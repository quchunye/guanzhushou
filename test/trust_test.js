// trust_test.js —— 批次 D 验收（node test/trust_test.js）
// 17：13 条规则各一行算式，且 lhs/rhs 能用原始成交复算
// 18：TextIn bbox → 匹配到该笔文字坐标；无坐标 → 降级"打开原图"并标 partial
// 19：标"计划内"后原 flag 保留、复发计数确实减一
// 20：T01+T02 / T05+T09 / T06+T08 冲突只在提示层
// 21：规则保存留痕、同参数不重复留痕、按版本分段并提示"前后不可比"
'use strict';
const assert = require('assert');
const { analyze } = require('../server/rules');
const T = require('../public/features/trust');
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
T.configure({ storage, recur: R });

const t = (date, time, side, name, price, qty, code = '') => ({ date, time, side, name, code, price, qty });
const cfg = (rules, capital = null) => ({ rules: rules.map(([templateId, params]) => ({ templateId, params })), capital });
const run = (trades, rules, capital) => analyze(trades, cfg(rules, capital), 'D-TEST');

function cmp(l, r, op) {
  return op === '<' ? l < r : op === '>' ? l > r : op === '>=' ? l >= r : op === '<=' ? l <= r : false;
}
const DAY = '2026-10-20';

// ---------------- 17 判定解释器 ----------------
console.log('\n[17] 13 条规则算式可复算');
const checks = [];
function checkFormula(label, e, expect) {
  ok(!!e, label + ' 有算式');
  if (!e) return;
  ok(e.ruleId === expect.id, label + ' 规则编号=' + expect.id);
  ok(/→/.test(e.text), label + ' 算式以 → 结尾（' + e.text + '）');
  if (expect.op) {
    ok(e.op === expect.op, label + ' 运算 ' + expect.op);
    ok(Math.abs(e.lhs - expect.lhs) < 1e-6, label + ' 左侧 ' + expect.lhs + '（实际 ' + e.lhs + '）');
    ok(Math.abs(e.rhs - expect.rhs) < 1e-6, label + ' 右侧 ' + expect.rhs + '（实际 ' + e.rhs + '）');
    ok(cmp(e.lhs, e.rhs, e.op) === true, label + ' 关系式成立=可复算');
  }
  ok(e.triggered === true, label + ' triggered=true');
  checks.push(label);
}

// T01
let v = run([t(DAY, '09:35', '买', '甲', 10, 100)], [['T01', { waitMin: 30 }]]);
checkFormula('T01', T.evalFormula('T01', v.lines[0], v), { id: 'T01', op: '<', lhs: 575, rhs: 600 });
ok(/09:30 \+ 30 分/.test(T.evalFormula('T01', v.lines[0], v).text), 'T01 算式写明 09:30 + 30 分');

// T02
v = run([t(DAY, '14:45', '买', '甲', 10, 100)], [['T02', { endMin: 30 }]]);
checkFormula('T02', T.evalFormula('T02', v.lines[0], v), { id: 'T02', op: '>=', lhs: 885, rhs: 870 });
ok(/15:00 − 30 分/.test(T.evalFormula('T02', v.lines[0], v).text), 'T02 算式写明 15:00 − 30 分');

// T03
v = run([t(DAY, '09:40', '买', '甲', 12, 3000), t(DAY, '10:10', '买', '甲', 11, 1000)], [['T03', { windowMin: 30 }]]);
checkFormula('T03', T.evalFormula('T03', v.lines[0], v), { id: 'T03', op: '>=', lhs: 12, rhs: 12 });
ok(/≤ 10:00/.test(T.evalFormula('T03', v.lines[0], v).text), 'T03 算式含窗口上限 10:00');

// T04
v = run([t(DAY, '10:00', '买', '甲', 12.14, 1000), t(DAY, '10:30', '买', '甲', 11.8, 1000)], [['T04', { tolPct: 0 }]]);
checkFormula('T04', T.evalFormula('T04', v.lines[1], v), { id: 'T04', op: '<', lhs: 11.8, rhs: 12.14 });
ok(/11\.80 < 12\.14 × \(1 − 0%\) = 12\.14/.test(T.evalFormula('T04', v.lines[1], v).text),
   'T04 算式形如 11.80 < 12.14 × (1 − 0%) = 12.14');
const hT04 = T.renderLineExtra(v.lines[1], v, { imageUrl: null });
ok(/class="tr-var"/.test(hT04) && /data-tr-idx="0"/.test(hT04), 'T04 的首笔价可点回第 1 笔成交');
ok(/data-tr-exempt="1"/.test(hT04) && /partial/.test(hT04), 'lineExtra 带「计划内」按钮且无原图时标 partial');

