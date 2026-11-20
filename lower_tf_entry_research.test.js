"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport, mergeLowerTimeframeArchive, SECONDS, MARKETS, LIMITS, R10_ARCHIVE_LIMITS } = require("./lower_tf_entry_research");

const IDS = ["R_10", "R_25", "R_50"];
const BASE = Math.floor(1794000000 / 900) * 900;

test("includes Jump 75 in the lower-timeframe research archive", () => {
  assert.ok(MARKETS.includes("JD75"));
});

function candles(tf, count) {
  const step = SECONDS[tf];
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + i / 1000;
    const close = open + 0.01;
    return { epoch: BASE + i * step, open, high: close + 0.01, low: open - 0.01, close };
  });
}
function fixture(m1Count = 1440) {
  const archive = { version: 1, markets: {} };
  const incoming = {};
  for (const id of IDS) {
    const timeframes = { M1: candles("M1", m1Count), M5: candles("M5", 500), M15: candles("M15", 400) };
    archive.markets[id] = { marketName: id, timeframes };
    incoming[id] = { timeframes };
  }
  return { archive, incoming };
}

test("requires three clean markets with at least 1,440 M1, 500 M5, 400 M15 candles and 24h overlap", () => {
  const { archive, incoming } = fixture();
  const report = buildReport(archive, incoming);
  assert.equal(report.marketsReady, 3);
  assert.equal(report.mode, "ready_for_lower_timeframe_replay");
  for (const id of IDS) assert.ok(report.markets[id].commonOverlapHours >= 24);
});

test("does not qualify a market with fewer than 1,440 M1 candles", () => {
  const { archive, incoming } = fixture(1439);
  assert.equal(buildReport(archive, incoming).marketsReady, 0);
});

for (const [label, mutate] of [
  ["duplicate timestamps", rows => rows.push({ ...rows[0] })],
  ["invalid OHLC", rows => { rows[0] = { ...rows[0], high: rows[0].low - 1 }; }],
  ["unaligned timestamps", rows => { rows[0] = { ...rows[0], epoch: rows[0].epoch + 1 }; }]
]) {
  test(`rejects ${label}`, () => {
    const { archive, incoming } = fixture();
    mutate(incoming.R_10.timeframes.M1);
    assert.equal(buildReport(archive, incoming).marketsReady, 2);
    const stats = buildReport(archive, incoming).markets.R_10.frames.M1;
    if (label === "duplicate timestamps") assert.equal(stats.duplicateEpochs, 1);
    if (label === "invalid OHLC") assert.equal(stats.invalidCandles, 1);
    if (label === "unaligned timestamps") assert.equal(stats.unalignedEpochs, 1);
  });
}

test("an older M1 gap does not block a fresh 24-hour continuous segment", () => {
  const { archive, incoming } = fixture();
  const rows = archive.markets.R_10.timeframes.M1;
  rows.unshift({ ...rows[0], epoch: rows[0].epoch - 30_000 });
  const report = buildReport(archive, incoming, { focusMarket: "R_10" });
  assert.equal(report.markets.R_10.frames.M1.gaps, 1);
  assert.equal(report.markets.R_10.frames.M1.latestSegmentCandles, 1440);
  assert.equal(report.marketsReady, 1);
  assert.equal(report.mode, "ready_for_lower_timeframe_replay");
  assert.equal(report.focusMarket, "R_10");
});

test("focused pair qualification does not wait for three markets", () => {
  const { archive, incoming } = fixture();
  archive.markets.R_25.timeframes.M1 = candles("M1", 900);
  archive.markets.R_50.timeframes.M1 = candles("M1", 900);
  const focused = buildReport(archive, incoming, { focusMarket: "R_10" });
  const portfolio = buildReport(archive, incoming);
  assert.equal(focused.marketsReady, 1);
  assert.equal(focused.marketsRequired, 1);
  assert.equal(focused.mode, "ready_for_lower_timeframe_replay");
  assert.equal(portfolio.marketsReady, 1);
  assert.equal(portfolio.mode, "collecting_lower_timeframe_history");
});


test("expands retained history only for R_10 without changing other markets", () => {
  const prior = { version: 1, markets: {
    R_10: { marketName: "R_10", timeframes: {
      M1: candles("M1", 16000), M5: candles("M5", 4100), M15: candles("M15", 1900)
    } },
    R_25: { marketName: "R_25", timeframes: {
      M1: candles("M1", 6000), M5: candles("M5", 2100), M15: candles("M15", 1300)
    } }
  } };
  const merged = mergeLowerTimeframeArchive(prior, {
    R_10: { marketName: "R_10", timeframes: {} },
    R_25: { marketName: "R_25", timeframes: {} }
  });
  assert.equal(merged.markets.R_10.timeframes.M1.length, R10_ARCHIVE_LIMITS.M1);
  assert.equal(merged.markets.R_10.timeframes.M5.length, R10_ARCHIVE_LIMITS.M5);
  assert.equal(merged.markets.R_10.timeframes.M15.length, R10_ARCHIVE_LIMITS.M15);
  assert.equal(merged.markets.R_25.timeframes.M1.length, LIMITS.M1);
  assert.equal(merged.markets.R_25.timeframes.M5.length, LIMITS.M5);
  assert.equal(merged.markets.R_25.timeframes.M15.length, LIMITS.M15);
  assert.equal(merged.markets.R_10.timeframes.M1[0].epoch, BASE + (16000 - R10_ARCHIVE_LIMITS.M1) * SECONDS.M1);
});
