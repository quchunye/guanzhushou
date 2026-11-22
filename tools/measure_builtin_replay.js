/* 实测回放页的内置分片加载链路：node tools/measure_builtin_replay.js
   起一个临时静态服务（模拟线上走 http，不是读本地磁盘），按页面同样的顺序
   fetch → arrayBuffer → gunzip → JSON.parse → parseKlines 走一遍，报：
     1) 首屏（只读 index.json）
     2) 切一只票（拉单片 gz）
     3) 窗口切换（同一只票换窗口）
     4) 50 只全量抽查：随机 10 只 × 2 窗口，报解析成功数
   产物：build/builtin_probe_20261106/replay_measure.json（临时报告，不提交） */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const R = require(path.join(PUBLIC, 'features', 'replay.js'));
const OUT = path.join(ROOT, 'build', 'builtin_probe_20261106', 'replay_measure.json');

function msOf(a, b) {
  return Number(b - a) / 1e6;
}

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(PUBLIC, p.replace(/^\/+/, ''));
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(file);
        const ctype = ext === '.json' ? 'application/json' : (ext === '.gz' ? 'application/gzip' : 'text/plain');
        res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(buf.length) });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

async function timedFetch(base, url) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf.length, fetchMs: msOf(t0, process.hrtime.bigint()), buf };
}

// 与 public/replay.html 的首屏/切票链路一致
async function loadPackLikePage(base, url) {
  const f = await timedFetch(base, url);
  if (f.status !== 200) return { ok: false, status: f.status, bytes: f.bytes, fetchMs: f.fetchMs };
  const t1 = process.hrtime.bigint();
  const txt = zlib.gunzipSync(f.buf).toString('utf8');
  const t2 = process.hrtime.bigint();
  const obj = JSON.parse(txt);
  const t3 = process.hrtime.bigint();
  const klines = R.parseKlines(obj.bars);
  const t4 = process.hrtime.bigint();
  if (!klines) return { ok: false, bytes: f.bytes, fetchMs: f.fetchMs, rawBytes: f.buf.length };
  return {
    ok: true, bytes: f.bytes, fetchMs: f.fetchMs,
    gunzipMs: msOf(t1, t2), jsonMs: msOf(t2, t3), parseMs: msOf(t3, t4),
    decodeMs: msOf(t1, t4),
    bars: klines.length, days: obj.days, first: obj.first, last: obj.last,
    pack: obj, klines,
  };
}

function fmt(n) { return String(n); }
function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

