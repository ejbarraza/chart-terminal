#!/usr/bin/env python3
"""chart-terminal: a free, self-hosted TradingView-style charting service.

Backend: Flask + yfinance (no API keys, no accounts).
Frontend: TradingView's own open-source Lightweight Charts library.

Run:
    ~/workspace/paper-trader/.venv/bin/python app.py
Then open http://127.0.0.1:5000
"""
import csv
import glob
import json
import os
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, request, send_from_directory

import requests
import yfinance as yf

BASE = os.path.dirname(os.path.abspath(__file__))
WATCHLIST_FILE = os.path.join(BASE, "watchlist.json")
DEFAULT_WATCHLIST = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA",
                     "APP", "RDDT", "PLTR", "DUOL", "FIGR", "BRUN"]

TD_KEY = os.environ.get("TWELVEDATA_API_KEY")  # never hardcode; set in env
TD_TZ = ZoneInfo("America/New_York")
# Persistent local key store (0600 perms) so the key survives restarts.
# Never served back to the client and never committed (see .gitignore).
TD_KEY_FILE = os.path.expanduser("~/.config/chart-terminal/twelvedata.key")


def td_key():
    """Twelve Data key: local file first, env var as fallback."""
    try:
        with open(TD_KEY_FILE) as f:
            k = f.read().strip()
            if k:
                return k
    except OSError:
        pass
    return TD_KEY

# timeframe -> (yfinance interval, yfinance period)
INTERVALS = {
    "1m": ("1m", "5d"),
    "5m": ("5m", "1mo"),
    "15m": ("15m", "3mo"),
    "1h": ("1h", "6mo"),
    "4h": ("1h", "6mo"),  # resampled to 4h below
    "1d": ("1d", "2y"),
    "1wk": ("1wk", "5y"),
    "1mo": ("1mo", "max"),
}

# timeframe -> Twelve Data interval
TD_INTERVALS = {
    "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h",
    "1d": "1day", "1wk": "1week", "1mo": "1month",
}

def _resample_4h(bars):
    """Group 1h bars into 4h candles, buckets aligned to UTC midnight."""
    out, cur, cur_b = [], None, None
    for b in bars:
        bucket = b["time"] // (4 * 3600)
        if cur is not None and bucket == cur_b:
            cur["high"] = max(cur["high"], b["high"])
            cur["low"] = min(cur["low"], b["low"])
            cur["close"] = b["close"]
            cur["volume"] += b["volume"]
        else:
            if cur is not None:
                out.append(cur)
            cur_b = bucket
            cur = dict(b, time=bucket * 4 * 3600)
    if cur is not None:
        out.append(cur)
    return out

app = Flask(__name__)


def _td_bars(symbol, interval):
    """Fetch OHLCV from Twelve Data. Raises ValueError on API errors."""
    key = td_key()
    if not key:
        raise ValueError("Twelve Data needs a key — set it in the app settings")
    r = requests.get("https://api.twelvedata.com/time_series", params={
        "symbol": symbol, "interval": TD_INTERVALS[interval],
        "outputsize": 5000, "format": "JSON", "apikey": key,
    }, timeout=25)
    data = r.json()
    if data.get("status") == "error":
        raise ValueError(f"Twelve Data: {data.get('message', 'unknown error')}")
    values = data.get("values") or []
    if not values:
        raise ValueError(f"no data for {symbol}")
    out = []
    for v in values:
        try:
            dt = datetime.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            dt = datetime.strptime(v["datetime"], "%Y-%m-%d")
        t = int(dt.replace(tzinfo=TD_TZ).timestamp())
        try:
            vol = int(float(v.get("volume") or 0))
        except (TypeError, ValueError):
            vol = 0
        out.append({"time": t, "open": float(v["open"]), "high": float(v["high"]),
                    "low": float(v["low"]), "close": float(v["close"]), "volume": vol})
    out.reverse()  # Twelve Data returns newest-first
    return out


def _td_quote(symbol):
    key = td_key()
    if not key:
        raise ValueError("Twelve Data needs a key — set it in the app settings")
    r = requests.get("https://api.twelvedata.com/quote", params={
        "symbol": symbol, "apikey": key,
    }, timeout=25)
    data = r.json()
    if data.get("status") == "error":
        raise ValueError(f"Twelve Data: {data.get('message', 'unknown error')}")
    return {"symbol": symbol, "price": round(float(data["close"]), 2),
            "changePct": round(float(data.get("percent_change") or 0), 2)}


@app.get("/api/sources")
def sources():
    avail = ["yahoo"]
    if td_key():
        avail.append("twelvedata")
    return jsonify({"sources": avail})


