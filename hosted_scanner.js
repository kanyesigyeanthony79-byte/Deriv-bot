"use strict";
// Hosted signal scanner and outcome monitor. Signal-only: no order execution.
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
const MAX_SIGNAL_AGE = 360;
const MAX_MONITOR_AGE = 96 * GRANULARITY; // expire unresolved signals after 24 hours

if (!WORKER_URL || !API_KEY) {
  console.error("Missing TELEGRAM_WORKER_URL or SIGNAL_API_KEY GitHub Actions secret.");
  process.exit(1);
}
let parsedUrl;
try { parsedUrl = new URL(WORKER_URL); } catch { throw new Error("TELEGRAM_WORKER_URL is not a valid URL."); }
if (parsedUrl.protocol !== "https:") throw new Error("Telegram Worker URL must use HTTPS.");

let state = { lastSig: {}, activeSignals: [] };
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (saved && typeof saved === "object") {
    state = {
      lastSig: saved.lastSig && typeof saved.lastSig === "object" ? saved.lastSig : {},
      activeSignals: Array.isArray(saved.activeSignals) ? saved.activeSignals : []
    };
  }
} catch {}
const log = (event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

const JOURNAL_FILE = path.join(__dirname, "trade_journal.json");
let journal = { version: 1, signals: [], dailyReports: {} };
try {
  const savedJournal = JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8"));
  if (savedJournal && Array.isArray(savedJournal.signals)) journal = { version: 1, signals: savedJournal.signals, dailyReports: savedJournal.dailyReports || {} };
} catch {}
const saveJournal = () => fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2) + "\n");
const localDate = epoch => new Intl.DateTimeFormat("en-CA", {timeZone:"Africa/Kampala",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(epoch * 1000));
const findJournalSignal = id => journal.signals.find(s => s.signalId === id);
function journalCandidate(entry) {
  if (findJournalSignal(entry.signalId)) return;
  journal.signals.push(entry);
  saveJournal();
}
function journalOutcome(signal, outcome, candle) {
  const entry = findJournalSignal(signal.signalId);
  if (!entry) return;
  entry.events = Array.isArray(entry.events) ? entry.events : [];
  entry.events.push({outcome, observedAt:new Date().toISOString(), candleEpoch:candle.epoch, candle:{open:candle.open,high:candle.high,low:candle.low,close:candle.close}});
  if (outcome === "TP1_HIT") entry.tp1Hit = true;
  if (outcome === "TP2_HIT") { entry.tp2Hit = true; entry.finalOutcome = "TP2"; }
  if (outcome === "SL_HIT") entry.finalOutcome = entry.tp1Hit ? "SL_AFTER_TP1" : "SL";
  if (outcome === "AMBIGUOUS") entry.finalOutcome = "AMBIGUOUS";
  saveJournal();
}
function journalStatus(signalId, status, reason) {
  const entry = findJournalSignal(signalId);
  if (entry && entry.status === "detected") { entry.status = status; if (reason) entry.statusReason = reason; saveJournal(); }
}
function dailySummary(day) {
  const rows = journal.signals.filter(s => s.localDate === day);
  const sent = rows.filter(s => s.status === "sent").length;
  const missed = rows.filter(s => ["suppressed","stale","delivery_failed"].includes(s.status)).length;
  const tp1 = rows.filter(s => s.tp1Hit).length;
  const tp2 = rows.filter(s => s.tp2Hit).length;
  const sl = rows.filter(s => s.finalOutcome === "SL" || s.finalOutcome === "SL_AFTER_TP1").length;
  const expired = rows.filter(s => s.finalOutcome === "EXPIRED").length;
  const ambiguous = rows.filter(s => s.finalOutcome === "AMBIGUOUS").length;
  const unresolved = rows.filter(s => s.status === "sent" && !s.finalOutcome).length;
  const byMarket = MARKETS.map(([id,name]) => {
    const m = rows.filter(s => s.marketId === id);
    return name + ": " + m.length + " generated, " + m.filter(s=>s.finalOutcome==="TP2").length + " TP2, " + m.filter(s=>s.finalOutcome==="SL"||s.finalOutcome==="SL_AFTER_TP1").length + " SL";
  }).filter((_,i)=>rows.some(s=>s.marketId===MARKETS[i][0]));
  return {day,generated:rows.length,sent,missed,tp1,tp2,sl,expired,ambiguous,unresolved,byMarket};
}
async function maybeSendDailySummary(now) {
  const localNow = new Date(now * 1000).toLocaleString("en-GB",{timeZone:"Africa/Kampala",hour:"2-digit",minute:"2-digit",hour12:false});
  const [hour,minute] = localNow.split(":").map(Number);
  if (hour !== 0 || minute > 9) return;
  const today = localDate(now);
  const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0,10);
  if (journal.dailyReports[yesterday]) return;
  const s = dailySummary(yesterday);
  const message = "DAILY DERIV SIGNAL REPORT (" + yesterday + ")\n" +
    "Generated: " + s.generated + "\nSent to Telegram: " + s.sent + "\nMissed / not sent: " + s.missed +
    "\nTP1 hit: " + s.tp1 + "\nTP2 hit: " + s.tp2 + "\nSL hit: " + s.sl +
    "\nExpired: " + s.expired + "\nAmbiguous: " + s.ambiguous + "\nStill open/unresolved: " + s.unresolved +
    (s.byMarket.length ? "\n\nBY MARKET\n" + s.byMarket.join("\n") : "");
  try {
    await postTelegram({event:"daily_summary", message, text:message});
    journal.dailyReports[yesterday] = {attemptedAt:new Date(now*1000).toISOString(), delivered:true, stats:s};
    saveJournal();
    log("daily_summary_delivered",{day:yesterday,generated:s.generated,sent:s.sent,tp1:s.tp1,tp2:s.tp2,sl:s.sl});
  } catch(error) {
    log("daily_summary_delivery_failed",{day:yesterday,message:error.message,note:"Telegram Worker may need daily_summary event support"});
  }
}


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

