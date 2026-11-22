// ocr.js —— OCR识别层：TextIn / 腾讯云 / 本地OCR + Mock演示
// 供应商由 .env 控制：OCR_PROVIDER = auto（默认，按 key 优先级）| textin | tencent | local | mock
// OCR_MODE 保留兼容：auto（真实失败时非生产降级Mock）| textin | mock
//
// 合规红线：本模块只把图片字节发往所选供应商，返回后即刻丢弃，绝不落盘。

'use strict';

const crypto = require('crypto');
const https = require('https');

const TEXTIN_URL = 'https://api.textin.com/ai/service/v2/recognize/document';
const TENCENT_HOST = 'ocr.tencentcloudapi.com';
const TENCENT_SERVICE = 'ocr';
const TENCENT_VERSION = '2018-11-19';
const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const BAIDU_OCR_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/';
const TIMEOUT_MS = 30000;

// ---------- Mock：模拟一张"券商 App 风"交割单截图的OCR输出 ----------
// 数据为合成样本（示例材料/示例环保），成交价、股数、日期均虚构
// 故意包含：①姓名/账号敏感行（应被丢弃计数）②一笔撤单（应跳过）
// ③一笔价格没认出来（应标低置信→复核页黄标补录）——用于演示复核管线的容错价值
function mockLines() {
  return [
    '示例证券 模拟交易客户端',
    '成 交 交 割 单',
    '股东姓名: 示例用户  股东账号: A9999****  资金账号: 9999****',
    '营业部: 示例证券股份有限公司示例营业部',
    '成交日期: 20260917  币种: 人民币',
    '成交时间  业务名称  证券代码  证券名称  成交价格  成交数量  成交金额',
    '09:34:55  证券买入  600001  示例材料  8.60  900  7740.00',
    '09:35:12  证券买入  600001  示例材料  8.50  100  850.00',
    '09:35:40  证券买入  600001  示例材料  8.45  100  845.00',
    '09:36:21  证券撤单  600001  示例材料  8.40  300  0.00',
    '09:38:05  证券买入  600001  示例材料  8.38  100  838.00',
    '09:39:20  证券买入  600001  示例材料  8.30  200  1660.00',
    '09:42:10  证券买入  600001  示例材料  8.18  200  1636.00',
    '09:45:00  证券买入  600001  示例材料  200  1600.00',
    '买入成交合计: 1800股  买入金额合计: 15169.00元',
    '==== 20260922 ====',
    '09:32:55  证券卖出  600001  示例材料  8.12  400  3248.00',
    '09:33:00  证券卖出  600001  示例材料  8.10  300  2430.00',
    '09:44:00  证券卖出  600001  示例材料  8.05  1100  8855.00',
    '卖出成交合计: 1800股  卖出金额合计: 14533.00元',
    '印花税: 23.29  过户费: 4.66',
  ];
}

