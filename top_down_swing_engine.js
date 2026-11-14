"use strict";

// Experimental, pure top-down swing evaluator. No networking, alerts, orders or stop mutation.
const TF = Object.freeze({ M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400 });
const VARIANTS = Object.freeze(["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"]);

function validCandles(candles) {
  return Array.isArray(candles) && candles.length >= 2 && candles.every((c, i) =>
    c && Number.isFinite(c.epoch) &&
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) &&
    c.high >= c.low && (i === 0 || c.epoch > candles[i - 1].epoch));
}
function completed(candles, timeframe, decisionEpoch) {
  if (!Array.isArray(candles)) return [];
  return candles.filter(c => c && Number.isFinite(c.epoch) &&
    c.epoch + TF[timeframe] <= decisionEpoch);
}
function validateContinuity(candles, timeframe, marketId) {
  if (!validCandles(candles) || !(TF[timeframe] > 0))
    return { valid: false, gaps: [], reason: "Insufficient or invalid candle history." };
  const gaps = [];
  for (let i=1;i<candles.length;i++) {
    const delta=candles[i].epoch-candles[i-1].epoch;
    if (delta <= TF[timeframe]*1.5) continue;
    const from=new Date(candles[i-1].epoch*1000), to=new Date(candles[i].epoch*1000);
    const goldWeekend=marketId==="frxXAUUSD" &&
      [0,5,6].includes(from.getUTCDay()) && [0,1].includes(to.getUTCDay()) &&
      delta <= 72*3600+TF[timeframe];
    if (!goldWeekend) gaps.push({afterEpoch:candles[i-1].epoch,beforeEpoch:candles[i].epoch,
      missingIntervals:Math.max(1,Math.round(delta/TF[timeframe])-1)});
  }
  return {valid:gaps.length===0,gaps,reason:gaps.length?"Missing candle intervals detected.":"Candle sequence is continuous."};
}
function atr(candles, period = 14) {
  if (!validCandles(candles) || candles.length <= period) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let value = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

// A pivot is exposed only at the close of its right-hand confirmation bars.
function confirmedPivots(candles, timeframe, decisionEpoch, left = 2, right = 2) {
  if (!validCandles(candles)) return { highs: [], lows: [] };
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const confirmEpoch = candles[i + right].epoch + TF[timeframe];
    if (confirmEpoch > decisionEpoch) continue;
    const window = candles.slice(i - left, i + right + 1), c = candles[i];
    if (window.every((x, j) => j === left || c.high > x.high))
      highs.push({ price: c.high, epoch: c.epoch, confirmedEpoch: confirmEpoch });
    if (window.every((x, j) => j === left || c.low < x.low))
      lows.push({ price: c.low, epoch: c.epoch, confirmedEpoch: confirmEpoch });
  }
  return { highs, lows };
}
function structure(candles, timeframe, decisionEpoch) {
  const pivots = confirmedPivots(candles, timeframe, decisionEpoch);
  const highs = pivots.highs.slice(-2), lows = pivots.lows.slice(-2);
  if (highs.length < 2 || lows.length < 2)
    return { state: "warming", direction: "NEUTRAL", pivots };
  const higherHigh = highs[1].price > highs[0].price, higherLow = lows[1].price > lows[0].price;
  const lowerHigh = highs[1].price < highs[0].price, lowerLow = lows[1].price < lows[0].price;
  const direction = higherHigh && higherLow ? "BUY" : lowerHigh && lowerLow ? "SELL" : "NEUTRAL";
  return { state: direction === "NEUTRAL" ? "mixed" : "structured", direction,
    higherHigh, higherLow, lowerHigh, lowerLow, pivots };
}
function result(state, reason, extra = {}) { return { state, reason, ...extra }; }

