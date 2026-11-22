// replay_test.js —— RPL-1 阶段3 回放最小闭环验收（node test/replay_test.js）
// 覆盖：load 失败一律 null / checkpoint 切片不越界（含未来 K 线被裁）/ 成交时刻归属 K 线 / 训练交互未选不揭示
'use strict';
const R = require('../public/features/replay');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

const mk = (date, time, side, price, qty) => ({ date, time, code: 'KX0001', name: '合成样本丁', side, price, qty });
const K5 = [
  '000101010935,10.00,10.50,9.90,10.20,1000',
  '000101010940,10.20,10.60,10.10,10.40,1000',
  '000101010945,10.40,10.80,10.30,10.60,1000',
  '000101010950,10.60,11.00,10.50,10.90,1000',
  '000101010955,10.90,11.20,10.80,11.10,1000',
];
const loadK = (trades, klines) => R.load('KX0001', '00010101', { klines: klines || K5, trades });

console.log('[1] load() 失败场景返回 null（不抛异常）');
ok(R.load('KX9999', '00010101', { trades: [mk('00010101', '09:45:00', '买', 10.5, 100)] }) === null, '未知标的 → null');
ok(R.load('KX0001', '00010104', { trades: [mk('00010101', '09:45:00', '买', 10.5, 100)] }) === null, '样本外日期 → null');
ok(R.load('KX0001', '00010101', { trades: [] }) === null, '无 trade → null');
ok(R.load('KX0001', '00010101') === null, '默认读账本但无 localStorage → null');
ok(R.load(null, null) === null, '入参缺失 → null');
ok(R.load('KX0001', '00010101', { klines: ['000101010935,10.0,10.5,9.9,10.2'], trades: [mk('00010101', '09:45:00', '买', 10.5, 100)] }) === null, 'K 线字段缺失 → null');
ok(R.load('KX0001', '00010101', { klines: K5, trades: [mk('00010101', '09:45:00', '买', 99, 100)] }) === null, '成交价偏离 >5% → 拒载 null');
ok(R.load('KX0001', '00010101', { klines: K5, trades: [mk('00010101', '', '买', 10.5, 100)] }) === null, '缺成交时间 → null');
ok(R.load('KX0001', '00010101', { klines: K5, trades: [mk('00010101', '09:10:00', '买', 10.5, 100)] }) === null, '成交时刻落在任何 K 线区间之外（开盘前）→ null');
ok(typeof R.load('KX0001', '00010101') === 'object' || R.load('KX0001', '00010101') === null, '不抛异常（返回 null 也允许）');

console.log('[2] checkpoint 切片不越界：构造“未来 K 线”必须被裁掉');
const r1 = loadK([mk('00010101', '09:45:00', '买', 10.5, 100)]);
ok(!!r1, '合法样本可载入');
ok(r1.checkpoints.length === 1 && r1.checkpoints[0].visibleUntil === '000101010945', 'visibleUntil = 成交时刻已收盘的最后一根');
const FUT = ['000101010950', '000101010955'];
const vUn = R.trainView(r1, 0, '');
ok(vUn.visible.length === 3, '未揭示时只渲染 3 根（09:35/09:40/09:45）');
ok(vUn.visible.every((b) => b.t <= r1.checkpoints[0].visibleUntil), '训练切片 max(t) <= visibleUntil');
ok(vUn.maxVisibleT === '000101010945', 'maxVisibleT 记录正确');
ok(FUT.every((t) => !vUn.visible.some((b) => b.t === t)), '未来 K 线未进入训练切片');
ok(vUn.after.length === 0, '未揭示时 after 为空');
ok(R.sliceVisible(r1.klines, '000101010945').length === 3
  && R.sliceVisible(r1.klines, '000101010945').every((b) => b.t <= '000101010945'), 'sliceVisible 显式裁掉 09:50/09:55 两根未来 K 线');
ok(R.trainView(r1, 0, 'do').after.length === 2, '揭示后未来两根才出现');

