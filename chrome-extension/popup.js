let maskMode = false;
let currentTab = "holdings";

// ---- Init ----
document.addEventListener("DOMContentLoaded", async () => {
  const { maskMode: stored } = await chrome.storage.local.get("maskMode");
  maskMode = !!stored;
  applyMask();

  const { latestData } = await chrome.storage.local.get("latestData");
  if (latestData) {
    renderData(latestData);
  } else {
    // Check if portfolio exists
    const { portfolio } = await chrome.storage.sync.get("portfolio");
    if (!portfolio || !portfolio.accounts?.length) {
      showEmpty();
    } else {
      document.getElementById("holdingsTab").innerHTML =
        '<div class="empty">正在加载数据...</div>';
      refresh();
    }
  }
});

// ---- Render ----
function renderData(data) {
  if (!data || !data.holdings) return;

  const { totalCNY, totalPnl, totalPnlPct, todayChg, rate } = data;

  document.getElementById("totalAssets").textContent = `¥${fmtW(totalCNY)}`;

  const pnlEl = document.getElementById("totalPnl");
  pnlEl.textContent = `${totalPnl >= 0 ? "+" : ""}¥${fmtW(totalPnl)}`;
  pnlEl.className = `value mask ${totalPnl >= 0 ? "up" : "down"}`;

  const pctText = ` (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%)`;
  pnlEl.textContent += pctText;

  const chgEl = document.getElementById("todayChg");
  chgEl.textContent = `${todayChg >= 0 ? "+" : ""}¥${fmtW(todayChg)}`;
  chgEl.className = `value mask ${todayChg >= 0 ? "up" : "down"}`;

  document.getElementById("rateDisplay").textContent = rate ? rate.toFixed(4) : "--";

  const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString("zh-CN") : "--";
  document.getElementById("updateTime").textContent = `更新于 ${time}`;

  renderHoldings(data.holdings, data.totalCNY);
  renderAttribution(data.holdings, data.totalCost, data.totalCNY);
}

function renderHoldings(holdings, totalCNY) {
  const container = document.getElementById("holdingsTab");
  if (!holdings.length) {
    container.innerHTML = '<div class="empty">暂无持仓</div>';
    return;
  }

  // Sort by market value
  const sorted = [...holdings].sort((a, b) => (b.mvCNY || 0) - (a.mvCNY || 0));

  let html = "";
  sorted.forEach((h) => {
    const cpCls = h.changePct > 0 ? "up" : h.changePct < 0 ? "down" : "";
    const pnlCls = h.pnl >= 0 ? "up" : "down";
    const arrow = h.changePct > 0 ? "▲" : h.changePct < 0 ? "▼" : "";
    const weight = totalCNY > 0 ? ((h.mvCNY || 0) / totalCNY * 100).toFixed(1) : "0";

    html += `
    <div class="holding-row">
      <div class="h-info">
        <div class="h-name">${esc(h.name)}</div>
        <div class="h-symbol">${h.symbol} · ${weight}%</div>
      </div>
      <div class="h-price">
        <div class="price ${cpCls}">${h.sym}${fmtN(h.currentPrice)}${h.afterHours ? '<span class="badge-ah">盘后</span>' : ""}</div>
        <div class="change ${cpCls}">${arrow} ${h.changePct >= 0 ? "+" : ""}${h.changePct.toFixed(2)}%</div>
      </div>
      <div class="h-pnl">
        <div class="pnl ${pnlCls} mask">${h.pnl >= 0 ? "+" : ""}${h.sym}${fmtW(h.pnl)}</div>
        <div class="pnl-pct">${h.pnlPct >= 0 ? "+" : ""}${h.pnlPct.toFixed(1)}%</div>
      </div>
    </div>`;
  });
  container.innerHTML = html;
}

