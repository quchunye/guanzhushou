// ledger.js —— 账本合并（纯函数，前端 localStorage / 后端 node 均可复用）
//
// 解决的问题：用户每次上传的交割单截图覆盖区间不一致（今天传 3 周、明天传当天），
// 重叠部分若不合并，同一笔交易会被重复计入，导致"违规次数/最常违规"等跨期统计虚高。
//
// 去重键 = 日期 + 时间(秒) + 标的(代码优先,无则名称) + 方向 + 价格 + 数量（五要素）
// 券商 APP 截图普遍没有成交编号/流水号，只能靠五要素拼接；
// 但 OCR 会错字（如"示例环保"识别成"湖南发服"），因此加一层模糊匹配容错。
//
// 原则：
// 1. 幂等——同一批数据反复导入，账本条数不变；
// 2. 不静默丢数据——模糊判定为重复时写入 dupLog，便于人工核对；
// 3. 只做合并与统计，不做判定（判定仍走 rules.js）。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const PRICE_REL_TOL = 0.01; // 价格相对容差 1%
  const TIME_TOL_SEC = 2;    // 时间秒差容差：OCR 偶尔吞秒
  const NAME_EDIT_TOL = 1;   // 名称编辑距离容差：允许 1 个字符错识

  // ---------- 基础归整 ----------
  function normDate(v) {
    const s = String(v || '');
    const d = s.replace(/[^\d]/g, '');
    if (d.length === 8) return d;
    if (d.length === 6) return '20' + d;
    return d;
  }

  function normTime(v) {
    const s = String(v || '');
    const d = s.replace(/[^\d]/g, '');
    if (!d) return '';
    return d.padEnd(6, '0').slice(0, 6);
  }

  function timeToSec(t) {
    const s = normTime(t);
    if (!s || s.length !== 6) return null;
    const h = +s.slice(0, 2), m = +s.slice(2, 4), sec = +s.slice(4, 6);
    if (h > 23 || m > 59 || sec > 60) return null;
    return h * 3600 + m * 60 + sec;
  }

  function normPrice(v) {
    const n = +v;
    return isFinite(n) && n > 0 ? n : null;
  }

  function normQty(v) {
    const n = Math.round(+v);
    return isFinite(n) && n > 0 ? n : null;
  }

  function normalizeTrade(t) {
    return {
      date: normDate(t.date),
      time: normTime(t.time),
      code: String(t.code || '').trim(),
      name: String(t.name || '').trim(),
      side: t.side === '卖' ? '卖' : (t.side === '买' ? '买' : String(t.side || '').trim()),
      price: normPrice(t.price),
      qty: normQty(t.qty),
      // 批次 E-23：account 默认空串；老数据由 migrateV2 填 'default'
      account: String(t.account || ''),
    };
  }

  // 展示/统计口径：空账号视作未迁移的老数据 → default（不改变 tradeKey 本身）
  function accountOf(t) {
    return String((t && t.account) || '') || 'default';
  }

  function accounts(ledger) {
    const seen = Object.create(null);
    ((ledger && ledger.trades) || []).forEach(function (t) { seen[accountOf(t)] = 1; });
    return Object.keys(seen).sort();
  }

  function isUsable(t) {
    return t && t.date && t.side && t.price !== null && t.qty !== null
      && (t.code || t.name);
  }

  // ---------- 精确键 ----------
  function tradeKey(t) {
    const n = normalizeTrade(t);
    const id = n.code || n.name;
    // 批次 E-23：date8|time6|code||name|side|price3|qty|account
    return [n.date, n.time, id, n.side, n.price.toFixed(3), n.qty, n.account].join('|');
  }

  // ---------- 模糊匹配 ----------
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, function (_, i) { return i; });
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function nameSimilar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 2 && b.length >= 2 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) return true;
    return levenshtein(a, b) <= NAME_EDIT_TOL;
  }

  function isSameTrade(a, b) {
    const x = normalizeTrade(a), y = normalizeTrade(b);
    // 批次 E-23：不同账户绝不合并（必须先比 account，再做其余容错）
    if (x.account !== y.account) return false;
    if (x.date !== y.date) return false;
    if (x.side !== y.side) return false;
    if (x.qty !== y.qty) return false;
    if (!nameSimilar(x.code || x.name, y.code || y.name)) return false;

    const sx = timeToSec(x.time), sy = timeToSec(y.time);
    if (sx !== null && sy !== null) {
      if (Math.abs(sx - sy) > TIME_TOL_SEC) return false;
    } else if (x.time !== y.time) {
      return false;
    }

    const diff = Math.abs(x.price - y.price) / Math.max(x.price, y.price);
    return diff <= PRICE_REL_TOL;
  }

  // ---------- 合并 ----------
  function mergeTrades(existing, incoming, opts) {
    opts = opts || {};
    const base = existing && Array.isArray(existing.trades) ? existing.trades : [];
    const out = {
      trades: base.map(function (t) { return Object.assign({}, t); }),
      imports: (existing && existing.imports ? existing.imports : []).slice(),
      dupLog: [],
    };

    // 安全网：本机账本已经迁移过（存在非空 account），但新数据没带 account（例如 asset flag 关了）
    // 时，把新数据视作 default，避免同一笔被当成新笔重复入库。不同显式 account 仍绝不合并。
    const baseHasAccount = out.trades.some(function (t) { return String(t.account || ''); });

    const exact = {};
    out.trades.forEach(function (t, i) {
      try { exact[tradeKey(t)] = i; } catch (e) { /* 脏数据跳过索引 */ }
    });

    let added = 0, dup = 0;
    const importId = opts.importId || String(Date.now());
    const now = opts.now || new Date().toISOString();
    const seenThisBatch = {};

    (incoming || []).forEach(function (raw) {
      const t = normalizeTrade(raw);
      if (baseHasAccount && !t.account) t.account = 'default';
      if (!isUsable(t)) return;
      const k = tradeKey(t);

      if (seenThisBatch[k]) { dup++; return; }
      if (exact[k] !== undefined) { dup++; seenThisBatch[k] = 1; return; }

      const near = out.trades.filter(function (e) { return isSameTrade(e, t); })[0];
      if (near) {
        near.lastSeen = now;
        out.dupLog.push({ incoming: t, matchedKey: tradeKey(near), reason: 'fuzzy_name_or_time' });
        dup++; seenThisBatch[k] = 1; return;
      }

      const rec = Object.assign({}, t, { firstSeen: now, lastSeen: now, importId: importId });
      out.trades.push(rec);
      exact[k] = out.trades.length - 1;
      seenThisBatch[k] = 1;
      added++;
    });

    const dates = out.trades.map(function (t) { return t.date; }).filter(Boolean).sort();
    out.imports.push({
      id: importId, at: now,
      imported: (incoming || []).length, added: added, dup: dup,
      coverageFrom: dates.length ? dates[0] : '',
      coverageTo: dates.length ? dates[dates.length - 1] : '',
    });
    if (out.imports.length > 200) out.imports = out.imports.slice(-200);

    return { ledger: out, added: added, dup: dup };
  }

  // ---------- 统计 ----------
  // opts.account 非空时只统计该账户（空 account 的老数据视作 default）
  function summarize(ledger, opts) {
    const all = (ledger && ledger.trades) ? ledger.trades : [];
    const want = opts && opts.account ? String(opts.account) : '';
    const trades = want ? all.filter(function (t) { return accountOf(t) === want; }) : all;
    const dates = trades.map(function (t) { return t.date; }).filter(Boolean).sort();
    const byDate = {};
    trades.forEach(function (t) { byDate[t.date] = (byDate[t.date] || 0) + 1; });

    let spanDays = 0;
    if (dates.length) {
      const a = dates[0], b = dates[dates.length - 1];
      const da = new Date(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8));
      const db = new Date(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
      spanDays = Math.round((db - da) / 86400000) + 1;
    }

    const imports = (ledger && ledger.imports) ? ledger.imports : [];
    return {
      total: trades.length,
      coverageFrom: dates.length ? dates[0] : '',
      coverageTo: dates.length ? dates[dates.length - 1] : '',
      spanDays: spanDays,
      tradeDays: Object.keys(byDate).length,
      byDate: byDate,
      importCount: imports.length,
      lastImport: imports.length ? imports[imports.length - 1] : null,
    };
  }

  return {
    normalizeTrade: normalizeTrade,
    tradeKey: tradeKey,
    isSameTrade: isSameTrade,
    mergeTrades: mergeTrades,
    summarize: summarize,
    accountOf: accountOf,
    accounts: accounts,
    _internal: { levenshtein: levenshtein, nameSimilar: nameSimilar, normDate: normDate, normTime: normTime, timeToSec: timeToSec },
  };
});
