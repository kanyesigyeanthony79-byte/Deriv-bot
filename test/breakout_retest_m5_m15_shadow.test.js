"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectBreakout, m15ContextAt, findM5RetestConfirmation,
  updateSignalOutcome, updateJournal, TERMINAL
} = require("../breakout_retest_m5_m15_shadow");

const START = Math.floor(1_700_000_000 / 900) * 900;

function risingM15(count = 100) {
  const base = START - count * 900;
  return Array.from({ length: count }, (_, i) => {
    const close = 90 + i * 0.1;
    return { epoch: base + i * 900, open: close - 0.05, high: close + 0.2, low: close - 0.2, close };
  });
}

function flatM5(count = 100) {
  return Array.from({ length: count }, (_, i) => ({
    epoch: START + i * 300, open: 100.2, high: 100.4, low: 100.0, close: 100.2
  }));
}

test("detects breakout beyond the prior 12 completed M5 candles", () => {
  const m5 = flatM5(13);
  m5[12] = { ...m5[12], open: 100.3, high: 100.8, low: 100.2, close: 100.7 };
  assert.deepEqual(detectBreakout(m5, 12, 0.4), { direction: 1, boundary: 100.4, atr5: 0.4 });
});

test("M15 direction uses only fully closed M15 candles", () => {
  const m15 = risingM15(100);
  const setupClose = START + 80 * 300 + 300;
  assert.equal(m15ContextAt(m15, setupClose), "up");
  const only54Closed = m15.filter(c => c.epoch + 900 <= setupClose).slice(-54);
  const futureCandle = { epoch: setupClose, open: 100, high: 100.2, low: 99.8, close: 100 };
  assert.equal(m15ContextAt([...only54Closed, futureCandle], setupClose), "unknown");
});

test("M5 retest requires a strong candle closing back beyond the breakout level", () => {
  const m5 = flatM5(10);
  m5[5] = { epoch: m5[5].epoch, open: 100.1, high: 100.9, low: 99.9, close: 100.8 };
  const atr = Array(10).fill(0.4);
  const result = findM5RetestConfirmation(m5, 5, { direction: 1, boundary: 100.4, atr5: 0.4 }, atr);
  assert.deepEqual(result, { triggerIndex: 5, entryIndex: 6, atr5: 0.4 });
});

test("M5 retest rejects weak or wrong-side closes", () => {
  const m5 = flatM5(10);
  m5[5] = { epoch: m5[5].epoch, open: 100.1, high: 100.3, low: 99.9, close: 100.2 };
  assert.equal(findM5RetestConfirmation(m5, 5, { direction: 1, boundary: 100.4, atr5: 0.4 }, Array(10).fill(0.4)), null);
});

function sampleSignal() {
  return {
    direction: "BUY", entry: 100, stopLoss: 99, tp2: 102, riskDistance: 1,
    entryCandleEpoch: START, lastProcessedEpoch: START - 300,
    status: "pending", outcomeCandles: 0, maxFavourableR: 0, maxAdverseR: 0,
    realizedR: null
  };
}

test("M5 outcome monitor resolves target, stop and same-candle ambiguity", () => {
  const target = sampleSignal();
  updateSignalOutcome(target, [{ epoch: START, open: 100, high: 102.1, low: 99.5, close: 102 }]);
  assert.equal(target.status, "tp2_hit");
  assert.equal(target.realizedR, 2);

  const stopped = sampleSignal();
  updateSignalOutcome(stopped, [{ epoch: START, open: 100, high: 101, low: 98.9, close: 99 }]);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.realizedR, -1);

  const ambiguous = sampleSignal();
  updateSignalOutcome(ambiguous, [{ epoch: START, open: 100, high: 102.1, low: 98.9, close: 100 }]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.realizedR, null);
});

test("forward journal waits for fresh bars, then creates only M15-aligned M5-entry signal", () => {
  const m5 = flatM5(80);
  const m15 = risingM15(100);
  const market = { marketName: "Volatility 10 Index", timeframes: { M5: m5, M15: m15 } };
  let journal = updateJournal(null, { R_10: market }, START + 80 * 300);
  assert.equal(journal.signals.length, 0);
  assert.equal(journal.markets.R_10.lastProcessedM5Epoch, m5.at(-1).epoch);

  m5[80] = { epoch: START + 80 * 300, open: 100.3, high: 100.8, low: 100.2, close: 100.7 };
  m5[81] = { epoch: START + 81 * 300, open: 100.1, high: 100.9, low: 99.9, close: 100.8 };
  m5[82] = { epoch: START + 82 * 300, open: 100.2, high: 100.4, low: 100.0, close: 100.2 };
  journal = updateJournal(journal, { R_10: market }, START + 83 * 300);
  assert.equal(journal.signals.length, 1);
  assert.equal(journal.signals[0].strategyId, "M5_BREAKOUT_M5_RETEST_M15_CONFIRM");
  assert.equal(journal.signals[0].entryTimeframe, "M5");
  assert.equal(journal.signals[0].confirmationTimeframe, "M15");
  assert.equal(journal.signals[0].m15Context, "up");
  assert.equal(journal.signals[0].entryCandleEpoch, START + 82 * 300);
  assert.equal(journal.signals[0].status, "pending");
  assert.equal(journal.summary.comparisonModel.targetR, 2);
  assert.equal(journal.summary.productionCompatibility.productionStatus, "not_enabled");
  assert.ok(TERMINAL.has("ambiguous"));
});

test("forward journal rejects breakout when M15 direction is not aligned", () => {
  const m5 = flatM5(80);
  const m15 = Array.from({ length: 100 }, (_, i) => {
    const close = 110 - i * 0.1;
    return { epoch: START - 100 * 900 + i * 900, open: close + 0.05, high: close + 0.2, low: close - 0.2, close };
  });
  const market = { timeframes: { M5: m5, M15: m15 } };
  let journal = updateJournal(null, { R_10: market }, START + 80 * 300);
  m5[80] = { epoch: START + 80 * 300, open: 100.3, high: 100.8, low: 100.2, close: 100.7 };
  market.timeframes.M5 = m5;
  journal = updateJournal(journal, { R_10: market }, START + 81 * 300);
  assert.equal(journal.signals.length, 0);
  assert.equal(journal.markets.R_10.stats.m15Rejected, 1);
});
