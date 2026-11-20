"use strict";

// Experimental, signal-only multi-timeframe reversal research.
// Inputs must be oldest-to-newest completed OHLC candles. This module never places orders.

const DEFAULTS = Object.freeze({
  minCandles: 20,
  atrPeriod: 14,
  minBodyAtr: 0.08,
  rejectionWickBodyRatio: 2.0,
  maxOppositeWickBodyRatio: 0.8,
  minCloseLocation: 0.65,
  maxCloseLocation: 0.35,
  swingLookback: 3,
  scoreWatch: 40,
  scoreCandidate: 70
});

function validCandles(candles, minimum) {
  return Array.isArray(candles) && candles.length >= minimum &&
    candles.every(c => c && [c.open,c.high,c.low,c.close].every(Number.isFinite) &&
      c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close) &&
      c.high > c.low && c.complete !== false);
}

function trueRange(c, previous) {
  return Math.max(c.high-c.low, Math.abs(c.high-previous.close), Math.abs(c.low-previous.close));
}

function atr(candles, period) {
  if (candles.length < period + 1) return 0;
  let sum=0;
  for(let i=candles.length-period;i<candles.length;i++) sum += trueRange(candles[i],candles[i-1]);
  return sum/period;
}

function candleShape(c, averageRange, cfg) {
  const range=c.high-c.low, body=Math.abs(c.close-c.open);
  const safeBody=Math.max(body, averageRange*0.025);
  const upper=c.high-Math.max(c.open,c.close);
  const lower=Math.min(c.open,c.close)-c.low;
  const location=(c.close-c.low)/range;
  const material=body >= averageRange*cfg.minBodyAtr;
  const bullishPin=material && lower/safeBody >= cfg.rejectionWickBodyRatio &&
    upper/safeBody <= cfg.maxOppositeWickBodyRatio && location >= cfg.minCloseLocation;
  const bearishPin=material && upper/safeBody >= cfg.rejectionWickBodyRatio &&
    lower/safeBody <= cfg.maxOppositeWickBodyRatio && location <= cfg.maxCloseLocation;
  return {range,body,upper,lower,location,bullishPin,bearishPin};
}

function engulfing(previous,current) {
  const prevBear=previous.close < previous.open, prevBull=previous.close > previous.open;
  const curBull=current.close > current.open, curBear=current.close < current.open;
  return {
    bullish: prevBear && curBull && current.open <= previous.close && current.close >= previous.open,
    bearish: prevBull && curBear && current.open >= previous.close && current.close <= previous.open
  };
}

function pivotLow(candles, index, width) {
  const value=candles[index].low;
  for(let i=index-width;i<=index+width;i++) if(i!==index && candles[i].low<=value) return false;
  return true;
}
function pivotHigh(candles, index, width) {
  const value=candles[index].high;
  for(let i=index-width;i<=index+width;i++) if(i!==index && candles[i].high>=value) return false;
  return true;
}
function structure(candles, width) {
  const lows=[], highs=[];
  for(let i=width;i<candles.length-width;i++) {
    if(pivotLow(candles,i,width)) lows.push({index:i,value:candles[i].low});
    if(pivotHigh(candles,i,width)) highs.push({index:i,value:candles[i].high});
  }
  const last=candles[candles.length-1];
  const priorHigh=highs.length ? highs[highs.length-1] : null;
  const priorLow=lows.length ? lows[lows.length-1] : null;
  const previousLow=lows.length>1 ? lows[lows.length-2] : null;
  const previousHigh=highs.length>1 ? highs[highs.length-2] : null;
  return {
    higherLow:!!(priorLow && previousLow && priorLow.value>previousLow.value),
    lowerHigh:!!(priorHigh && previousHigh && priorHigh.value<previousHigh.value),
    breakAbovePriorSwing:!!(priorHigh && last.close>priorHigh.value),
    breakBelowPriorSwing:!!(priorLow && last.close<priorLow.value),
    reclaimedPriorLow:!!(priorLow && last.close>priorLow.value && last.low<priorLow.value),
    rejectedPriorHigh:!!(priorHigh && last.close<priorHigh.value && last.high>priorHigh.value),
    latestSwingHigh:priorHigh?.value ?? null,
    latestSwingLow:priorLow?.value ?? null
  };
}

