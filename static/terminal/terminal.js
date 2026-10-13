/* E. BARRAZA TERMINAL — frontend */
"use strict";

const $ = (id) => document.getElementById(id);
const AMBER = "#ffa028", GRID = "#1a1206";

function fmt(n, d = 2) {
    if (n === null || n === undefined || isNaN(n)) return "---";
    return Number(n).toLocaleString("en-US",
        { minimumFractionDigits: d, maximumFractionDigits: d });
}
function chgCls(v) { return v > 0 ? "up" : v < 0 ? "dn" : "gry"; }
function nodata(msg) { return `<div class="nodata">${msg || "NO DATA"}</div>`; }
async function get(url) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
}

/* ---------- clock ---------- */
setInterval(() => {
    $("clock").textContent =
        new Date().toLocaleTimeString("en-US", { hour12: false });
}, 1000);

/* ---------- view nav ---------- */
const VIEWS = ["market", "chart", "portfolio", "scanner", "risk"];
const loaded = {};
function show(view) {
    VIEWS.forEach((v) => {
        $("v-" + v).classList.toggle("active", v === view);
        document.querySelector(`.fkey[data-v="${v}"]`)
            .classList.toggle("active", v === view);
    });
    if (!loaded[view]) { loaded[view] = true; LOADERS[view](); }
    if (view === "chart") setTimeout(sizeCharts, 30);
    if (view === "portfolio") setTimeout(sizeCharts, 30);
}
document.querySelectorAll(".fkey").forEach((el) =>
    el.addEventListener("click", () => show(el.dataset.v)));

document.addEventListener("keydown", (e) => {
    if (e.key >= "F1" && e.key <= "F5") {
        e.preventDefault();
        show(VIEWS[parseInt(e.key.slice(1)) - 1]);
        return;
    }
    const tag = (document.activeElement || {}).tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    if (e.key === "r" || e.key === "R") { refreshMarket(); }
});

/* ---------- command line ---------- */
$("cmdinput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        const sym = $("cmdinput").value.trim().toUpperCase()
            .replace(/<GO>|\s+/g, "");
        if (sym) { loadChart(sym); show("chart"); }
        $("cmdinput").value = "";
    } else if (e.key === "Escape") {
        $("cmdinput").value = "";
    }
});
// keep the fake block cursor aligned with typed text
$("cmdinput").addEventListener("input", () => {
    $("cursor").style.marginLeft =
        (-224 + $("cmdinput").value.length * 8.4) + "px";
});