console.log('[3] trade 时间戳对齐：成交时刻落在某根 K 线内时归属正确');
const r2 = loadK([mk('00010101', '09:41:00', '买', 10.5, 100)]);
ok(!!r2 && r2.checkpoints[0].barT === '000101010945', '09:41 归属 09:45 这根（区间 09:40–09:45）');
ok(r2.checkpoints[0].at === '000101010941', 'at 保留到分钟');
ok(r2.checkpoints[0].visibleUntil === '000101010940', '09:41 时只能看到 09:40（09:45 未收盘）');
const r3 = loadK([mk('00010101', '09:45:30', '买', 10.5, 100)]);
ok(!!r3 && r3.checkpoints[0].at === '000101010945' && r3.checkpoints[0].barT === '000101010945', '09:45:30 归属 09:45');
const r4 = loadK([mk('00010101', '09:55:00', '卖', 11.0, 100)]);
ok(!!r4 && r4.checkpoints[0].barT === '000101010955' && r4.checkpoints[0].visibleUntil === '000101010955', '09:55 归属 09:55');
const r5 = loadK([
  mk('00010101', '09:45:00', '买', 10.5, 100),
  mk('00010101', '09:55:00', '卖', 11.1, 100),
]);
ok(r5.checkpoints.length === 2 && r5.checkpoints[0].kind === 'buy_in' && r5.checkpoints[1].kind === 'sell_out', '买卖方向映射 buy_in/sell_out');
ok(r5.checkpoints.every((c) => c.visibleUntil <= c.at), '硬规则：visibleUntil <= at');

console.log('[4] 训练交互：未选择不揭示后续；选择后才出现');
const v0 = R.trainView(r5, 0, '');
ok(v0.revealed === false && v0.after.length === 0 && v0.actual === null, '未选择：revealed=false、after=[]、actual=null');
ok(v0.question === '这一刻你会不会动手', '问题文案');
ok(v0.choices.map((c) => c.label).join('/') === '动手/不动手', '两个按钮：动手 / 不动手');
const vDo = R.trainView(r5, 0, 'do');
ok(vDo.revealed === true && vDo.after.length > 0, '选“动手”后出现后续 K 线');
ok(vDo.after[0].t === '000101010950', '后续从 09:50 开始（严格晚于 visibleUntil）');
ok(vDo.after[vDo.after.length - 1].t === '000101010955', '后续截止到下一笔成交（09:55）');
ok(vDo.actual && vDo.actual.mode === 'trade' && vDo.actual.price === 11.1, '实际结果用下一笔卖出成交价对照');
ok(vDo.actual.pct > 0, '买 10.5 → 卖 11.1，结果为正');
ok(vDo.after.every((b) => b.t > vDo.visibleUntil), '后续切片全部晚于 visibleUntil，无重复渲染');
const vWait = R.trainView(r5, 0, 'wait');
ok(vWait.revealed === true && vWait.choice === 'wait' && vWait.after.length === vDo.after.length, '选“不动手”同样揭示后续（产品不奖励多交易，不做分数）');

console.log('[5] 内置演示样本（虚构代码 KX0001，合成 5m）');
const SROW = R.SAMPLE.raw.filter((x) => x.indexOf('000101010945,') === 0)[0];
const SPX = +SROW.split(',')[4];
const r6 = R.load('KX0001', '00010101', {
  trades: [mk('00010101', '09:45:00', '买', SPX, 1600)],
});
ok(!!r6 && r6.klines.length === 48, '示意日共 48 根 5m');
ok(!!r6 && r6.adjust === 'synthetic', '标注 synthetic（合成走势，不是真实复权）');
ok(!!r6 && r6.klines[0].t === '000101010935' && r6.klines[r6.klines.length - 1].t === '000101011500', '首末根 09:35 / 15:00');
ok(!!r6 && !r6.klines.some((b) => b.t.slice(8, 12) > '1130' && b.t.slice(8, 12) < '1305'), '午休无 bar');
const v6 = R.trainView(r6, 0, '');
ok(v6.visible.length === 3 && v6.maxVisibleT === '000101010945', '09:45:00 可见 09:35/09:40/09:45 三根（09:45 已收盘）');
ok(v6.visible.every((b) => b.t <= v6.visibleUntil), '样本切片不越界');

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
