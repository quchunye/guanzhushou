// server.js —— 「管住手了吗」H5 W1骨架服务端（零依赖，Node 18+）
// 启动：node server.js   （或双击 ../start.bat）
// 端口：默认3210，.env 可改
//
// 合规要点（10_产品合规可行性报告）：
//  1) 原图不落盘：上传字节仅在内存中过OCR后丢弃；日志只记元数据，永不记图像/识别内容
//  2) W1骨架期无数据库、无任何持久化用户数据；复核数据只存用户设备( localStorage )
//  3) 静态前端将来部署Cloudflare Pages；本服务端W3迁境内服务器（数据不出境架构）

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const ext = require('./ext');
const builtinCatalog = require('./builtin-catalog');

// ---- .env 加载（无依赖手搓）----
const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const CFG = {
  PORT: +(process.env.PORT || 3210),
  OCR_MODE: process.env.OCR_MODE || 'auto',
  OCR_PROVIDER: process.env.OCR_PROVIDER || 'auto',
  TEXTIN_APP_ID: process.env.TEXTIN_APP_ID || '',
  TEXTIN_SECRET_CODE: process.env.TEXTIN_SECRET_CODE || '',
  BAIDU_OCR_API_KEY: process.env.BAIDU_OCR_API_KEY || '',
  BAIDU_OCR_SECRET_KEY: process.env.BAIDU_OCR_SECRET_KEY || '',
  BAIDU_OCR_TYPE: process.env.BAIDU_OCR_TYPE || 'general_basic',
  TENCENT_SECRET_ID: process.env.TENCENT_SECRET_ID || '',
  TENCENT_SECRET_KEY: process.env.TENCENT_SECRET_KEY || '',
  TENCENT_REGION: process.env.TENCENT_REGION || 'ap-guangzhou',
  TENCENT_OCR_ACTION: process.env.TENCENT_OCR_ACTION || 'GeneralBasicOCR',
  LOCAL_OCR_URL: process.env.LOCAL_OCR_URL || '',
  LOCAL_OCR_TOKEN: process.env.LOCAL_OCR_TOKEN || '',
  JUDGE_MODE: process.env.JUDGE_MODE || 'auto',
  // 多厂商赛马池（20261021架构）：judge.js按有key才参赛，vendor:model记胜负
  ZHIPU_MODEL: process.env.ZHIPU_MODEL || 'glm-4.7-flash',
  ZHIPU_API_KEY: process.env.ZHIPU_API_KEY || '',
  DASHSCOPE_MODEL: process.env.DASHSCOPE_MODEL || 'qwen-flash',
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || '',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-flash', // = DeepSeek-V4.1-Flash-1017
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  STATS_KEY: process.env.STATS_KEY || '',
  // P0-2：是否信任反向代理覆盖式注入的 X-Forwarded-For（1=信任，缺省=不信任）
  TRUST_PROXY: process.env.TRUST_PROXY || '',
};

const ocr = require('./ocr');
const { parse } = require('./parser');
const { judge } = require('./judge');
const { TEMPLATES, DEFAULT_CONFIG } = require('./rules');

// 自托管版：无账号、无支付、无授权签发。以下三个钩子保持空实现，
// 判定链路直接放行（与上游「支付未启用」时的行为一致）。
const PAY_CFG = { required: false, enabled: false, price: null };
const paymentRouter = null;
const paymentRouterReady = false;
const authorizeReport = async () => ({ ok: true });
const markConsumed = async () => {};

// ---- 运行日志（溯源用，只记元数据）----
const LOG_DIR = path.join(__dirname, 'log');
fs.mkdirSync(LOG_DIR, { recursive: true });
function logRun(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  fs.appendFile(path.join(LOG_DIR, `run_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`), line, () => {});
}

// ---- 埋点（只记事件名/渠道/匿名设备ID，不记IP、不记图像与识别内容）----
const TRACK_DIR = path.join(__dirname, 'data', 'track');
fs.mkdirSync(TRACK_DIR, { recursive: true });
const TRACK_EVENTS = new Set([
  'view', 'help_open', 'sample_start', 'sample_review', 'upload_start', 'ocr_ok',
  'review_confirm', 'report_done', 'sample_report', 'share_open',
  'own_upload_after_sample', 'rules_saved', 'rules_from_report',
  // 批次 A（1 复发账本 / 2 连续合规 / 3 首破 / 4 共振 / 5 体检 / 6 间隔）
  'recur_view', 'recur_detail_open', 'recur_case_open',
  // 批次 B（7 明日一规 / 8 盘前一句话 / 9 买入理由 / 10 止损 / 11 情绪）
  'focus_set', 'focus_settle_view', 'note_set', 'reason_tag', 'stop_set', 'mood_set',
  // 批次 D（17 解释器 / 18 原图定位 / 19 申诉例外 / 20 冲突 / 21 版本）
  'explain_open', 'bbox_open', 'exempt_set', 'rule_conflict_warn', 'rules_version_seg',
  // 批次 C（12 回传 / 13 午间快检 / 14 缺口 / 15 重复 / 16 导入历史）
  't_view', 't_ocr_start', 't_report_done', 'upload_paste', 'upload_multi',
  'upload_time_ms', 'gap_view', 'dup_warn', 'import_history_open',
  // 批次 F（26 日历 / 27 静默名单 / 28 回归礼包 / 29 分享卡 / 30 示例复发）
  'ics_download', 'regress_open', 'demo_recur', 'gap_fill', 'silent_list', 'share_recur',
  'ocr_empty', 'archive_open', 'upload_after_report',
  // 批次 E（22 备份 / 23 多账户 / 24 持仓 / 25 出入金）
  'export', 'import', 'account_tag', 'position_set', 'cash_set',
  // FG-1 开闸面板
  'flag_set',
  'share_fallback',   // ST-2 分享页降级（只记 template/reason/fallbackUsed，不带交易内容）
]);

