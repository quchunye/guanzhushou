// test/migrate_test.js —— 档案迁移 v1 单测（纯 Node，无浏览器）
// 覆盖：sha 正确性 / 导出信封 / 篡改 / 未知 key / 旧 schema / 合并与覆盖 / 重复导入 / 超大拒绝 / 非法成交 / 加密备份 / 二维码评估
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const M = require(path.join(__dirname, '..', 'public', 'features', 'migrate.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(name, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(name, sa === sb, sa + ' !== ' + sb);
}
function throwsMsg(name, fn, expect) {
  try { fn(); ok(name, false, '未抛出'); }
  catch (e) { ok(name, String(e.message || e).indexOf(expect) >= 0, String(e.message || e).slice(0, 120)); }
}

// ---- 内存 storage（实现 length/key，供 quota 估算走全量路径）----
function memStorage(init) {
  const m = new Map();
  Object.keys(init || {}).forEach((k) => m.set(k, String(init[k])));
  return {
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] || null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _dump() { const o = {}; m.forEach((v, k) => { o[k] = v; }); return o; },
  };
}

// ---- 固定夹具：多账户账本 + 2 个真实档案 + 其余档案 key ----
function fixture() {
  const t = (date, time, code, side, price, qty, account, extra) => Object.assign({
    date, time, code, name: code === '600519' ? '贵州茅台' : '测试股', side, price, qty, account,
  }, extra || {});
  const ledger = {
    trades: [
      t('2026-10-08', '09:31:05', '600519', '买入', 1680.5, 100, 'main', { firstSeen: '2026-10-08T01:31:05.000Z', importId: 'imp_a' }),
      t('2026-10-08', '10:02:11', '600519', '卖出', 1701.0, 100, 'main'),
      t('2026-10-09', '09:45:00', '000001', '买入', 11.23, 2000, 'main'),
      t('2026-10-09', '14:20:30', '000001', '卖出', 11.05, 2000, 'main'),
      t('2026-10-10', '09:33:18', '300750', '买入', 205.6, 300, 'main'),
      t('2026-10-10', '13:10:09', '300750', '卖出', 209.8, 300, 'main'),
      t('2026-10-11', '09:30:55', '601318', '买入', 48.2, 1000, 'alt', { note: '第二账户' }),
      t('2026-10-11', '10:15:42', '601318', '卖出', 47.6, 1000, 'alt'),
    ],
    imports: [{ id: 'imp_a', at: '2026-10-08T09:00:00.000Z', source: 'fixture', added: 8, merged: 0, skipped: 0, unparsed: 0 }],
    dupLog: [{ date: '2026-10-08', key: 'k1', at: '2026-10-08T09:00:00.000Z' }],
  };
  const c1 = {
    id: 'case_001', n: 1, at: '2026-10-09T12:00:00.000Z', date: '2026-10-08', createdAt: '2026-10-09T12:00:00.000Z',
    trades: [ledger.trades[0], ledger.trades[1]],
    verdict: { hard: 1, soft: 0, pass: false, lines: [
      { rule: '不追高', text: '追高买入', hard: true, trade: 0, account: 'main' },
      { rule: '按计划', text: '卖出符合计划', hard: false, trade: 1, account: 'main' },
    ] },
    rules: [{ id: 'r1', text: '不追高' }],
    mood: { before: '急', after: '稳' },
    note: '第一份真实档案',
  };
  const c2 = {
    id: 'case_002', n: 2, at: '2026-10-11T15:30:00.000Z', date: '2026-10-11',
    trades: [ledger.trades[6], ledger.trades[7]],
    verdict: { hard: 0, soft: 1, pass: false, lines: [
      { rule: '不逆势加仓', text: '亏损卖出', hard: false, trade: 1, account: 'alt' },
    ] },
    rules: [{ id: 'r2', text: '不逆势加仓' }], mood: { before: '慌', after: '平' }, note: '第二账户档案',
  };
  return {
    data: {
      guanzhu_case_001: c1,
      guanzhu_case_002: c2,
      guanzhu_case_seq: 2,
      guanzhu_ledger: ledger,
      guanzhu_rules_v1: [{ id: 'r1', text: '不追高' }, { id: 'r2', text: '不逆势加仓' }],
      guanzhu_recur_v1: { 'r1': { n: 1, last: '2026-10-09' }, 'r2': { n: 1, last: '2026-10-11' } },
      guanzhu_exempt_v1: { '20261008|093105|600519|买入|1680.500|100|main': 1 },
      guanzhu_reason_v1: { '20261008|093105|600519|买入|1680.500|100|main': { code: 'chase', text: '怕错过' } },
      guanzhu_stop_v1: { '20261008|093105|600519|买入|1680.500|100|main': 1680 },
      guanzhu_focus_v1: { code: '600519' },
      guanzhu_note_v1: { '2026-10-08': '今日复盘' },
      guanzhu_mood_v1: { '2026-10-08': { before: '急', after: '稳' } },
      guanzhu_rules_hist_v1: [{ at: '2026-10-08T00:00:00.000Z', rules: [] }],
      guanzhu_pos_v1: { '600519': 0 },
      guanzhu_cash_v1: { balance: 100000, updatedAt: '2026-10-11T00:00:00.000Z' },
      guanzhu_upload_layout_v1: { v: 2, boxes: [] },
      guanzhu_recall_v1: { last: '2026-10-11' },
      guanzhu_ack_v1: { '2026-10-09': 1 },
      guanzhu_ack_txt_v1: { '2026-10-09': '已知悉' },
      guanzhu_openplan_v1: { text: '明日只看不动' },
      guanzhu_month_v1: { '2026-10': { reviews: 2 } },
      guanzhu_collection_v1: { unlocked: ['case_001'] },
      guanzhu_wizard_seen_v1: true,
    },
    ledger,
    c1,
    c2,
  };
}

