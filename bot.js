"use strict";
// Deriv Signal Assistant bot (Node 22+). Scans 15m candles on 5 markets with the same rules as the app.
// DEFAULT IS SIGNAL-ONLY. It places orders only when TRADE_ENABLED=true, and uses the DEMO account unless you also opt in to real money.
// Fixed stake, no martingale, no loss recovery. Tokens come from environment variables only and are never logged.
const fs = require("fs"), path = require("path");
const { evaluate, DEF } = require("./engine");
try { fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }); } catch (e) {}
const E = process.env, GRAN = 900, PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public";
const MODE = (E.TRADE_MODE || "demo").toLowerCase(), TRADING = E.TRADE_ENABLED === "true";
const STAKE = +E.STAKE || 1, STAKE_CAP = 20, DUR = Math.max(1, Math.round(+E.TRADE_DURATION_CANDLES || 4)), CUR = E.CURRENCY || "USD";
const MAX_TRADES = +E.MAX_TRADES_PER_DAY || 3, MAX_OPEN = +E.MAX_OPEN_TRADES || 2, MAX_LOSS = +E.MAX_DAILY_LOSS || 3 * STAKE, MIN_PAYOUT = +E.MIN_PAYOUT_RATIO || 0.6, MAX_AGE = 120;
const MARKETS = [["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"], ["R_50", "Volatility 50 Index"], ["R_75", "Volatility 75 Index"], ["JD100", "Jump 100 Index"]];
const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim(), nm = s => s.underlying_symbol_name || s.display_name || "", cd = s => s.underlying_symbol || s.symbol || "";

function fatal(m) { console.error("STARTUP REFUSED: " + m); process.exit(1); }
if (!["demo", "real"].includes(MODE)) fatal("TRADE_MODE must be demo or real.");
if (TRADING) {
  if (!E.DERIV_TOKEN || !E.DERIV_ACCOUNT_ID) fatal("TRADE_ENABLED needs DERIV_TOKEN and DERIV_ACCOUNT_ID.");
  if (!(STAKE > 0 && STAKE <= STAKE_CAP)) fatal("STAKE must be above 0 and at most " + STAKE_CAP + ".");
  if (MODE === "real" && (E.I_ACCEPT_REAL_MONEY_RISK !== "yes" || !E.MAX_DAILY_LOSS)) fatal("Real mode needs I_ACCEPT_REAL_MONEY_RISK=yes and an explicit MAX_DAILY_LOSS.");
}

const LOG = path.join(__dirname, "bot.log"), STATE = path.join(__dirname, "bot_state.json");
const log = o => { const l = JSON.stringify({t:new Date().toISOString(), ...o}); console.log(l); try { fs.appendFileSync(LOG, l + "\n"); } catch (e) {} };
let S = {lastSig:{}, day:"", trades:0, startBal:null, balance:null, open:[], mkt:{}};
try { S = {...S, ...JSON.parse(fs.readFileSync(STATE, "utf8"))}; } catch (e) {}
const save = () => { try { fs.writeFileSync(STATE, JSON.stringify(S)); } catch (e) { log({ev:"state_save_failed"}); } };

async function tgSend(text) {
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHAT_ID) return;
  try { const r = await fetch("https://api.telegram.org/bot" + E.TELEGRAM_BOT_TOKEN + "/sendMessage", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({chat_id:E.TELEGRAM_CHAT_ID, text}), signal:AbortSignal.timeout(10000)}); if (!r.ok) log({ev:"telegram_failed", status:r.status}); }
  catch (e) { log({ev:"telegram_failed", msg:"network"}); }
}

const open = url => new Promise((res, rej) => {
  const ws = new WebSocket(url), q = new Map(); let n = 0; const t = setTimeout(() => rej(new Error("connect timeout")), 15000);
  ws.onopen = () => { clearTimeout(t); res({ws, close:() => { try { ws.close(); } catch (e) {} },
    ask:(p, ms = 20000) => new Promise((rs, rj) => { const id = ++n; p.req_id = id; const to = setTimeout(() => { q.delete(id); rj(new Error("request timeout")); }, ms); q.set(id, d => { clearTimeout(to); rs(d); }); ws.send(JSON.stringify(p)); })}); };
  ws.onmessage = ev => { let d; try { d = JSON.parse(ev.data); } catch (e) { return; } const f = d.req_id && q.get(d.req_id); if (f) { q.delete(d.req_id); f(d); } };
  ws.onerror = () => rej(new Error("websocket error"));
  ws.onclose = () => q.forEach(f => f({error:{message:"closed"}}));
});

