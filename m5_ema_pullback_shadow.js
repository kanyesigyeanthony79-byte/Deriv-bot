"use strict";
// Forward-only M15 trend candidate with M5 EMA9/21 pullback-reclaim entry.
// Research journal only: no Telegram alerts, production signals, or MT5 execution.
const { evaluate, DEF } = require("./engine");
const MARKETS = Object.freeze(["R_10","R_25","R_50","R_75","JD75","JD100","CRASH500","BOOM500"]);
const M5 = 300, M15 = 900, STOP_LOOKBACK = 5, STOP_BUFFER_ATR = 0.10, SETUP_MAX_AGE = 12 * M5;
const MIN_RISK_ATR = 0.50, MAX_RISK_ATR = 3.0, TARGET_R = 2, HORIZON_BARS = 12;
const TERMINAL = new Set(["target","stop","time_exit","ambiguous"]);
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k=2/(period+1); let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++) v=values[i]*k+v*(1-k);
  return v;
}
function atr(candles, period=14) {
  if(!Array.isArray(candles)||candles.length<=period)return 0;
  const tr=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}
  let v=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++)v=(v*(period-1)+tr[i])/period;
  return v;
}
function continuous(rows, step, min) {
  return Array.isArray(rows)&&rows.length>=min&&rows.every((c,i)=>c&&[c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close)&&(i===0||c.epoch-rows[i-1].epoch===step));
}
function m15Bias(rows) {
  if(!continuous(rows,M15,65))return null;
  const r=evaluate(rows,DEF);
  return r.state==="ok"&&["BUY","SELL"].includes(r.signal)?r.signal:null;
}
function m5Trigger(rows, direction) {
  if(!continuous(rows,M5,65))return null;
  const closes=rows.map(c=>c.close), fast=ema(closes,9), slow=ema(closes,21), fastPrev=ema(closes.slice(0,-1),9);
  const a=atr(rows,14), c=rows.at(-1);
  if(!(a>0)||![fast,slow,fastPrev].every(Number.isFinite))return null;
  const aligned=direction==="BUY"?fast>slow&&fast>fastPrev:fast<slow&&fast<fastPrev;
  const reclaimed=direction==="BUY"?c.low<=fast+a*0.15&&c.close>fast&&c.close>c.open:c.high>=fast-a*0.15&&c.close<fast&&c.close<c.open;
  if(!aligned||!reclaimed)return null;
  const recent=rows.slice(-STOP_LOOKBACK);
  const stop=direction==="BUY"?Math.min(...recent.map(x=>x.low))-a*STOP_BUFFER_ATR:Math.max(...recent.map(x=>x.high))+a*STOP_BUFFER_ATR;
  const entry=NaN; // entry is fixed at the next M5 candle open by the caller.
  return {direction,stop,atr5:a,triggerEpoch:c.epoch,entryCandleEpoch:c.epoch+M5};
}
function makeSignal(marketId, marketName, direction, trigger, entryCandle) {
  const entry=entryCandle.open, stopLoss=trigger.stop;
  const riskDistance=direction==="BUY"?entry-stopLoss:stopLoss-entry;
  const riskAtr=riskDistance/trigger.atr5;
  if(!(riskDistance>0)||riskAtr<MIN_RISK_ATR||riskAtr>MAX_RISK_ATR)return null;
  return {signalId:marketId+"-M15_M5_PULLBACK-"+trigger.triggerEpoch,strategyId:"M15_M5_EMA_PULLBACK",strategyLabel:"M15 trend + M5 EMA9/21 pullback",marketId,market:marketName||marketId,direction,setupTimeframe:"M15",entryTimeframe:"M5",entryCandleEpoch:entryCandle.epoch,triggerEpoch:trigger.triggerEpoch,entry,stopLoss,tp2:entry+(direction==="BUY"?1:-1)*TARGET_R*riskDistance,riskDistance,riskAtr,targetR:TARGET_R,status:"pending",evaluationSource:"forward_shadow",outcomeBars:0,lastProcessedEpoch:entryCandle.epoch-M5,realizedR:null};
}
function updateOutcome(s, rows) {
  if(!s||s.status!=="pending")return s;
  for(const c of rows.filter(x=>x.epoch>=s.entryCandleEpoch&&x.epoch>s.lastProcessedEpoch)){
    s.lastProcessedEpoch=c.epoch;s.outcomeBars++;
    const stop=s.direction==="BUY"?c.low<=s.stopLoss:c.high>=s.stopLoss;
    const target=s.direction==="BUY"?c.high>=s.tp2:c.low<=s.tp2;
    if(stop&&target){s.status="ambiguous";break;}
    if(stop){s.status="stop";s.realizedR=-1;break;}
    if(target){s.status="target";s.realizedR=TARGET_R;break;}
    if(s.outcomeBars>=HORIZON_BARS){s.status="time_exit";s.realizedR=Number((((s.direction==="BUY"?1:-1)*(c.close-s.entry))/s.riskDistance).toFixed(4));break;}
  }
  return s;
}
function summarize(journal) {
  const rows=journal.signals||[], done=rows.filter(s=>TERMINAL.has(s.status));
  const wins=done.filter(s=>s.status==="target").length, losses=done.filter(s=>s.status==="stop").length;
  const realized=done.map(s=>s.realizedR).filter(Number.isFinite);
  const markets={};
  for(const id of MARKETS){const a=rows.filter(s=>s.marketId===id),d=a.filter(s=>TERMINAL.has(s.status)),w=d.filter(s=>s.status==="target").length,l=d.filter(s=>s.status==="stop").length,rs=d.map(s=>s.realizedR).filter(Number.isFinite);markets[id]={signals:a.length,resolved:d.length,pending:a.filter(s=>s.status==="pending").length,targetBeforeStop:w,stopBeforeTarget:l,targetRatePct:w+l?Number((w/(w+l)*100).toFixed(1)):null,averageRealizedR:rs.length?Number((rs.reduce((x,y)=>x+y,0)/rs.length).toFixed(3)):null};}
  return {mode:"forward_shadow_observation_only",strategy:"M15 EMA20/50 signal; M5 EMA9/21 alignment and EMA9 pullback/reclaim; next-M5-open entry; 2R target; 1-hour horizon",signalsGenerated:rows.length,resolvedSignals:done.length,pendingSignals:rows.length-done.length,targetBeforeStop:wins,stopBeforeTarget:losses,targetRatePct:wins+losses?Number((wins/(wins+losses)*100).toFixed(1)):null,averageRealizedR:realized.length?Number((realized.reduce((x,y)=>x+y,0)/realized.length).toFixed(3)):null,markets};
}
function updateM5PullbackJournal(prior, markets, nowEpoch=Math.floor(Date.now()/1000)) {
  const j=prior&&prior.version===1&&Array.isArray(prior.signals)?prior:{version:1,updatedAt:null,markets:{},signals:[]};j.markets||={};
  const ids=new Set(j.signals.map(s=>s.signalId));
  for(const [id,m] of Object.entries(markets||{})){
    if(!MARKETS.includes(id))continue;
    const f=m.timeframes||{},m5=f.M5||[],m15=f.M15||[],st=j.markets[id]||{lastM15Epoch:null,lastM5Epoch:null,initializedAt:null,signals:0};
    st.pendingSetups ||= [];
    if(!continuous(m5,M5,65)||!continuous(m15,M15,65)){st.dataQuality="insufficient_or_discontinuous";j.markets[id]=st;continue;}
    st.dataQuality="ok";
    for(const s of j.signals.filter(x=>x.marketId===id&&x.status==="pending"))updateOutcome(s,m5);
    if(st.lastM15Epoch===null||st.lastM5Epoch===null){st.lastM15Epoch=m15.at(-1).epoch;st.lastM5Epoch=m5.at(-1).epoch;st.initializedAt=new Date(nowEpoch*1000).toISOString();j.markets[id]=st;continue;}
    const newM15=m15.filter(c=>c.epoch>st.lastM15Epoch);
    for(const setup of newM15){
      const bias=m15Bias(m15.filter(c=>c.epoch<=setup.epoch));
      if(bias)st.pendingSetups.push({setupCloseEpoch:setup.epoch+M15,direction:bias,expiresEpoch:setup.epoch+M15+SETUP_MAX_AGE});
    }
    st.lastM15Epoch=m15.at(-1).epoch;
    const remaining=[];
    for(const setup of st.pendingSetups){
      if(m5.at(-1).epoch>setup.expiresEpoch)continue;
      let created=false;
      for(let i=64;i<m5.length-1;i++){
        const candle=m5[i];
        if(candle.epoch<setup.setupCloseEpoch)continue;
        const trigger=m5Trigger(m5.slice(0,i+1),setup.direction);
        if(!trigger)continue;
        const next=m5[i+1];
        if(next.epoch<=st.lastM5Epoch)continue;
        if(j.signals.some(s=>s.marketId===id&&s.status==="pending")){created=true;break;}
        const signal=makeSignal(id,m.marketName||id,setup.direction,trigger,next);
        if(signal&&!ids.has(signal.signalId)){j.signals.push(signal);ids.add(signal.signalId);st.signals++;}
        created=true;break;
      }
      if(!created)remaining.push(setup);
    }
    st.pendingSetups=remaining;
    st.lastM5Epoch=m5.at(-1).epoch;j.markets[id]=st;
  }
  j.updatedAt=new Date(nowEpoch*1000).toISOString();j.signals.sort((a,b)=>b.entryCandleEpoch-a.entryCandleEpoch);j.signals=j.signals.slice(0,2000);j.summary=summarize(j);return j;
}
module.exports={MARKETS,ema,atr,continuous,m15Bias,m5Trigger,makeSignal,updateOutcome,summarize,updateM5PullbackJournal,TERMINAL};
