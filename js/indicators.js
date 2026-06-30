// js/indicators.js
// 技术指标计算：BOLL / MACD / KDJ

// SMA 简单移动平均
function sma(values, period) {
  const result = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += values[i - j];
    result[i] = sum / period;
  }
  return result;
}

// EMA 指数移动平均
function ema(values, period) {
  const result = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[i - j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    result[i] = prev;
  }
  return result;
}

// 标准差
function stdDev(values, period) {
  const result = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += values[i - j];
    const mean = sum / period;
    let sq = 0;
    for (let j = 0; j < period; j++) sq += (values[i - j] - mean) ** 2;
    result[i] = Math.sqrt(sq / period);
  }
  return result;
}

// BOLL(20, 2) 布林带
export function calcBOLL(bars, period = 20, mult = 2) {
  const closes = bars.map(b => b.last);
  const mid = sma(closes, period);
  const sd = stdDev(closes, period);
  const upper = mid.map((m, i) => (m == null || sd[i] == null) ? null : m + mult * sd[i]);
  const lower = mid.map((m, i) => (m == null || sd[i] == null) ? null : m - mult * sd[i]);
  return { mid, upper, lower };
}

// MACD(12, 26, 9)
export function calcMACD(bars, fast = 12, slow = 26, signal = 9) {
  const closes = bars.map(b => b.last);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) =>
    (emaFast[i] == null || emaSlow[i] == null) ? null : emaFast[i] - emaSlow[i]
  );
  // DEA: 从第一个非 null DIF 开始算 EMA
  const firstValid = dif.findIndex(d => d != null);
  const dea = new Array(dif.length).fill(null);
  if (firstValid >= 0) {
    const validDifs = dif.slice(firstValid);
    const deaValid = ema(validDifs, signal);
    for (let i = 0; i < deaValid.length; i++) {
      dea[firstValid + i] = deaValid[i];
    }
  }
  const macd = dif.map((d, i) =>
    (d == null || dea[i] == null) ? null : (d - dea[i]) * 2
  );
  return { dif, dea, macd };
}

// KDJ(9, 3, 3)
export function calcKDJ(bars, n = 9, m1 = 3, m2 = 3) {
  const k = new Array(bars.length).fill(null);
  const d = new Array(bars.length).fill(null);
  const j = new Array(bars.length).fill(null);
  let prevK = 50, prevD = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) continue;
    let hn = -Infinity, ln = Infinity;
    for (let t = 0; t < n; t++) {
      const b = bars[i - t];
      if (b.high > hn) hn = b.high;
      if (b.low < ln) ln = b.low;
    }
    const rsv = hn === ln ? 50 : (bars[i].last - ln) / (hn - ln) * 100;
    const curK = (prevK * (m1 - 1) + rsv) / m1;
    const curD = (prevD * (m2 - 1) + curK) / m2;
    const curJ = 3 * curK - 2 * curD;
    k[i] = curK; d[i] = curD; j[i] = curJ;
    prevK = curK; prevD = curD;
  }
  return { k, d, j };
}
