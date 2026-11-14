"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { FILTERS, filterSignals, scoreSignals } = require("../top_down_swing_entry_quality_experiment");

test("entry-quality filters are fixed, named and reject unknown filters", () => {
  assert.deepEqual(Object.keys(FILTERS), [
    "BASELINE", "D1_ALIGNED", "RISK_ATR_MAX_2_5", "D1_ALIGNED_AND_RISK_ATR_MAX_2_5"
  ]);
  assert.throws(() => filterSignals([], "AUTO_TUNE"), /Unknown entry-quality filter/);
});

test("D1 alignment filter retains only aligned context without altering candidates", () => {
  const signals = [
    { d1Alignment: "aligned", riskInAtr: 2 },
    { d1Alignment: "counter_trend", riskInAtr: 1 },
    { d1Alignment: "neutral", riskInAtr: 2 }
  ];
  assert.equal(filterSignals(signals, "BASELINE").length, 3);
  assert.deepEqual(filterSignals(signals, "D1_ALIGNED"), [signals[0]]);
});

test("risk filter enforces the predeclared 2.5 H4 ATR ceiling", () => {
  const signals = [{ riskInAtr: 2.5 }, { riskInAtr: 2.51 }, { riskInAtr: null }];
  assert.deepEqual(filterSignals(signals, "RISK_ATR_MAX_2_5"), [signals[0]]);
});

test("combined filter requires both D1 alignment and risk ceiling", () => {
  const signals = [
    { d1Alignment: "aligned", riskInAtr: 2.4 },
    { d1Alignment: "aligned", riskInAtr: 2.6 },
    { d1Alignment: "neutral", riskInAtr: 1.2 }
  ];
  assert.deepEqual(filterSignals(signals, "D1_ALIGNED_AND_RISK_ATR_MAX_2_5"), [signals[0]]);
});

test("scoring exposes ambiguous and censored outcomes and does not invent a return", () => {
  const summary = scoreSignals([], {});
  assert.equal(summary.candidateCount, 0);
  assert.equal(summary.scoredCount, 0);
  assert.equal(summary.averageR, null);
});
