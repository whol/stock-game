// js/importer.js
// 添加新股票：在线直连腾讯接口优先 + 粘贴 JSON 兜底

import { addCustomStock } from './market.js';
import { toast } from './ui.js';

let stateRef = null;
let saveFn = null;
let onImportedCb = null;

export function setState(s, save, onImported) {
  stateRef = s;
  saveFn = save;
  onImportedCb = onImported;
}

// ===== 在线直连腾讯接口（Tab A） =====
// 接口：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,day,<start>,<end>,640,qfq
// 返回：data.<code>.qfqday = [[date, open, last, high, low, volume, amount], ...]
// 或 data.<code>.day（不复权）
export async function fetchOnline(code, name) {
  code = code.trim().toLowerCase();
  if (!code) return { ok: false, msg: '请输入股票代码' };
  if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
    return { ok: false, msg: '代码格式应为 sh600519 / sz000001 / bj430047' };
  }

  const start = stateRef.startDate;
  const end = stateRef.endDate;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${start},${end},640,qfq`;

  let resp;
  try {
    resp = await fetch(url, { mode: 'cors' });
  } catch (e) {
    return { ok: false, msg: '网络或 CORS 失败，请改用粘贴模式', fallback: true };
  }
  if (!resp.ok) return { ok: false, msg: `HTTP ${resp.status}，请改用粘贴模式`, fallback: true };

  let json;
  try { json = await resp.json(); } catch { return { ok: false, msg: '返回数据解析失败', fallback: true }; }

  const rows = json?.data?.[code]?.qfqday || json?.data?.[code]?.day || [];
  if (!rows.length) return { ok: false, msg: '返回数据为空，请改用粘贴模式', fallback: true };

  // 腾讯格式转统一结构
  const kline = rows.map(r => ({
    date: r[0], open: +r[1], last: +r[2], high: +r[3], low: +r[4],
    volume: +r[5], amount: +r[6],
    exchange: marketOf(code)
  })).filter(r => r.date && r.last > 0).sort((a, b) => a.date < b.date ? -1 : 1);

  if (!name || !name.trim()) name = code.toUpperCase();
  return mergeStock(code, name, kline);
}

// ===== 粘贴模式（Tab B 兜底） =====
export function importPasted(jsonText, code, name) {
  code = (code || '').trim().toLowerCase();
  if (!code) return { ok: false, msg: '请输入股票代码' };
  if (!name || !name.trim()) name = code.toUpperCase();

  let rows;
  try { rows = JSON.parse(jsonText); } catch {
    return { ok: false, msg: 'JSON 格式错误' };
  }

  let kline;
  if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
    // westock-data 格式：[{date, open, last, high, low, volume, amount, exchange?}, ...]
    kline = rows.map(r => ({
      date: r.date, open: +r.open, last: +r.last, high: +r.high, low: +r.low,
      volume: +r.volume, amount: +r.amount,
      exchange: r.exchange || marketOf(code)
    }));
  } else if (Array.isArray(rows) && rows.length && Array.isArray(rows[0])) {
    // 腾讯格式：[[date, o, c, h, l, v, a], ...]
    kline = rows.map(r => ({
      date: r[0], open: +r[1], last: +r[2], high: +r[3], low: +r[4],
      volume: +r[5], amount: +r[6], exchange: marketOf(code)
    }));
  } else {
    return { ok: false, msg: '无法识别的数据格式' };
  }

  kline = kline.filter(r => r.date && r.last > 0).sort((a, b) => a.date < b.date ? -1 : 1);
  return mergeStock(code, name, kline);
}

// ===== 合并入库（两模式共用） =====
function mergeStock(code, name, kline) {
  if (kline.length < 30) return { ok: false, msg: '数据不足 30 条，无法导入' };

  const overlap = kline.some(b => b.date >= stateRef.startDate && b.date <= stateRef.endDate);
  if (!overlap) return { ok: false, msg: '数据日期与游戏区间无重叠' };

  // 补涨跌幅 pct
  kline.forEach((b, i) => {
    if (i === 0) b.pct = 0;
    else {
      const prev = kline[i - 1].last;
      b.pct = +(((b.last - prev) / prev) * 100).toFixed(2);
    }
  });

  const stock = {
    code, name,
    market: marketOf(code),
    sector: '自定义',
    story: '用户导入',
    kline
  };

  addCustomStock(stock);
  if (!stateRef.unlockedStocks.includes(code)) stateRef.unlockedStocks.push(code);
  stateRef.customStocks = stateRef.customStocks.filter(s => s.code !== code);
  stateRef.customStocks.push(stock);
  saveFn && saveFn(stateRef);

  return { ok: true, stock };
}

function marketOf(code) {
  if (code.startsWith('sh')) return 'SH';
  if (code.startsWith('sz')) return 'SZ';
  if (code.startsWith('bj')) return 'BJ';
  return 'CN';
}

// 触发导入成功后的回调（刷新股票列表 + 选中）
export function notifyImported(stock) {
  toast(`✓ 已导入 ${stock.name} (${stock.code})`, 'success');
  onImportedCb && onImportedCb(stock.code);
}
