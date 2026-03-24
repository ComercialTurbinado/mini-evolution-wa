const { Client } = require('whatsapp-web.js');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

console.log('Iniciando conexão com o Chrome em:', process.env.CHROME_URL);

const client = new Client({
    puppeteer: {
        browserWSEndpoint: process.env.CHROME_URL,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-extensions',
            '--disable-dev-shm-usage' // Importante para containers
        ]
    }
});

// Tratamento de erro global para evitar que o app feche
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Erro não tratado:', reason);
});

client.on('qr', (qr) => {
    console.log('--- ESCANEIE O QR CODE ABAIXO ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Conectado!');
});

client.on('auth_failure', msg => {
    console.error('❌ Falha na autenticação:', msg);
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

client.initialize().catch(err => {
    console.error('❌ Falha ao inicializar o cliente:', err);
});
