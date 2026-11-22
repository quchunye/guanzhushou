// 批次 B 日频动作 7–11 测试（node test/intent_test.js）
// 覆盖：选规顺序与默认不选、次日只结算一条、盘前一句话 40 字与原文回引、
//       5 个固定理由标签与 FIFO 结局、止损已登记/未登记、情绪当天一次与样本 <30 不分组、★11 点击区域。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const I = require('../public/features/intent');
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
function reset() { Object.keys(storage._m).forEach(k => delete storage._m[k]); }
function put(key, val) { storage.setItem(key, JSON.stringify(val)); }

let violationDates = ['20261027', '20261028'];
const recurStub = {
  tk6: R.tk6,
  top: () => [{ ruleId: 'T04', count: violationDates.length, dates: violationDates.slice(), cases: 0 }],
  ruleStats: () => ({
    T04: { triggerDays: 3, last: '20261028', sinceLast: 2 },
    T03: { triggerDays: 1, last: '20261026', sinceLast: 4 },
  }),
  _state: () => ({ v: 1, rules: { T04: { days: { 20261027: {}, 20261028: {} } } } }),
};

const ALL_ON = { focus: true, note: true, reason: true, stop: true, mood: true };
I.configure({ storage, flags: ALL_ON, recur: recurStub });

const TODAY = I.today8();
const TOMORROW = I.addDays8(TODAY, 1);
const YESTERDAY = I.addDays8(TODAY, -1);

console.log('\n[1] 7 明日一规：只列已勾规则、按 T01→T13 编号排、默认不选');
reset();
put('guanzhu_rules_v1', { rules: [{ templateId: 'T12' }, { templateId: 'T03' }, { templateId: 'T01' }, { templateId: 'T07' }], capital: null });
const state = {
  templates: [
    { id: 'T01', name: '开盘冷静期' }, { id: 'T03', name: '追高' },
    { id: 'T07', name: '反复买卖' }, { id: 'T12', name: '止损预案' },
  ],
};
const html1 = I.renderReportBottom({ rule_stats: [{ id: 'T01', name: '开盘冷静期' }] }, state);
const ids = Array.from(html1.matchAll(/data-pi-focus="([^"]*)"[^>]*aria-pressed="([^"]*)"/g))
  .filter(m => m[1]).map(m => m[1]);
ok(ids.join(',') === 'T01,T03,T07,T12', `选规顺序为 T01,T03,T07,T12（实际 ${ids.join(',')}）`);
ok(!html1.includes('data-pi-focus="T05"'), '未勾选的 T05 不出现在列表里');
ok(I.focusList(['T12', 'T03', 'T01']).join(',') === 'T01,T03,T12', 'focusList 按编号升序');
ok(I.getFocus() === null, '默认不选：没有存过 focus');
ok(/data-pi-focus="T01"[^>]*aria-pressed="false"/.test(html1), 'T01 默认 aria-pressed=false');
ok(/data-pi-focus=""[^>]*aria-pressed="true"/.test(html1), '“不选”是当前唯一选中项');

console.log('\n[2] 7 选一条 → 存 guanzhu_focus_v1 → 可清除');
reset();
I.setFocus('T04', TOMORROW);
const f = I.getFocus();
ok(f && f.ruleId === 'T04' && f.date === TOMORROW, `存为 {date:${TOMORROW}, ruleId:T04}`);
const html2 = I.renderReportBottom({}, { defaultRules: [{ templateId: 'T04' }] });
ok(html2.includes('已存：T04'), '报告末尾回显已选规则');
ok(/data-pi-focus="T04"[^>]*aria-pressed="true"/.test(html2), 'T04 为选中态');
I.clearFocus();
ok(I.getFocus() === null, '清除后回到默认不选');

