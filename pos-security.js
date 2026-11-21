'use strict';
// ---------------------------------------------------------------------------
// Tencent POS security helpers: two-step login codes (TOTP, RFC 6238), recovery codes,
// and the encrypted key-ring used for payment gateway secrets.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

// ---------- key-ring vault: AES-256-GCM, one derived key per business, old keys can still be read ----------
// POS_CRED_KEY = current key. POS_CRED_KEY_OLD = older keys, comma separated (kept only while rotating).
function makeVault(current, olds = []) {
    const keys = [current, ...olds].map(k => String(k || '').trim()).filter(k => k.length >= 24)
        .map(k => ({ master: k, id: crypto.createHash('sha256').update(k).digest('hex').slice(0, 8) }));
    const derive = (k, scope) => Buffer.from(crypto.hkdfSync('sha256', k.master, 'tencent-pos-vault-v2', 'scope:' + scope, 32));
    const b64 = b => Buffer.from(b).toString('base64url');
    const parse = text => { const [v, kid, iv, tag, ct] = String(text || '').split('.'); return v === 'v2' && kid && iv && tag && ct ? { kid, iv, tag, ct } : null; };
    return {
        enabled: Boolean(keys[0]) && String(current || '').trim().length >= 24,
        keyId: keys[0] ? keys[0].id : '',
        // scope ties the ciphertext to its owner (for example "12:mpesa"), so a row copied to another business cannot be decrypted
        seal(obj, scope) {
            if (!keys[0] || String(current || '').trim() !== keys[0].master) throw new Error('POS_CRED_KEY is not set');
            const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', derive(keys[0], scope), iv);
            c.setAAD(Buffer.from('scope:' + scope));
            const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
            return ['v2', keys[0].id, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
        },
        open(text, scope) {
            const p = parse(text);
            if (!p) throw new Error('Unreadable credentials');
            const k = keys.find(x => x.id === p.kid);
            if (!k) throw new Error('No key is available for these credentials (check POS_CRED_KEY / POS_CRED_KEY_OLD)');
            const d = crypto.createDecipheriv('aes-256-gcm', derive(k, scope), Buffer.from(p.iv, 'base64url'));
            d.setAAD(Buffer.from('scope:' + scope)); d.setAuthTag(Buffer.from(p.tag, 'base64url'));
            return JSON.parse(Buffer.concat([d.update(Buffer.from(p.ct, 'base64url')), d.final()]).toString('utf8'));
        },
        needsRotation(text) { const p = parse(text); return Boolean(p && keys[0] && p.kid !== keys[0].id); }
    };
}

// ---------- TOTP (works with Google Authenticator, Microsoft Authenticator, Authy ...) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
    let bits = '', out = '';
    for (const b of buf) bits += b.toString(2).padStart(8, '0');
    for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    return out;
}
function b32decode(s) {
    let bits = '';
    for (const ch of String(s).toUpperCase().replace(/[\s=-]/g, '')) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); bits += i.toString(2).padStart(5, '0'); }
    const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(out);
}
const newTotpSecret = () => b32encode(crypto.randomBytes(20));
function hotp(secretBuf, counter, digits = 6) {
    const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', secretBuf).update(msg).digest(), o = h[h.length - 1] & 15;
    const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 10 ** digits).padStart(digits, '0');
}
// returns the matched time-step (so the caller can refuse to accept the same code twice) or null
function checkTotp(secretB32, code, lastCounter = 0, now = Date.now()) {
    const c = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(c)) return null;
    const secret = b32decode(secretB32), step = Math.floor(now / 30000);
    for (const d of [0, -1, 1]) {   // one step either side for clock drift
        const counter = step + d, a = Buffer.from(hotp(secret, counter)), b = Buffer.from(c);
        if (counter > Number(lastCounter) && crypto.timingSafeEqual(a, b)) return counter;
    }
    return null;
}
const otpauthUri = (account, secret, issuer = 'Tencent POS') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

// ---------- recovery codes: shown once, only their hashes are stored ----------
const RC_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => { const r = Array.from(crypto.randomBytes(10), b => RC_CHARS[b % RC_CHARS.length]).join(''); return r.slice(0, 5) + '-' + r.slice(5); });
const hashRecovery = c => crypto.createHash('sha256').update('tpos-recovery:' + String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

module.exports = { makeVault, newTotpSecret, checkTotp, hotp, b32decode, otpauthUri, newRecoveryCodes, hashRecovery };
