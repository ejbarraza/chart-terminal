/* chart-terminal frontend.
 * Charting: TradingView Lightweight Charts (open source, Apache-2.0).
 * Data: this app's own /api/* endpoints (yfinance underneath). */
'use strict';

/* Global error trap: surface any fatal JS error in the header badge so a
 * screenshot is a complete diagnostic. Must be first. */
window.__ctError = null;
window.addEventListener('error', (e) => {
  window.__ctError = String(e.message || e.error || 'unknown').slice(0, 80);
  const b = document.getElementById('app-ver');
  if (b) b.textContent += ' [ERR ' + window.__ctError + ']';
});

const $ = (id) => document.getElementById(id);
const LS_STATE = 'ct-state-v1';
const LS_DRAW = 'ct-drawings-v1';

/* ---------------- transport ----------------
 * Browser mode: plain HTTP to the Flask backend.
 * Tauri mode: invoke() -> Rust commands. Tauri v2 does NOT provide
 * window.__TAURI__ (that was v1); it injects window.__TAURI_INTERNALS__
 * with an invoke() function instead. We support both.
 * Both speak the same JSON shapes, so the rest of the app is identical. */
const TAURI_INVOKE =
  (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
  (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke &&
    window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__)) ||
  null;
const TAURI_CORE = TAURI_INVOKE ? { invoke: TAURI_INVOKE } : null;
async function tauriInvoke(path, body) {
  const u = new URL(path, 'http://localhost');
  const q = Object.fromEntries(u.searchParams.entries());
  const src = q.source || 'yahoo';
  try {
    switch (u.pathname) {
      case '/api/bars': return await TAURI_CORE.invoke('get_bars', { symbol: q.symbol, interval: q.interval, source: src });
      case '/api/quote': return await TAURI_CORE.invoke('get_quote', { symbol: q.symbol, source: src });
      case '/api/watchlist':
        return body ? await TAURI_CORE.invoke('save_watchlist', { watchlist: body.watchlist })
                    : await TAURI_CORE.invoke('get_watchlist');
      case '/api/sources': return await TAURI_CORE.invoke('get_sources');
      case '/api/scan': return await TAURI_CORE.invoke('get_scan', { symbol: q.symbol });
      case '/api/ptrades': return await TAURI_CORE.invoke('get_pt_trades', { symbol: q.symbol });
      case '/api/tdkey': {
        if (body && body._delete) {
          const ok = await TAURI_CORE.invoke('set_td_key', { key: '' });
          return { configured: !!ok };
        }
        if (body) {
          const ok = await TAURI_CORE.invoke('set_td_key', { key: body.key || '' });
          return { configured: !!ok };
        }
        const s = await TAURI_CORE.invoke('get_sources');
        return { configured: s.sources.includes('twelvedata') };
      }
    }
  } catch (e) { throw new Error(typeof e === 'string' ? e : (e && e.message) || 'request failed'); }
  throw new Error('unknown endpoint ' + u.pathname);
}
async function apiGet(path) {
  if (TAURI_CORE) return tauriInvoke(path);
  const r = await fetch(path);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'request failed');
  return j;
}
async function apiPost(path, body) {
  if (TAURI_CORE) return tauriInvoke(path, body);
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'request failed');
  return j;
}
async function apiDelete(path) {
  if (TAURI_CORE) return tauriInvoke(path, { _delete: true });
  const r = await fetch(path, { method: 'DELETE' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'request failed');
  return j;
}

/* ---------------- state ---------------- */
const state = Object.assign(
  { symbol: 'SPY', tf: '1d', source: 'yahoo', ind: { sma20: false, sma50: false, ema20: false, bb: false, vol: true, rsi: false, macd: false, emaclouds: false, stoch: false } },
  JSON.parse(localStorage.getItem(LS_STATE) || '{}')
);
let bars = [];            // raw OHLCV from backend
let drawings = [];        // active drawing primitives for this symbol/tf
let selectedDrawing = null;
let drawMode = null;      // null | 'trend' | 'hline'
let pendingPoint = null;  // first click of a trend line

/* ---------------- chart ---------------- */
let chart = null, candleSeries = null;
if (window.LightweightCharts) {
  chart = LightweightCharts.createChart($('chart'), {
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc', fontSize: 11 },
    grid: { vertLines: { color: '#1c2230' }, horzLines: { color: '#1c2230' } },
    crosshair: { vertLine: { color: '#758696' }, horzLine: { color: '#758696' } },
    rightPriceScale: { borderColor: '#2a2e39' },
    timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
  });
  candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a', downColor: '#ef5350',
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    borderVisible: false,
  });
} else {
  $('chart').innerHTML = '<div style="padding:40px;color:#f66">Chart library failed to load.</div>';
}
const indSeries = {};   // name -> series
const paneScales = {};  // paneId -> priceScale

