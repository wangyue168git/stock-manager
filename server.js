const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3457;
const PORTFOLIO_FILE = path.join(__dirname, "portfolio.json");
const HISTORY_FILE = path.join(__dirname, "history.json");
const MARKET_MAP = { sh: "1", sz: "0", hk: "116", crypto: "crypto" };
const US_PREFIXES = ["105", "106", "107"]; // NASDAQ, NYSE, NYSE Arca

// Auto-detect correct market for A-shares based on symbol prefix
function fixMarket(holding) {
  const sym = holding.symbol;
  if (/^\d{6}$/.test(sym)) {
    // A-share: 6xxxxx=Shanghai, 0xxxxx/3xxxxx=Shenzhen
    if (sym.startsWith("6")) return { ...holding, market: "sh" };
    if (sym.startsWith("0") || sym.startsWith("3")) return { ...holding, market: "sz" };
  }
  return holding;
}

// Auto-fetch exchange rate from open API
let cachedRate = null;
let rateLastFetch = 0;
const RATE_INTERVAL = 60 * 60 * 1000; // refresh every 1 hour

function fetchExchangeRate() {
  return new Promise((resolve) => {
    https.get("https://open.er-api.com/v6/latest/USD", {
      headers: { "User-Agent": "Mozilla/5.0" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.rates && j.rates.CNY) {
            cachedRate = {
              USD_CNY: Math.round(j.rates.CNY * 10000) / 10000,
              USD_HKD: j.rates.HKD ? Math.round(j.rates.HKD * 10000) / 10000 : 7.82,
            };
            rateLastFetch = Date.now();
            // Save to portfolio.json
            const p = loadPortfolio();
            p.exchangeRate = { USD_CNY: cachedRate.USD_CNY };
            savePortfolio(p);
            console.log(`Exchange rate updated: USD/CNY = ${cachedRate.USD_CNY}`);
          }
        } catch (e) {}
        resolve(cachedRate);
      });
    }).on("error", () => resolve(cachedRate));
  });
}

async function getExchangeRate() {
  if (!cachedRate || Date.now() - rateLastFetch > RATE_INTERVAL) {
    await fetchExchangeRate();
  }
  return cachedRate;
}

function loadPortfolio() {
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
  } catch (e) {
    return { exchangeRate: { USD_CNY: 6.88 }, accounts: [] };
  }
}

function savePortfolio(data) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(data, null, 2));
}

// ---- History tracking ----
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")); }
  catch (e) { return { snapshots: [] }; }
}

function saveHistoryFile(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data));
}

let lastSnapshotTime = 0;
const SNAPSHOT_INTERVAL = 60 * 1000; // 1 minute

function recordSnapshot(totalCNY, totalCost) {
  const now = Date.now();
  if (now - lastSnapshotTime < SNAPSHOT_INTERVAL) return;
  if (totalCNY <= 0) return;
  lastSnapshotTime = now;
  const history = loadHistory();
  history.snapshots.push({
    t: new Date().toISOString(),
    v: Math.round(totalCNY * 100) / 100,
    c: Math.round(totalCost * 100) / 100,
  });
  // Keep max 10000 entries (~7 days at 1-min intervals)
  if (history.snapshots.length > 10000) history.snapshots = history.snapshots.slice(-10000);
  saveHistoryFile(history);
}

