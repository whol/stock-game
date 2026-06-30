// scripts/build-stocks.js
// 用法: node scripts/build-stocks.js
// 读 data/raw/<code>.json + scripts/stock-list.json -> 排序/补涨跌幅/补exchange -> data/stocks.json
// 零依赖，仅用 Node 内置模块。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'stock-list.json'), 'utf8'));

const stocks = list.map(s => {
  const rawPath = path.join(RAW_DIR, `${s.code}.json`);
  if (!fs.existsSync(rawPath)) {
    console.error(`✗ 缺少 ${rawPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

  // raw 可能是数组，也可能是 { sections: [...] }，统一拍平成数组
  let rows;
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (raw && Array.isArray(raw.sections)) {
    // sections 结构：[{ name, data: [...] }]
    rows = raw.sections.flatMap(sec => sec.data || []);
  } else if (raw && Array.isArray(raw.data)) {
    rows = raw.data;
  } else {
    rows = [];
  }

  // 注意：westock-data 返回的字段里 "exchange" 实际存的是换手率（如 "0.24"），
  // 真正的交易所由代码前缀推断，这里不信任该字段，统一用 market 覆盖。
  const kline = rows
    .map(r => ({
      date: r.date,
      open: +r.open,
      last: +r.last,        // 收盘价（字段名是 last，不是 close）
      high: +r.high,
      low: +r.low,
      volume: +r.volume,
      amount: +r.amount,
      exchange: s.market    // 用清单里的市场代码，忽略原始 exchange 字段
    }))
    .filter(r => r.date && r.last > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 补涨跌幅 pct（相对前一日收盘，首日 0）
  kline.forEach((b, i) => {
    if (i === 0) {
      b.pct = 0;
    } else {
      const prev = kline[i - 1].last;
      b.pct = +(((b.last - prev) / prev) * 100).toFixed(2);
    }
  });

  return { ...s, kline };
});

// 全局日期范围：取所有股票 kline 的并集 [min, max]
const allDates = stocks.flatMap(s => s.kline.map(b => b.date)).sort();
const range = {
  start: allDates[0],
  end: allDates[allDates.length - 1]
};

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  range,
  stocks
};

const outPath = path.join(ROOT, 'data', 'stocks.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`✓ 生成 data/stocks.json`);
console.log(`  股票数: ${stocks.length}`);
console.log(`  交易日: ${allDates.length}（${range.start} ~ ${range.end}）`);
stocks.forEach(s => {
  console.log(`  - ${s.code} ${s.name}: ${s.kline.length} 根K线`);
});
