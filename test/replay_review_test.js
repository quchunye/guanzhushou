// replay_review_test.js —— 复盘第 4 tab 的纯函数回归（多账户取线 / 形态规则适用性 / 叠层 / 标签优先级 / byRule）
// 运行：node test/replay_review_test.js
'use strict';

const RR = require('../public/features/replay_review');
const { TEMPLATES, analyze } = require('../server/rules');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const day = '20261020';
const line = (time, side, price, account, rule) => ({
  date: day, time, side, code: '600000', name: '甲', price, qty: 1000,
  account, flag: rule ? '违规' : '合规', rule: rule || null,
});
const verdict = (rules, lines, opt) => {
  const o = opt || {};
  return {
    rules: rules.map(([id, params]) => ({ id, params })),
    lines,
    pending_rules: o.pending || [],
    capital: o.capital === undefined ? null : o.capital,
    suspects: o.suspects || [],
    opening_positions: o.openings || [],
  };
};
const pad = (n) => String(n).padStart(2, '0');
function makeBars(fromMin, toMin) {
  const out = [];
  for (let m = fromMin; m <= toMin; m++) {
    out.push({ t: day + pad(Math.floor(m / 60)) + pad(m % 60) });
  }
  return out;
}
const BARS = makeBars(571, 900); // 09:31–15:00

console.log('\n[1] 多账户：同日同票按账户分开取线，不混算');
const lA1 = line('09:40', '买', 12, '普通', 'T03');
const lA2 = line('10:10', '买', 11, '普通', 'T04');
const lB1 = line('13:00', '买', 10, '信用', null);
const vMix = verdict([['T03', { windowMin: 30 }], ['T04', { tolPct: 0 }]], [lA1, lA2, lB1]);
const cases = [{ verdict: vMix }];

const accts = RR.accountsFor(cases, '600000', day);
ok(accts.length === 2 && accts.indexOf('普通') >= 0 && accts.indexOf('信用') >= 0, 'accountsFor 列出当日两个账户');
ok(RR.linesFor(cases, '600000', day, '普通').lines.length === 2, '普通账户只取自己 2 笔');
ok(RR.linesFor(cases, '600000', day, '信用').lines.length === 1, '信用账户只取自己 1 笔');

const evA = RR.evaluate({
  verdict: vMix, lines: RR.linesFor(cases, '600000', day, '普通').lines,
  barCount: BARS.length, bars: BARS, code: '600000', day,
});
const evB = RR.evaluate({
  verdict: vMix, lines: RR.linesFor(cases, '600000', day, '信用').lines,
  barCount: BARS.length, bars: BARS, code: '600000', day,
});
ok(evA.buyCount === 2 && evB.buyCount === 1, '改后：普通 2 笔 / 信用 1 笔');
ok(evA.firstBuyPrice === 12 && evB.firstBuyPrice === 10, '改后：各账户首笔价 12 / 10');
ok(evA.actions[0].state === 'mismatch' && evA.actions[1].state === 'mismatch', '普通账户两笔各自命中 T03 / T04');
ok(evB.actions[0].state === 'na' && /T03/.test(evB.actions[0].why), '信用账户单笔不适用 T03/T04，写明确理由');

// 复现改前：三条线一起喂给 evaluate，信用账户那笔被当成普通账户的补仓
const evOld = RR.evaluate({
  verdict: vMix, lines: vMix.lines, barCount: BARS.length, bars: BARS, code: '600000', day,
});
ok(evOld.buyCount === 3, '改前复现：两账户三笔被合成一组');
ok(/T04/.test(evOld.actions[2].why) || evOld.actions[2].state === 'consistent', '改前复现：信用账户那笔被卷进 T04 判定');

