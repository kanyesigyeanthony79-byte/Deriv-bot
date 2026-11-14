"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { completedAtOrBefore, recentBreakout, evaluateSwingReversalSniper } = require("../swing_reversal_sniper");

const candle = (epoch, close = 100, range = 1) => ({
  epoch, open: close - 0.1, high: close + range, low: close - range, close
});

test("higher-timeframe cutoffs exclude candles not completed at the M5 close", () => {
  const result = completedAtOrBefore([candle(0), candle(3600), candle(7200)], "H1", 7200);
  assert.deepEqual(result.map(c => c.epoch), [0, 3600]);
});

test("structural breakout is compared only with preceding candles", () => {
  const bars = Array.from({length: 12}, (_, i) => candle(i * 300, 100 + i * 0.1));
  bars[11] = { epoch: 3300, open: 102, high: 104, low: 101, close: 103 };
  const result = recentBreakout(bars, "BUY", 10, 2);
  assert.equal(result.index, 11);
  assert.equal(result.level, Math.max(...bars.slice(1, 11).map(c => c.high)));
});

test("sniper candidate waits rather than signalling with insufficient history", () => {
  const result = evaluateSwingReversalSniper("R_25", "Volatility 25", {
    M5: [candle(300)], M15: [], H1: [], H4: [], D1: []
  });
  assert.equal(result.state, "warming");
  assert.equal(result.timeframe, "M5");
});

test("sniper candidate never signals from incomplete timeframe coverage", () => {
  const series = (count, step) => Array.from({length: count}, (_, i) => candle(i * step));
  const result = evaluateSwingReversalSniper("R_25", "Volatility 25", {
    M5: series(70, 300), M15: series(30, 900), H1: series(70, 3600),
    H4: series(55, 14400), D1: series(55, 86400)
  });
  assert.notEqual(result.state, "signal");
  assert.ok(["reversal_watch", "reversal_confirming", "pullback_wait", "entry_armed",
    "invalid_risk", "warming"].includes(result.state));
});

test("sniper candidate suppresses decisions when a required timeframe has a candle gap", () => {
  const series = (count, step) => Array.from({length: count}, (_, i) => candle(i * step));
  const frames = {
    M5: series(70, 300), M15: series(30, 900), H1: series(70, 3600),
    H4: series(60, 14400), D1: series(55, 86400)
  };
  frames.H4[40] = { ...frames.H4[40], epoch: frames.H4[40].epoch + 14400 };
  const result = evaluateSwingReversalSniper("R_25", "Volatility 25", frames);
  assert.equal(result.state, "data_gap");
  assert.equal(result.timeframe, "H4");
});
