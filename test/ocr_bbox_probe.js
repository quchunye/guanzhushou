// ocr_bbox_probe.js —— 批次 D 任务 18 的前置探针（最小验证，不做功能）
// 目的：用真实 TextIn 接口跑一次样例图，打印响应结构，判断 lines 是否带坐标（bbox/pos/polygon）。
// 结论只有两种：HAS_BBOX（可做原图定位）/ NO_BBOX（降级"打开原图"，功能标 partial）。
// 运行：node test/ocr_bbox_probe.js（没配密钥时输出 SKIP，不伪造结论）
'use strict';
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '..', 'server', '.env');
  if (!fs.existsSync(p)) return out;
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
  return out;
}

const COORD_RE = /^(pos|position|bbox|box|polygon|points|rect|location|coordinates|angle|x|y|w|h|width|height|left|top)$/i;

function scanCoords(node, depth, trail) {
  if (!node || depth > 4 || typeof node !== 'object') return [];
  const found = [];
  if (Array.isArray(node)) {
    if (node.length >= 4 && node.every(v => typeof v === 'number')) found.push(trail + '[]');
    node.slice(0, 3).forEach((v, i) => found.push(...scanCoords(v, depth + 1, trail + '[' + i + ']')));
    return found;
  }
  Object.keys(node).forEach((k) => {
    if (COORD_RE.test(k) && (typeof node[k] === 'number' || Array.isArray(node[k]) || typeof node[k] === 'object')) {
      found.push(trail + (trail ? '.' : '') + k);
    }
    found.push(...scanCoords(node[k], depth + 1, trail + (trail ? '.' : '') + k));
  });
  return found;
}

(async function main() {
  const cfg = loadEnv();
  const id = cfg.TEXTIN_APP_ID, secret = cfg.TEXTIN_SECRET_CODE;
  if (!id || !secret) {
    console.log('SKIP 未配置 TEXTIN_APP_ID / TEXTIN_SECRET_CODE，无法探针（不伪造结论）');
    process.exit(0);
  }
  const img = path.join(__dirname, '..', 'public', 'sample', 'demo_jiaogedan.jpg');
  const buf = fs.readFileSync(img);
  console.log(`[probe] 图片 ${path.relative(path.join(__dirname, '..'), img)} · ${Math.round(buf.length / 1024)}KB`);
  const res = await fetch('https://api.textin.com/ai/service/v2/recognize/document', {
    method: 'POST',
    headers: { 'x-ti-app-id': id, 'x-ti-secret-code': secret, 'content-type': 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 200) {
    console.log(`FAIL HTTP ${res.status} code=${json && json.code} ${(json && json.message) || ''}`);
    process.exit(1);
  }
  const result = json.result || json.data || {};
  const lines = Array.isArray(result.lines) ? result.lines : [];
  console.log('[probe] result 顶层字段:', Object.keys(result).join(', ') || '(空)');
  console.log(`[probe] 坐标系: ${result.width}x${result.height}px`);
  console.log(`[probe] lines 数量: ${lines.length}`);
  if (lines.length) {
    console.log('[probe] line[0] 字段:', Object.keys(lines[0]).join(', '));
    console.log('[probe] line[0] 原样:', JSON.stringify(lines[0]).slice(0, 300));
  }
  const hits = [...new Set(scanCoords(result, 0, ''))].filter(h => !/^pages\[\d+\]\.text$/.test(h));
  const hasBBox = hits.some(h => /pos|bbox|box|polygon|point|rect|location/i.test(h));
  console.log('[probe] 坐标类字段命中:', hits.slice(0, 12).join(', ') || '(无)');

  // 用 ocr.js 的 collectBoxes 跑同一份响应：有坐标时 boxes 必须非空（验收 18 的落地点）
  const { collectBoxes } = require('../server/ocr');
  const boxes = collectBoxes(result);
  console.log(`[probe] ocr.js collectBoxes: ${boxes ? boxes.items.length + ' 个框' : 'null'}`);
  if (hasBBox) {
    if (!boxes || !boxes.items.length) { console.log('FAIL 响应有坐标但 collectBoxes 没产出'); process.exit(1); }
    const b = boxes.items[0];
    console.log(`[probe] 首个框: text="${b.text.slice(0, 20)}" n=[${b.nx},${b.ny},${b.nw},${b.nh}]`);
    console.log('[probe] 结论: HAS_BBOX — 实现 boxes 返回 + 前端原图高亮');
  } else {
    console.log('[probe] 结论: NO_BBOX — 降级「打开原图」，18 标 partial，不伪造坐标');
  }
  process.exit(0);
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
