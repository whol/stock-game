// js/achievements.js
// 15 个成就定义 + 检测引擎 + 奖励发放

import { totalAssets, positionPnl, positionRatio } from './trading.js';
import { getStreak, getRecent } from './market.js';

let state = null;
let saveFn = null;

export function setState(s, save) {
  state = s;
  saveFn = save;
}

// 成就定义表
// check(ctx) ctx = { event, prevAssets, newAssets }
// event: { type: 'buy'|'sell'|'advance', ... }
export const ACHIEVEMENTS = [
  {
    id: 'first_buy',
    name: '初出茅庐',
    desc: '完成第一笔买入',
    icon: '🎯',
    reward: { type: 'title', value: '股市新人' },
    check: (ctx) => ctx.event?.type === 'buy' &&
      state.trades.filter(t => t.type === 'buy').length === 1
  },
  {
    id: 'first_sell',
    name: '落袋为安',
    desc: '完成第一笔卖出',
    icon: '💰',
    reward: { type: 'title', value: '交易者' },
    check: (ctx) => ctx.event?.type === 'sell' &&
      state.trades.filter(t => t.type === 'sell').length === 1
  },
  {
    id: 'first_profit',
    name: '开门红',
    desc: '首次单笔卖出盈利',
    icon: '🏆',
    reward: { type: 'title', value: '盈利先锋' },
    check: (ctx) => ctx.event?.type === 'sell' && (ctx.event.realizedPnl || 0) > 0
  },
  {
    id: 'streak_up_3',
    name: '小试牛刀',
    desc: '持仓股连涨 3 天',
    icon: '📈',
    reward: { type: 'title', value: '顺风顺水' },
    check: () => state.positions.some(p => getStreak(p.code).type === 'up' && getStreak(p.code).days >= 3)
  },
  {
    id: 'streak_up_5',
    name: '乘风破浪',
    desc: '持仓股连涨 5 天',
    icon: '🚀',
    reward: { type: 'title', value: '趋势骑手' },
    check: () => state.positions.some(p => getStreak(p.code).type === 'up' && getStreak(p.code).days >= 5)
  },
  {
    id: 'streak_down_3',
    name: '逆风前行',
    desc: '持仓股连跌 3 天仍持有',
    icon: '🪨',
    reward: { type: 'title', value: '铁头娃' },
    check: () => state.positions.some(p => getStreak(p.code).type === 'down' && getStreak(p.code).days >= 3)
  },
  {
    id: 'day_pnl_up_5',
    name: '暴富时刻',
    desc: '单日总资产涨幅 >5%',
    icon: '💎',
    reward: { type: 'title', value: '日内高手' },
    check: (ctx) => ctx.event?.type === 'advance' &&
      ctx.prevAssets > 0 && ((ctx.newAssets - ctx.prevAssets) / ctx.prevAssets * 100) > 5
  },
  {
    id: 'day_pnl_down_5',
    name: '黑色时刻',
    desc: '单日总资产跌幅 >5%',
    icon: '🌑',
    reward: { type: 'title', value: '扛把子' },
    check: (ctx) => ctx.event?.type === 'advance' &&
      ctx.prevAssets > 0 && ((ctx.newAssets - ctx.prevAssets) / ctx.prevAssets * 100) < -5
  },
  {
    id: 'assets_200k',
    name: '翻倍达人',
    desc: '总资产达到 20 万',
    icon: '🌟',
    reward: { type: 'title', value: '小富翁' },
    check: (ctx) => ctx.newAssets >= 200000
  },
  {
    id: 'assets_500k',
    name: '五十俱乐部',
    desc: '总资产达到 50 万',
    icon: '👑',
    reward: { type: 'title', value: '五旬尊者' },
    check: (ctx) => ctx.newAssets >= 500000
  },
  {
    id: 'assets_1m',
    name: '百万富翁',
    desc: '总资产达到 100 万',
    icon: '🏆',
    reward: { type: 'title', value: '股神在世' },
    check: (ctx) => ctx.newAssets >= 1000000
  },
  {
    id: 'hold_3_stocks',
    name: '分散投资',
    desc: '同时持有 ≥3 只不同股票',
    icon: '🧩',
    reward: { type: 'unlock', value: 'import' },
    check: () => state.positions.length >= 3
  },
  {
    id: 'full_position',
    name: '满仓出击',
    desc: '仓位占比 >90%',
    icon: '🔥',
    reward: { type: 'title', value: '激进派' },
    check: () => state.positions.length > 0 && positionRatio() > 0.9
  },
  {
    id: 'hold_30_days',
    name: '长情陪伴',
    desc: '单只股票持有 ≥30 个交易日',
    icon: '❤️',
    reward: { type: 'title', value: '长情守候' },
    check: (ctx) => {
      if (ctx.event?.type !== 'advance') return false;
      return state.positions.some(p => state.stats.daysPlayed >= 30 ||
        state.trades.some(t => t.type === 'buy' && t.code === p.code && t.date <= state.currentDate &&
          dayDiff(t.date, state.currentDate) >= 30));
    }
  },
  {
    id: 'days_60',
    name: '坚持就是胜利',
    desc: '推进游戏 ≥60 天',
    icon: '⏳',
    reward: { type: 'title', value: '时光旅人' },
    check: () => state.stats.daysPlayed >= 60
  }
];

// 计算两个日期间的交易日数（近似用日历日，足够触发判断）
function dayDiff(start, end) {
  const s = new Date(start), e = new Date(end);
  return Math.floor((e - s) / 86400000);
}

export function isUnlocked(id) {
  return state.achievements.some(a => a.id === id && a.unlocked);
}

// 检测并发放新成就
export function checkAchievements(event, prevAssets) {
  const newly = [];
  const newAssets = totalAssets().total;
  const ctx = { event, prevAssets, newAssets };

  for (const a of ACHIEVEMENTS) {
    if (isUnlocked(a.id)) continue;
    let ok = false;
    try { ok = a.check(ctx); } catch (e) { console.error('成就检测错误', a.id, e); }
    if (ok) {
      state.achievements.push({
        id: a.id, unlocked: true, unlockedDate: state.currentDate
      });
      applyReward(a);
      newly.push(a);
    }
  }

  // 更新最大资产
  if (newAssets > state.stats.maxAssets) state.stats.maxAssets = newAssets;

  if (newly.length) saveFn && saveFn(state);
  return newly;
}

function applyReward(a) {
  const r = a.reward;
  if (!r) return;
  if (r.type === 'cash') {
    // 奖励资金：既增加基准（bonusCash），也真正把钱加到现金账户
    state.bonusCash += r.value;
    state.cash += r.value;
  } else if (r.type === 'title') {
    state.title = r.value;
  } else if (r.type === 'unlock' && r.value === 'import') {
    state.importUnlocked = true;
  }
}

export function getProgress() {
  return { unlocked: state.achievements.length, total: ACHIEVEMENTS.length };
}
