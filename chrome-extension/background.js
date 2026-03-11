// Background service worker: periodic price refresh & badge update
chrome.alarms.create("refreshPrices", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "refreshPrices") {
    try {
      const data = await fetchAllPrices();
      if (data) {
        await chrome.storage.local.set({ latestData: data, lastUpdate: Date.now() });
        // Update badge with total P&L %
        const pnlPct = data.totalPnlPct;
        const text = pnlPct >= 0 ? `+${pnlPct.toFixed(1)}` : pnlPct.toFixed(1);
        chrome.action.setBadgeText({ text });
        chrome.action.setBadgeBackgroundColor({
          color: pnlPct >= 0 ? "#ef4444" : "#10b981",
        });
      }
    } catch (e) {
      console.error("Refresh error:", e);
    }
  }
});

// Also refresh on install/startup
chrome.runtime.onInstalled.addListener(() => refreshNow());
chrome.runtime.onStartup.addListener(() => refreshNow());

async function refreshNow() {
  try {
    const data = await fetchAllPrices();
    if (data) {
      await chrome.storage.local.set({ latestData: data, lastUpdate: Date.now() });
      const pnlPct = data.totalPnlPct;
      const text = pnlPct >= 0 ? `+${pnlPct.toFixed(1)}` : pnlPct.toFixed(1);
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({
        color: pnlPct >= 0 ? "#ef4444" : "#10b981",
      });
    }
  } catch (e) {}
}

// Fetch exchange rate
async function fetchRate() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const j = await res.json();
    return j.rates?.CNY || 6.88;
  } catch {
    return 6.88;
  }
}

// Fetch stock prices from Sina Finance
async function fetchStockPrices(holdings) {
  const symbolMap = {};
  const sinaSymbols = [];
  holdings.forEach((h) => {
    let ss;
    if (h.market === "sh") ss = `sh${h.symbol}`;
    else if (h.market === "sz") ss = `sz${h.symbol}`;
    else if (h.market === "nasdaq" || h.market === "nyse") ss = `gb_${h.symbol.toLowerCase()}`;
    if (ss) {
      sinaSymbols.push(ss);
      symbolMap[ss] = h;
    }
  });
  if (!sinaSymbols.length) return {};

  const url = `https://hq.sinajs.cn/list=${sinaSymbols.join(",")}`;
  const res = await fetch(url, {
    headers: { Referer: "https://finance.sina.com.cn" },
  });
  const text = await res.text();
  const prices = {};
  text.split("\n").filter((l) => l.trim()).forEach((line) => {
    const match = line.match(/var hq_str_(\w+)="(.*)"/);
    if (!match || !match[2]) return;
    const h = symbolMap[match[1]];
    if (!h) return;
    const parts = match[2].split(",");
    const isUS = h.market === "nasdaq" || h.market === "nyse";
    if (isUS) {
      const price = parseFloat(parts[1]) || 0;
      const changePct = parseFloat(parts[2]) || 0;
      const change = parseFloat(parts[4]) || 0;
      const ahPrice = parseFloat(parts[21]) || 0;
      if (ahPrice > 0) {
        const closePrice = parseFloat(parts[26]) || price;
        prices[h.symbol] = {
          price: ahPrice, changePct: closePrice ? ((ahPrice - closePrice) / closePrice * 100) : 0,
          change: ahPrice - closePrice, name: parts[0], afterHours: true,
        };
      } else {
        prices[h.symbol] = { price, changePct, change, name: parts[0] };
      }
    } else {
      const prevClose = parseFloat(parts[2]) || 0;
      const price = parseFloat(parts[3]) || 0;
      const change = price - prevClose;
      const changePct = prevClose ? (change / prevClose * 100) : 0;
      prices[h.symbol] = { price, changePct, change, name: parts[0] };
    }
  });
  return prices;
}

// Fetch crypto prices from Coinbase
async function fetchCryptoPrices(symbols) {
  const results = {};
  for (const sym of symbols) {
    try {
      const res = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`);
      const j = await res.json();
      if (j.data?.amount) {
        results[sym] = { price: parseFloat(j.data.amount), changePct: 0, change: 0, name: sym };
      }
    } catch {}
  }
  return results;
}

async function fetchAllPrices() {
  const { portfolio } = await chrome.storage.sync.get("portfolio");
  if (!portfolio || !portfolio.accounts?.length) return null;

  const rate = await fetchRate();
  const stockHoldings = [];
  const cryptoSymbols = [];
  portfolio.accounts.forEach((acc) =>
    acc.holdings.forEach((h) => {
      if (h.market === "crypto") cryptoSymbols.push(h.symbol);
      else stockHoldings.push(h);
    })
  );

  const [stockPrices, cryptoPrices] = await Promise.all([
    fetchStockPrices(stockHoldings),
    fetchCryptoPrices(cryptoSymbols),
  ]);
  const prices = { ...stockPrices, ...cryptoPrices };

  let totalCNY = 0, totalCost = 0, todayChg = 0;
  const holdings = [];

  portfolio.accounts.forEach((acc) => {
    const cur = acc.currency || "CNY";
    const mul = cur === "USD" ? rate : cur === "HKD" ? rate / 7.8 : 1;
    const sym = cur === "USD" ? "$" : cur === "HKD" ? "HK$" : "¥";

    acc.holdings.forEach((h) => {
      const p = prices[h.symbol] || {};
      const price = p.price || 0;
      const mv = price * h.shares;
      const cv = h.costPrice * h.shares;
      const pnl = mv - cv;
      const pnlPct = cv > 0 ? (pnl / cv * 100) : 0;
      const dayChg = (p.change || 0) * h.shares;

      totalCNY += mv * mul;
      totalCost += cv * mul;
      todayChg += dayChg * mul;

      holdings.push({
        ...h, currentPrice: price, changePct: p.changePct || 0,
        change: p.change || 0, marketValue: mv, costValue: cv,
        pnl, pnlPct, afterHours: p.afterHours || false,
        mvCNY: mv * mul, sym, currency: cur,
      });
    });
  });

  const totalPnl = totalCNY - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost * 100) : 0;

  return { holdings, totalCNY, totalCost, totalPnl, totalPnlPct, todayChg, rate, timestamp: Date.now() };
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "refresh") {
    refreshNow().then(() => sendResponse({ ok: true }));
    return true;
  }
});
