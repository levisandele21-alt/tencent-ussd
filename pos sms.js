'use strict';
// ---------------------------------------------------------------------------
// Tencent POS: sending SMS through the shop's OWN account with the SMS company of its choice.
// The shop's keys are stored encrypted (see pos-security.js). None of these providers has been tested against its live
// service by us: each shop should try sandbox / a test message to its own phone before relying on it.
// To add another company: add an entry to PROVIDERS below (fields to ask for, send(), check()).
// ---------------------------------------------------------------------------

// Keeps messages to plain characters so they stay in the cheap single-part SMS alphabet.
const clean = s => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[\r\t]+/g, ' ').replace(/[^\x20-\x7E\n]/g, '').replace(/ {2,}/g, ' ').trim();

async function http(url, opts) {
    const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    let data = {}; try { data = await resp.json(); } catch (_) { /* not JSON */ }
    return { status: resp.status, data };
}
const down = status => status >= 500 ? { ok: false, error: 'The SMS company had a problem (HTTP ' + status + ')', transient: true } : null;
// Safe to try again only when we KNOW the request never left (could not connect). A timeout or dropped connection may have been delivered, so it is marked "unknown" and never re-sent by itself.
const SAFE_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'];
const unreachable = e => SAFE_CODES.includes(e && (e.code || (e.cause && e.cause.code)))
    ? { ok: false, error: 'Could not reach the SMS company', transient: true }
    : { ok: false, error: 'No answer from the SMS company: it may or may not have sent this message. Check with them before sending again.', transient: false, unknown: true };