/* ---------- charts ---------- */
let chart = null, candle = null, eChart = null, eSeries = null;
function baseOpts() {
    return {
        layout: { background: { color: "#000000" }, textColor: AMBER,
                  fontFamily: "'Courier New', monospace" },
        grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
        crosshair: { vertLine: { color: AMBER, labelBackgroundColor: AMBER },
                     horzLine: { color: AMBER, labelBackgroundColor: AMBER } },
        timeScale: { borderColor: "#3a2a10" },
        rightPriceScale: { borderColor: "#3a2a10" },
    };
}
function sizeCharts() {
    [["chart-wrap", chart], ["equity-wrap", eChart]].forEach(([id, c]) => {
        if (!c) return;
        const el = $(id);
        c.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
}
window.addEventListener("resize", sizeCharts);

/* ---------- F1 market ---------- */
let watchlist = [];
async function refreshMarket() {
    const { j } = await get("/api/watchlist");
    watchlist = (j.watchlist || []);
    if (!watchlist.length) {
        $("mkt-body").innerHTML = nodata("NO WATCHLIST DATA");
        $("datastat").textContent = "DATA: NO WATCHLIST";
        return;
    }
    const { ok, j: q } = await get(
        "/api/quotes?symbols=" + watchlist.join(","));
    const rows = ok ? q.quotes : [];
    let html = `<table><tr><th>SYMBOL</th><th class="num">LAST</th>` +
        `<th class="num">CHG%</th></tr>`;
    rows.forEach((r) => {
        if (r.error) {
            html += `<tr><td class="amb">${r.symbol}</td>` +
                `<td colspan="2" class="gry">NO DATA</td></tr>`;
        } else {
            html += `<tr style="cursor:pointer" onclick="loadChart('${r.symbol}');show('chart')">` +
                `<td class="amb">${r.symbol}</td>` +
                `<td class="num wht">${fmt(r.price)}</td>` +
                `<td class="num ${chgCls(r.changePct)}">` +
                `${r.changePct > 0 ? "+" : ""}${fmt(r.changePct)}%</td></tr>`;
        }
    });
    html += "</table>";
    $("mkt-body").innerHTML = html;
    $("datastat").textContent =
        "DATA: YAHOO " + new Date().toLocaleTimeString("en-US", { hour12: false });
}
setInterval(refreshMarket, 45000);

/* ---------- F2 chart ---------- */
let curSym = null, curTf = "4h";
async function loadChart(sym) {
    curSym = sym;
    $("q-sym").textContent = sym;
    const { ok, j } = await get(
        `/api/bars?symbol=${sym}&interval=${curTf}`);
    if (!ok || !j.bars || !j.bars.length) {
        $("q-price").textContent = "";
        $("q-chg").textContent = "";
        $("q-chg").className = "";
        if (chart) candle.setData([]);
        return;
    }
    if (!chart) {
        chart = LightweightCharts.createChart($("chart"), baseOpts());
        candle = chart.addSeries(LightweightCharts.CandlestickSeries, {
            upColor: "#00ff00", downColor: "#ff2020",
            wickUpColor: "#00ff00", wickDownColor: "#ff2020",
            borderVisible: false,
        });
    }
    candle.setData(j.bars.map((b) => ({
        time: b.time, open: b.open, high: b.high,
        low: b.low, close: b.close })));
    chart.timeScale().fitContent();
    sizeCharts();
    const last = j.bars[j.bars.length - 1].close;
    const first = j.bars[0].open;
    const chg = (last - first) / first * 100;
    $("q-price").textContent = fmt(last);
    $("q-chg").textContent = `${chg >= 0 ? "+" : ""}${fmt(chg)}%`;
    $("q-chg").className = chgCls(chg);
}
document.querySelectorAll("#tfbar button").forEach((b) =>
    b.addEventListener("click", () => {
        document.querySelectorAll("#tfbar button")
            .forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        curTf = b.dataset.tf;
        if (curSym) loadChart(curSym);
    }));

/* ---------- F3 portfolio ---------- */
async function loadPortfolio() {
    const { j: dbj } = await get("/api/pt/db");
    $("pt-db").textContent = dbj.db ? `(LEDGER: ${dbj.db})` : "(NO LEDGER)";

    const { j: s } = await get("/api/pt/summary");
    const cls = chgCls(s.return_pct);
    $("pt-stats").innerHTML =
        stat("EQUITY", "$" + fmt(s.equity), "wht") +
        stat("CASH", "$" + fmt(s.cash), "gry") +
        stat("RETURN", `${s.return_pct >= 0 ? "+" : ""}${fmt(s.return_pct)}%`, cls) +
        stat("MAX DD", fmt(s.max_drawdown_pct) + "%", "dn") +
        stat("MARKS", String(s.n_points), "amb");

    const { j: eq } = await get("/api/pt/equity");
    if (eq.curve && eq.curve.length) {
        if (!eChart) {
            eChart = LightweightCharts.createChart($("equity-chart"), baseOpts());
            eSeries = eChart.addSeries(LightweightCharts.AreaSeries, {
                lineColor: AMBER, topColor: "rgba(255,160,40,0.4)",
                bottomColor: "rgba(255,160,40,0.0)",
            });
        }
        eSeries.setData(eq.curve.map((p) => ({
            time: p.ts.slice(0, 10), value: p.equity })));
        eChart.timeScale().fitContent();
    } else {
        $("equity-wrap").innerHTML = nodata("NO EQUITY DATA");
    }

    const { j: pos } = await get("/api/pt/positions");
    $("pos-asof").textContent = pos.as_of ? `AS OF ${pos.as_of.slice(0, 10)}` : "";
    if (!pos.positions || !pos.positions.length) {
        $("pos-body").innerHTML = nodata("FLAT — NO OPEN POSITIONS");
    } else {
        let h = `<table><tr><th>POSITION</th><th class="num">QTY</th>` +
            `<th class="num">MARK</th></tr>`;
        pos.positions.forEach((p) => {
            h += `<tr><td class="amb">${p.pkey}</td>` +
                `<td class="num ${p.qty < 0 ? "dn" : "wht"}">${fmt(p.qty, 1)}</td>` +
                `<td class="num wht">${fmt(p.mark, 4)}</td></tr>`;
        });
        $("pos-body").innerHTML = h + "</table>";
    }

    const { j: st } = await get("/api/pt/strategies");
    if (!st.strategies || !st.strategies.length) {
        $("strat-body").innerHTML = nodata("NO STRATEGY DATA");
    } else {
        let h = `<table><tr><th>STRATEGY</th><th class="num">NET P&amp;L</th>` +
            `<th class="num">TRADES</th></tr>`;
        st.strategies.forEach((r) => {
            h += `<tr><td class="amb">${r.strategy}</td>` +
                `<td class="num ${chgCls(r.net)}">${r.net >= 0 ? "+" : ""}$${fmt(r.net)}</td>` +
                `<td class="num gry">${r.n_trades}</td></tr>`;
        });
        $("strat-body").innerHTML = h + "</table>";
    }

    const { j: tr } = await get("/api/pt/trades?limit=15");
    if (!tr.trades || !tr.trades.length) {
        $("trades-body").innerHTML = nodata("NO TRADES");
    } else {
        let h = `<table><tr><th>DATE</th><th>SYM</th><th>ACTION</th>` +
            `<th class="num">QTY</th><th class="num">PRICE</th></tr>`;
        tr.trades.forEach((t) => {
            const buy = /buy/i.test(t.action);
            h += `<tr><td class="gry">${String(t.ts).slice(0, 10)}</td>` +
                `<td class="amb">${t.symbol}</td>` +
                `<td class="${buy ? "up" : "dn"}">${t.action}</td>` +
                `<td class="num wht">${fmt(t.qty, 1)}</td>` +
                `<td class="num wht">${fmt(t.price, 4)}</td></tr>`;
        });
        $("trades-body").innerHTML = h + "</table>";
    }
    sizeCharts();
}
function stat(k, v, c) {
    return `<div class="stat"><div class="k">${k}</div>` +
        `<div class="v ${c}">${v}</div></div>`;
}

/* ---------- F4 scanner ---------- */
async function loadScanner() {
    const sel = $("scan-sym");
    if (!sel.options.length) {
        watchlist.forEach((s) => {
            const o = document.createElement("option");
            o.value = o.textContent = s;
            sel.appendChild(o);
        });
        sel.value = watchlist.includes("APP") ? "APP" : watchlist[0];
        sel.addEventListener("change", loadScanner);
    }
    const sym = sel.value;
    const { ok, j } = await get("/api/scan?symbol=" + sym);
    if (!ok || (!j.candidates.length && !j.leaps.length)) {
        $("csp-body").innerHTML = nodata(`NO SCAN DATA FOR ${sym}`);
        $("leaps-body").innerHTML = "";
        $("scan-at").textContent = "";
        return;
    }
    $("scan-at").textContent = j.scanned_at
        ? "SCANNED " + new Date(j.scanned_at * 1000).toLocaleString() : "";
    let h = `<table><tr><th>STRIKE</th><th>EXP</th><th class="num">DTE</th>` +
        `<th class="num">VRP</th><th class="num">IV</th><th class="num">HV</th>` +
        `<th class="num">BID</th><th class="num">NET PREM</th>` +
        `<th class="num">ANN ROI</th></tr>`;
    j.candidates.forEach((c) => {
        h += `<tr><td class="wht">${fmt(c.strike, 0)}</td>` +
            `<td class="gry">${c.expiration}</td>` +
            `<td class="num gry">${c.dte}</td>` +
            `<td class="num up">${fmt(c.vrp, 1)}</td>` +
            `<td class="num gry">${fmt(c.iv * 100, 1)}%</td>` +
            `<td class="num gry">${fmt(c.hv * 100, 1)}%</td>` +
            `<td class="num wht">${fmt(c.bid, 2)}</td>` +
            `<td class="num wht">$${fmt(c.net_premium)}</td>` +
            `<td class="num up">${fmt(c.ann_roi, 1)}%</td></tr>`;
    });
    $("csp-body").innerHTML = h + "</table>";

    let l = `<table><tr><th>STRIKE</th><th>EXP</th><th class="num">DTE</th>` +
        `<th class="num">ASK</th><th class="num">BREAKEVEN</th>` +
        `<th class="num">REQ RALLY</th><th class="num">DELTA</th></tr>`;
    j.leaps.forEach((c) => {
        l += `<tr><td class="wht">${fmt(c.strike, 0)}</td>` +
            `<td class="gry">${c.expiration}</td>` +
            `<td class="num gry">${c.dte}</td>` +
            `<td class="num wht">${fmt(c.ask, 2)}</td>` +
            `<td class="num wht">${fmt(c.breakeven, 2)}</td>` +
            `<td class="num amb">${fmt(c.req_rally, 1)}%</td>` +
            `<td class="num gry">${fmt(c.delta, 2)}</td></tr>`;
    });
    $("leaps-body").innerHTML = l + "</table>";
}

/* ---------- F5 risk ---------- */
async function loadRisk() {
    const { j } = await get("/api/pt/rejections");
    const ks = j.killswitch_status || "UNKNOWN";
    $("kill-body").innerHTML =
        `<div class="${j.killswitch_tripped && j.killswitch_tripped.length
            ? "kill-tripped" : "kill-armed"}">${ks}</div>`;
    if (!j.total) {
        $("rej-body").innerHTML = nodata("NO REJECTIONS RECORDED");
    } else {
        let h = `<table><tr><th>REASON</th><th class="num">COUNT</th></tr>`;
        Object.entries(j.by_reason)
            .sort((a, b) => b[1] - a[1])
            .forEach(([reason, n]) => {
                h += `<tr><td class="amb">${reason}</td>` +
                    `<td class="num wht">${n}</td></tr>`;
            });
        $("rej-body").innerHTML =
            h + `</table><div class="gry" style="padding-top:6px">` +
            `TOTAL REJECTIONS: <span class="wht">${j.total}</span></div>`;
    }
    const { j: rk } = await get("/api/pt/risk");
    if (!rk.risk_events || !rk.risk_events.length) {
        $("risk-body").innerHTML = nodata("NO RISK EVENTS");
    } else {
        let h = `<table><tr><th>TIME</th><th>STRAT</th><th>SYM</th>` +
            `<th>ACTION</th><th>REASON</th></tr>`;
        rk.risk_events.slice(0, 40).forEach((e) => {
            h += `<tr><td class="gry">${String(e.ts).slice(0, 16).replace("T", " ")}</td>` +
                `<td class="gry">${e.strategy}</td>` +
                `<td class="amb">${e.symbol}</td>` +
                `<td class="dn">${e.action}</td>` +
                `<td class="amb">${e.reason}</td></tr>`;
        });
        $("risk-body").innerHTML = h + "</table>";
    }
}

const LOADERS = {
    market: refreshMarket,
    chart: () => { if (!curSym && watchlist.length) loadChart(watchlist[0]); },
    portfolio: loadPortfolio,
    scanner: loadScanner,
    risk: loadRisk,
};

/* boot */
(async function () {
    await refreshMarket();
    loaded.market = true;
    $("cmdinput").focus();
})();
