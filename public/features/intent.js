// features/intent.js —— 批次 B：日频动作 7–11
//
// 7 明日一规（focus）    ：报告末尾单选，只列已勾规则、按 T01→T13 排、默认不选；次日首屏只结算这一条。
// 8 盘前一句话（note）   ：≤40 字，原文留存与回引，不解析、不判定。
// 9 买入理由（reason）   ：确认后 5 个固定标签，可跳过；平仓用本机 FIFO，只给 n / 中位持有 / 已实现盈亏中位数。
// 10 止损预案（stop）    ：买入后登记止损价，可跳过；T12 只显示「已登记/未登记」，不判断高低。
//    20261107 第一步：普通用户存档后默认走「记预案」可选步骤（不依赖 reason/stop flag）；
//    「这次不记」写跳过标记（null），下次不再问，但不算已记录。
//    20261108 方案 B：T12 判定只认「被问过的成交」——有键进判定（正数=已记录、null=未记录），
//    无键（含历史交割单导入）不进判定、不进分母。判定实现见 replay_review.js 的 t12 段。
// 11 情绪打卡（mood，★）：首页 3 选 1，当天一次；报告给分组越线率，样本 <30 不分组；默认 flag 关。
//
// 键表（docs/30功能_分批施工_20261031.md §2.1）：
//   guanzhu_focus_v1  {date, ruleId}
//   guanzhu_note_v1   {date, text}
//   guanzhu_reason_v1 {tk6: tag}     tag='' 表示明确跳过
//   guanzhu_stop_v1   {tk6: price}   price=null 表示明确跳过
//   guanzhu_mood_v1   {date: mood}   值为 冷静/急/慌
//
// 只往 PanjiExt 注册钩子，不改 app.js / index.html / server。
// 浏览器挂 window.PanjiFeatures.intent；Node 测试走 module.exports。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else {
    const api = factory(root);
    root.PanjiFeatures = root.PanjiFeatures || {};
    root.PanjiFeatures.intent = api;
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // FX-3：键统一取自 PanjiStore.KEYS；无 store 环境（Node vm 沙箱）回落同值 fallback
  const Store = (function () {
    try { if (root && root.PanjiStore) return root.PanjiStore; } catch (e) { /* 继续 */ }
    try { if (typeof require === 'function') return require('../store.js'); } catch (e) { /* 继续 */ }
    return null;
  })();
  function keyOf(name, fallback) { return (Store && Store.KEYS && Store.KEYS[name]) || fallback; }

  const KEYS = {
    focus: keyOf('focus', 'guanzhu_focus_v1'),
    note: keyOf('note', 'guanzhu_note_v1'),
    reason: keyOf('reason', 'guanzhu_reason_v1'),
    stop: keyOf('stop', 'guanzhu_stop_v1'),
    mood: keyOf('mood', 'guanzhu_mood_v1'),
    ack: keyOf('ack', 'guanzhu_ack_v1'),
    ackTxt: keyOf('ackTxt', 'guanzhu_ack_txt_v1'),
  };
  const RULES_KEY = keyOf('rules', 'guanzhu_rules_v1');
  const LEDGER_KEY = keyOf('ledger', 'guanzhu_ledger');
  const NOTE_MAX = 40;
  const REASON_TAGS = ['追涨', '回踩', '消息', '补仓', '随手'];
  const MOODS = ['冷静', '急', '慌'];
  const MOOD_MIN_SAMPLE = 30;
  const MOOD_WINDOW = 90;

  let adapter = null;        // 测试注入 storage
  let flagsOverride = null;  // 测试注入 flag
  let recurOverride = null;  // 测试注入 PanjiRecur
  let collOverride = null;   // 测试注入 PanjiCollection

  // ---------- 存储 ----------
  function storage() {
    if (adapter) return adapter;
    return null;
  }
  function storeGet(key, fallback) {
    const s = storage();
    if (s) {
      try {
        const raw = s.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    }
    try {
      if (Store && typeof Store.get === 'function') return Store.get(key, fallback);
      const raw = root.localStorage ? root.localStorage.getItem(key) : null;
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function storeSet(key, value) {
    const s = storage();
    if (s) {
      try { s.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    }
    try {
      if (Store && typeof Store.set === 'function') return !!Store.set(key, value).ok;
      root.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }
  function storeRemove(key) {
    const s = storage();
    if (s) {
      try { s.removeItem(key); return true; } catch (e) { return false; }
    }
    try {
      if (Store && typeof Store.remove === 'function') return !!Store.remove(key);
      root.localStorage.removeItem(key);
      return true;
    } catch (e) { return false; }
  }
  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

  // ---------- flag / 埋点 / 复发索引 ----------
  function flag(name) {
    if (typeof flagsOverride === 'function') {
      try { return !!flagsOverride(name); } catch (e) { return false; }
    }
    if (isObj(flagsOverride)) return !!flagsOverride[name];
    try {
      if (typeof root.PanjiFlag === 'function') return !!root.PanjiFlag(name);
    } catch (e) { /* 静默 */ }
    return false;
  }
  function track(name) {
    try {
      const fn = root.PanjiTrack || root.__panjiTrack;
      if (typeof fn === 'function') fn(name);
    } catch (e) { /* 埋点失败不影响流程 */ }
  }
  function recurApi() {
    if (recurOverride) return recurOverride;
    try { return root.PanjiRecur || null; } catch (e) { return null; }
  }

  // ---------- 日期与数值 ----------
  function date8(v) {
    const d = String(v || '').replace(/[^\d]/g, '');
    if (d.length === 8) return d;
    if (d.length === 6) return '20' + d;
    return '';
  }
  function today8() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }
  function addDays8(date, n) {
    const y = +date.slice(0, 4), m = +date.slice(4, 6), d = +date.slice(6, 8);
    const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
    return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
  }
  function daysBetween(a, b) {
    const pa = Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8));
    const pb = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
    return Math.round((pb - pa) / 86400000);
  }
  function fmtDate(d) {
    const s = date8(d);
    return s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';
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
  // 与 recur.js tk6 同口径；有 PanjiRecur 时优先用它的实现
  function localTk6(t) {
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
  function tk6(t) {
    const r = recurApi();
    if (r && typeof r.tk6 === 'function') {
      try { return r.tk6(t); } catch (e) { /* 落到本地实现 */ }
    }
    return localTk6(t);
  }
  function median(nums) {
    const a = (nums || []).filter(n => typeof n === 'number' && isFinite(n)).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }
  function okFlag(t) { return String((t && t.side) || '').trim() === '买'; }
  function ruleIds(raw) {
    return String(raw || '').split('+').map(s => s.trim()).filter(s => /^T\d{2}$/.test(s));
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  // 成交价量：缺字段/非数值时给明确降级文案，不拼出 undefined/null/NaN
  function numField(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return isFinite(n) ? n : null;
    }
    return null;
  }
  function fmtPriceQty(price, qty) {
    const p = numField(price), q = numField(qty);
    if (p === null || q === null) return '价格/数量未提供';
    return p + '元 × ' + q + '股';
  }

  // ---------- 8 盘前一句话 ----------
  function clampNote(text) {
    const s = String(text == null ? '' : text).replace(/\s+$/g, '');
    return Array.from(s).slice(0, NOTE_MAX).join('');
  }
  function getNote() {
    const n = storeGet(KEYS.note, null);
    if (!isObj(n) || typeof n.text !== 'string') return null;
    return { date: date8(n.date), text: clampNote(n.text) };
  }
  function setNote(text, date) {
    const d = date8(date) || today8();
    return storeSet(KEYS.note, { date: d, text: clampNote(text) });
  }

  // ---------- 7 明日一规 ----------
  function focusList(ids) {
    return Array.from(new Set((ids || []).filter(id => /^T\d{2}$/.test(id))))
      .sort((a, b) => (+a.slice(1)) - (+b.slice(1)));
  }
  function getFocus() {
    const f = storeGet(KEYS.focus, null);
    if (!isObj(f) || !/^T\d{2}$/.test(String(f.ruleId || ''))) return null;
    const d = date8(f.date);
    return d ? { date: d, ruleId: f.ruleId } : null;
  }
  function setFocus(ruleId, date) {
    if (!/^T\d{2}$/.test(String(ruleId || ''))) return false;
    return storeSet(KEYS.focus, { date: date8(date) || today8(), ruleId: ruleId });
  }
  function clearFocus() { return storeRemove(KEYS.focus); }

  function enabledRuleIds(state, v) {
    const cfg = storeGet(RULES_KEY, null);
    if (isObj(cfg) && Array.isArray(cfg.rules) && cfg.rules.length) {
      return cfg.rules.map(r => r && r.templateId).filter(Boolean);
    }
    if (state && Array.isArray(state.defaultRules) && state.defaultRules.length) {
      return state.defaultRules.map(r => r && r.templateId).filter(Boolean);
    }
    if (v && Array.isArray(v.rule_stats) && v.rule_stats.length) {
      return v.rule_stats.map(r => r && r.id).filter(Boolean);
    }
    return [];
  }
  function ruleNames(state, v) {
    const out = {};
    (state && Array.isArray(state.templates) ? state.templates : []).forEach(t => {
      if (t && t.id) out[t.id] = String(t.name || '');
    });
    (v && Array.isArray(v.rule_stats) ? v.rule_stats : []).forEach(r => {
      if (r && r.id && !out[r.id]) out[r.id] = String(r.name || '');
    });
    return out;
  }

  // 次日结算：只算这一条规则；日期优先 focus.date，周末/停更则落到之后第一个有成交的复盘日
  function settleFocus(v, focus) {
    const f = focus || getFocus();
    if (!isObj(v) || !f) return null;
    const caseDates = uniq((v.lines || []).map(l => date8(l && l.date))).sort();
    let d = f.date;
    if (caseDates.indexOf(d) < 0) {
      const next = caseDates.filter(x => x >= d)[0];
      if (next) d = next;
    }
    const hasDate = caseDates.indexOf(d) >= 0;
    let lines = 0, dayChecks = 0;
    if (hasDate) {
      (v.lines || []).forEach(l => {
        if (l && l.flag === '违规' && date8(l.date) === d && ruleIds(l.rule).indexOf(f.ruleId) >= 0) lines++;
      });
      (v.day_checks || []).forEach(x => {
        if (x && date8(x.date) === d && ruleIds(x.rule).indexOf(f.ruleId) >= 0) dayChecks++;
      });
    }
    return {
      ruleId: f.ruleId,
      focusDate: f.date,
      date: d,
      hasDate: hasDate,
      lines: lines,
      dayChecks: dayChecks,
      hit: lines + dayChecks > 0,
    };
  }
  function focusStats(ruleId) {
    const r = recurApi();
    if (!r || typeof r.ruleStats !== 'function') return null;
    try {
      const all = r.ruleStats(today8());
      return (all && all[ruleId]) || null;
    } catch (e) { return null; }
  }

  // ---------- 9 买入理由 + FIFO ----------
  function getReasonMap() {
    const m = storeGet(KEYS.reason, null);
    return isObj(m) ? m : {};
  }
  function reasonGetKey(key) {
    const m = getReasonMap();
    return m[key] == null ? '' : String(m[key]);
  }
  function reasonGet(t) { return reasonGetKey(tk6(t)); }
  function reasonSetKey(key, tag) {
    if (!key) return { ok: false, reason: 'no_key' };
    const val = tag == null ? '' : String(tag);
    if (val !== '' && REASON_TAGS.indexOf(val) < 0) return { ok: false, reason: 'bad_tag' };
    const m = getReasonMap();
    m[key] = val;
    storeSet(KEYS.reason, m);
    if (val) { track('reason_tag'); recordReasonTag(key); }
    return { ok: true, tag: val };
  }
  // 图鉴 U-014：「写下买入理由」这一行为单独记一条（只记行为/日期，不含交易内容）。
  // 原始 key=tk6 交给 collection.record 后由它哈希成不透明指纹，落盘不含代码/价格/数量。
  // 采集不在场或存储被禁时静默跳过，绝不打断记理由主流程。
  function recordReasonTag(key) {
    try {
      const coll = (root && root.PanjiCollection) ||
        (typeof PanjiCollection !== 'undefined' ? PanjiCollection : null);
      if (coll && typeof coll.record === 'function') coll.record('reason_tag', { fp: key });
    } catch (e) { /* 静默：图鉴失败不影响理由标签 */ }
  }
  function reasonSet(t, tag) { return reasonSetKey(tk6(t), tag); }

  function getStopMap() {
    const m = storeGet(KEYS.stop, null);
    return isObj(m) ? m : {};
  }
  function stopStatusKey(key) {
    const m = getStopMap();
    const asked = Object.prototype.hasOwnProperty.call(m, key);
    const raw = asked ? m[key] : null;
    const n = +raw;
    const registered = asked && typeof raw === 'number' && isFinite(n) && n > 0;
    return { key: key, asked: asked, price: registered ? n : null, registered: registered };
  }
  function stopStatus(t) { return stopStatusKey(tk6(t)); }
  function setStopKey(key, price) {
    if (!key) return { ok: false, reason: 'no_key' };
    const m = getStopMap();
    if (price == null || price === '') {
      m[key] = null;                    // 明确跳过：记住已问过，不再弹
      storeSet(KEYS.stop, m);
      return { ok: true, registered: false, skipped: true };
    }
    const n = +price;
    if (!isFinite(n) || n <= 0) return { ok: false, reason: 'bad_price' };
    m[key] = n;
    storeSet(KEYS.stop, m);
    track('stop_set');
    return { ok: true, registered: true, price: n };
  }
  function setStop(t, price) { return setStopKey(tk6(t), price); }

  // ---------- 12 越线认下 + 改法（图鉴 U-007） ----------
  // 只记「认下这条越线并写下改法」这一行为：登记表存规则/日期/字数/哈希，
  // 不含代码、价格、数量；改法原文单独留在本机供回看，不进分享卡。
  const ACK_MIN = 20;
  const ACK_MAX = 100;
  const ACK_TEXT_MAX = 200;
  let ackCtx = {};

  // 与 collection.opaqueFp 同一算法（FNV 双 32 位）：写入后取不出原始 tk6
  function ackHash(raw) {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    const s = String(raw == null ? '' : raw);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = ((a << 5) - a + c) | 0;
      b = ((b << 7) - b + c) | 0;
    }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
  }
  function dayDash(v) {
    const d = date8(v);
    return d ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : todayDash();
  }
  function todayDash() { return dayDash(today8()); }
  function getAckList() {
    const l = storeGet(KEYS.ack, null);
    return Array.isArray(l) ? l : [];
  }
  function getAckTxt() {
    const m = storeGet(KEYS.ackTxt, null);
    return isObj(m) ? m : {};
  }
  function ackSame(list, ruleId) {
    return list.filter(x => x && x.r === ruleId && +(x.len || 0) >= ACK_MIN).length;
  }
  function ackStatusKey(key, ruleId) {
    const h = ackHash(key);
    const list = getAckList();
    const hit = list.filter(x => x && x.h === h && x.r === ruleId)[0] || null;
    return {
      h: h, done: !!hit, len: hit ? +(hit.len || 0) : 0, n: ackSame(list, ruleId),
      text: hit ? String(getAckTxt()[h] || '') : '',
    };
  }
  function ackSaveKey(key, ruleId, text, day) {
    if (!key || !ruleId) return { ok: false, reason: 'no_key' };
    const body = String(text == null ? '' : text).replace(/\s+$/g, '').slice(0, ACK_TEXT_MAX);
    const len = Array.from(body).length;
    if (len < ACK_MIN) return { ok: false, reason: 'short' };
    const h = ackHash(key);
    const at = dayDash(day);
    const list = getAckList();
    let hit = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].h === h && list[i].r === ruleId) { hit = list[i]; break; }
    }
    if (hit) { hit.at = at; hit.len = len; }
    else list.push({ r: ruleId, at: at, h: h, len: len });
    while (list.length > ACK_MAX) list.shift();
    storeSet(KEYS.ack, list);
    const txt = getAckTxt();
    txt[h] = body;
    storeSet(KEYS.ackTxt, txt);
    recordAck(h + '|' + ruleId);
    ackHooks.forEach(function (fn) {
      try { fn({ key: key, rule: ruleId, at: at }); } catch (e) { /* 订阅方失败不影响认下 */ }
    });
    return { ok: true, h: h, n: ackSame(list, ruleId), at: at };
  }
  // 认下成功后的订阅点：B 的窗口事件挂在这里，不另造确认入口
  const ackHooks = [];
  function onAck(fn) { if (typeof fn === 'function') ackHooks.push(fn); }
  function recordAck(fp) {
    try {
      const coll = collectionApi();
      if (coll && typeof coll.record === 'function') coll.record('violation_ack', { fp: fp });
    } catch (e) { /* 静默：图鉴失败不影响改法保存 */ }
  }
  function collectionApi() {
    if (collOverride) return collOverride;
    try { return (root && root.PanjiCollection) || null; } catch (e) { return null; }
  }

  // 本机 FIFO：同标的最早买入先配对；卖超部分不配对（底仓成本未知）
  function fifoMatches(trades) {
    const list = [];
    (Array.isArray(trades) ? trades : []).forEach((raw, i) => {
      if (!raw) return;
      const side = String(raw.side || '').trim();
      if (side !== '买' && side !== '卖') return;
      const price = +raw.price, qty = +raw.qty;
      if (!isFinite(price) || price <= 0 || !isFinite(qty) || qty <= 0) return;
      list.push({
        i: i,
        date: date8(raw.date),
        time: time6(raw.time),
        code: String(raw.code || '').trim(),
        name: String(raw.name || '').trim(),
        side: side,
        price: price,
        qty: qty,
        key: tk6(raw),
      });
    });
    list.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.i - b.i);

    const lots = {};
    const out = [];
    list.forEach(t => {
      const sym = t.code || t.name;
      if (!lots[sym]) lots[sym] = [];
      if (t.side === '买') {
        lots[sym].push({ key: t.key, date: t.date, price: t.price, qty: t.qty });
        return;
      }
      let remain = t.qty;
      while (remain > 1e-9 && lots[sym].length) {
        const lot = lots[sym][0];
        const q = Math.min(remain, lot.qty);
        out.push({
          sym: sym,
          name: t.name || lot.name || '',
          buyKey: lot.key,
          buyDate: lot.date,
          sellDate: t.date,
          qty: q,
          pnl: (t.price - lot.price) * q,
          holdDays: daysBetween(lot.date, t.date),
        });
        lot.qty -= q;
        remain -= q;
        if (lot.qty <= 1e-9) lots[sym].shift();
      }
    });
    return out;
  }

  // 只按固定标签顺序并列输出；不排序、不给比例
  function reasonOutcomes(trades, reasonMap) {
    const matches = fifoMatches(trades);
    const byTag = {};
    matches.forEach(m => {
      const tag = (reasonMap && reasonMap[m.buyKey]) || '';
      if (REASON_TAGS.indexOf(tag) < 0) return;
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(m);
    });
    return REASON_TAGS.map(tag => {
      const arr = byTag[tag] || [];
      return {
        tag: tag,
        n: arr.length,
        medHoldDays: arr.length ? median(arr.map(m => m.holdDays)) : null,
        medPnl: arr.length ? round2(median(arr.map(m => m.pnl))) : null,
      };
    }).filter(x => x.n > 0);
  }

  // ---------- 11 情绪打卡 ----------
  function getMoodMap() {
    const m = storeGet(KEYS.mood, null);
    return isObj(m) ? m : {};
  }
  function moodGet(date) {
    const map = getMoodMap();
    return map[date8(date) || today8()] || null;
  }
  function moodSet(mood, date) {
    const d = date8(date) || today8();
    if (MOODS.indexOf(mood) < 0) return { ok: false, reason: 'bad_mood' };
    const map = getMoodMap();
    if (map[d]) return { ok: false, reason: 'already', mood: map[d] };
    map[d] = mood;
    const saved = storeSet(KEYS.mood, map);
    if (saved) track('mood_set');
    return { ok: saved, date: d, mood: mood };
  }
  function judgedDates() {
    const out = [];
    const ledger = storeGet(LEDGER_KEY, null);
    (isObj(ledger) && Array.isArray(ledger.trades) ? ledger.trades : []).forEach(t => {
      if (t && t.date) out.push(date8(t.date));
    });
    return uniq(out);
  }
  function violationDays(windowDays, end) {
    const r = recurApi();
    if (!r || typeof r.top !== 'function') return null;
    const days = [];
    try {
      (r.top(windowDays || MOOD_WINDOW, end || today8()) || []).forEach(x => {
        (x && Array.isArray(x.dates) ? x.dates : []).forEach(d => days.push(date8(d)));
      });
    } catch (e) { return null; }
    return uniq(days);
  }
  // 分母=窗口内有复盘记录且记了情绪的天数；分组样本 <30 不展示
  function moodGroupStats(opts) {
    opts = opts || {};
    const windowDays = +opts.windowDays || MOOD_WINDOW;
    const end = date8(opts.end) || today8();
    const start = addDays8(end, -(windowDays - 1));
    const vs = new Set((opts.violationDays || []).map(date8).filter(Boolean));
    const js = new Set((opts.judgedDates || []).map(date8).filter(Boolean));
    const minSample = opts.minSample == null ? MOOD_MIN_SAMPLE : +opts.minSample;
    const map = isObj(opts.moodMap) ? opts.moodMap : {};
    const groups = MOODS.map(m => ({ mood: m, n: 0, violatedDays: 0, rate: null }));
    const byMood = {};
    groups.forEach(g => { byMood[g.mood] = g; });

    Object.keys(map).forEach((raw) => {
      const d = date8(raw);
      if (!d || d < start || d > end) return;
      if (!js.has(d)) return;               // 没有复盘记录的日子不进分母
      const g = byMood[map[raw]];
      if (!g) return;
      g.n++;
      if (vs.has(d)) g.violatedDays++;
    });
    groups.forEach(g => { g.rate = g.n ? g.violatedDays / g.n : null; });

    const shown = groups.filter(g => g.n >= minSample);
    return {
      windowDays: windowDays,
      start: start,
      end: end,
      minSample: minSample,
      groups: groups,
      shown: shown,
      eligible: shown.length > 0,
    };
  }
  function pct(rate) { return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`; }

  // ---------- 渲染（钩子内容） ----------
  function renderMoodCard() {
    const today = today8();
    const cur = moodGet(today);
    const btns = MOODS.map(m => `<button type="button" class="pi-mood-btn${cur === m ? ' on' : ''}"
      data-pi-mood="${esc(m)}" aria-pressed="${cur === m ? 'true' : 'false'}"${cur ? ' disabled' : ''}>${esc(m)}</button>`).join('');
    return `<div class="pi-block card" id="pi-mood-block">
      <div class="pi-head">盘前情绪打卡</div>
      <p class="pi-sub">当天只记一次，记了就不再改；只用来看分组越线率。</p>
      <div class="pi-moods">${btns}</div>
      <p class="pi-status">${cur ? `今天已记：${esc(cur)}（当天只记一次）` : '今天还没记。'}</p>
    </div>`;
  }

  function renderNoteCard() {
    const today = today8();
    const note = getNote();
    const prev = note && note.date && note.date !== today ? note : null;
    const text = note && note.date === today ? note.text : '';
    return `<div class="pi-block card" id="pi-note-block">
      <div class="pi-head">盘前一句话</div>
      <p class="pi-sub">≤40 字；原文留着，不解析、不判定。</p>
      <textarea class="pi-note-input" data-pi-note rows="2" maxlength="40"
        placeholder="例：今天只做计划内的两笔">${esc(text)}</textarea>
      <div class="pi-note-foot">
        <span class="pi-dim" data-pi-note-count>${Array.from(text).length}/40</span>
        <button type="button" class="pi-mini" data-pi-note-save>存下</button>
      </div>
      ${prev ? `<p class="pi-quote">上一份盘前记录（${fmtDate(prev.date)}）原文：『${esc(prev.text)}』</p>` : ''}
      ${note && note.date === today ? '<p class="pi-status">今天已存，可在明天首屏原文回引。</p>' : ''}
    </div>`;
  }

  function renderFocusMini() {
    const f = getFocus();
    if (!f) return '';
    const today = today8();
    if (f.date < today) return '';
    const label = f.date === today ? '今天结算项' : '已定结算项';
    return `<div class="pi-block card" id="pi-focus-mini">
      <div class="pi-head">${label}</div>
      <p class="pi-line"><b>${esc(f.ruleId)}</b> · ${fmtDate(f.date)}</p>
      <p class="pi-sub">只结算这一条，不扩到其他规则。</p>
    </div>`;
  }

  function renderHomeTop() {
    const parts = [];
    if (flag('mood')) parts.push(renderMoodCard());
    if (flag('note')) parts.push(renderNoteCard());
    if (flag('focus')) parts.push(renderFocusMini());
    return parts.length ? `<div class="pi-wrap" data-pi="home">${parts.join('')}</div>` : '';
  }

  function renderFocusCard(v, state) {
    const ids = focusList(enabledRuleIds(state, v));
    const names = ruleNames(state, v);
    const f = getFocus();
    const tomorrow = addDays8(today8(), 1);
    const active = f && f.date === tomorrow ? f.ruleId : '';
    const picks = ids.map(id => `<button type="button" class="pi-pick${active === id ? ' on' : ''}"
      data-pi-focus="${esc(id)}" aria-pressed="${active === id ? 'true' : 'false'}">${esc(id)}${names[id] ? ' ' + esc(names[id]) : ''}</button>`).join('');
    return `<div class="pi-block card" id="pi-focus">
      <div class="pi-head">下一次复盘的结算项</div>
      <p class="pi-sub">只列你已勾的规则，按 T01→T13 编号排；默认不选，选一条只结算这一条。</p>
      ${picks ? `<div class="pi-picks">${picks}<button type="button" class="pi-pick ghost${active ? '' : ' on'}"
        data-pi-focus="" aria-pressed="${active ? 'false' : 'true'}">不选</button></div>`
        : '<p class="pi-empty">当前没有已勾选的规则。</p>'}
      <p class="pi-status">${f ? `已存：${esc(f.ruleId)} · ${fmtDate(f.date)}` : '尚未选择（默认不选）'}</p>
    </div>`;
  }

  function renderFocusSettlement(v) {
    const f = getFocus();
    if (!f) return '';
    if (f.date > today8()) return '';
    const s = settleFocus(v, f);
    if (!s) return '';
    const names = ruleNames(null, v);
    let body;
    if (!s.hasDate) body = `本次档案没有 ${fmtDate(s.date)} 的成交，本条未结算。`;
    else if (s.hit) body = `本次档案：当日触发 ${s.lines} 笔。另有 ${s.dayChecks} 条日级判定记录（只结算这一条）。`;
    else body = '本次档案：当日未触发该规则（只结算这一条）。';
    const stats = focusStats(s.ruleId);
    let statsLine;
    if (!stats) statsLine = '履约档案：索引未就绪（PanjiRecur.ruleStats 未返回）。';
    else {
      statsLine = `履约档案：全量触发 ${stats.triggerDays || 0} 天`
        + (stats.last ? ` · 最近 ${fmtDate(stats.last)}` : ' · 暂无触发记录')
        + (stats.sinceLast == null ? '' : ` · 距上次 ${stats.sinceLast} 天`);
    }
    track('focus_settle_view');
    return `<div class="pi-block card" id="pi-focus-settle">
      <div class="pi-head">结算项 · 只结算这一条</div>
      <p class="pi-line"><b>${esc(s.ruleId)}</b>${names[s.ruleId] ? ' ' + esc(names[s.ruleId]) : ''} · ${fmtDate(s.date)}</p>
      ${s.date !== s.focusDate ? `<p class="pi-sub">原定 ${fmtDate(s.focusDate)}，本次按 ${fmtDate(s.date)}（之后第一个有成交的复盘日）结算。</p>` : ''}
      <p class="pi-note">${esc(body)}</p>
      <p class="pi-sub">${esc(statsLine)}</p>
      <p class="pi-sub">口径：按成交日、按当日是否触发该规则；只结算这一条。</p>
      <button type="button" class="pi-mini ghost" data-pi-focus-clear>清除结算项</button>
    </div>`;
  }

  function renderReportTop(v) {
    const parts = [];
    if (flag('focus')) parts.push(renderFocusSettlement(v));
    if (flag('note')) {
      const n = getNote();
      if (n && n.text) {
        const today = today8(), y = addDays8(today, -1);
        if (n.date === today || n.date === y) {
          parts.push(`<div class="pi-block card" id="pi-note-echo">
            <div class="pi-head">盘前记录原文（${fmtDate(n.date)}）</div>
            <p class="pi-quote">『${esc(n.text)}』</p>
            <p class="pi-sub">原文回引，不解析、不判定。</p>
          </div>`);
        }
      }
    }
    return parts.length ? `<div class="pi-wrap" data-pi="report-top">${parts.join('')}</div>` : '';
  }

  function renderStopStatusCard(v) {
    const buys = (v.lines || []).filter(l => l && String(l.side || '').trim() === '买');
    if (!buys.length) return '';
    const rows = buys.map(l => {
      const st = stopStatus(l);
      return `<p class="pi-line">${esc(l.name || '')}${l.code ? '（' + esc(l.code) + '）' : ''} ${fmtPriceQty(l.price, l.qty)}
        · ${st.registered ? '已登记 ' + st.price : '未登记'}</p>`;
    }).join('');
    const reg = buys.filter(l => stopStatus(l).registered).length;
    return `<div class="pi-block card" id="pi-stop">
      <div class="pi-head">T12 止损预案登记（本次档案）</div>
      <p class="pi-sub">只看已登记/未登记，不判断价格高低。</p>
      ${rows}
      <p class="pi-status">本次 ${buys.length} 笔买入：已登记 ${reg} · 未登记 ${buys.length - reg}</p>
    </div>`;
  }

  function renderReasonOutcomeCard() {
    const ledger = storeGet(LEDGER_KEY, null);
    const trades = isObj(ledger) && Array.isArray(ledger.trades) ? ledger.trades : [];
    const rows = reasonOutcomes(trades, getReasonMap());
    const body = rows.length
      ? rows.map(x => `<p class="pi-line">${esc(x.tag)} · n=${x.n} 笔 · 中位持有 ${x.medHoldDays} 天
        · 已实现盈亏中位数 ¥${x.medPnl}</p>`).join('')
      : '<p class="pi-empty">账本内暂无可配对的平仓样本（n=0）。</p>';
    return `<div class="pi-block card" id="pi-reason-outcome">
      <div class="pi-head">买入理由 × 平仓结果（本机 FIFO）</div>
      <p class="pi-sub">固定顺序并列，不排序；只给 n 与中位数。算法：同标的最早买入先配对，卖出按时间先后消耗；中位数偶数取中间两笔均值；不含手续费（交割单未提供）。</p>
      ${body}
    </div>`;
  }

  function renderMoodStatsCard() {
    const r = recurApi();
    const end = today8();
    let stats = null;
    if (r) {
      let indexReady = false;
      try {
        const st = typeof r._state === 'function' ? r._state() : null;
        indexReady = !!(st && isObj(st.rules) && Object.keys(st.rules).length);
      } catch (e) { indexReady = false; }
      const vs = violationDays(MOOD_WINDOW, end);
      if (vs === null) indexReady = false;
      if (!indexReady && !(vs && vs.length)) {
        stats = null;
      } else {
        stats = moodGroupStats({
          moodMap: getMoodMap(),
          violationDays: vs || [],
          judgedDates: judgedDates(),
          windowDays: MOOD_WINDOW,
          end: end,
          minSample: MOOD_MIN_SAMPLE,
        });
      }
    }
    let body;
    if (!stats) body = '<p class="pi-empty">样本不足，暂不分组</p>';
    else if (!stats.eligible) body = '<p class="pi-empty">样本不足，暂不分组</p>';
    else {
      body = stats.shown.map(g => `<p class="pi-line">${esc(g.mood)} · n=${g.n} 天 · 越线 ${g.violatedDays} 天 · ${pct(g.rate)}</p>`).join('');
    }
    return `<div class="pi-block card" id="pi-mood-stats">
      <div class="pi-head">情绪 × 越线率</div>
      <p class="pi-sub">窗口 ${MOOD_WINDOW} 天；按成交日；分母=窗口内有复盘记录且记了情绪的天数；单组样本 <${MOOD_MIN_SAMPLE} 不展示。</p>
      ${body}
    </div>`;
  }

  function ackRule(l) {
    const ids = ruleIds(l && l.rule);
    return ids[0] || String((l && l.rule) || '').trim();
  }
  function renderAckBlock(l) {
    if (!l || String(l.flag || '') !== '违规') return '';
    const rule = ackRule(l);
    if (!rule) return '';
    const idx = String(l.idx == null ? 0 : l.idx);
    const rawKey = tk6({
      code: l.code, date: l.date, time: l.time, side: l.side,
      price: l.price, qty: l.qty, account: l.account,
    });
    ackCtx[idx] = { key: rawKey, rule: rule };
    const st = ackStatusKey(rawKey, rule);
    return `<div class="pi-ack" data-pi-ack="${idx}">
      <p class="pi-ack-q">这笔打算怎么改？<span class="pi-dim">写下来才算认下这次越线</span></p>
      <textarea class="pi-ack-input" rows="2" maxlength="${ACK_TEXT_MAX}" data-pi-ack-input
        placeholder="下次遇到同类情况，先做什么、不做什么（至少 ${ACK_MIN} 字）">${esc(st.text)}</textarea>
      <div class="pi-ack-foot">
        <button type="button" class="pi-mini" data-pi-ack-save>认下并保存</button>
        <span class="pi-ack-msg" data-pi-ack-msg>${st.done ? '已认下 · 同类已写 ' + st.n + ' 次' : '同类还没写过'}</span>
      </div>
    </div>`;
  }
  function renderLineExtra(l) {
    if (!l) return '';
    const parts = [];
    if (flag('stop') && String(l.side || '').trim() === '买') {
      const st = stopStatus(l);
      parts.push(`<p class="pi-line-extra">T12 止损预案：${st.registered ? '已登记 ' + st.price : '未登记'}<span class="pi-dim"> · 不判断价格高低</span></p>`);
    }
    const ack = renderAckBlock(l);
    if (ack) parts.push(ack);
    return parts.join('');
  }

  function renderReportBottom(v, state) {
    v = v || {};
    lastCtx = { v: v, state: state };
    const parts = [];
    if (flag('stop')) parts.push(renderStopStatusCard(v));
    if (flag('reason')) parts.push(renderReasonOutcomeCard());
    if (flag('mood')) parts.push(renderMoodStatsCard());
    if (flag('focus')) parts.push(renderFocusCard(v, state));
    return parts.length ? `<div class="pi-wrap" data-pi="report-bottom">${parts.join('')}</div>` : '';
  }

  // ---------- 9/10 确认后的登记弹层 ----------
  function pendingBuys(trades) {
    const rm = getReasonMap();
    const sm = getStopMap();
    const out = [];
    (Array.isArray(trades) ? trades : []).forEach(t => {
      if (!okFlag(t)) return;
      const key = tk6(t);
      const hasReason = Object.prototype.hasOwnProperty.call(rm, key);
      const hasStop = Object.prototype.hasOwnProperty.call(sm, key);
      if (hasReason && hasStop) return;
      out.push({ key: key, trade: t });
    });
    return out;
  }

  let modalItems = [];
  let modalErr = {};

  function fmtTrade(t) {
    return `买入 ${String(t.name || '')}${t.code ? '（' + t.code + '）' : ''} ${fmtPriceQty(t.price, t.qty)}`;
  }

  function renderBuyRow(item) {
    const k = item.key, t = item.trade;
    const sel = reasonGetKey(k);
    const st = stopStatusKey(k);
    const tags = REASON_TAGS.map(tag => `<button type="button" class="pi-tag${sel === tag ? ' on' : ''}"
      data-pi-tag="${esc(tag)}" data-pi-key="${esc(k)}" aria-pressed="${sel === tag ? 'true' : 'false'}">${esc(tag)}</button>`).join('');
    return `<div class="pi-buy" data-pi-buy="${esc(k)}">
      <p class="pi-buy-info">${esc(fmtTrade(t))}</p>
      <div class="pi-tags">${tags}
        <button type="button" class="pi-tag ghost" data-pi-tag-skip="${esc(k)}">不记</button></div>
      <div class="pi-stop-row">
        <input class="pi-stop-input" type="number" step="0.01" inputmode="decimal"
          data-pi-stop="${esc(k)}" value="${st.registered ? st.price : ''}" placeholder="止损价（可跳过）">
        <button type="button" class="pi-mini" data-pi-stop-save="${esc(k)}">登记</button>
        <button type="button" class="pi-mini ghost" data-pi-stop-skip="${esc(k)}">不登记</button>
      </div>
      <p class="pi-status">T12 · ${st.registered ? '已登记 ' + st.price : '未登记'}${modalErr[k] ? ' · ' + esc(modalErr[k]) : ''}</p>
    </div>`;
  }

  function renderIntentModal() {
    if (!modalItems.length) return '';
    const rows = modalItems.map(renderBuyRow).join('');
    return `<div class="pi-block">
      <div class="pi-head">本档新增 ${modalItems.length} 笔买入</div>
      <p class="pi-sub">买入理由 5 选 1，止损价可选填；都可以跳过，跳过不影响报告。</p>
      ${rows}
      <div class="pi-modal-foot">
        <button type="button" class="pi-mini" data-pi-modal-close>完成</button>
      </div>
    </div>`;
  }

  function openIntentModal(trades) {
    const doc = root.document;
    if (!doc || !doc.body) return false;
    modalItems = pendingBuys(trades);
    modalErr = {};
    if (!modalItems.length) return false;
    const mask = doc.createElement('div');
    mask.className = 'pi-mask';
    mask.id = 'pi-mask';
    mask.innerHTML = `<div class="pi-modal" id="pi-modal">${renderIntentModal()}</div>`;
    doc.body.appendChild(mask);
    return true;
  }
  function rerenderModal() {
    const doc = root.document;
    const box = doc && doc.getElementById('pi-modal');
    if (box) box.innerHTML = renderIntentModal();
  }
  function closeIntentModal() {
    const doc = root.document;
    const mask = doc && doc.getElementById('pi-mask');
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    modalItems = [];
    modalErr = {};
  }

  // ---------- 普通用户存档后的「记预案」可选步骤（20261107） ----------
  // 复用 guanzhu_stop_v1 / setStopKey，不新造字段；不依赖 reason/stop flag。
  // 「这次不记」写跳过标记（null），下次不再问；价格为空，判定上仍算「未记录」。
  // 只问当天成交：历史交割单导入不弹，避免一次铺几十张卡。
  const PLAN_COPY = {
    title: '这笔还没记预案',
    desc: '写一句你当时打算怎么做就走，不填也能存。',
    placeholder: '预案价位（你自己定）',
    skip: '这次不记',
  };

  let planItems = [];
  let planErr = {};

  function renderPlanCard(item) {
    const k = item.key, t = item.trade;
    return `<div class="pi-buy" data-pi-plan="${esc(k)}">
      <p class="pi-head">${esc(PLAN_COPY.title)}</p>
      <p class="pi-sub">${esc(PLAN_COPY.desc)}</p>
      <p class="pi-buy-info">${esc(fmtTrade(t))}</p>
      <div class="pi-stop-row">
        <input class="pi-stop-input" type="number" step="0.01" inputmode="decimal"
          data-pi-plan-input="${esc(k)}" placeholder="${esc(PLAN_COPY.placeholder)}">
        <button type="button" class="pi-mini" data-pi-plan-save="${esc(k)}">记下</button>
        <button type="button" class="pi-mini ghost" data-pi-plan-skip="${esc(k)}">${esc(PLAN_COPY.skip)}</button>
      </div>
      ${planErr[k] ? `<p class="pi-status">${esc(planErr[k])}</p>` : ''}
    </div>`;
  }
  function renderPlanModal() {
    if (!planItems.length) return '';
    return `<div class="pi-block">${planItems.map(renderPlanCard).join('')}</div>`;
  }
  function planPending(trades) {
    const today = today8();
    return (Array.isArray(trades) ? trades : [])
      .filter(t => t && okFlag(t))
      // 只问当天成交：历史交割单导入不弹，避免一次几十条。
      .filter(t => date8(t.date) === today)
      .map(t => ({ key: tk6(t), trade: t }))
      // 问过就不再打扰：已登记（正数）或已跳过（null）都算问过。
      .filter(x => !stopStatusKey(x.key).asked);
  }
  function openPlanModal(trades) {
    const doc = root.document;
    if (!doc || !doc.body) return false;
    planItems = planPending(trades);
    planErr = {};
    if (!planItems.length) return false;
    const mask = doc.createElement('div');
    mask.className = 'pi-mask';
    mask.id = 'pi-plan-mask';
    mask.innerHTML = `<div class="pi-modal" id="pi-plan-modal">${renderPlanModal()}</div>`;
    doc.body.appendChild(mask);
    return true;
  }
  function rerenderPlanModal() {
    const doc = root.document;
    if (!planItems.length) { closePlanModal(); return; }
    const box = doc && doc.getElementById('pi-plan-modal');
    if (box) box.innerHTML = renderPlanModal();
  }
  function closePlanModal() {
    const doc = root.document;
    const mask = doc && doc.getElementById('pi-plan-mask');
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    planItems = [];
    planErr = {};
  }

  function afterConfirm(ctx) {
    if (!ctx || ctx.isDemo) return '';
    const trades = ctx.trades || [];
    // 开发开闸时仍走原 9/10 弹层；普通用户默认走「记预案」可选步骤。
    if (flag('reason') || flag('stop')) { openIntentModal(trades); return ''; }
    openPlanModal(trades);
    return '';
  }

  // ---------- DOM 交互 ----------
  let lastCtx = { v: {}, state: null };

  function replaceOuter(id, html) {
    const doc = root.document;
    const el = doc && doc.getElementById(id);
    if (el) el.outerHTML = html;
  }

  function onClick(e) {
    const t = e && e.target;
    if (!t || typeof t.closest !== 'function') return;

    const ackSaveBtn = t.closest('[data-pi-ack-save]');
    if (ackSaveBtn) {
      const box = ackSaveBtn.closest('[data-pi-ack]');
      const idx = box ? String(box.getAttribute('data-pi-ack')) : '';
      const ctx = ackCtx[idx];
      const input = box && box.querySelector('[data-pi-ack-input]');
      const msg = box && box.querySelector('[data-pi-ack-msg]');
      if (ctx) {
        const res = ackSaveKey(ctx.key, ctx.rule, input ? input.value : '');
        if (msg) {
          msg.textContent = res.ok ? '已认下 · 同类已写 ' + res.n + ' 次'
            : (res.reason === 'short' ? '至少写 ' + ACK_MIN + ' 字' : '保存失败');
        }
      }
      return;
    }

    const clearBtn = t.closest('[data-pi-focus-clear]');
    if (clearBtn) {
      clearFocus();
      replaceOuter('pi-focus-settle', '');
      return;
    }

    const moodBtn = t.closest('[data-pi-mood]');
    if (moodBtn) {
      const res = moodSet(moodBtn.getAttribute('data-pi-mood'));
      if (res.ok || res.reason === 'already') replaceOuter('pi-mood-block', renderMoodCard());
      return;
    }

    const noteSave = t.closest('[data-pi-note-save]');
    if (noteSave) {
      const doc = root.document;
      const input = doc && doc.querySelector('[data-pi-note]');
      if (input) {
        setNote(input.value);
        track('note_set');
        replaceOuter('pi-note-block', renderNoteCard());
      }
      return;
    }

    const pick = t.closest('[data-pi-focus]');
    if (pick) {
      const id = pick.getAttribute('data-pi-focus');
      if (id) setFocus(id, addDays8(today8(), 1));
      else clearFocus();
      track('focus_set');
      replaceOuter('pi-focus', renderFocusCard(lastCtx.v, lastCtx.state));
      return;
    }

    const tagBtn = t.closest('[data-pi-tag]');
    if (tagBtn) {
      const key = tagBtn.getAttribute('data-pi-key');
      const tag = tagBtn.getAttribute('data-pi-tag');
      const r = reasonSetKey(key, tag);
      delete modalErr[key];
      if (r.ok) rerenderModal();
      return;
    }

    const tagSkip = t.closest('[data-pi-tag-skip]');
    if (tagSkip) {
      reasonSetKey(tagSkip.getAttribute('data-pi-tag-skip'), '');
      rerenderModal();
      return;
    }

    const stopSave = t.closest('[data-pi-stop-save]');
    if (stopSave) {
      const key = stopSave.getAttribute('data-pi-stop-save');
      const row = stopSave.closest('[data-pi-buy]');
      const input = row && row.querySelector('[data-pi-stop]');
      const r = setStopKey(key, input ? input.value : '');
      if (!r.ok) modalErr[key] = '填一个大于 0 的价格';
      else delete modalErr[key];
      rerenderModal();
      return;
    }

    const stopSkip = t.closest('[data-pi-stop-skip]');
    if (stopSkip) {
      setStopKey(stopSkip.getAttribute('data-pi-stop-skip'), null);
      rerenderModal();
      return;
    }

    const planSave = t.closest('[data-pi-plan-save]');
    if (planSave) {
      const key = planSave.getAttribute('data-pi-plan-save');
      const row = planSave.closest('[data-pi-plan]');
      const input = row && row.querySelector('[data-pi-plan-input]');
      const r = setStopKey(key, input ? input.value : '');
      if (!r.ok) { planErr[key] = '填一个大于 0 的价格'; rerenderPlanModal(); return; }
      delete planErr[key];
      planItems = planItems.filter(x => x.key !== key);
      rerenderPlanModal();
      return;
    }

    const planSkip = t.closest('[data-pi-plan-skip]');
    if (planSkip) {
      const key = planSkip.getAttribute('data-pi-plan-skip');
      // 记跳过标记（null）但不算登记：下次不再问，判定上仍是「未记录」。
      setStopKey(key, null);
      delete planErr[key];
      planItems = planItems.filter(x => x.key !== key);
      rerenderPlanModal();
      return;
    }

    if (t.id === 'pi-plan-mask') { closePlanModal(); return; }

    const closeBtn = t.closest('[data-pi-modal-close]');
    if (closeBtn || (t.id === 'pi-mask')) {
      closeIntentModal();
    }
  }

  function onInput(e) {
    if (e && e.isComposing) return;   // 中文输入法拼写中不截断
    const t = e && e.target;
    if (!t || !t.matches || !t.matches('[data-pi-note]')) return;
    const v = clampNote(t.value);
    if (t.value !== v) t.value = v;
    const doc = root.document;
    const cnt = doc && doc.querySelector('[data-pi-note-count]');
    if (cnt) cnt.textContent = `${Array.from(v).length}/${NOTE_MAX}`;
  }

  // 首页首屏：app.js 只在 go('#scr-home') 时刷新；首次打开补一次（不覆盖别人内容）
  function initHomeExt() {
    const doc = root.document;
    if (!doc || !root.PanjiExt || typeof root.PanjiExt.run !== 'function') return;
    const he = doc.getElementById('home-ext');
    if (!he || he.innerHTML.trim()) return;
    he.innerHTML = root.PanjiExt.run('homeTop');
  }

  let registered = false;
  function registerHooks() {
    if (registered) return;
    const ext = root.PanjiExt;
    if (!ext || !Array.isArray(ext.reportBottom)) return;
    registered = true;
    ext.reportBottom.push((v, state) => { try { return renderReportBottom(v, state); } catch (e) { return ''; } });
    ext.reportTop.push((v) => { try { return renderReportTop(v); } catch (e) { return ''; } });
    ext.lineExtra.push((l) => { try { return renderLineExtra(l); } catch (e) { return ''; } });
    ext.homeTop.push(() => { try { return renderHomeTop(); } catch (e) { return ''; } });
    ext.afterConfirm.push((ctx) => { try { return afterConfirm(ctx); } catch (e) { return ''; } });
  }

  registerHooks();
  if (root.document) {
    root.document.addEventListener('click', onClick);
    root.document.addEventListener('input', onInput);
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', initHomeExt);
    } else if (typeof root.setTimeout === 'function') {
      root.setTimeout(initHomeExt, 0);
    }
  }

  // ---------- 测试注入与导出 ----------
  function configure(opts) {
    opts = opts || {};
    if ('storage' in opts) adapter = opts.storage || null;
    if ('flags' in opts) flagsOverride = opts.flags == null ? null : opts.flags;
    if ('recur' in opts) recurOverride = opts.recur || null;
    if ('collection' in opts) collOverride = opts.collection || null;
    return api;
  }

  const api = {
    KEYS: KEYS,
    NOTE_MAX: NOTE_MAX,
    REASON_TAGS: REASON_TAGS,
    MOODS: MOODS,
    MOOD_MIN_SAMPLE: MOOD_MIN_SAMPLE,
    MOOD_WINDOW: MOOD_WINDOW,
    configure: configure,
    date8: date8,
    time6: time6,
    today8: today8,
    addDays8: addDays8,
    daysBetween: daysBetween,
    fmtDate: fmtDate,
    tk6: tk6,
    median: median,
    esc: esc,
    // 8
    clampNote: clampNote,
    getNote: getNote,
    setNote: setNote,
    // 7
    focusList: focusList,
    enabledRuleIds: enabledRuleIds,
    getFocus: getFocus,
    setFocus: setFocus,
    clearFocus: clearFocus,
    settleFocus: settleFocus,
    focusStats: focusStats,
    // 9
    reasonGetKey: reasonGetKey,
    reasonGet: reasonGet,
    reasonSetKey: reasonSetKey,
    reasonSet: reasonSet,
    fifoMatches: fifoMatches,
    reasonOutcomes: reasonOutcomes,
    pendingBuys: pendingBuys,
    // 10
    stopStatusKey: stopStatusKey,
    stopStatus: stopStatus,
    setStopKey: setStopKey,
    setStop: setStop,
    // 12
    ACK_MIN: ACK_MIN,
    ackHash: ackHash,
    ackStatusKey: ackStatusKey,
    ackSaveKey: ackSaveKey,
    onAck: onAck,
    // 11
    moodGet: moodGet,
    moodSet: moodSet,
    moodGroupStats: moodGroupStats,
    judgedDates: judgedDates,
    violationDays: violationDays,
    // 渲染
    renderHomeTop: renderHomeTop,
    renderReportTop: renderReportTop,
    renderReportBottom: renderReportBottom,
    renderLineExtra: renderLineExtra,
    renderIntentModal: renderIntentModal,
    // 20261107 普通用户「记预案」步骤
    PLAN_COPY: PLAN_COPY,
    planPending: planPending,
    renderPlanModal: renderPlanModal,
    openPlanModal: openPlanModal,
  };
  return api;
});
