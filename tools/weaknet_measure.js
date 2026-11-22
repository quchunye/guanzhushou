/* 弱网三档首屏耗时实测（真服务 + 真浏览器 + CDP 节流）
 * 用法：node tools/weaknet_measure.js
 * 输出：三档（5Mbps / 1Mbps / 300kbps）下 replay 页首屏到可渲染的真实耗时
 */
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_PATH || 'C:\\Users\\曲\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const PORT = 9333;
const TARGET = process.env.TARGET_URL || 'http://localhost:3210/replay.html?f=train';

// CDP 网络条件：download(字节/秒), upload, latency(ms)
// 5 Mbps = 625000 B/s；1 Mbps = 125000 B/s；300 kbps = 37500 B/s
const SPEEDS = [
  { name: '5Mbps', download: 625000, upload: 625000, latency: 20 },
  { name: '1Mbps', download: 125000, upload: 125000, latency: 50 },
  { name: '300kbps', download: 37500, upload: 37500, latency: 100 },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cdpSend(ws, method, params = {}, id) {
  return new Promise((resolve, reject) => {
    const msg = { id, method, params };
    const onMsg = (data) => {
      const obj = JSON.parse(data.toString());
      if (obj.id === id) {
        ws.removeListener('message', onMsg);
        if (obj.error) reject(new Error(obj.error.message));
        else resolve(obj.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify(msg));
  });
}

function getWsUrl() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json/version`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body).webSocketDebuggerUrl); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function newPage() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'localhost', port: PORT, path: '/json/new', method: 'PUT',
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function measureSpeed(ws, speed, pageId) {
  let id = 1;
  // 启用网络域并设置节流
  await cdpSend(ws, 'Network.enable', {}, id++);
  await cdpSend(ws, 'Network.setCacheDisabled', { cacheDisabled: true }, id++);
  await cdpSend(ws, 'Network.emulateNetworkConditions', {
    offline: false,
    latency: speed.latency,
    downloadThroughput: speed.download,
    uploadThroughput: speed.upload,
    connectionType: 'cellular4g',
  }, id++);
  // 启用页面域，监听加载事件
  await cdpSend(ws, 'Page.enable', {}, id++);
  await cdpSend(ws, 'Runtime.enable', {}, id++);

  // 记录事件时间戳
  const events = {};
  const onEvent = (data) => {
    const obj = JSON.parse(data.toString());
    if (obj.method === 'Page.loadEventFired') events.load = obj.params.timestamp;
    if (obj.method === 'Page.domContentEventFired') events.domContent = obj.params.timestamp;
    if (obj.method === 'Network.loadingFinished' && obj.params.requestId) {
      // 记录最后一个请求完成时间
      events.lastRequest = obj.params.timestamp;
    }
  };
  ws.on('message', onEvent);

  const navStart = Date.now() / 1000;
  // 导航
  await cdpSend(ws, 'Page.navigate', { url: TARGET }, id++);

  // 等待可渲染：目录加载完成（#builtin-list 有内容）或 load 事件后 500ms
  let renderable = null;
  for (let i = 0; i < 180; i++) { // 最多等 90s
    await sleep(500);
    try {
      const r = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function(){
          var sel = document.getElementById('sel-symbol');
          var optCount = sel ? sel.options.length : 0;
          var stage = document.getElementById('stage');
          var stageText = stage ? stage.textContent.trim() : '';
          var stageHasContent = stageText.length > 0;
          var perf = performance.getEntriesByType('navigation')[0];
          var paints = performance.getEntriesByType('paint');
          var fcpEntry = paints.find(function(p){return p.name==='first-contentful-paint';});
          return JSON.stringify({
            optCount: optCount,
            stageHasContent: stageHasContent,
            stageTextLen: stageText.length,
            fcp: fcpEntry ? fcpEntry.startTime : null,
            load: perf ? perf.loadEventEnd : null,
            domContent: perf ? perf.domContentLoadedEventEnd : null,
          });
        })()`,
        returnByValue: true,
      }, id++);
      const val = JSON.parse(r.result.value);
      // 可渲染 = 下拉框有标的选项（目录已加载）
      if (val.optCount > 0) {
        renderable = val;
        renderable.elapsed = (Date.now() / 1000) - navStart;
        break;
      }
      // 兜底：页面 load 后等 15s 仍无目录，按失败态记录（不提前退出）
      if (val.load && (Date.now() / 1000) - navStart > (val.load / 1000) + 15) {
        renderable = val;
        renderable.elapsed = (Date.now() / 1000) - navStart;
        renderable.timeout = true;
        break;
      }
    } catch (e) { /* 页面还在导航 */ }
  }

  ws.removeListener('message', onEvent);
  return { speed: speed.name, renderable, navStart };
}

async function runOneSpeed(speed, idx) {
  const profile = `C:\\temp\\chrome_wn_${idx}`;
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT + idx}`,
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=390,844',
    `--user-data-dir=${profile}`,
  ], { stdio: 'ignore' });

  try {
    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
      try {
        wsUrl = await new Promise((resolve, reject) => {
          http.get(`http://localhost:${PORT + idx}/json/version`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body).webSocketDebuggerUrl); } catch (e) { reject(e); } });
          }).on('error', reject);
        });
        break;
      } catch (e) { await sleep(500); }
    }
    if (!wsUrl) { console.error(`Chrome ${speed.name} 未启动`); return null; }

    const page = await new Promise((resolve, reject) => {
      const req = http.request({ host: 'localhost', port: PORT + idx, path: '/json/new', method: 'PUT' }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.end();
    });

    const pageWs = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { pageWs.on('open', r); pageWs.on('error', j); });
    const r = await measureSpeed(pageWs, speed, page.id);
    pageWs.close();
    return r;
  } finally {
    chrome.kill();
  }
}

async function main() {
  const results = [];
  for (let i = 0; i < SPEEDS.length; i++) {
    const r = await runOneSpeed(SPEEDS[i], i);
    if (r) results.push(r);
    await sleep(1500);
  }

  // 输出结果
  console.log('\n========== 弱网三档首屏耗时实测（冷启动 · 每档独立 profile）==========');
  console.log(`目标页: ${TARGET}`);
  console.log(`浏览器: ${CHROME}`);
  console.log('------------------------------------------');
  for (const r of results) {
    const v = r.renderable || {};
    console.log(`【${r.speed}】`);
    console.log(`  首屏可渲染耗时: ${(v.elapsed * 1000).toFixed(0)} ms`);
    console.log(`  FCP:           ${v.fcp ? v.fcp.toFixed(0) + ' ms' : 'N/A'}`);
    console.log(`  DOMContentLoaded: ${v.domContent ? v.domContent.toFixed(0) + ' ms' : 'N/A'}`);
    console.log(`  loadEventEnd:  ${v.load ? v.load.toFixed(0) + ' ms' : 'N/A'}`);
    console.log(`  标的选项数:     ${v.optCount || 0}${v.timeout ? '  [TIMEOUT]' : ''}`);
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
