const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// 1. Static file serving for images (logo.png, banner.png)
app.use(express.static(__dirname));

// 2. Security Headers via Helmet
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
            <title>\${title} - Tencent Innovations</title>
            <style>
                :root { --primary: #0284c7; --bg: #0f172a; --text: #f8fafc; --muted: #94a3b8; --accent: #4ade80; }
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--text); line-height: 1.6; }
                
                /* Main Navigation Bar */
                nav { background: #0b1120; border-bottom: 1px solid #334155; padding: 12px 30px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; flex-wrap: wrap; }
                .logo-container { display: flex; align-items: center; gap: 12px; text-decoration: none; }
                .logo-img { height: 48px; width: auto; border-radius: 6px; background: #ffffff; padding: 2px; }
                .logo-text-group { display: flex; flex-direction: column; }
                .logo-text { font-size: 1.25rem; font-weight: bold; color: #38bdf8; text-decoration: none; line-height: 1.1; }
                .logo-tagline { font-size: 0.75rem; color: var(--muted); }
                .nav-links { display: flex; gap: 8px; list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
                .nav-links a { color: var(--muted); text-decoration: none; font-weight: 500; font-size: 0.9rem; padding: 6px 12px; border-radius: 6px; transition: all 0.2s; }
                .nav-links a:hover, .nav-links a.active { color: white; background: #1e293b; }
                
                /* Hero Service Banner */
                .hero-banner { 
                    background: linear-gradient(rgba(15, 23, 42, 0.85), rgba(15, 23, 42, 0.85)), url('/banner.png');
                    background-size: cover;
                    background-position: center;
                    padding: 60px 20px; 
                    text-align: center; 
                    border-bottom: 1px solid #334155; 
                }
                .hero-banner h1 { font-size: 2.3rem; margin: 0 0 10px 0; color: #ffffff; }
                .hero-banner p { color: #e2e8f0; font-size: 1.15rem; margin-bottom: 20px; max-width: 800px; margin-left: auto; margin-right: auto; }
                .ussd-badge { display: inline-block; background: #38bdf8; color: #0f172a; padding: 10px 22px; border-radius: 30px; font-weight: bold; font-size: 1.05rem; box-shadow: 0 4px 15px rgba(56, 189, 248, 0.3); }

                /* Seamless Page Layout */
                .container { max-width: 900px; margin: 40px auto; padding: 0 20px; }
                .content-section { margin-bottom: 30px; }
                .content-section h2 { color: #38bdf8; margin-top: 0; font-size: 2.2rem; }
                .intro-text { font-size: 1.1rem; color: #e2e8f0; margin-bottom: 25px; border-left: 3px solid var(--primary); padding-left: 15px; }
                
                /* Bullet & Feature Lists */
                ul.feature-list { list-style: none; padding: 0; margin: 20px 0; }
                ul.feature-list li { margin-bottom: 12px; padding-left: 28px; position: relative; font-size: 1.05rem; color: #f1f5f9; }
                ul.feature-list li::before { content: "✔"; position: absolute; left: 0; color: var(--accent); font-weight: bold; }

                /* Call to Action Box */
                .cta-box { background: #1e293b; border: 1px solid #0284c7; padding: 25px; border-radius: 10px; margin-top: 35px; text-align: center; }
                .cta-box p { font-size: 1.1rem; margin-top: 0; color: #f8fafc; }
                .cta-btn { display: inline-block; background: var(--primary); color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 1.05rem; transition: background 0.2s; }
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
                    <img src="/logo.png" alt="Tencent Innovations" class="logo-img" onerror="this.style.display='none'">
                    <div class="logo-text-group">
                        <span class="logo-text">Tencent Innovations</span>
                        <span class="logo-tagline">Connecting You, Faster.</span>
                    </div>
                </a>
                <ul class="nav-links">
                    <li><a href="/" class="\${activeNav === 'home' ? 'active' : ''}">Home</a></li>
                    <li><a href="/wifi" class="\${activeNav === 'wifi' ? 'active' : ''}">WiFi</a></li>
                    <li><a href="/cctv" class="\${activeNav === 'cctv' ? 'active' : ''}">CCTV</a></li>
                    <li><a href="/smart-locks" class="\${activeNav === 'smart-locks' ? 'active' : ''}">Smart Locks</a></li>
                    <li><a href="/electric-fence" class="\${activeNav === 'electric-fence' ? 'active' : ''}">Electric Fence</a></li>
                    <li><a href="/solar" class="\${activeNav === 'solar' ? 'active' : ''}">Solar</a></li>
                    <li><a href="/survey" class="\${activeNav === 'survey' ? 'active' : ''}">Surveys</a></li>
                </ul>
            </nav>

            \${content}

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

// 1. Home Page
app.get('/', (req, res) => {
    const content = `
        <div class="hero-banner">
            <h1>Internet, security and power for your home or business.</h1>
            <p>Tencent Innovations designs, installs and maintains WiFi, CCTV, smart locks, electric fences and solar systems. We start with a survey, so you only pay for what your site needs.</p>
            <div class="ussd-badge">📱 Dial *384*100# on your phone to book</div>
        </div>
        <div class="container">
            <div class="content-section">
                <p class="intro-text">Most problems with networks, cameras and power start with a poor plan, not poor equipment. We are engineers, so we plan first, install properly and stay around to support what we build.</p>
                
                <h3 style="color: #38bdf8;">What we do</h3>
                <ul class="feature-list">
                    <li><strong>WiFi:</strong> Hotspot and home internet that stays up and stays fast.</li>
                    <li><strong>CCTV:</strong> Cameras you can watch from your phone.</li>
                    <li><strong>Smart locks:</strong> Entry without keys to copy, lose or hand over.</li>
                    <li><strong>Electric fence:</strong> A boundary that deters intruders before they reach your door.</li>
                    <li><strong>Solar:</strong> Power that keeps your lights, router and cameras on when the grid is off.</li>
                    <li><strong>Surveys:</strong> A site visit and a written plan before any work begins.</li>
                </ul>

                <h3 style="color: #38bdf8; margin-top: 30px;">Why choose us</h3>
                <ul class="feature-list">
                    <li>Engineer-led design and installation, not guesswork.</li>
                    <li>A clear quote after the survey, with no surprise add-ons.</li>
                    <li>Local support after installation.</li>
                    <li>One team for all your systems, so your WiFi, cameras and power work together.</li>
                </ul>

                <div class="cta-box">
                    <p>Not sure where to start? Book a consultation. Pay by M-Pesa on the website or dial *384*100#, and an engineer will call you to agree a time.</p>
                    <a href="/survey" class="cta-btn">Book a consultation</a>
                </div>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'Home', activeNav: 'home', content }));
});

// 2. WiFi Page
app.get('/wifi', (req, res) => {
    const content = `
        <div class="container">
            <div class="content-section">
                <h2>Reliable WiFi for homes, rentals and businesses.</h2>
                <p style="color: var(--muted); font-size: 1.15rem; margin-top: -10px;">Pay-as-you-go hotspot or a fixed monthly connection. We build the network, run the billing and keep it online.</p>
                
                <p class="intro-text">A good connection depends on the whole chain: the link to the mast, the router, the access points and how many people share them. We design all of it together, so the signal reaches every room and holds up when more people connect.</p>

                <h3 style="color: #38bdf8;">Two ways to get connected</h3>
                <ul class="feature-list">
                    <li><strong>Hotspot:</strong> Buy a time or data bundle with M-Pesa and connect from any phone or laptop. Good for rental plots, shops, cafes and public spaces.</li>
                    <li><strong>Monthly home or office plan:</strong> A dedicated connection with its own private WiFi name and password, billed monthly. Good for homes, schools and offices that need a steady line.</li>
                </ul>

                <h3 style="color: #38bdf8;">What is included</h3>
                <ul class="feature-list">
                    <li>Site survey and signal test before we install</li>
                    <li>Outdoor and indoor access points, positioned for coverage</li>
                    <li>Router configuration with a captive login page, user limits and M-Pesa payments</li>
                    <li>Private WiFi and hotspot on the same equipment when you need both</li>
                    <li>Support when something drops</li>
                </ul>

                <h3 style="color: #38bdf8;">For business owners</h3>
                <p>Running a hotspot business? We can set up the network, billing and login system for you, and show you how to manage customers yourself.</p>

                <div class="cta-box">
                    <p>Tell us where you are and what you need. We will visit, test the signal and give you a clear quote.</p>
                    <a href="tel:*384*100#" class="cta-btn">Book a WiFi consultation</a>
                </div>
            </div>
        </div>
    `;
    res.send(renderPage({ title: 'WiFi & Networking', activeNav: 'wifi', content }));
});

// 3. CCTV Page
app.get('/cctv', (req, res) => {
    const content = `
        <div class="container">
            <div class="content-section">
                <h2>See your property from anywhere.</h2>
                <p style="color: var(--muted); font-size: 1.15rem; margin-top: -10px;">CCTV systems for homes, shops, schools and compounds, installed and set up to view live on your phone.</p>
                
                <p class="intro-text">A camera is only useful if it points at the right place, records clearly at night and keeps working when the power goes. We plan the camera positions on site, install the system neatly and show you how to use it.</p>

                <h3 style="color: #38bdf8;">What you get</h3>
                <ul class="feature-list">
                    <li>Cameras chosen for the spot: entrances, gates, parking, counters, perimeters</li>
                    <li>Clear day and night recording</li>
                    <li>Live viewing and playback on your phone</li>
                    <li>Recording to a hard drive, with enough storage for the number of days you need</li>
                    <li>Tidy, protected cabling and weatherproof fittings outdoors</li>
                    <li>Backup power so recording continues during outages</li>
                </ul>

                <h3 style="color: #38bdf8;">How it works</h3>
                <ol style="color: #f1f5f9; padding-left: 20px; line-height: 1.8;">
                    <li>We visit and walk the site with you.</li>
                    <li>You receive a camera layout and a written quote.</li>
                    <li>We install, test every camera and set up your phone.</li>
                    <li>We show you how to find and save footage.</li>
                </ol>

                <h3 style="color: #38bdf8;">Good to know</h3>
                <ul class="feature-list">
                    <li>Cameras work best when they are placed for a purpose. We will tell you if you need fewer than you expected, or more.</li>
                    <li>Already have cameras? We can inspect them, fix faults and add remote viewing.</li>
                </ul>

                <div class="cta-box">
                    <p>Book
