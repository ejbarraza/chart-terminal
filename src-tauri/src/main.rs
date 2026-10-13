//! Chart Terminal — Tauri backend.
//!
//! Ports the Flask backend (`../app.py`) to Rust commands:
//!   get_bars(symbol, interval, source)   -> OHLCV bars (Yahoo Finance / Twelve Data)
//!   get_quote(symbol, source)            -> last price + day change %
//!   get_watchlist() / save_watchlist()   -> JSON file in the app config dir
//!   get_sources()                        -> ["yahoo"] (+ "twelvedata" when a key is set)
//!
//! The Twelve Data key is read from the `TWELVEDATA_API_KEY` env var, falling
//! back to a `twelvedata.key` file in the app config dir. It is never baked
//! into the binary.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

#[derive(Serialize, Clone)]
struct Bar {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: i64,
}

#[derive(Serialize)]
struct BarsResponse {
    symbol: String,
    interval: String,
    source: String,
    bars: Vec<Bar>,
}

#[derive(Serialize)]
struct QuoteResponse {
    symbol: String,
    price: f64,
    #[serde(rename = "changePct")]
    change_pct: f64,
}

struct AppState {
    client: reqwest::Client,
}

fn td_key(app: &AppHandle) -> Option<String> {
    if let Ok(k) = std::env::var("TWELVEDATA_API_KEY") {
        if !k.trim().is_empty() {
            return Some(k.trim().to_string());
        }
    }
    config_file(app, "twelvedata.key")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn config_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

fn yahoo_params(interval: &str) -> (&'static str, &'static str) {
    match interval {
        "1m" => ("1m", "5d"),
        "5m" => ("5m", "1mo"),
        "15m" => ("15m", "3mo"),
        "1h" => ("1h", "6mo"),
        "4h" => ("1h", "6mo"), // resampled to 4h below
        "1wk" => ("1wk", "5y"),
        "1mo" => ("1mo", "max"),
        _ => ("1d", "2y"),
    }
}

fn td_interval(interval: &str) -> &'static str {
    match interval {
        "1m" => "1min",
        "5m" => "5min",
        "15m" => "15min",
        "1h" => "1h",
        "4h" => "4h",
        "1wk" => "1week",
        "1mo" => "1month",
        _ => "1day",
    }
}

/// Resample 1h bars into 4h candles, buckets aligned to UTC midnight.
fn resample_4h(bars: Vec<Bar>) -> Vec<Bar> {
    const SPAN: i64 = 4 * 3600;
    let mut out: Vec<Bar> = Vec::new();
    let mut cur: Option<Bar> = None;
    let mut cur_bucket = 0i64;
    for b in bars {
        let bucket = b.time.div_euclid(SPAN);
        match cur.as_mut() {
            Some(c) if bucket == cur_bucket => {
                if b.high > c.high { c.high = b.high; }
                if b.low < c.low { c.low = b.low; }
                c.close = b.close;
                c.volume += b.volume;
            }
            _ => {
                if let Some(c) = cur.take() { out.push(c); }
                cur_bucket = bucket;
                cur = Some(Bar { time: bucket * SPAN, ..b });
            }
        }
    }
    if let Some(c) = cur { out.push(c); }
    out
}

async fn yahoo_bars(client: &reqwest::Client, symbol: &str, interval: &str) -> Result<Vec<Bar>, String> {
    let (yi, yr) = yahoo_params(interval);
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval={}&range={}",
        symbol, yi, yr
    );
    let v: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("yahoo request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("yahoo bad response: {e}"))?;
    if let Some(msg) = v["chart"]["error"]["description"].as_str() {
        return Err(format!("yahoo: {msg}"));
    }
    let r = v["chart"]["result"][0]
        .as_object()
        .ok_or_else(|| format!("no data for {symbol}"))?;
    let empty = Vec::new();
    let ts = r["timestamp"].as_array().unwrap_or(&empty);
    let q = &r["indicators"]["quote"][0];
    let (op, hi, lo, cl, vo) = (
        q["open"].as_array().unwrap_or(&empty),
        q["high"].as_array().unwrap_or(&empty),
        q["low"].as_array().unwrap_or(&empty),
        q["close"].as_array().unwrap_or(&empty),
        q["volume"].as_array().unwrap_or(&empty),
    );
    let mut out = Vec::new();
    for i in 0..ts.len() {
        let (Some(t), Some(o), Some(h), Some(l), Some(c)) = (
            ts[i].as_i64(),
            op.get(i).and_then(|x| x.as_f64()),
            hi.get(i).and_then(|x| x.as_f64()),
            lo.get(i).and_then(|x| x.as_f64()),
            cl.get(i).and_then(|x| x.as_f64()),
        ) else {
            continue;
        };
        out.push(Bar {
            time: t,
            open: o,
            high: h,
            low: l,
            close: c,
            volume: vo.get(i).and_then(|x| x.as_i64()).unwrap_or(0),
        });
    }
    if out.is_empty() {
        return Err(format!("no data for {symbol}"));
    }
    if interval == "4h" {
        Ok(resample_4h(out))
    } else {
        Ok(out)
    }
}

