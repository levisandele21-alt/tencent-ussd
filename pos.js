'use strict';
// ---------------------------------------------------------------------------
// Tencent POS: a point-of-sale service for shops, mounted into server.js at /pos.
// Every shop has its own products, stock, sales and reports. Every database query is
// limited to the signed-in owner's shop, so one shop can never see another shop's data.
// ---------------------------------------------------------------------------
const express = require('express');

const TZ = 'Africa/Nairobi';

async function initSchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_businesses (
            id SERIAL PRIMARY KEY,
            owner_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(120) NOT NULL,
            tax_pin VARCHAR(40) NOT NULL DEFAULT '',
            receipt_footer VARCHAR(200) NOT NULL DEFAULT 'Thank you for shopping with us!',
            vat_rate NUMERIC(4,1) NOT NULL DEFAULT 16,
            logo BYTEA,
            logo_mime VARCHAR(20),
            logo_ver INT NOT NULL DEFAULT 0,
            active_until TIMESTAMPTZ,
            suspended BOOLEAN NOT NULL DEFAULT FALSE,
            mpesa_enc TEXT,
            mpesa_type VARCHAR(12),
            cb_token VARCHAR(64) UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_shops (
            id SERIAL PRIMARY KEY,
            business_id INT NOT NULL REFERENCES pos_businesses(id) ON DELETE CASCADE,
            name VARCHAR(120) NOT NULL,
            phone VARCHAR(40) NOT NULL DEFAULT '',
            address VARCHAR(200) NOT NULL DEFAULT '',
            next_receipt INT NOT NULL DEFAULT 1,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    // Upgrade from the first POS version (one shop per owner): each old shop becomes a business with one branch, with a free month
    const oldShops = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_shops' AND column_name = 'owner_id'`);
    if (oldShops.rowCount) {
        await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS business_id INT REFERENCES pos_businesses(id) ON DELETE CASCADE');
        const old = (await pool.query('SELECT id, owner_id, name, tax_pin, receipt_footer FROM pos_shops WHERE business_id IS NULL')).rows;
        for (const sh of old) {
            const b = (await pool.query(`INSERT INTO pos_businesses (owner_id, name, tax_pin, receipt_footer, cb_token, active_until) VALUES ($1,$2,$3,$4,$5, now() + interval '30 days') ON CONFLICT (owner_id) DO UPDATE SET name = pos_businesses.name RETURNING id`,
                [sh.owner_id, sh.name, sh.tax_pin || '', sh.receipt_footer || 'Thank you for shopping with us!', crypto.randomBytes(24).toString('hex')])).rows[0];
            await pool.query(`UPDATE pos_shops SET business_id = $2, name = 'Main Branch' WHERE id = $1`, [sh.id, b.id]);
        }
        await pool.query('ALTER TABLE pos_shops ALTER COLUMN business_id SET NOT NULL');
        await pool.query(`CREATE TABLE IF NOT EXISTS pos_members (id SERIAL PRIMARY KEY, user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, business_id INT NOT NULL REFERENCES pos_businesses(id) ON DELETE CASCADE, branch_id INT REFERENCES pos_shops(id) ON DELETE CASCADE, role VARCHAR(10) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query(`INSERT INTO pos_members (user_id, business_id, branch_id, role) SELECT owner_id, id, NULL, 'owner' FROM pos_businesses ON CONFLICT (user_id) DO NOTHING`);
        for (const col of ['owner_id', 'tax_pin', 'receipt_footer']) await pool.query(`ALTER TABLE pos_shops DROP COLUMN IF EXISTS ${col}`);
    }
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_members (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            business_id INT NOT NULL REFERENCES pos_businesses(id) ON DELETE CASCADE,
            branch_id INT REFERENCES pos_shops(id) ON DELETE CASCADE,
            role VARCHAR(10) NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    await pool.query('CREATE INDEX IF NOT EXISTS pos_members_branch_idx ON pos_members (branch_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS pos_shops_business_idx ON pos_shops (business_id)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_sub_payments (
            id SERIAL PRIMARY KEY,
            business_id INT NOT NULL REFERENCES pos_businesses(id) ON DELETE CASCADE,
            months INT NOT NULL,
            amount INT NOT NULL,
            phone VARCHAR(20) NOT NULL,
            checkout_id VARCHAR(80),
            status VARCHAR(10) NOT NULL DEFAULT 'pending',
            receipt VARCHAR(40) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_query TIMESTAMPTZ
        )`);
    await pool.query('CREATE INDEX IF NOT EXISTS pos_sub_checkout_idx ON pos_sub_payments (checkout_id)');
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
            method VARCHAR(40) NOT NULL,
            mpesa_ref VARCHAR(40),
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
    for (const sql of T) await pool.query(sql);
    for (const sql of [
        `ALTER TABLE pos_sales ALTER COLUMN method TYPE VARCHAR(40)`,
        `ALTER TABLE pos_sales ALTER COLUMN mpesa_ref TYPE VARCHAR(40)`,
        `ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS vat_cents BIGINT NOT NULL DEFAULT 0`,
        `ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(4,1) NOT NULL DEFAULT 0`,
        `ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS user_id INT`,
        `ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS user_name VARCHAR(80) NOT NULL DEFAULT ''`,
        `CREATE TABLE IF NOT EXISTS pos_pay_methods (id SERIAL PRIMARY KEY, business_id INT NOT NULL REFERENCES pos_businesses(id) ON DELETE CASCADE, name VARCHAR(30) NOT NULL, needs_ref BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE (business_id, name))`,
        `CREATE TABLE IF NOT EXISTS pos_mpesa_requests (id VARCHAR(40) PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, user_id INT, user_name VARCHAR(80) NOT NULL DEFAULT '', lines JSONB NOT NULL, discount_cents BIGINT NOT NULL DEFAULT 0, total_cents BIGINT NOT NULL, phone VARCHAR(20) NOT NULL, checkout_id VARCHAR(80), status VARCHAR(10) NOT NULL DEFAULT 'pending', mpesa_receipt VARCHAR(20), sale_id INT, note VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_query TIMESTAMPTZ)`,
        `CREATE INDEX IF NOT EXISTS pos_mpesa_checkout_idx ON pos_mpesa_requests (checkout_id)`
    ]) await pool.query(sql);
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
const crypto = require('crypto');
// Payment credentials are stored encrypted. POS_SECRET_KEY is best (so changing SESSION_SECRET cannot lock them out).
const encKey = () => crypto.createHash('sha256').update('tencent-pos|' + (process.env.POS_SECRET_KEY || process.env.SESSION_SECRET || '')).digest();
function encrypt(obj) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}
function decrypt(text) {
    try {
        const [iv, tag, ct] = String(text).split('.').map(x => Buffer.from(x, 'base64'));
        const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv); d.setAuthTag(tag);
        return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
    } catch (_) { return null; }
}
const vatOf = (netCents, rate) => (rate > 0 ? Math.round(Number(netCents) * rate / 100) : 0);   // item prices are before VAT; VAT is added to the sale
const subFee = () => { const n = parseInt(process.env.POS_MONTHLY_FEE || '3000', 10); return n > 0 ? n : 3000; };
const branchFee = () => { const n = parseInt(process.env.POS_BRANCH_FEE || '2000', 10); return n > 0 ? n : 2000; };
const monthlyTotal = branches => subFee() + branchFee() * Math.max(0, branches - 1);   // main shop + each extra branch
const methodLabel = m => (m === 'mpesa' ? 'M-Pesa' : m === 'cash' ? 'Cash' : m);
const jsonForHtml = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
let _ctx = { getPool: null, platform: null };   // set by mountPos, used by the subscription callback hook

function mountPos({ app, getPool, esc, str, ah, rateLimit, requireAuth, requireDb, requireVerified, renderPage, platform }) {
    _ctx = { getPool, platform };
    const pool = () => getPool();
    const router = express.Router();
    const q = (text, params) => pool().query(text, params);

    // ----- layout -----
    function navFor(role) {
        if (role === 'cashier') return [['Main', [['terminal', '/pos/terminal', 'POS Terminal'], ['sales', '/pos/sales', 'My Sales'], ['drawer', '/pos/drawer', 'Cash Drawer']]], ['App', [['install', '/pos/install', 'Install App']]]];
        if (!role) return [['Admin', [['admin', '/pos/admin', 'All businesses']]]];
        const nav = [
            ['Main', [['app', '/pos/app', 'Dashboard'], ['terminal', '/pos/terminal', 'POS Terminal'], ['sales', '/pos/sales', 'Sales History'], ['daily', '/pos/daily', 'Daily Sales (Z-Report)'], ['drawer', '/pos/drawer', 'Cash Drawer'], ['quotes', '/pos/quotes', 'Quotes']]],
            ['Inventory', [['items', '/pos/items', 'Items'], ['categories', '/pos/categories', 'Categories'], ['stock', '/pos/stock', 'Stock In / Out & Adjustment'], ['history', '/pos/stock/history', 'Stock History'], ['low', '/pos/stock/low', 'Low Stock Alerts'], ['suppliers', '/pos/suppliers', 'Suppliers'], ['po', '/pos/purchase-orders', 'Purchase Orders']]],
            ['Money', [['expenses', '/pos/expenses', 'Expenses'], ['ecats', '/pos/expense-categories', 'Expense Categories'], ['recurring', '/pos/recurring', 'Recurring Expenses'], ['budgets', '/pos/budgets', 'Budgets'], ['assets', '/pos/assets', 'Assets'], ['reports', '/pos/reports', 'Reports'], ['notebook', '/pos/notebook', 'Notebook']]],
            ['This branch', [['staff', '/pos/staff', 'Cashiers & Staff'], ['settings', '/pos/settings', 'Branch Settings']]]
        ];
        if (role === 'owner') nav.push(['Business', [['branches', '/pos/branches', 'Branches'], ['bizreport', '/pos/business-report', 'All-branch Report'], ['payments', '/pos/payments', 'Payment Methods'], ['biz', '/pos/business', 'Business & Receipts'], ['sub', '/pos/subscribe', 'Subscription']]]);
        nav.push(['App', [['install', '/pos/install', 'Install App']]]);
        return nav;
    }
    function layout(req, { title, nav = '', body }) {
        const shop = req.shop, role = req.role;
        const links = navFor(role).map(([group, items]) => `<div class="nav-group">${esc(group)}</div>` +
            items.map(([key, href, label]) => `<a href="${href}" class="${nav === key ? 'active' : ''}">${esc(label)}</a>`).join('')).join('');
        const brand = shop && shop.has_logo ? `<a class="brand" href="/pos/app"><img src="/pos/logo?v=${shop.logo_ver}" alt="" style="max-height:44px;max-width:180px;display:block"></a>` : '<a class="brand" href="/pos/app">Tencent POS</a>';
        const switcher = role === 'owner' && req.branches && req.branches.length > 1 ? `<form action="/pos/branch/switch" method="POST" style="margin:0 0 6px"><label for="bsw" style="color:#7dd3fc;font-size:.72rem;padding:0 10px">Branch</label><select id="bsw" name="branch_id" style="margin:2px 10px 0;width:calc(100% - 20px);font-size:.85rem;padding:6px">${req.branches.map(b => `<option value="${b.id}" ${b.id === shop.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select><noscript><button class="btn small" type="submit" style="margin:4px 10px">Go</button></noscript></form>` : '';
        let banner = '';
        if (req.business && req.business.active_until) {
            const days = Math.ceil((new Date(req.business.active_until) - Date.now()) / 86400000);
            if (days >= 0 && days <= 5) banner = `<div class="alert noprint" role="status" style="background:#fffbeb;border-color:#fde68a;color:#92400e">Your subscription ends in ${days} day${days === 1 ? '' : 's'}.${role === 'owner' ? ' <a href="/pos/subscribe">Renew now</a>' : ' Please ask the owner to renew.'}</div>`;
        }
        return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(shop ? shop.name : 'Tencent POS')}</title>
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b1b2e">
<link rel="manifest" href="/pos/manifest.webmanifest"><link rel="apple-touch-icon" href="/pos/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Tencent POS">
<style>
:root{--bg:#f1f5f9;--panel:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--side:#0b1b2e;--side2:#12304d;--accent:#0ea5e9;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--radius:10px}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.45}
a{color:#0369a1}.side{position:fixed;inset:0 auto 0 0;width:236px;background:var(--side);color:#cbd5e1;overflow-y:auto;padding:14px 10px 24px;z-index:30}
.side .brand{display:block;color:#fff;font-weight:800;font-size:1.05rem;padding:6px 10px 2px;text-decoration:none}.side .shopname{padding:0 10px 10px;font-size:.82rem;color:#7dd3fc;border-bottom:1px solid #1e3a56;margin-bottom:6px}
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
.btn{display:inline-block;border:0;border-radius:8px;padding:9px 14px;background:var(--accent);color:#04223a;cursor:pointer;text-decoration:none;font:inherit;font-weight:700;font-size:.9rem}
.btn.dark{background:#0f172a;color:#fff}.btn.ok{background:var(--ok);color:#fff}.btn.bad{background:var(--bad);color:#fff}.btn.ghost{background:#fff;border:1px solid var(--line);color:var(--ink)}.btn.small{padding:5px 10px;font-size:.8rem}
.btn:disabled{opacity:.5;cursor:not-allowed}
label{display:block;font-weight:600;font-size:.85rem;margin:0 0 4px}input,select,textarea{width:100%;padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff;color:var(--ink)}
input:focus,select:focus,textarea:focus,.btn:focus-visible,a:focus-visible{outline:3px solid #7dd3fc;outline-offset:1px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.field{margin-bottom:14px}.field small{color:var(--muted)}
.alert{padding:11px 14px;border-radius:8px;margin-bottom:14px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b}.alert.ok{background:#f0fdf4;border-color:#bbf7d0;color:#166534}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:700}.tag.ok{background:#dcfce7;color:#166534}.tag.bad{background:#fee2e2;color:#991b1b}.tag.warn{background:#fef3c7;color:#92400e}.tag.gray{background:#e2e8f0;color:#334155}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.row>*{flex:1 1 150px}.row>.btn{flex:0 0 auto}
.muted{color:var(--muted)}.right{text-align:right}.nowrap{white-space:nowrap}
.pos-wrap{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start}
.pos-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}
.pos-item{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px;text-align:left;cursor:pointer;font:inherit;display:flex;flex-direction:column;gap:4px;min-height:84px}.pos-item:hover{border-color:var(--accent);box-shadow:0 0 0 2px #bae6fd}.pos-item b{font-size:.92rem}.pos-item .p{color:#0369a1;font-weight:800}.pos-item .s{font-size:.75rem;color:var(--muted)}.pos-item.out{opacity:.45}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 12px;cursor:pointer;font:inherit;font-size:.85rem}.chip.on{background:#0f172a;color:#fff;border-color:#0f172a}
.cart{position:sticky;top:12px}.cart .lines{max-height:34vh;overflow:auto;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:10px 0}.cline{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:8px 2px;border-bottom:1px solid var(--line)}.cline:last-child{border:0}.cline .qty{display:flex;align-items:center;gap:4px}.cline .qty button{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);background:#fff;cursor:pointer;font-size:1rem}
.tot{display:flex;justify-content:space-between;padding:3px 0}.tot.big{font-size:1.35rem;font-weight:800;border-top:2px solid var(--ink);margin-top:6px;padding-top:8px}
.pay{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}.pay button{padding:10px;border:2px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;font:inherit;font-weight:700}.pay button.on{border-color:var(--accent);background:#e0f2fe}
.modal{position:fixed;inset:0;background:rgba(2,6,23,.6);display:none;align-items:center;justify-content:center;z-index:50;padding:16px}.modal.show{display:flex}.modal .box{background:#fff;border-radius:14px;padding:22px;max-width:420px;width:100%;text-align:center}
@media(max-width:1000px){.pos-wrap{grid-template-columns:1fr}.cart{position:static}}
@media(max-width:860px){.side{transform:translateX(-100%);transition:transform .2s;width:260px}.side.open{transform:none}.main{margin-left:0;padding:14px 14px 60px}.top{display:flex;align-items:center;gap:12px;background:var(--side);color:#fff;margin:-14px -14px 14px;padding:10px 14px;position:sticky;top:0;z-index:20}.top button{background:none;border:1px solid #3b5878;color:#fff;border-radius:7px;padding:6px 12px;font-size:1.1rem;cursor:pointer}}
@media print{.side,.top,.noprint{display:none!important}.main{margin:0;padding:0}body{background:#fff}.panel{border:0;padding:0}}
</style></head><body>
<div class="top noprint"><button type="button" id="side-btn" aria-label="Open menu" aria-expanded="false">&#9776;</button><strong>${esc(shop ? shop.name : 'Tencent POS')}</strong><a href="/pos/install" id="install-top" class="btn small" style="margin-left:auto;text-decoration:none">Install app</a></div>
<nav class="side" id="side" aria-label="POS menu">
${brand}<div class="shopname">${esc(shop ? shop.name + (shop.branch ? ' · ' + shop.branch : '') : 'Platform admin')}${role ? ` <span class="tag gray" style="margin-left:4px">${esc(role)}</span>` : ''}</div>
${switcher}${links}
<div class="nav-group">Account</div><a href="/pos/install" id="install-btn">&#11015; Install this app</a><a href="/">Back to website</a>
<form action="/logout" method="POST"><button class="linkbtn" type="submit">Log out</button></form>
</nav>
<main class="main">${banner}${body}</main>
<script nonce="${req.nonce || ''}">
(function(){var b=document.getElementById('side-btn'),s=document.getElementById('side');if(b)b.addEventListener('click',function(){var o=s.classList.toggle('open');b.setAttribute('aria-expanded',o?'true':'false');});
var sw=document.getElementById('bsw');if(sw)sw.addEventListener('change',function(){sw.form.submit();});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/pos/sw.js',{scope:'/pos/'}).catch(function(){});
var dp=null,standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true;
if(standalone){['install-btn','install-top'].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display='none';});}
window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();dp=e;});
function go(ev){if(dp){ev.preventDefault();dp.prompt();dp=null;}}
['install-btn','install-top','install-main'].forEach(function(id){var e=document.getElementById(id);if(e)e.addEventListener('click',go);});
window.__tposInstall=function(){return !!dp;};
window.addEventListener('appinstalled',function(){['install-btn','install-top'].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display='none';});});})();
</script>
</body></html>`;
    }
    const send = (req, res, opts, status = 200) => res.status(status).set('Cache-Control', 'no-store').send(layout(req, opts));
    const notice = (req) => req.query.ok ? `<div class="alert ok" role="status">${esc(String(req.query.ok).slice(0, 160))}</div>` : '';
    const errBox = req => req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 200))}</div>` : '';
    const back = (res, path, ok, err) => res.redirect(path + '?' + (err ? 'err=' + encodeURIComponent(err) : 'ok=' + encodeURIComponent(ok)));

    // ----- public landing page for the service -----
    app.get('/pos', (req, res) => {
        const loggedIn = Boolean(req.session && req.session.user);
        const fee = subFee().toLocaleString('en-KE'), subBranch = branchFee().toLocaleString('en-KE');
        const content = `
        <div class="general-container">
            <h2>Tencent POS: a point of sale for your business</h2>
            <p class="sub-title">Sell faster, know your stock, and see your profit every day. Installs on any phone, tablet or computer like an app.</p>
            <div class="form-container" style="border-left:4px solid var(--primary);">
                <h3 style="margin-top:0;color:var(--primary);">What your business gets</h3>
                <ul style="line-height:1.8;padding-left:20px;margin-bottom:0;">
                    <li><strong>Your own business account</strong>, with linked <strong>branch accounts</strong> and as many <strong>cashier logins</strong> as each branch needs.</li>
                    <li><strong>Fast sales screen:</strong> tap items or scan barcodes. Take cash, M-Pesa STK push (using your own paybill or till), and other payment types you add.</li>
                    <li><strong>Receipts with your logo and business name</strong>, with the 16% VAT added and shown. Print or save as PDF.</li>
                    <li><strong>Stock control</strong> per branch: stock in and out, purchase orders, low-stock alerts, suppliers.</li>
                    <li><strong>Reports:</strong> daily closing report, profit, expenses, budgets, cash drawer, and an all-branch report for the owner.</li>
                    <li><strong>Private:</strong> each business only ever sees its own data.</li>
                </ul>
            </div>
            <div class="form-container" style="margin-top:20px;">
                <h3 style="margin-top:0;">Pricing</h3>
                <p><strong>KES ${fee} per month for your main shop</strong>, plus <strong>KES ${subBranch} per month for each extra branch</strong>. Cashiers are unlimited. Pay by M-Pesa from inside the app. When your payment is confirmed, the POS is switched on and you can install it on your devices.</p>
                <p>You enter prices before VAT. The POS adds 16% VAT at the sale, and the receipt shows the subtotal, the VAT and the total.</p>
                <a href="/pos/app" class="cta-btn">${loggedIn ? 'Open my POS' : 'Get started'}</a>
                <a href="/contact" class="cta-btn" style="margin-left:8px;">Ask us about setup & hardware</a>
            </div>
            <p class="muted" style="margin-top:14px;">${loggedIn ? '' : 'You will create a free account first and confirm your email. '}We can also supply and install barcode scanners, receipt printers, tablets and shop WiFi.</p>
        </div>`;
        res.send(renderPage(req, { title: 'POS System for Shops', activeNav: 'pos', content }));
    });

    // ----- public files that make the app installable -----
    const ICON192 = Buffer.from('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', 'base64'), ICON512 = Buffer.from('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', 'base64');
    router.get('/manifest.webmanifest', (req, res) => res.set({ 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' }).send(JSON.stringify({
        name: 'Tencent POS', short_name: 'Tencent POS', description: 'Point of sale for shops and branches', start_url: '/pos/app', scope: '/pos/', display: 'standalone',
        background_color: '#0b1b2e', theme_color: '#0b1b2e',
        icons: [{ src: '/pos/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/pos/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
    })));
    router.get('/icon-192.png', (req, res) => res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).send(ICON192));
    router.get('/icon-512.png', (req, res) => res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).send(ICON512));
    router.get('/offline', (req, res) => res.set('Cache-Control', 'public, max-age=3600').send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><style>body{font-family:system-ui,sans-serif;background:#0b1b2e;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:20px}button{padding:12px 20px;border:0;border-radius:8px;background:#0ea5e9;font-weight:700;font-size:1rem;cursor:pointer}</style></head><body><div><h1>You are offline</h1><p>Tencent POS needs the internet to save sales safely. Reconnect and try again.</p><button onclick="location.reload()">Try again</button></div></body></html>'));
    router.get('/sw.js', (req, res) => res.set({ 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/pos/' }).send(
`const V='tpos-1';
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.add('/pos/offline')).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match('/pos/offline')));}});`));

    // ----- M-Pesa callback from a business's own paybill/till (public; the secret token in the URL identifies the business) -----
    router.post('/mpesa/cb/:token', (req, res) => {
        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
        handleStkCallback(String(req.params.token || ''), req.body).catch(err => console.error('POS M-Pesa callback error:', err.message));
    });

    // ----- everything below needs a confirmed, signed-in account -----
    router.use(requireAuth, requireDb, requireVerified);

    const isAdmin = req => Boolean(platform && platform.adminEmails && req.session.user.email && platform.adminEmails.includes(String(req.session.user.email).toLowerCase()));

    // ----- platform admin (us): see businesses, grant months, suspend -----
    router.get('/admin', ah(async (req, res) => {
        if (!isAdmin(req)) return send(req, res, { title: 'Not allowed', body: '<h1>Not allowed</h1>' }, 403);
        const r = await q(`SELECT b.id, b.name, b.active_until, b.suspended, b.created_at, u.name AS owner, u.email, u.phone, (SELECT count(*) FROM pos_shops s WHERE s.business_id=b.id)::int branches, (SELECT count(*) FROM pos_members m WHERE m.business_id=b.id AND m.role='cashier')::int cashiers FROM pos_businesses b JOIN users u ON u.id=b.owner_id ORDER BY b.created_at DESC LIMIT 500`);
        send(req, res, { title: 'All businesses', nav: 'admin', body: `<h1>All POS businesses</h1>${notice(req)}${errBox(req)}<div class="panel tablewrap"><table><tr><th>Business</th><th>Owner</th><th>Branches / cashiers</th><th>Paid until</th><th></th></tr>${r.rows.map(b => { const live = b.active_until && new Date(b.active_until) > new Date(); return `<tr><td>${esc(b.name)}${b.suspended ? ' <span class="tag bad">suspended</span>' : ''}</td><td>${esc(b.owner)}<br><small class="muted">${esc(b.email)} ${esc(b.phone)}</small></td><td>${b.branches} / ${b.cashiers}</td><td>${b.active_until ? esc(dateFmt(b.active_until)) : '-'} <span class="tag ${live ? 'ok' : 'warn'}">${live ? 'active' : 'not active'}</span></td><td class="right nowrap"><form action="/pos/admin/${b.id}/grant" method="POST" style="display:inline"><select name="months" style="width:auto;display:inline-block"><option>1</option><option>3</option><option>6</option><option>12</option></select> <button class="btn small ok" type="submit">Add months</button></form> <form action="/pos/admin/${b.id}/suspend" method="POST" style="display:inline"><button class="btn small ghost" type="submit">${b.suspended ? 'Unsuspend' : 'Suspend'}</button></form></td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">No businesses yet.</td></tr>'}</table><p class="muted">Use "Add months" when a customer pays you by cash or another route.</p></div>` });
    }));
    router.post('/admin/:id/grant', ah(async (req, res) => {
        if (!isAdmin(req)) return res.sendStatus(403);
        const id = parseCount(req.params.id, { min: 1 }), months = parseCount(req.body.months, { min: 1, max: 24 });
        if (id && months) await q(`UPDATE pos_businesses SET active_until = GREATEST(COALESCE(active_until, now()), now()) + ($2 || ' months')::interval WHERE id=$1`, [id, String(months)]);
        back(res, '/pos/admin', 'Months added.');
    }));
    router.post('/admin/:id/suspend', ah(async (req, res) => {
        if (!isAdmin(req)) return res.sendStatus(403);
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('UPDATE pos_businesses SET suspended = NOT suspended WHERE id=$1', [id]);
        back(res, '/pos/admin', 'Updated.');
    }));

    // ----- first-time setup: create the business and its first branch -----
    const memberOf = async uid => (await q('SELECT 1 FROM pos_members WHERE user_id=$1', [uid])).rowCount > 0;
    const setupForm = (req, error = '', v = {}) => `
        <h1>Set up your business</h1>
        <div class="panel" style="max-width:560px;">
            ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
            <p class="muted">This creates your business account and your first branch. You can add more branches and cashiers afterwards. The POS switches on once the monthly subscription (KES ${subFee().toLocaleString('en-KE')} for the main shop, KES ${branchFee().toLocaleString('en-KE')} for each extra branch) is paid.</p>
            <form action="/pos/setup" method="POST">
                <div class="field"><label for="n">Business name</label><input id="n" name="name" required maxlength="120" value="${esc(v.name || '')}" placeholder="e.g. Mama Achieng Stores"><small>This is the name printed on your receipts.</small></div>
                <div class="field"><label for="p">Phone</label><input id="p" name="phone" maxlength="40" value="${esc(v.phone || req.session.user.phone || '')}"></div>
                <div class="field"><label for="a">Address / location of your first branch</label><input id="a" name="address" maxlength="200" value="${esc(v.address || '')}" placeholder="e.g. Rangwe Market"></div>
                <button class="btn" type="submit">Create my business</button>
            </form>
        </div>`;
    router.get('/setup', ah(async (req, res) => {
        if (await memberOf(req.session.user.id)) return res.redirect('/pos/app');
        send(req, res, { title: 'Set up your business', body: setupForm(req) });
    }));
    router.post('/setup', ah(async (req, res) => {
        if (await memberOf(req.session.user.id)) return res.redirect('/pos/app');
        const v = { name: str(req.body.name).slice(0, 120), phone: str(req.body.phone).slice(0, 40), address: str(req.body.address).slice(0, 200) };
        if (v.name.length < 2) return send(req, res, { title: 'Set up your business', body: setupForm(req, 'Please enter your business name.', v) }, 400);
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const b = (await client.query('INSERT INTO pos_businesses (owner_id, name, cb_token) VALUES ($1,$2,$3) RETURNING id', [req.session.user.id, v.name, crypto.randomBytes(24).toString('hex')])).rows[0];
            await client.query('INSERT INTO pos_shops (business_id, name, phone, address) VALUES ($1,$2,$3,$4)', [b.id, 'Main Branch', v.phone, v.address]);
            await client.query(`INSERT INTO pos_members (user_id, business_id, branch_id, role) VALUES ($1,$2,NULL,'owner')`, [req.session.user.id, b.id]);
            await client.query('COMMIT');
        } catch (err) { await client.query('ROLLBACK').catch(() => {}); if (err.code !== '23505') throw err; } finally { client.release(); }
        res.redirect('/pos/subscribe');
    }));

    // ----- who is this, which business and branch, is it paid up, and are they allowed on this page -----
    router.use(ah(async (req, res, next) => {
        const me = (await q(`SELECT m.role, m.branch_id, m.active AS member_active, b.id AS business_id, b.name AS business_name, b.tax_pin, b.receipt_footer, b.vat_rate, b.logo_ver, (b.logo IS NOT NULL) AS has_logo, b.active_until, b.suspended, (b.mpesa_enc IS NOT NULL) AS has_mpesa FROM pos_members m JOIN pos_businesses b ON b.id = m.business_id WHERE m.user_id = $1`, [req.session.user.id])).rows[0];
        if (!me) return res.redirect('/pos/setup');
        req.role = me.role;
        req.business = { id: me.business_id, name: me.business_name, active_until: me.active_until, has_mpesa: me.has_mpesa };
        const blocked = (title, msg) => send(req, res, { title, body: `<h1>${esc(title)}</h1><div class="panel"><p>${msg}</p></div>` }, 403);
        if (!me.member_active) return blocked('Your login is switched off', 'Please ask the business owner to switch your account back on.');
        if (me.suspended) return blocked('Account paused', 'This POS account is paused. Please contact Tencent Innovations on 0740 311 014.');
        const branches = me.role === 'owner'
            ? (await q('SELECT * FROM pos_shops WHERE business_id=$1 AND active ORDER BY id', [me.business_id])).rows
            : (await q('SELECT * FROM pos_shops WHERE id=$1 AND business_id=$2 AND active', [me.branch_id, me.business_id])).rows;
        if (!branches.length) return blocked('Branch not available', 'Your branch is switched off. Please contact the business owner.');
        req.branches = branches;
        const branch = (me.role === 'owner' && branches.find(b => b.id === req.session.posBranch)) || branches[0];
        req.me = { id: req.session.user.id, name: req.session.user.name };
        req.shop = { id: branch.id, business_id: me.business_id, name: me.business_name, branch: branch.name, phone: branch.phone, address: branch.address, tax_pin: me.tax_pin, receipt_footer: me.receipt_footer, vat_rate: Number(me.vat_rate), has_logo: me.has_logo, logo_ver: me.logo_ver };

        // subscription gate: until it is paid, only the payment page opens
        const live = me.active_until && new Date(me.active_until) > new Date();
        const p = req.path;
        if (!live && !/^\/(subscribe|install|logo)(\/|$)/.test(p)) {
            if (me.role === 'owner') return res.redirect('/pos/subscribe');
            return blocked('Subscription ended', 'This business\'s POS subscription has ended. Please ask the owner to renew it.');
        }
        // what each role may open
        if (me.role === 'cashier') {
            const ok = /^\/(terminal|drawer|drawer\/(open|move|close)|sales|api\/items|api\/sales|api\/mpesa\/push|api\/mpesa\/status\/[A-Za-z0-9]+|logo|install)$/.test(p) || /^\/sales\/\d+\/receipt$/.test(p);
            if (p === '/app') return res.redirect('/pos/terminal');
            if (!ok) return blocked('Not allowed', 'Cashiers can use the POS Terminal, their own sales and the cash drawer. Please ask a manager.');
        } else if (me.role === 'manager' && /^\/(business|branches|payments|subscribe|business-report|branch\/switch)/.test(p)) {
            return blocked('Not allowed', 'Only the business owner can open this page.');
        }
        if (me.role !== 'cashier') await runRecurring(branch.id).catch(e => console.error('Recurring expenses failed:', e.message));
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
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Item</th><th>Category</th><th>Barcode</th><th class="num">Price (before VAT)</th><th class="num">Cost</th><th class="num">Stock</th><th></th></tr>${r.rows.map(i => `<tr><td>${esc(i.name)}${i.active ? '' : ' <span class="tag gray">archived</span>'}</td><td>${esc(i.cat || '')}</td><td>${esc(i.barcode || '')}</td><td class="num">${fmt(i.price_cents)}</td><td class="num">${fmt(i.cost_cents)}</td><td class="num">${i.track_stock ? `<span class="tag ${i.stock <= 0 ? 'bad' : i.stock <= i.reorder_level ? 'warn' : 'ok'}">${i.stock}</span>` : '<span class="muted">not tracked</span>'}</td><td class="right nowrap"><a class="btn small ghost" href="/pos/items/${i.id}/edit">Edit</a></td></tr>`).join('')}</table>` : '<p class="muted">No items found. <a href="/pos/items/new">Add your first item</a>.</p>'}</div>`;
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
                <div class="field"><label for="p">Selling price before VAT (KES)</label><input id="p" name="price" required inputmode="decimal" value="${esc(priceVal)}" placeholder="e.g. 150"></div>
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

    // ----- payments: sale creation shared by cash/code/STK -----
    const saleLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait a moment.' } });
    const payMethods = async bizId => (await q('SELECT id, name, needs_ref FROM pos_pay_methods WHERE business_id=$1 ORDER BY name', [bizId])).rows;

    // shop = { id, name, vat_rate }; want = Map(itemId -> qty). Prices always come from the database.
    async function createSale({ shop, user, want, discountIn, label, tendered, ref, phone, prepaid }) {
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const ids = [...want.keys()];
            const found = (await client.query('SELECT id, name, price_cents, cost_cents, stock, track_stock FROM pos_items WHERE shop_id=$1 AND active AND id = ANY($2::int[]) ORDER BY id FOR UPDATE', [shop.id, ids])).rows;
            if (found.length !== ids.length) { await client.query('ROLLBACK'); return { error: 'An item in the cart is no longer available. Refresh and try again.', code: 409 }; }
            let subtotal = 0;
            for (const it of found) {
                const qty = want.get(it.id);
                if (it.track_stock && it.stock < qty) { await client.query('ROLLBACK'); return { error: `Not enough stock for "${it.name}": ${it.stock} left.`, code: 409 }; }
                subtotal += Number(it.price_cents) * qty;
            }
            const discount = Math.min(discountIn, subtotal), net = subtotal - discount;
            const rate = Number(shop.vat_rate) || 0, vat = vatOf(net, rate), total = net + vat;
            let paid = total, change = 0;
            if (label === 'cash') {
                if (tendered === null || tendered < total) { await client.query('ROLLBACK'); return { error: 'The cash received is less than the total.', code: 400 }; }
                paid = tendered; change = tendered - total;
            }
            const no = (await client.query('UPDATE pos_shops SET next_receipt = next_receipt + 1 WHERE id=$1 RETURNING next_receipt - 1 AS no', [shop.id])).rows[0].no;
            const sale = (await client.query(`INSERT INTO pos_sales (shop_id, receipt_no, subtotal_cents, discount_cents, total_cents, paid_cents, change_cents, method, mpesa_ref, customer_phone, vat_cents, vat_rate, user_id, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
                [shop.id, no, subtotal, discount, total, paid, change, label, ref || null, phone || '', vat, rate, user.id, String(user.name || '').slice(0, 80)])).rows[0];
            for (const it of found) {
                const qty = want.get(it.id);
                await client.query('INSERT INTO pos_sale_items (sale_id, item_id, name, qty, unit_price_cents, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6)', [sale.id, it.id, it.name, qty, it.price_cents, it.cost_cents]);
                if (it.track_stock) {
                    const nb = it.stock - qty;
                    await client.query('UPDATE pos_items SET stock=$2 WHERE id=$1', [it.id, nb]);
                    await client.query(`INSERT INTO pos_stock_moves (shop_id, item_id, change, balance, reason, note, sale_id) VALUES ($1,$2,$3,$4,'sale',$5,$6)`, [shop.id, it.id, -qty, nb, 'Receipt #' + no, sale.id]);
                }
            }
            await client.query('COMMIT');
            let whatsapp = '';
            if (phone) whatsapp = `https://wa.me/${phone}?text=${encodeURIComponent(`Thank you for shopping at ${shop.name}. Receipt #${no}: KES ${fmt(total)} paid by ${methodLabel(label)}.`)}`;
            return { ok: true, saleId: sale.id, receiptNo: no, total, change, receiptUrl: `/pos/sales/${sale.id}/receipt`, whatsapp };
        } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    }
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
    const cleanPhone = raw => { const p = platform.normalizePhone(String(raw || '')); return p || ''; };

    router.post('/api/sales', saleLimiter, ah(async (req, res) => {
        const bad = (m, code = 400) => res.status(code).json({ error: m });
        const b = req.body || {};
        const cart = readCart(b);
        if (cart.error) return bad(cart.error);
        const key = String(b.method || ''), ref = String(b.ref || b.mpesaRef || '').trim();
        let label = '', refOut = '';
        if (key === 'cash') label = 'cash';
        else if (key === 'mpesa') {
            if (!/^[A-Za-z0-9]{8,14}$/.test(ref)) return bad('Enter the M-Pesa code from the customer\'s SMS.');
            label = 'mpesa'; refOut = ref.toUpperCase();
        } else if (/^m:\d+$/.test(key)) {
            const m = (await q('SELECT name, needs_ref FROM pos_pay_methods WHERE id=$1 AND business_id=$2', [Number(key.slice(2)), req.shop.business_id])).rows[0];
            if (!m) return bad('That payment method is not available.');
            if (m.needs_ref && !/^[A-Za-z0-9 _.\/-]{3,30}$/.test(ref)) return bad(`Enter the ${m.name} reference or transaction number.`);
            label = m.name; refOut = m.needs_ref ? ref : '';
        } else return bad('Choose how the customer is paying.');
        const phoneRaw = String(b.customerPhone || '').trim();
        const phone = phoneRaw ? cleanPhone(phoneRaw) : '';
        if (phoneRaw && !phone) return bad('The customer phone number is not valid.');
        const tendered = label === 'cash' ? (String(b.tendered || '').trim() === '' ? null : parseMoney(b.tendered)) : null;
        const r = await createSale({ shop: req.shop, user: req.me, want: cart.want, discountIn: cart.discountIn, label, tendered, ref: refOut, phone });
        if (r.error) return bad(r.error, r.code);
        res.json(r);
    }));

    // ----- M-Pesa STK push with the business's own credentials -----
    async function mpesaCreds(bizId) {
        const r = (await q('SELECT mpesa_enc, mpesa_type, cb_token FROM pos_businesses WHERE id=$1', [bizId])).rows[0];
        if (!r || !r.mpesa_enc) return null;
        const c = decrypt(r.mpesa_enc);
        return c ? { ...c, type: r.mpesa_type || 'paybill', cbToken: r.cb_token } : null;
    }
    const tokenCache = new Map();
    async function darajaToken(bizId, c, fresh) {
        const hit = tokenCache.get(bizId);
        if (!fresh && hit && hit.exp > Date.now()) return hit.value;
        const resp = await fetch(`${platform.darajaBase}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: 'Basic ' + Buffer.from(`${c.key}:${c.secret}`).toString('base64') }, signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`Safaricom rejected the consumer key/secret (HTTP ${resp.status}). Check them in Payment Methods.`);
        const d = await resp.json();
        tokenCache.set(bizId, { value: d.access_token, exp: Date.now() + (Number(d.expires_in || 3599) - 60) * 1000 });
        return d.access_token;
    }
    async function darajaCall(bizId, c, apiPath, payload) {
        const go = async fresh => fetch(`${platform.darajaBase}${apiPath}`, { method: 'POST', headers: { Authorization: 'Bearer ' + await darajaToken(bizId, c, fresh), 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
        let resp = await go(false);
        if (resp.status === 401) resp = await go(true);
        let d = {}; try { d = await resp.json(); } catch (_) { /* not JSON */ }
        if (!resp.ok) throw new Error(d.errorMessage || d.ResultDesc || `Safaricom error (HTTP ${resp.status})`);
        return d;
    }
    const darajaStamp = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
    async function stkQueryFor(bizId, c, checkoutId) {
        const ts = darajaStamp();
        return darajaCall(bizId, c, '/mpesa/stkpushquery/v1/query', { BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.passkey + ts).toString('base64'), Timestamp: ts, CheckoutRequestID: checkoutId });
    }

    router.post('/api/mpesa/push', saleLimiter, ah(async (req, res) => {
        const bad = (m, code = 400) => res.status(code).json({ error: m });
        const b = req.body || {};
        const c = await mpesaCreds(req.shop.business_id);
        if (!c) return bad('M-Pesa STK push is not set up for this business yet. The owner can add it under Payment Methods.');
        if (!String(platform.publicBaseUrl || '').startsWith('https://')) return bad('The website address (PUBLIC_BASE_URL) is not set, so M-Pesa cannot call back.');
        const cart = readCart(b);
        if (cart.error) return bad(cart.error);
        const phone = platform.normalizePhone(String(b.phone || ''));
        if (!phone) return bad('Enter the customer\'s M-Pesa number, for example 0712345678.');
        const found = (await q('SELECT id, name, price_cents, stock, track_stock FROM pos_items WHERE shop_id=$1 AND active AND id = ANY($2::int[])', [req.shop.id, [...cart.want.keys()]])).rows;
        if (found.length !== cart.want.size) return bad('An item in the cart is no longer available. Refresh and try again.', 409);
        let subtotal = 0;
        for (const it of found) {
            const qty = cart.want.get(it.id);
            if (it.track_stock && it.stock < qty) return bad(`Not enough stock for "${it.name}": ${it.stock} left.`, 409);
            subtotal += Number(it.price_cents) * qty;
        }
        const net = subtotal - Math.min(cart.discountIn, subtotal), total = net + vatOf(net, req.shop.vat_rate);
        if (total < 100 || total % 100 !== 0) return bad(`M-Pesa takes whole shillings only. The total is KES ${fmt(total)}: use the Discount box to round it.`);
        const id = crypto.randomBytes(16).toString('hex');
        await q('INSERT INTO pos_mpesa_requests (id, shop_id, user_id, user_name, lines, discount_cents, total_cents, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [id, req.shop.id, req.me.id, String(req.me.name || '').slice(0, 80), JSON.stringify([...cart.want].map(([i, n]) => ({ id: i, qty: n }))), Math.min(cart.discountIn, subtotal), total, phone]);
        try {
            const ts = darajaStamp();
            const d = await darajaCall(req.shop.business_id, c, '/mpesa/stkpush/v1/processrequest', {
                BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.passkey + ts).toString('base64'), Timestamp: ts,
                TransactionType: c.type === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
                Amount: total / 100, PartyA: phone, PartyB: c.till || c.shortcode, PhoneNumber: phone,
                CallBackURL: `${platform.publicBaseUrl}/pos/mpesa/cb/${c.cbToken}`,
                AccountReference: String(req.shop.name).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 12) || 'Sale', TransactionDesc: 'Purchase'
            });
            if (String(d.ResponseCode) !== '0') throw new Error(d.ResponseDescription || 'The request was rejected.');
            await q('UPDATE pos_mpesa_requests SET checkout_id=$2 WHERE id=$1', [id, String(d.CheckoutRequestID || '')]);
            res.json({ ok: true, id });
        } catch (err) {
            await q(`UPDATE pos_mpesa_requests SET status='failed', note=$2 WHERE id=$1`, [id, String(err.message).slice(0, 190)]);
            console.error('POS STK push failed:', err.message);
            bad('Could not send the M-Pesa request: ' + String(err.message).slice(0, 150), 502);
        }
    }));

    async function finalizeMpesa(id, receipt) {
        const row = (await q(`UPDATE pos_mpesa_requests SET status='paid', mpesa_receipt=$2 WHERE id=$1 AND status='pending' RETURNING *`, [id, receipt || null])).rows[0];
        if (!row) return;
        const shop = (await q('SELECT s.id, b.name, b.vat_rate FROM pos_shops s JOIN pos_businesses b ON b.id = s.business_id WHERE s.id=$1', [row.shop_id])).rows[0];
        const want = new Map(row.lines.map(l => [l.id, l.qty]));
        const r = await createSale({ shop, user: { id: row.user_id, name: row.user_name }, want, discountIn: Number(row.discount_cents), label: 'mpesa', ref: receipt || null, phone: row.phone });
        if (r.ok) await q('UPDATE pos_mpesa_requests SET sale_id=$2 WHERE id=$1', [id, r.saleId]);
        else {
            await q(`UPDATE pos_mpesa_requests SET status='review', note=$2 WHERE id=$1`, [id, ('Money received' + (receipt ? ` (${receipt})` : '') + ' but the sale could not be saved: ' + r.error).slice(0, 190)]);
            if (platform.notify) platform.notify('⚠️ POS: M-Pesa paid but sale not saved', { Business: shop.name, 'M-Pesa receipt': receipt || '-', Reason: r.error }).catch(() => {});
        }
    }
    async function handleStkCallback(token, body) {
        const cb = body && body.Body && body.Body.stkCallback;
        if (!cb || !token) return;
        const r = (await q(`SELECT r.* FROM pos_mpesa_requests r JOIN pos_shops s ON s.id = r.shop_id JOIN pos_businesses b ON b.id = s.business_id WHERE r.checkout_id=$1 AND b.cb_token=$2`, [String(cb.CheckoutRequestID || ''), token])).rows[0];
        if (!r || r.status !== 'pending') return;
        if (Number(cb.ResultCode) !== 0) { await q(`UPDATE pos_mpesa_requests SET status='failed', note=$2 WHERE id=$1 AND status='pending'`, [r.id, String(cb.ResultDesc || 'Not completed').slice(0, 190)]); return; }
        const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
        const meta = n => { const it = items.find(i => i.Name === n); return it ? it.Value : undefined; };
        if (Math.round(Number(meta('Amount')) * 100) !== Number(r.total_cents)) {
            await q(`UPDATE pos_mpesa_requests SET status='review', note=$2 WHERE id=$1 AND status='pending'`, [r.id, `Amount mismatch: customer paid ${meta('Amount')}`]);
            return;
        }
        await finalizeMpesa(r.id, String(meta('MpesaReceiptNumber') || '').slice(0, 20));
    }
    router.get('/api/mpesa/status/:id', ah(async (req, res) => {
        const id = String(req.params.id || '');
        const loadRow = async () => (await q(`SELECT r.*, s.receipt_no FROM pos_mpesa_requests r LEFT JOIN pos_sales s ON s.id = r.sale_id WHERE r.id=$1 AND r.shop_id=$2 ${req.role === 'cashier' ? 'AND r.user_id=$3' : ''}`, req.role === 'cashier' ? [id, req.shop.id, req.me.id] : [id, req.shop.id])).rows[0];
        let r = await loadRow();
        if (!r) return res.status(404).json({ status: 'unknown' });
        if (r.status === 'pending' && r.checkout_id && Date.now() - new Date(r.created_at) > 20000 && (!r.last_query || Date.now() - new Date(r.last_query) > 10000)) {
            await q('UPDATE pos_mpesa_requests SET last_query=now() WHERE id=$1', [id]);
            try {
                const c = await mpesaCreds(req.shop.business_id);
                const d = c && await stkQueryFor(req.shop.business_id, c, r.checkout_id);
                if (d && String(d.ResultCode) === '0') await finalizeMpesa(id, '');
                else if (d && d.ResultCode !== undefined && String(d.ResultCode) !== '') await q(`UPDATE pos_mpesa_requests SET status='failed', note=$2 WHERE id=$1 AND status='pending'`, [id, String(d.ResultDesc || 'Not completed').slice(0, 190)]);
            } catch (_) { /* still processing */ }
            r = await loadRow();
        }
        if (r.status === 'paid' && !r.sale_id) return res.json({ status: 'pending' });
        res.json({ status: r.status, error: r.note, receiptNo: r.receipt_no, total: Number(r.total_cents), receiptUrl: r.sale_id ? `/pos/sales/${r.sale_id}/receipt` : '' });
    }));

    // ----- POS terminal -----
    router.get('/api/items', ah(async (req, res) => {
        const r = await q(`SELECT i.id, i.name, i.barcode, i.price_cents, i.stock, i.track_stock, c.name AS category FROM pos_items i LEFT JOIN pos_categories c ON c.id = i.category_id WHERE i.shop_id=$1 AND i.active ORDER BY i.name LIMIT 2000`, [req.shop.id]);
        res.set('Cache-Control', 'no-store').json(r.rows.map(i => ({ id: i.id, name: i.name, barcode: i.barcode || '', price: i.price_cents, stock: i.track_stock ? i.stock : null, category: i.category || '' })));
    }));
    router.get('/terminal', ah(async (req, res) => {
        const cfg = { stk: Boolean(req.business.has_mpesa), vat: req.shop.vat_rate, methods: (await payMethods(req.shop.business_id)).map(m => ({ id: m.id, name: m.name, needsRef: m.needs_ref })) };
        const body = `<h1 class="noprint">POS Terminal <small class="muted" style="font-size:.9rem">${esc(req.shop.branch)}</small></h1>
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
                <div class="tot" id="vatrow"><span id="vatlbl">VAT</span><span id="vat">0.00</span></div>
                <div class="tot big"><span>Total</span><span id="total">0.00</span></div>
                <div class="pay" id="paybtns"></div>
                <div id="cashbox" class="field"><label for="tender">Cash received (KES)</label><input id="tender" inputmode="decimal" placeholder="0"><div class="tot" style="margin-top:6px"><span>Change</span><b id="change">0.00</b></div></div>
                <div id="stkbox" class="field" style="display:none"><label for="sphone">Customer's M-Pesa number</label><input id="sphone" type="tel" inputmode="tel" placeholder="0712345678"><small>The customer gets a prompt on their phone and enters their PIN.</small></div>
                <div id="refbox" class="field" style="display:none"><label for="mref" id="reflbl">Reference</label><input id="mref" maxlength="30" autocapitalize="characters"></div>
                <div class="field" id="cpbox"><label for="cphone">Customer phone (optional, to share the receipt)</label><input id="cphone" type="tel" placeholder="0712345678"></div>
                <div id="err" class="alert" role="alert" style="display:none"></div>
                <div id="wait" class="alert ok" role="status" style="display:none"></div>
                <button class="btn ok" id="done" type="button" style="width:100%;padding:13px;font-size:1rem" disabled>Complete sale</button>
                <button class="btn ghost" id="clear" type="button" style="width:100%;margin-top:8px">Clear sale</button>
            </div>
        </div>
        <div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="mtitle"><div class="box"><h2 id="mtitle">Sale complete</h2><p id="mtext" style="font-size:1.1rem"></p>
            <div class="row" style="justify-content:center"><a class="btn" id="mprint" target="_blank" rel="noopener">Print receipt</a><a class="btn ghost" id="mwa" target="_blank" rel="noopener" style="display:none">Send on WhatsApp</a></div>
            <button class="btn ok" id="mnew" type="button" style="margin-top:14px;width:100%">New sale</button></div></div>
        <script nonce="${req.nonce || ''}">
        (function () {
            var CFG = ${jsonForHtml(cfg)};
            var items = [], cart = [], cat = '', method = 'cash', busy = false, pollId = 0;
            var $ = function (id) { return document.getElementById(id); };
            function fmt(c) { return (c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
            function money(v) { var s = String(v || '').replace(/,/g, '').trim(); if (!/^\\d{1,9}(\\.\\d{1,2})?$/.test(s)) return 0; return Math.round(parseFloat(s) * 100); }
            function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
            function showErr(m) { var e = $('err'); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; }
            function showWait(m) { var e = $('wait'); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; }
            var METHODS = [{ k: 'cash', n: 'Cash' }];
            if (CFG.stk) { METHODS.push({ k: 'stk', n: 'M-Pesa (STK push)' }); METHODS.push({ k: 'mpesa', n: 'M-Pesa code' }); } else METHODS.push({ k: 'mpesa', n: 'M-Pesa' });
            CFG.methods.forEach(function (m) { METHODS.push({ k: 'm:' + m.id, n: m.name, needsRef: m.needsRef }); });
            function drawMethods() {
                var box = $('paybtns'); box.textContent = '';
                METHODS.forEach(function (m) { var b = el('button', m.k === method ? 'on' : '', m.n); b.type = 'button'; b.addEventListener('click', function () { setMethod(m.k); }); box.appendChild(b); });
            }
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
            function totals() { var s = 0; cart.forEach(function (l) { s += l.price * l.qty; }); var d = Math.min(money($('disc').value), s); var net = s - d, v = CFG.vat > 0 ? Math.round(net * CFG.vat / 100) : 0; return { sub: s, disc: d, total: net + v, vat: v }; }
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
                var t = totals(); $('sub').textContent = fmt(t.sub); $('total').textContent = fmt(t.total);
                $('vatrow').style.display = CFG.vat > 0 ? '' : 'none'; $('vatlbl').textContent = 'VAT (' + CFG.vat + '%)'; $('vat').textContent = fmt(t.vat);
                var tend = money($('tender').value); $('change').textContent = fmt(Math.max(0, tend - t.total));
                $('done').disabled = busy || !cart.length;
                $('done').textContent = method === 'stk' ? 'Send M-Pesa request' : 'Complete sale';
            }
            function setMethod(m) {
                method = m; pollId++; busy = false; showWait(''); showErr('');
                var def = METHODS.filter(function (x) { return x.k === m; })[0] || {};
                $('cashbox').style.display = m === 'cash' ? '' : 'none'; $('stkbox').style.display = m === 'stk' ? '' : 'none';
                var needRef = m === 'mpesa' || (m.indexOf('m:') === 0 && def.needsRef); $('refbox').style.display = needRef ? '' : 'none';
                $('reflbl').textContent = m === 'mpesa' ? 'M-Pesa code (from the customer\\'s SMS)' : (def.n || '') + ' reference / transaction number';
                $('cpbox').style.display = m === 'stk' ? 'none' : '';
                drawMethods(); render();
            }
            function reset() { pollId++; busy = false; cart = []; $('disc').value = ''; $('tender').value = ''; $('mref').value = ''; $('cphone').value = ''; $('sphone').value = ''; showErr(''); showWait(''); setMethod('cash'); $('find').value = ''; draw(); load(); $('find').focus(); }
            function success(d, phone) {
                $('mtext').textContent = 'Receipt #' + d.receiptNo + ' - KES ' + fmt(d.total) + (d.change ? ' - Change KES ' + fmt(d.change) : '');
                $('mprint').href = d.receiptUrl; var wa = $('mwa'); if (d.whatsapp) { wa.href = d.whatsapp; wa.style.display = ''; } else wa.style.display = 'none';
                $('modal').classList.add('show'); $('mnew').focus();
            }
            function post(url, body) { return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }); }
            function linesBody() { return cart.map(function (l) { return { id: l.id, qty: l.qty }; }); }
            function startStk() {
                var t = totals();
                if (t.total < 100 || t.total % 100 !== 0) { showErr('M-Pesa takes whole shillings only. Use the Discount box to round the total (now ' + fmt(t.total) + ').'); return; }
                busy = true; render(); $('done').disabled = true; showErr(''); showWait('Sending the request to the customer\\'s phone...');
                var my = ++pollId;
                post('/pos/api/mpesa/push', { lines: linesBody(), discount: $('disc').value, phone: $('sphone').value.trim() }).then(function (x) {
                    if (!x.ok) { busy = false; showWait(''); showErr(x.d.error || 'Could not send the request.'); render(); return; }
                    showWait('Waiting for the customer to enter their M-Pesa PIN...');
                    var tries = 0;
                    (function poll() {
                        if (my !== pollId) return;
                        if (++tries > 60) { busy = false; showWait(''); showErr('No confirmation yet. If the customer paid, the sale will appear in Sales History. Do not charge them twice.'); render(); return; }
                        fetch('/pos/api/mpesa/status/' + x.d.id, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
                            if (my !== pollId) return;
                            if (s.status === 'paid' && s.receiptUrl) { busy = false; showWait(''); success({ receiptNo: s.receiptNo, total: s.total, receiptUrl: s.receiptUrl }); return; }
                            if (s.status === 'failed' || s.status === 'review') { busy = false; showWait(''); showErr(s.status === 'failed' ? 'The payment was not completed: ' + (s.error || 'cancelled or timed out.') : (s.error || 'Please check this payment with the owner.')); render(); return; }
                            setTimeout(poll, 3000);
                        }).catch(function () { setTimeout(poll, 4000); });
                    })();
                }).catch(function () { busy = false; showWait(''); showErr('Connection problem. Try again.'); render(); });
            }
            $('find').addEventListener('input', draw);
            $('find').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return; e.preventDefault(); var f = $('find').value.trim().toLowerCase(); if (!f) return;
                var hit = items.filter(function (i) { return i.barcode && i.barcode.toLowerCase() === f; })[0]; if (!hit) { var m = items.filter(function (i) { return i.name.toLowerCase().indexOf(f) >= 0; }); if (m.length === 1) hit = m[0]; }
                if (hit) { add(hit); $('find').value = ''; draw(); } else showErr('No item matches "' + $('find').value.trim() + '".');
            });
            ['disc', 'tender'].forEach(function (id) { $(id).addEventListener('input', render); });
            $('clear').addEventListener('click', reset); $('mnew').addEventListener('click', function () { $('modal').classList.remove('show'); reset(); });
            $('done').addEventListener('click', function () {
                if (busy || !cart.length) return;
                if (method === 'stk') { startStk(); return; }
                var t = totals(), def = METHODS.filter(function (x) { return x.k === method; })[0] || {};
                if (method === 'cash' && money($('tender').value) < t.total) { showErr('The cash received is less than the total.'); return; }
                if (method === 'mpesa' && !/^[A-Za-z0-9]{8,14}$/.test($('mref').value.trim())) { showErr('Enter the M-Pesa code from the customer\\'s SMS.'); return; }
                if (method.indexOf('m:') === 0 && def.needsRef && $('mref').value.trim().length < 3) { showErr('Enter the reference for ' + def.n + '.'); return; }
                busy = true; $('done').disabled = true; $('done').textContent = 'Saving...'; showErr('');
                post('/pos/api/sales', { lines: linesBody(), discount: $('disc').value, method: method, tendered: $('tender').value, ref: $('mref').value.trim(), customerPhone: $('cphone').value.trim() })
                .then(function (x) {
                    busy = false;
                    if (!x.ok) { showErr(x.d.error || 'The sale could not be saved.'); render(); return; }
                    success(x.d);
                }).catch(function () { busy = false; showErr('Connection problem. The sale may not have been saved: check Sales History before trying again.'); render(); });
            });
            setMethod('cash'); load();
        })();
        </script>`;
        send(req, res, { title: 'POS Terminal', nav: 'terminal', body });
    }));

    // ----- sales history, receipts, void -----
    router.get('/sales', ah(async (req, res) => {
        const from = validDate(req.query.from) ? req.query.from : addDays(todayNairobi(), -6), to = validDate(req.query.to) ? req.query.to : todayNairobi();
        const mine = req.role === 'cashier';
        const r = await q(`SELECT id, receipt_no, total_cents, method, mpesa_ref, status, created_at, user_name FROM pos_sales WHERE shop_id=$1 AND (created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 ${mine ? 'AND user_id=$4' : ''} ORDER BY created_at DESC LIMIT 500`, mine ? [req.shop.id, from, to, req.me.id] : [req.shop.id, from, to]);
        const sum = r.rows.filter(s => s.status === 'completed').reduce((a, s) => a + Number(s.total_cents), 0);
        send(req, res, { title: mine ? 'My Sales' : 'Sales History', nav: 'sales', body: `<h1>${mine ? 'My Sales' : 'Sales History'}</h1>${notice(req)}
        <div class="panel"><form method="GET" class="row"><div><label for="f">From</label><input id="f" type="date" name="from" value="${from}"></div><div><label for="t">To</label><input id="t" type="date" name="to" value="${to}"></div><button class="btn dark" type="submit">Show</button></form><p class="muted" style="margin:10px 0 0">${r.rows.length} sale${r.rows.length === 1 ? '' : 's'}, completed total <b>${kes(sum)}</b></p></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Receipt</th><th>When</th><th>Method</th><th>Cashier</th><th class="num">Total</th><th>Status</th><th></th></tr>${r.rows.map(s => `<tr><td>#${s.receipt_no}</td><td class="nowrap">${esc(timeFmt(s.created_at))}</td><td>${esc(methodLabel(s.method))}${s.mpesa_ref ? ' ' + esc(s.mpesa_ref) : ''}</td><td>${esc(s.user_name)}</td><td class="num">${fmt(s.total_cents)}</td><td>${s.status === 'voided' ? '<span class="tag bad">voided</span>' : '<span class="tag ok">completed</span>'}</td><td class="right"><a class="btn small ghost" href="/pos/sales/${s.id}/receipt">Receipt</a></td></tr>`).join('')}</table>` : '<p class="muted">No sales in this period.</p>'}</div>` });
    }));
    const getSale = async (req, idParam) => {
        const id = parseCount(idParam, { min: 1 });
        if (!id) return null;
        const s = (await q('SELECT * FROM pos_sales WHERE id=$1 AND shop_id=$2', [id, req.shop.id])).rows[0];
        if (!s || (req.role === 'cashier' && s.user_id !== req.me.id)) return null;
        s.lines = (await q('SELECT name, qty, unit_price_cents FROM pos_sale_items WHERE sale_id=$1 ORDER BY id', [s.id])).rows;
        return s;
    };
    router.get('/logo', ah(async (req, res) => {
        const r = (await q('SELECT logo, logo_mime FROM pos_businesses WHERE id=$1', [req.shop.business_id])).rows[0];
        if (!r || !r.logo) return res.sendStatus(404);
        res.set({ 'Content-Type': r.logo_mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'" }).send(r.logo);
    }));
    router.get('/sales/:id/receipt', ah(async (req, res) => {
        const s = await getSale(req, req.params.id);
        if (!s) return send(req, res, { title: 'Not found', nav: 'sales', body: '<h1>Receipt not found</h1><a href="/pos/sales">Back to sales</a>' }, 404);
        const sh = req.shop, canVoid = req.role !== 'cashier' && s.status === 'completed';
        const body = `<div class="noprint" style="margin-bottom:14px"><button class="btn" id="prt" type="button">Print / Save as PDF</button> <a class="btn ghost" href="/pos/sales">Back to sales</a> ${canVoid ? `<form action="/pos/sales/${s.id}/void" method="POST" style="display:inline"><input name="reason" placeholder="Reason for voiding" maxlength="200" required style="width:220px;display:inline-block"> <button class="btn bad small" type="submit">Void sale</button></form>` : ''}</div>
        <div class="panel" style="max-width:380px;margin:0 auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88rem">
            <div style="text-align:center">${sh.has_logo ? `<img src="/pos/logo?v=${sh.logo_ver}" alt="" style="max-width:200px;max-height:90px;margin:0 auto 6px;display:block">` : ''}<b style="font-size:1.1rem">${esc(sh.name)}</b><br>${esc(sh.branch)}${sh.address ? '<br>' + esc(sh.address) : ''}${sh.phone ? '<br>Tel ' + esc(sh.phone) : ''}${sh.tax_pin ? '<br>PIN ' + esc(sh.tax_pin) : ''}</div>
            <hr><div>Receipt #${s.receipt_no}${s.status === 'voided' ? ' <b>(VOIDED)</b>' : ''}<br>${esc(timeFmt(s.created_at))}${s.user_name ? '<br>Served by ' + esc(s.user_name) : ''}</div><hr>
            <table style="font-size:.88rem">${s.lines.map(l => `<tr><td style="border:0;padding:3px 0">${esc(l.name)}<br><span class="muted">${l.qty} x ${fmt(l.unit_price_cents)}</span></td><td class="num" style="border:0;padding:3px 0">${fmt(Number(l.unit_price_cents) * l.qty)}</td></tr>`).join('')}</table><hr>
            <div class="tot"><span>Subtotal (before VAT)</span><span>${fmt(s.subtotal_cents)}</span></div>${Number(s.discount_cents) ? `<div class="tot"><span>Discount</span><span>-${fmt(s.discount_cents)}</span></div>` : ''}
            ${Number(s.vat_rate) > 0 ? `<div class="tot"><span>VAT ${Number(s.vat_rate)}%</span><span>${fmt(s.vat_cents)}</span></div>` : ''}
            <div class="tot big"><span>TOTAL</span><span>KES ${fmt(s.total_cents)}</span></div>
            <div class="tot"><span>Paid (${esc(methodLabel(s.method))})</span><span>${fmt(s.paid_cents)}</span></div>${s.mpesa_ref ? `<div class="tot"><span>Reference</span><span>${esc(s.mpesa_ref)}</span></div>` : ''}${Number(s.change_cents) ? `<div class="tot"><span>Change</span><span>${fmt(s.change_cents)}</span></div>` : ''}
            ${s.status === 'voided' ? `<hr><div>Voided: ${esc(s.void_reason || '')}</div>` : ''}<hr><div style="text-align:center">${esc(sh.receipt_footer)}</div>
            <div style="text-align:center;margin-top:8px;font-size:.75rem" class="muted">Powered by Tencent POS</div>
        </div>
        <script nonce="${req.nonce || ''}">document.getElementById('prt').addEventListener('click',function(){window.print();});</script>`;
        send(req, res, { title: 'Receipt #' + s.receipt_no, nav: 'sales', body });
    }));
    router.post('/sales/:id/void', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        const reason = str(req.body.reason).slice(0, 200) || 'No reason given';
        if (!id) return res.redirect('/pos/sales');
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const s = (await client.query(`UPDATE pos_sales SET status='voided', void_reason=$3, voided_at=now() WHERE id=$1 AND shop_id=$2 AND status='completed' RETURNING id, receipt_no`, [id, req.shop.id, reason])).rows[0];
            if (s) {
                const lines = (await client.query(`SELECT si.item_id, si.qty FROM pos_sale_items si JOIN pos_items i ON i.id = si.item_id AND i.shop_id=$2 AND i.track_stock WHERE si.sale_id=$1 ORDER BY si.item_id`, [id, req.shop.id])).rows;
                for (const l of lines) {
                    const nb = (await client.query('UPDATE pos_items SET stock = stock + $2 WHERE id=$1 AND shop_id=$3 RETURNING stock', [l.item_id, l.qty, req.shop.id])).rows[0].stock;
                    await client.query(`INSERT INTO pos_stock_moves (shop_id, item_id, change, balance, reason, note, sale_id) VALUES ($1,$2,$3,$4,'void',$5,$6)`, [req.shop.id, l.item_id, l.qty, nb, 'Voided receipt #' + s.receipt_no, id]);
                }
            }
            await client.query('COMMIT');
        } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
        res.redirect(`/pos/sales/${id}/receipt`);
    }));

    // ----- daily report (Z-report) -----
    async function periodSummary(shopId, from, to) {
        const f = `(created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3`;
        const [s, v, p, e, top, cash] = await Promise.all([
            q(`SELECT count(*)::int n, COALESCE(sum(subtotal_cents),0)::bigint gross, COALESCE(sum(discount_cents),0)::bigint disc, COALESCE(sum(total_cents),0)::bigint total, COALESCE(sum(vat_cents),0)::bigint vat,
                      COALESCE(sum(total_cents) FILTER (WHERE method='cash'),0)::bigint cash, COALESCE(sum(total_cents) FILTER (WHERE method='mpesa'),0)::bigint mpesa
               FROM pos_sales WHERE shop_id=$1 AND status='completed' AND ${f}`, [shopId, from, to]),
            q(`SELECT count(*)::int n, COALESCE(sum(total_cents),0)::bigint total FROM pos_sales WHERE shop_id=$1 AND status='voided' AND ${f}`, [shopId, from, to]),
            q(`SELECT COALESCE(sum((si.unit_price_cents - si.unit_cost_cents) * si.qty),0)::bigint profit, COALESCE(sum(si.qty),0)::int units FROM pos_sale_items si JOIN pos_sales s ON s.id = si.sale_id WHERE s.shop_id=$1 AND s.status='completed' AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3`, [shopId, from, to]),
            q(`SELECT COALESCE(sum(amount_cents),0)::bigint total FROM pos_expenses WHERE shop_id=$1 AND spent_on BETWEEN $2 AND $3`, [shopId, from, to]),
            q(`SELECT si.name, sum(si.qty)::int qty, sum(si.qty * si.unit_price_cents)::bigint revenue FROM pos_sale_items si JOIN pos_sales s ON s.id = si.sale_id WHERE s.shop_id=$1 AND s.status='completed' AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 GROUP BY si.name ORDER BY qty DESC, revenue DESC LIMIT 10`, [shopId, from, to]),
            q(`SELECT COALESCE(NULLIF(user_name,''),'-') AS who, count(*)::int n, sum(total_cents)::bigint total FROM pos_sales WHERE shop_id=$1 AND status='completed' AND ${f} GROUP BY 1 ORDER BY 3 DESC`, [shopId, from, to])
        ]);
        const S = s.rows[0], P = p.rows[0], E = e.rows[0];
        S.other = Number(S.total) - Number(S.cash) - Number(S.mpesa);
        // prices are before VAT, so profit is item margin after discounts; the VAT charged belongs to KRA and is shown separately
        const gross = Number(P.profit) - Number(S.disc);
        return { S, V: v.rows[0], units: P.units, gross, expenses: Number(E.total), net: gross - Number(E.total), top: top.rows, byCashier: cash.rows };
    }
    router.get('/daily', ah(async (req, res) => {
        const day = validDate(req.query.date) ? req.query.date : todayNairobi();
        const r = await periodSummary(req.shop.id, day, day);
        const row = (k, v, strong) => `<tr><td>${strong ? '<b>' + k + '</b>' : k}</td><td class="num">${strong ? '<b>' + v + '</b>' : v}</td></tr>`;
        send(req, res, { title: 'Daily Sales', nav: 'daily', body: `<h1>Daily Sales (Z-Report)</h1>
        <div class="panel noprint"><form method="GET" class="row"><div><label for="d">Date</label><input id="d" type="date" name="date" value="${day}"></div><button class="btn dark" type="submit">Show</button><button class="btn" type="button" id="prt">Print</button></form></div>
        <div class="panel" style="max-width:560px"><h2>${esc(req.shop.name)} (${esc(req.shop.branch)}): ${esc(dateFmt(day + 'T12:00:00+03:00'))}</h2><table>
            ${row('Number of sales', r.S.n)}${row('Items sold', r.units)}${row('Sales before VAT and discounts', kes(r.S.gross))}${row('Discounts given', '-' + kes(r.S.disc))}${row('Total sales', kes(r.S.total), true)}
            ${row('VAT charged (included in total sales)', kes(r.S.vat))}${row('Cash sales (expected in the drawer)', kes(r.S.cash))}${row('M-Pesa sales', kes(r.S.mpesa))}${row('Other payment types', kes(r.S.other))}${row('Voided sales (' + r.V.n + ')', kes(r.V.total))}
            ${row('Gross profit', kes(r.gross))}${row('Expenses', kes(r.expenses))}${row('Net profit', (r.net < 0 ? '-' : '') + kes(Math.abs(r.net)), true)}</table></div>
        <div class="grid2" style="align-items:start;max-width:1100px"><div class="panel"><h2>Sales by cashier</h2>${r.byCashier.length ? `<table><tr><th>Cashier</th><th class="num">Sales</th><th class="num">Total</th></tr>${r.byCashier.map(c => `<tr><td>${esc(c.who)}</td><td class="num">${c.n}</td><td class="num">${fmt(c.total)}</td></tr>`).join('')}</table>` : '<p class="muted">No sales on this day.</p>'}</div>
        <div class="panel"><h2>Best sellers</h2>${r.top.length ? `<table><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr>${r.top.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num">${fmt(t.revenue)}</td></tr>`).join('')}</table>` : '<p class="muted">No sales on this day.</p>'}</div></div>
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
        <div class="cards"><div class="stat c1"><span>Total sales</span><b>${kes(r.S.total)}</b><span>${r.S.n} sales</span></div><div class="stat c3"><span>Gross profit</span><b>${kes(r.gross)}</b></div><div class="stat c4"><span>Expenses</span><b>${kes(r.expenses)}</b></div><div class="stat ${r.net >= 0 ? 'c2' : 'c9'}"><span>Net profit</span><b>${r.net < 0 ? '-' : ''}${kes(Math.abs(r.net))}</b></div><div class="stat c7"><span>Cash</span><b>${kes(r.S.cash)}</b></div><div class="stat c5"><span>M-Pesa</span><b>${kes(r.S.mpesa)}</b></div></div>
        <div class="grid2" style="align-items:start"><div class="panel"><h2>Best sellers</h2>${r.top.length ? `<table><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr>${r.top.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num">${fmt(t.revenue)}</td></tr>`).join('')}</table>` : '<p class="muted">No sales in this period.</p>'}</div>
        <div class="panel"><h2>Sales by day</h2>${days.rows.length ? `<div class="tablewrap"><table><tr><th>Day</th><th class="num">Sales</th><th class="num">Total</th></tr>${days.rows.map(d => `<tr><td>${esc(dateFmt(isoDay(d.d) + 'T12:00:00+03:00'))}</td><td class="num">${d.n}</td><td class="num">${fmt(d.total)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No sales in this period.</p>'}</div></div>` });
    }));
    router.get('/reports.csv', ah(async (req, res) => {
        const today = todayNairobi();
        const from = validDate(req.query.from) ? req.query.from : today.slice(0, 8) + '01', to = validDate(req.query.to) ? req.query.to : today;
        const r = await q(`SELECT s.receipt_no, s.created_at, s.method, s.mpesa_ref, s.subtotal_cents, s.discount_cents, s.total_cents, s.status, string_agg(si.name || ' x' || si.qty, '; ' ORDER BY si.id) AS items
            FROM pos_sales s LEFT JOIN pos_sale_items si ON si.sale_id = s.id WHERE s.shop_id=$1 AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 GROUP BY s.id ORDER BY s.created_at`, [req.shop.id, from, to]);
        const lines = [['Receipt', 'Date', 'Method', 'M-Pesa code', 'Subtotal', 'Discount', 'Total', 'Status', 'Items'].map(csvCell).join(',')];
        for (const s of r.rows) lines.push([s.receipt_no, timeFmt(s.created_at), s.method, s.mpesa_ref || '', (s.subtotal_cents / 100).toFixed(2), (s.discount_cents / 100).toFixed(2), (s.total_cents / 100).toFixed(2), s.status, s.items || ''].map(csvCell).join(','));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sales-${from}-to-${to}.csv"`, 'Cache-Control': 'no-store' }).send('﻿' + lines.join('\r\n'));
    }));

    // ======================= BUSINESS, BRANCHES, STAFF, PAYMENTS, SUBSCRIPTION =======================
    const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
    const delPost = (action, label = 'Delete') => `<form action="${action}" method="POST" style="display:inline"><button class="btn small ghost" type="submit">${label}</button></form>`;
    const killSessions = uid => q(`DELETE FROM session WHERE (sess->'user'->>'id') = $1`, [String(uid)]).catch(() => {});

    // creates a login for a cashier or manager; the owner vouches for them, so no email confirmation is needed
    async function createStaff(client, { bizId, branchId, role, name, email, phone, password, fallbackPhone }) {
        name = str(name).slice(0, 80); email = str(email).toLowerCase();
        if (name.length < 2) return 'Enter the person\'s name.';
        if (!validEmail(email)) return 'Enter a valid email address. It is what they log in with.';
        if (typeof password !== 'string' || password.length < 8 || password.length > 72) return 'The password must be 8 to 72 characters.';
        const ph = phone ? platform.normalizePhone(phone) : '';
        if (phone && !ph) return 'The phone number is not valid.';
        if ((await client.query('SELECT 1 FROM users WHERE lower(email)=$1', [email])).rowCount) return 'That email already has an account. Use a different email.';
        const hash = await platform.hashPassword(password);
        const u = (await client.query('INSERT INTO users (name, email, phone, password_hash, email_verified) VALUES ($1,$2,$3,$4,TRUE) RETURNING id', [name, email, ph || fallbackPhone || '-', hash])).rows[0];
        await client.query('INSERT INTO pos_members (user_id, business_id, branch_id, role) VALUES ($1,$2,$3,$4)', [u.id, bizId, branchId, role]);
        return '';
    }

    // ----- branch settings -----
    router.get('/settings', ah(async (req, res) => {
        const s = req.shop;
        send(req, res, { title: 'Branch Settings', nav: 'settings', body: `<h1>Branch Settings</h1>${notice(req)}${errBox(req)}<div class="panel" style="max-width:620px"><form action="/pos/settings" method="POST">
            <div class="field"><label for="n">Branch name</label><input id="n" name="name" required maxlength="120" value="${esc(s.branch)}"></div>
            <div class="field"><label for="p">Branch phone</label><input id="p" name="phone" maxlength="40" value="${esc(s.phone)}"></div>
            <div class="field"><label for="a">Branch address</label><input id="a" name="address" maxlength="200" value="${esc(s.address)}"></div>
            <button class="btn" type="submit">Save</button></form></div>
            ${req.role === 'owner' ? '<p class="muted">The business name, logo, KRA PIN, VAT and receipt footer are under <a href="/pos/business">Business & Receipts</a>.</p>' : ''}` });
    }));
    router.post('/settings', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120);
        if (name.length < 2) return back(res, '/pos/settings', '', 'Enter the branch name.');
        await q('UPDATE pos_shops SET name=$2, phone=$3, address=$4 WHERE id=$1', [req.shop.id, name, str(req.body.phone).slice(0, 40), str(req.body.address).slice(0, 200)]);
        back(res, '/pos/settings', 'Saved.');
    }));

    // ----- business, receipts, logo, VAT (owner) -----
    router.get('/business', ah(async (req, res) => {
        const s = req.shop;
        send(req, res, { title: 'Business & Receipts', nav: 'biz', body: `<h1>Business & Receipts</h1>${notice(req)}${errBox(req)}
        <div class="panel" style="max-width:640px"><h2>Name and receipt details</h2><form action="/pos/business" method="POST">
            <div class="field"><label for="n">Business name (printed on receipts)</label><input id="n" name="name" required maxlength="120" value="${esc(s.name)}"></div>
            <div class="field"><label for="k">KRA PIN (optional)</label><input id="k" name="tax_pin" maxlength="40" value="${esc(s.tax_pin)}"></div>
            <div class="field"><label for="v">VAT rate added to your selling prices (%)</label><input id="v" name="vat" inputmode="decimal" value="${s.vat_rate}"><small>Item prices are entered before VAT. The POS adds this VAT at the sale, and the receipt shows subtotal, VAT and the total the customer pays. Use 0 if you are not VAT registered.</small></div>
            <div class="field"><label for="f">Receipt footer message</label><input id="f" name="footer" maxlength="200" value="${esc(s.receipt_footer)}"></div>
            <button class="btn" type="submit">Save</button></form></div>
        <div class="panel" style="max-width:640px"><h2>Logo</h2>
            ${s.has_logo ? `<p><img src="/pos/logo?v=${s.logo_ver}" alt="Your logo" style="max-height:90px;max-width:260px;border:1px solid var(--line);padding:6px;border-radius:8px"></p>` : '<p class="muted">No logo yet. Your business name is printed alone.</p>'}
            <div class="field"><label for="lg">Choose a PNG or JPG logo</label><input id="lg" type="file" accept="image/png,image/jpeg"><small>It is shrunk automatically. A simple, high-contrast logo prints best on receipts.</small></div>
            <div id="lgmsg" class="alert" style="display:none" role="alert"></div>
            <button class="btn" id="lgup" type="button">Upload logo</button>
            ${s.has_logo ? delPost('/pos/business/logo/remove', 'Remove logo') : ''}</div>
        <script nonce="${req.nonce || ''}">
        (function(){var f=document.getElementById('lg'),b=document.getElementById('lgup'),m=document.getElementById('lgmsg');
        function say(t){m.textContent=t;m.style.display='block';}
        b.addEventListener('click',function(){var file=f.files&&f.files[0];if(!file){say('Choose a picture first.');return;}
        var img=new Image(),u=URL.createObjectURL(file);img.onload=function(){var max=400,r=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*r));c.height=Math.max(1,Math.round(img.height*r));var x=c.getContext('2d');x.drawImage(img,0,0,c.width,c.height);
        c.toBlob(function(bl){if(!bl||bl.size>280000){c.toBlob(function(b2){send(b2);},'image/jpeg',0.85);}else send(bl);},'image/png');URL.revokeObjectURL(u);};
        img.onerror=function(){say('That file could not be read as a picture.');};img.src=u;});
        function send(bl){if(!bl){say('The picture could not be prepared.');return;}fetch('/pos/business/logo',{method:'POST',credentials:'same-origin',headers:{'Content-Type':bl.type},body:bl}).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});}).then(function(x){if(x.ok)location.href='/pos/business?ok='+encodeURIComponent('Logo saved.');else say(x.d.error||'Upload failed.');}).catch(function(){say('Connection problem. Try again.');});}})();
        </script>` });
    }));
    router.post('/business', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120), vatRaw = str(req.body.vat) === '' ? '16' : str(req.body.vat);
        if (name.length < 2) return back(res, '/pos/business', '', 'Enter the business name.');
        if (!/^\d{1,2}(\.\d)?$/.test(vatRaw) || Number(vatRaw) > 30) return back(res, '/pos/business', '', 'The VAT rate must be a number from 0 to 30.');
        await q('UPDATE pos_businesses SET name=$2, tax_pin=$3, receipt_footer=$4, vat_rate=$5 WHERE id=$1', [req.shop.business_id, name, str(req.body.tax_pin).slice(0, 40), str(req.body.footer).slice(0, 200), Number(vatRaw)]);
        back(res, '/pos/business', 'Saved.');
    }));
    router.post('/business/logo', express.raw({ type: ['image/png', 'image/jpeg'], limit: '300kb' }), ah(async (req, res) => {
        const b = req.body;
        if (!Buffer.isBuffer(b) || b.length < 20) return res.status(400).json({ error: 'No picture received.' });
        const png = b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
        if (!png && !jpg) return res.status(400).json({ error: 'Only PNG or JPG pictures are accepted.' });   // content is checked, not just the label
        await q('UPDATE pos_businesses SET logo=$2, logo_mime=$3, logo_ver=logo_ver+1 WHERE id=$1', [req.shop.business_id, b, png ? 'image/png' : 'image/jpeg']);
        res.json({ ok: true });
    }));
    router.post('/business/logo/remove', ah(async (req, res) => {
        await q('UPDATE pos_businesses SET logo=NULL, logo_mime=NULL, logo_ver=logo_ver+1 WHERE id=$1', [req.shop.business_id]);
        back(res, '/pos/business', 'Logo removed.');
    }));

    // ----- branches (owner) -----
    router.get('/branches', ah(async (req, res) => {
        const r = await q(`SELECT s.*, (SELECT count(*) FROM pos_members m WHERE m.branch_id=s.id AND m.role='cashier' AND m.active)::int cashiers, (SELECT u.email FROM pos_members m JOIN users u ON u.id=m.user_id WHERE m.branch_id=s.id AND m.role='manager' AND m.active ORDER BY m.id LIMIT 1) AS manager FROM pos_shops s WHERE s.business_id=$1 ORDER BY s.id`, [req.shop.business_id]);
        send(req, res, { title: 'Branches', nav: 'branches', body: `<h1>Branches</h1>${notice(req)}${errBox(req)}
        <div class="panel"><h2>Open a new branch</h2><p class="muted" style="margin-top:0">Each extra branch adds KES ${branchFee().toLocaleString('en-KE')} per month to your subscription from your next payment.</p><form action="/pos/branches" method="POST"><div class="grid2">
            <div class="field"><label for="n">Branch name</label><input id="n" name="name" required maxlength="120" placeholder="e.g. Homa Bay Town"></div>
            <div class="field"><label for="p">Phone</label><input id="p" name="phone" maxlength="40"></div>
            <div class="field"><label for="a">Address</label><input id="a" name="address" maxlength="200"></div></div>
            <div class="field"><label><input type="checkbox" name="copy" value="1" style="width:auto"> Copy the items and categories of <b>${esc(req.shop.branch)}</b> (stock starts at zero)</label></div>
            <h3 style="margin:14px 0 6px">Branch manager login (optional)</h3><p class="muted" style="margin-top:0">A manager runs this branch: items, stock, reports and cashiers. You can also add one later.</p>
            <div class="grid2"><div class="field"><label for="mn">Manager name</label><input id="mn" name="mgr_name" maxlength="80"></div><div class="field"><label for="me">Manager email (their login)</label><input id="me" name="mgr_email" type="email" maxlength="254"></div><div class="field"><label for="mp">Password (8+ characters)</label><input id="mp" name="mgr_password" type="password" autocomplete="new-password" maxlength="72"></div></div>
            <button class="btn" type="submit">Create branch</button></form></div>
        <div class="panel tablewrap"><table><tr><th>Branch</th><th>Phone</th><th>Cashiers</th><th>Manager</th><th>Status</th><th></th></tr>${r.rows.map(b => `<tr><td>${esc(b.name)}<br><small class="muted">${esc(b.address)}</small></td><td>${esc(b.phone)}</td><td>${b.cashiers}</td><td>${esc(b.manager || '-')}</td><td><span class="tag ${b.active ? 'ok' : 'gray'}">${b.active ? 'active' : 'switched off'}</span></td><td class="right nowrap">${b.active ? `<form action="/pos/branch/switch" method="POST" style="display:inline"><input type="hidden" name="branch_id" value="${b.id}"><button class="btn small" type="submit">Open</button></form> ` : ''}${delPost('/pos/branches/' + b.id + '/toggle', b.active ? 'Switch off' : 'Switch on')}</td></tr>`).join('')}</table></div>` });
    }));
    router.post('/branches', ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120);
        if (name.length < 2) return back(res, '/pos/branches', '', 'Enter the branch name.');
        const wantMgr = str(req.body.mgr_email) || str(req.body.mgr_name) || req.body.mgr_password;
        const client = await pool().connect();
        let err = '';
        try {
            await client.query('BEGIN');
            const b = (await client.query('INSERT INTO pos_shops (business_id, name, phone, address) VALUES ($1,$2,$3,$4) RETURNING id', [req.shop.business_id, name, str(req.body.phone).slice(0, 40), str(req.body.address).slice(0, 200)])).rows[0];
            if (req.body.copy === '1') {
                await client.query('INSERT INTO pos_categories (shop_id, name) SELECT $1, name FROM pos_categories WHERE shop_id=$2 ON CONFLICT DO NOTHING', [b.id, req.shop.id]);
                await client.query(`INSERT INTO pos_items (shop_id, category_id, name, barcode, price_cents, cost_cents, stock, track_stock, reorder_level)
                    SELECT $1, (SELECT c2.id FROM pos_categories c2 JOIN pos_categories c1 ON c1.name = c2.name AND c1.shop_id = $2 WHERE c1.id = i.category_id AND c2.shop_id = $1), i.name, i.barcode, i.price_cents, i.cost_cents, 0, i.track_stock, i.reorder_level FROM pos_items i WHERE i.shop_id=$2 AND i.active`, [b.id, req.shop.id]);
            }
            if (wantMgr) err = await createStaff(client, { bizId: req.shop.business_id, branchId: b.id, role: 'manager', name: req.body.mgr_name, email: req.body.mgr_email, password: req.body.mgr_password, fallbackPhone: str(req.body.phone) });
            if (err) await client.query('ROLLBACK'); else await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
        if (err) return back(res, '/pos/branches', '', err);
        back(res, '/pos/branches', 'Branch created.');
    }));
    router.post('/branches/:id/toggle', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) {
            const active = (await q('SELECT count(*)::int n FROM pos_shops WHERE business_id=$1 AND active', [req.shop.business_id])).rows[0].n;
            const r = (await q('SELECT active FROM pos_shops WHERE id=$1 AND business_id=$2', [id, req.shop.business_id])).rows[0];
            if (r && r.active && active <= 1) return back(res, '/pos/branches', '', 'You need at least one active branch.');
            if (r) await q('UPDATE pos_shops SET active = NOT active WHERE id=$1 AND business_id=$2', [id, req.shop.business_id]);
        }
        back(res, '/pos/branches', 'Updated.');
    }));
    router.post('/branch/switch', ah(async (req, res) => {
        const id = parseCount(req.body.branch_id, { min: 1 });
        if (id && req.branches.some(b => b.id === id)) req.session.posBranch = id;
        res.redirect('/pos/app');
    }));

    // ----- cashiers and staff of the current branch -----
    router.get('/staff', ah(async (req, res) => {
        const r = await q(`SELECT m.id, m.role, m.active, u.name, u.email, u.phone FROM pos_members m JOIN users u ON u.id=m.user_id WHERE m.branch_id=$1 AND m.business_id=$2 ORDER BY m.role, u.name`, [req.shop.id, req.shop.business_id]);
        send(req, res, { title: 'Cashiers & Staff', nav: 'staff', body: `<h1>Cashiers & Staff <small class="muted" style="font-size:.9rem">${esc(req.shop.branch)}</small></h1>${notice(req)}${errBox(req)}
        <div class="panel"><h2>Add a login for this branch</h2><form action="/pos/staff" method="POST"><div class="grid2">
            <div class="field"><label for="n">Name</label><input id="n" name="name" required maxlength="80"></div>
            <div class="field"><label for="e">Email (their login)</label><input id="e" name="email" type="email" required maxlength="254"></div>
            <div class="field"><label for="p">Phone (optional)</label><input id="p" name="phone" maxlength="20"></div>
            <div class="field"><label for="w">Password (8+ characters)</label><input id="w" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password"></div>
            <div class="field"><label for="r">Role</label><select id="r" name="role"><option value="cashier">Cashier: sells and views own sales</option>${req.role === 'owner' ? '<option value="manager">Manager: runs this branch</option>' : ''}</select></div></div>
            <button class="btn" type="submit">Add login</button></form><p class="muted">Give the person their email and password. They log in at the website and open the POS. Each cashier's sales are recorded under their name.</p></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Name</th><th>Login email</th><th>Role</th><th>Status</th><th></th></tr>${r.rows.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${esc(m.role)}</td><td><span class="tag ${m.active ? 'ok' : 'gray'}">${m.active ? 'active' : 'switched off'}</span></td><td class="right nowrap">${(req.role === 'owner' || m.role === 'cashier') ? `${delPost('/pos/staff/' + m.id + '/toggle', m.active ? 'Switch off' : 'Switch on')} <form action="/pos/staff/${m.id}/password" method="POST" style="display:inline"><input name="password" type="password" placeholder="New password" minlength="8" maxlength="72" required style="width:140px;display:inline-block;padding:5px" autocomplete="new-password"> <button class="btn small ghost" type="submit">Set</button></form>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">No cashiers yet for this branch.</p>'}</div>` });
    }));
    router.post('/staff', ah(async (req, res) => {
        const role = req.body.role === 'manager' && req.role === 'owner' ? 'manager' : 'cashier';
        const client = await pool().connect();
        let err = '';
        try {
            await client.query('BEGIN');
            err = await createStaff(client, { bizId: req.shop.business_id, branchId: req.shop.id, role, name: req.body.name, email: req.body.email, phone: str(req.body.phone), password: req.body.password, fallbackPhone: req.shop.phone });
            if (err) await client.query('ROLLBACK'); else await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); if (e.code === '23505') err = 'That email already has an account.'; else throw e; } finally { client.release(); }
        back(res, '/pos/staff', 'Login added.', err);
    }));
    const staffRow = async (req, idParam) => {
        const id = parseCount(idParam, { min: 1 });
        const m = id && (await q(`SELECT id, user_id, role, active FROM pos_members WHERE id=$1 AND branch_id=$2 AND business_id=$3 AND role <> 'owner'`, [id, req.shop.id, req.shop.business_id])).rows[0];
        return m && (req.role === 'owner' || m.role === 'cashier') ? m : null;
    };
    router.post('/staff/:id/toggle', ah(async (req, res) => {
        const m = await staffRow(req, req.params.id);
        if (m) { await q('UPDATE pos_members SET active = NOT active WHERE id=$1', [m.id]); if (m.active) await killSessions(m.user_id); }
        back(res, '/pos/staff', 'Updated.');
    }));
    router.post('/staff/:id/password', ah(async (req, res) => {
        const m = await staffRow(req, req.params.id), pw = typeof req.body.password === 'string' ? req.body.password : '';
        if (!m) return back(res, '/pos/staff', '', 'Person not found.');
        if (pw.length < 8 || pw.length > 72) return back(res, '/pos/staff', '', 'The password must be 8 to 72 characters.');
        await q('UPDATE users SET password_hash=$2 WHERE id=$1', [m.user_id, await platform.hashPassword(pw)]);
        await killSessions(m.user_id);
        back(res, '/pos/staff', 'Password changed. They have been logged out.');
    }));

    // ----- all-branch report (owner) -----
    router.get('/business-report', ah(async (req, res) => {
        const today = todayNairobi();
        const from = validDate(req.query.from) ? req.query.from : today.slice(0, 8) + '01', to = validDate(req.query.to) ? req.query.to : today;
        const all = (await q('SELECT id, name, active FROM pos_shops WHERE business_id=$1 ORDER BY id', [req.shop.business_id])).rows;
        const rows = await Promise.all(all.map(async b => ({ b, r: await periodSummary(b.id, from, to) })));
        const sum = f => rows.reduce((a, x) => a + f(x.r), 0);
        send(req, res, { title: 'All-branch Report', nav: 'bizreport', body: `<h1>All-branch Report</h1>
        <div class="panel"><form method="GET" class="row"><div><label for="f">From</label><input id="f" type="date" name="from" value="${from}"></div><div><label for="t">To</label><input id="t" type="date" name="to" value="${to}"></div><button class="btn dark" type="submit">Show</button></form></div>
        <div class="panel tablewrap"><table><tr><th>Branch</th><th class="num">Sales</th><th class="num">Total sales</th><th class="num">VAT</th><th class="num">Gross profit</th><th class="num">Expenses</th><th class="num">Net profit</th></tr>
        ${rows.map(({ b, r }) => `<tr><td>${esc(b.name)}${b.active ? '' : ' <span class="tag gray">off</span>'}</td><td class="num">${r.S.n}</td><td class="num">${fmt(r.S.total)}</td><td class="num">${fmt(r.S.vat)}</td><td class="num">${fmt(r.gross)}</td><td class="num">${fmt(r.expenses)}</td><td class="num">${r.net < 0 ? '-' : ''}${fmt(Math.abs(r.net))}</td></tr>`).join('')}
        <tr><td><b>All branches</b></td><td class="num"><b>${sum(r => r.S.n)}</b></td><td class="num"><b>${fmt(sum(r => Number(r.S.total)))}</b></td><td class="num"><b>${fmt(sum(r => Number(r.S.vat)))}</b></td><td class="num"><b>${fmt(sum(r => r.gross))}</b></td><td class="num"><b>${fmt(sum(r => r.expenses))}</b></td><td class="num"><b>${fmt(sum(r => r.net))}</b></td></tr></table></div>` });
    }));

    // ----- payment methods (owner): M-Pesa STK with the business's own credentials, plus other ways to take payment -----
    router.get('/payments', ah(async (req, res) => {
        const [c, methods] = await Promise.all([mpesaCreds(req.shop.business_id), payMethods(req.shop.business_id)]);
        const presets = ['Airtel Money', 'T-Kash', 'Card (POS machine)', 'Bank transfer', 'Cheque'];
        send(req, res, { title: 'Payment Methods', nav: 'payments', body: `<h1>Payment Methods</h1>${notice(req)}${errBox(req)}
        <div class="panel" style="max-width:720px"><h2>M-Pesa STK push (Safaricom Daraja)</h2>
            ${c ? `<p><span class="tag ok">Connected</span> ${c.type === 'till' ? 'Till (Buy Goods)' : 'Paybill'} shortcode <b>${esc(c.shortcode)}</b>. Cashiers will see "M-Pesa (STK push)" on the POS Terminal. The secrets are stored encrypted and never shown again.</p>
            <form action="/pos/payments/mpesa/test" method="POST" style="display:inline"><button class="btn small ghost" type="submit">Test connection</button></form> <form action="/pos/payments/mpesa/remove" method="POST" style="display:inline"><button class="btn small bad" type="submit">Remove</button></form><hr style="border:0;border-top:1px solid var(--line);margin:16px 0"><p class="muted">To change the details, enter them again below.</p>` : '<p class="muted">Add your own paybill or till from the Safaricom Daraja portal (Go Live). Customers then pay straight into <b>your</b> account, not ours.</p>'}
            <form action="/pos/payments/mpesa" method="POST"><div class="grid2">
                <div class="field"><label for="t">Account type</label><select id="t" name="type"><option value="paybill">Paybill</option><option value="till">Till number (Buy Goods)</option></select></div>
                <div class="field"><label for="s">Business shortcode (paybill, or the till's head-office number)</label><input id="s" name="shortcode" required inputmode="numeric" maxlength="10" autocomplete="off"></div>
                <div class="field"><label for="tl">Till number (only for tills)</label><input id="tl" name="till" inputmode="numeric" maxlength="10" autocomplete="off"></div>
                <div class="field"><label for="k">Consumer key</label><input id="k" name="key" required maxlength="120" autocomplete="off"></div>
                <div class="field"><label for="x">Consumer secret</label><input id="x" name="secret" type="password" required maxlength="120" autocomplete="off"></div>
                <div class="field"><label for="pk">Lipa na M-Pesa passkey</label><input id="pk" name="passkey" type="password" required maxlength="200" autocomplete="off"></div></div>
                <button class="btn" type="submit">Save M-Pesa details</button></form></div>
        <div class="panel" style="max-width:720px"><h2>Other ways to take payment</h2>
            <p class="muted">Cash and M-Pesa code entry are always available. Add the others you accept, such as Airtel Money, card machine or bank transfer. The cashier records the payment reference. Automatic confirmation for these gateways needs a separate integration for each one.</p>
            ${methods.length ? `<table>${methods.map(m => `<tr><td>${esc(m.name)}</td><td>${m.needs_ref ? 'asks for a reference' : 'no reference'}</td><td class="right">${delPost('/pos/payments/methods/' + m.id + '/delete', 'Remove')}</td></tr>`).join('')}</table>` : '<p class="muted">None added yet.</p>'}
            <form action="/pos/payments/methods" method="POST" class="row" style="margin-top:12px"><div><label for="mn">Name</label><input id="mn" name="name" list="pl" required maxlength="30"><datalist id="pl">${presets.map(p => `<option value="${esc(p)}">`).join('')}</datalist></div><div style="flex:0 0 auto"><label><input type="checkbox" name="needs_ref" value="1" checked style="width:auto"> Ask for a reference</label></div><button class="btn" type="submit">Add</button></form></div>` });
    }));
    router.post('/payments/mpesa', ah(async (req, res) => {
        const b = req.body, type = b.type === 'till' ? 'till' : 'paybill';
        const shortcode = str(b.shortcode), till = str(b.till), key = str(b.key), secret = str(b.secret), passkey = str(b.passkey);
        if (!/^\d{4,10}$/.test(shortcode)) return back(res, '/pos/payments', '', 'The shortcode must be 4 to 10 digits.');
        if (type === 'till' && !/^\d{4,10}$/.test(till)) return back(res, '/pos/payments', '', 'Enter the till number.');
        if (!key || !secret || !passkey) return back(res, '/pos/payments', '', 'Enter the consumer key, consumer secret and passkey.');
        await q('UPDATE pos_businesses SET mpesa_enc=$2, mpesa_type=$3 WHERE id=$1', [req.shop.business_id, encrypt({ shortcode, till: type === 'till' ? till : '', key, secret, passkey }), type]);
        tokenCache.delete(req.shop.business_id);
        back(res, '/pos/payments', 'M-Pesa details saved. Use "Test connection" to check them.');
    }));
    router.post('/payments/mpesa/test', ah(async (req, res) => {
        const c = await mpesaCreds(req.shop.business_id);
        if (!c) return back(res, '/pos/payments', '', 'Add your M-Pesa details first.');
        try { await darajaToken(req.shop.business_id, c, true); back(res, '/pos/payments', 'Connected: Safaricom accepted your consumer key and secret.'); }
        catch (e) { back(res, '/pos/payments', '', e.message); }
    }));
    router.post('/payments/mpesa/remove', ah(async (req, res) => {
        await q('UPDATE pos_businesses SET mpesa_enc=NULL, mpesa_type=NULL WHERE id=$1', [req.shop.business_id]);
        tokenCache.delete(req.shop.business_id);
        back(res, '/pos/payments', 'M-Pesa details removed.');
    }));
    router.post('/payments/methods', ah(async (req, res) => {
        const name = str(req.body.name).replace(/[<>]/g, '').slice(0, 30);
        if (!name || /^(cash|mpesa|m-pesa)$/i.test(name)) return back(res, '/pos/payments', '', 'Choose a name other than Cash or M-Pesa; those are built in.');
        await q('INSERT INTO pos_pay_methods (business_id, name, needs_ref) VALUES ($1,$2,$3) ON CONFLICT (business_id, name) DO NOTHING', [req.shop.business_id, name, req.body.needs_ref === '1']);
        back(res, '/pos/payments', 'Payment method added.');
    }));
    router.post('/payments/methods/:id/delete', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_pay_methods WHERE id=$1 AND business_id=$2', [id, req.shop.business_id]);
        back(res, '/pos/payments', 'Removed. Past sales keep their payment type.');
    }));

    // ----- subscription (monthly fee, paid to Tencent's own paybill by STK push) -----
    router.get('/subscribe', ah(async (req, res) => {
        const live = req.business.active_until && new Date(req.business.active_until) > new Date();
        const nBranches = (await q('SELECT count(*)::int n FROM pos_shops WHERE business_id=$1 AND active', [req.shop.business_id])).rows[0].n;
        const fee = monthlyTotal(nBranches), extra = Math.max(0, nBranches - 1), payId = parseCount(req.query.pay, { min: 1 });
        const hist = (await q(`SELECT months, amount, status, receipt, created_at FROM pos_sub_payments WHERE business_id=$1 ORDER BY id DESC LIMIT 12`, [req.shop.business_id])).rows;
        send(req, res, { title: 'Subscription', nav: 'sub', body: `<h1>Subscription</h1>${notice(req)}${errBox(req)}
        <div class="panel" style="max-width:640px">
            ${live ? `<p><span class="tag ok">Active</span> Your POS is paid until <b>${esc(dateFmt(req.business.active_until))}</b>. Paying again adds time on top.</p>` : `<p><span class="tag warn">Not active</span> Pay the monthly subscription to switch on your POS. It includes all your branches and cashiers.</p>`}
            <table style="max-width:420px;margin-bottom:10px"><tr><td>Main shop</td><td class="num">KES ${subFee().toLocaleString('en-KE')}</td></tr>${extra ? `<tr><td>${extra} extra branch${extra > 1 ? 'es' : ''} × KES ${branchFee().toLocaleString('en-KE')}</td><td class="num">KES ${(extra * branchFee()).toLocaleString('en-KE')}</td></tr>` : ''}<tr><td><b>Per month</b></td><td class="num"><b>KES ${fee.toLocaleString('en-KE')}</b></td></tr></table><p class="muted" style="margin-top:0">Cashiers are unlimited. The amount follows the number of active branches when you pay.</p>
            ${payId ? `<div class="alert ok" id="paywait" role="status">Check your phone and enter your M-Pesa PIN. This page updates when the payment is confirmed.</div><div class="alert" id="payfail" role="alert" style="display:none"></div>` : ''}
            <form action="/pos/subscribe" method="POST"><div class="grid2">
                <div class="field"><label for="m">How long?</label><select id="m" name="months">${[1, 3, 6, 12].map(n => `<option value="${n}">${n} month${n > 1 ? 's' : ''}: KES ${(fee * n).toLocaleString('en-KE')}</option>`).join('')}</select></div>
                <div class="field"><label for="p">M-Pesa number to pay from</label><input id="p" name="phone" inputmode="tel" required value="${esc(req.session.user.phone || '')}" placeholder="0712345678"></div></div>
                <button class="btn ok" type="submit">Pay with M-Pesa</button></form>
            ${platform.mpesaConfigured() ? '' : '<p class="muted" style="margin-top:10px">Online payment is not switched on yet. Please call 0740 311 014 to pay.</p>'}</div>
        ${hist.length ? `<div class="panel tablewrap" style="max-width:640px"><h2>Payments</h2><table><tr><th>Date</th><th>Months</th><th class="num">Amount</th><th>Status</th><th>M-Pesa</th></tr>${hist.map(h => `<tr><td>${esc(dateFmt(h.created_at))}</td><td>${h.months}</td><td class="num">${h.amount.toLocaleString('en-KE')}</td><td><span class="tag ${h.status === 'paid' ? 'ok' : h.status === 'failed' ? 'bad' : 'warn'}">${esc(h.status)}</span></td><td>${esc(h.receipt)}</td></tr>`).join('')}</table></div>` : ''}
        ${payId ? `<script nonce="${req.nonce || ''}">(function(){var n=0;function poll(){if(++n>60){var w=document.getElementById('paywait');if(w)w.textContent='Still waiting. If you paid, refresh this page in a minute.';return;}
        fetch('/pos/subscribe/status/${payId}',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(s){if(s.status==='paid'){location.href='/pos/app?ok='+encodeURIComponent('Payment received. Your POS is active.');return;}
        if(s.status==='failed'){document.getElementById('paywait').style.display='none';var f=document.getElementById('payfail');f.textContent='The payment was not completed. You can try again.';f.style.display='block';return;}setTimeout(poll,3000);}).catch(function(){setTimeout(poll,4000);});}poll();})();</script>` : ''}` });
    }));
    router.post('/subscribe', saleLimiter, ah(async (req, res) => {
        const months = parseCount(req.body.months, { min: 1, max: 12 }), phone = platform.normalizePhone(String(req.body.phone || ''));
        if (![1, 3, 6, 12].includes(months)) return back(res, '/pos/subscribe', '', 'Choose how many months.');
        if (!phone) return back(res, '/pos/subscribe', '', 'Enter a valid M-Pesa number, for example 0712345678.');
        if (!platform.mpesaConfigured()) return back(res, '/pos/subscribe', '', 'Online payment is not switched on yet. Please call 0740 311 014.');
        const recent = await q(`SELECT 1 FROM pos_sub_payments WHERE business_id=$1 AND status='pending' AND created_at > now() - interval '60 seconds'`, [req.shop.business_id]);
        if (recent.rowCount) return back(res, '/pos/subscribe', '', 'A payment request was just sent. Please wait a minute before trying again.');
        const nb = (await q('SELECT count(*)::int n FROM pos_shops WHERE business_id=$1 AND active', [req.shop.business_id])).rows[0].n;
        const amount = monthlyTotal(nb) * months;
        const id = (await q('INSERT INTO pos_sub_payments (business_id, months, amount, phone) VALUES ($1,$2,$3,$4) RETURNING id', [req.shop.business_id, months, amount, phone])).rows[0].id;
        try {
            const d = await platform.stkPush({ amount, phone, ref: 'POS' + req.shop.business_id, desc: 'POS subscription' });
            await q('UPDATE pos_sub_payments SET checkout_id=$2 WHERE id=$1', [id, String(d.CheckoutRequestID || '')]);
            res.redirect('/pos/subscribe?pay=' + id);
        } catch (err) {
            await q(`UPDATE pos_sub_payments SET status='failed' WHERE id=$1`, [id]);
            console.error('POS subscription STK failed:', err.message);
            back(res, '/pos/subscribe', '', 'Could not send the M-Pesa request. Please try again, or call 0740 311 014.');
        }
    }));
    router.get('/subscribe/status/:id', ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        let r = id && (await q('SELECT * FROM pos_sub_payments WHERE id=$1 AND business_id=$2', [id, req.shop.business_id])).rows[0];
        if (!r) return res.status(404).json({ status: 'unknown' });
        if (r.status === 'pending' && r.checkout_id && Date.now() - new Date(r.created_at) > 25000 && (!r.last_query || Date.now() - new Date(r.last_query) > 12000)) {
            await q('UPDATE pos_sub_payments SET last_query=now() WHERE id=$1', [id]);
            try {
                const d = await platform.stkQuery(r.checkout_id);
                if (String(d.ResultCode) === '0') await completeSubPayment(id, '');
                else if (d.ResultCode !== undefined && String(d.ResultCode) !== '') await q(`UPDATE pos_sub_payments SET status='failed' WHERE id=$1 AND status='pending'`, [id]);
            } catch (_) { /* still processing */ }
            r = (await q('SELECT status FROM pos_sub_payments WHERE id=$1', [id])).rows[0];
        }
        res.json({ status: r.status });
    }));

    // ----- install as an app -----
    router.get('/install', (req, res) => send(req, res, { title: 'Install the app', nav: 'install', body: `<h1>Install Tencent POS as an app</h1>
        <div class="panel" style="max-width:680px"><p>The POS installs on your phone, tablet or computer and opens in its own window, like any other app. It needs the internet to save sales.</p>
            <p><button class="btn ok" id="install-main" type="button" style="padding:12px 20px;font-size:1rem">Install now</button></p>
            <div id="install-msg" class="alert" role="status" style="display:none"></div>
            <div id="install-ua" class="alert ok" style="display:none"></div>
            <h2>Android (Chrome)</h2><p>Open the menu (three dots) and tap <b>Install app</b> or <b>Add to Home screen</b>.</p>
            <h2>iPhone and iPad (Safari only)</h2><p>Tap the <b>Share</b> button, then <b>Add to Home Screen</b>. This only works in Safari, not in Chrome on iPhone.</p>
            <h2>Windows or Mac (Chrome or Edge)</h2><p>Click the install icon at the right of the address bar, or open the menu and choose <b>Install Tencent POS</b> (in Chrome: Cast, save and share, then Install page as app).</p>
            <h2>No install option showing?</h2><p class="muted">Open the website in Chrome or Edge directly. Links opened inside WhatsApp, Facebook or other apps can't install it. Private windows and Firefox on computers don't offer it either. If it is already installed, open it from your home screen or app list.</p>
            <p class="muted">Cashiers can install it too: log in on their device and follow the same steps.</p></div>
        <script nonce="${req.nonce || ''}">(function(){var ua=navigator.userAgent||'',m=document.getElementById('install-msg'),u=document.getElementById('install-ua'),b=document.getElementById('install-main');
        var ios=/iPhone|iPad|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),inapp=/FBAN|FBAV|Instagram|WhatsApp/.test(ua);
        var standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true;
        if(standalone){b.style.display='none';u.textContent='You are already using the installed app.';u.style.display='block';return;}
        if(ios){u.textContent='On this iPhone/iPad: tap the Share button in Safari, then "Add to Home Screen".';u.style.display='block';}
        else if(inapp){u.textContent='You opened this inside another app. Open the website in Chrome or Edge to install.';u.style.display='block';}
        b.addEventListener('click',function(){if(!window.__tposInstall()){m.textContent=ios?'Use Share, then Add to Home Screen in Safari.':'Your browser has not offered the install prompt yet. Use the browser menu as shown below (Install app, or Add to Home screen), or open this site in Chrome or Edge.';m.style.display='block';}});})();</script>` }));

    // ======================= EXTRA PAGES =======================
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
        <div class="panel" style="max-width:720px"><h1 style="margin-bottom:4px">Quotation #${c.quote_no}</h1><p><b>${esc(sh.name)}</b><br>${esc(sh.address)}${sh.phone ? '<br>Tel ' + esc(sh.phone) : ''}${sh.tax_pin ? '<br>PIN ' + esc(sh.tax_pin) : ''}</p>
        <p>Date: ${esc(dateFmt(c.created_at))}${c.valid_until ? '<br>Valid until: ' + esc(dateFmt(isoDate(c.valid_until) + 'T12:00:00+03:00')) : ''}<br>Customer: ${esc(c.customer_name || '-')} ${esc(c.customer_phone)}<br>Status: ${esc(c.status)}</p>
        <table><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr>${lines.map(l => `<tr><td>${esc(l.name)}</td><td class="num">${l.qty}</td><td class="num">${fmt(l.unit_price_cents)}</td><td class="num">${fmt(l.qty * Number(l.unit_price_cents))}</td></tr>`).join('')}<tr><td colspan="3">Subtotal (before VAT)</td><td class="num">${fmt(total)}</td></tr>${sh.vat_rate > 0 ? `<tr><td colspan="3">VAT ${sh.vat_rate}%</td><td class="num">${fmt(vatOf(total, sh.vat_rate))}</td></tr>` : ''}<tr><td colspan="3"><b>Total (KES)</b></td><td class="num"><b>${fmt(total + vatOf(total, sh.vat_rate))}</b></td></tr></table>${c.note ? '<p>' + esc(c.note) + '</p>' : ''}</div>
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
}


