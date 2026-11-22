// upload_test.js —— 批次 C 纯函数回归（12 计时/版式 / 13 午间快检 / 15 重复导入 / 16 导入历史）
// 用法：node test/upload_test.js
// 说明：不依赖 DOM、不联网；只测可在 Node 复算的口径与文案。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const up = require('../public/features/upload.js');
const { parse } = require('../server/parser');
const { mockLines } = require('../server/ocr');

let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

function trade(o) {
  return Object.assign({ date: '2026-10-28', time: '09:35:00', side: '买', price: 10, qty: 100, name: '测试标的', code: '600001' }, o);
}
function fakeStorage(init) {
  const m = Object.assign({}, init || {});
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
    removeItem(k) { delete m[k]; },
    _m: m,
  };
}
const BANNED = /别再买|不要再买|建议|应该|下次注意|又犯/;

console.log('[1] 13 今日累计：先按成交日筛，再按五要素去重');
check('同一笔重复两次（不同 importId）只算一笔', () => {
  const ledger = { trades: [trade({ importId: 'case_001' }), trade({ importId: 'case_001' })] };
  assert.strictEqual(up.todayTrades(ledger, '2026-10-28').length, 1);
});
check('时间写法 093500 与 09:35:00 归一后仍算同一笔', () => {
  const ledger = { trades: [trade({ time: '093500' }), trade({ time: '09:35:00' })] };
  assert.strictEqual(up.todayTrades(ledger, '20261028').length, 1);
});
check('只取当日成交，昨天的不算', () => {
  const ledger = { trades: [trade({ date: '2026-10-27' }), trade()] };
  assert.strictEqual(up.todayTrades(ledger, '2026-10-28').length, 1);
});
check('返回按成交时间升序（账本里常是倒序）', () => {
  const ledger = { trades: [trade({ time: '11:25:00' }), trade({ time: '09:35:00' })] };
  const out = up.todayTrades(ledger, '2026-10-28');
  assert.strictEqual(up.timeHM(out[0].time), '09:35');
});

console.log('[2] 13 午间快检：只陈述“第 N 笔 / 超过你定的 M 笔”');
check('第 4 笔买入超过上限 3 → 文案精确', () => {
  const trades = [
    trade({ time: '09:35:00', name: 'A' }),
    trade({ time: '10:02:00', name: 'B' }),
    trade({ time: '10:40:00', name: 'C' }),
    trade({ time: '11:25:00', name: 'D' }),
    trade({ time: '11:28:00', name: 'E', side: '卖', price: 11 }),
  ];
  const r = up.buildMiddayStatement({ trades, maxBuys: 3 });
  assert.ok(r, '应返回陈述');
  assert.strictEqual(r.text, '截至 11:25：第 4 笔买入，超过你定的 3 笔');
  assert.strictEqual(r.buys, 4);
  assert.strictEqual(r.sells, 1);
  assert.strictEqual(r.maxBuys, 3);
});
check('文案没有祈使/建议词（只陈述）', () => {
  const r = up.buildMiddayStatement({ trades: [trade(), trade({ time: '10:00' }), trade({ time: '10:30' }), trade({ time: '11:00' })], maxBuys: 3 });
  assert.ok(r);
  assert.ok(!BANNED.test(r.text), r.text);
});
check('未超过上限 → 不输出“超过”', () => {
  assert.strictEqual(up.buildMiddayStatement({ trades: [trade(), trade()], maxBuys: 3 }), null);
});
check('未勾 T06（maxBuys=0）→ 不陈述', () => {
  assert.strictEqual(up.buildMiddayStatement({ trades: [trade()], maxBuys: 0 }), null);
});
check('没有成交时间时用“今日”开头，不编时间', () => {
  const r = up.buildMiddayStatement({ trades: [trade({ time: '' }), trade({ time: '', name: 'B' }), trade({ time: '', name: 'C' }), trade({ time: '', name: 'D' })], maxBuys: 3 });
  assert.ok(r);
  assert.ok(r.text.startsWith('今日：'), r.text);
});

console.log('[3] 13 同一天第二次上传的判定');
check('今天已有上一批（不同 importId）→ 是第二次上传', () => {
  const ledger = { trades: [trade({ importId: 'case_001' }), trade({ time: '10:00', name: 'B', importId: 'case_002' })] };
  assert.strictEqual(up.isSecondUploadToday(ledger, 'case_002', '2026-10-28'), true);
});
check('今天只有本次导入 → 不是第二次', () => {
  const ledger = { trades: [trade({ importId: 'case_001' })] };
  assert.strictEqual(up.isSecondUploadToday(ledger, 'case_001', '2026-10-28'), false);
});
check('今天没有成交 → 不是第二次', () => {
  assert.strictEqual(up.isSecondUploadToday({ trades: [] }, 'case_001', '2026-10-28'), false);
});