async fn yahoo_quote(client: &reqwest::Client, symbol: &str) -> Result<QuoteResponse, String> {
    // The v7 quote endpoint now needs cookie auth; v8 chart meta carries the
    // same fields without it.
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=5d",
        symbol
    );
    let v: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("yahoo request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("yahoo bad response: {e}"))?;
    let meta = &v["chart"]["result"][0]["meta"];
    let price = meta["regularMarketPrice"]
        .as_f64()
        .ok_or_else(|| format!("no quote for {symbol}"))?;
    let prev = meta["chartPreviousClose"].as_f64().unwrap_or(price);
    let pct = if prev != 0.0 { (price - prev) / prev * 100.0 } else { 0.0 };
    Ok(QuoteResponse {
        symbol: symbol.to_string(),
        price: (price * 100.0).round() / 100.0,
        change_pct: (pct * 100.0).round() / 100.0,
    })
}

/// Parse "2026-10-12 15:59:00" or "2026-10-12" as America/New_York -> epoch secs.
///
/// Twelve Data stamps exchange-local time. A full tz database is overkill
/// here (the chart only needs monotonic, roughly-right times), so DST is
/// approximated with the US rule: EDT = second Sunday of March through the
/// first Sunday of November, EST otherwise. Day-level approximation is fine.
fn td_epoch(dt: &str) -> Option<i64> {
    let (date_part, time_part) = match dt.split_once(' ') {
        Some((d, t)) => (d, Some(t)),
        None => (dt, None),
    };
    let mut dp = date_part.split('-');
    let (y, m, d): (i32, i32, i32) = (
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
    );
    let (hh, mm, ss): (i64, i64, i64) = match time_part {
        Some(t) => {
            let mut tp = t.split(':');
            (
                tp.next()?.parse().ok()?,
                tp.next()?.parse().ok()?,
                tp.next().and_then(|s| s.parse().ok()).unwrap_or(0),
            )
        }
        None => (0, 0, 0),
    };
    let is_dst = (3 < m && m < 11) || (m == 3 && d >= 8) || (m == 11 && d < 7);
    let offset_h: i64 = if is_dst { 4 } else { 5 };
    let days = days_since_epoch(y, m, d)?;
    // local NY time -> UTC: add the offset (EDT = UTC-4, EST = UTC-5)
    Some(days * 86400 + hh * 3600 + mm * 60 + ss + offset_h * 3600)
}

/// Days from 1970-01-01 to y/m/d (proleptic Gregorian).
fn days_since_epoch(y: i32, m: i32, d: i32) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let (y, m) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
    let era = y.div_euclid(400) as i64;
    let yoe = (y - era as i32 * 400) as i64; // [0, 399]
    let mp = ((m + 9) % 12) as i64; // [0,11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era * 146097 + doe - 719468)
}

