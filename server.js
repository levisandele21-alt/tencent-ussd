const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
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

// 1. Static file serving for images (logo.png, banner.png)
app.use(express.static(__dirname));

// 2. Security Headers via Helmet
app.use(
    helmet({
        contentSecurityPolicy: false,
    })
);

// 3. Trust Render's Proxy
app.set('trust proxy', 1);

// 4. Database Setup (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(50) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
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
        console.log('PostgreSQL tables initialized successfully.');
    } catch (err) {
        console.error('Database initialization error:', err.message);
    }
}
initDb();

// 5. Session Middleware with PostgreSQL Store
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
}));

// 6. Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    skip: (req) => req.path.startsWith('/payments/cb/') || req.path.startsWith('/payments/status/')
});

const payLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many payment attempts from this network. Please try again later.'
});
app.use(limiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Make user session data available in all templates
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

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

function generatePdfBuffer(bookingData) {
    return new Promise((resolve, reject) => {
        if (!PDFDocument) return reject(new Error('PDFKit not available'));
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        let buffers = [];
        doc.on('data', chunk => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));

        doc.fillColor('#0284c7').fontSize(22).text('TENCENT INNOVATIONS', { align: 'center' });
        doc.fillColor('#64748b').fontSize(10).text('Rangwe, Homa Bay County | Tel: 0740 311 014 | tencentbz@gmail.com', { align: 'center' });
        doc.moveDown(2);

        doc.fillColor('#0f172a').fontSize(16).text('OFFICIAL PAYMENT RECEIPT', { align: 'center' });
        doc.moveDown(1.5);

        doc.fontSize(12);
        const dateStr = new Date(bookingData.paidAt || Date.now()).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

        const rows = [
            ['Reference / Account:', bookingData.accountRef],
            ['Client Name:', bookingData.name],
            ['Phone Number:', bookingData.phone],
            ['Service Rendered:', bookingData.service],
            ['Location:', bookingData.location],
            ['Amount Paid:', `KES ${bookingData.amount}`],
            ['M-Pesa Receipt:', bookingData.receipt || 'Confirmed via Daraja'],
            ['Date & Time:', dateStr],
            ['Payment Status:', 'PAID & CONFIRMED']
        ];

        let y = doc.y;
        rows.forEach(([label, val]) => {
            doc.font('Helvetica-Bold').text(label, 50, y, { width: 160 });
            doc.font('Helvetica').text(val, 220, y, { width: 320 });
            y += 24;
        });

        doc.moveDown(4);
        doc.fontSize(10).fillColor('#64748b').text('Thank you for choosing Tencent Innovations. This is an electronically generated receipt.', 50, y + 40, { align: 'center', width: 500 });

        doc.end();
    });
}

