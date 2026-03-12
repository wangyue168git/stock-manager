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

// ---- Auth ----
const crypto = require("crypto");
const AUTH_HASH = "c60db372f8279a8e774c102278dbbdcee7c510969bb4c861728b90800a4569fa";
const AUTH_SALT = "stock-manager-salt:";
const validTokens = new Set();

function verifyPassword(pwd) {
  const hash = crypto.createHash("sha256").update(AUTH_SALT + pwd).digest("hex");
  return hash === AUTH_HASH;
}

function generateToken() {
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.add(token);
  return token;
}

function checkAuth(req) {
  const token = req.headers["x-auth-token"];
  return token && validTokens.has(token);
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

// Fetch crypto prices - try CryptoCompare first, then Coinbase, then Binance
function fetchCryptoPrices(symbols) {
  if (!symbols.length) return Promise.resolve({});
  return new Promise((resolve) => {
    const results = {};
    let done = 0;
    symbols.forEach((sym) => {
      // Primary: CryptoCompare (works globally)
      const ccUrl = `https://min-api.cryptocompare.com/data/price?fsym=${sym}&tsyms=USD`;
      https.get(ccUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.USD) {
              const price = parseFloat(j.USD);
              results[`crypto.${sym}`] = {
                price, changePercent: 0, change: 0,
                high: price, low: price, open: price, prevClose: price,
                name: sym,
              };
              if (++done === symbols.length) resolve(results);
              return;
            }
            throw new Error("no data");
          } catch (e) {
            // Fallback to Coinbase
            fetchCryptoCoinbase(sym, results, () => {
              if (++done === symbols.length) resolve(results);
            });
          }
        });
      }).on("error", () => {
        fetchCryptoCoinbase(sym, results, () => {
          if (++done === symbols.length) resolve(results);
        });
      });
    });
  });
}

function fetchCryptoCoinbase(sym, results, cb) {
  const url = `https://api.coinbase.com/v2/prices/${sym}-USD/spot`;
  https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 }, (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      try {
        const j = JSON.parse(data);
        if (j.data && j.data.amount) {
          const price = parseFloat(j.data.amount);
          results[`crypto.${sym}`] = {
            price, changePercent: 0, change: 0,
            high: price, low: price, open: price, prevClose: price, name: sym,
          };
          cb();
          return;
        }
        throw new Error("no data");
      } catch (e) {
        fetchCryptoBinance(sym, results, cb);
      }
    });
  }).on("error", () => fetchCryptoBinance(sym, results, cb));
}

