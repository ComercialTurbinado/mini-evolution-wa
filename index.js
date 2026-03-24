const { Client } = require('whatsapp-web.js');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const client = new Client({
    puppeteer: {
        browserWSEndpoint: process.env.CHROME_URL, // URL do Browseless
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Exibe o QR Code no log do Easypanel para você escanear
client.on('qr', (qr) => {
    console.log('--- ESCANEIE O QR CODE ABAIXO ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Conectado!');
});

// Envia para o n8n
client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return; // Ignora status

    try {
        console.log(`Mensagem de ${msg.from}: ${msg.body}`);
        await axios.post(process.env.N8N_WEBHOOK_URL, {
            event: "message.upsert",
            from: msg.from,
            body: msg.body,
            name: msg._data.notifyName || 'Contato',
            timestamp: msg.timestamp
        });
    } catch (err) {
        console.error('❌ Erro ao enviar para o n8n:', err.message);
    }
});

client.initialize();
