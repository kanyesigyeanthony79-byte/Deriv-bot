"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MARKETS, toAlert } = require("../research_shadow_telegram_collector");
const breakoutM1 = require("../breakout_retest_shadow");
const emaPullback = require("../m5_ema_pullback_shadow");
const breakoutM5M15 = require("../breakout_retest_m5_m15_shadow");

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
  assert.match(worker, /"RB100"/);
  assert.match(worker, /"RB200"/);
  assert.match(worker, /normalized\.includes\("1hz10v"\).*normalized\.includes\("volatility101s"/);
});
