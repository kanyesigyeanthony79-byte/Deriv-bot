"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {splitBounds,resolveCommonOutcome,summarizeTrades,replayMethod,buildExp01MatchedReplayReport,COST_STRESS_R,PRIMARY_METRIC}=require("../exp01_matched_replay");
function bars(n,start=0,close=100){return Array.from({length:n},(_,i)=>({epoch:start+i*60,open:close,high:close+0.1,low:close-0.1,close}));}
test("primary metric and hypothetical cost sensitivities are predeclared",()=>{assert.equal(PRIMARY_METRIC,"mean_R_after_0.10R_assumed_cost_per_resolved_trade");assert.deepEqual(COST_STRESS_R,[0.05,0.10,0.20]);});
test("chronological splits preserve one-hour embargoes",()=>{const b=splitBounds(0,100000);assert.equal(b.validation.start,b.discovery.end+3600);assert.equal(b.holdout.start,b.validation.end+3600);});
test("common stop/2R outcomes and same-candle ambiguity are conservative",()=>{const t=bars(60);t[0]={epoch:0,open:100,high:102.1,low:99.9,close:102};assert.deepEqual(resolveCommonOutcome({m1:t,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1}),{status:"target",realizedR:2,exitEpoch:0});const s=bars(60);s[0]={epoch:0,open:100,high:100.1,low:98.9,close:99};assert.equal(resolveCommonOutcome({m1:s,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1}).realizedR,-1);const a=bars(60);a[0]={epoch:0,open:100,high:102.1,low:98.9,close:100};assert.equal(resolveCommonOutcome({m1:a,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1}).status,"ambiguous");});
test("missing candles, gaps and incomplete horizons are not losses",()=>{assert.equal(resolveCommonOutcome({m1:bars(60,60),entryEpoch:0,entry:100,direction:"BUY",riskDistance:1}).status,"incomplete_data");const g=bars(60);g[10].epoch+=60;assert.equal(resolveCommonOutcome({m1:g,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1}).status,"data_gap");assert.equal(resolveCommonOutcome({m1:bars(30),entryEpoch:0,entry:100,direction:"BUY",riskDistance:1}).status,"incomplete_data");});
test("time exit uses last completed M1 close and cost deductions remain hypothetical",()=>{const x=bars(60);x[59]={epoch:3540,open:100,high:101.2,low:99.9,close:101};assert.equal(resolveCommonOutcome({m1:x,entryEpoch:0,entry:100,direction:"BUY",riskDistance:1}).realizedR,1);const s=summarizeTrades([{outcome:{status:"target",realizedR:2}},{outcome:{status:"stopped",realizedR:-1}}],{setups:2,eligibleSetups:2,overlapSkipped:0,noEntry:0,purgedAfterEntry:0},2);assert.equal(s.meanGrossR,0.5);assert.equal(s.meanAfterAssumedCostR["0.10"],0.4);});

test("unconfirmed EXP-01 breakouts are counted as no-entry setups and holdout stays sealed",()=>{
  const bounds={discovery:{start:0,end:100000},validation:{start:103600,end:200000},holdout:{start:203600,end:300000}};
  const result=replayMethod([{setupEpoch:60,direction:"BUY",entryEpoch:null,entry:null,riskDistance:1}],bars(60),bounds,80);
  assert.equal(result.discovery.setups,1);
  assert.equal(result.discovery.eligibleSetups,1);
  assert.equal(result.discovery.noEntry,1);
  assert.equal(result.discovery.entries,0);
  assert.equal(result.holdout.status,"sealed_not_evaluated");
});

test("real-data report labels undersized discovery samples and seals holdout",()=>{
  const start=1_700_000_100;
  const make=(n,step)=>Array.from({length:n},(_,i)=>({
    epoch:start+i*step,open:100,high:101,low:99,close:100
  }));
  const snapshot={markets:{R_10:{marketName:"Volatility 10 Index",timeframes:{
    M1:make(1200,60),M5:make(240,300),M15:make(80,900)
  }}}};
  const report=buildExp01MatchedReplayReport(snapshot,"2026-11-20T00:00:00.000Z");
  assert.equal(report.summary.marketsReplayed,1);
  assert.equal(report.summary.marketsWaiting,7);
  assert.equal(report.markets.R_10.methods.MTF_BASELINE_SCALP.holdout.status,"sealed_not_evaluated");
  assert.equal(report.markets.R_10.methods.EXP01_COMMON_ENTRY.holdout.status,"sealed_not_evaluated");
  assert.equal(report.summary.pooled.MTF_BASELINE_SCALP.discovery.sampleSufficiency.status,"insufficient_sample");
  assert.equal(report.summary.pooled.EXP01_COMMON_ENTRY.discovery.sampleSufficiency.status,"insufficient_sample");
  assert.equal(report.summary.pooled.EXP01_COMMON_ENTRY.discovery.sampleSufficiency.minimumResolvedObservations,50);
});
