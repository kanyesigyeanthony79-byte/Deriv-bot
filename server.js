"use strict";
// Serves the app and relays signal alerts to Telegram. The bot token exists only in this process's environment.
// This server has no trading code and no Deriv credentials.
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path"), crypto = require("crypto");
try { fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }); } catch (e) {}
const TOKEN = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID, PASS = process.env.RELAY_PASSCODE, PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const MIME = {".html":"text/html; charset=utf-8", ".js":"text/javascript", ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png"};

const tg = (method, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body || {});
  const r = https.request({hostname:"api.telegram.org", path:"/bot" + TOKEN + "/" + method, method:"POST", timeout:10000,
    headers:{"content-type":"application/json", "content-length":Buffer.byteLength(data)}}, res => {
    let b = ""; res.on("data", c => b += c);
    res.on("end", () => { try { const j = JSON.parse(b); j.ok ? resolve(j.result) : reject(new Error("Telegram HTTP " + res.statusCode)); } catch (e) { reject(new Error("Telegram bad response")); } });
  });
  r.on("timeout", () => r.destroy(new Error("Telegram timeout"))); r.on("error", e => reject(new Error(e.code || "network error"))); r.end(data);
});

if (process.argv.includes("--find-chat-id")) {
  if (!TOKEN) { console.error("Set TELEGRAM_BOT_TOKEN in .env first."); process.exit(1); }
  tg("getUpdates").then(u => {
    const seen = {}; u.forEach(x => { const c = (x.message || x.channel_post || {}).chat; if (c) seen[c.id] = c.title || c.username || c.first_name || ""; });
    console.log(Object.keys(seen).length ? seen : "No messages found. Send any message to your bot in Telegram, then run this again.");
  }).catch(e => console.error(e.message));
} else startServer();

function startServer() {
  const hits = [], fails = new Map(), sent = new Map();
  setInterval(() => { const n = Date.now(); sent.forEach((t, k) => { if (n - t > 864e5) sent.delete(k); }); }, 36e5).unref();
  const out = (res, code, obj) => { res.writeHead(code, {"content-type":"application/json", "cache-control":"no-store"}); res.end(JSON.stringify(obj)); };
  const eq = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
  const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);

  function format(b) { // the server builds the text itself; the browser cannot make it relay arbitrary messages
    if (b.type === "test") return "Deriv Signal Assistant: test message. Alerts are working. This app never places trades.";
    const ep = Number(b.candle), px = Number(b.close), sc = Math.round(Number(b.score)), sig = b.signal === "BUY" || b.signal === "SELL" ? b.signal : null;
    if (!sig || ![ep, px, sc].every(isFinite)) return null;
    const why = Array.isArray(b.reasons) ? b.reasons.slice(0, 10).map(x => "- " + clean(x, 90)).join("\n") : "";
    return sig + " signal: " + clean(b.market, 40) + " (" + clean(b.symbol, 20) + ")\n15m candle closed " + new Date((ep + 900) * 1000).toISOString().slice(11, 16) + " UTC at " + px + "\nHeuristic score " + sc + "/100 (not a win probability)\n" + why + "\nResearch alert only. No trade has been placed.";
  }

  async function notify(req, res) {
    const ip = req.socket.remoteAddress, f = fails.get(ip) || {n:0, t:Date.now()};
    if (Date.now() - f.t > 9e5) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) return out(res, 429, {error:"Too many wrong passcodes. Try again in 15 minutes."});
    if (!TOKEN || !CHAT || !PASS) return out(res, 503, {error:"Relay is not configured on the server."});
    if (!eq(req.headers["x-relay-passcode"] || "", PASS)) { f.n++; fails.set(ip, f); return out(res, 401, {error:"Wrong relay passcode."}); }
    let body = ""; for await (const c of req) { body += c; if (body.length > 4096) return out(res, 413, {error:"Payload too large."}); }
    let b; try { b = JSON.parse(body); } catch (e) { return out(res, 400, {error:"Bad JSON."}); }
    const text = format(b); if (!text) return out(res, 400, {error:"Invalid signal payload."});
    const key = b.type === "test" ? null : clean(b.market, 40) + ":" + Number(b.candle), now = Date.now();
    while (hits.length && now - hits[0] > 36e5) hits.shift();
    if (key && sent.has(key)) return out(res, 200, {ok:true, duplicate:true}); // one alert per market per candle
    if (hits.length >= 30) return out(res, 429, {error:"Hourly alert limit (30) reached."});
    try { await tg("sendMessage", {chat_id:CHAT, text, disable_web_page_preview:true}); hits.push(now); if (key) sent.set(key, now); out(res, 200, {ok:true}); }
    catch (e) { console.error("Telegram send failed:", e.message); out(res, 502, {error:"Telegram did not accept the message."}); }
  }

  http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://api.derivws.com; img-src 'self' data:; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/api/status" && req.method === "GET") return out(res, 200, {telegramConfigured:!!(TOKEN && CHAT && PASS)});
      if (url.pathname === "/api/notify" && req.method === "POST") {
        const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return out(res, 403, {error:"Cross-origin requests are not allowed."});
        return await notify(req, res);
      }
      if (req.method !== "GET") return out(res, 405, {error:"Method not allowed."});
      let p = decodeURIComponent(url.pathname); if (p === "/") p = "/index.html";
      const file = path.join(PUBLIC, p);
      if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end("Not found"); } res.writeHead(200, {"content-type":MIME[path.extname(file)] || "application/octet-stream", "cache-control":"no-cache"}); res.end(data); });
    } catch (e) { out(res, 500, {error:"Server error."}); }
  }).listen(PORT, () => console.log("Deriv Signal Assistant on port " + PORT + (TOKEN && CHAT && PASS ? " (Telegram relay configured)" : " (Telegram relay NOT configured)")));
}