function seed(st, data) {
  Object.keys(data).forEach((k) => st.setItem(k, JSON.stringify(data[k])));
}

// ================= 1. SHA-256 =================
console.log('\n[1] SHA-256 与规范化');
const oracle = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
['', 'abc', '中文档案', '盘纪🧊', 'a'.repeat(1000), '多字节：买入卖出😀'].forEach((s) => {
  ok('sha256 与 Node crypto 一致: ' + JSON.stringify(s.slice(0, 12)), M.sha256Hex(s) === oracle(s), M.sha256Hex(s));
});
ok('sha256 空串固定值', M.sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
ok('sha256 abc 固定值', M.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
eq('规范化与键序无关', M.canonicalStringify({ b: 1, a: { d: 2, c: [3, 4] } }), M.canonicalStringify({ a: { c: [3, 4], d: 2 }, b: 1 }));
ok('规范化数组顺序敏感', M.canonicalStringify([1, 2]) !== M.canonicalStringify([2, 1]));
ok('computeSha 忽略键序', M.computeSha({ b: 1, a: 2 }) === M.computeSha({ a: 2, b: 1 }));

// ================= 2. 导出信封 =================
console.log('\n[2] 导出信封');
const st = memStorage();
const fx = fixture();
seed(st, fx.data);
M.configure({ storage: st, ledger: null, recur: null });

const exp = M.buildExport({ now: new Date('2026-11-06T03:00:00.000Z') });
ok('buildExport 成功', exp.ok === true, JSON.stringify(exp).slice(0, 160));
ok('文件名带时间戳', exp.filename === 'panji-migrate-20261106-110000.json', exp.filename);
eq('导出条目数 keys/trades/cases', exp.counts, { keys: 23, trades: 8, cases: 2 });
const env = JSON.parse(exp.json);
eq('信封 app/kind/schema/version', [env.app, env.kind, env.schema, env.schemaVersion], ['guanzhushou', 'panji-migrate', 'panji.migrate.v1', 1]);
ok('信封带导出时间', /^2026-11-06T03:00:00\.000Z$/.test(env.exportedAt), env.exportedAt);
ok('信封带 sha256', env.sha256 === M.computeSha(env.data), env.sha256);
ok('信封不含设备开关/支付 key', !('guanzhu_flags_v1' in env.data) && !('guanzhu_client_token' in env.data) && !('guanzhu_pending_pay' in env.data));
ok('EXCLUDED 有原因说明', Object.keys(M.EXCLUDED).length >= 3 && typeof M.EXCLUDED['guanzhu_flags_v1'] === 'string');
ok('导出字节数 = JSON 字节', exp.bytes === M.byteLen(exp.json), exp.bytes);

// ================= 3. 校验 / 篡改 =================
console.log('\n[3] 校验与篡改');
const v1 = M.verifyExport(exp.json);
ok('原始包校验通过', v1.ok === true && v1.sha256 === env.sha256);
eq('校验后条目数', v1.counts, { keys: 23, trades: 8, cases: 2 });
const tampered = JSON.parse(exp.json);
tampered.data.guanzhu_case_001.note = '被改过';
const v2 = M.verifyExport(JSON.stringify(tampered));
ok('篡改内容 → sha 不匹配', v2.ok === false && v2.error === 'sha_mismatch', JSON.stringify(v2));
ok('sha 错误文案含校验失败', M.errorText('sha_mismatch').indexOf('校验不通过') >= 0);
const unknown = JSON.parse(exp.json);
unknown.data['evil_key'] = 1;
const v3 = M.verifyExport(JSON.stringify(unknown));
ok('未知 key 拒绝', v3.ok === false && v3.error === 'key_not_allowed' && v3.keys[0] === 'evil_key');
ok('非法 JSON 拒绝', M.verifyExport('{bad').error === 'json_invalid');
ok('非本产品文件拒绝', M.verifyExport(JSON.stringify({ kind: 'other', data: {} })).error === 'kind_invalid');
const badApp = JSON.parse(exp.json); badApp.app = 'x';
ok('app 不符拒绝', M.verifyExport(JSON.stringify(badApp)).error === 'app_invalid');
const badSchema = JSON.parse(exp.json); badSchema.schema = 'panji.migrate.v2';
ok('未知 schema 拒绝', M.verifyExport(JSON.stringify(badSchema)).error === 'schema_unsupported');
const decl = JSON.parse(exp.json); decl.counts = { keys: 1, trades: 1, cases: 1 };
const v4 = M.verifyExport(JSON.stringify(decl));
ok('声明条目数不符 → 仅告警不拒绝', v4.ok === true && v4.warnings.join('').indexOf('不一致') >= 0);
ok('缺 sha → 告警但可读（旧包路径）', M.verifyExport(JSON.stringify({ kind: 'panji-migrate', app: 'guanzhushou', schemaVersion: 0, data: {} })).ok === true);
ok('空 data 可校验', M.verifyExport(JSON.stringify({ app: 'guanzhushou', kind: 'panji-migrate', schema: 'panji.migrate.v1', schemaVersion: 1, data: {} })).ok === true);

// ================= 4. 旧 schema =================
console.log('\n[4] 旧 schema 缺字段');
const legacy = {
  kind: 'panji-backup', v: 2, exportedAt: '2026-09-01T00:00:00.000Z', counts: { keys: 4, trades: 2, cases: 1 },
  data: {
    guanzhu_case_001: {
      id: 'case_001', n: 1, at: '2026-09-01T00:00:00.000Z',
      trades: [{ date: '2026-08-31', time: '09:30:00', code: '600000', name: '浦发银行', side: '买入', price: 9.1, qty: 100 }],
      verdict: { lines: [{ rule: '旧规则', hard: true, text: '旧数据', trade: 0 }] },
    },
    guanzhu_case_seq: 1,
    guanzhu_ledger: { trades: [{ date: '2026-08-31', time: '09:30:00', code: '600000', name: '浦发银行', side: '买入', price: 9.1, qty: 100 }] },
    guanzhu_exempt_v1: { '20260831|093000|600000|买入|9.100|100|': 1 },
  },
};
const v5 = M.verifyExport(legacy);
ok('旧备份可读', v5.ok === true && v5.legacy === true);
ok('旧备份 account 补 default', v5.data.guanzhu_ledger.trades[0].account === 'default');
ok('旧备份案例 trades 补 account', v5.data.guanzhu_case_001.trades[0].account === 'default');
ok('旧备份 verdict.lines 补 account', v5.data.guanzhu_case_001.verdict.lines[0].account === 'default');
eq('旧备份账本补 imports/dupLog', [v5.data.guanzhu_ledger.imports, v5.data.guanzhu_ledger.dupLog], [[], []]);
ok('旧备份 tk6 键补第 7 段', Object.keys(v5.data.guanzhu_exempt_v1)[0] === '20260831|093000|600000|买入|9.100|100|default');
ok('旧备份有补字段提示', v5.warnings.join('').indexOf('默认值补齐') >= 0);
ok('加密旧备份明确拒绝', M.verifyExport({ kind: 'panji-backup', encrypted: true, data: {} }).error === 'encrypted_unsupported');
ok('加密拒绝文案指向备份面板', M.errorText('encrypted_unsupported').indexOf('备份面板') >= 0);

// ================= 5. 往返一致（导入空库） =================
console.log('\n[5] 导出→导入往返');
const stB = memStorage();
M.configure({ storage: stB });
const plan0 = M.planImport(v1.data, { strategy: 'merge' });
ok('空库计划可执行', plan0.ok === true);
eq('空库计划计数', plan0.summary.counts, { keys: 23, trades: 8, cases: 2 });
ok('空库计划新增 8 笔', plan0.summary.ledger.added === 8 && plan0.summary.ledger.dup === 0);
ok('空库计划新增 2 档案', plan0.summary.cases.added === 2 && plan0.summary.cases.skipped === 0);
const app0 = M.applyImport(v1.data, { strategy: 'merge' });
ok('空库导入成功', app0.ok === true && app0.written === Object.keys(app0.writes).length, JSON.stringify(app0).slice(0, 120));

const back = {};
Object.keys(stB._dump()).forEach((k) => { back[k] = JSON.parse(stB._dump()[k]); });
// 逐字段递归比对
let compared = 0, diffs = [];
function walk(a, b, p) {
  if (a === b) { compared++; return; }
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    diffs.push(p + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { diffs.push(p + ': array类型不同'); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) { diffs.push(p + '.length ' + a.length + ' ≠ ' + b.length); return; }
    a.forEach((x, i) => walk(x, b[i], p + '[' + i + ']')); return;
  }
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) { diffs.push(p + ' 键集不同'); return; }
  ka.forEach((k) => walk(a[k], b[k], p + '.' + k));
}
Object.keys(v1.data).sort().forEach((k) => walk(v1.data[k], back[k], k));
ok('往返后 key 集完全一致', Object.keys(v1.data).sort().join(',') === Object.keys(back).sort().join(','), Object.keys(back).join(','));
ok('往返逐字段一致（0 差异）', diffs.length === 0, diffs.slice(0, 3).join(' | '));
ok('往返比对字段数 > 100', compared > 100, String(compared));
console.log('  往返比对字段数: ' + compared + '，差异: ' + diffs.length);

// ================= 6. 重复导入 =================
console.log('\n[6] 重复导入');
const dup = M.planImport(v1.data, { strategy: 'merge' });
ok('重复导入 0 写入计划', dup.ok === true && typeof dup.writes === 'object' && Object.keys(dup.writes).length === 0, JSON.stringify(dup.summary));
ok('重复导入账本新增 0 / 重复 8', dup.summary.ledger.added === 0 && dup.summary.ledger.dup === 8);
ok('重复导入案例全跳过', dup.summary.cases.skipped === 2 && dup.summary.cases.added === 0);
ok('重复导入 duplicateOnly', dup.summary.duplicateOnly === true);
const dupApply = M.applyImport(v1.data, { strategy: 'merge' });
ok('重复导入无写入 / noChange', dupApply.ok === true && dupApply.noChange === true && dupApply.written === 0);
ok('重复导入有提示文案', dup.warnings.join('').indexOf('已存在') >= 0);

// ================= 7. 冲突：合并追加 vs 覆盖 =================
console.log('\n[7] 冲突策略');
const stC = memStorage();
seed(stC, fx.data);
M.configure({ storage: stC });
const incoming = { guanzhu_case_001: Object.assign({}, fx.c1, { note: '另一台设备的同名档案' }), guanzhu_case_seq: 2 };
const pMerge = M.planImport(incoming, { strategy: 'merge' });
ok('合并：同编号不同内容', pMerge.ok === true);
ok('合并：追加为新档案 case_003', pMerge.summary.cases.appended === 1 && pMerge.writes.guanzhu_case_003, JSON.stringify(pMerge.summary.cases));
ok('合并：本机 case_001 不动', !pMerge.writes.guanzhu_case_001);
ok('合并：案例编号升到 3', pMerge.writes.guanzhu_case_seq === 3);
const aMerge = M.applyImport(incoming, { strategy: 'merge' });
ok('合并落盘后本机原档案保留', JSON.parse(stC.getItem('guanzhu_case_001')).note === '第一份真实档案');
ok('合并落盘后新档案存在', JSON.parse(stC.getItem('guanzhu_case_003')).note === '另一台设备的同名档案');
const pOver = M.planImport(incoming, { strategy: 'overwrite' });
ok('覆盖：同编号直接覆盖', pOver.summary.cases.overwritten === 1 && pOver.writes.guanzhu_case_001);
const aOver = M.applyImport(incoming, { strategy: 'overwrite' });
ok('覆盖落盘后内容替换', JSON.parse(stC.getItem('guanzhu_case_001')).note === '另一台设备的同名档案');

// ================= 8. 合并账本去重 =================
console.log('\n[8] 账本合并去重');
const stD = memStorage();
seed(stD, { guanzhu_ledger: { trades: [fx.ledger.trades[0]], imports: [], dupLog: [] } });
M.configure({ storage: stD });
const pL = M.planImport(v1.data, { strategy: 'merge' });
ok('账本合并老笔重复 1 笔', pL.summary.ledger.dup === 1 && pL.summary.ledger.added === 7, JSON.stringify(pL.summary.ledger));
ok('合并后成交 8 笔', pL.writes.guanzhu_ledger.trades.length === 8);
const pLOver = M.planImport(v1.data, { strategy: 'overwrite' });
ok('覆盖策略账本整体替换', pLOver.writes.guanzhu_ledger.trades.length === 8 && pLOver.summary.ledger.replaced === 1);

// ================= 9. 超大拒绝 =================
console.log('\n[9] 超大档案拒绝');
const stBig = memStorage();
seed(stBig, { guanzhu_ledger: fx.ledger, guanzhu_case_seq: 2, guanzhu_case_001: fx.c1, guanzhu_case_002: fx.c2,
  guanzhu_note_v1: { blob: 'x'.repeat(4 * 1024 * 1024) } });
M.configure({ storage: stBig });
const bigExp = M.buildExport({ now: new Date('2026-11-06T03:00:00.000Z') });
ok('超过 3.5MB → 拒绝导出', bigExp.ok === false && bigExp.error === 'too_large', JSON.stringify(bigExp).slice(0, 120));
ok('拒绝导出带实际字节数', bigExp.bytes > M.LIMIT_BYTES && bigExp.limit === M.LIMIT_BYTES);
ok('超大导出文案可执行', M.errorText('too_large').indexOf('3.5MB') >= 0 && M.errorText('too_large').indexOf('CSV') >= 0);

const stNear = memStorage({ other_big: 'y'.repeat(3.45 * 1024 * 1024) });
M.configure({ storage: stNear });
const hugeIn = { guanzhu_note_v1: { blob: 'z'.repeat(300 * 1024) } };
const pHuge = M.planImport(hugeIn, { strategy: 'merge' });
ok('导入后超限 → 拒绝写入', pHuge.ok === false && pHuge.error === 'quota_exceeded', JSON.stringify(pHuge).slice(0, 120));
ok('超限拒绝带字节', pHuge.bytes > M.LIMIT_BYTES);
ok('超限文案可执行', M.errorText('quota_exceeded').indexOf('3.5MB') >= 0);
ok('超限时不产生写入', !pHuge.writes);

// ================= 10. 非法结构 =================
console.log('\n[10] 非法结构与边界');
M.configure({ storage: memStorage() });
ok('账本 trades 非数组 → 拒绝', M.verifyExport({ kind: 'panji-migrate', app: 'guanzhushou', schema: 'panji.migrate.v1', schemaVersion: 1, data: { guanzhu_ledger: { trades: 5 } } }).error === 'ledger_invalid');
ok('非法成交 → trade_invalid', M.verifyExport({ kind: 'panji-migrate', app: 'guanzhushou', schema: 'panji.migrate.v1', schemaVersion: 1, data: { guanzhu_ledger: { trades: [{ date: '2026-01-01', side: '', price: 1, qty: 1 }] } } }).error === 'trade_invalid');
ok('非法成交报下标', M.verifyExport({ kind: 'panji-migrate', app: 'guanzhushou', schema: 'panji.migrate.v1', schemaVersion: 1, data: { guanzhu_ledger: { trades: [{ date: '2026-01-01', side: '买入', price: 0, qty: 1 }] } } }).indexes[0] === 0);
M.configure({ storage: null });
ok('无 storage → no_storage', M.planImport({ guanzhu_case_seq: 1 }).error === 'no_storage');

// ================= 11. 二维码评估 =================
console.log('\n[11] 二维码评估');
ok('v1 状态 = 未实现', M.QR_EVAL.status === 'not_implemented_v1');
ok('两条路径都判定不可行', M.QR_EVAL.options.length === 2 && M.QR_EVAL.options.every((o) => o.feasible === false));
ok('短码原因提到服务器', M.QR_EVAL.options[0].reason.indexOf('服务器') >= 0);
ok('分片二维码原因提到解码器/依赖', /解码器|依赖/.test(M.QR_EVAL.options[1].reason));
ok('给出现实替代路径', /json|微信|隔空投送/.test(M.QR_EVAL.fallback));

console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