function evaluateTopDown(marketId, candlesByTimeframe, decisionEpoch, variant = "M15_REFINED", options = {}) {
  if (!VARIANTS.includes(variant)) throw new Error("Unknown entry variant: " + variant);
  if (!Number.isFinite(decisionEpoch)) throw new Error("decisionEpoch must be a finite Unix timestamp");
  const entryTimeframe = variant === "H1_CONTROL" ? "H1" : variant === "M15_REFINED" ? "M15" : "M5";
  const availableEntry = completed(candlesByTimeframe && candlesByTimeframe[entryTimeframe], entryTimeframe, decisionEpoch);
  if (!validCandles(availableEntry) || availableEntry.length < 2)
    return result("warming", "Waiting for completed " + entryTimeframe + " entry candles.", { timeframe: entryTimeframe });

  // Critical anti-look-ahead rule: all frames are re-cut at the candidate entry candle close.
  const entryCandle = availableEntry[availableEntry.length - 1];
  const entryCutoff = entryCandle.epoch + TF[entryTimeframe];
  const frames = {};
  for (const tf of Object.keys(TF)) {
    const raw = candlesByTimeframe && candlesByTimeframe[tf];
    if (Array.isArray(raw) && raw.length >= 2 && !validCandles(raw))
      return result("invalid_data", "Candles must be valid OHLC, oldest first, with unique increasing epochs.", { timeframe: tf });
    frames[tf] = completed(raw, tf, entryCutoff);
    if (frames[tf].length && !validCandles(frames[tf]))
      return result("invalid_data", "Completed candles must be valid OHLC, oldest first, with unique increasing epochs.", { timeframe: tf });
    if (frames[tf].length >= 2) {
      const continuity = validateContinuity(frames[tf], tf, marketId);
      if (!continuity.valid)
        return result("data_gap", continuity.reason, { timeframe: tf, gaps: continuity.gaps.slice(0, 5) });
    }
  }
  for (const tf of ["D1", "H4", "H1"]) {
    if (frames[tf].length < 12)
      return result("warming", "Waiting for sufficient completed " + tf + " candles as of the candidate entry close.", { timeframe: tf });
  }
  const d1 = structure(frames.D1, "D1", entryCutoff);
  const h4 = structure(frames.H4, "H4", entryCutoff);
  const h1 = structure(frames.H1, "H1", entryCutoff);
  if (h4.state !== "structured")
    return result("no_swing", "H4 has not formed two confirmed higher-high/higher-low or lower-high/lower-low sequences.", { d1, h4, h1, entryCutoff });
  if (h1.direction !== h4.direction)
    return result("waiting_h1", "H1 structure has not confirmed the H4 swing direction.", { direction: h4.direction, d1, h4, h1, entryCutoff });

  const direction = h4.direction;
  let trigger = "H1 structure confirmed";
  if (variant !== "H1_CONTROL") {
    if (frames.M15.length < 8)
      return result("warming", "Waiting for completed M15 candles for entry refinement.", { direction, d1, h4, h1, entryCutoff });
    const pivots = confirmedPivots(frames.M15, "M15", entryCutoff);
    const lastM15 = frames.M15[frames.M15.length - 1];
    const level = direction === "BUY" ? pivots.highs.at(-1) : pivots.lows.at(-1);
    const broke = level && (direction === "BUY" ? lastM15.close > level.price : lastM15.close < level.price);
    if (!broke)
      return result("waiting_m15", "H4/H1 thesis is valid, but M15 has not closed beyond its latest confirmed structure level.", { direction, d1, h4, h1, entryCutoff });
    trigger = "M15 confirmed structure break";
    if (variant === "M15_M5_REFINED") {
      if (frames.M5.length < 8)
        return result("warming", "Waiting for completed M5 candles for precision trigger.", { direction, d1, h4, h1, entryCutoff });
      const m5 = frames.M5[frames.M5.length - 1], prior = frames.M5[frames.M5.length - 2];
      const confirmed = direction === "BUY" ? m5.close > prior.high : m5.close < prior.low;
      if (!confirmed)
        return result("waiting_m5", "M15 setup is confirmed, but M5 has not closed through the prior candle extreme.", { direction, d1, h4, h1, entryCutoff });
      trigger = "M5 close beyond prior candle extreme after M15 break";
    }
  }
  const structuralPivot = direction === "BUY" ? h4.pivots.lows.at(-1) : h4.pivots.highs.at(-1);
  const volatility = atr(frames.H4);
  if (!structuralPivot || !(volatility > 0))
    return result("warming", "H4 structural invalidation or ATR is not yet available.", { direction, d1, h4, h1, entryCutoff });
  const buffer = volatility * (Number.isFinite(options.stopBufferAtr) ? options.stopBufferAtr : 0.25);
  const stopLoss = direction === "BUY" ? structuralPivot.price - buffer : structuralPivot.price + buffer;
  const riskDistance = Math.abs(entryCandle.close - stopLoss);
  const entryNoiseAtr = atr(frames.M15);
  const minEntryNoiseAtr = Number.isFinite(options.minEntryNoiseAtr) ? options.minEntryNoiseAtr : 1.5;
  const minRiskDistance = Math.max(buffer, entryNoiseAtr > 0 ? entryNoiseAtr * minEntryNoiseAtr : buffer);
  const maxRiskAtr = Number.isFinite(options.maxRiskAtr) ? options.maxRiskAtr : 3.5;
  if (!(riskDistance >= minRiskDistance) || riskDistance > volatility * maxRiskAtr)
    return result("risk_rejected", "Structural stop is inside the M15 noise floor or exceeds the predeclared H4 ATR risk ceiling.", {
      direction, entry: entryCandle.close, stopLoss, riskDistance, minRiskDistance, entryNoiseAtr,
      minEntryNoiseAtr, riskAtr: volatility, maxRiskAtr, d1, h4, h1, entryCutoff
    });
  return {
    state: "candidate", marketId, variant, direction,
    d1Context: d1.direction, d1Alignment: d1.direction === direction ? "aligned" :
      d1.direction === "NEUTRAL" ? "neutral" : "counter_trend",
    entryTimeframe, entryEpoch: entryCandle.epoch, decisionEpoch: entryCutoff,
    entry: entryCandle.close, stopLoss, riskDistance, riskAtr: volatility,
    riskInAtr: riskDistance / volatility, structuralInvalidation: structuralPivot.price,
    stopBuffer: buffer, trigger, maxRiskAtr, d1, h4, h1
  };
}

