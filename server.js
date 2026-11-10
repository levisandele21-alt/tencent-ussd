'use strict';
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

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.message ? err.message : err));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Render sits in front of the app

// ---------------------------------------------------------------
// 0. Settings
// ---------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const LINK_SECRET = process.env.LINK_SECRET || '';   // must be its own secret, never the M-Pesa callback secret
const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (LINK_SECRET.length < 16) console.error('LINK_SECRET is missing or shorter than 16 characters: shareable booking links are switched off.');
if (SESSION_SECRET.length < 32) console.error('SESSION_SECRET is missing or shorter than 32 characters: everyone is logged out whenever the server restarts. Add a long random value in Render.');

// ---------------------------------------------------------------
// 1. Small helpers
// ---------------------------------------------------------------
function esc(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
const flat = value => (Array.isArray(value) ? value.join(', ') : (value || ''));
const str = v => (typeof v === 'string' ? v.trim() : '');
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);   // Express 4 does not catch async errors by itself

// Only plain image/video files in the project folder are public. Source code, package.json and
// any key or .env file are never served.
const PUBLIC_FILE = /^\/[A-Za-z0-9_.-]+\.(png|jpe?g|gif|webp|svg|ico|mp4|webm)$/i;
const staticFiles = express.static(__dirname, { dotfiles: 'ignore', index: false, redirect: false, maxAge: '1h' });

// The logo file name has been wrong before (double extension), so find it instead of hard-coding it
let LOGO_FILE = '';
try {
    const images = fs.readdirSync(__dirname).filter(f => /\.(png|jpe?g|webp|svg)$/i.test(f) && /logo/i.test(f));
    LOGO_FILE = images.find(f => /^tencent/i.test(f)) || images[0] || '';
} catch (_) { /* no logo, the site still works */ }
let HERO_VIDEO = false;
try { HERO_VIDEO = fs.existsSync(path.join(__dirname, 'hero.mp4')); } catch (_) { /* optional */ }

// ---------------------------------------------------------------
// 2. Security headers (with a Content-Security-Policy) and public files
// ---------------------------------------------------------------
app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    req.nonce = res.locals.nonce;
    next();
});
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            mediaSrc: ["'self'"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: null
        }
    }
}));

app.use((req, res, next) => {
    if (req.method === 'GET' && PUBLIC_FILE.test(req.path)) return staticFiles(req, res, next);
    next();
});
app.get('/brand-logo', (req, res, next) => {
    if (!LOGO_FILE) return next();
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, LOGO_FILE), err => { if (err && !res.headersSent) next(); });
});

// ---------------------------------------------------------------
// 3. Rate limits (before the session, so floods never reach the database)
// ---------------------------------------------------------------
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests from this network, please try again later.',
    skip: req => req.path.startsWith('/payments/cb/') || req.path.startsWith('/payments/status/')
});
const statusLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false, message: { status: 'unknown' } });
const payLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: 'Too many payment attempts from this network. Please try again later.'
});
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: 'Too many sign-up attempts from this network. Please try again later.'
});
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    skipSuccessfulRequests: true,   // only failed logins count
    message: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.'
});
const resendLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: 'Too many email requests. Please try again later.' });
app.use(limiter);

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

// ---------------------------------------------------------------
// 4. Database (PostgreSQL)
// ---------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL || '';
const dbEnabled = Boolean(DATABASE_URL);
let pool = null;
let dbReady = false;

if (dbEnabled) {
    let host = '';
    try { host = new URL(DATABASE_URL).hostname; } catch (_) { /* pg reports a bad URL itself */ }
    const sslMode = (process.env.DATABASE_SSL || '').toLowerCase();
    let ssl;
    if (sslMode === 'off') ssl = false;
    else if (sslMode === 'insecure') ssl = { rejectUnauthorized: false };   // only if your provider's certificate cannot be verified
    else if (host === 'localhost' || host === '127.0.0.1' || (host && !host.includes('.'))) ssl = false;   // local, or Render's internal address
    else ssl = { rejectUnauthorized: true };
    pool = new Pool({ connectionString: DATABASE_URL, ssl, max: 8, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    pool.on('error', err => console.error('Database pool error:', err.message));
} else {
    console.error('DATABASE_URL is not set: sign-in, bookings and receipts are switched off until you add it.');
}

async function initDb() {
    if (!dbEnabled) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(50) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
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
            )`);
        // Added later: safe to run on a database that already has the older tables
        const had = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'receipt_sent'`);
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_sent BOOLEAN NOT NULL DEFAULT FALSE`);
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE`);
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS email_status VARCHAR(300)`);
        // Price breakdown (older bookings keep these empty and show only the total)
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS base_amount INT`);
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS travel_km INT`);
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS travel_fee INT`);
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS urgency VARCHAR(20)`);
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS urgency_fee INT`);
        await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS geo VARCHAR(40)`);
        if (!had.rowCount) {
            // First run of this version: receipts for payments that were already made are not re-sent
            await pool.query(`UPDATE bookings SET receipt_sent = TRUE WHERE status = 'paid'`);
        }
        await pool.query('CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings (user_id, created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS bookings_checkout_idx ON bookings (checkout_request_id)');
        // Uniqueness: skipped (with a warning) only if old data already contains duplicates
        for (const sql of [
            'CREATE UNIQUE INDEX IF NOT EXISTS bookings_account_ref_uq ON bookings (account_ref)',
            'CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (lower(email))'
        ]) {
            try { await pool.query(sql); } catch (e) { console.error('Could not add a unique index (old duplicate data?):', e.message); }
        }
        dbReady = true;
        console.log('PostgreSQL tables initialized successfully.');
    } catch (err) {
        dbReady = false;
        console.error('Database initialization error, trying again in 15 seconds:', err.message);
        setTimeout(() => initDb(), 15000).unref();
    }
}

// ---------------------------------------------------------------
// 5. Sessions
// ---------------------------------------------------------------
app.use(session({
    store: dbEnabled ? new pgSession({ pool, tableName: 'session', createTableIfMissing: true, errorLog: e => console.error('Session store error:', e.message) }) : undefined,
    name: 'tc.sid',
    secret: SESSION_SECRET.length >= 32 ? SESSION_SECRET : crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,   // visitors who never log in get no cookie
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto',   // secure whenever the request came over HTTPS (Render), without needing NODE_ENV
        maxAge: 14 * 24 * 60 * 60 * 1000
    }
}));

app.use((req, res, next) => {
    res.locals.user = (req.session && req.session.user) || null;
    next();
});

// Reject form posts that come from other websites (CSRF). Browsers always say where a form came from;
// cookies are also SameSite=Lax. Safaricom's callback is a machine call and is exempt.
app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path.startsWith('/payments/cb/')) return next();
    const fetchSite = req.get('sec-fetch-site');
    const origin = req.get('origin');
    let blocked = false;
    if (fetchSite) {
        // Modern browsers say exactly how the request relates to this site, so trust that and skip host comparisons
        blocked = fetchSite === 'cross-site';
    } else if (origin) {
        // Older browsers: compare the Origin with every name this site is reached by (Render, custom domain, proxy)
        const allowed = new Set([req.get('host'), req.get('x-forwarded-host')].filter(Boolean).map(h => h.split(',')[0].trim().toLowerCase()));
        try { allowed.add(new URL(PUBLIC_BASE_URL).host.toLowerCase()); } catch (_) { /* not set */ }
        try { blocked = !allowed.has(new URL(origin).host.toLowerCase()); } catch (_) { blocked = true; }
    }
    if (blocked) return errorPage(req, res, 403, 'Request blocked', 'This request came from another website, so it was blocked.');
    next();
});

const BCRYPT_COST = 11;
const DUMMY_HASH = bcrypt.hashSync('this-is-not-a-real-password', BCRYPT_COST);   // compared when the email is unknown, so timing does not reveal which emails exist
const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// Only go back to our own pages after login (stops //evil.com style redirects)
const NEXT_ALLOWED = new Set(['/', '/wifi', '/cctv', '/smart-locks', '/electric-fence', '/solar', '/survey', '/requests', '/terms', '/contact']);
function safeNext(value) {
    const v = typeof value === 'string' ? value : '';
    if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/survey';
    const pathOnly = v.split('?')[0].split('#')[0];
    return NEXT_ALLOWED.has(pathOnly) ? pathOnly : '/survey';
}

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    if (req.method === 'GET') return res.redirect('/login?next=' + encodeURIComponent(safeNext(req.path)));
    return res.redirect('/login');
}
function requireDb(req, res, next) {
    if (dbReady) return next();
    return errorPage(req, res, 503, 'Please try again shortly', dbEnabled
        ? 'Our booking system is starting up. Please try again in a minute.'
        : 'Accounts are not switched on yet. Please call us on 0740 311 014.');
}
const regenerateSession = req => new Promise((resolve, reject) => req.session.regenerate(err => (err ? reject(err) : resolve())));
const saveSession = req => new Promise((resolve, reject) => req.session.save(err => (err ? reject(err) : resolve())));

// ---------------------------------------------------------------
// 6. Email (receipts and alerts) and Telegram
// ---------------------------------------------------------------
// Render's free plan blocks normal email (SMTP), so the main route is Brevo, which works over HTTPS:
//   BREVO_API_KEY, MAIL_FROM_EMAIL (verified sender in Brevo), MAIL_FROM_NAME (optional)
// Gmail (GMAIL_USER + GMAIL_APP_PASSWORD) still works as a fallback on plans that allow SMTP.
const MAIL = {
    brevoKey: process.env.BREVO_API_KEY || '',
    brevoUrl: process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email',   // BREVO_API_URL exists so tests can use a mock
    fromEmail: process.env.MAIL_FROM_EMAIL || process.env.GMAIL_USER || '',
    fromName: process.env.MAIL_FROM_NAME || 'Tencent Innovations',
    adminTo: process.env.NOTIFY_TO || process.env.MAIL_FROM_EMAIL || process.env.GMAIL_USER || ''
};
let smtp = null;
function getSmtp() {
    if (!smtp && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
        smtp = nodemailer.createTransport({
            service: 'gmail',
            connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000,
            auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
        });
    }
    return smtp;
}

// attachments: [{ filename, content: Buffer, contentType }]
async function sendMail({ to, subject, html, text, attachments = [] }) {
    if (MAIL.brevoKey && MAIL.fromEmail) {
        const body = { sender: { name: MAIL.fromName, email: MAIL.fromEmail }, to: [{ email: to }], subject, htmlContent: html, textContent: text };
        if (attachments.length) body.attachment = attachments.map(a => ({ name: a.filename, content: a.content.toString('base64') }));
        const resp = await fetch(MAIL.brevoUrl, {
            method: 'POST',
            headers: { 'api-key': MAIL.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000)
        });
        if (!resp.ok) throw new Error(`Brevo HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        return 'brevo';
    }
    const transport = getSmtp();
    if (transport) {
        await transport.sendMail({
            from: `"${MAIL.fromName}" <${process.env.GMAIL_USER}>`, to, subject, html, text,
            attachments: attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
        });
        return 'smtp';
    }
    throw new Error('No email service is set up (add BREVO_API_KEY and MAIL_FROM_EMAIL in Render)');
}

