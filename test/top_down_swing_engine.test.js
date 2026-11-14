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

test("malformed higher-timeframe candles suppress the candidate", () => {
  const h1=bars(20,3600,i=>100+i);
  const d1=bars(20,86400,i=>100+i);
  d1[10]={...d1[10],high:d1[10].open-1};
  const result=evaluateTopDown("R_25",{H1:h1,D1:d1,H4:bars(20,14400,i=>100+i),M15:bars(20,900,i=>100+i),M5:bars(20,300,i=>100+i)},h1.at(-1).epoch+3600,"H1_CONTROL");
  assert.equal(result.state,"invalid_data");
  assert.equal(result.timeframe,"D1");
});
test("early loss warning is not delayed while waiting for a completed H4 candle", () => {
  const signal={direction:"BUY",entry:100,stopLoss:99,riskDistance:1,entryEpoch:0,decisionEpoch:1};
  const h1=bars(3,3600,i=>100-i*.6);
  const events=managementAdvisories(signal,{H1:h1,H4:[]},h1.at(-1).epoch+3600);
  assert.ok(events.some(e=>e.type==="EARLY_LOSS_REVIEW"));
});

test("all three entry variants preserve an H4/H1 thesis even when D1 context is opposite", () => {
  const end=2_000_000_000;
  const makeUp=(n,step)=>risingStructure(n,step).map((bar,i)=>({...bar,epoch:end-n*step+i*step}));
  const makeDown=(n,step)=>makeUp(n,step).map(bar=>({
    ...bar,open:200-bar.open,close:200-bar.close,high:200-bar.low,low:200-bar.high
  }));
  const frames={
    D1:makeDown(100,86400), H4:makeUp(100,14400), H1:makeUp(100,3600),
    M15:makeUp(100,900), M5:makeUp(100,300)
  };
  const last=frames.M5.at(-1), prior=frames.M5.at(-2);
  frames.M5[frames.M5.length-1]={...last,open:prior.high,close:prior.high+0.5,high:prior.high+0.7,low:prior.high-0.1};
  for(const variant of ["H1_CONTROL","M15_REFINED","M15_M5_REFINED"]) {
    const result=evaluateTopDown("R_25",frames,end,variant,{maxRiskAtr:10,minEntryNoiseAtr:0.1});
    assert.equal(result.state,"candidate",variant+" should produce the expected deterministic fixture candidate");
    assert.equal(result.direction,"BUY");
    assert.equal(result.d1Alignment,"counter_trend");
  }
});
