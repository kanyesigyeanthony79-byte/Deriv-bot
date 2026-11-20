"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMtfOverlap, findRetestWithinSplit } = require("../exp01_candidate_opportunity_replay");

test("candidate overlap distinguishes MTF agreement and direction disagreement", () => {
  assert.equal(classifyMtfOverlap({ state: "signal", direction: "BUY" }, "BUY"), "mtf_agrees");
  assert.equal(classifyMtfOverlap({ state: "signal", direction: "SELL" }, "BUY"), "mtf_direction_disagreement");
});

test("candidate overlap preserves non-signal MTF rejection states", () => {
  assert.equal(classifyMtfOverlap({ state: "no_signal" }, "BUY"), "mtf_no_signal");
  assert.equal(classifyMtfOverlap({ state: "market_filtered" }, "SELL"), "mtf_market_filtered");
  assert.equal(classifyMtfOverlap({ state: "warming" }, "BUY"), "mtf_warming");
});

test("retest confirmation cannot borrow an M1 candle from the next split", () => {
  const m1 = [
    { epoch: 0, open: 99.8, high: 100.0, low: 99.7, close: 99.9 },
    { epoch: 60, open: 99.9, high: 100.0, low: 99.8, close: 99.9 },
    { epoch: 120, open: 99.9, high: 100.0, low: 99.8, close: 99.9 },
    { epoch: 180, open: 100.0, high: 100.5, low: 99.9, close: 100.4 },
    { epoch: 240, open: 100.4, high: 100.6, low: 100.3, close: 100.5 }
  ];
  const atrValues = m1.map(() => 1);
  const setup = { direction: 1, boundary: 100, atr5: 1 };
  assert.equal(findRetestWithinSplit(m1, atrValues, 180, setup, 240), null);
  const withinSplit = findRetestWithinSplit(m1, atrValues, 180, setup, 300);
  assert.equal(withinSplit.triggerIndex, 3);
  assert.equal(withinSplit.entryIndex, 4);
});
