const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');

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
// Short timeouts so a blocked SMTP connection (Render free tier) cannot hang the form.
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
            const display = /phone/i.test(label)
                ? `<a href="tel:${safe}">${safe}</a>`
                : safe;
            return `<p><strong>${esc(label)}:</strong> ${display}</p>`;
        })
        .join('');
    const time = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

    // Always log the lead first, so it is in Render logs whatever happens next
    console.log('LEAD:', JSON.stringify({ subject: cleanSubject, fields, time }));

    // Telegram (HTTPS, works on Render free tier)
    // Env vars: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
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

    // Run both in parallel; one failing never blocks the other or the customer's page
    const results = await Promise.allSettled([sendTelegram(), sendEmail()]);
    if (results[0].status === 'rejected') console.error('Telegram notification failed:', results[0].reason && results[0].reason.message);
    if (results[1].status === 'rejected') console.error('Notification email failed:', results[1].reason && results[1].reason.message);
}

// ---------------------------------------------------------------
// M-Pesa (Daraja) STK Push for a PAYBILL shortcode
//
// Env vars on Render:
//   MPESA_ENV              sandbox (default) or production
//   MPESA_CONSUMER_KEY     from the Daraja portal
//   MPESA_CONSUMER_SECRET  from the Daraja portal
//   MPESA_SHORTCODE        sandbox test shortcode, later your Paybill number
//   MPESA_PASSKEY          sandbox test passkey, later your production passkey
//   MPESA_CALLBACK_SECRET  a long random string (32+ characters) you invent
//   PUBLIC_BASE_URL        https://tencent-ussd.onrender.com (no trailing slash)
//
// NOTE: bookings are kept in memory. They are lost when the server restarts,
// so add a database before relying on this for real money. Every lead and
// every confirmed payment is also sent to you by Telegram/email.
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
// MPESA_BASE_URL exists only so tests can point at a mock server
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

// Accepts 0712345678, 712345678, 254712345678, +254712345678 (and 01xx numbers)
function normalizePhone(raw) {
    let p = String(raw || '').replace(/[\s\-()]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
    else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
    return /^254[17]\d{8}$/.test(p) ? p : null;
}

// In-memory stores
const bookings = new Map();      // booking id -> booking
const byCheckout = new Map();    // CheckoutRequestID -> booking
const phoneAttempts = new Map(); // phone -> [timestamps]

function phoneAttemptAllowed(phone) {
    const now = Date.now();
    const recent = (phoneAttempts.get(phone) || []).filter(t => now - t < 60 * 60 * 1000);
    if (recent.length >= 3) { phoneAttempts.set(phone, recent); return false; }
    recent.push(now);
    phoneAttempts.set(phone, recent);
    return true;
}

// Tidy old data every 30 minutes
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

// Daraja timestamps are YYYYMMDDHHmmss in Nairobi time (UTC+3)
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
        // Path avoids words like "mpesa"/"safaricom", which Safaricom may reject in callback URLs
        CallBackURL: `${MPESA.publicBaseUrl}/payments/cb/${MPESA.callbackSecret}`,
        AccountReference: booking.accountRef,   // max 12 chars; shows as the Paybill account number
        TransactionDesc: 'Survey fee'
    });
    if (String(data.ResponseCode) !== '0') throw new Error(data.ResponseDescription || 'STK push was rejected');
    return data; // contains MerchantRequestID and CheckoutRequestID
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

