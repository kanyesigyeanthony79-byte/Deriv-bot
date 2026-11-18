"use strict";

// Read-only contemporaneous comparison of forward shadow candidates with the
// production MTF baseline journal. This is not a counterfactual replay.
const BASELINE_VERSION = "MTF_BASELINE_V1";
const BASELINE_CATEGORY = "SCALP";
const MATCH_WINDOW_SECONDS = 15 * 60;

function finiteOrNull(value) {\n  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))\n    ? Number(value) : null;\n}\n\nfunction statusOf(signal) {
  return String(signal?.status || "unknown").toLowerCase();
}

function countStatuses(rows) {
  const counts = {};
  for (const row of rows) {
    const key = statusOf(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function validEpoch(value) {\n  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));\n}\n\nfunction candidateRows(journal) {
  return (Array.isArray(journal?.signals) ? journal.signals : [])
    .filter(row => row && row.evaluationSource === "forward_shadow" &&
      validEpoch(row.entryCandleEpoch) &&
      ["BUY", "SELL"].includes(row.direction) && row.marketId && row.strategyId);
}

function baselineRows(journal) {
  return (Array.isArray(journal?.signals) ? journal.signals : [])
    .filter(row => row && row.strategyVersion === BASELINE_VERSION &&
      String(row.category || "").toUpperCase() === BASELINE_CATEGORY &&
      String(row.entryTimeframe || "").toUpperCase() === "M5" &&
      Number.isFinite(Number(row.entryCandleEpoch)) &&
      ["BUY", "SELL"].includes(row.direction) && row.marketId);
}

function buildStrategyComparison(strategyId, label, candidateJournal, baseline) {
  const candidates = candidateRows(candidateJournal)
    .filter(row => row.strategyId === strategyId)
    .sort((a, b) => Number(a.entryCandleEpoch) - Number(b.entryCandleEpoch));
  const usedBaselineIds = new Set();
  const pairs = [];
  let oppositeDirectionCandidates = 0;

  for (const candidate of candidates) {
    const epoch = Number(candidate.entryCandleEpoch);
    const sameMarketWindow = baseline.filter(base =>
      base.marketId === candidate.marketId &&
      Math.abs(Number(base.entryCandleEpoch) - epoch) <= MATCH_WINDOW_SECONDS
    );
    const available = sameMarketWindow.filter(base =>
      base.direction === candidate.direction && !usedBaselineIds.has(base.signalId)
    );
    available.sort((a, b) =>
      Math.abs(Number(a.entryCandleEpoch) - epoch) - Math.abs(Number(b.entryCandleEpoch) - epoch)
    );
    if (!available.length) {
      if (sameMarketWindow.some(base => base.direction !== candidate.direction)) {
        oppositeDirectionCandidates++;
      }
      continue;
    }
    const base = available[0];
    usedBaselineIds.add(base.signalId);
    pairs.push({
      marketId: candidate.marketId,
      direction: candidate.direction,
      candidateSignalId: candidate.signalId,
      baselineSignalId: base.signalId,
      candidateEntryEpoch: epoch,
      baselineEntryEpoch: Number(base.entryCandleEpoch),
      entryTimeDifferenceSeconds: Number(Math.abs(Number(base.entryCandleEpoch) - epoch)),
      candidateStatus: statusOf(candidate),
      baselineStatus: statusOf(base),
      candidateRealizedR: Number.isFinite(Number(candidate.realizedR)) ? Number(candidate.realizedR) : null,
      baselineRealizedR: Number.isFinite(Number(base.realizedR)) ? Number(base.realizedR) : null
    });
  }

  const pairedOutcomes = {};
  for (const pair of pairs) {
    const key = pair.candidateStatus + " / " + pair.baselineStatus;
    pairedOutcomes[key] = (pairedOutcomes[key] || 0) + 1;
  }
  const byMarket = {};
  for (const row of candidates) {
    const market = byMarket[row.marketId] ||= { candidates: 0, matched: 0, unmatched: 0 };
    market.candidates++;
  }
  for (const pair of pairs) byMarket[pair.marketId].matched++;
  for (const market of Object.values(byMarket)) market.unmatched = market.candidates - market.matched;

  return {
    strategyId,
    label,
    candidateSignals: candidates.length,
    candidateOutcomeCounts: countStatuses(candidates),
    matchedPairs: pairs.length,
    unmatchedCandidates: candidates.length - pairs.length,
    candidatesWithOppositeDirectionBaselineNearby: oppositeDirectionCandidates,
    baselineSignalsUsed: usedBaselineIds.size,
    pairedOutcomeCounts: Object.entries(pairedOutcomes)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    byMarket,
    pairs
  };
}

function buildMatchedComparisonReport({
  baselineJournal,
  strategyJournal,
  breakoutRetestJournal,
  m5PullbackJournal,
  breakoutRetestM5M15Journal,
  generatedAt = new Date().toISOString()
} = {}) {
  const baseline = baselineRows(baselineJournal);
  const experiments = [
    ...["EMA20_50", "EMA9_21", "EMA9_21_BODY_CLOSE", "EMA20_50_PULLBACK"].map(id => ({
      id,
      label: id,
      journal: strategyJournal
    })),
    { id: "M5_BREAKOUT_M1_RETEST", label: "M5 breakout / M1 retest", journal: breakoutRetestJournal },
    { id: "M15_M5_EMA_PULLBACK", label: "M15 trend / M5 EMA pullback", journal: m5PullbackJournal },
    { id: "M5_BREAKOUT_M5_RETEST_M15_CONFIRM", label: "M5 breakout / M5 retest / M15 confirmation", journal: breakoutRetestM5M15Journal }
  ];

  const strategies = experiments.map(item =>
    buildStrategyComparison(item.id, item.label, item.journal, baseline)
  );

  const summary = {
    baselineVersion: BASELINE_VERSION,
    baselineCategory: BASELINE_CATEGORY,
    baselineSignalsAvailable: baseline.length,
    candidateStrategies: strategies.length,
    candidateSignals: strategies.reduce((sum, row) => sum + row.candidateSignals, 0),
    matchedPairs: strategies.reduce((sum, row) => sum + row.matchedPairs, 0),
    unmatchedCandidates: strategies.reduce((sum, row) => sum + row.unmatchedCandidates, 0),
    matchWindowSeconds: MATCH_WINDOW_SECONDS
  };

  return {
    version: 1,
    generatedAt,
    mode: "read_only_forward_shadow_contemporaneous_match",
    methodology: {
      candidatePopulation: "Forward-shadow candidate records only; historical backfill is excluded.",
      baselinePopulation: "MTF_BASELINE_V1 SCALP records using M5 entry timeframe.",
      pairing: "One-to-one within each experiment family, same market and direction, nearest entry candle within 15 minutes.",
      reuse: "A baseline signal may be independently paired once in each separate experiment family.",
      limitations: [
        "This is a contemporaneous signal co-occurrence comparison, not a counterfactual replay.",
        "A missing baseline match means no qualifying baseline signal was recorded in the matching window; it is not a baseline loss.",
        "Candidate and baseline entries, stop distances, targets, management rules, and outcome horizons may differ.",
        "Candle-based outcomes do not prove fills, spread-adjusted returns, or realized account profit.",
        "Do not rank or promote strategies from this report alone. A matched replay with identical entry and exit assumptions is required before performance claims."
      ]
    },
    summary,
    strategies
  };
}

module.exports = {
  BASELINE_VERSION,
  BASELINE_CATEGORY,
  MATCH_WINDOW_SECONDS,
  candidateRows,
  baselineRows,
  buildStrategyComparison,
  buildMatchedComparisonReport
};