function makeLevels(candles, direction) {
  const candle = candles[candles.length - 1];
  const atr = calculateAtr(candles, 14);
  if (!(atr > 0)) throw new Error("ATR unavailable; refusing to send incomplete levels.");
  const entry = candle.close;
  const risk = atr * 1.5;
  const digits = Math.max(2, Math.min(8, (String(candle.close).split(".")[1] || "").length));
  return {
    entry: Number(entry.toFixed(digits)),
    stopLoss: Number((direction === "BUY" ? entry - risk : entry + risk).toFixed(digits)),
    tp1: Number((direction === "BUY" ? entry + risk * 2 : entry - risk * 2).toFixed(digits)),
    tp2: Number((direction === "BUY" ? entry + risk * 3 : entry - risk * 3).toFixed(digits))
  };
}

async function postTelegram(payload) {
  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) {
    throw new Error(result.error || ("Telegram Worker returned HTTP " + response.status));
  }
}

async function sendOutcome(signal, outcome, candle) {
  await postTelegram({
    event: "outcome",
    outcome,
    signalId: signal.signalId,
    market: signal.market,
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    tp1: signal.tp1,
    tp2: signal.tp2,
    currentPrice: candle.close
  });
  log("outcome_delivered", { signalId: signal.signalId, market: signal.market, outcome, candle_epoch: candle.epoch, observed_close: candle.close });
  journalOutcome(signal.signalId, outcome, candle);
}

