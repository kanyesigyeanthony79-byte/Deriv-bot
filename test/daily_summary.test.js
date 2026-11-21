"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { dailySummary, buildDailySummaryMessage, deliverDailyReport, previousUgandaDay } = require("../daily_summary");

const markets = [["R_50", "Volatility 50 Index"], ["JD100", "Jump 100 Index"]];
const signals = [
  { localDate:"2026-11-13", marketId:"R_50", status:"sent", finalOutcome:"TP2", tp1Hit:true, tp2Hit:true },
  { localDate:"2026-11-13", marketId:"R_50", status:"sent", finalOutcome:"SL_AFTER_TP1", tp1Hit:true },
  { localDate:"2026-11-13", marketId:"JD100", status:"sent", finalOutcome:"SL" },
  { localDate:"2026-11-13", marketId:"JD100", status:"sent", finalOutcome:"EXPIRED" },
  { localDate:"2026-11-13", marketId:"R_50", status:"sent", finalOutcome:"AMBIGUOUS" },
  { localDate:"2026-11-13", marketId:"R_50", status:"state_missing", finalOutcome:"UNVERIFIED" },
  { localDate:"2026-11-13", marketId:"JD100", status:"sent", finalOutcome:null },
  { localDate:"2026-11-13", marketId:"JD100", status:"stale", finalOutcome:null },
  { localDate:"2026-11-12", marketId:"R_50", status:"sent", finalOutcome:"TP2", tp2Hit:true }
];

test("daily summary separates resolved wins, losses and non-final states", () => {
  const summary = dailySummary(signals, "2026-11-13", markets);
  assert.equal(summary.generated, 8);
  assert.equal(summary.sent, 6);
  assert.equal(summary.missed, 1);
  assert.equal(summary.tp1, 2);
  assert.equal(summary.tp2, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 2);
  assert.equal(summary.resolved, 3);
  assert.equal(summary.winRate, 33.3);
  assert.equal(summary.netSignalOutcomes, -1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.ambiguous, 1);
  assert.equal(summary.unverified, 1);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.byMarket.length, 2);
});

test("daily summary separately tracks research-priority pair signal outcomes", () => {
  const tagged = [
    { localDate:"2026-11-13", marketId:"R_50", priorityTier:"RESEARCH_PRIORITY", status:"sent", finalOutcome:"TP2" },
    { localDate:"2026-11-13", marketId:"R_50", priorityTier:"RESEARCH_PRIORITY", status:"sent", finalOutcome:"SL" },
    { localDate:"2026-11-13", marketId:"R_50", status:"sent", finalOutcome:"TP2" }
  ];
  const summary = dailySummary(tagged, "2026-11-13", markets);
  assert.equal(summary.priorityPairs.generated, 2);
  assert.equal(summary.priorityPairs.sent, 2);
  assert.equal(summary.priorityPairs.wins, 1);
  assert.equal(summary.priorityPairs.losses, 1);
  assert.equal(summary.priorityPairs.resolved, 2);
  assert.equal(summary.priorityPairs.winRate, 50);
  const message = buildDailySummaryMessage(summary);
  assert.match(message, /PRIORITY PAIR RESEARCH WATCH \(R_50\)/);
  assert.match(message, /Historical 62\.9% directional follow-through is context only, not a strategy win rate/);
});

test("daily report clearly says metrics are signal outcomes, not account P/L", () => {
  const message = buildDailySummaryMessage(dailySummary(signals, "2026-11-13", markets));
  assert.match(message, /Signal outcomes only; this is not actual account profit\/loss/);
  assert.match(message, /Unverified \(state missing\): 1/);
  assert.match(message, /Win rate \(resolved wins\/losses\): 33\.3%/);
});

test("previous Uganda day uses Kampala calendar date around midnight", () => {
  const justAfterKampalaMidnight = Date.parse("2026-11-13T21:05:00Z") / 1000; // 00:05 in Uganda on Nov 14
  assert.equal(previousUgandaDay(justAfterKampalaMidnight), "2026-11-13");
});

test("empty day produces zero counts and an undefined win rate", () => {
  const summary = dailySummary(signals, "2026-11-11", markets);
  assert.equal(summary.generated, 0);
  assert.equal(summary.winRate, null);
  assert.equal(summary.netSignalOutcomes, 0);
  assert.deepEqual(summary.byMarket, []);
});

test("daily report separates legacy and all multi-timeframe MFE observations", () => {
  const legacy = [{ localDate: "2026-11-13", marketId: "R_50", market: "Volatility 50 Index",
    direction: "BUY", status: "sent", maxFavourablePoints: 18.4, maxFavourablePct: 0.74 }];
  const mtf = [
    { signalId: "a", category: "SCALP", marketId: "R_25", market: "Volatility 25 Index", direction: "SELL",
      entryTimeframe: "M1", entryCandleEpoch: Date.parse("2026-11-13T10:00:00Z") / 1000,
      status: "tp2_hit", telegramStatus: "sent", tp1Hit: true,
      maxFavourablePoints: 22, maxFavourablePct: 1.1 },
    { signalId: "b", category: "SWING", marketId: "JD100", market: "Jump 100 Index", direction: "BUY",
      entryTimeframe: "H1", entryCandleEpoch: Date.parse("2026-11-13T10:00:00Z") / 1000,
      status: "expired", maxFavourablePoints: 90, maxFavourablePct: 2.0 }
  ];
  const summary = dailySummary(legacy, "2026-11-13", markets, mtf);
  assert.equal(summary.mfeCount, 3);
  assert.equal(summary.legacyMfeCount, 1);
  assert.equal(summary.mtfMfeCount, 2);
  assert.equal(summary.multiTimeframe.generated, 2);
  assert.equal(summary.multiTimeframe.sent, 1);
  assert.equal(summary.multiTimeframe.deliveryUntracked, 1);
  assert.equal(summary.multiTimeframe.wins, 1);
  assert.equal(summary.multiTimeframe.expired, 1);
  assert.equal(summary.mfeTop[0].category, "SWING");
  const message = buildDailySummaryMessage(summary);
  assert.match(message, /LEGACY 15-MINUTE SIGNALS/);
  assert.match(message, /MULTI-TIMEFRAME OBSERVATION SIGNALS/);
  assert.match(message, /Volatility 25 Index SELL/);
  assert.match(message, /Jump 100 Index BUY/);
  assert.match(message, /does not prove TP was reached before SL/);
});



