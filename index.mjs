// Puente WhatsApp por código QR (dispositivo vinculado) para CoraSys.
// Solo transporta mensajes: toda la lógica (precios, stock, cotizaciones) vive en CoraSys.
import http from "node:http";
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from "baileys";
import QRCode from "qrcode";
import pino from "pino";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY;
const WEBHOOK = process.env.CORASYS_WEBHOOK_URL; // https://corasys.lovable.app/api/public/whatsapp-qr
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";
if (!API_KEY || !WEBHOOK) { console.error("Faltan API_KEY o CORASYS_WEBHOOK_URL"); process.exit(1); }

const log = pino({ level: "warn" });
// libsignal imprime sesiones completas (llaves privadas) con console.*: se filtran y solo se cuentan.
const SIGNAL_NOISE = /^(Closing session|Closing open session|Session error|Failed to decrypt|Removing old closed session|Decrypted message with closed session|Migrating session)/;
for (const k of ["log", "info", "warn", "error"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    const first = a[0];
    if ((typeof first === "string" && SIGNAL_NOISE.test(first)) || (first && typeof first === "object" && first.constructor?.name === "SessionEntry")) { signalStats.noise++; return; }
    orig(...a);
  };
}
const signalStats = { noise: 0 };
let connSeq = 0;
let sock = null;
let state = "CONECTANDO";
let qrDataUrl = null;
let myPhone = null;
const sentByBot = new Set(); // IDs enviados por el bot: no deben activar la pausa humana
// Caché de mensajes enviados: WhatsApp pide reenviarlos cuando otro dispositivo no puede descifrarlos
// ("Esperando el mensaje"). Sin esto, el mensaje queda atascado para siempre.
const msgStore = new Map();
const MAX_STORE = 2000;
const STORE_FILE = (process.env.AUTH_DIR || "/data/auth") + "/../msgstore.json";
try { for (const [k, v] of JSON.parse(fs.readFileSync(STORE_FILE, "utf8"))) msgStore.set(k, v); } catch {}
let saveTimer = null;
function remember(id, message) {
  if (!id || !message) return;
  msgStore.set(id, message);
  if (msgStore.size > MAX_STORE) msgStore.delete(msgStore.keys().next().value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(STORE_FILE, JSON.stringify([...msgStore])); } catch {} }, 1000);
}
const retryCounts = new Map();
const msgRetryCounterCache = {
  get: (k) => retryCounts.get(k),
  set: (k, v) => { retryCounts.set(k, v); if (retryCounts.size > 5000) retryCounts.delete(retryCounts.keys().next().value); },
  del: (k) => retryCounts.delete(k),
  flushAll: () => retryCounts.clear(),
};

// Chat real de cada cliente (@lid o número): se responde siempre al mismo para no romper el cifrado.
const CHATS_FILE = (process.env.AUTH_DIR || "/data/auth") + "/../chats.json";
const chatOf = new Map();
try { for (const [k, v] of JSON.parse(fs.readFileSync(CHATS_FILE, "utf8"))) chatOf.set(k, v); } catch {}
let chatsTimer = null;
function rememberChat(phone, jid) {
  if (!phone || !jid || chatOf.get(phone) === jid) return;
  chatOf.set(phone, jid);
  clearTimeout(chatsTimer);
  chatsTimer = setTimeout(() => { try { fs.writeFileSync(CHATS_FILE, JSON.stringify([...chatOf])); } catch (e) { console.error("No se pudo guardar chats:", e.message); } }, 500);
}
// Envíos en fila por chat: nunca dos cifrados simultáneos al mismo cliente.
const sendQueues = new Map();
function enqueue(jid, fn) {
  const prev = sendQueues.get(jid) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  sendQueues.set(jid, next);
  next.finally(() => { if (sendQueues.get(jid) === next) sendQueues.delete(jid); }).catch(() => {});
  return next;
}

const digits = (s) => String(s || "").replace(/\D/g, "");
/** Número real del chat (WhatsApp nuevo puede usar identificadores @lid). */
function phoneOf(key) {
  const jid = key.remoteJid || "";
  if (jid.endsWith("@s.whatsapp.net")) return digits(jid.split("@")[0]);
  const alt = key.remoteJidAlt || key.senderPn || key.participantAlt || key.participantPn || "";
  return alt ? digits(alt.split("@")[0]) : null;
}

async function forward(payload) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(WEBHOOK, { method: "POST", headers: { "x-api-key": API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (r.ok || (r.status >= 400 && r.status < 500)) return;
    } catch (e) { log.warn(e); }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // reintento con backoff
  }
  console.error("No se pudo entregar el mensaje", payload.id);
}

function clearAuthDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      try { fs.rmSync(dir + "/" + f, { recursive: true, force: true }); } catch (e) { console.error("No se pudo borrar", f, e.message); }
    }
  } catch (e) { console.error("Error limpiando credenciales:", e.message); }
}

