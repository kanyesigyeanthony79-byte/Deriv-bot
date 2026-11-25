"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const breakoutM1 = require("../breakout_retest_shadow");
const emaPullback = require("../m5_ema_pullback_shadow");
const breakoutM5M15 = require("../breakout_retest_m5_m15_shadow");
const collector = require("../research_shadow_telegram_collector");

test("shadow collector excludes standard Volatility 10 and includes both distinct 1-second products", () => {
  assert.equal(collector.MARKETS.some(([id]) => id === "R_10"), false);
  assert.deepEqual(collector.MARKETS.map(([id]) => id), [
    "R_25", "R_50", "R_75", "JD75", "JD100", "CRASH500", "BOOM500", "frxXAUUSD",
    "1HZ10V", "1HZ75V", "R_100", "JD25", "JD50", "CRASH100", "BOOM100", "RB100", "RB200"
  ]);
  assert.equal(collector.MARKETS.find(([id]) => id === "1HZ10V")[1], "Volatility 10 (1s) Index");
  assert.equal(collector.MARKETS.find(([id]) => id === "1HZ75V")[1], "Volatility 75 (1s) Index");
  for (const id of ["R_100", "JD25", "JD50", "CRASH100", "BOOM100"]) {
    assert.ok(collector.MARKETS.some(([marketId]) => marketId === id), id + " must be in research scanning");
  }
  assert.equal(collector.MARKETS.some(([id]) => id === "RB100"), true);
  assert.equal(collector.MARKETS.some(([id]) => id === "RB200"), true);
});


test("all seven added markets are configured in the original scanner and all three shadow strategies", () => {
  const scanner = fs.readFileSync(path.join(__dirname, "..", "hosted_scanner.js"), "utf8");
  const marketBlock = scanner.match(/const MARKETS = \\[([\\s\\S]*?)\\n\\];/);
  assert.ok(marketBlock, "original scanner market list must be discoverable");
  const added = ["R_100", "JD25", "JD50", "RB100", "RB200", "BOOM100", "CRASH100"];
  for (const id of added) {
    assert.ok(marketBlock[1].includes('"'+id+'"'), id + " must be scanned by original 15-minute system");
    assert.ok(collector.MARKETS.some(([marketId]) => marketId === id), id + " must be scanned by shadow collector");
    assert.ok(breakoutM1.RESEARCH_MARKETS.includes(id), id + " must be enabled in M1 retest strategy");
    assert.ok(emaPullback.MARKETS.includes(id), id + " must be enabled in EMA pullback strategy");
    assert.ok(breakoutM5M15.RESEARCH_MARKETS.includes(id), id + " must be enabled in M5/M15 strategy");
  }
});

test("both 1-second volatility products can produce research-only Telegram alerts", () => {
  for (const [marketId, market] of [
    ["1HZ10V", "Volatility 10 (1s) Index"],
    ["1HZ75V", "Volatility 75 (1s) Index"]
  ]) {
    const alert = collector.toAlert({
      signalId: marketId + "-example-123", marketId, market,
      direction: "BUY", entry: 100, stopLoss: 95, tp2: 110
    }, "M5_BREAKOUT_M1_RETEST", undefined, false);
    assert.equal(alert.marketId, marketId);
    assert.equal(alert.source, "RESEARCH_SHADOW");
    assert.equal(alert.paper, true);
    assert.equal(alert.live, false);
    assert.equal(alert.marketMode, "LIVE_MARKET");
    assert.equal(alert.executionMode, "DEMO_MANUAL");
    assert.equal(alert.status, "SHADOW");
  }
});

test("shadow alerts contain demo-only routing fields and calculated TP1", () => {
  const alert = collector.toAlert({
    signalId: "R_25-example-123", marketId: "R_25", market: "Volatility 25 Index",
    direction: "BUY", entry: 100, stopLoss: 95, tp2: 110,
    setupTimeframe: "M5", entryTimeframe: "M1", confirmationTimeframe: "M1"
  }, "M5_BREAKOUT_M1_RETEST", undefined, false);
  assert.equal(alert.source, "RESEARCH_SHADOW");
  assert.equal(alert.paper, true);
  assert.equal(alert.live, false);
  assert.equal(alert.marketMode, "LIVE_MARKET");
  assert.equal(alert.executionMode, "DEMO_MANUAL");
  assert.equal(alert.status, "SHADOW");
  assert.equal(alert.tp1, 107.5);
  assert.equal(alert.tp2, 110);
});

test("shadow alert builder rejects malformed and Volatility 10 signals", () => {
  assert.equal(collector.toAlert({ marketId: "R_10", signalId: "x" }, "bad"), null);
  assert.equal(collector.toAlert({
    signalId: "bad", marketId: "R_25", direction: "BUY",
    entry: 100, stopLoss: 105, tp2: 110
  }, "bad"), null);
});

test("new-signal detection is based on previously unseen stable IDs", () => {
  const previous = [{ signalId: "old" }];
  const current = [{ signalId: "old" }, { signalId: "new" }, { signalId: null }];
  assert.deepEqual(collector.newSignals(previous, current).map(s => s.signalId), ["new"]);
});

test("all seven expansion markets can generate explicitly research-only Telegram alerts", () => {
  for (const [marketId, market] of [
    ["R_100", "Volatility 100 Index"], ["JD25", "Jump 25 Index"],
    ["JD50", "Jump 50 Index"], ["CRASH100", "Crash 100 Index"],
    ["BOOM100", "Boom 100 Index"], ["RB100", "Range Break 100 Index"],
    ["RB200", "Range Break 200 Index"]
  ]) {
    const alert = collector.toAlert({
      signalId: marketId + "-example-123", marketId, market,
      direction: "SELL", entry: 100, stopLoss: 105, tp2: 90
    }, "M5_BREAKOUT_M1_RETEST", undefined, false);
    assert.equal(alert.marketId, marketId);
    assert.equal(alert.source, "RESEARCH_SHADOW");
    assert.equal(alert.paper, true);
    assert.equal(alert.live, false);
    assert.equal(alert.status, "SHADOW");
    assert.equal(alert.strategyId, "M5_BREAKOUT_M1_RETEST");
  }
});