async function markPaid(booking, receipt, verified) {
    if (booking.status === 'paid') return;   // idempotent: duplicate callbacks do nothing
    booking.status = 'paid';
    booking.receipt = receipt || '';
    booking.paidAt = Date.now();
    await notify(`✅ PAID: ${booking.service} - ${booking.name}`, bookingFields(booking, {
        'M-Pesa receipt': receipt || '(see M-Pesa statement, match the Reference)',
        Verified: verified ? 'Yes, confirmed with Safaricom' : 'Callback only (status query was unavailable)'
    }));
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

    // The amount paid must match the price we asked for
    if (Number(meta('Amount')) !== booking.amount) {
        booking.status = 'review';
        await notify(`⚠️ CHECK PAYMENT: amount mismatch for ${booking.name}`, bookingFields(booking, {
            'Amount reported by callback': String(meta('Amount')),
            'M-Pesa receipt': receipt
        }));
        return;
    }

    // Do not trust the callback alone: ask Safaricom directly
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

// Safaricom calls this when the customer pays, cancels or times out.
// The secret in the URL stops strangers from posting fake "payments".
app.post('/payments/cb/:secret', (req, res) => {
    const given = Buffer.from(String(req.params.secret));
    const expected = Buffer.from(String(MPESA.callbackSecret || ''));
    const ok = expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.sendStatus(404);

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });   // answer fast, process after
    handleCallback(req.body).catch(err => console.error('Callback handling error:', err.message));
});

