"use strict";

// Re-run the established replay only on the market/entry combinations that
// were positive in the initial broad screen. This is a research filter, not
// a live-market allowlist or a profitability guarantee.
const fs = require("node:fs");
const { runReplay } = require("./top_down_swing_replay");

const SELECTED = {
  R_10: ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"],
  R_25: ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"],
  R_50: ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"],
  BOOM500: ["H1_CONTROL", "M15_REFINED"]
};

function selectReport(report) {
  const markets = {};
  const summary = {};
  for (const [marketId, variants] of Object.entries(SELECTED)) {
    const source = report.markets && report.markets[marketId];
    if (!source || source.state !== "replayed") {
      markets[marketId] = { state: source ? source.state : "missing_market_data", variants: {} };
      continue;
    }
    const selectedVariants = {};
    for (const variant of variants) {
      if (source.variants && source.variants[variant]) selectedVariants[variant] = source.variants[variant];
    }
    markets[marketId] = { ...source, variants: selectedVariants };
  }
  for (const variant of ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"]) {
    const rows = Object.values(markets).filter(m => m.state === "replayed" && m.variants[variant]);
    const n = rows.reduce((sum, row) => sum + row.variants[variant].scoredCount, 0);
    const total = rows.reduce((sum, row) => {
      const item = row.variants[variant];
      return sum + (item.averageFixedR == null ? 0 : item.averageFixedR * item.scoredCount);
    }, 0);
    summary[variant] = {
      candidateCount: rows.reduce((sum, row) => sum + row.variants[variant].candidateCount, 0),
      scoredCount: n,
      averageFixedR: n ? Number((total / n).toFixed(4)) : null,
      marketsIncluded: rows.length
    };
  }
  return {
    version: 1,
    generatedAt: report.generatedAt,
    horizonDays: report.horizonDays,
    scope: "selective_positive_market_entry_pairs",
    selectedPairs: SELECTED,
    excludedMarkets: ["R_75", "JD100", "CRASH500", "frxXAUUSD"],
    assumptions: [...(report.assumptions || []),
      "Only market/entry combinations positive in the initial broad screen are retained.",
      "This is a selective historical research cohort, not an activation or live-trading allowlist."],
    markets,
    summary
  };
}

function runSelectiveReplay(snapshot) {
  const selectedSnapshot = {
    ...snapshot,
    markets: Object.fromEntries(Object.keys(SELECTED)
      .filter(id => snapshot.markets && snapshot.markets[id])
      .map(id => [id, snapshot.markets[id]]))
  };
  return selectReport(runReplay(selectedSnapshot));
}

if (require.main === module) {
  const input = process.argv[2] || "top_down_swing_snapshot.json";
  const output = process.argv[3] || "top_down_swing_selective_report.json";
  const snapshot = JSON.parse(fs.readFileSync(input, "utf8"));
  const report = runSelectiveReplay(snapshot);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, selectedPairs: report.selectedPairs, summary: report.summary }, null, 2));
}

module.exports = { SELECTED, selectReport, runSelectiveReplay };
