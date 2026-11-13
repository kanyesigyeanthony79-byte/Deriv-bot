
name: Deriv Hosted Scanner

on:
  workflow_dispatch:
  schedule:
    - cron: "*/5 * * * *"

permissions:
  contents: write

concurrency:
  group: deriv-hosted-scanner
  cancel-in-progress: false

jobs:
  scanner:
    runs-on: ubuntu-latest
    timeout-minutes: 4

    steps:
      - name: Download repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install WebSocket library
        run: pip install websocket-client

      - name: Run Deriv scanner
        run: python scanner.py
        env:
          TELEGRAM_WORKER_URL: ${{ secrets.TELEGRAM_WORKER_URL }}
          SIGNAL_API_KEY: ${{ secrets.SIGNAL_API_KEY }}

      - name: Save signal history
        run: |
          git config user.name "Deriv Scanner"
          git config user.email "actions@users.noreply.github.com"
          git add signal_state.json
          if ! git diff --cached --quiet; then
            git commit -m "Update Deriv signal history"
            git push
          fi
