"use strict";
// Gold research uses the latest aligned continuous session; session gaps are not bridged.
// Research/forward-shadow cycle shared by the hosted scanner. Standard Volatility 10 and retired MTF are excluded; 1-second products are separate markets.
// Observation/Telegram only; never imports production routing or MT5 execution modules.
const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("./scanner_data_dir");
const { updateBreakoutRetestJournal } = require("./breakout_retest_shadow");
const { updateM5PullbackJournal } = require("./m5_ema_pullback_shadow");
const { updateJournal: updateBreakoutM5M15Journal } = require("./breakout_retest_m5_m15_shadow");
const { evaluateMarketRegime } = require("./market_regime_filter_shadow");
const { updateM15ExpansionForwardShadowJournal, buildExpansionAlert } = require("./m15_expansion_forward_shadow");

const DATA_DIR = getDataDir();
// 1-second products use their canonical Deriv API symbol codes (not standard R_* aliases).
const MARKETS = Object.freeze([
  ["R_25", "Volatility 25 Index"], ["R_50", "Volatility 50 Index"],
  ["R_75", "Volatility 75 Index"], ["JD75", "Jump 75 Index"],
  ["JD100", "Jump 100 Index"], ["CRASH500", "Crash 500 Index"],
  ["BOOM500", "Boom 500 Index"], ["frxXAUUSD", "Gold (XAUUSD)"],
  ["1HZ10V", "Volatility 10 (1s) Index"],
  ["1HZ75V", "Volatility 75 (1s) Index"],
  ["RB100", "Range Break 100 Index"],
  ["RB200", "Range Break 200 Index"]
]);
const FRAMES = [["M1", 60, 300], ["M5", 300, 120], ["M15", 900, 120]];
const JOURNALS = {
  breakoutM1: "breakout_retest_shadow_journal.json",
  emaPullback: "m5_ema_pullback_shadow_journal.json",
  breakoutM5M15: "breakout_retest_m5_m15_shadow_journal.json",
  delivery: "shadow_telegram_delivery_journal.json"
};
const PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";

