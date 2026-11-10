const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');

let PDFDocument = null;
try {
    PDFDocument = require('pdfkit');
} catch (_) {
    console.error('pdfkit is not installed: PDF receipts are disabled.');
}

const app = express();

// ---------------------------------------------------------------
// Environment variables used by this file
//   DATABASE_URL           Postgres connection string
//   DATABASE_SSL           "false" turns database SSL off (default: on)
//   DATABASE_SSL_STRICT    "true" also verifies the database certificate
//   SESSION_SECRET         32+ random characters, signs login cookies
//   LINK_SECRET            32+ random characters, signs booking/receipt links.
//                          Use a DIFFERENT value from MPESA_CALLBACK_SECRET.
//   MPESA_*  PUBLIC_BASE_URL  GMAIL_USER  GMAIL_APP_PASSWORD  NOTIFY_TO
//   TELEGRAM_TOKEN  TELEGRAM_CHAT_ID
// ---------------------------------------------------------------

app.set('trust proxy', 1);
app.disable('x-powered-by');

// An error nobody caught must be logged, never allowed to stop the whole site
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.message));

// Lets async route handlers send their errors to the error handler at the bottom
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 1. Per-request nonce + security headers (including a Content-Security-Policy)
app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    next();
});
app.use(
    helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
                scriptSrcAttr: ["'none'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:'],
                mediaSrc: ["'self'", 'https://assets.mixkit.co'],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"]
            }
        }
    })
);

// 2. Rate limiting (before sessions and the database, so floods are cheap to refuse)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    // Safaricom callbacks are never throttled; the status poll has its own limiter below
    skip: (req) => req.path.startsWith('/payments/cb/') || req.path.startsWith('/payments/status/')
});
const statusLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { status: 'throttled' }
});
const payLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many payment attempts from this network. Please try again later.'
});
// Slows down password guessing and account spam
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many sign-in attempts from this network. Please try again later.'
});
app.use(limiter);

// 3. Static images only. (Serving the whole folder would expose server.js and package.json.)
const IMAGE_FILES = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
const staticOpts = { index: false, dotfiles: 'ignore', maxAge: '1d' };
const imageServers = [__dirname, path.join(__dirname, 'public'), path.join(__dirname, 'images')]
    .map(dir => express.static(dir, staticOpts));
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!IMAGE_FILES.test(req.path)) return next();
    let i = 0;
    const tryNext = () => (i < imageServers.length ? imageServers[i++](req, res, tryNext) : next());
    tryNext();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '20kb' }));

