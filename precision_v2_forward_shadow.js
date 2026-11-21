"use strict";
const { evaluatePrecisionVariants } = require("./precision_v2_shadow");

const VARIANTS = ["baseline", "swingStructureOnly", "trendSlopeOnly"];
const OUTCOMES = new Set(["tp2_hit", "stopped", "stopped_after_tp1", "ambiguous", "expired"]);

function updatePrecisionV2ForwardShadowJournal(prior, baselineJournal, nowEpoch) {
  const state = prior && prior.version === 1 && Array.isArray(prior.observations)
    ? prior : { version: 1, mode: "forward_shadow_only", startedEpoch: nowEpoch, updatedEpoch: null, observations: [] };
  const byId = new Map(state.observations.map(row => [row.signalId, row]));
  for (const signal of baselineJournal?.signals || []) {
    if (!signal || !signal.signalId || !Number.isFinite(Number(signal.createdEpoch)) ||
        Number(signal.createdEpoch) < Number(state.startedEpoch)) continue;
    let row = byId.get(signal.signalId);
    if (!row) {
      const evaluated = evaluatePrecisionVariants({ ...signal, state: "signal" });
      if (!evaluated.eligible) continue;
      row = {
        signalId: signal.signalId, marketId: signal.marketId, category: signal.category,
        direction: signal.direction, createdEpoch: Number(signal.createdEpoch),
        entryCandleEpoch: signal.entryCandleEpoch, entry: signal.entry,
        stopLoss: signal.stopLoss, tp1: signal.tp1, tp2: signal.tp2,
        filterPass: {
          baseline: true,
          swingStructureOnly: Boolean(evaluated.swingStructureOnly),
          trendSlopeOnly: Boolean(evaluated.trendSlopeOnly)
        },
        status: signal.status || "pending", tp1Hit: Boolean(signal.tp1Hit),
        tp1Epoch: signal.tp1Epoch || null, tp2Epoch: signal.tp2Epoch || null,
        stopEpoch: signal.stopEpoch || null, telegramStatus: signal.telegramStatus || "not_reported"
      };
      state.observations.push(row);
      byId.set(row.signalId, row);
    } else {
      row.status = signal.status || row.status;
      row.tp1Hit = Boolean(signal.tp1Hit);
      row.tp1Epoch = signal.tp1Epoch || row.tp1Epoch;
      row.tp2Epoch = signal.tp2Epoch || row.tp2Epoch;
      row.stopEpoch = signal.stopEpoch || row.stopEpoch;
      row.telegramStatus = signal.telegramStatus || row.telegramStatus;
    }
  }
  state.updatedEpoch = nowEpoch;
  state.observations.sort((a, b) => a.createdEpoch - b.createdEpoch);
  const summary = {};
  for (const variant of VARIANTS) {
    const rows = state.observations.filter(row => row.filterPass[variant]);
    const decisive = rows.filter(row => row.status === "tp2_hit" || row.status === "stopped");
    const wins = decisive.filter(row => row.status === "tp2_hit").length;
    summary[variant] = {
      admitted: rows.length,
      resolved: rows.filter(row => OUTCOMES.has(row.status)).length,
      pending: rows.filter(row => !OUTCOMES.has(row.status)).length,
      tp2: wins,
      stopped: decisive.length - wins,
      expired: rows.filter(row => row.status === "expired").length,
      ambiguous: rows.filter(row => row.status === "ambiguous").length,
      decisiveWinRatePct: decisive.length ? Number((wins / decisive.length * 100).toFixed(2)) : null
    };
  }
  state.summary = {
    mode: "forward_shadow_only",
    startedAt: new Date(Number(state.startedEpoch) * 1000).toISOString(),
    updatedAt: new Date(Number(nowEpoch) * 1000).toISOString(),
    totalBaselineSignals: state.observations.length,
    variants: summary,
    warning: "Only signals created after this journal started are included. All variants share the baseline entry, stop, targets, expiry and observed outcome; this is shadow research, not a live filter."
  };
  return state;
}
module.exports = { updatePrecisionV2ForwardShadowJournal };
