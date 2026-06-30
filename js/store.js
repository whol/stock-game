// js/store.js
// 游戏状态管理 + localStorage 持久化

const KEY = 'stock-game-save-v1';

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.error('存档失败（可能 localStorage 超限）:', e);
  }
}

export function reset() {
  localStorage.removeItem(KEY);
}

export function defaultState(startDate, endDate, stockCodes) {
  return {
    version: 1,
    startDate,
    endDate,
    currentDate: startDate,
    cash: 100000,
    initialCapital: 100000,
    bonusCash: 0,
    positions: [],
    trades: [],
    achievements: [],
    title: '股市新人',
    stats: {
      maxAssets: 100000,
      daysPlayed: 0,
      maxWinStreak: 0,   // 持仓股最大连涨天数
      maxLoseStreak: 0
    },
    unlockedStocks: [...stockCodes],
    customStocks: [],
    importUnlocked: false  // 添加股票功能是否解锁
  };
}
