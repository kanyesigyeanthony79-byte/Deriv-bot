"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { TF, validCandles, completed, confirmedPivots, structure, evaluateTopDown, managementAdvisories } = require("../top_down_swing_engine");

function bars(n, step, fn, start = 1_700_000_000) {
  return Array.from({ length: n }, (_, i) => {
    const p = fn(i);
    return { epoch: start + i * step, open: p - 0.2, high: p + 0.5, low: p - 0.5, close: p };
  });
}
function risingStructure(n, step, base = 100) {
  return Array.from({ length: n }, (_, i) => {
    const cycle = i % 8;
    const close = base + Math.floor(i / 8) * 3 + (cycle < 4 ? cycle * 0.2 : (8 - cycle) * 0.2);
    return { epoch: 1_700_000_000 + i * step, open: close - 0.1, high: close + (cycle === 3 ? 1.5 : 0.25),
      low: close - (cycle === 7 ? 1.5 : 0.25), close };
  });
}

test("timeframes are explicit and invalid input is rejected", () => {
  assert.equal(TF.H4, 14400);
  assert.equal(validCandles(bars(3, 60, i => 100 + i)), true);
  assert.equal(validCandles([{ epoch: 2, open: 1, high: 0, low: 0, close: 1 }]), false);
});
test("only candles closed by the decision timestamp are visible", () => {
  const data = bars(3, 300, i => 100 + i);
  const cutoff = data[1].epoch + 300;
  assert.equal(completed(data, "M5", cutoff).length, 2);
  assert.equal(completed(data, "M5", cutoff - 1).length, 1);
});
test("pivots are unavailable until all right-hand confirmation candles have closed", () => {
  const data = [
    {epoch:0,open:1,high:2,low:0,close:1},
    {epoch:60,open:1,high:3,low:0,close:1},
    {epoch:120,open:1,high:5,low:0,close:1},
    {epoch:180,open:1,high:3,low:0,close:1},
    {epoch:240,open:1,high:2,low:0,close:1}
  ];
  assert.equal(confirmedPivots(data, "M5", 240 + 300 - 1).highs.length, 0);
  assert.equal(confirmedPivots(data, "M5", 240 + 300).highs.length, 1);
});
test("structure reports warming when confirmed swing points are insufficient", () => {
  assert.equal(structure(bars(10, 3600, i => 100 + i), "H1", 2_000_000_000).state, "warming");
});
test("missing timeframe history suppresses a candidate", () => {
  const r = evaluateTopDown("JD100", {}, 2_000_000_000);
  assert.equal(r.state, "warming");
});
test("management is advisory-only and does not mutate the signal", () => {
  const signal = { direction:"BUY", entry:100, stopLoss:98, tp1:103 };
  const before = JSON.stringify(signal);
  const candles = { H1: bars(5, 3600, i => 101 + i), H4: bars(5, 14400, i => 101 + i) };
  const events = managementAdvisories(signal, candles, 2_000_000_000);
  assert.ok(Array.isArray(events));
  assert.ok(events.some(e => e.type === "BREAK_EVEN_REVIEW"));
  assert.ok(events.some(e => e.type === "TRAILING_PROTECTION_REVIEW"));
  assert.equal(JSON.stringify(signal), before);
});
test("unknown entry variants are rejected rather than silently substituted", () => {
  assert.throws(() => evaluateTopDown("JD100", {}, 2_000_000_000, "M1_SCALP"), /Unknown entry variant/);
});
