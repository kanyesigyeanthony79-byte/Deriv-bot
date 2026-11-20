"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {MAX_CANDIDATE_WAIT_SECONDS,pairKey,candidateEntry,replaySharedEvents,summarizePairedRows}=require("../exp01_paired_replay");

function bars(n,start=0,step=60,close=100){
  return Array.from({length:n},(_,i)=>({epoch:start+i*step,open:close,high:close+0.1,low:close-0.1,close}));
}
test("pair identity is immutable and includes market, setup epoch and shared direction",()=>{
  assert.equal(pairKey("R_10",1800,"BUY"),"R_10|1800|BUY");
  assert.notEqual(pairKey("R_10",1800,"BUY"),pairKey("R_10",1800,"SELL"));
  assert.notEqual(pairKey("R_10",1800,"BUY"),pairKey("R_25",1800,"BUY"));
});
test("candidate opposite-direction breakout is retained as directional-mismatch no-entry",()=>{
  const m1=bars(40,300);
  const atr=Array(40).fill(1);
  const result=candidateEntry({m1,m5:[],m5Index:0,m1Atr:atr,
    breakout:{direction:-1,boundary:100,atr5:1},setupEpoch:300,direction:"BUY"});
  assert.deepEqual(result,{status:"no_entry",reason:"directional_mismatch",entryEpoch:null,entry:null});
});
test("candidate no-breakout remains an explicit no-entry",()=>{
  const result=candidateEntry({m1:bars(40,300),m5:[],m5Index:0,m1Atr:[],
    breakout:null,setupEpoch:300,direction:"BUY"});
  assert.equal(result.status,"no_entry");
  assert.equal(result.reason,"no_candidate_breakout");
  assert.equal(MAX_CANDIDATE_WAIT_SECONDS,900);
});
test("paired R difference is emitted only for same-key resolved outcomes",()=>{
  const rows=[
    {pairKey:"a",marketId:"R_10",baseline:{outcome:{realizedR:1}},candidate:{outcome:{realizedR:2}}},
    {pairKey:"b",marketId:"R_10",baseline:{outcome:{realizedR:-1}},candidate:{status:"no_entry"}}
  ];
  const s=summarizePairedRows(rows);
  assert.equal(s.sharedEligibleEvents,2);
  assert.equal(s.pairedResolved,1);
  assert.equal(s.meanCandidateMinusBaselineR,1);
  assert.equal(s.pairedClaimStatus,"exploratory_inconclusive_under_50_pairs");
});
test("split-end purges are shared and holdout is never evaluated",()=>{
  const bounds={discovery:{start:0,end:10000},validation:{start:13600,end:30000},holdout:{start:33600,end:50000}};
  const event={pairKey:"R_10|9500|BUY",marketId:"R_10",setupEpoch:9500,direction:"BUY",riskDistance:1,
    baseline:{status:"entry",entryEpoch:9500,entry:100},candidate:{status:"no_entry",reason:"no_candidate_breakout"}};
  const result=replaySharedEvents([event],bars(60,9500),bounds);
  assert.equal(result.counts.discovery.purgedAtSplitEnd,1);
  assert.equal(result.rows.discovery[0].status,"split_purged");
  assert.equal(result.rows.holdout.status,"sealed_not_evaluated");
});
test("overlap skips are distinct from no-entry and are tracked per policy",()=>{
  const bounds={discovery:{start:0,end:200000},validation:{start:203600,end:400000},holdout:{start:403600,end:500000}};
  const make=(epoch,key)=>({pairKey:key,marketId:"R_10",setupEpoch:epoch,direction:"BUY",riskDistance:1,
    baseline:{status:"entry",entryEpoch:epoch,entry:100},candidate:{status:"no_entry",reason:"no_candidate_breakout"}});
  const result=replaySharedEvents([make(60,"a"),make(120,"b")],bars(60,60),bounds);
  assert.equal(result.counts.discovery.overlapSkipped.baseline,1);
  assert.equal(result.rows.discovery[1].baseline.status,"overlap_skipped");
  assert.equal(result.rows.discovery[1].candidate.status,"no_entry");
});
test("incomplete and ambiguous outcomes do not become resolved paired differences",()=>{
  const rows=[
    {marketId:"R_10",baseline:{outcome:{status:"ambiguous",realizedR:null}},candidate:{outcome:{status:"target",realizedR:2}}},
    {marketId:"R_10",baseline:{outcome:{status:"incomplete_data",realizedR:null}},candidate:{outcome:{status:"stopped",realizedR:-1}}}
  ];
  const s=summarizePairedRows(rows);
  assert.equal(s.pairedResolved,0);
  assert.equal(s.meanCandidateMinusBaselineR,null);
  assert.equal(s.pairedDifference95PctIntervalUnclustered,null);
});

test("shared event evaluator receives only M5 setup and already-completed M15 candles",()=>{
  const m1=bars(1200,0,60,100);
  const m5=bars(90,0,300,100);
  const m15=bars(90,0,900,100);
  const seen=[];
  const {buildSharedEvents}=require("../exp01_paired_replay");
  const events=buildSharedEvents({marketId:"R_10",m1,m5,m15,baselineEvaluator:(id,name,category,frames,index)=>{
    const eventClose=frames.M5[index].epoch+300;
    assert.ok(frames.M15.every(c=>c.epoch+900<=eventClose));
    assert.equal(frames.M5.length,index+1);
    seen.push({eventClose,m15Count:frames.M15.length});
    return {state:"signal",direction:"BUY"};
  }});
  assert.ok(events.length>0);
  assert.equal(events.length,new Set(events.map(e=>e.pairKey)).size);
  assert.ok(seen.length>0);
});