console.log('[4] 15 重复导入提示');
check('added=0 → 精确提示“这批已在账本，本次未新增”', () => {
  const msg = up.repeatNotice({ added: 0, dup: 12 });
  assert.ok(msg.indexOf('这批已在账本，本次未新增') === 0, msg);
  assert.ok(msg.indexOf('12') >= 0, '应说明重复笔数');
});
check('added>0 且有重复 → 说明新增与去重', () => {
  assert.strictEqual(up.repeatNotice({ added: 5, dup: 2 }), '本次新增 5 笔，另有 2 笔与账本重叠、已去重');
});
check('added>0 且无重复 → 不打扰', () => {
  assert.strictEqual(up.repeatNotice({ added: 5, dup: 0 }), null);
});

console.log('[5] 16 导入历史：上限 200、最新在前');
check('超过 200 条只保留最近 200 条', () => {
  const imports = [];
  for (let i = 1; i <= 210; i++) {
    imports.push({
      id: 'case_' + i, at: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
      imported: 10, added: 1, dup: 9,
      coverageFrom: '20261001', coverageTo: '20261028',
    });
  }
  const rows = up.importsRows({ imports }, 200);
  assert.strictEqual(rows.length, 200);
  assert.strictEqual(rows[0].added, 1);
  assert.strictEqual(rows[rows.length - 1].at, imports[10].at); // 丢掉最早 10 条
});
check('时间/新增/重复/覆盖区间四列都在', () => {
  const rows = up.importsRows({ imports: [{ at: '2026-10-28T07:20:00.000Z', added: 4, dup: 1, imported: 5, coverageFrom: '20261008', coverageTo: '20261028' }] }, 200);
  assert.strictEqual(rows[0].added, 4);
  assert.strictEqual(rows[0].dup, 1);
  assert.strictEqual(rows[0].from, '2026-10-08');
  assert.strictEqual(rows[0].to, '2026-10-28');
  assert.ok(/\d{2}-\d{2} \d{2}:\d{2}/.test(rows[0].timeLabel), rows[0].timeLabel);
});
check('空账本 → 显示空态，不报错', () => {
  const html = up.importsSectionHtml(null);
  assert.ok(html.indexOf('导入历史') >= 0);
  assert.ok(html.indexOf('还没有导入记录') >= 0);
});
check('列表最多 200 条且带口径说明', () => {
  const imports = [];
  for (let i = 0; i < 205; i++) imports.push({ at: '2026-10-28T07:20:00.000Z', added: 1, dup: 0, coverageFrom: '20261028', coverageTo: '20261028' });
  const html = up.importsSectionHtml({ imports });
  assert.ok(html.indexOf('共 200 次') >= 0);
  assert.ok(html.indexOf('口径：每次确认算一次导入') >= 0);
  assert.strictEqual((html.match(/<li>/g) || []).length, 200);
});
check('渲染文案同样不含祈使/建议词', () => {
  const html = up.importsSectionHtml({ imports: [{ at: '2026-10-28T07:20:00Z', added: 1, dup: 1, coverageFrom: '20261028', coverageTo: '20261028' }] });
  assert.ok(!BANNED.test(html), html);
});

console.log('[6] 12 版式记忆');
check('写入后可读回（含时间戳）', () => {
  const st = fakeStorage();
  const w = up.setLayoutMemory('guangda', st, new Date('2026-10-28T03:00:00Z'));
  assert.strictEqual(w.ok, true);
  const r = up.getLayoutMemory(st);
  assert.strictEqual(r.layout, 'guangda');
  assert.ok(r.at);
});
check('没有 storage 时安全降级，不抛错', () => {
  assert.strictEqual(up.setLayoutMemory('card', null).ok, false);
});
check('版式标签可读（光大/普通）', () => {
  assert.strictEqual(up.layoutLabel('guangda'), '光大对账单（一笔两行）');
  assert.strictEqual(up.layoutLabel('horizontal'), '横排一行一笔');
  assert.strictEqual(up.layoutLabel('unknown'), '');
});