// 埋点属性（前端 track(event, props) 会带来 props）：只收一层标量，体积有上限，
// 超限按 key 顺序丢尾部并标 truncated:true——埋点宁可少也不能整条拒收。
const PROPS_STR_MAX = 200;
const PROPS_MAX_BYTES = 1024;
function cleanProps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { props: null, truncated: false };
  const out = {};
  let truncated = false;
  for (const k of Object.keys(raw).slice(0, 30)) {
    const key = String(k).replace(/[^\w\-.]/g, '').slice(0, 40);
    if (!key) continue;
    const v = raw[k];
    if (typeof v === 'string') {
      out[key] = v.slice(0, PROPS_STR_MAX);
      if (v.length > PROPS_STR_MAX) truncated = true;
    } else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean' || v === null) out[key] = v;
    // 嵌套对象/数组/undefined 不收：埋点只要一层标量
  }
  if (!Object.keys(out).length) return { props: null, truncated: false };
  if (Buffer.byteLength(JSON.stringify(out)) > PROPS_MAX_BYTES) {
    const slim = {};
    for (const k of Object.keys(out)) {
      const test = Object.assign({}, slim, { [k]: out[k] });
      if (Buffer.byteLength(JSON.stringify(test)) > PROPS_MAX_BYTES) break;
      slim[k] = out[k];
    }
    return { props: slim, truncated: true };
  }
  return { props: out, truncated };
}

function trackWrite(req, res) {
  // 上限 8KB：props 允许超 1KB（落盘时截断），但不能让请求被体积上限直接拒掉
  readBody(req, 8192).then((buf) => {
    let p;
    try { p = JSON.parse(buf.toString('utf8')); } catch { return sendJson(res, 400, { ok: false }); }
    const event = String(p.event || '').slice(0, 40);
    if (!TRACK_EVENTS.has(event)) return sendJson(res, 400, { ok: false });
    const src = (String(p.src || 'direct').replace(/[^\w\-.]/g, '').slice(0, 32) || 'direct');
    const vid = String(p.vid || '').replace(/[^\w\-]/g, '').slice(0, 40);
    const { props, truncated } = cleanProps(p.props);
    const rec = { ts: new Date().toISOString(), event, src, vid };
    if (props) { rec.props = props; if (truncated) rec.truncated = true; }
    fs.appendFile(path.join(TRACK_DIR, `events_${rec.ts.slice(0, 10).replace(/-/g, '')}.jsonl`),
      JSON.stringify(rec) + '\n', () => {});
    return sendJson(res, 200, { ok: true });
  }).catch(() => { try { sendJson(res, 400, { ok: false }); } catch {} });
}

function trackStats(req, res, url) {
  const key = url.searchParams.get('key') || '';
  if (CFG.STATS_KEY) {
    if (key !== CFG.STATS_KEY) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  } else {
    // P0-3：门禁与 features/recall.js:173-185 保持一致——nginx 反代后 socket 恒为 127.0.0.1，
    // 只看 socket 会让公网可直读；必须先看 XFF 首跳是否本机。
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const first = xff.split(',')[0].trim();
      if (!isLocalIp(first)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }
    const ip = req.socket.remoteAddress || '';
    if (!isLocalIp(ip)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const totals = {}, todayMap = {}, sources = {};
  const vids = new Set(), reportVids = new Set();
  let files = [];
  try { files = fs.readdirSync(TRACK_DIR).filter(f => f.endsWith('.jsonl')); } catch {}
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(TRACK_DIR, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const ev = r.event, src = r.src || 'direct';
      totals[ev] = (totals[ev] || 0) + 1;
      if (String(r.ts || '').slice(0, 10) === today) todayMap[ev] = (todayMap[ev] || 0) + 1;
      if (!sources[src]) sources[src] = { view: 0, sample_start: 0, sample_report: 0, upload_start: 0, report_done: 0 };
      if (sources[src][ev] !== undefined) sources[src][ev]++;
      if (r.vid) { vids.add(r.vid); if (ev === 'report_done' || ev === 'sample_report') reportVids.add(r.vid); }
    }
  }
  return sendJson(res, 200, {
    ok: true, today,
    totals, today: todayMap, sources,
    unique: { visitors: vids.size, reporters: reportVids.size },
  });
}

function isLocalIp(ip) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(String(ip || ''));
}

// P0-2：限流用的真实客户端 IP。
// 默认不信任 X-Forwarded-For（客户端自带的一带就变，可伪造绕过限流）；
// 仅当 TRUST_PROXY=1 且直连方是本机回环（nginx 覆盖式注入场景）才采信 XFF 首跳。
function clientIp(req) {
  const sock = req.socket.remoteAddress || '';
  if (CFG.TRUST_PROXY === '1' && isLocalIp(sock)) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }
  return sock || 'unknown';
}

// ---- 简易限流：每IP 30次/分钟 ----
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.ts > 60000) { b = { ts: now, n: 0 }; buckets.set(ip, b); }
  b.n++;
  return b.n > 30;
}
const hashIp = (ip) => crypto.createHash('sha1').update(String(ip)).digest('hex').slice(0, 8);

