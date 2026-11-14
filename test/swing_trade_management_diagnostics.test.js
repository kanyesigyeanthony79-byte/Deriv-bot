"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { diagnoseTradePath } = require("../swing_trade_management_diagnostics");

const candles = [
  { epoch: 0, open: 100, high: 100, low: 100, close: 100 },
  { epoch: 300, open: 100, high: 112, low: 98, close: 108 },
  { epoch: 600, open: 108, high: 116, low: 105, close: 110 },
  { epoch: 900, open: 110, high: 130, low: 109, close: 125 },
  { epoch: 1200, open: 125, high: 126, low: 100, close: 102 }
];
const signal = { direction: "BUY", entry: 100, stopLoss: 90, riskDistance: 10, tp1: 115, tp2: 125 };

test("diagnostics measure MFE, MAE, time to +1R and peak-to-exit giveback", () => {
  const result = diagnoseTradePath(signal, candles, 0, {
    status: "early_exit", barsHeld: 2, exitR: 1
  }, { maxHoldBars: 4 });
  assert.equal(result.maxFavorableR, 1.6);
  assert.equal(result.maxAdverseR, -0.2);
  assert.equal(result.timeTo1RBars, 1);
  assert.equal(result.peakToExitGivebackR, 0.6);
});

test("early-exit diagnostics show whether the original targets or stop followed", () => {
  const result = diagnoseTradePath(signal, candles, 0, {
    status: "early_exit", barsHeld: 2, exitR: 1
  }, { maxHoldBars: 4 });
  assert.equal(result.afterEarlyExit.reachedOriginalTP1, true);
  assert.equal(result.afterEarlyExit.reachedOriginalTP2, true);
  assert.equal(result.afterEarlyExit.reachedOriginalStop, false);
  assert.equal(result.afterEarlyExit.maxFavorableR, 3);
});

test("diagnostics refuse incomplete outcomes instead of guessing", () => {
  assert.equal(diagnoseTradePath(signal, candles, 0, { status: "data_unavailable" }).diagnosticStatus,
    "insufficient_path_data");
});
