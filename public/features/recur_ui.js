// features/recur_ui.js —— 批次 A：纵向记忆 1–6（★1）
//
// 1 复发账本（首屏一行 + 明细 + 跳回案例）
// 2 连续合规天数（只显示当前连续与历史最好；断点只写「上次最好 N 天」）
// 3 首次破戒（近 30/90 天第 1 次触发，首屏一行）
// 4 同日共振（≥3 条规则同一天，只并入 1 的明细，不单独成块）
// 5 规则体检（设置页，90 天触发日数/最近触发日，按模板编号排）
// 6 复发间隔（1 的明细副标题，中位间隔 + n）
//
// 口径：按成交日、按触发日数；day_checks 一天一次；suspects 不计；重判按成交键去重。
// 约束：只读 guanzhu_recur_v1 与案例存档，不碰 app.js / index.html / server。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : root, null);
  } else {
    root.PanjiRecurUI = factory(root, root.PanjiRecur || null);
  }
})(typeof self !== 'undefined' ? self : this, function (root, Recur) {
  'use strict';

  const FLAG = 'recur';
  const REPORT_WINDOW = 7;
  const HEALTH_WINDOW = 90;
  const KEY_CASE_SEQ = 'guanzhu_case_seq';
  const KEY_CASE_PREFIX = 'guanzhu_case_';
  const KEY_RULES = 'guanzhu_rules_v1';
  const KEY_LEDGER = 'guanzhu_ledger';
  const KEY_OPENPLAN = 'guanzhu_openplan_v1';
  const KEY_MONTH = 'guanzhu_month_v1';
  const OP_MIN = 20;
  const OP_MAX = 200;
  const MONTH_MIN_TRADES = 3;
  const MONTH_MIN_COVER = 0.8;

  const D = {
    root: root,
    recur: Recur,
    storage: null,
    ext: null,
    flag: null,
    track: null,
    now: null,
    doc: null,
  };
  if (root && root.PanjiExt) D.ext = root.PanjiExt;
  if (root && root.PanjiFlag) D.flag = root.PanjiFlag;
  if (root && root.PanjiTrack) D.track = root.PanjiTrack;
  if (root && root.document) D.doc = root.document;

  let lastReport = null;
  let viewKey = '';
  let rcState = null;
  let booted = false;
  let caseCache = { seq: -1, map: null, cases: null };
  let complianceCache = { seq: -1, model: null };

  // ---------- 基础工具 ----------
  function pad3(n) { return String(n).padStart(3, '0'); }
  function num(v, def) { const n = +v; return isFinite(n) ? n : def; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]);
  }

  function storage() {
    if (D.storage) return D.storage;
    try { return D.root && D.root.localStorage; } catch (e) { return null; }
  }

  function getJson(key, fallback) {
    const s = storage();
    if (!s) return fallback;
    try {
      const raw = s.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function nowDate() {
    const d = D.now ? D.now() : new Date();
    return d instanceof Date ? d : new Date(d);
  }

  function today8() {
    const d = nowDate();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  function fmtMd(d8) {
    const s = String(d8 || '');
    return s.length === 8 ? s.slice(4, 6) + '-' + s.slice(6, 8) : s;
  }

  function fmtYmd(d8) {
    const s = String(d8 || '');
    return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
  }

  function fmtTime(t) {
    if (!D.recur) return String(t || '');
    const s = D.recur.time6(t);
    return s.length === 6 ? s.slice(0, 2) + ':' + s.slice(2, 4) : String(t || '');
  }

  function fmtNum(v) {
    const n = +v;
    if (!isFinite(n)) return String(v == null ? '' : v);
    return String(Math.round(n * 1000) / 1000);
  }

  function parseTk6(k) {
    const p = String(k || '').split('|');
    return {
      date: p[0] || '', time: p[1] || '', id: p[2] || '',
      side: p[3] || '', price: p[4] || '', qty: p[5] || '',
    };
  }

  function emit(event) {
    try {
      if (typeof D.track === 'function') return D.track(event);
      if (D.root && typeof D.root.PanjiTrack === 'function') return D.root.PanjiTrack(event);
    } catch (e) { /* 埋点失败不影响渲染 */ }
  }

  function enabled() {
    if (!D.recur) return false;
    if (typeof D.flag === 'function') {
      try { return !!D.flag(FLAG); } catch (e) { return false; }
    }
    return true;
  }

  // ---------- 规则与案例读取 ----------
  function caseSeq() {
    return Math.max(0, num(getJson(KEY_CASE_SEQ, 0), 0));
  }

  function caseKey(n) {
    return KEY_CASE_PREFIX + pad3(n);
  }

  function rulesConfig() {
    const c = getJson(KEY_RULES, null);
    return c && Array.isArray(c.rules) ? c : null;
  }

  function configuredIds() {
    const cfg = rulesConfig();
    if (!cfg) return [];
    return cfg.rules
      .map(r => (r && r.templateId) || '')
      .filter(id => /^T\d{2}$/.test(id));
  }

  function sortRuleIds(ids) {
    return ids.slice().sort((a, b) => {
      const d = num(String(a).slice(1), 99) - num(String(b).slice(1), 99);
      return d || String(a).localeCompare(String(b));
    });
  }

  function namesFrom(v) {
    const out = {};
    ((v && v.rules) || []).forEach((r) => {
      if (r && r.id) out[r.id] = r.name || '';
    });
    return out;
  }

  // 当前应检查的规则：有保存规则就只看勾选规则；没有就用当前报告 + 索引里出现过的
  function inspectIds(v) {
    const cfgIds = configuredIds();
    if (cfgIds.length) return sortRuleIds([...new Set(cfgIds)]);
    const seen = {};
    ((v && v.rules) || []).forEach((r) => {
      if (r && /^T\d{2}$/.test(r.id || '')) seen[r.id] = 1;
    });
    const st = D.recur && D.recur._state ? D.recur._state() : { rules: {} };
    Object.keys((st && st.rules) || {}).forEach((id) => { seen[id] = 1; });
    return sortRuleIds(Object.keys(seen));
  }

  function resetCache() {
    caseCache = { seq: -1, map: null, cases: null };
    complianceCache = { seq: -1, model: null };
  }

  // 单次扫描案例存档：成交键 → 最近一次判定（重判时后写的优先）
  function loadCases() {
    const seq = caseSeq();
    if (caseCache.seq === seq && caseCache.map) return caseCache;
    const cases = {};
    const map = {};
    const demoState = D.recur._state ? D.recur._state() : { rules: {} };
    for (let i = seq; i >= 1; i--) {
      const key = caseKey(i);
      const c = getJson(key, null);
      if (!c || !c.verdict) continue;
      const ref = 'case_' + pad3(i);
      // 示例案例不进入明细映射（防止示例的成交键被当成真实复发来源）
      if (D.recur.isDemoCase && D.recur.isDemoCase(c.verdict, ref, demoState)) continue;
      cases[ref] = c;
      (c.verdict.lines || []).forEach((line) => {
        if (!line) return;
        let k = '';
        try { k = D.recur.tk6(line); } catch (e) { k = ''; }
        if (!k) return;
        const prev = map[k];
        if (!prev || (prev.line && prev.line.flag !== '违规' && line.flag === '违规')) {
          map[k] = { ref: ref, line: line, case: c };
        }
      });
    }
    caseCache = { seq: seq, map: map, cases: cases };
    return caseCache;
  }

  function getCaseByRef(ref) {
    const c = loadCases();
    if (c.cases[ref]) return c.cases[ref];
    const m = String(ref || '').match(/(\d{1,})/);
    if (!m) return null;
    return getJson(caseKey(+m[1]), null);
  }

  function currentLine(k) {
    const v = lastReport && lastReport.v;
    if (!v || !Array.isArray(v.lines)) return null;
    for (let i = 0; i < v.lines.length; i++) {
      const l = v.lines[i];
      if (!l || l.flag !== '违规') continue;
      let kk = '';
      try { kk = D.recur.tk6(l); } catch (e) { kk = ''; }
      if (kk === k) return l;
    }
    return null;
  }

  // ---------- 1/3/6 数据模型 ----------
  function recurrenceModel(v, opts) {
    opts = opts || {};
    const end = opts.endDate || today8();
    const names = namesFrom(v);
    const top = D.recur.top(REPORT_WINDOW, end) || [];
    const hit = top.filter(x => x.count >= 2)[0] || null;

    if (hit) {
      const d = D.recur.detail(hit.ruleId, REPORT_WINDOW, end);
      const seen = {};
      let trades = 0;
      d.days.forEach((day) => {
        (day.keys || []).forEach((k) => {
          if (!seen[k]) { seen[k] = 1; trades++; }
        });
      });
      const datesText = hit.dates.map(fmtMd).join('/');
      const label = hit.ruleId + (names[hit.ruleId] ? ' ' + names[hit.ruleId] : '');
      return {
        kind: 'hit',
        ruleId: hit.ruleId,
        name: names[hit.ruleId] || '',
        count: hit.count,
        dates: hit.dates,
        datesText: datesText,
        trades: trades,
        headline: label + '：本周第 ' + hit.count + ' 次（' + datesText + '）',
        cta: trades > 0 ? '点开看 ' + trades + ' 笔' : '点开看 ' + hit.count + ' 天',
      };
    }

    const st = D.recur._state ? D.recur._state() : { rules: {} };
    if (!Object.keys((st && st.rules) || {}).length) {
      return {
        kind: 'empty',
        first: true,
        ruleId: '',
        name: '',
        headline: '这是第一份报告，还没有可比的复发记录。',
      };
    }

    const stats = D.recur.ruleStats(end);
    const ids = inspectIds(v);
    let best = null;
    ids.forEach((id) => {
      const s = stats[id];
      if (!s || s.sinceLast == null) return;
      if (D.recur.count(id, REPORT_WINDOW, end) > 1) return;
      if (!best || s.sinceLast > best.sinceLast
        || (s.sinceLast === best.sinceLast && num(id.slice(1), 99) < num(best.id.slice(1), 99))) {
        best = { id: id, sinceLast: s.sinceLast };
      }
    });

    let headline = '本周没有重复触发。';
    if (best && best.sinceLast > 0) {
      headline = '本周没有重复触发，' + best.id + ' 已 ' + best.sinceLast + ' 天没破';
    } else if (best) {
      headline = '本周没有重复触发，' + best.id + ' 今天触发过 1 次';
    }
    return {
      kind: 'empty',
      ruleId: best ? best.id : '',
      name: best ? (names[best.id] || '') : '',
      headline: headline,
    };
  }

  function firstBreachModel(v, opts) {
    opts = opts || {};
    const end = opts.endDate || today8();
    const ids = inspectIds(v);
    const names = namesFrom(v);
    const out = [];
    ids.forEach((id) => {
      const n30 = D.recur.count(id, 30, end);
      const n90 = D.recur.count(id, 90, end);
      let win = 0;
      if (n30 === 1) win = 30;
      else if (n30 === 0 && n90 === 1) win = 90;
      if (!win) return;
      const d = D.recur.detail(id, win, end);
      const last = d.days.length ? d.days[d.days.length - 1].date : '';
      out.push({ ruleId: id, name: names[id] || '', window: win, date: last });
    });
    out.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return num(a.ruleId.slice(1), 99) - num(b.ruleId.slice(1), 99);
    });
    const c = out[0] || null;
    if (!c) return null;
    const label = c.ruleId + (c.name ? ' ' + c.name : '');
    return {
      ruleId: c.ruleId,
      name: c.name,
      window: c.window,
      date: c.date,
      text: label + '：近 ' + c.window + ' 天第 1 次触发',
    };
  }

  function complianceModel() {
    const seq = caseSeq();
    if (complianceCache.seq === seq && complianceCache.model) return complianceCache.model;
    const days = {};
    const demoState = D.recur._state ? D.recur._state() : { rules: {} };
    for (let i = 1; i <= seq; i++) {
      const c = getJson(caseKey(i), null);
      if (!c || !c.verdict) continue;
      const ref = 'case_' + pad3(i);
      // 示例案例不计入真实合规天数（本机标记或固定样例签名）
      if (D.recur.isDemoCase && D.recur.isDemoCase(c.verdict, ref, demoState)) continue;
      (c.verdict.lines || []).forEach((l) => {
        if (!l) return;
        const d = D.recur.date8(l.date);
        if (!d) return;
        if (!days[d]) days[d] = { v: 0, dv: 0 };
        if (l.flag === '违规') days[d].v++;
      });
      (c.verdict.day_checks || []).forEach((dc) => {
        if (!dc) return;
        const d = D.recur.date8(dc.date);
        if (!d) return;
        if (!days[d]) days[d] = { v: 0, dv: 0 };
        days[d].dv++;
      });
    }
    const checked = Object.keys(days).sort();
    let current = 0;
    let best = 0;
    checked.forEach((d) => {
      if (days[d].v === 0 && days[d].dv === 0) {
        current++;
        if (current > best) best = current;
      } else {
        current = 0;
      }
    });
    let text = '';
    if (checked.length && best) {
      text = current
        ? '连续合规 ' + current + ' 天 · 历史最好 ' + best + ' 天'
        : '上次最好 ' + best + ' 天';
    }
    const result = {
      checked: checked.length,
      current: current,
      best: best,
      last: checked.length ? checked[checked.length - 1] : '',
      text: text,
    };
    complianceCache = { seq: seq, model: result };
    return result;
  }

  // ---------- 明细 ----------
  function buildTrade(k, cache) {
    const tk = parseTk6(k);
    const hit = cache.map[k] || null;
    if (hit && hit.line) {
      const l = hit.line;
      return {
        key: k,
        ref: hit.ref,
        missing: false,
        date: D.recur.date8(l.date) || tk.date,
        time: D.recur.time6(l.time) || tk.time,
        name: l.name || tk.id,
        code: l.code || '',
        side: l.side || tk.side,
        price: l.price != null ? l.price : tk.price,
        qty: l.qty != null ? l.qty : tk.qty,
        reason: l.reason || '',
        rule: l.rule || '',
        caseNo: (hit.case && hit.case.verdict && hit.case.verdict.case_no) || '',
        caseTs: (hit.case && hit.case.ts) || '',
      };
    }
    const cur = currentLine(k);
    if (cur) {
      return {
        key: k,
        ref: '',
        missing: true,
        date: D.recur.date8(cur.date) || tk.date,
        time: D.recur.time6(cur.time) || tk.time,
        name: cur.name || tk.id,
        code: cur.code || '',
        side: cur.side || tk.side,
        price: cur.price != null ? cur.price : tk.price,
        qty: cur.qty != null ? cur.qty : tk.qty,
        reason: cur.reason || '',
        rule: cur.rule || '',
        caseNo: '',
        caseTs: '',
      };
    }
    return {
      key: k,
      ref: '',
      missing: true,
      date: tk.date,
      time: tk.time,
      name: tk.id,
      code: '',
      side: tk.side,
      price: tk.price,
      qty: tk.qty,
      reason: '',
      rule: '',
      caseNo: '',
      caseTs: '',
    };
  }

  function detailModel(ruleId, win, endDate) {
    const end = endDate || today8();
    const d = D.recur.detail(ruleId, win, end);
    const iv = D.recur.intervals(ruleId, win, end);
    const cache = loadCases();
    const days = d.days.map((day) => {
      const trades = (day.keys || []).map(k => buildTrade(k, cache));
      const checks = [];
      (day.cases || []).forEach((ref) => {
        const cc = cache.cases[ref] || getCaseByRef(ref);
        if (!cc || !cc.verdict) return;
        (cc.verdict.day_checks || []).forEach((dc) => {
          if (!dc) return;
          if (D.recur.date8(dc.date) !== day.date) return;
          if (D.recur.ruleIds(dc.rule).indexOf(ruleId) < 0) return;
          const item = { text: dc.text || '', rule: dc.rule || '', ref: ref };
          if (!checks.some(x => x.text === item.text && x.ref === item.ref)) checks.push(item);
        });
      });
      return {
        date: day.date,
        keys: day.keys || [],
        cases: day.cases || [],
        trades: trades,
        checks: checks,
      };
    });
    return {
      ruleId: ruleId,
      window: d.window,
      start: d.start,
      end: d.end,
      count: d.count,
      days: days,
      intervals: iv,
      resonance: resonanceModel(ruleId, win, end),
    };
  }

  function resonanceModel(ruleId, win, end) {
    const list = D.recur.resonance(win, end) || [];
    return list.filter(x => x.rules.indexOf(ruleId) >= 0)[0] || null;
  }

  // ---------- 渲染 ----------
  function detailErrorHtml() {
    return '<div class="rc-detail"><h3>复发明细暂不可用</h3>'
      + '<p class="m-sub">本机存储读取失败，报告其他部分不受影响。</p>'
      + '<div class="btn-row"><button type="button" class="btn ghost" data-rc-close="1">关闭</button></div>'
      + '</div>';
  }

  function errorHtml() {
    return '<div class="rc-card rc-error" data-rc-root="1">'
      + '<div class="rc-line rc-line-main">'
      + '<span class="rc-main">复发索引读取失败（本机存储不可用）。这次不显示复发统计，报告其他部分不受影响。</span>'
      + '<button type="button" class="rc-retry" data-rc-retry="1">重试</button>'
      + '</div></div>';
  }

  function renderReportTop(v, state) {
    try {
      if (!D.recur) return errorHtml();
      if (!enabled()) return '';
      // 示例账户不写真实索引，也不拿真实复发记录套示例（批次 F 单独 seed）
      if (state && state.isDemo) return '';
      const key = (v && v.case_no) || '';
      if (key && key !== viewKey) {
        viewKey = key;
        emit('recur_view');
      }
      const opts = { endDate: today8() };
      lastReport = { v: v, state: state, opts: opts };
      const rec = recurrenceModel(v, opts);
      const comp = complianceModel();
      const fb = firstBreachModel(v, opts);

      let html = '<div class="rc-card' + (rec.kind === 'hit' ? ' rc-card-hit' : ' rc-card-empty') + '" data-rc-root="1">';
      if (rec.kind === 'hit') {
        // 手机 375px 下 done-box 只剩约 299px：标题与日期拆两行，完整文案进 aria-label
        const shortHead = rec.ruleId + (rec.name ? ' ' + rec.name : '') + '：本周第 ' + rec.count + ' 次';
        const full = rec.headline + ' · ' + rec.cta;
        html += '<button type="button" class="rc-line rc-line-main rc-tap" aria-label="' + esc(full) + '"'
          + ' data-rc-open="' + esc(rec.ruleId) + '" data-rc-name="' + esc(rec.name) + '">'
          + '<span class="rc-main"><b>' + esc(shortHead) + '</b></span>'
          + '<span class="rc-cta">' + esc(rec.cta) + ' <span class="rc-chev">›</span></span>'
          + '</button>';
      } else {
        html += '<div class="rc-line rc-line-main">'
          + '<span class="rc-main"><b>' + esc(rec.headline) + '</b></span>'
          + '</div>';
      }

      // 第二行：日期 + 首破（有首破时合规放到报告底部，避免三行）
      const sub = [];
      if (rec.kind === 'hit') {
        sub.push('<span class="rc-sub-item rc-dates">（' + esc(rec.datesText) + '）</span>');
      }
      if (fb) {
        // 首屏第二行要跟日期挤在一行：用「T03 近 30 天第 1 次」，全名放 title
        const shortFb = fb.ruleId + ' 近 ' + fb.window + ' 天第 1 次';
        const tip = fb.text + '。按成交日计；近 ' + fb.window + ' 天只有 1 天触发。';
        sub.push('<span class="rc-sub-item rc-first" title="' + esc(tip) + '">' + esc(shortFb) + '</span>');
      } else if (comp.text) {
        const tip = '按成交日计：violations=0 且 day_violations=0 才算合规日；n=' + comp.checked + ' 个成交日；suspects 不计。';
        const shortText = comp.current
          ? '连续合规 ' + comp.current + ' 天 · 最好 ' + comp.best + ' 天'
          : '上次最好 ' + comp.best + ' 天';
        sub.push('<span class="rc-sub-item" title="' + esc(tip) + '">'
          + esc(shortText) + '<i>n=' + comp.checked + '</i></span>');
      }
      if (sub.length) {
        html += '<div class="rc-line rc-line-sub">'
          + sub.join('<span class="rc-dot">·</span>')
          + '</div>';
      }
      html += '</div>';
      return html;
    } catch (e) {
      return errorHtml();
    }
  }

  // 报告底部：合规口径的完整版本（首屏放不下时也能看到）
  function renderReportBottom(v, state) {
    try {
      if (!D.recur) return '';
      if (!enabled()) return '';
      if (state && state.isDemo) return '';
      const comp = complianceModel();
      if (!comp.text) return '';
      return '<div class="rc-comp" data-rc-comp="1">'
        + '<div class="rc-comp-main">' + esc(comp.text) + '</div>'
        + '<div class="rc-comp-note">按成交日；violations=0 且 day_violations=0 才算合规日；'
        + 'n=' + comp.checked + ' 个成交日；suspects 不计；断点只显示上次最好。</div>'
        + '</div>';
    } catch (e) {
      return '';
    }
  }

  function tradeHtml(t) {
    const side = t.side === '卖' ? '卖' : (t.side === '买' ? '买' : String(t.side || ''));
    const code = t.code ? ' ' + esc(t.code) : '';
    const pq = (t.price !== '' && t.qty !== '')
      ? esc(fmtNum(t.price)) + '元 × ' + esc(fmtNum(t.qty)) + '股'
      : '';
    const refBtn = t.ref
      ? '<button type="button" class="rc-case" data-rc-case="' + esc(t.ref)
        + '" data-rc-key="' + esc(t.key) + '">跳回案例 ' + esc(caseLabel(t)) + ' ›</button>'
      : '<span class="rc-missing">' + (t.missing ? '原始案例已不在本机，仅保留这笔成交' : '') + '</span>';
    return '<div class="rc-trade">'
      + '<div class="rc-t-top">'
      + '<span class="rc-t-when">' + esc(fmtMd(t.date)) + ' ' + esc(fmtTime(t.time)) + '</span>'
      + '<span class="rc-t-side ' + (side === '卖' ? 'sell' : 'buy') + '">' + esc(side === '卖' ? '卖出' : '买入') + '</span>'
      + '<b class="rc-t-id">' + esc(t.name || t.key || '') + code + '</b>'
      + '</div>'
      + (pq ? '<div class="rc-t-pq">' + pq + '</div>' : '')
      + '<p class="rc-t-reason">当次理由：' + esc(t.reason || '原始案例没有留下理由') + '</p>'
      + '<div class="rc-t-foot">'
      + (t.rule ? '<span class="rc-t-rule">' + esc(t.rule) + '</span>' : '')
      + refBtn
      + '</div></div>';
  }

  function checkHtml(c) {
    return '<div class="rc-check">'
      + '<span class="rc-check-tag">' + esc(c.rule || '日级') + '</span>'
      + '<span class="rc-check-text">' + esc(c.text || '当日规则触发') + '</span>'
      + (c.ref ? '<button type="button" class="rc-case" data-rc-case="' + esc(c.ref) + '">跳回案例 ›</button>' : '')
      + '</div>';
  }

  function caseLabel(t) {
    const raw = String((t && t.caseNo) || (t && t.ref) || '');
    const m = raw.match(/(\d{1,})/);
    return m ? 'No.' + m[1].padStart(3, '0') : '案例';
  }

  function renderDetailHtml(model, name) {
    const title = model.ruleId + (name ? ' ' + name : '');
    const iv = model.intervals || { n: 0, median: null };
    const ivText = iv.n
      ? '中位间隔 ' + fmtNum(iv.median) + ' 天（n=' + iv.n + ' 段）'
      : '中位间隔 n=0（不足 2 段）';
    const wins = [7, 30, 90].map(w => '<button type="button" data-rc-win="' + w
      + '" class="' + (model.window === w ? 'on' : '') + '">近 ' + w + ' 天</button>').join('');
    const res = model.resonance
      ? '<p class="rc-res">' + esc(fmtMd(model.resonance.date)) + ' 同一天 '
        + model.resonance.rules.length + ' 条规则一起触发（'
        + esc(model.resonance.rules.join(' / ')) + '）。</p>'
      : '';
    const dayHtml = model.days.length
      ? model.days.map((day) => {
        const trades = day.trades.map(tradeHtml).join('');
        const checks = day.checks.map(checkHtml).join('');
        const empty = (!trades && !checks)
          ? '<p class="rc-missing">这一天只有索引记录，原始成交已不在本机。</p>'
          : '';
        return '<div class="rc-day">'
          + '<div class="rc-day-head"><b>' + esc(fmtMd(day.date)) + '</b>'
          + '<span>' + esc(fmtYmd(day.date)) + '</span></div>'
          + trades + checks + empty
          + '</div>';
      }).join('')
      : '<p class="rc-missing">这个窗口内没有触发记录。</p>';

    return '<div class="rc-detail">'
      + '<div class="rc-kicker">复发账本 · 明细</div>'
      + '<h3>' + esc(title) + '</h3>'
      + '<p class="m-sub">近 ' + model.window + ' 天触发 ' + model.count + ' 天 · ' + esc(ivText)
      + '<br>按成交日计数；同一天同一规则只算 1 天；存疑项不计。</p>'
      + '<div class="rc-win" role="group" aria-label="统计窗口">' + wins + '</div>'
      + res
      + dayHtml
      + '<div class="rc-foot-note">口径：按成交日，不按上传日；按触发日数，不按笔数；'
      + '同一天同一规则只算 1 天；suspects 不计；重判按成交键去重。</div>'
      + '<div class="btn-row"><button type="button" class="btn ghost" data-rc-close="1">关闭</button></div>'
      + '</div>';
  }

  function caseLineHtml(l, key) {
    const k = D.recur.tk6(l);
    const hit = k === key ? ' rc-hit' : '';
    const flagCls = l.flag === '违规' ? 'bad' : l.flag === '存疑' ? 'sus' : 'ok';
    return '<div class="rc-case-line' + hit + '">'
      + '<div class="rc-cl-top">'
      + '<span class="rflag ' + flagCls + '">' + esc(l.flag)
      + (l.rule ? ' · ' + esc(l.rule) : '') + '</span>'
      + '<span class="rc-cl-when">' + esc(fmtMd(D.recur.date8(l.date))) + ' '
      + esc(fmtTime(l.time)) + '</span></div>'
      + '<p class="rc-cl-trade">' + esc(l.side === '卖' ? '卖出' : '买入') + ' '
      + esc(l.name || '') + (l.code ? '（' + esc(l.code) + '）' : '') + ' '
      + esc(fmtNum(l.price)) + '元 × ' + esc(fmtNum(l.qty)) + '股</p>'
      + '<p class="rc-cl-reason">' + esc(l.reason || '') + '</p>'
      + '</div>';
  }

  function renderCaseHtml(ref, key) {
    const c = getCaseByRef(ref);
    if (!c || !c.verdict) {
      return '<div class="rc-detail">'
        + '<div class="rc-kicker">案例存档</div>'
        + '<h3>案例已不在本机</h3>'
        + '<p class="m-sub">索引还记着这次触发，但原始案例存档已被清空。复发天数仍按索引保留。</p>'
        + '<div class="rc-foot-note">本机只删了案例正文；要清掉复发索引，需要在设置里重建。</div>'
        + '<div class="btn-row">'
        + '<button type="button" class="btn ghost" data-rc-back="1">‹ 返回明细</button>'
        + '<button type="button" class="btn ghost" data-rc-close="1">关闭</button>'
        + '</div></div>';
    }
    const v = c.verdict;
    const no = caseLabel({ caseNo: v.case_no, ref: ref });
    const when = String(c.ts || '').slice(0, 10);
    const lines = (v.lines || []).map(l => caseLineHtml(l, key || '')).join('');
    return '<div class="rc-detail">'
      + '<div class="rc-case-nav"><button type="button" class="rc-back" data-rc-back="1">‹ 返回明细</button></div>'
      + '<div class="rc-kicker">原始案例存档</div>'
      + '<h3>案例存档 ' + esc(no) + '</h3>'
      + '<p class="m-sub">' + (when ? '判定存档于 ' + esc(when) + ' · ' : '')
      + '原始案例共 ' + (v.lines || []).length + ' 笔成交</p>'
      + (v.one_liner ? '<div class="m-body">“' + esc(v.one_liner) + '”</div>' : '')
      + '<div class="rc-case-lines">' + lines + '</div>'
      + '<div class="rc-foot-note">这是本机存档里的原始案例；你点开的那一笔已高亮。原 flag 保留，不做撤销。</div>'
      + '<div class="btn-row">'
      + '<button type="button" class="btn ghost" data-rc-back="1">‹ 返回明细</button>'
      + '<button type="button" class="btn ghost" data-rc-close="1">关闭</button>'
      + '</div></div>';
  }

  // ---------- 5 规则体检 ----------
  function readTemplatesFromDom() {
    const d = D.doc || (D.root && D.root.document);
    if (!d || typeof d.querySelectorAll !== 'function') return [];
    const cards = d.querySelectorAll('#rule-list .rule-card');
    const out = [];
    Array.prototype.forEach.call(cards, (card) => {
      const id = (card.dataset && card.dataset.id) || (card.getAttribute ? card.getAttribute('data-id') : '');
      if (!id) return;
      const span = card.querySelector ? card.querySelector('.rule-head span') : null;
      const name = span ? String(span.textContent || '').replace(id, '').trim() : '';
      out.push({ id: id, name: name });
    });
    return out;
  }

  function ruleHealthRows(config, stats, templates, endDate) {
    const end = endDate || today8();
    const seen = {};
    const rows = [];
    (templates || []).forEach((t) => {
      if (!t || !t.id || seen[t.id]) return;
      seen[t.id] = 1;
      rows.push({ id: t.id, name: t.name || '' });
    });
    ((config && config.rules) || []).forEach((r) => {
      if (!r || !r.templateId || seen[r.templateId]) return;
      seen[r.templateId] = 1;
      rows.push({ id: r.templateId, name: '' });
    });
    Object.keys(stats || {}).forEach((id) => {
      if (!seen[id]) {
        seen[id] = 1;
        rows.push({ id: id, name: '' });
      }
    });
    rows.sort((a, b) => {
      const d = num(String(a.id).slice(1), 99) - num(String(b.id).slice(1), 99);
      return d || String(a.id).localeCompare(String(b.id));
    });
    return rows.map((r) => {
      const s = stats[r.id] || {};
      return {
        id: r.id,
        name: r.name,
        triggerDays: D.recur.count(r.id, HEALTH_WINDOW, end),
        last: s.last || null,
        lastText: s.last ? fmtMd(s.last) : '',
      };
    });
  }

  // ---------- 未平仓跟踪计划（图鉴 U-013） ----------
  // 只记「给一个未平仓写下了跟踪计划」这一行为：计划表存日期/字数/哈希，原文留本机回看。
  function opHash(raw) {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    const s = String(raw == null ? '' : raw);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = ((a << 5) - a + c) | 0;
      b = ((b << 7) - b + c) | 0;
    }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
  }
  function openPositions() {
    const lg = getJson(KEY_LEDGER, null) || {};
    const all = Array.isArray(lg.trades) ? lg.trades : [];
    const map = {};
    const order = [];
    all.forEach((t) => {
      if (!t || !t.date || !t.side) return;
      const id = String(t.code || t.name || '').trim();
      if (!id) return;
      const acct = String(t.account || '') || 'default';
      const k = acct + '|' + id;
      if (!map[k]) {
        map[k] = { h: opHash(k), id: id, name: String(t.name || '').trim(), qty: 0, last: t.date };
        order.push(k);
      }
      map[k].qty += (t.side === '买' ? 1 : -1) * (+t.qty || 0);
      if (String(t.date) > map[k].last) map[k].last = String(t.date);
    });
    return order.map((k) => map[k]).filter((x) => x.qty > 0);
  }
  function openPlanAll() {
    const m = getJson(KEY_OPENPLAN, null);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  }
  function saveOpenPlan(h, text, day) {
    if (!h) return { ok: false, reason: 'no_key' };
    const body = String(text == null ? '' : text).replace(/\s+$/g, '').slice(0, OP_MAX);
    const len = Array.from(body).length;
    if (len < OP_MIN) return { ok: false, reason: 'short' };
    const at = String(day || today8());
    const m = openPlanAll();
    m[h] = { at: at, len: len, txt: body };
    try {
      const s = storage();
      if (!s) return { ok: false, reason: 'no_storage' };
      s.setItem(KEY_OPENPLAN, JSON.stringify(m));
    } catch (e) { return { ok: false, reason: 'write' }; }
    recordOpenPlan(h + '|' + at);
    return { ok: true, at: at, len: len };
  }
  function recordOpenPlan(fp) {
    try {
      const coll = (D.root && D.root.PanjiCollection) || null;
      if (coll && typeof coll.record === 'function') coll.record('open_plan', { fp: fp, storage: storage() });
    } catch (e) { /* 图鉴失败不影响计划保存 */ }
  }
  function renderOpenPlanCard() {
    const list = openPositions();
    if (!list.length) return '';
    const plans = openPlanAll();
    const rows = list.map((p) => {
      const plan = plans[p.h] || null;
      const label = esc(p.id + (p.name && p.name !== p.id ? ' ' + p.name : ''));
      return '<div class="rc-op-row" data-op-row="1" data-op-h="' + esc(p.h) + '">'
        + '<div class="rc-op-main"><b>' + label + '</b><span>未平仓</span></div>'
        + '<textarea class="rc-op-input" rows="2" maxlength="' + OP_MAX + '" data-op-input'
        + ' placeholder="下一步打算怎么处理（至少 ' + OP_MIN + ' 字）">' + esc(plan ? plan.txt : '') + '</textarea>'
        + '<div class="rc-op-foot"><button type="button" class="rc-op-save" data-op-save="1">保存计划</button>'
        + '<span class="rc-op-msg" data-op-msg="1">' + (plan ? '已写 · ' + fmtYmd(plan.at) : '还没有计划') + '</span></div>'
        + '</div>';
    }).join('');
    return '<div class="rc-health card" data-rc-openplan="1">'
      + '<div class="rc-health-head"><b>未平仓 · 跟踪计划</b><span>买进还没卖完的</span></div>'
      + rows
      + '<div class="rc-health-note">只写你的下一步；价格与数量不用写，不进分享卡。</div>'
      + '</div>';
  }

  // ---------- 月度复盘（U-012） ----------
  // 口径：当月成交 ≥3 笔，且当月 ≥80% 的成交写了理由或止损（同一单笔复盘口径）。
  // 只读不写交易内容；月度登记表只存月份 / 日期 / 笔数。
  function monthKeyOf(day) {
    return String(day == null ? '' : day).replace(/\D/g, '').slice(0, 6);
  }
  function monthLabel(month) {
    const s = String(month || '');
    return s.length === 6 ? s.slice(0, 4) + ' 年 ' + (+s.slice(4, 6)) + ' 月' : s;
  }
  function monthTk(t) {
    if (D.recur && typeof D.recur.tk6 === 'function') {
      try { return D.recur.tk6(t); } catch (e) { /* 落到空键 */ }
    }
    return '';
  }
  function monthVerdictKeys() {
    if (D.recur && typeof D.recur.verdictTradeKeys === 'function') {
      try { return D.recur.verdictTradeKeys() || {}; } catch (e) { /* 落到空表 */ }
    }
    return {};
  }
  function monthModel() {
    const month = monthKeyOf(today8());
    const lg = getJson(KEY_LEDGER, null);
    const all = lg && Array.isArray(lg.trades) ? lg.trades : [];
    const trades = all.filter((t) => t && monthKeyOf(t.date) === month);
    // 只有真的被逐笔复核过（案例 verdict.lines 里有这一笔）才算覆盖；
    // 只写理由标签或只填止损价都不算。
    const vkeys = monthVerdictKeys();
    let covered = 0;
    trades.forEach((t) => {
      const k = monthTk(t);
      if (k && vkeys[k]) covered++;
    });
    const n = trades.length;
    const pct = n ? Math.round((covered / n) * 100) : 0;
    const needCover = n ? Math.max(Math.ceil(n * MONTH_MIN_COVER) - covered, 0) : 0;
    const doneMap = getJson(KEY_MONTH, null);
    const done = !!(doneMap && typeof doneMap === 'object' && doneMap[month]);
    const doneAt = done ? String((doneMap[month] || {}).at || '') : '';
    return {
      month: month, label: monthLabel(month), n: n, covered: covered, pct: pct,
      needCover: needCover, done: done, doneAt: doneAt,
      eligible: !done && n >= 1 && needCover === 0,
      hasData: all.length > 0,
    };
  }
  function renderMonthlyCard() {
    const m = monthModel();
    if (!m.hasData) return '';
    let body;
    if (m.done) {
      body = '<p class="rc-mo-note">本月复盘已完成' + (m.doneAt ? ' · ' + esc(fmtYmd(m.doneAt)) : '')
        + '；当月 ' + m.n + ' 笔，覆盖率 ' + m.covered + '/' + m.n + '（' + m.pct + '%）。</p>';
    } else if (m.n === 0) {
      body = '<p class="rc-mo-note">' + esc(m.label) + ' 还没有成交；有成交即可进入月度复盘。</p>';
    } else {
      // 20261105：笔数不再作为硬门槛，只作提示（低频用户不该被挡在月度复盘门外）
      const tip = m.n < MONTH_MIN_TRADES ? '本月仅 ' + m.n + ' 笔，参考价值有限；' : '';
      const cover = '覆盖率 ' + m.covered + '/' + m.n + '（' + m.pct + '%）。';
      body = '<p class="rc-mo-note">' + esc(m.label) + ' ' + tip + cover + '</p>';
      if (m.needCover > 0) {
        body += '<p class="rc-mo-note">还差 ' + m.needCover + ' 笔没逐笔复核，覆盖率需 ≥80%。</p>';
      } else {
        body += '<div class="rc-mo-foot"><button type="button" class="rc-mo-btn" data-rc-month="1">完成本月复盘</button></div>';
      }
    }
    return '<div class="rc-mo card" data-rc-mo="1">'
      + '<div class="rc-kicker">本月复盘</div>' + body + '</div>';
  }
  function completeMonth() {
    const m = monthModel();
    if (m.done) return { ok: false, reason: 'done' };
    if (m.n === 0) return { ok: false, reason: 'trades', need: 1 };
    if (m.needCover > 0) return { ok: false, reason: 'cover', need: m.needCover };
    const at = today8();
    const map = getJson(KEY_MONTH, null);
    const next = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    next[m.month] = { at: at, n: m.n, covered: m.covered };
    try {
      const s = storage();
      if (!s) return { ok: false, reason: 'no_storage' };
      s.setItem(KEY_MONTH, JSON.stringify(next));
    } catch (e) { return { ok: false, reason: 'write' }; }
    try {
      const coll = (D.root && D.root.PanjiCollection) || null;
      if (coll && typeof coll.record === 'function') coll.record('monthly_review', { fp: m.month, storage: storage() });
    } catch (e) { /* 图鉴失败不影响月度登记 */ }
    return { ok: true, month: m.month, at: at };
  }

  function renderRulesBottom(config) {
    try {
      if (!D.recur) return '';
      if (!enabled()) return '';
      const end = today8();
      const stats = D.recur.ruleStats(end);
      const rows = ruleHealthRows(config, stats, readTemplatesFromDom(), end);
      const trs = rows.map(r => '<div class="rc-health-row">'
        + '<span class="rc-h-rule"><b>' + esc(r.id) + '</b> ' + esc(r.name || '') + '</span>'
        + '<span class="rc-h-n">' + r.triggerDays + ' 天</span>'
        + '<span class="rc-h-last">' + esc(r.lastText || '—') + '</span>'
        + '</div>').join('');
      const healthHtml = rows.length ? ('<div class="rc-health card" data-rc-health="1">'
        + '<div class="rc-health-head"><b>规则体检</b><span>过去 90 天 · 按模板编号</span></div>'
        + '<div class="rc-health-row rc-health-th">'
        + '<span>规则</span><span>90 天触发日数</span><span>最近触发</span></div>'
        + trs
        + '<div class="rc-health-note">按成交日计数：同一天同一规则只算 1 天；'
        + '存疑项不计；按模板编号排，不按触发频率排。</div>'
        + '</div>') : '';
      const opHtml = renderOpenPlanCard();
      if (!healthHtml && !opHtml) return '';
      return healthHtml + opHtml;
    } catch (e) {
      return '<div class="rc-health card rc-error"><b>规则体检暂不可用</b>'
        + '<p class="rc-health-note">本机存储读取失败，不影响规则保存。</p></div>';
    }
  }

  // ---------- 弹层交互 ----------
  function doc() {
    return D.doc || (D.root && D.root.document) || null;
  }

  function ensureMask() {
    const d = doc();
    if (!d) return null;
    let mask = d.getElementById ? d.getElementById('rc-mask') : null;
    if (mask) return mask;
    mask = d.createElement('div');
    mask.id = 'rc-mask';
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal rc-modal">'
      + '<div class="rc-modal-head"><span>纵向记忆</span>'
      + '<button type="button" class="rc-x" data-rc-close="1" aria-label="关闭">×</button></div>'
      + '<div id="rc-body"></div></div>';
    if (d.body) d.body.appendChild(mask);
    return mask;
  }

  function bodyEl() {
    const mask = ensureMask();
    if (!mask || !mask.querySelector) return null;
    return mask.querySelector('#rc-body');
  }

  function showMask(show) {
    const d = doc();
    if (!d || !d.getElementById) return;
    const mask = d.getElementById('rc-mask');
    if (!mask) return;
    if (show) mask.classList.add('show');
    else mask.classList.remove('show');
  }

  function openDetail(ruleId, name, sink) {
    emit('recur_detail_open');
    rcState = {
      view: 'detail', ruleId: ruleId, name: name || '',
      win: REPORT_WINDOW, endDate: today8(),
    };
    const html = renderDetailHtml(detailModel(ruleId, REPORT_WINDOW, rcState.endDate), rcState.name);
    if (sink) { sink.innerHTML = html; return html; }
    const body = bodyEl();
    if (body) body.innerHTML = html;
    showMask(true);
    return html;
  }

  function openCase(ref, key, sink) {
    emit('recur_case_open');
    rcState = Object.assign({}, rcState || {
      view: 'detail', ruleId: '', name: '', win: REPORT_WINDOW, endDate: today8(),
    }, { view: 'case', caseRef: ref, key: key || '' });
    const html = renderCaseHtml(ref, key || '');
    if (sink) { sink.innerHTML = html; return html; }
    const body = bodyEl();
    if (body) body.innerHTML = html;
    showMask(true);
    return html;
  }

  function renderRcBody() {
    if (!rcState) return;
    const body = bodyEl();
    if (!body) return;
    try {
      if (rcState.view === 'case') {
        body.innerHTML = renderCaseHtml(rcState.caseRef, rcState.key);
      } else {
        body.innerHTML = renderDetailHtml(detailModel(rcState.ruleId, rcState.win, rcState.endDate), rcState.name);
      }
    } catch (e) {
      body.innerHTML = '<div class="rc-detail"><h3>复发明细暂不可用</h3>'
        + '<p class="m-sub">本机存储读取失败，报告其他部分不受影响。</p>'
        + '<div class="btn-row"><button type="button" class="btn ghost" data-rc-close="1">关闭</button></div></div>';
    }
  }

  function retryReport() {
    const d = doc();
    if (!d || !lastReport || !d.getElementById) return;
    const el = d.getElementById('rep-ext-top');
    if (!el) return;
    const html = renderReportTop(lastReport.v, lastReport.state);
    el.innerHTML = html;
    el.hidden = !html;
  }

  function onClick(e) {
    const t = e && e.target;
    if (!t || !t.closest) return;
    const moBtn = t.closest('[data-rc-month]');
    if (moBtn) {
      const res = completeMonth();
      const host = t.closest('[data-rc-mo]');
      if (res.ok) { if (host) host.outerHTML = renderMonthlyCard(); }
      else if (host) {
        const note = host.querySelector ? host.querySelector('.rc-mo-note') : null;
        if (note && res.reason === 'cover') note.textContent = '还差 ' + (res.need || 1) + ' 笔没逐笔复核，覆盖率需 ≥80%。';
      }
      return;
    }
    const opSave = t.closest('[data-op-save]');
    if (opSave) {
      const row = opSave.closest('[data-op-row]');
      const h = row ? row.getAttribute('data-op-h') : '';
      const ta = row && row.querySelector ? row.querySelector('[data-op-input]') : null;
      const msg = row && row.querySelector ? row.querySelector('[data-op-msg]') : null;
      const res = saveOpenPlan(h, ta ? ta.value : '');
      if (msg) {
        msg.textContent = res.ok ? '已写 · ' + fmtYmd(res.at)
          : (res.reason === 'short' ? '至少写 ' + OP_MIN + ' 字' : '保存失败');
      }
      return;
    }
    const open = t.closest('[data-rc-open]');
    if (open) {
      e.preventDefault();
      openDetail(open.getAttribute('data-rc-open'), open.getAttribute('data-rc-name') || '');
      return;
    }
    const win = t.closest('[data-rc-win]');
    if (win && rcState) {
      rcState.win = num(win.getAttribute('data-rc-win'), REPORT_WINDOW);
      renderRcBody();
      return;
    }
    const caseBtn = t.closest('[data-rc-case]');
    if (caseBtn) {
      e.preventDefault();
      openCase(caseBtn.getAttribute('data-rc-case'), caseBtn.getAttribute('data-rc-key') || '');
      return;
    }
    const back = t.closest('[data-rc-back]');
    if (back && rcState) {
      rcState.view = 'detail';
      renderRcBody();
      return;
    }
    const close = t.closest('[data-rc-close]');
    if (close) {
      showMask(false);
      return;
    }
    const retry = t.closest('[data-rc-retry]');
    if (retry) {
      retryReport();
      return;
    }
    const d = doc();
    const mask = d && d.getElementById ? d.getElementById('rc-mask') : null;
    if (mask && t === mask) showMask(false);
  }

  // ---------- 启动：回填 + 注册钩子 ----------
  function startupBackfill() {
    if (!enabled()) return { skipped: 'flag' };
    if (!D.recur) return { skipped: 'no_recur' };
    const seq = caseSeq();
    resetCache();
    if (!seq) return { cases: 0 };
    const r = D.recur.backfill();
    resetCache();
    return r;
  }

  function boot() {
    if (booted) return false;
    const ext = D.ext || (D.root && D.root.PanjiExt);
    const d = doc();
    if (!ext || !d) return false;
    booted = true;
    if (!enabled()) return false;
    try { startupBackfill(); } catch (e) { /* 回填失败不阻塞首页 */ }
    try {
      ext.reportTop.push((v, state) => renderReportTop(v, state));
      ext.reportBottom.push((v, state) => renderReportBottom(v, state));
      ext.rulesBottom.push((config) => renderRulesBottom(config));
      if (Array.isArray(ext.homeTop)) ext.homeTop.push(() => renderMonthlyCard());
      ext.afterConfirm.push((payload) => {
        if (!payload) return;
        try {
          // 示例确认仍会被 app.js 写进 guanzhu_case_*；这里只打标记，
          // 让 ingest / backfill / 合规统计三条路径都跳过它，不污染真实复发。
          if (payload.isDemo) {
            if (D.recur.markDemo) D.recur.markDemo(payload.caseNo, payload.verdict);
          } else {
            D.recur.ingest(payload.verdict, payload.caseNo);
          }
          resetCache();
        } catch (e) { /* 单次写入失败不影响报告 */ }
      });
      d.addEventListener('click', onClick);
    } catch (e) { /* 钩子注册失败静默，页面照常 */ }
    return true;
  }

  const api = {
    FLAG,
    REPORT_WINDOW,
    HEALTH_WINDOW,
    configure(opts) {
      opts = opts || {};
      if ('root' in opts) D.root = opts.root;
      if ('recur' in opts) D.recur = opts.recur;
      if ('storage' in opts) D.storage = opts.storage;
      if ('ext' in opts) D.ext = opts.ext;
      if ('track' in opts) D.track = opts.track;
      if ('flag' in opts) D.flag = opts.flag;
      if ('now' in opts) D.now = opts.now;
      if ('doc' in opts) D.doc = opts.doc;
      return api;
    },
    enabled,
    recurrenceModel,
    firstBreachModel,
    complianceModel,
    detailModel,
    ruleHealthRows,
    renderReportTop,
    renderReportBottom,
    renderRulesBottom,
    renderDetailHtml,
    renderCaseHtml,
    openDetail,
    openCase,
    startupBackfill,
    resetCache,
    openPositions,
    openPlanAll,
    saveOpenPlan,
    renderOpenPlanCard,
    monthModel,
    renderMonthlyCard,
    completeMonth,
    _boot: boot,
  };

  // 浏览器里自启动；Node 测试只导出纯函数
  if (typeof module !== 'object' || !module.exports) boot();

  return api;
});
