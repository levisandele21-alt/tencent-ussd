const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Customer Website Homepage Route
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Tencent Innovations - Professional Consultation</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background: #0f172a; color: #f8fafc; text-align: center; }
                .container { max-width: 600px; margin: 40px auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
                h1 { color: #38bdf8; margin-bottom: 5px; }
                p.tagline { color: #94a3b8; font-size: 1.1rem; }
                .ussd-banner { background: #0284c7; padding: 15px; border-radius: 8px; font-size: 1.25rem; font-weight: bold; margin: 25px 0; color: #ffffff; }
                .services { text-align: left; background: #0f172a; padding: 20px; border-radius: 8px; margin-top: 20px; }
                .service-item { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #334155; }
                .service-item:last-child { border-bottom: none; }
                .price { color: #4ade80; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Tencent Innovations</h1>
                <p class="tagline">Tech, Solar & Business Advisory Services</p>
                
                <div class="ussd-banner">
                    Dial *384*100# on your Phone
                </div>

                <h3>Available Consultations</h3>
                <div class="services">
                    <div class="service-item"><span>1. Tech & Software</span> <span class="price">KES 2,500</span></div>
                    <div class="service-item"><span>2. Solar & Energy</span> <span class="price">KES 1,800</span></div>
                    <div class="service-item"><span>3. Business Strategy</span> <span class="price">KES 3,500</span></div>
                    <div class="service-item"><span>4. Financial Consulting</span> <span class="price">KES 2,000</span></div>
                </div>
            </div>
        </body>
        </html>
    `);
});

// 2. USSD Callback Endpoint
app.post('/ussd', (req, res) => {
    const { text, phoneNumber } = req.body;
    let response = '';

    if (text === '') {
        response = `CON Welcome to Tencent Innovations
1. Tech & Software Architecture
2. Solar & Energy Solutions
3. Business Strategy
4. Financial Consulting`;
    } else if (text === '1') {
        response = `CON Tech Consultation: KES 2,500
1. Confirm & Pay via M-PESA`;
    } else if (text === '2') {
        response = `CON Solar Consultation: KES 1,800
1. Confirm & Pay via M-PESA`;
    } else if (text === '3') {
        response = `CON Business Advisory: KES 3,500
1. Confirm & Pay via M-PESA`;
    } else if (text === '4') {
        response = `CON Financial Advisory: KES 2,000
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
app.listen(PORT, () => console.log(`Tencent Innovations App running on port ${PORT}`));