'use strict';
/*
 * 跨机型自适应验收脚本（只读，不修改任何产品文件）
 *
 * 用法：node tools/adaptive_check.js
 * 依赖：本机 Edge（Chromium）+ Node 24 内置 WebSocket（无需 npm install）
 * 产物：tools/adaptive_report.json（每页×每档：横向溢出 / 最小渲染字号 / ≤9.5px 实例）
 *
 * 口径说明：
 *   - 分辨率 5 档：360x640 / 393x873 / 412x915 / 428x926 / 800x1280（平板/折叠）
 *   - 字号维度：本 App WebView 未接 font_scale，系统字号对 H5 无效（如实标注）；
 *     故本脚本只做「渲染字号下限」读数，与静态扫描相互印证。
 *   - 页面用 file:// 打开（不依赖 server 启动，避免 .env/端口/资源冲突）；
 *     空态为主，数据态/服务端渲染未覆盖（见报告 note）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9223;
const USER_DATA = path.join(os.tmpdir(), 'panji_adaptive_edge_' + Date.now());

const PAGES = [
  'index', 'replay', 'replay_readonly', 'archive', 'records', 'discipline',
  'collection', 'learn', 'cases', 'features', 'guide', 'about', 'privacy',
  'agreement', 'membership', 'login', 'migrate', 'share', 'stats', 'pay-return',
];

const VIEWPORTS = [
  { w: 360, h: 640, label: '360x640' },
  { w: 393, h: 873, label: '393x873' },
  { w: 412, h: 915, label: '412x915' },
  { w: 428, h: 926, label: '428x926' },
  { w: 800, h: 1280, label: '平板/折叠' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 启动 headless Edge，等待 CDP 就绪
function startEdge() {
  if (!fs.existsSync(EDGE)) {
    console.error('ADAPTIVE_FAIL 未找到 Edge: ' + EDGE);
    process.exit(1);
  }
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + USER_DATA,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    'about:blank',
  ];
  const p = spawn(EDGE, args, { stdio: 'ignore' });
  p.on('error', (e) => { console.error('ADAPTIVE_FAIL 启动 Edge 失败: ' + e.message); process.exit(1); });
  return p;
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version');
      if (r.ok) return;
    } catch (e) { /* 未就绪 */ }
    await sleep(250);
  }
  console.error('ADAPTIVE_FAIL Edge CDP 未就绪（10s 超时）');
  process.exit(1);
}

async function newTab(url) {
  const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  const tab = await r.json();
  return tab.webSocketDebuggerUrl;
}