console.log('[7] 12 微信降级：不能用 navigator.clipboard.read，必须 contenteditable 接');
check('微信 UA 识别', () => {
  assert.strictEqual(up.isWeChatUA('Mozilla/5.0 (iPhone) MicroMessenger/8.0.47'), true);
  assert.strictEqual(up.isWeChatUA('Mozilla/5.0 Chrome/120'), false);
});
check('微信 UA 下禁用 clipboard.read（即使 API 存在）', () => {
  assert.strictEqual(up.shouldUseClipboardRead('MicroMessenger/8.0', true), false);
  assert.strictEqual(up.shouldUseClipboardRead('Chrome/120', true), true);
  assert.strictEqual(up.shouldUseClipboardRead('Chrome/120', false), false);
});
check('微信降级提示指向“长按粘贴”与“上传交割单截图”', () => {
  const t = up.pasteFallbackText('MicroMessenger/8.0');
  assert.ok(t.indexOf('长按') >= 0, t);
  assert.ok(t.indexOf('上传交割单截图') >= 0, t);
});
check('非微信降级提示也给出可完成动作', () => {
  assert.ok(up.pasteFallbackText('Chrome/120').indexOf('上传交割单截图') >= 0);
});

console.log('[8] 12 剪贴板/多图合并');
check('只收图片，忽略文本项', () => {
  const f = { name: 'a.png', type: 'image/png', size: 10 };
  const files = up.imageFilesFromClipboard({
    items: [
      { kind: 'file', type: 'image/png', getAsFile: () => f },
      { kind: 'string', type: 'text/plain' },
    ],
  });
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0], f);
});
check('items 不可用时退回 clipboardData.files', () => {
  const files = up.imageFilesFromClipboard({ files: [{ name: 'b.jpg', type: 'image/jpeg' }] });
  assert.strictEqual(files.length, 1);
});
check('多图结果按序合并成一批，scrubbed 累加，版式取首张', () => {
  const merged = up.mergeOcrResults([
    { mode: 'textin', trades: [trade({ time: '10:00' })], meta: { scrubbed_lines: 1, time_missing: false, layout: 'guangda' } },
    { mode: 'textin', trades: [trade({ time: '09:40', name: 'B' })], meta: { scrubbed_lines: 2, time_missing: false, layout: 'card' } },
  ]);
  assert.strictEqual(merged.trades.length, 2);
  assert.strictEqual(up.timeHM(merged.trades[0].time), '09:40');
  assert.strictEqual(merged.meta.scrubbed_lines, 3);
  assert.strictEqual(merged.meta.layout, 'guangda');
});

console.log('[9] 12 计时埋点');
check('view → ocr → report 三段耗时', () => {
  const t = up.timingSummary({ viewAt: 1000, ocrStartAt: 1500, reportAt: 9000 });
  assert.deepStrictEqual(t, { view_to_ocr_ms: 500, ocr_ms: 7500, total_ms: 8000 });
});
check('未开始 OCR 时不编造耗时', () => {
  const t = up.timingSummary({ viewAt: 1000, ocrStartAt: null, reportAt: null });
  assert.deepStrictEqual(t, { view_to_ocr_ms: null, ocr_ms: null, total_ms: null });
});

console.log('[10] 文案红线扫描');
check('13/14/15/16 输出里没有祈使/建议词', () => {
  const midday = up.buildMiddayStatement({ trades: [trade(), trade({ time: '10:00' }), trade({ time: '10:30' }), trade({ time: '11:00' })], maxBuys: 3 });
  const imports = up.importsSectionHtml({ imports: [{ at: '2026-10-28T07:20:00Z', added: 1, dup: 1, coverageFrom: '20261028', coverageTo: '20261028' }] });
  const gap = up.gapSectionHtml({ from: '2026-10-08', to: '2026-10-28', total: 2, gaps: [{ label: '10-15', hint: '补 10-15 的交割单截图' }, { label: '10-20', hint: '补 10-20 的交割单截图' }] });
  [midday.text, imports, gap, up.repeatNotice({ added: 0, dup: 3 })].forEach((s) => {
    assert.ok(!BANNED.test(s), s);
  });
});

