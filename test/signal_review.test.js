"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { reviewSignal } = require("../signal_review");

const base = {
  signalId: "AUDIT-M5-001", direction: "BUY", entryTimeframe: "M5",
  entryCandleEpoch: 100, entry: 100, stopLoss: 90, tp1: 110, tp2: 120
};
const candle = (epoch, high, low, close = 105) => ({ epoch, open: 100, high, low, close });

test("terminal stopped signal preserves journal outcome despite later TP candle", () => {
  const result = reviewSignal({ ...base, status: "stopped", stopEpoch: 400 }, {
    M5: [candle(100, 105, 95), candle(400, 105, 89), candle(700, 125, 100)]
  }, 1000);
  assert.equal(result.status, "JOURNAL_STOP_RECORDED");
  assert.equal(result.journalStatus, "stopped");
  assert.equal(result.terminalEpoch, 400);
  assert.equal(result.reconciliation, "JOURNAL_TERMINAL_OUTCOME_PRESERVED");
});

test("terminal TP2 signal preserves journal outcome despite later stop candle", () => {
  const result = reviewSignal({ ...base, status: "tp2_hit", tp1Hit: true, tp1Epoch: 400, tp2Epoch: 700 }, {
    M5: [candle(100, 105, 95), candle(400, 112, 99), candle(700, 125, 100), candle(1000, 105, 85)]
  }, 1300);
  assert.equal(result.status, "JOURNAL_TP2_RECORDED");
  assert.equal(result.terminalEpoch, 700);
});

test("expired signal excludes later target and stop touches", () => {
  const result = reviewSignal({ ...base, status: "expired", expiredEpoch: 1000, intendedExpiryEpoch: 900 }, {
    M5: [candle(100, 105, 95), candle(700, 105, 95), candle(1000, 125, 85)]
  }, 1400);
  assert.equal(result.status, "JOURNAL_EXPIRED_RECORDED");
  assert.equal(result.intendedExpiryEpoch, 900);
  assert.equal(result.reconciliation, "JOURNAL_TERMINAL_OUTCOME_PRESERVED");
  assert.match(result.reason, /later price movements are excluded/);
});

test("expired legacy signal with missing expiry boundary is explicitly non-comparable", () => {
  const result = reviewSignal({ ...base, status: "expired", intendedExpiryEpoch: null }, {
    M5: [candle(100, 105, 95), candle(700, 125, 95)]
  }, 1100);
  assert.equal(result.status, "JOURNAL_EXPIRED_RECORDED");
  assert.equal(result.intendedExpiryEpoch, null);
  assert.equal(result.reconciliation, "NON_COMPARABLE_MISSING_EXPIRY_BOUNDARY");
  assert.match(result.reason, /no boundary is inferred/);
});

test("active signal replay stops at intended expiry boundary", () => {
  const result = reviewSignal({ ...base, status: "pending", intendedExpiryEpoch: 900 }, {
    M5: [candle(100, 105, 95), candle(400, 112, 99), candle(700, 115, 99), candle(1000, 125, 95)]
  }, 1300);
  assert.notEqual(result.status, "TP2_LEVEL_TOUCHED");
  assert.equal(result.tp1Reached, true);
  assert.equal(result.tp1Epoch, 400);
});

test("same-candle stop and target remains ambiguous for active signal", () => {
  const result = reviewSignal({ ...base, status: "pending", intendedExpiryEpoch: 1500 }, {
    M5: [candle(100, 105, 95), candle(400, 121, 89)]
  }, 800);
  assert.equal(result.status, "AMBIGUOUS_CANDLE");
});
