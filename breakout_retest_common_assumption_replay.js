"use strict";

// Candidate-specific common-assumption replay for EXP-01 against the production
// MTF SCALP signal engine. Research only: no alerts, Telegram routing or orders.
const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("./scanner_data_dir");
const { evaluateCategory } = require("./multi_timeframe_engine");
const { detectBreakout, findRetestConfirmation, atrSeries } = require("./breakout_retest_shadow");

const DATA_DIR = getDataDir();
const INPUT = path.join(DATA_DIR, "lower_tf_research_candles.json");
const OUTPUT = path.join(DATA_DIR, "breakout_retest_common_assumption_replay_report.json");
const TF = Object.freeze({ M1: 60, M5: 300, M15: 900 });
const MINIMUM = Object.freeze({ M1: 1440, M5: 500, M15: 400 });
const MIN_OVERLAP_HOURS = 24;
const MIN_READY_MARKETS = 3;
const STOP_LOOKBACK_M1 = 5;
const STOP_BUFFER_ATR_M1 = 0.10;
const MIN_STOP_ATR_M1 = 0.50;
const MAX_STOP_ATR_M1 = 3.00;
const TARGET_R = 2;
const HORIZON_M1 = 60;
const COOLDOWN_M1 = 4;
const COST_SENSITIVITY_R = 0.10;
const SPLIT_EMBARGO_SECONDS = 3600;
const METHODS = Object.freeze(["PRODUCTION_MTF_SCALP", "M5_BREAKOUT_M1_RETEST"]);
const MARKET_IDS = Object.freeze(["R_10", "R_25", "R_50", "R_75", "JD75", "JD100", "CRASH500", "BOOM500"]);

