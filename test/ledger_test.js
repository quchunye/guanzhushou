// 账本合并测试（node test/ledger_test.js）
// 覆盖：精确去重、窗口重叠、OCR 错字容错、脏数据跳过、统计口径
const assert = require('assert');
const {
  mergeTrades, summarize, tradeKey, isSameTrade,
} = require('../public/ledger');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

function T(date, time, name, side, price, qty, code) {
  return { date, time, name, side, price, qty, code: code || '' };
}

// 模拟用户真实场景：东海证券 APP「历史成交」，无成交编号
const batch1 = [
  T('20261013', '10:14:50', '示例环保', '卖', 12.680, 100),
  T('20261013', '10:13:06', '示例建设', '买', 3.540, 100),
  T('20261013', '10:13:02', '示例建设', '买', 3.540, 300),
  T('20261014', '10:08:51', '示例环保', '卖', 12.620, 100),
  T('20261014', '10:08:02', '示例建设', '买', 3.530, 700),
];

const batch2 = [   // 次日再次导入，区间与 batch1 重叠 2 天，并多出 1 天
  T('20261014', '10:08:51', '示例环保', '卖', 12.620, 100),
  T('20261014', '10:08:02', '示例建设', '买', 3.530, 700),
  T('20261015', '09:31:39', '示例基建', '买', 3.610, 400),
  T('20261015', '09:31:01', '示例材料', '卖', 11.900, 100),
];

console.log('\n[1] 首次导入');
let r1 = mergeTrades(null, batch1, { importId: 'IMP1', now: '2026-10-20T00:00:00Z' });
ok(r1.added === 5 && r1.dup === 0, `首次新增 5 笔（实际 added=${r1.added} dup=${r1.dup}）`);
ok(r1.ledger.trades.length === 5, '账本总笔数 5');

console.log('\n[2] 同一批反复导入（幂等）');
let r2 = mergeTrades(r1.ledger, batch1, { importId: 'IMP2', now: '2026-10-20T01:00:00Z' });
ok(r2.added === 0 && r2.dup === 5, `重复导入不新增（added=${r2.added} dup=${r2.dup}）`);
ok(r2.ledger.trades.length === 5, '账本仍为 5 笔');

console.log('\n[3] 窗口重叠导入（关键场景）');
let r3 = mergeTrades(r2.ledger, batch2, { importId: 'IMP3', now: '2026-10-21T00:00:00Z' });
ok(r3.added === 2, `重叠 2 笔被去重、新增 2 笔（added=${r3.added}）`);
ok(r3.dup === 2, `重复计数为 2（dup=${r3.dup}）`);
ok(r3.ledger.trades.length === 7, `账本累计 7 笔（实际 ${r3.ledger.trades.length}）`);

console.log('\n[4] 同一批内部重复（截图重叠导致）');
const dupInBatch = [batch2[2], batch2[2], batch2[3]];
let r4 = mergeTrades(r3.ledger, dupInBatch, { importId: 'IMP4' });
ok(r4.added === 0, '批内重复 + 已存在，全部不新增');
ok(r4.dup === 3, `重复 3 笔（dup=${r4.dup}）`);

console.log('\n[5] OCR 错字容错（"示例环保"识别成"示例环服"）');
const typo = [T('20261013', '10:14:50', '示例环服', '卖', 12.680, 100)];
let r5 = mergeTrades(r4.ledger, typo, { importId: 'IMP5' });
ok(r5.added === 0, '名称差 1 字被判为同一笔，不新增');
ok(r5.ledger.dupLog.length >= 1, '记录了一条模糊匹配日志');

console.log('\n[6] 价格容差与时间容差');
const near1 = [T('20261013', '10:14:52', '示例环保', '卖', 12.679, 100)];  // 时间差2秒、价差1/1000
let r6 = mergeTrades(r5.ledger, near1, { importId: 'IMP6' });
ok(r6.added === 0, '时间差≤2秒且价差≤1% 判为同一笔');
const far1 = [T('20261013', '10:14:50', '示例环保', '卖', 12.500, 100)];   // 价差 1.4%
let r7 = mergeTrades(r6.ledger, far1, { importId: 'IMP7' });
ok(r7.added === 1, '价差超 1% 视为不同笔（可能是真两笔）');

console.log('\n[7] 脏数据不污染账本');
const dirty = [
  { date: '', time: '', name: '某某', side: '买', price: 1, qty: 100 },
  { date: '20261016', time: '09:30:00', name: '', side: '买', price: 1, qty: 100 },
  T('20261016', '09:30:00', '正常票', '买', 5.000, 200),
];
let r8 = mergeTrades(r7.ledger, dirty, { importId: 'IMP8' });
ok(r8.added === 1, `只有 1 笔合格数据入库（added=${r8.added}）`);

console.log('\n[8] 统计口径');
const s = summarize(r8.ledger);
ok(s.total === 9, `总笔数 9（实际 ${s.total}）`);
ok(s.coverageFrom === '20261013' && s.coverageTo === '20261016',
   `覆盖区间 20261013~20261016（实际 ${s.coverageFrom}~${s.coverageTo}）`);
ok(s.tradeDays === 4, `有交易的天数 4（实际 ${s.tradeDays}）`);
ok(s.importCount === 8, `导入记录 8 次（实际 ${s.importCount}）`);

console.log('\n[9] 键构造稳定性');
ok(tradeKey(T('2026-10-13', '10:14:50', '示例环保', '卖', 12.68, 100))
   === tradeKey(T('20261013', '101450', '示例环保', '卖', 12.680, 100)),
   '不同日期写法归一后键相同');

console.log('\n[10] 同名不同价不合并');
ok(isSameTrade(T('20261013', '10:14:50', '示例建设', '买', 3.540, 100),
               T('20261013', '10:14:50', '示例建设', '买', 3.700, 100)) === false,
   '同秒同量但价格不同 → 不是同一笔');

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
