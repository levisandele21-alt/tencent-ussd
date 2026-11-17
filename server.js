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
const axios = require('axios');

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
            scriptSrc: ["'self'", "https://cdn.jsdelivr.net", (req, res) => `'nonce-${res.locals.nonce}'`],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            imgSrc: ["'self'", 'data:'],
            mediaSrc: ["'self'"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
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
    skip: req => req.path.startsWith('/payments/cb/') || req.path.startsWith('/payments/status/') || req.path.startsWith('/api/pos/mpesa/callback/')
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
const forgotLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
    message: 'Too many password reset requests from this network. Please try again later.'
});
const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    message: 'Too many attempts. Please wait a few minutes and try again.'
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
        // Email confirmation and password reset
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS auth_tokens (
                id SERIAL PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind VARCHAR(10) NOT NULL,
                token_hash CHAR(64) NOT NULL UNIQUE,
                expires_at BIGINT NOT NULL,
                used_at BIGINT,
                created_at BIGINT NOT NULL
            )`);
        
        // --- Multi-Tenant POS Tables ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS businesses (
                id SERIAL PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                owner_id INT REFERENCES users(id) ON DELETE CASCADE,
                mpesa_shortcode VARCHAR(20),
                mpesa_passkey TEXT,
                mpesa_consumer_key TEXT,
                mpesa_consumer_secret TEXT,
                mpesa_type VARCHAR(30) DEFAULT 'CustomerBuyGoodsOnline',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
                barcode VARCHAR(50),
                name VARCHAR(150) NOT NULL,
                price DECIMAL(10, 2) NOT NULL,
                stock_qty INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS pos_sales (
                id SERIAL PRIMARY KEY,
                business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
                receipt_number VARCHAR(50) UNIQUE NOT NULL,
                total_amount DECIMAL(10, 2) NOT NULL,
                payment_method VARCHAR(20) NOT NULL,
                payment_status VARCHAR(20) DEFAULT 'PENDING',
                mpesa_checkout_id VARCHAR(100),
                mpesa_receipt_no VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS pos_sale_items (
                id SERIAL PRIMARY KEY,
                sale_id INT REFERENCES pos_sales(id) ON DELETE CASCADE,
                product_id INT REFERENCES products(id),
                quantity INT NOT NULL,
                unit_price DECIMAL(10, 2) NOT NULL
            )`);

        await pool.query('CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, kind)');
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
    if (req.method !== 'POST' || req.path.startsWith('/payments/cb/') || req.path.startsWith('/api/pos/mpesa/callback/')) return next();
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
const NEXT_ALLOWED = new Set(['/', '/wifi', '/cctv', '/smart-locks', '/electric-fence', '/solar', '/survey', '/requests', '/terms', '/contact', '/pos']);
function safeNext(value) {
    const v = typeof value === 'string' ? value : '';
    if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/survey';
    const pathOnly = v.split('?')[0].split('#')[0];
    return NEXT_ALLOWED.has(pathOnly) ? pathOnly : '/survey';
}

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    if (req.method === 'GET') return res.redirect('/login?next=' + encodeURIComponent(safeNext(req.path)));
    return res.status(401).json({ error: 'Unauthorized' });
}
function requireDb(req, res, next) {
    if (dbReady) return next();
    return errorPage(req, res, 503, 'Please try again shortly', dbEnabled
        ? 'Our booking system is starting up. Please try again in a minute.'
        : 'Accounts are not switched on yet. Please call us on 0740 311 014.');
}
const regenerateSession = req => new Promise((resolve, reject) => req.session.regenerate(err => (err ? reject(err) : resolve())));
const saveSession = req => new Promise((resolve, reject) => req.session.save(err => (err ? reject(err) : resolve())));

// Booking needs a confirmed email, so receipts can only ever go to an inbox the customer controls
async function requireVerified(req, res, next) {
    try {
        const u = req.session && req.session.user;
        if (!u) return res.redirect('/login');
        if (u.verified) return next();
        const r = await pool.query('SELECT email_verified FROM users WHERE id = $1', [u.id]);   // may have been confirmed in another browser
        if (r.rows[0] && r.rows[0].email_verified) {
            u.verified = true;
            return next();
        }
        return res.redirect('/verify-email/pending');
    } catch (err) { next(err); }
}