function fetchCryptoBinance(sym, results, cb) {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}USDT`;
  https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
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
      cb();
    });
  }).on("error", () => cb());
}

// Convert holding to Sina API symbol format
function toSinaSymbol(h) {
  const isUS = (m) => m === "nasdaq" || m === "nyse";
  if (h.market === "sh") return `sh${h.symbol}`;
  if (h.market === "sz") return `sz${h.symbol}`;
  if (h.market === "hk") return `hk${h.symbol}`;
  if (isUS(h.market)) return `gb_${h.symbol.toLowerCase()}`;
  return null;
}

// Fetch stock prices from Sina Finance API (works globally)
function fetchStockPrices(holdings) {
  if (!holdings.length) return Promise.resolve({});
  const symbolMap = {};
  const sinaSymbols = [];
  holdings.forEach((h) => {
    const ss = toSinaSymbol(h);
    if (ss) {
      sinaSymbols.push(ss);
      symbolMap[ss] = h;
    }
  });
  const url = `https://hq.sinajs.cn/list=${sinaSymbols.join(",")}`;

  return new Promise((resolve, reject) => {
    https
      .get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Referer: "https://finance.sina.com.cn",
        },
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const prices = {};
            const lines = data.split("\n").filter((l) => l.trim());
            lines.forEach((line) => {
              const match = line.match(/var hq_str_(\w+)="(.*)"/);
              if (!match || !match[2]) return;
              const sinaKey = match[1];
              const parts = match[2].split(",");
              const h = symbolMap[sinaKey];
              if (!h) return;

              const isUS = h.market === "nasdaq" || h.market === "nyse";
              const isHK = h.market === "hk";
              let price, open, high, low, prevClose, name;

              if (isUS) {
                // Sina US fields:
                // [0]name [1]price [2]changePct% [3]timestamp [4]change [5]open [6]high [7]low
                // [21]afterHoursPrice [22]ahChangePct% [23]ahChange [24]ahTime [25]closeTime [26]closePrice
                name = parts[0] || h.symbol;
                const regPrice = parseFloat(parts[1]) || 0;
                const regChangePct = parseFloat(parts[2]) || 0;
                const regChange = parseFloat(parts[4]) || 0;
                const ahPrice = parseFloat(parts[21]) || 0;
                const ahChangePct = parseFloat(parts[22]) || 0;
                const ahChange = parseFloat(parts[23]) || 0;
                const closePrice = parseFloat(parts[26]) || 0;

                // Use after-hours price if available, otherwise regular price
                if (ahPrice > 0) {
                  price = ahPrice;
                  // After-hours change is relative to regular close
                  prevClose = closePrice || (ahPrice - ahChange);
                  const totalChange = price - prevClose;
                  const totalChangePct = prevClose ? ((totalChange / prevClose) * 100) : 0;
                  high = parseFloat(parts[6]) || price;
                  low = parseFloat(parts[7]) || price;
                  open = parseFloat(parts[5]) || price;
                  const secid = `105.${h.symbol}`;
                  if (h.market === "nasdaq") resolvedSecids[h.symbol] = `105.${h.symbol}`;
                  else if (h.market === "nyse") resolvedSecids[h.symbol] = `106.${h.symbol}`;
                  prices[resolvedSecids[h.symbol] || secid] = {
                    price, changePercent: parseFloat(totalChangePct.toFixed(2)),
                    change: parseFloat(totalChange.toFixed(4)), name,
                    high, low, open, prevClose, afterHours: true,
                  };
                } else {
                  price = regPrice;
                  prevClose = price - regChange;
                  high = parseFloat(parts[6]) || price;
                  low = parseFloat(parts[7]) || price;
                  open = parseFloat(parts[5]) || price;
                  const secid = `105.${h.symbol}`;
                  if (h.market === "nasdaq") resolvedSecids[h.symbol] = `105.${h.symbol}`;
                  else if (h.market === "nyse") resolvedSecids[h.symbol] = `106.${h.symbol}`;
                  prices[resolvedSecids[h.symbol] || secid] = {
                    price, changePercent: regChangePct, change: regChange, name,
                    high, low, open, prevClose,
                  };
                }
              } else {
                // A-share: name,open,prevClose,price,high,low,...
                name = parts[0] || h.symbol;
                open = parseFloat(parts[1]) || 0;
                prevClose = parseFloat(parts[2]) || 0;
                price = parseFloat(parts[3]) || 0;
                high = parseFloat(parts[4]) || 0;
                low = parseFloat(parts[5]) || 0;
                const change = price - prevClose;
                const changePct = prevClose ? ((change / prevClose) * 100) : 0;
                const secid = `${MARKET_MAP[h.market]}.${h.symbol}`;
                prices[secid] = {
                  price, changePercent: parseFloat(changePct.toFixed(2)),
                  change: parseFloat(change.toFixed(4)), name,
                  high, low, open, prevClose,
                };
              }
            });
            resolve(prices);
          } catch (e) {
            console.error("Sina API parse error:", e.message);
            // Fallback to East Money API
            fetchStockPricesEastMoney(holdings).then(resolve).catch(reject);
          }
        });
      })
      .on("error", (e) => {
        console.error("Sina API error:", e.message);
        fetchStockPricesEastMoney(holdings).then(resolve).catch(reject);
      });
  });
}