function sizeChart() {
  if (!chart) return;
  const w = $('chart-wrap');
  chart.applyOptions({ width: w.clientWidth, height: w.clientHeight });
}
new ResizeObserver(sizeChart).observe($('chart-wrap'));
window.addEventListener('resize', sizeChart);

/* ---------------- indicator math ---------------- */
const closes = () => bars.map(b => b.close);

function smaArr(vals, n) {
  const out = []; let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}
function emaArr(vals, n) {
  const out = []; const k = 2 / (n + 1); let e = vals[0];
  for (let i = 0; i < vals.length; i++) {
    e = i === 0 ? vals[0] : vals[i] * k + e * (1 - k);
    if (i >= n - 1) out.push({ time: bars[i].time, value: e });
  }
  return out;
}
function bbArr(vals, n = 20, mult = 2) {
  const mid = smaArr(vals, n); const up = [], lo = [];
  for (let j = 0; j < mid.length; j++) {
    const i = j + n - 1;
    const slice = vals.slice(i - n + 1, i + 1);
    const m = mid[j].value;
    const sd = Math.sqrt(slice.reduce((a, v) => a + (v - m) ** 2, 0) / n);
    up.push({ time: mid[j].time, value: m + mult * sd });
    lo.push({ time: mid[j].time, value: m - mult * sd });
  }
  return { mid, up, lo };
}
function rsiArr(vals, n = 14) {
  const out = []; let g = 0, l = 0;
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    if (i >= n) out.push({ time: bars[i].time, value: 100 - 100 / (1 + (l === 0 ? 100 : g / l)) });
  }
  return out;
}
function macdArr(vals, f = 12, s = 26, sig = 9) {
  const ef = emaFull(vals, f), es = emaFull(vals, s);
  const line = [];
  for (let i = 0; i < vals.length; i++) line.push({ time: bars[i].time, value: ef[i] - es[i] });
  const sigVals = emaFull(line.map(p => p.value), sig);
  const hist = line.map((p, i) => ({ time: p.time, value: p.value - sigVals[i], up: p.value - sigVals[i] >= 0 }));
  return { line, signal: line.map((p, i) => ({ time: p.time, value: sigVals[i] })), hist };
}
function emaFull(vals, n) {
  const k = 2 / (n + 1); let e = vals[0];
  return vals.map((v, i) => (e = i === 0 ? v : v * k + e * (1 - k)));
}
/* EMA clouds: N EMAs on hl2, all aligned to the longest period. */
function emaClouds(periods) {
  const hl2 = bars.map(b => (b.high + b.low) / 2);
  const start = Math.max(...periods) - 1;
  return periods.map(p => ({
    period: p,
    data: emaFull(hl2, p).slice(start).map((v, i) => ({ time: bars[start + i].time, value: v })),
  }));
}
/* Stochastic %K(14) slowed 3, %D = SMA3 of %K. */
function stochArr(kPeriod = 14, slowing = 3, dPeriod = 3) {
  const kRaw = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...slice.map(b => b.high));
    const ll = Math.min(...slice.map(b => b.low));
    kRaw.push(hh === ll ? 50 : 100 * (bars[i].close - ll) / (hh - ll));
  }
  const kSm = smaOf(kRaw, slowing).map((v, i) => ({ time: bars[kPeriod - 1 + slowing - 1 + i].time, value: v }));
  const dSm = smaOf(kSm.map(p => p.value), dPeriod).map((v, i) => ({ time: kSm[dPeriod - 1 + i].time, value: v }));
  return { k: kSm, d: dSm };
}
function smaOf(vals, n) {
  const out = []; let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    if (i >= n - 1) out.push(sum / n);
  }
  return out;
}

