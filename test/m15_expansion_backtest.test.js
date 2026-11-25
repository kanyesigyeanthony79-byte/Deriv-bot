"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MARKETS, TIMEFRAME_SECONDS, normalizeCandles, filterClosedCandles,
  splitContinuousSegments, summarizeCoverage, resolveTrade, summarizeTrades,
  backtestMarket, fetchCandles
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

test("incomplete current M15 candle is excluded from replay", () => {
  const rows = [0, 900, 1800].map(epoch => candle(epoch, 1, 2, 0.5, 1.5));
  assert.deepEqual(filterClosedCandles(rows, 1800).map(c => c.epoch), [0, 900]);
});

test("continuous history coverage reports missing bars and gaps", () => {
  const rows = [0, 900, 2700, 3600, 4500].map(epoch => candle(epoch, 1, 2, 0.5, 1.5));
  assert.deepEqual(summarizeCoverage(rows, 0, 5400), {
    expectedCandles: 6, actualCandles: 5, missingCandles: 1, coveragePct: 83.33,
    gapCount: 1, largestGapCandles: 1, firstCandleEpoch: 0, lastCandleEpoch: 4500
  });
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

test("entry candle is included when checking stop and target touches", () => {
  const stop = resolveTrade(trade(), [
    candle(0, 100, 100.5, 99.5, 100), candle(900, 100, 100.1, 98.9, 99.2),
    candle(1800, 99.2, 99.5, 99.1, 99.3)
  ], 1);
  const target = resolveTrade(trade(), [
    candle(0, 100, 100.5, 99.5, 100), candle(900, 100, 103.1, 99.8, 102.5),
    candle(1800, 102.5, 102.6, 102.2, 102.4)
  ], 1);
  assert.equal(stop.outcome, "SL");
  assert.equal(stop.outcomeEpoch, 900);
  assert.equal(target.outcome, "TP2");
  assert.equal(target.outcomeEpoch, 900);
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

test("history fetch pages backwards with count and end, not an expensive start range", async () => {
  const requests = [];
  const client = {
    async ask(request) {
      requests.push(request);
      if (request.end === 5400) {
        return { candles: [2700, 3600, 4500].map(epoch => candle(epoch, 1, 2, 0.5, 1.5)) };
      }
      if (request.end === 1800) {
        return { candles: [0, 900, 1800].map(epoch => candle(epoch, 1, 2, 0.5, 1.5)) };
      }
      throw new Error("Unexpected page end: " + request.end);
    }
  };
  const rows = await fetchCandles(client, "R_100", { startEpoch: 0, endEpoch: 5400, requestGapMs: 0 });
  assert.deepEqual(rows.map(c => c.epoch), [0, 900, 1800, 2700, 3600, 4500]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.count, 1000);
    assert.equal("start" in request, false);
    assert.equal(request.granularity, 900);
  }
});

test("backtest does not create trades from insufficient history", () => {
  const candles = Array.from({ length: 64 }, (_, i) => candle(i * 900, 100, 101, 99, 100));
  const result = backtestMarket({ marketId: "R_100", marketName: "Volatility 100 Index", candles });
  assert.equal(result.segments, 0);
  assert.equal(result.summary.generated, 0);
});