// ---------- 真实TextIn调用 ----------
// QPS=2（TextIn通用文字识别套餐档，20261021查证）：瞬时第3个并发请求会429——
// 遇429/5xx延迟1.5s重试一次；判定依据=外部API边界容错，冷启动期发生率极低但兜底
async function textinRecognize(imageBuf, cfg) {
  const call = () => fetch(TEXTIN_URL, {
    method: 'POST',
    headers: {
      'x-ti-app-id': cfg.TEXTIN_APP_ID,
      'x-ti-secret-code': cfg.TEXTIN_SECRET_CODE,
      'content-type': 'application/octet-stream',
    },
    body: imageBuf,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let res = await call();
  if (res.status === 429 || res.status >= 500) {
    await new Promise(r => setTimeout(r, 1500));
    res = await call();
  }
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`TextIn响应不是JSON（HTTP ${res.status}）`);
  // TextIn约定：code=200 成功
  if (json.code !== 200) {
    throw new Error(`TextIn错误 code=${json.code} ${json.message || ''}`);
  }
  const result = json.result || json.data || {};
  const lines = collectTexts(result).map(fixMergedAnchor);
  if (!lines.length) throw new Error('TextIn未返回可解析文本（截图可能太模糊）');
  // 批次 D 任务 18：真实接口实测 line.position=八点多边形（20261102 探针 HAS_BBOX），
  // 归一化成 boxes 供前端在原图上高亮；没有 position 就返回 null，前端降级"打开原图"。
  return { lines, boxes: collectBoxes(result) };
}

// 收集识别文本：优先只用 result.lines——areas/tables 是同一内容的重复编码
// （20261020实测：全量递归walk导致每笔成交重复两遍），lines即解析器适配的逐单元格序列；
// lines缺失时才兜底全量walk（防御其他接口版本）
function collectTexts(result, out = []) {
  if (result && Array.isArray(result.lines)) {
    for (const l of result.lines) {
      if (l && typeof l.text === 'string' && l.text.trim()) out.push(l.text);
    }
    if (out.length) return out;
  }
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      if (typeof node.text === 'string' && node.text.trim()) out.push(node.text);
      for (const v of Object.values(node)) { if (v && typeof v === 'object') walk(v); }
    }
  })(result);
  return out;
}

// 收集坐标：TextIn通用文档识别返回 result.lines[].position = [x1,y1,x2,y2,x3,y3,x4,y4]
// （原始像素，配合 result.width/height）。这里同时给绝对值和归一化值，
// 前端按图片显示尺寸换算即可——OCR前压缩到1600px也不影响定位。
function collectBoxes(result) {
  const ls = result && Array.isArray(result.lines) ? result.lines : [];
  const W = +(result && result.width), H = +(result && result.height);
  if (!ls.length || !(W > 0) || !(H > 0)) return null;
  const items = [];
  for (const l of ls) {
    const p = l && l.position;
    if (!Array.isArray(p) || p.length < 4) continue;
    const xs = [], ys = [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = +p[i], y = +p[i + 1];
      if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
    }
    if (!xs.length) continue;
    const x = Math.min(...xs), y = Math.min(...ys);
    const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    if (w <= 0 || h <= 0) continue;
    items.push({
      text: String(l.text || ''), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
      nx: +(x / W).toFixed(4), ny: +(y / H).toFixed(4),
      nw: +(w / W).toFixed(4), nh: +(h / H).toFixed(4),
    });
    if (items.length >= 300) break;   // 交割单截图足够；防异常响应撑爆内存
  }
  return items.length ? { w: W, h: H, items } : null;
}

// 有些 OCR/截图会把「方向+日期+时间」合成一个单元格：卖2026101910:14:50
// 拆成 parser 能识别的锚点行：卖 20261019 10:14:50（全角冒号归一）
function fixMergedAnchor(s) {
  return String(s == null ? '' : s).replace(
    /([买卖])(\d{8})(\d{1,2}[：:]\d{2}(?:[：:]\d{2})?)/,
    (m, side, date, time) => side + ' ' + date + ' ' + time.replace(/：/g, ':')
  );
}

// ---------- 图片尺寸（归一化坐标需要；不引第三方依赖） ----------
function imageSize(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG：IHDR 宽高在 16/20 字节
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG：扫描 SOF 段
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let off = 2;
    while (off + 9 < buf.length) {
      while (off < buf.length && buf[off] === 0xFF) off++;
      if (off >= buf.length) break;
      const marker = buf[off++];
      if (marker === 0xD8 || marker === 0xD9) continue;
      if (marker >= 0xD0 && marker <= 0xD7) continue;
      if (off + 2 > buf.length) break;
      const len = buf.readUInt16BE(off);
      if (len < 2 || off + len > buf.length) break;
      const isSof = marker >= 0xC0 && marker <= 0xCF
        && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof) {
        const h = buf.readUInt16BE(off + 3);
        const w = buf.readUInt16BE(off + 5);
        return w > 0 && h > 0 ? { w, h } : null;
      }
      off += len;
    }
  }
  // WebP：VP8X 宽高（24 位小端，存的是减 1 后的值）
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      const w = 1 + buf.readUIntLE(24, 3);
      const h = 1 + buf.readUIntLE(27, 3);
      return { w, h };
    }
  }
  return null;
}