// 极简 CDP 客户端（Node 24 内置 WebSocket）
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', rej);
    });
    this.ws.addEventListener('message', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message || 'cdp_error'));
        else resolve(m.result);
      }
    });
  }
  async send(method, params) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const READ_JS = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const scrollOverflow = sw > vw + 1;
  let minFont = null;
  const tiny = [];
  const seen = new Set();
  const over = [];
  const innerScroll = [];
  const all = document.querySelectorAll('body *');
  // 祖先里有 overflow-x:auto/scroll 的，属容器内滚动（设计如此），不算页面级溢出
  const inScrollBox = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
      p = p.parentElement;
    }
    return false;
  };
  all.forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    // 逐元素右边界检测：scrollWidth 会被 overflow-x:hidden 吞掉，rect 不会
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && (rect.right > vw + 1 || rect.left < -1)) {
      const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      const item = { tag: el.tagName, sel: el.tagName.toLowerCase() + (cls ? '.' + cls : ''),
                     left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) };
      if (inScrollBox(el)) innerScroll.push(item); else over.push(item);
    }
    const t = (el.textContent || '').trim();
    if (!t) return;
    const fz = parseFloat(cs.fontSize);
    if (!isFinite(fz)) return;
    if (minFont == null || fz < minFont) minFont = fz;
    if (fz <= 9.5) {
      const key = cs.fontSize + '|' + t.slice(0, 16);
      if (!seen.has(key)) { seen.add(key); tiny.push({ px: cs.fontSize, text: t.slice(0, 24), tag: el.tagName, sel: el.tagName.toLowerCase() }); }
    }
  });
  // 页面到底渲没渲染：元素数 + 可见文字量
  const elemCount = all.length;
  const textLen = document.body ? (document.body.innerText || '').replace(/\\s+/g, '').length : 0;
  return { vw, sw, overflowX: over.length > 0, scrollOverflow, overflowCount: over.length,
           overflow: over.slice(0, 12), innerScrollCount: innerScroll.length, innerScroll: innerScroll.slice(0, 6),
           minFont, tinyCount: tiny.length, tiny: tiny.slice(0, 15),
           elemCount, textLen, rendered: elemCount >= 5 && textLen >= 20 };
})()`;

async function checkPage(cdp, page, vp) {
  const file = path.join(PUBLIC, page + '.html');
  const url = pathToFileURL(file).href;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 500,
  });
  await cdp.send('Page.navigate', { url });
  await sleep(1200); // 等 JS 渲染（空态/示例态）
  let res;
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: READ_JS, returnByValue: true });
    res = (r && r.result && r.result.value) || null;
  } catch (e) {
    res = { error: e.message };
  }
  return res;
}

async function main() {
  console.log('[自适应验收] 启动 Edge headless…');
  const edge = startEdge();
  await waitReady();

  console.log('[自适应验收] 打开首 tab…');
  const wsUrl = await newTab('about:blank');
  const cdp = new CDP(wsUrl);

  const report = { generatedAt: new Date().toISOString(), note: 'file:// 空态验收；WebView 未接 font_scale，系统字号对 H5 无效；数据态未覆盖', rows: [] };

  let done = 0;
  const total = PAGES.length * VIEWPORTS.length;
  for (const page of PAGES) {
    for (const vp of VIEWPORTS) {
      const r = await checkPage(cdp, page, vp);
      const row = { page, vp: vp.label, ...(r || {}) };
      report.rows.push(row);
      done++;
      const flag = (r && r.overflowCount) ? '  <-- 页面级溢出' + r.overflowCount : ((r && r.minFont != null && r.minFont <= 9.5) ? '  <-- 字号<=9.5' : '');
      console.log('  [' + String(done).padStart(3) + '/' + total + '] ' + page + ' @' + vp.label + '  overflow=' + (r ? (r.overflowCount || 0) : 'ERR') + '  innerScroll=' + (r ? r.innerScrollCount : '-') + '  minFont=' + (r && r.minFont != null ? r.minFont : '-') + '  elem=' + (r ? r.elemCount : '-') + '  text=' + (r ? r.textLen : '-') + (r && !r.rendered ? '  <-- 疑似未渲染' : '') + flag);
    }
  }

  cdp.close();
  try { edge.kill(); } catch (e) {}
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (e) {}

  const out = path.join(ROOT, 'tools', 'adaptive_report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('');
  console.log('报告已写入 ' + out);

  // 汇总
  const overflowRows = report.rows.filter((r) => r.overflowCount > 0);
  const tinyRows = report.rows.filter((r) => r.minFont != null && r.minFont <= 9.5);
  const notRendered = report.rows.filter((r) => r.rendered === false);
  const perPage = {};
  overflowRows.forEach((r) => { perPage[r.page] = (perPage[r.page] || 0) + r.overflowCount; });
  const top3 = Object.entries(perPage).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const narrow = report.rows.filter((r) => r.vp === '360x640');
  console.log('横向溢出组合数: ' + overflowRows.length + ' / ' + total);
  console.log('溢出元素总数: ' + overflowRows.reduce((s, r) => s + r.overflowCount, 0));
  console.log('溢出最多的前三页: ' + (top3.length ? top3.map(([p, n]) => p + '(' + n + ')').join(', ') : '无'));
  console.log('360x640 档溢出元素数: ' + narrow.reduce((s, r) => s + (r.overflowCount || 0), 0) + '（' + narrow.filter((r) => r.overflowCount > 0).map((r) => r.page).join(', ') + '）');
  console.log('出现 <=9.5px 渲染字号的组合数: ' + tinyRows.length + ' / ' + total + '（页面: ' + ([...new Set(tinyRows.map((r) => r.page))].join(', ') || '无') + '）');
  console.log('疑似未渲染组合数: ' + notRendered.length + ' / ' + total + (notRendered.length ? '（' + [...new Set(notRendered.map((r) => r.page))].join(', ') + '）' : ''));
}

main().catch((e) => { console.error('ADAPTIVE_FAIL ' + (e && e.stack || e)); process.exit(1); });
