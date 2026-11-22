"use strict";

const CONFIG = require("./market_category_filter_forward_shadow_config.json");

function exactKey(record) {
  return [record?.marketId || "unknown", record?.direction || "unknown", record?.category || "unknown"].join(" / ");
}
function marketCategoryKey(record) {
  return [record?.marketId || "unknown", record?.category || "unknown"].join(" / ");
}
function classifyMarketCategoryFilterShadow(record) {
  const key = exactKey(record);
  const marketCategory = marketCategoryKey(record);
  const priorWeakBuy = CONFIG.priorWeakBuyCohorts.includes(key);
  const newMarketCategory = CONFIG.newMarketCategoryCohorts.includes(marketCategory);
  const scoped = priorWeakBuy || newMarketCategory;
  return {
    version: CONFIG.version,
    mode: CONFIG.mode,
    scoped,
    wouldSuppress: scoped,
    reason: priorWeakBuy ? "prior_weak_buy_cohort" : newMarketCategory ? "new_weak_market_category_cohort" : null,
    filterGroup: priorWeakBuy ? "prior_weak_buy" : newMarketCategory ? "new_market_category" : null,
    cohort: key,
    marketCategory
  };
}
module.exports = { CONFIG, exactKey, marketCategoryKey, classifyMarketCategoryFilterShadow };