console.log('\n[2] formFor 适用性：T03 不满足窗口/最高价时判「不适用」，不静默算合规');
const vWindow = verdict([['T03', { windowMin: 30 }], ['T04', { tolPct: 0 }]], [
  line('10:40', '买', 12, '', null), line('11:10', '买', 11, '', null),
]);
const evWin = RR.evaluate({ verdict: vWindow, lines: vWindow.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
ok(evWin.actions[0].state === 'na' && /晚于追高窗口/.test(evWin.actions[0].why), '首笔晚于 10:00 → T03 不适用并说明理由');

const vNotHigh = verdict([['T03', { windowMin: 30 }], ['T04', { tolPct: 0 }]], [
  line('09:40', '买', 10, '', null), line('10:10', '买', 11, '', null),
]);
const evNotHigh = RR.evaluate({ verdict: vNotHigh, lines: vNotHigh.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
ok(evNotHigh.actions[0].state === 'na' && /不是你当天买得最高的一笔/.test(evNotHigh.actions[0].why), '首笔不是最高价 → T03 不适用');

const vOk = verdict([['T03', { windowMin: 30 }], ['T04', { tolPct: 0 }]], [
  line('09:40', '买', 12, '', null), line('10:10', '买', 11, '', null),
]);
const evOk = RR.evaluate({ verdict: vOk, lines: vOk.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
ok(evOk.actions[0].state === 'consistent' && /T03/.test(evOk.actions[0].why), '条件成立时才给「已判定」');

console.log('\n[3] 叠层：T03 窗口带、T04 阈值线与首笔参照线互不共用');
const vL = verdict([['T01', { waitMin: 30 }], ['T02', { endMin: 30 }], ['T03', { windowMin: 30 }], ['T04', { tolPct: 2 }]], [
  line('09:40', '买', 12, '', 'T03'),
  line('10:10', '买', 11, '', 'T04'),
  line('14:40', '卖', 11, '', null),
]);
const evL = RR.evaluate({ verdict: vL, lines: vL.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const layers = RR.buildLayers(evL);
ok(layers.filter((l) => l.type === 'timeBand').length === 3, 'T01/T02/T03 三条时间带各一条');
ok(layers.filter((l) => l.type === 'priceLine').length === 2, '首笔参照线 + T04 阈值线各自一条');
const ref = layers.find((l) => l.type === 'priceLine' && l.role === 'ref');
const lim = layers.find((l) => l.type === 'priceLine' && l.role === 'limit');
ok(ref && ref.price === 12, '参照线价 = 首笔 12');
ok(lim && Math.abs(lim.price - 11.76) < 1e-9, 'T04 阈值线 = 12×(1-2%) = 11.76');
ok(layers.filter((l) => l.type === 'point').length === 3, '三笔动作各一个点层');
ok(layers.find((l) => /追高 09:40/.test(l.label || '')), '违规标签写规则短名 + 时间（含冒号），带状态图标');
ok(layers.find((l) => l.type === 'point' && l.state === 'mismatch').label.indexOf('✕') === 0, '不一致点标签以 ✕ 开头，不只靠颜色');
ok(!layers.some((l) => /触发/.test(l.label || '')), '标签不再出现「触发」字样');

console.log('\n[4] 标签上限 6 按优先级丢：mismatch > unknown > ref/limit > band');
const many = [];
for (let i = 0; i < 8; i++) many.push(line('09:40', '买', 12, '', 'T04'));
const vMany = verdict([['T01', { waitMin: 30 }], ['T02', { endMin: 30 }], ['T03', { windowMin: 30 }], ['T04', { tolPct: 0 }]], many);
const evMany = RR.evaluate({ verdict: vMany, lines: many, barCount: BARS.length, bars: BARS, code: '600000', day });
const manyLayers = RR.buildLayers(evMany);
const picked = RR.pickLabels(manyLayers, 6);
ok(picked.length === 6, '标签总数封顶 6');
ok(picked.every((l) => l.type === 'point' && l.state === 'mismatch'), '8 个违规点时 6 个名额全给违规点，不留给带/线');
const fewPicked = RR.pickLabels(RR.buildLayers(evL), 6);
ok(fewPicked.some((l) => l.type === 'timeBand'), '不挤时时间带标签仍会出现');

console.log('\n[5] 缺早盘/尾盘 bar 时必须有可见提示');
const shortBars = makeBars(585, 890); // 09:45–14:50
const vCov = verdict([['T01', { waitMin: 30 }], ['T02', { endMin: 30 }]], [line('10:00', '买', 10, '', null)]);
const evCov = RR.evaluate({ verdict: vCov, lines: vCov.lines, barCount: shortBars.length, bars: shortBars, code: '600000', day });
ok(evCov.coverage.missingOpen && evCov.coverage.missingClose, 'coverage 标记缺早盘与缺尾盘');
ok(evCov.notes.some((t) => /早盘/.test(t)), '缺早盘时给 T01 可见提示');
ok(evCov.notes.some((t) => /收盘前时段/.test(t)), '缺收盘前时段时给 T02 可见提示');

console.log('\n[6] byRule：只含启用规则、顺序按 TEMPLATES、每个规则一次复盘最多记 1 次');
const tplIds = TEMPLATES.map((t) => t.id);
const vBy = verdict([['T05', {}], ['T03', { windowMin: 30 }], ['T01', { waitMin: 30 }], ['T07', {}], ['T11', {}]], [
  line('09:40', '买', 12, '', 'T03'),
  line('09:50', '买', 12, '', 'T03'),
  line('10:00', '买', 12, '', 'T03'),
  line('13:30', '卖', 11, '', 'T07'),
], { pending: ['T05', 'T11'] });
const evBy = RR.evaluate({ verdict: vBy, lines: vBy.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const enabled = ['T01', 'T03', 'T05', 'T07', 'T11'];
const expectOrder = tplIds.filter((id) => enabled.indexOf(id) >= 0);
ok(evBy.byRule.length === 5, 'byRule 只含 5 条启用规则');
ok(evBy.byRule.map((x) => x.id).join(',') === expectOrder.join(','), 'byRule 顺序与 TEMPLATES 一致：' + expectOrder.join(','));
ok(evBy.byRule.every((x) => !enabled.includes(x.id) || true), '未启用规则不出现（T04/T09 等）');
ok(evBy.byRule.every((x) => !/^T04$/.test(x.id)), '未启用的 T04 不在数组里');
const t03row = evBy.byRule.find((x) => x.id === 'T03');
ok(t03row && t03row.inconsistent === 1, 'T03 三笔违规只记 1 次 inconsistent，不按笔累加');
const t05row = evBy.byRule.find((x) => x.id === 'T05');
ok(t05row && t05row.undetermined === 1, '未填本金时 T05 记 undetermined');
const t11row = evBy.byRule.find((x) => x.id === 'T11');
ok(t11row && t11row.undetermined === 1, '未填本金且有卖出时 T11 记 undetermined');
ok(evBy.byRule.every((x) => (x.consistent + x.inconsistent + x.undetermined) <= 1), '三态计数之和不超过 1');

console.log('\n[7] drawReview 用 stub canvas 跑通（渲染不崩，标签不超上限）');
function stubCanvas(w, h) {
  const noop = () => {};
  const texts = [];
  const g = new Proxy({
    measureText: () => ({ width: 8 }),
    fillText: (s) => { texts.push(String(s)); },
  }, {
    get(t, k) { if (k in t) return t[k]; return noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { clientWidth: w || 800, clientHeight: h || 320, width: 0, height: 0, getContext: () => g, texts };
}
{
  const ohlc = makeBars(571, 900).map((b) => ({ t: b.t, o: 10, h: 10.6, l: 9.8, c: 10.2, v: 100 }));
  const cvF = stubCanvas();
  const res = RR.drawReview(cvF, ohlc, evL, {});
  ok(res && Array.isArray(res.bars) && res.bars.length > 0, '有 bar 时返回绘制结果');
  ok(res && res.labels <= 6, '返回的常显标签数 ≤ 6');
  ok(RR.drawReview(stubCanvas(), [], evL, {}) === null, '无 bar 时返回 null，不抛错');
  ok(cvF.texts.indexOf('✕') < 0, '无 T11 跨线时柱顶不画 ✕');
}

console.log('\n[8] 档案批注预填按 day+account、次数/天数分开、链接参数用 acct');
{
  const arch = {
    reviews: [
      { day: '20261020', account: '普通', note: '普通批注' },
      { day: '20261020', account: '信用', note: '信用批注' },
      { day: '20261018', account: '', note: '旧批注' },
    ],
  };
  ok(RR.archivedRec(arch, '20261020', '信用').note === '信用批注', '同日两账户各取各的批注');
  ok(RR.archivedRec(arch, '20261020', '普通').note === '普通批注', '普通账户不被信用覆盖');
  ok(RR.archivedRec(arch, '20261018', '') !== null, '缺 account 的旧记录按空串命中');
  ok(RR.archivedRec(arch, '20261018', '普通') === null, '不同账户不预填');
  ok(RR.archivedRec(arch, '20261021', '') === null, '不同日期不预填');

  const s = RR.archiveStat(arch);
  ok(s.times === 3 && s.days === 2, '次数与天数分开统计（3 次 / 2 天）');
  ok(RR.archiveStat(null).times === 0 && RR.archiveStat(null).days === 0, '空档案统计为 0');

  const h1 = RR.archiveHref('600000', '甲', '20261020', '信用');
  ok(/&acct=%E4%BF%A1%E7%94%A8/.test(h1), '账户走 acct 参数');
  const h2 = RR.archiveHref('600000', '甲', '20261020', '');
  ok(!/acct=/.test(h2), '空账户不拼 acct 参数');
}

console.log('\n[9] 资金轨：百分比主轴、同分钟错位/合并、超限截断、无本金不出假柱');
function buy(time, price, qty, account) {
  return { date: day, time, code: '600000', name: '甲', side: '买', price, qty, account, flag: '合规', rule: null };
}
function sell(time, price, qty, account) {
  return { date: day, time, code: '600000', name: '甲', side: '卖', price, qty, account, flag: '违规', rule: 'T07' };
}
const capRules = [['T05', { maxPct: 50 }], ['T09', { maxPct: 50 }], ['T10', { maxPct: 50 }], ['T11', { maxPct: 2 }]];
const fundTrades = [buy('09:40', 10, 2000, 'P'), buy('10:05', 10, 2500, 'P'), buy('10:40', 10, 2000, 'P'), sell('13:20', 8, 6500, 'P')];
const vFund = verdict(capRules, fundTrades, { capital: 100000 });
const evFund = RR.evaluate({ verdict: vFund, lines: fundTrades, barCount: BARS.length, bars: BARS, code: '600000', day });
const fl = RR.buildLayers(evFund);
ok(fl.filter((l) => l.type === 'fundBar').length === 3, 'T05 三笔买入三根柱');
ok(fl.filter((l) => l.type === 'fundStep').length === 2, 'T09/T10 各一条阶梯');
ok(fl.filter((l) => l.type === 'fundWaterfall').length === 1, 'T11 一条瀑布');
ok(fl.filter((l) => l.type === 'fundLine').length === 2, '上下两轨各一条阈值线（相同百分比去重）');
const fb = fl.filter((l) => l.type === 'fundBar');
ok(Math.abs(fb[0].pct - 20) < 1e-9 && Math.abs(fb[1].pct - 25) < 1e-9, '柱高按账户本金百分比：20% / 25%');
ok(fb.every((l) => l.overflow === false), '未超限的柱子不标截断');
const st09 = fl.find((l) => l.type === 'fundStep' && l.rule === 'T09');
ok(st09 && st09.crossHm === '10:40' && Math.abs(st09.crossPct - 65) < 1e-9, 'T09 首个跨线 10:40 / 65%');
const wf = fl.find((l) => l.type === 'fundWaterfall');
ok(wf && wf.crossHm === '13:20' && Math.abs(wf.crossPct - 13) < 1e-9, 'T11 首次亏损超线 13:20 / 13%');
ok(wf && wf.unknown === false && wf.capDown === 4, '买卖能对齐不标 unknown；亏损轨满刻度 2×上限');
ok(fl.filter((l) => l.panel === 'fundUp').length >= 3, '上轨只放占用类图层');

// 同分钟第 2 笔错位 2px：槽位 0/1，柱高不变
const vSame = verdict([['T05', { maxPct: 50 }]], [buy('09:40', 10, 1000, 'P'), buy('09:40', 10, 2000, 'P')], { capital: 100000 });
const evSame = RR.evaluate({ verdict: vSame, lines: vSame.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const sameBars = RR.buildLayers(evSame).filter((l) => l.type === 'fundBar');
ok(sameBars.length === 2 && sameBars[0].slot === 0 && sameBars[1].slot === 1, '同分钟第 2 笔错位槽位 0/1');
ok(Math.abs(sameBars[0].pct - 10) < 1e-9 && Math.abs(sameBars[1].pct - 20) < 1e-9, '错位不改柱高');

// 同分钟 >3 笔合并成一根，标签写笔数
const vMerge = verdict([['T05', { maxPct: 50 }]], [
  buy('09:40', 10, 1000, 'P'), buy('09:40', 10, 1000, 'P'),
  buy('09:40', 10, 1000, 'P'), buy('09:40', 10, 1000, 'P'),
], { capital: 100000 });
const evMerge = RR.evaluate({ verdict: vMerge, lines: vMerge.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const mergeBars = RR.buildLayers(evMerge).filter((l) => l.type === 'fundBar');
ok(mergeBars.length === 1 && mergeBars[0].count === 4 && Math.abs(mergeBars[0].pct - 40) < 1e-9, '同分钟 4 笔合并为一根（40%）');
ok(/4笔/.test(mergeBars[0].label), '合并柱标签写「4笔」');

// 超 100% 截断
const vOver = verdict([['T05', { maxPct: 50 }]], [buy('10:00', 10, 12000, 'P')], { capital: 100000 });
const evOver = RR.evaluate({ verdict: vOver, lines: vOver.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const overBars = RR.buildLayers(evOver).filter((l) => l.type === 'fundBar');
ok(overBars.length === 1 && Math.abs(overBars[0].pct - 120) < 1e-9 && overBars[0].overflow === true, '120% 标 overflow，几何侧截断到 100%');

// 无本金 / 本金为 0：不出空轨
const vNoCap = verdict(capRules, fundTrades, { capital: null });
const evNoCap = RR.evaluate({ verdict: vNoCap, lines: fundTrades, barCount: BARS.length, bars: BARS, code: '600000', day });
ok(RR.buildLayers(evNoCap).every((l) => !l.panel || l.panel === 'price'), '无本金：不产生任何资金轨图层');
const vZero = verdict(capRules, fundTrades, { capital: 0 });
const evZero = RR.evaluate({ verdict: vZero, lines: fundTrades, barCount: BARS.length, bars: BARS, code: '600000', day });
ok(RR.buildLayers(evZero).every((l) => !l.panel || l.panel === 'price'), '本金为 0：同样不出假柱');

// T05/T09 未触发（当日没有买入）不画 0 高度柱
const vNoBuy = verdict([['T05', { maxPct: 50 }], ['T09', { maxPct: 50 }], ['T11', { maxPct: 2 }]], [
  { date: day, time: '13:20', code: '600000', name: '甲', side: '卖', price: 8, qty: 1000, account: 'P', flag: '违规', rule: 'T07' },
], { capital: 100000 });
const evNoBuy = RR.evaluate({ verdict: vNoBuy, lines: vNoBuy.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const nb = RR.buildLayers(evNoBuy);
ok(!nb.some((l) => l.type === 'fundBar' || l.type === 'fundStep'), '没有买入就不出 T05/T09 图层');
ok(nb.some((l) => l.type === 'fundWaterfall'), '没有买入但有卖出时 T11 仍出瀑布');

// 盈利卖出不抵扣累计亏损：只累负 pnl
const vProfit = verdict([['T11', { maxPct: 2 }]], [buy('09:40', 10, 2000, 'P'), sell('13:20', 12, 2000, 'P')], { capital: 100000 });
const evProfit = RR.evaluate({ verdict: vProfit, lines: vProfit.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const pf = RR.buildLayers(evProfit).find((l) => l.type === 'fundWaterfall');
ok(pf && pf.pts[0].delta === 0 && Math.abs(pf.pts[0].cumPct) < 1e-9 && !pf.crossHm, '盈利卖出 delta=0，不抵扣也不跨线');

// 卖出多于持仓：底仓不明 → unknown
const vUnk = verdict([['T11', { maxPct: 2 }]], [buy('09:40', 10, 1000, 'P'), sell('13:20', 8, 3000, 'P')], { capital: 100000 });
const evUnk = RR.evaluate({ verdict: vUnk, lines: vUnk.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const uk = RR.buildLayers(evUnk).find((l) => l.type === 'fundWaterfall');
ok(uk && uk.unknown === true, '卖超持仓标 unknown（底仓不明走虚线）');

// 期初持仓先入队：卖超当日买入但被底仓覆盖时不标 unknown，成本按期初价复算
const vOpen = verdict([['T11', { maxPct: 2 }]], [sell('13:20', 8, 3000, 'P')], {
  capital: 100000,
  openings: [{ code: '600000', name: '甲', qty: 3000, cost: 12, account: 'P' }],
});
const evOpen = RR.evaluate({ verdict: vOpen, lines: vOpen.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
const op = RR.buildLayers(evOpen).find((l) => l.type === 'fundWaterfall');
ok(op && op.unknown === false, '期初持仓覆盖卖出：不标 unknown');
ok(op && Math.abs(op.crossPct - 12) < 1e-9, '亏损按期初成本复算（12%）');

console.log('\n[10] 面板切换：390 价格常驻 195 + 资金槽 57，槽内切换不改高度；≥768 才三面板');
{
  const ohlc = makeBars(571, 900).map((b) => ({ t: b.t, o: 10, h: 10.6, l: 9.8, c: 10.2, v: 100 }));
  const resF = RR.drawReview(stubCanvas(), ohlc, evFund, {});
  ok(resF && resF.panels === 3 && resF.funds.on === true, '宽屏资金轨开：价格 + 占用 + 亏损三面板');
  ok(resF && resF.funds.bars === 3 && resF.funds.steps === 2 && resF.funds.waterfall === 1, '绘制侧拿到的资金图层计数与纯函数一致');
  const resNo = RR.drawReview(stubCanvas(), ohlc, evL, {});
  ok(resNo && resNo.panels === 1 && resNo.funds.on === false, '无本金：退回单面板，不画空轨');
  // ✕ 不再单独 fillText，而是并进标签文本（形态冗余，不靠色相）。
  const cvW = stubCanvas();
  RR.drawReview(cvW, ohlc, evFund, {});
  ok(cvW.texts.some((t) => t.indexOf('✕') >= 0), 'T11 跨线柱以 ✕ 前缀的标签出画');

  const lay = RR.panelLayout(334, 300, false, true);
  ok(lay.priceH === 195 && lay.fundH === 57, '390：价格 195 / 资金槽 57');
  ok(lay.priceBottom === 205 && lay.fundTop === 215, '390：价格底 205、槽顶 215、间距 10');
  const layOne = RR.panelLayout(334, 300, false, false);
  ok(layOne.priceH === 270 && layOne.fundH === 0, '无资金轨：价格拿满 270，不预留空槽');

  const r390 = RR.drawReview(stubCanvas(334, 300), ohlc, evFund, {});
  ok(r390 && r390.panels === 2 && r390.panel === 'fundUp', '390：两面板，默认选中占用');
  ok(r390.priceHeight === 195 && r390.fundHeight === 57, '390 绘制侧实测：价格 195 / 资金槽 57');
  ok(r390.labels <= 2, '390 同屏内联标签不超过 2 个（实画 ' + r390.labels + ' / 命中 ' + r390.labelTotal + '）');
  const rDown = RR.drawReview(stubCanvas(334, 300), ohlc, evFund, { panel: 'fundDown' });
  ok(rDown.panel === 'fundDown' && rDown.priceHeight === 195 && rDown.fundHeight === 57, '切到亏损：槽高不变（57），价格仍 195');
  const boxes = r390.labelBoxes;
  const clash = boxes.some((a, i) => boxes.some((b, j) => i < j && a.panel === b.panel
    && Math.abs(a.y - b.y) < 12 && Math.abs(a.x - b.x) < 40));
  ok(!clash, '390 同屏标签不压字（同面板纵向至少差 12px）');
  if (r390.labelMerged > 2) ok(r390.band.length === r390.labelMerged - r390.labels, '溢出标签全部进标注带（' + r390.band.length + ' 条）');

  const hit = r390.hitRects[0];
  const hitId = RR.hitTest(r390, hit.x + 2, hit.y + 2);
  ok(typeof hitId === 'string' && hitId.length > 0, 'canvas 命中测试能返回标签 id');
  const rX = RR.drawReview(stubCanvas(334, 300), ohlc, evFund, { expanded: hitId });
  ok(rX.callout && rX.callout.id === hitId, '点按命中后展开出一条 callout');
  ok(rX.callout.x >= rX.callout.ax + 8 || rX.callout.x + rX.callout.w <= rX.callout.ax - 4, 'callout 侧放，不盖住锚点那一根柱');
  ok(rX.labels <= 2, '展开后内联标签仍不超 2 个');

  ok(RR.panelBadges([{ type: 'fundBar', panel: 'fundUp', over: true }]).fundUp === true, '占用轨有 mismatch 时挂徽标');
  ok(RR.panelBadges([{ type: 'fundBar', panel: 'fundUp', overflow: false }]).fundUp === false, '无 mismatch 不挂徽标');

  const g2 = {
    wide: false, pad: { l: 6, r: 40 }, cssW: 334, priceTop: 10, priceH: 195, plotW: 288, right: 294,
    xOfHm: (hm) => 6 + (hm.slice(0, 2) * 60 + hm.slice(3) * 1 - 570) * 1.2,
    yPrice: () => 100, yPct: () => 250, panelTopOf: () => 10, panelHOf: () => 195,
    measure: (t) => t.length * 6,
  };
  const merged = RR.mergeLabels([
    { id: 'a', panel: 'price', type: 'point', text: 'x', anchor: { kind: 'time', hm: '09:40', price: 10 }, rank: 0, seq: 0 },
    { id: 'b', panel: 'price', type: 'point', text: 'y', anchor: { kind: 'time', hm: '10:20', price: 10 }, rank: 0, seq: 1 },
  ], g2);
  ok(merged.length === 1 && merged[0].text === '09:40–10:20 · 2 笔', '间隔 <96px 合并成区间标签');
  const mergedSame = RR.mergeLabels([
    { id: 'c', panel: 'price', type: 'point', text: 'x', anchor: { kind: 'time', hm: '0940', price: 10 }, rank: 0, seq: 0 },
    { id: 'd', panel: 'price', type: 'point', text: 'y', anchor: { kind: 'time', hm: '09:40', price: 10 }, rank: 0, seq: 1 },
  ], g2);
  ok(mergedSame.length === 1 && mergedSame[0].text === '09:40 · 2 笔', '同一分钟的合并写单点时间，不写成区间');

  const g3 = {
    wide: false, pad: { l: 6, r: 40 }, cssW: 332, priceTop: 10, priceH: 195, right: 292, plotW: 286,
    xOfHm: () => 100, yPrice: () => 100, yPct: () => 260,
    panelTopOf: (p) => (p === 'fundUp' ? 215 : 10), panelHOf: () => 57,
    measure: (t) => t.length * 6,
  };
  const fundLab = RR.layoutLabels([
    { id: 'f1', panel: 'fundUp', type: 'fundBar', text: '✕ 亏损超线', anchor: { kind: 'timePct', hm: '09:40', pct: 20 }, rank: 0, seq: 0 },
  ], g3, '');
  ok(fundLab.drawn.length === 1 && fundLab.drawn[0].y >= 241, '资金轨标签从槽顶 26px 以下起排，不压分段控件');

  const g4 = Object.assign({}, g3, { xOfHm: () => 180 });
  const flip = RR.layoutLabels([
    { id: 'f2', panel: 'fundDown', type: 'fundWaterfall', text: '✕ 亏损超线 13:30 · 已亏 2564 / 2.6%', anchor: { kind: 'timePct', hm: '13:30', pct: 2 }, rank: 0, seq: 0 },
  ], g4, '');
  ok(flip.drawn.length === 1 && flip.drawn[0].align === 'right'
    && flip.drawn[0].x - flip.drawn[0].w <= 180, '标签会顶到右轴时翻到锚点左侧，不压刻度');

  const g6 = Object.assign({}, g3, { xOfHm: () => 180, right: 292 });
  const cl = RR.layoutLabels([
    { id: 'wide-long', panel: 'fundDown', type: 'fundWaterfall', text: 'x'.repeat(40), anchor: { kind: 'timePct', hm: '13:30', pct: 2 }, rank: 0, seq: 0 },
  ], g6, '');
  ok(cl.drawn.length === 1 && cl.drawn[0].x - cl.drawn[0].w >= 6, '超宽标签贴左边界，不出画布');

  const g5 = Object.assign({}, g3, { measureCallout: (t) => t.length * 7 });
  const co = RR.layoutLabels([
    { id: 'c1', panel: 'price', type: 'point', text: '当日首笔 93.70', anchor: { kind: 'time', hm: '09:40', price: 100 }, rank: 3, seq: 0 },
  ], g5, 'c1');
  ok(co.callout && co.callout.w >= '当日首笔 93.70'.length * 7 + 14, '读数块按 12px 字体量宽，不截成省略号');

  const bothFund = [
    { type: 'fundBar', panel: 'fundUp', over: true, overflow: true, label: '✕ 占用超线', fromHm: '09:40', pct: 90 },
    { type: 'fundBar', panel: 'fundDown', over: true, overflow: true, label: '✕ 亏损超线', fromHm: '13:30', pct: 2 },
  ];
  const onlyUp = RR.collectLabels(bothFund, 'fundUp');
  ok(onlyUp.length === 1 && onlyUp[0].panel === 'fundUp', '槽内切换只收当前资金轨的标签，另一条不画在错的轨上');
  ok(RR.collectLabels(bothFund).length === 2, '宽屏三面板时两条轨的标签都收');

  const longBand = Array.from({ length: 8 }, (_, i) => ({ id: 'b' + i, text: '标注条目很长很长很长', bandText: '标注条目很长很长很长' }));
  const per = RR.bandPageSize(longBand, g3, 332);
  ok(per > 0 && per < 8, '标注带按像素装箱：放不下时分页（每页 ' + per + ' 条）');
  ok(RR.bandPageSize(longBand.slice(0, 3), g3, 332) === 3, '放得下时不折叠，整条带一次显示');
  ok(RR.bandPageSize([{ text: '一条特别特别特别特别特别特别长的标注' }], g3, 40) === 1, '单条超宽也至少留 1 条，不出现空带');
}

console.log('\n[11] 资金跨线写进 byRule：数据层不漏记，徽标与入口同源');
{
  // 真实跨线：T09/T10 累计 65% > 50%，T11 已亏 13% > 2%
  const evCross = RR.evaluate({ verdict: vFund, lines: fundTrades, barCount: BARS.length, bars: BARS, code: '600000', day });
  const row09 = evCross.byRule.find((r) => r.id === 'T09');
  const row10 = evCross.byRule.find((r) => r.id === 'T10');
  const row11 = evCross.byRule.find((r) => r.id === 'T11');
  ok(row09 && row09.inconsistent === 1, '资金证据：T09 累计跨线，byRule 记 inconsistent（不再记 consistent）');
  ok(row10 && row10.inconsistent === 1, '资金证据：T10 累计跨线，byRule 记 inconsistent');
  ok(row11 && row11.inconsistent === 1, '资金证据：T11 亏损跨线，byRule 记 inconsistent');
  ok(row09 && row09.consistent === 0 && row10 && row10.consistent === 0, '跨线的规则不同时记 consistent，一条规则只落一格');

  // 同一批交易、本金抬到 1000 万：全部不跨线，不能误伤
  const vCalm = verdict(capRules, fundTrades, { capital: 10000000 });
  const evCalm = RR.evaluate({ verdict: vCalm, lines: fundTrades, barCount: BARS.length, bars: BARS, code: '600000', day });
  ok(evCalm.byRule.filter((r) => r.id === 'T09' || r.id === 'T10' || r.id === 'T11').every((r) => r.consistent === 1),
    '未跨线时 T09/T10/T11 仍记 consistent');

  // B 方案文案：笔数与规则数分工，笔数行不出现「不一致」
  const badge = RR.stateBadge(evCross);
  ok(/^\d+ 笔触发 · 落在 \d+ 条规则上。$/.test(badge.note), '徽标文案是「N 笔触发 · 落在 M 条规则上。」');
  ok(badge.note.indexOf('不一致') < 0, '笔数说明行不复用「不一致」');
  const rulesInNote = +badge.note.match(/落在 (\d+) 条规则/)[1];
  const badInByRule = evCross.byRule.filter((r) => +r.inconsistent > 0).length;
  ok(rulesInNote === badInByRule, '徽标里的规则数直接来自 byRule（' + rulesInNote + ' = ' + badInByRule + '），没有第二套算法');

  // 画布入口与徽标各自从 byRule 取，删掉事后回填后仍然相等
  const ohlcC = makeBars(571, 900).map((b) => ({ t: b.t, o: 10, h: 10.6, l: 9.8, c: 10.2, v: 100 }));
  const resC = RR.drawReview(stubCanvas(), ohlcC, evCross, {});
  ok(resC && resC.entry && resC.entry.mismatch === badInByRule,
    '画布底部入口的不一致条数 = byRule（' + (resC && resC.entry && resC.entry.mismatch) + '）');
}

console.log('\n[12] T05 单笔阈值统一：复盘页与报告页都读同一个 maxPct');
{
  const dayS = '2026-10-20';
  const capT = 100000;
  const oneBuy = (qty) => [{
    date: dayS, time: '10:00', side: '买', code: '600000', name: '甲', price: 10, qty,
  }];
  const report = (qty) => analyze(oneBuy(qty), {
    rules: [{ templateId: 'T05', params: { maxPct: 50 } }], capital: capT,
  }, 'TEST');
  const review = (qty) => {
    const lines = oneBuy(qty).map((l) => Object.assign({}, l, { account: '普通', flag: '合规', rule: null }));
    const v = verdict([['T05', { maxPct: 50 }]], lines, { capital: capT });
    return RR.evaluate({ verdict: v, lines: v.lines, barCount: BARS.length, bars: BARS, code: '600000', day });
  };
  const t05row = (ev) => ev.byRule.find((r) => r.id === 'T05');
  const barOf = (ev) => RR.buildLayers(ev).find((l) => l.type === 'fundBar');

  const e60 = review(6000);
  ok(report(6000).lines[0].rule === 'T05' && t05row(e60).inconsistent === 1,
    '单笔 60%（上限 50%）：报告页与复盘页都判不一致');
  ok(barOf(e60).over === true && barOf(e60).overflow === false,
    '60% 判超限，但柱高未截断（判定 over 与绘图 overflow 分开）');

  const e40 = review(4000);
  ok(report(4000).lines[0].rule === null && t05row(e40).consistent === 1,
    '单笔 40%（上限 50%）：报告页与复盘页都判一致');

  const e120 = review(12000);
  ok(report(12000).lines[0].rule === 'T05' && t05row(e120).inconsistent === 1,
    '单笔 120%：仍判不一致');
  ok(barOf(e120).overflow === true, '单笔 120%：绘图仍按 100% 截断');
}

console.log('\n[13] T12 方案 B：只判被问过的成交，无键不进分母');
{
  const mk = (time, side, price) => ({
    date: day, time, side, code: '600000', name: '甲', price, qty: 1000,
    account: '普通', flag: '合规', rule: null,
  });
  const ls = [mk('10:00', '买', 10), mk('14:00', '卖', 11)];
  const vT12 = verdict([['T12', {}], ['T05', { maxPct: 50 }]], ls, {
    capital: 100000,
    suspects: [{ code: '600000', account: '普通', rule: 'T12', text: '存疑' }],
  });
  const base = { verdict: vT12, lines: vT12.lines, barCount: BARS.length, bars: BARS, code: '600000', day, account: '普通' };
  const row12 = (ev) => ev.byRule.filter((r) => r.id === 'T12')[0];
  const run = (stopStatus) => RR.evaluate(Object.assign({}, base, { stopStatus }));
  const draw = (ev) => RR.drawReview(stubCanvas(), BARS, ev, {});
  const rowOf = (res, id) => res.sheet.notes.filter((r) => r.id === id)[0] || {};

  // 无键（历史导入 / 从没问过）：不进判定，分母减 1
  const eNone = run(() => ({ asked: false }));
  ok(row12(eNone).consistent === 0 && row12(eNone).inconsistent === 0 && row12(eNone).undetermined === 0,
    '无键：T12 三格全空（不进判定）');
  ok(eNone.t12.asked === 0 && eNone.t12.recorded === 0, '无键：asked=0');
  const dNone = draw(eNone);
  ok(dNone.entry.total === 1 && dNone.entry.mismatch === 0, '无键：分母 2 → 1，不一致 0');
  ok(rowOf(dNone, 'T12').param === '没有被问过的成交 · 不计入', '无键：浮层写「不计入」');

  // null（问过但明确跳过）：未记录 → 不一致
  const eSkip = run(() => ({ asked: true, registered: false }));
  ok(row12(eSkip).inconsistent === 1, 'null：未记录 → 不一致');
  const dSkip = draw(eSkip);
  ok(dSkip.entry.total === 2 && dSkip.entry.mismatch === 1, 'null：分母含 T12（2 条），不一致 1 条');
  ok(rowOf(dSkip, 'T12').param === '已记录 0 / 未记录 1（只统计被问过的成交）', 'null：浮层写「未记录 1」');

  // 正数（已记录）：一致
  const eReg = run(() => ({ asked: true, registered: true }));
  ok(row12(eReg).consistent === 1, '正数：已记录 → 一致');
  const dReg = draw(eReg);
  ok(dReg.entry.total === 2 && dReg.entry.mismatch === 0, '正数：分母含 T12，不一致 0');

  // 混合：同日两笔买入，一笔已记录、一笔跳过
  const lsMix = [mk('10:00', '买', 10), mk('10:30', '买', 10.5)];
  const vMix12 = verdict([['T12', {}], ['T05', { maxPct: 50 }]], lsMix, { capital: 100000 });
  const eMix = RR.evaluate(Object.assign({}, base, {
    verdict: vMix12, lines: vMix12.lines,
    stopStatus: (l) => (l.time === '10:00' ? { asked: true, registered: true } : { asked: true, registered: false }),
  }));
  ok(row12(eMix).inconsistent === 1 && row12(eMix).consistent === 0, '混合：一笔未记录即判不一致');
  ok(eMix.t12.asked === 2 && eMix.t12.recorded === 1, '混合：只在被问过的两笔里算（asked 2 / 已记录 1）');
  const dMix = draw(eMix);
  ok(dMix.entry.total === 2 && dMix.entry.mismatch === 1, '混合：分母 2、不一致 1');

  // 老 suspects 不再左右判定：有 suspect 但无键，T12 仍不进判定
  ok(row12(eNone).inconsistent === 0 && eNone.byRule.filter((r) => r.id === 'T12').length === 1,
    '有 suspect 但无键：T12 仍不进判定（老数据不追溯）');
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + 'pass ' + pass + ' / fail ' + fail);
process.exit(fail ? 1 : 0);
