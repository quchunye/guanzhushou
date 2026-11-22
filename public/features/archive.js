/* 个股档案页（P2）
   一只票一个档案：同一只票的所有复盘挂在这一页，按交易日倒序。
   页面展示的一切都从档案里已有的字段派生（day / rules / counts / reviewedAt / note / source / entitlement），
   不新增字段，不存金额、持仓、成交价、胜率。
   免费层能看到完整档案页（复盘次数、规则判定计数、最新记录）；会员（体验额度 / 会员）解锁完整时间线、
   跨日期对比与导出位。不提供同步、导出、支付、账号接口。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PanjiArchive = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {

  const TIERS = { free: 'free', trial: 'trial', member: 'member' };
  // 锁档动画只在本次会话第一次渲染锁定块时播一遍；播完（或降级兜底）后重渲染直接给末帧。
  let uvPlayed = false;
  const SHAPE_LABEL = {
    minute: '分钟扩展包',
    traded: '有成交',
    watching: '关注未买',
    daily: '仅日线',
    empty: '暂无数据',
  };
  const SUMMARY_LABEL = {
    consistent: '一致',
    inconsistent: '有违规',
    unknown: '无法判断',
    empty: '无判定',
  };
  const STATE_CLS = {
    consistent: 'ok',
    inconsistent: 'bad',
    unknown: 'warn',
    empty: 'na',
  };

  // 规则元数据：顺序与 server/rules.js 的 TEMPLATES 一致；读侧只做展示，不参与判定。
  // 五组是展示分组，组内仍按 T 编号排。
  const RULE_META = [
    { id: 'T01', short: '开盘冷静期', group: '时间纪律' },
    { id: 'T02', short: '收盘前禁买', group: '时间纪律' },
    { id: 'T03', short: '追当日最高', group: '追高与补仓' },
    { id: 'T04', short: '不越跌越补', group: '追高与补仓' },
    { id: 'T05', short: '单笔重仓', group: '仓位上限' },
    { id: 'T06', short: '笔数超限', group: '频次与集中度' },
    { id: 'T07', short: '来回折腾', group: '频次与集中度' },
    { id: 'T08', short: '铺得太散', group: '频次与集中度' },
    { id: 'T09', short: '单票太重', group: '仓位上限' },
    { id: 'T10', short: '预算失守', group: '仓位上限' },
    { id: 'T11', short: '亏损超线', group: '亏损与前置' },
    { id: 'T12', short: '止损预案', group: '亏损与前置' },
    { id: 'T13', short: 'ST 也敢碰', group: '亏损与前置' },
  ];
  const PORTRAIT_GROUPS = ['时间纪律', '追高与补仓', '仓位上限', '频次与集中度', '亏损与前置'];

  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function bare6(v) {
    const s = digits(v);
    return s.length >= 6 ? s.slice(-6) : '';
  }
  function day8(v) { return digits(v).slice(0, 8); }
  function d10(day) {
    const d = day8(day);
    return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : '';
  }
  function hhmm(m) {
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function num(v) { const n = +v; return isFinite(n) && n > 0 ? n : 0; }

  function tierOf(archive) {
    const t = archive && archive.entitlement && archive.entitlement.tier;
    return TIERS[t] ? t : TIERS.free;
  }
  // license 档位只做展示映射；判定完全以 window.PJL_GATE 为准，档案页不自建档位。
  const LICENSE_TIER_LABEL = { deep: '深度档案', library: '资料库档案', panorama: '全景档案' };
  function tierLabel(tier) {
    if (tier === TIERS.member) return '会员档案';
    if (tier === TIERS.trial) return '体验档案';
    if (tier === TIERS.free) return '基础档案';
    return LICENSE_TIER_LABEL[tier] || '会员档案';
  }

  // 授权是唯一真相源：只读 window.PJL_GATE，不写、不猜、不自建第二套档位。
  function licenseGate() {
    const g = (typeof window !== 'undefined') ? window.PJL_GATE : null;
    if (!g || typeof g !== 'object') return null;
    if (g.ready === true) return g;
    // 若 ready 是 Promise，先回退，等它 resolve 后由页面重绘。
    return null;
  }

  // 状态 chip：档位名来自 license/回退；回退时追加「· 本地」，避免用户以为授权已生效。
  function tierBadge(p) {
    const tier = p ? p.tier : TIERS.free;
    const full = p ? !!p.full : false;
    let cls = 'free';
    if (p && p.gateSource === 'fallback' && tier === TIERS.trial) cls = 'trial';
    else if (full) cls = 'member';
    let label = tierLabel(tier);
    if (p && p.gateSource === 'fallback') label += ' · 本地';
    const title = (p && p.gateStatus) ? ' title="' + esc(p.gateStatus) + '"' : '';
    return '<span class="ac-tier ' + cls + '"' + title + '>' + esc(label) + '</span>';
  }

  function resolveGate(archive) {
    const g = licenseGate();
    if (g) {
      // 解锁账本只认 stock: 命名空间；归一化统一走 PJL_GATE.normalizeCode，档案页不自己写规则。
      // 裸码（600519 / 600519.SH）开闸后会被闸门判非法，用户付了钱也打不开。
      const raw = 'stock:' + String((archive && archive.code) || '');
      const code = typeof g.normalizeCode === 'function' ? String(g.normalizeCode(raw) || '') : raw;
      const canView = typeof g.canView === 'function' ? !!g.canView(code) : true;
      const canArchive = typeof g.canArchive === 'function' ? !!g.canArchive(code) : canView;
      return {
        source: 'license',
        tier: String(g.tier || TIERS.free),
        // 档案页只负责「看」：可见范围以 canView 为准；canArchive 留给写入侧，不在这里二次判。
        full: canView,
        canView: canView,
        canArchive: canArchive,
        status: typeof g.statusText === 'function' ? String(g.statusText() || '') : '',
      };
    }
    // 回退：license 未配置时沿用本地 entitlement（trial 首月保护继续有效）。
    const t = tierOf(archive);
    return {
      source: 'fallback',
      tier: t,
      full: t !== TIERS.free,
      canView: true,
      canArchive: t !== TIERS.free,
      status: '',
    };
  }

  function shapeOf(rec, store) {
    if (store && typeof store.reviewShape === 'function') return store.reviewShape(rec);
    const s = (rec && rec.source) || {};
    if (s.minute && s.minute !== 'none') return 'minute';
    if (num(s.trades) > 0) return 'traded';
    if (s.watch) return 'watching';
    if (s.daily) return 'daily';
    return 'empty';
  }
  function summaryOf(rec, store) {
    if (store && typeof store.reviewSummary === 'function') return store.reviewSummary(rec);
    const c = (rec && rec.counts) || {};
    if (num(c.inconsistent) > 0) return 'inconsistent';
    if (num(c.undetermined) > 0) return 'unknown';
    if (num(c.consistent) > 0) return 'consistent';
    return 'empty';
  }
  function countsOf(rec) {
    const c = (rec && rec.counts) || {};
    return {
      consistent: num(c.consistent),
      inconsistent: num(c.inconsistent),
      undetermined: num(c.undetermined),
    };
  }
  // 账户：缺字段一律按空串（默认账户），读侧不猜、不补、不回写。
  function accountOf(rec) {
    const v = rec && rec.account;
    return String(v == null ? '' : v).trim();
  }
  function accountLabel(acct) { return acct || '默认账户'; }
  function hasMultiAccount(list) {
    const set = {};
    (list || []).forEach((r) => { set[accountOf(r)] = 1; });
    return Object.keys(set).length > 1;
  }
  // 旧记录缺 account 字段（新写入恒为 ''），单账户档案也要把它标成「默认账户」。
  function isLegacyRec(rec) { return !!rec && rec.account === undefined; }
  function showAcct(rec, multi) { return !!multi || isLegacyRec(rec); }

  /* ---------- 从档案派生档案页所需的一切 ---------- */
  function deriveProfile(archive, opts) {
    const store = (opts && opts.store) || null;
    const gateInfo = (opts && opts.gate) || resolveGate(archive);
    const reviews = ((archive && archive.reviews) || []).slice();
    // 主键 = 交易日 + 账户：按日倒序；同日按复盘时间倒序；再按账户兜底，保证顺序稳定。
    reviews.sort((a, b) => {
      const da = day8(a && a.day), db = day8(b && b.day);
      if (da !== db) return da < db ? 1 : -1;
      const ra = String((a && a.reviewedAt) || ''), rb = String((b && b.reviewedAt) || '');
      if (ra !== rb) return ra < rb ? 1 : -1;
      const aa = accountOf(a), ab = accountOf(b);
      return aa < ab ? -1 : aa > ab ? 1 : 0;
    });
    const latest = reviews[0] || null;
    const totals = { consistent: 0, inconsistent: 0, undetermined: 0 };
    reviews.forEach((r) => {
      const c = countsOf(r);
      totals.consistent += c.consistent;
      totals.inconsistent += c.inconsistent;
      totals.undetermined += c.undetermined;
    });
    return {
      code: (archive && archive.code) || '',
      name: (archive && archive.name) || '',
      count: reviews.length,
      latest: latest,
      timeline: reviews,
      totals: totals,
      shape: latest ? shapeOf(latest, store) : 'empty',
      latestSummary: latest ? summaryOf(latest, store) : 'empty',
      tier: gateInfo.tier,
      full: !!gateInfo.full,
      canArchive: gateInfo.canArchive !== false,
      gateSource: gateInfo.source || 'fallback',
      gateStatus: gateInfo.status || '',
      updatedAt: (archive && archive.updatedAt) || '',
    };
  }

  /* ---------- 免费 / 会员可见范围（免费不整页拦，只锁深度） ---------- */
  function gate(profile) {
    const p = profile || {};
    // 可见/解锁只看 profile.full（由 license 或本地回退算出），不再用档位名比较。
    const full = p.full != null ? !!p.full : p.tier !== TIERS.free;
    const timeline = p.timeline || [];
    // 免费层按交易日解锁：最新交易日（含同日两个账户）全部可见，锁更早的交易日。
    const latestDay = timeline.length ? day8(timeline[0].day) : '';
    const visible = full ? timeline.slice() : timeline.filter((r) => day8(r.day) === latestDay);
    return {
      full: full,
      visible: visible,
      locked: full ? 0 : Math.max(0, timeline.length - visible.length),
      canCompare: full,
      canExport: full,
    };
  }

  /* ---------- 跨日期对比：从 counts 派生，不落地 ---------- */
  function comparison(profile) {
    const tl = (profile && profile.timeline) || [];
    return tl.map((r, i) => {
      const c = countsOf(r);
      const older = tl[i + 1];
      const oc = older ? countsOf(older) : null;
      // 同日不同账户不做「较前次」：跨账户比计数没有意义，显示「—」。
      const sameAccount = !!(older && accountOf(r) === accountOf(older));
      return {
        day: day8(r.day),
        account: accountOf(r),
        consistent: c.consistent,
        inconsistent: c.inconsistent,
        undetermined: c.undetermined,
        delta: sameAccount ? c.consistent - oc.consistent : null,
      };
    });
  }

  /* ---------- 观察窗口：由当天启用的规则 + 本机规则参数派生 ---------- */
  function paramOf(cfg, tid, key, def) {
    const list = (cfg && cfg.rules) || [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (String((r && (r.templateId || r.id)) || '') !== tid) continue;
      const v = r && r.params ? +(r.params[key]) : NaN;
      return isFinite(v) && v >= 0 ? v : def;
    }
    return def;
  }
  function windowsFor(latest, rulesCfg) {
    const ids = ((latest && latest.rules && latest.rules.ids) || []).map(String);
    const hasOpen = ids.indexOf('T01') >= 0;
    const hasClose = ids.indexOf('T02') >= 0;
    return [
      {
        id: 'T01', label: '开盘冷静期不下单', on: hasOpen,
        text: hasOpen ? '09:30–' + hhmm(570 + paramOf(rulesCfg, 'T01', 'waitMin', 30)) : '未启用',
      },
      {
        id: 'T02', label: '收盘前 ' + paramOf(rulesCfg, 'T02', 'endMin', 30) + ' 分钟内不新增买入', on: hasClose,
        text: hasClose ? hhmm(900 - paramOf(rulesCfg, 'T02', 'endMin', 30)) + '–15:00' : '未启用',
      },
    ];
  }

  /* ---------- 规则画像：只读 rules.byRule，缺失的老记录不回读交割单 ---------- */
  function byRuleOf(rec) {
    const a = rec && rec.rules && rec.rules.byRule;
    return Array.isArray(a) ? a : null;
  }

  // 口径版本：缺字段或 < 2 视为旧阈值计算。读侧只标注，不迁移、不回填、不重算。
  const OLD_CALC_NOTE = '该次按旧阈值计算，仅作参考。';
  function calcVersionOf(rec) {
    const v = rec && rec.rules && rec.rules.calcVersion;
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  function isOldCalc(rec) {
    const v = calcVersionOf(rec);
    return v == null || v < 2;
  }
  // 只有确实逐条记过规则的旧记录才需要「旧阈值」提示；完全没记 byRule 的另有文案。
  function calcNoteOf(rec) {
    return byRuleOf(rec) && isOldCalc(rec) ? OLD_CALC_NOTE : '';
  }

  function portrait(profile) {
    const timeline = (profile && profile.timeline) || [];
    const scanned = timeline.filter((r) => byRuleOf(r));
    const oldCount = timeline.length - scanned.length;
    const merged = {};
    scanned.forEach((rec) => {
      byRuleOf(rec).forEach((it) => {
        const id = String((it && it.id) || '');
        if (!id) return;
        if (!merged[id]) merged[id] = { id: id, consistent: 0, inconsistent: 0, undetermined: 0 };
        merged[id].consistent += num(it.consistent);
        merged[id].inconsistent += num(it.inconsistent);
        merged[id].undetermined += num(it.undetermined);
      });
    });
    const rules = RULE_META.filter((m) => merged[m.id]).map((m) => {
      const it = merged[m.id];
      return {
        id: m.id, short: m.short, group: m.group,
        consistent: it.consistent, inconsistent: it.inconsistent, undetermined: it.undetermined,
        judged: it.consistent + it.inconsistent + it.undetermined,
      };
    });
    const groups = PORTRAIT_GROUPS.map((name) => {
      const rows = rules.filter((r) => r.group === name);
      const counts = { consistent: 0, inconsistent: 0, undetermined: 0 };
      rows.forEach((r) => {
        counts.consistent += r.consistent;
        counts.inconsistent += r.inconsistent;
        counts.undetermined += r.undetermined;
      });
      return {
        name: name, rules: rows, counts: counts,
        judged: counts.consistent + counts.inconsistent + counts.undetermined,
      };
    });
    // 样本门槛按「不同交易日」算：同日两个账户只算 1 天，避免同一天互相放大。
    const days = [];
    scanned.forEach((r) => {
      const d = day8(r.day);
      if (d && days.indexOf(d) < 0) days.push(d);
    });
    // 可统计交易日 ≥2 且确有违规，才出"最主要的一条"；次数相同按 TEMPLATES 顺序取先。
    let top = null;
    if (days.length >= 2) {
      rules.forEach((r) => {
        if (r.inconsistent > 0 && (!top || r.inconsistent > top.inconsistent)) top = r;
      });
    }
    return { scanned: scanned.length, scannedDays: days.length, oldCount: oldCount, legacyCalc: scanned.filter(isOldCalc).length, rules: rules, groups: groups, top: top };
  }

  // 信息量下限：只铺有违规的组；从未触发的规则收成一句话，避免一屏全是零。
  function portraitLayout(pt) {
    const hitGroups = pt.groups.filter((g) => g.rules.length && g.counts.inconsistent > 0);
    // T12 只判被问过的成交（方案 B）：judged=0 表示这一天从没被问过，不能收进「从未触发」当结论。
    const calmRules = pt.rules.filter((r) => r.inconsistent === 0 && !(r.id === 'T12' && r.judged === 0));
    return { hitGroups: hitGroups, calmRules: calmRules };
  }

  /* ---------- 历史列表是索引：一行一票 ---------- */
  function groupRows(rows) {
    const map = {};
    (rows || []).forEach((r) => {
      if (!r || !r.code) return;
      const k = bare6(r.code);
      if (!k) return;
      let it = map[k];
      if (!it) {
        it = map[k] = {
          code: k, name: r.name || '', count: 0,
          latestDay: '', latestReviewedAt: '', summary: 'empty', shape: 'empty', tier: r.tier || 'free',
        };
      }
      it.count++;
      if (!r.name) it.name = it.name || '';
      else if (!it.name) it.name = r.name;
      const at = String(r.reviewedAt || '');
      const day = String(r.day || '');
      if (at > it.latestReviewedAt || (at === it.latestReviewedAt && day > it.latestDay) || (it.latestReviewedAt === '' && it.latestDay === '')) {
        it.latestReviewedAt = at;
        it.latestDay = day;
        it.summary = r.summary || 'empty';
        it.shape = r.shape || 'empty';
        it.tier = r.tier || it.tier;
        if (r.name) it.name = r.name;
      }
    });
    return Object.keys(map).map((k) => map[k]).sort((a, b) => {
      if (a.latestReviewedAt !== b.latestReviewedAt) return a.latestReviewedAt < b.latestReviewedAt ? 1 : -1;
      if (a.latestDay !== b.latestDay) return a.latestDay < b.latestDay ? 1 : -1;
      return a.code < b.code ? -1 : 1;
    });
  }

  /* ---------- 页面 ---------- */
  function archiveHref(code, name) {
    return 'archive.html?code=' + encodeURIComponent(bare6(code)) + (name ? '&name=' + encodeURIComponent(name) : '');
  }
  function reviewHref(code, day, acct) {
    const d = day8(day);
    const a = String(acct == null ? '' : acct).trim();
    return 'replay.html?f=train&tab=d&symbol=' + encodeURIComponent(bare6(code))
      + (d ? '&date=' + encodeURIComponent(d) : '')
      + (a ? '&acct=' + encodeURIComponent(a) : '');
  }

  function mount(el, opts) {
    if (!el) return null;
    const o = opts || {};
    const S = o.store || (root && root.PanjiStore);
    const RR = o.replayReview || (root && root.PanjiReplayReview);
    if (!S) {
      el.innerHTML = '<div class="ac-miss"><b>档案模块没加载</b>刷新页面再试。</div>';
      return null;
    }
    const q = o.query || {};
    const st = { code: bare6(q.symbol || q.code || ''), name: String(q.name || ''), day: day8(q.day || ''), acct: String(q.acct || ''), dir: null };
    const listEl = o.listEl || null;
    const qEl = o.queryEl || null;
    const sugEl = o.suggestEl || null;
    const backEl = o.backEl || null;
    let sugHits = [];

    function rulesCfg() {
      try { return S.get(S.KEYS.rules, null); } catch (e) { return null; }
    }

    function statsHtml(p) {
      const l = p.latest;
      const lc = countsOf(l);
      const lastDay = l ? day8(l.day) : '';
      return '<div class="ac-stats">'
        + '<div class="ac-stat"><span>已复盘</span><b>' + p.count + ' 次</b></div>'
        + '<div class="ac-stat"><span>最近一次</span><b>' + (lastDay ? lastDay.slice(4, 6) + '-' + lastDay.slice(6, 8) : '—') + '</b></div>'
        + '<div class="ac-stat"><span>最近判定</span><b class="' + (STATE_CLS[p.latestSummary] || '') + '">' + esc(SUMMARY_LABEL[p.latestSummary] || '无判定') + '</b></div>'
        + '</div>'
        + '<div class="ac-hits"><span>规则判定</span>'
        + '<em class="ok">符合 ' + lc.consistent + ' 笔</em>'
        + '<em class="bad">不一致 ' + lc.inconsistent + ' 笔</em>'
        + '<em class="warn">无法判断 ' + lc.undetermined + ' 笔</em></div>'
        + '<div class="ac-all"><span>累计</span>符合 ' + p.totals.consistent + ' 笔'
        + ' · 不一致 ' + p.totals.inconsistent + ' 笔 · 无法判断 ' + p.totals.undetermined + ' 笔</div>';
    }

    function windowsHtml(p) {
      const wins = windowsFor(p.latest, rulesCfg());
      return '<div class="ac-wins">' + wins.map((w) => '<div class="ac-win' + (w.on ? '' : ' off') + '">'
        + '<span>' + esc(w.label) + '</span><b>' + esc(w.text) + '</b></div>').join('') + '</div>';
    }

    function barHtml(c) {
      const total = c.consistent + c.inconsistent + c.undetermined;
      if (!total) return '<span class="ac-pbar"></span>';
      const w = (n) => ((n / total) * 100).toFixed(1) + '%';
      return '<span class="ac-pbar">'
        + (c.inconsistent ? '<i class="bad" style="width:' + w(c.inconsistent) + '"></i>' : '')
        + (c.consistent ? '<i class="ok" style="width:' + w(c.consistent) + '"></i>' : '')
        + (c.undetermined ? '<i class="warn" style="width:' + w(c.undetermined) + '"></i>' : '')
        + '</span>';
    }

    function portraitHtml(p) {
      const pt = portrait(p);
      const head = '<div class="ac-sec ac-portrait"><div class="ac-sec-h"><h2>规则画像</h2>'
        + '<span>' + (pt.scanned ? '基于 ' + pt.scanned + ' 次可统计的复盘' : '还没有逐条数据') + '</span></div>';
      if (!pt.scanned) {
        return head + '<p class="ac-pstate">再复盘 1 次就能生成这只票的规则画像。</p>'
          + (pt.oldCount ? '<p class="ac-empty">现有 ' + pt.oldCount
            + ' 次复盘属于早期记录：该次未记录逐条规则，画像未计入；记录都还在。</p>' : '')
          + '</div>';
      }
      let lead = '';
      if (pt.top) {
        lead = '<div class="ac-plead">这只票 ' + pt.scanned + ' 次复盘里，有 ' + pt.top.inconsistent
          + ' 次栽在「' + esc(pt.top.short) + '」。</div>';
      } else if ((pt.scannedDays || 0) < 2) {
        lead = '<p class="ac-pstate">同一天先算一次，隔日再复盘才能看出倾向。</p>';
      } else {
        lead = '<p class="ac-pstate">这 ' + pt.scannedDays + ' 个交易日里没有出现规则不一致，暂时看不出主要倾向。</p>';
      }
      const lay = portraitLayout(pt);
      const badTotal = pt.rules.reduce((n, r) => n + (+r.inconsistent || 0), 0);
      const groups = lay.hitGroups.map((g) => {
        return '<div class="ac-pgroup' + (pt.top && pt.top.group === g.name ? ' top' : '') + '">'
          + '<div class="ac-pg-h"><b>' + esc(g.name) + '</b>'
          + '<em><i class="bad">' + g.counts.inconsistent + '</i> 条规则不一致 / <i class="ok">' + g.counts.consistent
          + '</i> 条规则符合 / <i class="warn">' + g.counts.undetermined + '</i> 条规则未定</em></div>'
          + barHtml(g.counts)
          + g.rules.map((r) => '<div class="ac-prow' + (pt.top && pt.top.id === r.id ? ' top' : '') + '">'
            + '<span class="ac-pname">' + esc(r.short) + '</span>'
            + barHtml({ consistent: r.consistent, inconsistent: r.inconsistent, undetermined: r.undetermined })
            + '<span class="ac-pn"><i class="bad">' + r.inconsistent + '</i><i class="ok">' + r.consistent
            + '</i><i class="warn">' + r.undetermined + '</i></span></div>').join('')
          + '</div>';
      }).join('');
      const calm = lay.calmRules.length
        ? '<p class="ac-pcalm">' + (lay.hitGroups.length
          ? '其余 ' + lay.calmRules.length + ' 条已启用规则在这 ' + pt.scanned + ' 次复盘里没有触发规则不一致。'
          : '已启用的 ' + lay.calmRules.length + ' 条规则在这 ' + pt.scanned + ' 次复盘里都没有触发规则不一致。') + '</p>'
        : '';
      return head + lead
        + (pt.legacyCalc ? '<p class="ac-empty">' + OLD_CALC_NOTE + '</p>' : '')
        + groups
        + (lay.hitGroups.length
          ? '<p class="ac-pcalm">合计 ' + badTotal + ' 条规则不一致</p>'
            + '<p class="ac-pleg"><i class="bad"></i>条规则不一致 <i class="ok"></i>条规则符合 <i class="warn"></i>条规则无法判断</p>'
          : '')
        + calm
        + (pt.oldCount ? '<p class="ac-empty">另有 ' + pt.oldCount
          + ' 次复盘属于早期记录：该次未记录逐条规则，画像未计入；记录都还在。</p>' : '')
        + '</div>';
    }

    function recordHtml(p, g) {
      if (!p.count) {
        return '<div class="ac-sec"><h2>这只票的记录区</h2>'
          + '<p class="ac-empty">还没有复盘记录。回到规则复盘，做完一天后点「存进档案」。</p></div>';
      }
      const multi = hasMultiAccount(p.timeline);
      const noteMeta = (r) => esc(d10(r.day)) + (showAcct(r, multi) ? ' · ' + esc(accountLabel(accountOf(r))) : '');
      if (g.full) {
        const notes = p.timeline.filter((r) => r.note);
        return '<div class="ac-sec"><h2>这只票的记录区</h2>' + (notes.length
          ? notes.map((r) => '<div class="ac-note"><span>' + noteMeta(r) + '</span><p>' + esc(r.note) + '</p></div>').join('')
          : '<p class="ac-empty">还没有批注。存档时可以写一句。</p>') + '</div>';
      }
      return '<div class="ac-sec"><h2>这只票的记录区</h2>'
        + (p.latest.note
          ? '<div class="ac-note"><span>' + noteMeta(p.latest) + '</span><p>' + esc(p.latest.note) + '</p></div>'
          : '<p class="ac-empty">还没有批注。存档时可以写一句。</p>')
        + '</div>';
    }

    function timelineHtml(p, g) {
      const multi = hasMultiAccount(p.timeline);
      const rows = g.visible.map((r) => {
        const c = countsOf(r);
        const sm = summaryOf(r, S);
        const acct = accountOf(r);
        return '<div class="ac-tl-row"><button type="button" class="ac-tl-day" data-day="' + esc(day8(r.day)) + '" data-acct="' + esc(acct) + '">'
          + esc(d10(r.day)) + '</button>'
          + (showAcct(r, multi) ? '<span class="ac-acct">' + esc(accountLabel(acct)) + '</span>' : '')
          + '<span class="ac-tl-c"><em class="ok">符合 ' + c.consistent + ' 笔</em><em class="bad">不一致 ' + c.inconsistent + ' 笔</em><em class="warn">未定 ' + c.undetermined + ' 笔</em></span>'
          + '<span class="ac-chip ' + (STATE_CLS[sm] || 'na') + '">' + esc(SUMMARY_LABEL[sm] || '无判定') + '</span>'
          + '<a class="ac-tl-go" href="' + reviewHref(p.code, r.day, acct) + '">叠层 →</a>'
          + (byRuleOf(r) ? '' : '<span class="ac-old">这次复盘记录得比较早，当时还没记到具体规则。</span>')
          + (calcNoteOf(r) ? '<span class="ac-old">' + calcNoteOf(r) + '</span>' : '')
          + '</div>';
      }).join('');
      let lock = '';
      if (g.locked > 0) {
        const UV = root && root.PanjiUnviewable;
        if (UV) {
          lock = UV.lock(g.locked, !uvPlayed);
        } else {
          lock = '<div class="ac-lock"><b>还有 ' + g.locked + ' 次复盘</b>'
            + '<span>完整时间线与跨日期对比在会员档案里。免费层可以继续复盘，不受影响。</span></div>';
        }
      }
      lock += '<div class="ac-unlock-slot"></div>';
      return '<div class="ac-sec"><div class="ac-sec-h"><h2>复盘时间线</h2><span>按交易日倒序</span></div>'
        + (p.count ? rows + lock : '<p class="ac-empty">暂无记录。</p>') + '</div>';
    }

    function compareHtml(p, g) {
      if (!g.canCompare) {
        return '<div class="ac-sec"><h2>跨日期对比</h2><div class="ac-lock"><b>会员可见</b>'
          + '<span>把每次复盘的判定计数排在一起，看同一条规则在不同日期怎么走。</span></div></div>';
      }
      const multi = hasMultiAccount(p.timeline);
      const rows = comparison(p).map((r) => '<tr><td>' + esc(d10(r.day))
        + (showAcct(r, multi) ? ' <span class="ac-acct">' + esc(accountLabel(r.account)) + '</span>' : '') + '</td>'
        + '<td class="ok">' + r.consistent + '</td><td class="bad">' + r.inconsistent + '</td>'
        + '<td class="warn">' + r.undetermined + '</td>'
        + '<td>' + (r.delta == null ? '—' : (r.delta > 0 ? '+' + r.delta : String(r.delta))) + '</td></tr>').join('');
      return '<div class="ac-sec"><h2>跨日期对比</h2>'
        + '<table class="ac-cmp"><thead><tr><th>交易日</th><th>符合（笔）</th><th>不一致（笔）</th><th>未定（笔）</th><th>符合较前次（笔）</th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table></div>';
    }

    function exportHtml(g) {
      if (!g.canExport) {
        return '<div class="ac-sec"><h2>导出</h2><div class="ac-lock"><b>会员可见</b>'
          + '<span>导出入口已预留，当前版本未开放。</span></div></div>';
      }
      return '<div class="ac-sec"><h2>导出</h2>'
        + '<button type="button" class="ac-export" disabled>导出档案（未开放）</button>'
        + '<p class="ac-empty">导出接口留在会员层，本轮不实现；备份请走首页的「备份本机数据」。</p></div>';
    }

    function claimHtml(p) {
      if (p.full) return '';
      // 授权已接管时，解锁入口归 license，档案页不再提供本地体验位，避免两套档位并存。
      if (p.gateSource === 'license') return '';
      const q = S.quotaState();
      if (q.remaining <= 0) {
        return '<div class="ac-claimbox"><p>体验名额已用完（' + q.total + ' 只）。</p>'
          + '<p class="ac-empty">免费层仍可继续做任意票的单票单日复盘。</p></div>';
      }
      return '<div class="ac-claimbox"><button type="button" class="ac-claim" id="ac-claim">体验完整档案 · 本机剩余 ' + q.remaining + ' 只</button>'
        + '<p class="ac-empty">体验额度只解锁完整档案，不影响免费层继续复盘。</p></div>';
    }

    function shapeHtml(p) {
      if (!p.count) {
        return '<div class="ac-template"><b>这只票的档案还空着</b>'
          + '<p>档案不是列表平铺：同一只票的所有复盘都会挂在这一页，按交易日倒序。</p></div>';
      }
      const hint = {
        minute: '有分钟扩展包，可回到当天逐笔看记录。',
        traded: '这只票有成交记录，可回到当天的叠层。',
        watching: '关注未买：只有观察记录，没有成交。',
        daily: '只有日线：当天没有可叠层的分钟数据。',
        empty: '暂无本地数据。',
      }[p.shape] || '';
      return '<div class="ac-template"><span class="ac-shape">' + esc(SHAPE_LABEL[p.shape] || '') + '</span>'
        + '<p>' + esc(hint) + '</p>'
        + (p.latest ? '<a class="ac-tl-go" href="' + reviewHref(p.code, p.latest.day, accountOf(p.latest)) + '">回到 ' + esc(d10(p.latest.day)) + ' 的叠层 →</a>' : '')
        + '</div>';
    }

    function render() {
      if (!st.code) {
        el.innerHTML = '<div class="ac-sec"><div class="ac-empty-guide"><b>先打开一只票的档案</b>'
          + '<p>在上面输入代码或名称；也可以从下面的历史档案点进去。</p>'
          + '<p>从规则复盘页做完一天后点「存进档案」，这里就会多一条记录。</p></div></div>';
        renderList();
        return;
      }
      const archive = S.readArchive(st.code);
      const p = archive ? deriveProfile(archive, { store: S }) : null;
      if (p && p.name) st.name = p.name;
      const title = (p && p.name) || st.name || st.code;
      const g = p ? gate(p) : null;
      let html = '<div class="ac-prof">'
        + '<div class="ac-id"><b>' + esc(title) + '</b><span>' + esc(st.code) + '</span>'
        + tierBadge(p) + '</div>';
      if (p && p.count) {
        html += statsHtml(p) + windowsHtml(p) + '</div>' + portraitHtml(p) + shapeHtml(p) + recordHtml(p, g)
          + timelineHtml(p, g) + compareHtml(p, g) + exportHtml(g) + claimHtml(p);
      } else {
        html += '<div class="ac-stats"><div class="ac-stat"><span>已复盘</span><b>0 次</b></div>'
          + '<div class="ac-stat"><span>最近一次</span><b>—</b></div>'
          + '<div class="ac-stat"><span>最近判定</span><b>—</b></div></div>'
          + '<p class="ac-empty">没有这只票的档案。</p></div>' + portraitHtml({ timeline: [] }) + shapeHtml({ count: 0 });
      }
      el.innerHTML = html;
      // 授权状态就绪会再 render 一次；用「动画播完」而不是「渲染过」标记一次性，
      // 否则第二次渲染会把刚插入的动画节点换掉，动画一帧都看不到。
      if (!uvPlayed) {
        const art = el.querySelector('.ac-lock-art .uv-anim');
        if (art) {
          const mark = () => { uvPlayed = true; };
          const node = art.querySelector('.uv-lock') || art;
          node.addEventListener('animationend', mark, { once: true });
          setTimeout(mark, 800);
        }
      }
      if (root.PanjiArchiveUnlock) root.PanjiArchiveUnlock.mount(el.querySelector('.ac-unlock-slot'), st.code);
      // 返回第 4 个 tab 时带上这只票、交易日与账户，避免回来变成空状态或串账户。
      if (backEl && st.code) {
        const latest = p && p.latest;
        const bDay = st.day || (latest ? latest.day : '');
        const bAcct = st.day ? st.acct : (latest ? accountOf(latest) : '');
        backEl.href = reviewHref(st.code, bDay, bAcct);
      }
      const btn = el.querySelector('#ac-claim');
      if (btn) {
        btn.addEventListener('click', () => {
          const r = S.claimQuota(st.code);
          if (!r || !r.ok) {
            btn.disabled = true;
            btn.textContent = (r && r.error === 'quota_full') ? '体验名额已用完' : '暂时不能解锁';
            return;
          }
          S.setArchiveTier(st.code, S.TIERS.trial);
          render();
          renderList();
        });
      }
      const dayBtns = el.querySelectorAll('.ac-tl-day');
      dayBtns.forEach((b) => {
        b.addEventListener('click', () => {
          window.location.href = reviewHref(st.code, b.getAttribute('data-day'), b.getAttribute('data-acct'));
        });
      });
      renderList();
    }

    function renderList() {
      if (!listEl) return;
      const rows = groupRows(S.listReviews());
      if (!rows.length) {
        listEl.innerHTML = '<div class="ac-sec"><div class="ac-sec-h"><h2>历史档案</h2><span>一只票一行</span></div>'
          + '<p class="ac-empty">还没有任何档案。做完一次规则复盘并点「存进档案」后，这里会出现第一行。</p></div>';
        return;
      }
      listEl.innerHTML = '<div class="ac-sec"><div class="ac-sec-h"><h2>历史档案</h2><span>一只票一行 · 按最近复盘排</span></div>'
        + rows.map((r) => '<button type="button" class="ac-row' + (r.code === st.code ? ' on' : '') + '" data-code="' + esc(r.code) + '" data-name="' + esc(r.name) + '">'
          + '<span class="ac-row-n"><b>' + esc(r.name || r.code) + '</b><em>' + esc(r.code) + '</em></span>'
          + '<span class="ac-row-d">' + (r.latestDay ? esc(d10(r.latestDay)) : '—') + '</span>'
          + '<span class="ac-row-c">复盘 ' + r.count + ' 次</span>'
          + '<span class="ac-chip ' + (STATE_CLS[r.summary] || 'na') + '">' + esc(SUMMARY_LABEL[r.summary] || '无判定') + '</span>'
          + '</button>').join('') + '</div>';
      listEl.querySelectorAll('.ac-row').forEach((row) => {
        row.addEventListener('click', () => {
          st.code = row.getAttribute('data-code');
          st.name = row.getAttribute('data-name');
          st.day = '';
          st.acct = '';
          if (qEl) qEl.value = st.code + (st.name ? ' ' + st.name : '');
          render();
        });
      });
    }

    function renderSug(q) {
      if (!sugEl) return;
      const hits = RR ? RR.searchDir(st.dir || [], q, 8) : [];
      sugHits = hits;
      if (!q || !hits.length) { sugEl.hidden = true; sugEl.innerHTML = ''; return; }
      sugEl.innerHTML = hits.map((h) => '<button type="button" class="ac-hit" data-code="' + esc(h.code) + '" data-name="' + esc(h.name) + '">'
        + '<b>' + esc(h.code) + '</b><span>' + esc(h.name) + '</span></button>').join('');
      sugEl.hidden = false;
      sugEl.querySelectorAll('.ac-hit').forEach((hit) => {
        hit.addEventListener('click', () => {
          st.code = hit.getAttribute('data-code');
          st.name = hit.getAttribute('data-name');
          st.day = '';
          st.acct = '';
          if (qEl) qEl.value = st.code + (st.name ? ' ' + st.name : '');
          sugEl.hidden = true;
          render();
        });
      });
    }

    if (qEl) {
      qEl.addEventListener('input', () => {
        const v = qEl.value.trim();
        const c6 = bare6(v);
        if (c6 && /^\d{6}$/.test(v.replace(/\s.*$/, ''))) {
          st.code = c6; st.name = ''; st.day = ''; st.acct = ''; render();
        }
        if (!st.dir && RR) RR.loadDirectory().then((list) => { st.dir = list; renderSug(v); });
        else renderSug(v);
      });
      qEl.addEventListener('focus', () => {
        if (!st.dir && RR) RR.loadDirectory().then((list) => { st.dir = list; renderSug(qEl.value.trim()); });
      });
    }

    // license 的 ready 是异步 getter：就绪后必须重绘，不能只读一次就定死。
    if (root && root.PanjiLicenseUI && typeof root.PanjiLicenseUI.onChange === 'function') {
      root.PanjiLicenseUI.onChange(() => { if (el) render(); });
    }

    render();
    return {
      state: () => ({ code: st.code, name: st.name }),
      setSymbol(code, name) {
        st.code = bare6(code); st.name = String(name || ''); st.day = ''; st.acct = '';
        if (qEl) qEl.value = st.code + (st.name ? ' ' + st.name : '');
        render();
      },
      _derive: deriveProfile,
      _gate: gate,
    };
  }

  return {
    TIERS, SHAPE_LABEL, SUMMARY_LABEL, RULE_META, PORTRAIT_GROUPS,
    deriveProfile, gate, comparison, windowsFor, portrait, portraitLayout, byRuleOf, accountOf, groupRows,
    calcVersionOf, isOldCalc, calcNoteOf, OLD_CALC_NOTE,
    archiveHref, reviewHref, mount, licenseGate, resolveGate, tierBadge, isLegacyRec, showAcct,
  };
});
