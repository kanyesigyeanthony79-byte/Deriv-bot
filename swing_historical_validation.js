"use strict";
// Historical swing-entry replay. Development-only, read-only market data.
// No Telegram calls, orders, or production files are modified.
const fs = require("node:fs");
const path = require("node:path");
const { evaluateCategory, validCandles, TIMEFRAMES, cooldownAllows } = require("./multi_timeframe_engine");
const { validateCandleContinuity } = require("./market_quality");
const { evaluateRefinedSwing } = require("./swing_h4_d1_m15_m5");
const { evaluateSwingReversalSniper } = require("./swing_reversal_sniper");
const { simulateFixedPlanOutcome, simulateManagedOutcome, summarizeManaged } = require("./swing_trade_management_replay");
const { diagnoseTradePath } = require("./swing_trade_management_diagnostics");

const PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public";
// Initial historical validation focuses on Volatility 25, the instrument
// from the user's losing swing-entry example. Expand only after this replay is sound.
const MARKETS = [
  ["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"],
  ["R_50", "Volatility 50 Index"], ["R_75", "Volatility 75 Index"],
  ["JD100", "Jump 100 Index"], ["frxXAUUSD", "Gold/USD"],
  ["CRASH500", "Crash 500 Index"], ["BOOM500", "Boom 500 Index"]
];
const REQUESTS = [["M5", 300, 25000], ["M15", 900, 8000], ["H1", 3600, 2000], ["H4", 14400, 600], ["D1", 86400, 180]];
const MAX_HOLD_SECONDS = 7 * 86400;
const REQUEST_SPACING_MS = 200;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_HOLD_BARS = MAX_HOLD_SECONDS / TIMEFRAMES.M5;

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function resolveSymbol(list, fallback, name) {
  const found = list.find(x => normalize(x.underlying_symbol_name || x.display_name) === normalize(name)) ||
    list.find(x => (x.underlying_symbol || x.symbol) === fallback);
  return found ? (found.underlying_symbol || found.symbol) : null;
}
function normalizeCandles(raw, granularity, now) {
  const candles = (raw || []).map(c => ({
    epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high),
    low: Number(c.low), close: Number(c.close)
  })).filter(c => [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.epoch - b.epoch)
    .filter(c => c.epoch + granularity <= now);
  return validCandles(candles) ? candles : [];
}

// Split history at every missing interval. Never let the replay engine bridge a gap.
function continuousSegments(candles, granularity) {
  if (!Array.isArray(candles) || !candles.length) return [];
  const segments = [];
  let start = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].epoch - candles[i - 1].epoch > granularity * 1.5) {
      segments.push(candles.slice(start, i));
      start = i;
    }
  }
  segments.push(candles.slice(start));
  return segments;
}
function latestContinuousSegment(candles, granularity) {
  const segments = continuousSegments(candles, granularity);
  return segments[segments.length - 1] || [];
}

// Conservative barrier replay: if SL and TP1 are both touched in one M5
// candle, their order is unknowable and the trade is marked ambiguous.
function simulateOutcome(signal, candles, signalIndex, horizonBars = MAX_HOLD_BARS) {
  const end = signalIndex + horizonBars;
  if (end >= candles.length) return { status: "incomplete_window" };
  let tp1Seen = false;
  for (let i = signalIndex + 1; i <= end; i++) {
    const c = candles[i];
    const stop = signal.direction === "BUY" ? c.low <= signal.stopLoss : c.high >= signal.stopLoss;
    const tp1 = signal.direction === "BUY" ? c.high >= signal.tp1 : c.low <= signal.tp1;
    const tp2 = signal.direction === "BUY" ? c.high >= signal.tp2 : c.low <= signal.tp2;
    if (!tp1Seen) {
      if (stop && tp1) return { status: "ambiguous_sl_tp1_same_candle", barsHeld: i - signalIndex };
      if (stop) return { status: "stop_before_tp1", barsHeld: i - signalIndex };
      if (tp1) {
        tp1Seen = true;
        if (tp2) return { status: "tp2_after_tp1", barsHeld: i - signalIndex };
      }
    } else {
      if (stop && tp2) return { status: "ambiguous_sl_tp2_same_candle", barsHeld: i - signalIndex };
      if (tp2) return { status: "tp2_after_tp1", barsHeld: i - signalIndex };
      if (stop) return { status: "stop_after_tp1", barsHeld: i - signalIndex };
    }
  }
  return { status: tp1Seen ? "tp1_only_by_horizon" : "no_barrier_by_horizon", barsHeld: horizonBars };
}

