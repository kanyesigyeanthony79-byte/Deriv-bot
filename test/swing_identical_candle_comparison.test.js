"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize, compareSignalMaps, simulateOutcome } = require("../swing_identical_candle_comparison");

test("paired comparison counts resolved outcomes and TP1 hits", () => {
  const result = summarize([
    {status:"stop_before_tp1"},
    {status:"tp2_after_tp1"},
    {status:"incomplete_window"}
  ]);
  assert.equal(result.signals, 3);
  assert.equal(result.resolvedSignals, 2);
  assert.equal(result.tp1Reached, 1);
  assert.equal(result.tp2Reached, 1);
});

test("paired comparison separates added, removed and changed outcomes", () => {
  const baseline = [
    {signalId:"A",status:"stop_before_tp1"},
    {signalId:"B",status:"tp2_after_tp1"},
    {signalId:"C",status:"stop_before_tp1"}
  ];
  const candidate = [
    {signalId:"A",status:"stop_before_tp1"},
    {signalId:"B",status:"stop_after_tp1"},
    {signalId:"D",status:"tp1_only_by_horizon"}
  ];
  const result = compareSignalMaps(baseline, candidate);
  assert.equal(result.baselineOnly, 1);
  assert.equal(result.candidateOnly, 1);
  assert.equal(result.commonSignals, 2);
  assert.equal(result.sameOutcome, 1);
  assert.equal(result.changedOutcome, 1);
});

test("paired comparison uses conservative same-candle ambiguity", () => {
  const candles = [{low:100,high:105},{low:94,high:111},...Array.from({length:2015},()=>({low:100,high:105}))];
  assert.equal(simulateOutcome({direction:"BUY",stopLoss:95,tp1:110,tp2:120},candles,0).status,
    "ambiguous_sl_tp1_same_candle");
});
