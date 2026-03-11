let maskMode = false;
let currentTab = "holdings";

// Default portfolio data (auto-imported from portfolio.json)
const DEFAULT_PORTFOLIO = {"accounts":[{"name":"A股账户","currency":"CNY","holdings":[{"symbol":"000858","market":"sz","name":"五粮液","shares":100,"costPrice":104.58},{"symbol":"513100","market":"sh","name":"纳指ETF","shares":19400,"costPrice":1.795},{"symbol":"513650","market":"sh","name":"标普500ETF南方","shares":17800,"costPrice":1.748},{"symbol":"512010","market":"sh","name":"医药ETF","shares":12600,"costPrice":0.374}]},{"name":"美股-IB","currency":"USD","holdings":[{"symbol":"TSLA","market":"nasdaq","name":"特斯拉","shares":24,"costPrice":407},{"symbol":"GOOGL","market":"nasdaq","name":"谷歌","shares":5,"costPrice":297},{"symbol":"AXP","market":"nyse","name":"美国运通","shares":4,"costPrice":294},{"symbol":"SOFI","market":"nasdaq","name":"SoFi","shares":55,"costPrice":18.3},{"symbol":"QQQ","market":"nasdaq","name":"QQQ","shares":2,"costPrice":605},{"symbol":"SCHG","market":"nyse","name":"SCHG","shares":42,"costPrice":30.8}]},{"name":"币圈","currency":"USD","holdings":[{"symbol":"ETH","market":"crypto","name":"以太坊 ETH","shares":0.85,"costPrice":2300}]}]};

// ---- Bindall events via addEventListener (CSP compliance) ----
document.addEventListener("DOMContentLoaded", async () => {
  // Bind button events
  document.getElementById("maskBtn").addEventListener("click", toggleMask);
  document.getElementById("tabHoldings").addEventListener("click", () => switchTab("holdings"));
  document.getElementById("tabAttribution").addEventListener("click", () => switchTab("attribution"));
  document.getElementById("btnRefresh").addEventListener("click", refresh);
  document.getElementById("btnSettings").addEventListener("click", showSettings);
  document.getElementById("btnLoadServer").addEventListener("click", loadFromServer);
  document.getElementById("btnCancel").addEventListener("click", showMain);
  document.getElementById("btnSave").addEventListener("click", saveConfig);
  document.getElementById("btnDoImport").addEventListener("click", doImport);

  // Restore mask mode
  const { maskMode: stored } = await chrome.storage.local.get("maskMode");
  maskMode = !!stored;
  applyMask();

  // Auto-init: if no portfolio saved, use default
  const { portfolio } = await chrome.storage.sync.get("portfolio");
  if (!portfolio || !portfolio.accounts?.length) {
    await chrome.storage.sync.set({ portfolio: DEFAULT_PORTFOLIO });
  }

  // Load cached data or trigger fresh fetch
  const { latestData } = await chrome.storage.local.get("latestData");
  if (latestData) {
    renderData(latestData);
  } else {
    document.getElementById("holdingsTab").innerHTML =
      '<div class="empty">\u6b63\u5728\u52a0\u8f7d\u6570\u636e...</div>';
    refresh();
  }
});

// ---- Render ----
function renderData(data) {
  if (!data || !data.holdings) return;

  const { totalCNY, totalPnl, totalPnlPct, todayChg, rate } = data;

  document.getElementById("totalAssets").textContent = "\u00a5" + fmtW(totalCNY);

  const pnlEl = document.getElementById("totalPnl");
  pnlEl.textContent = (totalPnl >= 0 ? "+" : "") + "\u00a5" + fmtW(totalPnl) +
    " (" + (totalPnlPct >= 0 ? "+" : "") + totalPnlPct.toFixed(2) + "%)";
  pnlEl.className = "value mask " + (totalPnl >= 0 ? "up" : "down");

  const chgEl = document.getElementById("todayChg");
  chgEl.textContent = (todayChg >= 0 ? "+" : "") + "\u00a5" + fmtW(todayChg);
  chgEl.className = "value mask " + (todayChg >= 0 ? "up" : "down");

  document.getElementById("rateDisplay").textContent = rate ? rate.toFixed(4) : "--";

  const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString("zh-CN") : "--";
  document.getElementById("updateTime").textContent = "\u66f4\u65b0\u4e8e " + time;

  renderHoldings(data.holdings, data.totalCNY);
  renderAttribution(data.holdings, data.totalCost, data.totalCNY);
}

function renderHoldings(holdings, totalCNY) {
  const container = document.getElementById("holdingsTab");
  if (!holdings.length) {
    container.innerHTML = '<div class="empty">\u6682\u65e0\u6301\u4ed3</div>';
    return;
  }

  const sorted = [...holdings].sort((a, b) => (b.mvCNY || 0) - (a.mvCNY || 0));

  let html = "";
  sorted.forEach((h) => {
    const cpCls = h.changePct > 0 ? "up" : h.changePct < 0 ? "down" : "";
    const pnlCls = h.pnl >= 0 ? "up" : "down";
    const arrow = h.changePct > 0 ? "\u25b2" : h.changePct < 0 ? "\u25bc" : "";
    const weight = totalCNY > 0 ? ((h.mvCNY || 0) / totalCNY * 100).toFixed(1) : "0";

    html += '<div class="holding-row">' +
      '<div class="h-info">' +
        '<div class="h-name">' + esc(h.name) + '</div>' +
        '<div class="h-symbol">' + h.symbol + ' \u00b7 ' + weight + '%</div>' +
      '</div>' +
      '<div class="h-price">' +
        '<div class="price ' + cpCls + '">' + h.sym + fmtN(h.currentPrice) +
          (h.afterHours ? '<span class="badge-ah">\u76d8\u540e</span>' : '') + '</div>' +
        '<div class="change ' + cpCls + '">' + arrow + ' ' + (h.changePct >= 0 ? '+' : '') + h.changePct.toFixed(2) + '%</div>' +
      '</div>' +
      '<div class="h-pnl">' +
        '<div class="pnl ' + pnlCls + ' mask">' + (h.pnl >= 0 ? '+' : '') + h.sym + fmtW(h.pnl) + '</div>' +
        '<div class="pnl-pct">' + (h.pnlPct >= 0 ? '+' : '') + h.pnlPct.toFixed(1) + '%</div>' +
      '</div>' +
    '</div>';
  });
  container.innerHTML = html;
}

