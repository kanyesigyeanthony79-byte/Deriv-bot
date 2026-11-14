# Demo execution manager — integration foundation

This branch is stacked on the demo-only risk/adapter foundation. It does not modify the production signal scanner, Telegram routing, or legacy `bot.js`.

## Added

- `deriv_demo_connection.js`: requests a short-lived OTP from the specified Deriv account endpoint, rejects anything other than the exact Deriv demo WebSocket host/path, and correlates concurrent WebSocket requests by `req_id`. OTP URLs and bearer tokens are never logged.
- `demo_execution_manager.js`: an injected, testable cycle manager with persistent equity baselines, Uganda-calendar daily reset, session high-water tracking, signal freshness checks, one-entry-per-cycle limit, explicit symbol allowlist, and separate entry/position-management switches.
- `JsonBaselineStore`: atomic local baseline persistence. Corrupt/missing state blocks entries. Initialisation requires a verified demo snapshot with zero open positions, avoiding a restart/reset loophole.
- Additional account identity checks: every authenticated balance response must identify the exact expected demo login ID; contract status responses must match the requested contract ID.
- Dedicated unit-test workflow.

## Default state and restrictions

- `executionEnabled=false` by default.
- `positionManagementEnabled=false` by default.
- Missing or corrupt equity baseline blocks entries.
- Candidate must be marked validated, based on completed candles, have a timestamp no older than 60 seconds, use an allowlisted synthetic symbol, and request no more than 60 minutes.
- Maximum one new entry per cycle.
- The experimental M1/M5/M15 price-action reversal module is explicitly rejected as an execution source until its separate historical replay and review are complete.
- Gold is not in the intended synthetic execution allowlist.
- A rejected or unconfirmed exit blocks new entries until reconciliation.

## What is not yet implemented/approved

- No process runner or scheduled service is installed; this manager is a library requiring a supervised host.
- No live market-data pipeline is connected to the manager.
- No strategy has been approved for automated entries. The current reversal detector remains research-only.
- No profit-harvesting, break-even, trailing, or early-loss thresholds are enabled. Deriv option contracts do not provide a generic stop-loss modification assumption; early exits depend on current sellability. An explicit, separately tested `exitEvaluator` can be injected, but none is configured here.
- No subscription-based contract monitor or reconnection supervisor is commissioned. A caller must schedule cycles and reconcile the complete portfolio after every reconnect.
- The OTP connection, balance identity, equity calculation, proposal schema, buy/sell lifecycle, and sellability must still be validated against an authenticated Deriv demo account and compared with the Deriv UI.

## Baseline setup

After connecting to the verified demo account, call `initializeBaselineFromVerifiedDemo(adapter, store)` once while the account has no open contracts. This stores current equity as the daily starting equity and session peak. The baseline file is sensitive operational state and should be kept out of Git, backed up securely, and never reset to bypass a loss limit.

## Test

```sh
node --test test/account_risk.test.js test/deriv_demo_adapter.test.js test/deriv_demo_connection.test.js test/demo_execution_manager.test.js
```

Passing unit tests do not prove profitability, live API compatibility, or permission to enable automated demo execution. The stacked PR inherits the risk/adapter CI definitions from its base branch so these tests can run on pull-request updates. This PR must remain unmerged and disabled until authenticated demo validation, replay evidence, and supervised soak testing are complete.
