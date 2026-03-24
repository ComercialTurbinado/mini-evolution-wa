// Handlers globais primeiro — antes de qualquer async da lib
process.on('unhandledRejection', (reason) => {
    const detail =
        reason instanceof Error
            ? reason.stack || reason.message
            : reason && typeof reason === 'object' && 'message' in reason
                ? reason.message
                : String(reason);
    console.error('⚠️ Erro não tratado (promise):', detail);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ Exceção não capturada:', err?.stack || err);
});

const { Client } = require('whatsapp-web.js');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

console.log('Iniciando conexão com o Chrome em:', process.env.CHROME_URL);

if (!process.env.CHROME_URL) {
    console.error('❌ Defina a variável CHROME_URL (browserWSEndpoint do Browseless).');
    process.exit(1);
}

const client = new Client({
    puppeteer: {
        browserWSEndpoint: process.env.CHROME_URL,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-extensions',
            '--disable-dev-shm-usage'
        ]
    }
});

let pupGuardsBound = false;
let reconnectBusy = false;
let reconnectTimer = null;

function bindPuppeteerGuardsOnce() {
    if (pupGuardsBound || !client.pupPage) return;
    pupGuardsBound = true;

    client.pupPage.on('error', (err) => {
        console.error('⚠️ pupPage error:', err?.message || err);
    });
    client.pupPage.on('pageerror', (err) => {
        console.error('⚠️ pupPage pageerror:', err?.message || err);
    });

    if (client.pupBrowser) {
        client.pupBrowser.on('disconnected', () => {
            console.error('⚠️ Puppeteer: sessão com o Chrome remoto encerrada');
            scheduleReconnect(8000);
        });
    }
}

async function destroyQuietly() {
    pupGuardsBound = false;
    try {
        await client.destroy();
    } catch (_) {
        /* ignore */
    }
}

function scheduleReconnect(delayMs = 15000) {
    if (reconnectTimer) return;
    console.log(`↻ Nova tentativa em ${Math.round(delayMs / 1000)}s...`);
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (reconnectBusy) return;
        reconnectBusy = true;
        try {
            await destroyQuietly();
            await start();
        } finally {
            reconnectBusy = false;
        }
    }, delayMs);
}

async function start() {
    try {
        await client.initialize();
        bindPuppeteerGuardsOnce();
    } catch (err) {
        console.error('❌ Falha ao inicializar o cliente:', err?.message || err);
        scheduleReconnect(15000);
    }
}

client.on('qr', (qr) => {
    bindPuppeteerGuardsOnce();
    console.log('--- ESCANEIE O QR CODE ABAIXO ---');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    bindPuppeteerGuardsOnce();
});

client.on('ready', () => {
    bindPuppeteerGuardsOnce();
    console.log('✅ WhatsApp Conectado!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Falha na autenticação:', msg);
});

client.on('disconnected', (reason) => {
    console.error('❌ WhatsApp desconectado:', reason);
    scheduleReconnect(10000);
});

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;

    try {
        console.log(`Mensagem de ${msg.from}: ${msg.body}`);
        await axios.post(process.env.N8N_WEBHOOK_URL, {
            event: 'message.upsert',
            from: msg.from,
            body: msg.body,
            name: msg._data.notifyName || 'Contato',
            timestamp: msg.timestamp
        });
    } catch (err) {
        console.error('❌ Erro ao enviar para o n8n:', err.message);
    }
});

start();
