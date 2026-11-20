"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMtfOverlap } = require("../exp01_candidate_opportunity_replay");

test("candidate overlap distinguishes MTF agreement and direction disagreement", () => {
  assert.equal(classifyMtfOverlap({ state: "signal", direction: "BUY" }, "BUY"), "mtf_agrees");
  assert.equal(classifyMtfOverlap({ state: "signal", direction: "SELL" }, "BUY"), "mtf_direction_disagreement");
});

test("candidate overlap preserves non-signal MTF rejection states", () => {
  assert.equal(classifyMtfOverlap({ state: "no_signal" }, "BUY"), "mtf_no_signal");
  assert.equal(classifyMtfOverlap({ state: "market_filtered" }, "SELL"), "mtf_market_filtered");
  assert.equal(classifyMtfOverlap({ state: "warming" }, "BUY"), "mtf_warming");
});
