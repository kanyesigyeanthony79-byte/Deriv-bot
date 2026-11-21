"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport, deliveryOf, summarize } = require("./market_direction_category_performance");

test("cohort report groups by market, direction and category", () => {
  const report = buildReport({ signals: [
    { marketId: "R_50", direction: "BUY", category: "SCALP", status: "tp2_hit", telegramStatus: "sent", entryCandleEpoch: 1700000000 },
    { marketId: "R_50", direction: "BUY", category: "SCALP", status: "stopped", telegramStatus: "sent", entryCandleEpoch: 1700000300 },
    { marketId: "R_50", direction: "SELL", category: "SCALP", status: "expired", telegramStatus: "stale", entryCandleEpoch: 1700000600 },
    { marketId: "R_25", direction: "BUY", category: "POSITION", status: "pending", telegramStatus: "quote_unavailable", entryCandleEpoch: 1700000900 }
  ]}, "2026-11-21T00:00:00.000Z");
  assert.equal(report.coverage.records, 4);
  assert.equal(report.cohorts.length, 3);
  const scalp = report.cohorts.find(row => row.key === "R_50 / BUY / SCALP");
  assert.equal(scalp.resolved, 2);
  assert.equal(scalp.winRate, 50);
  assert.equal(scalp.delivery.sent, 2);
  assert.equal(report.overall.expired, 1);
  assert.equal(report.overall.delivery.quote_unavailable, 1);
});

test("delivery and outcome classifications remain separate", () => {
  assert.equal(deliveryOf({ telegramStatus: "missed", telegramStatusReason: "live_price_too_far_from_entry" }), "price_out_of_range");
  assert.equal(deliveryOf({ telegramStatus: "missed", telegramStatusReason: "tp1_already_reached" }), "tp1_already_reached");
  assert.equal(deliveryOf({ telegramStatus: "delivery_failed" }), "delivery_failed");
  const summary = summarize([
    { status: "tp2_hit", telegramStatus: "suppressed" },
    { status: "stopped_after_tp1", telegramStatus: "quote_unavailable" },
    { status: "ambiguous" }
  ]);
  assert.equal(summary.resolved, 2);
  assert.equal(summary.winRate, 50);
  assert.equal(summary.outcomes.ambiguous, 1);
  assert.equal(summary.delivery.suppressed, 1);
  assert.equal(summary.delivery.quote_unavailable, 1);
  assert.equal(summary.delivery.untracked, 1);
  assert.equal(summary.sufficientResolvedSample, false);
});