// Fallback: East Money API (may not work from overseas)
function fetchStockPricesEastMoney(holdings) {
  if (!holdings.length) return Promise.resolve({});
  const isUS = (m) => m === "nasdaq" || m === "nyse";
  const secidList = [];
  holdings.forEach((h) => {
    if (isUS(h.market)) {
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
            resolve({});
          }
        });
      })
      .on("error", () => resolve({}));
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

  // API: auth
  if (urlObj.pathname === "/api/auth" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { password } = JSON.parse(body);
        if (verifyPassword(password)) {
          const token = generateToken();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, token }));
        } else {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "密码错误" }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: add account (auth required)
  if (urlObj.pathname === "/api/account" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
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

  // API: add holding (auth required)
  if (urlObj.pathname === "/api/holding" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
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

  // API: update holding (auth required)
  if (urlObj.pathname === "/api/holding" && req.method === "PUT") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holdingIndex, shares, costPrice } = JSON.parse(body);
        const p = loadPortfolio();
        if (p.accounts[accountIndex] && p.accounts[accountIndex].holdings[holdingIndex]) {
          const h = p.accounts[accountIndex].holdings[holdingIndex];
          if (shares !== undefined) h.shares = parseFloat(shares);
          if (costPrice !== undefined) h.costPrice = parseFloat(costPrice);
          savePortfolio(p);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end("Not found");
        }
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: delete holding (auth required)
  if (urlObj.pathname === "/api/holding" && req.method === "DELETE") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
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

  // API: news for a specific stock
  if (urlObj.pathname === "/api/news" && req.method === "GET") {
    const sym = urlObj.searchParams.get("symbol") || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(newsCache[sym] || []));
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
  // Try East Money first, fallback to empty (K-line is best-effort)
  return fetchKlineEastMoney(secid).then((klines) => {
    if (klines.length > 0) return klines;
    return [];
  });
}

