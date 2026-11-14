"use strict";

// Advisory-only manager for open synthetic-index swing positions.
// It consumes completed candles and returns a recommendation. It never
// changes an order, stop, or position and is not imported by live execution.
const { TIMEFRAMES, validCandles, trendBias } = require("./multi_timeframe_engine");
const { validateCandleContinuity } = require("./market_quality");

const CONFIG = Object.freeze({
  breakEvenAtR: 1.0,
  trailingActivationAtR: 1.5,
  trailingLookbackM15: 5,
  trailingAtrBuffer: 0.25
});

function riskDistance(position) {
  if (Number.isFinite(position.riskDistance) && position.riskDistance > 0) return position.riskDistance;
  if (position.direction === "BUY") return position.entry - position.stopLoss;
  return position.stopLoss - position.entry;
}

function favorableR(position, price) {
  const risk = riskDistance(position);
  if (!(risk > 0)) return null;
  return position.direction === "BUY"
    ? (price - position.entry) / risk
    : (position.entry - price) / risk;
}

function barrierTouches(position, candle) {
  const buy = position.direction === "BUY";
  return {
    stop: buy ? candle.low <= position.stopLoss : candle.high >= position.stopLoss,
    tp1: position.partialTaken !== true && Number.isFinite(position.tp1) && (buy ? candle.high >= position.tp1 : candle.low <= position.tp1),
    tp2: Number.isFinite(position.tp2) && (buy ? candle.high >= position.tp2 : candle.low <= position.tp2)
  };
}