// Alerts to YOU only (Telegram + email). Customers never receive these.
async function notify(subject, fields) {
    const cleanSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 150);
    const rows = Object.entries(fields).map(([label, val]) => {
        const safe = esc(flat(val));
        const display = /^https:\/\//.test(safe) ? `<a href="${safe}">Tap to open</a>`
            : /phone/i.test(label) ? `<a href="tel:${safe}">${safe}</a>` : safe;
        return `<p><strong>${esc(label)}:</strong> ${display}</p>`;
    }).join('');
    const time = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

    // The log says what happened but not who, so customer details do not pile up in Render's logs
    console.log('LEAD:', cleanSubject.split(/[:-]/)[0].trim(), time);

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
        if (!MAIL.adminTo) return;
        await sendMail({
            to: MAIL.adminTo,
            subject: cleanSubject,
            html: `<h3>${esc(cleanSubject)}</h3>${rows}<p style="color:#888">Received ${esc(time)} (EAT)</p>`,
            text: `${cleanSubject}\n\n${Object.entries(fields).map(([l, v]) => `${l}: ${flat(v)}`).join('\n')}\n\n${time} (EAT)`
        });
    };
    const results = await Promise.allSettled([sendTelegram(), sendAdminEmail()]);
    if (results[0].status === 'rejected') console.error('Telegram failed:', results[0].reason && results[0].reason.message);
    if (results[1].status === 'rejected') console.error('Admin email failed:', results[1].reason && results[1].reason.message);
}

// ---------------------------------------------------------------
// 7. M-Pesa (Daraja)
// ---------------------------------------------------------------
const MPESA = {
    production: process.env.MPESA_ENV === 'production',
    key: process.env.MPESA_CONSUMER_KEY,
    secret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    callbackSecret: process.env.MPESA_CALLBACK_SECRET,
    publicBaseUrl: PUBLIC_BASE_URL
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

// Prices are set here on the server and never taken from the form
const SERVICE_PRICES = {
    'Site Survey & Quotation': 3000,
    'WiFi Setup': 3000,
    'CCTV Installation': 3000,
    'Smart Locks': 2500,
    'Electric Fence': 5000,
    'Solar Consultation': 4000
};

// ---------------------------------------------------------------
// Location- and urgency-based pricing
// The service price above is the base fee. A travel fare (by distance from Rangwe) and an
// urgency fee are added on top. Everything is worked out here on the server, never in the browser.
// Change the numbers in Render (Environment) without touching the code:
//   TRAVEL_FREE_KM        km from Rangwe that carry no travel fare            (default 5)
//   TRAVEL_RATE_PER_KM    KES charged for each km beyond the free distance    (default 40)
//   TRAVEL_MAX_KM         furthest distance bookable online                   (default 80)
//   URGENCY_NEXT_DAY_FEE  extra KES for next-day service                      (default 500)
//   URGENCY_SAME_DAY_FEE  extra KES for same-day service                      (default 1000)
// ---------------------------------------------------------------
const envNum = (name, fallback) => {
    const v = Number(process.env[name]);
    return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) && v >= 0 ? v : fallback;
};
const PRICING = {
    base: { lat: -0.6003, lng: 34.5835 },   // Rangwe
    roadFactor: 1.3,                          // roads are longer than the straight line
    roundTo: 50,                              // travel fare is rounded up to the next KES 50
    freeKm: envNum('TRAVEL_FREE_KM', 5),
    ratePerKm: envNum('TRAVEL_RATE_PER_KM', 40),
    maxKm: envNum('TRAVEL_MAX_KM', 80),
    urgency: {
        standard: { label: 'Standard (within the week)', fee: 0 },
        'next-day': { label: 'Next day', fee: envNum('URGENCY_NEXT_DAY_FEE', 500) },
        'same-day': { label: 'Same day', fee: envNum('URGENCY_SAME_DAY_FEE', 1000) }
    }
};
// For customers who do not want to share their phone location. Coordinates are approximate town centres.
const PLACES = {
    rangwe: { label: 'Rangwe town', lat: -0.6003, lng: 34.5835 },
    'homa-bay': { label: 'Homa Bay town', lat: -0.5273, lng: 34.4571 },
    'kendu-bay': { label: 'Kendu Bay', lat: -0.3603, lng: 34.6439 },
    oyugis: { label: 'Oyugis', lat: -0.5078, lng: 34.7358 },
    rongo: { label: 'Rongo', lat: -0.7567, lng: 34.6 },
    mbita: { label: 'Mbita', lat: -0.4219, lng: 34.2022 },
    kisumu: { label: 'Kisumu', lat: -0.0917, lng: 34.7679 }
};
function distanceKm(lat, lng) {
    const rad = d => d * Math.PI / 180;
    const dLat = rad(lat - PRICING.base.lat), dLng = rad(lng - PRICING.base.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(PRICING.base.lat)) * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2;
    return Math.ceil(2 * 6371 * Math.asin(Math.sqrt(a)) * PRICING.roadFactor);
}
// input: { service, urgency, place, lat, lng } straight from the form. Returns { ok:true, ... } or { ok:false, error }.
function computeQuote(input) {
    const service = String(input.service || '');
    if (!Object.hasOwn(SERVICE_PRICES, service)) return { ok: false, error: 'Please choose a valid service.' };
    const urgencyKey = Object.hasOwn(PRICING.urgency, input.urgency) ? input.urgency : 'standard';
    let lat = Number(input.lat), lng = Number(input.lng);
    let source = 'gps';
    if (input.lat === undefined || input.lat === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        const place = Object.hasOwn(PLACES, input.place) ? PLACES[input.place] : null;
        if (!place) return { ok: false, error: 'Please choose your area or share your location so we can work out the travel fare.' };
        lat = place.lat; lng = place.lng; source = 'area';
    }
    const km = distanceKm(lat, lng);
    if (km > PRICING.maxKm) return { ok: false, error: `That location is about ${km} km from Rangwe, which is too far to book online. Please call us on 0740 311 014 for a quote.` };
    const chargeable = Math.max(0, km - PRICING.freeKm);
    const travel = chargeable === 0 ? 0 : Math.ceil(chargeable * PRICING.ratePerKm / PRICING.roundTo) * PRICING.roundTo;
    const base = SERVICE_PRICES[service];
    const urgencyFee = PRICING.urgency[urgencyKey].fee;
    return {
        ok: true, service, urgency: urgencyKey, urgencyLabel: PRICING.urgency[urgencyKey].label, source,
        lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)),
        km, base, travel, urgencyFee, total: base + travel + urgencyFee
    };
}

function normalizePhone(raw) {
    let p = String(raw || '').replace(/[\s\-()]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
    else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
    return /^254[17]\d{8}$/.test(p) ? p : null;
}

const phoneAttempts = new Map();     // phone -> [timestamps]
const lastStatusQuery = new Map();   // booking id -> when we last asked Safaricom
function phoneAttemptAllowed(phone) {
    const now = Date.now();
    const recent = (phoneAttempts.get(phone) || []).filter(t => now - t < 60 * 60 * 1000);
    if (recent.length >= 3) { phoneAttempts.set(phone, recent); return false; }
    recent.push(now);
    phoneAttempts.set(phone, recent);
    return true;
}
setInterval(() => {   // tidy the in-memory maps so they cannot grow forever
    const now = Date.now();
    for (const [p, arr] of phoneAttempts) {
        const recent = arr.filter(t => now - t < 60 * 60 * 1000);
        if (recent.length) phoneAttempts.set(p, recent); else phoneAttempts.delete(p);
    }
    for (const [id, t] of lastStatusQuery) if (now - t > 60 * 60 * 1000) lastStatusQuery.delete(id);
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
    tokenCache = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000 };
    return tokenCache.value;
}
const darajaTimestamp = () => new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
const darajaPassword = ts => Buffer.from(`${MPESA.shortcode}${MPESA.passkey}${ts}`).toString('base64');

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
        if (resp.status === 401) tokenCache = { value: null, expiresAt: 0 };
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
        AccountReference: booking.accountRef,   // max 12 characters
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

// ---------------------------------------------------------------
// 8. Bookings in the database
// ---------------------------------------------------------------
// One shape used everywhere (the database uses snake_case, the code uses camelCase)
function rowToBooking(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        name: r.name,
        email: r.email || '',
        phone: r.phone,
        service: r.service,
        location: r.location,
        amount: Number(r.amount),
        status: r.status,
        accountRef: r.account_ref,
        checkoutRequestId: r.checkout_request_id || '',
        receipt: r.receipt || '',
        createdAt: Number(r.created_at),
        paidAt: r.paid_at ? Number(r.paid_at) : null,
        receiptSent: Boolean(r.receipt_sent),
        verified: Boolean(r.verified),
        baseAmount: r.base_amount == null ? null : Number(r.base_amount),
        travelKm: r.travel_km == null ? null : Number(r.travel_km),
        travelFee: r.travel_fee == null ? null : Number(r.travel_fee),
        urgency: r.urgency || '',
        urgencyFee: r.urgency_fee == null ? null : Number(r.urgency_fee),
        geo: r.geo || ''
    };
}
const BOOKING_SELECT = `SELECT b.*, COALESCE(u.email, '') AS email FROM bookings b LEFT JOIN users u ON u.id = b.user_id`;
const getBooking = async id => rowToBooking((await pool.query(`${BOOKING_SELECT} WHERE b.id = $1`, [id])).rows[0]);
const getBookingByCheckout = async cid => rowToBooking((await pool.query(`${BOOKING_SELECT} WHERE b.checkout_request_id = $1`, [cid])).rows[0]);
const getBookingForUser = async (id, userId) => rowToBooking((await pool.query(`${BOOKING_SELECT} WHERE b.id = $1 AND b.user_id = $2`, [id, userId])).rows[0]);
const listBookings = async userId => (await pool.query(`${BOOKING_SELECT} WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 100`, [userId])).rows.map(rowToBooking);
const validBookingId = id => /^[0-9a-f-]{8,64}$/i.test(String(id || ''));

function bookingFields(b, extra = {}) {
    return {
        Name: b.name,
        Phone: b.phone,
        Email: b.email || '',
        Service: b.service,
        Location: b.location,
        Amount: `KES ${b.amount}`,
        ...(b.baseAmount == null ? {} : {
            'Service fee': `KES ${b.baseAmount}`,
            'Travel fare': `KES ${b.travelFee || 0} (about ${b.travelKm} km from Rangwe)`,
            Urgency: `${b.urgency || 'standard'}${b.urgencyFee ? ' (+KES ' + b.urgencyFee + ')' : ''}`
        }),
        ...(b.geo ? { 'Map pin': `https://www.google.com/maps?q=${b.geo}` } : {}),
        Reference: b.accountRef,
        ...extra
    };
}

