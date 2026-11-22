// fixtures_guard_test.js —— 样本护栏：防止真实交割单/个人信息再次混进仓库
// 这条用例的价值在于「以后」：一次清扫会复发，护栏不会。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const fixDir = path.join(__dirname, 'fixtures', 'synthetic');
let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

check('synthetic 样本均带 synthetic: true', () => {
  const files = walk(fixDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'synthetic 目录为空');
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(j.synthetic, true, path.basename(f) + ' 缺少 synthetic: true');
  }
});

check('synthetic 样本不含手机号 / 身份证 / 银行卡形态', () => {
  const bad = [/(^|\D)1[3-9]\d{9}(\D|$)/, /(^|\D)\d{17}[\dXx](\D|$)/, /(^|\D)6[0-9]{15,18}(\D|$)/];
  for (const f of walk(fixDir).filter((x) => x.endsWith('.json'))) {
    const t = fs.readFileSync(f, 'utf8');
    for (const re of bad) {
      assert.ok(!re.test(t), path.basename(f) + ' 命中敏感数字形态：' + re);
    }
  }
});

check('test/ 下不出现图片样本（真实截图最常见的入口）', () => {
  const imgs = walk(__dirname).filter((f) => /\.(jpg|jpeg|png|webp|pdf)$/i.test(f));
  assert.deepStrictEqual(imgs.map((f) => path.relative(root, f)), []);
});

check('示例图带合成水印说明', () => {
  const sampleDir = path.join(root, 'public', 'sample');
  const imgs = fs.existsSync(sampleDir) ? fs.readdirSync(sampleDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)) : [];
  for (const f of imgs) {
    const note = path.join(sampleDir, path.basename(f, path.extname(f)) + '.note.txt');
    assert.ok(fs.existsSync(note), f + ' 缺少同名 .note.txt 说明（须写明合成来源）');
  }
});

check('公共目录不出现绝对路径形式的用户名', () => {
  const re = /C:[\\/]Users[\\/][^\s"'<>]+/i;
  const files = walk(path.join(root, 'public')).concat(walk(path.join(root, 'server'))).concat(walk(path.join(root, 'tools')))
    .filter((f) => /\.(js|html|css|json|md|py)$/i.test(f));
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!re.test(t), path.relative(root, f) + ' 含本机绝对路径');
  }
});

console.log('\n通过 ' + pass + '/5');