// 4. Database (PostgreSQL)
const DB_URL = process.env.DATABASE_URL || '';
if (!DB_URL) console.error('DATABASE_URL is not set: accounts and bookings will not work until you add it.');
const dbIsLocal = /localhost|127\.0\.0\.1/.test(DB_URL);
const pool = new Pool({
    connectionString: DB_URL || undefined,
    ssl: (dbIsLocal || process.env.DATABASE_SSL === 'false')
        ? false
        : { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === 'true' },
    max: 10
});
pool.on('error', err => console.error('Postgres pool error:', err.message));

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            phone VARCHAR(50) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bookings (
            id VARCHAR(64) PRIMARY KEY,
            user_id INT REFERENCES users(id),
            name VARCHAR(255) NOT NULL,
            phone VARCHAR(50) NOT NULL,
            service VARCHAR(255) NOT NULL,
            location VARCHAR(255) NOT NULL,
            amount INT NOT NULL,
            account_ref VARCHAR(50) NOT NULL,
            status VARCHAR(50) NOT NULL,
            receipt VARCHAR(100),
            checkout_request_id VARCHAR(100),
            created_at BIGINT NOT NULL,
            paid_at BIGINT
        );
    `);
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_emailed BOOLEAN NOT NULL DEFAULT FALSE');

    // These can fail if old data already breaks the rule: log it and carry on
    const extras = [
        'CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (LOWER(email))',
        'CREATE UNIQUE INDEX IF NOT EXISTS bookings_account_ref_key ON bookings (account_ref)',
        'CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings (user_id)',
        'CREATE INDEX IF NOT EXISTS bookings_checkout_idx ON bookings (checkout_request_id)'
    ];
    for (const sql of extras) {
        try { await pool.query(sql); } catch (err) { console.error('Index not created:', err.message); }
    }
    console.log('PostgreSQL tables initialized successfully.');
}

// 5. Secrets
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    console.error('SESSION_SECRET is missing or too short: using a temporary one, so everyone is logged out on each restart.');
}
let LINK_SECRET = process.env.LINK_SECRET;
if (!LINK_SECRET || LINK_SECRET.length < 16) {
    // Derived from the session secret, never from the M-Pesa callback secret (which appears in URLs and logs)
    LINK_SECRET = crypto.createHmac('sha256', SESSION_SECRET).update('booking-links').digest('hex');
    console.error('LINK_SECRET is missing or too short: set it once and never change it, or old booking links stop working.');
}

// 6. Sessions (stored in PostgreSQL)
app.use(session({
    name: 'tnc.sid',
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: 'auto',          // secure on https (Render), still works on http for local testing
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

// 7. CSRF protection: every POST form carries a token tied to the visitor's session
function csrfToken(req) {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    return req.session.csrf;
}
function csrfField(req) {
    return req.session ? `<input type="hidden" name="_csrf" value="${csrfToken(req)}">` : '';
}
app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path.startsWith('/payments/cb/')) return next();
    const given = Buffer.from(String((req.body && req.body._csrf) || ''));
    const expected = Buffer.from(String((req.session && req.session.csrf) || ''));
    if (expected.length && given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    return errorPage(req, res, 403, 'Form expired', 'Your form session expired. Please go back, refresh the page and try again.', '/');
});

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------
function esc(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function flat(value) {
    return Array.isArray(value) ? value.join(', ') : (value || '');
}

// Only allow redirects to pages on this site (stops //evil.com style open redirects)
function safeRedirect(target, fallback = '/survey') {
    return (typeof target === 'string' && /^\/(?![\/\\])[^\r\n]*$/.test(target)) ? target : fallback;
}

function maskPhone(p) {
    const s = String(p || '');
    return s.length > 6 ? s.slice(0, 5) + '***' + s.slice(-3) : s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Data shape the PDF needs, from a database row
function receiptData(b) {
    return {
        accountRef: b.account_ref,
        name: b.name,
        phone: b.phone,
        service: b.service,
        location: b.location,
        amount: b.amount,
        receipt: b.receipt,
        paidAt: Number(b.paid_at) || null
    };
}
function receiptFileName(ref) {
    return `Tencent-Receipt-${String(ref || 'booking').replace(/[^A-Za-z0-9_-]/g, '')}.pdf`;
}

// ---------------------------------------------------------------
// Email notifications & PDF generation
// ---------------------------------------------------------------
const mailer = nodemailer.createTransport({
    service: 'gmail',
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});
const mailConfigured = () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

// Company logo (put logo.png next to server.js). Used on the website, PDF receipts and emails.
const LOGO_PATH = path.join(__dirname, 'logo.png');
const LOGO_EXISTS = fs.existsSync(LOGO_PATH);
if (!LOGO_EXISTS) console.error('logo.png not found next to server.js: receipts and emails will go out without the logo.');

function generatePdfBuffer(d) {
    return new Promise((resolve, reject) => {
        if (!PDFDocument) return reject(new Error('PDFKit not available'));
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const buffers = [];
        doc.on('data', chunk => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        try {
            if (LOGO_EXISTS) {
                // Letterhead: logo centred at the top (it already carries the name and tagline), contact line below
                doc.image(LOGO_PATH, (doc.page.width - 92) / 2, 34, { fit: [92, 96] });
                doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('Rangwe, Homa Bay County | Tel: 0740 311 014 | tencentbz@gmail.com', 50, 142, { width: 495, align: 'center' });
                doc.moveTo(50, 166).lineTo(545, 166).strokeColor('#cbd5e1').lineWidth(1).stroke();
                doc.x = 50; doc.y = 186;
            } else {
                doc.fillColor('#0284c7').fontSize(22).text('TENCENT INNOVATIONS', { align: 'center' });
                doc.fillColor('#64748b').fontSize(10).text('Rangwe, Homa Bay County | Tel: 0740 311 014 | tencentbz@gmail.com', { align: 'center' });
                doc.moveDown(2);
            }

            doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text('OFFICIAL PAYMENT RECEIPT', 50, doc.y, { align: 'center', width: 495 });
            doc.moveDown(1.5);

            const dateStr = new Date(d.paidAt || Date.now()).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
            const rows = [
                ['Reference / Account:', d.accountRef],
                ['Client Name:', d.name],
                ['Phone Number:', d.phone],
                ['Service Rendered:', d.service],
                ['Location:', d.location],
                ['Amount Paid:', `KES ${Number(d.amount).toLocaleString('en-KE')}`],
                ['M-Pesa Receipt:', d.receipt || 'See your M-Pesa SMS'],
                ['Date & Time:', `${dateStr} (EAT)`],
                ['Payment Status:', 'PAID & CONFIRMED']
            ];

            let y = doc.y;
            rows.forEach(([label, val]) => {
                const text = String(val === undefined || val === null || val === '' ? '-' : val);
                doc.font('Helvetica-Bold').fontSize(12).text(label, 50, y, { width: 160 });
                doc.font('Helvetica').text(text, 220, y, { width: 320 });
                // Long values (a long location) wrap, so move down by their real height
                y += Math.max(24, doc.heightOfString(text, { width: 320 }) + 8);
            });

            doc.fontSize(10).fillColor('#64748b').text('Thank you for choosing Tencent Innovations. This is an electronically generated receipt.', 50, y + 30, { align: 'center', width: 500 });
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// Alerts to YOU (Telegram + admin email). Customers get their own email in deliverReceipt().
async function notify(subject, fields, pdfBuffer = null) {
    const cleanSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 150);
    const rows = Object.entries(fields)
        .map(([label, val]) => {
            const safe = esc(flat(val));
            const display = /^https:\/\//.test(safe)
                ? `<a href="${safe}">Tap to open</a>`
                : /phone/i.test(label)
                    ? `<a href="tel:${safe}">${safe}</a>`
                    : safe;
            return `<p><strong>${esc(label)}:</strong> ${display}</p>`;
        })
        .join('');
    const time = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

    // Log the event but not the customer's details (they stay in the database and your alerts)
    console.log('EVENT:', cleanSubject, '|', time);

    const sendTelegram = async () => {
        if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
        const lines = Object.entries(fields).map(([label, val]) => `${label}: ${flat(val)}`);
        const text = `${cleanSubject}\n\n${lines.join('\n')}\n\n${time} (EAT)`.slice(0, 4000);
        const resp = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
            signal: AbortSignal.timeout(8000)
        });
        if (!resp.ok) throw new Error(`Telegram HTTP ${resp.status}`);
    };

    const sendAdminEmail = async () => {
        if (!mailConfigured()) return;
        const attachments = pdfBuffer ? [{ filename: 'Tencent-Receipt.pdf', content: pdfBuffer, contentType: 'application/pdf' }] : [];
        await mailer.sendMail({
            from: `"Tencent Website" <${process.env.GMAIL_USER}>`,
            to: process.env.NOTIFY_TO || process.env.GMAIL_USER,
            subject: cleanSubject,
            html: `<h3>${esc(cleanSubject)}</h3>${rows}<p style="color:#888">Received ${esc(time)} (EAT)</p>`,
            attachments
        });
    };

    const results = await Promise.allSettled([sendTelegram(), sendAdminEmail()]);
    if (results[0].status === 'rejected') console.error('Telegram failed:', results[0].reason && results[0].reason.message);
    if (results[1].status === 'rejected') console.error('Admin email failed:', results[1].reason && results[1].reason.message);
}

// Emails the PDF receipt to the customer. Runs at most once per booking, and only after payment.
async function deliverReceipt(bookingId) {
    const claim = await pool.query(
        'UPDATE bookings SET receipt_emailed = TRUE WHERE id = $1 AND status = $2 AND receipt_emailed = FALSE RETURNING *',
        [bookingId, 'paid']
    );
    if (claim.rows.length === 0) return;
    const b = claim.rows[0];
    if (!b.user_id) return;

    const u = await pool.query('SELECT email FROM users WHERE id = $1', [b.user_id]);
    if (u.rows.length === 0) return;
    if (!mailConfigured() || !PDFDocument) {
        console.log('Receipt email skipped: email or PDF is not set up.');
        return;
    }

    const pdf = await generatePdfBuffer(receiptData(b));
    const link = makeBookingLink(b);
    await mailer.sendMail({
        from: `"Tencent Innovations" <${process.env.GMAIL_USER}>`,
        to: u.rows[0].email,
        subject: `Your receipt: ${b.service} (${b.account_ref})`,
        html: `${LOGO_EXISTS ? '<img src="cid:tnclogo" alt="Tencent Innovations" width="90" style="display:block; margin-bottom:12px;">' : ''}
               <h3>Thank you, ${esc(b.name)}!</h3>
               <p>We have received your payment of <strong>KES ${esc(b.amount)}</strong> for <strong>${esc(b.service)}</strong>.</p>
               <p>Your official receipt is attached as a PDF. An engineer will call you to agree a time for the visit.</p>
               ${link ? `<p>Your booking page: <a href="${esc(link)}">${esc(link)}</a></p>` : ''}
               <p style="color:#888">Tencent Innovations | Rangwe, Homa Bay County | 0740 311 014</p>`,
        attachments: [
            { filename: receiptFileName(b.account_ref), content: pdf, contentType: 'application/pdf' },
            ...(LOGO_EXISTS ? [{ filename: 'logo.png', path: LOGO_PATH, cid: 'tnclogo' }] : [])
        ]
    });
    console.log('Receipt emailed for booking', b.account_ref);
}

// ---------------------------------------------------------------
// M-Pesa (Daraja) Configuration & Helpers
// ---------------------------------------------------------------
const MPESA = {
    production: process.env.MPESA_ENV === 'production',
    key: process.env.MPESA_CONSUMER_KEY,
    secret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    callbackSecret: process.env.MPESA_CALLBACK_SECRET,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
};
MPESA.baseUrl = process.env.MPESA_BASE_URL ||
    (MPESA.production ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');

function mpesaConfigured() {
    return Boolean(
        MPESA.key && MPESA.secret && MPESA.shortcode && MPESA.passkey &&
        MPESA.callbackSecret && MPESA.callbackSecret.length >= 16 &&
        MPESA.publicBaseUrl.startsWith('https://')
    );
}

// The server decides the price. The form only says which service was chosen.
const SERVICE_PRICES = {
    'Site Survey & Quotation': 3000,
    'WiFi Setup': 3000,
    'CCTV Installation': 3000,
    'Smart Locks': 2500,
    'Electric Fence': 5000,
    'Solar Consultation': 4000
};

function normalizePhone(raw) {
    let p = String(raw || '').replace(/[\s\-()]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
    else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
    return /^254[17]\d{8}$/.test(p) ? p : null;
}

const phoneAttempts = new Map();

function phoneAttemptAllowed(phone) {
    const now = Date.now();
    const recent = (phoneAttempts.get(phone) || []).filter(t => now - t < 60 * 60 * 1000);
    if (recent.length >= 3) { phoneAttempts.set(phone, recent); return false; }
    recent.push(now);
    phoneAttempts.set(phone, recent);
    return true;
}

// Per-booking throttle for asking Safaricom "did they pay?"
const lastQuery = new Map();

// Tidy in-memory data every 30 minutes so it cannot grow without limit
setInterval(() => {
    const now = Date.now();
    for (const [p, arr] of phoneAttempts) {
        const recent = arr.filter(t => now - t < 60 * 60 * 1000);
        if (recent.length) phoneAttempts.set(p, recent); else phoneAttempts.delete(p);
    }
    for (const [id, t] of lastQuery) if (now - t > 60 * 60 * 1000) lastQuery.delete(id);
}, 30 * 60 * 1000).unref();

let tokenCache = { value: null, expiresAt: 0 };
async function getAccessToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
    const auth = Buffer.from(`${MPESA.key}:${MPESA.secret}`).toString('base64');
    const resp = await fetch(`${MPESA.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) throw new Error(`Daraja authentication failed (HTTP ${resp.status})`);
    const data = await resp.json();
    tokenCache = {
        value: data.access_token,
        expiresAt: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000
    };
    return tokenCache.value;
}

function darajaTimestamp() {
    return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
}
function darajaPassword(timestamp) {
    return Buffer.from(`${MPESA.shortcode}${MPESA.passkey}${timestamp}`).toString('base64');
}

async function darajaPost(apiPath, payload) {
    const token = await getAccessToken();
    const resp = await fetch(`${MPESA.baseUrl}${apiPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000)
    });
    let data = {};
    try { data = await resp.json(); } catch (_) { /* non-JSON body */ }
    if (!resp.ok) {
        const err = new Error(data.errorMessage || data.ResultDesc || `Daraja HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
    }
    return data;
}

async function stkPush(booking) {
    const timestamp = darajaTimestamp();
    const data = await darajaPost('/mpesa/stkpush/v1/processrequest', {
        BusinessShortCode: MPESA.shortcode,
        Password: darajaPassword(timestamp),
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: booking.amount,
        PartyA: booking.phone,
        PartyB: MPESA.shortcode,
        PhoneNumber: booking.phone,
        CallBackURL: `${MPESA.publicBaseUrl}/payments/cb/${MPESA.callbackSecret}`,
        AccountReference: booking.accountRef,
        TransactionDesc: 'Survey fee'
    });
    if (String(data.ResponseCode) !== '0') throw new Error(data.ResponseDescription || 'STK push was rejected');
    return data;
}

