"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateBars,
  candidateGrid,
  buildFeatures,
  scoreCandidate,
  runReplay,
  loadArchive
} = require("../scripts/r50_replay");

function syntheticBars(count = 260) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.08 + Math.sin(i / 4) * 0.2;
    return {
      epoch: 1700000000 + i * 900,
      open: close - 0.05,
      high: close + 0.15,
      low: close - 0.15,
      close
    };
  });
}

test("R_50 replay refuses missing, duplicate, or malformed M15 candles", () => {
  const bars = syntheticBars();
  assert.doesNotThrow(() => validateBars(bars));
  const gap = syntheticBars();
  gap[100].epoch += 900;
  assert.throws(() => validateBars(gap), /gap or duplicate/);
  const malformed = syntheticBars();
  malformed[50].high = malformed[50].close - 1;
  assert.throws(() => validateBars(malformed), /Invalid OHLC range/);
});

test("candidate grid is deterministic and contains 360 configurations", () => {
  const first = candidateGrid();
  const second = candidateGrid();
  assert.equal(first.length, 360);
  assert.deepEqual(first, second);
});

test("feature builder creates finite EMA, RSI and ATR after warmup", () => {
  const features = buildFeatures(syntheticBars());
  assert.equal(features.length, 260);
  assert.equal(features[10].atr, null);
  assert.ok(features[100].atr > 0);
  assert.ok(Number.isFinite(features[100].e20));
  assert.ok(Number.isFinite(features[100].e50));
  assert.ok(Number.isFinite(features[100].rsi));
});

test("scoreCandidate is deterministic and reports resolved/time outcomes separately", () => {
  const bars = syntheticBars();
  const features = buildFeatures(bars);
  const config = { pullback: false, bodyMin: 0, rsiMode: "off", stopAtr: 1, rewardRisk: 1 };
  const first = scoreCandidate(bars, features, config, 64, bars.length);
  const second = scoreCandidate(bars, features, config, 64, bars.length);
  assert.deepEqual(first, second);
  assert.equal(first.resolved + first.ambiguous + first.timeExits, first.signals);
});

test("runReplay preserves a chronological split and labels output research-only", () => {
  const report = runReplay(syntheticBars(500));
  assert.equal(report.market, "R_50");
  assert.equal(report.status, "research_only_not_approved_for_promotion");
  assert.equal(report.split.discoveryBars, 300);
  assert.equal(report.split.holdoutBars, 200);
  assert.equal(report.candidateCount, 360);
  assert.ok(Array.isArray(report.topDiscoveryCandidates));
});

test("R_50 replay does not silently accept a non-contiguous series", () => {
  const bars = syntheticBars(500);
  bars[250].epoch += 900;
  assert.throws(() => runReplay(bars), /gap or duplicate/);
});

test("actual archived R_50 candles replay reproducibly and print holdout comparison", () => {
  const bars = loadArchive();
  const report = runReplay(bars);
  assert.equal(report.market, "R_50");
  assert.equal(report.bars, 1080);
  assert.equal(report.split.discoveryBars, 648);
  assert.equal(report.split.holdoutBars, 432);
  assert.ok(report.topDiscoveryCandidates.length > 0);
  assert.ok(report.frozenCandidate);
  assert.equal(report.frozenCandidate.config.pullback, true);
  assert.equal(report.frozenCandidate.config.bodyMin, 0.5);
  assert.equal(report.frozenCandidate.config.rsiMode, "strong");
  assert.equal(report.frozenCandidate.config.stopAtr, 1.25);
  assert.equal(report.frozenCandidate.config.rewardRisk, 1.5);
  assert.ok(report.baseline);
  console.log("\nR_50 ARCHIVE REPLAY SUMMARY");
  console.log(JSON.stringify({
    bars: report.bars,
    firstEpoch: report.firstEpoch,
    lastEpoch: report.lastEpoch,
    discoveryBars: report.split.discoveryBars,
    holdoutBars: report.split.holdoutBars,
    frozenCandidate: report.frozenCandidate,
    baseline: report.baseline,
    topDiscoveryCandidates: report.topDiscoveryCandidates.slice(0, 10).map(item => ({
      config: item.config,
      discovery: item.discovery,
      holdout: item.holdout
    }))
  }, null, 2));
});
