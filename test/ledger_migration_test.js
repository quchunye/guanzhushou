// ledger_migration_test.js —— 批次 E · 23 多账户迁移验收（node test/ledger_migration_test.js）
// 覆盖：老账本补 default、笔数不变、failed=0、幂等、同标的跨账户不合并、
//       失败时原子不写、dupKeys 只报告不删、rebuild 后索引按账户分开、导出/导入回滚演练、复核页下拉。
'use strict';
const R = require('../public/recur');
const L = require('../public/ledger');
const A = require('../public/features/asset');
const { analyze } = require('../server/rules');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

function memStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _m: m,
    clear: () => { Object.keys(m).forEach((k) => delete m[k]); },
  };
}
function seed(s, key, value) { s.setItem(key, JSON.stringify(value)); }
function read(s, key) { return JSON.parse(s.getItem(key)); }
function CASE(no) { return 'guanzhu_case_' + String(no).padStart(3, '0'); }

// 20261102 23:27 真实备份的 8 笔账本形状（当时没有 account 字段）
const OLD_TRADES = [
  { date: '20261030', time: '131206', code: '', name: '九阳股份', side: '买', price: 23.38, qty: 200 },
  { date: '20261030', time: '131132', code: '', name: '九阳股份', side: '买', price: 23.26, qty: 200 },
  { date: '20261030', time: '130626', code: '', name: '九阳股份', side: '买', price: 22.985, qty: 200 },
  { date: '20261029', time: '101404', code: '', name: '鸿博股份', side: '卖', price: 9.22, qty: 100 },
  { date: '20261029', time: '093002', code: '', name: '鸿博股份', side: '卖', price: 9.21, qty: 700 },
  { date: '20261028', time: '135502', code: '', name: '鸿博股份', side: '买', price: 9.23, qty: 100 },
  { date: '20261028', time: '131324', code: '', name: '鸿博股份', side: '买', price: 9.31, qty: 1400 },
  { date: '20261026', time: '093234', code: '', name: '智光电气', side: '卖', price: 9.28, qty: 600 },
];

const line = (date, time, side, name, price, qty, rule, flag, account) => ({
  date, time, side, name, code: '', price, qty, rule, flag,
  reason: '', ...(account === undefined ? {} : { account }),
});
const caseObj = (no, trades, lines) => ({
  ts: '2026-11-02T15:27:43.785Z',
  trades,
  verdict: { case_no: 'case_' + String(no).padStart(3, '0'), lines, day_checks: [], suspects: [] },
});

// ---------- [1] 老账本迁移：全部补 default，笔数不变 ----------
const s1 = memStorage();
seed(s1, 'guanzhu_ledger', {
  trades: OLD_TRADES.map((t) => Object.assign({}, t, { firstSeen: 'x', lastSeen: 'x', importId: 'case_001' })),
  imports: [{ id: 'case_001', at: '2026-11-02T15:27:43.785Z', imported: 8, added: 8, dup: 0 }],
  dupLog: [],
});
seed(s1, 'guanzhu_case_seq', 1);
seed(s1, CASE(1), caseObj(1,
  [{ date: '20261029', time: '100000', code: '', name: '鸿博股份', side: '买', price: 9.2, qty: 100 }],
  [
    line('20261026', '093234', '卖', '智光电气', 9.28, 600, null, '合规'),
    line('20261029', '100000', '买', '鸿博股份', 9.2, 100, 'T04', '违规'),
    line('20261030', '130626', '买', '九阳股份', 22.985, 200, 'T04', '违规'),
  ]));
const OLD_KEY = '20261030|131206|九阳股份|买|23.380|200|';
seed(s1, 'guanzhu_exempt_v1', { [OLD_KEY]: { T04: true } });
seed(s1, 'guanzhu_reason_v1', { [OLD_KEY]: '回踩' });
seed(s1, 'guanzhu_stop_v1', { [OLD_KEY]: 22.5 });

R.configure({ storage: s1 });
A.configure({ storage: s1, recur: R, ledger: L });

