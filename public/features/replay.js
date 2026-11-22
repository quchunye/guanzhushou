// RPL-1 阶段3：股票回放（panji.replay.v1 最小实现）
// 内置 SAMPLE 为虚构代码 KX0001 的合成走势；真实行情只能由用户自带文件导入（见 kline_import.js）
// 硬规则：训练视图只渲染 t ≤ visibleUntil 的 K 线；visibleUntil 必须 ≤ 该笔成交时刻 at
// 边界：只读账本（不写回）、不抓实时、不订阅、不做定时任务
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PanjiReplay = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  const SCHEMA = 'panji.replay.v1';
  const BAR_MIN = 5;
  // K 线 t = 该根 K 线的“结束时刻”（交易所本地时间，12 位）；首根覆盖 09:30 集合竞价

  /* ---------- 合成示意数据（默认模式：零真实行情依赖） ----------
     上线默认只展示这里生成的走势：固定种子、可复现、不出现真实票号与真实日期。
     真实离线包（public/data/kline）只在研发开关 f=real 打开时才请求。 */
  const SYNTH_TAG = '合成走势 · 非真实数据';
  const SYNTH_SYMBOLS = [
    { symbol: 'syn001', name: '合成样本甲', base: 9.8, seed: 101 },
    { symbol: 'syn002', name: '合成样本乙', base: 24.6, seed: 202 },
    { symbol: 'syn003', name: '合成样本丙', base: 41.5, seed: 303 },
  ];
  // 非真实日期（年 0001），仅用来给每根 K 线一个唯一有序时间戳
  const SYNTH_DAYS = ['00010101', '00010102', '00010103'];
  const SYNTH_MONTH = '0001-01';

  function lcg(seed) {
    let s = seed >>> 0;
    return function () { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
  }

  function synthTimes() {
    const out = [];
    for (let m = 575; m <= 690; m += 5) out.push((m / 60 | 0) * 100 + m % 60);  // 09:35 ~ 11:30
    for (let m = 785; m <= 900; m += 5) out.push((m / 60 | 0) * 100 + m % 60);  // 13:05 ~ 15:00
    return out;
  }

  // 一天 48 根：前段趋势 → 中段震荡 → 尾段假突破后回落
  function synthBars(symbol, day) {
    const meta = SYNTH_SYMBOLS.filter((x) => x.symbol === symbol)[0] || SYNTH_SYMBOLS[0];
    const r = lcg(meta.seed ^ (Number(day) || 1));
    const times = synthTimes();
    const rows = [];
    let price = meta.base;
    for (let i = 0; i < times.length; i++) {
      const seg = i < 16 ? 1 : (i < 32 ? 2 : 3);
      let mu = 0, vol = 0.004;
      if (seg === 1) mu = 0.0012;                        // 趋势
      else if (seg === 2) mu = -0.0003;                  // 震荡
      else { mu = i < 40 ? 0.0022 : -0.0030; vol = 0.009; }  // 假突破 + 回落
      const shock = (r() - 0.5) * 2 * vol + (r() - 0.5) * vol;
      const open = price;
      const close = Math.max(0.01, open * (1 + mu + shock));
      const wick = open * vol * (0.3 + r());
      const high = Math.max(open, close) + wick * r();
      const low = Math.max(0.01, Math.min(open, close) - wick * r());
      const v = Math.round(120000 + r() * 900000 + Math.abs(shock) * 8e7);
      rows.push([day + ('0000' + times[i]).slice(-4),
        open.toFixed(2), high.toFixed(2), low.toFixed(2), close.toFixed(2), v].join(','));
      price = close;
    }
    return rows;
  }

  function synthTrades(symbol, day) {
    const kl = parseKlines(synthBars(symbol, day));
    if (!kl) return [];
    const d10s = day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6, 8);
    return [12, 30, 41].map((idx, i) => {
      const b = kl[idx] || kl[kl.length - 1];
      const t = String(b.t);
      return {
        date: d10s, time: t.slice(8, 10) + ':' + t.slice(10, 12),
        code: symbol, name: '合成样本',
        side: i % 2 === 0 ? '动手' : '不动手', price: b.c,
      };
    });
  }

  // 内置演示样本（虚构代码 + 合成走势，不含任何真实票与真实日期）
  const SAMPLE = {
    symbol: 'KX0001', market: 'syn', name: '合成样本丁', timeframe: '5m',
    days: SYNTH_DAYS.slice(),
    raw: SYNTH_DAYS.reduce((a, d) => a.concat(synthBars('KX0001', d)), []),
  };

  // 默认页（逐笔回放）用的合成回放：形状与真实 load() 完全一致
  function loadSynth(symbol, day) {
    const meta = SYNTH_SYMBOLS.filter((x) => x.symbol === symbol)[0] || SYNTH_SYMBOLS[0];
    const sym = meta.symbol;
    const d = SYNTH_DAYS.indexOf(day) >= 0 ? day : SYNTH_DAYS[0];
    return load(sym, d, {
      klines: synthBars(sym, d), trades: synthTrades(sym, d),
      timeframe: '5m', adjust: 'synthetic', name: meta.name,
    });
  }

  function synthMeta() {
    return { tag: SYNTH_TAG, days: SYNTH_DAYS.slice(), symbols: SYNTH_SYMBOLS.slice() };
  }

  // 与真实 index.json 同形（前端走同一套 picker / 空态判断）
  function synthIndex() {
    const symbols = {};
    SYNTH_SYMBOLS.forEach((s) => { symbols[s.symbol] = { name: s.name, months: [SYNTH_MONTH] }; });
    const months = {};
    months[SYNTH_MONTH] = { stocks: SYNTH_SYMBOLS.length, trading_days: SYNTH_DAYS.length, files: 0, bytes: 0 };
    return {
      schema: PACK_SCHEMA, version: 'synthetic', synthetic: true, note: SYNTH_TAG,
      timeframe: '5m', barMinutes: BAR_MIN, adjust: 'synthetic', unit: 'share',
      layout: PACK_LAYOUT, months, symbols,
      total_files: 0, total_bytes: 0, excluded_days: [], missing_months: [],
    };
  }

  // 与真实月包同形的合成包（tab a/b 共用）
  function synthPack(symbol, month) {
    const meta = SYNTH_SYMBOLS.filter((x) => x.symbol === symbol)[0] || SYNTH_SYMBOLS[0];
    let all = [];
    SYNTH_DAYS.forEach((d) => { all = all.concat(synthBars(meta.symbol, d)); });
    const klines = parseKlines(all);
    if (!klines) return null;
    return {
      schema: PACK_SCHEMA, symbol: meta.symbol, name: meta.name,
      month: month || SYNTH_MONTH, timeframe: '5m', adjust: 'synthetic',
      unit: 'share', synthetic: true, klines,
    };
  }

  /* ---------- 时间工具 ---------- */
  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function t12(v) { const s = digits(v); return s.length >= 12 ? s.slice(0, 12) : s; }
  function day8(t) { return String(t || '').slice(0, 8); }
  function minOf(t) { return (+String(t).slice(8, 10)) * 60 + (+String(t).slice(10, 12)); }
  function d10(day) {
    const s = digits(day);
    return s.length >= 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '—';
  }
  // trade 的 date(YYYY-MM-DD) + time(HH:MM[:SS]) → 12 位 at
  function tOf(date, time) {
    const d = digits(date).slice(0, 8);
    const hm = digits(time).padEnd(4, '0').slice(0, 4);
    if (d.length !== 8 || hm.length !== 4) return '';
    return d + hm;
  }

  /* ---------- K 线解析 / 校验 ---------- */
  function parseKlines(list) {
    if (!list) return null;
    const rows = Array.isArray(list) ? list : String(list).split(/\s+/).filter(Boolean);
    const out = [];
    const seen = Object.create(null);
    for (const row of rows) {
      const p = typeof row === 'string' ? row.split(',') : null;
      if (!p || p.length < 6) return null;
      const t = t12(p[0]);
      const o = +p[1], h = +p[2], l = +p[3], c = +p[4], v = +p[5];
      if (t.length !== 12 || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0) || !(v >= 0)) return null;
      if (h < Math.max(o, c) || l > Math.min(o, c)) return null;
      if (seen[t]) return null;            // 重复
      seen[t] = 1;
      out.push({ t, o, h, l, c, v });
    }
    out.sort((a, b) => (a.t < b.t ? -1 : (a.t > b.t ? 1 : 0)));
    if (!out.length) return null;
    return out;
  }

  // 每根 K 线的区间起点（分钟）：同一交易日内取上一根的结束时刻；
  // 当日首根按 09:30（覆盖集合竞价）；午休后的首根按 13:00
  function barStart(klines, i, barMin) {
    const stepMin = +(barMin || BAR_MIN);
    const e = minOf(klines[i].t);
    if (i > 0 && day8(klines[i - 1].t) === day8(klines[i].t)) {
      const prev = minOf(klines[i - 1].t);
      return (e - prev > stepMin + 5) ? e - stepMin : prev;
    }
    return Math.max(570, e - stepMin);
  }

  // 成交时刻归属的 K 线：区间内命中优先；午休/收盘后回落到最近一根（gap=true）
  function locate(at, klines, barMin) {
    const d = day8(at), m = minOf(at);
    let last = -1;
    for (let i = 0; i < klines.length; i++) {
      const b = klines[i];
      if (day8(b.t) !== d) continue;
      const s = barStart(klines, i, barMin), e = minOf(b.t);
      if (m >= s && m <= e) return { idx: i, bar: b, gap: false };
      if (e <= m) last = i;
    }
    if (last >= 0) return { idx: last, bar: klines[last], gap: true };
    return null;
  }

  // 此刻允许看到的最后一根（已收盘的）K 线：t ≤ at；没有则空串
  function visibleUntilOf(at, klines) {
    let vu = '';
    for (const b of klines) {
      if (b.t <= at) vu = b.t;
      else break;
    }
    return vu;
    }

  function sliceVisible(klines, vu) {
    return (klines || []).filter((b) => !vu || b.t <= vu);
  }

  /* ---------- checkpoint ---------- */
  function buildCheckpoints(trades, klines, barMin) {
    const cps = [];
    for (let i = 0; i < trades.length; i++) {
      const tr = trades[i] || {};
      const at = tOf(tr.date, tr.time);
      if (!at || at.length !== 12) return null;
      const loc = locate(at, klines, barMin);
      if (!loc) return null;                       // at 不落在任何 K 线区间内
      const vu = visibleUntilOf(at, klines);
      if (vu && !(vu <= at)) return null;          // 硬规则 visibleUntil ≤ at
      const price = +tr.price;
      if (price > 0) {                             // 成交价偏离该根 [l,h] 超 5% → 数据错误
        const far = price > loc.bar.h ? (price - loc.bar.h) / loc.bar.h
          : (price < loc.bar.l ? (loc.bar.l - price) / loc.bar.l : 0);
        if (far > 0.05) return null;
      }
      const side = String(tr.side || tr.direction || '');
      cps.push({
        seq: cps.length,
        tradeIdx: i,
        kind: (side.indexOf('卖') >= 0 || side.indexOf('收手') >= 0 || side.indexOf('不动手') >= 0) ? 'sell_out' : 'buy_in',
        at,
        barT: loc.bar.t,
        visibleUntil: vu,
      });
    }
    return cps.length ? cps : null;
  }

  function validateReplay(r) {
    if (!r || !Array.isArray(r.klines) || !r.klines.length) return false;
    for (let i = 1; i < r.klines.length; i++) if (!(r.klines[i - 1].t < r.klines[i].t)) return false;
    if (!Array.isArray(r.checkpoints) || !r.checkpoints.length) return false;
    for (const c of r.checkpoints) {
      if (!(c.at && c.at.length === 12)) return false;
      if (c.visibleUntil && !(c.visibleUntil <= c.at)) return false;
      if (!locate(c.at, r.klines, r.barMinutes)) return false;
    }
    return true;
  }

  /* ---------- 读账本（只读） ---------- */
  /* ---------- 读账本（只读） ---------- */
  // 账本里代码可能是裸 6 位，也可能带 sh/sz/bj 前缀；统一成带前缀
  function normSym(code) {
    const s = String(code == null ? '' : code).trim().toLowerCase();
    if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
    if (/^\d{6}$/.test(s)) {
      if (/^(60|68|90|50|51|58)/.test(s)) return 'sh' + s;
      if (/^(4|8|92)/.test(s)) return 'bj' + s;
      return 'sz' + s;
    }
    if (/^[a-z][a-z0-9]{2,}$/.test(s)) return s;   // 虚构/演示代码（如 KX0001）原样保留
    return '';
  }

  // localStorage 句柄：浏览器里取 window，Node 测试可用 globalThis.localStorage 注入夹具
  function getStore() {
    try { if (root && root.localStorage) return root.localStorage; } catch (e) { /* 私密模式抛错 */ }
    try {
      if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function ledgerTrades() {
    try {
      const st = getStore();
      const raw = st ? st.getItem('guanzhu_ledger') : null;
      if (!raw) return [];
      const led = JSON.parse(raw);
      return led && Array.isArray(led.trades) ? led.trades : [];
    } catch (e) { return []; }
  }

  // 是否有可用档案：至少一条带日期的成交记录（不含任何内容，只看有没有）
  function hasArchive(trades) {
    const list = Array.isArray(trades) ? trades : ledgerTrades();
    return list.some((t) => t && digits(t.date).length >= 8);
  }

  function readTrades(symbol, day) {
    try {
      const st = getStore();
      const raw = st ? st.getItem('guanzhu_ledger') : null;
      if (!raw) return [];
      const led = JSON.parse(raw);
      const want = digits(day).slice(0, 8);
      const sym = normSym(symbol);
      return ((led && led.trades) || []).filter((t) => t
        && normSym(t.code) === sym
        && digits(t.date).slice(0, 8) === want)
        .map((t) => ({
          date: t.date, time: t.time, code: t.code, name: t.name,
          side: t.side, qty: t.qty, price: t.price, amount: t.amount,
        }));
    } catch (e) { return []; }
  }

  /* ---------- load ---------- */
  // opts 仅用于测试/离线导入：{ klines, trades }；不传则用内置样本 + 本地账本
  function load(symbol, date, opts) {
    try {
      const o = opts || {};
      const sym = String(symbol == null ? '' : symbol).trim();
      const day = digits(date);
      if (!sym || day.length !== 8) return null;
      let klines = null;
      let market = 'sz';
      let name = typeof o.name === 'string' ? o.name.trim() : '';
      if (o.klines) {
        klines = parseKlines(o.klines);
      } else if (sym === SAMPLE.symbol && SAMPLE.days.indexOf(day) >= 0) {
        klines = parseKlines(SAMPLE.raw);
        market = SAMPLE.market;
        name = SAMPLE.name;
      }
      if (!klines) return null;
      // 单日回放：只保留所请求交易日的 K 线（跨日样本不混进同一张图）
      const dayK = klines.filter((b) => day8(b.t) === day);
      if (dayK.length) klines = dayK;
      const trades = o.trades != null ? o.trades : readTrades(sym, day);
      if (!Array.isArray(trades) || !trades.length) return null;
      const cps = buildCheckpoints(trades, klines);
      if (!cps) return null;
      const replay = {
        schema: SCHEMA,
        symbol: sym,
        market,
        date: day,
        timeframe: o.timeframe || SAMPLE.timeframe,
        adjust: o.adjust || (o.klines ? 'none' : (sym === SAMPLE.symbol ? 'synthetic' : 'qfq')),
        klines,
        trades: trades.map((t) => Object.assign({}, t)),
        checkpoints: cps,
      };
      if (name) replay.name = name;
      return validateReplay(replay) ? replay : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- 训练视图（防未来函数的唯一出口） ---------- */
  function afterBars(replay, seq) {
    const cp = replay.checkpoints[seq];
    const next = replay.checkpoints[seq + 1];
    const day = day8(cp.at);
    const end = (next && next.visibleUntil && day8(next.visibleUntil) === day)
      ? next.visibleUntil : day + '1500';
    return replay.klines.filter((b) => b.t > cp.visibleUntil && b.t <= end);
  }

  function actualResult(replay, cp, after) {
    const tr = replay.trades[cp.tradeIdx] || {};
    const price = +tr.price || 0;
    if (price <= 0) return null;
    let exit = null;
    for (let i = cp.seq + 1; i < replay.checkpoints.length; i++) {
      const c = replay.checkpoints[i];
      if (c.kind !== cp.kind) { exit = c; break; }
    }
    const exitTrade = exit ? replay.trades[exit.tradeIdx] : null;
    if (exitTrade && +exitTrade.price > 0) {
      return {
        mode: 'trade', price: +exitTrade.price,
        pct: +((( +exitTrade.price - price) / price) * 100).toFixed(2),
        at: exit.at,
      };
    }
    const bars = after || [];
    if (bars.length) {
      const last = bars[bars.length - 1];
      return {
        mode: 'close', price: last.c,
        pct: +(((last.c - price) / price) * 100).toFixed(2),
        at: last.t,
      };
    }
    return null;
  }

  // choice 为空 → 未揭示（after 必须为空、actual 必须为 null）；'do' / 'wait' → 揭示后续
  function trainView(replay, seq, choice) {
    if (!replay || !Array.isArray(replay.checkpoints)) return null;
    const cp = replay.checkpoints[seq];
    if (!cp) return null;
    const tr = replay.trades[cp.tradeIdx] || {};
    const visible = sliceVisible(replay.klines, cp.visibleUntil);
    const v = {
      seq,
      checkpoint: cp,
      visibleUntil: cp.visibleUntil,
      maxVisibleT: visible.length ? visible[visible.length - 1].t : '',
      visible,
      marker: {
        at: cp.at, kind: cp.kind,
        price: +tr.price || 0, qty: +(tr.qty || 0), name: tr.name || '',
      },
      question: '这一刻你会不会动手',
      choices: [{ key: 'do', label: '动手' }, { key: 'wait', label: '不动手' }],
      revealed: false,
      choice: '',
      after: [],
      actual: null,
    };
    if (choice === 'do' || choice === 'wait') {
      v.revealed = true;
      v.choice = choice;
      v.after = afterBars(replay, seq);
      v.actual = actualResult(replay, cp, v.after);
    }
    return v;
  }

  // 读某月 manifest（gz），给真实模式的票池下拉用；无索引时返回 null
  async function loadManifest(month, opts) {
    const o = opts || {};
    const f = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!f) return null;
    try {
      const res = await f((o.base || PACK_BASE) + 'manifest?month=' + encodeURIComponent(month)
        + '&v=' + encodeURIComponent(o.version || INDEX_VERSION || PACK_VERSION), { headers: await klineAuthHeaders(o) });
      if (!res || !res.ok) return null;
      const text = await gunzipText(await res.arrayBuffer());
      if (!text) return null;
      const man = JSON.parse(text);
      return (man && man.entries) || null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- 离线包（服务端只读路由 /api/kline，数据不在 public 直出目录） ---------- */
  const PACK_BASE = 'api/kline/';
  const PACK_SCHEMA = 'panji.klines.v1';
  // index 走 no-cache；月包/清单走 immutable，必须带版本号换缓存键，
  // 否则老用户的浏览器会一直用旧包。月包实际用 index 里的 version，
  // 这里的常量只做 index 请求的 cache-buster，发布后应与 index.version 同步。
  const PACK_VERSION = 'v202611050639';
  const PACK_LAYOUT = '5m/{symbol}/{month}.json.gz';

  /* ---------- 档案令牌：scope 由本机账本推导，payload 本地组装、服务端签名 ---------- */
  // 令牌只含 symbol|month 白名单与过期时间，不含成交、价格、姓名等任何账本内容。
  const TOKEN_STORE_KEY = 'panji_kline_token';
  // B5：会话令牌由登录页写入。为空表示未登录，行情令牌按「匿名」签发（服务端默认仍放行）。
  const SESSION_STORE_KEY = 'guanzhu_session_v1';
  let TOKEN_MEM = null;

  function sessionToken() {
    try {
      const st = getStore();
      const v = st ? st.getItem(SESSION_STORE_KEY) : null;
      return typeof v === 'string' && v ? v : '';
    } catch (e) { return ''; }
  }

  // 只读 payload 里的 sub 做缓存键，不验签——验签是服务端的事，前端拿它当分区标识
  function sessionSub(tok) {
    const a = String(tok || '').split('.');
    if (a.length !== 3 || a[0] !== 'pjs1') return '';
    try {
      let s = a[1].replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      const p = JSON.parse(atob(s));
      return typeof p.sub === 'string' ? p.sub : '';
    } catch (e) { return ''; }
  }

  function ledgerScope(trades) {
    let led = null;
    if (Array.isArray(trades)) led = { trades };
    else {
      try { const st = getStore(); led = st ? JSON.parse(st.getItem('guanzhu_ledger') || 'null') : null; } catch (e) { led = null; }
    }
    const out = [];
    const seen = Object.create(null);
    ((led && led.trades) || []).forEach((t) => {
      const sym = normSym(t && t.code);
      const d = digits(t && t.date).slice(0, 8);
      if (!sym || d.length !== 8) return;
      const month = d.slice(0, 4) + '-' + d.slice(4, 6);
      if (!/^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$/.test(month)) return;
      const item = sym + '|' + month;
      if (seen[item]) return;
      seen[item] = 1;
      out.push(item);
    });
    return out.sort().slice(0, 200);
  }

  // 账本指纹：只用排序后的白名单算短 hash（FNV-1a 32 位转 8 位十六进制）。
  // 同一账本每算每同，换账本必变；用于给 immutable 的月包换缓存键。
  function scopeHash(list) {
    const s = (Array.isArray(list) ? list.slice() : []).sort().join(',');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  // 与 ensureToken 用的是同一份 scope：显式 o.scope 优先，否则由本机账本推导
  function packFingerprint(opts) {
    const o = opts || {};
    const scope = Array.isArray(o.scope) ? o.scope.slice() : ledgerScope(o.trades);
    return scope.length ? scopeHash(scope) : '';
  }

  function clearToken() {
    TOKEN_MEM = null;
    try { const st = getStore(); if (st) st.removeItem(TOKEN_STORE_KEY); } catch (e) { /* 忽略 */ }
  }

  // 无账本或服务端不可用时返回 ''，调用方必须降级为合成数据，不能把空当真实行情
  async function ensureToken(opts) {
    const o = opts || {};
    if (o.token) return String(o.token);
    const scope = Array.isArray(o.scope) ? o.scope.slice() : ledgerScope(o.trades);
    if (!scope.length) return '';
    const sess = sessionToken();
    // 缓存键加 sub：换账号必须重新取令牌，不能沿用上一个账号的 scope 白名单
    const key = (sessionSub(sess) || 'anon') + '|' + scope.join(',');
    const nowSec = Date.now() / 1000;
    if (TOKEN_MEM && TOKEN_MEM.key === key && +TOKEN_MEM.exp > nowSec + 60) return TOKEN_MEM.token;
    try {
      const st = getStore();
      const cached = st ? JSON.parse(st.getItem(TOKEN_STORE_KEY) || 'null') : null;
      if (cached && cached.key === key && typeof cached.token === 'string' && +cached.exp > nowSec + 60) {
        TOKEN_MEM = cached;
        return cached.token;
      }
    } catch (e) { /* 坏缓存忽略 */ }
    const f = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null)
      || (typeof fetch === 'function' ? fetch : null);
    if (!f) return '';
    try {
      const headers = { 'content-type': 'application/json' };
      if (sess) headers['authorization'] = 'Bearer ' + sess;
      const res = await f((o.base || PACK_BASE) + 'token', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ scope }),
      });
      if (!res || !res.ok || typeof res.json !== 'function') return '';
      const obj = await res.json();
      if (!obj || typeof obj.token !== 'string' || !obj.token) return '';
      TOKEN_MEM = { key, token: obj.token, exp: +obj.exp || 0 };
      try { const st = getStore(); if (st) st.setItem(TOKEN_STORE_KEY, JSON.stringify(TOKEN_MEM)); } catch (e) { /* 私密模式忽略 */ }
      return obj.token;
    } catch (e) {
      return '';
    }
  }

  async function klineAuthHeaders(opts) {
    const t = await ensureToken(opts);
    return t ? { 'x-kline-token': t } : {};
  }

  function packPath(sym, month) {
    return PACK_LAYOUT.replace('{symbol}', sym).replace('{month}', month);
  }

  // 纯 JS 的 gzip 解压：只依赖 Uint8Array，给没有 DecompressionStream 的旧 WebView 兜底。
  // 数据路径不能对浏览器 API 做硬依赖——缺一个 API 就整块内置行情空白，代价太大。
  function panjiGunzip(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let p0 = 0;
    if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
      const flg = u8[3];
      p0 = 10;
      if (flg & 4) { const xlen = (u8[p0] | 0) | ((u8[p0 + 1] | 0) << 8); p0 += 2 + xlen; }
      if (flg & 8) { while (p0 < u8.length && u8[p0] !== 0) p0++; p0++; }
      if (flg & 16) { while (p0 < u8.length && u8[p0] !== 0) p0++; p0++; }
      if (flg & 2) p0 += 2;
    }
    let bp = p0 * 8;

    function bits(n) {
      const bs = bp >> 3;
      const off = bp & 7;
      const v = ((u8[bs] | 0) | ((u8[bs + 1] | 0) << 8) | ((u8[bs + 2] | 0) << 16)) >>> off;
      bp += n;
      return v & ((1 << n) - 1);
    }

    let out = new Uint8Array(1 << 18);
    let op = 0;
    function put(b) {
      if (op >= out.length) {
        const nb = new Uint8Array(out.length * 2);
        nb.set(out);
        out = nb;
      }
      out[op++] = b;
    }

    function huff(lengths) {
      let maxL = 0;
      for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxL) maxL = lengths[i];
      const counts = new Uint16Array(maxL + 1);
      for (let i = 0; i < lengths.length; i++) if (lengths[i]) counts[lengths[i]]++;
      const offs = new Uint16Array(maxL + 2);
      for (let i = 1; i <= maxL; i++) offs[i] = offs[i - 1] + counts[i - 1];
      const sym = new Uint16Array(lengths.length);
      for (let i = 0; i < lengths.length; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
      return function () {
        let code = 0;
        let first = 0;
        let index = 0;
        for (let len = 1; len <= maxL; len++) {
          code |= bits(1);
          const count = counts[len];
          if (code - count < first) return sym[index + (code - first)];
          index += count;
          first = (first + count) << 1;
          code <<= 1;
        }
        throw new Error('bad huffman');
      };
    }

    const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

    let fixedLit = null;
    let fixedDist = null;
    function fixedHuffs() {
      if (fixedLit) return;
      const l = new Uint8Array(288);
      let i;
      for (i = 0; i < 144; i++) l[i] = 8;
      for (i = 144; i < 256; i++) l[i] = 9;
      for (i = 256; i < 280; i++) l[i] = 7;
      for (i = 280; i < 288; i++) l[i] = 8;
      fixedLit = huff(l);
      const d = new Uint8Array(30);
      for (i = 0; i < 30; i++) d[i] = 5;
      fixedDist = huff(d);
    }

    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bp = (bp + 7) & ~7;
        let at = bp >> 3;
        const len = (u8[at] | 0) | ((u8[at + 1] | 0) << 8);
        const nlen = (u8[at + 2] | 0) | ((u8[at + 3] | 0) << 8);
        if ((len ^ 0xffff) !== nlen) throw new Error('stored len mismatch');
        at += 4;
        for (let s = 0; s < len; s++) put(u8[at + s] | 0);
        bp = (at + len) * 8;
      } else if (type === 1 || type === 2) {
        let lit;
        let dist;
        if (type === 1) {
          fixedHuffs();
          lit = fixedLit;
          dist = fixedDist;
        } else {
          const hlit = bits(5) + 257;
          const hdist = bits(5) + 1;
          const hclen = bits(4) + 4;
          const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
          const clen = new Uint8Array(19);
          for (let ci = 0; ci < hclen; ci++) clen[order[ci]] = bits(3);
          const clh = huff(clen);
          const lens = new Uint8Array(hlit + hdist);
          let li = 0;
          while (li < lens.length) {
            const c = clh();
            if (c < 16) lens[li++] = c;
            else if (c === 16) {
              let rep = 3 + bits(2);
              const prev = lens[li - 1];
              while (rep--) lens[li++] = prev;
            } else if (c === 17) {
              let rep = 3 + bits(3);
              while (rep--) lens[li++] = 0;
            } else {
              let rep = 11 + bits(7);
              while (rep--) lens[li++] = 0;
            }
          }
          lit = huff(lens.subarray(0, hlit));
          dist = huff(lens.subarray(hlit, hlit + hdist));
        }
        for (;;) {
          const sym = lit();
          if (sym < 256) put(sym);
          else if (sym === 256) break;
          else {
            const li = sym - 257;
            const length = LBASE[li] + bits(LEXT[li]);
            const ds = dist();
            const distance = DBASE[ds] + bits(DEXT[ds]);
            const from = op - distance;
            if (from < 0) throw new Error('bad distance');
            for (let k = 0; k < length; k++) put(out[from + k]);
          }
        }
      } else {
        throw new Error('bad block type');
      }
    }
    return out.subarray(0, op);
  }

  // 优先原生 DecompressionStream（快）；没有或抛错都退回纯 JS，绝不因缺 API 直接返回 null
  async function gunzipText(buf) {
    if (!buf) return null;
    try {
      if (typeof Response !== 'undefined' && typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined') {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
        const txt = await new Response(stream).text();
        if (txt) return txt;
      }
    } catch (e) { /* 落到纯 JS 分支 */ }
    try {
      const bytes = panjiGunzip(buf);
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return decodeURIComponent(escape(s));
    } catch (e) {
      return null;
    }
  }

  // 异步读一个月包；失败一律 null，不抛异常（缺月由调用方降级）
  async function loadPack(sym, month, opts) {
    try {
      const o = opts || {};
      const f = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
      if (!f || !sym || !month) return null;
      // s = 账本指纹：月包是 immutable 长缓存，换账本但 URL 不变会命中旧账本的包，故带上它换缓存键。
      // index/manifest 是 no-store，不需要这个参数。
      const url = (o.base || PACK_BASE) + 'pack?symbol=' + encodeURIComponent(sym)
        + '&month=' + encodeURIComponent(month)
        + '&v=' + encodeURIComponent(o.version || INDEX_VERSION || PACK_VERSION)
        + '&s=' + encodeURIComponent(packFingerprint(o));
      const res = await f(url, { headers: await klineAuthHeaders(o) });
      if (!res || !res.ok) return null;
      const text = await gunzipText(await res.arrayBuffer());
      if (!text) return null;
      const obj = JSON.parse(text);
      if (!obj || obj.schema !== PACK_SCHEMA || obj.symbol !== sym || obj.month !== month) return null;
      const klines = parseKlines(obj.bars);
      if (!klines) return null;
      return {
        schema: PACK_SCHEMA, symbol: sym, name: obj.name || '',
        month, timeframe: obj.timeframe || '5m', adjust: obj.adjust || 'none',
        klines,
      };
    } catch (e) { return null; }
  }

  /* ---------- C 我的单子当题：只做分钟级，命中不了就诚实空态 ---------- */
  // 顶层覆盖清单（小文件，命中判断用；失败返回 null，不许靠猜）
  let INDEX_CACHE = null;
  let INDEX_VERSION = '';   // 读到的 index.version，用于给月包换缓存键
  async function loadIndex(opts) {
    if (INDEX_CACHE) return INDEX_CACHE;
    try {
      const o = opts || {};
      const f = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
      if (!f) return null;
      const res = await f((o.base || PACK_BASE) + 'index?v='
        + encodeURIComponent(o.version || PACK_VERSION), { headers: await klineAuthHeaders(o) });
      if (!res || !res.ok) return null;
      const obj = JSON.parse(await res.text());
      if (!obj || !obj.months) return null;
      INDEX_CACHE = obj;
      if (obj.version) INDEX_VERSION = String(obj.version);
      return obj;
    } catch (e) { return null; }
  }

  function levelText(adjust, tf) {
    return (tf === '1m' ? '1 分钟级' : '5 分钟级') + ' · ' + (adjust === 'qfq' ? '前复权' : '不复权');
  }

  /* ---------- 除权事件表：只标不改价，1m 与 5m 共用同一张表 ----------
     表在 builtin/corp_actions.json（随包分发，且不在 /builtin/index.json 与
     /builtin/pack/ 的签名守卫里），按「6 位代码 + 交易日」索引。
     命中只在图上加标记与一句说明，绝不改动任何 bar 的价格；
     表没加载、格式不对、没命中，一律返回 null，不猜不补。 */
  const CORP_BASE = 'builtin/';
  const CORP_SCHEMA = 'panji.corp.actions.v1';
  let CORP_TABLE = null;    // { '002594': { '20250729': { type, label } } }
  let CORP_PENDING = null;

  function indexCorpActions(obj) {
    const m = Object.create(null);
    if (!obj || !Array.isArray(obj.events)) return m;
    obj.events.forEach((e) => {
      if (!e) return;
      const code = digits(e.symbol).slice(-6);
      const day = digits(e.date).slice(0, 8);
      if (code.length !== 6 || day.length !== 8) return;
      if (!m[code]) m[code] = Object.create(null);
      m[code][day] = { type: e.type || 'event', label: String(e.label || obj.label || '') };
    });
    return m;
  }

  function loadCorpActions(opts) {
    if (CORP_TABLE) return Promise.resolve(CORP_TABLE);
    if (CORP_PENDING) return CORP_PENDING;
    const o = opts || {};
    const f = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!f) return Promise.resolve(null);
    CORP_PENDING = Promise.resolve()
      .then(() => f((o.base || CORP_BASE) + 'corp_actions.json', { cache: 'no-cache' }))
      .then((res) => (res && res.ok ? res.json() : null))
      .then((obj) => {
        if (!obj || obj.schema !== CORP_SCHEMA) return null;
        CORP_TABLE = indexCorpActions(obj);
        return CORP_TABLE;
      })
      .catch(() => null)
      .then((v) => { CORP_PENDING = null; return v; });
    return CORP_PENDING;
  }

  // 某只票某天的除权事件；没命中返回 null
  function corpEventOf(symbol, day) {
    if (!CORP_TABLE) return null;
    const row = CORP_TABLE[digits(symbol).slice(-6)];
    return (row && row[digits(day).slice(0, 8)]) || null;
  }

  /* ---------- 内置历史回放分片（商店包读本地资源；线上走签名地址） ---------- */
  const BUILTIN_BASE = 'builtin/';
  const BUILTIN_INDEX_SCHEMA = 'panji.builtin.index.v1';
  let BUILTIN_INDEX_CACHE = null;

  /* ---------- 分片失败态：四种人话，禁止出现「数据加载失败」 ----------
     口径（20261107 实测）：单票日线约 10 KB；分钟单片 222 KB、同票两窗口 449 KB。
     12 s 阈值的依据：300 kbps 下单窗口分钟片实测 7.39 s，留约 60% 余量给慢启动与 RTT；
     486 KB 明文索引在 300 kbps 下要 13.2 s，故意不被 12 s 覆盖——那是「首屏拉目录」要解决的问题，
     不靠放大超时掩盖。 */
  const BUILTIN_TIMEOUT_MS = 12000;
  const BUILTIN_FAIL_COPY = Object.freeze({
    load: '这只票的走势没读到。先给你看合成示意（不是真实数据）；再点一次这只票就会重拉。',
    timeout: '网太慢，这只票的走势没赶上。先看示意，网好点再点这只票。',
    forbidden: '数据通行证过期了，重新进一次回放页就行。',
    no_shard: '这只票这段没有可回放的走势，换一只。',
  });
  function builtinFailCopy(code) {
    return BUILTIN_FAIL_COPY[code] || BUILTIN_FAIL_COPY.load;
  }

  // 线上静态守卫要求 ?e=<exp>&s=<sig>；本地/商店包没有 ticket 时保持原地址不变
  function resolveBuiltinTicket(opts) {
    const t = opts && opts.ticket;
    if (!t) return Promise.resolve(null);
    if (typeof t === 'function') {
      return Promise.resolve().then(() => t()).then((v) => (v && v.exp && v.sig ? v : null)).catch(() => null);
    }
    return Promise.resolve(t.exp && t.sig ? t : null);
  }

  function builtinUrl(base, rel, ticket) {
    const url = base + rel;
    if (!ticket || !ticket.exp || !ticket.sig) return url;
    const sep = rel.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'e=' + encodeURIComponent(ticket.exp) + '&s=' + encodeURIComponent(ticket.sig);
  }

  /* ---------- 内置分片缓存（20261107）----------
     两级：页内内存 Map（L1，存解析后的 pack）→ IndexedDB（L2，存 gzip 原始字节）。
     键一律带内容版本：builtin/<version>/<code>.<win>，版本变了自然全批失效，不写清理逻辑。
     地址改走 /builtin/pack/<version>/<sig>/<code>.<win>.gz，sig 由服务端从版本派生、长期不变，
     所以同一版本的分片 URL 恒定，HTTP 缓存 + IndexedDB 都能命中；旧 ?e=&s= 60 秒票据形仅作回落。 */
  const BUILTIN_IDB_NAME = 'panji_builtin';
  const BUILTIN_IDB_STORE = 'packs';
  const BUILTIN_MEM = new Map();
  const BUILTIN_MEM_MAX = 24;

  function builtinCacheKey(ver, code, win) {
    return 'builtin/' + (ver || 'unknown') + '/' + code + '.' + win;
  }

  // 版本化地址；索引里没有 packSig（旧包/商店包/测试）时返回空串，调用方回落旧形态
  function builtinPackUrl(base, idx, code, win) {
    const ver = idx && idx.version ? String(idx.version) : '';
    const sig = idx && idx.packSig ? String(idx.packSig) : '';
    if (!ver || !sig) return '';
    return (base || BUILTIN_BASE) + 'pack/' + encodeURIComponent(ver) + '/' + sig + '/' + code + '.' + win + '.json.gz';
  }

  function builtinMemGet(key) {
    if (!BUILTIN_MEM.has(key)) return null;
    const v = BUILTIN_MEM.get(key);
    BUILTIN_MEM.delete(key);          // 轻量 LRU：命中的挪到队尾
    BUILTIN_MEM.set(key, v);
    return v;
  }
  function builtinMemPut(key, pack) {
    if (!key) return;
    BUILTIN_MEM.delete(key);
    BUILTIN_MEM.set(key, pack);
    while (BUILTIN_MEM.size > BUILTIN_MEM_MAX) BUILTIN_MEM.delete(BUILTIN_MEM.keys().next().value);
  }

  function builtinIdbOpen() {
    const g = root && (root.indexedDB || root.webkitIndexedDB || root.mozIndexedDB);
    if (!g) return Promise.resolve(null);
    return new Promise((resolve) => {
      let req;
      try { req = g.open(BUILTIN_IDB_NAME, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (db && !db.objectStoreNames.contains(BUILTIN_IDB_STORE)) db.createObjectStore(BUILTIN_IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    }).catch(() => null);
  }

  // 命中返回 gzip 原始字节（ArrayBuffer），miss 返回 null；IDB 不可用一律当 miss，不抛
  function builtinIdbGet(key) {
    if (!key) return Promise.resolve(null);
    return builtinIdbOpen().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(BUILTIN_IDB_STORE, 'readonly');
          const rq = tx.objectStore(BUILTIN_IDB_STORE).get(key);
          rq.onsuccess = () => resolve(rq.result || null);
          rq.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    }).catch(() => null);
  }

  function builtinIdbPut(key, buf) {
    if (!key || !buf) return Promise.resolve();
    return builtinIdbOpen().then((db) => {
      if (!db) return;
      try {
        db.transaction(BUILTIN_IDB_STORE, 'readwrite').objectStore(BUILTIN_IDB_STORE).put(buf, key);
      } catch (e) { /* 配额满/隐私模式：当写失败，下一次仍走网络 */ }
    }).catch(() => {});
  }

  // gz 文本 → pack；schema/symbol/window 任一不符都返回 null（缓存里的脏数据也在这里被拦掉）
  function parseBuiltinPack(txt, code, windowId) {
    if (!txt) return null;
    let obj;
    try {
      obj = JSON.parse(txt);
    } catch (e) { return null; }
    if (!obj || obj.schema !== PACK_SCHEMA) return null;
    if (bareCode(obj.symbol) !== code || obj.window !== windowId) return null;
    const klines = parseKlines(obj.bars);
    if (!klines) return null;
    return {
      schema: PACK_SCHEMA, symbol: code, name: obj.name || '', window: windowId,
      month: windowId, first: obj.first, last: obj.last, days: obj.days,
      timeframe: '1m', adjust: 'none', barMinutes: 1, klines,
    };
  }


  /* ---------- 目录优先（20261107 客户端接线）----------
     首屏不再拉全量 index.json（全市场明文 486 KB），只拉：
     ① 内置目录元信息端点（版本 + 目录签名 + 分片签名 + 窗口，no-cache，~222 B）
     ② 版本化目录本体 <version>/<sig>.json.gz（gzip，immutable；只含 code+name）
     目录本体按 builtin-catalog/<version> 落 IndexedDB，版本变了自然失效，不写清理逻辑。
     旧 ?e=&s= 形态在服务端保留：目录端点 403/404 时回落一次旧索引。 */
  const BUILTIN_CATALOG_SCHEMA = 'panji.builtin.catalog.v1';
  const BUILTIN_CATALOG_KEY = 'builtin-catalog/';

  function parseBuiltinCatalog(txt, ver) {
    if (!txt) return null;
    let obj;
    try { obj = JSON.parse(txt); } catch (e) { return null; }
    if (!obj || obj.schema !== BUILTIN_CATALOG_SCHEMA) return null;
    if (String(obj.version || '') !== String(ver || '')) return null;
    if (!Array.isArray(obj.symbols) || !obj.symbols.length) return null;
    const out = [];
    obj.symbols.forEach((s) => {
      if (!Array.isArray(s) || s.length < 2) return;
      const code = bareCode(s[0]);
      if (!code) return;
      out.push({ code: code, name: String(s[1] == null ? '' : s[1]) });
    });
    return out.length ? out : null;
  }

  // 目录本体：L1 内存 → L2 IndexedDB（键 builtin-catalog/<version>）→ 版本化地址
  function loadBuiltinCatalog(f, apiBase, meta, o) {
    const ver = String(meta.version);
    const key = BUILTIN_CATALOG_KEY + ver;
    const mem = builtinMemGet(key);
    if (mem) return Promise.resolve(mem);
    const ms = o.timeoutMs === undefined ? BUILTIN_TIMEOUT_MS : o.timeoutMs;
    const url = (apiBase || '') + String(meta.url || '');
    return builtinIdbGet(key).then((buf) => {
      if (!buf) return null;
      return gunzipText(buf).then((txt) => {
        const list = parseBuiltinCatalog(txt, ver);
        if (!list) return null;
        builtinMemPut(key, list);
        return list;
      });
    }).catch(() => null).then((cached) => {
      if (cached) return cached;
      return builtinAttempt(f, url, ms).then((r) => {
        if (r.error) return null;
        return gunzipText(r.buf).then((txt) => {
          const list = parseBuiltinCatalog(txt, ver);
          if (!list) return null;
          builtinMemPut(key, list);
          builtinIdbPut(key, r.buf);      // 只存原始 gz 字节
          return list;
        });
      });
    }).catch(() => null);
  }

  // 旧形态（含 60 秒票据）：仅在目录端点不可用时回落一次
  function loadLegacyBuiltinIndex(o) {
    return resolveBuiltinTicket(o).then((ticket) => {
      // 票据只约束线上资源：壳内/商店包读的是随包 builtin/index.json，本就不需要签名。
      // 所以拿不到 ticket 时照样发一次不带 e/s 的请求；线上守卫会回 403，结果仍是 null，
      // 不会因此读到大盘目录，也不会把随包数据挡在门外。
      // [PANJI-OFFLINE] 2026-11-08 随包资源不走票据校验，原守卫保留备查
      // 原代码（20261108 第一刀删除，仅注释保留，不执行）：
      // // 显式要求签名却拿不到 ticket：不发无签名请求，交给调用方落空态
      // if (o.ticket && !ticket) return null;
      const f = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
      if (!f) return null;
      return Promise.resolve(f(builtinUrl(o.base || BUILTIN_BASE, 'index.json', ticket), { cache: 'no-cache' }))
        .then((res) => (res && res.ok ? res.text() : ''))
        .then((txt) => {
          if (!txt) return null;
          const obj = JSON.parse(txt);
          if (!obj || obj.schema !== BUILTIN_INDEX_SCHEMA) return null;
          if (!Array.isArray(obj.windows) || !obj.windows.length) return null;
          if (!Array.isArray(obj.symbols) || !obj.symbols.length) return null;
          BUILTIN_INDEX_CACHE = obj;
          return obj;
        });
    }).catch(() => null);
  }

  function loadBuiltinIndex(opts) {
    const o = opts || {};
    if (BUILTIN_INDEX_CACHE && !o.force) return Promise.resolve(BUILTIN_INDEX_CACHE);
    const f = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!f) return Promise.resolve(null);
    /* STORE-STRIP-START */
    // 线上才走目录端点；商店包读包内 builtin/index.json，整段被剥离
    const apiBase = o.apiBase == null ? '' : o.apiBase;
    return Promise.resolve(f((apiBase || '') + '/api/builtin/catalog', { cache: 'no-cache' }))
      .then((res) => {
        if (!res || !res.ok) {
          // 目录端点在旧服务端不存在（404）或被拦（403）：回落旧索引一次
          return o.noLegacyFallback ? null : loadLegacyBuiltinIndex(Object.assign({}, o, { noLegacyFallback: true }));
        }
        return res.json ? res.json() : null;
      })
      .then((meta) => {
        // 回落分支返回的是随包旧索引（有 schema/windows/symbols，但没有 url 这类目录元数据），
        // 它本身已经是可用目录，必须直接返回；否则会被下面的 meta.url 判据误判成不可用。
        if (meta && meta.schema === BUILTIN_INDEX_SCHEMA
          && Array.isArray(meta.windows) && meta.windows.length
          && Array.isArray(meta.symbols) && meta.symbols.length) {
          return meta;
        }
        if (!meta || !meta.version || !meta.url) return null;
        return loadBuiltinCatalog(f, apiBase, meta, o).then((symbols) => {
          if (!symbols || !symbols.length) return null;
          const idx = {
            schema: BUILTIN_INDEX_SCHEMA,
            version: String(meta.version),
            sig: String(meta.sig || ''),
            packSig: String(meta.packSig || ''),
            count: +meta.count || symbols.length,
            windows: Array.isArray(meta.windows) ? meta.windows : [],
            symbols: symbols,
          };
          if (!idx.windows.length) return null;
          BUILTIN_INDEX_CACHE = idx;
          return idx;
        });
      })
      .catch(() => (o.noLegacyFallback ? null : loadLegacyBuiltinIndex(Object.assign({}, o, { noLegacyFallback: true }))));
    /* STORE-STRIP-END */
    // 商店包/本地资源：直接读随包的 builtin/index.json
    return loadLegacyBuiltinIndex(o);
  }

  function bareCode(code) {
    const s = digits(code);
    return s.length >= 6 ? s.slice(-6) : '';
  }

  // 某交易日落在哪个内置窗口
  function builtinWindowOf(idx, day) {
    const d = digits(day).slice(0, 8);
    if (!idx || d.length !== 8) return '';
    const wins = idx.windows || [];
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      if (d >= String(w.first) && d <= String(w.last)) return w.id;
    }
    return '';
  }

  // 403 后换一张新票：优先调用方给的 refreshTicket，其次走内置票据端点
  function refreshBuiltinTicket(f, o) {
    if (typeof o.refreshTicket === 'function') {
      return Promise.resolve().then(() => o.refreshTicket())
        .then((v) => (v && v.exp && v.sig ? v : null)).catch(() => null);
    }
    /* STORE-STRIP-START */
    const url = o.ticketEndpoint || '/api/builtin/ticket';
    return Promise.resolve(f(url, { cache: 'no-store' }))
      .then((res) => (res && res.ok ? res.json() : null))
      .then((v) => (v && v.exp && v.sig ? v : null))
      .catch(() => null);
    /* STORE-STRIP-END */
    // 商店包没有线上票据端点：换不到新票，交给调用方按原错误收尾
    return Promise.resolve(null);
  }

  // 真超时：到点 abort，head 之后 body 卡住也算，请求在网络上真正中断（不是 race 假装超时）
  function builtinAttempt(f, url, ms) {
    const AC = root && root.AbortController ? root.AbortController : (typeof AbortController === 'function' ? AbortController : null);
    const ctl = (AC && ms > 0) ? new AC() : null;
    let timedOut = false;
    let timer = null;
    const done = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const finish = (v) => { done(); return v; };
    const failWith = (status) => ({
      error: {
        code: timedOut ? 'timeout' : (status === 403 ? 'forbidden' : (status === 404 ? 'no_shard' : 'load')),
        status: status || 0,
      },
    });
    if (ctl) timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
    const init = ctl ? { signal: ctl.signal } : undefined;
    return Promise.resolve().then(() => f(url, init)).then((res) => {
      const status = (res && res.status) || 0;
      if (!res || !res.ok) return finish(failWith(status));
      return Promise.resolve(res.arrayBuffer()).then(
        (buf) => finish({ buf, status }),
        () => finish(failWith(status))
      );
    }, () => finish(failWith(0)));
  }

  // 拉单片：L1 内存 → L2 IndexedDB → 网络；返回 {pack, error}，error.code ∈ load/timeout/forbidden/no_shard
  function loadBuiltinPackEx(codeIn, windowId, opts) {
    const o = opts || {};
    const code = bareCode(codeIn);
    const fail = (code2, status) => ({ pack: null, error: { code: code2, status: status || 0 } });
    if (!code || !windowId) return Promise.resolve(fail('no_shard', 0));
    const idx = o.index || BUILTIN_INDEX_CACHE;
    if (idx) {
      const hit = (idx.symbols || []).some((s) => bareCode(s.code) === code);
      if (!hit) return Promise.resolve(fail('no_shard', 0));
    }
    const f = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!f) return Promise.resolve(fail('load', 0));
    const ver = (idx && idx.version) ? String(idx.version) : '';
    const key = ver ? builtinCacheKey(ver, code, windowId) : '';
    const ms = o.timeoutMs === undefined ? BUILTIN_TIMEOUT_MS : o.timeoutMs;
    const base = o.base || BUILTIN_BASE;

    // L1：页内内存。同一页里换票再换回来不发请求。
    // 没有版本号时不启用缓存：键必须带内容版本，否则版本一换旧包会被误命中。
    const mem = key ? builtinMemGet(key) : null;
    if (mem) return Promise.resolve({ pack: mem, error: null });

    // L2：IndexedDB，存 gzip 原始字节；命中即 0 网络请求。脏数据（版本/票不符）当 miss。
    return (key ? builtinIdbGet(key) : Promise.resolve(null)).then((buf) => {
      if (!buf) return null;
      return Promise.resolve(gunzipText(buf)).then((txt) => {
        const pack = parseBuiltinPack(txt, code, windowId);
        if (!pack) return null;
        builtinMemPut(key, pack);
        return { pack, error: null };
      });
    }).catch(() => null).then((cached) => {
      if (cached) return cached;
      return fetchBuiltinPack();
    }).catch(() => fail('load', 0));

    function fetchBuiltinPack() {
      const urlVers = builtinPackUrl(base, idx, code, windowId);
      const rel = 'pack/' + code + '.' + windowId + '.json.gz' + (ver ? '?v=' + encodeURIComponent(ver) : '');
      // 版本化地址不带 60 秒票据；拿不到 packSig（旧包/旧索引/测试）才回落 ?e=&s=
      // 同上：没票据不等于没数据，随包分片不带 e/s 也能读；线上无票请求自会被 403 拦下
      // [PANJI-OFFLINE] 2026-11-08 随包资源不走票据校验，原守卫保留备查
      // 原代码（20261108 第一刀删除，仅注释保留，不执行）：
      // const urlP = urlVers ? Promise.resolve(urlVers) : resolveBuiltinTicket(o).then((ticket) => {
      //   if (o.ticket && !ticket) return null;
      //   return builtinUrl(base, rel, ticket);
      // });
      const urlP = urlVers ? Promise.resolve(urlVers) : resolveBuiltinTicket(o).then((ticket) => builtinUrl(base, rel, ticket));
      return urlP.then((url) => {
        if (!url) return fail('forbidden', 403);
        return builtinAttempt(f, url, ms).then((first) => {
          if (!first.error || first.error.code !== 'forbidden' || o.autoRetry === false) return first;
          // 403：版本化地址说明索引版本过期 → 强刷索引再试一次；
          //      旧形态 → 换一张新票再试一次（沿用 20261107 的行为）
          if (urlVers) {
            return loadBuiltinIndex(Object.assign({}, o, { force: true })).then((idx2) => {
              const url2 = builtinPackUrl(base, idx2, code, windowId);
              if (!url2 || url2 === url) return first;
              return builtinAttempt(f, url2, ms);
            });
          }
          return refreshBuiltinTicket(f, o).then((t2) => {
            if (!t2) return first;
            return builtinAttempt(f, builtinUrl(base, rel, t2), ms);
          });
        });
      }).then((r) => {
        if (r.error) return { pack: null, error: r.error };
        return Promise.resolve(gunzipText(r.buf)).then((txt) => {
          const pack = parseBuiltinPack(txt, code, windowId);
          if (!pack) return fail('load', 0);
          builtinMemPut(key, pack);
          builtinIdbPut(key, r.buf);      // 只存原始 gz 字节，解析结果不落盘
          return { pack, error: null };
        });
      });
    }
  }

  // 老接口保持返回 null（调用方仍走合成示意）；失败原因由 loadBuiltinPackEx 给出
  function loadBuiltinPack(codeIn, windowId, opts) {
    return loadBuiltinPackEx(codeIn, windowId, opts).then((r) => r.pack);
  }

  // 单个交易日的切片（判断练习 / 逐根揭示都按日回放）
  function dayPackOf(pack, day) {
    if (!pack || !Array.isArray(pack.klines)) return null;
    const d = digits(day).slice(0, 8);
    const bars = pack.klines.filter((b) => day8(b.t) === d);
    if (!bars.length) return null;
    return {
      schema: PACK_SCHEMA, symbol: pack.symbol, name: pack.name || '',
      month: d10(d), day: d, timeframe: pack.timeframe || '5m',
      adjust: pack.adjust || 'none', barMinutes: pack.barMinutes || BAR_MIN, klines: bars,
    };
  }

  function daysOf(pack, minBars) {
    const m = Object.create(null);
    (pack && pack.klines ? pack.klines : []).forEach((b) => {
      const d = day8(b.t);
      m[d] = (m[d] || 0) + 1;
    });
    return Object.keys(m).filter((d) => m[d] >= +(minBars || 1)).sort();
  }

  function pickDayPack(pack, seed, minBars) {
    const days = daysOf(pack, minBars);
    if (!days.length) return null;
    const rnd = rngOf(String(seed || pack.symbol));
    return dayPackOf(pack, days[Math.floor(rnd() * days.length)]);
  }

  // 返回 {status:'ok', replay, level:'5m', adjust} / {status:'no-trades'} / {status:'empty', detail}
  async function loadTradeReplay(symIn, date, opts) {
    const o = opts || {};
    const sym = normSym(symIn);
    const day = digits(date).slice(0, 8);
    if (!sym || day.length !== 8) return { status: 'empty', symbol: sym, date: day, detail: null };
    const trades = Array.isArray(o.trades) ? o.trades : readTrades(sym, day);
    if (!trades.length) return { status: 'no-trades', symbol: sym, date: day };

    // 1) 内置 5 分钟演示样本（合成走势，不对应任何真实票）；账本里写 KX0001 也可命中
    const rawSym = String(symIn == null ? '' : symIn).trim().toLowerCase();
    if ((sym === SAMPLE.symbol || rawSym === SAMPLE.symbol.toLowerCase()) && SAMPLE.days.indexOf(day) >= 0) {
      const r = load(SAMPLE.symbol, day, { trades: trades });
      if (r) return { status: 'ok', replay: r, level: '5m', adjust: 'synthetic' };
    }

    // 2) 用户本机导入的 5 分钟行情（flag kimport 开时；数据只在本机，不请求网络）
    //    命中条件：代码归一后相同 + 该交易日落在文件覆盖范围内 + 当天至少 2 根
    const KI = root.PanjiKlineImport;
    if (KI && root.PanjiFlag && root.PanjiFlag('kimport') && typeof KI.listItems === 'function') {
      const items = KI.listItems() || [];
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (!it || it.timeframe !== '5m' || !it.bars || it.bars.length < 2) continue;
        if (KI.normCode(it.code) !== KI.normCode(symIn) && KI.normCode(it.code) !== sym) continue;
        const a = String(it.first).slice(0, 8), z = String(it.last).slice(0, 8);
        if (day < a || day > z) continue;
        const dayBars = it.bars.filter(function (b) { return String(b[0]).slice(0, 8) === day; });
        if (dayBars.length < 2) continue;
        const klines = dayBars.map(function (b) { return b.join(','); });
        const r = load(sym, day, { klines: klines, trades: trades, timeframe: '5m', adjust: it.adjust, name: it.code });
        if (r) return { status: 'ok', replay: r, level: '5m', adjust: it.adjust, source: 'user-import' };
      }
    }

    // 3) 内置历史回放分片（本机已加载 builtin 目录时；1 分钟，不复权）
    if (BUILTIN_INDEX_CACHE) {
      const win = builtinWindowOf(BUILTIN_INDEX_CACHE, day);
      if (win) {
        const bp = await loadBuiltinPack(sym, win, { fetch: o.fetch, base: o.builtinBase, ticket: o.ticket });
        if (bp) {
          const r = makeReplay(sym, day, bp.klines, trades, bp.name,
            { barMinutes: 1, timeframe: '1m' });
          if (r) return { status: 'ok', replay: r, level: '1m', adjust: 'none', source: 'builtin' };
        }
      }
    }

    // 4) 离线分钟包（不复权；当前只覆盖 2024 全年）
    const month = day.slice(0, 4) + '-' + day.slice(4, 6);
    const pack = await loadPack(sym, month, o);
    if (pack) {
      const r = makeReplay(sym, day, pack.klines, trades, pack.name);
      if (r) return { status: 'ok', replay: r, level: '5m', adjust: pack.adjust || 'none' };
    }

    // 5) 未命中：如实说缺什么，不给近似走势（先查顶层覆盖清单，命中不了才走这里）
    const idx = await loadIndex(o);
    const covered = idx && idx.months ? Object.keys(idx.months).sort() : ['2024-01', '2024-12'];
    return {
      status: 'empty', symbol: sym, date: day,
      detail: {
        month: month,
        coveredMonths: covered,
        monthCovered: !!(idx && idx.months && idx.months[month]),
      },
    };
  }

  // 把某天的分钟 K 线 + 账本成交拼成可回放对象
  function makeReplay(sym, day, klines, trades, name, opts) {
    const o = opts || {};
    const src = klines.filter((b) => day8(b.t) === day);
    if (!src.length) return null;
    const bm = +(o.barMinutes || BAR_MIN);
    const cps = buildCheckpoints(trades, src, bm);
    if (!cps) return null;
    const r = {
      schema: SCHEMA, symbol: sym, market: sym.slice(0, 2), date: day,
      timeframe: o.timeframe || '5m', adjust: 'none', barMinutes: bm, klines: src,
      trades: trades.map((t) => Object.assign({}, t)), checkpoints: cps,
    };
    if (name) r.name = name;
    return validateReplay(r) ? r : null;
  }

  /* ---------- B 逐根揭示：一次只多一根 ---------- */
  function buildStep(pack, opts) {
    const o = opts || {};
    if (!pack || !Array.isArray(pack.klines) || pack.klines.length < 3) return null;
    const base = Math.max(1, Math.min(+(o.base || 30), pack.klines.length - 1));
    return {
      schema: PACK_SCHEMA, symbol: pack.symbol, name: pack.name || '',
      month: pack.month, timeframe: pack.timeframe || '5m', adjust: pack.adjust || 'none',
      klines: pack.klines, base,
    };
  }

  // steps = 已经揭示的根数（0 = 只看基线）；一次调用只推进一根
  function stepView(step, steps) {
    if (!step) return null;
    const max = step.klines.length - step.base;
    const n = step.base + Math.max(0, Math.min(max, Math.round(+steps || 0)));
    const visible = step.klines.slice(0, n);
    return {
      step, base: step.base, steps: n - step.base, total: max,
      shown: n, visible,
      maxVisibleT: visible[visible.length - 1].t,
      canNext: n < step.klines.length,
      futureHidden: n < step.klines.length,
    };
  }

  function advanceStep(step, steps) {
    if (!step) return 0;
    const max = step.klines.length - step.base;
    return Math.min(max, Math.max(0, Math.round(+steps || 0)) + 1);
  }

  // 退出再进 = 从第 1 根开始（步数归零，不保留半截状态）
  function resetStep() { return 0; }

  /* ---------- A 判断练习：在一个 K 线处停下出题 ---------- */
  // 题目只问“你会怎么做”，不设分、不排名、不评价对错
  function rngOf(seedStr) {
    let h = 2166136261;
    for (let i = 0; i < String(seedStr).length; i++) {
      h ^= String(seedStr).charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return function () {
      h = (h * 1664525 + 1013904223) >>> 0;
      return h / 4294967296;
    };
  }

  function nextPosition(pos, key) {
    if (pos !== 'long') return key === 'buy' ? 'long' : 'flat';
    return key === 'cut' ? 'flat' : 'long';
  }

  // 选完即锁定：已有 choice 时再传任何 key 都原样返回（揭示不可撤销、不可改选）
  function commitChoice(state, key) {
    const st = state || {};
    if (st.choice) return { choice: st.choice, position: st.position };
    return { choice: key, position: nextPosition(st.position, key) };
  }

  // klines 同一天；题目点：前面至少 24 根、后面同一交易日内至少 6 根
  function buildDrill(pack, opts) {
    if (!pack || !Array.isArray(pack.klines)) return null;
    const o = opts || {};
    const bars = pack.klines;
    const want = Math.max(1, +(o.count || 8));
    const cand = [];
    for (let i = 24; i < bars.length - 6; i++) {
      const d = day8(bars[i].t);
      let ok = true;
      for (let j = i + 1; j <= i + 6; j++) if (day8(bars[j].t) !== d) { ok = false; break; }
      if (ok) cand.push(i);
    }
    if (!cand.length) return null;
    const n = Math.min(want, cand.length);
    const rnd = rngOf(String(o.seed || (pack.symbol + pack.month)));
    const picked = [];
    for (let s = 0; s < n; s++) {
      const a = Math.floor((s * cand.length) / n);
      const b = Math.floor(((s + 1) * cand.length) / n) - 1;
      picked.push(cand[a + Math.floor(rnd() * Math.max(1, b - a + 1))]);
    }
    const checkpoints = picked.map((idx, seq) => ({
      seq, idx,
      at: bars[idx].t,
      visibleUntil: bars[idx].t,
    }));
    return {
      schema: PACK_SCHEMA, symbol: pack.symbol, name: pack.name,
      month: pack.month, timeframe: pack.timeframe || '5m',
      klines: bars, checkpoints,
    };
  }

  function afterDrillBars(drill, seq, horizon) {
    const cp = drill.checkpoints[seq];
    const d = day8(cp.at);
    const out = [];
    for (let i = cp.idx + 1; i < drill.klines.length && out.length < (horizon || 12); i++) {
      const b = drill.klines[i];
      if (day8(b.t) !== d) break;
      out.push(b);
    }
    return out;
  }

  // position: 'flat' | 'long'；choice 空 = 未揭示
  // 已选过一次后 choice 会被调用方锁定，再传别的值不会改写揭示内容
  function drillView(drill, seq, position, choice) {
    if (!drill || !Array.isArray(drill.checkpoints)) return null;
    const cp = drill.checkpoints[seq];
    if (!cp) return null;
    const pos = position === 'long' ? 'long' : 'flat';
    const visible = sliceVisible(drill.klines, cp.visibleUntil);
    const v = {
      seq, checkpoint: cp, position: pos,
      visibleUntil: cp.visibleUntil,
      maxVisibleT: visible.length ? visible[visible.length - 1].t : '',
      visible,
      question: '这一刻你会不会动手',
      choices: [{ key: 'buy', label: '动手' }, { key: 'wait', label: '不动手' }],
      revealed: false, choice: '', after: [], actual: null,
    };
    if (choice) {
      const after = afterDrillBars(drill, seq, 12);
      const ref = visible.length ? visible[visible.length - 1].c : 0;
      let hi = 0, lo = 0, last = null;
      after.forEach((b) => { hi = Math.max(hi, b.h); lo = lo ? Math.min(lo, b.l) : b.l; last = b; });
      v.revealed = true;
      v.choice = choice;
      v.after = after;
      v.actual = after.length ? {
        mode: 'window', bars: after.length,
        from: after[0].t, to: last.t,
        high: hi, low: lo, close: last.c,
        pct: ref > 0 ? +(((last.c - ref) / ref) * 100).toFixed(2) : 0,
      } : null;
    }
    return v;
  }

  /* ---------- 渲染（replay.html 用） ---------- */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function fmtT(t) { return t ? String(t).slice(8, 10) + ':' + String(t).slice(10, 12) : '—'; }

  // 手机一屏只铺最近 N 根：整天约 240 根塞进 332px 会让实体互相重叠、糊成色带
  const CHART_VIEW_BARS = 72;
  // 右侧恒留 3 根空位：最后一根不贴价格轴，未来还有走势时视觉上「没画满」
  const RIGHT_GAP_BARS = 3;

  // 成交量：压成三位以内的短写法，避免副图上出现 8 位数字
  function fmtVol(v) {
    const n = +v || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(Math.round(n));
  }

  // 刻度步长取 1 / 2 / 5 × 10^k，保证价格轴落在「看得懂的数」上
  function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const m = n >= 7.5 ? 10 : (n >= 3.5 ? 5 : (n >= 1.5 ? 2 : 1));
    return m * mag;
  }

  function decimalsOf(stepV) {
    if (stepV >= 1) return 0;
    if (stepV >= 0.1) return 1;
    return 2;
  }

  // 主画布外包一层定位容器，十字光标才能挂在同尺寸的 overlay 上
  function chartBoxOf(cv) {
    let box = cv.parentNode;
    if (box && box.classList && box.classList.contains('chart-box')) return box;
    box = root.document.createElement('div');
    box.className = 'chart-box';
    cv.parentNode.insertBefore(box, cv);
    box.appendChild(cv);
    return box;
  }

  // 只重画 overlay：十字线 + 右轴价格牌 + 底轴时间牌 + 左上角 OHLCV
  function drawCross(ov, L, px, py) {
    const g = ov.getContext('2d');
    g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    g.clearRect(0, 0, L.w, L.h);
    const n = L.view.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(n - 1 - (L.xr - px) / L.step)));
    const b = L.view[i];
    const x = L.xr - (n - 1 - i) * L.step;
    const yTop = L.pad.t, yBot = L.h - L.pad.b;
    const y = Math.max(yTop, Math.min(L.mainBottom, py));
    const p = L.hi - (y - yTop) / Math.max(1, L.mainBottom - yTop) * (L.hi - L.lo);
    g.save();
    g.strokeStyle = 'rgba(120,132,156,.85)';
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x, yTop); g.lineTo(x, yBot); g.stroke();
    g.beginPath(); g.moveTo(L.pad.l, y); g.lineTo(L.w - L.pad.r, y); g.stroke();
    g.setLineDash([]);
    g.textBaseline = 'middle';
    // 右轴价格牌
    g.fillStyle = 'rgba(30,38,54,.92)';
    g.fillRect(L.w - L.pad.r + 1, y - 7, L.pad.r - 2, 14);
    g.fillStyle = '#fff';
    g.font = '10px sans-serif';
    g.textAlign = 'center';
    g.fillText(p.toFixed(L.dec), L.w - L.pad.r / 2, y);
    // 底轴时间牌
    const label = fmtT(b.t);
    const tw = g.measureText(label).width + 10;
    const tx = Math.max(L.pad.l, Math.min(x - tw / 2, L.w - L.pad.r - tw));
    g.fillStyle = 'rgba(30,38,54,.92)';
    g.fillRect(tx, yBot + 1, tw, Math.max(12, L.h - yBot - 2));
    g.fillStyle = '#fff';
    g.fillText(label, tx + tw / 2, L.h - 5);
    // 左上角 OHLCV：盖住均线图例，松手后随 overlay 一起消失
    const line1 = fmtT(b.t) + '  开 ' + b.o + '  高 ' + b.h + '  低 ' + b.l + '  收 ' + b.c;
    const line2 = '量 ' + fmtVol(b.v);
    g.font = '10px sans-serif';
    g.textAlign = 'left';
    const bw = Math.max(g.measureText(line1).width, g.measureText(line2).width) + 12;
    g.fillStyle = 'rgba(6,16,31,.86)';
    g.fillRect(L.pad.l, L.pad.t, bw, 30);
    g.fillStyle = '#e6edf7';
    g.fillText(line1, L.pad.l + 6, L.pad.t + 11);
    g.fillText(line2, L.pad.l + 6, L.pad.t + 24);
    g.restore();
  }

  // 长按 220ms 起十字；拖动只重画 overlay；抬手 / 移出即消失
  function attachCross(cv, L) {
    const box = chartBoxOf(cv);
    const doc = root.document;
    let ov = box.querySelector('canvas.chart-cross');
    if (!ov) {
      ov = doc.createElement('canvas');
      ov.className = 'chart-cross';
      box.appendChild(ov);
    }
    ov.width = Math.round(L.w * L.dpr);
    ov.height = Math.round(L.h * L.dpr);
    const ctx = ov.getContext('2d');
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    if (box.__crossOff) box.__crossOff();
    let timer = null, active = false, sx = 0, sy = 0;
    const local = (e) => {
      const r = ov.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const clear = () => { ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0); ctx.clearRect(0, 0, L.w, L.h); };
    const onDown = (e) => {
      const p = local(e);
      if (p.x < L.pad.l || p.x > L.w - L.pad.r) return;
      sx = e.clientX; sy = e.clientY;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; active = true; drawCross(ov, L, p.x, p.y); }, 220);
    };
    const onMove = (e) => {
      if (!active) {
        // 起手就滑动 = 用户在滚页面，别把十字线抢出来
        if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) {
          clearTimeout(timer); timer = null;
        }
        return;
      }
      const p = local(e);
      drawCross(ov, L, p.x, p.y);     // 主画布不动，只刷 overlay
    };
    const onUp = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (active) { active = false; clear(); }
    };
    // 双击复位：先收起十字，再把「初始视角」交给调用方（没有就只收十字）
    const onDbl = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      active = false; clear();
      if (typeof L.onReset === 'function') L.onReset();
    };
    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
    box.addEventListener('pointerleave', onUp);
    box.addEventListener('dblclick', onDbl);
    box.__crossOff = () => {
      box.removeEventListener('pointerdown', onDown);
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
      box.removeEventListener('pointerleave', onUp);
      box.removeEventListener('dblclick', onDbl);
      box.__crossOff = null;
    };
  }

  const MA_DEFS = [
    { n: 5, color: '#d99a2b' },
    { n: 10, color: '#4f8fe0' },
    { n: 20, color: '#9b6ad6' },
  ];

  function drawChart(cv, bars, markers, opts) {
    if (!cv) return null;
    const dpr = Math.min(2, (root.devicePixelRatio || 1));
    const w = cv.clientWidth || 358;
    const h = cv.clientHeight || 220;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!bars || !bars.length) {
      g.fillStyle = '#8b93a7';
      g.font = '12px sans-serif';
      g.fillText('该时刻之前没有可显示的走势', 10, 24);
      return null;
    }
    const o = opts || {};
    // 除权事件（由调用方从事件表取好传进来）；命中只加标记，不动任何价格
    const corp = o.corp && o.corp.label ? o.corp : null;
    const viewCount = Math.max(10, Math.min(240, Math.round(+o.viewCount || CHART_VIEW_BARS)));
    // 只画最后 viewCount 根；from 是本次窗口在全量数组里的起点（买卖点与均线都要按它平移）
    const from = Math.max(0, bars.length - viewCount);
    const view = from ? bars.slice(from) : bars;
    // 右侧留出价格刻度，底部留时间刻度；量能副图占绘图区下方约 1/4
    const pad = { l: 6, r: 44, t: 10, b: 16 };
    const plotH = Math.max(60, h - pad.t - pad.b);
    const volH = Math.max(22, Math.round(plotH * 0.24));
    const gapV = 8;
    const mainBottom = h - pad.b - volH - gapV;
    // 价格区间按可见窗口算：用全天极值会把最近几十根压扁
    let lo = Infinity, hi = -Infinity;
    view.forEach((b) => { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); });
    if (!(hi > lo)) { hi = lo + 0.01; lo -= 0.01; }
    const padP = (hi - lo) * 0.04;
    lo -= padP; hi += padP;
    const y = (p) => pad.t + (hi - p) / (hi - lo) * Math.max(1, mainBottom - pad.t);
    // 可见窗口内均分绘图宽度（右侧再留 RIGHT_GAP_BARS 根空位），实体宽封顶 9px
    const avail = w - pad.l - pad.r;
    const step = avail / (view.length + RIGHT_GAP_BARS);
    const bw = Math.min(9, Math.max(1.2, step * 0.62));
    const xr = w - pad.r - (RIGHT_GAP_BARS + 0.5) * step;
    const vBase = h - pad.b;

    // 除权日底色：整块价格区铺一层淡色，提示这天的价格与前后交易日不可比
    if (corp) {
      g.fillStyle = 'rgba(217,154,43,.07)';
      g.fillRect(pad.l, pad.t, Math.max(0, w - pad.l - pad.r), Math.max(0, mainBottom - pad.t));
    }

    // 网格 + 右轴价格刻度：步长随可见窗口的价差自适应
    const pStep = niceStep(hi - lo, 4);
    const dec = decimalsOf(pStep);
    const pStart = Math.ceil(lo / pStep) * pStep;
    for (let p = pStart; p <= hi + 1e-9; p += pStep) {
      const yy = y(p);
      if (yy < pad.t - 0.5 || yy > mainBottom + 0.5) continue;
      g.strokeStyle = 'rgba(128,140,160,.16)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(pad.l, yy); g.lineTo(w - pad.r, yy); g.stroke();
      g.fillStyle = '#8b93a7';
      g.font = '9px sans-serif';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(p.toFixed(dec), w - 4, yy);
    }

    // 均线：窗口内每根都用「全量 bars」里的前序数据算，不是只拿可见的这几十根
    MA_DEFS.forEach((ma) => {
      g.strokeStyle = ma.color;
      g.lineWidth = 1;
      g.beginPath();
      let started = false;
      for (let i = 0; i < view.length; i++) {
        const gi = from + i;
        if (gi < ma.n - 1) continue;
        let sum = 0;
        for (let k = 0; k < ma.n; k++) sum += bars[gi - k].c;
        const px = xr - (view.length - 1 - i) * step;
        const py = y(sum / ma.n);
        if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
      }
      if (started) g.stroke();
    });

    // K 线实体 + 影线
    view.forEach((b, i) => {
      const up = b.c >= b.o;
      const x = xr - (view.length - 1 - i) * step;
      g.strokeStyle = up ? '#ff5c7a' : '#3ddc97';
      g.fillStyle = up ? 'rgba(255,92,122,.75)' : 'rgba(61,220,151,.75)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y(b.h)); g.lineTo(x, y(b.l)); g.stroke();
      const top = y(Math.max(b.o, b.c)), bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      g.fillRect(x - bw / 2, top, bw, bh);
    });

    // 成交量副图：与 K 线同色，高度按窗口内最大量归一
    let vMax = 0;
    view.forEach((b) => { if (b.v > vMax) vMax = b.v; });
    g.strokeStyle = 'rgba(128,140,160,.16)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, vBase); g.lineTo(w - pad.r, vBase); g.stroke();
    if (vMax > 0) {
      view.forEach((b, i) => {
        const up = b.c >= b.o;
        const x = xr - (view.length - 1 - i) * step;
        const bh = Math.max(1, (b.v / vMax) * (volH - 2));
        g.fillStyle = up ? 'rgba(255,92,122,.62)' : 'rgba(61,220,151,.62)';
        g.fillRect(x - bw / 2, vBase - bh, bw, bh);
      });
    }

    // 持仓成本线：只有调用方明确传入正数成本（来自用户自己填的期初持仓）才画；
    // 没有就整段跳过，不按均价/首根收盘猜一个假成本
    const cost = +o.cost;
    if (cost > 0 && cost >= lo && cost <= hi) {
      const cy = y(cost);
      g.save();
      g.strokeStyle = 'rgba(214,178,90,.9)';
      g.lineWidth = 1;
      g.setLineDash([5, 4]);
      g.beginPath(); g.moveTo(pad.l, cy); g.lineTo(w - pad.r, cy); g.stroke();
      g.setLineDash([]);
      const cTxt = '成本 ' + cost.toFixed(dec);
      g.font = '9px sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      const cw = g.measureText(cTxt).width + 8;
      g.fillStyle = 'rgba(34,29,14,.88)';
      g.fillRect(pad.l + 1, cy - 7, cw, 14);
      g.fillStyle = '#e8c979';
      g.fillText(cTxt, pad.l + 5, cy);
      g.restore();
    }

    // 均线图例（左上角，十字线出现时被 OHLCV 卡片盖住）
    g.font = '9px sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    let lx0 = pad.l + 2;
    MA_DEFS.forEach((ma) => {
      const gi = bars.length - 1;
      let txt = 'MA' + ma.n;
      if (gi >= ma.n - 1) {
        let sum = 0;
        for (let k = 0; k < ma.n; k++) sum += bars[gi - k].c;
        txt += ' ' + (sum / ma.n).toFixed(dec);
      }
      g.fillStyle = ma.color;
      g.fillRect(lx0, pad.t + 3, 6, 2);
      g.fillText(txt, lx0 + 9, pad.t + 4);
      lx0 += 9 + g.measureText(txt).width + 8;
    });

    // 时间刻度：最多 4 个，按可见窗口均分，不逐根标
    const tCount = Math.min(4, view.length);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    for (let k = 0; k < tCount; k++) {
      const i = tCount === 1 ? 0 : Math.round((view.length - 1) * k / (tCount - 1));
      const x = xr - (view.length - 1 - i) * step;
      g.strokeStyle = 'rgba(128,140,160,.10)';
      g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, mainBottom); g.stroke();
      g.fillStyle = '#8b93a7';
      const label = fmtT(view[i].t);
      g.fillText(label, Math.max(14, Math.min(x, w - pad.r - 14)), h - 4);
    }

    // 买卖点标记
    (markers || []).forEach((m) => {
      const idx = bars.findIndex((b) => b.t >= m.at);
      const bi = idx >= 0 ? idx : bars.length - 1;
      if (bi < from) return;                       // 该笔已滚出可见窗口，不画
      const vi = bi - from;
      const bb = view[vi];
      let x = xr - (view.length - 1 - vi) * step;
      x = Math.max(pad.l + 4, Math.min(x, w - pad.r - 4));
      const buy = m.kind === 'buy_in';
      // 标记贴在 K 线下沿（买）/ 上沿（卖），带深色描边，避免与实体同色看不清
      const ay = Math.max(18, Math.min(mainBottom - 4, buy ? y(bb.l) + 11 : y(bb.h) - 11));
      g.fillStyle = buy ? '#3ddc97' : '#ff5c7a';
      g.strokeStyle = '#06101f';
      g.lineWidth = 1.4;
      g.beginPath();
      if (buy) { g.moveTo(x, ay - 5); g.lineTo(x - 5, ay + 5); g.lineTo(x + 5, ay + 5); }
      else { g.moveTo(x, ay + 5); g.lineTo(x - 5, ay - 5); g.lineTo(x + 5, ay - 5); }
      g.fill();
      g.stroke();
      g.font = '10px sans-serif';
      g.fillStyle = buy ? '#3ddc97' : '#ff5c7a';
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      const label = (buy ? 'A ' : 'B ') + (m.price > 0 ? m.price : '');
      const tw2 = g.measureText(label).width;
      let lx = x + 8;
      if (lx + tw2 > w - 2) lx = x - tw2 - 8;      // 贴右边缘时标签放左侧
      lx = Math.max(2, lx);
      g.fillText(label, lx, Math.max(12, Math.min(mainBottom - 2, ay + 4)));
    });

    // 除权日标签：贴在价格区左上角（均线图例下一行），十字线卡片出现时会被盖住
    if (corp) {
      g.font = '9px sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      const cw2 = g.measureText(corp.label).width + 10;
      const tx = pad.l + 1;
      const ty = pad.t + 18;
      g.fillStyle = 'rgba(34,29,14,.92)';
      g.fillRect(tx, ty - 7, cw2, 14);
      g.strokeStyle = 'rgba(217,154,43,.9)';
      g.lineWidth = 1;
      g.strokeRect(tx + 0.5, ty - 6.5, cw2 - 1, 13);
      g.fillStyle = '#e8c979';
      g.fillText(corp.label, tx + 5, ty + 0.5);
    }

    attachCross(cv, {
      view, pad, w, h, step, xr, hi, lo, dec, dpr, mainBottom,
      onReset: o.onReset,
    });
    return { view, from, step, xr };
  }

  function mount(el, replay, opts) {
    if (!el || !replay) return null;
    const o = opts || {};
    let seq = 0;
    let choice = '';
    const view = () => trainView(replay, seq, choice);
    const cps = replay.checkpoints;
    // 除权事件：首次渲染时表可能还没读到，读到后补一次重绘（只补一次）
    let corp = corpEventOf(replay.symbol, replay.date);
    let corpAsked = false;
    function corpOf() {
      if (corp || corpAsked) return corp;
      corpAsked = true;
      loadCorpActions().then((t) => {
        if (!t) return;
        const ev = corpEventOf(replay.symbol, replay.date);
        if (ev) { corp = ev; paint(); }
      });
      return corp;
    }

    function html(v) {
      const c = v.checkpoint;
      const tr = replay.trades[c.tradeIdx] || {};
      const kindTxt = c.kind === 'buy_in' ? 'A' : 'B';
      const head = replay.name ? replay.name + ' ' + replay.symbol : replay.symbol;
      const rows = cps.map((x, i) => {
        const xt = replay.trades[x.tradeIdx] || {};
        return '<li' + (i === seq ? ' class="on"' : '') + '>'
          + '<b>笔' + (i + 1) + '</b> ' + (x.kind === 'buy_in' ? 'A' : 'B')
          + ' ' + fmtT(x.at) + ' · ' + esc(xt.price)
          + '<span>可见截止 ' + (x.visibleUntil ? fmtT(x.visibleUntil) : '无') + '</span></li>';
      }).join('');
      const label = kindTxt + ' ' + fmtT(c.at) + ' · ' + esc(tr.price) + '元';
      let body = '<div class="ask"><p class="q">' + (v.revealed ? '已选择：' + (v.choice === 'do' ? '动手' : '不动手') : v.question)
        + '</p><div class="btns">'
        + (v.revealed ? '<button id="btn-next"' + (seq + 1 < cps.length ? '' : ' disabled') + '>下一笔</button>'
          : '<button id="btn-do" data-choice="do">动手</button><button id="btn-wait" data-choice="wait">不动手</button>')
        + '</div></div>';
      if (v.revealed) {
        const a = v.actual;
        body += '<div class="reveal" id="reveal">'
          + '<p>后面又走了 ' + v.after.length + ' 根（' + (v.after.length ? fmtT(v.after[0].t) + ' → ' + fmtT(v.after[v.after.length - 1].t) : '无') + '）</p>'
          + (a ? '<p>这组动作之后：' + esc(tr.price) + ' → ' + esc(a.price)
            + (a.mode === 'trade' ? '，下一次动作 ' + fmtT(a.at) : '，按收盘价对照') + '</p>' : '')
          + '</div>';
      } else {
        body += '<div class="reveal" id="reveal" hidden></div>';
      }
      const ev = corpOf();
      return '<h1>' + esc(head) + '</h1><p class="sub">' + d10(replay.date) + ' · 当前 ' + label + '</p>'
        + '<p class="level" data-level="' + esc(replay.timeframe) + '">'
        + esc(levelText(replay.adjust, replay.timeframe))
        + (ev && ev.label ? '<span style="display:block;margin-top:4px;color:#e8c979">' + esc(ev.label) + '</span>' : '')
        + '</p>'
        + '<canvas id="chart" data-visible-until="' + esc(v.visibleUntil) + '" data-max-visible-t="' + esc(v.maxVisibleT)
        + '" data-revealed="' + (v.revealed ? 1 : 0) + '"></canvas>'
        + '<ol class="cps">' + rows + '</ol>' + body;
    }

    function paint() {
      const v = view();
      el.innerHTML = html(v);
      const cv = el.querySelector('#chart');
      const markers = cps.slice(0, seq + 1).map((c) => ({
        at: c.barT || c.at, kind: c.kind,
        price: +(replay.trades[c.tradeIdx] || {}).price || 0,
        qty: +(replay.trades[c.tradeIdx] || {}).qty || 0,
      })).filter((m) => v.revealed || String(m.at) <= String(v.maxVisibleT));
      const bars = v.revealed
        ? v.visible.concat(v.after.filter((b) => b.t > v.visibleUntil))
        : v.visible;
      drawChart(cv, bars, markers, { cost: o.cost, corp: corpOf() });
      const nextBtn = el.querySelector('#btn-next');
      if (nextBtn) nextBtn.addEventListener('click', () => { seq = Math.min(seq + 1, cps.length - 1); choice = ''; paint(); });
      el.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', () => {
        choice = b.getAttribute('data-choice');
        paint();
      }));
      return v;
    }

    const api = {
      replay, paint, view,
      setSeq(n) { seq = Math.max(0, Math.min(n, cps.length - 1)); choice = ''; return paint(); },
      choose(c) { choice = c; return paint(); },
    };
    if (!o.noAutoPaint) paint();
    return api;
  }

  /* ---------- A 规则对照的渲染 ---------- */
  function mountDrill(el, drill, opts) {
    if (!el || !drill) return null;
    const o = opts || {};
    const cps = drill.checkpoints;
    let seq = 0;
    let position = 'flat';
    let choice = '';

    const view = () => drillView(drill, seq, position, choice);

    function html(v) {
      const name = (drill.name ? drill.name + ' ' : '') + drill.symbol;
      const tag = v.position === 'long' ? '已动手' : '未动手';
      const head = '<h1>' + esc(name) + '</h1><p class="sub">' + esc(drill.month) + ' · ' + esc(drill.timeframe)
        + ' · 第 ' + (seq + 1) + '/' + cps.length + ' 题 · ' + tag + ' · 不构成投资建议</p>';
      let body = '<div class="ask"><p class="q">' + esc(v.question) + '</p><div class="btns">';
      if (!v.revealed) {
        v.choices.forEach((c) => {
          body += '<button type="button" data-choice="' + esc(c.key) + '">' + esc(c.label) + '</button>';
        });
      } else {
        body += '<button type="button" id="btn-next"' + (seq + 1 < cps.length ? '' : ' disabled') + '>下一题</button>';
      }
      body += '</div></div>';
      if (v.revealed) {
        const a = v.actual;
        body += '<div class="reveal" id="reveal"><p>已选：' + esc(choiceLabel(v.choices, v.choice)) + '</p>'
          + (a ? '<p>后面 ' + a.bars + ' 根（' + fmtT(a.from) + ' → ' + fmtT(a.to) + '）：最高 '
            + esc(a.high) + ' · 最低 ' + esc(a.low) + ' · 收盘 ' + esc(a.close) + '</p>' : '<p>当天后面没有更多走势了</p>')
          + '<p>只记录事实走势，不做评价。</p></div>';
      } else {
        body += '<div class="reveal" id="reveal" hidden></div>';
      }
      return head + '<canvas id="chart" data-visible-until="' + esc(v.visibleUntil)
        + '" data-max-visible-t="' + esc(v.maxVisibleT) + '" data-revealed="' + (v.revealed ? 1 : 0)
        + '" data-seq="' + seq + '" data-position="' + esc(v.position) + '"></canvas>' + body;
    }

    function choiceLabel(choices, key) {
      for (const c of choices) if (c.key === key) return c.label;
      return key;
    }

    function paint() {
      const v = view();
      el.innerHTML = html(v);
      const bars = v.revealed ? v.visible.concat(v.after) : v.visible;
      drawChart(el.querySelector('#chart'), bars, [], { cost: o.cost });
      el.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', () => {
        const st = commitChoice({ choice, position }, b.getAttribute('data-choice'));
        if (choice) return;                 // 揭示后不可撤销、不可改选
        choice = st.choice; position = st.position;
        paint();
      }));
      const nextBtn = el.querySelector('#btn-next');
      if (nextBtn) nextBtn.addEventListener('click', () => {
        if (seq + 1 >= cps.length) return;
        seq += 1; choice = ''; paint();
      });
      return v;
    }

    const api = {
      drill, paint, view,
      setSeq(n) { seq = Math.max(0, Math.min(n, cps.length - 1)); choice = ''; return paint(); },
    };
    if (!o.noAutoPaint) paint();
    return api;
  }

  return {
    SCHEMA, BAR_MIN, SAMPLE,
    load, parseKlines, buildCheckpoints, validateReplay, locate, barStart,
    visibleUntilOf, sliceVisible, trainView, afterBars, actualResult, tOf,
    readTrades, mount, drawChart, fmtT, d10,
    ledgerTrades, hasArchive,
    PACK_SCHEMA, PACK_BASE, PACK_VERSION, packPath, loadPack, loadIndex, loadManifest, buildDrill, drillView,
    ledgerScope, ensureToken, clearToken,
    afterDrillBars, nextPosition, commitChoice, mountDrill,
    normSym, levelText, loadTradeReplay, makeReplay,
    loadCorpActions, corpEventOf, CORP_SCHEMA,
    buildStep, stepView, advanceStep, resetStep,
    SYNTH_TAG, SYNTH_DAYS, synthMeta, synthIndex, synthPack, loadSynth,
    BUILTIN_BASE, BUILTIN_INDEX_SCHEMA, loadBuiltinIndex, loadBuiltinPack, builtinUrl,
    BUILTIN_TIMEOUT_MS, BUILTIN_FAIL_COPY, builtinFailCopy, loadBuiltinPackEx,
    builtinPackUrl, builtinCacheKey,
    builtinWindowOf, dayPackOf, daysOf, pickDayPack,
  };
});
