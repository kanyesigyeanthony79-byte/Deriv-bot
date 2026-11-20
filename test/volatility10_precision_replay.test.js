"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  latestContinuousSegment,
  structureStop,
  resolveOutcome
} = require("../volatility10_precision_replay");

function candle(epoch, open, high, low, close) {
  return { epoch, open, high, low, close };
}

test("uses the latest continuous candle segment after a data gap", () => {
  const rows = [
    candle(0, 100, 101, 99, 100),
    candle(60, 100, 101, 99, 100),
    candle(600, 100, 101, 99, 100),
    candle(660, 100, 101, 99, 100),
    candle(720, 100, 101, 99, 100)
  ];
  const latest = latestContinuousSegment(rows, 60);
  assert.deepEqual(latest.map(row => row.epoch), [600, 660, 720]);
});

test("rejects duplicate timestamps in the candle series", () => {
  const rows = [
    candle(0, 100, 101, 99, 100),
    candle(0, 100, 101, 99, 100)
  ];
  assert.throws(() => latestContinuousSegment(rows, 60), /Unsorted or duplicate/);
});

test("builds a structural BUY stop below entry and reports risk in M15 ATR units", () => {
  const rows = [
    candle(0, 100, 102, 99, 101),
    candle(60, 101, 103, 100, 102),
    candle(120, 102, 104, 100.5, 103),
    candle(180, 103, 104, 100.2, 102),
    candle(240, 102, 103, 99.8, 102)
  ];
  const result = structureStop(rows, 4, "BUY", 102.5, 1, 2);
  assert.equal(result.accepted, true);
  assert.ok(result.stopLoss < 102.5);
  assert.ok(result.riskM15Atr > 0);
});

test("rejects a structural stop wider than the configured M15 ATR cap", () => {
  const rows = [
    candle(0, 100, 110, 80, 101),
    candle(60, 101, 110, 80, 102),
    candle(120, 102, 110, 80, 103),
    candle(180, 103, 110, 80, 102),
    candle(240, 102, 110, 80, 102)
  ];
  const result = structureStop(rows, 4, "BUY", 103, 1, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.status, "wide_risk");
});

test("marks a same-candle stop and target touch as ambiguous", () => {
  const rows = [candle(0, 100, 111, 94, 100)];
  const result = resolveOutcome(rows, 0, "BUY", 100, 95, 900, 900);
  assert.equal(result.status, "ambiguous");
});

test("records a target outcome at +2R", () => {
  const rows = [candle(0, 100, 111, 98, 109)];
  const result = resolveOutcome(rows, 0, "BUY", 100, 95, 900, 900);
  assert.equal(result.status, "target");
  assert.equal(result.r, 2);
});

test("records a stop outcome at -1R", () => {
  const rows = [candle(0, 100, 102, 94, 96)];
  const result = resolveOutcome(rows, 0, "BUY", 100, 95, 900, 900);
  assert.equal(result.status, "stop");
  assert.equal(result.r, -1);
});

test("marks an unresolved fully observed trade to market after one hour", () => {
  const rows = [
    candle(0, 100, 102, 99, 101),
    candle(900, 101, 103, 100, 102),
    candle(1800, 102, 104, 101, 103),
    candle(2700, 103, 105, 102, 104)
  ];
  const result = resolveOutcome(rows, 0, "BUY", 100, 95, 3600, 900);
  assert.equal(result.status, "time_exit");
  assert.equal(result.r, 0.8);
});

test("does not invent an outcome when the one-hour observation window is incomplete", () => {
  const rows = [candle(0, 100, 102, 99, 101)];
  const result = resolveOutcome(rows, 0, "BUY", 100, 95, 3600, 900);
  assert.equal(result.status, "censored");
});

test("selects chronologically non-overlapping setup windows without changing source rows", () => {
  const { selectNonOverlappingSetups } = require("../volatility10_precision_replay");
  const rows = [
    { setupCloseEpoch: 0, id: "a" },
    { setupCloseEpoch: 1800, id: "b" },
    { setupCloseEpoch: 4500, id: "c" },
    { setupCloseEpoch: 9000, id: "d" }
  ];
  const selected = selectNonOverlappingSetups(rows);
  assert.deepEqual(selected.map(row => row.id), ["a", "c", "d"]);
  assert.deepEqual(rows.map(row => row.id), ["a", "b", "c", "d"]);
});

test("keeps setups exactly at the prior maximum observation-window boundary", () => {
  const { selectNonOverlappingSetups } = require("../volatility10_precision_replay");
  const rows = [
    { setupCloseEpoch: 1000, id: "a" },
    { setupCloseEpoch: 5500, id: "b" }
  ];
  assert.deepEqual(selectNonOverlappingSetups(rows).map(row => row.id), ["a", "b"]);
});