function readJson(name, fallback) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(name, value) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2) + "\n");
}
function connect(url = PUBLIC_WS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Deriv WebSocket connection timed out")); }, 15000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      let reqId = 0;
      const pending = new Map();
      ws.addEventListener("message", event => {
        let payload;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        const waiter = pending.get(payload.req_id);
        if (!waiter) return;
        pending.delete(payload.req_id);
        clearTimeout(waiter.timer);
        if (payload.error) waiter.reject(new Error(payload.error.message || "Deriv API error"));
        else waiter.resolve(payload);
      });
      ws.addEventListener("close", () => {
        for (const [id, waiter] of pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Deriv WebSocket closed"));
          pending.delete(id);
        }
      });
      resolve({
        ask(payload, timeoutMs = 25000) {
          return new Promise((res, rej) => {
            const id = ++reqId;
            const requestTimer = setTimeout(() => { pending.delete(id); rej(new Error("Deriv request timed out")); }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer: requestTimer });
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Deriv WebSocket connection error")); }, { once: true });
  });
}
function normalizeCandles(rows, seconds, nowEpoch) {
  const lastClosedEpoch = Math.floor(nowEpoch / seconds) * seconds - seconds;
  return (rows || []).map(c => ({
    epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high),
    low: Number(c.low), close: Number(c.close)
  })).filter(c => [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.epoch <= lastClosedEpoch && c.high >= Math.max(c.open, c.close, c.low) &&
    c.low <= Math.min(c.open, c.close)).sort((a, b) => a.epoch - b.epoch);
}
async function fetchCandles(client, symbol, granularity, count, nowEpoch) {
  const response = await client.ask({
    ticks_history: symbol, adjust_start_time: 1, count,
    end: "latest", granularity, style: "candles"
  });
  if (response.error) throw new Error(response.error.message || "Deriv candle request failed");
  return normalizeCandles(response.candles, granularity, nowEpoch).slice(-count);
}
function newSignals(before, after) {
  const oldIds = new Set((before || []).map(s => s.signalId));
  return (after || []).filter(s => s.signalId && !oldIds.has(s.signalId));
}
function toAlert(signal, strategy, marketData, applyRegime = true) {
  if (!signal || signal.marketId === "R_10" || !MARKETS.some(([id]) => id === signal.marketId)) return null;
  const entry = Number(signal.entry);
  const stopLoss = Number(signal.stopLoss);
  const risk = Math.abs(entry - stopLoss);
  const direction = String(signal.direction || "").toUpperCase();
  const sign = direction === "BUY" ? 1 : -1;
  const tp2 = Number(signal.tp2);
  const target = Number.isFinite(tp2) ? tp2 : Number(signal.target);
  if (!signal.signalId || !["BUY", "SELL"].includes(direction) ||
      ![entry, stopLoss, risk, target].every(Number.isFinite) ||
      entry <= 0 || stopLoss <= 0 || risk <= 0 || target <= 0 ||
      (direction === "BUY" && !(stopLoss < entry && target > entry)) ||
      (direction === "SELL" && !(stopLoss > entry && target < entry))) return null;
  const tp1 = entry + sign * 1.5 * risk;
  const frames = marketData && marketData.timeframes || {};
  const regime = applyRegime
    ? evaluateMarketRegime({ m15: frames.M15 || [], m5: frames.M5 || [], direction, entryTimeframe: signal.entryTimeframe || "M5" })
    : { passed: true, adx: null, emaSeparationAtr: null };
  if (applyRegime && marketData) {
    marketData.regimeFilterDecisions ||= [];
    marketData.regimeFilterDecisions.push({ signalId: String(signal.signalId), strategyId: strategy, direction, entryTimeframe: signal.entryTimeframe || "?", ...regime });
  }
  if (!regime.passed) return null;
  return {
    event: "new_signal", source: "RESEARCH_SHADOW", paper: true, live: false,
    marketRegimeFilter: { status: "PASSED", adx: regime.adx, emaSeparationAtr: regime.emaSeparationAtr },
    signalId: String(signal.signalId), strategyId: strategy,
    strategyLabel: String(signal.strategyLabel || strategy),
    marketId: String(signal.marketId), market: String(signal.market || signal.marketId),
    direction, entry, stopLoss, tp1, tp2: target,
    setupTimeframe: signal.setupTimeframe || "?",
    entryTimeframe: signal.entryTimeframe || "?",
    confirmationTimeframe: signal.confirmationTimeframe || "?",
    status: "SHADOW"
  };
}
async function deliver(alert, env) {
  if (!env.TELEGRAM_WORKER_URL || !env.SIGNAL_API_KEY) throw new Error("Telegram worker URL/API key is not configured");
  const response = await fetch(env.TELEGRAM_WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": env.SIGNAL_API_KEY },
    body: JSON.stringify(alert)
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok || !result.success || result.suppressed) {
    throw new Error(result.error || result.reason || "Telegram worker rejected shadow alert (" + response.status + ")");
  }
  return result;
}
async function main(env = process.env, options = {}) {
  const now = Number(options.now) || Math.floor(Date.now() / 1000);
  const ownsClient = !options.client;
  const client = options.client || await connect();
  const symbols = options.symbols || {};
  try {
    const output = { version: 1, generatedAt: new Date(now * 1000).toISOString(), markets: {}, errors: [] };
    for (const [marketId, marketName] of MARKETS) {
      const market = { marketId, marketName, timeframes: {}, errors: [] };
      const isExpansionMarket = marketId === "RB100" || marketId === "RB200";
      for (const [tf, seconds, count] of FRAMES) {
        if (isExpansionMarket && tf !== "M15") continue;
        try {
          const symbol = symbols[marketId] || (!isExpansionMarket ? marketId : null);
          if (!symbol) throw new Error("Deriv active symbol was not confirmed; market skipped.");
          market.timeframes[tf] = await fetchCandles(client, symbol, seconds, count, now);
        } catch (error) { market.errors.push({ timeframe: tf, message: error.message }); }
      }
      output.markets[marketId] = market;
      if (market.errors.length) output.errors.push({ marketId, errors: market.errors });
    }

    // Keep the two M15 expansion markets out of the existing shadow strategies.
    // They receive only the isolated original-engine M15 forward evaluation below.
    const strategyMarkets = Object.fromEntries(Object.entries(output.markets)
      .filter(([marketId]) => marketId !== "RB100" && marketId !== "RB200"));
    const priorExpansion = readJson("m15_expansion_forward_shadow_journal.json", {
      version: 1, mode: "forward_shadow_observation_only", markets: {}, signals: []
    });
    const nextExpansion = updateM15ExpansionForwardShadowJournal(priorExpansion, output.markets, now);
    const priorA = readJson(JOURNALS.breakoutM1, { version: 1, updatedAt: null, markets: {}, signals: [] });
    const priorB = readJson(JOURNALS.emaPullback, { version: 1, updatedAt: null, markets: {}, signals: [] });
    const priorC = readJson(JOURNALS.breakoutM5M15, { version: 1, updatedAt: null, markets: {}, signals: [] });
    const nextA = updateBreakoutRetestJournal(priorA, strategyMarkets, now);
    const nextB = updateM5PullbackJournal(priorB, strategyMarkets, now);
    const nextC = updateBreakoutM5M15Journal(priorC, strategyMarkets, now);
    const delivery = readJson(JOURNALS.delivery, { version: 1, updatedAt: null, signals: {} });
    delivery.signals ||= {};
    const allCurrent = [
      ...nextA.signals.map(s => toAlert(s, "M5_BREAKOUT_M1_RETEST", output.markets[s.marketId], false)),
      ...nextB.signals.map(s => toAlert(s, "M15_M5_EMA_PULLBACK", output.markets[s.marketId], false)),
      ...nextC.signals.map(s => toAlert(s, "M5_BREAKOUT_M5_RETEST_M15_CONFIRM", output.markets[s.marketId], false)),
      ...nextExpansion.signals.map(s => buildExpansionAlert(s, now))
    ].filter(Boolean);
    const fresh = [
      ...newSignals(priorA.signals, nextA.signals).map(s => toAlert(s, "M5_BREAKOUT_M1_RETEST", output.markets[s.marketId])),
      ...newSignals(priorB.signals, nextB.signals).map(s => toAlert(s, "M15_M5_EMA_PULLBACK", output.markets[s.marketId])),
      ...newSignals(priorC.signals, nextC.signals).map(s => toAlert(s, "M5_BREAKOUT_M5_RETEST_M15_CONFIRM", output.markets[s.marketId])),
      ...nextExpansion.signals
        .filter(s => s.status === "PENDING" && !priorExpansion.signals?.some(p => p.signalId === s.signalId && Number.isFinite(p.entryEpoch)))
        .map(s => buildExpansionAlert(s, now))
    ].filter(Boolean);
    // Failed or interrupted deliveries are retried by stable ID; old journal entries
    // without a delivery record are never backfilled into Telegram.
    const retryIds = new Set(Object.entries(delivery.signals)
      .filter(([, record]) => record && ["failed", "pending"].includes(record.status))
      .map(([id]) => id));
    const byId = new Map([...fresh, ...allCurrent.filter(s => retryIds.has(s.signalId))]
      .filter(s => s.marketId !== "R_10" && MARKETS.some(([id]) => id === s.marketId))
      .map(s => [s.signalId, s]));
    const candidates = [...byId.values()];
    for (const alert of candidates) {
      delivery.signals[alert.signalId] ||= {
        signalId: alert.signalId, strategyId: alert.strategyId, marketId: alert.marketId,
        firstSeenAt: new Date(now * 1000).toISOString(), attempts: 0
      };
      if (delivery.signals[alert.signalId].status !== "sent") {
        delivery.signals[alert.signalId].status = "pending";
      }
    }
    // Persist delivery intent before journals/network calls so a process interruption
    // cannot strand a newly created signal without a retryable delivery record.
    delivery.updatedAt = new Date(now * 1000).toISOString();
    writeJson(JOURNALS.delivery, delivery);
    writeJson(JOURNALS.breakoutM1, nextA);
    writeJson(JOURNALS.emaPullback, nextB);
    writeJson("m15_expansion_forward_shadow_journal.json", nextExpansion);
    writeJson(JOURNALS.breakoutM5M15, nextC);

    let sent = 0, failed = 0;
    for (const alert of candidates) {
      const record = delivery.signals[alert.signalId];
      if (record.status === "sent") continue;
      record.attempts += 1;
      record.lastAttemptAt = new Date(now * 1000).toISOString();
      writeJson(JOURNALS.delivery, delivery);
      try {
        await deliver(alert, env);
        record.status = "sent";
        record.sentAt = new Date().toISOString();
        delete record.lastError;
        sent += 1;
      } catch (error) {
        record.status = "failed";
        record.lastError = error.message;
        failed += 1;
      }
      delivery.updatedAt = new Date().toISOString();
      writeJson(JOURNALS.delivery, delivery);
    }
    output.summary = {
      markets: Object.keys(output.markets).length,
      newCandidates: candidates.length, telegramSent: sent, telegramFailed: failed,
      strategies: {
        breakoutM1: nextA.summary || null,
        emaPullback: nextB.summary || null,
        breakoutM5M15: nextC.summary || null
      },
      m15ExpansionForwardShadow: nextExpansion.summary || null,
      r10Excluded: true, mtfEnabled: false, mt5ExecutionEnabled: false
    };
    const regimeJournal = { version: 1, generatedAt: output.generatedAt, mode: "shadow_only", productionGateEnabled: false, markets: Object.fromEntries(Object.entries(output.markets).map(([id, market]) => [id, { decisions: market.regimeFilterDecisions || [] }])) };
    const decisions = Object.values(regimeJournal.markets).flatMap(x => x.decisions);
    output.summary.marketRegime = { candidatesEvaluated: decisions.length, passed: decisions.filter(x => x.passed).length, rejected: decisions.filter(x => !x.passed).length, productionSignalsChanged: false };
    writeJson("market_regime_filter_shadow_journal.json", regimeJournal);
    writeJson("research_shadow_collection.json", output);
    console.log(JSON.stringify({ event: "research_shadow_collection_complete", summary: output.summary, errors: output.errors }));
    if (output.errors.length === MARKETS.length && ownsClient) process.exitCode = 1;
    return output;
  } finally {
    if (ownsClient) client.close();
  }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ event: "research_shadow_collector_failed", message: error.message })); process.exitCode = 1; });
module.exports = { MARKETS, FRAMES, normalizeCandles, newSignals, toAlert, main };
