'use strict';
// ---------------------------------------------------------------------------
// Tencent POS (Part 1): Multi-branch, Cashiers, Logo Branding & 16% Inclusive VAT
// ---------------------------------------------------------------------------
const express = require('express');

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
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

    // Migrate existing single-shop installations safely
    await pool.query('ALTER TABLE pos_shops DROP CONSTRAINT IF EXISTS pos_shops_owner_id_key');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS parent_shop_id INT REFERENCES pos_shops(id) ON DELETE CASCADE');
    await pool.query("ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS logo_data TEXT NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2) NOT NULL DEFAULT 16.00');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS next_po INT NOT NULL DEFAULT 1');
    await pool.query('ALTER TABLE pos_shops ADD COLUMN IF NOT EXISTS next_quote INT NOT NULL DEFAULT 1');

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
        `CREATE TABLE IF NOT EXISTS pos_notes (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES pos_shops(id) ON DELETE CASCADE, title VARCHAR(120) NOT NULL, body VARCHAR(4000) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    ];
    for (const sql of T) await pool.query(sql);
    await pool.query('ALTER TABLE pos_drawer ADD COLUMN IF NOT EXISTS opened_by INT REFERENCES users(id) ON DELETE SET NULL');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const fmt = cents => (Number(cents) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kes = cents => 'KES ' + fmt(cents);

// Inclusive 16% VAT extraction: Total includes VAT -> Net = Total / 1.16, VAT = Total - Net
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

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------
function mountPos({ app, getPool, esc, str, ah, rateLimit, requireAuth, requireDb, requireVerified, renderPage, bcrypt }) {
    const pool = () => getPool();
    const router = express.Router();
    const q = (text, params) => pool().query(text, params);

    // Increase JSON/urlencoded limit strictly on /pos/settings so base64 shop logos (up to 300KB) save cleanly
    const logoBodyParser = express.urlencoded({ extended: false, limit: '450kb' });

    const NAV = [
        ['Main', [['app', '/pos/app', 'Dashboard', false], ['terminal', '/pos/terminal', 'POS Terminal', true], ['sales', '/pos/sales', 'Sales History', true], ['daily', '/pos/daily', 'Daily Sales (Z-Report)', false], ['drawer', '/pos/drawer', 'Cash Drawer', true], ['quotes', '/pos/quotes', 'Quotes', false]]],
        ['Inventory', [['items', '/pos/items', 'Items', false], ['categories', '/pos/categories', 'Categories', false], ['stock', '/pos/stock', 'Stock In / Out & Adjustment', false], ['history', '/pos/stock/history', 'Stock History', false], ['low', '/pos/stock/low', 'Low Stock Alerts', false], ['suppliers', '/pos/suppliers', 'Suppliers', false], ['po', '/pos/purchase-orders', 'Purchase Orders', false]]],
        ['Money', [['expenses', '/pos/expenses', 'Expenses', false], ['ecats', '/pos/expense-categories', 'Expense Categories', false], ['recurring', '/pos/recurring', 'Recurring Expenses', false], ['budgets', '/pos/budgets', 'Budgets', false], ['assets', '/pos/assets', 'Assets', false], ['reports', '/pos/reports', 'Reports', false], ['notebook', '/pos/notebook', 'Notebook', false]]],
        ['Shop & Team', [['branches', '/pos/branches', 'Branches', false], ['staff', '/pos/staff', 'Cashiers & Staff', false], ['settings', '/pos/settings', 'Shop Settings', false]]]
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
<meta name="robots" content="noindex">
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
(function(){var b=document.getElementById('side-btn'),s=document.getElementById('side');if(b)b.addEventListener('click',function(){var o=s.classList.toggle('open');b.setAttribute('aria-expanded',o?'true':'false');});})();
</script>
</body></html>`;
    }
    const send = (req, res, opts, status = 200) => res.status(status).set('Cache-Control', 'no-store').send(layout(req, opts));
    const notice = (req) => req.query.ok ? `<div class="alert ok" role="status">${esc(String(req.query.ok).slice(0, 120))}</div>` : '';

    // ----- public landing page -----
    app.get('/pos', (req, res) => {
        const loggedIn = Boolean(req.session && req.session.user);
        const content = `
        <div class="general-container">
            <h2>Tencent POS: Multi-Branch Point of Sale</h2>
            <p class="sub-title">Sell faster, manage branches and cashiers, print branded VAT receipts, and track stock and profit every day.</p>
            <div class="form-container" style="border-left:4px solid var(--primary);">
                <h3 style="margin-top:0;color:var(--primary);">What your business gets</h3>
                <ul style="line-height:1.8;padding-left:20px;margin-bottom:0;">
                    <li><strong>Multi-Branch & Cashiers:</strong> Open linked branch accounts under your business and assign cashiers to each branch.</li>
                    <li><strong>Branded 16% VAT Receipts:</strong> Upload your shop logo and KRA PIN; every sale automatically computes 16% inclusive VAT.</li>
                    <li><strong>Fast POS Terminal:</strong> Tap items or scan barcodes, take cash or M-Pesa, give change, and print or share on WhatsApp.</li>
                    <li><strong>Inventory & Accounting:</strong> Stock levels, purchase orders, quotes, cash drawer shifts, expenses, and Z-reports.</li>
                </ul>
            </div>
            <div class="form-container" style="margin-top:20px;">
                <p style="margin-top:0;">${loggedIn ? 'You are logged in. Open your POS workspace.' : 'Create a personal account, confirm your email, and set up your business in two minutes.'}</p>
                <a href="/pos/app" class="cta-btn">${loggedIn ? 'Open my POS' : 'Get started'}</a>
                <a href="/contact" class="cta-btn" style="margin-left:8px;">Ask us about setup & hardware</a>
            </div>
        </div>`;
        res.send(renderPage(req, { title: 'POS System for Shops', activeNav: 'pos', content }));
    });

    router.use(requireAuth, requireDb, requireVerified);

    // Load all shops the user owns or works at as staff
    async function loadUserShops(userId) {
        const owned = await q(`SELECT *, 'owner' AS role FROM pos_shops WHERE owner_id = $1 ORDER BY parent_shop_id NULLS FIRST, id ASC`, [userId]);
        const staffed = await q(`
            SELECT s.*, st.role
            FROM pos_shops s
            JOIN pos_staff st ON st.shop_id = s.id
            WHERE st.user_id = $1 AND st.active = TRUE AND s.owner_id <> $1
            ORDER BY s.id ASC`, [userId]);
        return [...owned.rows, ...staffed.rows];
    }

    const setupForm = (req, error = '', v = {}) => `
        <h1>Set up your business</h1>
        <div class="panel" style="max-width:560px;">
            ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
            <form action="/pos/setup" method="POST">
                <div class="field"><label for="n">Main Business / Head Office Name</label><input id="n" name="name" required maxlength="120" value="${esc(v.name || '')}" placeholder="e.g. Mama Achieng Enterprises"></div>
                <div class="field"><label for="p">Business Phone</label><input id="p" name="phone" maxlength="40" value="${esc(v.phone || req.session.user.phone || '')}"></div>
                <div class="field"><label for="a">Address / Location</label><input id="a" name="address" maxlength="200" value="${esc(v.address || '')}" placeholder="e.g. Rangwe Market"></div>
                <div class="field"><label for="k">KRA PIN (optional, for 16% VAT receipts)</label><input id="k" name="tax_pin" maxlength="40" value="${esc(v.tax_pin || '')}" placeholder="e.g. A001234567Z"></div>
                <button class="btn" type="submit">Create my business</button>
            </form>
        </div>`;

    router.get('/setup', ah(async (req, res) => {
        const shops = await loadUserShops(req.session.user.id);
        if (shops.length) return res.redirect('/pos/app');
        send(req, res, { title: 'Set up your business', body: setupForm(req) });
    }));
    router.post('/setup', ah(async (req, res) => {
        const shops = await loadUserShops(req.session.user.id);
        if (shops.length) return res.redirect('/pos/app');
        const v = {
            name: str(req.body.name).slice(0, 120),
            phone: str(req.body.phone).slice(0, 40),
            address: str(req.body.address).slice(0, 200),
            tax_pin: str(req.body.tax_pin).slice(0, 40)
        };
        if (v.name.length < 2) return send(req, res, { title: 'Set up your business', body: setupForm(req, 'Please enter your business name.', v) }, 400);
        const r = await q('INSERT INTO pos_shops (owner_id, name, phone, address, tax_pin) VALUES ($1, $2, $3, $4, $5) RETURNING id', [req.session.user.id, v.name, v.phone, v.address, v.tax_pin]);
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

    // Resolve active shop & role for all downstream routes
    router.use(ah(async (req, res, next) => {
        const shops = await loadUserShops(req.session.user.id);
        if (!shops.length) return res.redirect('/pos/setup');
        req.accessibleShops = shops;
        const selected = shops.find(s => s.id === req.session.posShopId) || shops[0];
        req.session.posShopId = selected.id;
        req.shop = selected;
        req.posRole = selected.role; // 'owner', 'manager', or 'cashier'

        if (!selected.active) {
            return send(req, res, { title: 'Account paused', body: '<h1>This POS branch is paused</h1><div class="panel"><p>Please contact Tencent Innovations on 0740 311 014 to reactivate it.</p></div>' }, 403);
        }
        await runRecurring(selected.id).catch(e => console.error('Recurring expenses failed:', e.message));
        next();
    }));

    const requireManager = (req, res, next) => {
        if (req.posRole === 'cashier') return res.redirect('/pos/terminal');
        next();
    };
    const requireOwner = (req, res, next) => {
        if (req.posRole !== 'owner') return send(req, res, { title: 'Owner access only', nav: 'app', body: '<h1>Owner access required</h1><div class="panel"><p>Only the business owner account can manage branches and business settings.</p></div>' }, 403);
        next();
    };

    // ----- dashboard -----
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
            <div class="stat c2"><span>Inventory value (cost)</span><b>${kes(I.value)}</b></div>
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
            <a class="btn ghost" href="/pos/stock?type=in" style="flex:0 0 auto">Stock in</a><a class="btn ghost" href="/pos/expenses" style="flex:0 0 auto">Add expense</a>
            <a class="btn ghost" href="/pos/purchase-orders/new" style="flex:0 0 auto">New purchase order</a><a class="btn ghost" href="/pos/items.csv" style="flex:0 0 auto">Export CSV</a></div></div>
        <div class="grid2" style="align-items:start">
            <div class="panel"><h2>Recent stock movements</h2>${moves.rows.length ? `<table>${moves.rows.map(x => `<tr><td>${esc(x.name)}<br><small class="muted">${esc(label[x.reason] || x.reason)} · ${esc(timeFmt(x.created_at))}</small></td><td class="num"><b style="color:${x.change < 0 ? '#dc2626' : '#16a34a'}">${x.change > 0 ? '+' : ''}${x.change}</b></td></tr>`).join('')}</table>` : '<p class="muted">No movements yet.</p>'}</div>
            <div class="panel"><h2>Recent expenses</h2>${recentExp.rows.length ? `<table>${recentExp.rows.map(x => `<tr><td>${esc(x.category)}<br><small class="muted">${esc(dateFmt(isoDate(x.spent_on) + 'T12:00:00+03:00'))}</small></td><td class="num">${fmt(x.amount_cents)}</td></tr>`).join('')}</table>` : '<p class="muted">No expenses yet.</p>'}</div>
        </div>`;
        send(req, res, { title: 'Dashboard', nav: 'app', body });
    }));

    // ----- branches (linked branch accounts under the business owner) -----
    router.get('/branches', requireManager, ah(async (req, res) => {
        const rootId = req.shop.parent_shop_id || req.shop.id;
        const branches = (await q(`
            SELECT s.id, s.name, s.phone, s.address, s.parent_shop_id,
                   (SELECT count(*)::int FROM pos_staff st WHERE st.shop_id = s.id AND st.active) AS staff_count,
                   (SELECT COALESCE(sum(total_cents),0)::bigint FROM pos_sales sa WHERE sa.shop_id = s.id AND sa.status = 'completed' AND (sa.created_at AT TIME ZONE '${TZ}')::date = $2) AS today_sales
            FROM pos_shops s
            WHERE s.id = $1 OR s.parent_shop_id = $1
            ORDER BY s.parent_shop_id NULLS FIRST, s.id ASC`, [rootId, todayNairobi()])).rows;

        const err = req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 160))}</div>` : '';
        const createPanel = req.posRole === 'owner' ? `
        <div class="panel">
            <h2>Open a Linked Branch Account</h2>
            <p class="muted">Each branch keeps its own inventory, cash drawer, cashiers, and receipts while staying linked to your business account.</p>
            <form action="/pos/branches" method="POST">
                <div class="grid2">
                    <div class="field"><label for="bn">Branch Name</label><input id="bn" name="name" required maxlength="120" placeholder="e.g. Mama Achieng — Homa Bay Branch"></div>
                    <div class="field"><label for="bp">Branch Phone</label><input id="bp" name="phone" maxlength="40" value="${esc(req.shop.phone)}"></div>
                    <div class="field"><label for="ba">Branch Address / Location</label><input id="ba" name="address" maxlength="200" placeholder="e.g. Homa Bay Town, Main Street"></div>
                    <div class="field"><label><input type="checkbox" name="copy_catalog" value="1" checked style="width:auto"> Copy categories & item catalog (with 0 stock) from ${esc(req.shop.name)}</label></div>
                </div>
                <button class="btn" type="submit">Create Linked Branch</button>
            </form>
        </div>` : '';

        send(req, res, {
            title: 'Branches',
            nav: 'branches',
            body: `<h1>Business Branches</h1>${notice(req)}${err}${createPanel}
            <div class="panel tablewrap">
                <table>
                    <tr><th>Branch Name</th><th>Type</th><th>Address</th><th>Phone</th><th class="num">Staff</th><th class="num">Today's Sales</th><th></th></tr>
                    ${branches.map(b => `<tr>
                        <td><b>${esc(b.name)}</b> ${b.id === req.shop.id ? '<span class="tag ok">Active</span>' : ''}</td>
                        <td>${b.parent_shop_id ? '<span class="tag gray">Branch</span>' : '<span class="tag warn">Head Office</span>'}</td>
                        <td>${esc(b.address || '-')}</td>
                        <td>${esc(b.phone || '-')}</td>
                        <td class="num">${b.staff_count}</td>
                        <td class="num">${kes(b.today_sales)}</td>
                        <td class="right nowrap">
                            ${b.id !== req.shop.id ? `<form action="/pos/switch-shop" method="POST" style="display:inline"><input type="hidden" name="shop_id" value="${b.id}"><button class="btn small ghost" type="submit">Open Branch</button></form>` : ''}
                        </td>
                    </tr>`).join('')}
                </table>
            </div>`
        });
    }));

    router.post('/branches', requireOwner, ah(async (req, res) => {
        const rootShop = (await q('SELECT * FROM pos_shops WHERE id = $1', [req.shop.parent_shop_id || req.shop.id])).rows[0];
        const name = str(req.body.name).slice(0, 120);
        const phone = str(req.body.phone).slice(0, 40);
        const address = str(req.body.address).slice(0, 200);
        if (name.length < 2) return res.redirect('/pos/branches?err=' + encodeURIComponent('Please enter a branch name.'));

        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const ins = await client.query(`
                INSERT INTO pos_shops (owner_id, parent_shop_id, name, phone, address, tax_pin, receipt_footer, logo_data, vat_rate)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
                [req.session.user.id, rootShop.id, name, phone, address, rootShop.tax_pin, rootShop.receipt_footer, rootShop.logo_data, rootShop.vat_rate]);
            const newShopId = ins.rows[0].id;

            if (req.body.copy_catalog === '1') {
                const cats = (await client.query('SELECT id, name FROM pos_categories WHERE shop_id = $1', [req.shop.id])).rows;
                const catMap = new Map();
                for (const c of cats) {
                    const nc = await client.query('INSERT INTO pos_categories (shop_id, name) VALUES ($1, $2) RETURNING id', [newShopId, c.name]);
                    catMap.set(c.id, nc.rows[0].id);
                }
                const items = (await client.query('SELECT category_id, name, barcode, price_cents, cost_cents, track_stock, reorder_level FROM pos_items WHERE shop_id = $1 AND active = TRUE', [req.shop.id])).rows;
                for (const it of items) {
                    await client.query(
                        'INSERT INTO pos_items (shop_id, category_id, name, barcode, price_cents, cost_cents, stock, track_stock, reorder_level) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)',
                        [newShopId, it.category_id ? catMap.get(it.category_id) || null : null, it.name, it.barcode, it.price_cents, it.cost_cents, it.track_stock, it.reorder_level]
                    );
                }
            }
            await client.query('COMMIT');
            req.session.posShopId = newShopId;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        res.redirect('/pos/branches?ok=' + encodeURIComponent('Linked branch created and switched to active.'));
    }));

    // ----- cashiers & staff per branch -----
    router.get('/staff', requireManager, ah(async (req, res) => {
        const staff = (await q(`
            SELECT st.id, st.role, st.active, st.created_at, u.name, u.email, u.phone
            FROM pos_staff st
            JOIN users u ON u.id = st.user_id
            WHERE st.shop_id = $1
            ORDER BY st.created_at ASC`, [req.shop.id])).rows;
        const err = req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 180))}</div>` : '';

        send(req, res, {
            title: 'Cashiers & Staff',
            nav: 'staff',
            body: `<h1>Cashiers & Staff — ${esc(req.shop.name)}</h1>${notice(req)}${err}
            <div class="panel">
                <h2>Register a Cashier or Branch Manager</h2>
                <p class="muted">If the cashier already has an account on this site, enter their email. If not, fill in their name, phone, and a password to create their cashier login right away.</p>
                <form action="/pos/staff" method="POST">
                    <div class="grid2">
                        <div class="field"><label for="se">Email Address</label><input id="se" name="email" type="email" required maxlength="254" placeholder="cashier@example.com"></div>
                        <div class="field"><label for="sr">Role</label><select id="sr" name="role"><option value="cashier">Cashier (POS Terminal, Drawer & Sales only)</option><option value="manager">Branch Manager (Full branch access)</option></select></div>
                        <div class="field"><label for="sn">Full Name (required if new account)</label><input id="sn" name="name" maxlength="80" placeholder="e.g. Jane Akinyi"></div>
                        <div class="field"><label for="sp">Phone Number (required if new account)</label><input id="sp" name="phone" maxlength="30" placeholder="0712345678"></div>
                        <div class="field"><label for="spw">Initial Password (min 8 chars, if new account)</label><input id="spw" name="password" type="password" minlength="8" maxlength="72"></div>
                    </div>
                    <button class="btn" type="submit">Register Staff Member</button>
                </form>
            </div>
            <div class="panel tablewrap">
                <h2>Assigned Staff (${staff.length})</h2>
                ${staff.length ? `<table><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Status</th><th></th></tr>
                ${staff.map(s => `<tr>
                    <td><b>${esc(s.name)}</b></td>
                    <td>${esc(s.email)}</td>
                    <td>${esc(s.phone)}</td>
                    <td><span class="tag ${s.role === 'manager' ? 'warn' : 'gray'}">${esc(s.role)}</span></td>
                    <td><span class="tag ${s.active ? 'ok' : 'bad'}">${s.active ? 'Active' : 'Disabled'}</span></td>
                    <td class="right nowrap">
                        <form action="/pos/staff/${s.id}/toggle" method="POST" style="display:inline"><button class="btn small ghost" type="submit">${s.active ? 'Disable' : 'Enable'}</button></form>
                        <form action="/pos/staff/${s.id}/delete" method="POST" style="display:inline"><button class="btn small bad" type="submit">Remove</button></form>
                    </td>
                </tr>`).join('')}</table>` : '<p class="muted">No cashiers assigned to this branch yet.</p>'}
            </div>`
        });
    }));

    router.post('/staff', requireManager, ah(async (req, res) => {
        const email = str(req.body.email).toLowerCase().slice(0, 254);
        const role = req.body.role === 'manager' ? 'manager' : 'cashier';
        const fail = m => res.redirect('/pos/staff?err=' + encodeURIComponent(m));

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Please enter a valid email address.');
        if (email === req.session.user.email.toLowerCase()) return fail('You are already the owner of this branch.');

        let userRow = (await q('SELECT id, name, email FROM users WHERE lower(email) = $1', [email])).rows[0];
        if (!userRow) {
            const name = str(req.body.name).slice(0, 80);
            const phoneRaw = str(req.body.phone).replace(/[\s\-()]/g, '').replace(/^\+/, '');
            const phone = /^0[17]\d{8}$/.test(phoneRaw) ? '254' + phoneRaw.slice(1) : (/^254[17]\d{8}$/.test(phoneRaw) ? phoneRaw : '');
            const password = typeof req.body.password === 'string' ? req.body.password : '';

            if (name.length < 2) return fail('No existing account found for that email. Enter the cashier\'s full name to create one.');
            if (!phone) return fail('Enter a valid Kenyan phone number (e.g. 0712345678) for the new cashier account.');
            if (password.length < 8 || password.length > 72) return fail('Enter a password of at least 8 characters for the new cashier account.');
            if (!bcrypt) return fail('Password hashing module unavailable.');

            const hash = await bcrypt.hash(password, 11);
            const created = await q(
                'INSERT INTO users (name, email, phone, password_hash, email_verified) VALUES ($1, $2, $3, $4, TRUE) RETURNING id, name, email',
                [name, email, phone, hash]
            );
            userRow = created.rows[0];
        } else {
            await q('UPDATE users SET email_verified = TRUE WHERE id = $1', [userRow.id]);
        }

        await q(`
            INSERT INTO pos_staff (shop_id, user_id, role, active)
            VALUES ($1, $2, $3, TRUE)
            ON CONFLICT (shop_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = TRUE`,
            [req.shop.id, userRow.id, role]);

        res.redirect('/pos/staff?ok=' + encodeURIComponent(`${userRow.name} registered as ${role}.`));
    }));

    router.post('/staff/:id/toggle', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('UPDATE pos_staff SET active = NOT active WHERE id = $1 AND shop_id = $2', [id, req.shop.id]);
        res.redirect('/pos/staff?ok=' + encodeURIComponent('Staff status updated.'));
    }));

    router.post('/staff/:id/delete', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_staff WHERE id = $1 AND shop_id = $2', [id, req.shop.id]);
        res.redirect('/pos/staff?ok=' + encodeURIComponent('Staff member removed from branch.'));
    }));

    // ----- categories (manager+) -----
    router.get('/categories', requireManager, ah(async (req, res) => {
        const r = await q(`SELECT c.id, c.name, count(i.id)::int n FROM pos_categories c LEFT JOIN pos_items i ON i.category_id = c.id AND i.active WHERE c.shop_id=$1 GROUP BY c.id ORDER BY c.name`, [req.shop.id]);
        const err = req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 120))}</div>` : '';
        send(req, res, { title: 'Categories', nav: 'categories', body: `<h1>Categories</h1>${notice(req)}${err}
        <div class="panel"><form action="/pos/categories" method="POST" class="row"><div><label for="c">New category</label><input id="c" name="name" required maxlength="80" placeholder="e.g. Drinks"></div><button class="btn" type="submit">Add</button></form></div>
        <div class="panel">${r.rows.length ? `<table><tr><th>Name</th><th class="num">Items</th><th></th></tr>${r.rows.map(c => `<tr><td>${esc(c.name)}</td><td class="num">${c.n}</td><td class="right"><form action="/pos/categories/${c.id}/delete" method="POST" style="display:inline"><button class="btn small ghost" type="submit">Delete</button></form></td></tr>`).join('')}</table>` : '<p class="muted">No categories yet.</p>'}</div>` });
    }));
    router.post('/categories', requireManager, ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 80);
        if (!name) return res.redirect('/pos/categories?err=' + encodeURIComponent('Please enter a name.'));
        const r = await q('INSERT INTO pos_categories (shop_id, name) VALUES ($1, $2) ON CONFLICT (shop_id, name) DO NOTHING', [req.shop.id, name]);
        res.redirect(r.rowCount ? '/pos/categories?ok=' + encodeURIComponent('Category added.') : '/pos/categories?err=' + encodeURIComponent('That category already exists.'));
    }));
    router.post('/categories/:id/delete', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_categories WHERE id = $1 AND shop_id = $2', [id, req.shop.id]);
        res.redirect('/pos/categories?ok=' + encodeURIComponent('Category deleted.'));
    }));

    // ----- items (manager+) -----
    const categoriesOf = async shopId => (await q('SELECT id, name FROM pos_categories WHERE shop_id=$1 ORDER BY name', [shopId])).rows;
    router.get('/items', requireManager, ah(async (req, res) => {
        const search = str(req.query.q).slice(0, 60), showAll = req.query.all === '1';
        const r = await q(`SELECT i.*, c.name AS cat FROM pos_items i LEFT JOIN pos_categories c ON c.id = i.category_id
            WHERE i.shop_id=$1 ${showAll ? '' : 'AND i.active'} AND ($2 = '' OR i.name ILIKE '%' || $2 || '%' OR i.barcode = $2) ORDER BY i.name LIMIT 500`, [req.shop.id, search.replace(/[%_\\]/g, ' ')]);
        const body = `<h1>Items</h1>${notice(req)}
        <div class="panel"><form method="GET" class="row"><div><label for="q">Search name or barcode</label><input id="q" name="q" value="${esc(search)}"></div><div style="flex:0 0 auto"><label><input type="checkbox" name="all" value="1" ${showAll ? 'checked' : ''} style="width:auto"> Show archived</label></div><button class="btn dark" type="submit">Search</button><a class="btn" href="/pos/items/new">Add item</a></form></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Item</th><th>Category</th><th>Barcode</th><th class="num">Price (Incl. 16% VAT)</th><th class="num">Cost</th><th class="num">Stock</th><th></th></tr>${r.rows.map(i => `<tr><td>${esc(i.name)}${i.active ? '' : ' <span class="tag gray">archived</span>'}</td><td>${esc(i.cat || '')}</td><td>${esc(i.barcode || '')}</td><td class="num">${fmt(i.price_cents)}</td><td class="num">${fmt(i.cost_cents)}</td><td class="num">${i.track_stock ? `<span class="tag ${i.stock <= 0 ? 'bad' : i.stock <= i.reorder_level ? 'warn' : 'ok'}">${i.stock}</span>` : '<span class="muted">not tracked</span>'}</td><td class="right nowrap"><a class="btn small ghost" href="/pos/items/${i.id}/edit">Edit</a></td></tr>`).join('')}</table>` : '<p class="muted">No items found. <a href="/pos/items/new">Add your first item</a>.</p>'}</div>`;
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
                <div class="field"><label for="p">Selling price (KES, Incl. 16% VAT)</label><input id="p" name="price" required inputmode="decimal" value="${esc(priceVal)}" placeholder="e.g. 150"><small>16% VAT is automatically extracted on receipts.</small></div>
                <div class="field"><label for="k">Buying cost (KES)</label><input id="k" name="cost" inputmode="decimal" value="${esc(costVal)}" placeholder="e.g. 100"><small>Used to work out your profit.</small></div>
                <div class="field"><label for="b">Barcode (optional)</label><input id="b" name="barcode" maxlength="60" value="${esc(item.barcode || '')}"></div>
                ${isNew ? `<div class="field"><label for="s">Opening stock</label><input id="s" name="stock" inputmode="numeric" value="${esc(item._stock != null ? item._stock : '0')}"></div>` : ''}
                <div class="field"><label for="r">Warn me when stock is at or below</label><input id="r" name="reorder_level" inputmode="numeric" value="${esc(item.reorder_level != null ? item.reorder_level : 5)}"></div>
                <div class="field"><label><input type="checkbox" name="track_stock" value="1" ${item.track_stock === false ? '' : 'checked'} style="width:auto"> Track stock for this item</label></div>
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
            if (!c.rowCount) v.category_id = null;
        }
        return { v: { ...v, price_cents: price, cost_cents: cost }, error, stock };
    }
    router.get('/items/new', requireManager, ah(async (req, res) => send(req, res, { title: 'Add item', nav: 'items', body: await itemForm(req, {}) })));
    router.post('/items/new', requireManager, ah(async (req, res) => {
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
    router.get('/items/:id/edit', requireManager, ah(async (req, res) => {
        const item = await getItem(req, req.params.id);
        if (!item) return send(req, res, { title: 'Not found', nav: 'items', body: '<h1>Item not found</h1><a href="/pos/items">Back to items</a>' }, 404);
        send(req, res, { title: 'Edit item', nav: 'items', body: await itemForm(req, { item, isNew: false }) });
    }));
    router.post('/items/:id/edit', requireManager, ah(async (req, res) => {
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
    router.post('/items/:id/archive', requireManager, ah(async (req, res) => {
        const item = await getItem(req, req.params.id);
        if (item) await q('UPDATE pos_items SET active = NOT active WHERE id=$1 AND shop_id=$2', [item.id, req.shop.id]);
        res.redirect('/pos/items?ok=' + encodeURIComponent('Item updated.'));
    }));

    // ----- stock (manager+) -----
    router.get('/stock', requireManager, ah(async (req, res) => {
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
    router.post('/stock', requireManager, ah(async (req, res) => {
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
    router.get('/stock/history', requireManager, ah(async (req, res) => {
        const r = await q(`SELECT m.*, i.name FROM pos_stock_moves m JOIN pos_items i ON i.id = m.item_id WHERE m.shop_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 300`, [req.shop.id]);
        const label = { stock_in: 'Stock in', stock_out: 'Stock out', adjust: 'Stock count', sale: 'Sale', void: 'Sale voided' };
        send(req, res, { title: 'Stock History', nav: 'history', body: `<h1>Stock History</h1><div class="panel tablewrap">${r.rows.length ? `<table><tr><th>When</th><th>Item</th><th>Type</th><th class="num">Change</th><th class="num">Balance</th><th>Note</th></tr>${r.rows.map(m => `<tr><td class="nowrap">${esc(timeFmt(m.created_at))}</td><td>${esc(m.name)}</td><td>${esc(label[m.reason] || m.reason)}</td><td class="num"><b style="color:${m.change < 0 ? '#dc2626' : '#16a34a'}">${m.change > 0 ? '+' : ''}${m.change}</b></td><td class="num">${m.balance}</td><td>${esc(m.note)}</td></tr>`).join('')}</table>` : '<p class="muted">No stock movements yet.</p>'}</div>` });
    }));
    router.get('/stock/low', requireManager, ah(async (req, res) => {
        const r = await q(`SELECT id, name, stock, reorder_level FROM pos_items WHERE shop_id=$1 AND active AND track_stock AND stock <= reorder_level ORDER BY stock ASC, name`, [req.shop.id]);
        send(req, res, { title: 'Low Stock Alerts', nav: 'low', body: `<h1>Low Stock Alerts</h1><div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Item</th><th class="num">In stock</th><th class="num">Warning level</th><th></th></tr>${r.rows.map(i => `<tr><td>${esc(i.name)}</td><td class="num"><span class="tag ${i.stock <= 0 ? 'bad' : 'warn'}">${i.stock}</span></td><td class="num">${i.reorder_level}</td><td class="right"><a class="btn small" href="/pos/stock">Add stock</a></td></tr>`).join('')}</table>` : '<p class="muted">All good. Nothing is at or below its warning level.</p>'}</div>` });
    }));

    // ----- POS terminal (cashier, manager, owner) -----
    router.get('/api/items', ah(async (req, res) => {
        const r = await q(`SELECT i.id, i.name, i.barcode, i.price_cents, i.stock, i.track_stock, c.name AS category FROM pos_items i LEFT JOIN pos_categories c ON c.id = i.category_id WHERE i.shop_id=$1 AND i.active ORDER BY i.name LIMIT 2000`, [req.shop.id]);
        res.set('Cache-Control', 'no-store').json(r.rows.map(i => ({ id: i.id, name: i.name, barcode: i.barcode || '', price: i.price_cents, stock: i.track_stock ? i.stock : null, category: i.category || '' })));
    }));
    router.get('/terminal', ah(async (req, res) => {
        const vatRate = Number(req.shop.vat_rate || 16);
        const body = `<h1 class="noprint">POS Terminal — ${esc(req.shop.name)}</h1>
        <div class="pos-wrap">
            <div>
                <div class="panel" style="margin-bottom:0"><label for="find">Search items, or scan a barcode and press Enter</label><input id="find" type="search" autocomplete="off" autofocus placeholder="Type a name or scan..."><div class="chips" id="chips"></div></div>
                <div class="pos-items" id="grid" aria-live="polite"></div>
            </div>
            <div class="panel cart">
                <h2>Current sale</h2>
                <div class="lines" id="lines"><p class="muted" style="padding:10px 2px">Tap an item to add it.</p></div>
                <div class="tot"><span>Subtotal (Incl. VAT)</span><span id="sub">0.00</span></div>
                <div class="tot"><span>Discount (KES)</span><input id="disc" inputmode="decimal" style="width:110px;text-align:right" placeholder="0"></div>
                <div class="tot muted" style="font-size:.82rem"><span>Net (Excl. ${vatRate}% VAT)</span><span id="net">0.00</span></div>
                <div class="tot muted" style="font-size:.82rem"><span>VAT (${vatRate}% included)</span><span id="vat">0.00</span></div>
                <div class="tot big"><span>Total</span><span id="total">0.00</span></div>
                <div class="pay"><button type="button" id="m-cash" class="on">Cash</button><button type="button" id="m-mpesa">M-Pesa</button></div>
                <div id="cashbox" class="field"><label for="tender">Cash received (KES)</label><input id="tender" inputmode="decimal" placeholder="0"><div class="tot" style="margin-top:6px"><span>Change</span><b id="change">0.00</b></div></div>
                <div id="mpesabox" class="field" style="display:none"><label for="mref">M-Pesa code (from the customer's SMS)</label><input id="mref" maxlength="14" autocapitalize="characters" placeholder="e.g. SHK4A1B2C3"></div>
                <div class="field"><label for="cphone">Customer phone (optional, to share the receipt)</label><input id="cphone" type="tel" placeholder="0712345678"></div>
                <div id="err" class="alert" role="alert" style="display:none"></div>
                <button class="btn ok" id="done" type="button" style="width:100%;padding:13px;font-size:1rem" disabled>Complete sale</button>
                <button class="btn ghost" id="clear" type="button" style="width:100%;margin-top:8px">Clear sale</button>
            </div>
        </div>
        <div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="mtitle"><div class="box"><h2 id="mtitle">Sale complete</h2><p id="mtext" style="font-size:1.1rem"></p>
            <div class="row" style="justify-content:center"><a class="btn" id="mprint" target="_blank" rel="noopener">Print receipt</a><a class="btn ghost" id="mwa" target="_blank" rel="noopener" style="display:none">Send on WhatsApp</a></div>
            <button class="btn ok" id="mnew" type="button" style="margin-top:14px;width:100%">New sale</button></div></div>
        <script nonce="${req.nonce || ''}">
        (function () {
            var items = [], cart = [], cat = '', method = 'cash', busy = false, vatRate = ${JSON.stringify(vatRate)};
            var $ = function (id) { return document.getElementById(id); };
            function fmt(c) { return (c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
            function money(v) { var s = String(v || '').replace(/,/g, '').trim(); if (!/^\\d{1,9}(\\.\\d{1,2})?$/.test(s)) return 0; return Math.round(parseFloat(s) * 100); }
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
            function totals() {
                var s = 0; cart.forEach(function (l) { s += l.price * l.qty; });
                var d = Math.min(money($('disc').value), s), tot = s - d;
                var net = vatRate > 0 ? Math.round(tot / (1 + vatRate / 100)) : tot;
                return { sub: s, disc: d, total: tot, net: net, vat: tot - net };
            }
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
                var t = totals(); $('sub').textContent = fmt(t.sub); $('net').textContent = fmt(t.net); $('vat').textContent = fmt(t.vat); $('total').textContent = fmt(t.total);
                var tend = money($('tender').value); $('change').textContent = fmt(Math.max(0, tend - t.total));
                $('done').disabled = busy || !cart.length;
            }
            function setMethod(m) { method = m; $('m-cash').className = m === 'cash' ? 'on' : ''; $('m-mpesa').className = m === 'mpesa' ? 'on' : ''; $('cashbox').style.display = m === 'cash' ? '' : 'none'; $('mpesabox').style.display = m === 'mpesa' ? '' : 'none'; showErr(''); }
            function reset() { cart = []; $('disc').value = ''; $('tender').value = ''; $('mref').value = ''; $('cphone').value = ''; showErr(''); setMethod('cash'); render(); $('find').value = ''; draw(); load(); $('find').focus(); }
            $('find').addEventListener('input', draw);
            $('find').addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return; e.preventDefault(); var f = $('find').value.trim().toLowerCase(); if (!f) return;
                var hit = items.filter(function (i) { return i.barcode && i.barcode.toLowerCase() === f; })[0]; if (!hit) { var m = items.filter(function (i) { return i.name.toLowerCase().indexOf(f) >= 0; }); if (m.length === 1) hit = m[0]; }
                if (hit) { add(hit); $('find').value = ''; draw(); } else showErr('No item matches "' + $('find').value.trim() + '".');
            });
            ['disc', 'tender'].forEach(function (id) { $(id).addEventListener('input', render); });
            $('m-cash').addEventListener('click', function () { setMethod('cash'); }); $('m-mpesa').addEventListener('click', function () { setMethod('mpesa'); });
            $('clear').addEventListener('click', reset); $('mnew').addEventListener('click', function () { $('modal').classList.remove('show'); reset(); });
            $('done').addEventListener('click', function () {
                if (busy || !cart.length) return; var t = totals();
                if (method === 'cash' && money($('tender').value) < t.total) { showErr('The cash received is less than the total.'); return; }
                if (method === 'mpesa' && !/^[A-Za-z0-9]{8,14}$/.test($('mref').value.trim())) { showErr('Enter the M-Pesa code from the customer\\'s SMS.'); return; }
                busy = true; $('done').disabled = true; $('done').textContent = 'Saving...'; showErr('');
                fetch('/pos/api/sales', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    lines: cart.map(function (l) { return { id: l.id, qty: l.qty }; }), discount: $('disc').value, method: method, tendered: $('tender').value, mpesaRef: $('mref').value.trim(), customerPhone: $('cphone').value.trim() }) })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (x) {
                    busy = false; $('done').textContent = 'Complete sale';
                    if (!x.ok) { showErr(x.d.error || 'The sale could not be saved.'); render(); return; }
                    $('mtext').textContent = 'Receipt #' + x.d.receiptNo + ' - KES ' + fmt(x.d.total) + (x.d.change ? ' - Change KES ' + fmt(x.d.change) : '');
                    $('mprint').href = x.d.receiptUrl; var wa = $('mwa'); if (x.d.whatsapp) { wa.href = x.d.whatsapp; wa.style.display = ''; } else wa.style.display = 'none';
                    $('modal').classList.add('show'); $('mnew').focus();
                }).catch(function () { busy = false; $('done').textContent = 'Complete sale'; showErr('Connection problem. Check Sales History before trying again.'); render(); });
            });
            setMethod('cash'); render(); load();
        })();
        </script>`;
        send(req, res, { title: 'POS Terminal', nav: 'terminal', body });
    }));

    const saleLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait a moment.' } });
    router.post('/api/sales', saleLimiter, ah(async (req, res) => {
        const bad = (m, code = 400) => res.status(code).json({ error: m });
        const b = req.body || {};
        const method = b.method === 'mpesa' ? 'mpesa' : b.method === 'cash' ? 'cash' : '';
        if (!method) return bad('Choose cash or M-Pesa.');
        if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) return bad('The sale has no items.');
        const want = new Map();
        for (const l of b.lines) {
            const id = parseCount(l && l.id, { min: 1 }), qty = parseCount(l && l.qty, { min: 1, max: 100000 });
            if (!id || !qty) return bad('One of the items is not valid.');
            want.set(id, (want.get(id) || 0) + qty);
        }
        const discountIn = String(b.discount || '').trim() === '' ? 0 : parseMoney(b.discount);
        if (discountIn === null) return bad('The discount must be a number.');
        const mref = method === 'mpesa' ? String(b.mpesaRef || '').trim().toUpperCase() : '';
        if (method === 'mpesa' && !/^[A-Z0-9]{8,14}$/.test(mref)) return bad('Enter the M-Pesa code from the customer\'s SMS.');
        const phoneRaw = String(b.customerPhone || '').replace(/[\s-]/g, '');
        let phone = '';
        if (phoneRaw) {
            const m = phoneRaw.match(/^(?:\+?254|0)([17]\d{8})$/);
            if (!m) return bad('The customer phone number is not valid.');
            phone = '254' + m[1];
        }
        const client = await pool().connect();
        try {
            await client.query('BEGIN');
            const ids = [...want.keys()];
            const found = (await client.query('SELECT id, name, price_cents, cost_cents, stock, track_stock FROM pos_items WHERE shop_id=$1 AND active AND id = ANY($2::int[]) ORDER BY id FOR UPDATE', [req.shop.id, ids])).rows;
            if (found.length !== ids.length) { await client.query('ROLLBACK'); return bad('An item in the cart is no longer available. Refresh and try again.', 409); }
            let subtotal = 0;
            for (const it of found) {
                const qty = want.get(it.id);
                if (it.track_stock && it.stock < qty) { await client.query('ROLLBACK'); return bad(`Not enough stock for "${it.name}": ${it.stock} left.`, 409); }
                subtotal += Number(it.price_cents) * qty;
            }
            const discount = Math.min(discountIn, subtotal);
            const total = subtotal - discount;
            const { vat } = calcInclusiveVat(total, req.shop.vat_rate || 16);

            let paid = total, change = 0;
            if (method === 'cash') {
                const tendered = String(b.tendered || '').trim() === '' ? null : parseMoney(b.tendered);
                if (tendered === null || tendered < total) { await client.query('ROLLBACK'); return bad('The cash received is less than the total.'); }
                paid = tendered; change = tendered - total;
            }
            const no = (await client.query('UPDATE pos_shops SET next_receipt = next_receipt + 1 WHERE id=$1 RETURNING next_receipt - 1 AS no', [req.shop.id])).rows[0].no;
            const sale = (await client.query(
                `INSERT INTO pos_sales (shop_id, cashier_user_id, receipt_no, subtotal_cents, discount_cents, vat_cents, total_cents, paid_cents, change_cents, method, mpesa_ref, customer_phone)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
                [req.shop.id, req.session.user.id, no, subtotal, discount, vat, total, paid, change, method, mref || null, phone]
            )).rows[0];
            for (const it of found) {
                const qty = want.get(it.id);
                await client.query('INSERT INTO pos_sale_items (sale_id, item_id, name, qty, unit_price_cents, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6)', [sale.id, it.id, it.name, qty, it.price_cents, it.cost_cents]);
                if (it.track_stock) {
                    const nb = it.stock - qty;
                    await client.query('UPDATE pos_items SET stock=$2 WHERE id=$1', [it.id, nb]);
                    await client.query(`INSERT INTO pos_stock_moves (shop_id, item_id, change, balance, reason, note, sale_id) VALUES ($1,$2,$3,$4,'sale',$5,$6)`, [req.shop.id, it.id, -qty, nb, 'Receipt #' + no, sale.id]);
                }
            }
            await client.query('COMMIT');
            let whatsapp = '';
            if (phone) {
                const msg = `Thank you for shopping at ${req.shop.name}. Receipt #${no}: KES ${fmt(total)} (Incl. KES ${fmt(vat)} VAT) paid by ${method === 'mpesa' ? 'M-Pesa' : 'cash'}.`;
                whatsapp = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
            }
            res.json({ ok: true, saleId: sale.id, receiptNo: no, total, vat, change, receiptUrl: `/pos/sales/${sale.id}/receipt`, whatsapp });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
    }));

    // ----- sales history, branded VAT receipts, void -----
    router.get('/sales', ah(async (req, res) => {
        const from = validDate(req.query.from) ? req.query.from : addDays(todayNairobi(), -6), to = validDate(req.query.to) ? req.query.to : todayNairobi();
        const r = await q(`
            SELECT s.id, s.receipt_no, s.total_cents, s.vat_cents, s.method, s.mpesa_ref, s.status, s.created_at, u.name AS cashier_name
            FROM pos_sales s
            LEFT JOIN users u ON u.id = s.cashier_user_id
            WHERE s.shop_id=$1 AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3
            ORDER BY s.created_at DESC LIMIT 500`, [req.shop.id, from, to]);
        const sum = r.rows.filter(s => s.status === 'completed').reduce((a, s) => a + Number(s.total_cents), 0);
        const vatSum = r.rows.filter(s => s.status === 'completed').reduce((a, s) => a + Number(s.vat_cents || calcInclusiveVat(s.total_cents, req.shop.vat_rate).vat), 0);

        send(req, res, { title: 'Sales History', nav: 'sales', body: `<h1>Sales History</h1>${notice(req)}
        <div class="panel"><form method="GET" class="row"><div><label for="f">From</label><input id="f" type="date" name="from" value="${from}"></div><div><label for="t">To</label><input id="t" type="date" name="to" value="${to}"></div><button class="btn dark" type="submit">Show</button></form><p class="muted" style="margin:10px 0 0">${r.rows.length} sale${r.rows.length === 1 ? '' : 's'}, completed total <b>${kes(sum)}</b> (incl. <b>${kes(vatSum)}</b> VAT)</p></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Receipt</th><th>When</th><th>Cashier</th><th>Method</th><th class="num">VAT (16%)</th><th class="num">Total</th><th>Status</th><th></th></tr>${r.rows.map(s => {
            const vCents = s.vat_cents ? Number(s.vat_cents) : calcInclusiveVat(s.total_cents, req.shop.vat_rate).vat;
            return `<tr><td>#${s.receipt_no}</td><td class="nowrap">${esc(timeFmt(s.created_at))}</td><td>${esc(s.cashier_name || '-')}</td><td>${s.method === 'mpesa' ? 'M-Pesa ' + esc(s.mpesa_ref || '') : 'Cash'}</td><td class="num">${fmt(vCents)}</td><td class="num">${fmt(s.total_cents)}</td><td>${s.status === 'voided' ? '<span class="tag bad">voided</span>' : '<span class="tag ok">completed</span>'}</td><td class="right"><a class="btn small ghost" href="/pos/sales/${s.id}/receipt">Receipt</a></td></tr>`;
        }).join('')}</table>` : '<p class="muted">No sales in this period.</p>'}</div>` });
    }));

    const getSale = async (req, idParam) => {
        const id = parseCount(idParam, { min: 1 });
        if (!id) return null;
        const s = (await q(`
            SELECT s.*, u.name AS cashier_name
            FROM pos_sales s
            LEFT JOIN users u ON u.id = s.cashier_user_id
            WHERE s.id=$1 AND s.shop_id=$2`, [id, req.shop.id])).rows[0];
        if (!s) return null;
        s.lines = (await q('SELECT name, qty, unit_price_cents FROM pos_sale_items WHERE sale_id=$1 ORDER BY id', [s.id])).rows;
        return s;
    };

    router.get('/sales/:id/receipt', ah(async (req, res) => {
        const s = await getSale(req, req.params.id);
        if (!s) return send(req, res, { title: 'Not found', nav: 'sales', body: '<h1>Receipt not found</h1><a href="/pos/sales">Back to sales</a>' }, 404);
        const sh = req.shop;
        const vatRate = Number(sh.vat_rate || 16);
        const vatCents = Number(s.vat_cents) > 0 ? Number(s.vat_cents) : calcInclusiveVat(s.total_cents, vatRate).vat;
        const netCents = Number(s.total_cents) - vatCents;
        const canVoid = s.status === 'completed' && req.posRole !== 'cashier';
        const logoHtml = sh.logo_data && sh.logo_data.startsWith('data:image/') ? `<img src="${esc(sh.logo_data)}" alt="${esc(sh.name)}" class="receipt-logo">` : '';

        const body = `<div class="noprint" style="margin-bottom:14px"><button class="btn" id="prt" type="button">Print / Save as PDF</button> <a class="btn ghost" href="/pos/sales">Back to sales</a> ${canVoid ? `<form action="/pos/sales/${s.id}/void" method="POST" style="display:inline"><input name="reason" placeholder="Reason for voiding" maxlength="200" required style="width:220px;display:inline-block"> <button class="btn bad small" type="submit">Void sale</button></form>` : ''}</div>
        <div class="panel" style="max-width:380px;margin:0 auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88rem">
            <div style="text-align:center">
                ${logoHtml}
                <b style="font-size:1.15rem">${esc(sh.name)}</b><br>
                ${esc(sh.address)}${sh.phone ? '<br>Tel: ' + esc(sh.phone) : ''}${sh.tax_pin ? '<br>KRA PIN: ' + esc(sh.tax_pin) : ''}
            </div>
            <hr>
            <div>
                Receipt #${s.receipt_no}${s.status === 'voided' ? ' <b>(VOIDED)</b>' : ''}<br>
                Date: ${esc(timeFmt(s.created_at))}<br>
                Served by: ${esc(s.cashier_name || 'Staff')}
            </div>
            <hr>
            <table style="font-size:.88rem">${s.lines.map(l => `<tr><td style="border:0;padding:3px 0">${esc(l.name)}<br><span class="muted">${l.qty} x ${fmt(l.unit_price_cents)}</span></td><td class="num" style="border:0;padding:3px 0">${fmt(Number(l.unit_price_cents) * l.qty)}</td></tr>`).join('')}</table>
            <hr>
            <div class="tot"><span>Subtotal</span><span>${fmt(s.subtotal_cents)}</span></div>
            ${Number(s.discount_cents) ? `<div class="tot"><span>Discount</span><span>-${fmt(s.discount_cents)}</span></div>` : ''}
            <div class="tot"><span>Taxable (Excl. VAT)</span><span>${fmt(netCents)}</span></div>
            <div class="tot"><span>VAT (${vatRate}% Incl.)</span><span>${fmt(vatCents)}</span></div>
            <div class="tot big"><span>TOTAL</span><span>KES ${fmt(s.total_cents)}</span></div>
            <div class="tot"><span>Paid (${s.method === 'mpesa' ? 'M-Pesa' : 'Cash'})</span><span>${fmt(s.paid_cents)}</span></div>
            ${s.method === 'mpesa' ? `<div class="tot"><span>M-Pesa code</span><span>${esc(s.mpesa_ref || '')}</span></div>` : ''}
            ${Number(s.change_cents) ? `<div class="tot"><span>Change</span><span>${fmt(s.change_cents)}</span></div>` : ''}
            ${s.status === 'voided' ? `<hr><div>Voided: ${esc(s.void_reason || '')}</div>` : ''}
            <hr><div style="text-align:center">${esc(sh.receipt_footer)}</div>
            <div style="text-align:center;margin-top:8px;font-size:.75rem" class="muted">Prices inclusive of ${vatRate}% VAT · Tencent POS</div>
        </div>
        <script nonce="${req.nonce || ''}">document.getElementById('prt').addEventListener('click',function(){window.print();});</script>`;
        send(req, res, { title: 'Receipt #' + s.receipt_no, nav: 'sales', body });
    }));

    router.post('/sales/:id/void', requireManager, ah(async (req, res) => {
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

    // ----- daily report (Z-report with 16% inclusive VAT breakdown) -----
    async function periodSummary(shopId, from, to) {
        const f = `(created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3`;
        const [s, v, p, e, top] = await Promise.all([
            q(`SELECT count(*)::int n, COALESCE(sum(subtotal_cents),0)::bigint gross, COALESCE(sum(discount_cents),0)::bigint disc,
                      COALESCE(sum(vat_cents),0)::bigint vat, COALESCE(sum(total_cents),0)::bigint total,
                      COALESCE(sum(total_cents) FILTER (WHERE method='cash'),0)::bigint cash, COALESCE(sum(total_cents) FILTER (WHERE method='mpesa'),0)::bigint mpesa
               FROM pos_sales WHERE shop_id=$1 AND status='completed' AND ${f}`, [shopId, from, to]),
            q(`SELECT count(*)::int n, COALESCE(sum(total_cents),0)::bigint total FROM pos_sales WHERE shop_id=$1 AND status='voided' AND ${f}`, [shopId, from, to]),
            q(`SELECT COALESCE(sum((si.unit_price_cents - si.unit_cost_cents) * si.qty),0)::bigint profit, COALESCE(sum(si.qty),0)::int units FROM pos_sale_items si JOIN pos_sales s ON s.id = si.sale_id WHERE s.shop_id=$1 AND s.status='completed' AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3`, [shopId, from, to]),
            q(`SELECT COALESCE(sum(amount_cents),0)::bigint total FROM pos_expenses WHERE shop_id=$1 AND spent_on BETWEEN $2 AND $3`, [shopId, from, to]),
            q(`SELECT si.name, sum(si.qty)::int qty, sum(si.qty * si.unit_price_cents)::bigint revenue FROM pos_sale_items si JOIN pos_sales s ON s.id = si.sale_id WHERE s.shop_id=$1 AND s.status='completed' AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 GROUP BY si.name ORDER BY qty DESC, revenue DESC LIMIT 10`, [shopId, from, to])
        ]);
        const S = s.rows[0], P = p.rows[0], E = e.rows[0];
        const gross = Number(P.profit) - Number(S.disc);
        return { S, V: v.rows[0], units: P.units, gross, expenses: Number(E.total), net: gross - Number(E.total), top: top.rows };
    }
    router.get('/daily', requireManager, ah(async (req, res) => {
        const day = validDate(req.query.date) ? req.query.date : todayNairobi();
        const r = await periodSummary(req.shop.id, day, day);
        const netSales = Number(r.S.total) - Number(r.S.vat);
        const row = (k, v, strong) => `<tr><td>${strong ? '<b>' + k + '</b>' : k}</td><td class="num">${strong ? '<b>' + v + '</b>' : v}</td></tr>`;
        send(req, res, { title: 'Daily Sales', nav: 'daily', body: `<h1>Daily Sales (Z-Report)</h1>
        <div class="panel noprint"><form method="GET" class="row"><div><label for="d">Date</label><input id="d" type="date" name="date" value="${day}"></div><button class="btn dark" type="submit">Show</button><button class="btn" type="button" id="prt">Print</button></form></div>
        <div class="panel" style="max-width:560px"><h2>${esc(req.shop.name)}: ${esc(dateFmt(day + 'T12:00:00+03:00'))}</h2><table>
            ${row('Number of sales', r.S.n)}${row('Items sold', r.units)}${row('Sales before discounts', kes(r.S.gross))}${row('Discounts given', '-' + kes(r.S.disc))}
            ${row('Net sales (Excl. VAT)', kes(netSales))}${row('Output VAT (16% included)', kes(r.S.vat))}${row('Total sales (Incl. VAT)', kes(r.S.total), true)}
            ${row('Cash sales (expected in the drawer)', kes(r.S.cash))}${row('M-Pesa sales', kes(r.S.mpesa))}${row('Voided sales (' + r.V.n + ')', kes(r.V.total))}
            ${row('Gross profit', kes(r.gross))}${row('Expenses', kes(r.expenses))}${row('Net profit', (r.net < 0 ? '-' : '') + kes(Math.abs(r.net)), true)}</table></div>
        <div class="panel" style="max-width:560px"><h2>Best sellers</h2>${r.top.length ? `<table><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr>${r.top.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num">${fmt(t.revenue)}</td></tr>`).join('')}</table>` : '<p class="muted">No sales on this day.</p>'}</div>
        <script nonce="${req.nonce || ''}">document.getElementById('prt').addEventListener('click',function(){window.print();});</script>` });
    }));

    // ----- expenses (manager+) -----
    router.get('/expenses', requireManager, ah(async (req, res) => {
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
    router.post('/expenses', requireManager, ah(async (req, res) => {
        const category = str(req.body.category).slice(0, 60), amount = parseMoney(req.body.amount), date = req.body.date;
        if (!category || amount === null || amount <= 0 || !validDate(date)) return res.redirect('/pos/expenses?err=' + encodeURIComponent('Please enter a category, a valid amount and a date.'));
        await q('INSERT INTO pos_expenses (shop_id, category, amount_cents, note, spent_on) VALUES ($1,$2,$3,$4,$5)', [req.shop.id, category, amount, str(req.body.note).slice(0, 200), date]);
        res.redirect('/pos/expenses?ok=' + encodeURIComponent('Expense saved.'));
    }));
    router.post('/expenses/:id/delete', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_expenses WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        res.redirect('/pos/expenses?ok=' + encodeURIComponent('Expense deleted.'));
    }));

    // ----- reports (manager+) -----
    router.get('/reports', requireManager, ah(async (req, res) => {
        const today = todayNairobi();
        const from = validDate(req.query.from) ? req.query.from : today.slice(0, 8) + '01', to = validDate(req.query.to) ? req.query.to : today;
        const [r, days] = await Promise.all([
            periodSummary(req.shop.id, from, to),
            q(`SELECT (created_at AT TIME ZONE '${TZ}')::date AS d, count(*)::int n, sum(total_cents)::bigint total, sum(vat_cents)::bigint vat FROM pos_sales WHERE shop_id=$1 AND status='completed' AND (created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1 DESC LIMIT 366`, [req.shop.id, from, to])
        ]);
        const isoDay = d => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString() : String(d)).slice(0, 10);
        send(req, res, { title: 'Reports', nav: 'reports', body: `<h1>Reports</h1>
        <div class="panel"><form method="GET" class="row"><div><label for="f">From</label><input id="f" type="date" name="from" value="${from}"></div><div><label for="t">To</label><input id="t" type="date" name="to" value="${to}"></div><button class="btn dark" type="submit">Show</button><a class="btn ghost" href="/pos/reports.csv?from=${from}&to=${to}">Download CSV</a></form></div>
        <div class="cards"><div class="stat c1"><span>Total sales (Incl. VAT)</span><b>${kes(r.S.total)}</b><span>${r.S.n} sales · VAT ${kes(r.S.vat)}</span></div><div class="stat c3"><span>Gross profit</span><b>${kes(r.gross)}</b></div><div class="stat c4"><span>Expenses</span><b>${kes(r.expenses)}</b></div><div class="stat ${r.net >= 0 ? 'c2' : 'c9'}"><span>Net profit</span><b>${r.net < 0 ? '-' : ''}${kes(Math.abs(r.net))}</b></div><div class="stat c7"><span>Cash</span><b>${kes(r.S.cash)}</b></div><div class="stat c5"><span>M-Pesa</span><b>${kes(r.S.mpesa)}</b></div></div>
        <div class="grid2" style="align-items:start"><div class="panel"><h2>Best sellers</h2>${r.top.length ? `<table><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr>${r.top.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num">${fmt(t.revenue)}</td></tr>`).join('')}</table>` : '<p class="muted">No sales in this period.</p>'}</div>
        <div class="panel"><h2>Sales by day</h2>${days.rows.length ? `<div class="tablewrap"><table><tr><th>Day</th><th class="num">Sales</th><th class="num">VAT (16%)</th><th class="num">Total</th></tr>${days.rows.map(d => `<tr><td>${esc(dateFmt(isoDay(d.d) + 'T12:00:00+03:00'))}</td><td class="num">${d.n}</td><td class="num">${fmt(d.vat)}</td><td class="num">${fmt(d.total)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No sales in this period.</p>'}</div></div>` });
    }));
    router.get('/reports.csv', requireManager, ah(async (req, res) => {
        const today = todayNairobi();
        const from = validDate(req.query.from) ? req.query.from : today.slice(0, 8) + '01', to = validDate(req.query.to) ? req.query.to : today;
        const r = await q(`SELECT s.receipt_no, s.created_at, s.method, s.mpesa_ref, s.subtotal_cents, s.discount_cents, s.vat_cents, s.total_cents, s.status, string_agg(si.name || ' x' || si.qty, '; ' ORDER BY si.id) AS items
            FROM pos_sales s LEFT JOIN pos_sale_items si ON si.sale_id = s.id WHERE s.shop_id=$1 AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3 GROUP BY s.id ORDER BY s.created_at`, [req.shop.id, from, to]);
        const lines = [['Receipt', 'Date', 'Method', 'M-Pesa code', 'Subtotal', 'Discount', 'VAT (16%)', 'Total (Incl. VAT)', 'Status', 'Items'].map(csvCell).join(',')];
        for (const s of r.rows) lines.push([s.receipt_no, timeFmt(s.created_at), s.method, s.mpesa_ref || '', (s.subtotal_cents / 100).toFixed(2), (s.discount_cents / 100).toFixed(2), (Number(s.vat_cents || 0) / 100).toFixed(2), (s.total_cents / 100).toFixed(2), s.status, s.items || ''].map(csvCell).join(','));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sales-${from}-to-${to}.csv"`, 'Cache-Control': 'no-store' }).send('\uFEFF' + lines.join('\r\n'));
    }));

    // ----- settings with shop logo upload & receipt branding -----
    router.get('/settings', requireManager, ah(async (req, res) => {
        const s = req.shop;
        const preview = s.logo_data && s.logo_data.startsWith('data:image/')
            ? `<div style="margin:8px 0"><img src="${esc(s.logo_data)}" alt="Shop Logo" style="max-height:70px;border:1px solid var(--line);border-radius:6px;padding:4px"></div>`
            : '<p class="muted" style="font-size:.85rem">No logo uploaded yet.</p>';

        send(req, res, { title: 'Shop Settings', nav: 'settings', body: `<h1>Shop Settings & Receipt Branding</h1>${notice(req)}${errBox(req)}
        <div class="panel" style="max-width:620px">
            <form action="/pos/settings" method="POST" id="settings-form">
                <div class="field">
                    <label for="logo-file">Shop Logo (appears at top of printed receipts)</label>
                    ${preview}
                    <input id="logo-file" type="file" accept="image/png,image/jpeg,image/webp">
                    <input type="hidden" name="logo_data" id="logo-data" value="${esc(s.logo_data || '')}">
                    <small>Automatically resized for crisp thermal/A4 printing. <button type="button" id="clear-logo" class="btn small ghost" style="margin-left:6px">Remove logo</button></small>
                </div>
                <div class="field"><label for="n">Shop / Branch Name</label><input id="n" name="name" required maxlength="120" value="${esc(s.name)}"></div>
                <div class="field"><label for="p">Phone</label><input id="p" name="phone" maxlength="40" value="${esc(s.phone)}"></div>
                <div class="field"><label for="a">Address</label><input id="a" name="address" maxlength="200" value="${esc(s.address)}"></div>
                <div class="field"><label for="k">KRA PIN (printed on VAT receipts)</label><input id="k" name="tax_pin" maxlength="40" value="${esc(s.tax_pin)}"></div>
                <div class="field"><label for="f">Receipt footer message</label><input id="f" name="footer" maxlength="200" value="${esc(s.receipt_footer)}"></div>
                <button class="btn" type="submit">Save Settings</button>
            </form>
        </div>
        <script nonce="${req.nonce || ''}">
        (function(){
            var inp = document.getElementById('logo-file'), hidden = document.getElementById('logo-data'), clr = document.getElementById('clear-logo');
            if (clr) clr.addEventListener('click', function(){ hidden.value = ''; inp.value = ''; });
            if (inp) inp.addEventListener('change', function(){
                var file = inp.files && inp.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function(e){
                    var img = new Image();
                    img.onload = function(){
                        var maxW = 240, scale = img.width > maxW ? maxW / img.width : 1;
                        var c = document.createElement('canvas');
                        c.width = Math.round(img.width * scale);
                        c.height = Math.round(img.height * scale);
                        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                        hidden.value = c.toDataURL('image/png');
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            });
        })();
        </script>` });
    }));

    router.post('/settings', requireManager, logoBodyParser, ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120);
        if (name.length < 2) return res.redirect('/pos/settings?err=' + encodeURIComponent('Shop name is too short.'));
        const logoRaw = typeof req.body.logo_data === 'string' ? req.body.logo_data.trim() : '';
        const logoSafe = (logoRaw === '' || (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logoRaw) && logoRaw.length <= 350000)) ? logoRaw : req.shop.logo_data;

        await q(
            'UPDATE pos_shops SET name=$2, phone=$3, address=$4, tax_pin=$5, receipt_footer=$6, logo_data=$7 WHERE id=$1',
            [req.shop.id, name, str(req.body.phone).slice(0, 40), str(req.body.address).slice(0, 200), str(req.body.tax_pin).slice(0, 40), str(req.body.footer).slice(0, 200), logoSafe]
        );
        res.redirect('/pos/settings?ok=' + encodeURIComponent('Shop branding & settings saved.'));
    }));

    // ======================= EXTRA PAGES =======================
    const errBox = req => req.query.err ? `<div class="alert" role="alert">${esc(String(req.query.err).slice(0, 160))}</div>` : '';
    const back = (res, path, ok, err) => res.redirect(path + '?' + (err ? 'err=' + encodeURIComponent(err) : 'ok=' + encodeURIComponent(ok)));
    const delBtn = action => `<form action="${action}" method="POST" style="display:inline"><button class="btn small ghost" type="submit">Delete</button></form>`;
    const itemOptions = items => '<option value="">-</option>' + items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
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

    // ----- suppliers (manager+) -----
    router.get('/suppliers', requireManager, ah(async (req, res) => {
        const r = await q('SELECT * FROM pos_suppliers WHERE shop_id=$1 ORDER BY name', [req.shop.id]);
        send(req, res, { title: 'Suppliers', nav: 'suppliers', body: `<h1>Suppliers</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/suppliers" method="POST"><div class="grid2">
            <div class="field"><label for="n">Supplier name</label><input id="n" name="name" required maxlength="120"></div>
            <div class="field"><label for="p">Phone</label><input id="p" name="phone" maxlength="40"></div>
            <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" maxlength="160"></div>
            <div class="field"><label for="a">Address</label><input id="a" name="address" maxlength="200"></div></div><button class="btn" type="submit">Add supplier</button></form></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Name</th><th>Phone</th><th>Email</th><th>Address</th><th></th></tr>${r.rows.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.phone)}</td><td>${esc(s.email)}</td><td>${esc(s.address)}</td><td class="right">${delBtn('/pos/suppliers/' + s.id + '/delete')}</td></tr>`).join('')}</table>` : '<p class="muted">No suppliers yet.</p>'}</div>` });
    }));
    router.post('/suppliers', requireManager, ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120);
        if (!name) return back(res, '/pos/suppliers', '', 'Please enter the supplier name.');
        await q('INSERT INTO pos_suppliers (shop_id, name, phone, email, address) VALUES ($1,$2,$3,$4,$5)', [req.shop.id, name, str(req.body.phone).slice(0, 40), str(req.body.email).slice(0, 160), str(req.body.address).slice(0, 200)]);
        back(res, '/pos/suppliers', 'Supplier added.');
    }));
    router.post('/suppliers/:id/delete', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_suppliers WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/suppliers', 'Supplier deleted.');
    }));

    // ----- purchase orders (manager+) -----
    router.get('/purchase-orders', requireManager, ah(async (req, res) => {
        const r = await q(`SELECT p.id, p.po_no, p.status, p.created_at, s.name AS supplier, COALESCE(sum(l.qty * l.cost_cents),0)::bigint total FROM pos_purchase_orders p LEFT JOIN pos_suppliers s ON s.id=p.supplier_id LEFT JOIN pos_po_lines l ON l.po_id=p.id WHERE p.shop_id=$1 GROUP BY p.id, s.name ORDER BY p.created_at DESC LIMIT 200`, [req.shop.id]);
        const tag = { open: 'warn', received: 'ok', cancelled: 'gray' };
        send(req, res, { title: 'Purchase Orders', nav: 'po', body: `<h1>Purchase Orders</h1>${notice(req)}${errBox(req)}<p><a class="btn" href="/pos/purchase-orders/new">New purchase order</a></p>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>PO</th><th>Date</th><th>Supplier</th><th class="num">Total</th><th>Status</th><th></th></tr>${r.rows.map(p => `<tr><td>#${p.po_no}</td><td>${esc(dateFmt(p.created_at))}</td><td>${esc(p.supplier || '-')}</td><td class="num">${fmt(p.total)}</td><td><span class="tag ${tag[p.status]}">${esc(p.status)}</span></td><td class="right"><a class="btn small ghost" href="/pos/purchase-orders/${p.id}">Open</a></td></tr>`).join('')}</table>` : '<p class="muted">No purchase orders yet.</p>'}</div>` });
    }));
    router.get('/purchase-orders/new', requireManager, ah(async (req, res) => {
        const [items, sup] = await Promise.all([activeItems(req), q('SELECT id, name FROM pos_suppliers WHERE shop_id=$1 ORDER BY name', [req.shop.id])]);
        send(req, res, { title: 'New purchase order', nav: 'po', body: `<h1>New purchase order</h1>${errBox(req)}<div class="panel"><form action="/pos/purchase-orders/new" method="POST">
            <div class="field" style="max-width:380px"><label for="s">Supplier</label><select id="s" name="supplier_id"><option value="">No supplier</option>${sup.rows.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
            <div class="tablewrap"><table><tr><th>Item</th><th>Qty</th><th>Unit cost (KES)</th></tr>${lineRows(items, 'Unit cost')}</table></div>
            <div class="field" style="margin-top:12px"><label for="n">Note</label><input id="n" name="note" maxlength="200"></div>
            <button class="btn" type="submit">Save order</button> <a class="btn ghost" href="/pos/purchase-orders">Cancel</a></form></div>` });
    }));
    router.post('/purchase-orders/new', requireManager, ah(async (req, res) => {
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
    router.get('/purchase-orders/:id', requireManager, ah(async (req, res) => {
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
    router.post('/purchase-orders/:id/receive', requireManager, ah(async (req, res) => {
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
    router.post('/purchase-orders/:id/cancel', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q(`UPDATE pos_purchase_orders SET status='cancelled' WHERE id=$1 AND shop_id=$2 AND status='open'`, [id, req.shop.id]);
        res.redirect('/pos/purchase-orders/' + (id || ''));
    }));

    // ----- quotes (manager+) -----
    router.get('/quotes', requireManager, ah(async (req, res) => {
        const r = await q(`SELECT c.id, c.quote_no, c.customer_name, c.status, c.created_at, COALESCE(sum(l.qty * l.unit_price_cents),0)::bigint total FROM pos_quotes c LEFT JOIN pos_quote_lines l ON l.quote_id=c.id WHERE c.shop_id=$1 GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`, [req.shop.id]);
        send(req, res, { title: 'Quotes', nav: 'quotes', body: `<h1>Quotes</h1>${notice(req)}<p><a class="btn" href="/pos/quotes/new">New quote</a></p>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Quote</th><th>Date</th><th>Customer</th><th class="num">Total</th><th>Status</th><th></th></tr>${r.rows.map(c => `<tr><td>#${c.quote_no}</td><td>${esc(dateFmt(c.created_at))}</td><td>${esc(c.customer_name || '-')}</td><td class="num">${fmt(c.total)}</td><td><span class="tag ${c.status === 'accepted' ? 'ok' : c.status === 'open' ? 'warn' : 'gray'}">${esc(c.status)}</span></td><td class="right"><a class="btn small ghost" href="/pos/quotes/${c.id}">Open</a></td></tr>`).join('')}</table>` : '<p class="muted">No quotes yet.</p>'}</div>` });
    }));
    router.get('/quotes/new', requireManager, ah(async (req, res) => {
        const items = await activeItems(req);
        send(req, res, { title: 'New quote', nav: 'quotes', body: `<h1>New quote</h1>${errBox(req)}<div class="panel"><form action="/pos/quotes/new" method="POST"><div class="grid2">
            <div class="field"><label for="c">Customer name</label><input id="c" name="customer_name" maxlength="120"></div>
            <div class="field"><label for="p">Customer phone</label><input id="p" name="customer_phone" maxlength="40"></div>
            <div class="field"><label for="v">Valid until</label><input id="v" type="date" name="valid_until" value="${addDays(todayNairobi(), 14)}"></div></div>
            <div class="tablewrap"><table><tr><th>Item</th><th>Qty</th><th>Unit price (KES)</th></tr>${lineRows(items, 'Unit price')}</table></div>
            <div class="field" style="margin-top:12px"><label for="n">Note</label><input id="n" name="note" maxlength="200"></div>
            <button class="btn" type="submit">Save quote</button> <a class="btn ghost" href="/pos/quotes">Cancel</a></form></div>` });
    }));
    router.post('/quotes/new', requireManager, ah(async (req, res) => {
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
    router.get('/quotes/:id', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        const c = id && (await q('SELECT * FROM pos_quotes WHERE id=$1 AND shop_id=$2', [id, req.shop.id])).rows[0];
        if (!c) return send(req, res, { title: 'Not found', nav: 'quotes', body: '<h1>Quote not found</h1><a href="/pos/quotes">Back</a>' }, 404);
        const lines = (await q('SELECT name, qty, unit_price_cents FROM pos_quote_lines WHERE quote_id=$1 ORDER BY id', [id])).rows;
        const total = lines.reduce((a, l) => a + l.qty * Number(l.unit_price_cents), 0), sh = req.shop;
        send(req, res, { title: 'Quote #' + c.quote_no, nav: 'quotes', body: `<div class="noprint" style="margin-bottom:14px"><button class="btn" id="prt" type="button">Print / Save as PDF</button> <a class="btn ghost" href="/pos/quotes">Back</a>
            ${c.status === 'open' ? `<form action="/pos/quotes/${id}/status" method="POST" style="display:inline"><button class="btn ok small" name="status" value="accepted">Mark accepted</button> <button class="btn ghost small" name="status" value="cancelled">Cancel quote</button></form>` : ''}</div>${notice(req)}
        <div class="panel" style="max-width:720px"><h1 style="margin-bottom:4px">Quotation #${c.quote_no}</h1><p><b>${esc(sh.name)}</b><br>${esc(sh.address)}${sh.phone ? '<br>Tel ' + esc(sh.phone) : ''}${sh.tax_pin ? '<br>PIN ' + esc(sh.tax_pin) : ''}</p>
        <p>Date: ${esc(dateFmt(c.created_at))}${c.valid_until ? '<br>Valid until: ' + esc(dateFmt(isoDate(c.valid_until) + 'T12:00:00+03:00')) : ''}<br>Customer: ${esc(c.customer_name || '-')} ${esc(c.customer_phone)}<br>Status: ${esc(c.status)}</p>
        <table><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr>${lines.map(l => `<tr><td>${esc(l.name)}</td><td class="num">${l.qty}</td><td class="num">${fmt(l.unit_price_cents)}</td><td class="num">${fmt(l.qty * Number(l.unit_price_cents))}</td></tr>`).join('')}<tr><td colspan="3"><b>Total (KES, Incl. 16% VAT)</b></td><td class="num"><b>${fmt(total)}</b></td></tr></table>${c.note ? '<p>' + esc(c.note) + '</p>' : ''}</div>
        <script nonce="${req.nonce || ''}">document.getElementById('prt').addEventListener('click',function(){window.print();});</script>` });
    }));
    router.post('/quotes/:id/status', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 }), st = ['accepted', 'cancelled'].includes(req.body.status) ? req.body.status : '';
        if (id && st) await q(`UPDATE pos_quotes SET status=$3 WHERE id=$1 AND shop_id=$2 AND status='open'`, [id, req.shop.id, st]);
        res.redirect('/pos/quotes/' + (id || ''));
    }));

    // ----- cash drawer (cashier, manager, owner) -----
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
        const r = await q('INSERT INTO pos_drawer (shop_id, opened_by, opening_cents) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.shop.id, req.session.user.id, amt]);
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

    // ----- expense categories, recurring, budgets, assets, notebook, csv (manager+) -----
    router.get('/expense-categories', requireManager, ah(async (req, res) => {
        const r = await q('SELECT id, name FROM pos_expense_cats WHERE shop_id=$1 ORDER BY name', [req.shop.id]);
        send(req, res, { title: 'Expense Categories', nav: 'ecats', body: `<h1>Expense Categories</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/expense-categories" method="POST" class="row"><div><label for="c">New category</label><input id="c" name="name" required maxlength="60"></div><button class="btn" type="submit">Add</button></form></div>
        <div class="panel">${r.rows.length ? `<table>${r.rows.map(c => `<tr><td>${esc(c.name)}</td><td class="right">${delBtn('/pos/expense-categories/' + c.id + '/delete')}</td></tr>`).join('')}</table>` : '<p class="muted">No custom categories yet.</p>'}</div>` });
    }));
    router.post('/expense-categories', requireManager, ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 60);
        if (name) await q('INSERT INTO pos_expense_cats (shop_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.shop.id, name]);
        back(res, '/pos/expense-categories', 'Category added.');
    }));
    router.post('/expense-categories/:id/delete', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_expense_cats WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/expense-categories', 'Category deleted.');
    }));
    const catList = async shopId => {
        const r = await q('SELECT name FROM pos_expense_cats WHERE shop_id=$1 UNION SELECT category FROM pos_expenses WHERE shop_id=$1 ORDER BY 1 LIMIT 100', [shopId]);
        return [...new Set(['Rent', 'Transport', 'Electricity', 'Wages', 'Licences', 'Packaging', 'Airtime', 'Other'].concat(r.rows.map(x => x.name)))];
    };
    router.get('/recurring', requireManager, ah(async (req, res) => {
        const [r, cats] = await Promise.all([q('SELECT * FROM pos_recurring WHERE shop_id=$1 ORDER BY day_of_month, id', [req.shop.id]), catList(req.shop.id)]);
        send(req, res, { title: 'Recurring Expenses', nav: 'recurring', body: `<h1>Recurring Expenses</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/recurring" method="POST"><div class="grid2">
            <div class="field"><label for="c">Category</label><input id="c" name="category" list="cl" required maxlength="60"><datalist id="cl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
            <div class="field"><label for="a">Amount (KES)</label><input id="a" name="amount" required inputmode="decimal"></div>
            <div class="field"><label for="d">Day of month (1 to 28)</label><input id="d" name="day" required inputmode="numeric" value="1"></div>
            <div class="field"><label for="n">Note</label><input id="n" name="note" maxlength="200"></div></div><button class="btn" type="submit">Add</button></form></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Category</th><th>Day</th><th class="num">Amount</th><th>Note</th><th></th></tr>${r.rows.map(x => `<tr><td>${esc(x.category)}</td><td>${x.day_of_month}</td><td class="num">${fmt(x.amount_cents)}</td><td>${esc(x.note)}</td><td class="right">${delBtn('/pos/recurring/' + x.id + '/delete')}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}</div>` });
    }));
    router.post('/recurring', requireManager, ah(async (req, res) => {
        const cat = str(req.body.category).slice(0, 60), amt = parseMoney(req.body.amount), day = parseCount(req.body.day, { min: 1, max: 28 });
        if (!cat || amt === null || amt <= 0 || !day) return back(res, '/pos/recurring', '', 'Enter a category, an amount and a day from 1 to 28.');
        await q('INSERT INTO pos_recurring (shop_id, category, amount_cents, note, day_of_month) VALUES ($1,$2,$3,$4,$5)', [req.shop.id, cat, amt, str(req.body.note).slice(0, 200), day]);
        await runRecurring(req.shop.id);
        back(res, '/pos/recurring', 'Saved.');
    }));
    router.post('/recurring/:id/delete', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_recurring WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/recurring', 'Deleted.');
    }));
    async function runRecurring(shopId) {
        const today = todayNairobi(), ym = today.slice(0, 7);
        const r = await q(`UPDATE pos_recurring SET last_run = make_date($2::int, $3::int, day_of_month) WHERE shop_id=$1 AND day_of_month <= $4 AND (last_run IS NULL OR to_char(last_run,'YYYY-MM') < $5) RETURNING category, amount_cents, note, last_run`,
            [shopId, Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), Number(today.slice(8, 10)), ym]);
        for (const x of r.rows) await q('INSERT INTO pos_expenses (shop_id, category, amount_cents, note, spent_on) VALUES ($1,$2,$3,$4,$5)', [shopId, x.category, x.amount_cents, (x.note ? x.note + ' ' : '') + '(recurring)', x.last_run]);
    }
    router.get('/budgets', requireManager, ah(async (req, res) => {
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
    router.post('/budgets', requireManager, ah(async (req, res) => {
        const cat = str(req.body.category).slice(0, 60), amt = parseMoney(req.body.amount);
        if (!cat || amt === null) return back(res, '/pos/budgets', '', 'Enter a category and an amount.');
        await q('INSERT INTO pos_budgets (shop_id, category, amount_cents) VALUES ($1,$2,$3) ON CONFLICT (shop_id, category) DO UPDATE SET amount_cents=EXCLUDED.amount_cents', [req.shop.id, cat, amt]);
        back(res, '/pos/budgets', 'Budget saved.');
    }));
    router.post('/budgets/delete', requireManager, ah(async (req, res) => {
        await q('DELETE FROM pos_budgets WHERE shop_id=$1 AND category=$2', [req.shop.id, str(req.body.category).slice(0, 60)]);
        back(res, '/pos/budgets', 'Budget deleted.');
    }));
    router.get('/assets', requireManager, ah(async (req, res) => {
        const r = await q('SELECT * FROM pos_assets WHERE shop_id=$1 ORDER BY bought_on DESC, id DESC', [req.shop.id]), today = todayNairobi();
        send(req, res, { title: 'Assets', nav: 'assets', body: `<h1>Assets</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/assets" method="POST"><div class="grid2">
            <div class="field"><label for="n">Asset name</label><input id="n" name="name" required maxlength="120" placeholder="e.g. Fridge, Shelves, Laptop"></div>
            <div class="field"><label for="c">Cost (KES)</label><input id="c" name="cost" required inputmode="decimal"></div>
            <div class="field"><label for="d">Date bought</label><input id="d" type="date" name="bought_on" value="${today}" required></div>
            <div class="field"><label for="l">Useful life (years)</label><input id="l" name="life" inputmode="numeric" value="5"></div>
            <div class="field"><label for="s">Value at end of life (KES)</label><input id="s" name="salvage" inputmode="decimal" value="0"></div></div><button class="btn" type="submit">Add asset</button></form></div>
        <div class="panel tablewrap">${r.rows.length ? `<table><tr><th>Asset</th><th>Bought</th><th class="num">Cost</th><th class="num">Current value</th><th></th></tr>${r.rows.map(a => `<tr><td>${esc(a.name)}</td><td>${esc(dateFmt(isoDate(a.bought_on) + 'T12:00:00+03:00'))}</td><td class="num">${fmt(a.cost_cents)}</td><td class="num">${fmt(assetBookValue(a, today))}</td><td class="right">${delBtn('/pos/assets/' + a.id + '/delete')}</td></tr>`).join('')}</table>` : '<p class="muted">No assets recorded.</p>'}</div>` });
    }));
    router.post('/assets', requireManager, ah(async (req, res) => {
        const name = str(req.body.name).slice(0, 120), cost = parseMoney(req.body.cost), salv = str(req.body.salvage) === '' ? 0 : parseMoney(req.body.salvage), life = parseCount(req.body.life || '5', { min: 1, max: 50 });
        if (!name || cost === null || cost <= 0 || salv === null || salv > cost || !life || !validDate(req.body.bought_on)) return back(res, '/pos/assets', '', 'Check the name, cost, date and useful life.');
        await q('INSERT INTO pos_assets (shop_id, name, cost_cents, bought_on, life_years, salvage_cents) VALUES ($1,$2,$3,$4,$5,$6)', [req.shop.id, name, cost, req.body.bought_on, life, salv]);
        back(res, '/pos/assets', 'Asset added.');
    }));
    router.post('/assets/:id/delete', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_assets WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/assets', 'Asset removed.');
    }));
    router.get('/notebook', requireManager, ah(async (req, res) => {
        const r = await q('SELECT * FROM pos_notes WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 200', [req.shop.id]);
        send(req, res, { title: 'Notebook', nav: 'notebook', body: `<h1>Notebook</h1>${notice(req)}${errBox(req)}
        <div class="panel"><form action="/pos/notebook" method="POST"><div class="field"><label for="t">Title</label><input id="t" name="title" required maxlength="120"></div><div class="field"><label for="b">Note</label><textarea id="b" name="body" rows="4" maxlength="4000"></textarea></div><button class="btn" type="submit">Save note</button></form></div>
        ${r.rows.map(n => `<div class="panel"><div class="row" style="align-items:center"><h2 style="margin:0">${esc(n.title)}</h2><span class="muted" style="flex:0 0 auto">${esc(timeFmt(n.created_at))}</span><span style="flex:0 0 auto">${delBtn('/pos/notebook/' + n.id + '/delete')}</span></div><p style="white-space:pre-wrap;margin-bottom:0">${esc(n.body)}</p></div>`).join('') || '<p class="muted">No notes yet.</p>'}` });
    }));
    router.post('/notebook', requireManager, ah(async (req, res) => {
        const title = str(req.body.title).slice(0, 120);
        if (!title) return back(res, '/pos/notebook', '', 'Please enter a title.');
        await q('INSERT INTO pos_notes (shop_id, title, body) VALUES ($1,$2,$3)', [req.shop.id, title, String(req.body.body || '').slice(0, 4000)]);
        back(res, '/pos/notebook', 'Note saved.');
    }));
    router.post('/notebook/:id/delete', requireManager, ah(async (req, res) => {
        const id = parseCount(req.params.id, { min: 1 });
        if (id) await q('DELETE FROM pos_notes WHERE id=$1 AND shop_id=$2', [id, req.shop.id]);
        back(res, '/pos/notebook', 'Note deleted.');
    }));
    router.get('/items.csv', requireManager, ah(async (req, res) => {
        const r = await q('SELECT i.name, c.name AS cat, i.barcode, i.price_cents, i.cost_cents, i.stock, i.track_stock, i.reorder_level, i.active FROM pos_items i LEFT JOIN pos_categories c ON c.id=i.category_id WHERE i.shop_id=$1 ORDER BY i.name', [req.shop.id]);
        const lines = [['Item', 'Category', 'Barcode', 'Price (Incl. 16% VAT)', 'Cost', 'Stock', 'Tracked', 'Reorder level', 'Active'].map(csvCell).join(',')];
        for (const i of r.rows) lines.push([i.name, i.cat || '', i.barcode || '', (i.price_cents / 100).toFixed(2), (i.cost_cents / 100).toFixed(2), i.stock, i.track_stock ? 'yes' : 'no', i.reorder_level, i.active ? 'yes' : 'no'].map(csvCell).join(','));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="items.csv"', 'Cache-Control': 'no-store' }).send('\uFEFF' + lines.join('\r\n'));
    }));

    app.use('/pos', router);
}

module.exports = mountPos;
module.exports.initSchema = initSchema;
