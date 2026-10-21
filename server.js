const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// 1. Static file serving for images (logo.png, banner.png)
app.use(express.static(__dirname));

// 2. Security Headers via Helmet (configured to allow local image rendering)
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
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
                :root { --primary: #0284c7; --bg: #0f172a; --card-bg: #1e293b; --text: #f8fafc; --muted: #94a3b8; --accent: #4ade80; }
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--text); line-height: 1.6; }
                
                /* Main Navigation Bar */
                nav { background: #0b1120; border-bottom: 1px solid #334155; padding: 12px 30px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; flex-wrap: wrap; }
                .logo-container { display: flex; align-items: center; gap: 12px; text-decoration: none; }
                .logo-img { height: 48px; width: auto; border-radius: 6px; background: #ffffff; padding: 2px; }
                .logo-text-group { display: flex; flex-direction: column; }
                .logo-text { font-size: 1.25rem; font-weight: bold; color: #38bdf8; text-decoration: none; line-height: 1.1; }
                .logo-tagline { font-size: 0.75rem; color: var(--muted); }
                .nav-links { display: flex; gap: 10px; list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
                .nav-links a { color: var(--muted); text-decoration: none; font-weight: 500; font-size: 0.9rem; padding: 6px 12px; border-radius: 6px; transition: all 0.2s; }
                .nav-links a:hover, .nav-links a.active { color: white; background: #1e293b; }
                
                /* Hero Service Banner */
                .hero-banner { 
                    background: linear-gradient(rgba(15, 23, 42, 0.85), rgba(15, 23, 42, 0.85)), url('/banner.png');
                    background-size: cover;
                    background-position: center;
                    padding: 65px 20px; 
                    text-align: center; 
                    border-bottom: 1px solid #334155; 
                }
                .hero-banner h1 { font-size: 2.5rem; margin: 0 0 10px 0; color: #ffffff; }
                .hero-banner p { color: #e2e8f0; font-size: 1.2rem; margin-bottom: 20px; }
                .ussd-badge { display: inline-block; background: #38bdf8; color: #0f172a; padding: 10px 22px; border-radius: 30px; font-weight: bold; font-size: 1.1rem; box-shadow: 0 4px 15px rgba(56, 189, 248, 0.3); }

                /* Layout & Cards */
                .container { max-width: 1100px; margin: 40px auto; padding: 0 20px; }
                .service-detail-card { background: var(--card-bg); border-radius: 12px; padding: 35px; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
                .service-detail-card h2 { color: #38bdf8; margin-top: 0; font-size: 2rem; }
                .price-tag { color: var(--accent); font-weight: bold; font-size: 1.4rem; margin: 15px 0; }
                .features-list { list-style: none; padding: 0; margin: 20px 0; }
                .features-list li { margin-bottom: 10px; padding-left: 25px; position: relative; font-size: 1.05rem; }
                .features-list li::before { content: "✔"; position: absolute; left: 0; color: var(--accent); font-weight: bold; }
                
                .cta-btn { display: inline-block; background: var(--primary); color: white; padding: 12px 25px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 1rem; margin-top: 15px; }
                .cta-btn:hover { background: #0369a1; }
                
                .contact-bar { background: #0b1120; border-top: 1px solid #334155; padding: 20px; text-align: center; color: var(--muted); margin-top: 50px; }
                .contact-bar strong { color: #38bdf8; }
                footer { text-align: center; padding: 20px; color: var(--muted); font-size: 0.9rem; }
            </style>
        </head>
        <body>
            <!-- Main Navigation Menu -->
            <nav>
                <a href="/" class="logo-container">
                    <img src="/logo.png" alt="Tencent Innovations" class="logo-img">
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

            ${content}

            <div class="contact-bar">
                📍 <strong>Rangwe, Homa Bay County</strong> &nbsp;|&nbsp; 📞 <strong>0740 311 014</strong> &nbsp;|&nbsp; ✉️ <strong>tencentbz@gmail.com</strong>
            </div>

            <footer>
                <p>&copy; 2026 Tencent Innovations. All rights reserved. Powered by Secure USSD & Multi-Page Web Platform.</p>
            </footer>
        </body>
        </html>
    `;
}

// 1. Homepage Route
app.get('/', (req, res) => {
    const content = `
        <div class="hero-banner">
            <h1>Internet. Security. Power. One Call.</h1>
            <p>WiFi, CCTV, Solar Backup, and Cabling — Installed and supported by one local team.</p>
            <div class="ussd-badge">📱 Dial *384*100# on your phone for instant booking</div>
        </div>
        <div class="container">
            <h2 style="text-align: center; color: #38bdf8;">Explore Our Specialized Services</h2>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 30px;">
                <div style="background: var(--card-bg); padding: 25px; border-radius: 12px; border: 1px solid #334155;">
                    <h3 style="color: #38bdf8; margin-top: 0;">WiFi & Hotspot Internet</h3>
                    <p style="color: var(--muted);">High-speed Wi-Fi setups, structured cabling, and mesh hotspot configurations.</p>
                    <a href="/wifi" class="cta-btn">View WiFi Services →</a>
                </div>
                <div style="background: var(--card-bg); padding: 25px; border-radius: 12px; border: 1px solid #334155;">
                    <h3 style="color: #38bdf8; margin-top: 0;">CCTV Installation</h3>
                    <p style="color: var(--muted);">HD security camera installations with 24/7 mobile viewing and motion alerts.</p>
                    <a href="/cctv" class="cta-btn">View CCTV Services →</a>
                </div>
                <div style="background: var(--card-bg); padding: 25px; border-radius: 12px; border: 1px solid #334155;">
                    <h3 style="color: #38bdf8; margin-top: 0;">Smart Locks</h3>
                    <p style="color: var(--muted);">Biometric, keycard, and passcode keyless entry solutions for homes & Airbnbs.</p>
                    <a href="/smart-locks" class="cta-btn">View Smart Locks →</a>
                </div>
                <div style="background: var(--card-bg); padding: 25px; border-radius: 12px; border: 1px solid #334155;">
                    <h3 style="color: #38bdf8; margin-top: 0;">Electric Fencing</h3>
                    <p style="color: var(--muted);">High-voltage security electric fencing with energizer and alarm integrations.</p>
                    <a href="/electric-fence" class="cta-btn">View Electric Fence →</a>
                </div>
                <div style="background: var(--card-bg); padding: 25px; border-radius: 12px; border: 1px solid #334155;">
                    <h3 style="color: #38bdf8; margin-top: 0;">Solar Backup Power</h3>
                    <p style="color: var(--muted);">Custom off-grid & hybrid solar PV designs, inverters, and battery backups.</p>
                    <a href="/solar" class="cta-btn">View Solar Systems →</a>
                </div>
                <div style="background: var(--card-bg); padding: 25px; border-radius: 12px; border: 1px solid #334155;">
                    <h3 style="color: #38bdf8; margin-top: 0;">Surveys & Quotations</h3>
                    <p style="color: var(--muted);">On-site technical audits, scoping, and itemized bill of quantities.</p>
                    <a href="/survey" class="cta-btn">Request Site Visit →</a>
                </div>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'Home', activeNav: 'home', content }));
});

// 2. Service Sub-pages
app.get('/wifi', (req, res) => {
    const content = `
        <div class="container">
            <div class="service-detail-card">
                <h2>WiFi & Hotspot Internet Services</h2>
                <div class="price-tag">Consultation & Planning: KES 2,500</div>
                <p>We deliver high-performance wired and wireless networking installations tailored for homes, office spaces, and commercial buildings.</p>
                <h3>Key Features:</h3>
                <ul class="features-list">
                    <li>Seamless Mesh WiFi and Hotspot Coverage</li>
                    <li>Enterprise Router & Switch Configurations</li>
                    <li>Structured Cat6/Cat6A LAN Cabling</li>
                    <li>Bandwidth Control & Guest WiFi Setup</li>
                </ul>
                <a href="tel:*384*100#" class="cta-btn">Book via USSD (*384*100# - Option 1)</a>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'WiFi & Networking', activeNav: 'wifi', content }));
});

app.get('/cctv', (req, res) => {
    const content = `
        <div class="container">
            <div class="service-detail-card">
                <h2>CCTV Installation & Surveillance</h2>
                <div class="price-tag">Consultation & Assessment: KES 3,000</div>
                <p>Protect your property with state-of-the-art IP and analog high-definition CCTV systems with remote smartphone monitoring.</p>
                <h3>Key Features:</h3>
                <ul class="features-list">
                    <li>Full HD & 4K IP Camera Installations</li>
                    <li>Night Vision & Smart Motion Detection</li>
                    <li>Remote Mobile App Integration (iOS & Android)</li>
                    <li>DVR/NVR Storage Setup & System Maintenance</li>
                </ul>
                <a href="tel:*384*100#" class="cta-btn">Book via USSD (*384*100# - Option 2)</a>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'CCTV Systems', activeNav: 'cctv', content }));
});

app.get('/smart-locks', (req, res) => {
    const content = `
        <div class="container">
            <div class="service-detail-card">
                <h2>Smart Locks & Access Control</h2>
                <div class="price-tag">Consultation & Fitting Advisory: KES 3,000</div>
                <p>Keyless entry systems designed for homes, Airbnbs, and commercial offices.</p>
                <h3>Key Features:</h3>
                <ul class="features-list">
                    <li>Fingerprint, Passcode & RFID Card Entry</li>
                    <li>Mobile App Passcode Generation for Guests</li>
                    <li>Anti-Prying Tamper Alarms</li>
                    <li>Precision Mechanical Installation</li>
                </ul>
                <a href="tel:*384*100#" class="cta-btn">Book via USSD (*384*100# - Option 3)</a>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'Smart Locks', activeNav: 'smart-locks', content }));
});

app.get('/electric-fence', (req, res) => {
    const content = `
        <div class="container">
            <div class="service-detail-card">
                <h2>Electric Fence Installation</h2>
                <div class="price-tag">Consultation & Assessment: KES 5,000</div>
                <p>Secure boundary protection with high-voltage perimeter fencing systems.</p>
                <h3>Key Features:</h3>
                <ul class="features-list">
                    <li>Energizer & Alarm Siren Integration</li>
                    <li>Heavy-Duty Galvanized Wire & Post Setup</li>
                    <li>Strobe Light Tamper Alerts</li>
                    <li>Perimeter Maintenance & Repairs</li>
                </ul>
                <a href="tel:*384*100#" class="cta-btn">Book via USSD (*384*100# - Option 4)</a>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'Electric Fence', activeNav: 'electric-fence', content }));
});

app.get('/solar', (req, res) => {
    const content = `
        <div class="container">
            <div class="service-detail-card">
                <h2>Solar Backup Power Systems</h2>
                <div class="price-tag">Consultation & System Sizing: KES 3,500</div>
                <p>Reliable clean energy systems designed to keep your business and home running through power outages.</p>
                <h3>Key Features:</h3>
                <ul class="features-list">
                    <li>Off-Grid, On-Grid & Hybrid Solar Systems</li>
                    <li>Lithium Battery & Inverter Configurations</li>
                    <li>Solar Water Pumping & Lighting</li>
                    <li>Energy Audit & System Sizing</li>
                </ul>
                <a href="tel:*384*100#" class="cta-btn">Book via USSD (*384*100# - Option 5)</a>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'Solar Solutions', activeNav: 'solar', content }));
});

app.get('/survey', (req, res) => {
    const content = `
        <div class="container">
            <div class="service-detail-card">
                <h2>Free Site Visit & Professional Quotations</h2>
                <div class="price-tag">On-Site Survey: KES 5,500</div>
                <p>Detailed technical audits and precise pricing quotes for all installations in Rangwe and surrounding regions.</p>
                <h3>What You Get:</h3>
                <ul class="features-list">
                    <li>On-Site Technical Audits & Measurements</li>
                    <li>Comprehensive Itemized Bill of Quantities (BoQ)</li>
                    <li>Customized Blueprint & Solution Architecture</li>
                </ul>
                <a href="tel:*384*100#" class="cta-btn">Book via USSD (*384*100# - Option 6)</a>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'Surveys & Quotations', activeNav: 'survey', content }));
});

// 3. USSD Endpoint
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
6. Free Site Visit / Survey`;
    } else if (text === '1') {
        response = `CON WiFi Setup: KES 2,500
1. Confirm & Pay via M-PESA`;
    } else if (text === '2') {
        response = `CON CCTV Installation: KES 3,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '3') {
        response = `CON Smart Locks: KES 3,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '4') {
        response = `CON Electric Fence: KES 3,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '5') {
        response = `CON Solar Backup: KES 3,500
1. Confirm & Pay via M-PESA`;
    } else if (text === '6') {
        response = `CON Site Visit: KES 5,500
1. Confirm & Pay via M-PESA`;
    } else if (text.endsWith('*1')) {
        response = `END Thank you! An M-PESA payment prompt has been sent to ${phoneNumber}. Enter your PIN to complete booking.`;
    } else {
        response = `END Invalid selection. Please dial again.`;
    }

    res.set('Content-Type', 'text/plain');
    res.send(response);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Branded Tencent Innovations Platform running on port ${PORT}`));
