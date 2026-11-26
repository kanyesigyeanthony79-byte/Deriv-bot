"use strict";

// Step Index 300 M5 continuation model, frozen for signal-only forward testing.
// All inputs are completed candles, oldest to newest; no future data is used.
function median(values) {
  if (!values.length) return 0;
  const a = [...values].sort((x,y)=>x-y), m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}

function ema(values, period) {
  if (values.length < period) return null;
  let e = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  const k = 2/(period+1);
  for (let i=period;i<values.length;i++) e = values[i]*k + e*(1-k);
  return e;
}

function evaluateStep300(candles) {
  if (!Array.isArray(candles) || candles.length < 50) return {state:"warming"};
  const cs = candles.slice().sort((a,b)=>a.epoch-b.epoch);
  const lastFive = cs.slice(-5);
  const bullish = lastFive.every(c=>c.close>c.open);
  const bearish = lastFive.every(c=>c.close<c.open);
  if (!bullish && !bearish) return {state:"ok", signal:null, reason:"five-candle streak absent"};
  const direction = bullish ? "BUY" : "SELL";
  const fifth = lastFive[4];
  const range = fifth.high-fifth.low;
  if (!(range>0)) return {state:"ok", signal:null, reason:"zero fifth-candle range"};
  const bodyRatio = Math.abs(fifth.close-fifth.open)/range;
  if (bodyRatio < 0.50 || bodyRatio > 0.80) return {state:"ok", signal:null, reason:"fifth-candle body/range outside 0.50–0.80"};
  const closes = cs.map(c=>c.close);
  const ema20 = ema(closes,20), ema50 = ema(closes,50);
  if (ema20===null || ema50===null) return {state:"warming"};
  if (bullish ? !(ema20>ema50) : !(ema20<ema50)) return {state:"ok", signal:null, reason:"EMA20/EMA50 not aligned"};
  const medianRange = median(cs.slice(-20).map(c=>c.high-c.low).filter(x=>x>0));
  if (!(medianRange>0)) return {state:"ok", signal:null, reason:"median candle range unavailable"};
  const emaSeparationMedianRanges = Math.abs(ema20-ema50)/medianRange;
  if (emaSeparationMedianRanges < 0.50) return {state:"ok", signal:null, reason:"EMA separation below 0.50 median candle ranges"};
  return {state:"ok", signal:direction, c:fifth, bodyRatio, ema20, ema50, medianRange, emaSeparationMedianRanges};
}

module.exports = {evaluateStep300};
