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

const DATA_DIR = getDataDir();
// The 1-second products are part of this shared collector and use their canonical Deriv API symbol codes (not standard R_* aliases).
const MARKETS = Object.freeze([
  ["R_25", "Volatility 25 Index"], ["R_50", "Volatility 50 Index"],
  ["R_75", "Volatility 75 Index"], ["JD75", "Jump 75 Index"],
  ["JD100", "Jump 100 Index"], ["CRASH500", "Crash 500 Index"],
  ["BOOM500", "Boom 500 Index"], ["frxXAUUSD", "Gold (XAUUSD)"],
  ["1HZ10V", "Volatility 10 (1s) Index"],
  ["1HZ75V", "Volatility 75 (1s) Index"],
  ["R_100", "Volatility 100 Index"],
  ["JD25", "Jump 25 Index"],
  ["JD50", "Jump 50 Index"],
  ["CRASH100", "Crash 100 Index"],
  ["BOOM100", "Boom 100 Index"],
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
async function fetchFormingCandle(client, symbol, granularity, nowEpoch) {
  const response = await client.ask({
    ticks_history: symbol, adjust_start_time: 1, count: 2,
    end: "latest", granularity, style: "candles"
  });
  if (response.error) throw new Error(response.error.message || "Deriv forming-candle request failed");
  const lastClosedEpoch = Math.floor(nowEpoch / granularity) * granularity - granularity;
  const rows = (response.candles || []).map(c => ({
    epoch:Number(c.epoch), open:Number(c.open), high:Number(c.high),
    low:Number(c.low), close:Number(c.close)
  })).filter(c => [c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close));
  return rows.filter(c => c.epoch > lastClosedEpoch && c.epoch <= Math.floor(nowEpoch/granularity)*granularity)
    .sort((a,b) => a.epoch-b.epoch).at(-1) || null;
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
      (direction === "SELL" && !(stopLoss > entry && target < entry))) {
    if (marketData) {
      marketData.candidateDecisions ||= [];
      marketData.candidateDecisions.push({ signalId: String(signal.signalId || "unknown"), strategyId: strategy, decision: "rejected", reason: "invalid_signal_levels_or_direction" });
    }
    return null;
  }
  const tp1 = entry + sign * 1.5 * risk;
  const frames = marketData && marketData.timeframes || {};
  const regime = applyRegime
    ? evaluateMarketRegime({ m15: frames.M15 || [], m5: frames.M5 || [], direction, entryTimeframe: signal.entryTimeframe || "M5" })
    : { passed: true, adx: null, emaSeparationAtr: null };
  if (marketData) {
    if (applyRegime) {
      marketData.regimeFilterDecisions ||= [];
      marketData.regimeFilterDecisions.push({ signalId: String(signal.signalId), strategyId: strategy, direction, entryTimeframe: signal.entryTimeframe || "?", decision: regime.passed ? "passed" : "rejected", reason: regime.passed ? null : "market_regime_filter_rejected", ...regime });
    }
    marketData.candidateDecisions ||= [];
    marketData.candidateDecisions.push({
      signalId: String(signal.signalId), strategyId: strategy,
      decision: regime.passed ? "accepted" : "rejected",
      reason: regime.passed ? null : "market_regime_filter_rejected",
      regimeFilterApplied: applyRegime
    });
  }
  if (!regime.passed) return null;
  return {
    event: "new_signal", source: "RESEARCH_SHADOW", paper: true, live: false,
    marketMode: "LIVE_MARKET", executionMode: "DEMO_MANUAL",
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
    const output = { version: 1, generatedAt: new Date(now * 1000).toISOString(), cycleStatus: "running", markets: {}, errors: [] };
    for (const [marketId, marketName] of MARKETS) {
      const market = { marketId, marketName, timeframes: {}, errors: [] };
      for (const [tf, seconds, count] of FRAMES) {
        try {
          const symbol = symbols[marketId] || marketId;
          market.timeframes[tf] = await fetchCandles(client, symbol, seconds, count, now);
        } catch (error) { market.errors.push({ timeframe: tf, message: error.message }); }
      }
      output.markets[marketId] = market;
      if (market.errors.length) output.errors.push({ marketId, errors: market.errors });
    }

    // RB100 and RB200 are active expansion markets in forward-shadow scanning.
    const priorA = readJson(JOURNALS.breakoutM1, { version: 1, updatedAt: null, markets: {}, signals: [] });
    const priorB = readJson(JOURNALS.emaPullback, { version: 1, updatedAt: null, markets: {}, signals: [] });
    const priorC = readJson(JOURNALS.breakoutM5M15, { version: 1, updatedAt: null, markets: {}, signals: [] });
    const nextA = updateBreakoutRetestJournal(priorA, output.markets, now);
    const nextB = updateM5PullbackJournal(priorB, output.markets, now);
    const nextC = updateBreakoutM5M15Journal(priorC, output.markets, now);
    const delivery = readJson(JOURNALS.delivery, { version: 1, updatedAt: null, signals: {} });
    delivery.signals ||= {};
    const allCurrent = [
      ...nextA.signals.map(s => toAlert(s, "M5_BREAKOUT_M1_RETEST", output.markets[s.marketId], false)),
      ...nextB.signals.map(s => toAlert(s, "M15_M5_EMA_PULLBACK", output.markets[s.marketId], false)),
      ...nextC.signals.map(s => toAlert(s, "M5_BREAKOUT_M5_RETEST_M15_CONFIRM", output.markets[s.marketId], false))
    ].filter(Boolean);
    const freshSignals = [
      ...newSignals(priorA.signals, nextA.signals).map(signal => ({ signal, strategyId: "M5_BREAKOUT_M1_RETEST" })),
      ...newSignals(priorB.signals, nextB.signals).map(signal => ({ signal, strategyId: "M15_M5_EMA_PULLBACK" })),
      ...newSignals(priorC.signals, nextC.signals).map(signal => ({ signal, strategyId: "M5_BREAKOUT_M5_RETEST_M15_CONFIRM" }))
    ];
    for (const { signal } of freshSignals) {
      const market = output.markets[signal.marketId];
      if (market) market.newStrategyObservations = (market.newStrategyObservations || 0) + 1;
    }
    const fresh = freshSignals.map(({ signal, strategyId }) =>
      toAlert(signal, strategyId, output.markets[signal.marketId])
    ).filter(Boolean);
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
    output.cycleStatus = output.errors.length ? "partial" : "success";
    output.summary = {
      markets: Object.keys(output.markets).length,
      newStrategyObservations: freshSignals.length,
      eligibleNewCandidates: fresh.length,
      newCandidates: candidates.length, telegramSent: sent, telegramFailed: failed,
      strategies: {
        breakoutM1: nextA.summary || null,
        emaPullback: nextB.summary || null,
        breakoutM5M15: nextC.summary || null
      },
      activeExpansionMarkets: ["1HZ10V", "1HZ75V", "R_100", "JD75", "JD25", "JD50", "CRASH100", "BOOM100"],
      r10Excluded: true, mtfEnabled: false, mt5ExecutionEnabled: false
    };
    const regimeJournal = { version: 1, generatedAt: output.generatedAt, mode: "shadow_only", productionGateEnabled: false, markets: Object.fromEntries(Object.entries(output.markets).map(([id, market]) => [id, { decisions: market.regimeFilterDecisions || [] }])) };
    const regimeDecisions = Object.values(regimeJournal.markets).flatMap(x => x.decisions);
    const candidateDecisions = Object.values(output.markets).flatMap(m => m.candidateDecisions || []);
    const deliveryRecords = Object.values(delivery.signals);
    const strategyJournals = [
      ["M5_BREAKOUT_M1_RETEST", nextA],
      ["M15_M5_EMA_PULLBACK", nextB],
      ["M5_BREAKOUT_M5_RETEST_M15_CONFIRM", nextC]
    ];
    for (const [marketId, market] of Object.entries(output.markets)) {
      const timeframeHealth = Object.fromEntries(FRAMES.map(([tf]) => [tf, {
        candles: (market.timeframes[tf] || []).length,
        status: market.errors.some(error => error.timeframe === tf) ? "error" : ((market.timeframes[tf] || []).length ? "ok" : "empty")
      }]));
      const strategyStats = Object.fromEntries(strategyJournals.map(([strategyId, journal]) => {
        const stats = journal.summary?.markets?.[marketId] || {};
        return [strategyId, {
          setupsDetected: stats.setupsDetected ?? null,
          signalsGenerated: stats.signals ?? 0,
          riskRejected: stats.riskRejected ?? 0,
          overlapSuppressed: stats.overlapSuppressed ?? 0,
          confirmationExpired: stats.confirmationExpired ?? 0,
          targetBeforeStop: stats.targetBeforeStop ?? 0,
          stopBeforeTarget: stats.stopBeforeTarget ?? 0,
          timeExit: stats.timeExit ?? 0,
          averageRealizedR: stats.averageRealizedR ?? null
        }];
      }));
      const marketDeliveries = deliveryRecords.filter(record => record.marketId === marketId);
      const marketDecisions = candidateDecisions.filter(record => {
        const source = [nextA, nextB, nextC].find(journal => journal.signals.some(signal => signal.signalId === record.signalId));
        return source?.signals.some(signal => signal.marketId === marketId && signal.signalId === record.signalId);
      });
      market.diagnostics = {
        scanStatus: market.errors.length ? (FRAMES.every(([tf]) => market.errors.some(error => error.timeframe === tf)) ? "failed" : "partial") : "success",
        timeframes: timeframeHealth,
        strategies: strategyStats,
        signalPipeline: {
          newStrategyObservations: market.newStrategyObservations || 0,
          eligibleCandidates: fresh.filter(alert => alert.marketId === marketId).length,
          deliveryCandidates: candidates.filter(alert => alert.marketId === marketId).length,
          telegramSentThisCycle: candidates.filter(alert => alert.marketId === marketId && delivery.signals[alert.signalId]?.status === "sent" && delivery.signals[alert.signalId]?.sentAt && new Date(delivery.signals[alert.signalId].sentAt).getTime() >= now * 1000).length,
          telegramFailedThisCycle: candidates.filter(alert => alert.marketId === marketId && delivery.signals[alert.signalId]?.status === "failed" && delivery.signals[alert.signalId]?.lastAttemptAt === new Date(now * 1000).toISOString()).length
        },
        candidateDecisions: {
          accepted: marketDecisions.filter(record => record.decision === "accepted").length,
          rejected: marketDecisions.filter(record => record.decision === "rejected").length,
          rejectionReasons: marketDecisions.filter(record => record.decision === "rejected").reduce((acc, record) => {
            const reason = record.reason || "unspecified";
            acc[reason] = (acc[reason] || 0) + 1;
            return acc;
          }, {})
        },
        telegram: {
          tracked: marketDeliveries.length,
          sent: marketDeliveries.filter(record => record.status === "sent").length,
          failed: marketDeliveries.filter(record => record.status === "failed").length,
          pending: marketDeliveries.filter(record => record.status === "pending").length,
          lastSentAt: marketDeliveries.filter(record => record.status === "sent").map(record => record.sentAt).sort().at(-1) || null
        }
      };
    }
    output.summary.marketRegime = {
      candidatesEvaluated: regimeDecisions.length,
      passed: regimeDecisions.filter(x => x.passed).length,
      rejected: regimeDecisions.filter(x => !x.passed).length,
      rejectionReasons: regimeDecisions.filter(x => !x.passed).reduce((acc, record) => {
        const reason = record.reason || "unspecified";
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
      productionSignalsChanged: false
    };
    output.summary.candidateDiagnostics = {
      accepted: candidateDecisions.filter(record => record.decision === "accepted").length,
      rejected: candidateDecisions.filter(record => record.decision === "rejected").length,
      rejectionReasons: candidateDecisions.filter(record => record.decision === "rejected").reduce((acc, record) => {
        const reason = record.reason || "unspecified";
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
      deliveryRecords: deliveryRecords.length,
      confirmedTelegramSends: deliveryRecords.filter(record => record.status === "sent").length,
      failedTelegramDeliveries: deliveryRecords.filter(record => record.status === "failed").length,
      pendingTelegramDeliveries: deliveryRecords.filter(record => record.status === "pending").length
    };
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
