// calendar_test.js —— 批次 C 14 缺口补录：静态 2026 交易日历 + 缺口清单
// 用法：node test/calendar_test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const up = require('../public/features/upload.js');

const CAL_PATH = path.join(__dirname, '..', 'public', 'trading_calendar_2026.json');
const CAL = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
const CAL27_PATH = path.join(__dirname, '..', 'public', 'trading_calendar_2027.json');
const CAL27 = JSON.parse(fs.readFileSync(CAL27_PATH, 'utf8'));

let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
function dayOf(s) { return new Date(s + 'T00:00:00Z').getUTCDay(); }
function dummy(date, o) {
  return Object.assign({ date, time: '10:00', side: '买', price: 10, qty: 100, name: 'X', code: '600000' }, o || {});
}

console.log('[1] 交易日历文件结构');
check('version / year / tradingDays 齐备', () => {
  assert.strictEqual(CAL.version, 1);
  assert.strictEqual(CAL.year, 2026);
  assert.ok(Array.isArray(CAL.tradingDays));
  assert.ok(Array.isArray(CAL.holidays));
});
check('交易日升序、无重复、全部为 2026 年', () => {
  const days = CAL.tradingDays;
  assert.ok(days.length > 0);
  for (let i = 0; i < days.length; i++) {
    assert.ok(/^2026-\d{2}-\d{2}$/.test(days[i]), days[i]);
    if (i) assert.ok(days[i] > days[i - 1], '必须严格升序：' + days[i]);
  }
});
check('交易日不含周六 / 周日（调休上班的周末交易所也休市）', () => {
  for (const d of CAL.tradingDays) {
    const w = dayOf(d);
    assert.notStrictEqual(w, 0, d + ' 是周日');
    assert.notStrictEqual(w, 6, d + ' 是周六');
  }
});
check('2026 年交易日数量在合理区间（235–250）', () => {
  assert.ok(CAL.tradingDays.length >= 235 && CAL.tradingDays.length <= 250, String(CAL.tradingDays.length));
  assert.strictEqual(CAL.tradingDays.length, 242);
});

console.log('[2] 法定休市日已剔除、节后首日已恢复');
check('元旦：1/1、1/2 不在交易日，1/5 开市', () => {
  const set = new Set(CAL.tradingDays);
  assert.ok(!set.has('2026-01-01'));
  assert.ok(!set.has('2026-01-02'));
  assert.ok(set.has('2026-01-05'));
});
check('春节：2/16–2/20、2/23 不在交易日，2/24 开市', () => {
  const set = new Set(CAL.tradingDays);
  ['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23']
    .forEach((d) => assert.ok(!set.has(d), d + ' 应休市'));
  assert.ok(set.has('2026-02-24'));
});
check('清明 / 劳动 / 端午 / 中秋 / 国庆 的首个工作日都休市', () => {
  const set = new Set(CAL.tradingDays);
  ['2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19', '2026-09-25',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']
    .forEach((d) => assert.ok(!set.has(d), d + ' 应休市'));
  assert.ok(set.has('2026-04-07'));
  assert.ok(set.has('2026-05-06'));
  assert.ok(set.has('2026-10-08'));
});
check('holidays 字段能覆盖上面的休市区间（供人工核对）', () => {
  assert.ok(CAL.holidays.length >= 7);
  const names = CAL.holidays.map((h) => h.name);
  ['春节', '国庆'].forEach((n) => assert.ok(names.indexOf(n) >= 0, n));
});

console.log('[3] 缺口计算：coverage + byDate，最多 5 个');
check('缺 2 天 → 按日期升序列出，label/hint 正确', () => {
  const ledger = {
    trades: [
      dummy('2026-01-05'), dummy('2026-01-06'), dummy('2026-01-09'), dummy('2026-01-12'),
    ],
  };
  const r = up.findGaps(ledger, CAL, 5);
  assert.strictEqual(r.from, '2026-01-05');
  assert.strictEqual(r.to, '2026-01-12');
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.gaps.map((g) => g.date), ['2026-01-07', '2026-01-08']);
  assert.strictEqual(r.gaps[0].label, '01-07');
  assert.ok(r.gaps[0].hint.indexOf('补 01-07 的交割单截图') >= 0, r.gaps[0].hint);
});
check('缺 10 天 → 只列前 5 天，total 保留全量', () => {
  const ledger = { trades: [dummy('2026-01-05'), dummy('2026-01-30')] };
  const r = up.findGaps(ledger, CAL, 5);
  assert.strictEqual(r.gaps.length, 5);
  assert.ok(r.total > 5, String(r.total));
  assert.strictEqual(r.gaps[0].date, '2026-01-06');
});
check('覆盖区间内每个交易日都有记录 → 无缺口', () => {
  const ledger = { trades: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].map((d) => dummy(d)) };
  const r = up.findGaps(ledger, CAL, 5);
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.gaps, []);
});
check('周末与休市日不会被当成缺口', () => {
  const ledger = { trades: [dummy('2026-01-05'), dummy('2026-01-12')] };
  const r = up.findGaps(ledger, CAL, 5);
  assert.deepStrictEqual(r.gaps.map((g) => g.date), ['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']);
  assert.ok(r.gaps.every((g) => dayOf(g.date) >= 1 && dayOf(g.date) <= 5));
});
check('日期写法 20260105 / 2026-01-05 都能识别', () => {
  const ledger = { trades: [dummy('20260105'), dummy('2026-01-06')] };
  const r = up.findGaps(ledger, CAL, 5);
  assert.strictEqual(r.total, 0);
});
check('空账本 / 空日历 → 不报错、无缺口', () => {
  assert.strictEqual(up.findGaps({ trades: [] }, CAL, 5).total, 0);
  assert.strictEqual(up.findGaps({ trades: [dummy('2026-01-05')] }, { tradingDays: [] }, 5).total, 0);
  assert.strictEqual(up.findGaps(null, CAL, 5).total, 0);
});