async function stkQuery(checkoutRequestId) {
    const timestamp = darajaTimestamp();
    return darajaPost('/mpesa/stkpushquery/v1/query', {
        BusinessShortCode: MPESA.shortcode,
        Password: darajaPassword(timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
    });
}

// Works for a database row (account_ref) and for a fresh booking object (accountRef)
function bookingFields(b, extra = {}) {
    return {
        Name: b.name,
        Phone: b.phone,
        Service: b.service,
        Location: b.location,
        Amount: `KES ${b.amount}`,
        Reference: b.account_ref || b.accountRef,
        ...extra
    };
}

// ---------------------------------------------------------------
// Signed booking links. The link carries ONLY the booking id and a signature.
// The page always shows what is in the database, so a link can never claim
// a payment that did not happen, even if someone edits it.
// ---------------------------------------------------------------
function signLinkPart(part) {
    return crypto.createHmac('sha256', LINK_SECRET).update(part).digest('base64url');
}
function makeBookingLink(b) {
    if (!MPESA.publicBaseUrl.startsWith('https://')) return '';
    return `${MPESA.publicBaseUrl}/booking/${b.id}.${signLinkPart(b.id)}`;
}
// Returns the booking id if the signature is genuine, otherwise null
function readBookingLink(token) {
    token = String(token || '');
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const id = token.slice(0, dot);
    if (!UUID_RE.test(id)) return null;
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(signLinkPart(id));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return id;
}

// Marks a booking paid exactly once, even if the callback and the status check arrive together
async function markPaid(bookingId, receipt, verified) {
    const upd = await pool.query(
        "UPDATE bookings SET status = 'paid', receipt = $1, paid_at = $2 WHERE id = $3 AND status <> 'paid' RETURNING *",
        [receipt || '', Date.now(), bookingId]
    );
    if (upd.rows.length === 0) {
        // Already paid by the other path: just record the M-Pesa receipt number if we now have it
        if (receipt) {
            const r = await pool.query(
                "UPDATE bookings SET receipt = $1 WHERE id = $2 AND (receipt IS NULL OR receipt = '') RETURNING id",
                [receipt, bookingId]
            );
            if (r.rows.length) deliverReceipt(bookingId).catch(e => console.error('Receipt email failed:', e.message));
        }
        return;
    }
    const b = upd.rows[0];

    const link = makeBookingLink(b);
    const extra = {
        'M-Pesa receipt': receipt || '(see M-Pesa statement)',
        Verified: verified ? 'Yes, confirmed with Safaricom' : 'Callback only'
    };
    if (link) extra['Booking link'] = link;

    let pdf = null;
    try { if (PDFDocument) pdf = await generatePdfBuffer(receiptData(b)); }
    catch (e) { console.error('PDF generation error:', e.message); }
    await notify(`✅ PAID: ${b.service} - ${b.name}`, bookingFields(b, extra), pdf);

    if (receipt) {
        deliverReceipt(b.id).catch(e => console.error('Receipt email failed:', e.message));
    } else {
        // Confirmed by the status check before Safaricom's callback arrived. Wait a little for the
        // M-Pesa receipt number so the customer's PDF is complete; send anyway if it never comes.
        setTimeout(() => deliverReceipt(b.id).catch(e => console.error('Receipt email failed:', e.message)), 90 * 1000).unref();
    }
}

async function markFailed(bookingId, reason) {
    await pool.query('UPDATE bookings SET status = $1 WHERE id = $2 AND status = $3', ['failed', bookingId, 'pending']);
    console.log('PAYMENT NOT COMPLETED:', JSON.stringify({ id: bookingId, reason }));
}

async function handleCallback(body) {
    const cb = body && body.Body && body.Body.stkCallback;
    if (!cb) return;
    const checkoutId = cb.CheckoutRequestID;

    const res = await pool.query('SELECT * FROM bookings WHERE checkout_request_id = $1', [checkoutId]);
    if (res.rows.length === 0) return;
    const booking = res.rows[0];

    const succeeded = Number(cb.ResultCode) === 0;
    const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const meta = name => { const it = items.find(i => i.Name === name); return it ? it.Value : undefined; };
    const receipt = String(meta('MpesaReceiptNumber') || '').slice(0, 100);

    if (booking.status === 'paid') {
        if (succeeded && receipt && !booking.receipt) {
            await pool.query('UPDATE bookings SET receipt = $1 WHERE id = $2', [receipt, booking.id]);
            deliverReceipt(booking.id).catch(e => console.error('Receipt email failed:', e.message));
        }
        return;
    }
    if (!succeeded) { await markFailed(booking.id, cb.ResultDesc); return; }

    if (Number(meta('Amount')) !== booking.amount) {
        await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', ['review', booking.id]);
        await notify(`⚠️ CHECK PAYMENT: amount mismatch for ${booking.name}`, bookingFields(booking, {
            'Amount reported': String(meta('Amount')),
            'M-Pesa receipt': receipt
        }));
        return;
    }

    let verified = false;
    try {
        const q = await stkQuery(booking.checkout_request_id);
        verified = String(q.ResultCode) === '0';
        if (!verified) {
            await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', ['review', booking.id]);
            await notify(`⚠️ CHECK PAYMENT: callback and status query disagree for ${booking.name}`, bookingFields(booking, {
                'M-Pesa receipt': receipt,
                'Query result': `${q.ResultCode} ${q.ResultDesc || ''}`
            }));
            return;
        }
    } catch (err) {
        console.error('STK status query failed:', err.message);
    }
    await markPaid(booking.id, receipt, verified);
}

// Safaricom calls this when the customer pays, cancels or times out.
// The secret in the URL stops strangers from posting fake "payments".
app.post('/payments/cb/:secret', (req, res) => {
    const given = Buffer.from(String(req.params.secret));
    const expected = Buffer.from(String(MPESA.callbackSecret || ''));
    const ok = expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.sendStatus(404);

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    handleCallback(req.body).catch(err => console.error('Callback error:', err.message));
});

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    const target = req.method === 'GET' ? req.originalUrl : '/survey';
    res.redirect(`/login?redirect=${encodeURIComponent(target)}`);
}
function requireUserJson(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ status: 'unauthorized' });
}

// The "check your phone" page polls this. Only the person who made the booking can see it.
// If the callback never arrives, it asks Safaricom directly (at most once every 12 seconds).
app.get('/payments/status/:id', statusLimiter, requireUserJson, ah(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ status: 'unknown' });
    const r = await pool.query('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (r.rows.length === 0) return res.status(404).json({ status: 'unknown' });
    let b = r.rows[0];

    if (b.status === 'pending' && b.checkout_request_id &&
        Date.now() - Number(b.created_at) > 30000 && Date.now() - (lastQuery.get(b.id) || 0) > 12000) {
        lastQuery.set(b.id, Date.now());
        try {
            const q = await stkQuery(b.checkout_request_id);
            if (String(q.ResultCode) === '0') {
                await markPaid(b.id, '', true);
            } else if (q.ResultCode !== undefined && String(q.ResultCode) !== '' && String(q.ResultCode) !== '500.001.1001') {
                await markFailed(b.id, q.ResultDesc || 'Payment cancelled');
            }
        } catch (_) { /* still processing, or temporarily unavailable: stay pending */ }
        const updated = await pool.query('SELECT * FROM bookings WHERE id = $1', [b.id]);
        b = updated.rows[0];
    }

    const isPaid = b.status === 'paid';
    res.set('Cache-Control', 'private, no-store');
    res.json({
        status: b.status,
        link: isPaid ? makeBookingLink(b) : '',
        pdf: isPaid ? `/payments/receipt/${b.id}/download.pdf` : ''
    });
}));

// PDF receipt for the logged-in owner of the booking
app.get('/payments/receipt/:id/download.pdf', requireAuth, ah(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send('Receipt not available.');
    const r = await pool.query('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (r.rows.length === 0 || r.rows[0].status !== 'paid') {
        return res.status(404).send('Receipt not available or payment pending.');
    }
    if (!PDFDocument) return res.status(501).send('PDF generation disabled.');
    const b = r.rows[0];
    const buf = await generatePdfBuffer(receiptData(b));
    res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${receiptFileName(b.account_ref)}"`,
        'Content-Length': buf.length,
        'Cache-Control': 'private, no-store'
    });
    res.send(buf);
}));