async function notify(subject, fields, userEmail = null, pdfBuffer = null) {
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

    console.log('LEAD:', JSON.stringify({ subject: cleanSubject, fields, time }));

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
        if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
        let attachments = [];
        if (pdfBuffer) {
            attachments.push({ filename: 'Tencent-Receipt.pdf', content: pdfBuffer });
        }
        await mailer.sendMail({
            from: `"Tencent Website" <${process.env.GMAIL_USER}>`,
            to: process.env.NOTIFY_TO || process.env.GMAIL_USER,
            subject: cleanSubject,
            html: `<h3>${esc(cleanSubject)}</h3>${rows}<p style="color:#888">Received ${esc(time)} (EAT)</p>`,
            attachments
        });
    };

    const sendUserEmail = async () => {
        if (!userEmail || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
        let attachments = [];
        if (pdfBuffer) {
            attachments.push({ filename: 'Tencent-Receipt.pdf', content: pdfBuffer });
        }
        await mailer.sendMail({
            from: `"Tencent Innovations" <${process.env.GMAIL_USER}>`,
            to: userEmail,
            subject: `Receipt & Booking Confirmation: ${cleanSubject}`,
            html: `<h3>Hello, your booking is confirmed!</h3>${rows}<p>Please find attached your official payment receipt PDF.</p><p style="color:#888">Tencent Innovations | Rangwe, Homa Bay County</p>`,
            attachments
        });
    };

    const results = await Promise.allSettled([sendTelegram(), sendAdminEmail(), sendUserEmail()]);
    if (results[0].status === 'rejected') console.error('Telegram failed:', results[0].reason?.message);
    if (results[1].status === 'rejected') console.error('Admin email failed:', results[1].reason?.message);
    if (results[2].status === 'rejected') console.error('User email failed:', results[2].reason?.message);
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

async function darajaPost(path, payload) {
    const token = await getAccessToken();
    const resp = await fetch(`${MPESA.baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000)
    });
    let data = {};
    try { data = await resp.json(); } catch (_) {}
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

function bookingFields(b, extra = {}) {
    return {
        Name: b.name,
        Phone: b.phone,
        Service: b.service,
        Location: b.location,
        Amount: `KES ${b.amount}`,
        Reference: b.accountRef,
        ...extra
    };
}

// Signed booking links
const LINK_SECRET = process.env.LINK_SECRET || MPESA.callbackSecret || '';
function linksEnabled() {
    return LINK_SECRET.length >= 16 && MPESA.publicBaseUrl.startsWith('https://');
}
function signLinkPart(part) {
    return crypto.createHmac('sha256', LINK_SECRET).update(part).digest('base64url');
}
function makeBookingLink(b, paid = true) {
    if (!linksEnabled()) return '';
    const part = Buffer.from(JSON.stringify({
        n: b.name, p: b.phone, s: b.service, a: b.amount,
        r: paid ? (b.receipt || '') : '', f: b.accountRef, l: b.location,
        t: paid ? (b.paidAt || Date.now()) : b.createdAt,
        i: b.id, k: paid ? 1 : 0
    })).toString('base64url');
    return `${MPESA.publicBaseUrl}/booking/${part}.${signLinkPart(part)}`;
}
function readBookingLink(token) {
    if (LINK_SECRET.length < 16) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const part = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(signLinkPart(part));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch (_) { return null; }
}

async function markPaid(bookingId, receipt, verified) {
    const res = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (res.rows.length === 0) return;
    let b = res.rows[0];
    if (b.status === 'paid') return;

    const paidAt = Date.now();
    await pool.query('UPDATE bookings SET status = $1, receipt = $2, paid_at = $3 WHERE id = $4', ['paid', receipt || '', paidAt, bookingId]);

    b.status = 'paid';
    b.receipt = receipt || '';
    b.paidAt = paidAt;
    b.link = makeBookingLink(b);

    let userEmail = null;
    if (b.user_id) {
        const uRes = await pool.query('SELECT email FROM users WHERE id = $1', [b.user_id]);
        if (uRes.rows.length > 0) userEmail = uRes.rows[0].email;
    }

    let pdfBuffer = null;
    if (PDFDocument) {
        try {
            pdfBuffer = await generatePdfBuffer({
                accountRef: b.account_ref,
                name: b.name,
                phone: b.phone,
                service: b.service,
                location: b.location,
                amount: b.amount,
                receipt: b.receipt,
                paidAt: b.paid_at
            });
        } catch (e) {
            console.error('PDF generation error:', e.message);
        }
    }

    const pdfDownloadUrl = `${MPESA.publicBaseUrl}/payments/receipt/${b.id}/download.pdf`;
    const extra = {
        'M-Pesa receipt': receipt || '(see M-Pesa statement)',
        Verified: verified ? 'Yes, confirmed with Safaricom' : 'Callback only'
    };
    if (pdfBuffer) extra['Download Receipt PDF'] = pdfDownloadUrl;
    if (b.link) extra['Booking link'] = b.link;

    await notify(`✅ PAID: ${b.service} - ${b.name}`, bookingFields(b, extra), userEmail, pdfBuffer);
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
    const receipt = String(meta('MpesaReceiptNumber') || '');

    if (booking.status === 'paid') {
        if (succeeded && receipt && !booking.receipt) {
            await pool.query('UPDATE bookings SET receipt = $1 WHERE id = $2', [receipt, booking.id]);
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

app.post('/payments/cb/:secret', (req, res) => {
    const given = Buffer.from(String(req.params.secret));
    const expected = Buffer.from(String(MPESA.callbackSecret || ''));
    const ok = expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.sendStatus(404);

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    handleCallback(req.body).catch(err => console.error('Callback error:', err.message));
});

app.get('/payments/status/:id', async (req, res) => {
    const r = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ status: 'unknown' });
    let b = r.rows[0];

    if (b.status === 'pending' && b.checkout_request_id &&
        Date.now() - Number(b.created_at) > 25000) {
        try {
            const q = await stkQuery(b.checkout_request_id);
            if (String(q.ResultCode) === '0') await markPaid(b.id, '', true);
            else if (q.ResultCode !== undefined && String(q.ResultCode) !== '') await markFailed(b.id, q.ResultDesc);
        } catch (_) {}
        const updated = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
        b = updated.rows[0];
    }
    const paidLink = b.status === 'paid' ? (makeBookingLink(b) || '') : '';
    const pdfUrl = b.status === 'paid' ? `/payments/receipt/${b.id}/download.pdf` : '';
    res.json({ status: b.status, link: paidLink, pdf: pdfUrl });
});

app.get('/payments/receipt/:id/download.pdf', async (req, res) => {
    const r = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0 || r.rows[0].status !== 'paid') {
        return res.status(404).send('Receipt not available or payment pending.');
    }
    const b = r.rows[0];
    if (!PDFDocument) return res.status(501).send('PDF generation disabled.');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Tencent-Receipt-${b.account_ref}.pdf`);

    try {
        const buf = await generatePdfBuffer({
            accountRef: b.account_ref,
            name: b.name,
            phone: b.phone,
            service: b.service,
            location: b.location,
            amount: b.amount,
            receipt: b.receipt,
            paidAt: b.paid_at
        });
        res.send(buf);
    } catch (err) {
        res.status(500).send('Error generating PDF receipt.');
    }
});

