const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// PDF receipts need the "pdfkit" package.
let PDFDocument = null;
try {
    PDFDocument = require('pdfkit');
} catch (_) {
    console.error('pdfkit is not installed: PDF receipts are disabled.');
}

const app = express();

// Security headers must be applied before routes and static responses.
app.use(helmet({ contentSecurityPolicy: false }));

// Serve only intentional public assets.
app.use('/public', express.static(path.join(__dirname, 'public'), {
    index: false,
    dotfiles: 'deny',
    fallthrough: true
}));

app.set('trust proxy', 1);

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    skip: (req) =>
        req.path.startsWith('/payments/cb/') ||
        req.path.startsWith('/payments/status/')
});

const payLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many payment attempts from this network. Please try again later.'
});

app.use(limiter);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. PostgreSQL is required for startup.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

app.use(session({
    store: new PgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET ||
        (process.env.NODE_ENV === 'production'
            ? (() => {
                throw new Error('SESSION_SECRET is required in production.');
            })()
            : crypto.randomBytes(32).toString('hex')),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

function requireLogin(req, res, next) {
    if (req.session && req.session.user) return next();

    const nextPath = encodeURIComponent(req.originalUrl || '/dashboard');
    return res.redirect(`/login?next=${nextPath}`);
}

function safeNext(value) {
    if (
        typeof value !== 'string' ||
        !value.startsWith('/') ||
        value.startsWith('//') ||
        value.includes('\\')
    ) {
        return '/dashboard';
    }

    return value;
}

async function persistBooking(b) {
    if (!b || !b.id) return;

    await pool.query(
        `INSERT INTO customer_bookings
        (booking_id, customer_id, email, name, phone, service, location,
         amount, account_ref, status, created_at, paid_at, receipt,
         checkout_request_id, last_query, receipt_email_sent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (booking_id) DO UPDATE SET
        customer_id=EXCLUDED.customer_id,
        email=EXCLUDED.email,
        name=EXCLUDED.name,
        phone=EXCLUDED.phone,
        service=EXCLUDED.service,
        location=EXCLUDED.location,
        amount=EXCLUDED.amount,
        account_ref=EXCLUDED.account_ref,
        status=EXCLUDED.status,
        paid_at=EXCLUDED.paid_at,
        receipt=EXCLUDED.receipt,
        checkout_request_id=EXCLUDED.checkout_request_id,
        last_query=EXCLUDED.last_query,
        receipt_email_sent=EXCLUDED.receipt_email_sent`,
        [
            b.id,
            b.customerId || null,
            b.email || '',
            b.name,
            b.phone,
            b.service,
            b.location,
            b.amount,
            b.accountRef,
            b.status,
            b.createdAt,
            b.paidAt || null,
            b.receipt || '',
            b.checkoutRequestId || null,
            b.lastQuery || null,
            Boolean(b.receiptEmailSent)
        ]
    );
}

async function initDatabase() {
    if (!process.env.DATABASE_URL) {
        throw new Error(
            'DATABASE_URL is required. Add a PostgreSQL database on Render.'
        );
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS customers (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS customer_bookings (
            booking_id TEXT PRIMARY KEY,
            customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
            email TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            service TEXT NOT NULL,
            location TEXT NOT NULL,
            amount INTEGER NOT NULL,
            account_ref TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at BIGINT NOT NULL,
            paid_at BIGINT,
            receipt TEXT NOT NULL DEFAULT '',
            checkout_request_id TEXT UNIQUE,
            last_query BIGINT,
            receipt_email_sent BOOLEAN NOT NULL DEFAULT FALSE
        );

        CREATE INDEX IF NOT EXISTS customer_bookings_customer_idx
        ON customer_bookings(customer_id);
    `);

    const result = await pool.query('SELECT * FROM customer_bookings');

    for (const row of result.rows) {
        const b = {
            id: row.booking_id,
            customerId: row.customer_id == null
                ? null
                : String(row.customer_id),
            email: row.email,
            name: row.name,
            phone: row.phone,
            service: row.service,
            location: row.location,
            amount: Number(row.amount),
            accountRef: row.account_ref,
            status: row.status,
            createdAt: Number(row.created_at),
            paidAt: row.paid_at == null
                ? null
                : Number(row.paid_at),
            receipt: row.receipt || '',
            checkoutRequestId: row.checkout_request_id || undefined,
            lastQuery: row.last_query == null
                ? 0
                : Number(row.last_query),
            receiptEmailSent: Boolean(row.receipt_email_sent)
        };

        if (
            b.status === 'paid' ||
            Date.now() - b.createdAt < 24 * 60 * 60 * 1000
        ) {
            bookings.set(b.id, b);

            if (b.checkoutRequestId) {
                byCheckout.set(b.checkoutRequestId, b);
            }
        }
    }
}

// ---------------------------------------------------------------
// Email notifications (Gmail via Nodemailer)
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
    return Array.isArray(value)
        ? value.join(', ')
        : (value || '');
}

async function notify(subject, fields) {
    const cleanSubject = String(subject)
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 150);

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

    const time = new Date().toLocaleString('en-KE', {
        timeZone: 'Africa/Nairobi'
    });

    console.log('LEAD:', JSON.stringify({
        subject: cleanSubject,
        fields,
        time
    }));

    const sendTelegram = async () => {
        if (!process.env.TELEGRAM_TOKEN ||
            !process.env.TELEGRAM_CHAT_ID) return;

        const lines = Object.entries(fields)
            .map(([label, val]) => `${label}: ${flat(val)}`);

        const text = `${cleanSubject}\n\n${lines.join('\n')}\n\n${time} (EAT)`
            .slice(0, 4000);

        const resp = await fetch(
            `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: process.env.TELEGRAM_CHAT_ID,
                    text
                }),
                signal: AbortSignal.timeout(8000)
            }
        );

        if (!resp.ok) {
            throw new Error(`Telegram HTTP ${resp.status}`);
        }
    };

    const sendEmail = async () => {
        if (!process.env.GMAIL_USER ||
            !process.env.GMAIL_APP_PASSWORD) return;

        await mailer.sendMail({
            from: `"Tencent Website" <${process.env.GMAIL_USER}>`,
            to: process.env.NOTIFY_TO || process.env.GMAIL_USER,
            subject: cleanSubject,
            html: `<h3>${esc(cleanSubject)}</h3>${rows}<p style="color:#888">Received ${esc(time)} (EAT)</p>`
        });
    };
	    const results = await Promise.allSettled([
        sendTelegram(),
        sendEmail()
    ]);

    if (results[0].status === 'rejected') {
        console.error(
            'Telegram notification failed:',
            results[0].reason?.message
        );
    }

    if (results[1].status === 'rejected') {
        console.error(
            'Notification email failed:',
            results[1].reason?.message
        );
    }
}

