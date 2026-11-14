"use strict";
// Advisory-only review of an existing signal. Never changes journal levels or executes trades.
const FRAME_SECONDS = { M1:60, M5:300, M15:900, H1:3600, H4:14400, D1:86400, W1:604800 };
function reviewSignal(signal, timeframes, nowEpoch = Math.floor(Date.now()/1000)) {
  if (!signal || !signal.signalId || !["BUY","SELL"].includes(signal.direction)) throw new Error("A valid original signal is required.");
  const tf = signal.entryTimeframe, seconds = FRAME_SECONDS[tf], candles = timeframes && timeframes[tf];
  if (!seconds || !Array.isArray(candles) || !candles.length) return {signalId:signal.signalId,status:"INSUFFICIENT_DATA",headline:"REVIEW UNAVAILABLE",reason:"Latest completed candles are unavailable. Do not infer that the signal is safe."};
  const completed = candles.filter(c=>Number.isFinite(c.epoch)&&c.epoch+seconds<=nowEpoch).sort((a,b)=>a.epoch-b.epoch);
  const last = completed[completed.length-1];
  if (!last || nowEpoch-(last.epoch+seconds)>seconds*3) return {signalId:signal.signalId,status:"STALE_DATA",headline:"DATA TOO OLD",reason:"The latest completed entry-timeframe candle is stale. No hold/exit conclusion is issued."};
  const buy=signal.direction==="BUY";
  const afterEntry=completed.filter(c=>Number.isFinite(signal.entryCandleEpoch)?c.epoch>signal.entryCandleEpoch:true);
  if (!afterEntry.length) return {signalId:signal.signalId,status:"INSUFFICIENT_HISTORY",headline:"REVIEW INCOMPLETE",currentPrice:last.close,lastCandleEpoch:last.epoch,reason:"No completed candles after the original signal candle are available."};
  let tp1Epoch=null,tp2Epoch=null,stopEpoch=null,firstTerminal=null;
  for (const candle of afterEntry) {
    const stop=buy?candle.low<=signal.stopLoss:candle.high>=signal.stopLoss;
    const tp1=buy?candle.high>=signal.tp1:candle.low<=signal.tp1;
    const tp2=buy?candle.high>=signal.tp2:candle.low<=signal.tp2;
    if (tp1 && tp1Epoch===null) tp1Epoch=candle.epoch;
    if (stop && (tp1||tp2)) { firstTerminal={status:"AMBIGUOUS_CANDLE",epoch:candle.epoch,headline:"AMBIGUOUS CANDLE — VERIFY PRICE",reason:"A completed candle crossed the original stop and a target. Candle data cannot establish which was reached first; verify broker execution."}; break; }
    if (stop) { stopEpoch=candle.epoch; firstTerminal={status:tp1Epoch!==null?"STOP_AFTER_TP1":"STOP_LEVEL_TOUCHED",epoch:candle.epoch,headline:tp1Epoch!==null?"STOP TOUCHED AFTER TP1":"STOP-LOSS LEVEL TOUCHED",reason:"A completed candle after the signal crossed the original stop-loss level. Verify the actual broker price and execution; this review does not close a trade."}; break; }
    if (tp2) { tp2Epoch=candle.epoch; firstTerminal={status:"TP2_LEVEL_TOUCHED",epoch:candle.epoch,headline:"TP2 LEVEL TOUCHED",reason:"A completed candle reached the original TP2 level. Verify actual execution and your own exit plan."}; break; }
  }
  if (firstTerminal) return {signalId:signal.signalId,...firstTerminal,currentPrice:last.close,lastCandleEpoch:last.epoch,tp1Reached:tp1Epoch!==null,tp1Epoch,tp2Epoch,stopEpoch,advisoryOnly:true};
  const ema=(values,n)=>{if(values.length<n)return null;let v=values.slice(0,n).reduce((a,b)=>a+b,0)/n;const k=2/(n+1);for(let i=n;i<values.length;i++)v=values[i]*k+v*(1-k);return v;};
  const closes=completed.map(c=>c.close),fast=ema(closes,20),slow=ema(closes,50);
  if(fast===null||slow===null)return {signalId:signal.signalId,status:"INSUFFICIENT_HISTORY",headline:"REVIEW INCOMPLETE",currentPrice:last.close,lastCandleEpoch:last.epoch,tp1Reached:tp1Epoch!==null,tp1Epoch,reason:"Not enough completed candles to assess trend alignment."};
  const aligned=buy?fast>slow:fast<slow,closeSupport=buy?last.close>=fast:last.close<=fast, intact=aligned&&closeSupport;
  const status=tp1Epoch!==null?(intact?"TP1_REACHED_TREND_INTACT":"TP1_REACHED_TREND_WEAKENING"):(intact?"THESIS_INTACT":"THESIS_WEAKENING");
  return {signalId:signal.signalId,status,headline:tp1Epoch!==null?(intact?"TP1 REACHED · TREND STILL ALIGNED":"TP1 REACHED · TREND WEAKENING"):(intact?"THESIS STILL INTACT":"THESIS WEAKENING"),currentPrice:last.close,lastCandleEpoch:last.epoch,trend:aligned?"Aligned":"Against signal",priceVsEma20:closeSupport?"Supportive":"Lost EMA20 area",originalEntry:signal.entry,originalStopLoss:signal.stopLoss,originalTp1:signal.tp1,originalTp2:signal.tp2,tp1Reached:tp1Epoch!==null,tp1Epoch,reason:tp1Epoch!==null?(intact?"TP1 was reached after the original signal and the latest EMA20/EMA50 context remains aligned. This is not a guarantee of safety.":"TP1 was reached earlier, but the latest trend/EMA20 context has weakened. Reassess the open position."):(intact?"Latest completed candles and EMA20/EMA50 trend remain aligned with the original signal. This is not a guarantee of safety.":"Latest completed data no longer confirms the original trend/EMA20 support. Reassess rather than assuming the trade will recover."),advisoryOnly:true};
}
module.exports={reviewSignal};