// Lines like "Base fee: KES 3,000" for receipts, emails and pages. Empty for bookings made before this feature.
function breakdownLines(b) {
    if (b.baseAmount == null) return [];
    const kes = n => 'KES ' + Number(n).toLocaleString('en-KE');
    const lines = [['Service fee', kes(b.baseAmount)]];
    lines.push([`Travel fare${b.travelKm != null ? ' (about ' + b.travelKm + ' km from Rangwe)' : ''}`, b.travelFee ? kes(b.travelFee) : 'Free']);
    const u = PRICING.urgency[b.urgency];
    if (b.urgencyFee) lines.push([`Urgency (${u ? u.label : b.urgency})`, kes(b.urgencyFee)]);
    return lines;
}

// ---------------------------------------------------------------
// 9. Booking links: they carry only the booking id and a signature.
//    The page always reads the real details from the database,
//    so a link can never be edited into a fake receipt.
// ---------------------------------------------------------------
const linksEnabled = () => LINK_SECRET.length >= 16 && PUBLIC_BASE_URL.startsWith('https://');
const signId = id => crypto.createHmac('sha256', LINK_SECRET).update('booking:' + id).digest('base64url');
function makeBookingLink(b) {
    if (!linksEnabled()) return '';
    return `${PUBLIC_BASE_URL}/booking/${b.id}.${signId(b.id)}`;
}
function readBookingLink(token) {
    if (LINK_SECRET.length < 16) return null;
    const t = String(token || '');
    const dot = t.lastIndexOf('.');
    if (dot < 1) return null;
    const id = t.slice(0, dot);
    if (!validBookingId(id)) return null;
    const given = Buffer.from(t.slice(dot + 1));
    const expected = Buffer.from(signId(id));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return id;
}

// ---------------------------------------------------------------
// 10. PDF receipt
// ---------------------------------------------------------------
// The built-in PDF fonts only cover Latin characters, so anything else becomes "?"
const pdfText = v => String(v == null ? '' : v)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E¡-ÿ]/g, '?');

function generatePdfBuffer(b) {
    return new Promise((resolve, reject) => {
        if (!PDFDocument) return reject(new Error('PDFKit not available'));
        const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Payment Receipt - Tencent Innovations', Author: 'Tencent Innovations' } });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.fillColor('#0284c7').font('Helvetica-Bold').fontSize(22).text('TENCENT INNOVATIONS', { align: 'center' });
        doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('Rangwe, Homa Bay County | Tel: 0740 311 014 | tencentbz@gmail.com', { align: 'center' });
        doc.moveDown(2);
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text('OFFICIAL PAYMENT RECEIPT', { align: 'center' });
        doc.moveDown(1.5);

        const dateStr = new Date(b.paidAt || Date.now()).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) + ' EAT';
        const rows = [
            ['Reference / Account:', b.accountRef],
            ['Client Name:', b.name],
            ['Phone Number:', b.phone],
            ['Service Rendered:', b.service],
            ['Location:', b.location],
            ...breakdownLines(b).map(([k, v]) => [k + ':', v]),
            ['Amount Paid:', `KES ${Number(b.amount).toLocaleString('en-KE')}`],
            ['M-Pesa Receipt:', b.receipt || 'See your M-Pesa SMS'],
            ['Date & Time:', dateStr],
            ['Payment Status:', 'PAID & CONFIRMED']
        ];
        let y = doc.y;
        rows.forEach(([label, val]) => {
            const v = pdfText(val);
            doc.font('Helvetica').fontSize(12);
            const h = Math.max(doc.heightOfString(v, { width: 320 }), 16);
            doc.fillColor('#0f172a').font('Helvetica-Bold').text(label, 50, y, { width: 160 });
            doc.font('Helvetica').text(v, 220, y, { width: 320 });
            y += h + 10;
        });
        doc.fontSize(10).fillColor('#64748b').text('Thank you for choosing Tencent Innovations. This is an electronically generated receipt.', 50, y + 30, { align: 'center', width: 495 });
        doc.end();
    });
}

function sendPdf(res, buf, accountRef) {
    const ref = String(accountRef || 'receipt').replace(/[^A-Za-z0-9_-]/g, '') || 'receipt';
    res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Tencent-Receipt-${ref}.pdf"`,
        'Content-Length': buf.length,
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow'
    });
    res.end(buf);
}

// ---------------------------------------------------------------
// 11. Receipt email to the customer
// ---------------------------------------------------------------
function receiptEmailHtml(b, link) {
    const row = (k, v) => `<tr><td style="padding:8px 0;color:#5b7078;">${esc(k)}</td><td style="padding:8px 0;text-align:right;font-weight:600;">${esc(v)}</td></tr>`;
    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#17323a;line-height:1.5;">
<h2 style="margin:0 0 4px;">Payment received</h2>
<p style="margin:0 0 16px;color:#5b7078;">Thank you, ${esc(b.name)}. Your receipt is attached to this email as a PDF.</p>
<table style="width:100%;border-collapse:collapse;border-top:1px solid #d7dfd8;border-bottom:1px solid #d7dfd8;">
${row('Service', b.service)}${row('Location', b.location)}${breakdownLines(b).map(([k, v]) => row(k, v)).join('')}${row('Amount paid', 'KES ' + b.amount.toLocaleString('en-KE'))}${row('M-Pesa receipt', b.receipt || 'See your M-Pesa SMS')}${row('Reference', b.accountRef)}
</table>
${link ? `<p style="margin:20px 0;"><a href="${esc(link)}" style="display:inline-block;background:#0284c7;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;">View your booking online</a></p>` : ''}
<p>An engineer will call you on ${esc(b.phone)} to agree a time for the visit.</p>
<p style="color:#5b7078;font-size:13px;">Tencent Innovations, Rangwe, Homa Bay County. Calls 0740 311 014</p>
</div>`;
}
function receiptEmailText(b, link) {
    return `Payment received\n\nThank you, ${b.name}. Your receipt is attached to this email as a PDF.\n\n` +
        `Service: ${b.service}\nLocation: ${b.location}\n${breakdownLines(b).map(([k, v]) => k + ': ' + v + '\n').join('')}Amount paid: KES ${b.amount.toLocaleString('en-KE')}\n` +
        `M-Pesa receipt: ${b.receipt || 'See your M-Pesa SMS'}\nReference: ${b.accountRef}\n` +
        (link ? `\nView your booking online: ${link}\n` : '') +
        `\nAn engineer will call you on ${b.phone} to agree a time for the visit.\n\nTencent Innovations, Rangwe, Homa Bay County. Calls 0740 311 014\n`;
}
async function setEmailStatus(id, status) {
    try { await pool.query('UPDATE bookings SET email_status = $2 WHERE id = $1', [id, String(status).slice(0, 300)]); } catch (_) { /* best effort */ }
}

// Sends the PDF receipt to the customer. Never throws; returns true/false.
async function emailReceipt(b) {
    if (!b.email) { await setEmailStatus(b.id, 'no email address'); return false; }
    try {
        const attachments = [];
        if (PDFDocument) attachments.push({ filename: `Tencent-Receipt-${b.accountRef}.pdf`, content: await generatePdfBuffer(b), contentType: 'application/pdf' });
        const link = makeBookingLink(b);
        const via = await sendMail({
            to: b.email,
            subject: `Your receipt from Tencent Innovations: ${b.service}`,
            html: receiptEmailHtml(b, link),
            text: receiptEmailText(b, link),
            attachments
        });
        await setEmailStatus(b.id, 'sent via ' + via);
        return true;
    } catch (err) {
        console.error('Receipt email failed:', err.message);
        await setEmailStatus(b.id, 'failed: ' + err.message);
        return false;
    }
}

// ---------------------------------------------------------------
// 12. Payment state changes
// ---------------------------------------------------------------
// The receipt email and your alert go out exactly once, and only when the M-Pesa receipt number is known
// (or, as a fallback, a few minutes after payment was confirmed without one).
async function finalizePaid(id, force = false) {
    const r = await pool.query(
        `UPDATE bookings SET receipt_sent = TRUE
         WHERE id = $1 AND status = 'paid' AND receipt_sent = FALSE AND (COALESCE(receipt, '') <> '' OR $2::boolean)
         RETURNING id`,
        [id, force]
    );
    if (!r.rowCount) return;
    const b = await getBooking(id);
    if (!b) return;
    const link = makeBookingLink(b);
    const extra = {
        'M-Pesa receipt': b.receipt || '(not received yet, match the Reference in your M-Pesa statement)',
        Verified: b.verified ? 'Yes, confirmed with Safaricom' : 'Callback only (status query was unavailable)'
    };
    if (link) {
        extra['Booking link'] = link;
        extra['Send to client on WhatsApp'] = `https://wa.me/${b.phone}?text=${encodeURIComponent(`Hello ${b.name}, your Tencent Innovations booking is confirmed (${b.service}, KES ${b.amount} paid). Your booking details: ${link}`)}`;
    }
    await notify(`✅ PAID: ${b.service} - ${b.name}`, bookingFields(b, extra));
    await emailReceipt(b);
}