// 把 TextIn 的扁平坐标 / 腾讯云的 {X,Y} 多边形都转成矩形
function polygonRect(poly) {
  if (!Array.isArray(poly) || !poly.length) return null;
  const xs = [], ys = [];
  poly.forEach((p) => {
    if (Array.isArray(p)) {
      const x = +p[0], y = +p[1];
      if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
    } else if (p && typeof p === 'object') {
      const x = +(p.X != null ? p.X : p.x), y = +(p.Y != null ? p.Y : p.y);
      if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
    }
  });
  if (!xs.length) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function normalizeBoxes(items, W, H) {
  if (!Array.isArray(items) || !items.length || !(W > 0) || !(H > 0)) return null;
  const out = items.map((b) => {
    const x = +b.x, y = +b.y, w = +b.w, h = +b.h;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) return null;
    return {
      text: String(b.text || ''), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
      nx: +(x / W).toFixed(4), ny: +(y / H).toFixed(4),
      nw: +(w / W).toFixed(4), nh: +(h / H).toFixed(4),
    };
  }).filter(Boolean);
  return out.length ? { w: W, h: H, items: out } : null;
}

// ---------- 腾讯云 OCR（TC3-HMAC-SHA256） ----------
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function hmac(key, s) {
  return crypto.createHmac('sha256', key).update(String(s)).digest();
}
function tencentAuth(o) {
  const timestamp = o.timestamp;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payloadHash = sha256hex(o.payload);
  const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:' + TENCENT_HOST + '\n';
  const signedHeaders = 'content-type;host';
  const canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + payloadHash;
  const stringToSign = 'TC3-HMAC-SHA256\n' + timestamp + '\n'
    + date + '/' + TENCENT_SERVICE + '/tc3_request\n' + sha256hex(canonicalRequest);
  // 腾讯官方 Node SDK 的签名实现：HMAC 的根 key 是 "TC3" + SecretKey
  // （见 tencentcloud-sdk-nodejs-common/tencentcloud/common/sign.js）。
  const secretDate = hmac('TC3' + o.secretKey, date);
  const secretService = hmac(secretDate, TENCENT_SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign).toString('hex');
  return {
    authorization: 'TC3-HMAC-SHA256 Credential=' + o.secretId + '/' + date + '/' + TENCENT_SERVICE
      + '/tc3_request, SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    date, payloadHash,
  };
}

// 把腾讯响应映射成 {lines,boxes}；兼容 GeneralBasicOCR / TableOCR
function mapTencent(response, buf) {
  const r = (response && response.Response) || response || {};
  const dets = [];
  if (Array.isArray(r.TableDetections)) {
    r.TableDetections.forEach((t) => {
      (t && Array.isArray(t.Cells) ? t.Cells : []).forEach((c) => {
        if (!c) return;
        const text = String(c.Text != null ? c.Text : (c.text || '')).trim();
        const rect = polygonRect(c.Polygon || c.CellPolygon || c.polygon);
        if (text && rect) dets.push({ text, rect });
      });
    });
  }
  if (!dets.length && Array.isArray(r.TextDetections)) {
    r.TextDetections.forEach((d) => {
      if (!d) return;
      const text = String(d.DetectedText != null ? d.DetectedText : (d.Text || ''))
        .replace(/\r/g, '').trim();
      const rect = polygonRect(d.Polygon || d.polygon);
      if (text && rect) dets.push({ text, rect });
    });
  }
  if (!dets.length) throw new Error('腾讯OCR未返回可解析文本（截图可能太模糊）');

  // 按行排序：中心 Y 分桶（10px），桶内按 X；交割单一行多单元格能还原成一行
  dets.sort((a, b) => {
    const ay = Math.round((a.rect.y + a.rect.h / 2) / 10);
    const by = Math.round((b.rect.y + b.rect.h / 2) / 10);
    if (ay !== by) return ay - by;
    return a.rect.x - b.rect.x;
  });
  const lines = dets.map((d) => fixMergedAnchor(d.text));
  const size = imageSize(buf);
  const boxes = size ? normalizeBoxes(dets.map((d) => ({
    text: d.text, x: d.rect.x, y: d.rect.y, w: d.rect.w, h: d.rect.h,
  })), size.w, size.h) : null;
  return { lines, boxes };
}

