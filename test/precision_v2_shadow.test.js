"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { THRESHOLDS, evaluatePrecisionVariants, summarizePrecisionObservations } = require("../precision_v2_shadow");

function signal(overrides = {}) {
  return { state: "signal", direction: "BUY",
    metrics: {
      entry: { extensionAtr: 0.8, bodyRatio: 0.6, closeLocation: 0.75, swingAtr: 0.8, emaSlopeAtr: 0.5 },
      confirmation: { direction: "BUY" }, context: { direction: "BUY" }
    }, ...overrides };
}

test("Precision V2 thresholds are explicit experimental values", () => {
  assert.equal(THRESHOLDS.maxExtensionAtr, 1.0);
  assert.equal(THRESHOLDS.minBodyRatio, 0.5);
  assert.equal(THRESHOLDS.minCloseLocation, 0.65);
  assert.equal(THRESHOLDS.minSwingAtr, 0.65);
  assert.equal(THRESHOLDS.minSlopeAtr, 0.39);
});

test("a clean baseline signal passes all shadow variants", () => {
  const result = evaluatePrecisionVariants(signal());
  for (const key of ["baseline", "extensionOnly", "candleQualityOnly", "combined", "swingStructureOnly", "trendSlopeOnly"])
    assert.equal(result[key], true);
});

test("extension and candle-quality filters remain independently testable", () => {
  const extended = evaluatePrecisionVariants(signal({ metrics: {
    entry: { extensionAtr: 1.2, bodyRatio: 0.7, closeLocation: 0.8, swingAtr: 0.8, emaSlopeAtr: 0.5 },
    confirmation: { direction: "BUY" }, context: { direction: "BUY" }
  }}));
  assert.equal(extended.extensionOnly, false);
  assert.equal(extended.candleQualityOnly, true);
  assert.equal(extended.combined, false);

  const weakCandle = evaluatePrecisionVariants(signal({ metrics: {
    entry: { extensionAtr: 0.7, bodyRatio: 0.4, closeLocation: 0.55, swingAtr: 0.8, emaSlopeAtr: 0.5 },
    confirmation: { direction: "BUY" }, context: { direction: "BUY" }
  }}));
  assert.equal(weakCandle.extensionOnly, true);
  assert.equal(weakCandle.candleQualityOnly, false);
  assert.equal(weakCandle.combined, false);
});

test("swing and slope candidates use their own entry metrics", () => {
  const result = evaluatePrecisionVariants(signal({ metrics: {
    entry: { extensionAtr: 0.8, bodyRatio: 0.6, closeLocation: 0.75, swingAtr: 0.3, emaSlopeAtr: 0.2 },
    confirmation: { direction: "BUY" }, context: { direction: "BUY" }
  }}));
  assert.equal(result.swingStructureOnly, false);
  assert.equal(result.trendSlopeOnly, false);
});

test("direction disagreement rejects every precision candidate but preserves baseline observation", () => {
  const result = evaluatePrecisionVariants(signal({ metrics: {
    entry: { extensionAtr: 0.7, bodyRatio: 0.7, closeLocation: 0.8, swingAtr: 0.8, emaSlopeAtr: 0.5 },
    confirmation: { direction: "SELL" }, context: { direction: "BUY" }
  }}));
  assert.equal(result.baseline, true);
  for (const key of ["extensionOnly", "candleQualityOnly", "combined", "swingStructureOnly", "trendSlopeOnly"])
    assert.equal(result[key], false);
});

test("missing metrics are marked ineligible rather than guessed", () => {
  assert.equal(evaluatePrecisionVariants({ state: "signal", direction: "BUY" }).eligible, false);
  assert.equal(evaluatePrecisionVariants({ state: "warming" }).eligible, false);
});

test("outcome summary keeps expiry and ambiguity out of decisive win-rate denominator", () => {
  const rows = [
    { variant: "baseline", status: "tp2_hit", realizedR: 3 },
    { variant: "baseline", status: "stopped", realizedR: -1 },
    { variant: "baseline", status: "expired", realizedR: null },
    { variant: "baseline", status: "ambiguous", realizedR: null },
    { variant: "extensionOnly", status: "tp2_hit", realizedR: 3 },
    { variant: "extensionOnly", status: "stopped", realizedR: -1 },
    { variant: "swingStructureOnly", status: "tp2_hit", realizedR: 3 }
  ];
  const report = summarizePrecisionObservations(rows);
  assert.equal(report.variants.baseline.observations, 4);
  assert.equal(report.variants.baseline.resolved, 2);
  assert.equal(report.variants.baseline.decisiveWinRatePct, 50);
  assert.equal(report.variants.baseline.expired, 1);
  assert.equal(report.variants.baseline.ambiguous, 1);
  assert.equal(report.variants.extensionOnly.decisiveWinRatePct, 50);
  assert.equal(report.variants.swingStructureOnly.decisiveWinRatePct, 100);
});