async function markPaid(id, receipt, verified) {
    // Only the first caller flips the booking to paid. Callback and status poll can arrive together.
    await pool.query(
        `UPDATE bookings
         SET status = 'paid',
             receipt = CASE WHEN $2 <> '' THEN $2 ELSE receipt END,
             paid_at = $3,
             verified = $4
         WHERE id = $1 AND status <> 'paid'`,
        [id, receipt || '', Date.now(), Boolean(verified)]
    );
    await finalizePaid(id, false);
}
async function markFailed(id, reason) {
    const r = await pool.query(`UPDATE bookings SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [id]);
    if (r.rowCount) console.log('PAYMENT NOT COMPLETED:', JSON.stringify({ reason: String(reason || '').slice(0, 100) }));
}
const markReview = id => pool.query(`UPDATE bookings SET status = 'review' WHERE id = $1 AND status IN ('pending', 'review')`, [id]);

async function handleCallback(body) {
    const cb = body && body.Body && body.Body.stkCallback;
    if (!cb) return;
    const booking = await getBookingByCheckout(String(cb.CheckoutRequestID || ''));
    if (!booking) { console.log('Callback for an unknown CheckoutRequestID'); return; }

    const succeeded = Number(cb.ResultCode) === 0;
    const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const meta = name => { const it = items.find(i => i.Name === name); return it ? it.Value : undefined; };
    const receipt = String(meta('MpesaReceiptNumber') || '').slice(0, 40);

    if (booking.status === 'paid') {
        // Payment was already confirmed by the status check: add the receipt number, then send the receipt
        if (succeeded && receipt && !booking.receipt) {
            await pool.query(`UPDATE bookings SET receipt = $2 WHERE id = $1 AND COALESCE(receipt, '') = ''`, [booking.id, receipt]);
        }
        await finalizePaid(booking.id, false);
        return;
    }
    if (!succeeded) { await markFailed(booking.id, cb.ResultDesc); return; }

    // The amount paid must match the price we asked for
    if (Number(meta('Amount')) !== booking.amount) {
        await markReview(booking.id);
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
            await markReview(booking.id);
            await notify(`⚠️ CHECK PAYMENT: callback and status query disagree for ${booking.name}`, bookingFields(booking, {
                'M-Pesa receipt': receipt,
                'Query result': `${q.ResultCode} ${q.ResultDesc || ''}`
            }));
            return;
        }
    } catch (err) {
        console.error('STK status query failed, accepting callback only:', err.message);
    }
    await markPaid(booking.id, receipt, verified);
}

// Safaricom calls this. The secret in the URL stops strangers from posting fake payments.
app.post('/payments/cb/:secret', (req, res) => {
    const given = Buffer.from(String(req.params.secret));
    const expected = Buffer.from(String(MPESA.callbackSecret || ''));
    const ok = expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.sendStatus(404);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });   // answer fast, process after
    if (!dbReady) return console.error('Callback received while the database was not ready');
    handleCallback(req.body).catch(err => console.error('Callback error:', err.message));
});

// The "check your phone" page polls this. Only the person who made the booking can see it.
app.get('/payments/status/:id', statusLimiter, requireDb, ah(async (req, res) => {
    if (!(req.session && req.session.user)) return res.status(401).json({ status: 'unknown' });
    if (!validBookingId(req.params.id)) return res.status(404).json({ status: 'unknown' });
    let b = await getBookingForUser(req.params.id, req.session.user.id);
    if (!b) return res.status(404).json({ status: 'unknown' });

    if (b.status === 'pending' && b.checkoutRequestId &&
        Date.now() - b.createdAt > 25000 && Date.now() - (lastStatusQuery.get(b.id) || 0) > 12000) {
        lastStatusQuery.set(b.id, Date.now());
        try {
            const q = await stkQuery(b.checkoutRequestId);
            if (String(q.ResultCode) === '0') await markPaid(b.id, '', true);
            else if (q.ResultCode !== undefined && String(q.ResultCode) !== '') await markFailed(b.id, q.ResultDesc || 'Payment cancelled');
        } catch (_) { /* still processing, or temporarily unavailable: stay pending */ }
        b = (await getBookingForUser(b.id, req.session.user.id)) || b;
    }
    res.json({
        status: b.status,
        pdf: (b.status === 'paid' && PDFDocument) ? `/payments/receipt/${b.id}/download.pdf` : ''
    });
}));

// Only the owner can download from here. (The shareable /booking/ link has its own PDF route.)
app.get('/payments/receipt/:id/download.pdf', requireAuth, requireDb, ah(async (req, res) => {
    if (!PDFDocument) return errorPage(req, res, 501, 'Not available', 'Receipt download is not available right now.');
    if (!validBookingId(req.params.id)) return errorPage(req, res, 404, 'Not found', 'We could not find that receipt.', { href: '/requests', label: 'My requests' });
    const b = await getBookingForUser(req.params.id, req.session.user.id);
    if (!b || b.status !== 'paid') return errorPage(req, res, 404, 'Not found', 'That receipt is not available. It may not be paid yet.', { href: '/requests', label: 'My requests' });
    sendPdf(res, await generatePdfBuffer(b), b.accountRef);
}));

// Safety net: if the callback never delivered the M-Pesa receipt number, send the receipt anyway after 3 minutes.
// Also finishes any receipt that was waiting when the server restarted.
setInterval(() => {
    if (!dbReady) return;
    pool.query(`SELECT id FROM bookings WHERE status = 'paid' AND receipt_sent = FALSE AND paid_at < $1 AND paid_at > $2`,
        [Date.now() - 3 * 60 * 1000, Date.now() - 2 * 24 * 60 * 60 * 1000])
        .then(r => Promise.all(r.rows.map(row => finalizePaid(row.id, true))))
        .catch(err => console.error('Receipt sweep error:', err.message));
}, 60 * 1000).unref();

// ---------------------------------------------------------------
// 13. Layout: left sidebar (drawer on phones), theme toggle, styled error pages
// ---------------------------------------------------------------
function renderPage(req, { title, activeNav, content, showMpesaPopup = false }) {
    const user = req.session && req.session.user ? req.session.user : null;
    const nonce = req.nonce || '';
    const logo = LOGO_FILE ? '<img src="/brand-logo" alt="Tencent Innovations" class="logo-img">' : '';
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)} - Tencent Innovations</title>
    <script nonce="${nonce}">
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('theme') || 'dark'; } catch (e) {}
            document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
        })();
    </script>
    <style>
        :root { --bg: #0b132b; --surface: #1c2541; --sidebar-bg: #060a17; --text: #ffffff; --muted: #94a3b8; --border: #334155; --primary: #0284c7; --accent: #10b981; --danger: #f87171; }
        [data-theme="light"] { --bg: #f8fafc; --surface: #ffffff; --sidebar-bg: #ffffff; --text: #0f172a; --muted: #64748b; --border: #cbd5e1; --primary: #0284c7; --accent: #16a34a; --danger: #dc2626; }
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--text); line-height: 1.6; display: flex; min-height: 100vh; transition: background 0.3s, color 0.3s; }
        a { color: var(--primary); }

        .sidebar { width: 260px; background: var(--sidebar-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: fixed; top: 0; bottom: 0; left: 0; z-index: 100; transition: transform 0.25s ease; }
        .sidebar-header { padding: 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; background: rgba(0,0,0,0.2); }
        .logo-container { display: flex; align-items: center; gap: 12px; text-decoration: none; }
        .logo-img { height: 40px; width: auto; border-radius: 6px; background: #ffffff; padding: 2px; }
        .logo-text-group { display: flex; flex-direction: column; }
        .logo-text { font-size: 1.1rem; font-weight: bold; color: #38bdf8; line-height: 1.1; }
        .logo-tagline { font-size: 0.65rem; color: var(--muted); }

        .sidebar-nav { flex: 1; padding: 16px 12px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; list-style: none; margin: 0; }
        .sidebar-nav a { color: var(--muted); text-decoration: none; font-weight: 500; font-size: 0.95rem; padding: 10px 14px; border-radius: 8px; transition: all 0.2s; display: flex; align-items: center; gap: 10px; }
        .sidebar-nav a:hover, .sidebar-nav a.active { color: var(--text); background: var(--surface); }

        .sidebar-auth-group { display: flex; flex-direction: column; gap: 8px; padding: 14px 12px; background: rgba(2, 132, 199, 0.08); border-radius: 10px; border: 1px solid var(--border); margin: 6px 0; }
        .sidebar-auth-btn { text-align: center; font-weight: bold; padding: 10px 14px; border-radius: 8px; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 0.95rem; transition: background 0.2s; cursor: pointer; font-family: inherit; width: 100%; }
        .sidebar-login-btn { background: var(--primary); color: #ffffff !important; border: 1px solid var(--primary); }
        .sidebar-login-btn:hover { background: #0369a1 !important; }
        .sidebar-register-btn { background: transparent; border: 1px solid var(--primary); color: var(--primary) !important; }
        .sidebar-register-btn:hover { background: var(--surface) !important; }
        .sidebar-logout-btn { background: transparent; border: 1px solid var(--danger); color: var(--danger); }
        .sidebar-footer { padding: 15px 20px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
        .theme-toggle-btn { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
        .theme-toggle-btn:hover { background: var(--surface); }

        .mobile-bar { display: none; }
        .scrim { display: none; }

        .main-content { margin-left: 260px; flex: 1; display: flex; flex-direction: column; min-height: 100vh; min-width: 0; }
        .container { max-width: 100%; margin: 0 auto; padding: 0; flex: 1; width: 100%; }

        .hero-video-container { position: relative; width: 100%; min-height: 420px; overflow: hidden; display: flex; align-items: center; justify-content: center; text-align: center; border-bottom: 3px solid var(--border); background: linear-gradient(135deg, #0b132b 0%, #0c4a6e 55%, #0b132b 100%); background-size: 200% 200%; animation: drift 18s ease-in-out infinite; }
        .hero-video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; filter: brightness(0.45); }
        .hero-overlay-content { position: relative; z-index: 2; padding: 30px 20px; max-width: 800px; }
        .hero-logo-badge { height: 75px; width: auto; background: #fff; padding: 6px; border-radius: 10px; margin-bottom: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        .hero-overlay-content h1 { font-size: 2.3rem; color: #ffffff; margin: 0 0 10px 0; text-shadow: 0 2px 4px rgba(0,0,0,0.8); }
        .hero-overlay-content p { color: #e2e8f0; font-size: 1.15rem; margin: 0 0 20px 0; text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
        .hero-cta { display: inline-block; background: #38bdf8; color: #0f172a; padding: 12px 28px; border-radius: 30px; font-weight: bold; text-decoration: none; }
        @keyframes drift { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }

        .services-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; width: 100%; }
        .service-card { padding: 40px 20px; text-align: center; display: flex; flex-direction: column; justify-content: space-between; min-height: 320px; transition: transform 0.2s; position: relative; }
        .service-card:hover { transform: translateY(-4px); z-index: 10; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
        .service-card h3 { font-size: 1.25rem; font-weight: 800; letter-spacing: 0.05em; margin: 15px 0 10px 0; text-transform: uppercase; }
        .service-card p { font-size: 0.9rem; line-height: 1.5; margin-bottom: 25px; opacity: 0.9; }
        .service-icon { font-size: 2.3rem; margin-bottom: 10px; }
        .card-black { background: #000000; color: #ffffff; border-right: 1px solid #1e293b; }
        .card-gray { background: #334155; color: #ffffff; border-right: 1px solid #475569; }
        .card-light { background: #f1f5f9; color: #0f172a; border-right: 1px solid #cbd5e1; }
        .card-teal { background: #14b8a6; color: #000000; }
        .enquire-btn { display: inline-block; background: #ffffff; color: #0f172a; padding: 10px 20px; border-radius: 4px; font-weight: bold; text-decoration: none; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; transition: opacity 0.2s; }
        .card-black .enquire-btn { background: #0284c7; color: #fff; }
        .card-gray .enquire-btn, .card-light .enquire-btn, .card-teal .enquire-btn { background: #0f172a; color: #fff; }
        .enquire-btn:hover { opacity: 0.85; }

        .general-container { padding: 40px 30px; max-width: 900px; margin: 0 auto; }
        .general-container h2 { margin-top: 0; }
        .quote-box { background: var(--bg); border: 1px dashed var(--border); border-radius: 8px; padding: 12px 14px; margin: 0 0 16px 0; color: var(--muted); }
        .quote-row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; color: var(--text); }
        .quote-row.total { border-top: 1px solid var(--border); margin-top: 6px; padding-top: 8px; font-weight: bold; color: var(--accent); }
        .terms h3 { color: var(--primary); margin-top: 28px; }
        .terms p.clause { margin: 8px 0; }
        .terms p.clause strong { color: var(--accent); margin-right: 6px; }
        .terms ul { padding-left: 22px; }
        .sub-title { color: var(--muted); font-size: 1.1rem; margin-top: -6px; margin-bottom: 22px; }
        .intro-text { font-size: 1.05rem; color: var(--text); margin-bottom: 22px; }
        .cta-btn { display: inline-block; background: var(--primary); color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 1rem; border: none; cursor: pointer; text-align: center; font-family: inherit; }
        .cta-btn:hover { background: #0369a1; }
        .cta-btn.block { display: block; width: 100%; }
        .cta-btn.green { background: var(--accent); color: #0f172a; }
        .cta-btn.small { padding: 6px 12px; font-size: 0.85rem; border-radius: 6px; }
        .form-container { background: var(--surface); border: 1px solid var(--border); padding: 30px; border-radius: 12px; margin-top: 20px; text-align: left; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; color: var(--primary); font-weight: 600; }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 1rem; font-family: inherit; }
        .form-group small { display: block; margin-top: 6px; color: var(--muted); }
        .alert { padding: 12px 14px; border-radius: 8px; margin: 0 0 18px 0; border: 1px solid var(--danger); color: var(--danger); background: rgba(248,113,113,0.1); }
        .alert.ok { border-color: var(--accent); color: var(--accent); background: rgba(16,185,129,0.1); }
        .badge { padding: 4px 10px; border-radius: 6px; font-weight: bold; font-size: 0.85rem; display: inline-block; }
        .badge.paid { background: rgba(74,222,128,0.15); color: var(--accent); }
        .badge.pending { background: rgba(56,189,248,0.15); color: #38bdf8; }
        .badge.bad { background: rgba(248,113,113,0.15); color: var(--danger); }
        .data-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.95rem; }
        .data-table th { padding: 14px 12px; background: var(--bg); border-bottom: 2px solid var(--border); color: var(--primary); }
        .data-table td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
        .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow-x: auto; margin-top: 20px; }
        .inline-form { display: inline; margin: 0; }

        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.75); z-index: 1000; display: flex; align-items: center; justify-content: center; animation: fadeIn 0.2s ease-out; }
        .modal-box { background: var(--surface); border: 2px solid var(--accent); padding: 30px; border-radius: 12px; max-width: 450px; width: 90%; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .modal-box h3 { color: var(--accent); margin-top: 0; font-size: 1.35rem; }
        .modal-box p { font-size: 1.05rem; line-height: 1.5; color: var(--text); margin: 15px 0 25px 0; }
        .modal-btn { background: var(--accent); color: #0f172a; border: none; padding: 12px 28px; border-radius: 8px; font-weight: bold; font-size: 1rem; cursor: pointer; text-transform: uppercase; }
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

        @media (max-width: 992px) { .services-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 768px) {
            body { flex-direction: column; }
            .mobile-bar { display: flex; position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 90; align-items: center; gap: 12px; padding: 0 14px; background: var(--sidebar-bg); border-bottom: 1px solid var(--border); }
            .menu-btn { background: transparent; border: 1px solid var(--border); color: var(--text); border-radius: 8px; width: 40px; height: 40px; font-size: 1.3rem; cursor: pointer; }
            .mobile-title { font-weight: bold; color: #38bdf8; }
            .sidebar { transform: translateX(-100%); width: 280px; max-width: 85vw; }
            .sidebar.open { transform: translateX(0); box-shadow: 0 0 40px rgba(0,0,0,0.6); }
            .scrim.open { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 95; }
            .main-content { margin-left: 0; padding-top: 56px; }
            .services-grid { grid-template-columns: 1fr; }
            .general-container { padding: 28px 16px; }
            .hero-overlay-content h1 { font-size: 1.7rem; }
            .form-container { padding: 20px; }
        }
        @media (prefers-reduced-motion: reduce) { .hero-video-container { animation: none; } * { transition: none !important; } }
    </style>
</head>
<body>
    ${showMpesaPopup ? `
    <div class="modal-overlay" id="mpesa-modal">
        <div class="modal-box">
            <h3>📱 M-Pesa Prompt Sent!</h3>
            <p>An M-Pesa payment prompt has been sent to your phone. <strong>Please put your M-Pesa PIN immediately</strong> to authorize your order and complete the transaction.</p>
            <button class="modal-btn" id="mpesa-modal-close" type="button">I Have Entered My PIN</button>
        </div>
    </div>` : ''}

    <div class="mobile-bar">
        <button class="menu-btn" id="menu-btn" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">☰</button>
        <span class="mobile-title">Tencent Innovations</span>
    </div>
    <div class="scrim" id="scrim"></div>

    <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
            <a href="/" class="logo-container">
                ${logo}
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
            ${user ? `<li><a href="/requests" class="${activeNav === 'requests' ? 'active' : ''}">📊 My Requests & Receipts</a></li>` : ''}
            <li><a href="/contact" class="${activeNav === 'contact' ? 'active' : ''}">📞 Contact Us</a></li>
            <li><a href="/terms" class="${activeNav === 'terms' ? 'active' : ''}">📄 Terms & Conditions</a></li>
            <li><hr style="border:0; border-top:1px solid var(--border); margin: 12px 0;"></li>
            <li>
                <div class="sidebar-auth-group">
                    ${user ? `
                        <div style="padding: 4px 6px; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">👤 <strong>${esc(user.name)}</strong></div>
                        <form action="/logout" method="POST" class="inline-form"><button type="submit" class="sidebar-auth-btn sidebar-logout-btn">🚪 Logout</button></form>
                    ` : `
                        <a href="/login" class="sidebar-auth-btn sidebar-login-btn">🔑 Sign In / Login</a>
                        <a href="/register" class="sidebar-auth-btn sidebar-register-btn">📝 Register Account</a>
                    `}
                </div>
            </li>
        </ul>
        <div class="sidebar-footer">
            <button id="theme-toggle" class="theme-toggle-btn" type="button" aria-label="Toggle theme">
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
                        <li><a href="/wifi">WiFi & Networking</a></li>
                        <li><a href="/survey">Site Surveys</a></li>
                        <li><a href="/solar">Solar Systems</a></li>
                    </ul>
                </div>
                <div class="footer-col">
                    <h4>Customer Care</h4>
                    <ul class="footer-links">
                        <li><a href="${user ? '/requests' : '/login'}">My Account</a></li>
                        <li><a href="/contact">Contact Us</a></li>
                        <li><a href="/terms">Terms & Conditions</a></li>
                    </ul>
                </div>
                <div class="footer-col">
                    <h4>Tencent Innovations</h4>
                    <p style="font-size: 0.85rem; color: var(--muted); line-height: 1.5;">Empowering homes, schools, and businesses across Rangwe and Homa Bay County with integrated internet, reliable security, and clean solar backup power.</p>
                </div>
            </div>
            <div class="footer-bottom"><p>&copy; 2026 Tencent Innovations. All rights reserved.</p></div>
        </footer>
    </div>

    <script nonce="${nonce}">
        (function () {
            var root = document.documentElement;
            function themeUI(theme) {
                var icon = document.getElementById('theme-icon'), text = document.getElementById('theme-text');
                if (icon) icon.textContent = theme === 'light' ? '🌙' : '☀️';
                if (text) text.textContent = theme === 'light' ? 'Dark' : 'Light';
            }
            themeUI(root.getAttribute('data-theme'));
            document.getElementById('theme-toggle').addEventListener('click', function () {
                var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
                root.setAttribute('data-theme', next);
                try { localStorage.setItem('theme', next); } catch (e) {}
                themeUI(next);
            });

            var sidebar = document.getElementById('sidebar'), scrim = document.getElementById('scrim'), btn = document.getElementById('menu-btn');
            function setMenu(open) {
                sidebar.classList.toggle('open', open);
                scrim.classList.toggle('open', open);
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            btn.addEventListener('click', function () { setMenu(!sidebar.classList.contains('open')); });
            scrim.addEventListener('click', function () { setMenu(false); });
            document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });

            var close = document.getElementById('mpesa-modal-close');
            if (close) close.addEventListener('click', function () { document.getElementById('mpesa-modal').style.display = 'none'; });
        })();
    </script>
</body>
</html>`;
}

function errorPage(req, res, status, title, message, back = { href: '/', label: 'Back to Home' }) {
    return res.status(status).send(renderPage(req, {
        title,
        activeNav: '',
        content: `<div class="general-container"><h2>${esc(title)}</h2><p class="intro-text">${esc(message)}</p><a href="${esc(back.href)}" class="cta-btn">${esc(back.label)}</a></div>`
    }));
}

// ---------------------------------------------------------------
// 14. Accounts: register, login, logout
// ---------------------------------------------------------------
function registerForm(req, { error = '', values = {} } = {}) {
    return `
        <div class="general-container">
            <h2>Create an Account</h2>
            <p class="sub-title">Register to book services, request surveys, and receive receipts by email.</p>
            <div class="form-container">
                ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
                <form action="/register" method="POST">
                    <div class="form-group"><label for="r-name">Full Name</label><input id="r-name" type="text" name="name" required maxlength="80" autocomplete="name" placeholder="John Otieno" value="${esc(values.name || '')}"></div>
                    <div class="form-group"><label for="r-email">Email Address (your receipts are sent here)</label><input id="r-email" type="email" name="email" required maxlength="254" autocomplete="email" placeholder="john@example.com" value="${esc(values.email || '')}"></div>
                    <div class="form-group"><label for="r-phone">M-Pesa Phone Number</label><input id="r-phone" type="tel" name="phone" required autocomplete="tel" placeholder="0712345678" value="${esc(values.phone || '')}"></div>
                    <div class="form-group"><label for="r-pass">Password</label><input id="r-pass" type="password" name="password" required minlength="8" maxlength="72" autocomplete="new-password"><small>At least 8 characters.</small></div>
                    <div class="form-group"><label for="r-pass2">Confirm Password</label><input id="r-pass2" type="password" name="confirm" required minlength="8" maxlength="72" autocomplete="new-password"></div>
                    <button type="submit" class="cta-btn block">Register</button>
                </form>
                <p style="margin-top: 15px; text-align:center;">Already have an account? <a href="/login">Login here</a></p>
            </div>
        </div>`;
}

app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/survey');
    res.send(renderPage(req, { title: 'Register', activeNav: 'register', content: registerForm(req) }));
});

