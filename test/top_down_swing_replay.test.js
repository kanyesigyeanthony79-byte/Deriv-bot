"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateOutcome, runReplay } = require("../top_down_swing_replay");

const signal = { direction:"BUY", entry:100, entryEpoch:0, stopLoss:99, riskDistance:1 };
test("seven-day replay marks incomplete forward windows as censored", () => {
  const bars = [{epoch:300,open:100,high:101,low:99.5,close:100}];
  assert.equal(simulateOutcome(signal, bars, "fixed").status, "censored");
});
test("same-candle stop and target collision is ambiguous, not guessed", () => {
  const bars = [{epoch:300,open:100,high:103,low:98,close:101}];
  bars.push({epoch:604500,open:101,high:101,low:101,close:101});
  assert.equal(simulateOutcome(signal, bars, "fixed").status, "ambiguous");
});
test("outcome simulation never mutates the candidate signal", () => {
  const before = JSON.stringify(signal);
  simulateOutcome(signal, [], "partial");
  assert.equal(JSON.stringify(signal), before);
});

test("outcome replay excludes the entry candle and all candles before its close", () => {
  const candidate = { ...signal, entryEpoch:300, decisionEpoch:600 };
  const future = [{epoch:300,open:100,high:100,low:98,close:99}];
  for (let i=0;i<=2015;i++) {
    const epoch=600+i*300;
    future.push({epoch,open:100,high:100.2,low:99.8,close:100});
  }
  const result=simulateOutcome(candidate,future,"fixed");
  assert.equal(result.status,"expired");
  assert.equal(result.realisedR,0);
});

test("replay labels a short history as insufficient forward coverage", () => {
  const m5 = Array.from({length:20},(_,i)=>({epoch:i*300,open:100,high:101,low:99,close:100}));
  const report=runReplay({markets:{R_25:{timeframes:{M5:m5}}}});
  assert.equal(report.markets.R_25.state,"insufficient_forward_coverage");
  assert.equal(report.markets.R_25.eligibleDecisionCount,0);
});
