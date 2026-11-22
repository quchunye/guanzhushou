/* features/paywall.js —— 会员档位与权益页（2026-11-09，v1.1）
 *
 * 本版变化：
 *   1. 三档 × 17 项矩阵写死在 MATRIX。页面只渲染「进产品」的 9 项；
 *      8 项整条不做的条目保留 ✕ 值用于 canUse 判假，页面整行跳过，不单列、不预告。
 *   2. 新增 canUse(key) / canUseAt(key, tier)：按档位累计口径返回布尔。
 *      基础档含免费档全部，高级档含基础档全部；与页面矩阵同源。
 *   3. membership.html 改为真页：页头、说明、免费档闭环、免责为静态内容，
 *      三档卡片与矩阵由本文件渲染，矩阵数值不在 HTML 里另存一份。
 *
 * 边界（硬约束，改代码前先读）：
 *   - 不做支付、不接内购、不做登录、不做退款；页面不放任何购买按钮。
 *   - 只描述工具能力：记录 / 统计 / 回看 / 导出 / 容量 / 设备数 / 历史长度。
 *     不产出任何标的、价位、方向或收益类内容。
 *   - 每档权益说明末尾必须带「不构成投资建议」；页脚与说明弹层同。
 *   - 免费档必须自己完整可用：9 项进产品能力在免费档都有基础用法。
 *
 * 与组 1 对齐：
 *   - 档位 id：free / basic / pro；?tier=premium 兼容映射到 pro。
 *   - 与 features/membership.js 共用本机 key：panji_membership_tier_v0。
 *   - PAGE_KEYS 仍直接读 public/features/registry.js，只作页面级入口标识，不参与本矩阵。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./registry.js'), null);
  else root.PanjiPaywall = factory(root.PanjiRegistry, root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (registry, root) {
  'use strict';

  var VERSION = '1.1';
  var STORE_KEY = 'panji_membership_tier_v0';   // 与 features/membership.js 共用，禁止另起 key
  var DEFAULT_TIER = 'free';
  var TIER_ORDER = ['free', 'basic', 'pro'];
  var DISCLAIMER = '以上均为记录与统计工具能力，不构成投资建议。';
  var MODAL_DISCLAIMER = '本弹层只做档位说明，不拦截任何功能；不构成投资建议。';
  var FOOT_DISCLAIMER = '本页只描述工具能力与用量差异。所有判定标准由你自己勾选；'
    + '产品不提供证券分析、预测或选择建议。不构成投资建议。';
  var LEDE = '三档按累计口径排：基础档含免费档全部，高级档含基础档全部。'
    + '差异只在容量、历史长度、回看深度与导出方式；判定标准始终是你自己勾选的规则。'
    + '产品不产出任何分析、预测或选择建议。';
  var STATUS_NOTE = '● 该档可用；○ 该档新增工具位（依赖后端 / 构建，当前未接线）；'
    + '— 该档不新增（低档能力自动包含）；✕ 永不进产品（页面不列）。';

  var FALLBACK_PAGE_KEYS = {
    index:      { label: '交割单复盘', path: 'index.html' },
    learn:      { label: '科普动画', path: 'learn.html' },
    replay:     { label: '回放训练', path: 'replay.html?f=train&tab=a' },
    collection: { label: '图鉴', path: 'collection.html' },
    discipline: { label: '纪律随身卡', path: 'discipline.html' },
    features:   { label: '全部功能', path: 'features.html' },
    archive:    { label: '个股档案', path: 'archive.html' },
    cases:      { label: '档案列表', path: 'cases.html' },
    stats:      { label: '报告与统计', path: 'stats.html' },
    share:      { label: '分享页', path: 'share.html' },
    migrate:    { label: '备份与迁移', path: 'migrate.html?f=migrate' },
    membership: { label: '会员与档位', path: 'membership.html' }
  };

  // 页面注册表镜像：优先读组 1 的 PanjiRegistry，缺失项用 fallback 补齐。
  var PAGE_KEYS = {};
  if (registry && Array.isArray(registry.PAGES)) {
    registry.PAGES.forEach(function (p) {
      PAGE_KEYS[p.key] = { label: p.title, path: p.path, tier: p.tier };
    });
  }
  Object.keys(FALLBACK_PAGE_KEYS).forEach(function (k) {
    if (!PAGE_KEYS[k]) PAGE_KEYS[k] = FALLBACK_PAGE_KEYS[k];
  });

  var TIERS = [
    {
      id: 'free',
      name: '免费档',
      en: 'FREE',
      line: '免费：传一份交割单，生成只存在本机的纪律档案；写你自己的规则，逐日自查。',
      forWho: '刚开始记录，或只想先看清自己操作的人。',
      price: '价格见线上站点 · 自托管版免费',
      rows: [
        { label: '记录', text: '交割单导入、手工补录、账本合并与去重；判定标准由你自己勾选；单日报告。' },
        { label: '自查', text: '今日自查、我的检查时点、纪律随身卡；规则与内容全部由你自己写。' },
        { label: '回看', text: '单日 K 与分时；到期日自查（守住了吗）；最近 30 个交易日。' },
        { label: '档案', text: '我的记录（列表 + 搜索 + 三计数）；票档案与批注。' },
        { label: '导出', text: '本机备份导出 / 导入；分享卡（品牌位与示例水印固定）。' },
        { label: '容量', text: '30 份档案；1 台设备；最近 30 个交易日。', status: 'wire' }
      ],
      note: '核心的记录、判定、报告、备份都在免费档，不因付费缺失。'
    },
    {
      id: 'basic',
      name: '基础档',
      en: 'BASIC',
      line: '基础会员：解锁时间维度工具——把你的规则对到历史某一天，看条件成立几条；按票做跨日对比；导出你的记录。',
      forWho: '已经连续记录一段时间，想看跨日变化的人。',
      price: '价格见线上站点 · 自托管版免费',
      rows: [
        { label: '记录', text: '免费档全部；2 个账户；操作理由标记；期初持仓与出入金。' },
        { label: '时间维度', text: '指标参数 + 条件回放；票档案跨日对比 + 单票导出；到期回看队列。' },
        { label: '容量', text: '300 份档案；1 台设备；最近 250 个交易日。', status: 'wire' }
      ],
      note: '判定标准仍然只来自你自己勾选的规则，产品不替你下判断。'
    },
    {
      id: 'pro',
      name: '高级档',
      en: 'PRO',
      line: '高级会员：解锁规模维度工具——多日并排回放、跨年记录计数、批量导出。所有工具处理的对象都是你自己写下的内容。',
      forWho: '需要导出、需要复核判定、需要批量回看的人。',
      price: '价格见线上站点 · 自托管版免费',
      rows: [
        { label: '记录', text: '基础档全部；3 个账户；情绪标记分组（至少 30 条标记后才显示）。' },
        { label: '规模维度', text: '多日并排回放、跨年记录计数、批量导出（三项工具位当前未接线）。', status: 'plan' },
        { label: '容量', text: '不限（受本机存储限制）；3 台设备；全部已导入。', status: 'wire' }
      ],
      note: '工具位只处理你自己写下的内容，不产出任何判断结论。'
    }
  ];

  /*
   * 三档 × 17 项矩阵（数值写死，来源：红灰档合规化改造映射表 零·补三）。
   * 单元格首位是图例：● 该档可用；○ 该档新增工具位（当前未接线）；— 该档不新增；✕ 不进产品。
   * excluded=true 的 8 项只用于 canUse 判假，页面渲染时整行跳过。
   * 档位累计：基础档含免费档全部，高级档含基础档全部。
   */
  var MATRIX = [
    { id: 'R-01', label: '今日自查', free: '● 今日自查', basic: '—', pro: '—', note: '规则由你自己写，逐日作答。' },
    { id: 'R-02', label: '我的检查时点', free: '● 读卡时点', basic: '—', pro: '—', note: '时间点由你自己填，产品不发通知。' },
    { id: 'R-03', label: '历史回放', free: '● 单日 K 与分时', basic: '● 指标参数 + 条件回放', pro: '○ 多日并排', note: '只看已收盘的历史数据。' },
    { id: 'R-04', label: '我的记录', free: '● 列表 + 搜索 + 三计数', basic: '—', pro: '○ 跨年记录计数', note: '只数「份」，不算任何比例。' },
    { id: 'R-05', label: '规则怎么写', free: '● 规则怎么写', basic: '—', pro: '—', note: '只讲怎么写出可判定的规则，不提供方法结论。' },
    // R-06 整条不做：命中「删掉结论就没价值」判断原则，不进产品。
    { id: 'R-06', label: '', free: '✕', basic: '✕', pro: '✕', excluded: true },
    { id: 'R-07', label: '票档案与批注', free: '● 档案 + 批注', basic: '● 跨日对比 + 单票导出', pro: '○ 批量导出', note: '批注内容由你自己写。' },
    { id: 'R-08', label: '站点外壳', free: '● 导航与页脚', basic: '—', pro: '—', note: '外壳不单独售卖。' },
    { id: 'R-09', label: '纪律随身卡', free: '● 四组自填容器', basic: '—', pro: '—', note: '容器本身是空的，内容全部由你自己填。' },
    // R-10 ~ R-14、R-16、R-17 整条不做：同命中判断原则，不进产品。
    { id: 'R-10', label: '', free: '✕', basic: '✕', pro: '✕', excluded: true },
    { id: 'R-11', label: '', free: '✕', basic: '✕', pro: '✕', excluded: true },
    { id: 'R-12', label: '', free: '✕', basic: '✕', pro: '✕', excluded: true },
    { id: 'R-13', label: '', free: '✕', basic: '✕', pro: '✕', excluded: true },
    { id: 'R-14', label: '', free: '✕', basic: '✕', pro: '✕', excluded: true },
    { id: 'R-15', label: '到期回看', free: '● 到期日 + 守住了吗', basic: '● 回看队列', pro: '—', note: '到期只回答「那天你写的规则守住了吗」。' },
    { id: 'R-16', label: '', free: '✕', basic: '✕', pro: '✕', excluded: true },
    { id: 'R-17', label: '', free: '✕', basic: '✕', pro: '✕', excluded: true }
  ];

  function tierById(id) {
    for (var i = 0; i < TIERS.length; i += 1) {
      if (TIERS[i].id === id) return TIERS[i];
    }
    return null;
  }

  function query(name) {
    try {
      var search = (typeof location !== 'undefined' && location.search) ? String(location.search) : '';
      if (!search) return '';
      var q = search.replace(/^\?/, '').split('&');
      for (var i = 0; i < q.length; i += 1) {
        var pair = q[i].split('=');
        if (decodeURIComponent(pair[0] || '') === name) return decodeURIComponent(pair[1] || '');
      }
    } catch (e) { /* 读取失败按空处理 */ }
    return '';
  }

  function readStored() {
    try {
      if (typeof localStorage === 'undefined') return '';
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return '';
      return String(raw);
    } catch (e) { return ''; }
  }

  function writeStored(id) {
    try {
      if (typeof localStorage === 'undefined') return { ok: false, error: 'no_storage' };
      localStorage.setItem(STORE_KEY, id);
      return { ok: true };
    } catch (e) { return { ok: false, error: 'write_failed' }; }
  }

  // ?tier= 只影响本次加载；localStorage 是持久开关；都不合法则 free。
  var runtimeTier = '';

  // 组 1 的 id 是 free / basic / pro；兼容旧写法 premium / advanced。
  function normalizeTierId(id) {
    var s = String(id == null ? '' : id).trim().toLowerCase();
    if (s === 'premium' || s === 'advanced') return 'pro';
    return s;
  }

  function currentTier() {
    if (tierById(runtimeTier)) return runtimeTier;
    var fromUrl = normalizeTierId(query('tier'));
    if (tierById(fromUrl)) return fromUrl;
    var stored = normalizeTierId(readStored());
    if (tierById(stored)) return stored;
    return DEFAULT_TIER;
  }

  function setTier(id) {
    var normalized = normalizeTierId(id);
    if (!tierById(normalized)) return { ok: false, error: 'BAD_TIER' };
    runtimeTier = normalized;
    var r = writeStored(normalized);
    return { ok: r.ok, tier: normalized, error: r.error || '' };
  }

  function tierIndex(id) {
    for (var i = 0; i < TIERS.length; i += 1) {
      if (TIERS[i].id === id) return i;
    }
    return 0;
  }

  function rowByKey(key) {
    for (var i = 0; i < MATRIX.length; i += 1) {
      if (MATRIX[i].id === key) return MATRIX[i];
    }
    return null;
  }

  function visibleMatrix() {
    return MATRIX.filter(function (r) { return !r.excluded; });
  }

  function mark(v) {
    return String(v == null ? '' : v).charAt(0);
  }

  function cellText(v) {
    return String(v == null ? '' : v).slice(1).trim();
  }

  function cellAt(key, tierId) {
    var row = rowByKey(key);
    if (!row) return '';
    return String(row[tierId] == null ? '' : row[tierId]);
  }

  // 本档或更低档出现过 ●，即视为可用（档位累计；— 不是禁用）
  function canUseAt(key, tierId) {
    var row = rowByKey(key);
    if (!row || row.excluded) return false;
    var idx = tierIndex(tierId);
    for (var i = 0; i <= idx; i += 1) {
      if (mark(row[TIER_ORDER[i]]) === '●') return true;
    }
    return false;
  }

  function canUse(key) {
    return canUseAt(key, currentTier());
  }

  // 免费档是否覆盖全部进产品项（验收用）
  function freeComplete() {
    return visibleMatrix().every(function (r) { return canUseAt(r.id, 'free'); });
  }

  function requiredTier(key) {
    var row = rowByKey(key);
    if (!row || row.excluded) return 'none';
    for (var i = 0; i < TIER_ORDER.length; i += 1) {
      if (mark(row[TIER_ORDER[i]]) === '●') return TIER_ORDER[i];
    }
    return 'pro';
  }

  function inheritedFrom(row, tierId) {
    var idx = tierIndex(tierId);
    for (var i = idx - 1; i >= 0; i -= 1) {
      if (mark(row[TIER_ORDER[i]]) === '●') return TIER_ORDER[i];
    }
    return '';
  }

  /*
   * 矩阵查询：canUse 的真相源。
   * 9 项进产品能力在免费档都有基础用法，因此 canUse 三档均可用；
   * 8 项整条不做恒 false，页面不列。
   */
  function check(key) {
    var row = rowByKey(key);
    var allowed = canUse(key);
    var required = requiredTier(key);
    return {
      feature: key,
      label: row ? row.label : key,
      current: currentTier(),
      required: required,
      allowed: allowed,
      gated: !allowed,
      wouldGate: !allowed,
      reason: allowed ? 'MATRIX_ALLOWED' : 'MATRIX_NOT_AVAILABLE'
    };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function chip(status) {
    if (status === 'beta') return '<span class="pw-chip pw-chip--beta">内测</span>';
    if (status === 'plan') return '<span class="pw-chip pw-chip--plan">工具位 · 未接线</span>';
    if (status === 'wire') return '<span class="pw-chip pw-chip--wire">未接线</span>';
    return '';
  }

  function tierCardHtml(t, active) {
    var rows = t.rows.map(function (r) {
      return '<li><b>' + esc(r.label) + '</b><span>' + esc(r.text) + '</span>' + chip(r.status) + '</li>';
    }).join('');
    return ''
      + '<article class="pw-card' + (active ? ' pw-card--active' : '') + '" data-card="' + esc(t.id) + '">'
      +   '<div class="pw-card-top"><span class="pw-en">' + esc(t.en) + '</span>'
      +     (active ? '<span class="pw-now">当前档位</span>' : '')
      +   '</div>'
      +   '<h2>' + esc(t.name) + '</h2>'
      +   '<p class="pw-line">' + esc(t.line) + '</p>'
      +   '<p class="pw-for">' + esc(t.forWho) + '</p>'
      +   '<p class="pw-price">' + esc(t.price) + '</p>'
      +   '<ul class="pw-list">' + rows + '</ul>'
      +   '<p class="pw-note">' + esc(t.note) + '</p>'
      +   '<p class="pw-disclaimer">' + esc(DISCLAIMER) + '</p>'
      + '</article>';
  }

  function cardsHtml() {
    var cur = currentTier();
    return TIERS.map(function (x) { return tierCardHtml(x, x.id === cur); }).join('');
  }

  function cellHtml(row, tierId) {
    var raw = String(row[tierId] == null ? '' : row[tierId]);
    var mk = mark(raw);
    var txt = cellText(raw);
    var inherited = inheritedFrom(row, tierId);
    if (mk === '●') {
      return '<span class="pw-cell pw-cell--on"><em class="pw-cell-mark">可用</em>'
        + (txt ? '<span class="pw-cell-text">' + esc(txt) + '</span>' : '')
        + '</span>';
    }
    if (mk === '○') {
      return '<span class="pw-cell pw-cell--pending"><em class="pw-cell-mark">工具位 · 未接线</em>'
        + (txt ? '<span class="pw-cell-text">' + esc(txt) + '</span>' : '')
        + (inherited ? '<span class="pw-cell-carry">含' + esc(tierById(inherited).name) + '的基础能力</span>' : '')
        + '</span>';
    }
    if (mk === '—') {
      if (inherited) {
        return '<span class="pw-cell pw-cell--inherit"><em class="pw-cell-mark">含' + esc(tierById(inherited).name) + '</em></span>';
      }
      return '<span class="pw-cell pw-cell--off">不做</span>';
    }
    return '<span class="pw-cell pw-cell--off">不列</span>';
  }

  function matrixHtml() {
    var rows = visibleMatrix();
    var body = rows.map(function (r) {
      return ''
        + '<tr>'
        +   '<th scope="row"><code>' + esc(r.id) + '</code><span>' + esc(r.label) + '</span></th>'
        +   '<td>' + cellHtml(r, 'free') + '</td>'
        +   '<td>' + cellHtml(r, 'basic') + '</td>'
        +   '<td>' + cellHtml(r, 'pro') + '</td>'
        +   '<td class="pw-matrix-note-cell">' + esc(r.note || '') + '</td>'
        + '</tr>';
    }).join('');
    return ''
      + '<div class="pw-matrix-wrap">'
      +   '<table class="pw-matrix">'
      +     '<caption>三档 × 17 项矩阵 <span>本页只列已进产品的 ' + rows.length + ' 项；档位累计，基础档含免费档全部，高级档含基础档全部。</span></caption>'
      +     '<thead><tr><th scope="col">功能</th><th scope="col">免费档</th><th scope="col">基础档</th><th scope="col">高级档</th><th scope="col">说明</th></tr></thead>'
      +     '<tbody>' + body + '</tbody>'
      +   '</table>'
      + '</div>';
  }

  function navHtml() {
    return ''
      + '<nav class="pw-nav" aria-label="站点入口">'
      +   '<a href="./">交割单复盘</a>'
      +   '<a href="learn.html">科普动画</a>'
      +   '<a href="replay.html?f=train&amp;tab=a">回放训练</a>'
      +   '<a href="collection.html">图鉴</a>'
      +   '<a href="discipline.html">纪律随身卡</a>'
      +   '<a href="features.html">全部功能</a>'
      +   '<a class="on" href="membership.html" aria-current="page">会员与档位</a>'
      + '</nav>';
  }

  function switchInnerHtml() {
    var cur = currentTier();
    var buttons = TIERS.map(function (t) {
      return '<button type="button" data-set-tier="' + esc(t.id) + '"'
        + (t.id === cur ? ' aria-pressed="true"' : ' aria-pressed="false"')
        + '>' + esc(t.name) + '</button>';
    }).join('');
    return '<span>档位预览开关（仅 ?dev=1 可见）</span>' + buttons;
  }

  function switchHtml() {
    if (query('dev') !== '1') return '';
    return '<div class="pw-switch" role="group" aria-label="档位预览开关">' + switchInnerHtml() + '</div>';
  }

  function statusHtml() {
    var t = tierById(currentTier()) || tierById(DEFAULT_TIER);
    var rows = visibleMatrix();
    var on = rows.filter(function (r) { return canUseAt(r.id, currentTier()); }).length;
    return ''
      + '<div class="pw-status">'
      +   '<span>当前档位</span><b id="pw-current">' + esc(t.name) + '</b>'
      +   '<span class="pw-status-avail" id="pw-avail">本档可用 ' + on + ' / ' + rows.length + ' 项</span>'
      +   '<span class="pw-status-note">本机开关 · 不锁功能</span>'
      + '</div>';
  }

  function noticeHtml() {
    return ''
      + '<div class="pw-notice">'
      +   '<p><b>自托管版免费</b>：本仓以 AGPL-3.0 开源，不接支付、不做登录、不做退款，也不因档位拦截任何功能。托管版与内容库不在本仓。</p>'
      +   '<p>容量与设备数为设计上限，当前版本不校验；标注「工具位 · 未接线」的条目属于后续构建项，不作为在售权益。</p>'
      + '</div>';
  }

  function pageHtml() {
    var cur = currentTier();
    var t = tierById(cur) || tierById(DEFAULT_TIER);
    var rows = visibleMatrix();
    return ''
      + '<div class="pw-wrap">'
      +   '<div class="pw-top"><a href="./">← 回首页</a><span class="pw-mono">MEMBERSHIP</span></div>'
      +   navHtml()
      +   '<h1>会员与档位</h1>'
      +   '<p class="pw-lede">' + esc(LEDE) + '</p>'
      +   statusHtml()
      +   switchHtml()
      +   noticeHtml()
      +   '<section aria-label="三档对比">'
      +     '<div class="pw-section-h"><h2>三档权益</h2><p>每档末尾都写明同一条边界：只描述记录与统计工具能力。</p></div>'
      +     '<div class="pw-tiers" id="pw-cards">' + cardsHtml() + '</div>'
      +   '</section>'
      +   '<section class="pw-section"><div class="pw-section-h"><h2>三档 × 17 项矩阵</h2>'
      +     '<p>17 项里 9 项进产品，本页只列这 9 项；档位按累计口径显示。</p></div>'
      +     matrixHtml()
      +     '<p class="pw-matrix-note">' + esc(STATUS_NOTE) + '</p>'
      +   '</section>'
      +   '<footer class="pw-foot"><p>' + esc(FOOT_DISCLAIMER) + '</p></footer>'
      + '</div>';
  }

  function tierModalCell(row, t, cur) {
    var raw = String(row[t.id] == null ? '' : row[t.id]);
    var mk = mark(raw);
    var txt = cellText(raw);
    var inherited = inheritedFrom(row, t.id);
    var text;
    if (mk === '●') text = '可用' + (txt ? '：' + txt : '');
    else if (mk === '○') text = '工具位（未接线）' + (txt ? '：' + txt : '');
    else if (mk === '—') text = inherited ? '含' + tierById(inherited).name : '不做';
    else text = '不列';
    return '<tr' + (t.id === cur ? ' class="pw-cur"' : '') + '><th>' + esc(t.name)
      + (t.id === cur ? '（当前）' : '') + '</th><td>' + esc(text) + '</td></tr>';
  }

  function overlayHtml(featureKey) {
    var row = rowByKey(featureKey);
    var cur = currentTier();
    var title = row && row.label ? row.label : '这项能力';
    var cells = TIERS.map(function (t) {
      return row ? tierModalCell(row, t, cur) : '';
    }).join('');
    return ''
      + '<div class="pw-modal" role="dialog" aria-modal="true" aria-labelledby="pw-modal-title">'
      +   '<div class="pw-modal-card">'
      +     '<button type="button" class="pw-modal-x" data-close-paywall aria-label="关闭">×</button>'
      +     '<span class="pw-en">CAPABILITY PREVIEW</span>'
      +     '<h2 id="pw-modal-title">' + esc(title) + '</h2>'
      +     '<p class="pw-modal-line">这条能力在免费档就有基础用法；基础档与高级档只增加工具位。'
      +       '本弹层只做档位说明，<b>不拦截任何功能</b>。</p>'
      +     '<table class="pw-modal-table"><tbody>' + cells + '</tbody></table>'
      +     '<p class="pw-modal-note">当前档位：' + esc((tierById(cur) || {}).name || cur) + '。'
      +       'canUse() 按矩阵返回，三档都可使用这 9 项的基础能力。</p>'
      +     '<div class="pw-modal-acts">'
      +       '<a class="pw-btn" href="membership.html">去会员页看完整矩阵</a>'
      +       '<button type="button" class="pw-btn pw-btn--ghost" data-close-paywall>关闭，继续用免费功能</button>'
      +     '</div>'
      +     '<p class="pw-disclaimer">' + esc(MODAL_DISCLAIMER) + '</p>'
      +   '</div>'
      + '</div>';
  }

  function closePaywall() {
    var el = document.querySelector('.pw-modal');
    if (!el) return;
    var parent = el.parentNode;
    if (parent) parent.removeChild(el);
    try { document.body.classList.remove('pw-modal-open'); } catch (e) { /* 忽略 */ }
  }

  var escBound = false;
  function bindEsc() {
    if (escBound || typeof document === 'undefined') return;
    escBound = true;
    try {
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' || ev.keyCode === 27) closePaywall();
      });
    } catch (e) { /* 忽略 */ }
  }

  function openPaywall(opts) {
    if (typeof document === 'undefined') return null;
    var featureKey = (opts && opts.feature) ? String(opts.feature) : 'R-03';
    closePaywall();
    bindEsc();
    var host = document.createElement('div');
    host.innerHTML = overlayHtml(featureKey);
    var el = host.firstChild;
    document.body.appendChild(el);
    try { document.body.classList.add('pw-modal-open'); } catch (e) { /* 忽略 */ }
    // 弹层挂在 body 上，不在会员页 rootEl 内，所以单独绑自己的关闭事件。
    el.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t.closest && t.closest('[data-close-paywall]')) { closePaywall(); return; }
      if (t === el) closePaywall();
    });
    var closeBtn = el.querySelector('[data-close-paywall]');
    if (closeBtn && closeBtn.focus) closeBtn.focus();
    return el;
  }

  function bind(rootEl) {
    if (!rootEl || rootEl.__pwBound) return;
    rootEl.__pwBound = true;
    rootEl.addEventListener('click', function (ev) {
      var t = ev.target;
      var setBtn = t.closest ? t.closest('[data-set-tier]') : null;
      if (setBtn) {
        var id = setBtn.getAttribute('data-set-tier');
        setTier(id);
        mountPage();
        return;
      }
      var openBtn = t.closest ? t.closest('[data-paywall-preview]') : null;
      if (openBtn) {
        openPaywall({ feature: openBtn.getAttribute('data-paywall-preview') });
        return;
      }
    });
    bindEsc();
  }

  // 真页挂载：只填会员页里的容器，不重写整页，静态说明与免责留在 HTML 里。
  function mountPage() {
    if (typeof document === 'undefined') return;
    var cur = currentTier();
    var ct = tierById(cur) || tierById(DEFAULT_TIER);
    var rows = visibleMatrix();
    var on = rows.filter(function (r) { return canUseAt(r.id, cur); }).length;

    var nowEl = document.getElementById('pw-current');
    if (nowEl) nowEl.textContent = ct.name;
    var availEl = document.getElementById('pw-avail');
    if (availEl) availEl.textContent = '本档可用 ' + on + ' / ' + rows.length + ' 项';

    var cards = document.getElementById('pw-cards');
    if (cards) cards.innerHTML = cardsHtml();
    var matrix = document.getElementById('pw-matrix');
    if (matrix) matrix.innerHTML = matrixHtml();
    var note = document.getElementById('pw-matrix-note');
    if (note) note.textContent = STATUS_NOTE;

    var sw = document.getElementById('pw-switch');
    if (sw) {
      var dev = query('dev') === '1';
      sw.innerHTML = dev ? switchInnerHtml() : '';
      sw.hidden = !dev;
    }

    var rootEl = document.getElementById('pw-root') || document.body;
    bind(rootEl);
  }

  function render(rootEl, opts) {
    if (!rootEl) return;
    if (opts && opts.page) {
      if (typeof document !== 'undefined' && document.getElementById('pw-cards')) {
        mountPage();
        return;
      }
      rootEl.innerHTML = pageHtml();
      bind(rootEl);
      return;
    }
    rootEl.innerHTML = overlayHtml((opts && opts.feature) || 'R-03');
  }

  function mount(rootEl, opts) {
    if (!rootEl) return;
    if (opts && opts.page) { mountPage(); return; }
    render(rootEl, opts || { page: true });
  }

  function audit() {
    var rows = visibleMatrix().map(function (r) {
      return {
        id: r.id,
        label: r.label,
        cells: { free: r.free, basic: r.basic, pro: r.pro },
        canUse: {
          free: canUseAt(r.id, 'free'),
          basic: canUseAt(r.id, 'basic'),
          pro: canUseAt(r.id, 'pro')
        }
      };
    });
    var excluded = MATRIX.filter(function (r) { return r.excluded; }).map(function (r) {
      return { id: r.id, canUse: { free: false, basic: false, pro: false } };
    });
    return {
      total: MATRIX.length,
      visible: rows.length,
      excluded: excluded.length,
      freeComplete: freeComplete(),
      rows: rows,
      excludedRows: excluded
    };
  }

  return {
    VERSION: VERSION,
    DISCLAIMER: DISCLAIMER,
    MODAL_DISCLAIMER: MODAL_DISCLAIMER,
    FOOT_DISCLAIMER: FOOT_DISCLAIMER,
    STORE_KEY: STORE_KEY,
    STATUS_NOTE: STATUS_NOTE,
    PAGE_KEYS: PAGE_KEYS,
    TIERS: TIERS,
    MATRIX: MATRIX,
    tier: currentTier,
    setTier: setTier,
    tiers: function () { return TIERS.slice(); },
    matrix: function () { return MATRIX.slice(); },
    visibleMatrix: visibleMatrix,
    cellAt: cellAt,
    canUse: canUse,
    canUseAt: canUseAt,
    freeComplete: freeComplete,
    requiredTier: requiredTier,
    check: check,
    audit: audit,
    openPaywall: openPaywall,
    closePaywall: closePaywall,
    mount: mount,
    mountPage: mountPage,
    render: render,
    _pageHtml: pageHtml,
    _modalHtml: overlayHtml
  };
});
