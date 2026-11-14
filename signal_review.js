"use strict";
// Advisory-only review of an existing signal against the latest completed candles.
// This module never changes journal levels, places orders, or changes stop-losses.
const FRAME_SECONDS = { M1:60, M5:300, M15:900, H1:3600, H4:14400, D1:86400, W1:604800 };
function reviewSignal(signal, timeframes, nowEpoch = Math.floor(Date.now()/1000)) {
  if (!signal || !signal.signalId || !["BUY","SELL"].includes(signal.direction)) throw new Error("A valid original signal is required.");
  const tf = signal.entryTimeframe;
  const seconds = FRAME_SECONDS[tf];
  const candles = timeframes && timeframes[tf];
  if (!seconds || !Array.isArray(candles) || !candles.length) return { signalId:signal.signalId, status:"INSUFFICIENT_DATA", headline:"REVIEW UNAVAILABLE", reason:"Latest completed candles are unavailable. Do not infer that the signal is safe." };
  const completed = candles.filter(c => Number.isFinite(c.epoch) && c.epoch + seconds <= nowEpoch).sort((a,b)=>a.epoch-b.epoch);
  const last = completed[completed.length-1];
  if (!last || nowEpoch-(last.epoch+seconds) > seconds*3) return { signalId:signal.signalId, status:"STALE_DATA", headline:"DATA TOO OLD", reason:"The latest completed entry-timeframe candle is stale. No hold/exit conclusion is issued." };
  const buy = signal.direction==="BUY";
  const stopTouched = buy ? last.low <= signal.stopLoss : last.high >= signal.stopLoss;
  const tp2Touched = buy ? last.high >= signal.tp2 : last.low <= signal.tp2;
  const tp1Touched = buy ? last.high >= signal.tp1 : last.low <= signal.tp1;
  if (stopTouched && (tp1Touched || tp2Touched)) return { signalId:signal.signalId,status:"AMBIGUOUS_CANDLE",headline:"AMBIGUOUS CANDLE — VERIFY PRICE",currentPrice:last.close,lastCandleEpoch:last.epoch,reason:"The same completed candle crossed the original stop and a target level. Candle data cannot establish which was reached first; verify broker execution before deciding." };
  const ema = (values,n) => { if(values.length<n)return null; let v=values.slice(0,n).reduce((a,b)=>a+b,0)/n; const k=2/(n+1); for(let i=n;i<values.length;i++)v=values[i]*k+v*(1-k); return v; };
  const closes=completed.map(c=>c.close), fast=ema(closes,20), slow=ema(closes,50);
  if (stopTouched) return { signalId:signal.signalId,status:"STOP_LEVEL_TOUCHED",headline:"STOP-LOSS LEVEL TOUCHED",currentPrice:last.close,lastCandleEpoch:last.epoch,reason:"The latest completed candle crossed the original stop-loss level. Check actual broker price and execution; this review does not close a trade." };
  if (tp2Touched) return { signalId:signal.signalId,status:"TP2_LEVEL_TOUCHED",headline:"TP2 LEVEL TOUCHED",currentPrice:last.close,lastCandleEpoch:last.epoch,reason:"The latest completed candle reached the original TP2 level. Confirm the actual position and consider your own exit plan." };
  if (tp1Touched) return { signalId:signal.signalId,status:"TP1_LEVEL_TOUCHED",headline:"TP1 LEVEL TOUCHED",currentPrice:last.close,lastCandleEpoch:last.epoch,reason:"The latest completed candle reached the original TP1 level. Consider whether profit protection is appropriate; no stop adjustment is made." };
  if (fast===null || slow===null) return { signalId:signal.signalId,status:"INSUFFICIENT_HISTORY",headline:"REVIEW INCOMPLETE",currentPrice:last.close,lastCandleEpoch:last.epoch,reason:"Not enough completed candles to assess trend alignment." };
  const aligned=buy ? fast>slow : fast<slow;
  const closeSupport=buy ? last.close>=fast : last.close<=fast;
  const direction=aligned&&closeSupport;
  return {
    signalId:signal.signalId,
    status:direction?"THESIS_INTACT": "THESIS_WEAKENING",
    headline:direction?"THESIS STILL INTACT":"THESIS WEAKENING",
    currentPrice:last.close,lastCandleEpoch:last.epoch,
    trend:aligned?"Aligned":"Against signal",
    priceVsEma20:closeSupport?"Supportive":"Lost EMA20 area",
    originalEntry:signal.entry,originalStopLoss:signal.stopLoss,originalTp1:signal.tp1,originalTp2:signal.tp2,
    reason:direction?"Latest completed candle and EMA20/EMA50 trend remain aligned with the original signal. This is not a guarantee of safety.":"Latest completed data no longer confirms the original trend/EMA20 support. Reassess rather than assuming the trade will recover.",
    advisoryOnly:true
  };
}
module.exports={reviewSignal};
