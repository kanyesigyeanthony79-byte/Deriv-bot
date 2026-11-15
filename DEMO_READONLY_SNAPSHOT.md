# Read-only authenticated demo account snapshot

This script is the next commissioning gate after the initial demo balance check. It verifies that the authenticated WebSocket session identifies the exact expected demo account and that the account's open-contract portfolio can be read and reconciled.

## Run locally

Use Node.js 22 or newer. Keep .env local and git-ignored.

\`\`\`sh
node scripts/demo_readonly_account_snapshot.js
\`\`\`

Required .env values:

\`\`\`text
DERIV_TOKEN=your_private_token
DERIV_ACCOUNT_ID=DOT_your_demo_account_id
DERIV_APP_ID=your_registered_pat_app_id
\`\`\`

The account ID must be the demo ID returned by Deriv's account list (for the current test account, DOT91725732). Never commit or share the token.

## Strict request allowlist

The script can send only:

- balance
- portfolio
- proposal_open_contract for an already-open contract returned by the portfolio

It rejects every other request shape. In particular, it has no proposal, buy, sell, or contract_update operation. It does not send Telegram messages or modify account state.

The script also:

- requires a DOT... demo account ID;
- requests a one-time WebSocket URL and accepts only the exact Deriv demo endpoint;
- verifies the authenticated balance.loginid matches the expected demo account;
- reconciles each existing portfolio contract by contract ID;
- reports balance, estimated equity, open-contract count and sellability;
- never prints the bearer token or one-time WebSocket URL.

## What success means

A successful result proves only that the account can be authenticated and its current balance/portfolio can be read. It does not validate a strategy, simulate entries/exits, or enable order execution.

The token created for this project has the Trade permission selected. Treat it as capable of authorising trades if used by other code. Keep it private. This script itself enforces its own read-only request allowlist and never sends a trade request. Keep TRADE_ENABLED=false.

The next stage is a separate shadow-mode strategy observer. It must log hypothetical signals and management recommendations without invoking any execution adapter. No demo orders or live orders are part of this stage.
