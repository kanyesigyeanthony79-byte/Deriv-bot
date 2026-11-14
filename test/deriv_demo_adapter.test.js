"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DerivDemoAdapter, isDemoUrl } = require("../deriv_demo_adapter");

const NOW = 1_800_000_000_000;
const URL = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=one-time-secret";
function makeConnection(handler) {
  const calls = [];
  return {
    calls,
    close() {},
    async ask(payload) {
      calls.push(payload);
      return handler(payload, calls.length);
    }
  };
}
function baseOptions(connection, overrides = {}) {
  return {
    connection, websocketUrl: URL, accountId: "VRTC123456",
    allowedSymbols: ["R_10", "R_25"], now: () => NOW,
    ...overrides
  };
}
function portfolio() {
  return { portfolio: { contracts: [] } };
}
function balance() {
  return { balance: { balance: 100, currency: "USD", loginid: "VRTC123456" } };
}

test("only accepts Deriv demo WebSocket URLs with an OTP", () => {
  assert.equal(isDemoUrl(URL), true);
  assert.equal(isDemoUrl("wss://api.derivws.com/trading/v1/options/ws/real?otp=x"), false);
  assert.equal(isDemoUrl("wss://evil.example/trading/v1/options/ws/demo?otp=x"), false);
  assert.equal(isDemoUrl("https://api.derivws.com/trading/v1/options/ws/demo?otp=x"), false);
});

test("refuses real endpoint and missing explicit symbol allowlist", () => {
  const c = makeConnection(() => ({}));
  assert.throws(() => new DerivDemoAdapter(baseOptions(c, { websocketUrl: "wss://api.derivws.com/trading/v1/options/ws/real?otp=x" })), /demo_websocket_required/);
  assert.throws(() => new DerivDemoAdapter(baseOptions(c, { allowedSymbols: [] })), /allowlist/);
});

test("reads balance and reconciles an empty portfolio", async () => {
  const c = makeConnection(p => p.balance ? balance() : portfolio());
  const a = new DerivDemoAdapter(baseOptions(c));
  const s = await a.getAccountSnapshot({ dayStartEquity: 100, sessionPeakEquity: 100 });
  assert.equal(s.mode, "demo");
  assert.equal(s.balance, 100);
  assert.equal(s.equity, 100);
  assert.deepEqual(s.openPositions, []);
});

test("uses live contract mark value and reserves original stake in equity/risk", async () => {
  const c = makeConnection(p => {
    if (p.balance) return balance();
    if (p.portfolio) return { portfolio: { contracts: [{ contract_id: 7, buy_price: 0.5, date_start: NOW / 1000 - 30 }] } };
    if (p.proposal_open_contract) return { proposal_open_contract: {
      contract_id: 7, buy_price: 0.5, bid_price: 0.8, profit: 0.3,
      date_start: NOW / 1000 - 30, is_valid_to_sell: 1
    } };
    throw new Error("unexpected request");
  });
  const a = new DerivDemoAdapter(baseOptions(c));
  const s = await a.getAccountSnapshot({ dayStartEquity: 100, sessionPeakEquity: 100 });
  assert.equal(s.equity, 100.8);
  assert.equal(s.openPositions[0].stake, 0.5);
  assert.equal(s.openPositions[0].remainingRisk, 0.5);
  assert.equal(s.openPositions[0].isValidToSell, true);
});

test("fails closed when portfolio reconciliation fails", async () => {
  const c = makeConnection(p => p.balance ? balance() : { error: { message: "denied" } });
  const a = new DerivDemoAdapter(baseOptions(c));
  await assert.rejects(() => a.getAccountSnapshot({ dayStartEquity: 100, sessionPeakEquity: 100 }), /portfolio_request_failed/);
});

test("does not open a contract on a disallowed market or over-sixty-minute duration", async () => {
  const c = makeConnection(() => ({}));
  const a = new DerivDemoAdapter(baseOptions(c));
  assert.equal((await a.openPosition({ symbol: "XAUUSD", contractType: "CALL", duration: 5, dayStartEquity: 100, sessionPeakEquity: 100 })).reason, "symbol_not_allowlisted");
  assert.equal((await a.openPosition({ symbol: "R_10", contractType: "CALL", duration: 61, dayStartEquity: 100, sessionPeakEquity: 100 })).reason, "contract_duration_exceeds_60_minute_ceiling");
  assert.equal(c.calls.length, 0);
});

test("sizes a demo entry from current balance and buys by proposal id", async () => {
  const c = makeConnection(p => {
    if (p.balance) return balance();
    if (p.portfolio) return portfolio();
    if (p.proposal) return { proposal: { id: "proposal-1", ask_price: p.amount } };
    if (p.buy) return { buy: { contract_id: 99, buy_price: p.price, balance_after: 99.5 } };
    throw new Error("unexpected request");
  });
  const a = new DerivDemoAdapter(baseOptions(c));
  const r = await a.openPosition({ symbol: "R_10", contractType: "CALL", duration: 5, dayStartEquity: 100, sessionPeakEquity: 100 });
  assert.equal(r.opened, true);
  assert.equal(r.contractId, 99);
  assert.equal(r.stake, 0.5);
  assert.equal(c.calls.find(x => x.buy).buy, "proposal-1");
});

test("never retries an ambiguous buy acknowledgement", async () => {
  let buys = 0;
  const c = makeConnection(p => {
    if (p.balance) return balance();
    if (p.portfolio) return portfolio();
    if (p.proposal) return { proposal: { id: "proposal-1", ask_price: p.amount } };
    if (p.buy) { buys++; throw new Error("timeout"); }
  });
  const a = new DerivDemoAdapter(baseOptions(c));
  const first = await a.openPosition({ symbol: "R_10", contractType: "CALL", duration: 5, dayStartEquity: 100, sessionPeakEquity: 100 });
  const second = await a.openPosition({ symbol: "R_10", contractType: "CALL", duration: 5, dayStartEquity: 100, sessionPeakEquity: 100 });
  assert.equal(first.reason, "buy_outcome_unknown_manual_reconciliation_required");
  assert.equal(second.reason, "previous_buy_outcome_requires_manual_reconciliation");
  assert.equal(buys, 1);
});

test("sells only eligible contracts and verifies portfolio removal", async () => {
  let open = true;
  const c = makeConnection(p => {
    if (p.proposal_open_contract) return { proposal_open_contract: { contract_id: 7, is_valid_to_sell: 1 } };
    if (p.sell) return { sell: { sold_for: 0.8 } };
    if (p.portfolio) return { portfolio: { contracts: open ? [{ contract_id: 7, buy_price: 0.5, date_start: NOW / 1000 - 30 }] : [] } };
    if (p.balance) return balance();
    throw new Error("unexpected request");
  });
  const originalAsk = c.ask.bind(c);
  c.ask = async p => {
    const result = await originalAsk(p);
    if (p.sell) open = false;
    return result;
  };
  const a = new DerivDemoAdapter(baseOptions(c));
  const r = await a.closeContract(7, "profit_target");
  assert.equal(r.closed, true);
  assert.equal(r.contractId, 7);
});

test("refuses a close when Deriv says the contract is not sellable", async () => {
  const c = makeConnection(p => {
    if (p.proposal_open_contract) return { proposal_open_contract: { contract_id: 7, is_valid_to_sell: 0 } };
    throw new Error("sell must not be called");
  });
  const a = new DerivDemoAdapter(baseOptions(c));
  const r = await a.closeContract(7);
  assert.equal(r.closed, false);
  assert.equal(r.reason, "contract_not_currently_sellable");
  assert.equal(c.calls.some(x => x.sell), false);
});
