"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport, isExcluded } = require("./market_category_filter_shadow");

test("market-category shadow scenarios preserve prior exclusions and compare separately", () => {
  const journal = { signals: [
    { marketId: "R_75", category: "SHORT_TERM", direction: "BUY", status: "stopped", telegramStatus: "sent" },
    { marketId: "R_75", category: "SHORT_TERM", direction: "SELL", status: "stopped", telegramStatus: "sent" },
    { marketId: "BOOM500", category: "SHORT_TERM", direction: "SELL", status: "stopped", telegramStatus: "sent" },
    { marketId: "BOOM500", category: "SHORT_TERM", direction: "SELL", status: "tp2_hit", telegramStatus: "sent" },
    { marketId: "R_50", category: "SHORT_TERM", direction: "SELL", status: "tp2_hit", telegramStatus: "sent" }
  ] };
  const report = buildReport(journal, "2026-11-22T00:00:00.000Z");
  assert.equal(report.baseline.allObservations.generated, 5);
  assert.equal(report.scenarios[0].id, "R75_SHORT_TERM");
  assert.equal(report.scenarios[0].allObservations.generated, 3);
  assert.equal(report.scenarios[1].id, "BOOM500_SHORT_TERM");
  assert.equal(report.scenarios[1].allObservations.generated, 3);
  assert.equal(report.scenarios[2].id, "R75_AND_BOOM500_SHORT_TERM");
  assert.equal(report.scenarios[2].allObservations.generated, 1);
  assert.equal(isExcluded({ marketId: "JD100", direction: "BUY", category: "SCALP" }, []), true);
});
