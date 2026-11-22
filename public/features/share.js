// share.js —— ST-2 阶段 2：分享页的两个命名空间（契约 docs/整合框架_20261104.md §2.5 / §3 / §4）
//
// PanjiClip   ：只读 public/media/clips/clips_index.json（不扫目录），resolve(termOrId) -> clip | null
// PanjiShare  ：build(payload) -> { html, url, fallbackUsed, reason }，纯函数（不写 DOM、不发网络、不读 localStorage）
//
// 三个接口永不抛异常：内部 try/catch 收口，失败一律 null（build 例外，返回纯卡片兜底对象）。
// 浏览器挂 window.PanjiShare / window.PanjiClip；Node 测试走 module.exports（UMD，同 store.js）。
//
// 关于 build 的附加字段 reason：只放 D1–D6 代号，供分享页埋一次 share_fallback，不含任何交易内容。
// build 的 html 只用 URL 载荷里的摘要，绝不拼明细；载荷（hash）里也不放 src / 二进制 / trades。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PanjiShare = api.PanjiShare;
    root.PanjiClip = api.PanjiClip;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SCHEMA = 'panji.share.v1';
  const INDEX_SCHEMA = 'panji.clips_index.v1';
  const MAX_PAYLOAD = 900;                 // 契约 §2.5：hash 载荷上限 900 字符
  const DEFAULT_THUMB = 'media/clips/';    // 契约 §2.2：src/poster 必须以 media/clips/ 开头
  const FORMATS = { webm: 'video/webm', mp4: 'video/mp4', gif: 'image/gif', html: 'text/html' };
  const DEFAULT_DISCLAIMER = '基于本人确认的交易记录生成 · 不构成任何投资建议';

  function warn(msg) {
    try { if (root && root.console && root.console.warn) root.console.warn('[panji] ' + msg); } catch (e) { /* 忽略 */ }
  }

  // ---------- 埋点：每次降级只记一次 share_fallback，只带 template / reason / fallbackUsed ----------
  // 分享页没有 localStorage（对方设备无账本），vid 用内存随机串；Node 环境下不发网络。
  let shareVid = '';
  function track(event, props) {
    try {
      if (!root || typeof root.location === 'undefined') return;      // 非浏览器：单测里不发请求
      if (typeof root.fetch !== 'function') return;
      if (!shareVid) shareVid = 's' + Math.random().toString(36).slice(2, 12);
      const body = { event: event, src: 'share', vid: shareVid };
      if (props && typeof props === 'object') body.props = props;
      root.fetch('/api/track', {
        method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(function () {});
    } catch (e) { /* 埋点失败绝不影响渲染 */ }
  }
  function reportFallback(reason, template) {
    track('share_fallback', { template: template || 'card', reason: reason || 'D6', fallbackUsed: true });
  }

  // ---------- base64url（浏览器 btoa / Node Buffer 双实现，中文安全） ----------
  function utf8ToB64(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64ToUtf8(b64) {
    if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
    return decodeURIComponent(escape(atob(b64)));
  }
  function toUrlSafe(b64) { return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function fromUrlSafe(s) {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return t;
  }

  // ---------- 小工具 ----------
  function str(v, max) {
    const s = v == null ? '' : String(v);
    return max && s.length > max ? s.slice(0, max) : s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function safeColor(c) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? String(c) : '#6ee7ff';
  }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // ============================================================
  // PanjiClip（契约 §2.1 / §2.2 / §4）
  // ============================================================
  let manifest = null;          // 已加载并通过校验的 manifest；null = 未加载/加载失败
  const INDEX_URL = 'media/clips/clips_index.json';

  function normClip(c) {
    if (!isObj(c)) return null;
    const id = str(c.id);
    if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(id)) return null;
    const title = str(c.title, 24);
    if (!title) return null;
    const durationMs = Number(c.durationMs);
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30000) return null;
    const format = str(c.format);
    if (!format) return null;                    // 格式合法性交给 PanjiShare.build 判 D4
    const src = str(c.src);
    if (src.indexOf(DEFAULT_THUMB) !== 0) return null;
    const poster = str(c.poster);
    if (poster.indexOf(DEFAULT_THUMB) !== 0) return null;
    const terms = Array.isArray(c.terms) ? c.terms.map(function (t) { return str(t); }).filter(Boolean).slice(0, 8) : [];
    if (!terms.length) return null;
    const tags = Array.isArray(c.tags) ? c.tags.map(function (t) { return str(t).toLowerCase(); }).filter(Boolean).slice(0, 6) : [];
    return {
      id: id, title: title, durationMs: durationMs, format: format, src: src, poster: poster,
      tags: tags, terms: terms, license: str(c.license) || 'own', source: isObj(c.source) ? c.source : null,
    };
  }

  // load(source, opts)  —— 异步加载 manifest（页面唯一入口）
  //   source：URL 字符串（浏览器）或 manifest 对象（测试注入）；source=null 清空缓存
  //   opts.exists：可选同步探针 (相对站点根的 src) => boolean；为真时剔除指向不存在文件的记录
  //   浏览器默认自带探测（HEAD src/poster），不存在 → 视同查不到（D2/D3 前置）
  //   失败返回 null，不抛异常；不改写任何磁盘文件
  function headExists(rel) {
    try {
      if (!root || typeof root.location === 'undefined') return Promise.resolve(true);  // Node 单测：不探
      if (typeof root.fetch !== 'function') return Promise.resolve(true);
      return root.fetch(String(rel), { method: 'HEAD', cache: 'no-store' })
        .then(function (r) { return !!(r && r.ok); })
        .catch(function () { return false; });
    } catch (e) { return Promise.resolve(true); }
  }

  function load(source, opts) {
    return new Promise(function (resolve) {
      try {
        if (source === null || source === undefined) { manifest = null; return resolve(null); }
        const probe = opts && typeof opts.exists === 'function' ? opts.exists : null;
        const asyncProbe = !!(root && typeof root.location !== 'undefined' && typeof root.fetch === 'function');

        function pack(list, obj) {
          manifest = { schema: INDEX_SCHEMA, version: obj && obj.version, updatedAt: obj && obj.updatedAt, clips: list };
          return manifest;
        }

        function ingest(obj) {
          if (!isObj(obj) || obj.schema !== INDEX_SCHEMA || !Array.isArray(obj.clips)) { manifest = null; return null; }
          const clips = [];
          obj.clips.forEach(function (c) {
            const n = normClip(c);
            if (!n) return;                                  // 任一字段不合法 → 整条丢弃（契约通用约定）
            clips.push(n);
          });
          if (probe) {
            const kept = clips.filter(function (n) {
              let ok = true;
              try { ok = !!probe(n.src) && !!probe(n.poster); } catch (e) { ok = false; }
              return ok;                                    // D3 前置：登记了但文件不存在 → 视同查不到
            });
            return pack(kept, obj);
          }
          if (!asyncProbe) return pack(clips, obj);
          return Promise.all(clips.map(function (n) {
            return Promise.all([headExists(n.src), headExists(n.poster)]).then(function (r) {
              return (r[0] && r[1]) ? n : null;             // D3 前置（浏览器：真探一次）
            });
          })).then(function (rs) { return pack(rs.filter(Boolean), obj); });
        }

        if (typeof source === 'object') return resolve(ingest(source));
        const requester = (root && root.fetch) || (typeof fetch === 'function' ? fetch : null);
        if (!requester) { manifest = null; return resolve(null); }
        requester(String(source), { cache: 'no-store' })
          .then(function (res) { return res && res.ok ? res.json() : null; })
          .then(function (obj) { resolve(ingest(obj)); })
          .catch(function () { manifest = null; resolve(null); });
      } catch (e) {
        warn('clips index load failed');
        manifest = null;
        resolve(null);
      }
    });
  }

  // 能力判定（契约 §2.1 末：同 id 可登记多条，读取方按能力择一）
  //   html/gif 由 <iframe>/<img> 承担，不受视频解码能力限制；webm/mp4 看 canPlayType
  function canPlay(format) {
    try {
      if (format === 'html' || format === 'gif') return true;
      const type = FORMATS[format];
      if (!type) return false;
      const doc = root && root.document;
      if (!doc || typeof doc.createElement !== 'function') return true;   // Node 单测无 DOM：不在此层拦截
      const v = doc.createElement('video');
      if (!v || typeof v.canPlayType !== 'function') return true;
      const r = String(v.canPlayType(type) || '');
      return r === 'maybe' || r === 'probably';
    } catch (e) { return false; }
  }

  // resolve(termOrId) —— 匹配顺序：id 精确 → terms 精确 → tags 包含；同层取 manifest 顺序第一条
  //   同 id 多条（webm 主 + mp4 兜底）→ 先挑能播的；都不可播 → 返回第一条，交给 build 判 D4
  function resolve(termOrId) {
    try {
      const q = str(termOrId).trim();
      if (!q || !manifest || !manifest.clips.length) return null;
      const list = manifest.clips;
      const pick = function (pred) {
        const hits = list.filter(pred);
        if (!hits.length) return null;
        const playable = hits.find(function (c) { return canPlay(c.format); });
        return playable || hits[0];
      };
      let hit = pick(function (c) { return c.id === q; });
      if (!hit) hit = pick(function (c) { return c.terms.indexOf(q) >= 0; });
      if (!hit) hit = pick(function (c) { return c.tags.indexOf(q.toLowerCase()) >= 0; });
      return hit ? Object.assign({}, hit) : null;
    } catch (e) {
      warn('clip resolve failed');
      return null;
    }
  }

  // ============================================================
  // PanjiShare（契约 §2.5）
  // ============================================================
  const HOME_URL = 'index.html';
  const SHARE_PAGE = 'share.html';

  function normalize(p) {
    if (!isObj(p)) return null;
    if (p.schema !== SCHEMA) return null;
    if (p.template !== 'card' && p.template !== 'clip-card' && p.template !== 'replay-card') return null;
    if (!isObj(p.cardPayload)) return null;
    const cp = p.cardPayload;
    const caseNo = str(cp.caseNo, 20);
    if (!caseNo) return null;                               // 无 caseNo → 不渲染数字（D6）
    const stats = (Array.isArray(cp.stats) ? cp.stats : []).filter(isObj).slice(0, 3).map(function (s) {
      return { label: str(s.label, 12), val: str(s.val, 12), col: safeColor(s.col) };
    }).filter(function (s) { return s.label && s.val; });
    return {
      schema: SCHEMA,
      template: p.template,
      title: str(p.title, 40) || '纪律记分卡',
      cardPayload: {
        caseNo: caseNo,
        stats: stats,
        oneLiner: str(cp.oneLiner, 40),
        isDemo: !!cp.isDemo,
        disclaimer: str(cp.disclaimer, 60) || DEFAULT_DISCLAIMER,
      },
      clipRef: isObj(p.clipRef) && str(p.clipRef.id) ? { id: str(p.clipRef.id, 48) } : null,
      replayRef: isObj(p.replayRef) ? {
        symbol: str(p.replayRef.symbol, 16), date: str(p.replayRef.date, 8), timeframe: str(p.replayRef.timeframe, 4),
      } : null,
    };
  }

  function compact(p) {
    const o = { v: p.schema, t: p.template, c: p.cardPayload };
    if (p.clipRef) o.cl = p.clipRef;
    if (p.replayRef) o.rp = p.replayRef;
    return o;
  }

  function encodePayload(p) {
    return toUrlSafe(utf8ToB64(JSON.stringify(compact(p))));
  }

  // 超限截断（契约：截断而不是失败）：逐级减内容，最后一级仍超限则退成最小卡片
  function fitWithin(p) {
    let c = {
      v: p.schema, t: p.template, c: Object.assign({}, p.cardPayload),
      cl: p.clipRef ? Object.assign({}, p.clipRef) : null,
      rp: p.replayRef ? Object.assign({}, p.replayRef) : null,
    };
    if (!c.cl) delete c.cl;
    if (!c.rp) delete c.rp;
    let enc = toUrlSafe(utf8ToB64(JSON.stringify(c)));
    if (enc.length <= MAX_PAYLOAD) return { enc: enc, droppedClip: false, truncated: false };

    const steps = [
      function () { c.c.oneLiner = str(c.c.oneLiner, 10); },
      function () { c.c.stats = (c.c.stats || []).slice(0, 1); },
      function () { c.c.stats = []; },
      function () { c.c.oneLiner = ''; c.c.disclaimer = '不构成任何投资建议'; },
      function () { delete c.cl; delete c.rp; c.t = 'card'; },
      function () {
        c.c = { caseNo: str(c.c.caseNo, 20), stats: [], oneLiner: '', isDemo: !!c.c.isDemo, disclaimer: '' };
      },
    ];
    let droppedClip = false;
    for (let i = 0; i < steps.length; i++) {
      try { steps[i](); } catch (e) { /* 继续下一级 */ }
      if (c.t === 'card' && !c.cl) droppedClip = true;
      enc = toUrlSafe(utf8ToB64(JSON.stringify(c)));
      if (enc.length <= MAX_PAYLOAD) break;
    }
    return { enc: enc, droppedClip: droppedClip, truncated: true };
  }

  // decode(hashOrUrl) —— 分享页专用：hash 解析失败返回 null（不抛异常）
  function decode(hashOrUrl) {
    try {
      let s = str(hashOrUrl).trim();
      if (!s) return null;
      const hashAt = s.indexOf('#');
      if (hashAt >= 0) s = s.slice(hashAt + 1);
      if (!s) return null;
      if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
      const o = JSON.parse(b64ToUtf8(fromUrlSafe(s)));
      if (!isObj(o)) return null;
      return {
        schema: o.v, template: o.t, cardPayload: o.c,
        clipRef: o.cl || null, replayRef: o.rp || null,
      };
    } catch (e) {
      warn('share decode failed');
      return null;
    }
  }

  function neutralHtml() {
    return '<section class="card neutral" id="share-card">' +
      '<div class="kicker">纪 律 记 分 卡</div>' +
      '<h1 class="case">这份分享不完整</h1>' +
      '<p class="sub">链接可能被截断或已过期</p>' +
      '<div class="brandline">在「管住手了吗复盘」生成</div>' +
      '<a class="go" href="index.html">回首页，用自己的交割单生成 →</a>' +
      '<div class="disclaimer">不构成任何投资建议</div>' +
      '</section>';
  }

  function clipHtml(clip) {
    const src = esc(clip.src);
    const poster = esc(clip.poster);
    const type = FORMATS[clip.format];
    if (clip.format === 'html') {
      // 契约 Amendment A1：自包含 HTML，仅 allow-scripts，禁 top-navigation / same-origin
      // poster 作为容器背景：iframe 被拦或撤掉时仍留静帧（硬约束 4）
      return '<div class="clip clip-holder" id="share-clip" style="background-image:url(' + poster + ')">' +
        '<iframe class="clip-frame" src="' + src + '" title="' + esc(clip.title) +
        '" loading="lazy" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></div>';
    }
    if (clip.format === 'gif') {
      return '<div class="clip" id="share-clip"><img src="' + src + '" alt=""></div>';
    }
    return '<div class="clip" id="share-clip"><video muted autoplay playsinline loop preload="auto" poster="' +
      poster + '"><source src="' + src + '" type="' + type + '"></video></div>';
  }

  // attachClip(rootEl, opts) —— 挂载与超时（D3 挂载失败 / D5 3 秒未就绪），只回调、不抛异常
  //   opts: { timeoutMs=3000, onReady(), onFailed(reasonCode) }；返回 cancel()
  function attachClip(rootEl, opts) {
    const o = opts || {};
    const timeoutMs = Number.isInteger(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 3000;
    let el = null;
    try {
      el = rootEl && typeof rootEl.querySelector === 'function'
        ? rootEl.querySelector('#share-clip video, #share-clip iframe, #share-clip img')
        : null;
    } catch (e) { el = null; }

    let settled = false;
    let timer = null;
    function finish(ok, reason) {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try {
        if (ok) { if (typeof o.onReady === 'function') o.onReady(); }
        else if (typeof o.onFailed === 'function') o.onFailed(reason || 'D3');
      } catch (e) { /* 回调异常不影响页面 */ }
    }

    if (!el) { finish(false, 'D3'); return function () {}; }

    const tag = String(el.tagName || '').toUpperCase();
    const ready = function () { finish(true); };
    const broken = function () { finish(false, 'D3'); };
    try {
      if (tag === 'VIDEO') {
        if (el.readyState >= 2) finish(true);
        else if (typeof el.addEventListener === 'function') {
          el.addEventListener('loadeddata', ready);
          el.addEventListener('error', broken);
        }
      } else if (tag === 'IMG') {
        if (el.complete && el.naturalWidth) finish(true);
        else if (typeof el.addEventListener === 'function') {
          el.addEventListener('load', ready);
          el.addEventListener('error', broken);
        }
      } else if (typeof el.addEventListener === 'function') {
        el.addEventListener('load', ready);            // IFRAME：文档加载完 → 内部动画已在跑
        el.addEventListener('error', broken);
      }
    } catch (e) { /* 忽略 */ }

    if (!settled) timer = setTimeout(function () { finish(false, 'D5'); }, timeoutMs);
    return function () {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
    };
  }

  function cardHtml(p) {
    const cp = p.cardPayload;
    let stats = '';
    if (cp.stats.length) {
      stats = '<div class="stats">' + cp.stats.map(function (s) {
        return '<div class="stat"><span class="lab">' + esc(s.label) + '</span>' +
          '<b style="color:' + esc(s.col) + '">' + esc(s.val) + '</b></div>';
      }).join('') + '</div>';
    }
    const quote = cp.oneLiner
      ? '<blockquote>“' + esc(cp.oneLiner) + '”</blockquote>'
      : '';
    return '<section class="card' + (cp.isDemo ? ' demo' : '') + '" id="share-card">' +
      '<div class="kicker">' + esc(p.title) + '</div>' +
      '<h1 class="case">' + esc(cp.caseNo) + '</h1>' +
      stats + quote +
      '<div class="brandline">在「管住手了吗复盘」生成</div>' +
      '<div class="disclaimer">' + esc(cp.disclaimer) + '</div>' +
      (cp.isDemo ? '<div class="demo-mark">示例数据 · 仅用于体验</div>' : '') +
      '</section>';
  }

  // build(payload) -> { html, url, fallbackUsed, reason }
  //   纯函数：不写 DOM、不发网络、不读 localStorage；只看 PanjiClip 已加载的 manifest 缓存
  //   失败一律返回纯卡片兜底对象，不抛异常
  function build(payload) {
    try {
      const p = normalize(payload);
      if (!p) return { html: neutralHtml(), url: HOME_URL, fallbackUsed: true, reason: 'D6' };

      let clip = null;
      let fallbackUsed = false;
      let reason = '';

      if (p.template !== 'card' && p.clipRef && p.clipRef.id) {
        clip = resolve(p.clipRef.id);
        if (!clip) { fallbackUsed = true; reason = 'D2'; }                 // 查不到（含 manifest 空）
        else if (!FORMATS[clip.format] || !canPlay(clip.format)) { fallbackUsed = true; reason = 'D4'; clip = null; }
      } else {
        fallbackUsed = true; reason = 'D1';                                // clipRef 缺失
      }

      const fitted = fitWithin(p);
      let clipDropped = false;
      if (fitted.droppedClip) {
        // 超限截断把 clipRef 拿掉了：按纯卡片出，不再挂 clip
        clip = null;
        if (!fallbackUsed) { fallbackUsed = true; }
        reason = 'D6';
        clipDropped = true;
      }

      const html = (clip && !clipDropped ? clipHtml(clip) : '') + cardHtml(p);
      return { html: html, url: SHARE_PAGE + '#' + fitted.enc, fallbackUsed: fallbackUsed, reason: reason };
    } catch (e) {
      warn('share build failed');
      return { html: neutralHtml(), url: HOME_URL, fallbackUsed: true, reason: 'D6' };
    }
  }

  const PanjiClip = {
    load: load,
    resolve: resolve,
    INDEX_URL: INDEX_URL,
  };

  const PanjiShare = {
    build: build,
    decode: decode,
    reportFallback: reportFallback,
    attachClip: attachClip,
    encode: function (payload) {
      try {
        const p = normalize(payload);
        return p ? encodePayload(p) : '';
      } catch (e) { return ''; }
    },
    MAX_PAYLOAD: MAX_PAYLOAD,
  };

  return { PanjiShare: PanjiShare, PanjiClip: PanjiClip };
});
