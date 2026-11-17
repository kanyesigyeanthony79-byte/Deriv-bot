import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../workers/deriv-telegram-alerts/worker.js", import.meta.url), "utf8")
  .replace(/\\bexport class /g, "class ")
  .replace(/\\bexport default /g, "const Worker = ");
const api = new Function("Response", "URL", "fetch", source + "\\nreturn { ExecutionQueue, Worker, validateMt5TradeEvent };")(
  Response, URL, globalThis.fetch
);

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(fn) { return fn(this); }
}

function makeEvent(overrides = {}) {
  return {
    event: "position_closed",
    signalId: "R_50-SCALP-1763000000",
    clientId: "MT5-DEMO-01",
    dealTicket: "1001",
    positionId: "2001",
    marketId: "R_50",
    market: "Volatility 50 Index",
    category: "SCALP",
    direction: "BUY",
    targetLeg: "TP1",
    closeReason: "TP",
    entryPrice: 100,
    stopLoss: 98,
    tp1: 103,
    tp2: 106,
    closePrice: 103,
    volume: 0.1,
    realizedProfit: 3.25,
    closeTime: 1763000100,
    accountCurrency: "USD",
    accountMode: "DEMO",
    ...overrides
  };
}

function makeOpenedBasket(overrides = {}) {
  const { positions, ...eventOverrides } = overrides;
  return {
    ...makeEvent({ event: "basket_opened", ...eventOverrides }),
    positions: positions || [
      { positionId: "2001", targetLeg: "TP1", entryPrice: 100.01, volume: 0.1 },
      { positionId: "2002", targetLeg: "TP1", entryPrice: 100.02, volume: 0.1 },
      { positionId: "2003", targetLeg: "TP2", entryPrice: 100.03, volume: 0.1 }
    ]
  };
}

async function post(queue, path, body) {
  const response = await queue.fetch(new Request("https://queue" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }));
  return { response, body: await response.json() };
}

test("accepts only synthetic-market USD demo closure and three-entry basket events", () => {
  assert.equal(api.validateMt5TradeEvent(makeEvent()), null);
  assert.equal(api.validateMt5TradeEvent(makeOpenedBasket()), null);
  assert.match(api.validateMt5TradeEvent(makeOpenedBasket({
    positions: [{ positionId: "1", targetLeg: "TP1", entryPrice: 100, volume: 0.1 }]
  })), /exactly three/);
  assert.match(api.validateMt5TradeEvent(makeEvent({ marketId: "frxXAUUSD" })), /allow-list/);
  assert.match(api.validateMt5TradeEvent(makeEvent({ accountMode: "LIVE" })), /demo-account/);
  assert.match(api.validateMt5TradeEvent(makeEvent({ accountCurrency: "UGX" })), /USD/);
  assert.match(api.validateMt5TradeEvent(makeEvent({ targetLeg: "TP3" })), /targetLeg/);
});