app.post('/register', registerLimiter, requireDb, ah(async (req, res) => {
    const values = { name: str(req.body.name).slice(0, 80), email: str(req.body.email).toLowerCase(), phone: str(req.body.phone) };
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : '';
    const fail = message => res.status(400).send(renderPage(req, { title: 'Register', activeNav: 'register', content: registerForm(req, { error: message, values }) }));

    const phone = normalizePhone(values.phone);
    if (values.name.length < 2) return fail('Please enter your full name.');
    if (!validEmail(values.email)) return fail('Please enter a valid email address.');
    if (!phone) return fail('Please enter a valid Safaricom number, for example 0712345678.');
    if (password.length < 8) return fail('Your password must be at least 8 characters.');
    if (Buffer.byteLength(password) > 72) return fail('Your password is too long. Please use 72 characters or fewer.');
    if (password !== confirm) return fail('The two passwords do not match.');

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    let user;
    try {
        const r = await pool.query(
            'INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone',
            [values.name, values.email, phone, hash]
        );
        user = r.rows[0];
    } catch (err) {
        if (err.code === '23505') return fail('We could not create that account. If you already registered, please log in instead.');
        throw err;
    }
    await regenerateSession(req);   // a fresh session id at login prevents session fixation
    req.session.user = { id: user.id, name: user.name, email: user.email, phone: user.phone };
    await saveSession(req);
    res.redirect('/survey');
}));

