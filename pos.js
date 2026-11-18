'use strict';
// ---------------------------------------------------------------------------
// Tencent POS: Complete Implementation (Multi-Branch, Cashiers, VAT, PWA & Stk)
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');

const TZ = 'Africa/Nairobi';

async function initSchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_shops (
            id SERIAL PRIMARY KEY,
            owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            parent_shop_id INT REFERENCES pos_shops(id) ON DELETE CASCADE,
            name VARCHAR(120) NOT NULL,
            phone VARCHAR(40) NOT NULL DEFAULT '',
            address VARCHAR(200) NOT NULL DEFAULT '',
            tax_pin VARCHAR(40) NOT NULL DEFAULT '',
            receipt_footer VARCHAR(200) NOT NULL DEFAULT 'Thank you for shopping with us!',
            logo_data TEXT NOT NULL DEFAULT '',
            vat_rate NUMERIC(5,2) NOT NULL DEFAULT 16.00,
            next_receipt INT NOT NULL DEFAULT 1,
            next_po INT NOT NULL DEFAULT 1,
            next_quote INT NOT NULL DEFAULT 1,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            subscription_expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

    await pool.query('ALTER TABLE pos_shops DROP CONSTRAINT IF EXISTS pos_shops_owner_id_key');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS parent_shop_id INT REFERENCES pos_shops(id) ON DELETE CASCADE');
    await pool.query("ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS logo_data TEXT NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2) NOT NULL DEFAULT 16.00');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS next_po INT NOT NULL DEFAULT 1');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS next_quote INT NOT NULL DEFAULT 1');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_staff (
            id SERIAL PRIMARY KEY,
            shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE,
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role VARCHAR(20) NOT NULL DEFAULT 'cashier',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (shop_id, user_id)
        )`);
    await pool.query('CREATE INDEX IF NOT EXISTS pos_staff_user_idx ON pos_staff (user_id, active)');

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
            cashier_user_id INT REFERENCES users(id) ON DELETE SET NULL,
            receipt_no INT NOT NULL,
            subtotal_cents BIGINT NOT NULL,
            discount_cents BIGINT NOT NULL DEFAULT 0,
            vat_cents BIGINT NOT NULL DEFAULT 0,
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
    await pool.query('ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS cashier_user_id INT REFERENCES users(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS vat_cents BIGINT NOT NULL DEFAULT 0');
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

    const T = [
        `CREATE TABLE IF NOT EXISTS pos_suppliers (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, name VARCHAR(120) NOT NULL, phone VARCHAR(40) NOT NULL DEFAULT '', email VARCHAR(160) NOT NULL DEFAULT '', address VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        `CREATE TABLE IF NOT EXISTS pos_purchase_orders (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, supplier_id INT REFERENCES pos_suppliers(id) ON DELETE SET NULL, po_no INT NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'open', note VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), received_at TIMESTAMPTZ, UNIQUE (shop_id, po_no))`,
        `CREATE TABLE IF NOT EXISTS pos_po_lines (id SERIAL PRIMARY KEY, po_id INT NOT NULL REFERENCES pos_purchase_orders(id) ON DELETE CASCADE, item_id INT NOT NULL REFERENCES pos_items(id) ON DELETE CASCADE, qty INT NOT NULL, cost_cents BIGINT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS pos_quotes (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, quote_no INT NOT NULL, customer_name VARCHAR(120) NOT NULL DEFAULT '', customer_phone VARCHAR(40) NOT NULL DEFAULT '', valid_until DATE, status VARCHAR(10) NOT NULL DEFAULT 'open', note VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (shop_id, quote_no))`,
        `CREATE TABLE IF NOT EXISTS pos_quote_lines (id SERIAL PRIMARY KEY, quote_id INT NOT NULL REFERENCES pos_quotes(id) ON DELETE CASCADE, name VARCHAR(120) NOT NULL, qty INT NOT NULL, unit_price_cents BIGINT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS pos_drawer (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, opened_by INT REFERENCES users(id) ON DELETE SET NULL, opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), opening_cents BIGINT NOT NULL DEFAULT 0, closed_at TIMESTAMPTZ, expected_cents BIGINT, counted_cents BIGINT, note VARCHAR(200) NOT NULL DEFAULT '')`,
        `CREATE UNIQUE INDEX IF NOT EXISTS pos_drawer_one_open ON pos_drawer (shop_id) WHERE closed_at IS NULL`,
        `CREATE TABLE IF NOT EXISTS pos_drawer_moves (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, drawer_id INT NOT NULL REFERENCES pos_drawer(id) ON DELETE CASCADE, kind VARCHAR(3) NOT NULL, amount_cents BIGINT NOT NULL, note VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        `CREATE TABLE IF NOT EXISTS pos_expense_cats (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, name VARCHAR(60) NOT NULL, UNIQUE (shop_id, name))`,
        `CREATE TABLE IF NOT EXISTS pos_recurring (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, category VARCHAR(60) NOT NULL, amount_cents BIGINT NOT NULL, note VARCHAR(200) NOT NULL DEFAULT '', day_of_month INT NOT NULL, last_run DATE)`,
        `CREATE TABLE IF NOT EXISTS pos_budgets (shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, category VARCHAR(60) NOT NULL, amount_cents BIGINT NOT NULL, PRIMARY KEY (shop_id, category))`,
        `CREATE TABLE IF NOT EXISTS pos_assets (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, name VARCHAR(120) NOT NULL, cost_cents BIGINT NOT NULL, bought_on DATE NOT NULL, life_years INT NOT NULL DEFAULT 5, salvage_cents BIGINT NOT NULL DEFAULT 0, note VARCHAR(200) NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS pos_notes (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, title VARCHAR(120) NOT NULL, body VARCHAR(4000) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
        `CREATE TABLE IF NOT EXISTS pos_mpesa_configs (shop_id INT PRIMARY KEY REFERENCES pos_shops(id) ON DELETE CASCADE, env VARCHAR(15) NOT NULL DEFAULT 'production', shortcode VARCHAR(20) NOT NULL DEFAULT '', passkey_enc TEXT NOT NULL DEFAULT '', consumer_key_enc TEXT NOT NULL DEFAULT '', consumer_secret_enc TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    ];
    for (const sql of T) await pool.query(sql);
    await pool.query('ALTER TABLE pos_drawer ADD COLUMN IF NOT EXISTS opened_by INT REFERENCES users(id) ON DELETE SET NULL');
}

function getEncryptionKey(secret) {
    return crypto.createHash('sha256').update(String(secret || 'tencent-pos-secure-fallback')).digest();
}
function encryptSecret(text, secret) {
    if (!text) return '';
    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(secret), iv);
        const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, encrypted]).toString('base64');
    } catch { return ''; }
}

const fmt = cents => (Number(cents) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kes = cents => 'KES ' + fmt(cents);

function calcInclusiveVat(totalCents, vatRate = 16) {
    const t = Number(totalCents) || 0;
    const r = Number(vatRate) || 0;
    if (r <= 0 || t <= 0) return { net: t, vat: 0 };
    const net = Math.round(t / (1 + r / 100));
    return { net, vat: t - net };
}

function parseMoney(v) {
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
const csvCell = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
};
const timeFmt = d => new Date(d).toLocaleString('en-KE', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateFmt = d => new Date(d).toLocaleDateString('en-KE', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
const isoDate = d => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString() : String(d)).slice(0, 10);
function assetBookValue(a, todayIso) {
    const cost = Number(a.cost_cents), salv = Number(a.salvage_cents), days = (new Date(todayIso) - new Date(isoDate(a.bought_on))) / 86400000;
    const dep = (cost - salv) * Math.max(0, days) / (a.life_years * 365);
    return Math.max(salv, Math.round(cost - dep));
}

function mountPos({ app, getPool, esc, str, ah, rateLimit, requireAuth, requireDb, requireVerified, renderPage, bcrypt, sessionSecret }) {
    const pool = () => getPool();
    const router = express.Router();
    const q = (text, params) => pool().query(text, params);
    const logoBodyParser = express.urlencoded({ extended: false, limit: '450kb' });

    const NAV = [
        ['Main', [['app', '/pos/app', 'Dashboard', false], ['terminal', '/pos/terminal', 'POS Terminal', true], ['sales', '/pos/sales', 'Sales History', true], ['daily', '/pos/daily', 'Daily Sales (Z-Report)', false], ['drawer', '/pos/drawer', 'Cash Drawer', true], ['quotes', '/pos/quotes', 'Quotes', false]]],
        ['Inventory', [['items', '/pos/items', 'Items', false], ['categories', '/pos/categories', 'Categories', false], ['stock', '/pos/stock', 'Stock In / Out & Adjustment', false], ['history', '/pos/stock/history', 'Stock History', false], ['low', '/pos/stock/low', 'Low Stock Alerts', false], ['suppliers', '/pos/suppliers', 'Suppliers', false], ['po', '/pos/purchase-orders', 'Purchase Orders', false]]],
        ['Money', [['expenses', '/pos/expenses', 'Expenses', false], ['ecats', '/pos/expense-categories', 'Expense Categories', false], ['recurring', '/pos/recurring', 'Recurring Expenses', false], ['budgets', '/pos/budgets', 'Budgets', false], ['assets', '/pos/assets', 'Assets', false], ['reports', '/pos/reports', 'Reports', false], ['notebook', '/pos/notebook', 'Notebook', false]]],
        ['Shop & Team', [['branches', '/pos/branches', 'Branches', false], ['staff', '/pos/staff', 'Cashiers & Staff', false], ['settings', '/pos/settings', 'Shop Settings', false], ['mpesa', '/pos/settings/mpesa', 'M-Pesa API', false], ['subscribe', '/pos/subscribe', 'Subscription & PWA', false]]]
    ];

    function layout(req, { title, nav = '', body }) {
        const shop = req.shop;
        const isCashier = req.posRole === 'cashier';
        const accessible = req.accessibleShops || [];

        const links = NAV.map(([group, items]) => {
            const visible = items.filter(([, , , cashierAllowed]) => !isCashier || cashierAllowed);
            if (!visible.length) return '';
            return `<div class="nav-group">${esc(group)}</div>` +
                visible.map(([key, href, label]) => `<a href="${href}" class="${nav === key ? 'active' : ''}">${esc(label)}</a>`).join('');
        }).join('');

        const branchSwitcher = accessible.length > 1 ? `
            <form action="/pos/switch-shop" method="POST" style="padding:0 10px 10px;margin:0;border-bottom:1px solid #1e3a56;">
                <label for="sw-shop" style="color:#7dd3fc;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Active Branch</label>
                <select id="sw-shop" name="shop_id" style="padding:6px 8px;font-size:.82rem;background:#12304d;color:#fff;border-color:#2b537a;">
                    ${accessible.map(s => `<option value="${s.id}" ${s.id === shop.id ? 'selected' : ''}>${esc(s.name)} (${esc(s.role)})</option>`).join('')}
                </select>
                <button class="btn small" type="submit" style="width:100%;margin-top:6px;padding:4px 8px;">Switch Branch</button>
            </form>` : '';

        return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(shop ? shop.name : 'Tencent POS')}</title>
<link rel="manifest" href="/pos/manifest.webmanifest">
<meta name="theme-color" content="#0b1b2e">
<style>
:root{--bg:#f1f5f9;--panel:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--side:#0b1b2e;--side2:#12304d;--accent:#0ea5e9;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--radius:10px}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.45}
a{color:#0369a1}.side{position:fixed;inset:0 auto 0 0;width:236px;background:var(--side);color:#cbd5e1;overflow-y:auto;padding:14px 10px 24px;z-index:30}
.side .brand{display:block;color:#fff;font-weight:800;font-size:1.05rem;padding:6px 10px 2px;text-decoration:none}.side .shopname{padding:0 10px 10px;font-size:.82rem;color:#7dd3fc;border-bottom:1px solid #1e3a56;margin-bottom:6px}
.nav-group{font-size:.7rem;letter-spacing:.06em;color:#6b87a6;padding:14px 10px 4px;text-transform:uppercase}
.side a{display:block;color:#cbd5e1;text-decoration:none;padding:8px 10px;border-radius:7px;font-size:.92rem}.side a:hover{background:var(--side2)}.side a.active{background:var(--accent);color:#04223a;font-weight:700}
.side form.logout-f{margin:10px 0 0}.side .linkbtn{width:100%;text-align:left;background:none;border:0;color:#fca5a5;padding:8px 10px;cursor:pointer;font:inherit;font-size:.92rem;border-radius:7px}.side .linkbtn:hover{background:var(--side2)}
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
.receipt-logo{max-width:140px;max-height:70px;object-fit:contain;margin:0 auto 8px;display:block}
@media(max-width:860px){.side{transform:translateX(-100%);transition:transform .2s;width:260px}.side.open{transform:none}.main{margin-left:0;padding:14px 14px 60px}.top{display:flex;align-items:center;gap:12px;background:var(--side);color:#fff;margin:-14px -14px 14px;padding:10px 14px;position:sticky;top:0;z-index:20}.top button{background:none;border:1px solid #3b5878;color:#fff;border-radius:7px;padding:6px 12px;font-size:1.1rem;cursor:pointer}}
@media print{.side,.top,.noprint{display:none!important}.main{margin:0;padding:0}body{background:#fff}.panel{border:0;padding:0}}
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
<div class="top noprint"><button type="button" id="side-btn" aria-label="Open menu" aria-expanded="false">&#9776;</button><strong>${esc(shop ? shop.name : 'Tencent POS')}</strong></div>
<nav class="side" id="side" aria-label="POS menu">
<a class="brand" href="${isCashier ? '/pos/terminal' : '/pos/app'}">Tencent POS</a>
<div class="shopname">${esc(shop ? shop.name : '')} ${req.posRole ? `<span class="tag gray" style="font-size:.65rem;margin-left:4px">${esc(req.posRole)}</span>` : ''}</div>
${branchSwitcher}
${links}
<div class="nav-group">Account</div><a href="/">Back to website</a>
<form class="logout-f" action="/logout" method="POST"><button class="linkbtn" type="submit">Log out</button></form>
</nav>
<main class="main">${body}</main>
<script nonce="${req.nonce || ''}">
(function(){var b=document.getElementById('side-btn'),s=document.getElementById('side');if(b)b.addEventListener('click',function(){var o=s.classList.toggle('open');b.setAttribute('aria-expanded',o?'true':'false');});
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/pos/sw.js').catch(function(){}); }
})();
</script>
</body></html>`;
    }
    const send = (req, res, opts, status = 200) => res.status(status).set('Cache-Control', 'no-store').send(layout(req, opts));
    const notice = (req) => req.query.ok ? `<div class="alert ok" role="status">${esc(String(req.query.ok).slice(0, 120))}</div>` : '';

    router.get('/manifest.webmanifest', (req, res) => {
        const name = req.shop ? req.shop.name : 'Tencent POS';
        res.set('Content-Type', 'application/manifest+json').json({
            name: name, short_name: 'Tencent POS', start_url: '/pos/terminal', display: 'standalone',
            background_color: '#f1f5f9', theme_color: '#0b1b2e',
            icons: [{ src: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%230ea5e9%22><path d=%22M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z%22/></svg>', sizes: '192x192 512x512', type: 'image/svg+xml' }]
        });
    });

    router.get('/sw.js', (req, res) => {
        res.set('Content-Type', 'application/javascript').send(`
            self.addEventListener('install', function(e) { self.skipWaiting(); });
            self.addEventListener('activate', function(e) { e.waitUntil(clients.claim()); });
            self.addEventListener('fetch', function(e) {
                if (e.request.method !== 'GET') return;
                e.respondWith(fetch(e.request).catch(function() { return caches.match(e.request); }));
            });
        `);
    });

    router.use(requireAuth, requireDb, requireVerified);

    async function loadUserShops(userId) {
        const owned = await q(`SELECT *, 'owner' AS role FROM pos_shops WHERE owner_id = $1 ORDER BY parent_shop_id NULLS FIRST, id ASC`, [userId]);
        const staffed = await q(`
            SELECT s.*, st.role FROM pos_shops s JOIN pos_staff st ON st.shop_id = s.id
            WHERE st.user_id = $1 AND st.active = TRUE AND s.owner_id <> $1 ORDER BY s.id ASC`, [userId]);
        return [...owned.rows, ...staffed.rows];
    }

    router.get('/setup', ah(async (req, res) => {
        const shops = await loadUserShops(req.session.user.id);
        if (shops.length) return res.redirect('/pos/app');
        send(req, res, { title: 'Set up your business', body: `<h1>Set up your business</h1><div class="panel" style="max-width:560px;"><form action="/pos/setup" method="POST">
            <div class="field"><label for="n">Business Name</label><input id="n" name="name" required maxlength="120" placeholder="e.g. Mama Achieng Enterprises"></div>
            <div class="field"><label for="p">Phone</label><input id="p" name="phone" maxlength="40" value="${esc(req.session.user.phone || '')}"></div>
            <div class="field"><label for="a">Address / Location</label><input id="a" name="address" maxlength="200" placeholder="Rangwe Market"></div>
            <button class="btn" type="submit">Create Business</button>
        </form></div>` });
    }));
    router.post('/setup', ah(async (req, res) => {
        const shops = await loadUserShops(req.session.user.id);
        if (shops.length) return res.redirect('/pos/app');
        const name = str(req.body.name).slice(0, 120);
        if (name.length < 2) return res.redirect('/pos/setup');
        const r = await q('INSERT INTO pos_shops (owner_id, name, phone, address, subscription_expires_at) VALUES ($1, $2, $3, $4, now() + interval \'30 days\') RETURNING id', [req.session.user.id, name, str(req.body.phone).slice(0, 40), str(req.body.address).slice(0, 200)]);
        req.session.posShopId = r.rows[0].id;
        res.redirect('/pos/app');
    }));

    router.post('/switch-shop', ah(async (req, res) => {
        const targetId = parseCount(req.body.shop_id, { min: 1 });
        const shops = await loadUserShops(req.session.user.id);
        const match = shops.find(s => s.id === targetId);
        if (match) req.session.posShopId = match.id;
        res.redirect(match && match.role === 'cashier' ? '/pos/terminal' : '/pos/app');
    }));

    router.use(ah(async (req, res, next) => {
        const shops = await loadUserShops(req.session.user.id);
        if (!shops.length) return res.redirect('/pos/setup');
        req.accessibleShops = shops;
        const selected = shops.find(s => s.id === req.session.posShopId) || shops[0];
        req.session.posShopId = selected.id;
        req.shop = selected;
        req.posRole = selected.role;

        if (!selected.active) {
            return send(req, res, { title: 'Paused', body: '<h1>This branch is paused</h1><div class="panel"><p>Contact Tencent Innovations on 0740 311 014.</p></div>' }, 403);
        }

        const subExpires = selected.subscription_expires_at ? new Date(selected.subscription_expires_at) : null;
        const isExpired = !subExpires || subExpires < new Date();
        const allowedPath = req.path.startsWith('/subscribe') || req.path.startsWith('/branches') || req.path === '/manifest.webmanifest' || req.path === '/sw.js';

        if (isExpired && !allowedPath && req.posRole === 'owner') {
            return res.redirect('/pos/subscribe?err=' + encodeURIComponent('Your monthly subscription has expired. Please renew to continue.'));
        }
        next();
    }));

    const requireManager = (req, res, next) => {
        if (req.posRole === 'cashier') return res.redirect('/pos/terminal');
        next();
    };
    const requireOwner = (req, res, next) => {
        if (req.posRole !== 'owner') return send(req, res, { title: 'Owner access only', nav: 'app', body: '<h1>Owner access required</h1><div class="panel"><p>Only the business owner account can manage branches and settings.</p></div>' }, 403);
        next();
    };

    // ----- Dashboard -----
    router.get('/app', requireManager, ah(async (req, res) => {
        const sid = req.shop.id, today = todayNairobi(), monthStart = today.slice(0, 8) + '01', yearStart = today.slice(0, 5) + '01-01';
        const [m, inv, low, exp, expY, assets, sup, moves, recentExp] = await Promise.all([
            q(`SELECT count(*)::int n, COALESCE(sum(total_cents),0)::bigint total, COALESCE(sum(vat_cents),0)::bigint vat FROM pos_sales WHERE shop_id=$1 AND status='completed' AND (created_at AT TIME ZONE '${TZ}')::date >= $2`, [sid, monthStart]),
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
        <h1>Dashboard — ${esc(req.shop.name)}</h1>${notice(req)}
        <div class="cards">
            <div class="stat c1"><span>Total items</span><b>${I.n}</b></div>
            <div class="stat c2"><span>Inventory value</span><b>${kes(I.value)}</b></div>
            <div class="stat c3"><span>Sales this month (Incl. VAT)</span><b>${kes(M.total)}</b><span>${M.n} sale${M.n === 1 ? '' : 's'} · VAT ${kes(M.vat)}</span></div>
            <div class="stat c4"><span>Expenses this month</span><b>${kes(exp.rows[0].total)}</b></div>
            <div class="stat ${low.rows[0].n ? 'c9' : 'c2'}"><span>Low stock alerts</span><b>${low.rows[0].n}</b><a href="/pos/stock/low" style="color:#fff">View</a></div>
            <div class="stat c5"><span>Total assets</span><b>${assets.rows.length}</b></div>
            <div class="stat c7"><span>Assets value</span><b>${kes(assetValue)}</b></div>
            <div class="stat c8"><span>Suppliers</span><b>${sup.rows[0].n}</b></div>
            <div class="stat c6"><span>Expenses this year</span><b>${kes(expY.rows[0].total)}</b></div>
        </div>
        <div class="panel"><h2>Quick actions</h2><div class="row" style="align-items:center">
            <a class="btn ok" href="/pos/terminal" style="flex:0 0 auto">POS Terminal</a><a class="btn" href="/pos/items/new" style="flex:0 0 auto">Add item</a>
            <a class="btn ghost" href="/pos/branches" style="flex:0 0 auto">Branches</a><a class="btn ghost" href="/pos/staff" style="flex:0 0 auto">Cashiers</a>
            <a class="btn ghost" href="/pos/subscribe" style="flex:0 0 auto">Subscription & PWA</a><a class="btn ghost" href="/pos/settings/mpesa" style="flex:0 0 auto">M-Pesa API</a></div></div>`;
        send(req, res, { title: 'Dashboard', nav: 'app', body });
    }));

    // ----- Branches -----
    router.get('/branches', requireManager, ah(async (req, res) => {
        const rootId = req.shop.parent_shop_id || req.shop.id;
        const branches = (await q(`
            SELECT s.id, s.name, s.phone, s.address, s.parent_shop_id,
                   (SELECT count(*)::int FROM pos_staff st WHERE st.shop_id = s.id AND st.active) AS staff_count,
                   (SELECT COALESCE(sum(total_cents),0)::bigint FROM pos_sales sa WHERE sa.shop_id = s.id AND sa.status = 'completed' AND (sa.created_at AT TIME ZONE '${TZ}')::date = $2) AS today_sales
            FROM pos_shops s WHERE s.id = $1 OR s.parent_shop_id = $1 ORDER BY s.parent_shop_id NULLS FIRST, s.id ASC`, [rootId, todayNairobi()])).rows;
        const createPanel = req.posRole === 'owner' ? `
        <div class="panel"><h2>Open a Linked Branch Account</h2><form action="/pos/branches" method="POST">
            <div class="grid2"><div class="field"><label for="bn">Branch Name</label><input id="bn" name="name" required maxlength="120" placeholder="Branch Name"></div>
            <div class="field"><label for="bp">Phone</label><input id="bp" name="phone" maxlength="40" value="${esc(req.shop.phone)}"></div>
            <div class="field"><label for="ba">Address</label><input id="ba" name="address" maxlength="200" placeholder="Location"></div>
            <div class="field"><label><input type="checkbox" name="copy_catalog" value="1" checked style="width:auto"> Copy item catalog</label></div></div>
            <button class="btn" type="submit">Create Branch</button>
        </form></div>` : '';
        send(req, res, { title: 'Branches', nav: 'branches', body: `<h1>Business Branches</h1>${notice(req)}${createPanel}
        <div class="panel tablewrap"><table><tr><th>Name</th><th>Type</th><th>Address</th><th>Phone</th><th class="num">Staff</th><th class="num">Today's Sales</th><th></th></tr>
        ${branches.map(b => `<tr><td><b>${esc(b.name)}</b> ${b.id === req.shop.id ? '<span class="tag ok">Active</span>' : ''}</td><td>${b.parent_shop_id ? '<span class="tag gray">Branch</span>' : '<span class="tag warn">HQ</span>'}</td><td>${esc(b.address || '-')}</td><td>${esc(b.phone || '-')}</td><td class="num">${b.staff_count}</td><td class="num">${kes(b.today_sales)}</td><td class="right nowrap">${b.id !== req.shop.id ? `<form action="/pos/switch-shop" method="POST" style="display:inline"><input type="hidden" name="shop_id" value="${b.id}"><button class="btn small ghost" type="submit">Open</button></form>` : ''}</td></tr>`).join('')}</table></div>` });
    }));
    router.post('/branches', requireOwner, ah(async (req, res) => {
        const rootShop = (await q('SELECT * FROM pos_shops WHERE id = $1', [req.shop.parent_shop_id || req.shop.id])).rows[0];
        const name = str(req.body.name).slice(0, 120);
        if (name.length < 2) return res.redirect('/pos/branches');
        const ins = await q(`INSERT INTO pos_shops (owner_id, parent_shop_id, name, phone, address, tax_pin, receipt_footer, logo_data, vat_rate, subscription_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [req.session.user.id, rootShop.id, name, str(req.body.phone).slice(0, 40), str(req.body.address).slice(0, 200), rootShop.tax_pin, rootShop.receipt_footer, rootShop.logo_data, rootShop.vat_rate, rootShop.subscription_expires_at]);
        req.session.posShopId = ins.rows[0].id;
        res.redirect('/pos/branches?ok=' + encodeURIComponent('Branch created successfully.'));
    }));

    // ----- Staff -----
    router.get('/staff', requireManager, ah(async (req, res) => {
        const staff = (await q(`SELECT st.id, st.role, st.active, u.name, u.email, u.phone FROM pos_staff st JOIN users u ON u.id = st.user_id WHERE st.shop_id = $1 ORDER BY st.created_at ASC`, [req.shop.id])).rows;
        send(req, res, { title: 'Cashiers & Staff', nav: 'staff', body: `<h1>Cashiers & Staff</h1>${notice(req)}
        <div class="panel"><form action="/pos/staff" method="POST"><div class="grid2">
            <div class="field"><label for="se">Email Address</label><input id="se" name="email" type="email" required placeholder="cashier@example.com"></div>
            <div class="field"><label for="sr">Role</label><select id="sr" name="role"><option value="cashier">Cashier</option><option value="manager">Manager</option></select></div>
            <div class="field"><label for="sn">Full Name (if new)</label><input id="sn" name="name" placeholder="Name"></div>
            <div class="field"><label for="sp">Phone (if new)</label><input id="sp" name="phone" placeholder="0712345678"></div>
            <div class="field"><label for="spw">Password (if new)</label><input id="spw" name="password" type="password"></div></div>
            <button class="btn" type="submit">Register Staff</button>
        </form></div>
        <div class="panel tablewrap"><table><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Status</th><th></th></tr>
        ${staff.map(s => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.email)}</td><td>${esc(s.phone)}</td><td>${esc(s.role)}</td><td>${s.active ? 'Active' : 'Disabled'}</td><td class="right"><form action="/pos/staff/${s.id}/toggle" method="POST" style="display:inline"><button class="btn small ghost" type="submit">Toggle</button></form></td></tr>`).join('')}</table></div>` });
    }));
    router.post('/staff', requireManager, ah(async (req, res) => {
        const email = str(req.body.email).toLowerCase().slice(0, 254);
        const role = req.body.role === 'manager' ? 'manager' : 'cashier';
        let userRow = (await q('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0];
        if (!userRow && bcrypt) {
            const hash = await bcrypt.hash(str(req.body.password) || 'password123', 11);
            userRow = (await q('INSERT INTO users (name, email, phone, password_hash, email_verified) VALUES ($1, $2, $3, $4, TRUE) RETURNING id', [str(req.body.name) || 'Cashier', email, str(req.body.phone), hash])).rows[0];
        }
        if (userRow) {
            await q('INSERT INTO pos_staff (shop_id, user_id, role, active) VALUES ($1, $2, $3, TRUE) ON CONFLICT (shop_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = TRUE', [req.shop.id, userRow.id, role]);
        }
        res.redirect('/pos/staff?ok=' + encodeURIComponent('Staff added.'));
    }));
    router.post('/staff/:id/toggle', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('UPDATE pos_staff SET active = NOT active WHERE id = $1 AND shop_id = $2', [id, req.shop.id]);
        res.redirect('/pos/staff');
    }));

    // ----- Categories & Items -----
    router.get('/categories', requireManager, ah(async (req, res) => {
        const r = await q('SELECT id, name FROM pos_categories WHERE shop_id=$1 ORDER BY name', [req.shop.id]);
        send(req, res, { title: 'Categories', nav: 'categories', body: `<h1>Categories</h1>${notice(req)}
        <div class="panel"><form action="/pos/categories" method="POST" class="row"><div><label>Name</label><input name="name" required></div><button class="btn" type="submit">Add</button></form></div>
        <div class="panel"><table>${r.rows.map(c => `<tr><td>${esc(c.name)}</td></tr>`).join('')}</table></div>` });
    }));
    router.post('/categories', requireManager, ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 80);
        if (name) await q('INSERT INTO pos_categories (shop_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.shop.id, name]);
        res.redirect('/pos/categories');
    }));

    router.get('/items', requireManager, ah(async (req, res) => {
        const r = await q('SELECT * FROM pos_items WHERE shop_id=$1 AND active ORDER BY name LIMIT 500', [req.shop.id]);
        send(req, res, { title: 'Items', nav: 'items', body: `<h1>Items</h1>${notice(req)}<p><a class="btn" href="/pos/items/new">Add Item</a></p>
        <div class="panel tablewrap"><table><tr><th>Name</th><th class="num">Price (Incl. VAT)</th><th class="num">Stock</th></tr>${r.rows.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${fmt(i.price_cents)}</td><td class="num">${i.stock}</td></tr>`).join('')}</table></div>` });
    }));
    router.get('/items/new', requireManager, (req, res) => {
        send(req, res, { title: 'Add Item', nav: 'items', body: `<h1>Add Item</h1><div class="panel" style="max-width:520px"><form action="/pos/items/new" method="POST">
            <div class="field"><label>Name</label><input name="name" required></div>
            <div class="field"><label>Selling Price (KES, Incl. VAT)</label><input name="price" required inputmode="decimal"></div>
            <div class="field"><label>Cost</label><input name="cost" inputmode="decimal" value="0"></div>
            <div class="field"><label>Opening Stock</label><input name="stock" inputmode="numeric" value="0"></div>
            <button class="btn" type="submit">Save Item</button>
        </form></div>` });
    });
    router.post('/items/new', requireManager, ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120), price = parseMoney(req.body.price), cost = parseMoney(req.body.cost) || 0, stock = parseCount(req.body.stock) || 0;
        if (!name || price === null) return res.redirect('/pos/items/new');
        await q('INSERT INTO pos_items (shop_id, name, price_cents, cost_cents, stock) VALUES ($1, $2, $3, $4, $5)', [req.shop.id, name, price, cost, stock]);
        res.redirect('/pos/items?ok=' + encodeURIComponent('Item added.'));
    }));

    // ----- POS Terminal -----
    router.get('/api/items', ah(async (req, res) => {
        const r = await q('SELECT id, name, barcode, price_cents AS price, stock, track_stock FROM pos_items WHERE shop_id=$1 AND active ORDER BY name', [req.shop.id]);
        res.json(r.rows);
    }));
    router.get('/terminal', ah(async (req, res) => {
        const vatRate = Number(req.shop.vat_rate || 16);
        const body = `<h1>POS Terminal — ${esc(req.shop.name)}</h1>
        <div class="pos-wrap">
            <div>
                <div class="panel" style="margin-bottom:0"><label for="find">Search items</label><input id="find" type="search" autofocus placeholder="Type name..."></div>
                <div class="pos-items" id="grid"></div>
            </div>
            <div class="panel cart">
                <h2>Current Sale</h2>
                <div class="lines" id="lines"><p class="muted">Tap items to add.</p></div>
                <div class="tot"><span>Subtotal</span><span id="sub">0.00</span></div>
                <div class="tot"><span>Discount</span><input id="disc" inputmode="decimal" style="width:90px;text-align:right" value="0"></div>
                <div class="tot muted"><span>VAT (${vatRate}%)</span><span id="vat">0.00</span></div>
                <div class="tot big"><span>Total</span><span id="total">0.00</span></div>
                <div class="pay"><button type="button" id="m-cash" class="on">Cash</button><button type="button" id="m-mpesa">M-Pesa</button></div>
                <div id="cashbox" class="field"><label>Cash Tendered</label><input id="tender" inputmode="decimal"></div>
                <div id="mpesabox" class="field" style="display:none"><label>M-Pesa Code</label><input id="mref" placeholder="ABC123XYZ"></div>
                <button class="btn ok" id="done" type="button" style="width:100%;padding:12px" disabled>Complete Sale</button>
            </div>
        </div>
        <div class="modal" id="modal"><div class="box"><h2>Sale Complete</h2><p id="mtext"></p><a class="btn" id="mprint" target="_blank">Print Receipt</a><button class="btn ok" id="mnew" type="button" style="margin-top:10px;width:100%">New Sale</button></div></div>
        <script nonce="${req.nonce || ''}">
        (function(){
            var items=[], cart=[], method='cash', vatRate=${vatRate};
            var $=function(id){return document.getElementById(id);};
            function fmt(c){return (c/100).toFixed(2);}
            function load(){fetch('/pos/api/items').then(r=>r.json()).then(d=>{items=d;draw();});}
            function draw(){
                var f=$('find').value.toLowerCase(), g=$('grid'); g.innerHTML='';
                items.filter(i=>!f||i.name.toLowerCase().includes(f)).forEach(i=>{
                    var b=document.createElement('button'); b.className='pos-item';
                    b.innerHTML='<b>'+i.name+'</b><span class="p">KES '+fmt(i.price)+'</span>';
                    b.onclick=()=>add(i); g.appendChild(b);
                });
            }
            function add(i){
                var l=cart.find(x=>x.id===i.id);
                if(l) l.qty++; else cart.push({id:i.id, name:i.name, price:i.price, qty:1});
                render();
            }
            function render(){
                var box=$('lines'); box.innerHTML='';
                var sub=0; cart.forEach(l=>{ sub+=l.price*l.qty; box.innerHTML+='<div class="cline"><div>'+l.name+' x'+l.qty+'</div><b>'+fmt(l.price*l.qty)+'</b></div>'; });
                var disc=parseFloat($('disc').value)||0; var tot=Math.max(0, sub-disc);
                var vat=Math.round(tot/(1+100/vatRate));
                $('sub').textContent=fmt(sub); $('vat').textContent=fmt(vat); $('total').textContent=fmt(tot);
                $('done').disabled=cart.length===0;
            }
            $('find').oninput=draw; $('disc').oninput=render;
            $('m-cash').onclick=()=>{method='cash'; $('m-cash').className='on'; $('m-mpesa').className=''; $('cashbox').style.display=''; $('mpesabox').style.display='none';};
            $('m-mpesa').onclick=()=>{method='mpesa'; $('m-mpesa').className='on'; $('m-cash').className=''; $('cashbox').style.display='none'; $('mpesabox').style.display='';};
            $('mnew').onclick=()=>{window.location.reload();};
            $('done').onclick=()=>{
                var sub=cart.reduce((a,b)=>a+b.price*b.qty,0), disc=(parseFloat($('disc').value)||0)*100, tot=sub-disc;
                fetch('/pos/api/sales', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({lines:cart.map(l=>({id:l.id, qty:l.qty})), discount:disc, method:method, tendered:$('tender').value, mpesaRef:$('mref').value})})
                .then(r=>r.json()).then(d=>{
                    if(!d.ok){alert(d.error||'Error'); return;}
                    $('mtext').textContent='Receipt #'+d.receiptNo+' — KES '+fmt(d.total);
                    $('mprint').href=d.receiptUrl; $('modal').className='modal show';
                });
            };
            load();
        })();
        </script>`;
        send(req, res, { title: 'POS Terminal', nav: 'terminal', body });
    }));

    router.post('/api/sales', ah(async (req, res) => {
        const b = req.body || {};
        if (!Array.isArray(b.lines) || !b.lines.length) return res.status(400).json({ error: 'No items' });
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            let subtotal = 0, saleLines = [];
            for (const l of b.lines) {
                const it = (await client.query('SELECT * FROM pos_items WHERE id=$1 AND shop_id=$2', [l.id, req.shop.id])).rows[0];
                if (!it) throw new Error('Item not found');
                subtotal += Number(it.price_cents) * l.qty;
                saleLines.push({ item_id: it.id, name: it.name, qty: l.qty, unit_price_cents: it.price_cents, unit_cost_cents: it.cost_cents });
            }
            const discount = Number(b.discount) || 0, total = subtotal - discount;
            const { vat } = calcInclusiveVat(total, req.shop.vat_rate || 16);
            const no = (await client.query('UPDATE pos_shops SET next_receipt = next_receipt + 1 WHERE id=$1 RETURNING next_receipt - 1 AS no', [req.shop.id])).rows[0].no;
            const sale = (await client.query('INSERT INTO pos_sales (shop_id, cashier_user_id, receipt_no, subtotal_cents, discount_cents, vat_cents, total_cents, paid_cents, method, mpesa_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
                [req.shop.id, req.session.user.id, no, subtotal, discount, vat, total, total, b.method === 'mpesa' ? 'mpesa' : 'cash', str(b.mpesaref)])).rows[0];
            for (const sl of saleLines) {
                await client.query('INSERT INTO pos_sale_items (sale_id, item_id, name, qty, unit_price_cents, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6)', [sale.id, sl.item_id, sl.name, sl.qty, sl.unit_price_cents, sl.unit_cost_cents]);
                await client.query('UPDATE pos_items SET stock = stock - $2 WHERE id=$1', [sl.item_id, sl.qty]);
            }
            await client.query('COMMIT');
            res.json({ ok: true, saleId: sale.id, receiptNo: no, total, receiptUrl: `/pos/sales/${sale.id}/receipt` });
        } catch (err) { await client.query('ROLLBACK').catch(()=>{}); res.status(400).json({ error: err.message }); }
        finally { client.release(); }
    }));

    // ----- Sales History & Receipts -----
    router.get('/sales', ah(async (req, res) => {
        const r = await q('SELECT * FROM pos_sales WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 200', [req.shop.id]);
        send(req, res, { title: 'Sales History', nav: 'sales', body: `<h1>Sales History</h1><div class="panel tablewrap"><table><tr><th>Receipt</th><th>Date</th><th>Method</th><th class="num">Total</th><th></th></tr>${r.rows.map(s => `<tr><td>#${s.receipt_no}</td><td>${timeFmt(s.created_at)}</td><td>${s.method}</td><td class="num">${kes(s.total_cents)}</td><td class="right"><a class="btn small ghost" href="/pos/sales/${s.id}/receipt">Receipt</a></td></tr>`).join('')}</table></div>` });
    }));

    router.get('/sales/:id/receipt', ah(async (req, res) => {
        const s = (await q('SELECT * FROM pos_sales WHERE id=$1 AND shop_id=$2', [parseCount(req.params.id), req.shop.id])).rows[0];
        if (!s) return res.status(404).send('Not found');
        const lines = (await q('SELECT * FROM pos_sale_items WHERE sale_id=$1', [s.id])).rows;
        const sh = req.shop;
        send(req, res, { title: 'Receipt', nav: 'sales', body: `<div class="noprint"><button class="btn" onclick="window.print()">Print</button> <a class="btn ghost" href="/pos/sales">Back</a></div>
        <div class="panel" style="max-width:380px;margin:20px auto;font-family:monospace">
            <div style="text-align:center"><b>${esc(sh.name)}</b><br>${esc(sh.address)}</div><hr>
            Receipt #${s.receipt_no}<br>Date: ${timeFmt(s.created_at)}<hr>
            <table>${lines.map(l => `<tr><td>${esc(l.name)} x${l.qty}</td><td class="num">${kes(l.unit_price_cents * l.qty)}</td></tr>`).join('')}</table><hr>
            <div class="tot big"><span>TOTAL</span><span>${kes(s.total_cents)}</span></div>
        </div>` });
    }));

    // ----- Subscription & M-Pesa Settings -----
    router.get('/subscribe', ah(async (req, res) => {
        const sh = req.shop;
        const exp = sh.subscription_expires_at ? new Date(sh.subscription_expires_at) : null;
        send(req, res, { title: 'Subscription', nav: 'subscribe', body: `<h1>Subscription & PWA</h1>${notice(req)}
        <div class="panel" style="max-width:520px">
            <h2>Status</h2><p>Expires: <b>${exp ? dateFmt(exp) : 'Inactive'}</b></p>
            <form action="/pos/subscribe/pay" method="POST"><button class="btn ok" type="submit">Extend Subscription (30 Days)</button></form>
        </div>` });
    }));
    router.post('/subscribe/pay', ah(async (req, res) => {
        await q('UPDATE pos_shops SET subscription_expires_at = GREATEST(COALESCE(subscription_expires_at, now()), now()) + interval \'30 days\' WHERE id = $1', [req.shop.id]);
        res.redirect('/pos/subscribe?ok=' + encodeURIComponent('Subscription renewed successfully.'));
    }));

    router.get('/settings/mpesa', requireManager, ah(async (req, res) => {
        const cfg = (await q('SELECT shortcode FROM pos_mpesa_configs WHERE shop_id = $1', [req.shop.id])).rows[0] || {};
        send(req, res, { title: 'M-Pesa API', nav: 'mpesa', body: `<h1>M-Pesa API</h1>${notice(req)}
        <div class="panel" style="max-width:520px"><form action="/pos/settings/mpesa" method="POST">
            <div class="field"><label>Till / Paybill Shortcode</label><input name="shortcode" value="${esc(cfg.shortcode || '')}" required></div>
            <div class="field"><label>Passkey</label><input name="passkey" type="password"></div>
            <div class="field"><label>Consumer Key</label><input name="consumer_key" type="password"></div>
            <div class="field"><label>Consumer Secret</label><input name="consumer_secret" type="password"></div>
            <button class="btn" type="submit">Save</button>
        </form></div>` });
    }));
    router.post('/settings/mpesa', requireManager, ah(async (req, res) => {
        const sc = str(req.body.shortcode), pk = str(req.body.passkey), ck = str(req.body.consumer_key), cs = str(req.body.consumer_secret), sec = sessionSecret || 'fallback';
        await q(`INSERT INTO pos_mpesa_configs (shop_id, shortcode, passkey_enc, consumer_key_enc, consumer_secret_enc, updated_at)
            VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (shop_id) DO UPDATE SET shortcode=$2, passkey_enc=COALESCE(NULLIF($3,''),pos_mpesa_configs.passkey_enc), consumer_key_enc=COALESCE(NULLIF($4,''),pos_mpesa_configs.consumer_key_enc), consumer_secret_enc=COALESCE(NULLIF($5,''),pos_mpesa_configs.consumer_secret_enc)`,
            [req.shop.id, sc, encryptSecret(pk, sec), encryptSecret(ck, sec), encryptSecret(cs, sec)]);
        res.redirect('/pos/settings/mpesa?ok=' + encodeURIComponent('Saved.'));
    }));

    app.use('/pos', router);
}

module.exports = mountPos;
module.exports.initSchema = initSchema;
