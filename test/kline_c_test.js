// kline_c_test.js —— C 我的单子当题：三态验收（node test/kline_c_test.js）
// 覆盖：分钟命中 / 没这笔成交 / 缺分钟数据空态 / 口径标注 / 不混口径 / 红线
'use strict';
const zlib = require('zlib');
const R = require('../public/features/replay');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

const SAMPLE_TRADE = {
  code: 'KX0001', name: '合成样本丁', date: '0001-01-01', time: '10:00:00',
  side: 'buy', qty: 100,
  price: +R.SAMPLE.raw.filter((x) => x.indexOf('000101011000,') === 0)[0].split(',')[4],
};

// 2024-01-02 的 48 根 5 分钟 K，价格 10 附近
function packBars() {
  const out = [];
  const times = [];
  for (let m = 575; m <= 690; m += 5) times.push([Math.floor(m / 60), m % 60]);
  for (let m = 785; m <= 900; m += 5) times.push([Math.floor(m / 60), m % 60]);
  times.forEach(([h, mi], i) => {
    const base = 10 + i * 0.001;
    const o = base, c = base + (i % 2 ? 0.002 : -0.002);
    out.push([
      '20240102' + String(h).padStart(2, '0') + String(mi).padStart(2, '0'),
      o.toFixed(3), (Math.max(o, c) + 0.002).toFixed(3),
      (Math.min(o, c) - 0.002).toFixed(3), c.toFixed(3), String(1000 + i),
    ].join(','));
  });
  return out;
}

const PACK_BARS = packBars();
const PACK_OBJ = {
  schema: 'panji.klines.v1', symbol: 'sz000001', name: '平安银行',
  month: '2024-01', timeframe: '5m', adjust: 'none', bars: PACK_BARS,
};

// 假 fetch：兜底 404；命中返回 gzip 包；带 indexObj 时 index.json 返回 JSON
function fetchWith(obj, indexObj) {
  return async function (url) {
    // 顶层索引已改走 /api/kline/index（原先直取 index.json），两种路径都要命中
    if (indexObj && String(url).indexOf('pack') === -1 && String(url).indexOf('index') !== -1) {
      return { ok: true, status: 200, text: async () => JSON.stringify(indexObj) };
    }
    if (!obj) return { ok: false, status: 404 };
    const buf = zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  };
}

const TRADE_2024 = {
  code: 'sz000001', name: '平安银行', date: '2024-01-02', time: '10:00:00',
  side: 'buy', qty: 100, price: 10.0,
};

(async function main() {
  console.log('[1] 口径标注：只标 5 分钟，不复权/前复权分得清');
  ok(R.levelText('none') === '5 分钟级 · 不复权', '分钟包标不复权');
  ok(R.levelText('qfq') === '5 分钟级 · 前复权', '内置样本标前复权');
  ok(!/日线/.test(R.levelText('none') + R.levelText('qfq')), '不再出现日线级口径');

  console.log('[2] 命中分钟包：分钟级回放');
  const hit = await R.loadTradeReplay('sz000001', '20240102', {
    trades: [TRADE_2024], fetch: fetchWith(PACK_OBJ),
  });
  ok(hit.status === 'ok', '状态 ok');
  ok(hit.level === '5m' && hit.replay.timeframe === '5m', 'level=5m 且 timeframe=5m');
  ok(hit.replay.adjust === 'none', '复权口径 = 不复权');
  ok(hit.replay.klines.every((b) => String(b.t).slice(0, 8) === '20240102'), '只保留当天 K 线，不混别的日子');
  ok(hit.replay.checkpoints.length === 1 && hit.replay.checkpoints[0].at === '202401021000', '成交点定位正确');
  ok(hit.replay.checkpoints[0].visibleUntil <= hit.replay.checkpoints[0].at, '可见截止不越过成交时刻');

  console.log('[3] 内置演示样本命中：合成走势');
  const sample = await R.loadTradeReplay('KX0001', '00010101', { trades: [SAMPLE_TRADE] });
  ok(sample.status === 'ok' && sample.level === '5m', '样本命中且为分钟级');
  ok(sample.replay.adjust === 'synthetic', '样本标注 synthetic（合成走势）');
  ok(sample.replay.symbol === 'KX0001', '虚构代码原样匹配演示样本');

  console.log('[4] 没有这笔成交：明确状态，不瞎画');
  const none = await R.loadTradeReplay('sz000001', '20240102', {
    trades: [], fetch: fetchWith(PACK_OBJ),
  });
  ok(none.status === 'no-trades', '无成交返回 no-trades');
  ok(!none.replay && !none.klines, '不返回任何 K 线');

  console.log('[5] 缺分钟数据：诚实空态 + 指出缺哪个月');
  const miss = await R.loadTradeReplay('sz000722', '20261019', {
    trades: [{ code: 'sz000722', name: '示例环保', date: '2026-10-19', time: '10:00:00', side: 'buy', qty: 100, price: 13.0 }],
    fetch: fetchWith(null),
  });
  ok(miss.status === 'empty', '未命中返回 empty');
  ok(!miss.replay, '不塞日线、不画近似走势');
  ok(miss.detail.month === '2026-10', '指出缺 2026-10 的分钟数据');
  ok(Array.isArray(miss.detail.coveredMonths) && miss.detail.coveredMonths.length === 2,
    '索引不可读时回退到内置覆盖常量');
  ok(miss.detail.monthCovered === false, '明确指出该月未覆盖');

  console.log('[5b] 顶层索引可读：覆盖范围来自 index.json');
  const INDEX_OBJ = {
    schema: 'panji.kline.index.v1',
    months: { '2026-01': { stocks: 5165 }, '2026-09': { stocks: 5571 } },
  };
  const miss2 = await R.loadTradeReplay('sz000722', '20261019', {
    trades: [{ code: 'sz000722', name: '示例环保', date: '2026-10-19', time: '10:00:00', side: 'buy', qty: 100, price: 13.0 }],
    fetch: fetchWith(null, INDEX_OBJ),
  });
  ok(miss2.status === 'empty', '仍返回 empty');
  ok(miss2.detail.coveredMonths.join('~') === '2026-01~2026-09', '覆盖范围读自 index.json');
  ok(miss2.detail.monthCovered === false, '2026-10 判为未覆盖');

  console.log('[6] 参数缺失 / 代码归一化');
  ok((await R.loadTradeReplay('', '20240102', {})).status === 'empty', '空代码返回 empty');
  ok((await R.loadTradeReplay('sz000001', '2024', {})).status === 'empty', '日期不完整返回 empty');
  ok(R.normSym('600853') === 'sh600853' && R.normSym('000722') === 'sz000722', '裸 6 位补市场前缀');

  console.log('[7] 红线：不叫胜率、不计分、不排名、不出现「你应该」');
  const blob = JSON.stringify([hit, sample, none, miss]).replace(/"fetch".*?}/g, '');
  ok(!/胜率|得分|评分|排名|排行|积分|你应该|建议你|score|rank|winrate/i.test(blob), '返回里没有评价/排名字段');

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
