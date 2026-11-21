"use strict";

// Forward-only, research-only comparison of two additional weak cohorts.
// The first three previously excluded BUY cohorts are excluded from every arm.
const BASE_EXCLUDED = new Set([
  "JD100|BUY|SCALP",
  "JD100|BUY|SHORT_TERM",
  "R_10|BUY|SHORT_TERM"
]);
const R75_COHORT = "R_75|SHORT_TERM";
const BOOM500_COHORT = "BOOM500|SHORT_TERM";
const TERMINAL = new Set(["tp2_hit", "stopped", "stopped_after_tp1", "expired", "ambiguous"]);

function cohortKey(signal) {
  return [String(signal.marketId || ""), String(signal.direction || ""), String(signal.category || "")].join("|");
}
function candidateKey(signal) {
  return [String(signal.marketId || ""), String(signal.category || "")].join("|");
}
function isBaseExcluded(signal) {
  return BASE_EXCLUDED.has(cohortKey(signal));
}
function admission(signal) {
  const base = !isBaseExcluded(signal);
  const r75 = base && candidateKey(signal) !== R75_COHORT;
  const boom = base && candidateKey(signal) !== BOOM500_COHORT;
  return {
    control: base,
    r75Only: r75,
    boom500Only: boom,
    combined: r75 && boom
  };
}
function outcomeSnapshot(signal) {
  return {
    status: signal.status || "pending",
    telegramStatus: signal.telegramStatus || "not_reported",
    tp1Hit: Boolean(signal.tp1Hit),
    tp1Epoch: signal.tp1Epoch ?? null,
    tp2Epoch: signal.tp2Epoch ?? null,
    stopEpoch: signal.stopEpoch ?? null,
    expiredEpoch: signal.expiredEpoch ?? null,
    lastProcessedEpoch: signal.lastProcessedEpoch ?? null,
    updatedAt: signal.updatedAt || null
  };
}
function summarize(rows, arm) {
  const admitted = rows.filter(row => row.admission[arm]);
  const delivered = admitted.filter(row => row.telegramStatus === "sent");
  const count = list => {
    const wins = list.filter(row => row.status === "tp2_hit").length;
    const losses = list.filter(row => ["stopped", "stopped_after_tp1"].includes(row.status)).length;
    const resolved = wins + losses;
    return {
      generated: list.length,
      delivered: list.filter(row => row.telegramStatus === "sent").length,
      resolved,
      wins,
      losses,
      expired: list.filter(row => row.status === "expired").length,
      pending: list.filter(row => !TERMINAL.has(row.status)).length,
      ambiguous: list.filter(row => row.status === "ambiguous").length,
      decisiveWinRate: resolved ? Number((wins / resolved * 100).toFixed(1)) : null
    };
  };
  return { all: count(admitted), delivered: count(delivered) };
}
function buildSummary(rows, startedEpoch, updatedEpoch) {
  const arms = ["control", "r75Only", "boom500Only", "combined"];
  return {
    mode: "forward_shadow_observation_only",
    shadowOnly: true,
    startedEpoch,
    updatedEpoch,
    observations: rows.length,
    arms: Object.fromEntries(arms.map(arm => [arm, summarize(rows, arm)])),
    warnings: [
      "The first three previously excluded BUY cohorts are excluded from every arm.",
      "R_75 and BOOM500 exclusions are counterfactual only; no signal generation or delivery is changed.",
      "Compare only on new observations collected after startedEpoch; historical retrospective results are not included."
    ]
  };
}
function updateWeakCohortForwardShadowJournal(prior, baselineJournal, nowEpoch) {
  const validPrior = prior && prior.version === 1 && Number.isFinite(Number(prior.startedEpoch)) && Array.isArray(prior.observations);
  const state = validPrior
    ? prior
    : { version: 1, startedEpoch: Number(nowEpoch), updatedEpoch: Number(nowEpoch), observations: [] };
  const byId = new Map(state.observations.map(row => [row.signalId, row]));
  const signals = Array.isArray(baselineJournal?.signals) ? baselineJournal.signals : [];

  for (const signal of signals) {
    const createdEpoch = Number(signal.createdEpoch);
    if (!signal.signalId || !Number.isFinite(createdEpoch) || createdEpoch < state.startedEpoch) continue;
    let row = byId.get(signal.signalId);
    if (!row) {
      row = {
        signalId: signal.signalId,
        marketId: signal.marketId,
        direction: signal.direction,
        category: signal.category,
        createdEpoch,
        entry: signal.entry ?? null,
        stopLoss: signal.stopLoss ?? null,
        tp1: signal.tp1 ?? null,
        tp2: signal.tp2 ?? null,
        admission: admission(signal)
      };
      state.observations.push(row);
      byId.set(row.signalId, row);
    }
    Object.assign(row, outcomeSnapshot(signal));
  }
  state.updatedEpoch = Number(nowEpoch);
  state.observations.sort((a, b) => a.createdEpoch - b.createdEpoch || a.signalId.localeCompare(b.signalId));
  state.summary = buildSummary(state.observations, state.startedEpoch, state.updatedEpoch);
  return state;
}

module.exports = {
  BASE_EXCLUDED, R75_COHORT, BOOM500_COHORT, cohortKey, candidateKey,
  isBaseExcluded, admission, summarize, buildSummary, updateWeakCohortForwardShadowJournal
};
