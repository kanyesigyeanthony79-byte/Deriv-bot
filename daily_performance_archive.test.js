"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDailyPerformanceArchive, legacyDate, mtfDate } = require("./daily_performance_archive");

test("archive reconstructs every recoverable day and separates signal pipelines", () => {
  const legacy = { signals: [
    { signalId:"L1", localDate:"2026-11-17", status:"sent", finalOutcome:"TP2", tp1Hit:true },
    { signalId:"L2", localDate:"2026-11-17", status:"delivery_failed", statusReason:"worker_502" },
    { signalId:"L3", createdAt:"2026-11-18T19:30:00.000Z", status:"sent", finalOutcome:"SL" }
  ], dailyReports: {
    "2026-11-17": { delivered:true, telegramConfirmed:true, attemptedAt:"2026-11-18T00:15:00.000Z", stats:{generated:2} }
  }};
  const mtf = { signals: [
    { signalId:"M1", entryCandleEpoch:Date.parse("2026-11-17T10:00:00Z")/1000, marketId:"R_50", status:"tp2_hit", telegramStatus:"sent", strategyVersion:"MTF_BASELINE_V1", tp1Hit:true },
    { signalId:"M2", entryCandleEpoch:Date.parse("2026-11-17T10:15:00Z")/1000, marketId:"R_50", status:"pending", telegramStatus:"not_sent" }
  ]};
  const a = buildDailyPerformanceArchive(legacy, mtf, "2026-11-19T00:00:00Z");
  const day = a.days.find(d => d.date === "2026-11-17");
  assert.ok(day);
  assert.equal(day.recordStatus, "verified_daily_report");
  assert.equal(day.legacy.generated, 2);
  assert.equal(day.legacy.wins, 1);
  assert.equal(day.legacy.missed, 1);
  assert.equal(day.multiTimeframe.generated, 2);
  assert.equal(day.multiTimeframe.wins, 1);
  assert.equal(day.legacy.signals[0].source, "legacy_15m");
  assert.equal(a.coverage.verifiedDailyReports, 1);
  assert.equal(legacyDate({createdAt:"2026-11-18T19:30:00.000Z"}), "2026-11-18");
  assert.equal(mtfDate({entryCandleEpoch:Date.parse("2026-11-17T10:00:00Z")/1000}), "2026-11-17");
});

test("unconfirmed days are reconstructed and missing days are never invented", () => {
  const a = buildDailyPerformanceArchive({signals:[
    {signalId:"A",localDate:"2026-11-13",status:"sent",finalOutcome:"UNVERIFIED"}
  ]},{signals:[]});
  assert.equal(a.coverage.days,1);
  assert.equal(a.days[0].recordStatus,"reconstructed_from_journals");
  assert.equal(a.days[0].reportDelivery,"no_saved_delivery_record");
  assert.equal(a.days[0].legacy.unverified,1);
});

test("a daily record without explicit Telegram confirmation is not verified", () => {
  const a = buildDailyPerformanceArchive({signals:[],dailyReports:{
    "2026-11-18":{delivered:true,stats:{generated:9}}
  }},{signals:[]});
  assert.equal(a.days[0].recordStatus,"reconstructed_from_journals");
  assert.equal(a.days[0].reportDelivery,"delivery_not_confirmed");
});