// ---------------------------------------------------------------
// M-Pesa (Daraja) STK Push
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
    (MPESA.production
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke');

function mpesaConfigured() {
    return Boolean(
        MPESA.key &&
        MPESA.secret &&
        MPESA.shortcode &&
        MPESA.passkey &&
        MPESA.callbackSecret &&
        MPESA.callbackSecret.length >= 16 &&
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
    let phone = String(raw || '').replace(/[\s\-()]/g, '');

    if (phone.startsWith('+')) {
        phone = phone.slice(1);
    }

    if (/^0[17]\d{8}$/.test(phone)) {
        phone = '254' + phone.slice(1);
    } else if (/^[17]\d{8}$/.test(phone)) {
        phone = '254' + phone;
    }

    return /^254[17]\d{8}$/.test(phone) ? phone : null;
}

const bookings = new Map();
const byCheckout = new Map();
const phoneAttempts = new Map();

function phoneAttemptAllowed(phone) {
    const now = Date.now();

    const recent = (phoneAttempts.get(phone) || [])
        .filter(time => now - time < 60 * 60 * 1000);

    if (recent.length >= 3) {
        phoneAttempts.set(phone, recent);
        return false;
    }

    recent.push(now);
    phoneAttempts.set(phone, recent);
    return true;
}

setInterval(() => {
    const now = Date.now();

    for (const [id, booking] of bookings) {
        if (
            booking.status !== 'paid' &&
            now - booking.createdAt > 24 * 60 * 60 * 1000
        ) {
            bookings.delete(id);

            if (booking.checkoutRequestId) {
                byCheckout.delete(booking.checkoutRequestId);
            }
        }
    }

    for (const [phone, attempts] of phoneAttempts) {
        const recent = attempts.filter(
            time => now - time < 60 * 60 * 1000
        );

        if (recent.length) {
            phoneAttempts.set(phone, recent);
        } else {
            phoneAttempts.delete(phone);
        }
    }
}, 30 * 60 * 1000).unref();

let tokenCache = {
    value: null,
    expiresAt: 0
};

async function getAccessToken() {
    if (
        tokenCache.value &&
        Date.now() < tokenCache.expiresAt
    ) {
        return tokenCache.value;
    }

    const auth = Buffer.from(
        `${MPESA.key}:${MPESA.secret}`
    ).toString('base64');

    const response = await fetch(
        `${MPESA.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
            headers: {
                Authorization: `Basic ${auth}`
            },
            signal: AbortSignal.timeout(15000)
        }
    );

    if (!response.ok) {
        throw new Error(
            `Daraja authentication failed (HTTP ${response.status})`
        );
    }

    const data = await response.json();

    tokenCache = {
        value: data.access_token,
        expiresAt: Date.now() +
            (Number(data.expires_in || 3599) - 60) * 1000
    };

    return tokenCache.value;
}

function darajaTimestamp() {
    return new Date(Date.now() + 3 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\D/g, '')
        .slice(0, 14);
}

function darajaPassword(timestamp) {
    return Buffer.from(
        `${MPESA.shortcode}${MPESA.passkey}${timestamp}`
    ).toString('base64');
}

async function darajaPost(endpoint, payload) {
    const token = await getAccessToken();

    const response = await fetch(
        `${MPESA.baseUrl}${endpoint}`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(20000)
        }
    );

    let data = {};

    try {
        data = await response.json();
    } catch (_) {
        // The response was not valid JSON.
    }

    if (!response.ok) {
        const error = new Error(
            data.errorMessage ||
            data.ResultDesc ||
            `Daraja HTTP ${response.status}`
        );

        error.status = response.status;
        throw error;
    }

    return data;
}

async function stkPush(booking) {
    const timestamp = darajaTimestamp();

    const data = await darajaPost(
        '/mpesa/stkpush/v1/processrequest',
        {
            BusinessShortCode: MPESA.shortcode,
            Password: darajaPassword(timestamp),
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: booking.amount,
            PartyA: booking.phone,
            PartyB: MPESA.shortcode,
            PhoneNumber: booking.phone,
            CallBackURL:
                `${MPESA.publicBaseUrl}/payments/cb/${MPESA.callbackSecret}`,
            AccountReference: booking.accountRef,
            TransactionDesc: 'Tencent Innovations service payment'
        }
    );

    if (String(data.ResponseCode) !== '0') {
        throw new Error(
            data.ResponseDescription || 'STK push was rejected'
        );
    }

    return data;
}

async function stkQuery(checkoutRequestId) {
    const timestamp = darajaTimestamp();

    return darajaPost(
        '/mpesa/stkpushquery/v1/query',
        {
            BusinessShortCode: MPESA.shortcode,
            Password: darajaPassword(timestamp),
            Timestamp: timestamp,
            CheckoutRequestID: checkoutRequestId
        }
    );
}

function bookingFields(booking, extra = {}) {
    return {
        Name: booking.name,
        Phone: booking.phone,
        Service: booking.service,
        Location: booking.location,
        Amount: `KES ${booking.amount}`,
        Reference: booking.accountRef,
        ...extra
    };
}

// ---------------------------------------------------------------
// Signed booking confirmation links
// ---------------------------------------------------------------

const LINK_SECRET =
    process.env.LINK_SECRET ||
    MPESA.callbackSecret ||
    '';

function linksEnabled() {
    return (
        LINK_SECRET.length >= 16 &&
        MPESA.publicBaseUrl.startsWith('https://')
    );
}

function signLinkPart(part) {
    return crypto
        .createHmac('sha256', LINK_SECRET)
        .update(part)
        .digest('base64url');
}

function makeBookingLink(booking, paid = true) {
    if (!linksEnabled()) return '';

    const part = Buffer.from(
        JSON.stringify({
            n: booking.name,
            p: booking.phone,
            s: booking.service,
            a: booking.amount,
            r: paid ? (booking.receipt || '') : '',
            f: booking.accountRef,
            l: booking.location,
            t: paid
                ? (booking.paidAt || Date.now())
                : booking.createdAt,
            i: booking.id,
            k: paid ? 1 : 0
        })
    ).toString('base64url');

    return `${MPESA.publicBaseUrl}/booking/${part}.${signLinkPart(part)}`;
}

function readBookingLink(token) {
    if (LINK_SECRET.length < 16) return null;

    const dot = token.lastIndexOf('.');

    if (dot < 1) return null;

    const part = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(signLinkPart(part));

    if (
        given.length !== expected.length ||
        !crypto.timingSafeEqual(given, expected)
    ) {
        return null;
    }

    try {
        return JSON.parse(
            Buffer.from(part, 'base64url').toString('utf8')
        );
    } catch (_) {
        return null;
    }
}

app.get('/booking/:token', (req, res) => {
    const data = readBookingLink(req.params.token);

    if (!data || data.k !== 1 || !data.i) {
        return res.status(404).send(
            'This booking link is invalid or has expired.'
        );
    }

    const content = `
        <h2>Booking confirmed</h2>
        <div class="form-container">
            <p><strong>Customer:</strong> ${esc(data.n)}</p>
            <p><strong>Service:</strong> ${esc(data.s)}</p>
            <p><strong>Reference:</strong> ${esc(data.f)}</p>
            <p><strong>Amount:</strong> KES ${Number(data.a).toLocaleString('en-KE')}</p>
            <p><strong>M-Pesa receipt:</strong> ${esc(data.r || 'Confirmed')}</p>
            <p><strong>Status:</strong> PAID</p>
            <p>Sign in to download your PDF receipt.</p>
            <a class="cta-btn" href="/login">Sign in</a>
        </div>
    `;

    res.send(
        renderPage({
            title: 'Booking Confirmation',
            activeNav: '',
            content
        })
    );
});
// ---------------------------------------------------------------
// PDF receipt generation
// ---------------------------------------------------------------

function generateReceiptPDF(booking) {
    return new Promise((resolve, reject) => {
        if (!PDFDocument) {
            return reject(
                new Error('PDFKit is not installed.')
            );
        }

        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 55,
                info: {
                    Title: 'Tencent Innovations Payment Receipt',
                    Author: 'Tencent Innovations'
                }
            });

            const chunks = [];

            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            doc
                .fontSize(22)
                .fillColor('#123b68')
                .text('TENCENT INNOVATIONS', { align: 'center' });

            doc
                .moveDown(0.5)
                .fontSize(12)
                .fillColor('#555555')
                .text('OFFICIAL PAYMENT RECEIPT', { align: 'center' });

            doc.moveDown(2);

            doc
                .fontSize(11)
                .fillColor('#222222')
                .text(`Receipt reference: ${booking.accountRef}`)
                .text(`Booking ID: ${booking.id}`)
                .text(`Date paid: ${new Date(
                    booking.paidAt || Date.now()
                ).toLocaleString('en-KE', {
                    timeZone: 'Africa/Nairobi'
                })}`);

            doc.moveDown();

            doc
                .fontSize(13)
                .fillColor('#123b68')
                .text('CUSTOMER DETAILS');

            doc
                .moveDown(0.5)
                .fontSize(11)
                .fillColor('#222222')
                .text(`Customer name: ${booking.name}`)
                .text(`Email: ${booking.email}`)
                .text(`Phone: ${booking.phone}`);

            doc.moveDown();

            doc
                .fontSize(13)
                .fillColor('#123b68')
                .text('PAYMENT DETAILS');

            doc
                .moveDown(0.5)
                .fontSize(11)
                .fillColor('#222222')
                .text(`Service: ${booking.service}`)
                .text(`Location: ${booking.location}`)
                .text(`Amount paid: KES ${Number(
                    booking.amount
                ).toLocaleString('en-KE')}`)
                .text(`M-Pesa receipt: ${booking.receipt || 'Confirmed'}`)
                .text('Payment status: PAID');

            doc.moveDown(3);

            doc
                .fontSize(10)
                .fillColor('#555555')
                .text(
                    'Thank you for choosing Tencent Innovations. ' +
                    'Keep this receipt for your records.',
                    { align: 'center' }
                );

            doc.moveDown(2);

            doc
                .fontSize(9)
                .fillColor('#777777')
                .text(
                    'This receipt was generated electronically following payment verification.',
                    { align: 'center' }
                );

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

// ---------------------------------------------------------------
// Customer payment receipt email
// ---------------------------------------------------------------

async function sendCustomerReceipt(booking) {
    if (booking.receiptEmailSent) return;

    if (!process.env.GMAIL_USER ||
        !process.env.GMAIL_APP_PASSWORD) {
        throw new Error('Email credentials are not configured.');
    }

    if (!booking.email) {
        throw new Error('Customer email address is missing.');
    }

    const pdf = await generateReceiptPDF(booking);

    await mailer.sendMail({
        from: `"Tencent Innovations" <${process.env.GMAIL_USER}>`,
        to: booking.email,
        subject: 'Your Tencent Innovations payment receipt',
        text:
            `Hello ${booking.name},\n\n` +
            `Your payment has been verified successfully.\n\n` +
            `Service: ${booking.service}\n` +
            `Amount: KES ${booking.amount}\n` +
            `M-Pesa receipt: ${booking.receipt || 'Confirmed'}\n\n` +
            'Your PDF receipt is attached.\n\n' +
            'Thank you for choosing Tencent Innovations.',
        attachments: [
            {
                filename: `Tencent-Receipt-${booking.id}.pdf`,
                content: pdf,
                contentType: 'application/pdf'
            }
        ]
    });

    booking.receiptEmailSent = true;
    await persistBooking(booking);
}

// ---------------------------------------------------------------
// Mark a booking as paid only after verification
// ---------------------------------------------------------------

async function markPaid(booking, receipt, verified) {
    if (!verified) {
        throw new Error('Payment has not been verified.');
    }

    const alreadyPaid = booking.status === 'paid';

    if (alreadyPaid && booking.receiptEmailSent) {
        return;
    }

    const previous = {
        status: booking.status,
        receipt: booking.receipt,
        paidAt: booking.paidAt,
        link: booking.link
    };

    booking.status = 'paid';
    booking.receipt = receipt || booking.receipt || '';
    booking.paidAt = booking.paidAt || Date.now();
    booking.link = makeBookingLink(booking, true);

    // Save the verified payment before sending a receipt.
    try {
        await persistBooking(booking);
    } catch (error) {
        Object.assign(booking, previous);
        throw error;
    }

    try {
        await sendCustomerReceipt(booking);
    } catch (error) {
        console.error(
            'Customer receipt email failed; retry is required:',
            error.message
        );
    }

    await notify(
        'M-Pesa payment confirmed',
        bookingFields(booking, {
            'M-Pesa receipt': booking.receipt,
            'Booking confirmation': booking.link || 'Not configured'
        })
    );
}

// ---------------------------------------------------------------
// Mark failed payments
// ---------------------------------------------------------------

async function markFailed(booking, description) {
    if (!booking || booking.status === 'paid') return;

    booking.status = 'failed';
    booking.failureReason = String(
        description || 'Payment was not completed.'
    ).slice(0, 300);

    await persistBooking(booking);

    await notify(
        'M-Pesa payment failed',
        bookingFields(booking, {
            Reason: booking.failureReason
        })
    );
}

// ---------------------------------------------------------------
// M-Pesa callback processing
// ---------------------------------------------------------------

function safeSecretEqual(received, expected) {
    const a = Buffer.from(String(received || ''));
    const b = Buffer.from(String(expected || ''));

    return (
        a.length === b.length &&
        a.length > 0 &&
        crypto.timingSafeEqual(a, b)
    );
}

async function handleCallback(body) {
    const callback = body?.Body?.stkCallback;

    if (!callback) {
        throw new Error('Invalid M-Pesa callback structure.');
    }

    const checkoutId = callback.CheckoutRequestID;
    const booking = byCheckout.get(checkoutId);

    if (!booking) {
        console.error(
            'Callback received for unknown CheckoutRequestID:',
            checkoutId
        );
        return;
    }

    // Never trust the callback alone. Query Daraja for the final status.
    let query;

    try {
        query = await stkQuery(checkoutId);
    } catch (error) {
        booking.status = 'review';
        await persistBooking(booking);
        throw error;
    }

    if (String(query.ResultCode) === '0') {
        const callbackItems =
            callback.CallbackMetadata?.Item || [];

        const callbackAmount = callbackItems.find(
            item => item.Name === 'Amount'
        )?.Value;

        const callbackReceipt = callbackItems.find(
            item => item.Name === 'MpesaReceiptNumber'
        )?.Value;

        if (
            callbackAmount !== undefined &&
            Number(callbackAmount) !== Number(booking.amount)
        ) {
            booking.status = 'review';
            await persistBooking(booking);
            throw new Error('M-Pesa amount does not match booking amount.');
        }

        await markPaid(
            booking,
            callbackReceipt || '',
            true
        );
    } else {
        const resultCode = String(callback.ResultCode);

        if (resultCode === '1032') {
            await markFailed(booking, 'Payment cancelled by customer.');
        } else if (resultCode === '1037') {
            await markFailed(booking, 'M-Pesa request timed out.');
        } else {
            await markFailed(
                booking,
                callback.ResultDesc || 'M-Pesa payment was not completed.'
            );
        }
    }
}

// Callback URL is protected by a secret path segment.
app.post('/payments/cb/:secret', async (req, res) => {
    if (!safeSecretEqual(
        req.params.secret,
        MPESA.callbackSecret
    )) {
        return res.sendStatus(404);
    }

    // Acknowledge quickly to avoid repeated Daraja delivery.
    res.json({
        ResultCode: 0,
        ResultDesc: 'Accepted'
    });

    try {
        await handleCallback(req.body);
    } catch (error) {
        console.error(
            'M-Pesa callback processing error:',
            error.message
        );
    }
});

// ---------------------------------------------------------------
// Payment status verification
// ---------------------------------------------------------------

async function verifyBookingPayment(booking) {
    if (!booking || !booking.checkoutRequestId) {
        return booking;
    }

    if (booking.status === 'paid') {
        return booking;
    }

    const now = Date.now();

    if (
        booking.lastQuery &&
        now - booking.lastQuery < 15000
    ) {
        return booking;
    }

    booking.lastQuery = now;
    await persistBooking(booking);

    const result = await stkQuery(
        booking.checkoutRequestId
    );

    if (String(result.ResultCode) === '0') {
        await markPaid(
            booking,
            result.MpesaReceiptNumber || booking.receipt || '',
            true
        );
    } else if (
        ['1032', '1037'].includes(String(result.ResultCode))
    ) {
        await markFailed(
            booking,
            result.ResultDesc || 'Payment was not completed.'
        );
    }

    return booking;
}
// ---------------------------------------------------------------
// Payment status endpoint
// ---------------------------------------------------------------

app.get('/payments/status/:id', requireLogin, async (req, res) => {
    try {
        let booking = bookings.get(String(req.params.id));

        // Recover older bookings from PostgreSQL if not in memory.
        if (!booking) {
            const result = await pool.query(
                `SELECT * FROM customer_bookings
                 WHERE booking_id = $1 AND customer_id = $2`,
                [String(req.params.id), req.session.user.id]
            );

            if (result.rowCount) {
                const row = result.rows[0];

                booking = {
                    id: row.booking_id,
                    customerId: String(row.customer_id),
                    email: row.email,
                    name: row.name,
                    phone: row.phone,
                    service: row.service,
                    location: row.location,
                    amount: Number(row.amount),
                    accountRef: row.account_ref,
                    status: row.status,
                    createdAt: Number(row.created_at),
                    paidAt: row.paid_at
                        ? Number(row.paid_at)
                        : null,
                    receipt: row.receipt || '',
                    checkoutRequestId:
                        row.checkout_request_id || undefined,
                    lastQuery: row.last_query
                        ? Number(row.last_query)
                        : 0,
                    receiptEmailSent:
                        Boolean(row.receipt_email_sent)
                };

                bookings.set(booking.id, booking);

                if (booking.checkoutRequestId) {
                    byCheckout.set(
                        booking.checkoutRequestId,
                        booking
                    );
                }
            }
        }

        if (
            !booking ||
            String(booking.customerId) !==
                String(req.session.user.id)
        ) {
            return res.status(404).json({
                status: 'unknown'
            });
        }

        if (booking.status === 'pending') {
            try {
                await verifyBookingPayment(booking);
            } catch (error) {
                console.error(
                    'Payment status verification failed:',
                    error.message
                );
            }
        }

        return res.json({
            id: booking.id,
            status: booking.status,
            service: booking.service,
            amount: booking.amount,
            receipt: booking.receipt || '',
            receiptEmailSent: Boolean(
                booking.receiptEmailSent
            )
        });
    } catch (error) {
        console.error('Payment status error:', error.message);

        return res.status(500).json({
            error: 'Unable to check payment status.'
        });
    }
});

// ---------------------------------------------------------------
// PDF receipt download
// ---------------------------------------------------------------

app.get(
    '/payments/receipt/:id/download.pdf',
    requireLogin,
    async (req, res) => {
        try {
            let booking = bookings.get(String(req.params.id));

            if (
                !booking ||
                String(booking.customerId) !==
                    String(req.session.user.id)
            ) {
                const result = await pool.query(
                    `SELECT * FROM customer_bookings
                     WHERE booking_id = $1
                     AND customer_id = $2
                     AND status = 'paid'`,
                    [
                        String(req.params.id),
                        req.session.user.id
                    ]
                );

                if (result.rowCount) {
                    const row = result.rows[0];

                    booking = {
                        id: row.booking_id,
                        customerId: String(row.customer_id),
                        email: row.email,
                        name: row.name,
                        phone: row.phone,
                        service: row.service,
                        location: row.location,
                        amount: Number(row.amount),
                        accountRef: row.account_ref,
                        status: row.status,
                        createdAt: Number(row.created_at),
                        paidAt: row.paid_at
                            ? Number(row.paid_at)
                            : null,
                        receipt: row.receipt || ''
                    };
                }
            }

            if (
                !booking ||
                booking.status !== 'paid' ||
                String(booking.customerId) !==
                    String(req.session.user.id)
            ) {
                return res.status(404).send(
                    'Receipt not available or payment pending.'
                );
            }

            if (!PDFDocument) {
                return res.status(503).send(
                    'PDF receipt service is unavailable.'
                );
            }

            const pdf = await generateReceiptPDF(booking);

            res.setHeader(
                'Content-Type',
                'application/pdf'
            );

            res.setHeader(
                'Content-Disposition',
                `attachment; filename="Tencent-Receipt-${booking.id}.pdf"`
            );

            return res.send(pdf);
        } catch (error) {
            console.error(
                'Receipt download failed:',
                error.message
            );

            return res.status(500).send(
                'Unable to generate your receipt.'
            );
        }
    }
);

// ---------------------------------------------------------------
// Customer registration
// ---------------------------------------------------------------

app.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    const content = `
        <h2>Create Customer Account</h2>
        <div class="form-container">
            <form method="POST" action="/register">
                <label>Full name</label>
                <input type="text" name="name"
                    minlength="2" maxlength="100"
                    autocomplete="name" required>

                <label>Email address</label>
                <input type="email" name="email"
                    maxlength="254"
                    autocomplete="email" required>

                <label>Password</label>
                <input type="password" name="password"
                    minlength="10" maxlength="128"
                    autocomplete="new-password" required>

                <label>Confirm password</label>
                <input type="password" name="confirmPassword"
                    minlength="10" maxlength="128"
                    autocomplete="new-password" required>

                <button class="cta-btn" type="submit">
                    Create Account
                </button>
            </form>

            <p>Already registered?
                <a href="/login">Sign in here</a>
            </p>
        </div>
    `;

    res.send(renderPage({
        title: 'Customer Registration',
        activeNav: '',
        content
    }));
});

app.post('/register', payLimiter, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const email = String(req.body.email || '')
            .trim()
            .toLowerCase();

        const password = String(req.body.password || '');
        const confirmPassword =
            String(req.body.confirmPassword || '');

        if (
            name.length < 2 ||
            name.length > 100 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
            email.length > 254 ||
            password.length < 10 ||
            password.length > 128
        ) {
            return res.status(400).send(
                'Please provide valid registration details. ' +
                'Your password must contain at least 10 characters.'
            );
        }

        if (password !== confirmPassword) {
            return res.status(400).send(
                'Your passwords do not match.'
            );
        }

        const passwordHash = await bcrypt.hash(
            password,
            12
        );

        const result = await pool.query(
            `INSERT INTO customers
             (name, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, name, email`,
            [name, email, passwordHash]
        );

        const customer = result.rows[0];

        await new Promise((resolve, reject) => {
            req.session.regenerate(error => {
                if (error) return reject(error);
                resolve();
            });
        });

        req.session.user = {
            id: String(customer.id),
            name: customer.name,
            email: customer.email
        };

        return res.redirect('/dashboard');
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).send(
                'An account with this email already exists. Please sign in.'
            );
        }

        console.error('Registration error:', error.message);

        return res.status(500).send(
            'Registration failed. Please try again.'
        );
    }
});

// ---------------------------------------------------------------
// Customer login
// ---------------------------------------------------------------

app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }

    const content = `
        <h2>Customer Login</h2>
        <div class="form-container">
            <form method="POST" action="/login">
                <label>Email address</label>
                <input type="email" name="email"
                    autocomplete="email" required>

                <label>Password</label>
                <input type="password" name="password"
                    autocomplete="current-password" required>

                <input type="hidden" name="next"
                    value="${esc(safeNext(req.query.next))}">

                <button class="cta-btn" type="submit">
                    Sign In
                </button>
            </form>

            <p>New customer?
                <a href="/register">Create an account</a>
            </p>
        </div>
    `;

    res.send(renderPage({
        title: 'Customer Login',
        activeNav: '',
        content
    }));
});

app.post('/login', payLimiter, async (req, res) => {
    try {
        const email = String(req.body.email || '')
            .trim()
            .toLowerCase();

        const password = String(req.body.password || '');

        const result = await pool.query(
            `SELECT id, name, email, password_hash
             FROM customers
             WHERE email = $1`,
            [email]
        );

        if (!result.rowCount) {
            return res.status(401).send(
                'Invalid email or password.'
            );
        }

        const customer = result.rows[0];

        const valid = await bcrypt.compare(
            password,
            customer.password_hash
        );

        if (!valid) {
            return res.status(401).send(
                'Invalid email or password.'
            );
        }

        await new Promise((resolve, reject) => {
            req.session.regenerate(error => {
                if (error) return reject(error);
                resolve();
            });
        });

        req.session.user = {
            id: String(customer.id),
            name: customer.name,
            email: customer.email
        };

        const destination = safeNext(req.body.next);

        return res.redirect(destination);
    } catch (error) {
        console.error('Login error:', error.message);

        return res.status(500).send(
            'Unable to sign in. Please try again.'
        );
    }
});

// ---------------------------------------------------------------
// Customer logout
// ---------------------------------------------------------------

app.post('/logout', requireLogin, (req, res) => {
    req.session.destroy(error => {
        if (error) {
            console.error(
                'Session logout error:',
                error.message
            );

            return res.status(500).send(
                'Unable to log out. Please try again.'
            );
        }

        res.clearCookie('connect.sid');
        return res.redirect('/login');
    });
});
// ---------------------------------------------------------------
// Customer dashboard
// ---------------------------------------------------------------

app.get('/dashboard', requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT booking_id, service, location, amount,
                    status, created_at, paid_at, receipt,
                    receipt_email_sent
             FROM customer_bookings
             WHERE customer_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [req.session.user.id]
        );

        const bookingsHtml = result.rows.length
            ? result.rows.map(row => {
                const paid = row.status === 'paid';

                const statusColor = paid
                    ? '#16803c'
                    : row.status === 'failed'
                        ? '#c0392b'
                        : '#d18b00';

                const receiptButton = paid
                    ? `<a class="cta-btn"
                        href="/payments/receipt/${encodeURIComponent(row.booking_id)}/download.pdf">
                        Download PDF Receipt
                       </a>`
                    : '<span>Receipt available after payment confirmation</span>';

                return `
                    <div class="booking-card">
                        <h3>${esc(row.service)}</h3>
                        <p><strong>Location:</strong> ${esc(row.location)}</p>
                        <p><strong>Amount:</strong> KES ${Number(row.amount).toLocaleString('en-KE')}</p>
                        <p><strong>Date:</strong> ${new Date(Number(row.created_at)).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}</p>
                        <p><strong>Status:</strong>
                            <span style="color:${statusColor};font-weight:bold">
                                ${esc(String(row.status).toUpperCase())}
                            </span>
                        </p>
                        ${paid && row.receipt
                            ? `<p><strong>M-Pesa receipt:</strong> ${esc(row.receipt)}</p>`
                            : ''}
                        ${receiptButton}
                    </div>
                `;
            }).join('')
            : '<p>You have not made any service bookings yet.</p>';

        const content = `
            <h2>Welcome, ${esc(req.session.user.name)}</h2>

            <div class="dashboard-summary">
                <h3>Your Customer Account</h3>
                <p><strong>Name:</strong> ${esc(req.session.user.name)}</p>
                <p><strong>Email:</strong> ${esc(req.session.user.email)}</p>
            </div>

            <h2>Our Services</h2>

            <div class="service-grid">
                <a class="service-card" href="/wifi">
                    <h3>WiFi Installation</h3>
                    <p>Professional wireless networking solutions.</p>
                </a>

                <a class="service-card" href="/cctv">
                    <h3>CCTV Installation</h3>
                    <p>Security camera installation and monitoring.</p>
                </a>

                <a class="service-card" href="/smart-locks">
                    <h3>Smart Locks</h3>
                    <p>Modern access control and smart security.</p>
                </a>

                <a class="service-card" href="/electric-fence">
                    <h3>Electric Fencing</h3>
                    <p>Reliable perimeter security solutions.</p>
                </a>

                <a class="service-card" href="/solar">
                    <h3>Solar Systems</h3>
                    <p>Solar power design and installation.</p>
                </a>

                <a class="service-card" href="/survey">
                    <h3>Site Survey</h3>
                    <p>Request a technical site survey and quotation.</p>
                </a>
            </div>

            <h2>Your Booking History</h2>

            <div class="booking-list">
                ${bookingsHtml}
            </div>

            <form method="POST" action="/logout">
                <button class="logout-btn" type="submit">
                    Log Out
                </button>
            </form>
        `;

        res.send(renderPage({
            title: 'Customer Dashboard',
            activeNav: 'dashboard',
            content
        }));

    } catch (error) {
        console.error(
            'Dashboard error:',
            error.message
        );

        res.status(500).send(
            'Unable to load your dashboard. Please try again.'
        );
    }
});

// ---------------------------------------------------------------
// Website navigation
// ---------------------------------------------------------------

function navigation() {
    return `
        <nav class="sidebar">
            <div class="sidebar-brand">
                <a href="/">TENCENT INNOVATIONS</a>
            </div>

            <a href="/dashboard">Dashboard</a>
            <a href="/wifi">WiFi Solutions</a>
            <a href="/cctv">CCTV Installation</a>
            <a href="/smart-locks">Smart Locks</a>
            <a href="/electric-fence">Electric Fence</a>
            <a href="/solar">Solar Systems</a>
            <a href="/survey">Site Survey</a>
            <a href="/terms">Terms & Conditions</a>

            <div class="sidebar-account">
                <a href="/dashboard">My Account</a>
                <form method="POST" action="/logout">
                    <button type="submit">Log Out</button>
                </form>
            </div>
        </nav>
    `;
}

// ---------------------------------------------------------------
// Shared website layout
// ---------------------------------------------------------------

function renderPage({
    title = 'Tencent Innovations',
    activeNav = '',
    content = ''
} = {}) {
    const loggedIn = false;

    const accountLinks = `
        <div class="account-links">
            <a href="/login">Login</a>
            <a href="/register">Register</a>
        </div>
    `;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <title>${esc(title)} | Tencent Innovations</title>

    <style>
        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            font-family: Arial, Helvetica, sans-serif;
            background: #f4f6f9;
            color: #202b3c;
        }

        a {
            color: #145da0;
            text-decoration: none;
        }

        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: #102d4f;
            color: white;
            padding: 16px 24px;
        }

        .topbar h1 {
            font-size: 20px;
            margin: 0;
        }

        .topbar a {
            color: white;
            margin-left: 14px;
        }

        .account-links a {
            padding: 9px 13px;
            border: 1px solid white;
            border-radius: 5px;
        }

        .layout {
            display: flex;
            min-height: calc(100vh - 60px);
        }

        .sidebar {
            width: 235px;
            flex-shrink: 0;
            background: #173b63;
            padding: 20px 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .sidebar-brand {
            font-weight: bold;
            padding: 10px;
            margin-bottom: 15px;
        }

        .sidebar a,
        .sidebar button {
            color: white;
            padding: 12px;
            border: 0;
            border-radius: 5px;
            background: transparent;
            text-align: left;
            font-size: 14px;
            cursor: pointer;
            display: block;
            width: 100%;
        }

        .sidebar a:hover,
        .sidebar button:hover {
            background: #285782;
        }

        .sidebar-account {
            margin-top: auto;
        }

        .main-content {
            flex: 1;
            padding: 30px;
            min-width: 0;
        }

        .main-content h2 {
            color: #173b63;
        }

        .form-container {
            max-width: 520px;
            margin: 20px auto;
            background: white;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 3px 12px rgba(0,0,0,.08);
        }

        input,
        select,
        textarea {
            width: 100%;
            padding: 12px;
            margin: 8px 0 18px;
            border: 1px solid #ccd3dc;
            border-radius: 5px;
            font-size: 15px;
        }

        label {
            display: block;
            font-weight: bold;
            margin-top: 8px;
        }

        button,
        .cta-btn {
            display: inline-block;
            border: none;
            background: #145da0;
            color: white;
            padding: 12px 18px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 15px;
        }

        .cta-btn:hover,
        button:hover {
            background: #0d477d;
        }

        .service-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 18px;
            margin: 25px 0;
        }

        .service-card,
        .booking-card,
        .dashboard-summary {
            display: block;
            background: white;
            padding: 20px;
            border-radius: 9px;
            box-shadow: 0 2px 10px rgba(0,0,0,.06);
        }

        .service-card:hover {
            transform: translateY(-2px);
        }

        .booking-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 16px;
        }

        .booking-card h3 {
            color: #173b63;
        }

        .logout-btn {
            margin-top: 25px;
            background: #a52a2a;
        }

        footer {
            text-align: center;
            background: #102d4f;
            color: white;
            padding: 18px;
        }

        @media(max-width: 760px) {
            .layout {
                flex-direction: column;
            }

            .sidebar {
                width: 100%;
            }

            .main-content {
                padding: 18px;
            }

            .topbar {
                flex-direction: column;
                gap: 12px;
                align-items: flex-start;
            }
        }
    </style>
</head>
<body>
    <header class="topbar">
        <h1>Tencent Innovations</h1>
        ${accountLinks}
    </header>

    <div class="layout">
        ${navigation()}

        <main class="main-content">
            ${content}
        </main>
    </div>

    <footer>
        &copy; ${new Date().getFullYear()} Tencent Innovations.
        All rights reserved.
    </footer>
</body>
</html>`;
}
// ---------------------------------------------------------------
// Homepage
// ---------------------------------------------------------------

app.get('/', (req, res) => {
    const content = `
        <section class="hero">
            <h2>Smart Technology. Reliable Security. Innovative Solutions.</h2>

            <p>
                Welcome to Tencent Innovations. We provide professional
                networking, security, automation and renewable energy solutions.
            </p>

            <a class="cta-btn" href="${req.session.user ? '/dashboard' : '/register'}">
                Get Started
            </a>
        </section>

        <h2>Our Services</h2>

        <div class="service-grid">
            <a class="service-card" href="/wifi">
                <h3>WiFi & Networking</h3>
                <p>Reliable wireless networks for homes and businesses.</p>
            </a>

            <a class="service-card" href="/cctv">
                <h3>CCTV Installation</h3>
                <p>Modern surveillance and security camera systems.</p>
            </a>

            <a class="service-card" href="/smart-locks">
                <h3>Smart Locks</h3>
                <p>Smart access control and door security solutions.</p>
            </a>

            <a class="service-card" href="/electric-fence">
                <h3>Electric Fencing</h3>
                <p>Perimeter protection for residential and commercial properties.</p>
            </a>

            <a class="service-card" href="/solar">
                <h3>Solar Energy</h3>
                <p>Solar power solutions and system installations.</p>
            </a>

            <a class="service-card" href="/survey">
                <h3>Site Survey & Quotation</h3>
                <p>Request a professional site assessment and quotation.</p>
            </a>
        </div>

        <section class="hero">
            <h2>Ready to get started?</h2>
            <p>Create your customer account to request a service and make payments securely.</p>
            <a class="cta-btn" href="${req.session.user ? '/dashboard' : '/register'}">
                ${req.session.user ? 'Open Dashboard' : 'Register Now'}
            </a>
        </section>
    `;

    res.send(renderPage({
        title: 'Home',
        activeNav: 'home',
        content
    }));
});

// ---------------------------------------------------------------
// Shared service-page renderer
// ---------------------------------------------------------------

function servicePage({
    title,
    heading,
    description,
    features = [],
    image = ''
}) {
    const featureList = features.map(feature =>
        `<li>${esc(feature)}</li>`
    ).join('');

    const imageHtml = image
        ? `<img src="${esc(image)}" alt="${esc(title)}"
             style="width:100%;max-height:350px;object-fit:cover;border-radius:10px">`
        : '';

    const content = `
        <section class="service-detail">
            <h2>${esc(heading)}</h2>

            <p>${esc(description)}</p>

            ${imageHtml}

            ${features.length ? `
                <h3>What we offer</h3>
                <ul>${featureList}</ul>
            ` : ''}

            <div class="form-container">
                <h3>Request this service</h3>
                <p>
                    To request this service, submit your details and
                    our team will contact you.
                </p>

                <a class="cta-btn" href="/survey">
                    Request Site Survey
                </a>
            </div>
        </section>
    `;

    return renderPage({
        title,
        activeNav: '',
        content
    });
}

// ---------------------------------------------------------------
// WiFi and networking
// ---------------------------------------------------------------

app.get('/wifi', requireLogin, (req, res) => {
    res.send(servicePage({
        title: 'WiFi & Networking',
        heading: 'WiFi and Networking Solutions',
        description:
            'We design, install and configure reliable wireless and wired networks for homes, offices and businesses.',
        features: [
            'Wireless access point installation',
            'Router and network configuration',
            'Structured network cabling',
            'Network coverage planning',
            'Network troubleshooting and maintenance'
        ],
        image: '/public/wifi.jpg'
    }));
});

// ---------------------------------------------------------------
// CCTV installation
// ---------------------------------------------------------------

app.get('/cctv', requireLogin, (req, res) => {
    res.send(servicePage({
        title: 'CCTV Installation',
        heading: 'CCTV Security Systems',
        description:
            'Protect your property with professionally installed CCTV surveillance systems.',
        features: [
            'IP and analogue CCTV installation',
            'Indoor and outdoor cameras',
            'Remote viewing configuration',
            'Digital video recorder installation',
            'System maintenance and troubleshooting'
        ],
        image: '/public/cctv.jpg'
    }));
});

// ---------------------------------------------------------------
// Smart locks
// ---------------------------------------------------------------

app.get('/smart-locks', requireLogin, (req, res) => {
    res.send(servicePage({
        title: 'Smart Locks',
        heading: 'Smart Locks and Access Control',
        description:
            'Improve security and convenience through modern electronic locking and access control systems.',
        features: [
            'Smart door lock installation',
            'Fingerprint access systems',
            'PIN and card access control',
            'Smartphone-controlled locks',
            'Access control configuration'
        ],
        image: '/public/smart-locks.jpg'
    }));
});

// ---------------------------------------------------------------
// Electric fencing
// ---------------------------------------------------------------

app.get('/electric-fence', requireLogin, (req, res) => {
    res.send(servicePage({
        title: 'Electric Fencing',
        heading: 'Electric Fence Installation',
        description:
            'We provide electric perimeter security solutions for residential, commercial and industrial properties.',
        features: [
            'Electric fence installation',
            'Energizer installation and configuration',
            'Fence wiring and accessories',
            'Fence maintenance',
            'Fault detection and repair'
        ],
        image: '/public/electric-fence.jpg'
    }));
});

// ---------------------------------------------------------------
// Solar energy
// ---------------------------------------------------------------

app.get('/solar', requireLogin, (req, res) => {
    res.send(servicePage({
        title: 'Solar Energy',
        heading: 'Solar Power Solutions',
        description:
            'Explore solar energy systems designed to provide reliable and efficient power for your property.',
        features: [
            'Solar system consultation',
            'Solar panel installation',
            'Inverter and battery solutions',
            'Solar system sizing',
            'System inspection and maintenance'
        ],
        image: '/public/solar.jpg'
    }));
});

// ---------------------------------------------------------------
// Site survey and quotation
// ---------------------------------------------------------------

app.get('/survey', requireLogin, (req, res) => {
    const content = `
        <h2>Request a Site Survey</h2>

        <p>
            Submit your location and contact details so our technical
            team can assess your requirements and prepare a quotation.
        </p>

        <div class="form-container">
            <form method="POST" action="/submit-survey-payment">

                <label>Customer name</label>
                <input type="text"
                    value="${esc(req.session.user.name)}"
                    readonly>

                <label>Registered email</label>
                <input type="email"
                    value="${esc(req.session.user.email)}"
                    readonly>

                <label>Phone number for M-Pesa</label>
                <input type="tel"
                    name="phone"
                    placeholder="07XXXXXXXX or 2547XXXXXXXX"
                    required>

                <label>Service required</label>
                <select name="service" required>
                    <option value="">Select a service</option>
                    <option value="Site Survey & Quotation">
                        Site Survey & Quotation — KES 3,000
                    </option>
                    <option value="WiFi Setup">
                        WiFi Setup — KES 3,000
                    </option>
                    <option value="CCTV Installation">
                        CCTV Installation — KES 3,000
                    </option>
                    <option value="Smart Locks">
                        Smart Locks — KES 2,500
                    </option>
                    <option value="Electric Fence">
                        Electric Fence — KES 5,000
                    </option>
                    <option value="Solar Consultation">
                        Solar Consultation — KES 4,000
                    </option>
                </select>

                <label>Installation or service location</label>
                <textarea name="location"
                    rows="4"
                    maxlength="250"
                    placeholder="Enter your town, estate or physical location"
                    required></textarea>

                <button class="cta-btn" type="submit">
                    Continue to M-Pesa Payment
                </button>
            </form>
        </div>
    `;

    res.send(renderPage({
        title: 'Site Survey & Payment',
        activeNav: 'survey',
        content
    }));
});
// ---------------------------------------------------------------
// Submit service request and initiate M-Pesa payment
// ---------------------------------------------------------------

app.post(
    '/submit-survey-payment',
    requireLogin,
    payLimiter,
    async (req, res) => {
        try {
            const phone = normalizePhone(req.body.phone);
            const service = String(req.body.service || '').trim();
            const location = String(req.body.location || '')
                .trim()
                .slice(0, 250);

            const name = req.session.user.name;
            const email = req.session.user.email;

            if (!phone) {
                return res.status(400).send(
                    'Please enter a valid Kenyan M-Pesa phone number.'
                );
            }

            if (!location) {
                return res.status(400).send(
                    'Please provide your service location.'
                );
            }

            if (
                !Object.prototype.hasOwnProperty.call(
                    SERVICE_PRICES,
                    service
                )
            ) {
                return res.status(400).send(
                    'Invalid service selected. Please return to the survey page and select a listed service.'
                );
            }

            if (!mpesaConfigured()) {
                console.error(
                    'M-Pesa configuration is incomplete.'
                );

                return res.status(503).send(
                    'M-Pesa payments are temporarily unavailable. Please contact our support team.'
                );
            }

            if (!phoneAttemptAllowed(phone)) {
                return res.status(429).send(
                    'You have reached the maximum number of payment attempts for this phone number. Please try again later.'
                );
            }

            const amount = SERVICE_PRICES[service];
            const bookingId = crypto.randomUUID();

            const accountRef =
                `TI${Date.now().toString().slice(-8)}`;

            const booking = {
                id: bookingId,
                customerId: String(req.session.user.id),
                name,
                email,
                phone,
                service,
                location,
                amount,
                accountRef,
                status: 'pending',
                createdAt: Date.now(),
                paidAt: null,
                receipt: '',
                checkoutRequestId: undefined,
                lastQuery: 0,
                receiptEmailSent: false
            };

            // Save the booking before sending the payment request.
            bookings.set(booking.id, booking);

            try {
                await persistBooking(booking);
            } catch (error) {
                bookings.delete(booking.id);

                console.error(
                    'Could not save booking:',
                    error.message
                );

                return res.status(500).send(
                    'We could not save your booking. Please try again.'
                );
            }

            let stkResponse;

            try {
                stkResponse = await stkPush(booking);
            } catch (error) {
                booking.status = 'failed';
                booking.failureReason = error.message;

                await persistBooking(booking).catch(
                    dbError => console.error(
                        'Could not save STK failure:',
                        dbError.message
                    )
                );

                console.error(
                    'STK Push error:',
                    error.message
                );

                return res.status(502).send(
                    'M-Pesa could not initiate your payment. Please check your phone number and try again.'
                );
            }

            booking.checkoutRequestId =
                stkResponse.CheckoutRequestID;

            booking.merchantRequestId =
                stkResponse.MerchantRequestID;

            booking.status = 'pending';

            byCheckout.set(
                booking.checkoutRequestId,
                booking
            );

            try {
                await persistBooking(booking);
            } catch (error) {
                console.error(
                    'Could not save checkout request:',
                    error.message
                );

                // Keep the booking in memory for callback processing.
                // A database failure here must be investigated.
                return res.status(500).send(
                    'Your M-Pesa request was created, but we could not save its reference. Please contact support before attempting another payment.'
                );
            }

            await notify(
                'New service payment request',
                bookingFields(booking, {
                    Status: 'Awaiting M-Pesa payment',
                    'Checkout Request ID':
                        booking.checkoutRequestId
                })
            );

            const content = `
                <div class="form-container">
                    <h2>M-Pesa Payment Request Sent</h2>

                    <p>
                        An M-Pesa payment prompt has been sent
                        to <strong>${esc(phone)}</strong>.
                    </p>

                    <p><strong>Service:</strong>
                        ${esc(service)}
                    </p>

                    <p><strong>Amount:</strong>
                        KES ${Number(amount).toLocaleString('en-KE')}
                    </p>

                    <p><strong>Booking reference:</strong>
                        ${esc(accountRef)}
                    </p>

                    <p>
                        Enter your M-Pesa PIN on your phone
                        to complete the payment.
                    </p>

                    <p id="payment-status">
                        Payment status: Waiting for confirmation...
                    </p>

                    <a class="cta-btn"
                        href="/dashboard">
                        Go to Dashboard
                    </a>
                </div>

                <script>
                    const bookingId = ${JSON.stringify(bookingId)};
                    const statusElement =
                        document.getElementById('payment-status');

                    async function checkPayment() {
                        try {
                            const response = await fetch(
                                '/payments/status/' +
                                encodeURIComponent(bookingId)
                            );

                            if (!response.ok) return;

                            const data = await response.json();

                            if (data.status === 'paid') {
                                statusElement.textContent =
                                    'Payment confirmed! Your receipt is available in your dashboard.';
                                return;
                            }

                            if (data.status === 'failed') {
                                statusElement.textContent =
                                    'Payment failed. Please return to the dashboard and try again.';
                                return;
                            }

                            statusElement.textContent =
                                'Payment status: ' +
                                data.status +
                                '. Waiting for confirmation...';

                            setTimeout(checkPayment, 10000);
                        } catch (error) {
                            setTimeout(checkPayment, 15000);
                        }
                    }

                    setTimeout(checkPayment, 10000);
                </script>
            `;

            return res.send(
                renderPage({
                    title: 'M-Pesa Payment',
                    activeNav: '',
                    content
                })
            );

        } catch (error) {
            console.error(
                'Service payment submission error:',
                error.message
            );

            return res.status(500).send(
                'Unable to process your service request. Please try again.'
            );
        }
    }
);
// ---------------------------------------------------------------
// Terms and conditions
// ---------------------------------------------------------------

app.get('/terms', (req, res) => {
    const content = `
        <div class="form-container">
            <h2>Terms and Conditions</h2>

            <h3>1. Service Requests</h3>
            <p>
                Customers must provide accurate contact information
                and service location details when submitting requests.
            </p>

            <h3>2. Payments</h3>
            <p>
                Payments are processed through M-Pesa.
                A service booking is not considered paid until
                the payment has been verified.
            </p>

            <h3>3. Receipts</h3>
            <p>
                Receipts are generated after successful payment
                verification and sent to the customer's registered
                email address where email delivery is configured.
            </p>

            <h3>4. Customer Information</h3>
            <p>
                Customer information is used to manage accounts,
                process service requests and communicate about
                bookings and payments.
            </p>

            <h3>5. Support</h3>
            <p>
                Contact Tencent Innovations for assistance
                with service requests or payment problems.
            </p>
        </div>
    `;

    res.send(
        renderPage({
            title: 'Terms and Conditions',
            activeNav: '',
            content
        })
    );
});


// ---------------------------------------------------------------
// Basic USSD endpoint
// ---------------------------------------------------------------

app.post('/ussd', async (req, res) => {
    try {
        const sessionId = String(
            req.body.sessionId || ''
        );

        const serviceCode = String(
            req.body.serviceCode || ''
        );

        const phoneNumber = normalizePhone(
            req.body.phoneNumber
        );

        const textValue = String(
            req.body.text || ''
        );

        const steps = textValue
            ? textValue.split('*')
            : [];

        let response = '';

        if (!phoneNumber) {
            response =
                'END Invalid phone number. Please try again.';
        } else if (steps.length === 0) {
            response =
                'CON Welcome to Tencent Innovations\n' +
                '1. View Services\n' +
                '2. Contact Support';
        } else if (steps[0] === '1' && steps.length === 1) {
            response =
                'CON Select a service\n' +
                '1. WiFi Setup\n' +
                '2. CCTV Installation\n' +
                '3. Smart Locks\n' +
                '4. Electric Fence\n' +
                '5. Solar Consultation';
        } else if (steps[0] === '1' && steps.length === 2) {
            const services = {
                '1': 'WiFi Setup',
                '2': 'CCTV Installation',
                '3': 'Smart Locks',
                '4': 'Electric Fence',
                '5': 'Solar Consultation'
            };

            const selected = services[steps[1]];

            if (!selected) {
                response =
                    'END Invalid service selection.';
            } else {
                response =
                    'END You selected ' + selected +
                    '. Please visit our website or contact support ' +
                    'to submit a service request and make payment.';
            }
        } else if (steps[0] === '2') {
            response =
                'END Please contact Tencent Innovations ' +
                'through the support details on our website.';
        } else {
            response =
                'END Invalid selection. Please try again.';
        }

        res.set('Content-Type', 'text/plain');
        res.send(response);

    } catch (error) {
        console.error(
            'USSD processing error:',
            error.message
        );

        res.set('Content-Type', 'text/plain');
        res.send(
            'END The service is temporarily unavailable.'
        );
    }
});


// ---------------------------------------------------------------
// Health check
// ---------------------------------------------------------------

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        application: 'Tencent Innovations',
        timestamp: new Date().toISOString()
    });
});


