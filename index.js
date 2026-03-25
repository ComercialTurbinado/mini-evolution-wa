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

const STARTUP_WAIT_MS = Math.max(0, parseInt(process.env.STARTUP_WAIT_MS || '0', 10) || 0);
const CHROME_RECONNECT_MS = Math.max(3000, parseInt(process.env.CHROME_RECONNECT_MS || '15000', 10) || 15000);
const MESSAGE_DEDUP_TTL_MS = Math.max(
    1000,
    parseInt(process.env.MESSAGE_DEDUP_TTL_MS || '300000', 10) || 300000
); // 5 min padrão
const MAX_RECENT_MESSAGES = Math.max(1000, parseInt(process.env.MAX_RECENT_MESSAGES || '10000', 10) || 10000);
const DEBUG_LOG_MESSAGES = ['1', 'true', 'yes'].includes(String(process.env.DEBUG_LOG_MESSAGES || '').toLowerCase());
const FORWARD_EMPTY_BODY = ['1', 'true', 'yes'].includes(String(process.env.FORWARD_EMPTY_BODY || '').toLowerCase());

// Deduplicação em memória (evita disparos repetidos do mesmo messageId)
const recentMessages = new Map(); // messageKey -> lastSeenAtMs

function getMessageKey(msg) {
    // whatsapp-web.js Message.id geralmente tem _serialized
    const key = msg?.id?._serialized;
    if (typeof key === 'string' && key.length > 0) return key;
    // fallback
    const rawId = msg?.id;
    try {
        return rawId ? JSON.stringify(rawId) : undefined;
    } catch (_) {
        return undefined;
    }
}

function isDuplicateAndMark(messageKey) {
    const now = Date.now();
    const prev = recentMessages.get(messageKey);
    if (prev && now - prev < MESSAGE_DEDUP_TTL_MS) return true;
    recentMessages.set(messageKey, now);

    if (recentMessages.size > MAX_RECENT_MESSAGES) {
        // poda simples baseada no TTL
        for (const [k, t] of recentMessages.entries()) {
            if (now - t >= MESSAGE_DEDUP_TTL_MS) recentMessages.delete(k);
        }
    }
    return false;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function explainInitError(err) {
    const msg = err?.message || String(err);
    console.error('❌ Falha ao inicializar o cliente:', msg);
    if (/ECONNREFUSED/i.test(msg)) {
        console.error(`→ ECONNREFUSED: ninguém está aceitando TCP no endereço de CHROME_URL.
  • Garanta que o serviço do Chrome/Browserless (ex.: chrome-wa) está **rodando** e **healthy**.
  • No Easypanel, coloque este app e o Chrome na **mesma rede** interna (alias DNS tipo chrome-wa).
  • Confira a **porta**: muitas imagens Browserless expõem WebSocket na **3000**; Chrome “cru” (CDP) costuma ser **9222**.
  • Se o Chrome sobe mais devagar, use STARTUP_WAIT_MS=30000 (milissegundos antes da 1ª tentativa).`);
    }
}

console.log('Iniciando conexão com o Chrome em:', process.env.CHROME_URL);
if (STARTUP_WAIT_MS) {
    console.log(`⏳ STARTUP_WAIT_MS=${STARTUP_WAIT_MS} — aguardando antes do 1º connect...`);
}

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
let pendingStartupWait = STARTUP_WAIT_MS > 0;

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
            scheduleReconnect(Math.min(8000, CHROME_RECONNECT_MS));
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

function scheduleReconnect(delayMs = CHROME_RECONNECT_MS) {
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
        if (pendingStartupWait) {
            pendingStartupWait = false;
            await sleep(STARTUP_WAIT_MS);
        }
        await client.initialize();
        bindPuppeteerGuardsOnce();
    } catch (err) {
        explainInitError(err);
        scheduleReconnect(CHROME_RECONNECT_MS);
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
    scheduleReconnect(Math.min(10000, CHROME_RECONNECT_MS));
});

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;
    // Evita loop caso o n8n envie mensagens de volta por esta mesma sessão.
    if (msg.fromMe) return;

    const messageKey = getMessageKey(msg);
    if (messageKey && isDuplicateAndMark(messageKey)) {
        if (DEBUG_LOG_MESSAGES) console.log(`⏭️ Duplicado ignorado: ${messageKey}`);
        return;
    }

    if (!FORWARD_EMPTY_BODY && (!msg.body || String(msg.body).trim().length === 0)) {
        if (DEBUG_LOG_MESSAGES) console.log(`⏭️ Corpo vazio ignorado. id=${messageKey}`);
        return;
    }

    try {
        const bodyPreview = msg.body ? String(msg.body).slice(0, 120) : '';
        console.log(`↪ Mensagem de ${msg.from} (type=${msg.type}) id=${messageKey || 'n/a'}: ${bodyPreview}`);
        await axios.post(process.env.N8N_WEBHOOK_URL, {
            event: 'message.upsert',
            from: msg.from,
            body: msg.body,
            name: msg._data?.notifyName || 'Contato',
            timestamp: msg.timestamp,
            messageId: messageKey,
            messageType: msg.type
        });
    } catch (err) {
        console.error('❌ Erro ao enviar para o n8n:', err.message);
    }
});

start();