/* ---------------- indicator series ---------------- */
function addLine(name, data, color, paneId, width = 1) {
  const opts = { color, lineWidth: width, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true };
  if (paneId) opts.priceScaleId = paneId;
  const s = chart.addSeries(LightweightCharts.LineSeries, opts);
  s.setData(data);
  indSeries[name] = s;
  return s;
}
function removeInd(name) {
  if (indSeries[name]) { chart.removeSeries(indSeries[name]); delete indSeries[name]; }
}
/* Primitives (cloud fills, zone shades) must be detached explicitly. */
const dynPrims = [];
function trackPrim(prim, host) { host.attachPrimitive(prim); dynPrims.push({ prim, host }); }
function clearDynamic() {
  ['sma20', 'sma50', 'ema20', 'bb-up', 'bb-mid', 'bb-lo', 'vol-pane', 'rsi-pane',
   'macd-pane', 'macd-sig', 'macd-hist', 'stoch-k', 'stoch-d', 'stoch-80', 'stoch-50', 'stoch-20',
   ...Array.from({ length: 10 }, (_, i) => 'ec' + i)].forEach(removeInd);
  dynPrims.forEach(({ prim, host }) => { try { host.detachPrimitive(prim); } catch (e) {} });
  dynPrims.length = 0;
}
function layoutPanes() {
  // Stack visible sub-panes (vol, rsi, macd, stoch) along the bottom 30%.
  const panes = ['vol', 'rsi', 'macd', 'stoch'].filter(p => indSeries[p + '-pane']);
  const n = panes.length;
  chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: n ? 0.32 : 0.06 } });
  panes.forEach((p, i) => {
    const h = 0.28 / n, top = 0.70 + i * h + 0.015;
    paneScales[p].applyOptions({ scaleMargins: { top, bottom: Math.max(0.02, 1 - top - h) } });
  });
}
function refreshIndicators() {
  clearDynamic();
  const c = closes();
  if (state.ind.sma20) addLine('sma20', smaArr(c, 20), '#f5c542');
  if (state.ind.sma50) addLine('sma50', smaArr(c, 50), '#e06c9f');
  if (state.ind.ema20) addLine('ema20', emaArr(c, 20), '#4fc3f7');
  if (state.ind.bb) {
    const bb = bbArr(c);
    addLine('bb-up', bb.up, '#787b86'); addLine('bb-mid', bb.mid, '#a9b0c0'); addLine('bb-lo', bb.lo, '#787b86');
  }
  if (state.ind.emaclouds && bars.length > 200) {
    // Ripster-style: 10 EMAs on hl2, filled clouds between consecutive pairs.
    const periods = [8, 9, 5, 12, 34, 50, 72, 89, 180, 200];
    const pairCols = [
      { up: '#26a69a', down: '#ef5350' },
      { up: '#2962ff', down: '#ff9f43' },
      { up: '#00c853', down: '#d50000' },
      { up: '#9c6bff', down: '#ffd54f' },
      { up: '#90a4ae', down: '#90a4ae' },
    ];
    const clouds = emaClouds(periods);
    clouds.forEach((cl, i) => addLine('ec' + i, cl.data, pairCols[Math.floor(i / 2)].up, null, 1));
    for (let p = 0; p < periods.length; p += 2) {
      const col = pairCols[p / 2];
      trackPrim(new CloudBand(clouds[p].data, clouds[p + 1].data, col.up + '2e', col.down + '2e'), candleSeries);
    }
  }
  if (state.ind.vol) {
    const s = chart.addSeries(LightweightCharts.HistogramSeries, {
      priceScaleId: 'vol', priceFormat: { type: 'volume' },
      priceLineVisible: false, lastValueVisible: false,
    });
    s.setData(bars.map(b => ({
      time: b.time, value: b.volume,
      color: b.close >= b.open ? 'rgba(38,166,154,.5)' : 'rgba(239,83,80,.5)',
    })));
    indSeries['vol-pane'] = s; paneScales['vol'] = chart.priceScale('vol');
  }
  if (state.ind.rsi) {
    const s = addLine('rsi-pane', rsiArr(c), '#9c6bff', 'rsi');
    paneScales['rsi'] = chart.priceScale('rsi'); indSeries['rsi-pane'] = s;
  }
  if (state.ind.macd) {
    const m = macdArr(c);
    addLine('macd-pane', m.line, '#4fc3f7', 'macd');
    addLine('macd-sig', m.signal, '#ff9f43', 'macd');
    const h = chart.addSeries(LightweightCharts.HistogramSeries, { priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false });
    h.setData(m.hist.map(p => ({ time: p.time, value: p.value, color: p.up ? 'rgba(38,166,154,.6)' : 'rgba(239,83,80,.6)' })));
    indSeries['macd-hist'] = h; paneScales['macd'] = chart.priceScale('macd');
  }
  if (state.ind.stoch) {
    const st = stochArr(14, 3, 3);
    const k = addLine('stoch-k', st.k, '#00e676', 'stoch', 2);
    addLine('stoch-d', st.d, '#ff5252', 'stoch', 1);
    paneScales['stoch'] = chart.priceScale('stoch'); indSeries['stoch-pane'] = k;
    [80, 50, 20].forEach(lv => {
      const s = chart.addSeries(LightweightCharts.LineSeries, {
        color: '#787b86', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
        priceScaleId: 'stoch', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData(bars.map(b => ({ time: b.time, value: lv })));
      indSeries['stoch-' + lv] = s;
    });
    trackPrim(new ZoneShade(st.k, 80, 20), k);
  }
  layoutPanes();
}

/* ---------------- drawings ---------------- */
function drawKey() { return state.symbol + '|' + state.tf; }
function loadDrawings() {
  const all = JSON.parse(localStorage.getItem(LS_DRAW) || '{}');
  return all[drawKey()] || [];
}
function saveDrawings() {
  const all = JSON.parse(localStorage.getItem(LS_DRAW) || '{}');
  all[drawKey()] = drawings.map(d => d.spec());
  localStorage.setItem(LS_DRAW, JSON.stringify(all));
}
function clearDrawings() {
  drawings.forEach(d => candleSeries.detachPrimitive(d));
  drawings = []; selectedDrawing = null;
}
function restoreDrawings() {
  clearDrawings();
  loadDrawings().forEach(spec => {
    const d = spec.k === 't' ? new TrendDrawing(spec.a, spec.b) : new HLineDrawing(spec.p);
    attachDrawing(d);
  });
}
function attachDrawing(d) {
  candleSeries.attachPrimitive(d);
  drawings.push(d);
  saveDrawings();
}
function removeSelected() {
  if (!selectedDrawing) return;
  candleSeries.detachPrimitive(selectedDrawing);
  drawings = drawings.filter(d => d !== selectedDrawing);
  selectedDrawing = null;
  saveDrawings();
}

class BaseDrawing {
  constructor() { this._chart = null; this._series = null; this.selected = false; }
  attached({ chart, series }) { this._chart = chart; this._series = series; }
  detached() { this._chart = null; this._series = null; }
  paneViews() { return [this]; }
  updateAllViews() {}
  zOrder() { return 'top'; }
  renderer() { return { draw: (t) => this._draw(t) }; }
  xy(time, price) {
    const x = this._chart.timeScale().timeToCoordinate(time);
    const y = this._series.priceToCoordinate(price);
    return (x === null || y === null) ? null : { x, y };
  }
  stroke(target, selected) {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio, verticalPixelRatio }) => {
      ctx.save();
      ctx.scale(horizontalPixelRatio, verticalPixelRatio);
      this.paint(ctx, !!selected);
      ctx.restore();
    });
  }
  _draw(target) { this.stroke(target, this.selected); }
}