// T05
v = run([t(DAY, '10:00', '买', '甲', 10, 6000)], [['T05', { maxPct: 50 }]], 100000);
checkFormula('T05', T.evalFormula('T05', v.lines[0], v), { id: 'T05', op: '>', lhs: 60000, rhs: 50000 });
ok(/账户资金/.test(T.evalFormula('T05', v.lines[0], v).text), 'T05 算式标明口径=账户资金');

// T06
v = run([1, 2, 3, 4].map(n => t(DAY, `10:0${n}`, '买', '甲', 10, 100)), [['T06', { maxBuys: 3 }]]);
checkFormula('T06', T.evalFormula('T06', v.lines[3], v), { id: 'T06', op: '>', lhs: 4, rhs: 3 });

// T07
v = run([
  t(DAY, '09:40', '买', '甲', 10, 100), t(DAY, '10:00', '卖', '甲', 11, 100),
  t(DAY, '10:20', '买', '甲', 10, 100), t(DAY, '10:40', '卖', '甲', 11, 100),
  t(DAY, '11:00', '买', '甲', 10, 100), t(DAY, '11:20', '卖', '甲', 11, 100),
], [['T07', {}]]);
checkFormula('T07', T.evalFormula('T07', v.lines[5], v), { id: 'T07', op: '>=', lhs: 3, rhs: 2 });

// T08
v = run(['甲', '乙', '丙', '丁', '戊', '己'].map((n, i) => t(DAY, `10:0${i}`, '买', n, 10, 100)), [['T08', { maxSymbols: 5 }]]);
checkFormula('T08', T.evalFormula('T08', v.lines[5], v), { id: 'T08', op: '>', lhs: 6, rhs: 5 });

// T09
v = run([t(DAY, '10:00', '买', '甲', 10, 3000), t(DAY, '10:30', '买', '甲', 10, 3000)], [['T09', { maxPct: 50 }]], 100000);
checkFormula('T09', T.evalFormula('T09', v.lines[1], v), { id: 'T09', op: '>=', lhs: 60000, rhs: 50000 });

// T10
v = run([t(DAY, '10:00', '买', '甲', 10, 600), t(DAY, '10:30', '买', '乙', 10, 600)], [['T10', { maxPct: 30 }]], 40000);
checkFormula('T10', T.evalFormula('T10', v.lines[1], v), { id: 'T10', op: '>=', lhs: 12000, rhs: 12000 });

// T11（日级）
v = run([t(DAY, '10:00', '买', '甲', 10, 1000), t(DAY, '14:00', '卖', '甲', 8.5, 1000)], [['T11', { maxPct: 2 }]], 50000);
const chk11 = v.day_checks.find(d => d.rule === 'T11');
checkFormula('T11', T.evalFormula('T11', null, v, chk11), { id: 'T11', op: '>', lhs: 1500, rhs: 1000 });
ok(/当日规则算式/.test(T.renderReportBottom(v, {})) || T.renderReportBottom(v, {}).indexOf('T11') >= 0,
   'reportBottom 给日级规则 T11 一行算式');

// T12（存疑）
v = run([t(DAY, '10:00', '买', '甲', 10, 100), t(DAY, '14:00', '卖', '甲', 11, 100)], [['T12', {}]]);
const chk12 = v.suspects[0];
const e12 = T.evalFormula('T12', null, v, chk12);
ok(!!e12 && /存疑/.test(e12.text) && !/触发/.test(e12.text), 'T12 算式标存疑、不写成触发');
ok(e12 && e12.triggered === true, 'T12 triggered=true（存疑成立，但不算违规）');
checks.push('T12');

// T13
v = run([t(DAY, '10:00', '买', '*ST甲', 10, 100)], [['T13', {}]]);
checkFormula('T13', T.evalFormula('T13', v.lines[0], v), { id: 'T13' });
ok(/ST/.test(T.evalFormula('T13', v.lines[0], v).text), 'T13 算式写明名称含 ST');

ok(checks.length === 13, '13 条规则全部覆盖（实际 ' + checks.length + ' 条）');

// 全部 13 条拼在一起逐条复算（防某条漏写）
const ids = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13'];
ok(ids.every(id => checks.some(c => c.indexOf(id) === 0)), '规则编号 T01–T13 无缺号');

