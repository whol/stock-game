// js/market.js
// 股票数据加载、当日价格查询、日期推进、交易日历

let stocksData = null;          // { range, stocks: [...] }
let customStocks = [];          // 用户导入的股票
let tradingDays = [];           // 所有交易日升序去重
let state = null;               // 引用 store 的 state（由 main 注入）

export function setState(s) { state = s; }

export function getStocksData() { return stocksData; }

export function getAllStocks() {
  // 合并内置 + customStocks（customStocks 优先，去重）
  const map = new Map();
  if (stocksData) stocksData.stocks.forEach(s => map.set(s.code, s));
  customStocks.forEach(s => map.set(s.code, s));
  return [...map.values()];
}

export function findStock(code) {
  return getAllStocks().find(s => s.code === code);
}

export function getTradingDays() { return tradingDays; }

export function isTradingDay(date) { return tradingDays.includes(date); }

export async function loadStocks() {
  const resp = await fetch('data/stocks.json');
  if (!resp.ok) throw new Error('加载 stocks.json 失败: ' + resp.status);
  stocksData = await resp.json();
  rebuildTradingDays();
  return stocksData;
}

export function loadCustomStocks(saved) {
  customStocks = Array.isArray(saved) ? saved : [];
  rebuildTradingDays();
}

export function addCustomStock(stock) {
  // 去重覆盖
  customStocks = customStocks.filter(s => s.code !== stock.code);
  customStocks.push(stock);
  rebuildTradingDays();
}

function rebuildTradingDays() {
  const set = new Set();
  getAllStocks().forEach(s => s.kline.forEach(b => set.add(b.date)));
  tradingDays = [...set].sort();
}

export function advanceDay(n = 1) {
  let idx = tradingDays.indexOf(state.currentDate);
  if (idx === -1) idx = 0;
  idx = Math.min(idx + n, tradingDays.length - 1);
  state.currentDate = tradingDays[idx];
  state.stats.daysPlayed++;
  return state.currentDate;
}

export function getCurrentDate() { return state.currentDate; }

export function getBar(code, date) {
  const s = findStock(code);
  if (!s) return null;
  return s.kline.find(b => b.date === date) || null;
}

export function getPrice(code, date) {
  const bar = getBar(code, date);
  return bar ? bar.last : null;
}

export function getRecent(code, n) {
  const s = findStock(code);
  if (!s) return [];
  const bars = s.kline.filter(b => b.date <= state.currentDate);
  return bars.slice(-n);
}

// 计算某股票截至当前日期的连涨/连跌天数（向后看）
export function getStreak(code) {
  const recent = getRecent(code, 30);
  if (recent.length < 2) return { type: 'none', days: 0 };
  const last = recent[recent.length - 1];
  if (!last.pct || last.pct === 0) return { type: 'none', days: 0 };
  const dir = last.pct > 0 ? 'up' : 'down';
  let days = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const p = recent[i].pct;
    if (dir === 'up' && p > 0) days++;
    else if (dir === 'down' && p < 0) days++;
    else break;
  }
  return { type: dir, days };
}
