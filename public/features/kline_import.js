// kline_import.js —— 用户自带行情文件导入（纯前端 / 只存本机）
// 支持：通达信二进制 .day / .lc5 / .lc1；CSV / TXT（同花顺、东方财富、通达信文本导出）
// 边界：不请求网络、不上传、不预置任何真实票；所有数据只写 localStorage。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PanjiKlineImport = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const KEY = 'guanzhu_userkline_v1';
  const MAX_BARS = 60000;               // 单文件上限（约 1 分钟线 4 个月）
  const MAX_ITEMS = 8;
  const MAX_JSON = 3.5 * 1024 * 1024;   // localStorage 保守上限
  const TZ_OFFSET_MIN = 480;            // Asia/Shanghai = UTC+8

  const ERRORS = {
    FORMAT: '文件不是可识别的行情文件。支持通达信 .day/.lc5/.lc1，或带表头的 CSV/TXT（时间、开盘、最高、最低、收盘）。',
    BINARY_LEN: '通达信文件长度不是 32 字节的整数倍，可能下载不完整或不是通达信原始数据文件。',
    EMPTY: '文件里没有有效的数据行。',
    MISSING_FIELD: '缺少必需字段。至少需要时间（日期/时间）、开盘、最高、最低、收盘；成交量可选。',
    TIME_ORDER: '时间不是从早到晚。行情文件必须按时间正序导出；混入不同日期或不同周期也会触发。',
    DUP_TIME: '同一时间出现两根 K 线，文件可能被重复导出或拼接。',
    OHLC: '价格不自洽：最高价低于开盘/收盘，或最低价高于开盘/收盘。',
    BAD_PRICE: '价格字段不是有效数字。',
    NEED_CSV: '同花顺/东方财富导出的 .xls/.xlsx 需要在客户端里另存为 CSV（UTF-8 或 GBK）后再导入；本产品不解析 Excel 二进制。',
    TOO_BIG: '文件太大（单文件最多 ' + MAX_BARS + ' 根 K 线）。请按月份或按周期拆成多个文件导入。',
    QUOTA: '浏览器本机存储空间不足。请先删除旧文件，或换用 Chrome/Edge 并清理本站存储后重试。',
    ADJUST: '成交价与 K 线区间差得太远，像是复权口径不一致。请让行情文件与成交价使用同一口径（不复权 / 前复权 / 后复权）。',
    NO_TIME: '这笔成交没有时间，无法落到分钟轴上。',
    OUT_OF_RANGE: '这笔成交不在导入数据的日期范围内。请导入覆盖该日期的文件。',
    NO_BAR: '这笔成交落在导入数据的空档里（例如午休、停牌或该分钟没有 K 线）。',
    NO_STORAGE: '当前浏览器不允许本机存储，导入无法保存。',
  };

  function err(code, detail) {
    return { ok: false, code: code, message: ERRORS[code] || '解析失败', detail: detail == null ? null : String(detail) };
  }

  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

  function bytesOf(v) {
    if (!v) return null;
    if (typeof v === 'string') return null;
    if (v instanceof Uint8Array) return v;
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return new Uint8Array(v);
    if (v.buffer && v.byteOffset != null && v.byteLength != null) {
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    return null;
  }

  function decodeText(bytes) {
    if (typeof TextDecoder === 'undefined') {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return { text: s, encoding: 'latin1' };
    }
    const u = new TextDecoder('utf-8').decode(bytes);
    const badU = (u.match(/\uFFFD/g) || []).length;
    if (badU > Math.max(2, Math.floor(u.length * 0.002))) {
      try {
        const g = new TextDecoder('gb18030').decode(bytes);
        if ((g.match(/\uFFFD/g) || []).length <= badU) return { text: g.replace(/^\uFEFF/, ''), encoding: 'gb18030' };
      } catch (e) { /* 浏览器不支持 gb18030 时退回 utf-8 */ }
    }
    return { text: u.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  }

  function normCode(v) {
    return String(v == null ? '' : v).trim().toLowerCase()
      .replace(/^(sh|sz|bj)/, '').replace(/\.(sh|sz|bj)$/, '').replace(/[^a-z0-9]/g, '');
  }

  function codeFromName(name) {
    const base = String(name || '').replace(/^.*[\\/]/, '').replace(/\.(day|lc5|lc1|csv|txt|xls|xlsx)$/i, '');
    const m = base.match(/((?:sh|sz|bj)?\d{6})/i);
    if (m) return m[1].toUpperCase();
    const K = base.match(/[A-Za-z]{1,4}\d{3,6}/);
    if (K) return K[0].toUpperCase();
    return base.split(/[_\-\s.]+/)[0] || '未命名';
  }

  function hashId(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  function fmtPrice(v) { return (+v).toFixed(2); }

  function timeLabel(t, tf) {
    const s = digits(t);
    if (tf === 'day' || s.length <= 8) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12);
  }

  function tfLabel(tf) {
    if (tf === 'day') return '日线';
    if (tf === '5m') return '5 分钟';
    if (tf === '1m') return '1 分钟';
    if (/^\d+m$/.test(String(tf))) return tf.slice(0, -1) + ' 分钟';
    return '分钟线';
  }

  function adjustLabel(a) {
    if (a === 'qfq') return '前复权';
    if (a === 'hfq') return '后复权';
    if (a === 'none') return '不复权';
    return '未标注（按原样使用）';
  }

  function isDate(y, m, d) {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /* ================= 通达信二进制 ================= */
  function parseTdxBinary(name, ext, bytes) {
    if (!bytes.length) return err('EMPTY');
    if (bytes.length % 32 !== 0) return err('BINARY_LEN', '长度 ' + bytes.length + ' 字节，余 ' + (bytes.length % 32));
    const tf = ext === 'day' ? 'day' : (ext === 'lc5' ? '5m' : '1m');
    const bars = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let prev = '';
    for (let i = 0; i < bytes.length / 32; i++) {
      const off = i * 32;
      let t = '';
      let o, h, l, c, v, a;
      if (ext === 'day') {
        const n = dv.getUint32(off, true);
        const y = Math.floor(n / 10000), mo = Math.floor((n / 100) % 100), d = n % 100;
        if (!isDate(y, mo, d)) return err('FORMAT', '第 ' + (i + 1) + ' 条的日期 ' + n + ' 不是有效日期');
        t = String(y) + String(mo).padStart(2, '0') + String(d).padStart(2, '0') + '0000';
        o = dv.getUint32(off + 4, true) / 100;
        h = dv.getUint32(off + 8, true) / 100;
        l = dv.getUint32(off + 12, true) / 100;
        c = dv.getUint32(off + 16, true) / 100;
        a = dv.getFloat32(off + 20, true);
        v = dv.getUint32(off + 24, true);
      } else {
        const n = dv.getUint16(off, true);
        const y = Math.floor(n / 2048) + 2004;
        const rem = n % 2048;
        const mo = Math.floor(rem / 100), d = rem % 100;
        if (!isDate(y, mo, d)) return err('FORMAT', '第 ' + (i + 1) + ' 条的日期编码 ' + n + ' 不是有效日期');
        const mins = dv.getUint16(off + 2, true);
        if (mins > 1439) return err('FORMAT', '第 ' + (i + 1) + ' 条的分钟数 ' + mins + ' 超过一天');
        t = String(y) + String(mo).padStart(2, '0') + String(d).padStart(2, '0')
          + String(Math.floor(mins / 60)).padStart(2, '0') + String(mins % 60).padStart(2, '0');
        o = dv.getFloat32(off + 4, true);
        h = dv.getFloat32(off + 8, true);
        l = dv.getFloat32(off + 12, true);
        c = dv.getFloat32(off + 16, true);
        a = dv.getFloat32(off + 20, true);
        v = dv.getUint32(off + 24, true);
      }
      const bad = [o, h, l, c].some(function (p) { return !isFinite(p) || p <= 0 || p > 100000; });
      if (bad) return err('BAD_PRICE', '第 ' + (i + 1) + ' 条价格 ' + [o, h, l, c].join('/') + ' 不是有效价格');
      if (h + 1e-6 < Math.max(o, c) || l - 1e-6 > Math.min(o, c)) {
        return err('OHLC', '第 ' + (i + 1) + ' 条 高/低 与 开/收 矛盾');
      }
      if (prev && t < prev) return err('TIME_ORDER', '第 ' + (i + 1) + ' 条 ' + timeLabel(t, tf) + ' 早于上一条 ' + timeLabel(prev, tf));
      if (prev && t === prev) return err('DUP_TIME', '第 ' + (i + 1) + ' 条与上一条时间相同：' + timeLabel(t, tf));
      prev = t;
      bars.push([t, o, h, l, c, +v || 0]);
    }
    if (!bars.length) return err('EMPTY');
    if (bars.length > MAX_BARS) return err('TOO_BIG', '共 ' + bars.length + ' 根');
    const code = codeFromName(name);
    const item = {
      id: hashId(code + '|' + tf + '|' + bars[0][0] + '|' + bars[bars.length - 1][0] + '|' + bars.length),
      name: name, code: code, timeframe: tf, adjust: ext === 'day' ? 'none' : 'none',
      format: 'tdx-' + ext, tz: 'local', unit: 'unknown',
      barsCount: bars.length, first: bars[0][0], last: bars[bars.length - 1][0], bars: bars,
    };
    return { ok: true, item: item, warnings: ['通达信原始文件不含复权因子，按不复权原样使用；时间按交易所本地时间（UTC+8）解释。'] };
  }

  /* ================= CSV / TXT ================= */
  function splitLine(line, delim) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { q = !q; continue; }
      if (!q && ch === delim) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  function normHeader(s) {
    return String(s || '').trim().toLowerCase().replace(/^\uFEFF/, '').replace(/["']/g, '')
      .replace(/\s+/g, '').replace(/[（）()【】\[\]]/g, '');
  }

  function classifyHeader(s) {
    const h = normHeader(s);
    if (/^(日期时间|datetime|时间戳|timestamp|交易时间|date_time)$/.test(h)) return 'dt';
    if (/^(日期|交易日期|交易日|date|day)$/.test(h)) return 'date';
    if (/^(时间|时刻|time|clock)$/.test(h)) return 'clock';
    if (/^(开盘|开盘价|open|o)$/.test(h)) return 'open';
    if (/^(最高|最高价|high|h)$/.test(h)) return 'high';
    if (/^(最低|最低价|low|l)$/.test(h)) return 'low';
    if (/^(收盘|收盘价|close|c)$/.test(h)) return 'close';
    if (/^(成交量|成交手数|volume|vol|v)$/.test(h)) return 'volume';
    if (/^(成交额|成交金额|amount|turnover)$/.test(h)) return 'amount';
    if (/^(证券代码|股票代码|代码|code|symbol|ticker)$/.test(h)) return 'code';
    if (/^(复权|复权类型|adjust|fq)$/.test(h)) return 'adjust';
    return '';
  }

  function filenameAdjust(name) {
    const s = String(name || '').toLowerCase();
    if (/前复权|qfq/.test(s)) return 'qfq';
    if (/后复权|hfq/.test(s)) return 'hfq';
    if (/不复权|none|raw/.test(s)) return 'none';
    return '';
  }

  function metaOf(lines) {
    const m = {};
    lines.forEach(function (line) {
      const s = String(line || '');
      if (!m.code) {
        const cm = s.match(/(?:证券代码|股票代码|代码|symbol|code)\s*[:：]\s*([A-Za-z0-9]+)/i);
        if (cm) m.code = cm[1];
      }
      if (!m.adjust) {
        const am = s.match(/(?:复权(?:类型)?|adjust)\s*[:：]\s*([^,，;；\s]+)/i);
        if (am) {
          if (/前/.test(am[1]) || /qfq/i.test(am[1])) m.adjust = 'qfq';
          else if (/后/.test(am[1]) || /hfq/i.test(am[1])) m.adjust = 'hfq';
          else if (/不复权|none|raw/i.test(am[1])) m.adjust = 'none';
        }
      }
      if (!m.period) {
        const pm = s.match(/(?:周期|period)\s*[:：]\s*([^,，;；\s]+)/i);
        if (pm) {
          if (/日线|daily|day/i.test(pm[1])) m.period = 'day';
          else {
            const nm = pm[1].match(/(\d+)\s*分钟/);
            if (nm) m.period = nm[1] + 'm';
          }
        }
      }
      if (!m.unit) {
        const um = s.match(/(?:成交量|volume)[^:：]*[:：]\s*(手|股)/i);
        if (um) m.unit = um[1];
      }
    });
    return m;
  }

  function normalizeStamp(dateStr, clockStr) {
    const raw = (String(dateStr == null ? '' : dateStr) + ' ' + String(clockStr == null ? '' : clockStr)).trim();
    const tzm = raw.match(/(Z|[+-]\d{2}:?\d{2})\s*$/i);
    if (!tzm) return raw;
    const m = raw.match(/(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})(?:[ T]?(\d{1,2})[:.]?(\d{2})(?::?(\d{2}))?)?/);
    if (!m) return raw;
    const y = +m[1], mo = +m[2], d = +m[3], hh = +(m[4] || 0), mm = +(m[5] || 0), ss = +(m[6] || 0);
    let off = 0;
    if (/^z$/i.test(tzm[1])) off = 0;
    else {
      const om = tzm[1].match(/^([+-])(\d{2}):?(\d{2})$/);
      if (om) off = (om[1] === '-' ? -1 : 1) * (+om[2] * 60 + +om[3]);
    }
    const base = Date.UTC(y, mo - 1, d, hh, mm, ss) / 60000;
    const sh = base - off + TZ_OFFSET_MIN;
    const dt = new Date(sh * 60000);
    return String(dt.getUTCFullYear()) + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-'
      + String(dt.getUTCDate()).padStart(2, '0') + ' '
      + String(dt.getUTCHours()).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0');
  }

  function stampOf(dateStr, clockStr) {
    const s = normalizeStamp(dateStr, clockStr);
    // Excel 序列日期（1900 起算），常见于 xlsx 另存 CSV
    if (s && /^\d{5,6}(\.\d+)?$/.test(s.replace(/\s+/g, ''))) {
      const n = parseFloat(s);
      if (n > 20000 && n < 80000) {
        const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
        const mins = Math.round((n % 1) * 1440);
        const day = String(dt.getUTCFullYear()) + String(dt.getUTCMonth() + 1).padStart(2, '0')
          + String(dt.getUTCDate()).padStart(2, '0');
        if (!isDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())) return null;
        return { t: day + String(Math.floor(mins / 60)).padStart(2, '0') + String(mins % 60).padStart(2, '0'), day: day, hasTime: mins > 0, minute: mins };
      }
    }
    let y, mo, d, hh = 0, mm = 0, hasTime = false;
    const full = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]?(\d{1,2})[:.](\d{1,2})(?::?(\d{1,2}))?)?/);
    if (full) {
      y = +full[1]; mo = +full[2]; d = +full[3];
      if (full[4] != null) { hh = +full[4]; mm = +full[5]; hasTime = true; }
    } else {
      const ds = digits(s);
      if (ds.length < 8) return null;
      y = +ds.slice(0, 4); mo = +ds.slice(4, 6); d = +ds.slice(6, 8);
      if (ds.length >= 12) { hh = +ds.slice(8, 10); mm = +ds.slice(10, 12); hasTime = true; }
      else if (ds.length === 10) { hh = +ds.slice(8, 10); mm = 0; hasTime = true; }
      else if (ds.length === 9) { hh = +ds.slice(8, 9); mm = 0; hasTime = true; }
    }
    if (!isDate(y, mo, d)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    const day = String(y) + String(mo).padStart(2, '0') + String(d).padStart(2, '0');
    return {
      t: day + (hasTime ? String(hh).padStart(2, '0') + String(mm).padStart(2, '0') : '0000'),
      day: day, hasTime: hasTime, minute: hh * 60 + mm,
    };
  }

  function inferTimeframe(bars, hasTime, meta, warnings) {
    if (meta.period) return meta.period;
    if (!hasTime) return 'day';
    const times = bars.map(function (b) { return +b[0].slice(8, 12); });
    if (times.every(function (v) { return v === 0; })) return 'day';
    const byDay = {};
    bars.forEach(function (b) { const d = b[0].slice(0, 8); (byDay[d] || (byDay[d] = [])).push(+b[0].slice(8, 12)); });
    let diff = 0;
    Object.keys(byDay).forEach(function (d) {
      const arr = byDay[d].sort(function (a, b) { return a - b; });
      for (let i = 1; i < arr.length; i++) {
        const dd = (Math.floor(arr[i] / 100) * 60 + arr[i] % 100) - (Math.floor(arr[i - 1] / 100) * 60 + arr[i - 1] % 100);
        if (dd > 0 && (!diff || dd < diff)) diff = dd;
      }
    });
    if (diff === 1 || diff === 5 || diff === 15 || diff === 30 || diff === 60) return diff + 'm';
    if (diff > 0 && diff <= 60) return diff + 'm';
    warnings.push('无法从时间间隔判断周期，按“分钟线”处理。');
    return 'minute';
  }

  function parseText(name, text, opts) {
    if (!text || !text.trim()) return err('EMPTY');
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let headerIdx = -1, delim = ',', cols = [], map = {};
    for (let i = 0; i < Math.min(lines.length, 40); i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      const d = line.indexOf('\t') >= 0 ? '\t' : (line.indexOf(';') >= 0 && line.split(';').length > 3 ? ';' : ',');
      const arr = splitLine(line, d);
      const m = {};
      arr.forEach(function (cell, j) { const k = classifyHeader(cell); if (k && m[k] == null) m[k] = j; });
      const core = ['open', 'high', 'low', 'close'].filter(function (k) { return m[k] != null; }).length;
      if (core >= 4 && (m.date != null || m.dt != null)) {
        headerIdx = i; delim = d; cols = arr; map = m;
        break;
      }
    }
    const warnings = [];
    const meta = metaOf(headerIdx >= 0 ? lines.slice(0, headerIdx) : lines.slice(0, 10));
    let headerless = false;
    if (headerIdx < 0) {
      // 无表头兜底：首格是时间，且至少 6 列数字（时间/开/高/低/收/量[/额]）
      for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const arr = splitLine(lines[i], ',');
        if (arr.length >= 6 && stampOf(arr[0], '') && (+arr[1]) > 0 && (+arr[2]) > 0 && (+arr[3]) > 0 && (+arr[4]) > 0) {
          headerIdx = i - 1; delim = ','; cols = [];
          map = { dt: 0, open: 1, high: 2, low: 3, close: 4, volume: 5, amount: arr.length >= 7 ? 6 : null };
          headerless = true;
          warnings.push('没有表头，按“时间/开/高/低/收/量”顺序解析。建议导出时保留表头。');
          break;
        }
      }
    }
    if (headerIdx < 0 && !headerless) {
      if (/\x00/.test(text)) return err('FORMAT', '文件内容是二进制乱码，可能是改错扩展名的通达信文件');
      return err('MISSING_FIELD', '找不到表头行（需要“日期/时间、开盘、最高、最低、收盘”）。');
    }

    if (!headerless) {
      const missing = [];
      if (map.open == null) missing.push('开盘');
      if (map.high == null) missing.push('最高');
      if (map.low == null) missing.push('最低');
      if (map.close == null) missing.push('收盘');
      if (map.dt == null && map.date == null) missing.push('日期/时间');
      if (missing.length) return err('MISSING_FIELD', '缺少：' + missing.join('、') + '（第 ' + (headerIdx + 1) + ' 行表头）');
    }

    const bars = [];
    let prev = '';
    let hasTime = false;
    let tzConverted = 0;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      if (/^\s*(#|\/\/)/.test(line)) continue;
      const arr = splitLine(line, delim);
      if (headerless && !/\d/.test(arr[0])) continue;
      const need = Math.max(map.open, map.high, map.low, map.close, map.date != null ? map.date : -1, map.clock != null ? map.clock : -1, map.dt != null ? map.dt : -1);
      if (arr.length <= need) return err('MISSING_FIELD', '第 ' + (i + 1) + ' 行列数不够（' + arr.length + ' 列）');
      let dateStr = '';
      let clockStr = '';
      if (map.dt != null) dateStr = arr[map.dt];
      else if (map.date != null) { dateStr = arr[map.date]; clockStr = map.clock != null ? arr[map.clock] : ''; }
      if (map.dt != null && /(Z|[+-]\d{2}:?\d{2})\s*$/i.test(dateStr)) tzConverted++;
      const st = stampOf(dateStr, clockStr);
      if (!st) return err('MISSING_FIELD', '第 ' + (i + 1) + ' 行日期/时间无法识别：' + [dateStr, clockStr].filter(Boolean).join(' '));
      if (st.hasTime) hasTime = true;
      function num(k) { return map[k] == null ? NaN : parseFloat(arr[map[k]]); }
      const o = num('open'), h = num('high'), l = num('low'), c = num('close');
      const v = map.volume != null ? parseFloat(arr[map.volume]) : NaN;
      const a = map.amount != null ? parseFloat(arr[map.amount]) : NaN;
      const bad = [o, h, l, c].some(function (p) { return !isFinite(p) || p <= 0 || p > 100000; });
      if (bad) return err('BAD_PRICE', '第 ' + (i + 1) + ' 行价格 ' + [o, h, l, c].join('/') + ' 不是有效价格');
      if (h + 1e-6 < Math.max(o, c) || l - 1e-6 > Math.min(o, c)) {
        return err('OHLC', '第 ' + (i + 1) + ' 行 高/低 与 开/收 矛盾');
      }
      if (prev && st.t < prev) return err('TIME_ORDER', '第 ' + (i + 1) + ' 行 ' + st.t + ' 早于上一行 ' + prev);
      if (prev && st.t === prev) return err('DUP_TIME', '第 ' + (i + 1) + ' 行与上一行时间相同：' + st.t);
      prev = st.t;
      bars.push([st.t, o, h, l, c, isFinite(v) ? v : 0, isFinite(a) ? a : 0]);
    }
    if (!bars.length) return err('EMPTY');

    if (map.volume == null) warnings.push('没有成交量列，K 线只画价格。');
    const tf = inferTimeframe(bars, hasTime, meta, warnings);
    if (tzConverted) warnings.push('检测到 ' + tzConverted + ' 行带时区标记，已换算到 Asia/Shanghai（UTC+8）。');
    if (headerless) warnings.push('无表头文件无法确认复权口径，按原样使用。');
    const code = meta.code || codeFromName(name);
    const adjust = meta.adjust || filenameAdjust(name) || 'unknown';
    const item = {
      id: hashId(code + '|' + tf + '|' + bars[0][0] + '|' + bars[bars.length - 1][0] + '|' + bars.length),
      name: name, code: code, timeframe: tf, adjust: adjust,
      format: headerless ? 'csv-headerless' : 'csv', tz: tzConverted ? 'converted-utc' : 'local',
      unit: meta.unit || 'unknown',
      barsCount: bars.length, first: bars[0][0], last: bars[bars.length - 1][0], bars: bars,
    };
    if (bars.length > MAX_BARS) return err('TOO_BIG', '共 ' + bars.length + ' 根');
    return { ok: true, item: item, warnings: warnings };
  }

  /* ================= 统一入口 ================= */
  function parseFile(name, input, opts) {
    try {
      const o = opts || {};
      const ext = (String(name || '').match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
      if (ext === 'xls' || ext === 'xlsx') return err('NEED_CSV');
      const bytes = bytesOf(input);
      if (bytes && (ext === 'day' || ext === 'lc5' || ext === 'lc1')) {
        const r = parseTdxBinary(name, ext, bytes);
        if (r.ok && o.maxBars && r.item.barsCount > o.maxBars) return err('TOO_BIG');
        return r;
      }
      if (bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return err('NEED_CSV');
      let text = '';
      if (typeof input === 'string') text = input;
      else if (bytes) {
        const d = decodeText(bytes);
        text = d.text;
      }
      if (!text) return err('EMPTY');
      if (/\x00/.test(text.slice(0, 2000))) return err('FORMAT', '看起来是二进制文件；通达信原始文件请保留 .day/.lc5/.lc1 扩展名。');
      const r = parseText(name, text, o);
      if (r.ok && o.maxBars && r.item.barsCount > o.maxBars) return err('TOO_BIG');
      return r;
    } catch (e) {
      return err('FORMAT', (e && e.message) || String(e));
    }
  }

  /* ================= 本机存储 ================= */
  let injectedStore = null;
  function setStorage(s) { injectedStore = s || null; }
  function store() {
    if (injectedStore) return injectedStore;
    try { return root && root.localStorage ? root.localStorage : null; } catch (e) { return null; }
  }
  function readDB(st) {
    try {
      const raw = st.getItem(KEY);
      const db = raw ? JSON.parse(raw) : null;
      if (db && Array.isArray(db.items)) return db;
    } catch (e) { /* 损坏按空库 */ }
    return { v: 1, items: [] };
  }
  function listItems() {
    const st = store();
    if (!st) return [];
    return readDB(st).items.slice();
  }
  function saveItem(item) {
    const st = store();
    if (!st) return err('NO_STORAGE');
    if (!item || !Array.isArray(item.bars) || !item.bars.length) return err('EMPTY');
    if (item.bars.length > MAX_BARS) return err('TOO_BIG', '共 ' + item.bars.length + ' 根');
    let json = '';
    try { json = JSON.stringify(item); } catch (e) { return err('FORMAT', e.message); }
    if (json.length > MAX_JSON) return err('TOO_BIG', '序列化后 ' + Math.round(json.length / 1024) + ' KB');
    const db = readDB(st);
    db.items = [item].concat(db.items.filter(function (x) { return x.id !== item.id; })).slice(0, MAX_ITEMS);
    try { st.setItem(KEY, JSON.stringify(db)); } catch (e) { return err('QUOTA', (e && e.name) || 'setItem'); }
    return { ok: true, item: item };
  }
  function removeItem(id) {
    const st = store();
    if (!st) return err('NO_STORAGE');
    const db = readDB(st);
    db.items = db.items.filter(function (x) { return x.id !== id; });
    try { st.setItem(KEY, JSON.stringify(db)); } catch (e) { return err('QUOTA', e && e.name); }
    return { ok: true };
  }
  function findItem(id) {
    const items = listItems();
    for (let i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  /* ================= 像素映射 ================= */
  function chartModel(bars, width, height, opts) {
    const o = opts || {};
    const pad = {
      l: o.padL != null ? o.padL : 46, r: o.padR != null ? o.padR : 8,
      t: o.padT != null ? o.padT : 12, b: o.padB != null ? o.padB : 20,
    };
    const w = Math.max(80, +width || 358);
    const h = Math.max(60, +height || 240);
    const innerW = Math.max(20, w - pad.l - pad.r);
    const innerH = Math.max(20, h - pad.t - pad.b);
    const n = Math.max(1, bars ? bars.length : 0);
    let min = Infinity, max = -Infinity;
    (bars || []).forEach(function (b) {
      const l = +b[3], hi = +b[2];
      if (isFinite(l)) min = Math.min(min, l);
      if (isFinite(hi)) max = Math.max(max, hi);
    });
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (max === min) { max += 0.01; min -= 0.01; }
    const padP = (max - min) * 0.02;
    min -= padP; max += padP;
    const step = innerW / n;
    function xOfIndex(i) { return pad.l + step * (i + 0.5); }
    function yOfPrice(p) { return pad.t + (max - p) / (max - min) * innerH; }
    function xAtTime(ts) {
      if (!bars || !bars.length) return pad.l;
      const s = String(ts);
      if (s <= bars[0][0]) return xOfIndex(0);
      if (s >= bars[n - 1][0]) return xOfIndex(n - 1);
      let i = 0;
      while (i < n - 1 && bars[i + 1][0] <= s) i++;
      const span = +bars[i + 1][0] - +bars[i][0];
      const frac = span > 0 ? (+s - +bars[i][0]) / span : 0;
      return xOfIndex(i) + frac * (xOfIndex(i + 1) - xOfIndex(i));
    }
    function priceTicks(k) {
      const out = [];
      const cnt = k || 4;
      for (let i = 0; i < cnt; i++) {
        const p = max - (max - min) * (i / (cnt - 1));
        out.push({ p: p, y: yOfPrice(p) });
      }
      return out;
    }
    return {
      bars: bars || [], width: w, height: h, pad: pad, innerW: innerW, innerH: innerH,
      min: min, max: max, n: n, step: step,
      xOfIndex: xOfIndex, yOfPrice: yOfPrice, xAtTime: xAtTime, priceTicks: priceTicks,
    };
  }

  /* ================= 成交落点 ================= */
  function alignTrades(item, trades, model) {
    const pts = [], rejects = [];
    let mismatch = 0, missingTime = 0;
    const bars = (item && item.bars) || [];
    const code = normCode(item && item.code);
    const m = model || chartModel(bars, 358, 240);
    (trades || []).forEach(function (tr) {
      if (!tr || normCode(tr.code) !== code) return;
      const price = +tr.price;
      if (!isFinite(price) || price <= 0) return;
      const day = digits(tr.date).slice(0, 8);
      if (!day) { rejects.push({ trade: tr, code: 'OUT_OF_RANGE' }); return; }
      let idx = -1, ts = '';
      if (item.timeframe === 'day') {
        for (let i = 0; i < bars.length; i++) if (String(bars[i][0]).slice(0, 8) === day) { idx = i; break; }
      } else {
        const hm = digits(tr.time).padEnd(4, '0').slice(0, 4);
        if (hm === '0000') { missingTime++; rejects.push({ trade: tr, code: 'NO_TIME' }); return; }
        ts = day + hm;
        // 成交时刻属于“结束时刻 >= 该时刻”的第一根（09:41 → 09:45 这根）
        for (let i = 0; i < bars.length; i++) {
          const bt = String(bars[i][0]);
          if (bt.slice(0, 8) === day && bt >= ts && bt.slice(8, 12) <= '1500') { idx = i; break; }
        }
        if (idx < 0) {
          // 收盘后仍可挂到当天最后一根
          for (let i = bars.length - 1; i >= 0; i--) if (String(bars[i][0]).slice(0, 8) === day) { idx = i; break; }
        }
      }
      if (idx < 0) { rejects.push({ trade: tr, code: 'OUT_OF_RANGE' }); return; }
      const bar = bars[idx];
      const lo = +bar[3], hi = +bar[2];
      const inside = price >= lo * 0.95 && price <= hi * 1.05;
      if (!inside) mismatch++;
      const at = ts || (String(bar[0]).slice(0, 8) + (tr.time ? digits(tr.time).padEnd(4, '0').slice(0, 4) : '0000'));
      pts.push({
        trade: tr, barIndex: idx, barTime: String(bar[0]), at: at,
        price: price, x: item.timeframe === 'day' ? m.xOfIndex(idx) : m.xAtTime(at),
        y: m.yOfPrice(price), inside: inside,
        kind: /卖/.test(String(tr.side || '')) ? 'sell' : 'buy',
        qty: +(tr.qty || 0), name: tr.name || '',
      });
    });
    let warning = null;
    if (mismatch) warning = { code: 'ADJUST', message: ERRORS.ADJUST, count: mismatch };
    else if (missingTime) warning = { code: 'NO_TIME', message: ERRORS.NO_TIME, count: missingTime };
    return { points: pts, rejects: rejects, warning: warning };
  }

  function colorOf(up) { return up ? '#ff5c7a' : '#3ddc97'; }

  function draw(canvas, item, trades, opts) {
    if (!canvas || !item || !item.bars) return null;
    const o = opts || {};
    const cssW = (canvas.clientWidth || o.width || 358);
    const cssH = (canvas.clientHeight || o.height || 240);
    const dpr = (root && root.devicePixelRatio) || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const m = chartModel(item.bars, cssW, cssH, o);
    ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    // 网格 + 价格轴
    const ticks = m.priceTicks(4);
    ticks.forEach(function (tk) {
      ctx.strokeStyle = 'rgba(120,140,180,0.16)';
      ctx.beginPath(); ctx.moveTo(m.pad.l, tk.y); ctx.lineTo(cssW - m.pad.r, tk.y); ctx.stroke();
      ctx.fillStyle = '#6f7a92';
      ctx.fillText(fmtPrice(tk.p), 4, tk.y + 3);
    });
    // K 线
    const bw = Math.max(1, Math.min(9, m.step * 0.62));
    item.bars.forEach(function (b, i) {
      const x = m.xOfIndex(i);
      const up = +b[4] >= +b[1];
      const c = colorOf(up);
      ctx.strokeStyle = c; ctx.fillStyle = c;
      ctx.beginPath(); ctx.moveTo(x, m.yOfPrice(+b[2])); ctx.lineTo(x, m.yOfPrice(+b[3])); ctx.stroke();
      const y1 = m.yOfPrice(+b[1]), y2 = m.yOfPrice(+b[4]);
      const top = Math.min(y1, y2), hgt = Math.max(1, Math.abs(y2 - y1));
      ctx.fillRect(x - bw / 2, top, bw, hgt);
    });
    // 时间轴
    ctx.fillStyle = '#6f7a92';
    if (item.bars.length) {
      ctx.fillText(timeLabel(item.bars[0][0], item.timeframe).slice(5), m.pad.l, cssH - 5);
      const lastTxt = timeLabel(item.bars[item.bars.length - 1][0], item.timeframe).slice(5);
      const tw = ctx.measureText(lastTxt).width;
      ctx.fillText(lastTxt, cssW - m.pad.r - tw, cssH - 5);
    }
    // 成交点：x 用成交时刻插值，y 用真实成交价
    const al = alignTrades(item, trades, m);
    al.points.forEach(function (p) {
      const c = p.kind === 'sell' ? '#3ddc97' : '#ff5c7a';
      ctx.strokeStyle = 'rgba(232,236,246,0.5)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, m.pad.t + m.innerH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(7,11,22,0.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#e8ecf6';
      ctx.fillText((p.kind === 'sell' ? '卖 ' : '买 ') + fmtPrice(p.price), Math.min(cssW - 52, p.x + 5), p.y - 5);
    });
    return { model: m, align: al };
  }

  /* ================= 页面挂载 ================= */
  function readLedger() {
    try {
      const raw = root.localStorage && root.localStorage.getItem('guanzhu_ledger');
      const led = raw ? JSON.parse(raw) : null;
      return (led && led.trades) || [];
    } catch (e) { return []; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function barSpan(item) {
    const a = timeLabel(item.first, item.timeframe);
    const b = timeLabel(item.last, item.timeframe);
    return a === b ? a : a + ' ~ ' + b;
  }

  function mount(el, opts) {
    const o = opts || {};
    let activeId = '';
    el.innerHTML = ''
      + '<label class="ki-drop" for="ki-file">选择文件（.day / .lc5 / .lc1 / .csv / .txt）'
      + '<input type="file" id="ki-file" accept=".day,.lc5,.lc1,.csv,.txt"></label>'
      + '<p class="ki-msg" id="ki-msg" aria-live="polite"></p>'
      + '<div class="ki-list" id="ki-list"></div>'
      + '<div class="ki-view" id="ki-view"></div>';
    const file = el.querySelector('#ki-file');
    const msg = el.querySelector('#ki-msg');
    const listBox = el.querySelector('#ki-list');
    const viewBox = el.querySelector('#ki-view');

    function say(text, kind, code) {
      msg.textContent = text;
      msg.className = 'ki-msg' + (kind ? ' ' + kind : '');
      if (code) msg.setAttribute('data-code', code);
      else msg.removeAttribute('data-code');
    }

    function renderList() {
      const items = listItems();
      if (!items.length) { listBox.innerHTML = '<p class="ki-empty">还没有导入文件。数据只保存在本机浏览器。</p>'; return; }
      listBox.innerHTML = items.map(function (it) {
        return '<div class="ki-item' + (it.id === activeId ? ' on' : '') + '" data-id="' + esc(it.id) + '">'
          + '<button type="button" class="ki-pick" data-pick="' + esc(it.id) + '">'
          + '<b>' + esc(it.code) + '</b> ' + esc(tfLabel(it.timeframe)) + ' · ' + it.barsCount + ' 根'
          + '<span>' + esc(barSpan(it)) + ' · ' + esc(adjustLabel(it.adjust)) + '</span></button>'
          + '<button type="button" class="ki-del" data-del="' + esc(it.id) + '" aria-label="删除">×</button>'
          + '</div>';
      }).join('');
      listBox.querySelectorAll('[data-pick]').forEach(function (b) {
        b.addEventListener('click', function () { activeId = b.getAttribute('data-pick'); renderList(); renderView(); });
      });
      listBox.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          removeItem(b.getAttribute('data-del'));
          if (activeId === b.getAttribute('data-del')) activeId = '';
          renderList(); renderView();
        });
      });
    }

    function renderView() {
      const item = activeId ? findItem(activeId) : (listItems()[0] || null);
      if (!item) { viewBox.innerHTML = ''; return; }
      activeId = item.id;
      viewBox.innerHTML = '<canvas id="ki-canvas" class="ki-canvas" aria-label="用你导入的数据绘制的 K 线"></canvas>'
        + '<p class="ki-meta">' + esc(item.code) + ' · ' + esc(tfLabel(item.timeframe)) + ' · ' + item.barsCount
        + ' 根 · ' + esc(barSpan(item)) + ' · ' + esc(adjustLabel(item.adjust)) + ' · 仅本机</p>'
        + '<div id="ki-align" class="ki-align"></div>';
      const canvas = viewBox.querySelector('#ki-canvas');
      const trades = readLedger().filter(function (t) { return normCode(t.code) === normCode(item.code); });
      const out = draw(canvas, item, trades, { width: (canvas.clientWidth || o.width || 334), height: 240 });
      const box = viewBox.querySelector('#ki-align');
      let html = '';
      if (!trades.length) {
        html += '<p class="ki-note">账本里没有 ' + esc(item.code) + ' 的成交。价格轴已用你的数据画好；导入交割单后会自动落点。</p>';
      } else if (!out || !out.align.points.length) {
        html += '<p class="ki-note">这只票有成交，但没有一笔落在导入数据的日期范围内。</p>';
      } else {
        html += '<p class="ki-note">成交点 → 像素（按本机图表尺寸复算，可逐条核对）：</p>';
        out.align.points.slice(0, 8).forEach(function (p) {
          html += '<p class="ki-row">' + esc(timeLabel(p.at, item.timeframe)) + ' · '
            + (p.kind === 'sell' ? '卖' : '买') + ' ' + p.qty + ' @ ' + fmtPrice(p.price)
            + ' · K 线 ' + esc(timeLabel(p.barTime, item.timeframe)) + ' · x=' + p.x.toFixed(1)
            + ' · y=' + p.y.toFixed(1) + (p.inside ? '' : ' · 价格在区间外') + '</p>';
        });
      }
      const rejects = out && out.align ? out.align.rejects : [];
      if (rejects.length) {
        const r = rejects[0];
        html += '<p class="ki-bad">' + esc(ERRORS[r.code] || '这笔成交无法落点') + '</p>';
      }
      if (out && out.align && out.align.warning) {
        html += '<p class="ki-bad">' + esc(out.align.warning.message) + '</p>';
      }
      box.innerHTML = html;
      root.__klineImport = { item: item, model: out ? out.model : null, align: out ? out.align : null };
    }

    function handleFile(f) {
      if (!f) return;
      say('正在解析 ' + f.name + '…', '', '');
      const reader = new FileReader();
      reader.onload = function () {
        const res = parseFile(f.name, new Uint8Array(reader.result));
        if (!res.ok) { say('导入失败：' + res.message, 'bad', res.code); return; }
        const saved = saveItem(res.item);
        if (!saved.ok) { say('导入失败：' + saved.message, 'bad', saved.code); return; }
        activeId = res.item.id;
        const warn = (res.warnings || []).length ? ' ' + res.warnings.join(' ') : '';
        say('已导入 ' + res.item.code + ' · ' + tfLabel(res.item.timeframe) + ' · ' + res.item.barsCount
          + ' 根 · ' + barSpan(res.item) + ' · ' + adjustLabel(res.item.adjust) + '。仅保存在本机。' + warn,
          'good', 'OK');
        renderList(); renderView();
      };
      reader.onerror = function () { say('读取文件失败，请重试。', 'bad', 'FORMAT'); };
      reader.readAsArrayBuffer(f);
    }

    file.addEventListener('change', function () { handleFile(file.files && file.files[0]); });
    renderList();
    renderView();
    return { refresh: function () { renderList(); renderView(); }, select: function (id) { activeId = id; renderList(); renderView(); } };
  }

  return {
    KEY, MAX_BARS, MAX_ITEMS, ERRORS,
    parseFile, parseTdxBinary, parseText,
    listItems, saveItem, removeItem, findItem, setStorage, store,
    chartModel, alignTrades, draw, mount,
    normCode, codeFromName, timeLabel, tfLabel, adjustLabel, barSpan,
    _internal: { parseText, stampOf, normalizeStamp, decodeText, inferTimeframe, metaOf, classifyHeader, splitLine, hashId, ERRORS },
  };
});