test("MTF delivery summary separates missed entries, actual delivery failures and untracked status", () => {
  const epoch = Date.parse("2026-11-13T10:00:00Z") / 1000;
  const mtf = [
    { signalId: "sent", marketId: "R_50", entryCandleEpoch: epoch, status: "pending", telegramStatus: "sent" },
    { signalId: "moved", marketId: "R_50", entryCandleEpoch: epoch, status: "pending", telegramStatus: "missed", telegramStatusReason: "live_price_too_far_from_entry" },
    { signalId: "stale", marketId: "R_50", entryCandleEpoch: epoch, status: "pending", telegramStatus: "stale" },
    { signalId: "failed", marketId: "R_50", entryCandleEpoch: epoch, status: "pending", telegramStatus: "delivery_failed" },
    { signalId: "unknown", marketId: "R_50", entryCandleEpoch: epoch, status: "pending" }
  ];
  const summary = dailySummary([], "2026-11-13", markets, mtf);
  assert.equal(summary.multiTimeframe.sent, 1);
  assert.equal(summary.multiTimeframe.deliveryMissed, 2);
  assert.equal(summary.multiTimeframe.deliveryFailed, 1);
  assert.equal(summary.multiTimeframe.deliveryUntracked, 1);
  assert.equal(summary.multiTimeframe.deliveryBreakdown.price_out_of_range, 1);
  assert.equal(summary.multiTimeframe.deliveryBreakdown.stale, 1);
  assert.equal(summary.multiTimeframe.deliveryBreakdown.delivery_failed, 1);
  assert.equal(summary.multiTimeframe.deliveryBreakdown.untracked, 1);
  const message = buildDailySummaryMessage(summary);
  assert.match(message, /Not sent \(entry moved \/ stale \/ suppressed\): 2/);
  assert.match(message, /Delivery failed: 1/);
  assert.match(message, /Delivery status untracked: 1/);
});

test("daily MTF delivery breakdown separates unavailable quotes from untracked records", () => {
  const epoch = Date.parse("2026-11-13T10:00:00Z") / 1000;
  const summary = dailySummary([], "2026-11-13", markets, [
    { signalId: "quote", marketId: "R_50", entryCandleEpoch: epoch, status: "pending", telegramStatus: "quote_unavailable" },
    { signalId: "suppressed", marketId: "R_50", entryCandleEpoch: epoch, status: "pending", telegramStatus: "suppressed" }
  ]);
  assert.equal(summary.multiTimeframe.deliveryBreakdown.quote_unavailable, 1);
  assert.equal(summary.multiTimeframe.deliveryBreakdown.suppressed, 1);
  assert.equal(summary.multiTimeframe.deliveryUntracked, 0);
  assert.match(buildDailySummaryMessage(summary), /quote unavailable 1/);
});

test("daily report labels the demo snapshot as point-in-time, not daily profit/loss", () => {
  const summary = dailySummary(signals, "2026-11-13", markets);
  const snapshot = {
    status: "ok", mode: "demo", accountId: "DOT91725732",
    balance: 10000, currency: "USD", equityEstimate: 10000,
    openPositions: [], fetchedAt: "2026-11-14T00:20:00.000Z"
  };
  const message = buildDailySummaryMessage(summary, snapshot);
  assert.match(message, /DEMO ACCOUNT SNAPSHOT \(READ-ONLY\)/);
  assert.match(message, /Account: DOT91725732/);
  assert.match(message, /Balance: 10000 USD/);
  assert.match(message, /Open contracts: 0/);
  assert.match(message, /point-in-time demo account snapshot, not daily profit\/loss/);
});

test("daily report delivery sends one daily_summary payload through the injected relay", async () => {
  const summary = dailySummary(signals, "2026-11-13", markets);
  const calls = [];
  const result = await deliverDailyReport(summary, { status: "not_configured" }, async payload => {
    calls.push(payload);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, "daily_summary");
  assert.equal(calls[0].message, calls[0].text);
  assert.match(calls[0].message, /DEMO ACCOUNT SNAPSHOT/);
  assert.equal(result.delivered, true);
});

test("failed Telegram relay rejects delivery so the scanner can retry", async () => {
  const summary = dailySummary(signals, "2026-11-13", markets);
  await assert.rejects(
    deliverDailyReport(summary, null, async () => { throw new Error("relay unavailable"); }),
    /relay unavailable/
  );
});