// Called from server.js when Safaricom reports a payment that is not a survey booking: it may be a POS subscription.
async function completeSubPayment(id, receipt) {
    const pool = _ctx.getPool();
    const p = (await pool.query(`UPDATE pos_sub_payments SET status='paid', receipt=$2 WHERE id=$1 AND status <> 'paid' RETURNING *`, [id, String(receipt || '').slice(0, 40)])).rows[0];
    if (!p) return;   // already counted, so duplicate callbacks and polls add nothing
    const b = (await pool.query(`UPDATE pos_businesses SET active_until = GREATEST(COALESCE(active_until, now()), now()) + ($2 || ' months')::interval WHERE id=$1 RETURNING name, active_until`, [p.business_id, String(p.months)])).rows[0];
    if (_ctx.platform && _ctx.platform.notify && b) _ctx.platform.notify(`✅ POS subscription paid: ${b.name}`, { Business: b.name, Months: String(p.months), Amount: 'KES ' + p.amount, 'M-Pesa receipt': receipt || '(see statement)', 'Active until': new Date(b.active_until).toISOString().slice(0, 10) }).catch(() => {});
}
async function handlePlatformCallback(cb) {
    if (!_ctx.getPool) return false;
    const pool = _ctx.getPool();
    const r = (await pool.query('SELECT * FROM pos_sub_payments WHERE checkout_id=$1', [String(cb.CheckoutRequestID || '')])).rows[0];
    if (!r) return false;
    if (Number(cb.ResultCode) !== 0) { await pool.query(`UPDATE pos_sub_payments SET status='failed' WHERE id=$1 AND status='pending'`, [r.id]); return true; }
    const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const meta = n => { const it = items.find(i => i.Name === n); return it ? it.Value : undefined; };
    if (Number(meta('Amount')) !== r.amount) {
        console.error('POS subscription amount mismatch, not activated');
        if (_ctx.platform && _ctx.platform.notify) _ctx.platform.notify('⚠️ CHECK POS PAYMENT: amount mismatch', { 'Business id': String(r.business_id), Expected: String(r.amount), Reported: String(meta('Amount')), 'M-Pesa receipt': String(meta('MpesaReceiptNumber') || '') }).catch(() => {});
        return true;
    }
    await completeSubPayment(r.id, String(meta('MpesaReceiptNumber') || ''));
    return true;
}

module.exports = mountPos;
module.exports.initSchema = initSchema;
module.exports.handlePlatformCallback = handlePlatformCallback;
