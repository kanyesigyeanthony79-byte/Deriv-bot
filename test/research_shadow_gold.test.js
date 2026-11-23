"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MARKETS, toAlert } = require("../research_shadow_telegram_collector");

test("Gold is included in the active research-shadow scanner", () => {
  assert.ok(MARKETS.some(([id]) => id === "frxXAUUSD"));
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
  }, "M5_BREAKOUT_M1_RETEST");
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
