// asset_test.js —— 批次 E · 22 备份导出/导入 v2 验收（node test/asset_test.js）
// 覆盖：全 key、示例案例过滤（复用 PanjiRecur.isDemoCase）、可选密码 AES-GCM、
//       导出→清空→导入 100% 还原、账本按 tradeKey 合并去重、版本/key/账本校验、逐笔 CSV。
'use strict';
const R = require('../public/recur');
const L = require('../public/ledger');
const A = require('../public/features/asset');

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
const storage = memStorage();
R.configure({ storage });
A.configure({ storage, recur: R, ledger: L, crypto: globalThis.crypto, kdfIterations: 1000 });

function seed(key, value) { storage.setItem(key, JSON.stringify(value)); }
const read = (key) => JSON.parse(storage.getItem(key));
const CASE = (no) => 'guanzhu_case_' + String(no).padStart(3, '0');
const line = (idx, date, time, side, name, price, qty, rule = 'T04') => ({
  idx, date, time, side, name, code: '', price, qty, flag: '违规', rule, reason: '',
});
const caseObj = (no, lines) => ({
  ts: '2026-11-02T10:00:00.000Z',
  trades: lines.map((l) => ({ date: l.date, time: l.time, side: l.side, name: l.name, code: '', price: l.price, qty: l.qty })),
  verdict: { case_no: 'case_' + String(no).padStart(3, '0'), lines, day_checks: [] },
});

// /api/demo 固定 9 笔（与 recur.js DEMO_TK6 同源）
const DEMO = [
  ['20261019', '10:14:50', '示例环保', '卖', 12.68, 100],
  ['20261019', '10:13:06', '示例建设', '买', 3.54, 100],
  ['20261019', '10:13:02', '示例建设', '买', 3.54, 300],
  ['20261019', '10:08:51', '示例环保', '卖', 12.62, 100],
  ['20261019', '10:08:02', '示例建设', '买', 3.53, 700],
  ['20261019', '10:05:10', '示例建设', '买', 3.53, 700],
  ['20261019', '09:31:39', '示例基建', '买', 3.61, 400],
  ['20261019', '09:31:01', '示例材料', '卖', 11.90, 100],
  ['20261019', '09:30:21', '示例建设', '买', 3.70, 4100],
];
const demoLines = DEMO.map((x, i) => line(i, x[0], x[1], x[3], x[2], x[4], x[5], ''));

// 真实案例 001/004；示例案例 002（内容签名）/ 003（本机标记）
seed(CASE(1), caseObj(1, [line(0, '20261020', '09:40', '买', '甲', 12, 100)]));
seed(CASE(2), caseObj(2, demoLines));
seed(CASE(3), caseObj(3, [line(0, '20261021', '10:00', '买', '乙', 13, 100)]));
seed(CASE(4), caseObj(4, [line(0, '20261021', '10:30', '买', '丙', 14, 200)]));
seed('guanzhu_case_seq', 4);

