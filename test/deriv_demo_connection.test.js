"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requestDemoOtp, connectWebSocket } = require("../deriv_demo_connection");

const DEMO_URL = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=ephemeral";

test("requests OTP from the expected account endpoint and never accepts real URL", async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => ({ data: { url: DEMO_URL } }) };
  };
  const url = await requestDemoOtp({ token: "secret", accountId: "VRTC123", appId: "123", fetchImpl });
  assert.equal(url, DEMO_URL);
  assert.match(seen.url, /accounts\/VRTC123\/otp$/);
  assert.equal(seen.options.headers.Authorization, "Bearer secret");
  assert.equal(seen.options.headers["Deriv-App-ID"], "123");
  await assert.rejects(() => requestDemoOtp({
    token: "secret", accountId: "VRTC123",
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { url: "wss://api.derivws.com/trading/v1/options/ws/real?otp=x" } }) })
  }), /non_demo_url/);
});

test("rejects unsuccessful OTP requests without disclosing OTP contents", async () => {
  await assert.rejects(() => requestDemoOtp({
    token: "secret", accountId: "VRTC123",
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: "denied" }) })
  }), /demo_otp_request_failed/);
});

test("correlates concurrent WebSocket replies by request id", async () => {
  class FakeWebSocket {
    constructor() { this.listeners = {}; this.readyState = 0; this.sent = []; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  let ws;
  const connected = connectWebSocket(DEMO_URL, { WebSocketImpl: class extends FakeWebSocket {
    constructor(url) { super(); this.url = url; ws = this; queueMicrotask(() => { this.readyState = 1; this.emit("open"); }); }
  }});
  const connection = await connected;
  const one = connection.ask({ balance: 1 });
  const two = connection.ask({ portfolio: 1 });
  assert.equal(ws.sent.length, 2);
  ws.emit("message", { data: JSON.stringify({ req_id: ws.sent[1].req_id, portfolio: { contracts: [] } }) });
  ws.emit("message", { data: JSON.stringify({ req_id: ws.sent[0].req_id, balance: { balance: 10 } }) });
  assert.deepEqual(await one, { req_id: ws.sent[0].req_id, balance: { balance: 10 } });
  assert.deepEqual(await two, { req_id: ws.sent[1].req_id, portfolio: { contracts: [] } });
  connection.close();
});

test("refuses to open a real endpoint", async () => {
  await assert.rejects(() => connectWebSocket(
    "wss://api.derivws.com/trading/v1/options/ws/real?otp=x",
    { WebSocketImpl: class {} }
  ), /demo_websocket_required/);
});
