// js/ui.js
// DOM 渲染、数字滚动动画、特效、Toast

import { getAllStocks, getRecent, getStreak, getCurrentDate, getTradingDays } from './market.js';
import { totalAssets, totalPnl, positionPnl, positionRatio } from './trading.js';
import { ACHIEVEMENTS, isUnlocked, getProgress } from './achievements.js';

let stateRef = null;
let onSelectStockCb = null;
let prevTotalAssets = null;

export function setState(s, onSelect) {
  stateRef = s;
  onSelectStockCb = onSelect;
}

export function isCompact() {
  const list = document.getElementById('stockList');
  return list && list.classList.contains('compact');
}

// ===== 格式化 =====
export function formatMoney(v) {
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 100000000) return `${sign}¥${(abs / 100000000).toFixed(2)}亿`;
  if (abs >= 10000) return `${sign}¥${(abs / 10000).toFixed(2)}万`;
  return `${sign}¥${abs.toFixed(2)}`;
}

export function formatMoneyFull(v) {
  return (v < 0 ? '-¥' : '¥') + Math.abs(v).toFixed(2);
}

export function formatPct(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

// ===== 数字滚动动画 =====
export function animateNumber(el, from, to, dur = 600, formatter = formatMoney) {
  if (!el) return;
  if (from === to) { el.textContent = formatter(to); return; }
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / dur, 1);
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    el.textContent = formatter(from + (to - from) * e);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ===== Toast =====
export function toast(msg, type = 'info', duration = 2800) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

export function achievementToast(ach) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast achievement';
  let rewardText = '';
  if (ach.reward?.type === 'cash') rewardText = ` 奖励 +¥${ach.reward.value}`;
  else if (ach.reward?.type === 'title') rewardText = ` 称号「${ach.reward.value}」`;
  else if (ach.reward?.type === 'unlock') rewardText = ` 解锁新功能`;
  el.innerHTML = `
    <div class="toast-title">${ach.icon} 成就解锁：${ach.name}</div>
    <div style="font-size:12px;color:#e6edf3;">${ach.desc}${rewardText}</div>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

// ===== 顶部资产栏 =====
export function renderAssetBar() {
  const t = totalAssets();
  const p = totalPnl();

  // 日期
  const dateEl = document.getElementById('currentDate');
  dateEl.textContent = stateRef.currentDate;
  const total = getTradingDays().length;
  const idx = getTradingDays().indexOf(stateRef.currentDate) + 1;
  document.getElementById('dayProgress').textContent = `第 ${idx} / ${total} 日`;

  // 资产数字（带动画）
  const cashEl = document.getElementById('cash');
  const mvEl = document.getElementById('marketValue');
  const totalEl = document.getElementById('totalAssets');
  const pnlEl = document.getElementById('totalPnl');
  const pnlPctEl = document.getElementById('totalPnlPct');

  animateNumber(cashEl, parseFloat(cashEl.dataset.v || 0), t.cash, 400, formatMoneyFull);
  animateNumber(mvEl, parseFloat(mvEl.dataset.v || 0), t.marketValue, 400, formatMoneyFull);
  animateNumber(totalEl, parseFloat(totalEl.dataset.v || 0), t.total, 500, formatMoneyFull);
  cashEl.dataset.v = t.cash;
  mvEl.dataset.v = t.marketValue;
  totalEl.dataset.v = t.total;

  pnlEl.textContent = formatMoneyFull(p.pnl);
  pnlEl.className = 'stat-value ' + (p.pnl >= 0 ? 'num-up' : 'num-down');
  pnlPctEl.textContent = formatPct(p.pct);
  pnlPctEl.className = 'stat-sub ' + (p.pnl >= 0 ? 'num-up' : 'num-down');

  document.getElementById('playerTitle').textContent = stateRef.title;
}

// ===== 左侧股票列表 =====
export function renderStockList(currentCode) {
  const list = document.getElementById('stockList');
  const stocks = getAllStocks();
  const isCompact = list.classList.contains('compact');
  list.innerHTML = '';

  for (const s of stocks) {
    const recent = getRecent(s.code, 20);
    const lastBar = recent[recent.length - 1];
    if (!lastBar) continue;
    const pct = lastBar.pct || 0;
    const cls = pct > 0 ? 'num-up' : pct < 0 ? 'num-down' : 'num-flat';
    const sign = pct > 0 ? '+' : '';

    const card = document.createElement('div');
    card.className = 'stock-card' + (s.code === currentCode ? ' active' : '');
    card.dataset.code = s.code;

    if (isCompact) {
      // 紧凑模式：纯单行 — 名称 价格 涨跌%
      card.innerHTML = `
        <span class="sc-name ${cls}">${s.name}</span>
        <span class="sc-right">
          <span class="sc-price ${cls}">${lastBar.last.toFixed(2)}</span>
          <span class="sc-pct ${cls}">${sign}${pct.toFixed(2)}%</span>
        </span>
      `;
    } else {
      // 正常模式：带 sparkline 的卡片
      const prices = recent.map(b => b.last);
      const minP = Math.min(...prices), maxP = Math.max(...prices);
      const range = maxP - minP || 1;
      const w = 240, h = 14;
      const pts = prices.map((p, i) => {
        const x = (i / (prices.length - 1 || 1)) * w;
        const y = h - ((p - minP) / range) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      const strokeColor = pct >= 0 ? '#ff4d4f' : '#26a69a';
      card.innerHTML = `
        <div class="stock-card-row">
          <div>
            <div class="stock-name">${s.name}</div>
            <div class="stock-code">${s.code} · ${s.sector}</div>
          </div>
          <div style="text-align:right">
            <div class="stock-price ${cls}">${lastBar.last.toFixed(2)}</div>
            <div class="stock-pct ${cls}">${sign}${pct.toFixed(2)}%</div>
          </div>
        </div>
        <svg class="stock-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%">
          <polyline points="${pts}" fill="none" stroke="${strokeColor}" stroke-width="1.2" />
        </svg>
      `;
    }

    card.addEventListener('click', () => onSelectStockCb && onSelectStockCb(s.code));
    list.appendChild(card);
  }
}

// ===== 中间K线标题 =====
export function renderChartHeader(code) {
  const s = getAllStocks().find(x => x.code === code);
  if (!s) return;
  const recent = getRecent(code, 2);
  const lastBar = recent[recent.length - 1];
  const prevBar = recent[recent.length - 2];
  document.getElementById('chartName').textContent = s.name;
  document.getElementById('chartCode').textContent = `${s.code} · ${s.sector} · ${s.story}`;
  if (!lastBar) return;
  document.getElementById('chartPrice').textContent = lastBar.last.toFixed(2);
  const pct = lastBar.pct || 0;
  const pctEl = document.getElementById('chartPct');
  pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  pctEl.className = 'chart-pct ' + (pct >= 0 ? 'num-up' : 'num-down');
  pctEl.style.background = pct >= 0 ? 'var(--up-soft)' : 'var(--down-soft)';
}

// ===== 右侧持仓 =====
export function renderPositions() {
  const list = document.getElementById('positionsList');
  list.innerHTML = '';
  if (!stateRef.positions.length) {
    list.innerHTML = '<div class="empty-hint">还没有持仓<br>选一只股票开始买入吧</div>';
    return;
  }
  for (const p of stateRef.positions) {
    const pnl = positionPnl(p);
    const cls = pnl.floatPnl >= 0 ? 'num-up' : 'num-down';
    const card = document.createElement('div');
    card.className = 'position-card';
    card.innerHTML = `
      <div class="position-header">
        <span class="position-name">${p.name}</span>
        <span class="position-shares">${p.shares}股</span>
      </div>
      <div class="position-grid">
        <span>成本 <b>${p.costPrice.toFixed(2)}</b></span>
        <span>现价 <b>${(pnl.marketValue / p.shares).toFixed(2)}</b></span>
        <span>市值 <b>${formatMoney(pnl.marketValue)}</b></span>
        <span>浮盈 <b class="${cls}">${formatMoney(pnl.floatPnl)}</b></span>
        <span style="grid-column:1/-1">收益率 <b class="${cls}">${pnl.floatPnlPct >= 0 ? '+' : ''}${pnl.floatPnlPct.toFixed(2)}%</b></span>
      </div>
    `;
    list.appendChild(card);
  }
}

// ===== 右侧成就 =====
export function renderAchievements() {
  const list = document.getElementById('achievementsList');
  list.innerHTML = '';
  const prog = getProgress();
  document.getElementById('achProgress').textContent = `${prog.unlocked}/${prog.total}`;

  for (const a of ACHIEVEMENTS) {
    const unlocked = isUnlocked(a.id);
    const item = document.createElement('div');
    item.className = 'ach-item ' + (unlocked ? 'unlocked' : 'locked');
    let rewardLabel = '';
    if (a.reward?.type === 'cash') rewardLabel = `+¥${a.reward.value}`;
    else if (a.reward?.type === 'title') rewardLabel = '称号';
    else if (a.reward?.type === 'unlock') rewardLabel = '解锁';
    item.innerHTML = `
      <span class="ach-icon">${unlocked ? a.icon : '🔒'}</span>
      <div class="ach-info">
        <div class="ach-name">${a.name}</div>
        <div class="ach-desc">${a.desc}</div>
      </div>
      ${rewardLabel ? `<span class="ach-reward">${rewardLabel}</span>` : ''}
    `;
    list.appendChild(item);
  }
}

// ===== 黑屏闪红（单日大跌） =====
export function flashCrash() {
  document.body.classList.remove('crash');
  void document.body.offsetWidth; // 触发重排
  document.body.classList.add('crash');
  setTimeout(() => document.body.classList.remove('crash'), 900);
}

// ===== 刷新添加股票按钮状态 =====
export function refreshAddStockBtn() {
  const btn = document.getElementById('addStockBtn');
  if (stateRef.importUnlocked) {
    btn.classList.remove('locked');
    btn.classList.add('unlocked');
    btn.innerHTML = '➕ 添加股票';
    btn.title = '添加新股票';
  } else {
    btn.classList.add('locked');
    btn.classList.remove('unlocked');
    btn.innerHTML = '🔒 添加股票';
    btn.title = "达成『分散投资』(同时持有3只股票)解锁";
  }
}
