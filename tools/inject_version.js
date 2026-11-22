#!/usr/bin/env node
/* 构建期版本常量注入（设计稿 §6 已裁定：不加依赖、不引构建工具链）
 *
 * 读 android/app/build.gradle 的 versionName / versionCode，生成
 * public/version.js：
 *     window.__PANJI_VERSION__ = {"versionName":"1.0.0","versionCode":1};
 *
 * 用法：
 *   node tools/inject_version.js                     # 写 public/version.js
 *   node tools/inject_version.js --out some/dir/x.js
 *   node tools/inject_version.js --check             # 只校验，内容不一致 exit 1
 *
 * 输出不含时间戳：同一 gradle 版本重复执行，产物字节一致。
 * 注：接入 android_build/build_web.js 属于另一条改动线，本脚本只负责「可被调用」。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CHECK = argv.indexOf('--check') >= 0;

const GRADLE = path.resolve(argVal('--gradle', path.join(ROOT, 'android', 'app', 'build.gradle')));
const OUT = path.resolve(argVal('--out', path.join(ROOT, 'public', 'version.js')));

function fail(msg) { console.error('VERSION_INJECT_FAIL ' + msg); process.exit(1); }

if (!fs.existsSync(GRADLE)) fail('build.gradle 不存在: ' + GRADLE);
const src = fs.readFileSync(GRADLE, 'utf8');

let versionName = '';
let versionCode = '';
for (const line of src.split(/\r?\n/)) {
  const s = line.replace(/\/\/.*$/, '').trim();
  if (!versionName) {
    const m = s.match(/^versionName\s+"([^"]+)"/);
    if (m) versionName = m[1];
  }
  if (!versionCode) {
    const m = s.match(/^versionCode\s+(\d+)/);
    if (m) versionCode = m[1];
  }
}
if (!versionName) fail('build.gradle 里没找到 versionName');
if (!versionCode) fail('build.gradle 里没找到 versionCode');

const content = [
  '/* 构建期版本常量：由 tools/inject_version.js 从 android/app/build.gradle 生成，勿手改。 */',
  'window.__PANJI_VERSION__ = ' + JSON.stringify({ versionName: versionName, versionCode: +versionCode }) + ';',
  '',
].join('\n');

if (CHECK) {
  if (!fs.existsSync(OUT)) fail('产物不存在: ' + OUT);
  const cur = fs.readFileSync(OUT, 'utf8');
  if (cur !== content) fail('产物与 build.gradle 不一致: ' + OUT);
  console.log('VERSION_INJECT_OK (check) name=' + versionName + ' code=' + versionCode + ' out=' + OUT);
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, content, 'utf8');
console.log('VERSION_INJECT_OK name=' + versionName + ' code=' + versionCode + ' out=' + OUT);