seed('guanzhu_ledger', {
  trades: [
    { date: '20261020', time: '094000', code: '600000', name: '甲', side: '买', price: 12, qty: 100, importId: 'case_001' },
    { date: '20261021', time: '100000', code: '', name: '乙', side: '买', price: 13, qty: 100, importId: 'case_003' },
    { date: '20261021', time: '103000', code: '', name: '丙', side: '买', price: 14, qty: 200, importId: 'case_004' },
  ],
  imports: [{ id: 'case_001', at: '2026-10-20T10:00:00.000Z', imported: 3, added: 3, dup: 0, coverageFrom: '20261020', coverageTo: '20261021' }],
  dupLog: [],
});
const RULES = { rules: [{ templateId: 'T04', params: { tolPct: 0 } }], capital: null, savedAt: '2026-10-31T12:00:00.000Z' };
seed('guanzhu_rules_v1', RULES);
seed('guanzhu_recur_v1', {
  v: 1,
  rules: {
    T04: {
      days: {
        20261020: { cases: ['case_001'], keys: ['20261020|094000|600000|买|12.000|100|'] },
        20261021: { cases: ['case_004'], keys: [] },
      },
      first: '20261020', last: '20261021',
    },
  },
  demoCases: { case_003: 1 },
  updatedAt: '2026-11-02T10:00:00.000Z',
});
seed('guanzhu_exempt_v1', { '20261020|094000|600000|买|12.000|100|': { T04: true } });
seed('guanzhu_focus_v1', { date: '20261102', ruleId: 'T01' });
seed('guanzhu_note_v1', { date: '20261102', text: '盘前一句话' });
seed('guanzhu_reason_v1', { '20261021|103000|丙|买|14.000|200|': '回踩' });
seed('guanzhu_stop_v1', { '20261021|103000|丙|买|14.000|200|': 13.5 });
seed('guanzhu_mood_v1', { '20261102': '冷静' });
seed('guanzhu_rules_hist_v1', [{ savedAt: '2026-10-31T12:00:00.000Z', hash: 'h1', rules: RULES.rules }]);
seed('guanzhu_pos_v1', [{ code: '600000', name: '甲', qty: 100, cost: 12 }]);
seed('guanzhu_cash_v1', [{ date: '20261101', amount: 10000, dir: 'in' }]);
seed('guanzhu_flags_v1', { recur: true, mood: true });
seed('guanzhu_upload_layout_v1', { layout: 'horizontal', at: '2026-11-01T10:00:00.000Z' });
seed('guanzhu_recall_v1', { seen: '20261101', pending: null });
// COL-2：用户自己写的内容（越线认下 / 改法原文 / 未平仓跟踪计划 / 月度复盘登记）
seed('guanzhu_ack_v1', [{ r: 'T04', at: '2026-11-02', h: 'ack-h1', len: 42 }]);
seed('guanzhu_ack_txt_v1', { 'ack-h1': '这次补仓是怕亏，不是看到了机会' });
seed('guanzhu_openplan_v1', { 'op-h1': { at: '20261102', len: 26, txt: '未平仓 600000，跌破 11.5 就减一半' } });
seed('guanzhu_month_v1', { '202610': { at: '20261031', n: 8, covered: 8 } });