console.log('\n[3] 7 次日首屏只结算这一条');
reset();
I.setFocus('T04', TODAY);
const vHit = {
  lines: [
    { idx: 0, date: TODAY, time: '09:35:00', side: '买', name: '甲', code: '600000', price: 10, qty: 100, flag: '违规', rule: 'T04' },
    { idx: 1, date: TODAY, time: '10:00:00', side: '买', name: '乙', code: '600001', price: 20, qty: 100, flag: '违规', rule: 'T03' },
    { idx: 2, date: TODAY, time: '10:05:00', side: '买', name: '乙', code: '600001', price: 21, qty: 100, flag: '合规', rule: 'T04' },
  ],
  day_checks: [],
  rule_stats: [{ id: 'T04', name: '越跌越补', triggered: 1 }],
};
const top1 = I.renderReportTop(vHit);
ok(top1.includes('当日触发 1 笔'), '只结算 T04，不把 T03/合规行算进来');
ok(top1.includes('只结算这一条'), '文案写明只结算这一条');
ok(top1.includes('履约档案：全量触发 3 天'), '履约档案取自 PanjiRecur.ruleStats');
ok(top1.includes('距上次 2 天'), '履约档案带距上次天数');
const s3 = I.settleFocus(vHit, { date: TODAY, ruleId: 'T04' });
ok(s3 && s3.lines === 1 && s3.dayChecks === 0, 'settleFocus 只统计该规则该日违规笔');
const top2 = I.renderReportTop({ lines: [], day_checks: [], rule_stats: [] });
ok(top2.includes('本次档案没有'), '档案不含该日成交时如实写未结算');
const vMiss = { lines: [{ idx: 0, date: TODAY, time: '09:35:00', side: '买', name: '甲', code: '600000', price: 10, qty: 100, flag: '合规', rule: 'T04' }], day_checks: [] };
ok(I.renderReportTop(vMiss).includes('当日未触发该规则'), '该日无违规时写未触发，不写“守住了”之类判断');
I.setFocus('T04', YESTERDAY);
const sWeek = I.settleFocus(vHit, { date: YESTERDAY, ruleId: 'T04' });
ok(sWeek.date === TODAY && sWeek.hasDate && sWeek.lines === 1, '原定日没有成交时，落到之后第一个有成交的复盘日');
ok(I.renderReportTop(vHit).includes('之后第一个有成交的复盘日'), '结算日顺延时如实说明');
I.clearFocus();

console.log('\n[4] 8 盘前一句话：≤40 字、原文回引、不解析');
reset();
ok(I.getNote() === null, '未写过时没有记录');
I.setNote('一'.repeat(45));
ok(Array.from(I.getNote().text).length === 40, '超长截到 40 字');
ok(Array.from(I.clampNote('😀'.repeat(45))).length === 40, '按字符数（不是 UTF-16 码元）截到 40');
I.setNote('今天只看 <b>不动手', YESTERDAY);
const home1 = I.renderHomeTop();
ok(home1.includes('上一份盘前记录'), '次日首屏回引上一份');
ok(home1.includes('&lt;b&gt;') && !home1.includes('<b>不动手'), '原文按文本渲染，不注入 HTML');
const note = I.getNote();
ok(note.date === YESTERDAY && note.text === '今天只看 <b>不动手', '按 {date,text} 原文存储');
ok(I.renderReportTop(vHit).includes('原文回引，不解析、不判定'), '报告里明确不解析、不判定');
I.setNote('两天前的记录', I.addDays8(TODAY, -3));
ok(!I.renderReportTop(vHit).includes('两天前的记录'), '过旧的盘前记录不在报告里回引');

console.log('\n[5] 9 买入理由：5 个固定标签、可跳过');
ok(I.REASON_TAGS.join(',') === '追涨,回踩,消息,补仓,随手', '固定 5 个标签且顺序固定');
const keyA = 'kA';
ok(I.reasonSetKey(keyA, '追涨').ok, '写入标签成功');
ok(I.reasonGetKey(keyA) === '追涨', '读回标签');
ok(I.reasonSetKey(keyA, '').ok && I.reasonGetKey(keyA) === '', '跳过记为空串（不再追问）');
ok(!I.reasonSetKey(keyA, '乱写').ok, '非固定标签被拒绝');

