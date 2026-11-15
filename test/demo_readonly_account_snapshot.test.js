"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseEnvText,
  isDemoOtpUrl,
  validateReadOnlyRequest,
  createDerivDemoReadOnlySnapshot
} = require("../scripts/demo_readonly_account_snapshot");

const DEMO_ID = "DOT91725732";
const DEMO_URL = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=fake-one-time-value";

class FakeWebSocket {
  constructor(url, replies = {}) {
    this.url = url;
    this.replies = replies;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  emit(name, event) {
    for (const callback of this.listeners.get(name) || []) callback(event);
  }
  send(raw) {
    const request = JSON.parse(raw);
    this.sent.push(request);
    const key = Object.keys(request).find(k => k !== "req_id");
    const body = this.replies[key];
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({ req_id: request.req_id, ...(typeof body === "function" ? body(request) : body) })
    }));
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
}

function makeFetch({ url = DEMO_URL, ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (requestUrl, options) => {
    calls.push({ requestUrl, options });
    return { ok, json: async () => ({ data: { url } }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeWebSocketClass({ loginid = DEMO_ID, contracts = [] } = {}) {
  const instances = [];
  class MockWebSocket extends FakeWebSocket {
    constructor(url) {
      super(url, {
        balance: request => ({
          balance: { loginid, balance: 10000, currency: "USD" }
        }),
        portfolio: request => ({ portfolio: { contracts } }),
        proposal_open_contract: request => ({
          proposal_open_contract: {
            contract_id: request.contract_id,
            buy_price: 1,
            bid_price: 1.2,
            profit: 0.2,
            date_start: 1794700000,
            is_valid_to_sell: 1,
            underlying: "R_50",
            contract_type: "CALL"
          }
        })
      });
      instances.push(this);
    }
  }
  MockWebSocket.instances = instances;
  return MockWebSocket;
}

test("parses local env lines without exposing or transforming values", () => {
  assert.deepEqual(parseEnvText("# comment\nDERIV_TOKEN=abc123\nDERIV_ACCOUNT_ID=DOT123\nEMPTY=\n"), {
    DERIV_TOKEN: "abc123",
    DERIV_ACCOUNT_ID: "DOT123",
    EMPTY: ""
  });
});

test("accepts only the exact Deriv demo OTP websocket endpoint", () => {
  assert.equal(isDemoOtpUrl(DEMO_URL), true);
  assert.equal(isDemoOtpUrl("wss://api.derivws.com/trading/v1/options/ws/real?otp=x"), false);
  assert.equal(isDemoOtpUrl("wss://example.com/trading/v1/options/ws/demo?otp=x"), false);
  assert.equal(isDemoOtpUrl("wss://api.derivws.com/trading/v1/options/ws/demo"), false);
});

test("read-only request guard permits balance, portfolio and existing-contract status only", () => {
  assert.equal(validateReadOnlyRequest({ balance: 1 }), true);
  assert.equal(validateReadOnlyRequest({ portfolio: 1 }), true);
  assert.equal(validateReadOnlyRequest({ proposal_open_contract: 1, contract_id: 123 }), true);
  for (const payload of [
    { proposal: 1 },
    { buy: "1", price: 1 },
    { sell: 123, price: 0 },
    { contract_update: 1, contract_id: 123, limit_order: {} },
    { balance: 1, buy: "1" }
  ]) {
    assert.throws(() => validateReadOnlyRequest(payload), /read_only_request_not_allowed/);
  }
});

test("rejects non-demo account IDs before requesting an OTP", async () => {
  const fetchImpl = makeFetch();
  await assert.rejects(
    createDerivDemoReadOnlySnapshot({
      token: "test-token", accountId: "ROT90664456", fetchImpl,
      WebSocketImpl: makeWebSocketClass()
    }),
    /demo_account_id_must_be_a_DOT_id/
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("verifies demo identity and reads balance plus empty portfolio without order requests", async () => {
  const fetchImpl = makeFetch();
  const WebSocketImpl = makeWebSocketClass();
  const snapshot = await createDerivDemoReadOnlySnapshot({
    token: "test-token",
    accountId: DEMO_ID,
    appId: "12345",
    fetchImpl,
    WebSocketImpl,
    now: () => 1794701000000
  });

  assert.equal(snapshot.mode, "demo");
  assert.equal(snapshot.accountId, DEMO_ID);
  assert.equal(snapshot.balance, 10000);
  assert.equal(snapshot.currency, "USD");
  assert.equal(snapshot.openPositions.length, 0);
  assert.equal(snapshot.equityEstimate, 10000);
  assert.deepEqual(snapshot.requestTypes, ["balance", "portfolio"]);
  assert.equal(fetchImpl.calls[0].options.headers["Deriv-App-ID"], "12345");

  const sent = WebSocketImpl.instances[0].sent.map(request => Object.keys(request).filter(k => k !== "req_id"));
  assert.deepEqual(sent, [["balance"], ["portfolio"]]);
  assert.equal(sent.flat().some(key => ["proposal", "buy", "sell", "contract_update"].includes(key)), false);
});

test("reconciles each existing open contract using status-only requests", async () => {
  const fetchImpl = makeFetch();
  const WebSocketImpl = makeWebSocketClass({
    contracts: [{ contract_id: 456, buy_price: 1, date_start: 1794700000 }]
  });
  const snapshot = await createDerivDemoReadOnlySnapshot({
    token: "test-token",
    accountId: DEMO_ID,
    fetchImpl,
    WebSocketImpl
  });

  assert.equal(snapshot.openPositions.length, 1);
  assert.equal(snapshot.openPositions[0].contractId, 456);
  assert.equal(snapshot.openPositions[0].symbol, "R_50");
  assert.equal(snapshot.openPositions[0].isValidToSell, true);
  assert.equal(snapshot.equityEstimate, 10001.2);
  assert.deepEqual(snapshot.requestTypes, ["balance", "portfolio", "proposal_open_contract"]);
  const sent = WebSocketImpl.instances[0].sent.map(request => Object.keys(request).filter(k => k !== "req_id"));
  assert.deepEqual(sent, [["balance"], ["portfolio"], ["proposal_open_contract", "contract_id"]]);
});

test("rejects a mismatched authenticated account identity", async () => {
  await assert.rejects(
    createDerivDemoReadOnlySnapshot({
      token: "test-token",
      accountId: DEMO_ID,
      fetchImpl: makeFetch(),
      WebSocketImpl: makeWebSocketClass({ loginid: "ROT90664456" })
    }),
    /demo_account_identity_mismatch/
  );
});

test("rejects a real-account OTP endpoint even when HTTP succeeds", async () => {
  await assert.rejects(
    createDerivDemoReadOnlySnapshot({
      token: "test-token",
      accountId: DEMO_ID,
      fetchImpl: makeFetch({ url: "wss://api.derivws.com/trading/v1/options/ws/real?otp=fake" }),
      WebSocketImpl: makeWebSocketClass()
    }),
    /demo_otp_request_failed_or_non_demo_url/
  );
});
