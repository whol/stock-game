// js/chart.js
// 纯 canvas K 线图 + 技术指标 + 画线工具（无外部依赖）
// A 股惯例：涨红跌绿

import { findStock, getCurrentDate, getRecent } from './market.js';
import { calcBOLL, calcMACD, calcKDJ } from './indicators.js';

let canvas, ctx, volCanvas, volCtx, indCanvas, indCtx;
let currentCode = null;
let stateRef = null;
let bars = [];          // 当前显示的K线数据
let hoverIdx = -1;
let mainGeo = {};       // 主图几何
let indGeo = {};        // 指标副图几何

// 指标 & 画线状态
let indicator = 'none';  // 'none' | 'boll' | 'macd' | 'kdj'
let tool = 'browse';     // 'browse' | 'trendline' | 'hline'
let drawings = [];       // [{ type:'line'|'hline', date1, price1, date2, price2 }]
let drawingDraft = null; // 正在画的线 { date1, price1, date2, price2 } (date2/price2 跟随鼠标)
let mousePos = null;     // 当前鼠标在主图上的 { x, y, date, price }

let rafId = null;

const UP = '#ff4d4f';
const DOWN = '#26a69a';
const GRID = '#1e2a40';
const TICK = '#8b98a9';
const NEON = '#00f0ff';
const TEXT = '#e6edf3';
const BOLL_MID = '#ffcc00';
const BOLL_UP = 'rgba(0, 240, 255, 0.6)';
const BOLL_LOW = 'rgba(255, 0, 170, 0.6)';
const MACD_DIF = '#00f0ff';
const MACD_DEA = '#ffcc00';
const KDJ_K = '#00f0ff';
const KDJ_D = '#ffcc00';
const KDJ_J = '#ff00aa';

// 视图窗口：控制显示哪些K线（缩放/拖动）
let viewStart = 0;      // 起始索引（在 bars 中的位置）
let viewCount = 0;      // 显示根数（0 = 自动/全部）

export function setState(s) { stateRef = s; }

export function initChart() {
  canvas = document.getElementById('klineChart');
  volCanvas = document.getElementById('volumeChart');
  indCanvas = document.getElementById('indicatorChart');
  if (!canvas || !volCanvas) return false;
  ctx = canvas.getContext('2d');
  volCtx = volCanvas.getContext('2d');
  if (indCanvas) indCtx = indCanvas.getContext('2d');

  // 鼠标事件
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onDragStart);
  canvas.addEventListener('mouseup', onDragEnd);
  canvas.addEventListener('mouseleave', () => { onDragEnd(); onMouseLeave(); });
  canvas.addEventListener('dblclick', () => { resetView(); });

  // 触摸事件
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });

  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(canvas.parentElement);
  if (volCanvas) ro.observe(volCanvas.parentElement);
  if (indCanvas) ro.observe(indCanvas.parentElement);

  return true;
}

// 重置视图窗口到默认（显示最近全部）
export function resetView() {
  viewStart = 0;
  viewCount = 0;
  scheduleDraw();
}

// 获取当前显示窗口
function getViewRange() {
  if (!bars.length) return { start: 0, count: 0 };
  const rect = canvas.parentElement.getBoundingClientRect();
  const plotW = rect.width - 8 - 56;
  // 默认每根K线 6px 宽
  let count = viewCount > 0 ? viewCount : Math.min(bars.length, Math.floor(plotW / 6));
  count = Math.max(20, Math.min(count, bars.length));
  let start = viewStart;
  // 默认（用户未操作视图）：始终显示最新 K 线
  if (start === 0 && viewCount === 0) {
    start = Math.max(0, bars.length - count);
  }
  // 确保 start 合法
  if (start < 0) start = 0;
  if (start > bars.length - count) start = bars.length - count;
  return { start, count };
}

