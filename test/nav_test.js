'use strict';
// nav_test.js —— 站点入口与占位页断言（只读 HTML，不依赖服务器路由）
// 本仓只分发「判定与记录」能力：内容库（图鉴/科普动画/clips）不在仓内，相关页面必须是诚实占位页。
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}

const PUB = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');
const idx = read('index.html');
const learn = read('learn.html');
const collection = read('collection.html');

console.log('[1] 核心页面在位');
['index.html', 'discipline.html', 'replay_readonly.html', 'records.html', 'archive.html', 'guide.html',
  'price.html', 'replay.html', 'share.html', 'migrate.html', 'features.html']
  .forEach((h) => ok(fs.existsSync(path.join(PUB, h)), 'public/' + h + ' 存在'));

console.log('[2] index.html 七个容器入口');
ok(idx.indexOf('id="btn-upload"') >= 0, '上传按钮仍在');
ok(idx.indexOf('确认并选择图片') >= 0 && idx.indexOf('for="file-input"') >= 0, '「确认并选择图片」仍绑定 file-input');
const navStart = idx.indexOf('<nav class="site-nav"');
const navEnd = idx.indexOf('</nav>', navStart);
const nav = idx.slice(navStart, navEnd);
ok(navStart > 0 && idx.slice(navStart).indexOf('</section>') > 0, '入口位于首页区块内');
const navLinks = (nav.match(/<a href="/g) || []).length;
ok(navLinks === 7, '导航有 7 个容器入口', String(navLinks));
['discipline.html', 'replay_readonly.html', 'records.html', 'archive.html', 'guide.html', 'price.html']
  .forEach((h) => { ok(nav.indexOf(`href="${h}"`) >= 0, `首页 → ${h}`); });
ok(idx.indexOf('id="home-ext"') > 0 && idx.indexOf('<nav class="site-nav"') > idx.indexOf('id="home-ext"'),
  '入口在 home-ext 之后、foot 之前（不改布局骨架）');
ok(idx.indexOf('id="btn-demo"') >= 0 && idx.indexOf('id="btn-rules"') >= 0, '既有主按钮 / 规则入口未动');

console.log('[3] 内容库页面为诚实占位（不含 clips 资源引用）');
ok(collection.indexOf('clips/') < 0, 'collection.html 不引用 clips/');
ok(collection.indexOf('不在本仓') >= 0, 'collection.html 写明内容库不在本仓');
ok(learn.indexOf('PAGE_BASE = "clips/"') < 0, 'learn.html 不再挂 clips/ 动画数据');
ok(learn.indexOf('不在本仓') >= 0, 'learn.html 写明内容库不在本仓');
ok(!fs.existsSync(path.join(PUB, 'clips')), 'public/clips 未随仓分发');
ok(!fs.existsSync(path.join(PUB, 'clips_index.json')), 'public/clips_index.json 未随仓分发');

console.log('[4] 对外文案：作者实数 0 命中');
const AUTHOR_REAL = /1766|925|31\.14|1\.22|5 小时 14|52 次|47 次|18 颗|36 个|17 笔|13 只/;
ok(!AUTHOR_REAL.test(learn), 'learn.html 作者实数 0 命中');
ok(!AUTHOR_REAL.test(idx), 'index.html 作者实数 0 命中');
ok(!AUTHOR_REAL.test(collection), 'collection.html 作者实数 0 命中');

console.log(fail ? `\n===== nav_test 失败 ${fail} 项（通过 ${pass}）=====` : `\n===== nav_test 全部通过：${pass} 项 =====`);
process.exit(fail ? 1 : 0);