async fn td_bars(
    client: &reqwest::Client,
    symbol: &str,
    interval: &str,
    key: &str,
) -> Result<Vec<Bar>, String> {
    let url = "https://api.twelvedata.com/time_series";
    let v: serde_json::Value = client
        .get(url)
        .query(&[
            ("symbol", symbol),
            ("interval", td_interval(interval)),
            ("outputsize", "5000"),
            ("format", "JSON"),
            ("apikey", key),
        ])
        .send()
        .await
        .map_err(|e| format!("twelve data request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("twelve data bad response: {e}"))?;
    if v["status"] == "error" {
        return Err(format!(
            "twelve data: {}",
            v["message"].as_str().unwrap_or("unknown error")
        ));
    }
    let values = v["values"].as_array().ok_or("twelve data: no values")?;
    let mut out = Vec::new();
    for x in values {
        let t = x["datetime"]
            .as_str()
            .and_then(td_epoch)
            .ok_or("twelve data: bad datetime")?;
        let num = |k: &str| {
            x[k].as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| x[k].as_f64())
        };
        out.push(Bar {
            time: t,
            open: num("open").unwrap_or(0.0),
            high: num("high").unwrap_or(0.0),
            low: num("low").unwrap_or(0.0),
            close: num("close").unwrap_or(0.0),
            volume: num("volume").unwrap_or(0.0) as i64,
        });
    }
    out.reverse(); // Twelve Data returns newest-first
    if out.is_empty() {
        return Err(format!("no data for {symbol}"));
    }
    Ok(out)
}

async fn td_quote(client: &reqwest::Client, symbol: &str, key: &str) -> Result<QuoteResponse, String> {
    let v: serde_json::Value = client
        .get("https://api.twelvedata.com/quote")
        .query(&[("symbol", symbol), ("apikey", key)])
        .send()
        .await
        .map_err(|e| format!("twelve data request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("twelve data bad response: {e}"))?;
    if v["status"] == "error" {
        return Err(format!(
            "twelve data: {}",
            v["message"].as_str().unwrap_or("unknown error")
        ));
    }
    let num = |k: &str| {
        v[k].as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| v[k].as_f64())
    };
    Ok(QuoteResponse {
        symbol: symbol.to_string(),
        price: (num("close").unwrap_or(0.0) * 100.0).round() / 100.0,
        change_pct: (num("percent_change").unwrap_or(0.0) * 100.0).round() / 100.0,
    })
}

#[tauri::command]
async fn get_bars(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    symbol: String,
    interval: String,
    source: Option<String>,
) -> Result<BarsResponse, String> {
    let symbol = symbol.trim().to_uppercase();
    if symbol.is_empty() {
        return Err("missing symbol".into());
    }
    let source = source.unwrap_or_else(|| "yahoo".to_string());
    let bars = match source.as_str() {
        "twelvedata" => {
            let key = td_key(&app).ok_or(
                "Twelve Data needs TWELVEDATA_API_KEY set or a twelvedata.key file in the app config dir",
            )?;
            td_bars(&state.client, &symbol, &interval, &key).await?
        }
        _ => yahoo_bars(&state.client, &symbol, &interval).await?,
    };
    Ok(BarsResponse {
        symbol,
        interval,
        source,
        bars,
    })
}

#[tauri::command]
async fn get_quote(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    symbol: String,
    source: Option<String>,
) -> Result<QuoteResponse, String> {
    let symbol = symbol.trim().to_uppercase();
    if symbol.is_empty() {
        return Err("missing symbol".into());
    }
    match source.unwrap_or_else(|| "yahoo".to_string()).as_str() {
        "twelvedata" => {
            let key = td_key(&app).ok_or(
                "Twelve Data needs TWELVEDATA_API_KEY set or a twelvedata.key file in the app config dir",
            )?;
            td_quote(&state.client, &symbol, &key).await
        }
        _ => yahoo_quote(&state.client, &symbol).await,
    }
}

/* ---------------- options-scanner + paper-trader ---------------- */

fn scanner_dir() -> PathBuf {
    std::env::var("CHART_SCANNER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs_home()
                .join("workspace/options_scanner/outputs")
        })
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/root"))
}

fn csv_num(rec: &csv::StringRecord, hdr: &csv::StringRecord, k: &str) -> f64 {
    hdr.iter()
        .position(|h| h == k)
        .and_then(|i| rec.get(i))
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn csv_str<'a>(rec: &'a csv::StringRecord, hdr: &csv::StringRecord, k: &str) -> &'a str {
    hdr.iter()
        .position(|h| h == k)
        .and_then(|i| rec.get(i))
        .unwrap_or("")
}

#[derive(Serialize)]
struct ScanCandidate {
    strike: f64,
    expiration: String,
    dte: i64,
    vrp: f64,
    iv: f64,
    hv: f64,
    bid: f64,
    ask: f64,
    net_premium: f64,
    ann_roi: f64,
}

#[derive(Serialize)]
struct LeapCandidate {
    strike: f64,
    expiration: String,
    dte: i64,
    ask: f64,
    breakeven: f64,
    req_rally: f64,
    delta: f64,
}

#[derive(Serialize)]
struct ScanResponse {
    symbol: String,
    scanned_at: Option<i64>,
    candidates: Vec<ScanCandidate>,
    leaps: Vec<LeapCandidate>,
}