// 滚轮缩放
function onWheel(e) {
  if (!bars.length) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const { start, count } = getViewRange();
  const plotW = rect.width - 8 - 56;
  const cw = plotW / count;
  // 鼠标所在K线索引（相对于视图）
  const idxIn = Math.floor((mouseX - 8) / cw);
  if (idxIn < 0 || idxIn >= count) return;
  // 鼠标对应的 bars 绝对索引
  const absIdx = start + idxIn;

  // 缩放因子
  const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
  let newCount = Math.round(count * factor);
  newCount = Math.max(20, Math.min(newCount, bars.length));

  // 保持鼠标位置不动：新 start 使 absIdx 仍在 idxIn 位置
  let newStart = absIdx - Math.round(idxIn * (count / newCount) * (newCount / count));
  // 简化：保持鼠标绝对索引比例
  const ratio = idxIn / count;
  newStart = Math.round(absIdx - ratio * newCount);
  newStart = Math.max(0, Math.min(newStart, bars.length - newCount));

  viewStart = newStart;
  viewCount = newCount;
  scheduleDraw();
}

// 拖动平移
let dragging = false;
let dragStartX = 0;
let dragStartViewStart = 0;
let dragMoved = false;

function onDragStart(e) {
  if (tool !== 'browse' || !bars.length) return;
  // 只在主图区域内才开始拖动
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < 8 || x > rect.width - 56) return;
  dragging = true;
  dragMoved = false;
  dragStartX = e.clientX;
  dragStartViewStart = getViewRange().start;
  canvas.style.cursor = 'grabbing';
}

function onDragEnd() {
  if (dragging) {
    dragging = false;
    canvas.style.cursor = tool === 'browse' ? 'crosshair' : 'cell';
    // 如果发生了拖动，阻止 click 事件（避免误触发画线）
    if (dragMoved) {
      dragMoved = false;
      // 用一个标记，下次 click 时检查
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 50);
    }
  }
}

function scheduleDraw() {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => draw());
}

export function renderStock(code) {
  currentCode = code;
  const s = findStock(code);
  if (!s) return;
  const currentDate = getCurrentDate();
  bars = s.kline.filter(b => b.date <= currentDate);
  // 切换股票时重置视图
  viewStart = 0;
  viewCount = 0;
  applyStreakEffect(code);
  scheduleDraw();
}

export function setIndicator(type) {
  indicator = type;
  const wrap = document.getElementById('indicatorWrap');
  if (wrap) wrap.classList.toggle('hidden', type === 'none');
  scheduleDraw();
}

export function setTool(t) {
  tool = t;
  drawingDraft = null;
  if (t === 'clear') {
    drawings = [];
    tool = 'browse';
    scheduleDraw();
  }
  // 更新光标样式
  if (canvas) {
    canvas.style.cursor = (tool === 'browse') ? 'crosshair' : 'cell';
  }
}

export function clearDrawings() {
  drawings = [];
  drawingDraft = null;
  scheduleDraw();
}

function applyStreakEffect(code) {
  const wrap = document.getElementById('chartWrap');
  if (!wrap) return;
  const recent = getRecent(code, 3);
  if (recent.length < 3) {
    wrap.classList.remove('streak-up', 'streak-down');
    return;
  }
  const allUp = recent.every(b => b.pct > 0);
  const allDown = recent.every(b => b.pct < 0);
  wrap.classList.toggle('streak-up', allUp);
  wrap.classList.toggle('streak-down', allDown);
}

// ===== 绘制 =====
function draw() {
  if (!ctx || !bars.length) return;
  resizeCanvases();
  drawKline();
  drawVolume();
  if (indCtx && indicator !== 'none') drawIndicator();
}

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const resize = (c, c_ctx) => {
    if (!c) return;
    const rect = c.parentElement.getBoundingClientRect();
    if (rect.width === 0) return;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    c.style.width = rect.width + 'px';
    c.style.height = rect.height + 'px';
    c_ctx.setTransform(1, 0, 0, 1, 0, 0);
    c_ctx.scale(dpr, dpr);
  };
  resize(canvas, ctx);
  resize(volCanvas, volCtx);
  resize(indCanvas, indCtx);
}

