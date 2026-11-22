/* 会员档骨架（占位）
 * - 只读本机 localStorage 的档位标记，默认免费；不做支付、不接内购、不做登录。
 * - 与既有 license / PJL_GATE 体系无关：PJL_GATE 仍是授权的真相源，这里只服务页面导航骨架。
 * - canUse 只查注册表，不改变任何现有页面的行为与可见性。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./registry.js'), root);
  } else {
    root.PanjiMembership = factory(root.PanjiRegistry, root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (registry, root) {
  'use strict';

  var STORAGE_KEY = 'panji_membership_tier_v0';
  var DEFAULT_TIER = 'free';
  var TIERS = (registry && registry.TIERS) || {
    free: { level: 0, label: '免费' },
    basic: { level: 1, label: '基础' },
    pro: { level: 2, label: '高级' }
  };

  function storage() {
    try { return (root && root.localStorage) || null; } catch (e) { return null; }
  }

  /** 当前档位；未写标记、读不到或值不合法时一律按免费 */
  function currentTier() {
    var raw = '';
    var store = storage();
    try { raw = store ? String(store.getItem(STORAGE_KEY) || '') : ''; } catch (e) { raw = ''; }
    raw = raw.trim().toLowerCase();
    return TIERS[raw] ? raw : DEFAULT_TIER;
  }

  /**
   * 是否能使用某个页面/功能。
   * @param {string} featureKey 注册表 key（如 'replay'）或路径（如 'replay.html'、'replay.html?f=train'）
   * @returns {boolean} 当前档位 ≥ 该条目档位；未登记的 key 一律放行（骨架期不误拦）
   */
  function canUse(featureKey) {
    if (!registry || typeof registry.getPage !== 'function') return true;
    var page = registry.getPage(featureKey);
    if (!page) return true;
    var need = TIERS[page.tier] ? TIERS[page.tier].level : 0;
    var have = TIERS[currentTier()].level;
    return have >= need;
  }

  /** 给导航项挂「会员」小标识；只改标识，不动导航结构与页面布局。返回新增数量。 */
  function decorateNav(scope) {
    var doc = root && root.document;
    if (!doc || !registry || typeof registry.getPage !== 'function') return 0;

    var host = doc;
    if (scope) host = typeof scope === 'string' ? doc.querySelector(scope) : scope;
    if (!host || typeof host.querySelectorAll !== 'function') return 0;

    var added = 0;
    Array.prototype.forEach.call(host.querySelectorAll('nav a[href]'), function (link) {
      var href = link.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;
      if (/^(javascript|mailto|tel):/i.test(href)) return;

      var page = registry.getPage(href);
      if (!page) return;
      var tier = TIERS[page.tier];
      if (!tier || tier.level <= 0) return;
      if (link.querySelector('[data-pj-tier-mark]')) return;

      var mark = doc.createElement('span');
      mark.setAttribute('data-pj-tier-mark', page.tier);
      mark.setAttribute('aria-label', tier.label + '档功能');
      mark.title = tier.label + '档功能';
      mark.textContent = '会员';
      mark.style.cssText = [
        'margin-left:6px',
        'padding:1px 6px',
        'border:1px solid currentColor',
        'border-radius:100px',
        'font:10px/1.5 ui-monospace,monospace',
        'letter-spacing:.06em',
        'opacity:.7',
        'vertical-align:middle',
        'white-space:nowrap'
      ].join(';');
      link.appendChild(mark);
      added += 1;
    });
    return added;
  }

  /** 首页 / 功能页的入口占位：只显示档位与说明，不含任何业务内容。 */
  function mountEntry(target) {
    var doc = root && root.document;
    if (!doc) return null;
    var host = target ? (typeof target === 'string' ? doc.querySelector(target) : target) : null;
    if (!host) return null;
    if (host.getAttribute('data-pj-entry') === '1') return host;
    host.setAttribute('data-pj-entry', '1');

    if (!doc.querySelector('style[data-pj-member-style]')) {
      var style = doc.createElement('style');
      style.setAttribute('data-pj-member-style', '1');
      style.textContent = [
        '.pj-member-entry{margin:14px 0 18px;padding:12px 14px;border:1px dashed currentColor;border-radius:12px;font-size:12.5px;line-height:1.7;opacity:.75}',
        '.pj-member-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0}',
        '.pj-member-tag{font:10.5px/1.6 ui-monospace,monospace;letter-spacing:.12em;border:1px solid currentColor;border-radius:100px;padding:1px 8px}',
        '.pj-member-note{margin:6px 0 0;opacity:.7}'
      ].join('\n');
      (doc.head || doc.documentElement).appendChild(style);
    }

    var box = doc.createElement('div');
    box.className = 'pj-member-entry';

    var row = doc.createElement('p');
    row.className = 'pj-member-row';
    var tag = doc.createElement('span');
    tag.className = 'pj-member-tag';
    tag.textContent = '会员入口 · 占位';
    var cur = doc.createElement('span');
    cur.textContent = '当前档位：' + TIERS[currentTier()].label;
    row.appendChild(tag);
    row.appendChild(cur);

    var note = doc.createElement('p');
    note.className = 'pj-member-note';
    note.textContent = '档位按页面统一登记，本机标记默认免费；不接支付、不接内购、不做登录。';

    box.appendChild(row);
    box.appendChild(note);
    host.appendChild(box);
    return host;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_TIER: DEFAULT_TIER,
    TIERS: TIERS,
    currentTier: currentTier,
    canUse: canUse,
    decorateNav: decorateNav,
    mountEntry: mountEntry
  };
});
