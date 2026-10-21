const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// 1. Security Headers via Helmet
app.use(helmet());

// 2. Trust Render's Proxy
app.set('trust proxy', 1);

// 3. Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 4. Interactive Customer Website Homepage Route
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Tencent Innovations - Professional Tech, Security & Energy Solutions</title>
            <style>
                :root { --primary: #0284c7; --bg: #0f172a; --card-bg: #1e293b; --text: #f8fafc; --muted: #94a3b8; --accent: #4ade80; }
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--text); line-height: 1.6; }
                header { background: linear-gradient(135deg, #0f172a, #1e293b); padding: 50px 20px; text-align: center; border-bottom: 1px solid #334155; }
                h1 { color: #38bdf8; margin: 0 0 10px 0; font-size: 2.5rem; }
                p.tagline { color: var(--muted); font-size: 1.2rem; margin-bottom: 20px; }
                .ussd-badge { display: inline-block; background: var(--primary); color: white; padding: 10px 20px; border-radius: 30px; font-weight: bold; font-size: 1.1rem; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.4); }
                .container { max-width: 1100px; margin: 40px auto; padding: 0 20px; }
                h2 { text-align: center; color: #38bdf8; margin-bottom: 30px; }
                .services-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
                .service-card { background: var(--card-bg); padding: 25px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); border: 1px solid #334155; display: flex; flex-direction: column; justify-content: space-between; transition: transform 0.2s; }
                .service-card:hover { transform: translateY(-5px); }
                .service-card h3 { color: #38bdf8; margin-top: 0; }
                .price { color: var(--accent); font-weight: bold; font-size: 1.1rem; margin: 15px 0; }
                .features { list-style: none; padding: 0; margin: 0 0 20px 0; color: var(--muted); text-align: left; }
                .features li { margin-bottom: 6px; padding-left: 20px; position: relative; font-size: 0.95rem; }
                .features li::before { content: "✔"; position: absolute; left: 0; color: var(--accent); }
                .cta-btn { display: block; background: var(--primary); color: white; text-align: center; padding: 10px; border-radius: 6px; text-decoration: none; font-weight: bold; transition: background 0.2s; }
                .cta-btn:hover { background: #0369a1; }
                footer { text-align: center; padding: 40px; color: var(--muted); border-top: 1px solid #334155; margin-top: 50px; }
            </style>
        </head>
        <body>
            <header>
                <h1>Tencent Innovations</h1>
                <p class="tagline">Empowering Enterprises & Homes through Tech, Security & Clean Energy</p>
                <div class="ussd-badge">📱 Prefer offline? Dial *384*100# on your phone</div>
            </header>

            <div class="container">
                <h2>Our Comprehensive Services & Solutions</h2>
                <div class="services-grid">
                    <div class="service-card">
                        <div>
                            <h3>1. WiFi & Networking</h3>
                            <p>High-speed enterprise and home Wi-Fi setups, structured cabling, and router configurations.</p>
                            <ul class="features">
                                <li>Seamless Mesh & Hotspot Coverage</li>
                                <li>Enterprise Router Setup</li>
                                <li>Network Troubleshooting</li>
                            </ul>
                        </div>
                        <div>
                            <div class="price">KES 2,500 / Consultation</div>
                            <a href="#ussd" class="cta-btn">Book via USSD (*384*100#)</a>
                        </div>
                    </div>

                    <div class="service-card">
                        <div>
                            <h3>2. CCTV & Surveillance Systems</h3>
                            <p>HD security camera installations, remote mobile viewing setup, and proactive surveillance maintenance.</p>
                            <ul class="features">
                                <li>IP & Analog Camera Setups</li>
                                <li>Mobile App Integration</li>
                                <li>Night Vision & Motion Detection</li>
                            </ul>
                        </div>
                        <div>
                            <div class="price">KES 2,000 / Consultation</div>
                            <a href="#ussd" class="cta-btn">Book via USSD (*384*100#)</a>
                        </div>
                    </div>

                    <div class="service-card">
                        <div>
                            <h3>3. Smart Locks & Access Control</h3>
                            <p>Advanced biometric, keycard, and password-enabled smart locks for secure residential and office access.</p>
                            <ul class="features">
                                <li>Fingerprint & Code Entry</li>
                                <li>Remote App Management</li>
                                <li>Professional Fitting</li>
                            </ul>
                        </div>
                        <div>
                            <div class="price">KES 2,000 / Consultation</div>
                            <a href="#ussd" class="cta-btn">Book via USSD (*384*100#)</a>
                        </div>
                    </div>

                    <div class="service-card">
                        <div>
                            <h3>4. Electric Fence Installation</h3>
                            <p>High-voltage security electric fencing systems designed to safeguard perimeter boundaries effectively.</p>
                            <ul class="features">
                                <li>Energizer & Alarm Integration</li>
                                <li>Perimeter Safety Compliance</li>
                                <li>Maintenance & Repairs</li>
                            </ul>
                        </div>
                        <div>
                            <div class="price">KES 3,000 / Consultation</div>
                            <a href="#ussd" class="cta-btn">Book via USSD (*384*100#)</a>
                        </div>
                    </div>

                    <div class="service-card">
                        <div>
                            <h3>5. Solar Installation</h3>
                            <p>End-to-end solar PV design and installation for homes and commercial enterprises to lower power costs.</p>
                            <ul class="features">
                                <li>Off-grid & Hybrid Systems</li>
                                <li>Inverter & Battery Setup</li>
                                <li>Energy Efficiency Advisory</li>
                            </ul>
                        </div>
                        <div>
                            <div class="price">KES 2,500 / Consultation</div>
                            <a href="#ussd" class="cta-btn">Book via USSD (*384*100#)</a>
                        </div>
                    </div>

                    <div class="service-card">
                        <div>
                            <h3>6. Professional Surveys & Quotation</h3>
                            <p>Detailed site assessments, technical scoping, and precise itemized quotations for your projects.</p>
                            <ul class="features">
                                <li>On-site Technical Audits</li>
                                <li>Comprehensive Bill of Quantities</li>
                                <li>Customized Solution Blueprints</li>
                            </ul>
                        </div>
                        <div>
                            <div class="price">KES 1,500 / Survey</div>
                            <a href="#ussd" class="cta-btn">Book via USSD (*384*100#)</a>
                        </div>
                    </div>
                </div>
            </div>

            <footer>
                <p>&copy; 2026 Tencent Innovations. All rights reserved. Powered by Secure USSD & Web Integration.</p>
            </footer>
        </body>
        </html>
    `);
});

// 5. USSD Callback Endpoint (Expanded menu options)
app.post('/ussd', (req, res) => {
    const { text, phoneNumber } = req.body;
    let response = '';

    if (text === '') {
        response = `CON Welcome to Tencent Innovations
1. WiFi & Networking
2. CCTV & Surveillance
3. Smart Locks
4. Electric Fence
5. Solar Installation
6. Surveys & Quotation`;
    } else if (text === '1') {
        response = `CON WiFi Setup: KES 2,500
1. Confirm & Pay via M-PESA`;
    } else if (text === '2') {
        response = `CON CCTV Installation: KES 2,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '3') {
        response = `CON Smart Locks: KES 2,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '4') {
        response = `CON Electric Fence: KES 3,000
1. Confirm & Pay via M-PESA`;
    } else if (text === '5') {
        response = `CON Solar Installation: KES 2,500
1. Confirm & Pay via M-PESA`;
    } else if (text === '6') {
        response = `CON Survey & Quotation: KES 1,500
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
app.listen(PORT, () => console.log(`Comprehensive Tencent Innovations App running on port ${PORT}`));