function loginForm(req, { error = '', email = '', next = '/survey' } = {}) {
    return `
        <div class="general-container">
            <h2>Login to Your Account</h2>
            <p class="sub-title">Access surveys, service bookings, and receipt downloads.</p>
            <div class="form-container">
                ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
                <form action="/login" method="POST">
                    <input type="hidden" name="next" value="${esc(next)}">
                    <div class="form-group"><label for="l-email">Email Address</label><input id="l-email" type="email" name="email" required maxlength="254" autocomplete="email" placeholder="john@example.com" value="${esc(email)}"></div>
                    <div class="form-group"><label for="l-pass">Password</label><input id="l-pass" type="password" name="password" required maxlength="72" autocomplete="current-password"></div>
                    <button type="submit" class="cta-btn block">Login</button>
                </form>
                <p style="margin-top: 15px; text-align:center;">Don't have an account? <a href="/register">Register here</a></p>
            </div>
        </div>`;
}

app.get('/login', (req, res) => {
    const next = safeNext(req.query.next);
    if (req.session.user) return res.redirect(next);
    res.send(renderPage(req, { title: 'Login', activeNav: 'login', content: loginForm(req, { next }) }));
});

app.post('/login', loginLimiter, requireDb, ah(async (req, res) => {
    const email = str(req.body.email).toLowerCase().slice(0, 254);
    const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 72) : '';
    const next = safeNext(req.body.next);

    const r = await pool.query('SELECT id, name, email, phone, password_hash FROM users WHERE lower(email) = $1', [email]);
    const user = r.rows[0];
    // Always run one bcrypt comparison, so unknown emails take as long as wrong passwords
    const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !match) {
        return res.status(401).send(renderPage(req, { title: 'Login', activeNav: 'login', content: loginForm(req, { error: 'Invalid email or password.', email, next }) }));
    }
    await regenerateSession(req);
    req.session.user = { id: user.id, name: user.name, email: user.email, phone: user.phone };
    await saveSession(req);
    res.redirect(next);
}));

// POST, so another website cannot log people out with a link or image
app.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('tc.sid');
        res.redirect('/');
    });
});

// ---------------------------------------------------------------
// 15. Public pages
// ---------------------------------------------------------------
app.get('/', (req, res) => {
    const logoBadge = LOGO_FILE ? '<img src="/brand-logo" alt="Tencent Innovations Logo" class="hero-logo-badge"><br>' : '';
    const video = HERO_VIDEO ? '<video autoplay muted loop playsinline class="hero-video"><source src="/hero.mp4" type="video/mp4"></video>' : '';
    const content = `
        <div class="hero-video-container">
            ${video}
            <div class="hero-overlay-content">
                ${logoBadge}
                <h1>INTEGRATED TECHNOLOGY & SECURITY LEADERS</h1>
                <p>Providing high-performance WiFi, Solar Backup, CCTV, Smart Locks, and Electric Fences across East Africa.</p>
                <div style="margin-top:15px;"><a href="/survey" class="hero-cta">Book Site Survey</a></div>
            </div>
        </div>

        <div class="services-grid">
            <div class="service-card card-black">
                <div><div class="service-icon">📶</div><h3>WIFI NETWORKS</h3><p>High-speed hotspot and dedicated home/office fiber internet installations designed for maximum uptime and stability.</p></div>
                <div><a href="/wifi" class="enquire-btn">Enquire Now</a></div>
            </div>
            <div class="service-card card-gray">
                <div><div class="service-icon">☀️</div><h3>SOLAR SOLUTIONS</h3><p>Contact us now for your solar system quote for both Home & Commercial off-grid and hybrid kits.</p></div>
                <div><a href="/solar" class="enquire-btn">Enquire Now</a></div>
            </div>
            <div class="service-card card-light">
                <div><div class="service-icon">📷</div><h3>CCTV SYSTEMS</h3><p>Advanced security surveillance cameras with remote smartphone viewing and crystal-clear night vision.</p></div>
                <div><a href="/cctv" class="enquire-btn">Enquire Now</a></div>
            </div>
            <div class="service-card card-teal">
                <div><div class="service-icon">🔐 & ⚡</div><h3>LOCKS & FENCES</h3><p>Secure biometric smart locks and high-voltage perimeter electric fences engineered to protect your premises.</p></div>
                <div><a href="/smart-locks" class="enquire-btn">Enquire Now</a></div>
            </div>
        </div>
    `;
    res.send(renderPage(req, { title: 'Home', activeNav: 'home', content }));
});

const servicePage = (route, nav, title, heading, sub, body, button) => app.get(route, (req, res) => {
    const content = `
        <div class="general-container">
            <h2>${heading}</h2>
            <p class="sub-title">${sub}</p>
            ${body}
            <div class="form-container" style="margin-top: 25px;">
                <p style="margin-top:0;">${button.text}</p>
                <a href="/survey" class="cta-btn">${button.label}</a>
            </div>
        </div>`;
    res.send(renderPage(req, { title, activeNav: nav, content }));
});

servicePage('/wifi', 'wifi', 'WiFi & Networking',
    'Reliable WiFi for Homes, Rentals, and ISP Resellers.',
    'Pay-as-you-go hotspots, PPPoE client management, and dedicated fiber connections.',
    `<div class="form-container" style="border-left: 4px solid var(--primary);">
        <h3 style="color:var(--primary); margin-top:0;">What we offer WiFi resellers, technicians & network owners</h3>
        <ul style="line-height: 1.8; margin-bottom: 0; padding-left: 20px;">
            <li><strong>For resellers:</strong> We set up automated M-Pesa hotspot vending (MikroTik and FreeRADIUS), so your customers buy daily, weekly or monthly vouchers and are connected automatically.</li>
            <li><strong>For technicians:</strong> We install and configure the network for you: mast grounding, shielded CAT6 STP cabling, and watchdog scripts on access points to prevent signal dropouts.</li>
            <li><strong>For network owners:</strong> We monitor bandwidth use, set up automated payment reconciliation and help you track uptime, so you can see how your network is performing.</li>
        </ul>
    </div>`,
    { text: 'Book a site visit or network review with our senior network engineers.', label: 'Book WiFi Consultation' });

servicePage('/cctv', 'cctv', 'CCTV Systems',
    'See your property from anywhere.',
    'CCTV systems for homes, shops, schools and compounds, installed and set up to view live on your phone.', '',
    { text: 'Get professional camera positioning and a clear quote.', label: 'Book CCTV Survey' });

servicePage('/smart-locks', 'smart-locks', 'Smart Locks',
    'Open your door without a key.',
    'Smart locks for homes, rental units, offices and stores. Use a code, a card, a fingerprint or your phone.', '',
    { text: 'Find the right smart lock model for your doors.', label: 'Book Smart Lock Consultation' });

servicePage('/electric-fence', 'electric-fence', 'Electric Fence',
    'Stop intruders at the boundary.',
    'Electric fence installation for homes, compounds, schools, farms and commercial plots.', '',
    { text: 'Measure your boundary and get a professional installation quote.', label: 'Book Electric Fence Survey' });

servicePage('/solar', 'solar', 'Solar Solutions',
    'Keep the lights, internet and cameras on when the grid goes off.',
    'Solar and battery systems sized for your home, shop, school or network site.', '',
    { text: 'Calculate your load requirements with our engineers.', label: 'Book Solar Consultation' });

// ---------------------------------------------------------------
// 16. Survey booking and payment (login required)
// ---------------------------------------------------------------
const quoteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests. Please wait a moment.' } });
// Live price for the booking form. The same function prices the real booking, so the two can never disagree.
app.get('/survey/quote', requireAuth, quoteLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const q = computeQuote({ service: str(req.query.service), urgency: str(req.query.urgency), place: str(req.query.place), lat: str(req.query.lat), lng: str(req.query.lng) });
    res.json(q.ok ? { ok: true, base: q.base, km: q.km, travel: q.travel, urgencyFee: q.urgencyFee, urgencyLabel: q.urgencyLabel, total: q.total } : q);
});

