// js/trading.js
// 买入/卖出/费用/盈亏/T+1 校验

import { findStock, getPrice } from './market.js';

// A 股费用规则
export const FEE = {
  commissionRate: 0.00025,   // 佣金万 2.5
  commissionMin: 5,          // 最低 5 元
  stampTax: 0.0005,          // 印花税卖出单边 0.05%（2023.8 起）
  transferRate: 0.00001      // 沪市过户费 0.001%
};

export function calcFee(amount, isBuy, market) {
  const commission = Math.max(amount * FEE.commissionRate, FEE.commissionMin);
  const stampTax = isBuy ? 0 : amount * FEE.stampTax;
  const transfer = market === 'SH' ? amount * FEE.transferRate : 0;
  return { commission, stampTax, transfer, total: commission + stampTax + transfer };
}

let state = null;
let saveFn = null;

export function setState(s, save) {
  state = s;
  saveFn = save;
}

function pushTrade(type, code, name, shares, price, fee, realizedPnl = 0) {
  const trade = {
    id: (state.trades[state.trades.length - 1]?.id || 0) + 1,
    type, code, name, shares, price, fee,
    amount: price * shares,
    realizedPnl,
    date: state.currentDate
  };
  state.trades.push(trade);
  return trade;
}

export function buy(code, shares) {
  if (shares <= 0) return { ok: false, msg: '请输入有效股数' };
  if (shares % 100 !== 0) return { ok: false, msg: 'A股需按 100 股整数倍买入' };

  const s = findStock(code);
  if (!s) return { ok: false, msg: '股票不存在' };

  const price = getPrice(code, state.currentDate);
  if (price == null) return { ok: false, msg: '当日无行情' };

  const amount = price * shares;
  const fee = calcFee(amount, true, s.market).total;
  if (state.cash < amount + fee) return { ok: false, msg: '资金不足' };

  // 合并持仓（加权平均成本）
  const pos = state.positions.find(p => p.code === code);
  if (pos) {
    const totalCost = pos.costPrice * pos.shares + amount;
    pos.costPrice = +(totalCost / (pos.shares + shares)).toFixed(4);
    pos.shares += shares;
    pos.buyFee = (pos.buyFee || 0) + fee;
    // 保留最早 buyDate 用于 T+1 宽松判断
  } else {
    state.positions.push({
      code, name: s.name, shares,
      costPrice: price, buyDate: state.currentDate, buyFee: fee
    });
  }

  state.cash -= (amount + fee);
  const trade = pushTrade('buy', code, s.name, shares, price, fee);
  saveFn && saveFn(state);
  return { ok: true, trade };
}

export function canSell(code, shares) {
  const pos = state.positions.find(p => p.code === code);
  if (!pos || pos.shares < shares) return { ok: false, msg: '持仓不足' };
  if (shares % 100 !== 0) return { ok: false, msg: '需按 100 股整数倍卖出' };
  if (state.currentDate <= pos.buyDate) return { ok: false, msg: 'T+1：当日买入次日方可卖出' };
  return { ok: true };
}

export function sell(code, shares) {
  const chk = canSell(code, shares);
  if (!chk.ok) return chk;

  const s = findStock(code);
  const price = getPrice(code, state.currentDate);
  if (price == null) return { ok: false, msg: '当日无行情' };

  const amount = price * shares;
  const fee = calcFee(amount, false, s.market).total;
  const pos = state.positions.find(p => p.code === code);
  const realizedPnl = +((price - pos.costPrice) * shares - fee).toFixed(2);

  state.cash += (amount - fee);
  pos.shares -= shares;
  if (pos.shares === 0) {
    state.positions = state.positions.filter(p => p.code !== code);
  }

  const trade = pushTrade('sell', code, s.name, shares, price, fee, realizedPnl);
  saveFn && saveFn(state);
  return { ok: true, trade, realizedPnl };
}

export function positionPnl(pos) {
  const cur = getPrice(pos.code, state.currentDate);
  if (cur == null) return { marketValue: 0, cost: 0, floatPnl: 0, floatPnlPct: 0 };
  const mv = cur * pos.shares;
  const cost = pos.costPrice * pos.shares;
  return {
    marketValue: mv,
    cost,
    floatPnl: mv - cost,
    floatPnlPct: cost > 0 ? ((mv - cost) / cost) * 100 : 0
  };
}

export function totalAssets() {
  const mv = state.positions.reduce((sum, p) => sum + positionPnl(p).marketValue, 0);
  return { cash: state.cash, marketValue: mv, total: state.cash + mv };
}

export function totalPnl() {
  const t = totalAssets();
  const base = state.initialCapital + state.bonusCash;
  return { pnl: t.total - base, pct: base > 0 ? ((t.total - base) / base) * 100 : 0 };
}

// 单日总资产变化率（相对 base）
export function dayPnlPct(prevTotal) {
  if (!prevTotal || prevTotal === 0) return 0;
  return ((totalAssets().total - prevTotal) / prevTotal) * 100;
}

// 仓位占比
export function positionRatio() {
  const t = totalAssets();
  if (t.total === 0) return 0;
  return t.marketValue / t.total;
}