@app.get("/api/tdkey")
def tdkey_status():
    # Never returns the key itself — just whether one is stored.
    return jsonify({"configured": bool(td_key())})


@app.post("/api/tdkey")
def tdkey_save():
    key = (request.get_json(silent=True) or {}).get("key", "").strip()
    if not key:
        return jsonify({"error": "empty key"}), 400
    os.makedirs(os.path.dirname(TD_KEY_FILE), exist_ok=True)
    with open(TD_KEY_FILE, "w") as f:
        f.write(key + "\n")
    os.chmod(TD_KEY_FILE, 0o600)
    return jsonify({"configured": True})


@app.delete("/api/tdkey")
def tdkey_clear():
    try:
        os.remove(TD_KEY_FILE)
    except OSError:
        pass
    return jsonify({"configured": bool(td_key())})


@app.get("/")
def index():
    return send_from_directory(os.path.join(BASE, "static"), "index.html")


@app.get("/<path:p>")
def root_static(p):
    # Serve frontend assets with Tauri-compatible relative paths
    # (index.html uses "styles.css", "app.js", "vendor/...").
    # Explicit /api/* routes take precedence over this catch-all.
    full = os.path.join(BASE, "static", p)
    if os.path.isfile(full):
        return send_from_directory(os.path.join(BASE, "static"), p)
    return jsonify({"error": "not found"}), 404


@app.get("/api/bars")
def bars():
    symbol = (request.args.get("symbol") or "").strip().upper()
    interval = request.args.get("interval") or "1d"
    source = (request.args.get("source") or "yahoo").lower()
    if not symbol:
        return jsonify({"error": "missing symbol"}), 400
    if interval not in INTERVALS:
        return jsonify({"error": f"unknown interval {interval}"}), 400
    if source == "twelvedata":
        try:
            out = _td_bars(symbol, interval)
        except ValueError as e:
            return jsonify({"error": str(e)}), 502
        return jsonify({"symbol": symbol, "interval": interval,
                        "source": source, "bars": out})
    yf_interval, period = INTERVALS[interval]
    try:
        df = yf.download(symbol, interval=yf_interval, period=period,
                         auto_adjust=False, progress=False)
    except Exception as e:  # network / yfinance errors
        return jsonify({"error": f"download failed: {e}"}), 502
    if df is None or df.empty:
        return jsonify({"error": f"no data for {symbol}"}), 404
    # yfinance >= 0.9 can return MultiIndex columns; flatten to plain names.
    if hasattr(df.columns, "nlevels") and df.columns.nlevels > 1:
        df.columns = df.columns.get_level_values(0)
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    if df.empty:
        return jsonify({"error": f"no data for {symbol}"}), 404
    out = []
    for ts, row in df.iterrows():
        # epoch seconds, UTC — what Lightweight Charts expects.
        t = int(ts.tz_convert("UTC").timestamp()) if ts.tzinfo else int(ts.timestamp())
        out.append({
            "time": t,
            "open": round(float(row["Open"]), 4),
            "high": round(float(row["High"]), 4),
            "low": round(float(row["Low"]), 4),
            "close": round(float(row["Close"]), 4),
            "volume": int(row["Volume"]) if row["Volume"] == row["Volume"] else 0,
        })
    if interval == "4h":
        out = _resample_4h(out)
    return jsonify({"symbol": symbol, "interval": interval, "bars": out})


@app.get("/api/quote")
def quote():
    symbol = (request.args.get("symbol") or "").strip().upper()
    source = (request.args.get("source") or "yahoo").lower()
    if not symbol:
        return jsonify({"error": "missing symbol"}), 400
    if source == "twelvedata":
        try:
            return jsonify(_td_quote(symbol))
        except ValueError as e:
            return jsonify({"error": str(e)}), 502
    try:
        info = yf.Ticker(symbol).fast_info
        price = info.get("lastPrice") or info.get("last_price")
        prev = info.get("previousClose") or info.get("previous_close")
    except Exception as e:
        return jsonify({"error": f"quote failed: {e}"}), 502
    if price is None:
        return jsonify({"error": f"no quote for {symbol}"}), 404
    change = (price - prev) / prev * 100 if prev else 0.0
    return jsonify({"symbol": symbol, "price": round(float(price), 2),
                    "changePct": round(float(change), 2)})


def _load_watchlist():
    try:
        with open(WATCHLIST_FILE) as f:
            wl = json.load(f)
            return [s for s in wl if isinstance(s, str)]
    except (OSError, ValueError):
        return list(DEFAULT_WATCHLIST)


@app.get("/api/watchlist")
def get_watchlist():
    return jsonify({"watchlist": _load_watchlist()})