function fetchKlineEastMoney(secid) {
  return new Promise((resolve) => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=120`;
    https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", Referer: "https://www.eastmoney.com" },
      timeout: 8000,
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

// ---- Benchmarks ----
const BENCHMARKS = [
  { name: "沪深300", secid: "1.000300" },
  { name: "纳斯达克", secid: "100.NDX" },
  { name: "标普500", secid: "100.SPX" },
];
const benchmarkCache = {};
let bmLastFetch = 0;

async function refreshBenchmarks() {
  if (Date.now() - bmLastFetch < 30 * 60 * 1000 && Object.keys(benchmarkCache).length > 0) return;
  bmLastFetch = Date.now();
  await Promise.all(BENCHMARKS.map((bm) =>
    fetchKlineEastMoney(bm.secid).then((k) => { if (k.length) benchmarkCache[bm.name] = k; }).catch(() => {})
  ));
}

// ---- Risk Metrics ----
function calcRiskMetrics(snapshots) {
  if (!snapshots || snapshots.length < 5) return null;

  // Use snapshots directly (minute-level), sample every 5 points for smoothing
  const pts = snapshots.length > 100
    ? snapshots.filter((_, i) => i % 5 === 0 || i === snapshots.length - 1)
    : snapshots;
  if (pts.length < 3) return null;

  const returns = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].v > 0) returns.push((pts[i].v - pts[i - 1].v) / pts[i - 1].v);
  }
  if (returns.length < 2) return null;

  // Max Drawdown
  let peak = pts[0].v, maxDD = 0;
  pts.forEach((s) => { if (s.v > peak) peak = s.v; const dd = peak > 0 ? (peak - s.v) / peak : 0; if (dd > maxDD) maxDD = dd; });

  // Volatility - scale to annualized based on data frequency
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  // Estimate periods per year: if data spans < 1 day, use intraday scaling
  const spanMs = new Date(pts[pts.length - 1].t) - new Date(pts[0].t);
  const spanDays = Math.max(spanMs / 86400000, 0.01);
  const periodsPerYear = (returns.length / spanDays) * 252;
  const annualVol = Math.sqrt(variance) * Math.sqrt(periodsPerYear);

  // Returns
  const totalReturn = pts[0].v > 0 ? (pts[pts.length - 1].v - pts[0].v) / pts[0].v : 0;
  const annualReturn = spanDays > 0.01 ? (Math.pow(1 + Math.abs(totalReturn), 252 / spanDays) - 1) * (totalReturn >= 0 ? 1 : -1) : 0;
  const sharpe = annualVol > 0 ? (annualReturn - 0.03) / annualVol : 0;

  // Beta vs benchmarks (use daily aggregation for alignment)
  const betas = {};
  const byDay = {};
  snapshots.forEach((s) => { byDay[s.t.slice(0, 10)] = s; });
  for (const [bmName, bmKlines] of Object.entries(benchmarkCache)) {
    if (bmKlines.length < 2) continue;
    const bmByDate = {}; bmKlines.forEach((k) => { bmByDate[k.date] = k.c; });
    const dates = Object.keys(byDay).sort();
    const rp = [], rb = [];
    for (let i = 1; i < dates.length; i++) {
      if (bmByDate[dates[i - 1]] && bmByDate[dates[i]] && byDay[dates[i - 1]].v > 0 && bmByDate[dates[i - 1]] > 0) {
        rp.push((byDay[dates[i]].v - byDay[dates[i - 1]].v) / byDay[dates[i - 1]].v);
        rb.push((bmByDate[dates[i]] - bmByDate[dates[i - 1]]) / bmByDate[dates[i - 1]]);
      }
    }
    if (rp.length >= 3) {
      const mp = rp.reduce((a, b) => a + b, 0) / rp.length;
      const mb = rb.reduce((a, b) => a + b, 0) / rb.length;
      let cov = 0, vb = 0;
      for (let i = 0; i < rp.length; i++) { cov += (rp[i] - mp) * (rb[i] - mb); vb += (rb[i] - mb) ** 2; }
      betas[bmName] = vb > 0 ? +(cov / vb).toFixed(2) : 0;
    }
  }

  return {
    maxDrawdown: +(maxDD * 100).toFixed(2),
    volatility: +(annualVol * 100).toFixed(2),
    sharpe: +sharpe.toFixed(2),
    annualReturn: +(annualReturn * 100).toFixed(2),
    totalReturn: +(totalReturn * 100).toFixed(2),
    betas,
    dataPoints: pts.length,
  };
}

// ---- Correlation Matrix ----
function calcCorrelationMatrix() {
  const symbols = Object.keys(klineCache).filter((s) => klineCache[s].length >= 10);
  if (symbols.length < 2) return null;
  const returnsMap = {};
  symbols.forEach((sym) => {
    returnsMap[sym] = {};
    const kl = klineCache[sym];
    for (let i = 1; i < kl.length; i++) {
      if (kl[i - 1].c > 0) returnsMap[sym][kl[i].date] = (kl[i].c - kl[i - 1].c) / kl[i - 1].c;
    }
  });

  // Get symbol names from portfolio
  const portfolio = loadPortfolio();
  const nameMap = {};
  portfolio.accounts.forEach((acc) => acc.holdings.forEach((h) => { nameMap[h.symbol] = h.name; }));

  const matrix = {};
  for (let i = 0; i < symbols.length; i++) {
    matrix[symbols[i]] = {};
    for (let j = 0; j < symbols.length; j++) {
      if (i === j) { matrix[symbols[i]][symbols[j]] = 1; continue; }
      const ra = [], rb = [];
      Object.keys(returnsMap[symbols[i]]).forEach((d) => {
        if (returnsMap[symbols[j]][d] !== undefined) { ra.push(returnsMap[symbols[i]][d]); rb.push(returnsMap[symbols[j]][d]); }
      });
      if (ra.length < 5) { matrix[symbols[i]][symbols[j]] = 0; continue; }
      const ma = ra.reduce((a, b) => a + b, 0) / ra.length;
      const mb = rb.reduce((a, b) => a + b, 0) / rb.length;
      let cov = 0, va = 0, vb = 0;
      for (let k = 0; k < ra.length; k++) { cov += (ra[k] - ma) * (rb[k] - mb); va += (ra[k] - ma) ** 2; vb += (rb[k] - mb) ** 2; }
      matrix[symbols[i]][symbols[j]] = va > 0 && vb > 0 ? +(cov / Math.sqrt(va * vb)).toFixed(2) : 0;
    }
  }
  return { symbols, nameMap, matrix };
}

// ---- News ----
const newsCache = {};
let newsLastFetch = 0;

function fetchNewsItem(keyword) {
  return new Promise((resolve) => {
    const q = encodeURIComponent(keyword);
    const url = `https://www.bing.com/news/search?q=${q}&format=rss&count=5`;
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const items = data.match(/<item>([\s\S]*?)<\/item>/g) || [];
          resolve(items.slice(0, 5).map((item) => {
            const title = ((item.match(/<title>(.*?)<\/title>/) || [])[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
            const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || "";
            const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || "";
            const source = (item.match(/<News:Source>(.*?)<\/News:Source>/) || [])[1] || "";
            return { title, time: pubDate ? new Date(pubDate).toISOString() : "", source, url: link };
          }));
        } catch (e) { resolve([]); }
      });
    }).on("error", () => resolve([]));
  });
}