let starting = false;
async function start() {
  if (starting) return;
  starting = true;
  try {
    if (sock) { try { sock.ev.removeAllListeners(); sock.end(undefined); } catch {} sock = null; }
    await connect();
  } finally { starting = false; }
}
let reconnectTimer = null;
function scheduleReconnect(ms) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(start, ms); }

async function connect() {
  const conn = ++connSeq;
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({ auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, log) }, version, logger: log, browser: Browsers.ubuntu("Chrome"), markOnlineOnConnect: true, syncFullHistory: false,
    msgRetryCounterCache,
    getMessage: async (key) => msgStore.get(key.id) || undefined,
  });
  const current = sock;
  sock.ev.on("creds.update", async () => { try { await saveCreds(); } catch (e) { console.error(`[c${conn}] No se pudieron guardar credenciales:`, e.message); } });
  sock.ev.on("connection.update", async (u) => {
    if (u.qr) { state = "ESPERANDO_QR"; qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }); }
    if (u.connection === "open") { state = "CONECTADO"; qrDataUrl = null; myPhone = digits(sock.user?.id?.split(":")[0]); console.log(`[c${conn}] Conectado`, myPhone); }
    if (u.connection === "close") {
      if (current !== sock) return; // conexión vieja: ignorar
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { state = "DESCONECTADO"; clearAuthDir(AUTH_DIR); }
      else state = "CONECTANDO";
      console.log(`[c${conn}] Conexión cerrada (código ${code}); reconectando`);
      scheduleReconnect(3000);
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) {
      const id = m.key.id;
      if (m.message) remember(id, m.message);
      const jid = m.key.remoteJid || "";
      if (!m.message || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
      if (m.key.fromMe && sentByBot.has(id)) { sentByBot.delete(id); continue; }
      const from = phoneOf(m.key);
      if (!from) continue;
      rememberChat(from, jid);
      const msg = m.message.ephemeralMessage?.message || m.message;
      const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.documentMessage?.caption || undefined;
      const payload = { id, from, fromMe: !!m.key.fromMe, type: "other", text };
      if (msg.conversation || msg.extendedTextMessage) payload.type = "text";
      else if (msg.locationMessage) {
        const l = msg.locationMessage;
        payload.type = "location";
        payload.location = { latitude: l.degreesLatitude, longitude: l.degreesLongitude, name: l.name || undefined, address: l.address || undefined };
      } else if ((msg.imageMessage || msg.documentMessage) && !m.key.fromMe) {
        payload.type = msg.imageMessage ? "image" : "document";
        try {
          const buf = await downloadMediaMessage(m, "buffer", {});
          if (buf.length <= 10 * 1024 * 1024) payload.media = { base64: buf.toString("base64"), mime: (msg.imageMessage || msg.documentMessage).mimetype || "image/jpeg" };
        } catch (e) { log.warn(e); }
      }
      if (!m.key.fromMe) await sock.readMessages([m.key]).catch(() => {});
      forward(payload);
    }
  });
}

function json(res, code, body) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((ok, ko) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on("end", () => ok(b)); req.on("error", ko); }); }

http.createServer(async (req, res) => {
  if (req.url === "/health") return json(res, 200, { ok: true });
  if (req.headers["x-api-key"] !== API_KEY) return json(res, 401, { error: "unauthorized" });
  try {
    if (req.method === "GET" && req.url === "/status") return json(res, 200, { state, phone: myPhone, qr: qrDataUrl, conexion: connSeq, erroresCifrado: signalStats.noise });
    if (req.method === "POST" && req.url === "/send") {
      const { to, text } = JSON.parse(await readBody(req));
      if (state !== "CONECTADO") return json(res, 503, { error: "WhatsApp no conectado" });
      const jid = chatOf.get(digits(to)) || `${digits(to)}@s.whatsapp.net`;
      await enqueue(jid, async () => {
        await sock.sendPresenceUpdate("composing", jid).catch(() => {});
        await new Promise((r) => setTimeout(r, Math.min(3000, 800 + String(text).length * 15))); // tipeo natural
        const sent = await sock.sendMessage(jid, { text: String(text).slice(0, 4000) });
        if (sent?.key?.id) { sentByBot.add(sent.key.id); remember(sent.key.id, sent.message); }
        console.log(`[c${connSeq}] Enviado a ${jid.endsWith("@lid") ? "lid" : "número"} id=${sent?.key?.id}`);
        await sock.sendPresenceUpdate("paused", jid).catch(() => {});
      });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/logout") { await sock?.logout().catch(() => {}); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && req.url === "/restart") { scheduleReconnect(100); return json(res, 200, { ok: true }); }
    json(res, 404, { error: "not found" });
  } catch (e) { console.error(e); json(res, 500, { error: "error" }); }
}).listen(PORT, () => console.log("Puente QR en puerto", PORT));

start();