// The "Check your phone" page polls this. If the callback never arrives
// (for example the server was asleep), it asks Safaricom directly.
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
        } catch (_) { /* still processing, or temporarily unavailable: stay pending */ }
    }
    res.json({ status: b.status });
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
                .intro-text { font-size: 1.1rem; color: #e2e8f0; margin-bottom: 25px; border-left: 3px solid var(--primary); padding-left: 15px; }
                
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

// 1. Home Page (Includes Form #2: Quick Callback / Inquiry Form)
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

// Handle Callback Submission (emails you instantly)
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

// 6. Solar Page (Includes Form #3: Solar Load & Battery Sizing Form)
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

        <h3>How we size it</h3>
        <p>We add up the power of each device, estimate the hours you use it, and size the batteries and panels to cover that load with room to grow. You see the numbers before you decide.</p>

        <div class="form-container">
            <h3 style="margin-top:0; color:#38bdf8;">Solar Load & Battery Sizing Request</h3>
            <p style="color:var(--muted); font-size:0.95rem;">Select your required equipment to get a custom sizing estimate.</p>
            <form action="/submit-solar" method="POST">
                <div class="form-group">
                    <label>Property Type</label>
                    <select name="propertyType">
                        <option value="Home">Home</option>
                        <option value="Shop">Shop / Business</option>
                        <option value="School">School / Institution</option>
                        <option value="Rental Compound">Rental Compound</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Equipment to Power (Check all that apply):</label>
                    <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 5px; color: #f1f5f9;">
                        <label><input type="checkbox" name="equipment" value="Lights"> Lights & Phone Charging</label>
                        <label><input type="checkbox" name="equipment" value="Router"> WiFi Router / Internet</label>
                        <label><input type="checkbox" name="equipment" value="CCTV"> CCTV Cameras</label>
                        <label><input type="checkbox" name="equipment" value="Fridge"> Refrigerator / Fridge</label>
                    </div>
                </div>
                <div class="form-group">
                    <label>Required Backup Duration</label>
                    <select name="duration">
                        <option value="4 Hours">4 Hours (Basic Outage)</option>
                        <option value="8 Hours">8 Hours (Extended)</option>
                        <option value="24/7 Off-Grid">24/7 Full Off-Grid</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Phone Number (M-Pesa)</label>
                    <input type="tel" name="phone" required placeholder="e.g. 0712345678">
                </div>
                <button type="submit" class="cta-btn">Calculate & Get Solar Quote</button>
            </form>
        </div>
    `;
    res.send(renderPage({ title: 'Solar Solutions', activeNav: 'solar', content }));
});

// Handle Solar Request Submission (emails you instantly)
app.post('/submit-solar', async (req, res) => {
    const { propertyType, equipment, duration, phone } = req.body;

    await notify(`☀️ Solar request: ${propertyType || 'Unknown'} (${duration || 'n/a'})`, {
        'Property type': propertyType,
        Equipment: equipment,
        'Backup duration': duration,
        Phone: phone
    });

    res.send(renderPage({
        title: 'Solar Sizing Request Received',
        activeNav: 'solar',
        content: `<h2>Solar Analysis in Progress</h2><p class="intro-text">We received your requirements for your <strong>${esc(propertyType)}</strong> with <strong>${esc(duration)}</strong> backup. Our solar engineers will compute your panel sizing and call <strong>${esc(phone)}</strong> with a precise quotation.</p><a href="/solar" class="cta-btn">Back to Solar</a>`
    }));
});

// 7. Surveys Page (Includes Form #1: Direct M-PESA STK Push Booking & Form #4: Site Inspection Booking)
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

        <h3>How it works</h3>
        <ol style="color: #f1f5f9; padding-left: 20px; line-height: 1.8;">
            <li>Book a survey on this website or by USSD, and pay the survey fee by M-Pesa.</li>
            <li>We call you to agree a time.</li>
            <li>An engineer visits and inspects your site.</li>
            <li>You receive the report and quote.</li>
            <li>If you go ahead, we schedule the installation.</li>
        </ol>

        <div class="form-container" style="border-color: var(--accent);">
            <h3 style="margin-top:0; color: var(--accent);">Book Site Survey & Pay via M-Pesa (STK Push)</h3>
            <p style="color:var(--muted); font-size:0.95rem;">Fill in your site details. Submitting will send an M-Pesa prompt to your phone for the fee shown next to the service you choose.</p>
            <form action="/submit-survey-payment" method="POST">
                <div class="form-group">
                    <label>Full Name</label>
                    <input type="text" name="name" required placeholder="e.g. Mary Akinyi">
                </div>
                <div class="form-group">
                    <label>M-Pesa Phone Number</label>
                    <input type="tel" name="phone" required placeholder="0712345678">
                </div>
                <div class="form-group">
                    <label>Service Category</label>
                    <select name="service">
                        <option value="Site Survey & Quotation">General Site Survey (KES 3,000)</option>
                        <option value="WiFi Setup">WiFi & Hotspot Consultation (KES 3,000)</option>
                        <option value="CCTV Installation">CCTV System Assessment (KES 3,000)</option>
                        <option value="Smart Locks">Smart Locks Consultation (KES 2,500)</option>
                        <option value="Electric Fence">Electric Fence Survey (KES 5,000)</option>
                        <option value="Solar Consultation">Solar Consultation & Sizing (KES 4,000)</option>
                    </select>
                    <small style="display:block; margin-top:6px; color:var(--muted);">Prices can change according to the location and urgency. Thank you.</small>
                </div>
                <div class="form-group">
                    <label>Physical Location / Address</label>
                    <input type="text" name="location" required placeholder="e.g. Rangwe Town, Homa Bay">
                </div>
                <p style="color:var(--muted); font-size:0.9rem; margin: 0 0 12px 0;">By booking, you agree to our <a href="/terms" target="_blank" style="color:#38bdf8;">Terms and Conditions</a>.</p>
                <button type="submit" class="cta-btn" style="background: var(--accent); color: #0f172a;">Trigger M-Pesa Payment & Book Survey</button>
            </form>
        </div>
    `;
    res.send(renderPage({ title: 'Surveys & Quotations', activeNav: 'survey', content }));
});

