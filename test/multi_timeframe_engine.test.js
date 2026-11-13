"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TIMEFRAMES, CATEGORIES, validCandles, trendBias,
  evaluateCategory, evaluateAllCategories, aggregateWeeklyCandles
} = require("../multi_timeframe_engine");

function candles(count, stepSeconds, start = 1_700_000_000, startPrice = 100) {
  return Array.from({ length: count }, (_, i) => {
    const close = startPrice + i * 0.2;
    return { epoch: start + i * stepSeconds, open: close - 0.08, high: close + 0.12, low: close - 0.12, close };
  });
}

test("defines all four horizons and required chart intervals", () => {
  assert.deepEqual(Object.keys(CATEGORIES), ["SCALP", "SHORT_TERM", "SWING", "POSITION"]);
  assert.equal(TIMEFRAMES.M1, 60);
  assert.equal(CATEGORIES.SCALP.entry, "M1");
  assert.equal(CATEGORIES.POSITION.context, "W1");
});

test("validates candle order and OHLC structure", () => {
  assert.equal(validCandles(candles(3, 60)), true);
  assert.equal(validCandles([{ epoch: 2, open: 1, high: 1, low: 1, close: 1 }, { epoch: 1, open: 1, high: 1, low: 1, close: 1 }]), false);
  assert.equal(validCandles([{ epoch: 1, open: 2, high: 1, low: 0, close: 1 }]), false);
});

test("trend bias waits for enough history and identifies a rising trend", () => {
  assert.equal(trendBias(candles(20, 60)).state, "warming");
  assert.equal(trendBias(candles(100, 60)).direction, "BUY");
});

test("all categories return a safe warming result when history is missing", () => {
  const results = evaluateAllCategories("JD100", "Jump 100 Index", {});
  assert.equal(results.length, 4);
  assert.ok(results.every(x => x.state === "warming"));
});

test("category-specific analysis does not throw on valid but conflicting frames", () => {
  const rising = candles(100, 60);
  const falling = candles(100, 300, 1_700_000_000, 130).map((c, i) => {
    const close = 130 - i * 0.2;
    return { ...c, open: close + 0.08, high: close + 0.12, low: close - 0.12, close };
  });
  const result = evaluateCategory("JD100", "Jump 100 Index", "SCALP", { M1: rising, M5: falling, M15: rising });
  assert.ok(["warming", "no_signal", "timeframe_conflict", "signal"].includes(result.state));
});

test("weekly aggregation excludes the current incomplete week and aggregates OHLC", () => {
  const monday = Date.UTC(2026, 0, 5) / 1000;
  const daily = Array.from({ length: 14 }, (_, i) => ({
    epoch: monday + i * 86400, open: 100 + i, high: 102 + i,
    low: 99 + i, close: 101 + i
  }));
  const result = aggregateWeeklyCandles(daily, monday + 14 * 86400);
  assert.equal(result.length, 2);
  assert.equal(result[0].open, 100);
  assert.equal(result[0].high, 108);
  assert.equal(result[0].low, 99);
  assert.equal(result[0].close, 107);
  assert.equal(result[1].open, 107);
});