// ---------------- 18 原图定位 ----------------
console.log('\n[18] 原图定位 / 降级');
const boxes = {
  w: 1000, h: 2000,
  items: [
    { text: '09:34:55', nx: 0.10, ny: 0.200, nw: 0.08, nh: 0.012 },
    { text: '证券买入', nx: 0.20, ny: 0.200, nw: 0.08, nh: 0.012 },
    { text: '13.69', nx: 0.42, ny: 0.200, nw: 0.06, nh: 0.012 },
    { text: '900', nx: 0.50, ny: 0.200, nw: 0.05, nh: 0.012 },
    { text: '万字头标题', nx: 0.30, ny: 0.010, nw: 0.20, nh: 0.015 },
  ],
};
T.configure({ storage, recur: R, boxes });
const bLine = { idx: 0, date: '20261020', time: '09:34', side: '买', name: '示例材料', code: '600847', price: 13.69, qty: 900, flag: '违规', rule: 'T04' };
const bV = { case_no: 'D-BBOX', rules: [{ id: 'T04', params: { tolPct: 0 } }], capital: null, lines: [bLine] };
const mb = T.matchBox(bLine, bV);
ok(!!mb, '有 bbox 时能匹配到该笔文字坐标');
ok(mb && Math.abs(mb.ny - 0.200) < 0.001 && mb.nw > 0.06, '匹配框落在同一行并覆盖时间+价格（' + JSON.stringify(mb && [mb.nx, mb.ny, mb.nw, mb.nh]) + '）');
const hBox = T.renderLineExtra(bLine, bV, { imageUrl: 'blob:x' });
ok(/原图定位/.test(hBox) && /data-tr-bbox="0"/.test(hBox), '有坐标时 lineExtra 显示「原图定位」');
T.configure({ storage, recur: R, boxes: null });
const hNo = T.renderLineExtra(bLine, bV, { imageUrl: 'blob:x' });
ok(/打开原图/.test(hNo) && /OCR 未返回坐标/.test(hNo) && /partial/.test(hNo), '无坐标时降级「打开原图」并标 partial');
const hNoImg = T.renderLineExtra(bLine, bV, { imageUrl: null });
ok(/本次无原图可对照/.test(hNoImg), '没有原图时如实标注，不伪造坐标');

// ---------------- 19 申诉例外 ----------------
console.log('\n[19] 计划内标记 → 复发计数减一');
R.reset();
const v19 = {
  case_no: 'D-19',
  rules: [{ id: 'T04', params: { tolPct: 0 } }],
  capital: null,
  lines: [{ idx: 0, date: '20261020', time: '10:00', side: '买', name: '甲', code: '', price: 12, qty: 100, flag: '违规', rule: 'T04', reason: '' }],
  day_checks: [], suspects: [],
};
storage.setItem('guanzhu_case_001', JSON.stringify({ ts: '2026-10-20T07:00:00Z', trades: [], verdict: v19 }));
storage.setItem('guanzhu_case_seq', '1');
R.ingest(v19, 'case_001');
ok(R.count('T04', 90, '20261020') === 1, '标记前 T04 触发日=1');
const r19 = T.toggleExempt(v19.lines[0]);
ok(r19.exempt === true, '第一次点击=标为计划内');
ok(R.count('T04', 90, '20261020') === 0, '标记后复发计数确实减一（1→0）');
ok(v19.lines[0].flag === '违规', '原 flag 保留，判定本身不改');
ok(JSON.parse(storage.getItem('guanzhu_case_001')).verdict.lines[0].flag === '违规', '落盘的案例原 flag 仍为违规');
const m19 = JSON.parse(storage.getItem(T.EXEMPT_KEY));
ok(m19[R.tk6(v19.lines[0])] && m19[R.tk6(v19.lines[0])].T04 === true, 'guanzhu_exempt_v1 结构 {tk6:{T04:true}}');
ok(T.exemptSummary(v19) === '1 笔越线，其中 1 笔你标为计划内', '报告话术：' + T.exemptSummary(v19));
ok(/1 笔你标为计划内/.test(T.renderReportBottom(v19, {})), 'reportBottom 渲染出计划内笔数');
const r19b = T.toggleExempt(v19.lines[0]);
ok(r19b.exempt === false, '第二次点击=撤销');
ok(R.count('T04', 90, '20261020') === 1, '撤销后复发计数回到 1');
ok(!JSON.parse(storage.getItem(T.EXEMPT_KEY))[R.tk6(v19.lines[0])], '撤销后豁免记录清空');

