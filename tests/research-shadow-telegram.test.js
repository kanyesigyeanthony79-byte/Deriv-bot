"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const collector = require("../research_shadow_telegram_collector");

test("shadow collector excludes standard Volatility 10 and includes both distinct 1-second products", () => {
  assert.equal(collector.MARKETS.some(([id]) => id === "R_10"), false);
  assert.deepEqual(collector.MARKETS.map(([id]) => id), [
    "R_25", "R_50", "R_75", "JD75", "JD100", "CRASH500", "BOOM500", "frxXAUUSD",
    "R_10_1S", "R_75_1S"
  ]);
  assert.equal(collector.MARKETS.find(([id]) => id === "R_10_1S")[1], "Volatility 10 (1s) Index");
  assert.equal(collector.MARKETS.find(([id]) => id === "R_75_1S")[1], "Volatility 75 (1s) Index");
});

test("both 1-second volatility products can produce research-only Telegram alerts", () => {
  for (const [marketId, market] of [
    ["R_10_1S", "Volatility 10 (1s) Index"],
    ["R_75_1S", "Volatility 75 (1s) Index"]
  ]) {
    const alert = collector.toAlert({
      signalId: marketId + "-example-123", marketId, market,
      direction: "BUY", entry: 100, stopLoss: 95, tp2: 110
    }, "M5_BREAKOUT_M1_RETEST");
    assert.equal(alert.marketId, marketId);
    assert.equal(alert.source, "RESEARCH_SHADOW");
    assert.equal(alert.paper, true);
    assert.equal(alert.live, false);
    assert.equal(alert.status, "SHADOW");
  }
});

test("shadow alerts contain demo-only routing fields and calculated TP1", () => {
  const alert = collector.toAlert({
    signalId: "R_25-example-123", marketId: "R_25", market: "Volatility 25 Index",
    direction: "BUY", entry: 100, stopLoss: 95, tp2: 110,
    setupTimeframe: "M5", entryTimeframe: "M1", confirmationTimeframe: "M1"
  }, "M5_BREAKOUT_M1_RETEST");
  assert.equal(alert.source, "RESEARCH_SHADOW");
  assert.equal(alert.paper, true);
  assert.equal(alert.live, false);
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
