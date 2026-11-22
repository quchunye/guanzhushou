// card_svg.js —— 获客链路第一段：复盘卡 / 图鉴卡的 SVG 图面生成
//
// 边界：
//   - 只生成字符串，不写 DOM、不发网络、不读 localStorage。
//   - 不生成二维码、不写 URL；图面只放产品名与一句钩子。
//   - 尺寸与现有 50 条海报同一套格式：viewBox 0 0 640 360，正文都落在这套坐标里。
//   - 配色只用 docs/设计规范_v2_20261105.md 的 B 版 token（与 clips/poster/*.svg 一致）。
//
// 挂 window.PanjiCardSvg；Node 走 module.exports（UMD，同 share.js）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PanjiCardSvg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const W = 640, H = 360;
  const T = {
    bg: '#04070e',
    panel: '#0a111b',
    line: '#1d2b3d',
    ink: '#eaf4ff',
    sub: '#8ea6bf',
    frost: '#8fd8ff',
    gold: '#e8d39a',
  };
  const FONT = "-apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
  const BRAND = '管住手了吗复盘';
  const SIGN = '管住手了吗复盘 · 玄霜纪 出品';
  const HOOK_REVIEW = '把每一笔，讲成一句人话';
  const HOOK_COLLECTION = '我点亮了 %N% 条复盘行为';

  // ---------- 小工具 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // 宽度单位：CJK/全角记 1，ASCII 记 0.5。用于保守截断，不追求精确排版。
  function units(s) {
    let n = 0;
    for (const ch of String(s)) n += (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.5);
    return n;
  }
  function fit(s, maxUnits) {
    let t = String(s == null ? '' : s).trim();
    if (!t) return '';
    if (units(t) <= maxUnits) return t;
    let out = '';
    while (t.length && units(out + t[0]) <= maxUnits - 1) { out += t[0]; t = t.slice(1); }
    return out + '…';
  }
  function color(c) {
    return Object.values(T).indexOf(String(c)) >= 0 ? String(c) : T.frost;
  }
  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function text(x, y, size, fill, content, opts) {
    const o = opts || {};
    const anchor = o.anchor || 'start';
    const weight = o.weight || 400;
    const ls = o.ls ? ' letter-spacing="' + o.ls + '"' : '';
    const mono = o.tabular ? ' style="font-variant-numeric:tabular-nums"' : '';
    return '<text x="' + x + '" y="' + y + '" font-family="' + FONT +
      '" font-size="' + size + '" font-weight="' + weight +
      '" fill="' + fill + '" text-anchor="' + anchor + '"' + ls + mono + '>' +
      esc(content) + '</text>';
  }

  // 海报统一的底：底色 + 玻璃卡 + 上下 58px 压条
  function base() {
    return [
      '<rect width="' + W + '" height="' + H + '" fill="' + T.bg + '"/>',
      '<rect x="24" y="62" width="592" height="236" rx="10" fill="' + T.panel +
        '" stroke="' + T.line + '" stroke-width="1"/>',
      '<rect x="0" y="0" width="' + W + '" height="58" fill="' + T.bg + '" opacity=".82"/>',
      '<rect x="0" y="302" width="' + W + '" height="58" fill="' + T.bg + '" opacity=".82"/>',
    ].join('');
  }

  function head(right) {
    return text(24, 34, 24, T.ink, BRAND, { weight: 800 }) +
      text(616, 34, 13, T.sub, right, { anchor: 'end' });
  }

  function foot(hook) {
    return text(24, 340, 15, T.frost, fit(hook, 22)) +
      text(616, 340, 13, T.sub, SIGN, { anchor: 'end' });
  }

  function demoTag(on) {
    if (!on) return '';
    const w = 64;
    return '<rect x="40" y="76" width="' + w + '" height="22" rx="4" fill="none" stroke="' + T.gold + '" stroke-width="1" opacity=".7"/>' +
      text(40 + w / 2, 92, 11, T.gold, '示例数据', { anchor: 'middle' });
  }

  // ---------- 复盘卡 ----------
  // payload: { caseNo, stats:[{label,val,col}], isDemo, hook }
  function review(payload) {
    try {
      const p = payload || {};
      const caseNo = fit(p.caseNo || 'No.000', 14);
      const caseSize = units(caseNo) <= 10 ? 42 : 36;
      const raw = Array.isArray(p.stats) ? p.stats : [];
      const stats = raw.slice(0, 3).map(function (s) {
        return {
          label: fit(s && s.label, 4),
          val: fit(s && s.val, 7),
          col: color(s && s.col),
        };
      });
      const n = stats.length;
      const xs = n === 3 ? [137, 320, 503] : n === 2 ? [213, 427] : n === 1 ? [320] : [];
      const sep = n === 3
        ? '<line x1="232" y1="172" x2="232" y2="264" stroke="' + T.line + '"/>' +
          '<line x1="408" y1="172" x2="408" y2="264" stroke="' + T.line + '"/>'
        : '';

      const parts = [
        base(),
        // 一道很轻的弧，延续海报的线条语言，不承担信息
        '<path d="M64,158 C200,150 440,150 576,158" fill="none" stroke="' + T.frost + '" stroke-width="1" opacity=".35"/>',
        demoTag(p.isDemo),
        text(320, 120, caseSize, T.frost, caseNo, { anchor: 'middle', weight: 800, ls: '.02em' }),
        text(320, 146, 12, T.sub, '本人确认的交易记录 · 不含成交明细', { anchor: 'middle' }),
        sep,
      ];
      stats.forEach(function (s, i) {
        parts.push(text(xs[i], 190, 12, T.sub, s.label, { anchor: 'middle' }));
        const size = units(s.val) <= 5 ? 46 : units(s.val) <= 7 ? 38 : 32;
        parts.push(text(xs[i], 254, size, s.col, s.val, { anchor: 'middle', weight: 800, tabular: true }));
      });
      parts.push(head('复盘卡'));
      parts.push(foot(p.hook || HOOK_REVIEW));
      return wrap(parts.join(''));
    } catch (e) {
      return fallback('复盘卡');
    }
  }

  // ---------- 图鉴卡 ----------
  // payload: { lit, total, todayPlus, isDemo, hook }
  function collection(payload) {
    try {
      const p = payload || {};
      const total = clamp(num(p.total, 25), 1, 25);
      const lit = clamp(num(p.lit, 0), 0, total);
      const plus = clamp(num(p.todayPlus, 0), 0, 25);
      const litStr = (lit < 10 ? '0' : '') + lit;
      const totalStr = String(total);

      // 5×5 点阵：格 26、间距 10；起点 x=366 / y=112
      const cells = [];
      for (let i = 0; i < 25; i++) {
        if (i >= total) break;
        const r = Math.floor(i / 5), c = i % 5;
        const x = 366 + c * 36, y = 112 + r * 36;
        if (i < lit) {
          cells.push('<rect x="' + x + '" y="' + y + '" width="26" height="26" rx="2" fill="' + T.frost + '" opacity=".92"/>');
        } else {
          cells.push('<rect x="' + x + '" y="' + y + '" width="26" height="26" rx="2" fill="none" stroke="' + T.line + '" stroke-width="1"/>');
        }
      }

      const hook = String(p.hook || HOOK_COLLECTION).replace('%N%', String(lit));
      const parts = [
        base(),
        demoTag(p.isDemo),
        text(72, 142, 12, T.sub, '已点亮'),
        text(72, 216, 64, T.frost, litStr, { weight: 800, tabular: true }),
        text(158, 216, 24, T.sub, '/ ' + totalStr, { weight: 600, tabular: true }),
        text(72, 254, 13, T.gold, plus > 0 ? '今日 +' + plus : '今日 +0'),
        '<line x1="72" y1="272" x2="318" y2="272" stroke="' + T.line + '"/>',
        cells.join(''),
        head('图鉴卡'),
        foot(hook),
      ];
      return wrap(parts.join(''));
    } catch (e) {
      return fallback('图鉴卡');
    }
  }

  function wrap(body) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H +
      '" width="' + W + '" height="' + H + '">' + body + '</svg>';
  }

  // 生成失败时的兜底：仍然是一张合法 SVG，不吐异常、不吐半截
  function fallback(label) {
    return wrap(base() + head(label) + foot('把每一笔，讲成一句人话'));
  }

  return {
    review: review,
    collection: collection,
    render: function (type, payload) {
      return type === 'collection' ? collection(payload) : review(payload);
    },
    TOKENS: Object.assign({}, T),
    W: W,
    H: H,
  };
});
