// replay_synth_test.js —— 合成示意模式验收（node test/replay_synth_test.js）
// 上线默认：只用页面按固定种子生成的走势，不请求任何 data/kline 真实包。
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../public/features/replay');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

console.log('[1] 合成走势：形状 / 根数 / 可复现');
const k1 = R.synthPack('syn001', '0001-01');
ok(!!k1 && k1.synthetic === true, '合成包标记 synthetic=true');
ok(k1.klines.length === R.SYNTH_DAYS.length * 48, '3 个示意日 × 48 根 = ' + k1.klines.length);
const perDay = {};
k1.klines.forEach((b) => { perDay[String(b.t).slice(0, 8)] = (perDay[String(b.t).slice(0, 8)] || 0) + 1; });
ok(Object.keys(perDay).every((d) => perDay[d] === 48), '每个示意日都是 48 根（午休无 bar）');
ok(k1.klines[0].t % 10000 === 935 && k1.klines[47].t % 10000 === 1500, '首根 09:35、末根 15:00');
ok(k1.klines.every((b) => b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c) && b.l > 0),
  'OHLC 自洽（高≥开收、低≤开收、低>0）');

const again = R.synthPack('syn001', '0001-01');
ok(JSON.stringify(k1.klines) === JSON.stringify(again.klines), '固定种子：两次生成逐字节一致');

console.log('[2] 不含真实票号与真实日期');
ok(/^syn\d+$/.test(k1.symbol) && !/^(sh|sz|bj)\d{6}$/.test(k1.symbol),
  '合成票号不是真实 A 股代码（' + k1.symbol + '）');
ok(R.SYNTH_DAYS.every((d) => Number(d.slice(0, 4)) < 1900), '示意日期年份 < 1900，不对应真实交易日');

console.log('[3] 默认页合成回放：可挂载、有成交锚');
const rep = R.loadSynth('syn001', R.SYNTH_DAYS[1]);
ok(!!rep && rep.checkpoints.length === 3, '合成回放有 3 个成交锚');
ok(rep.klines.length === 48, '当天可见 K 线 48 根');
ok(rep.adjust === 'synthetic', '标注 adjust=synthetic（不是真实复权）');

console.log('[4] 零真实数据请求（请求拦截）');
let hits = [];
let hitsKline = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  hits.push(String(url));
  if (String(url).indexOf('data/kline/') >= 0) hitsKline.push(String(url));
  return { ok: false, status: 404 };
};
try {
  // 把默认模式（不带 flag）会走到的入口全跑一遍：索引、各票各月包、回放
  const idx = R.synthIndex();
  ok(!!idx && idx.synthetic === true && idx.total_files === 0, '合成索引不登记任何真实包');
  R.synthMeta().symbols.forEach((s) => {
    R.synthPack(s.symbol, '0001-01');
    R.SYNTH_DAYS.forEach((d) => R.loadSynth(s.symbol, d));
  });
} finally {
  globalThis.fetch = origFetch;
}
ok(hits.length === 0, '总请求命中数 = ' + hits.length);
ok(hitsKline.length === 0, 'data/kline 请求命中数 = ' + hitsKline.length);

const html4 = fs.readFileSync(path.join(__dirname, '..', 'public', 'replay.html'), 'utf8');
ok(/var REAL = !!\(window\.PanjiFlag && window\.PanjiFlag\('real'\)\)/.test(html4),
  '真实数据开关默认关闭（只在 f=real 时打开）');
