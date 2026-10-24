const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// PDF receipts need the "pdfkit" package. If it is missing the site still runs,
// and the download buttons simply do not appear.
let PDFDocument = null;
try {
    PDFDocument = require('pdfkit');
} catch (_) {
    console.error('pdfkit is not installed: PDF receipts are disabled. Add "pdfkit" to package.json dependencies.');
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

// 4. Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    // Safaricom callbacks and the payment status poll must never be throttled by this general limit
    skip: (req) => req.path.startsWith('/payments/cb/') || req.path.startsWith('/payments/status/')
});

// Strict limit on the payment form: stops people spamming M-Pesa prompts
const payLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many payment attempts from this network. Please try again later.'
});
app.use(limiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------
// Email notifications (Gmail via Nodemailer)
// Required env vars on Render: GMAIL_USER, GMAIL_APP_PASSWORD
// Optional: NOTIFY_TO (defaults to GMAIL_USER)
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

// Escape user input so nobody can inject HTML into pages or emails
function esc(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Form fields may arrive as strings or arrays (e.g. checkboxes)
function flat(value) {
    return Array.isArray(value) ? value.join(', ') : (value || '');
}

// Send a lead alert. Never throws: a mail failure must not break the customer's page.
async function notify(subject, fields) {
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

    // Always log the lead first, so it is in Render logs whatever happens next
    console.log('LEAD:', JSON.stringify({ subject: cleanSubject, fields, time }));

    // Telegram (HTTPS, works on Render free tier)
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

    // Email (needs SMTP: blocked on Render free tier, works on paid instances)
    const sendEmail = async () => {
        if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
        await mailer.sendMail({
            from: `"Tencent Website" <${process.env.GMAIL_USER}>`,
            to: process.env.NOTIFY_TO || process.env.GMAIL_USER,
            subject: cleanSubject,
            html: `<h3>${esc(cleanSubject)}</h3>${rows}<p style="color:#888">Received ${esc(time)} (EAT)</p>`
        });
    };

    const results = await Promise.allSettled([sendTelegram(), sendEmail()]);
    if (results[0].status === 'rejected') console.error('Telegram notification failed:', results[0].reason && results[0].reason.message);
    if (results[1].status === 'rejected') console.error('Notification email failed:', results[1].reason && results[1].reason.message);
}

// ---------------------------------------------------------------
// M-Pesa (Daraja) STK Push for a PAYBILL shortcode
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

const bookings = new Map();
const byCheckout = new Map();
const phoneAttempts = new Map();

function phoneAttemptAllowed(phone) {
    const now = Date.now();
    const recent = (phoneAttempts.get(phone) || []).filter(t => now - t < 60 * 60 * 1000);
    if (recent.length >= 3) { phoneAttempts.set(phone, recent); return false; }
    recent.push(now);
    phoneAttempts.set(phone, recent);
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, b] of bookings) {
        if (now - b.createdAt > 24 * 60 * 60 * 1000) {
            bookings.delete(id);
            if (b.checkoutRequestId) byCheckout.delete(b.checkoutRequestId);
        }
    }
    for (const [p, arr] of phoneAttempts) {
        const recent = arr.filter(t => now - t < 60 * 60 * 1000);
        if (recent.length) phoneAttempts.set(p, recent); else phoneAttempts.delete(p);
    }
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

// ---- Signed booking links -------------------------------------------------
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

async function markPaid(booking, receipt, verified) {
    if (booking.status === 'paid') return;
    booking.status = 'paid';
    booking.receipt = receipt || '';
    booking.paidAt = Date.now();
    booking.link = makeBookingLink(booking);

    const pdfDownloadUrl = `${MPESA.publicBaseUrl}/payments/receipt/${booking.id}/download.pdf`;

    const extra = {
        'M-Pesa receipt': receipt || '(see M-Pesa statement, match the Reference)',
        Verified: verified ? 'Yes, confirmed with Safaricom' : 'Callback only (status query was unavailable)'
    };

    if (PDFDocument) {
        extra['Download Receipt PDF'] = pdfDownloadUrl;
    }

    if (booking.link) {
        extra['Booking link'] = booking.link;
        if (PDFDocument) extra['Receipt Link PDF'] = booking.link + '/receipt.pdf';
        const msg = `Hello ${booking.name}, your Tencent Innovations booking is confirmed (${booking.service}, KES ${booking.amount} paid). Download receipt: ${pdfDownloadUrl}`;
        extra['Send to client on WhatsApp'] = `https://wa.me/${booking.phone}?text=${encodeURIComponent(msg)}`;
    }
    await notify(`✅ PAID: ${booking.service} - ${booking.name}`, bookingFields(booking, extra));
}

function markFailed(booking, reason) {
    if (booking.status !== 'pending') return;
    booking.status = 'failed';
    console.log('PAYMENT NOT COMPLETED:', JSON.stringify({ id: booking.id, reason }));
}

async function handleCallback(body) {
    const cb = body && body.Body && body.Body.stkCallback;
    if (!cb) return;
    const booking = byCheckout.get(cb.CheckoutRequestID);
    if (!booking) {
        console.log('Callback for unknown CheckoutRequestID:', cb.CheckoutRequestID);
        return;
    }

    const succeeded = Number(cb.ResultCode) === 0;
    const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const meta = name => { const it = items.find(i => i.Name === name); return it ? it.Value : undefined; };
    const receipt = String(meta('MpesaReceiptNumber') || '');

    if (booking.status === 'paid') {
        if (succeeded && receipt && !booking.receipt) booking.receipt = receipt;
        return;
    }
    if (!succeeded) { markFailed(booking, cb.ResultDesc); return; }

    if (Number(meta('Amount')) !== booking.amount) {
        booking.status = 'review';
        await notify(`⚠️ CHECK PAYMENT: amount mismatch for ${booking.name}`, bookingFields(booking, {
            'Amount reported by callback': String(meta('Amount')),
            'M-Pesa receipt': receipt
        }));
        return;
    }

    let verified = false;
    try {
        const q = await stkQuery(booking.checkoutRequestId);
        verified = String(q.ResultCode) === '0';
        if (!verified) {
            booking.status = 'review';
            await notify(`⚠️ CHECK PAYMENT: callback and status query disagree for ${booking.name}`, bookingFields(booking, {
                'M-Pesa receipt': receipt,
                'Query result': `${q.ResultCode} ${q.ResultDesc || ''}`
            }));
            return;
        }
    } catch (err) {
        console.error('STK status query failed, accepting callback only:', err.message);
    }
    await markPaid(booking, receipt, verified);
}

app.post('/payments/cb/:secret', (req, res) => {
    const given = Buffer.from(String(req.params.secret));
    const expected = Buffer.from(String(MPESA.callbackSecret || ''));
    const ok = expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.sendStatus(404);

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    handleCallback(req.body).catch(err => console.error('Callback handling error:', err.message));
});

app.get('/payments/status/:id', async (req, res) => {
    const b = bookings.get(String(req.params.id));
    if (!b) return res.status(404).json({ status: 'unknown' });

    if (b.status === 'pending' && b.checkoutRequestId &&
        Date.now() - b.createdAt > 25000 && Date.now() - (b.lastQuery || 0) > 12000) {
        b.lastQuery = Date.now();
        try {
            const q = await stkQuery(b.checkoutRequestId);
            if (String(q.ResultCode) === '0') await markPaid(b, '', true);
            else if (q.ResultCode !== undefined && String(q.ResultCode) !== '') markFailed(b, q.ResultDesc);
        } catch (_) {}
    }
    const paidLink = b.status === 'paid' ? (b.link || '') : '';
    const pdfUrl = b.status === 'paid' ? `/payments/receipt/${b.id}/download.pdf` : '';
    res.json({ status: b.status, link: paidLink, pdf: pdfUrl });
});

// Direct Session PDF Receipt Download Endpoint
app.get('/payments/receipt/:id/download.pdf', (req, res) => {
    const b = bookings.get(String(req.params.id));
    if (!b || b.status !== 'paid') {
        return res.status(404).send('Receipt not available or payment pending.');
    }

    if (!PDFDocument) {
        return res.status(501).send('PDF generation module (pdfkit) is not available.');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Tencent-Receipt-${b.accountRef}.pdf`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    doc.fillColor('#0284c7').fontSize(22).text('TENCENT INNOVATIONS', { align: 'center' });
    doc.fillColor('#64748b').fontSize(10).text('Rangwe, Homa Bay County | Tel: 0740 311 014 | tencentbz@gmail.com', { align: 'center' });
    doc.moveDown(2);

    doc.fillColor('#0f172a').fontSize(16).text('OFFICIAL PAYMENT RECEIPT', { align: 'center' });
    doc.moveDown(1.5);

    doc.fontSize(12);
    const dateStr = new Date(b.paidAt || Date.now()).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

    const rows = [
        ['Reference / Account:', b.accountRef],
        ['Client Name:', b.name],
        ['Phone Number:', b.phone],
        ['Service Rendered:', b.service],
        ['Location:', b.location],
        ['Amount Paid:', `KES ${b.amount}`],
        ['M-Pesa Receipt:', b.receipt || 'Confirmed via Daraja'],
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

// Shared Layout Template Helper
function renderPage({ title, activeNav, content }) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title} - Tencent Innovations</title>
            <style>
                :root { --primary: #0284c7; --bg: #0f172a; --text: #f8fafc; --muted: #94a3b8; --accent: #4ade80; }
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--text); line-height: 1.6; }
                
                /* Main Navigation Bar */
                nav { background: #0b1120; border-bottom: 1px solid #334155; padding: 12px 30px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; flex-wrap: wrap; }
                .logo-container { display: flex; align-items: center; gap: 12px; text-decoration: none; }
                .logo-img { height: 48px; width: auto; border-radius: 6px; background: #ffffff; padding: 2px; }
                .logo-text-group { display: flex; flex-direction: column; }
                .logo-text { font-size: 1.25rem; font-weight: bold; color: #38bdf8; text-decoration: none; line-height: 1.1; }
                .logo-tagline { font-size: 0.75rem; color: var(--muted); }
                .nav-links { display: flex; gap: 8px; list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
                .nav-links a { color: var(--muted); text-decoration: none; font-weight: 500; font-size: 0.9rem; padding: 6px 12px; border-radius: 6px; transition: all 0.2s; }
                .nav-links a:hover, .nav-links a.active { color: white; background: #1e293b; }
                
                /* Hero Service Banner */
                .hero-banner { 
                    background: linear-gradient(rgba(15, 23, 42, 0.85), rgba(15, 23, 42, 0.85)), url('/banner.png');
                    background-size: cover;
                    background-position: center;
                    padding: 60px 20px; 
                    text-align: center; 
                    border-bottom: 1px solid #334155; 
                }
                .hero-banner h1 { font-size: 2.3rem; margin: 0 0 10px 0; color: #ffffff; }
                .hero-banner p { color: #e2e8f0; font-size: 1.15rem; margin-bottom: 20px; max-width: 800px; margin-left: auto; margin-right: auto; }
                .ussd-badge { display: inline-block; background: #38bdf8; color: #0f172a; padding: 10px 22px; border-radius: 30px; font-weight: bold; font-size: 1.05rem; box-shadow: 0 4px 15px rgba(56, 189, 248, 0.3); }

                /* Layout & Content Flow */
                .container { max-width: 900px; margin: 40px auto; padding: 0 20px; }
                h2 { color: #38bdf8; font-size: 2rem; margin-top: 0; }
                h3 { color: #38bdf8; margin-top: 30px; }
                .sub-title { color: var(--muted); font-size: 1.15rem; margin-top: -10px; margin-bottom: 25px; }
                .intro-text { font-size: 1.1rem; color: #e2e8f0; margin-bottom: 25px; }
                
                /* Bullet & Feature Lists */
                ul.feature-list { list-style: none; padding: 0; margin: 20px 0; }
                ul.feature-list li { margin-bottom: 12px; padding-left: 28px; position: relative; font-size: 1.05rem; color: #f1f5f9; }
                ul.feature-list li::before { content: "✔"; position: absolute; left: 0; color: var(--accent); font-weight: bold; }

                /* Call to Action & Forms Styling */
                .cta-box { background: #1e293b; border: 1px solid #334155; padding: 25px; border-radius: 10px; margin-top: 40px; text-align: center; }
                .cta-box p { font-size: 1.1rem; margin-top: 0; color: #f8fafc; }
                .cta-btn { display: inline-block; background: var(--primary); color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 1.05rem; transition: background 0.2s; border: none; cursor: pointer; width: 100%; box-sizing: border-box; text-align: center; }
                .cta-btn:hover { background: #0369a1; }

                .form-container { background: #1e293b; border: 1px solid #334155; padding: 25px; border-radius: 10px; margin-top: 30px; text-align: left; }
                .form-group { margin-bottom: 15px; }
                .form-group label { display: block; margin-bottom: 5px; color: #38bdf8; font-weight: 500; }
                .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #f8fafc; box-sizing: border-box; }
                .form-group checkbox-group { display: flex; gap: 15px; flex-wrap: wrap; }

                .contact-bar { background: #0b1120; border-top: 1px solid #334155; padding: 20px; text-align: center; color: var(--muted); margin-top: 50px; }
                .contact-bar strong { color: #38bdf8; }
                footer { text-align: center; padding: 20px; color: var(--muted); font-size: 0.9rem; }
                footer a { color: #38bdf8; text-decoration: none; }
                footer a:hover { text-decoration: underline; }

                /* Terms & Conditions page */
                .terms h3 { margin-top: 30px; }
                .terms p.clause { margin: 8px 0; color: #e2e8f0; }
                .terms p.clause strong { color: var(--accent); margin-right: 6px; }
                .terms ul { padding-left: 22px; color: #f1f5f9; }
                .terms ul li { margin-bottom: 8px; }
            </style>
        </head>
        <body>
            <!-- Main Navigation Menu -->
            <nav>
                <a href="/" class="logo-container">
                    <img src="/logo.png" alt="Tencent Innovations" class="logo-img" onerror="this.style.display='none'">
                    <div class="logo-text-group">
                        <span class="logo-text">Tencent Innovations</span>
                        <span class="logo-tagline">Connecting You, Faster.</span>
                    </div>
                </a>
                <ul class="nav-links">
                    <li><a href="/" class="${activeNav === 'home' ? 'active' : ''}">Home</a></li>
                    <li><a href="/wifi" class="${activeNav === 'wifi' ? 'active' : ''}">WiFi</a></li>
                    <li><a href="/cctv" class="${activeNav === 'cctv' ? 'active' : ''}">CCTV</a></li>
                    <li><a href="/smart-locks" class="${activeNav === 'smart-locks' ? 'active' : ''}">Smart Locks</a></li>
                    <li><a href="/electric-fence" class="${activeNav === 'electric-fence' ? 'active' : ''}">Electric Fence</a></li>
                    <li><a href="/solar" class="${activeNav === 'solar' ? 'active' : ''}">Solar</a></li>
                    <li><a href="/survey" class="${activeNav === 'survey' ? 'active' : ''}">Surveys</a></li>
                </ul>
            </nav>

            <div class="container">
                ${content}
            </div>

            <div class="contact-bar">
                📍 <strong>Rangwe, Homa Bay County</strong> &nbsp;|&nbsp; 📞 <strong>0740 311 014</strong> &nbsp;|&nbsp; ✉️ <strong>tencentbz@gmail.com</strong>
            </div>

            <footer>
                <p>&copy; 2026 Tencent Innovations. All rights reserved. Powered by Tencent Innovations Web Platform.</p>
                <p><a href="/terms">Terms and Conditions</a></p>
            </footer>
        </body>
        </html>
    `;
}

// 1. Home Page
app.get('/', (req, res) => {
    const content = `
        <div class="hero-banner" style="margin: -40px -20px 40px -20px;">
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

        <h3>Why choose us</h3>
        <ul class="feature-list">
            <li>Engineer-led design and installation, not guesswork.</li>
            <li>A clear quote after the survey, with no surprise add-ons.</li>
            <li>Local support after installation.</li>
            <li>One team for all your systems, so your WiFi, cameras and power work together.</li>
        </ul>

        <div class="form-container" id="callback-form">
            <h3 style="margin-top:0; color:#38bdf8;">Request a Free Callback</h3>
            <p style="color:var(--muted); font-size:0.95rem;">Not sure where to start? Send us your details and an engineer will call you back shortly.</p>
            <form action="/submit-callback" method="POST">
                <div class="form-group">
                    <label>Your Name</label>
                    <input type="text" name="name" required placeholder="e.g. John Otieno">
                </div>
                <div class="form-group">
                    <label>Phone Number</label>
                    <input type="tel" name="phone" required placeholder="e.g. 0712345678">
                </div>
                <div class="form-group">
                    <label>Project / Problem Description</label>
                    <textarea name="message" rows="3" required placeholder="e.g. Need CCTV installed at my shop in Rangwe"></textarea>
                </div>
                <button type="submit" class="cta-btn">Request Callback</button>
            </form>
        </div>
    `;
    res.send(renderPage({ title: 'Home', activeNav: 'home', content }));
});

// Handle Callback Submission
app.post('/submit-callback', async (req, res) => {
    const { name, phone, message } = req.body;

    await notify(`📞 Callback request: ${name || 'Unknown'}`, {
        Name: name,
        Phone: phone,
        Message: message
    });

    res.send(renderPage({
        title: 'Callback Requested',
        activeNav: 'home',
        content: `<h2>Thank You, ${esc(name)}!</h2><p class="intro-text">We have received your request. An engineer will call you at <strong>${esc(phone)}</strong> shortly.</p><a href="/" class="cta-btn">Back to Home</a>`
    }));
});

// 2. WiFi Page
app.get('/wifi', (req, res) => {
    const content = `
        <h2>Reliable WiFi for homes, rentals and businesses.</h2>
        <p class="sub-title">Pay-as-you-go hotspot or a fixed monthly connection. We build the network, run the billing and keep it online.</p>
        
        <p class="intro-text">A good connection depends on the whole chain: the link to the mast, the router, the access points and how many people share them. We design all of it together, so the signal reaches every room and holds up when more people connect.</p>

        <h3>Two ways to get connected</h3>
        <ul class="feature-list">
            <li><strong>Hotspot:</strong> Buy a time or data bundle with M-Pesa and connect from any phone or laptop. Good for rental plots, shops, cafes and public spaces.</li>
            <li><strong>Monthly home or office plan:</strong> A dedicated connection with its own private WiFi name and password, billed monthly. Good for homes, schools and offices that need a steady line.</li>
        </ul>

        <h3>What is included</h3>
        <ul class="feature-list">
            <li>Site survey and signal test before we install</li>
            <li>Outdoor and indoor access points, positioned for coverage</li>
            <li>Router configuration with a captive login page, user limits and M-Pesa payments</li>
            <li>Private WiFi and hotspot on the same equipment when you need both</li>
            <li>Support when something drops</li>
        </ul>

        <h3>For business owners</h3>
        <p>Running a hotspot business? We can set up the network, billing and login system for you, and show you how to manage customers yourself.</p>

        <div class="cta-box">
            <p>Tell us where you are and what you need. We will visit, test the signal and give you a clear quote.</p>
            <a href="/survey" class="cta-btn">Book a WiFi consultation</a>
        </div>
    `;
    res.send(renderPage({ title: 'WiFi & Networking', activeNav: 'wifi', content }));
});

// 3. CCTV Page
app.get('/cctv', (req, res) => {
    const content = `
        <h2>See your property from anywhere.</h2>
        <p class="sub-title">CCTV systems for homes, shops, schools and compounds, installed and set up to view live on your phone.</p>
        
        <p class="intro-text">A camera is only useful if it points at the right place, records clearly at night and keeps working when the power goes. We plan the camera positions on site, install the system neatly and show you how to use it.</p>

        <h3>What you get</h3>
        <ul class="feature-list">
            <li>Cameras chosen for the spot: entrances, gates, parking, counters, perimeters</li>
            <li>Clear day and night recording</li>
            <li>Live viewing and playback on your phone</li>
            <li>Recording to a hard drive, with enough storage for the number of days you need</li>
            <li>Tidy, protected cabling and weatherproof fittings outdoors</li>
            <li>Backup power so recording continues during outages</li>
        </ul>

        <h3>How it works</h3>
        <ol style="color: #f1f5f9; padding-left: 20px; line-height: 1.8;">
            <li>We visit and walk the site with you.</li>
            <li>You receive a camera layout and a written quote.</li>
            <li>We install, test every camera and set up your phone.</li>
            <li>We show you how to find and save footage.</li>
        </ol>

        <h3>Good to know</h3>
        <ul class="feature-list">
            <li>Cameras work best when they are placed for a purpose. We will tell you if you need fewer than you expected, or more.</li>
            <li>Already have cameras? We can inspect them, fix faults and add remote viewing.</li>
        </ul>

        <div class="cta-box">
            <p>Book a survey and we will tell you what your property needs and what it will cost.</p>
            <a href="/survey" class="cta-btn">Book a CCTV survey</a>
        </div>
    `;
    res.send(renderPage({ title: 'CCTV Systems', activeNav: 'cctv', content }));
});

// 4. Smart Locks Page
app.get('/smart-locks', (req, res) => {
    const content = `
        <h2>Open your door without a key.</h2>
        <p class="sub-title">Smart locks for homes, rental units, offices and stores. Use a code, a card, a fingerprint or your phone.</p>
        
        <p class="intro-text">Keys get lost, copied and passed to people who should not have them. A smart lock removes that problem. You decide who can enter, and you can take that access away in seconds.</p>

        <h3>Ways to unlock</h3>
        <ul class="feature-list">
            <li>Fingerprint</li>
            <li>PIN code</li>
            <li>Card or key tag</li>
            <li>Phone app (on supported models)</li>
            <li>Mechanical key as a backup</li>
        </ul>

        <h3>Why people choose them</h3>
        <ul class="feature-list">
            <li><strong>Landlords and caretakers:</strong> Give each tenant their own code and change it when they move out. No more rekeying.</li>
            <li><strong>Families:</strong> Children enter without carrying keys.</li>
            <li><strong>Offices and stores:</strong> Give staff access and remove it when they leave.</li>
            <li><strong>Short-stay hosts:</strong> Share a temporary code with guests.</li>
        </ul>

        <h3>What we do</h3>
        <ul class="feature-list">
            <li>Help you pick a model that fits your door and budget</li>
            <li>Fit and align the lock so it closes smoothly</li>
            <li>Add your users and show you how to manage them</li>
            <li>Fit new batteries and show you how to know when they are low</li>
        </ul>

        <p><strong>Good to know:</strong> Smart locks fit most standard wooden and metal doors. We check your door during the survey and tell you if it needs changes before the lock goes on.</p>

        <div class="cta-box">
            <p>Tell us about your door and how many people need access. We will recommend a lock and quote you the installed price.</p>
            <a href="/survey" class="cta-btn">Book a smart lock consultation</a>
        </div>
    `;
    res.send(renderPage({ title: 'Smart Locks', activeNav: 'smart-locks', content }));
});

// 5. Electric Fence Page
app.get('/electric-fence', (req, res) => {
    const content = `
        <h2>Stop intruders at the boundary.</h2>
        <p class="sub-title">Electric fence installation for homes, compounds, schools, farms and commercial plots, with an alarm that alerts you when the fence is touched or cut.</p>
        
        <p class="intro-text">A visible fence with a warning sign makes most intruders look for an easier target. Fitted correctly, it protects your boundary without turning your compound into a hazard. We install to a safe standard and explain every part of the system to you.</p>

        <h3>What is included</h3>
        <ul class="feature-list">
            <li>Fence design for your wall, roof or open boundary</li>
            <li>Energiser, wiring, insulators and earthing, installed correctly</li>
            <li>Alarm siren and a control unit you can arm and disarm</li>
            <li>Warning signs on every side of the fence</li>
            <li>Backup battery so protection continues during power cuts</li>
            <li>A walk-through showing how to arm, disarm and check the system</li>
        </ul>

        <h3>Safety comes first</h3>
        <ul class="feature-list">
            <li>We use proper insulators and a correct earthing system.</li>
            <li>The fence delivers a short pulse designed to deter, not harm.</li>
            <li>Warning signs go up before the fence is switched on.</li>
            <li>We tell you how to keep vegetation and objects away from the live wires.</li>
        </ul>

        <p><strong>Often paired with:</strong> CCTV to see what set off the alarm, a solar backup so the fence runs through blackouts, and a smart lock on your gate or main door.</p>

        <div class="cta-box">
            <p>Book a survey. We measure your boundary, explain the options and give you a written quote.</p>
            <a href="/survey" class="cta-btn">Book an electric fence survey</a>
        </div>
    `;
    res.send(renderPage({ title: 'Electric Fence', activeNav: 'electric-fence', content }));
});

// 6. Solar Page
app.get('/solar', (req, res) => {
    const content = `
        <h2>Keep the lights, internet and cameras on when the grid goes off.</h2>
        <p class="sub-title">Solar and battery systems sized for your home, shop, school or network site, from a small backup to a full installation.</p>
        
        <p class="intro-text">Power cuts cost you sales, security and connection time. A solar system with battery storage keeps your essential equipment running, and cuts your dependence on the grid. We size every system to the equipment you need to power, so you do not overpay for capacity you will not use.</p>

        <h3>What we offer</h3>
        <ul class="feature-list">
            <li><strong>Backup power:</strong> Keep lights, TV, router, phones and cameras running through outages.</li>
            <li><strong>Hybrid systems:</strong> Use solar by day, batteries at night and the grid as a fallback.</li>
            <li><strong>Off-grid systems:</strong> Power sites with no grid connection.</li>
            <li><strong>Network and security backup:</strong> Keep WiFi access points, CCTV and electric fences online for hours after a cut.</li>
        </ul>

        <h3>What is included</h3>
        <ul class="feature-list">
            <li>A list of what you want to power, and how long it must run</li>
            <li>System sizing: panels, battery capacity and inverter</li>
            <li>Mounting, wiring, protection and earthing done to a safe standard</li>
            <li>Testing and a walk-through of how the system behaves</li>
            <li>Support and maintenance</li>
        </ul>

        <div class="form-container">
            <h3 style="margin-top:0; color:#38bdf8;">Solar Load & Battery Sizing Request</h3>
            <form action="/submit-survey-payment" method="POST">
                <input type="hidden" name="service" value="Solar Consultation">
                <div class="form-group"><label>Full Name</label><input type="text" name="name" required placeholder="e.g. Mary Akinyi"></div>
                <div class="form-group"><label>M-Pesa Phone Number</label><input type="tel" name="phone" required placeholder="0712345678"></div>
                <div class="form-group"><label>Property Type</label>
                    <select name="propertyType">
                        <option value="Home">Home</option>
                        <option value="Shop">Shop / Business</option>
                        <option value="School">School / Institution</option>
                        <option value="Rental Compound">Rental Compound</option>
                    </select>
                </div>
                <div class="form-group"><label>Location</label><input type="text" name="location" required placeholder="e.g. Rangwe Town"></div>
                <button type="submit" class="cta-btn">Pay KES 4,000 & Request Sizing</button>
            </form>
        </div>
    `;
    res.send(renderPage({ title: 'Solar Solutions', activeNav: 'solar', content }));
});

// 7. Surveys Page
app.get('/survey', (req, res) => {
    const content = `
        <h2>Know what your site needs before you spend.</h2>
        <p class="sub-title">A site survey by an engineer, followed by a written plan and quote for WiFi, CCTV, smart locks, electric fence or solar.</p>
        
        <p class="intro-text">The survey is where good installations start. We visit your property, measure, test and talk through what you want to achieve. You leave with a clear plan, so you can compare options and decide with confidence.</p>

        <h3>What we check</h3>
        <ul class="feature-list">
            <li><strong>Network:</strong> Signal strength, line of sight to the mast, obstacles and the best place for access points</li>
            <li><strong>CCTV:</strong> Camera positions, viewing angles, lighting and cable routes</li>
            <li><strong>Smart locks:</strong> Door type, thickness and condition</li>
            <li><strong>Electric fence:</strong> Boundary length, corners, gates and earthing points</li>
            <li><strong>Solar:</strong> Roof space, shading, the equipment you need to power and where batteries should sit</li>
        </ul>

        <h3>What you receive</h3>
        <ul class="feature-list">
            <li>A written report of what we found</li>
            <li>A recommended design, with options where they make sense</li>
            <li>An itemised quote for equipment and installation</li>
            <li>An estimated installation time</li>
        </ul>

        <div class="form-container" style="border-color: var(--accent);">
            <h3 style="margin-top:0; color: var(--accent);">Book Site Survey & Pay via M-Pesa (STK Push)</h3>
            <p style="color:var(--muted); font-size:0.95rem;">Fill in your site details. Submitting will trigger an instant M-Pesa prompt on your phone for the survey fee.</p>
            <form action="/submit-survey-payment" method="POST" id="payment-form">
                <div class="form-group"><label>Full Name</label><input type="text" name="name" required placeholder="e.g. Mary Akinyi"></div>
                <div class="form-group"><label>M-Pesa Phone Number</label><input type="tel" name="phone" required placeholder="0712345678"></div>
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

app.get('/submit-survey-payment', (req, res) => {
    res.redirect('/survey');
});

// Handle Payment Submission & STK Push
app.post('/submit-survey-payment', payLimiter, async (req, res) => {
    const { name, phone: rawPhone, service, location } = req.body;
    const phone = normalizePhone(rawPhone);

    if (!name || !phone || !service || !location) {
        return res.status(400).send(renderPage({
            title: 'Missing Details',
            activeNav: 'survey',
            content: `<h2>Incomplete Form</h2><p class="intro-text">Please provide your name, a valid Safaricom phone number, service, and location.</p><a href="/survey" class="cta-btn">Back</a>`
        }));
    }

    if (!phoneAttemptAllowed(phone)) {
        return res.status(429).send(renderPage({
            title: 'Too Many Attempts',
            activeNav: 'survey',
            content: `<h2>Please Wait</h2><p class="intro-text">You have requested several payment prompts recently. Please check your phone or try again later.</p><a href="/survey" class="cta-btn">Back</a>`
        }));
    }

    const amount = SERVICE_PRICES[service] || 3000;
    const bookingId = crypto.randomUUID();
    const accountRef = `TI-${Math.floor(1000 + Math.random() * 9000)}`;

    const booking = {
        id: bookingId,
        name,
        phone,
        service,
        location,
        amount,
        accountRef,
        status: 'pending',
        createdAt: Date.now()
    };
    bookings.set(bookingId, booking);

    if (!mpesaConfigured()) {
        await notify(`📝 PENDING (M-Pesa unconfigured): ${service} - ${name}`, bookingFields(booking));
        return res.send(renderPage({
            title: 'Booking Received',
            activeNav: 'survey',
            content: `
                <h2>Booking Received!</h2>
                <p class="intro-text">Thank you, <strong>${esc(name)}</strong>. Our online M-Pesa gateway is currently in offline setup mode. An engineer has received your request for <strong>${esc(service)}</strong> in <strong>${esc(location)}</strong> and will call <strong>${esc(phone)}</strong> shortly.</p>
                <a href="/" class="cta-btn">Back to Home</a>
            `
        }));
    }

    try {
        const resStk = await stkPush(booking);
        booking.checkoutRequestId = resStk.CheckoutRequestID;
        byCheckout.set(resStk.CheckoutRequestID, booking);

        await notify(`📱 STK sent: ${service} - ${name} (KES ${amount})`, bookingFields(booking));

        res.send(renderPage({
            title: 'Check Your Phone',
            activeNav: 'survey',
            content: `
                <h2>Check Your Phone for M-Pesa</h2>
                <p class="intro-text">An STK push for <strong>KES ${amount}</strong> has been sent to <strong>${esc(phone)}</strong> for <strong>${esc(service)}</strong>.</p>
                <p>Please enter your M-Pesa PIN when the prompt appears on your screen.</p>
                
                <div id="status-box" style="background:#1e293b; border:1px solid #334155; padding:20px; border-radius:8px; margin-top:20px; text-align:center;">
                    <p id="status-text" style="font-weight:bold; color:#38bdf8;">Waiting for M-Pesa PIN confirmation...</p>
                </div>

                <script>
                    async function checkStatus() {
                        try {
                            const r = await fetch('/payments/status/${bookingId}');
                            const d = await r.json();
                            if (d.status === 'paid') {
                                let html = '<h3 style="color:#4ade80; margin:0;">Payment Confirmed Successfully!</h3><p>An engineer has been assigned and will call you shortly.</p>';
                                if (d.pdf) {
                                    html += '<p><a href="' + d.pdf + '" class="cta-btn" style="margin-top:10px; display:inline-block; background:#4ade80; color:#0f172a;">Download Official PDF Receipt</a></p>';
                                }
                                if (d.link) {
                                    html += '<p><a href="' + d.link + '" class="cta-btn" style="margin-top:10px; display:inline-block; background:#0284c7;">View Permanent Receipt Page</a></p>';
                                }
                                document.getElementById('status-box').innerHTML = html;
                                clearInterval(timer);
                            } else if (d.status === 'failed') {
                                document.getElementById('status-box').innerHTML = '<h3 style="color:#f87171; margin:0;">Payment Cancelled or Failed</h3><p>The transaction was not completed. Please try again.</p><a href="/survey" class="cta-btn" style="margin-top:15px;">Try Again</a>';
                                clearInterval(timer);
                            }
                        } catch(e) {}
                    }
                    const timer = setInterval(checkStatus, 4000);
                </script>
            `
        }));
    } catch (err) {
        booking.status = 'error';
        console.error('STK Push Error:', err.message);
        res.status(500).send(renderPage({
            title: 'Payment Error',
            activeNav: 'survey',
            content: `
                <h2>Could Not Send M-Pesa Prompt</h2>
                <p class="intro-text">We encountered an error contacting Safaricom: ${esc(err.message)}. Please check your phone number or use our USSD code <strong>*384*100#</strong>.</p>
                <a href="/survey" class="cta-btn">Try Again</a>
            `
        }));
    }
});

// View booking / receipt via signed link
app.get('/booking/:token', (req, res) => {
    const data = readBookingLink(req.params.token);
    if (!data) {
        return res.status(404).send(renderPage({
            title: 'Invalid Link',
            activeNav: 'home',
            content: `<h2>Invalid or Expired Link</h2><p class="intro-text">This booking or receipt link is invalid or has expired.</p><a href="/" class="cta-btn">Back to Home</a>`
        }));
    }

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
            
            ${isPaid && PDFDocument ? `
                <div style="margin-top: 25px;">
                    <a href="/booking/${esc(req.params.token)}/receipt.pdf" class="cta-btn" style="background: var(--accent); color: #0f172a; text-align: center;">Download Official PDF Receipt</a>
                </div>
            ` : ''}
        </div>
        <div style="margin-top: 20px; text-align: center;">
            <a href="/" class="cta-btn" style="width: auto; padding: 10px 20px;">Return to Home</a>
        </div>
    `;
    res.send(renderPage({ title: isPaid ? 'Receipt' : 'Booking', activeNav: 'home', content }));
});

// PDF Receipt Download Route for signed links
app.get('/booking/:token/receipt.pdf', (req, res) => {
    if (!PDFDocument) {
        return res.status(501).send('PDF generation is not enabled on this server.');
    }
    const data = readBookingLink(req.params.token);
    if (!data || data.k !== 1) {
        return res.status(404).send('Receipt not found or payment not completed.');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Tencent-Receipt-${data.f}.pdf`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    doc.fillColor('#0284c7').fontSize(22).text('TENCENT INNOVATIONS', { align: 'center' });
    doc.fillColor('#64748b').fontSize(10).text('Rangwe, Homa Bay County | Tel: 0740 311 014 | tencentbz@gmail.com', { align: 'center' });
    doc.moveDown(2);

    doc.fillColor('#0f172a').fontSize(16).text('OFFICIAL PAYMENT RECEIPT', { align: 'center' });
    doc.moveDown(1.5);

    doc.fontSize(12);
    const dateStr = new Date(data.t).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

    const rows = [
        ['Receipt No / Ref:', data.f],
        ['Client Name:', data.n],
        ['Phone Number:', data.p],
        ['Service Rendered:', data.s],
        ['Location:', data.l],
        ['Amount Paid:', `KES ${data.a}`],
        ['M-Pesa Transaction:', data.r || 'Verified via System'],
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

// Terms and Conditions Page
app.get('/terms', (req, res) => {
    const content = `
        <div class="terms">
            <h2>Terms and Conditions</h2>
            <p class="sub-title">Last updated: January 2026</p>
            
            <p class="intro-text">These Terms and Conditions govern the provision of internet services, security installations, solar systems, and site surveys by Tencent Innovations.</p>

            <h3>1. Services and Surveys</h3>
            <p class="clause"><strong>1.1</strong> Site surveys and consultations require an advance fee (such as KES 3,000 for general surveys/WiFi/CCTV, KES 2,500 for smart locks, KES 5,000 for electric fences, or KES 4,000 for solar consultations) paid via M-Pesa.</p>
            <p class="clause"><strong>1.2</strong> Survey fees cover engineer site visits, testing, and written quotations. Fees are non-refundable once the site visit has been executed.</p>

            <h3>2. Payments and M-Pesa</h3>
            <p class="clause"><strong>2.1</strong> All payments for packages, hotspots, and survey bookings are processed securely via M-Pesa STK Push or authorised channels.</p>
            <p class="clause"><strong>2.2</strong> Services or installations commence only upon confirmation of payment by our system.</p>

            <h3>3. Equipment and Warranties</h3>
            <p class="clause"><strong>3.1</strong> Hardware supplied and installed by Tencent Innovations remains property of the company until paid for in full where applicable under specific agreements.</p>
            <p class="clause"><strong>3.2</strong> Workmanship is backed by our local support team in Rangwe and Homa Bay County.</p>

            <h3>4. Contact Us</h3>
            <p class="clause">For any inquiries regarding these terms, contact us on <strong>0740 311 014</strong> or email <strong>tencentbz@gmail.com</strong>.</p>
        </div>
    `;
    res.send(renderPage({ title: 'Terms and Conditions', activeNav: 'home', content }));
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
        response = `CON WiFi Consultation: KES 3,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '2') {
        response = `CON CCTV Survey: KES 3,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '3') {
        response = `CON Smart Locks Consultation: KES 2,500
1. Confirm & Pay via M-PESA`;
    } else if (text === '4') {
        response = `CON Electric Fence Survey: KES 5,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '5') {
        response = `CON Solar Consultation: KES 4,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '6') {
        response = `CON Site Survey: KES 3,000
1. Confirm & Pay via M-PESA`;
    } else if (text.endsWith('*1')) {
        response = `END Thank you! An M-PESA payment prompt has been sent to ${phoneNumber}. An engineer will call you shortly.`;
    } else {
        response = `END Invalid selection. Please dial again.`;
    }

    res.set('Content-Type', 'text/plain');
    res.send(response);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Tencent Innovations server running on port ${PORT}`));