// Passwords
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', '11111111', '00000000', 'iloveyou1', 'tencent123']);
function passwordProblem(password, confirm, email = '') {
    if (password.length < 8) return 'Your password must be at least 8 characters.';
    if (Buffer.byteLength(password) > 72) return 'Your password is too long. Please use 72 characters or fewer.';
    if (COMMON_PASSWORDS.has(password.toLowerCase()) || (email && password.toLowerCase() === email.toLowerCase())) return 'That password is too easy to guess. Please choose a different one.';
    if (password !== confirm) return 'The two passwords do not match.';
    return '';
}

// Lockout: 6 wrong passwords for the same email within 15 minutes locks sign-in for that email for 15 minutes.
// Unknown emails are counted the same way, so the lock message never reveals whether an account exists.
// Resetting the password through the emailed link clears the lock.
const LOCK_AFTER = 6, LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map();   // email -> { count, first, lockedUntil }
function lockedMinutes(email) {
    const f = loginFails.get(email);
    return f && f.lockedUntil > Date.now() ? Math.ceil((f.lockedUntil - Date.now()) / 60000) : 0;
}
function recordLoginFailure(email) {
    const now = Date.now();
    let f = loginFails.get(email);
    if (!f || now - f.first > LOCK_MS) f = { count: 0, first: now, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= LOCK_AFTER) f.lockedUntil = now + LOCK_MS;
    loginFails.set(email, f);
}
const clearLoginFailures = email => loginFails.delete(email);
setInterval(() => {
    const now = Date.now();
    for (const [k, f] of loginFails) if (now - f.first > LOCK_MS && f.lockedUntil < now) loginFails.delete(k);
    for (const [k, t] of emailCooldown) if (now - t > 10 * 60 * 1000) emailCooldown.delete(k);
}, 10 * 60 * 1000).unref();

// One-time links sent by email (confirm email, reset password). Only a hash is stored, so a database leak cannot be used to take over accounts.
const emailCooldown = new Map();   // "kind:userId" -> last send time
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
async function createAuthToken(userId, kind, ttlMs) {
    const raw = crypto.randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1 AND kind = $2', [userId, kind]);   // only the newest link works
    await pool.query('INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
        [userId, kind, sha256(raw), Date.now() + ttlMs, Date.now()]);
    return raw;
}
async function peekAuthToken(raw, kind) {
    if (!TOKEN_FORMAT.test(String(raw || ''))) return null;
    const r = await pool.query('SELECT user_id FROM auth_tokens WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3', [sha256(raw), kind, Date.now()]);
    return r.rows[0] ? r.rows[0].user_id : null;
}
async function useAuthToken(raw, kind) {   // atomic: a link can only be used once, even if clicked twice at the same moment
    if (!TOKEN_FORMAT.test(String(raw || ''))) return null;
    const r = await pool.query('UPDATE auth_tokens SET used_at = $3 WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id', [sha256(raw), kind, Date.now()]);
    return r.rows[0] ? r.rows[0].user_id : null;
}
function cooldownOk(kind, userId, ms) {
    const key = kind + ':' + userId, now = Date.now();
    if (now - (emailCooldown.get(key) || 0) < ms) return false;
    emailCooldown.set(key, now);
    return true;
}
// Links in emails always use your own address from PUBLIC_BASE_URL, never the Host header (that would let an attacker poison reset links)
function emailLink(path) {
    if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is not set, so account emails cannot be sent');
    return PUBLIC_BASE_URL + path;
}
const mailShell = (heading, bodyHtml) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#17323a;line-height:1.5;"><h2 style="margin:0 0 12px;">${heading}</h2>${bodyHtml}<p style="color:#5b7078;font-size:13px;margin-top:24px;">Tencent Innovations, Rangwe, Homa Bay County. Calls 0740 311 014</p></div>`;
const mailButton = (href, label) => `<p style="margin:20px 0;"><a href="${esc(href)}" style="display:inline-block;background:#f4b400;color:#2a1f00;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">${esc(label)}</a></p><p style="font-size:13px;color:#5b7078;">If the button does not work, copy this link into your browser:<br>${esc(href)}</p>`;

