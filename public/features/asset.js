// features/asset.js —— 批次 E · 22 本地备份导出 / 导入 v2 + 23 多账户
//
// 边界：不改 app.js / index.html；UI 挂 PanjiExt.rulesBottom（备份）、reviewTop（本批账户）、
//       reportBottom（按账户看）；不云同步、不引依赖。
// 导出：全 key（含 case_*）。示例案例按 PanjiRecur.isDemoCase 过滤，示例不进真实备份。
//       E-23：账本/案例/tk6 映射在备份副本里补 account，不改本机存储。
// 可选密码：PBKDF2-SHA256 → AES-GCM 256（WebCrypto），盐/IV 随机，参数写进信封。
// 导入：校验 app / 版本 / key 白名单；账本按 tradeKey 合并去重；单例 key 本地优先（冲突计数）；
//       先迁移本机老数据再合并，导入后再跑一次 migrateV2（幂等）。
// 浏览器挂 window.PanjiFeatures.asset；Node 测试走 module.exports（UMD，同 recur.js）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else {
    const api = factory(root);
    root.PanjiFeatures = root.PanjiFeatures || {};
    root.PanjiFeatures.asset = api;
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => api.boot());
      else api.boot();
    }
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const VERSION = 2;
  const APP = 'guanzhushou';
  const FLAG = 'asset';
  // FX-3：键统一取自 PanjiStore.KEYS；无 store 环境（Node vm 沙箱）回落同值 fallback
  const Store = (function () {
    try { if (root && root.PanjiStore) return root.PanjiStore; } catch (e) { /* 继续 */ }
    try { if (typeof require === 'function') return require('../store.js'); } catch (e) { /* 继续 */ }
    return null;
  })();
  function keyOf(name, fallback) { return (Store && Store.KEYS && Store.KEYS[name]) || fallback; }

  const CASE_PREFIX = keyOf('casePrefix', 'guanzhu_case_');
  const CASE_SEQ = keyOf('caseSeq', 'guanzhu_case_seq');
  const RECUR_KEY = keyOf('recur', 'guanzhu_recur_v1');
  const LEDGER_KEY = keyOf('ledger', 'guanzhu_ledger');
  const KDF_ITER = 100000;
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  const CASE_RE = new RegExp('^' + CASE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d{3,}$');

  // 批次 E-23：账户标签（存储里用英文 id，界面显示中文）
  const DEFAULT_ACCOUNT = 'default';
  const ACCOUNTS = [
    { id: 'default', label: '普通' },
    { id: 'credit', label: '信用' },
    { id: 'other', label: '其他' },
  ];
  // 这些 key 的值是 tk6 映射（老数据缺 account 段，迁移时补 default）
  const TK6_MAP_KEYS = [
    keyOf('exempt', 'guanzhu_exempt_v1'),
    keyOf('reason', 'guanzhu_reason_v1'),
    keyOf('stop', 'guanzhu_stop_v1'),
  ];
  // 批次 E-24 / E-25：期初持仓与出入金（手填，只做本金口径）
  const POS_KEY = keyOf('pos', 'guanzhu_pos_v1');
  const CASH_KEY = keyOf('cash', 'guanzhu_cash_v1');
  const MAX_POSITIONS = 50;
  const MAX_CASH = 500;

  // §2.1 全 key + C/F 新增的两个（版式记忆 / 回归礼包状态）。新增 key 必须同步这里。
  const SINGLE_KEYS = [
    LEDGER_KEY, keyOf('rules', 'guanzhu_rules_v1'), RECUR_KEY, keyOf('exempt', 'guanzhu_exempt_v1'),
    keyOf('focus', 'guanzhu_focus_v1'), keyOf('note', 'guanzhu_note_v1'), keyOf('reason', 'guanzhu_reason_v1'),
    keyOf('stop', 'guanzhu_stop_v1'), keyOf('mood', 'guanzhu_mood_v1'), keyOf('rulesHist', 'guanzhu_rules_hist_v1'),
    POS_KEY, CASH_KEY, keyOf('flags', 'guanzhu_flags_v1'),
    keyOf('uploadLayout', 'guanzhu_upload_layout_v1'), keyOf('recall', 'guanzhu_recall_v1'),
    // COLL-1 之后用户自己写的内容：越线认下 / 改法原文 / 未平仓跟踪计划 / 月度复盘登记
    keyOf('ack', 'guanzhu_ack_v1'), keyOf('ackTxt', 'guanzhu_ack_txt_v1'),
    keyOf('openplan', 'guanzhu_openplan_v1'), keyOf('month', 'guanzhu_month_v1'),
  ];
  const ALLOWED = new Set(SINGLE_KEYS.concat([CASE_SEQ]));

  let adapter = null;
  let flagsOverride = null;
  let recurOverride = null;
  let ledgerOverride = null;
  let cryptoOverride = null;
  let kdfIterations = KDF_ITER;
  let booted = false;

  function configure(opts) {
    opts = opts || {};
    if (opts.storage) adapter = opts.storage;
    if ('flags' in opts) flagsOverride = opts.flags;
    if (opts.recur) recurOverride = opts.recur;
    if (opts.ledger) ledgerOverride = opts.ledger;
    if (opts.crypto) cryptoOverride = opts.crypto;
    if (opts.kdfIterations) kdfIterations = Math.max(1000, +opts.kdfIterations || KDF_ITER);
    return { storage: adapter, flags: flagsOverride };
  }

  function storage() {
    if (adapter) return adapter;
    if (!root) return null;
    try { return root.localStorage; } catch (e) { return null; }
  }
  function recurApi() {
    if (recurOverride) return recurOverride;
    try { return root && root.PanjiRecur ? root.PanjiRecur : null; } catch (e) { return null; }
  }
  function ledgerApi() {
    if (ledgerOverride) return ledgerOverride;
    try { return root && root.Ledger ? root.Ledger : null; } catch (e) { return null; }
  }
  function webcrypto() {
    if (cryptoOverride) return cryptoOverride;
    try { if (root && root.crypto && root.crypto.subtle) return root.crypto; } catch (e) { /* 继续 */ }
    try { if (typeof crypto !== 'undefined' && crypto && crypto.subtle) return crypto; } catch (e) { /* 无 */ }
    return null;
  }
  function flagOn() {
    if (flagsOverride && typeof flagsOverride === 'object') return !!flagsOverride[FLAG];
    try { return !!(root && typeof root.PanjiFlag === 'function' && root.PanjiFlag(FLAG)); } catch (e) { return false; }
  }
  function track(name, data) {
    try {
      if (!root) return;
      const fn = root.PanjiTrack || (typeof root.__panjiTrack === 'function' ? root.__panjiTrack : null);
      if (typeof fn === 'function') fn(name, data);
    } catch (e) { /* 埋点失败不影响导出 */ }
  }

  // ---------- 存储读写 ----------
  function getRaw(key) {
    const s = storage();
    if (!s) return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }
  function parseRaw(raw) {
    try { return JSON.parse(raw); } catch (e) { return undefined; }
  }
  function getJson(key, fallback) {
    const raw = getRaw(key);
    if (raw == null) return fallback;
    const v = parseRaw(raw);
    return v === undefined ? fallback : v;
  }
  function setJson(key, value) {
    const s = storage();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function removeRaw(key) {
    const s = storage();
    if (!s) return false;
    try { s.removeItem(key); return true; } catch (e) { return false; }
  }

  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function pad3(n) { return String(n).padStart(3, '0'); }
  function caseRefOf(n) {
    const raw = 'case_' + pad3(n);
    const r = recurApi();
    if (r && typeof r.caseRef === 'function') {
      try { return r.caseRef(raw); } catch (e) { /* 用原值 */ }
    }
    return raw;
  }
  function demoCheck(verdict, ref, st) {
    const r = recurApi();
    if (!r || typeof r.isDemoCase !== 'function') return false;
    try { return !!r.isDemoCase(verdict, ref, st); } catch (e) { return false; }
  }

  // ---------- E-23 账户工具 ----------
  function accountOf(t) {
    const L = ledgerApi();
    if (L && typeof L.accountOf === 'function') {
      try { return L.accountOf(t); } catch (e) { /* 落到本地实现 */ }
    }
    return String((t && t.account) || '').trim() || DEFAULT_ACCOUNT;
  }
  function accountLabel(id) {
    const a = String(id || '').trim() || DEFAULT_ACCOUNT;
    const hit = ACCOUNTS.filter((x) => x.id === a)[0];
    return hit ? hit.label : a;
  }
  // 只认显式写下的 account；空串表示老数据/未标注
  function explicitAccount(list) {
    const arr = Array.isArray(list) ? list : [];
    for (const t of arr) {
      const a = String((t && t.account) || '').trim();
      if (a) return a;
    }
    return '';
  }
  function fillAccounts(list) {
    return (Array.isArray(list) ? list : []).map((t) => {
      if (!t || typeof t !== 'object') return t;
      return String(t.account || '') ? t : Object.assign({}, t, { account: DEFAULT_ACCOUNT });
    });
  }
  // 老 tk6 以 '|' 结尾（account 空段）→ 补 default；已有 account 的键原样保留
  function normalizeTk6Key(k) {
    const s = String(k == null ? '' : k);
    const parts = s.split('|');
    if (parts.length !== 7) return s;
    if (String(parts[6] || '') !== '') return s;
    parts[6] = DEFAULT_ACCOUNT;
    return parts.join('|');
  }
  // tk6 键里的账户段（用于按账户过滤复发/例外数据）
  function keyAccount(k) {
    const parts = String(k == null ? '' : k).split('|');
    if (parts.length !== 7) return '';
    return String(parts[6] || '');
  }
  function caseAccount(c) {
    if (!c || typeof c !== 'object') return DEFAULT_ACCOUNT;
    const fromTrades = explicitAccount(c.trades);
    if (fromTrades) return fromTrades;
    const fromLines = explicitAccount(c.verdict && c.verdict.lines);
    return fromLines || DEFAULT_ACCOUNT;
  }
  function caseRefFromKey(k) {
    const r = recurApi();
    if (r && typeof r.caseRef === 'function') {
      try { return r.caseRef(k); } catch (e) { /* 用原值 */ }
    }
    return String(k || '');
  }

  // ---------- E-24 期初持仓（手填） ----------
  // 口径：只进服务端 FIFO 当"最早买入"，不生成判定行、不计成交笔数；
  //       每条 {code,name,qty,cost,account}，qty 正整数、cost 正数，代码/名称至少一项。
  function normalizePosition(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const code = String(raw.code || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 8);
    const name = String(raw.name || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 12);
    const qty = Math.round(+raw.qty);
    const cost = +raw.cost;
    if (!code && !name) return null;
    if (!Number.isFinite(qty) || qty <= 0) return null;
    if (!Number.isFinite(cost) || cost <= 0) return null;
    return {
      code, name: name || '未命名标的', qty, cost,
      account: String(raw.account || '').trim() || DEFAULT_ACCOUNT,
    };
  }
  function normalizePositions(list) {
    const out = [];
    (Array.isArray(list) ? list : []).slice(0, MAX_POSITIONS).forEach((p) => {
      const n = normalizePosition(p);
      if (n) out.push(n);
    });
    return out;
  }
  function readPositions() {
    return normalizePositions(getJson(POS_KEY, []));
  }
  function savePositions(list) {
    return setJson(POS_KEY, normalizePositions(list));
  }
  function positionKey(p) {
    return accountOf(p) + '|' + (p.code || p.name);
  }
  // 同一账户同一标的只保留一条（再次加入＝覆盖成本/数量）
  function addPosition(raw) {
    const p = normalizePosition(raw);
    if (!p) return { ok: false, error: 'position_invalid' };
    const list = readPositions();
    const key = positionKey(p);
    const idx = list.findIndex((x) => positionKey(x) === key);
    if (idx >= 0) list[idx] = p;
    else {
      if (list.length >= MAX_POSITIONS) return { ok: false, error: 'position_limit' };
      list.push(p);
    }
    if (!savePositions(list)) return { ok: false, error: 'write_failed' };
    track('position_set', { account: p.account, total: list.length });
    return { ok: true, positions: list, replaced: idx >= 0 };
  }
  function removePosition(index) {
    const list = readPositions();
    const i = +index;
    if (!(i >= 0) || i >= list.length) return { ok: false, error: 'position_not_found' };
    const removed = list.splice(i, 1)[0];
    if (!savePositions(list)) return { ok: false, error: 'write_failed' };
    track('position_set', { account: removed.account, total: list.length, removed: 1 });
    return { ok: true, positions: list, removed };
  }
  // 只把与本批成交同一账户的期初持仓带上，避免普通账户的底仓污染信用账户判定
  function positionsForRequest(trades) {
    const accts = Object.create(null);
    (Array.isArray(trades) ? trades : []).forEach((t) => { accts[accountOf(t)] = 1; });
    return readPositions().filter((p) => accts[accountOf(p)]);
  }
  // 给 /api/confirm 与 /api/judge 的请求体补 positions；调用方已显式给出则不覆盖
  function withPositions(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.trades)) return body;
    if (body.positions !== undefined) return body;
    const pos = positionsForRequest(body.trades);
    if (!pos.length) return body;
    return Object.assign({}, body, { positions: pos });
  }

  // ---------- E-25 出入金（手填，只做本金口径） ----------
  // 口径：{date,amount,dir}，amount 恒为正数，dir 为 in/out；本金 = 累计入金 - 累计出金。
  //       不计算收益率、不做收益类推断。
  function normalizeCashDate(v) {
    const d = String(v || '').replace(/[^\d]/g, '');
    if (d.length === 8) return d;
    if (d.length === 6) return '20' + d;
    return '';
  }
  function normalizeCash(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const date = normalizeCashDate(raw.date);
    const amount = Math.round(Math.abs(+raw.amount) * 100) / 100;
    const dir = raw.dir === 'out' ? 'out' : (raw.dir === 'in' ? 'in' : '');
    if (!date) return null;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!dir) return null;
    return { date, amount, dir };
  }
  function normalizeCashList(list) {
    const out = [];
    (Array.isArray(list) ? list : []).slice(0, MAX_CASH).forEach((c) => {
      const n = normalizeCash(c);
      if (n) out.push(n);
    });
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
  function readCash() {
    return normalizeCashList(getJson(CASH_KEY, []));
  }
  function saveCash(list) {
    return setJson(CASH_KEY, normalizeCashList(list));
  }
  function addCash(raw) {
    const c = normalizeCash(raw);
    if (!c) return { ok: false, error: 'cash_invalid' };
    const list = readCash();
    if (list.length >= MAX_CASH) return { ok: false, error: 'cash_limit' };
    list.push(c);
    if (!saveCash(list)) return { ok: false, error: 'write_failed' };
    track('cash_set', { dir: c.dir, total: list.length });
    return { ok: true, cash: readCash(), entry: c };
  }
  function removeCash(index) {
    const list = readCash();
    const i = +index;
    if (!(i >= 0) || i >= list.length) return { ok: false, error: 'cash_not_found' };
    const removed = list.splice(i, 1)[0];
    if (!saveCash(list)) return { ok: false, error: 'write_failed' };
    track('cash_set', { dir: removed.dir, total: list.length, removed: 1 });
    return { ok: true, cash: list, removed };
  }
  // 只做本金口径：入金合计 / 出金合计 / 净本金；不含收益率
  function principalOf(cashList) {
    const list = Array.isArray(cashList) ? cashList : readCash();
    let inflow = 0, outflow = 0;
    list.forEach((c) => {
      if (c.dir === 'in') inflow += c.amount;
      else if (c.dir === 'out') outflow += c.amount;
    });
    return { in: Math.round(inflow * 100) / 100, out: Math.round(outflow * 100) / 100, net: Math.round((inflow - outflow) * 100) / 100, count: list.length };
  }

  // 备份/导入统一口径：账本、案例、tk6 映射全部带 account（不改本机存储）
  function canonicalData(src, opts) {
    opts = opts || {};
    const data = src && typeof src === 'object' ? JSON.parse(JSON.stringify(src)) : {};
    const ledger = data[LEDGER_KEY];
    if (ledger && Array.isArray(ledger.trades)) ledger.trades = fillAccounts(ledger.trades);

    const recurState = data[RECUR_KEY] || null;
    Object.keys(data).forEach((k) => {
      if (!CASE_RE.test(k)) return;
      const c = data[k];
      if (!c || typeof c !== 'object') return;
      // 导出时示例案例已在 collectData 过滤；导入时再查一次，避免改掉示例签名
      if (!opts.assumeReal && demoCheck(c.verdict, caseRefFromKey(k), recurState)) return;
      if (Array.isArray(c.trades)) c.trades = fillAccounts(c.trades);
      if (c.verdict && Array.isArray(c.verdict.lines)) c.verdict.lines = fillAccounts(c.verdict.lines);
    });

    TK6_MAP_KEYS.forEach((k) => {
      const m = data[k];
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      const next = {};
      Object.keys(m).forEach((key) => { next[normalizeTk6Key(key)] = m[key]; });
      data[k] = next;
    });

    const rec = data[RECUR_KEY];
    if (rec && rec.rules && typeof rec.rules === 'object') {
      Object.keys(rec.rules).forEach((rid) => {
        const r = rec.rules[rid];
        if (!r || !r.days || typeof r.days !== 'object') return;
        Object.keys(r.days).forEach((d) => {
          const day = r.days[d];
          if (day && Array.isArray(day.keys)) day.keys = day.keys.map(normalizeTk6Key);
        });
      });
    }
    return data;
  }

  // 把一个带 tk6 键的映射对象整体迁移；返回改动的键数
  function planTk6Map(raw, key) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return { failed: 1 }; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { failed: 1 };
    let changed = 0;
    const next = {};
    Object.keys(m).forEach((k) => {
      const nk = normalizeTk6Key(k);
      if (nk !== k) changed++;
      next[nk] = m[k];
    });
    return { failed: 0, changed, next, key };
  }

  // ---------- 导出 ----------
  function countsOf(data) {
    const ledger = data && data[LEDGER_KEY];
    const trades = ledger && Array.isArray(ledger.trades) ? ledger.trades.length : 0;
    const cases = Object.keys(data || {}).filter((k) => CASE_RE.test(k)).length;
    return { keys: Object.keys(data || {}).length, ledgerTrades: trades, cases };
  }

  function collectData() {
    const data = {};
    const invalidKeys = [];
    SINGLE_KEYS.forEach((k) => {
      const raw = getRaw(k);
      if (raw == null) return;
      const v = parseRaw(raw);
      if (v === undefined) { invalidKeys.push(k); return; }
      data[k] = v;
    });

    const seqRaw = getRaw(CASE_SEQ);
    const seq = seqRaw == null ? 0 : Math.max(0, +(parseRaw(seqRaw) || 0));
    if (seq) data[CASE_SEQ] = seq;

    const st = data[RECUR_KEY] || null;
    const demoCases = [];
    for (let i = 1; i <= seq; i++) {
      const key = CASE_PREFIX + pad3(i);
      const raw = getRaw(key);
      if (raw == null) continue;
      const c = parseRaw(raw);
      if (c === undefined) { invalidKeys.push(key); continue; }
      const ref = caseRefOf(i);
      if (demoCheck(c && c.verdict, ref, st)) { demoCases.push(ref); continue; }
      data[key] = c;
    }

    // E-23：备份统一带 account（不改本机存储；示例案例已在上面过滤，勿重复 isDemoCase）
    const canon = canonicalData(data, { assumeReal: true });
    return { data: canon, seq, demoCases, invalidKeys, counts: countsOf(canon) };
  }

  function stamp(d) {
    const x = d instanceof Date ? d : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}-${p(x.getHours())}${p(x.getMinutes())}${p(x.getSeconds())}`;
  }
  function filename(ext, d) { return `panji-backup-${stamp(d)}.${ext}`; }

  function bytesToB64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64ToBytes(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(s), 'base64'));
    const bin = atob(String(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }

  async function deriveKey(password, salt, iterations) {
    const wc = webcrypto();
    if (!wc || !wc.subtle) throw new Error('crypto_unavailable');
    const base = await wc.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
    return wc.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function exportBackup(opts) {
    opts = opts || {};
    try {
      const { data, demoCases, counts, invalidKeys } = collectData();
      const at = opts.now instanceof Date ? opts.now : new Date();
      const exportedAt = at.toISOString();
      const meta = {
        exportedAt,
        counts: Object.assign({}, counts, { demoCases: demoCases.length }),
        filtered: { demoCases },
        data,
      };
      let envelope = Object.assign({ app: APP, v: VERSION, kind: 'panji-backup', exportedAt },
        { encrypted: false, counts: meta.counts, filtered: meta.filtered, data });

      if (opts.password) {
        const password = String(opts.password);
        if (!password) return { ok: false, error: 'password_empty' };
        const wc = webcrypto();
        if (!wc || !wc.subtle) return { ok: false, error: 'crypto_unavailable' };
        const salt = wc.getRandomValues(new Uint8Array(16));
        const iv = wc.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(password, salt, kdfIterations);
        const ct = await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(JSON.stringify(meta)));
        envelope = {
          app: APP, v: VERSION, kind: 'panji-backup', exportedAt, encrypted: true,
          kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: kdfIterations, salt: bytesToB64(salt) },
          cipher: { name: 'AES-GCM', iv: bytesToB64(iv) },
          payload: bytesToB64(new Uint8Array(ct)),
        };
      }

      return {
        ok: true, json: JSON.stringify(envelope), filename: filename('json', at),
        encrypted: !!opts.password, counts: meta.counts,
        demoCases, invalidKeys,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------- 导入 ----------
  function isAllowedKey(k) {
    return ALLOWED.has(k) || CASE_RE.test(k);
  }

  function validateLedger(ledger) {
    if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.trades)) {
      return { ok: false, error: 'ledger_invalid' };
    }
    const bad = [];
    ledger.trades.forEach((t, i) => {
      if (!t || !t.date || !t.side || !(+t.price > 0) || !(+t.qty > 0)) bad.push(i);
    });
    if (bad.length) return { ok: false, error: 'trade_invalid', indexes: bad.slice(0, 5) };
    const L = ledgerApi();
    if (L && typeof L.tradeKey === 'function') {
      try { ledger.trades.forEach((t) => L.tradeKey(t)); } catch (e) { return { ok: false, error: 'trade_key_invalid' }; }
    }
    return { ok: true };
  }

  function mergeImports(a, b) {
    const seen = Object.create(null);
    return (a || []).concat(b || []).filter((r) => {
      const k = String((r && r.id) || '') + '|' + String((r && r.at) || '');
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    }).slice(-200);
  }

  async function decodeBackup(input, password) {
    let env;
    try { env = typeof input === 'string' ? JSON.parse(input) : input; } catch (e) { return { ok: false, error: 'json_invalid' }; }
    if (!env || typeof env !== 'object') return { ok: false, error: 'envelope_invalid' };
    if (env.app !== APP) return { ok: false, error: 'app_invalid' };
    if (typeof env.v !== 'number' || env.v !== VERSION) return { ok: false, error: 'version_unsupported' };
    if (env.kind !== 'panji-backup') return { ok: false, error: 'kind_invalid' };

    let payload;
    if (env.encrypted) {
      if (!password) return { ok: false, error: 'password_required' };
      const wc = webcrypto();
      if (!wc || !wc.subtle) return { ok: false, error: 'crypto_unavailable' };
      const kdf = env.kdf || {}, cipher = env.cipher || {};
      if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !kdf.salt || !cipher.iv || !env.payload) {
        return { ok: false, error: 'envelope_invalid' };
      }
      const iter = Math.max(1000, Math.min(2000000, +kdf.iterations || KDF_ITER));
      try {
        const key = await deriveKey(String(password), b64ToBytes(kdf.salt), iter);
        const pt = await wc.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(cipher.iv) }, key, b64ToBytes(env.payload));
        payload = JSON.parse(new TextDecoder().decode(pt));
      } catch (e) {
        return { ok: false, error: 'bad_password' };
      }
    } else {
      payload = { exportedAt: env.exportedAt, counts: env.counts, filtered: env.filtered, data: env.data };
    }

    if (!payload || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      return { ok: false, error: 'data_invalid' };
    }
    const badKeys = Object.keys(payload.data).filter((k) => !isAllowedKey(k));
    if (badKeys.length) return { ok: false, error: 'key_not_allowed', keys: badKeys.slice(0, 5) };

    // E-23：老备份（无 account）在解码时统一补齐 default，导入后即可与已迁移账本合并
    const canon = canonicalData(payload.data);
    return {
      ok: true, envelope: env, data: canon,
      counts: payload.counts || countsOf(canon),
      filtered: payload.filtered || {},
      exportedAt: payload.exportedAt || env.exportedAt,
    };
  }

  // ---------- E-23 迁移（老数据补 account，幂等、原子） ----------
  // 扫 guanzhu_ledger.trades + 真实案例 + tk6 映射；任一失败 → 整体不写（先回滚到 22 备份）。
  // 返回 {total,migrated,failed,dupKeys,...}；正常数据 failed=0，再跑一次 migrated=0。
  function migrateV2(opts) {
    opts = opts || {};
    const out = {
      ok: true, total: 0, migrated: 0, failed: 0, dupKeys: [],
      casesTotal: 0, casesMigrated: 0, keysMigrated: 0,
      rebuilt: false, aborted: false, writeFailed: false,
    };
    const plans = [];
    const snapshots = [];

    // 1) 账本：缺 account 的逐笔补 default；笔数不变，只报告键碰撞，不删数据
    const rawLedger = getRaw(LEDGER_KEY);
    if (rawLedger != null) {
      let ledger;
      try { ledger = JSON.parse(rawLedger); } catch (e) { out.failed += 1; ledger = null; }
      if (ledger && !Array.isArray(ledger.trades)) {
        out.failed += 1;
      } else if (ledger) {
        out.total = ledger.trades.length;
        const L = ledgerApi();
        let changed = 0;
        const trades = ledger.trades.map((t) => {
          if (!t || typeof t !== 'object') { out.failed += 1; return t; }
          if (String(t.account || '')) return t;
          changed += 1;
          return Object.assign({}, t, { account: DEFAULT_ACCOUNT });
        });

        const seen = Object.create(null), dupSeen = Object.create(null);
        trades.forEach((t) => {
          if (!t || typeof t !== 'object' || !L || typeof L.tradeKey !== 'function') return;
          try {
            const k = L.tradeKey(t);
            if (seen[k]) {
              if (!dupSeen[k]) { dupSeen[k] = 1; out.dupKeys.push(k); }
            } else {
              seen[k] = 1;
            }
          } catch (e) { out.failed += 1; }
        });

        if (changed) {
          out.migrated = changed;
          ledger.trades = trades;
          plans.push({ key: LEDGER_KEY, next: ledger });
          snapshots.push({ key: LEDGER_KEY, raw: rawLedger });
        }
      }
    }

    // 2) 真实案例：trades 与 verdict.lines 同步补 default；示例案例不动（签名必须保留）
    const seq = Math.max(0, +(getJson(CASE_SEQ, 0) || 0));
    const recurState = getJson(RECUR_KEY, null);
    for (let i = 1; i <= seq; i++) {
      const key = CASE_PREFIX + pad3(i);
      const raw = getRaw(key);
      if (raw == null) continue;
      out.casesTotal++;
      let c;
      try { c = JSON.parse(raw); } catch (e) { out.failed += 1; continue; }
      if (!c || typeof c !== 'object') { out.failed += 1; continue; }
      if (demoCheck(c.verdict, caseRefOf(i), recurState)) continue;

      let fields = 0;
      if (Array.isArray(c.trades)) {
        c.trades = c.trades.map((t) => {
          if (!t || typeof t !== 'object') { out.failed += 1; return t; }
          if (String(t.account || '')) return t;
          fields += 1;
          return Object.assign({}, t, { account: DEFAULT_ACCOUNT });
        });
      }
      if (c.verdict && Array.isArray(c.verdict.lines)) {
        c.verdict.lines = c.verdict.lines.map((l) => {
          if (!l || typeof l !== 'object') { out.failed += 1; return l; }
          if (String(l.account || '')) return l;
          fields += 1;
          return Object.assign({}, l, { account: DEFAULT_ACCOUNT });
        });
      }
      if (fields) {
        out.casesMigrated += 1;
        plans.push({ key, next: c });
        snapshots.push({ key, raw });
      }
    }

    // 3) tk6 映射（申诉例外 / 买入理由 / 止损价）：键补 default，值不动
    TK6_MAP_KEYS.forEach((k) => {
      const raw = getRaw(k);
      if (raw == null) return;
      const plan = planTk6Map(raw, k);
      if (plan.failed) { out.failed += plan.failed; return; }
      if (plan.changed) {
        out.keysMigrated += plan.changed;
        plans.push({ key: k, next: plan.next });
        snapshots.push({ key: k, raw });
      }
    });

    // 硬闸门：失败率必须为 0；有任何失败就不落盘，保留现场等 22 备份回滚
    if (out.failed > 0) {
      out.ok = false;
      out.aborted = true;
      out.migrated = 0;
      out.casesMigrated = 0;
      out.keysMigrated = 0;
      return out;
    }

    // 4) 落盘（写入失败则用快照回滚）
    if (plans.length) {
      const s = storage();
      if (!s) {
        out.ok = false; out.aborted = true; out.writeFailed = true; out.failed += 1;
        out.migrated = 0; out.casesMigrated = 0; out.keysMigrated = 0;
        return out;
      }
      try {
        plans.forEach((p) => { if (!setJson(p.key, p.next)) throw new Error('write_failed'); });
      } catch (e) {
        snapshots.forEach((sn) => {
          try { s.setItem(sn.key, sn.raw); } catch (x) { /* 回滚尽力而为 */ }
        });
        out.ok = false; out.aborted = true; out.writeFailed = true; out.failed += 1;
        out.migrated = 0; out.casesMigrated = 0; out.keysMigrated = 0;
        return out;
      }
    }

    // 5) 重建复发索引（tk6 带 account，必须重算；示例案例由 backfill 自行跳过）
    if (!opts.noRebuild && (out.migrated || out.casesMigrated || out.keysMigrated)) {
      const r = recurApi();
      if (r && typeof r.rebuild === 'function') {
        try { out.rebuildResult = r.rebuild(); out.rebuilt = true; } catch (e) { out.failed += 1; }
      }
    }
    return out;
  }

  async function importBackup(input, opts) {
    opts = opts || {};
    const dec = await decodeBackup(input, opts.password);
    if (!dec.ok) return dec;

    const data = dec.data;
    const now = new Date();
    const out = {
      ok: true, version: VERSION,
      addedTrades: 0, dupTrades: 0, addedCases: 0, skippedCases: 0,
      conflicts: [], writtenKeys: [], rebuilt: false, ledgerMerged: false,
      demoFiltered: (dec.filtered && Array.isArray(dec.filtered.demoCases)) ? dec.filtered.demoCases.length : 0,
      migrate: null,
    };

    // 先校验备份里的账本，再迁移本机老数据（否则老 key 无 account，合并会把同一笔当新笔）
    if (data[LEDGER_KEY] !== undefined) {
      const check = validateLedger(data[LEDGER_KEY]);
      if (!check.ok) return check;
    }
    const pre = migrateV2();
    out.migrate = {
      total: pre.total, migrated: pre.migrated, failed: pre.failed,
      casesMigrated: pre.casesMigrated, keysMigrated: pre.keysMigrated,
      dupKeys: pre.dupKeys.slice(0, 20), aborted: !!pre.aborted,
    };
    if (pre.rebuilt) out.rebuilt = true;

    // 账本：本机有成交 → 按 tradeKey 合并；本机空 → 原样恢复
    if (data[LEDGER_KEY] !== undefined) {
      const inc = data[LEDGER_KEY];
      const cur = getJson(LEDGER_KEY, null);
      const L = ledgerApi();
      if (cur && Array.isArray(cur.trades) && cur.trades.length && L && typeof L.mergeTrades === 'function') {
        const merged = L.mergeTrades(cur, inc.trades, { importId: 'backup_' + now.getTime(), now: now.toISOString() });
        const next = merged.ledger || { trades: [], imports: [], dupLog: [] };
        next.imports = mergeImports(next.imports, inc.imports);
        next.dupLog = (next.dupLog || []).concat(Array.isArray(inc.dupLog) ? inc.dupLog : []).slice(-500);
        if (!setJson(LEDGER_KEY, next)) return { ok: false, error: 'write_failed' };
        out.addedTrades = merged.added || 0;
        out.dupTrades = merged.dup || 0;
        out.ledgerMerged = true;
      } else {
        if (!setJson(LEDGER_KEY, inc)) return { ok: false, error: 'write_failed' };
        out.addedTrades = inc.trades.length;
      }
      out.writtenKeys.push(LEDGER_KEY);
    }

    // 案例编号：只升不降，避免覆盖本机更大的编号
    if (data[CASE_SEQ] !== undefined) {
      const incSeq = +data[CASE_SEQ];
      if (Number.isFinite(incSeq) && incSeq > 0) {
        const curSeq = +(getJson(CASE_SEQ, 0) || 0);
        if (incSeq > curSeq && !setJson(CASE_SEQ, incSeq)) return { ok: false, error: 'write_failed' };
        out.writtenKeys.push(CASE_SEQ);
      }
    }

    // 案例：同编号且内容不同 → 保留本机，记冲突
    Object.keys(data).forEach((k) => {
      if (!CASE_RE.test(k)) return;
      const inc = data[k];
      const cur = getJson(k, null);
      if (cur !== null) {
        if (!same(cur, inc)) { out.conflicts.push(k); out.skippedCases++; }
        return;
      }
      if (!setJson(k, inc)) { out.conflicts.push(k); out.skippedCases++; return; }
      out.addedCases++;
      out.writtenKeys.push(k);
    });

    // 单例 key：本机已有且内容不同 → 保留本机，记冲突
    SINGLE_KEYS.forEach((k) => {
      if (k === LEDGER_KEY || data[k] === undefined) return;
      const inc = data[k];
      const cur = getJson(k, null);
      if (cur !== null) {
        if (!same(cur, inc)) out.conflicts.push(k);
        return;
      }
      if (!setJson(k, inc)) { out.conflicts.push(k); return; }
      out.writtenKeys.push(k);
    });

    // 只还原了案例、但没还原复发索引 → 重建一次（示例案例由 backfill 自行跳过）
    const recurRestored = out.writtenKeys.indexOf(RECUR_KEY) >= 0;
    const r = recurApi();
    if (out.addedCases && !recurRestored && r && typeof r.backfill === 'function') {
      try { r.backfill(); out.rebuilt = true; } catch (e) { /* 重建失败不阻塞导入结果 */ }
    }

    // 导入后再跑一次迁移：老备份被补齐 account；已迁移数据应为 migrated=0（幂等）
    const post = migrateV2();
    if (out.migrate) {
      out.migrate.after = { total: post.total, migrated: post.migrated, failed: post.failed };
    }
    if (post.rebuilt) out.rebuilt = true;
    return out;
  }

  // ---------- 逐笔 CSV ----------
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function hmss(t) {
    const s = String(t || '').replace(/[^\d]/g, '');
    if (s.length !== 6) return String(t || '');
    return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
  }
  function ledgerCsv(ledger) {
    const rows = [['日期', '时间', '代码', '名称', '方向', '价格', '数量', '账户']];
    const trades = ledger && Array.isArray(ledger.trades) ? ledger.trades : [];
    trades.forEach((t) => {
      rows.push([
        t.date || '', hmss(t.time), t.code || '', t.name || '', t.side || '',
        t.price == null ? '' : t.price, t.qty == null ? '' : t.qty,
        accountLabel(accountOf(t)),
      ]);
    });
    return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function exportCsv(opts) {
    opts = opts || {};
    const at = opts.now instanceof Date ? opts.now : new Date();
    const ledger = getJson(LEDGER_KEY, null);
    const trades = ledger && Array.isArray(ledger.trades) ? ledger.trades : [];
    return { ok: true, text: ledgerCsv(ledger), filename: filename('csv', at), rows: trades.length };
  }

  // ---------- 按账户统计（复核页 / 报告页） ----------
  function today8() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }
  function addDays8(date, n) {
    const y = +date.slice(0, 4), m = +date.slice(4, 6), d = +date.slice(6, 8);
    const t = Date.UTC(y, m - 1, d) + n * 86400000;
    const x = new Date(t);
    return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, '0')}${String(x.getUTCDate()).padStart(2, '0')}`;
  }
  function ymd(date8) {
    const s = String(date8 || '');
    return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
  }

  function caseAccountMap() {
    const map = {};
    const seq = Math.max(0, +(getJson(CASE_SEQ, 0) || 0));
    for (let i = 1; i <= seq; i++) {
      const c = getJson(CASE_PREFIX + pad3(i), null);
      if (!c) continue;
      map[caseRefOf(i)] = caseAccount(c);
    }
    return map;
  }

  // 在 recur 现有索引上做账户视图：tk6 键的 account 段 + 案例归属
  // （不改 recur.js；日级 day_checks 没有 tk6 键，按所属案例的账户归属）
  function recurByAccount(account, windowDays, endDate) {
    const want = String(account || '').trim() || DEFAULT_ACCOUNT;
    const r = recurApi();
    if (!r || typeof r._state !== 'function') return [];
    const st = r._state();
    if (!st || !st.rules) return [];
    const end = (r.date8 ? r.date8(endDate || today8()) : (endDate || today8()));
    const win = Math.max(1, +windowDays || 30);
    const start = addDays8(end, -(win - 1));
    const cases = caseAccountMap();
    const out = [];
    Object.keys(st.rules).forEach((ruleId) => {
      const rule = st.rules[ruleId] || {};
      const days = rule.days || {};
      const dates = Object.keys(days)
        .filter((d) => d >= start && d <= end)
        .filter((d) => {
          const day = days[d] || {};
          const keys = Array.isArray(day.keys) ? day.keys : [];
          if (keys.some((k) => (keyAccount(k) || DEFAULT_ACCOUNT) === want)) return true;
          const refs = Array.isArray(day.cases) ? day.cases : [];
          if (refs.some((ref) => (cases[ref] || DEFAULT_ACCOUNT) === want)) return true;
          return !keys.length && !refs.length && want === DEFAULT_ACCOUNT;
        })
        .sort();
      if (dates.length) out.push({ ruleId, count: dates.length, dates });
    });
    out.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
    return out;
  }

  function ledgerSummaryFor(account) {
    const L = ledgerApi();
    const ledger = getJson(LEDGER_KEY, null) || { trades: [], imports: [], dupLog: [] };
    if (L && typeof L.summarize === 'function') {
      try { return L.summarize(ledger, { account }); } catch (e) { /* 落到空统计 */ }
    }
    return { total: 0, coverageFrom: '', coverageTo: '', tradeDays: 0, importCount: 0 };
  }

  // ---------- 复核页账户下拉（reviewTop） ----------
  let reviewState = null;
  function renderAccountBar(state) {
    if (!flagOn()) return '';
    if (!state || !Array.isArray(state.trades) || !state.trades.length) return '';
    // 示例体验不打 account：保住 recur.js 的 9 笔示例签名，示例继续被备份/复发过滤
    if (state.isDemo) return '';
    reviewState = state;
    const current = explicitAccount(state.trades) || DEFAULT_ACCOUNT;
    // 本批一个账户：只补空行，不覆盖已标注的账户
    state.trades.forEach((t) => {
      if (t && typeof t === 'object' && !String(t.account || '')) t.account = current;
    });
    const counts = {};
    state.trades.forEach((t) => { const a = accountOf(t); counts[a] = (counts[a] || 0) + 1; });
    const mixed = Object.keys(counts).length > 1;
    const opts = ACCOUNTS.map((a) => `<option value="${a.id}"${a.id === current ? ' selected' : ''}>${a.label}</option>`).join('');
    return '<div class="acct-bar" id="acct-bar">'
      + '<label class="acct-label" for="acct-select">本批账户</label>'
      + '<select id="acct-select" class="acct-select">' + opts + '</select>'
      + '<span class="acct-hint">' + state.trades.length + ' 笔 · ' + esc(accountLabel(current))
      + (mixed ? '（含多个账户）' : '') + '</span>'
      + '</div>';
  }

  // ---------- 报告页账户视图（reportBottom） ----------
  let reportCtx = null;
  let reportAccount = '';
  function renderAccountReport(v, state) {
    if (!flagOn()) return '';
    if (state && state.isDemo) return '';  // 示例报告不展示账户口径，避免被当成真实账户
    reportCtx = { v, state };
    const lines = (v && Array.isArray(v.lines)) ? v.lines : [];
    const own = explicitAccount(lines) || explicitAccount(state && state.trades) || DEFAULT_ACCOUNT;
    reportAccount = own;
    const opts = ACCOUNTS.map((a) => `<option value="${a.id}"${a.id === own ? ' selected' : ''}>${a.label}</option>`).join('');
    return '<div class="acct-card" id="acct-rep">'
      + '<div class="acct-head">'
      + '<h4>按账户看</h4>'
      + '<select id="acct-rep-select" class="acct-select">' + opts + '</select>'
      + '</div>'
      + '<p class="acct-own">本档案账户：' + esc(accountLabel(own)) + '</p>'
      + '<div id="acct-rep-body">' + renderAccountBody(v) + '</div>'
      + '</div>';
  }

  function renderAccountBody(v) {
    const account = reportAccount || DEFAULT_ACCOUNT;
    const lines = (v && Array.isArray(v.lines)) ? v.lines : [];
    const own = explicitAccount(lines)
      || (reportCtx && explicitAccount(reportCtx.state && reportCtx.state.trades))
      || DEFAULT_ACCOUNT;
    let caseHtml;
    if (account === own) {
      const list = lines.filter((l) => accountOf(l) === account);
      const bad = list.filter((l) => l.flag === '违规').length;
      caseHtml = '<div class="acct-line-item">本档案：<b>' + list.length + '</b> 笔，违规 <b>' + bad + '</b> 笔</div>';
    } else {
      caseHtml = '<div class="acct-line-item acct-dim">本档案属于「' + esc(accountLabel(own))
        + '」；当前查看「' + esc(accountLabel(account)) + '」，本档案数字不参与。</div>';
    }
    const sum = ledgerSummaryFor(account);
    const cover = sum.total ? '覆盖 ' + esc(ymd(sum.coverageFrom)) + ' ~ ' + esc(ymd(sum.coverageTo)) : '该账户暂无账本记录';
    const rec = recurByAccount(account, 30);
    const recHtml = rec.length
      ? '<div class="acct-line-item">近 30 天触发日（按成交日，窗口 30 天）：</div>'
        + '<div class="acct-rules">'
        + rec.slice(0, 6).map((x) => '<span class="acct-chip">' + esc(x.ruleId) + ' ' + x.count + ' 天</span>').join('')
        + '</div>'
      : '<div class="acct-line-item acct-dim">近 30 天无触发记录</div>';
    return caseHtml
      + '<div class="acct-line-item">账本：<b>' + sum.total + '</b> 笔 · ' + cover + '</div>'
      + recHtml
      + '<div class="acct-foot">口径：按成交日不按上传日；窗口 30 天；只统计带该账户标记的记录。</div>';
  }

  function updateReportBody() {
    if (typeof document === 'undefined' || !reportCtx) return;
    const el = document.getElementById('acct-rep-body');
    if (el) el.innerHTML = renderAccountBody(reportCtx.v);
  }

  function onAccountChange(e) {
    const t = e && e.target;
    if (!t || !t.id) return;
    if (t.id === 'acct-select' && reviewState) {
      const val = String(t.value || '');
      if (!ACCOUNTS.some((a) => a.id === val)) return;
      let n = 0;
      reviewState.trades.forEach((x) => {
        if (x && typeof x === 'object') { x.account = val; n++; }
      });
      const hint = document.querySelector('#acct-bar .acct-hint');
      if (hint) hint.textContent = n + ' 笔 · ' + accountLabel(val);
      track('account_tag', { account: val, trades: n });
      return;
    }
    if (t.id === 'acct-rep-select') {
      const val = String(t.value || '');
      if (!ACCOUNTS.some((a) => a.id === val)) return;
      reportAccount = val;
      updateReportBody();
      track('account_tag', { account: val, view: 'report' });
    }
  }

  // ---------- 设置页 UI（只在 flag 开时注册） ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
  }
  function renderPanel() {
    if (!flagOn()) return '';
    return '<div class="asset-card" id="asset-panel">'
      + '<h4>数据备份（本机）</h4>'
      + '<p class="asset-note">备份含账本、案例、规则与本机设置；示例案例不进备份。文件由你保管，不上传服务器。</p>'
      + '<div class="asset-row">'
      + '<input id="asset-pass" class="asset-input" type="password" autocomplete="new-password" placeholder="可选：给备份设密码">'
      + '<button id="asset-export" class="btn ghost" type="button">导出备份</button>'
      + '<button id="asset-csv" class="btn ghost" type="button">导出逐笔 CSV</button>'
      + '</div>'
      + '<div class="asset-row">'
      + '<input id="asset-import-pass" class="asset-input" type="password" autocomplete="off" placeholder="导入加密备份时填密码">'
      + '<button id="asset-import" class="btn ghost" type="button">导入备份</button>'
      + '<input id="asset-file" type="file" accept=".json,application/json" hidden>'
      + '</div>'
      + '<p id="asset-status" class="asset-status"></p>'
      + '</div>';
  }

  // ---------- E-24 / E-25 设置页 UI（与备份面板同一个 flag） ----------
  function posBodyHtml() {
    const list = readPositions();
    if (!list.length) return '<p class="asset-empty">还没有期初持仓。账本开始前已持有的股票填在这里。</p>';
    return '<div class="asset-list">' + list.map((p, i) => '<div class="asset-item">'
      + '<span class="asset-item-main">' + esc((p.code ? p.code + ' ' : '') + p.name)
      + ' · ' + p.qty + ' 股 · 成本 ' + p.cost + '</span>'
      + '<span class="asset-item-side">' + esc(accountLabel(p.account))
      + '<button type="button" class="asset-del" data-pos-del="' + i + '">删除</button></span>'
      + '</div>').join('') + '</div>';
  }
  function renderPositionsPanel() {
    if (!flagOn()) return '';
    const opts = ACCOUNTS.map((a) => '<option value="' + a.id + '"' + (a.id === DEFAULT_ACCOUNT ? ' selected' : '') + '>' + a.label + '</option>').join('');
    return '<div class="asset-card" id="pos-panel">'
      + '<h4>期初持仓（手动填写）</h4>'
      + '<p class="asset-note">账本开始前已持有的股票。判定时当作最早买入参与 FIFO 成本配对；不产生判定行、不计成交笔数。</p>'
      + '<div class="asset-row asset-row-wrap">'
      + '<input id="pos-code" class="asset-input" type="text" placeholder="代码（可空）">'
      + '<input id="pos-name" class="asset-input" type="text" placeholder="名称">'
      + '<input id="pos-qty" class="asset-input" type="number" min="1" step="1" placeholder="数量">'
      + '<input id="pos-cost" class="asset-input" type="number" min="0.001" step="0.001" placeholder="成本价">'
      + '<select id="pos-account" class="acct-select">' + opts + '</select>'
      + '<button id="pos-add" class="btn ghost" type="button">加入期初</button>'
      + '</div>'
      + '<div id="pos-body">' + posBodyHtml() + '</div>'
      + '<p id="pos-status" class="asset-status"></p>'
      + '</div>';
  }

  function todayInput() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function money(n) {
    return '¥' + (+n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  function cashBodyHtml() {
    const list = readCash();
    const sum = principalOf(list);
    const rows = list.length
      ? '<div class="asset-list">' + list.map((c, i) => '<div class="asset-item">'
        + '<span class="asset-item-main">' + esc(ymd(c.date)) + ' · ' + (c.dir === 'in' ? '入金' : '出金') + ' ' + money(c.amount) + '</span>'
        + '<span class="asset-item-side"><button type="button" class="asset-del" data-cash-del="' + i + '">删除</button></span>'
        + '</div>').join('') + '</div>'
      : '<p class="asset-empty">还没有出入金记录。</p>';
    return rows
      + '<p class="asset-sum" id="cash-sum">本金口径：累计入金 ' + money(sum.in) + ' · 累计出金 ' + money(sum.out)
      + ' · 净本金 ' + money(sum.net) + '（' + sum.count + ' 笔；不做收益率）</p>';
  }
  function renderCashPanel() {
    if (!flagOn()) return '';
    return '<div class="asset-card" id="cash-panel">'
      + '<h4>出入金（手动填写）</h4>'
      + '<p class="asset-note">只记银证转账这类本金进出。只做本金口径，不计算收益率。</p>'
      + '<div class="asset-row asset-row-wrap">'
      + '<input id="cash-date" class="asset-input" type="date" value="' + todayInput() + '">'
      + '<input id="cash-amount" class="asset-input" type="number" min="0.01" step="0.01" placeholder="金额（元）">'
      + '<select id="cash-dir" class="acct-select"><option value="in">入金</option><option value="out">出金</option></select>'
      + '<button id="cash-add" class="btn ghost" type="button">记一笔</button>'
      + '</div>'
      + '<div id="cash-body">' + cashBodyHtml() + '</div>'
      + '<p id="cash-status" class="asset-status"></p>'
      + '</div>';
  }

  function setPanelStatus(id, text, isError) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(text || '');
    el.className = 'asset-status' + (isError ? ' asset-error' : '');
  }
  function refreshPositions() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('pos-body');
    if (el) el.innerHTML = posBodyHtml();
  }
  function refreshCash() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('cash-body');
    if (el) el.innerHTML = cashBodyHtml();
  }

  function onPosAdd() {
    const r = addPosition({
      code: inputValue('pos-code'),
      name: inputValue('pos-name'),
      qty: inputValue('pos-qty'),
      cost: inputValue('pos-cost'),
      account: typeof document !== 'undefined' && document.getElementById('pos-account')
        ? document.getElementById('pos-account').value : DEFAULT_ACCOUNT,
    });
    if (!r.ok) { setPanelStatus('pos-status', errorText(r.error), true); return; }
    ['pos-code', 'pos-name', 'pos-qty', 'pos-cost'].forEach((id) => {
      const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
      if (el) el.value = '';
    });
    const last = r.positions[r.positions.length - 1];
    setPanelStatus('pos-status', (r.replaced ? '已更新：' : '已加入：') + (last.code ? last.code + ' ' : '') + last.name, false);
    refreshPositions();
  }
  function onCashAdd() {
    const r = addCash({
      date: inputValue('cash-date'),
      amount: inputValue('cash-amount'),
      dir: typeof document !== 'undefined' && document.getElementById('cash-dir')
        ? document.getElementById('cash-dir').value : 'in',
    });
    if (!r.ok) { setPanelStatus('cash-status', errorText(r.error), true); return; }
    const el = typeof document !== 'undefined' ? document.getElementById('cash-amount') : null;
    if (el) el.value = '';
    setPanelStatus('cash-status', '已记一笔：' + ymd(r.entry.date) + ' ' + (r.entry.dir === 'in' ? '入金' : '出金') + ' ' + money(r.entry.amount), false);
    refreshCash();
  }

  function setStatus(text, isError) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('asset-status');
    if (!el) return;
    el.textContent = String(text || '');
    el.className = 'asset-status' + (isError ? ' asset-error' : '');
  }
  function inputValue(id) {
    if (typeof document === 'undefined') return '';
    const el = document.getElementById(id);
    return el && typeof el.value === 'string' ? el.value : '';
  }
  function downloadText(name, text, mime) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
    const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } }, 3000);
    return true;
  }
  function readFileText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('file_read_failed'));
      fr.readAsText(file);
    });
  }

  async function onExportClick() {
    const btn = document.getElementById('asset-export');
    if (btn) btn.disabled = true;
    setStatus('正在生成备份…');
    const pass = inputValue('asset-pass');
    const r = await exportBackup({ password: pass || '' });
    if (btn) btn.disabled = false;
    if (!r.ok) {
      setStatus('导出失败：' + errorText(r.error), true);
      return;
    }
    downloadText(r.filename, r.json, 'application/json;charset=utf-8');
    track('export', { encrypted: r.encrypted ? 1 : 0, trades: r.counts.ledgerTrades, cases: r.counts.cases });
    // COLL-1c：备份文件已生成 → 记一次「导出」行为；图鉴不在场 / 存储禁用都不影响导出
    try { if (typeof PanjiCollection !== 'undefined' && PanjiCollection && typeof PanjiCollection.record === 'function') PanjiCollection.record('export'); } catch (e) {}
    const demo = r.demoCases && r.demoCases.length ? ' · 跳过 ' + r.demoCases.length + ' 个示例案例' : '';
    setStatus('已导出：' + r.counts.ledgerTrades + ' 笔成交 · ' + r.counts.cases + ' 个真实案例' + demo + (r.encrypted ? ' · 已加密' : ''));
  }

  function onCsvClick() {
    const r = exportCsv();
    if (!r.ok) { setStatus('CSV 导出失败', true); return; }
    downloadText(r.filename, r.text, 'text/csv;charset=utf-8');
    track('export', { csv: 1, trades: r.rows });
    setStatus('已导出逐笔 CSV：' + r.rows + ' 笔');
  }

  async function onFileChange(e) {
    const input = e.target;
    if (!input || input.id !== 'asset-file') return;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { setStatus('文件超过 20MB，已拒绝', true); return; }
    setStatus('正在导入…');
    let text;
    try { text = await readFileText(file); } catch (err) { setStatus('文件读取失败', true); return; }
    const r = await importBackup(text, { password: inputValue('asset-import-pass') });
    if (!r.ok) { setStatus('导入失败：' + errorText(r.error), true); return; }
    track('import', { addedTrades: r.addedTrades, addedCases: r.addedCases, conflicts: r.conflicts.length });
    const parts = [
      '导入完成：账本新增 ' + r.addedTrades + ' 笔、重复 ' + r.dupTrades + ' 笔',
      '案例新增 ' + r.addedCases + ' 个',
    ];
    if (r.rebuilt) parts.push('已重建复发索引');
    if (r.conflicts.length) parts.push('冲突保留本机 ' + r.conflicts.length + ' 项');
    setStatus(parts.join('；') + '。页面即将刷新…');
    setTimeout(() => { try { location.reload(); } catch (e) { /* 忽略 */ } }, 1200);
  }

  function onClick(e) {
    const t = e && e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('#asset-export')) { e.preventDefault(); onExportClick(); return; }
    if (t.closest('#asset-csv')) { e.preventDefault(); onCsvClick(); return; }
    if (t.closest('#asset-import')) {
      e.preventDefault();
      const f = document.getElementById('asset-file');
      if (f) f.click();
      return;
    }
    if (t.closest('#pos-add')) { e.preventDefault(); onPosAdd(); return; }
    const posDel = t.closest('[data-pos-del]');
    if (posDel) {
      e.preventDefault();
      const r = removePosition(posDel.getAttribute('data-pos-del'));
      if (!r.ok) setPanelStatus('pos-status', errorText(r.error), true);
      else setPanelStatus('pos-status', '已删除：' + (r.removed.code ? r.removed.code + ' ' : '') + r.removed.name, false);
      refreshPositions();
      return;
    }
    if (t.closest('#cash-add')) { e.preventDefault(); onCashAdd(); return; }
    const cashDel = t.closest('[data-cash-del]');
    if (cashDel) {
      e.preventDefault();
      const r = removeCash(cashDel.getAttribute('data-cash-del'));
      if (!r.ok) setPanelStatus('cash-status', errorText(r.error), true);
      else setPanelStatus('cash-status', '已删除 ' + ymd(r.removed.date) + ' ' + (r.removed.dir === 'in' ? '入金' : '出金'), false);
      refreshCash();
    }
  }

  function errorText(code) {
    const map = {
      password_required: '这是加密备份，请先填导入密码',
      bad_password: '密码不正确',
      crypto_unavailable: '当前浏览器不支持 WebCrypto，无法加解密',
      version_unsupported: '备份版本不支持（只认 v2）',
      app_invalid: '不是本产品的备份文件',
      json_invalid: '文件不是合法 JSON',
      ledger_invalid: '备份里的账本结构无效',
      trade_invalid: '备份里有无效成交（日期/方向/价格/数量）',
      key_not_allowed: '备份里有未知 key，已拒绝导入',
      position_invalid: '期初持仓无效：数量和成本价须为正数，代码/名称至少填一项',
      position_limit: '期初持仓最多 ' + MAX_POSITIONS + ' 条',
      position_not_found: '这条期初持仓已不存在',
      cash_invalid: '出入金无效：日期、金额（正数）、方向都必填',
      cash_limit: '出入金最多 ' + MAX_CASH + ' 笔',
      cash_not_found: '这条出入金记录已不存在',
      write_failed: '本机存储写入失败，请检查浏览器存储空间',
    };
    return map[code] || String(code || '未知错误');
  }

  let lastMigration = null;

  // E-24：app.js 是冻结文件、server.js 由另一会话独占改，这里在客户端给判定请求体补 positions。
  // 只在 flag 开时装一次；解析失败原样透传，绝不阻断判定。
  let bridgeInstalled = false;
  function installPositionsBridge() {
    if (bridgeInstalled) return false;
    if (!root || typeof root.fetch !== 'function') return false;
    const orig = root.fetch;
    root.fetch = function (input, init) {
      let next = init;
      try {
        const url = typeof input === 'string' ? input : String((input && input.url) || '');
        if (/\/(api\/confirm|api\/judge)(?:[?#]|$)/.test(url) && init && typeof init.body === 'string') {
          const body = JSON.parse(init.body);
          const inj = withPositions(body);
          if (inj !== body) next = Object.assign({}, init, { body: JSON.stringify(inj) });
        }
      } catch (e) { /* 原样透传 */ }
      return orig.call(root, input, next);
    };
    bridgeInstalled = true;
    return true;
  }

  function boot() {
    if (booted) return false;
    if (!root || !root.document) return false;
    if (!flagOn()) return false;
    const ext = root.PanjiExt;
    if (!ext) return false;
    booted = true;
    if (Array.isArray(ext.rulesBottom)) ext.rulesBottom.push(renderPanel);
    // E-24 / E-25：期初持仓与出入金（手填），与备份面板共用 asset flag
    if (Array.isArray(ext.rulesBottom)) ext.rulesBottom.push(renderPositionsPanel);
    if (Array.isArray(ext.rulesBottom)) ext.rulesBottom.push(renderCashPanel);
    if (Array.isArray(ext.reviewTop)) ext.reviewTop.push(renderAccountBar);
    if (Array.isArray(ext.reportBottom)) ext.reportBottom.push(renderAccountReport);
    root.document.addEventListener('click', onClick, true);
    root.document.addEventListener('change', onFileChange, true);
    root.document.addEventListener('change', onAccountChange, true);
    installPositionsBridge();
    // E-23：进复核页之前把老账本补 default 并重建复发索引（幂等；失败不阻塞页面）
    try {
      lastMigration = migrateV2();
    } catch (e) {
      lastMigration = { ok: false, failed: 1, aborted: true, error: String((e && e.message) || e) };
    }
    return true;
  }

  return {
    VERSION, APP, FLAG,
    SINGLE_KEYS, CASE_PREFIX, CASE_SEQ, RECUR_KEY, LEDGER_KEY,
    POS_KEY, CASH_KEY, DEFAULT_ACCOUNT, ACCOUNTS,
    configure,
    collectData, countsOf, exportBackup, exportCsv, ledgerCsv,
    decodeBackup, importBackup, validateLedger, isAllowedKey,
    canonicalData, migrateV2, normalizeTk6Key, keyAccount,
    accountOf, accountLabel, explicitAccount, caseAccount, recurByAccount,
    readPositions, addPosition, removePosition, positionsForRequest, withPositions,
    readCash, addCash, removeCash, principalOf,
    renderPanel, renderPositionsPanel, renderCashPanel,
    renderAccountBar, renderAccountReport, onAccountChange, boot,
    installPositionsBridge,
    errorText,
    _state: () => ({ booted, kdfIterations, lastMigration, bridgeInstalled }),
  };
});
