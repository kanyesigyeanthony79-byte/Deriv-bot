"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { touchStatus, applyLiveQuote, updateJournal, summarizeJournal, dashboardSignalsForMarket } = require("../multi_timeframe_journal");

const signal = {
  signalId: "JD100-SWING-100", marketId: "JD100", direction: "BUY",
  entryTimeframe: "H1", entryCandleEpoch: 100, entry: 100,
  stopLoss: 90, tp1: 110, tp2: 120, maxAgeSeconds: 10000
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

test("records maximum favourable movement before a terminal outcome", () => {
  const buySignal = { ...signal, signalId: "JD100-SHORT_TERM-200", category: "SHORT_TERM", state: "signal" };
  const first = updateJournal({ version: 1, signals: [] }, {
    JD100: { marketId: "JD100", signals: [buySignal], timeframes: { H1: [candle(100, 105, 95), candle(200, 108, 99)] } }
  }, 250);
  assert.equal(first.signals[0].maxFavourablePoints, 8);
  assert.equal(first.signals[0].maxFavourablePrice, 108);
  const second = updateJournal(first, {
    JD100: { marketId: "JD100", signals: [buySignal], timeframes: { H1: [candle(100, 105, 95), candle(200, 108, 99), candle(300, 111, 99)] } }
  }, 350);
  assert.equal(second.signals[0].maxFavourablePoints, 11);
  assert.equal(second.signals[0].status, "tp1_hit");
});

test("journal expires an unclosed observation after its category age limit", () => {
  const result = updateJournal({ version: 1, signals: [{ ...signal, status: "pending", createdEpoch: 100, tp1Hit: false }] }, {}, 10101);
  assert.equal(result.signals[0].status, "expired");
});


test("outcomes and MFE ignore completed candles that close after the observation deadline", () => {
  const buySignal = { ...signal, signalId: "JD100-SHORT_TERM-EXPIRY", category: "SHORT_TERM", state: "signal" };
  const result = updateJournal({ version: 1, signals: [] }, {
    JD100: { marketId: "JD100", signals: [buySignal], timeframes: { H1: [
      candle(100, 105, 95),
      candle(200, 108, 99),
      candle(11000, 130, 99)
    ] } }
  }, 12000);
  const record = result.signals[0];
  assert.equal(record.status, "expired");
  assert.equal(record.outcomeCandles, 1);
  assert.equal(record.maxFavourablePoints, 8, "post-expiry MFE must not be credited");
  assert.equal(record.tp1Hit, false, "post-expiry TP1 must not be credited");
});

test("a live quote received after expiry cannot turn an expired observation into TP2", () => {
  const record = { ...signal, signalId: "late-quote", status: "pending", createdEpoch: 100, tp1Hit: false };
  const result = updateJournal({ version: 1, signals: [record] }, {}, 12000, {
    JD100: { price: 122, epoch: 12000 }
  });
  assert.equal(result.signals[0].status, "expired");
  assert.equal(result.signals[0].tp2Epoch ?? null, null);
});

test("dashboard projection includes only journal-confirmed active signals with a fresh quote", () => {
  const regular = { ...signal, signalId: "JD100-SWING-100", state: "signal", marketId: "JD100" };
  const recentOnly = { ...signal, signalId: "JD100-SCALP-200", category: "SCALP", state: "signal", marketId: "JD100" };
  const market = { marketId: "JD100", signals: [regular], recentSignals: [recentOnly, { ...regular, score: 99 }] };
  const journal = { signals: [
    { ...regular, status: "pending", tp1Hit: false },
    { ...recentOnly, status: "tp1_hit", tp1Hit: true },
    { ...signal, signalId: "journal-only", marketId: "JD100", status: "pending", tp1Hit: false },
    { ...signal, signalId: "old-sl", marketId: "JD100", status: "stopped" },
    { ...signal, signalId: "old-expired", marketId: "JD100", status: "expired" }
  ] };
  const quote = { JD100: { price: 105, epoch: 250 } };
  const projected = dashboardSignalsForMarket(market, journal, 250, quote);
  assert.deepEqual(projected.map(item => item.signalId), ["JD100-SWING-100", "JD100-SCALP-200", "journal-only"]);
  assert.equal(projected[0].status, "pending");
  assert.equal(projected[1].status, "tp1_hit");
  assert.equal(projected[1].tp1Hit, true);
  assert.equal(dashboardSignalsForMarket(market, journal, 250, {}).length, 0, "missing quote must never be shown as live");
  assert.equal(dashboardSignalsForMarket(market, journal, 600, { JD100: { price: 105, epoch: 250 } }).length, 0, "old quote must never be shown as live");
});

test("live quote immediately resolves TP1, TP2 and stop loss", () => {
  const tp1 = { ...signal, status: "pending", tp1Hit: false };
  applyLiveQuote(tp1, { price: 112, epoch: 250 }, 250);
  assert.equal(tp1.status, "tp1_hit");
  assert.equal(tp1.tp1Hit, true);

  const tp2 = { ...signal, status: "pending", tp1Hit: false };
  applyLiveQuote(tp2, { price: 122, epoch: 260 }, 260);
  assert.equal(tp2.status, "tp2_hit");
  assert.equal(tp2.tp1Hit, true, "TP2 necessarily implies TP1 was crossed");

  const stopped = { ...signal, status: "pending", tp1Hit: false };
  applyLiveQuote(stopped, { price: 89, epoch: 270 }, 270);
  assert.equal(stopped.status, "stopped");
});


test("legacy TP2 and post-TP1 stop records recover their TP1 milestone", () => {
  const legacy = { version: 1, signals: [
    { ...signal, signalId: "legacy-tp2", status: "tp2_hit", tp1Hit: false, tp2Epoch: 300 },
    { ...signal, signalId: "legacy-stop", status: "stopped_after_tp1", tp1Hit: false }
  ] };
  const migrated = updateJournal(legacy, {}, 400);
  assert.equal(migrated.signals.find(s => s.signalId === "legacy-tp2").tp1Hit, true);
  assert.equal(migrated.signals.find(s => s.signalId === "legacy-tp2").tp1Epoch, 300);
  assert.equal(migrated.signals.find(s => s.signalId === "legacy-stop").tp1Hit, true);
});