// 多规则同一笔：T03+T04 一次标两条
const v19c = {
  case_no: 'D-19c', rules: [], capital: null,
  lines: [{ idx: 0, date: '20261021', time: '09:40', side: '买', name: '乙', code: '', price: 12, qty: 100, flag: '违规', rule: 'T03+T04', reason: '' }],
  day_checks: [], suspects: [],
};
const rc = T.toggleExempt(v19c.lines[0]);
ok(rc.ids.length === 2 && rc.ids.every(id => rc.map[rc.key][id]), '同一笔命中两条时两条一起标');
ok(T.exemptSummary(v19c) === '1 笔越线，其中 1 笔你标为计划内', '多规则笔也只算 1 笔');
T.toggleExempt(v19c.lines[0]); // 还原，避免影响后续

// ---------------- 20 规则冲突 ----------------
console.log('\n[20] 规则冲突提示（不改参数）');
const c20a = { rules: [{ templateId: 'T01', params: { waitMin: 150 } }, { templateId: 'T02', params: { endMin: 100 } }] };
const f20a = T.detectConflicts(c20a);
ok(f20a.length === 1 && /> 240 分/.test(f20a[0].text), 'T01+T02 合计 250>240 分提示');
ok(c20a.rules[0].params.waitMin === 150, '只提示，不改参数');
const c20b = { rules: [{ templateId: 'T01', params: { waitMin: 120 } }, { templateId: 'T02', params: { endMin: 60 } }] };
const f20b = T.detectConflicts(c20b);
ok(f20b.length === 1 && /180 分/.test(f20b[0].text), 'T01+T02 达模板上限 180 分也会提示覆盖过大');
const f20c = T.detectConflicts({ rules: [{ templateId: 'T05', params: { maxPct: 50 } }, { templateId: 'T09', params: { maxPct: 45 } }] });
ok(f20c.length === 1 && /相差 5 个百分点/.test(f20c[0].text), 'T05+T09 参数接近提示');
const f20d = T.detectConflicts({ rules: [{ templateId: 'T06', params: { maxBuys: 3 } }, { templateId: 'T08', params: { maxSymbols: 2 } }] });
ok(f20d.length === 1 && /只数先触发/.test(f20d[0].text), 'T06+T08 互掩提示（只数上限更低）');
const f20e = T.detectConflicts({ rules: [{ templateId: 'T06', params: { maxBuys: 2 } }, { templateId: 'T08', params: { maxSymbols: 5 } }] });
ok(f20e.length === 1 && /笔数先触发/.test(f20e[0].text), 'T06+T08 互掩提示（笔数上限更低）');
ok(T.renderRulesBottom(c20a).indexOf('规则组合提示') >= 0, 'rulesBottom 渲染冲突块');
ok(T.renderRulesBottom(null) === '', '没有规则配置时不渲染（默认规则无这几条）');

// ---------------- 21 规则版本 ----------------
console.log('\n[21] 规则版本留痕 / 分段');
storage.removeItem(T.HIST_KEY);
const h1 = T.appendRulesHistory({ rules: [{ templateId: 'T04', params: { tolPct: 0 } }], capital: null });
ok(h1.added === true && h1.hist.length === 1, '第一次保存留痕 1 条');
const h1b = T.appendRulesHistory({ rules: [{ templateId: 'T04', params: { tolPct: 0 } }], capital: null });
ok(h1b.added === false && h1b.hist.length === 1, '同参数再保存不重复留痕');
const h2 = T.appendRulesHistory({ rules: [{ templateId: 'T04', params: { tolPct: 2 } }], capital: null });
ok(h2.added === true && h2.hist.length === 2, '改参数后追加第 2 版');
ok(h2.hist[1].hash !== h2.hist[0].hash && h2.hist[1].savedAt, '每条留痕带 savedAt + hash');
ok(JSON.parse(storage.getItem(T.HIST_KEY)).length === 2, 'guanzhu_rules_hist_v1 落盘 2 条');

const hist = [
  { savedAt: '2026-10-01T00:00:00.000Z', hash: 'a', rules: [] },
  { savedAt: '2026-10-15T00:00:00.000Z', hash: 'b', rules: [] },
];
const cases = [
  { ts: '2026-09-20T00:00:00.000Z', verdict: { lines: [{ flag: '违规' }, { flag: '合规' }] } },
  { ts: '2026-10-05T00:00:00.000Z', verdict: { lines: [{ flag: '违规' }] } },
  { ts: '2026-10-05T01:00:00.000Z', verdict: { lines: [{ flag: '违规' }, { flag: '违规' }] } },
  { ts: '2026-10-20T00:00:00.000Z', verdict: { lines: [{ flag: '合规' }] } },
];
const segs = T.versionSegments(hist, cases);
ok(segs.length === 3, '按版本分成 3 段（含未记录段）');
const s0 = segs.find(s => s.label === '版本未记录');
const s1 = segs.find(s => s.label === '第 1 版');
const s2 = segs.find(s => s.label === '第 2 版');
ok(s0 && s0.cases === 1, '第 1 次保存前的案例标「版本未记录」');
ok(s1 && s1.cases === 2 && s1.violationLines === 3, '第 1 版 2 次复盘 / 3 笔违规');
ok(s2 && s2.cases === 1 && s2.violationLines === 0, '第 2 版 1 次复盘 / 0 笔违规');