#[tauri::command]
fn get_scan(symbol: String) -> Result<ScanResponse, String> {
    let symbol = symbol.trim().to_uppercase();
    if symbol.is_empty() {
        return Err("missing symbol".into());
    }
    let dir = scanner_dir();
    let mut candidates = Vec::new();
    let mut scanned_at = None;
    let csp_path = dir.join(format!("{symbol}_csp.csv"));
    if csp_path.exists() {
        scanned_at = std::fs::metadata(&csp_path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        let mut rdr = csv::Reader::from_path(&csp_path).map_err(|e| format!("read scan: {e}"))?;
        let hdr = rdr.headers().map_err(|e| format!("read scan: {e}"))?.clone();
        for rec in rdr.records().flatten() {
            let strike: f64 = match csv_str(&rec, &hdr, "strike").parse() {
                Ok(s) => s,
                Err(_) => continue,
            };
            candidates.push(ScanCandidate {
                strike,
                expiration: csv_str(&rec, &hdr, "expiration").to_string(),
                dte: csv_num(&rec, &hdr, "DTE") as i64,
                vrp: csv_num(&rec, &hdr, "vrp"),
                iv: csv_num(&rec, &hdr, "impliedVolatility"),
                hv: csv_num(&rec, &hdr, "realized_vol"),
                bid: csv_num(&rec, &hdr, "bid"),
                ask: csv_num(&rec, &hdr, "ask"),
                net_premium: csv_num(&rec, &hdr, "net_premium"),
                ann_roi: csv_num(&rec, &hdr, "annualized_roi_net"),
            });
        }
    }
    candidates.sort_by(|a, b| b.vrp.partial_cmp(&a.vrp).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(8);
    let mut leaps = Vec::new();
    let leaps_path = dir.join(format!("{symbol}_leaps_calls.csv"));
    if leaps_path.exists() {
        let mut rdr = csv::Reader::from_path(&leaps_path).map_err(|e| format!("read scan: {e}"))?;
        let hdr = rdr.headers().map_err(|e| format!("read scan: {e}"))?.clone();
        for rec in rdr.records().flatten() {
            let strike: f64 = match csv_str(&rec, &hdr, "strike").parse() {
                Ok(s) => s,
                Err(_) => continue,
            };
            leaps.push(LeapCandidate {
                strike,
                expiration: csv_str(&rec, &hdr, "expiration").to_string(),
                dte: csv_num(&rec, &hdr, "DTE") as i64,
                ask: csv_num(&rec, &hdr, "ask"),
                breakeven: csv_num(&rec, &hdr, "breakeven"),
                req_rally: csv_num(&rec, &hdr, "required_rally_pct"),
                delta: csv_num(&rec, &hdr, "delta"),
            });
        }
    }
    leaps.sort_by(|a, b| {
        a.req_rally
            .partial_cmp(&b.req_rally)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    leaps.truncate(5);
    Ok(ScanResponse {
        symbol,
        scanned_at,
        candidates,
        leaps,
    })
}

#[derive(Serialize)]
struct PtTrade {
    time: i64,
    action: String,
    qty: f64,
    price: f64,
    strategy: String,
}

#[derive(Serialize)]
struct PtTradesResponse {
    db: Option<String>,
    trades: Vec<PtTrade>,
}

/// Parse "2025-10-06T00:00:00" as UTC -> epoch.
fn parse_ts_utc(ts: &str) -> Option<i64> {
    let (date, time) = ts.split_once('T')?;
    let mut dp = date.split('-');
    let (y, m, d): (i32, i32, i32) = (
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
    );
    let mut tp = time.split(':');
    let (hh, mm, ss): (i64, i64, i64) = (
        tp.next()?.parse().ok()?,
        tp.next()?.parse().ok()?,
        tp.next().and_then(|s| s.split('.').next()?.parse().ok()).unwrap_or(0),
    );
    let days = days_since_epoch(y, m, d)?;
    Some(days * 86400 + hh * 3600 + mm * 60 + ss)
}

fn pt_db_for(symbol: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CHART_PT_DB") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let base = dirs_home().join("workspace/paper-trader");
    let mut best: Option<(PathBuf, i64, i64)> = None; // path, n_trades, mtime
    let mut stack = vec![base];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|x| x.to_str()) == Some("db") {
                let (n, m) = (|| {
                    let con = rusqlite::Connection::open_with_flags(
                        &p,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                    )
                    .ok()?;
                    let n: i64 = con
                        .query_row(
                            "select count(*) from trades where symbol = ?1",
                            rusqlite::params![symbol],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    let m = std::fs::metadata(&p)
                        .and_then(|x| x.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    Some((n, m))
                })()
                .unwrap_or((0, 0));
                let replace = match &best {
                    None => true,
                    Some((_, bn, bm)) => n > *bn || (n == *bn && m > *bm),
                };
                if replace {
                    best = Some((p, n, m));
                }
            }
        }
    }
    best.map(|(p, _, _)| p)
}

#[tauri::command]
fn get_pt_trades(symbol: String) -> Result<PtTradesResponse, String> {
    let symbol = symbol.trim().to_uppercase();
    if symbol.is_empty() {
        return Err("missing symbol".into());
    }
    let db = pt_db_for(&symbol);
    let db_name = db.as_ref().and_then(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
    });
    let mut trades = Vec::new();
    if let Some(path) = db {
        let con = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("ledger read failed: {e}"))?;
        let mut stmt = con
            .prepare("select ts, action, qty, price, strategy from trades where symbol = ?1 order by ts")
            .map_err(|e| format!("ledger read failed: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![symbol], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                ))
            })
            .map_err(|e| format!("ledger read failed: {e}"))?;
        for row in rows.flatten() {
            let (ts, action, qty, price, strategy) = row;
            if let Some(t) = parse_ts_utc(&ts) {
                trades.push(PtTrade {
                    time: t,
                    action,
                    qty,
                    price,
                    strategy,
                });
            }
        }
    }
    Ok(PtTradesResponse { db: db_name, trades })
}

/* ---------------- terminal view (Flask /terminal parity) ----------------
 * The Bloomberg-style terminal page ships as static/terminal/index.html and
 * calls these commands when running inside the desktop app (no Flask server).
 * JSON shapes mirror the Flask /api/quotes and /api/pt/... endpoints exactly,
 * so terminal.js needs no per-mode branching. */

/* ---- batch quotes (F1 market monitor) ---- */

#[derive(Serialize)]
struct QuoteRow {
    symbol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    price: Option<f64>,
    #[serde(rename = "changePct", skip_serializing_if = "Option::is_none")]
    change_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct QuotesResponse {
    quotes: Vec<QuoteRow>,
}

#[tauri::command]
async fn get_quotes(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    symbols: String,
    source: Option<String>,
) -> Result<QuotesResponse, String> {
    let syms: Vec<String> = symbols
        .split(',')
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty())
        .take(40)
        .collect();
    if syms.is_empty() {
        return Err("missing symbols".into());
    }
    let source = source.unwrap_or_else(|| "yahoo".to_string());
    let mut out = Vec::with_capacity(syms.len());
    for s in syms {
        let row = match source.as_str() {
            "twelvedata" => match td_key(&app) {
                Some(key) => match td_quote(&state.client, &s, &key).await {
                    Ok(q) => QuoteRow {
                        symbol: s.clone(),
                        price: Some(q.price),
                        change_pct: Some(q.change_pct),
                        error: None,
                    },
                    Err(_) => QuoteRow {
                        symbol: s.clone(),
                        price: None,
                        change_pct: None,
                        error: Some("NO DATA".into()),
                    },
                },
                None => QuoteRow {
                    symbol: s.clone(),
                    price: None,
                    change_pct: None,
                    error: Some("Twelve Data key not set".into()),
                },
            },
            _ => match yahoo_quote(&state.client, &s).await {
                Ok(q) => QuoteRow {
                    symbol: s.clone(),
                    price: Some(q.price),
                    change_pct: Some(q.change_pct),
                    error: None,
                },
                Err(_) => QuoteRow {
                    symbol: s.clone(),
                    price: None,
                    change_pct: None,
                    error: Some("NO DATA".into()),
                },
            },
        };
        out.push(row);
    }
    Ok(QuotesResponse { quotes: out })
}

/* ---- paper-trader read-only ledger (F3 portfolio, F5 risk) ---- */

/// Ledger DB with the most trades overall (newest mtime breaks ties),
/// mirroring Flask's _pt_db_any(). CHART_PT_DB overrides for testing.
fn pt_db_any() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CHART_PT_DB") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let base = dirs_home().join("workspace/paper-trader");
    let mut best: Option<(PathBuf, i64, i64)> = None; // path, n_trades, mtime
    let mut stack = vec![base];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|x| x.to_str()) == Some("db") {
                let (n, m) = (|| {
                    let con = rusqlite::Connection::open_with_flags(
                        &p,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                    )
                    .ok()?;
                    let n: i64 = con
                        .query_row("select count(*) from trades", [], |r| r.get(0))
                        .unwrap_or(0);
                    let m = std::fs::metadata(&p)
                        .and_then(|x| x.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    Some((n, m))
                })()
                .unwrap_or((0, 0));
                let replace = match &best {
                    None => true,
                    Some((_, bn, bm)) => n > *bn || (n == *bn && m > *bm),
                };
                if replace {
                    best = Some((p, n, m));
                }
            }
        }
    }
    best.map(|(p, _, _)| p)
}

