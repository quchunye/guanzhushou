// 用户自带行情导入 —— Node 单测（全部样本为构造数据，代码虚构 KX0001）
// 运行：node test/kline_import_test.js
'use strict';

const assert = require('assert');
const K = require('../public/features/kline_import.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; fails.push(name + ' :: ' + e.message); console.log('FAIL ' + name + ' :: ' + e.message); }
}

function u32(b, v, o) { b.writeUInt32LE(v >>> 0, o); }
function f32(b, v, o) { b.writeFloatLE(v, o); }
function dayRec(date, o, h, l, c, v, a) {
  const b = Buffer.alloc(32);
  u32(b, date, 0);
  u32(b, Math.round(o * 100), 4); u32(b, Math.round(h * 100), 8);
  u32(b, Math.round(l * 100), 12); u32(b, Math.round(c * 100), 16);
  f32(b, a == null ? v * 10 : a, 20); u32(b, v, 24);
  return b;
}
function lcRec(y, mo, d, hh, mm, o, h, l, c, v, a) {
  const b = Buffer.alloc(32);
  const n = (y - 2004) * 2048 + mo * 100 + d;
  b.writeUInt16LE(n, 0); b.writeUInt16LE(hh * 60 + mm, 2);
  f32(b, o, 4); f32(b, h, 8); f32(b, l, 12); f32(b, c, 16);
  f32(b, a == null ? v * 10 : a, 20); u32(b, v, 24);
  return b;
}
const B5 = (hm) => '20260104' + hm;
function bars5() {
  return [
    ['0935', 10.00, 10.40, 9.90, 10.20, 1000],
    ['0940', 10.20, 10.60, 10.10, 10.50, 1200],
    ['0945', 10.40, 10.80, 10.30, 10.70, 900],
    ['0950', 10.60, 11.00, 10.50, 10.90, 1500],
    ['0955', 10.90, 11.20, 10.80, 11.00, 1100],
  ];
}
function bars1() {
  return [
    ['0931', 10.00, 10.10, 9.95, 10.05, 200],
    ['0932', 10.05, 10.15, 10.00, 10.10, 180],
    ['0933', 10.10, 10.20, 10.05, 10.15, 220],
    ['0934', 10.15, 10.25, 10.10, 10.20, 240],
    ['0935', 10.20, 10.30, 10.15, 10.25, 260],
  ];
}

// ---------- 构造样本 ----------
const FIX = {};

FIX['KX0001.day'] = Buffer.concat([
  dayRec(20260104, 10.00, 10.40, 9.90, 10.20, 1000),
  dayRec(20260105, 10.20, 10.70, 10.10, 10.60, 1200),
  dayRec(20260106, 10.60, 10.90, 10.40, 10.50, 900),
]);
FIX['KX0001.lc5'] = Buffer.concat(bars5().map((r) =>
  lcRec(2026, 1, 4, +r[0].slice(0, 2), +r[0].slice(2, 4), r[1], r[2], r[3], r[4], r[5])));
FIX['KX0001.lc1'] = Buffer.concat(bars1().map((r) =>
  lcRec(2026, 1, 4, +r[0].slice(0, 2), +r[0].slice(2, 4), r[1], r[2], r[3], r[4], r[5])));
FIX['KX0001_5m.csv'] = '证券代码: KX0001\n周期: 5分钟\n复权: 不复权\n'
  + '日期,时间,开盘,最高,最低,收盘,成交量,成交额\n'
  + bars5().map((r) => '2026-01-04,' + r[0].slice(0, 2) + ':' + r[0].slice(2) + ','
    + r[1] + ',' + r[2] + ',' + r[3] + ',' + r[4] + ',' + r[5] + ',' + (r[5] * r[4])).join('\n');
FIX['KX0001_1m.csv'] = 'Date,Time,Open,High,Low,Close,Volume\n'
  + bars1().map((r) => '2026-01-04,' + r[0].slice(0, 2) + ':' + r[0].slice(2) + ','
    + r[1] + ',' + r[2] + ',' + r[3] + ',' + r[4] + ',' + r[5]).join('\n');
FIX['KX0001_day.csv'] = '代码,日期,开盘,最高,最低,收盘,成交量\n'
  + 'KX0001,2026-01-04,10.00,10.40,9.90,10.20,1000\n'
  + 'KX0001,2026-01-05,10.20,10.70,10.10,10.60,1200\n'
  + 'KX0001,2026-01-06,10.60,10.90,10.40,10.50,900\n';