// ----- 主 K 线图 -----
function drawKline() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const padL = 8, padR = 56, padT = 8, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  let minP = Infinity, maxP = -Infinity;
  for (const b of bars) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
  }

  // BOLL 叠加时扩展价格范围
  let bollData = null;
  if (indicator === 'boll') {
    bollData = calcBOLL(bars);
    for (let i = 0; i < bars.length; i++) {
      if (bollData.upper[i] != null && bollData.upper[i] > maxP) maxP = bollData.upper[i];
      if (bollData.lower[i] != null && bollData.lower[i] < minP) minP = bollData.lower[i];
    }
  }

  const padP = (maxP - minP) * 0.05 || 1;
  minP -= padP; maxP += padP;
  const rangeP = maxP - minP;

  // 使用视图窗口（缩放/拖动）
  const { start: vStart, count: vCount } = getViewRange();
  const showBars = bars.slice(vStart, vStart + vCount);
  const n = showBars.length;
  const cw = plotW / n;
  const bodyW = Math.max(2, Math.min(cw * 0.7, 10));

  const xOf = (i) => padL + i * cw + cw / 2;
  const yOf = (p) => padT + (1 - (p - minP) / rangeP) * plotH;
  // 反向：像素 -> 价格
  const priceOf = (y) => minP + (1 - (y - padT) / plotH) * rangeP;
  // 日期 -> 索引
  const idxOfDate = (date) => {
    for (let i = 0; i < n; i++) if (showBars[i].date === date) return i;
    return -1;
  };

  mainGeo = { padL, padR, padT, padB, plotW, plotH, minP, maxP, xOf, yOf, priceOf, idxOfDate, n, showBars, W, H };

  // 网格 + Y 轴
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = TICK;
  ctx.font = '11px Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const p = minP + (rangeP * i) / ySteps;
    const y = yOf(p);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(p.toFixed(2), padL + plotW + 4, y);
  }

  // X 轴日期
  const xSteps = Math.min(6, n);
  ctx.textAlign = 'center';
  for (let i = 0; i < xSteps; i++) {
    const idx = Math.floor((n - 1) * i / Math.max(1, xSteps - 1));
    ctx.fillText(showBars[idx].date.slice(5), xOf(idx), H - padB / 2);
  }

  // BOLL 叠加
  if (bollData) {
    if (bars.length >= 20) {
      drawBOLL(bollData, showBars, xOf, yOf, n, vStart);
      // 当前日 BOLL 数值显示在主图左上角
      const curIdx = bars.length - 1;
      const cMid = bollData.mid[curIdx], cUp = bollData.upper[curIdx], cLow = bollData.lower[curIdx];
      if (cMid != null) {
        ctx.fillStyle = TICK;
        ctx.font = '11px Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const valText = `BOLL(20,2)  MID=${cMid.toFixed(2)}  UP=${cUp.toFixed(2)}  LOW=${cLow.toFixed(2)}`;
        ctx.fillText(valText, mainGeo.padL + 4, mainGeo.padT + 4);
      }
    } else {
      // 预热期提示
      ctx.fillStyle = TICK;
      ctx.font = '11px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        `BOLL 预热中，还需 ${20 - bars.length} 天`,
        mainGeo.padL + 4, mainGeo.padT + 4
      );
    }
  }

  // K 线
  for (let i = 0; i < n; i++) {
    const b = showBars[i];
    const up = b.last >= b.open;
    const color = up ? UP : DOWN;
    const x = xOf(i);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(b.high));
    ctx.lineTo(x, yOf(b.low));
    ctx.stroke();
    const yO = yOf(b.open), yC = yOf(b.last);
    const top = Math.min(yO, yC);
    const h = Math.max(1, Math.abs(yC - yO));
    ctx.fillStyle = color;
    ctx.fillRect(x - bodyW / 2, top, bodyW, h);
  }

  // 画线（用户绘制）
  drawUserLines(xOf, yOf, idxOfDate);

  // 当前日竖线
  const currentDate = getCurrentDate();
  const curIdx = idxOfDate(currentDate);
  if (curIdx >= 0) {
    const x = xOf(curIdx);
    ctx.strokeStyle = NEON;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 买卖点标记
  if (stateRef && currentCode) {
    const trades = stateRef.trades.filter(t => t.code === currentCode);
    for (const t of trades) {
      const ti = idxOfDate(t.date);
      if (ti === -1) continue;
      const x = xOf(ti);
      const y = yOf(t.price);
      ctx.fillStyle = t.type === 'buy' ? UP : DOWN;
      ctx.beginPath();
      if (t.type === 'buy') {
        ctx.moveTo(x, y - 12);
        ctx.lineTo(x - 5, y - 2);
        ctx.lineTo(x + 5, y - 2);
      } else {
        ctx.moveTo(x, y + 12);
        ctx.lineTo(x - 5, y + 2);
        ctx.lineTo(x + 5, y + 2);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  // 十字光标 + tooltip
  if (hoverIdx >= 0 && hoverIdx < n && tool === 'browse') {
    drawCrosshair(hoverIdx, showBars, xOf, yOf, padL, padT, plotW, plotH, W);
  }

  // 画线模式下的鼠标价格标签
  if (mousePos && tool !== 'browse') {
    ctx.fillStyle = NEON;
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(mousePos.price.toFixed(2), padL + plotW + 4, mousePos.y);
  }
}

function drawBOLL(bollData, showBars, xOf, yOf, n, vStart) {
  const drawLine = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = arr[vStart + i];
      if (v == null) { started = false; continue; }
      const x = xOf(i), y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  drawLine(bollData.mid, BOLL_MID);
  drawLine(bollData.upper, BOLL_UP);
  drawLine(bollData.lower, BOLL_LOW);
}

// ----- 用户画线 -----
function drawUserLines(xOf, yOf, idxOfDate) {
  const drawOne = (d) => {
    const i1 = idxOfDate(d.date1);
    if (i1 === -1) return;
    const x1 = xOf(i1), y1 = yOf(d.price1);
    ctx.strokeStyle = NEON;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (d.type === 'hline') {
      // 水平线横跨整个图
      ctx.moveTo(mainGeo.padL, y1);
      ctx.lineTo(mainGeo.padL + mainGeo.plotW, y1);
    } else {
      // 趋势线
      const i2 = idxOfDate(d.date2);
      const x2 = i2 === -1 ? (d.x2 || mainGeo.padL + mainGeo.plotW) : xOf(i2);
      const y2 = d.price2 != null ? yOf(d.price2) : (d.y2 || y1);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  };

  // 已完成的画线
  for (const d of drawings) drawOne(d);
  // 正在画的预览线
  if (drawingDraft) {
    ctx.setLineDash([4, 3]);
    drawOne(drawingDraft);
    ctx.setLineDash([]);
  }
}

function drawCrosshair(idx, showBars, xOf, yOf, padL, padT, plotW, plotH, W) {
  const b = showBars[idx];
  const x = xOf(idx);
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x, padT);
  ctx.lineTo(x, padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // tooltip
  const lines = [
    b.date,
    `开 ${b.open.toFixed(2)}  收 ${b.last.toFixed(2)}`,
    `高 ${b.high.toFixed(2)}  低 ${b.low.toFixed(2)}`,
    `涨跌 ${(b.pct >= 0 ? '+' : '') + b.pct.toFixed(2)}%`
  ];
  ctx.font = '12px Consolas, monospace';
  const tw = 170, th = lines.length * 16 + 8;
  let tx = x + 8;
  if (tx + tw > W - mainGeo.padR) tx = x - 8 - tw;
  const ty = padT + 4;
  ctx.fillStyle = 'rgba(13, 20, 33, 0.95)';
  ctx.strokeStyle = NEON;
  ctx.lineWidth = 1;
  ctx.fillRect(tx, ty, tw, th);
  ctx.strokeRect(tx, ty, tw, th);
  ctx.fillStyle = NEON;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(lines[0], tx + 6, ty + 4);
  ctx.fillStyle = TEXT;
  for (let i = 1; i < lines.length; i++) ctx.fillText(lines[i], tx + 6, ty + 4 + i * 16);
}

// ----- 成交量 -----
function drawVolume() {
  if (!volCtx) return;
  const rect = volCanvas.parentElement.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  volCtx.clearRect(0, 0, W, H);
  if (!bars.length) return;

  const padL = 8, padR = 56, padT = 4, padB = 4;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  // 与主图同步视图窗口
  const { start: vStart, count: vCount } = getViewRange();
  const showBars = bars.slice(vStart, vStart + vCount);
  const n = showBars.length;
  const cw = plotW / n;
  const bodyW = Math.max(2, Math.min(cw * 0.7, 10));

  let maxV = 0;
  for (const b of showBars) if (b.volume > maxV) maxV = b.volume;
  const xOf = (i) => padL + i * cw + cw / 2;
  const yOf = (v) => padT + (1 - v / (maxV || 1)) * plotH;

  volCtx.strokeStyle = GRID;
  volCtx.lineWidth = 1;
  volCtx.beginPath();
  volCtx.moveTo(padL, padT + plotH);
  volCtx.lineTo(padL + plotW, padT + plotH);
  volCtx.stroke();

  volCtx.fillStyle = TICK;
  volCtx.font = '10px Consolas, monospace';
  volCtx.textAlign = 'left';
  volCtx.textBaseline = 'top';
  volCtx.fillText(maxV >= 10000 ? (maxV / 10000).toFixed(0) + '万' : maxV.toString(), padL + plotW + 4, padT);

  for (let i = 0; i < n; i++) {
    const b = showBars[i];
    const up = b.last >= b.open;
    volCtx.fillStyle = up ? 'rgba(255, 77, 79, 0.5)' : 'rgba(38, 166, 154, 0.5)';
    const x = xOf(i);
    const y = yOf(b.volume);
    volCtx.fillRect(x - bodyW / 2, y, bodyW, padT + plotH - y);
  }
}

// ----- 指标副图 -----
// 各指标预热期（需要多少个交易日才有第一个有效值）
const WARMUP = { macd: 35, kdj: 9, boll: 20 };

function drawIndicator() {
  if (!indCtx || indicator === 'none') return;
  const rect = indCanvas.parentElement.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  indCtx.clearRect(0, 0, W, H);
  if (!bars.length) return;

  const padL = 8, padR = 56, padT = 16, padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  // 与主图同步视图窗口
  const { start: vStart, count: vCount } = getViewRange();
  const showBars = bars.slice(vStart, vStart + vCount);
  const offset = vStart;
  const n = showBars.length;
  const cw = plotW / n;
  const xOf = (i) => padL + i * cw + cw / 2;

  // 标题 + 当前日指标数值
  indCtx.fillStyle = TICK;
  indCtx.font = '11px Consolas, monospace';
  indCtx.textAlign = 'left';
  indCtx.textBaseline = 'top';
  const title = indicator === 'macd' ? 'MACD(12,26,9)' : indicator === 'kdj' ? 'KDJ(9,3,3)' : '';
  indCtx.fillText(title, padL, 2);

  // 当前日在 bars 中的索引（bars 已过滤到 currentDate，最后一个就是当前日）
  const curIdx = bars.length - 1;

  // 预热期检查：数据不足时显示提示
  const needed = WARMUP[indicator] || 0;
  if (bars.length < needed) {
    indCtx.fillStyle = TEXT;
    indCtx.font = '12px Consolas, monospace';
    indCtx.textAlign = 'center';
    indCtx.textBaseline = 'middle';
    indCtx.fillText(
      `${title} 数据预热中，还需 ${needed - bars.length} 个交易日`,
      W / 2, H / 2
    );
    return;
  }

  if (indicator === 'macd') {
    const { dif, dea, macd } = calcMACD(bars);
    // 当前日指标数值显示在标题右侧
    const cDif = dif[curIdx], cDea = dea[curIdx], cMacd = macd[curIdx];
    if (cDif != null) {
      indCtx.textAlign = 'left';
      indCtx.font = '11px Consolas, monospace';
      const valText = `  DIF=${cDif.toFixed(3)}  DEA=${cDea != null ? cDea.toFixed(3) : '-'}  MACD=${cMacd != null ? cMacd.toFixed(3) : '-'}`;
      indCtx.fillStyle = MACD_DIF;
      indCtx.fillText(valText, padL + 110, 2);
    }
    let minV = Infinity, maxV = -Infinity;
    for (let i = offset; i < bars.length; i++) {
      if (dif[i] != null) { if (dif[i] < minV) minV = dif[i]; if (dif[i] > maxV) maxV = dif[i]; }
      if (dea[i] != null) { if (dea[i] < minV) minV = dea[i]; if (dea[i] > maxV) maxV = dea[i]; }
      if (macd[i] != null) { if (macd[i] < minV) minV = macd[i]; if (macd[i] > maxV) maxV = macd[i]; }
    }
    const pad = (maxV - minV) * 0.1 || 1;
    minV -= pad; maxV += pad;
    const range = maxV - minV || 1;
    const yOf = (v) => padT + (1 - (v - minV) / range) * plotH;
    const zeroY = yOf(0);

    // 零线
    indCtx.strokeStyle = GRID;
    indCtx.lineWidth = 1;
    indCtx.beginPath();
    indCtx.moveTo(padL, zeroY);
    indCtx.lineTo(padL + plotW, zeroY);
    indCtx.stroke();

    // MACD 柱
    for (let i = 0; i < n; i++) {
      const v = macd[offset + i];
      if (v == null) continue;
      const x = xOf(i);
      const y = yOf(v);
      indCtx.fillStyle = v >= 0 ? 'rgba(255, 77, 79, 0.6)' : 'rgba(38, 166, 154, 0.6)';
      const h = Math.abs(y - zeroY);
      indCtx.fillRect(x - 1.5, Math.min(y, zeroY), 3, h);
    }

    // DIF / DEA 线
    drawIndLine(dif, offset, n, xOf, yOf, MACD_DIF);
    drawIndLine(dea, offset, n, xOf, yOf, MACD_DEA);

    // Y 轴
    indCtx.fillStyle = TICK;
    indCtx.font = '10px Consolas, monospace';
    indCtx.textAlign = 'left';
    indCtx.textBaseline = 'middle';
    indCtx.fillText(maxV.toFixed(3), padL + plotW + 4, padT);
    indCtx.fillText(minV.toFixed(3), padL + plotW + 4, padT + plotH);

  } else if (indicator === 'kdj') {
    const { k, d, j } = calcKDJ(bars);
    // 当前日指标数值
    const cK = k[curIdx], cD = d[curIdx], cJ = j[curIdx];
    if (cK != null) {
      indCtx.textAlign = 'left';
      indCtx.font = '11px Consolas, monospace';
      const valText = `  K=${cK.toFixed(2)}  D=${cD != null ? cD.toFixed(2) : '-'}  J=${cJ != null ? cJ.toFixed(2) : '-'}`;
      indCtx.fillStyle = KDJ_K;
      indCtx.fillText(valText, padL + 80, 2);
    }
    let minV = Infinity, maxV = -Infinity;
    for (let i = offset; i < bars.length; i++) {
      if (k[i] != null) { if (k[i] < minV) minV = k[i]; if (k[i] > maxV) maxV = k[i]; }
      if (d[i] != null) { if (d[i] < minV) minV = d[i]; if (d[i] > maxV) maxV = d[i]; }
      if (j[i] != null) { if (j[i] < minV) minV = j[i]; if (j[i] > maxV) maxV = j[i]; }
    }
    minV = Math.min(minV, 0); maxV = Math.max(maxV, 100);
    const range = maxV - minV || 100;
    const yOf = (v) => padT + (1 - (v - minV) / range) * plotH;

    // 20/50/80 参考线
    indCtx.strokeStyle = GRID;
    indCtx.lineWidth = 1;
    indCtx.setLineDash([2, 3]);
    for (const lv of [20, 50, 80]) {
      const y = yOf(lv);
      indCtx.beginPath();
      indCtx.moveTo(padL, y);
      indCtx.lineTo(padL + plotW, y);
      indCtx.stroke();
    }
    indCtx.setLineDash([]);

    drawIndLine(k, offset, n, xOf, yOf, KDJ_K);
    drawIndLine(d, offset, n, xOf, yOf, KDJ_D);
    drawIndLine(j, offset, n, xOf, yOf, KDJ_J);

    indCtx.fillStyle = TICK;
    indCtx.font = '10px Consolas, monospace';
    indCtx.textAlign = 'left';
    indCtx.textBaseline = 'middle';
    indCtx.fillText('100', padL + plotW + 4, padT);
    indCtx.fillText('0', padL + plotW + 4, padT + plotH);
  }

  // X 轴日期
  indCtx.fillStyle = TICK;
  indCtx.font = '10px Consolas, monospace';
  indCtx.textAlign = 'center';
  indCtx.textBaseline = 'bottom';
  const xSteps = Math.min(6, n);
  for (let i = 0; i < xSteps; i++) {
    const idx = Math.floor((n - 1) * i / Math.max(1, xSteps - 1));
    indCtx.fillText(showBars[idx].date.slice(5), xOf(idx), H - 2);
  }
}

function drawIndLine(arr, offset, n, xOf, yOf, color) {
  indCtx.strokeStyle = color;
  indCtx.lineWidth = 1.2;
  indCtx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = arr[offset + i];
    if (v == null) { started = false; continue; }
    const x = xOf(i), y = yOf(v);
    if (!started) { indCtx.moveTo(x, y); started = true; }
    else indCtx.lineTo(x, y);
  }
  indCtx.stroke();
}

// ===== 鼠标交互 =====
let justDragged = false;

function onMouseMove(e) {
  if (!mainGeo.xOf || !bars.length) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { padL, plotW, n, priceOf, showBars } = mainGeo;
  const cw = plotW / n;
  const idx = Math.floor((x - padL) / cw);
  mousePos = { x, y, price: priceOf(y) };

  // 拖动平移
  if (dragging) {
    const dx = e.clientX - dragStartX;
    if (Math.abs(dx) > 3) dragMoved = true;
    const moveBars = Math.round(dx / cw);
    let newStart = dragStartViewStart - moveBars;
    newStart = Math.max(0, Math.min(newStart, bars.length - getViewRange().count));
    if (newStart !== viewStart) {
      viewStart = newStart;
      scheduleDraw();
    }
    return;
  }

  if (idx >= 0 && idx < n) {
    mousePos.date = showBars[idx].date;
    if (tool === 'browse') {
      if (idx !== hoverIdx) { hoverIdx = idx; scheduleDraw(); }
    } else {
      // 画线模式：更新预览
      if (drawingDraft) {
        drawingDraft.date2 = showBars[idx].date;
        drawingDraft.price2 = mousePos.price;
      }
      scheduleDraw();
    }
  }
}

function onMouseLeave() {
  hoverIdx = -1;
  mousePos = null;
  if (!dragging) drawingDraft = null;
  scheduleDraw();
}

function onClick(e) {
  // 拖动刚结束，忽略这次 click
  if (justDragged) { justDragged = false; return; }
  if (!mousePos || !mainGeo.showBars) return;
  if (tool === 'browse') return; // 浏览模式不响应点击画线
  const { showBars, n } = mainGeo;
  const cw = mainGeo.plotW / n;
  const idx = Math.floor((mousePos.x - mainGeo.padL) / cw);
  if (idx < 0 || idx >= n) return;
  const date = showBars[idx].date;
  const price = mousePos.price;

  if (tool === 'trendline') {
    if (!drawingDraft) {
      drawingDraft = { type: 'line', date1: date, price1: price, date2: date, price2: price };
    } else {
      drawingDraft.date2 = date;
      drawingDraft.price2 = price;
      drawings.push({ ...drawingDraft });
      drawingDraft = null;
      // 保持工具激活，可连续画多条
    }
    scheduleDraw();
  } else if (tool === 'hline') {
    drawings.push({ type: 'hline', date1: date, price1: price, date2: date, price2: price });
    // 保持工具激活，可连续画多条
    scheduleDraw();
  }
}

// ===== 触摸交互 =====
let touchState = null;  // { startX, startY, startViewStart, startViewCount, mode: 'pan'|'pinch', dist }
let lastTapTime = 0;

function getTouchPos(touch) {
  const rect = canvas.getBoundingClientRect();
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

function getTouchDist(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function onTouchStart(e) {
  if (!bars.length || !mainGeo.xOf) return;
  e.preventDefault();

  if (e.touches.length === 1) {
    const pos = getTouchPos(e.touches[0]);
    const { padL, plotW, n, priceOf, showBars } = mainGeo;
    const cw = plotW / n;
    const idx = Math.floor((pos.x - padL) / cw);
    mousePos = { x: pos.x, y: pos.y, price: priceOf(pos.y) };

    // 单指：拖动 or 点击
    touchState = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      startViewStart: getViewRange().start,
      mode: 'pan',
      moved: false
    };

    // 十字光标
    if (idx >= 0 && idx < n) {
      mousePos.date = showBars[idx].date;
      hoverIdx = idx;
      scheduleDraw();
    }

    // 双击检测（双指单机）
    const now = Date.now();
    if (now - lastTapTime < 300) {
      resetView();
    }
    lastTapTime = now;

  } else if (e.touches.length === 2) {
    // 双指缩放
    touchState = {
      mode: 'pinch',
      startDist: getTouchDist(e.touches[0], e.touches[1]),
      startViewCount: getViewRange().count,
      startViewStart: getViewRange().start
    };
  }
}

function onTouchMove(e) {
  if (!touchState || !bars.length) return;
  e.preventDefault();

  if (touchState.mode === 'pan' && e.touches.length === 1) {
    const dx = e.touches[0].clientX - touchState.startX;
    if (Math.abs(dx) > 5) {
      touchState.moved = true;
      const { plotW, n } = mainGeo;
      const cw = plotW / n;
      const moveBars = Math.round(dx / cw);
      let newStart = touchState.startViewStart - moveBars;
      newStart = Math.max(0, Math.min(newStart, bars.length - getViewRange().count));
      if (newStart !== viewStart) {
        viewStart = newStart;
        scheduleDraw();
      }
    }

    // 更新十字光标
    const pos = getTouchPos(e.touches[0]);
    const { padL, plotW, n, priceOf, showBars } = mainGeo;
    const cw = plotW / n;
    const idx = Math.floor((pos.x - padL) / cw);
    mousePos = { x: pos.x, y: pos.y, price: priceOf(pos.y) };
    if (idx >= 0 && idx < n) {
      mousePos.date = showBars[idx].date;
      hoverIdx = idx;
    }
    scheduleDraw();

  } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
    const dist = getTouchDist(e.touches[0], e.touches[1]);
    const factor = touchState.startDist / dist;
    let newCount = Math.round(touchState.startViewCount * factor);
    newCount = Math.max(20, Math.min(newCount, bars.length));
    viewCount = newCount;
    // 保持中心不变
    const centerIdx = touchState.startViewStart + Math.floor(touchState.startViewCount / 2);
    let newStart = centerIdx - Math.floor(newCount / 2);
    newStart = Math.max(0, Math.min(newStart, bars.length - newCount));
    viewStart = newStart;
    scheduleDraw();
  }
}

function onTouchEnd(e) {
  if (!touchState) return;

  if (touchState.mode === 'pan' && !touchState.moved) {
    // 没有拖动 → 当作点击
    if (mousePos && mainGeo.showBars && tool !== 'browse') {
      const { showBars, n } = mainGeo;
      const cw = mainGeo.plotW / n;
      const idx = Math.floor((mousePos.x - mainGeo.padL) / cw);
      if (idx >= 0 && idx < n) {
        const date = showBars[idx].date;
        const price = mousePos.price;
        if (tool === 'trendline') {
          if (!drawingDraft) {
            drawingDraft = { type: 'line', date1: date, price1: price, date2: date, price2: price };
          } else {
            drawingDraft.date2 = date;
            drawingDraft.price2 = price;
            drawings.push({ ...drawingDraft });
            drawingDraft = null;
          }
          scheduleDraw();
        } else if (tool === 'hline') {
          drawings.push({ type: 'hline', date1: date, price1: price, date2: date, price2: price });
          scheduleDraw();
        }
      }
    }
  }

  touchState = null;
  // 触摸结束后保留十字光标 2 秒
  setTimeout(() => {
    if (!touchState) {
      hoverIdx = -1;
      mousePos = null;
      scheduleDraw();
    }
  }, 2000);
}

function updateToolButtons() {
  document.querySelectorAll('[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  if (canvas) canvas.style.cursor = tool === 'browse' ? 'grab' : 'cell';
}

// 双击重置视图
export function bindDblClick() {
  if (canvas) {
    canvas.addEventListener('dblclick', () => {
      resetView();
    });
  }
}

export function getCurrentCode() { return currentCode; }
export function getDrawings() { return drawings; }
export function setDrawings(d) { drawings = d || []; }
