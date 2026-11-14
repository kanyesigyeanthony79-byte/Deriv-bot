"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { completedTail, simulateFixedPlanOutcome, simulateManagedOutcome, summarizeManaged } = require("../swing_trade_management_replay");

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

test("lifecycle replay exits a profitable position when both H4 and D1 invalidate the swing", () => {
  const frames = data();
  frames.H1 = series(80, 3600, END, "down", 130);
  frames.M15 = series(80, 900, END, "down", 130);
  frames.H4 = series(80, 14400, END, "down", 130);
  frames.D1 = series(80, 86400, END, "down", 130);
  const result = simulateManagedOutcome(signal(), frames, 70, { maxHoldBars: 5 });
  assert.equal(result.status, "early_exit");
  assert.ok(result.realizedR > 0);
  assert.ok(result.exitPrice > signal().stopLoss);
});

test("lifecycle replay keeps a profitable runner open when only H1 and M15 reverse", () => {
  const frames = data();
  frames.H1 = series(80, 3600, END, "down", 130);
  frames.M15 = series(80, 900, END, "down", 130);
  const result = simulateManagedOutcome(signal(), frames, 70, { maxHoldBars: 5 });
  assert.notEqual(result.status, "early_exit");
  assert.equal(result.partialTaken, true);
  assert.ok(result.realizedR > 0);
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


test("fixed-plan benchmark books half at TP1 and closes the rest at TP2", () => {
  const frames = data();
  frames.M5[71] = { ...frames.M5[71], open: 114.8, high: 115.2, low: 114.7, close: 115 };
  frames.M5[72] = { ...frames.M5[72], open: 124.8, high: 125.2, low: 124.7, close: 125 };
  const result = simulateFixedPlanOutcome(signal(), frames, 70, { maxHoldBars: 5, partialFraction: 0.5 });
  assert.equal(result.status, "tp2_exit");
  assert.equal(result.realizedR, 2);
});

test("fixed-plan benchmark records a partial TP1 gain when the remaining half hits the original stop", () => {
  const frames = data();
  frames.M5[71] = { ...frames.M5[71], open: 114.8, high: 115.2, low: 114.7, close: 115 };
  frames.M5[72] = { ...frames.M5[72], open: 115.1, high: 116, low: 89, close: 90 };
  const result = simulateFixedPlanOutcome(signal(), frames, 70, { maxHoldBars: 5, partialFraction: 0.5 });
  assert.equal(result.status, "stop_after_tp1");
  assert.equal(result.realizedR, 0.25);
});

test("summary reports winning trade duration and profit factor", () => {
  const summary = summarizeManaged([
    { status: "tp2_exit", realizedR: 2, barsHeld: 100 },
    { status: "stop_before_tp1", realizedR: -1, barsHeld: 20 }
  ]);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.profitFactor, 2);
  assert.equal(summary.averageWinningHoldBars, 100);
  assert.equal(summary.longestWinningHoldBars, 100);
});
