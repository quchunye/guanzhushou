// store.js —— localStorage 键常量与安全读写（批次 0 地基）
//
// 只做三件事：键表、安全读写、配额保护。
// 不碰业务逻辑；业务模块通过 PanjiStore.get/set 访问，避免各处散落字符串。
//
// 兼容：浏览器挂 window.PanjiStore；Node 测试走 module.exports。
// 注意：factory 必须接收 root。批次 0 原版漏传，浏览器里 root 为 undefined，
// root.localStorage 的 TypeError 被 try/catch 吞掉 → set() 恒返回 {ok:false,error:'no_storage'}，
// 把 B 批的 focus/note/reason/stop/mood 全卡死。与 recur.js 同一处 bug，照同一方式修。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.PanjiStore = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {

  const VERSION = 1;

  // 全局键表：新增 key 必须在这里登记，禁止在业务里裸写字符串
  const KEYS = {
    ledger: 'guanzhu_ledger',
    caseSeq: 'guanzhu_case_seq',
    casePrefix: 'guanzhu_case_',
    rules: 'guanzhu_rules_v1',
    recur: 'guanzhu_recur_v1',
    exempt: 'guanzhu_exempt_v1',
    focus: 'guanzhu_focus_v1',
    note: 'guanzhu_note_v1',
    reason: 'guanzhu_reason_v1',
    stop: 'guanzhu_stop_v1',
    mood: 'guanzhu_mood_v1',
    rulesHist: 'guanzhu_rules_hist_v1',
    pos: 'guanzhu_pos_v1',
    cash: 'guanzhu_cash_v1',
    flags: 'guanzhu_flags_v1',
    uploadLayout: 'guanzhu_upload_layout_v1', // C 批 12 版式记忆
    recall: 'guanzhu_recall_v1',              // F 批 28 回归礼包状态
    flag_audit: 'guanzhu_flag_audit_v1',      // FG-1 开闸面板本机变更记录
    // 既有键（§2.1 未列，登记备查；写入点仍在 app.js，边界内不改）
    clientToken: 'guanzhu_client_token',      // 支付身份（批次 0 之前）
    pendingPay: 'guanzhu_pending_pay',        // 待支付快照（批次 0 之前）
    collection: 'guanzhu_collection_v1',      // COLL-1 图鉴收集解锁（只记复盘行为）
    ack: 'guanzhu_ack_v1',                    // 越线认下 + 改法登记（只存规则/日期/字数/哈希）
    ackTxt: 'guanzhu_ack_txt_v1',             // 改法原文（本机展示用，不进分享卡）
    openplan: 'guanzhu_openplan_v1',          // 未平仓跟踪计划（键为哈希，原文本机展示）
    month: 'guanzhu_month_v1',                // 月度复盘完成登记（只存月份/日期/笔数）
    wizardSeen: 'guanzhu_wizard_seen_v1',      // 首屏新手向导卡「已见过」标记（只存 1，不记行为）
    reviewArchivePrefix: 'guanzhu_review_archive_', // 按票建档：一只票一个档案（内含历次复盘数组）
    reviewQuota: 'guanzhu_review_quota_v1',    // 会员体验额度：3 只票的完整档案（本地，重装可重置）
  };

  // 允许测试注入替代 storage（Node 无 localStorage）
  let adapter = null;
  function storage() {
    if (adapter) return adapter;
    if (!root) return null;
    try { return root.localStorage; } catch (e) { return null; }
  }

  function getRaw(key) {
    const s = storage();
    if (!s) return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }

  function get(key, fallback) {
    const raw = getRaw(key);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  // 返回 {ok:true} 或 {ok:false, error:'quota'|'no_storage'|'write_failed'}
  function set(key, value) {
    const s = storage();
    if (!s) return { ok: false, error: 'no_storage' };
    try {
      s.setItem(key, JSON.stringify(value));
      return { ok: true };
    } catch (e) {
      const quota = (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014));
      return { ok: false, error: quota ? 'quota' : 'write_failed' };
    }
  }

  function remove(key) {
    const s = storage();
    if (!s) return false;
    try { s.removeItem(key); return true; } catch (e) { return false; }
  }

  function caseKey(n) {
    return KEYS.casePrefix + String(n).padStart(3, '0');
  }

  /* ---------- 按票建档（本轮只定结构，不做 UI） ----------
     一只票一个档案；reviews 按「票 + 交易日 + 账户」去重，同日同账户重做覆盖最后一次；
     同日不同账户各自保留、按账户兜底排序相邻排列；账户缺省为 ''（不猜、不补）。
     明确不存：金额、持仓、成交价。派生指标（如胜率）也不落盘，只存判定计数。
     换设备不同步、暂不导出：本模块不提供任何同步/导出接口。 */
  const ARCHIVE_SCHEMA = 'panji.review.archive.v1';
  const ARCHIVE_VERSION = 1;
  const ENTITLEMENT_DEFAULT = 'free'; // 免费层可完整做完一次复盘；完整档案（模板/表现/批注/买点对照）给体验额度或会员
  const QUOTA_SCHEMA = 'panji.review.quota.v1';
  const QUOTA_TOTAL = 3;              // 体验额度：3 只票的完整档案
  const TIERS = { free: 'free', trial: 'trial', member: 'member' };
  const REVIEW_SHAPE = {
    minute: 'minute',     // 有分钟扩展包（可做规则叠层）
    traded: 'traded',     // 有成交
    watching: 'watching', // 关注未买
    daily: 'daily',       // 只有日线
    empty: 'empty',
  };

  function bare6(code) {
    const s = String(code == null ? '' : code).replace(/\D/g, '');
    return s.length >= 6 ? s.slice(-6) : '';
  }

  // 账户缺省值：没有账户信息就写空串 ''，读侧不猜、不补。
  // 旧记录没有该字段，按空串参与主键比对；readArchive 不做迁移、不回写。
  const DEFAULT_ACCOUNT = '';
  function normAccount(v) {
    return String(v == null ? '' : v).trim();
  }

  function archiveKey(code) {
    const c = bare6(code);
    return c ? KEYS.reviewArchivePrefix + c : '';
  }

  function readArchive(code) {
    const k = archiveKey(code);
    if (!k) return null;
    const a = get(k, null);
    if (!a || a.schema !== ARCHIVE_SCHEMA || !Array.isArray(a.reviews)) return null;
    return a;
  }

  // rec: { code, name, day, account?, rules:{id,version,ids,byRule?}, counts:{consistent,inconsistent,undetermined},
  //        reviewedAt?, note?, source:{trades,watch,daily,minute} }
  function writeReview(rec) {
    const r = rec || {};
    const code = bare6(r.code);
    const day = String(r.day == null ? '' : r.day).replace(/\D/g, '').slice(0, 8);
    const account = normAccount(r.account);
    if (!code || !day) return { ok: false, error: 'bad_args' };
    const prev = readArchive(code);
    const reviews = prev ? prev.reviews.slice() : [];
    const c = r.counts || {};
    const s = r.source || {};
    const item = {
      day: day,
      account: account,
      rules: {
        id: String((r.rules && r.rules.id) || ''),
        version: Number((r.rules && r.rules.version) || ARCHIVE_VERSION),
        ids: ((r.rules && r.rules.ids) || []).map(String).slice(0, 32),
      },
      counts: {
        consistent: Math.max(0, Number(c.consistent || 0)),
        inconsistent: Math.max(0, Number(c.inconsistent || 0)),
        undetermined: Math.max(0, Number(c.undetermined || 0)),
      },
      reviewedAt: String(r.reviewedAt || new Date().toISOString()),
      note: String(r.note || '').slice(0, 500),
      source: {
        trades: Math.max(0, Number(s.trades || 0)),
        watch: !!s.watch,
        daily: !!s.daily,
        minute: (s.minute === 'builtin' || s.minute === 'import') ? s.minute : 'none',
      },
    };
    // 逐规则汇总由调用方算好，这里只做落盘；老存档没有该字段，不补算。
    const rawByRule = r.rules && r.rules.byRule;
    if (Array.isArray(rawByRule) && rawByRule.length) {
      item.rules.byRule = rawByRule.slice(0, 32).map((x) => ({
        id: String((x && x.id) || ''),
        consistent: Math.max(0, Number(x && x.consistent || 0)),
        inconsistent: Math.max(0, Number(x && x.inconsistent || 0)),
        undetermined: Math.max(0, Number(x && x.undetermined || 0)),
      }));
    }
    // 口径版本随记录落盘：老记录没有这两个字段，读侧按 legacy 处理，不回填。
    const cv = Number(r.rules && r.rules.calcVersion);
    if (isFinite(cv) && cv > 0) item.rules.calcVersion = cv;
    const rawSpec = r.rules && r.rules.calcSpec;
    if (rawSpec && typeof rawSpec === 'object') {
      const spec = {};
      const pct = Number(rawSpec.t05MaxPct);
      spec.t05MaxPct = isFinite(pct) ? pct : null;
      spec.t07Mode = String(rawSpec.t07Mode || '');
      spec.pack = String(rawSpec.pack || '');
      item.rules.calcSpec = spec;
    }
    // 主键 = day + account：同日同账户覆盖，同日不同账户各自保留。
    // 旧记录无 account 字段，按默认账户参与比对，因此不会被清掉；也不会被改写。
    const at = reviews.findIndex((x) => x && x.day === day && normAccount(x.account) === account);
    if (at >= 0) reviews[at] = item; else reviews.push(item);
    reviews.sort((a, b) => {
      if (a.day !== b.day) return a.day < b.day ? 1 : -1;
      const aa = normAccount(a.account), ab = normAccount(b.account);
      return aa < ab ? -1 : aa > ab ? 1 : 0;
    });
    const doc = {
      schema: ARCHIVE_SCHEMA,
      version: ARCHIVE_VERSION,
      code: code,
      name: String((prev && prev.name) || r.name || ''),
      updatedAt: new Date().toISOString(),
      entitlement: {
        tier: normalizeTier((r.entitlement && r.entitlement.tier) || r.tier || (prev && prev.entitlement && prev.entitlement.tier)),
        full: normalizeTier((r.entitlement && r.entitlement.tier) || r.tier || (prev && prev.entitlement && prev.entitlement.tier)) !== TIERS.free,
      },
      reviews: reviews,
    };
    const saved = set(archiveKey(code), doc);
    return saved && saved.ok ? { ok: true, archive: doc } : saved;
  }

  // 档案页版式：分钟扩展包 > 有成交 > 关注未买 > 只有日线 > 空
  function reviewShape(rec) {
    const s = (rec && rec.source) || {};
    if (s.minute && s.minute !== 'none') return REVIEW_SHAPE.minute;
    if (Number(s.trades || 0) > 0) return REVIEW_SHAPE.traded;
    if (s.watch) return REVIEW_SHAPE.watching;
    if (s.daily) return REVIEW_SHAPE.daily;
    return REVIEW_SHAPE.empty;
  }

  // 列表行的结果摘要：只从计数派生，不落盘派生指标
  function reviewSummary(rec) {
    const c = (rec && rec.counts) || {};
    if (Number(c.inconsistent || 0) > 0) return 'inconsistent';
    if (Number(c.undetermined || 0) > 0) return 'unknown';
    if (Number(c.consistent || 0) > 0) return 'consistent';
    return 'empty';
  }

  function allKeys() {
    const s = storage();
    if (!s) return [];
    try {
      if (typeof s.length === 'number' && typeof s.key === 'function') {
        const out = [];
        for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) out.push(k); }
        return out;
      }
      return Object.keys(s);
    } catch (e) { return []; }
  }

  // 历史列表：不另存一份，直接从各票档案派生，按复盘时间倒序
  function listReviews() {
    const pre = KEYS.reviewArchivePrefix;
    const rows = [];
    allKeys().forEach((k) => {
      if (String(k).indexOf(pre) !== 0) return;
      const a = get(k, null);
      if (!a || a.schema !== ARCHIVE_SCHEMA || !Array.isArray(a.reviews)) return;
      a.reviews.forEach((r) => {
        if (!r || !r.day) return;
        rows.push({
          code: a.code,
          name: a.name || '',
          day: r.day,
          account: normAccount(r.account),
          reviewedAt: r.reviewedAt || '',
          shape: reviewShape(r),
          summary: reviewSummary(r),
          counts: r.counts || { consistent: 0, inconsistent: 0, undetermined: 0 },
          tier: (a.entitlement && a.entitlement.tier) || ENTITLEMENT_DEFAULT,
          full: !!(a.entitlement && a.entitlement.full),
        });
      });
    });
    rows.sort((x, y) => {
      const ax = String(x.reviewedAt), ay = String(y.reviewedAt);
      if (ax !== ay) return ax < ay ? 1 : -1;
      if (String(y.day) > String(x.day)) return 1;
      if (String(y.day) < String(x.day)) return -1;
      const aa = normAccount(x.account), ab = normAccount(y.account);
      return aa < ab ? -1 : aa > ab ? 1 : 0;
    });
    return rows;
  }

  function normalizeTier(v) {
    const t = String(v || '').trim();
    return TIERS[t] ? t : ENTITLEMENT_DEFAULT;
  }

  /* ---------- 体验额度（本地记录，无支付、无账号、无服务端校验） ---------- */
  function readQuota() {
    const q = get(KEYS.reviewQuota, null);
    if (!q || q.schema !== QUOTA_SCHEMA || !Array.isArray(q.slots)) {
      return { schema: QUOTA_SCHEMA, total: QUOTA_TOTAL, slots: [], updatedAt: '' };
    }
    return { schema: QUOTA_SCHEMA, total: Number(q.total || QUOTA_TOTAL), slots: q.slots.slice(), updatedAt: q.updatedAt || '' };
  }

  // {total, used, remaining, slots}：剩余数从 slots 派生，不另存一份
  function quotaState() {
    const q = readQuota();
    const slots = q.slots.map(bare6).filter(Boolean);
    const total = Math.max(0, q.total);
    return { total: total, used: slots.length, remaining: Math.max(0, total - slots.length), slots: slots };
  }

  // 占用一个体验票位；免费的单票单日复盘与历史列表不受影响
  function claimQuota(code) {
    const c6 = bare6(code);
    if (!c6) return { ok: false, error: 'bad_args' };
    const q = readQuota();
    const slots = q.slots.map(bare6).filter(Boolean);
    if (slots.indexOf(c6) >= 0) return { ok: true, already: true, quota: quotaState() };
    if (slots.length >= q.total) return { ok: false, error: 'quota_full', quota: quotaState() };
    slots.push(c6);
    const doc = { schema: QUOTA_SCHEMA, total: q.total, slots: slots, updatedAt: new Date().toISOString() };
    const saved = set(KEYS.reviewQuota, doc);
    return saved && saved.ok ? { ok: true, quota: quotaState() } : saved;
  }

  // 切换某票档案的档位（free=基础版 / trial=体验额度 / member=会员解锁）
  function setArchiveTier(code, tier) {
    const a = readArchive(code);
    if (!a) return { ok: false, error: 'no_archive' };
    const t = normalizeTier(tier);
    const doc = a;
    doc.entitlement = { tier: t, full: t !== TIERS.free };
    doc.updatedAt = new Date().toISOString();
    const saved = set(archiveKey(code), doc);
    return saved && saved.ok ? { ok: true, archive: doc } : saved;
  }

  function configure(opts) {
    adapter = opts && opts.storage ? opts.storage : null;
  }

  return {
    VERSION,
    KEYS,
    ARCHIVE_SCHEMA,
    ARCHIVE_VERSION,
    DEFAULT_ACCOUNT,
    normAccount,
    REVIEW_SHAPE,
    QUOTA_SCHEMA,
    QUOTA_TOTAL,
    TIERS,
    getRaw,
    get,
    set,
    remove,
    caseKey,
    archiveKey,
    readArchive,
    writeReview,
    reviewShape,
    reviewSummary,
    listReviews,
    quotaState,
    claimQuota,
    setArchiveTier,
    configure,
  };
});