// ---------------------------------------------------------------
// Not found and error handling
// ---------------------------------------------------------------

app.use((req, res) => {
    res.status(404).send(
        renderPage({
            title: 'Page Not Found',
            activeNav: '',
            content: `
                <div class="form-container">
                    <h2>Page not found</h2>
                    <p>The page you requested does not exist.</p>
                    <a class="cta-btn" href="/">Return Home</a>
                </div>
            `
        })
    );
});

app.use((err, req, res, next) => {
    console.error('Application error:', err);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).send(
        'An unexpected server error occurred. Please try again later.'
    );
});


// ---------------------------------------------------------------
// Start application
// ---------------------------------------------------------------

async function startServer() {
    try {
        if (!process.env.SESSION_SECRET) {
            throw new Error(
                'SESSION_SECRET environment variable is required.'
            );
        }

        if (!process.env.DATABASE_URL) {
            throw new Error(
                'DATABASE_URL environment variable is required.'
            );
        }

        await initDatabase();

        const PORT = Number(process.env.PORT) || 3000;

        app.listen(PORT, '0.0.0.0', () => {
            console.log(
                `Tencent Innovations server running on port ${PORT}`
            );
        });

    } catch (error) {
        console.error(
            'Server startup failed:',
            error.message
        );

        process.exit(1);
    }
}

startServer();