// 图鉴接线：非空标签调 record('reason_tag')；跳过不记；图鉴不在场不抛错
const collCalls = [];
global.PanjiCollection = { record(kind, o) { collCalls.push({ kind: kind, fp: o && o.fp }); } };
I.reasonSetKey('kT1', '回踩');
I.reasonSetKey('kT1', '');          // 明确跳过，不应记
I.reasonSetKey('kT2', '补仓');
ok(collCalls.length === 2 && collCalls.every((c) => c.kind === 'reason_tag'),
  '非空标签记 2 次，跳过不记', String(collCalls.length));
ok(collCalls[0].fp === 'kT1' && collCalls[1].fp === 'kT2', '指纹用买入键（由 collection 哈希后落盘）');
delete global.PanjiCollection;
let collThrew = false;
try { I.reasonSetKey('kX', '追涨'); } catch (e) { collThrew = true; }
ok(!collThrew && I.reasonGetKey('kX') === '追涨', '图鉴不在场：记理由不被采集打断');

console.log('\n[6] 9 本机 FIFO：只按最早买入配对');
const tradesFifo = [
  { date: '20261030', time: '093000', code: '600000', name: '甲', side: '买', price: 10, qty: 100 },
  { date: '20261101', time: '100000', code: '600000', name: '甲', side: '买', price: 11, qty: 100 },
  { date: '20261102', time: '140000', code: '600000', name: '甲', side: '卖', price: 12, qty: 150 },
];
const f6 = I.fifoMatches(tradesFifo);
ok(f6.length === 2, `卖出 150 股拆成 2 个配对（实际 ${f6.length}）`);
ok(f6[0].qty === 100 && f6[0].pnl === 200 && f6[0].holdDays === 3, '第一笔：最早买入 100 股，持有 3 天，盈亏 200');
ok(f6[1].qty === 50 && f6[1].pnl === 50 && f6[1].holdDays === 1, '第二笔：次早买入 50 股，持有 1 天，盈亏 50');
ok(I.median([3, 1]) === 2, '中位数：偶数取中间两笔均值');
ok(I.median([]) === null, '无样本时中位数为 null');

console.log('\n[7] 9 买入理由 × 平仓结局：固定顺序并列，不排序');
reset();
const tradesA = [
  { date: '20261030', time: '100000', code: '600001', name: '甲', side: '买', price: 10, qty: 100 },
  { date: '20261102', time: '140000', code: '600001', name: '甲', side: '卖', price: 9, qty: 100 },
  { date: '20261031', time: '100000', code: '600002', name: '乙', side: '买', price: 11, qty: 100 },
  { date: '20261102', time: '140500', code: '600002', name: '乙', side: '卖', price: 13, qty: 100 },
];
put('guanzhu_ledger', { trades: tradesA, imports: [], dupLog: [] });
I.reasonSet(tradesA[0], '追涨');
I.reasonSet(tradesA[2], '回踩');
const out7 = I.reasonOutcomes(tradesA, JSON.parse(storage.getItem('guanzhu_reason_v1')));
ok(out7.map(x => x.tag).join(',') === '追涨,回踩', '按固定标签顺序（追涨在前），不按盈亏排序');
ok(out7[0].n === 1 && out7[0].medHoldDays === 3 && out7[0].medPnl === -100, '追涨：n=1，中位持有 3 天，盈亏中位 -100');
ok(out7[1].n === 1 && out7[1].medHoldDays === 2 && out7[1].medPnl === 200, '回踩：n=1，中位持有 2 天，盈亏中位 200');
const html7 = I.renderReportBottom(vHit, state);
ok(html7.includes('追涨 · n=1 笔'), '报告给 n');
ok(html7.includes('中位持有 3 天'), '报告给中位持有天数');
ok(html7.includes('已实现盈亏中位数 ¥-100'), '报告给已实现盈亏中位数');
ok(!html7.includes('胜率'), '不写胜率');

