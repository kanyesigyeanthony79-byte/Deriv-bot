"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateOutcome } = require("../top_down_swing_replay");

const signal = { direction:"BUY", entry:100, entryEpoch:0, stopLoss:99, riskDistance:1 };
test("seven-day replay marks incomplete forward windows as censored", () => {
  const bars = [{epoch:300,open:100,high:101,low:99.5,close:100}];
  assert.equal(simulateOutcome(signal, bars, "fixed").status, "censored");
});
test("same-candle stop and target collision is ambiguous, not guessed", () => {
  const bars = [{epoch:300,open:100,high:103,low:98,close:101}];
  bars.push({epoch:604800,open:101,high:101,low:101,close:101});
  assert.equal(simulateOutcome(signal, bars, "fixed").status, "ambiguous");
});
test("outcome simulation never mutates the candidate signal", () => {
  const before = JSON.stringify(signal);
  simulateOutcome(signal, [], "partial");
  assert.equal(JSON.stringify(signal), before);
});