console.log('[11] parser 只加 meta.layout，解析结果不变');
function layoutOf(lines) { return parse(lines).meta.layout; }
check('横排一行一笔 → horizontal', () => {
  assert.strictEqual(layoutOf(mockLines()), 'horizontal');
  assert.strictEqual(parse(mockLines()).trades.length, 10);
});
check('券商 APP 卡片式 → card', () => {
  const r = parse([
    '600519', '贵州茅台', '证券买入', '10.50', '100', '买 20261019 10：14：50', '1050',
    '000001', '平安银行', '证券卖出', '11.20', '200', '卖 20261019 10：20：30', '2240',
  ]);
  assert.strictEqual(r.meta.layout, 'card');
  assert.strictEqual(r.meta.trade_count, r.trades.length);
});
check('光大对账单（一笔两行）→ guangda', () => {
  const r = parse([
    '2026',
    '证券买入-测试甲', '12.140', '-3642.54', '买09-02 09:41', '300', '0.54',
    '证券买入-测试乙', '8.010', '-1602.00', '买09-02 10:02', '200', '0.54',
  ]);
  assert.strictEqual(r.meta.layout, 'guangda');
  assert.strictEqual(r.trades.length, 2);
});
check('逐单元格（历史成交版式）→ side_cells', () => {
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic', 'sample1_ocr.json'), 'utf8'));
  assert.strictEqual(sample.synthetic, true, '样本必须显式标注 synthetic: true');
  const r = parse(sample.lines);
  assert.strictEqual(r.meta.layout, 'side_cells');
  assert.strictEqual(r.trades.length, 6);
});
check('layout 值都能映射到可读标签（版式记忆只认这几种）', () => {
  ['horizontal', 'card', 'guangda', 'side_cells', 'vertical'].forEach((k) => {
    assert.ok(up.layoutLabel(k), k);
  });
});

// ============ [12] UP-1 日期推断 + 日期选择器 ============
const CAL = require('../public/trading_calendar_2026.json');
const CAL27 = require('../public/trading_calendar_2027.json');
const NOW = new Date(2026, 10, 4, 12, 47); // 2026-11-04 周三 12:47

function dailyBatch(n, extra) {
  const out = [];
  for (let i = 0; i < (n || 7); i++) {
    out.push(trade({ date: null, time: '09:35:57', price: 12.345, qty: 200, name: '测试标的', code: null, dateSource: null, datePart: null, low: { date: true } }));
  }
  return Object.assign({ trades: out }, extra || {});
}

console.log('\n[12] UP-1 日期推断 + 日期选择器');
check('当日成交无日期 → 推断为上传当天，并写清依据', () => {
  const d = dailyBatch(7);
  const sum = up.applyDateInference(d, { now: NOW, calendar: CAL });
  assert.strictEqual(sum.kind, 'inferred');
  assert.strictEqual(sum.date, '2026-11-04');
  assert.strictEqual(sum.missing, 0);
  assert.strictEqual(sum.scope, 'batch');
  d.trades.forEach((t) => {
    assert.strictEqual(t.date, '2026-11-04');
    assert.strictEqual(t.dateSource, 'inferred');
    assert.ok(t.dateReason.indexOf('当日成交表没有日期列') === 0, t.dateReason);
    assert.strictEqual(t.needs_fix, false);
  });
  assert.ok(sum.reason.indexOf('依据') === -1); // 依据由渲染层加前缀
});

check('收盘后上传（20:00）仍算当天', () => {
  const d = dailyBatch(2);
  const sum = up.applyDateInference(d, { now: new Date(2026, 10, 4, 20, 0), calendar: CAL });
  assert.strictEqual(sum.date, '2026-11-04');
  assert.ok(sum.reason.indexOf('已收盘') >= 0, sum.reason);
});

check('周六上传 → 回退最近交易日（周五）', () => {
  const d = dailyBatch(2);
  const sum = up.applyDateInference(d, { now: new Date(2026, 10, 7, 10, 0), calendar: CAL });
  assert.strictEqual(sum.date, '2026-11-06');
  assert.ok(sum.reason.indexOf('不是交易日') >= 0, sum.reason);
});

check('交易日开盘前（08:30）→ 仍算上一个交易日', () => {
  const d = dailyBatch(2);
  const sum = up.applyDateInference(d, { now: new Date(2026, 10, 9, 8, 30), calendar: CAL });
  assert.strictEqual(sum.date, '2026-11-06');
  assert.ok(sum.reason.indexOf('开盘前') >= 0, sum.reason);
});

check('法定假日（10/5 国庆）→ 回退到 9/30', () => {
  const d = dailyBatch(2);
  const sum = up.applyDateInference(d, { now: new Date(2026, 9, 5, 10, 0), calendar: CAL });
  assert.strictEqual(sum.date, '2026-09-30');
});

