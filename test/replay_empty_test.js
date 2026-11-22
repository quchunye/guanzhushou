// replay_empty_test.js —— 回放页「无档案空态 + 数据来源角标」验收（node test/replay_empty_test.js）
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../public/features/replay');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

const LEDGER = { trades: [
  { date: '2024-03-05 10:12', code: '600519', name: '贵州茅台', side: 'B', price: 1700, qty: 100 },
  { date: '2024-03-06 14:03', code: '000001', name: '平安银行', side: 'S', price: 10, qty: 1000 },
] };

console.log('[1] hasArchive：只认「有成交记录」，空账本/坏数据不算档案');
ok(R.hasArchive([]) === false, '空数组 → false');
ok(R.hasArchive([{ date: '' }]) === false, '无日期成交 → false');
ok(R.hasArchive([null, { date: 'abc' }]) === false, '无有效日期 → false');
ok(R.hasArchive([{ date: '2024-03-05' }]) === true, '一条带日期成交 → true');
ok(R.hasArchive(LEDGER.trades) === true, '两条真实形态成交 → true');

console.log('[2] localStorage 夹具：真实路径签发令牌并带 x-kline-token');
const prevLoc = globalThis.localStorage;
const storeStub = {
  getItem(k) { return k === 'guanzhu_ledger' ? JSON.stringify(LEDGER) : null; },
  setItem() {}, removeItem() {},
};
globalThis.localStorage = storeStub;
const calls = [];
const tokenFetch = async (url, opts) => {
  calls.push({ url: String(url), opts: opts || {} });
  if (/token(\?|$)/.test(String(url))) {
    return { ok: true, status: 200, json: async () => ({ token: 'TK-LEDGER-1', exp: Math.floor(Date.now() / 1000) + 600 }) };
  }
  if (/index/.test(String(url))) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ schema: 'panji.kline.index.v1', months: {} }) };
  }
  return { ok: false, status: 404 };
};
R.clearToken();
(async () => {
  const tok = await R.ensureToken({ fetch: tokenFetch, base: 'api/kline/' });
  ok(tok === 'TK-LEDGER-1', 'ensureToken 用本机账本夹具换到令牌：' + tok);
  const tokenCall = calls.filter((c) => /token(\?|$)/.test(c.url))[0];
  ok(!!tokenCall, '发起了 POST token 请求');
  const body = JSON.parse(tokenCall.opts.body || '{}');
  ok(Array.isArray(body.scope) && body.scope.length === 2, 'scope 条目数 = ' + (body.scope || []).length + '（2 只票 × 1 个月）');
  ok((body.scope || []).every((s) => /^\S+\|2024-03$/.test(s)), 'scope 只含 symbol|month，不含价格/数量：' + JSON.stringify(body.scope));

  const idx = await R.loadIndex({ fetch: tokenFetch, base: 'api/kline/' });
  ok(!!idx, 'loadIndex 读取成功');
  const idxCall = calls.filter((c) => /index/.test(c.url))[0];
  ok(!!idxCall && !!idxCall.opts.headers && idxCall.opts.headers['x-kline-token'] === 'TK-LEDGER-1',
    '索引请求带 x-kline-token：' + JSON.stringify(idxCall && idxCall.opts.headers));

  await R.loadPack('sh600519', '2024-03', { fetch: tokenFetch });
  const packCall = calls.filter((c) => /pack/.test(c.url))[0];
  ok(!!packCall && packCall.opts.headers && packCall.opts.headers['x-kline-token'] === 'TK-LEDGER-1',
    '月包请求也带 x-kline-token');

  R.clearToken();
  const tok401 = await R.ensureToken({
    trades: [{ date: '2024-05-02', code: '600036' }],
    fetch: async () => ({ ok: false, status: 401 }),
  });
  ok(tok401 === '', '401 / 令牌失败 → 返回空令牌（调用方必须降级）');

  /* ---------------- 页面渲染夹具 ---------------- */
  function flush(n) {
    return new Promise((res) => {
      let i = 0;
      const tick = () => (++i >= n ? res() : setImmediate(tick));
      setImmediate(tick);
    });
  }

  function renderPage(search, opts) {
    const o = opts || {};
    const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'replay.html'), 'utf8')
      .match(/<script>([\s\S]*?)<\/script>/)[1];
    function El(tag, id) {
      this.tag = tag; this.id = id; this.textContent = ''; this.innerHTML = '';
      this.hidden = false; this.value = ''; this.onchange = null; this.children = [];
      this._attrs = {}; this._handlers = {};
      this.classList = { toggle: function () {} };
    }
    El.prototype.appendChild = function (c) { this.children.push(c); return c; };
    El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
    El.prototype.getAttribute = function (k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
    };
    El.prototype.addEventListener = function (type, fn) { this._handlers[type] = fn; };
    El.prototype.querySelectorAll = function (sel) {
      return sel === 'button' ? this.children.filter((c) => c.tag === 'button') : [];
    };
    El.prototype.querySelector = function () { return null; };
    const els = {};
    const doc = {
      getElementById(id) { return els[id] || (els[id] = new El('div', id)); },
      createElement(tag) { return new El(tag, ''); },
    };
    const fm = /f=([^&]+)/.exec(search || '');
    const flags = fm ? fm[1].split(',') : [];
    const win = {
      PanjiFlag(name) { return flags.indexOf(name) >= 0; },
      PanjiReplay: Object.assign(Object.create(R), {
        mount: function (el) { el.innerHTML = '<canvas id="chart" data-test="demo"></canvas>'; return { view: function () { return { shown: 1, bars: [] }; } }; },
        mountDrill: function () { return null; },
        drawChart: function () { return null; },
      }),
    };
    const loc = { search: search || '' };
    const store = {
      getItem(k) {
        if (k !== 'guanzhu_ledger') return null;
        return o.ledger ? JSON.stringify(o.ledger) : null;
      },
      setItem() {}, removeItem() {},
    };
    const pageCalls = [];
    const fetchStub = function (url, init) {
      pageCalls.push({ url: String(url), opts: init || {} });
      if (o.fetch) return o.fetch(url, init);
      return Promise.resolve({ ok: false, status: 404 });
    };
    globalThis.localStorage = store;
    if (o.globalFetch) globalThis.fetch = o.globalFetch;
    const fn = new Function('window', 'document', 'location', 'localStorage', 'fetch', 'console', code);
    fn(win, doc, loc, store, fetchStub, console);
    return {
      win, els, calls: pageCalls,
      text: function () {
        return [els.title, els.sub, els.tag, els.stage, els['src-badge'], els['sel-symbol'], els['sel-month']]
          .filter(Boolean).map((e) => String(e.textContent || '') + String(e.innerHTML || '')).join('\n');
      },
    };
  }

  console.log('[3] 无档案首屏：不画合成 K 线，先给两个入口');
  const empty = renderPage('');
  await flush(6);
  ok(empty.win.__replay.source() === 'empty', '来源状态 = empty');
  ok((empty.els.stage.innerHTML.match(/<canvas/g) || []).length === 0, '首屏合成 K 线元素数 = 0');
  ok(/id="empty-demo"/.test(empty.els.stage.innerHTML), '存在「先看示例档案」入口');
  ok(/id="empty-upload" href="\.\/"/.test(empty.els.stage.innerHTML), '存在「上传交割单」入口，走现有首页路由');
  ok(/示例/.test(empty.text()) && /合成/.test(empty.text()), '空态文案同时含「示例」「合成」');
  ok(empty.win.__replay.badge() === '', '空态不显示来源角标（不冒充真实/合成）');

  console.log('[4] 点「先看示例档案」：才出现走势，角标 = 示例 · 合成走势 · 非真实数据');
  const demoBtn = empty.els['empty-demo'];
  ok(!!demoBtn && typeof demoBtn._handlers.click === 'function', '示例按钮已挂 click 处理器');
  demoBtn._handlers.click();
  await flush(6);
  ok(empty.win.__replay.source() === 'demo', '点后来源状态 = demo');
  ok(/<canvas/.test(empty.els.stage.innerHTML), '点后才出现走势 canvas');
  ok(empty.win.__replay.badge() === '示例 · 合成走势 · 非真实数据',
    '角标文案 = ' + empty.win.__replay.badge());
  ok(empty.calls.length === 0, '示例不走服务端，请求数 = ' + empty.calls.length);

  console.log('[5] f=real 但无档案：仍是空态；点示例也不请求真实包');
  const realNoArc = renderPage('?f=real,train&tab=a');
  await flush(6);
  ok(realNoArc.win.__replay.source() === 'empty', 'f=real 无档案首屏 = empty');
  realNoArc.win.__replay.showDemo();
  await flush(10);
  ok(realNoArc.win.__replay.source() === 'demo', '示例态来源 = demo');
  ok(realNoArc.win.__replay.badge() === '示例 · 合成走势 · 非真实数据', '示例态角标正确');
  ok(realNoArc.calls.filter((c) => !/builtin\//.test(c.url)).length === 0,
    '示例态即使 f=real 也不请求真实包，请求数 = '
    + realNoArc.calls.filter((c) => !/builtin\//.test(c.url)).length
    + '（另有内置目录探测 ' + realNoArc.calls.filter((c) => /builtin\//.test(c.url)).length + ' 次）');

  console.log('[6] 有档案 + f=real,train：真实路径，索引请求带 x-kline-token');
  const realCalls = [];
  const pageFetch = function (url, init) {
    realCalls.push({ url: String(url), opts: init || {} });
    if (/index/.test(String(url))) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ schema: 'panji.kline.index.v1', symbols: { sh600519: { name: '贵州茅台', months: ['2024-03'] } } }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
  const tokenFetch2 = async (url, init) => {
    if (/token(\?|$)/.test(String(url))) {
      return { ok: true, status: 200, json: async () => ({ token: 'TK-PAGE-1', exp: Math.floor(Date.now() / 1000) + 600 }) };
    }
    return { ok: false, status: 404 };
  };
  R.clearToken();
  const real = renderPage('?f=real,train&tab=a', { ledger: LEDGER, fetch: pageFetch, globalFetch: tokenFetch2 });
  await flush(30);
  ok(real.win.__replay.source() === 'real', '有档案 → 来源状态 = real');
  ok(real.win.__replay.badge() === '本机档案回放', '角标 = ' + real.win.__replay.badge());
  ok(real.win.__replay.tab() === 'a', '?tab=a 逻辑不变');
  const realIdx = realCalls.filter((c) => !/builtin\//.test(c.url) && /index/.test(c.url))[0];
  ok(!!realIdx && realIdx.opts.headers && realIdx.opts.headers['x-kline-token'] === 'TK-PAGE-1',
    '真实索引请求带 x-kline-token：' + JSON.stringify(realIdx && realIdx.opts.headers));
  ok(!/降级为示意/.test(real.text()), '有档案且令牌成功 → 不出现降级角标');

  globalThis.localStorage = prevLoc;
  console.log('\n' + pass + ' 项通过 / ' + fail + ' 项失败');
  process.exit(fail ? 1 : 0);
})();