storage.setItem(T.HIST_KEY, JSON.stringify(hist));
const v21 = { case_no: 'D-21', rules: [], capital: null, lines: [], day_checks: [], suspects: [] };
const b21 = T.renderReportBottom(v21, {});
ok(/规则版本/.test(b21) && /第 <b>2<\/b> 版/.test(b21), 'reportBottom 显示当前第 2 版');
ok(/按版本分段/.test(b21) && /前后统计不可比/.test(b21), 'reportBottom 分段并提示「前后不可比」');

// ---------------- 结构 ----------
console.log('\n[22] 契约与权限边界');
ok(T.EXEMPT_KEY === 'guanzhu_exempt_v1', '豁免 key 符合 §2.1');
ok(T.HIST_KEY === 'guanzhu_rules_hist_v1', '版本 key 符合 §2.1');
ok(T.tk6({ date: '2026-10-20', time: '9:34', code: '600847', side: '买', price: 13.69, qty: 900 })
   === R.tk6({ date: '2026-10-20', time: '9:34', code: '600847', side: '买', price: 13.69, qty: 900 }),
   'trust 内 tk6 与 recur.tk6 一致');

// ---------------- 18b 同行组合匹配（ST-1 增量） ----------------
console.log('\n[18b] 同行组合匹配 / 开关 / 不跨行误配');
// 时间框与价格框不同行（相邻行）、且时间是全角冒号（TextIn 真实格式）
const rowBoxes = {
  w: 1080, h: 2081,
  items: [
    { text: '3.700', nx: 0.451, ny: 0.854, nw: 0.106, nh: 0.0235 },
    { text: '买 20261019 09：30：21', nx: 0.043, ny: 0.872, nw: 0.309, nh: 0.0192 },
    { text: '4100', nx: 0.673, ny: 0.8554, nw: 0.0935, nh: 0.0202 },
    { text: '示例建设', nx: 0.041, ny: 0.8409, nw: 0.176, nh: 0.025 },
  ],
};
const rowLine = { idx: 0, date: '2026-10-19', time: '09:30', side: '买', name: '示例建设', price: 3.7, qty: 4100, flag: '违规', rule: 'T04' };
const rowV = { case_no: 'D-ROW', rules: [{ id: 'T04', params: { tolPct: 0 } }], capital: null, lines: [rowLine] };
T.configure({ storage, recur: R, boxes: rowBoxes, rowMatch: true });
const rm = T.matchBox(rowLine, rowV);
ok(!!rm, '时间与价格不同行时仍能匹配（全角冒号已归一半角）');
ok(rm && /09：30：21/.test(rm.text), '并集确实包含时间框（不是只拿价格+名称）');
ok(rm && Math.abs(rm.ny - 0.854) < 0.001 && rm.nh > 0.03, '并集从价格行顶端覆盖到时间行底端');
ok(rm && rm.nx < 0.05 && rm.nw > 0.35, '并集横向覆盖时间列到价格列');
const rowHtml = T.renderLineExtra(rowLine, rowV, { imageUrl: 'blob:x' });
ok(/原图定位/.test(rowHtml) && !/partial/.test(rowHtml), '不同行组合命中后显示「原图定位」，不再 partial');

// 只有时间框：定位不到价格 → 按未匹配处理，仍 partial
const onlyTimeBoxes = { w: 1080, h: 2081, items: [{ text: '买 20261019 10：05：10', nx: 0.043, ny: 0.642, nw: 0.312, nh: 0.0187 }] };
const onlyLine = { idx: 0, date: '2026-10-19', time: '10:05', side: '买', name: '示例建设', price: 3.53, qty: 700, flag: '违规', rule: 'T04' };
const onlyV = { case_no: 'D-ONLY', rules: [{ id: 'T04', params: { tolPct: 0 } }], capital: null, lines: [onlyLine] };
T.configure({ storage, recur: R, boxes: onlyTimeBoxes });
ok(T.matchBox(onlyLine, onlyV) === null, '只有时间框时不直配（不伪造成交位置）');
const onlyHtml = T.renderLineExtra(onlyLine, onlyV, { imageUrl: 'blob:x' });
ok(/打开原图/.test(onlyHtml) && /partial/.test(onlyHtml), '只有时间框的报告行仍降级 partial');