function tencentPost(payload, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TENCENT_HOST, port: 443, path: '/', method: 'POST',
      headers, timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('腾讯OCR超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function tencentRecognize(imageBuf, cfg) {
  const secretId = cfg.TENCENT_SECRET_ID, secretKey = cfg.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) throw new Error('未配置 TENCENT_SECRET_ID/TENCENT_SECRET_KEY');
  const action = cfg.TENCENT_OCR_ACTION || 'GeneralBasicOCR';
  const region = cfg.TENCENT_REGION || 'ap-guangzhou';
  const bodyObj = { ImageBase64: imageBuf.toString('base64') };
  if (/Table/i.test(action)) bodyObj.UseNewModel = true;
  const payload = JSON.stringify(bodyObj);
  const timestamp = Math.floor(Date.now() / 1000);
  const auth = tencentAuth({ secretId, secretKey, payload, timestamp, action });

  // 用 https.request 显式控制 Host/Content-Type：Node fetch 对 host 的改写
  // 会让 TC3 的 host 签名对不上（实测报 AuthFailure.SignatureFailure）。
  const headers = {
    'Host': TENCENT_HOST,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Authorization': auth.authorization,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': TENCENT_VERSION,
    'X-TC-Region': region,
  };
  const transport = typeof cfg.TENCENT_TRANSPORT === 'function' ? cfg.TENCENT_TRANSPORT : tencentPost;
  const call = () => transport(payload, headers);

  let res = await call();
  if (res.status === 429 || res.status >= 500) {
    await new Promise(r => setTimeout(r, 1500));
    res = await call();
  }
  const json = res.json;
  if (!json) throw new Error('腾讯OCR响应不是JSON（HTTP ' + res.status + '）');
  if (json.Response && json.Response.Error) {
    const e = json.Response.Error;
    throw new Error('腾讯OCR错误 code=' + (e.Code || '') + ' ' + (e.Message || ''));
  }
  return mapTencent(json, imageBuf);
}

// ---------- 百度 OCR（OAuth access_token + REST） ----------
let baiduTokenCache = { key: '', token: '', expiresAt: 0 };

async function baiduAccessToken(cfg) {
  if (cfg.BAIDU_ACCESS_TOKEN) return String(cfg.BAIDU_ACCESS_TOKEN);
  const key = String(cfg.BAIDU_OCR_API_KEY || '') + '|' + String(cfg.BAIDU_OCR_SECRET_KEY || '');
  if (!cfg.BAIDU_OCR_API_KEY || !cfg.BAIDU_OCR_SECRET_KEY) {
    throw new Error('未配置 BAIDU_OCR_API_KEY/BAIDU_OCR_SECRET_KEY');
  }
  if (baiduTokenCache.key === key && baiduTokenCache.token && Date.now() < baiduTokenCache.expiresAt - 60000) {
    return baiduTokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(cfg.BAIDU_OCR_API_KEY),
    client_secret: String(cfg.BAIDU_OCR_SECRET_KEY),
  });
  const res = await fetch(BAIDU_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.access_token) {
    throw new Error('百度OCR获取token失败: ' + (json && (json.error_description || json.error) || ('HTTP ' + res.status)));
  }
  baiduTokenCache = {
    key,
    token: json.access_token,
    expiresAt: Date.now() + (+json.expires_in || 2592000) * 1000,
  };
  return baiduTokenCache.token;
}