// ---------------------------------------------------------------
// Layout Template Helper with Left Sidebar, Global Modal & Styling
// ---------------------------------------------------------------
function renderPage(req, { title, activeNav, content, showMpesaPopup = false }) {
    const user = req.session && req.session.user ? req.session.user : null;
    const nonce = (req.res && req.res.locals && req.res.locals.nonce) || '';
    return `
        <!DOCTYPE html>
        <html lang="en" data-theme="dark">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title} - Tencent Innovations</title>
            <link rel="icon" type="image/png" href="/logo.png">
            <script nonce="${nonce}">
                (function() {
                    const savedTheme = localStorage.getItem('theme') || 'dark';
                    document.documentElement.setAttribute('data-theme', savedTheme);
                })();
            </script>
            <style>
                :root {
                    --bg: #0b132b;
                    --surface: #1c2541;
                    --sidebar-bg: #060a17;
                    --text: #ffffff;
                    --muted: #94a3b8;
                    --border: #334155;
                    --primary: #0284c7;
                    --accent: #10b981;
                }
                [data-theme="light"] {
                    --bg: #f8fafc;
                    --surface: #ffffff;
                    --sidebar-bg: #ffffff;
                    --text: #0f172a;
                    --muted: #64748b;
                    --border: #cbd5e1;
                    --primary: #0284c7;
                    --accent: #16a34a;
                }

                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--text); line-height: 1.6; display: flex; min-height: 100vh; transition: background 0.3s, color 0.3s; }
                
                .sidebar { width: 260px; background: var(--sidebar-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: fixed; top: 0; bottom: 0; left: 0; z-index: 100; }
                .sidebar-header { padding: 24px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; background: rgba(0,0,0,0.2); }
                .logo-container { display: flex; align-items: center; gap: 12px; text-decoration: none; }
                .logo-img { height: 52px; width: auto; border-radius: 6px; background: #ffffff; padding: 2px; }
                .logo-text-group { display: flex; flex-direction: column; }
                .logo-text { font-size: 1.1rem; font-weight: bold; color: #38bdf8; text-decoration: none; line-height: 1.1; }
                .logo-tagline { font-size: 0.65rem; color: var(--muted); }

                .sidebar-nav { flex: 1; padding: 20px 12px; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; list-style: none; margin: 0; }
                .sidebar-nav a { color: var(--muted); text-decoration: none; font-weight: 500; font-size: 0.95rem; padding: 10px 14px; border-radius: 8px; transition: all 0.2s; display: flex; align-items: center; gap: 10px; }
                .sidebar-nav a:hover, .sidebar-nav a.active { color: var(--text); background: var(--surface); }

                .sidebar-auth-group { display: flex; flex-direction: column; gap: 8px; padding: 14px 12px; background: rgba(2, 132, 199, 0.08); border-radius: 10px; border: 1px solid var(--border); margin: 6px 0; }
                .sidebar-auth-btn { text-align: center; font-weight: bold; padding: 10px 14px; border-radius: 8px; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 0.95rem; transition: background 0.2s; }
                .sidebar-login-btn { background: var(--primary); color: #ffffff; }
                .sidebar-login-btn:hover { background: #0369a1; color: #ffffff; }
                .sidebar-register-btn { background: transparent; border: 1px solid var(--primary); color: var(--primary); }
                .sidebar-register-btn:hover { background: var(--surface); color: var(--text); }

                .sidebar-footer { padding: 15px 20px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
                .theme-toggle-btn { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
                .theme-toggle-btn:hover { background: var(--surface); }

                .main-content { margin-left: 260px; flex: 1; display: flex; flex-direction: column; min-height: 100vh; }
                .container { max-width: 100%; margin: 0 auto; padding: 0; flex: 1; width: 100%; box-sizing: border-box; }

                /* Modern 4-Column Grid Homepage Styling */
                .hero-video-container { position: relative; width: 100%; height: 420px; overflow: hidden; display: flex; align-items: center; justify-content: center; text-align: center; border-bottom: 3px solid var(--border); }
                .hero-video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; filter: brightness(0.45); }
                .hero-overlay-content { position: relative; z-index: 2; padding: 20px; max-width: 800px; }
                .hero-logo-badge { height: 110px; width: auto; background: #fff; padding: 6px; border-radius: 10px; margin-bottom: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
                .hero-overlay-content h1 { font-size: 2.3rem; color: #ffffff; margin: 0 0 10px 0; text-shadow: 0 2px 4px rgba(0,0,0,0.8); }
                .hero-overlay-content p { color: #e2e8f0; font-size: 1.15rem; margin: 0 0 20px 0; text-shadow: 0 1px 3px rgba(0,0,0,0.8); }

                .services-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; width: 100%; }
                .service-card { padding: 40px 20px; text-align: center; display: flex; flex-direction: column; justify-content: space-between; min-height: 320px; box-sizing: border-box; transition: transform 0.2s; position: relative; }
                .service-card:hover { transform: translateY(-4px); z-index: 10; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
                .service-card h3 { font-size: 1.25rem; font-weight: 800; letter-spacing: 0.05em; margin: 15px 0 10px 0; text-transform: uppercase; }
                .service-card p { font-size: 0.9rem; line-height: 1.5; margin-bottom: 25px; opacity: 0.9; }
                .service-icon { font-size: 2.3rem; margin-bottom: 10px; }
                
                .card-black { background: #000000; color: #ffffff; border-right: 1px solid #1e293b; }
                .card-gray { background: #334155; color: #ffffff; border-right: 1px solid #475569; }
                .card-light { background: #f1f5f9; color: #0f172a; border-right: 1px solid #cbd5e1; }
                .card-teal { background: #14b8a6; color: #000000; }

                .enquire-btn { display: inline-block; background: #ffffff; color: #0f172a; padding: 10px 20px; border-radius: 4px; font-weight: bold; text-decoration: none; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; transition: background 0.2s; }
                .card-black .enquire-btn { background: #0284c7; color: #fff; }
                .card-black .enquire-btn:hover { background: #0369a1; }
                .card-gray .enquire-btn { background: #0f172a; color: #fff; }
                .card-light .enquire-btn { background: #0f172a; color: #fff; }
                .card-teal .enquire-btn { background: #0f172a; color: #fff; }
                .enquire-btn:hover { opacity: 0.85; }

                .general-container { padding: 40px 30px; max-width: 900px; margin: 0 auto; }
                .form-container { background: var(--surface); border: 1px solid var(--border); padding: 30px; border-radius: 12px; margin-top: 20px; text-align: left; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
                .form-group { margin-bottom: 20px; }
                .form-group label { display: block; margin-bottom: 8px; color: var(--primary); font-weight: 600; }
                .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); box-sizing: border-box; font-size: 1rem; }

                .cta-btn { display: inline-block; background: var(--primary); color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; text-align: center; }
                .cta-btn:hover { opacity: 0.9; }
                .sub-title { color: var(--muted); font-size: 1.05rem; margin-top: -6px; margin-bottom: 20px; }
                .intro-text { font-size: 1.05rem; color: var(--text); margin-bottom: 20px; }
                .alert-error { background: rgba(248,113,113,0.12); border: 1px solid rgba(248,113,113,0.5); color: #f87171; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: 0.95rem; }
                .menu-toggle { display: none; margin-left: auto; background: transparent; border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 12px; font-size: 1.1rem; cursor: pointer; }

                /* Modal Pop-up Styling */
                .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.75); z-index: 1000; display: flex; align-items: center; justify-content: center; animation: fadeIn 0.2s ease-out; }
                .modal-box { background: var(--surface); border: 2px solid var(--accent); padding: 30px; border-radius: 12px; max-width: 450px; width: 90%; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
                .modal-box h3 { color: var(--accent); margin-top: 0; font-size: 1.35rem; }
                .modal-box p { font-size: 1.05rem; line-height: 1.5; color: var(--text); margin: 15px 0 25px 0; }
                .modal-btn { background: var(--accent); color: #0f172a; border: none; padding: 12px 28px; border-radius: 8px; font-weight: bold; font-size: 1rem; cursor: pointer; text-transform: uppercase; }
                .modal-btn:hover { opacity: 0.9; }
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

                .contact-bar { background: var(--sidebar-bg); border-top: 1px solid var(--border); padding: 25px 30px; text-align: center; color: var(--muted); margin-top: auto; }
                .contact-bar strong { color: var(--primary); }

                .site-footer { background: var(--sidebar-bg); border-top: 1px solid var(--border); color: var(--muted); padding: 40px 30px 20px 30px; }
                .footer-grid { max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 30px; margin-bottom: 30px; }
                .footer-col h4 { color: var(--primary); font-size: 1rem; margin-top: 0; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid var(--border); padding-bottom: 6px; }
                .footer-links { list-style: none; padding: 0; margin: 0; }
                .footer-links li { margin-bottom: 8px; }
                .footer-links a { color: var(--muted); text-decoration: none; font-size: 0.9rem; }
                .footer-links a:hover { color: var(--primary); }
                .footer-bottom { max-width: 1100px; margin: 0 auto; border-top: 1px solid var(--border); padding-top: 15px; text-align: center; font-size: 0.85rem; color: var(--muted); }

                @media(max-width: 992px) {
                    .services-grid { grid-template-columns: repeat(2, 1fr); }
                }
                @media(max-width: 768px) {
                    .sidebar { width: 100%; position: relative; height: auto; }
                    .menu-toggle { display: block; }
                    .sidebar .sidebar-nav, .sidebar .sidebar-footer { display: none; }
                    .sidebar.open .sidebar-nav { display: flex; }
                    .sidebar.open .sidebar-footer { display: flex; }
                    .main-content { margin-left: 0; }
                    body { flex-direction: column; }
                    .services-grid { grid-template-columns: 1fr; }
                }
            </style>
        </head>
        <body>
            ${showMpesaPopup ? `
                <div class="modal-overlay" id="mpesa-modal">
                    <div class="modal-box">
                        <h3>📱 M-Pesa Prompt Sent!</h3>
                        <p>An M-Pesa payment prompt has been sent to your phone. <strong>Please put your M-Pesa PIN immediately</strong> to authorize your order and complete the transaction.</p>
                        <button class="modal-btn" id="mpesa-ok" type="button">I Have Entered My PIN</button>
                    </div>
                </div>
            ` : ''}

            <aside class="sidebar" id="sidebar">
                <div class="sidebar-header">
                    <a href="/" class="logo-container">
                        <img src="/logo.png" alt="Tencent Innovations" class="logo-img" data-hide-on-error="1">
                        <div class="logo-text-group">
                            <span class="logo-text">Tencent Innovations</span>
                            <span class="logo-tagline">Connecting You, Faster.</span>
                        </div>
                    </a>
                    <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Menu">☰</button>
                </div>
                <ul class="sidebar-nav">
                    <li><a href="/" class="${activeNav === 'home' ? 'active' : ''}">🏠 Home</a></li>
                    <li><a href="/wifi" class="${activeNav === 'wifi' ? 'active' : ''}">📶 WiFi & Networking</a></li>
                    <li><a href="/cctv" class="${activeNav === 'cctv' ? 'active' : ''}">📷 CCTV Systems</a></li>
                    <li><a href="/smart-locks" class="${activeNav === 'smart-locks' ? 'active' : ''}">🔐 Smart Locks</a></li>
                    <li><a href="/electric-fence" class="${activeNav === 'electric-fence' ? 'active' : ''}">⚡ Electric Fence</a></li>
                    <li><a href="/solar" class="${activeNav === 'solar' ? 'active' : ''}">☀️ Solar Solutions</a></li>
                    <li><a href="/survey" class="${activeNav === 'survey' ? 'active' : ''}">📋 Book Site Survey</a></li>
                    ${user ? `<li><a href="/requests" class="${activeNav === 'requests' ? 'active' : ''}">📊 My Requests & Receipts</a></li>` : ''}
                    <li><a href="/terms" class="${activeNav === 'terms' ? 'active' : ''}">📄 Terms & Conditions</a></li>
                    
                    <hr style="border:0; border-top:1px solid var(--border); margin: 12px 0;">

                    <div class="sidebar-auth-group">
                        ${user ? `
                            <div style="padding: 4px 6px; font-size: 0.9rem; color: var(--text); overflow: hidden; text-overflow: ellipsis;">
                                👤 <strong>${esc(user.name)}</strong>
                            </div>
                            <form action="/logout" method="POST" style="margin:0;">${csrfField(req)}<button type="submit" class="sidebar-auth-btn sidebar-register-btn" style="width:100%; cursor:pointer; font-family:inherit; border-color: #f87171; color: #f87171;">🚪 Logout</button></form>
                        ` : `
                            <a href="/login" class="sidebar-auth-btn sidebar-login-btn">🔑 Sign In / Login</a>
                            <a href="/register" class="sidebar-auth-btn sidebar-register-btn">📝 Register Account</a>
                        `}
                    </div>
                </ul>
                <div class="sidebar-footer">
                    <button id="theme-toggle" class="theme-toggle-btn" aria-label="Toggle Theme">
                        <span id="theme-icon">☀️</span> <span id="theme-text">Light</span>
                    </button>
                </div>
            </aside>

            <div class="main-content">
                <div class="container">
                    ${content}
                </div>

                <div class="contact-bar">
                    📍 <strong>Rangwe, Homa Bay County</strong> &nbsp;|&nbsp; 📞 <strong>0740 311 014</strong> &nbsp;|&nbsp; ✉️ <strong>tencentbz@gmail.com</strong>
                </div>

                <footer class="site-footer">
                    <div class="footer-grid">
                        <div class="footer-col">
                            <h4>Find It Fast</h4>
                            <ul class="footer-links">
                                <li><a href="/smart-locks">Access Control</a></li>
                                <li><a href="/cctv">Security Systems</a></li>
                                <li><a href="/wifi">Telephony Systems</a></li>
                                <li><a href="/survey">Site Surveys</a></li>
                                <li><a href="/solar">Solar Systems</a></li>
                            </ul>
                        </div>
                        <div class="footer-col">
                            <h4>Customer Care</h4>
                            <ul class="footer-links">
                                <li><a href="/survey">My Account</a></li>
                                <li><a href="tel:0740311014">Contact Us</a></li>
                                <li><a href="/terms">Terms & Conditions</a></li>
                            </ul>
                        </div>
                        <div class="footer-col">
                            <h4>Tencent Innovations</h4>
                            <p style="font-size: 0.85rem; color: var(--muted); line-height: 1.5;">
                                Empowering homes, schools, and businesses across Rangwe and Homa Bay County with integrated internet, reliable security, and clean solar backup power.
                            </p>
                        </div>
                    </div>
                    <div class="footer-bottom">
                        <p>&copy; 2026 Tencent Innovations. All rights reserved. Powered by Tencent Innovations Web Platform.</p>
                    </div>
                </footer>
            </div>

            <script nonce="${nonce}">
                function updateThemeUI(theme) {
                    const icon = document.getElementById('theme-icon');
                    const text = document.getElementById('theme-text');
                    if (theme === 'light') {
                        if (icon) icon.textContent = '🌙';
                        if (text) text.textContent = 'Dark';
                    } else {
                        if (icon) icon.textContent = '☀️';
                        if (text) text.textContent = 'Light';
                    }
                }
                const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
                updateThemeUI(currentTheme);

                document.getElementById('theme-toggle').addEventListener('click', () => {
                    const current = document.documentElement.getAttribute('data-theme') || 'dark';
                    const next = current === 'dark' ? 'light' : 'dark';
                    document.documentElement.setAttribute('data-theme', next);
                    localStorage.setItem('theme', next);
                    updateThemeUI(next);
                });

                document.querySelectorAll('img[data-hide-on-error]').forEach(function (img) {
                    var hide = function () { img.style.display = 'none'; };
                    img.addEventListener('error', hide);
                    if (img.complete && img.naturalWidth === 0) hide();
                });
                var okBtn = document.getElementById('mpesa-ok');
                if (okBtn) okBtn.addEventListener('click', function () { document.getElementById('mpesa-modal').style.display = 'none'; });
                var menuBtn = document.getElementById('menu-toggle');
                if (menuBtn) menuBtn.addEventListener('click', function () { document.getElementById('sidebar').classList.toggle('open'); });
            </script>
        </body>
        </html>
    `;
}