class TrendDrawing extends BaseDrawing {
  constructor(a, b) { super(); this.a = a; this.b = b; }  // {t: time, p: price}
  spec() { return { k: 't', a: this.a, b: this.b }; }
  paint(ctx, sel) {
    const A = this.xy(this.a.t, this.a.p), B = this.xy(this.b.t, this.b.p);
    if (!A || !B) return;
    ctx.strokeStyle = sel ? '#ffcf3f' : '#2962ff'; ctx.lineWidth = sel ? 3 : 2;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    for (const P of [A, B]) {
      ctx.fillStyle = sel ? '#ffcf3f' : '#2962ff';
      ctx.beginPath(); ctx.arc(P.x, P.y, 4, 0, Math.PI * 2); ctx.fill();
    }
  }
  hitTest(x, y) {
    const A = this.xy(this.a.t, this.a.p), B = this.xy(this.b.t, this.b.p);
    if (!A || !B) return null;
    // distance point->segment
    const dx = B.x - A.x, dy = B.y - A.y, len2 = dx * dx + dy * dy || 1;
    const t = Math.min(1, Math.max(0, ((x - A.x) * dx + (y - A.y) * dy) / len2));
    const d = Math.hypot(x - (A.x + t * dx), y - (A.y + t * dy));
    return d < 8 ? { cursorStyle: 'pointer' } : null;
  }
}

