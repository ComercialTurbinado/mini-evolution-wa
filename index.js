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

const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const http = require('http');

const STARTUP_WAIT_MS = Math.max(0, parseInt(process.env.STARTUP_WAIT_MS || '0', 10) || 0);
const CHROME_RECONNECT_MS = Math.max(3000, parseInt(process.env.CHROME_RECONNECT_MS || '15000', 10) || 15000);
const CHROME_RECONNECT_MAX_MS = Math.max(
    CHROME_RECONNECT_MS,
    parseInt(process.env.CHROME_RECONNECT_MAX_MS || '60000', 10) || 60000
);
const WWEB_AUTH_DATA_PATH = process.env.WWEB_AUTH_DATA_PATH || '/app/.wwebjs_auth';
const ENABLE_MEDIA_FORWARDING = !['0', 'false', 'no'].includes(
    String(process.env.ENABLE_MEDIA_FORWARDING || 'true').toLowerCase()
);
const MAX_MEDIA_BASE64_CHARS = Math.max(
    10000,
    parseInt(process.env.MAX_MEDIA_BASE64_CHARS || '6000000', 10) || 6000000
); // ~6MB base64 (JSON grande). Ajuste se necessário.
const MESSAGE_DEDUP_TTL_MS = Math.max(
    1000,
    parseInt(process.env.MESSAGE_DEDUP_TTL_MS || '300000', 10) || 300000
); // 5 min padrão
const MAX_RECENT_MESSAGES = Math.max(1000, parseInt(process.env.MAX_RECENT_MESSAGES || '10000', 10) || 10000);
const DEBUG_LOG_MESSAGES = ['1', 'true', 'yes'].includes(String(process.env.DEBUG_LOG_MESSAGES || '').toLowerCase());
const FORWARD_EMPTY_BODY = ['1', 'true', 'yes'].includes(String(process.env.FORWARD_EMPTY_BODY || '').toLowerCase());

// Deduplicação em memória (evita disparos repetidos do mesmo messageId)
const recentMessages = new Map(); // messageKey -> lastSeenAtMs
const recentContentMessages = new Map(); // contentKey -> lastSeenAtMs

const CONTENT_DEDUP_TTL_MS = Math.max(1000, parseInt(process.env.CONTENT_DEDUP_TTL_MS || '15000', 10) || 15000); // 15s por conteúdo
const MAX_RECENT_CONTENT_KEYS = Math.max(1000, parseInt(process.env.MAX_RECENT_CONTENT_KEYS || '5000', 10) || 5000);
const TS_BUCKET_SECONDS = Math.max(1, parseInt(process.env.TS_BUCKET_SECONDS || '10', 10) || 10);

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

function getContentKey(msg) {
    const from = msg?.from || '';
    const type = msg?.type || '';
    const tsNum = typeof msg?.timestamp === 'number' ? msg.timestamp : parseInt(String(msg?.timestamp || ''), 10);
    const tsBucket = Number.isFinite(tsNum) ? Math.floor(tsNum / TS_BUCKET_SECONDS) : '';
    const body = msg?.body ? String(msg.body).trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    // O timestamp do WA pode variar entre eventos repetidos; "bucket" estabiliza a chave em rajadas.
    return `${from}|${type}|${tsBucket}|${body}`;
}

