"use strict";
// Signal rules, ported 1:1 from public/index.html (evaluate + helpers) so the bot and the app agree.
// Uses only the candles passed in (oldest to newest, all completed). No future data.
const DEF = {emaF:20, emaS:50, rsiP:14, buyLo:50, buyHi:68, sellLo:32, sellHi:50, minScore:55, minSep:0.2, minBody:0.4, maxExt:1.5, maxRange:3, cooldown:4};
const ema = (v, p) => { const k = 2 / (p + 1); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; };
function rsi(v, p) {
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
  return l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
}
const tr = (cs, i) => Math.max(cs[i].high - cs[i].low, Math.abs(cs[i].high - cs[i - 1].close), Math.abs(cs[i].low - cs[i - 1].close));
function atr(cs, p) { let a = 0; for (let i = 1; i <= p; i++) a += tr(cs, i); a /= p; for (let i = p + 1; i < cs.length; i++) a = (a * (p - 1) + tr(cs, i)) / p; return a; }
const clamp = (x, y) => Math.max(0, Math.min(1, x / y));

function evaluate(cs, C = DEF) {
  if (cs.length < Math.max(60, C.emaS + 15)) return {state:"warming"};
  const c = cs[cs.length - 1], closes = cs.map(x => x.close);
  const e20 = ema(closes, C.emaF), e50 = ema(closes, C.emaS), e50b = ema(closes.slice(0, -5), C.emaS), rv = rsi(closes, C.rsiP), a = atr(cs, 14);
  if (!(a > 0)) return {state:"flat"};
  const side = e20 > e50 ? "BUY" : "SELL", d = side === "BUY" ? 1 : -1, up = d > 0;
  const range = c.high - c.low, bodyR = range > 0 ? Math.abs(c.close - c.open) / range : 0, loc = range > 0 ? (up ? c.close - c.low : c.high - c.close) / range : 0;
  const sep = d * (e20 - e50) / a, slope = d * (e50 - e50b) / a, ext = Math.abs(c.close - e20) / a;
  const rec = cs.slice(-6), pri = cs.slice(-12, -6);
  const swing = (up ? Math.min(...rec.map(x => x.low)) - Math.min(...pri.map(x => x.low)) : Math.max(...pri.map(x => x.high)) - Math.max(...rec.map(x => x.high))) / a;
  const lo = up ? C.buyLo : C.sellLo, hi = up ? C.buyHi : C.sellHi, dirOK = up ? c.close > c.open : c.close < c.open, pc = Math.round(bodyR * 100);
  const FE = "EMA" + C.emaF, SE = "EMA" + C.emaS;
  const G = [
    [sep >= C.minSep, FE + "/" + SE + " trend " + (up ? "up" : "down") + ", gap " + sep.toFixed(2) + " ATR"],
    [d * (c.close - e20) > 0, "Close on the trend side of " + FE],
    [slope > 0, SE + " sloping with the trend"],
    [rv >= lo && rv <= hi, "RSI " + rv.toFixed(1) + " inside " + lo + "-" + hi],
    [dirOK && bodyR >= C.minBody, (up ? "Bullish" : "Bearish") + " candle, body " + pc + "% of range"],
    [swing > 0, up ? "Higher low formed" : "Lower high formed"],
    [ext <= C.maxExt, "Not extended from " + FE + " (" + ext.toFixed(1) + " ATR)"],
    [range <= C.maxRange * a, "No spike candle"]
  ];
  const rsiQ = up ? (rv < lo + 5 ? (rv - lo) / 5 : rv > hi - 3 ? (hi - rv) / 3 : 1) : (rv > hi - 5 ? (hi - rv) / 5 : rv < lo + 3 ? (rv - lo) / 3 : 1);
  const score = Math.round(25 * clamp(sep, 1) + 15 * clamp(slope, 0.5) + 20 * clamp(rsiQ, 1) + 20 * (clamp(bodyR, 0.7) + clamp(loc, 1)) / 2 + 20 * clamp(swing, 0.5));
  const fail = G.filter(g => !g[0]).length;
  return {state:"ok", signal:(!fail && score >= C.minScore) ? side : "NO TRADE", side, score, c, rsi:rv, pass:G.filter(g => g[0]).map(g => g[1])};
}
module.exports = {evaluate, DEF};
