"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TIMEFRAMES, CATEGORIES, validCandles, trendBias,
  evaluateCategory, evaluateAllCategories, evaluateRecentSignals, aggregateWeeklyCandles,
  classifyMarketRegime, validateCandleContinuity
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

test("historical entry evaluation excludes higher-timeframe candles that had not closed yet", () => {
  const m1 = candles(100, 60);
  const m5 = candles(100, 300);
  const m15 = candles(100, 900);
  const result = evaluateCategory("JD100", "Jump 100 Index", "SCALP", { M1: m1, M5: m5, M15: m15 }, 70);
  assert.equal(result.state, "warming");
  assert.match(result.reason, /completed candles/);
});

test("recent-signal recovery returns only candidates with unique entry-candle IDs", () => {
  const frames = { M1: candles(240, 60), M5: candles(240, 300), M15: candles(240, 900), H1: candles(240, 3600), H4: candles(240, 14400), D1: candles(365, 86400), W1: candles(52, 604800) };
  const results = evaluateRecentSignals("JD100", "Jump 100 Index", frames, 6);
  assert.ok(Array.isArray(results));
  assert.ok(results.length <= 24, "at most six recent entries per each of four categories");
  assert.ok(results.every(s => s.state === "signal" && s.signalId.includes("-")));
  assert.equal(new Set(results.map(s => s.signalId)).size, results.length);
});


test("market regime filter distinguishes a clean directional trend", () => {
  const rising = candles(120, 60);
  assert.equal(classifyMarketRegime(rising).state, "trending");
  assert.equal(classifyMarketRegime(rising).direction, "BUY");
});

test("market regime filter identifies a flat sideways market", () => {
  const flat = Array.from({ length: 120 }, (_, i) => ({
    epoch: 1_700_000_000 + i * 60,
    open: 100 + (i % 2) * 0.01, high: 100.05, low: 99.95,
    close: 100 + (i % 2) * 0.01
  }));
  assert.equal(classifyMarketRegime(flat).state, "ranging");
});

test("continuity validation catches missing synthetic-market candles", () => {
  const data = candles(5, 60);
  data[3].epoch += 120;
  assert.equal(validateCandleContinuity(data, 60, "JD100").valid, false);
});

test("continuity validation accepts normal contiguous candles", () => {
  assert.equal(validateCandleContinuity(candles(10, 300), 300, "R_25").valid, true);
});

test("continuity validation allows the scheduled Gold/USD weekend closure", () => {
  const fridayClose = Date.UTC(2026, 10, 13, 21, 0, 0) / 1000; // Friday 21:00 UTC
  const sundayReopen = Date.UTC(2026, 10, 15, 22, 0, 0) / 1000; // Sunday 22:00 UTC
  const gold = [
    { epoch: fridayClose, open: 4000, high: 4002, low: 3998, close: 4001 },
    { epoch: sundayReopen, open: 4001, high: 4004, low: 4000, close: 4003 }
  ];
  assert.equal(validateCandleContinuity(gold, 3600, "frxXAUUSD").valid, true);
});

test("continuity validation does not apply the Gold/USD weekend exception to synthetic markets", () => {
  const fridayClose = Date.UTC(2026, 10, 13, 21, 0, 0) / 1000;
  const sundayReopen = Date.UTC(2026, 10, 15, 22, 0, 0) / 1000;
  const synthetic = [
    { epoch: fridayClose, open: 100, high: 101, low: 99, close: 100 },
    { epoch: sundayReopen, open: 100, high: 101, low: 99, close: 100 }
  ];
  assert.equal(validateCandleContinuity(synthetic, 3600, "R_25").valid, false);
});

