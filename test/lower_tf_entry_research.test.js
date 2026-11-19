"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeBackfillCandles, mergeLowerTimeframeArchive, findM5Gaps, BACKFILL_M5_COUNT
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
