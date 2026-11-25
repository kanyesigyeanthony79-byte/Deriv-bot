"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateAtr, updateM15ExpansionForwardShadowJournal, buildExpansionAlert, summarize
} = require("../m15_expansion_forward_shadow");

function candle(epoch, open, high, low, close) {
  return { epoch, open, high, low, close };
}
function flatHistory(count=100) {
  return Array.from({length:count}, (_,i) => candle(i*900,100,101,99,100.2));
}

test("ATR(14) uses the same Wilder smoothing as the historical expansion replay", () => {
  const rows = Array.from({length:20},(_,i)=>candle(i*900,100,102,99,101));
  assert.equal(calculateAtr(rows,14),3);
});

test("first observation establishes a forward cursor without backfilling historical signals", () => {
  const rows = flatHistory();
  const journal = updateM15ExpansionForwardShadowJournal(null, {
    RB100:{marketName:"Range Break 100 Index",timeframes:{M15:rows}},
    RB200:{marketName:"Range Break 200 Index",timeframes:{M15:rows}}
  }, 200000);
  assert.equal(journal.signals.length,0);
  assert.equal(journal.markets.RB100.lastProcessedEpoch,rows.at(-1).epoch);
  assert.equal(journal.markets.RB200.lastProcessedEpoch,rows.at(-1).epoch);
  assert.equal(journal.markets.RB100.startedAt,new Date(200000000).toISOString());
});

test("does not re-evaluate already processed candles", () => {
  const rows = flatHistory();
  const first = updateM15ExpansionForwardShadowJournal(null, {
    RB100:{timeframes:{M15:rows}}, RB200:{timeframes:{M15:rows}}
  }, 200000);
  const again = updateM15ExpansionForwardShadowJournal(first, {
    RB100:{timeframes:{M15:rows}}, RB200:{timeframes:{M15:rows}}
  }, 200300);
  assert.equal(again.markets.RB100.evaluatedCandles,0);
  assert.equal(again.markets.RB100.lastProcessedEpoch,rows.at(-1).epoch);
});

test("builds an explicitly non-live research alert with the backtest's 2R and 3R targets", () => {
  const signal = {
    signalId:"M15EXP-RB100-123", strategyId:"M15_EXPANSION_FORWARD_V1",
    marketId:"RB100", market:"Range Break 100 Index", direction:"BUY",
    status:"PENDING", setupCloseEpoch:900, entryEpoch:900, entry:100, stopLoss:98.5, tp1:103, tp2:104.5
  };
  const alert = buildExpansionAlert(signal, 1800);
  assert.equal(alert.source,"RESEARCH_SHADOW");
  assert.equal(alert.live,false);
  assert.equal(alert.paper,true);
  assert.match(alert.strategyProfile,/SHADOW \/ RESEARCH — NOT LIVE/);
  assert.equal(alert.tp1,103);
  assert.equal(alert.tp2,104.5);
  assert.equal(buildExpansionAlert({...signal, setupCloseEpoch:0, entryEpoch:0},1800),null);
});



test("uses the forming next M15 candle open without counting its incomplete OHLC outcome", () => {
  const rows = flatHistory(100);
  const journal = updateM15ExpansionForwardShadowJournal(null, {
    RB100:{marketName:"Range Break 100 Index",timeframes:{M15:rows}},
    RB200:{marketName:"Range Break 200 Index",timeframes:{M15:rows}}
  }, 200000);
  const setupCloseEpoch = rows.at(-1).epoch+900;
  journal.signals.push({
    signalId:"M15EXP-RB100-FORMING", strategyId:"M15_EXPANSION_FORWARD_V1",
    marketId:"RB100", market:"Range Break 100 Index", direction:"BUY",
    signalEpoch:setupCloseEpoch-900, setupCloseEpoch, setupAtr:1,
    status:"AWAITING_ENTRY", entry:null, entryEpoch:null,
    stopLoss:null, tp1:null, tp2:null, tp1ReachedAt:null,
    outcomeEpoch:null, r:null, barsObserved:0, horizonCandles:96
  });
  const forming = candle(setupCloseEpoch,101,102,100.5,101.5);
  const updated = updateM15ExpansionForwardShadowJournal(journal, {
    RB100:{marketName:"Range Break 100 Index",timeframes:{M15:rows},formingM15:forming},
    RB200:{marketName:"Range Break 200 Index",timeframes:{M15:rows}}
  }, 200300);
  const trade = updated.signals.find(s => s.signalId === "M15EXP-RB100-FORMING");
  assert.equal(trade.status,"PENDING");
  assert.equal(trade.entry,101);
  assert.equal(trade.entryEpoch,setupCloseEpoch);
  assert.equal(trade.barsObserved,0);
  assert.equal(trade.outcomeEpoch,null);
});

test("records TP1 as a milestone and resolves the later TP2 at +3R", () => {
  const rows = flatHistory(70);
  const journal = updateM15ExpansionForwardShadowJournal(null, {
    RB100:{marketName:"Range Break 100 Index",timeframes:{M15:rows}},
    RB200:{marketName:"Range Break 200 Index",timeframes:{M15:rows}}
  }, 200000);
  const state = journal.markets.RB100;
  state.lastProcessedEpoch = rows.at(-2).epoch;
  const entry = rows.at(-2);
  journal.signals.push({
    signalId:"M15EXP-RB100-TEST", strategyId:"M15_EXPANSION_FORWARD_V1",
    marketId:"RB100", market:"Range Break 100 Index", direction:"BUY",
    signalEpoch:entry.epoch-900, setupCloseEpoch:entry.epoch,
    setupAtr:1, status:"PENDING", entry:100, entryEpoch:entry.epoch,
    stopLoss:98.5, tp1:103, tp2:104.5, tp1ReachedAt:null,
    outcomeEpoch:null, r:null, barsObserved:0, horizonCandles:96
  });
  rows[69] = candle(rows[69].epoch,100,105,100,104.5);
  const updated = updateM15ExpansionForwardShadowJournal(journal, {
    RB100:{marketName:"Range Break 100 Index",timeframes:{M15:rows}},
    RB200:{marketName:"Range Break 200 Index",timeframes:{M15:rows}}
  }, 200300);
  const trade = updated.signals.find(s => s.signalId === "M15EXP-RB100-TEST");
  assert.equal(trade.status,"TP2");
  assert.equal(trade.r,3);
  assert.ok(trade.tp1ReachedAt);
});

test("summary keeps unresolved and ambiguous records out of resolved expectancy", () => {
  const result = summarize([
    {status:"TP2",r:3}, {status:"SL",r:-1},
    {status:"AMBIGUOUS"}, {status:"UNRESOLVED"}, {status:"PENDING"}
  ]);
  assert.equal(result.resolved,2);
  assert.equal(result.wins,1);
  assert.equal(result.losses,1);
  assert.equal(result.expectancyR,1);
  assert.equal(result.ambiguous,1);
  assert.equal(result.unresolved,1);
  assert.equal(result.pending,1);
});
