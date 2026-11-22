/* features/replay_readonly.js —— 组3 · 只读回放
 *
 * 只读已收盘的日 K 与分时：
 *   数据入口统一走 PanjiSnapshot.resolveSnapshot()（随包 builtin/index.json
 *   + builtin/pack/<code>.<window>.json.gz），不建立任何实时请求。
 *
 * 条件：5 条固定条件，门槛全部由使用者自己填；只报「条件命中 n/5 条」，
 *   不做评价、不做合成结论。条件顺序固定，不因结果改变位置。
 *
 * 边界：本文件为新增模块，不修改 features/replay.js 与 replay.html；
 *   不做主动触达；页面打开时才读数据。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.PanjiReplayReadonly = factory(root);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  const INDEX_SCHEMA = 'panji.builtin.index.v1';
  const PACK_SCHEMA = 'panji.klines.v1';
  const LS_KEY = 'guanzhu_rr_v1';
  const BAR_MIN = 1;
  const PACK_TIMEOUT_MS = 20000;
  const DAILY_VIEW = 60;

  const CONDITION_DEFS = [
    { id: 'prevShrink', label: '前日缩量', setting: 'shrinkMax', unit: '%' },
    { id: 'volUp', label: '今放量', setting: 'volUpMin', unit: '%' },
    { id: 'yang', label: '阳线', setting: null, unit: '' },
    { id: 'aboveMA', label: '站上均线', setting: 'maDays', unit: '日' },
    { id: 'rise', label: '当日涨幅', setting: 'riseMin', unit: '%' }
  ];

  const DEFAULT_SETTINGS = { shrinkMax: null, volUpMin: null, maDays: null, riseMin: null };

  function fetchOf(o) {
    if (o && typeof o.fetch === 'function') return o.fetch;
    return (root && typeof root.fetch === 'function') ? root.fetch.bind(root) : null;
  }

  function bufToText(buf, o) {
    if (typeof buf === 'string') return Promise.resolve(buf);
    if (o && typeof o.gunzip === 'function') {
      return Promise.resolve().then(() => o.gunzip(buf)).then((s) => String(s));
    }
    const DS = root && root.DecompressionStream;
    const RS = root && root.Response;
    const BL = root && root.Blob;
    if (DS && RS && BL) {
      try {
        return RS.prototype.text
          ? new RS(new BL([buf]).stream().pipeThrough(new DS('gzip'))).text()
          : Promise.reject(new Error('gunzip_unsupported'));
      } catch (e) { return Promise.reject(new Error('gunzip_unsupported')); }
    }
    if (typeof require === 'function') {
      try {
        const zlib = require('zlib');
        return Promise.resolve(zlib.gunzipSync(Buffer.from(buf)).toString('utf8'));
      } catch (e) { return Promise.reject(new Error('gunzip_failed')); }
    }
    return Promise.reject(new Error('gunzip_unsupported'));
  }

  function fetchBuffer(f, url, ms) {
    const AC = root && root.AbortController;
    let ctl = null;
    let timer = null;
    if (AC && ms > 0) {
      try { ctl = new AC(); } catch (e) { ctl = null; }
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(v);
      };
      if (ms > 0) {
        timer = setTimeout(() => {
          try { if (ctl) ctl.abort(); } catch (e) { /* 忽略 */ }
          done(null);
        }, ms);
      }
      Promise.resolve().then(() => f(url, ctl ? { signal: ctl.signal } : undefined))
        .then((res) => {
          if (!res || !res.ok) return done(null);
          if (typeof res.arrayBuffer !== 'function') {
            return Promise.resolve(res.text()).then((t) => done(t), () => done(null));
          }
          return Promise.resolve(res.arrayBuffer()).then((b) => done(b), () => done(null));
        }, () => done(null));
    });
  }

  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function day8(v) { return digits(v).slice(0, 8); }
  function d10(day) {
    const s = digits(day);
    return s.length >= 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '—';
  }
  function tLabel(t) {
    const s = digits(t);
    return s.length >= 12 ? s.slice(8, 10) + ':' + s.slice(10, 12) : '—';
  }
  function pct1(v) { return (Math.round(+v * 10) / 10).toFixed(1) + '%'; }
  function price2(v) { return (Math.round(+v * 100) / 100).toFixed(2); }
  function volText(v) {
    const n = Math.round(+v || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function validIndex(idx) {
    return !!(idx && idx.schema === INDEX_SCHEMA
      && Array.isArray(idx.windows) && idx.windows.length
      && Array.isArray(idx.symbols) && idx.symbols.length);
  }

  function windowOf(index, day) {
    const d = day8(day);
    if (!validIndex(index) || d.length !== 8) return '';
    const wins = index.windows || [];
    for (let i = 0; i < wins.length; i += 1) {
      const w = wins[i];
      if (d >= String(w.first) && d <= String(w.last)) return String(w.id);
    }
    return '';
  }

  function parseBars(list) {
    if (!list) return null;
    const rows = Array.isArray(list) ? list : String(list).split(/\s+/).filter(Boolean);
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const p = typeof row === 'string' ? row.split(',') : null;
      if (!p || p.length < 6) return null;
      const t = digits(p[0]).slice(0, 12);
      const o = +p[1]; const h = +p[2]; const l = +p[3]; const c = +p[4]; const v = +p[5];
      if (t.length !== 12 || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0) || !(v >= 0)) return null;
      if (h < Math.max(o, c) || l > Math.min(o, c)) return null;
      if (seen[t]) return null;
      seen[t] = 1;
      out.push({ t: t, o: o, h: h, l: l, c: c, v: v });
    }
    if (!out.length) return null;
    out.sort(function (a, b) { return a.t < b.t ? -1 : (a.t > b.t ? 1 : 0); });
    return out;
  }

  function aggregateDaily(bars) {
    const out = [];
    let cur = null;
    for (let i = 0; i < (bars || []).length; i += 1) {
      const b = bars[i];
      const d = day8(b.t);
      if (!cur || cur.d !== d) {
        cur = { d: d, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, bars: 0 };
        out.push(cur);
      }
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v;
      cur.bars += 1;
    }
    for (let i = 1; i < out.length; i += 1) out[i].prevClose = out[i - 1].c;
    return out;
  }

  function resolveSnapshotOf(opts) {
    const o = opts || {};
    if (o.snapshot) return Promise.resolve(o.snapshot);
    const S = root && root.PanjiSnapshot;
    if (!S || typeof S.resolveSnapshot !== 'function') return Promise.resolve(null);
    return Promise.resolve(S.resolveSnapshot({ fetch: o.fetch, auto: o.auto, noBundle: o.noBundle })).catch(function () { return null; });
  }

  function loadPack(snap, code, win, opts) {
    const o = opts || {};
    const key = String(snap.version || '') + '|' + String(code) + '|' + String(win);
    if (o.cache && o.cache.has && o.cache.has(key)) return Promise.resolve(o.cache.get(key));
    const url = (typeof snap.packUrl === 'function') ? String(snap.packUrl(code, win) || '') : '';
    if (!url) return Promise.resolve(null);
    const f = fetchOf(o);
    if (!f) return Promise.resolve(null);
    return fetchBuffer(f, url, o.packTimeoutMs || PACK_TIMEOUT_MS).then(function (buf) {
      if (buf == null) return null;
      return bufToText(buf, o).then(function (txt) {
        let obj;
        try { obj = JSON.parse(txt); } catch (e) { return null; }
        if (!obj || obj.schema !== PACK_SCHEMA) return null;
        if (day8(obj.symbol) !== day8(code)) return null;
        const bars = parseBars(obj.bars);
        if (!bars) return null;
        const pack = {
          code: day8(obj.symbol),
          name: String(obj.name == null ? '' : obj.name),
          window: String(win),
          first: day8(obj.first) || day8(bars[0].t),
          last: day8(obj.last) || day8(bars[bars.length - 1].t),
          bars: bars,
          url: url
        };
        if (o.cache && o.cache.set) {
          // 只留最近两片：单片解析后约 3–5 MB，低端机不常驻更多
          if (o.cache.size && o.cache.size >= 2) {
            const oldest = o.cache.keys().next().value;
            o.cache.delete(oldest);
          }
          o.cache.set(key, pack);
        }
        return pack;
      });
    }, function () { return null; });
  }

  /**
   * loadDay(code, day, opts) -> Promise<
   *   { ok:true, source, version, cutoffDay, pack, daily, dayIndex, dayBars }
   *   | { ok:false, error:'snapshot_unavailable'|'day_out_of_window'|'pack_unavailable'|'day_not_in_pack' }
   * >
   * opts.snapshot 可直接注入（测试）；opts.fetch / opts.auto 透传给 resolveSnapshot。
   */
  function loadDay(code, day, opts) {
    const o = opts || {};
    const c = day8(code);
    const d = day8(day);
    if (c.length !== 6 || d.length !== 8) return Promise.resolve({ ok: false, error: 'bad_params' });
    return resolveSnapshotOf(o).then(function (snap) {
      if (!snap || !validIndex(snap.index)) return { ok: false, error: 'snapshot_unavailable' };
      const win = windowOf(snap.index, d);
      if (!win) return { ok: false, error: 'day_out_of_window' };
      return loadPack(snap, c, win, o).then(function (pack) {
        if (!pack) return { ok: false, error: 'pack_unavailable' };
        const daily = aggregateDaily(pack.bars);
        let idx = -1;
        for (let i = 0; i < daily.length; i += 1) {
          if (daily[i].d === d) { idx = i; break; }
        }
        if (idx < 0) return { ok: false, error: 'day_not_in_pack' };
        const dayBars = pack.bars.filter(function (b) { return day8(b.t) === d; });
        return {
          ok: true,
          source: snap.source || 'bundle',
          version: String(snap.version || ''),
          cutoffDay: String(snap.cutoffDay || ''),
          pack: pack,
          daily: daily,
          dayIndex: idx,
          dayBars: dayBars
        };
      });
    });
  }

  function daysOf(daily) {
    return (daily || []).map(function (x) { return x.d; });
  }

  function factsOf(daily, i) {
    const d = daily && daily[i];
    if (!d) return null;
    const prev = daily[i - 1] || null;
    const prevClose = prev ? prev.c : null;
    const amplitude = (prevClose && prevClose > 0) ? (d.h - d.l) / prevClose * 100 : null;
    const closePos = (d.h > d.l) ? (d.c - d.l) / (d.h - d.l) * 100 : null;
    return {
      day: d.d,
      o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, bars: d.bars,
      prevClose: prevClose,
      amplitude: amplitude,
      closePos: closePos
    };
  }

  function avgOf(list, from, to, field) {
    if (from < 0 || to >= list.length || to < from) return null;
    let sum = 0;
    for (let i = from; i <= to; i += 1) sum += list[i][field];
    return sum / (to - from + 1);
  }

  function settingOf(settings, key) {
    const v = settings ? settings[key] : null;
    if (v == null || v === '') return null;
    const n = +v;
    if (!isFinite(n) || n <= 0) return null;
    return n;
  }

  function makeRow(def, state, actual, setting, detail) {
    return { id: def.id, label: def.label, state: state, actual: actual, setting: setting, detail: detail || '' };
  }

  /**
   * evaluate(daily, dayIndex, settings) -> {
   *   hits, total, rows:[{id,label,state,actual,setting,detail}]
   * }
   * state ∈ hit / miss / no_setting / no_sample；只数 hit。
   */
  function evaluate(daily, i, settings) {
    const rows = [];
    const d = daily && daily[i];
    const prev = daily && daily[i - 1];
    const s = settings || {};
    if (!d) return { hits: 0, total: CONDITION_DEFS.length, rows: rows };

    // 1) 前日缩量：前日量 ÷ 前 5 日均量 < 门槛
    (function () {
      const def = CONDITION_DEFS[0];
      const th = settingOf(s, 'shrinkMax');
      const base = avgOf(daily, i - 6, i - 2, 'v');
      if (!prev || th == null) {
        rows.push(makeRow(def, th == null ? 'no_setting' : 'no_sample', '—', th == null ? '未填' : ('< ' + th + '%'), ''));
        return;
      }
      if (base == null || base <= 0) {
        rows.push(makeRow(def, 'no_sample', '—', '< ' + th + '%', '前 5 日均量样本不足'));
        return;
      }
      const ratio = prev.v / base * 100;
      rows.push(makeRow(def, ratio < th ? 'hit' : 'miss', pct1(ratio), '< ' + th + '%',
        '前日量 ' + volText(prev.v) + ' ÷ 前 5 日均量 ' + volText(base)));
    })();

    // 2) 今放量：当日量 ÷ 前 5 日均量 ≥ 门槛
    (function () {
      const def = CONDITION_DEFS[1];
      const th = settingOf(s, 'volUpMin');
      const base = avgOf(daily, i - 5, i - 1, 'v');
      if (th == null) {
        rows.push(makeRow(def, 'no_setting', '—', '未填', ''));
        return;
      }
      if (base == null || base <= 0) {
        rows.push(makeRow(def, 'no_sample', '—', '≥ ' + th + '%', '前 5 日均量样本不足'));
        return;
      }
      const ratio = d.v / base * 100;
      rows.push(makeRow(def, ratio >= th ? 'hit' : 'miss', pct1(ratio), '≥ ' + th + '%',
        '当日量 ' + volText(d.v) + ' ÷ 前 5 日均量 ' + volText(base)));
    })();

    // 3) 阳线：收盘 > 开盘（事实，不设门槛）
    (function () {
      const def = CONDITION_DEFS[2];
      rows.push(makeRow(def, d.c > d.o ? 'hit' : 'miss',
        '收 ' + price2(d.c) + ' / 开 ' + price2(d.o),
        '', ''));
    })();

    // 4) 站上均线：收盘 ≥ N 日均收（N 由使用者填）
    (function () {
      const def = CONDITION_DEFS[3];
      const n = settingOf(s, 'maDays');
      if (n == null) {
        rows.push(makeRow(def, 'no_setting', '收 ' + price2(d.c), '未填', ''));
        return;
      }
      const nn = Math.round(n);
      if (nn < 1) {
        rows.push(makeRow(def, 'no_setting', '收 ' + price2(d.c), '未填', ''));
        return;
      }
      const ma = avgOf(daily, i - nn + 1, i, 'c');
      if (ma == null) {
        rows.push(makeRow(def, 'no_sample', '收 ' + price2(d.c), nn + ' 日均收',
          '前面只有 ' + i + ' 个交易日，不足 ' + nn + ' 日'));
        return;
      }
      rows.push(makeRow(def, d.c >= ma ? 'hit' : 'miss', '收 ' + price2(d.c), nn + ' 日均收',
        '该日均收 ' + price2(ma) + '（你设 ' + nn + ' 日）'));
    })();

    // 5) 当日涨幅：相对前收 ≥ 门槛
    (function () {
      const def = CONDITION_DEFS[4];
      const th = settingOf(s, 'riseMin');
      if (th == null) {
        rows.push(makeRow(def, 'no_setting', '—', '未填', ''));
        return;
      }
      if (!prev || !(prev.c > 0)) {
        rows.push(makeRow(def, 'no_sample', '—', '≥ ' + th + '%', '窗口首日没有前收'));
        return;
      }
      const chg = (d.c - prev.c) / prev.c * 100;
      const sign = chg > 0 ? '+' : '';
      rows.push(makeRow(def, chg >= th ? 'hit' : 'miss', sign + pct1(chg), '≥ ' + th + '%',
        '前收 ' + price2(prev.c)));
    })();

    let hits = 0;
    rows.forEach(function (r) { if (r.state === 'hit') hits += 1; });
    return { hits: hits, total: CONDITION_DEFS.length, rows: rows };
  }

  function countText(res) {
    const n = res ? res.hits : 0;
    const t = res ? res.total : CONDITION_DEFS.length;
    return '条件命中 ' + n + '/' + t + ' 条';
  }

  function readSettings() {
    try {
      const raw = root && root.localStorage && root.localStorage.getItem(LS_KEY);
      if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
      const obj = JSON.parse(raw);
      const out = Object.assign({}, DEFAULT_SETTINGS);
      Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
        if (obj && obj[k] != null && obj[k] !== '') out[k] = +obj[k];
      });
      return out;
    } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }

  function saveSettings(s) {
    try {
      if (root && root.localStorage) root.localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch (e) { /* 存不下不影响本次显示 */ }
  }

  /* ---------------- 画布 ---------------- */
  function cssVar(name, fallback) {
    try {
      if (root && root.getComputedStyle && root.document) {
        const v = root.getComputedStyle(root.document.documentElement).getPropertyValue(name);
        if (v && v.trim()) return v.trim();
      }
    } catch (e) { /* 走兜底 */ }
    return fallback;
  }

  function canvasBox(cv) {
    const dpr = Math.min(2, (root && root.devicePixelRatio) || 1);
    const w = cv.clientWidth || 358;
    const h = cv.clientHeight || 200;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g: g, w: w, h: h };
  }

  function line(g, x1, y1, x2, y2, color, width, dash) {
    g.save();
    g.strokeStyle = color;
    g.lineWidth = width || 1;
    if (dash) g.setLineDash(dash);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.restore();
  }

  function drawDaily(cv, daily, upto) {
    if (!cv) return;
    const box = canvasBox(cv);
    const g = box.g;
    const w = box.w;
    const h = box.h;
    const all = daily || [];
    if (!all.length) {
      g.fillStyle = cssVar('--pal-text-weak', '#666');
      g.font = '12px sans-serif';
      g.fillText('没有可画的日线', 10, 22);
      return;
    }
    const end = Math.max(0, Math.min(all.length - 1, upto));
    const from = Math.max(0, end - DAILY_VIEW + 1);
    const view = all.slice(from, end + 1);
    const pad = { l: 6, r: 44, t: 10, b: 18 };
    let lo = Infinity;
    let hi = -Infinity;
    view.forEach(function (b) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
    if (!(hi > lo)) { hi = lo + 0.01; lo -= 0.01; }
    const padP = (hi - lo) * 0.04;
    lo -= padP; hi += padP;
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const y = function (p) { return pad.t + (hi - p) / (hi - lo) * plotH; };

    const grid = cssVar('--pal-grid-major', '#e3e3e3');
    const weak = cssVar('--pal-text-weak', '#666');
    for (let k = 0; k <= 3; k += 1) {
      const p = lo + (hi - lo) * k / 3;
      const yy = y(p);
      line(g, pad.l, yy, w - pad.r, yy, grid, 1);
      g.fillStyle = weak;
      g.font = '9px sans-serif';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(price2(p), w - 3, yy);
    }

    const step = plotW / (view.length + 1);
    const bw = Math.min(8, Math.max(1.2, step * 0.62));
    const up = cssVar('--pal-up-solid', '#ef4358');
    const dn = cssVar('--pal-down-solid', '#00c48a');
    const restAlpha = 0.55;
    view.forEach(function (b, i) {
      const x = pad.l + step * (i + 0.5);
      const color = b.c >= b.o ? up : dn;
      g.save();
      g.globalAlpha = (i === view.length - 1) ? 1 : restAlpha;
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y(b.h));
      g.lineTo(x, y(b.l));
      g.stroke();
      const y1 = y(Math.max(b.o, b.c));
      const y2 = y(Math.min(b.o, b.c));
      g.fillStyle = color;
      g.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
      g.restore();
    });

    const accent = cssVar('--pal-accent', '#0a6b7c');
    g.strokeStyle = accent;
    g.lineWidth = 1;
    g.strokeRect(pad.l + step * (view.length - 0.5) - bw / 2 - 1, pad.t, bw + 2, plotH);
    g.fillStyle = weak;
    g.font = '9px sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(d10(view[0].d).slice(5), pad.l, h - 14);
    g.textAlign = 'right';
    g.fillText(d10(view[view.length - 1].d).slice(5), w - pad.r, h - 14);
  }

  function drawIntraday(cv, bars, prevClose) {
    if (!cv) return;
    const box = canvasBox(cv);
    const g = box.g;
    const w = box.w;
    const h = box.h;
    const list = bars || [];
    if (list.length < 2) {
      g.fillStyle = cssVar('--pal-text-weak', '#666');
      g.font = '12px sans-serif';
      g.fillText('该交易日没有可画的分时', 10, 22);
      return;
    }
    const pad = { l: 6, r: 44, t: 10, b: 18 };
    let lo = Infinity;
    let hi = -Infinity;
    list.forEach(function (b) { if (b.c < lo) lo = b.c; if (b.c > hi) hi = b.c; });
    if (prevClose && prevClose > 0) {
      if (prevClose < lo) lo = prevClose;
      if (prevClose > hi) hi = prevClose;
    }
    if (!(hi > lo)) { hi = lo + 0.01; lo -= 0.01; }
    const padP = (hi - lo) * 0.06;
    lo -= padP; hi += padP;
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const y = function (p) { return pad.t + (hi - p) / (hi - lo) * plotH; };

    const grid = cssVar('--pal-grid-major', '#e3e3e3');
    const weak = cssVar('--pal-text-weak', '#666');
    for (let k = 0; k <= 3; k += 1) {
      const p = lo + (hi - lo) * k / 3;
      const yy = y(p);
      line(g, pad.l, yy, w - pad.r, yy, grid, 1);
      g.fillStyle = weak;
      g.font = '9px sans-serif';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(price2(p), w - 3, yy);
    }

    if (prevClose && prevClose > 0) {
      const yy = y(prevClose);
      line(g, pad.l, yy, w - pad.r, yy, weak, 1, [4, 3]);
      g.fillStyle = weak;
      g.font = '9px sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText('前收 ' + price2(prevClose), pad.l + 2, yy - 1);
    }

    const accent = cssVar('--pal-accent', '#0a6b7c');
    const step = plotW / Math.max(1, list.length - 1);
    g.strokeStyle = accent;
    g.lineWidth = 1.5;
    g.beginPath();
    list.forEach(function (b, i) {
      const x = pad.l + step * i;
      if (i === 0) g.moveTo(x, y(b.c));
      else g.lineTo(x, y(b.c));
    });
    g.stroke();

    const last = list[list.length - 1];
    const lastDot = cssVar('--pal-accent-2', '#b23e07');
    g.fillStyle = lastDot;
    g.beginPath();
    g.arc(pad.l + step * (list.length - 1), y(last.c), 2.4, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = weak;
    g.font = '9px sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(tLabel(list[0].t), pad.l, h - 14);
    g.textAlign = 'right';
    g.fillText(tLabel(last.t), w - pad.r, h - 14);
  }

  /* ---------------- 页面 ---------------- */
  function el(tag, cls, text) {
    const n = root.document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function opt(value, label) {
    const o = root.document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  function mount(box, opts) {
    const o = opts || {};
    if (!box || !root.document) return null;
    const doc = root.document;
    box.textContent = '';

    const head = el('div', 'rr-head');
    head.appendChild(el('h1', null, '只读回放'));
    head.appendChild(el('p', 'rr-sub', '已收盘的日 K 与分时。数据随应用提供，打开页面才读取。'));
    box.appendChild(head);

    const meta = el('div', 'rr-meta');
    box.appendChild(meta);

    const status = el('div', 'rr-status');
    status.hidden = true;
    box.appendChild(status);

    const picker = el('div', 'rr-picker');
    const winLab = el('label', null, '窗口');
    const winSel = doc.createElement('select');
    winSel.id = 'rr-win';
    winLab.appendChild(winSel);
    const codeLab = el('label', null, '标的');
    const codeSel = doc.createElement('select');
    codeSel.id = 'rr-code';
    codeLab.appendChild(codeSel);
    const dayLab = el('label', null, '交易日');
    const daySel = doc.createElement('select');
    daySel.id = 'rr-day';
    dayLab.appendChild(daySel);
    picker.appendChild(winLab);
    picker.appendChild(codeLab);
    picker.appendChild(dayLab);
    box.appendChild(picker);

    const dailyBlock = el('section', 'rr-block');
    dailyBlock.appendChild(el('h2', null, '日 K'));
    dailyBlock.appendChild(el('p', 'rr-hint', '只画到所选交易日收盘。'));
    const dailyCv = doc.createElement('canvas');
    dailyCv.className = 'rr-canvas';
    dailyBlock.appendChild(dailyCv);
    box.appendChild(dailyBlock);

    const intraBlock = el('section', 'rr-block');
    intraBlock.appendChild(el('h2', null, '分时'));
    intraBlock.appendChild(el('p', 'rr-hint', '所选交易日的分钟收盘价，已收盘。'));
    const intraCv = doc.createElement('canvas');
    intraCv.className = 'rr-canvas';
    intraBlock.appendChild(intraCv);
    box.appendChild(intraBlock);

    const factsBlock = el('section', 'rr-block');
    factsBlock.appendChild(el('h2', null, '当日事实'));
    const factsBox = el('div', 'rr-facts');
    factsBlock.appendChild(factsBox);
    box.appendChild(factsBlock);

    const condBlock = el('section', 'rr-block');
    condBlock.appendChild(el('h2', null, '条件'));
    condBlock.appendChild(el('p', 'rr-hint', '门槛由你自己填；这里只报命中条数。'));
    const settingsBox = el('div', 'rr-settings');
    const countBox = el('div', 'rr-count');
    const rowsBox = el('div', 'rr-rows');
    condBlock.appendChild(settingsBox);
    condBlock.appendChild(countBox);
    condBlock.appendChild(rowsBox);
    box.appendChild(condBlock);

    const state = {
      snap: null,
      pack: null,
      code: '',
      win: '',
      day: '',
      dayIndex: 0,
      daily: [],
      dayBars: [],
      settings: readSettings(),
      cache: new Map()
    };
    renderSettings();

    function showStatus(text, detail) {
      status.textContent = '';
      const p = el('p', 'rr-status-main', text);
      status.appendChild(p);
      if (detail) status.appendChild(el('p', 'rr-status-detail', detail));
      status.hidden = false;
      dailyBlock.hidden = true;
      intraBlock.hidden = true;
      factsBlock.hidden = true;
      condBlock.hidden = true;
    }

    function clearStatus() {
      status.hidden = true;
      dailyBlock.hidden = false;
      intraBlock.hidden = false;
      factsBlock.hidden = false;
      condBlock.hidden = false;
    }

    function renderMeta() {
      meta.textContent = '';
      const src = state.snap && state.snap.source === 'remote' ? '本机快照' : '随包';
      const win = state.snap && state.snap.index ? state.snap.index.windows.filter(function (w) {
        return String(w.id) === state.win;
      })[0] : null;
      const parts = [
        '数据：' + src,
        '版本 ' + (state.snap && state.snap.version ? state.snap.version : '—'),
        '截止 ' + d10((state.snap && state.snap.cutoffDay) || ''),
        win ? (d10(win.first) + ' ~ ' + d10(win.last)) : '—',
        '不复权'
      ];
      meta.textContent = parts.join(' · ');
    }

    function fillWindows() {
      winSel.textContent = '';
      const wins = (state.snap && state.snap.index && state.snap.index.windows) || [];
      wins.forEach(function (w) {
        winSel.appendChild(opt(String(w.id), String(w.id) + '  ' + d10(w.first) + '~' + d10(w.last)));
      });
    }

    function fillSymbols() {
      codeSel.textContent = '';
      const syms = (state.snap && state.snap.index && state.snap.index.symbols) || [];
      syms.forEach(function (s) {
        const code = day8(s.code);
        codeSel.appendChild(opt(code, code + '  ' + String(s.name == null ? '' : s.name)));
      });
    }

    function fillDays() {
      daySel.textContent = '';
      daysOf(state.daily).forEach(function (d) {
        daySel.appendChild(opt(d, d10(d)));
      });
    }

    function renderFacts() {
      factsBox.textContent = '';
      const f = factsOf(state.daily, state.dayIndex);
      if (!f) return;
      const grid = el('div', 'rr-fact-grid');
      const items = [
        ['开', price2(f.o)],
        ['高', price2(f.h)],
        ['低', price2(f.l)],
        ['收', price2(f.c)],
        ['成交量', volText(f.v)],
        ['分钟根数', String(f.bars)]
      ];
      items.forEach(function (it) {
        const cell = el('div', 'rr-fact');
        cell.appendChild(el('span', 'rr-fact-k', it[0]));
        cell.appendChild(el('b', 'rr-fact-v', it[1]));
        grid.appendChild(cell);
      });
      factsBox.appendChild(grid);
      const lines = [];
      if (f.amplitude != null) lines.push('当日振幅 ' + pct1(f.amplitude) + '（高-低 ÷ 前收）');
      else lines.push('当日振幅 —（窗口首日没有前收）');
      if (f.closePos != null) lines.push('收盘位于当日区间 ' + Math.round(f.closePos) + ' 分位');
      else lines.push('收盘位于当日区间 —（当日最高等于最低）');
      const note = el('p', 'rr-fact-note', lines.join(' · '));
      factsBox.appendChild(note);
    }

    function renderSettings() {
      settingsBox.textContent = '';
      const defs = [
        { key: 'shrinkMax', label: '前日缩量', mid: '前日量 ÷ 前 5 日均量 <', unit: '%' },
        { key: 'volUpMin', label: '今放量', mid: '当日量 ÷ 前 5 日均量 ≥', unit: '%' },
        { key: 'maDays', label: '站上均线', mid: '收盘 ≥', unit: '日均收' },
        { key: 'riseMin', label: '当日涨幅', mid: '相对前收 ≥', unit: '%' }
      ];
      defs.forEach(function (d) {
        const row = el('div', 'rr-set');
        row.appendChild(el('span', 'rr-set-k', d.label));
        row.appendChild(el('span', 'rr-set-mid', d.mid));
        const inp = doc.createElement('input');
        inp.type = 'number';
        inp.inputMode = 'decimal';
        inp.min = '0';
        inp.step = '1';
        inp.className = 'rr-set-in';
        inp.setAttribute('aria-label', d.label);
        const cur = state.settings[d.key];
        inp.value = (cur == null) ? '' : String(cur);
        inp.addEventListener('input', function () {
          const raw = inp.value.trim();
          state.settings[d.key] = raw === '' ? null : +raw;
          saveSettings(state.settings);
          renderConditions();
        });
        row.appendChild(inp);
        row.appendChild(el('span', 'rr-set-unit', d.unit));
        settingsBox.appendChild(row);
      });
    }

    function renderConditions() {
      const res = evaluate(state.daily, state.dayIndex, state.settings);
      countBox.textContent = countText(res);
      rowsBox.textContent = '';
      res.rows.forEach(function (r) {
        const row = el('div', 'rr-row');
        row.setAttribute('data-state', r.state);
        const marks = { hit: '成立', miss: '未成立', no_setting: '未设门槛', no_sample: '样本不足' };
        row.appendChild(el('span', 'rr-row-mark', marks[r.state] || '—'));
        row.appendChild(el('span', 'rr-row-label', r.label));
        const act = el('span', 'rr-row-actual');
        act.textContent = r.actual;
        row.appendChild(act);
        if (r.setting) {
          const set = el('span', 'rr-row-setting');
          set.textContent = '你设：' + r.setting;
          row.appendChild(set);
        }
        if (r.detail) row.appendChild(el('span', 'rr-row-detail', r.detail));
        rowsBox.appendChild(row);
      });
      return res;
    }

    function renderDay() {
      const f = factsOf(state.daily, state.dayIndex);
      renderFacts();
      renderMeta();
      drawDaily(dailyCv, state.daily, state.dayIndex);
      drawIntraday(intraCv, state.dayBars, f ? f.prevClose : null);
      renderConditions();
    }

    function loadWindowDay(dayWanted) {
      const d = dayWanted || state.day;
      return loadDay(state.code, d, { snapshot: state.snap, fetch: o.fetch, cache: state.cache, gunzip: o.gunzip })
        .then(function (r) {
          if (!r.ok) {
            showStatus(r.error === 'pack_unavailable'
              ? '该标的此窗口的随包分片没读到。'
              : '所选交易日不在随包数据里。', r.error);
            return false;
          }
          state.pack = r.pack;
          state.daily = r.daily;
          state.dayBars = r.dayBars;
          state.dayIndex = r.dayIndex;
          state.day = state.daily[state.dayIndex].d;
          clearStatus();
          fillDays();
          daySel.value = state.day;
          renderDay();
          return true;
        });
    }

    function reloadPack(dayWanted) {
      // 先按目标窗口取新片；取到后再定日期
      const first = state.daily.length ? state.daily[0].d : '';
      return loadDay(state.code, dayWanted || first || '20260101', {
        snapshot: state.snap, fetch: o.fetch, cache: state.cache, gunzip: o.gunzip
      }).then(function (r) {
        if (!r.ok) {
          showStatus('该标的此窗口的随包分片没读到。', r.error);
          return false;
        }
        state.pack = r.pack;
        state.daily = r.daily;
        state.dayBars = r.dayBars;
        state.dayIndex = r.dayIndex;
        state.day = state.daily[state.dayIndex].d;
        clearStatus();
        fillDays();
        daySel.value = state.day;
        renderDay();
        return true;
      });
    }

    winSel.addEventListener('change', function () {
      state.win = winSel.value;
      const wins = (state.snap && state.snap.index && state.snap.index.windows) || [];
      const w = wins.filter(function (x) { return String(x.id) === state.win; })[0];
      // 换窗口：从该窗口最后一天起读
      reloadPack(w ? day8(w.last) : '');
    });

    codeSel.addEventListener('change', function () {
      state.code = codeSel.value;
      reloadPack(state.daily.length ? state.daily[state.daily.length - 1].d : '');
    });

    daySel.addEventListener('change', function () {
      loadWindowDay(daySel.value);
    });

    // 首次：resolveSnapshot -> 选默认窗口/标的/日期
    return resolveSnapshotOf(o).then(function (snap) {
      if (!snap || !validIndex(snap.index)) {
        meta.textContent = '';
        showStatus('随包数据未读到。', 'resolveSnapshot() 返回空。');
        return null;
      }
      state.snap = snap;
      const wins = snap.index.windows || [];
      let w = wins[0];
      wins.forEach(function (x) { if (String(x.last) > String(w.last)) w = x; });
      state.win = String(w.id);
      state.code = day8(snap.index.symbols[0].code);
      fillWindows();
      fillSymbols();
      winSel.value = state.win;
      codeSel.value = state.code;
      renderMeta();

      state.day = day8(w.last);
      return loadDay(state.code, state.day, {
        snapshot: state.snap, fetch: o.fetch, cache: state.cache, gunzip: o.gunzip
      }).then(function (r) {
        if (!r.ok) {
          showStatus('该标的此窗口的随包分片没读到。', r.error);
          return null;
        }
        state.pack = r.pack;
        state.daily = r.daily;
        state.dayBars = r.dayBars;
        state.dayIndex = r.dayIndex;
        state.day = state.daily[state.dayIndex].d;
        clearStatus();
        fillDays();
        daySel.value = state.day;
        renderDay();
        return state;
      });
    }).catch(function (e) {
      showStatus('读取随包数据时出错。', (e && e.message) || '');
      return null;
    });
  }

  return {
    INDEX_SCHEMA: INDEX_SCHEMA,
    PACK_SCHEMA: PACK_SCHEMA,
    BAR_MIN: BAR_MIN,
    LS_KEY: LS_KEY,
    CONDITION_DEFS: CONDITION_DEFS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    validIndex: validIndex,
    windowOf: windowOf,
    parseBars: parseBars,
    aggregateDaily: aggregateDaily,
    daysOf: daysOf,
    factsOf: factsOf,
    evaluate: evaluate,
    countText: countText,
    readSettings: readSettings,
    saveSettings: saveSettings,
    resolveSnapshotOf: resolveSnapshotOf,
    loadPack: loadPack,
    loadDay: loadDay,
    mount: mount,
    drawDaily: drawDaily,
    drawIntraday: drawIntraday,
    d10: d10
  };
});
