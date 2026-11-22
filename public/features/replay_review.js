/* 规则复盘 · 第 4 个 tab（P1：单票单日 · 形态类规则叠层）
   判定不重算：直接读 case.verdict.lines。
   三态与数据覆盖先于叠层：无分片 / 无档案 / 未填本金 / 缺时间，一律判「无法判断」，不标「一致」。
   标的与数据的来源通过 opts.source 注入（默认内置分片；App 侧可替换为全市场源），
   渲染与判定共用同一套，不做两份。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PanjiReplayReview = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {

  /* ================= 常量 ================= */
  const FORM_RULES = ['T01', 'T02', 'T03', 'T04'];
  const CAPITAL_RULES = ['T05', 'T09', 'T10', 'T11'];
  const FORM_NAME = {
    T01: '开盘冷静期',
    T02: '收盘前禁买',
    T03: '不追当日最高',
    T04: '不越跌越补',
  };
  // 逐规则汇总与标签用的短名；顺序与 server/rules.js 的 TEMPLATES 一致（测试会锁死）。
  const RULE_ORDER = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13'];
  const SHORT_NAME = {
    T01: '冷静期', T02: '收盘前禁买', T03: '追高', T04: '不越跌越补', T05: '单笔超限',
    T06: '笔数超限', T07: '反复买卖', T08: '持股超限', T09: '单票超限', T10: '日额超限',
    T11: '亏损超线', T12: '止损预案', T13: 'ST',
  };
  const SESSION = { open: 570, close: 900 };
  const STATE_LABEL = {
    consistent: '一致',
    mismatch: '不一致',
    unknown: '无法判断',
    na: '不适用',
  };
  // 颜色只在 public/styles/rv-theme.css 的 --color-* 变量里定义一次；
  // 这里只登记变量名与兜底值，canvas 侧通过 getComputedStyle 读取，禁止再散写色值。
  const THEME_VARS = {
    bg: '--color-bg-chart',
    gridMajor: '--color-grid-major',
    gridMinor: '--color-grid-minor',
    gridAxis: '--color-grid-axis',
    textStrong: '--color-text-strong',
    text: '--color-text',
    textWeak: '--color-text-weak',
    accent: '--color-accent',
    up: '--color-candle-up-border',
    upBody: '--color-candle-up-body',
    down: '--color-candle-down-border',
    downBody: '--color-candle-down-body',
    candleRest: '--color-candle-rest-opacity',
    consistent: '--color-rule-consistent',
    consistentBg: '--color-rule-consistent-bg',
    consistentBorder: '--color-rule-consistent-border',
    inconsistent: '--color-rule-inconsistent',
    inconsistentBg: '--color-rule-inconsistent-bg',
    inconsistentBorder: '--color-rule-inconsistent-border',
    undetermined: '--color-rule-undetermined',
    undeterminedBg: '--color-rule-undetermined-bg',
    undeterminedBorder: '--color-rule-undetermined-border',
    crosshair: '--color-crosshair',
    upDim: '--color-up-dim',
    downDim: '--color-down-dim',
  };
  // 兜底值仅用于没有 CSS 环境的纯函数测试，页面上一律读变量。
  const THEME_FALLBACK = {
    bg: '#060b16',
    gridMajor: '#1a2740',
    gridMinor: '#101a2b',
    gridAxis: '#2c405d',
    textStrong: '#e6f1ff',
    text: '#b9cadc',
    textWeak: '#8598ad',
    accent: '#8fd8ff',
    up: '#ff6b5e',
    upBody: 'transparent',
    down: '#1c8f6a',
    downBody: '#1c8f6a',
    candleRest: '1',
    consistent: '#6ee0ff',
    consistentBg: '#0d2433',
    consistentBorder: '#2a5f7d',
    inconsistent: '#f59a3c',
    inconsistentBg: '#2a2011',
    inconsistentBorder: '#6b4a1c',
    undetermined: '#8a97a9',
    undeterminedBg: '#161c26',
    undeterminedBorder: '#38424f',
    crosshair: '#3a4e6b',
    upDim: '#b85048',
    downDim: '#177a5b',
  };
  // 状态 → 三态色名 + 图标（形态冗余：不允许只靠颜色区分）
  const STATE_COLOR = { consistent: 'consistent', mismatch: 'inconsistent', unknown: 'undetermined', na: 'undetermined' };
  const STATE_ICON = { consistent: '✓', mismatch: '✕', unknown: '?', na: '·' };
  // 兼容旧导出名：三态语义映射，不含具体色值
  const COLOR = { consistent: 'consistent', mismatch: 'inconsistent', unknown: 'undetermined', na: 'undetermined' };
  const DIR_URL = 'symbols.json';
  const PACKS = (typeof WeakMap === 'function') ? new WeakMap() : null;

  /* ================= 小工具 ================= */
  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function day8(v) { return digits(v).slice(0, 8); }
  function bareCode(v) {
    const s = digits(v);
    return s.length >= 6 ? s.slice(-6) : '';
  }
  function normSym(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (/^(sh|sz|bj)\d{6}$/.test(s)) return s.slice(-6);
    if (/^\d{6}$/.test(s)) return s;
    return '';
  }
  function minutes(hm) {
    const m = /^(\d{1,2}):?(\d{2})$/.exec(String(hm || '').trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function hhmm(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }
  function hm4(v) {
    const s = digits(v);
    if (s.length < 4) return '';
    const m = minutes(s.slice(-4));
    return m == null ? '' : hhmm(m);
  }
  function hmText(v) {
    const m = minutes(v);
    return m == null ? String(v || '') : hhmm(m);
  }
  function fmtPrice(v) {
    const n = +v;
    return isFinite(n) ? n.toFixed(2) : '—';
  }
  // hero 金额：带千分位、两位小数；0 一律写 0.00，不用 — 占位。
  function fmtHeroMoney(v) {
    const n = +v;
    const r = isFinite(n) ? Math.round(n * 100) / 100 : 0;
    if (r === 0) return '0.00';
    const abs = Math.abs(r).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (r > 0 ? '+' : '-') + abs;
  }
  // 金额只做标签：≥1 万折成「万」，不参与坐标。
  function fmtAmt(v) {
    const n = +v;
    if (!isFinite(n)) return '—';
    if (Math.abs(n) >= 10000) {
      const w = n / 10000;
      return (Math.abs(w) >= 10 ? w.toFixed(0) : w.toFixed(1)) + '万';
    }
    return String(Math.round(n));
  }
  function fmtPct(v) {
    const n = +v;
    if (!isFinite(n)) return '—';
    return n.toFixed(1) + '%';
  }
  // 读主题变量。el 传 canvas 时，绘图区内部的 token 重声明（如 --color-accent
  // 降级为 text-secondary）会一起生效——不写 if，靠 CSS 层做边界。
  function themeOf(el) {
    const out = {};
    Object.keys(THEME_FALLBACK).forEach((k) => { out[k] = THEME_FALLBACK[k]; });
    try {
      const doc = root && root.document;
      if (doc && doc.documentElement && typeof root.getComputedStyle === 'function') {
        const target = el || doc.documentElement;
        const cs = root.getComputedStyle(target);
        Object.keys(THEME_VARS).forEach((k) => {
          const v = String(cs.getPropertyValue(THEME_VARS[k]) || '').trim();
          if (v) out[k] = v;
        });
      }
    } catch (e) { /* 无 CSS 环境：用兜底值 */ }
    return out;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ================= 5 分钟聚合 ================= */
  // 输入 1 分钟 bars（{t,o,h,l,c,v}，t 为该分钟结束时刻），输出 5 分钟 bars，t 取该桶最后一分钟。
  function aggBars(bars, size) {
    const step = Math.max(1, +(size || 5));
    const out = [];
    let cur = null, key = '';
    (bars || []).forEach((b) => {
      const t = String(b && b.t || '');
      if (t.length < 12) return;
      const d = t.slice(0, 8), hm = t.slice(8, 12);
      const m = minutes(hm);
      if (m == null) return;
      // t 是分钟「结束时刻」：09:31–09:35 归同一桶，桶末 09:35
      const k = d + '|' + Math.floor((m - 1) / step);
      if (!cur || key !== k) {
        cur = { t: t, day: d, hm: hm, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0) };
        out.push(cur);
        key = k;
      } else {
        cur.t = t; cur.hm = hm;
        cur.h = Math.max(cur.h, +b.h);
        cur.l = Math.min(cur.l, +b.l);
        cur.c = +b.c;
        cur.v += +(b.v || 0);
      }
    });
    return out;
  }

  /* ================= 三态与覆盖 ================= */
  function splitRules(v) {
    return String(v || '').split('+').map((s) => s.trim()).filter(Boolean);
  }

  // input: { verdict, lines, barCount, bars, code, day }
  function evaluate(input) {
    const verdict = input && input.verdict;
    const lines = (input && input.lines) || [];
    const barCount = +(input && input.barCount || 0);
    const hasBars = barCount > 0;
    const barList = (input && input.bars) || [];
    const hasVerdict = !!(verdict && Array.isArray(verdict.rules) && Array.isArray(verdict.lines));
    const cfg = hasVerdict ? verdict.rules : [];
    const cfgIds = cfg.map((r) => r.id);
    const form = cfg.filter((r) => FORM_RULES.indexOf(r.id) >= 0);
    const formOff = FORM_RULES.filter((id) => cfgIds.indexOf(id) < 0);
    const other = cfg.filter((r) => FORM_RULES.indexOf(r.id) < 0 && CAPITAL_RULES.indexOf(r.id) < 0);
    const capitalCfg = cfg.filter((r) => CAPITAL_RULES.indexOf(r.id) >= 0);
    const pending = (verdict && verdict.pending_rules) || [];
    const missingCapital = !!(verdict && verdict.capital == null) && pending.length > 0;

    const buys = lines.filter((l) => l.side === '买').slice().sort((a, b) => {
      const ta = String(a.time || ''), tb = String(b.time || '');
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    const sells = lines.filter((l) => l.side === '卖');

    // T12 方案 B（20261108）：只判「在存档弹层里被问过的成交」。
    // 有键（null 或正数）= 问过 → 进判定；正数=已记录，null=未记录；
    // 无键 = 从没被问过（含历史交割单导入）→ 不进判定、不进分母。
    // 无 intent 环境（Node 测试 / 老档案）时一律「没问过」，等于不追溯。
    const stopOf = (function () {
      const fn = (input && typeof input.stopStatus === 'function') ? input.stopStatus
        : function (l) {
          const I = root && root.PanjiFeatures && root.PanjiFeatures.intent;
          if (!I || typeof I.stopStatus !== 'function') return { asked: false };
          return I.stopStatus(l);
        };
      return function (l) {
        try { return fn(l) || { asked: false }; } catch (e) { return { asked: false }; }
      };
    })();
    const t12 = (function () {
      const asked = buys.filter((b) => !!stopOf(b).asked);
      return { asked: asked.length, recorded: asked.filter((b) => !!stopOf(b).registered).length };
    })();
    const firstBuy = buys[0] || null;
    const buyCount = buys.length;
    const maxBuyPrice = buys.reduce((m, b) => Math.max(m, +b.price || 0), 0);
    const firstMin = firstBuy ? minutes(firstBuy.time) : null;

    // 分片覆盖：首末 1 分钟 bar 与固定交易时段比对（bar 的 t 是分钟结束时刻）
    const firstBarHm = barList.length ? hm4(barList[0] && barList[0].t) : '';
    const lastBarHm = barList.length ? hm4(barList[barList.length - 1] && barList[barList.length - 1].t) : '';
    const firstBarMin = minutes(firstBarHm), lastBarMin = minutes(lastBarHm);
    const missingOpen = firstBarMin != null && firstBarMin > SESSION.open + 5;
    const missingClose = lastBarMin != null && lastBarMin < SESSION.close - 5;

    // 每条动作的可判形态规则；同时给出「不适用 / 判不了」的明确理由
    function formFor(line) {
      const out = { ids: [], na: '', unknown: '' };
      if (!form.length) return out;
      if (line.side !== '买') return out;
      if (form.some((r) => r.id === 'T01')) out.ids.push('T01');
      if (form.some((r) => r.id === 'T02')) out.ids.push('T02');

      const t03 = form.find((r) => r.id === 'T03');
      if (t03) {
        if (buyCount < 2) {
          out.na = out.na || ('T03 需要当日≥2笔，今天只有 ' + buyCount + ' 笔');
        } else {
          const win = SESSION.open + (+(t03.params && t03.params.windowMin) || 0);
          const isFirst = line === firstBuy || (firstBuy && line.idx === firstBuy.idx);
          if (firstMin == null) {
            out.unknown = out.unknown || '首笔没有记时间，T03 无法判断是否在追高窗口内';
          } else if (firstMin > win) {
            out.na = out.na || ('首笔 ' + hm4(firstBuy.time) + ' 晚于追高窗口 ' + hhmm(win) + '，T03 不适用');
          } else if (+firstBuy.price < maxBuyPrice) {
            out.na = out.na || '首笔不是你当天买得最高的一笔，T03 不适用';
          } else if (isFirst) {
            out.ids.push('T03');
          } else {
            out.na = out.na || 'T03 只判定当日首笔';
          }
        }
      }

      const t04 = form.find((r) => r.id === 'T04');
      if (t04) {
        if (buyCount < 2) {
          out.na = out.na || ('T04 需要当日≥2笔，今天只有 ' + buyCount + ' 笔');
        } else if (firstBuy && (line === firstBuy || line.idx === firstBuy.idx)) {
          out.na = out.na || 'T04 以当日首笔为参照，首笔本身不适用';
        } else {
          out.ids.push('T04');
        }
      }
      return out;
    }

    const actions = lines.map((line) => {
      const ids = splitRules(line.rule);
      const formHit = ids.filter((id) => FORM_RULES.indexOf(id) >= 0);
      let state, why;
      if (line.flag === '违规') {
        state = 'mismatch';
        const t03Cond = formHit.indexOf('T03') >= 0 ? '：首笔必须落在开盘窗口内，且是你当天买得最高的一笔' : '';
        why = formHit.length
          ? ('触发 ' + formHit.join('+') + t03Cond)
          : ('触发 ' + (ids.join('+') || '已配置规则') + '（不在本页叠层的四条内）');
      } else if (!hasVerdict) {
        state = 'unknown'; why = '这一天没有档案判定';
      } else if (!hasBars) {
        state = 'unknown'; why = '本地没有这一天的分片，图上无法落点';
      } else if (!line.time) {
        state = 'unknown'; why = '这笔没有记时间，时间类规则无法判断';
      } else if (line.side !== '买') {
        state = 'na'; why = '这一笔不在 T01–T04 的判定范围内';
      } else if (!form.length) {
        state = 'unknown'; why = '没有勾选 T01–T04 中的任何一条';
      } else {
        const ap = formFor(line);
        if (ap.unknown) {
          state = 'unknown'; why = ap.unknown;
        } else if (!ap.ids.length) {
          state = 'na';
          why = ap.na || '这一笔不在 T01–T04 的适用范围内';
        } else if (missingCapital) {
          state = 'unknown';
          why = '未填本金：T05/T09/T10/T11 未判定，因此本页不给「一致」';
        } else {
          state = 'consistent';
          why = '已判定 ' + ap.ids.join('+');
        }
      }
      return {
        line: line, state: state, why: why, formIds: formHit,
        hm: hm4(line.time), price: +line.price,
      };
    });

    const anyMismatch = actions.some((a) => a.state === 'mismatch');
    const anyUnknown = actions.some((a) => a.state === 'unknown');
    const allNa = actions.length > 0 && actions.every((a) => a.state === 'na');
    let overall;
    if (!hasVerdict || !hasBars) overall = 'unknown';
    else if (!actions.length) overall = 'noActions';
    else if (anyMismatch) overall = 'mismatch';
    else if (anyUnknown || allNa) overall = 'unknown';
    else overall = 'consistent';

    // 覆盖说明（先于叠层展示）
    const notes = [];
    if (!hasBars) notes.push('本地没有这一天的 1 分钟分片，图上不画走势，也不给规则结论。');
    if (!hasVerdict) notes.push('这一天没有档案判定（交割单里没确认过），规则结论无法判断。');
    if (hasVerdict && !form.length) notes.push('你这份档案没有勾选 T01–T04，本页没有可叠层的形态规则。');
    if (hasVerdict && formOff.length) notes.push('未勾选：' + formOff.join('、') + '。');
    if (missingCapital) notes.push('未填本金：' + capitalCfg.map((r) => r.id).join('、') + ' 未判定，本页不给「一致」结论；资金轨没有分母，不画。');
    const noTime = lines.filter((l) => !l.time).length;
    if (noTime) notes.push('有 ' + noTime + ' 笔没有记时间，时间类规则无法判断。');
    if (hasBars && missingOpen && form.some((r) => r.id === 'T01')) {
      notes.push('当日分片从 ' + (firstBarHm || '—') + ' 开始，缺 09:30–09:35 早盘数据，T01 冷静期带仅示意，不构成完整覆盖。');
    }
    if (hasBars && missingClose && form.some((r) => r.id === 'T02')) {
      notes.push('当日分片到 ' + (lastBarHm || '—') + ' 结束，缺收盘前时段数据，T02 收盘前禁买带仅示意，不构成完整覆盖。');
    }

    // 资金轨入参：只读既有判定产物（本金、规则上限、逐笔），不新增判定逻辑。
    const acct = String((input && input.account != null) ? input.account : ((lines[0] && lines[0].account) || ''));
    const allLines = (verdict && Array.isArray(verdict.lines)) ? verdict.lines : lines;
    const capPct = { T05: 0, T09: 0, T10: 0, T11: 0 };
    capitalCfg.forEach((r) => {
      if (r && Object.prototype.hasOwnProperty.call(capPct, r.id)) capPct[r.id] = +((r.params && r.params.maxPct) || 0) || 0;
    });
    const openingPositions = (verdict && Array.isArray(verdict.opening_positions)) ? verdict.opening_positions : [];
    // 资金证据只算一次：byRule（数据层）与资金轨（画布层）共用同一份，画布认出的跨线不会在档案里漏记。
    const capitalEv = capitalEvidence({
      capital: (verdict && verdict.capital != null) ? +verdict.capital : 0,
      capPct: capPct, allLines: allLines, account: acct,
      day: day8(input && input.day), code: bareCode(input && input.code),
      openingPositions: openingPositions,
    });
    const noTimeBuys = buys.filter((b) => !b.time).length;
    if (noTimeBuys && (capPct.T05 > 0 || capPct.T09 > 0 || capPct.T10 > 0)) {
      notes.push('有 ' + noTimeBuys + ' 笔动作没有记时间，资金轨上落不下柱，占比只按其余笔算。');
    }

    // 逐规则汇总：一条规则在一次复盘里最多记 1 次，不按触发笔数累加。
    const ruleHits = (id) => lines.some((l) => splitRules(l.rule).indexOf(id) >= 0);
    function ruleState(id) {
      if (id === 'T12') {
        // 只看被问过的成交：无键 → 不判（返回空，不进分母）；有 null → 未记录；全正数 → 已记录。
        if (!t12.asked) return '';
        return t12.recorded === t12.asked ? 'consistent' : 'inconsistent';
      }
      if (ruleHits(id)) return 'inconsistent';
      if (!hasBars) return 'undetermined';
      if (id === 'T01' || id === 'T02') {
        if (!buys.length) return '';
        return buys.some((b) => !b.time) ? 'undetermined' : 'consistent';
      }
      if (id === 'T03') {
        if (buyCount < 2) return '';
        if (firstMin == null) return 'undetermined';
        const tpl = form.find((r) => r.id === 'T03');
        const win = SESSION.open + (+((tpl && tpl.params && tpl.params.windowMin) || 0));
        if (firstMin > win) return '';
        if (+firstBuy.price < maxBuyPrice) return '';
        return 'consistent';
      }
      if (id === 'T04') return buyCount >= 2 ? 'consistent' : '';
      if (id === 'T05' || id === 'T09' || id === 'T10') {
        if (!buys.length) return '';
        if (missingCapital) return 'undetermined';
        // 资金证据：T05 单笔超配置的 maxPct；T09/T10 累计跨线以证据里的首个 crossHm 为准。
        if (id === 'T05') return capitalEv.t05.over ? 'inconsistent' : 'consistent';
        const step = capitalEv.steps[id];
        if (!step) return 'undetermined';
        return step.crossHm ? 'inconsistent' : 'consistent';
      }
      if (id === 'T06' || id === 'T08') return buys.length ? 'consistent' : '';
      if (id === 'T07') {
        // 买入或卖出任一方向都要参与；只买不卖多次同样能判。
        return (buys.length || sells.length) ? 'consistent' : '';
      }
      if (id === 'T11') {
        if (!sells.length) return '';
        if (missingCapital) return 'undetermined';
        const wf = capitalEv.waterfall;
        if (!wf) return 'undetermined';
        if (wf.crossHm) return 'inconsistent';
        // 底仓不明时已实现亏损算不满，不能给「一致」
        return wf.unknown ? 'undetermined' : 'consistent';
      }
      if (id === 'T13') return buys.length ? 'consistent' : '';
      return '';
    }
    const orderOf = (id) => {
      const i = RULE_ORDER.indexOf(id);
      return i < 0 ? RULE_ORDER.length : i;
    };
    const byRule = cfgIds.slice()
      .sort((a, b) => orderOf(a) - orderOf(b))
      .map((id) => {
        const st = ruleState(id);
        const row = { id: id, consistent: 0, inconsistent: 0, undetermined: 0 };
        if (st === 'consistent' || st === 'inconsistent' || st === 'undetermined') row[st] = 1;
        return row;
      });

    // hero 数字：当日已实现 = FIFO 逐笔 pnl 直接求和（不新造算法、不抵扣）
    const sellRows = fifoSells(allLines, acct, day8(input && input.day), openingPositions);
    const netPnl = sellRows.reduce((sum, s) => sum + (+s.pnl || 0), 0);

    return {
      hasBars: hasBars, hasVerdict: hasVerdict, barCount: barCount,
      netPnl: netPnl, sellCount: sellRows.length,
      form: form, formOff: formOff, other: other, capitalCfg: capitalCfg,
      pending: pending, missingCapital: missingCapital,
      actions: actions, overall: overall, notes: notes, cfgIds: cfgIds,
      buyCount: buyCount, firstBuyPrice: firstBuy ? +firstBuy.price : 0,
      firstBuyHm: firstBuy ? hm4(firstBuy.time) : '',
      byRule: byRule,
      // T12 方案 B：分母与文案都读这一份，避免「判了 / 没判」两套口径。
      t12: t12,
      capital: (verdict && verdict.capital != null) ? +verdict.capital : null,
      // 资金轨只读既有判定产物：本金（唯一分母）、各资金规则的上限、账户与当日全账户逐笔。
      // capitalEv 同时喂给 byRule：数据层与画布层共用同一份证据。
      capitalEv: capitalEv,
      capPct: capPct, account: acct, day: day8(input && input.day),
      code: bareCode(input && input.code), allLines: allLines,
      openingPositions: openingPositions,
      coverage: {
        firstHm: firstBarHm, lastHm: lastBarHm,
        missingOpen: missingOpen, missingClose: missingClose,
      },
    };
  }

  /* ================= 档案 ================= */
  function readCases(store, injected) {
    if (Array.isArray(injected)) return injected.slice();
    let seq = 0;
    try { seq = +(store && store.getItem('guanzhu_case_seq') || 0); } catch (e) { seq = 0; }
    const out = [];
    for (let i = seq; i >= 1; i--) {
      let c = null;
      try { c = JSON.parse(store.getItem('guanzhu_case_' + String(i).padStart(3, '0')) || 'null'); } catch (e) { c = null; }
      if (!c || !c.verdict) break;
      out.push(c);
    }
    return out;
  }

  // 同日同票可能有多个账户，必须按账户分别取线；account 为空表示交割单未写账户。
  function linesFor(cases, code, day, account) {
    const d = day8(day), c6 = bareCode(code), acct = String(account == null ? '' : account);
    for (let i = 0; i < cases.length; i++) {
      const v = cases[i] && cases[i].verdict;
      if (!v || !Array.isArray(v.lines)) continue;
      const hit = v.lines.filter((l) => bareCode(l.code) === c6 && day8(l.date) === d
        && String(l.account || '') === acct);
      if (hit.length) return { verdict: v, lines: hit, holder: cases[i] };
    }
    return { verdict: null, lines: [], holder: null };
  }

  // 当日该票出现过的账户；'' 排在最前（无账户信息的老交割单）。
  function accountsFor(cases, code, day) {
    const d = day8(day), c6 = bareCode(code);
    const set = Object.create(null);
    (cases || []).forEach((c) => {
      const v = c && c.verdict;
      if (!v || !Array.isArray(v.lines)) return;
      v.lines.forEach((l) => {
        if (bareCode(l.code) === c6 && day8(l.date) === d) set[String(l.account || '')] = 1;
      });
    });
    return Object.keys(set).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  }

  // 档案里该票的「次数 / 天数」两个口径，文案要能把它们分开说。
  function archiveStat(arch) {
    const arr = (arch && arch.reviews) || [];
    const set = Object.create(null);
    arr.forEach((x) => { if (x && x.day) set[x.day] = 1; });
    return { times: arr.length, days: Object.keys(set).length };
  }

  // 同日同账户的那条记录；账户缺省为空串，读侧不猜不补。
  function archivedRec(arch, day, account) {
    const acct = String(account == null ? '' : account).trim();
    const arr = (arch && arch.reviews) || [];
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (x && x.day === day && String(x.account == null ? '' : x.account).trim() === acct) return x;
    }
    return null;
  }

  /* ================= 写档案（只在有结论的日子提供入口） ================= */
  // 计数只按这一天的动作判定派生，不存胜率等派生指标。
  function countsOfActions(ev) {
    const c = { consistent: 0, inconsistent: 0, undetermined: 0 };
    (ev.actions || []).forEach((a) => {
      if (a.state === 'consistent') c.consistent++;
      else if (a.state === 'mismatch') c.inconsistent++;
      else if (a.state === 'unknown') c.undetermined++;
    });
    return c;
  }
  function ledgerTradesOn(store, code, day) {
    if (!store) return 0;
    try {
      const led = JSON.parse(store.getItem('guanzhu_ledger') || 'null');
      const trades = (led && led.trades) || [];
      const c6 = bareCode(code), d8 = day8(day);
      return trades.filter((t) => bareCode(t && t.code) === c6 && day8(t && t.date) === d8).length;
    } catch (e) { return 0; }
  }
  function archiveHref(code, name, day, account) {
    const acct = String(account == null ? '' : account).trim();
    return 'archive.html?code=' + encodeURIComponent(bareCode(code))
      + (name ? '&name=' + encodeURIComponent(name) : '')
      + (day ? '&day=' + encodeURIComponent(day8(day)) : '')
      + (acct ? '&acct=' + encodeURIComponent(acct) : '');
  }

  /* ================= 默认数据源（内置分片；可整体替换） ================= */
  function packCacheOf(idx) {
    if (!PACKS) return {};
    if (!PACKS.has(idx)) PACKS.set(idx, {});
    return PACKS.get(idx);
  }

  function createBuiltinSource(o) {
    const R = o.replay;
    const idx = o.idx;
    const ticket = o.ticket;
    const packCache = packCacheOf(idx);
    const has = Object.create(null);
    (idx.symbols || []).forEach((s) => { has[bareCode(s.code)] = 1; });
    const lastWin = (idx.windows[idx.windows.length - 1] || {}).id || '';
    function pack(code, win) {
      if (!code || !win) return Promise.resolve(null);
      const k = code + '|' + win;
      if (Object.prototype.hasOwnProperty.call(packCache, k)) return Promise.resolve(packCache[k]);
      return R.loadBuiltinPack(code, win, { ticket: ticket }).then((p) => {
        packCache[k] = p;
        return p;
      });
    }
    return {
      symbols: (idx.symbols || []).map((s) => ({ code: bareCode(s.code), name: s.name || '' })),
      hasCode(code) { return !!has[bareCode(code)]; },
      loadDays(code) {
        if (!has[bareCode(code)]) return Promise.resolve([]);
        const wins = (idx.windows || []).map((w) => w.id);
        return Promise.all(wins.map((w) => pack(bareCode(code), w))).then((list) => {
          const set = Object.create(null);
          list.forEach((p) => { if (p) R.daysOf(p, 1).forEach((d) => { set[d] = 1; }); });
          return Object.keys(set).sort().reverse();
        });
      },
      loadDay(code, day) {
        const c6 = bareCode(code);
        if (!has[c6]) return Promise.resolve({ status: 'no-pack' });
        const win = R.builtinWindowOf(idx, day) || lastWin;
        return pack(c6, win).then((p) => {
          if (!p) return { status: 'no-pack' };
          const dp = R.dayPackOf(p, day);
          if (!dp) return { status: 'no-day' };
          return { status: 'ok', bars: dp.klines, name: dp.name, day: dp.day, timeframe: dp.timeframe, barMinutes: dp.barMinutes };
        });
      },
    };
  }

  /* ================= 名录（懒加载，只在搜索时取） ================= */
  let DIR_CACHE = null;
  let DIR_PROMISE = null;
  function loadDirectory() {
    if (DIR_CACHE) return Promise.resolve(DIR_CACHE);
    if (DIR_PROMISE) return DIR_PROMISE;
    const f = root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
    if (!f) return Promise.resolve(null);
    DIR_PROMISE = Promise.resolve(f(DIR_URL, { cache: 'force-cache' }))
      .then((r) => (r && r.ok ? r.json() : null))
      .then((obj) => {
        if (obj && Array.isArray(obj.symbols)) DIR_CACHE = obj.symbols;
        return DIR_CACHE;
      })
      .catch(() => null);
    return DIR_PROMISE;
  }
  function searchDir(list, q, limit) {
    const s = String(q || '').trim();
    if (!s) return [];
    const low = s.toLowerCase();
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const code = it.code || it[0];
      const name = it.name || it[1] || '';
      if (String(code).indexOf(low) >= 0 || String(name).toLowerCase().indexOf(low) >= 0) {
        out.push({ code: code, name: name });
        if (out.length >= (limit || 8)) break;
      }
    }
    return out;
  }

  /* ================= 画图 ================= */
  // 面板契约：390 价格常驻 195 + 间距 10 + 资金槽 57，占用/亏损只在槽内切换；≥768 恢复三面板。
  const PANEL_NAME = { price: '价格', fundUp: '占用', fundDown: '亏损' };
  // 标签上限：画布常驻只留最严重的那一个，其余进「规则」浮层 / 点元素弹小浮窗。
  function labelCaps() {
    return { price: 1, fund: 1, total: 1 };
  }

  function acctOf(l) { return String((l && l.account) || ''); }
  function lineAmt(l) {
    const p = +((l && l.price) || 0), q = +((l && l.qty) || 0);
    return (isFinite(p) && isFinite(q) && p > 0 && q > 0) ? p * q : 0;
  }
  function sortLines(list) {
    return (list || []).slice().sort((a, b) => {
      const ta = String((a && a.date) || '') + ' ' + String((a && a.time) || '');
      const tb = String((b && b.date) || '') + ' ' + String((b && b.time) || '');
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  }
  // 当前账户当日逐笔（跨标的）；T10 累计与 T11 复算都要用到。
  function acctDayLines(ev) {
    const d = day8(ev.day), acct = String(ev.account == null ? '' : ev.account);
    return sortLines((ev.allLines || []).filter((l) => l && day8(l.date) === d && acctOf(l) === acct));
  }
  // T11 逐笔已实现盈亏：按 rules.js 的 FIFO 口径在渲染侧复算，不新增判定逻辑。
  // 期初底仓与 rules.js 一样先入队（等同最早一笔动作），只在超出「期初 + 当日动作」时才标 unknown。
  function fifoSells(all, account, day, openings) {
    const rows = sortLines((all || []).filter((l) => l && acctOf(l) === account));
    const queues = Object.create(null);
    (openings || []).forEach((p) => {
      if (!p || acctOf(p) !== account) return;
      const sym = bareCode(p.code) || String(p.name || '');
      if (!sym) return;
      const q = queues[sym] || (queues[sym] = []);
      q.push({ qty: +(p.qty || 0), price: +(p.cost || 0) });
    });
    const out = [];
    rows.forEach((l) => {
      const sym = bareCode(l.code) || String(l.name || '');
      const q = queues[sym] || (queues[sym] = []);
      if (l.side === '买') {
        q.push({ qty: +(l.qty || 0), price: +(l.price || 0) });
        return;
      }
      if (l.side !== '卖') return;
      let need = +(l.qty || 0), cost = 0, matched = 0;
      while (need > 0 && q.length) {
        const h = q[0], take = Math.min(need, h.qty);
        cost += take * h.price; matched += take;
        h.qty -= take; need -= take;
        if (h.qty <= 0) q.shift();
      }
      if (day8(l.date) === day) {
        out.push({ hm: hm4(l.time), pnl: matched * (+(l.price || 0)) - cost, unknown: need > 0 });
      }
    });
    return out;
  }

  // 资金证据：T05 单笔截断、T09/T10 累计跨线、T11 已实现亏损跨线，只算一次。
  // evaluate 用它写 byRule（数据层），buildLayers 用它画资金轨（画布层），两边不会各算一套。
  function capitalEvidence(src) {
    const cap = +((src && src.capital) || 0);
    const pct = (src && src.capPct) || {};
    const out = { cap: cap, t05: { bars: [], over: false, overflow: false }, steps: { T09: null, T10: null }, waterfall: null };
    if (!(cap > 0)) return out;
    const rows = acctDayLines(src);
    const curCode = bareCode(src && src.code);
    const curBuys = rows.filter((l) => l.side === '买' && (!curCode || bareCode(l.code) === curCode));

    // T05 单笔柱：出方向的笔不画；同一分钟不合并（>3 笔才合并）。
    // over = 超过配置的 maxPct（判定用）；overflow = 超过本金 100%（仅供绘图截断）。
    if (pct.T05 > 0) {
      const groups = [], idxOf = Object.create(null);
      curBuys.forEach((l) => {
        const amt = lineAmt(l), hm = hm4(l.time);
        if (amt <= 0 || !hm) return;
        let g = idxOf[hm];
        if (!g) { g = { hm: hm, amts: [] }; idxOf[hm] = g; groups.push(g); }
        g.amts.push(amt);
      });
      const limitPct = pct.T05;
      const pushBar = (hm, p, amt, slot, count) => {
        const over = p > limitPct;          // 判定：与报告页同一个 maxPct
        const overflow = p > 100;           // 绘图：柱高截断到 100%，与判定无关
        out.t05.bars.push({ hm: hm, pct: p, amt: amt, over: over, overflow: overflow, slot: slot, count: count });
        if (over) out.t05.over = true;
        if (overflow) out.t05.overflow = true;
      };
      groups.forEach((g) => {
        const total = g.amts.reduce((a, b) => a + b, 0);
        if (g.amts.length > 3) { pushBar(g.hm, total / cap * 100, total, 0, g.amts.length); return; }
        g.amts.forEach((amt, i) => pushBar(g.hm, amt / cap * 100, amt, i, 1));
      });
    }

    // T09 / T10 阶梯：按时间升序累计；只标首个跨线 hm，跨线后的点仍画线但不挂标签
    function stepOf(rule, list, limitPct) {
      if (!(limitPct > 0) || !list.length) return null;
      let cum = 0, crossHm = '', crossPct = 0, crossAmt = 0;
      const pts = [];
      list.forEach((l) => {
        const amt = lineAmt(l), hm = hm4(l.time);
        if (amt <= 0 || !hm) return;
        cum += amt;
        const p = cum / cap * 100;
        pts.push({ hm: hm, pct: p, amt: cum });
        if (!crossHm && p >= limitPct) { crossHm = hm; crossPct = p; crossAmt = cum; }
      });
      if (!pts.length) return null;
      return { pts: pts, limitPct: limitPct, crossHm: crossHm, crossPct: crossPct, crossAmt: crossAmt };
    }
    out.steps.T09 = stepOf('T09', curBuys, pct.T09);
    out.steps.T10 = stepOf('T10', rows.filter((l) => l.side === '买'), pct.T10);

    // T11 瀑布：只累亏损、正数不抵扣；底仓不明标 unknown（虚线）
    if (pct.T11 > 0) {
      const sells = fifoSells(src.allLines || [], String(src.account == null ? '' : src.account), day8(src.day), src.openingPositions);
      let cum = 0, crossHm = '', crossPct = 0, crossAmt = 0, unknown = false;
      const pts = [];
      sells.forEach((s) => {
        if (!s.hm) return;
        const delta = s.pnl < 0 ? -s.pnl : 0;     // 正数方向 delta=0，保留刻度不画柱
        if (delta > 0) cum += delta;
        if (s.unknown) unknown = true;
        const cumPct = cum / cap * 100;
        pts.push({ hm: s.hm, deltaPct: delta / cap * 100, cumPct: cumPct, delta: delta, unknown: s.unknown });
        if (!crossHm && cumPct > pct.T11) { crossHm = s.hm; crossPct = cumPct; crossAmt = cum; }
      });
      if (pts.length) {
        out.waterfall = {
          pts: pts, limitPct: pct.T11, capDown: pct.T11 * 2,
          crossHm: crossHm, crossPct: crossPct, crossAmt: crossAmt, unknown: unknown,
        };
      }
    }
    return out;
  }

  // 叠层描述（业务坐标，不含像素）：绘制与测试共用同一份输出。
  function buildLayers(ev) {
    const out = [];
    if (!ev || !ev.form) return out;
    const form = ev.form;
    const t01 = form.find((r) => r.id === 'T01');
    const t02 = form.find((r) => r.id === 'T02');
    const t03 = form.find((r) => r.id === 'T03');
    const t04 = form.find((r) => r.id === 'T04');

    if (t01) {
      const end = SESSION.open + (+(t01.params && t01.params.waitMin) || 0);
      out.push({ type: 'timeBand', panel: 'price', role: 'rule', from: { min: SESSION.open }, to: { min: end }, label: '冷静期 09:30–' + hhmm(end) });
    }
    if (t02) {
      const from = SESSION.close - (+(t02.params && t02.params.endMin) || 0);
      out.push({ type: 'timeBand', panel: 'price', role: 'context', from: { min: from }, to: { min: SESSION.close }, label: '收盘前禁买 ' + hhmm(from) + '–15:00' });
    }
    if (t03 && ev.buyCount >= 2) {
      const win = SESSION.open + (+(t03.params && t03.params.windowMin) || 0);
      out.push({ type: 'timeBand', panel: 'price', role: 'window', from: { min: SESSION.open }, to: { min: win }, label: '追高窗口 ' + hhmm(win) + ' 前' });
    }
    if ((t03 || t04) && ev.firstBuyPrice > 0) {
      out.push({ type: 'priceLine', panel: 'price', role: 'ref', price: ev.firstBuyPrice, dash: [4, 4], label: '当日首笔 ' + fmtPrice(ev.firstBuyPrice), align: 'right' });
    }
    if (t04 && ev.firstBuyPrice > 0) {
      const tol = +((t04.params && t04.params.tolPct) || 0);
      const lim = ev.firstBuyPrice * (1 - tol / 100);
      out.push({ type: 'priceLine', panel: 'price', role: 'limit', rule: 'T04', price: lim, dash: [6, 3], label: '价格下限 ' + fmtPrice(lim), align: 'left' });
    }
    (ev.actions || []).forEach((a) => {
      if (!a.hm) return;
      const ids = splitRules(a.line && a.line.rule);
      const firstId = ids[0] || '';
      const hmText = hhmm(minutes(a.hm)) || a.hm;
      const icon = STATE_ICON[a.state] || '';
      let text;
      if (a.state === 'mismatch') text = (SHORT_NAME[firstId] || firstId || '违规') + ' ' + hmText;
      else if (a.state === 'unknown') text = '无法判断 ' + hmText;
      else if (a.state === 'consistent') text = '一致 ' + hmText;
      else text = '不适用 ' + hmText;
      out.push({
        type: 'point', panel: 'price', hm: a.hm, price: a.price, state: a.state,
        tone: STATE_COLOR[a.state] || 'undetermined', icon: icon,
        shape: (a.state === 'mismatch' || a.state === 'unknown') ? 'ring' : 'dot',
        rule: firstId, label: (icon ? icon + ' ' : '') + text,
      });
    });

    /* ---- 资金轨（§7.8）：主轴是百分比，分母 = 当前账户本金；金额只做标签 ---- */
    const pctCfg = ev.capPct || {};
    // 资金证据由 capitalEvidence 统一算一次（evaluate 已写进 byRule），这里只负责画。
    const capEv = ev.capitalEv || capitalEvidence(ev);
    const cap = +capEv.cap;
    if (!(cap > 0)) return out;                 // 无本金 / 本金为 0：不出空轨

    capEv.t05.bars.forEach((b) => {
      out.push({
        type: 'fundBar', panel: 'fundUp', rule: 'T05', fromHm: b.hm, toHm: b.hm,
        pct: b.pct, amt: b.amt, over: b.over, overflow: b.overflow, slot: b.slot, count: b.count,
        label: '单笔超限 ' + hmText(b.hm) + ' · ' + fmtAmt(b.amt) + ' / ' + fmtPct(b.pct)
          + (b.count > 1 ? '（' + b.count + '笔）' : ''),
      });
    });

    ['T09', 'T10'].forEach((rule) => {
      const st = capEv.steps[rule];
      if (!st) return;
      out.push({
        type: 'fundStep', panel: 'fundUp', rule: rule, pts: st.pts,
        limitPct: st.limitPct, crossHm: st.crossHm, crossPct: st.crossPct, crossAmt: st.crossAmt,
        label: st.crossHm ? (SHORT_NAME[rule] || rule) + ' ' + hmText(st.crossHm) + ' · ' + fmtAmt(st.crossAmt) + ' / ' + fmtPct(st.crossPct) : '',
      });
    });

    if (capEv.waterfall) {
      const wf = capEv.waterfall;
      out.push({
        type: 'fundWaterfall', panel: 'fundDown', rule: 'T11', pts: wf.pts,
        limitPct: wf.limitPct, capDown: wf.capDown,
        crossHm: wf.crossHm, crossPct: wf.crossPct, crossAmt: wf.crossAmt, unknown: wf.unknown,
        label: wf.crossHm ? (SHORT_NAME.T11 || 'T11') + ' ' + hmText(wf.crossHm) + ' · 已亏 ' + fmtAmt(wf.crossAmt) + ' / ' + fmtPct(wf.crossPct) : '',
      });
    }

    // 两条子轨的阈值线：同一百分比只画一条，避免叠线
    const usedIds = Object.create(null);
    out.forEach((l) => { if (l.panel === 'fundUp' && l.rule) usedIds[l.rule] = 1; });
    const limitRows = [];
    ['T05', 'T09', 'T10'].forEach((id) => {
      const pct = pctCfg[id];
      if (!(pct > 0) || !usedIds[id]) return;
      let row = limitRows.find((x) => x.pct === pct);
      if (!row) { row = { pct: pct, rules: [] }; limitRows.push(row); }
      if (row.rules.indexOf(id) < 0) row.rules.push(id);
    });
    limitRows.forEach((row) => out.push({
      type: 'fundLine', panel: 'fundUp', role: 'limit', pct: row.pct, rules: row.rules,
      label: '上限 ' + fmtPct(row.pct),
    }));
    if (out.some((l) => l.panel === 'fundDown')) {
      out.push({
        type: 'fundLine', panel: 'fundDown', role: 'limit', pct: pctCfg.T11,
        rules: ['T11'], label: '上限 ' + fmtPct(pctCfg.T11),
      });
    }
    return out;
  }

  // 标签优先级：mismatch > unknown > ref/limit > band > consistent > na。
  function labelPriority(l) {
    if (!l) return 6;
    if (l.type === 'point') {
      if (l.state === 'mismatch') return 0;
      if (l.state === 'unknown') return 1;
      if (l.state === 'na') return 5;
      return 4;
    }
    if (l.type === 'priceLine') return 2;
    if (l.type === 'timeBand') return 3;
    if (l.type === 'fundBar') return l.over ? 0 : 6;
    if (l.type === 'fundStep') return l.crossHm ? 0 : 6;
    if (l.type === 'fundWaterfall') return l.crossHm ? 0 : (l.unknown ? 1 : 6);
    if (l.type === 'fundLine') return 2;
    return 6;
  }

  function pickLabels(layers, cap) {
    const n = cap == null ? 6 : cap;
    return (layers || []).filter((l) => l && l.label)
      .map((l, i) => ({ l: l, i: i, p: labelPriority(l) }))
      .sort((a, b) => (a.p - b.p || a.i - b.i))
      .slice(0, n)
      .map((x) => x.l);
  }

  // 统一标签：价格层与资金轨共用一份列表，每项带严重度（rank）与锚点（anchor）。
  // 之前价格标签走 pickLabels + 避让、资金标签直接 fillText，两套机制在此合成一套。
  function collectLabels(layers, activeFund) {
    const out = [];
    const upLimits = (layers || []).filter((l) => l && l.type === 'fundLine' && l.panel === 'fundUp')
      .slice().sort((a, b) => a.pct - b.pct);
    const effUp = upLimits[0] || null;
    const restUp = upLimits.slice(1).map((l) => fmtPct(l.pct)).join(' · ');
    (layers || []).forEach((l, i) => {
      if (!l) return;
      const panel = l.panel || 'price';
      // 390 槽内切换时只收当前资金轨的标签；另一条轨靠分段控件上的徽标提示。
      if (activeFund && panel !== 'price' && panel !== activeFund) return;
      if (l.type === 'point') {
        if (!l.label) return;
        out.push({ id: 'L' + i, type: l.type, panel: panel, text: l.label,
          anchor: { kind: 'time', hm: l.hm, price: l.price }, rank: labelPriority(l),
          tone: l.tone || 'undetermined', dy: -10, align: 'left', seq: i });
        return;
      }
      if (l.type === 'priceLine') {
        if (!l.label) return;
        out.push({ id: 'L' + i, type: l.type, panel: panel, text: l.label,
          anchor: { kind: 'price', price: l.price, align: l.align || 'left' },
          rank: labelPriority(l), tone: l.role === 'limit' ? 'inconsistent' : 'undetermined',
          dy: -5, seq: i });
        return;
      }
      if (l.type === 'timeBand') {
        if (l.role !== 'window' || !l.label) return;
        out.push({ id: 'L' + i, type: l.type, panel: panel, text: '追高窗口',
          anchor: { kind: 'band', hm: hhmm(l.to.min) }, rank: 3, tone: 'inconsistent', seq: i });
        return;
      }
      if (l.type === 'fundBar') {
        if (!l.over) return;
        out.push({ id: 'L' + i, type: l.type, panel: panel, text: STATE_ICON.mismatch + ' ' + l.label,
          bandText: STATE_ICON.mismatch + ' ' + String(l.label || '').split(' · ')[0],
          anchor: { kind: 'timePct', hm: l.fromHm, pct: l.pct }, rank: 0, tone: 'inconsistent',
          dy: 12, seq: i });
        return;
      }
      if (l.type === 'fundStep') {
        if (!l.crossHm) return;
        out.push({ id: 'L' + i, type: l.type, panel: panel, text: STATE_ICON.mismatch + ' ' + l.label,
          bandText: STATE_ICON.mismatch + ' ' + String(l.label || '').split(' · ')[0],
          anchor: { kind: 'timePct', hm: l.crossHm, pct: l.crossPct }, rank: 0, tone: 'inconsistent',
          dy: -4, seq: i });
        return;
      }
      if (l.type === 'fundWaterfall') {
        if (l.crossHm) {
          out.push({ id: 'L' + i + 'a', type: l.type, panel: panel,
            text: STATE_ICON.mismatch + ' ' + l.label,
            bandText: STATE_ICON.mismatch + ' ' + String(l.label || '').split(' · ')[0],
            anchor: { kind: 'timePct', hm: l.crossHm, pct: l.crossPct }, rank: 0, tone: 'inconsistent',
            dy: -4, seq: i });
        }
        if (l.unknown) {
          out.push({ id: 'L' + i + 'b', type: l.type, panel: panel,
            text: STATE_ICON.unknown + ' 底仓不明，亏损可能算不全',
            anchor: { kind: 'panelRight' }, rank: 1, tone: 'undetermined', seq: i });
        }
        return;
      }
      if (l.type === 'fundLine') {
        if (panel !== 'fundUp' || !l.label) return;   // 亏损轨的上限刻度走左侧轴，不重复出标签
        const isEff = l === effUp;
        if (!isEff) return;   // 其余上限已折进首条的 suffix，再单列只会把标注带挤爆
        out.push({ id: 'L' + i, type: l.type, panel: panel, text: l.label,
          suffix: restUp ? ' · ' + restUp : '',
          anchor: { kind: 'panelRight' }, rank: 2,
          tone: 'inconsistent', seq: i });
      }
    });
    return out;
  }

  // 分段控件标记：哪块面板上有 rank 0（规则不一致 / 跨线）的标签。
  function panelBadges(layers) {
    const out = { price: false, fundUp: false, fundDown: false };
    collectLabels(layers).forEach((it) => { if (it.rank === 0) out[it.panel] = true; });
    return out;
  }

  // 业务锚点 → 像素位置（绘制与命中测试共用同一份计算）。
  function labelPos(it, geom) {
    const a = it.anchor || { kind: 'panelRight' };
    const pad = geom.pad;
    // 资金槽顶部 26px 留给分段控件（控件 13 + 字身 12），标签一律从它下面起排，避免 DOM 控件压住 canvas 标签。
    const ltop = (panel) => geom.panelTopOf(panel) + (panel === 'price' ? 10 : 26);
    let x = pad.l + 4, y = ltop(it.panel), ay = y, align = it.align || 'left';
    if (a.kind === 'price') {
      const rawY = geom.yPrice(a.price);
      ay = rawY;
      y = Math.max(geom.panelTopOf(it.panel) + 10, rawY + (it.dy || 0));
      if (a.align === 'right') { x = geom.right; align = 'right'; }
      else { x = pad.l + 4; align = 'left'; }
    } else if (a.kind === 'time') {
      const bx = geom.xOfHm(a.hm);
      const rawY = geom.yPrice(a.price);
      ay = rawY;
      y = Math.max(geom.priceTop + 10, rawY + (it.dy || 0));
      if (bx > geom.cssW - 80) { x = bx; align = 'right'; }
      else { x = bx + 7; align = 'left'; }
    } else if (a.kind === 'band') {
      x = geom.xOfHm(a.hm) - 4; y = geom.priceTop + 11; ay = y; align = 'right';
    } else if (a.kind === 'timePct') {
      const bx = geom.xOfHm(a.hm);
      const rawY = geom.yPct(it.panel, a.pct);
      ay = rawY;
      y = Math.max(ltop(it.panel), rawY + (it.dy || 0));
      if (bx > geom.cssW - 80) { x = bx; align = 'right'; }
      else { x = bx + 5; align = 'left'; }
    } else {
      x = geom.right; y = ltop(it.panel); ay = y; align = 'right';
    }
    const ax = (a.kind === 'time' || a.kind === 'timePct') ? geom.xOfHm(a.hm) : x;
    return { x: x, y: y, align: align, ax: ax, ay: ay };
  }

  // 同区间合并：同一面板内两个事件标签横向间隔 <96px（16 根蜡烛）合成一条区间标签，
  // 形如「09:40–10:20 · 2 笔」；阈值与面板说明不参与合并。
  function mergeLabels(list, geom) {
    const keep = [];
    const groups = Object.create(null);
    (list || []).forEach((it) => {
      const k = it.anchor && it.anchor.kind;
      if (k !== 'time' && k !== 'timePct') { keep.push(it); return; }
      (groups[it.panel] || (groups[it.panel] = [])).push(it);
    });
    const merged = keep.slice();
    Object.keys(groups).forEach((panel) => {
      const arr = groups[panel].slice().sort((a, b) => (minutes(a.anchor.hm) || 0) - (minutes(b.anchor.hm) || 0));
      let cur = null;
      arr.forEach((it) => {
        const x = geom.xOfHm(it.anchor.hm);
        if (cur && x - cur.lastX < 96 && it.type === cur.items[0].type) {
          cur.items.push(it);
          cur.lastX = x;
          const a = hmText(cur.items[0].anchor.hm), b = hmText(it.anchor.hm);
          cur.text = (a === b ? a : a + '–' + b) + ' · ' + cur.items.length + ' 笔';
          cur.rank = Math.min(cur.rank, it.rank);
          if (it.rank === 0) cur.tone = 'inconsistent';
          return;
        }
        cur = { id: it.id, panel: panel, type: it.type, text: it.text,
          bandText: it.bandText, anchor: it.anchor, rank: it.rank, tone: it.tone,
          dy: it.dy, seq: it.seq, items: [it], lastX: x };
        merged.push(cur);
      });
    });
    return merged;
  }

  // 展开：贴锚点侧放（右优先），整块避开锚点那一根柱，不遮住被标注的柱子。
  function calloutBox(items, geom, expandedId) {
    if (!expandedId) return null;
    const r = items.find((x) => x.it.id === expandedId);
    if (!r) return null;
    const bx = r.ax;
    // 宽度按 12px 读数块字体量，别用 10px 标签字体量——否则画出来被截成省略号。
    const tw = (geom.measureCallout || geom.measure)(r.full);
    const w = Math.min(geom.cssW - geom.pad.l - 4, Math.max(48, tw) + 14);
    const h = geom.wide ? 26 : 24;
    let x = bx + 10;
    if (x + w > geom.cssW - 2) x = bx - 10 - w;
    if (x < geom.pad.l + 2) x = geom.pad.l + 2;
    let y = r.ay - h - 6;
    const top = geom.panelTopOf(r.it.panel) + 2;
    const bottom = geom.panelTopOf(r.it.panel) + geom.panelHOf(r.it.panel) - 2;
    if (y < top) y = r.ay + 8;
    if (y + h > bottom) y = Math.max(top, bottom - h);
    return { id: expandedId, text: r.full, x: x, y: y, w: w, h: h, ax: bx, ay: r.ay };
  }

  // 标注带装箱：不换行、不横向滚动。按 rank 顺序塞进可用宽度；塞不下的折成「＋N 条」分页。
  const BAND_DOT = 8;    // 4px 圆点 + 4px 间距
  const BAND_GAP = 12;   // 与 .rv-band 的 gap 对齐
  const BAND_MORE = 34;  // 「＋N 条」预留宽度
  function bandPageSize(band, geom, width) {
    const n = (band || []).length;
    if (!n) return 0;
    const w = (it) => Math.max(20, geom.measure(it.bandText || it.text) + BAND_DOT);
    let total = 0;
    for (let i = 0; i < n; i++) total += w(band[i]) + (i ? BAND_GAP : 0);
    if (total <= width) return n;
    let used = 0, k = 0;
    for (; k < n; k++) {
      const add = w(band[k]) + (k ? BAND_GAP : 0);
      if (used + add + BAND_GAP + BAND_MORE > width) break;
      used += add;
    }
    return Math.max(1, k);
  }

  // 一套避让：同面板按 rank 排序 → 每面板上限 → 全图上限 → 12px 步进最多 2 档 → 溢出进标注带。
  function layoutLabels(list, geom, expandedId) {
    const caps = labelCaps(geom.wide);
    const items = mergeLabels(list, geom).map((it) => {
      const p = labelPos(it, geom);
      const full = it.text + (it.suffix || '');
      return { it: it, full: full, bandText: it.bandText || full,
        x: p.x, y: p.y, align: p.align, ax: p.ax, ay: p.ay,
        w: Math.max(16, geom.measure(full)) };
    });
    // 左对齐会顶到右轴时翻到锚点左侧，宁可压左侧蜡烛也不压轴刻度、不出画布。
    items.forEach((r) => {
      if (r.align !== 'left' || r.x + r.w <= geom.right) return;
      const k = r.it.anchor && r.it.anchor.kind;
      r.align = 'right';
      r.x = (k === 'time' || k === 'timePct') ? r.ax : geom.right;
    });
    // 翻过去仍会出左边界（宽屏 12px 字）时，整块夹在绘图区内。
    items.forEach((r) => {
      const l0 = r.align === 'right' ? r.x - r.w : r.x;
      const minL = geom.pad.l + 2;
      const maxL = Math.max(minL, geom.right - r.w);
      const l = Math.max(minL, Math.min(l0, maxL));
      if (l !== l0) r.x = r.align === 'right' ? l + r.w : l;
    });
    items.sort((a, b) => (a.it.rank - b.it.rank) || (a.it.seq - b.it.seq));
    const used = { price: 0, fund: 0 };
    let total = 0;
    const drawn = [];
    const rects = [];
    const band = [];
    items.forEach((r) => {
      const slot = r.it.panel === 'price' ? 'price' : 'fund';
      const left = r.align === 'right' ? r.x - r.w : r.x;
      const yMax = r.it.panel === 'price'
        ? geom.priceTop + geom.priceH - 4
        : geom.panelTopOf(r.it.panel) + geom.panelHOf(r.it.panel) - 3;
      const y0 = Math.min(r.y, yMax);
      // 命中矩形一律保留：被折叠／分页的那条点开才知道写了什么。
      rects.push({ id: r.it.id, rank: r.it.rank, panel: r.it.panel, text: r.full,
        x: left - 4, y: y0 - 12, w: r.w + 8, h: 18, ax: r.ax, ay: r.ay });
      if (expandedId && r.it.id === expandedId) return;   // 展开的走 callout，不在线上
      if (used[slot] >= caps[slot] || total >= caps.total) {
        band.push({ id: r.it.id, text: r.full, bandText: r.bandText, tone: r.it.tone, panel: r.it.panel });
        return;
      }
      let y = y0, ok = false;
      for (let k = 0; k <= 2; k++) {
        if (y > yMax) break;
        const clash = drawn.some((d) => d.panel === r.it.panel
          && Math.abs(d.y - y) < 12
          && left < d.x + d.w + 4 && left + r.w > d.x - 4);
        if (!clash) { ok = true; break; }
        y += 12;
      }
      if (!ok) {
        band.push({ id: r.it.id, text: r.full, bandText: r.bandText, tone: r.it.tone, panel: r.it.panel });
        return;
      }
      used[slot] += 1; total += 1;
      drawn.push({ id: r.it.id, text: r.full, x: r.x, y: y, w: r.w, align: r.align,
        panel: r.it.panel, tone: r.it.tone, type: r.it.type, ax: r.ax, ay: r.ay });
    });
    return { drawn: drawn, rects: rects, band: band, merged: items.length,
      bandPage: bandPageSize(band, geom, geom.cssW),
      callout: calloutBox(items, geom, expandedId) };
  }

  // canvas 命中测试：取覆盖点且面积最小的矩形（同一处多个标签时先命中更精确的那个）。
  function hitTest(result, x, y) {
    if (!result || !Array.isArray(result.hitRects)) return '';
    const hits = result.hitRects.filter((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    if (!hits.length) return '';
    hits.sort((a, b) => (a.w * a.h) - (b.w * b.h) || (a.rank - b.rank));
    return hits[0].id;
  }

  // 面板高度契约（390）：价格 195 + 间距 10 + 资金槽 57；≥768：三面板 66/20/14。
  // 资金轨必须与价格同屏才有参照物，所以价格常驻，占用/亏损只在槽内切换。
  function panelLayout(cssW, cssH, wide, fundSlot) {
    const pad = wide ? { l: 8, r: 44, t: 12, b: 22 } : { l: 6, r: 40, t: 10, b: 20 };
    const plotH = Math.max(20, cssH - pad.t - pad.b);
    const gap = wide ? 12 : 10;
    const out = {
      pad: pad, gap: gap, plotH: plotH, wide: !!wide,
      plotLeft: pad.l, plotRight: cssW - pad.r, cssW: cssW, cssH: cssH,
      priceTop: pad.t, priceH: plotH, priceBottom: pad.t + plotH,
      fundTop: pad.t + plotH, fundH: 0,
      upTop: pad.t + plotH, upH: 0, downTop: pad.t + plotH, downH: 0,
    };
    if (!fundSlot) return out;
    if (wide) {
      const usable = Math.max(60, plotH - gap * 2);
      out.priceH = Math.floor(usable * 0.66);
      out.upH = Math.floor(usable * 0.20);
      out.downH = usable - out.priceH - out.upH;
      out.fundH = out.upH;
      out.priceBottom = pad.t + out.priceH;
      out.fundTop = out.priceBottom + gap;
      out.upTop = out.fundTop;
      out.downTop = out.upTop + out.upH + gap;
    } else {
      out.priceH = 195;
      out.fundH = 57;
      out.priceBottom = pad.t + out.priceH;
      out.fundTop = out.priceBottom + gap;
      out.upTop = out.fundTop;
      out.downTop = out.fundTop;
      out.upH = out.fundH;
      out.downH = out.fundH;
    }
    return out;
  }

  function drawReview(canvas, bars1m, ev, opts) {
    if (!canvas || !canvas.getContext) return null;
    const o = opts || {};
    const T = o.theme || themeOf(canvas);
    const dpr = Math.min(2, (root && root.devicePixelRatio) || 1);
    const cssW = canvas.clientWidth || o.width || 340;
    const cssH = canvas.clientHeight || o.height || 300;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    g.fillStyle = T.bg;
    g.fillRect(0, 0, cssW, cssH);
    const bars = aggBars(bars1m, 5);
    g.font = '9px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    if (!bars.length) {
      g.fillStyle = T.textWeak;
      g.font = '12px sans-serif';
      g.fillText('这一天没有可画的走势', 10, 24);
      return null;
    }

    const layers = buildLayers(ev);
    const fundOn = layers.some((l) => l.panel === 'fundUp' || l.panel === 'fundDown');
    const priceLayers = layers.filter((l) => !l.panel || l.panel === 'price');
    // 空态：配了资金规则却缺本金（或本金为 0），资金轨画不出来，居中留一行说明。
    const capRulesOn = (ev.capitalCfg || []).length > 0
      || (ev.pending || []).some((id) => CAPITAL_RULES.indexOf(id) >= 0);
    const noCapital = !fundOn && capRulesOn && !(ev.capital > 0);
    // 资金槽：有资金图层，或配了资金规则但缺本金（要留一行空态说明）。
    const fundSlot = fundOn || capRulesOn;
    const wide = (root && typeof root.innerWidth === 'number') ? (root.innerWidth >= 768) : (cssW >= 768);
    const lay = panelLayout(cssW, cssH, wide, fundSlot);
    const pad = lay.pad;
    const innerW = Math.max(20, cssW - pad.l - pad.r);
    const plotLeft = lay.plotLeft, plotRight = lay.plotRight;
    const priceTop = lay.priceTop, priceH = lay.priceH, priceBottom = lay.priceBottom;
    const fundTop = lay.fundTop, fundH = lay.fundH;
    const upTop = lay.upTop, upH = lay.upH, downTop = lay.downTop, downH = lay.downH;
    const narrow = !wide;
    const activeFund = o.panel === 'fundDown' ? 'fundDown' : 'fundUp';
    // 数字字号只用 H+ 五档（34/22/15/13/11）：轴刻度与区间标签落 11，浮窗数字落 13。
    const FONT_AXIS = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const FONT_LABEL = '500 11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const FONT_CALLOUT = '500 13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    // 刻度贴右轴：右对齐、距画布右缘 2px（距轴约 6px），不描边不加底。
    // canvas 没有 tabular-nums：按 0–9 的最大字宽等距落字，价格列的小数点才会对齐成一条竖线。
    function numW(text) {
      let adv = 0;
      for (let i = 0; i <= 9; i++) adv = Math.max(adv, g.measureText(String(i)).width);
      let w = 0;
      String(text).split('').forEach((ch) => { w += /\d/.test(ch) ? adv : g.measureText(ch).width; });
      return w;
    }
    function numAt(text, x, y, align) {
      let adv = 0;
      for (let i = 0; i <= 9; i++) adv = Math.max(adv, g.measureText(String(i)).width);
      const s = String(text);
      let cx = x;
      if (align === 'right') cx = x - numW(s);
      else if (align === 'center') cx = x - numW(s) / 2;
      s.split('').forEach((ch) => {
        g.fillText(ch, cx, y);
        cx += /\d/.test(ch) ? adv : g.measureText(ch).width;
      });
    }
    function axisText(text, y, color) {
      g.font = FONT_AXIS;
      g.fillStyle = color || T.textWeak;
      numAt(text, cssW - 2, y, 'right');
    }
    // 占用/亏损轴是第二套坐标系，刻度留在面板内部左侧竖排（10px 弱色），不与价格轴共列。
    // 刻度只写整数（0/50/100），底下垫一块画布底色，避免和阶梯、柱子、分段控件叠字。
    function fundAxisText(text, y) {
      g.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      const tw = g.measureText(text).width;
      g.fillStyle = T.bg;
      g.fillRect(plotLeft + 2, y - 9, tw + 4, 11);
      g.fillStyle = T.textWeak;
      numAt(text, plotLeft + 4, y, 'left');
    }

    let lo = Infinity, hi = -Infinity;
    bars.forEach((b) => { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); });
    (ev && ev.actions ? ev.actions : []).forEach((a) => {
      if (isFinite(a.price) && a.price > 0) { lo = Math.min(lo, a.price); hi = Math.max(hi, a.price); }
    });
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi === lo) { hi += 0.01; lo -= 0.01; }
    const padP = (hi - lo) * 0.02;
    lo -= padP; hi += padP;
    const step = innerW / bars.length;
    const xOf = (i) => plotLeft + step * (i + 0.5);
    const yOf = (p) => priceTop + (hi - p) / (hi - lo) * priceH;
    function xOfHm(hm) {
      const m = minutes(hm);
      if (m == null) return plotLeft;
      const firstM = minutes(bars[0].hm), lastM = minutes(bars[bars.length - 1].hm);
      if (m <= firstM) return xOf(0);
      if (m >= lastM) return xOf(bars.length - 1);
      for (let i = 0; i < bars.length - 1; i++) {
        const a = minutes(bars[i].hm), b = minutes(bars[i + 1].hm);
        if (m >= a && m < b) {
          const frac = (m - a) / (b - a || 1);
          return xOf(i) + frac * (xOf(i + 1) - xOf(i));
        }
      }
      return xOf(bars.length - 1);
    }
    function anchorOf(hm) {
      const m = minutes(hm);
      if (m == null) return -1;
      for (let i = 0; i < bars.length; i++) if (minutes(bars[i].hm) >= m) return i;
      return bars.length - 1;
    }

    // 时间带：只留语义底色，不描边，避免「框里还有框」。
    const BAND_STYLE = {
      rule: { fill: T.inconsistentBg },
      window: { fill: T.inconsistentBg },
      context: { fill: T.undeterminedBg },
    };
    // 带内左下给一个 10px 名字，否则一块无名底色读起来像图脏了。
    // 带很窄（30 分钟窗口只有 30px）时不截断文字，只把文字按左右边缘择边落位。
    const bandTexts = [];
    const BAND_NAME_SHORT = { rule: '冷静期', context: '收盘前禁买', window: '追高窗口' };
    g.save();
    priceLayers.filter((l) => l.type === 'timeBand').forEach((l) => {
      const st = BAND_STYLE[l.role] || BAND_STYLE.rule;
      const x1 = xOfHm(hhmm(l.from.min)), x2 = xOfHm(hhmm(l.to.min));
      const w = Math.max(2, x2 - x1);
      g.globalAlpha = 0.35;
      g.fillStyle = st.fill;
      g.fillRect(x1, priceTop, w, priceH);
      g.globalAlpha = 1;
      const name = BAND_NAME_SHORT[l.role] || '';
      if (name) bandTexts.push({ x: x1 + 3, xr: x2, text: name });
    });

    // 网格：竖网格 0 条；价格 3 条横线（顶/中/底），刻度贴右轴；时间只靠底部 5 个标签。
    const pTicks = [hi, (hi + lo) / 2, lo];
    const thresholdYs = priceLayers.filter((l) => l.type === 'priceLine').map((l) => yOf(l.price));
    g.lineWidth = 1;
    pTicks.forEach((p) => {
      const y = yOf(p);
      g.strokeStyle = T.gridMajor;
      g.beginPath(); g.moveTo(plotLeft, y); g.lineTo(plotRight, y); g.stroke();
      // 阈值标签同高贴右轴，刻度先让位，避免两行字叠在一起。
      if (!thresholdYs.some((ty) => Math.abs(ty - y) < 11)) axisText(fmtPrice(p), y + 3, T.text);
    });
    const timeTicks = wide ? [570, 600, 660, 840, 900] : [570, 630, 690, 840, 900];
    g.font = FONT_AXIS;
    timeTicks.forEach((m) => {
      const x = xOfHm(hhmm(m));
      if (x < plotLeft + 10 || x > plotRight - 10) return;
      const t = hhmm(m), w = numW(t);
      g.fillStyle = T.textWeak;
      numAt(t, Math.min(plotRight - w, Math.max(plotLeft, x - w / 2)), cssH - 8, 'left');
    });

    g.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    // K 线：不再分主次，全部统一填充 + 1px 满不透明描边。
    // 45% 填充对图底只有 1.81 / 1.46，低于非文本 3:1，描边补到 7.40 / 6.27。
    const bw = Math.max(1, Math.min(9, step * 0.62));
    const restRaw = parseFloat(T.candleRest);
    const restOpacity = isFinite(restRaw) ? Math.max(0, Math.min(1, restRaw)) : 1;
    // 密集区（bw < 7）不画上下影线：1px 影线连成一片就是「毛毛虫」，只留实体 + 描边。
    const denseK = bw < 7;
    bars.forEach((b, i) => {
      const x = xOf(i);
      const up = b.c >= b.o;
      const base = up ? T.up : T.down;
      g.lineWidth = 1;
      g.strokeStyle = base;
      if (!denseK) {
        g.beginPath(); g.moveTo(x, yOf(b.h)); g.lineTo(x, yOf(b.l)); g.stroke();
      }
      const y1 = yOf(b.o), y2 = yOf(b.c);
      const top = Math.min(y1, y2), hgt = Math.max(1, Math.abs(y2 - y1));
      g.globalAlpha = restOpacity;
      g.fillStyle = base;
      g.fillRect(x - bw / 2, top, bw, hgt);
      g.globalAlpha = 1;
      g.strokeRect(x - bw / 2 + 0.5, top + 0.5, Math.max(1, bw - 1), Math.max(1, hgt - 1));
    });

    // 参考线 / 阈值线：未判定 = 1px 点线，不一致 = 2px 虚线
    const LINE_STYLE = {
      limit: { color: T.inconsistent, dash: [6, 3], width: 1.5, label: T.inconsistent },
      ref: { color: T.undetermined, dash: [2, 2], width: 1, label: T.undetermined },
    };
    // 阈值线：只画生效的那一条（limit 优先，其次参考线），其余不画线也不常驻。
    const priceLineLayers = priceLayers.filter((l) => l.type === 'priceLine');
    const effPriceLine = priceLineLayers.filter((l) => l.role === 'limit')[0] || priceLineLayers[0];
    if (effPriceLine) {
      const st = LINE_STYLE[effPriceLine.role] || LINE_STYLE.ref;
      const y = yOf(effPriceLine.price);
      g.strokeStyle = st.color;
      g.lineWidth = st.width;
      g.setLineDash(st.dash);
      g.beginPath(); g.moveTo(plotLeft, y); g.lineTo(plotRight, y); g.stroke();
      g.setLineDash([]);
    }

    // 动作点：不再画任何圆点/圆环（390 下首笔标记必然落在左上角合并标签的文字盒里）。
    // 时间、价格与规则文本已经由标签承担；元素仍可点按弹小浮窗，不靠标记指认。
    g.restore();

    // 资金坐标：390 槽内切换时占用/亏损共用同一槽高；≥768 各占一块。
    const downRule = layers.filter((l) => l.type === 'fundWaterfall')[0];
    const downCap = downRule && downRule.capDown > 0 ? downRule.capDown : 100;
    const yUp = (pct) => upTop + upH - Math.max(0, Math.min(100, pct)) / 100 * upH;
    const yDown = (pct) => downTop + Math.max(0, Math.min(downCap, pct)) / downCap * downH;

    // 绘制与标签共用的像素几何；价格层与资金轨走同一份锚点计算。
    const geom = {
      cssW: cssW, pad: pad, plotLeft: plotLeft, plotRight: plotRight,
      right: plotRight, plotW: innerW, priceTop: priceTop, priceH: priceH,
      wide: wide, narrow: narrow,
      xOfHm: xOfHm, indexOfHm: anchorOf, xOfIdx: xOf,
      yPrice: yOf,
      yPct: (panel, pct) => (panel === 'fundDown' ? yDown(pct) : yUp(pct)),
      panelTopOf: (panel) => (panel === 'fundDown' ? downTop : upTop),
      panelHOf: (panel) => (panel === 'fundDown' ? downH : upH),
      measure: (text) => { g.font = FONT_LABEL; return g.measureText(text).width; },
      measureCallout: (text) => { g.font = FONT_CALLOUT; return g.measureText(text).width; },
    };
    const labelList = collectLabels(layers, narrow ? activeFund : '');

    // 元素命中框 + 规则浮层三组（价位线 / 时间带 / 文字结论）。点元素弹小浮窗就靠这张表。
    const hits = [];
    const marks = [];
    const yPctOf = (panel, pct) => (panel === 'fundDown' ? yDown(pct) : yUp(pct));
    // 资金轨的 label 自带规则名（"单笔超限 13:50 · 40万 / 27%"），浮层里名字已单列，去掉重复前缀
    const trimName = (txt, name) => {
      const s = String(txt || '');
      return (name && s.indexOf(name) === 0) ? s.slice(name.length).trim() : s;
    };
    const BAND_NAME = { rule: '冷静期', context: '收盘前禁买', window: '追高窗口' };
    const BAND_RULE = { rule: 'T01', context: 'T02', window: 'T03' };
    layers.forEach((l, i) => {
      const id = 'L' + i;
      const add = (h) => { h.id = id; hits.push(h); };
      if (l.type === 'point') {
        const j = anchorOf(l.hm);
        if (j < 0) return;
        const x = xOf(j), y = yOf(l.price);
        add({ kind: 'point', rule: l.rule || '', name: SHORT_NAME[l.rule] || '成交点',
          param: hhmm(minutes(l.hm)) + ' ' + fmtPrice(l.price), tone: l.tone || 'undetermined',
          x: x - 8, y: y - 8, w: 16, h: 16, ax: x, ay: y });
      } else if (l.type === 'priceLine') {
        const y = yOf(l.price);
        const lnName = l.rule ? (SHORT_NAME[l.rule] || l.rule) : '当日首笔';
        add({ kind: 'line', rule: l.rule || '', name: lnName,
          param: trimName(l.label, lnName), tone: l.role === 'limit' ? 'inconsistent' : 'undetermined',
          x: plotLeft, y: y - 5, w: innerW, h: 10, ax: plotRight, ay: y });
      } else if (l.type === 'timeBand') {
        if (!l.from || !l.to) return;
        const x1 = xOfHm(hhmm(l.from.min)), x2 = xOfHm(hhmm(l.to.min));
        const a = Math.max(plotLeft, Math.min(x1, x2)), b = Math.min(plotRight, Math.max(x1, x2));
        add({ kind: 'band', rule: BAND_RULE[l.role] || '', name: BAND_NAME[l.role] || '时间带',
          param: trimName(l.label, BAND_NAME[l.role]), tone: l.role === 'rule' ? 'inconsistent' : 'undetermined',
          x: a, y: priceTop, w: Math.max(8, b - a), h: priceH, ax: a + 2, ay: priceTop + 10 });
      } else if (l.type === 'fundBar') {
        const x = xOfHm(l.fromHm) + (l.count > 1 ? 0 : (l.slot || 0) * 2);
        const y1 = yPctOf(l.panel, l.pct), y0 = yPctOf(l.panel, 0);
        add({ kind: 'bar', rule: l.rule || '', name: SHORT_NAME[l.rule] || '资金柱', pct: +l.pct || 0,
          param: trimName(l.label, SHORT_NAME[l.rule]), tone: l.over ? 'inconsistent' : 'consistent',
          x: x - 4, y: Math.min(y1, y0), w: 8, h: Math.max(1, Math.abs(y0 - y1)),
          ax: x, ay: Math.min(y1, y0) });
      } else if (l.type === 'fundStep' || l.type === 'fundWaterfall') {
        const pts = l.pts || [];
        const hm = l.crossHm || (pts.length ? pts[pts.length - 1].hm : '');
        if (!hm) return;
        const pct = l.crossHm ? l.crossPct : ((pts[pts.length - 1] || {}).pct || 0);
        const x = xOfHm(hm), y = yPctOf(l.panel, pct);
        add({ kind: 'step', rule: l.rule || '', name: SHORT_NAME[l.rule] || l.rule,
          param: trimName(l.label, SHORT_NAME[l.rule]) || l.rule, pct: +pct || 0, limitPct: +l.limitPct || 0, cross: !!l.crossHm,
          tone: l.crossHm ? 'inconsistent' : 'consistent',
          x: x - 8, y: y - 8, w: 16, h: 16, ax: x, ay: y });
      } else if (l.type === 'fundLine') {
        const y = yPctOf(l.panel, l.pct);
        add({ kind: 'line', rule: l.rule || '', name: SHORT_NAME[l.rule] || '上限', limitPct: +l.pct || 0,
          param: l.label, tone: 'inconsistent',
          x: plotLeft, y: y - 5, w: innerW, h: 10, ax: plotRight, ay: y });
      }
    });

    // —— 规则浮层的数据：三组行 + 底边入口文案 ——
    const byRuleRows = (ev && ev.byRule) || [];
    const stateOf = (id) => {
      const r = byRuleRows.filter((x) => x.id === id)[0];
      if (!r) return 'undetermined';
      if (+r.inconsistent > 0) return 'inconsistent';
      if (+r.undetermined > 0) return 'undetermined';
      return 'consistent';
    };
    const cfgIds = (ev && ev.cfgIds) || [];
    const sheet = { lines: [], bands: [], notes: [] };
    function put(group, id, name, param, tone, pick) {
      if (id !== 'ref' && cfgIds.indexOf(id) < 0) return;
      sheet[group].push({
        id: id, name: name, param: param, tone: tone || stateOf(id),
        hitIds: hits.filter(pick || ((h) => h.rule === id)).map((h) => h.id),
      });
    }

    // 价位线：当日首笔参照 + T04 价格下限（图上只画生效的那一条，浮层也只列这一条）。
    const refL = layers.filter((l) => l.type === 'priceLine' && l.role === 'ref')[0];
    if (refL) put('lines', 'ref', '当日首笔', fmtPrice(refL.price), 'undetermined',
      (h) => h.kind === 'line' && !h.rule);
    const limL = layers.filter((l) => l.type === 'priceLine' && l.role === 'limit')[0];
    if (limL) put('lines', 'T04', FORM_NAME.T04, '价格下限 ' + fmtPrice(limL.price), '',
      (h) => h.kind === 'line' && h.rule === 'T04');

    // 时间带：冷静期 / 收盘前禁买 / 追高窗口。
    ['rule', 'context', 'window'].forEach((role) => {
      const b = layers.filter((l) => l.type === 'timeBand' && l.role === role)[0];
      if (!b || !b.from || !b.to) return;
      const rng = hhmm(b.from.min) + '–' + hhmm(b.to.min);
      const param = role === 'window'
        ? (fmtPrice((ev && ev.firstBuyPrice) || 0) + ' / ' + rng)
        : rng;
      put('bands', BAND_RULE[role], BAND_NAME[role], param,
        role === 'window' ? stateOf('T03') : (role === 'rule' ? stateOf('T01') : 'undetermined'),
        (h) => h.kind === 'band' && h.rule === BAND_RULE[role]);
    });

    // 文字结论：资金类四条（本页画在资金槽里），组内一条一行。
    CAPITAL_RULES.forEach((id) => {
      if (cfgIds.indexOf(id) < 0) return;
      if (id === 'T05') {
        const bars = hits.filter((h) => h.kind === 'bar' && h.rule === 'T05');
        const worst = bars.slice().sort((a, b) => b.pct - a.pct)[0];
        const bad = bars.some((h) => h.tone === 'inconsistent');
        put('notes', 'T05', SHORT_NAME.T05,
          bars.length ? (bars.length + ' 笔 / 最高 ' + fmtPct(worst.pct)) : '无成交',
          bad ? 'inconsistent' : 'consistent',
          (h) => !!worst && h.id === worst.id);
      } else if (id === 'T09' || id === 'T10' || id === 'T11') {
        const step = hits.filter((h) => h.kind === 'step' && h.rule === id)[0];
        const capLine = hits.filter((h) => h.kind === 'line' && h.rule === id)[0];
        const limitPct = (step && step.limitPct) || (capLine && capLine.limitPct) || 0;
        let param = '未判定';
        if (step) param = step.cross ? (step.param || '已跨线') : ('未跨线 · 上限 ' + fmtPct(limitPct));
        else if (ev && ev.missingCapital) param = '本金未填 · 未判定';
        else if (limitPct) param = '上限 ' + fmtPct(limitPct) + ' · 未跨线';
        put('notes', id, SHORT_NAME[id], param,
          step ? (step.cross ? 'inconsistent' : 'consistent') : 'undetermined',
          (h) => (step ? h.id === step.id : false));
      }
    });

    // T12 止损预案：只统计被问过的成交。无记录（含历史导入）不进分母，也不写成「一致」。
    if (cfgIds.indexOf('T12') >= 0) {
      const t12 = (ev && ev.t12) || { asked: 0, recorded: 0 };
      put('notes', 'T12', SHORT_NAME.T12,
        t12.asked
          ? ('已记录 ' + t12.recorded + ' / 未记录 ' + (t12.asked - t12.recorded) + '（只统计被问过的成交）')
          : '没有被问过的成交 · 不计入',
        t12.asked ? (t12.recorded === t12.asked ? 'consistent' : 'inconsistent') : 'undetermined');
    }

    // 入口文案：规则条数 = 本页参与判定的规则数；不一致 = byRule 里 inconsistent 的条数。
    // 不再从浮层行汇总——那是同一件事的第二套算法，迟早和 byRule 对不上。
    // T12 没有被问过的成交时分母减 1（方案 B），否则会出现「13 条里 X 条不一致」把没判的算进去。
    const t12Judged = !!(ev && ev.t12 && +ev.t12.asked > 0);
    const totalJudged = cfgIds.filter((id) => (id === 'T12' ? t12Judged : true)).length;
    const entry = { total: totalJudged, mismatch: byRuleRows.filter((r) => +r.inconsistent > 0).length };

    const lab = layoutLabels(labelList, geom, o.expanded || '');

    // 内联标签：一套颜色与避让；离锚点 >14px 时补一条 30% 不透明的引导线。
    g.font = FONT_LABEL;
    lab.drawn.forEach((d) => {
      if (Math.abs(d.y - d.ay) > 14) {
        g.globalAlpha = 0.3;
        g.strokeStyle = T.textWeak;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(d.ax, d.ay);
        g.lineTo(d.ax, d.ay + (d.y > d.ay ? 1 : -1) * Math.min(18, Math.abs(d.y - d.ay)));
        g.stroke();
        g.globalAlpha = 1;
      }
      // 赭橙只留给「超阈值数值」：价格上限线与资金轨超限/跨线标签。
      // 合并区间（09:40–14:45 · 25 笔）、窗口说明等一律中性深灰，不整片染橙。
      const ORANGE_LABEL = { priceLine: 1, fundBar: 1, fundStep: 1, fundLine: 1, fundWaterfall: 1 };
      g.fillStyle = (d.tone === 'inconsistent' && ORANGE_LABEL[d.type]) ? T.inconsistent : T.text;
      g.fillText(d.text, d.align === 'right' ? d.x - d.w : d.x, d.y);
    });

    // 点按展开：读数块贴在锚点侧边（右优先，放不下翻左），整块避开被标注那一根柱。
    if (lab.callout) {
      const c = lab.callout;
      g.fillStyle = T.bg;
      g.fillRect(c.x, c.y, c.w, c.h);
      g.strokeStyle = T.gridAxis;
      g.lineWidth = 1;
      g.strokeRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1);
      g.font = FONT_CALLOUT;
      g.fillStyle = T.textStrong;
      let txt = c.text;
      while (txt.length > 4 && g.measureText(txt).width > c.w - 12) txt = txt.slice(0, -2) + '…';
      g.fillText(txt, c.x + 6, c.y + c.h / 2 + 4);
    }

    // —— 资金轨 ——
    const fundBars = layers.filter((l) => l.type === 'fundBar');
    const fundSteps = layers.filter((l) => l.type === 'fundStep');
    const fundWater = layers.filter((l) => l.type === 'fundWaterfall');
    const fundLines = layers.filter((l) => l.type === 'fundLine');
    if (fundOn) {
      // 面板之间只留一条 1px 分界线（价格轨底部）；槽内切换不加第二条线。
      g.strokeStyle = T.gridAxis;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(plotLeft, priceBottom); g.lineTo(plotRight, priceBottom); g.stroke();
      if (wide) {
        g.beginPath(); g.moveTo(plotLeft, upTop + upH); g.lineTo(plotRight, upTop + upH); g.stroke();
      }

      const drawUp = () => {
        // 占用轨：满刻度固定 100%，刻度写整数、贴面板内部左侧（第二套坐标系不占价格列右轴）。
        g.strokeStyle = T.gridMinor;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(plotLeft, yUp(0)); g.lineTo(plotRight, yUp(0)); g.stroke();
        // 50% 参照：极弱 1px 线 + 面板内左侧刻度，槽里不再是空的两头数字。
        g.strokeStyle = T.gridMinor;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(plotLeft, yUp(50)); g.lineTo(plotRight, yUp(50)); g.stroke();
        // 上限：只画生效（最低）的那条琥珀虚线（1px，6/3）；其余不画线，折进同一条标签。
        const upLimits = fundLines.filter((l) => l.panel === 'fundUp')
          .slice().sort((a, b) => a.pct - b.pct);
        if (upLimits.length) {
          const y = yUp(upLimits[0].pct);
          g.strokeStyle = T.inconsistent;
          g.lineWidth = 1;
          g.setLineDash([6, 3]);
          g.beginPath(); g.moveTo(plotLeft, y); g.lineTo(plotRight, y); g.stroke();
          g.setLineDash([]);
        }
        // T05 柱：宽按时间跨度折算成 2–3px 细条，贴时间轴排布；未成交时段留空，不补满。
        // 同分钟第 2/3 笔向右错开一条柱宽；>3 笔合并。
        const pxPerMin = step / 5;
        fundBars.filter((l) => l.panel === 'fundUp').forEach((l) => {
          const spanMin = Math.max(1, (minutes(l.toHm) || 0) - (minutes(l.fromHm) || 0));
          const barW = Math.max(2, Math.min(3, spanMin * pxPerMin));
          const slot = l.count > 1 ? 0 : (l.slot || 0);
          const x = xOfHm(l.fromHm) + slot * (barW + 1);
          const y0 = yUp(0), y1 = yUp(l.pct);
          g.fillStyle = l.over ? T.inconsistent : T.text;
          g.fillRect(x - barW / 2, y1, barW, Math.max(1, y0 - y1));
          if (l.overflow) {
            g.fillStyle = T.inconsistent;
            g.beginPath();
            g.moveTo(x, y1 + 6); g.lineTo(x - 3.5, y1 + 1); g.lineTo(x + 3.5, y1 + 1);
            g.closePath(); g.fill();
          }
        });
        // T09 / T10 阶梯：中性 1px；跨线只加环，文字统一走标签系统。
        fundSteps.forEach((l) => {
          const pts = l.pts;
          const xs = pts.map((p) => xOfHm(p.hm));
          // 辅助层：阶梯退到中性 45% 灰，不再用正文黑压过蜡烛；只画在有成交的时间段内，不拉到图边。
          g.strokeStyle = T.text;
          g.globalAlpha = 0.45;
          g.lineWidth = 1;
          const x0 = Math.max(plotLeft, xs[0]);
          const xN = Math.min(plotRight, xs[xs.length - 1]);
          g.beginPath();
          g.moveTo(x0, yUp(0));
          g.lineTo(x0, yUp(pts[0].pct));
          for (let i = 1; i < pts.length; i++) {
            g.lineTo(xs[i], yUp(pts[i - 1].pct));
            g.lineTo(xs[i], yUp(pts[i].pct));
          }
          g.lineTo(xN, yUp(pts[pts.length - 1].pct));
          g.stroke();
          g.globalAlpha = 1;
          // 跨线不再画圆环：390 槽高 57px，环径 12.8 比柱间距还宽，读起来就是噪点。
          // 跨线时刻与超限金额已由文字结论（标签 / 规则浮层）承担。
        });
        // 刻度最后画：底色垫片压住阶梯/柱子，避免 0% 被第一根柱吃掉。
        fundAxisText('0%', yUp(0) - 3);
        fundAxisText('50%', yUp(50) + 3);
        fundAxisText('100%', yUp(100) + 15);
      };

      const drawDown = () => {
        if (!downRule || !(downCap > 0)) {
          g.font = '400 10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
          g.fillStyle = T.textWeak;
          g.fillText('这一天没有动作', plotLeft + 4, downTop + Math.round(downH / 2) + 3);
          return;
        }
        // 亏损轨：0 在顶、向下生长；满刻度 = 上限 × 2；只累亏损，正数不抵扣。
        g.strokeStyle = T.gridAxis;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(plotLeft, yDown(0)); g.lineTo(plotRight, yDown(0)); g.stroke();
        fundLines.filter((l) => l.panel === 'fundDown').forEach((l) => {
          const y = yDown(l.pct);
          g.strokeStyle = T.inconsistent;
          g.lineWidth = 1;
          g.setLineDash([6, 3]);
          g.beginPath(); g.moveTo(plotLeft, y); g.lineTo(plotRight, y); g.stroke();
          g.setLineDash([]);
        });
        let prev = 0;
        downRule.pts.forEach((pt) => {
          const x = xOfHm(pt.hm);
          if (pt.delta > 0) {
            const y1 = yDown(prev), y2 = yDown(pt.cumPct);
            if (pt.unknown) {
              g.strokeStyle = T.undetermined;
              g.lineWidth = 1;
              g.setLineDash([2, 2]);
              g.strokeRect(x - 2.5, Math.min(y1, y2), 5, Math.max(1, Math.abs(y2 - y1)));
              g.setLineDash([]);
            } else {
              g.fillStyle = T.down;
              g.fillRect(x - 2.5, Math.min(y1, y2), 5, Math.max(1, Math.abs(y2 - y1)));
            }
            if (pt.cumPct > downCap) {
              g.fillStyle = T.inconsistent;
              g.beginPath();
              g.moveTo(x, downTop + downH - 5); g.lineTo(x - 3.5, downTop + downH - 1); g.lineTo(x + 3.5, downTop + downH - 1);
              g.closePath(); g.fill();
            }
          }
          prev = pt.cumPct;
        });
        // 刻度最后画：底色垫片压住阶梯/柱子。
        fundAxisText('0', yDown(0) + 15);
        fundAxisText(fmtPct(downRule.limitPct), yDown(downRule.limitPct) + 3);
      };

      if (wide) { drawUp(); drawDown(); }
      else if (activeFund === 'fundDown') drawDown();
      else drawUp();
    }

    // 空态：资金槽居中一行细体说明（槽高不因空态改变）。
    if (noCapital) {
      g.strokeStyle = T.gridAxis;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(plotLeft, priceBottom); g.lineTo(plotRight, priceBottom); g.stroke();
      g.font = '400 10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      g.fillStyle = T.textWeak;
      const msg = '未填本金 · 资金轨不绘制';
      g.fillText(msg, plotLeft + (innerW - g.measureText(msg).width) / 2, fundTop + Math.round(fundH / 2) + 3);
    }

    // 时间带名字最后画：压在蜡烛/网格之上，10px、45% 深灰，只做标注不抢数据。
    if (bandTexts.length) {
      g.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      g.fillStyle = T.text;
      g.globalAlpha = 0.45;
      bandTexts.forEach((t) => {
        const tw = g.measureText(t.text).width;
        // 优先贴带左缘；会越出画布右边界时，改成贴带右缘向左排。
        const x = (t.x + tw <= plotRight) ? t.x : Math.max(plotLeft + 2, t.xr - tw - 2);
        g.fillText(t.text, x, priceBottom - 6);
      });
      g.globalAlpha = 1;
    }

    // 浮层里点某一条 → 画布对应位置亮一下（扫一遍就清，不做滚动跳转）。
    const hiIds = Array.isArray(o.highlight) ? o.highlight : [];
    if (hiIds.length) {
      g.strokeStyle = T.accent;
      g.lineWidth = 2;
      hiIds.forEach((id) => {
        const h = hits.filter((x) => x.id === id)[0];
        if (!h) return;
        g.strokeRect(Math.max(1, h.x - 3), Math.max(1, h.y - 3),
          Math.min(innerW, h.w + 6), Math.max(6, h.h) + 6);
      });
      g.lineWidth = 1;
    }

    return {
      bars: bars, total: bars.length,
      hits: hits, sheet: sheet, entry: entry, highlight: hiIds.slice(), marks: marks,
      labels: lab.drawn.length, labelTotal: labelList.length, labelMerged: lab.merged,
      panels: wide ? (fundOn ? 3 : 1) : (fundSlot ? 2 : 1),
      panel: wide ? 'all' : activeFund,
      priceHeight: priceH, fundHeight: fundSlot ? fundH : 0, fundTop: fundSlot ? fundTop : 0,
      badges: panelBadges(layers),
      hitRects: lab.rects, band: lab.band, bandPage: lab.bandPage, callout: lab.callout,
      labelBoxes: lab.drawn.map((d) => ({ id: d.id, panel: d.panel, x: d.x, y: d.y, w: d.w, align: d.align })),
      funds: { on: fundOn, bars: fundBars.length, steps: fundSteps.length, waterfall: fundWater.length, lines: fundLines.length },
    };
  }

  /* ================= 页面 ================= */
  function stateBadge(ev) {
    if (ev.overall === 'noActions') {
      return { text: '无动作', cls: 'rv-na', note: '这一天没有与该标的相关的动作，规则无法观察。' };
    }
    if (ev.overall === 'mismatch') {
      const n = ev.actions.filter((a) => a.state === 'mismatch').length;
      // 笔数是行为（N 笔），规则数是审计项（一条规则最多记一次）。
      // 规则数直接取 byRule：资金跨线在 evaluate 里已经写进 byRule，徽标与画布入口天然同源。
      const rules = (ev.byRule || []).filter((r) => +r.inconsistent > 0).length;
      return { text: STATE_LABEL.mismatch, cls: 'rv-bad', note: n + ' 笔触发 · 落在 ' + rules + ' 条规则上。' };
    }
    if (ev.overall === 'consistent') {
      return { text: STATE_LABEL.consistent, cls: 'rv-ok', note: '已判定的规则都没有触发。' };
    }
    return { text: STATE_LABEL.unknown, cls: 'rv-warn', note: '判定条件不全，本页不给「一致」结论。' };
  }

  function mount(el, opts) {
    if (!el) return null;
    const o = opts || {};
    const R = o.replay || (root && root.PanjiReplay);
    if (!R || !o.idx) return null;
    const store = (function () {
      try { if (root && root.localStorage) return root.localStorage; } catch (e) { /* 私密模式 */ }
      return null;
    })();
    const source = o.source || createBuiltinSource({ replay: R, idx: o.idx, ticket: o.ticket });
    const cases = readCases(store, o.cases);
    const q = o.query || {};
    const st = {
      code: normSym(q.symbol) || (source.symbols[0] ? source.symbols[0].code : ''),
      day: day8(q.date),
      days: [],
      account: '',
      dayPack: null,
      loading: false,
      reqSeq: 0,
    };
    let dirList = DIR_CACHE;

    el.innerHTML = '<div class="rv-bar">'
      + '<div class="rv-title"><b id="rv-name" class="rv-name" hidden></b>'
      + '<input id="rv-q" class="rv-search" type="search" autocomplete="off" '
      + 'placeholder="代码或名称" value="' + esc(st.code) + '"></div>'
      + '<select id="rv-day" class="rv-day" aria-label="选择日期"></select>'
      + '</div><div class="rv-sug" id="rv-sug" hidden></div><div id="rv-body"></div>';
    const qEl = el.querySelector('#rv-q');
    const dayEl = el.querySelector('#rv-day');
    const sugEl = el.querySelector('#rv-sug');
    const body = el.querySelector('#rv-body');

    function setNote(text) {
      if (typeof o.onState === 'function') o.onState({ text: text });
    }

    function loadDays() {
      st.days = [];
      dayEl.innerHTML = '<option value="">读取中…</option>';
      return Promise.resolve(source.loadDays(st.code)).then((days) => {
        st.days = Array.isArray(days) ? days : [];
        if (!st.day || st.days.indexOf(st.day) < 0) st.day = st.days[0] || st.day || '';
        dayEl.innerHTML = st.days.length
          ? st.days.map((d) => '<option value="' + d + '"' + (d === st.day ? ' selected' : '') + '>' + d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + '</option>').join('')
          : '<option value="">无本地日期</option>';
      }).catch(() => {
        st.days = [];
        dayEl.innerHTML = '<option value="">无本地日期</option>';
      });
    }

    function renderBody() {
      const seq = ++st.reqSeq;
      body.innerHTML = '<p class="sub">正在读取 ' + esc(st.code) + (st.day ? ' · ' + esc(st.day) : '') + '…</p>';
      const p = Promise.resolve(source.loadDay(st.code, st.day));
      return p.then((res) => {
        if (seq !== st.reqSeq) return;
        st.dayPack = res && res.status === 'ok' ? res : null;
        paintBody(seq);
      }).catch(() => {
        if (seq !== st.reqSeq) return;
        st.dayPack = null;
        paintBody(seq);
      });
    }

    function paintBody(seq) {
      const dp = st.dayPack;
      const code = st.code;
      const day = st.day;
      // 同日同票多账户：按账户分别取线、分别判定，绝不混算
      const accts = accountsFor(cases, code, day);
      if (accts.indexOf(st.account) < 0) st.account = accts[0] || '';
      const off = linesFor(cases, code, day, st.account);
      const ev = evaluate({
        verdict: off.verdict,
        lines: off.lines,
        account: st.account,
        barCount: dp ? (dp.bars || []).length : 0,
        bars: dp ? (dp.bars || []) : [],
        code: code,
        day: day,
      });
      const b = stateBadge(ev);
      const name = (dp && dp.name) || '';
      const head = name && name !== code ? name + ' ' + code : code;
      const nameEl = el.querySelector('#rv-name');
      if (nameEl) {
        nameEl.hidden = !(name && name !== code);
        if (name && name !== code) nameEl.textContent = name;
      }
      setNote(head + (day ? ' · ' + day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6, 8) : '') + ' · 1 分钟聚合 5 分钟 · 不构成投资建议');

      let html = '';
      // hero：当日已实现（本机档案 FIFO 复算），无动作也写 0.00，不用 — 占位
      if (dp) {
        const heroCls = ev.netPnl > 0 ? ' is-up' : (ev.netPnl < 0 ? ' is-down' : '');
        html += '<div class="rv-hero' + heroCls + '">' + fmtHeroMoney(ev.netPnl) + '</div>'
          + '<p class="rv-hero-sub">' + (ev.sellCount ? '当日动作 · 元' : '当日无动作') + '</p>';
      }
      html += '<div class="rv-badge ' + b.cls + '">' + b.text + '</div><p class="rv-verdict-note">' + b.note + '</p>';

      if (accts.length > 1) {
        html += '<div class="rv-acct"><label for="rv-acct-sel">账户</label>'
          + '<select id="rv-acct-sel" class="rv-day">'
          + accts.map((a) => '<option value="' + esc(a) + '"' + (a === st.account ? ' selected' : '') + '>'
            + esc(a === '' ? '默认账户' : a) + '</option>').join('')
          + '</select></div>';
      }

      if (!dp) {
        const isKnown = source.hasCode && source.hasCode(code);
        if (isKnown) {
          html += '<div class="rv-miss"><b>这一天本地没有分片</b>'
            + '这只票在 50 只样本里，但这天不在内置窗口内。换一个日期再试；完整复盘在 App 内。'
            + '<br>可选：' + (st.days.length ? st.days.slice(0, 6).map((d) => d.slice(4, 6) + '-' + d.slice(6, 8)).join('、') : '无') + '。</div>';
        } else {
          html += '<div class="rv-app"><b>该股完整复盘在 App 内</b>'
            + 'H5 内置 50 只有历史分片的样本；' + esc(code) + ' 目前没有本地走势，规则叠层画不出来。'
            + '<br>换一只样本票可以先看叠层效果。</div>';
        }
      } else {
        html += '<div class="rv-chart-wrap">'
          + '<canvas id="rv-chart" class="rv-chart"></canvas>'
          + '<div class="rv-seg" id="rv-seg" hidden>'
          + '<button type="button" data-panel="fundUp" aria-pressed="true">占用<i class="rv-seg-dot"></i></button>'
          + '<button type="button" data-panel="fundDown" aria-pressed="false">亏损<i class="rv-seg-dot"></i></button>'
          + '</div>'
          + '<div class="rv-mask" id="rv-mask" hidden></div>'
          + '<div class="rv-sheet" id="rv-sheet" hidden role="dialog" aria-label="规则明细">'
          + '<div class="rv-sheet-grip"></div>'
          + '<div class="rv-sheet-h"><b>规则明细</b><span>点一条，画布上对应位置亮一下</span></div>'
          + '<div class="rv-sheet-body" id="rv-sheet-body"></div>'
          + '</div>'
          + '<div class="rv-pop" id="rv-pop" hidden></div>'
          + '<button type="button" class="rv-entry" id="rv-entry" aria-expanded="false">'
          + '<span class="rv-entry-txt" id="rv-entry-txt"></span>'
          + '<span class="rv-entry-arrow">›</span></button>'
          + '</div>';
      }

      if (ev.notes.length) {
        const coverWarn = !!(ev.missingCapital || (ev.coverage && (ev.coverage.missingOpen || ev.coverage.missingClose)) || ev.overall === 'unknown');
        html += '<div class="rv-cover' + (coverWarn ? ' is-warn' : '') + '"><b>数据覆盖</b>'
          + ev.notes.map((t) => '<p>' + esc(t) + '</p>').join('') + '</div>';
      }

      html += '<div class="rv-rules"><b>本页叠层的四条</b>';
      FORM_RULES.forEach((id) => {
        const r = ev.form.find((x) => x.id === id);
        let tail = '未勾选';
        if (r) {
          if (id === 'T01') tail = '09:30–' + hhmm(570 + (+r.params.waitMin || 0));
          else if (id === 'T02') tail = hhmm(900 - (+r.params.endMin || 0)) + '–15:00';
          else if (id === 'T03') tail = ev.buyCount >= 2 ? '首笔 ' + fmtPrice(ev.firstBuyPrice) + ' · 须落在开盘窗口内' : '当日仅 ' + ev.buyCount + ' 笔，不适用（须首笔落在开盘窗口内）';
          else if (id === 'T04') tail = ev.buyCount >= 2 ? '以首笔 ' + fmtPrice(ev.firstBuyPrice) + ' 为参照' : '当日仅 ' + ev.buyCount + ' 笔，不适用';
        }
        html += '<div class="rv-rule' + (r ? '' : ' off') + '"><b>' + id + '</b>'
          + '<span class="rv-rn">' + esc(FORM_NAME[id]) + '</span>'
          + '<span class="rv-rt">' + esc(tail) + '</span></div>';
      });
      html += '</div>';

      const otherIds = ev.other.map((r) => r.id).concat(ev.capitalCfg.map((r) => r.id));
      if (otherIds.length) {
        html += '<p class="rv-other">另有 ' + otherIds.length + ' 条规则（' + esc(otherIds.join('、')) + '）在报告里判定，本页不叠层。</p>';
      }

      if (ev.actions.length) {
        html += '<div class="rv-acts"><b>这一天的动作</b>';
        ev.actions.forEach((a, i) => {
          html += '<div class="rv-act ' + a.state + '"><span class="rv-time">' + esc(a.hm || '无时间') + '</span>'
            + '<span class="rv-price">' + fmtPrice(a.price) + '</span>'
            + '<span class="rv-st">' + esc(STATE_LABEL[a.state]) + '</span>'
            + '<span class="rv-why">' + esc(a.why) + '</span></div>';
        });
        html += '</div>';
      }

      html += '<p class="rv-foot">判定直接读这一天的档案结论，不在页面上重算。未填本金或数据不全时，不给确定性结论。</p>';

      const PS = root && root.PanjiStore;
      const hasCode = !!(code && day && source.hasCode && source.hasCode(code));
      const canSave = !!(PS && ev.hasVerdict && code && day);
      const arch = PS ? PS.readArchive(code) : null;
      const stat = archiveStat(arch);
      const archRec = archivedRec(arch, day, st.account);
      let saveHint;
      if (!PS) saveHint = '档案模块没加载，刷新页面再试。';
      else if (!ev.hasVerdict) saveHint = '这一天没有档案判定，先导入交割单再存档。';
      else if (!hasCode) saveHint = '这只票没有本地分片，仍可把档案结论存进这只票的档案。';
      else saveHint = '存入后，这只票的档案会多一条按交易日倒序的记录。';
      html += '<div class="rv-store"><div class="rv-store-h"><b>存进这只票的档案</b>'
        + '<span>' + (stat.times ? '已存档 ' + stat.times + ' 次 / ' + stat.days + ' 天' : '还没存过') + '</span></div>'
        + '<div class="rv-save-row"><input id="rv-note" class="rv-note" type="text" maxlength="200"'
        + ' placeholder="批注（可选，只存本机）" value="' + esc((archRec && archRec.note) || '') + '">'
        + '<button type="button" id="rv-save"' + (canSave ? '' : ' disabled') + '>存进档案</button></div>'
        + '<p class="rv-store-note" id="rv-store-note">' + esc(saveHint) + '</p>'
        + '<a class="rv-archive" href="' + archiveHref(code, name, day, st.account) + '">查看这只票的档案 →</a>'
        + '</div>';
      body.innerHTML = html;

      const acctSel = body.querySelector('#rv-acct-sel');
      if (acctSel) {
        acctSel.addEventListener('change', () => {
          st.account = acctSel.value;
          renderBody();
        });
      }

      const saveBtn = body.querySelector('#rv-save');
      if (saveBtn && canSave) {
        saveBtn.addEventListener('click', () => {
          const noteEl = body.querySelector('#rv-note');
          const noteP = body.querySelector('#rv-store-note');
          const vd = off.verdict || {};
          const t05 = (vd.rules || []).filter((r) => r.id === 'T05')[0];
          const t05MaxPct = t05 && t05.params && t05.params.maxPct != null ? +t05.params.maxPct : null;
          const res = PS.writeReview({
            code: code,
            name: name,
            day: day,
            account: st.account,
            rules: {
              id: 'rules_v1', version: 1, ids: (ev.cfgIds || []).slice(), byRule: (ev.byRule || []).slice(),
              calcVersion: 2,
              calcSpec: { t05MaxPct: t05MaxPct, t07Mode: 'dual', pack: 'v1' },
            },
            counts: countsOfActions(ev),
            note: noteEl ? noteEl.value.trim() : '',
            source: { trades: ledgerTradesOn(store, code, day), watch: false, daily: true, minute: dp ? 'builtin' : 'none' },
          });
          if (res && res.ok) {
            saveBtn.disabled = true;
            saveBtn.textContent = '已存入';
            const stat2 = archiveStat(res.archive);
            const hSpan = body.querySelector('.rv-store-h span');
            if (hSpan) hSpan.textContent = stat2.times ? '已存档 ' + stat2.times + ' 次 / ' + stat2.days + ' 天' : '还没存过';
            if (noteP) {
              noteP.className = 'rv-store-note good';
              noteP.textContent = '已存入档案 · 这只票共 ' + stat2.times + ' 次复盘 / ' + stat2.days + ' 天。';
            }
          } else if (noteP) {
            noteP.className = 'rv-store-note bad';
            noteP.textContent = '存入失败：' + ((res && res.error) || '未知原因') + '。';
          }
        });
      }

      const cv = body.querySelector('#rv-chart');
      if (cv && dp) {
        const seg = body.querySelector('#rv-seg');
        const entryEl = body.querySelector('#rv-entry');
        const entryTxt = body.querySelector('#rv-entry-txt');
        const sheetEl = body.querySelector('#rv-sheet');
        const sheetBody = body.querySelector('#rv-sheet-body');
        const maskEl = body.querySelector('#rv-mask');
        const popEl = body.querySelector('#rv-pop');
        const btns = seg ? Array.prototype.slice.call(seg.querySelectorAll('button')) : [];
        let mode = 'fundUp';
        let expanded = '';
        let last = null;
        let open = false;
        let activePop = '';
        let highlight = [];
        let hlTimer = 0;
        let sheetKey = '';
        const toneCls = (tone) => (tone === 'inconsistent' ? 'bad' : (tone === 'consistent' ? 'ok' : 'na'));
        // 底边入口：常驻一行，不随规则多少消失。
        const paintEntry = (res) => {
          if (!entryEl) return;
          const e = res.entry || { total: 0, mismatch: 0 };
          const txt = e.total + ' 条规则' + (e.mismatch ? ('里有 ' + e.mismatch + ' 条不一致') : ' · 无异常');
          if (entryTxt.textContent !== txt) entryTxt.textContent = txt;
          entryEl.classList.toggle('has-bad', !!e.mismatch);
          entryEl.hidden = false;
        };
        // 浮层内容：价位线 / 时间带 / 文字结论 三组，组内一条一行。
        const paintSheet = (res) => {
          if (!sheetBody) return;
          const s = res.sheet || { lines: [], bands: [], notes: [] };
          const key = JSON.stringify(s);
          if (key === sheetKey) return;
          sheetKey = key;
          const names = { lines: '价位线', bands: '时间带', notes: '文字结论' };
          sheetBody.innerHTML = ['lines', 'bands', 'notes'].map((k) => {
            const rows = s[k] || [];
            if (!rows.length) return '';
            return '<div class="rv-grp"><h4>' + names[k] + '</h4>'
              + rows.map((r) => '<button type="button" class="rv-row" data-group="' + k
                + '" data-row="' + esc(r.id) + '"><span class="rv-row-n">' + esc(r.name)
                + '</span><span class="rv-row-p">' + esc(r.param || '') + '</span>'
                + '<i class="rv-dot ' + toneCls(r.tone) + '"></i></button>').join('')
              + '</div>';
          }).join('');
          sheetBody.querySelectorAll('[data-row]').forEach((b) => b.addEventListener('click', () => {
            const rows = (last && last.sheet && last.sheet[b.getAttribute('data-group')]) || [];
            const row = rows.filter((x) => x.id === b.getAttribute('data-row'))[0];
            if (!row || !row.hitIds || !row.hitIds.length) return;
            clearTimeout(hlTimer);
            // 浮层占画布 60% 且带遮罩，开着时高亮看不见：先收起（200ms linear），再亮 200ms
            setOpen(false);
            setTimeout(() => {
              highlight = row.hitIds.slice(0, 3);
              draw();
              hlTimer = setTimeout(() => { highlight = []; draw(); }, 200);
            }, 220);
          }));
        };
        const draw = () => {
          const res = drawReview(cv, dp.bars || [], ev, { panel: mode, expanded: expanded, highlight: highlight });
          last = res;
          if (root) root.__rvLast = res;
          if (!res) return;
          if (seg) {
            seg.hidden = res.panels === 3 || !res.fundHeight;
            if (!seg.hidden) seg.style.top = res.fundTop + 'px';
            btns.forEach((b) => {
              const key = b.getAttribute('data-panel');
              b.setAttribute('aria-pressed', key === mode ? 'true' : 'false');
              if (res.badges && res.badges[key]) b.classList.add('has-badge');
              else b.classList.remove('has-badge');
            });
          }
          paintEntry(res);
          paintSheet(res);
        };
        function toggle(id) {
          expanded = (id && id !== expanded) ? id : '';
          draw();
        }
        // —— 规则浮层：入口一行；遮罩 / 下拖 / 再点入口都能关 ——
        const setOpen = (v) => {
          open = !!v;
          if (!sheetEl || !maskEl) return;
          if (open) {
            sheetEl.hidden = false;
            maskEl.hidden = false;
            sheetEl.style.maxHeight = Math.round(cv.clientHeight * 0.6) + 'px';
            sheetEl.style.transform = '';
          }
          const apply = () => {
            sheetEl.classList.toggle('on', open);
            maskEl.classList.toggle('on', open);
          };
          if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(apply);
          else apply();
          if (entryEl) entryEl.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (!open) {
            setTimeout(() => {
              if (open) return;
              sheetEl.hidden = true;
              maskEl.hidden = true;
            }, 200);
          }
        };
        if (entryEl) entryEl.addEventListener('click', () => setOpen(!open));
        if (maskEl) maskEl.addEventListener('click', () => setOpen(false));

        // 下拖关闭：>40px 收起，否则回弹。动效只有 200ms linear 一档。
        let dragStart = 0, dragY = 0, dragging = false, pid = null;
        const dragDown = (e) => {
          if (!open) return;
          // 不在这里 setPointerCapture：捕获会把 click 重定向到 sheet 容器，行按钮就点不动了
          dragStart = e.clientY; dragY = 0; dragging = true; pid = e.pointerId;
          sheetEl.style.transition = 'none';
        };
        const dragMove = (e) => {
          if (!dragging) return;
          dragY = Math.max(0, e.clientY - dragStart);
          if (dragY > 6 && sheetEl.setPointerCapture && pid != null) {
            try { sheetEl.setPointerCapture(pid); } catch (err) { /* 忽略 */ }
            pid = null;
          }
          sheetEl.style.transform = 'translateY(' + dragY + 'px)';
        };
        const dragUp = () => {
          if (!dragging) return;
          dragging = false;
          sheetEl.style.transition = '';
          if (dragY > 40) setOpen(false);
          else sheetEl.style.transform = '';
          setTimeout(() => { dragY = 0; }, 200);
        };
        if (sheetEl) {
          sheetEl.addEventListener('pointerdown', dragDown);
          sheetEl.addEventListener('pointermove', dragMove);
          sheetEl.addEventListener('pointerup', dragUp);
          sheetEl.addEventListener('pointercancel', dragUp);
          sheetEl.addEventListener('click', (e) => {
            if (dragY > 8) { e.preventDefault(); e.stopPropagation(); }
          }, true);
        }

        // —— 画布点元素：旁边弹小浮窗；点空白 / 再点同一处关闭 ——
        const hitEl = (res, x, y) => {
          let best = null, bestArea = 0;
          (res.hits || []).forEach((h) => {
            const hh = Math.max(6, h.h);
            if (x < h.x || x > h.x + h.w || y < h.y || y > h.y + hh) return;
            const area = h.w * hh;
            if (!best || area < bestArea) { best = h; bestArea = area; }
          });
          return best;
        };
        const overlaps = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
        const hidePop = () => {
          activePop = '';
          if (!popEl) return;
          popEl.hidden = true;
          popEl.setAttribute('data-avoid', '');
        };
        const showPop = (hit) => {
          if (!popEl) return;
          activePop = hit.id;
          popEl.innerHTML = '<b>' + esc(hit.name) + '</b><span class="rv-pop-p">' + esc(hit.param || '') + '</span>'
            + '<i class="rv-dot ' + toneCls(hit.tone) + '"></i>';
          popEl.hidden = false;
          const W = cv.clientWidth, H = cv.clientHeight;
          const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
          // 右优先，右边放不下翻左
          let left = hit.ax + 10;
          let top = Math.max(2, Math.min(H - ph - 2, hit.ay - ph / 2));
          const ar = { x: hit.x, y: hit.y, w: Math.max(4, hit.w), h: Math.max(6, hit.h) };
          if (hit.kind === 'line') {
            // 横贯全宽的阈值线 / 首笔线：两侧都压线，只能放到线的上方或下方
            left = (hit.ax - pw - 10 >= 2) ? (hit.ax - pw - 10) : Math.max(2, W - pw - 2);
            const above = hit.ay - ph - 6;
            top = above >= 2 ? above : Math.min(H - ph - 2, hit.ay + 6);
          } else {
            if (left + pw > W - 2) left = hit.ax - 10 - pw;
            if (left < 2) left = Math.max(2, Math.min(W - pw - 2, hit.ax + 10));
          }
          let pr = { x: left, y: top, w: pw, h: ph };
          // 不许遮住它标注的那根柱：压住就翻到另一侧
          if (hit.kind !== 'line' && overlaps(pr, ar)) {
            const rightL = ar.x + ar.w + 6, leftL = ar.x - pw - 6;
            left = (rightL + pw <= W - 2) ? rightL : Math.max(2, leftL);
            pr = { x: left, y: top, w: pw, h: ph };
          }
          popEl.style.left = Math.round(left) + 'px';
          popEl.style.top = Math.round(top) + 'px';
          popEl.setAttribute('data-avoid', overlaps(pr, ar) ? '0' : '1');
          if (root) root.__rvPop = { avoid: overlaps(pr, ar) ? 0 : 1, left: left, top: top, w: pw, h: ph, ax: hit.ax, ay: hit.ay };
        };
        btns.forEach((b) => b.addEventListener('click', () => {
          mode = b.getAttribute('data-panel') === 'fundDown' ? 'fundDown' : 'fundUp';
          expanded = '';
          hidePop();
          draw();
        }));
        cv.addEventListener('click', (e) => {
          if (!last) return;
          const r = cv.getBoundingClientRect();
          const sx = r.width ? cv.clientWidth / r.width : 1;
          const sy = r.height ? cv.clientHeight / r.height : 1;
          const x = (e.clientX - r.left) * sx;
          const y = (e.clientY - r.top) * sy;
          const hit = hitEl(last, x, y);
          if (hit) {
            if (activePop === hit.id) hidePop();
            else showPop(hit);
            return;
          }
          const lid = hitTest(last, x, y);
          if (lid) { hidePop(); toggle(lid); return; }
          hidePop();
        });
        if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(draw);
        else draw();
      }
    }

    function renderSug(q) {
      const list = dirList || (source.symbols || []);
      const hits = searchDir(list, q, 8);
      if (!q || !hits.length) { sugEl.hidden = true; sugEl.innerHTML = ''; return; }
      sugEl.innerHTML = hits.map((h) => '<button type="button" class="rv-hit" data-code="' + esc(h.code) + '" data-name="' + esc(h.name) + '">'
        + '<b>' + esc(h.code) + '</b><span>' + esc(h.name) + '</span>'
        + (source.hasCode && source.hasCode(h.code) ? '<em>有分片</em>' : '<em class="no">App</em>')
        + '</button>').join('');
      sugEl.hidden = false;
      sugEl.querySelectorAll('.rv-hit').forEach((btn) => {
        btn.addEventListener('click', () => {
          const code = btn.getAttribute('data-code');
          const nm = btn.getAttribute('data-name');
          qEl.value = code + (nm ? ' ' + nm : '');
          st.code = code;
          st.day = '';
          renderSug('');
          loadDays().then(() => renderBody());
        });
      });
    }

    qEl.addEventListener('input', () => {
      const q = qEl.value.trim();
      const direct = normSym(q);
      if (direct && direct.length === 6) {
        st.code = direct;
        st.day = '';
        loadDays().then(() => renderBody());
      }
      if (!dirList) loadDirectory().then((list) => { dirList = list; renderSug(q); });
      else renderSug(q);
    });
    qEl.addEventListener('focus', () => {
      if (!dirList) loadDirectory().then((list) => { dirList = list; renderSug(qEl.value.trim()); });
    });
    dayEl.addEventListener('change', () => {
      st.day = dayEl.value;
      renderBody();
    });

    loadDays().then(() => renderBody());
    return {
      state: () => ({ code: st.code, day: st.day, days: st.days.slice(), overall: null }),
      setSymbol(code, day) {
        st.code = normSym(code) || st.code;
        st.day = day8(day);
        qEl.value = st.code;
        return loadDays().then(() => renderBody());
      },
      _evaluate: evaluate,
    };
  }

  return {
    FORM_RULES, CAPITAL_RULES, FORM_NAME, STATE_LABEL, COLOR, SHORT_NAME, RULE_ORDER,
    aggBars, evaluate, linesFor, accountsFor, archiveStat, archivedRec, archiveHref, readCases, createBuiltinSource,
    buildLayers, pickLabels, drawReview, mount, normSym,
    panelLayout, labelCaps, collectLabels, panelBadges, mergeLabels, layoutLabels, bandPageSize, hitTest,
    stateBadge,
  };
});
