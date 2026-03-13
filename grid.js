// grid.js - Binance Grid Trading Bot Module
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const GRID_FILE = path.join(__dirname, "grid-state.json");
const BINANCE_HOST = "api.binance.com";

// ---- State ----
let state = {
  apiKey: "", apiSecret: "",
  config: null,   // { pair, upper, lower, grids, amount }
  running: false,
  grids: [],      // per-level state
  trades: [],     // completed buy-sell cycles
  totalProfit: 0,
  currentPrice: 0,
  pairInfo: null, // { tickSize, stepSize, minNotional, minQty, baseAsset, quoteAsset }
  startTime: null,
  error: null,
};
let pollTimer = null;
let wssRef = null;

function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(GRID_FILE, "utf-8"));
    state = { ...state, ...d, running: false }; // never auto-resume
  } catch {}
}

function saveState() {
  try {
    const s = { ...state };
    fs.writeFileSync(GRID_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

// ---- Binance API ----
function sign(qs) {
  return crypto.createHmac("sha256", state.apiSecret).update(qs).digest("hex");
}

function bnReq(method, endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    const qs = new URLSearchParams(params).toString();
    const sig = sign(qs);
    const fullPath = `${endpoint}?${qs}&signature=${sig}`;
    const opts = {
      hostname: BINANCE_HOST, path: fullPath, method,
      headers: { "X-MBX-APIKEY": state.apiKey },
    };
    const r = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.code && j.code < 0) reject(new Error(`[${j.code}] ${j.msg}`));
          else resolve(j);
        } catch { reject(new Error(data)); }
      });
    });
    r.on("error", reject);
    r.end();
  });
}

