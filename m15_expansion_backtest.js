"use strict";

// Offline/research-only M15 replay for proposed expansion markets.
// This module fetches public Deriv candles, evaluates the existing M15 engine,
// and resolves paper outcomes. It never calls Telegram, places orders, or
// mutates the production trade journal.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getDataDir } = require("./scanner_data_dir");
const { evaluate, DEF } = require("./engine");

const PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const TIMEFRAME_SECONDS = 900;
const WARMUP_CANDLES = 65;
const DEFAULT_DAYS = 180;
const DEFAULT_HORIZON_CANDLES = 96; // 24 hours on M15
const DEFAULT_COOLDOWN_CANDLES = DEF.cooldown;
const REQUEST_GAP_MS = 1200;
const PAGE_SIZE = 1000;
const RATE_LIMIT_RETRIES = 3;
const STOP_ATR = 1.5;
const TP1_R = 2;
const TP2_R = 3;
const MARKETS = Object.freeze([
  ["R_100", "Volatility 100 Index"],
  ["JD25", "Jump 25 Index"],
  ["JD50", "Jump 50 Index"],
  ["RB100", "Range Break 100 Index"],
  ["RB200", "Range Break 200 Index"],
  ["BOOM100", "Boom 100 Index"],
  ["CRASH100", "Crash 100 Index"]
]);