ok(/if \(!REAL \|\| DEMO\) \{[\s\S]*?synthIndex\(\)[\s\S]*?return;/.test(html4),
  '索引在合成模式（含示例态）下本地生成并提前返回');
ok(/\(REAL && !DEMO\) \? R\.SAMPLE : \{ symbol: 'syn001'/.test(html4), '默认页（不带 flag）样本走合成票');

console.log('[5] 真实模式才带版本号请求 index.json');
(async () => {
  const urls = [];
  const f = async (u) => {
    urls.push(String(u));
    return { ok: true, status: 200, text: async () => JSON.stringify({ schema: 'panji.kline.index.v1', months: {} }) };
  };
  await R.loadIndex({ fetch: f, base: 'data/kline/' });
  ok(urls.length === 1, '真实模式只请求 1 次索引');
  ok(/index(\.json)?\?v=/.test(urls[0]), '索引请求带 ?v= 版本号：' + urls[0]);

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'replay.html'), 'utf8');
  ok(/index(\.json)?\?v=/.test(html), 'replay.html 的索引请求也带 ?v=');
  ok(/if \(!REAL \|\| DEMO\)\s*\{/.test(html) && /synthIndex\(\)/.test(html), 'replay.html 合成模式（含示例态）提前返回、不 fetch');

  console.log('[6] 渲染文本扫描：任何字段缺失都不出现 undefined/null/NaN');
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
      this._attrs = {}; this.classList = { toggle: function () {} };
    }
    El.prototype.appendChild = function (c) { this.children.push(c); return c; };
    El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
    El.prototype.getAttribute = function (k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
    };
    El.prototype.addEventListener = function () {};
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
        mount: function () { return null; },
        mountDrill: function () { return null; },
        drawChart: function () { return null; },
      }),
    };
    const loc = { search: search || '' };
    const store = {
      getItem(k) {
        if (k !== 'guanzhu_ledger') return null;   // 令牌缓存也返回空，测试不串缓存
        return o.ledger ? JSON.stringify(o.ledger) : null;
      },
      setItem() {}, removeItem() {},
    };
    const fetchStub = o.fetch || function () { return Promise.resolve({ ok: false, status: 404 }); };
    globalThis.localStorage = store;   // R.ensureToken / R.readTrades 走 globalThis.localStorage 夹具
    const fn = new Function('window', 'document', 'location', 'localStorage', 'fetch', 'console', code);
    fn(win, doc, loc, store, fetchStub, console);
    return {
      win,
      text: function () {
        return [els.title, els.sub, els.tag, els.stage, els['src-badge'], els['sel-symbol'], els['sel-month']]
          .filter(Boolean).map((e) => String(e.textContent || '') + String(e.innerHTML || '')).join('\n');
      },
    };
  }
  const scanPaths = ['', '?f=train&tab=a', '?f=train&tab=b', '?f=train&tab=c',
    '?f=real', '?f=real,train&tab=a', '?f=real,train&tab=c'];
  for (const p of scanPaths) {
    const pg = renderPage(p);
    await flush(8);
    const t = pg.text();
    ok(!!t && !/\bundefined\b|\bnull\b|\bNaN\b/.test(t),
      '路径 ' + (p || '(无 flag)') + ' 渲染文本无 undefined/null/NaN');
  }

  console.log('[7] 无档案：不直接合成，先给空态（示例 / 上传两个入口）');
  const empty = renderPage('?f=real,train&tab=a');
  await flush(12);
  const et = empty.text();
  ok(/还没有你自己的档案/.test(et), '无档案显示空态标题');
  ok(/id="empty-demo"/.test(et) && /id="empty-upload"/.test(et), '空态含「先看示例档案」「上传交割单」两个入口');
  ok((et.match(/<canvas/g) || []).length === 0, '无档案首屏合成 K 线元素数 = 0');
  ok(!/已切换为合成走势/.test(et), '无档案不再自动降级合成走势');
  ok(/示例/.test(et) && /合成/.test(et), '空态文案含「示例」与「合成」');
  ok(/id="empty-upload" href="\.\/"/.test(et), '「上传交割单」走现有首页路由，不新造页面');

  console.log('[8] 有档案但令牌失败 → 角标明确「降级为示意」');
  const LEDGER = { trades: [
    { date: '2024-03-05 10:12', code: '600519', name: '贵州茅台' },
    { date: '2024-03-06 14:03', code: '000001', name: '平安银行' },
  ] };
  const deg = renderPage('?f=real,train&tab=a', { ledger: LEDGER });
  await flush(20);
  const dt2 = deg.text();
  ok(/降级为示意/.test(dt2), '角标写明「降级为示意」');
  ok(/降级为示意 · 合成走势 · 非真实数据/.test(dt2), '角标同时写明合成走势、非真实数据');
  ok(!/本机档案回放/.test(dt2), '降级后不再标注「本机档案回放」');
  ok(/已切换为合成走势/.test(dt2), '降级原因仍可见');

  console.log('\n' + pass + ' 项通过 / ' + fail + ' 项失败');
  process.exit(fail ? 1 : 0);
})();
