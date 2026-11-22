'use strict';
// ---------------------------------------------------------------------------
// Tencent POS: a point-of-sale service for shops, mounted into server.js at /pos.
// Every shop has its own products, stock, sales and reports. Every database query is
// limited to the signed-in owner's shop, so one shop can never see another shop's data.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const GW = require('./pos-gateways');
const SEC = require('./pos-security');
const PAYSTACK_ON = process.env.POS_ENABLE_PAYSTACK === '1';   // Paystack code is not verified against their live service, so it stays off unless you switch it on
const COMMON_PW = new Set(['password', 'password1', '12345678', '123456789', '1234567890', 'qwerty123', '11111111', '00000000', 'abcd1234', 'tencent123', 'welcome123']);

const TZ = 'Africa/Nairobi';
const VAT_RATE = 16;   // percent. Selling prices already include this VAT.
const vatOf = gross => Math.round(Number(gross) * VAT_RATE / (100 + VAT_RATE));   // VAT inside a VAT-inclusive amount, in cents
const envInt = (name, fallback) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : fallback; };
const SUB_FEE_KES = envInt('POS_MONTHLY_FEE', 3000);   // monthly subscription, paid to the platform M-Pesa account in server.js
const GRACE_DAYS = envInt('POS_GRACE_DAYS', 30);       // shops that already existed before subscriptions started get this many free days
const LOGO_OK = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
async function assignCode(db, shopId) {   // short business code that staff type when they sign in
    for (let i = 0; i < 12; i++) {
        try { const r = await db.query('UPDATE pos_shops SET code=$2 WHERE id=$1 AND code IS NULL', [shopId, newCode()]); return r.rowCount; }
        catch (e) { if (e.code !== '23505') throw e; }
    }
    throw new Error('Could not create a business code');
}

