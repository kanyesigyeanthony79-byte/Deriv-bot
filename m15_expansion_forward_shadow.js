"use strict";

// Forward-only M15 validation for RB100 and RB200.
// Reuses the production M15 evaluator but writes only to its own research journal.
// No production signal journal, production scanner routing, MT5, or order execution.
const { evaluate, DEF } = require("./engine");

const TIMEFRAME_SECONDS = 900;
const STOP_ATR = 1.5;
const TP1_R = 2;
const TP2_R = 3;
const HORIZON_CANDLES = 96;
const MARKET_IDS = Object.freeze(["RB100", "RB200"]);

function validCandle(c) {
  return c && [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
}
function summarize(trades) {
  const resolved = trades.filter(t => ["TP2", "SL", "SL_AFTER_TP1"].includes(t.status));
  const wins = resolved.filter(t => t.status === "TP2").length;
  const losses = resolved.length - wins;
  const r = resolved.reduce((sum, t) => sum + Number(t.r || 0), 0);
  const count = status => trades.filter(t => t.status === status).length;
  return {
    generated: trades.length,
    resolved: resolved.length,
    wins,
    losses,
    winRatePct: resolved.length ? Number((wins / resolved.length * 100).toFixed(2)) : null,
    expectancyR: resolved.length ? Number((r / resolved.length).toFixed(4)) : null,
    crudeR: Number(r.toFixed(3)),
    pending: count("PENDING"),
    awaitingEntry: count("AWAITING_ENTRY"),
    unresolved: count("UNRESOLVED"),
    ambiguous: count("AMBIGUOUS"),
    censored: count("CENSORED")
  };
}
function updateMarket(journal, marketId, market, nowEpoch) {
  const candles = Array.isArray(market?.timeframes?.M15) ? market.timeframes.M15.filter(validCandle).sort((a,b) => a.epoch-b.epoch) : [];
  const state = journal.markets[marketId] ||= {
    marketId, marketName: market?.marketName || marketId, lastProcessedEpoch: null,
    lastSignalEpoch: null, evaluatedCandles: 0, noSignalCandles: 0,
    cooldownSuppressed: 0, gapCount: 0, largestGapCandles: 0,
    coverage: null, dataQuality: "warming"
  };
  if (candles.length < 65) {
    state.dataQuality = "insufficient_completed_m15_history";
    state.updatedAt = new Date(nowEpoch * 1000).toISOString();
    return;
  }
  const first = candles[0], last = candles[candles.length - 1];
  let gaps = 0, largestGap = 0;
  for (let i=1;i<candles.length;i++) {
    const missing = Math.max(0, Math.round((candles[i].epoch-candles[i-1].epoch)/TIMEFRAME_SECONDS)-1);
    if (missing) gaps++;
    largestGap = Math.max(largestGap, missing);
  }
  state.coverage = {
    candles: candles.length, firstEpoch: first.epoch, lastEpoch: last.epoch,
    missingIntervals: candles.length ? Math.max(0, Math.round((last.epoch-first.epoch)/TIMEFRAME_SECONDS)+1-candles.length) : null,
    gapCount: gaps, largestGapCandles: largestGap
  };
  state.dataQuality = gaps ? "gaps_detected" : "continuous_latest_window";

  // First observation establishes the forward cursor. Never backfill old setups.
  if (!Number.isFinite(state.lastProcessedEpoch)) {
    state.lastProcessedEpoch = last.epoch;
    state.startedAt = new Date(nowEpoch * 1000).toISOString();
    state.updatedAt = new Date(nowEpoch * 1000).toISOString();
    return;
  }

  const firstNewIndex = candles.findIndex(c => c.epoch > state.lastProcessedEpoch);
  if (firstNewIndex < 0) {
    state.updatedAt = new Date(nowEpoch * 1000).toISOString();
    return;
  }
  const expectedNext = state.lastProcessedEpoch + TIMEFRAME_SECONDS;
  if (candles[firstNewIndex].epoch !== expectedNext || firstNewIndex < 64) {
    const missing = Math.max(1, Math.round((candles[firstNewIndex].epoch-state.lastProcessedEpoch)/TIMEFRAME_SECONDS)-1);
    state.gapCount += 1;
    state.largestGapCandles = Math.max(state.largestGapCandles, missing);
    state.lastGap = {
      afterEpoch: state.lastProcessedEpoch, resumedAtEpoch: candles[firstNewIndex].epoch,
      missingCandles: missing, detectedAt: new Date(nowEpoch * 1000).toISOString()
    };
    // Skip the unobserved interval rather than manufacture historical forward signals.
    state.lastProcessedEpoch = last.epoch;
    state.updatedAt = new Date(nowEpoch * 1000).toISOString();
    return;
  }

  const byId = new Map(journal.signals.filter(s => s.marketId === marketId).map(s => [s.signalId, s]));
  for (let i=firstNewIndex;i<candles.length;i++) {
    const candle = candles[i];
    if (candle.epoch !== state.lastProcessedEpoch + TIMEFRAME_SECONDS) {
      const missing = Math.max(1, Math.round((candle.epoch-state.lastProcessedEpoch)/TIMEFRAME_SECONDS)-1);
      state.gapCount += 1;
      state.largestGapCandles = Math.max(state.largestGapCandles, missing);
      state.lastGap = {
        afterEpoch: state.lastProcessedEpoch, resumedAtEpoch: candle.epoch,
        missingCandles: missing, detectedAt: new Date(nowEpoch * 1000).toISOString()
      };
      state.lastProcessedEpoch = candle.epoch;
      continue;
    }
    state.lastProcessedEpoch = candle.epoch;
    const history = candles.slice(0, i+1);
    const result = evaluate(history);
    state.evaluatedCandles += 1;
    if (result.state !== "ok" || !["BUY","SELL"].includes(result.signal)) {
      state.noSignalCandles += 1;
      continue;
    }
    if (Number.isFinite(state.lastSignalEpoch) &&
        candle.epoch-state.lastSignalEpoch < DEF.cooldown*TIMEFRAME_SECONDS) {
      state.cooldownSuppressed += 1;
      continue;
    }
    const atr = Number(result.metrics?.atr);
    if (!(atr > 0)) continue;
    const signalId = "M15EXP-" + marketId + "-" + candle.epoch;
    if (byId.has(signalId)) continue;
    const signal = {
      signalId, strategyId: "M15_EXPANSION_FORWARD_V1", marketId,
      market: market?.marketName || marketId, direction: result.signal, score: result.score,
      signalEpoch: candle.epoch, setupCloseEpoch: candle.epoch+TIMEFRAME_SECONDS,
      setupAtr: atr, status: "AWAITING_ENTRY",
      entry: null, entryEpoch: null, stopLoss: null, tp1: null, tp2: null,
      tp1ReachedAt: null, outcomeEpoch: null, r: null, barsObserved: 0,
      horizonCandles: HORIZON_CANDLES,
      checks: result.checks || [], metrics: result.metrics || {},
      createdAt: new Date((candle.epoch+TIMEFRAME_SECONDS)*1000).toISOString()
    };
    journal.signals.push(signal);
    byId.set(signalId, signal);
    state.lastSignalEpoch = candle.epoch;
  }

  // Resolve entries and outcomes only from completed candles in the forward window.
  for (const signal of journal.signals) {
    if (signal.marketId !== marketId || ["TP2","SL","SL_AFTER_TP1","AMBIGUOUS","UNRESOLVED","CENSORED"].includes(signal.status)) continue;
    if (signal.status === "AWAITING_ENTRY") {
      const entryIndex = candles.findIndex(c => c.epoch === signal.setupCloseEpoch);
      const forming = validCandle(market?.formingM15) && market.formingM15.epoch === signal.setupCloseEpoch
        ? market.formingM15 : null;
      if (entryIndex < 0 && !forming) {
        if (last.epoch >= signal.setupCloseEpoch) {
          signal.status = "CENSORED";
          signal.reason = "next_m15_entry_candle_missing";
        }
        continue;
      }
      const entryCandle = forming || candles[entryIndex];
      const risk = signal.setupAtr * STOP_ATR;
      signal.entry = entryCandle.open;
      signal.entryEpoch = entryCandle.epoch;
      signal.stopLoss = signal.direction === "BUY" ? signal.entry-risk : signal.entry+risk;
      signal.tp1 = signal.direction === "BUY" ? signal.entry+risk*TP1_R : signal.entry-risk*TP1_R;
      signal.tp2 = signal.direction === "BUY" ? signal.entry+risk*TP2_R : signal.entry-risk*TP2_R;
      signal.status = "PENDING";
    }
    if (signal.status !== "PENDING") continue;
    const entryIndex = candles.findIndex(c => c.epoch === signal.entryEpoch);
    if (entryIndex < 0) {
      if (validCandle(market?.formingM15) && market.formingM15.epoch === signal.entryEpoch) continue;
      if (last.epoch < signal.entryEpoch) continue;
      signal.status = "CENSORED";
      signal.reason = "entry_candle_outside_latest_continuous_window";
      continue;
    }
    for (let i=entryIndex;i<candles.length && signal.barsObserved<HORIZON_CANDLES;i++) {
      const c = candles[i];
      if (signal.outcomeEpoch && c.epoch <= signal.outcomeEpoch) continue;
      if (signal.barsObserved && c.epoch !== signal.outcomeEpoch+TIMEFRAME_SECONDS) {
        signal.status = "CENSORED";
        signal.reason = "gap_during_outcome_observation";
        break;
      }
      const buy = signal.direction === "BUY";
      const sl = buy ? c.low <= signal.stopLoss : c.high >= signal.stopLoss;
      const tp1 = buy ? c.high >= signal.tp1 : c.low <= signal.tp1;
      const tp2 = buy ? c.high >= signal.tp2 : c.low <= signal.tp2;
      signal.barsObserved += 1;
      signal.outcomeEpoch = c.epoch;
      if (sl && (tp1 || tp2)) {
        signal.status = "AMBIGUOUS";
        signal.reason = "stop_and_target_touched_same_candle";
        break;
      }
      if (sl) {
        signal.status = signal.tp1ReachedAt ? "SL_AFTER_TP1" : "SL";
        signal.r = -1;
        break;
      }
      if (tp2) {
        signal.status = "TP2";
        signal.r = TP2_R;
        break;
      }
      if (tp1 && !signal.tp1ReachedAt) signal.tp1ReachedAt = c.epoch;
    }
    if (signal.status === "PENDING" && signal.barsObserved >= HORIZON_CANDLES) {
      signal.status = "UNRESOLVED";
      signal.reason = "96_completed_m15_candles_without_sl_or_tp2";
    }
  }
  state.updatedAt = new Date(nowEpoch * 1000).toISOString();
}
function updateM15ExpansionForwardShadowJournal(prior, markets, nowEpoch=Math.floor(Date.now()/1000)) {
  const journal = prior && prior.version === 1 && Array.isArray(prior.signals) && prior.markets
    ? prior
    : { version:1, mode:"forward_shadow_observation_only", createdAt:new Date(nowEpoch*1000).toISOString(), updatedAt:null, markets:{}, signals:[] };
  for (const marketId of MARKET_IDS) updateMarket(journal, marketId, markets?.[marketId], nowEpoch);
  journal.updatedAt = new Date(nowEpoch*1000).toISOString();
  journal.summary = {
    mode:"forward_shadow_observation_only",
    generatedAt:journal.updatedAt,
    markets:Object.fromEntries(MARKET_IDS.map(id => [id, {
      ...summarize(journal.signals.filter(s => s.marketId === id)),
      dataQuality:journal.markets[id]?.dataQuality || "warming",
      evaluatedCandles:journal.markets[id]?.evaluatedCandles || 0,
      cooldownSuppressed:journal.markets[id]?.cooldownSuppressed || 0,
      gapCount:journal.markets[id]?.gapCount || 0,
      coverage:journal.markets[id]?.coverage || null
    }])),
    signals:journal.signals.length,
    productionSignalsChanged:false,
    telegramSource:"RESEARCH_SHADOW",
    mt5ExecutionEnabled:false
  };
  return journal;
}
function buildExpansionAlert(signal, nowEpoch=Math.floor(Date.now()/1000)) {
  if (!signal || signal.status === "AWAITING_ENTRY" || signal.status === "CENSORED" || !Number.isFinite(signal.entryEpoch)) return null;
  const signalAgeSeconds = Math.max(0, nowEpoch-Number(signal.setupCloseEpoch || signal.entryEpoch));
  if (signalAgeSeconds > 900) return null;
  return {
    event:"new_signal", source:"RESEARCH_SHADOW", paper:true, live:false,
    signalId:signal.signalId, strategyId:signal.strategyId,
    strategyProfile:"SHADOW / RESEARCH — NOT LIVE · M15_EXPANSION_FORWARD_V1",
    marketId:signal.marketId, market:signal.market, direction:signal.direction,
    entry:signal.entry, stopLoss:signal.stopLoss, tp1:signal.tp1, tp2:signal.tp2,
    setupTimeframe:"M15", entryTimeframe:"M15", confirmationTimeframe:"M15",
    signalAgeSeconds, quality:"RESEARCH", status:"SHADOW"
  };
}
module.exports = {
  MARKET_IDS, TIMEFRAME_SECONDS, STOP_ATR, TP1_R, TP2_R, HORIZON_CANDLES,
  summarize, updateM15ExpansionForwardShadowJournal, buildExpansionAlert
};
