'use strict';
// Admin-only Solar Load Profile & Sizing Calculator.
//   GET /solar-calculator       info page in the normal site layout
//   GET /solar-calculator/app   the calculator (solar-calculator.html, next to this file)
// The calculator runs in the browser; nothing entered is sent to the server.
// Mounted from server.js with guard middleware [requireDb, requireAdmin].
const fs = require('fs');
const path = require('path');

module.exports = function mountSolar({ app, renderPage, guard = [], basePath = '/solar-calculator' }) {
    const html = fs.readFileSync(path.join(__dirname, 'solar-calculator.html'), 'utf8');
    if (html.split('<script>').length !== 2) console.error('Solar calculator: expected exactly one <script> tag; the page may be blocked by the Content-Security-Policy.');
    const title = 'Solar Load Profile & Sizing Calculator';

    app.get(basePath, ...guard, (req, res) => {
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
                    <li><strong>Inverter size</strong> in kW and kVA, with a battery-voltage check.</li>
                    <li><strong>Battery bank</strong> in kWh and Ah, for all loads or essential loads only, checked against the battery's discharge-current limit.</li>
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
        // a new script nonce is issued per page, so this page is never cached
        const body = req.nonce ? html.replace('<script>', () => `<script nonce="${req.nonce}">`) : html;
        res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).send(body);
    });
};