// 同值价格在远处：不跨行用「全文任意一个同值框」
const farBoxes = {
  w: 1080, h: 2081,
  items: [
    { text: '3.700', nx: 0.451, ny: 0.100, nw: 0.106, nh: 0.0235 },
    { text: '买 20261019 09：30：21', nx: 0.043, ny: 0.872, nw: 0.309, nh: 0.0192 },
  ],
};
T.configure({ storage, recur: R, boxes: farBoxes });
ok(T.matchBox(rowLine, rowV) === null, '远处同值价格框不被拉进本笔（不跨行误配）');

// 同一分钟、同价的重复成交：用数量框同行二次区分，两笔不会都指同一行
const twinBoxes = {
  w: 1080, h: 2081,
  items: [
    { text: '3.540', nx: 0.451, ny: 0.3186, nw: 0.106, nh: 0.0226 },
    { text: '100', nx: 0.694, ny: 0.3186, nw: 0.074, nh: 0.0226 },
    { text: '买 20261019 10：13：06', nx: 0.043, ny: 0.3354, nw: 0.312, nh: 0.0187 },
    { text: '3.540', nx: 0.453, ny: 0.396, nw: 0.102, nh: 0.0207 },
    { text: '300', nx: 0.694, ny: 0.396, nw: 0.072, nh: 0.0207 },
    { text: '买 20261019 10：13：02', nx: 0.043, ny: 0.4128, nw: 0.312, nh: 0.0183 },
  ],
};
T.configure({ storage, recur: R, boxes: twinBoxes });
const twinA = { idx: 0, time: '10:13', name: '示例建设', price: 3.54, qty: 100, flag: '违规', rule: 'T04' };
const twinB = { idx: 1, time: '10:13', name: '示例建设', price: 3.54, qty: 300, flag: '违规', rule: 'T04' };
const twinV = { case_no: 'D-TWIN', rules: [], capital: null, lines: [twinA, twinB] };
const tA = T.matchBox(twinA, twinV);
const tB = T.matchBox(twinB, twinV);
ok(!!tA && !!tB && tA.ny !== tB.ny, '同一分钟同价两笔各自匹配到不同行（' + (tA && tA.ny) + ' / ' + (tB && tB.ny) + '）');

// 开关可关闭：关闭后回到改前单框规则（只有时间框也会返回时间位置，便于回滚）
T.configure({ storage, recur: R, boxes: onlyTimeBoxes, rowMatch: false });
ok(!!T.matchBox(onlyLine, onlyV), 'rowMatch=false 时旧单框规则仍可用（回滚路径）');
T.configure({ storage, recur: R, boxes: null, rowMatch: true });

