"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { dailySummary, buildDailySummaryMessage, previousUgandaDay } = require("../daily_summary");

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