// Authentication Middleware
function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    }
    next();
}

// ---------------------------------------------------------------
// Layout Template Helper with Left Sidebar & Auth / Sign In / Login Buttons
// ---------------------------------------------------------------
function renderPage({ title, activeNav, content }) {
    return `
        <!DOCTYPE html>
        <html lang="en" data-theme="dark">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title} - Tencent Innovations</title>
            <script>
                (function() {
                    const savedTheme = localStorage.getItem('theme') || 'dark';
                    document.documentElement.setAttribute('data-theme', savedTheme);
                })();
            </script>
            <style>
                :root {
                    --bg: #0f172a;
                    --surface: #1e293b;
                    --sidebar-bg: #0b1120;
                    --text: #f8fafc;
                    --muted: #94a3b8;
                    --border: #334155;
                    --primary: #0284c7;
                    --accent: #4ade80;
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
                .sidebar-header { padding: 24px 20px; border-bottom: 1px solid var(--border); }
                .logo-container { display: flex; align-items: center; gap: 12px; text-decoration: none; }
                .logo-img { height: 42px; width: auto; border-radius: 6px; background: #ffffff; padding: 2px; }
                .logo-text-group { display: flex; flex-direction: column; }
                .logo-text { font-size: 1.15rem; font-weight: bold; color: #38bdf8; text-decoration: none; line-height: 1.1; }
                .logo-tagline { font-size: 0.7rem; color: var(--muted); }

                .sidebar-nav { flex: 1; padding: 20px 12px; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; list-style: none; margin: 0; }
                .sidebar-nav a { color: var(--muted); text-decoration: none; font-weight: 500; font-size: 0.95rem; padding: 10px 14px; border-radius: 8px; transition: all 0.2s; display: flex; align-items: center; gap: 10px; }
                .sidebar-nav a:hover, .sidebar-nav a.active { color: var(--text); background: var(--surface); }

                /* Prominent Authentication Sidebar Buttons */
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
                .container { max-width: 900px; margin: 40px auto; padding: 0 30px; flex: 1; width: 100%; box-sizing: border-box; }

                h2 { color: var(--primary); font-size: 2rem; margin-top: 0; }
                h3 { color: var(--primary); margin-top: 30px; }
                .sub-title { color: var(--muted); font-size: 1.15rem; margin-top: -10px; margin-bottom: 25px; }
                .intro-text { font-size: 1.1rem; color: var(--text); margin-bottom: 25px; }
                
                ul.feature-list { list-style: disc; padding-left: 20px; margin: 20px 0; }
                ul.feature-list li { margin-bottom: 12px; font-size: 1.05rem; color: var(--text); }

                .cta-box { background: var(--surface); border: 1px solid var(--border); padding: 25px; border-radius: 10px; margin-top: 40px; text-align: center; }
                .cta-box p { font-size: 1.1rem; margin-top: 0; color: var(--text); }
                .cta-btn { display: inline-block; background: var(--primary); color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 1.05rem; border: none; cursor: pointer; width: 100%; box-sizing: border-box; text-align: center; }
                .cta-btn:hover { background: #0369a1; }

                .form-container { background: var(--surface); border: 1px solid var(--border); padding: 25px; border-radius: 10px; margin-top: 30px; text-align: left; }
                .form-group { margin-bottom: 15px; }
                .form-group label { display: block; margin-bottom: 5px; color: var(--primary); font-weight: 500; }
                .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); box-sizing: border-box; }

                .contact-bar { background: var(--sidebar-bg); border-top: 1px solid var(--border); padding: 20px; text-align: center; color: var(--muted); margin-top: 50px; }
                .contact-bar strong { color: var(--primary); }

                .site-footer { background: var(--sidebar-bg); border-top: 1px solid var(--border); color: var(--muted); padding: 40px 30px 20px 30px; }
                .footer-grid { max-width: 900px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 30px; margin-bottom: 30px; }
                .footer-col h4 { color: var(--primary); font-size: 1rem; margin-top: 0; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid var(--border); padding-bottom: 6px; }
                .footer-links { list-style: none; padding: 0; margin: 0; }
                .footer-links li { margin-bottom: 8px; }
                .footer-links a { color: var(--muted); text-decoration: none; font-size: 0.9rem; }
                .footer-links a:hover { color: var(--primary); }
                .footer-bottom { max-width: 900px; margin: 0 auto; border-top: 1px solid var(--border); padding-top: 15px; text-align: center; font-size: 0.85rem; color: var(--muted); }

                .hero-banner { 
                    background: linear-gradient(rgba(15, 23, 42, 0.85), rgba(15, 23, 42, 0.85)), url('/banner.png');
                    background-size: cover;
                    background-position: center;
                    padding: 50px 20px; 
                    text-align: center; 
                    border-bottom: 1px solid var(--border); 
                    margin: -40px -30px 30px -30px;
                }
                .hero-banner h1 { font-size: 2.2rem; margin: 0 0 10px 0; color: #ffffff; }
                .hero-banner p { color: #e2e8f0; font-size: 1.1rem; margin-bottom: 20px; max-width: 750px; margin-left: auto; margin-right: auto; }
                .ussd-badge { display: inline-block; background: #38bdf8; color: #0f172a; padding: 8px 18px; border-radius: 30px; font-weight: bold; font-size: 1rem; }

                @media(max-width: 768px) {
                    .sidebar { width: 100%; position: relative; height: auto; }
                    .main-content { margin-left: 0; }
                    body { flex-direction: column; }
                }
            </style>
        </head>
        <body>
            <aside class="sidebar">
                <div class="sidebar-header">
                    <a href="/" class="logo-container">
                        <img src="/logo.png" alt="Tencent Innovations" class="logo-img" onerror="this.style.display='none'">
                        <div class="logo-text-group">
                            <span class="logo-text">Tencent Innovations</span>
                            <span class="logo-tagline">Connecting You, Faster.</span>
                        </div>
                    </a>
                </div>
                <ul class="sidebar-nav">
                    <li><a href="/" class="${activeNav === 'home' ? 'active' : ''}">🏠 Home</a></li>
                    <li><a href="/wifi" class="${activeNav === 'wifi' ? 'active' : ''}">📶 WiFi & Networking</a></li>
                    <li><a href="/cctv" class="${activeNav === 'cctv' ? 'active' : ''}">📷 CCTV Systems</a></li>
                    <li><a href="/smart-locks" class="${activeNav === 'smart-locks' ? 'active' : ''}">🔐 Smart Locks</a></li>
                    <li><a href="/electric-fence" class="${activeNav === 'electric-fence' ? 'active' : ''}">⚡ Electric Fence</a></li>
                    <li><a href="/solar" class="${activeNav === 'solar' ? 'active' : ''}">☀️ Solar Solutions</a></li>
                    <li><a href="/survey" class="${activeNav === 'survey' ? 'active' : ''}">📋 Book Site Survey</a></li>
                    ${res.locals.user ? `<li><a href="/requests" class="${activeNav === 'requests' ? 'active' : ''}">📊 My Requests & Receipts</a></li>` : ''}
                    <li><a href="/terms" class="${activeNav === 'terms' ? 'active' : ''}">📄 Terms & Conditions</a></li>
                    
                    <hr style="border:0; border-top:1px solid var(--border); margin: 12px 0;">

                    <!-- Prominent Login / Register / Account Section -->
                    <div class="sidebar-auth-group">
                        ${res.locals.user ? `
                            <div style="padding: 4px 6px; font-size: 0.9rem; color: var(--text); overflow: hidden; text-overflow: ellipsis;">
                                👤 <strong>${esc(res.locals.user.name)}</strong>
                            </div>
                            <a href="/logout" class="sidebar-auth-btn sidebar-register-btn" style="border-color: #f87171; color: #f87171;">🚪 Logout</a>
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
                                <li><a href="/survey">My account</a></li>
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

            <script>
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
            </script>
        </body>
        </html>
    `;
}

// ---------------------------------------------------------------
// Auth Routes (Register, Login, Logout)
// ---------------------------------------------------------------
app.get('/register', (req, res) => {
    const content = `
        <h2>Create an Account</h2>
        <p class="sub-title">Register to book services, request surveys, and download receipts.</p>
        <div class="form-container">
            <form action="/register" method="POST">
                <div class="form-group"><label>Full Name</label><input type="text" name="name" required placeholder="John Otieno"></div>
                <div class="form-group"><label>Email Address (for receipt delivery)</label><input type="email" name="email" required placeholder="john@example.com"></div>
                <div class="form-group"><label>Phone Number</label><input type="tel" name="phone" required placeholder="0712345678"></div>
                <div class="form-group"><label>Password</label><input type="password" name="password" required placeholder="••••••••"></div>
                <button type="submit" class="cta-btn">Register</button>
            </form>
            <p style="margin-top: 15px; text-align:center;">Already have an account? <a href="/login" style="color:var(--primary);">Login here</a></p>
        </div>
    `;
    res.send(renderPage({ title: 'Register', activeNav: 'register', content }));
});

app.post('/register', async (req, res) => {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
        return res.status(400).send('All fields are required.');
    }
    try {
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone',
            [name, email, phone, hash]
        );
        req.session.user = result.rows[0];
        res.redirect('/survey');
    } catch (err) {
        console.error('Registration error:', err.message);
        res.status(400).send(renderPage({
            title: 'Registration Error',
            activeNav: 'register',
            content: `<h2>Registration Failed</h2><p class="intro-text">Email may already be registered. Please try logging in.</p><a href="/login" class="cta-btn">Go to Login</a>`
        }));
    }
});

app.get('/login', (req, res) => {
    const redirectUrl = req.query.redirect || '/survey';
    const content = `
        <h2>Login to Your Account</h2>
        <p class="sub-title">Access surveys, service bookings, and receipt downloads.</p>
        <div class="form-container">
            <form action="/login?redirect=${encodeURIComponent(redirectUrl)}" method="POST">
                <div class="form-group"><label>Email Address</label><input type="email" name="email" required placeholder="john@example.com"></div>
                <div class="form-group"><label>Password</label><input type="password" name="password" required placeholder="••••••••"></div>
                <button type="submit" class="cta-btn">Login</button>
            </form>
            <p style="margin-top: 15px; text-align:center;">Don't have an account? <a href="/register" style="color:var(--primary);">Register here</a></p>
        </div>
    `;
    res.send(renderPage({ title: 'Login', activeNav: 'login', content }));
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const redirectUrl = req.query.redirect || '/survey';
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(400).send('Invalid email or password.');
        }
        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(400).send('Invalid email or password.');
        }
        req.session.user = { id: user.id, name: user.name, email: user.email, phone: user.phone };
        res.redirect(redirectUrl);
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).send('Server error during login.');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// ---------------------------------------------------------------
// Public Pages
// ---------------------------------------------------------------
app.get('/', (req, res) => {
    const content = `
        <div class="hero-banner">
            <h1>Internet, security and power for your home or business.</h1>
            <p>Tencent Innovations designs, installs and maintains WiFi, CCTV, smart locks, electric fences and solar systems. We start with a survey, so you only pay for what your site needs.</p>
            <div class="ussd-badge">📱 Dial *384*100# on your phone to book</div>
        </div>
        
        <p class="intro-text">Most problems with networks, cameras and power start with a poor plan, not poor equipment. We are engineers, so we plan first, install properly and stay around to support what we build.</p>
        
        <h3>What we do</h3>
        <ul class="feature-list">
            <li><strong>WiFi:</strong> Hotspot and home internet that stays up and stays fast.</li>
            <li><strong>CCTV:</strong> Cameras you can watch from your phone.</li>
            <li><strong>Smart locks:</strong> Entry without keys to copy, lose or hand over.</li>
            <li><strong>Electric fence:</strong> A boundary that deters intruders before they reach your door.</li>
            <li><strong>Solar:</strong> Power that keeps your lights, router and cameras on when the grid is off.</li>
            <li><strong>Surveys:</strong> A site visit and a written plan before any work begins.</li>
        </ul>

        <div class="cta-box">
            <p>Ready to get started? Register or login to book a professional site survey.</p>
            <a href="/survey" class="cta-btn">Book a Survey Now</a>
        </div>
    `;
    res.send(renderPage({ title: 'Home', activeNav: 'home', content }));
});

app.get('/wifi', (req, res) => {
    const content = `
        <h2>Reliable WiFi for homes, rentals and businesses.</h2>
        <p class="sub-title">Pay-as-you-go hotspot or a fixed monthly connection. We build the network, run the billing and keep it online.</p>
        <p class="intro-text">A good connection depends on the whole chain: the link to the mast, the router, the access points and how many people share them.</p>
        <div class="cta-box">
            <p>Book a site visit to test signal strength at your location.</p>
            <a href="/survey" class="cta-btn">Book WiFi Consultation</a>
        </div>
    `;
    res.send(renderPage({ title: 'WiFi & Networking', activeNav: 'wifi', content }));
});

app.get('/cctv', (req, res) => {
    const content = `
        <h2>See your property from anywhere.</h2>
        <p class="sub-title">CCTV systems for homes, shops, schools and compounds, installed and set up to view live on your phone.</p>
        <div class="cta-box">
            <p>Get professional camera positioning and a clear quote.</p>
            <a href="/survey" class="cta-btn">Book CCTV Survey</a>
        </div>
    `;
    res.send(renderPage({ title: 'CCTV Systems', activeNav: 'cctv', content }));
});

app.get('/smart-locks', (req, res) => {
    const content = `
        <h2>Open your door without a key.</h2>
        <p class="sub-title">Smart locks for homes, rental units, offices and stores. Use a code, a card, a fingerprint or your phone.</p>
        <div class="cta-box">
            <p>Find the right smart lock model for your doors.</p>
            <a href="/survey" class="cta-btn">Book Smart Lock Consultation</a>
        </div>
    `;
    res.send(renderPage({ title: 'Smart Locks', activeNav: 'smart-locks', content }));
});

app.get('/electric-fence', (req, res) => {
    const content = `
        <h2>Stop intruders at the boundary.</h2>
        <p class="sub-title">Electric fence installation for homes, compounds, schools, farms and commercial plots.</p>
        <div class="cta-box">
            <p>Measure your boundary and get a professional installation quote.</p>
            <a href="/survey" class="cta-btn">Book Electric Fence Survey</a>
        </div>
    `;
    res.send(renderPage({ title: 'Electric Fence', activeNav: 'electric-fence', content }));
});

app.get('/solar', (req, res) => {
    const content = `
        <h2>Keep the lights, internet and cameras on when the grid goes off.</h2>
        <p class="sub-title">Solar and battery systems sized for your home, shop, school or network site.</p>
        <div class="cta-box">
            <p>Calculate your load requirements with our engineers.</p>
            <a href="/survey" class="cta-btn">Book Solar Consultation</a>
        </div>
    `;
    res.send(renderPage({ title: 'Solar Solutions', activeNav: 'solar', content }));
});

// ---------------------------------------------------------------
// Protected Survey & Payment Page
// ---------------------------------------------------------------
app.get('/survey', requireAuth, (req, res) => {
    const content = `
        <h2>Know what your site needs before you spend.</h2>
        <p class="sub-title">A site survey by an engineer, followed by a written plan and quote.</p>
        
        <div class="form-container" style="border-color: var(--accent);">
            <h3 style="margin-top:0; color: var(--accent);">Book Site Survey & Pay via M-Pesa (STK Push)</h3>
            <p style="color:var(--muted); font-size:0.95rem;">Logged in as: <strong>${esc(req.session.user.email)}</strong>. Receipts will be emailed here.</p>
            <form action="/submit-survey-payment" method="POST" id="payment-form">
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
                <button type="submit" class="cta-btn" style="background: var(--accent); color: #0f172a;">Trigger M-Pesa Payment & Book Survey</button>
            </form>
        </div>
    `;
    res.send(renderPage({ title: 'Surveys & Quotations', activeNav: 'survey', content }));
});

app.post('/submit-survey-payment', requireAuth, payLimiter, async (req, res) => {
    const { name, phone: rawPhone, service, location } = req.body;
    const phone = normalizePhone(rawPhone);

    if (!name || !phone || !service || !location) {
        return res.status(400).send('Incomplete form details.');
    }

    if (!phoneAttemptAllowed(phone)) {
        return res.status(429).send('Too many payment attempts. Please try again later.');
    }

    const amount = SERVICE_PRICES[service] || 3000;
    const bookingId = crypto.randomUUID();
    const accountRef = `TI-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        await pool.query(
            'INSERT INTO bookings (id, user_id, name, phone, service, location, amount, account_ref, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [bookingId, req.session.user.id, name, phone, service, location, amount, accountRef, 'pending', Date.now()]
        );
    } catch (err) {
        console.error('Booking insertion error:', err.message);
        return res.status(500).send('Database error processing booking.');
    }

    if (!mpesaConfigured()) {
        await notify(`📝 PENDING (M-Pesa unconfigured): ${service} - ${name}`, { Name: name, Phone: phone, Service: service, Location: location, Amount: `KES ${amount}` }, req.session.user.email);
        return res.send(renderPage({
            title: 'Booking Received',
            activeNav: 'survey',
            content: `
                <h2>Booking Received!</h2>
                <p class="intro-text">Thank you, <strong>${esc(name)}</strong>. Our M-Pesa gateway is currently in offline mode. An engineer has received your request and will call <strong>${esc(phone)}</strong> shortly.</p>
                <p><a href="/requests" class="cta-btn" style="margin-top:10px;">View My Requests</a></p>
            `
        }));
    }

    try {
        const bookingObj = { id: bookingId, name, phone, service, location, amount, accountRef };
        const resStk = await stkPush(bookingObj);
        await pool.query('UPDATE bookings SET checkout_request_id = $1 WHERE id = $2', [resStk.CheckoutRequestID, bookingId]);

        await notify(`📱 STK sent: ${service} - ${name} (KES ${amount})`, bookingFields(bookingObj), req.session.user.email);

        res.send(renderPage({
            title: 'Check Your Phone',
            activeNav: 'survey',
            content: `
                <h2>Check Your Phone for M-Pesa</h2>
                <p class="intro-text">An STK push for <strong>KES ${amount}</strong> has been sent to <strong>${esc(phone)}</strong>.</p>
                <div id="status-box" style="background:var(--surface); border:1px solid var(--border); padding:20px; border-radius:8px; margin-top:20px; text-align:center;">
                    <p id="status-text" style="font-weight:bold; color:var(--primary);">Waiting for M-Pesa PIN confirmation...</p>
                </div>
                <div style="margin-top:20px; text-align:center;">
                    <a href="/requests" class="cta-btn" style="background:var(--primary);">View All My Requests & Receipts</a>
                </div>
                <script>
                    async function checkStatus() {
                        try {
                            const r = await fetch('/payments/status/${bookingId}');
                            const d = await r.json();
                            if (d.status === 'paid') {
                                let html = '<h3 style="color:var(--accent); margin:0;">Payment Confirmed Successfully!</h3><p>An official receipt has been emailed to you.</p>';
                                if (d.pdf) html += '<p><a href="' + d.pdf + '" class="cta-btn" style="margin-top:10px; display:inline-block; background:var(--accent); color:#0f172a;">Download Official PDF Receipt</a></p>';
                                html += '<p style="margin-top:10px;"><a href="/requests" style="color:var(--primary);">Go to My Requests Dashboard</a></p>';
                                document.getElementById('status-box').innerHTML = html;
                                clearInterval(timer);
                            } else if (d.status === 'failed') {
                                document.getElementById('status-box').innerHTML = '<h3 style="color:#f87171; margin:0;">Payment Cancelled or Failed</h3><a href="/survey" class="cta-btn" style="margin-top:15px;">Try Again</a>';
                                clearInterval(timer);
                            }
                        } catch(e) {}
                    }
                    const timer = setInterval(checkStatus, 4000);
                </script>
            `
        }));
    } catch (err) {
        console.error('STK Push Error:', err.message);
        res.status(500).send('Could not trigger M-Pesa payment prompt.');
    }
});

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
                    statusBadge = `<span style="background:rgba(248,113,113,0.15); color:#f87171; padding:4px 10px; border-radius:6px; font-weight:bold; font-size:0.85rem;">${b.status.toUpperCase()}</span>`;
                }

                const actionBtn = b.status === 'paid' 
                    ? `<a href="/payments/receipt/${b.id}/download.pdf" class="cta-btn" style="padding:6px 12px; font-size:0.85rem; background:var(--accent); color:#0f172a; text-decoration:none; display:inline-block;">📥 Download PDF</a>`
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
                <a href="/survey" class="cta-btn" style="display:inline-block; width:auto; padding:10px 24px;">+ Book Another Service</a>
            </div>
        `;
        res.send(renderPage({ title: 'My Requests', activeNav: 'requests', content }));
    } catch (err) {
        console.error('Error fetching requests:', err.message);
        res.status(500).send('Error loading requests dashboard.');
    }
});

// Signed booking / receipt link view
app.get('/booking/:token', async (req, res) => {
    const data = readBookingLink(req.params.token);
    if (!data) return res.status(404).send('Invalid or expired receipt link.');

    const isPaid = data.k === 1;
    const dateStr = new Date(data.t).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    const content = `
        <h2>${isPaid ? 'Payment Receipt & Booking' : 'Booking Status'}</h2>
        <p class="sub-title">Tencent Innovations | Rangwe, Homa Bay County</p>
        <div class="form-container">
            <p><strong>Status:</strong> <span style="color: ${isPaid ? 'var(--accent)' : '#38bdf8'}; font-weight: bold;">${isPaid ? 'PAID & CONFIRMED' : 'PENDING'}</span></p>
            <p><strong>Client Name:</strong> ${esc(data.n)}</p>
            <p><strong>Phone Number:</strong> ${esc(data.p)}</p>
            <p><strong>Service:</strong> ${esc(data.s)}</p>
            <p><strong>Location:</strong> ${esc(data.l)}</p>
            <p><strong>Amount:</strong> KES ${esc(data.a)}</p>
            <p><strong>Reference:</strong> ${esc(data.f)}</p>
            ${data.r ? `<p><strong>M-Pesa Receipt:</strong> ${esc(data.r)}</p>` : ''}
            <p><strong>Timestamp:</strong> ${esc(dateStr)}</p>
            ${isPaid && PDFDocument ? `<div style="margin-top: 25px;"><a href="/booking/${esc(req.params.token)}/receipt.pdf" class="cta-btn" style="background: var(--accent); color: #0f172a; text-align: center;">Download Official PDF Receipt</a></div>` : ''}
        </div>
    `;
    res.send(renderPage({ title: 'Receipt', activeNav: 'home', content }));
});

app.get('/booking/:token/receipt.pdf', async (req, res) => {
    if (!PDFDocument) return res.status(501).send('PDF generation disabled.');
    const data = readBookingLink(req.params.token);
    if (!data || data.k !== 1) return res.status(404).send('Receipt not found.');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Tencent-Receipt-${data.f}.pdf`);
    try {
        const buf = await generatePdfBuffer({
            accountRef: data.f,
            name: data.n,
            phone: data.p,
            service: data.s,
            location: data.l,
            amount: data.a,
            receipt: data.r,
            paidAt: data.t
        });
        res.send(buf);
    } catch (e) {
        res.status(500).send('Error generating PDF.');
    }
});

