"use strict";
// Hosted signal scanner and outcome monitor. Signal-only: no order execution.
const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("./scanner_data_dir");
const DATA_DIR = getDataDir();
const { evaluate, DEF } = require("./engine");
const { journalOutcome: recordJournalOutcome, reconcileJournalState, markExpired, updateFavourableMovement } = require("./signal_journal");
const { dailySummary, deliverDailyReport, previousUgandaDay } = require("./daily_summary");
const { createDerivDemoReadOnlySnapshot } = require("./scripts/demo_readonly_account_snapshot");
const { priorityForMarket } = require("./priority_pairs");
const { createHeartbeat } = require("./scanner_heartbeat");
const { cleanupUnmonitoredSignals } = require("./stale_signal_cleanup");

const PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public";
const GRANULARITY = 900;
const MARKETS = [
  ["R_10", "Volatility 10 Index"],
  ["R_25", "Volatility 25 Index"],
  ["R_50", "Volatility 50 Index"],
  ["R_75", "Volatility 75 Index"],
  ["JD100", "Jump 100 Index"],
  ["CRASH500", "Crash 500 Index"],
  ["BOOM500", "Boom 500 Index"]
];
const STATE_FILE = path.join(DATA_DIR, "signal_state.json");
const HEARTBEAT_FILE = path.join(DATA_DIR, "scanner_heartbeat.json");
let heartbeat;
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

const JOURNAL_FILE = path.join(DATA_DIR, "trade_journal.json");
let journal = { version: 1, signals: [], dailyReports: {} };
try {
  const savedJournal = JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8"));
  if (savedJournal && Array.isArray(savedJournal.signals)) journal = { version: 1, signals: savedJournal.signals, dailyReports: savedJournal.dailyReports || {} };
} catch {}
const saveJournal = () => fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2) + "\n");
if (reconcileJournalState(journal, state, log) > 0) saveJournal();
const unmonitoredExpired = cleanupUnmonitoredSignals({
  state, journal,
  nowEpoch: Math.floor(Date.now() / 1000),
  monitoredMarketIds: MARKETS.map(([id]) => id),
  excludedMarketIds: ["R_10"],
  maxAgeSeconds: MAX_MONITOR_AGE,
  markExpired,
  log
});
if (unmonitoredExpired > 0) {
  saveState();
  saveJournal();
  log("unmonitored_signal_cleanup_completed", { expired: unmonitoredExpired });
}
const localDate = epoch => new Intl.DateTimeFormat("en-CA", {timeZone:"Africa/Kampala",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(epoch * 1000));
const findJournalSignal = id => journal.signals.find(s => s.signalId === id);

async function readDemoSnapshotForReport() {
  if (!process.env.DERIV_TOKEN || !process.env.DERIV_ACCOUNT_ID) {
    return { status: "not_configured" };
  }
  try {
    const snapshot = await createDerivDemoReadOnlySnapshot({
      token: process.env.DERIV_TOKEN,
      accountId: process.env.DERIV_ACCOUNT_ID,
      appId: process.env.DERIV_APP_ID
    });
    return { status: "ok", ...snapshot };
  } catch (error) {
    // Do not log credentials, OTP URLs, response bodies, or raw transport details.
    log("demo_account_snapshot_failed", { reason: String(error.message || "read_only_snapshot_failed").slice(0, 100) });
    return { status: "unavailable" };
  }
}
function journalCandidate(entry) {
  if (findJournalSignal(entry.signalId)) return;
  journal.signals.push(entry);
  saveJournal();
}
function journalStatus(signalId, status, reason) {
  const entry = findJournalSignal(signalId);
  if (entry && entry.status === "detected") { entry.status = status; if (reason) entry.statusReason = reason; saveJournal(); }
}
async function maybeSendDailySummary(now) {
  // Retry the previous Uganda calendar day's report on every scanner cycle until delivery succeeds.
  // A successful Telegram response is persisted in the journal to prevent routine duplicate reports.
  const reportDay = previousUgandaDay(now);
  const localNow = new Date(now * 1000);
  const localClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Kampala", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(localNow);
  const [localHour, localMinute] = localClock.split(":").map(Number);
  if (localHour * 60 + localMinute < 15) return; // allow final completed candles and MTF journal commit to arrive
  if (journal.dailyReports[reportDay]?.delivered) return;
  let mtfSignals = [];
  try {
    const mtfJournal = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "multi_timeframe_journal.json"), "utf8"));
    if (mtfJournal && Array.isArray(mtfJournal.signals)) mtfSignals = mtfJournal.signals;
  } catch {}
  const summary = dailySummary(journal.signals, reportDay, MARKETS, mtfSignals);
  const accountSnapshot = await readDemoSnapshotForReport();
  try {
    await deliverDailyReport(summary, accountSnapshot, postTelegram);
    journal.dailyReports[reportDay] = {
      attemptedAt: new Date(now * 1000).toISOString(),
      delivered: true,
      stats: summary,
      accountSnapshot: accountSnapshot.status === "ok" ? {
        status: "ok", mode: accountSnapshot.mode, accountId: accountSnapshot.accountId,
        currency: accountSnapshot.currency, balance: accountSnapshot.balance,
        equityEstimate: accountSnapshot.equityEstimate,
        openContracts: accountSnapshot.openPositions.length,
        fetchedAt: accountSnapshot.fetchedAt,
        ordersPlaced: 0
      } : { status: accountSnapshot.status }
    };
    saveJournal();
    log("daily_summary_delivered", {
      day: reportDay, generated: summary.generated, sent: summary.sent,
      wins: summary.wins, losses: summary.losses, winRate: summary.winRate,
      accountSnapshotStatus: accountSnapshot.status
    });
  } catch (error) {
    log("daily_summary_delivery_failed", {
      day: reportDay, message: error.message,
      note: "The report will be retried on the next scanner cycle."
    });
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
  try {
    const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true) {
      const telegram = result.telegram && typeof result.telegram === "object" ? result.telegram : {};
      const detail = [
        telegram.httpStatus ? "Telegram HTTP " + telegram.httpStatus : null,
        telegram.errorCode ? "code " + telegram.errorCode : null,
        telegram.description || null,
        result.detail || null
      ].filter(Boolean).join(": ");
      throw new Error((result.error || ("Telegram Worker returned HTTP " + response.status)) +
        (detail ? " — " + detail : ""));
    }
    if (result.suppressed === true) {
      log("telegram_alert_suppressed", {
        event: payload.event, marketId: payload.marketId || null,
        signalId: payload.signalId || null, reason: result.reason || "market_specific_filter"
      });
      return result;
    }
    if (heartbeat && (payload.event === "new_signal" || payload.event === "outcome")) heartbeat.telegram(payload.event, true);
    return result;
  } catch (error) {
    if (heartbeat && (payload.event === "new_signal" || payload.event === "outcome")) heartbeat.telegram(payload.event, false, { error: String(error.message || error) });
    throw error;
  }
}

