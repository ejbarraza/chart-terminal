#!/usr/bin/env bash
# chart-terminal launcher. Uses the paper-trader venv (has flask + yfinance + requests).
#
# Optional: export TWELVEDATA_API_KEY="your-key" before running to enable the
# Twelve Data source in the UI. The key is never written to disk by this app.
set -e
cd "$(dirname "$0")"
exec ~/workspace/paper-trader/.venv/bin/python app.py
