'use strict';
// ---------------------------------------------------------------------------
// Tencent POS: payment gateways for each business (their own till / paybill), the vault that
// keeps their API secrets encrypted, and the app icons. No extra npm packages are needed.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

// ---------- shared helpers ----------
async function getJson(url, opts, label) {
    const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    let data = {};
    try { data = await resp.json(); } catch (_) { /* not JSON */ }
    if (!resp.ok) {
        const err = new Error(data.errorMessage || data.ResultDesc || data.message || `${label} HTTP ${resp.status}`);
        err.status = resp.status; err.data = data;
        throw err;
    }
    return data;
}
const eatStamp = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);

// A gateway object looks like: { id, provider, cfg: {...plain settings}, secrets: {...decrypted} }

// ---------- Safaricom Daraja (M-Pesa Express / STK push) ----------
const DARAJA_HOST = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' };
const darajaTokens = new Map();   // gateway id -> { value, exp }
const darajaBase = gw => process.env.MPESA_BASE_URL_POS || DARAJA_HOST[gw.cfg.env === 'production' ? 'production' : 'sandbox'];
async function darajaToken(gw) {
    const ck = `${gw.id}:${gw.cfg.env}:${String(gw.secrets.consumerKey).slice(-8)}:${String(gw.secrets.consumerSecret).slice(-6)}`;   // changes when the keys change
    const hit = darajaTokens.get(ck);
    if (hit && hit.exp > Date.now()) return hit.value;
    const auth = Buffer.from(`${gw.secrets.consumerKey}:${gw.secrets.consumerSecret}`).toString('base64');
    const d = await getJson(`${darajaBase(gw)}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } }, 'Daraja sign-in');
    if (!d.access_token) throw new Error('Daraja did not return an access token');
    darajaTokens.set(ck, { value: d.access_token, exp: Date.now() + (Number(d.expires_in || 3599) - 60) * 1000 });
    return d.access_token;
}
async function darajaPost(gw, path, payload) {
    const token = await darajaToken(gw);
    try {
        return await getJson(`${darajaBase(gw)}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 'Daraja');
    } catch (e) { if (e.status === 401) darajaTokens.clear(); throw e; }
}
const darajaPassword = (gw, ts) => Buffer.from(`${gw.cfg.shortcode}${gw.secrets.passkey}${ts}`).toString('base64');

const mpesa = {
    label: 'M-Pesa (Safaricom Daraja STK push)',
    async charge(gw, { amountKes, phone, ref, desc, callbackUrl }) {
        const ts = eatStamp(), buyGoods = gw.cfg.txnType === 'till';
        const d = await darajaPost(gw, '/mpesa/stkpush/v1/processrequest', {
            BusinessShortCode: gw.cfg.shortcode, Password: darajaPassword(gw, ts), Timestamp: ts,
            TransactionType: buyGoods ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
            Amount: amountKes, PartyA: phone, PartyB: buyGoods ? (gw.cfg.till || gw.cfg.shortcode) : gw.cfg.shortcode, PhoneNumber: phone,
            CallBackURL: callbackUrl, AccountReference: String(ref).slice(0, 12), TransactionDesc: String(desc || 'Sale').slice(0, 13)
        });
        if (String(d.ResponseCode) !== '0' || !d.CheckoutRequestID) throw new Error(d.ResponseDescription || 'The STK push was rejected');
        return { providerRef: d.CheckoutRequestID };
    },
    async verify(gw, providerRef) {
        const ts = eatStamp();
        try {
            const d = await darajaPost(gw, '/mpesa/stkpushquery/v1/query', { BusinessShortCode: gw.cfg.shortcode, Password: darajaPassword(gw, ts), Timestamp: ts, CheckoutRequestID: providerRef });
            if (String(d.ResultCode) === '0') return { state: 'paid', receipt: '' };
            if (d.ResultCode !== undefined && String(d.ResultCode) !== '') return { state: 'failed', reason: d.ResultDesc || 'Payment cancelled' };
        } catch (_) { /* "still being processed" comes back as an error: stay pending */ }
        return { state: 'pending' };
    },
    async test(gw) { await darajaToken(gw); return true; },
    // Safaricom's callback body -> a plain object
    parseCallback(body) {
        const cb = body && body.Body && body.Body.stkCallback;
        if (!cb || !cb.CheckoutRequestID) return null;
        const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
        const meta = n => { const it = items.find(i => i.Name === n); return it ? it.Value : undefined; };
        return { providerRef: String(cb.CheckoutRequestID), succeeded: Number(cb.ResultCode) === 0, reason: String(cb.ResultDesc || ''), receipt: String(meta('MpesaReceiptNumber') || '').slice(0, 40), amountKes: meta('Amount') === undefined ? null : Number(meta('Amount')) };
    }
};

// ---------- Paystack (mobile money charge for Kenya). Not tested against the live API: try it with a small amount first. ----------
const paystack = {
    label: 'Paystack (M-Pesa mobile money)',
    async charge(gw, { amountKes, phone, ref, email }) {
        const d = await getJson('https://api.paystack.co/charge', {
            method: 'POST', headers: { Authorization: `Bearer ${gw.secrets.secretKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, amount: amountKes * 100, currency: 'KES', reference: ref, mobile_money: { phone: '+' + phone, provider: 'mpesa' } })
        }, 'Paystack');
        if (!d.status || !d.data) throw new Error(d.message || 'Paystack rejected the request');
        return { providerRef: String(d.data.reference || ref) };
    },
    async verify(gw, providerRef) {
        try {
            const d = await getJson(`https://api.paystack.co/transaction/verify/${encodeURIComponent(providerRef)}`, { headers: { Authorization: `Bearer ${gw.secrets.secretKey}` } }, 'Paystack');
            const s = d.data && d.data.status;
            if (s === 'success') return { state: 'paid', receipt: String((d.data.reference || '')).slice(0, 40), amountKes: Number(d.data.amount) / 100, currency: d.data.currency };
            if (s === 'failed' || s === 'abandoned' || s === 'reversed') return { state: 'failed', reason: (d.data && d.data.gateway_response) || 'Payment not completed' };
        } catch (_) { /* not ready yet */ }
        return { state: 'pending' };
    },
    async test(gw) { await getJson('https://api.paystack.co/balance', { headers: { Authorization: `Bearer ${gw.secrets.secretKey}` } }, 'Paystack'); return true; },
    // Paystack's webhook body is only used as a hint about which reference to check: the real answer is fetched with verify().
    parseCallback(body) {
        const ref = body && body.data && body.data.reference;
        return ref ? { providerRef: String(ref), hintOnly: true } : null;
    }
};

const PROVIDERS = { mpesa, paystack };

// ---------- app icons: the company logo symbol (see pos-icons.js) ----------
const ICONS = require('./pos-icons');
const iconPng = (size, maskable) => ICONS[maskable ? '512m' : size >= 512 ? '512' : '192'];

module.exports = { PROVIDERS, iconPng };