check('历史成交只有 月-日 → 补当前年份', () => {
  const d = { trades: [trade({ date: null, datePart: '11-02', time: '14:36:38' })] };
  const sum = up.applyDateInference(d, { now: NOW, calendar: CAL });
  assert.strictEqual(d.trades[0].date, '2026-11-02');
  assert.strictEqual(d.trades[0].dateSource, 'inferred');
  assert.ok(d.trades[0].dateReason.indexOf('按当前年份补全') >= 0, d.trades[0].dateReason);
  assert.strictEqual(sum.kind, 'inferred');
});

check('跨年边界：1 月看到 12-31 → 回退上一年', () => {
  const r = up.resolveMonthDay('12-31', new Date(2026, 0, 5, 10, 0));
  assert.strictEqual(r.date, '2025-12-31');
  assert.ok(r.reason.indexOf('上一年') >= 0, r.reason);
});

check('三种日期写法都能归一；非法日期要拒绝', () => {
  assert.strictEqual(up.parseDateInput('2026-11-04', NOW).date, '2026-11-04');
  assert.strictEqual(up.parseDateInput('20261104', NOW).date, '2026-11-04');
  assert.strictEqual(up.parseDateInput('11-04', NOW).date, '2026-11-04');
  assert.strictEqual(up.parseDateInput('2026/11/4', NOW).date, '2026-11-04');
  assert.strictEqual(up.parseDateInput('2026-02-30', NOW).ok, false);
  assert.strictEqual(up.parseDateInput('', NOW).ok, false);
});

check('整批日期联动：改一处全批跟着改，并回写 needs_fix', () => {
  const trades = [trade({ date: null }), trade({ date: null }), trade({ date: null })];
  const n = up.applyTradeDate(trades, 1, '2026-11-03', 'batch');
  assert.strictEqual(n, 3);
  trades.forEach((t) => {
    assert.strictEqual(t.date, '2026-11-03');
    assert.strictEqual(t.dateSource, 'manual');
    assert.strictEqual(t.needs_fix, false);
  });
});

check('历史各笔日期不同 → 只改当前笔', () => {
  const trades = [trade({ date: '2026-11-01' }), trade({ date: '2026-11-02' })];
  assert.strictEqual(up.summarizeDates(trades).scope, 'per');
  const n = up.applyTradeDate(trades, 0, '2026-10-31', 'per');
  assert.strictEqual(n, 1);
  assert.strictEqual(trades[0].date, '2026-10-31');
  assert.strictEqual(trades[1].date, '2026-11-02');
});

check('没有日期也没有时间 → 不推断、不默认今天，提示请选择', () => {
  const d = { trades: [trade({ date: null, time: null, low: { date: true, time: true } })] };
  const sum = up.applyDateInference(d, { now: NOW, calendar: CAL });
  assert.strictEqual(d.trades[0].date, '');
  assert.strictEqual(d.trades[0].dateSource, 'missing');
  assert.strictEqual(sum.kind, 'missing');
  assert.strictEqual(sum.date, '');
  const html = up.dateReviewHtml(d, { now: NOW, calendar: CAL });
  assert.ok(html.indexOf('日期未识别，请选择') >= 0);
  assert.ok(html.indexOf('不会默认成今天') >= 0);
});

check('部分笔缺日期 → 只留空那一笔，不静默补成同批日期', () => {
  const d = { trades: [trade({ date: '2026-11-02' }), trade({ date: null, time: null, low: { date: true } })] };
  const sum = up.applyDateInference(d, { now: NOW, calendar: CAL });
  assert.strictEqual(d.trades[0].date, '2026-11-02');
  assert.strictEqual(d.trades[0].dateSource, 'table');
  assert.strictEqual(d.trades[1].date, '');
  assert.strictEqual(d.trades[1].dateSource, 'missing');
  assert.strictEqual(sum.scope, 'per');
  assert.ok(up.dateReviewHtml(d, { now: NOW, calendar: CAL }).indexOf('只改当前笔') >= 0);
});

check('快捷 chips：今天/昨天/上周五/最近交易日', () => {
  const chips = up.dateChips(new Date(2026, 10, 4, 12, 47), CAL);
  assert.strictEqual(chips.length, 4);
  assert.deepStrictEqual(chips.map((c) => c.date), ['2026-11-04', '2026-11-03', '2026-10-30', '2026-11-04']);
  const sat = up.dateChips(new Date(2026, 10, 7, 10, 0), CAL);
  assert.strictEqual(sat.find((c) => c.key === 'lastFriday').date, '2026-11-06');
  assert.strictEqual(sat.find((c) => c.key === 'lastTrading').date, '2026-11-06');
});