function connect(url = PUBLIC_WS) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("This backtest requires a Node.js runtime with global WebSocket support (Node.js 22+)."));
      return;
    }
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Deriv WebSocket connection timed out"));
    }, 15000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      let nextId = 0;
      const pending = new Map();
      ws.addEventListener("message", event => {
        let payload;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        const waiter = pending.get(payload.req_id);
        if (!waiter) return;
        pending.delete(payload.req_id);
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
      });
      ws.addEventListener("close", () => {
        for (const [id, waiter] of pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Deriv WebSocket closed before reply"));
          pending.delete(id);
        }
      });
      resolve({
        ask(payload, timeoutMs = 20000) {
          return new Promise((res, rej) => {
            const reqId = ++nextId;
            const requestTimer = setTimeout(() => {
              pending.delete(reqId);
              rej(new Error("Deriv request timed out"));
            }, timeoutMs);
            pending.set(reqId, { resolve: res, reject: rej, timer: requestTimer });
            ws.send(JSON.stringify({ ...payload, req_id: reqId }));
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

function validCandle(c) {
  return c && [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
}

function normalizeCandles(rows) {
  const byEpoch = new Map();
  for (const row of rows || []) {
    const candle = {
      epoch: Number(row.epoch), open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close)
    };
    if (validCandle(candle)) byEpoch.set(candle.epoch, candle);
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

// A candle is eligible only when its full 15-minute interval ended by endEpoch.
function filterClosedCandles(candles, endEpoch, timeframe = TIMEFRAME_SECONDS) {
  return normalizeCandles(candles).filter(c => c.epoch + timeframe <= endEpoch);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function splitContinuousSegments(candles, timeframe = TIMEFRAME_SECONDS) {
  const segments = [];
  let segment = [];
  for (const candle of candles) {
    if (segment.length && candle.epoch !== segment.at(-1).epoch + timeframe) {
      segments.push(segment);
      segment = [];
    }
    segment.push(candle);
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function summarizeCoverage(candles, startEpoch, endEpoch, timeframe = TIMEFRAME_SECONDS) {
  const firstExpected = Math.ceil(startEpoch / timeframe) * timeframe;
  const lastExpected = Math.floor((endEpoch - timeframe) / timeframe) * timeframe;
  const expectedCandles = lastExpected >= firstExpected
    ? Math.floor((lastExpected - firstExpected) / timeframe) + 1 : 0;
  const inWindow = normalizeCandles(candles).filter(c =>
    c.epoch >= firstExpected && c.epoch <= lastExpected &&
    c.epoch % timeframe === 0
  );
  const missingCandles = Math.max(0, expectedCandles - inWindow.length);
  const gaps = splitContinuousSegments(inWindow, timeframe);
  let largestGapCandles = 0;
  for (let i = 1; i < inWindow.length; i++) {
    largestGapCandles = Math.max(
      largestGapCandles,
      Math.max(0, Math.round((inWindow[i].epoch - inWindow[i - 1].epoch) / timeframe) - 1)
    );
  }
  return {
    expectedCandles,
    actualCandles: inWindow.length,
    missingCandles,
    coveragePct: expectedCandles ? Number((inWindow.length / expectedCandles * 100).toFixed(2)) : null,
    gapCount: Math.max(0, gaps.length - 1),
    largestGapCandles,
    firstCandleEpoch: inWindow[0]?.epoch ?? null,
    lastCandleEpoch: inWindow.at(-1)?.epoch ?? null
  };
}

function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let value = ranges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

function makeTrade({ marketId, marketName, signalCandle, entryCandle, result, history, horizonCandles }) {
  const atr = calculateAtr(history, 14);
  if (!(atr > 0) || !result.signal || result.signal === "NO TRADE") return null;
  const direction = result.signal;
  const entry = entryCandle.open;
  const risk = atr * STOP_ATR;
  return {
    marketId, marketName, signalEpoch: signalCandle.epoch, entryEpoch: entryCandle.epoch,
    direction, score: result.score, entry, stopLoss: direction === "BUY" ? entry - risk : entry + risk,
    tp1: direction === "BUY" ? entry + risk * TP1_R : entry - risk * TP1_R,
    tp2: direction === "BUY" ? entry + risk * TP2_R : entry - risk * TP2_R,
    horizonCandles, metrics: result.metrics, outcome: null, outcomeEpoch: null, r: null
  };
}

function resolveTrade(trade, candles, entryIndex) {
  // Include the entry candle: its high/low occur after the next-candle-open fill.
  const end = Math.min(candles.length, entryIndex + trade.horizonCandles);
  let tp1Hit = false;
  for (let i = entryIndex; i < end; i++) {
    const candle = candles[i];
    const buy = trade.direction === "BUY";
    const slTouched = buy ? candle.low <= trade.stopLoss : candle.high >= trade.stopLoss;
    const tp1Touched = buy ? candle.high >= trade.tp1 : candle.low <= trade.tp1;
    const tp2Touched = buy ? candle.high >= trade.tp2 : candle.low <= trade.tp2;
    if (slTouched && (tp1Touched || tp2Touched)) {
      return { ...trade, outcome: "AMBIGUOUS", outcomeEpoch: candle.epoch, r: null };
    }
    if (slTouched) {
      return { ...trade, outcome: tp1Hit ? "SL_AFTER_TP1" : "SL", outcomeEpoch: candle.epoch, r: -1 };
    }
    if (tp2Touched) {
      return { ...trade, outcome: "TP2", outcomeEpoch: candle.epoch, r: TP2_R };
    }
    if (tp1Touched) tp1Hit = true;
  }
  return { ...trade, outcome: "UNRESOLVED", outcomeEpoch: null, r: null };
}

function summarizeTrades(trades) {
  const resolved = trades.filter(t => ["TP2", "SL", "SL_AFTER_TP1"].includes(t.outcome));
  const wins = resolved.filter(t => t.outcome === "TP2").length;
  const losses = resolved.length - wins;
  const ambiguous = trades.filter(t => t.outcome === "AMBIGUOUS").length;
  const unresolved = trades.filter(t => t.outcome === "UNRESOLVED").length;
  const crudeR = resolved.reduce((sum, t) => sum + t.r, 0);
  return {
    generated: trades.length,
    resolved: resolved.length,
    wins, losses,
    resolvedWinRatePct: resolved.length ? Number((wins / resolved.length * 100).toFixed(2)) : null,
    ambiguous, unresolved,
    crudeR: Number(crudeR.toFixed(3)),
    expectancyR: resolved.length ? Number((crudeR / resolved.length).toFixed(4)) : null
  };
}

function backtestMarket({ marketId, marketName, candles, horizonCandles = DEFAULT_HORIZON_CANDLES, cooldownCandles = DEFAULT_COOLDOWN_CANDLES }) {
  const segments = splitContinuousSegments(candles).filter(segment => segment.length >= WARMUP_CANDLES + 2);
  const trades = [];
  for (const segment of segments) {
    let lastSignalEpoch = -Infinity;
    for (let signalIndex = WARMUP_CANDLES - 1; signalIndex < segment.length - 1; signalIndex++) {
      const signalCandle = segment[signalIndex];
      const entryCandle = segment[signalIndex + 1];
      if (signalCandle.epoch - lastSignalEpoch < cooldownCandles * TIMEFRAME_SECONDS) continue;
      const history = segment.slice(0, signalIndex + 1);
      const result = evaluate(history);
      if (result.state !== "ok" || result.signal === "NO TRADE") continue;
      const trade = makeTrade({ marketId, marketName, signalCandle, entryCandle, result, history, horizonCandles });
      if (!trade) continue;
      trades.push(resolveTrade(trade, segment, signalIndex + 1));
      lastSignalEpoch = signalCandle.epoch;
    }
  }
  return { marketId, marketName, segments: segments.length, candleCount: candles.length, trades, summary: summarizeTrades(trades) };
}

async function fetchCandles(client, symbol, { startEpoch, endEpoch, requestGapMs = REQUEST_GAP_MS }) {
  const rows = [];
  let end = endEpoch;
  let lastRequestAt = 0;
  while (end > startEpoch) {
    const waitForGap = requestGapMs - (Date.now() - lastRequestAt);
    if (waitForGap > 0) await sleep(waitForGap);
    let reply;
    let lastError;
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
      try {
        lastRequestAt = Date.now();
        // With start supplied Deriv ignores count and may return an expensive
        // full-range response. Page backwards using count + end only.
        reply = await client.ask({
          ticks_history: symbol, end, count: PAGE_SIZE, adjust_start_time: 1,
          granularity: TIMEFRAME_SECONDS, style: "candles"
        });
        if (!reply.error) break;
        lastError = new Error(reply.error.message || "ticks_history failed");
      } catch (error) {
        lastError = error;
      }
      if (!/rate limit|ticks_history_expensive/i.test(lastError.message)) throw lastError;
      if (attempt === RATE_LIMIT_RETRIES) {
        throw new Error("Deriv historical-candle rate limit persisted after bounded retries: " + lastError.message);
      }
      await sleep(5000 * (attempt + 1));
    }
    if (reply.error) throw new Error(reply.error.message || "ticks_history failed");
    const batch = normalizeCandles(reply.candles || []).filter(c =>
      c.epoch >= startEpoch && c.epoch <= end
    );
    if (!batch.length) break;
    rows.push(...batch);
    const earliest = batch[0].epoch;
    if (earliest <= startEpoch) break;
    end = earliest - TIMEFRAME_SECONDS;
  }
  return filterClosedCandles(
    normalizeCandles(rows).filter(c => c.epoch >= startEpoch && c.epoch <= endEpoch),
    endEpoch
  );
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  const now = Math.floor(Date.now() / 1000);
  const days = Math.max(1, Number(args.days || DEFAULT_DAYS));
  const endEpoch = args.end ? Number(args.end) : now;
  const startEpoch = args.start ? Number(args.start) : endEpoch - days * 86400;
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch) || startEpoch >= endEpoch) throw new Error("Invalid --start/--end or --days");
  return {
    startEpoch, endEpoch,
    horizonCandles: Math.max(1, Number(args.horizon || DEFAULT_HORIZON_CANDLES)),
    cooldownCandles: Math.max(0, Number(args.cooldown || DEFAULT_COOLDOWN_CANDLES)),
    output: args.output || path.join(getDataDir(), "m15_expansion_backtest_report.json")
  };
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function runBacktest(options = {}) {
  const config = { ...parseArgs([]), ...options };
  const client = await connect();
  try {
    const active = await client.ask({ active_symbols: "brief" });
    if (active.error) throw new Error(active.error.message || "active_symbols failed");
    const available = new Map((active.active_symbols || []).map(row => [row.underlying_symbol || row.symbol, row.underlying_symbol_name || row.display_name]));
    const reportMarkets = {};
    for (const [marketId, configuredName] of MARKETS) {
      const symbol = available.has(marketId) ? marketId : [...available.keys()].find(key => key === marketId);
      if (!symbol) {
        reportMarkets[marketId] = { marketId, marketName: configuredName, status: "symbol_not_available" };
        continue;
      }
      const candles = await fetchCandles(client, symbol, { startEpoch: config.startEpoch, endEpoch: config.endEpoch });
      const dataQuality = summarizeCoverage(candles, config.startEpoch, config.endEpoch);
      const replay = backtestMarket({ marketId, marketName: available.get(symbol) || configuredName, candles, horizonCandles: config.horizonCandles, cooldownCandles: config.cooldownCandles });
      reportMarkets[marketId] = { status: "replayed", dataQuality, ...replay };
    }
    const combinedTrades = Object.values(reportMarkets).filter(m => m.status === "replayed").flatMap(m => m.trades);
    const enginePath = require.resolve("./engine");
    const report = {
      generatedAt: new Date().toISOString(), mode: "paper_only_m15_expansion_backtest",
      strategy: {
        evaluator: "engine.evaluate", engineSha256: sha256File(enginePath),
        entry: "next completed M15 candle open", stopAtr: STOP_ATR, tp1R: TP1_R, tp2R: TP2_R,
        tp1Semantics: "milestone_only; no partial close and original stop remains active",
        horizonCandles: config.horizonCandles, cooldownCandles: config.cooldownCandles,
        warmupCandles: WARMUP_CANDLES
      },
      window: { startEpoch: config.startEpoch, endEpoch: config.endEpoch, days: Number(((config.endEpoch - config.startEpoch) / 86400).toFixed(3)) },
      safety: { telegram: false, orderExecution: false, productionJournalMutation: false },
      markets: reportMarkets,
      combined: summarizeTrades(combinedTrades),
      note: "Historical outcomes are counterfactual research evidence, not actual account P/L. TP1 is a milestone only; it does not book partial profit or move the stop. Ambiguous and unresolved outcomes are excluded from resolved win rate and expectancy. Check per-market dataQuality coverage before interpreting results."
    };
    if (config.output) {
      fs.mkdirSync(path.dirname(config.output), { recursive: true });
      fs.writeFileSync(config.output, JSON.stringify(report, null, 2) + "\n");
    }
    return report;
  } finally {
    client.close();
  }
}

if (require.main === module) {
  runBacktest(parseArgs()).then(report => {
    console.log(JSON.stringify({ event: "m15_expansion_backtest_completed", output: parseArgs().output, window: report.window, combined: report.combined }, null, 2));
  }).catch(error => {
    console.error(JSON.stringify({ event: "m15_expansion_backtest_failed", error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  MARKETS, TIMEFRAME_SECONDS, WARMUP_CANDLES, STOP_ATR, TP1_R, TP2_R,
  normalizeCandles, filterClosedCandles, splitContinuousSegments, summarizeCoverage,
  makeTrade, resolveTrade, summarizeTrades, backtestMarket, fetchCandles,
  parseArgs, runBacktest
};