// An older POS design may already exist in the database (no owner_id column, other column names). It cannot be used by this
// version, so every pos_* table is renamed to legacy_<date>_pos_* (data, indexes and constraints included). NOTHING is deleted:
// the old data stays in the database and can be copied across later.
async function quarantineLegacyLayout(pool) {
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pos_shops'`)).rows.map(r => r.column_name);
    if (!cols.length || cols.includes('owner_id')) return;   // brand new database, or already the current layout
    const tag = 'legacy_' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '_';
    const qi = n => '"' + String(n).replace(/"/g, '""') + '"', fit = n => (tag + n).slice(0, 63);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND left(tablename, 4) = 'pos_' ORDER BY tablename`)).rows.map(r => r.tablename);
        for (const t of tables) {
            for (const c of (await client.query('SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass', [qi(t)])).rows) await client.query(`ALTER TABLE ${qi(t)} RENAME CONSTRAINT ${qi(c.conname)} TO ${qi(fit(c.conname))}`);
            for (const i of (await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1`, [t])).rows) if (!i.indexname.startsWith(tag)) await client.query(`ALTER INDEX ${qi(i.indexname)} RENAME TO ${qi(fit(i.indexname))}`);
            await client.query(`ALTER TABLE ${qi(t)} RENAME TO ${qi(fit(t))}`);
        }
        await client.query('COMMIT');
        console.log(`POS: the old POS tables (${tables.length}) were moved aside as ${tag}pos_*. Nothing was deleted.`);
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw new Error('Could not move the old POS tables aside: ' + e.message); }
    finally { client.release(); }
}

async function initSchema(pool) {
    await quarantineLegacyLayout(pool);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_shops (
            id SERIAL PRIMARY KEY,
            owner_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(120) NOT NULL,
            phone VARCHAR(40) NOT NULL DEFAULT '',
            address VARCHAR(200) NOT NULL DEFAULT '',
            tax_pin VARCHAR(40) NOT NULL DEFAULT '',
            receipt_footer VARCHAR(200) NOT NULL DEFAULT 'Thank you for shopping with us!',
            next_receipt INT NOT NULL DEFAULT 1,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_categories (
            id SERIAL PRIMARY KEY,
            shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE,
            name VARCHAR(80) NOT NULL,
            UNIQUE (shop_id, name)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_items (
            id SERIAL PRIMARY KEY,
            shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE,
            category_id INT REFERENCES pos_categories(id) ON DELETE SET NULL,
            name VARCHAR(120) NOT NULL,
            barcode VARCHAR(60),
            price_cents BIGINT NOT NULL,
            cost_cents BIGINT NOT NULL DEFAULT 0,
            stock INT NOT NULL DEFAULT 0,
            track_stock BOOLEAN NOT NULL DEFAULT TRUE,
            reorder_level INT NOT NULL DEFAULT 5,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS pos_items_barcode_uq ON pos_items (shop_id, barcode) WHERE barcode IS NOT NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS pos_items_shop_idx ON pos_items (shop_id, active)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_sales (
            id SERIAL PRIMARY KEY,
            shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE,
            receipt_no INT NOT NULL,
            subtotal_cents BIGINT NOT NULL,
            discount_cents BIGINT NOT NULL DEFAULT 0,
            total_cents BIGINT NOT NULL,
            paid_cents BIGINT NOT NULL,
            change_cents BIGINT NOT NULL DEFAULT 0,
            method VARCHAR(10) NOT NULL,
            mpesa_ref VARCHAR(20),
            customer_name VARCHAR(80) NOT NULL DEFAULT '',
            customer_phone VARCHAR(30) NOT NULL DEFAULT '',
            status VARCHAR(10) NOT NULL DEFAULT 'completed',
            void_reason VARCHAR(200),
            voided_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (shop_id, receipt_no)
        )`);
    await pool.query('CREATE INDEX IF NOT EXISTS pos_sales_shop_time_idx ON pos_sales (shop_id, created_at DESC)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_sale_items (
            id SERIAL PRIMARY KEY,
            sale_id INT NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
            item_id INT REFERENCES pos_items(id) ON DELETE SET NULL,
            name VARCHAR(120) NOT NULL,
            qty INT NOT NULL,
            unit_price_cents BIGINT NOT NULL,
            unit_cost_cents BIGINT NOT NULL DEFAULT 0
        )`);
    await pool.query('CREATE INDEX IF NOT EXISTS pos_sale_items_sale_idx ON pos_sale_items (sale_id)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_stock_moves (
            id SERIAL PRIMARY KEY,
            shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE,
            item_id INT NOT NULL REFERENCES pos_items(id) ON DELETE CASCADE,
            change INT NOT NULL,
            balance INT NOT NULL,
            reason VARCHAR(12) NOT NULL,
            note VARCHAR(200) NOT NULL DEFAULT '',
            sale_id INT REFERENCES pos_sales(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    await pool.query('CREATE INDEX IF NOT EXISTS pos_moves_shop_idx ON pos_stock_moves (shop_id, created_at DESC)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_expenses (
            id SERIAL PRIMARY KEY,
            shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE,
            category VARCHAR(60) NOT NULL,
            amount_cents BIGINT NOT NULL,
            note VARCHAR(200) NOT NULL DEFAULT '',
            spent_on DATE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    await pool.query('CREATE INDEX IF NOT EXISTS pos_expenses_shop_idx ON pos_expenses (shop_id, spent_on DESC)');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS next_po INT NOT NULL DEFAULT 1');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS next_quote INT NOT NULL DEFAULT 1');
    const T = [
        `CREATE TABLE IF NOT EXISTS pos_suppliers (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, name VARCHAR(120) NOT NULL, phone VARCHAR(40) NOT NULL DEFAULT '', email VARCHAR(160) NOT NULL DEFAULT '', address VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        `CREATE TABLE IF NOT EXISTS pos_purchase_orders (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, supplier_id INT REFERENCES pos_suppliers(id) ON DELETE SET NULL, po_no INT NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'open', note VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), received_at TIMESTAMPTZ, UNIQUE (shop_id, po_no))`,
        `CREATE TABLE IF NOT EXISTS pos_po_lines (id SERIAL PRIMARY KEY, po_id INT NOT NULL REFERENCES pos_purchase_orders(id) ON DELETE CASCADE, item_id INT NOT NULL REFERENCES pos_items(id) ON DELETE CASCADE, qty INT NOT NULL, cost_cents BIGINT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS pos_quotes (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, quote_no INT NOT NULL, customer_name VARCHAR(120) NOT NULL DEFAULT '', customer_phone VARCHAR(40) NOT NULL DEFAULT '', valid_until DATE, status VARCHAR(10) NOT NULL DEFAULT 'open', note VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (shop_id, quote_no))`,
        `CREATE TABLE IF NOT EXISTS pos_quote_lines (id SERIAL PRIMARY KEY, quote_id INT NOT NULL REFERENCES pos_quotes(id) ON DELETE CASCADE, name VARCHAR(120) NOT NULL, qty INT NOT NULL, unit_price_cents BIGINT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS pos_drawer (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), opening_cents BIGINT NOT NULL DEFAULT 0, closed_at TIMESTAMPTZ, expected_cents BIGINT, counted_cents BIGINT, note VARCHAR(200) NOT NULL DEFAULT '')`,
        `CREATE UNIQUE INDEX IF NOT EXISTS pos_drawer_one_open ON pos_drawer (shop_id) WHERE closed_at IS NULL`,
        `CREATE TABLE IF NOT EXISTS pos_drawer_moves (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, drawer_id INT NOT NULL REFERENCES pos_drawer(id) ON DELETE CASCADE, kind VARCHAR(3) NOT NULL, amount_cents BIGINT NOT NULL, note VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        `CREATE TABLE IF NOT EXISTS pos_expense_cats (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, name VARCHAR(60) NOT NULL, UNIQUE (shop_id, name))`,
        `CREATE TABLE IF NOT EXISTS pos_recurring (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, category VARCHAR(60) NOT NULL, amount_cents BIGINT NOT NULL, note VARCHAR(200) NOT NULL DEFAULT '', day_of_month INT NOT NULL, last_run DATE)`,
        `CREATE TABLE IF NOT EXISTS pos_budgets (shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, category VARCHAR(60) NOT NULL, amount_cents BIGINT NOT NULL, PRIMARY KEY (shop_id, category))`,
        `CREATE TABLE IF NOT EXISTS pos_assets (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, name VARCHAR(120) NOT NULL, cost_cents BIGINT NOT NULL, bought_on DATE NOT NULL, life_years INT NOT NULL DEFAULT 5, salvage_cents BIGINT NOT NULL DEFAULT 0, note VARCHAR(200) NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS pos_notes (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, title VARCHAR(120) NOT NULL, body VARCHAR(4000) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    ];
    // the audit-log lock is a safety extra: if the database refuses it (old version, no permission), the POS still starts and the problem is logged
    const OPTIONAL_STEP = /pos_audit_immutable|pos_audit_no_change/;
    const step = async sql => { try { await pool.query(sql); } catch (e) {
            if (OPTIONAL_STEP.test(String(sql.text || sql))) { console.error('POS: skipped an optional safety step (' + e.message + '). The audit log will work but will not be locked against edits.'); return; } let layout = '';
            try {   // what the existing POS tables really look like, to make a mismatch easy to diagnose
                const r = await pool.query(`SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS cols FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('pos_shops', 'pos_items', 'pos_sales', 'pos_categories') GROUP BY table_name ORDER BY table_name`);
                layout = ' | existing tables: ' + r.rows.map(x => `${x.table_name}(${x.cols})`).join('; ');
            } catch (_) { /* diagnostics only */ }
            throw new Error(`POS schema step failed (${e.message}) in: ${String(sql.text || sql).replace(/\s+/g, ' ').slice(0, 140)}${layout.slice(0, 900)}`); } };
    console.log('POS: setting up database tables');
    for (const sql of T) await step(sql);

    // ---- businesses, branches, staff, payment gateways, subscription and VAT ----
    try { await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_mpesa_ref_uq ON pos_sales (mpesa_ref) WHERE mpesa_ref IS NOT NULL'); }
    catch (e) { console.error('Could not add the one-use M-Pesa code index (old duplicate codes exist). Sales still check for repeats in code:', e.message); }
    const hadSub = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_shops' AND column_name = 'sub_until'`);
    for (const sql of [
        'ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES pos_shops(id) ON DELETE CASCADE',   // set on branches: points at the head office
        'ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS code VARCHAR(10)',                                          // business code used by staff to sign in
        'ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS logo TEXT',
        'ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS vat_enabled BOOLEAN NOT NULL DEFAULT TRUE',
        'ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS max_discount_pct INT NOT NULL DEFAULT 10',                  // most a cashier/manager may take off a sale; owners are not capped
        'ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS allow_manual_codes BOOLEAN NOT NULL DEFAULT TRUE',          // typed M-Pesa codes can be switched off in favour of STK push only
        'ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS sub_until TIMESTAMPTZ',
        'ALTER TABLE pos_shops DROP CONSTRAINT IF EXISTS pos_shops_owner_id_key',                                   // one business per owner now means one HEAD OFFICE per owner
        'ALTER TABLE pos_shops ALTER COLUMN owner_id DROP NOT NULL',
        'CREATE UNIQUE INDEX IF NOT EXISTS pos_shops_owner_root_uq ON pos_shops (owner_id) WHERE parent_id IS NULL',
        'CREATE UNIQUE INDEX IF NOT EXISTS pos_shops_code_uq ON pos_shops (code) WHERE code IS NOT NULL',
        'CREATE INDEX IF NOT EXISTS pos_shops_parent_idx ON pos_shops (parent_id)',
        'ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS vat_cents BIGINT NOT NULL DEFAULT 0',
        'ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS staff_id INT',
        `ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS cashier_name VARCHAR(80) NOT NULL DEFAULT ''`,
        `CREATE TABLE IF NOT EXISTS pos_staff (id SERIAL PRIMARY KEY, business_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, role VARCHAR(10) NOT NULL, name VARCHAR(80) NOT NULL, username VARCHAR(40) NOT NULL, password_hash VARCHAR(100) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, failed INT NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ, last_login TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        'CREATE UNIQUE INDEX IF NOT EXISTS pos_staff_user_uq ON pos_staff (business_id, lower(username))',
        'CREATE INDEX IF NOT EXISTS pos_staff_shop_idx ON pos_staff (shop_id)',
        `CREATE TABLE IF NOT EXISTS pos_gateways (id SERIAL PRIMARY KEY, business_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, provider VARCHAR(20) NOT NULL, cfg JSONB NOT NULL DEFAULT '{}', secrets TEXT NOT NULL, callback_token CHAR(48) NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE, is_default BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (business_id, provider))`,
        `CREATE TABLE IF NOT EXISTS pos_payments (id VARCHAR(32) PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, gateway_id INT REFERENCES pos_gateways(id) ON DELETE SET NULL, staff_id INT, cashier_name VARCHAR(80) NOT NULL DEFAULT '', amount_kes INT NOT NULL, phone VARCHAR(20) NOT NULL, provider_ref VARCHAR(120), status VARCHAR(10) NOT NULL DEFAULT 'pending', receipt VARCHAR(40) NOT NULL DEFAULT '', cart JSONB NOT NULL, sale_id INT REFERENCES pos_sales(id) ON DELETE SET NULL, fail_reason VARCHAR(160) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        'CREATE INDEX IF NOT EXISTS pos_payments_ref_idx ON pos_payments (provider_ref)',
        'CREATE INDEX IF NOT EXISTS pos_payments_shop_idx ON pos_payments (shop_id, created_at DESC)',
        `CREATE TABLE IF NOT EXISTS pos_sub_payments (id SERIAL PRIMARY KEY, business_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, amount_kes INT NOT NULL, phone VARCHAR(20) NOT NULL, account_ref VARCHAR(20) NOT NULL UNIQUE, checkout_request_id VARCHAR(100), status VARCHAR(10) NOT NULL DEFAULT 'pending', receipt VARCHAR(40) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ)`,
        'CREATE INDEX IF NOT EXISTS pos_sub_checkout_idx ON pos_sub_payments (checkout_request_id)',
        'ALTER TABLE pos_staff ADD COLUMN IF NOT EXISTS session_ver INT NOT NULL DEFAULT 0',   // bumped on password change or switch-off: ends that person's sessions
        `CREATE TABLE IF NOT EXISTS pos_auth_fails (key TEXT PRIMARY KEY, count INT NOT NULL DEFAULT 0, first_at TIMESTAMPTZ NOT NULL DEFAULT now(), locked_until TIMESTAMPTZ)`,
        `CREATE TABLE IF NOT EXISTS pos_audit (id BIGSERIAL PRIMARY KEY, business_id INT NOT NULL, shop_id INT, actor_kind VARCHAR(10) NOT NULL, actor_id INT, actor_name VARCHAR(80) NOT NULL DEFAULT '', action VARCHAR(40) NOT NULL, detail VARCHAR(300) NOT NULL DEFAULT '', ip VARCHAR(60) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        'CREATE INDEX IF NOT EXISTS pos_audit_biz_idx ON pos_audit (business_id, id DESC)',
        `CREATE OR REPLACE FUNCTION pos_audit_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'the audit log cannot be changed'; END; $$ LANGUAGE plpgsql`,
        'DROP TRIGGER IF EXISTS pos_audit_no_change ON pos_audit',
        'CREATE TRIGGER pos_audit_no_change BEFORE UPDATE OR DELETE ON pos_audit FOR EACH ROW EXECUTE PROCEDURE pos_audit_immutable()',
        `CREATE TABLE IF NOT EXISTS pos_owner_security (user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, secret TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT FALSE, last_counter BIGINT NOT NULL DEFAULT 0, recovery JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        `CREATE TABLE IF NOT EXISTS pos_void_requests (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, sale_id INT NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE, reason VARCHAR(200) NOT NULL, requested_by VARCHAR(80) NOT NULL DEFAULT '', staff_id INT, status VARCHAR(10) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ, decided_by VARCHAR(80) NOT NULL DEFAULT '')`,
        `CREATE UNIQUE INDEX IF NOT EXISTS pos_void_one_pending ON pos_void_requests (sale_id) WHERE status = 'pending'`
    ]) await step(sql);
    // shops that were already using the POS before subscriptions existed keep working for a grace period
    if (!hadSub.rowCount) await step({ text: 'UPDATE pos_shops SET sub_until = now() + make_interval(days => $1::int) WHERE parent_id IS NULL', values: [GRACE_DAYS] });
    for (const s of (await pool.query('SELECT id FROM pos_shops WHERE parent_id IS NULL AND code IS NULL')).rows) await assignCode(pool, s.id);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const fmt = cents => (Number(cents) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kes = cents => 'KES ' + fmt(cents);
function parseMoney(v) {   // "1250" or "1250.50" -> cents; anything else -> null
    const s = String(v == null ? '' : v).trim().replace(/,/g, '');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
}
function parseCount(v, { min = 0, max = 1000000 } = {}) {
    const s = String(v == null ? '' : v).trim();
    if (!/^-?\d{1,7}$/.test(s)) return null;
    const n = Number(s);
    return n >= min && n <= max ? n : null;
}
const validDate = v => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const todayNairobi = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const csvCell = v => {   // quotes, and a leading apostrophe stops spreadsheet formulas such as =HYPERLINK(...)
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
};
const timeFmt = d => new Date(d).toLocaleString('en-KE', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateFmt = d => new Date(d).toLocaleDateString('en-KE', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
const isoDate = d => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString() : String(d)).slice(0, 10);
function assetBookValue(a, todayIso) {   // straight-line depreciation by whole days
    const cost = Number(a.cost_cents), salv = Number(a.salvage_cents), days = (new Date(todayIso) - new Date(isoDate(a.bought_on))) / 86400000;
    const dep = (cost - salv) * Math.max(0, days) / (a.life_years * 365);
    return Math.max(salv, Math.round(cost - dep));
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------
function mountPos({ app, getPool, esc, str, ah, rateLimit, requireAuth, requireDb, requireVerified, renderPage, platform = null, publicBaseUrl = '' }) {
    const pool = () => getPool();
    let QRCode = null; try { QRCode = require('qrcode'); } catch (_) { /* optional: the page shows the typed key instead */ }
    const router = express.Router();
    const q = (text, params) => pool().query(text, params);
    // loose per-network limit for everything under /pos (the server-wide limiter skips /pos so a shop's many staff behind one WiFi are not blocked together)
    router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 3000, standardHeaders: true, legacyHeaders: false, skip: r => /^\/(mpesa\/cb|paystack\/hook)\//.test(r.path), message: 'Too many requests from this network. Please wait a few minutes.' }));

    // ----- layout -----
    const BASE_NAV = [
        ['Main', [['app', '/pos/app', 'Dashboard'], ['terminal', '/pos/terminal', 'POS Terminal'], ['sales', '/pos/sales', 'Sales History'], ['daily', '/pos/daily', 'Daily Sales (Z-Report)'], ['drawer', '/pos/drawer', 'Cash Drawer'], ['quotes', '/pos/quotes', 'Quotes']]],
        ['Inventory', [['items', '/pos/items', 'Items'], ['categories', '/pos/categories', 'Categories'], ['stock', '/pos/stock', 'Stock In / Out & Adjustment'], ['history', '/pos/stock/history', 'Stock History'], ['low', '/pos/stock/low', 'Low Stock Alerts'], ['suppliers', '/pos/suppliers', 'Suppliers'], ['po', '/pos/purchase-orders', 'Purchase Orders']]],
        ['Money', [['expenses', '/pos/expenses', 'Expenses'], ['ecats', '/pos/expense-categories', 'Expense Categories'], ['recurring', '/pos/recurring', 'Recurring Expenses'], ['budgets', '/pos/budgets', 'Budgets'], ['assets', '/pos/assets', 'Assets'], ['reports', '/pos/reports', 'Reports'], ['notebook', '/pos/notebook', 'Notebook']]]
    ];
    function navFor(role) {
        if (role === 'cashier') return [['Sell', [['terminal', '/pos/terminal', 'POS Terminal'], ['sales', '/pos/sales', 'My Sales'], ['account', '/pos/account', 'My Account']]], ['App', [['install', '/pos/install', 'Install App']]]];
        const shop = [];
        if (role === 'owner') shop.push(['branches', '/pos/branches', 'Branches']);
        shop.push(['staff', '/pos/staff', role === 'owner' ? 'Staff & Cashiers' : 'Cashiers']);
        if (role === 'owner') shop.push(['gateways', '/pos/gateways', 'Payment Gateways'], ['voids', '/pos/voids', 'Void Requests'], ['audit', '/pos/audit', 'Audit Log'], ['security', '/pos/security', 'Security (2-step login)'], ['subscription', '/pos/subscribe', 'Subscription'], ['settings', '/pos/settings', 'Shop Settings & Logo']);
        else shop.push(['account', '/pos/account', 'My Account']);
        shop.push(['install', '/pos/install', 'Install App']);
        return [...BASE_NAV, ['Shop', shop]];
    }
    function layout(req, { title, nav = '', body, bare = false }) {
        const shop = req.shop;
        const role = (req.actor && req.actor.role) || 'owner', biz = req.biz || shop, isStaff = Boolean(req.actor && req.actor.kind === 'staff');
        const logoImg = biz && biz.logo && LOGO_OK.test(biz.logo) ? `<img src="${biz.logo}" alt="" style="max-height:36px;max-width:130px;display:block;margin-bottom:6px;background:#fff;border-radius:5px;padding:2px">` : '';
        const switcher = role === 'owner' && req.branches && req.branches.length > 1 ? `<form action="/pos/branches/switch" method="POST" style="margin:0 0 6px"><label for="sw" style="color:#6b87a6;font-size:.7rem;padding:0 10px;text-transform:uppercase;letter-spacing:.06em">Branch</label><select id="sw" name="shop_id" style="margin:2px 8px 0;width:calc(100% - 16px);font-size:.85rem">${req.branches.map(b => `<option value="${b.id}"${shop && b.id === shop.id ? ' selected' : ''}>${esc(biz && b.id === biz.id ? b.name + ' (head office)' : b.name)}</option>`).join('')}</select></form>` : '';
        const daysLeft = biz && biz.sub_until ? Math.ceil((new Date(biz.sub_until) - Date.now()) / 86400000) : null;
        const voidBanner = role === 'owner' && req.pendingVoids ? `<div class="alert noprint" role="status">${req.pendingVoids} void request${req.pendingVoids === 1 ? '' : 's'} waiting for your approval. <a href="/pos/voids">Review</a></div>` : '';
        const nudge2 = role === 'owner' && !isStaff && req.has2fa === false && vault.enabled && nav !== 'security' && !bare ? `<div class="alert noprint" role="status">Protect your shop money: <a href="/pos/security"><b>turn on 2-step login</b></a> (takes about a minute).</div>` : '';
        const banner = nudge2 + voidBanner + (role === 'owner' && daysLeft !== null && daysLeft > 0 && daysLeft <= 5 ? `<div class="alert noprint" role="status">Your POS subscription ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. <a href="/pos/subscribe">Renew now</a></div>` : '');
        const links = navFor(role).map(([group, items]) => `<div class="nav-group">${esc(group)}</div>` +
            items.map(([key, href, label]) => `<a href="${href}"${key === 'install' ? ' id="nav-install"' : ''} class="${nav === key ? 'active' : ''}">${esc(label)}</a>`).join('')).join('');
        return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(shop ? shop.name : 'Tencent POS')}</title>
<meta name="robots" content="noindex">
<link rel="manifest" href="/pos/manifest.webmanifest"><meta name="theme-color" content="#0b1b2e"><link rel="icon" type="image/png" href="/pos/icon-192.png"><link rel="apple-touch-icon" href="/pos/icon-192.png"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Tencent POS">
<script nonce="${req.nonce || ''}">window.__ip=null;window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__ip=e;window.dispatchEvent(new Event('ip-ready'));});</script>
<style>
:root{--bg:#f1f5f9;--panel:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--side:#0b1b2e;--side2:#12304d;--accent:#0ea5e9;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--radius:10px}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.45}
a{color:#0369a1}.side{position:fixed;inset:0 auto 0 0;width:236px;background:var(--side);color:#cbd5e1;overflow-y:auto;padding:14px 10px 24px;z-index:30}
.side .brand{display:block;color:#fff;font-weight:800;font-size:1.05rem;padding:6px 10px 2px;text-decoration:none}.side .shopname{padding:0 10px 12px;font-size:.82rem;color:#7dd3fc;border-bottom:1px solid #1e3a56;margin-bottom:6px}
.nav-group{font-size:.7rem;letter-spacing:.06em;color:#6b87a6;padding:14px 10px 4px;text-transform:uppercase}
.side a{display:block;color:#cbd5e1;text-decoration:none;padding:8px 10px;border-radius:7px;font-size:.92rem}.side a:hover{background:var(--side2)}.side a.active{background:var(--accent);color:#04223a;font-weight:700}
.side form{margin:10px 0 0}.side .linkbtn{width:100%;text-align:left;background:none;border:0;color:#fca5a5;padding:8px 10px;cursor:pointer;font:inherit;font-size:.92rem;border-radius:7px}.side .linkbtn:hover{background:var(--side2)}
.main{margin-left:236px;padding:22px 26px 60px;min-height:100vh}.top{display:none}
h1{font-size:1.5rem;margin:0 0 16px}h2{font-size:1.1rem;margin:0 0 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;margin-bottom:18px}
.stat{border-radius:var(--radius);padding:16px 18px;color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12)}.stat b{display:block;font-size:1.55rem;line-height:1.2}.stat span{font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;opacity:.92}
.c1{background:#2563eb}.c2{background:#059669}.c3{background:#16a34a}.c4{background:#d97706}.c5{background:#7c3aed}.c6{background:#be185d}.c7{background:#0891b2}.c8{background:#1e3a5f}.c9{background:#dc2626}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;margin-bottom:18px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:.92rem;vertical-align:middle}th{font-size:.76rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}td.num,th.num{text-align:right;white-space:nowrap}
.tablewrap{overflow-x:auto}
.btn{display:inline-block;border:0;border-radius:8px;padding:9px 14px;background:var(--accent);color:#04223a;font-weight:700;cursor:pointer;text-decoration:none;font:inherit;font-weight:700;font-size:.9rem}
.btn.dark{background:#0f172a;color:#fff}.btn.ok{background:var(--ok);color:#fff}.btn.bad{background:var(--bad);color:#fff}.btn.ghost{background:#fff;border:1px solid var(--line);color:var(--ink)}.btn.small{padding:5px 10px;font-size:.8rem}
.btn:disabled{opacity:.5;cursor:not-allowed}
label{display:block;font-weight:600;font-size:.85rem;margin:0 0 4px}input,select,textarea{width:100%;padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff;color:var(--ink)}
input:focus,select:focus,textarea:focus,.btn:focus-visible,a:focus-visible{outline:3px solid #7dd3fc;outline-offset:1px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.field{margin-bottom:14px}.field small{color:var(--muted)}
.alert{padding:11px 14px;border-radius:8px;margin-bottom:14px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b}.alert.ok{background:#f0fdf4;border-color:#bbf7d0;color:#166534}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:700}.tag.ok{background:#dcfce7;color:#166534}.tag.bad{background:#fee2e2;color:#991b1b}.tag.warn{background:#fef3c7;color:#92400e}.tag.gray{background:#e2e8f0;color:#334155}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.row>*{flex:1 1 150px}.row>.btn{flex:0 0 auto}
.muted{color:var(--muted)}.right{text-align:right}.nowrap{white-space:nowrap}
@media(max-width:860px){.side{transform:translateX(-100%);transition:transform .2s;width:260px}.side.open{transform:none}.main{margin-left:0;padding:14px 14px 60px}.top{display:flex;align-items:center;gap:12px;background:var(--side);color:#fff;margin:-14px -14px 14px;padding:10px 14px;position:sticky;top:0;z-index:20}.top button{background:none;border:1px solid #3b5878;color:#fff;border-radius:7px;padding:6px 12px;font-size:1.1rem;cursor:pointer}}
@media print{.side,.top,.noprint{display:none!important}.main{margin:0;padding:0}body{background:#fff}.panel{border:0;padding:0}}
${bare ? '.side,.top{display:none!important}.main{margin:0 auto;max-width:480px;padding-top:7vh}' : ''}
.pos-wrap{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start}
.pos-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}
.pos-item{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px;text-align:left;cursor:pointer;font:inherit;display:flex;flex-direction:column;gap:4px;min-height:84px}.pos-item:hover{border-color:var(--accent);box-shadow:0 0 0 2px #bae6fd}.pos-item b{font-size:.92rem}.pos-item .p{color:#0369a1;font-weight:800}.pos-item .s{font-size:.75rem;color:var(--muted)}.pos-item.out{opacity:.45}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 12px;cursor:pointer;font:inherit;font-size:.85rem}.chip.on{background:#0f172a;color:#fff;border-color:#0f172a}
.cart{position:sticky;top:12px}.cart .lines{max-height:38vh;overflow:auto;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:10px 0}.cline{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:8px 2px;border-bottom:1px solid var(--line)}.cline:last-child{border:0}.cline .qty{display:flex;align-items:center;gap:4px}.cline .qty button{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);background:#fff;cursor:pointer;font-size:1rem}
.tot{display:flex;justify-content:space-between;padding:3px 0}.tot.big{font-size:1.35rem;font-weight:800;border-top:2px solid var(--ink);margin-top:6px;padding-top:8px}
.pay{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}.pay button{padding:10px;border:2px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;font:inherit;font-weight:700}.pay button.on{border-color:var(--accent);background:#e0f2fe}
.modal{position:fixed;inset:0;background:rgba(2,6,23,.6);display:none;align-items:center;justify-content:center;z-index:50;padding:16px}.modal.show{display:flex}.modal .box{background:#fff;border-radius:14px;padding:22px;max-width:420px;width:100%;text-align:center}
@media(max-width:1000px){.pos-wrap{grid-template-columns:1fr}.cart{position:static}}
</style></head><body>
<div class="top noprint"><button type="button" id="side-btn" aria-label="Open menu" aria-expanded="false">&#9776;</button><strong>${esc(biz ? biz.name : 'Tencent POS')}</strong></div>
<nav class="side" id="side" aria-label="POS menu">
<a class="brand" href="/pos/start">Tencent POS</a><div class="shopname">${logoImg}${esc(biz ? biz.name : '')}${shop && biz && shop.id !== biz.id ? '<br>' + esc(shop.name) : ''}${isStaff ? '<br>' + esc(req.actor.name) + ' (' + esc(role) + ')' : ''}</div>
${switcher}${links}
<div class="nav-group">Account</div>${isStaff ? '' : '<a href="/">Back to website</a>'}
<form action="${isStaff ? '/pos/staff/logout' : '/logout'}" method="POST"><button class="linkbtn" type="submit">Log out</button></form>
</nav>
<main class="main">${banner}${body}</main>
<div id="ibar" class="noprint" style="display:none;position:fixed;left:0;right:0;bottom:0;z-index:60;background:#0b1b2e;color:#fff;padding:10px 14px;align-items:center;gap:10px;flex-wrap:wrap;box-shadow:0 -2px 12px rgba(0,0,0,.25)"><span style="flex:1;min-width:150px;font-weight:600">Get the Tencent POS app</span><button id="ibar-go" type="button" style="background:#16a34a;color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:1rem;font-weight:700;cursor:pointer">Install</button><button id="ibar-x" type="button" aria-label="Hide" style="background:none;border:0;color:#cbd5e1;font-size:1.3rem;cursor:pointer">&times;</button><span id="ibar-ios" style="display:none;flex-basis:100%;font-size:.9rem">On iPhone: tap the Share button in Safari, then <b>Add to Home Screen</b>.</span></div>
<script nonce="${req.nonce || ''}">
(function(){var b=document.getElementById('side-btn'),s=document.getElementById('side');if(b)b.addEventListener('click',function(){var o=s.classList.toggle('open');b.setAttribute('aria-expanded',o?'true':'false');});
var sw=document.getElementById('sw');if(sw)sw.addEventListener('change',function(){sw.form.submit();});
var ev=window.__ip,ib=document.getElementById('install-now'),ni=document.getElementById('nav-install');
var standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true;
if(standalone&&ni)ni.style.display='none';
function startInstall(){if(!ev)return false;var p=ev;ev=null;p.prompt();p.userChoice.then(function(c){if(c&&c.outcome==='accepted'){if(ni)ni.style.display='none';if(ib)ib.style.display='none';}});return true;}
function ready(){ev=window.__ip;if(ib)ib.style.display='';var h=document.getElementById('install-help');if(h)h.style.display='none';showBar();}
window.addEventListener('ip-ready',ready);
var bar=document.getElementById('ibar'),ibtn=document.getElementById('ibar-go'),ix=document.getElementById('ibar-x'),ios=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function hidden(){try{return Number(localStorage.getItem('ibar-hide')||0)>Date.now();}catch(_){return false;}}
function showBar(){if(bar&&!standalone&&!hidden()&&(window.__ip||ios))bar.style.display='flex';}
if(ev)ready();else if(ios)showBar();
if(ibtn)ibtn.addEventListener('click',function(){if(window.__ip){ev=window.__ip;window.__ip=null;startInstall();bar.style.display='none';}else{document.getElementById('ibar-ios').style.display='block';}});
if(ix)ix.addEventListener('click',function(){bar.style.display='none';try{localStorage.setItem('ibar-hide',String(Date.now()+7*864e5));}catch(_){}});
if(standalone&&bar)bar.style.display='none';
window.addEventListener('appinstalled',function(){if(ni)ni.style.display='none';});
if(ni)ni.addEventListener('click',function(e){if(startInstall())e.preventDefault();});
if(ib)ib.addEventListener('click',startInstall);
if('serviceWorker' in navigator)navigator.serviceWorker.register('/pos/sw.js',{scope:'/pos/'}).catch(function(){});})();
</script>
</body></html>`;
    }
    const send = (req, res, opts, status = 200) => res.status(status).set('Cache-Control', 'no-store').send(layout(req, opts));
    const notice = (req) => req.query.ok ? `<div class="alert ok" role="status">${esc(String(req.query.ok).slice(0, 120))}</div>` : '';

    // ----- public landing page for the service -----
    app.get('/pos', (req, res) => {
        const loggedIn = Boolean(req.session && req.session.user);
        const content = `
        <div class="general-container">
            <h2>Tencent POS: a point of sale for your shop</h2>
            <p class="sub-title">Sell faster, know your stock, and see your profit every day. Works on any phone, tablet or computer, and installs like an app. KES ${SUB_FEE_KES.toLocaleString('en-KE')} per month.</p>
            <div class="form-container" style="border-left:4px solid var(--primary);">
                <h3 style="margin-top:0;color:var(--primary);">What your shop gets</h3>
                <ul style="line-height:1.8;padding-left:20px;margin-bottom:0;">
                    <li><strong>Fast sales screen:</strong> tap items or scan barcodes, take cash or M-Pesa, give change, print or share the receipt.</li>
                    <li><strong>Stock control:</strong> stock goes down with every sale, add or remove stock, and get low-stock alerts before you run out.</li>
                    <li><strong>Daily and monthly reports:</strong> sales, profit, best sellers, cash versus M-Pesa, and a daily closing report.</li>
                    <li><strong>Expenses:</strong> record rent, transport and other costs so you see real profit.</li>
                    <li><strong>Your own private account:</strong> your products and sales are visible only to you.</li>
                </ul>
            </div>
            <div class="form-container" style="margin-top:20px;">
                <p style="margin-top:0;">${loggedIn ? 'You are logged in. Open your POS to start selling.' : 'Create a free account, confirm your email, and set up your shop in two minutes.'}</p>
                <a href="/pos/app" class="cta-btn">${loggedIn ? 'Open my POS' : 'Get started'}</a>
                <a href="/contact" class="cta-btn" style="margin-left:8px;">Ask us about setup & hardware</a>
            </div>
            <p class="muted" style="margin-top:14px;">We can also supply and install barcode scanners, receipt printers, tablets and shop WiFi.</p>
        </div>`;
        res.send(renderPage(req, { title: 'POS System for Shops', activeNav: 'pos', content }));
    });

    // complimentary test accounts: owners whose login email is listed in POS_FREE_EMAILS use the POS without paying the subscription
    const compEmails = new Set(String(process.env.POS_FREE_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
    const isComped = async (biz, a, req) => {
        if (!compEmails.size) return false;
        if (a.kind === 'owner') return compEmails.has(String((req.session.user && req.session.user.email) || '').toLowerCase());
        const u = (await q('SELECT lower(email) AS email FROM users WHERE id = $1', [biz.owner_id])).rows[0];
        return Boolean(u && compEmails.has(u.email));
    };
    const vault = SEC.makeVault(process.env.POS_CRED_KEY, String(process.env.POS_CRED_KEY_OLD || '').split(','));
    const regen = req => new Promise((ok, no) => req.session.regenerate(e => (e ? no(e) : ok())));
    const saveSess = req => new Promise((ok, no) => req.session.save(e => (e ? no(e) : ok())));

    // ----- files that make the POS installable as an app (public, no sign-in needed) -----
    const SW_JS = `const V='tpos-v1';
self.addEventListener('install',function(e){e.waitUntil(caches.open(V).then(function(c){return c.addAll(['/pos/offline','/pos/icon-192.png']);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(x){return x!==V;}).map(function(x){return caches.delete(x);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(function(){return caches.match('/pos/offline');}));}});`;
    const MANIFEST = JSON.stringify({
        name: 'Tencent POS', short_name: 'POS', description: 'Point of sale for shops', id: '/pos/start', start_url: '/pos/start', scope: '/pos/', display: 'standalone',
        background_color: '#ffffff', theme_color: '#0b1b2e',
        icons: [{ src: '/pos/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/pos/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/pos/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
    });
    router.get('/manifest.webmanifest', (req, res) => res.set({ 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' }).send(MANIFEST));
    router.get('/sw.js', (req, res) => res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': '/pos/', 'Cache-Control': 'no-cache' }).send(SW_JS));
    for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
        router.get('/' + name, (req, res) => res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).send(GW.iconPng(size, maskable)));
    }
    router.get('/offline', (req, res) => res.set('Cache-Control', 'no-store').send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:12vh 20px;color:#0f172a"><h1>You are offline</h1><p>Tencent POS needs an internet connection to save sales and keep your stock correct.<br>Check your WiFi or mobile data, then reopen the app.</p></body></html>'));

    // ----- M-Pesa / gateway callbacks (called by the payment company, so no sign-in; every one is checked in gatewayCallback) -----
    router.post('/mpesa/cb/:token', (req, res) => {
        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });   // answer fast, process after
        gatewayCallback('mpesa', req.params.token, req.body).catch(e => console.error('POS M-Pesa callback error:', e.message));
    });
    router.post('/paystack/hook/:token', (req, res) => {
        res.sendStatus(200);
        gatewayCallback('paystack', req.params.token, req.body).catch(e => console.error('POS Paystack webhook error:', e.message));
    });

    // ----- staff (managers and cashiers) sign in with business code + username + password -----
    const staffForm = (error = '', v = {}) => `<h1>Staff sign in</h1><div class="panel">${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
        <form action="/pos/staff/login" method="POST">
            <div class="field"><label for="c">Business code</label><input id="c" name="code" required maxlength="10" autocapitalize="characters" autocomplete="off" value="${esc(v.code || '')}" placeholder="e.g. K7M2QX"><small>Your manager or the shop owner can give you this code.</small></div>
            <div class="field"><label for="u">Username</label><input id="u" name="username" required maxlength="40" autocapitalize="none" autocomplete="username" value="${esc(v.username || '')}"></div>
            <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" required maxlength="100" autocomplete="current-password"></div>
            <button class="btn" type="submit" style="width:100%">Sign in</button></form></div>
        <p class="muted">Shop owner? <a href="/login?next=/pos/app">Sign in with your owner account</a>.</p>`;
    const staffLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' });
    const DUMMY_HASH = bcrypt.hashSync('this-is-not-a-real-password', 10);   // compared when the username is unknown, so timing does not give it away
    // ----- audit log: append-only (the database refuses UPDATE and DELETE on it) -----
    async function auditRaw(bizId, shopId, kind, actorId, actorName, action, detail, ip) {
        try {
            if (!bizId && kind === 'owner' && actorId) bizId = ((await q('SELECT id FROM pos_shops WHERE owner_id=$1 AND parent_id IS NULL', [actorId])).rows[0] || {}).id;   // 2-step checks happen before the shop is loaded
            if (!bizId) return;
            await q('INSERT INTO pos_audit (business_id, shop_id, actor_kind, actor_id, actor_name, action, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [bizId, shopId || null, kind, actorId || null, String(actorName || '').slice(0, 80), action, String(detail || '').slice(0, 300), String(ip || '').slice(0, 60)]); }
        catch (e) { console.error('Audit write failed:', e.message); }
    }
    const audit = (req, action, detail) => auditRaw(req.biz ? req.biz.id : (req.actor && req.actor.businessId), req.shop ? req.shop.id : null, req.actor ? req.actor.kind : 'system', req.actor ? (req.actor.staffId || (req.session && req.session.user && req.session.user.id)) : null, req.actor ? req.actor.name : '', action, detail, req.ip);

    // ----- attack throttling kept in the database (survives restarts, shared by every server instance) -----
    const failLocked = async keys => (await q('SELECT 1 FROM pos_auth_fails WHERE key = ANY($1::text[]) AND locked_until > now() LIMIT 1', [keys])).rowCount > 0;
    async function failHit(key, max, windowSec, lockSec) {
        const r = await q(`INSERT INTO pos_auth_fails (key, count, first_at) VALUES ($1, 1, now()) ON CONFLICT (key) DO UPDATE SET
                count = CASE WHEN pos_auth_fails.first_at < now() - make_interval(secs => $2) THEN 1 ELSE pos_auth_fails.count + 1 END,
                first_at = CASE WHEN pos_auth_fails.first_at < now() - make_interval(secs => $2) THEN now() ELSE pos_auth_fails.first_at END RETURNING count`, [key, windowSec]);
        if (r.rows[0].count >= max) await q('UPDATE pos_auth_fails SET locked_until = now() + make_interval(secs => $2) WHERE key = $1', [key, lockSec]);
    }
    const failClear = keys => q('DELETE FROM pos_auth_fails WHERE key = ANY($1::text[])', [keys]);
    const STAFF_IDLE_MS = 30 * 60 * 1000, STAFF_ABS_MS = 12 * 3600 * 1000;   // staff are signed out after 30 idle minutes, and always after 12 hours

    router.get('/staff/login', requireDb, (req, res) => {
        if (req.session && req.session.posStaff) return res.redirect('/pos/app');
        send(req, res, { title: 'Staff sign in', bare: true, body: staffForm(req.query.expired ? 'You were signed out to keep the shop safe. Please sign in again.' : '') });
    });
    router.post('/staff/login', staffLimiter, requireDb, ah(async (req, res) => {
        const code = str(req.body.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10), username = str(req.body.username).slice(0, 40), password = String(req.body.password || '').slice(0, 100);
        const fail = (m, status = 401) => send(req, res, { title: 'Staff sign in', bare: true, body: staffForm(m, { code, username }) }, status);
        const GENERIC = 'The business code, username or password is not right.';
        const ip = String(req.ip || '').slice(0, 60), uname = username.toLowerCase();
        // three separate counters: this network, this account from this network, and this account from anywhere.
        // So a stranger who guesses a cashier's username locks only their own network out, not the cashier.
        const kIp = 'ip:' + ip, kPair = `u:${code}:${uname}:${ip}`, kAcct = `u:${code}:${uname}`;
        if (await failLocked([kIp, kPair, kAcct])) return fail('Too many attempts. Please wait 15 minutes and try again.', 429);
        const row = code && username ? (await q('SELECT s.* FROM pos_staff s JOIN pos_shops b ON b.id = s.business_id WHERE b.code = $1 AND lower(s.username) = lower($2)', [code, username])).rows[0] : null;
        const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
        if (!row || !row.active || !ok) {
            await Promise.all([failHit(kIp, 30, 900, 900), failHit(kPair, 5, 900, 900), failHit(kAcct, 40, 3600, 900)]);
            if (row) await auditRaw(row.business_id, row.shop_id, 'staff', row.id, row.name, 'staff.login_failed', '', ip);
            return fail(GENERIC);
        }
        await failClear([kPair, kAcct]);
        await q('UPDATE pos_staff SET last_login = now() WHERE id = $1', [row.id]);
        await regen(req);
        req.session.cookie.maxAge = STAFF_ABS_MS;   // the browser cookie also expires after 12 hours
        req.session.posStaff = { id: row.id, ver: row.session_ver, at: Date.now(), last: Date.now() };
        await saveSess(req);
        await auditRaw(row.business_id, row.shop_id, 'staff', row.id, row.name, 'staff.login', '', ip);
        res.redirect('/pos/app');
    }));
    router.post('/staff/logout', (req, res) => {
        const done = () => res.redirect('/pos/staff/login');
        if (req.session) req.session.destroy(done); else done();
    });
    // where the installed app opens
    router.get('/start', (req, res) => res.redirect(req.session && (req.session.posStaff || req.session.user) ? '/pos/app' : '/pos/staff/login'));

    // ----- everything below needs a signed-in owner (confirmed email) or a staff member -----
    router.use(requireDb);
    const isApi = req => req.path.startsWith('/api/');
    const OTP_VALID_MS = 12 * 3600 * 1000, STEP_VALID_MS = 10 * 60 * 1000;
    router.use(ah(async (req, res, next) => {
        const st = req.session && req.session.posStaff;
        if (st) {
            const now = Date.now();
            const stale = () => { delete req.session.posStaff; return isApi(req) ? res.status(401).json({ error: 'Please sign in again.' }) : res.redirect('/pos/staff/login?expired=1'); };
            if (!st.at || now - st.at > STAFF_ABS_MS || now - (st.last || st.at) > STAFF_IDLE_MS) return stale();
            const r = (await q('SELECT id, role, name, username, business_id, shop_id, session_ver FROM pos_staff WHERE id = $1 AND active', [st.id])).rows[0];
            if (!r || r.session_ver !== st.ver) return stale();   // switched off, deleted, or password changed: every old session ends
            if (now - (st.last || 0) > 60000) st.last = now;
            req.actor = { kind: 'staff', role: r.role, staffId: r.id, name: r.name, username: r.username, businessId: r.business_id, shopId: r.shop_id };
            return next();
        }
        requireAuth(req, res, () => requireVerified(req, res, () => {
            req.actor = { kind: 'owner', role: 'owner', name: req.session.user.name || 'Owner' };
            ownerGate(req, res, next).catch(next);
        }));
    }));

    // ----- owners can turn on a two-step code (authenticator app); once on, every POS visit needs it -----
    async function ownerGate(req, res, next) {
        const sec = (await q('SELECT enabled FROM pos_owner_security WHERE user_id = $1', [req.session.user.id])).rows[0];
        req.has2fa = Boolean(sec && sec.enabled);
        if (!req.has2fa || (req.session.pos2faAt && Date.now() - req.session.pos2faAt < OTP_VALID_MS) || /^\/2fa(\/|$)/.test(req.path)) return next();
        if (isApi(req)) return res.status(401).json({ error: 'Your two-step code is needed. Reload the page.' });
        return res.redirect('/pos/2fa');
    }
    // checks a code from the authenticator app (or a one-time recovery code). Five wrong tries lock it for 15 minutes.
    async function verifyOwnerOtp(req, input) {
        const uid = req.session.user.id, kUser = '2fa:' + uid, kIp = '2fa-ip:' + String(req.ip || '');
        if (await failLocked([kUser, kIp])) return { ok: false, locked: true };
        const row = (await q('SELECT secret, last_counter, recovery, enabled FROM pos_owner_security WHERE user_id = $1', [uid])).rows[0];
        let ok = false;
        const code = String(input || '').trim();
        if (row && row.enabled && vault.enabled) {
            if (/^\d{3}\s?\d{3}$/.test(code)) {
                const counter = SEC.checkTotp(vault.open(row.secret, '2fa:' + uid).s, code, row.last_counter);
                if (counter) ok = (await q('UPDATE pos_owner_security SET last_counter = $2 WHERE user_id = $1 AND last_counter < $2 RETURNING 1', [uid, counter])).rowCount > 0;   // a code works once
            } else if (code.length >= 10) {
                const h = SEC.hashRecovery(code), list = Array.isArray(row.recovery) ? row.recovery : [];
                if (list.includes(h)) ok = (await q('UPDATE pos_owner_security SET recovery = $2::jsonb WHERE user_id = $1 AND recovery = $3::jsonb RETURNING 1', [uid, JSON.stringify(list.filter(x => x !== h)), JSON.stringify(list)])).rowCount > 0;
            }
        }
        if (!ok) { await Promise.all([failHit(kUser, 5, 900, 900), failHit(kIp, 20, 900, 900)]); await audit(req, '2fa.failed', ''); return { ok: false }; }
        await failClear([kUser]);
        req.session.posStepAt = Date.now();
        return { ok: true };
    }
    const autoSubmit = nonce => `<script nonce="${nonce}">(function(){var i=document.getElementById('o'),f=i&&i.form;if(!i)return;i.addEventListener('input',function(){if(/^\\d{6}$/.test(i.value.replace(/\\s/g,'')))f.submit();});})();</script>`;
    const otpForm = (error = '', nonce = '') => `<h1>Two-step check</h1><div class="panel">${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}<form action="/pos/2fa" method="POST">
        <div class="field"><label for="o">6-digit code from your authenticator app</label><input id="o" name="otp" inputmode="numeric" autocomplete="one-time-code" required maxlength="20" autofocus style="font-size:1.6rem;letter-spacing:.3em;text-align:center"><small>It signs you in by itself after 6 digits. Lost your phone? Type a recovery code instead.</small></div>
        <button class="btn" type="submit" style="width:100%">Continue</button></form></div>${autoSubmit(nonce)}`;
    router.get('/2fa', (req, res) => {
        if (req.actor.kind !== 'owner' || !req.has2fa) return res.redirect('/pos/app');
        send(req, res, { title: 'Two-step check', bare: true, body: otpForm('', req.nonce || '') });
    });
    router.post('/2fa', ah(async (req, res) => {
        if (req.actor.kind !== 'owner' || !req.has2fa) return res.redirect('/pos/app');
        const r = await verifyOwnerOtp(req, req.body.otp);
        if (!r.ok) return send(req, res, { title: 'Two-step check', bare: true, body: otpForm(r.locked ? 'Too many wrong codes. Please wait 15 minutes.' : 'That code is not right. Try the newest code.', req.nonce || '') }, r.locked ? 429 : 401);
        req.session.pos2faAt = Date.now();
        await saveSess(req);
        res.redirect('/pos/app');
    }));

    async function loadShop(req) {   // the owner's head office
        const r = await q('SELECT * FROM pos_shops WHERE owner_id = $1 AND parent_id IS NULL', [req.session.user.id]);
        return r.rows[0] || null;
    }

    const setupForm = (req, error = '', v = {}) => `
        <h1>Set up your business</h1>
        <div class="panel" style="max-width:560px;">
            ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
            <form action="/pos/setup" method="POST">
                <div class="field"><label for="n">Business name</label><input id="n" name="name" required maxlength="120" value="${esc(v.name || '')}" placeholder="e.g. Mama Achieng Shop"></div>
                <div class="field"><label for="p">Business phone</label><input id="p" name="phone" maxlength="40" value="${esc(v.phone || req.session.user.phone || '')}"></div>
                <div class="field"><label for="a">Address / location</label><input id="a" name="address" maxlength="200" value="${esc(v.address || '')}" placeholder="e.g. Rangwe Market"></div>
                <button class="btn" type="submit">Create my business account</button>
            </form>
        </div>`;
    router.get('/setup', ah(async (req, res) => {
        if (req.actor.kind === 'staff' || await loadShop(req)) return res.redirect('/pos/app');
        send(req, res, { title: 'Set up your business', body: setupForm(req) });
    }));
    router.post('/setup', ah(async (req, res) => {
        if (req.actor.kind === 'staff' || await loadShop(req)) return res.redirect('/pos/app');
        const v = { name: str(req.body.name).slice(0, 120), phone: str(req.body.phone).slice(0, 40), address: str(req.body.address).slice(0, 200) };
        if (v.name.length < 2) return send(req, res, { title: 'Set up your business', body: setupForm(req, 'Please enter your business name.', v) }, 400);
        const ins = await q('INSERT INTO pos_shops (owner_id, name, phone, address) VALUES ($1, $2, $3, $4) ON CONFLICT (owner_id) WHERE parent_id IS NULL DO NOTHING RETURNING id', [req.session.user.id, v.name, v.phone, v.address]);
        if (ins.rows[0]) await assignCode(pool(), ins.rows[0].id);
        res.redirect('/pos/app');
    }));

    // ----- who may open what -----
    const CASHIER_PAGES = [['GET', /^\/(app|terminal|sales|account|install|api\/items)$/], ['GET', /^\/sales\/\d+\/receipt$/], ['GET', /^\/api\/pay\/[a-f0-9]{24}$/], ['POST', /^\/(api\/sales|api\/pay\/start|account\/password)$/]];
    const OWNER_ONLY = /^\/(branches|gateways|subscribe|settings|voids|audit|security|payments|2fa)(\/|$)/;
    function roleAllows(role, method, p) {
        if (role === 'owner') return true;
        if (OWNER_ONLY.test(p)) return false;
        if (role === 'manager') return true;
        return CASHIER_PAGES.some(([m, re]) => m === method && re.test(p));
    }
    const deny = (req, res) => isApi(req) ? res.status(403).json({ error: 'Your account does not have access to that.' })
        : send(req, res, { title: 'Not allowed', body: '<h1>Not allowed</h1><div class="panel"><p>Your account does not have access to this page.</p><a class="btn" href="/pos/start">Go back</a></div>' }, 403);

    // every route after this has req.actor, req.biz (the business) and req.shop (the shop or branch being worked on)
    router.use(ah(async (req, res, next) => {
        const a = req.actor;
        let biz, shop;
        if (a.kind === 'owner') {
            biz = await loadShop(req);
            if (!biz) return res.redirect('/pos/setup');
            req.branches = (await q('SELECT id, name, active FROM pos_shops WHERE id = $1 OR parent_id = $1 ORDER BY (parent_id IS NULL) DESC, name', [biz.id])).rows;
            const want = Number(req.session.posShopId), pick = req.branches.find(b => b.id === want && b.active) || req.branches[0];
            shop = pick.id === biz.id ? biz : (await q('SELECT * FROM pos_shops WHERE id = $1', [pick.id])).rows[0];
        } else {
            shop = (await q('SELECT * FROM pos_shops WHERE id = $1', [a.shopId])).rows[0];
            biz = shop && shop.parent_id ? (await q('SELECT * FROM pos_shops WHERE id = $1', [shop.parent_id])).rows[0] : shop;
            if (!shop || !biz || biz.id !== a.businessId) { delete req.session.posStaff; return res.redirect('/pos/staff/login'); }
        }
        req.biz = biz; req.shop = shop;
        if (!biz.active) return send(req, res, { title: 'Account paused', body: '<h1>Your POS account is paused</h1><div class="panel"><p>Please contact Tencent Innovations on 0740 311 014 to reactivate it.</p></div>' }, 403);
        if (!shop.active) return send(req, res, { title: 'Branch paused', body: '<h1>This branch is paused</h1><div class="panel"><p>Please ask the business owner to switch it back on.</p></div>' }, 403);
        if (!roleAllows(a.role, req.method, req.path)) return deny(req, res);
        if (a.role === 'cashier' && req.path === '/app') return res.redirect('/pos/terminal');
        req.subActive = Boolean(biz.sub_until && new Date(biz.sub_until) > new Date());
        if (!req.subActive && await isComped(biz, a, req)) { req.subActive = true; req.comped = true; }
        if (!req.subActive && !(a.role === 'owner' && /^\/subscribe(\/|$)/.test(req.path))) {
            if (isApi(req)) return res.status(402).json({ error: 'The POS subscription has ended. The owner must renew it.' });
            if (a.role === 'owner') return res.redirect('/pos/subscribe');
            return send(req, res, { title: 'Subscription ended', body: '<h1>The POS subscription has ended</h1><div class="panel"><p>Please ask the business owner to renew it. Your sales are safe and will be here when it is back on.</p></div>' }, 402);
        }
        if (a.role === 'owner' && req.method === 'GET' && !isApi(req)) req.pendingVoids = Number((await q(`SELECT count(*) n FROM pos_void_requests v JOIN pos_shops x ON x.id = v.shop_id WHERE v.status = 'pending' AND (x.id = $1 OR x.parent_id = $1)`, [biz.id])).rows[0].n);
        if (req.subActive) await runRecurring(shop.id).catch(e => console.error('Recurring expenses failed:', e.message));
        next();
    }));

    // ----- dashboard -----
    router.get('/app', ah(async (req, res) => {
        const sid = req.shop.id, today = todayNairobi(), monthStart = today.slice(0, 8) + '01', yearStart = today.slice(0, 5) + '01-01';
        const [m, inv, low, exp, expY, assets, sup, moves, recentExp] = await Promise.all([
            q(`SELECT count(*)::int n, COALESCE(sum(total_cents),0)::bigint total FROM pos_sales WHERE shop_id=$1 AND status='completed' AND (created_at AT TIME ZONE '${TZ}')::date >= $2`, [sid, monthStart]),
            q(`SELECT count(*)::int n, COALESCE(sum(stock * cost_cents) FILTER (WHERE track_stock),0)::bigint value FROM pos_items WHERE shop_id=$1 AND active`, [sid]),
            q(`SELECT count(*)::int n FROM pos_items WHERE shop_id=$1 AND active AND track_stock AND stock <= reorder_level`, [sid]),
            q(`SELECT COALESCE(sum(amount_cents),0)::bigint total FROM pos_expenses WHERE shop_id=$1 AND spent_on >= $2`, [sid, monthStart]),
            q(`SELECT COALESCE(sum(amount_cents),0)::bigint total FROM pos_expenses WHERE shop_id=$1 AND spent_on >= $2`, [sid, yearStart]),
            q(`SELECT * FROM pos_assets WHERE shop_id=$1`, [sid]),
            q(`SELECT count(*)::int n FROM pos_suppliers WHERE shop_id=$1`, [sid]),
            q(`SELECT m.change, m.balance, m.reason, m.created_at, i.name FROM pos_stock_moves m JOIN pos_items i ON i.id=m.item_id WHERE m.shop_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 6`, [sid]),
            q(`SELECT category, amount_cents, spent_on FROM pos_expenses WHERE shop_id=$1 ORDER BY spent_on DESC, id DESC LIMIT 6`, [sid])
        ]);
        const M = m.rows[0], I = inv.rows[0];
        const assetValue = assets.rows.reduce((a, x) => a + assetBookValue(x, today), 0);
        const label = { stock_in: 'Stock in', stock_out: 'Stock out', adjust: 'Count', sale: 'Sale', void: 'Voided' };
        const body = `
        <h1>Dashboard</h1>${notice(req)}
        <div class="cards">
            <div class="stat c1"><span>Total items</span><b>${I.n}</b></div>
            <div class="stat c2"><span>Inventory value (cost)</span><b>${kes(I.value)}</b></div>
            <div class="stat c3"><span>Sales this month</span><b>${kes(M.total)}</b><span>${M.n} sale${M.n === 1 ? '' : 's'}</span></div>
            <div class="stat c4"><span>Expenses this month</span><b>${kes(exp.rows[0].total)}</b></div>
            <div class="stat ${low.rows[0].n ? 'c9' : 'c2'}"><span>Low stock alerts</span><b>${low.rows[0].n}</b><a href="/pos/stock/low" style="color:#fff">View</a></div>
            <div class="stat c5"><span>Total assets</span><b>${assets.rows.length}</b></div>
            <div class="stat c7"><span>Assets value</span><b>${kes(assetValue)}</b></div>
            <div class="stat c8"><span>Suppliers</span><b>${sup.rows[0].n}</b></div>
            <div class="stat c6"><span>Expenses this year</span><b>${kes(expY.rows[0].total)}</b></div>
        </div>
        <div class="panel"><h2>Quick actions</h2><div class="row" style="align-items:center">
            <a class="btn ok" href="/pos/terminal" style="flex:0 0 auto">POS Terminal</a><a class="btn" href="/pos/items/new" style="flex:0 0 auto">Add item</a>
            <a class="btn ghost" href="/pos/stock?type=in" style="flex:0 0 auto">Stock in</a><a class="btn ghost" href="/pos/stock?type=out" style="flex:0 0 auto">Stock out</a>
            <a class="btn ghost" href="/pos/expenses" style="flex:0 0 auto">Add expense</a><a class="btn ghost" href="/pos/purchase-orders/new" style="flex:0 0 auto">New purchase order</a>
            <a class="btn ghost" href="/pos/assets" style="flex:0 0 auto">Add asset</a><a class="btn ghost" href="/pos/stock?type=set" style="flex:0 0 auto">Stock adjustment</a>
            <a class="btn ghost" href="/pos/items.csv" style="flex:0 0 auto">Export CSV</a></div></div>
        <div class="grid2" style="align-items:start">
            <div class="panel"><h2>Recent stock movements</h2>${moves.rows.length ? `<table>${moves.rows.map(x => `<tr><td>${esc(x.name)}<br><small class="muted">${esc(label[x.reason] || x.reason)} · ${esc(timeFmt(x.created_at))}</small></td><td class="num"><b style="color:${x.change < 0 ? '#dc2626' : '#16a34a'}">${x.change > 0 ? '+' : ''}${x.change}</b></td></tr>`).join('')}</table>` : '<p class="muted">No movements yet.</p>'}</div>
            <div class="panel"><h2>Recent expenses</h2>${recentExp.rows.length ? `<table>${recentExp.rows.map(x => `<tr><td>${esc(x.category)}<br><small class="muted">${esc(dateFmt(isoDate(x.spent_on) + 'T12:00:00+03:00'))}</small></td><td class="num">${fmt(x.amount_cents)}</td></tr>`).join('')}</table>` : '<p class="muted">No expenses yet.</p>'}</div>
        </div>`;
        send(req, res, { title: 'Dashboard', nav: 'app', body });
    }));

    // ----- categories -----
    router.get('/categories', ah(async (req, res) => {
        const r = await q(`SELECT c.id, c.name, count(i.id)::int n FROM pos_categories c LEFT JOIN pos_items i ON i.category_id = c.id AND i.active WHERE c.shop_id=$1 GROUP BY c.id ORDER BY c.name`, [req.shop.id]);
        const err = req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 120))}</div>` : '';
        send(req, res, { title: 'Categories', nav: 'categories', body: `<h1>Categories</h1>${notice(req)}${err}
        <div class="panel"><form action="/pos/categories" method="POST" class="row"><div><label for="c">New category</label><input id="c" name="name" required maxlength="80" placeholder="e.g. Drinks"></div><button class="btn" type="submit">Add</button></form></div>
        <div class="panel">${r.rows.length ? `<table><tr><th>Name</th><th class="num">Items</th><th></th></tr>${r.rows.map(c => `<tr><td>${esc(c.name)}</td><td class="num">${c.n}</td><td class="right"><form action="/pos/categories/${c.id}/delete" method="POST" style="display:inline"><button class="btn small ghost" type="submit">Delete</button></form></td></tr>`).join('')}</table>` : '<p class="muted">No categories yet.</p>'}</div>` });
    }));
    router.post('/categories', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 80);
        if (!name) return res.redirect('/pos/categories?err=' + encodeURIComponent('Please enter a name.'));
        const r = await q('INSERT INTO pos_categories (shop_id, name) VALUES ($1, $2) ON CONFLICT (shop_id, name) DO NOTHING', [req.shop.id, name]);
        res.redirect(r.rowCount ? '/pos/categories?ok=' + encodeURIComponent('Category added.') : '/pos/categories?err=' + encodeURIComponent('That category already exists.'));
    }));
    router.post('/categories/:id/delete', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_categories WHERE id = $1 AND shop_id = $2', [id, req.shop.id]);
        res.redirect('/pos/categories?ok=' + encodeURIComponent('Category deleted. Its items are now uncategorised.'));
    }));

    // ----- items -----
    const categoriesOf = async shopId => (await q('SELECT id, name FROM pos_categories WHERE shop_id=$1 ORDER BY name', [shopId])).rows;
    router.get('/items', ah(async (req, res) => {
        const search = str(req.query.q).slice(0, 60), showAll = req.query.all === '1';
        const r = await q(`SELECT i.*, c.name AS cat FROM pos_items i LEFT JOIN pos_categories c ON c.id = i.category_id
            WHERE i.shop_id=$1 ${showAll ? '' : 'AND i.active'} AND ($2 = '' OR i.name ILIKE '%' || $2 || '%' OR i.barcode = $2) ORDER BY i.name LIMIT 500`, [req.shop.id, search.replace(/[%_\\]/g, ' ')]);
        const body = `<h1>Items</h1>${notice(req)}
        <div class="panel"><form method="GET" class="row"><div><label for="q">Search name or barcode</label><input id="q" name="q" value="${esc(search)}"></div><div style="flex:0 0 auto"><label><input type="checkbox" name="all" value="1" ${showAll ? 'checked' : ''} style="width:auto"> Show archived</label></div><button class="btn dark" type="submit">Search</button><a class="btn" href="/pos/items/new">Add item</a></form></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Item</th><th>Category</th><th>Barcode</th><th class="num">Price</th><th class="num">Cost</th><th class="num">Stock</th><th></th></tr>${r.rows.map(i => `<tr><td>${esc(i.name)}${i.active ? '' : ' <span class="tag gray">archived</span>'}</td><td>${esc(i.cat || '')}</td><td>${esc(i.barcode || '')}</td><td class="num">${fmt(i.price_cents)}</td><td class="num">${fmt(i.cost_cents)}</td><td class="num">${i.track_stock ? `<span class="tag ${i.stock <= 0 ? 'bad' : i.stock <= i.reorder_level ? 'warn' : 'ok'}">${i.stock}</span>` : '<span class="muted">not tracked</span>'}</td><td class="right nowrap"><a class="btn small ghost" href="/pos/items/${i.id}/edit">Edit</a></td></tr>`).join('')}</table>` : '<p class="muted">No items found. <a href="/pos/items/new">Add your first item</a>.</p>'}</div>`;
        send(req, res, { title: 'Items', nav: 'items', body });
    }));

    async function itemForm(req, { item = {}, error = '', isNew = true }) {
        const cats = await categoriesOf(req.shop.id);
        const action = isNew ? '/pos/items/new' : `/pos/items/${item.id}/edit`;
        const priceVal = item.price_cents != null ? (item.price_cents / 100).toFixed(2) : (item._price || '');
        const costVal = item.cost_cents != null ? (item.cost_cents / 100).toFixed(2) : (item._cost || '');
        return `<h1>${isNew ? 'Add item' : 'Edit item'}</h1>
        <div class="panel" style="max-width:720px">${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
        <form action="${action}" method="POST">
            <div class="grid2">
                <div class="field"><label for="n">Item name</label><input id="n" name="name" required maxlength="120" value="${esc(item.name || '')}"></div>
                <div class="field"><label for="c">Category</label><select id="c" name="category_id"><option value="">No category</option>${cats.map(c => `<option value="${c.id}" ${String(item.category_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><small><a href="/pos/categories">Manage categories</a></small></div>
                <div class="field"><label for="p">Selling price (KES, includes ${VAT_RATE}% VAT)</label><input id="p" name="price" required inputmode="decimal" value="${esc(priceVal)}" placeholder="e.g. 150"></div>
                <div class="field"><label for="k">Buying cost (KES)</label><input id="k" name="cost" inputmode="decimal" value="${esc(costVal)}" placeholder="e.g. 100"><small>Used to work out your profit.</small></div>
                <div class="field"><label for="b">Barcode (optional)</label><input id="b" name="barcode" maxlength="60" value="${esc(item.barcode || '')}"><small>Scan it here, or leave blank.</small></div>
                ${isNew ? `<div class="field"><label for="s">Opening stock</label><input id="s" name="stock" inputmode="numeric" value="${esc(item._stock != null ? item._stock : '0')}"></div>` : ''}
                <div class="field"><label for="r">Warn me when stock is at or below</label><input id="r" name="reorder_level" inputmode="numeric" value="${esc(item.reorder_level != null ? item.reorder_level : 5)}"></div>
                <div class="field"><label><input type="checkbox" name="track_stock" value="1" ${item.track_stock === false ? '' : 'checked'} style="width:auto"> Track stock for this item</label><small>Turn off for services or things you do not count.</small></div>
            </div>
            <button class="btn" type="submit">Save item</button> <a class="btn ghost" href="/pos/items">Cancel</a>
        </form></div>
        ${isNew ? '' : `<form action="/pos/items/${item.id}/archive" method="POST" style="max-width:720px"><button class="btn ghost" type="submit">${item.active ? 'Archive this item (hide from the POS)' : 'Restore this item'}</button></form>`}`;
    }
    async function readItemBody(req, isNew) {
        const price = parseMoney(req.body.price), cost = str(req.body.cost) === '' ? 0 : parseMoney(req.body.cost);
        const v = { name: str(req.body.name).slice(0, 120), barcode: str(req.body.barcode).slice(0, 60) || null, category_id: parseCount(req.body.category_id, { min: 1 }), track_stock: req.body.track_stock === '1', reorder_level: parseCount(req.body.reorder_level, { min: 0, max: 100000 }), _price: str(req.body.price), _cost: str(req.body.cost), _stock: str(req.body.stock) };
        let error = '';
        if (v.name.length < 1) error = 'Please enter the item name.';
        else if (price === null || price <= 0) error = 'Please enter a selling price, for example 150 or 150.50.';
        else if (cost === null) error = 'The buying cost must be a number, for example 100.';
        else if (v.reorder_level === null) error = 'The low-stock warning level must be a whole number.';
        let stock = 0;
        if (!error && isNew) { stock = parseCount(req.body.stock || '0', { min: 0, max: 10000000 }); if (stock === null) error = 'Opening stock must be a whole number.'; }
        if (!error && v.category_id) {
            const c = await q('SELECT 1 FROM pos_categories WHERE id=$1 AND shop_id=$2', [v.category_id, req.shop.id]);
            if (!c.rowCount) v.category_id = null;   // another shop's category id is ignored
        }
        return { v: { ...v, price_cents: price, cost_cents: cost }, error, stock };
    }
    router.get('/items/new', ah(async (req, res) => send(req, res, { title: 'Add item', nav: 'items', body: await itemForm(req, {}) })));
    router.post('/items/new', ah(async (req, res) => {
        const { v, error, stock } = await readItemBody(req, true);
        if (error) return send(req, res, { title: 'Add item', nav: 'items', body: await itemForm(req, { item: v, error }) }, 400);
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const r = await client.query(`INSERT INTO pos_items (shop_id, category_id, name, barcode, price_cents, cost_cents, stock, track_stock, reorder_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
                [req.shop.id, v.category_id, v.name, v.barcode, v.price_cents, v.cost_cents, v.track_stock ? stock : 0, v.track_stock, v.reorder_level]);
            if (v.track_stock && stock > 0) await client.query(`INSERT INTO pos_stock_moves (shop_id, item_id, change, balance, reason, note) VALUES ($1,$2,$3,$3,'stock_in','Opening stock')`, [req.shop.id, r.rows[0].id, stock]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (err.code === '23505') return send(req, res, { title: 'Add item', nav: 'items', body: await itemForm(req, { item: v, error: 'Another item already uses that barcode.' }) }, 400);
            throw err;
        } finally { client.release(); }
        res.redirect('/pos/items?ok=' + encodeURIComponent('Item added.'));
    }));
    const getItem = async (req, idParam) => {
        const id = parseCount(idParam, { min: 1 });
        if (!id) return null;
        return (await q('SELECT * FROM pos_items WHERE id=$1 AND shop_id=$2', [id, req.shop.id])).rows[0] || null;
    };
    router.get('/items/:id/edit', ah(async (req, res) => {
        const item = await getItem(req, req.params.id);
        if (!item) return send(req, res, { title: 'Not found', nav: 'items', body: '<h1>Item not found</h1><a href="/pos/items">Back to items</a>' }, 404);
        send(req, res, { title: 'Edit item', nav: 'items', body: await itemForm(req, { item, isNew: false }) });
    }));
    router.post('/items/:id/edit', ah(async (req, res) => {
        const item = await getItem(req, req.params.id);
        if (!item) return res.redirect('/pos/items');
        const { v, error } = await readItemBody(req, false);
        if (error) return send(req, res, { title: 'Edit item', nav: 'items', body: await itemForm(req, { item: { ...item, ...v, id: item.id, price_cents: undefined, cost_cents: undefined }, error, isNew: false }) }, 400);
        try {
            await q(`UPDATE pos_items SET name=$3, category_id=$4, barcode=$5, price_cents=$6, cost_cents=$7, track_stock=$8, reorder_level=$9 WHERE id=$1 AND shop_id=$2`,
                [item.id, req.shop.id, v.name, v.category_id, v.barcode, v.price_cents, v.cost_cents, v.track_stock, v.reorder_level]);
        } catch (err) {
            if (err.code === '23505') return send(req, res, { title: 'Edit item', nav: 'items', body: await itemForm(req, { item: { ...item, ...v, id: item.id, price_cents: undefined, cost_cents: undefined }, error: 'Another item already uses that barcode.', isNew: false }) }, 400);
            throw err;
        }
        res.redirect('/pos/items?ok=' + encodeURIComponent('Item saved.'));
    }));
    router.post('/items/:id/archive', ah(async (req, res) => {
        const item = await getItem(req, req.params.id);
        if (item) await q('UPDATE pos_items SET active = NOT active WHERE id=$1 AND shop_id=$2', [item.id, req.shop.id]);
        res.redirect('/pos/items?ok=' + encodeURIComponent('Item updated.'));
    }));

    // ----- stock -----
    router.get('/stock', ah(async (req, res) => {
        const items = (await q('SELECT id, name, stock FROM pos_items WHERE shop_id=$1 AND active AND track_stock ORDER BY name', [req.shop.id])).rows;
        const err = req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 160))}</div>` : '';
        send(req, res, { title: 'Stock In / Out', nav: 'stock', body: `<h1>Stock In / Out</h1>${notice(req)}${err}
        <div class="panel" style="max-width:640px">${items.length ? `<form action="/pos/stock" method="POST">
            <div class="field"><label for="i">Item</label><select id="i" name="item_id" required>${items.map(i => `<option value="${i.id}">${esc(i.name)} (now ${i.stock})</option>`).join('')}</select></div>
            <div class="field"><label for="t">What happened?</label><select id="t" name="type"><option value="in" ${req.query.type === 'in' ? 'selected' : ''}>Stock in: received more stock</option><option value="out" ${req.query.type === 'out' ? 'selected' : ''}>Stock out: damaged, expired, used or lost</option><option value="set" ${req.query.type === 'set' ? 'selected' : ''}>Stock count: set the exact number on the shelf</option></select></div>
            <div class="field"><label for="q">Quantity</label><input id="q" name="qty" required inputmode="numeric" placeholder="e.g. 24"></div>
            <div class="field"><label for="nt">Note (optional)</label><input id="nt" name="note" maxlength="200" placeholder="e.g. Delivery from supplier"></div>
            <button class="btn" type="submit">Save</button></form>` : '<p class="muted">You have no tracked items yet. <a href="/pos/items/new">Add an item</a> first.</p>'}</div>` });
    }));
    router.post('/stock', ah(async (req, res) => {
        const itemId = parseCount(req.body.item_id, { min: 1 });
        const type = ['in', 'out', 'set'].includes(req.body.type) ? req.body.type : '';
        const qty = parseCount(req.body.qty, { min: 0, max: 10000000 });
        const note = str(req.body.note).slice(0, 200);
        const fail = m => res.redirect('/pos/stock?err=' + encodeURIComponent(m));
        if (!itemId || !type || qty === null || (type !== 'set' && qty < 1)) return fail('Please choose an item and enter a whole-number quantity.');
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const it = (await client.query('SELECT id, stock FROM pos_items WHERE id=$1 AND shop_id=$2 AND track_stock FOR UPDATE', [itemId, req.shop.id])).rows[0];
            if (!it) { await client.query('ROLLBACK'); return fail('Item not found.'); }
            const change = type === 'in' ? qty : type === 'out' ? -qty : qty - it.stock;
            const balance = it.stock + change;
            if (balance < 0) { await client.query('ROLLBACK'); return fail(`You only have ${it.stock} in stock, so you cannot remove ${qty}.`); }
            await client.query('UPDATE pos_items SET stock=$2 WHERE id=$1', [it.id, balance]);
            await client.query(`INSERT INTO pos_stock_moves (shop_id, item_id, change, balance, reason, note) VALUES ($1,$2,$3,$4,$5,$6)`, [req.shop.id, it.id, change, balance, type === 'in' ? 'stock_in' : type === 'out' ? 'stock_out' : 'adjust', note]);
            await client.query('COMMIT');
        } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
        await audit(req, 'stock.' + type, `item #${itemId} qty ${qty}${note ? ': ' + note : ''}`);
        res.redirect('/pos/stock?ok=' + encodeURIComponent('Stock updated.'));
    }));
    router.get('/stock/history', ah(async (req, res) => {
        const r = await q(`SELECT m.*, i.name FROM pos_stock_moves m JOIN pos_items i ON i.id = m.item_id WHERE m.shop_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 300`, [req.shop.id]);
        const label = { stock_in: 'Stock in', stock_out: 'Stock out', adjust: 'Stock count', sale: 'Sale', void: 'Sale voided' };
        send(req, res, { title: 'Stock History', nav: 'history', body: `<h1>Stock History</h1><div class="panel tablewrap">${r.rows.length ? `<table><tr><th>When</th><th>Item</th><th>Type</th><th class="num">Change</th><th class="num">Balance</th><th>Note</th></tr>${r.rows.map(m => `<tr><td class="nowrap">${esc(timeFmt(m.created_at))}</td><td>${esc(m.name)}</td><td>${esc(label[m.reason] || m.reason)}</td><td class="num"><b style="color:${m.change < 0 ? '#dc2626' : '#16a34a'}">${m.change > 0 ? '+' : ''}${m.change}</b></td><td class="num">${m.balance}</td><td>${esc(m.note)}</td></tr>`).join('')}</table>` : '<p class="muted">No stock movements yet.</p>'}</div>` });
    }));
    router.get('/stock/low', ah(async (req, res) => {
        const r = await q(`SELECT id, name, stock, reorder_level FROM pos_items WHERE shop_id=$1 AND active AND track_stock AND stock <= reorder_level ORDER BY stock ASC, name`, [req.shop.id]);
        send(req, res, { title: 'Low Stock Alerts', nav: 'low', body: `<h1>Low Stock Alerts</h1><div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Item</th><th class="num">In stock</th><th class="num">Warning level</th><th></th></tr>${r.rows.map(i => `<tr><td>${esc(i.name)}</td><td class="num"><span class="tag ${i.stock <= 0 ? 'bad' : 'warn'}">${i.stock}</span></td><td class="num">${i.reorder_level}</td><td class="right"><a class="btn small" href="/pos/stock">Add stock</a></td></tr>`).join('')}</table>` : '<p class="muted">All good. Nothing is at or below its warning level.</p>'}</div>` });
    }));

    // ----- POS terminal -----
    router.get('/api/items', ah(async (req, res) => {
        const r = await q(`SELECT i.id, i.name, i.barcode, i.price_cents, i.stock, i.track_stock, c.name AS category FROM pos_items i LEFT JOIN pos_categories c ON c.id = i.category_id WHERE i.shop_id=$1 AND i.active ORDER BY i.name LIMIT 2000`, [req.shop.id]);
        res.set('Cache-Control', 'no-store').json(r.rows.map(i => ({ id: i.id, name: i.name, barcode: i.barcode || '', price: i.price_cents, stock: i.track_stock ? i.stock : null, category: i.category || '' })));
    }));
    const LIVE_PROVIDERS = PAYSTACK_ON ? ['mpesa', 'paystack'] : ['mpesa'];
    const hasGateway = async bizId => vault.enabled && (await q('SELECT 1 FROM pos_gateways WHERE business_id=$1 AND active AND provider = ANY($2::text[]) LIMIT 1', [bizId, LIVE_PROVIDERS])).rowCount > 0;
    router.get('/terminal', ah(async (req, res) => {
        const stkOn = await hasGateway(req.biz.id), vatOn = Boolean(req.biz.vat_enabled);
        const body = `<h1 class="noprint">POS Terminal</h1>
        <div class="pos-wrap">
            <div>
                <div class="panel" style="margin-bottom:0"><label for="find">Search items, or scan a barcode and press Enter</label><input id="find" type="search" autocomplete="off" autofocus placeholder="Type a name or scan..."><div class="chips" id="chips"></div></div>
                <div class="pos-items" id="grid" aria-live="polite"></div>
            </div>
            <div class="panel cart">
                <h2>Current sale</h2>
                <div class="lines" id="lines"><p class="muted" style="padding:10px 2px">Tap an item to add it.</p></div>
                <div class="tot"><span>Subtotal</span><span id="sub">0.00</span></div>
                <div class="tot"><span>Discount (KES)</span><input id="disc" inputmode="decimal" style="width:110px;text-align:right" placeholder="0"></div>
                <div class="tot big"><span>Total</span><span id="total">0.00</span></div>
                ${vatOn ? `<div class="tot muted"><small>Includes VAT ${VAT_RATE}%</small><small id="vat">0.00</small></div>` : ''}
                <div class="pay" style="grid-template-columns:repeat(${stkOn ? 3 : 2},1fr)"><button type="button" id="m-cash" class="on">Cash</button><button type="button" id="m-mpesa">M-Pesa code</button>${stkOn ? '<button type="button" id="m-stk">Phone prompt</button>' : ''}</div>
                <div id="cashbox" class="field"><label for="tender">Cash received (KES)</label><input id="tender" inputmode="decimal" placeholder="0"><div class="tot" style="margin-top:6px"><span>Change</span><b id="change">0.00</b></div></div>
                <div id="mpesabox" class="field" style="display:none"><label for="mref">M-Pesa code (from the customer's SMS)</label><input id="mref" maxlength="10" autocapitalize="characters" placeholder="e.g. SHK4A1B2C3"></div>
                <div id="stkbox" class="field" style="display:none"><label for="sphone">Customer M-Pesa number</label><input id="sphone" type="tel" placeholder="0712345678"><small>The customer gets a prompt on their phone and types their PIN.</small></div>
                <div class="field" id="cpbox"><label for="cphone">Customer phone (optional, to share the receipt)</label><input id="cphone" type="tel" placeholder="0712345678"></div>
                <div id="err" class="alert" role="alert" style="display:none"></div>
                <button class="btn ok" id="done" type="button" style="width:100%;padding:13px;font-size:1rem" disabled>Complete sale</button>
                <button class="btn ghost" id="clear" type="button" style="width:100%;margin-top:8px">Clear sale</button>
            </div>
        </div>
        <div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="mtitle"><div class="box"><h2 id="mtitle">Sale complete</h2><p id="mtext" style="font-size:1.1rem"></p>
            <div class="row" style="justify-content:center"><a class="btn" id="mprint" target="_blank" rel="noopener">Print receipt</a><a class="btn ghost" id="mwa" target="_blank" rel="noopener" style="display:none">Send on WhatsApp</a></div>
            <button class="btn ok" id="mnew" type="button" style="margin-top:14px;width:100%">New sale</button></div></div>
        <div class="modal" id="wait" role="dialog" aria-modal="true" aria-labelledby="wtitle"><div class="box"><h2 id="wtitle">Waiting for payment</h2><p id="wtext" style="font-size:1.05rem">Ask the customer to check their phone and enter their M-Pesa PIN.</p>
            <button class="btn ghost" id="wcancel" type="button" style="margin-top:10px;width:100%">Stop waiting</button></div></div>
        <script nonce="${req.nonce || ''}">
        (function () {
            var VAT_ON = ${vatOn ? 'true' : 'false'}, VAT_RATE = ${VAT_RATE};
            var items = [], cart = [], cat = '', method = 'cash', busy = false, timer = null;
            var $ = function (id) { return document.getElementById(id); };
            function fmt(c) { return (c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
            function money(v) { var s = String(v || '').replace(/,/g, '').trim(); if (!/^[0-9]{1,9}([.][0-9]{1,2})?$/.test(s)) return 0; return Math.round(parseFloat(s) * 100); }
            function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
            function showErr(m) { var e = $('err'); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; }
            function load() {
                fetch('/pos/api/items', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) { items = d; chips(); draw(); }).catch(function () { showErr('Could not load your items. Check your connection and refresh.'); });
            }
            function chips() {
                var c = $('chips'); c.textContent = ''; var cats = ['']; items.forEach(function (i) { if (i.category && cats.indexOf(i.category) < 0) cats.push(i.category); });
                if (cats.length < 2) return;
                cats.forEach(function (n) { var b = el('button', 'chip' + (n === cat ? ' on' : ''), n || 'All'); b.type = 'button'; b.addEventListener('click', function () { cat = n; chips(); draw(); }); c.appendChild(b); });
            }
            function draw() {
                var f = $('find').value.trim().toLowerCase(), g = $('grid'); g.textContent = '';
                var list = items.filter(function (i) { return (!cat || i.category === cat) && (!f || i.name.toLowerCase().indexOf(f) >= 0 || (i.barcode && i.barcode.toLowerCase() === f)); }).slice(0, 120);
                if (!list.length) { g.appendChild(el('p', 'muted', items.length ? 'No matching items.' : 'You have no items yet. Add items first.')); return; }
                list.forEach(function (i) {
                    var out = i.stock !== null && i.stock <= 0;
                    var b = el('button', 'pos-item' + (out ? ' out' : '')); b.type = 'button';
                    b.appendChild(el('b', '', i.name)); b.appendChild(el('span', 'p', 'KES ' + fmt(i.price)));
                    b.appendChild(el('span', 's', i.stock === null ? '' : (out ? 'Out of stock' : i.stock + ' in stock')));
                    b.addEventListener('click', function () { add(i); }); g.appendChild(b);
                });
            }
            function add(i) {
                var l = cart.filter(function (x) { return x.id === i.id; })[0];
                if (i.stock !== null && (l ? l.qty : 0) + 1 > i.stock) { showErr('Only ' + i.stock + ' of "' + i.name + '" in stock.'); return; }
                showErr(''); if (l) l.qty++; else cart.push({ id: i.id, name: i.name, price: i.price, qty: 1, stock: i.stock });
                render();
            }
            function totals() { var s = 0; cart.forEach(function (l) { s += l.price * l.qty; }); var d = Math.min(money($('disc').value), s); var t = s - d; return { sub: s, disc: d, total: t, vat: VAT_ON ? Math.round(t * VAT_RATE / (100 + VAT_RATE)) : 0 }; }
            function render() {
                var box = $('lines'); box.textContent = '';
                if (!cart.length) box.appendChild(el('p', 'muted', 'Tap an item to add it.'));
                cart.forEach(function (l, idx) {
                    var r = el('div', 'cline'), nm = el('div'); nm.appendChild(el('div', '', l.name)); nm.appendChild(el('small', 'muted', 'KES ' + fmt(l.price) + ' each'));
                    var q = el('div', 'qty'), mi = el('button', '', '-'), n = el('span', '', String(l.qty)), pl = el('button', '', '+'); mi.type = pl.type = 'button';
                    mi.setAttribute('aria-label', 'Less ' + l.name); pl.setAttribute('aria-label', 'More ' + l.name);
                    mi.addEventListener('click', function () { l.qty--; if (l.qty <= 0) cart.splice(idx, 1); render(); });
                    pl.addEventListener('click', function () { if (l.stock !== null && l.qty + 1 > l.stock) { showErr('Only ' + l.stock + ' of "' + l.name + '" in stock.'); return; } showErr(''); l.qty++; render(); });
                    q.appendChild(mi); q.appendChild(n); q.appendChild(pl);
                    r.appendChild(nm); r.appendChild(q); r.appendChild(el('b', '', fmt(l.price * l.qty))); box.appendChild(r);
                });
                var t = totals(); $('sub').textContent = fmt(t.sub); $('total').textContent = fmt(t.total); if ($('vat')) $('vat').textContent = fmt(t.vat);
                var tend = money($('tender').value); $('change').textContent = fmt(Math.max(0, tend - t.total));
                $('done').disabled = busy || !cart.length;
            }
            function setMethod(m) {
                method = m; $('m-cash').className = m === 'cash' ? 'on' : ''; $('m-mpesa').className = m === 'mpesa' ? 'on' : ''; if ($('m-stk')) $('m-stk').className = m === 'stk' ? 'on' : '';
                $('cashbox').style.display = m === 'cash' ? '' : 'none'; $('mpesabox').style.display = m === 'mpesa' ? '' : 'none'; $('stkbox').style.display = m === 'stk' ? '' : 'none'; $('cpbox').style.display = m === 'stk' ? 'none' : '';
                $('done').textContent = m === 'stk' ? 'Send M-Pesa prompt' : 'Complete sale'; showErr('');
            }
            function reset() { cart = []; $('disc').value = ''; $('tender').value = ''; $('mref').value = ''; $('cphone').value = ''; if ($('sphone')) $('sphone').value = ''; showErr(''); setMethod('cash'); render(); $('find').value = ''; draw(); load(); $('find').focus(); }
            function lines() { return cart.map(function (l) { return { id: l.id, qty: l.qty }; }); }
            function finished(d) {
                $('mtext').textContent = 'Receipt #' + d.receiptNo + ' - KES ' + fmt(d.total) + (d.change ? ' - Change KES ' + fmt(d.change) : '');
                $('mprint').href = d.receiptUrl; var wa = $('mwa'); if (d.whatsapp) { wa.href = d.whatsapp; wa.style.display = ''; } else wa.style.display = 'none';
                $('modal').classList.add('show'); $('mnew').focus();
            }
            function stopWait() { if (timer) { clearInterval(timer); timer = null; } $('wait').classList.remove('show'); busy = false; render(); }
            function poll(id) {
                var tries = 0;
                timer = setInterval(function () {
                    tries++;
                    fetch('/pos/api/pay/' + id, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
                        if (d.status === 'paid') { stopWait(); finished(d); }
                        else if (d.status === 'failed' || d.status === 'review') { stopWait(); showErr(d.status === 'review' ? 'The payment needs checking by the owner (see Payment Gateways). Do not give goods until it is confirmed.' : (d.error || 'The customer did not complete the payment.')); }
                        else if (tries >= 45) { $('wtext').textContent = 'No answer yet. If the customer already paid, the sale is saved automatically: check Sales History. You can keep waiting or stop.'; }
                    }).catch(function () {});
                }, 3000);
            }
            function startStk() {
                var phone = $('sphone').value.trim(); if (!phone) { showErr("Enter the customer's M-Pesa number."); return; }
                busy = true; $('done').disabled = true; showErr('');
                fetch('/pos/api/pay/start', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: lines(), discount: $('disc').value, phone: phone }) })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (x) {
                    if (!x.ok) { busy = false; showErr(x.d.error || 'The prompt could not be sent.'); render(); return; }
                    $('wtext').textContent = 'KES ' + x.d.amountKes.toLocaleString('en-KE') + ': ask the customer to check their phone and enter their M-Pesa PIN.'; $('wait').classList.add('show'); poll(x.d.id);
                }).catch(function () { busy = false; showErr('Connection problem. The prompt may not have been sent.'); render(); });
            }
            $('find').addEventListener('input', draw);
            $('find').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return; e.preventDefault(); var f = $('find').value.trim().toLowerCase(); if (!f) return;
                var hit = items.filter(function (i) { return i.barcode && i.barcode.toLowerCase() === f; })[0]; if (!hit) { var m = items.filter(function (i) { return i.name.toLowerCase().indexOf(f) >= 0; }); if (m.length === 1) hit = m[0]; }
                if (hit) { add(hit); $('find').value = ''; draw(); } else showErr('No item matches "' + $('find').value.trim() + '".');
            });
            ['disc', 'tender'].forEach(function (id) { $(id).addEventListener('input', render); });
            $('m-cash').addEventListener('click', function () { setMethod('cash'); }); $('m-mpesa').addEventListener('click', function () { setMethod('mpesa'); }); if ($('m-stk')) $('m-stk').addEventListener('click', function () { setMethod('stk'); });
            $('wcancel').addEventListener('click', stopWait);
            $('clear').addEventListener('click', reset); $('mnew').addEventListener('click', function () { $('modal').classList.remove('show'); reset(); });
            $('done').addEventListener('click', function () {
                if (busy || !cart.length) return; var t = totals();
                if (method === 'stk') { startStk(); return; }
                if (method === 'cash' && money($('tender').value) < t.total) { showErr('The cash received is less than the total.'); return; }
                if (method === 'mpesa' && !/^[A-Za-z0-9]{10}$/.test($('mref').value.trim())) { showErr("The M-Pesa code is 10 letters and numbers, as in the customer's SMS."); return; }
                busy = true; $('done').disabled = true; $('done').textContent = 'Saving...'; showErr('');
                fetch('/pos/api/sales', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    lines: lines(), discount: $('disc').value, method: method, tendered: $('tender').value, mpesaRef: $('mref').value.trim(), customerPhone: $('cphone').value.trim() }) })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (x) {
                    busy = false; $('done').textContent = 'Complete sale';
                    if (!x.ok) { showErr(x.d.error || 'The sale could not be saved.'); render(); return; }
                    finished(x.d);
                }).catch(function () { busy = false; $('done').textContent = 'Complete sale'; showErr('Connection problem. The sale may not have been saved: check Sales History before trying again.'); render(); });
            });
            setMethod('cash'); render(); load();
        })();
        </script>`;
        send(req, res, { title: 'POS Terminal', nav: 'terminal', body });
    }));

    // ----- saving a sale -----
    const saleLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait a moment.' } });
    const pollLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1500, standardHeaders: true, legacyHeaders: false, message: { status: 'pending' } });
    const cashierOf = req => ({ staffId: req.actor.kind === 'staff' ? req.actor.staffId : null, name: String(req.actor.name || '').slice(0, 80) });
    const kePhone = raw => { const m = String(raw || '').replace(/[\s-]/g, '').match(/^(?:\+?254|0)([17]\d{8})$/); return m ? '254' + m[1] : ''; };

    // staff may only take off so much; every discount is written to the audit log
    function discountProblem(req, subtotal, discount) {
        if (!discount || req.actor.kind === 'owner') return '';
        const pct = Number.isInteger(Number(req.biz.max_discount_pct)) ? Number(req.biz.max_discount_pct) : 10;
        return discount > Math.floor(subtotal * pct / 100) + 100 ? `Discounts above ${pct}% need the owner. Ask the owner to make this sale or raise the limit in Shop Settings.` : '';   // +KES 1 for rounding
    }
    // reads the cart from the request: { want: Map(itemId -> qty), discountIn } or { error }
    function readCart(b) {
        if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) return { error: 'The sale has no items.' };
        const want = new Map();
        for (const l of b.lines) {
            const id = parseCount(l && l.id, { min: 1 }), qty = parseCount(l && l.qty, { min: 1, max: 100000 });
            if (!id || !qty) return { error: 'One of the items is not valid.' };
            want.set(id, (want.get(id) || 0) + qty);
        }
        const discountIn = String(b.discount || '').trim() === '' ? 0 : parseMoney(b.discount);
        if (discountIn === null) return { error: 'The discount must be a number.' };
        return { want, discountIn };
    }
    // prices come from the database, never from the browser
    async function priceCart(db, shopId, want, lock) {
        const ids = [...want.keys()];
        const found = (await db.query(`SELECT id, name, price_cents, cost_cents, stock, track_stock FROM pos_items WHERE shop_id=$1 AND active AND id = ANY($2::int[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [shopId, ids])).rows;
        if (found.length !== ids.length) return { error: 'An item in the cart is no longer available. Refresh and try again.', code: 409 };
        const lines = [];
        for (const it of found) {
            const qty = want.get(it.id);
            if (it.track_stock && it.stock < qty) return { error: `Not enough stock for "${it.name}": ${it.stock} left.`, code: 409 };
            lines.push({ id: it.id, name: it.name, qty, price: Number(it.price_cents), cost: Number(it.cost_cents) });
        }
        return { lines };
    }
    // writes the sale, its lines, VAT and stock movements inside the caller's transaction
    async function insertSale(client, shop, biz, d) {
        const subtotal = d.lines.reduce((a, l) => a + l.price * l.qty, 0), discount = Math.min(d.discount, subtotal), total = subtotal - discount;
        const vat = biz.vat_enabled ? vatOf(total) : 0;   // prices already include VAT, so this is the VAT inside the total
        const no = (await client.query('UPDATE pos_shops SET next_receipt = next_receipt + 1 WHERE id=$1 RETURNING next_receipt - 1 AS no', [shop.id])).rows[0].no;
        const paid = d.paid == null ? total : d.paid;
        const sale = (await client.query(`INSERT INTO pos_sales (shop_id, receipt_no, subtotal_cents, discount_cents, total_cents, vat_cents, paid_cents, change_cents, method, mpesa_ref, customer_phone, staff_id, cashier_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
            [shop.id, no, subtotal, discount, total, vat, paid, d.change || 0, d.method, d.mref || null, d.phone || '', d.staffId || null, d.cashierName || ''])).rows[0];
        const oversold = [];
        for (const l of d.lines) {
            await client.query('INSERT INTO pos_sale_items (sale_id, item_id, name, qty, unit_price_cents, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6)', [sale.id, l.id, l.name, l.qty, l.price, l.cost]);
            const st = (await client.query('UPDATE pos_items SET stock = CASE WHEN track_stock THEN stock - $2 ELSE stock END WHERE id=$1 AND shop_id=$3 RETURNING stock, track_stock', [l.id, l.qty, shop.id])).rows[0];
            if (st && st.track_stock && st.stock < 0) oversold.push(l.name);   // only possible for a payment that arrived after the stock was gone
            if (st && st.track_stock) await client.query(`INSERT INTO pos_stock_moves (shop_id, item_id, change, balance, reason, note, sale_id) VALUES ($1,$2,$3,$4,'sale',$5,$6)`, [shop.id, l.id, -l.qty, st.stock, 'Receipt #' + no, sale.id]);
        }
        return { id: sale.id, no, total, change: d.change || 0, oversold };
    }
    const whatsappLink = (shop, phone, no, total, method) => phone ? `https://wa.me/${phone}?text=${encodeURIComponent(`Thank you for shopping at ${shop.name}. Receipt #${no}: KES ${fmt(total)} paid by ${method === 'cash' ? 'cash' : 'M-Pesa'}.`)}` : '';

    router.post('/api/sales', saleLimiter, ah(async (req, res) => {
        const bad = (m, code = 400) => res.status(code).json({ error: m });
        const b = req.body || {};
        const method = b.method === 'mpesa' ? 'mpesa' : b.method === 'cash' ? 'cash' : '';
        if (!method) return bad('Choose cash or M-Pesa.');
        const cart = readCart(b);
        if (cart.error) return bad(cart.error);
        const mref = method === 'mpesa' ? String(b.mpesaRef || '').trim().toUpperCase() : '';
        if (method === 'mpesa' && !/^[A-Z0-9]{10}$/.test(mref)) return bad("The M-Pesa code is 10 letters and numbers, as in the customer's SMS.");
        if (method === 'mpesa' && req.actor.kind !== 'owner' && req.biz.allow_manual_codes === false) return bad('Typed M-Pesa codes are switched off for this business. Use the "M-Pesa prompt" option.', 403);
        const phoneRaw = String(b.customerPhone || '').replace(/[\s-]/g, ''), phone = kePhone(phoneRaw);
        if (phoneRaw && !phone) return bad('The customer phone number is not valid.');
        const who = cashierOf(req);
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const priced = await priceCart(client, req.shop.id, cart.want, true);
            if (priced.error) { await client.query('ROLLBACK'); return bad(priced.error, priced.code); }
            const subtotal = priced.lines.reduce((a, l) => a + l.price * l.qty, 0), discount = Math.min(cart.discountIn, subtotal), total = subtotal - discount;
            const dProb = discountProblem(req, subtotal, discount);
            if (dProb) { await client.query('ROLLBACK'); await audit(req, 'sale.discount_blocked', `KES ${fmt(discount)} off KES ${fmt(subtotal)}`); return bad(dProb, 403); }
            if (mref) {
                const dup = await client.query('SELECT 1 FROM pos_sales WHERE mpesa_ref=$1 LIMIT 1', [mref]);
                if (dup.rowCount) { await client.query('ROLLBACK'); await audit(req, 'sale.code_reused', mref); return bad('That M-Pesa code has already been used for another sale.', 409); }
            }
            let paid = total, change = 0;
            if (method === 'cash') {
                const tendered = String(b.tendered || '').trim() === '' ? null : parseMoney(b.tendered);
                if (tendered === null || tendered < total) { await client.query('ROLLBACK'); return bad('The cash received is less than the total.'); }
                paid = tendered; change = tendered - total;
            }
            const sale = await insertSale(client, req.shop, req.biz, { lines: priced.lines, discount, method, mref, phone, paid, change, staffId: who.staffId, cashierName: who.name });
            await client.query('COMMIT');
            if (discount > 0) await audit(req, 'sale.discount', `Receipt #${sale.no}: KES ${fmt(discount)} off KES ${fmt(subtotal)}`);
            res.json({ ok: true, saleId: sale.id, receiptNo: sale.no, total: sale.total, change, receiptUrl: `/pos/sales/${sale.id}/receipt`, whatsapp: whatsappLink(req.shop, phone, sale.no, sale.total, method) });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (err && err.code === '23505' && /mpesa_ref/.test(String(err.constraint || err.message))) return bad('That M-Pesa code has already been used for another sale.', 409);
            throw err;
        } finally { client.release(); }
    }));

    // ----- phone prompt (STK push) through the business's own gateway -----
    async function loadGateway(where, params) {   // returns the gateway with its secrets decrypted, or null
        const row = (await q(`SELECT * FROM pos_gateways WHERE ${where} LIMIT 1`, params)).rows[0];
        if (!row || !vault.enabled) return null;
        try { return { id: row.id, businessId: row.business_id, provider: row.provider, cfg: row.cfg || {}, secrets: vault.open(row.secrets, `${row.business_id}:${row.provider}`), token: String(row.callback_token).trim(), active: row.active, isDefault: row.is_default }; }
        catch (e) { console.error('Could not read gateway', row.id + ':', e.message); return null; }
    }
    const callbackUrlFor = gw => `${publicBaseUrl}/pos/${gw.provider === 'mpesa' ? 'mpesa/cb' : 'paystack/hook'}/${gw.token}`;

    router.post('/api/pay/start', saleLimiter, ah(async (req, res) => {
        const bad = (m, code = 400) => res.status(code).json({ error: m });
        const b = req.body || {};
        const gw = await loadGateway('business_id=$1 AND active AND provider = ANY($2::text[]) ORDER BY is_default DESC, id', [req.biz.id, LIVE_PROVIDERS]);
        if (!gw) return bad('Phone prompts are not set up. The owner can add payment credentials under Payment Gateways.');
        if (!publicBaseUrl.startsWith('https://')) return bad('Phone prompts need the site address (PUBLIC_BASE_URL) to be set to an https address.', 503);
        const phone = kePhone(b.phone);
        if (!phone) return bad("The customer's phone number is not valid. Use a Safaricom number such as 0712345678.");
        const cart = readCart(b);
        if (cart.error) return bad(cart.error);
        const priced = await priceCart({ query: q }, req.shop.id, cart.want, false);
        if (priced.error) return bad(priced.error, priced.code);
        const subtotal = priced.lines.reduce((a, l) => a + l.price * l.qty, 0), discount = Math.min(cart.discountIn, subtotal), total = subtotal - discount;
        const dProb = discountProblem(req, subtotal, discount);
        if (dProb) { await audit(req, 'sale.discount_blocked', `KES ${fmt(discount)} off KES ${fmt(subtotal)}`); return bad(dProb, 403); }
        const amountKes = Math.ceil(total / 100);   // M-Pesa takes whole shillings
        if (amountKes < 1) return bad('The total is too small to charge.');
        const who = cashierOf(req), id = crypto.randomBytes(12).toString('hex');
        await q('INSERT INTO pos_payments (id, shop_id, gateway_id, staff_id, cashier_name, amount_kes, phone, status, cart) VALUES ($1,$2,$3,$4,$5,$6,$7,\'pending\',$8::jsonb)',
            [id, req.shop.id, gw.id, who.staffId, who.name, amountKes, phone, JSON.stringify({ lines: priced.lines, discount, customerPhone: phone })]);
        try {
            const r = await GW.PROVIDERS[gw.provider].charge(gw, { amountKes, phone, ref: gw.provider === 'mpesa' ? id.slice(0, 12).toUpperCase() : id, desc: 'Sale payment', callbackUrl: callbackUrlFor(gw), email: (req.session.user && req.session.user.email) || 'pos@tencent.invalid' });
            await q('UPDATE pos_payments SET provider_ref=$2, updated_at=now() WHERE id=$1', [id, r.providerRef]);
        } catch (e) {
            console.error('POS prompt failed:', e.message);
            await q(`UPDATE pos_payments SET status='failed', fail_reason=$2, updated_at=now() WHERE id=$1`, [id, String(e.message).slice(0, 160)]);
            return bad('The prompt could not be sent: ' + String(e.message).slice(0, 120), 502);
        }
        res.json({ ok: true, id, amountKes });
    }));

    const lastCheck = new Map();   // payment id -> when we last asked the gateway
    router.get('/api/pay/:id', pollLimiter, ah(async (req, res) => {
        let p = (await q('SELECT * FROM pos_payments WHERE id=$1 AND shop_id=$2', [req.params.id, req.shop.id])).rows[0];
        if (!p) return res.status(404).json({ status: 'unknown' });
        if (p.status === 'pending' && p.provider_ref && Date.now() - new Date(p.created_at).getTime() > 20000 && Date.now() - (lastCheck.get(p.id) || 0) > 8000) {
            lastCheck.set(p.id, Date.now());
            const gw = await loadGateway('id=$1', [p.gateway_id]);
            if (gw) {
                const v = await GW.PROVIDERS[gw.provider].verify(gw, p.provider_ref).catch(() => ({ state: 'pending' }));
                await applyVerdict(p, v);
                p = (await q('SELECT * FROM pos_payments WHERE id=$1', [p.id])).rows[0];
            }
        }
        const out = { status: p.status, error: p.fail_reason || '' };
        if (p.status === 'paid' && p.sale_id) {
            const s = (await q('SELECT id, receipt_no, total_cents, change_cents, customer_phone FROM pos_sales WHERE id=$1', [p.sale_id])).rows[0];
            if (s) Object.assign(out, { saleId: s.id, receiptNo: s.receipt_no, total: Number(s.total_cents), change: Number(s.change_cents), receiptUrl: `/pos/sales/${s.id}/receipt`, whatsapp: whatsappLink(req.shop, s.customer_phone, s.receipt_no, Number(s.total_cents), 'mpesa') });
        }
        res.set('Cache-Control', 'no-store').json(out);
    }));

    // Turns a confirmed payment into a sale exactly once, from the cart saved when the prompt was sent
    // (so the sale matches what the customer was charged, even if the cashier has left the screen).
    async function finalizePayment(id, receipt) {
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const p = (await client.query('SELECT * FROM pos_payments WHERE id=$1 FOR UPDATE', [id])).rows[0];
            if (!p || p.sale_id) { await client.query('ROLLBACK'); return; }
            const shop = (await client.query('SELECT * FROM pos_shops WHERE id=$1', [p.shop_id])).rows[0];
            const biz = shop.parent_id ? (await client.query('SELECT * FROM pos_shops WHERE id=$1', [shop.parent_id])).rows[0] : shop;
            const cart = p.cart, mref = String(receipt || '').slice(0, 20) || null;
            const sale = await insertSale(client, shop, biz, { lines: cart.lines, discount: cart.discount, method: 'mpesa', mref, phone: cart.customerPhone || '', paid: p.amount_kes * 100, change: 0, staffId: p.staff_id, cashierName: p.cashier_name });
            await client.query(`UPDATE pos_payments SET status='paid', receipt=$2, sale_id=$3, updated_at=now() WHERE id=$1`, [id, String(receipt || '').slice(0, 40), sale.id]);
            await client.query('COMMIT');
            if (sale.oversold.length) await auditRaw(shop.parent_id || shop.id, shop.id, 'system', null, '', 'stock.negative', 'Paid sale after stock ran out: ' + sale.oversold.join(', '), '');
            await auditRaw(shop.parent_id || shop.id, shop.id, 'system', null, '', 'payment.sale', `receipt #${sale.no} code ${mref || ''}`, '');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    }
    const setPaymentState = (id, status, reason) => q(`UPDATE pos_payments SET status=$2, fail_reason=$3, updated_at=now() WHERE id=$1 AND status IN ('pending','review')`, [id, status, String(reason || '').slice(0, 160)]);
    async function applyVerdict(p, v) {   // v comes from the gateway's own "check this payment" call
        if (v.state === 'paid') {
            if ((v.amountKes != null && v.amountKes !== p.amount_kes) || (v.currency && v.currency !== 'KES')) { await setPaymentState(p.id, 'review', 'Amount paid does not match the sale'); return; }
            await finalizePayment(p.id, v.receipt || '');
        } else if (v.state === 'failed') await setPaymentState(p.id, 'failed', v.reason || 'Payment not completed');
    }
    async function gatewayCallback(provider, token, body) {
        if (!/^[a-f0-9]{48}$/.test(String(token))) return;
        const gw = await loadGateway('callback_token=$1 AND provider=$2', [token, provider]);
        if (!gw) return;
        const prov = GW.PROVIDERS[provider], cb = prov.parseCallback(body);
        if (!cb) return;
        const p = (await q('SELECT * FROM pos_payments WHERE provider_ref=$1 AND gateway_id=$2', [cb.providerRef, gw.id])).rows[0];
        if (!p || p.status === 'paid') return;
        if (cb.hintOnly) return applyVerdict(p, await prov.verify(gw, p.provider_ref));   // webhook is only a nudge: ask the gateway for the truth
        if (!cb.succeeded) return setPaymentState(p.id, 'failed', cb.reason || 'Payment not completed');
        if (cb.amountKes !== null && cb.amountKes !== p.amount_kes) return setPaymentState(p.id, 'review', 'Amount paid does not match the sale');
        // The callback address contains a secret, but a leaked secret must not be enough to fake a payment:
        // a sale is only saved when the payment company itself confirms it. If it cannot confirm yet, the payment
        // stays pending and the background check keeps asking (see sweep).
        const v = await prov.verify(gw, p.provider_ref).catch(() => ({ state: 'pending' }));
        if (v.state === 'failed') return setPaymentState(p.id, 'review', 'Callback and status check disagree');
        if (v.state !== 'paid') return;
        await finalizePayment(p.id, cb.receipt || v.receipt);
    }

    // ----- sales history, receipts, void -----
    router.get('/sales', ah(async (req, res) => {
        const mine = req.actor.role === 'cashier';
        const from = validDate(req.query.from) ? req.query.from : addDays(todayNairobi(), -6), to = validDate(req.query.to) ? req.query.to : todayNairobi();
        const params = [req.shop.id, from, to]; if (mine) params.push(req.actor.staffId);
        const r = await q(`SELECT id, receipt_no, total_cents, method, mpesa_ref, status, cashier_name, created_at FROM pos_sales WHERE shop_id=$1 AND (created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3${mine ? ' AND staff_id=$4' : ''} ORDER BY created_at DESC LIMIT 500`, params);
        const sum = r.rows.filter(s => s.status === 'completed').reduce((a, s) => a + Number(s.total_cents), 0);
        send(req, res, { title: mine ? 'My Sales' : 'Sales History', nav: 'sales', body: `<h1>${mine ? 'My Sales' : 'Sales History'}</h1>${notice(req)}
        <div class="panel"><form method="GET" class="row"><div><label for="f">From</label><input id="f" type="date" name="from" value="${from}"></div><div><label for="t">To</label><input id="t" type="date" name="to" value="${to}"></div><button class="btn dark" type="submit">Show</button></form><p class="muted" style="margin:10px 0 0">${r.rows.length} sale${r.rows.length === 1 ? '' : 's'}, completed total <b>${kes(sum)}</b></p></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Receipt</th><th>When</th><th>Method</th>${mine ? '' : '<th>Cashier</th>'}<th class="num">Total</th><th>Status</th><th></th></tr>${r.rows.map(s => `<tr><td>#${s.receipt_no}</td><td class="nowrap">${esc(timeFmt(s.created_at))}</td><td>${s.method === 'mpesa' ? 'M-Pesa ' + esc(s.mpesa_ref || '') : 'Cash'}</td>${mine ? '' : `<td>${esc(s.cashier_name || '')}</td>`}<td class="num">${fmt(s.total_cents)}</td><td>${s.status === 'voided' ? '<span class="tag bad">voided</span>' : '<span class="tag ok">completed</span>'}</td><td class="right"><a class="btn small ghost" href="/pos/sales/${s.id}/receipt">Receipt</a></td></tr>`).join('')}</table>` : '<p class="muted">No sales in this period.</p>'}</div>` });
    }));
    const getSale = async (req, idParam) => {
        const id = parseCount(idParam, { min: 1 });
        if (!id) return null;
        const s = (await q('SELECT * FROM pos_sales WHERE id=$1 AND shop_id=$2 AND ($3::int IS NULL OR staff_id = $3)', [id, req.shop.id, req.actor.role === 'cashier' ? req.actor.staffId : null])).rows[0];
        if (!s) return null;
        s.lines = (await q('SELECT name, qty, unit_price_cents FROM pos_sale_items WHERE sale_id=$1 ORDER BY id', [s.id])).rows;
        return s;
    };
    router.get('/sales/:id/receipt', ah(async (req, res) => {
        const s = await getSale(req, req.params.id);
        if (!s) return send(req, res, { title: 'Not found', nav: 'sales', body: '<h1>Receipt not found</h1><a href="/pos/sales">Back to sales</a>' }, 404);
        const sh = req.shop, biz = req.biz, isBranch = sh.id !== biz.id, canVoid = req.actor.role !== 'cashier';
        const logo = biz.logo && LOGO_OK.test(biz.logo) ? `<img src="${biz.logo}" alt="" style="max-height:72px;max-width:230px;margin-bottom:6px"><br>` : '';
        const vat = Number(s.vat_cents), net = Number(s.total_cents) - vat, phone = sh.phone || biz.phone;
        const body = `<div class="noprint" style="margin-bottom:14px"><button class="btn" id="prt" type="button">Print / Save as PDF</button> <a class="btn ghost" href="/pos/sales">Back to sales</a> ${canVoid && s.status === 'completed' ? `<form action="/pos/sales/${s.id}/void" method="POST" style="display:inline"><input name="reason" placeholder="Reason for voiding" maxlength="200" required style="width:220px;display:inline-block"> <button class="btn bad small" type="submit">Void sale</button></form>` : ''}</div>
        <div class="panel" style="max-width:380px;margin:0 auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88rem">
            <div style="text-align:center">${logo}<b style="font-size:1.1rem">${esc(biz.name)}</b>${isBranch ? '<br><b>' + esc(sh.name) + '</b>' : ''}<br>${esc(sh.address)}${phone ? '<br>Tel ' + esc(phone) : ''}${biz.tax_pin ? '<br>PIN ' + esc(biz.tax_pin) : ''}</div>
            <hr><div>Receipt #${s.receipt_no}${s.status === 'voided' ? ' <b>(VOIDED)</b>' : ''}<br>${esc(timeFmt(s.created_at))}${s.cashier_name ? '<br>Served by: ' + esc(s.cashier_name) : ''}</div><hr>
            <table style="font-size:.88rem">${s.lines.map(l => `<tr><td style="border:0;padding:3px 0">${esc(l.name)}<br><span class="muted">${l.qty} x ${fmt(l.unit_price_cents)}</span></td><td class="num" style="border:0;padding:3px 0">${fmt(Number(l.unit_price_cents) * l.qty)}</td></tr>`).join('')}</table><hr>
            <div class="tot"><span>Subtotal</span><span>${fmt(s.subtotal_cents)}</span></div>${Number(s.discount_cents) ? `<div class="tot"><span>Discount</span><span>-${fmt(s.discount_cents)}</span></div>` : ''}
            <div class="tot big"><span>TOTAL</span><span>KES ${fmt(s.total_cents)}</span></div>
            ${vat > 0 ? `<div class="tot"><span>Amount excluding VAT</span><span>${fmt(net)}</span></div><div class="tot"><span>VAT ${VAT_RATE}% (included)</span><span>${fmt(vat)}</span></div>` : ''}
            <div class="tot"><span>Paid (${s.method === 'mpesa' ? 'M-Pesa' : 'Cash'})</span><span>${fmt(s.paid_cents)}</span></div>${s.method === 'mpesa' ? `<div class="tot"><span>M-Pesa code</span><span>${esc(s.mpesa_ref || '')}</span></div>` : ''}${Number(s.change_cents) ? `<div class="tot"><span>Change</span><span>${fmt(s.change_cents)}</span></div>` : ''}
            ${s.status === 'voided' ? `<hr><div>Voided: ${esc(s.void_reason || '')}</div>` : ''}<hr><div style="text-align:center">${esc(sh.receipt_footer)}</div>
            <div style="text-align:center;margin-top:8px;font-size:.75rem" class="muted">Powered by Tencent POS</div>
        </div>
        <script nonce="${req.nonce || ''}">document.getElementById('prt').addEventListener('click',function(){window.print();});</script>`;
        send(req, res, { title: 'Receipt #' + s.receipt_no, nav: 'sales', body });
    }));
    // Voiding a sale puts the stock back. Managers can only ASK: the owner approves.
    async function voidSale(shopId, id, reason) {
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const s = (await client.query(`UPDATE pos_sales SET status='voided', void_reason=$3, voided_at=now() WHERE id=$1 AND shop_id=$2 AND status='completed' RETURNING id, receipt_no`, [id, shopId, reason])).rows[0];
            if (s) {
                const lines = (await client.query(`SELECT si.item_id, si.qty FROM pos_sale_items si JOIN pos_items i ON i.id = si.item_id AND i.shop_id=$2 AND i.track_stock WHERE si.sale_id=$1 ORDER BY si.item_id`, [id, shopId])).rows;
                for (const l of lines) {
                    const nb = (await client.query('UPDATE pos_items SET stock = stock + $2 WHERE id=$1 AND shop_id=$3 RETURNING stock', [l.item_id, l.qty, shopId])).rows[0].stock;
                    await client.query(`INSERT INTO pos_stock_moves (shop_id, item_id, change, balance, reason, note, sale_id) VALUES ($1,$2,$3,$4,'void',$5,$6)`, [shopId, l.item_id, l.qty, nb, 'Voided receipt #' + s.receipt_no, id]);
                }
            }
            await client.query('COMMIT');
            return s || null;
        } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    }
    router.post('/sales/:id/void', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        const reason = str(req.body.reason).slice(0, 200) || 'No reason given';
        if (!id) return res.redirect('/pos/sales');
        const sale = (await q(`SELECT id, receipt_no, status FROM pos_sales WHERE id=$1 AND shop_id=$2`, [id, req.shop.id])).rows[0];
        if (!sale || sale.status !== 'completed') return res.redirect('/pos/sales');
        if (req.actor.role === 'owner') {
            await voidSale(req.shop.id, id, reason);
            await audit(req, 'sale.void', `receipt #${sale.receipt_no}: ${reason}`);
            return res.redirect(`/pos/sales/${id}/receipt`);
        }
        try {
            await q(`INSERT INTO pos_void_requests (shop_id, sale_id, reason, requested_by, staff_id) VALUES ($1,$2,$3,$4,$5)`, [req.shop.id, id, reason, req.actor.name || '', req.actor.staffId]);
            await audit(req, 'void.request', `receipt #${sale.receipt_no}: ${reason}`);
        } catch (e) { if (e.code !== '23505') throw e; }   // already waiting for the owner
        res.redirect(`/pos/sales/${id}/receipt?ok=` + encodeURIComponent('Sent to the owner for approval. The sale stays as it is until then.'));
    }));
    router.get('/voids', ah(async (req, res) => {
        const rows = (await q(`SELECT v.id, v.reason, v.requested_by, v.status, v.created_at, v.decided_by, s.receipt_no, s.total_cents, sh.name AS shop FROM pos_void_requests v JOIN pos_sales s ON s.id = v.sale_id JOIN pos_shops sh ON sh.id = v.shop_id WHERE sh.id=$1 OR sh.parent_id=$1 ORDER BY (v.status='pending') DESC, v.id DESC LIMIT 60`, [req.biz.id])).rows;
        send(req, res, { title: 'Void Requests', nav: 'voids', body: `<h1>Void Requests</h1>${notice(req)}<p class="muted">Managers cannot cancel a sale on their own: they ask here, and the stock goes back only after you approve.</p>
        <div class="panel tablewrap">${rows.length ? `<table><tr><th>When</th><th>Branch</th><th>Receipt</th><th class="num">Total</th><th>Asked by</th><th>Reason</th><th></th></tr>${rows.map(v => `<tr><td class="nowrap">${esc(timeFmt(v.created_at))}</td><td>${esc(v.shop)}</td><td>#${v.receipt_no}</td><td class="num">${fmt(v.total_cents)}</td><td>${esc(v.requested_by)}</td><td>${esc(v.reason)}</td><td class="right nowrap">${v.status === 'pending' ? `<form action="/pos/voids/${v.id}/approve" method="POST" style="display:inline"><button class="btn small ok">Approve</button></form> <form action="/pos/voids/${v.id}/reject" method="POST" style="display:inline"><button class="btn small ghost">Reject</button></form>` : `<span class="tag ${v.status === 'approved' ? 'ok' : 'gray'}">${esc(v.status)}</span>`}</td></tr>`).join('')}</table>` : '<p class="muted">No requests.</p>'}</div>` });
    }));
    const decideVoid = (name, status) => router.post('/voids/:id/' + name, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        const v = id && (await q(`UPDATE pos_void_requests SET status=$3, decided_at=now(), decided_by=$4 WHERE id=$1 AND status='pending' AND shop_id IN (SELECT id FROM pos_shops WHERE id=$2 OR parent_id=$2) RETURNING shop_id, sale_id, reason`, [id, req.biz.id, status, req.actor.name || 'Owner'])).rows[0];
        if (v && status === 'approved') await voidSale(v.shop_id, v.sale_id, v.reason + ' (approved by owner)');
        if (v) await audit(req, 'void.' + status, 'request #' + id);
        res.redirect('/pos/voids?ok=' + encodeURIComponent(v ? 'Done.' : 'That request was already handled.'));
    }));
    decideVoid('approve', 'approved'); decideVoid('reject', 'rejected');

    // ----- audit log page -----
    router.get('/audit', ah(async (req, res) => {
        const pageNo = Math.max(1, parseCount(req.query.page || '1', { min: 1, max: 100000 }) || 1), per = 100;
        const pre = str(req.query.action).replace(/[^a-z0-9._]/g, '').slice(0, 30);
        const rows = (await q(`SELECT created_at, actor_kind, actor_name, action, detail, ip, shop_id FROM pos_audit WHERE business_id=$1 AND ($2 = '' OR action LIKE $2 || '%') ORDER BY id DESC LIMIT $3 OFFSET $4`, [req.biz.id, pre, per + 1, (pageNo - 1) * per])).rows;
        send(req, res, { title: 'Audit Log', nav: 'audit', body: `<h1>Audit Log</h1><p class="muted">A permanent record of sensitive actions. Nobody, including you, can edit or delete it.</p>
        <div class="panel"><form method="GET" class="row"><div><label for="a">Show only</label><select id="a" name="action"><option value="">Everything</option>${['sale', 'void', 'staff', 'gateway', 'payment', '2fa', 'branch', 'settings', 'sub', 'stock'].map(x => `<option value="${x}" ${pre === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div><button class="btn dark" type="submit">Filter</button></form></div>
        <div class="panel tablewrap">${rows.length ? `<table><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>Network</th></tr>${rows.slice(0, per).map(r => `<tr><td class="nowrap">${esc(timeFmt(r.created_at))}</td><td>${esc(r.actor_name || r.actor_kind)}<br><small class="muted">${esc(r.actor_kind)}</small></td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td><td><small>${esc(r.ip)}</small></td></tr>`).join('')}</table>` : '<p class="muted">Nothing recorded yet.</p>'}
        <p>${pageNo > 1 ? `<a class="btn small ghost" href="/pos/audit?page=${pageNo - 1}&action=${esc(pre)}">Newer</a> ` : ''}${rows.length > per ? `<a class="btn small ghost" href="/pos/audit?page=${pageNo + 1}&action=${esc(pre)}">Older</a>` : ''}</p></div>` });
    }));

    // ----- two-step login: set-up page -----
    router.get('/security', ah(async (req, res) => {
        const uid = req.session.user.id, row = (await q('SELECT secret, enabled FROM pos_owner_security WHERE user_id=$1', [uid])).rows[0];
        let body;
        if (!vault.enabled) body = '<div class="alert" role="alert">Two-step login needs POS_CRED_KEY to be set on the server first.</div>';
        else if (row && row.enabled) body = `<div class="panel" style="max-width:620px"><h2>Two-step login is ON <span class="tag ok">protected</span></h2><p>Every time you open the POS you type a code from your authenticator app. Payment settings need a fresh code.</p>
            <form action="/pos/security/disable" method="POST" class="row"><div><label for="o">To turn it off, enter a current code</label><input id="o" name="otp" inputmode="numeric" required maxlength="20" autocomplete="one-time-code"></div><button class="btn bad" type="submit">Turn off</button></form></div>`;
        else {
            // no extra "start" click: opening this page prepares a fresh (not yet active) key
            let sec;
            if (row) sec = vault.open(row.secret, '2fa:' + uid).s;
            else { await q(`INSERT INTO pos_owner_security (user_id, secret, enabled) VALUES ($1,$2,FALSE) ON CONFLICT (user_id) DO NOTHING`, [uid, vault.seal({ s: SEC.newTotpSecret() }, '2fa:' + uid)]); sec = vault.open((await q('SELECT secret FROM pos_owner_security WHERE user_id=$1', [uid])).rows[0].secret, '2fa:' + uid).s; }
            const uri = SEC.otpauthUri(req.session.user.email || 'owner', sec);
            let qr = '';
            if (QRCode) { try { qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' }); } catch (_) { qr = ''; } }
            body = `<div class="panel" style="max-width:620px"><h2>Turn on 2-step login</h2><p style="margin-top:0">A stranger who learns your password still cannot get into your shop. Three quick steps:</p>
            <p><b>1.</b> Get a free authenticator app on your phone: <i>Google Authenticator</i> or <i>Microsoft Authenticator</i>.</p>
            <p><b>2.</b> ${qr ? 'In the app tap <b>+</b> then <b>Scan a QR code</b> and point it here:' : 'In the app tap <b>+</b> then <b>Enter a setup key</b>.'}</p>
            ${qr ? `<p style="text-align:center"><img src="${qr}" width="220" height="220" alt="QR code to scan with your authenticator app" style="background:#fff;padding:6px;border:1px solid var(--line);border-radius:8px"></p>` : ''}
            <p class="muted" style="margin:6px 0">${qr ? 'Cannot scan? Type this key instead' : 'Key'} (time based): <b style="letter-spacing:.08em;word-break:break-all;user-select:all">${esc(sec.match(/.{1,4}/g).join(' '))}</b><br>On this phone you can also <a href="${esc(uri)}">tap here to add it to the app</a>.</p>
            <form action="/pos/security/enable" method="POST"><div class="field"><label for="c"><b>3.</b> Type the 6-digit number the app shows</label><input id="c" name="otp" inputmode="numeric" required maxlength="8" autocomplete="one-time-code" autofocus style="font-size:1.5rem;letter-spacing:.3em;text-align:center;max-width:240px"><small>It turns on by itself after 6 digits.</small></div><button class="btn ok" type="submit">Turn on</button></form></div>
            <script nonce="${req.nonce || ''}">(function(){var i=document.getElementById('c');i.addEventListener('input',function(){if(/^\\d{6}$/.test(i.value.replace(/\\s/g,'')))i.form.submit();});})();</script>`;
        }
        send(req, res, { title: 'Security', nav: 'security', body: `<h1>Security</h1>${notice(req)}${errBox(req)}${body}` });
    }));
    router.post('/security/start', ah(async (req, res) => {
        if (!vault.enabled || req.has2fa) return back(res, '/pos/security', '', req.has2fa ? 'Already on.' : 'Two-step login needs POS_CRED_KEY to be set on the server.');
        const uid = req.session.user.id;
        await q(`INSERT INTO pos_owner_security (user_id, secret, enabled) VALUES ($1,$2,FALSE) ON CONFLICT (user_id) DO UPDATE SET secret=EXCLUDED.secret, enabled=FALSE, last_counter=0, recovery='[]'::jsonb`, [uid, vault.seal({ s: SEC.newTotpSecret() }, '2fa:' + uid)]);
        res.redirect('/pos/security');
    }));
    router.post('/security/enable', ah(async (req, res) => {
        const uid = req.session.user.id, kUser = '2fa:' + uid;
        if (await failLocked([kUser])) return back(res, '/pos/security', '', 'Too many wrong codes. Wait 15 minutes.');
        const row = (await q('SELECT secret, enabled FROM pos_owner_security WHERE user_id=$1', [uid])).rows[0];
        const counter = row && !row.enabled ? SEC.checkTotp(vault.open(row.secret, '2fa:' + uid).s, req.body.otp, 0) : null;
        if (!counter) { await failHit(kUser, 5, 900, 900); return back(res, '/pos/security', '', 'That code is not right. Check the phone clock is automatic and try the newest code.'); }
        const codes = SEC.newRecoveryCodes(8);
        await q('UPDATE pos_owner_security SET enabled=TRUE, last_counter=$2, recovery=$3::jsonb WHERE user_id=$1', [uid, counter, JSON.stringify(codes.map(SEC.hashRecovery))]);
        req.session.pos2faAt = Date.now(); req.session.posStepAt = Date.now();
        await saveSess(req);
        await audit(req, '2fa.enabled', '');
        send(req, res, { title: 'Security', nav: 'security', body: `<h1>Two-step login is on</h1><div class="panel" style="max-width:620px"><h2>Save your recovery codes</h2><p>If you lose your phone, each of these codes works once instead of the app code. <b>They are shown only now.</b> Write them down and keep them somewhere safe.</p><pre id="rc" style="font-size:1.1rem;line-height:1.8">${codes.map(esc).join('\n')}</pre><p class="row noprint"><button class="btn ghost" id="rc-copy" type="button">Copy</button><button class="btn ghost" id="rc-print" type="button">Print</button><a class="btn" href="/pos/security">I have saved them</a></p></div><script nonce="${req.nonce || ''}">(function(){document.getElementById('rc-print').addEventListener('click',function(){window.print();});document.getElementById('rc-copy').addEventListener('click',function(){var t=document.getElementById('rc').textContent,b=this;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='Copied';},function(){b.textContent='Select and copy by hand';});});})();</script>` });
    }));
    router.post('/security/disable', ah(async (req, res) => {
        const r = await verifyOwnerOtp(req, req.body.otp);
        if (!r.ok) return back(res, '/pos/security', '', r.locked ? 'Too many wrong codes. Wait 15 minutes.' : 'That code is not right.');
        await q('DELETE FROM pos_owner_security WHERE user_id=$1', [req.session.user.id]);
        await audit(req, '2fa.disabled', '');
        back(res, '/pos/security', 'Two-step login turned off.');
    }));

    // ----- daily report (Z-report) -----
    async function periodSummary(shopId, from, to) {
        const f = `(created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3`;
        const [s, v, p, e, top] = await Promise.all([
            q(`SELECT count(*)::int n, COALESCE(sum(subtotal_cents),0)::bigint gross, COALESCE(sum(discount_cents),0)::bigint disc, COALESCE(sum(total_cents),0)::bigint total, COALESCE(sum(vat_cents),0)::bigint vat,
                      COALESCE(sum(total_cents) FILTER (WHERE method='cash'),0)::bigint cash, COALESCE(sum(total_cents) FILTER (WHERE method='mpesa'),0)::bigint mpesa
               FROM pos_sales WHERE shop_id=$1 AND status='completed' AND ${f}`, [shopId, from, to]),
            q(`SELECT count(*)::int n, COALESCE(sum(total_cents),0)::bigint total FROM pos_sales WHERE shop_id=$1 AND status='voided' AND ${f}`, [shopId, from, to]),
            q(`SELECT COALESCE(sum((si.unit_price_cents - si.unit_cost_cents) * si.qty),0)::bigint profit, COALESCE(sum(si.qty),0)::int units FROM pos_sale_items si JOIN pos_sales s ON s.id = si.sale_id WHERE s.shop_id=$1 AND s.status='completed' AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3`, [shopId, from, to]),
            q(`SELECT COALESCE(sum(amount_cents),0)::bigint total FROM pos_expenses WHERE shop_id=$1 AND spent_on BETWEEN $2 AND $3`, [shopId, from, to]),
            q(`SELECT si.name, sum(si.qty)::int qty, sum(si.qty * si.unit_price_cents)::bigint revenue FROM pos_sale_items si JOIN pos_sales s ON s.id = si.sale_id WHERE s.shop_id=$1 AND s.status='completed' AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 GROUP BY si.name ORDER BY qty DESC, revenue DESC LIMIT 10`, [shopId, from, to])
        ]);
        const S = s.rows[0], P = p.rows[0], E = e.rows[0];
        // profit is measured after discounts and without VAT (the VAT inside the prices belongs to KRA, not to the shop)
        const gross = Number(P.profit) - Number(S.disc) - Number(S.vat);
        return { S, V: v.rows[0], units: P.units, gross, expenses: Number(E.total), net: gross - Number(E.total), top: top.rows };
    }
    router.get('/daily', ah(async (req, res) => {
        const day = validDate(req.query.date) ? req.query.date : todayNairobi();
        const r = await periodSummary(req.shop.id, day, day);
        const row = (k, v, strong) => `<tr><td>${strong ? '<b>' + k + '</b>' : k}</td><td class="num">${strong ? '<b>' + v + '</b>' : v}</td></tr>`;
        send(req, res, { title: 'Daily Sales', nav: 'daily', body: `<h1>Daily Sales (Z-Report)</h1>
        <div class="panel noprint"><form method="GET" class="row"><div><label for="d">Date</label><input id="d" type="date" name="date" value="${day}"></div><button class="btn dark" type="submit">Show</button><button class="btn" type="button" id="prt">Print</button></form></div>
        <div class="panel" style="max-width:560px"><h2>${esc(req.shop.name)}: ${esc(dateFmt(day + 'T12:00:00+03:00'))}</h2><table>
            ${row('Number of sales', r.S.n)}${row('Items sold', r.units)}${row('Sales before discounts', kes(r.S.gross))}${row('Discounts given', '-' + kes(r.S.disc))}${row('Total sales', kes(r.S.total), true)}${row('Sales excluding VAT', kes(Number(r.S.total) - Number(r.S.vat)))}${row('VAT collected (' + VAT_RATE + '%, included in prices)', kes(r.S.vat))}
            ${row('Cash sales (expected in the drawer)', kes(r.S.cash))}${row('M-Pesa sales', kes(r.S.mpesa))}${row('Voided sales (' + r.V.n + ')', kes(r.V.total))}
            ${row('Gross profit', kes(r.gross))}${row('Expenses', kes(r.expenses))}${row('Net profit', (r.net < 0 ? '-' : '') + kes(Math.abs(r.net)), true)}</table></div>
        <div class="panel" style="max-width:560px"><h2>Best sellers</h2>${r.top.length ? `<table><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr>${r.top.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num">${fmt(t.revenue)}</td></tr>`).join('')}</table>` : '<p class="muted">No sales on this day.</p>'}</div>
        <script nonce="${req.nonce || ''}">document.getElementById('prt').addEventListener('click',function(){window.print();});</script>` });
    }));

    // ----- expenses -----
    router.get('/expenses', ah(async (req, res) => {
        const from = validDate(req.query.from) ? req.query.from : todayNairobi().slice(0, 8) + '01', to = validDate(req.query.to) ? req.query.to : todayNairobi();
        const [rows, cats] = await Promise.all([
            q('SELECT id, category, amount_cents, note, spent_on FROM pos_expenses WHERE shop_id=$1 AND spent_on BETWEEN $2 AND $3 ORDER BY spent_on DESC, id DESC LIMIT 500', [req.shop.id, from, to]),
            q('SELECT DISTINCT category FROM pos_expenses WHERE shop_id=$1 ORDER BY category LIMIT 50', [req.shop.id])
        ]);
        const total = rows.rows.reduce((a, e) => a + Number(e.amount_cents), 0);
        const err = req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 160))}</div>` : '';
        send(req, res, { title: 'Expenses', nav: 'expenses', body: `<h1>Expenses</h1>${notice(req)}${err}
        <div class="panel"><h2>Add an expense</h2><form action="/pos/expenses" method="POST"><div class="grid2">
            <div class="field"><label for="c">Category</label><input id="c" name="category" list="cl" required maxlength="60" placeholder="e.g. Rent, Transport, Electricity"><datalist id="cl">${['Rent', 'Transport', 'Electricity', 'Wages', 'Licences', 'Packaging', 'Airtime', 'Other'].concat(cats.rows.map(c => c.category)).map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
            <div class="field"><label for="a">Amount (KES)</label><input id="a" name="amount" required inputmode="decimal"></div>
            <div class="field"><label for="d">Date</label><input id="d" type="date" name="date" value="${todayNairobi()}" required></div>
            <div class="field"><label for="n">Note (optional)</label><input id="n" name="note" maxlength="200"></div></div><button class="btn" type="submit">Save expense</button></form></div>
        <div class="panel"><form method="GET" class="row"><div><label for="f">From</label><input id="f" type="date" name="from" value="${from}"></div><div><label for="t">To</label><input id="t" type="date" name="to" value="${to}"></div><button class="btn dark" type="submit">Show</button></form><p class="muted" style="margin:10px 0 0">Total for this period: <b>${kes(total)}</b></p></div>
        <div class="panel tablewrap">${rows.rows.length ? `<table><tr><th>Date</th><th>Category</th><th>Note</th><th class="num">Amount</th><th></th></tr>${rows.rows.map(e => `<tr><td class="nowrap">${esc(dateFmt(String(e.spent_on instanceof Date ? e.spent_on.toISOString().slice(0, 10) : e.spent_on).slice(0, 10) + 'T12:00:00+03:00'))}</td><td>${esc(e.category)}</td><td>${esc(e.note)}</td><td class="num">${fmt(e.amount_cents)}</td><td class="right"><form action="/pos/expenses/${e.id}/delete" method="POST" style="display:inline"><button class="btn small ghost" type="submit">Delete</button></form></td></tr>`).join('')}</table>` : '<p class="muted">No expenses in this period.</p>'}</div>` });
    }));
    router.post('/expenses', ah(async (req, res) => {
        const category = str(req.body.category).slice(0, 60), amount = parseMoney(req.body.amount), date = req.body.date;
        if (!category || amount === null || amount <= 0 || !validDate(date)) return res.redirect('/pos/expenses?err=' + encodeURIComponent('Please enter a category, a valid amount and a date.'));
        await q('INSERT INTO pos_expenses (shop_id, category, amount_cents, note, spent_on) VALUES ($1,$2,$3,$4,$5)', [req.shop.id, category, amount, str(req.body.note).slice(0, 200), date]);
        res.redirect('/pos/expenses?ok=' + encodeURIComponent('Expense saved.'));
    }));
    router.post('/expenses/:id/delete', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_expenses WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        res.redirect('/pos/expenses?ok=' + encodeURIComponent('Expense deleted.'));
    }));

    // ----- reports -----
    router.get('/reports', ah(async (req, res) => {
        const today = todayNairobi();
        const from = validDate(req.query.from) ? req.query.from : today.slice(0, 8) + '01', to = validDate(req.query.to) ? req.query.to : today;
        const [r, days] = await Promise.all([
            periodSummary(req.shop.id, from, to),
            q(`SELECT (created_at AT TIME ZONE '${TZ}')::date AS d, count(*)::int n, sum(total_cents)::bigint total FROM pos_sales WHERE shop_id=$1 AND status='completed' AND (created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1 DESC LIMIT 366`, [req.shop.id, from, to])
        ]);
        const isoDay = d => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString() : String(d)).slice(0, 10);
        send(req, res, { title: 'Reports', nav: 'reports', body: `<h1>Reports</h1>
        <div class="panel"><form method="GET" class="row"><div><label for="f">From</label><input id="f" type="date" name="from" value="${from}"></div><div><label for="t">To</label><input id="t" type="date" name="to" value="${to}"></div><button class="btn dark" type="submit">Show</button><a class="btn ghost" href="/pos/reports.csv?from=${from}&to=${to}">Download CSV</a></form></div>
        <div class="cards"><div class="stat c1"><span>Total sales</span><b>${kes(r.S.total)}</b><span>${r.S.n} sales</span></div><div class="stat c3"><span>Gross profit</span><b>${kes(r.gross)}</b></div><div class="stat c4"><span>Expenses</span><b>${kes(r.expenses)}</b></div><div class="stat ${r.net >= 0 ? 'c2' : 'c9'}"><span>Net profit</span><b>${r.net < 0 ? '-' : ''}${kes(Math.abs(r.net))}</b></div><div class="stat c6"><span>VAT collected</span><b>${kes(r.S.vat)}</b></div><div class="stat c7"><span>Cash</span><b>${kes(r.S.cash)}</b></div><div class="stat c5"><span>M-Pesa</span><b>${kes(r.S.mpesa)}</b></div></div>
        <div class="grid2" style="align-items:start"><div class="panel"><h2>Best sellers</h2>${r.top.length ? `<table><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr>${r.top.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num">${fmt(t.revenue)}</td></tr>`).join('')}</table>` : '<p class="muted">No sales in this period.</p>'}</div>
        <div class="panel"><h2>Sales by day</h2>${days.rows.length ? `<div class="tablewrap"><table><tr><th>Day</th><th class="num">Sales</th><th class="num">Total</th></tr>${days.rows.map(d => `<tr><td>${esc(dateFmt(isoDay(d.d) + 'T12:00:00+03:00'))}</td><td class="num">${d.n}</td><td class="num">${fmt(d.total)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No sales in this period.</p>'}</div></div>` });
    }));
    router.get('/reports.csv', ah(async (req, res) => {
        const today = todayNairobi();
        const from = validDate(req.query.from) ? req.query.from : today.slice(0, 8) + '01', to = validDate(req.query.to) ? req.query.to : today;
        const r = await q(`SELECT s.receipt_no, s.created_at, s.method, s.mpesa_ref, s.subtotal_cents, s.discount_cents, s.total_cents, s.vat_cents, s.cashier_name, s.status, string_agg(si.name || ' x' || si.qty, '; ' ORDER BY si.id) AS items
            FROM pos_sales s LEFT JOIN pos_sale_items si ON si.sale_id = s.id WHERE s.shop_id=$1 AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 GROUP BY s.id ORDER BY s.created_at`, [req.shop.id, from, to]);
        const lines = [['Receipt', 'Date', 'Method', 'M-Pesa code', 'Subtotal', 'Discount', 'Total', 'VAT included', 'Cashier', 'Status', 'Items'].map(csvCell).join(',')];
        for (const s of r.rows) lines.push([s.receipt_no, timeFmt(s.created_at), s.method, s.mpesa_ref || '', (s.subtotal_cents / 100).toFixed(2), (s.discount_cents / 100).toFixed(2), (s.total_cents / 100).toFixed(2), (s.vat_cents / 100).toFixed(2), s.cashier_name || '', s.status, s.items || ''].map(csvCell).join(','));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sales-${from}-to-${to}.csv"`, 'Cache-Control': 'no-store' }).send('﻿' + lines.join('\r\n'));
    }));

    // ----- settings (owner only) -----
    router.get('/settings', ah(async (req, res) => {
        const s = req.shop, b = req.biz, isBranch = s.id !== b.id;
        const logo = b.logo && LOGO_OK.test(b.logo) ? b.logo : '';
        send(req, res, { title: 'Shop Settings', nav: 'settings', body: `<h1>Shop Settings</h1>${notice(req)}${errBox(req)}
        <div class="panel" style="max-width:620px"><h2>${isBranch ? 'This branch' : 'Your shop'}</h2>${isBranch ? '<p class="muted">You are editing the branch chosen at the top of the menu. The name and address print on this branch\'s receipts.</p>' : ''}<form action="/pos/settings" method="POST">
            <div class="field"><label for="n">${isBranch ? 'Branch name' : 'Business name (printed on receipts)'}</label><input id="n" name="name" required maxlength="120" value="${esc(s.name)}"></div>
            <div class="field"><label for="p">Phone</label><input id="p" name="phone" maxlength="40" value="${esc(s.phone)}"></div>
            <div class="field"><label for="a">Address</label><input id="a" name="address" maxlength="200" value="${esc(s.address)}"></div>
            <div class="field"><label for="f">Receipt footer message</label><input id="f" name="footer" maxlength="200" value="${esc(s.receipt_footer)}"></div>
            <button class="btn" type="submit">Save</button></form></div>
        <div class="panel" style="max-width:620px"><h2>Business-wide (all branches)</h2><form action="/pos/settings/business" method="POST">
            <div class="field"><label for="k">KRA PIN (printed on receipts)</label><input id="k" name="tax_pin" maxlength="40" value="${esc(b.tax_pin)}"></div>
            <div class="field"><label><input type="checkbox" name="vat" value="1" ${b.vat_enabled ? 'checked' : ''} style="width:auto"> My prices include ${VAT_RATE}% VAT (receipts show the VAT amount)</label><small>Switch this off only if the business is not registered for VAT.</small></div>
            <div class="field"><label for="md">Biggest discount cashiers and managers may give (%)</label><input id="md" name="max_discount_pct" type="number" min="0" max="100" value="${Number(b.max_discount_pct == null ? 10 : b.max_discount_pct)}" style="max-width:120px"><small>Above this, only you (the owner) can sell. Every discount is recorded in the Audit Log.</small></div>
            <div class="field"><label><input type="checkbox" name="manual_codes" value="1" ${b.allow_manual_codes === false ? '' : 'checked'} style="width:auto"> Allow cashiers to type an M-Pesa code from the customer's SMS</label><small>A typed code cannot be checked with Safaricom. Switch this off to accept M-Pesa only through the phone prompt, which is verified.</small></div>
            <button class="btn" type="submit">Save</button></form></div>
        <div class="panel" style="max-width:620px"><h2>Receipt logo</h2>
            <p>${logo ? `<img src="${logo}" alt="Your logo" style="max-height:90px;max-width:260px;background:#fff;border:1px solid var(--line);border-radius:6px;padding:4px">` : '<span class="muted">No logo yet.</span>'}</p>
            <div class="field"><label for="logo-file">Choose a logo (PNG or JPG)</label><input id="logo-file" type="file" accept="image/png,image/jpeg"><small>It is shrunk to fit automatically and printed at the top of every receipt.</small></div>
            <p><img id="logo-prev" alt="Preview" style="display:none;max-height:90px;max-width:260px;border:1px dashed var(--line);border-radius:6px;padding:4px"></p>
            <div id="logo-msg" class="muted" role="status"></div>
            <button class="btn" id="logo-save" type="button" disabled>Save logo</button>
            ${logo ? '<form action="/pos/settings/logo/remove" method="POST" style="display:inline"><button class="btn ghost" type="submit">Remove logo</button></form>' : ''}</div>
        <script nonce="${req.nonce || ''}">
        (function () {
            var f = document.getElementById('logo-file'), pv = document.getElementById('logo-prev'), msg = document.getElementById('logo-msg'), btn = document.getElementById('logo-save'), data = '';
            f.addEventListener('change', function () {
                var file = f.files[0]; if (!file) return; btn.disabled = true; data = '';
                if (file.type !== 'image/png' && file.type !== 'image/jpeg') { msg.textContent = 'Please choose a PNG or JPG picture.'; return; }
                var rd = new FileReader();
                rd.onerror = function () { msg.textContent = 'Could not read that picture.'; };
                rd.onload = function () {
                    var img = new Image();
                    img.onerror = function () { msg.textContent = 'Could not read that picture.'; };
                    img.onload = function () {
                        var s = Math.min(1, 256 / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s)), c = document.createElement('canvas');
                        function enc(type, quality) { c.width = w; c.height = h; var x = c.getContext('2d'); if (type === 'image/jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); } x.drawImage(img, 0, 0, w, h); return c.toDataURL(type, quality); }
                        var out = enc('image/png', 0.92), steps = [0.85, 0.7, 0.55], i = 0;
                        while (out.length > 38000 && i < 6) { if (i < 3) out = enc('image/jpeg', steps[i]); else { w = Math.round(w * 0.75); h = Math.round(h * 0.75); out = enc('image/jpeg', 0.7); } i++; }
                        if (out.length > 38000) { msg.textContent = 'That picture is too detailed. Try a simpler logo.'; return; }
                        data = out; pv.src = out; pv.style.display = ''; btn.disabled = false; msg.textContent = 'This is how it will look. Press Save logo.';
                    };
                    img.src = rd.result;
                };
                rd.readAsDataURL(file);
            });
            btn.addEventListener('click', function () {
                if (!data) return; btn.disabled = true; msg.textContent = 'Saving...';
                fetch('/pos/settings/logo', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: data }) })
                .then(function (r) { return r.json(); }).then(function (d) { if (d.ok) location.href = '/pos/settings?ok=' + encodeURIComponent('Logo saved.'); else { msg.textContent = d.error || 'Could not save the logo.'; btn.disabled = false; } })
                .catch(function () { msg.textContent = 'Connection problem. Try again.'; btn.disabled = false; });
            });
        })();
        </script>` });
    }));
    router.post('/settings', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120);
        if (name.length < 2) return res.redirect('/pos/settings?err=' + encodeURIComponent('Please enter a name.'));
        await q('UPDATE pos_shops SET name=$2, phone=$3, address=$4, receipt_footer=$5 WHERE id=$1', [req.shop.id, name, str(req.body.phone).slice(0, 40), str(req.body.address).slice(0, 200), str(req.body.footer).slice(0, 200)]);
        res.redirect('/pos/settings?ok=' + encodeURIComponent('Saved.'));
    }));
    router.post('/settings/business', ah(async (req, res) => {
        const md = Math.min(100, Math.max(0, parseInt(req.body.max_discount_pct, 10) || 0));
        await q('UPDATE pos_shops SET tax_pin=$2, vat_enabled=$3, max_discount_pct=$4, allow_manual_codes=$5 WHERE id=$1', [req.biz.id, str(req.body.tax_pin).slice(0, 40), req.body.vat === '1', md, req.body.manual_codes === '1']);
        await audit(req, 'settings.business', 'VAT ' + (req.body.vat === '1' ? 'on' : 'off') + ', KRA PIN updated, max discount ' + md + '%, typed M-Pesa codes ' + (req.body.manual_codes === '1' ? 'allowed' : 'off'));
        res.redirect('/pos/settings?ok=' + encodeURIComponent('Saved.'));
    }));
    router.post('/settings/logo', ah(async (req, res) => {
        const d = String((req.body && req.body.dataUrl) || '');
        if (d.length > 41000 || !LOGO_OK.test(d)) return res.status(400).json({ error: 'That picture could not be used. Choose a PNG or JPG.' });
        const bytes = Buffer.from(d.slice(d.indexOf(',') + 1), 'base64');
        const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, jpg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        if (bytes.length > 30000 || !(png || jpg) || (png && !d.startsWith('data:image/png')) || (jpg && !d.startsWith('data:image/jpeg'))) return res.status(400).json({ error: 'That picture could not be used. Choose a PNG or JPG that is not too large.' });
        await q('UPDATE pos_shops SET logo=$2 WHERE id=$1', [req.biz.id, d]);
        await audit(req, 'settings.logo', 'logo changed');
        res.json({ ok: true });
    }));
    router.post('/settings/logo/remove', ah(async (req, res) => {
        await q('UPDATE pos_shops SET logo=NULL WHERE id=$1', [req.biz.id]);
        res.redirect('/pos/settings?ok=' + encodeURIComponent('Logo removed.'));
    }));

    // ======================= EXTRA PAGES =======================
    const errBox = req => req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 160))}</div>` : '';
    const back = (res, path, ok, err) => res.redirect(path + '?' + (err ? 'err=' + encodeURIComponent(err) : 'ok=' + encodeURIComponent(ok)));
    const delBtn = action => `<form action="${action}" method="POST" style="display:inline"><button class="btn small ghost" type="submit">Delete</button></form>`;
    const itemOptions = items => '<option value="">-</option>' + items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
    // reads rows item_1/qty_1/price_1 .. item_10; blank price uses the item's own default
    async function readLines(req, priceField) {
        const ids = [];
        for (let n = 1; n <= 10; n++) { const id = parseCount(req.body['item_' + n], { min: 1 }); if (id) ids.push(id); }
        if (!ids.length) return { error: 'Add at least one item.' };
        const items = new Map((await q('SELECT id, name, price_cents, cost_cents FROM pos_items WHERE shop_id=$1 AND id = ANY($2::int[])', [req.shop.id, ids])).rows.map(i => [i.id, i]));
        const lines = [];
        for (let n = 1; n <= 10; n++) {
            const id = parseCount(req.body['item_' + n], { min: 1 });
            if (!id) continue;
            const it = items.get(id), qty = parseCount(req.body['qty_' + n], { min: 1, max: 1000000 });
            if (!it) return { error: 'One of the items was not found.' };
            if (!qty) return { error: `Enter a whole-number quantity for ${it.name}.` };
            const raw = str(req.body['price_' + n]);
            const price = raw === '' ? Number(it[priceField]) : parseMoney(raw);
            if (price === null) return { error: `The price for ${it.name} is not a number.` };
            lines.push({ item_id: id, name: it.name, qty, cents: price });
        }
        return { lines };
    }
    const lineRows = (items, label) => Array.from({ length: 6 }, (_, k) => `<tr><td><select name="item_${k + 1}" aria-label="Item ${k + 1}">${itemOptions(items)}</select></td><td><input name="qty_${k + 1}" inputmode="numeric" aria-label="Quantity" style="width:80px" placeholder="Qty"></td><td><input name="price_${k + 1}" inputmode="decimal" aria-label="${label}" style="width:110px" placeholder="default"></td></tr>`).join('');
    const activeItems = async req => (await q('SELECT id, name FROM pos_items WHERE shop_id=$1 AND active ORDER BY name LIMIT 2000', [req.shop.id])).rows;

    // ----- suppliers -----
    router.get('/suppliers', ah(async (req, res) => {
        const r = await q('SELECT * FROM pos_suppliers WHERE shop_id=$1 ORDER BY name', [req.shop.id]);
        send(req, res, { title: 'Suppliers', nav: 'suppliers', body: `<h1>Suppliers</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/suppliers" method="POST"><div class="grid2">
            <div class="field"><label for="n">Supplier name</label><input id="n" name="name" required maxlength="120"></div>
            <div class="field"><label for="p">Phone</label><input id="p" name="phone" maxlength="40"></div>
            <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" maxlength="160"></div>
            <div class="field"><label for="a">Address</label><input id="a" name="address" maxlength="200"></div></div><button class="btn" type="submit">Add supplier</button></form></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Name</th><th>Phone</th><th>Email</th><th>Address</th><th></th></tr>${r.rows.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.phone)}</td><td>${esc(s.email)}</td><td>${esc(s.address)}</td><td class="right">${delBtn('/pos/suppliers/' + s.id + '/delete')}</td></tr>`).join('')}</table>` : '<p class="muted">No suppliers yet.</p>'}</div>` });
    }));
    router.post('/suppliers', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120);
        if (!name) return back(res, '/pos/suppliers', '', 'Please enter the supplier name.');
        await q('INSERT INTO pos_suppliers (shop_id, name, phone, email, address) VALUES ($1,$2,$3,$4,$5)', [req.shop.id, name, str(req.body.phone).slice(0, 40), str(req.body.email).slice(0, 160), str(req.body.address).slice(0, 200)]);
        back(res, '/pos/suppliers', 'Supplier added.');
    }));
    router.post('/suppliers/:id/delete', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_suppliers WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/suppliers', 'Supplier deleted.');
    }));

    // ----- purchase orders -----
    router.get('/purchase-orders', ah(async (req, res) => {
        const r = await q(`SELECT p.id, p.po_no, p.status, p.created_at, s.name AS supplier, COALESCE(sum(l.qty * l.cost_cents),0)::bigint total FROM pos_purchase_orders p LEFT JOIN pos_suppliers s ON s.id=p.supplier_id LEFT JOIN pos_po_lines l ON l.po_id=p.id WHERE p.shop_id=$1 GROUP BY p.id, s.name ORDER BY p.created_at DESC LIMIT 200`, [req.shop.id]);
        const tag = { open: 'warn', received: 'ok', cancelled: 'gray' };
        send(req, res, { title: 'Purchase Orders', nav: 'po', body: `<h1>Purchase Orders</h1>${notice(req)}${errBox(req)}<p><a class="btn" href="/pos/purchase-orders/new">New purchase order</a></p>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>PO</th><th>Date</th><th>Supplier</th><th class="num">Total</th><th>Status</th><th></th></tr>${r.rows.map(p => `<tr><td>#${p.po_no}</td><td>${esc(dateFmt(p.created_at))}</td><td>${esc(p.supplier || '-')}</td><td class="num">${fmt(p.total)}</td><td><span class="tag ${tag[p.status]}">${esc(p.status)}</span></td><td class="right"><a class="btn small ghost" href="/pos/purchase-orders/${p.id}">Open</a></td></tr>`).join('')}</table>` : '<p class="muted">No purchase orders yet.</p>'}</div>` });
    }));
    router.get('/purchase-orders/new', ah(async (req, res) => {
        const [items, sup] = await Promise.all([activeItems(req), q('SELECT id, name FROM pos_suppliers WHERE shop_id=$1 ORDER BY name', [req.shop.id])]);
        send(req, res, { title: 'New purchase order', nav: 'po', body: `<h1>New purchase order</h1>${errBox(req)}<div class="panel"><form action="/pos/purchase-orders/new" method="POST">
            <div class="field" style="max-width:380px"><label for="s">Supplier</label><select id="s" name="supplier_id"><option value="">No supplier</option>${sup.rows.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
            <div class="tablewrap"><table><tr><th>Item</th><th>Qty</th><th>Unit cost (KES)</th></tr>${lineRows(items, 'Unit cost')}</table></div>
            <div class="field" style="margin-top:12px"><label for="n">Note</label><input id="n" name="note" maxlength="200"></div>
            <button class="btn" type="submit">Save order</button> <a class="btn ghost" href="/pos/purchase-orders">Cancel</a></form></div>` });
    }));
    router.post('/purchase-orders/new', ah(async (req, res) => {
        const { lines, error } = await readLines(req, 'cost_cents');
        if (error) return back(res, '/pos/purchase-orders/new', '', error);
        let supplier = parseCount(req.body.supplier_id, { min: 1 });
        if (supplier && !(await q('SELECT 1 FROM pos_suppliers WHERE id=$1 AND shop_id=$2', [supplier, req.shop.id])).rowCount) supplier = null;
        const client = await pool().connect();
        let id;
        try {
            await client.query('BEGIN');
            const no = (await client.query('UPDATE pos_shops SET next_po = next_po + 1 WHERE id=$1 RETURNING next_po - 1 AS no', [req.shop.id])).rows[0].no;
            id = (await client.query('INSERT INTO pos_purchase_orders (shop_id, supplier_id, po_no, note) VALUES ($1,$2,$3,$4) RETURNING id', [req.shop.id, supplier, no, str(req.body.note).slice(0, 200)])).rows[0].id;
            for (const l of lines) await client.query('INSERT INTO pos_po_lines (po_id, item_id, qty, cost_cents) VALUES ($1,$2,$3,$4)', [id, l.item_id, l.qty, l.cents]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
        res.redirect('/pos/purchase-orders/' + id);
    }));
    router.get('/purchase-orders/:id', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        const p = id && (await q(`SELECT p.*, s.name AS supplier FROM pos_purchase_orders p LEFT JOIN pos_suppliers s ON s.id=p.supplier_id WHERE p.id=$1 AND p.shop_id=$2`, [id, req.shop.id])).rows[0];
        if (!p) return send(req, res, { title: 'Not found', nav: 'po', body: '<h1>Purchase order not found</h1><a href="/pos/purchase-orders">Back</a>' }, 404);
        const lines = (await q('SELECT l.qty, l.cost_cents, i.name FROM pos_po_lines l JOIN pos_items i ON i.id=l.item_id WHERE l.po_id=$1 ORDER BY l.id', [id])).rows;
        const total = lines.reduce((a, l) => a + l.qty * Number(l.cost_cents), 0);
        send(req, res, { title: 'Purchase order #' + p.po_no, nav: 'po', body: `<h1>Purchase order #${p.po_no}</h1>${notice(req)}${errBox(req)}
        <div class="panel noprint"><span class="tag ${p.status === 'open' ? 'warn' : p.status === 'received' ? 'ok' : 'gray'}">${esc(p.status)}</span>
            ${p.status === 'open' ? `<form action="/pos/purchase-orders/${id}/receive" method="POST" style="display:inline;margin-left:10px"><button class="btn ok small" type="submit">Mark received (adds the stock)</button></form> <form action="/pos/purchase-orders/${id}/cancel" method="POST" style="display:inline"><button class="btn ghost small" type="submit">Cancel order</button></form>` : ''}
            <button class="btn small" id="prt" type="button" style="margin-left:10px">Print</button> <a class="btn small ghost" href="/pos/purchase-orders">Back</a></div>
        <div class="panel"><p><b>${esc(req.shop.name)}</b><br>Supplier: ${esc(p.supplier || '-')}<br>Date: ${esc(dateFmt(p.created_at))}${p.note ? '<br>Note: ' + esc(p.note) : ''}</p>
        <table><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Line total</th></tr>${lines.map(l => `<tr><td>${esc(l.name)}</td><td class="num">${l.qty}</td><td class="num">${fmt(l.cost_cents)}</td><td class="num">${fmt(l.qty * Number(l.cost_cents))}</td></tr>`).join('')}<tr><td colspan="3"><b>Total</b></td><td class="num"><b>${fmt(total)}</b></td></tr></table></div>
        <script nonce="${req.nonce || ''}">document.getElementById('prt').addEventListener('click',function(){window.print();});</script>` });
    }));
    router.post('/purchase-orders/:id/receive', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (!id) return res.redirect('/pos/purchase-orders');
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const p = (await client.query(`UPDATE pos_purchase_orders SET status='received', received_at=now() WHERE id=$1 AND shop_id=$2 AND status='open' RETURNING po_no`, [id, req.shop.id])).rows[0];
            if (p) {
                const lines = (await client.query('SELECT item_id, qty, cost_cents FROM pos_po_lines WHERE po_id=$1 ORDER BY item_id', [id])).rows;
                for (const l of lines) {
                    const it = (await client.query('UPDATE pos_items SET stock = CASE WHEN track_stock THEN stock + $2 ELSE stock END, cost_cents=$4 WHERE id=$1 AND shop_id=$3 RETURNING stock, track_stock', [l.item_id, l.qty, req.shop.id, l.cost_cents])).rows[0];
                    if (it && it.track_stock) await client.query(`INSERT INTO pos_stock_moves (shop_id, item_id, change, balance, reason, note) VALUES ($1,$2,$3,$4,'stock_in',$5)`, [req.shop.id, l.item_id, l.qty, it.stock, 'Purchase order #' + p.po_no]);
                }
            }
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
        back(res, '/pos/purchase-orders/' + id, 'Order received and stock updated.');
    }));
    router.post('/purchase-orders/:id/cancel', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q(`UPDATE pos_purchase_orders SET status='cancelled' WHERE id=$1 AND shop_id=$2 AND status='open'`, [id, req.shop.id]);
        res.redirect('/pos/purchase-orders/' + (id || ''));
    }));

    // ----- quotes -----
    router.get('/quotes', ah(async (req, res) => {
        const r = await q(`SELECT c.id, c.quote_no, c.customer_name, c.status, c.created_at, COALESCE(sum(l.qty * l.unit_price_cents),0)::bigint total FROM pos_quotes c LEFT JOIN pos_quote_lines l ON l.quote_id=c.id WHERE c.shop_id=$1 GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`, [req.shop.id]);
        send(req, res, { title: 'Quotes', nav: 'quotes', body: `<h1>Quotes</h1>${notice(req)}<p><a class="btn" href="/pos/quotes/new">New quote</a></p>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Quote</th><th>Date</th><th>Customer</th><th class="num">Total</th><th>Status</th><th></th></tr>${r.rows.map(c => `<tr><td>#${c.quote_no}</td><td>${esc(dateFmt(c.created_at))}</td><td>${esc(c.customer_name || '-')}</td><td class="num">${fmt(c.total)}</td><td><span class="tag ${c.status === 'accepted' ? 'ok' : c.status === 'open' ? 'warn' : 'gray'}">${esc(c.status)}</span></td><td class="right"><a class="btn small ghost" href="/pos/quotes/${c.id}">Open</a></td></tr>`).join('')}</table>` : '<p class="muted">No quotes yet.</p>'}</div>` });
    }));
    router.get('/quotes/new', ah(async (req, res) => {
        const items = await activeItems(req);
        send(req, res, { title: 'New quote', nav: 'quotes', body: `<h1>New quote</h1>${errBox(req)}<div class="panel"><form action="/pos/quotes/new" method="POST"><div class="grid2">
            <div class="field"><label for="c">Customer name</label><input id="c" name="customer_name" maxlength="120"></div>
            <div class="field"><label for="p">Customer phone</label><input id="p" name="customer_phone" maxlength="40"></div>
            <div class="field"><label for="v">Valid until</label><input id="v" type="date" name="valid_until" value="${addDays(todayNairobi(), 14)}"></div></div>
            <div class="tablewrap"><table><tr><th>Item</th><th>Qty</th><th>Unit price (KES)</th></tr>${lineRows(items, 'Unit price')}</table></div>
            <div class="field" style="margin-top:12px"><label for="n">Note</label><input id="n" name="note" maxlength="200"></div>
            <button class="btn" type="submit">Save quote</button> <a class="btn ghost" href="/pos/quotes">Cancel</a></form></div>` });
    }));
    router.post('/quotes/new', ah(async (req, res) => {
        const { lines, error } = await readLines(req, 'price_cents');
        if (error) return back(res, '/pos/quotes/new', '', error);
        const valid = validDate(req.body.valid_until) ? req.body.valid_until : null;
        const client = await pool().connect();
        let id;
        try {
            await client.query('BEGIN');
            const no = (await client.query('UPDATE pos_shops SET next_quote = next_quote + 1 WHERE id=$1 RETURNING next_quote - 1 AS no', [req.shop.id])).rows[0].no;
            id = (await client.query('INSERT INTO pos_quotes (shop_id, quote_no, customer_name, customer_phone, valid_until, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [req.shop.id, no, str(req.body.customer_name).slice(0, 120), str(req.body.customer_phone).slice(0, 40), valid, str(req.body.note).slice(0, 200)])).rows[0].id;
            for (const l of lines) await client.query('INSERT INTO pos_quote_lines (quote_id, name, qty, unit_price_cents) VALUES ($1,$2,$3,$4)', [id, l.name, l.qty, l.cents]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
        res.redirect('/pos/quotes/' + id);
    }));
    router.get('/quotes/:id', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        const c = id && (await q('SELECT * FROM pos_quotes WHERE id=$1 AND shop_id=$2', [id, req.shop.id])).rows[0];
        if (!c) return send(req, res, { title: 'Not found', nav: 'quotes', body: '<h1>Quote not found</h1><a href="/pos/quotes">Back</a>' }, 404);
        const lines = (await q('SELECT name, qty, unit_price_cents FROM pos_quote_lines WHERE quote_id=$1 ORDER BY id', [id])).rows;
        const total = lines.reduce((a, l) => a + l.qty * Number(l.unit_price_cents), 0), sh = req.shop;
        send(req, res, { title: 'Quote #' + c.quote_no, nav: 'quotes', body: `<div class="noprint" style="margin-bottom:14px"><button class="btn" id="prt" type="button">Print / Save as PDF</button> <a class="btn ghost" href="/pos/quotes">Back</a>
            ${c.status === 'open' ? `<form action="/pos/quotes/${id}/status" method="POST" style="display:inline"><button class="btn ok small" name="status" value="accepted">Mark accepted</button> <button class="btn ghost small" name="status" value="cancelled">Cancel quote</button></form>` : ''}</div>${notice(req)}
        <div class="panel" style="max-width:720px"><h1 style="margin-bottom:4px">Quotation #${c.quote_no}</h1><p>${req.biz.logo && LOGO_OK.test(req.biz.logo) ? `<img src="${req.biz.logo}" alt="" style="max-height:64px;max-width:200px"><br>` : ''}<b>${esc(req.biz.name)}</b>${sh.id !== req.biz.id ? '<br>' + esc(sh.name) : ''}<br>${esc(sh.address)}${sh.phone ? '<br>Tel ' + esc(sh.phone) : ''}${req.biz.tax_pin ? '<br>PIN ' + esc(req.biz.tax_pin) : ''}</p>
        <p>Date: ${esc(dateFmt(c.created_at))}${c.valid_until ? '<br>Valid until: ' + esc(dateFmt(isoDate(c.valid_until) + 'T12:00:00+03:00')) : ''}<br>Customer: ${esc(c.customer_name || '-')} ${esc(c.customer_phone)}<br>Status: ${esc(c.status)}</p>
        <table><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr>${lines.map(l => `<tr><td>${esc(l.name)}</td><td class="num">${l.qty}</td><td class="num">${fmt(l.unit_price_cents)}</td><td class="num">${fmt(l.qty * Number(l.unit_price_cents))}</td></tr>`).join('')}<tr><td colspan="3"><b>Total (KES)</b></td><td class="num"><b>${fmt(total)}</b></td></tr></table>${req.biz.vat_enabled ? '<p class="muted">All prices include VAT at ' + VAT_RATE + '%.</p>' : ''}${c.note ? '<p>' + esc(c.note) + '</p>' : ''}</div>
        <script nonce="${req.nonce || ''}">document.getElementById('prt').addEventListener('click',function(){window.print();});</script>` });
    }));
    router.post('/quotes/:id/status', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 }), st = ['accepted', 'cancelled'].includes(req.body.status) ? req.body.status : '';
        if (id && st) await q(`UPDATE pos_quotes SET status=$3 WHERE id=$1 AND shop_id=$2 AND status='open'`, [id, req.shop.id, st]);
        res.redirect('/pos/quotes/' + (id || ''));
    }));

    // ----- cash drawer -----
    router.get('/drawer', ah(async (req, res) => {
        const sid = req.shop.id;
        const cur = (await q('SELECT * FROM pos_drawer WHERE shop_id=$1 AND closed_at IS NULL', [sid])).rows[0];
        const past = (await q('SELECT * FROM pos_drawer WHERE shop_id=$1 AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 15', [sid])).rows;
        let panel;
        if (cur) {
            const [cash, mv] = await Promise.all([
                q(`SELECT COALESCE(sum(total_cents),0)::bigint t FROM pos_sales WHERE shop_id=$1 AND status='completed' AND method='cash' AND created_at >= $2`, [sid, cur.opened_at]),
                q('SELECT * FROM pos_drawer_moves WHERE drawer_id=$1 ORDER BY id', [cur.id])
            ]);
            const inn = mv.rows.filter(m => m.kind === 'in').reduce((a, m) => a + Number(m.amount_cents), 0), out = mv.rows.filter(m => m.kind === 'out').reduce((a, m) => a + Number(m.amount_cents), 0);
            const expected = Number(cur.opening_cents) + Number(cash.rows[0].t) + inn - out;
            panel = `<div class="panel"><h2>Drawer is open</h2><p class="muted">Opened ${esc(timeFmt(cur.opened_at))}</p><table>
                <tr><td>Opening float</td><td class="num">${fmt(cur.opening_cents)}</td></tr><tr><td>Cash sales since opening</td><td class="num">${fmt(cash.rows[0].t)}</td></tr>
                <tr><td>Cash added</td><td class="num">${fmt(inn)}</td></tr><tr><td>Cash taken out</td><td class="num">-${fmt(out)}</td></tr><tr><td><b>Expected in drawer</b></td><td class="num"><b>${fmt(expected)}</b></td></tr></table></div>
            <div class="grid2" style="align-items:start"><div class="panel"><h2>Cash in / out</h2><form action="/pos/drawer/move" method="POST"><div class="field"><label for="k">Type</label><select id="k" name="kind"><option value="in">Cash added to drawer</option><option value="out">Cash taken out (e.g. paid a supplier)</option></select></div><div class="field"><label for="a">Amount (KES)</label><input id="a" name="amount" required inputmode="decimal"></div><div class="field"><label for="n">Note</label><input id="n" name="note" maxlength="200"></div><button class="btn" type="submit">Save</button></form>
                ${mv.rows.length ? `<table style="margin-top:12px">${mv.rows.map(m => `<tr><td>${m.kind === 'in' ? 'In' : 'Out'}: ${esc(m.note)}</td><td class="num">${fmt(m.amount_cents)}</td></tr>`).join('')}</table>` : ''}</div>
            <div class="panel"><h2>Close drawer</h2><form action="/pos/drawer/close" method="POST"><div class="field"><label for="c">Cash counted (KES)</label><input id="c" name="counted" required inputmode="decimal"></div><div class="field"><label for="cn">Note</label><input id="cn" name="note" maxlength="200"></div><button class="btn bad" type="submit">Close drawer</button></form></div></div>`;
        } else {
            panel = `<div class="panel" style="max-width:480px"><h2>Open the drawer</h2><form action="/pos/drawer/open" method="POST"><div class="field"><label for="f">Opening cash float (KES)</label><input id="f" name="opening" required inputmode="decimal" value="0"></div><button class="btn ok" type="submit">Open drawer</button></form></div>`;
        }
        send(req, res, { title: 'Cash Drawer', nav: 'drawer', body: `<h1>Cash Drawer</h1>${notice(req)}${errBox(req)}${panel}
        <div class="panel tablewrap"><h2>Past sessions</h2>${past.length ? `<table><tr><th>Closed</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Difference</th></tr>${past.map(d => { const diff = Number(d.counted_cents) - Number(d.expected_cents); return `<tr><td>${esc(timeFmt(d.closed_at))}</td><td class="num">${fmt(d.expected_cents)}</td><td class="num">${fmt(d.counted_cents)}</td><td class="num"><span class="tag ${diff === 0 ? 'ok' : 'bad'}">${diff > 0 ? '+' : diff < 0 ? '-' : ''}${fmt(Math.abs(diff))}</span></td></tr>`; }).join('')}</table>` : '<p class="muted">No closed sessions yet.</p>'}</div>` });
    }));
    router.post('/drawer/open', ah(async (req, res) => {
        const amt = parseMoney(req.body.opening);
        if (amt === null) return back(res, '/pos/drawer', '', 'Enter the opening amount as a number.');
        const r = await q('INSERT INTO pos_drawer (shop_id, opening_cents) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.shop.id, amt]);
        back(res, '/pos/drawer', r.rowCount ? 'Drawer opened.' : 'The drawer is already open.');
    }));
    router.post('/drawer/move', ah(async (req, res) => {
        const amt = parseMoney(req.body.amount), kind = req.body.kind === 'out' ? 'out' : 'in';
        if (amt === null || amt <= 0) return back(res, '/pos/drawer', '', 'Enter an amount.');
        await q(`INSERT INTO pos_drawer_moves (shop_id, drawer_id, kind, amount_cents, note) SELECT $1, id, $2, $3, $4 FROM pos_drawer WHERE shop_id=$1 AND closed_at IS NULL`, [req.shop.id, kind, amt, str(req.body.note).slice(0, 200)]);
        back(res, '/pos/drawer', 'Saved.');
    }));
    router.post('/drawer/close', ah(async (req, res) => {
        const counted = parseMoney(req.body.counted), sid = req.shop.id;
        if (counted === null) return back(res, '/pos/drawer', '', 'Enter the counted cash as a number.');
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const cur = (await client.query('SELECT * FROM pos_drawer WHERE shop_id=$1 AND closed_at IS NULL FOR UPDATE', [sid])).rows[0];
            if (cur) {
                const cash = (await client.query(`SELECT COALESCE(sum(total_cents),0)::bigint t FROM pos_sales WHERE shop_id=$1 AND status='completed' AND method='cash' AND created_at >= $2`, [sid, cur.opened_at])).rows[0].t;
                const mv = (await client.query(`SELECT COALESCE(sum(CASE WHEN kind='in' THEN amount_cents ELSE -amount_cents END),0)::bigint t FROM pos_drawer_moves WHERE drawer_id=$1`, [cur.id])).rows[0].t;
                await client.query('UPDATE pos_drawer SET closed_at=now(), counted_cents=$2, expected_cents=$3, note=$4 WHERE id=$1', [cur.id, counted, Number(cur.opening_cents) + Number(cash) + Number(mv), str(req.body.note).slice(0, 200)]);
            }
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
        back(res, '/pos/drawer', 'Drawer closed.');
    }));

    // ----- expense categories, recurring, budgets -----
    router.get('/expense-categories', ah(async (req, res) => {
        const r = await q('SELECT id, name FROM pos_expense_cats WHERE shop_id=$1 ORDER BY name', [req.shop.id]);
        send(req, res, { title: 'Expense Categories', nav: 'ecats', body: `<h1>Expense Categories</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/expense-categories" method="POST" class="row"><div><label for="c">New category</label><input id="c" name="name" required maxlength="60"></div><button class="btn" type="submit">Add</button></form></div>
        <div class="panel">${r.rows.length ? `<table>${r.rows.map(c => `<tr><td>${esc(c.name)}</td><td class="right">${delBtn('/pos/expense-categories/' + c.id + '/delete')}</td></tr>`).join('')}</table>` : '<p class="muted">No custom categories yet. Common ones (Rent, Transport, Electricity...) are always offered.</p>'}</div>` });
    }));
    router.post('/expense-categories', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 60);
        if (name) await q('INSERT INTO pos_expense_cats (shop_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.shop.id, name]);
        back(res, '/pos/expense-categories', 'Category added.');
    }));
    router.post('/expense-categories/:id/delete', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_expense_cats WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/expense-categories', 'Category deleted.');
    }));
    const catList = async shopId => {
        const r = await q('SELECT name FROM pos_expense_cats WHERE shop_id=$1 UNION SELECT category FROM pos_expenses WHERE shop_id=$1 ORDER BY 1 LIMIT 100', [shopId]);
        return [...new Set(['Rent', 'Transport', 'Electricity', 'Wages', 'Licences', 'Packaging', 'Airtime', 'Other'].concat(r.rows.map(x => x.name)))];
    };
    router.get('/recurring', ah(async (req, res) => {
        const [r, cats] = await Promise.all([q('SELECT * FROM pos_recurring WHERE shop_id=$1 ORDER BY day_of_month, id', [req.shop.id]), catList(req.shop.id)]);
        send(req, res, { title: 'Recurring Expenses', nav: 'recurring', body: `<h1>Recurring Expenses</h1>${notice(req)}${errBox(req)}
        <p class="muted">These are added to your expenses automatically every month, on the day you choose.</p>
        <div class="panel"><form action="/pos/recurring" method="POST"><div class="grid2">
            <div class="field"><label for="c">Category</label><input id="c" name="category" list="cl" required maxlength="60"><datalist id="cl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
            <div class="field"><label for="a">Amount (KES)</label><input id="a" name="amount" required inputmode="decimal"></div>
            <div class="field"><label for="d">Day of month (1 to 28)</label><input id="d" name="day" required inputmode="numeric" value="1"></div>
            <div class="field"><label for="n">Note</label><input id="n" name="note" maxlength="200"></div></div><button class="btn" type="submit">Add</button></form></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Category</th><th>Day</th><th class="num">Amount</th><th>Note</th><th></th></tr>${r.rows.map(x => `<tr><td>${esc(x.category)}</td><td>${x.day_of_month}</td><td class="num">${fmt(x.amount_cents)}</td><td>${esc(x.note)}</td><td class="right">${delBtn('/pos/recurring/' + x.id + '/delete')}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}</div>` });
    }));
    router.post('/recurring', ah(async (req, res) => {
        const cat = str(req.body.category).slice(0, 60), amt = parseMoney(req.body.amount), day = parseCount(req.body.day, { min: 1, max: 28 });
        if (!cat || amt === null || amt <= 0 || !day) return back(res, '/pos/recurring', '', 'Enter a category, an amount and a day from 1 to 28.');
        await q('INSERT INTO pos_recurring (shop_id, category, amount_cents, note, day_of_month) VALUES ($1,$2,$3,$4,$5)', [req.shop.id, cat, amt, str(req.body.note).slice(0, 200), day]);
        await runRecurring(req.shop.id);
        back(res, '/pos/recurring', 'Saved.');
    }));
    router.post('/recurring/:id/delete', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_recurring WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/recurring', 'Deleted.');
    }));
    // adds this month's expense once the day has arrived; the UPDATE ... RETURNING makes sure it only happens once
    async function runRecurring(shopId) {
        const today = todayNairobi(), ym = today.slice(0, 7);
        const r = await q(`UPDATE pos_recurring SET last_run = make_date($2::int, $3::int, day_of_month) WHERE shop_id=$1 AND day_of_month <= $4 AND (last_run IS NULL OR to_char(last_run,'YYYY-MM') < $5) RETURNING category, amount_cents, note, last_run`,
            [shopId, Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), Number(today.slice(8, 10)), ym]);
        for (const x of r.rows) await q('INSERT INTO pos_expenses (shop_id, category, amount_cents, note, spent_on) VALUES ($1,$2,$3,$4,$5)', [shopId, x.category, x.amount_cents, (x.note ? x.note + ' ' : '') + '(recurring)', x.last_run]);
    }
    router.get('/budgets', ah(async (req, res) => {
        const today = todayNairobi(), ms = today.slice(0, 8) + '01';
        const [b, spent, cats] = await Promise.all([
            q('SELECT category, amount_cents FROM pos_budgets WHERE shop_id=$1 ORDER BY category', [req.shop.id]),
            q('SELECT category, sum(amount_cents)::bigint t FROM pos_expenses WHERE shop_id=$1 AND spent_on >= $2 GROUP BY category', [req.shop.id, ms]),
            catList(req.shop.id)
        ]);
        const sp = new Map(spent.rows.map(x => [x.category, Number(x.t)]));
        send(req, res, { title: 'Budgets', nav: 'budgets', body: `<h1>Monthly Budgets</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/budgets" method="POST" class="row"><div><label for="c">Category</label><input id="c" name="category" list="cl" required maxlength="60"><datalist id="cl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div><div><label for="a">Monthly budget (KES)</label><input id="a" name="amount" required inputmode="decimal"></div><button class="btn" type="submit">Set budget</button></form></div>
        <div class="panel tablewrap">${b.rows.length ? `<table><tr><th>Category</th><th class="num">Budget</th><th class="num">Spent this month</th><th class="num">Left</th><th></th></tr>${b.rows.map(x => { const s = sp.get(x.category) || 0, left = Number(x.amount_cents) - s, pct = Math.min(100, Math.round(s * 100 / Math.max(1, Number(x.amount_cents)))); return `<tr><td>${esc(x.category)}<div style="background:#e2e8f0;border-radius:4px;height:6px;margin-top:4px"><div style="width:${pct}%;height:6px;border-radius:4px;background:${left < 0 ? '#dc2626' : pct > 80 ? '#d97706' : '#16a34a'}"></div></div></td><td class="num">${fmt(x.amount_cents)}</td><td class="num">${fmt(s)}</td><td class="num"><span class="tag ${left < 0 ? 'bad' : 'ok'}">${left < 0 ? '-' : ''}${fmt(Math.abs(left))}</span></td><td class="right"><form action="/pos/budgets/delete" method="POST" style="display:inline"><input type="hidden" name="category" value="${esc(x.category)}"><button class="btn small ghost" type="submit">Delete</button></form></td></tr>`; }).join('')}</table>` : '<p class="muted">No budgets set.</p>'}</div>` });
    }));
    router.post('/budgets', ah(async (req, res) => {
        const cat = str(req.body.category).slice(0, 60), amt = parseMoney(req.body.amount);
        if (!cat || amt === null) return back(res, '/pos/budgets', '', 'Enter a category and an amount.');
        await q('INSERT INTO pos_budgets (shop_id, category, amount_cents) VALUES ($1,$2,$3) ON CONFLICT (shop_id, category) DO UPDATE SET amount_cents=EXCLUDED.amount_cents', [req.shop.id, cat, amt]);
        back(res, '/pos/budgets', 'Budget saved.');
    }));
    router.post('/budgets/delete', ah(async (req, res) => {
        await q('DELETE FROM pos_budgets WHERE shop_id=$1 AND category=$2', [req.shop.id, str(req.body.category).slice(0, 60)]);
        back(res, '/pos/budgets', 'Budget deleted.');
    }));

    // ----- assets -----
    router.get('/assets', ah(async (req, res) => {
        const r = await q('SELECT * FROM pos_assets WHERE shop_id=$1 ORDER BY bought_on DESC, id DESC', [req.shop.id]), today = todayNairobi();
        send(req, res, { title: 'Assets', nav: 'assets', body: `<h1>Assets</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/assets" method="POST"><div class="grid2">
            <div class="field"><label for="n">Asset name</label><input id="n" name="name" required maxlength="120" placeholder="e.g. Fridge, Shelves, Laptop"></div>
            <div class="field"><label for="c">Cost (KES)</label><input id="c" name="cost" required inputmode="decimal"></div>
            <div class="field"><label for="d">Date bought</label><input id="d" type="date" name="bought_on" value="${today}" required></div>
            <div class="field"><label for="l">Useful life (years)</label><input id="l" name="life" inputmode="numeric" value="5"></div>
            <div class="field"><label for="s">Value at end of life (KES)</label><input id="s" name="salvage" inputmode="decimal" value="0"></div></div><button class="btn" type="submit">Add asset</button></form></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Asset</th><th>Bought</th><th class="num">Cost</th><th class="num">Current value</th><th></th></tr>${r.rows.map(a => `<tr><td>${esc(a.name)}</td><td>${esc(dateFmt(isoDate(a.bought_on) + 'T12:00:00+03:00'))}</td><td class="num">${fmt(a.cost_cents)}</td><td class="num">${fmt(assetBookValue(a, today))}</td><td class="right">${delBtn('/pos/assets/' + a.id + '/delete')}</td></tr>`).join('')}</table><p class="muted">Current value drops evenly over the useful life (straight-line depreciation).</p>` : '<p class="muted">No assets recorded.</p>'}</div>` });
    }));
    router.post('/assets', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120), cost = parseMoney(req.body.cost), salv = str(req.body.salvage) === '' ? 0 : parseMoney(req.body.salvage), life = parseCount(req.body.life || '5', { min: 1, max: 50 });
        if (!name || cost === null || cost <= 0 || salv === null || salv > cost || !life || !validDate(req.body.bought_on)) return back(res, '/pos/assets', '', 'Check the name, cost, date and useful life.');
        await q('INSERT INTO pos_assets (shop_id, name, cost_cents, bought_on, life_years, salvage_cents) VALUES ($1,$2,$3,$4,$5,$6)', [req.shop.id, name, cost, req.body.bought_on, life, salv]);
        back(res, '/pos/assets', 'Asset added.');
    }));
    router.post('/assets/:id/delete', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_assets WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/assets', 'Asset removed.');
    }));

    // ----- notebook -----
    router.get('/notebook', ah(async (req, res) => {
        const r = await q('SELECT * FROM pos_notes WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 200', [req.shop.id]);
        send(req, res, { title: 'Notebook', nav: 'notebook', body: `<h1>Notebook</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/notebook" method="POST"><div class="field"><label for="t">Title</label><input id="t" name="title" required maxlength="120"></div><div class="field"><label for="b">Note</label><textarea id="b" name="body" rows="4" maxlength="4000"></textarea></div><button class="btn" type="submit">Save note</button></form></div>
        ${r.rows.map(n => `<div class="panel"><div class="row" style="align-items:center"><h2 style="margin:0">${esc(n.title)}</h2><span class="muted" style="flex:0 0 auto">${esc(timeFmt(n.created_at))}</span><span style="flex:0 0 auto">${delBtn('/pos/notebook/' + n.id + '/delete')}</span></div><p style="white-space:pre-wrap;margin-bottom:0">${esc(n.body)}</p></div>`).join('') || '<p class="muted">No notes yet. Use this for supplier numbers, reminders and anything you want to remember.</p>'}` });
    }));
    router.post('/notebook', ah(async (req, res) => {
        const title = str(req.body.title).slice(0, 120);
        if (!title) return back(res, '/pos/notebook', '', 'Please enter a title.');
        await q('INSERT INTO pos_notes (shop_id, title, body) VALUES ($1,$2,$3)', [req.shop.id, title, String(req.body.body || '').slice(0, 4000)]);
        back(res, '/pos/notebook', 'Note saved.');
    }));
    router.post('/notebook/:id/delete', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_notes WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/notebook', 'Note deleted.');
    }));

    // ----- items export -----
    router.get('/items.csv', ah(async (req, res) => {
        const r = await q('SELECT i.name, c.name AS cat, i.barcode, i.price_cents, i.cost_cents, i.stock, i.track_stock, i.reorder_level, i.active FROM pos_items i LEFT JOIN pos_categories c ON c.id=i.category_id WHERE i.shop_id=$1 ORDER BY i.name', [req.shop.id]);
        const lines = [['Item', 'Category', 'Barcode', 'Price', 'Cost', 'Stock', 'Tracked', 'Reorder level', 'Active'].map(csvCell).join(',')];
        for (const i of r.rows) lines.push([i.name, i.cat || '', i.barcode || '', (i.price_cents / 100).toFixed(2), (i.cost_cents / 100).toFixed(2), i.stock, i.track_stock ? 'yes' : 'no', i.reorder_level, i.active ? 'yes' : 'no'].map(csvCell).join(','));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="items.csv"', 'Cache-Control': 'no-store' }).send('﻿' + lines.join('\r\n'));
    }));

    app.use('/pos', router);

    // ======================= BUSINESS FEATURES: subscription, gateways, branches, staff, install =======================
    const pubUrl = path => (publicBaseUrl || '') + path;

    // ----- monthly subscription, paid by M-Pesa to the platform's own account (the one set up in server.js) -----
    const subLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: 'Too many payment attempts. Please try again later.' });
    const subLastCheck = new Map();
    async function markSubPaid(id, receipt) {   // only the first caller extends the subscription, even if the callback and the status check arrive together
        const done = await q(`WITH p AS (UPDATE pos_sub_payments SET status='paid', receipt=CASE WHEN $2 <> '' THEN $2 ELSE receipt END, paid_at=now() WHERE id=$1 AND status <> 'paid' RETURNING business_id)
                 UPDATE pos_shops s SET sub_until = GREATEST(now(), COALESCE(s.sub_until, now())) + interval '1 month' FROM p WHERE s.id = p.business_id RETURNING s.id`, [id, String(receipt || '').slice(0, 40)]);
        if (done.rows[0]) await auditRaw(done.rows[0].id, null, 'system', null, '', 'sub.paid', 'KES ' + SUB_FEE_KES + ' ' + String(receipt || ''), '');
        if (receipt) await q(`UPDATE pos_sub_payments SET receipt=$2 WHERE id=$1 AND receipt = ''`, [id, String(receipt).slice(0, 40)]);
    }
    // called from server.js when Safaricom's callback is not for a booking; returns true when it was ours
    async function handlePlatformCallback(cb) {
        const p = (await q('SELECT * FROM pos_sub_payments WHERE checkout_request_id=$1', [String(cb.CheckoutRequestID || '')])).rows[0];
        if (!p) return false;
        const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [], meta = n => { const it = items.find(i => i.Name === n); return it ? it.Value : undefined; };
        const receipt = String(meta('MpesaReceiptNumber') || '').slice(0, 40);
        if (p.status === 'paid') { if (receipt) await q(`UPDATE pos_sub_payments SET receipt=$2 WHERE id=$1 AND receipt = ''`, [p.id, receipt]); return true; }
        if (Number(cb.ResultCode) !== 0) { await q(`UPDATE pos_sub_payments SET status='failed' WHERE id=$1 AND status='pending'`, [p.id]); return true; }
        if (Number(meta('Amount')) !== p.amount_kes) { await q(`UPDATE pos_sub_payments SET status='review', receipt=$2 WHERE id=$1 AND status IN ('pending','review')`, [p.id, receipt]); return true; }
        try {   // do not trust the callback alone
            const r = await platform.stkQuery(p.checkout_request_id);
            if (String(r.ResultCode) !== '0') { await q(`UPDATE pos_sub_payments SET status='review' WHERE id=$1 AND status='pending'`, [p.id]); return true; }
        } catch (e) { console.error('POS subscription status check failed, leaving it pending for the background check:', e.message); return true; }
        await markSubPaid(p.id, receipt);
        return true;
    }
    router.get('/subscribe', ah(async (req, res) => {
        const b = req.biz, until = b.sub_until ? new Date(b.sub_until) : null, active = req.subActive;
        const hist = (await q('SELECT amount_kes, status, receipt, created_at FROM pos_sub_payments WHERE business_id=$1 ORDER BY created_at DESC LIMIT 12', [b.id])).rows;
        const phone = platform && platform.normalizePhone ? (platform.normalizePhone(req.session.user.phone) || '') : '';
        const compNote = req.comped ? '<div class="alert ok" role="status">This is a complimentary test account: the POS is switched on without a subscription payment.</div>' : '';
        const payId = parseCount(req.query.pay, { min: 1 });
        send(req, res, { title: 'Subscription', nav: 'subscription', body: `<h1>Subscription</h1>${notice(req)}${errBox(req)}
        ${compNote}<div class="panel" style="max-width:620px"><h2>${active ? 'Your POS is active' : 'Your POS is not active'}</h2>
            <p>${active ? `Paid up to <b>${esc(dateFmt(until))}</b>.` : (until ? `It ended on <b>${esc(dateFmt(until))}</b>.` : 'Pay your first month to switch it on.')} The fee is <b>KES ${SUB_FEE_KES.toLocaleString('en-KE')} per month</b> for the whole business, including all branches and cashiers. Paying early adds a month to the end of your current period.</p>
            ${payId ? `<div id="paybox" class="alert ok" role="status">Check your phone and enter your M-Pesa PIN. Waiting for the payment...</div>` : ''}
            ${platform && platform.mpesaConfigured() ? `<form action="/pos/subscribe" method="POST" class="row"><div><label for="ph">M-Pesa number to pay from</label><input id="ph" name="phone" type="tel" required value="${esc(phone)}" placeholder="0712345678"></div><button class="btn ok" type="submit">Pay KES ${SUB_FEE_KES.toLocaleString('en-KE')} with M-Pesa</button></form>` : '<p class="alert">Online payment is not available right now. Please call 0740 311 014.</p>'}
        </div>
        ${active ? '<div class="panel" style="max-width:620px"><h2>Install the app</h2><p>Your POS can be installed on phones, tablets and computers. <a href="/pos/install">Open the install page</a>.</p></div>' : ''}
        <div class="panel tablewrap" style="max-width:620px"><h2>Payments</h2>${hist.length ? `<table><tr><th>Date</th><th class="num">Amount</th><th>Status</th><th>M-Pesa code</th></tr>${hist.map(h => `<tr><td>${esc(timeFmt(h.created_at))}</td><td class="num">${h.amount_kes.toLocaleString('en-KE')}</td><td><span class="tag ${h.status === 'paid' ? 'ok' : h.status === 'pending' ? 'warn' : 'bad'}">${esc(h.status)}</span></td><td>${esc(h.receipt)}</td></tr>`).join('')}</table>` : '<p class="muted">No payments yet.</p>'}</div>
        ${payId ? `<script nonce="${req.nonce || ''}">(function(){var n=0,box=document.getElementById('paybox'),t=setInterval(function(){n++;fetch('/pos/subscribe/status/${payId}',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(d){if(d.status==='paid'){clearInterval(t);location.href='/pos/subscribe?ok='+encodeURIComponent('Payment received. Your POS is active.');}else if(d.status==='failed'){clearInterval(t);location.href='/pos/subscribe?err='+encodeURIComponent('The payment was cancelled or timed out. Please try again.');}else if(d.status==='review'){clearInterval(t);box.textContent='We are confirming your payment and will call you shortly.';}else if(n>=60){clearInterval(t);box.textContent='We have not seen the payment yet. If you paid, it will switch on automatically.';}}).catch(function(){});},4000);})();</script>` : ''}` });
    }));
    router.post('/subscribe', subLimiter, ah(async (req, res) => {
        if (!platform || !platform.mpesaConfigured()) return back(res, '/pos/subscribe', '', 'Online payment is not available right now. Please call 0740 311 014.');
        const phone = platform.normalizePhone(str(req.body.phone));
        if (!phone) return back(res, '/pos/subscribe', '', 'Please enter a valid Safaricom number, for example 0712345678.');
        const open = (await q(`SELECT id FROM pos_sub_payments WHERE business_id=$1 AND status='pending' AND created_at > now() - interval '2 minutes'`, [req.biz.id])).rows[0];
        if (open) return res.redirect('/pos/subscribe?pay=' + open.id);
        let row = null;
        for (let i = 0; i < 5 && !row; i++) {
            try { row = (await q(`INSERT INTO pos_sub_payments (business_id, amount_kes, phone, account_ref) VALUES ($1,$2,$3,$4) RETURNING id, account_ref`, [req.biz.id, SUB_FEE_KES, phone, 'POS' + crypto.randomBytes(4).toString('hex').toUpperCase()])).rows[0]; }
            catch (e) { if (e.code !== '23505') throw e; }
        }
        if (!row) return back(res, '/pos/subscribe', '', 'Could not start the payment. Please try again.');
        try {
            const r = await platform.stkPush({ amount: SUB_FEE_KES, phone, accountRef: row.account_ref, desc: 'POS monthly' });
            await q('UPDATE pos_sub_payments SET checkout_request_id=$2 WHERE id=$1', [row.id, r.CheckoutRequestID]);
        } catch (e) {
            console.error('POS subscription STK failed:', e.message);
            await q(`UPDATE pos_sub_payments SET status='failed' WHERE id=$1`, [row.id]);
            return back(res, '/pos/subscribe', '', 'We could not send the M-Pesa prompt. Check the number and try again.');
        }
        res.redirect('/pos/subscribe?pay=' + row.id);
    }));
    router.get('/subscribe/status/:id', pollLimiter, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        let p = id && (await q('SELECT * FROM pos_sub_payments WHERE id=$1 AND business_id=$2', [id, req.biz.id])).rows[0];
        if (!p) return res.status(404).json({ status: 'unknown' });
        if (p.status === 'pending' && p.checkout_request_id && Date.now() - new Date(p.created_at).getTime() > 25000 && Date.now() - (subLastCheck.get(p.id) || 0) > 12000) {
            subLastCheck.set(p.id, Date.now());
            try {
                const r = await platform.stkQuery(p.checkout_request_id);
                if (String(r.ResultCode) === '0') await markSubPaid(p.id, '');
                else if (r.ResultCode !== undefined && String(r.ResultCode) !== '') await q(`UPDATE pos_sub_payments SET status='failed' WHERE id=$1 AND status='pending'`, [p.id]);
            } catch (_) { /* still processing */ }
            p = (await q('SELECT status FROM pos_sub_payments WHERE id=$1', [id])).rows[0];
        }
        res.set('Cache-Control', 'no-store').json({ status: p.status });
    }));

    // ----- payment gateways (owner): the business's own M-Pesa till/paybill, and others -----
    // Changing payment settings needs a fresh two-step code, because this is where a hijacked account would redirect the money.
    const stepFresh = req => Boolean(req.has2fa && req.session.posStepAt && Date.now() - req.session.posStepAt < STEP_VALID_MS);
    function needStep(req, res, path) {   // true when the request was refused
        if (!req.has2fa) { back(res, '/pos/security', '', 'Turn on two-step login first. It is required to change payment settings.'); return true; }
        if (!stepFresh(req)) { back(res, path, '', 'Enter your two-step code at the top of the page first.'); return true; }
        return false;
    }
    router.post('/gateways/unlock', ah(async (req, res) => {
        if (!req.has2fa) return back(res, '/pos/security', '', 'Turn on two-step login first.');
        const r = await verifyOwnerOtp(req, req.body.otp);
        await saveSess(req);
        back(res, '/pos/gateways', r.ok ? 'Unlocked for 10 minutes.' : '', r.ok ? '' : (r.locked ? 'Too many wrong codes. Wait 15 minutes.' : 'That code is not right.'));
    }));
    router.get('/gateways', ah(async (req, res) => {
        const gws = (await q('SELECT id, provider, cfg, active, is_default, callback_token FROM pos_gateways WHERE business_id=$1 ORDER BY id', [req.biz.id])).rows;
        const byProv = Object.fromEntries(gws.map(g => [g.provider, g]));
        const recent = (await q(`SELECT p.id, p.amount_kes, p.status, p.receipt, p.fail_reason, p.created_at, p.cashier_name, s.name AS shop FROM pos_payments p JOIN pos_shops s ON s.id=p.shop_id WHERE s.id=$1 OR s.parent_id=$1 ORDER BY p.created_at DESC LIMIT 15`, [req.biz.id])).rows;
        const mp = byProv.mpesa, ps = byProv.paystack, mc = mp ? mp.cfg : {}, fresh = stepFresh(req);
        const act = g => `<form action="/pos/gateways/${g.id}/test" method="POST" style="display:inline"><button class="btn small ghost">Test keys</button></form> ${g.is_default ? '<span class="tag ok">default</span>' : `<form action="/pos/gateways/${g.id}/default" method="POST" style="display:inline"><button class="btn small ghost">Make default</button></form>`} <form action="/pos/gateways/${g.id}/toggle" method="POST" style="display:inline"><button class="btn small ghost">${g.active ? 'Switch off' : 'Switch on'}</button></form> <form action="/pos/gateways/${g.id}/rotate" method="POST" style="display:inline"><button class="btn small ghost">New callback address</button></form> <form action="/pos/gateways/${g.id}/delete" method="POST" style="display:inline"><button class="btn small ghost">Remove</button></form>`;
        send(req, res, { title: 'Payment Gateways', nav: 'gateways', body: `<h1>Payment Gateways</h1>${notice(req)}${errBox(req)}
        <p class="muted" style="max-width:700px">Connect your own M-Pesa till or paybill so customers can pay from a prompt on their phone at the POS terminal. The money goes straight to your account, not ours. Your keys are stored encrypted and are never shown again.</p>
        ${vault.enabled ? '' : '<div class="alert" role="alert">Keys cannot be saved yet: the site administrator must set POS_CRED_KEY (a long random secret) in the server settings.</div>'}
        ${req.has2fa ? (fresh ? '<div class="alert ok" role="status">Unlocked: you can change payment settings for the next few minutes.</div>' : `<div class="panel" style="max-width:720px"><form action="/pos/gateways/unlock" method="POST" class="row"><div><label for="otp">Two-step code (needed to change anything on this page)</label><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" required maxlength="20"></div><button class="btn" type="submit">Unlock</button></form></div>`) : '<div class="alert" role="alert">Payment settings need two-step login. <a href="/pos/security">Turn it on first</a>.</div>'}
        <div class="panel" style="max-width:720px"><h2>M-Pesa (Safaricom Daraja) ${mp ? (mp.active ? '<span class="tag ok">connected</span>' : '<span class="tag gray">off</span>') : ''}</h2>
            ${mp ? `<p>${act(mp)}</p><p class="muted">Callback address used for this business: <code>${esc(pubUrl('/pos/mpesa/cb/' + String(mp.callback_token).trim()))}</code> (sent with every prompt, nothing to register). Every payment is also double-checked with Safaricom before a sale is saved.</p>` : ''}
            <form action="/pos/gateways/mpesa" method="POST"><div class="grid2">
                <div class="field"><label for="env">Environment</label><select id="env" name="env"><option value="production" ${mc.env === 'production' ? 'selected' : ''}>Live (production)</option><option value="sandbox" ${mc.env === 'sandbox' ? 'selected' : ''}>Test (sandbox)</option></select></div>
                <div class="field"><label for="tt">Your account type</label><select id="tt" name="txnType"><option value="paybill" ${mc.txnType !== 'till' ? 'selected' : ''}>Paybill</option><option value="till" ${mc.txnType === 'till' ? 'selected' : ''}>Buy Goods (Till)</option></select></div>
                <div class="field"><label for="sc">Business shortcode</label><input id="sc" name="shortcode" inputmode="numeric" maxlength="8" value="${esc(mc.shortcode || '')}" placeholder="Paybill number, or store number for a till"></div>
                <div class="field"><label for="tl">Till number (Buy Goods only)</label><input id="tl" name="till" inputmode="numeric" maxlength="8" value="${esc(mc.till || '')}"></div>
                <div class="field"><label for="ck">Consumer key</label><input id="ck" name="consumerKey" autocomplete="off" placeholder="${mp ? 'saved: leave blank to keep' : ''}"></div>
                <div class="field"><label for="cs">Consumer secret</label><input id="cs" name="consumerSecret" type="password" autocomplete="off" placeholder="${mp ? 'saved: leave blank to keep' : ''}"></div>
                <div class="field"><label for="pk">Lipa na M-Pesa passkey</label><input id="pk" name="passkey" type="password" autocomplete="off" placeholder="${mp ? 'saved: leave blank to keep' : ''}"></div></div>
            <p class="muted">Get the key, secret and passkey from developer.safaricom.co.ke (your app, then Go Live), or from Safaricom Business support.</p>
            <button class="btn" type="submit">${mp ? 'Update M-Pesa' : 'Connect M-Pesa'}</button></form></div>
        ${PAYSTACK_ON ? `<div class="panel" style="max-width:720px"><h2>Paystack (M-Pesa mobile money) ${ps ? (ps.active ? '<span class="tag ok">connected</span>' : '<span class="tag gray">off</span>') : ''}</h2>
            ${ps ? `<p>${act(ps)}</p><p class="muted">Optional webhook address for your Paystack dashboard: <code>${esc(pubUrl('/pos/paystack/hook/' + String(ps.callback_token).trim()))}</code></p>` : ''}
            <form action="/pos/gateways/paystack" method="POST"><div class="field"><label for="sk">Paystack secret key</label><input id="sk" name="secretKey" type="password" autocomplete="off" placeholder="${ps ? 'saved: leave blank to keep' : 'sk_live_...'}"></div>
            <p class="muted">Not yet tested against Paystack's live service: try a small sale first.</p>
            <button class="btn" type="submit">${ps ? 'Update Paystack' : 'Connect Paystack'}</button></form></div>` : ''}
        <div class="panel tablewrap"><h2>Recent phone-prompt payments</h2>${recent.length ? `<table><tr><th>When</th><th>Shop</th><th>Cashier</th><th class="num">KES</th><th>Status</th><th>Code</th><th></th></tr>${recent.map(r => `<tr><td class="nowrap">${esc(timeFmt(r.created_at))}</td><td>${esc(r.shop)}</td><td>${esc(r.cashier_name)}</td><td class="num">${r.amount_kes.toLocaleString('en-KE')}</td><td><span class="tag ${r.status === 'paid' ? 'ok' : r.status === 'pending' ? 'warn' : 'bad'}">${esc(r.status)}</span>${r.fail_reason ? '<br><small class="muted">' + esc(r.fail_reason) + '</small>' : ''}</td><td>${esc(r.receipt)}</td><td class="right">${r.status === 'review' || r.status === 'pending' ? `<form action="/pos/payments/${esc(r.id)}/confirm" method="POST" style="display:inline"><input name="receipt" placeholder="M-Pesa code" maxlength="14" required style="width:110px;display:inline-block"> <button class="btn small ghost" type="submit">I received it</button></form>` : ''}</td></tr>`).join('')}</table><p class="muted">"review" means the amount or status did not match, or no confirmation came: check your M-Pesa statement. Only press "I received it" after you see the money, with the code from your statement.</p>` : '<p class="muted">None yet.</p>'}</div>` });
    }));
    async function saveGateway(req, res, provider, cfg, secrets) {
        const existing = (await q('SELECT 1 FROM pos_gateways WHERE business_id=$1 AND is_default', [req.biz.id])).rowCount > 0;
        await q(`INSERT INTO pos_gateways (business_id, provider, cfg, secrets, callback_token, is_default) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
                 ON CONFLICT (business_id, provider) DO UPDATE SET cfg=EXCLUDED.cfg, secrets=EXCLUDED.secrets, active=TRUE`, [req.biz.id, provider, JSON.stringify(cfg), vault.seal(secrets, `${req.biz.id}:${provider}`), crypto.randomBytes(24).toString('hex'), !existing]);
        await audit(req, 'gateway.save', `${provider} ${cfg.env || ''} ${cfg.shortcode || ''}`.trim());   // never the secrets
        const gw = await loadGateway('business_id=$1 AND provider=$2', [req.biz.id, provider]);
        try { await GW.PROVIDERS[provider].test(gw); return back(res, '/pos/gateways', 'Saved. The keys were accepted.'); }
        catch (e) { return back(res, '/pos/gateways', 'Saved, but the keys were NOT accepted (' + String(e.message).slice(0, 80) + '). Check them and the Live/Test setting.'); }
    }
    router.post('/gateways/mpesa', ah(async (req, res) => {
        if (!vault.enabled) return back(res, '/pos/gateways', '', 'Keys cannot be saved until the site administrator sets POS_CRED_KEY.');
        if (needStep(req, res, '/pos/gateways')) return;
        const b = req.body || {}, old = await loadGateway('business_id=$1 AND provider=$2', [req.biz.id, 'mpesa']);
        const cfg = { env: b.env === 'sandbox' ? 'sandbox' : 'production', txnType: b.txnType === 'till' ? 'till' : 'paybill', shortcode: str(b.shortcode), till: str(b.till) };
        const secrets = { consumerKey: str(b.consumerKey) || (old && old.secrets.consumerKey) || '', consumerSecret: str(b.consumerSecret) || (old && old.secrets.consumerSecret) || '', passkey: str(b.passkey) || (old && old.secrets.passkey) || '' };
        if (!/^\d{5,8}$/.test(cfg.shortcode)) return back(res, '/pos/gateways', '', 'Enter the business shortcode (5 to 8 digits).');
        if (cfg.txnType === 'till' && !/^\d{5,8}$/.test(cfg.till)) return back(res, '/pos/gateways', '', 'For Buy Goods, enter your till number.');
        if (cfg.txnType !== 'till') cfg.till = '';
        for (const k of ['consumerKey', 'consumerSecret', 'passkey']) if (!/^\S{8,300}$/.test(secrets[k])) return back(res, '/pos/gateways', '', 'Please fill in the consumer key, consumer secret and passkey.');
        await saveGateway(req, res, 'mpesa', cfg, secrets);
    }));
    router.post('/gateways/paystack', ah(async (req, res) => {
        if (!PAYSTACK_ON) return back(res, '/pos/gateways', '', 'Paystack is not switched on for this server.');
        if (!vault.enabled) return back(res, '/pos/gateways', '', 'Keys cannot be saved until the site administrator sets POS_CRED_KEY.');
        if (needStep(req, res, '/pos/gateways')) return;
        const old = await loadGateway('business_id=$1 AND provider=$2', [req.biz.id, 'paystack']);
        const secretKey = str(req.body.secretKey) || (old && old.secrets.secretKey) || '';
        if (!/^sk_(live|test)_[A-Za-z0-9]{10,}$/.test(secretKey)) return back(res, '/pos/gateways', '', 'Enter your Paystack secret key (it starts with sk_).');
        await saveGateway(req, res, 'paystack', {}, { secretKey });
    }));
    const gwById = async req => { const id = parseCount(req.params.id, { min: 1 }); return id ? loadGateway('id=$1 AND business_id=$2', [id, req.biz.id]) : null; };
    router.post('/gateways/:id/test', ah(async (req, res) => {
        const gw = await gwById(req); if (!gw) return back(res, '/pos/gateways', '', 'Gateway not found.');
        try { await GW.PROVIDERS[gw.provider].test(gw); back(res, '/pos/gateways', 'The keys are accepted.'); } catch (e) { back(res, '/pos/gateways', '', 'The keys were not accepted: ' + String(e.message).slice(0, 100)); }
    }));
    const gwAction = (name, label, fn) => router.post('/gateways/:id/' + name, ah(async (req, res) => {
        if (needStep(req, res, '/pos/gateways')) return;
        const id = parseCount(req.params.id, { min: 1 });
        if (id && await fn(req, id)) await audit(req, 'gateway.' + name, 'gateway #' + id);
        back(res, '/pos/gateways', label);
    }));
    gwAction('default', 'Default gateway changed.', async (req, id) => (await q('UPDATE pos_gateways SET is_default = (id=$2) WHERE business_id=$1', [req.biz.id, id])).rowCount > 0);
    gwAction('toggle', 'Saved.', async (req, id) => (await q('UPDATE pos_gateways SET active = NOT active WHERE id=$1 AND business_id=$2', [id, req.biz.id])).rowCount > 0);
    gwAction('delete', 'Removed.', async (req, id) => (await q('DELETE FROM pos_gateways WHERE id=$1 AND business_id=$2', [id, req.biz.id])).rowCount > 0);
    gwAction('rotate', 'New callback address created. Payments already waiting are still checked directly with the payment company.', async (req, id) => (await q('UPDATE pos_gateways SET callback_token=$3 WHERE id=$1 AND business_id=$2', [id, req.biz.id, crypto.randomBytes(24).toString('hex')])).rowCount > 0);
    // the owner can settle a payment by hand after seeing the money on their M-Pesa statement
    router.post('/payments/:id/confirm', ah(async (req, res) => {
        if (needStep(req, res, '/pos/gateways')) return;
        const code = str(req.body.receipt).toUpperCase();
        if (!/^[A-Z0-9]{8,14}$/.test(code)) return back(res, '/pos/gateways', '', 'Enter the M-Pesa code from your statement.');
        const p = (await q(`SELECT p.id FROM pos_payments p JOIN pos_shops s ON s.id = p.shop_id WHERE p.id=$1 AND p.status IN ('pending','review') AND p.sale_id IS NULL AND (s.id=$2 OR s.parent_id=$2)`, [String(req.params.id).slice(0, 32), req.biz.id])).rows[0];
        if (!p) return back(res, '/pos/gateways', '', 'That payment can no longer be confirmed.');
        await finalizePayment(p.id, code);
        await audit(req, 'payment.manual_confirm', 'payment ' + p.id + ' code ' + code);
        back(res, '/pos/gateways', 'Payment confirmed and the sale was saved.');
    }));

    // ----- branches (owner): linked accounts under the same business -----
    const passwordProblem = (pw, min, username = '') => pw.length < min ? `The password must be at least ${min} characters.` : Buffer.byteLength(pw) > 72 ? 'The password is too long (72 characters at most).' : (COMMON_PW.has(pw.toLowerCase()) || (username && pw.toLowerCase() === String(username).toLowerCase())) ? 'That password is too easy to guess. Choose a different one.' : '';
    const MIN_PW = { manager: 10, cashier: 8 };
    const USERNAME_OK = /^[A-Za-z0-9._-]{3,30}$/;
    router.get('/branches', ah(async (req, res) => {
        const today = todayNairobi();
        const rows = (await q(`SELECT s.id, s.name, s.address, s.phone, s.active, (s.parent_id IS NULL) AS hq,
                (SELECT count(*)::int FROM pos_staff t WHERE t.shop_id=s.id AND t.active) AS staff,
                COALESCE((SELECT sum(total_cents) FROM pos_sales x WHERE x.shop_id=s.id AND x.status='completed' AND (x.created_at AT TIME ZONE '${TZ}')::date = $2),0)::bigint AS today
              FROM pos_shops s WHERE s.id=$1 OR s.parent_id=$1 ORDER BY (s.parent_id IS NULL) DESC, s.name`, [req.biz.id, today])).rows;
        const total = rows.reduce((a, r) => a + Number(r.today), 0);
        send(req, res, { title: 'Branches', nav: 'branches', body: `<h1>Branches</h1>${notice(req)}${errBox(req)}
        <div class="panel"><p style="margin-top:0">Staff sign in at <b>${esc(pubUrl('/pos/staff/login'))}</b> with this business code: <b style="font-size:1.2rem;letter-spacing:.1em">${esc(req.biz.code || '')}</b></p>
            <p class="muted" style="margin-bottom:0">Today's sales across all branches: <b>${kes(total)}</b></p></div>
        <div class="panel tablewrap"><table><tr><th>Branch</th><th>Address</th><th class="num">Staff</th><th class="num">Sales today</th><th></th></tr>${rows.map(r => `<tr><td>${esc(r.name)}${r.hq ? ' <span class="tag gray">head office</span>' : ''}${r.active ? '' : ' <span class="tag bad">paused</span>'}</td><td>${esc(r.address)}</td><td class="num">${r.staff}</td><td class="num">${fmt(r.today)}</td><td class="right">${r.active ? `<form action="/pos/branches/switch" method="POST" style="display:inline"><input type="hidden" name="shop_id" value="${r.id}"><button class="btn small" type="submit">Open</button></form>` : ''} ${r.hq ? '' : `<form action="/pos/branches/${r.id}/toggle" method="POST" style="display:inline"><button class="btn small ghost" type="submit">${r.active ? 'Pause' : 'Resume'}</button></form>`}</td></tr>`).join('')}</table></div>
        <div class="panel" style="max-width:720px"><h2>Open a new branch</h2><form action="/pos/branches" method="POST"><div class="grid2">
            <div class="field"><label for="bn">Branch name</label><input id="bn" name="name" required maxlength="120" placeholder="e.g. Kisumu Branch"></div>
            <div class="field"><label for="ba">Address</label><input id="ba" name="address" maxlength="200"></div>
            <div class="field"><label for="bp">Branch phone</label><input id="bp" name="phone" maxlength="40"></div></div>
            <div class="field"><label><input type="checkbox" name="copy" value="1" checked style="width:auto"> Copy my items and categories to the new branch (stock starts at 0)</label></div>
            <h2 style="margin-top:14px">Branch manager login (optional)</h2><p class="muted">The manager runs the branch and can register its cashiers.</p><div class="grid2">
            <div class="field"><label for="mn">Manager name</label><input id="mn" name="mname" maxlength="80"></div>
            <div class="field"><label for="mu">Username</label><input id="mu" name="musername" maxlength="30" autocapitalize="none" autocomplete="off"></div>
            <div class="field"><label for="mp">Password</label><input id="mp" name="mpassword" type="password" autocomplete="new-password" maxlength="72"></div></div>
            <button class="btn" type="submit">Open branch</button></form></div>` });
    }));
    router.post('/branches', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120), mname = str(req.body.mname).slice(0, 80), mu = str(req.body.musername), mpw = String(req.body.mpassword || '');
        if (name.length < 2) return back(res, '/pos/branches', '', 'Please enter the branch name.');
        const wantManager = Boolean(mname || mu || mpw);
        if (wantManager && (mname.length < 2 || !USERNAME_OK.test(mu) || passwordProblem(mpw, MIN_PW.manager, mu))) return back(res, '/pos/branches', '', 'For the manager login enter a name, a username (3 to 30 letters or numbers) and a password of at least 10 characters that is not easy to guess.');
        const count = Number((await q('SELECT count(*) n FROM pos_shops WHERE parent_id=$1', [req.biz.id])).rows[0].n);
        if (count >= 50) return back(res, '/pos/branches', '', 'You have reached the limit of 50 branches.');
        const hash = wantManager ? await bcrypt.hash(mpw, 10) : '';
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const b = (await client.query('INSERT INTO pos_shops (parent_id, name, phone, address, receipt_footer) VALUES ($1,$2,$3,$4,$5) RETURNING id', [req.biz.id, name, str(req.body.phone).slice(0, 40), str(req.body.address).slice(0, 200), req.biz.receipt_footer])).rows[0];
            if (req.body.copy === '1') {
                await client.query('INSERT INTO pos_categories (shop_id, name) SELECT $2, name FROM pos_categories WHERE shop_id=$1', [req.biz.id, b.id]);
                await client.query(`INSERT INTO pos_items (shop_id, category_id, name, barcode, price_cents, cost_cents, stock, track_stock, reorder_level, active)
                    SELECT $2, nc.id, i.name, i.barcode, i.price_cents, i.cost_cents, 0, i.track_stock, i.reorder_level, i.active FROM pos_items i
                    LEFT JOIN pos_categories oc ON oc.id = i.category_id LEFT JOIN pos_categories nc ON nc.shop_id = $2 AND nc.name = oc.name WHERE i.shop_id = $1`, [req.biz.id, b.id]);
            }
            if (wantManager) await client.query(`INSERT INTO pos_staff (business_id, shop_id, role, name, username, password_hash) VALUES ($1,$2,'manager',$3,$4,$5)`, [req.biz.id, b.id, mname, mu, hash]);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            if (e.code === '23505') return back(res, '/pos/branches', '', 'That username is already used in your business. Choose another.');
            throw e;
        } finally { client.release(); }
        await audit(req, 'branch.open', name);
        back(res, '/pos/branches', 'Branch opened.');
    }));
    router.post('/branches/switch', ah(async (req, res) => {
        const id = parseCount(req.body.shop_id, { min: 1 });
        if (id && req.branches.some(b => b.id === id && b.active)) { req.session.posShopId = id; await saveSess(req); }
        res.redirect('/pos/app');
    }));
    router.post('/branches/:id/toggle', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id && (await q('UPDATE pos_shops SET active = NOT active WHERE id=$1 AND parent_id=$2', [id, req.biz.id])).rowCount) await audit(req, 'branch.toggle', 'branch #' + id);
        back(res, '/pos/branches', 'Saved.');
    }));

    // ----- staff: managers and cashiers -----
    const staffScope = req => req.actor.role === 'owner' ? { sql: '(t.business_id=$1)', params: [req.biz.id] } : { sql: '(t.shop_id=$1 AND t.role=\'cashier\')', params: [req.shop.id] };
    router.get('/staff', ah(async (req, res) => {
        const owner = req.actor.role === 'owner', sc = staffScope(req);
        const rows = (await q(`SELECT t.id, t.name, t.username, t.role, t.active, t.last_login, s.name AS shop FROM pos_staff t JOIN pos_shops s ON s.id=t.shop_id WHERE ${sc.sql} ORDER BY s.name, t.role, t.name`, sc.params)).rows;
        send(req, res, { title: 'Staff', nav: 'staff', body: `<h1>${owner ? 'Staff & Cashiers' : 'Cashiers'}</h1>${notice(req)}${errBox(req)}
        <div class="panel"><p style="margin:0">They sign in at <b>${esc(pubUrl('/pos/staff/login'))}</b> with business code <b>${esc(req.biz.code || '')}</b>, their username and their password.</p></div>
        <div class="panel" style="max-width:720px"><h2>Register ${owner ? 'a staff member' : 'a cashier'}</h2><form action="/pos/staff" method="POST"><div class="grid2">
            <div class="field"><label for="sn">Full name</label><input id="sn" name="name" required maxlength="80"></div>
            <div class="field"><label for="su">Username</label><input id="su" name="username" required maxlength="30" autocapitalize="none" autocomplete="off"><small>3 to 30 letters, numbers, dot, dash or underscore.</small></div>
            <div class="field"><label for="sp">Password</label><input id="sp" name="password" type="password" required maxlength="72" autocomplete="new-password"><small>At least 8 characters (10 for managers).</small></div>
            ${owner ? `<div class="field"><label for="sr">Role</label><select id="sr" name="role"><option value="cashier">Cashier (sells only)</option><option value="manager">Branch manager</option></select></div>
            <div class="field"><label for="ss">Works at</label><select id="ss" name="shop_id">${req.branches.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div>` : ''}</div>
            <button class="btn" type="submit">Register</button></form></div>
        <div class="panel tablewrap">${rows.length ? `<table><tr><th>Name</th><th>Username</th><th>Role</th><th>Branch</th><th>Last sign-in</th><th></th></tr>${rows.map(r => `<tr><td>${esc(r.name)}${r.active ? '' : ' <span class="tag bad">off</span>'}</td><td>${esc(r.username)}</td><td>${esc(r.role)}</td><td>${esc(r.shop)}</td><td class="nowrap">${r.last_login ? esc(timeFmt(r.last_login)) : '-'}</td><td class="right nowrap">
            <form action="/pos/staff/${r.id}/password" method="POST" style="display:inline"><input name="password" type="password" placeholder="New password" minlength="8" maxlength="72" required style="width:130px;display:inline-block" autocomplete="new-password"> <button class="btn small ghost" type="submit">Reset</button></form>
            <form action="/pos/staff/${r.id}/toggle" method="POST" style="display:inline"><button class="btn small ghost" type="submit">${r.active ? 'Switch off' : 'Switch on'}</button></form>
            <form action="/pos/staff/${r.id}/delete" method="POST" style="display:inline"><button class="btn small ghost" type="submit">Delete</button></form></td></tr>`).join('')}</table>` : '<p class="muted">No one registered yet.</p>'}</div>` });
    }));
    router.post('/staff', ah(async (req, res) => {
        const owner = req.actor.role === 'owner';
        const name = str(req.body.name).slice(0, 80), username = str(req.body.username), pw = String(req.body.password || '');
        const role = owner && req.body.role === 'manager' ? 'manager' : 'cashier';
        const shopId = owner ? parseCount(req.body.shop_id, { min: 1 }) : req.shop.id;
        if (name.length < 2 || !USERNAME_OK.test(username)) return back(res, '/pos/staff', '', 'Enter a name and a username of 3 to 30 letters or numbers.');
        const pwErr = passwordProblem(pw, MIN_PW[role], username);
        if (pwErr) return back(res, '/pos/staff', '', pwErr);
        if (!(owner ? req.branches : [{ id: req.shop.id }]).some(b => b.id === shopId)) return back(res, '/pos/staff', '', 'Choose a branch.');
        try { await q('INSERT INTO pos_staff (business_id, shop_id, role, name, username, password_hash) VALUES ($1,$2,$3,$4,$5,$6)', [req.biz.id, shopId, role, name, username, await bcrypt.hash(pw, 10)]); }
        catch (e) { if (e.code === '23505') return back(res, '/pos/staff', '', 'That username is already used in your business. Choose another.'); throw e; }
        await audit(req, 'staff.add', `${username} (${role})`);
        back(res, '/pos/staff', name + ' can now sign in.');
    }));
    const staffAct = (path, sqlFor) => router.post('/staff/:id/' + path, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 }), sc = staffScope(req);
        let msg = 'Saved.';
        if (id) {
            const own = (await q(`SELECT t.id, t.name, t.username, t.role FROM pos_staff t WHERE t.id=$${sc.params.length + 1} AND ${sc.sql}`, [...sc.params, id])).rows[0];
            if (own) { const r = await sqlFor(req, own); if (r === false) msg = 'That password is not strong enough (8 characters, 10 for managers, not easy to guess).'; else await audit(req, 'staff.' + path, `${own.username} (${own.role})`); }
        }
        back(res, '/pos/staff', msg);
    }));
    staffAct('password', async (req, t) => {
        const pw = String(req.body.password || '');
        if (passwordProblem(pw, MIN_PW[t.role], t.username)) return false;
        await q('UPDATE pos_staff SET password_hash=$2, failed=0, locked_until=NULL, session_ver = session_ver + 1 WHERE id=$1', [t.id, await bcrypt.hash(pw, 10)]);
        await q('DELETE FROM pos_auth_fails WHERE left(key, char_length($1)) = $1', [`u:${req.biz.code}:${String(t.username).toLowerCase()}`]);   // lift any sign-in lock
    });
    staffAct('toggle', (req, t) => q('UPDATE pos_staff SET active = NOT active, session_ver = session_ver + 1 WHERE id=$1', [t.id]));
    staffAct('delete', (req, t) => q('DELETE FROM pos_staff WHERE id=$1', [t.id]));

    // ----- a staff member changes their own password -----
    router.get('/account', ah(async (req, res) => {
        send(req, res, { title: 'My Account', nav: 'account', body: `<h1>My Account</h1>${notice(req)}${errBox(req)}<div class="panel" style="max-width:480px"><p>Signed in as <b>${esc(req.actor.name || '')}</b> (${esc(req.actor.role)}) at ${esc(req.shop.name)}.</p>
            <form action="/pos/account/password" method="POST"><div class="field"><label for="cp">Current password</label><input id="cp" name="current" type="password" required autocomplete="current-password" maxlength="100"></div>
            <div class="field"><label for="np">New password</label><input id="np" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password"></div><button class="btn" type="submit">Change password</button></form></div>` });
    }));
    router.post('/account/password', ah(async (req, res) => {
        if (req.actor.kind !== 'staff') return back(res, '/pos/app', 'Owners change their password on the main site.');
        const row = (await q('SELECT password_hash FROM pos_staff WHERE id=$1', [req.actor.staffId])).rows[0];
        const pw = String(req.body.password || '');
        if (!row || !(await bcrypt.compare(String(req.body.current || ''), row.password_hash))) return back(res, '/pos/account', '', 'The current password is not right.');
        const pwErr = passwordProblem(pw, MIN_PW[req.actor.role] || 8, req.actor.username || '');
        if (pwErr) return back(res, '/pos/account', '', pwErr);
        await q('UPDATE pos_staff SET password_hash=$2, session_ver = session_ver + 1 WHERE id=$1', [req.actor.staffId, await bcrypt.hash(pw, 10)]);
        req.session.posStaff.ver += 1;   // this session stays signed in, every other one ends
        await audit(req, 'staff.own_password', '');
        back(res, '/pos/account', 'Password changed.');
    }));

    // ----- install as an app -----
    router.get('/install', ah(async (req, res) => {
        send(req, res, { title: 'Install App', nav: 'install', body: `<h1>Install the POS app</h1>
        <div class="panel" style="max-width:640px">
            <div id="installed" class="alert ok" role="status" style="display:none">The POS app is already installed on this device.</div>
            <p id="install-intro" style="margin-top:0">Tap the button to install Tencent POS on this device. It gets its own icon and opens like any other app.</p>
            <p><button class="btn ok" id="install-now" type="button" style="display:none;padding:14px 26px;font-size:1.05rem">Install now</button></p>
            <div id="help-ios" style="display:none"><p><b>On iPhone / iPad</b> Apple does not allow one-tap installs: tap the Share button in Safari, then <i>Add to Home Screen</i>.</p></div>
            <div id="help-other" style="display:none"><p>Your browser did not offer the install yet. Open this page in <b>Chrome</b> or <b>Edge</b> and try again, or use the browser menu (three dots), then <i>Install app</i> / <i>Add to Home screen</i>.</p></div>
            <p class="muted">The POS needs internet to save sales. ${req.actor.role === 'owner' ? `Cashiers and managers install it the same way, opening <b>${esc(pubUrl('/pos/staff/login'))}</b> on their own device.` : ''}</p></div>
        <script nonce="${req.nonce || ''}">
        (function () {
            var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
            if (standalone) { document.getElementById('installed').style.display = ''; document.getElementById('install-intro').style.display = 'none'; return; }
            var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            if (ios) { document.getElementById('help-ios').style.display = ''; return; }
            setTimeout(function () { var b = document.getElementById('install-now'); if (b && b.style.display === 'none') document.getElementById('help-other').style.display = ''; }, 2000);
        })();
        </script>` });
    }));


    // ----- background checks (safe to run on several server copies at once: every step is idempotent) -----
    // 1) payments still waiting are asked about directly, so a sale is saved even if the callback never arrives
    // 2) payments with no answer after 30 minutes go to "review" for the owner
    // 3) gateway secrets sealed with an old key are re-sealed with the current key
    // 4) old throttle rows are removed
    let lastHousekeeping = 0;
    async function sweep() {
        const pend = (await q(`SELECT * FROM pos_payments WHERE status='pending' AND provider_ref IS NOT NULL AND created_at < now() - interval '25 seconds' AND created_at > now() - interval '30 minutes' ORDER BY created_at LIMIT 25`)).rows;
        for (const p of pend) {
            const gw = await loadGateway('id=$1', [p.gateway_id]);
            if (!gw) continue;
            await applyVerdict(p, await GW.PROVIDERS[gw.provider].verify(gw, p.provider_ref).catch(() => ({ state: 'pending' })));
        }
        await q(`UPDATE pos_payments SET status='review', fail_reason='No confirmation received. Check your M-Pesa statement.', updated_at=now() WHERE status='pending' AND created_at < now() - interval '30 minutes'`);
        if (platform) {
            const subs = (await q(`SELECT * FROM pos_sub_payments WHERE status='pending' AND checkout_request_id IS NOT NULL AND created_at < now() - interval '25 seconds' AND created_at > now() - interval '30 minutes' LIMIT 25`)).rows;
            for (const p of subs) {
                try {
                    const r = await platform.stkQuery(p.checkout_request_id);
                    if (String(r.ResultCode) === '0') await markSubPaid(p.id, '');
                    else if (r.ResultCode !== undefined && String(r.ResultCode) !== '') await q(`UPDATE pos_sub_payments SET status='failed' WHERE id=$1 AND status='pending'`, [p.id]);
                } catch (_) { /* not ready yet */ }
            }
        }
        if (Date.now() - lastHousekeeping > 10 * 60 * 1000) {
            lastHousekeeping = Date.now();
            await q(`DELETE FROM pos_auth_fails WHERE COALESCE(locked_until, first_at) < now() - interval '2 days'`);
            if (vault.enabled) {
                for (const g of (await q('SELECT id, business_id, provider, secrets FROM pos_gateways')).rows) {
                    if (!vault.needsRotation(g.secrets)) continue;
                    try { const scope = `${g.business_id}:${g.provider}`; await q('UPDATE pos_gateways SET secrets=$2 WHERE id=$1 AND secrets=$3', [g.id, vault.seal(vault.open(g.secrets, scope), scope), g.secrets]); console.log('POS: re-sealed gateway', g.id, 'with the current key'); }
                    catch (e) { console.error('POS: could not re-seal gateway', g.id + ':', e.message); }
                }
            }
        }
    }
    if (process.env.POS_NO_JOBS !== '1') { const t = setInterval(() => sweep().catch(e => console.error('POS background check failed:', e.message)), 30000); if (t.unref) t.unref(); }

    return { handlePlatformCallback };
}

module.exports = mountPos;
module.exports.initSchema = initSchema;
