// 复发索引测试（node test/recur_test.js）
// 覆盖：跨日计数、同一天多笔只算一次、重判不重复、day_checks 一天一次、
//       suspects 不计、exempt、回填、窗口 7/30/90。
const assert = require('assert');
const R = require('../public/recur');

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
  };
}

const storage = memStorage();
R.configure({ storage });
R.reset();

function L(date, time, name, side, price, qty, rule, flag) {
  return { date, time, name, side, price, qty, rule, flag };
}
function V(lines, dayChecks, suspects) {
  return { case_no: '', lines: lines || [], day_checks: dayChecks || [], suspects: suspects || [] };
}
function saveCase(n, verdict) {
  storage.setItem('guanzhu_case_' + String(n).padStart(3, '0'), JSON.stringify({ ts: '2026-10-30T00:00:00Z', trades: verdict.lines, verdict }));
}

const v1 = V([
  L('20260901', '093000', '甲', '买', 10, 100, 'T04', '违规'),
  L('20261024', '100000', '乙', '买', 20, 100, 'T03+T04', '违规'),
  L('20261028', '093000', '丙', '买', 30, 100, 'T04', '违规'),
], [
  { rule: 'T06', date: '20261024', text: '当日买入超限' },
  { rule: 'T06', date: '20261024', text: '同日另一条' },   // 同日同规则只算 1 天
], []);

const v2 = V([
  L('20261028', '093000', '丙', '买', 30, 100, 'T04', '违规'),   // 与 v1 同一笔：去重
  L('20261028', '140000', '丁', '买', 40, 100, 'T04', '违规'),   // 同日另一笔：仍只算 1 天
], [
  { rule: 'T06', date: '20261028', text: '当日买入超限' },
], [
  { code: 'x', rule: 'T04', text: '存疑项，不计' },
]);

const v3 = V([
  L('20260901', '093000', '甲', '买', 10, 100, 'T04', '违规'),   // 重判再现同一笔：不重复
], [], []);

function ingestAll() {
  R.ingest(v1, 'case_001');
  R.ingest(v2, 'case_002');
  R.ingest(v3, 'case_003');
  saveCase(1, v1); saveCase(2, v2); saveCase(3, v3);
  storage.setItem('guanzhu_case_seq', '3');
}

console.log('\n[1] 跨日计数 / 同日多笔只算一次 / 重判不重复');
ingestAll();
ok(R.count('T04', 90, '20261030') === 3, `T04 触发日 3 天（实际 ${R.count('T04', 90, '20261030')}）`);
ok(R.count('T03', 90, '20261030') === 1, `T03 触发日 1 天（实际 ${R.count('T03', 90, '20261030')}）`);
ok(R.count('T06', 90, '20261030') === 2, `T06 日级触发 2 天（实际 ${R.count('T06', 90, '20261030')}）`);

console.log('\n[2] 同一天同一规则多笔也只算一天');
const st = R._state();
ok(Object.keys(st.rules.T04.days['20261028'].keys).length === 2,
   `20261028 T04 有 2 笔明细，但只算 1 天`);
ok(R.count('T04', 1, '20261028') === 1, '单日窗口仍为 1');

console.log('\n[3] day_checks 一天只算一次');
ok(R.count('T06', 1, '20261024') === 1, '同日两条 day_check 只算 1 天');

console.log('\n[4] suspects 不计');
ok(R.count('T04', 1, '20261028') === 1, '带 suspects 的案例不额外增加 T04 天数');

console.log('\n[5] 窗口 7 / 30 / 90');
ok(R.count('T04', 7, '20261030') === 2, `7 天窗口 2 天（实际 ${R.count('T04', 7, '20261030')}）`);
ok(R.count('T04', 30, '20261030') === 2, `30 天窗口 2 天（实际 ${R.count('T04', 30, '20261030')}）`);
ok(R.count('T04', 90, '20261030') === 3, `90 天窗口 3 天（实际 ${R.count('T04', 90, '20261030')}）`);
const top7 = R.top(7, '20261030');
ok(top7[0] && top7[0].ruleId === 'T04' && top7[0].count === 2, 'top(7) 第一项是 T04=2 天');
ok(R.ruleStats('20261030').T04.sinceLast === 2, `T04 距上次 2 天（实际 ${R.ruleStats('20261030').T04.sinceLast}）`);

console.log('\n[6] exempt：申诉例外不计');
R.setExempt(() => true);
R.rebuild();
ok(R.count('T04', 90, '20261030') === 0, '全部 exempt 后 T04 归零');
R.setExempt(null);

console.log('\n[7] 回填：从 guanzhu_case_001..003 重建');
R.rebuild();
ok(R.count('T04', 90, '20261030') === 3, `回填后 T04 仍 3 天（实际 ${R.count('T04', 90, '20261030')}）`);
ok(R.ruleStats('20261030').T04.triggerDays === 3, '回填后 ruleStats.triggerDays=3');

console.log('\n[8] tk6 稳定性');
ok(R.tk6(L('2026-10-24', '10:00', '乙', '买', 20, 100, 'T04', '违规'))
   === R.tk6(L('20261024', '100000', '乙', '买', 20.000, 100, 'T04', '违规')),
   '不同日期/时间写法归一后 tk6 相同');

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