// Terms and Conditions Page
app.get('/terms', (req, res) => {
    const content = `
        <h2>Terms and Conditions of Service</h2>
        <p class="sub-title">Tencent Innovations | Rangwe, Homa Bay County, Kenya</p>
        <p class="intro-text">These Terms and Conditions govern the provision of internet services, security installations, and site surveys by Tencent Innovations.</p>
        <h3>1. Services and Surveys</h3>
        <p>Site surveys and consultations require an advance fee paid via M-Pesa. Fees cover engineer site visits and written quotations.</p>
        <h3>2. Payments</h3>
        <p>All payments are processed securely via M-Pesa STK Push. Receipts are delivered via email upon confirmation.</p>
    `;
    res.send(renderPage({ title: 'Terms and Conditions', activeNav: 'terms', content }));
});

// USSD Endpoint
app.post('/ussd', (req, res) => {
    const { text, phoneNumber } = req.body;
    let response = '';
    if (text === '') {
        response = `CON Welcome to Tencent Innovations
1. WiFi & Hotspot Internet
2. CCTV Installation
3. Smart Locks
4. Electric Fence
5. Solar Backup Power
6. Site Survey & Visit`;
    } else if (text === '1') {
        response = `CON WiFi Consultation: KES 3,000\n1. Confirm & Pay via M-PESA`;
    } else if (text.endsWith('*1')) {
        response = `END Thank you! An M-PESA payment prompt has been sent to ${phoneNumber}.`;
    } else {
        response = `END Invalid selection.`;
    }
    res.set('Content-Type', 'text/plain');
    res.send(response);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Tencent Innovations server running on port ${PORT}`));