FIX['KX0001_headerless.csv'] = bars5().map((r) => B5(r[0]) + ',' + r[1] + ',' + r[2] + ',' + r[3] + ',' + r[4] + ',' + r[5]).join('\n');
FIX['KX0001_utc.csv'] = '日期时间,开盘,最高,最低,收盘,成交量\n'
  + '2026-01-04T01:31:00Z,10,10.1,9.95,10.05,200\n'
  + '2026-01-04T01:32:00Z,10.05,10.15,10,10.1,180\n';

// GBK：日期/开盘/最高/最低/收盘/成交量
const gbkHeader = Buffer.concat([
  Buffer.from([0xC8, 0xD5, 0xC6, 0xDA]), Buffer.from(','),
  Buffer.from([0xBF, 0xAA, 0xC5, 0xCC]), Buffer.from(','),
  Buffer.from([0xD7, 0xEE, 0xB8, 0xDF]), Buffer.from(','),
  Buffer.from([0xD7, 0xEE, 0xB5, 0xCD]), Buffer.from(','),
  Buffer.from([0xCA, 0xD5, 0xC5, 0xCC]), Buffer.from(','),
  Buffer.from([0xB3, 0xC9, 0xBD, 0xBB, 0xC1, 0xBF]), Buffer.from('\n'),
]);
FIX['KX0001_gbk.csv'] = Buffer.concat([
  gbkHeader,
  Buffer.from(bars5().map((r) => '2026-01-04 ' + r[0].slice(0, 2) + ':' + r[0].slice(2) + ','
    + r[1] + ',' + r[2] + ',' + r[3] + ',' + r[4] + ',' + r[5]).join('\n') + '\n'),
]);

// ---------- 解析：成功样本 ----------
const validNames = ['KX0001.day', 'KX0001.lc5', 'KX0001.lc1', 'KX0001_5m.csv',
  'KX0001_1m.csv', 'KX0001_day.csv', 'KX0001_headerless.csv', 'KX0001_gbk.csv'];
let validOk = 0;
validNames.forEach(function (name) {
  const r = K.parseFile(name, FIX[name]);
  if (r.ok) validOk++;
  ok('解析成功 ' + name + ' → ' + (r.ok ? [r.item.timeframe, r.item.barsCount, r.item.code].join('/') : r.code + ':' + r.message), function () {
    assert.strictEqual(r.ok, true, r.code + ' ' + r.message);
    assert.strictEqual(r.item.barsCount, name === 'KX0001.day' || name === 'KX0001_day.csv' ? 3 : 5);
    assert.strictEqual(K.normCode(r.item.code), 'kx0001');
    assert.deepStrictEqual(r.item.bars[0][0].slice(0, 8), '20260104');
    assert.strictEqual(r.item.bars[0][0].length, 12);
  });
});

