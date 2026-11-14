"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { METHODS, deriveStop, completedFrames } = require("../top_down_swing_m15_stop_experiment");
const { atr } = require("../top_down_swing_engine");

function makeFrames() {
  const M15 = [];
  for (let i = 0; i < 32; i++) {
    const close = 100 + i * 0.1;
    let low = close - 0.2;
    if (i === 25) low = close - 1.2;
    M15.push({
      epoch: 100000 + i * 900,
      open: close - 0.05,
      high: close + 0.2,
      low,
      close
    });
  }
  return { M15 };
}

test("completedFrames excludes any M15 candle not closed by decision time", () => {
  const frames = makeFrames();
  const result = completedFrames(frames, frames.M15.at(-1).epoch + 900);
  assert.equal(result.M15.length, frames.M15.length);
  assert.equal(completedFrames(frames, frames.M15.at(-1).epoch + 899).M15.length, frames.M15.length - 1);
});

test("H4 hybrid stop preserves the existing structural invalidation", () => {
  const signal = { direction: "BUY", entry: 104, stopLoss: 99, decisionEpoch: 100000 + 32 * 900 };
  const stop = deriveStop(signal, makeFrames(), METHODS.H4_HYBRID);
  assert.equal(stop.stopLoss, 99);
  assert.equal(stop.riskDistance, 5);
});

test("M15 ATR stop uses the fixed 1.5 ATR distance on the same entry", () => {
  const frames = makeFrames();
  const signal = { direction: "BUY", entry: 104, stopLoss: 99, decisionEpoch: frames.M15.at(-1).epoch + 900 };
  const stop = deriveStop(signal, frames, METHODS.M15_ATR_1_5);
  assert.ok(stop);
  assert.equal(stop.source, METHODS.M15_ATR_1_5);
  assert.ok(Math.abs(stop.riskDistance - 1.5 * atr(completedFrames(frames, signal.decisionEpoch).M15)) < 1e-9);
  assert.ok(stop.stopLoss < signal.entry);
});

test("M15 structural stop uses a confirmed pivot and remains on the protective side", () => {
  const frames = makeFrames();
  const signal = { direction: "BUY", entry: 104, stopLoss: 99, decisionEpoch: frames.M15.at(-1).epoch + 900 };
  const stop = deriveStop(signal, frames, METHODS.M15_STRUCTURAL);
  assert.ok(stop);
  assert.equal(stop.source, METHODS.M15_STRUCTURAL);
  assert.ok(stop.stopLoss < signal.entry);
  assert.ok(stop.riskDistance > 0);
});

test("unknown stop methods are rejected", () => {
  assert.throws(() => deriveStop({}, {}, "OPTIMIZE"), /Unknown stop method/);
});
