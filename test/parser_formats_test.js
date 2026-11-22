// parser_formats_test.js —— 交割单解析回归
// 覆盖：横排 / 东海卡片式 / 时间优先竖排 / 方向词锚定逐单元格 / 同花顺 PC 横表
// 样本：本仓只使用合成样本（test/fixtures/synthetic），不含任何真实成交数据
// 用法：node test/parser_formats_test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parse } = require('../server/parser');
const { mockLines } = require('../server/ocr');

let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}
function load(name) {
  const p = path.join(__dirname, 'fixtures', 'synthetic', name);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(j.synthetic, true, '样本必须显式标注 synthetic: true');
  return j;
}

check('横排一行一笔（合成 Mock 版式）', () => {
  const r = parse(mockLines());
  assert.strictEqual(r.trades.length, 10);
  assert.strictEqual(r.meta.needs_fix_count, 1); // 09:45 那笔缺价格=预期低置信
  assert.strictEqual(r.trades[0].price, 8.6);
  assert.strictEqual(r.trades[0].qty, 900);
  assert.strictEqual(r.trades[0].amount, 7740);
});

check('时间优先竖排（旧格式不回归）', () => {
  const lines = [
    '2026-10-09',
    '09:34:55', '证券买入', '600001', '示例材料', '13.69', '900', '12321.00',
    '09:35:12', '证券买入', '600001', '示例材料', '13.52', '100', '1352.00',
  ];
  const r = parse(lines);
  assert.strictEqual(r.trades.length, 2);
  assert.strictEqual(r.trades[0].date, '2026-10-09');
  assert.strictEqual(r.trades[0].price, 13.69);
  assert.strictEqual(r.trades[0].qty, 900);
  assert.strictEqual(r.trades[1].amount, 1352);
});

// 合成样本：历史成交，名称→方向→价→量→时间→金额，两段日期表头
check('历史成交两段日期（合成样本，6 笔）', () => {
  const r = parse(load('sample1_ocr.json').lines);
  assert.strictEqual(r.trades.length, 6);
  assert.strictEqual(r.meta.needs_fix_count, 0);
  assert.strictEqual(r.meta.date_missing, false);
  assert.strictEqual(r.trades[0].date, '2026-09-18');
  assert.strictEqual(r.trades[0].time, '10:30:55');
  assert.strictEqual(r.trades[0].price, 52.31);
  assert.strictEqual(r.trades[0].qty, 100);
  assert.strictEqual(r.trades[0].amount, 5231);
  // 后一笔日期段必须切到第二个表头日期，且不被杂行污染
  const last = r.trades[r.trades.length - 1];
  assert.strictEqual(last.name, '示例银行');
  assert.strictEqual(last.side, '卖');
  assert.strictEqual(last.date, '2026-09-24');
  assert.strictEqual(last.amount, 5540);
});

// UP-1：东海证券版式的合成样本（只保留结构）
check('东海·历史成交卡片（表内有 20261102 日期）', () => {
  const r = parse([
    '甲公司', '12.345', '200', '买入', '买 20261102 09:31:00', '2469.00',
    '乙公司', '15.550', '300', '卖出', '卖 20261102 09:35:00', '4665.00',
  ]);
  assert.strictEqual(r.meta.layout, 'card');
  assert.strictEqual(r.trades.length, 2);
  assert.strictEqual(r.meta.date_missing, false);
  assert.strictEqual(r.trades[0].date, '2026-11-02');
  assert.strictEqual(r.trades[1].date, '2026-11-02');
  assert.strictEqual(r.meta.needs_fix_count, 0);
});

check('东海·当日成交（无日期列，只剩时间）', () => {
  const r = parse([
    '当日成交', '成交时间', '成交价', '成交量', '成交额',
    '甲公司', '12.345', '200', '买入', '买 09:35:57', '2469.00',
    '乙公司', '15.550', '300', '卖出', '卖 09:32:24', '4665.00',
  ]);
  assert.strictEqual(r.meta.layout, 'side_cells');
  assert.strictEqual(r.trades.length, 2);
  assert.strictEqual(r.meta.date_missing, true);
  assert.strictEqual(r.trades[0].date, null);
  assert.strictEqual(r.trades[0].time, '09:35:57');
  assert.strictEqual(r.trades[0].datePart, null);
});

check('历史成交只有 月-日 → 只带 datePart，年份交给前端推断', () => {
  const r = parse([
    '历史成交', '11-02',
    '甲公司', '12.345', '200', '买入', '09:31:00', '2469.00',
    '乙公司', '15.550', '300', '卖出', '09:35:00', '4665.00',
  ]);
  assert.strictEqual(r.meta.layout, 'side_cells');
  assert.strictEqual(r.meta.date_missing, true);
  assert.strictEqual(r.trades[0].date, null);
  assert.strictEqual(r.trades[0].datePart, '11-02');
  assert.strictEqual(r.trades[1].datePart, '11-02');
});

