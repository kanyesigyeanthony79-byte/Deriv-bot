"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateOutcome, summarize } = require("../swing_historical_validation");

const candle = (low, high) => ({ low, high });
const signal = { direction: "BUY", stopLoss: 95, tp1: 110, tp2: 120 };

test("historical replay marks a same-candle stop and TP1 as ambiguous", () => {
  const bars = [candle(100, 105), candle(94, 111), ...Array.from({length: 2015}, () => candle(100, 105))];
  assert.equal(simulateOutcome(signal, bars, 0).status, "ambiguous_sl_tp1_same_candle");
});

test("historical replay identifies stop before TP1", () => {
  const bars = [candle(100, 105), candle(94, 105), ...Array.from({length: 2015}, () => candle(100, 105))];
  assert.equal(simulateOutcome(signal, bars, 0).status, "stop_before_tp1");
});

test("historical replay identifies TP2 after TP1", () => {
  const bars = [candle(100, 105), candle(100, 111), candle(100, 121), ...Array.from({length: 2014}, () => candle(100, 105))];
  assert.equal(simulateOutcome(signal, bars, 0).status, "tp2_after_tp1");
});

test("historical replay does not score a trade without a full seven-day outcome window", () => {
  assert.equal(simulateOutcome(signal, [candle(100, 105), candle(100, 105)], 0).status, "incomplete_window");
});

test("summary reports resolved outcomes separately from incomplete windows", () => {
  const s = summarize([{status:"stop_before_tp1"},{status:"tp2_after_tp1"},{status:"incomplete_window"}]);
  assert.equal(s.signals, 3);
  assert.equal(s.resolvedSignals, 2);
  assert.equal(s.tp1Reached, 1);
  assert.equal(s.tp2Reached, 1);
});