async function monitorSignals(marketId, candles, now) {
  const active = state.activeSignals.filter(s => s.marketId === marketId && !s.closed);
  for (const signal of active) {
    if (now - signal.createdEpoch > MAX_MONITOR_AGE) {
      signal.closed = true;
      signal.closeReason = "expired_after_24_hours";
      const je = findJournalSignal(signal.signalId); if (je) { je.finalOutcome = "EXPIRED"; je.statusReason = "expired_after_24_hours"; saveJournal(); }
      log("signal_expired", { signalId: signal.signalId, market: signal.market });
      continue;
    }

    const laterCandles = candles.filter(c => c.epoch > Number(signal.lastCheckedEpoch || signal.createdEpoch));
    for (const candle of laterCandles) {
      const isBuy = signal.direction === "BUY";
      const slTouched = isBuy ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
      const tp1Touched = isBuy ? candle.high >= signal.tp1 : candle.low <= signal.tp1;
      const tp2Touched = isBuy ? candle.high >= signal.tp2 : candle.low <= signal.tp2;

      // OHLC candles cannot tell us which level came first if both sides were touched.
      if (slTouched && (tp1Touched || tp2Touched)) {
        signal.closed = true;
        signal.closeReason = "ambiguous_same_candle";
        signal.lastCheckedEpoch = candle.epoch;
        journalOutcome(signal.signalId, "AMBIGUOUS", candle);
        log("ambiguous_outcome_not_reported", { signalId: signal.signalId, market: signal.market, candle_epoch: candle.epoch });
        break;
      }

      if (slTouched) {
        await sendOutcome(signal, "SL_HIT", candle);
        signal.closed = true;
        signal.closeReason = signal.tp1Hit ? "sl_after_tp1" : "sl_hit";
        signal.lastCheckedEpoch = candle.epoch;
        break;
      }

      if (tp1Touched && !signal.tp1Hit) {
        await sendOutcome(signal, "TP1_HIT", candle);
        signal.tp1Hit = true;
      }

      if (tp2Touched && !signal.tp2Hit) {
        if (!signal.tp1Hit) {
          await sendOutcome(signal, "TP1_HIT", candle);
          signal.tp1Hit = true;
        }
        await sendOutcome(signal, "TP2_HIT", candle);
        signal.tp2Hit = true;
        signal.closed = true;
        signal.closeReason = "tp2_hit";
        signal.lastCheckedEpoch = candle.epoch;
        break;
      }

      signal.lastCheckedEpoch = candle.epoch;
    }
  }
  state.activeSignals = state.activeSignals.filter(s => !s.closed);
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

        await monitorSignals(id, candles, now);

        const result = evaluate(candles);
        if (result.state !== "ok" || result.signal === "NO TRADE") {
          log("no_signal", { market: name, state: result.state || "unknown" });
          continue;
        }

        const candleEpoch = result.c.epoch;
        const signalId = id + "-" + candleEpoch;
        journalCandidate({
          signalId, marketId:id, market:name, direction:result.signal, localDate:localDate(candleEpoch),
          createdAt:new Date(candleEpoch*1000).toISOString(), candleEpoch, score:result.score,
          entry:candle.close, metrics:result.metrics || {}, checks:result.checks || [],
          status:"detected", tp1Hit:false, tp2Hit:false, finalOutcome:null, events:[]
        });
        const previous = Number(state.lastSig[id] || 0);
        if (candleEpoch <= previous || candleEpoch - previous < DEF.cooldown * GRANULARITY) {
          journalStatus(signalId, "suppressed", "duplicate_or_cooldown");
          log("signal_suppressed", { market: name, direction: result.signal, reason: "duplicate_or_cooldown", candle_epoch: candleEpoch });
          continue;
        }

        const age = now - (candleEpoch + GRANULARITY);
        if (age > MAX_SIGNAL_AGE) {
          journalStatus(signalId, "stale", "too_old_for_alert");
          log("signal_skipped", { market: name, direction: result.signal, age_seconds: age, reason: "too_old_for_alert" });
          continue;
        }

        const levels = makeLevels(candles, result.signal);
        await postTelegram({ market: name, direction: result.signal, ...levels });
        journalStatus(signalId, "sent");
        state.lastSig[id] = candleEpoch;
        state.activeSignals.push({
          signalId,
          marketId: id,
          market: name,
          direction: result.signal,
          ...levels,
          createdEpoch: candleEpoch,
          lastCheckedEpoch: candleEpoch,
          tp1Hit: false,
          tp2Hit: false,
          closed: false
        });
        saveState();
        log("telegram_delivered", { signalId, market: name, direction: result.signal, candle_epoch: candleEpoch, ...levels });
      } catch (error) {
        const pending = [...journal.signals].reverse().find(entry => entry.marketId === id && entry.status === "detected");
        if (pending) journalStatus(pending.signalId, "delivery_failed", error.message);
        log("market_scan_error", { market: name, message: error.message });
      }
    }
    saveState();
  } finally {
    client.close();
  }
}

main().catch(error => {
  log("scanner_failed", { message: error.message });
  process.exitCode = 1;
});
