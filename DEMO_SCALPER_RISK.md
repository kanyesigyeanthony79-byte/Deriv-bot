# Demo account-aware scalper risk policy

This is an isolated, testable risk-policy foundation for a future Deriv demo execution adapter. It does not connect to Deriv, place orders, close contracts, or alter the existing signal scanner.

## Starting policy

- Demo account only.
- Up to five concurrent positions (five is a hard maximum).
- 0.5% of current account equity as the maximum risk budget for one new position.
- 2% of current equity as the maximum combined open-risk budget.
- Pause new entries at 3% daily equity loss.
- Pause new entries at 5% drawdown from the session equity peak.
- Maximum holding time: 60 minutes.
- Maximum stake: 20 account-currency units, subject to the lower account-risk calculation.
- No martingale, loss recovery, or automatic stake increase after a loss.

The percentages are configurable only within hard safety caps: 1% per position, 3% combined open risk, 5% daily loss, 8% drawdown, five positions, and sixty minutes. Defaults remain the starting policy above.

## Required execution-adapter contract

Before calling `assessNewPosition`, an adapter must obtain a fresh authenticated **demo** account snapshot and reconcile all open contracts. Required fields are:

- `mode: "demo"`
- `balance`, `equity`, `currency`
- `dayStartEquity`, `sessionPeakEquity`
- `fetchedAtMs` (local epoch milliseconds when the snapshot was fetched)
- `openPositions` array; each position must have a valid `stake`. A broker-derived `remainingRisk` may be supplied; otherwise the full original stake is reserved.

Missing, stale, mismatched, or unreconciled account/position data must block new entries. Never infer a zero open-position count from a failed portfolio request.

## Profit management and time exit

`positionsPastTimeLimit` identifies contracts at or beyond the configured holding-time ceiling. The execution adapter must then verify contract status and use a supported Deriv early-sell/close operation. If that close cannot be confirmed, it must stop opening new positions, alert the operator, and keep reconciling the contract. A timer or local state alone is not proof that a broker position closed.

Profit harvesting, trailing protection, and target extension are intentionally not implemented in this policy module. They require broker-supported live contract values and verified close/adjust operations; those API behaviours must be integration-tested on demo before enabling them.

## Safety boundary

This PR is not an activation or deployment. It does not change `main`, the production Telegram alert path, or the existing `bot.js` execution behaviour. No real-account trading is enabled.

## Deriv API integration notes (verified against current official docs)

- Obtain the authenticated WebSocket URL from the account OTP endpoint and require the returned URL to identify the demo endpoint before connecting.
- Read `balance` and `portfolio` on the authenticated session. Portfolio is the authoritative list of currently open contracts; never assume no positions when this request fails.
- Track each contract with `proposal_open_contract` (prefer a subscription for timely updates). Reconcile every returned contract ID against the portfolio.
- Before an early close, inspect the contract's `is_valid_to_sell` flag and issue `sell` only when it is true. Treat a confirmed broker response—not a local timer—as proof of closure.
- Use `contract_update` for stop-loss/take-profit changes only when the specific contract type supports the requested update.
- Buy by the proposal ID rather than repeatedly sending `buy: "1"` with parameters. If a buy request times out or its response is lost, query the account statement for the transaction before retrying; otherwise a duplicate position could be created.

These rules are deliberately prerequisites for the next adapter phase. The current PR does not implement or invoke these operations.