app.get('/survey', requireAuth, (req, res) => {
    const u = req.session.user;
    const content = `
        <div class="general-container">
            <h2>Know what your site needs before you spend.</h2>
            <p class="sub-title">A site survey by an engineer, followed by a written plan and quote.</p>
            <div class="form-container" style="border-color: var(--accent);">
                <h3 style="margin-top:0; color: var(--accent);">Book Site Survey & Pay via M-Pesa (STK Push)</h3>
                <p style="color:var(--muted); font-size:0.95rem;">Logged in as: <strong>${esc(u.email)}</strong>. Your receipt will be emailed here.</p>
                <form action="/submit-survey-payment" method="POST" id="payment-form">
                    <div class="form-group"><label for="s-name">Full Name</label><input id="s-name" type="text" name="name" value="${esc(u.name)}" required maxlength="80"></div>
                    <div class="form-group"><label for="s-phone">M-Pesa Phone Number</label><input id="s-phone" type="tel" name="phone" value="${esc(u.phone)}" required placeholder="0712345678"></div>
                    <div class="form-group">
                        <label for="s-service">Service Category</label>
                        <select name="service" id="s-service">
                            <option value="Site Survey & Quotation">General Site Survey (from KES 3,000)</option>
                            <option value="WiFi Setup">WiFi & Hotspot Consultation (from KES 3,000)</option>
                            <option value="CCTV Installation">CCTV System Assessment (from KES 3,000)</option>
                            <option value="Smart Locks">Smart Locks Consultation (from KES 2,500)</option>
                            <option value="Electric Fence">Electric Fence Survey (from KES 5,000)</option>
                            <option value="Solar Consultation">Solar Consultation & Sizing (from KES 4,000)</option>
                        </select>
                        <small>These are base fees. A travel fare (by distance from Rangwe) and an urgency fee are added below. Prices can change according to the location and urgency. Thank you.</small>
                    </div>
                    <div class="form-group">
                        <label for="s-urgency">How soon do you need us?</label>
                        <select name="urgency" id="s-urgency">
                            ${Object.entries(PRICING.urgency).map(([k, u]) => `<option value="${esc(k)}">${esc(u.label)}${u.fee ? ' (+KES ' + u.fee.toLocaleString('en-KE') + ')' : ''}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="s-place">Where is the site?</label>
                        <select name="place" id="s-place">
                            <option value="">Choose your area...</option>
                            ${Object.entries(PLACES).map(([k, pl]) => `<option value="${esc(k)}">${esc(pl.label)}</option>`).join('')}
                        </select>
                        <button type="button" id="s-gps" class="cta-btn small" style="margin-top:10px;">📍 Use my current location instead</button>
                        <small id="s-gps-note" style="display:block; margin-top:6px;">Sharing your location gives the most accurate travel fare. It is used only for this quote and to find your site.</small>
                        <input type="hidden" name="lat" id="s-lat"><input type="hidden" name="lng" id="s-lng">
                    </div>
                    <div class="form-group"><label for="s-loc">Physical Location / Address</label><input id="s-loc" type="text" name="location" required maxlength="120" placeholder="e.g. Rangwe Town, near the market"></div>
                    <div id="quote-box" class="quote-box" aria-live="polite">Choose your area to see the total.</div>
                    <p style="color:var(--muted); font-size:0.9rem; margin:0 0 12px 0;">By booking, you agree to our <a href="/terms" target="_blank" rel="noopener">Terms and Conditions</a>.</p>
                    <button type="submit" id="s-submit" class="cta-btn block green" disabled>Trigger M-Pesa Payment & Book Survey</button>
                </form>
                <script nonce="${req.nonce}">
                (function () {
                    var f = document.getElementById('payment-form'), box = document.getElementById('quote-box'), btn = document.getElementById('s-submit');
                    var lat = document.getElementById('s-lat'), lng = document.getElementById('s-lng'), place = document.getElementById('s-place'), note = document.getElementById('s-gps-note');
                    function kes(n) { return 'KES ' + Number(n).toLocaleString('en-KE'); }
                    function row(k, v, strong) { var r = document.createElement('div'); r.className = 'quote-row' + (strong ? ' total' : ''); var a = document.createElement('span'), b = document.createElement('span'); a.textContent = k; b.textContent = v; r.appendChild(a); r.appendChild(b); return r; }
                    var seq = 0;
                    function refresh() {
                        var mine = ++seq;
                        var q = new URLSearchParams({ service: f.service.value, urgency: f.urgency.value, place: place.value, lat: lat.value, lng: lng.value });
                        btn.disabled = true;
                        fetch('/survey/quote?' + q.toString(), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
                            if (mine !== seq) return;
                            box.textContent = '';
                            if (!d.ok) { box.textContent = d.error || 'Choose your area to see the total.'; return; }
                            box.appendChild(row('Service fee', kes(d.base)));
                            box.appendChild(row('Travel fare (about ' + d.km + ' km from Rangwe)', d.travel ? kes(d.travel) : 'Free'));
                            if (d.urgencyFee) box.appendChild(row('Urgency (' + d.urgencyLabel + ')', kes(d.urgencyFee)));
                            box.appendChild(row('Total to pay now', kes(d.total), true));
                            btn.disabled = false;
                        }).catch(function () { if (mine === seq) box.textContent = 'We could not work out the total. Please try again.'; });
                    }
                    ['service', 'urgency'].forEach(function (n) { f[n].addEventListener('change', refresh); });
                    place.addEventListener('change', function () { lat.value = ''; lng.value = ''; note.textContent = 'Using the area you chose.'; refresh(); });
                    document.getElementById('s-gps').addEventListener('click', function () {
                        if (!navigator.geolocation) { note.textContent = 'Your browser cannot share location. Please choose your area instead.'; return; }
                        note.textContent = 'Finding your location...';
                        navigator.geolocation.getCurrentPosition(function (pos) {
                            lat.value = pos.coords.latitude.toFixed(5); lng.value = pos.coords.longitude.toFixed(5); place.value = '';
                            note.textContent = 'Location shared. Thank you.'; refresh();
                        }, function () { note.textContent = 'We could not get your location. Please choose your area instead.'; }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
                    });
                    refresh();
                })();
                </script>
            </div>
        </div>`;
    res.send(renderPage(req, { title: 'Surveys & Quotations', activeNav: 'survey', content }));
});

app.post('/submit-survey-payment', requireAuth, payLimiter, requireDb, ah(async (req, res) => {
    const user = req.session.user;
    const name = str(req.body.name).slice(0, 80);
    const location = str(req.body.location).slice(0, 120);
    const service = str(req.body.service);
    const phone = normalizePhone(str(req.body.phone));
    const back = { href: '/survey', label: 'Back to Surveys' };
    const quote = computeQuote({ service, urgency: str(req.body.urgency), place: str(req.body.place), lat: str(req.body.lat), lng: str(req.body.lng) });

    if (!name || !location) return errorPage(req, res, 400, 'We could not start your payment', 'Please enter your name and location.', back);
    if (!quote.ok) return errorPage(req, res, 400, 'We could not start your payment', quote.error, back);
    if (!phone) return errorPage(req, res, 400, 'We could not start your payment', 'Please enter a valid Safaricom number, for example 0712345678.', back);
    if (!phoneAttemptAllowed(phone)) return errorPage(req, res, 429, 'Too many attempts', 'Too many payment requests for this number. Please try again later.', back);

    // Random, unique reference (max 12 characters for Daraja)
    let booking = null;
    for (let attempt = 0; attempt < 5 && !booking; attempt++) {
        const candidate = {
            id: crypto.randomBytes(16).toString('hex'),
            userId: user.id, name, phone, service, location,
            amount: quote.total,   // base fee + travel fare + urgency fee, all worked out on the server
            baseAmount: quote.base, travelKm: quote.km, travelFee: quote.travel, urgency: quote.urgency, urgencyFee: quote.urgencyFee,
            geo: `${quote.lat},${quote.lng}`,
            accountRef: 'TNC' + crypto.randomBytes(4).toString('hex').toUpperCase(),
            email: user.email
        };
        try {
            await pool.query(
                `INSERT INTO bookings (id, user_id, name, phone, service, location, amount, account_ref, status, created_at,
                                       base_amount, travel_km, travel_fee, urgency, urgency_fee, geo)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13, $14, $15)`,
                [candidate.id, candidate.userId, name, phone, service, location, candidate.amount, candidate.accountRef, Date.now(),
                 candidate.baseAmount, candidate.travelKm, candidate.travelFee, candidate.urgency, candidate.urgencyFee, candidate.geo]
            );
            booking = candidate;
        } catch (err) {
            if (err.code !== '23505') throw err;   // 23505 = reference already used, try another
        }
    }
    if (!booking) return errorPage(req, res, 500, 'We could not save your booking', 'Please try again.', back);

    // Tell you about the lead right away (alerts go to you only, never to the customer)
    notify(`📋 Survey booking (awaiting payment): ${name} - ${service}`, bookingFields(booking)).catch(() => {});

    if (!mpesaConfigured()) {
        await pool.query(`UPDATE bookings SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [booking.id]);
        console.error('M-Pesa is not fully configured (check MPESA_* variables and PUBLIC_BASE_URL).');
        return errorPage(req, res, 503, 'Online payment is unavailable', 'Online payment is not available right now. We have saved your request and will call you.', { href: '/requests', label: 'My requests' });
    }

    try {
        const r = await stkPush(booking);
        await pool.query('UPDATE bookings SET checkout_request_id = $1 WHERE id = $2', [r.CheckoutRequestID, booking.id]);
    } catch (err) {
        console.error('STK push failed:', err.message);
        await pool.query(`UPDATE bookings SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [booking.id]);
        return errorPage(req, res, 502, 'We could not send the M-Pesa prompt', 'Please check your number and try again, or call us on 0740 311 014.', back);
    }

    const link = makeBookingLink(booking);
    res.send(renderPage(req, {
        title: 'Check Your Phone',
        activeNav: 'survey',
        showMpesaPopup: true,
        content: `
            <div class="general-container">
                <h2>📱 M-Pesa Prompt Sent</h2>
                <div style="background:var(--surface); border:2px solid var(--accent); padding:25px; border-radius:12px; margin-top:20px; text-align:center;">
                    <h3 style="color:var(--accent); margin-top:0; font-size:1.4rem;">Please check your phone</h3>
                    <p style="font-size:1.15rem; font-weight:bold; margin:15px 0;">Enter your M-Pesa PIN on <strong>${esc(phone)}</strong> to pay KES ${booking.amount.toLocaleString('en-KE')}.</p>
                    <div id="status-box" style="margin:25px 0 0; padding:15px; border-radius:8px; background:var(--bg); border:1px solid var(--border);">
                        <p id="status-text" style="font-weight:bold; color:#38bdf8; margin:0;">⏳ Waiting for your M-Pesa PIN entry...</p>
                    </div>
                </div>
                <div style="margin-top:25px; text-align:center; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
                    <a href="/requests" class="cta-btn">View All My Requests & Receipts</a>
                    ${link ? `<a href="${esc(link)}" class="cta-btn green">Open your booking page</a>` : ''}
                </div>
            </div>
            <script nonce="${req.nonce}">
            (function () {
                var id = ${JSON.stringify(booking.id)}, tries = 0, box = document.getElementById('status-box'), timer;
                function show(html) { box.innerHTML = html; }
                function check() {
                    tries++;
                    fetch('/payments/status/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
                        if (d.status === 'paid') {
                            var h = '<h3 style="color:var(--accent); margin:0;">✅ Payment Confirmed</h3><p style="margin-top:8px;">An official PDF receipt is being emailed to you.</p>';
                            if (d.pdf) h += '<p><a href="' + d.pdf + '" class="cta-btn green">📥 Download Official PDF Receipt</a></p>';
                            show(h); clearInterval(timer);
                        } else if (d.status === 'failed') {
                            show('<h3 style="color:var(--danger); margin:0;">❌ Payment Cancelled or Timed Out</h3><p style="color:var(--muted);">The payment request was not completed.</p><a href="/survey" class="cta-btn">Try Again</a>'); clearInterval(timer);
                        } else if (d.status === 'review') {
                            show('<p style="margin:0; font-weight:bold;">We are confirming your payment and will call you shortly.</p>'); clearInterval(timer);
                        } else if (tries >= 60) {
                            show('<p style="margin:0;">We have not seen the payment yet. If you paid, we will confirm and call you.</p>'); clearInterval(timer);
                        }
                    }).catch(function () {});
                }
                check();
                timer = setInterval(check, 4000);
            })();
            </script>`
    }));
}));

// ---------------------------------------------------------------
// 17. My requests and receipts
// ---------------------------------------------------------------
const FLASH = {
    sent: { cls: 'ok', text: 'The receipt was emailed to you.' },
    failed: { cls: '', text: 'We could not send the email right now. You can still download the PDF.' }
};
app.get('/requests', requireAuth, requireDb, ah(async (req, res) => {
    const bookings = await listBookings(req.session.user.id);
    const flash = FLASH[String(req.query.msg || '')];

    let rowsHtml;
    if (bookings.length === 0) {
        rowsHtml = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--muted);">You have not made any service requests or bookings yet.<br><a href="/survey" style="font-weight:bold;">Book a Site Survey Now</a></td></tr>`;
    } else {
        rowsHtml = bookings.map(b => {
            const dateStr = new Date(b.createdAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
            const badge = b.status === 'paid' ? '<span class="badge paid">PAID & CONFIRMED</span>'
                : b.status === 'pending' ? '<span class="badge pending">PENDING PAYMENT</span>'
                    : `<span class="badge bad">${esc(b.status.toUpperCase())}</span>`;
            const action = b.status === 'paid'
                ? `<a href="/payments/receipt/${esc(b.id)}/download.pdf" class="cta-btn green small">📥 Download PDF</a>
                   <form action="/requests/${esc(b.id)}/resend" method="POST" class="inline-form"><button type="submit" class="cta-btn small">✉️ Email me</button></form>`
                : `<a href="/survey" style="font-size:0.85rem; font-weight:bold;">Book again</a>`;
            return `<tr>
                <td>${esc(dateStr)}</td>
                <td><strong>${esc(b.service)}</strong><br><small style="color:var(--muted);">${esc(b.location)}</small></td>
                <td>KES ${b.amount.toLocaleString('en-KE')}</td>
                <td>${esc(b.accountRef)}</td>
                <td>${badge}</td>
                <td>${esc(b.receipt || '-')}</td>
                <td style="display:flex; gap:6px; flex-wrap:wrap;">${action}</td>
            </tr>`;
        }).join('');
    }

    const content = `
        <div class="general-container">
            <h2>My Service Requests & Tracking</h2>
            <p class="sub-title">Monitor your bookings, payment statuses, and download official PDF receipts.</p>
            ${flash ? `<div class="alert ${flash.cls}" role="status">${esc(flash.text)}</div>` : ''}
            <div class="table-wrap">
                <table class="data-table">
                    <thead><tr><th>Date</th><th>Service & Location</th><th>Amount</th><th>Reference</th><th>Status</th><th>M-Pesa Receipt</th><th>Action</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
            <div style="margin-top: 30px; text-align: right;"><a href="/survey" class="cta-btn">+ Book Another Service</a></div>
        </div>`;
    res.send(renderPage(req, { title: 'My Requests', activeNav: 'requests', content }));
}));