async function otpUrl() {
  const h = {Authorization:"Bearer " + E.DERIV_TOKEN}; if (E.DERIV_APP_ID) h["Deriv-App-ID"] = E.DERIV_APP_ID;
  const r = await fetch("https://api.derivws.com/trading/v1/options/accounts/" + encodeURIComponent(E.DERIV_ACCOUNT_ID) + "/otp", {method:"POST", headers:h, signal:AbortSignal.timeout(15000)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data || !j.data.url) throw new Error("OTP request failed (HTTP " + r.status + ")");
  return j.data.url; // contains a one-time password: never logged
}

async function trade(id, name, sym, r, now) {
  const day = new Date().toISOString().slice(0, 10);
  if (S.day !== day) Object.assign(S, {day, trades:0, startBal:null});
  S.open = S.open.filter(t => t > now);
  const why = fs.existsSync(path.join(__dirname, "STOP")) ? "STOP file present" : S.trades >= MAX_TRADES ? "daily trade limit" : S.open.length >= MAX_OPEN ? "max open trades"
    : (S.startBal !== null && S.balance !== null && S.startBal - S.balance >= MAX_LOSS) ? "daily loss limit" : (S.mkt[id] || 0) > now ? "this market already has an open trade" : "";
  if (why) return log({ev:"trade_blocked", market:name, why});
  let c, counted = false;
  try {
    const url = await otpUrl();
    if (!url.includes("/ws/" + MODE)) throw new Error("OTP URL is not a " + MODE + " endpoint. Refusing to trade.");
    c = await open(url);
    const base = {amount:STAKE, basis:"stake", contract_type:r.side === "BUY" ? "CALL" : "PUT", currency:CUR, duration:DUR * 15, duration_unit:"m", underlying_symbol:sym};
    const p = await c.ask({proposal:1, ...base});
    if (p.error || !p.proposal) throw new Error("proposal: " + ((p.error && p.error.message) || "no proposal"));
    const ratio = p.proposal.payout / p.proposal.ask_price - 1;
    if (!(ratio >= MIN_PAYOUT)) throw new Error("payout ratio " + ratio.toFixed(2) + " is below minimum " + MIN_PAYOUT);
    if (p.proposal.ask_price > STAKE * 1.001) throw new Error("ask price above stake");
    const exp = now + DUR * GRAN + 60;
    S.trades++; S.open.push(exp); S.mkt[id] = exp; counted = true; save(); // counted BEFORE sending, so an unknown outcome can never cause extra trades
    const b = await c.ask({buy:"1", price:STAKE, parameters:base});
    if (b.error || !b.buy) { S.trades--; S.open.pop(); S.mkt[id] = 0; counted = false; save(); throw new Error("buy: " + ((b.error && b.error.message) || "no receipt")); }
    S.balance = b.buy.balance_after; if (S.startBal === null) S.startBal = b.buy.balance_after + b.buy.buy_price; save();
    log({ev:"trade_placed", mode:MODE, market:name, type:base.contract_type, stake:b.buy.buy_price, contract_id:b.buy.contract_id, balance_after:b.buy.balance_after});
    tgSend("[" + MODE.toUpperCase() + "] Placed " + base.contract_type + " on " + name + ", stake " + b.buy.buy_price + " " + CUR + ", " + DUR * 15 + " min. Fixed stake, no martingale.");
  } catch (e) {
    log({ev:"trade_failed", market:name, msg:e.message, note:counted ? "outcome unknown, counted against limits; check your Deriv account" : ""});
  } finally { if (c) c.close(); }
}

async function onSignal(id, name, sym, r, now) {
  const ep = r.c.epoch, last = S.lastSig[id] || 0;
  if (ep <= last || ep - last < DEF.cooldown * GRAN) return; // duplicate or cooldown, same as the app
  S.lastSig[id] = ep; save();
  const age = now - (ep + GRAN);
  log({ev:"signal", market:name, signal:r.signal, score:r.score, close:r.c.close, age_s:age});
  if (age > MAX_AGE) return log({ev:"skipped", market:name, why:"signal older than " + MAX_AGE + "s"});
  tgSend(r.signal + " signal: " + name + "\n15m close " + r.c.close + ", heuristic score " + r.score + "/100 (not a win probability)\n" + r.pass.map(x => "- " + x).join("\n") + (TRADING ? "" : "\nSignal only. No order placed."));
  if (TRADING) await trade(id, name, sym, r, now);
}

let pub = null, syms = {}, busy = false;
async function resolveSymbols(c) {
  const out = {};
  for (const mode of ["brief", "full"]) {
    const d = await c.ask({active_symbols:mode}), L = d.active_symbols || [];
    MARKETS.forEach(([id, name]) => { if (out[id]) return; const h = L.find(x => norm(nm(x)) === norm(name)) || L.find(x => cd(x) === id); if (h) out[id] = cd(h); });
    if (Object.keys(out).length === MARKETS.length) break;
  }
  MARKETS.forEach(([id, name]) => { if (!out[id]) log({ev:"symbol_not_confirmed", market:name, note:"skipped, not guessed"}); });
  return out;
}
async function cycle() {
  if (busy) return; busy = true;
  try {
    if (!pub || pub.ws.readyState !== 1) { pub = await open(PUBLIC); syms = await resolveSymbols(pub); }
    const t = await pub.ask({time:1}), now = typeof t.time === "number" ? t.time : Math.floor(Date.now() / 1000);
    for (const [id, name] of MARKETS) {
      const sym = syms[id]; if (!sym) continue;
      try {
        const d = await pub.ask({ticks_history:sym, adjust_start_time:1, count:200, end:"latest", granularity:GRAN, style:"candles"});
        if (d.error) throw new Error(d.error.message);
        const cs = (d.candles || []).map(x => ({epoch:+x.epoch, open:+x.open, high:+x.high, low:+x.low, close:+x.close})).filter(x => [x.epoch, x.open, x.high, x.low, x.close].every(isFinite)).sort((a, b) => a.epoch - b.epoch).filter(x => x.epoch + GRAN <= now);
        const r = evaluate(cs);
        if (r.state === "ok" && r.signal !== "NO TRADE") await onSignal(id, name, sym, r, now);
      } catch (e) { log({ev:"scan_error", market:name, msg:e.message}); }
    }
  } catch (e) { log({ev:"cycle_error", msg:e.message}); if (pub) { pub.close(); pub = null; } }
  busy = false;
}
const boundary = () => setTimeout(() => { cycle(); boundary(); }, (GRAN - (Math.floor(Date.now() / 1000) % GRAN)) * 1000 + 3000);
log({ev:"start", trading:TRADING, mode:MODE, stake:STAKE, duration_min:DUR * 15, note:TRADING ? "ORDERS ENABLED (" + MODE + " account)" : "SIGNAL-ONLY, no orders will be placed"});
cycle(); setInterval(cycle, 30000); boundary();
