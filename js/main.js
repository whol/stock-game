// js/main.js
// 入口：初始化、加载存档、绑定全局事件、主循环

import * as store from './store.js';
import * as market from './market.js';
import * as trading from './trading.js';
import * as ach from './achievements.js';
import * as chart from './chart.js';
import * as ui from './ui.js';
import * as importer from './importer.js';

let state = null;
let currentCode = null;
let playTimer = null;
let prevDayAssets = null;  // 用于单日盈亏判断

// ===== 初始化 =====
async function init() {
  try {
    await market.loadStocks();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;text-align:center;color:#ff4d4f">
      数据加载失败：${e.message}<br>请通过本地服务器（如 <code>python -m http.server</code>）打开本页</div>`;
    return;
  }

  const range = market.getStocksData().range;
  const stockCodes = market.getStocksData().stocks.map(s => s.code);

  // 读取存档
  const saved = store.load();
  if (saved && saved.version === 1) {
    state = saved;
    market.loadCustomStocks(state.customStocks);
  } else {
    state = store.defaultState(range.start, range.end, stockCodes);
    store.save(state);
    market.loadCustomStocks([]);
  }

  // 注入 state 到各模块
  market.setState(state);
  trading.setState(state, store.save);
  ach.setState(state, store.save);
  chart.setState(state);
  ui.setState(state, selectStock);
  importer.setState(state, store.save, (code) => {
    ui.renderStockList(currentCode);
    selectStock(code);
  });

  // 默认选中第一只股票
  currentCode = state.unlockedStocks[0] || stockCodes[0];

  // 先绑定事件，确保即使 chart 初始化失败也能交互
  bindEvents();

  // 初始化 K 线图（失败不影响其他功能）
  try {
    chart.initChart();
  } catch (e) {
    console.error('K线图初始化失败:', e);
    ui.toast('K线图加载失败，其他功能仍可用', 'error');
  }

  renderAll();
}

// ===== 全量刷新 =====
function renderAll() {
  ui.renderAssetBar();
  ui.renderStockList(currentCode);
  ui.renderChartHeader(currentCode);
  chart.renderStock(currentCode);
  ui.renderPositions();
  ui.renderAchievements();
  ui.refreshAddStockBtn();
}

// ===== 选股 =====
function selectStock(code) {
  currentCode = code;
  ui.renderStockList(currentCode);
  ui.renderChartHeader(currentCode);
  chart.renderStock(currentCode);
}

// ===== 时间推进 =====
function advanceOneDay() {
  if (state.currentDate === state.endDate) {
    stopPlay();
    ui.toast('已到达数据终点', 'info');
    return;
  }
  prevDayAssets = trading.totalAssets().total;
  market.advanceDay(1);

  // 检测成就（推进日事件）
  const newly = ach.checkAchievements({ type: 'advance', prevAssets: prevDayAssets }, prevDayAssets);
  newly.forEach(a => ui.achievementToast(a));

  // 单日大跌红屏
  const dayChgPct = trading.dayPnlPct(prevDayAssets);
  if (dayChgPct < -5) ui.flashCrash();

  // 刷新 UI
  ui.renderAssetBar();
  ui.renderStockList(currentCode);
  ui.renderChartHeader(currentCode);
  chart.renderStock(currentCode);
  ui.renderPositions();
  ui.renderAchievements();
  ui.refreshAddStockBtn();

  store.save(state);
}

// ===== 播放控制 =====
function startPlay() {
  if (playTimer) return;
  const speed = parseInt(document.getElementById('speed').value, 10);
  document.getElementById('playPause').textContent = '⏸';
  playTimer = setInterval(advanceOneDay, speed);
}

function stopPlay() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
  document.getElementById('playPause').textContent = '▶';
}

function togglePlay() {
  if (playTimer) stopPlay();
  else startPlay();
}

function changeSpeed() {
  if (playTimer) {
    stopPlay();
    startPlay();
  }
}

// ===== 交易弹窗 =====
let tradeMode = 'buy'; // 'buy' | 'sell'

function openTradeModal(mode) {
  tradeMode = mode;
  const s = market.findStock(currentCode);
  if (!s) return;
  const price = market.getPrice(currentCode, state.currentDate);
  if (price == null) {
    ui.toast('当日无行情', 'error');
    return;
  }

  const modal = document.getElementById('tradeModal');
  document.getElementById('tradeModalTitle').textContent = mode === 'buy' ? '买入' : '卖出';
  document.getElementById('tradeStockName').textContent = `${s.name} ${s.code}`;
  document.getElementById('tradeStockPrice').textContent = `¥${price.toFixed(2)}`;
  document.getElementById('tradeMsg').textContent = '';
  document.getElementById('tradeMsg').className = 'trade-msg';

  const input = document.getElementById('sharesInput');
  input.value = 100;
  input.min = 100;
  input.step = 100;

  // 卖出模式下，全仓按钮替换为「持仓」
  const maxBtn = document.getElementById('maxShares');
  const pos = state.positions.find(p => p.code === currentCode);
  if (mode === 'sell') {
    maxBtn.textContent = '清仓';
    maxBtn.dataset.shares = pos ? pos.shares : 0;
  } else {
    maxBtn.textContent = '全仓';
    delete maxBtn.dataset.shares;
  }

  updateTradePreview();
  modal.classList.remove('hidden');

  const confirmBtn = document.getElementById('confirmTrade');
  confirmBtn.textContent = mode === 'buy' ? '确认买入' : '确认卖出';
  confirmBtn.className = mode === 'buy' ? 'btn btn-buy' : 'btn btn-sell';
}

function closeTradeModal() {
  document.getElementById('tradeModal').classList.add('hidden');
}

function updateTradePreview() {
  const s = market.findStock(currentCode);
  if (!s) return;
  const price = market.getPrice(currentCode, state.currentDate);
  if (price == null) return;
  const shares = parseInt(document.getElementById('sharesInput').value, 10) || 0;
  const amount = price * shares;
  const fee = trading.calcFee(amount, tradeMode === 'buy', s.market).total;

  document.getElementById('tradeAmount').textContent = ui.formatMoneyFull(amount);
  document.getElementById('tradeFee').textContent = ui.formatMoneyFull(fee);

  const msgEl = document.getElementById('tradeMsg');
  msgEl.textContent = '';
  msgEl.className = 'trade-msg';

  // 校验提示
  if (shares % 100 !== 0) {
    msgEl.textContent = 'A股需按 100 股整数倍交易';
    msgEl.className = 'trade-msg error';
  } else if (tradeMode === 'buy' && amount + fee > state.cash) {
    msgEl.textContent = '资金不足';
    msgEl.className = 'trade-msg error';
  } else if (tradeMode === 'sell') {
    const chk = trading.canSell(currentCode, shares);
    if (!chk.ok) {
      msgEl.textContent = chk.msg;
      msgEl.className = 'trade-msg error';
    }
  }
}

function confirmTrade() {
  const shares = parseInt(document.getElementById('sharesInput').value, 10) || 0;
  const msgEl = document.getElementById('tradeMsg');

  let result;
  let eventObj;
  if (tradeMode === 'buy') {
    result = trading.buy(currentCode, shares);
    eventObj = { type: 'buy' };
  } else {
    result = trading.sell(currentCode, shares);
    eventObj = { type: 'sell', realizedPnl: result.realizedPnl || 0 };
  }

  if (!result.ok) {
    msgEl.textContent = result.msg;
    msgEl.className = 'trade-msg error';
    return;
  }

  // 成功
  const trade = result.trade;
  const verb = tradeMode === 'buy' ? '买入' : '卖出';
  ui.toast(`✓ ${verb} ${trade.name} ${trade.shares}股 @${trade.price.toFixed(2)}`, 'success');

  closeTradeModal();

  // 检测成就
  const prevAssets = trading.totalAssets().total;
  const newly = ach.checkAchievements(eventObj, prevAssets);
  newly.forEach(a => ui.achievementToast(a));

  renderAll();
}

// ===== 添加股票弹窗 =====
function openAddStockModal() {
  if (!state.importUnlocked) {
    ui.toast("达成『分散投资』(同时持有3只股票)解锁", 'info', 3000);
    return;
  }
  document.getElementById('addStockModal').classList.remove('hidden');
  // 默认在线 tab
  switchTab('online');
  // 清空输入
  document.getElementById('onlineCode').value = '';
  document.getElementById('onlineName').value = '';
  document.getElementById('pasteCode').value = '';
  document.getElementById('pasteName').value = '';
  document.getElementById('pasteJson').value = '';
  document.getElementById('onlineMsg').textContent = '';
  document.getElementById('pasteMsg').textContent = '';
}

function closeAddStockModal() {
  document.getElementById('addStockModal').classList.add('hidden');
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.getElementById('tabOnline').classList.toggle('hidden', tab !== 'online');
  document.getElementById('tabPaste').classList.toggle('hidden', tab !== 'paste');
}

async function doFetchOnline() {
  const code = document.getElementById('onlineCode').value.trim();
  const name = document.getElementById('onlineName').value.trim();
  const msgEl = document.getElementById('onlineMsg');
  const btn = document.getElementById('fetchOnlineBtn');

  if (!code) {
    msgEl.textContent = '请输入股票代码';
    msgEl.className = 'trade-msg error';
    return;
  }

  btn.disabled = true;
  btn.textContent = '获取中…';
  msgEl.textContent = '';
  msgEl.className = 'trade-msg';

  const result = await importer.fetchOnline(code, name);

  btn.disabled = false;
  btn.textContent = '获取并导入';

  if (!result.ok) {
    msgEl.textContent = result.msg;
    msgEl.className = 'trade-msg error';
    if (result.fallback) {
      // 自动切到粘贴 tab
      switchTab('paste');
      document.getElementById('pasteCode').value = code.toLowerCase();
      document.getElementById('pasteName').value = name;
      document.getElementById('pasteJson').placeholder =
        `直连失败，请在主对话执行：\nwestock-data kline ${code.toLowerCase()} --start 2024-01-01 --end 2025-06-30 --period day --fq qfq --raw\n把返回 JSON 粘贴到这里`;
    }
    return;
  }

  importer.notifyImported(result.stock);
  closeAddStockModal();
}

function doImportPaste() {
  const code = document.getElementById('pasteCode').value.trim();
  const name = document.getElementById('pasteName').value.trim();
  const json = document.getElementById('pasteJson').value;
  const msgEl = document.getElementById('pasteMsg');

  if (!code) {
    msgEl.textContent = '请输入股票代码';
    msgEl.className = 'trade-msg error';
    return;
  }
  if (!json) {
    msgEl.textContent = '请粘贴 JSON 数据';
    msgEl.className = 'trade-msg error';
    return;
  }

  const result = importer.importPasted(json, code, name);
  if (!result.ok) {
    msgEl.textContent = result.msg;
    msgEl.className = 'trade-msg error';
    return;
  }

  importer.notifyImported(result.stock);
  closeAddStockModal();
}

// ===== 重置游戏 =====
function confirmReset() {
  if (!confirm('确定重置游戏？所有持仓、成就、资金将清空。')) return;
  store.reset();
  const range = market.getStocksData().range;
  const stockCodes = market.getStocksData().stocks.map(s => s.code);
  state = store.defaultState(range.start, range.end, stockCodes);
  store.save(state);
  market.loadCustomStocks([]);
  market.setState(state);
  trading.setState(state, store.save);
  ach.setState(state, store.save);
  chart.setState(state);
  ui.setState(state, selectStock);
  importer.setState(state, store.save, (code) => {
    ui.renderStockList(currentCode);
    selectStock(code);
  });
  // 重置画线
  chart.clearDrawings();
  currentCode = stockCodes[0];
  ui.toast('游戏已重置', 'info');
  renderAll();
}

// ===== 搜索 =====
function handleSearch(e) {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.stock-card').forEach(card => {
    const code = card.dataset.code;
    const s = market.findStock(code);
    if (!s) return;
    const match = !q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q);
    card.style.display = match ? '' : 'none';
  });
}

// ===== 绑定事件 =====
function bindEvents() {
  // 时间
  document.getElementById('prevDay').addEventListener('click', () => {
    if (playTimer) stopPlay();
    // 回退一天
    const days = market.getTradingDays();
    let idx = days.indexOf(state.currentDate);
    if (idx > 0) {
      state.currentDate = days[idx - 1];
      renderAll();
      store.save(state);
    }
  });
  document.getElementById('nextDay').addEventListener('click', () => {
    if (playTimer) stopPlay();
    advanceOneDay();
  });
  document.getElementById('playPause').addEventListener('click', togglePlay);
  document.getElementById('speed').addEventListener('change', changeSpeed);
  document.getElementById('resetGame').addEventListener('click', confirmReset);

  // 交易
  document.getElementById('buyBtn').addEventListener('click', () => openTradeModal('buy'));
  document.getElementById('sellBtn').addEventListener('click', () => openTradeModal('sell'));

  // 交易弹窗
  document.getElementById('sharesInput').addEventListener('input', updateTradePreview);
  document.getElementById('sharesMinus').addEventListener('click', () => {
    const inp = document.getElementById('sharesInput');
    inp.value = Math.max(100, (parseInt(inp.value, 10) || 100) - 100);
    updateTradePreview();
  });
  document.getElementById('sharesPlus').addEventListener('click', () => {
    const inp = document.getElementById('sharesInput');
    inp.value = (parseInt(inp.value, 10) || 0) + 100;
    updateTradePreview();
  });
  document.querySelectorAll('.quick-shares button').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById('sharesInput');
      if (btn.id === 'maxShares') {
        if (tradeMode === 'sell') {
          const pos = state.positions.find(p => p.code === currentCode);
          inp.value = pos ? pos.shares : 0;
        } else {
          const price = market.getPrice(currentCode, state.currentDate);
          if (price) {
            const max = Math.floor(state.cash / price / 100) * 100;
            inp.value = Math.max(100, max);
          }
        }
      } else {
        inp.value = btn.dataset.shares;
      }
      updateTradePreview();
    });
  });
  document.getElementById('confirmTrade').addEventListener('click', confirmTrade);

  // 指标切换
  document.querySelectorAll('[data-indicator]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ind = btn.dataset.indicator;
      document.querySelectorAll('[data-indicator]').forEach(b => b.classList.toggle('active', b === btn));
      chart.setIndicator(ind);
    });
  });

  // 画线工具
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      chart.setTool(t);
      document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  // 重置视图
  const resetViewBtn = document.getElementById('resetViewBtn');
  if (resetViewBtn) resetViewBtn.addEventListener('click', () => chart.resetView());

  // 添加股票
  document.getElementById('addStockBtn').addEventListener('click', openAddStockModal);
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  document.getElementById('fetchOnlineBtn').addEventListener('click', doFetchOnline);
  document.getElementById('importPasteBtn').addEventListener('click', doImportPaste);

  // 通用关闭
  document.querySelectorAll('[data-close]').forEach(b => {
    b.addEventListener('click', () => {
      document.getElementById('tradeModal').classList.add('hidden');
      document.getElementById('addStockModal').classList.add('hidden');
    });
  });
  // 点遮罩关闭
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  });
  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('tradeModal').classList.add('hidden');
      document.getElementById('addStockModal').classList.add('hidden');
    }
  });

  // 搜索
  document.getElementById('stockSearch').addEventListener('input', handleSearch);
}

// 启动
init();