// 百度框两种编码：
// ① words_result[].location = {left,top,width,height}（general / accurate / 多数带位置接口）
// ② words_result[].vertexes_location = [{x,y},...] 四点多边形（部分接口/高精度变体）
// 注意档位差异（20261104 实测）：general_basic / accurate_basic 这类「基础版」**不返回任何 location**
// （75 条 words 全是纯文字），要坐标必须用含位置版 general / accurate。
function baiduRect(r) {
  if (!r) return null;
  const loc = r.location;
  if (loc) {
    const x = +loc.left, y = +loc.top, w = +loc.width, h = +loc.height;
    if (Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0) return { x, y, w, h };
  }
  return polygonRect(r.vertexes_location || r.vertexesLocation || null);
}

function mapBaidu(json, buf) {
  const rows = (json && Array.isArray(json.words_result)) ? json.words_result : [];
  const dets = [];
  rows.forEach((r) => {
    if (!r) return;
    const text = String(r.words == null ? '' : r.words).replace(/\r/g, '').trim();
    if (!text) return;
    dets.push({ text, rect: baiduRect(r) });
  });
  if (!dets.length) throw new Error('百度OCR未返回可解析文本（截图可能太模糊）');
  // 全部有框才按 top/left 重排——无框档位（*_basic）必须保持接口返回的阅读顺序
  if (dets.every((d) => d.rect)) {
    dets.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
  }
  const lines = dets.map((d) => fixMergedAnchor(d.text));
  // 坐标降级：只有部分行带框时，用带框的那些出 boxes（不再整批作废），
  // 前端 trust.js 拿不到框的行自动跳过原图定位，不会因此中断主流程。
  const size = imageSize(buf);
  const rected = size ? dets.filter((d) => d.rect) : [];
  const boxes = rected.length ? normalizeBoxes(rected.map((d) => ({
    text: d.text, x: d.rect.x, y: d.rect.y, w: d.rect.w, h: d.rect.h,
  })), size.w, size.h) : null;
  return { lines, boxes };
}