function validCandle(c) {
  return c && [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close);
}
function latestContinuousSegment(rows, seconds) {
  const data = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => a.epoch - b.epoch);
  if (!data.length) return [];
  let start = data.length - 1;
  while (start > 0 && data[start].epoch - data[start - 1].epoch === seconds) start--;
  return data.slice(start);
}
function frameQuality(raw, tf) {
  const seconds = TF[tf];
  const rows = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  let duplicates = 0, invalid = 0, unaligned = 0;
  for (const c of rows) {
    const epoch = Number(c?.epoch);
    if (seen.has(epoch)) duplicates++;
    seen.add(epoch);
    if (!validCandle(c)) invalid++;
    if (Number.isFinite(epoch) && epoch % seconds !== 0) unaligned++;
  }
  const valid = rows.filter(validCandle).filter(c => c.epoch % seconds === 0)
    .sort((a, b) => a.epoch - b.epoch)
    .filter((c, i, all) => i === 0 || c.epoch !== all[i - 1].epoch);
  const segment = latestContinuousSegment(valid, seconds);
  return {
    candles: rows.length,
    latestContinuousCandles: segment.length,
    firstEpoch: segment[0]?.epoch ?? null,
    endEpoch: segment.length ? segment[segment.length - 1].epoch + seconds : null,
    duplicates, invalid, unaligned,
    clean: duplicates === 0 && invalid === 0 && unaligned === 0,
    segment
  };
}
function assessMarket(marketId, market) {
  const frames = {};
  for (const tf of Object.keys(TF)) frames[tf] = frameQuality(market?.timeframes?.[tf], tf);
  const starts = Object.values(frames).map(f => f.firstEpoch).filter(Number.isFinite);
  const ends = Object.values(frames).map(f => f.endEpoch).filter(Number.isFinite);
  const overlapStart = starts.length === 3 ? Math.max(...starts) : null;
  const overlapEnd = ends.length === 3 ? Math.min(...ends) : null;
  const overlapHours = Number.isFinite(overlapStart) && Number.isFinite(overlapEnd)
    ? Math.max(0, (overlapEnd - overlapStart) / 3600) : 0;
  const checks = {
    M1: frames.M1.latestContinuousCandles >= MINIMUM.M1,
    M5: frames.M5.latestContinuousCandles >= MINIMUM.M5,
    M15: frames.M15.latestContinuousCandles >= MINIMUM.M15,
    overlap: overlapHours >= MIN_OVERLAP_HOURS,
    quality: Object.values(frames).every(f => f.clean)
  };
  return {
    marketId, status: Object.values(checks).every(Boolean) ? "ready" : "not_ready",
    checks, overlapHours,
    frames: Object.fromEntries(Object.entries(frames).map(([tf, f]) => [tf, {
      candles: f.candles, latestContinuousCandles: f.latestContinuousCandles,
      duplicates: f.duplicates, invalid: f.invalid, unaligned: f.unaligned
    }])),
    segments: Object.fromEntries(Object.entries(frames).map(([tf, f]) => [tf, f.segment]))
  };
}
function splitBounds(startEpoch, endEpoch) {
  const span = endEpoch - startEpoch;
  const first = startEpoch + span * 0.60;
  const second = startEpoch + span * 0.80;
  return {
    discovery: { start: startEpoch, end: first - SPLIT_EMBARGO_SECONDS },
    validation: { start: first + SPLIT_EMBARGO_SECONDS, end: second - SPLIT_EMBARGO_SECONDS },
    holdout: { start: second + SPLIT_EMBARGO_SECONDS, end: endEpoch }
  };
}
function commonEntry({ m1, triggerIndex, entryIndex, direction }) {
  if (!Number.isInteger(triggerIndex) || !Number.isInteger(entryIndex) ||
      triggerIndex < STOP_LOOKBACK_M1 - 1 || entryIndex !== triggerIndex + 1 ||
      !m1[triggerIndex] || !m1[entryIndex]) return { status: "invalid_entry" };
  const volatility = Number(m1._atr1?.[triggerIndex]);
  if (!(volatility > 0)) return { status: "invalid_risk" };
  const recent = m1.slice(triggerIndex - STOP_LOOKBACK_M1 + 1, triggerIndex + 1);
  if (recent.length !== STOP_LOOKBACK_M1) return { status: "invalid_risk" };
  const stop = direction === "BUY"
    ? Math.min(...recent.map(c => c.low)) - STOP_BUFFER_ATR_M1 * volatility
    : Math.max(...recent.map(c => c.high)) + STOP_BUFFER_ATR_M1 * volatility;
  const entry = m1[entryIndex].open;
  const riskDistance = direction === "BUY" ? entry - stop : stop - entry;
  const riskAtr = riskDistance / volatility;
  if (!(riskDistance > 0) || riskAtr < MIN_STOP_ATR_M1 || riskAtr > MAX_STOP_ATR_M1) {
    return { status: "risk_rejected", riskAtr: Number.isFinite(riskAtr) ? riskAtr : null };
  }
  return {
    status: "entry",
    direction, triggerEpoch: m1[triggerIndex].epoch,
    entryEpoch: m1[entryIndex].epoch, entry, stop,
    riskDistance, riskAtr, target: entry + (direction === "BUY" ? 1 : -1) * TARGET_R * riskDistance
  };
}
function resolveOutcome(m1, trade) {
  const start = m1.findIndex(c => c.epoch === trade.entryEpoch);
  if (start < 0) return { status: "incomplete_data", realizedR: null };
  if (start + HORIZON_M1 > m1.length) return { status: "incomplete_data", realizedR: null };
  for (let offset = 0; offset < HORIZON_M1; offset++) {
    const c = m1[start + offset];
    if (offset > 0 && c.epoch - m1[start + offset - 1].epoch !== TF.M1) {
      return { status: "data_gap", realizedR: null };
    }
    const stopTouched = trade.direction === "BUY" ? c.low <= trade.stop : c.high >= trade.stop;
    const targetTouched = trade.direction === "BUY" ? c.high >= trade.target : c.low <= trade.target;
    if (stopTouched && targetTouched) return { status: "ambiguous", realizedR: null, exitEpoch: c.epoch };
    if (stopTouched) return { status: "stopped", realizedR: -1, exitEpoch: c.epoch };
    if (targetTouched) return { status: "target", realizedR: TARGET_R, exitEpoch: c.epoch };
  }
  const last = m1[start + HORIZON_M1 - 1];
  const signedMove = trade.direction === "BUY" ? last.close - trade.entry : trade.entry - last.close;
  return {
    status: "time_exit", realizedR: Number((signedMove / trade.riskDistance).toFixed(4)),
    exitEpoch: last.epoch + TF.M1
  };
}
function makeSetups(marketId, market, segments) {
  const m1 = segments.M1.slice();
  m1._atr1 = atrSeries(m1, 14);
  const m5 = segments.M5, m15 = segments.M15;
  const atr5 = atrSeries(m5, 14);
  const baseline = [];
  const candidate = [];
  const baselineNoEntry = [];
  const candidateNoEntry = [];

  for (let i = 64; i < m5.length; i++) {
    const result = evaluateCategory(marketId, market.marketName || marketId, "SCALP", {
      M1: m1, M5: m5, M15: m15
    }, i);
    if (result.state === "signal") {
      const setupEpoch = m5[i].epoch + TF.M5;
      const entryIndex = m1.findIndex(c => c.epoch === setupEpoch);
      if (entryIndex > 0) {
        const trade = commonEntry({ m1, triggerIndex: entryIndex - 1, entryIndex, direction: result.direction });
        if (trade.status === "entry") baseline.push({ ...trade, setupEpoch, method: METHODS[0] });
        else baselineNoEntry.push({ setupEpoch, reason: trade.status });
      } else baselineNoEntry.push({ setupEpoch, reason: "missing_next_m1_open" });
    }

    const breakout = detectBreakout(m5, i, atr5[i]);
    if (!breakout) continue;
    const setupEpoch = m5[i].epoch + TF.M5;
    const setup = { ...breakout, setupCloseEpoch: setupEpoch };
    const startIndex = m1.findIndex(c => c.epoch === setupEpoch);
    if (startIndex < 0) {
      candidateNoEntry.push({ setupEpoch, reason: "missing_m1_start" });
      continue;
    }
    const confirmation = findRetestConfirmation(m1, startIndex, setup, m1._atr1);
    if (!confirmation) {
      candidateNoEntry.push({ setupEpoch, reason: "retest_not_confirmed" });
      continue;
    }
    const trade = commonEntry({
      m1, triggerIndex: confirmation.triggerIndex,
      entryIndex: confirmation.entryIndex,
      direction: breakout.direction === 1 ? "BUY" : "SELL"
    });
    if (trade.status === "entry") candidate.push({ ...trade, setupEpoch, method: METHODS[1] });
    else candidateNoEntry.push({ setupEpoch, reason: trade.status });
  }
  return {
    [METHODS[0]]: { setups: baseline.length + baselineNoEntry.length, entries: baseline, noEntry: baselineNoEntry },
    [METHODS[1]]: { setups: candidate.length + candidateNoEntry.length, entries: candidate, noEntry: candidateNoEntry }
  };
}
function blankStats(setups = 0, noEntry = 0) {
  return {
    setups, eligibleEntries: 0, overlapSkipped: 0, noEntry,
    riskRejected: 0, entries: 0, target: 0, stopped: 0,
    timeExit: 0, ambiguous: 0, incompleteData: 0, dataGap: 0,
    resolved: 0, decisive: 0, totalGrossR: 0, averageGrossR: null,
    averageCostSensitivityRAt010: null, maxDrawdownR: 0
  };
}
function simulateSplit(setupPack, m1, bounds) {
  const selectedNoEntry = setupPack.noEntry.filter(s => s.setupEpoch >= bounds.start && s.setupEpoch < bounds.end);
  const selectedEntries = setupPack.entries
    .filter(t => t.setupEpoch >= bounds.start && t.setupEpoch < bounds.end)
    .sort((a, b) => a.entryEpoch - b.entryEpoch);
  const stats = blankStats(
    selectedNoEntry.length + selectedEntries.length,
    selectedNoEntry.length
  );
  stats.riskRejected = selectedNoEntry.filter(s => s.reason === "risk_rejected").length;
  stats.noEntry = selectedNoEntry.length;
  const realized = [];
  let blockedUntil = null;
  for (const trade of selectedEntries) {
    if (trade.entryEpoch + HORIZON_M1 * TF.M1 > bounds.end) {
      stats.incompleteData++;
      continue;
    }
    if (Number.isFinite(blockedUntil) && trade.entryEpoch < blockedUntil) {
      stats.overlapSkipped++;
      continue;
    }
    stats.eligibleEntries++;
    const outcome = resolveOutcome(m1, trade);
    if (outcome.status === "incomplete_data" || outcome.status === "data_gap") {
      if (outcome.status === "incomplete_data") stats.incompleteData++;
      else stats.dataGap++;
      blockedUntil = trade.entryEpoch + HORIZON_M1 * TF.M1 + COOLDOWN_M1 * TF.M1;
      continue;
    }
    stats.entries++;
    if (outcome.status === "target") stats.target++;
    else if (outcome.status === "stopped") stats.stopped++;
    else if (outcome.status === "time_exit") stats.timeExit++;
    else if (outcome.status === "ambiguous") stats.ambiguous++;
    if (Number.isFinite(outcome.realizedR)) {
      stats.resolved++;
      if (outcome.status === "target" || outcome.status === "stopped") stats.decisive++;
      realized.push(outcome.realizedR);
    }
    const endEpoch = Number(outcome.exitEpoch) || (trade.entryEpoch + HORIZON_M1 * TF.M1);
    blockedUntil = endEpoch + COOLDOWN_M1 * TF.M1;
  }
  stats.totalGrossR = Number(realized.reduce((sum, r) => sum + r, 0).toFixed(4));
  stats.averageGrossR = realized.length
    ? Number((realized.reduce((sum, r) => sum + r, 0) / realized.length).toFixed(4)) : null;
  stats.averageCostSensitivityRAt010 = realized.length
    ? Number((realized.reduce((sum, r) => sum + r - COST_SENSITIVITY_R, 0) / realized.length).toFixed(4)) : null;
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const r of realized) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  stats.maxDrawdownR = Number(maxDrawdown.toFixed(4));
  return stats;
}
function aggregateStats(rows) {
  const sums = blankStats();
  const realizedTotal = rows.reduce((sum, r) => sum + r.totalGrossR, 0);
  const resolved = rows.reduce((sum, r) => sum + r.resolved, 0);
  for (const key of ["setups","eligibleEntries","overlapSkipped","noEntry","riskRejected","entries","target","stopped","timeExit","ambiguous","incompleteData","dataGap","resolved","decisive"]) {
    sums[key] = rows.reduce((sum, r) => sum + r[key], 0);
  }
  sums.totalGrossR = Number(realizedTotal.toFixed(4));
  sums.averageGrossR = resolved ? Number((realizedTotal / resolved).toFixed(4)) : null;
  sums.averageCostSensitivityRAt010 = resolved
    ? Number(((realizedTotal / resolved) - COST_SENSITIVITY_R).toFixed(4)) : null;
  sums.maxDrawdownR = null; // Cross-market trade ordering is not a single portfolio sequence.
  return sums;
}
function replayMarket(marketId, assessed) {
  const segments = assessed.segments;
  const overlapStart = Math.max(...Object.keys(TF).map(tf => segments[tf][0]?.epoch ?? Infinity));
  const overlapEnd = Math.min(...Object.keys(TF).map(tf => (segments[tf].at(-1)?.epoch ?? -Infinity) + TF[tf]));
  const rows = Object.fromEntries(Object.keys(TF).map(tf => [tf,
    segments[tf].filter(c => c.epoch >= overlapStart && c.epoch + TF[tf] <= overlapEnd)
  ]));
  const bounds = splitBounds(overlapStart, overlapEnd);
  const setups = makeSetups(marketId, { marketName: marketId }, rows);
  const splits = {};
  for (const splitName of Object.keys(bounds)) {
    splits[splitName] = {};
    for (const method of METHODS) {
      splits[splitName][method] = simulateSplit(setups[method], rows.M1, bounds[splitName]);
    }
  }
  return {
    status: "replayed",
    overlapHours: Number(((overlapEnd - overlapStart) / 3600).toFixed(2)),
    splitBounds: bounds,
    splits
  };
}
function buildReport(archive, generatedAt = new Date().toISOString()) {
  const assessments = {};
  for (const id of MARKET_IDS) assessments[id] = assessMarket(id, archive?.markets?.[id]);
  const readyIds = Object.entries(assessments).filter(([, a]) => a.status === "ready").map(([id]) => id);
  const ready = readyIds.length >= MIN_READY_MARKETS;
  const markets = {};
  if (ready) {
    for (const id of readyIds) markets[id] = replayMarket(id, assessments[id]);
  } else {
    for (const id of MARKET_IDS) markets[id] = {
      status: assessments[id].status,
      checks: assessments[id].checks,
      overlapHours: assessments[id].overlapHours,
      frames: assessments[id].frames
    };
  }
  const overall = {};
  if (ready) {
    for (const split of ["discovery", "validation", "holdout"]) {
      overall[split] = {};
      for (const method of METHODS) {
        overall[split][method] = aggregateStats(readyIds.map(id => markets[id].splits[split][method]));
      }
    }
  }
  return {
    version: 1, generatedAt,
    mode: ready ? "common_assumption_replay_complete" : "waiting_for_research_data_quality",
    readiness: {
      readyMarkets: readyIds, readyMarketCount: readyIds.length,
      requiredMarkets: MIN_READY_MARKETS, minimum: MINIMUM,
      minimumOverlapHours: MIN_OVERLAP_HOURS,
      assessments: Object.fromEntries(Object.entries(assessments).map(([id, a]) => [id, {
        status: a.status, checks: a.checks, overlapHours: Number(a.overlapHours.toFixed(2)), frames: a.frames
      }]))
    },
    assumptions: {
      baseline: "Production MTF engine SCALP category evaluated on each completed M5 candle, using completed M15 confirmation/context; entry at the next M1 open.",
      candidate: "Frozen EXP-01 M5 12-bar breakout, then M1 retest/confirmation within 10 M1 candles; entry at the next M1 open.",
      commonStop: "Both methods use the last 5 completed M1 candles before entry, buffered by 0.10 M1 ATR; risk must be 0.50–3.00 M1 ATR.",
      commonTarget: "Fixed 2R target for both methods.",
      commonHorizon: "Resolve on M1 candles for up to 60 bars (60 minutes); same-candle stop and target touches are ambiguous.",
      concurrency: "Each method is simulated independently with one open position at a time and a shared 4-M1-bar post-exit cooldown.",
      splits: "Chronological 60% discovery, 20% validation, 20% holdout with a 1-hour embargo at each split boundary. Parameters are frozen; holdout is not used for tuning.",
      costs: "No broker-specific spread, commission or slippage data is available. Reported expectancy is gross candle-based R; an illustrative fixed 0.10R-per-resolved-trade sensitivity is also shown, not a measured cost.",
      limits: "No counterfactual fill simulation, no account P/L, no strategy ranking or promotion from this report alone."
    },
    methods: METHODS,
    markets,
    overall: ready ? overall : null,
    interpretation: ready
      ? "Exploratory common-assumption replay. Inspect per-market sample sizes and all outcome categories; small or sparse holdout samples remain insufficient evidence."
      : "No replay results are published until at least three markets pass all history, overlap and candle-quality requirements."
  };
}
function run({ input = INPUT, output = OUTPUT, generatedAt } = {}) {
  const archive = JSON.parse(fs.readFileSync(input, "utf8"));
  const report = buildReport(archive, generatedAt || new Date().toISOString());
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    event: "breakout_retest_common_assumption_replay_completed",
    mode: report.mode,
    readyMarkets: report.readiness.readyMarketCount,
    requiredMarkets: report.readiness.requiredMarkets,
    output
  }));
  return report;
}
if (require.main === module) {
  try { run(); } catch (error) {
    console.error(JSON.stringify({ event: "breakout_retest_common_assumption_replay_failed", message: error.message }));
    process.exitCode = 1;
  }
}
module.exports = {
  TF, MINIMUM, MIN_OVERLAP_HOURS, MIN_READY_MARKETS, TARGET_R, HORIZON_M1,
  validCandle, latestContinuousSegment, frameQuality, assessMarket, splitBounds,
  commonEntry, resolveOutcome, makeSetups, simulateSplit, aggregateStats,
  replayMarket, buildReport, run
};