app.post('/requests/:id/resend', requireAuth, resendLimiter, requireDb, ah(async (req, res) => {
    if (!validBookingId(req.params.id)) return res.redirect('/requests');
    const b = await getBookingForUser(req.params.id, req.session.user.id);
    if (!b || b.status !== 'paid') return res.redirect('/requests');
    const ok = await emailReceipt(b);
    res.redirect('/requests?msg=' + (ok ? 'sent' : 'failed'));
}));

// ---------------------------------------------------------------
// 18. Shareable booking page (signed link; details always come from the database)
// ---------------------------------------------------------------
const BOOKING_VIEWS = {
    paid: { h: 'Payment Receipt & Booking', sub: 'Payment received. Keep this page as your receipt.', badge: '<span class="badge paid">PAID & CONFIRMED</span>' },
    pending: { h: 'Booking Received', sub: 'We are waiting for your M-Pesa payment. This page refreshes by itself.', badge: '<span class="badge pending">AWAITING PAYMENT</span>' },
    failed: { h: 'Payment Not Completed', sub: 'The payment was cancelled or did not go through. You can book again.', badge: '<span class="badge bad">NOT PAID</span>' },
    review: { h: 'Confirming Your Payment', sub: 'We are checking your payment and will call you shortly.', badge: '<span class="badge pending">CHECKING</span>' }
};

app.get('/booking/:token', requireDb, ah(async (req, res) => {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store' });
    const id = readBookingLink(req.params.token);
    const b = id ? await getBooking(id) : null;
    if (!b) return errorPage(req, res, 404, 'This link is not valid', 'Please check the link you were sent, or call us on 0740 311 014.');

    const v = BOOKING_VIEWS[b.status] || BOOKING_VIEWS.pending;
    const isPaid = b.status === 'paid';
    const when = new Date(isPaid && b.paidAt ? b.paidAt : b.createdAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) + ' EAT';
    const row = (k, val) => `<p style="margin:8px 0;"><strong>${esc(k)}:</strong> ${val}</p>`;
    const refresh = b.status === 'pending' ? `
        <script nonce="${req.nonce}">
        (function () {
            var n = 0;
            try { n = Number(sessionStorage.getItem('bk-refresh') || 0); } catch (e) {}
            if (n >= 40) return;
            setTimeout(function () {
                try { sessionStorage.setItem('bk-refresh', String(n + 1)); } catch (e) {}
                location.reload();
            }, 8000);
        })();
        </script>` : '';
    const content = `
        <div class="general-container">
            <h2>${esc(v.h)}</h2>
            <p class="sub-title">${esc(v.sub)}</p>
            <div class="form-container">
                ${row('Status', v.badge)}
                ${row('Client Name', esc(b.name))}
                ${row('Phone Number', esc(b.phone))}
                ${row('Service', esc(b.service))}
                ${row('Location', esc(b.location))}
                ${breakdownLines(b).map(([k, v]) => row(k, esc(v))).join('')}
                ${row(isPaid ? 'Amount Paid' : 'Amount Due', 'KES ' + b.amount.toLocaleString('en-KE'))}
                ${isPaid ? row('M-Pesa Receipt', esc(b.receipt || 'See your M-Pesa SMS')) : ''}
                ${row('Reference', esc(b.accountRef))}
                ${row(isPaid ? 'Paid on' : 'Requested on', esc(when))}
                ${isPaid && PDFDocument ? `<div style="margin-top: 25px;"><a href="/booking/${esc(req.params.token)}/receipt.pdf" class="cta-btn green">Download Official PDF Receipt</a></div>` : ''}
                ${b.status === 'failed' ? '<div style="margin-top: 25px;"><a href="/survey" class="cta-btn">Book again</a></div>' : ''}
            </div>
        </div>${refresh}`;
    res.send(renderPage(req, { title: 'Receipt', activeNav: '', content }));
}));

app.get('/booking/:token/receipt.pdf', requireDb, ah(async (req, res) => {
    if (!PDFDocument) return errorPage(req, res, 501, 'Not available', 'Receipt download is not available right now.');
    const id = readBookingLink(req.params.token);
    const b = id ? await getBooking(id) : null;
    if (!b || b.status !== 'paid') return errorPage(req, res, 404, 'Receipt not found', 'This receipt is not available. It may not be paid yet.');
    sendPdf(res, await generatePdfBuffer(b), b.accountRef);
}));

// ---------------------------------------------------------------
// Contact page: call, WhatsApp, email, and a callback request (alerts go to you by Telegram/email)
// ---------------------------------------------------------------
const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: 'Too many requests from this network. Please call us on 0740 311 014.'
});
function contactPage(req, { error = '', sent = false, values = {} } = {}) {
    const content = `
        <div class="general-container">
            <h2>Contact Us</h2>
            <p class="sub-title">Call, message us on WhatsApp, or ask for a callback and an engineer will phone you.</p>
            ${sent ? `<div class="alert ok" role="status">Thank you${values.name ? ', ' + esc(values.name) : ''}. We have received your request and will call you shortly.</div>` : ''}
            ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
            <div class="form-container">
                <p style="margin-top:0;">📞 <strong>Calls:</strong> <a href="tel:+254740311014">0740 311 014</a></p>
                <p>💬 <strong>WhatsApp:</strong> <a href="https://wa.me/254769306917" target="_blank" rel="noopener">0769 306 917</a></p>
                <p>✉️ <strong>Email:</strong> <a href="mailto:tencentbz@gmail.com">tencentbz@gmail.com</a></p>
                <p style="margin-bottom:0;">📍 <strong>Location:</strong> Rangwe, Homa Bay County, Kenya</p>
            </div>
            <div class="form-container">
                <h3 style="margin-top:0; color:var(--primary);">Request a callback</h3>
                <form action="/contact" method="POST">
                    <div class="form-group"><label for="c-name">Your Name</label><input id="c-name" type="text" name="name" required maxlength="80" autocomplete="name" placeholder="e.g. John Otieno" value="${esc(values.name || '')}"></div>
                    <div class="form-group"><label for="c-phone">Phone Number</label><input id="c-phone" type="tel" name="phone" required autocomplete="tel" placeholder="0712345678" value="${esc(values.phone || '')}"></div>
                    <div class="form-group"><label for="c-msg">How can we help?</label><textarea id="c-msg" name="message" rows="4" required maxlength="600" placeholder="e.g. I need CCTV installed at my shop in Rangwe">${esc(values.message || '')}</textarea></div>
                    <button type="submit" class="cta-btn block">Request Callback</button>
                </form>
            </div>
        </div>`;
    return renderPage(req, { title: 'Contact Us', activeNav: 'contact', content });
}
app.get('/contact', (req, res) => res.send(contactPage(req)));
app.post('/contact', contactLimiter, ah(async (req, res) => {
    const values = { name: str(req.body.name).slice(0, 80), phone: str(req.body.phone).slice(0, 30), message: str(req.body.message).slice(0, 600) };
    if (!values.name || !values.message) return res.status(400).send(contactPage(req, { error: 'Please enter your name and a short message.', values }));
    if (!normalizePhone(values.phone)) return res.status(400).send(contactPage(req, { error: 'Please enter a valid phone number, for example 0712345678.', values }));
    await notify(`📞 Callback request: ${values.name}`, { Name: values.name, Phone: values.phone, Message: values.message });
    res.send(contactPage(req, { sent: true, values: { name: values.name } }));
}));

// ---------------------------------------------------------------
// 19. Terms and Conditions
// ---------------------------------------------------------------
app.get('/terms', (req, res) => {
    const content = `
        <div class="general-container terms">
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
    res.send(renderPage(req, { title: 'Terms and Conditions', activeNav: 'terms', content }));
});


// USSD endpoint (the USSD gateway posts here; no login, no cookies)
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

// ---------------------------------------------------------------
// 20. Not found, errors, start
// ---------------------------------------------------------------
app.use((req, res) => errorPage(req, res, 404, 'Page not found', 'We could not find that page.'));

// One place that catches every error, so a database hiccup cannot crash the server
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    console.error('Request error:', err && err.message ? err.message : err);
    if (res.headersSent) return;
    const status = err && (err.status === 400 || err.type === 'entity.too.large') ? (err.status || 413) : 500;
    try {
        errorPage(req, res, status, status === 500 ? 'Something went wrong' : 'Bad request',
            status === 500 ? 'Something went wrong on our side. Please try again in a moment.' : 'We could not read that request.');
    } catch (_) {
        res.status(status).type('text/plain').send('Something went wrong.');
    }
});

(async () => {
    await initDb();   // wait for the tables before taking traffic (it keeps retrying in the background if the database is down)
    app.listen(PORT, () => console.log(`Tencent Innovations server running on port ${PORT}`));
})();