console.log('\n[8] 10 止损预案：T12 只显示已登记/未登记，不判断高低');
const buyLine = { idx: 0, date: TODAY, time: '09:35', side: '买', name: '甲', code: '600000', price: 10, qty: 100, flag: '合规', rule: '' };
const kBuy = I.tk6(buyLine);
ok(!I.stopStatusKey(kBuy).asked, '初始未问过');
ok(I.setStopKey(kBuy, 9.8).registered, '登记 9.8 成功');
ok(I.stopStatus(buyLine).registered && I.stopStatus(buyLine).price === 9.8, '通过成交记录读回止损价');
ok(I.renderLineExtra(buyLine).includes('已登记 9.8'), '买入卡片显示已登记');
ok(I.renderLineExtra(buyLine).includes('不判断价格高低'), '不判断止损价高低');
ok(I.renderLineExtra({ side: '卖' }) === '', '卖出笔不显示 T12 登记状态');
ok(!I.setStopKey(kBuy, -1).ok, '非正数价格被拒绝');
I.setStopKey(kBuy, null);
ok(I.stopStatusKey(kBuy).asked && !I.stopStatusKey(kBuy).registered, '跳过记为已问过、未登记');
I.setStopKey(kBuy, 9.8);
const html8 = I.renderReportBottom(vHit, state);
ok(html8.includes('T12 止损预案登记'), '报告里有 T12 登记块');
ok(html8.includes('本次 3 笔买入'), '统计本次全部买入笔数（含未登记）');
ok(html8.includes('已登记 1 · 未登记 2'), '已登记/未登记并列，不判高低');

console.log('\n[9] 11 情绪打卡：首页 3 选 1，当天一次');
reset();
ok(I.moodSet('急', TODAY).ok, '记录今天情绪=急');
ok(!I.moodSet('慌', TODAY).ok && I.moodSet('慌', TODAY).reason === 'already', '当天第二次被拒绝');
ok(I.moodGet(TODAY) === '急', '读回当天情绪');
ok(!I.moodSet('乱', TODAY).ok, '非固定 3 选 1 被拒绝');
ok(I.moodSet('冷静', YESTERDAY).ok, '昨天可以单独记一条');
const homeMood = I.renderHomeTop();
ok((homeMood.match(/data-pi-mood=/g) || []).length === 3, '首页正好 3 个选项');
ok(homeMood.includes('今天已记：急（当天只记一次）'), '当天只记一次的状态回显');
ok(homeMood.includes('冷静') && homeMood.includes('急') && homeMood.includes('慌'), '冷静/急/慌 三项文案');

console.log('\n[10] 11 样本 <30：只显示「样本不足，暂不分组」');
reset();
const end = TODAY;
const fewDates = Array.from({ length: 5 }, (_, i) => I.addDays8(end, -i));
put('guanzhu_ledger', {
  trades: fewDates.map(d => ({ date: d, time: '093000', code: '600000', name: '甲', side: '买', price: 10, qty: 100 })),
  imports: [], dupLog: [],
});
const fewMood = {};
fewDates.forEach(d => { fewMood[d] = '急'; });
put('guanzhu_mood_v1', fewMood);
violationDates = [fewDates[0], fewDates[1]];
const g10 = I.moodGroupStats({
  moodMap: fewMood, violationDays: violationDates, judgedDates: fewDates,
  windowDays: 90, end: TODAY, minSample: 30,
});
ok(g10.eligible === false, 'n=5 时判定为样本不足');
ok(g10.shown.length === 0, '样本不足时没有可展示分组');
const html10 = I.renderReportBottom(vHit, state);
ok(html10.includes('样本不足，暂不分组'), '报告只写这一句');
ok(!html10.includes('%'), '样本不足时不出现任何分组百分比');

