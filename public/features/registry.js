/* 页面注册表（会员档骨架 · 全部为占位值）
 * 改动只发生在本文件：页面 → 档位一处登记，导航标识与 canUse 都查这张表。
 * 档位：free=免费 / basic=基础 / pro=高级。占位值不改变任何页面的实际可见性。
 * 范围：public 根目录下可路由的 .html；public/clips 与 public/media/clips 里的动画片段
 *       属于内容素材页，随学习页内嵌展示，不单独设档。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PanjiRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TIERS = {
    free: { level: 0, label: '免费' },
    basic: { level: 1, label: '基础' },
    pro: { level: 2, label: '高级' }
  };

  var PAGES = [
    { key: 'index', path: 'index.html', title: '交割单复盘', tier: 'free' },
    { key: 'learn', path: 'learn.html', title: '科普动画', tier: 'free' },
    { key: 'replay', path: 'replay.html', title: '回放训练', tier: 'basic' },
    { key: 'collection', path: 'collection.html', title: '图鉴', tier: 'pro' },
    { key: 'discipline', path: 'discipline.html', title: '纪律随身卡', tier: 'free' },
    { key: 'features', path: 'features.html', title: '全部功能', tier: 'free' },
    { key: 'archive', path: 'archive.html', title: '个股档案', tier: 'basic' },
    { key: 'cases', path: 'cases.html', title: '之前的档案', tier: 'basic' },
    { key: 'stats', path: 'stats.html', title: '使用统计', tier: 'basic' },
    { key: 'share', path: 'share.html', title: '纪律记分卡', tier: 'free' },
    { key: 'about', path: 'about.html', title: '产品事实页', tier: 'free' },
    { key: 'agreement', path: 'agreement.html', title: '用户协议', tier: 'free' },
    { key: 'privacy', path: 'privacy.html', title: '隐私政策', tier: 'free' },
    { key: 'migrate', path: 'migrate.html', title: '档案迁移', tier: 'free' },
    { key: 'login', path: 'login.html', title: '登录', tier: 'free' },
    { key: 'pay-return', path: 'pay-return.html', title: '支付结果', tier: 'free' }
  ];

  var BY_PATH = {};
  var BY_KEY = {};
  PAGES.forEach(function (page) {
    BY_PATH[page.path] = page;
    BY_KEY[page.key] = page;
  });

  /** href / 文件名 / 带查询串的路径 → 注册表里的页面文件名 */
  function normalizePath(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return 'index.html';
    s = s.split('#')[0].split('?')[0].replace(/\\/g, '/');
    var cut = s.lastIndexOf('/');
    if (cut >= 0) s = s.slice(cut + 1);
    if (!s || s === '.' || s === './') return 'index.html';
    return s;
  }

  /** 按 key（'replay'）或路径（'replay.html'）查页面；查不到返回 null */
  function getPage(term) {
    if (term == null || term === '') return null;
    var t = String(term);
    if (BY_KEY[t]) return BY_KEY[t];
    return BY_PATH[normalizePath(t)] || null;
  }

  /** 页面所属档位；查不到返回 null */
  function tierOf(term) {
    var page = getPage(term);
    return page ? page.tier : null;
  }

  /** 页面所需档位等级；免费页与未登记项均为 0 */
  function requiredLevel(term) {
    var tier = TIERS[tierOf(term) || 'free'];
    return tier ? tier.level : 0;
  }

  function listPages(tier) {
    if (!tier) return PAGES.slice();
    return PAGES.filter(function (page) { return page.tier === tier; });
  }

  return {
    TIERS: TIERS,
    PAGES: PAGES,
    normalizePath: normalizePath,
    getPage: getPage,
    tierOf: tierOf,
    requiredLevel: requiredLevel,
    listPages: listPages
  };
});
