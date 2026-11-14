"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { iso, tradeRow, summarizeLedger } = require("../top_down_swing_trade_ledger");

test("ledger rows preserve entry-time context and UTC timestamps", () => {
  const signal = {
    direction:"BUY", entryTimeframe:"M15", entryEpoch:100, decisionEpoch:1000,
    entry:120, stopLoss:110, structuralInvalidation:112, riskDistance:10,
    riskInAtr:1.25, trigger:"M15 confirmed structure break",
    d1Context:"BUY", d1Alignment:"aligned", d1:{state:"structured"},
    h4:{state:"structured",direction:"BUY",pivots:{highs:[],lows:[{price:112,epoch:50,confirmedEpoch:80}]}},
    h1:{state:"structured",direction:"BUY"}
  };
  const row = tradeRow("R_10","M15_REFINED","H4_PIVOT_TRAIL",signal,{
    status:"scored",realisedR:1.2,mfeR:2,maeR:0.4,durationHours:36,
    exitEpoch:130000,exitReason:"structure_trailing_stop"
  });
  assert.equal(row.entryTimeUtc, iso(1000));
  assert.equal(row.exitTimeUtc, iso(130000));
  assert.equal(row.d1Alignment,"aligned");
  assert.equal(row.h4LatestLowPivot.price,112);
  assert.equal(row.realisedR,1.2);
});

test("ledger summary keeps censored and ambiguous trades separate", () => {
  const base = {market:"R_10",variant:"H1_CONTROL",policy:"FIXED_2_5R"};
  const summary = summarizeLedger([
    {...base,status:"scored",realisedR:2,mfeR:2.5,maeR:0.2,durationHours:12,exitReason:"target"},
    {...base,status:"censored"},
    {...base,status:"ambiguous"}
  ]);
  assert.equal(summary.length,1);
  assert.equal(summary[0].candidateCount,3);
  assert.equal(summary[0].scoredCount,1);
  assert.equal(summary[0].censoredCount,1);
  assert.equal(summary[0].ambiguousCount,1);
  assert.equal(summary[0].averageR,2);
  assert.deepEqual(summary[0].exitReasons,{target:1});
});

test("missing timestamps serialize as null rather than invented dates", () => {
  assert.equal(iso(undefined),null);
});