function makeTrailingStop(position, m15Candles, currentPrice, requireProfitProtection = false) {
  const lookback = m15Candles.slice(-CONFIG.trailingLookbackM15);
  if (lookback.length < CONFIG.trailingLookbackM15) return null;
  const volatility = atr(m15Candles, 14);
  if (!(volatility > 0)) return null;
  const buffer = volatility * CONFIG.trailingAtrBuffer;
  const candidate = position.direction === "BUY"
    ? Math.min(...lookback.map(c => c.low)) - buffer
    : Math.max(...lookback.map(c => c.high)) + buffer;
  if (position.direction === "BUY") {
    if (candidate <= position.stopLoss || candidate >= currentPrice ||
        (requireProfitProtection && candidate <= position.entry)) return null;
  } else if (candidate >= position.stopLoss || candidate <= currentPrice ||
      (requireProfitProtection && candidate >= position.entry)) {
    return null;
  }
  return Number(candidate.toFixed(priceDigits(position.entry)));
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i], previous = candles[i - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  let value = ranges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

function priceDigits(value) {
  return Math.max(2, Math.min(8, (String(value).split(".")[1] || "").length));
}

function recommendation(action, reason, extra = {}) {
  return { mode: "advisory_only", action, reason, ...extra };
}

function evaluateTradeManagement({ position, candlesByTimeframe }) {
  if (!position || !["BUY", "SELL"].includes(position.direction) ||
      ![position.entry, position.stopLoss].every(Number.isFinite)) {
    return recommendation("INVALID_POSITION", "A valid BUY/SELL position, entry and stop-loss are required.");
  }
  const risk = riskDistance(position);
  if (!(risk > 0)) return recommendation("INVALID_POSITION", "The initial risk distance must be positive.");

  const rawM5 = candlesByTimeframe && candlesByTimeframe.M5;
  if (!validCandles(rawM5) || rawM5.length < 51) {
    return recommendation("WAIT_FOR_DATA", "Insufficient completed M5 candles; no management advice is issued.", {
      timeframe: "M5", availableCandles: Array.isArray(rawM5) ? rawM5.length : 0, requiredCandles: 51
    });
  }
  const latestM5 = rawM5[rawM5.length - 1];
  const cutoffEpoch = latestM5.epoch + TIMEFRAMES.M5;
  const required = ["M15", "H1", "H4", "D1"];
  const frames = { M5: rawM5 };
  const m5Continuity = validateCandleContinuity(rawM5, TIMEFRAMES.M5, position.marketId);
  if (!m5Continuity.valid) {
    return recommendation("WAIT_FOR_DATA", "A candle gap exists on M5; no management advice is issued across missing data.", {
      timeframe: "M5", gaps: m5Continuity.gaps.slice(0, 3)
    });
  }
  for (const timeframe of required) {
    const raw = candlesByTimeframe && candlesByTimeframe[timeframe];
    const candles = Array.isArray(raw)
      ? raw.filter(c => c.epoch + TIMEFRAMES[timeframe] <= cutoffEpoch)
      : raw;
    if (!validCandles(candles) || candles.length < 51) {
      return recommendation("WAIT_FOR_DATA", "Insufficient completed " + timeframe + " candles; no management advice is issued.", {
        timeframe, availableCandles: Array.isArray(candles) ? candles.length : 0, requiredCandles: 51
      });
    }
    const continuity = validateCandleContinuity(candles, TIMEFRAMES[timeframe], position.marketId);
    if (!continuity.valid) {
      return recommendation("WAIT_FOR_DATA", "A candle gap exists on " + timeframe + "; do not infer a management decision across missing data.", {
        timeframe, gaps: continuity.gaps.slice(0, 3)
      });
    }
    frames[timeframe] = candles;
  }

  const currentPrice = latestM5.close;
  const rNow = favorableR(position, currentPrice);
  const touches = barrierTouches(position, latestM5);

  // OHLC cannot reveal which barrier was hit first inside one candle.
  if ((touches.stop && (touches.tp1 || touches.tp2)) || (touches.tp1 && touches.tp2)) {
    return recommendation("AMBIGUOUS_BARRIER", "The same M5 candle touched multiple trade barriers; their order cannot be known from OHLC data.", {
      currentPrice, favorableR: rNow, touches, candleEpoch: latestM5.epoch
    });
  }
  if (touches.stop) {
    return recommendation("EXIT_AT_SL", "The original stop-loss was touched in the latest completed M5 candle.", {
      currentPrice, favorableR: rNow, candleEpoch: latestM5.epoch
    });
  }
  if (touches.tp2) {
    return recommendation("CLOSE_REMAINDER", "The final target was touched; close the remaining position according to the tested plan.", {
      currentPrice, favorableR: rNow, candleEpoch: latestM5.epoch
    });
  }
  if (touches.tp1 && position.partialTaken !== true) {
    return recommendation("PARTIAL_PROFIT", "TP1 was touched. Consider taking the planned partial profit and protecting the remainder.", {
      currentPrice, favorableR: rNow, suggestedStopLoss: position.entry, candleEpoch: latestM5.epoch
    });
  }

  const h1 = trendBias(frames.H1).direction;
  const m15 = trendBias(frames.M15).direction;
  const h4 = trendBias(frames.H4).direction;
  const d1 = trendBias(frames.D1).direction;
  const opposite = position.direction === "BUY" ? "SELL" : "BUY";
  const lowerTimeframeReversal = h1 === opposite && m15 === opposite;
  const higherTimeframeInvalidation = h4 === opposite && d1 === opposite;

  // A confirmed higher-timeframe reversal invalidates the swing thesis even
  // when the position is currently profitable.
  if (higherTimeframeInvalidation) {
    return recommendation("EXIT_EARLY", "Both H4 and D1 now oppose the position, invalidating the larger swing thesis.", {
      currentPrice, favorableR: rNow, biases: { M15: m15, H1: h1, H4: h4, D1: d1 }, candleEpoch: latestM5.epoch
    });
  }

  if (!position.partialTaken && rNow >= 0.5 && (h1 === opposite || m15 === opposite)) {
    const extra = { currentPrice, favorableR: rNow, biases: { M15: m15, H1: h1, H4: h4, D1: d1 }, candleEpoch: latestM5.epoch };
    if (rNow >= CONFIG.breakEvenAtR) extra.suggestedStopLoss = position.direction === "BUY"
      ? Math.max(position.stopLoss, position.entry)
      : Math.min(position.stopLoss, position.entry);
    return recommendation("PARTIAL_PROFIT_EARLY", "The trade is in profit and a lower timeframe is weakening. Consider banking part while keeping the larger swing thesis under review.", extra);
  }

  // A lower-timeframe reversal can justify an early exit while the trade is
  // losing. For a winner, preserve the runner unless H4 and D1 also reverse.
  if (lowerTimeframeReversal && rNow < 0) {
    return recommendation("EXIT_EARLY", "H1 and M15 both oppose the position while it is losing. Consider reducing the loss before the original stop.", {
      currentPrice, favorableR: rNow, biases: { M15: m15, H1: h1, H4: h4, D1: d1 }, candleEpoch: latestM5.epoch
    });
  }

  if (position.partialTaken === true && rNow >= 0.5 &&
      (lowerTimeframeReversal || rNow >= CONFIG.trailingActivationAtR)) {
    const trailingStop = makeTrailingStop(position, frames.M15, currentPrice, true);
    if (trailingStop !== null) {
      return recommendation("TRAIL_PROTECT_PROFIT", "Protect the profitable remainder behind completed M15 structure without closing the runner solely because lower timeframes weakened.", {
        currentPrice, favorableR: rNow, suggestedStopLoss: trailingStop, biases: { M15: m15, H1: h1, H4: h4, D1: d1 }, candleEpoch: latestM5.epoch
      });
    }
  }

  const stopStillBeyondEntry = position.direction === "BUY" ? position.stopLoss < position.entry : position.stopLoss > position.entry;
  if (rNow >= CONFIG.breakEvenAtR && stopStillBeyondEntry) {
    const saferStop = position.direction === "BUY"
      ? Math.max(position.stopLoss, position.entry)
      : Math.min(position.stopLoss, position.entry);
    return recommendation("MOVE_TO_BREAK_EVEN", "The trade has reached +1R. Consider moving the stop to entry to remove the initial price risk, subject to spread and execution costs.", {
      currentPrice, favorableR: rNow, suggestedStopLoss: saferStop, biases: { M15: m15, H1: h1, H4: h4, D1: d1 }, candleEpoch: latestM5.epoch
    });
  }

  if (h1 === opposite || m15 === opposite) {
    return recommendation("WATCH_CLOSELY", "One lower timeframe is opposing the position, but the full early-exit confirmation is not present. Avoid reacting to one timeframe alone.", {
      currentPrice, favorableR: rNow, biases: { M15: m15, H1: h1, H4: h4, D1: d1 }, candleEpoch: latestM5.epoch
    });
  }

  return recommendation("HOLD", "The latest completed candles do not show a confirmed exit condition. Continue monitoring; this is not a guarantee that the trade will remain favourable.", {
    currentPrice, favorableR: rNow, biases: { M15: m15, H1: h1, H4: h4, D1: d1 }, candleEpoch: latestM5.epoch
  });
}

module.exports = { CONFIG, atr, favorableR, evaluateTradeManagement };