console.log('\n[11] 11 样本 ≥30：给分组越线率（按固定顺序）');
reset();
const manyDates = Array.from({ length: 40 }, (_, i) => I.addDays8(end, -i));
put('guanzhu_ledger', {
  trades: manyDates.map(d => ({ date: d, time: '093000', code: '600000', name: '甲', side: '买', price: 10, qty: 100 })),
  imports: [], dupLog: [],
});
const manyMood = {};
manyDates.forEach(d => { manyMood[d] = '急'; });
put('guanzhu_mood_v1', manyMood);
violationDates = manyDates.slice(0, 10);
const g11 = I.moodGroupStats({
  moodMap: manyMood, violationDays: violationDates, judgedDates: manyDates,
  windowDays: 90, end: TODAY, minSample: 30,
});
ok(g11.eligible === true, 'n=40 时可以分组');
ok(g11.shown[0].n === 40 && g11.shown[0].violatedDays === 10, '分母 40 天、越线 10 天');
ok(Math.abs(g11.shown[0].rate - 0.25) < 1e-9, '越线率 25%');
const html11 = I.renderReportBottom(vHit, state);
ok(html11.includes('n=40 天') && html11.includes('越线 10 天') && html11.includes('25.0%'), '报告给 n、越线天数、越线率');
ok(!html11.includes('样本不足'), '样本足够时不再显示样本不足');

console.log('\n[12] 11 ★ 3 选 1 点击区域 ≥44px');
const cssPath = path.join(__dirname, '../public/features/intent.css');
const css = fs.readFileSync(cssPath, 'utf8');
const moodRule = (css.match(/\.pi-mood-btn\s*\{([^}]*)\}/) || [])[1] || '';
const mh = moodRule.match(/min-height:\s*(\d+)px/);
const mw = moodRule.match(/min-width:\s*(\d+)px/);
ok(!!mh && +mh[1] >= 44, `情绪按钮 min-height=${mh ? mh[1] : '缺失'}px（≥44）`);
ok(!!mw && +mw[1] >= 44, `情绪按钮 min-width=${mw ? mw[1] : '缺失'}px（≥44）`);

console.log('\n[13] flag 默认关：不开就不渲染不弹层');
I.configure({ storage, flags: {}, recur: recurStub });
ok(I.renderHomeTop() === '', '全关时首页不渲染任何 intent 内容');
ok(I.renderReportBottom({}, state) === '', '全关时报告底部不渲染');
ok(I.renderReportTop({ lines: [] }) === '', '全关时报告首屏不渲染');
ok(I.renderLineExtra(buyLine) === '', '全关时逐笔不追加内容');
I.configure({ storage, flags: ALL_ON, recur: recurStub });

console.log('\n[14] 合规文案：无祈使/建议/胜率');
const allHtml = I.renderReportBottom(vHit, state) + I.renderReportTop(vHit) + I.renderHomeTop() + I.renderIntentModal();
ok(!/建议|应该|别再|下次注意|又犯/.test(allHtml), '不写建议/应该/别再/下次注意/又犯');
ok(!allHtml.includes('胜率'), '不写胜率');

console.log('\n[15] 9/10 弹层：新增买入才出现，已登记则不再弹');
reset();
I.configure({ storage, flags: ALL_ON, recur: recurStub });
const buyT = { date: TODAY, time: '09:35', code: '600000', name: '甲', side: '买', price: 10, qty: 100 };
const sellT = { date: TODAY, time: '10:00', code: '600001', name: '乙', side: '卖', price: 11, qty: 100 };
const pend = I.pendingBuys([buyT, sellT]);
ok(pend.length === 1 && pend[0].key === I.tk6(buyT), '只把买入列进弹层');
I.reasonSet(buyT, '随手');
I.setStop(buyT, 9.5);
ok(I.pendingBuys([buyT]).length === 0, '理由和止损都登记后不再弹');
ok(I.renderIntentModal() === '', '没有待登记项时不渲染弹层');

