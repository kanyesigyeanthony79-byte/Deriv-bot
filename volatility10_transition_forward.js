"use strict";

// Frozen, signal-only R_10 forward-test strategy. All epochs are Unix UTC seconds.
const STRATEGY_VERSION = "volatility10_transition_lowvol_1r_forward_v1";
const MARKET_ID = "R_10";
const M1 = 60, M5 = 300, H1 = 3600, H4 = 14400;
const ATR_PERIOD = 14, ATR_RANK_LOOKBACK = 500;
const SWING_LEFT = 2, SWING_RIGHT = 2;
const SWEEP_LOOKBACK = 10, DISPLACEMENT_ATR = 0.8, STOP_BUFFER_ATR = 0.10;
const ENTRY_HOURS_UTC = Object.freeze([16, 18, 19, 20]);
const MAX_ENTRY_DELAY_SECONDS = 60;
const MAX_HOLD_M5_BARS = 24;
const TERMINAL_OUTCOMES = new Set(["WIN", "LOSS", "AMBIGUOUS", "UNRESOLVED", "EXPIRED"]);

function validCandle(c) {
  return !!c && Number.isInteger(Number(c.epoch)) &&
    [c.open,c.high,c.low,c.close].every(v => Number.isFinite(Number(v))) &&
    Number(c.high) >= Math.max(Number(c.open),Number(c.close)) &&
    Number(c.low) <= Math.min(Number(c.open),Number(c.close)) &&
    Number(c.high) >= Number(c.low);
}
function validateSeries(rows, step) {
  if (!Array.isArray(rows)) return "missing_candles";
  for (let i=0;i<rows.length;i++) {
    if (!validCandle(rows[i])) return "invalid_candle";
    if (i && Number(rows[i].epoch)-Number(rows[i-1].epoch)!==step) return "data_gap";
  }
  return null;
}
function aggregateM1(m1, intervalSeconds) {
  if (![M5,H1,H4].includes(intervalSeconds)) throw new Error("Unsupported aggregation interval");
  if (validateSeries(m1,M1)) return [];
  const count=intervalSeconds/M1, out=[];
  for(let i=0;i+count<=m1.length;i++){
    const start=Number(m1[i].epoch);
    if(start%intervalSeconds!==0) continue;
    const chunk=m1.slice(i,i+count);
    if(chunk.some((c,j)=>Number(c.epoch)!==start+j*M1)) continue;
    out.push({epoch:start,open:Number(chunk[0].open),
      high:Math.max(...chunk.map(c=>Number(c.high))),
      low:Math.min(...chunk.map(c=>Number(c.low))),
      close:Number(chunk[count-1].close)});
    i+=count-1;
  }
  return out;
}
function atrSeries(rows, period=ATR_PERIOD) {
  const out=Array(rows.length).fill(null);
  if(rows.length<period) return out;
  const tr=rows.map((c,i)=>i===0?Number(c.high)-Number(c.low):
    Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-Number(rows[i-1].close)),Math.abs(Number(c.low)-Number(rows[i-1].close))));
  let value=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period-1]=value;
  for(let i=period;i<rows.length;i++){value=((period-1)*value+tr[i])/period;out[i]=value;}
  return out;
}
function rollingAtrPercentile(atrValues,index,lookback=ATR_RANK_LOOKBACK) {
  const current=atrValues[index],prior=atrValues.slice(index-lookback,index);
  if(!Number.isFinite(current)||prior.length!==lookback||!prior.every(Number.isFinite))
    return {ready:false,percentile:null,warmupRequired:lookback};
  const belowOrEqual=prior.filter(v=>v<=current).length;
  return {ready:true,percentile:belowOrEqual/lookback,warmupRequired:lookback};
}
function confirmedSwings(rows, intervalSeconds, asOfEpoch, left=SWING_LEFT, right=SWING_RIGHT) {
  const highs=[],lows=[];
  for(let i=left;i+right<rows.length;i++){
    const candle=rows[i],confirmationEpoch=Number(rows[i+right].epoch)+intervalSeconds;
    if(confirmationEpoch>asOfEpoch) continue;
    const leftRows=rows.slice(i-left,i),rightRows=rows.slice(i+1,i+right+1);
    if(leftRows.every(x=>Number(candle.high)>Number(x.high))&&rightRows.every(x=>Number(candle.high)>Number(x.high)))
      highs.push({price:Number(candle.high),epoch:Number(candle.epoch),confirmedAt:confirmationEpoch});
    if(leftRows.every(x=>Number(candle.low)<Number(x.low))&&rightRows.every(x=>Number(candle.low)<Number(x.low)))
      lows.push({price:Number(candle.low),epoch:Number(candle.epoch),confirmedAt:confirmationEpoch});
  }
  return {highs,lows};
}
function classifyStructure(rows,intervalSeconds,asOfEpoch) {
  const swings=confirmedSwings(rows,intervalSeconds,asOfEpoch);
  if(swings.highs.length<2||swings.lows.length<2)
    return {direction:"NEUTRAL",reason:"insufficient_confirmed_swings",swings};
  const h=swings.highs.slice(-2),l=swings.lows.slice(-2);
  if(h[1].price>h[0].price&&l[1].price>l[0].price)
    return {direction:"BULLISH",reason:"higher_confirmed_high_and_low",swings};
  if(h[1].price<h[0].price&&l[1].price<l[0].price)
    return {direction:"BEARISH",reason:"lower_confirmed_high_and_low",swings};
  return {direction:"NEUTRAL",reason:"mixed_or_transition_structure",swings};
}
function isTransitionRegime(h4,h1) {
  return !((h4==="BULLISH"&&h1==="BULLISH")||(h4==="BEARISH"&&h1==="BEARISH"));
}
function detectSweep(rows,index,atrValue) {
  if(index<SWEEP_LOOKBACK||!(atrValue>0)) return null;
  const current=rows[index],prior=rows.slice(index-SWEEP_LOOKBACK,index);
  const body=Math.abs(Number(current.close)-Number(current.open));
  const priorLow=Math.min(...prior.map(c=>Number(c.low)));
  const priorHigh=Math.max(...prior.map(c=>Number(c.high)));
  if(Number(current.low)<priorLow&&Number(current.close)>Number(current.open)&&body>=DISPLACEMENT_ATR*atrValue)
    return {direction:"BUY",sweepExtreme:Number(current.low),priorExtreme:priorLow,body,bodyAtr:body/atrValue};
  if(Number(current.high)>priorHigh&&Number(current.close)<Number(current.open)&&body>=DISPLACEMENT_ATR*atrValue)
    return {direction:"SELL",sweepExtreme:Number(current.high),priorExtreme:priorHigh,body,bodyAtr:body/atrValue};
  return null;
}
function utcHour(epoch) { return new Date(Number(epoch)*1000).getUTCHours(); }
function calculateLevels(direction,entry,sweepExtreme,atrValue) {
  if(!["BUY","SELL"].includes(direction)||![entry,sweepExtreme,atrValue].every(Number.isFinite)||atrValue<=0)
    return {valid:false,reason:"invalid_inputs"};
  const stopLoss=direction==="BUY"?sweepExtreme-STOP_BUFFER_ATR*atrValue:sweepExtreme+STOP_BUFFER_ATR*atrValue;
  const risk=Math.abs(entry-stopLoss);
  if(!(risk>0)||!(direction==="BUY"?stopLoss<entry:stopLoss>entry))
    return {valid:false,reason:"stop_not_on_correct_side"};
  return {valid:true,entry,stopLoss,target:entry+(direction==="BUY"?risk:-risk),risk,distanceR:1};
}
function evaluateSetup({m1,m5,h1,h4,nowEpoch,activeTrade=null,lastSetupEpoch=null}) {
  if(!Number.isFinite(nowEpoch)) return {status:"SKIPPED",reason:"invalid_clock"};
  if(activeTrade) return {status:"SKIPPED",reason:"active_trade_exists"};
  if(!m5?.length||!m1?.length||!h1?.length||!h4?.length) return {status:"SKIPPED",reason:"missing_timeframe_data"};
  const setup=m5[m5.length-1],setupClose=Number(setup.epoch)+M5;
  if(setupClose>nowEpoch) return {status:"SKIPPED",reason:"setup_candle_not_completed"};
  if(lastSetupEpoch===Number(setup.epoch)) return {status:"SKIPPED",reason:"duplicate_setup_candle"};
  const hour=utcHour(setupClose);
  if(!ENTRY_HOURS_UTC.includes(hour)) return {status:"SKIPPED",reason:"outside_utc_window",utcHour:hour};
  const h4Structure=classifyStructure(h4,H4,setupClose);
  const h1Structure=classifyStructure(h1,H1,setupClose);
  if(!isTransitionRegime(h4Structure.direction,h1Structure.direction))
    return {status:"SKIPPED",reason:"higher_timeframes_aligned",h4Structure,h1Structure};
  const atrs=atrSeries(m5),i=m5.length-1,atrValue=atrs[i];
  const rank=rollingAtrPercentile(atrs,i);
  if(!rank.ready) return {status:"SKIPPED",reason:"atr_percentile_warmup",atrValue,atrPercentile:null};
  if(!(rank.percentile<0.33)) return {status:"SKIPPED",reason:"volatility_not_lower_third",atrValue,atrPercentile:rank.percentile};
  const setupSignal=detectSweep(m5,i,atrValue);
  if(!setupSignal) return {status:"SKIPPED",reason:"sweep_or_displacement_not_met",atrValue,atrPercentile:rank.percentile};
  const entryCandle=m1.find(c=>Number(c.epoch)===setupClose);
  if(!entryCandle) return {status:"SKIPPED",reason:"next_entry_candle_unavailable",atrValue,atrPercentile:rank.percentile};
  const entryDelaySeconds=Number(nowEpoch)-setupClose;
  if(entryDelaySeconds<0||entryDelaySeconds>MAX_ENTRY_DELAY_SECONDS)
    return {status:"SKIPPED",reason:"stale_entry",entryDelaySeconds,atrValue,atrPercentile:rank.percentile};
  const levels=calculateLevels(setupSignal.direction,Number(entryCandle.open),setupSignal.sweepExtreme,atrValue);
  if(!levels.valid) return {status:"SKIPPED",reason:levels.reason,atrValue,atrPercentile:rank.percentile};
  const signalId="R10-TF-"+setup.epoch+"-"+setupSignal.direction;
  return {status:"GENERATED",signal:{
    strategyVersion:STRATEGY_VERSION,providerId:STRATEGY_VERSION,signalId,marketId:MARKET_ID,
    market:"Volatility 10 Index",direction:setupSignal.direction,
    signalTimestamp:new Date(setupClose*1000).toISOString(),signalEpoch:setupClose,
    entryTimestamp:new Date(Number(entryCandle.epoch)*1000).toISOString(),
    entryEpoch:Number(entryCandle.epoch),entry:levels.entry,referenceEntryPrice:levels.entry,
    stopLoss:levels.stopLoss,target:levels.target,risk:levels.risk,targetR:1,
    h4Structure:h4Structure.direction,h1Structure:h1Structure.direction,
    h4StructureReason:h4Structure.reason,h1StructureReason:h1Structure.reason,
    m5Setup:{candleEpoch:Number(setup.epoch),closeEpoch:setupClose,sweepExtreme:setupSignal.sweepExtreme,
      priorExtreme:setupSignal.priorExtreme,body:setupSignal.body,bodyAtr:setupSignal.bodyAtr},
    atr14:atrValue,atrPercentile:rank.percentile,utcHour:hour,
    spread:null,quoteAgeSeconds:null,dataSource:"Deriv completed M1 candles aggregated to M5/H1/H4",
    entryDelaySeconds,deliveryStatus:"PENDING",status:"PAPER",paper:true,live:false,
    brokerExecutionAllowed:false,createdAt:new Date(Number(nowEpoch)*1000).toISOString()
  }};
}
function resolveM1Outcome(signal,m1Rows) {
  const maxBars=MAX_HOLD_M5_BARS*(M5/M1);
  let expectedEpoch=Number(signal.entryEpoch),observed=0;
  for(const candle of m1Rows){
    const epoch=Number(candle.epoch);
    if(epoch<expectedEpoch) continue;
    if(epoch!==expectedEpoch) return {outcome:"UNRESOLVED",reason:"M1_DATA_GAP",exitEpoch:null,exitPrice:null,dataGap:true};
    const stopHit=signal.direction==="BUY"?Number(candle.low)<=signal.stopLoss:Number(candle.high)>=signal.stopLoss;
    const targetHit=signal.direction==="BUY"?Number(candle.high)>=signal.target:Number(candle.low)<=signal.target;
    observed++;
    if(stopHit&&targetHit) return {outcome:"AMBIGUOUS",reason:"BOTH_LEVELS_TOUCHED_IN_SAME_M1",exitEpoch:epoch,exitPrice:null,ambiguous:true};
    if(stopHit) return {outcome:"LOSS",reason:"STOP_LOSS_FIRST",exitEpoch:epoch,exitPrice:signal.stopLoss};
    if(targetHit) return {outcome:"WIN",reason:"1R_TARGET_FIRST",exitEpoch:epoch,exitPrice:signal.target};
    expectedEpoch+=M1;
    if(observed>=maxBars) return {outcome:"EXPIRED",reason:"24_M5_CANDLE_TIMEOUT",exitEpoch:epoch,exitPrice:Number(candle.close)};
  }
  return {outcome:"PENDING",reason:"WAITING_FOR_M1_OUTCOME",exitEpoch:null,exitPrice:null};
}
function isTerminalOutcome(value) { return TERMINAL_OUTCOMES.has(value); }
module.exports={STRATEGY_VERSION,MARKET_ID,M1,M5,H1,H4,ATR_PERIOD,ATR_RANK_LOOKBACK,SWING_LEFT,SWING_RIGHT,
  SWEEP_LOOKBACK,DISPLACEMENT_ATR,STOP_BUFFER_ATR,ENTRY_HOURS_UTC,MAX_ENTRY_DELAY_SECONDS,MAX_HOLD_M5_BARS,
  validCandle,validateSeries,aggregateM1,atrSeries,rollingAtrPercentile,confirmedSwings,classifyStructure,
  isTransitionRegime,detectSweep,utcHour,calculateLevels,evaluateSetup,resolveM1Outcome,isTerminalOutcome};