// Returns advisory events only. It never edits a signal or a broker-side stop.
function managementAdvisories(signal, candlesByTimeframe, decisionEpoch) {
  if (!signal || !["BUY", "SELL"].includes(signal.direction) ||
      !Number.isFinite(signal.entry) || !Number.isFinite(signal.stopLoss) ||
      !Number.isFinite(decisionEpoch)) return [];
  const events = [], risk = Math.abs(signal.entry - signal.stopLoss);
  if (!(risk > 0)) return events;
  const favourable = price => signal.direction === "BUY" ? price - signal.entry : signal.entry - price;
  const entryCloseEpoch = Number.isFinite(signal.decisionEpoch) ? signal.decisionEpoch :
    (Number.isFinite(signal.entryEpoch) ? signal.entryEpoch : 0);
  // Exclude bars that began before entry; their high/low may include pre-entry movement.
  const h1 = completed(candlesByTimeframe && candlesByTimeframe.H1, "H1", decisionEpoch).filter(c => c.epoch >= entryCloseEpoch);
  const h4 = completed(candlesByTimeframe && candlesByTimeframe.H4, "H4", decisionEpoch).filter(c => c.epoch >= entryCloseEpoch);
  const lastH1 = h1.at(-1), lastH4 = h4.at(-1);
  const maxFavourable = Math.max(0, ...h1.map(c => favourable(signal.direction === "BUY" ? c.high : c.low)));
  if (maxFavourable >= risk && lastH1)
    events.push({ type: "BREAK_EVEN_REVIEW", epoch: lastH1.epoch, timeframe: "H1",
      reason: "Completed H1 price path has reached at least +1R; review whether break-even protection is justified. No stop is changed." });
  if (maxFavourable >= risk * 1.5 && lastH1)
    events.push({ type: "TRAILING_PROTECTION_REVIEW", epoch: lastH1.epoch, timeframe: "H1",
      reason: "Completed H1 price path has reached at least +1.5R; review a structure-based trailing level while preserving room for the swing." });
  const target = Number.isFinite(signal.tp1) ? signal.tp1 :
    signal.entry + (signal.direction === "BUY" ? 1 : -1) * risk * 1.5;
  if (h1.some(c => signal.direction === "BUY" ? c.high >= target : c.low <= target) && lastH1)
    events.push({ type: "PARTIAL_PROFIT_REVIEW", epoch: lastH1.epoch, timeframe: "H1",
      reason: "TP1 reference was reached on a completed H1 candle; review partial profit and the remaining swing thesis." });
  if (lastH1) {
    const crossed = signal.direction === "BUY" ? lastH1.close < signal.stopLoss : lastH1.close > signal.stopLoss;
    const adverseClose = signal.direction === "BUY" ? lastH1.close < signal.entry : lastH1.close > signal.entry;
    const remainingToStop = signal.direction === "BUY" ? lastH1.close - signal.stopLoss : signal.stopLoss - lastH1.close;
    const currentH1Atr = h1.length >= 5 ? atr(h1, Math.min(14, h1.length - 1)) : 0;
    const approaching = adverseClose && currentH1Atr > 0 && remainingToStop > 0 &&
      remainingToStop <= currentH1Atr * 0.5;
    if (crossed || approaching) events.push({ type: "EARLY_LOSS_REVIEW", epoch: lastH1.epoch, timeframe: "H1",
      reason: crossed
        ? "Completed H1 close has crossed structural invalidation; review exit rather than waiting mechanically for the stop."
        : "Adverse H1 close is within 0.5 H1 ATR of structural invalidation; review an early exit before the stop is reached." });
  }
  if (lastH1 && lastH4) {
    const h1s = structure(h1, "H1", decisionEpoch), h4s = structure(h4, "H4", decisionEpoch);
    if ([h1s, h4s].some(s => ["BUY", "SELL"].includes(s.direction) && s.direction !== signal.direction))
      events.push({ type: "STRUCTURE_DETERIORATION_WARNING", epoch: lastH1.epoch, timeframe: "H1/H4",
        reason: "Completed-candle swing structure is opposing the open thesis; review whether to reduce or exit." });
    else if (h1s.direction === signal.direction && h4s.direction === signal.direction)
      events.push({ type: "HOLD_STRUCTURE_INTACT", epoch: lastH1.epoch, timeframe: "H1/H4",
        reason: "Completed H1 and H4 swing structure still supports the thesis; holding remains consistent with the plan." });
  }
  return events.filter((e, i, all) => all.findIndex(x => x.type === e.type) === i);
}

