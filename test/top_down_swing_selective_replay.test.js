"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SELECTED, selectReport } = require("../top_down_swing_selective_replay");

test("selective cohort retains only the predeclared positive market-entry pairs", () => {
  const variants = Object.fromEntries(["H1_CONTROL","M15_REFINED","M15_M5_REFINED"].map(v => [v, {
    candidateCount: 3, scoredCount: 2, averageFixedR: 0.5, averagePartialR: 0.2,
    outcomesFixed: { tp2_hit: 1, stopped: 1, ambiguous: 0, expired: 0 }
  }]));
  const report = selectReport({
    generatedAt: "2026-11-14T00:00:00Z", horizonDays: 7, assumptions: [],
    markets: Object.fromEntries([...Object.keys(SELECTED), "JD100"].map(id => [id, {
      state: "replayed", variants
    }]))
  });
  assert.deepEqual(Object.keys(report.markets), Object.keys(SELECTED));
  assert.deepEqual(Object.keys(report.markets.BOOM500.variants), ["H1_CONTROL", "M15_REFINED"]);
  assert.equal(report.markets.R_10.variants.M15_M5_REFINED.scoredCount, 2);
  assert.equal(report.markets.BOOM500.variants.M15_M5_REFINED, undefined);
  assert.equal(report.scope, "selective_positive_market_entry_pairs");
});

test("missing market history is reported rather than silently treated as zero", () => {
  const report = selectReport({ markets: {}, assumptions: [] });
  assert.equal(report.markets.R_10.state, "missing_market_data");
  assert.equal(report.summary.H1_CONTROL.scoredCount, 0);
});
