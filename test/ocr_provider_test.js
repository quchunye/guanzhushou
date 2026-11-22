// ocr_provider_test.js —— OCR 多供应商层验收（node test/ocr_provider_test.js）
// 覆盖：图片尺寸、腾讯响应映射（通用/表格）、TC3 签名头、本地 OCR 映射、供应商优先级。
// 不调用真实腾讯/TextIn 接口，不消耗额度。
'use strict';
const fs = require('fs');
const path = require('path');
const O = require('../server/ocr');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

const sample = fs.readFileSync(path.join(__dirname, '..', 'public', 'sample', 'demo_jiaogedan.jpg'));
const size = O.imageSize(sample);
ok(!!size && size.w === 900 && size.h === 1200, 'JPEG 尺寸 900x1200（合成样本；实际 ' + JSON.stringify(size) + '）');
ok(O.fixMergedAnchor('卖2026101910:14:50') === '卖 20261019 10:14:50', '合并锚点拆成「卖 日期 时间」');
ok(O.fixMergedAnchor('卖 20261019 10:14:50') === '卖 20261019 10:14:50', '已拆好的锚点不被二次改动');
ok(O.fixMergedAnchor('卖2026101910：14：50') === '卖 20261019 10:14:50', '全角冒号归一');

// 腾讯通用印刷体：故意乱序，验证按行排序
const textResp = {
  Response: {
    TextDetections: [
      { DetectedText: '13.69', Polygon: [{ X: 500, Y: 200 }, { X: 620, Y: 200 }, { X: 620, Y: 230 }, { X: 500, Y: 230 }] },
      { DetectedText: '09:35:12', Polygon: [{ X: 100, Y: 260 }, { X: 260, Y: 260 }, { X: 260, Y: 290 }, { X: 100, Y: 290 }] },
      { DetectedText: '示例材料', Polygon: [{ X: 300, Y: 200 }, { X: 420, Y: 200 }, { X: 420, Y: 230 }, { X: 300, Y: 230 }] },
      { DetectedText: '09:34:55', Polygon: [{ X: 100, Y: 200 }, { X: 260, Y: 200 }, { X: 260, Y: 230 }, { X: 100, Y: 230 }] },
      { DetectedText: '买入', Polygon: [{ X: 200, Y: 200 }, { X: 280, Y: 200 }, { X: 280, Y: 230 }, { X: 200, Y: 230 }] },
    ],
  },
};
const mapped = O.mapTencent(textResp, sample);
ok(mapped.lines.length === 5, '通用响应映射 5 行');
ok(mapped.lines[0] === '09:34:55' && mapped.lines[1] === '买入' && mapped.lines[2] === '示例材料' && mapped.lines[3] === '13.69',
  '同一行按 X 排序：' + JSON.stringify(mapped.lines));
ok(mapped.lines[4] === '09:35:12', '第二行在最后');
ok(!!mapped.boxes && mapped.boxes.w === size.w && mapped.boxes.h === size.h, 'boxes 带原图尺寸');
const first = mapped.boxes.items[0];
ok(Math.abs(first.nx - 100 / size.w) < 1e-3 && Math.abs(first.ny - 200 / size.h) < 1e-3,
  '首个框归一化 nx/ny（' + first.nx + '/' + first.ny + '）');
ok(mapped.boxes.items.every(b => b.nw > 0 && b.nh > 0), '所有框都有 nw/nh');

// 腾讯表格 V3：Cells 路径
const tableResp = {
  Response: {
    TableDetections: [{
      Cells: [
        { Text: '10:20:00', Polygon: [{ X: 10, Y: 50 }, { X: 120, Y: 50 }, { X: 120, Y: 80 }, { X: 10, Y: 80 }] },
        { Text: '证券买入', Polygon: [{ X: 130, Y: 50 }, { X: 220, Y: 50 }, { X: 220, Y: 80 }, { X: 130, Y: 80 }] },
        { Text: '600000', Polygon: [{ X: 230, Y: 50 }, { X: 330, Y: 50 }, { X: 330, Y: 80 }, { X: 230, Y: 80 }] },
      ],
    }],
  },
};
const table = O.mapTencent(tableResp, sample);
ok(table.lines.length === 3 && table.lines[0] === '10:20:00' && table.lines[2] === '600000', '表格 Cells 映射并排序');
ok(!!table.boxes && table.boxes.items.length === 3, '表格 Cells 也产出 boxes');

// 百度 words_result：location left/top/width/height，乱序验证排序
const baiduResp = {
  words_result: [
    { words: '13.69', location: { left: 500, top: 200, width: 120, height: 30 } },
    { words: '09:35:12', location: { left: 100, top: 260, width: 160, height: 30 } },
    { words: '示例材料', location: { left: 300, top: 200, width: 120, height: 30 } },
    { words: '09:34:55', location: { left: 100, top: 200, width: 160, height: 30 } },
    { words: '买入', location: { left: 200, top: 200, width: 80, height: 30 } },
  ],
};
const baidu = O.mapBaidu(baiduResp, sample);
ok(baidu.lines.length === 5 && baidu.lines[0] === '09:34:55' && baidu.lines[4] === '09:35:12', '百度 words_result 按 top/left 排序');
ok(!!baidu.boxes && baidu.boxes.items.length === 5 && Math.abs(baidu.boxes.items[0].nx - 100 / size.w) < 1e-3, '百度 boxes 归一化');