(async () => {
  const { srv, base } = await serve();
  const report = { at: new Date().toISOString(), base: 'local-static' };
  try {
    // 1) 首屏：只读 index.json
    const idxReq = await timedFetch(base, '/builtin/index.json');
    const idx = JSON.parse(idxReq.buf.toString('utf8'));
    report.firstScreen = {
      url: '/builtin/index.json', bytes: idxReq.bytes, ms: +idxReq.fetchMs.toFixed(2),
      schema: idx.schema, version: idx.version,
      windows: idx.windows.map((w) => w.id + ' ' + w.first + '~' + w.last),
      symbols: idx.symbols.length, packs: idx.windows.length * idx.symbols.length,
      packsTotalBytes: idx.symbols.reduce((s, x) => s + (x.bytes['2025h2'] || 0) + (x.bytes['2026q2q3'] || 0), 0),
    };

    // 2) 切一只票：默认窗口（2026q2q3）+ 第一只票
    const winB = idx.windows[idx.windows.length - 1].id;
    const code = idx.symbols[0].code;
    const packUrl = (c, w) => '/builtin/pack/' + c + '.' + w + '.json.gz?v=' + encodeURIComponent(idx.version);
    const pB = await loadPackLikePage(base, packUrl(code, winB));
    if (!pB.ok) throw new Error('默认窗口分片读取失败 ' + code + ' ' + winB);
    report.pickOne = {
      code, window: winB, bytes: pB.bytes, fetchMs: +pB.fetchMs.toFixed(2),
      gunzipMs: +pB.gunzipMs.toFixed(2), jsonMs: +pB.jsonMs.toFixed(2), parseMs: +pB.parseMs.toFixed(2),
      decodeMs: +pB.decodeMs.toFixed(2), bars: pB.bars, days: pB.days,
    };

    // 3) 窗口切换：同一只票换到另一个窗口
    const winA = idx.windows[0].id;
    const pA = await loadPackLikePage(base, packUrl(code, winA));
    if (!pA.ok) throw new Error('窗口切换分片读取失败 ' + code + ' ' + winA);
    report.switchWindow = {
      code, window: winA, bytes: pA.bytes, fetchMs: +pA.fetchMs.toFixed(2),
      gunzipMs: +pA.gunzipMs.toFixed(2), jsonMs: +pA.jsonMs.toFixed(2), parseMs: +pA.parseMs.toFixed(2),
      decodeMs: +pA.decodeMs.toFixed(2), bars: pA.bars, days: pA.days,
    };

    // 页面开工：分片解析后按日切片 + 出题（不含 DOM 挂载）
    const t0 = process.hrtime.bigint();
    const dp = R.pickDayPack(pB, code + '|' + winB, 60);
    const drill = dp ? R.buildDrill(dp, { count: 8 }) : null;
    const t1 = process.hrtime.bigint();
    const step = dp ? R.buildStep(dp, { base: 30 }) : null;
    const stepMax = step ? R.stepView(step, 0).total : 0;
    const t2 = process.hrtime.bigint();
    report.pageBuild = {
      day: dp ? dp.day : '', dayBars: dp ? dp.klines.length : 0,
      drillQuestions: drill ? drill.checkpoints.length : 0,
      drillMs: +msOf(t0, t1).toFixed(2),
      stepTotal: stepMax,
      stepMs: +msOf(t1, t2).toFixed(2),
    };

    // 4) 50 只全量抽查：随机 10 只 × 2 窗口
    const seed = crypto.createHash('sha1').update('20261107').digest();
    const pick = [];
    const pool = idx.symbols.map((s) => s.code);
    let h = seed.readUInt32LE(0);
    while (pick.length < 10 && pool.length) {
      h = (h * 1103515245 + 12345) >>> 0;
      const i = h % pool.length;
      pick.push(pool.splice(i, 1)[0]);
    }
    let okCount = 0, failCount = 0, totalBytes = 0, totalBars = 0;
    const rows = [];
    for (const c of pick) {
      for (const w of idx.windows.map((x) => x.id)) {
        const p = await loadPackLikePage(base, packUrl(c, w));
        totalBytes += p.bytes;
        if (p.ok) {
          okCount += 1; totalBars += p.bars;
          rows.push({ code: c, window: w, ok: true, bytes: p.bytes,
            fetchMs: +p.fetchMs.toFixed(2), decodeMs: +p.decodeMs.toFixed(2), bars: p.bars });
        } else {
          failCount += 1;
          rows.push({ code: c, window: w, ok: false, bytes: p.bytes });
        }
      }
    }
    report.sample = {
      picked: pick, packs: rows.length, ok: okCount, fail: failCount,
      totalBytes, totalBytesKB: +(totalBytes / 1024).toFixed(1), totalBars,
      avgDecodeMs: +(rows.filter((r) => r.ok).reduce((s, r) => s + r.decodeMs, 0) / Math.max(1, okCount)).toFixed(2),
      rows,
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

    console.log('FIRST_SCREEN index ' + fmt(report.firstScreen.bytes) + ' B (' + kb(report.firstScreen.bytes) + ') '
      + report.firstScreen.ms + ' ms | windows=' + report.firstScreen.windows.join(' / ')
      + ' | symbols=' + report.firstScreen.symbols + ' | packs=' + report.firstScreen.packs);
    console.log('PICK_ONE ' + code + ' ' + winB + ' ' + kb(pB.bytes) + ' fetch ' + report.pickOne.fetchMs
      + ' ms decode ' + report.pickOne.decodeMs + ' ms (gunzip ' + report.pickOne.gunzipMs
      + ' / json ' + report.pickOne.jsonMs + ' / parse ' + report.pickOne.parseMs + ') bars=' + pB.bars);
    console.log('SWITCH_WINDOW ' + code + ' ' + winA + ' ' + kb(pA.bytes) + ' fetch ' + report.switchWindow.fetchMs
      + ' ms decode ' + report.switchWindow.decodeMs + ' ms bars=' + pA.bars);
    console.log('PAGE_BUILD day=' + report.pageBuild.day + ' bars=' + report.pageBuild.dayBars
      + ' drill=' + report.pageBuild.drillQuestions + ' questions in ' + report.pageBuild.drillMs
      + ' ms | step total=' + report.pageBuild.stepTotal + ' in ' + report.pageBuild.stepMs + ' ms');
    console.log('SAMPLE_10X2 ok=' + okCount + '/' + rows.length + ' fail=' + failCount
      + ' total=' + kb(totalBytes) + ' bars=' + totalBars + ' avgDecode=' + report.sample.avgDecodeMs + ' ms');
    console.log('REPORT ' + OUT);
  } finally {
    srv.close();
  }
})().catch((e) => {
  console.error('MEASURE_FAIL ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