async function baiduRecognize(imageBuf, cfg) {
  const type = cfg.BAIDU_OCR_TYPE || 'general_basic';
  const token = await baiduAccessToken(cfg);
  const body = new URLSearchParams({
    image: imageBuf.toString('base64'),
    language_type: 'CHN_ENG',
    detect_direction: 'true',
    paragraph: 'false',
  });
  const transport = typeof cfg.BAIDU_TRANSPORT === 'function'
    ? cfg.BAIDU_TRANSPORT
    : (url, opts) => fetch(url, opts);
  const url = BAIDU_OCR_URL + type + '?access_token=' + encodeURIComponent(token);
  const res = await transport(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('百度OCR响应不是JSON（HTTP ' + res.status + '）');
  if (json.error_code) throw new Error('百度OCR错误 code=' + json.error_code + ' ' + (json.error_msg || ''));
  return mapBaidu(json, imageBuf);
}


// ---------- 本地 OCR 服务（POST 图片字节；返回 {ok,lines,boxes}） ----------
async function localRecognize(imageBuf, cfg) {
  const url = cfg.LOCAL_OCR_URL;
  if (!url) throw new Error('未配置 LOCAL_OCR_URL');
  const headers = { 'content-type': 'application/octet-stream' };
  if (cfg.LOCAL_OCR_TOKEN) headers['x-ocr-token'] = String(cfg.LOCAL_OCR_TOKEN);
  const res = await fetch(url, {
    method: 'POST', headers, body: imageBuf,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('本地OCR响应不是JSON（HTTP ' + res.status + '）');
  if (!json.ok) throw new Error(json.error || '本地OCR识别失败');
  const lines = Array.isArray(json.lines) ? json.lines
    : (Array.isArray(json.items) ? json.items.map((i) => String((i && i.text) || '')) : []);
  const clean = lines.map((s) => fixMergedAnchor(String(s || '').replace(/\r/g, '').trim())).filter(Boolean);
  if (!clean.length) throw new Error('本地OCR未返回可解析文本');
  const boxes = json.boxes || normalizeBoxes(json.items, +json.w, +json.h);
  return { lines: clean, boxes };
}

function hasTextin(cfg) { return !!(cfg.TEXTIN_APP_ID && cfg.TEXTIN_SECRET_CODE); }
function hasTencent(cfg) { return !!(cfg.TENCENT_SECRET_ID && cfg.TENCENT_SECRET_KEY); }
function hasBaidu(cfg) { return !!(cfg.BAIDU_OCR_API_KEY && cfg.BAIDU_OCR_SECRET_KEY); }
function resolveProvider(cfg) {
  const p = String(cfg.OCR_PROVIDER || 'auto').toLowerCase();
  if (p !== 'auto' && p !== '') return p;
  if (cfg.LOCAL_OCR_URL) return 'local';
  if (hasBaidu(cfg)) return 'baidu';
  if (hasTencent(cfg)) return 'tencent';
  if (hasTextin(cfg)) return 'textin';
  return 'mock';
}

// ---------- 统一入口 ----------
async function recognize(imageBuf, cfg) {
  const mode = (cfg.OCR_MODE || 'auto').toLowerCase();
  // P0-1：生产环境绝不返回演示数据。无 key（provider=mock）或显式 OCR_MODE=mock
  // 都走 503 + reason=ocr_not_configured，由 server.js 转成明确错误；非生产保持 mock 供本地测试。
  const prod = process.env.NODE_ENV === 'production';
  const mockOrProdError = () => (prod
    ? { lines: [], backend: 'mock', error: 'OCR 未配置：生产环境禁止返回演示数据', reason: 'ocr_not_configured', boxes: null }
    : { lines: mockLines(), backend: 'mock', boxes: null });
  if (mode === 'mock') return mockOrProdError();

  let provider = resolveProvider(cfg);
  if (mode === 'textin' && String(cfg.OCR_PROVIDER || 'auto').toLowerCase() === 'auto') provider = 'textin';
  if (provider === 'mock') return mockOrProdError();

  try {
    if (provider === 'textin') {
      if (!hasTextin(cfg)) throw new Error('OCR_PROVIDER=textin 但未配置 TEXTIN_APP_ID/TEXTIN_SECRET_CODE');
      const r = await textinRecognize(imageBuf, cfg);
      return Object.assign(r, { backend: 'textin' });
    }
    if (provider === 'tencent') {
      const r = await tencentRecognize(imageBuf, cfg);
      return Object.assign(r, { backend: 'tencent' });
    }
    if (provider === 'baidu') {
      const r = await baiduRecognize(imageBuf, cfg);
      return Object.assign(r, { backend: 'baidu' });
    }
    if (provider === 'local') {
      const r = await localRecognize(imageBuf, cfg);
      return Object.assign(r, { backend: 'local' });
    }
    throw new Error('未知 OCR_PROVIDER: ' + provider);
  } catch (e) {
    // 生产模式：真实失败直接报错让用户重试——演示数据进生产=事故
    // 开发模式：降级Mock便于本地无网调试
    if (process.env.NODE_ENV === 'production') {
      return { lines: [], backend: provider, error: String(e.message || e), boxes: null };
    }
    const lines = mockLines();
    lines.unshift('[降级提示] ' + provider + '失败(' + (e.message || e) + ')，本次使用演示数据');
    return { lines, backend: 'mock-fallback', error: String(e.message || e), boxes: null };
  }
}

module.exports = {
  recognize, mockLines, collectTexts, collectBoxes, fixMergedAnchor,
  imageSize, polygonRect, normalizeBoxes, mapTencent, tencentAuth, tencentRecognize,
  mapBaidu, baiduRecognize, baiduAccessToken,
  localRecognize, resolveProvider,
};