@app.post("/api/watchlist")
def save_watchlist():
    data = request.get_json(silent=True) or {}
    wl = [str(s).strip().upper() for s in data.get("watchlist", []) if str(s).strip()]
    wl = list(dict.fromkeys(wl))  # de-dupe, keep order
    with open(WATCHLIST_FILE, "w") as f:
        json.dump(wl, f)
    return jsonify({"watchlist": wl})


# --- options-scanner + paper-trader integration ---
SCANNER_DIR = os.environ.get("CHART_SCANNER_DIR",
                             os.path.expanduser("~/workspace/options_scanner/outputs"))
PT_DB_ENV = os.environ.get("CHART_PT_DB")


def _pt_db_for(symbol):
    """Ledger DB holding the most trades for symbol (newest mtime breaks ties)."""
    if PT_DB_ENV and os.path.isfile(PT_DB_ENV):
        return PT_DB_ENV
    dbs = glob.glob(os.path.expanduser("~/workspace/paper-trader/**/*.db"), recursive=True)
    best, best_n, best_m = None, -1, -1
    for db in dbs:
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            n = con.execute("select count(*) from trades where symbol = ?",
                            (symbol,)).fetchone()[0]
            con.close()
        except sqlite3.Error:
            continue
        m = os.path.getmtime(db)
        if n > best_n or (n == best_n and m > best_m):
            best, best_n, best_m = db, n, m
    return best


def _read_scan_csv(symbol, leg):
    """Read {SYM}_{leg}.csv -> (mtime, rows). Missing/unreadable -> (None, [])."""
    path = os.path.join(SCANNER_DIR, f"{symbol}_{leg}.csv")
    if not os.path.isfile(path):
        return None, []
    try:
        with open(path, newline="") as f:
            rows = list(csv.DictReader(f))
    except OSError:
        return None, []
    return os.path.getmtime(path), rows


def _num(r, k, default=0.0):
    try:
        return float(r.get(k) or default)
    except (ValueError, TypeError):
        return default


@app.get("/api/scan")
def scan():
    symbol = (request.args.get("symbol") or "").strip().upper()
    if not symbol:
        return jsonify({"error": "missing symbol"}), 400
    mtime, rows = _read_scan_csv(symbol, "csp")
    cands = []
    for r in rows:
        try:
            strike = float(r["strike"])
        except (ValueError, KeyError, TypeError):
            continue
        cands.append({
            "strike": strike, "expiration": r.get("expiration", ""),
            "dte": int(_num(r, "DTE")), "vrp": _num(r, "vrp"),
            "iv": _num(r, "impliedVolatility"), "hv": _num(r, "realized_vol"),
            "bid": _num(r, "bid"), "ask": _num(r, "ask"),
            "net_premium": _num(r, "net_premium"),
            "ann_roi": _num(r, "annualized_roi_net"),
        })
    cands.sort(key=lambda c: c["vrp"], reverse=True)
    _, lrows = _read_scan_csv(symbol, "leaps_calls")
    leaps = []
    for r in lrows:
        try:
            strike = float(r["strike"])
        except (ValueError, KeyError, TypeError):
            continue
        leaps.append({
            "strike": strike, "expiration": r.get("expiration", ""),
            "dte": int(_num(r, "DTE")), "ask": _num(r, "ask"),
            "breakeven": _num(r, "breakeven"),
            "req_rally": _num(r, "required_rally_pct"),
            "delta": _num(r, "delta"),
        })
    leaps.sort(key=lambda c: c["req_rally"])
    return jsonify({
        "symbol": symbol,
        "scanned_at": int(mtime) if mtime else None,
        "candidates": cands[:8],
        "leaps": leaps[:5],
    })


@app.get("/api/ptrades")
def ptrades():
    symbol = (request.args.get("symbol") or "").strip().upper()
    if not symbol:
        return jsonify({"error": "missing symbol"}), 400
    db = _pt_db_for(symbol)
    if not db:
        return jsonify({"db": None, "trades": []})
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        rows = con.execute(
            "select ts, action, qty, price, strategy from trades where symbol = ? order by ts",
            (symbol,)).fetchall()
        con.close()
    except sqlite3.Error as e:
        return jsonify({"error": f"ledger read failed: {e}"}), 502
    trades = []
    for ts, action, qty, price, strategy in rows:
        try:
            t = int(datetime.fromisoformat(ts).replace(tzinfo=ZoneInfo("UTC")).timestamp())
        except ValueError:
            continue
        trades.append({"time": t, "action": action, "qty": qty,
                       "price": price, "strategy": strategy or ""})
    return jsonify({"db": os.path.basename(db), "trades": trades})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