// ---------------------------------------------------------------
// Auth Routes (Register, Login, Logout)
// ---------------------------------------------------------------
function registerPage(req, { error = '', values = {} } = {}) {
    const content = `
        <div class="general-container">
            <h2>Create an Account</h2>
            <p class="sub-title">Register to book services, request surveys, and download receipts.</p>
            <div class="form-container">
                ${error ? `<div class="alert-error">${esc(error)}</div>` : ''}
                <form action="/register" method="POST">
                    ${csrfField(req)}
                    <div class="form-group"><label>Full Name</label><input type="text" name="name" required maxlength="80" placeholder="John Otieno" value="${esc(values.name || '')}" autocomplete="name"></div>
                    <div class="form-group"><label>Email Address (for receipt delivery)</label><input type="email" name="email" required maxlength="120" placeholder="john@example.com" value="${esc(values.email || '')}" autocomplete="email"></div>
                    <div class="form-group"><label>M-Pesa Phone Number</label><input type="tel" name="phone" required placeholder="0712345678" value="${esc(values.phone || '')}" autocomplete="tel"></div>
                    <div class="form-group"><label>Password (8 to 72 characters)</label><input type="password" name="password" required minlength="8" maxlength="72" placeholder="••••••••" autocomplete="new-password"></div>
                    <div class="form-group"><label>Confirm Password</label><input type="password" name="confirm" required minlength="8" maxlength="72" placeholder="••••••••" autocomplete="new-password"></div>
                    <p style="color:var(--muted); font-size:0.9rem;">By registering you agree to our <a href="/terms" style="color:var(--primary);">Terms and Conditions</a>.</p>
                    <button type="submit" class="cta-btn" style="width:100%; padding:12px; border:none; border-radius:8px; cursor:pointer;">Register</button>
                </form>
                <p style="margin-top: 15px; text-align:center;">Already have an account? <a href="/login" style="color:var(--primary);">Login here</a></p>
            </div>
        </div>
    `;
    return renderPage(req, { title: 'Register', activeNav: 'register', content });
}

function loginPage(req, { error = '', email = '', redirect = '/survey' } = {}) {
    const content = `
        <div class="general-container">
            <h2>Login to Your Account</h2>
            <p class="sub-title">Access surveys, service bookings, and receipt downloads.</p>
            <div class="form-container">
                ${error ? `<div class="alert-error">${esc(error)}</div>` : ''}
                <form action="/login?redirect=${encodeURIComponent(redirect)}" method="POST">
                    ${csrfField(req)}
                    <div class="form-group"><label>Email Address</label><input type="email" name="email" required maxlength="120" placeholder="john@example.com" value="${esc(email)}" autocomplete="email"></div>
                    <div class="form-group"><label>Password</label><input type="password" name="password" required maxlength="72" placeholder="••••••••" autocomplete="current-password"></div>
                    <button type="submit" class="cta-btn" style="width:100%; padding:12px; border:none; border-radius:8px; cursor:pointer;">Login</button>
                </form>
                <p style="margin-top: 15px; text-align:center;">Don't have an account? <a href="/register" style="color:var(--primary);">Register here</a></p>
            </div>
        </div>
    `;
    return renderPage(req, { title: 'Login', activeNav: 'login', content });
}

