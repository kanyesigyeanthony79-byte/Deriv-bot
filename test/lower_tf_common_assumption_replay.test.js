"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  marketReady, continuous, resolveCommonOutcome, splitBounds, summarizeTrades,
  buildCommonAssumptionReplayReport
} = require("../lower_tf_common_assumption_replay");

function candle(epoch, open, high, low, close) {
  return { epoch, open, high, low, close };
}
function readyStats() {
  return {
    commonOverlapHours: 30,
    frames: {
      M1: { latestSegmentCandles: 1500, duplicateEpochs: 0, invalidCandles: 0, unalignedEpochs: 0 },
      M5: { latestSegmentCandles: 550, duplicateEpochs: 0, invalidCandles: 0, unalignedEpochs: 0 },
      M15: { latestSegmentCandles: 450, duplicateEpochs: 0, invalidCandles: 0, unalignedEpochs: 0 }
    }
  };
}
function flatBars(count, start = 0) {
  return Array.from({ length: count }, (_, i) => candle(start + i * 60, 100, 100.2, 99.8, 100));
}

test("readiness requires minimum latest continuous history, overlap and clean candles", () => {
  assert.equal(marketReady(readyStats()), true);
  const bad = readyStats();
  bad.frames.M1.latestSegmentCandles = 1439;
  assert.equal(marketReady(bad), false);
  const gap = readyStats();
  gap.frames.M5.duplicateEpochs = 1;
  assert.equal(marketReady(gap), false);
  const shortOverlap = readyStats();
  shortOverlap.commonOverlapHours = 23.99;
  assert.equal(marketReady(shortOverlap), false);
});

test("continuous candle validator rejects gaps and misaligned epochs", () => {
  assert.equal(continuous(flatBars(4), 60), true);
  assert.equal(continuous([candle(0,100,101,99,100), candle(120,100,101,99,100)], 60), false);
  assert.equal(continuous([candle(1,100,101,99,100), candle(61,100,101,99,100)], 60), false);
});

test("common outcome uses the same 2R target and -1R stop", () => {
  const targetBars = flatBars(60);
  targetBars[1] = candle(60,100,102.1,99.9,102);
  const target = resolveCommonOutcome({m1:targetBars,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1,horizonEndEpoch:3600});
  assert.equal(target.status,"target");
  assert.equal(target.realizedR,2);

  const stopBars = flatBars(60);
  stopBars[1] = candle(60,100,100.1,98.9,99);
  const stop = resolveCommonOutcome({m1:stopBars,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1,horizonEndEpoch:3600});
  assert.equal(stop.status,"stopped");
  assert.equal(stop.realizedR,-1);
});

test("same-candle stop and target touch is ambiguous, never guessed", () => {
  const bars = flatBars(60);
  bars[0] = candle(0,100,102.1,98.9,100);
  const result = resolveCommonOutcome({m1:bars,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1,horizonEndEpoch:3600});
  assert.equal(result.status,"ambiguous");
  assert.equal(result.realizedR,null);
});

test("one-hour time exit uses last completed M1 close and missing history is not a loss", () => {
  const bars = flatBars(60);
  bars[59] = candle(3540,100,101.2,99.9,101);
  const timed = resolveCommonOutcome({m1:bars,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1,horizonEndEpoch:3600});
  assert.equal(timed.status,"time_exit");
  assert.equal(timed.realizedR,1);

  const incomplete = resolveCommonOutcome({m1:bars.slice(0,30),entryEpoch:0,entry:100,direction:"BUY",riskDistance:1,horizonEndEpoch:3600});
  assert.equal(incomplete.status,"incomplete_data");

  const gapBars = flatBars(60);
  gapBars[10] = candle(660,100,100.2,99.8,100);
  const gap = resolveCommonOutcome({m1:gapBars,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1,horizonEndEpoch:3600});
  assert.equal(gap.status,"data_gap");
});

test("chronological splits are ordered and summary excludes unresolved outcomes from expectancy", () => {
  const bounds = splitBounds(0,10000);
  assert.ok(bounds.discovery.end < bounds.validation.end);
  assert.ok(bounds.validation.end < bounds.holdout.end);
  const summary = summarizeTrades([
    {outcome:{status:"target",realizedR:2}},
    {outcome:{status:"ambiguous",realizedR:null}},
    {outcome:{status:"stopped",realizedR:-1}}
  ],4);
  assert.equal(summary.setups,4);
  assert.equal(summary.entries,3);
  assert.equal(summary.resolved,2);
  assert.equal(summary.averageGrossR,0.5);
  assert.equal(summary.outcomes.ambiguous,1);
});

test("report waits for qualified history and does not publish premature strategy results", () => {
  const report = buildCommonAssumptionReplayReport({markets:{}},{markets:{R_10:readyStats(),R_25:{frames:{}}}},"2026-11-19T00:00:00.000Z");
  assert.equal(report.mode,"waiting_for_research_data_quality");
  assert.equal(report.summary.marketsReplayed,0);
  assert.equal(report.markets.R_25.status,"not_ready");
});

test("replay respects the configured focus market instead of pooling other ready markets", () => {
  const stats = readyStats();
  const report = buildCommonAssumptionReplayReport(
    { markets: {} },
    { focusMarket: "R_10", markets: { R_10: stats, R_25: stats } },
    "2026-11-19T00:00:00.000Z"
  );
  assert.equal(report.summary.focusMarket, "R_10");
  assert.equal(report.markets.R_25.status, "outside_focus");
  assert.equal(report.summary.marketsOutsideFocus, 1);
  assert.equal(report.summary.marketsReplayed, 0);
});