// Handle Survey Booking + M-Pesa STK Push
app.post('/submit-survey-payment', payLimiter, async (req, res) => {
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const name = str(req.body.name).slice(0, 80);
    const location = str(req.body.location).slice(0, 120);
    const service = str(req.body.service);
    const phone = normalizePhone(str(req.body.phone));

    const problem = (message, status = 400) => res.status(status).send(renderPage({
        title: 'Booking Problem',
        activeNav: 'survey',
        content: `<h2>We could not start your payment</h2><p class="intro-text">${esc(message)}</p><a href="/survey" class="cta-btn">Back to Surveys</a>`
    }));

    if (!name || !location) return problem('Please enter your name and location.');
    if (!Object.hasOwn(SERVICE_PRICES, service)) return problem('Please choose a valid service.');
    if (!phone) return problem('Please enter a valid Safaricom number, for example 0712345678.');
    if (!phoneAttemptAllowed(phone)) return problem('Too many payment requests for this number. Please try again later.', 429);

    const id = crypto.randomBytes(8).toString('hex');
    const booking = {
        id, name, phone, service, location,
        amount: SERVICE_PRICES[service],            // price comes from the server, never from the form
        status: 'pending',
        createdAt: Date.now(),
        accountRef: 'TNC' + id.slice(0, 8).toUpperCase()
    };
    bookings.set(id, booking);

    // Tell you about the lead right away, so it is never lost even if payment fails
    notify(`📋 Survey booking (awaiting payment): ${name} - ${service}`, bookingFields(booking))
        .catch(() => {});

    if (!mpesaConfigured()) {
        booking.status = 'failed';
        console.error('M-Pesa is not fully configured (check MPESA_* variables and PUBLIC_BASE_URL).');
        return problem('Online payment is not available right now. We have saved your request and will call you.', 503);
    }

    try {
        const r = await stkPush(booking);
        booking.checkoutRequestId = r.CheckoutRequestID;
        booking.merchantRequestId = r.MerchantRequestID;
        byCheckout.set(r.CheckoutRequestID, booking);
    } catch (err) {
        console.error('STK push failed:', err.message);
        booking.status = 'failed';
        return problem('We could not send the M-Pesa prompt. Please check your number and try again, or call us on 0740 311 014.', 502);
    }

    res.send(renderPage({
        title: 'Check Your Phone',
        activeNav: 'survey',
        content: `
            <h2>Check your phone</h2>
            <p class="intro-text">Thank you, <strong>${esc(name)}</strong>. An M-Pesa prompt for <strong>KES ${booking.amount}</strong> has been sent to <strong>${esc(phone)}</strong>. Enter your M-Pesa PIN to pay.</p>
            <p id="pay-status" class="sub-title">Waiting for your payment...</p>
            <a href="/survey" class="cta-btn">Back to Surveys</a>
            <script>
            (function () {
                var id = ${JSON.stringify(id)}, tries = 0, box = document.getElementById('pay-status');
                function poll() {
                    tries++;
                    fetch('/payments/status/' + id).then(function (r) { return r.json(); }).then(function (d) {
                        if (d.status === 'paid') {
                            box.textContent = 'Payment received. Thank you! An engineer will call you to schedule the visit.';
                        } else if (d.status === 'failed') {
                            box.textContent = 'The payment was cancelled or did not go through. You can go back and try again.';
                        } else if (d.status === 'review') {
                            box.textContent = 'We are confirming your payment and will call you shortly.';
                        } else if (tries < 40) {
                            setTimeout(poll, 4000);
                        } else {
                            box.textContent = 'We have not seen the payment yet. If you paid, we will confirm and call you.';
                        }
                    }).catch(function () {
                        if (tries < 40) setTimeout(poll, 4000);
                    });
                }
                setTimeout(poll, 4000);
            })();
            </script>`
    }));
});