async function sendVerificationEmail(user) {
    const link = emailLink('/verify-email?token=' + await createAuthToken(user.id, 'verify', 24 * 60 * 60 * 1000));
    await sendMail({
        to: user.email,
        subject: 'Confirm your email address - Tencent Innovations',
        html: mailShell('Confirm your email', `<p>Hello ${esc(user.name)}, please confirm your email address so we can send your receipts here and let you book services.</p>${mailButton(link, 'Confirm my email')}<p style="font-size:13px;">This link works for 24 hours. If you did not create an account, you can ignore this email.</p>`),
        text: `Hello ${user.name},\n\nConfirm your email address so we can send your receipts here and let you book services:\n${link}\n\nThis link works for 24 hours. If you did not create an account, ignore this email.\n`
    });
}
async function sendResetEmail(user) {
    const link = emailLink('/reset-password?token=' + await createAuthToken(user.id, 'reset', 60 * 60 * 1000));
    await sendMail({
        to: user.email,
        subject: 'Reset your password - Tencent Innovations',
        html: mailShell('Reset your password', `<p>Hello ${esc(user.name)}, we received a request to reset your password.</p>${mailButton(link, 'Choose a new password')}<p style="font-size:13px;">This link works for 1 hour and can be used once. If you did not ask for this, ignore this email; your password stays the same.</p>`),
        text: `Hello ${user.name},\n\nReset your password here (valid for 1 hour, one use):\n${link}\n\nIf you did not ask for this, ignore this email; your password stays the same.\n`
    });
}
async function sendPasswordChangedEmail(user) {
    await sendMail({
        to: user.email,
        subject: 'Your password was changed - Tencent Innovations',
        html: mailShell('Password changed', `<p>Hello ${esc(user.name)}, the password for your Tencent Innovations account was just changed and you were signed out everywhere.</p><p>If this was not you, call us right away on 0740 311 014 and reset your password again.</p>`),
        text: `Hello ${user.name},\n\nThe password for your Tencent Innovations account was just changed and you were signed out everywhere.\nIf this was not you, call 0740 311 014 and reset your password again.\n`
    });
}
const quietly = (label, promise) => promise.catch(err => console.error(label + ':', err.message));

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
// POS API & Terminal Routes
// ---------------------------------------------------------------
async function getTenantMpesaToken(businessId) {
    const res = await pool.query(
        'SELECT mpesa_consumer_key, mpesa_consumer_secret FROM businesses WHERE id = $1', 
        [businessId]
    );
    if (!res.rows.length || !res.rows[0].mpesa_consumer_key) {
        throw new Error('M-Pesa credentials not configured for this business.');
    }
    const { mpesa_consumer_key, mpesa_consumer_secret } = res.rows[0];
    const auth = Buffer.from(`${mpesa_consumer_key}:${mpesa_consumer_secret}`).toString('base64');
    
    const baseUrl = process.env.MPESA_ENV === 'production' 
        ? 'https://api.safaricom.co.ke' 
        : 'https://sandbox.safaricom.co.ke';

    const tokenRes = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` }
    });
    return { token: tokenRes.data.access_token, baseUrl };
}

app.get('/api/pos/products', requireAuth, ah(async (req, res) => {
    const businessId = req.query.business_id || 1;
    const result = await pool.query('SELECT * FROM products WHERE business_id = $1 ORDER BY name ASC', [businessId]);
    res.json(result.rows);
}));

app.post('/api/pos/checkout/cash', requireAuth, ah(async (req, res) => {
    const { business_id = 1, items, total_amount } = req.body;
    const receiptNumber = 'POS-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const saleRes = await client.query(
            `INSERT INTO pos_sales (business_id, receipt_number, total_amount, payment_method, payment_status)
             VALUES ($1, $2, $3, 'CASH', 'COMPLETED') RETURNING id`,
            [business_id, receiptNumber, total_amount]
        );
        const saleId = saleRes.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO pos_sale_items (sale_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)`,
                [saleId, item.product_id, item.quantity, item.unit_price]
            );
            await client.query(
                `UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2`,
                [item.quantity, item.product_id]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, receipt_number: receiptNumber });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

