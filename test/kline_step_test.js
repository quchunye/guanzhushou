// kline_step_test.js —— B 逐根揭示的交互层验收（node test/kline_step_test.js）
// 覆盖：每次只多一根 / 连点多根不跳过 / 封顶后停住 / 退出复位从第 1 根开始 / 未来不可见 / 红线
'use strict';
const R = require('../public/features/replay');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

// 60 根合成 K 线：时间严格递增，价格自洽
function bars(n) {
  const out = [];
  const times = [];
  for (let m = 575; m <= 690; m += 5) times.push([Math.floor(m / 60), m % 60]);
  for (let m = 785; m <= 900; m += 5) times.push([Math.floor(m / 60), m % 60]);
  let d = 20240102;
  let i = 0;
  while (out.length < n) {
    const [h, mi] = times[i % times.length];
    const base = 10 + i * 0.01;
    const o = base, c = base + (i % 2 ? 0.01 : -0.01);
    out.push([
      String(d) + String(h).padStart(2, '0') + String(mi).padStart(2, '0'),
      o.toFixed(2), (Math.max(o, c) + 0.02).toFixed(2),
      (Math.min(o, c) - 0.02).toFixed(2), c.toFixed(2), String(1000 + i),
    ].join(','));
    i++;
    if (i % times.length === 0) d++;
  }
  return out;
}

const PACK = {
  symbol: 'sz000001', name: '平安银行', month: '2024-01', timeframe: '5m',
  adjust: 'none', klines: R.parseKlines(bars(60)),
};

console.log('[1] buildStep：基线合法、数据太短不给');
ok(R.buildStep(null) === null, 'null 包返回 null');
ok(R.buildStep({ klines: R.parseKlines(bars(2)) }) === null, '少于 3 根返回 null');
const st = R.buildStep(PACK, {});
ok(!!st && st.base === 30, '默认基线 30 根');
ok(R.buildStep(PACK, { base: 999 }).base === PACK.klines.length - 1, '基线过大会被夹住，不会把未来吃光');
ok(st.timeframe === '5m' && st.adjust === 'none', '口径字段原样保留');

console.log('[2] stepView：初始只给基线，未来不可见');
const v0 = R.stepView(st, R.resetStep());
ok(v0.steps === 0 && v0.total === 30, '初始 steps=0，共 30 根可揭示');
ok(v0.visible.length === 30 && v0.shown === 30, '只显示基线 30 根');
ok(v0.visible[v0.visible.length - 1].t === v0.maxVisibleT, 'maxVisibleT = 最后一根可见');
ok(v0.futureHidden === true && v0.canNext === true, '未来仍隐藏、还能继续');
ok(PACK.klines.slice(30).every((b) => b.t > v0.maxVisibleT), '第 31 根及以后都在可见边界之外');

console.log('[3] advanceStep：一次只多一根，连点不跳过');
let steps = 0;
const seen = [];
for (let i = 0; i < 4; i++) {
  steps = R.advanceStep(st, steps);
  seen.push(R.stepView(st, steps).shown);
}
ok(JSON.stringify(seen) === JSON.stringify([31, 32, 33, 34]), '连续四次 = 31/32/33/34，一根不多');
ok(R.advanceStep(st, 0) === 1 && R.advanceStep(st, 1) === 2, '相邻两次严格 +1');
const v4 = R.stepView(st, steps);
ok(v4.visible.length === steps + st.base, '可见根数 = 基线 + 步数');
ok(v4.maxVisibleT === PACK.klines[steps + st.base - 1].t, '可见边界落在第步数根');

console.log('[4] 封顶：放完就停，不会越界');
let capped = 0;
for (let i = 0; i < 100; i++) capped = R.advanceStep(st, capped);
const vc = R.stepView(st, capped);
ok(capped === vc.total && vc.total === 30, '步数封顶在 30');
ok(vc.shown === PACK.klines.length && vc.canNext === false, '全放完后不能继续');
ok(vc.futureHidden === false, '全放完后没有隐藏的未来');

console.log('[5] 退出复位：重进从第 1 根开始');
const after = R.resetStep();
const vr = R.stepView(st, after);
ok(after === 0 && vr.steps === 0 && vr.shown === 30, '复位后步数归零、只显示基线');
ok(vr.steps + 1 === 1, '界面计数回到第 1 根');
ok(R.stepView(R.buildStep(PACK, {}), R.resetStep()).shown === 30, '重新进入 = 等同全新状态，不留半截');
ok(vr.maxVisibleT === v0.maxVisibleT, '复位后可见边界与首次进入一致');

console.log('[6] 红线：不叫胜率、不计分、不排名、不出现「你应该」');
const blob = [JSON.stringify(v0), JSON.stringify(v4), JSON.stringify(vc)].join('|');
ok(!/胜率|得分|评分|排名|排行|积分|你应该|建议你|score|rank|winrate|grade/i.test(blob), '状态里没有任何评价/排名字段');
ok(Object.keys(v0).every((k) => !/score|rank|win|grade|point/i.test(k)), '字段名同样干净');

console.log('[7] 页面出口：a/b/c 与 flag 关都能回科普/复盘');
const html = require('fs').readFileSync(require('path').join(__dirname, '../public/replay.html'), 'utf8');
const nav = html.match(/<nav class="navfoot"[^>]*>[\s\S]*?<\/nav>/);
ok(!!nav, 'replay.html 有 navfoot 出口');
ok(nav && (nav[0].match(/href="\.\/learn\.html"/g) || []).length === 1, '去科普指向 ./learn.html');
ok(nav && (nav[0].match(/href="\.\//g) || []).length === 2, '去复盘指向 ./（相对路径）');
ok(!/id="navfoot"[^>]*hidden/.test(html), '出口不受 flag 隐藏影响');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
