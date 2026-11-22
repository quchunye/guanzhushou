// test/run_all.js —— 依次运行 test/ 下的全部用例，汇总通过/失败
// 用法：node test/run_all.js  （或 npm test）
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.js') && f !== 'run_all.js')
  .sort();

let ok = 0;
const failed = [];

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  if (r.status === 0) {
    ok++;
    console.log('PASS ' + f);
  } else {
    failed.push(f);
    console.log('FAIL ' + f);
    const out = (r.stdout || '') + (r.stderr || '');
    console.log(out.split('\n').filter((l) => /FAIL|Error|错误|throw/.test(l)).slice(0, 4).join('\n'));
  }
}

console.log('\n合计 ' + files.length + ' 个文件：通过 ' + ok + '，失败 ' + failed.length);
if (failed.length) {
  console.log('失败清单：' + failed.join(', '));
  process.exitCode = 1;
}