app.post('/api/pos/checkout/mpesa', requireAuth, ah(async (req, res) => {
    const { business_id = 1, phone, items, total_amount } = req.body;
    const receiptNumber = 'POS-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    let bizRes = await pool.query('SELECT * FROM businesses WHERE id = $1', [business_id]);
    if (!bizRes.rows.length) {
        const newBiz = await pool.query(
            `INSERT INTO businesses (name, mpesa_shortcode, mpesa_passkey, mpesa_consumer_key, mpesa_consumer_secret)
             VALUES ('Demo Shop', '174379', 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919', $1, $2) RETURNING *`,
            [process.env.MPESA_CONSUMER_KEY || 'demo', process.env.MPESA_SECRET || 'demo']
        );
        bizRes = newBiz;
    }
    const biz = bizRes.rows[0];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const saleRes = await client.query(
            `INSERT INTO pos_sales (business_id, receipt_number, total_amount, payment_method, payment_status)
             VALUES ($1, $2, $3, 'MPESA', 'PENDING') RETURNING id`,
            [business_id, receiptNumber, total_amount]
        );
        const saleId = saleRes.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO pos_sale_items (sale_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)`,
                [saleId, item.product_id, item.quantity, item.unit_price]
            );
        }

        const { token, baseUrl } = await getTenantMpesaToken(business_id);
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${biz.mpesa_shortcode}${biz.mpesa_passkey}${timestamp}`).toString('base64');
        const formattedPhone = phone.startsWith('0') ? '254' + phone.slice(1) : phone;

        const stkRes = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
            BusinessShortCode: biz.mpesa_shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: biz.mpesa_type || 'CustomerBuyGoodsOnline',
            Amount: Math.ceil(total_amount),
            PartyA: formattedPhone,
            PartyB: biz.mpesa_shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: `${PUBLIC_BASE_URL}/api/pos/mpesa/callback/${saleId}`,
            AccountReference: receiptNumber,
            TransactionDesc: `POS Sale ${receiptNumber}`
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        await client.query(
            `UPDATE pos_sales SET mpesa_checkout_id = $1 WHERE id = $2`,
            [stkRes.data.CheckoutRequestID, saleId]
        );

        await client.query('COMMIT');
        res.json({ success: true, sale_id: saleId, checkout_request_id: stkRes.data.CheckoutRequestID });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

app.post('/api/pos/mpesa/callback/:saleId', ah(async (req, res) => {
    const { saleId } = req.params;
    const body = req.body.Body.stkCallback;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (body.ResultCode === 0) {
            const metadata = body.CallbackMetadata.Item;
            const mpesaReceipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;

            await client.query(
                `UPDATE pos_sales SET payment_status = 'COMPLETED', mpesa_receipt_no = $1 WHERE id = $2`,
                [mpesaReceipt, saleId]
            );

            const itemsRes = await client.query('SELECT product_id, quantity FROM pos_sale_items WHERE sale_id = $1', [saleId]);
            for (const item of itemsRes.rows) {
                await client.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2', [item.quantity, item.product_id]);
            }
        } else {
            await client.query(`UPDATE pos_sales SET payment_status = 'FAILED' WHERE id = $1`, [saleId]);
        }
        await client.query('COMMIT');
        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
}));

app.get('/api/pos/sales/:id/status', requireAuth, ah(async (req, res) => {
    const result = await pool.query('SELECT payment_status, receipt_number, mpesa_receipt_no FROM pos_sales WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Sale not found' });
    res.json(result.rows[0]);
}));

app.get('/api/pos/seed', requireAuth, ah(async (req, res) => {
    await pool.query(`
        INSERT INTO businesses (id, name, mpesa_shortcode) 
        VALUES (1, 'Demo Shop', '174379')
        ON CONFLICT (id) DO NOTHING;
    `);

    const existing = await pool.query('SELECT COUNT(*) FROM products WHERE business_id = 1');
    if (parseInt(existing.rows[0].count) === 0) {
        await pool.query(`
            INSERT INTO products (business_id, barcode, name, price, stock_qty) VALUES
            (1, '071234567890', 'Smart Extension Cord (3-Way)', 1250.00, 45),
            (1, '071234567891', 'CAT6 Ethernet Cable (10m)', 650.00, 120),
            (1, '071234567892', 'Solar LED Bulb (12W)', 350.00, 80),
            (1, '071234567893', '12V DC Cooling Fan', 900.00, 25),
            (1, '071234567894', 'Digital Multimeter (DT-830B)', 750.00, 30),
            (1, '071234567895', 'Type-C Fast Charging Cable', 400.00, 150);
        `);
        return res.json({ success: true, message: 'Sample products added successfully!' });
    }
    res.json({ success: true, message: 'Products already exist.' });
}));

app.get('/pos', requireAuth, (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>POS Terminal - Service</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
</head>
<body class="bg-gray-100 h-screen flex flex-col">
    <header class="bg-slate-900 text-white px-6 py-4 flex justify-between items-center shadow">
        <h1 class="text-xl font-bold">⚡ Cloud POS Terminal</h1>
        <div class="flex items-center gap-4">
            <a href="/" class="text-sm text-sky-400 hover:underline">← Back to Website</a>
            <div class="text-sm text-slate-300">Logged in as: ${esc(req.session.user.name)}</div>
        </div>
    </header>

    <div class="flex-1 flex overflow-hidden">
        <!-- Products Grid -->
        <div class="flex-1 p-6 overflow-y-auto">
            <div class="mb-4">
                <input type="text" id="search" placeholder="Search products or scan barcode..." class="w-full px-4 py-2 bg-white rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <div id="product-grid" class="grid grid-cols-3 gap-4">
                <!-- Populated via JS -->
            </div>
        </div>

        <!-- Cart & Checkout Sidebar -->
        <div class="w-96 bg-white border-l border-gray-200 flex flex-col shadow-lg">
            <div class="p-4 border-b border-gray-200 font-bold text-lg bg-gray-50">Current Sale</div>
            <div id="cart-items" class="flex-1 p-4 overflow-y-auto space-y-3">
                <p class="text-gray-400 text-center mt-10">Cart is empty</p>
            </div>
            <div class="p-4 border-t border-gray-200 bg-gray-50 space-y-3">
                <div class="flex justify-between text-xl font-bold">
                    <span>Total:</span>
                    <span id="cart-total">KES 0.00</span>
                </div>
                <button onclick="checkoutCash()" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 rounded-lg shadow transition">Pay with Cash</button>
                <button onclick="openMpesaModal()" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg shadow transition">Pay with M-Pesa</button>
            </div>
        </div>
    </div>

    <!-- M-Pesa Modal -->
    <div id="mpesa-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center">
        <div class="bg-white p-6 rounded-xl w-96 space-y-4 shadow-2xl">
            <h3 class="text-lg font-bold">Enter M-Pesa Phone Number</h3>
            <input type="text" id="mpesa-phone" placeholder="07XXXXXXXX" class="w-full px-4 py-2 border rounded-lg">
            <div class="flex space-x-2">
                <button onclick="closeMpesaModal()" class="flex-1 bg-gray-300 py-2 rounded-lg font-medium">Cancel</button>
                <button onclick="checkoutMpesa()" class="flex-1 bg-green-600 text-white py-2 rounded-lg font-bold">Send STK Push</button>
            </div>
        </div>
    </div>

    <script>
        let products = [];
        let cart = [];

        async function loadProducts() {
            const res = await fetch('/api/pos/products?business_id=1');
            products = await res.json();
            renderProducts(products);
        }

        function renderProducts(itemsToRender) {
            const grid = document.getElementById('product-grid');
            if (!itemsToRender.length) {
                grid.innerHTML = '<p class="col-span-3 text-center text-gray-400 py-10">No products found</p>';
                return;
            }
            grid.innerHTML = itemsToRender.map(p => \`
                <div onclick="addToCart(\${p.id})" class="bg-white p-4 rounded-xl shadow-sm border border-gray-200 cursor-pointer hover:border-blue-500 transition flex flex-col justify-between">
                    <div>
                        <h4 class="font-bold text-gray-800">\${p.name}</h4>
                        <p class="text-xs text-gray-500">Barcode: \${p.barcode || 'N/A'}</p>
                        <p class="text-xs text-gray-500">Stock: \${p.stock_qty}</p>
                    </div>
                    <p class="text-blue-600 font-extrabold mt-4">KES \${Number(p.price).toLocaleString()}</p>
                </div>
            \`).join('');
        }

        const searchInput = document.getElementById('search');
        
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const filtered = products.filter(p => 
                p.name.toLowerCase().includes(query) || (p.barcode && p.barcode.toLowerCase().includes(query))
            );
            renderProducts(filtered);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const query = searchInput.value.trim();
                const matched = products.find(p => p.barcode === query || p.name.toLowerCase() === query.toLowerCase());
                if (matched) {
                    addToCart(matched.id);
                    searchInput.value = '';
                    renderProducts(products);
                } else {
                    const filtered = products.filter(p => p.name.toLowerCase().includes(query.toLowerCase()) || (p.barcode && p.barcode.includes(query)));
                    if (filtered.length === 1) {
                        addToCart(filtered[0].id);
                        searchInput.value = '';
                        renderProducts(products);
                    } else {
                        alert('Product not found for scan/search: ' + query);
                    }
                }
            }
        });

        function addToCart(id) {
            const product = products.find(p => p.id === id);
            if (!product) return;
            if (product.stock_qty <= 0) return alert('Out of stock!');

            const existing = cart.find(item => item.product_id === id);
            if (existing) {
                if (existing.quantity >= product.stock_qty) return alert('Cannot exceed available stock.');
                existing.quantity++;
            } else {
                cart.push({ product_id: product.id, name: product.name, unit_price: Number(product.price), quantity: 1 });
            }
            renderCart();
            searchInput.focus();
        }

        function renderCart() {
            const container = document.getElementById('cart-items');
            if (!cart.length) {
                container.innerHTML = '<p class="text-gray-400 text-center mt-10">Cart is empty</p>';
                document.getElementById('cart-total').innerText = 'KES 0.00';
                return;
            }
            container.innerHTML = cart.map((item, idx) => \`
                <div class="flex justify-between items-center bg-gray-50 p-2 rounded border">
                    <div>
                        <h5 class="font-bold text-sm">\${item.name}</h5>
                        <p class="text-xs text-gray-500">\${item.quantity} x KES \${item.unit_price.toLocaleString()}</p>
                    </div>
                    <button onclick="cart.splice(\${idx}, 1); renderCart();" class="text-red-500 font-bold text-sm px-2">✕</button>
                </div>
            \`).join('');
            const total = cart.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0);
            document.getElementById('cart-total').innerText = 'KES ' + total.toLocaleString();
        }

        async function checkoutCash() {
            if (!cart.length) return alert('Cart is empty');
            const total = cart.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0);
            const res = await fetch('/api/pos/checkout/cash', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ business_id: 1, items: cart, total_amount: total })
            });
            const data = await res.json();
            if (data.success) {
                alert('Sale completed! Receipt: ' + data.receipt_number);
                cart = [];
                renderCart();
                loadProducts();
                searchInput.focus();
            } else {
                alert('Checkout failed');
            }
        }

        function openMpesaModal() {
            if (!cart.length) return alert('Cart is empty');
            document.getElementById('mpesa-modal').classList.remove('hidden');
        }
        function closeMpesaModal() {
            document.getElementById('mpesa-modal').classList.add('hidden');
        }

        async function checkoutMpesa() {
            const phone = document.getElementById('mpesa-phone').value;
            if (!phone) return alert('Enter phone number');
            closeMpesaModal();

            const total = cart.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0);
            const res = await fetch('/api/pos/checkout/mpesa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ business_id: 1, phone, items: cart, total_amount: total })
            });
            const data = await res.json();
            if (!data.success) return alert('STK Push failed to start');

            const saleId = data.sale_id;
            alert('STK Push sent! Waiting for customer PIN...');

            let attempts = 0;
            const interval = setInterval(async () => {
                attempts++;
                const statusRes = await fetch(\`/api/pos/sales/\${saleId}/status\`);
                const statusData = await statusRes.json();

                if (statusData.payment_status === 'COMPLETED') {
                    clearInterval(interval);
                    alert('Payment successful! M-Pesa Receipt: ' + statusData.mpesa_receipt_no);
                    cart = [];
                    renderCart();
                    loadProducts();
                    searchInput.focus();
                } else if (statusData.payment_status === 'FAILED' || attempts > 20) {
                    clearInterval(interval);
                    if (statusData.payment_status === 'FAILED') alert('Payment failed or cancelled.');
                }
            }, 3000);
        }

        window.onload = () => {
            loadProducts();
            searchInput.focus();
        };
    </script>
</body>
</html>`);
});

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
        .hero-cta { display: inline-block; background: #38bdf8; color: #0f172a; padding: 12px 28px; border-radius: 30px; font-weight: bold; text