function summarizeTradeDiagnostics(results) {
  const measured = results.map(x => x.pathDiagnostics).filter(x => x && x.diagnosticStatus === "measured");
  const average = key => {
    const values = measured.map(x => x[key]).filter(Number.isFinite);
    return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)) : null;
  };
  const early = measured.map(x => x.afterEarlyExit).filter(Boolean);
  return {
    measuredSignals: measured.length,
    averageMaxFavorableR: average("maxFavorableR"),
    averageMaxAdverseR: average("maxAdverseR"),
    averageTimeTo1RBars: average("timeTo1RBars"),
    averagePeakToExitGivebackR: average("peakToExitGivebackR"),
    earlyExitCounterfactuals: early.length,
    earlyExitLaterReachedTP1: early.filter(x => x.reachedOriginalTP1).length,
    earlyExitLaterReachedTP2: early.filter(x => x.reachedOriginalTP2).length,
    earlyExitLaterReachedOriginalStop: early.filter(x => x.reachedOriginalStop).length,
    earlyExitFullHorizonObserved: early.filter(x => x.fullHorizonObserved).length
  };
}

function summarize(results) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const resolved = results.filter(r => r.status !== "incomplete_window");
  const tp1Reached = (counts.tp1_only_by_horizon || 0) + (counts.tp2_after_tp1 || 0) +
    (counts.stop_after_tp1 || 0) + (counts.ambiguous_sl_tp2_same_candle || 0);
  const tp2Reached = counts.tp2_after_tp1 || 0;
  return {
    signals: results.length,
    resolvedSignals: resolved.length,
    outcomes: counts,
    tp1Reached,
    tp1RateAmongResolved: resolved.length ? Number((tp1Reached / resolved.length).toFixed(4)) : null,
    tp2Reached,
    tp2RateAmongTp1Reached: tp1Reached ? Number((tp2Reached / tp1Reached).toFixed(4)) : null
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Connection timed out")); }, 15000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      let nextId = 0;
      const pending = new Map();
      ws.addEventListener("message", ev => {
        let data;
        try { data = JSON.parse(String(ev.data)); } catch { return; }
        const item = pending.get(data.req_id);
        if (!item) return;
        pending.delete(data.req_id);
        clearTimeout(item.timer);
        if (data.error) item.reject(new Error(data.error.message || "Deriv API error"));
        else item.resolve(data);
      });
      ws.addEventListener("close", () => {
        for (const [id, item] of pending) {
          clearTimeout(item.timer);
          item.reject(new Error("WebSocket closed before response"));
          pending.delete(id);
        }
      });
      resolve({
        ask(payload, timeoutMs = 30000) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error("Request timed out")); }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection error")); }, { once: true });
  });
}

async function fetchHistory(client, symbol, granularity, requestedCount, now) {
  const byEpoch = new Map();
  let end = "latest";
  let pages = 0;
  while (byEpoch.size < requestedCount && pages < 32) {
    const remaining = requestedCount - byEpoch.size;
    const count = Math.min(999, remaining);
    const reply = await client.ask({
      ticks_history: symbol, adjust_start_time: 1, count,
      end, granularity, style: "candles"
    });
    // Space every paginated request, not just each timeframe, to avoid bursts.
    await new Promise(resolve => setTimeout(resolve, REQUEST_SPACING_MS));
    const batch = normalizeCandles(reply.candles, granularity, now);
    if (!batch.length) break;
    const previousSize = byEpoch.size;
    for (const candle of batch) byEpoch.set(candle.epoch, candle);
    if (byEpoch.size === previousSize) break;
    const oldest = batch[0].epoch;
    const nextEnd = oldest + granularity;
    if (typeof end === "number" && nextEnd >= end) break;
    end = nextEnd;
    pages++;
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch).slice(-requestedCount);
}

async function fetchMarket(symbol, now, maxAttempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client;
    try {
      // A fresh socket per market avoids relying on one connection for the full replay.
      client = await connect(PUBLIC);
      const frames = {};
      for (const [tf, granularity, count] of REQUESTS) {
        frames[tf] = await fetchHistory(client, symbol, granularity, count, now);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return frames;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const backoff = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * 250);
        await new Promise(resolve => setTimeout(resolve, backoff + jitter));
      }
    } finally {
      if (client) client.close();
    }
  }
  throw new Error("Market history failed after " + maxAttempts + " attempts: " + (lastError?.message || "unknown error"));
}