// TC3 签名头
const auth = O.tencentAuth({
  secretId: 'AKIDTEST', secretKey: 'SECRETKEY', payload: '{"ImageBase64":"abc"}',
  timestamp: 1700000000, action: 'DescribeInstances',
});
ok(/^TC3-HMAC-SHA256 Credential=AKIDTEST\/2023-11-14\/ocr\/tc3_request/.test(auth.authorization), 'Authorization 头格式');
ok(/SignedHeaders=content-type;host/.test(auth.authorization), 'SignedHeaders 正确（与官方 SDK 一致）');
ok(/Signature=[0-9a-f]{64}$/.test(auth.authorization), '签名 64 位 hex');
ok(auth.payloadHash.length === 64 && auth.date === '2023-11-14', 'payload hash 与日期');

// 本地 OCR 客户端：stub fetch
const localFixture = {
  ok: true,
  lines: ['09:34:55', '证券买入', '600847'],
  boxes: { w: 1000, h: 2000, items: [
    { text: '09:34:55', x: 10, y: 20, w: 100, h: 20, nx: 0.01, ny: 0.01, nw: 0.1, nh: 0.01 },
    { text: '证券买入', x: 110, y: 20, w: 100, h: 20, nx: 0.11, ny: 0.01, nw: 0.1, nh: 0.01 },
    { text: '600847', x: 210, y: 20, w: 100, h: 20, nx: 0.21, ny: 0.01, nw: 0.1, nh: 0.01 },
  ] },
};
(async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ status: 200, json: async () => localFixture });
  const local = await O.localRecognize(Buffer.from('fake'), { LOCAL_OCR_URL: 'http://127.0.0.1:8010/ocr' });
  global.fetch = realFetch;
  ok(local.lines.length === 3 && local.lines[1] === '证券买入', '本地 OCR 返回 lines');
  ok(local.boxes && local.boxes.items.length === 3, '本地 OCR 返回 boxes');

  // 供应商优先级：local > baidu > tencent > textin > mock
  ok(O.resolveProvider({ LOCAL_OCR_URL: 'http://x', BAIDU_OCR_API_KEY: 'a', BAIDU_OCR_SECRET_KEY: 'b', TENCENT_SECRET_ID: 'c', TENCENT_SECRET_KEY: 'd', TEXTIN_APP_ID: 'e', TEXTIN_SECRET_CODE: 'f' }) === 'local', 'local 最高优先');
  ok(O.resolveProvider({ BAIDU_OCR_API_KEY: 'a', BAIDU_OCR_SECRET_KEY: 'b', TENCENT_SECRET_ID: 'c', TENCENT_SECRET_KEY: 'd' }) === 'baidu', '百度优先于腾讯');
  ok(O.resolveProvider({ TENCENT_SECRET_ID: 'a', TENCENT_SECRET_KEY: 'b', TEXTIN_APP_ID: 'c', TEXTIN_SECRET_CODE: 'd' }) === 'tencent', '腾讯优先于 TextIn');
  ok(O.resolveProvider({ TEXTIN_APP_ID: 'c', TEXTIN_SECRET_CODE: 'd' }) === 'textin', '只有 TextIn 时选 textin');
  ok(O.resolveProvider({}) === 'mock', '无 key 选 mock');

  // 端到端选择：注入 transport 走百度路径
  const baiduRun = await O.recognize(sample, {
    OCR_PROVIDER: 'baidu', BAIDU_ACCESS_TOKEN: 'TESTTOKEN',
    BAIDU_TRANSPORT: async () => ({ status: 200, json: async () => baiduResp }),
  });
  ok(baiduRun.backend === 'baidu' && baiduRun.lines.length === 5, 'recognize 走百度并返回 backend=baidu');

  // 端到端选择：注入 transport 走腾讯路径，避免真实网络
  const tencent = await O.recognize(sample, {
    OCR_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'AKID', TENCENT_SECRET_KEY: 'KEY',
    TENCENT_TRANSPORT: async () => ({ status: 200, json: textResp }),
  });
  ok(tencent.backend === 'tencent' && tencent.lines.length === 5, 'recognize 走腾讯并返回 backend=tencent');
  ok(tencent.boxes && tencent.boxes.items.length === 5, '腾讯路径 boxes 正常');

  // mock 模式不碰网络
  const mock = await O.recognize(sample, { OCR_MODE: 'mock' });
  ok(mock.backend === 'mock' && mock.lines.length > 10, 'OCR_MODE=mock 返回演示数据');

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
