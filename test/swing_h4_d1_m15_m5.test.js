"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { completedAtOrBefore, evaluateRefinedSwing } = require("../swing_h4_d1_m15_m5");

const candle = (epoch, close = 100) => ({
  epoch, open: close - 0.2, high: close + 1, low: close - 1, close
});

test("higher-timeframe cutoffs exclude candles that were not yet complete at the M5 close", () => {
  const frames = [candle(0), candle(3600), candle(7200)];
  const result = completedAtOrBefore(frames, "H1", 7200);
  assert.deepEqual(result.map(item => item.epoch), [0, 3600]);
});

test("refined swing candidate waits when the required M5 history is unavailable", () => {
  const result = evaluateRefinedSwing("R_25", "Volatility 25", {
    M5: [candle(300)], M15: [], H1: [], H4: [], D1: []
  });
  assert.equal(result.state, "warming");
  assert.equal(result.timeframe, "M5");
});

test("refined swing candidate never creates a signal from missing timeframe data", () => {
  const makeSeries = (count, step) => Array.from({length: count}, (_, i) => candle(i * step));
  const result = evaluateRefinedSwing("R_25", "Volatility 25", {
    M5: makeSeries(70, 300),
    M15: makeSeries(30, 900),
    H1: makeSeries(70, 3600),
    H4: makeSeries(55, 14400),
    D1: makeSeries(55, 86400)
  });
  assert.notEqual(result.state, "signal");
  assert.ok(["timeframe_conflict", "setup_not_confirmed", "waiting_m15_confirmation",
    "waiting_m5_trigger", "data_gap", "warming"].includes(result.state));
});
