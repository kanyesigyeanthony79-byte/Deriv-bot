# MT5 Synthetic Signal Execution — Demo Setup

## Status

The Telegram Worker now has an authenticated Durable Objects execution queue. The queue is separate from Telegram delivery and is strongly coordinated; it is not backed by Workers KV.

The signal collector change and EA source are on the `mt5-signal-execution` branch. The GitHub Actions execution flag is deliberately `false` until the EA has been compiled and checked on the MT5 demo account.

## Trading rules

- Existing multi-timeframe signal server is the only signal source.
- Three market entries are submitted immediately for each accepted signal.
- Maximum planned basket stop-loss risk: USD 15 total (USD 5 per entry).
- Combined floating basket profit target: USD 30.
- Signal server stop-loss is attached to all three entries; individual take-profit orders are not used.
- The EA closes the basket when its combined floating P/L reaches +USD 30 or -USD 15.
- Only one basket may be open at a time.
- Supported markets: R_10, R_25, R_50, R_75, JD100, CRASH500, BOOM500.
- Gold/XAUUSD and SWING signals are excluded.
- Demo account and USD account currency are mandatory. The EA also requires a hedging account.

## Bridge endpoints

Base URL: `https://deriv-telegram-alerts.kanyesigyeanthony79-451.workers.dev`

- `POST /mt5/ingest`: authenticated signal-server enqueue route.
- `GET /mt5/next?clientId=MT5-DEMO-01`: lease the oldest pending signal.
- `POST /mt5/ack`: acknowledge an accepted or rejected signal.
- `GET /mt5/health`: queue depth health check.

All endpoints require `X-API-Key` using the existing `SIGNAL_API_KEY`. The Telegram bot token, chat ID, review URL and API key bindings were retained during the Worker update.

## MT5 installation and validation

1. Open the `.mq5` file in MetaEditor and compile it. Do not enable trading if compilation reports errors.
2. In MT5, open Tools → Options → Expert Advisors and add the bridge base URL to the allowed WebRequest list.
3. Attach the EA to any chart in the Deriv demo account.
4. Set `InpApiKey` to the same secret value as GitHub `SIGNAL_API_KEY`.
5. Confirm the exact MT5 Market Watch symbol names. If any broker symbol has a suffix or different spelling, update `InpSymbolMap`.
6. Keep `InpEnableTrading=false` for the first connection/health check.
7. Confirm the Experts log reports a successful bridge health check and that the account is USD, demo, and hedging.
8. Only after compilation and those checks, enable the GitHub Actions variable `MT5_EXECUTION_QUEUE_ENABLED=true` and set `InpEnableTrading=true` on the demo EA.

## Safety and execution notes

- If a broker's minimum lot size would make one entry risk more than USD 5 at the signal stop-loss, the EA rejects the signal rather than rounding volume up.
- The three market orders are sent back-to-back in one timer event. MT5/broker execution is not atomic; if an entry fails or is partially filled, the EA attempts to close the entries already opened.
- A server-side stop-loss protects each entry. Slippage can cause realized loss to exceed the planned USD 15; no software can guarantee a hard maximum during gaps or execution failure.
- Basket target/stop monitoring uses open-position profit plus swap. It does not reconstruct already-realized partial-close commissions; all three entries share the same stop level to reduce that case.
- The EA records processed signal IDs locally before submitting orders to reduce duplicate execution after restarts.
- Do not use on a live-money account. The EA refuses non-demo accounts.


## Observation-only reception test (EA observation mode)

- Compile the updated `DerivSignalAssistantV2_SignalBridge.mq5` in MetaEditor before attaching it.
- Keep `InpEnableTrading=false` and `InpObserveOnly=true`. Observation mode polls the queue, validates signal fields and freshness, logs the signal details, and acknowledges it as `observed`. It does not call the order-opening function.
- Deploy the matching Worker source with `MT5_OBSERVATION_ENABLED=true`. This separate switch permits queue ingestion/polling/acknowledgement for observation tests without enabling the execution switch.
- Set the GitHub Actions repository variable `MT5_EXECUTION_QUEUE_ENABLED=true` only for a supervised observation test so eligible MTF signals are placed in the queue. Keep the Worker variable `MT5_EXECUTION_ENABLED` unset/false.
- Confirm Experts logs show `OBSERVATION ONLY: signal received and validated` and that no order/deal appears in the MT5 Trade tab.
- Do not set `InpObserveOnly=false` or enable trading during this phase. Demo-only testing is required before any later execution test; live accounts are not permitted.