function bnPublic(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
    https.get(`https://${BINANCE_HOST}${endpoint}${qs}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(data)); }
      });
    }).on("error", reject);
  });
}

// ---- Precision Helpers ----
function roundStep(val, step) {
  const prec = step.toString().replace(/0+$/, "").split(".")[1]?.length || 0;
  return parseFloat((Math.floor(val / step) * step).toFixed(prec));
}

function roundTick(val, tick) {
  const prec = tick.toString().replace(/0+$/, "").split(".")[1]?.length || 0;
  return parseFloat((Math.round(val / tick) * tick).toFixed(prec));
}

// ---- Grid Logic ----
function calcLevels(upper, lower, count) {
  const levels = [];
  const step = (upper - lower) / count;
  for (let i = 0; i <= count; i++) {
    levels.push(lower + step * i);
  }
  return levels;
}

async function fetchPairInfo(symbol) {
  const info = await bnPublic("/api/v3/exchangeInfo", { symbol });
  const s = info.symbols && info.symbols[0];
  if (!s) throw new Error(`交易对 ${symbol} 不存在`);
  const lotSize = s.filters.find((f) => f.filterType === "LOT_SIZE");
  const priceFilter = s.filters.find((f) => f.filterType === "PRICE_FILTER");
  const notional = s.filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  return {
    tickSize: parseFloat(priceFilter?.tickSize || "0.01"),
    stepSize: parseFloat(lotSize?.stepSize || "0.00001"),
    minQty: parseFloat(lotSize?.minQty || "0.00001"),
    minNotional: parseFloat(notional?.minNotional || notional?.minNotional || "5"),
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
  };
}

async function fetchPrice(symbol) {
  const d = await bnPublic("/api/v3/ticker/price", { symbol });
  return parseFloat(d.price);
}

async function placeOrder(symbol, side, price, qty) {
  const pi = state.pairInfo;
  const adjPrice = roundTick(price, pi.tickSize);
  const adjQty = roundStep(qty, pi.stepSize);
  if (adjQty < pi.minQty) throw new Error(`数量 ${adjQty} 低于最小值 ${pi.minQty}`);
  if (adjPrice * adjQty < pi.minNotional) throw new Error(`订单金额 ${(adjPrice * adjQty).toFixed(2)} 低于最低 ${pi.minNotional}`);
  const res = await bnReq("POST", "/api/v3/order", {
    symbol, side, type: "LIMIT", timeInForce: "GTC",
    price: adjPrice.toString(), quantity: adjQty.toString(),
  });
  return { orderId: res.orderId, price: adjPrice, qty: adjQty, side, status: "NEW" };
}

async function cancelOrder(symbol, orderId) {
  try {
    await bnReq("DELETE", "/api/v3/order", { symbol, orderId });
  } catch (e) {
    if (!e.message.includes("Unknown order")) throw e;
  }
}

async function checkOrder(symbol, orderId) {
  const res = await bnReq("GET", "/api/v3/order", { symbol, orderId });
  return res.status; // NEW, FILLED, CANCELED, PARTIALLY_FILLED, etc.
}

// ---- Bot Lifecycle ----
async function startBot(config) {
  if (state.running) throw new Error("机器人已在运行");
  if (!state.apiKey || !state.apiSecret) throw new Error("请先设置 API Key");

  const { pair, upper, lower, grids, amount } = config;
  if (upper <= lower) throw new Error("上限价格必须大于下限");
  if (grids < 2 || grids > 200) throw new Error("网格数量需在 2-200 之间");
  if (amount <= 0) throw new Error("投资金额无效");

  // Fetch pair info and current price
  state.pairInfo = await fetchPairInfo(pair);
  state.currentPrice = await fetchPrice(pair);

  if (state.currentPrice < lower || state.currentPrice > upper) {
    throw new Error(`当前价格 ${state.currentPrice} 不在网格区间 [${lower}, ${upper}] 内`);
  }

  // Calculate grid levels
  const levels = calcLevels(upper, lower, grids);
  const amountPerGrid = amount / grids;

  // Initialize grid state
  state.grids = levels.map((price, i) => ({
    index: i, price: roundTick(price, state.pairInfo.tickSize),
    buyOrderId: null, sellOrderId: null,
    status: "idle", // idle, buying, bought, selling
    qty: 0,
  }));

  state.config = config;
  state.trades = [];
  state.totalProfit = 0;
  state.error = null;
  state.startTime = new Date().toISOString();

  // Place initial BUY orders at levels below current price
  let placed = 0;
  for (const g of state.grids) {
    if (g.price >= state.currentPrice) continue; // skip levels at/above price
    if (g.index >= state.grids.length - 1) continue; // need a level above to sell
    try {
      const qty = roundStep(amountPerGrid / g.price, state.pairInfo.stepSize);
      if (qty < state.pairInfo.minQty) continue;
      if (g.price * qty < state.pairInfo.minNotional) continue;
      const order = await placeOrder(pair, "BUY", g.price, qty);
      g.buyOrderId = order.orderId;
      g.qty = order.qty;
      g.status = "buying";
      placed++;
    } catch (e) {
      console.error(`Grid ${g.index} buy failed:`, e.message);
    }
  }

  if (placed === 0) throw new Error("未能放置任何订单，请检查资金或参数");

  state.running = true;
  saveState();

  // Start polling
  pollTimer = setInterval(() => pollOrders().catch(console.error), 3000);
  console.log(`Grid bot started: ${pair}, ${placed} orders placed`);
  broadcastGridState();
}

async function stopBot() {
  if (!state.running) return;
  state.running = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  // Cancel all open orders
  const pair = state.config?.pair;
  if (pair) {
    for (const g of state.grids) {
      try {
        if (g.buyOrderId && g.status === "buying") await cancelOrder(pair, g.buyOrderId);
        if (g.sellOrderId && g.status === "selling") await cancelOrder(pair, g.sellOrderId);
      } catch (e) { console.error(`Cancel grid ${g.index}:`, e.message); }
      g.status = "idle";
      g.buyOrderId = null;
      g.sellOrderId = null;
    }
  }

  saveState();
  broadcastGridState();
  console.log("Grid bot stopped");
}

async function pollOrders() {
  if (!state.running || !state.config) return;
  const pair = state.config.pair;

  try {
    state.currentPrice = await fetchPrice(pair);
  } catch { return; }

  for (const g of state.grids) {
    try {
      if (g.status === "buying" && g.buyOrderId) {
        const status = await checkOrder(pair, g.buyOrderId);
        if (status === "FILLED") {
          // Buy filled → place sell at next level up
          g.status = "bought";
          g.buyOrderId = null;
          const nextLevel = state.grids[g.index + 1];
          if (nextLevel) {
            try {
              const order = await placeOrder(pair, "SELL", nextLevel.price, g.qty);
              g.sellOrderId = order.orderId;
              g.status = "selling";
              console.log(`Grid ${g.index}: BUY filled at ${g.price}, SELL placed at ${nextLevel.price}`);
            } catch (e) {
              console.error(`Grid ${g.index} sell failed:`, e.message);
              g.status = "bought"; // still holding, try again later
            }
          }
        } else if (status === "CANCELED" || status === "EXPIRED") {
          g.status = "idle";
          g.buyOrderId = null;
        }
      }

      if (g.status === "selling" && g.sellOrderId) {
        const status = await checkOrder(pair, g.sellOrderId);
        if (status === "FILLED") {
          // Sell filled → record profit, place new buy
          const nextLevel = state.grids[g.index + 1];
          const profit = (nextLevel.price - g.price) * g.qty;
          state.totalProfit += profit;
          state.trades.push({
            buyPrice: g.price, sellPrice: nextLevel.price,
            qty: g.qty, profit: Math.round(profit * 10000) / 10000,
            time: new Date().toISOString(),
          });
          g.sellOrderId = null;
          console.log(`Grid ${g.index}: SELL filled, profit: ${profit.toFixed(4)}`);

          // Re-place buy at this level
          try {
            const amtPerGrid = state.config.amount / state.config.grids;
            const qty = roundStep(amtPerGrid / g.price, state.pairInfo.stepSize);
            const order = await placeOrder(pair, "BUY", g.price, qty);
            g.buyOrderId = order.orderId;
            g.qty = order.qty;
            g.status = "buying";
          } catch (e) {
            g.status = "idle";
            console.error(`Grid ${g.index} re-buy failed:`, e.message);
          }

          saveState();
        } else if (status === "CANCELED" || status === "EXPIRED") {
          g.status = "bought"; // still holding
          g.sellOrderId = null;
        }
      }
    } catch (e) {
      // Rate limit or network error, skip this cycle
    }
  }

  broadcastGridState();
}

function getStatus() {
  const activeOrders = state.grids.filter((g) => g.status === "buying" || g.status === "selling").length;
  const filledBuys = state.grids.filter((g) => g.status === "selling" || g.status === "bought").length;
  return {
    running: state.running,
    config: state.config,
    currentPrice: state.currentPrice,
    totalProfit: Math.round(state.totalProfit * 10000) / 10000,
    activeOrders,
    filledBuys,
    trades: state.trades.slice(-50),
    tradeCount: state.trades.length,
    grids: state.grids.map((g) => ({
      index: g.index, price: g.price, status: g.status, qty: g.qty,
    })),
    startTime: state.startTime,
    error: state.error,
    hasKeys: !!(state.apiKey && state.apiSecret),
    pairInfo: state.pairInfo,
  };
}

function broadcastGridState() {
  if (!wssRef) return;
  const msg = JSON.stringify({ type: "grid", data: getStatus() });
  wssRef.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

// ---- HTTP Handler ----
function handleGridRequest(req, res, urlObj, checkAuth) {
  const p = urlObj.pathname;

  // Serve grid.html
  if (p === "/grid" || p === "/grid.html") {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(__dirname, "grid.html")));
    } catch (e) {
      res.writeHead(500);
      res.end("Error loading grid.html");
    }
    return true;
  }

  // API: Save keys
  if (p === "/api/grid/keys" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return true; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { apiKey, apiSecret } = JSON.parse(body);
        state.apiKey = apiKey || "";
        state.apiSecret = apiSecret || "";
        saveState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return true;
  }

  // API: Get status
  if (p === "/api/grid/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getStatus()));
    return true;
  }

  // API: Get available pairs
  if (p === "/api/grid/pairs" && req.method === "GET") {
    bnPublic("/api/v3/exchangeInfo").then((info) => {
      const pairs = info.symbols
        .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
        .map((s) => s.symbol)
        .sort();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(pairs));
    }).catch((e) => {
      res.writeHead(500);
      res.end(e.message);
    });
    return true;
  }

  // API: Get current price
  if (p === "/api/grid/price" && req.method === "GET") {
    const symbol = urlObj.searchParams.get("symbol") || "BTCUSDT";
    fetchPrice(symbol).then((price) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ price }));
    }).catch((e) => {
      res.writeHead(500);
      res.end(e.message);
    });
    return true;
  }

  // API: Start bot
  if (p === "/api/grid/start" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return true; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const config = JSON.parse(body);
        config.upper = parseFloat(config.upper);
        config.lower = parseFloat(config.lower);
        config.grids = parseInt(config.grids);
        config.amount = parseFloat(config.amount);
        startBot(config).then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }).catch((e) => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        });
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return true;
  }

  // API: Stop bot
  if (p === "/api/grid/stop" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return true; }
    stopBot().then(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(500);
      res.end(e.message);
    });
    return true;
  }

  // API: Account balance
  if (p === "/api/grid/balance" && req.method === "GET") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return true; }
    if (!state.apiKey) { res.writeHead(400); res.end("No API key"); return true; }
    bnReq("GET", "/api/v3/account").then((acc) => {
      const balances = acc.balances
        .filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
        .map((b) => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(balances));
    }).catch((e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    return true;
  }

  return false; // not handled
}

function setup(wss) {
  wssRef = wss;
  loadState();
}

module.exports = { handleGridRequest, setup, getStatus };
