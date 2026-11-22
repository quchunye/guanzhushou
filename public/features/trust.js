// features/trust.js —— 批次 D：信任与可追溯（17 判定解释器 / 18 原图定位 /
// 19 申诉例外 / 20 规则冲突 / 21 规则版本留痕）
//
// 只注册公开 hook（lineExtra / rulesBottom / reportBottom / afterRulesSave），
// 不改 app.js。所有 HTML 只做陈述，不写祈使/未来/因果/收益数字。
// 浏览器挂 window.PanjiTrust；Node 测试走 module.exports（UMD，同 recur.js）。
//
// 闸门：全部功能受 PanjiFlag('trust') 控制，默认关（?f=trust 或 guanzhu_flags_v1 手动开）。
// 关闭时不装豁免、不挂 PanjiExt 钩子、不接管 OCR、不绑点击、不埋点；
// PanjiTrust 仍挂到 window（app.js 的 configure() 自带判空，不需要改 app.js）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else {
    const api = factory(root);
    root.PanjiTrust = api;
    if (!api.flagOn()) return;                      // flag 默认关：整体不注册，不留半截挂载
    if (root.PanjiRecur) api.installExempt();       // 先装豁免，避免任何 ingest 漏计
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => api.register());
      else api.register();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {

  // FX-3：键统一取自 PanjiStore.KEYS；无 store 环境（Node vm 沙箱）回落同值 fallback
  const Store = (function () {
    try { if (root && root.PanjiStore) return root.PanjiStore; } catch (e) { /* 继续 */ }
    try { if (typeof require === 'function') return require('../store.js'); } catch (e) { /* 继续 */ }
    return null;
  })();
  function keyOf(name, fallback) { return (Store && Store.KEYS && Store.KEYS[name]) || fallback; }

  const EXEMPT_KEY = keyOf('exempt', 'guanzhu_exempt_v1');   // {tk6:{T04:true}}
  const HIST_KEY = keyOf('rulesHist', 'guanzhu_rules_hist_v1'); // [{savedAt,hash,rules}]
  const CASE_SEQ = keyOf('caseSeq', 'guanzhu_case_seq');
  const CASE_PREFIX = keyOf('casePrefix', 'guanzhu_case_');
  const MAX_HIST = 50;

  const FLAG = 'trust';

  let adapter = null;
  let flagsOverride = null;
  let recurApi = null;
  let boxesCache = null;     // {w,h,items} 或 null
  let boxesSig = '';         // 与当次成交签名绑定，防止上一张图的坐标串到下一张
  let rowMatchOn = true;     // 同行组合匹配开关（默认开；configure({rowMatch:false}) 可回退旧规则）
  let lastV = null;
  let lastState = null;
  let registered = false;
  let explained = '';        // 同一份报告只记一次 explain_open
  // ---------- COL-3 窗口越线（只做展示与事件，判定结果保持线上原样） ----------
  const WIN_NEAR = 5, WIN_FAR = 20;
  let calTried = false, calIndex = null;      // {pos:{day:idx}, sorted:[], years:Set}
  let chainCache = null, chainSeq = -1;       // 同规则越线历史链（按成交日去重）
  let winCache = { seq: -1, no: '', map: null }; // 按 case_no 缓存本案例每行命中结果

  // ---------- 存储 ----------
  function storage() {
    if (adapter) return adapter;
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
  function getJson(key, fb) {
    const raw = getRaw(key);
    if (raw == null) return fb;
    try { return JSON.parse(raw); } catch (e) { return fb; }
  }
  function caseKey(n) { return CASE_PREFIX + String(n).padStart(3, '0'); }

  function configure(opts) {
    opts = opts || {};
    if (opts.storage) adapter = opts.storage;
    if (opts.recur) recurApi = opts.recur;
    if (opts.flags) flagsOverride = opts.flags;
    if (opts.boxes !== undefined) { boxesCache = opts.boxes || null; boxesSig = ''; }
    if (opts.rowMatch !== undefined) rowMatchOn = !!opts.rowMatch;
    if (opts.calendar !== undefined) {
      calTried = true;
      calIndex = opts.calendar ? indexCalendar(opts.calendar) : null;
    }
    if (opts.storage !== undefined) {
      chainSeq = -1;                                 // 换 storage / 换测试环境时清结果缓存
      winCache = { seq: -1, no: '', map: null };
    }
  }

  // 闸门读取点：默认关；读不到 PanjiFlag 也按关处理
  function flagOn() {
    if (flagsOverride && typeof flagsOverride === 'object') return !!flagsOverride[FLAG];
    try { return !!(root && typeof root.PanjiFlag === 'function' && root.PanjiFlag(FLAG)); } catch (e) { return false; }
  }

  // ---------- 小工具 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  }
  function minutesOf(v) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
    return m ? +m[1] * 60 + +m[2] : null;
  }
  function hhmmOf(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }
  function price2(v) { return (+v || 0).toFixed(2); }
  function money(v) { return '¥' + Math.round(+v || 0).toLocaleString('zh-CN'); }
  function sym(t) { return String((t && (t.code || t.name)) || ''); }
  function amount(t) { return (+t.price || 0) * (+t.qty || 0); }
  function ruleIds(raw) {
    return String(raw || '').split('+').map(s => s.trim()).filter(s => /^T\d{2}$/.test(s));
  }
  function linesOf(v) { return (v && Array.isArray(v.lines)) ? v.lines : []; }
  function dayOf(v, line) { return linesOf(v).filter(l => l.date === line.date).sort((a, b) => a.idx - b.idx); }
  function dayBuys(v, line) { return dayOf(v, line).filter(l => l.side === '买'); }
  function symBuys(v, line) {
    return dayOf(v, line).filter(l => l.side === '买' && sym(l) === sym(line)).sort((a, b) => a.idx - b.idx);
  }
  function paramsOf(v) {
    const m = new Map();
    ((v && v.rules) || []).forEach(r => m.set(r.id || r.templateId, r.params || {}));
    return m;
  }

  // 与 public/recur.js 的 tk6 完全一致（Node / 浏览器都可用，不依赖 PanjiRecur）
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
  function price3(v) { const n = +v; return Number.isFinite(n) && n > 0 ? n.toFixed(3) : ''; }
  function tk6(t) {
    t = t || {};
    return [date8(t.date), time6(t.time), String(t.code || t.name || '').trim(),
      String(t.side || '').trim(), price3(t.price), String(t.qty == null ? '' : t.qty),
      String(t.account || '')].join('|');
  }

  // ---------- 窗口越线：成交日距离 ----------
  // 日历只用于数距离；年份不在日历覆盖范围时退化为自然日（仅内部处理，文案不体现）。
  function indexCalendar(raw) {
    const list = Array.isArray(raw && raw.tradingDays) ? raw.tradingDays.map(date8).filter(Boolean) : [];
    if (!list.length) return null;
    list.sort();
    const pos = {};
    const years = {};
    list.forEach((d, i) => { pos[d] = i; years[d.slice(0, 4)] = 1; });
    return { sorted: list, pos: pos, years: years };
  }
  function bootCalendar() {
    if (calTried) return calIndex;
    calTried = true;
    // Node 测试直接读同目录 JSON；浏览器一次性同步取，保证报告渲染时数据已就绪。
    // 按年追加：新增年份只改下面两个数组，不改距离算法。
    const CAL_FILES = ['../trading_calendar_2026.json', '../trading_calendar_2027.json'];
    const CAL_URLS = ['trading_calendar_2026.json', 'trading_calendar_2027.json'];
    const merged = [];
    try {
      if (typeof require === 'function') {
        CAL_FILES.forEach((f) => {
          try {
            const raw = require(f);
            if (raw && Array.isArray(raw.tradingDays)) merged.push.apply(merged, raw.tradingDays);
          } catch (e) { /* 单年文件缺失：跳过，其它年照常 */ }
        });
        calIndex = indexCalendar({ tradingDays: merged });
        if (calIndex) return calIndex;
      }
    } catch (e) { /* 浏览器没有 require，走 XHR */ }
    merged.length = 0;
    try {
      const X = root && root.XMLHttpRequest;
      if (typeof X === 'function') {
        CAL_URLS.forEach((u) => {
          try {
            const x = new X();
            x.open('GET', u, false);
            x.send(null);
            if (x.status === 200 || x.status === 0) {
              const raw = JSON.parse(x.responseText);
              if (raw && Array.isArray(raw.tradingDays)) merged.push.apply(merged, raw.tradingDays);
            }
          } catch (e2) { /* 单年取不到不影响其它年 */ }
        });
        calIndex = indexCalendar({ tradingDays: merged });
      }
    } catch (e) { calIndex = null; }
    return calIndex;
  }
  function naturalDays(a, b) {
    const ta = Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8));
    const tb = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
    return Math.round((tb - ta) / 86400000);
  }
  // a < b 时返回相隔的成交日数；任一日不在日历覆盖范围内 → 自然日
  function spanDays(a, b) {
    a = date8(a); b = date8(b);
    if (!a || !b) return NaN;
    const cal = bootCalendar();
    if (!cal || !cal.years[a.slice(0, 4)] || !cal.years[b.slice(0, 4)]) return naturalDays(a, b);
    if (!(a in cal.pos) || !(b in cal.pos)) return naturalDays(a, b);
    return cal.pos[b] - cal.pos[a];
  }
  // 同规则历史链：只收违规行；计划内、可疑（不在 lines）、tk6 重复都不进链
  function buildChain() {
    const seq = +(getRaw(CASE_SEQ) || 0);
    if (chainCache && chainSeq === seq) return chainCache;
    const ex = loadExempt();
    const rules = {};
    readCases(1000).forEach((c) => {
      linesOf(c.verdict).forEach((line) => {
        if (!line || line.flag !== '违规') return;
        const ids = ruleIds(line.rule);
        const d = date8(line.date);
        if (!ids.length || !d) return;
        const k = tk6(line);
        ids.forEach((id) => {
          if (k && ex[k] && ex[k][id]) return;             // 计划内不计
          const r = rules[id] || (rules[id] = { days: {}, tk: {} });
          if (k && r.tk[k]) return;                        // 同一笔只取最早一次
          if (k) r.tk[k] = 1;
          r.days[d] = 1;                                   // 同日多行只算 1 天
        });
      });
    });
    chainCache = { seq: seq, rules: rules };
    chainSeq = seq;
    return chainCache;
  }
  function prevDayOf(ruleId, d) {
    const days = Object.keys(((buildChain().rules[ruleId] || {}).days) || {}).sort();
    let prev = '';
    for (let i = 0; i < days.length; i++) {
      if (days[i] < d) prev = days[i]; else break;
    }
    return prev;
  }
  function hitForRules(ids, d) {
    let near = null, far = null;
    (ids || []).forEach((id) => {
      const p = prevDayOf(id, d);
      if (!p) return;
      const n = spanDays(p, d);
      if (!(n > 0)) return;
      if (n <= WIN_NEAR) { if (!near || p > near.prev) near = { prev: p, n: n, rule: id }; }
      else if (n <= WIN_FAR) { if (!far || p > far.prev) far = { prev: p, n: n, rule: id }; }
    });
    if (near) return { hit: 'w5', prev: near.prev, n: near.n, rule: near.rule };
    if (far) return { hit: 'w20', prev: far.prev, n: far.n, rule: far.rule };
    return null;
  }
  function windowMapFor(v) {
    const seq = +(getRaw(CASE_SEQ) || 0);
    const no = String((v && v.case_no) || '');
    if (winCache.seq === seq && winCache.no === no && winCache.map) return winCache.map;
    const map = {};
    linesOf(v).forEach((line) => {
      if (!line || line.flag !== '违规') return;
      if (String(line.side || '') !== '买') return;        // U-005/006 口径是越线买入
      const ids = ruleIds(line.rule);
      const d = date8(line.date);
      if (!ids.length || !d) return;
      const h = hitForRules(ids, d);
      if (h) map[line.idx] = h;
    });
    winCache = { seq: seq, no: no, map: map };
    return map;
  }
  function windowHit(line, v) { return windowMapFor(v || lastV)[line && line.idx] || null; }
  function fmtDay(d) {
    const s = date8(d);
    return s ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '';
  }
  // 认下成功后由 intent.onAck 回调：只有这笔是「违规买入」且同规则确实在窗口内再触发，才记事件
  function noteAck(ctx) {
    ctx = ctx || {};
    const key = String(ctx.key || '');
    const parts = key.split('|');
    if (!parts[0] || parts[3] !== '买') return null;
    const ids = /^T\d{2}$/.test(String(ctx.rule || '')) ? [String(ctx.rule)] : [];
    if (!ids.length) return null;
    const h = hitForRules(ids, parts[0]);
    if (!h) return null;
    try {
      const coll = (root && root.PanjiCollection) || (typeof PanjiCollection !== 'undefined' ? PanjiCollection : null);
      if (coll && typeof coll.record === 'function') {
        coll.record(h.hit === 'w5' ? 'ack_w5' : 'ack_w20', { fp: key + '|' + h.rule, storage: storage() });
      }
    } catch (e) { /* 静默：图鉴失败不影响认下 */ }
    return h;
  }
  function hookAck() {
    try {
      const I = root && root.PanjiFeatures && root.PanjiFeatures.intent;
      if (I && typeof I.onAck === 'function') I.onAck(noteAck);
    } catch (e) { /* 没有 intent 就只做展示 */ }
  }

  // ---------- 17 判定解释器 ----------
  // 每条规则一行算式；parts 里带 idx 的变量可点回对应那笔成交。
  function P(v, idx) { return idx == null ? { v: String(v) } : { v: String(v), idx: idx }; }
  function cmp(lhs, rhs, op) {
    if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) return false;
    if (op === '<') return lhs < rhs;
    if (op === '>') return lhs > rhs;
    if (op === '>=') return lhs >= rhs;
    if (op === '<=') return lhs <= rhs;
    return false;
  }

  function fT01(line, p) {
    const m = minutesOf(line.time);
    if (m == null) return { op: null, triggered: false, parts: [P('时间缺失 → T01 跳过（不计）')] };
    const wait = +p.waitMin || 0;
    const limit = 570 + wait;
    return {
      op: '<', lhs: m, rhs: limit,
      parts: [P(String(line.time) + ' < ' + hhmmOf(limit)), P('（09:30 + ' + wait + ' 分） → 触发')],
    };
  }

  function fT02(line, p) {
    const m = minutesOf(line.time);
    if (m == null) return { op: null, triggered: false, parts: [P('时间缺失 → T02 跳过（不计）')] };
    const end = +p.endMin || 0;
    const from = 900 - end;
    return {
      op: '>=', lhs: m, rhs: from,
      parts: [P(String(line.time) + ' ≥ ' + hhmmOf(from)), P('（15:00 − ' + end + ' 分） → 触发')],
    };
  }

  function fT03(line, v, p) {
    const buys = symBuys(v, line);
    if (!buys.length) return null;
    const first = buys[0];
    const maxPrice = Math.max.apply(null, buys.map(b => +b.price || 0));
    const win = +p.windowMin || 0;
    const limit = 570 + win;
    const inWin = minutesOf(first.time) != null && minutesOf(first.time) <= limit;
    return {
      op: '>=', lhs: +first.price, rhs: maxPrice, extraOk: inWin,
      parts: [
        P(String(first.time) + ' 首笔仍为当日最高 ' + price2(first.price), first.idx),
        P(' ≥ 当日买入最高 ' + price2(maxPrice)),
        P('，且 ≤ ' + hhmmOf(limit) + '（09:30 + ' + win + ' 分） → 触发'),
      ],
    };
  }

  function fT04(line, v, p) {
    const buys = symBuys(v, line);
    const first = buys[0];
    if (!first) return null;
    const tol = +p.tolPct || 0;
    const rhs = (+first.price || 0) * (1 - tol / 100);
    return {
      op: '<', lhs: +line.price, rhs: rhs,
      parts: [
        P(price2(line.price) + ' < '),
        P(price2(first.price), first.idx),
        P(' × (1 − ' + tol + '%) = ' + price2(rhs) + ' → 触发'),
      ],
    };
  }

  function fT05(line, v, p) {
    const buys = symBuys(v, line);
    const base = +v.capital || 0;
    const maxPct = +p.maxPct || 0;
    const rhs = base * maxPct / 100;
    return {
      op: '>', lhs: amount(line), rhs: rhs,
      parts: [
        P(money(amount(line)) + ' > '),
        P(money(base) + '（账户资金）'),
        P(' × ' + maxPct + '% = ' + money(rhs) + ' → 触发'),
      ],
    };
  }

  function fT06(line, v, p) {
    const buys = dayBuys(v, line);
    const n = buys.findIndex(b => b.idx === line.idx) + 1;
    const maxBuys = +p.maxBuys || 0;
    return {
      op: '>', lhs: n, rhs: maxBuys,
      parts: [P('当日第 ' + n + ' 笔买入 > 上限 ' + maxBuys + ' 笔 → 触发')],
    };
  }

  function fT07(line, v) {
    // 20261107：买入或卖出任一方向重复 ≥2 次即触发，不再数「卖出上限」。
    const side = line.side;
    const same = dayOf(v, line).filter(l => l.side === side && sym(l) === sym(line));
    const n = same.findIndex(b => b.idx === line.idx) + 1;
    return {
      op: '>=', lhs: n, rhs: 2,
      parts: [P('当日 ' + sym(line) + ' ' + side + '第 ' + n + ' 次 ≥ 2 次 → 触发（买入或卖出任一方向重复）')],
    };
  }

  function fT08(line, v, p) {
    const day = dayOf(v, line);
    const firstBuys = [];
    const seen = {};
    day.forEach(l => {
      if (l.side !== '买' || seen[sym(l)]) return;
      seen[sym(l)] = 1;
      firstBuys.push(l);
    });
    const n = firstBuys.findIndex(b => b.idx === line.idx) + 1;
    const maxSymbols = +p.maxSymbols || 0;
    return {
      op: '>', lhs: n, rhs: maxSymbols,
      parts: [P('当日第 ' + n + ' 只买入标的（' + sym(line) + '） > 上限 ' + maxSymbols + ' 只 → 触发')],
    };
  }

  function fT09(line, v, p) {
    const day = dayOf(v, line);
    const base = +v.capital || 0;
    const cum = day.filter(l => l.side === '买' && sym(l) === sym(line) && l.idx <= line.idx)
      .reduce((a, b) => a + amount(b), 0);
    const maxPct = +p.maxPct || 0;
    const rhs = base * maxPct / 100;
    return {
      op: '>=', lhs: cum, rhs: rhs,
      parts: [
        P('当日累计 ' + money(cum) + ' ≥ '),
        P(money(base) + '（账户资金）'),
        P(' × ' + maxPct + '% = ' + money(rhs) + ' → 触发'),
      ],
    };
  }

  function fT10(line, v, p) {
    const cum = dayBuys(v, line).filter(b => b.idx <= line.idx).reduce((a, b) => a + amount(b), 0);
    const base = +v.capital || 0;
    const maxPct = +p.maxPct || 0;
    const rhs = base * maxPct / 100;
    return {
      op: '>=', lhs: cum, rhs: rhs,
      parts: [
        P('当日累计买入 ' + money(cum) + ' ≥ '),
        P(money(base) + '（账户资金）× ' + maxPct + '% = ' + money(rhs) + ' → 触发'),
      ],
    };
  }

  // T11 是日级规则：按成交日 FIFO 重算已实现亏损，保证算式可复算
  function fifoLossByDate(v) {
    const ts = linesOf(v).slice().sort((a, b) =>
      (String(a.date) + ' ' + String(a.time)).localeCompare(String(b.date) + ' ' + String(b.time)));
    const queues = {};
    const loss = {};
    ts.forEach(t => {
      const k = sym(t);
      if (!queues[k]) queues[k] = [];
      if (t.side === '买') {
        queues[k].push({ qty: +t.qty || 0, price: +t.price || 0 });
      } else {
        let need = +t.qty || 0, cost = 0;
        while (need > 0 && queues[k].length) {
          const h = queues[k][0];
          const take = Math.min(need, h.qty);
          cost += take * h.price;
          h.qty -= take; need -= take;
          if (h.qty <= 0) queues[k].shift();
        }
        const done = (+t.qty || 0) - need;
        const pnl = done * (+t.price || 0) - cost;
        if (pnl < 0) loss[t.date] = (loss[t.date] || 0) - pnl;
      }
    });
    return loss;
  }

  function fT11(check, v) {
    const p = paramsOf(v).get('T11') || {};
    const loss = fifoLossByDate(v)[check.date] || 0;
    const base = +v.capital || 0;
    const maxPct = +p.maxPct || 0;
    const rhs = base * maxPct / 100;
    return {
      op: '>', lhs: loss, rhs: rhs,
      parts: [P('已实现亏损 ' + money(loss) + ' > ' + money(base) + '（账户资金）× ' + maxPct + '% = ' + money(rhs) + ' → 触发')],
    };
  }

  function fT12(check, v) {
    const code = String(check.code || '');
    return {
      op: null, triggered: true,
      parts: [P(code + ' 同日既有买入又有卖出，交割单看不到止损记录 → 存疑（不计违规）')],
    };
  }

  function fT13(line) {
    const hit = /ST|退/i.test(String(line.name || ''));
    return {
      op: null, triggered: hit,
      parts: [P('名称「' + (line.name || '') + '」' + (hit ? '含 ST / 退 → 触发' : '不含 ST / 退 → 未触发'))],
    };
  }

  // evalFormula(ruleId, line, verdict, dayCheck?) → {ruleId, parts, text, op, lhs, rhs, triggered}
  function evalFormula(ruleId, line, v, check) {
    const p = paramsOf(v).get(ruleId) || {};
    let f = null;
    if (ruleId === 'T11') f = fT11(check || {}, v);
    else if (ruleId === 'T12') f = fT12(check || {}, v);
    else if (!line) return null;
    else if (ruleId === 'T01') f = fT01(line, p);
    else if (ruleId === 'T02') f = fT02(line, p);
    else if (ruleId === 'T03') f = fT03(line, v, p);
    else if (ruleId === 'T04') f = fT04(line, v, p);
    else if (ruleId === 'T05') f = fT05(line, v, p);
    else if (ruleId === 'T06') f = fT06(line, v, p);
    else if (ruleId === 'T07') f = fT07(line, v, p);
    else if (ruleId === 'T08') f = fT08(line, v, p);
    else if (ruleId === 'T09') f = fT09(line, v, p);
    else if (ruleId === 'T10') f = fT10(line, v, p);
    else if (ruleId === 'T13') f = fT13(line);
    if (!f) return null;
    const triggered = f.op ? (cmp(f.lhs, f.rhs, f.op) && f.extraOk !== false) : !!f.triggered;
    return {
      ruleId: ruleId,
      parts: f.parts,
      text: f.parts.map(x => x.v).join(''),
      op: f.op || null, lhs: f.lhs, rhs: f.rhs, triggered: triggered,
    };
  }

  function formulaHtml(f, line) {
    return f.parts.map((p) => {
      if (p.idx != null && (!line || p.idx !== line.idx)) {
        return '<span class="tr-var" data-tr-idx="' + p.idx + '" title="点回第 ' + (p.idx + 1) + ' 笔成交">' + esc(p.v) + '</span>';
      }
      return esc(p.v);
    }).join('');
  }

  // ---------- 19 申诉例外 ----------
  function loadExempt() {
    const m = getJson(EXEMPT_KEY, null);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  }
  function saveExempt(m) { return setRaw(EXEMPT_KEY, m); }
  function isExempt(k, rule) {
    const m = loadExempt();
    return !!(m[k] && m[k][rule]);
  }
  function isLineExempt(line) {
    const ids = ruleIds(line && line.rule);
    if (!ids.length) return false;
    const key = tk6(line);
    const m = loadExempt();
    return ids.every(id => !!(m[key] && m[key][id]));
  }
  function applyToRecur() {
    const r = recurApi || (root && root.PanjiRecur);
    if (!r) return false;
    try {
      r.setExempt((k, rule) => isExempt(k, rule));
      return true;
    } catch (e) { return false; }
  }
  function installExempt() { return applyToRecur(); }

  function toggleExempt(line) {
    const key = tk6(line);
    const ids = ruleIds(line && line.rule);
    const m = loadExempt();
    const cur = m[key] || {};
    const on = !ids.every(id => !!cur[id]);
    if (!m[key]) m[key] = {};
    ids.forEach((id) => { if (on) m[key][id] = true; else delete m[key][id]; });
    if (!Object.keys(m[key]).length) delete m[key];
    saveExempt(m);
    chainSeq = -1;                                   // 计划内开关变了，历史链要重算
    winCache = { seq: -1, no: '', map: null };
    // 先装豁免再重建：原 flag 保留，复发索引不再计这笔
    applyToRecur();
    const r = recurApi || (root && root.PanjiRecur);
    if (r && typeof r.rebuild === 'function') {
      try { r.rebuild(); } catch (e) { /* 回填失败不阻塞标记 */ }
    }
    return { exempt: on, map: m, key: key, ids: ids };
  }

  function exemptSummary(v) {
    const vio = linesOf(v).filter(l => l.flag === '违规');
    const marked = vio.filter(l => isLineExempt(l)).length;
    return vio.length + ' 笔越线，其中 ' + marked + ' 笔你标为计划内';
  }

  // ---------- 18 原图定位 ----------
  function tradeSig(list) {
    return (list || []).slice(0, 60).map(t => [
      String(t.date || ''), String(t.time || '').slice(0, 5), String(t.code || t.name || ''),
      (+t.price || 0).toFixed(2), String(t.qty == null ? '' : t.qty),
    ].join(',')).join(';');
  }
  function currentBoxes(v) {
    if (!boxesCache) return null;
    if (boxesSig && boxesSig !== tradeSig(linesOf(v))) return null;   // 坐标必须属于这批成交
    return boxesCache;
  }
  function boxItems(boxes) {
    if (!boxes) return null;
    if (Array.isArray(boxes)) return boxes;
    return Array.isArray(boxes.items) ? boxes.items : null;
  }
  function centerY(b) { return (+b.ny || 0) + (+b.nh || 0) / 2; }
  function unionBox(a, b) {
    const x = Math.min(+a.nx, +b.nx);
    const y = Math.min(+a.ny, +b.ny);
    const r = Math.max(+a.nx + +a.nw, +b.nx + +b.nw);
    const d = Math.max(+a.ny + +a.nh, +b.ny + +b.nh);
    return { nx: x, ny: y, nw: r - x, nh: d - y, text: a.text + ' ' + b.text, label: '该笔成交位置' };
  }
  // OCR 文本常带全角冒号/全角数字（TextIn 示例：'卖 20261019 10：14：50'），
  // 匹配前统一成半角并去掉空白；否则 line.time='10:14' 永远匹配不到时间框。
  function normBoxText(s) {
    return String(s == null ? '' : s)
      .replace(/：/g, ':')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248))
      .replace(/\s+/g, '');
  }
  function boxTop(b) { return +b.ny || 0; }
  function boxBottom(b) { return (+b.ny || 0) + (+b.nh || 0); }
  // 同行：y 区间重叠，或相邻行行距不超过约一个行高（不跨卡片行，避免全文乱配）
  function rowNear(a, b) {
    if (!a || !b) return false;
    const ov = Math.min(boxBottom(a), boxBottom(b)) - Math.max(boxTop(a), boxTop(b));
    if (ov > 0) return true;
    const tol = Math.max(0.02, Math.max(+a.nh || 0, +b.nh || 0) * 1.2);
    return -ov <= tol;
  }
  function rowDist(a, b) {
    const ov = Math.min(boxBottom(a), boxBottom(b)) - Math.max(boxTop(a), boxTop(b));
    return ov > 0 ? 0 : -ov;
  }

  // OCR 行可能是整行，也可能是单元格：同行命中时间+价格两框时取并集；
  // 只有时间框（定位不到价格）按未匹配处理，报告降级 partial，不伪造一笔成交位置。
  function matchBox(line, v) {
    const items = boxItems(currentBoxes(v));
    if (!items || !items.length || !line) return null;
    const time = String(line.time || '').slice(0, 5);
    const prices = [price2(line.price), (+line.price || 0).toFixed(3), String(+line.price || 0)];
    const name = String(line.name || '');
    const tCands = time ? items.filter(b => normBoxText(b.text).indexOf(time) >= 0) : [];
    const pCands = prices.some(p => p && p !== '0')
      ? items.filter(b => prices.some(p => p && normBoxText(b.text).indexOf(p) >= 0))
      : [];
    if (rowMatchOn) {
      // 同一行内（y 重叠或相邻行）分别命中时间与价格 → 取两框并集
      // 同一分钟同价的重复成交用「数量框同行」二次区分，避免两笔都指到同一行
      const qty = String(line.qty == null ? '' : line.qty);
      const qtyNear = (tb, pb, q) => {
        if (!q) return 0;
        return items.some(b => normBoxText(b.text) === q && rowNear(b, tb) && rowNear(b, pb)) ? 1 : 0;
      };
      let best = null;
      tCands.forEach((tb) => {
        pCands.forEach((pb) => {
          if (!rowNear(tb, pb)) return;
          const d = rowDist(tb, pb);
          const q = qtyNear(tb, pb, qty);
          if (!best || d < best.d || (d === best.d && q > best.q)) best = { tb: tb, pb: pb, d: d, q: q };
        });
      });
      if (best) return unionBox(best.tb, best.pb);
      // 没有时间锚点时，才用「价格+名称同行」的单框规则兜底；不跨行拿全文同值框
      if (!tCands.length && pCands.length) {
        const nb = name ? (items.find(b => normBoxText(b.text).indexOf(name) >= 0) || null) : null;
        if (nb && Math.abs(centerY(pCands[0]) - centerY(nb)) < 0.08) return unionBox(pCands[0], nb);
      }
      return null;
    }
    // 开关关闭：保留改前规则（单时间框也会返回，回滚时行为不变）
    const tb = tCands[0] || null;
    const pb = tb
      ? (pCands.slice().sort((a, b) => Math.abs(centerY(a) - centerY(tb)) - Math.abs(centerY(b) - centerY(tb)))[0] || null)
      : (pCands[0] || null);
    const nb = name ? (items.find(b => normBoxText(b.text).indexOf(name) >= 0) || null) : null;
    if (tb && pb && Math.abs(centerY(tb) - centerY(pb)) < 0.08) return unionBox(tb, pb);
    if (tb) return { nx: tb.nx, ny: tb.ny, nw: tb.nw, nh: tb.nh, text: tb.text, label: '该笔时间位置' };
    if (pb && nb && Math.abs(centerY(pb) - centerY(nb)) < 0.08) return unionBox(pb, nb);
    return null;
  }

  let overlay = null;
  function clearOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }
  function openOriginal(state) {
    const iv = typeof document !== 'undefined' ? document.getElementById('img-viewer') : null;
    const img = typeof document !== 'undefined' ? document.getElementById('iv-img') : null;
    if (!iv || !img || !state || !state.imageUrl) return false;
    clearOverlay();
    img.src = state.imageUrl;
    img.style.width = '100%';
    state.imgScale = 1;
    iv.hidden = false;
    return true;
  }
  function showBox(state, box) {
    if (!openOriginal(state)) return false;
    const img = document.getElementById('iv-img');
    const paint = () => {
      clearOverlay();
      // 先把目标行滚到查看器可视区中间，再按图片当前像素矩形画框
      const scroller = img.closest ? img.closest('.iv-scroll') : null;
      if (scroller) {
        const sr = scroller.getBoundingClientRect();
        const ir = img.getBoundingClientRect();
        const contentTop = ir.top - sr.top + (scroller.scrollTop || 0);
        const targetY = (box.ny + box.nh / 2) * ir.height;
        scroller.scrollTop = Math.max(0, contentTop + targetY - scroller.clientHeight / 2);
      }
      const r = img.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const o = document.createElement('div');
      o.className = 'tr-bbox';
      o.style.position = 'fixed';
      o.style.left = (r.left + box.nx * r.width) + 'px';
      o.style.top = (r.top + box.ny * r.height) + 'px';
      o.style.width = (box.nw * r.width) + 'px';
      o.style.height = (box.nh * r.height) + 'px';
      o.innerHTML = '<span class="tr-bbox-tag">' + esc(box.label || '原图定位') + ' · 点击关闭</span>';
      o.addEventListener('click', clearOverlay);
      document.body.appendChild(o);
      overlay = o;
    };
    if (img.complete && img.naturalWidth) setTimeout(paint, 0);
    else img.addEventListener('load', paint, { once: true });
    return true;
  }

  function bboxBlock(line, v, state) {
    if (!state || !state.imageUrl) {
      return '<div class="tr-bbox-row"><span class="tr-partial">本次无原图可对照 · partial</span></div>';
    }
    const box = matchBox(line, v);
    if (box) {
      return '<div class="tr-bbox-row"><button class="tr-btn ghost" data-tr-bbox="' + line.idx + '">原图定位</button>'
        + '<span class="tr-hint">OCR 坐标已匹配（' + esc(box.label || '') + '）</span></div>';
    }
    const hasBoxes = !!boxItems(currentBoxes(v));
    return '<div class="tr-bbox-row"><button class="tr-btn ghost" data-tr-img="' + line.idx + '">打开原图</button>'
      + '<span class="tr-partial">原图定位未启用（' + (hasBoxes ? '未匹配到该笔坐标' : 'OCR 未返回坐标') + '）· partial</span></div>';
  }

  function installOcrCapture() {
    const ocr = root && root.PanjiOcr;
    if (!ocr || ocr.__trustBoxesHook || typeof ocr.ingest !== 'function') return false;
    const orig = ocr.ingest;
    ocr.ingest = function (data) {
      try {
        boxesCache = (data && data.boxes) || null;
        boxesSig = tradeSig((data && data.trades) || []);
      } catch (e) { boxesCache = null; boxesSig = ''; }
      return orig.apply(this, arguments);
    };
    ocr.__trustBoxesHook = true;
    return true;
  }

  // ---------- 20 规则冲突（只提示，不改参数） ----------
  function paramsMap(config) {
    const m = new Map();
    ((config && config.rules) || []).forEach(r => m.set(r.templateId || r.id, r.params || {}));
    return m;
  }
  function detectConflicts(config) {
    const m = paramsMap(config);
    const out = [];
    if (m.has('T01') && m.has('T02')) {
      const w = +(m.get('T01').waitMin) || 0;
      const e = +(m.get('T02').endMin) || 0;
      const sum = w + e;
      if (sum > 240) {
        out.push({ a: 'T01', b: 'T02', level: 'conflict',
          text: '冷静期 ' + w + ' 分 + 收盘前禁买 ' + e + ' 分 = ' + sum + ' 分 > 240 分，两段禁区大面积重叠。' });
      } else if (sum >= 180) {
        out.push({ a: 'T01', b: 'T02', level: 'notice',
          text: '冷静期 ' + w + ' 分 + 收盘前禁买 ' + e + ' 分 = ' + sum + ' 分，已叠加覆盖当日大半交易时段（模板上限合计 180 分）。' });
      }
    }
    if (m.has('T05') && m.has('T09')) {
      const a = +(m.get('T05').maxPct) || 0;
      const b = +(m.get('T09').maxPct) || 0;
      if (Math.abs(a - b) <= 10) {
        out.push({ a: 'T05', b: 'T09', level: 'conflict',
          text: '单笔上限 ' + a + '% 与单只上限 ' + b + '% 相差 ' + Math.abs(a - b) + ' 个百分点，接近时同一笔可能同时命中两条。' });
      }
    }
    if (m.has('T06') && m.has('T08')) {
      const mb = +(m.get('T06').maxBuys) || 0;
      const ms = +(m.get('T08').maxSymbols) || 0;
      out.push({ a: 'T06', b: 'T08', level: 'conflict',
        text: '笔数上限 ' + mb + ' 笔与只数上限 ' + ms + ' 只同时生效：' + (ms <= mb ? '只数先触发，笔数规则可能被遮住' : '笔数先触发，只数规则可能被遮住') + '。' });
    }
    return out;
  }

  // ---------- 21 规则版本留痕 ----------
  function hashRules(rules) {
    const canon = (rules || []).map(r => ({ id: String((r && (r.templateId || r.id)) || ''), p: (r && r.params) || {} }))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(r => r.id + '(' + Object.keys(r.p).sort().map(k => k + '=' + (+r.p[k])).join(',') + ')')
      .join('|');
    let h = 2166136261;
    for (let i = 0; i < canon.length; i++) {
      h = h ^ canon.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(36) + '-' + canon.length;
  }
  function loadHist() {
    const h = getJson(HIST_KEY, null);
    return Array.isArray(h) ? h : [];
  }
  function appendRulesHistory(payload) {
    const rules = (payload && Array.isArray(payload.rules)) ? payload.rules : [];
    if (!rules.length) return { added: false, hist: loadHist(), reason: 'empty' };
    const hist = loadHist();
    const hash = hashRules(rules);
    const last = hist[hist.length - 1];
    if (last && last.hash === hash) return { added: false, hist: hist, reason: 'same' };
    hist.push({
      savedAt: new Date().toISOString(),
      hash: hash,
      rules: rules.map(r => ({ templateId: r.templateId || r.id, params: Object.assign({}, r.params || {}) })),
    });
    if (hist.length > MAX_HIST) hist.splice(0, hist.length - MAX_HIST);
    setRaw(HIST_KEY, hist);
    return { added: true, hist: hist, reason: 'new' };
  }
  function readCases(limit) {
    const cap = +limit || 200;
    const seq = +(getRaw(CASE_SEQ) || 0);
    const from = seq > cap ? seq - cap + 1 : 1;
    const out = [];
    for (let i = from; i <= seq; i++) {
      const c = getJson(caseKey(i), null);
      if (c && c.verdict) out.push({ no: i, ts: String(c.ts || ''), verdict: c.verdict });
    }
    return out;
  }
  function versionIndexOf(ts, hist) {
    let idx = -1;
    hist.forEach((h, i) => { if (h.savedAt && String(h.savedAt) <= String(ts)) idx = i; });
    return idx;
  }
  function versionSegments(hist, cases) {
    const h = Array.isArray(hist) ? hist : loadHist();
    const cs = Array.isArray(cases) ? cases : readCases();
    const buckets = new Map();
    cs.forEach((c) => {
      const i = versionIndexOf(c.ts, h);
      if (!buckets.has(i)) buckets.set(i, { index: i, cases: 0, violationLines: 0 });
      const b = buckets.get(i);
      b.cases++;
      b.violationLines += ((c.verdict && c.verdict.lines) || []).filter(l => l.flag === '违规').length;
    });
    return Array.from(buckets.keys()).sort((a, b) => a - b).map((i) => {
      const b = buckets.get(i);
      return {
        index: i, label: i < 0 ? '版本未记录' : '第 ' + (i + 1) + ' 版',
        savedAt: i >= 0 ? String(h[i].savedAt || '') : '', cases: b.cases, violationLines: b.violationLines,
      };
    });
  }

  // ---------- 渲染 ----------
  function track(name) {
    try { if (root && typeof root.PanjiTrack === 'function') root.PanjiTrack(name); } catch (e) { /* 静默 */ }
  }

  function renderLineExtra(line, v, state) {
    lastV = v; lastState = state;
    if (!line || line.flag !== '违规') return '';
    const ids = ruleIds(line.rule);
    let formulas = '';
    ids.forEach((id) => {
      const f = evalFormula(id, line, v);
      if (!f) return;
      formulas += '<div class="tr-formula"><span class="tr-rule">' + esc(id) + '</span> ' + formulaHtml(f, line) + '</div>';
    });
    if (!formulas) return '';
    if (!explained && v && v.case_no) { explained = v.case_no; track('explain_open'); }

    const win = windowHit(line, v);
    const winBlock = win
      ? '<div class="tr-win"><button type="button" class="tr-win-btn" data-tr-win="' + line.idx + '">'
        + '同一规则 ' + (win.hit === 'w5' ? '5' : '20') + ' 个成交日内再次触发</button>'
        + '<span class="tr-win-note" data-tr-win-note="' + line.idx + '" hidden>'
        + '上一次越线日期：' + esc(fmtDay(win.prev)) + '</span></div>'
      : '';

    const marked = isLineExempt(line);
    const actions = marked
      ? '<span class="tr-badge">已标为计划内 · 不计入复发</span><button class="tr-btn ghost" data-tr-exempt="' + line.idx + '">撤销</button>'
      : '<button class="tr-btn" data-tr-exempt="' + line.idx + '">这笔是计划内的</button><span class="tr-tip">原判定保留，只在复发统计里不计</span>';

    return '<div class="tr-extra" data-tr-line="' + line.idx + '">'
      + '<div class="tr-exp-title">判定依据（可点数字回到那笔成交）</div>'
      + formulas
      + winBlock
      + '<div class="tr-actions">' + actions + '</div>'
      + bboxBlock(line, v, state)
      + '</div>';
  }

  function renderRulesBottom(config) {
    if (!config || !Array.isArray(config.rules) || !config.rules.length) return '';
    const list = detectConflicts(config);
    if (!list.length) return '';
    track('rule_conflict_warn');
    return '<div class="tr-panel tr-conflict"><h4>规则组合提示</h4>'
      + list.map(c => '<p class="tr-conflict-item"><b>' + esc(c.a) + ' + ' + esc(c.b) + '</b> '
        + esc(c.text) + '</p>').join('')
      + '<p class="tr-hint">只提示组合关系，不自动改任何参数。</p></div>';
  }

  function renderReportBottom(v, state) {
    lastV = v; lastState = state;
    const out = [];

    const vioCount = linesOf(v).filter(l => l.flag === '违规').length;
    if (vioCount) {
      out.push('<div class="tr-panel tr-exempt-panel"><h4>申诉例外（计划内）</h4>'
        + '<p class="tr-exempt-note" id="tr-exempt-note">' + esc(exemptSummary(v)) + '</p>'
        + '<p class="tr-hint">标为计划内：原「违规」标记保留；复发索引重建后，这笔不计入天数。</p></div>');
    }

    // 日级规则（T11）没有逐笔卡片，算式放在这里，保证 13 条规则都有可复算的一行
    const dayF = ((v && v.day_checks) || []).filter(d => d && d.rule === 'T11').map((d) => {
      const f = evalFormula('T11', null, v, d);
      return f ? '<div class="tr-formula"><span class="tr-rule">T11</span> ' + esc(f.text) + '</div>' : '';
    }).join('');
    if (dayF) out.push('<div class="tr-panel"><h4>当日规则算式</h4>' + dayF + '</div>');

    const hist = loadHist();
    if (hist.length) {
      const cur = hist[hist.length - 1];
      let block = '<div class="tr-panel tr-version"><h4>规则版本</h4>'
        + '<p>当前第 <b>' + hist.length + '</b> 版（' + esc(String(cur.savedAt || '').slice(0, 10)) + ' 保存）</p>';
      if (hist.length > 1) {
        const segs = versionSegments(hist);
        const rows = segs.map(s => '<span class="tr-seg">' + esc(s.label) + ' ' + s.cases + ' 次复盘</span>').join('');
        block += '<p class="tr-seg-line">按版本分段：' + (rows || '<span class="tr-seg">暂无案例</span>') + '</p>'
          + '<p class="tr-warn">规则参数改过之后，前后统计不可比。</p>';
        track('rules_version_seg');
      } else {
        block += '<p class="tr-hint">当前只有 1 个版本，统计不涉及跨版本比较。</p>';
      }
      block += '</div>';
      out.push(block);
    }
    return out.length ? '<div class="tr-bottom">' + out.join('') + '</div>' : '';
  }

  function onRulesSave(payload) {
    return appendRulesHistory(payload).added;
  }

  // ---------- 交互（事件委托，不新增 app.js 绑定） ----------
  function scrollToLine(idx) {
    if (typeof document === 'undefined') return;
    const rows = document.querySelectorAll('#rep-lines .rep-line');
    const el = rows[idx];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('tr-flash');
    setTimeout(() => el.classList.remove('tr-flash'), 1400);
  }
  function onDocClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const varEl = t.closest('.tr-var');
    if (varEl) { e.preventDefault(); scrollToLine(+varEl.dataset.trIdx); return; }
    const ex = t.closest('[data-tr-exempt]');
    if (ex && lastV) {
      const idx = +ex.dataset.trExempt;
      const line = linesOf(lastV)[idx];
      if (line) {
        const r = toggleExempt(line);
        track('exempt_set');
        const box = document.querySelector('.tr-extra[data-tr-line="' + idx + '"]');
        if (box) box.outerHTML = renderLineExtra(line, lastV, lastState);
        const note = document.getElementById('tr-exempt-note');
        if (note) note.textContent = exemptSummary(lastV);
        if (r.exempt === false) { /* 撤销后无需额外提示 */ }
      }
      return;
    }
    const wn = t.closest('[data-tr-win]');
    if (wn) {
      const idx = wn.getAttribute('data-tr-win');
      const note = document.querySelector('[data-tr-win-note="' + idx + '"]');
      if (note) note.hidden = !note.hidden;   // 只展开上次越线日期，不展开任何成交
      return;
    }
    const bb = t.closest('[data-tr-bbox]');
    if (bb && lastV) {
      const line = linesOf(lastV)[+bb.dataset.trBbox];
      const box = line ? matchBox(line, lastV) : null;
      if (box && showBox(lastState, box)) track('bbox_open');
      return;
    }
    const im = t.closest('[data-tr-img]');
    if (im && lastState) { if (openOriginal(lastState)) track('bbox_open'); return; }
    if (t.closest('#iv-close')) clearOverlay();
  }

  function register() {
    if (registered) return true;
    const ext = root && root.PanjiExt;
    if (!ext) return false;
    if (Array.isArray(ext.lineExtra)) ext.lineExtra.push(renderLineExtra);
    if (Array.isArray(ext.rulesBottom)) ext.rulesBottom.push(renderRulesBottom);
    if (Array.isArray(ext.reportBottom)) ext.reportBottom.push(renderReportBottom);
    if (Array.isArray(ext.afterRulesSave)) ext.afterRulesSave.push(onRulesSave);
    installOcrCapture();
    installExempt();
    hookAck();
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('click', onDocClick, true);
    registered = true;
    return true;
  }

  return {
    EXEMPT_KEY, HIST_KEY, FLAG,
    configure, register, flagOn,
    installExempt, installOcrCapture,
    tk6, evalFormula, formulaHtml,
    fifoLossByDate,
    loadExempt, isExempt, isLineExempt, toggleExempt, exemptSummary,
    matchBox, tradeSig,
    detectConflicts,
    hashRules, appendRulesHistory, versionSegments, readCases,
    renderLineExtra, renderRulesBottom, renderReportBottom,
    windowHit, windowMapFor, spanDays, noteAck, buildChain, hookAck, fmtDay,
    _boxes: () => boxesCache,
  };
});
