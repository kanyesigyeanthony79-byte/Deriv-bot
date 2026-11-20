# Signal delivery and demo execution isolation

## Decision

Keep the current hosted signal scanner, signal journal, Telegram relay, schedules, and alert rules independent from the Deriv demo execution service. The signal system remains useful even when the demo account is disconnected, execution is paused, or an order is rejected. Execution must also continue managing already-open demo positions when Telegram is unavailable.

This PR defines and tests the service-isolation contract. It does **not** wire either service into a new production supervisor and does not change the current scanner or Telegram workflow.

## Current repository constraints found during inspection

- `hosted_scanner.js` is explicitly signal-only and posts through the Telegram Worker.
- `bot.js` is a legacy standalone path with a separate `TRADE_ENABLED` switch, fixed-stake settings, and a real-account opt-in. It is **not** an acceptable shortcut or execution service for this project.
- PR #32 contains the isolated demo account/risk adapter; it is draft and not connected to the scanner.
- PR #33 contains the experimental M1/M5/M15 reversal detector; it is draft and not connected to execution.
- Therefore the current production signal system and the new demo execution service are not yet commissioned as a combined system.

## Required target topology

```text
                  Deriv public market data
                           |
                 shared/read-only feed
                    /            \
                   /              \
       SIGNAL SERVICE          EXECUTION SERVICE
       hosted_scanner          demo-only manager
       existing strategy       validated strategy
       signal journal          account snapshot
       Telegram relay          open-position manager
       signal outcomes         risk gates / exits
                   \              /
                    independent logs
                    independent health
```

The signal service must not import the execution adapter, require Deriv account credentials, or wait for execution results before sending an alert. Execution must not depend on Telegram delivery or on the signal process staying alive. Shared market data is optional; if introduced, it must be read-only and its outage handling must not couple the services.

## Event semantics

Keep these as distinct event types in logs and Telegram messages:

- `SIGNAL_NEW`: existing signal system detected a setup.
- `REVERSAL_WATCH` / `REVERSAL_CANDIDATE`: research detector state, clearly labelled experimental until replay validation.
- `EXECUTION_ENTRY_REQUESTED`: demo manager passed all gates and requested an order.
- `EXECUTION_OPEN_CONFIRMED`: broker confirmed an opened demo contract.
- `EXECUTION_EXIT_REQUESTED` / `EXECUTION_EXIT_CONFIRMED`: requested and confirmed close events.
- `EXECUTION_REJECTED` / `EXECUTION_RECONCILIATION_REQUIRED`: rejected or ambiguous actions.

A signal alert is never proof that an order was placed. An entry request is never proof that a contract opened. Telegram delivery failure is never a reason to abandon position management.

## Safety invariants before any demo commissioning

1. Demo-only endpoint and account identity are verified on every new connection; no real-account fallback.
2. Execution process starts in disabled / observe-only mode until explicitly configured for demo.
3. Reconcile broker portfolio before any new entry after startup or reconnect.
4. Never blindly retry an ambiguous buy acknowledgement; reconcile first.
5. Enforce account-aware position risk, combined exposure, daily loss and session drawdown caps; max five open positions and 60-minute holding cap.
6. Gold is excluded from this synthetic-index execution scope.
7. No automatic averaging or adding to losing positions.
8. Signal scanner schedule, Telegram secrets, Telegram routing and journal remain unchanged by execution outages.
9. Independent health checks and logs identify stale market data, stale account snapshots, disconnected execution, and Telegram delivery failures separately.
10. Do not merge or enable execution based only on unit tests. Require authenticated demo-session contract/schema validation, replay evidence, and supervised demo soak testing.

## Integration sequence

1. Keep this contract/test PR isolated from production.
2. Complete review of PR #32 adapter and PR #33 reversal research separately.
3. Build a dedicated demo execution entrypoint that imports only approved demo modules; do not call the legacy `bot.js` trade path.
4. Add an isolated workflow/service with separate secrets and a kill switch; do not add execution credentials to the signal workflow.
5. Add integration tests with a fake broker and fake Telegram relay proving both outage directions, restart reconciliation, ambiguous acknowledgements, and no real endpoint access.
6. Validate against an authenticated demo account without real funds, then supervised soak test.
7. Only after evidence and explicit approval consider production deployment. Keep signal delivery running throughout.

## What this PR proves—and does not prove

The unit tests prove that the proposed supervisor starts both cycles and reports their outcomes independently when either one fails. They do not prove the existing production workflow is already running both services, nor do they prove broker connectivity, trading performance, or that a demo bot is active. Production wiring is intentionally deferred to a separate PR after the demo adapter and execution manager pass their own gates.