async function run() {
  const metadataClient = await connect(PUBLIC);
  let now;
  let symbols;
  try {
    const timeReply = await metadataClient.ask({ time: 1 });
    now = Number(timeReply.time) || Math.floor(Date.now() / 1000);
    symbols = (await metadataClient.ask({ active_symbols: "brief" })).active_symbols || [];
    const missing = MARKETS.some(([id, name]) => !resolveSymbol(symbols, id, name));
    if (missing) symbols = [...symbols, ...((await metadataClient.ask({ active_symbols: "full" })).active_symbols || [])];
  } finally {
    metadataClient.close();
  }

    const report = {
      generatedAt: new Date(now * 1000).toISOString(),
      mode: "historical_read_only_replay",
      methodology: {
        entry: "M5 completed candle close",
        setupAndFilters: "Paired baseline and experimental H4/D1 trend, H1 setup, M15 confirmation, M5 trigger; all higher-timeframe candles completed by entry close",
        comparison: "Both strategies use the same market candle snapshot, M5 entry index, four-entry-bar cooldown, and seven-day outcome horizon",
        forwardHorizon: "7 days",
        intendedLookback: "Approximately 80 days, subject to Deriv API history availability",
        barrierHandling: "Same-candle SL/TP contact is marked ambiguous; no assumed intrabar order",
        caveat: "Descriptive historical replay, not a guarantee of future performance; no fees/slippage model"
      },
      requestedHistory: Object.fromEntries(REQUESTS.map(([tf,,count]) => [tf,count])),
      markets: {},
      errors: []
    };

    for (const [marketId, marketName] of MARKETS) {
      if (marketId === "frxXAUUSD") {
        report.markets[marketId] = { marketName, status: "deferred_until_2026-11-16", reason: "Gold collection is deferred until the agreed Monday review." };
        continue;
      }
      const symbol = resolveSymbol(symbols, marketId, marketName);
      if (!symbol) {
        report.errors.push({ marketId, error: "Symbol could not be resolved" });
        continue;
      }
      try {
        const fetchedFrames = await fetchMarket(symbol, now, 2);
        const continuity = {};
        const minimumBars = { M5: MAX_HOLD_BARS + 65, M15: 60, H1: 65, H4: 51, D1: 60 };
        const m5Segments = [];
        const frames = {};
        let dataReady = true;
        for (const [tf, granularity] of REQUESTS) {
          const fetched = fetchedFrames[tf] || [];
          const check = validateCandleContinuity(fetched, granularity, marketId);
          const segments = continuousSegments(fetched, granularity);
          const usable = segments.filter(segment => validCandles(segment) && segment.length >= minimumBars[tf]);
          continuity[tf] = {
            fetchedCandles: fetched.length, continuousSegments: segments.length,
            usableSegments: usable.length, usableCandleCounts: usable.map(segment => segment.length),
            valid: usable.length > 0, gapsInFetchedHistory: check.gaps?.length || 0,
            gapSamples: (check.gaps || []).slice(0, 3)
          };
          if (tf === "M5") m5Segments.push(...usable);
          else frames[tf] = usable[usable.length - 1] || [];
          if (!usable.length) dataReady = false;
        }
        if (!dataReady || !m5Segments.length) {
          report.markets[marketId] = { marketName, symbol, status: "insufficient_or_discontinuous_data", continuity };
          continue;
        }

        const outcomes = [];
        const states = {};
        const refinedOutcomes = [];
        const refinedStates = {};
        const sniperOutcomes = [];
        const sniperStates = {};
        const fixedPlanOutcomes = [];
        const refinedFixedPlanOutcomes = [];
        const managedOutcomes = [];
        const refinedManagedOutcomes = [];
        let replayedM5Bars = 0;
        for (const m5 of m5Segments) {
          let lastSignalIndex = null;
          let lastRefinedSignalIndex = null;
          let lastSniperSignalIndex = null;
          const lastMatureIndex = m5.length - MAX_HOLD_BARS - 1;
          replayedM5Bars += Math.max(0, lastMatureIndex - 63);
          const segmentFrames = { ...frames, M5: m5 };
          for (let i = 64; i <= lastMatureIndex; i++) {
            const signal = evaluateCategory(marketId, marketName, "SWING", segmentFrames, i);
            states[signal.state] = (states[signal.state] || 0) + 1;
            if (signal.state === "signal" && cooldownAllows(lastSignalIndex, i, 4)) {
              lastSignalIndex = i;
              const outcome = simulateOutcome(signal, m5, i);
              outcomes.push({
                signalId: signal.signalId, direction: signal.direction,
                signalTime: new Date(signal.candleEpoch * 1000).toISOString(),
                entry: signal.entry, stopLoss: signal.stopLoss, tp1: signal.tp1, tp2: signal.tp2,
                ...outcome
              });
              const fixedResult = simulateFixedPlanOutcome(signal, segmentFrames, i);
              fixedPlanOutcomes.push({
                signalId: signal.signalId, direction: signal.direction,
                signalTime: new Date(signal.candleEpoch * 1000).toISOString(),
                ...fixedResult,
                pathDiagnostics: diagnoseTradePath(signal, m5, i, fixedResult)
              });
              const managedResult = simulateManagedOutcome(signal, segmentFrames, i);
              managedOutcomes.push({
                signalId: signal.signalId, direction: signal.direction,
                signalTime: new Date(signal.candleEpoch * 1000).toISOString(),
                ...managedResult,
                pathDiagnostics: diagnoseTradePath(signal, m5, i, managedResult)
              });
            }

            const sniper = evaluateSwingReversalSniper(marketId, marketName, segmentFrames, i);
            sniperStates[sniper.state] = (sniperStates[sniper.state] || 0) + 1;
            if (sniper.state === "signal" && cooldownAllows(lastSniperSignalIndex, i, 4)) {
              lastSniperSignalIndex = i;
              const sniperOutcome = simulateOutcome(sniper, m5, i);
              const sniperFixedResult = simulateFixedPlanOutcome(sniper, segmentFrames, i);
              const sniperManagedResult = simulateManagedOutcome(sniper, segmentFrames, i);
              sniperOutcomes.push({
                signalId: sniper.signalId, direction: sniper.direction,
                signalTime: new Date(sniper.candleEpoch * 1000).toISOString(),
                entry: sniper.entry, stopLoss: sniper.stopLoss, tp1: sniper.tp1, tp2: sniper.tp2,
                ...sniperOutcome,
                fixedPlan: sniperFixedResult,
                managed: sniperManagedResult,
                pathDiagnostics: diagnoseTradePath(sniper, m5, i, sniperManagedResult)
              });
            }

            const refined = evaluateRefinedSwing(marketId, marketName, segmentFrames, i);
            refinedStates[refined.state] = (refinedStates[refined.state] || 0) + 1;
            if (refined.state === "signal" && cooldownAllows(lastRefinedSignalIndex, i, 4)) {
              lastRefinedSignalIndex = i;
              const refinedOutcome = simulateOutcome(refined, m5, i);
              refinedOutcomes.push({
                signalId: refined.signalId, direction: refined.direction,
                signalTime: new Date(refined.candleEpoch * 1000).toISOString(),
                entry: refined.entry, stopLoss: refined.stopLoss, tp1: refined.tp1, tp2: refined.tp2,
                ...refinedOutcome
              });
              const refinedFixedResult = simulateFixedPlanOutcome(refined, segmentFrames, i);
              refinedFixedPlanOutcomes.push({
                signalId: refined.signalId, direction: refined.direction,
                signalTime: new Date(refined.candleEpoch * 1000).toISOString(),
                ...refinedFixedResult,
                pathDiagnostics: diagnoseTradePath(refined, m5, i, refinedFixedResult)
              });
              const refinedManagedResult = simulateManagedOutcome(refined, segmentFrames, i);
              refinedManagedOutcomes.push({
                signalId: refined.signalId, direction: refined.direction,
                signalTime: new Date(refined.candleEpoch * 1000).toISOString(),
                ...refinedManagedResult,
                pathDiagnostics: diagnoseTradePath(refined, m5, i, refinedManagedResult)
              });
            }
          }
        }
        report.markets[marketId] = {
          marketName, symbol, status: "completed",
          history: continuity,
          replayedM5Bars,
          stateCounts: states,
          performance: summarize(outcomes),
          signals: outcomes,
          refinedStateCounts: refinedStates,
          sniperStateCounts: sniperStates,
          sniperPerformance: summarize(sniperOutcomes),
          sniperSignals: sniperOutcomes,
          refinedPerformance: summarize(refinedOutcomes),
          refinedSignals: refinedOutcomes,
          fixedPlanPerformance: summarizeManaged(fixedPlanOutcomes),
          fixedPlanDiagnostics: summarizeTradeDiagnostics(fixedPlanOutcomes),
          fixedPlanSignals: fixedPlanOutcomes,
          refinedFixedPlanPerformance: summarizeManaged(refinedFixedPlanOutcomes),
          refinedFixedPlanDiagnostics: summarizeTradeDiagnostics(refinedFixedPlanOutcomes),
          refinedFixedPlanSignals: refinedFixedPlanOutcomes,
          managedPerformance: summarizeManaged(managedOutcomes),
          managedDiagnostics: summarizeTradeDiagnostics(managedOutcomes),
          managedSignals: managedOutcomes,
          refinedManagedPerformance: summarizeManaged(refinedManagedOutcomes),
          refinedManagedDiagnostics: summarizeTradeDiagnostics(refinedManagedOutcomes),
          refinedManagedSignals: refinedManagedOutcomes
        };
      } catch (error) {
        report.markets[marketId] = { marketName, symbol, status: "collection_or_replay_error", error: error.message };
        report.errors.push({ marketId, error: error.message });
      }
    }

    const totals = Object.values(report.markets).filter(m => m.performance);
    const refinedTotals = Object.values(report.markets).filter(m => m.refinedPerformance);
    const sniperTotals = Object.values(report.markets).filter(m => m.sniperPerformance);
    const fixedPlanTotals = Object.values(report.markets).filter(m => m.fixedPlanPerformance);
    const refinedFixedPlanTotals = Object.values(report.markets).filter(m => m.refinedFixedPlanPerformance);
    const managedTotals = Object.values(report.markets).filter(m => m.managedPerformance);
    const refinedManagedTotals = Object.values(report.markets).filter(m => m.refinedManagedPerformance);
    const baselineKeys = new Set(totals.flatMap(m => m.signals.map(x => x.signalTime + "|" + x.direction)));
    const refinedKeys = new Set(refinedTotals.flatMap(m => m.refinedSignals.map(x => x.signalTime + "|" + x.direction)));
    const overlap = [...baselineKeys].filter(key => refinedKeys.has(key)).length;
    report.comparison = {
      baselineSignals: [...baselineKeys].length,
      refinedSignals: [...refinedKeys].length,
      exactTimeAndDirectionOverlap: overlap,
      baselineOnly: [...baselineKeys].filter(key => !refinedKeys.has(key)).length,
      refinedOnly: [...refinedKeys].filter(key => !baselineKeys.has(key)).length,
      note: "Signal overlap is descriptive; different signal frequencies do not establish better performance."
    };
    report.summary = {
      marketsRequested: MARKETS.length,
      marketsCompleted: totals.length,
      marketsSkipped: MARKETS.length - totals.length,
      totalSignals: totals.reduce((n, m) => n + m.performance.signals, 0),
      totalResolvedSignals: totals.reduce((n, m) => n + m.performance.resolvedSignals, 0),
      refinedSignals: refinedTotals.reduce((n, m) => n + m.refinedPerformance.signals, 0),
      sniperSignals: sniperTotals.reduce((n, m) => n + m.sniperPerformance.signals, 0),
      sniperResolvedSignals: sniperTotals.reduce((n, m) => n + m.sniperPerformance.resolvedSignals, 0),
      sniperOutcomeCounts: sniperTotals.reduce((acc, m) => { for (const [k,v] of Object.entries(m.sniperPerformance.outcomes)) acc[k] = (acc[k] || 0) + v; return acc; }, {}),
      sniperAverageRealizedR: sniperTotals.flatMap(m => m.sniperSignals).filter(x => Number.isFinite(x.managed?.realizedR)).length
        ? Number((sniperTotals.flatMap(m => m.sniperSignals).filter(x => Number.isFinite(x.managed?.realizedR)).reduce((sum, x) => sum + x.managed.realizedR, 0) / sniperTotals.flatMap(m => m.sniperSignals).filter(x => Number.isFinite(x.managed?.realizedR)).length).toFixed(4)) : null,
      refinedResolvedSignals: refinedTotals.reduce((n, m) => n + m.refinedPerformance.resolvedSignals, 0),
      fixedPlanSignals: fixedPlanTotals.reduce((n, m) => n + m.fixedPlanPerformance.signals, 0),
      refinedFixedPlanSignals: refinedFixedPlanTotals.reduce((n, m) => n + m.refinedFixedPlanPerformance.signals, 0),
      managedSignals: managedTotals.reduce((n, m) => n + m.managedPerformance.signals, 0),
      managedScoredSignals: managedTotals.reduce((n, m) => n + m.managedPerformance.scoredSignals, 0),
      refinedManagedSignals: refinedManagedTotals.reduce((n, m) => n + m.refinedManagedPerformance.signals, 0),
      refinedManagedScoredSignals: refinedManagedTotals.reduce((n, m) => n + m.refinedManagedPerformance.scoredSignals, 0),
      outcomeCounts: totals.reduce((acc, m) => {
        for (const [k,v] of Object.entries(m.performance.outcomes)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
      refinedOutcomeCounts: refinedTotals.reduce((acc, m) => {
        for (const [k,v] of Object.entries(m.refinedPerformance.outcomes)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
      fixedPlanOutcomeCounts: fixedPlanTotals.reduce((acc, m) => {
        for (const [k,v] of Object.entries(m.fixedPlanPerformance.outcomes)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
      refinedFixedPlanOutcomeCounts: refinedFixedPlanTotals.reduce((acc, m) => {
        for (const [k,v] of Object.entries(m.refinedFixedPlanPerformance.outcomes)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
      managedOutcomeCounts: managedTotals.reduce((acc, m) => {
        for (const [k,v] of Object.entries(m.managedPerformance.outcomes)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
      refinedManagedOutcomeCounts: refinedManagedTotals.reduce((acc, m) => {
        for (const [k,v] of Object.entries(m.refinedManagedPerformance.outcomes)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
      fixedPlanAverageRealizedR: fixedPlanTotals.flatMap(m => m.fixedPlanSignals).filter(x => Number.isFinite(x.realizedR)).length
        ? Number((fixedPlanTotals.flatMap(m => m.fixedPlanSignals).filter(x => Number.isFinite(x.realizedR)).reduce((sum, x) => sum + x.realizedR, 0) / fixedPlanTotals.flatMap(m => m.fixedPlanSignals).filter(x => Number.isFinite(x.realizedR)).length).toFixed(4)) : null,
      refinedFixedPlanAverageRealizedR: refinedFixedPlanTotals.flatMap(m => m.refinedFixedPlanSignals).filter(x => Number.isFinite(x.realizedR)).length
        ? Number((refinedFixedPlanTotals.flatMap(m => m.refinedFixedPlanSignals).filter(x => Number.isFinite(x.realizedR)).reduce((sum, x) => sum + x.realizedR, 0) / refinedFixedPlanTotals.flatMap(m => m.refinedFixedPlanSignals).filter(x => Number.isFinite(x.realizedR)).length).toFixed(4)) : null,
      managedAverageRealizedR: managedTotals.flatMap(m => m.managedSignals).filter(x => Number.isFinite(x.realizedR)).length
        ? Number((managedTotals.flatMap(m => m.managedSignals).filter(x => Number.isFinite(x.realizedR)).reduce((sum, x) => sum + x.realizedR, 0) / managedTotals.flatMap(m => m.managedSignals).filter(x => Number.isFinite(x.realizedR)).length).toFixed(4)) : null,
      refinedManagedAverageRealizedR: refinedManagedTotals.flatMap(m => m.refinedManagedSignals).filter(x => Number.isFinite(x.realizedR)).length
        ? Number((refinedManagedTotals.flatMap(m => m.refinedManagedSignals).filter(x => Number.isFinite(x.realizedR)).reduce((sum, x) => sum + x.realizedR, 0) / refinedManagedTotals.flatMap(m => m.refinedManagedSignals).filter(x => Number.isFinite(x.realizedR)).length).toFixed(4)) : null,
      errors: report.errors.length
    };
    fs.writeFileSync(path.join(__dirname, "swing_historical_validation.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ event: "historical_replay_complete", summary: report.summary, markets: Object.fromEntries(Object.entries(report.markets).map(([k,v]) => [k, {status:v.status, replayedM5Bars:v.replayedM5Bars, signals:v.performance?.signals, outcomes:v.performance?.outcomes, fixedPlan:v.fixedPlanPerformance, refinedFixedPlan:v.refinedFixedPlanPerformance, managed:v.managedPerformance, refinedManaged:v.refinedManagedPerformance, stateCounts:v.stateCounts, history:v.history || v.continuity}])) }));
    if (totals.length === 0) process.exitCode = 1;
}

if (require.main === module) run().catch(error => { console.error(JSON.stringify({ event: "historical_replay_failed", message: error.message })); process.exitCode = 1; });
module.exports = { simulateOutcome, summarize, latestContinuousSegment, continuousSegments };
