// 卡片 SVG 双端渲染检查：
//   - 手机 390 宽 / 桌面 1280 宽各渲染一次
//   - 0 溢出（文本 bbox 超出 640×360，或页面横向滚动）
//   - 0 文本互相压字
//   - 0 报错（pageerror / console.error / SVG 解析失败）
// 用法：node tools/card_svg_check.js
// 输出：docs/卡片样例/screens/*.png + docs/卡片样例/check.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = path.join(__dirname, '..', 'docs', '卡片样例');
const SHOTS = path.join(DIR, 'screens');
fs.mkdirSync(SHOTS, { recursive: true });

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.svg')).sort();

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function launch() {
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    return await chromium.launch({ headless: true, executablePath: EDGE });
  }
}

function html(svg, width) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;background:#111;overflow-x:hidden}' +
    '#wrap{width:' + width + 'px;max-width:100%;margin:0 auto}' +
    'svg{width:100%;height:auto;display:block}</style></head>' +
    '<body><div id="wrap">' + svg + '</div></body></html>';
}

(async () => {
  const browser = await launch();
  const report = { files: [], ok: true };

  for (const f of files) {
    const svg = fs.readFileSync(path.join(DIR, f), 'utf8');
    const item = { file: f, viewports: [] };

    for (const vp of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 800 }]) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

      await page.setContent(html(svg, Math.min(vp.width, 640)), { waitUntil: 'load' });
      const result = await page.evaluate((svgText) => {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const parseError = !!doc.querySelector('parsererror');
        const nodes = Array.from(document.querySelectorAll('svg text'));
        const boxes = nodes.map((n) => {
          const b = n.getBBox();
          return { t: n.textContent, x: b.x, y: b.y, w: b.width, h: b.height };
        });
        const out = [];
        for (const b of boxes) {
          if (b.x < -0.01 || b.y < -0.01 || b.x + b.w > 640.01 || b.y + b.h > 360.01) out.push(b);
        }
        const overlaps = [];
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ix > 0.5 && iy > 0.5) overlaps.push([a.t, b.t, Math.round(ix), Math.round(iy)]);
          }
        }
        return {
          parseError,
          textCount: nodes.length,
          boxes,
          out,
          overlaps,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          svgRect: (() => { const r = document.querySelector('svg').getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
        };
      }, svg);

      result.errors = errors;
      const pass = !result.parseError && result.errors.length === 0 && result.out.length === 0 &&
        result.overlaps.length === 0 && result.scrollW <= result.innerW + 1;
      item.viewports.push({
        name: vp.name, pass,
        textCount: result.textCount, overflow: result.out,
        overlaps: result.overlaps, errors: result.errors,
        scrollW: result.scrollW, innerW: result.innerW, svgRender: result.svgRect,
      });
      if (!pass) report.ok = false;

      await page.screenshot({ path: path.join(SHOTS, vp.name + '_' + f.replace(/\.svg$/, '.png')), fullPage: true });
      await page.close();
    }
    report.files.push(item);
  }

  await browser.close();
  fs.writeFileSync(path.join(DIR, 'check.json'), JSON.stringify(report, null, 2), 'utf8');

  for (const f of report.files) {
    const v = f.viewports.map((x) => x.name + ':' + (x.pass ? 'PASS' : 'FAIL')).join(' ');
    console.log(v + '  ' + f.file);
    f.viewports.filter((x) => !x.pass).forEach((x) => {
      console.log('   overflow=', JSON.stringify(x.overflow), 'overlaps=', JSON.stringify(x.overlaps), 'errors=', JSON.stringify(x.errors));
    });
  }
  console.log(report.ok ? 'ALL PASS' : 'HAS FAIL');
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
