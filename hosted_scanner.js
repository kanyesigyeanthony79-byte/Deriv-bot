"use strict";
// One-shot GitHub Actions scanner. Reuses the repository's engine.js rules.
// Signal-only: this file contains no Deriv order/buy code.
const fs = require("node:fs");
const path = require("node:path");
const { evaluate, DEF } = require("./engine");

const PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public";
const GRANULARITY = 900;
const MARKETS = [
  ["R_10", "Volatility 10 Index"],
  ["R_25", "Volatility 25 Index"],
  ["R_50", "Volatility 50 Index"],
  ["R_75", "Volatility 75 Index"],
  ["JD100", "Jump 100 Index"]
];
const STATE_FILE = path.join(__dirname, "signal_state.json");
const WORKER_URL = process.env.TELEGRAM_WORKER_URL;
const API_KEY = process.env.SIGNAL_API_KEY;
const MAX_SIGNAL_AGE = 360; // scheduled runs are five minutes apart

if (!WORKER_URL || !API_KEY) {
  console.error("Missing TELEGRAM_WORKER_URL or SIGNAL_API_KEY GitHub Actions secret.");
  process.exit(1);
}
let parsedUrl;
try { parsedUrl = new URL(WORKER_URL); } catch { throw new Error("TELEGRAM_WORKER_URL is not a valid URL."); }
if (parsedUrl.protocol !== "https:") throw new Error("Telegram Worker URL must use HTTPS.");

let state = { lastSig: {} };
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (saved && typeof saved === "object" && saved.lastSig) state = saved;
} catch {}
const log = (event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Deriv WebSocket connection timed out")); }, 15000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      let nextId = 0;
      const pending = new Map();
      ws.addEventListener("message", ev => {
        let data;
        try { data = JSON.parse(String(ev.data)); } catch { return; }
        const id = data.req_id;
        if (id && pending.has(id)) {
          const entry = pending.get(id);
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.resolve(data);
        }
      });
      ws.addEventListener("close", () => {
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("Deriv WebSocket closed before replying"));
          pending.delete(id);
        }
      });
      resolve({
        ws,
        ask(payload, timeoutMs = 20000) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error("Deriv request timed out")); }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Deriv WebSocket connection error"));
    }, { once: true });
  });
}

const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const symbolCode = s => s.underlying_symbol || s.symbol || "";
const symbolName = s => s.underlying_symbol_name || s.display_name || "";

async function resolveSymbols(client) {
  const found = {};
  for (const mode of ["brief", "full"]) {
    const reply = await client.ask({ active_symbols: mode });
    if (reply.error) throw new Error("active_symbols: " + reply.error.message);
    const list = reply.active_symbols || [];
    for (const [fallback, name] of MARKETS) {
      if (found[fallback]) continue;
      const match = list.find(x => norm(symbolName(x)) === norm(name)) || list.find(x => symbolCode(x) === fallback);
      if (match && symbolCode(match)) found[fallback] = symbolCode(match);
    }
    if (Object.keys(found).length === MARKETS.length) break;
  }
  for (const [id, name] of MARKETS) if (!found[id]) log("symbol_not_confirmed", { market: name });
  return found;
}

function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let value = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

async function sendTelegram(market, direction, candles) {
  const candle = candles[candles.length - 1];
  const atr = calculateAtr(candles, 14);
  if (!(atr > 0)) throw new Error("ATR unavailable; refusing to send incomplete levels.");
  const entry = candle.close;
  const risk = atr * 1.5;
  const digits = Math.max(2, Math.min(8, (String(candle.close).split(".")[1] || "").length));
  const levels = {
    entry: Number(entry.toFixed(digits)),
    stopLoss: Number((direction === "BUY" ? entry - risk : entry + risk).toFixed(digits)),
    tp1: Number((direction === "BUY" ? entry + risk * 2 : entry - risk * 2).toFixed(digits)),
    tp2: Number((direction === "BUY" ? entry + risk * 3 : entry - risk * 3).toFixed(digits))
  };
  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify({ market, direction, ...levels }),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) {
    throw new Error(result.error || ("Telegram Worker returned HTTP " + response.status));
  }
  log("telegram_delivered", { market, direction, candle_epoch: candle.epoch, ...levels });
}

async function main() {
  const client = await connect(PUBLIC);
  try {
    const timeReply = await client.ask({ time: 1 });
    if (timeReply.error) throw new Error("Deriv time: " + timeReply.error.message);
    const now = Number(timeReply.time) || Math.floor(Date.now() / 1000);
    const symbols = await resolveSymbols(client);
    for (const [id, name] of MARKETS) {
      const symbol = symbols[id];
      if (!symbol) continue;
      try {
        const reply = await client.ask({
          ticks_history: symbol, adjust_start_time: 1, count: 200,
          end: "latest", granularity: GRANULARITY, style: "candles"
        });
        if (reply.error) throw new Error(reply.error.message);
        const candles = (reply.candles || [])
          .map(x => ({ epoch: Number(x.epoch), open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close) }))
          .filter(x => [x.epoch, x.open, x.high, x.low, x.close].every(Number.isFinite))
          .sort((a, b) => a.epoch - b.epoch)
          .filter(x => x.epoch + GRANULARITY <= now);
        const result = evaluate(candles);
        if (result.state !== "ok" || result.signal === "NO TRADE") {
          log("no_signal", { market: name, state: result.state || "unknown" });
          continue;
        }
        const candleEpoch = result.c.epoch;
        const previous = Number(state.lastSig[id] || 0);
        if (candleEpoch <= previous || candleEpoch - previous < DEF.cooldown * GRANULARITY) {
          log("signal_suppressed", { market: name, direction: result.signal, reason: "duplicate_or_cooldown", candle_epoch: candleEpoch });
          continue;
        }
        state.lastSig[id] = candleEpoch;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
        const age = now - (candleEpoch + GRANULARITY);
        if (age > MAX_SIGNAL_AGE) {
          log("signal_skipped", { market: name, direction: result.signal, age_seconds: age, reason: "too_old_for_alert" });
          continue;
        }
        log("signal_detected", { market: name, direction: result.signal, score: result.score, close: result.c.close, candle_epoch: candleEpoch, age_seconds: age, checks_passed: result.pass });
        await sendTelegram(name, result.signal, candles);
      } catch (error) {
        log("market_scan_error", { market: name, message: error.message });
      }
    }
  } finally {
    client.close();
  }
}

main().catch(error => {
  log("scanner_failed", { message: error.message });
  process.exitCode = 1;
});