// Starts a fresh session (stops session fixation) and sends the person onwards
function startSession(req, res, user, next) {
    req.session.regenerate(err => {
        if (err) {
            console.error('Session error:', err.message);
            return errorPage(req, res, 500, 'Something went wrong', 'Please try again in a moment.', '/login');
        }
        req.session.user = { id: user.id, name: user.name, email: user.email, phone: user.phone };
        req.session.save(() => res.redirect(next));
    });
}

app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/survey');
    res.send(registerPage(req));
});

app.post('/register', authLimiter, ah(async (req, res) => {
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const name = str(req.body.name).slice(0, 80);
    const email = str(req.body.email).toLowerCase().slice(0, 120);
    const phone = normalizePhone(str(req.body.phone));
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : '';
    const values = { name, email, phone: str(req.body.phone) };
    const fail = (error, status = 400) => res.status(status).send(registerPage(req, { error, values }));

    if (!name) return fail('Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Please enter a valid email address.');
    if (!phone) return fail('Please enter a valid Safaricom number, for example 0712345678.');
    if (password.length < 8) return fail('Your password must be at least 8 characters.');
    if (password.length > 72) return fail('Your password must be 72 characters or fewer.');
    if (password !== confirm) return fail('The two passwords do not match.');

    try {
        const hash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            'INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone',
            [name, email, phone, hash]
        );
        startSession(req, res, result.rows[0], '/survey');
    } catch (err) {
        if (err.code === '23505') return fail('An account with this email already exists. Please log in instead.', 409);
        throw err;
    }
}));

app.get('/login', (req, res) => {
    const redirect = safeRedirect(req.query.redirect);
    if (req.session.user) return res.redirect(redirect);
    res.send(loginPage(req, { redirect }));
});

// A login for an unknown email takes as long as one for a known email (no timing clue)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

app.post('/login', authLimiter, ah(async (req, res) => {
    const email = (typeof req.body.email === 'string' ? req.body.email : '').trim().toLowerCase().slice(0, 120);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const redirect = safeRedirect(req.query.redirect);
    const fail = (error, status = 401) => res.status(status).send(loginPage(req, { error, email, redirect }));

    if (!email || !password) return fail('Please enter your email and password.', 400);
    if (password.length > 72) return fail('Incorrect email or password.');

    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !match) return fail('Incorrect email or password.');
    startSession(req, res, user, redirect);
}));

// Logging out is a POST (with the CSRF token), so another site cannot log people out
app.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('tnc.sid');
        res.redirect('/');
    });
});

// ---------------------------------------------------------------
// Public Pages with Custom Background Video & 4-Column Homepage Grid
// ---------------------------------------------------------------
app.get('/', (req, res) => {
    const content = `
        <div class="hero-video-container">
            <video autoplay muted loop playsinline class="hero-video">
                <source src="https://assets.mixkit.co/videos/preview/mixkit-digital-animation-of-screens-and-connections-31917-large.mp4" type="video/mp4">
            </video>
            <div class="hero-overlay-content">
                <img src="/logo.png" alt="Tencent Innovations Logo" class="hero-logo-badge" data-hide-on-error="1">
                <h1>INTEGRATED TECHNOLOGY & SECURITY LEADERS</h1>
                <p>Providing high-performance WiFi, Solar Backup, CCTV, Smart Locks, and Electric Fences across East Africa.</p>
                <div style="margin-top:15px;"><a href="/survey" style="background:#38bdf8; color:#0f172a; padding:12px 28px; border-radius:30px; font-weight:bold; text-decoration:none;">Book Site Survey</a></div>
            </div>
        </div>

        <div class="services-grid">
            <div class="service-card card-black">
                <div>
                    <div class="service-icon">📶</div>
                    <h3>WIFI NETWORKS</h3>
                    <p>High-speed hotspot and dedicated home/office fiber internet installations designed for maximum uptime and stability.</p>
                </div>
                <div><a href="/wifi" class="enquire-btn">Enquire Now</a></div>
            </div>

            <div class="service-card card-gray">
                <div>
                    <div class="service-icon">☀️</div>
                    <h3>SOLAR SOLUTIONS</h3>
                    <p>Contact us now for your solar system quote for both Home & Commercial off-grid and hybrid kits.</p>
                </div>
                <div><a href="/solar" class="enquire-btn">Enquire Now</a></div>
            </div>

            <div class="service-card card-light">
                <div>
                    <div class="service-icon">📷</div>
                    <h3>CCTV SYSTEMS</h3>
                    <p>Advanced security surveillance cameras with remote smartphone viewing and crystal-clear night vision.</p>
                </div>
                <div><a href="/cctv" class="enquire-btn">Enquire Now</a></div>
            </div>

            <div class="service-card card-teal">
                <div>
                    <div class="service-icon">🔐 & ⚡</div>
                    <h3>LOCKS & FENCES</h3>
                    <p>Secure biometric smart locks and high-voltage perimeter electric fences engineered to protect your premises.</p>
                </div>
                <div><a href="/smart-locks" class="enquire-btn">Enquire Now</a></div>
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'Home', activeNav: 'home', content }));
});

app.get('/wifi', (req, res) => {
    const content = `
        <div class="general-container">
            <h2>Reliable WiFi for Homes, Rentals, and ISP Resellers.</h2>
            <p class="sub-title">Pay-as-you-go hotspots, PPPoE client management, and dedicated fiber connections.</p>
            
            <div class="form-container" style="border-left: 4px solid var(--primary);">
                <h3 style="color:var(--primary); margin-top:0;">ℹ️ Notes for WiFi Resellers, Technicians & Management</h3>
                <ul style="line-height: 1.8; margin-bottom: 0; padding-left: 20px;">
                    <li><strong>For Resellers:</strong> Deploy automated M-Pesa vending portals (FreeRADIUS / MikroTik integration) to manage daily/weekly/monthly subscriber vouchers seamlessly.</li>
                    <li><strong>For Technicians:</strong> Ensure proper mast grounding, use shielded CAT6 STP cables, and configure watchdog scripts on all access points to prevent signal dropouts.</li>
                    <li><strong>For Management:</strong> Monitor bandwidth utilization thresholds, automated payment reconciliations, and uptime SLAs directly from your dashboard.</li>
                </ul>
            </div>

            <div class="form-container" style="margin-top: 25px;">
                <p>Book a site visit or network review with our senior network engineers.</p>
                <a href="/survey" style="display:inline-block; background:var(--primary); color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Book WiFi Consultation</a>
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'WiFi & Networking', activeNav: 'wifi', content }));
});

app.get('/cctv', (req, res) => {
    const content = `
        <div class="general-container">
            <h2>See your property from anywhere.</h2>
            <p class="sub-title">CCTV systems for homes, shops, schools and compounds, installed and set up to view live on your phone.</p>
            <div class="form-container">
                <p>Get professional camera positioning and a clear quote.</p>
                <a href="/survey" style="display:inline-block; background:var(--primary); color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Book CCTV Survey</a>
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'CCTV Systems', activeNav: 'cctv', content }));
});

app.get('/smart-locks', (req, res) => {
    const content = `
        <div class="general-container">
            <h2>Open your door without a key.</h2>
            <p class="sub-title">Smart locks for homes, rental units, offices and stores. Use a code, a card, a fingerprint or your phone.</p>
            <div class="form-container">
                <p>Find the right smart lock model for your doors.</p>
                <a href="/survey" style="display:inline-block; background:var(--primary); color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Book Smart Lock Consultation</a>
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'Smart Locks', activeNav: 'smart-locks', content }));
});

app.get('/electric-fence', (req, res) => {
    const content = `
        <div class="general-container">
            <h2>Stop intruders at the boundary.</h2>
            <p class="sub-title">Electric fence installation for homes, compounds, schools, farms and commercial plots.</p>
            <div class="form-container">
                <p>Measure your boundary and get a professional installation quote.</p>
                <a href="/survey" style="display:inline-block; background:var(--primary); color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Book Electric Fence Survey</a>
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'Electric Fence', activeNav: 'electric-fence', content }));
});

app.get('/solar', (req, res) => {
    const content = `
        <div class="general-container">
            <h2>Keep the lights, internet and cameras on when the grid goes off.</h2>
            <p class="sub-title">Solar and battery systems sized for your home, shop, school or network site.</p>
            <div class="form-container">
                <p>Calculate your load requirements with our engineers.</p>
                <a href="/survey" style="display:inline-block; background:var(--primary); color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Book Solar Consultation</a>
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'Solar Solutions', activeNav: 'solar', content }));
});