async function sendOutcome(signal, outcome, candle) {
  await postTelegram({
    event: "outcome",
    source: "LEGACY_15M",
    marketId: signal.marketId,
    outcome,
    signalId: signal.signalId,
    market: signal.market,
    direction: signal.direction,
    priorityTier: signal.priorityTier || null,
    priorityLabel: signal.priorityLabel || null,
    priorityMetricName: signal.priorityMetricName || null,
    priorityMetricPct: signal.priorityMetricPct ?? null,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    tp1: signal.tp1,
    tp2: signal.tp2,
    currentPrice: candle.close
  });
  log("outcome_recorded", { signalId: signal.signalId, market: signal.market, outcome, candle_epoch: candle.epoch, observed_close: candle.close });
  recordJournalOutcome(journal, signal.signalId, outcome, candle);
  saveJournal();
}

async function monitorSignals(marketId, candles, now) {
  const active = state.activeSignals.filter(s => s.marketId === marketId && !s.closed);
  for (const signal of active) {
    if (now - signal.createdEpoch > MAX_MONITOR_AGE) {
      const lastCandle = candles[candles.length - 1];
      if (lastCandle) {
        try {
          await sendOutcome(signal, "EXPIRED", lastCandle);
        } catch (error) {
          markExpired(journal, signal.signalId, lastCandle, "expired_after_24_hours; expiry_alert_failed");
          saveJournal();
          log("expiry_alert_failed", { signalId: signal.signalId, market: signal.market, message: error.message });
        }
      } else {
        markExpired(journal, signal.signalId, null, "expired_after_24_hours_no_recent_candle");
        saveJournal();
      }
      signal.closed = true;
      signal.closeReason = "expired_after_24_hours";
      log("signal_expired", { signalId: signal.signalId, market: signal.market });
      continue;
    }

    const laterCandles = candles.filter(c => c.epoch > Number(signal.lastCheckedEpoch || signal.createdEpoch));
    for (const candle of laterCandles) {
      updateFavourableMovement(journal, signal.signalId, candle);
      const isBuy = signal.direction === "BUY";
      const slTouched = isBuy ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
      const tp1Touched = isBuy ? candle.high >= signal.tp1 : candle.low <= signal.tp1;
      const tp2Touched = isBuy ? candle.high >= signal.tp2 : candle.low <= signal.tp2;

      // OHLC candles cannot tell us which level came first if both sides were touched.
      if (slTouched && (tp1Touched || tp2Touched)) {
        signal.closed = true;
        signal.closeReason = "ambiguous_same_candle";
        signal.lastCheckedEpoch = candle.epoch;
        recordJournalOutcome(journal, signal.signalId, "AMBIGUOUS", candle);
        saveJournal();
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
  heartbeat = createHeartbeat({ filePath: HEARTBEAT_FILE, markets: MARKETS.map(([, name]) => name) });
  log("scanner_started", { markets: MARKETS.length, granularity_seconds: GRANULARITY });
  const client = await connect(PUBLIC);
  try {
    const timeReply = await client.ask({ time: 1 });
    if (timeReply.error) throw new Error("Deriv time: " + timeReply.error.message);
    const now = Number(timeReply.time) || Math.floor(Date.now() / 1000);
    const symbols = await resolveSymbols(client);

    for (const [id, name] of MARKETS) {
      if (id === "R_10" && process.env.R10_LEGACY_ROLLBACK_ENABLED !== "true") {
        heartbeat.market(name, "skipped", { reason: "volatility10_exclusive_provider_gate" });
        continue;
      }
      const symbol = symbols[id];
      if (!symbol) {
        heartbeat.market(name, "unavailable", { reason: "symbol_not_confirmed" });
        continue;
      }
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
        const hasSignal = result.state === "ok" && result.signal !== "NO TRADE";
        // Record market-data/evaluation health separately from notification delivery.
        // A Telegram failure must never turn a successfully scanned market into a scan error.
        heartbeat.market(name, "success", {
          candles: candles.length,
          signalFound: hasSignal,
          evaluationState: result.state || "unknown",
          ...(hasSignal ? { direction: result.signal } : {})
        });

        await monitorSignals(id, candles, now);

        if (!hasSignal) {
          log("no_signal", { market: name, state: result.state || "unknown" });
          continue;
        }
        heartbeat.signalDetected();

        const candleEpoch = result.c.epoch;
        const signalId = id + "-" + candleEpoch;
        const priority = priorityForMarket(id);
        journalCandidate({
          signalId, marketId:id, market:name, direction:result.signal, localDate:localDate(candleEpoch),
          ...(priority ? {
            priorityTier: priority.tier, priorityLabel: priority.label,
            priorityMetricName: priority.metricName, priorityMetricPct: priority.metricPct,
            prioritySampleBars: priority.sampleBars, priorityEvidenceAsOf: priority.asOf
          } : {}),
          createdAt:new Date(candleEpoch*1000).toISOString(), candleEpoch, score:result.score,
          entry:result.c.close, metrics:result.metrics || {}, checks:result.checks || [],
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
        const telegramResult = await postTelegram({
          event: "new_signal", source: "LEGACY_15M", signalId, marketId: id, market: name, direction: result.signal, ...levels,
          ...(priority ? {
            priorityTier: priority.tier, priorityLabel: priority.label,
            priorityMetricName: priority.metricName, priorityMetricPct: priority.metricPct
          } : {})
        });
        journalStatus(signalId, telegramResult?.suppressed === true ? "suppressed" : "sent",
          telegramResult?.suppressed === true ? (telegramResult.reason || "market_specific_telegram_filter") : undefined);
        state.lastSig[id] = candleEpoch;
        state.activeSignals.push({
          signalId,
          marketId: id,
          market: name,
          direction: result.signal,
          ...(priority ? {
            priorityTier: priority.tier, priorityLabel: priority.label,
            priorityMetricName: priority.metricName, priorityMetricPct: priority.metricPct
          } : {}),
          ...levels,
          createdEpoch: candleEpoch,
          lastCheckedEpoch: candleEpoch,
          tp1Hit: false,
          tp2Hit: false,
          closed: false
        });
        saveState();
        log(telegramResult?.suppressed === true ? "telegram_suppressed" : "telegram_delivered",
          { signalId, market: name, direction: result.signal, candle_epoch: candleEpoch,
            reason: telegramResult?.reason || null, ...levels });
      } catch (error) {
        const message = String(error.message || error).slice(0, 200);
        // Only candle retrieval/evaluation failures count as market scan failures.
        // Telegram delivery failures are counted by postTelegram() in the Telegram totals.
        const latestMarket = heartbeat.record.marketResults.find(item => item.market === name);
        if (!latestMarket || latestMarket.status !== "success") {
          heartbeat.market(name, "error", { error: message });
          log("market_scan_error", { market: name, message });
        } else {
          log("market_processing_error", { market: name, message });
        }
        const pending = [...journal.signals].reverse().find(entry => entry.marketId === id && entry.status === "detected");
        if (pending) journalStatus(pending.signalId, "delivery_failed", message);
      }
    }
    await maybeSendDailySummary(now);
    saveState();
    saveJournal();
    heartbeat.finish(heartbeat.record.marketsFailed > 0 || heartbeat.record.marketsUnavailable > 0 ? "partial" : "success");
    log("scanner_completed", {
      scannedAt: new Date(now * 1000).toISOString(),
      activeSignals: state.activeSignals.filter(signal => !signal.closed).length,
      journalRecords: journal.signals.length
    });
  } finally {
    client.close();
  }
}

main().catch(error => {
  if (heartbeat) heartbeat.finish("failed", error);
  log("scanner_failed", { message: error.message });
  process.exitCode = 1;
});