async function refreshNews() {
  if (Date.now() - newsLastFetch < 10 * 60 * 1000 && Object.keys(newsCache).length > 0) return;
  newsLastFetch = Date.now();
  const portfolio = loadPortfolio();
  const holdings = [];
  portfolio.accounts.forEach((acc) => acc.holdings.forEach((h) => { if (!holdings.find((x) => x.symbol === h.symbol)) holdings.push(h); }));
  for (const h of holdings) {
    try {
      const isUS = h.market === "nasdaq" || h.market === "nyse";
      const isCrypto = h.market === "crypto";
      // Build search keyword for Bing News
      let kw;
      if (isUS) kw = `${h.symbol} stock`;
      else if (isCrypto) kw = `${h.symbol} crypto`;
      else {
        kw = h.name.trim();
        // For ETFs with short names, keep full name
        if (kw.length <= 3) kw = h.symbol + " " + kw;
        kw += " 股票";
      }
      newsCache[h.symbol] = await fetchNewsItem(kw);
    } catch (e) {}
  }
}

// ---- Dividend Tracking ----
const dividendCache = {};
let divLastFetch = 0;

function fetchDividendUS(symbol) {
  return new Promise((resolve) => {
    // Use Yahoo Finance v8 chart API to get dividend events
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=3mo&events=dividends`;
    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode === 429) {
        console.log(`Yahoo Finance rate limited for ${symbol}, will retry later`);
        resolve(null);
        return;
      }
      if (res.statusCode !== 200) { resolve(null); return; }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const result = j.chart?.result?.[0];
          if (!result) { resolve(null); return; }
          const events = result.events?.dividends || {};
          const divList = Object.values(events).map(d => ({
            date: new Date(d.date * 1000).toISOString().slice(0, 10),
            amount: Math.round(d.amount * 10000) / 10000,
          })).sort((a, b) => a.date.localeCompare(b.date));
          const annualDiv = divList.reduce((sum, d) => sum + d.amount, 0);
          resolve({ dividends: divList, annualDividend: Math.round(annualDiv * 100) / 100 });
        } catch (e) { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

function fetchDividendCN(symbol) {
  return new Promise((resolve) => {
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE%3D%22${symbol}%22)&pageNumber=1&pageSize=5&sortTypes=-1&sortColumns=EX_DIVIDEND_DATE&source=HSF10&client=PC`;
    https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://emweb.securities.eastmoney.com" },
      timeout: 8000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (!j.result?.data?.length) { resolve(null); return; }
          const records = j.result.data;
          const divList = records.map(r => ({
            date: r.EX_DIVIDEND_DATE ? r.EX_DIVIDEND_DATE.slice(0, 10) : "",
            amount: Math.round((r.PRETAX_BONUS_RMB || 0) / 10 * 10000) / 10000, // per 10 shares → per share
            plan: r.IMPL_PLAN_PROFILE || r.ASSIGN_DETAIL || "",
          })).filter(d => d.date);
          // Sum dividends from the last ~12 months for annual estimate
          const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
          const recentDivs = divList.filter(d => new Date(d.date) >= oneYearAgo);
          const annualDiv = recentDivs.reduce((s, d) => s + d.amount, 0);
          resolve({
            dividends: divList,
            annualDividend: Math.round(annualDiv * 10000) / 10000,
            latestPlan: divList[0]?.plan || "",
          });
        } catch (e) { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

async function refreshDividends() {
  if (Date.now() - divLastFetch < 24 * 60 * 60 * 1000 && Object.keys(dividendCache).length > 0) return;
  divLastFetch = Date.now();
  console.log("Refreshing dividend data...");
  const portfolio = loadPortfolio();
  const holdings = [];
  portfolio.accounts.forEach((acc) => {
    acc.holdings.forEach((h) => {
      if (h.market !== "crypto" && !holdings.find((x) => x.symbol === h.symbol)) holdings.push(h);
    });
  });
  // Fetch sequentially with small delay to avoid API throttling
  for (const h of holdings) {
    try {
      const isUS = h.market === "nasdaq" || h.market === "nyse";
      const d = isUS ? await fetchDividendUS(h.symbol) : await fetchDividendCN(h.symbol);
      if (d) dividendCache[h.symbol] = d;
      if (isUS) await new Promise((r) => setTimeout(r, 1500)); // rate limit Yahoo (strict)
    } catch (e) {}
  }
  const cached = Object.keys(dividendCache).length;
  const total = holdings.length;
  console.log(`Dividend data updated for ${cached}/${total} stocks`);
  // If many failed (likely rate limited), retry after 5 minutes
  if (cached < total * 0.5 && cached < 5) {
    divLastFetch = Date.now() - 24 * 60 * 60 * 1000 + 5 * 60 * 1000; // retry in 5 min
  }
}

// ---- VIX Fear Index ----
let vixCache = null;
let vixLastFetch = 0;
const VIX_INTERVAL = 5 * 60 * 1000; // refresh every 5 min

function fetchYahooQuote(symbol) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=1d`;
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const meta = j.chart?.result?.[0]?.meta;
          if (meta) {
            const price = meta.regularMarketPrice || 0;
            const prevClose = meta.chartPreviousClose || 0;
            const change = Math.round((price - prevClose) * 10000) / 10000;
            const changePct = prevClose > 0 ? Math.round((change / prevClose) * 10000) / 100 : 0;
            resolve({ price, prevClose, change, changePct, name: meta.shortName || symbol });
          } else resolve(null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

function fetchVIX() {
  return new Promise(async (resolve) => {
    try {
      // Fetch VIX and US indices in parallel from Yahoo Finance
      const [vix, dji, ixic, spx] = await Promise.all([
        fetchYahooQuote("^VIX"),
        fetchYahooQuote("^DJI"),
        fetchYahooQuote("^IXIC"),
        fetchYahooQuote("^GSPC"),
      ]);

      if (vix && vix.price > 0) {
        let level, color;
        if (vix.price < 12) { level = "极度贪婪"; color = "#10b981"; }
        else if (vix.price < 17) { level = "贪婪"; color = "#34d399"; }
        else if (vix.price < 20) { level = "中性"; color = "#f59e0b"; }
        else if (vix.price < 25) { level = "恐惧"; color = "#f97316"; }
        else if (vix.price < 30) { level = "高度恐惧"; color = "#ef4444"; }
        else { level = "极度恐惧"; color = "#dc2626"; }

        const indices = {};
        if (dji) indices.DJI = { name: "道琼斯", price: dji.price, change: dji.change, changePct: dji.changePct };
        if (ixic) indices.IXIC = { name: "纳斯达克", price: ixic.price, change: ixic.change, changePct: ixic.changePct };
        if (spx) indices.SPX = { name: "标普500", price: spx.price, change: spx.change, changePct: spx.changePct };

        vixCache = {
          vix: vix.price,
          vixChange: vix.change,
          vixChangePct: vix.changePct,
          level, color, indices,
          lastUpdate: new Date().toISOString(),
        };
        vixLastFetch = Date.now();
        console.log(`VIX updated: ${vix.price} (${level})`);
      }
    } catch (e) {
      console.error("VIX fetch error:", e.message);
    }
    resolve(vixCache);
  });
}

async function getVIX() {
  if (!vixCache || Date.now() - vixLastFetch > VIX_INTERVAL) {
    await fetchVIX();
  }
  return vixCache;
}

// ---- Bitcoin Hoarding Index (AHR999) ----
let btcCache = null;
let btcLastFetch = 0;
const BTC_INTERVAL = 5 * 60 * 1000; // 5 min

function fetchBTCIndex() {
  return new Promise(async (resolve) => {
    try {
      // Fetch BTC 200-day history + 2-day price in parallel
      const [btcHistory, btc2d, fng] = await Promise.all([
        new Promise((res) => {
          const url = "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=200d&interval=1d";
          https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 }, (resp) => {
            let data = "";
            resp.on("data", (c) => (data += c));
            resp.on("end", () => { try { res(JSON.parse(data)); } catch { res(null); } });
          }).on("error", () => res(null));
        }),
        new Promise((res) => {
          const url = "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=2d&interval=1d";
          https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 }, (resp) => {
            let data = "";
            resp.on("data", (c) => (data += c));
            resp.on("end", () => { try { res(JSON.parse(data)); } catch { res(null); } });
          }).on("error", () => res(null));
        }),
        new Promise((res) => {
          https.get("https://api.alternative.me/fng/?limit=1", {
            headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000,
          }, (resp) => {
            let data = "";
            resp.on("data", (c) => (data += c));
            resp.on("end", () => { try { res(JSON.parse(data)); } catch { res(null); } });
          }).on("error", () => res(null));
        }),
      ]);

      const r = btcHistory?.chart?.result?.[0];
      if (r) {
        const price = r.meta?.regularMarketPrice || 0;
        // Use 2-day data for accurate daily change
        const prevClose2d = btc2d?.chart?.result?.[0]?.meta?.chartPreviousClose || 0;
        const closes = (r.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
        const ma200 = closes.length > 0 ? closes.reduce((s, v) => s + v, 0) / closes.length : 0;

        // AHR999 calculation
        const genesis = new Date("2009-01-03").getTime();
        const days = (Date.now() - genesis) / 86400000;
        const growthVal = Math.pow(10, 5.84 * Math.log10(days) - 17.01);
        const ahr999 = ma200 > 0 && growthVal > 0 ? (price / ma200) * (price / growthVal) : 0;

        // AHR999 level
        let level, color, advice;
        if (ahr999 < 0.45) {
          level = "抄底区"; color = "#10b981"; advice = "AHR999 < 0.45：价格低于成本和增长曲线，历史底部区域";
        } else if (ahr999 < 1.2) {
          level = "定投区"; color = "#3b82f6"; advice = "AHR999 0.45-1.2：适合定期定额买入，长期持有";
        } else {
          level = "等待区"; color = "#ef4444"; advice = "AHR999 > 1.2：价格偏高，建议持币观望或分批止盈";
        }

        // BTC price change (from 2-day data for accuracy)
        const prevClose = prevClose2d || 0;
        const btcChange = Math.round((price - prevClose) * 100) / 100;
        const btcChangePct = prevClose > 0 ? Math.round((btcChange / prevClose) * 10000) / 100 : 0;

        // Crypto Fear & Greed
        const fngValue = fng?.data?.[0] ? parseInt(fng.data[0].value) : null;
        const fngClass = fng?.data?.[0]?.value_classification || null;
        let fngLevel = null;
        if (fngClass === "Extreme Fear") fngLevel = "极度恐惧";
        else if (fngClass === "Fear") fngLevel = "恐惧";
        else if (fngClass === "Neutral") fngLevel = "中性";
        else if (fngClass === "Greed") fngLevel = "贪婪";
        else if (fngClass === "Extreme Greed") fngLevel = "极度贪婪";

        btcCache = {
          price, btcChange, btcChangePct,
          ma200: Math.round(ma200 * 100) / 100,
          growthVal: Math.round(growthVal * 100) / 100,
          ahr999: Math.round(ahr999 * 10000) / 10000,
          level, color, advice,
          fng: fngValue, fngLevel, fngClass,
          lastUpdate: new Date().toISOString(),
        };
        btcLastFetch = Date.now();
        console.log(`BTC index updated: price=$${price}, AHR999=${ahr999.toFixed(4)} (${level}), F&G=${fngValue}`);
      }
    } catch (e) {
      console.error("BTC index fetch error:", e.message);
    }
    resolve(btcCache);
  });
}

async function getBTCIndex() {
  if (!btcCache || Date.now() - btcLastFetch > BTC_INTERVAL) {
    await fetchBTCIndex();
  }
  return btcCache;
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
    await refreshBenchmarks();
    refreshNews(); // non-blocking
    refreshDividends(); // non-blocking, daily refresh
    getVIX(); // non-blocking, refresh VIX
    getBTCIndex(); // non-blocking, refresh BTC hoarding index

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
            afterHours: p.afterHours || false,
            tech,
            dividend: dividendCache[fixed.symbol] ? {
              annualDividend: dividendCache[fixed.symbol].annualDividend,
              dividendYield: price > 0 && dividendCache[fixed.symbol].annualDividend > 0
                ? Math.round(dividendCache[fixed.symbol].annualDividend / price * 10000) / 100 : 0,
              annualIncome: Math.round((dividendCache[fixed.symbol].annualDividend || 0) * h.shares * 100) / 100,
              dividends: dividendCache[fixed.symbol].dividends || [],
              latestPlan: dividendCache[fixed.symbol].latestPlan || null,
            } : null,
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

    // Return Attribution
    const attribution = [];
    result.accounts.forEach((acc) => {
      const cur = acc.currency || "CNY";
      acc.holdings.forEach((h) => {
        const mul = cur === "USD" ? rate : cur === "HKD" ? rate / 7.8 : 1;
        const pnlCNY = (h.pnl || 0) * mul;
        const mvCNY = (h.marketValue || 0) * mul;
        const dayChgCNY = (h.change || 0) * h.shares * mul;
        attribution.push({
          symbol: h.symbol,
          name: h.name,
          pnlCNY: Math.round(pnlCNY * 100) / 100,
          dayChgCNY: Math.round(dayChgCNY * 100) / 100,
          contribution: totalCost > 0 ? Math.round(pnlCNY / totalCost * 10000) / 100 : 0,
          dayContribution: totalCNY > 0 ? Math.round(dayChgCNY / totalCNY * 10000) / 100 : 0,
          weight: totalCNY > 0 ? Math.round(mvCNY / totalCNY * 10000) / 100 : 0,
          pnlPercent: h.pnlPercent ? Math.round(h.pnlPercent * 100) / 100 : 0,
        });
      });
    });
    attribution.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    const snapshots = loadHistory().snapshots;
    result.history = snapshots;
    result.benchmarks = {};
    for (const [name, klines] of Object.entries(benchmarkCache)) {
      result.benchmarks[name] = klines.map((k) => ({ date: k.date, close: k.c }));
    }
    result.riskMetrics = calcRiskMetrics(snapshots);
    result.correlation = calcCorrelationMatrix();
    result.news = newsCache;
    result.attribution = attribution;
    result.dividends = dividendCache;
    result.rateInfo = {
      USD_CNY: cachedRate?.USD_CNY || rate,
      USD_HKD: cachedRate?.USD_HKD || 7.82,
      lastUpdate: rateLastFetch ? new Date(rateLastFetch).toISOString() : null,
    };
    result.fearGreed = vixCache;
    result.btcIndex = btcCache;

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
