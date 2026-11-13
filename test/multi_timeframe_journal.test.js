"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { touchStatus, updateJournal, summarizeJournal } = require("../multi_timeframe_journal");

const signal = {
  signalId: "JD100-SWING-100", marketId: "JD100", direction: "BUY",
  entryTimeframe: "H1", entryCandleEpoch: 100, entry: 100,
  stopLoss: 90, tp1: 110, tp2: 120, maxAgeSeconds: 1000
};
const candle = (epoch, high, low) => ({ epoch, open: 100, high, low, close: 100 });

test("detects target and stop outcomes without assuming intrabar order", () => {
  assert.equal(touchStatus(signal, candle(200, 111, 95)), "tp1_hit");
  assert.equal(touchStatus(signal, candle(200, 121, 95)), "tp2_hit");
  assert.equal(touchStatus(signal, candle(200, 111, 89)), "ambiguous");
  assert.equal(touchStatus(signal, candle(200, 105, 89)), "stopped");
});

test("journal keeps market and category signal IDs separate and updates outcomes", () => {
  const first = updateJournal({ version: 1, signals: [] }, {
    JD100: { marketId: "JD100", signals: [{ ...signal, state: "signal" }], timeframes: { H1: [candle(100, 105, 95)] } }
  }, 150);
  assert.equal(first.signals.length, 1);
  assert.equal(first.signals[0].status, "pending");
  const second = updateJournal(first, {
    JD100: { marketId: "JD100", signals: [{ ...signal, state: "signal" }], timeframes: { H1: [candle(100, 105, 95), candle(200, 112, 99)] } }
  }, 250);
  assert.equal(second.signals[0].status, "tp1_hit");
  assert.equal(second.signals[0].tp1Hit, true);
  assert.equal(second.signals[0].outcomeCandles, 1);
  const third = updateJournal(second, {
    JD100: { marketId: "JD100", signals: [{ ...signal, state: "signal" }], timeframes: { H1: [candle(100, 105, 95), candle(200, 112, 99)] } }
  }, 350);
  assert.equal(third.signals[0].outcomeCandles, 1);
  assert.deepEqual(summarizeJournal(third), { tp1_hit: 1 });
});

test("journal expires an unclosed observation after its category age limit", () => {
  const result = updateJournal({ version: 1, signals: [{ ...signal, status: "pending", createdEpoch: 100, tp1Hit: false }] }, {}, 1200);
  assert.equal(result.signals[0].status, "expired");
});
