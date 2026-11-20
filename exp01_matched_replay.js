"use strict";
// EXP-01 entry-method common-assumption replay. Offline only; no alerts or orders.
const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("./scanner_data_dir");
const { evaluateCategory, TIMEFRAMES } = require("./multi_timeframe_engine");
const { atrSeries, detectBreakout, findRetestConfirmation } = require("./breakout_retest_shadow");

const DATA_DIR = getDataDir();
const FILE_PREFIX = String(process.env.RESEARCH_FILE_PREFIX || "");
const INPUT = path.join(DATA_DIR, process.env.RESEARCH_MTF_DATA_FILE || (FILE_PREFIX ? FILE_PREFIX + "multi_timeframe_data.json" : "multi_timeframe_data.json"));
const OUTPUT = path.join(DATA_DIR, FILE_PREFIX + "exp01_matched_replay_report.json");
const MARKETS = Object.freeze(["R_10","R_25","R_50","R_75","JD75","JD100","CRASH500","BOOM500"]);
const STOP_ATR_M15 = 1.25;
const TARGET_R = 2;
const HORIZON_SECONDS = 3600;
const EMBARGO_SECONDS = 3600;
const COST_STRESS_R = Object.freeze([0.05,0.10,0.20]);
const PRIMARY_METRIC = "mean_R_after_0.10R_assumed_cost_per_resolved_trade";
const GUARDRAILS = Object.freeze({ minimumResolvedObservations:50, minimumMarketsWithTenResolved:3, maximumAmbiguousRatePct:5, reportDrawdown:true, reportSignalFrequency:true });