check('推断面板文案含来源与依据，且不含祈使/建议词', () => {
  const d = dailyBatch(3);
  up.applyDateInference(d, { now: NOW, calendar: CAL });
  const html = up.dateReviewHtml(d, { now: NOW, calendar: CAL });
  assert.ok(html.indexOf('推断') >= 0);
  assert.ok(html.indexOf('依据：当日成交表没有日期列') >= 0);
  assert.ok(html.indexOf('应用到本批 3 笔') >= 0);
  assert.strictEqual(BANNED.test(html.replace(/<[^>]*>/g, ' ')), false);
});

console.log('\n[13] UP-1b 按年日历 + Asia/Shanghai 固定时刻');

const CAL_BUNDLE = up.makeCalendarBundle({ '2026': CAL, '2027': CAL27 });
const Z2027 = Date.UTC(2027, 0, 4, 2, 0); // 北京时间 2027-01-04（周一）10:00
const Z2028 = Date.UTC(2028, 0, 3, 2, 0); // 北京时间 2028-01-03（周一）10:00（2028 未收录）

check('cstParts：UTC 深夜 = 北京次日清晨（UTC+8，不看本机时区）', () => {
  const p = up.cstParts(Date.UTC(2026, 10, 3, 23, 30)); // 北京 2026-11-04 07:30
  assert.strictEqual(p.day8, '20261104');
  assert.strictEqual(p.hm, '07:30');
  assert.strictEqual(p.y, 2026);
  assert.strictEqual(p.mins, 7 * 60 + 30);
});

check('开盘前按北京时间判断：UTC 23:30 = 北京 07:30 → 回退上一个交易日', () => {
  const r = up.inferSessionDate(Date.UTC(2026, 10, 3, 23, 30), CAL);
  assert.strictEqual(r.date, '2026-11-03'); // 北京时间 11-04 开盘前 → 11-03（若按 UTC 会错成 11-02）
  assert.ok(r.reason.indexOf('07:30') >= 0, r.reason);
  assert.ok(r.reason.indexOf('Asia/Shanghai') >= 0, r.reason);
});

check('UTC 01:30 = 北京 09:30 → 按当天推断（边界时刻）', () => {
  const r = up.inferSessionDate(Date.UTC(2026, 10, 4, 1, 30), CAL);
  assert.strictEqual(r.date, '2026-11-04');
  assert.ok(r.reason.indexOf('09:30') >= 0, r.reason);
  assert.ok(r.reason.indexOf('已开盘') >= 0, r.reason);
});

check('注入毫秒时间戳：跨年补年按北京时间算（北京已到 1/5）', () => {
  const r = up.resolveMonthDay('12-31', Date.UTC(2026, 0, 4, 16, 30)); // 北京 2026-01-05 00:30
  assert.strictEqual(r.date, '2025-12-31');
  assert.ok(r.reason.indexOf('上一年') >= 0, r.reason);
});

check('跨时区子进程：UTC / 洛杉矶 / 上海推算结果完全一致', () => {
  const upPath = JSON.stringify(path.join(__dirname, '..', 'public', 'features', 'upload.js'));
  const calPath = JSON.stringify(path.join(__dirname, '..', 'public', 'trading_calendar_2026.json'));
  const code = 'const up=require(' + upPath + '),CAL=require(' + calPath + ');'
    + 'const a=up.inferSessionDate(Date.UTC(2026,10,3,23,30),CAL);'
    + 'const b=up.resolveMonthDay("12-31",Date.UTC(2026,0,4,16,30));'
    + 'process.stdout.write(JSON.stringify({date:a.date,monthDay:b.date,off:new Date(2026,0,1).getTimezoneOffset()}));';
  const outs = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map((tz) => {
    const raw = cp.execFileSync(process.execPath, ['-e', code], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { TZ: tz }),
    });
    return JSON.parse(raw);
  });
  // 结果（成交日 / 补年）与运行环境时区无关
  assert.deepStrictEqual(
    outs.map((o) => o.date + '|' + o.monthDay),
    ['2026-11-03|2025-12-31', '2026-11-03|2025-12-31', '2026-11-03|2025-12-31'],
  );
  // 若运行环境支持 TZ，时区偏移应不同；不支持时也不影响上面的推断一致性
  if (new Set(outs.map((o) => o.off)).size > 1) {
    assert.strictEqual(new Set(outs.map((o) => o.off)).size, 3);
  }
});

