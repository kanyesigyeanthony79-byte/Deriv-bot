"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MARKETS, toAlert, normalizeCandles } = require("../research_shadow_telegram_collector");
const breakoutM1 = require("../breakout_retest_shadow");
const emaPullback = require("../m5_ema_pullback_shadow");
const breakoutM5M15 = require("../breakout_retest_m5_m15_shadow");
const emaPullback = require("../m5_ema_pullback_shadow");

test("Gold M15 session gaps are accepted only within a bounded window", () => {
  const rows = Array.from({ length: 65 }, (_, i) => {
    const bar = i < 20 ? i : i + 5;
    const price = 3500 + i;
    return { epoch: bar * 900, open: price, high: price + 2, low: price - 1, close: price + 1 };
  });
  assert.equal(breakoutM1.validFrame(rows, 900, 55), false);
  assert.equal(breakoutM1.validFrame(rows, 900, 55, 6 * 60 * 60), true);
  assert.equal(breakoutM5M15.validFrame(rows, 900, 55), false);
  assert.equal(breakoutM5M15.validFrame(rows, 900, 55, 6 * 60 * 60), true);
  assert.equal(emaPullback.continuous(rows, 900, 65), false);
  assert.equal(emaPullback.continuous(rows, 900, 65, 24), true);
});

test("collector drops misaligned partial candles before strategy validation", () => {
  const rows = [
    { epoch: 39, open: 1, high: 2, low: 1, close: 2 },
    { epoch: 900, open: 2, high: 3, low: 2, close: 3 }
  ];
  assert.deepEqual(normalizeCandles(rows, 900, 2000).map(c => c.epoch), [900]);
});

test("Gold is included in the active research-shadow scanner", () => {
  assert.ok(MARKETS.some(([id]) => id === "frxXAUUSD"));
});


test("Gold is enabled in all three isolated research strategy engines", () => {
  assert.ok(breakoutM1.RESEARCH_MARKETS.includes("frxXAUUSD"));
  assert.ok(emaPullback.MARKETS.includes("frxXAUUSD"));
  assert.ok(breakoutM5M15.RESEARCH_MARKETS.includes("frxXAUUSD"));
});

test("Gold research candidates are formatted as shadow-only Telegram alerts", () => {
  const alert = toAlert({
    signalId: "frxXAUUSD-SCALP-123",
    marketId: "frxXAUUSD",
    market: "Gold (XAUUSD)",
    direction: "BUY",
    entry: 4000,
    stopLoss: 3990,
    tp2: 4020,
    setupTimeframe: "M15",
    entryTimeframe: "M1",
    confirmationTimeframe: "M5"
  }, "M5_BREAKOUT_M1_RETEST", undefined, false);
  assert.equal(alert.marketId, "frxXAUUSD");
  assert.equal(alert.source, "RESEARCH_SHADOW");
  assert.equal(alert.paper, true);
  assert.equal(alert.live, false);
  assert.equal(alert.status, "SHADOW");
});

test("the Telegram research-shadow endpoint explicitly permits Gold and both 1-second products", () => {
  const workerPath = path.join(__dirname, "..", "workers", "deriv-telegram-alerts", "worker.js");
  const worker = fs.readFileSync(workerPath, "utf8");
  assert.match(worker, /allowedMarkets\s*=\s*new Set\(\[[^\]]*"frxXAUUSD"/);
  assert.match(worker, /"1HZ10V"/);
  assert.match(worker, /"1HZ75V"/);
  assert.match(worker, /normalized\.includes\("1hz10v"\).*normalized\.includes\("volatility101s"/);
});
