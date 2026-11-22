// 按年拆包原型：把「票」分片改成「票 × 年」分片，复用 panji.klines.v1 / panji.builtin.index.v1 形态。
// 输入是已有的日线分片目录（每票一片、含多年），不是 CSV；输出每票每年一片。
// 用法：node tools/build_daily_packs_by_year.js --src <日线分片目录> --out <输出目录>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SRC = argVal('--src', 'build/daily_packs_20261107/d3y/pack');
const OUT = argVal('--out', 'build/daily_packs_by_year_20261107');
const gz9 = buf => zlib.gzipSync(buf, { level: 9 });

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.json.gz')).sort();
const t0 = Date.now();
const indexSymbols = new Map();
const sizes = [];
const yearSizes = {};
const yearRange = {};
const pending = [];

for (const fn of files) {
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(SRC, fn)));
  const o = JSON.parse(raw.toString('utf8'));
  const byYear = new Map();
  for (const b of o.bars) {
    const y = b.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(b);
  }
  if (!indexSymbols.has(o.symbol)) {
    indexSymbols.set(o.symbol, { code: o.symbol, name: o.name, bars: {}, bytes: {}, days: {}, first: o.first, last: o.last });
  }
  const ix = indexSymbols.get(o.symbol);
  for (const [y, bars] of byYear) {
    const first = bars[0].slice(0, 8), last = bars[bars.length - 1].slice(0, 8);
    const pack = {
      schema: 'panji.klines.v1', symbol: o.symbol, name: o.name, window: y,
      first, last, days: bars.length, timeframe: '1d', barMinutes: 0, bars,
    };
    const gz = gz9(Buffer.from(JSON.stringify(pack)));
    pending.push({ file: path.join(OUT, 'pack', o.symbol + '.' + y + '.json.gz'), gz });
    sizes.push(gz.length);
    (yearSizes[y] || (yearSizes[y] = [])).push(gz.length);
    const r = yearRange[y] || (yearRange[y] = { first: '99999999', last: '00000000' });
    if (first < r.first) r.first = first;
    if (last > r.last) r.last = last;
    ix.bars[y] = bars.length; ix.bytes[y] = gz.length; ix.days[y] = bars.length;
  }
}

fs.mkdirSync(path.join(OUT, 'pack'), { recursive: true });
for (const p of pending) fs.writeFileSync(p.file, p.gz);

const years = Object.keys(yearSizes).sort();
const symbolsOut = [...indexSymbols.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
const indexWindows = years.map(y => ({
  id: y, first: yearRange[y].first, last: yearRange[y].last,
  label: yearRange[y].first + '~' + yearRange[y].last,
}));
const body = {
  schema: 'panji.builtin.index.v1', version: '', generatedAt: new Date().toISOString().slice(0, 10),
  windows: indexWindows, symbols: symbolsOut, excluded: [],
};
body.version = 'dy' + crypto.createHash('sha1')
  .update(JSON.stringify(symbolsOut) + JSON.stringify(indexWindows)).digest('hex').slice(0, 8);
const indexJson = JSON.stringify(body);
fs.writeFileSync(path.join(OUT, 'index.json'), indexJson);

const slim = {
  schema: body.schema, version: body.version, generatedAt: body.generatedAt,
  windows: body.windows,
  symbols: symbolsOut.map(s => ({ code: s.code, name: s.name, first: s.first, last: s.last, bars: s.bars })),
  excluded: [],
};
const slimBytes = Buffer.byteLength(JSON.stringify(slim));

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const perYear = {};
for (const y of years) {
  perYear[y] = {
    shards: yearSizes[y].length,
    bytes: yearSizes[y].reduce((a, b) => a + b, 0),
    min: q(yearSizes[y], 0), med: q(yearSizes[y], .5), p95: q(yearSizes[y], .95), max: q(yearSizes[y], 1),
    first: yearRange[y].first, last: yearRange[y].last,
  };
}
const report = {
  mode: 'by-year', src: SRC, years,
  symbols: symbolsOut.length, shards: sizes.length, totalBytes: sizes.reduce((a, b) => a + b, 0),
  indexBytes: Buffer.byteLength(indexJson), slimIndexBytes: slimBytes,
  shard: { min: q(sizes, 0), med: q(sizes, .5), p95: q(sizes, .95), max: q(sizes, 1) },
  perYear,
  elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
};
fs.writeFileSync(path.join(OUT, 'build_report.json'), JSON.stringify(report, null, 1));
console.log('\n[by-year] years=' + years.join(',') + ' symbols=' + report.symbols + ' shards=' + report.shards +
  ' total=' + (report.totalBytes / 1048576).toFixed(2) + 'MB' +
  ' index=' + report.indexBytes + 'B slim=' + slimBytes + 'B ' + report.elapsedSec + 's');
for (const y of years) {
  const p = perYear[y];
  console.log('  ' + y + ' shards=' + p.shards + ' ' + (p.bytes / 1048576).toFixed(2) + 'MB min/med/p95/max=' +
    Math.round(p.min / 1024) + '/' + Math.round(p.med / 1024) + '/' + Math.round(p.p95 / 1024) + '/' + Math.round(p.max / 1024) + 'KB');
}