ok('通达信 .day 价格按 *0.01 解码（10.00 / 10.40 / 9.90）', function () {
  const r = K.parseFile('KX0001.day', FIX['KX0001.day']);
  assert.deepStrictEqual([r.item.bars[0][1], r.item.bars[0][2], r.item.bars[0][3], r.item.bars[0][4]], [10, 10.4, 9.9, 10.2]);
  assert.strictEqual(r.item.adjust, 'none');
  assert.ok(/UTC\+8/.test(r.warnings[0]));
});
ok('通达信 .lc5 日期编码 (2026,1,4) + 分钟数 575 → 09:35', function () {
  const r = K.parseFile('KX0001.lc5', FIX['KX0001.lc5']);
  assert.strictEqual(r.item.bars[0][0], '202601040935');
  assert.strictEqual(r.item.timeframe, '5m');
});
ok('通达信 .lc1 周期识别为 1m', function () {
  const r = K.parseFile('KX0001.lc1', FIX['KX0001.lc1']);
  assert.strictEqual(r.item.timeframe, '1m');
  assert.strictEqual(r.item.bars[0][0], '202601040931');
});
ok('CSV 中文表头 + 元信息（代码/复权/周期）', function () {
  const r = K.parseFile('KX0001_5m.csv', FIX['KX0001_5m.csv']);
  assert.strictEqual(r.item.code, 'KX0001');
  assert.strictEqual(r.item.timeframe, '5m');
  assert.strictEqual(r.item.adjust, 'none');
});
ok('CSV 英文表头 + 1 分钟周期推断', function () {
  const r = K.parseFile('KX0001_1m.csv', FIX['KX0001_1m.csv']);
  assert.strictEqual(r.item.timeframe, '1m');
});
ok('CSV 无时间列 → 日线', function () {
  const r = K.parseFile('KX0001_day.csv', FIX['KX0001_day.csv']);
  assert.strictEqual(r.item.timeframe, 'day');
  assert.strictEqual(r.item.bars[0][0], '202601040000');
});
ok('无表头兜底（时间/开/高/低/收/量）', function () {
  const r = K.parseFile('KX0001_headerless.csv', FIX['KX0001_headerless.csv']);
  assert.strictEqual(r.item.barsCount, 5);
  assert.ok(r.warnings.some((w) => /无表头/.test(w)));
});
ok('GBK 中文表头自动识别', function () {
  const d = K._internal.decodeText(FIX['KX0001_gbk.csv']);
  assert.ok(/^日期/.test(d.text), 'decoded: ' + d.text.slice(0, 20));
  assert.strictEqual(d.encoding, 'gb18030');
  const r = K.parseFile('KX0001_gbk.csv', FIX['KX0001_gbk.csv']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.item.barsCount, 5);
});
ok('UTC 时间换算到 Asia/Shanghai (01:31Z → 09:31)', function () {
  const r = K.parseFile('KX0001_utc.csv', FIX['KX0001_utc.csv']);
  assert.strictEqual(r.item.bars[0][0], '202601040931');
  assert.strictEqual(r.item.tz, 'converted-utc');
});

// ---------- 解析：错误样本（必须各自命中不同文案） ----------
const bad = {};
bad['KX0001.xls'] = 'dummy';
bad['KX0001_missing.csv'] = '日期,开盘,最高,最低,成交量\n2026-01-04 09:35,10,10.1,9.9,1000\n';
bad['KX0001_reverse.csv'] = '日期时间,开盘,最高,最低,收盘\n2026-01-04 09:40,10,10.1,9.9,10.05\n2026-01-04 09:35,10,10.1,9.9,10.05\n';
bad['KX0001_badsize.day'] = Buffer.alloc(33);
bad['KX0001_ohlc.csv'] = '日期时间,开盘,最高,最低,收盘\n2026-01-04 09:35,10,10.05,9.9,10.2\n';
bad['KX0001_empty.csv'] = '日期时间,开盘,最高,最低,收盘\n';
bad['KX0001_dup.csv'] = '日期时间,开盘,最高,最低,收盘\n2026-01-04 09:35,10,10.1,9.9,10\n2026-01-04 09:35,10.1,10.2,10,10.1\n';

const expectCode = {
  'KX0001.xls': 'NEED_CSV',
  'KX0001_missing.csv': 'MISSING_FIELD',
  'KX0001_reverse.csv': 'TIME_ORDER',
  'KX0001_badsize.day': 'BINARY_LEN',
  'KX0001_ohlc.csv': 'OHLC',
  'KX0001_empty.csv': 'EMPTY',
  'KX0001_dup.csv': 'DUP_TIME',
};
let badHit = 0;
Object.keys(bad).forEach(function (name) {
  const r = K.parseFile(name, bad[name]);
  if (!r.ok && r.code === expectCode[name]) badHit++;
  ok('错误命中 ' + name + ' → ' + (r.ok ? 'OK(意外成功)' : r.code), function () {
    assert.strictEqual(r.ok, false, '应当失败');
    assert.strictEqual(r.code, expectCode[name]);
    assert.ok(r.message && r.message.length >= 12, '错误文案过短');
  });
});

// ---------- 像素映射 / 成交落点 ----------
const csv5 = K.parseFile('KX0001_5m.csv', FIX['KX0001_5m.csv']).item;
const model = K.chartModel(csv5.bars, 358, 240, {});
const trades = [
  { code: 'KX0001', date: '2026-01-04', time: '09:47:00', side: '买入', qty: 100, price: 10.55 },
  { code: 'KX0001', date: '2026-01-04', time: '09:52:00', side: '卖出', qty: 100, price: 10.95 },
];
const al = K.alignTrades(csv5, trades, model);