// ---------------------------------------------------------------
// Protected Survey & Payment Page
// ---------------------------------------------------------------
app.get('/survey', requireAuth, (req, res) => {
    const content = `
        <div class="general-container">
            <h2>Know what your site needs before you spend.</h2>
            <p class="sub-title">A site survey by an engineer, followed by a written plan and quote.</p>
            
            <div class="form-container" style="border-color: var(--accent);">
                <h3 style="margin-top:0; color: var(--accent);">Book Site Survey & Pay via M-Pesa (STK Push)</h3>
                <p style="color:var(--muted); font-size:0.95rem;">Logged in as: <strong>${esc(req.session.user.email)}</strong>. Receipts will be emailed here.</p>
                <form action="/submit-survey-payment" method="POST" id="payment-form">
                    ${csrfField(req)}
                    <div class="form-group"><label>Full Name</label><input type="text" name="name" value="${esc(req.session.user.name)}" required></div>
                    <div class="form-group"><label>M-Pesa Phone Number</label><input type="tel" name="phone" value="${esc(req.session.user.phone)}" required placeholder="0712345678"></div>
                    <div class="form-group">
                        <label>Service Category</label>
                        <select name="service" id="service-select">
                            <option value="Site Survey & Quotation">General Site Survey (KES 3,000)</option>
                            <option value="WiFi Setup">WiFi & Hotspot Consultation (KES 3,000)</option>
                            <option value="CCTV Installation">CCTV System Assessment (KES 3,000)</option>
                            <option value="Smart Locks">Smart Locks Consultation (KES 2,500)</option>
                            <option value="Electric Fence">Electric Fence Survey (KES 5,000)</option>
                            <option value="Solar Consultation">Solar Consultation & Sizing (KES 4,000)</option>
                        </select>
                    </div>
                    <div class="form-group"><label>Physical Location / Address</label><input type="text" name="location" required placeholder="e.g. Rangwe Town, Homa Bay"></div>
                    <button type="submit" style="width:100%; padding:14px; background:var(--accent); color:#0f172a; border:none; border-radius:8px; font-weight:bold; font-size:1.05rem; cursor:pointer;">Trigger M-Pesa Payment & Book Survey</button>
                </form>
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'Surveys & Quotations', activeNav: 'survey', content }));
});

app.post('/submit-survey-payment', requireAuth, payLimiter, ah(async (req, res) => {
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const name = str(req.body.name).slice(0, 80);
    const location = str(req.body.location).slice(0, 120);
    const service = str(req.body.service);
    const phone = normalizePhone(str(req.body.phone));
    const user = req.session.user;
    const problem = (status, message) => errorPage(req, res, status, 'We could not start your payment', message, '/survey');

    if (!name || !location) return problem(400, 'Please enter your name and location.');
    if (!Object.hasOwn(SERVICE_PRICES, service)) return problem(400, 'Please choose a valid service.');
    if (!phone) return problem(400, 'Please enter a valid Safaricom number, for example 0712345678.');
    if (!phoneAttemptAllowed(phone)) return problem(429, 'Too many payment requests for this number. Please try again later.');

    const amount = SERVICE_PRICES[service];   // the price comes from the server, never from the form

    // Unique id and reference (retry in the very unlikely case of a clash)
    let bookingId = null, accountRef = null;
    for (let attempt = 0; attempt < 5 && !bookingId; attempt++) {
        const id = crypto.randomUUID();
        const ref = 'TI-' + crypto.randomBytes(4).toString('hex').toUpperCase();   // 11 characters, within M-Pesa's 12 limit
        try {
            await pool.query(
                'INSERT INTO bookings (id, user_id, name, phone, service, location, amount, account_ref, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                [id, user.id, name, phone, service, location, amount, ref, 'pending', Date.now()]
            );
            bookingId = id; accountRef = ref;
        } catch (err) {
            if (err.code !== '23505') throw err;
        }
    }
    if (!bookingId) return problem(500, 'Please try again in a moment.');

    if (!mpesaConfigured()) {
        await notify(`📝 PENDING (M-Pesa unconfigured): ${service} - ${name}`, { Name: name, Phone: phone, Service: service, Location: location, Amount: `KES ${amount}` });
        return res.send(renderPage(req, {
            title: 'Booking Received',
            activeNav: 'survey',
            content: `
                <div class="general-container">
                    <h2>Booking Received!</h2>
                    <p class="intro-text">Thank you, <strong>${esc(name)}</strong>. Online payment is not available right now. An engineer has received your request and will call <strong>${esc(phone)}</strong> shortly.</p>
                    <p><a href="/requests" style="color:var(--primary); font-weight:bold;">View My Requests</a></p>
                </div>
            `
        }));
    }

    const bookingObj = { id: bookingId, name, phone, service, location, amount, accountRef };
    try {
        const resStk = await stkPush(bookingObj);
        await pool.query('UPDATE bookings SET checkout_request_id = $1 WHERE id = $2', [resStk.CheckoutRequestID, bookingId]);
    } catch (err) {
        console.error('STK Push Error:', err.message);
        await pool.query("UPDATE bookings SET status = 'failed' WHERE id = $1 AND status = 'pending'", [bookingId]);
        return problem(502, 'We could not send the M-Pesa prompt. Please check your number and try again, or call us on 0740 311 014.');
    }

    notify(`📱 STK sent: ${service} - ${name} (KES ${amount})`, bookingFields(bookingObj)).catch(() => {});

    res.send(renderPage(req, {
        title: 'Check Your Phone',
        activeNav: 'survey',
        showMpesaPopup: true,
        content: `
            <div class="general-container">
                <h2>📱 M-Pesa Prompt Sent Successfully</h2>
                <div style="background:var(--surface); border:2px solid var(--accent); padding:25px; border-radius:12px; margin-top:20px; text-align:center;">
                    <h3 style="color:var(--accent); margin-top:0; font-size:1.4rem;">⚠️ ATTENTION REQUIRED:</h3>
                    <p style="font-size:1.2rem; color:var(--text); font-weight:bold; margin: 15px 0;">
                        Please check your phone (${esc(phone)}) immediately and put your M-Pesa PIN to authorize KES ${amount}!
                    </p>

                    <div id="status-box" style="margin:25px 0; padding:15px; border-radius:8px; background:var(--bg); border:1px solid var(--border);">
                        <p id="status-text" style="font-weight:bold; color:#38bdf8; font-size:1.05rem; margin:0;">
                            ⏳ Waiting for your M-Pesa PIN entry...
                        </p>
                    </div>
                </div>

                <div style="margin-top:25px; text-align:center;">
                    <a href="/requests" class="cta-btn">View All My Requests & Receipts</a>
                </div>
            </div>

            <script nonce="${res.locals.nonce}">
                (function () {
                    var id = ${JSON.stringify(bookingId)}, tries = 0, timer = null;
                    var box = document.getElementById('status-box');
                    function show(html) { box.innerHTML = html; }
                    function stop() { if (timer) clearInterval(timer); }
                    function checkStatus() {
                        tries++;
                        fetch('/payments/status/' + encodeURIComponent(id), { credentials: 'same-origin' })
                            .then(function (r) { return r.json(); })
                            .then(function (d) {
                                if (d.status === 'paid') {
                                    var html = '<h3 style="color:var(--accent); margin:0;">✅ Payment Confirmed Successfully!</h3><p style="margin-top:8px;">Your official PDF receipt is being emailed to you.</p>';
                                    if (d.pdf && d.pdf.indexOf('/payments/receipt/') === 0) html += '<p><a href="' + d.pdf + '" class="cta-btn" style="margin-top:12px;">📥 Download Official PDF Receipt</a></p>';
                                    html += '<p style="margin-top:12px;"><a href="/requests" style="color:var(--primary); text-decoration:underline;">Go to My Requests Dashboard</a></p>';
                                    show(html); stop();
                                } else if (d.status === 'failed') {
                                    show('<h3 style="color:#f87171; margin:0;">❌ Payment Cancelled or Timed Out</h3><p style="margin-top:8px; color:var(--muted);">The payment request was not completed.</p><a href="/survey" class="cta-btn" style="margin-top:15px;">Try Again</a>');
                                    stop();
                                } else if (d.status === 'review') {
                                    show('<h3 style="color:#fbbf24; margin:0;">We are confirming your payment</h3><p style="margin-top:8px; color:var(--muted);">We will call you shortly.</p>');
                                    stop();
                                } else if (d.status === 'unauthorized') {
                                    location.href = '/login';
                                } else if (tries >= 100) {
                                    show('<p style="margin:0; color:var(--muted);">We have not seen the payment yet. If you paid, check <a href="/requests" style="color:var(--primary);">My Requests</a> in a few minutes, or call 0740 311 014.</p>');
                                    stop();
                                }
                            })
                            .catch(function () { /* try again on the next tick */ });
                    }
                    checkStatus();
                    timer = setInterval(checkStatus, 3000);
                })();
            </script>
        `
    }));
}));

// ---------------------------------------------------------------
// My Requests & Tracking Dashboard
// ---------------------------------------------------------------
app.get('/requests', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC',
            [req.session.user.id]
        );
        const bookings = result.rows;

        let rowsHtml = '';
        if (bookings.length === 0) {
            rowsHtml = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--muted);">You have not made any service requests or bookings yet. <br><a href="/survey" style="color:var(--primary); font-weight:bold;">Book a Site Survey Now</a></td></tr>`;
        } else {
            rowsHtml = bookings.map(b => {
                const dateStr = new Date(Number(b.created_at)).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
                let statusBadge = '';
                if (b.status === 'paid') {
                    statusBadge = `<span style="background:rgba(74,222,128,0.15); color:var(--accent); padding:4px 10px; border-radius:6px; font-weight:bold; font-size:0.85rem;">PAID & CONFIRMED</span>`;
                } else if (b.status === 'pending') {
                    statusBadge = `<span style="background:rgba(56,189,248,0.15); color:#38bdf8; padding:4px 10px; border-radius:6px; font-weight:bold; font-size:0.85rem;">PENDING PAYMENT</span>`;
                } else {
                    statusBadge = `<span style="background:rgba(248,113,113,0.15); color:#f87171; padding:4px 10px; border-radius:6px; font-weight:bold; font-size:0.85rem;">${esc(b.status.toUpperCase())}</span>`;
                }

                const actionBtn = b.status === 'paid' 
                    ? `<a href="/payments/receipt/${b.id}/download.pdf" style="padding:6px 12px; font-size:0.85rem; background:var(--accent); color:#0f172a; text-decoration:none; border-radius:4px; font-weight:bold; display:inline-block;">📥 Download PDF</a>`
                    : `<a href="/survey" style="color:var(--primary); font-size:0.85rem; font-weight:bold;">Retry Payment</a>`;

                return `
                    <tr style="border-bottom: 1px solid var(--border);">
                        <td style="padding:12px;">${dateStr}</td>
                        <td style="padding:12px;"><strong>${esc(b.service)}</strong><br><small style="color:var(--muted);">${esc(b.location)}</small></td>
                        <td style="padding:12px;">KES ${b.amount}</td>
                        <td style="padding:12px;">${esc(b.account_ref)}</td>
                        <td style="padding:12px;">${statusBadge}</td>
                        <td style="padding:12px;">${esc(b.receipt || '-')}</td>
                        <td style="padding:12px; text-align:center;">${actionBtn}</td>
                    </tr>
                `;
            }).join('');
        }

        const content = `
            <div class="general-container">
                <h2>My Service Requests & Tracking</h2>
                <p class="sub-title">Monitor your submitted bookings, payment statuses, and download official PDF receipts.</p>
                
                <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow-x: auto; margin-top: 20px;">
                    <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.95rem;">
                        <thead>
                            <tr style="background: var(--bg); border-bottom: 2px solid var(--border); color: var(--primary);">
                                <th style="padding: 14px 12px;">Date</th>
                                <th style="padding: 14px 12px;">Service & Location</th>
                                <th style="padding: 14px 12px;">Amount</th>
                                <th style="padding: 14px 12px;">Reference</th>
                                <th style="padding: 14px 12px;">Status</th>
                                <th style="padding: 14px 12px;">M-Pesa Receipt</th>
                                <th style="padding: 14px 12px; text-align: center;">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                </div>

                <div style="margin-top: 30px; text-align: right;">
                    <a href="/survey" style="display:inline-block; background:var(--primary); color:#fff; padding:10px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">+ Book Another Service</a>
                </div>
            </div>
        `;
        res.send(renderPage(req, { title: 'My Requests', activeNav: 'requests', content }));
    } catch (err) {
        console.error('Error fetching requests:', err.message);
        errorPage(req, res, 500, 'Something went wrong', 'We could not load your requests. Please try again in a moment.', '/');
    }
});