// ---------------- 22 窗口越线（按成交日；只展示与事件） ----------------
console.log('\n[22] 窗口越线：成交日距离');
{
  const CAL = require('../public/trading_calendar_2026.json');
  const DAYS = CAL.tradingDays.slice();
  const i0 = DAYS.indexOf('2026-10-20');
  const D0 = DAYS[i0], D3 = DAYS[i0 + 3], D8 = DAYS[i0 + 8], D25 = DAYS[i0 + 25];
  ok(i0 >= 0 && !!D3 && !!D8 && !!D25, '日历里能取到 0/3/8/25 个成交日样本');
  if (i0 >= 0 && D25) {
    const pad = (n) => ('00' + n).slice(-3);
    function ln(idx, date, rule, side, account, code) {
      return { idx: idx, flag: '违规', side: side || '买', date: date, time: '093000',
        code: code || '600000', name: code || '某股', price: 10, qty: 100, account: account || '', rule: rule };
    }
    function seed(st, i, lines, extra) {
      const v = Object.assign({ case_no: 'case_' + pad(i), rules: [], capital: null, lines: lines,
        day_checks: [], suspects: [] }, extra || {});
      st.setItem('guanzhu_case_' + pad(i), JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', trades: [], verdict: v }));
      st.setItem('guanzhu_case_seq', String(i));
      return v;
    }
    function mapOf(st, v) { T.configure({ storage: st }); return T.windowMapFor(v); }

    // 22a 隔 3 个成交日 → 5 日命中
    let s = memStorage();
    const a1 = seed(s, 1, [ln(0, D0, 'T04')]);
    const a2 = seed(s, 2, [ln(0, D3, 'T04')]);
    let h = mapOf(s, a2)[0];
    ok(h && h.hit === 'w5' && T.fmtDay(h.prev) === D0, '隔 3 个成交日 = 5 日命中（' + (h && h.prev) + '）');
    ok(T.spanDays(D0, D3) === 3, '成交日距离按日历数 = 3（实际 ' + T.spanDays(D0, D3) + '）');

    // 22b 隔 8 个成交日 → 5 日不中 / 20 日命中
    s = memStorage();
    seed(s, 1, [ln(0, D0, 'T04')]);
    const b2 = seed(s, 2, [ln(0, D8, 'T04')]);
    h = mapOf(s, b2)[0];
    ok(h && h.hit === 'w20' && T.fmtDay(h.prev) === D0, '隔 8 个成交日 = 20 日命中、5 日不中');

    // 22c 隔 25 个成交日 → 两档都不中
    s = memStorage();
    seed(s, 1, [ln(0, D0, 'T04')]);
    const c2 = seed(s, 2, [ln(0, D25, 'T04')]);
    h = mapOf(s, c2)[0];
    ok(!h, '隔 25 个成交日 = 两档都不中');

    // 22d 不同规则不命中
    s = memStorage();
    seed(s, 1, [ln(0, D0, 'T04')]);
    const d2 = seed(s, 2, [ln(0, D3, 'T05')]);
    h = mapOf(s, d2)[0];
    ok(!h, '不同规则不命中');

    // 22e 计划内不计
    s = memStorage();
    const e1 = seed(s, 1, [ln(0, D0, 'T04')]);
    s.setItem('guanzhu_exempt_v1', JSON.stringify({ [R.tk6(e1.lines[0])]: { T04: true } }));
    const e2 = seed(s, 2, [ln(0, D3, 'T04')]);
    h = mapOf(s, e2)[0];
    ok(!h, '勾了计划内的那笔不进历史链 → 不命中');
    ok(Object.keys((T.buildChain().rules.T04 || { days: {} }).days).length === 1,
      '计划内那笔不进链，只剩当前这一笔（1 天）');

    // 22f suspects / 合规行不计：夹一笔合规，距离仍按 8 个成交日算 20 日
    s = memStorage();
    seed(s, 1, [ln(0, D0, 'T04')]);
    seed(s, 2, [ln(0, D3, 'T04', '买')], {
      suspects: [{ code: '600000', account: '', text: '疑似同规则再次触发', rule: 'T04' }],
    });
    s.setItem('guanzhu_case_002', JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', trades: [], verdict: {
      case_no: 'case_002', rules: [], capital: null, day_checks: [],
      suspects: [{ code: '600000', account: '', text: '疑似', rule: 'T04' }],
      lines: [{ idx: 0, flag: '合规', side: '买', date: D3, time: '093000', code: '600000', name: '某股', price: 10, qty: 100, account: '', rule: 'T04' }],
    } }));
    const f3 = seed(s, 3, [ln(0, D8, 'T04')]);
    h = mapOf(s, f3)[0];
    ok(h && h.hit === 'w20', 'suspects / 合规行不进链 → 按 8 个成交日算 20 日');
    ok(!(T.buildChain().rules.T04.days[D3]), '合规行与 suspect 都没进历史链');

    // 22g 同日多行只算 1 天
    s = memStorage();
    seed(s, 1, [ln(0, D0, 'T04', '买', '', '600000'), ln(1, D0, 'T04', '买', '', '000001')]);
    const g2 = seed(s, 2, [ln(0, D3, 'T04')]);
    h = mapOf(s, g2)[0];
    ok(Object.keys(T.buildChain().rules.T04.days).length === 2, '同日 2 行合并为 1 个越线日（链里共 2 天）');
    ok(h && h.hit === 'w5' && T.fmtDay(h.prev) === D0, '同日多行不影响上一次越线日');

    // 22h 跨账户算同一条链
    s = memStorage();
    seed(s, 1, [ln(0, D0, 'T04', '买', 'A')]);
    const h2 = seed(s, 2, [ln(0, D3, 'T04', '买', 'B')]);
    h = mapOf(s, h2)[0];
    ok(h && h.hit === 'w5', '跨账户同规则仍算同一条历史链');

    // 22i 2027 已进日历：按成交日数；2028 缺年才退化为自然日
    s = memStorage();
    seed(s, 1, [ln(0, '20270104', 'T04')]);
    const i2 = seed(s, 2, [ln(0, '20270107', 'T04')]);
    h = mapOf(s, i2)[0];
    ok(h && h.hit === 'w5', '2027 已进日历：01-04 → 01-07 隔 3 个成交日 = 5 日命中');
    ok(T.spanDays('20270104', '20270107') === 3, '2027 成交日距离按日历数 = 3（实际 ' + T.spanDays('20270104', '20270107') + '）');
    s = memStorage();
    seed(s, 1, [ln(0, '20270104', 'T04')]);
    const i3 = seed(s, 2, [ln(0, '20270125', 'T04')]);
    h = mapOf(s, i3)[0];
    ok(T.spanDays('20270104', '20270125') === 15, '2027 01-04 → 01-25 隔 15 个成交日（自然日 21 会漏算）');
    ok(h && h.hit === 'w20' && h.n === 15, '2027 已进日历：隔 15 个成交日 = 20 日命中');
    s = memStorage();
    seed(s, 1, [ln(0, '20280103', 'T04')]);
    const i4 = seed(s, 2, [ln(0, '20280107', 'T04')]);
    h = mapOf(s, i4)[0];
    ok(h && h.hit === 'w5', '2028 不在日历 → 自然日 4 天 = 5 日命中（缺年降级仍在）');
    s = memStorage();
    seed(s, 1, [ln(0, '20280103', 'T04')]);
    const i5 = seed(s, 2, [ln(0, '20280124', 'T04')]);
    h = mapOf(s, i5)[0];
    ok(!h, '2028 自然日 21 天 → 20 日也不中');

    // 22j 徽标：只展开上一次越线日期，不出现均线 / 成交内容
    s = memStorage();
    seed(s, 1, [ln(0, D0, 'T13', '买', '', 'ST甲')]);
    const j2 = seed(s, 2, [ln(0, D3, 'T13', '买', '', 'ST乙')], { rules: [{ templateId: 'T13', params: {} }] });
    T.configure({ storage: s, recur: R });
    const html = T.renderLineExtra(j2.lines[0], j2);
    ok(html.indexOf('同一规则 5 个成交日内再次触发') >= 0, '徽标钩在违规行上并写明 5 个成交日');
    ok(html.indexOf('上一次越线日期：' + D0) >= 0, '点开内容只有上一次越线日期');
    ok(html.indexOf('均线') < 0 && html.indexOf('MA5') < 0 && html.indexOf('MA20') < 0, '不出现均线 / MA5 / MA20');
    const note = html.slice(html.indexOf('tr-win-note'));
    ok(note.indexOf('10.000') < 0 && note.indexOf('|100|') < 0, '展开区不带价格 / 数量');

    // 22k 认下 → 只落 ev:ack_w5 / ack_w20 指纹（图鉴模块不在本仓，这里用同契约的最小桩）
    const hashFp = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(16); };
    const C = {
      KEY: 'guanzhu_collection_v1',
      record(kind, o) {
        o = o || {};
        const store = o.storage;
        let st = null;
        try { st = JSON.parse(store.getItem(C.KEY)); } catch (e) { st = null; }
        if (!st || typeof st !== 'object') st = {};
        st.behaviors = st.behaviors || {};
        st.behaviors['ev:' + kind + ':' + hashFp(String(o.fp || ''))] = { n: 1 };
        store.setItem(C.KEY, JSON.stringify(st));
      },
    };
    global.PanjiCollection = C;
    s = memStorage();
    seed(s, 1, [ln(0, D0, 'T04')]);
    const k2 = seed(s, 2, [ln(0, D3, 'T04')]);
    T.configure({ storage: s, recur: R });
    const n5 = T.noteAck({ key: R.tk6(k2.lines[0]), rule: 'T04' });
    ok(n5 && n5.hit === 'w5', '认下 5 日越线买入 → 记 ack_w5');
    const stt = JSON.parse(s.getItem(C.KEY));
    const keys = Object.keys(stt.behaviors);
    ok(keys.some((k) => k.indexOf('ev:ack_w5:') === 0), '落盘键是 ev:ack_w5:*');
    ok(!keys.some((k) => k.indexOf('600000') >= 0 || k.indexOf('10.000') >= 0), '落盘不含代码 / 价格');
    T.noteAck({ key: R.tk6(k2.lines[0]), rule: 'T04' });
    ok(Object.keys(JSON.parse(s.getItem(C.KEY)).behaviors).length === keys.length, '同一笔重复认下不新增第二条事件');
    const sell = ln(0, D3, 'T04', '卖');
    ok(T.noteAck({ key: R.tk6(sell), rule: 'T04' }) === null, '卖出行不记窗口事件（口径是越线买入）');
  }
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