// ---------- Africa's Talking ----------
const AT_HOSTS = { sandbox: 'https://api.sandbox.africastalking.com', production: 'https://api.africastalking.com' };
const atHost = cfg => process.env.SMS_BASE_URL_POS || AT_HOSTS[cfg.env === 'production' ? 'production' : 'sandbox'];
const africastalking = {
    label: "Africa's Talking",
    help: "Copy your username and an API key from africastalking.com. Sandbox messages are not delivered to real phones.",
    fields: [
        { key: 'username', label: 'Username', re: /^[A-Za-z0-9_.-]{2,40}$/, bad: 'Enter your Africa\'s Talking username.' },
        { key: 'apiKey', label: 'API key', secret: true, re: /^\S{10,200}$/, bad: 'Enter your Africa\'s Talking API key.' },
        { key: 'sender', label: 'Sender name (optional)', optional: true, re: /^[A-Za-z0-9]{0,11}$/, hint: 'Up to 11 letters or numbers, approved in your account first.' },
        { key: 'env', label: 'Mode', choices: [['sandbox', 'Sandbox (testing)'], ['production', 'Live (real messages)']], re: /^(sandbox|production)$/ }
    ],
    async send(cfg, sec, to, message) {
        try {
            const form = new URLSearchParams({ username: cfg.username, to: '+' + to, message });
            if (cfg.sender) form.set('from', cfg.sender);
            const { status, data } = await http(atHost(cfg) + '/version1/messaging', { method: 'POST', headers: { apiKey: sec.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
            if (status === 401) return { ok: false, error: 'The SMS company rejected the API key', transient: false };
            if (down(status)) return down(status);
            const r = data && data.SMSMessageData && data.SMSMessageData.Recipients && data.SMSMessageData.Recipients[0];
            if (r && [100, 101, 102].includes(Number(r.statusCode))) return { ok: true, ref: String(r.messageId || '').slice(0, 60) };
            return { ok: false, error: String((r && r.status) || (data.SMSMessageData && data.SMSMessageData.Message) || 'HTTP ' + status).slice(0, 150), transient: false };
        } catch (e) { return unreachable(e); }
    },
    async check(cfg, sec) {
        const { status, data } = await http(atHost(cfg) + '/version1/user?username=' + encodeURIComponent(cfg.username), { headers: { apiKey: sec.apiKey, Accept: 'application/json' } });
        if (status === 401) throw new Error('The API key or username was rejected');
        if (status >= 400) throw new Error('SMS company error (HTTP ' + status + ')');
        return 'balance ' + String((data.UserData && data.UserData.balance) || 'ok');
    }
};

// ---------- Twilio ----------
const twilio = {
    label: 'Twilio',
    help: 'Copy the Account SID and Auth Token from the Twilio console. "From" is your Twilio number (like +12025550123) or an approved sender name.',
    fields: [
        { key: 'accountSid', label: 'Account SID', re: /^AC[a-f0-9]{32}$/i, bad: 'The Account SID starts with AC and is 34 characters.' },
        { key: 'authToken', label: 'Auth token', secret: true, re: /^[A-Za-z0-9]{20,64}$/, bad: 'Enter your Twilio auth token.' },
        { key: 'from', label: 'From (number or sender name)', re: /^(\+\d{7,15}|[A-Za-z0-9 ]{1,11})$/, bad: 'Enter your Twilio number (+...) or approved sender name.' }
    ],
    async send(cfg, sec, to, message) {
        try {
            const { status, data } = await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`, {
                method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(cfg.accountSid + ':' + sec.authToken).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ To: '+' + to, From: cfg.from, Body: message }).toString()
            });
            if (status === 401) return { ok: false, error: 'Twilio rejected the Account SID or auth token', transient: false };
            if (down(status)) return down(status);
            if (status === 429) return { ok: false, error: 'Twilio asked us to slow down', transient: true };
            if (data && data.sid && status < 300) return { ok: true, ref: String(data.sid).slice(0, 60) };
            return { ok: false, error: String(data.message || 'HTTP ' + status).slice(0, 150), transient: false };
        } catch (e) { return unreachable(e); }
    },
    async check(cfg, sec) {
        const { status, data } = await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Balance.json`, { headers: { Authorization: 'Basic ' + Buffer.from(cfg.accountSid + ':' + sec.authToken).toString('base64') } });
        if (status === 401) throw new Error('The Account SID or auth token was rejected');
        if (status >= 400) throw new Error('Twilio error (HTTP ' + status + ')');
        return 'balance ' + [data.currency, data.balance].filter(Boolean).join(' ');
    }
};

// ---------- Kenyan companies that share the "apikey + partnerID + shortcode" style of API ----------
function partnerStyle(label, host, help) {
    return {
        label, help,
        fields: [
            { key: 'partnerID', label: 'Partner ID', re: /^[0-9]{1,12}$/, bad: 'The Partner ID is a number from your dashboard.' },
            { key: 'apikey', label: 'API key', secret: true, re: /^\S{8,200}$/, bad: 'Enter your API key.' },
            { key: 'shortcode', label: 'Sender ID / shortcode', re: /^[A-Za-z0-9]{1,11}$/, bad: 'Enter the sender ID (shortcode) registered on your account.' }
        ],
        async send(cfg, sec, to, message) {
            try {
                const { status, data } = await http(`${process.env.SMS_BASE_URL_POS || host}/api/services/sendsms/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apikey: sec.apikey, partnerID: cfg.partnerID, message, shortcode: cfg.shortcode, mobile: to }) });
                if (down(status)) return down(status);
                const r = data && Array.isArray(data.responses) && data.responses[0];
                const code = r ? Number(r['response-code'] !== undefined ? r['response-code'] : r['respose-code']) : NaN;   // one provider's docs spell it "respose-code"
                if (code === 200) return { ok: true, ref: String(r.messageid || '').slice(0, 60) };
                return { ok: false, error: String((r && r['response-description']) || (code ? 'Error code ' + code : 'HTTP ' + status)).slice(0, 150), transient: false };
            } catch (e) { return unreachable(e); }
        },
        async check() { return 'keys cannot be checked without sending: use "Send myself a test SMS"'; }
    };
}
const advanta = partnerStyle('Advanta (Advanta Africa)', 'https://quicksms.advantasms.com', 'Copy the API key, Partner ID and sender ID (shortcode) from your Advanta dashboard.');
const celcom = partnerStyle('Celcom Africa', 'https://isms.celcomafrica.com', 'Copy the API key, Partner ID and sender ID (shortcode) from your Celcom dashboard.');


// ---------- Any other company: the shop describes the company's HTTP API itself ----------
// One engine serves three kinds: plain (address + body + header), login-first (get a token, then send) and signed (HMAC signature header).
const crypto = require('crypto'), dns = require('dns').promises, net = require('net'), https = require('https'), httpMod = require('http');
const TEST_MODE = process.env.SMS_ALLOW_INSECURE_TEST === '1';   // only for automated tests: allows http and local addresses

// A mistake in the shop's settings: retrying can never fix it. Network trouble is a plain Error and IS retried.
class SmsConfigError extends Error { constructor(msg) { super(msg); this.permanent = true; } }
const fail = (e, fallback) => e && e.permanent ? { ok: false, error: e.message, transient: false } : (e && e.code === 'ENOTFOUND' ? { ok: false, error: 'The SMS company address was not found', transient: false } : fallback());

function privateIp(ip) {
    if (net.isIPv6(ip)) { const l = ip.toLowerCase(); if (l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l)) return true; const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); return m ? privateIp(m[1]) : false; }
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
const PLACEHOLDER = /\{\{(to|plus_to|message|sender|key|token|user|pass|timestamp|body|signature)\}\}/g;
const fill = (tpl, vals, mode) => String(tpl || '').replace(PLACEHOLDER, (_, k) => {
    const v = String(vals[k] == null ? '' : vals[k]);
    return mode === 'json' ? JSON.stringify(v).slice(1, -1) : mode === 'header' ? v.replace(/[\r\n]/g, '') : mode === 'raw' ? v : encodeURIComponent(v);
});
// Validates the address and returns { u, ip }: ip is the checked public address we then connect to (so the name cannot change in between).
async function safeTarget(rawUrl) {
    let u; try { u = new URL(rawUrl); } catch (_) { throw new SmsConfigError('The API address is not valid'); }
    if (TEST_MODE) return { u, ip: null };
    if (u.protocol !== 'https:') throw new SmsConfigError('The address must start with https://');
    if (u.username || u.password) throw new SmsConfigError('Do not put a password in the address');
    if (u.port && u.port !== '443') throw new SmsConfigError('Only the normal https port is allowed');
    if (net.isIP(u.hostname)) throw new SmsConfigError("Use the company's website name, not a numeric address");
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new SmsConfigError('That address is not a public website');
    return { u, ip: addrs[0].address };
}
function rawRequest(u, ip, { method, headers, body }) {
    return new Promise((resolve, reject) => {
        const mod = u.protocol === 'http:' ? httpMod : https;
        const req = mod.request({ host: ip || u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method, servername: u.hostname, headers: { ...headers, Host: u.host }, timeout: 20000 }, res => {
            let data = ''; res.setEncoding('utf8'); res.on('data', c => { if (data.length < 4000) data += c; }); res.on('end', () => resolve({ status: res.statusCode, text: data }));
        });   // redirects are NOT followed
        req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
        if (body) req.write(body); req.end();
    });
}
const pathGet = (obj, path) => String(path || '').split('.').filter(Boolean).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const tokenCache = new Map();   // login-first providers: cache key -> { token, exp }

async function fetchToken(cfg, sec, vals, force) {
    const ck = crypto.createHash('sha256').update(cfg.loginUrl + '|' + cfg.loginUser + '|' + (sec.loginPass || '')).digest('hex');
    const hit = tokenCache.get(ck);
    if (!force && hit && hit.exp > Date.now()) return hit.token;
    const json = cfg.format !== 'form', lv = { ...vals, user: cfg.loginUser, pass: sec.loginPass || '' };
    const t = await safeTarget(fill(cfg.loginUrl, lv, 'form'));
    const body = fill(cfg.loginBody, lv, json ? 'json' : 'form');
    const r = await rawRequest(t.u, t.ip, { method: 'POST', headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'TencentPOS/1.0' }, body });
    if (r.status >= 500) throw new Error('login service down (HTTP ' + r.status + ')');
    let data = {}; try { data = JSON.parse(r.text); } catch (_) { /* not JSON */ }
    const token = pathGet(data, cfg.loginTokenPath);
    if (r.status < 200 || r.status >= 300 || !token || typeof token !== 'string') throw new SmsConfigError('The SMS company login was refused or its reply had no token at "' + cfg.loginTokenPath + '"');
    tokenCache.set(ck, { token, exp: Date.now() + 50 * 60 * 1000 });
    return token;
}

async function genericSend(cfg, sec, to, message, kind) {
    let stage = 'send';
    try {
        const vals = { to, plus_to: '+' + to, message, sender: cfg.sender || '', key: (sec && sec.apiKey) || '' };
        const post = cfg.method !== 'GET', json = cfg.format !== 'form';
        for (let attempt = 0; attempt < 2; attempt++) {
            if (kind === 'login') { stage = 'login'; vals.token = await fetchToken(cfg, sec, vals, attempt > 0); stage = 'send'; }
            const target = await safeTarget(fill(cfg.url, vals, 'form'));
            const headers = { Accept: '*/*', 'User-Agent': 'TencentPOS/1.0' };
            if (cfg.headerName) headers[cfg.headerName] = fill(cfg.headerValue, vals, 'header');
            let body = '';
            if (post) { body = fill(cfg.body, vals, json ? 'json' : 'form'); headers['Content-Type'] = json ? 'application/json' : 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
            if (kind === 'signed') {
                const ts = String(Math.floor(Date.now() / 1000)), sv = { ...vals, timestamp: ts, body };
                const sig = crypto.createHmac(cfg.sigAlgo === 'sha512' ? 'sha512' : 'sha256', (sec && sec.signKey) || '').update(fill(cfg.sigInput || '{{timestamp}}.{{body}}', sv, 'raw')).digest(cfg.sigEncoding === 'base64' ? 'base64' : 'hex');
                headers[cfg.sigHeader] = sig; if (cfg.tsHeader) headers[cfg.tsHeader] = ts;
            }
            const r = await rawRequest(target.u, target.ip, { method: post ? 'POST' : 'GET', headers, body });
            if (kind === 'login' && (r.status === 401 || r.status === 403) && attempt === 0) { continue; }   // token expired: log in again once
            if (r.status >= 500 || r.status === 429) return { ok: false, error: 'The SMS company had a problem (HTTP ' + r.status + ')', transient: true };
            const snippet = clean(r.text).slice(0, 80);
            if (r.status >= 200 && r.status < 300 && (!cfg.okText || r.text.toLowerCase().includes(cfg.okText.toLowerCase()))) return { ok: true, ref: '' };
            return { ok: false, error: ('HTTP ' + r.status + (snippet ? ': ' + snippet : '')).slice(0, 150), transient: false };
        }
    } catch (e) { return stage === 'login' && !e.permanent ? { ok: false, error: 'Could not log in to the SMS company', transient: true } : fail(e, () => unreachable(e)); }   // nothing was sent yet, so a failed login is safe to retry
}
const checkGeneric = async cfg => { await safeTarget(cfg.url.replace(PLACEHOLDER, 'x')); return 'cannot be checked without sending: use "Send myself a test SMS"'; };

const PH_HELP = 'In the address, header and body you can use {{to}} (254712345678), {{plus_to}} (+254712345678), {{message}}, {{sender}} and {{key}} (your API key below).';
const baseFields = [
    { key: 'url', label: 'Send address (https://...)', re: /^https?:\/\/[^\s{/?#]+[^\s]{0,280}$/, bad: 'Enter the API address starting with https://' },
    { key: 'method', label: 'Method', choices: [['POST', 'POST'], ['GET', 'GET']], re: /^(POST|GET)$/ },
    { key: 'format', label: 'Body format (POST)', choices: [['json', 'JSON'], ['form', 'Form fields (a=1&b=2)']], re: /^(json|form)$/ },
    { key: 'body', label: 'Body (POST)', textarea: true, optional: true, re: /^[\s\S]{0,1500}$/, hint: 'Example JSON: {"to":"{{to}}","text":"{{message}}","from":"{{sender}}"}' },
    { key: 'headerName', label: 'Header name (optional)', optional: true, re: /^[A-Za-z0-9-]{0,40}$/, hint: 'For example Authorization or X-API-Key' },
    { key: 'headerValue', label: 'Header value (optional)', optional: true, re: /^[\x20-\x7E]{0,300}$/, hint: 'For example Bearer {{key}}' },
    { key: 'apiKey', label: 'API key / token (kept secret)', secret: true, optional: true, re: /^\S{0,300}$/ },
    { key: 'sender', label: 'Sender name (optional)', optional: true, re: /^[A-Za-z0-9 +-]{0,20}$/ },
    { key: 'okText', label: 'Success text (optional)', optional: true, re: /^[\x20-\x7E]{0,60}$/, hint: 'A word the company replies with when a message is accepted, like Success. Empty means any normal (2xx) reply counts as sent.' }
];
const other = { label: 'Another company (my own API settings)', kind: 'plain', help: 'For any SMS company with an HTTP API. Copy the address, method and body from the company\'s API page. ' + PH_HELP + ' Then use "Send myself a test SMS".', fields: baseFields, send: (c, s, t, m) => genericSend(c, s, t, m, 'plain'), check: checkGeneric };
const loginFirst = {
    label: 'Another company: log in first, then send', kind: 'login',
    help: 'For companies that give a token after a login call. First the POS logs in, takes the token from the reply, then sends. Also use {{token}} (and {{user}}, {{pass}} in the login body). ' + PH_HELP,
    fields: [
        { key: 'loginUrl', label: 'Login address (https://...)', re: /^https?:\/\/[^\s{/?#]+[^\s]{0,280}$/, bad: 'Enter the login address starting with https://' },
        { key: 'loginUser', label: 'Login username', re: /^[\x20-\x7E]{1,120}$/, bad: 'Enter the login username.' },
        { key: 'loginPass', label: 'Login password (kept secret)', secret: true, re: /^[\x20-\x7E]{1,200}$/, bad: 'Enter the login password.' },
        { key: 'loginBody', label: 'Login body', textarea: true, re: /^[\s\S]{1,800}$/, bad: 'Enter the login body.', hint: 'Example JSON: {"username":"{{user}}","password":"{{pass}}"}' },
        { key: 'loginTokenPath', label: 'Where is the token in the login reply?', re: /^[A-Za-z0-9_.-]{1,80}$/, bad: 'Enter where the token is, like data.access_token', hint: 'Dots go into the reply: data.access_token means {"data":{"access_token":"..."}}' },
        ...baseFields.filter(f => f.key !== 'apiKey')
    ],
    send: (c, s, t, m) => genericSend(c, s, t, m, 'login'), check: checkGeneric
};
const signed = {
    label: 'Another company: signed requests (HMAC)', kind: 'signed',
    help: 'For companies that want every request signed with a secret. The POS computes an HMAC of the text you describe and puts it in a header. In the signing text you can use {{timestamp}}, {{body}}, {{to}} and {{message}}. ' + PH_HELP,
    fields: [
        ...baseFields.filter(f => f.key !== 'apiKey'),
        { key: 'apiKey', label: 'API key (kept secret, optional)', secret: true, optional: true, re: /^\S{0,300}$/ },
        { key: 'signKey', label: 'Signing secret (kept secret)', secret: true, re: /^\S{4,300}$/, bad: 'Enter the signing secret.' },
        { key: 'sigHeader', label: 'Signature header name', re: /^[A-Za-z0-9-]{1,40}$/, bad: 'Enter the header name for the signature, like X-Signature.' },
        { key: 'sigInput', label: 'Text to sign', re: /^[\x20-\x7E{}.:|,;_-]{1,200}$/, bad: 'Enter the text to sign, like {{timestamp}}.{{body}}', hint: 'Example: {{timestamp}}.{{body}}' },
        { key: 'sigAlgo', label: 'Algorithm', choices: [['sha256', 'HMAC-SHA256'], ['sha512', 'HMAC-SHA512']], re: /^(sha256|sha512)$/ },
        { key: 'sigEncoding', label: 'Signature written as', choices: [['hex', 'Hex'], ['base64', 'Base64']], re: /^(hex|base64)$/ },
        { key: 'tsHeader', label: 'Timestamp header name (optional)', optional: true, re: /^[A-Za-z0-9-]{0,40}$/, hint: 'Example: X-Timestamp' }
    ],
    send: (c, s, t, m) => genericSend(c, s, t, m, 'signed'), check: checkGeneric
};

// ---------- Amazon SNS (AWS): SMS through the shop's own AWS account, signed with AWS Signature V4 ----------
function signV4({ method, host, path, query = '', headers, body, region, service, accessKey, secretKey, now = new Date() }) {
    const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amz.slice(0, 8);
    const hs = { ...headers, host, 'x-amz-date': amz };
    const names = Object.keys(hs).map(k => k.toLowerCase()).sort();
    const lower = {}; for (const k of Object.keys(hs)) lower[k.toLowerCase()] = String(hs[k]).trim().replace(/\s+/g, ' ');
    const canonHeaders = names.map(n => n + ':' + lower[n] + '\n').join(''), signed = names.join(';');
    const sha = s => crypto.createHash('sha256').update(s).digest('hex');
    const canon = [method, path, query, canonHeaders, signed, sha(body || '')].join('\n');
    const scope = `${day}/${region}/${service}/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
    const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const key = hm(hm(hm(hm('AWS4' + secretKey, day), region), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', key).update(sts).digest('hex');
    return { ...hs, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
const aws = {
    label: 'Amazon AWS (SNS)', kind: 'aws',
    help: 'Create an IAM user in your AWS account that is allowed sns:Publish, then copy its access key here. Messages are charged to your AWS bill. New AWS accounts start in the SMS sandbox: verify your own number first.',
    fields: [
        { key: 'accessKeyId', label: 'Access key ID', re: /^[A-Z0-9]{16,32}$/, bad: 'The access key ID is 20 capital letters and numbers.' },
        { key: 'secretAccessKey', label: 'Secret access key (kept secret)', secret: true, re: /^[A-Za-z0-9/+=]{30,60}$/, bad: 'Enter the secret access key.' },
        { key: 'region', label: 'Region', re: /^[a-z]{2}-[a-z]+-\d$/, bad: 'Enter the region, like eu-west-1 or af-south-1.' },
        { key: 'senderId', label: 'Sender name (optional)', optional: true, re: /^[A-Za-z0-9]{0,11}$/, hint: 'Many countries ignore it or need it registered.' },
        { key: 'smsType', label: 'Message type', choices: [['Transactional', 'Transactional (more reliable)'], ['Promotional', 'Promotional (cheaper)']], re: /^(Transactional|Promotional)$/ }
    ],
    async send(cfg, sec, to, message) {
        try {
            const params = [['Action', 'Publish'], ['Message', message], ['PhoneNumber', '+' + to], ['Version', '2010-03-31'],
                ['MessageAttributes.entry.1.Name', 'AWS.SNS.SMS.SMSType'], ['MessageAttributes.entry.1.Value.DataType', 'String'], ['MessageAttributes.entry.1.Value.StringValue', cfg.smsType === 'Promotional' ? 'Promotional' : 'Transactional']];
            if (cfg.senderId) params.push(['MessageAttributes.entry.2.Name', 'AWS.SNS.SMS.SenderID'], ['MessageAttributes.entry.2.Value.DataType', 'String'], ['MessageAttributes.entry.2.Value.StringValue', cfg.senderId]);
            const body = params.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
            const base = process.env.SMS_BASE_URL_POS_AWS || `https://sns.${cfg.region}.amazonaws.com`, u = new URL(base + '/');
            const headers = signV4({ method: 'POST', host: u.host, path: '/', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body, region: cfg.region, service: 'sns', accessKey: cfg.accessKeyId, secretKey: sec.secretAccessKey });
            headers['Content-Length'] = Buffer.byteLength(body);
            const r = await rawRequest(u, null, { method: 'POST', headers, body });
            const id = (r.text.match(/<MessageId>([^<]+)<\/MessageId>/) || [])[1];
            if (r.status >= 500 || r.status === 429) return { ok: false, error: 'AWS had a problem (HTTP ' + r.status + ')', transient: true };
            if (r.status === 200 && id) return { ok: true, ref: id.slice(0, 60) };
            const code = (r.text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || 'HTTP ' + r.status, msg = (r.text.match(/<Message>([^<]+)<\/Message>/) || [])[1] || '';
            if (/Throttl/i.test(code)) return { ok: false, error: 'AWS asked us to slow down', transient: true };
            return { ok: false, error: (code + (msg ? ': ' + msg : '')).slice(0, 150), transient: false };
        } catch (e) { return fail(e, () => unreachable(e)); }
    },
    async check() { return 'keys cannot be checked without sending: use "Send myself a test SMS"'; }
};

const PROVIDERS = { africastalking, twilio, advanta, celcom, aws, other, login: loginFirst, signed };
const providerOf = cfg => PROVIDERS[(cfg && cfg.provider) || 'africastalking'];   // older saved settings were Africa's Talking

const configured = (cfg, secrets) => {
    const p = cfg && providerOf(cfg);
    if (!p || !secrets) return false;
    return p.fields.every(f => f.optional || f.choices || (f.secret ? secrets[f.key] : cfg[f.key]));
};
const send = (cfg, secrets, to, message) => providerOf(cfg).send(cfg, secrets, to, message);
const balance = (cfg, secrets) => providerOf(cfg).check(cfg, secrets);

module.exports = { PROVIDERS, providerOf, configured, send, balance, clean, fill, signV4, SmsConfigError };
