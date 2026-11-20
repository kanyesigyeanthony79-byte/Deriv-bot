"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
test("R_50 allows tagged Original M15 Priority Pair BUY and SELL alerts", async () => {
  const { shouldDeliverTelegramAlert } = await import("../telegram_routing.mjs");
  for (const direction of ["BUY", "SELL"]) {
    assert.equal(shouldDeliverTelegramAlert({ event: "new_signal", source: "LEGACY_15M", marketId: "R_50", priorityTier: "RESEARCH_PRIORITY", direction }), true);
    assert.equal(shouldDeliverTelegramAlert({ event: "outcome", source: "LEGACY_15M", market: "Volatility 50 Index", priorityTier: "RESEARCH_PRIORITY", direction }), true);
  }
});

test("R_50 blocks Promoted MTF alerts and untagged or unknown sources", async () => {
  const { shouldDeliverTelegramAlert } = await import("../telegram_routing.mjs");
  assert.equal(shouldDeliverTelegramAlert({ event: "new_signal", source: "PROMOTED_MTF", marketId: "R_50", priorityTier: "RESEARCH_PRIORITY" }), false);
  assert.equal(shouldDeliverTelegramAlert({ event: "outcome", source: "PROMOTED_MTF", marketId: "R_50" }), false);
  assert.equal(shouldDeliverTelegramAlert({ event: "new_signal", source: "LEGACY_15M", marketId: "R_50" }), false);
  assert.equal(shouldDeliverTelegramAlert({ event: "new_signal", source: "UNKNOWN", market: "Volatility 50 Index" }), false);
});

test("other markets and daily summaries keep their existing delivery", async () => {
  const { shouldDeliverTelegramAlert } = await import("../telegram_routing.mjs");
  assert.equal(shouldDeliverTelegramAlert({ event: "new_signal", source: "PROMOTED_MTF", marketId: "R_75" }), true);
  assert.equal(shouldDeliverTelegramAlert({ event: "new_signal", source: "LEGACY_15M", marketId: "R_10" }), true);
  assert.equal(shouldDeliverTelegramAlert({ event: "daily_summary", message: "Daily report" }), true);
});
