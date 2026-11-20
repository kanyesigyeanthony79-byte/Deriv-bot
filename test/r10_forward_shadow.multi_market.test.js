"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { updateR10ForwardShadowJournal } = require("../r10_forward_shadow");

test("initializes an isolated forward-shadow journal for a non-R10 synthetic market", () => {
  const journal = updateR10ForwardShadowJournal(null, {
    marketId: "R_25",
    timeframes: { M1: [], M5: [], M15: [] }
  }, 1795200000, "R_25");
  assert.equal(journal.marketId, "R_25");
  assert.equal(journal.dataQuality, "insufficient_continuous_history");
  assert.equal(journal.setups.length, 0);
});

test("does not write a market's candles into a different market journal", () => {
  const prior = { version: 1, marketId: "R_25", setups: [], marker: "preserve" };
  const result = updateR10ForwardShadowJournal(prior, {
    marketId: "R_50",
    timeframes: { M1: [], M5: [], M15: [] }
  }, 1795200000, "R_25");
  assert.equal(result, prior);
  assert.equal(result.marker, "preserve");
});