/**
 * Converts advisory evidence into one human-readable management state.
 * Priority is deliberately conservative: exit review > deterioration warning >
 * partial-profit review > protection review > hold. This is advice only.
 */
function managementDecision(signal, candlesByTimeframe, decisionEpoch, state = {}) {
  if (!signal || !Number.isFinite(decisionEpoch) ||
      !["BUY", "SELL"].includes(signal.direction) ||
      !Number.isFinite(signal.entry) || !Number.isFinite(signal.stopLoss)) {
    return { action: "WAIT", reason: "A valid open swing signal and decision timestamp are required.", events: [] };
  }
  const entryClose = Number.isFinite(signal.decisionEpoch) ? signal.decisionEpoch :
    (Number.isFinite(signal.entryEpoch) ? signal.entryEpoch : null);
  if (!Number.isFinite(entryClose) || decisionEpoch <= entryClose) {
    return { action: "WAIT", reason: "No completed post-entry candle is available yet.", events: [] };
  }
  const rawH1 = candlesByTimeframe && candlesByTimeframe.H1;
  const h1 = completed(rawH1, "H1", decisionEpoch).filter(c => c.epoch >= entryClose);
  if (!validCandles(h1) || h1.length === 0) {
    return { action: "WAIT", reason: "Waiting for the first valid completed H1 candle after entry.", events: [] };
  }
  const h1Continuity = validateContinuity(h1, "H1", signal.marketId);
  if (!h1Continuity.valid) {
    return { action: "WAIT", reason: "H1 history contains missing intervals; management advice is suppressed until the candle history is reliable.", events: [], dataGaps: h1Continuity.gaps };
  }
  const h4 = completed(candlesByTimeframe && candlesByTimeframe.H4, "H4", decisionEpoch)
    .filter(c => c.epoch >= entryClose);
  const h4Continuity = h4.length >= 2 ? validateContinuity(h4, "H4", signal.marketId) : { valid: true, gaps: [] };
  const events = managementAdvisories(signal, candlesByTimeframe, decisionEpoch)
    .filter(event => !state.dismissedEventTypes?.includes(event.type))
    .filter(event => h4Continuity.valid || !["HOLD_STRUCTURE_INTACT", "STRUCTURE_DETERIORATION_WARNING"].includes(event.type));
  const has = type => events.some(event => event.type === type);
  if (has("EARLY_LOSS_REVIEW")) {
    return { action: "EXIT_REVIEW", reason: "The completed H1 evidence shows structural risk near or beyond invalidation.", events };
  }
  if (has("STRUCTURE_DETERIORATION_WARNING")) {
    return { action: "WARNING", reason: "H1/H4 swing structure is deteriorating or opposing the open thesis.", events };
  }
  if (has("PARTIAL_PROFIT_REVIEW") && !state.partialTaken) {
    return { action: "TAKE_PARTIAL_REVIEW", reason: "The first profit reference has been reached; review a partial close while reassessing the remaining swing.", events };
  }
  if (has("TRAILING_PROTECTION_REVIEW")) {
    return { action: "PROTECT_REVIEW", reason: "Favourable movement is sufficient to review a structure-based trailing level without crowding the trade.", events };
  }
  if (has("BREAK_EVEN_REVIEW")) {
    return { action: "PROTECT_REVIEW", reason: "The trade has reached at least +1R; review whether break-even protection is appropriate for current structure.", events };
  }
  if (has("HOLD_STRUCTURE_INTACT")) {
    return { action: "HOLD", reason: "Completed H1/H4 structure still supports the swing thesis.", events };
  }
  if (!h4Continuity.valid) {
    return { action: "MONITOR", reason: "H4 history has gaps; price-based H1 reviews remain available, but no H1/H4 structure verdict is issued.", events, dataGaps: h4Continuity.gaps };
  }
  return { action: "MONITOR", reason: "No decisive management trigger is confirmed; keep the original invalidation and monitor the next completed candle.", events };
}

module.exports = { TF, VARIANTS, validCandles, completed, validateContinuity, atr, confirmedPivots, structure, evaluateTopDown, managementAdvisories, managementDecision };