function renderAttribution(holdings, totalCost, totalCNY) {
  const container = document.getElementById("attributionTab");
  if (!holdings.length) {
    container.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }

  const items = holdings.map((h) => {
    const pnlCNY = (h.pnl || 0) * (h.currency === "USD" ? (totalCNY / totalCost || 1) : 1);
    const contribution = totalCost > 0 ? ((h.mvCNY - h.costValue * (h.currency === "USD" ? (totalCNY > 0 ? h.mvCNY / (h.marketValue || 1) : 1) : 1)) / totalCost * 100) : 0;
    return { ...h, contribution: h.pnl * (h.mvCNY / (h.marketValue || 1)) / (totalCost || 1) * 100 };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const maxAbs = Math.max(...items.map((a) => Math.abs(a.contribution)), 0.01);

  let html = '<div style="padding:4px 0">';
  items.forEach((a) => {
    const isPos = a.contribution >= 0;
    const barColor = isPos ? "#ef4444" : "#10b981";
    const barW = Math.abs(a.contribution) / maxAbs * 100;
    const textCls = isPos ? "up" : "down";

    html += `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px">
      <div style="width:60px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600">${esc(a.name)}</div>
      <div style="flex:1;height:14px;background:#f1f5f9;border-radius:7px;overflow:hidden">
        <div style="height:100%;background:${barColor};border-radius:7px;width:${Math.max(2, barW)}%;transition:width .3s"></div>
      </div>
      <div style="width:60px;text-align:right;font-family:monospace" class="${textCls} mask">${a.contribution >= 0 ? "+" : ""}${a.contribution.toFixed(2)}%</div>
    </div>`;
  });
  html += "</div>";
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
  const btn = document.getElementById("maskBtn");
  btn.textContent = maskMode ? "👁 取消遮掩" : "👁 遮掩";
}

// ---- Actions ----
async function refresh() {
  document.getElementById("updateTime").textContent = "刷新中...";
  chrome.runtime.sendMessage({ type: "refresh" }, async () => {
    const { latestData } = await chrome.storage.local.get("latestData");
    if (latestData) renderData(latestData);
  });
}

function showSettings() {
  document.getElementById("mainView").style.display = "none";
  document.querySelector(".footer").style.display = "none";
  document.getElementById("settingsView").style.display = "";

  chrome.storage.sync.get("portfolio", ({ portfolio }) => {
    if (portfolio) {
      document.getElementById("configText").value = JSON.stringify(portfolio, null, 2);
    }
  });
}

function showMain() {
  document.getElementById("mainView").style.display = "";
  document.querySelector(".footer").style.display = "";
  document.getElementById("settingsView").style.display = "none";
}

async function saveConfig() {
  const text = document.getElementById("configText").value.trim();
  try {
    const data = JSON.parse(text);
    if (!data.accounts) throw new Error("缺少 accounts 字段");
    await chrome.storage.sync.set({ portfolio: data });
    showMain();
    // Clear old data and refresh
    await chrome.storage.local.remove("latestData");
    refresh();
  } catch (e) {
    alert("JSON 格式错误: " + e.message);
  }
}

function loadFromServer() {
  document.getElementById("serverImport").style.display = "";
}

async function doImport() {
  const url = document.getElementById("serverUrl").value.trim() || "http://localhost:3457";
  try {
    const res = await fetch(`${url}/api/portfolio`);
    const data = await res.json();
    document.getElementById("configText").value = JSON.stringify(data, null, 2);
    document.getElementById("serverImport").style.display = "none";
  } catch (e) {
    alert("导入失败: " + e.message);
  }
}

function showEmpty() {
  document.getElementById("holdingsTab").innerHTML = `
    <div class="empty">
      <p>尚未配置持仓</p>
      <p style="font-size:11px;margin-top:4px">点击下方"设置"按钮添加持仓配置</p>
      <button class="btn btn-primary" onclick="showSettings()" style="margin-top:12px">配置持仓</button>
    </div>`;
}

// ---- Utils ----
function fmtN(v) {
  if (v == null) return "--";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtW(v) {
  if (v == null) return "--";
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(2) + "万";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
