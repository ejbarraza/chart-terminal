# chart-terminal

A free, self-hosted TradingView-style charting service. No accounts, no API keys,
no subscriptions.

- **Charts**: candlesticks with TradingView's own open-source Lightweight Charts library
- **Data**: Yahoo Finance via yfinance (1m → 1M timeframes)
- **Indicators**: SMA 20/50, EMA 20, Bollinger Bands, Volume, RSI 14, MACD 12/26/9,
  EMA Clouds (10 EMAs on hl2 with colored fills), Stochastic 14,3,3 (80/20 zones)
- **Options-scanner integration**: side panel tabs — Scan shows the latest
  CSP put candidates (strike, VRP, IV/HV, premium, ann. ROI) and LEAPS calls
  for the current symbol, with an option to draw the put/call strikes as
  dashed lines on the chart; reads `~/workspace/options_scanner/outputs/`
  (`CHART_SCANNER_DIR` to override)
- **Paper-trader integration**: Trades tab lists ledger trades for the symbol
  and marks entries on the chart (▲ buys / ▼ sells); auto-picks the ledger DB
  with the most trades for the symbol (`CHART_PT_DB` to override)
- **Drawing tools**: trend lines, horizontal lines (persisted per symbol/timeframe)
- **Watchlist**: persisted server-side in `watchlist.json`
- **Quote header**: live price + day change, refreshed every 60s

## Run

```bash
./run.sh
# open http://127.0.0.1:5000
```

`run.sh` uses the paper-trader venv (`~/workspace/paper-trader/.venv`), which
already has Flask, yfinance, and requests. Or run directly:

```bash
~/workspace/paper-trader/.venv/bin/python app.py
```

## Data sources

- **Yahoo** (default): free, no key. Intraday (1m–1h) + daily/weekly/monthly.
- **Twelve Data**: select it in the top bar. Set the key once in the app
  (⚙ Settings) and it is stored locally on your machine — `~/.config/chart-terminal/twelvedata.key`
  for the Flask version, the app config dir for the Tauri build — with 0600
  permissions, never echoed back, never committed. A `TWELVEDATA_API_KEY`
  env var still works as a fallback/override.

Free tier: 800 credits/day; each chart load is 1 credit.

## API

- `GET /api/bars?symbol=AAPL&interval=1d` → `{symbol, interval, bars: [{time, open, high, low, close, volume}]}` (time = epoch seconds UTC)
- `GET /api/quote?symbol=AAPL` → `{symbol, price, changePct}`
- `GET /api/watchlist` / `POST /api/watchlist` → `{watchlist: [...]}`

Intervals: `1m 5m 15m 1h 1d 1wk 1mo`.

## Desktop app (Tauri)

`src-tauri/` is a Tauri v2 port of the backend — same commands, same JSON
shapes, no Python needed at runtime. The web UI (`static/`) is shared: it
talks HTTP to Flask in a browser and `invoke()` to Rust inside Tauri.

- Yahoo data goes through Yahoo's chart API directly (no yfinance in Rust).
- Twelve Data key: `TWELVEDATA_API_KEY` env var, or a `twelvedata.key` file in
  the app config dir (`~/Library/Application Support/com.ejbarraza.chart-terminal/` on macOS).
- Watchlist lives in the same config dir as `watchlist.json`.

```bash
cd src-tauri
cargo tauri dev      # needs the Tauri CLI; Flask on :5000 as the dev server
cargo tauri build    # local installer for this machine
```

Releases: push a `v*` tag and `.github/workflows/release.yml` builds the
macOS DMG (ARM64 + x64), Windows NSIS + MSI, and Linux AppImage + deb via
`tauri-action`, as a draft GitHub release. (The repo doesn't exist on GitHub
yet — create it, push, then tag.)

Icon note: `src-tauri/icons/icon.png` is a placeholder drawn for the project.
Run `cargo tauri icon icons/icon.png` once for proper multi-size .icns/.ico
before the first release build.

## Notes

- Drawing tools: click **Trend** then two chart points, or **H-Line** then a price.
  Click a drawing to select it, **Delete** removes it. Esc cancels drawing mode.
- UI preferences (symbol, timeframe, indicators) and drawings persist in the
  browser's localStorage; the watchlist persists in `watchlist.json`.
- Market data is delayed per Yahoo's free feed — fine for research, not for live trading decisions.
