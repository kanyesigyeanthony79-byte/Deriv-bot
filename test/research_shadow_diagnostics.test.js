"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MARKETS, toAlert } = require("../research_shadow_telegram_collector");

test("research diagnostics cover all 17 shadow markets including both 1-second indices", () => {
  assert.equal(MARKETS.length, 17);
  assert.ok(MARKETS.some(([id]) => id === "1HZ10V"));
  assert.ok(MARKETS.some(([id]) => id === "1HZ75V"));
  assert.ok(MARKETS.some(([id]) => id === "RB100"));
  assert.ok(MARKETS.some(([id]) => id === "RB200"));
});

test("research alert validation records an explicit rejection reason", () => {
  const market = { timeframes: {} };
  const result = toAlert({
    signalId: "1HZ10V-test-invalid",
    marketId: "1HZ10V",
    market: "Volatility 10 (1s) Index",
    direction: "BUY",
    entry: 100,
    stopLoss: 99,
    tp2: 98,
    entryTimeframe: "M1"
  }, "TEST_STRATEGY", market, false);
  assert.equal(result, null);
  assert.deepEqual(market.candidateDecisions, [{
    signalId: "1HZ10V-test-invalid",
    strategyId: "TEST_STRATEGY",
    decision: "rejected",
    reason: "invalid_signal_levels_or_direction"
  }]);
});

test("valid research alerts remain explicitly shadow-only", () => {
  const market = { timeframes: {} };
  const alert = toAlert({
    signalId: "1HZ75V-test-valid",
    marketId: "1HZ75V",
    market: "Volatility 75 (1s) Index",
    direction: "SELL",
    entry: 100,
    stopLoss: 101,
    tp2: 98,
    setupTimeframe: "M5",
    entryTimeframe: "M1",
    confirmationTimeframe: "M1"
  }, "TEST_STRATEGY", market, false);
  assert.equal(alert.status, "SHADOW");
  assert.equal(alert.paper, true);
  assert.equal(alert.live, false);
  assert.equal(alert.marketId, "1HZ75V");
  assert.equal(alert.tp1, 98.5);
  assert.deepEqual({ ...{ ...({}) } }, {});
  assert.deepEqual({ decision: market.candidateDecisions[0].decision, regimeFilterApplied: market.candidateDecisions[0].regimeFilterApplied }, {
    decision: "accepted", regimeFilterApplied: false
  });
});