fn pt_db_name(path: &PathBuf) -> Option<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
}

fn pt_con(path: &PathBuf) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("ledger read failed: {e}"))
}

#[derive(Serialize)]
struct PtDbResponse {
    db: Option<String>,
}

#[tauri::command]
fn get_pt_db() -> Result<PtDbResponse, String> {
    Ok(PtDbResponse {
        db: pt_db_any().as_ref().and_then(pt_db_name),
    })
}

#[derive(Serialize)]
struct EquityPoint {
    ts: String,
    equity: f64,
    cash: f64,
}

#[derive(Serialize)]
struct PtEquityResponse {
    db: Option<String>,
    curve: Vec<EquityPoint>,
}

#[tauri::command]
fn get_pt_equity() -> Result<PtEquityResponse, String> {
    let path = pt_db_any();
    let mut curve = Vec::new();
    if let Some(p) = &path {
        let con = pt_con(p)?;
        let mut stmt = con
            .prepare("select ts, equity, cash from equity order by ts")
            .map_err(|e| format!("ledger read failed: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                ))
            })
            .map_err(|e| format!("ledger read failed: {e}"))?;
        for row in rows.flatten() {
            curve.push(EquityPoint {
                ts: row.0,
                equity: row.1,
                cash: row.2,
            });
        }
    }
    Ok(PtEquityResponse {
        db: path.as_ref().and_then(pt_db_name),
        curve,
    })
}

