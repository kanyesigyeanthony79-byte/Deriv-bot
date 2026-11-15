"use strict";
// Offline rule-discovery research. Reads completed M15 candles only.
// It never emits alerts or places orders. All candidates share identical entry/exit assumptions.
const { validateCandleContinuity } = require("./market_quality");
const TIMEFRAME = 900, STOP_ATR = 1.5, TP1_R = 2, TP2_R = 3, HORIZON = 96;
const MAX_CANDLES_PER_MARKET = 2000, MIN_RESEARCH_BARS = 400;
function mergeCandleArchive(prior, markets) {
  const archive = prior && prior.version === 1 ? prior : { version: 1, updatedAt: null, markets: {} };
  archive.markets ||= {};
  for (const [id, market] of Object.entries(markets || {})) {
    const incoming = market.timeframes?.M15 || [];
    if (!incoming.length) continue;
    const byEpoch = new Map((archive.markets[id] || []).map(c => [Number(c.epoch), c]));
    for (const c of incoming) {
      const values = [c.epoch, c.open, c.high, c.low, c.close].map(Number);
      if (values.every(Number.isFinite) && values[2] >= values[3]) {
        byEpoch.set(values[0], { epoch: values[0], open: values[1], high: values[2], low: values[3], close: values[4] });
      }
    }
    archive.markets[id] = [...byEpoch.values()].sort((a,b) => a.epoch-b.epoch).slice(-MAX_CANDLES_PER_MARKET);
  }
  archive.updatedAt = new Date().toISOString();
  return archive;
}
function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2/(period+1);
  let e = values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period-1] = e;
  for(let i=period;i<values.length;i++){e=values[i]*k+e*(1-k);out[i]=e;}
  return out;
}
function rsiSeries(values, period=14) {
  const out=Array(values.length).fill(null); if(values.length<=period)return out;
  let g=0,l=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
  g/=period;l/=period;
  const val=()=>l===0?(g===0?50:100):100-100/(1+g/l);
  out[period]=val();
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];g=(g*(period-1)+Math.max(d,0))/period;l=(l*(period-1)+Math.max(-d,0))/period;out[i]=val();}
  return out;
}
function atrSeries(cs, period=14) {
  const out=Array(cs.length).fill(null); if(cs.length<=period)return out;
  const tr=[];
  for(let i=1;i<cs.length;i++){const c=cs[i],p=cs[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}
  let a=tr.slice(0,period).reduce((x,y)=>x+y,0)/period;out[period]=a;
  for(let i=period+1;i<cs.length;i++){a=(a*(period-1)+tr[i-1])/period;out[i]=a;}
  return out;
}
function buildFeatures(cs) {
  const close=cs.map(c=>c.close), e20=emaSeries(close,20), e50=emaSeries(close,50), rsi=rsiSeries(close), atr=atrSeries(cs);
  return cs.map((c,i)=>{
    if(i<64||!(atr[i]>0)||!Number.isFinite(e20[i])||!Number.isFinite(e50[i])||!Number.isFinite(e50[i-5])||!Number.isFinite(rsi[i]))return null;
    const a=atr[i],range=c.high-c.low,up=e20[i]>e50[i],d=up?1:-1;
    const body=range>0?Math.abs(c.close-c.open)/range:0;
    const loc=range>0?(up?(c.close-c.low)/range:(c.high-c.close)/range):0;
    return {direction:up?"BUY":"SELL",sep:Math.abs(e20[i]-e50[i])/a,slope:d*(e50[i]-e50[i-5])/a,
      rsi:rsi[i],body,loc,extension:Math.abs(c.close-e20[i])/a,rangeAtr:range/a,
      directionalCandle:up?c.close>c.open:c.close<c.open,atr:a};
  });
}
function configs() {
  const out=[];
  for(const sep of [0.2,0.4,0.7])for(const slope of [0,0.1,0.25])
  for(const rsiMin of [50,55,60])for(const bodyMin of [0.35,0.5])
  for(const maxExtension of [1,1.5,2]) {
    out.push({minSeparationAtr:sep,minSlopeAtr:slope,minDirectionalRsi:rsiMin,minBodyRatio:bodyMin,maxExtensionAtr:maxExtension,maxRangeAtr:2.5});
  }
  return out.map((x,i)=>({...x,id:"RULE_"+String(i+1).padStart(3,"0")}));
}
function passes(f,cfg) {
  if(!f||!f.directionalCandle||f.sep<cfg.minSeparationAtr||f.slope<cfg.minSlopeAtr||
    f.body<cfg.minBodyRatio||f.extension>cfg.maxExtensionAtr||f.rangeAtr>cfg.maxRangeAtr)return false;
  return f.direction==="BUY" ? f.rsi>=cfg.minDirectionalRsi&&f.rsi<=72 : f.rsi<=100-cfg.minDirectionalRsi&&f.rsi>=28;
}
function outcome(cs, features, entryIndex, maxIndex = cs.length-1) {
  const f=features[entryIndex], next=cs[entryIndex+1];
  if(!f||!next||!(f.atr>0))return null;
  const direction=f.direction, entry=next.open, risk=f.atr*STOP_ATR;
  if(!(risk>0))return null;
  const stop=direction==="BUY"?entry-risk:entry+risk, tp1=direction==="BUY"?entry+2*risk:entry-2*risk, tp2=direction==="BUY"?entry+3*risk:entry-3*risk;
  const end=Math.min(cs.length-1,maxIndex,entryIndex+HORIZON);
  let tp1Hit=false;
  for(let i=entryIndex+1;i<=end;i++){
    const c=cs[i], sl=direction==="BUY"?c.low<=stop:c.high>=stop, one=direction==="BUY"?c.high>=tp1:c.low<=tp1, two=direction==="BUY"?c.high>=tp2:c.low<=tp2;
    if(sl&&(one||two))return {status:"ambiguous",tp1Hit:tp1Hit||one||two,realizedR:null};
    if(sl)return {status:tp1Hit?"stopped_after_tp1":"stopped",tp1Hit,realizedR:tp1Hit?null:-1};
    if(one)tp1Hit=true;
    if(two)return {status:"tp2_hit",tp1Hit:true,realizedR:3};
  }
  if(end-entryIndex<HORIZON)return null;
  return {status:"expired",tp1Hit,realizedR:null};
}
function scoreConfig(cs,features,cfg,start,end) {
  const trades=[];let last=-Infinity;
  for(let i=Math.max(64,start);i<Math.min(end,cs.length-1);i++){
    if(i-last<4||!passes(features[i],cfg))continue;
    const result=outcome(cs,features,i,Math.min(cs.length-1,end===cs.length-1?cs.length-1:end-1));if(!result)continue;
    trades.push({epoch:cs[i].epoch,...result});last=i;
  }
  const resolved=trades.filter(t=>["tp2_hit","stopped","stopped_after_tp1","ambiguous","expired"].includes(t.status));
  const tp1=trades.filter(t=>t.tp1Hit).length, tp2=trades.filter(t=>t.status==="tp2_hit").length, stoppedAfterTp1=trades.filter(t=>t.status==="stopped_after_tp1").length;
  const stops=trades.filter(t=>t.status==="stopped"||t.status==="stopped_after_tp1").length;
  const fullStops=trades.filter(t=>t.status==="stopped").length;
  const ambiguous=trades.filter(t=>t.status==="ambiguous").length;
  const wins=trades.filter(t=>t.tp1Hit&&t.status!=="stopped_after_tp1"&&t.status!=="ambiguous").length;
  const realized=trades.map(t=>t.realizedR).filter(Number.isFinite);
  return {signals:trades.length,resolved:resolved.length,tp1Hits:tp1,tp2Hits:tp2,fullStops,stoppedAfterTp1,anyStops:stops,ambiguous,
    expired:trades.filter(t=>t.status==="expired").length,
    winRate:resolved.length?Number((wins/resolved.length*100).toFixed(1)):null,
    tp1Rate:resolved.length?Number((tp1/resolved.length*100).toFixed(1)):null,
    tp2Rate:resolved.length?Number((tp2/resolved.length*100).toFixed(1)):null,
    stopRate:resolved.length?Number((fullStops/resolved.length*100).toFixed(1)):null,
    anyStopRate:resolved.length?Number((stops/resolved.length*100).toFixed(1)):null,
    averageRealizedR:realized.length?Number((realized.reduce((a,b)=>a+b,0)/realized.length).toFixed(2)):null,
    realizedRCount:realized.length};
}
function splitSegments(cs) {
  const parts=[];let start=0;
  for(let i=1;i<cs.length;i++)if(cs[i].epoch-cs[i-1].epoch!==TIMEFRAME){if(i-start>=100)parts.push(cs.slice(start,i));start=i;}
  if(cs.length-start>=100)parts.push(cs.slice(start));
  return parts;
}
function researchMarket(candles) {
  const segments=splitSegments(candles||[]), qualifiedSegments=segments.filter(cs=>cs.length>=MIN_RESEARCH_BARS), configsList=configs(), results=[];
  for(const cs of qualifiedSegments){
    const features=buildFeatures(cs), split=Math.floor(cs.length*0.50);
    for(const cfg of configsList){
      const train=scoreConfig(cs,features,cfg,64,split);
      const validation=scoreConfig(cs,features,cfg,split,cs.length-1);
      results.push({config:cfg,train,validation,marketBars:cs.length,splitEpoch:cs[split]?.epoch||null});
    }
  }
  const aggregate=new Map();
  for(const row of results){
    const id=row.config.id;const a=aggregate.get(id)||{config:row.config,train:{signals:0,resolved:0,tp1Hits:0,tp2Hits:0,fullStops:0,stoppedAfterTp1:0,anyStops:0,ambiguous:0,expired:0},validation:{signals:0,resolved:0,tp1Hits:0,tp2Hits:0,fullStops:0,stoppedAfterTp1:0,anyStops:0,ambiguous:0,expired:0}};
    for(const phase of ["train","validation"])for(const k of Object.keys(a[phase]))a[phase][k]+=row[phase][k]||0;
    aggregate.set(id,a);
  }
  const summarize=x=>{const n=x.resolved;return {...x,winRate:n?Number((Math.max(0,x.tp1Hits-x.stoppedAfterTp1-x.ambiguous)/n*100).toFixed(1)):null,tp1Rate:n?Number((x.tp1Hits/n*100).toFixed(1)):null,tp2Rate:n?Number((x.tp2Hits/n*100).toFixed(1)):null,stopRate:n?Number((x.fullStops/n*100).toFixed(1)):null,anyStopRate:n?Number((x.anyStops/n*100).toFixed(1)):null};};
  const ranked=[...aggregate.values()].map(x=>({...x,train:summarize(x.train),validation:summarize(x.validation)}));
  ranked.sort((a,b)=>(b.train.tp2Hits-b.train.fullStops)-(a.train.tp2Hits-a.train.fullStops)||b.train.resolved-a.train.resolved);
  const usable=ranked.filter(x=>x.train.resolved>=15);
  const topValidation=usable.filter(x=>x.validation.resolved>=10).slice(0,20).sort((a,b)=>(b.validation.tp2Hits-b.validation.fullStops)-(a.validation.tp2Hits-a.validation.fullStops)||b.validation.resolved-a.validation.resolved).slice(0,10);
  return {bars:candles?.length||0,continuousSegments:segments.length,qualifiedSegments:qualifiedSegments.length,minimumBarsRequired:MIN_RESEARCH_BARS,configsTested:configsList.length,
    status:qualifiedSegments.length?"research_complete":"collecting_history",
    discoveryTop:usable.slice(0,10),validationOfDiscovery:topValidation,allCandidates:ranked,
    note:"Only continuous segments with at least 400 M15 candles are evaluated. Discovery uses the first 50%; the later 50% is held out for validation. Entry is next candle open. Shared exits: 1.5 ATR stop, TP1=2R, TP2=3R, 96-candle horizon. Same-candle stop/target touches are ambiguous. A candidate is shown in validation only after at least 10 resolved validation signals. Expired trades are reported, not counted as wins or losses. This is exploratory research, not a live strategy."};
}
function researchArchive(archive) {
  const markets={};for(const [id,cs] of Object.entries(archive?.markets||{}))markets[id]=researchMarket(cs);
  const pooled=new Map();
  for(const [marketId,report] of Object.entries(markets))for(const candidate of report.allCandidates||[]){
    const id=candidate.config.id;
    const row=pooled.get(id)||{config:candidate.config,marketsSeen:0,train:{signals:0,resolved:0,tp1Hits:0,tp2Hits:0,fullStops:0,stoppedAfterTp1:0,anyStops:0,ambiguous:0,expired:0},validation:{signals:0,resolved:0,tp1Hits:0,tp2Hits:0,fullStops:0,stoppedAfterTp1:0,anyStops:0,ambiguous:0,expired:0}};
    if(candidate.train.resolved>0)row.marketsSeen++;
    for(const phase of ["train","validation"])for(const key of Object.keys(row[phase]))row[phase][key]+=candidate[phase][key]||0;
    pooled.set(id,row);
  }
  const summarize=x=>{const n=x.resolved;return {...x,winRate:n?Number((Math.max(0,x.tp1Hits-x.stoppedAfterTp1-x.ambiguous)/n*100).toFixed(1)):null,tp1Rate:n?Number((x.tp1Hits/n*100).toFixed(1)):null,tp2Rate:n?Number((x.tp2Hits/n*100).toFixed(1)):null,stopRate:n?Number((x.fullStops/n*100).toFixed(1)):null,anyStopRate:n?Number((x.anyStops/n*100).toFixed(1)):null};};
  const pooledCandidates=[...pooled.values()].map(x=>({...x,train:summarize(x.train),validation:summarize(x.validation)}));
  const discovery=pooledCandidates.filter(x=>x.train.resolved>=30&&x.marketsSeen>=3).sort((a,b)=>(b.train.tp1Hits-b.train.stoppedAfterTp1-b.train.fullStops)-(a.train.tp1Hits-a.train.stoppedAfterTp1-a.train.fullStops)||b.train.resolved-a.train.resolved).slice(0,15);
  const validation=discovery.filter(x=>x.validation.resolved>=15).sort((a,b)=>(b.validation.tp1Hits-b.validation.stoppedAfterTp1-b.validation.fullStops)-(a.validation.tp1Hits-a.validation.stoppedAfterTp1-a.validation.fullStops)||b.validation.resolved-a.validation.resolved).slice(0,10);
  return {version:1,generatedAt:new Date().toISOString(),mode:"offline_research_only",markets,pooled:{configsTested:pooledCandidates.length,minimumDiscoverySample:30,minimumMarkets:3,discoveryCandidates:discovery,heldOutValidation:validation},
    caution:"Pooled results combine multiple markets and are exploratory. Require adequate independent validation samples and subsequent forward-shadow results before promoting any rule."};
}
module.exports={mergeCandleArchive,buildFeatures,configs,passes,outcome,scoreConfig,researchMarket,researchArchive,MIN_RESEARCH_BARS};
