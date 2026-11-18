"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("cloudflare/deriv-telegram-alerts.js", "utf8")
  .replace("export class ExecutionQueue", "class ExecutionQueue")
  .replace("export default {", "module.exports = {");
const captured = [];
const sandbox = {
  module: { exports: {} },
  URL,
  Response,
  fetch: async (url, options) => {
    captured.push({ url, options, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
};
vm.runInNewContext(source, sandbox, { filename: "deriv-telegram-alerts.js" });
const worker = sandbox.module.exports;
const env = {
  SIGNAL_API_KEY: "test-api-key",
  TELEGRAM_BOT_TOKEN: "test-bot-token",
  TELEGRAM_CHAT_ID: "-100123456",
  REVIEW_PAGE_URL: "https://example.github.io/Deriv-bot/signal-review.html"
};
const signal = {
  event: "new_signal", reviewAvailable: true, signalId: "R_25:SCALP-1700000000",
  market: "Volatility 25", direction: "BUY", entry: 100, stopLoss: 95, tp1: 110, tp2: 115
};
async function send(data, overrides = {}) {
  captured.length = 0;
  const request = new Request("https://worker.example/alerts", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": env.SIGNAL_API_KEY },
    body: JSON.stringify(data)
  });
  const response = await worker.fetch(request, { ...env, ...overrides });
  return { response, payload: captured[0]?.payload };
}

test("adds a signal-specific review button to opted-in new signal alerts", async () => {
  const { response, payload } = await send(signal);
  assert.equal(response.status, 200);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].text, "REVIEW SIGNAL STATUS");
  const reviewUrl = new URL(payload.reply_markup.inline_keyboard[0][0].url);
  assert.equal(reviewUrl.origin, "https://example.github.io");
  assert.equal(reviewUrl.searchParams.get("signalId"), signal.signalId);
});

test("does not add review buttons to legacy signals", async () => {
  const { payload } = await send({ ...signal, reviewAvailable: false });
  assert.equal(Object.hasOwn(payload, "reply_markup"), false);
});

test("does not add review buttons when the review URL is not configured", async () => {
  const { payload } = await send(signal, { REVIEW_PAGE_URL: "" });
  assert.equal(Object.hasOwn(payload, "reply_markup"), false);
});

test("does not add review buttons to outcome updates", async () => {
  const { payload } = await send({
    ...signal, event: "outcome", outcome: "TP1_HIT", reviewAvailable: true
  });
  assert.equal(Object.hasOwn(payload, "reply_markup"), false);
});

test("rejects non-HTTPS review page configuration without blocking alert delivery", async () => {
  const { response, payload } = await send(signal, { REVIEW_PAGE_URL: "http://example.com/review" });
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(payload, "reply_markup"), false);
});