(async function main() {
console.log('\n[1] 老账本迁移：填 default / 笔数不变 / failed=0');
const beforeCount = read(s1, 'guanzhu_ledger').trades.length;
const m1 = A.migrateV2();
ok(m1.total === 8, `迁移 total=8（实际 ${m1.total}）`);
ok(m1.migrated === 8, `8 笔全部补 default（实际 ${m1.migrated}）`);
ok(m1.failed === 0, `failed=0（实际 ${m1.failed}）`);
ok(m1.dupKeys.length === 0, `dupKeys=0（实际 ${m1.dupKeys.length}）`);
ok(m1.ok === true && m1.aborted === false, '迁移成功且未中止');
ok(m1.casesMigrated === 1, `真实案例 1 个补齐（实际 ${m1.casesMigrated}）`);
ok(m1.keysMigrated === 3, `tk6 映射 3 个键补齐（实际 ${m1.keysMigrated}）`);
ok(m1.rebuilt === true, '迁移后已重建复发索引');

const afterLedger = read(s1, 'guanzhu_ledger');
ok(afterLedger.trades.length === beforeCount && beforeCount === 8,
   `迁移前后笔数一致（${beforeCount} → ${afterLedger.trades.length}）`);
ok(afterLedger.trades.every((t) => t.account === 'default'), '账本每笔 account=default');
ok(afterLedger.trades[0].name === '九阳股份' && afterLedger.trades[0].price === 23.38,
   '迁移不丢原字段（名称/价格不变）');
const c1 = read(s1, CASE(1));
ok(c1.trades.every((t) => t.account === 'default'), '案例 trades 补 default');
ok(c1.verdict.lines.every((l) => l.account === 'default'), '案例 verdict.lines 补 default');
ok(read(s1, 'guanzhu_exempt_v1')[OLD_KEY + 'default'] !== undefined,
   '申诉例外键补 default（值保留）');
ok(read(s1, 'guanzhu_reason_v1')[OLD_KEY + 'default'] === '回踩', '买入理由值保留');
ok(read(s1, 'guanzhu_stop_v1')[OLD_KEY + 'default'] === 22.5, '止损价值保留');

const st1 = R._state();
const day30 = st1.rules.T04 && st1.rules.T04.days['20261030'];
ok(!!day30 && day30.keys.some((k) => k.endsWith('|default')),
   '复发索引重建后，T04 键带 account 段');
ok(R.count('T04', 30, '20261102') === 2, `重建后 T04 触发 2 天（实际 ${R.count('T04', 30, '20261102')}）`);
ok(A.recurByAccount('default', 30, '20261102')[0].ruleId === 'T04', '账户视图默认账户命中 T04');

// ---------- [2] 幂等：再跑一次 migrated=0，存储一字不改 ----------
console.log('\n[2] 幂等：再跑一次 migrated=0');
const snapKeys = ['guanzhu_ledger', CASE(1), 'guanzhu_exempt_v1', 'guanzhu_reason_v1', 'guanzhu_stop_v1', 'guanzhu_recur_v1'];
const snapshot = snapKeys.map((k) => s1.getItem(k));
const m2 = A.migrateV2();
ok(m2.total === 8 && m2.migrated === 0, `第二次 migrated=0（实际 ${m2.migrated}）`);
ok(m2.failed === 0, `第二次 failed=0（实际 ${m2.failed}）`);
ok(m2.casesMigrated === 0 && m2.keysMigrated === 0, '第二次案例/键均无改动');
ok(m2.rebuilt === false, '第二次不重建索引');
ok(snapKeys.every((k, i) => s1.getItem(k) === snapshot[i]), '第二次运行存储逐 key 完全不变');

// ---------- [3] 同标的跨账户绝不合并 ----------
console.log('\n[3] 同标的跨账户不合并（精确键 + 模糊匹配）');
const trade = (account, name) => ({
  date: '20261030', time: '131206', code: '', name: name || '九阳股份',
  side: '买', price: 23.38, qty: 200, account,
});
ok(L.tradeKey(trade('default')) !== L.tradeKey(trade('credit')), '同笔不同账户 tradeKey 不同');
ok(L.tradeKey(trade('default')).endsWith('|default'), 'tradeKey 末段是 account');
ok(L.tradeKey({ ...trade(''), account: undefined }).endsWith('|'), '未迁移账户默认空串段');
ok(L.isSameTrade(trade('default'), trade('credit')) === false, 'isSameTrade 先比 account → 不同账户 false');
ok(L.isSameTrade(trade('default'), trade('default', '九阳股服')) === true, '同账户仍保留 1 字 OCR 容错');

let base = L.mergeTrades(null, [trade('default')], { importId: 'ACC1', now: '2026-11-02T00:00:00Z' });
let rAcc = L.mergeTrades(base.ledger, [trade('credit')], { importId: 'ACC2', now: '2026-11-02T00:01:00Z' });
ok(rAcc.added === 1 && rAcc.dup === 0, `跨账户同标的并存入库（added=${rAcc.added} dup=${rAcc.dup}）`);
ok(rAcc.ledger.trades.length === 2, '账本 2 笔（每个账户 1 笔）');

const rSame = L.mergeTrades(rAcc.ledger, [trade('credit')], { importId: 'ACC3' });
ok(rSame.added === 0 && rSame.dup === 1, `同账户重复仍是重复（added=${rSame.added} dup=${rSame.dup}）`);

const rFuzzyCross = L.mergeTrades(rAcc.ledger, [trade('other', '九阳股服')], { importId: 'ACC4' });
ok(rFuzzyCross.added === 1, '模糊名称错字也不能跨账户合并');

// 安全网：已迁移账本 + 新数据没 account（flag 关了）→ 视作 default，不重复入库
const baseDefault = L.mergeTrades(null, [trade('default')], { importId: 'SAFE1' });
const noAcc = { date: '20261030', time: '131206', code: '', name: '九阳股份', side: '买', price: 23.38, qty: 200 };
const safeSame = L.mergeTrades(baseDefault.ledger, [noAcc], { importId: 'SAFE2' });
ok(safeSame.added === 0 && safeSame.dup === 1, '已迁移账本 + 无 account 新数据 → 按 default 去重');
const baseCredit = L.mergeTrades(null, [trade('credit')], { importId: 'SAFE3' });
const safeCredit = L.mergeTrades(baseCredit.ledger, [noAcc], { importId: 'SAFE4' });
ok(safeCredit.added === 1 && safeCredit.ledger.trades[1].account === 'default',
   '无 account 新数据归 default，不与 credit 合并');

const mixLedger = {
  trades: [
    { date: '20261020', time: '094000', code: '600000', name: '甲', side: '买', price: 12, qty: 100, account: 'default' },
    { date: '20261021', time: '100000', code: '', name: '乙', side: '买', price: 13, qty: 100, account: 'credit' },
    { date: '20261022', time: '110000', code: '', name: '丙', side: '买', price: 14, qty: 200 }, // 老数据空 account
  ],
  imports: [], dupLog: [],
};
ok(L.summarize(mixLedger).total === 3, '全量统计 3 笔');
ok(L.summarize(mixLedger, { account: 'default' }).total === 2, '普通账户统计 2 笔（空 account 归 default）');
ok(L.summarize(mixLedger, { account: 'credit' }).total === 1, '信用账户统计 1 笔，不串入普通');
ok(L.summarize(mixLedger, { account: 'other' }).total === 0, '其他账户统计 0 笔');

// ---------- [4] 有失败就原子不写（保留现场等 22 备份回滚） ----------
console.log('\n[4] 失败 >0 → 整体不落盘');
const s2 = memStorage();
seed(s2, 'guanzhu_ledger', { trades: OLD_TRADES.slice(0, 2).map((t) => Object.assign({}, t)), imports: [], dupLog: [] });
s2.setItem(CASE(1), '{broken json');
seed(s2, 'guanzhu_case_seq', 1);
A.configure({ storage: s2, recur: R, ledger: L });
R.configure({ storage: s2 });
const ledgerRawBefore = s2.getItem('guanzhu_ledger');
const mBad = A.migrateV2();
ok(mBad.failed >= 1, `坏案例计入 failed（实际 ${mBad.failed}）`);
ok(mBad.aborted === true && mBad.ok === false, '有失败 → aborted=true');
ok(mBad.migrated === 0, '失败时 migrated 归零，不做半截迁移');
ok(s2.getItem('guanzhu_ledger') === ledgerRawBefore, '失败时账本原样未写');
ok(s2.getItem(CASE(1)) === '{broken json', '失败时坏案例原样未写');

s2.removeItem(CASE(1));
seed(s2, 'guanzhu_case_seq', 0);
const mFixed = A.migrateV2();
ok(mFixed.migrated === 2 && mFixed.failed === 0, `排除坏案例后 2 笔迁移成功（${mFixed.migrated}/${mFixed.failed}）`);
ok(read(s2, 'guanzhu_ledger').trades.every((t) => t.account === 'default'), '修复后账本全部 default');

const s3 = memStorage();
s3.setItem('guanzhu_ledger', '{not json');
A.configure({ storage: s3, recur: R, ledger: L });
R.configure({ storage: s3 });
const mRaw = A.migrateV2();
ok(mRaw.failed === 1 && mRaw.aborted === true, '账本 JSON 损坏 → failed=1 / aborted');
ok(s3.getItem('guanzhu_ledger') === '{not json', '账本损坏时原样未写');

// ---------- [5] 迁移后键碰撞只报告，不删数据 ----------
console.log('\n[5] dupKeys 只报告不删（笔数保持一致）');
const s4 = memStorage();
const dupTrade = { date: '20261030', time: '131206', code: '', name: '九阳股份', side: '买', price: 23.38, qty: 200 };
seed(s4, 'guanzhu_ledger', { trades: [{ ...dupTrade }, { ...dupTrade }], imports: [], dupLog: [] });
A.configure({ storage: s4, recur: R, ledger: L });
R.configure({ storage: s4 });
const mDup = A.migrateV2();
ok(mDup.total === 2 && mDup.migrated === 2, '2 笔都补齐 account');
ok(mDup.dupKeys.length === 1, `迁移后检出 1 个重复键（实际 ${mDup.dupKeys.length}）`);
ok(mDup.dupKeys[0].endsWith('|default'), '重复键已带 default 段');
ok(read(s4, 'guanzhu_ledger').trades.length === 2, '不删重复笔，迁移前后笔数一致');

// ---------- [6] rebuild 后索引按账户分开 ----------
console.log('\n[6] 复发索引按账户分开');
const s5 = memStorage();
seed(s5, 'guanzhu_case_seq', 2);
seed(s5, CASE(1), caseObj(1,
  [{ date: '20261030', time: '131206', code: '', name: '九阳股份', side: '买', price: 23.38, qty: 200 }],
  [
    line('20261029', '100000', '买', '鸿博股份', 9.2, 100, 'T04', '违规'),
    line('20261030', '131206', '买', '九阳股份', 23.38, 200, 'T04', '违规'),
  ]));
seed(s5, CASE(2), caseObj(2,
  [{ date: '20261030', time: '131206', code: '', name: '九阳股份', side: '买', price: 23.38, qty: 200, account: 'credit' }],
  [line('20261030', '131206', '买', '九阳股份', 23.38, 200, 'T04', '违规', 'credit')]));
A.configure({ storage: s5, recur: R, ledger: L });
R.configure({ storage: s5 });
const mAcc = A.migrateV2();
ok(mAcc.casesMigrated === 1 && mAcc.failed === 0, `老案例补 default 1 个（${mAcc.casesMigrated}）`);
ok(mAcc.rebuilt === true, '按账户迁移后重建索引');

const stAcc = R._state();
const keys30 = stAcc.rules.T04.days['20261030'].keys;
ok(keys30.length === 2, `同一笔在两个账户保留 2 个 tk6 键（实际 ${keys30.length}）`);
ok(keys30.some((k) => k.endsWith('|default')) && keys30.some((k) => k.endsWith('|credit')),
   '20261030 的键同时含 default 与 credit');
ok(R.count('T04', 30, '20261102') === 2, `全账户并集 2 天（实际 ${R.count('T04', 30, '20261102')}）`);
const byDefault = A.recurByAccount('default', 30, '20261102');
const byCredit = A.recurByAccount('credit', 30, '20261102');
ok(byDefault[0] && byDefault[0].ruleId === 'T04' && byDefault[0].count === 2,
   `默认账户 T04 2 天（实际 ${byDefault[0] && byDefault[0].count}）`);
ok(byCredit[0] && byCredit[0].ruleId === 'T04' && byCredit[0].count === 1,
   `信用账户 T04 1 天（实际 ${byCredit[0] && byCredit[0].count}）`);
ok(A.recurByAccount('other', 30, '20261102').length === 0, '其他账户无触发，不串数据');

// ---------- [7] 22 备份 → 迁移 → 导入回滚演练 ----------
console.log('\n[7] 22 备份 → 迁移 → 导入回滚演练');
A.configure({ storage: s1, recur: R, ledger: L });
R.configure({ storage: s1 });
const exp = await A.exportBackup();
ok(exp.ok && exp.counts.ledgerTrades === 8, `迁移后导出 8 笔（实际 ${exp.counts.ledgerTrades}）`);
const env = JSON.parse(exp.json);
ok(env.data.guanzhu_ledger.trades.every((t) => t.account === 'default'), '导出的账本每笔带 account');
ok(env.data[CASE(1)].verdict.lines.every((l) => l.account === 'default'), '导出的案例逐笔带 account');
ok(env.data.guanzhu_exempt_v1[OLD_KEY + 'default'] !== undefined, '导出的 tk6 映射带 account 键');

const s6 = memStorage();
A.configure({ storage: s6, recur: R, ledger: L });
R.configure({ storage: s6 });
const imp = await A.importBackup(exp.json);
ok(imp.ok === true, '导入成功');
ok(imp.addedTrades === 8 && imp.addedCases === 1, `回滚导入 8 笔 / 1 案例（${imp.addedTrades}/${imp.addedCases}）`);
ok(read(s6, 'guanzhu_ledger').trades.length === 8, '导入后账本 8 笔');
ok(read(s6, 'guanzhu_ledger').trades.every((t) => t.account === 'default'), '导入后 account 保留');
const mAfterImp = A.migrateV2();
ok(mAfterImp.migrated === 0 && mAfterImp.failed === 0, '导入后 migrateV2 幂等（migrated=0/failed=0）');
const exp2 = await A.exportBackup();
ok(exp2.counts.ledgerTrades === 8 && exp2.counts.cases === 1, '再次导出笔数/案例数一致');

// ---------- [8] 复核页下拉选项与默认填充 ----------
console.log('\n[8] 复核页账户下拉（default / credit / other）');
A.configure({ storage: s6, recur: R, ledger: L, flags: { asset: true } });
const review = { trades: [{ date: '20261030', time: '131206', code: '', name: '九阳股份', side: '买', price: 23.38, qty: 200 }] };
const bar = A.renderAccountBar(review);
ok(bar.indexOf('id="acct-select"') >= 0, '渲染账户下拉');
ok(bar.indexOf('<option value="default" selected>普通</option>') >= 0, '默认选中「普通」');
ok(bar.indexOf('<option value="credit">信用</option>') >= 0, '选项含「信用」');
ok(bar.indexOf('<option value="other">其他</option>') >= 0, '选项含「其他」');
ok(review.trades[0].account === 'default', '进入复核页自动给本批补 default');

const rep = A.renderAccountReport({
  lines: [{ date: '20261030', time: '131206', side: '买', name: '九阳股份', price: 23.38, qty: 200, account: 'credit', flag: '违规', rule: 'T04' }],
  day_checks: [], suspects: [],
}, { trades: [] });
ok(rep.indexOf('id="acct-rep-select"') >= 0, '报告页渲染账户切换下拉');
ok(rep.indexOf('value="credit" selected') >= 0, '报告页默认选中本档案账户「信用」');
ok(rep.indexOf('本档案账户：信用') >= 0, '报告页显示本档案账户');

const demoReview = { isDemo: true, trades: [{ date: '20261030', time: '131206', code: '', name: '九阳股份', side: '买', price: 23.38, qty: 200 }] };
ok(A.renderAccountBar(demoReview) === '', '示例体验不出账户下拉');
ok(demoReview.trades[0].account === undefined, '示例数据不写 account（保住 9 笔示例签名）');
ok(A.renderAccountReport({ lines: [], day_checks: [], suspects: [] }, { isDemo: true, trades: [] }) === '',
   '示例报告不出账户卡');

// ---------- [9] rules.js：ctx 与 verdict.lines 保留 account ----------
console.log('\n[9] 判定引擎按账户分组 + 逐笔带 account');
const rt = (account, time, name, price, qty, side) => ({
  date: '20261030', time, side: side || '买', name: name || '甲', code: '',
  price: price == null ? 10 : price, qty: qty == null ? 100 : qty, account,
});
const cfg = (rules, capital) => ({ rules: rules.map(([templateId, params]) => ({ templateId, params })), capital: capital || null });

const vTwo = analyze([rt('default', '10:00'), rt('credit', '10:01')], cfg([['T06', { maxBuys: 1 }]]), 'TEST');
ok(vTwo.lines.every((l) => l.flag === '合规') && vTwo.day_checks.length === 0,
   'T06：普通/信用各 1 笔，不合并成 2 笔');
ok(vTwo.lines[0].account === 'default' && vTwo.lines[1].account === 'credit', 'verdict.lines 保留 account');

const vOne = analyze([rt('default', '10:00'), rt('default', '10:01')], cfg([['T06', { maxBuys: 1 }]]), 'TEST');
ok(vOne.lines[1].rule === 'T06' && vOne.day_checks.length === 1, 'T06：同账户 2 笔仍触发');
ok(vOne.day_checks[0].account === 'default', 'day_checks 带 account');

const v05 = analyze([rt('default', '10:00', '甲', 10, 400), rt('credit', '10:01', '甲', 10, 400)],
  cfg([['T05', { maxPct: 5 }]], 100000), 'TEST');
ok(v05.lines.every((l) => l.flag === '合规'), 'T05：每账户各 4%，不混算成 8%');

const vSym = analyze([
  rt('default', '10:00', '甲'), rt('default', '10:01', '乙'), rt('default', '10:02', '丙'),
  rt('credit', '10:10', '甲'), rt('credit', '10:11', '乙'), rt('credit', '10:12', '丙'),
], cfg([['T08', { maxSymbols: 5 }]]), 'TEST');
ok(vSym.lines.every((l) => l.flag === '合规') && vSym.day_checks.length === 0,
   'T08：每账户 3 只，不合并成 6 只');

const vFifo = analyze([
  rt('default', '10:00', '甲', 10, 1000, '买'),
  rt('credit', '14:00', '甲', 5, 1000, '卖'),
], cfg([['T11', { maxPct: 2 }]], 100000), 'TEST');
ok(!vFifo.day_checks.some((d) => d.rule === 'T11'), 'T11：不跨账户配对（信用卖出不拿普通底仓算亏损）');

const vFifoOne = analyze([
  rt('default', '10:00', '甲', 10, 1000, '买'),
  rt('default', '14:00', '甲', 5, 1000, '卖'),
], cfg([['T11', { maxPct: 2 }]], 100000), 'TEST');
ok(vFifoOne.day_checks.some((d) => d.rule === 'T11' && d.account === 'default'),
   'T11：同账户亏损仍触发');

// ---------- [10] 示例案例：迁移不碰签名、不进复发索引 ----------
console.log('\n[10] 示例案例不被迁移污染');
const DEMO = [
  ['20261019', '101450', '示例环保', '卖', 12.68, 100],
  ['20261019', '101306', '示例建设', '买', 3.54, 100],
  ['20261019', '101302', '示例建设', '买', 3.54, 300],
  ['20261019', '100851', '示例环保', '卖', 12.62, 100],
  ['20261019', '100802', '示例建设', '买', 3.53, 700],
  ['20261019', '100510', '示例建设', '买', 3.53, 700],
  ['20261019', '093139', '示例基建', '买', 3.61, 400],
  ['20261019', '093101', '示例材料', '卖', 11.90, 100],
  ['20261019', '093021', '示例建设', '买', 3.70, 4100],
];
const demoLines = DEMO.map((x, i) => line(x[0], x[1], x[3], x[2], x[4], x[5], 'T04', '违规'));
const s7 = memStorage();
seed(s7, 'guanzhu_case_seq', 2);
seed(s7, CASE(2), caseObj(2, [], demoLines));
seed(s7, 'guanzhu_ledger', { trades: [Object.assign({}, OLD_TRADES[0])], imports: [], dupLog: [] });
A.configure({ storage: s7, recur: R, ledger: L });
R.configure({ storage: s7 });
const demoRaw = s7.getItem(CASE(2));
const mDemo = A.migrateV2();
ok(mDemo.migrated === 1 && mDemo.failed === 0, '账本 1 笔迁移成功');
ok(mDemo.casesMigrated === 0, '示例案例不补 account（签名必须保留）');
ok(s7.getItem(CASE(2)) === demoRaw, '示例案例原样未写');
ok(R.isDemoCase(read(s7, CASE(2)).verdict, 'case_002') === true, '示例签名仍可识别');
ok(R.count('T04', 30, '20261030') === 0, '示例案例不进复发索引');

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', (e && e.stack) || e);
  process.exit(1);
});
