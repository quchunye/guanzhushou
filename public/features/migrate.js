// features/migrate.js —— 档案迁移 v1（导出 / 导入 / 二维码评估）
//
// 边界：
//   - 纯前端、只读写本机 localStorage；不发任何网络请求，不引第三方依赖。
//   - 不碰 index.html / app.js / upload.js / replay.js / replay.html；只被 migrate.html 使用。
//   - 键白名单只含「档案相关」key；设备级开关、支付身份、开闸记录不进迁移包（见 EXCLUDED）。
//
// 导出包结构（schema panji.migrate.v1）：
//   { app, kind, schema, schemaVersion, exportedAt, counts:{keys,trades,cases}, sha256, data }
//   sha256 = SHA-256(canonicalStringify(data))，只覆盖 data，不覆盖信封元信息。
//
// 导入：解析 → 白名单 → sha 校验 → 旧 schema 归一 → 预览（不写）→ 用户确认 → 原子写入（失败回滚）。
// 冲突策略：merge（默认）= 同 id 内容不同的档案追加为新档案；overwrite = 同 id 覆盖。
//
// 二维码：v1 不做，评估见 QR_EVAL（一次性短码需服务器；分片二维码需自研编解码器且无法在无相机环境验证）。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else {
    const api = factory(root);
    root.PanjiFeatures = root.PanjiFeatures || {};
    root.PanjiFeatures.migrate = api;
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const APP = 'guanzhushou';
  const KIND = 'panji-migrate';
  const SCHEMA = 'panji.migrate.v1';
  const SCHEMA_VERSION = 1;
  // 自设上限（localStorage 通常约 5MB，留 1.5MB 余量给页面其他数据）
  const LIMIT_BYTES = 3.5 * 1024 * 1024;
  const LIMIT_LABEL = '3.5MB';
  const CASE_PREFIX = 'guanzhu_case_';
  const CASE_SEQ = 'guanzhu_case_seq';
  const LEDGER_KEY = 'guanzhu_ledger';
  const RECUR_KEY = 'guanzhu_recur_v1';
  const EXEMPT_KEY = 'guanzhu_exempt_v1';
  const REASON_KEY = 'guanzhu_reason_v1';
  const STOP_KEY = 'guanzhu_stop_v1';
  const CASE_RE = /^guanzhu_case_\d{3,}$/;

  // 迁移白名单：档案与本机记录（不含设备设置 / 支付 / 开闸审计）
  const ARCHIVE_KEYS = [
    LEDGER_KEY, 'guanzhu_rules_v1', RECUR_KEY, EXEMPT_KEY,
    'guanzhu_focus_v1', 'guanzhu_note_v1', REASON_KEY, STOP_KEY, 'guanzhu_mood_v1',
    'guanzhu_rules_hist_v1', 'guanzhu_pos_v1', 'guanzhu_cash_v1',
    'guanzhu_upload_layout_v1', 'guanzhu_recall_v1',
    'guanzhu_ack_v1', 'guanzhu_ack_txt_v1', 'guanzhu_openplan_v1', 'guanzhu_month_v1',
    'guanzhu_collection_v1', 'guanzhu_wizard_seen_v1',
  ];
  // 明确不迁移的 key 与原因（页面与回报都要引用同一份口径）
  const EXCLUDED = {
    'guanzhu_flags_v1': '设备级功能开关，换机后应在目标设备重新选择',
    'guanzhu_flag_audit_v1': '本机开闸记录，仅用于本机排查',
    'guanzhu_client_token': '支付身份标识，不随档案迁移',
    'guanzhu_pending_pay': '未完成支付快照，不随档案迁移',
  };
  const TK6_MAP_KEYS = [EXEMPT_KEY, REASON_KEY, STOP_KEY];

  const QR_EVAL = {
    status: 'not_implemented_v1',
    title: 'v1 不做二维码迁移',
    options: [
      {
        id: 'short_code',
        name: '一次性短码',
        feasible: false,
        reason: '短码必须由服务器签发并在另一台设备校验，本功能红线是纯前端、档案数据不经服务器中转，无法成立。',
      },
      {
        id: 'chunked_qr',
        name: '分片二维码（共 N 张 / 第 i 张）',
        feasible: false,
        reason: '仓库内没有任何二维码依赖，也不允许 CDN；编码器可以自研，但接收端还需要摄像头实时解码器，仓库同样没有，且无相机环境无法验证正确性。真实档案通常 20KB 以上，会拆成十几张密排二维码，扫描与失败重试体验不可接受。',
      },
    ],
    fallback: '导出 .json 文件 → 用微信 / 隔空投送 / 数据线传到新设备 → 在新设备打开本页导入。',
  };

  let adapter = null;
  let ledgerOverride = null;
  let recurOverride = null;

  function configure(opts) {
    opts = opts || {};
    if ('storage' in opts) adapter = opts.storage;
    if ('ledger' in opts) ledgerOverride = opts.ledger;
    if ('recur' in opts) recurOverride = opts.recur;
    return { storage: adapter };
  }

  function storage() {
    if (adapter) return adapter;
    if (!root) return null;
    try { return root.localStorage; } catch (e) { return null; }
  }
  function ledgerApi() {
    if (ledgerOverride) return ledgerOverride;
    try { if (root && root.Ledger) return root.Ledger; } catch (e) { /* 继续 */ }
    try { if (typeof require === 'function') return require('../ledger.js'); } catch (e) { /* 继续 */ }
    return null;
  }
  function recurApi() {
    if (recurOverride) return recurOverride;
    try { return root && root.PanjiRecur ? root.PanjiRecur : null; } catch (e) { return null; }
  }

  // ---------- 基础读写 ----------
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
  function removeKey(key) {
    const s = storage();
    if (!s) return false;
    try { s.removeItem(key); return true; } catch (e) { return false; }
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function pad3(n) { return String(n).padStart(3, '0'); }
  function caseKey(n) { return CASE_PREFIX + pad3(n); }

  // ---------- UTF-8 / SHA-256（自研，浏览器与 Node 同一套；不依赖 WebCrypto） ----------
  function utf8Bytes(str) {
    const s = String(str);
    if (typeof TextEncoder !== 'undefined') {
      try { return new TextEncoder().encode(s); } catch (e) { /* 落到手写 */ }
    }
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(++i);
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(out);
  }

  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  function sha256Hex(input) {
    const bytes = typeof input === 'string' ? utf8Bytes(input) : (input instanceof Uint8Array ? input : new Uint8Array(input));
    const len = bytes.length;
    const blocks = Math.ceil((len + 9) / 64);
    const padded = new Uint8Array(blocks * 64);
    padded.set(bytes);
    padded[len] = 0x80;
    const bits = len * 8;
    for (let i = 0; i < 8; i++) {
      padded[padded.length - 1 - i] = Math.floor(bits / Math.pow(2, 8 * i)) & 0xff;
    }
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    for (let b = 0; b < blocks; b++) {
      const o = b * 64;
      for (let i = 0; i < 16; i++) {
        w[i] = ((padded[o + i * 4] << 24) | (padded[o + i * 4 + 1] << 16)
          | (padded[o + i * 4 + 2] << 8) | padded[o + i * 4 + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ ((~e) & g)) >>> 0;
        const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
        const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & bb) ^ (a & c) ^ (bb & c)) >>> 0;
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map((x) => {
      let s = '';
      for (let i = 7; i >= 0; i--) s += ((x >>> (i * 4)) & 0xf).toString(16);
      return s;
    }).join('');
  }

  // 规范化 JSON：对象键排序、数组保持顺序；同一数据无论键序都得到同一串
  function canonicalStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
  }
  function computeSha(data) { return sha256Hex(canonicalStringify(data)); }
  function byteLen(text) { return utf8Bytes(text).length; }
  function sameJson(a, b) { return canonicalStringify(a) === canonicalStringify(b); }

  // ---------- 旧 schema 归一 ----------
  // 只补「缺字段的默认值」，不改已有值：account 补 default、账本补 imports/dupLog、
  // tk6 映射键补第 7 段、案例 trades/verdict.lines 补 account。
  function normalizeTk6Key(k) {
    const s = String(k == null ? '' : k);
    const parts = s.split('|');
    if (parts.length !== 7) return s;
    if (String(parts[6] || '') !== '') return s;
    parts[6] = 'default';
    return parts.join('|');
  }

  function normalizeArchive(src) {
    const data = clone(src);
    const filled = [];
    const warnings = [];

    if (data[LEDGER_KEY] !== undefined) {
      const ledger = data[LEDGER_KEY];
      if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.trades)) {
        return { ok: false, error: 'ledger_invalid', filled: [], warnings: [] };
      }
      if (!Array.isArray(ledger.imports)) { ledger.imports = []; filled.push(LEDGER_KEY + '.imports'); }
      if (!Array.isArray(ledger.dupLog)) { ledger.dupLog = []; filled.push(LEDGER_KEY + '.dupLog'); }
      let acc = 0;
      ledger.trades.forEach((t) => {
        if (t && typeof t === 'object' && !String(t.account || '')) { t.account = 'default'; acc++; }
      });
      if (acc) filled.push(LEDGER_KEY + ':account×' + acc);
    }

    Object.keys(data).forEach((k) => {
      if (!CASE_RE.test(k)) return;
      const c = data[k];
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        warnings.push(k + ' 不是有效档案，已跳过');
        delete data[k];
        return;
      }
      let acc = 0;
      if (Array.isArray(c.trades)) {
        c.trades.forEach((t) => {
          if (t && typeof t === 'object' && !String(t.account || '')) { t.account = 'default'; acc++; }
        });
      }
      if (c.verdict && Array.isArray(c.verdict.lines)) {
        c.verdict.lines.forEach((l) => {
          if (l && typeof l === 'object' && !String(l.account || '')) { l.account = 'default'; acc++; }
        });
      }
      if (acc) filled.push(k + ':account×' + acc);
    });

    TK6_MAP_KEYS.forEach((k) => {
      const m = data[k];
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      let n = 0;
      const next = {};
      Object.keys(m).forEach((key) => {
        const nk = normalizeTk6Key(key);
        if (nk !== key) n++;
        next[nk] = m[key];
      });
      if (n) { data[k] = next; filled.push(k + ':tk6×' + n); }
    });

    if (filled.length) {
      warnings.push('旧版数据缺少字段，已按默认值补齐：' + filled.slice(0, 6).join('，')
        + (filled.length > 6 ? ' 等 ' + filled.length + ' 处' : ''));
    }
    return { ok: true, data, filled, warnings };
  }

  function validateLedger(ledger) {
    if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.trades)) {
      return { ok: false, error: 'ledger_invalid' };
    }
    const bad = [];
    ledger.trades.forEach((t, i) => {
      if (!t || typeof t !== 'object') { bad.push(i); return; }
      if (!String(t.date || '').replace(/[^\d]/g, '')) { bad.push(i); return; }
      if (!String(t.side || '').trim()) { bad.push(i); return; }
      if (!(+t.price > 0) || !(+t.qty > 0)) bad.push(i);
    });
    if (bad.length) return { ok: false, error: 'trade_invalid', indexes: bad.slice(0, 5), total: bad.length };
    return { ok: true };
  }

  // ---------- 导出 ----------
  function countsOf(data) {
    const ledger = data && data[LEDGER_KEY];
    const trades = ledger && Array.isArray(ledger.trades) ? ledger.trades.length : 0;
    const cases = Object.keys(data || {}).filter((k) => CASE_RE.test(k)).length;
    return { keys: Object.keys(data || {}).length, trades, cases };
  }

  function demoCheck(verdict, ref, st) {
    const r = recurApi();
    if (!r || typeof r.isDemoCase !== 'function') return false;
    try { return !!r.isDemoCase(verdict, ref, st); } catch (e) { return false; }
  }
  function caseRefOf(n) {
    const r = recurApi();
    if (r && typeof r.caseRef === 'function') {
      try { return r.caseRef('case_' + pad3(n)); } catch (e) { /* 用原值 */ }
    }
    return 'case_' + pad3(n);
  }

  function collectArchive() {
    const data = {};
    const invalidKeys = [];
    const demoCases = [];
    ARCHIVE_KEYS.forEach((k) => {
      const raw = getRaw(k);
      if (raw == null) return;
      const v = parseRaw(raw);
      if (v === undefined) { invalidKeys.push(k); return; }
      data[k] = v;
    });

    const seqRaw = getRaw(CASE_SEQ);
    const seq = seqRaw == null ? 0 : Math.max(0, +(parseRaw(seqRaw) || 0));
    if (seq) data[CASE_SEQ] = seq;

    const recurState = data[RECUR_KEY] || null;
    for (let i = 1; i <= seq; i++) {
      const key = caseKey(i);
      const raw = getRaw(key);
      if (raw == null) continue;
      const c = parseRaw(raw);
      if (c === undefined) { invalidKeys.push(key); continue; }
      const ref = caseRefOf(i);
      if (demoCheck(c && c.verdict, ref, recurState)) { demoCases.push(ref); continue; }
      data[key] = c;
    }
    return { data, seq, demoCases, invalidKeys, counts: countsOf(data) };
  }

  function stamp(d) {
    const x = d instanceof Date ? d : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}-${p(x.getHours())}${p(x.getMinutes())}${p(x.getSeconds())}`;
  }
  function filename(ext, d) { return `panji-migrate-${stamp(d)}.${ext}`; }

  function buildExport(opts) {
    opts = opts || {};
    try {
      const { data, seq, demoCases, invalidKeys, counts } = collectArchive();
      const at = opts.now instanceof Date ? opts.now : new Date();
      const sha256 = computeSha(data);
      const envelope = {
        app: APP,
        kind: KIND,
        schema: SCHEMA,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: at.toISOString(),
        counts,
        sha256,
        data,
      };
      const json = JSON.stringify(envelope);
      const bytes = byteLen(json);
      if (bytes > LIMIT_BYTES) {
        return { ok: false, error: 'too_large', bytes, limit: LIMIT_BYTES, limitLabel: LIMIT_LABEL, counts };
      }
      const warnings = [];
      if (invalidKeys.length) warnings.push('有 ' + invalidKeys.length + ' 个 key 内容损坏，已跳过：' + invalidKeys.slice(0, 3).join('，'));
      if (demoCases.length) warnings.push('已跳过 ' + demoCases.length + ' 个示例案例（示例不进真实迁移包）');
      return {
        ok: true, json, filename: filename('json', at), counts, sha256, bytes,
        exportedAt: envelope.exportedAt, demoCases, invalidKeys, warnings, seq,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------- 校验 ----------
  function isAllowedKey(k) { return ARCHIVE_KEYS.indexOf(k) >= 0 || CASE_RE.test(k) || k === CASE_SEQ; }

  function verifyExport(input) {
    let env;
    try { env = typeof input === 'string' ? JSON.parse(input) : input; } catch (e) { return { ok: false, error: 'json_invalid' }; }
    if (!env || typeof env !== 'object' || Array.isArray(env)) return { ok: false, error: 'envelope_invalid' };

    // 兼容 E-22 未加密备份（kind=panji-backup）：旧包没有 sha / schema，按旧 schema 读取
    if (env.kind === 'panji-backup') {
      if (env.encrypted) return { ok: false, error: 'encrypted_unsupported' };
      if (!env.data || typeof env.data !== 'object' || Array.isArray(env.data)) return { ok: false, error: 'data_invalid' };
      return finishVerify({
        raw: env.data, exportedAt: env.exportedAt || '', legacy: true, legacyLabel: 'E-22 旧备份（无校验值）',
        declaredCounts: env.counts || null, sha256: '',
      });
    }
    if (env.kind !== KIND) return { ok: false, error: 'kind_invalid' };
    if (env.app !== APP) return { ok: false, error: 'app_invalid' };
    if (!env.data || typeof env.data !== 'object' || Array.isArray(env.data)) return { ok: false, error: 'data_invalid' };

    const legacy = !env.schema || +env.schemaVersion < SCHEMA_VERSION;
    if (env.schema && env.schema !== SCHEMA) return { ok: false, error: 'schema_unsupported', schema: String(env.schema) };

    // 白名单先于 sha：结构异常优先报「未知 key」，避免被校验错误掩盖
    const badKeys = Object.keys(env.data).filter((k) => !isAllowedKey(k));
    if (badKeys.length) return { ok: false, error: 'key_not_allowed', keys: badKeys.slice(0, 5) };

    // 先按原始 data 校验 sha，再做旧 schema 归一（归一不能改变校验结论）
    let sha = '';
    if (typeof env.sha256 === 'string' && env.sha256) {
      sha = computeSha(env.data);
      if (sha !== env.sha256.toLowerCase()) {
        return {
          ok: false, error: 'sha_mismatch',
          expected: env.sha256.toLowerCase().slice(0, 16), actual: sha.slice(0, 16),
        };
      }
    }
    return finishVerify({
      raw: env.data, exportedAt: env.exportedAt || '', legacy,
      legacyLabel: legacy ? '旧版格式（缺 schema 或版本较低）' : '',
      declaredCounts: env.counts || null, sha256: sha,
    });
  }

  function finishVerify(info) {
    const badKeys = Object.keys(info.raw).filter((k) => !isAllowedKey(k));
    if (badKeys.length) return { ok: false, error: 'key_not_allowed', keys: badKeys.slice(0, 5) };
    const norm = normalizeArchive(info.raw);
    if (!norm.ok) return norm;
    if (norm.data[LEDGER_KEY] !== undefined) {
      const check = validateLedger(norm.data[LEDGER_KEY]);
      if (!check.ok) return check;
    }
    const warnings = norm.warnings.slice();
    if (info.legacy && !info.sha256) warnings.push(info.legacyLabel + '，未带 sha 校验值，已按默认值补齐后读取');
    if (info.declaredCounts) {
      const actual = countsOf(norm.data);
      const dc = info.declaredCounts;
      if (+dc.keys !== actual.keys || +dc.trades !== actual.trades || +dc.cases !== actual.cases) {
        warnings.push('包内声明的条目数与实际不一致（声明 ' + (+dc.keys || 0) + '/' + (+dc.trades || 0) + '/' + (+dc.cases || 0)
          + '，实际 ' + actual.keys + '/' + actual.trades + '/' + actual.cases + '），以 sha 校验与实际内容为准');
      }
    }
    return {
      ok: true, data: norm.data, counts: countsOf(norm.data), exportedAt: info.exportedAt,
      legacy: !!info.legacy, warnings, sha256: info.sha256, filled: norm.filled,
    };
  }

  // ---------- 导入计划（预览与落盘共用，保证预览=实际） ----------
  function tradeKeyOf(t) {
    const L = ledgerApi();
    if (L && typeof L.tradeKey === 'function') {
      try { return L.tradeKey(t); } catch (e) { /* 落到自带实现 */ }
    }
    const date = String(t && t.date || '').replace(/[^\d]/g, '');
    const time = String(t && t.time || '').replace(/[^\d]/g, '').padEnd(6, '0').slice(0, 6);
    const id = String((t && (t.code || t.name)) || '');
    const price = +((t && t.price) || 0);
    return [date, time, id, String((t && t.side) || ''), price.toFixed(3), Math.round(+((t && t.qty) || 0)), String((t && t.account) || '')].join('|');
  }

  function localSeq() {
    return Math.max(0, +(getJson(CASE_SEQ, 0) || 0));
  }

  function storageUsage(extraWrites) {
    const writes = extraWrites || {};
    const s = storage();
    let total = 0;
    if (!s) return { bytes: 0, known: false };
    try {
      if (typeof s.length === 'number' && typeof s.key === 'function') {
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k == null) continue;
          if (Object.prototype.hasOwnProperty.call(writes, k)) continue;
          total += byteLen(s.getItem(k) || '');
        }
        Object.keys(writes).forEach((k) => { total += byteLen(JSON.stringify(writes[k])); });
        return { bytes: total, known: true };
      }
    } catch (e) { /* 落到按已知 key 估算 */ }
    ARCHIVE_KEYS.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(writes, k)) return;
      total += byteLen(getRaw(k) || '');
    });
    total += byteLen(getRaw(CASE_SEQ) || '');
    const seq = localSeq();
    for (let i = 1; i <= seq; i++) total += byteLen(getRaw(caseKey(i)) || '');
    Object.keys(writes).forEach((k) => { total += byteLen(JSON.stringify(writes[k])); });
    return { bytes: total, known: true };
  }

  function planImport(incoming, opts) {
    opts = opts || {};
    const strategy = opts.strategy === 'overwrite' ? 'overwrite' : 'merge';
    const data = incoming && typeof incoming === 'object' ? incoming : null;
    if (!data) return { ok: false, error: 'data_invalid' };
    if (!storage()) return { ok: false, error: 'no_storage' };

    const writes = {};
    const conflicts = [];
    const warnings = [];
    const summary = {
      strategy,
      counts: countsOf(data),
      ledger: { added: 0, dup: 0, replaced: 0 },
      cases: { added: 0, skipped: 0, appended: 0, overwritten: 0 },
      singles: { added: 0, keptLocal: 0, overwritten: 0 },
      duplicateOnly: false,
    };

    // ---- 账本 ----
    let nextSeq = localSeq();
    if (data[LEDGER_KEY] !== undefined) {
      const inc = data[LEDGER_KEY];
      const cur = getJson(LEDGER_KEY, null);
      const incTrades = Array.isArray(inc.trades) ? inc.trades : [];
      if (strategy === 'overwrite' || !cur || !Array.isArray(cur.trades) || !cur.trades.length) {
        writes[LEDGER_KEY] = clone(inc);
        summary.ledger.added = incTrades.length;
        summary.ledger.replaced = cur && Array.isArray(cur.trades) ? cur.trades.length : 0;
      } else {
        const out = clone(cur);
        out.trades = Array.isArray(out.trades) ? out.trades : [];
        const seen = Object.create(null);
        out.trades.forEach((t) => { try { seen[tradeKeyOf(t)] = 1; } catch (e) { /* 脏数据不建索引 */ } });
        incTrades.forEach((t) => {
          const k = tradeKeyOf(t);
          if (seen[k]) { summary.ledger.dup++; return; }
          seen[k] = 1;
          out.trades.push(clone(t));
          summary.ledger.added++;
        });
        // 合并时保留本机导入历史，并把对方历史追加（按 id|at 去重）
        const imports = Array.isArray(out.imports) ? out.imports.slice() : [];
        const seenImp = Object.create(null);
        imports.forEach((x) => { seenImp[String(x && x.id) + '|' + String(x && x.at)] = 1; });
        (Array.isArray(inc.imports) ? inc.imports : []).forEach((x) => {
          const k = String(x && x.id) + '|' + String(x && x.at);
          if (!seenImp[k]) { seenImp[k] = 1; imports.push(clone(x)); }
        });
        out.imports = imports.slice(-200);
        const seenDup = Object.create(null);
        const dupLog = [];
        (Array.isArray(out.dupLog) ? out.dupLog : []).concat(Array.isArray(inc.dupLog) ? inc.dupLog : []).forEach((x) => {
          const k = String(x && x.date) + '|' + String(x && x.key) + '|' + String(x && x.at);
          if (seenDup[k]) return;
          seenDup[k] = 1;
          dupLog.push(clone(x));
        });
        out.dupLog = dupLog.slice(-500);
        // 内容完全没变就不写：重复导入应保持「无变化」，不制造假的写入
        if (!sameJson(out, cur)) writes[LEDGER_KEY] = out;
      }
    }

    // ---- 案例 ----
    const caseNos = Object.keys(data).filter((k) => CASE_RE.test(k))
      .sort((a, b) => (+a.replace(/\D/g, '')) - (+b.replace(/\D/g, '')));
    const incSeq = Math.max(0, +(data[CASE_SEQ] || 0));
    nextSeq = Math.max(nextSeq, incSeq);
    caseNos.forEach((k) => {
      const cur = getJson(k, null);
      if (cur !== null) {
        if (sameJson(cur, data[k])) { summary.cases.skipped++; return; }
        if (strategy === 'overwrite') {
          writes[k] = clone(data[k]);
          summary.cases.overwritten++;
          conflicts.push({ key: k, action: 'overwritten', reason: '同编号内容不同，按选择覆盖' });
          return;
        }
        // merge：同编号内容不同 → 追加为新档案，保留本机原件
        let target = null;
        do {
          nextSeq++;
          target = caseKey(nextSeq);
        } while (getRaw(target) != null);
        writes[target] = clone(data[k]);
        summary.cases.appended++;
        conflicts.push({ key: k, to: target, action: 'appended', reason: '同编号内容不同，已追加为新档案' });
        return;
      }
      writes[k] = clone(data[k]);
      summary.cases.added++;
    });

    // ---- 单例 key ----
    ARCHIVE_KEYS.forEach((k) => {
      if (k === LEDGER_KEY || data[k] === undefined) return;
      const cur = getJson(k, null);
      if (cur !== null) {
        if (sameJson(cur, data[k])) return;
        if (strategy === 'overwrite') {
          writes[k] = clone(data[k]);
          summary.singles.overwritten++;
          conflicts.push({ key: k, action: 'overwritten', reason: '本机已有不同内容，按选择覆盖' });
        } else {
          summary.singles.keptLocal++;
          conflicts.push({ key: k, action: 'kept_local', reason: '本机已有不同内容，保留本机' });
        }
        return;
      }
      writes[k] = clone(data[k]);
      summary.singles.added++;
    });

    // ---- 案例编号只升不降 ----
    const seqNow = localSeq();
    const finalSeq = Math.max(seqNow, nextSeq, incSeq);
    if (finalSeq > 0 && finalSeq !== seqNow) { writes[CASE_SEQ] = finalSeq; nextSeq = finalSeq; }

    // ---- 体积闸门（导入前就拒绝，不做静默失败） ----
    const usage = storageUsage(writes);
    if (usage.bytes > LIMIT_BYTES) {
      return {
        ok: false, error: 'quota_exceeded', bytes: usage.bytes, limit: LIMIT_BYTES, limitLabel: LIMIT_LABEL,
        summary, conflicts, warnings,
      };
    }

    summary.duplicateOnly = Object.keys(writes).length === 0;
    if (summary.ledger.dup) warnings.push('账本有 ' + summary.ledger.dup + ' 笔已存在（按 tradeKey 去重）');
    if (summary.cases.skipped) warnings.push('有 ' + summary.cases.skipped + ' 个档案与本机完全相同，已跳过');

    return {
      ok: true, writes, summary, conflicts, warnings, nextSeq,
      bytes: usage.bytes, limit: LIMIT_BYTES, limitLabel: LIMIT_LABEL,
    };
  }

  function rollback(snapshot) {
    snapshot.forEach((x) => {
      try {
        if (x.raw == null) removeKey(x.key);
        else storage().setItem(x.key, x.raw);
      } catch (e) { /* 回滚尽力而为 */ }
    });
  }

  function applyImport(incoming, opts) {
    try {
      const plan = planImport(incoming, opts);
      if (!plan.ok) return plan;
      const s = storage();
      if (!s) return { ok: false, error: 'no_storage' };
      const keys = Object.keys(plan.writes);
      if (!keys.length) {
        return { ok: true, ...plan, written: 0, rebuilt: false, noChange: true };
      }
      const snapshot = keys.map((k) => ({ key: k, raw: getRaw(k) }));
      for (let i = 0; i < keys.length; i++) {
        if (!setJson(keys[i], plan.writes[keys[i]])) {
          rollback(snapshot);
          return { ok: false, error: 'write_failed', rolledBack: true, written: i };
        }
      }
      // 只还原了案例、没还原复发索引 → 重建一次（索引本身随包导入时不重算，保证逐字段一致）
      let rebuilt = false;
      const recurRestored = keys.indexOf(RECUR_KEY) >= 0;
      const r = recurApi();
      if (!recurRestored && plan.summary.cases.added + plan.summary.cases.appended > 0
        && r && typeof r.rebuild === 'function') {
        try { r.rebuild(); rebuilt = true; } catch (e) { /* 重建失败不阻塞导入 */ }
      }
      return { ok: true, ...plan, written: keys.length, rebuilt, noChange: false };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function errorText(code, extra) {
    const map = {
      json_invalid: '文件不是合法 JSON',
      envelope_invalid: '文件结构不正确',
      app_invalid: '不是本产品的迁移文件',
      kind_invalid: '不是档案迁移文件（请使用本页导出的 .json）',
      schema_unsupported: '迁移文件 schema 版本不支持',
      data_invalid: '文件里没有可读的档案数据',
      key_not_allowed: '文件里有未知 key，已拒绝导入',
      sha_mismatch: '文件校验不通过：内容可能被修改或损坏（sha 不一致）',
      ledger_invalid: '账本结构无效：缺少 trades 数组',
      trade_invalid: '账本里有无效成交（日期 / 方向 / 价格 / 数量）',
      too_large: '档案超过 ' + LIMIT_LABEL + '，已拒绝导出（本机 localStorage 通常只有约 5MB，继续写入会失败）。请先导出逐笔 CSV 拆分档案后再迁移。',
      quota_exceeded: '导入后本机存储将超过 ' + LIMIT_LABEL + '，已拒绝写入。请先清理本机档案或拆分文件。',
      no_storage: '当前浏览器不允许本机存储，无法迁移',
      write_failed: '本机存储写入失败，已回滚到导入前状态',
      encrypted_unsupported: '这是加密备份，本页不处理；请到「我的纪律规则」页用备份面板导入',
    };
    let text = map[code] || String(code || '未知错误');
    if (code === 'key_not_allowed' && extra && extra.length) text += '（' + extra.join('，') + '）';
    if (code === 'trade_invalid' && extra && extra.length) text += '（第 ' + extra.map((i) => i + 1).join('、') + ' 笔）';
    return text;
  }

  return {
    APP, KIND, SCHEMA, SCHEMA_VERSION, LIMIT_BYTES, LIMIT_LABEL,
    ARCHIVE_KEYS, EXCLUDED, QR_EVAL, CASE_PREFIX, CASE_SEQ, LEDGER_KEY,
    configure,
    sha256Hex, canonicalStringify, computeSha, utf8Bytes, byteLen,
    normalizeArchive, normalizeTk6Key, validateLedger, countsOf,
    collectArchive, buildExport, verifyExport,
    planImport, applyImport, tradeKeyOf, storageUsage,
    errorText,
    _state: () => ({ adapter: !!adapter, ledgerOverride: !!ledgerOverride }),
  };
});