// ---- 行情数据只读路由（数据落在 KLINE_ROOT，不在 public 直出目录）----
// 合规：行情包不做静态公开直出，全部收敛到 /api/kline/{index|manifest|pack}，
// 参数走严格白名单 + 解析后断言仍在数据根内；未命中一律 404，不回落到静态文件。
const KLINE_ROOT = path.resolve(
  process.env.KLINE_ROOT || path.join(__dirname, '..', 'public', 'data', 'kline')
);
const KLINE_SYMBOL_RE = /^(sh|sz|bj)[0-9]{6}$/;
const KLINE_MONTH_RE = /^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$/;
// 访问模式：ledger（默认，令牌 + 档案白名单）/ public（仅本地开发与既有测试）
const KLINE_ACCESS_MODE = String(process.env.KLINE_ACCESS_MODE || 'ledger').toLowerCase() === 'public' ? 'public' : 'ledger';
const KLINE_TOKEN_SECRET = process.env.KLINE_TOKEN_SECRET || '';
// B5：默认压到 30 分钟（原 86400）。前端 ensureToken 会在过期前 60 秒重取。
const KLINE_TOKEN_TTL = Math.max(60, +(process.env.KLINE_TOKEN_TTL || 1800));
const KLINE_TOKEN_MAX_SCOPE = Math.max(1, +(process.env.KLINE_TOKEN_MAX_SCOPE || 200));
// 是否强制要求会话：默认 0。登录页（B6）上线前切 1 会让现有用户全部 401，先不动。
const KLINE_REQUIRE_SESSION = process.env.KLINE_REQUIRE_SESSION === '1';
// PLACEHOLDER: 待定价确定后按档位替换。
// 当前所有有会话的用户统一「当月 + 前 2 个月」，先让机制跑通，商业规则留白。
const KLINE_PLACEHOLDER_MONTHS = 3;
// 未配密钥时用进程内随机密钥兜底：安全上不会退化成无签名，代价是重启后旧令牌失效
const KLINE_SIGN_KEY = KLINE_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
if (KLINE_ACCESS_MODE === 'ledger' && !KLINE_TOKEN_SECRET) {
  console.warn('[kline] KLINE_TOKEN_SECRET 未配置：本次启动用随机密钥签名，重启后旧令牌全部失效');
}
const KLINE_RATE_PER_MIN = +(process.env.KLINE_RATE_PER_MIN || 60);
const KLINE_BURST = +(process.env.KLINE_BURST || 10);
const klineBuckets = new Map();

// 令牌桶：容量 = 突发 10，按 60 次/分钟匀速回填（1 次/秒）
function klineRateLimited(ip) {
  const now = Date.now();
  let b = klineBuckets.get(ip);
  if (!b) { b = { ts: now, tokens: KLINE_BURST }; klineBuckets.set(ip, b); }
  else {
    b.tokens = Math.min(KLINE_BURST, b.tokens + (now - b.ts) / 60000 * KLINE_RATE_PER_MIN);
    b.ts = now;
  }
  if (klineBuckets.size > 5000) {
    for (const [k, v] of klineBuckets) if (now - v.ts > 600001) klineBuckets.delete(k);
  }
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

// ---- 内置回放静态包签名（20261107）----
// /builtin/index.json 与 /builtin/pack/* 不再公开直出：先取 60 秒票据，再带 ?e=&s= 访问。
// 签名只覆盖 exp，签名密钥不进前端；静态守卫用常量时间比较，失败一律 403（沿用静态域，不混 kline 的 401）。
const BUILTIN_SIGN_KEY = process.env.BUILTIN_SIGN_KEY || crypto.randomBytes(32).toString('hex');
const BUILTIN_TICKET_TTL = Math.max(5, +(process.env.BUILTIN_TICKET_TTL || 60));
const BUILTIN_RATE_PER_MIN = Math.max(1, +(process.env.BUILTIN_RATE_PER_MIN || 20));
if (!process.env.BUILTIN_SIGN_KEY) {
  console.warn('[builtin] BUILTIN_SIGN_KEY 未配置：本次启动用随机密钥签名，重启后旧票据失效（票期仅 60 秒，无影响）');
}
const builtinBuckets = new Map();

// 票据接口独立限流：每 IP 20 次/分钟（固定窗口），不与通用桶/行情桶共享
function builtinRateLimited(ip) {
  const now = Date.now();
  let b = builtinBuckets.get(ip);
  if (!b || now - b.ts > 60000) { b = { ts: now, n: 0 }; builtinBuckets.set(ip, b); }
  if (builtinBuckets.size > 5000) {
    for (const [k, v] of builtinBuckets) if (now - v.ts > 600001) builtinBuckets.delete(k);
  }
  b.n++;
  return b.n > BUILTIN_RATE_PER_MIN;
}

function builtinSig(exp) {
  return crypto.createHmac('sha256', BUILTIN_SIGN_KEY).update(String(exp)).digest('hex');
}

// 长期签名（20261107）：由内容版本派生、不随时间变。
// 旧 ?e=&s= 的 60 秒票据会把 HTTP 缓存命中率清零（每 60 秒换 URL），
// 分片改走 /builtin/pack/<version>/<sig>/<file>.gz，sig 只跟版本走，可长期 immutable。
const BUILTIN_PACK_SIG_LEN = 24;
function builtinVersionSig(version) {
  return crypto.createHmac('sha256', BUILTIN_SIGN_KEY).update('pack:v1:' + String(version)).digest('hex').slice(0, BUILTIN_PACK_SIG_LEN);
}

// 任意长度 hex 的常量时间比较（timingSafeEqual 不接受不等长）
function builtinHexEqual(gotRaw, wantHex) {
  const got = String(gotRaw == null ? '' : gotRaw);
  const want = String(wantHex == null ? '' : wantHex);
  if (got.length !== want.length || !got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
  } catch (e) { return false; }
}

// 校验 ?e=&s=：exp 必须是当前有效的 10 位秒级时间戳，sig 必须是 64 位 hex；
// 长度先比、再 timingSafeEqual，长度不等直接判失败（timingSafeEqual 不接受不等长）。
function builtinSigOk(expRaw, sigRaw) {
  const expStr = String(expRaw == null ? '' : expRaw);
  const sig = String(sigRaw == null ? '' : sigRaw);
  if (!/^\d{1,12}$/.test(expStr) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const exp = +expStr;
  const now = Math.floor(Date.now() / 1000);
  if (!(exp > now)) return false;
  if (exp > now + BUILTIN_TICKET_TTL + 5) return false;
  const want = Buffer.from(builtinSig(exp), 'hex');
  const got = Buffer.from(sig, 'hex');
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function builtinStaticGuard(res) {
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('403');
}

// ---- 目录（code+name，不带 K 线索引）----
// 元信息：GET /api/builtin/catalog → { ok, version, sig, count, url }，no-cache
function handleBuiltinCatalogMeta(res) {
  const meta = builtinIndexMetaRead();
  const info = meta && meta.obj ? builtinCatalog.catalogMeta(BUILTIN_SIGN_KEY, meta.obj) : null;
  if (!info) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: false, error: '目录尚未生成' }));
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  // packSig/windows 一并给出：客户端接上目录后，首屏可完全不读 index.json
  return res.end(JSON.stringify({
    ok: true, schema: info.schema, version: info.version, sig: info.sig,
    packSig: builtinVersionSig(info.version),
    count: info.count, url: info.url,
    windows: Array.isArray(meta.obj.windows) ? meta.obj.windows : [],
  }));
}