ok('像素公式：358×240，padL=46，5 根，step=60.8', function () {
  assert.strictEqual(model.pad.l, 46);
  assert.strictEqual(model.step, 60.8);
  assert.strictEqual(model.xOfIndex(2), 198);
});
ok('成交 09:47 @10.55 → x=222.3, y=116.0（可复算）', function () {
  assert.strictEqual(al.points.length, 2);
  const p = al.points[0];
  assert.strictEqual(p.barIndex, 3);
  assert.strictEqual(p.barTime, '202601040950');
  assert.ok(Math.abs(p.x - 222.32) < 0.01, 'x=' + p.x);
  assert.ok(Math.abs(p.y - 116) < 0.01, 'y=' + p.y);
  assert.strictEqual(p.inside, true);
  console.log('   [落点] 09:47/10.55 → x=' + p.x.toFixed(2) + ' y=' + p.y.toFixed(2)
    + '；模型 min=' + model.min.toFixed(3) + ' max=' + model.max.toFixed(3)
    + ' step=' + model.step.toFixed(2) + ' innerH=' + model.innerH);
});
ok('成交 09:52 @10.95 → x=283.1, y=54.5（第二段插值）', function () {
  const p = al.points[1];
  assert.strictEqual(p.barIndex, 4);
  assert.ok(Math.abs(p.x - 283.12) < 0.01, 'x=' + p.x);
  assert.ok(Math.abs(p.y - 54.46) < 0.02, 'y=' + p.y);
});
ok('成交价远离 K 线区间 → 复权口径警告 ADJUST', function () {
  const far = K.alignTrades(csv5, [{ code: 'KX0001', date: '2026-01-04', time: '09:47', price: 12.5 }], model);
  assert.strictEqual(far.warning.code, 'ADJUST');
  assert.strictEqual(far.points[0].inside, false);
  assert.ok(/复权/.test(far.warning.message));
});
ok('成交不在导入日期范围 → OUT_OF_RANGE', function () {
  const out = K.alignTrades(csv5, [{ code: 'KX0001', date: '2026-01-09', time: '09:47', price: 10.55 }], model);
  assert.strictEqual(out.rejects[0].code, 'OUT_OF_RANGE');
});
ok('日线成交按日期对齐，x 取该日 K 线中心', function () {
  const d = K.parseFile('KX0001.day', FIX['KX0001.day']).item;
  const dm = K.chartModel(d.bars, 358, 240, {});
  const da = K.alignTrades(d, [{ code: 'KX0001', date: '2026-01-05', time: '09:47', price: 10.45 }], dm);
  assert.strictEqual(da.points[0].barIndex, 1);
  assert.strictEqual(da.points[0].barTime, '202601050000');
  assert.strictEqual(da.points[0].x, dm.xOfIndex(1));
});

// ---------- 本机存储 ----------
function memStore() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}
const fake = memStore();
K.setStorage(fake);
ok('导入结果只写入本机存储，可列出/删除', function () {
  const r = K.parseFile('KX0001_5m.csv', FIX['KX0001_5m.csv']);
  const s = K.saveItem(r.item);
  assert.strictEqual(s.ok, true);
  const items = K.listItems();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(K.findItem(r.item.id).barsCount, 5);
  assert.strictEqual(K.removeItem(r.item.id).ok, true);
  assert.strictEqual(K.listItems().length, 0);
  assert.ok(fake.getItem(K.KEY));
});
ok('存储超限 → QUOTA 明确报错（不静默）', function () {
  K.setStorage({
    getItem: () => null,
    setItem: () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; },
    removeItem: () => {},
  });
  const r = K.parseFile('KX0001_5m.csv', FIX['KX0001_5m.csv']);
  const s = K.saveItem(r.item);
  assert.strictEqual(s.code, 'QUOTA');
});
K.setStorage(null);

// ---------- 汇总 ----------
const total = pass + fail;
console.log('\n================ 汇总 ================');
console.log('成功样本解析：' + validOk + '/' + validNames.length + ' = ' + Math.round(validOk / validNames.length * 100) + '%');
console.log('错误样本命中：' + badHit + '/' + Object.keys(bad).length + ' = ' + Math.round(badHit / Object.keys(bad).length * 100) + '%');
console.log('用例：通过 ' + pass + ' / 失败 ' + fail + ' / 共 ' + total);
console.log('样本文件：' + (validNames.length + Object.keys(bad).length) + ' 份（有效 ' + validNames.length + '，错误 ' + Object.keys(bad).length + '）');
if (fail) { console.log(fails.join('\n')); process.exit(1); }
