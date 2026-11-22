#!/usr/bin/env node
/* 行情快照 manifest 生成器（只读随包数据，不接线上源、不改 public/builtin）
 *
 * 用法：
 *   node tools/build_snapshot.js                          # 读 public/builtin，产出 dist/snapshots/manifest.json
 *   node tools/build_snapshot.js --out D:\panji_snapshots
 *   node tools/build_snapshot.js --window 2026q2q3        # 只出一个窗口（快照口径）
 *   node tools/build_snapshot.js --generated-at 2026-11-09T15:41:12+08:00
 *
 * 设计口径（docs 设计稿第 2 条）：
 *   schema   = panji.snapshot.manifest.v1
 *   version  = <cutoffDay>-<内容哈希 8 位>（内容哈希不含 generatedAt）
 *   cutoffDay= 覆盖窗口里最大的 last
 *   files[].bytes/sha256 以磁盘实际字节为准，bars/days 取 index.json 聚合值
 *   base     = /api/snapshot/files/<version>/（客户端所有分片地址都由它拼出）
 *
 * 幂等：同输入跑两次输出字节一致（generatedAt 默认取输入文件最大 mtime，不取当前时间）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const SRC = path.resolve(argVal('--src', path.join(ROOT, 'public', 'builtin')));
const OUT_DIR = path.resolve(argVal('--out', path.join(ROOT, 'dist', 'snapshots')));
const ONLY_WIN = argVal('--window', 'all');
const MIN_CLIENT = argVal('--min-client', '1.0.0');
const MIN_CLIENT_CODE = +(argVal('--min-client-code', '1'));
const GENERATED_AT_ARG = argVal('--generated-at', '');
const BASE_ARG = argVal('--base', '');

const INDEX_FILE = path.join(SRC, 'index.json');
const PACK_DIR = path.join(SRC, 'pack');
const NEW_INDEX_SCHEMA = 'panji.builtin.index.v1';
const MANIFEST_SCHEMA = 'panji.snapshot.manifest.v1';

function die(msg) { console.error('SNAPSHOT_MANIFEST_FAIL ' + msg); process.exit(1); }
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function sha256Text(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function posix(p) { return p.replace(/\\/g, '/'); }

// 本地时间 +08:00，去掉毫秒；用于 deterministic 的 generatedAt
function isoCst(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().replace(/\.\d+Z$/, '') + '+08:00';
}

if (!fs.existsSync(INDEX_FILE)) die('索引不存在: ' + INDEX_FILE);
if (!fs.existsSync(PACK_DIR)) die('分片目录不存在: ' + PACK_DIR);

const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
if (!index || index.schema !== NEW_INDEX_SCHEMA) die('index.json schema 不符: ' + (index && index.schema));
if (!Array.isArray(index.windows) || !index.windows.length) die('index.json 没有 windows');
if (!Array.isArray(index.symbols) || !index.symbols.length) die('index.json 没有 symbols');

const windows = index.windows.filter((w) => ONLY_WIN === 'all' || w.id === ONLY_WIN);
if (!windows.length) die('窗口 ' + ONLY_WIN + ' 不在 index.json 的 windows 里');

const symbolByCode = new Map();
index.symbols.forEach((s) => {
  const code = String(s.code || '');
  if (code) symbolByCode.set(code, s);
});

// 枚举磁盘分片：<code>.<window>.json.gz
const diskFiles = fs.readdirSync(PACK_DIR)
  .filter((n) => n.endsWith('.json.gz'))
  .sort();

const files = [];
const warnings = [];
const seen = new Set();
let maxMtimeMs = fs.statSync(INDEX_FILE).mtimeMs;

for (const name of diskFiles) {
  const m = name.match(/^([0-9]{6})\.([A-Za-z0-9]+)\.json\.gz$/);
  if (!m) { warnings.push('命名不符，跳过: ' + name); continue; }
  const code = m[1];
  const win = m[2];
  if (!windows.some((w) => w.id === win)) continue;
  const sym = symbolByCode.get(code);
  if (!sym) { warnings.push('index 里没有该标的，跳过: ' + name); continue; }

  const abs = path.join(PACK_DIR, name);
  const st = fs.statSync(abs);
  maxMtimeMs = Math.max(maxMtimeMs, st.mtimeMs);
  const sha = sha256File(abs);
  const bars = (sym.bars && sym.bars[win]) || 0;
  const days = (sym.days && sym.days[win]) || 0;
  const idxBytes = (sym.bytes && sym.bytes[win]) || 0;
  if (idxBytes && idxBytes !== st.size) {
    warnings.push('磁盘字节与索引不一致: ' + name + ' disk=' + st.size + ' index=' + idxBytes);
  }
  files.push({
    path: 'pack/' + name,
    symbol: code,
    window: win,
    bytes: st.size,
    bars: bars,
    days: days,
    sha256: sha,
  });
  seen.add(code + '.' + win);
}

// index 声明了、磁盘却没有的片，明确记出来（不让「说截至某天其实缺片」）
for (const sym of index.symbols) {
  for (const w of windows) {
    const key = sym.code + '.' + w.id;
    if (!seen.has(key)) warnings.push('索引有、磁盘缺: ' + key + '.json.gz');
  }
}

if (!files.length) die('没有任何可用的分片');
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// cutoffDay：覆盖窗口里最大的 last
const cutoffDay = windows.reduce((mx, w) => (String(w.last) > mx ? String(w.last) : mx), '');

// 内容哈希：排序后的 files.sha256 + windows + cutoffDay；不含 generatedAt
const versionDigest = sha256Text([
  files.map((f) => f.sha256).join('\n'),
  windows.map((w) => [w.id, w.first, w.last].join(':')).join('\n'),
  cutoffDay,
].join('\n'));
const version = cutoffDay + '-' + versionDigest.slice(0, 8);

const generatedAt = GENERATED_AT_ARG || isoCst(maxMtimeMs);
const base = BASE_ARG || ('/api/snapshot/files/' + version + '/');
const indexSha = sha256File(INDEX_FILE);

// 每个窗口的交易日数：取 index 里出现最多的 days 值（同窗口各票一致）
const windowRows = windows.map((w) => {
  const counts = new Map();
  index.symbols.forEach((s) => {
    const d = (s.days && s.days[w.id]) || 0;
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  });
  let days = 0;
  let best = 0;
  counts.forEach((n, d) => { if (n > best) { best = n; days = d; } });
  return { id: w.id, first: String(w.first), last: String(w.last), label: w.label || '', days: days };
});

const symbols = index.symbols.map((s) => ({ code: String(s.code), name: String(s.name == null ? '' : s.name) }));
const counts = {
  symbols: symbols.length,
  files: files.length,
  bytes: files.reduce((n, f) => n + f.bytes, 0),
};

const body = {
  schema: MANIFEST_SCHEMA,
  version: version,
  generatedAt: generatedAt,
  cutoffDay: cutoffDay,
  minClient: MIN_CLIENT,
  minClientCode: MIN_CLIENT_CODE,
  base: base,
  index: { path: 'index.json', bytes: fs.statSync(INDEX_FILE).size, sha256: indexSha },
  windows: windowRows,
  symbols: symbols,
  files: files,
  counts: counts,
};
// sig：v1 无服务端密钥，这里只做内容指纹（客户端不验签，见设计稿 §2.1/§6）
body.sig = sha256Text(JSON.stringify(body));

const outFile = path.join(OUT_DIR, 'manifest.json');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(body) + '\n', 'utf8');

console.log('SNAPSHOT_MANIFEST_OK ' + outFile);
console.log('version=' + version + ' cutoffDay=' + cutoffDay + ' generatedAt=' + generatedAt);
console.log('windows=' + windowRows.map((w) => w.id).join(',') + ' files=' + counts.files
  + ' symbols=' + counts.symbols + ' bytes=' + counts.bytes + ' indexBytes=' + body.index.bytes);
if (warnings.length) {
  console.warn('WARN ' + warnings.length + ' 条：');
  warnings.forEach((w) => console.warn('  - ' + w));
}