// 本体：GET /api/builtin/catalog/<version>/<sig>.json.gz，gzip 的 {schema,version,count,symbols:[[code,name]]}
function handleBuiltinCatalogPack(res, m) {
  const meta = builtinIndexMetaRead();
  if (!meta || !meta.version || m[1] !== meta.version
      || !builtinHexEqual(m[2], builtinCatalog.catalogSig(BUILTIN_SIGN_KEY, m[1]))) {
    return builtinStaticGuard(res);
  }
  const built = builtinCatalogGz(meta);
  if (!built) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end('404'); }
  res.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'public, max-age=31536000, immutable' });
  return res.end(built.gz);
}

// 目录 gzip 与索引 mtime 绑定：索引换版本时重算，否则直接复用
let builtinCatalogCache = { mtimeMs: 0, raw: null, gz: null };
function builtinCatalogGz(meta) {
  if (!meta || !meta.obj) return null;
  if (!builtinCatalogCache.mtimeMs || builtinCatalogCache.mtimeMs !== meta.mtimeMs) {
    const raw = builtinCatalog.catalogJson(meta.obj);
    builtinCatalogCache = { mtimeMs: meta.mtimeMs, raw: raw, gz: zlib.gzipSync(raw, { level: 9 }) };
  }
  return builtinCatalogCache;
}

// GET /api/builtin/ticket → { ok, exp, sig }；不回显密钥，也不做身份认证
function handleBuiltinTicket(req, res, ip) {
  if (builtinRateLimited(ip)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' });
    return res.end('{"ok":false,"error":"请求太频繁"}');
  }
  const exp = Math.floor(Date.now() / 1000) + BUILTIN_TICKET_TTL;
  return sendJson(res, 200, { ok: true, exp, sig: builtinSig(exp) });
}

// 只读 month/symbol 两个参数；其余 query（含前端账本指纹 s、缓存键 v）一律忽略，
// 不因未知参数返回 400/401（20261106 加 s 后仍需保持这一行为）。
function klineRelPath(kind, url) {
  if (kind === 'index') return 'index.json';
  const month = url.searchParams.get('month') || '';
  if (!KLINE_MONTH_RE.test(month)) return null;
  if (kind === 'manifest') return path.join('5m', '_manifest', month + '.json.gz');
  const symbol = url.searchParams.get('symbol') || '';
  if (!KLINE_SYMBOL_RE.test(symbol)) return null;
  return path.join('5m', symbol, month + '.json.gz');
}

// 先 realpath 数据根（current 是软链），再 resolve + 前缀断言；
// 任何 ../、绝对路径、越界解析都返回 null。
function klineResolve(rel) {
  let root;
  try { root = fs.realpathSync(KLINE_ROOT); } catch { return null; }
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function klineNotFound(res) {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end('{"ok":false,"error":"未找到"}');
}

function klineUnauthorized(res) {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'www-authenticate': 'Bearer realm="kline"',
  });
  res.end('{"ok":false,"error":"未授权：需要档案令牌"}');
}

// ---- 档案令牌：payload 里是 symbol|month 白名单 + 过期时间，HMAC-SHA256 签名 ----
// 幂等编码：同一份 scope 同一秒内签出的令牌一致，便于客户端缓存。
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function klineSign(payloadB64) {
  return b64url(crypto.createHmac('sha256', KLINE_SIGN_KEY).update('pj1.' + payloadB64).digest());
}
function issueKlineToken(scope, ttlSec, sub) {
  const ttl = Math.min(Math.max(+ttlSec || KLINE_TOKEN_TTL, 60), 604800);
  const payload = { v: 1, exp: Math.floor(Date.now() / 1000) + ttl, s: scope.slice().sort() };
  // sub 进 payload：令牌从此可归因到账号（只做归属，不放任何手机号/PII）
  if (sub) payload.sub = String(sub);
  const p = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { token: 'pj1.' + p + '.' + klineSign(p), exp: payload.exp };
}
/**
 * 验签并返回 { sub, scope }。
 * sub 为 null 表示旧令牌（签发时没有会话），调用方必须能处理这种情况。
 */
function verifyKlineToken(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'pj1') return null;
  const got = Buffer.from(parts[2]);
  const want = Buffer.from(klineSign(parts[1]));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.s) || !(payload.exp > Date.now() / 1000)) return null;
  if (payload.s.length > KLINE_TOKEN_MAX_SCOPE) return null;
  return {
    sub: payload.sub ? String(payload.sub) : null,
    scope: new Set(payload.s),
  };
}

// 按「当月 + 前 n-1 个月」生成 YYYY-MM（固定 Asia/Shanghai，不受进程时区影响）
function recentMonths(n, nowMs) {
  const d = new Date((nowMs || Date.now()) + 8 * 3600001);   // 用 UTC 读法读上海本地时间
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.getUTCFullYear() + '-' + String(m.getUTCMonth() + 1).padStart(2, '0'));
  }
  return out;
}

/**
 * 这个账号能取哪些月份。
 * 占位口径下所有人一致；定价确定后把 KLINE_PLACEHOLDER_MONTHS 置 0，改读 account.kline_months。
 * 老账号没有 kline_months 字段时必须返回空数组——不能默认放宽成「全部月份」。
 */
function allowedMonths(account) {
  if (KLINE_PLACEHOLDER_MONTHS > 0) return recentMonths(KLINE_PLACEHOLDER_MONTHS);
  const list = account && account.kline_months;
  return Array.isArray(list) ? list.filter((m) => KLINE_MONTH_RE.test(String(m))) : [];
}
function validKlineScopeItem(s) {
  const a = String(s || '').split('|');
  return a.length === 2 && KLINE_SYMBOL_RE.test(a[0]) && KLINE_MONTH_RE.test(a[1]);
}

