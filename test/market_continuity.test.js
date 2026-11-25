"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { latestContinuousCandleSegment } = require("../market_continuity");

function candles(count, start = 1_700_000_100, step = 900) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i;
    return { epoch: start + i * step, open: close - 0.5, high: close + 0.5, low: close - 1, close };
  });
}

test("returns the latest continuous segment only when the minimum is met", () => {
  assert.equal(latestContinuousCandleSegment(candles(64), 900, 65), null);
  assert.equal(latestContinuousCandleSegment(candles(65), 900, 65).length, 65);
});

test("does not bridge a Gold-style M15 gap", () => {
  const rows = candles(65);
  rows[30].epoch += 900;
  const result = latestContinuousCandleSegment(rows, 900, 65);
  assert.equal(result, null);
  assert.equal(latestContinuousCandleSegment(rows, 900, 30).length, 34);
});
