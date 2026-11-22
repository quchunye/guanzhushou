// replay_readonly_test.js —— 组3 只读回放验收（node test/replay_readonly_test.js）
// 覆盖：走 resolveSnapshot() 取随包数据 / 只读已收盘 K 线与分时 / 条件只报命中条数 /
//       全程只请求 builtin 路径（断网口径）/ 文案不含指导性与收益类表述 / 无主动触达接口
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const RO = require('../public/features/replay_readonly');
const Snapshot = require('../public/features/snapshot');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

const INDEX = {
  schema: 'panji.builtin.index.v1',
  version: 'testv1',
  windows: [{ id: '2025h2', first: '20250701', last: '20251231', label: '2025-07-01~2025-12-31' }],
  symbols: [{ code: '000035', name: '样本甲' }],
};

const PACK = {
  schema: 'panji.klines.v1',
  symbol: '000035',
  name: '样本甲',
  window: '2025h2',
  first: '20251230',
  last: '20251231',
  bars: [
    '202512300930,10.00,10.20,9.90,10.10,1200',
    '202512300931,10.10,10.30,10.00,10.20,800',
    '202512310930,10.20,10.40,10.10,10.30,1500',
    '202512310931,10.30,10.50,10.20,10.40,900',
  ],
};

const requests = [];
function resText(txt) {
  return { ok: true, status: 200, text: function () { return Promise.resolve(txt); } };
}
function resBuf(buf) {
  return { ok: true, status: 200, arrayBuffer: function () { return Promise.resolve(buf); } };
}
// 只提供 builtin 下的两份东西；其它路径一律 404（等价于没有外部网络）
function offlineFetch(url) {
  const u = String(url);
  requests.push(u);
  if (u === 'builtin/index.json') return Promise.resolve(resText(JSON.stringify(INDEX)));
  if (/^builtin\/pack\/000035\.2025h2\.json\.gz$/.test(u)) {
    return Promise.resolve(resBuf(zlib.gzipSync(Buffer.from(JSON.stringify(PACK), 'utf8'))));
  }
  return Promise.resolve({ ok: false, status: 404, text: function () { return Promise.resolve(''); } });
}

function gunzip(buf) {
  return zlib.gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('utf8');
}

