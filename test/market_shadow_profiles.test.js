"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DEF, evaluate } = require("../engine");
const { SHADOW_PROFILES, shadowProfileForMarket, candidateGateDecision, evaluateMarketShadow } = require("../market_shadow_profiles");

function risingCandles(last = {}) {
  const rows = Array.from({ length: 90 }, (_, i) => {
    const close = 100 + i * 0.2;
    return { epoch: 1_700_000_000 + i * 900, open: close - 0.12, high: close + 0.2, low: close - 0.2, close };
  });
  rows[rows.length - 1] = { ...rows[rows.length - 1], ...last };
  return rows;
}

test("defines only the intended R_75 and JD100 shadow profiles", () => {
  assert.deepEqual(Object.keys(SHADOW_PROFILES), ["R_75", "JD100"]);
  assert.equal(SHADOW_PROFILES.R_75.minScore, 65);
  assert.equal(SHADOW_PROFILES.R_75.minBody, 0.60);
  assert.equal(SHADOW_PROFILES.R_75.maxExt, 1.00);
  assert.equal(SHADOW_PROFILES.R_75.minCloseLocation, 0.88);
  assert.equal(SHADOW_PROFILES.JD100.minCloseLocation, 0.85);
  assert.equal(SHADOW_PROFILES.R_75.cooldown, 8);
  assert.equal(SHADOW_PROFILES.JD100.cooldown, 8);
});

test("does not alter active defaults or create profiles for other markets", () => {
  assert.equal(DEF.minScore, 55);
  assert.equal(DEF.minBody, 0.4);
  assert.equal(DEF.minCloseLocation, undefined);
  assert.equal(shadowProfileForMarket("R_50"), null);
  assert.equal(evaluateMarketShadow([], "R_50"), null);
});

test("paper gate accepts only candidate-matching signals when enabled", () => {
  assert.deepEqual(candidateGateDecision({ enabled: true, baselineSignal: "BUY", shadowSignal: "BUY" }), { active: true, accepted: true });
  assert.deepEqual(candidateGateDecision({ enabled: true, baselineSignal: "BUY", shadowSignal: "NO TRADE" }), { active: true, accepted: false });
  assert.deepEqual(candidateGateDecision({ enabled: false, baselineSignal: "BUY", shadowSignal: "NO TRADE" }), { active: false, accepted: true });
  assert.deepEqual(candidateGateDecision({ enabled: true, baselineSignal: "BUY", shadowSignal: null }), { active: false, accepted: true });
});

test("optional close-location gate rejects an indecisive candidate candle", () => {
  const candles = risingCandles({ open: 117.80, high: 118.10, low: 117.20, close: 117.90 });
  const result = evaluate(candles, SHADOW_PROFILES.R_75);
  const closeCheck = result.checks.find(check => check.reason === "Candle closes strongly in the signal direction");
  assert.ok(closeCheck);
  assert.equal(closeCheck.passed, false);
  assert.equal(evaluateMarketShadow(candles, "R_75").profile.minCloseLocation, 0.88);
});