// Booking / receipt page opened from a signed link. Everything shown comes from the database.
app.get('/booking/:token', ah(async (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'private, no-store');
    const id = readBookingLink(req.params.token);
    if (!id) return errorPage(req, res, 404, 'Link not valid', 'Please check the link you were sent, or call us on 0740 311 014.', '/');

    const r = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
    if (r.rows.length === 0) return errorPage(req, res, 404, 'Booking not found', 'We could not find this booking. Please call us on 0740 311 014.', '/');
    const b = r.rows[0];

    const isPaid = b.status === 'paid';
    const views = {
        paid:    { h: 'Payment Receipt & Booking', badge: '<span style="color:var(--accent); font-weight:bold;">PAID & CONFIRMED</span>' },
        pending: { h: 'Booking Status', badge: '<span style="color:#38bdf8; font-weight:bold;">AWAITING PAYMENT</span>' },
        failed:  { h: 'Booking Status', badge: '<span style="color:#f87171; font-weight:bold;">NOT PAID</span>' },
        review:  { h: 'Booking Status', badge: '<span style="color:#fbbf24; font-weight:bold;">CHECKING PAYMENT</span>' }
    };
    const v = views[b.status] || views.pending;
    const when = Number(isPaid ? b.paid_at : b.created_at) || Date.now();
    const dateStr = new Date(when).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

    const content = `
        <div class="general-container">
            <h2>${v.h}</h2>
            <p class="sub-title">Tencent Innovations | Rangwe, Homa Bay County</p>
            <div class="form-container">
                <p><strong>Status:</strong> ${v.badge}</p>
                <p><strong>Client Name:</strong> ${esc(b.name)}</p>
                <p><strong>Phone Number:</strong> ${esc(maskPhone(b.phone))}</p>
                <p><strong>Service:</strong> ${esc(b.service)}</p>
                <p><strong>Location:</strong> ${esc(b.location)}</p>
                <p><strong>Amount:</strong> KES ${esc(Number(b.amount).toLocaleString('en-KE'))}</p>
                <p><strong>Reference:</strong> ${esc(b.account_ref)}</p>
                ${isPaid && b.receipt ? `<p><strong>M-Pesa Receipt:</strong> ${esc(b.receipt)}</p>` : ''}
                <p><strong>${isPaid ? 'Paid on' : 'Requested on'}:</strong> ${esc(dateStr)} (EAT)</p>
                ${isPaid && PDFDocument ? `<div style="margin-top: 25px;"><a href="/booking/${esc(req.params.token)}/receipt.pdf" class="cta-btn">Download Official PDF Receipt</a></div>` : ''}
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'Receipt', activeNav: 'home', content }));
}));

app.get('/booking/:token/receipt.pdf', ah(async (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'private, no-store');
    if (!PDFDocument) return res.status(501).send('PDF generation disabled.');
    const id = readBookingLink(req.params.token);
    if (!id) return res.status(404).send('Receipt not found.');

    const r = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
    if (r.rows.length === 0 || r.rows[0].status !== 'paid') return res.status(404).send('Receipt not found.');
    const b = r.rows[0];

    const buf = await generatePdfBuffer(receiptData(b));
    res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${receiptFileName(b.account_ref)}"`,
        'Content-Length': buf.length
    });
    res.send(buf);
}));

// Terms and Conditions Page
app.get('/terms', (req, res) => {
    const content = `
        <div class="general-container">
            <h2>Terms and Conditions of Service</h2>
            <p class="sub-title">Tencent Innovations | Rangwe, Homa Bay County, Kenya</p>
            <p class="intro-text">These Terms and Conditions govern the provision of internet services, security installations, and site surveys by Tencent Innovations.</p>
            <h3>1. Services and Surveys</h3>
            <p>Site surveys and consultations require an advance fee paid via M-Pesa. Fees cover engineer site visits and written quotations.</p>
            <h3>2. Payments</h3>
            <p>All payments are processed securely via M-Pesa STK Push. Receipts are delivered via email upon confirmation.</p>
        </div>
    `;
    res.send(renderPage(req, { title: 'Terms and Conditions', activeNav: 'terms', content }));
});

// ---------------------------------------------------------------
// Error pages, 404 and the global error handler
// ---------------------------------------------------------------
function errorPage(req, res, status, title, message, backHref = '/') {
    return res.status(status).send(renderPage(req, {
        title,
        activeNav: '',
        content: `<div class="general-container"><h2>${esc(title)}</h2><p class="intro-text">${esc(message)}</p><a href="${esc(backHref)}" class="cta-btn">Go back</a></div>`
    }));
}

app.use((req, res) => errorPage(req, res, 404, 'Page not found', 'We could not find that page.', '/'));

// Any error thrown in a route lands here instead of crashing the server
app.use((err, req, res, next) => {
    console.error('Request error:', err && err.message);
    if (res.headersSent) return next(err);
    try {
        errorPage(req, res, 500, 'Something went wrong', 'Please try again in a moment, or call us on 0740 311 014.', '/');
    } catch (_) {
        res.status(500).send('Server error. Please try again.');
    }
});

const PORT = process.env.PORT || 10000;
initDb()
    .catch(err => console.error('Database initialization error:', err.message))
    .finally(() => {
        app.listen(PORT, () => console.log(`Tencent Innovations server running on port ${PORT}`));
    });
