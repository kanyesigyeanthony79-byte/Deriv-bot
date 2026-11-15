"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { dailySummary, buildDailySummaryMessage } = require("../daily_summary");

test("keeps legacy and multi-timeframe daily counts separate", () => {
  const legacy = [
    { localDate: "2026-11-15", marketId: "R_50", market: "Volatility 50 Index", status: "sent", finalOutcome: "SL", maxFavourablePoints: 0.4 },
    { localDate: "2026-11-15", marketId: "R_25", market: "Volatility 25 Index", status: "stale", finalOutcome: null }
  ];
  const mtf = [
    { entryCandleEpoch: Date.parse("2026-11-15T09:00:00Z") / 1000, marketId: "R_75", market: "Volatility 75 Index", category: "SHORT_TERM", direction: "SELL", entryTimeframe: "M5", status: "tp2_hit", tp1Hit: true, telegramStatus: "sent", maxFavourablePoints: 10, maxFavourablePct: 1 },
    { entryCandleEpoch: Date.parse("2026-11-15T10:00:00Z") / 1000, marketId: "JD100", market: "Jump 100 Index", category: "SWING", direction: "BUY", entryTimeframe: "H1", status: "expired", tp1Hit: false, maxFavourablePoints: 2, maxFavourablePct: 0.2 },
    { entryCandleEpoch: Date.parse("2026-11-15T11:00:00Z") / 1000, marketId: "R_10", market: "Volatility 10 Index", category: "SCALP", direction: "SELL", entryTimeframe: "M1", status: "stopped_after_tp1", tp1Hit: true, telegramStatus: "failed" },
    { entryCandleEpoch: Date.parse("2026-11-15T12:00:00Z") / 1000, marketId: "R_25", market: "Volatility 25 Index", category: "SHORT_TERM", direction: "BUY", entryTimeframe: "M5", status: "pending", tp1Hit: false }
  ];

  const summary = dailySummary(legacy, "2026-11-15", [
    ["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"],
    ["R_50", "Volatility 50 Index"], ["R_75", "Volatility 75 Index"],
    ["JD100", "Jump 100 Index"]
  ], mtf);

  assert.equal(summary.generated, 2);
  assert.equal(summary.sent, 1);
  assert.equal(summary.missed, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.multiTimeframe.generated, 4);
  assert.equal(summary.multiTimeframe.sent, 1);
  assert.equal(summary.multiTimeframe.deliveryFailed, 1);
  assert.equal(summary.multiTimeframe.deliveryUntracked, 2);
  assert.equal(summary.multiTimeframe.wins, 1);
  assert.equal(summary.multiTimeframe.losses, 1);
  assert.equal(summary.multiTimeframe.expired, 1);
  assert.equal(summary.multiTimeframe.unresolved, 1);
  assert.equal(summary.multiTimeframe.tp1, 2);
  assert.equal(summary.legacyMfeCount, 1);
  assert.equal(summary.mtfMfeCount, 2);
  assert.equal(summary.mfeCount, 3);
  assert.ok(summary.multiTimeframe.byMarket.some(line => line.startsWith("Jump 100 Index:")));
});

test("labels the two data sources and explains MFE in the Telegram message", () => {
  const summary = dailySummary([], "2026-11-15", [], []);
  const message = buildDailySummaryMessage(summary);
  assert.match(message, /LEGACY 15-MINUTE SIGNALS/);
  assert.match(message, /MULTI-TIMEFRAME OBSERVATION SIGNALS/);
  assert.match(message, /MFE is the greatest favourable completed-candle excursion/);
  assert.match(message, /does not prove TP was reached before SL/);
});
