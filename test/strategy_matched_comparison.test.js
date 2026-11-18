"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  candidateRows, baselineRows, buildStrategyComparison, buildMatchedComparisonReport
} = require("../strategy_matched_comparison");

function base(id, epoch, direction = "BUY", extra = {}) {
  return {
    signalId: id, marketId: "R_10", direction, entryCandleEpoch: epoch,
    entryTimeframe: "M5", category: "SCALP", strategyVersion: "MTF_BASELINE_V1",
    status: "tp2_hit", ...extra
  };
}
function candidate(id, epoch, direction = "BUY", extra = {}) {
  return {
    signalId: id, marketId: "R_10", direction, entryCandleEpoch: epoch,
    strategyId: "EXP", status: "target", evaluationSource: "forward_shadow", ...extra
  };
}

test("only forward candidates and MTF_BASELINE_V1 M5 scalp records enter matching", () => {
  const candidates = candidateRows({ signals: [
    candidate("fwd", 900), candidate("backfill", 1800, "BUY", { evaluationSource: "historical_backfill" }),
    candidate("bad-time", null)
  ] });
  const baselines = baselineRows({ signals: [
    base("valid", 900), base("wrong-version", 1800, "BUY", { strategyVersion: "LEGACY" }),
    base("wrong-category", 2700, "BUY", { category: "SHORT_TERM" }),
    base("wrong-entry", 3600, "BUY", { entryTimeframe: "M15" })
  ] });
  assert.deepEqual(candidates.map(x => x.signalId), ["fwd"]);
  assert.deepEqual(baselines.map(x => x.signalId), ["valid"]);
});

test("pairs nearest same-market same-direction baseline one-to-one inside 15 minutes", () => {
  const candidates = { signals: [
    candidate("c1", 900), candidate("c2", 1200), candidate("c3", 1800, "SELL")
  ] };
  const baselines = [
    base("b1", 850), base("b2", 1300), base("b3", 1800, "SELL")
  ];
  const result = buildStrategyComparison("EXP", "Experiment", candidates, baselines);
  assert.equal(result.matchedPairs, 3);
  assert.equal(result.unmatchedCandidates, 0);
  assert.deepEqual(result.pairs.map(x => x.baselineSignalId), ["b1", "b2", "b3"]);
  assert.equal(result.pairs[0].entryTimeDifferenceSeconds, 50);
});

test("opposite direction is reported separately and unmatched candidates are not losses", () => {
  const result = buildStrategyComparison("EXP", "Experiment",
    { signals: [candidate("c1", 900, "BUY")] },
    [base("b1", 900, "SELL")]);
  assert.equal(result.matchedPairs, 0);
  assert.equal(result.unmatchedCandidates, 1);
  assert.equal(result.candidatesWithOppositeDirectionBaselineNearby, 1);
  assert.equal(result.candidateOutcomeCounts.target, 1);
});

test("report labels itself as contemporaneous matching, not counterfactual replay", () => {
  const report = buildMatchedComparisonReport({
    baselineJournal: { signals: [base("b1", 900)] },
    strategyJournal: { signals: [candidate("c1", 900, "BUY", { strategyId: "EMA20_50", realizedR: null })] },
    generatedAt: "2026-11-19T00:00:00.000Z"
  });
  assert.equal(report.summary.matchedPairs, 1);
  assert.equal(report.strategies[0].pairs[0].candidateRealizedR, null);
  assert.match(report.methodology.limitations[0], /not a counterfactual replay/);
  assert.equal(report.strategies.length, 7);
});