// 按令牌白名单裁剪 index：只暴露涉及的标的与月份，total 也只算白名单内
function scopedKlineIndex(raw, scope) {
  const allowed = {};
  scope.forEach((s) => {
    const a = s.split('|');
    if (!a || a.length !== 2) return;
    (allowed[a[1]] || (allowed[a[1]] = new Set())).add(a[0]);
  });
  const months = {};
  const symbols = {};
  Object.keys(allowed).sort().forEach((m) => {
    if (!raw.months || !raw.months[m]) return;
    const file = klineResolve(path.join('5m', '_manifest', m + '.json.gz'));
    if (!file) return;
    let man = null;
    try { man = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch (e) { man = null; }
    const keep = ((man && man.entries) || []).filter((e) => e && allowed[m].has(e.symbol));
    const bytes = keep.reduce((a, e) => a + (+e.bytes || 0), 0);
    months[m] = Object.assign({}, raw.months[m], { files: keep.length, bytes });
    keep.forEach((e) => {
      if (!symbols[e.symbol]) symbols[e.symbol] = { name: e.name || '', months: [] };
      symbols[e.symbol].months.push(m);
    });
  });
  return Object.assign({}, raw, {
    months,
    symbols,
    scoped: true,
    total_files: Object.keys(months).reduce((a, m) => a + months[m].files, 0),
    total_bytes: Object.keys(months).reduce((a, m) => a + months[m].bytes, 0),
  });
}

// 按令牌裁剪月清单：只保留白名单内的票，重新 gzip（内容随范围变化，禁止共享缓存）
function sendScopedManifest(res, file, month, scope) {
  const allowed = new Set();
  scope.forEach((s) => {
    const a = s.split('|');
    if (a.length === 2 && a[1] === month) allowed.add(a[0]);
  });
  if (!allowed.size) return klineUnauthorized(res);
  let man = null;
  try { man = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch (e) { return klineNotFound(res); }
  const entries = ((man && man.entries) || []).filter((e) => e && allowed.has(e.symbol));
  const body = zlib.gzipSync(JSON.stringify(Object.assign({}, man, { entries })));
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'cache-control': 'private, no-store',
    'vary': 'x-kline-token',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendKlineFile(req, res, file, kind, scoped) {
  fs.readFile(file, (err, data) => {
    if (err) return klineNotFound(res);
    const etag = '"' + crypto.createHash('sha256').update(data).digest('hex').slice(0, 32) + '"';
    const headers = {
      'content-type': kind === 'index' ? 'application/json; charset=utf-8' : 'application/gzip',
      'cache-control': kind === 'index' ? 'no-cache'
        : (scoped ? 'private, max-age=31536000, immutable' : 'public, max-age=31536000, immutable'),
      'etag': etag,
      'x-content-type-options': 'nosniff',
    };
    if (scoped) headers.vary = 'x-kline-token';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// 令牌签发：POST {scope:[symbol|month,...], ttl?}。只做范围收窄，不做身份认证
async function handleKlineToken(req, res, ip) {
  if (klineRateLimited(ip)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' });
    return res.end('{"ok":false,"error":"请求太频繁"}');
  }
  let payload;
  try { payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
  }
  const scope = Array.isArray(payload && payload.scope) ? payload.scope.map(String) : [];
  if (!scope.length) return sendJson(res, 400, { ok: false, error: 'scope 不能为空' });
  if (scope.length > KLINE_TOKEN_MAX_SCOPE) {
    return sendJson(res, 400, { ok: false, error: 'scope 超过上限', max: KLINE_TOKEN_MAX_SCOPE });
  }
  if (scope.some((s) => !validKlineScopeItem(s))) {
    return sendJson(res, 400, { ok: false, error: 'scope 必须形如 sh600001|2025-01' });
  }

  // 自托管版不做账号月份限权，按请求 scope 直接签发。
  const out = issueKlineToken(scope, payload.ttl, null);
  return sendJson(res, 200, {
    ok: true,
    token: out.token,
    exp: out.exp,
    scope: new Set(scope).size,
  });
}

function handleKline(req, res, pathname, url, ip) {
  if (klineRateLimited(ip)) {
    res.writeHead(429, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '60',
    });
    return res.end('{"ok":false,"error":"请求太频繁"}');
  }
  const kind = pathname === '/api/kline/index' ? 'index'
    : pathname === '/api/kline/manifest' ? 'manifest'
      : pathname === '/api/kline/pack' ? 'pack' : '';
  const rel = kind ? klineRelPath(kind, url) : null;
  const full = rel ? klineResolve(rel) : null;
  if (!full) return klineNotFound(res);

  if (KLINE_ACCESS_MODE === 'ledger') {
    const verified = verifyKlineToken(req.headers['x-kline-token']);
    if (!verified) return klineUnauthorized(res);
    const scope = verified.scope;
    if (kind === 'index') {
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { return klineNotFound(res); }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'vary': 'x-kline-token',
      });
      return res.end(JSON.stringify(scopedKlineIndex(raw, Array.from(scope))));
    }
    const month = url.searchParams.get('month') || '';
    if (kind === 'manifest') return sendScopedManifest(res, full, month, Array.from(scope));
    const symbol = url.searchParams.get('symbol') || '';
    if (!scope.has(symbol + '|' + month)) return klineUnauthorized(res);
    return sendKlineFile(req, res, full, kind, true);
  }
  return sendKlineFile(req, res, full, kind, false);
}

// ---- 图片校验：魔数 + 大小（不信任前端声明的类型）----
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  // 预压缩的 K 线包（public/data/kline / tick）。不给 Content-Encoding：
  // 前端用 DecompressionStream('gzip') 自行解压，若这里声明 gzip 会被浏览器二次解压而报错。
  '.gz': 'application/gzip',
};

function readBody(req, capBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > capBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// ---- 规则配置：前端勾选结果，2KB 上限（细挖项 5）----
// 批次 E-24：期初持仓随判定请求透传（客户端 asset.js 注入）。体积仍只按 rules+capital 计，
// positions 按条数钳制 50；字段/数值清洗在 server/rules.js 的 sanitizePositions 里做。
function pickConfig(payload) {
  const config = {
    rules: Array.isArray(payload.rules) ? payload.rules.slice(0, 13) : null,
    capital: payload.capital == null || payload.capital === '' ? null : +payload.capital,
    positions: Array.isArray(payload.positions) ? payload.positions.slice(0, 50) : null,
  };
  return { config, tooBig: JSON.stringify({ rules: config.rules, capital: config.capital }).length > 2048 };
}

// ---- API 处理器 ----
async function handleApi(req, res, pathname, url) {
  // 扩展路由先接（批次 F 的 /api/recall/* 等）；返回 false 继续主流程
  try {
    if (await ext.handle(req, res, pathname, url)) return;
  } catch (e) { /* 扩展失败不阻塞主服务 */ }

  const ip = clientIp(req);
  if (pathname === '/api/track' && req.method === 'POST') return trackWrite(req, res);
  if (pathname === '/api/stats' && req.method === 'GET') return trackStats(req, res, url);
  // 自托管版不提供 /api/survey、/api/license、/api/auth（托管版能力，不在本仓）
  // 行情包独立限流（60 次/分、突发 10），不走下面 30 次/分的通用桶
  if (req.method === 'POST' && pathname === '/api/kline/token') return handleKlineToken(req, res, ip);
  if (req.method === 'GET' && pathname.startsWith('/api/kline/')) return handleKline(req, res, pathname, url, ip);
  // 内置回放票据（20 次/分），同样走独立桶
  if (req.method === 'GET' && pathname === '/api/builtin/ticket') return handleBuiltinTicket(req, res, ip);
  // 内置回放目录（code+name）：元信息 no-cache，本体走版本化 immutable 地址
  if (req.method === 'GET' && pathname === '/api/builtin/catalog') return handleBuiltinCatalogMeta(res);
  if (req.method === 'GET') {
    const vcat = BUILTIN_CATALOG_VERSIONED_RE.exec(pathname);
    if (vcat) return handleBuiltinCatalogPack(res, vcat);
  }
  if (rateLimited(ip)) return sendJson(res, 429, { ok: false, error: '请求太频繁，稍后再试' });

  if (pathname.startsWith('/api/pay/')) {
    return sendJson(res, 404, { ok: false, error: '本仓为自托管版，未提供支付' });
  }

  // 示例体验：读内置样例图，只跑一次 OCR 并缓存（不重复消耗识别额度）
  if (req.method === 'GET' && pathname === '/api/demo') {
    try {
      if (!DEMO_CACHE) {
        const buf = fs.readFileSync(DEMO_PATH);
        const { lines, backend, error, boxes } = await ocr.recognize(buf, CFG);
        if (error && !lines.length) return sendJson(res, 503, { ok: false, error: '示例暂不可用，请稍后再试' });
        const { trades, meta } = parse(lines);
        if (!trades.length) return sendJson(res, 503, { ok: false, error: '示例数据异常' });
        // boxes 与 /api/ocr 同一格式（collectBoxes 已归一化 nx/ny/nw/nh），
        // 否则示例报告的原图定位只能降级成「打开原图 · partial」
        DEMO_CACHE = { trades, meta, mode: backend, boxes: boxes || null };
      }
      return sendJson(res, 200, {
        ok: true, demo: true, trades: DEMO_CACHE.trades, meta: DEMO_CACHE.meta, mode: DEMO_CACHE.mode,
        boxes: DEMO_CACHE.boxes || null,
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: '示例加载失败' });
    }
  }

  // 规则模板元数据（前端渲染配置页的唯一来源，避免前后端两份定义漂移）
  if (req.method === 'GET' && pathname === '/api/rules') {
    return sendJson(res, 200, { ok: true, templates: TEMPLATES, defaults: DEFAULT_CONFIG });
  }

  if (req.method === 'GET' && pathname === '/api/ping') {
    const provider = CFG.OCR_MODE === 'mock' ? 'mock' : ocr.resolveProvider(CFG);
    // P0-1：只报布尔，便于运维判断"配没配"；绝不回显任何密钥值。
    return sendJson(res, 200, {
      ok: true, service: '管住手了吗 H5 W1',
      ocr_backend: provider, ocr_provider: CFG.OCR_PROVIDER, mode: CFG.OCR_MODE,
      production: process.env.NODE_ENV === 'production',
      keys_configured: {
        textin: !!(CFG.TEXTIN_APP_ID && CFG.TEXTIN_SECRET_CODE),
        baidu: !!(CFG.BAIDU_OCR_API_KEY && CFG.BAIDU_OCR_SECRET_KEY),
        tencent: !!(CFG.TENCENT_SECRET_ID && CFG.TENCENT_SECRET_KEY),
        local: !!CFG.LOCAL_OCR_URL,
        judge: !!(CFG.ZHIPU_API_KEY || CFG.DASHSCOPE_API_KEY || CFG.DEEPSEEK_API_KEY),
        stats: !!CFG.STATS_KEY,
      },
    });
  }

  if (req.method === 'POST' && pathname === '/api/ocr') {
    const t0 = Date.now();
    try {
      const body = await readBody(req, 12 * 1024 * 1024);
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: '请求格式错误' }); }
      if (!payload.image_base64 || typeof payload.image_base64 !== 'string') {
        return sendJson(res, 400, { ok: false, error: '缺少图片数据' });
      }
      const buf = Buffer.from(payload.image_base64, 'base64');
      if (buf.length < 1024) return sendJson(res, 400, { ok: false, error: '图片太小或无效' });
      if (buf.length > 8 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: '图片超过8MB，请换清晰度合适的截图' });
      const kind = sniffImage(buf);
      if (!kind) return sendJson(res, 400, { ok: false, error: '仅支持 JPG/PNG/WebP 截图' });

      const ocrResult = await ocr.recognize(buf, CFG);
      const { lines, backend, error, reason } = ocrResult;
      // 生产模式TextIn失败（重试后仍429/5xx）→ 显式报错让用户重试，不给空结果
      // P0-1：生产未配 OCR key → 503 + reason=ocr_not_configured，绝不返回演示数据
      if (error && !lines.length) {
        logRun({ route: 'ocr', ip: hashIp(ip), backend, err: String(error), reason: reason || null });
        const out = { ok: false, error: reason === 'ocr_not_configured' ? '识别服务未配置，请联系管理员' : '识别服务繁忙，请稍后重试' };
        if (reason) out.reason = reason;
        return sendJson(res, 503, out);
      }
      const { trades, meta } = parse(lines);
      const ms = Date.now() - t0;
      logRun({ route: 'ocr', ip: hashIp(ip), backend, ms, img_kb: Math.round(buf.length / 1024), trades: meta.trade_count, needs_fix: meta.needs_fix_count, err: error || null });
      return sendJson(res, 200, {
        ok: true, mode: backend, trades, meta, elapsed_ms: ms,
        boxes: ocrResult.boxes || null,   // 批次 D 原图定位用；现在 ocr.js 不返回则为 null
      });
    } catch (e) {
      logRun({ route: 'ocr', ip: hashIp(ip), err: String(e.message || e) });
      return sendJson(res, 500, { ok: false, error: '识别失败：' + (e.message || '服务异常') });
    }
  }

  if (req.method === 'POST' && pathname === '/api/confirm') {
    // 确认+判定一体化（W2）：复核数据验证通过后直接在本请求内完成纪律判定。
    // 单往返设计——20261020浏览器实测：confirm后紧连的第二个fetch会被吞（未达服务端），
    // 合并后消灭该环节；judge熔断（45s）保证本请求必然返回。
    const t0 = Date.now();
    try {
      const body = await readBody(req, 4 * 1024 * 1024);
      const payload = JSON.parse(body.toString('utf8'));
      const trades = Array.isArray(payload.trades) ? payload.trades : null;
      if (!trades || !trades.length) return sendJson(res, 400, { ok: false, error: '没有可确认的记录' });
      if (trades.length > 200) return sendJson(res, 400, { ok: false, error: '单次最多200笔' });
      const bad = trades.some(t => !t || typeof t !== 'object' || !['买', '卖'].includes(t.side) || !t.name || !(+t.qty > 0) || !isFinite(+t.price) || +t.price <= 0);
      if (bad) return sendJson(res, 400, { ok: false, error: '存在非法记录（方向须为买/卖，名称/价格/数量必填）' });
      const norm = trades.map(t => ({
        date: t.date || '', time: t.time || '', code: t.code || '', name: t.name,
        side: t.side, price: +t.price, qty: +t.qty,
        // 批次 E-23：多账户透传，rules.js 用它分组、recur 用它生成 tk6
        account: String(t.account || '').replace(/\|/g, '').slice(0, 16),
      }));
      const caseNo = typeof payload.case_no === 'string' ? payload.case_no.slice(0, 20) : '';
      const { config, tooBig } = pickConfig(payload);
      if (tooBig) return sendJson(res, 400, { ok: false, error: '规则配置过大' });
      const payCheck = await authorizeReport(PAY_CFG, {
        outTradeNo: typeof payload.order_no === 'string' ? payload.order_no : '',
        clientToken: req.headers['x-client-token'],
        caseNo,
      });
      if (!payCheck.ok) {
        logRun({ route: 'confirm_judge', ip: hashIp(ip), reason: 'pay_required', detail: payCheck.error });
        return sendJson(res, payCheck.code, { ok: false, error: payCheck.error, pay_required: PAY_CFG.required });
      }
      const { verdict, mode, model, lost, error } = await judge(norm, caseNo, CFG, config);
      if (payCheck.order) await markConsumed(payCheck.order.outTradeNo, caseNo);
      const ms = Date.now() - t0;
      logRun({ route: 'confirm_judge', ip: hashIp(ip), mode, model: model || null, lost: lost || [], ms, trades: norm.length, rules: (config.rules || []).length, violations: verdict.summary.violations, day_violations: verdict.summary.day_violations, suspects: verdict.summary.suspects, usage: verdict.ai_usage || null, err: error || null });
      return sendJson(res, 200, { ok: true, received: norm.length, mode, verdict, ts: new Date().toISOString() });
    } catch (e) {
      logRun({ route: 'confirm_judge', ip: hashIp(ip), err: String(e.message || e) });
      return sendJson(res, 500, { ok: false, error: '判定失败：' + (e.message || '服务异常') });
    }
  }

  if (req.method === 'POST' && pathname === '/api/judge') {
    // W2判定引擎：消费复核确认后的数据，产出纪律复盘判定（合规/违规/存疑）
    const t0 = Date.now();
    try {
      const body = await readBody(req, 4 * 1024 * 1024);
      const payload = JSON.parse(body.toString('utf8'));
      const trades = Array.isArray(payload.trades) ? payload.trades : null;
      if (!trades || !trades.length) return sendJson(res, 400, { ok: false, error: '没有可判定的记录' });
      if (trades.length > 200) return sendJson(res, 400, { ok: false, error: '单次最多200笔' });
      const bad = trades.some(t => !t || typeof t !== 'object' || !['买', '卖'].includes(t.side) || !t.name || !(+t.qty > 0) || !isFinite(+t.price) || +t.price <= 0);
      if (bad) return sendJson(res, 400, { ok: false, error: '存在非法记录（方向须为买/卖，名称/价格/数量必填）' });
      const norm = trades.map(t => ({
        date: t.date || '', time: t.time || '', code: t.code || '', name: t.name,
        side: t.side, price: +t.price, qty: +t.qty,
        account: String(t.account || '').replace(/\|/g, '').slice(0, 16),
      }));
      const caseNo = typeof payload.case_no === 'string' ? payload.case_no.slice(0, 20) : '';
      const { config, tooBig } = pickConfig(payload);
      if (tooBig) return sendJson(res, 400, { ok: false, error: '规则配置过大' });
      const payCheck = await authorizeReport(PAY_CFG, {
        outTradeNo: typeof payload.order_no === 'string' ? payload.order_no : '',
        clientToken: req.headers['x-client-token'],
        caseNo,
      });
      if (!payCheck.ok) {
        logRun({ route: 'judge', ip: hashIp(ip), reason: 'pay_required', detail: payCheck.error });
        return sendJson(res, payCheck.code, { ok: false, error: payCheck.error, pay_required: PAY_CFG.required });
      }
      const { verdict, mode, model, lost, error } = await judge(norm, caseNo, CFG, config);
      if (payCheck.order) await markConsumed(payCheck.order.outTradeNo, caseNo);
      const ms = Date.now() - t0;
      logRun({ route: 'judge', ip: hashIp(ip), mode, model: model || null, lost: lost || [], ms, trades: norm.length, rules: (config.rules || []).length, violations: verdict.summary.violations, day_violations: verdict.summary.day_violations, suspects: verdict.summary.suspects, usage: verdict.ai_usage || null, err: error || null });
      return sendJson(res, 200, { ok: true, mode, verdict, elapsed_ms: ms });
    } catch (e) {
      logRun({ route: 'judge', ip: hashIp(ip), err: String(e.message || e) });
      return sendJson(res, 500, { ok: false, error: '判定失败：' + (e.message || '服务异常') });
    }
  }

  sendJson(res, 404, { ok: false, error: '接口不存在' });
}