class HLineDrawing extends BaseDrawing {
  constructor(price) { super(); this.price = price; }
  spec() { return { k: 'h', p: this.price }; }
  paint(ctx, sel) {
    const y = this._series.priceToCoordinate(this.price);
    if (y === null) return;
    const w = this._chart.timeScale().width();
    ctx.strokeStyle = sel ? '#ffcf3f' : '#e06c9f'; ctx.lineWidth = sel ? 3 : 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]);
  }
  hitTest(x, y) {
    const ly = this._series.priceToCoordinate(this.price);
    return (ly !== null && Math.abs(y - ly) < 8) ? { cursorStyle: 'pointer' } : null;
  }
}

/* Fills the band between two aligned {time,value} arrays, coloring each
 * segment by which line is on top. Drawn in media (CSS pixel) coordinates. */
class CloudBand {
  constructor(fast, slow, upFill, downFill) {
    this.fast = fast; this.slow = slow;
    this.upFill = upFill; this.downFill = downFill;
    this._chart = null; this._series = null;
  }
  attached({ chart, series }) { this._chart = chart; this._series = series; }
  detached() { this._chart = null; this._series = null; }
  paneViews() { return [this]; }
  updateAllViews() {}
  zOrder() { return 'bottom'; }
  renderer() { return { draw: (t) => this._draw(t) }; }
  _draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const ts = this._chart.timeScale();
      const n = Math.min(this.fast.length, this.slow.length);
      for (let i = 1; i < n; i++) {
        const x0 = ts.timeToCoordinate(this.fast[i - 1].time);
        const x1 = ts.timeToCoordinate(this.fast[i].time);
        if (x0 === null || x1 === null) continue;
        const f0 = this._series.priceToCoordinate(this.fast[i - 1].value);
        const f1 = this._series.priceToCoordinate(this.fast[i].value);
        const s0 = this._series.priceToCoordinate(this.slow[i - 1].value);
        const s1 = this._series.priceToCoordinate(this.slow[i].value);
        if (f0 === null || f1 === null || s0 === null || s1 === null) continue;
        const up = (this.fast[i].value + this.fast[i - 1].value) >= (this.slow[i].value + this.slow[i - 1].value);
        ctx.fillStyle = up ? this.upFill : this.downFill;
        ctx.beginPath();
        ctx.moveTo(x0, f0); ctx.lineTo(x1, f1); ctx.lineTo(x1, s1); ctx.lineTo(x0, s0);
        ctx.closePath(); ctx.fill();
      }
    });
  }
}

/* Shades full-height vertical strips of a sub-pane where the %K line is in
 * the overbought/oversold zones. */
class ZoneShade {
  constructor(kArr, ob, os) {
    this.k = kArr; this.ob = ob; this.os = os;
    this._chart = null;
  }
  attached({ chart }) { this._chart = chart; }
  detached() { this._chart = null; }
  paneViews() { return [this]; }
  updateAllViews() {}
  zOrder() { return 'bottom'; }
  renderer() { return { draw: (t) => this._draw(t) }; }
  _draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = this._chart.timeScale();
      for (let i = 1; i < this.k.length; i++) {
        const v = this.k[i].value;
        let color = null;
        if (v >= this.ob) color = 'rgba(239,83,80,0.13)';
        else if (v <= this.os) color = 'rgba(38,166,154,0.13)';
        if (!color) continue;
        const x0 = ts.timeToCoordinate(this.k[i - 1].time);
        const x1 = ts.timeToCoordinate(this.k[i].time);
        if (x0 === null || x1 === null) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), mediaSize.height);
      }
    });
  }
}

