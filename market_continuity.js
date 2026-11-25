"use strict";

function latestContinuousCandleSegment(candles, seconds, minimum) {
  let segment = [];
  for (const candle of candles || []) {
    const valid = candle && [candle.epoch, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
      candle.epoch % seconds === 0 && candle.high >= Math.max(candle.open, candle.close, candle.low) &&
      candle.low <= Math.min(candle.open, candle.close);
    if (!valid) { segment = []; continue; }
    if (segment.length && candle.epoch - segment[segment.length - 1].epoch !== seconds) segment = [];
    segment.push(candle);
  }
  return segment.length >= minimum ? segment : null;
}

module.exports = { latestContinuousCandleSegment };
