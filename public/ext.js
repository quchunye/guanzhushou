// ext.js —— 扩展钩子注册器 + feature flag + 埋点转发（批次 0 地基）
//
// 其他批次只往 PanjiExt 的数组里 push，不抢改 app.js/index.html。
// 所有钩子失败都必须静默降级，不能让报告页面挂掉。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else {
    const api = factory(root);
    root.PanjiExt = api.PanjiExt;
    root.PanjiFlag = api.PanjiFlag;
    root.PanjiTrack = api.PanjiTrack;
  }
})(typeof self !== 'undefined' ? self : this, function (root) {

  const NAMES = [
    'reportTop', 'reportBottom', 'lineExtra', 'reviewTop', 'homeTop',
    'rulesBottom', 'afterConfirm', 'afterIngest', 'afterRulesSave', 'shareStats',
  ];

  const PanjiExt = {};
  NAMES.forEach((n) => { PanjiExt[n] = []; });

  // 把某个钩子的返回值拼成 html；钩子异常不影响主流程
  function run(name, ...args) {
    const arr = PanjiExt[name] || [];
    const out = [];
    arr.forEach((fn) => {
      try {
        const r = fn(...args);
        if (r != null && r !== '') out.push(String(r));
      } catch (e) { /* 钩子失败静默 */ }
    });
    return out.join('');
  }

  // shareStats 这类只取第一个非空返回值
  function first(name, ...args) {
    const arr = PanjiExt[name] || [];
    for (const fn of arr) {
      try {
        const r = fn(...args);
        if (r != null && r !== '') return r;
      } catch (e) { /* 静默 */ }
    }
    return null;
  }

  // ---------- feature flags ----------
  const DEFAULTS = { recur: true, train: false, migrate: false };  // train：K 线训练三板块，默认关（关着时 /replay.html 与改动前一致）；migrate：档案迁移页，默认关

  function readFlags() {
    const flags = Object.assign({}, DEFAULTS);
    try {
      const q = new URLSearchParams(root.location ? root.location.search : '');
      const f = q.get('f');
      if (f) {
        f.split(',').map(s => s.trim()).filter(Boolean).forEach((name) => {
          if (name[0] === '-') flags[name.slice(1)] = false;
          else flags[name] = true;
        });
      }
    } catch (e) { /* 非浏览器环境 */ }
    try {
      const raw = root.localStorage && root.localStorage.getItem('guanzhu_flags_v1');
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') Object.assign(flags, saved);
      }
    } catch (e) { /* 读取失败按默认 */ }
    return flags;
  }

  // 商店包（构建级常量）：真实数据入口与自带数据导入恒关，URL 参数与本地 flags 都不能打开
  const STORE_BLOCKED = { real: true, kimport: true };
  function isStoreBuild() {
    try { return !!(root.PANJI_STORE_BUILD); } catch (e) { return false; }
  }

  function PanjiFlag(name) {
    if (isStoreBuild() && STORE_BLOCKED[name]) return false;
    return !!readFlags()[name];
  }

  // ---------- 埋点转发 ----------
  // app.js 会把 window.PanjiTrack 覆盖成真正的 track；这里只做兜底。
  function PanjiTrack(event, data) {
    try {
      if (typeof root.__panjiTrack === 'function') return root.__panjiTrack(event, data);
    } catch (e) { /* 静默 */ }
  }

  PanjiExt.run = run;
  PanjiExt.first = first;
  PanjiExt.NAMES = NAMES;

  return { PanjiExt, PanjiFlag, PanjiTrack };
});
