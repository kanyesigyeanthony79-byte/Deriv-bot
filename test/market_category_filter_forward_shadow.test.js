"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMarketCategoryFilterShadow } = require("../market_category_filter_forward_shadow");
const { updateJournal } = require("../multi_timeframe_journal");

function record(overrides = {}) {
  return { state: "signal", signalId: "R_75-SHORT_TERM-1", marketId: "R_75", direction: "SELL", category: "SHORT_TERM", entryCandleEpoch: 100, ...overrides };
}

test("new market-category shadow classifier marks both new and prior filter groups", () => {
  const r75 = classifyMarketCategoryFilterShadow(record());
  assert.equal(r75.scoped, true);
  assert.equal(r75.wouldSuppress, true);
  assert.equal(r75.reason, "new_weak_market_category_cohort");
  assert.equal(r75.filterGroup, "new_market_category");
  const prior = classifyMarketCategoryFilterShadow(record({ marketId: "JD100", direction: "BUY", category: "SCALP" }));
  assert.equal(prior.reason, "prior_weak_buy_cohort");
  assert.equal(prior.filterGroup, "prior_weak_buy");
});

test("market-category scope includes SELL while unrelated cohorts remain out of scope", () => {
  const sell = classifyMarketCategoryFilterShadow(record({ marketId: "BOOM500", direction: "SELL" }));
  assert.equal(sell.scoped, true);
  assert.equal(sell.wouldSuppress, true);
  const result = classifyMarketCategoryFilterShadow(record({ marketId: "R_50", category: "SHORT_TERM" }));
  assert.equal(result.scoped, false);
  assert.equal(result.wouldSuppress, false);
  assert.equal(result.reason, null);
  assert.equal(result.filterGroup, null);
});

test("journal stores the filter marker without changing signal state", () => {
  const result = updateJournal({ version: 1, signals: [] }, {
    R_75: { marketId: "R_75", signals: [record()], timeframes: {} }
  }, 150);
  assert.equal(result.signals[0].status, "pending");
  assert.equal(result.signals[0].marketCategoryFilterShadow.wouldSuppress, true);
  assert.equal(result.signals[0].telegramStatus, undefined);
});