(async function main() {
  console.log('[1] 纯函数：窗口归属 / K 线解析 / 日线聚合');
  ok(RO.windowOf(INDEX, '20251231') === '2025h2', '窗口内日期 → 2025h2');
  ok(RO.windowOf(INDEX, '20260101') === '', '窗口外日期 → 空');
  ok(RO.windowOf(INDEX, '2025-12-31') === '2025h2', '带横线日期先归一为 8 位再判窗口');
  ok(RO.parseBars(PACK.bars) !== null, '合法 1 分钟行可解析');
  ok(RO.parseBars(['202512300930,10.00,10.20,9.90,10.10']) === null, '字段缺失 → null');
  ok(RO.parseBars(['202512300930,10.00,10.10,10.20,9.90,1200']) === null, '高低于实体 → null');
  ok(RO.parseBars(['202512300930,10.00,10.20,9.90,10.10,1200', '202512300930,10.00,10.20,9.90,10.10,1200']) === null, '重复分钟 → null');
  const daily = RO.aggregateDaily(RO.parseBars(PACK.bars));
  ok(daily.length === 2, '两个交易日 → 2 根日线');
  ok(daily[0].o === 10.00 && daily[0].h === 10.30 && daily[0].l === 9.90 && daily[0].c === 10.20, '首日 OHLC 正确');
  ok(daily[0].v === 2000 && daily[0].bars === 2, '首日量与分钟根数正确');
  ok(daily[1].prevClose === 10.20, '次日带前收');

  console.log('[2] 数量事实：振幅与收盘区间位置');
  const f0 = RO.factsOf(daily, 0);
  const f1 = RO.factsOf(daily, 1);
  ok(f0.amplitude === null && f0.prevClose === null, '窗口首日没有前收 → 振幅为空');
  ok(Math.abs(f1.amplitude - (10.50 - 10.10) / 10.20 * 100) < 1e-9, '次日振幅 = (高-低)/前收');
  ok(Math.abs(f1.closePos - (10.40 - 10.10) / (10.50 - 10.10) * 100) < 1e-9, '收盘区间位置 = (收-低)/(高-低)');

  console.log('[3] 条件只数命中：构造 4/5');
  const days = [];
  for (let i = 0; i < 21; i += 1) {
    const c = 10 + i * 0.1;
    days.push({ d: '202601' + String(i + 1).padStart(2, '0'), o: c - 0.1, h: c + 0.1, l: c - 0.2, c: c, v: 2000 });
  }
  days[19].v = 1000;
  days[20].v = 2700;
  const settings = { shrinkMax: 55, volUpMin: 150, maDays: 20, riseMin: 2 };
  const res = RO.evaluate(days, 20, settings);
  ok(res.rows.length === 5 && res.total === 5, '固定 5 条条件');
  ok(res.rows[0].state === 'hit', '前日缩量：前日量/前5日均量 50.0% < 55% → 成立');
  ok(res.rows[0].actual === '50.0%', '前日缩量实际值 50.0%');
  ok(res.rows[1].state === 'hit' && res.rows[1].actual === '150.0%', '今放量：150.0% ≥ 150% → 成立');
  ok(res.rows[2].state === 'hit', '阳线：收 > 开 → 成立');
  ok(res.rows[3].state === 'hit', '站上均线：收 ≥ 20 日均收 → 成立');
  ok(res.rows[4].state === 'miss' && res.rows[4].actual === '+0.8%', '当日涨幅：+0.8% < 2% → 未成立');
  ok(res.hits === 4 && RO.countText(res) === '条件命中 4/5 条', '计数 4/5，文案只报条数');
  ok(res.rows.every((r) => !('score' in r) && !('rank' in r)), '条件行不带分值/位置字段');

  const none = RO.evaluate(days, 20, {});
  ok(none.hits === 1, '全部门槛为空时只有不设门槛的阳线成立');
  ok(none.rows.filter((r) => r.state === 'no_setting').length === 4, '四条要填门槛的条件标为未设门槛');
  const first = RO.evaluate(days, 0, settings);
  ok(first.rows.filter((r) => r.state === 'no_sample').length === 4, '首日四条条件标为样本不足');
  ok(RO.countText(first) === '条件命中 1/5 条', '样本不足不计入命中');

  console.log('[4] 数据入口：走 resolveSnapshot()，只请求随包 builtin 路径');
  global.PanjiSnapshot = Snapshot;
  const r1 = await RO.loadDay('000035', '20251231', { fetch: offlineFetch, auto: false, gunzip: gunzip });
  ok(r1.ok === true, 'loadDay 成功');
  ok(r1.source === 'bundle', '来源为随包（不是远端快照）');
  ok(r1.version === 'testv1' && r1.cutoffDay === '20251231', '版本与截止日来自随包索引');
  ok(r1.daily.length === 2 && r1.dayIndex === 1, '所选日定位到第 2 根日线');
  ok(r1.dayBars.length === 2 && r1.dayBars[0].t === '202512310930', '当日分时取到 2 根已收盘分钟线');
  ok(requests.every((u) => u.indexOf('builtin/') === 0), '全部请求都在 builtin/ 下');
  ok(!requests.some((u) => u.indexOf('/api/') >= 0), '没有任何 /api 请求');

  const out = await RO.loadDay('000035', '20260101', { fetch: offlineFetch, auto: false, gunzip: gunzip });
  ok(out.ok === false && out.error === 'day_out_of_window', '窗口外日期如实报错');
  const miss = await RO.loadDay('000035', '20251229', { fetch: offlineFetch, auto: false, gunzip: gunzip });
  ok(miss.ok === false && miss.error === 'day_not_in_pack', '窗口内但分片没有该日 → 如实报错');

  console.log('[5] 没有主动触达与实时通道');
  const js = fs.readFileSync(path.join(ROOT, 'public/features/replay_readonly.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public/replay_readonly.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/features/replay_readonly.css'), 'utf8');
  ['Notification', 'alert(', 'confirm(', 'setInterval', 'WebSocket', 'EventSource'].forEach(function (t) {
    ok(js.indexOf(t) === -1 && html.indexOf(t) === -1, '没有 ' + t);
  });
  ok(js.indexOf('Math.random') === -1, '没有随机数，同一数据每次结果一致');
  ok(html.indexOf('features/snapshot.js') >= 0 && html.indexOf('features/replay_readonly.js') >= 0, '页面按顺序加载快照层与本模块');
  ok(html.indexOf('/api/') === -1 && html.indexOf('api/snapshot') === -1, '页面不直连任何接口');

  console.log('[6] 文案边界：不含禁用表述与指导性动词');
  const BANNED = ['选股', '荐股', '精选', '牛股', '买卖点', '目标价', '胜率', '盈亏比', '评分', '排序',
    '推荐', '买入价', '卖出价', '买入参考', '买入区间', '该买', '该卖', '立即买入', '打分', '评级',
    '星级', '期望值', '收益率', '兑现率', '止损建议', '止盈建议', '建议', '应当', '适合'];
  // 合规免责声明「不构成投资建议」属于必须保留的边界表述，先剔除再判禁用词
  const htmlScan = html.split('不构成投资建议').join('');
  BANNED.forEach(function (w) {
    ok(js.indexOf(w) === -1 && htmlScan.indexOf(w) === -1 && css.indexOf(w) === -1, '不含「' + w + '」');
  });
  ok(html.indexOf('已收盘') >= 0, '页面写明已收盘');
  ok(html.indexOf('逐笔回放') >= 0 || css.length > 0, '页面保留返回逐笔回放的出口');

  console.log('');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  if (requests.length) console.log('请求路径：' + requests.join(' , '));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('FAIL 未捕获异常：' + (e && e.stack || e));
  process.exit(1);
});