#[derive(Serialize)]
struct PtSummaryResponse {
    equity: f64,
    cash: f64,
    #[serde(rename = "return_pct")]
    return_pct: f64,
    #[serde(rename = "max_drawdown_pct")]
    max_drawdown_pct: f64,
    #[serde(rename = "n_points")]
    n_points: i64,
}

/// Pure max-drawdown math, shared with get_pt_summary and unit-tested below.
fn summary_stats(eq: &[f64]) -> (f64, f64, f64) {
    if eq.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let mut peak: f64 = eq[0];
    let mut max_dd: f64 = 0.0;
    for &v in eq {
        if v > peak {
            peak = v;
        }
        if peak > 0.0 {
            max_dd = max_dd.max((peak - v) / peak);
        }
    }
    let ret = if eq[0] != 0.0 { eq[eq.len() - 1] / eq[0] - 1.0 } else { 0.0 };
    (eq[eq.len() - 1], ret * 100.0, max_dd * 100.0)
}

#[tauri::command]
fn get_pt_summary() -> Result<PtSummaryResponse, String> {
    let path = pt_db_any().ok_or("NO DATA — no ledger DB found")?;
    let con = pt_con(&path)?;
    let mut stmt = con
        .prepare("select ts, equity, cash from equity order by ts")
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let rows: Vec<(String, f64, f64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("ledger read failed: {e}"))?
        .flatten()
        .collect();
    if rows.is_empty() {
        return Ok(PtSummaryResponse {
            equity: 0.0,
            cash: 0.0,
            return_pct: 0.0,
            max_drawdown_pct: 0.0,
            n_points: 0,
        });
    }
    let eq: Vec<f64> = rows.iter().map(|r| r.1).collect();
    let (equity, return_pct, max_drawdown_pct) = summary_stats(&eq);
    Ok(PtSummaryResponse {
        equity,
        cash: rows.last().map(|r| r.2).unwrap_or(0.0),
        return_pct,
        max_drawdown_pct,
        n_points: rows.len() as i64,
    })
}

#[derive(Serialize)]
struct PtPosition {
    pkey: String,
    qty: f64,
    mark: f64,
}

#[derive(Serialize)]
struct PtPositionsResponse {
    #[serde(rename = "as_of")]
    as_of: Option<String>,
    positions: Vec<PtPosition>,
}

#[tauri::command]
fn get_pt_positions() -> Result<PtPositionsResponse, String> {
    let path = pt_db_any().ok_or("NO DATA — no ledger DB found")?;
    let con = pt_con(&path)?;
    let snap: Option<String> = con
        .query_row("select ts from snapshots order by ts desc limit 1", [], |r| {
            r.get(0)
        })
        .ok();
    let latest_ts = match snap {
        Some(t) => Some(t),
        None => con
            .query_row("select max(ts) as ts from positions", [], |r| {
                r.get::<_, Option<String>>(0)
            })
            .unwrap_or(None),
    };
    let mut positions = Vec::new();
    if let Some(ts) = &latest_ts {
        let mut stmt = con
            .prepare("select pkey, qty, mark from positions where ts = ?1")
            .map_err(|e| format!("ledger read failed: {e}"))?;
        let rows = stmt
            .query_map([ts], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                ))
            })
            .map_err(|e| format!("ledger read failed: {e}"))?;
        for row in rows.flatten() {
            positions.push(PtPosition {
                pkey: row.0,
                qty: row.1,
                mark: row.2,
            });
        }
    }
    Ok(PtPositionsResponse {
        as_of: latest_ts,
        positions,
    })
}