function analyzeReversal(input, overrides={}) {
  const cfg={...DEFAULTS,...overrides};
  const {m1,m5,m15,market="UNKNOWN"}=input||{};
  const required=cfg.minCandles;
  if(!validCandles(m1,required)||!validCandles(m5,required)||!validCandles(m15,required))
    return {state:"insufficient_data",market,reason:"Need at least 20 valid completed candles on M1, M5 and M15."};

  const a1=atr(m1,cfg.atrPeriod), a5=atr(m5,cfg.atrPeriod), a15=atr(m15,cfg.atrPeriod);
  if(!(a1>0&&a5>0&&a15>0)) return {state:"insufficient_data",market,reason:"ATR unavailable or flat candle series."};

  const c1=m1[m1.length-1], c1p=m1[m1.length-2], c5=m5[m5.length-1], c5p=m5[m5.length-2], c15=m15[m15.length-1];
  const s1=candleShape(c1,a1,cfg), s5=candleShape(c5,a5,cfg), e1=engulfing(c1p,c1), e5=engulfing(c5p,c5);
  const st1=structure(m1,cfg.swingLookback), st5=structure(m5,cfg.swingLookback), st15=structure(m15,cfg.swingLookback);
  const candidates=[
    {direction:"BUY",name:"bullish_pin_bar",ok:s1.bullishPin,points:15,timeframe:"M1"},
    {direction:"SELL",name:"bearish_pin_bar",ok:s1.bearishPin,points:15,timeframe:"M1"},
    {direction:"BUY",name:"bullish_engulfing",ok:e1.bullish,points:15,timeframe:"M1"},
    {direction:"SELL",name:"bearish_engulfing",ok:e1.bearish,points:15,timeframe:"M1"},
    {direction:"BUY",name:"m5_bullish_rejection",ok:s5.bullishPin||e5.bullish,points:15,timeframe:"M5"},
    {direction:"SELL",name:"m5_bearish_rejection",ok:s5.bearishPin||e5.bearish,points:15,timeframe:"M5"},
    {direction:"BUY",name:"m1_higher_low",ok:st1.higherLow,points:10,timeframe:"M1"},
    {direction:"SELL",name:"m1_lower_high",ok:st1.lowerHigh,points:10,timeframe:"M1"},
    {direction:"BUY",name:"m5_break_of_structure",ok:st5.breakAbovePriorSwing,points:20,timeframe:"M5"},
    {direction:"SELL",name:"m5_break_of_structure",ok:st5.breakBelowPriorSwing,points:20,timeframe:"M5"},
    {direction:"BUY",name:"m5_false_break_reclaim",ok:st5.reclaimedPriorLow,points:15,timeframe:"M5"},
    {direction:"SELL",name:"m5_false_break_rejection",ok:st5.rejectedPriorHigh,points:15,timeframe:"M5"},
    {direction:"BUY",name:"m15_higher_low",ok:st15.higherLow,points:10,timeframe:"M15"},
    {direction:"SELL",name:"m15_lower_high",ok:st15.lowerHigh,points:10,timeframe:"M15"}
  ];
  const summaries=["BUY","SELL"].map(direction=>{
    const evidence=candidates.filter(x=>x.direction===direction&&x.ok);
    const points=evidence.reduce((sum,x)=>sum+x.points,0);
    const m5Confirmed=evidence.some(x=>x.timeframe==="M5"&&
      (x.name.includes("break_of_structure")||x.name.includes("rejection")||x.name.includes("false_break")));
    const m15Structure=direction==="BUY"?st15.higherLow:st15.lowerHigh;
    const score=Math.min(100,points);
    const state=score>=cfg.scoreCandidate&&m5Confirmed?"candidate":
      score>=cfg.scoreWatch?"watch":"none";
    return {direction,score,state,m5Confirmed,m15Structure,evidence:evidence.map(({name,timeframe,points})=>({name,timeframe,points}))};
  });
  const ranked=summaries.sort((a,b)=>b.score-a.score);
  const best=ranked[0], opposing=ranked[1];
  const conflict=best.score===opposing.score&&best.score>0;
  return {
    state:conflict?"conflict":best.state,
    market,
    direction:conflict?null:best.direction,
    score:best.score,
    reason:conflict?"Conflicting BUY and SELL evidence; no direction selected.":
      best.state==="candidate"?"M5 confirmation plus multi-timeframe price-action evidence; research candidate only.":
      best.state==="watch"?"Early reversal evidence only; wait for M5 structural confirmation.":
      "No qualifying reversal evidence.",
    candidates:summaries,
    context:{m1Atr:a1,m5Atr:a5,m15Atr:a15,m1:st1,m5:st5,m15:st15,
      lastClosedCandleEpoch:c1.epoch??null},
    executionAllowed:false
  };
}

module.exports={analyzeReversal,DEFAULTS};
