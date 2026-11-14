"use strict";
// Historical swing-entry replay. Development-only, read-only market data.
// No Telegram calls, orders, or production files are modified.
const fs = require("node:fs");
const path = require("node:path");
const { evaluateCategory, validCandles, TIMEFRAMES, cooldownAllows } = require("./multi_timeframe_engine");
const { validateCandleContinuity } = require("./market_quality");

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
        setupAndFilters: "Existing staged swing engine with M15/H1/H4/D1 completed-candle cutoffs",
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
        let replayedM5Bars = 0;
        for (const m5 of m5Segments) {
          let lastSignalIndex = null;
          const lastMatureIndex = m5.length - MAX_HOLD_BARS - 1;
          replayedM5Bars += Math.max(0, lastMatureIndex - 63);
          const segmentFrames = { ...frames, M5: m5 };
          for (let i = 64; i <= lastMatureIndex; i++) {
            const signal = evaluateCategory(marketId, marketName, "SWING", segmentFrames, i);
            states[signal.state] = (states[signal.state] || 0) + 1;
            if (signal.state !== "signal" || !cooldownAllows(lastSignalIndex, i, 4)) continue;
            lastSignalIndex = i;
            const outcome = simulateOutcome(signal, m5, i);
            outcomes.push({
              signalId: signal.signalId, direction: signal.direction,
              signalTime: new Date(signal.candleEpoch * 1000).toISOString(),
              entry: signal.entry, stopLoss: signal.stopLoss, tp1: signal.tp1, tp2: signal.tp2,
              ...outcome
            });
          }
        }
        report.markets[marketId] = {
          marketName, symbol, status: "completed",
          history: continuity,
          replayedM5Bars,
          stateCounts: states,
          performance: summarize(outcomes),
          signals: outcomes
        };
      } catch (error) {
        report.markets[marketId] = { marketName, symbol, status: "collection_or_replay_error", error: error.message };
        report.errors.push({ marketId, error: error.message });
      }
    }

    const totals = Object.values(report.markets).filter(m => m.performance);
    report.summary = {
      marketsRequested: MARKETS.length,
      marketsCompleted: totals.length,
      marketsSkipped: MARKETS.length - totals.length,
      totalSignals: totals.reduce((n, m) => n + m.performance.signals, 0),
      totalResolvedSignals: totals.reduce((n, m) => n + m.performance.resolvedSignals, 0),
      outcomeCounts: totals.reduce((acc, m) => {
        for (const [k,v] of Object.entries(m.performance.outcomes)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
      errors: report.errors.length
    };
    fs.writeFileSync(path.join(__dirname, "swing_historical_validation.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ event: "historical_replay_complete", summary: report.summary, markets: Object.fromEntries(Object.entries(report.markets).map(([k,v]) => [k, {status:v.status, replayedM5Bars:v.replayedM5Bars, signals:v.performance?.signals, outcomes:v.performance?.outcomes, stateCounts:v.stateCounts, history:v.history || v.continuity}])) }));
    if (totals.length === 0) process.exitCode = 1;
}

if (require.main === module) run().catch(error => { console.error(JSON.stringify({ event: "historical_replay_failed", message: error.message })); process.exitCode = 1; });
module.exports = { simulateOutcome, summarize, latestContinuousSegment, continuousSegments };