/* ---------------- data loading ---------------- */
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}
async function loadSymbol() {
  const sym = state.symbol, tf = state.tf;
  document.title = `${sym} — chart-terminal`;
  try {
    const j = await apiGet(`/api/bars?symbol=${encodeURIComponent(sym)}&interval=${tf}&source=${state.source}`);
    bars = j.bars;
    candleSeries.setData(bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    refreshIndicators();
    restoreDrawings();
    chart.timeScale().fitContent();
    loadQuote();
    loadScan();
    loadTrades();
    saveState();
  } catch (e) { toast(e.message); }
}
async function loadQuote() {
  let j;
  try {
    j = await apiGet(`/api/quote?symbol=${encodeURIComponent(state.symbol)}&source=${state.source}`);
  } catch (e) { return; /* quote is a nice-to-have */ }
    const cls = j.changePct >= 0 ? 'up' : 'down';
    const arrow = j.changePct >= 0 ? '▲' : '▼';
    $('quote').innerHTML = `${j.symbol} <b>$${j.price.toFixed(2)}</b> <span class="${cls}">${arrow} ${Math.abs(j.changePct).toFixed(2)}%</span>`;
}
function saveState() { localStorage.setItem(LS_STATE, JSON.stringify(state)); }

/* ---------------- toolbar wiring ---------------- */
$('symbol-go').onclick = () => {
  const v = $('symbol-input').value.trim().toUpperCase();
  if (v && v !== state.symbol) { state.symbol = v; loadSymbol(); markWatchlist(); }
};
$('symbol-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('symbol-go').click(); });

document.querySelectorAll('#timeframes button').forEach(b => {
  if (b.dataset.tf === state.tf) { var _a = document.querySelector('#timeframes .active'); if (_a) _a.classList.remove('active'); b.classList.add('active'); }
  b.onclick = () => {
    var _b = document.querySelector('#timeframes .active'); if (_b) _b.classList.remove('active');
    b.classList.add('active');
    state.tf = b.dataset.tf; loadSymbol();
  };
});

$('ind-btn').onclick = () => $('ind-menu').classList.toggle('hidden');
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown')) $('ind-menu').classList.add('hidden');
});
document.querySelectorAll('#ind-menu input').forEach(cb => {
  cb.checked = !!state.ind[cb.dataset.ind];
  cb.onchange = () => { state.ind[cb.dataset.ind] = cb.checked; refreshIndicators(); saveState(); };
});

function setDrawMode(mode, btn) {
  drawMode = drawMode === mode ? null : mode;
  pendingPoint = null;
  ['tool-trend', 'tool-hline'].forEach(id => $(id).classList.remove('armed'));
  if (drawMode) { $(btn).classList.add('armed'); showHint(mode === 'trend' ? 'Click two points for the trend line (Esc to cancel)' : 'Click a price for the horizontal line (Esc to cancel)'); }
  else hideHint();
}
function showHint(t) { const h = $('draw-hint'); h.textContent = t; h.classList.remove('hidden'); }
function hideHint() { $('draw-hint').classList.add('hidden'); }
$('tool-trend').onclick = () => setDrawMode('trend', 'tool-trend');
$('tool-hline').onclick = () => setDrawMode('hline', 'tool-hline');
$('tool-clear').onclick = removeSelected;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawMode) setDrawMode(drawMode, drawMode === 'trend' ? 'tool-trend' : 'tool-hline');
  if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement.tagName !== 'INPUT') removeSelected();
});

chart.subscribeClick((param) => {
  if (!param.point || param.time === undefined) return;
  if (drawMode === 'trend') {
    const price = candleSeries.coordinateToPrice(param.point.y);
    if (price === null) return;
    const pt = { t: param.time, p: price };
    if (!pendingPoint) { pendingPoint = pt; showHint('Click the second point'); }
    else { attachDrawing(new TrendDrawing(pendingPoint, pt)); setDrawMode('trend', 'tool-trend'); }
    return;
  }
  if (drawMode === 'hline') {
    const price = candleSeries.coordinateToPrice(param.point.y);
    if (price !== null) { attachDrawing(new HLineDrawing(price)); setDrawMode('hline', 'tool-hline'); }
    return;
  }
  // selection mode: hit-test drawings topmost-first
  selectedDrawing = null;
  for (let i = drawings.length - 1; i >= 0; i--) {
    if (drawings[i].hitTest(param.point.x, param.point.y)) { selectedDrawing = drawings[i]; break; }
  }
  drawings.forEach(d => { d.selected = (d === selectedDrawing); });
  chart.timeScale().applyOptions({}); // nudge repaint
});

/* ---------------- OHLC legend ---------------- */
chart.subscribeCrosshairMove((param) => {
  const el = $('ohlc');
  const d = param.seriesData ? param.seriesData.get(candleSeries) : null;
  if (!d) { el.innerHTML = ''; return; }
  const col = d.close >= d.open ? 'var(--up)' : 'var(--down)';
  const f = (v) => v.toFixed(2);
  el.innerHTML = `O <b>${f(d.open)}</b> H <b>${f(d.high)}</b> L <b>${f(d.low)}</b> C <b style="color:${col}">${f(d.close)}</b>`;
});

