"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MARKETS, TIMEFRAME_SECONDS, normalizeCandles, splitContinuousSegments,
  resolveTrade, summarizeTrades, backtestMarket
} = require("../m15_expansion_backtest");

function candle(epoch, open, high, low, close) {
  return { epoch, open, high, low, close };
}

function trade(overrides = {}) {
  return {
    marketId: "R_100", marketName: "Volatility 100 Index", signalEpoch: 0, entryEpoch: 900,
    direction: "BUY", score: 70, entry: 100, stopLoss: 99, tp1: 102, tp2: 103,
    horizonCandles: 4, metrics: {}, outcome: null, outcomeEpoch: null, r: null, ...overrides
  };
}

test("expansion backtest is scoped to exactly the seven proposed markets", () => {
  assert.deepEqual(MARKETS.map(([id]) => id), ["R_100", "JD25", "JD50", "RB100", "RB200", "BOOM100", "CRASH100"]);
});

test("candle normalization removes malformed and duplicate epochs", () => {
  const rows = normalizeCandles([
    { epoch: 1800, open: 3, high: 4, low: 2, close: 3.5 },
    { epoch: 900, open: 2, high: 3, low: 1, close: 2.5 },
    { epoch: 900, open: 2, high: 3, low: 1, close: 2.6 },
    { epoch: 2700, open: 1, high: 0, low: 2, close: 1 },
    { epoch: 3600, open: 4, high: 5, low: 3, close: 4 }
  ]);
  assert.deepEqual(rows.map(c => c.epoch), [900, 1800, 3600]);
  assert.equal(rows[0].close, 2.6);
});

test("continuity splits unexplained M15 gaps instead of bridging them", () => {
  const rows = [0, 900, 1800, 3600, 4500].map(epoch => candle(epoch, 1, 2, 0.5, 1.5));
  assert.deepEqual(splitContinuousSegments(rows, TIMEFRAME_SECONDS).map(s => s.length), [3, 2]);
});

test("same-candle stop and target touches are ambiguous, not losses", () => {
  const result = resolveTrade(trade(), [
    candle(0, 100, 100.5, 99.5, 100), candle(900, 100, 100.1, 99.9, 100),
    candle(1800, 100, 103.2, 98.8, 101)
  ], 1);
  assert.equal(result.outcome, "AMBIGUOUS");
  assert.equal(result.r, null);
});

test("TP2 is +3R and a stop after TP1 is -1R", () => {
  const win = resolveTrade(trade(), [
    candle(0, 100, 100.5, 99.5, 100), candle(900, 100, 100.1, 99.9, 100),
    candle(1800, 100, 103.1, 99.8, 102.5)
  ], 1);
  const lossAfterTp1 = resolveTrade(trade(), [
    candle(0, 100, 100.5, 99.5, 100), candle(900, 100, 100.1, 99.9, 100),
    candle(1800, 100, 102.2, 99.8, 101.8), candle(2700, 101.8, 101.9, 98.9, 100)
  ], 1);
  assert.equal(win.outcome, "TP2");
  assert.equal(win.r, 3);
  assert.equal(lossAfterTp1.outcome, "SL_AFTER_TP1");
  assert.equal(lossAfterTp1.r, -1);
});

test("unresolved and ambiguous outcomes stay outside resolved win rate", () => {
  const result = summarizeTrades([
    trade({ outcome: "TP2", r: 3 }), trade({ outcome: "SL", r: -1 }),
    trade({ outcome: "AMBIGUOUS" }), trade({ outcome: "UNRESOLVED" })
  ]);
  assert.deepEqual(result, {
    generated: 4, resolved: 2, wins: 1, losses: 1, resolvedWinRatePct: 50,
    ambiguous: 1, unresolved: 1, crudeR: 2, expectancyR: 1
  });
});

test("backtest does not create trades from insufficient history", () => {
  const candles = Array.from({ length: 64 }, (_, i) => candle(i * 900, 100, 101, 99, 100));
  const result = backtestMarket({ marketId: "R_100", marketName: "Volatility 100 Index", candles });
  assert.equal(result.segments, 0);
  assert.equal(result.summary.generated, 0);
});
