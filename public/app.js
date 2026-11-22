// app.js —— 「管住手了吗」H5 W1 前端逻辑（零依赖）
// 流程：上传→单独同意(PIPL)→客户端压缩→/api/ocr→预填复核页(低置信黄标)→确认→完成页(W2占位)
// W1骨架：复核确认数据存 localStorage（W2判定引擎的消费接口），服务端不留存任何用户数据。

'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ---------- storage 安全读写：被禁（隐私模式/策略）或写满时一律不抛异常 ----------
   读失败返回 null，写失败返回 false；本地存储不可用时由调用方退化为内存态。 */
function lsGet(key) {
  try { const v = localStorage.getItem(key); return v == null ? null : v; } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}
function ssGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function ssSet(key, value) {
  try { sessionStorage.setItem(key, value); return true; } catch { return false; }
}

/* ---------- 判定分步进度：阶段由真实请求驱动，不做百分比假进度 ----------
   读取档案（压缩/取示例）→ 识别成交（/api/ocr）→ 逐笔比对（/api/confirm 判定引擎）→ 出结论
   8 秒后把「当前阶段名」显式写进提示行；window.__panjiPhases 记录各阶段出现时刻，供测试取值。 */
const PHASE_NAMES = ['读取档案', '识别成交', '逐笔比对', '出结论'];
const phase = { start: 0, timer: null, cur: -1, marks: [null, null, null, null] };
window.__panjiPhases = phase.marks;
function phaseTick() {
  const sec = (performance.now() - phase.start) / 1000;
  const secEl = $('#phase-sec');
  if (secEl) secEl.textContent = sec.toFixed(1) + 's';
  const note = $('#phase-note');
  if (note && sec >= 8 && phase.cur >= 0) {
    note.textContent = '已等待 ' + Math.floor(sec) + ' 秒 · 当前阶段：' + PHASE_NAMES[phase.cur] + '（逐笔比对可能需要十几秒，请别关页面）';
  }
}
function phaseSet(i, st) {
  if (phase.marks[i] == null) phase.marks[i] = Math.round(performance.now() - phase.start);
  phase.cur = st === 'active' ? i : phase.cur;
  const lis = $('#phase-list') ? $('#phase-list').children : [];
  for (let k = 0; k < lis.length; k++) {
    lis[k].setAttribute('data-st', k < i ? 'done' : k === i ? st : 'wait');
    const em = lis[k].querySelector('em');
    if (em) em.textContent = k < i ? '已完成' : k === i ? (st === 'active' ? '进行中' : '等待') : '等待';
  }
  phaseTick();
}
function phaseShow() {
  const mask = $('#phase-mask');
  if (!mask) return;
  phase.start = performance.now();
  phase.cur = -1;
  phase.marks = [null, null, null, null];
  window.__panjiPhases = phase.marks;
  $('#phase-note').textContent = '大型交割单要逐笔比对，通常十几秒；请别关页面。';
  // 识别中：遮罩不能压暗识别页，否则 ticket 上的扫描线只剩一层暗底。加标记让 CSS 放行背景，卡片下沉到底部。
  mask.classList.toggle('on-scan', curScreen === '#scr-scan');
  mask.hidden = false;
  if (phase.timer) clearInterval(phase.timer);
  phase.timer = setInterval(phaseTick, 100);
  phaseTick();
}
function phaseHide() {
  const mask = $('#phase-mask');
  if (phase.timer) { clearInterval(phase.timer); phase.timer = null; }
  if (mask) { mask.hidden = true; mask.classList.remove('on-scan'); }
}

const state = {
  trades: [],       // 复核中的成交记录
  scrubbed: 0,      // 服务端丢弃的敏感行数
  timeMissing: false, // 整张截图没有成交时间（页面本身无时间列，非识别失败）
  confirmed: null,  // 确认后的数据
  file: null,
  templates: null,  // 规则模板（服务端 /api/rules 单一来源）
  defaultRules: null,
  pendingJudge: false, // 复核完但还没设规则：保存规则后自动继续判定
  pendingRejudge: false, // 报告页改规则后：保存规则即用同一批交易重判
  lastSnapshot: null,  // 最近一次判定用的交易快照（改规则重判用）
  usingDefaults: false, // 本次用了默认规则（报告页提示可改）
  isDemo: false,       // 本次是示例体验
  expanded: new Set(), // 复核页手动展开的行
  derived: false,      // 是否已做过一次自动补全
  imageUrl: null,      // 复核页对照原图（本地 objectURL 或示例图路径）
  scanLeft: false,     // 识别中用户已按返回离开：结果回来后只入库，不再把人拽回复核页
  imgScale: 1,         // 原图查看器缩放
  payConfig: null,  // 服务端支付配置（required / enabled / price）
  ledger: null,     // 账本（跨次导入合并去重后的全量交易）
};

/* ---------- 账本（localStorage，跨多次导入合并去重，服务端不留存） ---------- */
const LEDGER_KEY = 'guanzhu_ledger';

function ledgerLoad() {
  try {
    const raw = lsGet(LEDGER_KEY);
    if (!raw) return { trades: [], imports: [], dupLog: [] };
    const o = JSON.parse(raw);
    return { trades: o.trades || [], imports: o.imports || [], dupLog: o.dupLog || [] };
  } catch (e) { return { trades: [], imports: [], dupLog: [] }; }
}

// 把本次确认的交易并进账本：重叠区间自动去重，OCR 错字做模糊匹配
function ledgerMerge(trades, importId) {
  if (typeof Ledger === 'undefined' || !Array.isArray(trades) || !trades.length) return null;
  const cur = ledgerLoad();
  const r = Ledger.mergeTrades(cur, trades, { importId: importId || String(Date.now()) });
  lsSet(LEDGER_KEY, JSON.stringify(r.ledger));   // 写失败（配额满/被禁）不阻塞主流程，账本退化为本次会话
  state.ledger = r.ledger;
  return r;
}

function ledgerSummary() {
  if (typeof Ledger === 'undefined') return null;
  return Ledger.summarize(state.ledger || ledgerLoad());
}

