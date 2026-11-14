"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { completedTail, simulateManagedOutcome } = require("../swing_trade_management_replay");

function series(count, step, end, direction = "up", startPrice = 100) {
  const start = end - count * step;
  return Array.from({ length: count }, (_, index) => {
    const close = startPrice + (direction === "up" ? 1 : -1) * index * 0.2;
    return { epoch: start + index * step, open: close - (direction === "up" ? 0.05 : -0.05),
      high: close + 0.1, low: close - 0.1, close };
  });
}
const END = 1_700_000_000 + 80 * 300;
function data() {
  return {
    M5: series(80, 300, END),
    M15: series(80, 900, END),
    H1: series(80, 3600, END),
    H4: series(80, 14400, END),
    D1: series(80, 86400, END)
  };
}
const signal = () => ({ marketId: "R_25", direction: "BUY", entry: 100, stopLoss: 90,
  tp1: 115, tp2: 125, riskDistance: 10 });

test("completedTail excludes a higher-timeframe candle that has not closed", () => {
  const candles = series(60, 900, END);
  const tail = completedTail(candles, "M15", END - 1, 120);
  assert.equal(tail.length, 59);
});

test("lifecycle replay exits early when H1 and M15 reverse before the original stop", () => {
  const frames = data();
  frames.H1 = series(80, 3600, END, "down", 130);
  frames.M15 = series(80, 900, END, "down", 130);
  const result = simulateManagedOutcome(signal(), frames, 70, { maxHoldBars: 5 });
  assert.equal(result.status, "early_exit");
  assert.ok(result.realizedR > 0);
  assert.ok(result.exitPrice > signal().stopLoss);
});

test("lifecycle replay records a break-even exit after the +1R protection advice", () => {
  const frames = data();
  frames.M5[71] = { ...frames.M5[71], open: 109.9, high: 110.1, low: 109.8, close: 110 };
  frames.M5[72] = { ...frames.M5[72], open: 100.2, high: 111, low: 99, close: 100.5 };
  const result = simulateManagedOutcome(signal(), frames, 70, { maxHoldBars: 5 });
  assert.equal(result.status, "break_even_exit");
  assert.equal(result.realizedR, 0);
});

test("lifecycle replay accounts for partial TP1 profit followed by a break-even exit", () => {
  const frames = data();
  frames.M5[71] = { ...frames.M5[71], open: 114.8, high: 115.2, low: 114.7, close: 115 };
  frames.M5[72] = { ...frames.M5[72], open: 115.1, high: 116, low: 99, close: 100.5 };
  const result = simulateManagedOutcome(signal(), frames, 70, { maxHoldBars: 5, partialFraction: 0.5 });
  assert.equal(result.status, "break_even_after_partial");
  assert.equal(result.realizedR, 0.75);
});
