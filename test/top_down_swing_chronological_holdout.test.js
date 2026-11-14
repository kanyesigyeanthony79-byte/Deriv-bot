"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { POLICIES } = require("../top_down_swing_long_hold_replay");
const { makeWindows, summarizeResults, summarizePairedResults, choosePolicy } = require("../top_down_swing_chronological_holdout");

test("training outcome horizon does not overlap validation entries", () => {
  const start = 1_800_000_000;
  const windows = makeWindows(start, start + 70 * 86400);
  assert.equal(windows.train.startEpoch, start);
  assert.equal(windows.validation.startEpoch - windows.train.endEpoch, 14 * 86400);
  assert.equal(windows.validation.endEpoch, start + 70 * 86400);
});

test("holdout rejects a window too short for training, embargo and validation", () => {
  assert.throws(() => makeWindows(1000, 1000 + 40 * 86400), /Insufficient history/);
});

test("policy selection uses only sufficiently scored training policies", () => {
  const rows = Object.fromEntries(POLICIES.map(policy => [policy, { scoredCount: 20, averageR: 0.2 }]));
  rows.H4_PIVOT_TRAIL = { scoredCount: 9, averageR: 9 };
  rows.H1_PIVOT_TRAIL = { scoredCount: 20, averageR: 0.8 };
  assert.equal(choosePolicy(rows), "H1_PIVOT_TRAIL");
});

test("policy selection abstains when no policy reaches minimum training sample", () => {
  const rows = Object.fromEntries(POLICIES.map(policy => [policy, { scoredCount: 3, averageR: 5 }]));
  assert.equal(choosePolicy(rows), null);
});

test("summary separates scored, censored and ambiguous results", () => {
  const result = summarizeResults([
    { status: "scored", realisedR: 1, mfeR: 2, maeR: 0.5, durationHours: 24 },
    { status: "scored", realisedR: -1, mfeR: 0.5, maeR: 1, durationHours: 12 },
    { status: "censored" }, { status: "ambiguous" }
  ]);
  assert.deepEqual({ candidates: result.candidateCount, scored: result.scoredCount,
    censored: result.censoredCount, ambiguous: result.ambiguousCount, averageR: result.averageR },
  { candidates: 4, scored: 2, censored: 1, ambiguous: 1, averageR: 0 });
});

test("policy averages use the same common unambiguous trade cohort", () => {
  const results = {
    FIXED_2_5R: [
      { status: "scored", realisedR: 2.5, mfeR: 3, maeR: 0.2, durationHours: 20 },
      { status: "ambiguous" },
      { status: "scored", realisedR: -1, mfeR: 0.5, maeR: 1, durationHours: 4 }
    ],
    H4_PIVOT_TRAIL: [
      { status: "scored", realisedR: 1.5, mfeR: 3, maeR: 0.2, durationHours: 18 },
      { status: "scored", realisedR: 1, mfeR: 2, maeR: 0.4, durationHours: 12 },
      { status: "scored", realisedR: -0.5, mfeR: 0.5, maeR: 1, durationHours: 5 }
    ]
  };
  const paired = summarizePairedResults(results);
  assert.equal(paired.pairedScoredCount, 2);
  assert.equal(paired.policies.FIXED_2_5R.averageR, 0.75);
  assert.equal(paired.policies.H4_PIVOT_TRAIL.averageR, 0.5);
  assert.equal(paired.policies.FIXED_2_5R.rawAmbiguousCount, 1);
  assert.equal(paired.policies.H4_PIVOT_TRAIL.rawScoredCount, 3);
  assert.equal(paired.policies.H4_PIVOT_TRAIL.scoredCount, 2);
});
