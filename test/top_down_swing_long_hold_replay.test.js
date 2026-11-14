"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { POLICIES, simulatePolicy, summarize } = require("../top_down_swing_long_hold_replay");

const signal = { direction:"BUY", entry:100, stopLoss:90, riskDistance:10,
  entryEpoch:0, decisionEpoch:0 };
const frames = bars => ({ M5:bars, H1:[], H4:[] });
const candle = (epoch, high, low, close=100) => ({epoch,open:100,high,low,close});

test("long-hold replay exposes only the declared research policies", () => {
  assert.deepEqual(POLICIES, ["FIXED_2_5R","PARTIAL_1_5R_BE","H1_PIVOT_TRAIL","H4_PIVOT_TRAIL","H1_STRUCTURE_EXIT"]);
});

test("fixed policy scores a clean 2.5R target", () => {
  const result = simulatePolicy(signal, frames([candle(0,126,99)]), "FIXED_2_5R", 300);
  assert.equal(result.status, "scored");
  assert.equal(result.realisedR, 2.5);
  assert.equal(result.exitReason, "fixed_target_2_5R");
});

test("partial policy takes 1.5R then exits remaining half at 2.5R", () => {
  const result = simulatePolicy(signal, frames([candle(0,116,99),candle(300,126,101)]), "PARTIAL_1_5R_BE", 600);
  assert.equal(result.status, "scored");
  assert.equal(result.realisedR, 2);
  assert.equal(result.partialTaken, true);
});

test("incomplete forward history is censored, not counted as a loss", () => {
  const result = simulatePolicy(signal, frames([candle(0,105,99)]), "FIXED_2_5R", 600);
  assert.equal(result.status, "censored");
});

test("summary separates scored, censored and ambiguous observations", () => {
  const s = summarize([
    {status:"scored",realisedR:2,mfeR:2.5,maeR:0.2,durationHours:1,exitReason:"target"},
    {status:"censored"}, {status:"ambiguous"}
  ]);
  assert.equal(s.scoredCount,1);
  assert.equal(s.censoredCount,1);
  assert.equal(s.ambiguousCount,1);
  assert.equal(s.averageR,2);
});