function validCandle(c) {
  return c && [c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open,c.close,c.low) && c.low <= Math.min(c.open,c.close);
}
function continuous(rows, seconds) {
  return Array.isArray(rows) && rows.length > 1 && rows.every((c,i) =>
    validCandle(c) && c.epoch % seconds === 0 && (i===0 || c.epoch-rows[i-1].epoch===seconds));
}
function latestContinuousSegment(rows, seconds) {
  if (!Array.isArray(rows) || !rows.length) return [];
  let start=rows.length-1;
  while(start>0 && rows[start].epoch-rows[start-1].epoch===seconds) start--;
  return rows.slice(start);
}
function atr(candles, period=14) {
  if (!Array.isArray(candles) || candles.length<=period) return 0;
  const tr=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}
  let v=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++)v=(v*(period-1)+tr[i])/period;
  return v;
}
function splitBounds(start,end) {
  const span=end-start, discoveryEnd=start+span*0.6, validationEnd=start+span*0.8;
  return {discovery:{start,end:discoveryEnd},validation:{start:discoveryEnd+EMBARGO_SECONDS,end:validationEnd},holdout:{start:validationEnd+EMBARGO_SECONDS,end}};
}
function splitForEpoch(epoch,bounds){return Object.entries(bounds).find(([,b])=>epoch>=b.start&&epoch<b.end)||null;}
function resolveCommonOutcome({m1,entryEpoch,entry,direction,riskDistance}) {
  if(!(riskDistance>0)||!Number.isFinite(entry)||!["BUY","SELL"].includes(direction))return{status:"invalid_risk",realizedR:null,exitEpoch:null};
  const bars=m1.filter(c=>c.epoch>=entryEpoch&&c.epoch<entryEpoch+HORIZON_SECONDS);
  if(!bars.length||bars[0].epoch!==entryEpoch)return{status:"incomplete_data",realizedR:null,exitEpoch:null};
  const stop=direction==="BUY"?entry-riskDistance:entry+riskDistance;
  const target=direction==="BUY"?entry+TARGET_R*riskDistance:entry-TARGET_R*riskDistance;
  for(let i=0;i<bars.length;i++){
    const c=bars[i];
    if(i>0&&c.epoch-bars[i-1].epoch!==TIMEFRAMES.M1)return{status:"data_gap",realizedR:null,exitEpoch:null};
    const sl=direction==="BUY"?c.low<=stop:c.high>=stop, tp=direction==="BUY"?c.high>=target:c.low<=target;
    if(sl&&tp)return{status:"ambiguous",realizedR:null,exitEpoch:c.epoch};
    if(sl)return{status:"stopped",realizedR:-1,exitEpoch:c.epoch};
    if(tp)return{status:"target",realizedR:TARGET_R,exitEpoch:c.epoch};
  }
  if(bars.length!==HORIZON_SECONDS/TIMEFRAMES.M1)return{status:"incomplete_data",realizedR:null,exitEpoch:null};
  const last=bars[bars.length-1], move=direction==="BUY"?last.close-entry:entry-last.close;
  return{status:"time_exit",realizedR:Number((move/riskDistance).toFixed(4)),exitEpoch:last.epoch+TIMEFRAMES.M1};
}
function blankStats(){return{setups:0,eligibleSetups:0,overlapSkipped:0,noEntry:0,purgedAtSplitEnd:0,purgedAfterEntry:0,entries:0,resolved:0,outcomes:{target:0,stopped:0,time_exit:0,ambiguous:0,incomplete_data:0,data_gap:0},totalGrossR:0,meanGrossR:null,meanAfterAssumedCostR:{},maxDrawdownR:0,signalsPerDay:null};}
function summarizeTrades(trades,counts,hours) {
  const s=blankStats();Object.assign(s,counts);s.entries=trades.length;
  for(const t of trades)s.outcomes[t.outcome.status]=(s.outcomes[t.outcome.status]||0)+1;
  const done=trades.filter(t=>Number.isFinite(t.outcome.realizedR)), vals=done.map(t=>t.outcome.realizedR);
  s.resolved=done.length;s.totalGrossR=Number(vals.reduce((a,b)=>a+b,0).toFixed(4));
  s.meanGrossR=vals.length?Number((s.totalGrossR/vals.length).toFixed(4)):null;
  for(const cost of COST_STRESS_R)s.meanAfterAssumedCostR[cost.toFixed(2)]=vals.length?Number((vals.reduce((a,b)=>a+b-cost,0)/vals.length).toFixed(4)):null;
  let equity=0,peak=0,dd=0;for(const v of vals){equity+=v;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
  s.maxDrawdownR=Number(dd.toFixed(4));s.signalsPerDay=hours>0?Number((trades.length/hours*24).toFixed(3)):null;
  return s;
}
function makeMethodSetups({marketId,marketName,m1,m5,m15}) {
  const a1=atrSeries(m1,14),a5=atrSeries(m5,14),baseline=[],candidate=[];
  for(let i=64;i<m5.length-1;i++){
    const c=m5[i],setupEpoch=c.epoch+TIMEFRAMES.M5;
    const riskRows=m15.filter(x=>x.epoch+TIMEFRAMES.M15<=setupEpoch),risk=atr(riskRows,14)*STOP_ATR_M15;
    if(!(risk>0))continue;
    const base=evaluateCategory(marketId,marketName,"SCALP",{M5:m5,M15:m15},i);
    if(base.state==="signal")baseline.push({setupEpoch,direction:base.direction,entryEpoch:m5[i+1].epoch,entry:m5[i+1].open,riskDistance:risk});
    const breakout=detectBreakout(m5,i,a5[i]);
    if(!breakout)continue;
    const start=m1.findIndex(x=>x.epoch===setupEpoch);
    let entryEpoch=null, entryPrice=null;
    if(start>=0){
      const confirmation=findRetestConfirmation(m1,start,breakout,a1);
      const entry=confirmation ? m1[confirmation.entryIndex] : null;
      if(entry){entryEpoch=entry.epoch;entryPrice=entry.open;}
    }
    candidate.push({setupEpoch,direction:breakout.direction===1?"BUY":"SELL",entryEpoch,entry:entryPrice,riskDistance:risk});
  }
  return{baseline,candidate};
}
function replayMethod(setups,m1,bounds,hours) {
  const trades=[],counts=Object.fromEntries(Object.keys(bounds).map(k=>[k,{setups:0,eligibleSetups:0,overlapSkipped:0,noEntry:0,purgedAtSplitEnd:0,purgedAfterEntry:0}]));
  let blockedUntil=null;
  for(const setup of setups){
    const match=splitForEpoch(setup.setupEpoch,bounds);if(!match)continue;
    const [name,range]=match;
    counts[name].setups++;
    if(setup.setupEpoch+HORIZON_SECONDS>range.end){counts[name].purgedAtSplitEnd++;continue;}
    if(Number.isFinite(blockedUntil)&&setup.setupEpoch<blockedUntil){counts[name].overlapSkipped++;continue;}
    counts[name].eligibleSetups++;
    if(!Number.isFinite(setup.entryEpoch)||!Number.isFinite(setup.entry)){counts[name].noEntry++;continue;}
    if(setup.entryEpoch+HORIZON_SECONDS>range.end){counts[name].purgedAfterEntry++;continue;}
    const outcome=resolveCommonOutcome({m1,entryEpoch:setup.entryEpoch,entry:setup.entry,direction:setup.direction,riskDistance:setup.riskDistance});
    trades.push({...setup,outcome});
    blockedUntil=Number.isFinite(outcome.exitEpoch)?outcome.exitEpoch+TIMEFRAMES.M1:setup.entryEpoch+HORIZON_SECONDS;
  }
  const result={};
  for(const k of ["discovery","validation"]){
    result[k]=summarizeTrades(trades.filter(t=>t.setupEpoch>=bounds[k].start&&t.setupEpoch<bounds[k].end),counts[k],(bounds[k].end-bounds[k].start)/3600);
  }
  result.holdout={status:"sealed_not_evaluated",startEpoch:bounds.holdout.start,endEpoch:bounds.holdout.end,reason:"Do not consume the current holdout window: EXP-01 forward-shadow observations already cover this period. Gate D requires a later untouched period after the comparison contract is frozen."};
  return result;
}
function buildExp01MatchedReplayReport(snapshot,generatedAt=new Date().toISOString()) {
  const markets={};
  for(const id of MARKETS){
    const market=snapshot?.markets?.[id],f=market?.timeframes||{};
    const s1=latestContinuousSegment(f.M1||[],60),s5=latestContinuousSegment(f.M5||[],300),s15=latestContinuousSegment(f.M15||[],900);
    if(s1.length<500||s5.length<65||s15.length<65){markets[id]={status:"insufficient_continuous_history",counts:{M1:s1.length,M5:s5.length,M15:s15.length}};continue;}
    const start=Math.max(s1[0].epoch,s5[0].epoch,s15[0].epoch);
    const end=Math.min(s1.at(-1).epoch+60,s5.at(-1).epoch+300,s15.at(-1).epoch+900);
    const m1=s1.filter(c=>c.epoch>=start&&c.epoch+60<=end),m5=s5.filter(c=>c.epoch>=start&&c.epoch+300<=end),m15=s15.filter(c=>c.epoch+900<=end);
    if(!continuous(m1,60)||!continuous(m5,300)||!continuous(m15,900)){markets[id]={status:"noncontinuous_common_window"};continue;}
    const bounds=splitBounds(start,end);
    if(bounds.validation.start>=bounds.validation.end||bounds.holdout.start>=bounds.holdout.end){markets[id]={status:"window_too_short",overlapHours:(end-start)/3600};continue;}
    const sets=makeMethodSetups({marketId:id,marketName:market.marketName||id,m1,m5,m15}),hours=(end-start)/3600;
    markets[id]={status:"replayed",commonWindow:{startEpoch:start,endEpoch:end,hours:Number(hours.toFixed(3))},candleCounts:{M1:m1.length,M5:m5.length,M15:m15.length},setupCandidates:{baseline:sets.baseline.length,exp01:sets.candidate.length},methods:{MTF_BASELINE_SCALP:replayMethod(sets.baseline,m1,bounds,hours),EXP01_COMMON_ENTRY:replayMethod(sets.candidate,m1,bounds,hours)},splitBounds:bounds};
  }
  const pooled={};
  for(const method of ["MTF_BASELINE_SCALP","EXP01_COMMON_ENTRY"]){
    pooled[method]={};
    for(const split of ["discovery","validation"]){
      const rows=Object.values(markets).filter(x=>x.status==="replayed").map(x=>x.methods[method][split]);
      const entries=rows.reduce((a,x)=>a+x.entries,0),resolved=rows.reduce((a,x)=>a+x.resolved,0),gross=rows.reduce((a,x)=>a+x.totalGrossR,0);
      const cost=Object.fromEntries(COST_STRESS_R.map(c=>[c.toFixed(2),resolved?Number((rows.reduce((a,x)=>a+(x.meanAfterAssumedCostR[c.toFixed(2)]??0)*x.resolved,0)/resolved).toFixed(4)):null]));
      const outcomes=rows.reduce((a,x)=>{for(const[k,v]of Object.entries(x.outcomes))a[k]=(a[k]||0)+v;return a;},{});
      const marketsWithTenResolved=rows.filter(x=>x.resolved>=10).length;
      const ambiguousRatePct=entries?Number(((outcomes.ambiguous||0)/entries*100).toFixed(2)):0;
      const sampleSufficient=resolved>=GUARDRAILS.minimumResolvedObservations &&
        marketsWithTenResolved>=GUARDRAILS.minimumMarketsWithTenResolved &&
        ambiguousRatePct<=GUARDRAILS.maximumAmbiguousRatePct;
      pooled[method][split]={
        entries,resolved,totalGrossR:Number(gross.toFixed(4)),
        meanGrossR:resolved?Number((gross/resolved).toFixed(4)):null,
        meanAfterAssumedCostR:cost,outcomes,
        sampleSufficiency:{
          status:sampleSufficient?"sample_sufficient":"insufficient_sample",
          minimumResolvedObservations:GUARDRAILS.minimumResolvedObservations,
          actualResolvedObservations:resolved,
          minimumMarketsWithTenResolved:GUARDRAILS.minimumMarketsWithTenResolved,
          actualMarketsWithTenResolved:marketsWithTenResolved,
          maximumAmbiguousRatePct:GUARDRAILS.maximumAmbiguousRatePct,
          actualAmbiguousRatePct:ambiguousRatePct,
          note:"This is a sample-size/data-quality gate only, not a profitability or strategy-promotion verdict."
        }
      };
    }
  }
  return{version:1,generatedAt,mode:"common_assumption_entry_method_replay",scope:"Common-risk/common-target replay of two distinct signal-generation methods, not an isolated entry-only comparison: the production MTF baseline requires M15 confirmation/context alignment, while the EXP-01 breakout/retest candidate records M15 context but does not use it as a directional filter. EXP-01 original M1-local stop sizing is replaced by the common M15 ATR stop, so this is not a full reproduction of original EXP-01 trade management. The current chronological holdout partition is sealed and not evaluated because the existing forward-shadow journal already covers this period.",assumptions:{baseline:"Production MTF_BASELINE_V1 SCALP evaluated on completed M5 candles with completed M15 confirmation/context; next M5 open entry.",candidate:"Frozen EXP-01 M5 breakout beyond prior 12-bar range, followed by M1 retest confirmation; next M1 open entry. M15 context is recorded but is not a directional eligibility filter, unlike the MTF baseline.",commonRisk:"Both use 1.25 x completed M15 ATR at the M5 setup close.",commonTarget:"Fixed 2R target.",commonHorizon:"60 minutes resolved on completed M1 candles.",ambiguity:"Same-candle stop/target touches are ambiguous.",concurrency:"One open position per method per market; overlapping setups are skipped until prior outcome resolves.",splits:"Per-market chronological 60/20/20; one-hour embargo after discovery and validation boundaries; purge outcomes crossing split end.",costs:"Gross candle R plus hypothetical 0.05R, 0.10R and 0.20R deductions. Not measured broker costs or net returns."},predeclaredDecisionFramework:{primaryMetric:PRIMARY_METRIC,guardrails:GUARDRAILS,costStressR:COST_STRESS_R,note:"Review discovery first. Sample sufficiency requires at least 50 resolved observations, at least three markets with ten resolved observations each, and no more than 5% ambiguous entries. This is not a profitability verdict. Do not tune on validation; preserve the current holdout sealed."},summary:{marketsConsidered:MARKETS.length,marketsReplayed:Object.values(markets).filter(x=>x.status==="replayed").length,marketsWaiting:Object.values(markets).filter(x=>x.status!=="replayed").length,pooled},markets,interpretation:"Research-only comparison of two distinct signal-generation methods under common risk, target, horizon, and cost assumptions. Because their directional eligibility filters differ, results cannot isolate the effect of entry timing alone. The holdout is deliberately not evaluated. Small samples and missing broker cost data prevent profitability or promotion claims."};
}
function main(){
  if(!fs.existsSync(INPUT))throw new Error("multi_timeframe_data.json missing; EXP-01 replay not run.");
  const report=buildExp01MatchedReplayReport(JSON.parse(fs.readFileSync(INPUT,"utf8")));
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({event:"exp01_matched_replay_completed",marketsReplayed:report.summary.marketsReplayed,marketsWaiting:report.summary.marketsWaiting,output:OUTPUT}));
}
if(require.main===module)main();
module.exports={MARKETS,STOP_ATR_M15,TARGET_R,HORIZON_SECONDS,EMBARGO_SECONDS,COST_STRESS_R,PRIMARY_METRIC,GUARDRAILS,validCandle,continuous,latestContinuousSegment,atr,splitBounds,resolveCommonOutcome,summarizeTrades,makeMethodSetups,replayMethod,buildExp01MatchedReplayReport};
