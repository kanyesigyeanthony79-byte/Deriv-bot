"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeBackfillCandles, candlesFromTickHistory, mergeLowerTimeframeArchive, findM5Gaps, findRepairableM5Gaps, BACKFILL_M5_COUNT, GAP_REPAIR_WINDOW_SECONDS
} = require("../lower_tf_entry_research");

test("R_10 M5 backfill keeps only completed aligned valid unique candles", () => {
  const rows = [
    { epoch: 3000, open: 1, high: 3, low: 1, close: 2 },
    { epoch: 3300, open: 2, high: 4, low: 2, close: 3 },
    { epoch: 3300, open: 2, high: 4, low: 2, close: 3 },
    { epoch: 3600, open: 3, high: 5, low: 3, close: 4 },
    { epoch: 3301, open: 2, high: 4, low: 2, close: 3 },
    { epoch: 3600, open: 3, high: 2, low: 3, close: 4 }
  ];
  assert.deepEqual(normalizeBackfillCandles(rows, 3600).map(c => c.epoch), [3000, 3300]);
  assert.equal(BACKFILL_M5_COUNT, 1000);
});

test("historical R_10 M5 backfill merges with prior research candles by epoch", () => {
  const prior = { version: 1, markets: { R_10: {
    marketName: "Volatility 10 Index",
    timeframes: { M5: [
      { epoch: 3000, open: 1, high: 2, low: 1, close: 2 },
      { epoch: 3301, open: 2, high: 3, low: 2, close: 3 }
    ] }
  } } };
  const incoming = { R_10: {
    marketName: "Volatility 10 Index",
    timeframes: { M5: [
      { epoch: 3000, open: 1, high: 2, low: 1, close: 2 },
      { epoch: 3300, open: 2, high: 3, low: 2, close: 3 },
      { epoch: 3601, open: 3, high: 4, low: 3, close: 4 }
    ] }
  } };
  const merged = mergeLowerTimeframeArchive(prior, incoming);
  assert.deepEqual(merged.markets.R_10.timeframes.M5.map(c => c.epoch), [3000, 3300]);
});


test("R_10 M5 gap finder returns exact missing candle boundaries", () => {
  const rows = [
    { epoch: 1794962700, open: 1, high: 2, low: 1, close: 2 },
    { epoch: 1794964200, open: 2, high: 3, low: 2, close: 3 }
  ];
  assert.deepEqual(findM5Gaps(rows), [{
    start: 1794963000, end: 1794963900, missingCandles: 4
  }]);
});

test("tick-history fallback reconstructs only M5 buckets containing real ticks", () => {
  const gap = { start: 1794963000, end: 1794963900, missingCandles: 4 };
  const history = {
    times: [1794963001, 1794963010, 1794963300, 1794963601, 1794964200],
    prices: [10, 12, 11, 9, 99]
  };
  const candles = candlesFromTickHistory(history, gap, 1794965000);
  assert.deepEqual(candles.map(c => c.epoch), [1794963000, 1794963300, 1794963600]);
  assert.deepEqual(candles[0], {
    epoch: 1794963000, open: 10, high: 12, low: 10, close: 12
  });
  assert.deepEqual(candles[2], {
    epoch: 1794963600, open: 9, high: 9, low: 9, close: 9
  });
});

test("tick-history fallback excludes incomplete candles and invalid tick rows", () => {
  const gap = { start: 3000, end: 3900, missingCandles: 4 };
  const history = { times: [3001, 3301, 3601, 3901], prices: ["bad", 2, 3, 4] };
  assert.deepEqual(candlesFromTickHistory(history, gap, 3899).map(c => c.epoch), [3300]);
});

test("M5 gap repair skips old gaps and keeps recent gaps eligible", () => {
  const now = 1795089600;
  const rows = [
    { epoch: 1794962700, open: 1, high: 2, low: 1, close: 2 },
    { epoch: 1794964200, open: 2, high: 3, low: 2, close: 3 },
    { epoch: now - 900, open: 3, high: 4, low: 3, close: 4 },
    { epoch: now - 300, open: 4, high: 5, low: 4, close: 5 }
  ];
  assert.equal(GAP_REPAIR_WINDOW_SECONDS, 86400);
  assert.deepEqual(findRepairableM5Gaps(rows, now), [{
    start: now - 600, end: now - 600, missingCandles: 1
  }]);
});