function renderAttribution(holdings, totalCost, totalCNY) {
  const container = document.getElementById("attributionTab");
  if (!holdings.length) {
    container.innerHTML = '<div class="empty">\u6682\u65e0\u6570\u636e</div>';
    return;
  }

  const items = holdings.map((h) => {
    const pnlCNY = h.pnl * ((h.mvCNY || 0) / (h.marketValue || 1));
    const contribution = totalCost > 0 ? (pnlCNY / totalCost * 100) : 0;
    return { name: h.name, contribution };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const maxAbs = Math.max(...items.map((a) => Math.abs(a.contribution)), 0.01);

  let html = '<div style="padding:4px 0">';
  items.forEach((a) => {
    const isPos = a.contribution >= 0;
    const barColor = isPos ? "#ef4444" : "#10b981";
    const barW = Math.abs(a.contribution) / maxAbs * 100;
    const textCls = isPos ? "up" : "down";

    html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px">' +
      '<div style="width:60px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600">' + esc(a.name) + '</div>' +
      '<div style="flex:1;height:14px;background:#f1f5f9;border-radius:7px;overflow:hidden">' +
        '<div style="height:100%;background:' + barColor + ';border-radius:7px;width:' + Math.max(2, barW) + '%;transition:width .3s"></div>' +
      '</div>' +
      '<div style="width:60px;text-align:right;font-family:monospace" class="' + textCls + ' mask">' + (a.contribution >= 0 ? '+' : '') + a.contribution.toFixed(2) + '%</div>' +
    '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

// ---- Tab switching ----
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  document.getElementById("holdingsTab").style.display = tab === "holdings" ? "" : "none";
  document.getElementById("attributionTab").style.display = tab === "attribution" ? "" : "none";
}

// ---- Mask mode ----
function toggleMask() {
  maskMode = !maskMode;
  chrome.storage.local.set({ maskMode });
  applyMask();
}

function applyMask() {
  document.body.classList.toggle("mask-mode", maskMode);
  document.getElementById("maskBtn").textContent = maskMode ? "\ud83d\udc41 \u53d6\u6d88\u906e\u63a9" : "\ud83d\udc41 \u906e\u63a9";
}

// ---- Actions ----
async function refresh() {
  document.getElementById("updateTime").textContent = "\u5237\u65b0\u4e2d...";
  chrome.runtime.sendMessage({ type: "refresh" }, async () => {
    const { latestData } = await chrome.storage.local.get("latestData");
    if (latestData) renderData(latestData);
  });
}

function showSettings() {
  document.getElementById("mainView").style.display = "none";
  document.querySelector(".footer").style.display = "none";
  document.getElementById("settingsView").classList.remove("hidden");

  chrome.storage.sync.get("portfolio", ({ portfolio }) => {
    if (portfolio) {
      document.getElementById("configText").value = JSON.stringify(portfolio, null, 2);
    }
  });
}

function showMain() {
  document.getElementById("mainView").style.display = "";
  document.querySelector(".footer").style.display = "";
  document.getElementById("settingsView").classList.add("hidden");
}

async function saveConfig() {
  const text = document.getElementById("configText").value.trim();
  try {
    const data = JSON.parse(text);
    if (!data.accounts) throw new Error("\u7f3a\u5c11 accounts \u5b57\u6bb5");
    await chrome.storage.sync.set({ portfolio: data });
    showMain();
    await chrome.storage.local.remove("latestData");
    refresh();
  } catch (e) {
    alert("JSON \u683c\u5f0f\u9519\u8bef: " + e.message);
  }
}

function loadFromServer() {
  document.getElementById("serverImport").style.display = "";
}

async function doImport() {
  const url = (document.getElementById("serverUrl").value.trim() || "http://localhost:3457").replace(/\/$/, "");
  try {
    const res = await fetch(url + "/api/portfolio");
    const data = await res.json();
    document.getElementById("configText").value = JSON.stringify(data, null, 2);
    document.getElementById("serverImport").style.display = "none";
  } catch (e) {
    alert("\u5bfc\u5165\u5931\u8d25: " + e.message);
  }
}

function showEmpty() {
  const container = document.getElementById("holdingsTab");
  container.innerHTML = '<div class="empty">' +
    '<p>\u5c1a\u672a\u914d\u7f6e\u6301\u4ed3</p>' +
    '<p style="font-size:11px;margin-top:4px">\u70b9\u51fb\u4e0b\u65b9\u201c\u8bbe\u7f6e\u201d\u6309\u94ae\u6dfb\u52a0\u6301\u4ed3\u914d\u7f6e</p>' +
    '<button class="btn btn-primary" id="btnEmptySetup" style="margin-top:12px">\u914d\u7f6e\u6301\u4ed3</button>' +
  '</div>';
  document.getElementById("btnEmptySetup").addEventListener("click", showSettings);
}

// ---- Utils ----
function fmtN(v) {
  if (v == null) return "--";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtW(v) {
  if (v == null) return "--";
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(2) + "\u4e07";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
