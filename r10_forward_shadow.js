"use strict";
// R10 forward-only shadow validation. Uses completed Deriv candles supplied by the
// existing collector. No Telegram, production signal routing, MT5, or order execution.
const { evaluate } = require("./engine");

const MARKET_ID = "R_10";
const SECONDS = Object.freeze({ M1: 60, M5: 300, M15: 900 });
const ENTRY_WINDOW_SECONDS = 900;
const OBSERVATION_SECONDS = 3600;
const LOOKBACK = 5;
const ATR_BUFFER = 0.10;
const MAX_STOP_M15_ATR = 2.0;
const TARGET_R = 2.0;
const TERMINAL = new Set(["target", "stop", "time_exit", "ambiguous", "censored", "no_trigger", "wide_risk", "invalid_risk"]);

function validCandle(c) {
  return c && [c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.high >= c.low && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close);
}
function latestContinuousSegment(rows, step) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  for (let i=0;i<rows.length;i++) {
    if (!validCandle(rows[i]) || (i>0 && rows[i].epoch<=rows[i-1].epoch)) return [];
  }
  let start=rows.length-1;
  while(start>0 && rows[start].epoch-rows[start-1].epoch===step) start--;
  return rows.slice(start);
}
function ema(values, period) {
  if(!Array.isArray(values)||values.length<period)return null;
  const k=2/(period+1);let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)value=values[i]*k+value*(1-k);
  return value;
}
function atr(rows, period=14) {
  if(!Array.isArray(rows)||rows.length<=period)return 0;
  const tr=[];
  for(let i=1;i<rows.length;i++){const c=rows[i],p=rows[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}
  let value=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++)value=(value*(period-1)+tr[i])/period;
  return value;
}
function lowerBound(rows, epoch) {
  let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].epoch<epoch)lo=mid+1;else hi=mid;}
  return lo;
}
function lastCompletedIndex(rows, step, epoch) {
  let lo=0,hi=rows.length-1,answer=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(rows[mid].epoch+step<=epoch){answer=mid;lo=mid+1;}else hi=mid-1;}
  return answer;
}
function trendAligned(rows,index,direction) {
  if(index<20)return false;
  const closes=rows.slice(0,index+1).map(c=>c.close);
  const fast=ema(closes,9),slow=ema(closes,21);
  return direction==="BUY"?fast>slow:fast<slow;
}
function findM5Trigger(rows, setupCloseEpoch, direction) {
  const start=lowerBound(rows,setupCloseEpoch),end=setupCloseEpoch+ENTRY_WINDOW_SECONDS;
  for(let i=Math.max(25,start);i<rows.length-1;i++){
    const c=rows[i];if(c.epoch>=end)break;
    if(!trendAligned(rows,i,direction))continue;
    const previous=rows[i-1],previousEma=ema(rows.slice(0,i).map(x=>x.close),9);
    const currentRows=rows.slice(0,i+1),currentEma=ema(currentRows.map(x=>x.close),9),volatility=atr(currentRows,14);
    if(!(volatility>0))continue;
    const confirmed=direction==="BUY"
      ? previous.close>previousEma&&c.low<=currentEma+volatility*.15&&c.close>currentEma&&c.close>c.open
      : previous.close<previousEma&&c.high>=currentEma-volatility*.15&&c.close<currentEma&&c.close<c.open;
    if(confirmed)return {index:i,candle:c,entryCandle:rows[i+1],volatility};
  }
  return null;
}
function findM1Trigger(m1,m5,setupCloseEpoch,direction) {
  const start=lowerBound(m1,setupCloseEpoch),end=setupCloseEpoch+ENTRY_WINDOW_SECONDS;
  for(let i=Math.max(30,start);i<m1.length-1;i++){
    const c=m1[i];if(c.epoch>=end)break;
    const m5Index=lastCompletedIndex(m5,SECONDS.M5,c.epoch);
    if(m5Index<20||!trendAligned(m5,m5Index,direction))continue;
    const current=m1.slice(0,i+1),currentEma=ema(current.map(x=>x.close),9),volatility=atr(current,14);
    if(!(volatility>0))continue;
    const prior=m1.slice(i-3,i);if(prior.length!==3)continue;
    const swing=direction==="BUY"?Math.max(...prior.map(x=>x.high)):Math.min(...prior.map(x=>x.low));
    const confirmed=direction==="BUY"
      ? c.low<=currentEma+volatility*.10&&c.close>currentEma&&c.close>c.open&&c.close>swing
      : c.high>=currentEma-volatility*.10&&c.close<currentEma&&c.close<c.open&&c.close<swing;
    if(confirmed)return {index:i,candle:c,entryCandle:m1[i+1],volatility};
  }
  return null;
}
function structureStop(rows,index,direction,entry,volatility,setupAtr) {
  const recent=rows.slice(Math.max(0,index-LOOKBACK+1),index+1);
  if(recent.length!==LOOKBACK||!(volatility>0)||!(setupAtr>0))return {accepted:false,status:"invalid_risk"};
  const stop=direction==="BUY"?Math.min(...recent.map(x=>x.low))-volatility*ATR_BUFFER:Math.max(...recent.map(x=>x.high))+volatility*ATR_BUFFER;
  const risk=Math.abs(entry-stop),valid=direction==="BUY"?stop<entry:stop>entry;
  if(!valid||!(risk>0)||!Number.isFinite(risk))return {accepted:false,status:"invalid_risk"};
  const riskM15Atr=risk/setupAtr;
  if(riskM15Atr>MAX_STOP_M15_ATR)return {accepted:false,status:"wide_risk",riskDistance:risk,riskM15Atr,stopLoss:stop};
  return {accepted:true,stopLoss:stop,riskDistance:risk,riskM15Atr};
}
function resolveOutcome(rows,entryIndex,direction,entry,stop,horizonEnd,step) {
  const risk=Math.abs(entry-stop);if(!(risk>0))return {status:"invalid_risk"};
  const target=entry+(direction==="BUY"?1:-1)*TARGET_R*risk;
  let last=null,bars=0;
  for(let i=entryIndex;i<rows.length&&rows[i].epoch<horizonEnd;i++){
    const c=rows[i];last=c;bars++;
    const stopHit=direction==="BUY"?c.low<=stop:c.high>=stop;
    const targetHit=direction==="BUY"?c.high>=target:c.low<=target;
    if(stopHit&&targetHit)return {status:"ambiguous",barsObserved:bars,outcomeEpoch:c.epoch};
    if(stopHit)return {status:"stop",r:-1,barsObserved:bars,outcomeEpoch:c.epoch};
    if(targetHit)return {status:"target",r:TARGET_R,barsObserved:bars,outcomeEpoch:c.epoch};
  }
  if(!last||last.epoch+step<horizonEnd)return {status:"pending",barsObserved:bars};
  const move=direction==="BUY"?last.close-entry:entry-last.close;
  return {status:"time_exit",r:move/risk,barsObserved:bars,outcomeEpoch:last.epoch};
}
function summarizeTrades(trades) {
  const counts={};for(const t of trades)counts[t.status]=(counts[t.status]||0)+1;
  const resolved=trades.filter(t=>["target","stop","time_exit"].includes(t.status));
  const returns=resolved.map(t=>t.r).filter(Number.isFinite);
  return {setups:trades.length,resolved:resolved.length,target:counts.target||0,stop:counts.stop||0,timeExit:counts.time_exit||0,ambiguous:counts.ambiguous||0,pending:counts.pending||0,noTrigger:counts.no_trigger||0,wideRisk:counts.wide_risk||0,invalidRisk:counts.invalid_risk||0,censored:counts.censored||0,expectancyR:returns.length?Number((returns.reduce((a,b)=>a+b,0)/returns.length).toFixed(3)):null};
}
function nonOverlappingSetups(setups) {
  const ordered=setups.slice().sort((a,b)=>a.setupCloseEpoch-b.setupCloseEpoch),out=[];let next=-Infinity;
  for(const s of ordered){if(s.setupCloseEpoch<next)continue;out.push(s);next=s.setupCloseEpoch+ENTRY_WINDOW_SECONDS+OBSERVATION_SECONDS;}
  return out;
}
function tradeForTrigger(rows,tf,trigger,direction,setupAtr,setupCloseEpoch) {
  if(!trigger)return {status:"waiting"};
  if(!trigger.entryCandle)return {status:"waiting"};
  const stop=structureStop(rows,trigger.index,direction,trigger.entryCandle.open,trigger.volatility,setupAtr);
  if(!stop.accepted)return {...stop,triggerEpoch:trigger.candle.epoch,entryEpoch:trigger.entryCandle.epoch};
  return {status:"pending",entry:trigger.entryCandle.open,entryEpoch:trigger.entryCandle.epoch,triggerEpoch:trigger.candle.epoch,stopLoss:stop.stopLoss,riskDistance:stop.riskDistance,riskM15Atr:stop.riskM15Atr,target:trigger.entryCandle.open+(direction==="BUY"?1:-1)*TARGET_R*stop.riskDistance,horizonEndEpoch:trigger.entryCandle.epoch+OBSERVATION_SECONDS,timeframe:tf};
}
function updateTradeOutcome(trade,rows,tf) {
  if(!trade||trade.status!=="pending")return trade;
  const first=lowerBound(rows,trade.entryEpoch);
  if(first>=rows.length||rows[first].epoch>trade.entryEpoch){trade.status="censored";trade.reason="entry_candle_missing_from_latest_continuous_segment";return trade;}
  const outcome=resolveOutcome(rows,first,trade.direction,trade.entry,trade.stopLoss,trade.horizonEndEpoch,SECONDS[tf]);
  if(outcome.status!=="pending")Object.assign(trade,outcome);
  return trade;
}
function updateR10ForwardShadowJournal(prior,market,nowEpoch=Math.floor(Date.now()/1000),marketId=MARKET_ID) {
  const journal=prior&&prior.version===1&&Array.isArray(prior.setups)
    ? prior : {version:1,createdAt:new Date(nowEpoch*1000).toISOString(),updatedAt:null,marketId,setups:[]};
  if(!market||market.marketId!==marketId||!market.timeframes)return journal;
  const frames={
    M1:latestContinuousSegment(market.timeframes.M1,SECONDS.M1),
    M5:latestContinuousSegment(market.timeframes.M5,SECONDS.M5),
    M15:latestContinuousSegment(market.timeframes.M15,SECONDS.M15)
  };
  const {M1:m1,M5:m5,M15:m15}=frames;
  if(m1.length<40||m5.length<30||m15.length<65){journal.dataQuality="insufficient_continuous_history";journal.updatedAt=new Date(nowEpoch*1000).toISOString();return journal;}
  journal.dataQuality="ok";
  journal.coverage={M1:{candles:m1.length,start:m1[0].epoch,end:m1.at(-1).epoch},M5:{candles:m5.length,start:m5[0].epoch,end:m5.at(-1).epoch},M15:{candles:m15.length,start:m15[0].epoch,end:m15.at(-1).epoch}};
  // First run establishes a forward-only starting cursor; older candles are not backfilled
  // into this journal because those observations predate the forward-validation start.
  if (!Number.isFinite(journal.lastSetupEpoch)) {
    journal.lastSetupEpoch = m15.at(-1).epoch;
    journal.startedAt = new Date(nowEpoch * 1000).toISOString();
  } else {
    for(let i=64;i<m15.length;i++){
      const candle=m15[i];if(candle.epoch<=journal.lastSetupEpoch)continue;
      const closeEpoch=candle.epoch+SECONDS.M15;
      if(closeEpoch>nowEpoch)continue;
      const result=evaluate(m15.slice(0,i+1));
      if(result.state!=="ok"||!["BUY","SELL"].includes(result.signal))continue;
      const setupAtr=Number(result.metrics?.atr);if(!(setupAtr>0))continue;
      journal.setups.push({setupEpoch:candle.epoch,setupCloseEpoch:closeEpoch,direction:result.signal,score:result.score,setupAtr,createdAt:new Date(closeEpoch*1000).toISOString(),baseline:{status:"waiting"},m5:{status:"waiting"},m1:{status:"waiting"}});
    }
    journal.lastSetupEpoch = Math.max(journal.lastSetupEpoch,m15.at(-1).epoch);
  }
  journal.setups.sort((a,b)=>a.setupEpoch-b.setupEpoch);
  for(const setup of journal.setups){
    if(setup.baseline.status==="waiting"){
      const idx=lowerBound(m15,setup.setupCloseEpoch);
      if(idx<m15.length&&m15[idx].epoch===setup.setupCloseEpoch){
        const entry=m15[idx].open,risk=setup.setupAtr*1.5,stop=setup.direction==="BUY"?entry-risk:entry+risk;
        Object.assign(setup.baseline,{status:"pending",entry,entryEpoch:m15[idx].epoch,stopLoss:stop,riskDistance:risk,riskM15Atr:1.5,target:entry+(setup.direction==="BUY"?1:-1)*TARGET_R*risk,horizonEndEpoch:m15[idx].epoch+OBSERVATION_SECONDS,timeframe:"M15"});
      }
    }
    if(setup.m5.status==="waiting"){
      const trigger=findM5Trigger(m5,setup.setupCloseEpoch,setup.direction);
      if(trigger){const trade=tradeForTrigger(m5,"M5",trigger,setup.direction,setup.setupAtr,setup.setupCloseEpoch);if(trade.status!=="waiting")Object.assign(setup.m5,trade);}
      else if(m5.at(-1).epoch+SECONDS.M5>=setup.setupCloseEpoch+ENTRY_WINDOW_SECONDS){
        setup.m5.status=m5[0].epoch>setup.setupCloseEpoch?"censored":"no_trigger";
        if(setup.m5.status==="censored")setup.m5.reason="M5 continuous segment does not cover the full trigger window.";
      }
    }
    if(setup.m1.status==="waiting"){
      const trigger=findM1Trigger(m1,m5,setup.setupCloseEpoch,setup.direction);
      if(trigger){const trade=tradeForTrigger(m1,"M1",trigger,setup.direction,setup.setupAtr,setup.setupCloseEpoch);if(trade.status!=="waiting")Object.assign(setup.m1,trade);}
      else if(m1.at(-1).epoch+SECONDS.M1>=setup.setupCloseEpoch+ENTRY_WINDOW_SECONDS){
        setup.m1.status=m1[0].epoch>setup.setupCloseEpoch?"censored":"no_trigger";
        if(setup.m1.status==="censored")setup.m1.reason="M1 continuous segment does not cover the full trigger window.";
      }
    }
    for(const [tf,key] of [["M15","baseline"],["M5","m5"],["M1","m1"]]){
      const trade=setup[key];
      if(trade.status==="pending"){trade.direction=setup.direction;updateTradeOutcome(trade,frames[tf],tf);}
    }
  }
  const tradesFor=key=>journal.setups.map(s=>({...s[key],direction:s.direction,setupEpoch:s.setupEpoch,setupCloseEpoch:s.setupCloseEpoch}));
  const selected=nonOverlappingSetups(journal.setups);
  const split=Math.ceil(selected.length/2);
  journal.summary={
    mode:"forward_shadow_observation_only",
    generatedAt:new Date(nowEpoch*1000).toISOString(),
    setups:journal.setups.length,
    methods:{baseline:summarizeTrades(tradesFor("baseline")),m5:summarizeTrades(tradesFor("m5")),m1:summarizeTrades(tradesFor("m1"))},
    nonOverlapping:{setups:selected.length,excluded:journal.setups.length-selected.length,split:{discovery:split,validation:selected.length-split},methods:{
      baseline:summarizeTrades(tradesFor("baseline").filter(t=>selected.some(s=>s.setupEpoch===t.setupEpoch))),
      m5:summarizeTrades(tradesFor("m5").filter(t=>selected.some(s=>s.setupEpoch===t.setupEpoch))),
      m1:summarizeTrades(tradesFor("m1").filter(t=>selected.some(s=>s.setupEpoch===t.setupEpoch)))
    }}
  };
  journal.updatedAt=journal.summary.generatedAt;
  return journal;
}
module.exports={updateR10ForwardShadowJournal,latestContinuousSegment,findM5Trigger,findM1Trigger,structureStop,resolveOutcome,summarizeTrades,nonOverlappingSetups,TERMINAL};
