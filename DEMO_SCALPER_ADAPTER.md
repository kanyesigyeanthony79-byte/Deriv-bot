# Demo execution and position-management adapter

This adapter is isolated from the existing signal scanner. It is designed for an authenticated Deriv demo WebSocket session only.

## Implemented adapter operations

- Rejects non-Deriv, non-WebSocket, real-account, and missing-OTP URLs.
- Reads authenticated account balance and the full open-contract portfolio.
- Reconciles every open contract through `proposal_open_contract`; if any contract cannot be reconciled, it refuses to provide an account snapshot.
- Estimates account equity as available balance plus the current liquidation value (`bid_price`) of each open contract.
- Reserves the full original buy price as remaining worst-case risk until the contract closes.
- Sizes entries through the account-risk policy, uses the account currency, validates an explicit symbol allowlist, and caps contract duration at 60 minutes.
- Requests a proposal and buys using the returned proposal ID.
- Never retries a buy when the acknowledgement is ambiguous; it locks further entries pending manual reconciliation.
- Sells only when the live contract response says `is_valid_to_sell`, then verifies that the contract has disappeared from the portfolio.
- Identifies positions at the 60-minute limit and attempts a verified early sale when the contract is sellable.

## Important boundaries

- This adapter is not wired into `bot.js` or the production scanner yet.
- It does not automatically choose a signal, calculate day-start equity/session peak, or decide when to harvest a profit. The signal engine and lifecycle policy must provide those inputs/decisions.
- The caller must persist daily starting equity and session peak reliably across restarts. Missing values are rejected by the account-risk policy.
- A Deriv contract may not always be sellable. If the API says it cannot be sold, the adapter reports that state; it does not pretend a close happened. New contracts are limited to a maximum duration of 60 minutes, so they should also expire within that ceiling.
- The account equity estimate depends on Deriv's available balance and contract liquidation values; it must be verified against the account UI during the first demo connection.
- Profit trailing, break-even, TP changes, and partial exits are not assumed to be universally supported. These require contract-type-specific verification before enabling.
- No real account, live credential, or production order path is used by this module.

## Required connection

The caller supplies the existing authenticated connection object (`ask(payload)`, `close()`), the exact WebSocket URL returned by the demo OTP endpoint, the expected demo account ID, and an explicit synthetic-symbol allowlist. Never log the OTP URL or token.
