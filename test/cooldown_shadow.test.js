"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateCooldown, buildCooldownShadowReport } = require("../cooldown_shadow");

function row(id, epoch, overrides = {}) {
  return {
    signalId: id, entryCandleEpoch: epoch, marketId: "R_50", category: "SCALP",
    direction: "BUY", telegramStatus: "sent", status: "expired", ...overrides
  };
}

test("market-category cooldown accepts the first candidate and suppresses nearby repeats", () => {
  const rows = [row("a", 1000), row("b", 1600), row("c", 2800), row("other", 1600, { category: "SHORT_TERM" })];
  const result = simulateCooldown(rows, 15, "market_category");
  assert.equal(result.accepted, 3);
  assert.equal(result.suppressed, 1);
  assert.deepEqual(result.suppressedRecords.map(item => item.signalId), ["b"]);
  assert.equal(result.sent, 3);
  assert.equal(result.deliveryRate, 100);
});

test("cooldown scope keeps different markets independent", () => {
  const rows = [row("r50", 1000), row("r25", 1100, { marketId: "R_25" }), row("r50-repeat", 1200)];
  const result = simulateCooldown(rows, 30, "market");
  assert.equal(result.accepted, 2);
  assert.equal(result.suppressed, 1);
  assert.equal(result.suppressedRecords[0].signalId, "r50-repeat");
});

test("shadow report preserves the journal and includes the recommended window", () => {
  const rows = [row("a", 1000), row("b", 1300), row("c", 3000, { status: "tp2_hit" })];
  const before = JSON.stringify(rows);
  const report = buildCooldownShadowReport({ signals: rows }, "2026-11-21T00:00:00.000Z", [30]);
  assert.equal(report.mode, "shadow_only");
  assert.equal(report.recommendedWindowMinutes, 30);
  assert.equal(report.windows[0].suppressed, 1);
  assert.equal(report.windows[0].wins, 1);
  assert.equal(JSON.stringify(rows), before);
});
