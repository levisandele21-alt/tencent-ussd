'use strict';
// Admin-only Solar Load Profile & Sizing Calculator.
//   GET /solar-calculator       info page in the normal site layout
//   GET /solar-calculator/app   the calculator (solar-calculator.html, next to this file)
// The calculator runs in the browser; nothing entered is sent to the server.
// Mounted from server.js with guard middleware [requireDb, requireAdmin].
//
// The routes are always registered. If solar-calculator.html is missing or broken, administrators
// see the reason on screen (and in the server log) instead of a confusing "Page not found".
const fs = require('fs');
const path = require('path');

const HTML_FILE = path.join(__dirname, 'solar-calculator.html');
const esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = function mountSolar({ app, renderPage, guard = [], basePath = '/solar-calculator' }) {
    const title = 'Solar Load Profile & Sizing Calculator';
    let html = '';
    let loadError = '';

    // Reads the calculator page. Called at start-up and again on request while it is still missing,
    // so uploading the file later fixes the page without needing a restart.
    function loadHtml() {
        try {
            const text = fs.readFileSync(HTML_FILE, 'utf8');
            // The page must have exactly one plain inline script: a nonce is added to it so the site's
            // Content-Security-Policy lets it run.
            const scripts = text.match(/<script\b/gi) || [];
            if (scripts.length !== 1 || !text.includes('<script>')) {
                throw new Error('solar-calculator.html must contain exactly one plain <script> tag (found ' + scripts.length + ')');
            }
            html = text;
            loadError = '';
            return true;
        } catch (e) {
            html = '';
            loadError = e.code === 'ENOENT'
                ? 'solar-calculator.html was not found next to solar-calculator.js (looked in ' + __dirname + ')'
                : e.message;
            return false;
        }
    }

    if (loadHtml()) console.log('Solar calculator ready at ' + basePath);
    else console.error('Solar calculator page not loaded: ' + loadError);

    const unavailable = (req, res) => {
        const content = `
        <div class="general-container">
            <h2>Solar calculator unavailable</h2>
            <p class="intro-text">The calculator page could not be loaded.</p>
            <div class="alert" role="alert">${esc(loadError)}</div>
            <p style="color:var(--muted);">Check that <strong>solar-calculator.html</strong> is in your GitHub repository, in the same folder as <strong>server.js</strong>, with exactly that name, then redeploy.</p>
            <a href="/" class="cta-btn">Back to Home</a>
        </div>`;
        res.status(503).set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' })
            .send(renderPage(req, { title: 'Solar calculator unavailable', activeNav: 'solar-calculator', content }));
    };

    app.get(basePath, ...guard, (req, res) => {
        if (!html && !loadHtml()) return unavailable(req, res);
        res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
        const content = `
        <div class="general-container">
            <h2>Solar Load Profile &amp; Sizing Calculator</h2>
            <p class="sub-title">Admin tool: list appliances and get daily energy use, inverter size and battery bank for a customer quote.</p>
            <div class="form-container" style="border-left:4px solid var(--primary);">
                <h3 style="margin-top:0;color:var(--primary);">What it works out</h3>
                <ul style="line-height:1.8;padding-left:20px;margin-bottom:0;">
                    <li><strong>Daily energy use</strong> from a library of 55+ appliances, or your own entries.</li>
                    <li><strong>Peak start-up surge</strong>, which usually decides the inverter size.</li>
                    <li><strong>Single-phase or three-phase quote</strong>, chosen at the top of the calculator: it sets the inverter sizes, AC currents, cable sizes, breakers and the ATS.</li>
                    <li><strong>Inverter size</strong> in kW and kVA, with a battery-voltage check.</li>
                    <li><strong>Battery bank</strong> in kWh and Ah, sized only for the hours when the sun is down and the grid is off, checked against the battery's discharge-current limit.</li>
                    <li><strong>Solar array</strong> from peak sun hours and performance ratio: panel count and MPPT charge-controller rating.</li>
                    <li><strong>Best connection</strong> for the panels and for the battery bank: how many in series, how many strings in parallel, and why.</li>
                    <li><strong>Cable sizes</strong> for every run from the panels to the grid, with the breakers, fuses and surge protection each one needs.</li>
                    <li><strong>CSV export</strong> and print / save as PDF.</li>
                </ul>
            </div>
            <div class="form-container" style="margin-top:20px;">
                <p style="margin-top:0;">Entries stay in this browser only. Only administrators can see this page.</p>
                <a href="${basePath}/app" class="cta-btn">Open the calculator</a>
            </div>
            <p style="margin-top:14px;color:var(--muted);">Results are planning estimates. Confirm cable sizes and protection before buying or installing.</p>
        </div>`;
        res.send(renderPage(req, { title, activeNav: 'solar-calculator', content }));
    });

    app.get(basePath + '/app', ...guard, (req, res) => {
        if (!html && !loadHtml()) return unavailable(req, res);
        // a new script nonce is issued per page, so this page is never cached
        const body = req.nonce ? html.replace('<script>', () => `<script nonce="${req.nonce}">`) : html;
        res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).send(body);
    });
};
