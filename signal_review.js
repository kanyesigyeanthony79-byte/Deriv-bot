"use strict";
// Advisory-only review of an existing signal. Never changes journal levels or executes trades.
const FRAME_SECONDS = { M1:60, M5:300, M15:900, H1:3600, H4:14400, D1:86400, W1:604800 };
function reviewSignalCore(signal, timeframes, nowEpoch = Math.floor(Date.now()/1000)) {
  if (!signal || !signal.signalId || !["BUY","SELL"].includes(signal.direction)) throw new Error("A valid original signal is required.");
  // Preserve terminal outcomes already observed by the original MTF journal.
  // A shorter advisory candle window must not downgrade a recorded outcome.
  const recorded = {
    tp2_hit: ["TP2_LEVEL_TOUCHED", "TP2 LEVEL TOUCHED"],
    stopped: ["STOP_LEVEL_TOUCHED", "STOP-LOSS LEVEL TOUCHED"],
    stopped_after_tp1: ["STOP_AFTER_TP1", "STOP TOUCHED AFTER TP1"],
    ambiguous: ["AMBIGUOUS_CANDLE", "AMBIGUOUS CANDLE — VERIFY PRICE"],
    expired: ["EXPIRED", "SIGNAL EXPIRED"]
  }[signal.status];
  if (recorded) {
    const [status, headline] = recorded;
    const epoch = status === "TP2_LEVEL_TOUCHED" ? signal.tp2Epoch
      : status === "STOP_LEVEL_TOUCHED" || status === "STOP_AFTER_TP1" || status === "AMBIGUOUS_CANDLE" ? signal.stopEpoch
      : signal.expiredEpoch;
    return { signalId: signal.signalId, status, headline, epoch: epoch || null,
      tp1Reached: Boolean(signal.tp1Hit || signal.tp1Epoch), tp1Epoch: signal.tp1Epoch || null,
      tp2Epoch: signal.tp2Epoch || null, stopEpoch: signal.stopEpoch || null,
      expiryEpoch: signal.intendedExpiryEpoch || null, sourceJournalStatus: signal.status,
      outcomeSource: "original_mtf_journal",
      reason: "This signal already has a terminal outcome recorded by the original MTF journal. The advisory review preserves that outcome rather than reclassifying it from a limited candle snapshot.",
      advisoryOnly: true };
  }
  const tf = signal.entryTimeframe, seconds = FRAME_SECONDS[tf], candles = timeframes && timeframes[tf];
  if (!seconds || !Array.isArray(candles) || !candles.length) return {signalId:signal.signalId,status:"INSUFFICIENT_DATA",headline:"REVIEW UNAVAILABLE",reason:"Latest completed candles are unavailable. Do not infer that the signal is safe."};
  const entryEpoch=Number(signal.entryCandleEpoch);
  const explicitExpiry=signal.intendedExpiryEpoch!==null&&signal.intendedExpiryEpoch!==undefined?Number(signal.intendedExpiryEpoch):NaN;
  const maxAge=signal.maxAgeSeconds!==null&&signal.maxAgeSeconds!==undefined?Number(signal.maxAgeSeconds):NaN;
  const expiryEpoch=Number.isFinite(explicitExpiry)?explicitExpiry:
    (Number.isFinite(entryEpoch)&&Number.isFinite(maxAge)&&maxAge>0?entryEpoch+maxAge:NaN);
  if (!Number.isFinite(expiryEpoch)) return {signalId:signal.signalId,status:"EXPIRY_UNKNOWN",headline:"VALIDITY WINDOW UNKNOWN",reason:"This signal has no recorded intended expiry or usable maximum age. The review will not classify later price touches as outcomes."};
  const completed = candles.filter(c=>Number.isFinite(c.epoch)&&c.epoch+seconds<=nowEpoch&&c.epoch+seconds<=expiryEpoch).sort((a,b)=>a.epoch-b.epoch);
  const last = completed[completed.length-1];
  const buy=signal.direction==="BUY";
  const afterEntry=completed.filter(c=>Number.isFinite(entryEpoch)?c.epoch>entryEpoch:true);
  if (!afterEntry.length) {
    if (nowEpoch>expiryEpoch) return {signalId:signal.signalId,status:"EXPIRED",headline:"SIGNAL EXPIRED",reason:"The intended validity window ended without a recorded target or stop touch inside that window.",expiryEpoch,advisoryOnly:true};
    if (!last || nowEpoch-(last.epoch+seconds)>seconds*3) return {signalId:signal.signalId,status:"STALE_DATA",headline:"DATA TOO OLD",reason:"The latest completed candle inside the signal validity window is stale. No hold/exit conclusion is issued."};
    return {signalId:signal.signalId,status:"INSUFFICIENT_HISTORY",headline:"REVIEW INCOMPLETE",currentPrice:last.close,lastCandleEpoch:last.epoch,expiryEpoch,reason:"No completed candles after the original signal candle are available."};
  }
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
  if (firstTerminal) return {signalId:signal.signalId,...firstTerminal,currentPrice:last.close,lastCandleEpoch:last.epoch,tp1Reached:tp1Epoch!==null,tp1Epoch,tp2Epoch,stopEpoch,expiryEpoch,advisoryOnly:true};
  if (nowEpoch>expiryEpoch) return {signalId:signal.signalId,status:tp1Epoch!==null?"EXPIRED_AFTER_TP1":"EXPIRED",headline:tp1Epoch!==null?"EXPIRED AFTER TP1":"SIGNAL EXPIRED",currentPrice:last.close,lastCandleEpoch:last.epoch,tp1Reached:tp1Epoch!==null,tp1Epoch,expiryEpoch,reason:tp1Epoch!==null?"TP1 was reached within the valid window, but neither TP2 nor the stop was reached before expiry.":"No target or stop was reached before the intended validity window ended.",advisoryOnly:true};
  if (!last || nowEpoch-(last.epoch+seconds)>seconds*3) return {signalId:signal.signalId,status:"STALE_DATA",headline:"DATA TOO OLD",reason:"The latest completed candle inside the signal validity window is stale. No hold/exit conclusion is issued.",expiryEpoch};
  const ema=(values,n)=>{if(values.length<n)return null;let v=values.slice(0,n).reduce((a,b)=>a+b,0)/n;const k=2/(n+1);for(let i=n;i<values.length;i++)v=values[i]*k+v*(1-k);return v;};
  const closes=completed.map(c=>c.close),fast=ema(closes,20),slow=ema(closes,50);
  if(fast===null||slow===null)return {signalId:signal.signalId,status:"INSUFFICIENT_HISTORY",headline:"REVIEW INCOMPLETE",currentPrice:last.close,lastCandleEpoch:last.epoch,tp1Reached:tp1Epoch!==null,tp1Epoch,reason:"Not enough completed candles to assess trend alignment."};
  const aligned=buy?fast>slow:fast<slow,closeSupport=buy?last.close>=fast:last.close<=fast, intact=aligned&&closeSupport;
  const status=tp1Epoch!==null?(intact?"TP1_REACHED_TREND_INTACT":"TP1_REACHED_TREND_WEAKENING"):(intact?"THESIS_INTACT":"THESIS_WEAKENING");
  return {signalId:signal.signalId,status,headline:tp1Epoch!==null?(intact?"TP1 REACHED · TREND STILL ALIGNED":"TP1 REACHED · TREND WEAKENING"):(intact?"THESIS STILL INTACT":"THESIS WEAKENING"),currentPrice:last.close,lastCandleEpoch:last.epoch,trend:aligned?"Aligned":"Against signal",priceVsEma20:closeSupport?"Supportive":"Lost EMA20 area",originalEntry:signal.entry,originalStopLoss:signal.stopLoss,originalTp1:signal.tp1,originalTp2:signal.tp2,tp1Reached:tp1Epoch!==null,tp1Epoch,reason:tp1Epoch!==null?(intact?"TP1 was reached after the original signal and the latest EMA20/EMA50 context remains aligned. This is not a guarantee of safety.":"TP1 was reached earlier, but the latest trend/EMA20 context has weakened. Reassess the open position."):(intact?"Latest completed candles and EMA20/EMA50 trend remain aligned with the original signal. This is not a guarantee of safety.":"Latest completed data no longer confirms the original trend/EMA20 support. Reassess rather than assuming the trade will recover."),advisoryOnly:true};
}
function recommendationOptions(status) {
  const option = (label, detail) => ({ label, detail });
  switch (status) {
    case 'THESIS_INTACT': return [
      option('Continue monitoring', 'The current trend and EMA20 position still support the original direction. Keep checking completed candles and the original invalidation level.'),
      option('Keep to the original plan', 'Only if the live broker price, position size and risk still match the plan you chose when the signal was issued.'),
      option('Reassess at the next candle close', 'A completed close against EMA20 or an EMA20/EMA50 reversal would weaken this assessment.')
    ];
    case 'TP1_REACHED_TREND_INTACT': return [
      option('Verify TP1 was actually filled', 'The candle reached the target level; confirm the executable price and your broker order history.'),
      option('Consider protecting profit', 'Review partial-profit or risk-protection choices within your own plan; no stop is changed automatically.'),
      option('Continue monitoring toward TP2', 'Only while the original trend remains aligned and the remaining risk is acceptable.')
    ];
    case 'THESIS_WEAKENING': return [
      option('Pause adding exposure', 'The latest completed candle no longer supports the original trend/EMA20 structure.'),
      option('Wait for another completed candle', 'Look for the original direction to recover EMA20 support and trend alignment before treating the thesis as restored.'),
      option('Reassess risk or consider exiting', 'If weakness persists or your predefined invalidation condition is met, compare reducing exposure or exiting with your own risk plan.')
    ];
    case 'TP1_REACHED_TREND_WEAKENING': return [
      option('Verify TP1 execution', 'Confirm whether the target was filled at your broker; candle data alone is not an execution receipt.'),
      option('Review profit protection', 'Consider what to do with remaining exposure while the trend has weakened; no stop or position is changed automatically.'),
      option('Consider exiting if weakness persists', 'Use your predefined invalidation and risk limits rather than assuming price will recover.')
    ];
    case 'STOP_LEVEL_TOUCHED':
    case 'STOP_AFTER_TP1': return [
      option('Verify broker execution', 'A candle crossed the original stop level. Check the actual order history and executable price.'),
      option('Treat the original thesis as invalidated', 'Do not assume the setup remains valid because price later recovers.'),
      option('Review remaining exposure', 'If any position remains open, assess it against your own risk plan; this review does not close it.')
    ];
    case 'TP2_LEVEL_TOUCHED': return [
      option('Verify TP2 execution', 'Confirm whether the target was filled at your broker and record the actual result.'),
      option('Review the planned exit', 'Use the exit rules you set before entry; the dashboard does not manage the position.')
    ];
    case 'AMBIGUOUS_CANDLE': return [
      option('Check broker execution first', 'The same candle crossed a stop and target, so candle data cannot establish which happened first.'),
      option('Do not rely on the candle-only outcome', 'Use your broker order history and actual fills before deciding what happened.')
    ];
    case 'STALE_DATA':
    case 'INSUFFICIENT_DATA':
    case 'INSUFFICIENT_HISTORY': return [
      option('Wait for fresh completed candles', 'There is not enough current evidence to say the thesis is intact or weakening.'),
      option('Verify the live position independently', 'Check your broker price and risk controls; this snapshot cannot support a hold/exit conclusion.')
    ];
    default: return [
      option('Verify current market data', 'No reliable recommendation can be made from the available review snapshot.'),
      option('Check the broker position independently', 'This is an advisory evidence snapshot, not a trade-management instruction.')
    ];
  }
}
function reviewSignal(signal, timeframes, nowEpoch = Math.floor(Date.now()/1000)) {
  const result = reviewSignalCore(signal, timeframes, nowEpoch);
  return { ...result, recommendationOptions: recommendationOptions(result.status), advisoryOnly: true };
}
module.exports={reviewSignal};