console.log('\n[16] 浏览器路径：UMD 挂 window + 注册钩子 + 首屏补渲染');
const src = fs.readFileSync(path.join(__dirname, '../public/features/intent.js'), 'utf8');
function fakeEl(id) {
  return {
    id: id, innerHTML: '', className: '', baseURI: '',
    addEventListener() {}, appendChild() {}, removeChild() {},
    querySelector() { return null; }, closest() { return null; },
    getAttribute() { return null; }, setAttribute() {}, matches() { return false; },
    parentNode: null,
  };
}
const doc = fakeEl('doc');
doc.readyState = 'complete';
doc.body = fakeEl('body');
doc.createElement = () => fakeEl('created');
const homeEl = fakeEl('home-ext');
doc.getElementById = (id) => (id === 'home-ext' ? homeEl : null);
doc.querySelector = () => null;
const sandbox = {
  document: doc,
  setTimeout: (fn) => { fn(); return 0; },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  PanjiExt: {
    reportTop: [], reportBottom: [], lineExtra: [], reviewTop: [], homeTop: [],
    rulesBottom: [], afterConfirm: [], afterIngest: [], afterRulesSave: [], shareStats: [],
    run(name, a, b) {
      const arr = sandbox.PanjiExt[name] || [];
      return arr.map((f) => { try { return f(a, b) || ''; } catch (e) { return ''; } }).join('');
    },
  },
  PanjiFlag: () => true,
};
sandbox.self = sandbox;
vm.runInNewContext(src, sandbox);
ok(!!(sandbox.PanjiFeatures && sandbox.PanjiFeatures.intent), '浏览器里挂到 window.PanjiFeatures.intent');
ok(sandbox.PanjiExt.homeTop.length === 1 && sandbox.PanjiExt.reportTop.length === 1
  && sandbox.PanjiExt.reportBottom.length === 1 && sandbox.PanjiExt.lineExtra.length === 1
  && sandbox.PanjiExt.afterConfirm.length === 1, '注册 5 个钩子，不改 app.js/index.html');
ok(homeEl.innerHTML.length > 200, '首屏 home-ext 由本模块补渲染（app.js 初始化时不调用 go(home)）');
ok(sandbox.PanjiExt.run('reportBottom', vHit, state).length > 0, 'reportBottom 钩子在浏览器上下文可用');
ok(sandbox.PanjiExt.run('reportTop', vHit, state).length > 0, 'reportTop 钩子在浏览器上下文可用');

console.log('\n[17] 12 越线认下 + 改法（图鉴 U-007）');
reset();
const ackRecords = [];
I.configure({
  storage, flags: ALL_ON, recur: recurStub,
  collection: { record: (kind, o) => { ackRecords.push([kind, o && o.fp]); return { ok: true }; } },
});
const ackLine = { idx: 7, date: TODAY, time: '09:40', code: '600000', side: '买', price: 10.25, qty: 100, flag: '违规', rule: 'T04' };
ok(I.renderLineExtra(ackLine).includes('data-pi-ack-save'), '违规行出现「认下并保存」入口');
ok(!I.renderLineExtra(Object.assign({}, ackLine, { flag: '合规' })).includes('data-pi-ack'), '合规行不出现改法入口');
const short = I.ackSaveKey(I.tk6(ackLine), 'T04', '下次少买点');
ok(!short.ok && short.reason === 'short', '不足 20 字拒绝保存');
const fix20 = '下次先写清楚为什么买再下单，价格冲高就不追';
const r1 = I.ackSaveKey(I.tk6(ackLine), 'T04', fix20, '2026-11-04');
ok(r1.ok && r1.n === 1, '写满 20 字保存成功，同类计 1 次');
const r1b = I.ackSaveKey(I.tk6(ackLine), 'T04', fix20, '2026-11-04');
ok(r1b.n === 1, '同一笔同一类重复保存不重复计数');
const ackList = JSON.parse(storage.getItem('guanzhu_ack_v1'));
ok(ackList.length === 1 && ackList[0].r === 'T04' && ackList[0].at === '2026-11-04', '登记表只存规则/日期/字数/哈希');
ok(!JSON.stringify(ackList).includes('600000') && !JSON.stringify(ackList).includes('10.25'), '登记表不含代码与价格原文');
ok(JSON.parse(storage.getItem('guanzhu_ack_txt_v1'))[r1.h] === fix20, '改法原文单独留在本机供回看');
const lineB = Object.assign({}, ackLine, { idx: 8, code: '600001', time: '10:05' });
const lineC = Object.assign({}, ackLine, { idx: 9, code: '600002', time: '14:20' });
const r2 = I.ackSaveKey(I.tk6(lineB), 'T04', '同类情况先按预案写清楚再决定，不临时改主意', '2026-11-05');
const r3 = I.ackSaveKey(I.tk6(lineC), 'T04', '同类情况先等一分钟再下单，不去追已经冲高的价格', '2026-11-06');
ok(r2.n === 2 && r3.n === 3, '三笔不同成交认下同一类，累计到 3 次');
ok(ackRecords.length === 4 && ackRecords.every(x => x[0] === 'violation_ack' && String(x[1]).includes('|T04')),
  '每次保存写一条 violation_ack 行为，指纹带规则、不含成交原文');