// ---- 静态托管 ----
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEMO_PATH = path.join(PUBLIC_DIR, 'sample', 'demo_jiaogedan.jpg');
let DEMO_CACHE = null;

// 版本化分片路径：/builtin/pack/<version>/<sig>/<code>.<win>.json.gz
const BUILTIN_PACK_VERSIONED_RE = /^\/builtin\/pack\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{24})\/([0-9]{6})\.([A-Za-z0-9_-]{1,32})\.json\.gz$/;
// 版本化目录路径：/api/builtin/catalog/<version>/<sig>.json.gz
const BUILTIN_CATALOG_VERSIONED_RE = /^\/api\/builtin\/catalog\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{24})\.json\.gz$/;
// 当前内容版本（跟 index.json 的 version 同源）；按 mtime 缓存，索引换版本时自动跟着换
let builtinIndexMeta = { mtimeMs: -1, version: '', obj: null };
function builtinIndexMetaRead() {
  const p = path.join(PUBLIC_DIR, 'builtin', 'index.json');
  try {
    const st = fs.statSync(p);
    if (st.mtimeMs !== builtinIndexMeta.mtimeMs) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      builtinIndexMeta = { mtimeMs: st.mtimeMs, version: String((obj && obj.version) || ''), obj: obj };
    }
    return builtinIndexMeta;
  } catch (e) { return null; }
}

