"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EXPECTED_MT5_DEMO_LOGIN, validateMt5DemoAccount } = require("./mt5_demo_readonly_snapshot");
test("accepts configured MT5 CFDs demo account", () => {
  const x = validateMt5DemoAccount({ login: "32478970", account_type: "demo", group: "demo\\svg_financial", currency: "USD", balance: 9995.8 });
  assert.equal(x.accountId, EXPECTED_MT5_DEMO_LOGIN); assert.equal(x.balance, 9995.8);
});
test("rejects former DOT Options account", () => assert.throws(() => validateMt5DemoAccount({ login: "DOT91725732", account_type: "demo", balance: 9995.8 }), /mt5_account_identity_mismatch/));
test("rejects real MT5 account", () => assert.throws(() => validateMt5DemoAccount({ login: "32478970", account_type: "real", group: "real\\svg_financial", balance: 9995.8 }), /mt5_account_is_not_demo/));
test("rejects invalid balance", () => assert.throws(() => validateMt5DemoAccount({ login: "32478970", account_type: "demo", balance: -1 }), /mt5_balance_invalid/));