function fmtYmd(d) {
  const s = String(d || '');
  if (s.length !== 8) return s;
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

/* ---------- 支付身份与待支付快照（localStorage，服务端只存哈希） ---------- */
const CLIENT_TOKEN_KEY = 'guanzhu_client_token';
const PAY_PENDING_KEY = 'guanzhu_pending_pay';

let memClientToken = null;   // 本机存储不可用时的进程内身份，保证同一次会话 vid 稳定

/* ---------- 隐私同意（本机标记，默认关） ----------
   同意前：不生成 vid、不上报任何事件；同意后：恢复上报并补发一次 view。 */
const CONSENT_KEY = 'guanzhu_privacy_consent_v1';
function consentGiven() {
  try { return lsGet(CONSENT_KEY) === '1'; } catch { return false; }
}
function grantConsent() {
  try { if (!lsGet(CONSENT_KEY)) lsSet(CONSENT_KEY, '1'); } catch {}
}

function getClientToken() {
  if (!consentGiven()) return '';   // 未同意隐私条款前不生成、不读取设备标识
  let token = lsGet(CLIENT_TOKEN_KEY) || memClientToken;
  if (!token) {
    token = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    lsSet(CLIENT_TOKEN_KEY, token);
  }
  memClientToken = token;
  return token;
}

/* ---------- 轻量埋点：事件名 + 渠道 + 匿名设备ID，不记IP、不记交易内容 ---------- */
const TRACK_SRC = (() => {
  const q = new URLSearchParams(location.search);
  const raw = q.get('src') || q.get('ch') || q.get('from') || ssGet('guanzhu_src') || 'direct';
  const src = String(raw).replace(/[^\w\-.]/g, '').slice(0, 32) || 'direct';
  ssSet('guanzhu_src', src);
  return src;
})();
// 第二参数 props 随事件一起上报（服务端是否落盘由服务端决定，前端不再丢弃属性）
function track(event, props) {
  if (!consentGiven()) return;   // 未同意隐私条款前，任何事件都不发（含 view）
  try {
    const body = { event, src: TRACK_SRC, vid: getClientToken() };
    if (props && typeof props === 'object') body.props = props;
    fetch('/api/track', {
      method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {}
}
// 首屏只在「之前已同意」时上报；首次访客等同意后由同意弹窗补发
if (consentGiven()) track('view');
window.PanjiTrack = track;
window.__panjiTrack = track;   // ext.js 的兜底转发入口

function extRun(name, ...args) {
  return (window.PanjiExt && PanjiExt.run) ? PanjiExt.run(name, ...args) : '';
}
function extFirst(name, ...args) {
  return (window.PanjiExt && PanjiExt.first) ? PanjiExt.first(name, ...args) : null;
}

/* ---------- 图鉴第 16–25 格：剩余可接格的点亮信号（只读已存数据与页面结果） ---------- */
function ymd8Local() {
  const d = new Date();
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
function storeKey(name, fallback) {
  try {
    const K = (window.PanjiStore && PanjiStore.KEYS) || null;
    return (K && K[name]) || fallback;
  } catch (e) { return fallback; }
}
function readStoreJson(key, fallback) {
  try {
    const raw = lsGet(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function collUnlock(id, proof) {
  try {
    if (!window.PanjiCollection || typeof PanjiCollection.unlockPending !== 'function') return false;
    const r = PanjiCollection.unlockPending(id, { proof: proof });
    if (r && r.ok && state.verdict) renderRepWall();
    return !!(r && r.ok);
  } catch (e) { return false; }
}
// 交易日历：与 trust.js 同源，同步读取本地 JSON；读不到就不点亮（宁可不亮，不放宽）。
let calDaysCache = null;
function tradingDays8() {
  if (calDaysCache) return calDaysCache;
  const out = [];
  const urls = ['trading_calendar_2026.json', 'trading_calendar_2027.json'];
  try {
    const X = window.XMLHttpRequest;
    if (typeof X === 'function') {
      urls.forEach((u) => {
        try {
          const x = new X();
          x.open('GET', u, false);
          x.send(null);
          if (x.status === 200 || x.status === 0) {
            const obj = JSON.parse(x.responseText);
            if (obj && Array.isArray(obj.tradingDays)) {
              obj.tradingDays.forEach((d) => out.push(String(d).replace(/-/g, '').slice(0, 8)));
            }
          }
        } catch (e) { /* 单个日历读失败跳过 */ }
      });
    }
  } catch (e) { /* 无 XHR 环境 */ }
  calDaysCache = out.sort();
  return calDaysCache;
}
function checkMoodStreak() {
  if (state.isDemo) return;
  const days = tradingDays8().filter((d) => d <= ymd8Local());
  if (days.length < 3) return;
  const last3 = days.slice(-3);
  const map = readStoreJson(storeKey('mood', 'guanzhu_mood_v1'), {});
  const ok = last3.every((d) => map && String(map[d] == null ? '' : map[d]).trim() !== '');
  if (ok) collUnlock('U-019', '连续 3 个交易日记录情绪：' + last3.join(' / '));
}
function checkAssetEntry() {
  if (state.isDemo) return;
  const pos = readStoreJson(storeKey('pos', 'guanzhu_pos_v1'), []);
  const cash = readStoreJson(storeKey('cash', 'guanzhu_cash_v1'), []);
  if ((Array.isArray(pos) && pos.length > 0) || (Array.isArray(cash) && cash.length > 0)) {
    collUnlock('U-025', '资产面板填了 1 条期初持仓或出入金');
  }
}
// 报告渲染后才有回引 / 次日结算结果，所以两条都在 renderReport 末尾判定。
function checkPendingSignals(v) {
  if (state.isDemo || !v) return;
  const echo = document.getElementById('pi-note-echo');
  if (echo) {
    const n = readStoreJson(storeKey('note', 'guanzhu_note_v1'), null);
    const txt = n && String(n.text == null ? '' : n.text).trim();
    if (txt) collUnlock('U-020', '盘前一句话在当天报告原文回引：' + txt.slice(0, 20));
  }
  try {
    const I = window.PanjiFeatures && window.PanjiFeatures.intent;
    if (I && typeof I.getFocus === 'function' && typeof I.settleFocus === 'function') {
      const f = I.getFocus();
      if (f && String(f.date || '') <= ymd8Local()) {
        const s = I.settleFocus(v, f);
        if (s && s.hasDate) collUnlock('U-021', '次日结算 ' + String(s.ruleId || '') + ' · ' + String(s.date || ''));
      }
    }
  } catch (e) { /* 无 intent 环境 */ }
}


function readPendingPay() {
  try {
    const value = JSON.parse(lsGet(PAY_PENDING_KEY) || 'null');
    return value && Array.isArray(value.trades) ? value : null;
  } catch { return null; }
}

function savePendingPay(pending) {
  lsSet(PAY_PENDING_KEY, JSON.stringify(pending));
}

function clearPendingPay() {
  lsRemove(PAY_PENDING_KEY);
}

async function getPayConfig(force = false) {
  if (state.payConfig && !force) return state.payConfig;
  try {
    const res = await fetch('/api/pay/config');
    const data = await res.json();
    if (data.ok) state.payConfig = data;
  } catch { /* 网络失败按未配置处理，不误放行 */ }
  return state.payConfig || { required: false, enabled: false, price: null };
}

/* ---------- 我的规则：localStorage（V1 零账号、零服务端存储） ---------- */
const RULES_KEY = 'guanzhu_rules_v1';
let memRules = null;   // 本机存储不可用/写失败时，本次会话内仍按用户刚设的规则判定

function getConfig() {
  try {
    const c = JSON.parse(lsGet(RULES_KEY) || 'null');
    if (c && Array.isArray(c.rules) && c.rules.length) return c;
  } catch { /* 解析失败走内存兜底 */ }
  return memRules;
}

function updateRuleEntry() {
  const c = getConfig();
  const n = c ? c.rules.length : 0;
  const el = $('#rule-count');
  if (el) el.textContent = n ? `已设 ${n} 条 · 点击修改` : '未设置 · 先定规则，再看复盘';
}

async function loadTemplates() {
  if (state.templates) return state.templates;
  try {
    const r = await fetch('/api/rules');
    const d = await r.json();
    if (d.ok) { state.templates = d.templates; state.defaultRules = (d.defaults && d.defaults.rules) || null; }
  } catch { /* 网络失败走提示 */ }
  // 纯静态预览（无后端）时的兜底：规则模板与默认值走同目录快照，保证示例流程能走完
  if (!state.templates) {
    try {
      const r = await fetch('demo_rules.json');
      const d = await r.json();
      if (d.ok) { state.templates = d.templates; state.defaultRules = (d.defaults && d.defaults.rules) || null; }
    } catch { /* 静态快照也没有就维持原提示 */ }
  }
  return state.templates || [];
}

function renderRulesPage() {
  const box = $('#rule-list');
  const cfg = getConfig();
  const src = cfg ? cfg.rules : (state.defaultRules || []);
  const enabled = new Map(src.map(r => [r.templateId, r.params || {}]));
  $('#capital').value = cfg && cfg.capital ? cfg.capital : '';
  box.innerHTML = state.templates.map((t) => {
    const on = enabled.has(t.id);
    const ps = (t.params || []).map((p) => {
      // 20261105：必填项（T06/T08 频率类）不预填默认值，由用户自己定
      const v = on && enabled.get(t.id)[p.key] != null ? enabled.get(t.id)[p.key] : (p.required ? '' : p.def);
      return `<div class="rule-param"><label>${p.label}</label><input type="number" data-param="${p.key}"
        min="${p.min}" max="${p.max}" step="${p.step}" inputmode="decimal" value="${v}" placeholder="${p.required ? '必填' : ''}" ${on ? '' : 'disabled'}></div>`;
    }).join('');
    // T02 正式名里的 N 落成当前配置值（未勾选时用模板默认值），不新造参数。
    const pv = on ? (enabled.get(t.id) || {}) : {};
    const tName = t.id === 'T02'
      ? t.name.replace('N', String(pv.endMin != null ? pv.endMin : (((t.params || []).find((p) => p.key === 'endMin') || {}).def || 0)))
      : t.name;
    return `<div class="rule-card card${on ? ' on' : ''}" data-id="${t.id}">
      <label class="rule-head"><input type="checkbox" data-check ${on ? 'checked' : ''}>
        <span><b>${t.id}</b> ${tName}</span></label>
      <p class="rule-desc">${t.desc}</p>
      ${ps ? `<div class="rule-params">${ps}</div>` : ''}
    </div>`;
  }).join('');
  const re = $('#rules-ext');
  if (re) re.innerHTML = extRun('rulesBottom', getConfig());
}

$('#btn-rules').addEventListener('click', async () => {
  state.pendingJudge = false;
  await loadTemplates();
  if (!state.templates || !state.templates.length) return toast('规则模板没读到，稍后再试', true);
  renderRulesPage();
  go('#scr-rules');
});

$('#btn-rules-back').addEventListener('click', () => {
  state.pendingJudge = false;
  state.pendingRejudge = false;
  go(state.verdict ? '#scr-done' : '#scr-home');
});

$('#rule-list').addEventListener('change', (e) => {
  if (!e.target.matches('[data-check]')) return;
  const card = e.target.closest('.rule-card');
  card.classList.toggle('on', e.target.checked);
  card.querySelectorAll('input[data-param]').forEach((i) => { i.disabled = !e.target.checked; });
});

$('#btn-rules-save').addEventListener('click', () => {
  const rules = [];
  let missingLabel = '';
  $$('#rule-list .rule-card.on').forEach((card) => {
    const tpl = state.templates.find((t) => t.id === card.dataset.id);
    if (!tpl) return;
    const params = {};
    card.querySelectorAll('input[data-param]').forEach((inp) => {
      const meta = tpl.params.find((p) => p.key === inp.dataset.param);
      // 20261105：必填项（T06/T08）留空不替用户猜，直接提示先填
      if (meta.required && !inp.value.trim()) { missingLabel = meta.label; return; }
      let v = +inp.value;
      if (!Number.isFinite(v)) v = meta.def;
      v = Math.min(meta.max, Math.max(meta.min, v));   // 前端 min/max 校验（后端还会再 clamp 一次）
      inp.value = v;
      params[meta.key] = v;
    });
    rules.push({ templateId: tpl.id, params });
  });
  if (missingLabel) return toast('「' + missingLabel + '」还没填——这一项得由你自己定', true);
  if (!rules.length) return toast('至少勾一条规则——没有规则就没有判定标准', true);
  const cap = +$('#capital').value;
  const capital = Number.isFinite(cap) && cap > 0 ? cap : null;
  const cfg = { rules, capital, savedAt: new Date().toISOString() };
  memRules = cfg;   // 先落内存：本机存储写失败也不会丢用户刚设的规则
  const savedOk = lsSet(RULES_KEY, JSON.stringify(cfg));
  const saveTag = savedOk
    ? `已保存 ${rules.length} 条规则`
    : `规则仅本次生效（本机存储不可用，共 ${rules.length} 条）`;
  updateRuleEntry();
  track('rules_saved');
  extRun('afterRulesSave', { rules, capital });
  // 第 17 格「规则版本」：改动后生成第 2 条版本记录才点亮（同一份规则重复保存不生成新版本）。
  if (!state.isDemo) {
    const hist = readStoreJson(storeKey('rulesHist', 'guanzhu_rules_hist_v1'), []);
    if (Array.isArray(hist) && hist.length >= 2) {
      collUnlock('U-017', '规则版本记录 ' + hist.length + ' 条（改到第 ' + hist.length + ' 版）');
    }
  }
  if (state.pendingRejudge && state.lastSnapshot) {
    state.pendingRejudge = false;
    state.usingDefaults = false;
    toast(`${saveTag}，重新判定…`, !savedOk);
    submitJudge(undefined, state.lastSnapshot);
    return;
  }
  toast(saveTag, !savedOk);
  if (state.pendingJudge) { state.pendingJudge = false; submitJudge(); }
  else go('#scr-home');
});

/* ---------- 屏幕切换 ---------- */
let curScreen = '#scr-home';   // 当前屏：popstate 里用来判断「从哪一屏退出去」
function go(id, opts) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  const thumb = $('#btn-src-thumb');
  if (thumb) thumb.hidden = id !== '#scr-review' || !state.imageUrl;
  if (id === '#scr-home') {
    const he = $('#home-ext');
    if (he) he.innerHTML = extRun('homeTop');
  }
  if (id === '#scr-scan') state.scanLeft = false;   // 每次进识别中都是一轮新任务
  const pmAsk = $('#phase-mask');
  if (pmAsk && id !== '#scr-scan') pmAsk.classList.remove('on-scan');   // 离开识别中后遮罩恢复压暗
  window.scrollTo(0, 0);
  curScreen = id;
  // 屏幕切换写入 history，系统返回键/侧滑返回才能逐层退回上一屏。
  // 「识别中」是过渡屏，不能单独占一层：否则从复核页返回会先落回识别动画，
  // 得再返一次才回首页。所以从识别中出去（成功进复核、失败回首页）一律 replace。
  if (!(opts && opts.pop)) {
    try {
      const st = { panjiScreen: id };
      const onScan = !!(history.state && history.state.panjiScreen === '#scr-scan');
      if ((opts && opts.replace) || onScan || (history.state && history.state.panjiScreen === id)) history.replaceState(st, '');
      else history.pushState(st, '');
    } catch (e) { }
  }
}
// 离开识别中：先把转圈动画和固定遮罩结算掉再切屏。
// 遮罩铺满全屏且层级最高，留着会吞掉之后所有点击，表现就是「卡在动画上」。
function settleScan() {
  state.scanLeft = true;
  phaseHide();
  const s = $('#scan-status');
  if (s) s.textContent = '已取消，可重新上传';
}
window.addEventListener('popstate', (e) => {
  const from = curScreen;
  const st = e.state;
  const id = (st && st.panjiScreen) || '#scr-home';
  if (from === '#scr-scan') settleScan();
  if ($(id)) go(id, { pop: true });
});
try { history.replaceState({ panjiScreen: history.state && history.state.panjiScreen || '#scr-home' }, ''); } catch (e) { }

let toastTimer;
function toast(msg, warn = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (warn ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

/* ---------- 单独同意弹窗 ---------- */
const consent = { privacy: false, agreement: false };
function refreshConsentBtn() {
  const ok = consent.privacy && consent.agreement;
  const el = $('#btn-consent-ok');
  el.setAttribute('aria-disabled', ok ? 'false' : 'true');
}
['privacy', 'agreement'].forEach((k) => {
  $(`#c-${k}`).addEventListener('click', () => {
    consent[k] = !consent[k];
    $(`#c-${k}`).classList.toggle('on', consent[k]);
    refreshConsentBtn();
  });
});

$('#btn-upload').addEventListener('click', () => {
  $('#consent-mask').classList.add('show');
});
$('#btn-cancel').addEventListener('click', () => {
  $('#consent-mask').classList.remove('show');
});
// iOS Safari：程序化 input.click() 会被拦，改成 <label for="file-input"> 原生激活。
// 这里只负责「两项都勾了才放行」与关弹窗，不再调用 .click()。
$('#btn-consent-ok').addEventListener('click', (e) => {
  if (!(consent.privacy && consent.agreement)) {
    e.preventDefault();
    return;
  }
  $('#consent-mask').classList.remove('show');
  const firstConsent = !consentGiven();
  grantConsent();
  if (firstConsent) track('view');   // 同意生效后补发本次会话的 view
});

// 批次 0：把 OCR 识别与入库拆成可复用接口，批次 C 直接复用
const PanjiOcr = {
  async recognize(file) {
    const b64 = await compressImage(file);
    setScan('AI识别中…');
    phaseSet(1, 'active');
    // 识别悬挂时不能无限等：75 秒超时，提示可转手动补录
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 75000);
    let res, data;
    try {
      res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image_base64: b64 }),
        signal: ctl.signal,
      });
      data = await res.json();
    } catch (e) {
      const err = new Error(e && e.name === 'AbortError'
        ? '识别超时（75 秒）——可点「＋ 补一笔」手动录入，或换一张截图'
        : (e.message || '识别请求失败'));
      if (e && e.name === 'AbortError') err.manual = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!data.ok) throw new Error(data.error || '识别失败');
    phaseSet(1, 'done');
    return data;
  },
  ingest(data, opts = {}) {
    // 用户是否还停在识别页。识别是异步的，期间按返回已经离开的话不再自动跳复核页，
    // 否则会出现「点了返回却又被拽走」的错觉。
    const onScan = curScreen === '#scr-scan' && !state.scanLeft;
    const incoming = Array.isArray(data.trades) ? data.trades : [];
    state.trades = opts.append ? state.trades.concat(incoming) : incoming;
    state.scrubbed = (data.meta && data.meta.scrubbed_lines) || 0;
    state.timeMissing = !!(data.meta && data.meta.time_missing);
    state.derived = false;
    // 真实上传也要把本次 OCR 坐标交给 trust.js：判定结果按时间排序，与 OCR 顺序不同，
    // trust.js 自带的签名校验会因此判成「旧坐标」而整批作废（只剩「打开原图 · partial」）。
    // configure({boxes}) 会清掉签名，确保这批坐标与本次档案一起用。
    if (data.boxes && window.PanjiTrust && typeof window.PanjiTrust.configure === 'function') {
      window.PanjiTrust.configure({ boxes: data.boxes });
    }
    if (data.mode && String(data.mode).startsWith('mock')) {
      toast('演示模式：未配置TextIn密钥，使用内置样例数据');
    }
    if (!state.trades.length) {
      // 零识别不再踢回首页：直接进复核页，留空让「＋ 补一笔」真的能用
      autoDerive();
      renderReview();
      track('ocr_empty');
      if (!onScan) { phaseHide(); return data; }
      go('#scr-review');
      phaseSet(2, 'done');
      setTimeout(phaseHide, 350);
      toast('没认出成交记录——点「＋ 补一笔」手动录入', true);
      return data;
    }
    autoDerive();
    renderReview();
    track('ocr_ok');
    if (!onScan) { phaseHide(); return data; }
    go('#scr-review');
    phaseSet(2, 'done');
    setTimeout(phaseHide, 350);
    return data;
  },
};
window.PanjiOcr = PanjiOcr;

$('#file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const hn = $('#home-note'); if (hn) hn.hidden = true;   // 重新开始时收起上一次的失败提示
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) return toast('图片太大，请截图后重试', true);
  // 遮挡预览（可选）：确认或跳过后才进入识别；模块缺失时直接走原路径
  if (window.PanjiMask && typeof window.PanjiMask.open === 'function') {
    window.PanjiMask.open(file, (out) => startUpload(out || file));
    return;
  }
  startUpload(file);
});

async function startUpload(file) {
  state.file = file;
  state.isDemo = false;
  state.expanded = new Set();
  state.derived = false;
  if (state.imageUrl && state.imageUrl.startsWith('blob:')) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = URL.createObjectURL(file);
  track('upload_start');
  go('#scr-scan');
  if (window.PanjiUpload && typeof window.PanjiUpload.handle === 'function') {
    window.PanjiUpload.handle([file]);
    return;
  }
  setScan('压缩上传中…');
  try {
    const data = await PanjiOcr.recognize(file);
    await PanjiOcr.ingest(data);
  } catch (err) {
    phaseHide();
    const msg = err.message || '出错了';
    toast(msg, true);
    // 超时这类「识别没走完」：直接进复核页留白，让「＋ 补一笔」可用
    if (err && err.manual) {
      autoDerive();
      renderReview();
      go('#scr-review');
      return;
    }
    // 空态不能只闪一条 toast：回首页后留一句能照着做的话，不然用户只看到「回去了」
    const note = $('#home-note');
    if (note) {
      note.hidden = false;
      const known = /换一张|补录/.test(msg);
      let text = msg + (known ? '' : ' → 换一张更清晰的截图再试。');
      if (!/[。！？]$/.test(text.trim())) text += '。';
      note.textContent = text + '也可以点「先看示例」，不用传就能看完一整份报告。';
    }
    go('#scr-home');
  }
}

function setScan(txt) { $('#scan-status').textContent = txt; }

/* ---------- 图片压缩：最长边2200px、JPEG 92%（密集交割单要留住末笔成交时间） ---------- */
function compressImage(file) {
  phaseShow(); phaseSet(0, 'active');
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 2200;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let b64 = c.toDataURL('image/jpeg', 0.92).split(',')[1];
      if (!b64) b64 = c.toDataURL('image/png').split(',')[1];
      phaseSet(0, 'done');
      resolve(b64);
    };
    img.onerror = () => { URL.revokeObjectURL(url); phaseHide(); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

/* ---------- 复核页渲染 ---------- */
function fieldHtml(t, i, key, label, val, opts = {}) {
  const lowCls = t.low && t.low[key] ? ' low' : '';
  const ph = opts.ph || '';
  const type = opts.type || 'text';
  const mode = opts.mode || '';
  return `<div class="f${opts.wide ? ' wide' : ''}${lowCls}">
    <label>${esc(label)}</label>
    <input data-i="${i}" data-k="${key}" type="${type}" inputmode="${mode}" placeholder="${esc(ph)}" value="${esc(val ?? '')}">
  </div>`;
}

function missingFields(t) {
  const miss = [];
  if (!t.date) miss.push('日期');
  if (!t.name) miss.push('名称');
  if (!t.side) miss.push('方向');
  if (!(+t.price > 0)) miss.push('成交价');
  if (!(+t.qty > 0)) miss.push('数量');
  return miss;
}

// 用「成交额」把缺的价格/数量补出来；日期用同批已知日期兜底。
// 只在首次进入复核页做一次，用户手动改过就不再覆盖。
function autoDerive() {
  if (state.derived) return;
  state.derived = true;
  const dateFallback = (state.trades.find(t => t.date) || {}).date || '';
  for (const t of state.trades) {
    if (!t.date && dateFallback) t.date = dateFallback;
    const price = +t.price, qty = +t.qty, amount = +t.amount;
    if (amount > 0) {
      if (price > 0 && !(qty > 0)) {
        // 只在能整除时反推数量：除不尽就留空让用户看见黄框，不拿四舍五入的假数字顶上
        const q = amount / price;
        if (q >= 1 && Math.abs(q - Math.round(q)) < 1e-6) {
          t.qty = Math.round(q);
          if (t.low) t.low.qty = false;
        }
      }
      if (qty > 0 && !(price > 0)) {
        t.price = +(amount / qty).toFixed(3);
        if (t.low) t.low.price = false;
      }
    }
    t.needs_fix = needsFix(t);
  }
}

// 多账户分账：asset 开关打开后，复核页每笔都能选一个账户。
// 只有真实档案（非示例）且至少 2 个不同账户才会点亮第 24 格。
function acctOn() {
  try { return !!(window.PanjiFlag && window.PanjiFlag('asset')); } catch (e) { return false; }
}

function acctSel(t, i) {
  if (!acctOn()) return '';
  const cur = t.account || 'default';
  const opts = [['default', '普通'], ['credit', '信用'], ['other', '其他']]
    .map(([v, label]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`).join('');
  return `<select class="acct-select t-acct" data-acct="${i}" aria-label="这笔的账户" style="height:28px;min-width:72px;font-size:11.5px;padding:0 4px;">${opts}</select>`;
}

// 方向徽标：读不准时显示「方向待定」，绝不默认成买入
function sideBadge(t) {
  const cls = t.side === '卖' ? 'sell' : t.side === '买' ? 'buy' : 'unknown';
  const txt = t.side === '卖' ? '卖出' : t.side === '买' ? '买入' : '方向待定';
  return `<span class="t-side ${cls}">${txt}</span>`;
}

function compactTradeHtml(t, i) {
  const when = [t.date, t.time].filter(Boolean).join(' ');
  const money = (+t.price > 0 && +t.qty > 0) ? `${t.price}元 × ${t.qty}股` : '';
  return `<div class="trade compact" data-i="${i}">
    <div class="t-top">
      <span class="t-idx">笔${i + 1}</span>
      ${sideBadge(t)}
      ${acctSel(t, i)}
      <div class="t-sum">
        <b>${esc(t.name || '')}${t.code ? ' ' + esc(t.code) : ''}</b>
        <span>${esc(when)}${money ? ' · ' + money : ''}</span>
      </div>
      <button class="t-edit" data-edit="${i}">改</button>
      <button class="t-del" data-del="${i}" aria-label="删除这笔">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a1.6 1.6 0 0 1-1.6 1.5H8.6A1.6 1.6 0 0 1 7 20L6 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>`;
}

function tradeHtml(t, i) {
  if (!needsFix(t) && !state.expanded.has(i)) return compactTradeHtml(t, i);
  const mismatch = t.low && t.low.mismatch
    ? `<div style="grid-column:1/-1;font-size:11px;color:var(--warn);padding:0 2px;">${t.side ? '※ 价格×数量 对不上金额，请帮忙核对' : '※ 发生金额与「成交金额±费用」对不上，这条方向读不准，请手动选买卖'}</div>` : '';
  const miss = missingFields(t);
  return `<div class="trade" data-i="${i}">
    <div class="t-top">
      <span class="t-idx">笔${i + 1}</span>
      ${sideBadge(t)}
      ${acctSel(t, i)}
      <button class="t-del" data-del="${i}" aria-label="删除这笔">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a1.6 1.6 0 0 1-1.6 1.5H8.6A1.6 1.6 0 0 1 7 20L6 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    ${miss.length ? `<div class="t-miss">还缺：${miss.join('、')}——填完这笔才能归档</div>` : ''}
    <div class="f-grid">
      ${fieldHtml(t, i, 'date', '日期', t.date, { ph: '2026-10-09' })}
      ${fieldHtml(t, i, 'time', '时间', t.time, { ph: '09:34', mode: 'text' })}
      <div class="f wide" style="gap:8px">
        ${fieldHtml(t, i, 'name', '名称', t.name, { ph: '示例材料' })}
        ${fieldHtml(t, i, 'code', '代码', t.code, { ph: '600001', mode: 'numeric' })}
      </div>
      <div class="f"><label>方向</label>
        <div class="seg" data-i="${i}" data-k="side">
          <button data-v="买" class="${t.side === '买' ? 'on buy' : ''}">买</button>
          <button data-v="卖" class="${t.side === '卖' ? 'on sell' : ''}">卖</button>
        </div>
      </div>
      ${fieldHtml(t, i, 'qty', '数量（股）', t.qty, { ph: '必填', mode: 'numeric' })}
      ${fieldHtml(t, i, 'price', '成交价', t.price, { ph: '必填', mode: 'decimal' })}
      <div class="f"><label>　</label><input style="visibility:hidden" tabindex="-1"></div>
    </div>
    ${mismatch}
  </div>`;
}

function renderReview() {
  const list = $('#trade-list');
  list.innerHTML = state.trades.map(tradeHtml).join('');
  renderChips();
  const rt = $('#rev-ext-top');
  if (rt) rt.innerHTML = extRun('reviewTop', state);
  const n = state.scrubbed;
  const empty = $('#review-empty');
  if (empty) empty.hidden = state.trades.length > 0;
  $('#scrub-note').hidden = n === 0;
  $('#scrub-n').textContent = n;
  $('#time-note').hidden = !state.timeMissing;
  $('#btn-src-thumb').hidden = !state.imageUrl || !$('#scr-review').classList.contains('active');
  if (state.imageUrl) $('#src-thumb-img').src = state.imageUrl;
}

function renderChips() {
  const ts = state.trades;
  const buys = ts.filter(t => t.side === '买').length;
  const sells = ts.filter(t => t.side === '卖').length;
  const unknown = ts.filter(t => !t.side).length;   // 方向读不准：单独计数，不计入买/卖
  const fix = ts.filter(needsFix).length; // 与确认按钮口径一致：时间缺失不算阻塞项
  $('#rev-chips').innerHTML =
    `<span class="chip">共 <b>${ts.length}</b> 笔</span>` +
    `<span class="chip">买入 <b>${buys}</b> 笔</span>` +
    `<span class="chip">卖出 <b>${sells}</b> 笔</span>` +
    (unknown ? `<span class="chip fix">方向待定 <b>${unknown}</b> 笔</span>` : '') +
    `<span class="chip${fix ? ' fix' : ' zero'}">${fix ? `<b>${fix}</b> 笔待你补录` : '无待补录项 ✓'}</span>`;
}

/* 复核页交互：事件委托统一处理 */
$('#trade-list').addEventListener('input', (e) => {
  const i = +e.target.dataset.i, k = e.target.dataset.k;
  if (Number.isNaN(i) || !k) return;
  let v = e.target.value.trim();
  if (k === 'qty') { v = v.replace(/[^\d]/g, ''); e.target.value = v; state.trades[i].qty = v ? +v : null; }
  else if (k === 'price') { v = v.replace(/[^\d.]/g, ''); e.target.value = v; state.trades[i].price = v ? +v : null; }
  else if (k === 'code') { v = v.replace(/[^\dA-Za-z]/g, '').slice(0, 6); e.target.value = v; state.trades[i].code = v || null; }
  else state.trades[i][k] = v || null;
  if (state.trades[i].low && k in state.trades[i].low) {
    state.trades[i].low[k] = !v;                        // 补录后摘掉黄标
    e.target.closest('.f').classList.toggle('low', !v);
  }
  state.trades[i].needs_fix = needsFix(state.trades[i]);
  renderChips();
});

$('#trade-list').addEventListener('change', (e) => {
  const sel = e.target && e.target.closest ? e.target.closest('[data-acct]') : null;
  if (!sel) return;
  const i = +sel.dataset.acct;
  if (Number.isNaN(i) || !state.trades[i]) return;
  state.trades[i].account = sel.value;
});

$('#btn-help').addEventListener('click', () => { track('help_demo'); go('#scr-demo'); });

/* ---------- 示例体验：不传自己的数据也能看一份完整报告 ---------- */
async function startDemo() {
  track('sample_start');
  const hn = $('#home-note'); if (hn) hn.hidden = true;   // 走示例就收起上传失败提示，别两句话打架
  state.isDemo = true;
  state.expanded = new Set();
  state.derived = false;
  state.usingDefaults = false;
  state.imageUrl = 'sample/demo_jiaogedan.jpg';
  const scanT0 = Date.now();
  go('#scr-scan');
  setScan('正在加载示例…');
  try {
    let d = null;
    try {
      const res = await fetch('/api/demo');
      const j = await res.json();
      if (j && j.ok) d = j;
    } catch { /* 无后端时走静态快照 */ }
    if (!d) {
      const res = await fetch('demo_data.json');
      d = await res.json();
    }
    if (!d.ok) throw new Error(d.error || '示例没读到');
    state.trades = d.trades || [];
    state.scrubbed = (d.meta && d.meta.scrubbed_lines) || 0;
    state.timeMissing = !!(d.meta && d.meta.time_missing);
    // 批次 D 原图定位：示例坐标走与真实上传同一个公开入口（PanjiTrust.configure），
    // 否则 /api/demo 返回了 boxes 也到不了报告，仍只显示「打开原图 · partial」
    if (window.PanjiTrust && typeof window.PanjiTrust.configure === 'function') {
      window.PanjiTrust.configure({ boxes: d.boxes || null });
    }
    if (!state.trades.length) throw new Error('示例数据为空');
    // 让扫描动画至少走满一轮，别点完「开始」一闪就到档案
    const rest = 2000 - (Date.now() - scanT0);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    autoDerive();
    renderReview();
    track('sample_review');
    // L1 成功判据：主按钮必须直达示例档案全文（No.000 + 明细 + 规则标题），
    // 不停在复核页、不落到图鉴页。示例走免确认判定，用户点一次即可看到结果。
    await submitJudge();
    if (state.verdict) {
      track('sample_report');
      const lines = document.getElementById('rep-lines');
      if (lines && lines.scrollIntoView) lines.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  } catch (err) {
    state.isDemo = false;
    toast(err.message || '示例没读到', true);
    go('#scr-home');
  }
}

// 首屏两个入口错开：主按钮右上角 → 先看示例截图（预览屏）；「先看示例」→ 直接出 No.000 档案
$('#btn-demo').addEventListener('click', () => {
  const hn = $('#home-note'); if (hn) hn.hidden = true;
  startDemo();
});
$('#btn-demo-start').addEventListener('click', startDemo);
$('#btn-demo-back').addEventListener('click', () => go('#scr-home'));

$('#btn-demo-own').addEventListener('click', () => {
  track('own_upload_after_sample');
  state.isDemo = false;
  state.trades = [];
  state.expanded = new Set();
  state.derived = false;
  state.imageUrl = null;
  go('#scr-home');
  $('#consent-mask').classList.add('show');
});

/* ---------- 复核页原图对照 ---------- */
function applyImgScale() {
  $('#iv-img').style.width = Math.round(state.imgScale * 100) + '%';
  $('#iv-scale').textContent = Math.round(state.imgScale * 100) + '%';
}
function openImgViewer() {
  if (!state.imageUrl) return;
  $('#iv-img').src = state.imageUrl;
  state.imgScale = 1;
  applyImgScale();
  $('#img-viewer').hidden = false;
}
$('#btn-src-thumb').addEventListener('click', openImgViewer);
$('#iv-close').addEventListener('click', () => { $('#img-viewer').hidden = true; });
$('#iv-plus').addEventListener('click', () => { state.imgScale = Math.min(4, state.imgScale + 0.5); applyImgScale(); });
$('#iv-minus').addEventListener('click', () => { state.imgScale = Math.max(0.5, state.imgScale - 0.5); applyImgScale(); });

$('#trade-list').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    state.expanded.add(+edit.dataset.edit);
    renderReview();
    return;
  }
  const seg = e.target.closest('.seg');
  if (seg && e.target.dataset.v) {
    const i = +seg.dataset.i;
    state.trades[i].side = e.target.dataset.v;
    seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
    e.target.classList.add(`on`);
    e.target.classList.add(e.target.dataset.v === '买' ? 'buy' : 'sell');
    const card = seg.closest('.trade');
    const side = card.querySelector('.t-side');
    side.textContent = state.trades[i].side === '卖' ? '卖出' : '买入';
    side.className = `t-side ${state.trades[i].side === '卖' ? 'sell' : 'buy'}`;
    renderChips();
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    state.trades.splice(+del.dataset.del, 1);
    state.expanded = new Set();
    renderReview();
    toast('已删除');
  }
});

function needsFix(t) {
  // 代码选填：APP卡片视图（东海等）本就无代码列，靠名称即可配对判定（20261020）
  // 时间选填：部分券商"历史成交"页面没有时间列，时间类规则由服务端跳过并披露（20261023）
  // 方向必填：同花顺 PC 这类无方向列的表，方向靠发生金额对账推断，对不上时必须让用户自己选，不许默认买入
  return !t.name || !t.date || !t.side || !(+t.qty > 0) || !(+t.price > 0);
}

$('#btn-add').addEventListener('click', () => {
  const last = state.trades[state.trades.length - 1] || {};
  state.trades.push({
    date: last.date || '', time: '', code: last.code || null, name: last.name || null,
    side: '买', price: null, qty: null, amount: null,
    low: { price: true, qty: true, time: !last.date, date: !last.date, code: false, name: false },
    needs_fix: true,
  });
  renderReview();
  $('#trade-list').lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('#btn-reupload').addEventListener('click', () => go('#scr-home'));

/* ---------- 确认 → AI判定 → 报告（W2闭环） ---------- */
$('#btn-confirm').addEventListener('click', async () => {
  if (!state.trades.length) {
    $('#btn-add').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return toast('先补一笔再生成档案', true);
  }
  const incomplete = state.trades.filter(needsFix).length;
  if (incomplete) {
    const first = state.trades.findIndex(needsFix);
    const el = first >= 0 ? document.querySelector(`.trade[data-i="${first}"]`) : null;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return toast(`还有 ${incomplete} 笔没补全（黄框）`, true);
  }
  track('review_confirm');
  // 没设过规则：先用默认规则出报告，报告底部再引导改成自己的
  if (!getConfig()) {
    await loadTemplates();
    if (!state.defaultRules || !state.defaultRules.length) return toast('规则模板没读到，稍后再试', true);
    state.usingDefaults = true;
  }
  submitJudge();
});

let memCaseSeq = 0;   // 案例序号内存自增：本机存储写失败时不跳号、不阻断报告

function buildSnapshot() {
  const trades = state.trades.map(t => ({
    date: t.date, time: t.time, code: t.code, name: t.name,
    side: t.side, price: +t.price, qty: +t.qty, amount: t.amount ?? null,
    account: t.account || '',   // 批次 E-23 多账户：reviewTop 下拉把 account 写到 state.trades
  }));
  // L1 判据：示例档案固定 No.000，不占真实编号。第一份真实档案才是 No.001（L2）。
  if (state.isDemo) {
    return { seq: 0, caseNo: '冲动案例档案 No.000', trades, savedAt: Date.now(), outTradeNo: '' };
  }
  const stored = +(lsGet('guanzhu_case_seq') || 0);
  memCaseSeq = Math.max(memCaseSeq, stored);
  const seq = memCaseSeq + 1;
  memCaseSeq = seq;
  const caseNo = `冲动案例档案 No.${String(seq).padStart(3, '0')}`;
  return { seq, caseNo, trades, savedAt: Date.now(), outTradeNo: '' };
}

// 页面跳转类接口返回的是 HTML 表单，必须渲染后提交；禁止把 paymentHtml 当 URL 跳转。
function renderPaymentHtml(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.zIndex = '9999';
  container.style.background = '#070b16';
  document.body.appendChild(container);
  const form = container.querySelector('form');
  if (!form) {
    container.remove();
    throw new Error('支付表单生成失败，请稍后重试');
  }
  form.submit();
}

/* ---------- 解锁点档位选择 ----------
   只展示「价格 / 点数 / 单点成本」，不写任何尚未上线的功能（功能上线后再加卖点）。 */
function unitCostText(sku) {
  const cents = Number(sku.priceCents) || 0;
  const points = Number(sku.points) || 0;
  if (!points) return '';
  return (cents / 100 / points).toFixed(2);
}

function pickSku(skus, defaultId) {
  return new Promise((resolve) => {
    const old = document.getElementById('sku-picker');
    if (old) old.remove();
    const mask = document.createElement('div');
    mask.id = 'sku-picker';
    mask.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:9998;background:rgba(7,11,22,.72);display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(560px,100%);max-height:90vh;overflow:auto;background:#0f1526;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:18px;color:#e8ecf5;font-family:inherit;';
    const title = document.createElement('h3');
    title.textContent = '选择解锁点';
    title.style.cssText = 'margin:0 0 4px;font-size:17px;';
    const hint = document.createElement('p');
    hint.textContent = '价格 / 点数 / 单点成本；点数有效期 1 个月。';
    hint.style.cssText = 'margin:0 0 14px;font-size:12px;color:#9aa4b8;';
    box.appendChild(title);
    box.appendChild(hint);

    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      mask.remove();
      resolve(value);
    };

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    skus.forEach((sku) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.style.cssText = 'text-align:left;display:block;width:100%;padding:12px 14px;border-radius:10px;border:1px solid '
        + (sku.id === defaultId ? 'rgba(96,165,250,.7)' : 'rgba(255,255,255,.12)')
        + ';background:#151d31;color:inherit;cursor:pointer;';
      const price = (Number(sku.priceCents) || 0) / 100;
      item.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">'
        + '<b style="font-size:15px;">' + esc(sku.name) + '</b>'
        + '<span style="font-size:15px;">¥' + price.toFixed(2) + '</span>'
        + '</div>'
        + '<div style="margin-top:4px;font-size:12px;color:#9aa4b8;">'
        + esc(String(sku.points)) + ' 解锁点 · 单点成本 ¥' + unitCostText(sku)
        + '</div>';
      item.addEventListener('click', () => close(sku.id));
      list.appendChild(item);
    });
    box.appendChild(list);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.style.cssText = 'margin-top:14px;width:100%;padding:11px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#c9d2e3;cursor:pointer;';
    cancel.addEventListener('click', () => close(null));
    box.appendChild(cancel);

    mask.addEventListener('click', (e) => { if (e.target === mask) close(null); });
    mask.appendChild(box);
    document.body.appendChild(mask);
  });
}

async function startPayment() {
  const pay = await getPayConfig(true);
  if (!pay.required) return submitJudge();
  if (!pay.enabled) return toast('支付功能尚未配置，暂时无法生成档案', true);

  const skus = Array.isArray(pay.skus) ? pay.skus : [];
  let skuId = '';
  if (skus.length) {
    skuId = await pickSku(skus, pay.defaultSkuId);
    if (!skuId) return;   // 用户取消，不下单
  }

  let pending = readPendingPay();
  if (!pending || Date.now() - (pending.savedAt || 0) > 30 * 60 * 1000) {
    pending = buildSnapshot();
    savePendingPay(pending);
  }

  const btn = $('#btn-confirm');
  btn.disabled = true; btn.textContent = '正在创建支付…';
  try {
    const res = await fetch('/api/pay/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-token': getClientToken() },
      body: JSON.stringify({ sku: skuId, reuse_out_trade_no: pending.outTradeNo || '' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '支付下单失败');
    pending.outTradeNo = data.outTradeNo;
    pending.amount = data.amount;
    pending.subject = data.subject;
    pending.skuId = skuId;
    savePendingPay(pending);
    renderPaymentHtml(data.paymentHtml);
  } catch (err) {
    toast(err.message || '支付下单失败', true);
  } finally {
    btn.disabled = false; btn.textContent = '确认无误，生成档案';
  }
}

/* ---------- 授权闸门（会员线提供 window.PJL_GATE） ----------
   判断一律从这里取，不在 app.js 里维护第二套档位逻辑；
   接口未落地或未就绪时默认放行，保证 GATE_MODE=off 时零行为变更。

   ready 是布尔 getter，不是函数：只能读值。未就绪时必须等它变 true 再判，
   否则会抢在初始化前读到 tier='free'——表现是刚激活的人一进来看到免费档，刷新才好。 */
function gateApi() { return (typeof window !== 'undefined' && window.PJL_GATE) || null; }
function gateUiApi() { return (typeof window !== 'undefined' && window.PanjiLicenseUI) || null; }

function gateIsReady() {
  const g = gateApi();
  if (!g) return true;                    // 没有闸门＝不必等待
  try { return g.ready === true; } catch (err) { return true; }
}

const gateWaiters = [];
let gateSubscribed = false;

function gateFlush() {
  if (!gateIsReady()) return;
  while (gateWaiters.length) {
    const done = gateWaiters.shift();
    try { done(); } catch (err) { /* 单个等待者异常不影响其余 */ }
  }
}

function gateReady() {
  if (gateIsReady()) return Promise.resolve();
  const ui = gateUiApi();
  // 拿不到任何「就绪通知」入口就当等不到，直接放行，绝不把判定流程卡死
  const canNotify = !!(ui && (typeof ui.onChange === 'function' || typeof ui.ready === 'function'));
  if (!canNotify) return Promise.resolve();
  return new Promise((resolve) => {
    gateWaiters.push(resolve);
    if (typeof ui.ready === 'function') {
      // boot 的 Promise 落定后再冲刷一次：降级路径不触发 onChange 时也不会卡住
      try { Promise.resolve(ui.ready()).then(gateFlush, gateFlush); } catch (err) { gateFlush(); }
    }
  });
}

/* 授权状态异步就绪：订阅一次 onChange，状态变化后重绘报告底部档位条 */
(function gateSubscribe() {
  const ui = gateUiApi();
  if (!ui || typeof ui.onChange !== 'function' || gateSubscribed) return;
  gateSubscribed = true;
  try {
    ui.onChange(() => { gateFlush(); paintGateNote(); });
    gateFlush();   // 订阅与就绪之间可能有竞态，补一次
  } catch (err) { gateFlush(); }
})();

function gateAllow(name, code) {
  if (!code) return true;                 // 定位不到标的就不拦（老档案/无股票代码）
  const g = gateApi();
  const fn = g && g[name];
  if (typeof fn !== 'function') return true;
  try { return !!fn.call(g, code); } catch (err) { return true; }
}
function gateStatusText() {
  const g = gateApi();
  try { return g && typeof g.statusText === 'function' ? String(g.statusText() || '').trim() : ''; } catch (err) { return ''; }
}

/* 报告所属股票 → 唯一合法解锁键 'stock:NNNNNN'
   解锁账本只认 stock 命名空间；case:000001 只用于本地文件定位，不参与解锁。
   归一化一律走 PJL_GATE.normalizeCode，不在 app.js 里另写一套编码规则。 */
function gateStockKey(trades) {
  const list = Array.isArray(trades) ? trades : [];
  for (let i = 0; i < list.length; i++) {
    const raw = String((list[i] && list[i].code) || '').trim();
    if (!raw) continue;
    const g = gateApi();
    if (g && typeof g.normalizeCode === 'function') {
      try { return g.normalizeCode('stock:' + raw) || ''; } catch (err) { return ''; }
    }
    return 'stock:' + raw;
  }
  return '';
}

/* 闸门是否真的生效（GATE_MODE=off / whitelist 未命中时为 false）
   底部档位条只在生效时才出现，保证首页挂上授权脚本后视觉零变化 */
function gateActiveNow() {
  const ui = gateUiApi();
  const fn = ui && ui.gateActive;
  if (typeof fn !== 'function') return false;
  try { return !!fn.call(ui); } catch (err) { return false; }
}

/* 报告底部档位条：文案只取 PJL_GATE.statusText()，闸门未生效或空则整条隐藏 */
function paintGateNote() {
  if (typeof document === 'undefined') return;
  const anchor = $('#rep-disclaimer');
  if (!anchor || !anchor.parentNode) return;
  const gt = gateActiveNow() ? gateStatusText() : '';
  let gnote = $('#rep-gate-note');
  if (gt) {
    if (!gnote) {
      gnote = document.createElement('p');
      gnote.id = 'rep-gate-note';
      gnote.className = 'rep-gate-note';
      anchor.parentNode.insertBefore(gnote, anchor.nextSibling);
    }
    gnote.hidden = false;
    gnote.textContent = gt;
  } else if (gnote) {
    gnote.hidden = true;
    gnote.textContent = '';
  }
}

async function submitJudge(orderNo, snapshot) {
  const btn = $('#btn-confirm');
  btn.disabled = true; btn.textContent = '判定中…';
  const jnote = $('#judge-note');
  if (jnote) { jnote.hidden = true; jnote.textContent = ''; }
  phaseShow();
  phaseSet(0, 'done');   // 档案已读取（示例或上次快照）
  phaseSet(1, 'done');   // 成交已识别（OCR 阶段已完成）
  phaseSet(2, 'active'); // 逐笔比对：等 /api/confirm 判定引擎返回
  try {
    const saved = getConfig();
    if (!saved) state.usingDefaults = true;
    const cfg = saved || { rules: state.defaultRules || [], capital: null };
    if (!cfg.rules || !cfg.rules.length) throw new Error('规则模板未加载，请刷新页面后重试');
    const current = snapshot || buildSnapshot();
    state.lastSnapshot = current;
    // 单请求闭环：确认+判定一体（/api/confirm 内部跑判定引擎，45s熔断保底）
    let jdata = null;
    try {
      const jres = await fetch('/api/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-token': getClientToken() },
        body: JSON.stringify({
          trades: current.trades,
          case_no: current.caseNo,
          rules: cfg.rules,
          capital: cfg.capital,
          order_no: orderNo || '',
        }),
        signal: AbortSignal.timeout(75000),
      });
      if (jres.status === 402) {
        clearPendingPay();
        return startPayment();
      }
      jdata = await jres.json();
      if (!jdata.ok) throw new Error(jdata.error);
    } catch (err) {
      // 纯静态预览（无后端）：示例档案用预生成的判定快照，保证「开始 → 档案」走得完
      if (!state.isDemo) throw err;
      const fres = await fetch('demo_report.json');
      jdata = await fres.json();
      if (!jdata.ok) throw err;
    }

    // 归档落盘失败（配额满/被禁）只降级提示，绝不阻断报告
    // L2 成功判据：真实档案才写 guanzhu_case_seq / guanzhu_case_001；示例（isDemo）只渲染不落盘，
    // 否则示例数据会占掉 No.001，第二份真实档案变成 No.002、图鉴第 1 格已被示例点亮。
    let seqSaved = true;
    let caseSaved = true;
    let archiveBlocked = false;
    state.confirmed = current.trades;
    state.verdict = jdata.verdict;
    state.caseNo = current.caseNo;
    state.judgeMode = jdata.mode;
    const caseId = 'case_' + String(current.seq).padStart(3, '0');
    // 解锁账本只认 stock 键；case:000001 只用于本地文件定位，不参与解锁
    const stockKey = gateStockKey(current.trades);
    if (!state.isDemo) {
      // 档位不够存档时只跳过落盘，报告照旧渲染（GATE_MODE=off 时 canArchive 恒真）
      await gateReady();
      archiveBlocked = !gateAllow('canArchive', stockKey);
    }
    if (!state.isDemo && !archiveBlocked) {
      seqSaved = lsSet('guanzhu_case_seq', String(current.seq));
      caseSaved = lsSet(`guanzhu_case_${String(current.seq).padStart(3, '0')}`,
        JSON.stringify({ ts: new Date().toISOString(), trades: current.trades, verdict: jdata.verdict }));
      // 并入账本：区间重叠自动去重，供跨期统计（违规次数/最常违规）使用
      const merged = ledgerMerge(current.trades, caseId);
      extRun('afterConfirm', { caseNo: current.caseNo, trades: current.trades, verdict: jdata.verdict, isDemo: state.isDemo });
      extRun('afterIngest', {
        added: merged ? merged.added : 0,
        dup: merged ? merged.dup : 0,
        ledger: merged ? merged.ledger : null,
        caseNo: caseId,
      });
    }
    // 第 24 格「多账户分账」：真实档案 + 复核页至少用了 2 个不同账户，才点亮
    if (!state.isDemo && acctOn() && window.PanjiCollection && PanjiCollection.unlockPending) {
      const used = {};
      (current.trades || []).forEach((t) => { used[t.account || 'default'] = 1; });
      const n = Object.keys(used).length;
      if (n >= 2) {
        PanjiCollection.unlockPending('U-024', { proof: '复核页按账户存档：' + Object.keys(used).join(' / ') });
      }
    }
    clearPendingPay();

    if (jdata.mode === 'glm') toast('AI判定完成');
    else if (jdata.mode === 'mock-fallback') toast('AI增强暂不可用，已用规则引擎兜底', true);
    else toast('演示判定：规则引擎骨架');
    if (state.usingDefaults) toast('先用默认规则生成；报告底部可改成你自己的');

    renderReport();
    go('#scr-done');
    phaseSet(2, 'done');
    phaseSet(3, 'active');
    setTimeout(() => { phaseSet(3, 'done'); setTimeout(phaseHide, 600); }, 250);
    track(state.isDemo ? 'sample_report' : 'report_done');
    if (archiveBlocked) {
      toast('当前档位不写本机档案：报告可看、可分享；档案与跨日对比需激活后才有', true);
    } else if (!seqSaved || !caseSaved) {
      toast('本机存储不可用，本次档案未存档；报告已生成，可先截图留存', true);
    }
  } catch (err) {
    phaseHide();
    // 判定失败不能只闪一条 toast：留在复核页，写一句能照着做的下一步
    const jnote = $('#judge-note');
    const msg = err && err.message ? err.message : '提交失败';
    if (jnote) {
      jnote.hidden = false;
      jnote.textContent = msg + (/[。！？]$/.test(msg) ? '' : '。') +
        '点下面的「确认无误，生成档案」再试一次；还是不行就回首页刷新（多半是本机服务在重启）。';
    }
    // 示例路径是从扫描页直接判定的：失败时不能把人停在转圈页，要落到复核页让人看到上面那句话
    const onScan = document.querySelector('#scr-scan.active');
    if (onScan && state.trades && state.trades.length) go('#scr-review');
    // 复核页比一屏长，失败句在底部：不滚过去等于没写
    if (jnote) jnote.scrollIntoView({ block: 'center' });
    // 同一句话不再弹 toast，避免盖住常驻提示的第二行
  } finally {
    btn.disabled = false; btn.textContent = '确认无误，生成档案';
  }
}

// 支付回跳后：只认服务端交易查询结果，不信任 URL 参数。
async function resumePaymentReturn() {
  const orderNo = new URLSearchParams(location.search).get('pay_order');
  if (!orderNo) return;
  const pending = readPendingPay();
  if (!pending) {
    toast('未找到待生成的档案，请重新上传交割单', true);
    history.replaceState(null, '', '/');
    return;
  }
  state.trades = pending.trades;
  try {
    const res = await fetch(`/api/pay/order?out_trade_no=${encodeURIComponent(orderNo)}`, {
      headers: { 'x-client-token': getClientToken() },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '支付结果确认失败');
    if (!data.order || !data.order.paid) {
      toast('支付尚未确认，请稍后刷新页面', true);
      return;
    }
    history.replaceState(null, '', '/');
    await submitJudge(orderNo, pending);
  } catch (err) {
    toast(err.message || '支付结果确认失败', true);
  }
}

/* ---------- 报告渲染 ---------- */
function flagCls(f) { return f === '违规' ? 'bad' : f === '存疑' ? 'sus' : 'ok'; }

// 连续复盘天数：从当前档案向前数连续有档案的日期数（不做「合规」筛选，避免羞辱感）
function streakDays() {
  const dates = new Set([new Date().toISOString().slice(0, 10)]);
  const seq = Math.max(+(lsGet('guanzhu_case_seq') || 0), memCaseSeq);
  for (let i = seq - 1; i >= 1; i--) {
    let c = null;
    try { c = JSON.parse(lsGet(`guanzhu_case_${String(i).padStart(3, '0')}`) || 'null'); } catch {}
    if (!c || !c.verdict) break;
    dates.add(String(c.ts || '').slice(0, 10));
  }
  return dates.size;
}

// 判定文本里的方向必须与这笔一致：卖出笔不得出现「这笔买入」
function sideReason(reason, side) {
  const r = String(reason || '');
  if (side === '卖') return r.replace(/这笔买入|该笔买入|本次买入/g, '这笔卖出');
  return r.replace(/这笔卖出|该笔卖出|本次卖出/g, '这笔买入');
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]); }

// 判据（对应 docs/引导策略_20261105.md 的 L2 / L5，写进代码以便回归）：
// L2：真实档案落盘后 guanzhu_case_seq ≥ 1，且「编号 No.001 + 图鉴第 1 格点亮」同屏出现；
// L5：n < 3 时必须显式给下一档提示「再攒 N 份档案，解锁同一类越线 · 3 次对比」，
// 不许只点亮不给提示；示例（isDemo，seq=0）不点亮任何格。
function renderRepWall() {
  const grid = $('#rep-wall');
  if (!grid) return;
  if (!grid.children.length) {
    for (let i = 0; i < 25; i++) grid.appendChild(document.createElement('i'));
  }
  let n = 0;
  try { n = Number(lsGet('guanzhu_case_seq') || 0); } catch (e) {}
  // 前 15 格：1 份档案点亮 1 格，封顶 15。第 16–25 格按功能开关与实际动作点亮。
  n = Math.max(0, Math.min(15, n));
  let w = null;
  try { w = (window.PanjiCollection && PanjiCollection.wall) ? PanjiCollection.wall(null, {}) : null; } catch (e) { w = null; }
  const items = (w && w.items) ? w.items : [];
  let pendLit = 0;
  for (let i = 15; i < 25; i++) if (items[i] && items[i].state === 'unlocked') pendLit++;
  const totalLit = n + pendLit;
  Array.prototype.forEach.call(grid.children, (c, i) => {
    if (i < 15) {
      c.classList.toggle('on', i < n);
      c.classList.remove('locked');
      c.title = `第 ${i + 1} 格 · 可判定`;
      return;
    }
    const it = items[i] || null;
    c.classList.toggle('on', !!(it && it.state === 'unlocked'));
    c.classList.toggle('locked', !!(it && it.state === 'unlaunched'));
    if (!it) { c.title = `第 ${i + 1} 格`; return; }
    const label = it.state === 'unlocked' ? '已点亮'
      : (!it.live ? '本版不可点亮'
      : (it.state === 'progress' ? '可判定·未点亮' : '需先开启 ' + it.gateName));
    c.title = `第 ${i + 1} 格 · ${it.title} · ${label}`;
  });
  const lit = $('#rep-lit'); if (lit) lit.textContent = totalLit;
  const judgedN = w ? w.judged : 15;
  const judgedEl = $('#rep-judged'); if (judgedEl) judgedEl.textContent = judgedN;
  const offN = w ? w.gateOff : 10;
  const deadN = w ? w.dead : 0;
  const wallNote = $('#rep-wall-note');
  if (wallNote) {
    wallNote.textContent = judgedN + ' 格可判定 · 已点亮 ' + totalLit + ' 格' +
      (offN ? ' · ' + offN + ' 格需先开启对应功能' : '') +
      (deadN ? ' · ' + deadN + ' 格本版不可点亮' : '') + '（图鉴页可看逐格）';
  }
  const no = $('#rep-no');
  if (no) {
    // 双反馈里的「档案编号」只放 No.XXX，标题前缀已经在上方 pill 里，不重复
    // 示例固定 No.000（不占真实编号）：就算服务端把示例回成 No.001，这里也按示例口径显示 No.000
    const full = state.isDemo ? 'No.000' : ((state.verdict && state.verdict.case_no) || state.caseNo || 'No.001');
    const m = String(full).match(/No\.\d{3}/);
    no.textContent = m ? m[0] : full;
  }
  const cta = $('#btn-again2');
  if (cta) {
    cta.textContent = totalLit === 0 ? '传我自己的，生成 No.001'
      : (totalLit >= judgedN || n >= 15) ? '再传一张，继续攒档案'
      : `再传一张，点亮第 ${n + 1} 格`;
  }
  const next = $('#rep-next');
  if (next) {
    if (n >= 3) {
      next.textContent = '已解锁「同一类越线 · 3 次对比」，在档案列表里看。';
    } else {
      next.textContent = `再攒 ${3 - n} 份档案，解锁「同一类越线 · 3 次对比」。`;
    }
  }
}

// 第 16 格「原图定位」：trust 开关打开、真实档案的报告里点一次，才点亮。
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('[data-tr-bbox]') : null;
  if (!btn || state.isDemo) return;
  try { if (!(window.PanjiFlag && window.PanjiFlag('trust'))) return; } catch (err) { return; }
  if (!(window.PanjiCollection && PanjiCollection.unlockPending)) return;
  const r = PanjiCollection.unlockPending('U-016', { proof: '报告里点了一次「原图定位」' });
  if (r && r.ok) renderRepWall();
});

// 第 19 格「情绪打卡」/ 第 22 格「日历订阅 .ics」/ 第 25 格「期初持仓 / 出入金」：
// 等对应模块把数据写进存储（或把成功文案写进按钮）后再判定，避免抢在前一步。
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  const moodBtn = t.closest('[data-pi-mood]');
  const icsBtn = t.closest('[data-recall="ics"]');
  const assetBtn = t.closest('#pos-add, #cash-add');
  if (!moodBtn && !icsBtn && !assetBtn) return;
  setTimeout(() => {
    if (moodBtn) checkMoodStreak();
    if (icsBtn && icsBtn.textContent && icsBtn.textContent.indexOf('已生成') >= 0) {
      collUnlock('U-022', '点「加到日历」生成 .ics 成功（导入由系统日历完成）');
    }
    if (assetBtn) checkAssetEntry();
  }, 0);
});

function renderReport() {
  const v = state.verdict, s = v.summary;
  $('#case-no').textContent = v.case_no || state.caseNo;
  $('#mode-tag').textContent = state.isDemo ? '示例数据'
    : (state.judgeMode === 'archive' ? '历史档案 · 只读（不重新判定）'
      : (state.judgeMode === 'glm' ? 'AI 判定' : '规则引擎判定'));
  renderRepWall();
  $('#done-stats').innerHTML = `
    <div class="card"><div class="v" style="background:none;color:${s.violations ? 'var(--bad)' : 'var(--ok)'}">${s.violations}</div><div class="k">越线笔数</div></div>
    <div class="card"><div class="v" style="background:none;color:var(--warn)">${s.worst ? s.worst.text : '—'}</div><div class="k">最痛一笔</div></div>
    <div class="card"><div class="v" style="background:none;color:var(--ok)">${streakDays()} 天</div><div class="k">连续复盘</div></div>`;

  const ls = ledgerSummary();
  const ln = $('#ledger-note');
  if (ln) {
    if (ls && ls.total > 0) {
      ln.hidden = false;
      ln.innerHTML = `账本累计 <b style="color:#c9d1e0">${ls.total}</b> 笔 · `
        + `覆盖 ${fmtYmd(ls.coverageFrom)} ~ ${fmtYmd(ls.coverageTo)} · `
        + `已合并 ${ls.importCount} 次导入（重叠区间自动去重）`;
    } else {
      ln.hidden = true;
    }
  }
  const topHtml = extRun('reportTop', v, state);
  const ret = $('#rep-ext-top');
  if (ret) { ret.innerHTML = topHtml; ret.hidden = !topHtml; }

  $('#rep-oneliner').innerHTML = `“${esc(v.one_liner)}”`;
  $('#rep-lines').innerHTML = v.lines.map(l => `
    <div class="rep-line card">
      <div class="rl-top">
        <span class="rl-meta">笔${l.idx + 1} · ${esc(l.date)} ${esc(l.time)}</span>
        <span class="rflag ${flagCls(l.flag)}">${esc(l.flag)}${l.rule ? ' · ' + esc(l.rule) : ''}</span>
      </div>
      <p class="rl-trade">${l.side === '卖' ? '卖出' : '买入'} ${esc(l.name)}${l.code ? '（' + esc(l.code) + '）' : ''} ${l.price}元 × ${l.qty}股</p>
      <p class="rl-reason">${esc(sideReason(l.reason, l.side))}</p>
      ${extRun('lineExtra', l, v, state)}
    </div>`).join('');
  const sb = $('#rep-suspects-block');
  sb.hidden = !v.suspects.length;
  $('#rep-suspects').innerHTML = v.suspects.map(x => `<div class="sus-item">${esc(x.text)}</div>`).join('');
  const fb = $('#rep-fixes-block');
  fb.hidden = !v.fixes.length;
  $('#rep-fixes').innerHTML = v.fixes.map(f => `<div class="fix-item">${esc(f)}</div>`).join('');

  // 日级规则（不污名化单笔，单独成块）
  const days = v.day_checks || [];
  $('#rep-day-block').hidden = !days.length;
  $('#rep-day').innerHTML = days.map(d => `
    <div class="day-item"><span class="df">${esc(d.rule)}</span>${esc(d.text)}</div>`).join('');

  // 规则使用情况：让用户看到哪条规矩今天根本没用上
  const stats = v.rule_stats || [];
  $('#rep-rules-block').hidden = !stats.length;
  const zeroText = (r) => (r.id === 'T03' || r.id === 'T04') ? '本区间未触发' : '未触发';
  $('#rep-rules').innerHTML = stats.map(r => `
    <div class="rstat"><span class="rs-id">${esc(r.id)}</span><span class="rs-name">${esc(r.name)}</span>
      <span class="rs-n ${r.triggered ? 'hit' : ''}">${r.triggered ? `触发 ${r.triggered} 次` : (r.pending ? '暂不判定 · 需先填本金' : zeroText(r))}</span></div>`).join('')
    + (v.pending_rules && v.pending_rules.length
      ? `<div class="rs-note">未填本金：涉及本金的规则暂不判定，当日买入总额仅作参考基数，不参与判定。</div>`
      : '');

  const bottomHtml = extRun('reportBottom', v, state);
  const reb = $('#rep-ext-bottom');
  if (reb) { reb.innerHTML = bottomHtml; reb.hidden = !bottomHtml; }

  // 配置提示（参数越界/规则被降级）
  const warns = v.config_warnings || [];
  $('#rep-warn').hidden = !warns.length;
  $('#rep-warn').innerHTML = warns.map(w => `<div>${esc(w)}</div>`).join('');

  // AI 标识（《人工智能生成合成内容标识办法》显式标识）
  $('#rep-ai-label').textContent = v.ai_label ? `※ ${v.ai_label}` : '';

  $('#rep-disclaimer').textContent = v.disclaimer;

  // 底部内联条：档位文案一律取 PJL_GATE.statusText()，闸门关时为空即不渲染
  paintGateNote();

  // 报告页两个出口：默认规则的改成自己的；示例数据的换成自己的
  $('#rules-cta').hidden = !state.usingDefaults || state.isDemo;
  $('#demo-cta').hidden = !state.isDemo;

  // 第 20 格「盘前一句话」与第 21 格「明日一规」：要等报告正文渲染完才有回引 / 结算结果。
  // 只读档案不重新判定，也不在这里触发新解锁。
  if (state.judgeMode !== 'archive') checkPendingSignals(v);
}

/* ---------- 只读档案：index.html?case=No.001 ----------
   读本机 case_00X 快照，渲染当时判定，不请求 /api/confirm、不写新档案。 */
async function openCaseArchive(noText) {
  const m = String(noText || '').match(/(\d{3})/);
  if (!m) { toast('档案编号无效：' + noText, true); return; }
  const id = m[1];
  let snap = null;
  try { snap = JSON.parse(lsGet('guanzhu_case_' + id) || 'null'); } catch (e) { snap = null; }
  if (!snap || !snap.verdict || !snap.verdict.summary) {
    toast('本机读不到档案 No.' + id + '（可能已清理或不在本机），先回首页', true);
    setTimeout(() => go('#scr-home'), 1200);
    return;
  }
  // 闸门看的是「这份档案所属股票」，不是档案号：解锁账本只认 stock 键
  await gateReady();
  if (!gateAllow('canView', gateStockKey(snap.trades))) {
    const st = gateStatusText();
    toast('这份档案需要激活后才能查看' + (st ? '（' + st + '）' : ''), true);
    return;
  }
  const v = snap.verdict;
  state.isDemo = false;
  state.trades = snap.trades || [];
  state.confirmed = snap.trades || [];
  state.verdict = v;
  state.caseNo = v.case_no || ('冲动案例档案 No.' + id);
  state.judgeMode = 'archive';
  state.usingDefaults = false;
  state.imageUrl = '';
  state.scrubbed = 0;
  state.timeMissing = false;
  state.expanded = new Set();
  renderReport();
  go('#scr-done');
  track('archive_open');
  toast('只读档案：按当时的判定回放，不重新判定');
}

updateRuleEntry();
loadTemplates();
resumePaymentReturn();

// 只读档案路由：案例库点进来时直接渲染，不重新判定
const archiveNo = new URLSearchParams(location.search).get('case');
if (archiveNo) openCaseArchive(archiveNo);

$('#btn-again').addEventListener('click', () => go('#scr-home'));
// 手机没有悬停：点暗格时把「本版未开放」直接写到说明行，避免纯灰无解释
const repWallEl = $('#rep-wall');
if (repWallEl) repWallEl.addEventListener('click', (e) => {
  const c = e.target && e.target.closest ? e.target.closest('i') : null;
  if (!c) return;
  const idx = Array.prototype.indexOf.call(e.currentTarget.children, c);
  const note = $('#rep-wall-note');
  if (!note) return;
  if (idx >= 15) {
    const ps = (window.PanjiCollection && typeof PanjiCollection.pending === 'function')
      ? PanjiCollection.pending({}) : [];
    const p = ps[idx - 15];
    if (!p) { note.textContent = `第 ${idx + 1} 格 · 读不到这一格的状态，刷新再试`; return; }
    if (!p.live) note.textContent = `第 ${idx + 1} 格 · ${p.title}：本版不可点亮。原因：${p.why}`;
    else if (p.state === 'unlocked') note.textContent = `第 ${idx + 1} 格 · ${p.title}：已点亮（${p.at || ''}）`;
    else if (p.state === 'progress') note.textContent = `第 ${idx + 1} 格 · ${p.title}：可判定·未点亮。怎么做：${p.cond}`;
    else note.textContent = `第 ${idx + 1} 格 · ${p.title}：需先开启 ${p.gateName}（${p.need}）。开启后点亮条件：${p.cond}`;
  } else {
    note.textContent = `第 ${idx + 1} 格 · 可判定，还没点亮`;
  }
});
$('#btn-again2').addEventListener('click', () => {
  track('upload_after_report');
  go('#scr-home');
  $('#consent-mask').classList.add('show');
});
const demoCard = $('#btn-demo-card');
if (demoCard) demoCard.addEventListener('click', () => $('#btn-demo').click());

$('#btn-rules-from-report').addEventListener('click', async () => {
  track('rules_from_report');
  state.pendingRejudge = true;
  state.pendingJudge = false;
  await loadTemplates();
  if (!state.templates || !state.templates.length) return toast('规则模板没读到，稍后再试', true);
  renderRulesPage();
  go('#scr-rules');
});

/* ---------- 分享卡（3:4竖版 canvas 一键出图，内生分享主引擎） ---------- */
function rr(x, a, b, w, h, r) {
  x.beginPath();
  x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r);
  x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath();
}
const FONT = '"PingFang SC","Microsoft YaHei",sans-serif';

/* 分享卡「一句人话」脱敏：one_liner 由模型自由生成，提示词管不住它复述标的。
   出图前用本案例的代码/名称/金额/数量/日期做确定性黑名单替换；
   替换后仍残留 4 位以上数字或标的名称的，整句退回中性句，绝不带着敏感信息出图。 */
function stripShareSensitive(text, v) {
  let s = String(text || '');
  if (!s) return '';
  const names = [], codes = [], dates = [], nums = [];
  const add = (arr, x) => {
    const t = String(x == null ? '' : x).trim();
    if (t && arr.indexOf(t) < 0) arr.push(t);
  };
  const rows = (v && Array.isArray(v.lines) ? v.lines : [])
    .concat(Array.isArray(state.confirmed) ? state.confirmed : []);
  for (const t of rows) {
    if (!t) continue;
    add(names, t.name);
    add(codes, t.code);
    add(dates, t.date);
    add(dates, t.time);
    add(nums, t.amount);
    add(nums, t.price);
    add(nums, t.qty);
  }
  // 标的名称：≥2 字符才替，避免把「补仓」「追高」这类词也替掉
  const nameHits = names.filter(n => n.length >= 2).sort((a, b) => b.length - a.length);
  for (const n of nameHits) s = s.split(n).join('某只票');
  // 股票代码：本案例原值 + 任意 5~6 位连续数字
  for (const c of codes) if (/^\d{5,6}$/.test(c)) s = s.split(c).join('某只票');
  s = s.replace(/[A-Za-z]{0,2}\d{5,6}/g, '某只票');
  // 本案例金额 / 单价 / 数量：原值（含千分位与万元变体）一律替成「若干」
  for (const n of nums) {
    const plain = String(n).replace(/,/g, '');
    if (!/^\d{3,}(?:\.\d+)?$/.test(plain)) continue;
    s = s.split(String(n)).join('若干');
    if (plain !== String(n)) s = s.split(plain).join('若干');
    const f = Number(plain);
    if (isFinite(f) && f >= 10000) {
      const w = (f / 10000).toFixed(2).replace(/\.?0+$/, '');
      s = s.split(w + '万').join('若干');
    }
  }
  // 金额 / 数量 / 单价：数字（含千分位与小数）后接单位
  s = s.replace(/\d[\d,]*(?:\.\d+)?\s*(万|元|块|股|手|张|%)/g, '若干');
  // 日期与时间（本案例原值优先，再兜底通用格式）
  for (const d of dates) {
    const dd = String(d || '');
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(dd)) { s = s.split(dd).join('某刻'); continue; }
    if (dd.length >= 4) s = s.split(dd).join('某天');
    const md = dd.match(/^\d{2,4}[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (md) {
      const alt = Number(md[1]) + '月' + Number(md[2]) + '日';
      s = s.split(alt).join('某天');
      const alt2 = Number(md[1]) + '/' + Number(md[2]);
      s = s.split(alt2).join('某天');
    }
  }
  s = s.replace(/\d{1,2}:\d{2}/g, '某刻');
  s = s.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '某天');
  // 兜底复核：还看得出代码/金额/标的就整句弃用
  const stillLeaks = /\d{4,}/.test(s)
    || /\d[\d,]*(?:\.\d+)?\s*(?:万|元|块|股|手|张|%)/.test(s)
    || nameHits.some(n => s.indexOf(n) >= 0);
  if (stillLeaks) return '';
  return s.replace(/\s+/g, ' ').trim();
}

function drawShareCard() {
  const v = state.verdict, s = v.summary;
  const W = 1080, H = 1440;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');

  // 深色底 + 极光晕
  x.fillStyle = '#070b16'; x.fillRect(0, 0, W, H);
  const orb = (cx, cy, r, col) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(cx - r, cy - r, r * 2, r * 2);
  };
  orb(140, 90, 430, 'rgba(20,66,158,0.55)');
  orb(960, 430, 390, 'rgba(109,40,217,0.42)');
  orb(320, 1340, 370, 'rgba(13,148,136,0.38)');
  // 44px 微网格
  x.fillStyle = 'rgba(255,255,255,0.05)';
  for (let gy = 44; gy < H; gy += 44) for (let gx = 44; gx < W; gx += 44) { x.beginPath(); x.arc(gx, gy, 1.5, 0, 7); x.fill(); }

  // 玻璃主卡
  rr(x, 70, 140, W - 140, 1130, 40);
  x.fillStyle = 'rgba(255,255,255,0.05)'; x.fill();
  x.strokeStyle = 'rgba(255,255,255,0.14)'; x.lineWidth = 2; x.stroke();
  const hg = x.createLinearGradient(200, 0, 880, 0);
  hg.addColorStop(0, 'rgba(110,231,255,0)'); hg.addColorStop(0.5, 'rgba(110,231,255,0.9)'); hg.addColorStop(1, 'rgba(167,139,250,0)');
  x.fillStyle = hg; x.fillRect(200, 142, 680, 3);

  x.textAlign = 'center';
  x.fillStyle = 'rgba(232,237,248,0.65)'; x.font = `500 30px ${FONT}`;
  x.fillText('纪 律 记 分 卡', W / 2, 258);
  // 编号渐变字
  const ng = x.createLinearGradient(340, 0, 740, 0);
  ng.addColorStop(0, '#6ee7ff'); ng.addColorStop(1, '#a78bfa');
  x.fillStyle = ng; x.font = `800 46px ${FONT}`;
  x.fillText(v.case_no || state.caseNo, W / 2, 338);
  x.fillStyle = 'rgba(147,160,189,0.95)'; x.font = `500 30px ${FONT}`;
  x.fillText(s.violations ? `今天看清了 ${s.violations} 处越线` : '今天，手管住了', W / 2, 402);

  // 三大数字：正向优先（复盘笔数 → 越线笔数 → 连续复盘）
  // 批次 F 可用 shareStats 钩子替换成复发清单；没有钩子时保持默认
  const defaultStats = [
    { label: '复盘笔数', val: String(v.lines.length), col: '#6ee7ff' },
    { label: '越线笔数', val: String(s.violations), col: s.violations ? '#f87171' : '#34d399' },
    { label: '连续复盘', val: streakDays() + ' 天', col: '#34d399' },
  ];
  const customStats = extFirst('shareStats', v, state);
  const stats = (Array.isArray(customStats) && customStats.length ? customStats : defaultStats)
    .map(x => ({ label: x.label, val: x.val, col: x.col || '#6ee7ff' }));
  let sy = 512;
  for (const st of stats) {
    x.fillStyle = 'rgba(255,255,255,0.35)'; x.font = `500 30px ${FONT}`;
    x.fillText(st.label, W / 2, sy);
    x.fillStyle = st.col; x.font = `800 104px ${FONT}`;
    x.fillText(st.val, W / 2, sy + 122);
    sy += 218;
  }

  // 一句人话（最多两行）：模型生成后先过确定性脱敏，仍残留敏感信息则退回中性句
  const cleanedLiner = stripShareSensitive(v.one_liner, v);
  const q = (cleanedLiner || (s.violations ? '手没管住的地方，都记在这一页' : '每一笔都翻出来看了看')).slice(0, 40);
  const rows = [];
  for (let i = 0; i < q.length && rows.length < 2; i += 18) rows.push(q.slice(i, i + 18));
  x.fillStyle = '#e8edf8'; x.font = `600 38px ${FONT}`;
  rows.forEach((r0, i) => x.fillText((i === 0 ? '“' : '') + r0 + (i === rows.length - 1 ? '”' : ''), W / 2, 1118 + i * 52));

  // 品牌位（零平台词——封号教训：品牌名暗示，不做任何导流表述）
  x.fillStyle = 'rgba(147,160,189,1)'; x.font = `500 30px ${FONT}`;
  x.fillText('在「管住手了吗复盘」生成', W / 2, 1330);
  x.fillStyle = 'rgba(91,103,132,0.9)'; x.font = `400 22px ${FONT}`;
  x.fillText('基于本人确认的交易记录生成 · 不构成任何投资建议', W / 2, 1382);

  // 示例数据水印：防止被当成真实账户传播
  if (state.isDemo) {
    x.textAlign = 'right';
    x.fillStyle = 'rgba(251,191,36,0.85)'; x.font = `700 24px ${FONT}`;
    x.fillText('示例数据 · 仅用于体验', W - 96, 110);
    x.textAlign = 'center';
  }

  const url = c.toDataURL('image/png');
  $('#share-img').src = url;
  $('#btn-share-dl').href = url;
  /* 分享钩子：按环境给最短路径 */
  const isWX = /MicroMessenger/i.test(navigator.userAgent);
  const tip = $('#share-tip'), dl = $('#btn-share-dl');
  if (isWX) {
    tip.innerHTML = '<b>长按上方图片</b>，直接「发送给朋友」<br>点右上角「···」可转发本页';
    dl.textContent = '保存图片';
    dl.classList.add('ghost');
  } else {
    tip.textContent = '长按 / 右键保存图片，发到你想发的地方';
    dl.textContent = '下载图片';
  }
  /* ST-2 分享页入口：按需加载 features/share.js（不动 index.html），加载好再挂可转发链接 */
  const mountShareLink = () => {
    const share = window.PanjiShare;
    if (!share || typeof share.build !== 'function') return;
    let link = $('#share-page-link');
    if (!link) {
      link = document.createElement('a');
      link.id = 'share-page-link'; link.className = 'btn ghost';
      link.target = '_blank'; link.rel = 'noopener'; link.textContent = '预览分享页';
      $('#btn-share-dl').parentNode.appendChild(link);
    }
    link.href = share.build({
      schema: 'panji.share.v1', template: 'card',
      title: '纪律记分卡 · ' + (v.case_no || state.caseNo),
      cardPayload: {
        caseNo: v.case_no || state.caseNo, stats, oneLiner: q, isDemo: !!state.isDemo,
        disclaimer: '基于本人确认的交易记录生成 · 不构成任何投资建议',
      },
      url: 'share.html',
    }).url;
  };
  if (window.PanjiShare) mountShareLink();
  else {
    const sc = document.createElement('script');
    sc.src = 'features/share.js'; sc.onload = mountShareLink; sc.onerror = () => {};
    document.head.appendChild(sc);
  }
  $('#share-mask').classList.add('show');
}

$('#btn-share').addEventListener('click', () => {
  if (!state.verdict) return toast('还没有可分享的档案', true);
  track('share_open');
  drawShareCard();
});
$('#btn-share-close').addEventListener('click', () => $('#share-mask').classList.remove('show'));
$('#share-mask').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });

// 首屏标题：每次加载随机取一组，取完就定住（同一页面生命周期内不再变，不做轮播）
// 「|」是显式断行位：第 13 条原文没有逗号，靠它固定成两行；没有「|」的条目按单行显示。
(function randomHeroTitle() {
  const list = [
    '复盘不是反思|是对账',
    '把情绪|换成数字',
    '先有记录|再谈判断',
    '账是账|感觉是感觉',
    '记录比记忆可靠',
    '你做的|和你说的不一样',
    '买入那一刻|你在想什么',
    '亏的那几笔|有共同点',
    '那天九点半|你点了什么',
    '涨了七个点之后|你还追吗',
    '十点的单|比下午的好吗',
    '你说你卖飞了|真的吗',
    '在这张表里|找你的固定动作',
    '账不会替你圆场',
    '先看事实|再谈心态',
    '手比脑子快|是要付钱的',
  ];
  const h1 = $('#scr-home h1.title');
  if (!h1) return;
  const t = list[Math.floor(Math.random() * list.length)];
  const parts = t.split('|');
  h1.textContent = '';
  if (parts.length < 2) { h1.textContent = parts[0]; return; }
  // 固定两行：前半句换行，后半句走原来的 em 渐变块
  h1.append(parts[0]);
  const em = document.createElement('em');
  em.textContent = parts[1];
  h1.append(em);
})();

// 首屏副标题：与标题各自独立随机，同样加载时定住；字号固定 14px，不随句子长短缩放
(function randomHeroSubtitle() {
  const list = [
    '看完你就知道手快在哪。',
    '不是让你少交易，是让你看清。',
    '算的不是赚亏，是你怎么办事。',
    '半年下来，有些动作重复得可笑。',
    '你以为的和你做的，差得挺远。',
    '复盘不靠回忆，靠记录。',
    '先看清，再决定改不改。',
    '数字不评价你，但会说真话。',
    '顺手点的那几笔，往往最贵。',
    '一单一单看，习惯就露出来了。',
    '不预测涨跌，只算已经发生的。',
    '算完出一份档案，可存可删。',
    '档案按编号存，下次能对比。',
    '一份档案一页纸，看得完。',
  ];
  const el = $('#scr-home .sub-row .subtitle');
  if (!el) return;
  el.textContent = list[Math.floor(Math.random() * list.length)];
})();

// L1 判据：?demo 必须真能打开示例档案（No.000 + 明细 + 规则标题），而不是停在首页。
// 等规则模板到位再触发示例链路，避免 /api/rules 未返回时判定失败。
// ?demo=preview 是「先看示例」的预览屏，单开地址用（demo.html 会转到这里）。
const demoParam = new URLSearchParams(location.search).get('demo');
if (demoParam === 'preview') {
  go('#scr-demo');
} else if (demoParam !== null) {
  (function openDemo() {
    if (state.defaultRules && state.defaultRules.length) {
      startDemo();
      return;
    }
    setTimeout(openDemo, 300);
  })();
}
