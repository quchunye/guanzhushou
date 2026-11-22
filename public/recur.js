// recur.js —— 复发索引（批次 0 地基）
//
// 口径（以 docs/30功能_分批施工_20261031.md §2.3 为准）：
//   - 只统计 verdict.lines 里 flag=违规 的逐笔，以及 verdict.day_checks 的日级触发；
//   - 按「成交日」计数，不按上传日；同一天同一规则多笔只算 1 天；
//   - suspects 不计；重判不重复计数（tk6 去重）；
//   - tk6 = date8|time6|code||name|side|price3|qty|account。
//
// 存储：guanzhu_recur_v1 = {v:1,rules:{T04:{days:{20261024:{cases:[],keys:[]}},first,last}},updatedAt}
// 兼容：浏览器挂 window.PanjiRecur；Node 测试走 module.exports。
// 注意：factory 必须接收 root。批次 0 原版漏传，浏览器里 root.localStorage 抛 ReferenceError
// 被 try/catch 吞掉，导致索引永远写不进 localStorage；Node 测试走 adapter 因此没暴露。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.PanjiRecur = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {

  // FX-3：键统一取自 PanjiStore.KEYS（store.js 已登记 19 条，业务里不再裸写字符串）；
  // Node 无 root 时 require 同一份 store.js；两者都不可用（如 vm 沙箱）才回落到 fallback，
  // fallback 与 KEYS 同值，且每个 key 只在一个地方定义。
  const Store = (function () {
    try { if (root && root.PanjiStore) return root.PanjiStore; } catch (e) { /* 继续 */ }
    try { if (typeof require === 'function') return require('./store.js'); } catch (e) { /* 继续 */ }
    return null;
  })();
  function keyOf(name, fallback) { return (Store && Store.KEYS && Store.KEYS[name]) || fallback; }

  const KEY = keyOf('recur', 'guanzhu_recur_v1');
  const CASE_SEQ = keyOf('caseSeq', 'guanzhu_case_seq');
  const CASE_PREFIX = keyOf('casePrefix', 'guanzhu_case_');
  const VERSION = 1;

  // 示例体验的 9 笔成交键（/api/demo 固定样例，2026-10-19）。
  // 用途：识别 A 批之前已经落进 guanzhu_case_* 的历史示例案例；之后的示例由 markDemo 打标记。
  const DEMO_TK6 = [
    '20261019|101450|示例环保|卖|12.680|100|',
    '20261019|101306|示例建设|买|3.540|100|',
    '20261019|101302|示例建设|买|3.540|300|',
    '20261019|100851|示例环保|卖|12.620|100|',
    '20261019|100802|示例建设|买|3.530|700|',
    '20261019|100510|示例建设|买|3.530|700|',
    '20261019|093139|示例基建|买|3.610|400|',
    '20261019|093101|示例材料|卖|11.900|100|',
    '20261019|093021|示例建设|买|3.700|4100|',
  ];
  const DEMO_SIG = DEMO_TK6.slice().sort().join(';');

  let adapter = null;
  let exemptFn = null;

  function storage() {
    if (adapter) return adapter;
    if (!root) return null;
    try { return root.localStorage; } catch (e) { return null; }
  }

  function getRaw(key) {
    const s = storage();
    if (!s) return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }

  function setRaw(key, value) {
    const s = storage();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function getJson(key, fallback) {
    const raw = getRaw(key);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function caseKey(n) {
    return CASE_PREFIX + String(n).padStart(3, '0');
  }

  // ---------- 归一化 ----------
  function date8(v) {
    const d = String(v || '').replace(/[^\d]/g, '');
    if (d.length === 8) return d;
    if (d.length === 6) return '20' + d;
    if (d.length === 10) return d.replace(/-/g, '');
    return '';
  }

  function time6(v) {
    let d = String(v || '').replace(/[^\d]/g, '');
    if (!d) return '';
    if (d.length === 1) d = '0' + d + '0000';
    else if (d.length === 2) d = d + '0000';
    else if (d.length === 3) d = '0' + d + '00';
    else if (d.length === 4) d = d + '00';
    else if (d.length === 5) d = d + '0';
    return d.slice(0, 6);
  }

  function price3(v) {
    const n = +v;
    return isFinite(n) && n > 0 ? n.toFixed(3) : '';
  }

  function tk6(t) {
    t = t || {};
    const id = String(t.code || t.name || '').trim();
    return [
      date8(t.date),
      time6(t.time),
      id,
      String(t.side || '').trim(),
      price3(t.price),
      String(t.qty == null ? '' : t.qty),
      String(t.account || ''),
    ].join('|');
  }

  function ruleIds(raw) {
    return String(raw || '').split('+')
      .map(s => s.trim())
      .filter(s => /^T\d{2}$/.test(s));
  }

  // 案例引用归一：'guanzhu_case_001' / 'case_001' / '冲动案例档案 No.001' → 'case_001'
  // 目的：afterConfirm 的展示名与 backfill 的存储键在索引里是同一个案例，不重复计数。
  function caseRef(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    let m = s.match(/case[_-]?(\d{1,})/i);
    if (m) return 'case_' + m[1].padStart(3, '0');
    m = s.match(/No\.?\s*(\d{1,})/i);
    if (m) return 'case_' + m[1].padStart(3, '0');
    return s;
  }

  // 示例案例判据（两层）：
  // 1) 本机标记：afterConfirm 收到 isDemo 时调 markDemo，之后 backfill 不再把它当真实复发；
  // 2) 内容签名：A 批之前已落盘的示例案例没有标记，用 /api/demo 的 9 笔成交键精确匹配。
  function demoSignature(verdict) {
    if (!verdict || !Array.isArray(verdict.lines) || verdict.lines.length !== DEMO_TK6.length) return '';
    return verdict.lines.map(tk6).sort().join(';');
  }

  function isDemoVerdict(verdict) {
    return demoSignature(verdict) === DEMO_SIG;
  }

  function isDemoCase(verdict, ref, st) {
    const state = st || load();
    if (ref && state && state.demoCases && state.demoCases[ref]) return true;
    return isDemoVerdict(verdict);
  }

  // 给刚写入的示例案例打标记；verdict 只用于解析案例编号，不写进索引
  function markDemo(caseNo, verdict) {
    const st = load();
    const ref = caseRef(caseNo || (verdict && verdict.case_no) || '');
    if (!ref) return false;
    if (!st.demoCases || typeof st.demoCases !== 'object') st.demoCases = {};
    st.demoCases[ref] = 1;
    return save(st);
  }

  function today8() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  function addDays(date, n) {
    const y = +date.slice(0, 4), m = +date.slice(4, 6), d = +date.slice(6, 8);
    const t = Date.UTC(y, m - 1, d) + n * 86400000;
    const x = new Date(t);
    return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, '0')}${String(x.getUTCDate()).padStart(2, '0')}`;
  }

  function daysBetween(a, b) {
    const pa = Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8));
    const pb = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
    return Math.round((pb - pa) / 86400000);
  }

  // ---------- 状态 ----------
  function emptyState() {
    return { v: VERSION, rules: {}, updatedAt: '' };
  }

  function load() {
    const st = getJson(KEY, null);
    if (!st || st.v !== VERSION || !st.rules || typeof st.rules !== 'object') return emptyState();
    return st;
  }

  function save(st) {
    st.v = VERSION;
    st.updatedAt = new Date().toISOString();
    return setRaw(KEY, st);
  }

  function ensureRule(st, ruleId) {
    if (!st.rules[ruleId]) st.rules[ruleId] = { days: {}, first: '', last: '' };
    if (!st.rules[ruleId].days) st.rules[ruleId].days = {};
    return st.rules[ruleId];
  }

  function addOcc(st, ruleId, date, tk, caseNo) {
    if (!date) return;
    const r = ensureRule(st, ruleId);
    if (!r.days[date]) r.days[date] = { cases: [], keys: [] };
    const day = r.days[date];
    if (caseNo && day.cases.indexOf(caseNo) < 0) day.cases.push(caseNo);
    if (tk && day.keys.indexOf(tk) < 0) day.keys.push(tk);
    if (!r.first || date < r.first) r.first = date;
    if (!r.last || date > r.last) r.last = date;
  }

  // 内部：不发 save，供 backfill 批量用
  function ingestInto(st, verdict, caseNo) {
    if (!verdict || !Array.isArray(verdict.lines)) return st;
    const no = caseRef(caseNo || verdict.case_no || '');
    if (isDemoCase(verdict, no, st)) return st;  // 示例案例不进复发索引

    verdict.lines.forEach((line) => {
      if (!line || line.flag !== '违规') return;  // 只记违规；suspects 与合规不记
      const ids = ruleIds(line.rule);
      if (!ids.length) return;
      const k = tk6(line);
      ids.forEach((id) => {
        if (exemptFn && exemptFn(k, id)) return;  // 申诉例外：不计
        addOcc(st, id, date8(line.date), k, no);
      });
    });

    (verdict.day_checks || []).forEach((d) => {
      if (!d) return;
      const ids = ruleIds(d.rule);
      const date = date8(d.date);
      if (!ids.length || !date) return;
      ids.forEach((id) => addOcc(st, id, date, '', no));
    });

    return st;
  }

  // ---------- 公开 API ----------
  function ingest(verdict, caseNo) {
    const st = load();
    ingestInto(st, verdict, caseNo);
    save(st);
    return st;
  }

  // 从 guanzhu_case_001..seq 升序回填；最多 500 个案例
  // 示例案例（本机标记或固定样例签名）一律跳过，避免示例体验污染真实复发。
  function backfill(max) {
    const limit = max == null ? 500 : +max;
    const seq = +(getJson(CASE_SEQ, 0) || 0);
    const prev = load();
    const st = emptyState();
    if (prev.demoCases && Object.keys(prev.demoCases).length) {
      st.demoCases = Object.assign({}, prev.demoCases);
    }
    const from = seq > limit ? seq - limit + 1 : 1;
    let read = 0;
    let skipped = 0;
    for (let i = from; i <= seq; i++) {
      const c = getJson(caseKey(i), null);
      if (!c || !c.verdict) continue;
      const ref = caseRef(caseKey(i));
      if (isDemoCase(c.verdict, ref, st)) { skipped++; continue; }
      ingestInto(st, c.verdict, ref);
      read++;
    }
    save(st);
    return { cases: read, from: from, to: seq, skipped: skipped };
  }

  function rebuild() {
    return backfill();
  }

  // 逐笔复核过的成交键（tk6）：案例 verdict.lines 里出现过的每一笔。
  // 按月算复盘覆盖率时用这个，而不是只看理由标签 / 止损价。
  function verdictTradeKeys(max) {
    const limit = max == null ? 500 : +max;
    const seq = +(getJson(CASE_SEQ, 0) || 0);
    const out = {};
    const from = seq > limit ? seq - limit + 1 : 1;
    for (let i = from; i <= seq; i++) {
      const c = getJson(caseKey(i), null);
      const v = c && c.verdict;
      if (!v || !Array.isArray(v.lines)) continue;
      v.lines.forEach(function (line) {
        if (!line || !line.date) return;
        const k = tk6(line);
        if (k) out[k] = 1;
      });
    }
    return out;
  }

  function count(ruleId, windowDays, endDate) {
    const st = load();
    const r = st.rules[ruleId];
    if (!r) return 0;
    const end = date8(endDate || today8());
    const start = addDays(end, -(Math.max(1, +windowDays || 7) - 1));
    return Object.keys(r.days).filter(d => d >= start && d <= end).length;
  }

  function top(windowDays, endDate) {
    const st = load();
    const end = date8(endDate || today8());
    const start = addDays(end, -(Math.max(1, +windowDays || 7) - 1));
    const out = [];
    Object.keys(st.rules).forEach((ruleId) => {
      const r = st.rules[ruleId];
      const dates = Object.keys(r.days).filter(d => d >= start && d <= end).sort();
      if (!dates.length) return;
      const cases = {};
      dates.forEach((d) => (r.days[d].cases || []).forEach(c => { cases[c] = 1; }));
      out.push({ ruleId: ruleId, count: dates.length, dates: dates, cases: Object.keys(cases).length });
    });
    out.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
    return out;
  }

  // 某规则在窗口内的触发明细：按成交日升序，带当日的成交键与案例引用
  function detail(ruleId, windowDays, endDate) {
    const st = load();
    const r = st.rules[ruleId];
    const end = date8(endDate || today8());
    const win = Math.max(1, +windowDays || 7);
    const start = addDays(end, -(win - 1));
    const days = [];
    if (r) {
      Object.keys(r.days).filter(d => d >= start && d <= end).sort().forEach((d) => {
        const day = r.days[d] || {};
        days.push({
          date: d,
          keys: (day.keys || []).slice(),
          cases: (day.cases || []).slice(),
        });
      });
    }
    return {
      ruleId: ruleId,
      window: win,
      start: start,
      end: end,
      days: days,
      count: days.length,
      first: r ? r.first : '',
      last: r ? r.last : '',
    };
  }

  function median(nums) {
    if (!nums || !nums.length) return null;
    const a = nums.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // 复发间隔：窗口内相邻触发日之间的天数差；n = 间隔段数
  function intervals(ruleId, windowDays, endDate) {
    const d = detail(ruleId, windowDays, endDate);
    const gaps = [];
    for (let i = 1; i < d.days.length; i++) {
      gaps.push(daysBetween(d.days[i - 1].date, d.days[i].date));
    }
    return { gaps: gaps, n: gaps.length, median: median(gaps) };
  }

  // 同日共振：同一天触发 ≥3 条规则的日子（事实统计，不单独成块由 UI 决定）
  function resonance(windowDays, endDate) {
    const st = load();
    const end = date8(endDate || today8());
    const start = addDays(end, -(Math.max(1, +windowDays || 7) - 1));
    const byDate = {};
    Object.keys(st.rules).forEach((ruleId) => {
      const days = st.rules[ruleId].days || {};
      Object.keys(days).forEach((d) => {
        if (d < start || d > end) return;
        if (!byDate[d]) byDate[d] = [];
        if (byDate[d].indexOf(ruleId) < 0) byDate[d].push(ruleId);
      });
    });
    return Object.keys(byDate)
      .filter(d => byDate[d].length >= 3)
      .sort()
      .map(d => ({ date: d, rules: byDate[d].sort() }));
  }

  function ruleStats(endDate) {
    const st = load();
    const end = date8(endDate || today8());
    const out = {};
    Object.keys(st.rules).forEach((ruleId) => {
      const r = st.rules[ruleId];
      const dates = Object.keys(r.days).sort();
      const last = dates.length ? dates[dates.length - 1] : '';
      out[ruleId] = {
        triggerDays: dates.length,
        last: last || null,
        sinceLast: last ? daysBetween(last, end) : null,
      };
    });
    return out;
  }

  function setExempt(fn) {
    exemptFn = typeof fn === 'function' ? fn : null;
  }

  function configure(opts) {
    adapter = opts && opts.storage ? opts.storage : null;
  }

  function reset() {
    save(emptyState());
  }

  function _state() {
    return load();
  }

  return {
    VERSION,
    KEY,
    tk6,
    date8,
    time6,
    ruleIds,
    caseRef,
    isDemoVerdict,
    isDemoCase,
    markDemo,
    ingest,
    backfill,
    rebuild,
    verdictTradeKeys,
    count,
    top,
    detail,
    intervals,
    resonance,
    ruleStats,
    setExempt,
    configure,
    reset,
    _state,
  };
});