check('2027 已收录：元旦休市 → 节后首个交易日 1/4，无降级提示', () => {
  const cov = up.calCoverage(CAL_BUNDLE, 2027);
  assert.deepStrictEqual(cov, { covered: true, note: '' });
  assert.strictEqual(up.isTradingDay('20270101', CAL_BUNDLE), false); // 周五但元旦休市
  const r = up.inferSessionDate(Z2027, CAL_BUNDLE);
  assert.strictEqual(r.date, '2027-01-04');
  assert.strictEqual(r.reason.indexOf('尚未收录'), -1);
});

check('缺年降级：2028 未收录 → 只按周一~五，并给出显式文案', () => {
  const cov = up.calCoverage(CAL_BUNDLE, 2028);
  assert.strictEqual(cov.covered, false);
  assert.ok(cov.note.indexOf('2028 年节假日安排尚未收录') >= 0, cov.note);
  assert.ok(cov.note.indexOf('仅按周一至周五判断') >= 0, cov.note);
  const r = up.inferSessionDate(Z2028, CAL_BUNDLE);
  assert.strictEqual(r.date, '2028-01-03'); // 周一，按周一到五规则算交易日
  assert.ok(r.reason.indexOf('2028 年节假日安排尚未收录') >= 0, r.reason);
});

check('缺年不静默：复核面板同样展示降级说明', () => {
  const d = dailyBatch(2);
  up.applyDateInference(d, { now: Z2028, calendar: CAL_BUNDLE });
  const html = up.dateReviewHtml(d, { now: Z2028, calendar: CAL_BUNDLE });
  assert.ok(html.indexOf('2028 年节假日安排尚未收录') >= 0, '面板应明说缺年');
  assert.ok(html.indexOf('仅按周一至周五判断') >= 0, '面板应说明降级口径');
});

check('已收录年份（2026）不出现降级提示', () => {
  assert.deepStrictEqual(up.calCoverage(CAL_BUNDLE, 2026), { covered: true, note: '' });
  const d = dailyBatch(2);
  up.applyDateInference(d, { now: NOW, calendar: CAL_BUNDLE });
  const html = up.dateReviewHtml(d, { now: NOW, calendar: CAL_BUNDLE });
  assert.strictEqual(html.indexOf('尚未收录'), -1);
});

check('按年入口：2026/2027 已登记；2028 走缺年降级，不偷偷当工作日', () => {
  assert.deepStrictEqual(up.CAL_KNOWN_YEARS, [2026, 2027]);
  assert.strictEqual(up.calHasYear(CAL_BUNDLE, 2026), true);
  assert.strictEqual(up.calHasYear(CAL_BUNDLE, 2027), true);
  assert.strictEqual(up.calHasYear(CAL_BUNDLE, 2028), false);
  assert.strictEqual(up.calendarUrl(2026), 'trading_calendar_2026.json');
  assert.strictEqual(up.calendarUrl(2027), 'trading_calendar_2027.json');
  // 2027-01-02 是周六 → 休市；2027-01-05 是普通工作日 → 开市
  assert.strictEqual(up.isTradingDay('20270102', CAL_BUNDLE), false);
  assert.strictEqual(up.isTradingDay('20270105', CAL_BUNDLE), true);
});

check('缺口口径的年份标签：单年 2026，跨年显示区间', () => {
  assert.strictEqual(up.calYearsLabel('20261104', '20261104'), '2026');
  assert.strictEqual(up.calYearsLabel('20261231', '20270104'), '2026–2027');
});

console.log('\n[14] UP-2 逐笔推断 / 三态文案 / 缺时间笔手选');

// 北京时间 2026-11-04 02:25（周三，开盘前）→ 应推断到上一个交易日 2026-11-03
const NOW_OPEN = Date.UTC(2026, 10, 3, 18, 25);
function dayBatch(times) {
  return {
    trades: times.map((tm, i) => trade({
      date: null, time: tm, name: '测试标的' + (i + 1),
      dateSource: null, datePart: null, low: { date: true },
    })),
  };
}
const OLD_DAY_TEXT = '表里没有日期，也没有可推断的成交时间';

check('7 笔里 1 笔无时间 → 6 笔 inferred、1 笔 missing，逐笔推断不整批连坐', () => {
  const d = dayBatch(['09:35:57', '09:35:57', '09:32:24', '09:32:16', '09:31:54', '09:31:41', null]);
  const sum = up.applyDateInference(d, { now: NOW_OPEN, calendar: CAL });
  assert.strictEqual(sum.count, 7);
  assert.strictEqual(sum.missing, 1, '只应有 1 笔缺日期，不能整批 missing');
  assert.strictEqual(sum.inferred, 6);
  assert.strictEqual(sum.scope, 'missing');
  d.trades.slice(0, 6).forEach((t) => {
    assert.strictEqual(t.date, '2026-11-03'); // 与注入的 now（开盘前）自洽
    assert.strictEqual(t.dateSource, 'inferred');
    assert.strictEqual(t.needs_fix, false);
  });
  const last = d.trades[6];
  assert.strictEqual(last.date, '');
  assert.strictEqual(last.dateSource, 'missing');
  assert.strictEqual(last.needs_fix, true);
});