console.log('[4] 缺口区块渲染');
check('有缺口 → 渲染“账本缺口”与补录提示', () => {
  const html = up.gapSectionHtml(up.findGaps({ trades: [dummy('2026-01-05'), dummy('2026-01-12')] }, CAL, 5));
  assert.ok(html.indexOf('账本缺口') >= 0);
  assert.ok(html.indexOf('补 01-06 的交割单截图') >= 0);
  assert.ok(html.indexOf('静态 2026') >= 0);
});
check('无缺口 → 不渲染区块（不占首屏）', () => {
  assert.strictEqual(up.gapSectionHtml({ total: 0, gaps: [] }), '');
});
check('缺口文案不含祈使 / 建议词', () => {
  const html = up.gapSectionHtml(up.findGaps({ trades: [dummy('2026-01-05'), dummy('2026-01-12')] }, CAL, 5));
  assert.ok(!/别再买|不要再买|建议|应该|下次注意/.test(html), html);
});

console.log('[5] 按年加载（2026/2027 已收录，2028 仍走缺年降级）');

check('登记年份 2026 + 2027；URL 按年份拼接', () => {
  assert.deepStrictEqual(up.CAL_KNOWN_YEARS, [2026, 2027]);
  assert.strictEqual(up.calendarUrl(2026), 'trading_calendar_2026.json');
  assert.strictEqual(up.calendarUrl(2027), 'trading_calendar_2027.json');
  assert.strictEqual(up.calHasYear(CAL, 2026), true);
  assert.strictEqual(up.calHasYear(CAL27, 2027), true);
  assert.strictEqual(up.calHasYear(CAL, 2027), false);
  assert.strictEqual(up.calHasYear(CAL27, 2028), false);
});

check('2026 命中表：节假日休市、普通工作日开市，无降级提示', () => {
  assert.deepStrictEqual(up.calCoverage(CAL, 2026), { covered: true, note: '' });
  assert.strictEqual(up.isTradingDay('20261005', CAL), false); // 国庆
  assert.strictEqual(up.isTradingDay('20261104', CAL), true);
});