// P0 20261104：三位小数但小数位全零的价格（16.000）曾被 Number() 洗成整数 16
// → 被当成数量，价格缺失后由成交额反推成 100，复核页静默通过（100 股记成 16 股）
check('三位小数价格全零 16.000 / 100 / 1600.000 不得串位', () => {
  const r = parse([
    '甲公司', '16.000', '100', '卖出', '卖 20261103 09:32:16', '1600.000',
    '乙公司', '23.443', '700', '买入', '买 20261103 09:35:57', '16410.000',
  ]);
  assert.strictEqual(r.meta.layout, 'card');
  assert.strictEqual(r.meta.needs_fix_count, 0);
  assert.strictEqual(r.trades[0].price, 16);
  assert.strictEqual(r.trades[0].qty, 100);
  assert.strictEqual(r.trades[0].amount, 1600);
  assert.strictEqual(r.trades[0].low.price, false);
  assert.strictEqual(r.trades[0].low.qty, false);
  assert.strictEqual(r.trades[0].price * r.trades[0].qty, 1600); // 自洽，未被反推改写

  // 同一缺陷在 side_cells 分支（逐单元格三元组求解）
  const s = parse([
    '当日成交', '成交时间', '成交价', '成交量', '成交额',
    '甲公司', '16.000', '100', '卖出', '卖 09:32:16', '1600.000',
    '乙公司', '23.443', '700', '买入', '买 09:35:57', '16410.000',
  ]);
  assert.strictEqual(s.meta.layout, 'side_cells');
  assert.strictEqual(s.trades[0].price, 16);
  assert.strictEqual(s.trades[0].qty, 100);
  assert.strictEqual(s.trades[0].amount, 1600);
  assert.strictEqual(s.trades[0].price * s.trades[0].qty, 1600);
});

// 同花顺 PC 版「历史成交」横表（合成样本）：无「操作」列、无「成交数量」列，
// 日期 20261113 无分隔符；方向只能靠发生金额对账，数量只能靠成交金额÷成交均价。
check('同花顺PC·历史成交（16 笔，方向对账 + 数量反算）', () => {
  const r = parse(load('ths_pc_history_20261113.json').lines);
  assert.strictEqual(r.meta.layout, 'ths_pc');
  assert.strictEqual(r.trades.length, 16);
  assert.strictEqual(r.meta.needs_fix_count, 0);
  const t0 = r.trades[0];
  assert.strictEqual(t0.date, '2026-11-13');
  assert.strictEqual(t0.time, '10:41:40');
  assert.strictEqual(t0.code, '002088');
  assert.strictEqual(t0.name, '示例甲');
  assert.strictEqual(t0.side, '买');
  assert.strictEqual(t0.price, 9.28);
  assert.strictEqual(t0.qty, 100);
  assert.strictEqual(t0.amount, 928);
  // 发生金额符号决定方向：卖出为正、买入为负
  assert.strictEqual(r.trades[3].side, '卖');
  assert.strictEqual(r.trades[3].qty, 1100);
  assert.strictEqual(r.trades[8].side, '卖');
  assert.strictEqual(r.trades[8].qty, 1900);
  assert.strictEqual(r.trades[2].side, '卖');
  assert.strictEqual(r.trades[2].qty, 100);
});

check('同花顺PC·方向/数量读不准时不瞎猜', () => {
  const r = parse([
    '成交日期成交时间证券代码证券名称成交均价', '成交金额', '合同编号', '成交编号',
    '手续费', '印花税', '其他杂费', '发生金额', '交易市场', '市场名称',
    // 发生金额为 0：方向必须留空，不能默认买入
    '2026111310:41:40', '002088', '甲公司9.280', '928.0001001', '09999.…',
    '0.030', '0.000', '0.060', '0.000', 'SZ', '深圳A股',
    // 正常买入：-(1262.000 + 0.060 + 0.000 + 0.080) = -1262.140
    '2026111310:30:04', '603725', '乙公司12.620', '1262.0001002', '69999..',
    '0.060', '0.000', '0.080', '-1262.140', 'SH', '上海A股',
    // 成交金额÷均价除不尽：数量必须留空，不能四舍五入
    '2026111310:28:10', '600135', '丙公司6.913', '2764.0001003', '59999.',
    '0.140', '1.390', '0.170', '2762.300', 'SH', '上海A股',
  ]);
  assert.strictEqual(r.meta.layout, 'ths_pc');
  assert.strictEqual(r.trades.length, 3);
  assert.strictEqual(r.trades[0].side, null);
  assert.strictEqual(r.trades[0].low.mismatch, true);
  assert.strictEqual(r.trades[0].needs_fix, true);
  assert.strictEqual(r.trades[1].side, '买');
  assert.strictEqual(r.trades[1].qty, 100);
  assert.strictEqual(r.trades[2].side, '卖');
  assert.strictEqual(r.trades[2].qty, null);
  assert.strictEqual(r.trades[2].low.qty, true);
  assert.strictEqual(r.trades[2].needs_fix, true);
});

console.log('\n通过 ' + pass + '/9');
