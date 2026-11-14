"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateTradeManagement, favorableR } = require("../swing_trade_management");

function series(count, step, start, direction = "up", startPrice = 100) {
  return Array.from({ length: count }, (_, index) => {
    const close = startPrice + (direction === "up" ? 1 : -1) * index * 0.2;
    return { epoch: start + index * step, open: close - (direction === "up" ? 0.05 : -0.05),
      high: close + 0.1, low: close - 0.1, close };
  });
}
function frames(direction = "up", lastM5 = null) {
  const result = {
    M5: series(80, 300, 1_700_000_000, direction),
    M15: series(80, 900, 1_700_000_000, direction),
    H1: series(80, 3600, 1_700_000_000, direction),
    H4: series(80, 14400, 1_700_000_000, direction),
    D1: series(80, 86400, 1_700_000_000, direction)
  };
  if (lastM5) result.M5[result.M5.length - 1] = { ...result.M5.at(-1), ...lastM5 };
  return result;
}
const position = (overrides = {}) => ({
  marketId: "R_25", direction: "BUY", entry: 100, stopLoss: 90,
  tp1: 115, tp2: 125, riskDistance: 10, partialTaken: false, ...overrides
});

test("calculates favourable movement in R for long and short positions", () => {
  assert.equal(favorableR(position(), 110), 1);
  assert.equal(favorableR(position({ direction: "SELL", entry: 100, stopLoss: 110 }), 90), 1);
});

test("waits rather than advising when a required timeframe is missing", () => {
  const data = frames();
  data.H4 = [];
  assert.equal(evaluateTradeManagement({ position: position(), candlesByTimeframe: data }).action, "WAIT_FOR_DATA");
});

test("refuses to infer the order when stop and target are touched in the same M5 candle", () => {
  const data = frames("up", { low: 89, high: 116 });
  assert.equal(evaluateTradeManagement({ position: position(), candlesByTimeframe: data }).action, "AMBIGUOUS_BARRIER");
});

test("advises an early exit when H1 and M15 both reverse before the original stop", () => {
  const data = frames("up", { open: 104.9, high: 105.1, low: 104.8, close: 105 });
  data.H1 = series(80, 3600, 1_700_000_000, "down", 130);
  data.M15 = series(80, 900, 1_700_000_000, "down", 130);
  const result = evaluateTradeManagement({ position: position(), candlesByTimeframe: data });
  assert.equal(result.action, "EXIT_EARLY");
  assert.ok(result.currentPrice > 90);
});

test("advises break-even only after price reaches the configured +1R threshold", () => {
  const data = frames("up", { close: 110, open: 109.9, high: 110.1, low: 109.8 });
  const result = evaluateTradeManagement({ position: position(), candlesByTimeframe: data });
  assert.equal(result.action, "MOVE_TO_BREAK_EVEN");
  assert.equal(result.suggestedStopLoss, 100);
});

test("advises partial profit when TP1 is touched without an ambiguous same-candle barrier", () => {
  const data = frames("up", { close: 114, open: 113.8, high: 115.2, low: 113.7 });
  const result = evaluateTradeManagement({ position: position(), candlesByTimeframe: data });
  assert.equal(result.action, "PARTIAL_PROFIT");
});

test("advises closing the remainder when TP2 is touched", () => {
  const data = frames("up", { close: 125, open: 124.8, high: 125.2, low: 124.7 });
  const result = evaluateTradeManagement({ position: position({ partialTaken: true }), candlesByTimeframe: data });
  assert.equal(result.action, "CLOSE_REMAINDER");
});

test("does not recommend break-even when the long stop already protects profit", () => {
  const data = frames("up", { close: 110, open: 109.9, high: 110.1, low: 109.8 });
  const result = evaluateTradeManagement({ position: position({ stopLoss: 103 }), candlesByTimeframe: data });
  assert.notEqual(result.action, "MOVE_TO_BREAK_EVEN");
});