(async function main() {
  console.log('\n[1] 导出：全 key + 示例案例过滤（复用 PanjiRecur.isDemoCase）');
  const calls = [];
  const origIsDemo = R.isDemoCase;
  R.isDemoCase = function (v, ref, st) { calls.push(ref); return origIsDemo(v, ref, st); };
  const plain = await A.exportBackup();
  R.isDemoCase = origIsDemo;

  ok(plain.ok === true, '导出成功');
  ok(plain.encrypted === false, '不带密码 → 明文信封');
  ok(/^panji-backup-\d{8}-\d{6}\.json$/.test(plain.filename), '文件名格式 ' + plain.filename);
  ok(calls.length === 4, 'isDemoCase 对 4 个案例逐个调用（实际 ' + calls.length + '）');
  ok(calls.indexOf('case_002') >= 0 && calls.indexOf('case_003') >= 0, '示例案例 002/003 都走到 isDemoCase');

  const env = JSON.parse(plain.json);
  ok(env.app === 'guanzhushou' && env.v === 2 && env.kind === 'panji-backup', '信封 app/v2/kind');
  ok(env.counts.ledgerTrades === 3, '账本 3 笔进备份');
  ok(env.counts.cases === 2, '只导出 2 个真实案例（实际 ' + env.counts.cases + '）');
  ok(env.counts.demoCases === 2, '示例案例计数 2');
  ok(env.filtered.demoCases.indexOf('case_002') >= 0 && env.filtered.demoCases.indexOf('case_003') >= 0, '过滤清单含 002/003');
  ok(!env.data[CASE(2)] && !env.data[CASE(3)], '示例 case_002/003 不在 data 里');
  ok(!!env.data[CASE(1)] && !!env.data[CASE(4)], '真实 case_001/004 在 data 里');
  ok(env.data['guanzhu_case_seq'] === 4, '案例编号随备份保留');

  const keyCount = Object.keys(env.data).length;
  ok(keyCount === 19 + 1 + 2, '全 key：19 个单例 + seq + 2 案例（实际 ' + keyCount + '）');
  A.SINGLE_KEYS.forEach((k) => {
    if (k === 'guanzhu_ledger') return;
    if (!(k in env.data)) { fail++; console.log('  FAIL 缺 key ' + k); }
  });
  ok(A.SINGLE_KEYS.every((k) => k === 'guanzhu_ledger' || k in env.data), '19 个单例 key 全部在备份里');
  // COL-2：四张用户自写内容表必须在白名单且真的进备份
  ['guanzhu_ack_v1', 'guanzhu_ack_txt_v1', 'guanzhu_openplan_v1', 'guanzhu_month_v1'].forEach((k) => {
    ok(A.SINGLE_KEYS.indexOf(k) >= 0 && k in env.data, '新表在白名单且已导出：' + k);
  });

  console.log('\n[2] 逐笔 CSV');
  ok(plain.ok && A.exportCsv().rows === 3, 'CSV 行数=账本笔数');
  const csv = A.ledgerCsv({ trades: [
    { date: '20261020', time: '094000', code: '600000', name: '甲,乙', side: '买', price: 12, qty: 100 },
    { date: '20261021', time: '100000', code: '', name: '说"引号"', side: '卖', price: 13.5, qty: 200 },
  ] });
  ok(csv.charCodeAt(0) === 0xFEFF, 'CSV 带 BOM');
  ok(csv.indexOf('日期,时间,代码,名称,方向,价格,数量') >= 0, 'CSV 表头');
  ok(csv.indexOf('"甲,乙"') >= 0, '逗号字段加引号');
  ok(csv.indexOf('"说""引号"') >= 0, '引号字段转义');
  ok(csv.indexOf('09:40:00') >= 0, '时间 094000 → 09:40:00');

  console.log('\n[3] 可选密码 AES-GCM');
  const enc = await A.exportBackup({ password: 'pw-123' });
  ok(enc.ok && enc.encrypted === true, '密码导出 → 加密信封');
  const eEnv = JSON.parse(enc.json);
  ok(eEnv.encrypted === true && !!eEnv.payload && !!eEnv.kdf && !!eEnv.cipher, '信封含 payload/kdf/cipher');
  ok(eEnv.kdf.name === 'PBKDF2' && eEnv.kdf.hash === 'SHA-256' && eEnv.kdf.iterations === 1000, 'KDF 参数写进信封');
  ok(eEnv.data === undefined && enc.json.indexOf('"data"') < 0, '加密信封没有明文 data');
  ok(enc.json.indexOf('示例环保') < 0 && enc.json.indexOf('guanzhu_ledger') < 0, '密文里没有明文 key/内容');
  ok(enc.counts.ledgerTrades === 3, '加密导出仍返回 counts（本地用）');

  const noPass = await A.decodeBackup(enc.json);
  ok(!noPass.ok && noPass.error === 'password_required', '没给密码 → password_required');
  const badPass = await A.decodeBackup(enc.json, 'wrong');
  ok(!badPass.ok && badPass.error === 'bad_password', '密码错 → bad_password');
  const dec = await A.decodeBackup(enc.json, 'pw-123');
  ok(dec.ok === true, '正确密码可解密');
  ok(JSON.stringify(dec.data) === JSON.stringify(env.data), '解密 data 与明文导出一致');

  console.log('\n[4] 往返：导出 → 清空 → 导入 100% 还原');
  const before = JSON.parse(plain.json).data;
  storage.clear();
  ok(storage.getItem('guanzhu_ledger') === null, '清空后账本不存在');
  const imp = await A.importBackup(plain.json);
  ok(imp.ok === true, '导入成功');
  ok(imp.addedTrades === 3 && imp.dupTrades === 0, '空库导入 3 笔、0 重复');
  ok(imp.addedCases === 2, '导入 2 个真实案例');
  ok(imp.demoFiltered === 2, '导入结果标明过滤 2 个示例');
  let mismatch = 0;
  Object.keys(before).forEach((k) => {
    const got = storage.getItem(k);
    if (got == null || JSON.stringify(JSON.parse(got)) !== JSON.stringify(before[k])) mismatch++;
  });
  ok(mismatch === 0, '所有导出 key 逐个还原一致（不一致 ' + mismatch + '）');
  ok(!!storage.getItem(CASE(1)) && !!storage.getItem(CASE(4)), '真实案例已还原');
  ok(!storage.getItem(CASE(2)) && !storage.getItem(CASE(3)), '示例案例没有被还原（本来就没导出）');
  ok(read('guanzhu_case_seq') === 4, '案例编号还原为 4');
  ok(read('guanzhu_ledger').trades.length === 3, '账本笔数还原为 3');
  ok(read('guanzhu_recur_v1').updatedAt === '2026-11-02T10:00:00.000Z', '复发索引原样还原');
  ok(read('guanzhu_recur_v1').demoCases.case_003 === 1, '示例标记随索引保留');
  // COL-2 实测：另起 storage 导入后，四张用户自写内容表内容还在
  ok(read('guanzhu_ack_v1')[0].h === 'ack-h1' && read('guanzhu_ack_v1')[0].r === 'T04', '越线认下记录还原');
  ok(read('guanzhu_ack_txt_v1')['ack-h1'].indexOf('补仓') >= 0, '改法原文还原');
  ok(read('guanzhu_openplan_v1')['op-h1'].txt.indexOf('11.5') >= 0, '未平仓跟踪计划还原');
  ok(read('guanzhu_month_v1')['202610'].at === '20261031', '月度复盘登记还原');

  console.log('\n[5] 导入合并：账本按 tradeKey 去重、单例冲突本地优先');
  const s2 = memStorage();
  R.configure({ storage: s2 });
  A.configure({ storage: s2, recur: R, ledger: L, crypto: globalThis.crypto, kdfIterations: 1000 });
  const trade = (date, time, code, name, side, price, qty) => ({ date, time, code, name, side, price, qty });
  const A1 = trade('20261020', '09:40', '600000', '甲', '买', 12, 100);
  const B1 = trade('20261020', '10:00', '', '乙', '买', 13, 100);
  const C1 = trade('20261021', '10:30', '', '丙', '买', 14, 200);
  s2.setItem('guanzhu_ledger', JSON.stringify({ trades: [A1, B1], imports: [], dupLog: [] }));
  s2.setItem('guanzhu_rules_v1', JSON.stringify({ rules: [{ templateId: 'T01', params: { waitMin: 30 } }], capital: null, savedAt: 'x' }));
  s2.setItem('guanzhu_case_seq', JSON.stringify(1));

  const mergeEnv = {
    app: 'guanzhushou', v: 2, kind: 'panji-backup', exportedAt: '2026-11-02T10:00:00.000Z',
    encrypted: false, counts: {}, filtered: { demoCases: [] },
    data: {
      guanzhu_ledger: { trades: [A1, C1], imports: [], dupLog: [] },
      guanzhu_rules_v1: { rules: [{ templateId: 'T02', params: { endMin: 30 } }], capital: 5000, savedAt: 'y' },
      guanzhu_case_seq: 3,
      [CASE(1)]: caseObj(1, [line(0, '20261020', '09:40', '买', '甲', 12, 100)]),
    },
  };
  const mi = await A.importBackup(mergeEnv);
  ok(mi.ok === true, '合并导入成功');
  ok(mi.ledgerMerged === true, '走账本合并路径');
  ok(mi.addedTrades === 1 && mi.dupTrades === 1, '新增 1 笔、重复 1 笔（tradeKey 去重）');
  ok(read2(s2, 'guanzhu_ledger').trades.length === 3, '合并后账本 3 笔');
  ok(mi.conflicts.indexOf('guanzhu_rules_v1') >= 0, '规则冲突被记录');
  ok(read2(s2, 'guanzhu_rules_v1').rules[0].templateId === 'T01', '冲突时保留本机规则');
  ok(mi.addedCases === 1 && !!s2.getItem(CASE(1)), '案例新增 1 个');
  ok(read2(s2, 'guanzhu_case_seq') === 3, '编号只升不降 → 3');
  ok(mi.rebuilt === true, '只导入案例、未还原索引 → 重建复发索引');
  ok(!!s2.getItem('guanzhu_recur_v1'), '重建后存在复发索引');

  function read2(s, k) { return JSON.parse(s.getItem(k)); }

  console.log('\n[6] 校验：版本 / app / key 白名单 / 账本结构');
  const v1 = await A.decodeBackup({ app: 'guanzhushou', v: 1, kind: 'panji-backup', encrypted: false, data: {} });
  ok(!v1.ok && v1.error === 'version_unsupported', 'v1 拒绝');
  const wrongApp = await A.decodeBackup({ app: 'other', v: 2, kind: 'panji-backup', encrypted: false, data: {} });
  ok(!wrongApp.ok && wrongApp.error === 'app_invalid', '非本产品备份拒绝');
  const badKey = await A.decodeBackup({ app: 'guanzhushou', v: 2, kind: 'panji-backup', encrypted: false, data: { evil_key: 1 } });
  ok(!badKey.ok && badKey.error === 'key_not_allowed', '未知 key 拒绝');
  ok(A.isAllowedKey('guanzhu_case_001') && A.isAllowedKey('guanzhu_ledger') && !A.isAllowedKey('evil_key'), 'key 白名单函数');
  const badLedger = await A.importBackup({
    app: 'guanzhushou', v: 2, kind: 'panji-backup', encrypted: false,
    data: { guanzhu_ledger: { trades: [{ date: '', side: '买', price: 1, qty: 1 }] } },
  });
  ok(!badLedger.ok && badLedger.error === 'trade_invalid', '无效成交拒绝导入');
  ok(read2(s2, 'guanzhu_ledger').trades.length === 3, '拒绝后账本未被改写');

  console.log('\n[7] 浏览器入口边界');
  ok(typeof A.boot === 'function', '导出 boot()');
  ok(A.boot() === false, 'Node 无 document 时 boot 返回 false');
  ok(A.FLAG === 'asset', 'flag 名 asset（默认关由 ext.js 决定）');

  console.log('\n[8] E-23 回归：导出/导入带 account，导入后迁移幂等');
  const s3 = memStorage();
  R.configure({ storage: s3 });
  A.configure({ storage: s3, recur: R, ledger: L, crypto: globalThis.crypto, kdfIterations: 1000 });
  const oldTrade = { date: '20261020', time: '094000', code: '600000', name: '甲', side: '买', price: 12, qty: 100 };
  const creditTrade = { date: '20261021', time: '100000', code: '', name: '乙', side: '买', price: 13, qty: 100, account: 'credit' };
  s3.setItem('guanzhu_ledger', JSON.stringify({ trades: [oldTrade, creditTrade], imports: [], dupLog: [] }));
  s3.setItem(CASE(1), JSON.stringify({ ts: '2026-11-02T10:00:00.000Z', trades: [oldTrade], verdict: { case_no: 'case_001', lines: [line(0, '20261020', '094000', '买', '甲', 12, 100)], day_checks: [], suspects: [] } }));
  s3.setItem('guanzhu_case_seq', '1');

  const acctExp = await A.exportBackup();
  ok(acctExp.ok === true, '多账户数据导出成功');
  const acctEnv = JSON.parse(acctExp.json);
  ok(acctEnv.data.guanzhu_ledger.trades[0].account === 'default', '导出时老笔补 default');
  ok(acctEnv.data.guanzhu_ledger.trades[1].account === 'credit', '导出保留已标注的 credit');
  ok(acctEnv.data[CASE(1)].verdict.lines[0].account === 'default', '导出案例逐笔补 default');
  const csvAcct = A.ledgerCsv(acctEnv.data.guanzhu_ledger);
  ok(csvAcct.indexOf('账户') >= 0, '逐笔 CSV 表头含账户列');
  ok(csvAcct.indexOf('普通') >= 0 && csvAcct.indexOf('信用') >= 0, '逐笔 CSV 行含账户中文标签');

  const s4 = memStorage();
  R.configure({ storage: s4 });
  A.configure({ storage: s4, recur: R, ledger: L, crypto: globalThis.crypto, kdfIterations: 1000 });
  const acctImp = await A.importBackup(acctExp.json);
  ok(acctImp.ok === true, '多账户备份导入成功');
  ok(acctImp.addedTrades === 2 && acctImp.addedCases === 1, `导入 2 笔 / 1 案例（${acctImp.addedTrades}/${acctImp.addedCases}）`);
  ok(read2(s4, 'guanzhu_ledger').trades.map((t) => t.account).join(',') === 'default,credit', '导入后账户原样保留');
  const acctM = A.migrateV2();
  ok(acctM.migrated === 0 && acctM.failed === 0, '导入后 migrateV2 幂等（migrated=0/failed=0）');

  // 老 v2 备份（完全没有 account）导入 → 解码时补 default，再跑迁移仍幂等
  const s5 = memStorage();
  R.configure({ storage: s5 });
  A.configure({ storage: s5, recur: R, ledger: L, crypto: globalThis.crypto, kdfIterations: 1000 });
  const oldEnv = {
    app: 'guanzhushou', v: 2, kind: 'panji-backup', exportedAt: '2026-11-02T10:00:00.000Z',
    encrypted: false, counts: {}, filtered: { demoCases: [] },
    data: {
      guanzhu_ledger: { trades: [oldTrade], imports: [], dupLog: [] },
      guanzhu_case_seq: 1,
      [CASE(1)]: { ts: '2026-11-02T10:00:00.000Z', trades: [oldTrade], verdict: { case_no: 'case_001', lines: [line(0, '20261020', '094000', '买', '甲', 12, 100)], day_checks: [], suspects: [] } },
    },
  };
  const oldImp = await A.importBackup(oldEnv);
  ok(oldImp.ok === true, '老 v2 备份导入成功');
  ok(read2(s5, 'guanzhu_ledger').trades[0].account === 'default', '老备份导入后账本补 default');
  ok(read2(s5, CASE(1)).verdict.lines[0].account === 'default', '老备份导入后案例补 default');
  const oldM = A.migrateV2();
  ok(oldM.migrated === 0 && oldM.failed === 0, '老备份导入后 migrateV2 仍幂等');

  console.log('\n[9] COL-2：旧格式备份（无四张新表）解码 / 导入仍兼容，缺键按空处理');
  const s6 = memStorage();
  R.configure({ storage: s6 });
  A.configure({ storage: s6, recur: R, ledger: L, crypto: globalThis.crypto, kdfIterations: 1000 });
  const legacyEnv = {
    app: 'guanzhushou', v: 2, kind: 'panji-backup', exportedAt: '2026-11-01T10:00:00.000Z',
    encrypted: false, counts: {}, filtered: { demoCases: [] },
    data: {
      guanzhu_ledger: { trades: [oldTrade], imports: [], dupLog: [] },
      guanzhu_rules_v1: RULES,
      guanzhu_case_seq: 1,
      [CASE(1)]: { ts: '2026-11-02T10:00:00.000Z', trades: [oldTrade], verdict: { case_no: 'case_001', lines: [line(0, '20261020', '094000', '买', '甲', 12, 100)], day_checks: [], suspects: [] } },
    },
  };
  const NEW_KEYS = ['guanzhu_ack_v1', 'guanzhu_ack_txt_v1', 'guanzhu_openplan_v1', 'guanzhu_month_v1'];
  const legacyDec = await A.decodeBackup(legacyEnv);
  ok(legacyDec.ok === true, '旧备份解码通过（不因缺新表报 key_not_allowed）');
  NEW_KEYS.forEach((k) => ok(!(k in legacyDec.data), '旧备份没有 ' + k + '（解码不伪造）'));
  const legacyImp = await A.importBackup(legacyEnv);
  ok(legacyImp.ok === true, '旧备份导入成功');
  NEW_KEYS.forEach((k) => ok(s6.getItem(k) === null, '缺键按空处理，未凭空写入：' + k));
  ok(legacyImp.addedTrades === 1 && legacyImp.addedCases === 1, '旧备份照常导入账本 / 案例');
  ok(read2(s6, 'guanzhu_ledger').trades[0].account === 'default', '旧备份导入后账本补 default');
  ok(A.migrateV2().failed === 0, '旧备份导入后迁移不报错');

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e && e.stack || e);
  process.exit(1);
});