#[derive(Serialize)]
struct PtStrategyRow {
    strategy: String,
    net: f64,
    #[serde(rename = "n_trades")]
    n_trades: i64,
}

#[derive(Serialize)]
struct PtStrategiesResponse {
    strategies: Vec<PtStrategyRow>,
}

#[tauri::command]
fn get_pt_strategies() -> Result<PtStrategiesResponse, String> {
    let path = pt_db_any().ok_or("NO DATA — no ledger DB found")?;
    let con = pt_con(&path)?;
    let mut stmt = con
        .prepare(
            "select strategy,
                    sum(case when cash_delta > 0 then cash_delta else 0 end) as gross_in,
                    sum(case when cash_delta < 0 then cash_delta else 0 end) as gross_out,
                    sum(cash_delta) as net,
                    count(*) as n_trades
             from trades group by strategy order by net desc",
        )
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let mut strategies = Vec::new();
    for row in rows.flatten() {
        strategies.push(PtStrategyRow {
            strategy: row.0,
            net: row.1,
            n_trades: row.2,
        });
    }
    Ok(PtStrategiesResponse { strategies })
}

#[derive(Serialize)]
struct PtTradeRow {
    ts: String,
    strategy: String,
    symbol: String,
    action: String,
    qty: f64,
    price: f64,
}

#[derive(Serialize)]
struct PtRecentTradesResponse {
    trades: Vec<PtTradeRow>,
}

#[tauri::command]
fn get_pt_recent(limit: Option<i64>) -> Result<PtRecentTradesResponse, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let path = pt_db_any().ok_or("NO DATA — no ledger DB found")?;
    let con = pt_con(&path)?;
    let mut stmt = con
        .prepare(
            "select ts, strategy, symbol, action, qty, price, cash_delta \
             from trades order by id desc limit ?1",
        )
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, f64>(5)?,
            ))
        })
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let mut trades = Vec::new();
    for row in rows.flatten() {
        trades.push(PtTradeRow {
            ts: row.0,
            strategy: row.1,
            symbol: row.2,
            action: row.3,
            qty: row.4,
            price: row.5,
        });
    }
    Ok(PtRecentTradesResponse { trades })
}

#[derive(Serialize)]
struct PtRiskEvent {
    ts: String,
    strategy: String,
    symbol: String,
    action: String,
    reason: String,
}

#[derive(Serialize)]
struct PtRiskResponse {
    #[serde(rename = "risk_events")]
    risk_events: Vec<PtRiskEvent>,
}

#[tauri::command]
fn get_pt_risk() -> Result<PtRiskResponse, String> {
    let path = pt_db_any().ok_or("NO DATA — no ledger DB found")?;
    let con = pt_con(&path)?;
    let mut stmt = con
        .prepare(
            "select ts, strategy, symbol, action, reason \
             from risk_events order by id desc limit 200",
        )
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let mut risk_events = Vec::new();
    for row in rows.flatten() {
        risk_events.push(PtRiskEvent {
            ts: row.0,
            strategy: row.1,
            symbol: row.2,
            action: row.3,
            reason: row.4,
        });
    }
    Ok(PtRiskResponse { risk_events })
}

#[derive(Serialize)]
struct PtRejectionsResponse {
    total: i64,
    #[serde(rename = "by_reason")]
    by_reason: std::collections::HashMap<String, i64>,
    #[serde(rename = "killswitch_tripped")]
    killswitch_tripped: Vec<String>,
    #[serde(rename = "killswitch_status")]
    killswitch_status: String,
}

#[tauri::command]
fn get_pt_rejections() -> Result<PtRejectionsResponse, String> {
    let path = pt_db_any().ok_or("NO DATA — no ledger DB found")?;
    let con = pt_con(&path)?;
    let mut stmt = con
        .prepare(
            "select reason, strategy, count(*) as n from risk_events \
             group by reason, strategy order by n desc",
        )
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("ledger read failed: {e}"))?;
    let mut by_reason: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    for (reason, _strategy, n) in rows.flatten() {
        *by_reason.entry(reason).or_insert(0) += n;
    }
    let mut tripped: Vec<String> = ["drawdown_killswitch", "daily_loss_killswitch"]
        .iter()
        .filter(|r| by_reason.contains_key(**r))
        .map(|r| r.to_string())
        .collect();
    tripped.sort();
    let status = if tripped.is_empty() {
        "ARMED — NO TRIPS".to_string()
    } else {
        format!("TRIPPED: {}", tripped.join(", "))
    };
    let total: i64 = by_reason.values().sum();
    Ok(PtRejectionsResponse {
        total,
        by_reason,
        killswitch_tripped: tripped,
        killswitch_status: status,
    })
}

