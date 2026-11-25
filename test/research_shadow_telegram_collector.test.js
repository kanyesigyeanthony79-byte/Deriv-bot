"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MARKETS, FRAMES, toAlert } = require("../research_shadow_telegram_collector");

test("research diagnostics cover all 17 markets and all three scanned timeframes", () => {
  assert.equal(MARKETS.length, 17);
  assert.ok(MARKETS.some(([id]) => id === "1HZ10V"));
  assert.ok(MARKETS.some(([id]) => id === "1HZ75V"));
  assert.deepEqual(FRAMES.map(([name]) => name), ["M1", "M5", "M15"]);
});

test("candidate validation returns a shadow alert for valid signal geometry", () => {
  const alert = toAlert({
    signalId: "1HZ10V-test-1", marketId: "1HZ10V", market: "Volatility 10 (1s) Index",
    direction: "BUY", entry: 100, stopLoss: 99, tp2: 102,
    setupTimeframe: "M5", entryTimeframe: "M1"
  }, "TEST_STRATEGY", { timeframes: {} }, false);
  assert.equal(alert.source, "RESEARCH_SHADOW");
  assert.equal(alert.paper, true);
  assert.equal(alert.live, false);
  assert.equal(alert.tp1, 101.5);
});

test("candidate diagnostics expose invalid signal geometry as a rejection reason", () => {
  let reason = null;
  const alert = toAlert({
    signalId: "1HZ75V-invalid-1", marketId: "1HZ75V",
    direction: "BUY", entry: 100, stopLoss: 101, tp2: 102
  }, "TEST_STRATEGY", { timeframes: {} }, false, value => { reason = value; });
  assert.equal(alert, null);
  assert.equal(reason, "invalid_signal_geometry_or_fields");
});

test("regime-filter rejection is reported distinctly from malformed candidates", () => {
  let reason = null;
  const alert = toAlert({
    signalId: "1HZ10V-regime-1", marketId: "1HZ10V",
    direction: "BUY", entry: 100, stopLoss: 99, tp2: 102,
    entryTimeframe: "M5"
  }, "TEST_STRATEGY", { timeframes: { M15: [], M5: [] } }, true, value => { reason = value; });
  assert.equal(alert, null);
  assert.equal(reason, "market_regime_rejected");
});
