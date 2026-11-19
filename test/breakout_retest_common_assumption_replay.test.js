"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assessMarket, splitBounds, commonEntry, resolveOutcome, simulateSplit,
  buildReport, MINIMUM, MIN_READY_MARKETS
} = require("../breakout_retest_common_assumption_replay");

function candles(count, seconds, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    epoch: start + i * seconds, open: 100, high: 100.2, low: 99.8, close: 100
  }));
}
function readyMarket() {
  return {
    marketName: "Test",
    timeframes: {
      M1: candles(1500, 60),
      M5: candles(500, 300),
      M15: candles(400, 900)
    }
  };
}
function testTrade(direction = "BUY") {
  const m1 = candles(70, 60);
  m1._atr1 = Array(70).fill(1);
  return { m1, triggerIndex: 4, entryIndex: 5, direction };
}

test("readiness requires clean continuous M1/M5/M15 history and 24h overlap", () => {
  const ready = assessMarket("R_10", readyMarket());
  assert.equal(ready.status, "ready");
  assert.equal(ready.checks.M1, true);
  assert.equal(ready.checks.M5, true);
  assert.equal(ready.checks.M15, true);
  assert.ok(ready.overlapHours >= 24);

  const bad = readyMarket();
  bad.timeframes.M5[100].epoch += 300;
  assert.equal(assessMarket("R_10", bad).status, "not_ready");
});
test("readiness rejects duplicate, invalid and unaligned archive rows", () => {
  const bad = readyMarket();
  bad.timeframes.M1.push({ ...bad.timeframes.M1.at(-1) });
  assert.equal(assessMarket("R_10", bad).checks.quality, false);
});
test("split boundaries preserve chronological order and one-hour embargo", () => {
  const b = splitBounds(0, 100000);
  assert.ok(b.discovery.end < b.validation.start);
  assert.ok(b.validation.end < b.holdout.start);
  assert.equal(b.validation.start - b.discovery.end, 7200);
  assert.equal(b.holdout.start - b.validation.end, 7200);
});
test("common entry uses the same five completed M1 candles and fixed risk bounds", () => {
  const { m1, triggerIndex, entryIndex, direction } = testTrade();
  const entry = commonEntry({ m1, triggerIndex, entryIndex, direction });
  assert.equal(entry.status, "entry");
  assert.equal(entry.entryEpoch, m1[entryIndex].epoch);
  assert.equal(entry.riskDistance, 0.3);
  assert.equal(entry.target, entry.entry + 0.6);
});
test("common outcome distinguishes target, stop, ambiguity and time exit", () => {
  const m1 = candles(60, 60);
  const base = { entryEpoch: 0, direction: "BUY", stop: 99, target: 102, entry: 100, riskDistance: 1 };
  const targetBars = m1.map(x => ({ ...x })); targetBars[1].high = 102.1;
  assert.equal(resolveOutcome(targetBars, base).status, "target");
  const stopBars = m1.map(x => ({ ...x })); stopBars[1].low = 98.9;
  assert.equal(resolveOutcome(stopBars, base).status, "stopped");
  const bothBars = m1.map(x => ({ ...x })); bothBars[0].high = 102.1; bothBars[0].low = 98.9;
  assert.equal(resolveOutcome(bothBars, base).status, "ambiguous");
  const time = resolveOutcome(m1, base);
  assert.equal(time.status, "time_exit");
});
test("split simulation applies one-position guard and reports unresolved outcomes separately", () => {
  const m1 = candles(240, 60);
  const entry = (epoch, index) => ({
    setupEpoch: epoch, entryEpoch: epoch, triggerEpoch: epoch - 60,
    direction: "BUY", entry: 100, stop: 99, target: 102, riskDistance: 1
  });
  const pack = {
    noEntry: [],
    entries: [entry(0), entry(300), entry(7200)]
  };
  const stats = simulateSplit(pack, m1, { start: 0, end: 14400 });
  assert.equal(stats.setups, 3);
  assert.equal(stats.overlapSkipped, 1);
  assert.equal(stats.entries, 2);
  assert.equal(stats.timeExit, 2);
});
test("report waits for at least three fully ready markets", () => {
  const archive = { markets: { R_10: readyMarket(), R_25: readyMarket() } };
  const report = buildReport(archive, "2026-11-19T00:00:00Z");
  assert.equal(MIN_READY_MARKETS, 3);
  assert.equal(report.mode, "waiting_for_research_data_quality");
  assert.equal(report.overall, null);
  assert.equal(report.readiness.readyMarketCount, 2);
});
