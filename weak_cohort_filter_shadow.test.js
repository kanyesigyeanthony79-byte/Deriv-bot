"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport, EXCLUDED_COHORTS } = require("./weak_cohort_filter_shadow");

test("weak cohort shadow filter removes only the selected cohorts and reports deltas", () => {
  const journal = { signals: [
    { marketId: "JD100", direction: "BUY", category: "SCALP", status: "stopped", telegramStatus: "sent" },
    { marketId: "JD100", direction: "BUY", category: "SCALP", status: "tp2_hit", telegramStatus: "sent" },
    { marketId: "R_50", direction: "SELL", category: "SCALP", status: "tp2_hit", telegramStatus: "sent" },
    { marketId: "R_50", direction: "SELL", category: "SCALP", status: "stopped", telegramStatus: "sent" }
  ] };
  const before = JSON.stringify(journal);
  const report = buildReport(journal, "2026-11-21T00:00:00.000Z");
  assert.deepEqual(report.candidate.excludedCohorts, EXCLUDED_COHORTS);
  assert.equal(report.baseline.allObservations.generated, 4);
  assert.equal(report.candidate.allObservations.generated, 2);
  assert.equal(report.candidate.removedObservations, 2);
  assert.equal(report.baseline.allObservations.wins, 2);
  assert.equal(report.candidate.allObservations.wins, 1);
  assert.equal(report.deltas.expired, 0);
  assert.equal(JSON.stringify(journal), before, "shadow experiment must not mutate journal data");
});

test("candidate filter leaves unrelated cohorts unchanged", () => {
  const report = buildReport({ signals: [
    { marketId: "R_50", direction: "SELL", category: "SHORT_TERM", status: "stopped", telegramStatus: "sent" },
    { marketId: "R_50", direction: "SELL", category: "SHORT_TERM", status: "tp2_hit", telegramStatus: "sent" }
  ] });
  assert.equal(report.candidate.removedObservations, 0);
  assert.equal(report.deltas.generated, 0);
  assert.equal(report.deltas.winRatePoints, 0);
});