ok(I.ackStatusKey(I.tk6(lineC), 'T04').done, '保存后读回该笔为已认下');

console.log('\n[18] 12 成交价量缺字段：两个渲染节点都不漏 undefined/null/NaN');
const browserApi = sandbox.PanjiFeatures.intent;
function normText(html) {
  return String(html).replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
const BAD_RE = /\bundefined\b|\bnull\b|\bNaN\b/;
function stopLineOf(extra) {
  const line = Object.assign({ date: TODAY, time: '09:35', side: '买', name: '壬', code: '600009' }, extra);
  const html = I.renderReportBottom({ lines: [line] }, state);
  const at = html.indexOf('id="pi-stop"');
  if (at < 0) return '';
  const m = html.slice(at).match(/<p class="pi-line">([\s\S]*?)<\/p>/);
  return m ? m[1] : '';
}
function modalLineOf(extra) {
  const t = Object.assign({ date: TODAY, time: '09:40', side: '买', name: '癸', code: '600010' }, extra);
  sandbox.PanjiExt.afterConfirm[0]({ isDemo: false, trades: [t] });
  const html = browserApi.renderIntentModal();
  const m = html.match(/<p class="pi-buy-info">([\s\S]*?)<\/p>/);
  return m ? m[1] : '';
}
const pqCases = [
  ['有值', { price: 10.25, qty: 100 }],
  ['缺 price', { qty: 100 }],
  ['缺 qty', { price: 10.25 }],
  ['price 为 NaN', { price: NaN, qty: 100 }],
];
let pqHits = 0, pqScans = 0;
pqCases.forEach(([label, extra]) => {
  [['止损卡', stopLineOf], ['弹层', modalLineOf]].forEach(([node, get]) => {
    const raw = get(extra);
    pqScans++;
    const hit = BAD_RE.test(raw) || BAD_RE.test(normText(raw));
    if (hit) pqHits++;
    ok(!hit, `${node} · ${label}：textContent/innerHTML 均无 undefined/null/NaN
        ${normText(raw)}`);
  });
});
ok(pqScans === 8 && pqHits === 0, `扫描合计 ${pqScans} 处（2 节点 × 4 输入），命中 ${pqHits}（要求 0）`);
ok(normText(stopLineOf({ price: 10.25, qty: 100 })).includes('10.25元 × 100股'), '止损卡有值时按「X元 × Y股」原样渲染');
ok(normText(stopLineOf({ qty: 100 })).includes('价格/数量未提供'), '止损卡缺 price 时给明确降级文案');
ok(normText(modalLineOf({ price: 10.25, qty: 100 })).includes('10.25元 × 100股'), '弹层有值时按「X元 × Y股」原样渲染');
ok(normText(modalLineOf({ qty: 100 })).includes('价格/数量未提供'), '弹层缺 qty 时给明确降级文案');

console.log('\n[19] 20261107 普通用户「记预案」：四句文案、跳过计未记录');
reset();
const planT = { date: TODAY, time: '09:35', code: '600011', name: '子', side: '买', price: 10, qty: 100 };
ok(I.PLAN_COPY.title === '这笔还没记预案', '标题文案固定');
ok(I.PLAN_COPY.desc === '写一句你当时打算怎么做就走，不填也能存。', '说明文案固定');
ok(I.PLAN_COPY.placeholder === '预案价位（你自己定）', '输入框文案固定');
ok(I.PLAN_COPY.skip === '这次不记', '跳过文案固定');
ok(I.planPending([planT]).length === 1, '未登记买入选入预案步骤');
I.setStop(planT, 9.6);
ok(I.planPending([planT]).length === 0, '已登记的不再提示');
reset();

const planStorage = memStorage();
let planCreated = null;
const pdoc = fakeEl('doc2');
pdoc.readyState = 'complete';
pdoc.body = fakeEl('body2');
pdoc.createElement = () => { planCreated = fakeEl('created2'); return planCreated; };
pdoc.getElementById = () => null;
pdoc.querySelector = () => null;
pdoc.addEventListener = (type, fn) => { if (type === 'click') pdoc._click = fn; };
const psandbox = {
  document: pdoc,
  setTimeout: (fn) => { fn(); return 0; },
  localStorage: planStorage,
  PanjiExt: {
    reportTop: [], reportBottom: [], lineExtra: [], reviewTop: [], homeTop: [],
    rulesBottom: [], afterConfirm: [], afterIngest: [], afterRulesSave: [], shareStats: [],
  },
  PanjiFlag: () => false,
};
psandbox.self = psandbox;
vm.runInNewContext(src, psandbox);
psandbox.PanjiExt.afterConfirm[0]({ isDemo: false, trades: [planT] });
ok(planCreated && planCreated.id === 'pi-plan-mask', '普通用户默认（flag 关）存档后打开记预案弹层');
const planHtml = planCreated ? planCreated.innerHTML : '';
ok(planHtml.includes(I.PLAN_COPY.title), '渲染标题');
ok(planHtml.includes(I.PLAN_COPY.desc), '渲染说明');
ok(planHtml.includes(I.PLAN_COPY.placeholder), '渲染输入框占位');
ok(planHtml.includes(I.PLAN_COPY.skip), '渲染跳过按钮');
ok(!/止损|合规|不合规|参考价|建议/.test(planHtml), '不出现止损/合规/参考价/建议字样');

const planKey = psandbox.PanjiFeatures.intent.tk6(planT);
const skipTarget = {
  id: '',
  closest: (sel) => (sel === '[data-pi-plan-skip]' ? { getAttribute: () => planKey } : null),
};
pdoc._click({ target: skipTarget });
const planMap = JSON.parse(planStorage.getItem('guanzhu_stop_v1') || 'null');
ok(planMap && Object.prototype.hasOwnProperty.call(planMap, planKey),
  '「这次不记」写入跳过标记');
ok(planMap && planMap[planKey] === null, '跳过标记是 null，不是价格');
const skipped = psandbox.PanjiFeatures.intent.stopStatusKey(planKey);
ok(skipped.asked === true, '跳过之后算已问过');
ok(skipped.registered === false, '跳过之后仍算未登记（未记录）');
ok(skipped.price === null, '跳过之后价格为空');
ok(psandbox.PanjiFeatures.intent.planPending([planT]).length === 0,
  '同一笔下次不再弹（不骚扰）');

const histT = {
  date: I.addDays8(TODAY, -90), time: '09:35', code: '600099', name: '亥',
  side: '买', price: 10, qty: 100,
};
ok(I.planPending([histT]).length === 0, '历史交割单的成交不进预案步骤（只问当天）');
planCreated = null;
psandbox.PanjiExt.afterConfirm[0]({ isDemo: false, trades: [histT] });
ok(planCreated === null, '只带历史成交存档时不开弹层（不逐笔弹）');
const todayT2 = { date: TODAY, time: '10:00', code: '600098', name: '杂', side: '买', price: 11, qty: 100 };
ok(I.planPending([histT, todayT2]).length === 1, '历史+当天混合时只问当天那一笔');

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