function isDuplicateContentAndMark(contentKey) {
    const now = Date.now();
    const prev = recentContentMessages.get(contentKey);
    if (prev && now - prev < CONTENT_DEDUP_TTL_MS) return true;
    recentContentMessages.set(contentKey, now);

    if (recentContentMessages.size > MAX_RECENT_CONTENT_KEYS) {
        for (const [k, t] of recentContentMessages.entries()) {
            if (now - t >= CONTENT_DEDUP_TTL_MS) recentContentMessages.delete(k);
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

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
if (!N8N_WEBHOOK_URL) {
    console.error('❌ Defina a variável N8N_WEBHOOK_URL (URL completa do Webhook no n8n).');
}

if (!process.env.CHROME_URL) {
    console.error('❌ Defina a variável CHROME_URL (browserWSEndpoint do Browseless).');
    process.exit(1);
}

const client = new Client({
    // Persistir sessão evita precisar reconectar (QR) a cada reinício do container.
    authStrategy: new LocalAuth({ dataPath: WWEB_AUTH_DATA_PATH }),
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
let healthServer = null;
let healthServers = [];
let reconnectAttempt = 0;

function startHealthServer() {
    if (String(process.env.DISABLE_HEALTH_SERVER || '').toLowerCase() === 'true') return;
    const ports = new Set();
    const envPort = parseInt(process.env.PORT || '', 10);
    ports.add(Number.isFinite(envPort) ? envPort : 3000);
    ports.add(3000);
    ports.add(8080);

    const handler = (req, res) => {
        if (req.url === '/' || req.url === '/health' || req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, service: 'mini-evolution-wa' }));
            return;
        }
        res.writeHead(404);
        res.end();
    };

    for (const port of ports) {
        try {
            const srv = http.createServer(handler);
            srv.listen(port, '0.0.0.0', () => {
                console.log(`🌐 Health server listening on :${port}`);
            });
            healthServers.push(srv);
        } catch (_) {
            // Ignora falhas ao bind (porta em uso etc.)
        }
    }
}

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

process.on('SIGTERM', async () => {
    console.error('↯ SIGTERM recebido. Encerrando com segurança...');
    try {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        for (const srv of healthServers) {
            try {
                srv.close();
            } catch (_) {
                /* ignore */
            }
        }
    } catch (_) {
        /* ignore */
    }
    try {
        await destroyQuietly();
    } catch (_) {
        /* ignore */
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.error('↯ SIGINT recebido. Encerrando com segurança...');
    try {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        for (const srv of healthServers) {
            try {
                srv.close();
            } catch (_) {
                /* ignore */
            }
        }
    } catch (_) {
        /* ignore */
    }
    try {
        await destroyQuietly();
    } catch (_) {
        /* ignore */
    }
    process.exit(0);
});

function scheduleReconnect(delayMs = CHROME_RECONNECT_MS) {
    if (reconnectTimer) return;
    reconnectAttempt += 1;
    const jitter = Math.round(delayMs * 0.2 * Math.random());
    const expBackoff = delayMs * Math.pow(2, reconnectAttempt - 1);
    const finalDelay = Math.min(CHROME_RECONNECT_MAX_MS, expBackoff + jitter);
    console.log(
        `↻ Reconnect scheduled (attempt=${reconnectAttempt}) em ${Math.round(finalDelay / 1000)}s...`
    );
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
    }, finalDelay);
}

async function start() {
    try {
        if (pendingStartupWait) {
            pendingStartupWait = false;
            await sleep(STARTUP_WAIT_MS);
        }
        await client.initialize();
        // Se inicializou, zera tentativas: a conexão está indo pra "ok".
        reconnectAttempt = 0;
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
    reconnectAttempt = 0;
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

    const contentKey = getContentKey(msg);
    if (contentKey && isDuplicateContentAndMark(contentKey)) {
        if (DEBUG_LOG_MESSAGES) console.log(`⏭️ Duplicado por conteúdo ignorado: ${contentKey}`);
        return;
    }

    if (!FORWARD_EMPTY_BODY && !msg.hasMedia && (!msg.body || String(msg.body).trim().length === 0)) {
        if (DEBUG_LOG_MESSAGES) console.log(`⏭️ Corpo vazio ignorado. id=${messageKey}`);
        return;
    }

    try {
        const bodyPreview = msg.body ? String(msg.body).slice(0, 120) : '';
        console.log(`↪ Mensagem de ${msg.from} (type=${msg.type}) id=${messageKey || 'n/a'}: ${bodyPreview}`);

        let media = null;
        if (ENABLE_MEDIA_FORWARDING && msg.hasMedia) {
            try {
                const downloaded = await msg.downloadMedia();
                const dataLen = downloaded?.data ? String(downloaded.data).length : 0;
                if (dataLen > MAX_MEDIA_BASE64_CHARS) {
                    console.error(
                        `⚠️ Mídia grande demais para enviar (base64 chars=${dataLen}). Ajuste MAX_MEDIA_BASE64_CHARS se quiser.`
                    );
                } else {
                    media = {
                        mimetype: downloaded?.mimetype,
                        filename: downloaded?.filename,
                        data: downloaded?.data
                    };
                }
            } catch (e) {
                console.error('⚠️ Falha ao baixar mídia do WhatsApp:', e?.message || e);
            }
        }

        await axios.post(N8N_WEBHOOK_URL, {
            event: 'message.upsert',
            from: msg.from,
            body: msg.body,
            name: msg._data?.notifyName || 'Contato',
            timestamp: msg.timestamp,
            messageId: messageKey,
            messageType: msg.type,
            hasMedia: Boolean(msg.hasMedia),
            media
        });
    } catch (err) {
        const status = err?.response?.status;
        const respData = err?.response?.data;
        const respText = typeof respData === 'string' ? respData : JSON.stringify(respData || {});
        const respPreview = respText.slice(0, 400);
        console.error(
            '❌ Erro ao enviar para o n8n:',
            `status=${status || 'n/a'}`,
            `url=${N8N_WEBHOOK_URL}`,
            'msg=',
            err?.message || String(err),
            respPreview ? `resp=${respPreview}` : ''
        );
    }
});

startHealthServer();
start();
