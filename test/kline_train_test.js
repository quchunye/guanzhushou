// kline_train_test.js —— A 判断练习的交互层验收（node test/kline_train_test.js）
// 覆盖：出题点合法 / 空仓与持仓两套选项 / 未选不揭示 / 揭示后不可回退 / 结果只记事实不评分
'use strict';
const R = require('../public/features/replay');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

// 造 3 天 × 48 根（09:35–11:30、13:05–15:00），价格随手写但保持 h/l 自洽
function bars() {
  const out = [];
  const times = [];
  for (let m = 575; m <= 690; m += 5) times.push([Math.floor(m / 60), m % 60]);
  for (let m = 785; m <= 900; m += 5) times.push([Math.floor(m / 60), m % 60]);
  ['20240102', '20240103', '20240104'].forEach((d, di) => {
    times.forEach(([h, mi], i) => {
      const base = 10 + di * 0.2 + i * 0.01;
      const o = base, c = base + (i % 3 === 0 ? 0.02 : -0.01);
      out.push([
        d + String(h).padStart(2, '0') + String(mi).padStart(2, '0'),
        o.toFixed(2), (Math.max(o, c) + 0.03).toFixed(2),
        (Math.min(o, c) - 0.03).toFixed(2), c.toFixed(2), String(1000 + i),
      ].join(','));
    });
  });
  return out;
}
const PACK = {
  symbol: 'sz000001', name: '平安银行', month: '2024-01', timeframe: '5m',
  klines: R.parseKlines(bars()),
};

console.log('[1] buildDrill：出题点合法且可复现');
const d1 = R.buildDrill(PACK, { count: 8, seed: 'fixed' });
ok(!!d1 && d1.checkpoints.length === 8, '出 8 题');
ok(d1.checkpoints.every((c, i) => i === 0 || c.idx > d1.checkpoints[i - 1].idx), '题目按时间递增、不重复');
ok(d1.checkpoints.every((c) => c.idx >= 24), '每题前面至少 24 根历史');
ok(d1.checkpoints.every((c) => c.visibleUntil === c.at), 'visibleUntil = 停下的那根（收盘后才问）');
const d2 = R.buildDrill(PACK, { count: 8, seed: 'fixed' });
ok(JSON.stringify(d2.checkpoints) === JSON.stringify(d1.checkpoints), '同一 seed 可复现（测试可断言）');

console.log('[2] 未选时不揭示');
const v0 = R.drillView(d1, 0, 'flat', '');
ok(v0.revealed === false && v0.after.length === 0 && v0.actual === null, 'revealed=false、after=[]、actual=null');
ok(v0.visible.length === d1.checkpoints[0].idx + 1, '只渲染到停下那根为止');
ok(v0.visible[v0.visible.length - 1].t === v0.visibleUntil, '最后一根 = visibleUntil');
ok(v0.maxVisibleT === v0.visibleUntil, 'maxVisibleT 记录正确');

console.log('[3] 统一的动作对照选项');
ok(v0.question === '这一刻你会不会动手', '问题文案');
ok(v0.choices.map((c) => c.label).join('/') === '动手/不动手', '选项：动手 / 不动手');
const vLong = R.drillView(d1, 0, 'long', '');
ok(vLong.question === '这一刻你会不会动手', '已动手后问题文案不变成买卖决策');
ok(vLong.choices.map((c) => c.label).join('/') === '动手/不动手', '已动手后选项：动手 / 不动手');

console.log('[4] 选完才揭示，且只给事实');
const vBuy = R.drillView(d1, 0, 'flat', 'buy');
ok(vBuy.revealed === true && vBuy.choice === 'buy', '选「买」后 revealed=true');
ok(vBuy.after.length >= 6 && vBuy.after.length <= 12, '揭示 6–12 根（' + vBuy.after.length + '）');
ok(vBuy.after.every((b) => b.t > vBuy.visibleUntil), '后续全部晚于 visibleUntil，不重复');
ok(vBuy.after.every((b) => b.t.slice(0, 8) === vBuy.visibleUntil.slice(0, 8)), '不跨交易日（避免隔夜跳空误读）');
const a = vBuy.actual;
ok(a && a.mode === 'window', 'actual.mode=window');
ok(a && a.high === Math.max.apply(null, vBuy.after.map((b) => b.h)), 'high = 后续最高价');
ok(a && a.low === Math.min.apply(null, vBuy.after.map((b) => b.l)), 'low = 后续最低价');
ok(a && a.close === vBuy.after[vBuy.after.length - 1].c, 'close = 后续收盘价');
ok(!!(vBuy.visible.length && vBuy.visible[vBuy.visible.length - 1].c), '参考价取当时最后一根收盘');

console.log('[5] 红线：不评分、不排名、不出现「你应该」');
const keys = Object.keys(vBuy).concat(Object.keys(a || {}));
ok(!keys.some((k) => /score|win|accuracy|rank|grade|correct/i.test(k)), '视图对象里没有计分/胜率/排名字段');
const dumped = JSON.stringify(vBuy).replace(/"t":"[^"]*"|"o":|"h":|"l":|"c":|"v":/g, '');
ok(!/你应该|胜率|得分|排名|正确率/.test(dumped), '视图数据里没有评价性文案');

console.log('[6] 揭示后不可撤销、不可改选');
const st1 = R.commitChoice({ position: 'flat' }, 'buy');
ok(st1.choice === 'buy' && st1.position === 'long', '空仓选「买」→ 持仓');
const st2 = R.commitChoice({ choice: 'buy', position: 'long' }, 'wait');
ok(st2.choice === 'buy' && st2.position === 'long', '已选后再传「等」被忽略（不可回退）');
ok(R.commitChoice({ position: 'flat' }, 'wait').position === 'flat', '空仓选「等」→ 仍空仓');
ok(R.commitChoice({ position: 'long' }, 'cut').position === 'flat', '持仓选「减仓」→ 空仓');
ok(R.commitChoice({ position: 'long' }, 'hold').position === 'long', '持仓选「不动」→ 仍持仓');
ok(R.commitChoice({ position: 'long' }, 'add').position === 'long', '持仓选「加仓」→ 仍持仓');

console.log('[7] 数据不足时不硬出题');
ok(R.buildDrill({ symbol: 'x', month: 'y', klines: R.parseKlines(bars().slice(0, 20)) }) === null, '不足 30 根的月份 → null（页面降级）');
ok(R.buildDrill(null) === null, '空包 → null');
ok(R.drillView(d1, 99, 'flat', '') === null, '越界题号 → null');

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
