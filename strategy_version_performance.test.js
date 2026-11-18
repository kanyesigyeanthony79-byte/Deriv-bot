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


test("new observation records preserve intended expiry and record actual expiry delay", () => {
  const candidate = {
    state: "signal", signalId: "TEST-SCALP-EXPIRY", marketId: "R_50", category: "SCALP",
    direction: "BUY", entry: 100, stopLoss: 99, tp1: 102, tp2: 103,
    entryTimeframe: "M5", entryCandleEpoch: 1000, maxAgeSeconds: 1800
  };
  const first = updateJournal({ version: 1, signals: [] }, {
    R_50: { marketId: "R_50", signals: [candidate], timeframes: { M5: [] } }
  }, 1100);
  assert.equal(first.signals[0].intendedExpiryEpoch, 2800);
  assert.equal(first.signals[0].status, "pending");
  const expired = updateJournal(first, {}, 2860);
  assert.equal(expired.signals[0].status, "expired");
  assert.equal(expired.signals[0].expiredEpoch, 2860);
  assert.equal(expired.signals[0].expiryDelaySeconds, 60);
});

test("historical expired records keep missing expiry timestamps missing", () => {
  const historical = { signalId: "OLD-EXPIRED", marketId: "R_50", category: "SCALP",
    entryCandleEpoch: 1000, maxAgeSeconds: 1800, status: "expired" };
  const result = updateJournal({ version: 1, signals: [historical] }, {}, 9000);
  assert.equal(result.signals[0].intendedExpiryEpoch, undefined);
  assert.equal(result.signals[0].expiredEpoch, undefined);
  assert.equal(result.signals[0].expiryDelaySeconds, undefined);
});

test("expiry analysis reports timestamp coverage and favourable excursion bands", () => {
  const report = buildPerformanceReport({ signals: [
    { telegramStatus: "sent", status: "expired", category: "SCALP", marketId: "R_50",
      tp1Hit: true, maxFavourablePoints: 15, riskDistance: 10,
      intendedExpiryEpoch: 100, expiredEpoch: 160, expiryDelaySeconds: 60 },
    { telegramStatus: "sent", status: "expired", category: "SHORT_TERM", marketId: "R_25",
      tp1Hit: false, maxFavourablePoints: 4, riskDistance: 10 },
    { telegramStatus: "sent", status: "tp2_hit" }
  ]});
  assert.equal(report.expiryAnalysis.expiredSignals, 2);
  assert.equal(report.expiryAnalysis.tp1Reached, 1);
  assert.equal(report.expiryAnalysis.withIntendedExpiryTimestamp, 1);
  assert.equal(report.expiryAnalysis.withActualExpiryTimestamp, 1);
  assert.equal(report.expiryAnalysis.withMeasuredExpiryDelay, 1);
  assert.equal(report.expiryAnalysis.medianExpiryDelaySeconds, 60);
  assert.deepEqual(report.expiryAnalysis.favourableExcursionBands.map(x => x.signals), [1, 0, 0, 1, 0, 0]);
});


test("review comparison keeps original journal outcomes separate from advisory statuses", () => {
  const journal = { signals: [
    { signalId: "A", telegramStatus: "sent", status: "expired" },
    { signalId: "B", telegramStatus: "sent", status: "tp2_hit" },
    { signalId: "C", telegramStatus: "sent", status: "stopped" }
  ] };
  const reviews = [
    { signalId: "A", review: { status: "TP2_LEVEL_TOUCHED" } },
    { signalId: "B", review: { status: "THESIS_INTACT" } }
  ];
  const report = buildPerformanceReport(journal, "2026-11-18T00:00:00.000Z", reviews);
  assert.equal(report.overall.outcomes.expired, 1);
  assert.equal(report.overall.outcomes.tp2_hit, 1);
  assert.equal(report.reviewComparison.matchedSignals, 2);
  assert.equal(report.reviewComparison.unmatchedSignals, 1);
  assert.equal(report.reviewComparison.terminalReviewLevels, 1);
  assert.deepEqual(report.reviewComparison.byOriginalOutcomeAndAdvisoryStatus, [
    { key: "expired / TP2_LEVEL_TOUCHED", signals: 1 },
    { key: "tp2_hit / THESIS_INTACT", signals: 1 }
  ]);
});