check('三态文案（全有）：按成交时间推断为 2026-11-03', () => {
  const d = dayBatch(['09:35:57', '09:32:24', '09:30:01']);
  up.applyDateInference(d, { now: NOW_OPEN, calendar: CAL });
  const html = up.dateReviewHtml(d, { now: NOW_OPEN, calendar: CAL });
  assert.ok(html.indexOf('当日成交表没有日期列；按成交时间推断为 2026-11-03。') >= 0, html);
  assert.ok(html.indexOf(OLD_DAY_TEXT) < 0, '旧文案不应再出现');
});

check('三态文案（部分）：本批 4 笔中 3 笔可推断，第 4 笔缺成交时间需要手选', () => {
  const d = dayBatch(['09:35:57', '09:32:24', '09:31:41', null]);
  up.applyDateInference(d, { now: NOW_OPEN, calendar: CAL });
  const html = up.dateReviewHtml(d, { now: NOW_OPEN, calendar: CAL });
  assert.ok(html.indexOf('本批 4 笔中 3 笔可按成交时间推断为 2026-11-03，第 4 笔缺成交时间，需要手选。') >= 0, html);
  assert.ok(html.indexOf(OLD_DAY_TEXT) < 0, '旧文案不应再出现');
});

check('三态文案（全无）：请手动选择日期，不默认今天', () => {
  const d = dayBatch([null, null]);
  up.applyDateInference(d, { now: NOW_OPEN, calendar: CAL });
  const html = up.dateReviewHtml(d, { now: NOW_OPEN, calendar: CAL });
  assert.ok(html.indexOf('当日成交表没有日期列，也没有可推断的成交时间；请手动选择日期。') >= 0, html);
  assert.ok(html.indexOf(OLD_DAY_TEXT) < 0, '旧文案不应再出现');
  d.trades.forEach((t) => assert.strictEqual(t.date, ''));
});

check('缺时间笔的 chips 只补这一笔，改完 dateSource=manual', () => {
  const d = dayBatch(['09:35:57', '09:32:24', '09:31:41', null]);
  const sum = up.applyDateInference(d, { now: NOW_OPEN, calendar: CAL });
  assert.strictEqual(sum.scope, 'missing');
  const html = up.dateReviewHtml(d, { now: NOW_OPEN, calendar: CAL });
  assert.ok(html.indexOf('data-date-quick') >= 0, '复核页应给出日期 chips');
  assert.ok(html.indexOf('id="c-date-pick"') >= 0, '复核页应给出日期选择控件');
  const n = up.applyTradeDate(d.trades, 3, '2026-11-03', sum.scope);
  assert.strictEqual(n, 1, '只应补 1 笔');
  assert.strictEqual(d.trades[3].dateSource, 'manual');
  assert.strictEqual(d.trades[3].needs_fix, false);
  d.trades.slice(0, 3).forEach((t) => assert.strictEqual(t.dateSource, 'inferred'));
  assert.ok(up.dateReviewHtml(d, { now: NOW_OPEN, calendar: CAL }).indexOf('已手动选择日期') >= 0);
});

check('推断日不一致（开盘前后）→ 按笔保留，不强行统一', () => {
  const NOW_0931 = Date.UTC(2026, 10, 4, 1, 31); // 北京 09:31
  const d = dayBatch(['09:30:01', '09:35:57']);
  const sum = up.applyDateInference(d, { now: NOW_0931, calendar: CAL });
  assert.strictEqual(d.trades[0].date, '2026-11-04');
  assert.strictEqual(d.trades[1].date, '2026-11-03'); // 晚于当前时刻 → 上一个交易日
  assert.strictEqual(sum.scope, 'per');
  assert.strictEqual(sum.mainDate, '2026-11-04'); // 面板以多数笔的推断日为准
  const html = up.dateReviewHtml(d, { now: NOW_0931, calendar: CAL });
  assert.ok(html.indexOf('已按笔保留') >= 0, html);
});

console.log('\n===== ' + pass + ' 通过 / ' + (process.exitCode ? '有失败' : '0 失败') + ' =====');