#[cfg(test)]
mod terminal_tests {
    use super::*;

    #[test]
    fn summary_stats_flat_book() {
        let (eq, ret, dd) = summary_stats(&[100000.0, 101000.0, 99500.0, 102000.0]);
        assert!((eq - 102000.0).abs() < 1e-9);
        assert!((ret - 2.0).abs() < 1e-9);
        assert!((dd - (1500.0 / 101000.0) * 100.0).abs() < 1e-9);
    }

    #[test]
    fn summary_stats_empty() {
        assert_eq!(summary_stats(&[]), (0.0, 0.0, 0.0));
    }
}

fn watchlist_path(app: &AppHandle) -> Result<PathBuf, String> {    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("config dir: {e}"))?;
    Ok(dir.join("watchlist.json"))
}

const DEFAULT_WATCHLIST: &[&str] = &[
    "SPY", "QQQ", "AAPL", "NVDA", "TSLA", "APP", "RDDT", "PLTR", "DUOL", "FIGR", "BRUN",
];

#[derive(Serialize)]
struct WatchlistResponse {
    watchlist: Vec<String>,
}

#[derive(Serialize)]
struct SourcesResponse {
    sources: Vec<String>,
}

#[tauri::command]
fn get_watchlist(app: AppHandle) -> Result<WatchlistResponse, String> {
    let p = watchlist_path(&app)?;
    let watchlist = if !p.exists() {
        DEFAULT_WATCHLIST.iter().map(|s| s.to_string()).collect()
    } else {
        let raw = std::fs::read_to_string(p).map_err(|e| format!("read watchlist: {e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("parse watchlist: {e}"))?
    };
    Ok(WatchlistResponse { watchlist })
}

#[tauri::command]
fn save_watchlist(app: AppHandle, watchlist: Vec<String>) -> Result<WatchlistResponse, String> {
    let clean: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        watchlist
            .into_iter()
            .map(|s| s.trim().to_uppercase())
            .filter(|s| !s.is_empty() && seen.insert(s.clone()))
            .collect()
    };
    let p = watchlist_path(&app)?;
    let raw = serde_json::to_string(&clean).map_err(|e| format!("encode watchlist: {e}"))?;
    std::fs::write(p, raw).map_err(|e| format!("write watchlist: {e}"))?;
    Ok(WatchlistResponse { watchlist: clean })
}

#[tauri::command]
fn get_sources(app: AppHandle) -> Result<SourcesResponse, String> {
    let mut sources = vec!["yahoo".to_string()];
    if td_key(&app).is_some() {
        sources.push("twelvedata".to_string());
    }
    Ok(SourcesResponse { sources })
}

/// Persist the Twelve Data key in the app config dir (0600 on unix).
/// Empty key clears it. The key is never read back out — get_sources only
/// reports whether one is configured.
#[tauri::command]
fn set_td_key(app: AppHandle, key: String) -> Result<bool, String> {
    let key = key.trim().to_string();
    let p = config_file(&app, "twelvedata.key").ok_or("no config dir")?;
    if key.is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(td_key(&app).is_some());
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("config dir: {e}"))?;
    }
    std::fs::write(&p, key + "\n").map_err(|e| format!("write key: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod key: {e}"))?;
    }
    Ok(true)
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            client: reqwest::Client::builder()
                .user_agent(UA)
                .build()
                .expect("http client"),
        })
        .setup(|app| {
            // WebView2 caches the embedded frontend aggressively, so an update
            // can keep showing the previous version's UI. On a version change,
            // wipe the browsing data and reload to force fresh assets.
            let ver = app.package_info().version.to_string();
            let vf = app
                .path()
                .app_config_dir()
                .map(|d| d.join("app_version"))
                .unwrap_or_default();
            let old = std::fs::read_to_string(&vf).unwrap_or_default();
            if old.trim() != ver {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.clear_all_browsing_data();
                    let _ = w.eval("window.location.reload();");
                }
                if let Some(parent) = vf.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&vf, &ver);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_bars,
            get_quote,
            get_quotes,
            get_watchlist,
            save_watchlist,
            get_sources,
            set_td_key,
            get_scan,
            get_pt_trades,
            get_pt_db,
            get_pt_equity,
            get_pt_summary,
            get_pt_positions,
            get_pt_strategies,
            get_pt_recent,
            get_pt_risk,
            get_pt_rejections
        ])
        .run(tauri::generate_context!())
        .expect("error while running chart-terminal");
}