check('2027 已收录：节假日休市、普通工作日开市，无降级提示', () => {
  assert.deepStrictEqual(up.calCoverage(CAL27, 2027), { covered: true, note: '' });
  assert.strictEqual(up.isTradingDay('20270101', CAL27), false); // 元旦（周五）
  assert.strictEqual(up.isTradingDay('20270104', CAL27), true);  // 节后首个交易日
  assert.strictEqual(up.isTradingDay('20270131', CAL27), false); // 补班周日仍休市
});

check('2028 未收录：只按周一~五判断，并给出可展示的降级原文', () => {
  const cov = up.calCoverage(CAL27, 2028);
  assert.strictEqual(cov.covered, false);
  assert.ok(cov.note.indexOf('2028 年节假日安排尚未收录') >= 0, cov.note);
  assert.ok(cov.note.indexOf('仅按周一至周五判断') >= 0, cov.note);
  assert.strictEqual(up.isTradingDay('20280103', CAL27), true); // 周一
  assert.strictEqual(up.isTradingDay('20280101', CAL27), false); // 周六
});

check('按年 bundle 的缺口计算与单年一致', () => {
  const bundle = up.makeCalendarBundle({ '2026': CAL, '2027': CAL27 });
  const r = up.findGaps({ trades: [dummy('2026-01-05'), dummy('2026-01-12')] }, bundle, 5);
  assert.strictEqual(r.total, 4);
  assert.deepStrictEqual(r.gaps.map((g) => g.date), ['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']);
});

check('缺口口径年份标签：单年 2026，跨年区间', () => {
  assert.strictEqual(up.calYearsLabel('20261104', '20261104'), '2026');
  assert.ok(up.calYearsLabel('20261231', '20270104').indexOf('2026–2027') >= 0);
});

