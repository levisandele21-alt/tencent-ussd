const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// USSD Callback Endpoint
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tencent USSD running on port ${PORT}`));