/* ---------------- watchlist ---------------- */
let watchlist = [];
async function loadWatchlist() {
  try {
    watchlist = (await apiGet('/api/watchlist')).watchlist || [];
  } catch (e) { watchlist = ['SPY', 'QQQ', 'AAPL']; }
  renderWatchlist();
}
function renderWatchlist() {
  const ul = $('wl-list'); ul.innerHTML = '';
  watchlist.forEach(sym => {
    const li = document.createElement('li');
    li.textContent = sym;
    if (sym === state.symbol) li.classList.add('active');
    li.onclick = (e) => {
      if (e.target.classList.contains('rm')) return;
      state.symbol = sym; loadSymbol(); markWatchlist();
    };
    const rm = document.createElement('span');
    rm.textContent = '×'; rm.className = 'rm'; rm.title = 'Remove';
    rm.onclick = async () => {
      watchlist = watchlist.filter(s => s !== sym);
      await apiPost('/api/watchlist', { watchlist });
      renderWatchlist();
    };
    li.appendChild(rm); ul.appendChild(li);
  });
}
function markWatchlist() {
  document.querySelectorAll('#wl-list li').forEach(li => {
    li.classList.toggle('active', li.firstChild.textContent === state.symbol);
  });
}
$('wl-add').onclick = async () => {
  if (!watchlist.includes(state.symbol)) {
    watchlist.unshift(state.symbol);
    await apiPost('/api/watchlist', { watchlist });
    renderWatchlist();
  }
};

/* ---------------- settings ---------------- */
function hideMenus() {
  $('ind-menu').classList.add('hidden');
  $('draw-menu').classList.add('hidden');
  $('settings-pop').classList.add('hidden');
}
$('settings-btn').onclick = (e) => {
  e.stopPropagation();
  const wasHidden = $('settings-pop').classList.contains('hidden');
  hideMenus();
  if (wasHidden) { $('settings-pop').classList.remove('hidden'); refreshTdStatus(); }
};
document.addEventListener('click', (e) => {
  if (!$('settings-pop').classList.contains('hidden') && !$('settings-pop').contains(e.target)) {
    $('settings-pop').classList.add('hidden');
  }
});
async function refreshTdStatus() {
  try {
    const j = await apiGet('/api/tdkey');
    $('tdkey-status').textContent = j.configured ? '✓ key saved' : 'no key saved';
  } catch (e) { $('tdkey-status').textContent = ''; }
}
$('tdkey-save').onclick = async () => {
  const key = $('tdkey-input').value.trim();
  if (!key) { toast('paste a key first'); return; }
  try {
    await apiPost('/api/tdkey', { key });
    $('tdkey-input').value = '';
    toast('Twelve Data key saved');
    state.source = 'twelvedata'; saveState();
    await loadSources();
    $('source-sel').value = 'twelvedata';
    loadSymbol();
    refreshTdStatus();
  } catch (e) { toast('save failed: ' + e.message); }
};
$('tdkey-clear').onclick = async () => {
  try {
    await apiDelete('/api/tdkey');
    toast('key cleared');
    await loadSources();
    if (!$('source-sel').querySelector('option[value="twelvedata"]')) {
      state.source = 'yahoo'; saveState(); loadSymbol();
    }
    refreshTdStatus();
  } catch (e) { toast('clear failed: ' + e.message); }
};
async function loadSources() {
  const sel = $('source-sel');
  let avail = ['yahoo'];
  try { avail = (await apiGet('/api/sources')).sources || avail; } catch (e) { /* yahoo default */ }
  sel.innerHTML = '';
  avail.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s === 'yahoo' ? 'Yahoo' : 'Twelve Data';
    sel.appendChild(o);
  });
  if (!avail.includes(state.source)) state.source = 'yahoo';
  sel.value = state.source;
  sel.onchange = () => { state.source = sel.value; saveState(); loadSymbol(); };
}
/* ---------------- scan + trades tabs ---------------- */
document.querySelectorAll('.side-tabs button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.side-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['watchlist', 'scan', 'trades'].forEach(t => $('tab-' + t).classList.add('hidden'));
    $('tab-' + btn.dataset.tab).classList.remove('hidden');
  };
});

let scanData = null;
let scanLines = [];
function clearScanLines() {
  scanLines.forEach(l => { try { candleSeries.removePriceLine(l); } catch (e) {} });
  scanLines = [];
}
function drawScanLines() {
  clearScanLines();
  if (!scanData || !$('scan-lines').checked) return;
  const mk = (price, title, color) => {
    scanLines.push(candleSeries.createPriceLine({
      price, color, lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true, title,
    }));
  };
  scanData.candidates.slice(0, 5).forEach(c =>
    mk(c.strike, `P ${c.strike} ${String(c.expiration).slice(5)}`, '#ff9f43'));
  (scanData.leaps || []).slice(0, 3).forEach(c =>
    mk(c.strike, `C ${c.strike} ${String(c.expiration).slice(5)}`, '#2962ff'));
}
$('scan-lines').onchange = drawScanLines;

