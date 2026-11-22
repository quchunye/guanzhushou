// features/upload.js —— 批次 C：12 10 秒回传 / 13 午间快检 / 14 缺口补录 / 15 重复导入 / 16 导入历史
//
// 边界（docs/30功能_分批施工_20261031.md §3）：
//  - 只往批次 0 的 PanjiExt 钩子注册；不改 app.js / index.html / ledger.js；
//  - feature flag `upload` 默认关：关着时本文件不注册任何钩子、不接管文件输入；
//  - 浏览器挂 window.PanjiUpload = { handle(files) }；Node 导出纯函数给测试直接调用。
//
// 口径：
//  - 13 的“今日累计”一律从账本（已按五要素去重）重新取，不看本批 verdict，避免同一笔算两次；
//  - 13/14/16 只陈述事实（覆盖区间、笔数、缺口日期），不写祈使句、不写“该不该买”。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PanjiUploadCore = api;
    try { api.boot(); } catch (e) { /* 功能失败不能影响主流程 */ }
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // FX-3：键统一取自 PanjiStore.KEYS（store.js 已登记 19 条）；无 store 环境回落同值 fallback
  const Store = (function () {
    try { if (root && root.PanjiStore) return root.PanjiStore; } catch (e) { /* 继续 */ }
    try { if (typeof require === 'function') return require('../store.js'); } catch (e) { /* 继续 */ }
    return null;
  })();
  function keyOf(name, fallback) { return (Store && Store.KEYS && Store.KEYS[name]) || fallback; }
  function storeRaw(key) {
    if (Store && typeof Store.getRaw === 'function') return Store.getRaw(key);
    const s = root && root.localStorage;
    return s ? s.getItem(key) : null;
  }

  const LAYOUT_KEY = keyOf('uploadLayout', 'guanzhu_upload_layout_v1'); // 版式记忆（C 批 12）
  // UP-1b：日历按年查表。新增年份 = 放 trading_calendar_<year>.json + 在 CAL_KNOWN_YEARS 登记一行，不改代码。
  // 未登记/未收录的年份只按周一至周五判断，并在复核页显式提示，不静默当普通工作日。
  const CAL_PREFIX = 'trading_calendar_';
  const CAL_KNOWN_YEARS = [2026, 2027];
  const MAX_FILES = 6;       // 多图队列一次最多 6 张
  const MAX_IMPORTS = 200;   // 与 ledger.js 的上限一致
  const MAX_GAPS = 5;

  const LAYOUT_LABELS = {
    guangda: '光大对账单（一笔两行）',
    card: '券商 APP 卡片式',
    side_cells: '逐单元格（中邮等）',
    vertical: '竖排逐格',
    horizontal: '横排一行一笔',
  };

  const S = {
    booted: false,
    busy: false,
    pasteConsent: { privacy: false, agreement: false },
    lastLayout: null,
    dupNotice: null,
    midday: null,
    calendar: null,
    calendarPromise: null,
    calYears: {},          // { '2026': 日历对象 | null }
    calYearPromises: {},
    clock: null,           // 可注入的“当前时刻”来源；缺省用真实时钟
    gapTracked: false,
    batchFromChange: null,
    cycle: { viewAt: null, ocrStartAt: null, reportAt: null },
  };

  /* ================= 基础归一化 ================= */

  function nowMs() {
    try {
      if (root.performance && typeof root.performance.now === 'function') return root.performance.now();
    } catch (e) { /* 非浏览器 */ }
    return Date.now();
  }

  function d8(v) {
    if (v instanceof Date) {
      if (!isFinite(v.getTime())) return '';
      return `${v.getFullYear()}${pad2(v.getMonth() + 1)}${pad2(v.getDate())}`;
    }
    const s = String(v == null ? '' : v).replace(/[^\d]/g, '');
    if (s.length === 8) return s;
    if (s.length === 6) return '20' + s;
    return '';
  }

  function d10(v) {
    const s = d8(v);
    return s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // UP-1b：日期推断一律按 Asia/Shanghai（UTC+8，中国无夏令时）计算，
  // 不依赖运行环境的本地时区；now 可传 Date / 毫秒时间戳 / 缺省=当前时刻。
  function cstParts(now) {
    let ms;
    if (now instanceof Date) ms = now.getTime();
    else if (typeof now === 'number' && isFinite(now)) ms = now;
    else ms = Date.now();
    if (!isFinite(ms)) ms = Date.now();
    const t = new Date(ms + 8 * 3600 * 1000);
    const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1, da = t.getUTCDate();
    const h = t.getUTCHours(), mi = t.getUTCMinutes();
    return {
      y, mo, da, h, mi,
      day8: `${y}${pad2(mo)}${pad2(da)}`,
      hm: `${pad2(h)}:${pad2(mi)}`,
      mins: h * 60 + mi,
    };
  }

  function currentNow() {
    try {
      if (S.clock) { const v = S.clock(); if (v != null) return v; }
    } catch (e) { /* 注入时钟异常时回落真实时钟 */ }
    return new Date();
  }

  function today8(date) {
    return d8(date) || cstParts().day8;
  }

  function time6(v) {
    const s = String(v == null ? '' : v).replace(/[^\d]/g, '');
    if (!s) return '';
    return s.padEnd(6, '0').slice(0, 6);
  }

  function timeHM(v) {
    const s = time6(v);
    return s.length === 6 ? `${s.slice(0, 2)}:${s.slice(2, 4)}` : '';
  }

  // 成交时刻折算成分钟数；缺时间/非法时间返回 -1（用来逐笔判断，不做整批连坐）
  function timeMins(v) {
    const s = time6(v);
    if (s.length !== 6) return -1;
    const h = +s.slice(0, 2), mi = +s.slice(2, 4), se = +s.slice(4, 6);
    if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && se >= 0 && se <= 59)) return -1;
    return h * 60 + mi;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  function fmtAt(at) {
    const d = new Date(String(at || ''));
    if (!isFinite(d.getTime())) return String(at || '').slice(0, 16);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // 账本里的时间可能是 HHMMSS 纯数字，也可能带冒号；统一成五要素键
  function tradeKey(t) {
    try {
      if (root.Ledger && typeof root.Ledger.tradeKey === 'function') return root.Ledger.tradeKey(t);
    } catch (e) { /* 落回本地实现 */ }
    t = t || {};
    const id = String(t.code || t.name || '').trim();
    const price = isFinite(+t.price) && +t.price > 0 ? (+t.price).toFixed(3) : '';
    const qty = isFinite(+t.qty) && +t.qty > 0 ? String(Math.round(+t.qty)) : '';
    return [d8(t.date), time6(t.time), id, t.side || '', price, qty].join('|');
  }

  function cmpTrade(a, b) {
    const da = d8(a && a.date), db = d8(b && b.date);
    if (da !== db) return da < db ? -1 : 1;
    const ta = time6(a && a.time), tb = time6(b && b.time);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return 0;
  }

  /* ================= 13 午间快检（纯函数） ================= */

  // 今日全部成交：按成交日筛，再用五要素去重（★ 不能把同一笔算两次）
  function todayTrades(ledger, date) {
    const day = today8(date);
    const seen = Object.create(null);
    const out = [];
    ((ledger && ledger.trades) || []).forEach((t) => {
      if (!t || d8(t.date) !== day) return;
      const k = tradeKey(t);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(t);
    });
    return out.sort(cmpTrade);
  }

  // 当天是否第二次上传：今日账本里存在“不是本次导入”的成交
  function isSecondUploadToday(ledger, importId, date) {
    const day = today8(date);
    const own = String(importId || '');
    return todayTrades(ledger, day).some((t) => String((t && t.importId) || '') !== own);
  }

  // “截至 11:30：第 4 笔买入，超过你定的 3 笔”——只陈述，不做建议
  function buildMiddayStatement(opts) {
    opts = opts || {};
    const trades = Array.isArray(opts.trades) ? opts.trades : [];
    const buys = trades.filter((t) => t && t.side === '买');
    const max = +opts.maxBuys;
    const buyCount = opts.buyCount != null ? +opts.buyCount : buys.length;
    if (!(buyCount > 0) || !(max > 0) || buyCount <= max) return null;
    const last = buys.reduce((a, b) => (time6(b && b.time) >= time6(a && a.time) ? b : a), buys[0]);
    const hm = last ? timeHM(last.time) : '';
    const head = hm ? `截至 ${hm}` : '今日';
    return {
      text: `${head}：第 ${buyCount} 笔买入，超过你定的 ${max} 笔`,
      buys: buyCount,
      sells: trades.filter((t) => t && t.side === '卖').length,
      maxBuys: max,
      lastTime: hm,
    };
  }

  function ruleParam(cfg, id, key, def) {
    const rules = (cfg && Array.isArray(cfg.rules)) ? cfg.rules : [];
    const r = rules.find((x) => x && x.templateId === id);
    if (!r || !r.params) return def;
    const v = +r.params[key];
    return isFinite(v) ? v : def;
  }

  /* ================= 15 重复导入（纯函数） ================= */

  function repeatNotice(r) {
    const added = +((r && r.added) || 0);
    const dup = +((r && r.dup) || 0);
    if (added > 0) {
      return dup > 0 ? `本次新增 ${added} 笔，另有 ${dup} 笔与账本重叠、已去重` : null;
    }
    return `这批已在账本，本次未新增${dup ? `（${dup} 笔与账本重叠）` : ''}`;
  }

  /* ================= 16 导入历史（纯函数） ================= */

  function importsRows(ledger, limit) {
    const max = limit == null ? MAX_IMPORTS : Math.max(0, +limit || 0);
    const list = (ledger && Array.isArray(ledger.imports)) ? ledger.imports : [];
    return list.slice(-max).map((it) => {
      it = it || {};
      return {
        at: String(it.at || ''),
        timeLabel: fmtAt(it.at),
        imported: +it.imported || 0,
        added: +it.added || 0,
        dup: +it.dup || 0,
        from: d10(it.coverageFrom),
        to: d10(it.coverageTo),
      };
    }).reverse(); // 最新在前
  }

  function impItemHtml(r) {
    const range = r.from || r.to ? `${r.from || '—'} ~ ${r.to || '—'}` : '—';
    return `<li><span class="c-imp-at">${esc(r.timeLabel)}</span>`
      + `<span class="c-imp-num">新增 <b>${r.added}</b> · 重复 ${r.dup}</span>`
      + `<span class="c-imp-cov">${esc(range)}</span></li>`;
  }

  // limit=null → 全部（默认，保持既有调用/测试口径）；limit=30 → 首屏只渲染前 30 条
  function importsSectionFromRows(rows, limit) {
    if (!rows.length) {
      return '<section class="c-card c-imports"><h3>导入历史</h3>'
        + '<p class="c-empty">还没有导入记录——上传第一张交割单并确认后，这里按时间列出每次新增、重复与覆盖区间。</p></section>';
    }
    const shown = limit == null ? rows.length : Math.min(rows.length, Math.max(0, +limit || 0));
    const items = rows.slice(0, shown).map(impItemHtml).join('');
    return `<section class="c-card c-imports" id="c-imports"><h3>导入历史 `
      + `<small>共 ${rows.length} 次${rows.length >= MAX_IMPORTS ? '（最多保留 200 条）' : ''}</small></h3>`
      + '<p class="c-note">口径：每次确认算一次导入；新增=本次真正并入账本的笔数，重复=与账本重叠而跳过的笔数。</p>'
      + `<ol class="c-imp-list">${items}</ol></section>`;
  }

  function importsSectionHtml(ledger, limit) {
    return importsSectionFromRows(importsRows(ledger, MAX_IMPORTS), limit);
  }

  // FX-3：200 条一次性挂 DOM 是「导入历史打开」的唯一热点 →
  // 首屏 30 条立刻给，其余按 60 条/空闲帧补全；数据与列不变，只是拆批次上屏。
  const FIRST_IMPORTS = 30;
  const IMPORT_CHUNK = 60;
  let importsFillToken = 0;

  function idleRun(fn) {
    try {
      if (root && typeof root.requestIdleCallback === 'function') {
        return root.requestIdleCallback(fn, { timeout: 900 });
      }
    } catch (e) { /* 继续 */ }
    const setT = (root && root.setTimeout) || setTimeout;
    return setT(fn, 0);
  }

  function fillImportsRemainder(rows, shown) {
    if (shown >= rows.length) return;
    const token = ++importsFillToken;
    let i = shown;
    const step = () => {
      if (token !== importsFillToken) return;          // 规则页已重渲染，放弃这一批
      const sec = el('c-imports');
      const list = sec && sec.querySelector('.c-imp-list');
      if (!list) return;
      const batch = document.createElement('div');
      batch.innerHTML = rows.slice(i, i + IMPORT_CHUNK).map(impItemHtml).join('');
      while (batch.firstChild) list.appendChild(batch.firstChild);
      i += IMPORT_CHUNK;
      if (i < rows.length) idleRun(step);
    };
    idleRun(step);
  }

  /* ================= 14 缺口补录（纯函数） ================= */

  function findGaps(ledger, calendar, limit) {
    const max = limit == null ? MAX_GAPS : Math.max(0, +limit || 0);
    const trades = (ledger && Array.isArray(ledger.trades)) ? ledger.trades : [];
    const seen = Object.create(null);
    let from = '', to = '';
    trades.forEach((t) => {
      const d = d8(t && t.date);
      if (!d) return;
      seen[d] = 1;
      if (!from || d < from) from = d;
      if (!to || d > to) to = d;
    });
    const days = (calendar && Array.isArray(calendar.tradingDays)) ? calendar.tradingDays : [];
    if (!from || !to || !days.length) return { from: '', to: '', total: 0, gaps: [] };
    const missing = [];
    days.forEach((x) => {
      const d = d8(x);
      if (!d || d < from || d > to || seen[d]) return;
      missing.push(d);
    });
    missing.sort();
    return {
      from: d10(from),
      to: d10(to),
      total: missing.length,
      gaps: missing.slice(0, max).map((d) => ({
        date: d10(d),
        label: d10(d).slice(5),
        hint: `补 ${d10(d).slice(5)} 的交割单截图`,
      })),
    };
  }

  function gapSectionHtml(result) {
    if (!result || !result.total || !result.gaps.length) return '';
    const items = result.gaps.map((g) =>
      `<li><b>${esc(g.label)}</b><span>${esc(g.hint)}</span></li>`).join('');
    const more = result.total > result.gaps.length
      ? `<p class="c-note">共 ${result.total} 个交易日没有记录，先列前 ${result.gaps.length} 天。</p>`
      : `<p class="c-note">共 ${result.total} 个交易日没有记录。</p>`;
    return `<section class="c-card c-gap" id="c-gap"><h3>账本缺口 `
      + `<small>${esc(result.from)} ~ ${esc(result.to)}</small></h3>`
      + `<ul class="c-gap-list">${items}</ul>${more}`
      + `<p class="c-note">口径：A股交易日历（静态 ${esc(calYearsLabel(result.from, result.to))}）与账本成交日比对；只提示缺哪一天，不判断该不该交易。</p></section>`;
  }

  // 缺口口径里的年份标签：单年保持“静态 2026”，跨年显示区间
  function calYearsLabel(from8, to8) {
    const a = d8(from8) || '', b = d8(to8) || '';
    const y1 = a.slice(0, 4), y2 = b.slice(0, 4);
    if (!y1 && !y2) return CAL_KNOWN_YEARS.join('/');
    if (y1 && y2 && y1 !== y2) return `${y1}–${y2}`;
    return y1 || y2;
  }

  /* ================= 12 计时 / 版式记忆 / 微信降级（纯函数） ================= */

  function timingSummary(cycle) {
    const c = cycle || {};
    const viewAt = c.viewAt, ocrAt = c.ocrStartAt, doneAt = c.reportAt;
    return {
      view_to_ocr_ms: (viewAt && ocrAt) ? Math.round(ocrAt - viewAt) : null,
      ocr_ms: (ocrAt && doneAt) ? Math.round(doneAt - ocrAt) : null,
      total_ms: (viewAt && doneAt) ? Math.round(doneAt - viewAt) : null,
    };
  }

  function layoutLabel(layout) {
    return LAYOUT_LABELS[String(layout || '')] || '';
  }

  function getLayoutMemory(storage) {
    try {
      const s = storage || (root.localStorage || null);
      if (!s) return null;
      const raw = s.getItem(LAYOUT_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.layout) return null;
      return { layout: String(o.layout), at: String(o.at || '') };
    } catch (e) { return null; }
  }

  function setLayoutMemory(layout, storage, now) {
    if (!layout) return { ok: false, error: 'empty' };
    try {
      const s = storage || (root.localStorage || null);
      if (!s) return { ok: false, error: 'no_storage' };
      const value = { layout: String(layout), at: (now || new Date()).toISOString() };
      s.setItem(LAYOUT_KEY, JSON.stringify(value));
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: 'write_failed' };
    }
  }

  function isWeChatUA(ua) {
    return /MicroMessenger/i.test(String(ua || ''));
  }

  // 微信内置浏览器常禁用 navigator.clipboard.read，必须走 paste 事件 + contenteditable
  function shouldUseClipboardRead(ua, hasApi) {
    if (isWeChatUA(ua)) return false;
    return !!hasApi;
  }

  function pasteFallbackText(ua) {
    if (isWeChatUA(ua)) {
      return '微信内置浏览器读不了剪贴板：请点虚线框，长按选择「粘贴」；如果长按没有「粘贴」，回到首页点「上传交割单截图」。';
    }
    return '没有读到图片：可以改用「上传交割单截图」，或把截图复制后再粘贴一次。';
  }

  function imageFilesFromClipboard(clipboardData) {
    const out = [];
    const cd = clipboardData || {};
    let items = [];
    try { items = Array.prototype.slice.call(cd.items || []); } catch (e) { items = []; }
    items.forEach((it) => {
      if (!it || it.kind !== 'file') return;
      if (!/^image\//i.test(String(it.type || ''))) return;
      let f = null;
      try { f = it.getAsFile ? it.getAsFile() : null; } catch (e) { f = null; }
      if (f) out.push(f);
    });
    if (!out.length) {
      let files = [];
      try { files = Array.prototype.slice.call(cd.files || []); } catch (e) { files = []; }
      files.forEach((f) => { if (f && /^image\//i.test(String(f.type || ''))) out.push(f); });
    }
    return out;
  }

  function mergeOcrResults(list) {
    const arr = (list || []).filter(Boolean);
    const trades = [];
    let scrubbed = 0;
    arr.forEach((d) => {
      (Array.isArray(d.trades) ? d.trades : []).forEach((t) => trades.push(t));
      scrubbed += +((d.meta && d.meta.scrubbed_lines) || 0);
    });
    if (arr.length > 1) trades.sort(cmpTrade);
    const timeMissing = arr.length > 0 && arr.every((d) => !!(d.meta && d.meta.time_missing));
    const layout = String((arr[0] && arr[0].meta && arr[0].meta.layout) || '');
    return {
      ok: true,
      mode: String((arr[0] && arr[0].mode) || ''),
      trades,
      meta: {
        trade_count: trades.length,
        scrubbed_lines: scrubbed,
        time_missing: timeMissing,
        layout,
      },
    };
  }

  /* ================= UP-1 日期推断 + 日期选择器（纯函数） =================
     20261104 真实版式实测：
     - 历史成交（东海卡片）：锚点行 "买 20261102 14：36：38"，表内有完整日期；
     - 当日成交：每笔只有 "买 09：35：57"，整张表没有日期列，也没有年份。
     口径：能推断就写清依据并标「推断」；推不出就留空提示选择，绝不默认今天。 */

  function isValidYmd(y, m, d) {
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  // 只有 月-日：补当前年；候选日期比今天晚 183 天以上（如 1 月看到 12-31）→ 回退上一年
  function resolveMonthDay(md, now) {
    const m = String(md || '').match(/(\d{1,2})[-/／月.](\d{1,2})/);
    if (!m) return { ok: false, date: '', reason: '' };
    const mo = +m[1], da = +m[2];
    const base = cstParts(now);
    const y0 = base.y;
    if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31) || !isValidYmd(y0, mo, da)) {
      return { ok: false, date: '', reason: '' };
    }
    const todayUtc = Date.UTC(y0, base.mo - 1, base.da);
    const candUtc = Date.UTC(y0, mo - 1, da);
    const aheadDays = Math.round((candUtc - todayUtc) / 86400000);
    let y = y0;
    let reason = `表里只有 ${pad2(mo)}-${pad2(da)}；按当前年份补全为 ${y0}-${pad2(mo)}-${pad2(da)}。`;
    if (aheadDays > 183) {
      y = y0 - 1;
      reason = `表里只有 ${pad2(mo)}-${pad2(da)}；今天 ${d10(base.day8)}，该日期更接近上一年，补全为 ${y}-${pad2(mo)}-${pad2(da)}。`;
    }
    return { ok: true, date: `${y}-${pad2(mo)}-${pad2(da)}`, reason };
  }

  // 三种常见写法归一：2026-11-04 / 20261104 / 11-04（11-04 走补年规则）
  function parseDateInput(value, now) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { ok: false, date: '', reason: '日期是空的' };
    const n = raw.replace(/[年月日./]/g, '-').replace(/\s+/g, '');
    let m = n.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const y = +m[1], mo = +m[2], da = +m[3];
      if (!isValidYmd(y, mo, da)) return { ok: false, date: '', reason: '这个日期不存在' };
      return { ok: true, date: `${y}-${pad2(mo)}-${pad2(da)}`, reason: '' };
    }
    m = n.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) {
      const y = +m[1], mo = +m[2], da = +m[3];
      if (!isValidYmd(y, mo, da)) return { ok: false, date: '', reason: '这个日期不存在' };
      return { ok: true, date: `${y}-${pad2(mo)}-${pad2(da)}`, reason: '' };
    }
    m = n.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) return resolveMonthDay(`${m[1]}-${m[2]}`, now);
    return { ok: false, date: '', reason: '只认 2026-11-04 / 20261104 / 11-04 三种写法' };
  }

  function calendarSet(calendar) {
    if (!calendar || !Array.isArray(calendar.tradingDays) || !calendar.tradingDays.length) return null;
    const set = Object.create(null);
    calendar.tradingDays.forEach((x) => { const d = d8(x); if (d) set[d] = 1; });
    return { set };
  }

  // 该年是否有已收录的日历（多年度 bundle 用 years 字段；单年对象用 year 字段）
  function calHasYear(calendar, year) {
    if (!calendar) return false;
    const y = String(year || '');
    if (!y) return false;
    if (calendar.years) return !!calendar.years[y];
    return String(calendar.year == null ? '' : calendar.year) === y;
  }

  // 缺年降级说明：covered=false 时给出可展示的原文，绝不静默当普通工作日
  function calCoverage(calendar, year) {
    const y = String(year || '');
    if (!y) return { covered: false, note: '' };
    if (calHasYear(calendar, y)) return { covered: true, note: '' };
    const noYears = !calendar || (calendar.years && !Object.keys(calendar.years).length);
    if (noYears) return { covered: false, note: '交易日历未加载，仅按周一至周五判断。' };
    const known = (Array.isArray(calendar.knownYears) && calendar.knownYears.length)
      ? calendar.knownYears.slice() : CAL_KNOWN_YEARS.slice();
    return {
      covered: false,
      note: `${y} 年节假日安排尚未收录（已收录：${known.join('、')}），仅按周一至周五判断。`,
    };
  }

  function weekdayOf(day8v) {
    const s = d8(day8v);
    if (!s) return -1;
    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getDay();
  }

  // 周末一律休市（调休上班的周末交易所也休市）；未收录年份回落“周一到周五”，
  // 但调用方（推断依据 / 复核面板）必须通过 calCoverage 把降级说明显式展示出来。
  function isTradingDay(day8v, calendar) {
    const s = d8(day8v);
    if (!s) return false;
    const w = weekdayOf(s);
    if (w === 0 || w === 6) return false;
    if (!calHasYear(calendar, s.slice(0, 4))) return true; // 缺年：仅周一~五
    const cs = calendarSet(calendar);
    return !!(cs && cs.set[s]);
  }

  function addDays8(day8v, delta) {
    const s = d8(day8v);
    if (!s) return '';
    const dt = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) + (+delta || 0));
    return d8(dt);
  }

  function prevTradingDay(day8v, calendar) {
    let d = addDays8(day8v, -1);
    for (let i = 0; i < 30 && d; i++) {
      if (isTradingDay(d, calendar)) return d;
      d = addDays8(d, -1);
    }
    return '';
  }

  function lastTradingOnOrBefore(day8v, calendar) {
    const s = d8(day8v);
    return (s && isTradingDay(s, calendar)) ? s : prevTradingDay(s, calendar);
  }

  // 当日成交表的日期：交易日 09:30 后（含收盘后）→ 当天；开盘前/周末/节假日 → 最近交易日
  // 时刻一律按 Asia/Shanghai 换算，避免设备时区不同导致推断漂移；缺年时在依据里显式降级
  function inferSessionDate(now, calendar) {
    const base = cstParts(now);
    const day = base.day8;
    const mins = base.mins;
    const hm = base.hm;
    const td = isTradingDay(day, calendar);
    const cov = calCoverage(calendar, day.slice(0, 4));
    const tail = cov.covered ? '' : ` ${cov.note}`;
    if (td && mins >= 570) {
      return {
        date: d10(day),
        reason: `当日成交表没有日期列；${d10(day)} 是交易日，${hm} ${mins >= 900 ? '已收盘' : '已开盘'}，按当天推断。${tail}`,
      };
    }
    const prev = prevTradingDay(day, calendar);
    if (!prev) {
      return { date: '', reason: `当日成交表没有日期列，交易日历里也没找到可回退的交易日。${tail}` };
    }
    const reason = td
      ? `当日成交表没有日期列；现在是 ${d10(day)} ${hm}（Asia/Shanghai），开盘前，表对应的仍是上一个交易日 ${d10(prev)}。${tail}`
      : `当日成交表没有日期列；今天 ${d10(day)} 不是交易日，回退到最近交易日 ${d10(prev)}。${tail}`;
    return { date: d10(prev), reason };
  }

  // 当日成交表逐笔推断：按“这一笔自己的成交时间”判断属于哪个交易日（UTC 换成北京时间）
  // 缺时间的笔直接返回空，不做“默认今天”的兜底
  function inferTradeDate(timeStr, now, calendar) {
    const base = cstParts(now);
    const mins = timeMins(timeStr);
    if (mins < 0) return { date: '', reason: '' };
    const hm = timeHM(timeStr);
    const day = base.day8;
    const nowhm = base.hm;
    const td = isTradingDay(day, calendar);
    const cov = calCoverage(calendar, day.slice(0, 4));
    const tail = cov.covered ? '' : ` ${cov.note}`;
    if (td && base.mins >= 570 && mins <= base.mins) {
      return {
        date: d10(day),
        reason: `当日成交表没有日期列；成交时间 ${hm}，现在 ${nowhm}（Asia/Shanghai）${base.mins >= 900 ? '已收盘' : '已开盘'}，按当天 ${d10(day)} 推断。${tail}`,
      };
    }
    const prev = prevTradingDay(day, calendar);
    if (!prev) {
      return { date: '', reason: `当日成交表没有日期列，交易日历里也没找到可回退的交易日。${tail}` };
    }
    const why = !td
      ? `今天 ${d10(day)} 不是交易日`
      : (base.mins < 570
        ? `现在是 ${d10(day)} ${nowhm}（Asia/Shanghai），开盘前`
        : `成交时间 ${hm} 晚于当前时刻 ${nowhm}`);
    return { date: d10(prev), reason: `当日成交表没有日期列；${why}，该笔对应上一个交易日 ${d10(prev)}。${tail}` };
  }

  // 当日成交表的三态文案：数字与笔数全部来自实际解析结果，不写死
  function dayNoteText(o) {
    o = o || {};
    const total = +o.total || 0;
    if (total <= 0) return '';
    const withTime = +o.withTime || 0;
    const dates = (Array.isArray(o.dates) ? o.dates : []).filter((v, i, a) => v && a.indexOf(v) === i);
    const missingIdx = (Array.isArray(o.missingIdx) ? o.missingIdx : []).filter((n) => +n > 0);
    const filled = +o.filled || 0;
    if (withTime <= 0) {
      return '当日成交表没有日期列，也没有可推断的成交时间；请手动选择日期。';
    }
    const when = dates.length > 1
      ? `分别推断为 ${dates.join('、')}（跨开盘/午夜，按笔保留）`
      : `推断为 ${dates[0] || o.mainDate || ''}`;
    if (withTime >= total && !missingIdx.length && !filled) {
      return `当日成交表没有日期列；按成交时间${when}。`;
    }
    const head = `当日成交表没有日期列；本批 ${total} 笔中 ${withTime} 笔可按成交时间${when}`;
    if (missingIdx.length) {
      return `${head}，第 ${missingIdx.join('、')} 笔缺成交时间，需要手选。`;
    }
    return `${head}，其余 ${filled || (total - withTime)} 笔已手动选择日期。`;
  }

  function needsFixOf(t) {
    return !t || !t.name || !d8(t.date) || !(+t.qty > 0) || !(+t.price > 0);
  }

  // 日期来源：table=表里写的；inferred=推出来的；manual=用户选的；missing=推不出
  function dateSourceOf(t) {
    if (!t) return 'missing';
    if (t.dateSource) return t.dateSource;
    return d8(t.date) ? 'table' : 'missing';
  }

  // 给一批 OCR 结果补日期，并返回整批的日期口径；不静默假定
  function applyDateInference(data, opts) {
    const trades = (data && Array.isArray(data.trades)) ? data.trades : [];
    if (!trades.length) return summarizeDates(trades);
    const now = (opts && opts.now) || currentNow();
    const calendar = (opts && opts.calendar) || null;

    const undated = [];
    trades.forEach((t) => {
      if (d8(t.date)) { if (!t.dateSource) t.dateSource = 'table'; }
      else undated.push(t);
    });

    // 历史成交只有 月-日：补年份
    undated.forEach((t) => {
      if (!t.datePart || d8(t.date)) return;
      const r = resolveMonthDay(t.datePart, now);
      if (!r.ok) return;
      t.date = r.date;
      t.dateSource = 'inferred';
      t.dateReason = r.reason;
      if (t.low) t.low.date = false;
      t.needs_fix = needsFixOf(t);
    });

    // 整张表都没有日期列 → 当日成交表：有时间的那几笔各自推断；缺时间的那笔保持 missing
    // （不做整批连坐，也绝不给缺时间的笔兜底成今天）
    if (trades.every((t) => !d8(t.date))) {
      const session = inferSessionDate(now, calendar);
      trades.forEach((t) => {
        t.dateDayTable = true;
        const mins = timeMins(t.time);
        t.dateTimeMissing = mins < 0;
        if (mins < 0) return;
        const inf = inferTradeDate(t.time, now, calendar);
        if (!inf.date) { t.dateReason = session.reason; return; }
        t.date = inf.date;
        t.dateSource = 'inferred';
        t.dateReason = inf.reason;
        if (t.low) t.low.date = false;
        t.needs_fix = needsFixOf(t);
      });
      // 缺时间的笔留会话级依据（供复核页说明），日期一律留空
      trades.forEach((t) => {
        if (d8(t.date) || t.dateReason) return;
        t.dateReason = session.reason;
      });
    }

    // 仍无日期的：明确标记未识别，留空让用户选
    trades.forEach((t) => {
      if (d8(t.date)) return;
      t.date = '';
      t.dateSource = 'missing';
      if (t.low) t.low.date = true;
      t.needs_fix = needsFixOf(t);
    });
    return summarizeDates(trades);
  }

  function summarizeDates(trades) {
    const list = Array.isArray(trades) ? trades : [];
    const dated = list.filter((t) => d8(t && t.date));
    const missing = list.filter((t) => !d8(t && t.date));
    const inferred = dated.filter((t) => dateSourceOf(t) === 'inferred');
    const manual = dated.filter((t) => dateSourceOf(t) === 'manual');
    const table = dated.filter((t) => dateSourceOf(t) === 'table');
    const sameDay = dated.length > 0 && dated.every((t) => d8(t.date) === d8(dated[0].date));
    const date = sameDay ? d10(dated[0].date) : '';
    // 多数笔的推断日：跨午夜/开盘前后各笔不同时，面板仍以多数日为准（各笔不强行统一）
    const dateCounts = Object.create(null);
    let mainDate = '';
    dated.forEach((t) => {
      const d = d10(t.date);
      dateCounts[d] = (dateCounts[d] || 0) + 1;
      if (!mainDate || dateCounts[d] > dateCounts[mainDate]) mainDate = d;
    });
    let kind = 'mixed';
    if (!list.length) kind = 'none';
    else if (missing.length === list.length) kind = 'missing';
    else if (!missing.length && !inferred.length) kind = 'table';
    else if (!missing.length) kind = 'inferred';
    const hit = list.find((t) => t && t.dateSource === 'inferred' && t.dateReason);
    const reason = String((hit && hit.dateReason) || (list.find((t) => t && t.dateReason) || {}).dateReason || '');
    // 缺的是“成交时间没认出来”的笔（当日成交表）→ 改日期只补这几笔，不动已推断的
    const timeMissing = missing.filter((t) => t && t.dateTimeMissing);
    let scope = 'per';
    if (missing.length === list.length) scope = 'batch';
    else if (!missing.length && dated.length > 0 && sameDay) scope = 'batch';
    else if (missing.length && timeMissing.length === missing.length && dated.length > 0 && sameDay) scope = 'missing';
    return {
      count: list.length,
      dated: dated.length,
      missing: missing.length,
      inferred: inferred.length,
      table: table.length,
      manual: manual.length,
      sameDay,
      date,
      mainDate,
      kind,
      reason,
      // batch=改一处应用全批；missing=只补缺成交时间的笔；per=只改当前笔（历史各笔不同）
      scope,
    };
  }

  // 改日期：batch=整批同一日期；missing=只补缺成交时间的那几笔；per=只改当前笔
  function applyTradeDate(trades, idx, date, scope) {
    const list = Array.isArray(trades) ? trades : [];
    const r = parseDateInput(date, currentNow());
    if (!r.ok) return 0;
    let targets;
    if (scope === 'batch') targets = list;
    else if (scope === 'missing') targets = list.filter((t) => t && (!d8(t.date) || dateSourceOf(t) === 'missing'));
    else targets = [list[idx]].filter(Boolean);
    targets.forEach((t) => {
      t.date = r.date;
      t.dateSource = 'manual';
      t.dateReason = '';
      if (t.low) t.low.date = false;
      t.needs_fix = needsFixOf(t);
    });
    // COLL-1b：用户确认写入日期才算一次「日期纠正」；图鉴不在场 / 存储被禁都不影响上传
    if (targets.length) {
      try { if (typeof PanjiCollection !== 'undefined' && PanjiCollection && typeof PanjiCollection.record === 'function') PanjiCollection.record('date_fix'); } catch (e) { /* 静默 */ }
    }
    return targets.length;
  }

  function lastFriday8(day8v) {
    const s = d8(day8v);
    if (!s) return '';
    let back = (weekdayOf(s) - 5 + 7) % 7;
    if (!back) back = 7; // 今天就是周五 → 上一个周五
    return addDays8(s, -back);
  }

  function dateChips(now, calendar) {
    const t = cstParts(now).day8;
    return [
      { key: 'today', label: '今天', date: d10(t) },
      { key: 'yesterday', label: '昨天', date: d10(addDays8(t, -1)) },
      { key: 'lastFriday', label: '上周五', date: d10(lastFriday8(t)) },
      { key: 'lastTrading', label: '最近交易日', date: d10(lastTradingOnOrBefore(t, calendar)) },
    ];
  }

  function dateReviewHtml(stateArg, opts) {
    const trades = (stateArg && Array.isArray(stateArg.trades)) ? stateArg.trades : [];
    const sum = summarizeDates(trades);
    if (!sum.count) return '';
    const now = (opts && opts.now) || currentNow();
    const cal = (opts && opts.calendar) || S.calendar;
    const calNote = coverageNoteHtml(cal, trades, now);
    const badge = sum.missing > 0
      ? `<span class="c-badge warn">${sum.missing === sum.count ? '未识别' : '还有 ' + sum.missing + ' 笔未识别'}</span>`
      : (sum.inferred > 0 ? '<span class="c-badge inf">推断</span>'
        : (sum.manual > 0 ? '<span class="c-badge">手动</span>' : '<span class="c-badge">表内</span>'));
    const head = sum.missing === sum.count
      ? '日期未识别，请选择'
      : (sum.date ? `日期：${sum.date}` : `有 ${sum.missing} 笔日期未识别`);
    // 当日成交表：按实际有/无成交时间的笔数说实情（数字全部来自解析结果）
    const dayTable = trades.some((t) => t && t.dateDayTable);
    let dayNote = '';
    if (dayTable) {
      let withTime = 0;
      let filled = 0;
      const missingIdx = [];
      trades.forEach((t, i) => {
        if (timeMins(t && t.time) >= 0) { withTime++; return; }
        if (d8(t && t.date)) filled++; else missingIdx.push(i + 1);
      });
      const dates = trades
        .filter((t) => dateSourceOf(t) === 'inferred' && d8(t.date))
        .map((t) => d10(t.date));
      dayNote = dayNoteText({ total: trades.length, withTime, missingIdx, filled, dates, mainDate: sum.mainDate });
    }
    const reasonTxt = dayNote || sum.reason;
    const note = reasonTxt ? `<p class="c-note">依据：${esc(reasonTxt)}</p>` : '';
    const keptDates = (sum.mainDate && !sum.sameDay && sum.inferred > 0)
      ? (function () {
        const ds = trades.filter((t) => dateSourceOf(t) === 'inferred' && d8(t.date)).map((t) => d10(t.date));
        return ds.filter((v, i, a) => a.indexOf(v) === i).join('、');
      })()
      : '';
    let scopeNote;
    if (sum.scope === 'missing') {
      scopeNote = `<p class="c-note">点日期只补「缺成交时间」的 ${sum.missing} 笔，已按时间推断的 ${sum.dated} 笔不动。</p>`;
    } else if (sum.scope === 'per') {
      scopeNote = keptDates
        ? `<p class="c-note">本批各笔推断日不同（跨开盘/午夜），已按笔保留：${esc(keptDates)}；点每笔「改」单独选。</p>`
        : '<p class="c-note">本批各笔日期不同（历史成交）：点每笔「改」，在日期里单独选，只改当前笔。</p>';
    } else {
      scopeNote = `<p class="c-note">改这里的日期会应用到本批 ${sum.count} 笔。</p>`;
    }
    if (sum.missing === sum.count) {
      return `<section class="c-card c-date" id="c-date"><h3>成交日期 ${badge}</h3>`
        + `<p class="c-date-main warn">${esc(head)}</p>${note}${calNote}`
        + '<p class="c-note">任何一笔都不会默认成今天。</p>'
        + datePickControls(sum, now, cal) + '</section>';
    }
    return `<section class="c-card c-date" id="c-date"><h3>成交日期 ${badge}</h3>`
      + `<p class="c-date-main">${esc(head)}</p>${note}${calNote}${scopeNote}`
      + ((sum.scope === 'batch' || sum.scope === 'missing') ? datePickControls(sum, now, cal) : '')
      + '</section>';
  }

  // 缺年降级说明：把“未收录年份只按周一~五”的判断摆到复核页，不静默
  function coverageNoteHtml(calendar, trades, now) {
    const years = [];
    const addYear = (y) => { if (y && years.indexOf(y) < 0) years.push(y); };
    addYear(String(cstParts(now).y)); // 推断口径看的是“上传当天”所在年
    (Array.isArray(trades) ? trades : []).forEach((t) => {
      const d = d8(t && t.date);
      if (d) addYear(d.slice(0, 4));
    });
    const notes = years
      .map((y) => calCoverage(calendar, y))
      .filter((c) => !c.covered && c.note)
      .map((c) => c.note);
    if (!notes.length) return '';
    const uniq = notes.filter((n, i) => notes.indexOf(n) === i);
    return `<p class="c-note">${esc(uniq.join(' '))}</p>`;
  }

  function dateReviewTop(stateArg) {
    const st = (stateArg && Array.isArray(stateArg.trades)) ? stateArg : { trades: currentTrades() };
    // 记住这一屏的联动范围：app.js 的 input 监听会先改单笔，change 时再算 scope 已经晚了
    try { S.reviewScope = summarizeDates(st.trades).scope; } catch (e) { S.reviewScope = ''; }
    return dateReviewHtml(st);
  }

  function datePickControls(sum, now, cal) {
    const chips = dateChips(now, cal).map((c) =>
      `<button type="button" class="c-date-chip" data-date-quick="${esc(c.key)}" data-date="${esc(c.date)}">${esc(c.label)}</button>`).join('');
    const val = sum.mainDate || sum.date || '';
    const label = sum.scope === 'missing' ? '缺时间笔的日期' : '本批日期';
    return `<div class="c-date-chips">${chips}</div>`
      + `<label class="c-date-field"><span>${label}</span>`
      + `<input class="c-date-pick" id="c-date-pick" type="date" value="${esc(val)}" aria-label="${label}">`
      + '</label>'
      + '<p class="c-note">直接点日历选，不用手打；手写时 2026-11-04 / 20261104 / 11-04 都认。</p>';
  }

  /* ================= 浏览器：粘贴面板与钩子 ================= */

  function track(name, data) {
    // 注意：t_view/t_ocr_start/t_report_done/upload_paste/upload_multi/upload_time_ms/
    // gap_view/dup_warn/import_history_open 需要 server/server.js 的 TRACK_EVENTS 放行；
    // server.js 归批次 E，本批不改，合并时补一行白名单。
    try {
      if (typeof root.PanjiTrack === 'function') root.PanjiTrack(name, data);
    } catch (e) { /* 埋点失败静默 */ }
  }

  function userAgent() {
    try { return String((root.navigator && root.navigator.userAgent) || ''); } catch (e) { return ''; }
  }

  function hasClipboardRead() {
    try {
      return !!(root.navigator && root.navigator.clipboard && typeof root.navigator.clipboard.read === 'function');
    } catch (e) { return false; }
  }

  function el(id) {
    try { return root.document ? root.document.getElementById(id) : null; } catch (e) { return null; }
  }

  function setPasteStatus(msg) {
    const s = el('c-paste-status');
    if (s) s.textContent = msg;
  }

  function setScanStatus(txt) {
    const s = el('scan-status');
    if (s) s.textContent = txt;
  }

  // app.js 是普通脚本，go/toast/state 在全局词法环境；调用前做存在性判断，缺失就静默降级
  function appGo(id) {
    try { if (typeof go === 'function') { go(id); return true; } } catch (e) { /* 静默 */ }
    return false;
  }

  function appToast(msg, warn) {
    try { if (typeof toast === 'function') { toast(msg, warn); return true; } } catch (e) { /* 静默 */ }
    return false;
  }

  function syncAppFile(file) {
    try {
      if (typeof state === 'object' && state) {
        state.file = file;
        state.isDemo = false;
        state.expanded = new Set();
        state.derived = false;
        if (state.imageUrl && String(state.imageUrl).indexOf('blob:') === 0) {
          try { URL.revokeObjectURL(state.imageUrl); } catch (e) { /* 静默 */ }
        }
        state.imageUrl = URL.createObjectURL(file);
      }
    } catch (e) { /* app 内部状态不可写时保持原样 */ }
  }

  function readLedger() {
    try {
      const raw = storeRaw(keyOf('ledger', 'guanzhu_ledger'));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function readRulesConfig() {
    try {
      const raw = storeRaw(keyOf('rules', 'guanzhu_rules_v1'));
      const cfg = raw ? JSON.parse(raw) : null;
      return cfg && Array.isArray(cfg.rules) && cfg.rules.length ? cfg : null;
    } catch (e) { return null; }
  }

  function rememberLayout(layout) {
    if (!layout) return;
    S.lastLayout = { layout: String(layout), at: new Date().toISOString() };
    // FX-4：实参位置不取 root.localStorage（storage 被禁时 getter 抛 SecurityError，
    // 会绕过 setLayoutMemory 自带的 try/catch，卡死上传链路）。交给函数内部惰性求值 + 静默降级。
    setLayoutMemory(layout);
    renderPasteMemo();
  }

  // 同意文案同源：粘贴卡直接克隆主弹窗的同意块与去向句，不另写一份
  function consentBlocksHtml() {
    const doc = root && root.document;
    if (!doc || !doc.querySelector) return '';
    let out = '';
    ['privacy', 'agreement'].forEach((k) => {
      const src = doc.querySelector('#c-' + k);
      if (!src) return;
      const node = src.cloneNode(true);
      node.removeAttribute('id');
      node.className = 'consent' + (S.pasteConsent[k] ? ' on' : '');
      node.setAttribute('data-paste-consent', k);
      out += node.outerHTML;
    });
    return out;
  }

  function consentDestHtml() {
    const doc = root && root.document;
    const src = doc && doc.querySelector ? doc.querySelector('#consent-dest') : null;
    if (!src) return '';
    return `<p class="c-dest">去向：<span>${src.innerHTML}</span></p>`;
  }

  function pasteConsentOk() { return !!(S.pasteConsent.privacy && S.pasteConsent.agreement); }

  function pastePanelHtml() {
    const wx = isWeChatUA(userAgent());
    const memo = S.lastLayout || getLayoutMemory();
    const label = memo ? layoutLabel(memo.layout) : '';
    const memoHtml = label
      ? `<p class="c-memo">上次识别：<b>${esc(label)}</b> · 已记住版式，这次直接传（识别仍由服务端自动判断）</p>`
      : '<p class="c-memo">第一次用：截图直接贴进来就行。</p>';
    const readBtn = shouldUseClipboardRead(userAgent(), hasClipboardRead())
      ? '<button class="c-link" id="c-paste-read" type="button">从剪贴板读取</button>'
      : '';
    return `<section class="c-card c-paste" id="c-paste">`
      + '<h3>粘贴截图，10 秒回传</h3>'
      + '<p class="c-note">可一次粘贴/选择多张，按顺序逐张识别后再合并成一次复核。</p>'
      + '<div class="c-paste-box" id="c-paste-box" contenteditable="true" role="textbox" '
      + 'aria-label="粘贴交割单截图" data-placeholder="点这里，然后长按选择「粘贴」"></div>'
      + '<div class="c-consents">' + consentBlocksHtml() + '</div>'
      + consentDestHtml()
      + `<p class="c-status" id="c-paste-status"></p>`
      + '<div class="c-paste-foot">'
      + readBtn
      + '<button class="c-link" id="c-paste-upload" type="button">改用「上传交割单截图」</button>'
      + '</div>'
      + memoHtml
      + (wx ? `<p class="c-degrade">${esc(pasteFallbackText(userAgent()))}</p>` : '')
      + '</section>';
  }

  function renderPasteMemo() {
    try {
      const box = el('c-paste');
      if (!box) return;
      const old = box.querySelector('.c-memo');
      if (!old || !S.lastLayout) return;
      const label = layoutLabel(S.lastLayout.layout);
      if (label) old.innerHTML = `上次识别：<b>${esc(label)}</b> · 已记住版式，这次直接传（识别仍由服务端自动判断）`;
    } catch (e) { /* 静默 */ }
  }

  // 多图队列：串行识别、前端按序合并，最后只 ingest 一次
  async function handle(input) {
    if (S.busy) { setPasteStatus('上一批还在识别，稍等一下'); return; }
    if (!pasteConsentOk()) { setPasteStatus('先勾选下面两项同意，再上传识别'); return; }
    const files = resolveFiles(input);
    if (!files || !files.length) return;
    if (!root.PanjiOcr || typeof root.PanjiOcr.recognize !== 'function') {
      appToast('识别组件未加载，请刷新页面重试', true);
      return;
    }
    if (files.length > MAX_FILES) {
      files.length = MAX_FILES;
      appToast(`一次最多 ${MAX_FILES} 张，已取前 ${MAX_FILES} 张`);
    }
    S.busy = true;
    S.cycle.ocrStartAt = nowMs();
    S.cycle.reportAt = null;
    track('t_ocr_start');
    if (files.length > 1) track('upload_multi', { n: files.length });
    try {
      appGo('#scr-scan');
      syncAppFile(files[0]);
      setScanStatus(files.length > 1 ? `识别中… 1/${files.length}` : '压缩上传中…');
      // 日期推断要用交易日历；本地静态文件，取不到也不阻塞（回落“周一到周五”）
      try { await loadCalendar(); } catch (e) { /* 静默 */ }
      const outs = [];
      const failed = [];
      let lastErr = null;
      for (let i = 0; i < files.length; i++) {
        if (files.length > 1) setScanStatus(`识别中… ${i + 1}/${files.length}`);
        try {
          const d = await root.PanjiOcr.recognize(files[i]);
          if (d && Array.isArray(d.trades) && d.trades.length) {
            try { applyDateInference(d, { now: currentNow(), calendar: S.calendar }); } catch (e) { /* 推断失败不拦识别 */ }
            outs.push(d);
          } else failed.push(i + 1);
        } catch (e) {
          failed.push(i + 1);
          lastErr = e;
        }
      }
      if (!outs.length) {
        throw new Error(files.length > 1
          ? '这几张都没认出成交记录——换更清晰的截图，或在复核页手动补录'
          : ((lastErr && lastErr.message) || '识别失败'));
      }
      const merged = mergeOcrResults(outs);
      if (failed.length) appToast(`第 ${failed.join('、')} 张没认出成交记录，已跳过`, true);
      rememberLayout(merged.meta.layout);
      await root.PanjiOcr.ingest(merged);
      // app.js 的 autoDerive 会用第一笔日期静默补齐缺失日期；这里把明确“未识别”的笔还原成空
      finalizeUnresolvedDates();
    } catch (err) {
      const msg = (err && err.message) || '识别失败';
      setScanStatus(msg);
      appToast(msg, true);
      // 空态不能只闪一条 toast：回首页后留一句能照着做的话，不然用户只看到「回去了」
      const note = el('home-note');
      if (note) {
        note.hidden = false;
        const known = /换一张|补录/.test(msg);
        let text = msg + (known ? '' : ' → 换一张更清晰的截图再试。');
        if (!/[。！？]$/.test(text.trim())) text += '。';
        note.textContent = text + '也可以点「先看示例」，不用传就能看完一整份报告。';
      }
      appGo('#scr-home');
    } finally {
      S.busy = false;
    }
  }

  // 多选：app.js 只把 files[0] 交给 handle；document 捕获阶段先记下完整文件列表
  function resolveFiles(input) {
    const arr = Array.prototype.slice.call(input || []);
    const batch = S.batchFromChange;
    S.batchFromChange = null;
    if (batch && batch.length && arr.length && batch[0] === arr[0]) return batch.slice();
    return arr;
  }

  function closestBox(target) {
    try { return target && target.closest ? target.closest('#c-paste-box') : null; } catch (e) { return null; }
  }

  function makeFile(blob, name) {
    try { return new File([blob], name, { type: (blob && blob.type) || 'image/png' }); } catch (e) {
      try { blob.name = name; } catch (e2) { /* 静默 */ }
      return blob;
    }
  }

  // 微信可能把图片直接塞进 contenteditable（<img src="data:...">），没有 clipboardData.items
  async function harvestPastedImages(box) {
    if (!box) return;
    const imgs = Array.prototype.slice.call(box.querySelectorAll('img'));
    if (!imgs.length) { setPasteStatus(pasteFallbackText(userAgent())); return; }
    if (!pasteConsentOk()) {
      box.innerHTML = '';
      setPasteStatus('先勾选下面两项同意，再粘贴');
      return;
    }
    const files = [];
    for (const img of imgs) {
      const src = String(img.src || '');
      if (!src) continue;
      try {
        const r = await fetch(src);
        const b = await r.blob();
        if (!b || !/^image\//i.test(String(b.type || 'image/png'))) continue;
        files.push(makeFile(b, `paste_${files.length + 1}.png`));
      } catch (e) { /* 单张失败跳过 */ }
    }
    box.innerHTML = '';
    if (!files.length) { setPasteStatus(pasteFallbackText(userAgent())); return; }
    track('upload_paste', { n: files.length });
    handle(files);
  }

  function onPaste(e) {
    if (S.busy) return;
    const box = closestBox(e.target);
    const files = imageFilesFromClipboard(e.clipboardData);
    if (files.length) {
      if (e.preventDefault) e.preventDefault();
      if (box) box.innerHTML = '';
      if (!pasteConsentOk()) { setPasteStatus('先勾选下面两项同意，再粘贴'); return; }
      track('upload_paste', { n: files.length });
      handle(files);
      return;
    }
    if (!box) return;
    // 先让浏览器把图插进 contenteditable，再从 <img> 收割（微信内置浏览器的兜底路径）
    setTimeout(() => { harvestPastedImages(box); }, 30);
  }

  async function readClipboard() {
    const ua = userAgent();
    if (!shouldUseClipboardRead(ua, hasClipboardRead())) {
      setPasteStatus(pasteFallbackText(ua));
      return;
    }
    if (!pasteConsentOk()) { setPasteStatus('先勾选下面两项同意，再读取剪贴板'); return; }
    try {
      const items = await root.navigator.clipboard.read();
      const files = [];
      for (const item of items) {
        const type = (item.types || []).find((x) => /^image\//i.test(x));
        if (!type) continue;
        const b = await item.getType(type);
        files.push(makeFile(b, `clip_${files.length + 1}.png`));
      }
      if (!files.length) { setPasteStatus(pasteFallbackText(ua)); return; }
      track('upload_paste', { n: files.length, via: 'clipboard_read' });
      handle(files);
    } catch (e) {
      setPasteStatus(pasteFallbackText(ua));
    }
  }

  function onDocumentClick(e) {
    const t = e.target;
    if (!t) return;
    // 粘贴卡的同意块（克隆自主弹窗）：点链接只跳转，不切换勾选
    const anchor = t.closest && t.closest('a');
    const pc = (!anchor && t.closest) ? t.closest('[data-paste-consent]') : null;
    if (pc) {
      const k = pc.getAttribute('data-paste-consent');
      if (k === 'privacy' || k === 'agreement') {
        S.pasteConsent[k] = !S.pasteConsent[k];
        pc.classList.toggle('on', S.pasteConsent[k]);
      }
      return;
    }
    const chip = (t.closest && t.closest('[data-date-quick]'));
    if (chip) { applyQuickDate(chip); return; }
    if (!t.id) return;
    if (t.id === 'c-paste-read') { readClipboard(); return; }
    if (t.id === 'c-paste-upload') {
      const btn = el('btn-upload');
      if (btn && btn.click) btn.click();
    }
  }

  function onDocumentChange(e) {
    const t = e.target;
    if (!t) return;
    if (t.id === 'file-input') {
      try { S.batchFromChange = Array.prototype.slice.call(t.files || []); } catch (err) { S.batchFromChange = null; }
      return;
    }
    // UP-1：本批日期控件 / 每笔日期控件（app.js 已先把值写进 state.trades，这里做归一与联动）
    if (t.id === 'c-date-pick') {
      applyBatchDateValue(t.value, S.reviewScope === 'missing' ? 'missing' : 'batch');
      return;
    }
    if (t.getAttribute && t.getAttribute('data-k') === 'date') {
      const i = +t.getAttribute('data-i');
      const trades = currentTrades();
      const r = parseDateInput(t.value, currentNow());
      if (!r.ok) {
        const trade = trades[i];
        if (trade) { trade.date = ''; if (trade.low) trade.low.date = true; trade.needs_fix = needsFixOf(trade); }
        appToast('日期没认出来，请重新选择', true);
        appRenderReview();
        return;
      }
      // 用“这一屏渲染时的范围”，避免 app.js 已先改单笔导致误判为 per
      const scope = S.reviewScope === 'batch' ? 'batch' : 'per';
      const n = applyTradeDate(trades, i, r.date, scope);
      if (n > 1) appToast(`已应用到本批 ${n} 笔`);
      appRenderReview();
    }
  }

  /* ---------- 13 服务端合并重判 ---------- */

  function usableForServer(t) {
    return t && ['买', '卖'].indexOf(t.side) >= 0
      && String(t.name || '').trim()
      && isFinite(+t.price) && +t.price > 0
      && isFinite(+t.qty) && Math.round(+t.qty) > 0;
  }

  function toServerTrade(t) {
    return {
      date: d10(t.date) || String(t.date || ''),
      time: timeHM(t.time),
      code: String(t.code || ''),
      name: String(t.name || ''),
      side: t.side === '卖' ? '卖' : '买',
      price: +t.price,
      qty: Math.round(+t.qty),
    };
  }

  function clientToken() {
    try {
      return storeRaw(keyOf('clientToken', 'guanzhu_client_token')) || '';
    } catch (e) { return ''; }
  }

  async function judgeToday(trades, cfg, caseId, maxBuys) {
    const local = buildMiddayStatement({ trades, maxBuys });
    const payload = {
      trades: trades.map(toServerTrade),
      case_no: ('MID' + String(caseId || '')).slice(0, 20),
      rules: cfg.rules,
      capital: cfg.capital != null ? cfg.capital : null,
    };
    try {
      const res = await fetch('/api/judge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-token': clientToken() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data || !data.ok) throw new Error((data && data.error) || 'judge_failed');
      const buys = (data.verdict && data.verdict.summary && +data.verdict.summary.buy_count) || local.buys;
      const statement = buildMiddayStatement({ trades, maxBuys, buyCount: buys });
      return {
        state: 'done',
        statement,
        buys,
        sells: local.sells,
        maxBuys,
        source: 'judge',
      };
    } catch (e) {
      return {
        state: 'done',
        statement: local,
        buys: local ? local.buys : 0,
        sells: local ? local.sells : 0,
        maxBuys,
        source: 'local',
      };
    }
  }

  function middayBodyHtml(data) {
    if (!data) return '';
    if (data.state === 'pending') {
      return '<p class="c-note">正在把今天全部成交与账本去重后重新判定…</p>';
    }
    const st = data.statement;
    if (!st) {
      const head = data.lastTime ? `截至 ${esc(data.lastTime)}` : '今日';
      return `<p class="c-midday-main">${head}：今日买入 ${data.buys} 笔，未超过你定的 ${data.maxBuys} 笔。</p>`;
    }
    const src = data.source === 'judge'
      ? '已把今日全部成交合并后重新判定'
      : '服务端重判未返回，以上按账本去重口径计数';
    return `<p class="c-midday-main">${esc(st.text)}</p>`
      + `<p class="c-note">今日账本去重后：买入 ${data.buys} 笔、卖出 ${data.sells} 笔；${esc(src)}。`
      + '口径：按成交日与账本去重；只陈述事实。</p>';
  }

  function middayHtml(data) {
    return '<section class="c-card c-midday" id="c-midday"><h3>今日累计（午间快检）</h3>'
      + `<div id="c-midday-body">${middayBodyHtml(data)}</div></section>`;
  }

  function renderMiddayNow() {
    const body = el('c-midday-body');
    if (!body) return;
    body.innerHTML = S.midday ? middayBodyHtml(S.midday) : '';
  }

  function onAfterIngest(p) {
    if (!p) return;
    S.dupNotice = repeatNotice(p);
    if (S.dupNotice) track('dup_warn', { added: p.added, dup: p.dup });
    S.midday = null;
    // 13 只判新增：本次没有新增就不必再发一次合并重判
    if (!(+p.added > 0)) return;

    const ledger = p.ledger || readLedger();
    const day = today8();
    if (!ledger || !isSecondUploadToday(ledger, p.caseNo, day)) return;
    const cfg = readRulesConfig();
    if (!cfg) return;
    const maxBuys = ruleParam(cfg, 'T06', 'maxBuys', 0);
    if (!(maxBuys > 0)) return;
    const trades = todayTrades(ledger, day).filter(usableForServer);
    if (!trades.length) return;
    const lastBuy = trades.filter((t) => t.side === '买').slice(-1)[0];
    const lastTime = lastBuy ? timeHM(lastBuy.time) : '';
    S.midday = { state: 'pending', buys: 0, sells: 0, maxBuys, source: 'judge', lastTime };
    judgeToday(trades, cfg, p.caseNo, maxBuys).then((r) => {
      S.midday = Object.assign({ lastTime }, r);
      renderMiddayNow();
    });
  }

  /* ---------- 14 日历加载与渲染 ---------- */

  function calendarUrl(year) {
    return CAL_PREFIX + String(year) + '.json';
  }

  // 单年加载：命中已登记年份才取文件；未登记年份直接返回 null（由 calCoverage 显式降级）
  function loadYearCalendar(year) {
    const y = +year;
    if (S.calYears[y] !== undefined) return Promise.resolve(S.calYears[y]);
    if (S.calYearPromises[y]) return S.calYearPromises[y];
    if (CAL_KNOWN_YEARS.indexOf(y) < 0 || typeof fetch !== 'function') {
      S.calYears[y] = null;
      return Promise.resolve(null);
    }
    const p = fetch(calendarUrl(y), { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => (o && Array.isArray(o.tradingDays) && o.tradingDays.length ? o : null))
      .catch(() => null)
      .then((o) => { S.calYears[y] = o; return o; });
    S.calYearPromises[y] = p;
    return p;
  }

  function makeCalendarBundle(map) {
    let days = [];
    Object.keys(map).forEach((y) => { days = days.concat(map[y].tradingDays || []); });
    return { years: map, knownYears: CAL_KNOWN_YEARS.slice(), tradingDays: days };
  }

  // 按年查表：默认加载所有已登记年份（2026 / 2027）；也可指定某一年
  function loadCalendar(year) {
    if (year == null && S.calendar) return Promise.resolve(S.calendar);
    if (year == null && S.calendarPromise) return S.calendarPromise;
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const years = year == null ? CAL_KNOWN_YEARS.slice() : [+year];
    const p = Promise.all(years.map(loadYearCalendar)).then((list) => {
      const map = {};
      years.forEach((y, i) => { if (list[i]) map[String(y)] = list[i]; });
      const bundle = makeCalendarBundle(map);
      if (year == null) S.calendar = bundle;
      return bundle;
    });
    if (year == null) S.calendarPromise = p;
    return p;
  }

  function fillGapDom() {
    const box = el('c-gap');
    if (!box) return;
    const ledger = readLedger();
    const result = ledger && S.calendar ? findGaps(ledger, S.calendar, MAX_GAPS) : null;
    if (!result || !result.total) { box.hidden = true; box.innerHTML = ''; return; }
    box.outerHTML = gapSectionHtml(result);
    if (!S.gapTracked) { S.gapTracked = true; track('gap_view', { total: result.total, shown: result.gaps.length }); }
  }

  function reportBottomHtml() {
    const ledger = readLedger();
    if (!ledger || !Array.isArray(ledger.trades) || !ledger.trades.length) return '';
    if (S.calendar) {
      const result = findGaps(ledger, S.calendar, MAX_GAPS);
      if (!result.total) return '';
      if (!S.gapTracked) { S.gapTracked = true; track('gap_view', { total: result.total, shown: result.gaps.length }); }
      return gapSectionHtml(result);
    }
    loadCalendar().then(fillGapDom);
    return '<div id="c-gap" class="c-gap-slot"></div>';
  }

  /* ---------- 钩子 ---------- */

  function reportTopHtml() {
    if (S.cycle.ocrStartAt && !S.cycle.reportAt) {
      S.cycle.reportAt = nowMs();
      track('t_report_done');
      track('upload_time_ms', timingSummary(S.cycle));
    }
    const parts = [];
    if (S.dupNotice) {
      parts.push(`<div class="c-card c-dup" role="status"><b>${esc(S.dupNotice)}</b>`
        + '<p class="c-note">口径：账本按日期+时间+标的+方向+价格+数量去重；重复的笔不会虚增统计。</p></div>');
    }
    if (S.midday) parts.push(middayHtml(S.midday));
    return parts.length ? `<div class="c-ext">${parts.join('')}</div>` : '';
  }

  function rulesBottomHtml() {
    const ledger = readLedger();
    const rows = importsRows(ledger, MAX_IMPORTS);
    if (rows.length) track('import_history_open', { n: rows.length });
    const shown = Math.min(rows.length, FIRST_IMPORTS);
    if (rows.length > shown) fillImportsRemainder(rows, shown);
    return importsSectionFromRows(rows, shown);
  }

  /* ---------- UP-1 浏览器：复核页日期控件 ---------- */

  function currentTrades() {
    try {
      if (typeof state === 'object' && state && Array.isArray(state.trades)) return state.trades;
    } catch (e) { /* 非浏览器或 app.js 未就绪 */ }
    return [];
  }

  function appRenderReview() {
    try {
      if (typeof renderReview === 'function') { renderReview(); return true; }
      if (root && typeof root.renderReview === 'function') { root.renderReview(); return true; }
    } catch (e) { /* 静默 */ }
    return false;
  }

  // app.js 的 autoDerive 会用第一笔日期静默补齐缺失日期；这里把“明确未识别”的笔还原成空
  function finalizeUnresolvedDates() {
    const trades = currentTrades();
    let changed = false;
    trades.forEach((t) => {
      if (!t || t.dateSource !== 'missing' || !d8(t.date)) return;
      t.date = '';
      if (t.low) t.low.date = true;
      t.needs_fix = needsFixOf(t);
      changed = true;
    });
    if (changed) appRenderReview();
    upgradeReviewDates();
  }

  function applyDateToTrades(date, idx, scope) {
    const trades = currentTrades();
    if (!trades.length) return 0;
    return applyTradeDate(trades, idx, date, scope);
  }

  function applyBatchDateValue(raw, scope) {
    const r = parseDateInput(raw, currentNow());
    if (!r.ok) { appToast('日期没认出来，请用日历重新选', true); appRenderReview(); return; }
    const sc = scope === 'missing' ? 'missing' : 'batch';
    const n = applyDateToTrades(r.date, 0, sc);
    if (n > 1 || sc === 'missing') appToast(sc === 'missing' ? `已补 ${n} 笔缺成交时间的日期` : `已应用到本批 ${n} 笔`);
    appRenderReview();
  }

  function applyQuickDate(chip) {
    const key = chip.getAttribute('data-date-quick');
    const t = cstParts(currentNow()).day8; // 与推断同一口径（可注入时钟），不看本机时区
    let date = '';
    if (key === 'today') date = d10(t);
    else if (key === 'yesterday') date = d10(addDays8(t, -1));
    else if (key === 'lastFriday') date = d10(lastFriday8(t));
    else date = d10(lastTradingOnOrBefore(t, S.calendar));
    if (!date) date = d10(t);
    applyBatchDateValue(date, S.reviewScope);
  }

  // 把 app.js 渲染的文本日期输入升级成原生日期控件（移动端自带滚轮日历）
  function upgradeReviewDates() {
    let list = null;
    try { list = el('trade-list'); } catch (e) { return; }
    if (!list) return;
    const trades = currentTrades();
    list.querySelectorAll('input[data-k="date"]').forEach((inp) => {
      if (inp.getAttribute('type') !== 'date') {
        inp.setAttribute('type', 'date');
        inp.setAttribute('placeholder', 'YYYY-MM-DD');
        inp.setAttribute('aria-label', '成交日期');
      }
      const i = +inp.getAttribute('data-i');
      const t = trades[i];
      const f = inp.closest ? inp.closest('.f') : null;
      const lab = f ? f.querySelector('label') : null;
      if (!lab) return;
      const src = t && t.dateSource === 'inferred' ? '推断'
        : (t && (t.dateSource === 'missing' || !d8(t.date))
          ? (t.dateTimeMissing ? '第 ' + (i + 1) + ' 笔缺成交时间，请选择' : '未识别，请选择')
          : '');
      const old = lab.querySelector('.c-date-src');
      if (!src) { if (old) old.parentNode.removeChild(old); return; }
      if (old) { old.textContent = src; return; }
      const badge = root.document.createElement('span');
      badge.className = 'c-date-src' + ((src.indexOf('未识') >= 0 || src.indexOf('缺成交时间') >= 0) ? ' warn' : '');
      badge.textContent = src;
      lab.appendChild(badge);
    });
  }

  function installDateObserver() {
    try {
      const list = el('trade-list');
      if (!list || !root.MutationObserver) return;
      if (S.dateObserver) S.dateObserver.disconnect();
      S.dateObserver = new root.MutationObserver(() => { upgradeReviewDates(); });
      // 只看复核列表的直接子节点替换；不去监听徽标自身的追加，避免自触发
      S.dateObserver.observe(list, { childList: true });
      upgradeReviewDates();
    } catch (e) { /* 静默 */ }
  }

  function boot() {
    if (S.booted) return;
    const enabled = (typeof root.PanjiFlag === 'function') ? root.PanjiFlag('upload') : false;
    if (!enabled) return;         // flag 默认关：不注册、不接管，保持基线行为
    if (!root.document) return;
    S.booted = true;
    S.cycle.viewAt = nowMs();
    S.lastLayout = getLayoutMemory();

    root.PanjiUpload = { handle };

    // <input type=file> 在 index.html 里没有 multiple，这里运行时补上，不改文件
    try {
      const fi = root.document.getElementById('file-input');
      if (fi) fi.multiple = true;
    } catch (e) { /* 静默 */ }

    const ext = root.PanjiExt;
    if (ext) {
      if (Array.isArray(ext.homeTop)) ext.homeTop.push(pastePanelHtml);
      if (Array.isArray(ext.reviewTop)) ext.reviewTop.push(dateReviewTop);
      if (Array.isArray(ext.reportTop)) ext.reportTop.push(reportTopHtml);
      if (Array.isArray(ext.reportBottom)) ext.reportBottom.push(reportBottomHtml);
      if (Array.isArray(ext.rulesBottom)) ext.rulesBottom.push(rulesBottomHtml);
      if (Array.isArray(ext.afterIngest)) ext.afterIngest.push(onAfterIngest);
    }

    root.document.addEventListener('paste', onPaste, true);
    root.document.addEventListener('click', onDocumentClick, true);
    root.document.addEventListener('change', onDocumentChange, true);

    // app.js 只在 go('#scr-home') 时刷新 homeTop；首次打开补渲染一次（不覆盖已有内容）
    const initHome = () => {
      track('t_view'); // 此时 app.js 已把 PanjiTrack 换成真 track，埋点不会丢
      installDateObserver();
      try {
        const he = el('home-ext');
        if (!he || String(he.innerHTML).trim()) return;
        if (root.PanjiExt && typeof root.PanjiExt.run === 'function') he.innerHTML = root.PanjiExt.run('homeTop');
      } catch (e) { /* 静默 */ }
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', initHome);
    else setTimeout(initHome, 0);

    // 日历预热：不阻塞首页，空闲时再取（报告页用不到就完全不取）
    setTimeout(() => { loadCalendar(); }, 2500);
  }

  return {
    PanjiUpload: { handle },
    boot,
    // 纯函数（测试用）
    d8, d10, today8, time6, timeHM,
    tradeKey, todayTrades, isSecondUploadToday, buildMiddayStatement, ruleParam,
    repeatNotice, importsRows, importsSectionHtml,
    findGaps, gapSectionHtml,
    timingSummary, layoutLabel, getLayoutMemory, setLayoutMemory,
    isWeChatUA, shouldUseClipboardRead, pasteFallbackText,
    imageFilesFromClipboard, mergeOcrResults,
    // UP-1 日期推断 / 选择器
    parseDateInput, resolveMonthDay, isTradingDay, addDays8, prevTradingDay,
    inferSessionDate, applyDateInference, summarizeDates, applyTradeDate,
    dateChips, dateReviewHtml, needsFixOf,
    // UP-2 逐笔推断 / 三态文案
    timeMins, inferTradeDate, dayNoteText,
    // UP-1b 按年日历 / Asia-Shanghai 时刻
    cstParts, calCoverage, calHasYear, calendarUrl, calYearsLabel,
    makeCalendarBundle, coverageNoteHtml, CAL_KNOWN_YEARS,
    LAYOUT_KEY, LAYOUT_LABELS, MAX_IMPORTS, MAX_GAPS,
  };
});
