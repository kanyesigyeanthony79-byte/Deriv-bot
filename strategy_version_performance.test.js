"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { STRATEGY_VERSION, updateJournal } = require("./multi_timeframe_journal");
const { LEGACY_VERSION, buildPerformanceReport } = require("./strategy_version_performance");

test("new journal candidates receive a version and immutable setup snapshot", () => {
  const candidate = {
    state: "signal", signalId: "TEST-SCALP-1", marketId: "R_50", category: "SCALP",
    direction: "BUY", entry: 100, stopLoss: 99, tp1: 102, tp2: 103,
    entryTimeframe: "M5", setupTimeframe: "M15", confirmationTimeframe: "M15",
    contextTimeframe: "M15", riskTimeframe: "M15", targetHorizon: "M15",
    riskReward: { tp1: 2, tp2: 3 }, maxAgeSeconds: 1800, entryCandleEpoch: 1000
  };
  const result = updateJournal({ version: 1, signals: [] }, {
    R_50: { marketId: "R_50", signals: [candidate], recentSignals: [], timeframes: { M5: [] } }
  }, 1100);
  const record = result.signals.find(s => s.signalId === candidate.signalId);
  assert.equal(record.strategyVersion, STRATEGY_VERSION);
  assert.deepEqual(record.strategySnapshot.riskReward, { tp1: 2, tp2: 3 });
  assert.equal(record.strategySnapshot.confirmationTimeframe, "M15");
  assert.equal(record.status, "pending");
});

test("legacy journal records are not retrospectively relabelled", () => {
  const legacy = { signalId: "OLD-1", marketId: "R_50", status: "pending", telegramStatus: "sent", createdEpoch: 1 };
  const result = updateJournal({ version: 1, signals: [legacy] }, {}, 1200);
  assert.equal(result.signals[0].strategyVersion, undefined);
  const report = buildPerformanceReport(result, "2026-11-18T00:00:00.000Z");
  assert.equal(report.byVersion[0].key, LEGACY_VERSION);
  assert.equal(report.totals.legacyUnversioned, 1);
});

test("performance report keeps partial, expired and unresolved outcomes out of decisive rate", () => {
  const rows = [
    { strategyVersion: "V1", telegramStatus: "sent", status: "tp2_hit", category: "SCALP", marketId: "R_50", direction: "BUY", score: 92 },
    { strategyVersion: "V1", telegramStatus: "sent", status: "stopped", category: "SCALP", marketId: "R_50", direction: "SELL", score: 78 },
    { strategyVersion: "V1", telegramStatus: "sent", status: "stopped_after_tp1", category: "SHORT_TERM", marketId: "R_25", direction: "BUY", score: 84 },
    { strategyVersion: "V1", telegramStatus: "sent", status: "expired", category: "SHORT_TERM", marketId: "R_25", direction: "SELL", score: 84 },
    { strategyVersion: "V1", telegramStatus: "sent", status: "pending", category: "SCALP", marketId: "R_10", direction: "BUY", score: null },
    { strategyVersion: "V1", telegramStatus: "delivery_failed", status: "tp2_hit" }
  ];
  const report = buildPerformanceReport({ signals: rows });
  assert.equal(report.overall.signals, 5);
  assert.equal(report.overall.decisiveTp2Rate, 50);
  assert.equal(report.overall.outcomes.stopped_after_tp1, 1);
  assert.equal(report.overall.outcomes.expired, 1);
  assert.equal(report.overall.outcomes.pending, 1);
  assert.equal(report.totals.telegramDelivered, 5);
  assert.equal(report.byVersion[0].key, "V1");
  assert.equal(report.byCategory.length, 2);
});