test("TP1 is confirmed only after both TP1 positions close and duplicate deals do not inflate P/L", async () => {
  const queue = new api.ExecutionQueue({ storage: new MemoryStorage() }, {});
  const opened = await post(queue, "/basket-opened", makeOpenedBasket());
  assert.equal(opened.body.trade.status, "OPEN");
  assert.equal(opened.body.trade.closedEntries, 0);
  assert.equal(opened.body.trade.openEntries, 3);
  assert.deepEqual(opened.body.trade.positions.map(p => p.status), ["OPEN", "OPEN", "OPEN"]);

  const duplicateOpen = await post(queue, "/basket-opened", makeOpenedBasket());
  assert.equal(duplicateOpen.body.duplicate, true);

  const first = await post(queue, "/trade-event", makeEvent());
  assert.equal(first.body.trade.closedEntries, 1);
  assert.equal(first.body.trade.status, "PARTIALLY_CLOSED");
  assert.equal(first.body.trade.openEntries, 2);
  assert.deepEqual(first.body.trade.positions.map(p => p.status), ["TP1_HIT", "OPEN", "OPEN"]);
  assert.equal(first.body.notifications.some(n => n.id === "TP1_HIT"), false);

  const secondEvent = makeEvent({ dealTicket: "1002", positionId: "2002", realizedProfit: 3.10 });
  const second = await post(queue, "/trade-event", secondEvent);
  assert.equal(second.body.trade.closedEntries, 2);
  assert.equal(second.body.trade.tp1Complete, true);
  assert.equal(second.body.trade.status, "TP1_HIT_RUNNER_OPEN");
  assert.equal(second.body.trade.realizedProfit, 6.35);
  assert.equal(second.body.notifications.some(n => n.id === "TP1_HIT" && n.status === "pending"), true);

  const duplicate = await post(queue, "/trade-event", secondEvent);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.trade.closedEntries, 2);
  assert.equal(duplicate.body.trade.realizedProfit, 6.35);

  const third = await post(queue, "/trade-event", makeEvent({
    dealTicket: "1003", positionId: "2003", targetLeg: "TP2", closePrice: 106,
    realizedProfit: 6.20
  }));
  assert.equal(third.body.trade.closedEntries, 3);
  assert.equal(third.body.trade.openEntries, 0);
  assert.equal(third.body.trade.status, "CLOSED_TP2");
  assert.equal(third.body.trade.terminalOutcome, "TP2_HIT");
  assert.equal(third.body.trade.realizedProfit, 12.55);
});

test("final stop loss after two confirmed TP1 closures is classified separately", async () => {
  const queue = new api.ExecutionQueue({ storage: new MemoryStorage() }, {});
  const signalId = "R_25-SCALP-1763000001";
  await post(queue, "/basket-opened", makeOpenedBasket({ signalId }));
  await post(queue, "/trade-event", makeEvent({ signalId, dealTicket: "2001", positionId: "2001" }));
  await post(queue, "/trade-event", makeEvent({ signalId, dealTicket: "2002", positionId: "2002" }));
  const final = await post(queue, "/trade-event", makeEvent({
    signalId, dealTicket: "2003", positionId: "2003", targetLeg: "TP2",
    closeReason: "SL", closePrice: 98, realizedProfit: -5.10
  }));
  assert.equal(final.body.trade.status, "SL_AFTER_TP1");
  assert.equal(final.body.trade.terminalOutcome, "SL_AFTER_TP1");
  assert.equal(final.body.trade.allClosed, true);
});

test("authenticated Worker endpoint stores basket and closure events and exposes per-entry ledger", async () => {
  const queue = new api.ExecutionQueue({ storage: new MemoryStorage() }, {});
  const stub = { fetch: (url, init = {}) => queue.fetch(new Request(url, init)) };
  const binding = { idFromName: () => "global-synthetic-signal-queue", get: () => stub };
  const env = { SIGNAL_API_KEY: "secret", EXECUTION_QUEUE: binding };

  const unauthorized = await api.Worker.fetch(new Request("https://worker/mt5/trade-event", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(makeEvent())
  }), env);
  assert.equal(unauthorized.status, 401);

  const opened = await api.Worker.fetch(new Request("https://worker/mt5/basket-opened", {
    method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "secret" },
    body: JSON.stringify(makeOpenedBasket())
  }), env);
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).trade.openEntries, 3);

  const accepted = await api.Worker.fetch(new Request("https://worker/mt5/trade-event", {
    method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "secret" },
    body: JSON.stringify(makeEvent())
  }), env);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).accepted, true);

  const ledger = await api.Worker.fetch(new Request("https://worker/mt5/trades", {
    method: "GET", headers: { "X-API-Key": "secret" }
  }), env);
  const result = await ledger.json();
  assert.equal(ledger.status, 200);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].closedEntries, 1);
  assert.equal(result.trades[0].openEntries, 2);
  assert.deepEqual(result.trades[0].positions.map(p => p.status), ["TP1_HIT", "OPEN", "OPEN"]);
});
