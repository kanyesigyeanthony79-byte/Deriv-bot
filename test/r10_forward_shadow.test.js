"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
  latestContinuousSegment,resolveOutcome,nonOverlappingSetups,
  summarizeTrades,updateR10ForwardShadowJournal
}=require("../r10_forward_shadow");

function candle(epoch,open,high,low,close){return {epoch,open,high,low,close};}

test("uses only the latest continuous completed candle segment",()=>{
  const rows=[candle(0,10,11,9,10),candle(60,10,11,9,10),candle(300,10,11,9,10),candle(360,10,11,9,10)];
  assert.deepEqual(latestContinuousSegment(rows,60).map(x=>x.epoch),[300,360]);
});

test("resolves a clean 2R target and preserves ambiguous OHLC outcomes",()=>{
  const target=resolveOutcome([candle(300,100,111,99,110)],0,"BUY",100,95,3900,300);
  assert.equal(target.status,"target");
  assert.equal(target.r,2);
  const ambiguous=resolveOutcome([candle(300,100,111,94,100)],0,"BUY",100,95,3900,300);
  assert.equal(ambiguous.status,"ambiguous");
});

test("non-overlapping selector reserves the full 75-minute setup and outcome window",()=>{
  const rows=[{setupCloseEpoch:0,id:"a"},{setupCloseEpoch:4500,id:"b"},{setupCloseEpoch:4501,id:"c"},{setupCloseEpoch:9000,id:"d"}];
  assert.deepEqual(nonOverlappingSetups(rows).map(x=>x.id),["a","b","d"]);
});

test("summary keeps pending and missed triggers separate from resolved outcomes",()=>{
  const result=summarizeTrades([{status:"target",r:2},{status:"pending"},{status:"no_trigger"},{status:"wide_risk"}]);
  assert.equal(result.resolved,1);
  assert.equal(result.pending,1);
  assert.equal(result.noTrigger,1);
  assert.equal(result.wideRisk,1);
  assert.equal(result.expectancyR,2);
});

test("first run sets a forward-only cursor and does not backfill historical M15 setups",()=>{
  const m15=Array.from({length:100},(_,i)=>candle(900*i,100+i*.01,101+i*.01,99+i*.01,100.5+i*.01));
  const m5=Array.from({length:100},(_,i)=>candle(300*i,100,101,99,100.5));
  const m1=Array.from({length:100},(_,i)=>candle(60*i,100,101,99,100.5));
  const market={marketId:"R_10",timeframes:{M1:m1,M5:m5,M15:m15}};
  const journal=updateR10ForwardShadowJournal(null,market,100000);
  assert.equal(journal.lastSetupEpoch,m15.at(-1).epoch);
  assert.equal(journal.setups.length,0);
  assert.ok(journal.startedAt);
});