// Terms and Conditions page
app.get('/terms', (req, res) => {
    const content = `
        <div class="terms">
        <h2>Terms and Conditions of Service</h2>
        <p class="sub-title">Tencent Innovations &middot; Rangwe, Homa Bay County, Kenya<br>Calls: 0740 311 014 &middot; WhatsApp: 0769 306 917</p>

        <p class="intro-text">These Terms and Conditions ("Terms") govern the provision of WiFi/internet, CCTV installation, electric fence installation, solar standby system, and fingerprint door lock installation services by Tencent Innovations ("the Company", "we", "us") to any person or entity that subscribes to, purchases, or otherwise uses those services ("the Customer", "you"). By registering for an account, connecting to our network, paying for a package, or signing an installation job card, you agree to be bound by these Terms.</p>

        <h3>1. Definitions</h3>
        <p class="clause"><strong>1.1</strong> "Service" means any of the WiFi/internet access, CCTV installation, electric fence installation, solar standby system, or fingerprint door lock installation services offered by the Company.</p>
        <p class="clause"><strong>1.2</strong> "Package" means a specific data, speed, or duration bundle purchased for internet access, as published by the Company from time to time.</p>
        <p class="clause"><strong>1.3</strong> "Customer Premises Equipment" or "CPE" means routers, antennas, cameras, fence energisers, solar panels, batteries, fingerprint door locks, cabling, and any other hardware installed at the Customer's premises.</p>
        <p class="clause"><strong>1.4</strong> "Hotspot" means the Company's WiFi network accessible via login portal and voucher, PIN, or M-Pesa payment.</p>

        <h3>2. Account Registration</h3>
        <p class="clause"><strong>2.1</strong> Customers must register using accurate name and phone number details. This information is used for billing, support, and network security, and will not be sold to third parties.</p>
        <p class="clause"><strong>2.2</strong> A customer is responsible for keeping their account PIN, voucher codes, and WiFi password confidential. The Company is not liable for usage arising from a shared or leaked password.</p>
        <p class="clause"><strong>2.3</strong> One account and connection are intended for a single household or business premises unless a business/enterprise package has been agreed in writing.</p>

        <h3>3. WiFi and Internet Service</h3>
        <p class="clause"><strong>3.1</strong> Internet access is sold in prepaid Packages (hourly, daily, weekly, or monthly) as displayed on the Hotspot login page or communicated by the Company. Prices may be revised from time to time; the price in effect at the moment of payment applies to that purchase.</p>
        <p class="clause"><strong>3.2</strong> Payment is made via M-Pesa STK Push or such other method as the Company may enable. A Package activates automatically once payment is confirmed, and its allocated time or data begins running from activation, whether or not the Customer is actively using the connection.</p>
        <p class="clause"><strong>3.3</strong> Packages are non-refundable and non-transferable once activated, save for cases of a confirmed technical fault on the Company's network, at the Company's discretion.</p>
        <p class="clause"><strong>3.4</strong> Speeds advertised (e.g. "up to" a stated Mbps) are maximum attainable speeds under ideal conditions. Actual speed may vary with the number of concurrent users, device capability, weather, and upstream network conditions, and is not guaranteed.</p>
        <p class="clause"><strong>3.5</strong> The Company operates a Fair Use Policy. Unlimited or bundled Packages are intended for normal browsing, streaming, communication, and work use by the registered premises. Sustained heavy use that materially degrades service for other customers (for example commercial-scale reselling, large-scale server hosting, or automated bulk downloading) may be throttled, or the Customer moved to a suitable business package, after notice where practicable.</p>
        <p class="clause"><strong>3.6</strong> The Customer may not resell, rebroadcast, or share the Hotspot connection with persons outside the registered premises without a prior written reseller or hotspot-sharing agreement with the Company.</p>
        <p class="clause"><strong>3.7</strong> WiFi/internet installations are currently offered within Rangwe and its immediate environs, within the Company's normal service radius from its base station. Requests for WiFi installation outside this area will be assessed individually and may not be available.</p>

        <h3>4. Acceptable Use</h3>
        <p class="clause">The Service may not be used to:</p>
        <ul>
            <li>Transmit, host, or access content that is illegal under the laws of Kenya, including material that infringes copyright, is defamatory, obscene, or promotes violence or hatred;</li>
            <li>Attempt to gain unauthorised access to the Company's network, another customer's account, or any third-party system;</li>
            <li>Distribute malware, run port scans, flood the network, or otherwise disrupt Service for other users;</li>
            <li>Impersonate another person or misrepresent your affiliation in connection with the Service.</li>
        </ul>
        <p class="clause">A breach of this clause entitles the Company to suspend or terminate access immediately, without refund, and to report unlawful activity to the relevant authorities.</p>

        <h3>5. Equipment (CPE)</h3>
        <p class="clause"><strong>5.1</strong> Where the Company supplies and installs equipment (router, antenna, CCTV camera, fence energiser, solar panel, battery, or fingerprint door lock), ownership of that equipment remains with the Company until it has been fully paid for, unless otherwise agreed in writing.</p>
        <p class="clause"><strong>5.2</strong> The Customer must provide a safe mounting location, stable power supply, and reasonable access for installation and future maintenance.</p>
        <p class="clause"><strong>5.3</strong> The Customer is responsible for equipment once installed and accepted, and must promptly report any fault, damage, or tampering. Damage caused by the Customer, third parties, lightning, rodents, theft, or vandalism is not covered by any workmanship warranty and may attract a call-out and repair or replacement fee.</p>
        <p class="clause"><strong>5.4</strong> Where a device remains the Company's property under an instalment or lease arrangement, the Customer may not relocate, resell, or allow a third party to tamper with it without the Company's written consent.</p>
        <p class="clause"><strong>5.5</strong> Where the Customer supplies their own equipment for use with the Service (for example, a Customer-owned router under a Commercial/Rental WiFi installation), that equipment remains the Customer's property at all times, and the Company's equipment ownership terms and workmanship warranty apply only to hardware supplied and installed by the Company.</p>

        <h3>6. Installation Services (CCTV, Electric Fence, Solar Standby, Fingerprint Door Locks)</h3>
        <p class="clause"><strong>6.1</strong> A site assessment may be carried out before a quotation is confirmed. Quoted costs are based on the site conditions observed at assessment; material changes discovered on the installation day (for example additional cabling distance, wall type, or wiring condition) may adjust the final cost, which will be communicated to the Customer before proceeding.</p>
        <p class="clause"><strong>6.2</strong> Workmanship is warranted for a period agreed at the time of installation and stated on the job card or invoice. This workmanship warranty does not cover damage from power surges, lightning, water damage, unauthorised modification, or normal wear and tear. Equipment manufacturer warranties, where applicable, are handled in line with the manufacturer's own terms.</p>
        <p class="clause"><strong>6.3</strong> CCTV and electric fence systems are deterrent and monitoring aids, and fingerprint door locks are an access-control aid. The Company does not guarantee that any installed system will prevent theft, break-in, injury, or loss, and accepts no liability for such incidents.</p>
        <p class="clause"><strong>6.4</strong> Solar standby systems are sized to the load and backup duration agreed with the Customer at the point of sale. Connecting additional appliances beyond the agreed load may reduce backup duration or damage the system, and is done at the Customer's own risk.</p>
        <p class="clause"><strong>6.5</strong> CCTV, electric fence, solar standby, and fingerprint door lock installation services are offered nationwide across Kenya, subject to logistics and travel costs for sites outside the Company's normal service radius, communicated to the Customer at the point of quotation.</p>
        <p class="clause"><strong>6.6</strong> Fingerprint door locks are powered by internal batteries. The Customer is responsible for replacing batteries as needed and for keeping any backup mechanical key or master code safe. Loss of access due to depleted batteries, lost backup keys or codes, or manufacturer firmware issues is not covered by the workmanship warranty.</p>

        <h3>7. Service Availability</h3>
        <p class="clause"><strong>7.1</strong> The Company takes reasonable technical measures to keep the network available but does not guarantee uninterrupted, error-free service. Outages may occur due to power interruptions, upstream provider faults, adverse weather, equipment failure, or scheduled maintenance.</p>
        <p class="clause"><strong>7.2</strong> Where practical, the Company will give advance notice of planned maintenance that is expected to interrupt Service.</p>
        <p class="clause"><strong>7.3</strong> The Company is not liable for losses arising from Service interruption, including business losses, except where caused by the Company's proven negligence.</p>

        <h3>8. Suspension and Termination</h3>
        <p class="clause"><strong>8.1</strong> The Company may suspend or terminate Service for non-payment, breach of these Terms, unlawful use, or where continued connection poses a risk to the network or other customers.</p>
        <p class="clause"><strong>8.2</strong> A Customer may discontinue Service at any time; Packages already paid for are consumed as described in Clause 3.3 and are not refunded on voluntary discontinuation.</p>
        <p class="clause"><strong>8.3</strong> Where equipment remains the Company's property, the Company may retrieve it on termination of an instalment or lease arrangement, giving reasonable notice to the Customer.</p>
        <p class="clause"><strong>8.4</strong> Upon termination of Service, any Customer-supplied equipment remains the property of the Customer, except the outdoor LiteBeam (LBE) CPE unit, which remains the property of the Company and will be retrieved regardless of who originally supplied or paid for it.</p>

        <h3>9. Limitation of Liability</h3>
        <p class="clause"><strong>9.1</strong> To the extent permitted by law, the Company's total liability for any claim arising from the Service is limited to the amount paid by the Customer for the specific Service giving rise to the claim in the preceding three months.</p>
        <p class="clause"><strong>9.2</strong> The Company is not liable for indirect, incidental, or consequential loss, including loss of income, data, or business opportunity.</p>

        <h3>10. Privacy</h3>
        <p class="clause"><strong>10.1</strong> Customer information collected at registration is used for billing, service delivery, and support, and is kept confidential save where disclosure is required by law or necessary to enforce these Terms.</p>

        <h3>11. Amendments</h3>
        <p class="clause"><strong>11.1</strong> The Company may update these Terms from time to time. Material changes will be communicated through the Hotspot login page, SMS, WhatsApp, or notices at the Company's office. Continued use of the Service after a change takes effect constitutes acceptance of the revised Terms.</p>

        <h3>12. Governing Law</h3>
        <p class="clause"><strong>12.1</strong> These Terms are governed by the laws of Kenya. Any dispute that cannot be resolved amicably between the parties shall be subject to the jurisdiction of the Kenyan courts.</p>

        <h3>13. Contact</h3>
        <p class="clause"><strong>13.1</strong> For billing, support, or installation enquiries, contact Tencent Innovations on Calls 0740 311 014, WhatsApp 0769 306 917, or visit the office in Rangwe, Homa Bay County.</p>

        <a href="/" class="cta-btn" style="margin-top:30px;">Back to Home</a>
        </div>
    `;
    res.send(renderPage({ title: 'Terms and Conditions', activeNav: '', content }));
});

// 8. USSD Endpoint
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
(Prices can change by location & urgency)
1. Confirm & Pay via M-PESA`;
    } else if (text === '2') {
        response = `CON CCTV Survey: KES 3,000
(Prices can change by location & urgency)
1. Confirm & Pay via M-PESA`;
    } else if (text === '3') {
        response = `CON Smart Locks Consultation: KES 2,500
(Prices can change by location & urgency)
1. Confirm & Pay via M-PESA`;
    } else if (text === '4') {
        response = `CON Electric Fence Survey: KES 5,000
(Prices can change by location & urgency)
1. Confirm & Pay via M-PESA`;
    } else if (text === '5') {
        response = `CON Solar Consultation: KES 4,000
(Prices can change by location & urgency)
1. Confirm & Pay via M-PESA`;
    } else if (text === '6') {
        response = `CON Site Survey: KES 3,000
(Prices can change by location & urgency)
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
app.listen(PORT, () => console.log(`Tencent Innovations server with interactive forms running on port ${PORT}`));
