"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectBreakout, findRetestConfirmation, updateSignalOutcome,
  updateBreakoutRetestJournal, summarizeBreakoutRetestJournal, TERMINAL
} = require("../breakout_retest_shadow");

function candles(count, step, start = 1_700_000_000, price = 100) {
  return Array.from({ length: count }, (_, i) => ({
    epoch: start + i * step,
    open: price,
    high: price + 0.2,
    low: price - 0.2,
    close: price
  }));
}

test("detects an upside breakout beyond the previous 12 completed M5 candles", () => {
  const m5 = candles(13, 300);
  m5[12] = { ...m5[12], open: 101, high: 101.4, low: 100.9, close: 101.2 };
  assert.deepEqual(detectBreakout(m5, 12, 1), { direction: 1, boundary: 100.2, atr5: 1 });
});

test("detects a downside breakout beyond the previous 12 completed M5 candles", () => {
  const m5 = candles(13, 300);
  m5[12] = { ...m5[12], open: 99, high: 99.1, low: 98.6, close: 98.8 };
  assert.deepEqual(detectBreakout(m5, 12, 1), { direction: -1, boundary: 99.8, atr5: 1 });
});

test("M1 confirmation requires a retest, strong body and directional close", () => {
  const m1 = candles(8, 60);
  m1[4] = { epoch: m1[4].epoch, open: 100.1, high: 100.9, low: 99.9, close: 100.8 };
  const atr1 = Array(8).fill(1);
  const found = findRetestConfirmation(m1, 4, { direction: 1, boundary: 100, atr5: 1 }, atr1);
  assert.deepEqual(found, { triggerIndex: 4, entryIndex: 5, atr1: 1 });
});

test("M1 confirmation rejects a weak candle and does not enter before the next candle", () => {
  const m1 = candles(8, 60);
  m1[4] = { epoch: m1[4].epoch, open: 100.1, high: 100.3, low: 99.9, close: 100.2 };
  assert.equal(findRetestConfirmation(m1, 4, { direction: 1, boundary: 100, atr5: 1 }, Array(8).fill(1)), null);
});

function signal() {
  return {
    direction: "BUY", entry: 100, stopLoss: 99, tp2: 102, riskDistance: 1,
    entryCandleEpoch: 1_700_000_000, lastProcessedEpoch: 1_699_999_940,
    status: "pending", outcomeCandles: 0, maxFavourableR: 0, maxAdverseR: 0,
    realizedR: null
  };
}

test("outcome monitor records target, stop and same-candle ambiguity conservatively", () => {
  const target = signal();
  updateSignalOutcome(target, [{ epoch: target.entryCandleEpoch, open: 100, high: 102.1, low: 99.5, close: 102 }]);
  assert.equal(target.status, "tp2_hit");
  assert.equal(target.realizedR, 2);

  const stopped = signal();
  updateSignalOutcome(stopped, [{ epoch: stopped.entryCandleEpoch, open: 100, high: 101, low: 98.9, close: 99 }]);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.realizedR, -1);

  const ambiguous = signal();
  updateSignalOutcome(ambiguous, [{ epoch: ambiguous.entryCandleEpoch, open: 100, high: 102.1, low: 98.9, close: 100 }]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.realizedR, null);
});

test("60 completed M1 bars close an unresolved observation at market close", () => {
  const s = signal();
  const m1 = Array.from({ length: 60 }, (_, i) => ({
    epoch: s.entryCandleEpoch + i * 60,
    open: 100, high: 100.2, low: 99.8, close: 100.1
  }));
  updateSignalOutcome(s, m1);
  assert.equal(s.status, "time_exit");
  assert.equal(s.outcomeCandles, 60);
  assert.equal(s.realizedR, 0.1);
  assert.ok(TERMINAL.has(s.status));
});

test("forward journal records a new M5 breakout and its next-M1-open retest entry", () => {
  const start = Math.floor(1_700_000_000 / 900) * 900;
  const m1 = Array.from({ length: 500 }, (_, i) => ({
    epoch: start + i * 60, open: 100, high: 100.2, low: 99.8, close: 100
  }));
  const m5 = Array.from({ length: 81 }, (_, i) => ({
    epoch: start + i * 300, open: 100, high: 100.2, low: 99.8, close: 100
  }));
  const m15 = Array.from({ length: 100 }, (_, i) => ({
    epoch: start + i * 900, open: 100, high: 100.2, low: 99.8, close: 100
  }));
  const market = { marketName: "Volatility 10 Index", timeframes: { M1: m1, M5: m5.slice(0, 80), M15: m15 } };
  let journal = updateBreakoutRetestJournal(null, { R_10: market }, start + 80 * 300);
  m5[80] = { epoch: start + 80 * 300, open: 100.2, high: 100.6, low: 100.1, close: 100.5 };
  m1[406] = { epoch: start + 406 * 60, open: 100.1, high: 100.9, low: 99.9, close: 100.8 };
  market.timeframes.M5 = m5;
  journal = updateBreakoutRetestJournal(journal, { R_10: market }, start + 80 * 300 + 600);
  assert.equal(journal.signals.length, 1);
  assert.equal(journal.signals[0].strategyId, "M5_BREAKOUT_M1_RETEST");
  assert.equal(journal.signals[0].entryCandleEpoch, start + 407 * 60);
  assert.equal(journal.signals[0].direction, "BUY");
  assert.equal(journal.signals[0].status, "pending");
});

test("forward journal initializes at the latest M5 candle without historical backfill", () => {
  const start = Math.floor(1_700_000_000 / 900) * 900;
  const market = {
    marketName: "Volatility 10 Index",
    timeframes: {
      M1: candles(100, 60, start),
      M5: candles(100, 300, start),
      M15: candles(100, 900, start)
    }
  };
  const first = updateBreakoutRetestJournal(null, { R_10: market }, start + 100_000);
  assert.equal(first.markets.R_10.lastProcessedM5Epoch, market.timeframes.M5.at(-1).epoch);
  assert.equal(first.signals.length, 0);
  assert.equal(first.summary.mode, "forward_shadow_observation_only");

  const second = updateBreakoutRetestJournal(first, { R_10: market }, start + 100_300);
  assert.equal(second.signals.length, 0);
  assert.equal(second.markets.R_10.lastProcessedM5Epoch, market.timeframes.M5.at(-1).epoch);
});

test("breakout-retest summary does not publish unverified historical holdout metrics", () => {
  const summary = summarizeBreakoutRetestJournal({ version: 1, signals: [], markets: {} });
  assert.equal(Object.hasOwn(summary, "historicalHoldout"), false);
});