console.log('[6] 2027 交易日历：全年数量、逐月分布、节假日边界、补班日');
check('2027 文件结构齐备，交易日严格升序、无重复、全部为 2027 年', () => {
  assert.strictEqual(CAL27.version, 1);
  assert.strictEqual(CAL27.year, 2027);
  assert.ok(Array.isArray(CAL27.tradingDays) && Array.isArray(CAL27.holidays));
  const days = CAL27.tradingDays;
  for (let i = 0; i < days.length; i++) {
    assert.ok(/^2027-\d{2}-\d{2}$/.test(days[i]), days[i]);
    if (i) assert.ok(days[i] > days[i - 1], '必须严格升序：' + days[i]);
  }
});
check('2027 交易日不含周六 / 周日（补班周末交易所也休市）', () => {
  for (const d of CAL27.tradingDays) {
    assert.notStrictEqual(dayOf(d), 0, d + ' 是周日');
    assert.notStrictEqual(dayOf(d), 6, d + ' 是周六');
  }
});
check('2027 全年 243 个交易日（261 个工作日 − 18 个工作日休市）', () => {
  assert.strictEqual(CAL27.tradingDays.length, 243);
});
check('2027 逐月交易日数：20/14/23/21/18/21/22/22/21/16/22/23', () => {
  const byMonth = {};
  for (const d of CAL27.tradingDays) {
    const m = d.slice(5, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  const expect = { '01': 20, '02': 14, '03': 23, '04': 21, '05': 18, '06': 21,
    '07': 22, '08': 22, '09': 21, '10': 16, '11': 22, '12': 23 };
  assert.deepStrictEqual(byMonth, expect);
});
check('官方通知标注的星期与真实日历一致（防止抄错年份/月份）', () => {
  const w = (d, day, label) => assert.strictEqual(dayOf(d), day, d + ' 应为 ' + label);
  w('2027-01-01', 5, '周五'); w('2027-02-05', 5, '周五'); w('2027-02-13', 6, '周六');
  w('2027-01-31', 0, '周日'); w('2027-02-14', 0, '周日'); w('2027-04-03', 6, '周六');
  w('2027-04-05', 1, '周一'); w('2027-05-01', 6, '周六'); w('2027-05-05', 3, '周三');
  w('2027-05-08', 6, '周六'); w('2027-06-09', 3, '周三'); w('2027-09-15', 3, '周三');
  w('2027-10-01', 5, '周五'); w('2027-10-07', 4, '周四'); w('2027-09-26', 0, '周日');
  w('2027-10-09', 6, '周六');
});
check('2027 节假日区间内的工作日全部休市', () => {
  const set = new Set(CAL27.tradingDays);
  ['2027-01-01', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11',
    '2027-02-12', '2027-04-05', '2027-05-03', '2027-05-04', '2027-05-05', '2027-06-09',
    '2027-09-15', '2027-10-01', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07']
    .forEach((d) => assert.ok(!set.has(d), d + ' 应休市'));
  assert.strictEqual(up.isTradingDay('20270101', CAL27), false);
});
check('元旦：节前最后 2026-12-31，节后首个 2027-01-04', () => {
  assert.ok(new Set(CAL.tradingDays).has('2026-12-31'));
  assert.strictEqual(up.isTradingDay('20261231', CAL), true);
  assert.strictEqual(up.isTradingDay('20270101', CAL27), false);
  assert.strictEqual(up.isTradingDay('20270104', CAL27), true);
});
check('春节：节前最后 2027-02-04，节后首个 2027-02-15', () => {
  assert.strictEqual(up.isTradingDay('20270204', CAL27), true);
  assert.strictEqual(up.isTradingDay('20270205', CAL27), false);
  assert.strictEqual(up.isTradingDay('20270215', CAL27), true);
});
check('清明：节前最后 2027-04-02，节后首个 2027-04-06', () => {
  assert.strictEqual(up.isTradingDay('20270402', CAL27), true);
  assert.strictEqual(up.isTradingDay('20270405', CAL27), false);
  assert.strictEqual(up.isTradingDay('20270406', CAL27), true);
});
check('劳动节：节前最后 2027-04-30，节后首个 2027-05-06', () => {
  assert.strictEqual(up.isTradingDay('20270430', CAL27), true);
  assert.strictEqual(up.isTradingDay('20270503', CAL27), false);
  assert.strictEqual(up.isTradingDay('20270506', CAL27), true);
});
check('端午：节前最后 2027-06-08，节后首个 2027-06-10', () => {
  assert.strictEqual(up.isTradingDay('20270608', CAL27), true);
  assert.strictEqual(up.isTradingDay('20270609', CAL27), false);
  assert.strictEqual(up.isTradingDay('20270610', CAL27), true);
});
check('中秋：节前最后 2027-09-14，节后首个 2027-09-16', () => {
  assert.strictEqual(up.isTradingDay('20270914', CAL27), true);
  assert.strictEqual(up.isTradingDay('20270915', CAL27), false);
  assert.strictEqual(up.isTradingDay('20270916', CAL27), true);
});
check('国庆：节前最后 2027-09-30，节后首个 2027-10-08', () => {
  assert.strictEqual(up.isTradingDay('20270930', CAL27), true);
  assert.strictEqual(up.isTradingDay('20271001', CAL27), false);
  assert.strictEqual(up.isTradingDay('20271008', CAL27), true);
});
check('调休补班日必须判为非交易日（1/31、2/14、5/8、9/26、10/9）', () => {
  ['2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09']
    .forEach((d) => {
      assert.strictEqual(up.isTradingDay(d.replace(/-/g, ''), CAL27), false, d + ' 补班但交易所休市');
      assert.ok(!new Set(CAL27.tradingDays).has(d), d + ' 不应出现在 tradingDays');
    });
});
check('2027 holidays 字段能覆盖上面全部休市区间（供人工核对）', () => {
  const names = CAL27.holidays.map((h) => h.name);
  assert.deepStrictEqual(names, ['元旦', '春节', '清明', '劳动节', '端午', '中秋', '国庆']);
  CAL27.holidays.forEach((h) => {
    assert.ok(h.from <= h.to, h.name + ' 区间倒置');
    assert.strictEqual(h.from.slice(0, 4), '2027');
  });
});

console.log('\n===== ' + pass + ' 通过 / ' + (process.exitCode ? '有失败' : '0 失败') + ' =====');