async function loadScan() {
  const sym = state.symbol;
  $('scan-meta').textContent = 'loading…';
  $('scan-body').innerHTML = '';
  clearScanLines();
  try {
    const j = await apiGet(`/api/scan?symbol=${encodeURIComponent(sym)}`);
    scanData = j;
    const when = j.scanned_at ? new Date(j.scanned_at * 1000).toLocaleDateString() : 'never';
    $('scan-meta').textContent = `Scanned ${when} · ${j.candidates.length} puts · ${(j.leaps || []).length} leaps`;
    if (!j.candidates.length && !(j.leaps || []).length) {
      $('scan-body').innerHTML = '<div class="tab-meta">No scan data for this symbol.</div>';
      return;
    }
    $('scan-body').innerHTML = j.candidates.slice(0, 5).map(c => `
      <div class="scan-card">
        <b>Put $${c.strike}</b> <span class="k">${c.expiration} · ${c.dte} DTE</span><br>
        <span class="k">VRP</span> ${(c.vrp * 100).toFixed(1)}% · <span class="k">IV</span> ${(c.iv * 100).toFixed(0)}% · <span class="k">HV</span> ${(c.hv * 100).toFixed(0)}%<br>
        <span class="k">Net prem</span> $${c.net_premium.toFixed(0)} · <span class="k">Ann ROI</span> ${(c.ann_roi * 100).toFixed(1)}%
      </div>`).join('');
    drawScanLines();
  } catch (e) {
    $('scan-meta').textContent = 'scan unavailable';
    scanData = null;
  }
}

async function loadTrades() {
  const sym = state.symbol;
  $('trades-meta').textContent = 'loading…';
  $('trades-list').innerHTML = '';
  try {
    const j = await apiGet(`/api/ptrades?symbol=${encodeURIComponent(sym)}`);
    const tr = j.trades || [];
    $('trades-meta').textContent = tr.length
      ? `${tr.length} trade${tr.length > 1 ? 's' : ''} · ${j.db || ''}`
      : `no trades · ${j.db || 'no ledger'}`;
    const markers = [];
    tr.forEach(t => {
      const a = (t.action || '').toLowerCase();
      const isBuy = a.startsWith('buy');
      const isSell = a.startsWith('sell') || a.startsWith('close');
      const cls = isBuy ? 't-buy' : isSell ? 't-sell' : 't-other';
      const li = document.createElement('li');
      const d = new Date(t.time * 1000).toLocaleDateString();
      li.innerHTML = `<span class="${cls}">${t.action}</span> ${t.qty} @ $${Number(t.price).toFixed(2)} <span class="k">${d}</span>${t.strategy ? ` <span class="k">${t.strategy}</span>` : ''}`;
      $('trades-list').appendChild(li);
      markers.push({
        time: t.time,
        position: isSell ? 'aboveBar' : 'belowBar',
        color: isBuy ? '#26a69a' : isSell ? '#ef5350' : '#2962ff',
        shape: isSell ? 'arrowDown' : 'arrowUp',
        text: (isBuy ? 'B' : isSell ? 'S' : '•') + (t.qty ? ` ${t.qty}` : ''),
      });
    });
    candleSeries.setMarkers(markers);
  } catch (e) {
    $('trades-meta').textContent = 'trades unavailable';
    try { candleSeries.setMarkers([]); } catch (e2) {}
  }
}

/* ---------------- boot ---------------- */
const APP_VER = '0.1.6';
// Bridge self-test: the header badge reports whether the app can actually
// reach its Rust backend, so a screenshot is a complete diagnostic.
$('app-ver').textContent = 'v' + APP_VER + (TAURI_CORE ? ' …' : ' • web');
if (TAURI_CORE) {
  TAURI_CORE.invoke('get_sources').then(
    () => { $('app-ver').textContent = 'v' + APP_VER + ' • ok'; },
    (e) => { $('app-ver').textContent = 'v' + APP_VER + ' • backend err'; console.warn('bridge test failed', e); }
  );
}
$('symbol-input').value = state.symbol;
sizeChart();
loadSources().then(() => loadWatchlist().then(() => { markWatchlist(); }));
loadSymbol();
setInterval(loadQuote, 60000);
