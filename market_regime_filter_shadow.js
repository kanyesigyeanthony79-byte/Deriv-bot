"use strict";
// Shadow-only market-regime gate. Never imported by the production signal engine.
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<values.length;i++) value=values[i]*k+value*(1-k);
  return value;
}
function atr(candles, period=14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const tr=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],p=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
  }
  let value=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++) value=(value*(period-1)+tr[i])/period;
  return value;
}
function adx(candles, period=14) {
  if (!Array.isArray(candles) || candles.length < period*2+1) return null;
  const tr=[], plus=[], minus=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],p=candles[i-1];
    const up=c.high-p.high, down=p.low-c.low;
    plus.push(up>down&&up>0?up:0);
    minus.push(down>up&&down>0?down:0);
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
  }
  let sTr=tr.slice(0,period).reduce((a,b)=>a+b,0);
  let sPlus=plus.slice(0,period).reduce((a,b)=>a+b,0);
  let sMinus=minus.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[];
  const add=()=> {
    const pdi=sTr>0?100*sPlus/sTr:0, mdi=sTr>0?100*sMinus/sTr:0;
    dx.push(pdi+mdi>0?100*Math.abs(pdi-mdi)/(pdi+mdi):0);
  };
  add();
  for(let i=period;i<tr.length;i++){
    sTr=sTr-sTr/period+tr[i];
    sPlus=sPlus-sPlus/period+plus[i];
    sMinus=sMinus-sMinus/period+minus[i];
    add();
  }
  if(dx.length<period)return null;
  let value=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<dx.length;i++)value=(value*(period-1)+dx[i])/period;
  return Number.isFinite(value)?value:null;
}
function directionOn(candles) {
  if(!Array.isArray(candles)||candles.length<50)return null;
  const closes=candles.map(c=>c.close),fast=ema(closes,20),slow=ema(closes,50);
  if(fast===null||slow===null||fast===slow)return null;
  return fast>slow?"BUY":"SELL";
}
function evaluateMarketRegime({m15=[],m5=[],direction,entryTimeframe="M5",adxMinimum=22,sidewaysAdx=18,minEmaAtr=0.10}={}) {
  const result={passed:false,adx:null,emaSeparationAtr:null,marketDirection:null,checks:[]};
  const a=adx(m15,14),vol=atr(m15,14),closes=m15.map(c=>c.close);
  const fast=ema(closes,20),slow=ema(closes,50);
  const sep=vol>0&&fast!==null&&slow!==null?Math.abs(fast-slow)/vol:null;
  result.adx=a; result.emaSeparationAtr=sep; result.marketDirection=directionOn(m15);
  const enough=a!==null&&sep!==null&&result.marketDirection!==null;
  result.checks.push({name:"data_quality",passed:enough});
  const trending=enough&&a>=adxMinimum;
  result.checks.push({name:"adx_trend_strength",passed:trending,threshold:adxMinimum});
  const notSideways=enough&&a>=sidewaysAdx&&sep>=minEmaAtr;
  result.checks.push({name:"sideways_market",passed:notSideways,adxFloor:sidewaysAdx,minEmaAtr});
  const m15Aligned=result.marketDirection===direction;
  result.checks.push({name:"m15_direction",passed:m15Aligned});
  let m5Aligned=true;
  if(String(entryTimeframe).toUpperCase()==="M1"){
    const d5=directionOn(m5);m5Aligned=d5===direction;
    result.m5Direction=d5;
    result.checks.push({name:"m5_direction",passed:m5Aligned});
  }
  result.passed=result.checks.every(c=>c.passed);
  result.reason=result.passed?"market_regime_pass":"market_regime_rejected";
  return result;
}
module.exports={adx,atr,directionOn,evaluateMarketRegime};