// Fetch crypto prices from Binance API
function fetchCryptoPrices(symbols) {
  if (!symbols.length) return Promise.resolve({});
  return new Promise((resolve) => {
    const results = {};
    let done = 0;
    symbols.forEach((sym) => {
      const pair = `${sym}USDT`;
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`;
      https.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            results[`crypto.${sym}`] = {
              price: parseFloat(j.lastPrice) || 0,
              changePercent: parseFloat(j.priceChangePercent) || 0,
              change: parseFloat(j.priceChange) || 0,
              high: parseFloat(j.highPrice) || 0,
              low: parseFloat(j.lowPrice) || 0,
              open: parseFloat(j.openPrice) || 0,
              prevClose: parseFloat(j.prevClosePrice) || 0,
              name: sym,
            };
          } catch (e) {}
          if (++done === symbols.length) resolve(results);
        });
      }).on("error", () => { if (++done === symbols.length) resolve(results); });
    });
  });
}

// Fetch stock prices from East Money API (supports A-shares + US + HK)
function fetchStockPrices(holdings) {
  if (!holdings.length) return Promise.resolve({});
  const isUS = (m) => m === "nasdaq" || m === "nyse";
  const secidList = [];
  holdings.forEach((h) => {
    if (isUS(h.market)) {
      // Try all US exchange prefixes to auto-detect
      US_PREFIXES.forEach((p) => secidList.push(`${p}.${h.symbol}`));
    } else {
      secidList.push(`${MARKET_MAP[h.market]}.${h.symbol}`);
    }
  });
  const secids = secidList.join(",");
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?ut=fa5fd1943c7b386f172d6893dbfba10b&invt=2&fltt=2&fields=f2,f3,f4,f12,f13,f14,f15,f16,f17,f18&secids=${secids}`;

  return new Promise((resolve, reject) => {
    https
      .get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Referer: "https://www.eastmoney.com",
        },
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const prices = {};
            if (json.data && json.data.diff) {
              json.data.diff.forEach((item) => {
                prices[`${item.f13}.${item.f12}`] = {
                  price: typeof item.f2 === "number" ? item.f2 : 0,
                  changePercent: typeof item.f3 === "number" ? item.f3 : 0,
                  change: typeof item.f4 === "number" ? item.f4 : 0,
                  name: item.f14 || "",
                  high: typeof item.f15 === "number" ? item.f15 : 0,
                  low: typeof item.f16 === "number" ? item.f16 : 0,
                  open: typeof item.f17 === "number" ? item.f17 : 0,
                  prevClose: typeof item.f18 === "number" ? item.f18 : 0,
                };
              });
            }
            resolve(prices);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// Fetch all prices (stocks + crypto)
async function fetchPrices(holdings) {
  const stockHoldings = holdings.filter((h) => h.market !== "crypto");
  const cryptoSymbols = holdings.filter((h) => h.market === "crypto").map((h) => h.symbol);
  const [stockPrices, cryptoPrices] = await Promise.all([
    fetchStockPrices(stockHoldings),
    fetchCryptoPrices(cryptoSymbols),
  ]);
  return { ...stockPrices, ...cryptoPrices };
}

// HTTP Server
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, "http://localhost");

  if (urlObj.pathname === "/" || urlObj.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  // API: get portfolio
  if (urlObj.pathname === "/api/portfolio" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadPortfolio()));
    return;
  }

  // API: add account
  if (urlObj.pathname === "/api/account" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const acc = JSON.parse(body);
        const p = loadPortfolio();
        p.accounts.push({ name: acc.name, currency: acc.currency, holdings: [] });
        savePortfolio(p);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: add holding
  if (urlObj.pathname === "/api/holding" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holding } = JSON.parse(body);
        const p = loadPortfolio();
        if (p.accounts[accountIndex]) {
          p.accounts[accountIndex].holdings.push(holding);
          savePortfolio(p);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end("Invalid account");
        }
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: delete holding
  if (urlObj.pathname === "/api/holding" && req.method === "DELETE") {
    const ai = parseInt(urlObj.searchParams.get("account"));
    const hi = parseInt(urlObj.searchParams.get("index"));
    const p = loadPortfolio();
    if (p.accounts[ai] && p.accounts[ai].holdings[hi]) {
      p.accounts[ai].holdings.splice(hi, 1);
      savePortfolio(p);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(400);
      res.end("Not found");
    }
    return;
  }

  // API: update exchange rate
  if (urlObj.pathname === "/api/rate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { rate } = JSON.parse(body);
        const p = loadPortfolio();
        p.exchangeRate = { USD_CNY: parseFloat(rate) };
        savePortfolio(p);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ---- K-line & Technical Analysis ----
const klineCache = {};
let klineLastFetch = 0;
const KLINE_INTERVAL = 10 * 60 * 1000; // refresh every 10 min
const resolvedSecids = {}; // cache correct secid for US stocks

function fetchKline(secid) {
  return new Promise((resolve) => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=120`;
    https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", Referer: "https://www.eastmoney.com" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.data && j.data.klines) {
            resolve(j.data.klines.map((k) => {
              const [date, open, close, high, low, vol] = k.split(",");
              return { date, o: +open, c: +close, h: +high, l: +low, v: +vol };
            }));
          } else resolve([]);
        } catch (e) { resolve([]); }
      });
    }).on("error", () => resolve([]));
  });
}

function calcTechnicals(klines, curPrice, costPrice) {
  if (!klines.length || !curPrice) return null;
  const closes = klines.map((k) => k.c);
  const highs = klines.map((k) => k.h);
  const lows = klines.map((k) => k.l);

  const ma = (arr, n) => arr.length >= n ? +(arr.slice(-n).reduce((a, b) => a + b, 0) / n).toFixed(4) : null;
  const ma5 = ma(closes, 5), ma10 = ma(closes, 10), ma20 = ma(closes, 20), ma60 = ma(closes, 60);

  const high60 = Math.max(...highs), low60 = Math.min(...lows);
  const high20 = Math.max(...highs.slice(-20)), low20 = Math.min(...lows.slice(-20));

  // Fibonacci retracement from 60-day range
  const range = high60 - low60;
  const fib236 = +(low60 + range * 0.236).toFixed(4);
  const fib382 = +(low60 + range * 0.382).toFixed(4);
  const fib500 = +(low60 + range * 0.5).toFixed(4);
  const fib618 = +(low60 + range * 0.618).toFixed(4);

  // Find local minimums as support (scan last 60 bars)
  const localMins = [];
  const scan = klines.slice(-60);
  for (let i = 2; i < scan.length - 2; i++) {
    if (scan[i].l < scan[i - 1].l && scan[i].l < scan[i - 2].l && scan[i].l < scan[i + 1].l && scan[i].l < scan[i + 2].l) {
      localMins.push(scan[i].l);
    }
  }

  // Collect support levels below current price
  const supSet = new Set();
  [ma5, ma10, ma20, ma60].forEach((m) => { if (m && m < curPrice && m > curPrice * 0.7) supSet.add(+m.toFixed(3)); });
  [fib382, fib500, fib236].forEach((f) => { if (f < curPrice && f > curPrice * 0.7) supSet.add(f); });
  localMins.forEach((m) => { if (m < curPrice && m > curPrice * 0.7) supSet.add(m); });
  if (low20 < curPrice) supSet.add(low20);
  const supports = [...supSet].sort((a, b) => b - a).slice(0, 4);

  // Resistance levels above current price
  const resSet = new Set();
  [ma5, ma10, ma20, ma60].forEach((m) => { if (m && m > curPrice && m < curPrice * 1.3) resSet.add(+m.toFixed(3)); });
  [fib618, fib500].forEach((f) => { if (f > curPrice && f < curPrice * 1.3) resSet.add(f); });
  if (high20 > curPrice) resSet.add(high20);
  const resistances = [...resSet].sort((a, b) => a - b).slice(0, 3);

  // Recommended entry levels: support levels below current price, plus -5% / -10% from cost if in loss
  const entries = [];
  supports.slice(0, 3).forEach((s) => entries.push({ price: s, reason: "支撑位" }));
  if (costPrice && curPrice < costPrice) {
    const avg = +(costPrice * 0.9).toFixed(4);
    if (avg < curPrice && !entries.find((e) => Math.abs(e.price - avg) / avg < 0.01)) {
      entries.push({ price: avg, reason: "成本-10%" });
    }
  }
  // Sort by price descending
  entries.sort((a, b) => b.price - a.price);

  return { ma5, ma10, ma20, ma60, high60, low60, high20, low20, fib382, fib500, fib618, supports, resistances, entries: entries.slice(0, 4) };
}

async function refreshKlines(prices) {
  const now = Date.now();
  if (now - klineLastFetch < KLINE_INTERVAL && Object.keys(klineCache).length > 0) return;
  klineLastFetch = now;
  console.log("Refreshing K-line data...");

  const portfolio = loadPortfolio();
  const tasks = [];
  portfolio.accounts.forEach((acc) => {
    acc.holdings.forEach((h) => {
      const fixed = fixMarket(h);
      if (fixed.market === "crypto") return; // skip crypto
      let secid;
      const isUS = fixed.market === "nasdaq" || fixed.market === "nyse";
      if (isUS) {
        if (resolvedSecids[fixed.symbol]) {
          secid = resolvedSecids[fixed.symbol];
        } else {
          for (const pfx of US_PREFIXES) {
            if (prices[`${pfx}.${fixed.symbol}`]) {
              secid = `${pfx}.${fixed.symbol}`;
              resolvedSecids[fixed.symbol] = secid;
              break;
            }
          }
        }
      } else {
        secid = `${MARKET_MAP[fixed.market]}.${fixed.symbol}`;
      }
      if (secid) {
        tasks.push(fetchKline(secid).then((klines) => { klineCache[fixed.symbol] = klines; }));
      }
    });
  });
  await Promise.all(tasks);
  console.log(`K-line data updated for ${tasks.length} stocks`);
}

// WebSocket
const wss = new WebSocketServer({ server });
let latestData = null;

async function refreshPrices() {
  try {
    await getExchangeRate();
    const portfolio = loadPortfolio();
    const allHoldings = [];
    portfolio.accounts.forEach((acc) => acc.holdings.forEach((h) => allHoldings.push(fixMarket(h))));
    const prices = await fetchPrices(allHoldings);
    await refreshKlines(prices);

    const result = {
      exchangeRate: portfolio.exchangeRate,
      accounts: portfolio.accounts.map((acc) => ({
        ...acc,
        holdings: acc.holdings.map((h) => {
          const fixed = fixMarket(h);
          // For US stocks, match by symbol (since we try multiple prefixes)
          const isUS = fixed.market === "nasdaq" || fixed.market === "nyse";
          let p = {};
          if (isUS) {
            // Find by symbol across any US prefix
            for (const pfx of US_PREFIXES) {
              if (prices[`${pfx}.${fixed.symbol}`]) {
                p = prices[`${pfx}.${fixed.symbol}`];
                break;
              }
            }
          } else if (fixed.market === "crypto") {
            p = prices[`crypto.${fixed.symbol}`] || {};
          } else {
            p = prices[`${MARKET_MAP[fixed.market]}.${fixed.symbol}`] || {};
          }
          const price = p.price || 0;
          const mv = price * h.shares;
          const cv = h.costPrice * h.shares;
          const pnl = mv - cv;
          const pnlPct = cv > 0 ? (pnl / cv) * 100 : 0;
          const tech = klineCache[fixed.symbol] ? calcTechnicals(klineCache[fixed.symbol], price, h.costPrice) : null;
          return {
            ...h,
            currentPrice: price,
            changePercent: p.changePercent || 0,
            change: p.change || 0,
            high: p.high || 0,
            low: p.low || 0,
            open: p.open || 0,
            prevClose: p.prevClose || 0,
            marketValue: mv,
            costValue: cv,
            pnl,
            pnlPercent: pnlPct,
            tech,
          };
        }),
      })),
      timestamp: new Date().toISOString(),
    };

    // Calculate totals and record history
    const rate = portfolio.exchangeRate?.USD_CNY || 6.88;
    let totalCNY = 0, totalCost = 0;
    result.accounts.forEach((acc) => {
      const cur = acc.currency || "CNY";
      acc.holdings.forEach((h) => {
        const mul = cur === "USD" ? rate : cur === "HKD" ? rate / 7.8 : 1;
        totalCNY += (h.marketValue || 0) * mul;
        totalCost += (h.costValue || 0) * mul;
      });
    });
    recordSnapshot(totalCNY, totalCost);
    result.history = loadHistory().snapshots;

    latestData = result;
    const msg = JSON.stringify({ type: "portfolio", data: result });
    wss.clients.forEach((c) => {
      if (c.readyState === 1) c.send(msg);
    });
  } catch (e) {
    console.error("Price fetch error:", e.message);
  }
}

wss.on("connection", (ws) => {
  if (latestData) ws.send(JSON.stringify({ type: "portfolio", data: latestData }));
});

setInterval(refreshPrices, 5000);
refreshPrices();

server.listen(PORT, () => {
  console.log(`Stock Manager running at http://localhost:${PORT}`);
});