function serveStatic(req, res, pathname, url) {
  let rel = decodeURIComponent(pathname);
  // 行情包不再走静态直出：目录整体 404，真实数据只经 /api/kline 读取。
  if (rel === '/data/kline' || rel.startsWith('/data/kline/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('404');
  }
  // 新版长期签名分片：不带 60 秒票据，sig 只跟内容版本走，可一年 immutable。
  const vpack = BUILTIN_PACK_VERSIONED_RE.exec(rel);
  if (vpack) {
    const meta = builtinIndexMetaRead();
    // 版本必须等于当前索引版本，且 sig 必须是该版本的 HMAC 截断值
    if (!meta || !meta.version || vpack[1] !== meta.version
        || !builtinHexEqual(vpack[2], builtinVersionSig(vpack[1]))) {
      return builtinStaticGuard(res);
    }
    const vfile = path.normalize(path.join(PUBLIC_DIR, 'builtin', 'pack', vpack[3] + '.' + vpack[4] + '.json.gz'));
    if (!vfile.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    return fs.readFile(vfile, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end('404'); }
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(data);
    });
  }
  // 旧形态（/builtin/pack/<file>.json.gz?e=&s=）继续接受：60 秒票据，no-store。
  // 过渡期双向可用，老客户端不会被 403 打断；新版客户端命中本地缓存时不发请求。
  if (rel === '/builtin/index.json' || rel.startsWith('/builtin/pack/')) {
    if (!url || !builtinSigOk(url.searchParams.get('e'), url.searchParams.get('s'))) {
      return builtinStaticGuard(res);
    }
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    const ext = path.extname(file).toLowerCase();
    // 索引随票据下发长期签名的种子：前端拿到 packSig 才能拼出版本化分片地址。
    // index.json 本身仍 no-cache（版本会变，不能 immutable），每次打开回源校验。
    if (rel === '/builtin/index.json') {
      let body = data;
      try {
        const obj = JSON.parse(data.toString('utf8'));
        if (obj && obj.version) { obj.packSig = builtinVersionSig(obj.version); body = Buffer.from(JSON.stringify(obj)); }
      } catch (e) { body = data; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(body);
    }
    // K 线数据包是内容寻址的（文件名含月份、内容随 version 变），前端用 ?v= 换缓存键，可长期 immutable。
    // 索引类文件（index.json / _manifest）路径固定、每次发布会换内容，必须回源校验，不能 immutable。
    const isIndex = /\/(index\.json|_manifest\/[^/]+\.json\.gz)$/.test(rel);
    const immutable = !isIndex && (rel.startsWith('/data/kline/') || rel.startsWith('/data/tick/'));
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': isIndex ? 'no-cache' : (immutable ? 'public, max-age=31536000, immutable' : 'no-store'),
    });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    return res.end('Bad Request');
  }
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url);
    if (pathname === '/pay/return') return serveStatic(req, res, '/pay-return.html', url);
    return serveStatic(req, res, pathname, url);
  } catch (e) {
    logRun({ route: 'fatal', err: String(e.stack || e) });
    try { sendJson(res, 500, { ok: false, error: '服务异常' }); } catch {}
  }
}).listen(CFG.PORT, () => {
  const backend = (CFG.TEXTIN_APP_ID && CFG.TEXTIN_SECRET_CODE) ? 'TextIn真实' : 'Mock演示（未配密钥）';
  console.log(`[管住手了吗 W1] http://localhost:${CFG.PORT}  OCR后端: ${backend}  模式: ${CFG.OCR_MODE}`);
});
