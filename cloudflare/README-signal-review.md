# Telegram Signal Review button configuration

The Worker source in this directory adds an optional inline **REVIEW SIGNAL** button only to multi-timeframe alerts that explicitly send `reviewAvailable: true`.

Before deploying the Worker source, configure this Worker variable:

- `REVIEW_PAGE_URL=https://kanyesigyeanthony79-byte.github.io/Deriv-bot/signal-review.html`

The page reads the public `signal_review_data.json` snapshot published by the multi-timeframe collector. It does not expose or require the signal API key in the browser.

Deploying the Worker is a separate production action. This pull request does not deploy it or change the existing live Worker.
