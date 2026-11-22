// parser.js —— 交割单OCR文本 → 结构化成交记录（W1骨架核心）
// 设计口径（20261014拍板）：OCR采用"先识别→预填→用户人工复核修正"模式。
// 本解析器不追求100%正确——识别不出/可疑的字段置null并标低置信，
// 由用户在复核页补录。鲁棒性风险因此从阻塞项降级为非阻塞项。
//
// W1限制（已知，W2迭代）：
//  1) 单行一笔解析（多数券商交割单每笔成交占一行）；跨行折行的记录暂不支持
//  2) 价格/数量启发式：小数=价格、整数=数量、末位大数=成交金额，金额勾稽校验
//  3) 姓名/股东账号/资金账号行直接丢弃（数据最小化红线），只计数不留内容

'use strict';

// 需要丢弃的行（非成交记录）
const SCRUB_RE = /股东姓名|姓名|股东账号|股东账户|资金账号|资金账户|身份证|客户号|手机号/;
const SKIP_RE = /撤单|已撤|废单|银行|利息|规费|杂费|费率|合计|总计|提示|备注|打印|声明|营业部|币种|类型:|摘要/;

// 方向词（覆盖常见券商写法：证券买入/融资买入/担保品卖出等）
const SIDE_BUY_RE = /证券买入|担保品买入|融资买入|担保买入|买入|买进/;
const SIDE_SELL_RE = /证券卖出|担保品卖出|融券卖出|卖出/;

const DATE_RE = /(?:20\d{2}[-/／年.]\s?\d{1,2}[-/／月.]\s?\d{1,2}日?)|(?:^|[^0-9])(20\d{6})(?![0-9])/;
const TIME_RE = /(?:^|[^0-9])(\d{1,2}:\d{2}(?::\d{2})?)(?![0-9])/;
const CODE_RE = /(?:^|[^0-9A-Za-z])(\d{6})(?![0-9])/;

function pad(n) { return String(n).padStart(2, '0'); }

function normDate(s) {
  if (!s) return null;
  s = s.replace(/／/g, '/').replace(/[年月.]/g, '-').replace(/日/g, '').trim();
  const m8 = s.match(/(\d{4})-(\d{2})(\d{2})/); // 2026-1009 形态修正
  if (m8) return `${m8[1]}-${m8[2]}-${m8[3]}`;
  const p = s.split('-').map(x => x.trim());
  if (p.length === 3) return `${p[0]}-${pad(+p[1])}-${pad(+p[2])}`;
  return null;
}

function normTime(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const h = Math.min(23, +m[1]), mi = Math.min(59, +m[2]);
  const sec = m[3] ? `:${pad(Math.min(59, +m[3]))}` : '';
  return `${pad(h)}:${pad(mi)}${sec}`;
}

// 从"去掉日期/时间/方向/代码"后的剩余串里抠出 名称 + 数字序列
function extractNameAndNumbers(rest) {
  rest = rest.replace(/[，,、|]/g, ' ').trim();
  let name = '';
  const m = rest.match(/^([^\d.]+)/);
  if (m) name = m[1].trim();
  // 20261104：保留原文小数位信息——Number('16.000')===16，只按“是否整数”分类
  // 会把 16.000 误判成数量（经成交额反推成价格 100），导致 100 股被记成 16 股
  const tokens = (rest.match(/\d+(?:\.\d+)?/g) || []).map(s => ({
    v: Number(s), dec: (s.split('.')[1] || '').length,
  }));
  return { name, nums: tokens.map(t => t.v), decs: tokens.map(t => t.dec > 0) };
}

// 数字序列 → 价格/数量/金额 启发式（decs: 与 nums 等长的“原文带小数点”标记）
function classifyNums(nums, decs) {
  const out = { price: null, qty: null, amount: null, low_price: false, low_qty: false, mismatch: false };
  const isDec = (n, i) => (decs ? !!decs[i] : (!Number.isInteger(n) || String(n).includes('.')));
  const dec = nums.filter((n, i) => isDec(n, i));
  const ints = nums.filter((n, i) => !isDec(n, i));
  if (dec.length >= 2) {
    out.price = dec[0];
    out.amount = dec[dec.length - 1];
    if (ints.length) out.qty = ints[0];
  } else if (dec.length === 1) {
    const d = dec[0];
    if (!ints.length) {
      // 只有一个小数：太像金额（>=1000）按金额处理，价格待补
      if (d >= 1000) { out.amount = d; out.low_price = true; out.low_qty = true; }
      else { out.price = d; out.low_qty = true; }
    } else if (d >= 1000) {
      out.amount = d; out.qty = ints[0]; out.low_price = true;
    } else {
      out.price = d; out.qty = ints[0];
      if (ints.length > 1) out.amount = ints[ints.length - 1];
    }
  } else if (ints.length === 1) {
    out.qty = ints[0]; out.low_price = true;
  } else if (ints.length >= 2) {
    out.qty = ints[0]; out.amount = ints[ints.length - 1]; out.low_price = true;
  } else {
    out.low_price = true; out.low_qty = true;
  }
  // 合理性校验
  if (out.price != null && (out.price <= 0 || out.price > 9999.99)) {
    // A股价格不可能五位数以上——多半是把金额认成了价格
    out.amount = out.amount == null ? out.price : out.amount;
    out.price = null; out.low_price = true;
  }
  if (out.qty != null && (out.qty <= 0 || out.qty > 1e7)) { out.low_qty = true; }
  if (out.price != null && out.qty != null && out.amount != null) {
    const exp = out.price * out.qty;
    if (Math.abs(exp - out.amount) > Math.max(1, exp * 0.01)) {
      out.mismatch = true; out.low_price = true; out.low_qty = true;
    }
  }
  return out;
}

function parseLine(line, ctx) {
  if (!line) return null;
  const raw = line.trim();
  if (raw.length < 4) return null;

  // 敏感信息行：直接丢弃，只计数（数据最小化红线）
  if (SCRUB_RE.test(raw)) { ctx.scrubbed++; return null; }

  // 日期上下文：优先于跳过逻辑——表头行（如"成交日期: 20261009 币种:人民币"）
  // 常被SKIP_RE跳过，但其中的日期必须更新上下文，供后续无日期行继承
  let lineDate = null;
  const d0 = raw.match(DATE_RE);
  if (d0) {
    lineDate = d0[1]
      ? `${d0[1].slice(0, 4)}-${d0[1].slice(4, 6)}-${d0[1].slice(6, 8)}`
      : normDate(d0[0].trim());
    if (lineDate) { ctx.date = lineDate; ctx.datePart = null; }
  }
  // 只有 月-日：不在这里补年份（避免用服务端时区猜跨年），只把原文交给前端推断
  let lineDatePart = null;
  if (!lineDate) {
    lineDatePart = extractDatePart(raw);
    if (lineDatePart) ctx.datePart = lineDatePart;
  }

  if (SKIP_RE.test(raw)) return null;

  const sideBuy = SIDE_BUY_RE.test(raw);
  const sideSell = SIDE_SELL_RE.test(raw);
  if (!sideBuy && !sideSell) return null; // 没有方向词=不是成交行

  let work = raw;
  const consume = (re) => { const m = work.match(re); if (m) work = work.replace(m[0], ' '); return m; };

  // 1) 日期：本行有则用本行（已在上面提取并更新上下文），无则继承最近日期
  consume(DATE_RE);
  const date = lineDate || ctx.date || null;
  const datePart = (lineDate || !ctx.datePart) ? null : ctx.datePart;

  // 2) 时间
  const tm = consume(TIME_RE);
  const time = tm ? normTime(tm[1]) : null;

  // 3) 方向（先试买入，"证券买入"含"买入"，删掉即可；注意别把"卖出"里的"买"误伤——买入词不含单字买）
  let side = null;
  if (sideBuy) { side = '买'; work = work.replace(/(证券买入|担保品买入|融资买入|担保买入|买入|买进)/, ' '); }
  else { side = '卖'; work = work.replace(/(证券卖出|担保品卖出|融券卖出|卖出)/, ' '); }

  // 4) 证券代码
  const cm = consume(CODE_RE);
  const code = cm ? cm[1] : null;

  // 5) 名称 + 数字
  const { name, nums, decs } = extractNameAndNumbers(work);
  const cls = classifyNums(nums, decs);

  const trade = {
    date, datePart, time, code, name: name || null,
    side, price: cls.price, qty: cls.qty, amount: cls.amount,
    low: {
      price: cls.low_price, qty: cls.low_qty,
      time: !time, date: !date,
      code: !code, name: !name,
      mismatch: cls.mismatch,
    },
  };
  trade.needs_fix = trade.low.price || trade.low.qty || trade.low.time ||
    trade.low.date || !trade.name || !trade.code;
  return trade;
}

// 整批都没有成交时间：截图本身不含时间列（同花顺"历史成交"明细卡片等），
// 不是识别失败——不标黄、不阻塞确认；时间类规则由 judge 在 config_warnings 里声明跳过。
function finalizeTrades(trades) {
  if (!trades.length || trades.some(t => t.time)) return false;
  for (const t of trades) {
    t.low.time = false;
    t.needs_fix = !!(t.low.price || t.low.qty || t.low.date || t.low.code || !t.name);
  }
  return true;
}

// ---------- 光大证券「对账单」版式（20261028实测）----------
// 形态：一笔占两行，字段上下错位——
//   证券买入-百花医药 / 12.140 / -3,642.54 / 买09-02 09:41 / 300 / 0.54
// 第一行是「方向-名称」，随后价格、金额，锚点行含方向+月日+时间，再下一行数量、末行费用。
// 识别本身没问题（TextIn 逐行读得很干净），是旧解析器按「一行一笔」读不出来。
const GD_NAME_RE = /^证券(买入|卖出)[-－—·]?\s*(.+)$/;
const GD_ANCHOR_RE = /^([买卖])\s*(\d{2})\s*[-/]\s*(\d{2})\s+(\d{1,2})[：:](\d{2})(?:[：:](\d{2}))?$/;

function isGuangdaMode(lines) {
  let names = 0, anchors = 0;
  for (const raw of lines) {
    const l = String(raw).trim();
    if (GD_NAME_RE.test(l)) names++;
    if (GD_ANCHOR_RE.test(l)) anchors++;
  }
  return names >= 2 && anchors >= 2;
}

function parseGuangda(lines) {
  const all = lines.map(l => String(l).trim());
  let year = null;
  for (const l of all) {
    const m = l.match(/(20\d{2})[-/年.]?\d{1,2}/);
    if (m) { year = m[1]; break; }
  }
  if (!year) year = String(new Date().getFullYear());

  const cooked = [];
  for (let i = 0; i < all.length; i++) {
    const nm = all[i].match(GD_NAME_RE);
    if (!nm) continue;
    const side = nm[1] === '买入' ? '证券买入' : '证券卖出';
    const name = nm[2].replace(/^[-－—·\s]+/, '').trim();
    if (!name) continue;

    const nums = [];
    let anchor = null;
    for (let j = i + 1; j < all.length && j <= i + 8; j++) {
      const s = all[j];
      if (GD_NAME_RE.test(s)) break;
      const am = s.match(GD_ANCHOR_RE);
      if (am) {
        anchor = { side: am[1] === '买' ? '买入' : '卖出', mm: am[2], dd: am[3], hh: am[4], mi: am[5], ss: am[6] || '' };
        continue;
      }
      if (/^-?[\d,]+(?:\.\d+)?$/.test(s)) nums.push(s);
      else if (GROUP_END_RE.test(s)) break;
    }
    if (!anchor) continue;

    const rows = nums.map((s) => {
      const clean = s.replace(/,/g, '');
      const dec = (clean.split('.')[1] || '').length;
      return { v: Math.abs(+clean), dec };
    }).filter(x => isFinite(x.v) && x.v > 0);
    const price = rows.find(x => x.dec >= 3) || rows.find(x => x.dec > 0 && x.v < 1000);
    const qty = rows.find(x => x.dec === 0);
    const amount = rows.filter(x => x !== price && x !== qty).sort((a, b) => b.v - a.v)[0];

    const date = `${year}-${anchor.mm}-${anchor.dd}`;
    const time = `${pad(+anchor.hh)}:${pad(+anchor.mi)}${anchor.ss ? ':' + pad(+anchor.ss) : ''}`;
    const parts = [date, time, side, name];
    if (price) parts.push(price.v);
    if (qty) parts.push(qty.v);
    if (amount) parts.push(amount.v);
    cooked.push(parts.join(' '));
  }

  const ctx = { date: null, scrubbed: 0 };
  const trades = [];
  for (const line of cooked) {
    const t = parseLine(line, ctx);
    if (!t) continue;
    // 光大对账单没有证券代码列（非识别失败）——代码降级为选填
    t.low.code = false;
    t.needs_fix = t.low.price || t.low.qty || t.low.time || t.low.date || !t.name;
    trades.push(t);
  }
  return trades;
}

// ===== 同花顺 PC「历史成交」横表（20261114 实测）=====
// 列序：成交日期 成交时间 证券代码 证券名称 成交均价 成交金额 合同编号 成交编号
//       手续费 印花税 其他杂费 发生金额 交易市场 市场名称
// 该表没有「方向」列也没有「数量」列：
//   方向 ← 发生金额正负（负=买入、正=卖出；为 0 或缺失时置空，不默认成买入）
//   数量 ← 成交金额 ÷ 成交均价（必须是正整数；除不尽就置空标黄，不做四舍五入）
// 百度 general_basic 无坐标且会把相邻单元格并成一段（「鲁阳节能9.280」「928.0009479」），
// 所以按「8 位日期行起、汇总行止」分组，再按语义把数字归位到 价/额/费用/发生金额。
const THS_PC_HEADERS = ['成交日期', '成交时间', '证券代码', '证券名称', '发生金额', '交易市场', '市场名称'];
const THS_ROW_START = /^(20\d{6})(\d{1,2}:\d{2}:\d{2})?$/;
// TextIn 会为每个单元格单独出一行，左侧导航菜单偶尔会插进某笔的中间（与表格行同一水平线）。
// 这些词只可能是侧栏/市场名，绝不是证券名称——不拉黑会把「历史成交」当股票名（20261115 线上实测）。
const THS_NAV = new Set([
  '买', '卖', '买入', '卖出', '当日', '近一周', '近一月', '近三月', '近一年', '自定义', '过滤', '汇总',
  '撤单', '自选股', '条件单', '查询', '资金股票', '目资金股票', '当日成交', '当日委托', '历史成交',
  '历史持仓', '历史委托', '资金明细', '交割单', '日交割单', '未到期回购', '新股申购列表查询',
  'E新股申购列表查询', '客户股东席位信息', '账户分析', 'HOT', '不', '仙', '深圳人', '北交所交易',
  '股票', '信用', '港股通', '信用｜港股通', '深圳A股', '上海A股', '北京A股', '港股', '美股',
]);
function isThsNoise(s) {
  return THS_NAV.has(s) || s.indexOf('申购列表查询') >= 0;
}

function isThsPcMode(lines) {
  const head = lines.slice(0, 40).map(s => String(s).replace(/\s+/g, '')).join(' ');
  const hit = THS_PC_HEADERS.filter(h => head.indexOf(h) >= 0).length;
  if (hit < 6) return false;
  let rows = 0;
  for (const l of lines) if (THS_ROW_START.test(String(l).replace(/\s+/g, ''))) rows++;
  return rows >= 2;
}

// 从一段文本里取数：价+额+合同编号 可能被 OCR 并成一段
function pushThsNums(s, out) {
  if (/^\d+\.(\.|…)/.test(s) || s.indexOf('…') >= 0) return; // 成交编号被界面截断
  if (/^0{3,}$/.test(s)) { out.push(0); return; }             // TextIn 把 0.000 读成 0000（20261115 线上实测）
  const p3 = s.match(/^(\d+\.\d{3})(\d+\.\d{3})(\d+)$/);      // 价 + 额 + 合同号
  if (p3) { out.push(+p3[1], +p3[2]); return; }
  const p2 = s.match(/^(\d+\.\d{3})(\d+)$/);                   // 额 + 合同号
  if (p2) { out.push(+p2[1]); return; }
  if (/^-?\d+\.\d+$/.test(s)) out.push(+s);
}

function buildThsTrade(group) {
  const m = group[0].match(THS_ROW_START);
  if (!m) return null;
  const date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
  let time = m[2] || null, code = null, name = null;
  const nums = [];
  for (let i = 1; i < group.length; i++) {
    let s = group[i];
    if (!time && /^\d{1,2}:\d{2}:\d{2}$/.test(s)) { time = s; continue; }
    s = s.replace(/(SH|SZ|sh|sz)$/, '');
    const nm = s.match(/^([\u4e00-\u9fa5A-Za-z*·]{2,})(\d[\d.]*)$/); // 名称并着数字
    if (nm) {
      if (!name && !isThsNoise(nm[1])) name = nm[1];
      pushThsNums(nm[2], nums);
      continue;
    }
    if (/^[\u4e00-\u9fa5A-Za-z*·]+$/.test(s)) {
      // TextIn 的单元格顺序会变（名称可能排在代码前），所以不要求先有代码；
      // 靠侧栏/市场名黑名单排除噪声——不能按「股」字结尾排除，荣丰控股就会误伤
      if (!name && !isThsNoise(s)) name = s;
      continue;
    }
    if (/^\d{6}$/.test(s)) { if (!code) code = s; continue; }
    pushThsNums(s, nums);
  }
  // 归位顺序：[成交均价, 成交金额, 手续费, 印花税, 其他杂费, 发生金额]
  const ok = nums.length === 6;
  const price = ok ? nums[0] : null;
  const amount = ok ? nums[1] : null;
  const fee = ok ? nums[2] + nums[3] + nums[4] : 0;
  const occ = ok ? nums[5] : null;
  // 方向不用猜：发生金额与「成交金额 ± 费用」精确对账，哪种方向能对上就是哪种。
  // 百度 OCR 偶尔会丢掉负号，所以正号也允许用「金额+费用」的绝对值反推。
  let side = null, mismatch = false;
  if (ok) {
    const expBuy = -(amount + fee), expSell = amount - fee;
    const near = (a, b) => Math.abs(a - b) <= 0.05;
    if (near(occ, expBuy)) side = '买';
    else if (near(occ, expSell)) side = '卖';
    else if (near(occ, -expBuy)) side = '买';   // OCR 丢负号
    else if (near(occ, -expSell)) side = '卖';
    else { side = occ < 0 ? '买' : occ > 0 ? '卖' : null; mismatch = true; }
  }
  let qty = null, lowQty = !ok;
  if (price > 0 && amount > 0) {
    const q = amount / price;
    if (q >= 1 && Math.abs(q - Math.round(q)) < 1e-6) {
      qty = Math.round(q);
      if (qty % 100 !== 0) lowQty = true; // 非 100 股整数倍：保留数值但标出来
    } else lowQty = true;                 // 除不尽：不猜，置空
  }
  return {
    date,
    datePart: null,
    time,
    code,
    name: name || null,
    side,
    price,
    qty,
    amount,
    low: { price: !(price > 0), qty: !(qty > 0) || lowQty, time: !time, date: false, code: !code, name: !name, mismatch },
    needs_fix: !name || !(price > 0) || !(qty > 0) || !side || mismatch || lowQty,
  };
}

function parseThsPc(lines) {
  const arr = lines.map(l => String(l).replace(/\s+/g, '').trim()).filter(Boolean);
  const trades = [];
  let group = null, started = false;
  const flush = () => { if (group) { const t = buildThsTrade(group); if (t) trades.push(t); group = null; } };
  for (const l of arr) {
    if (THS_ROW_START.test(l)) { flush(); started = true; group = [l]; continue; }
    if (!started) continue;
    if (/^(汇总|合计|总计)/.test(l)) { flush(); break; }
    if (group && group.length < 24) group.push(l);
  }
  flush();
  return trades;
}

function parse(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  // 同花顺 PC「历史成交」横表：无方向列/数量列，版式特征足够独特，最先判
  if (isThsPcMode(arr)) {
    const trades = parseThsPc(arr);
    const timeMissing = finalizeTrades(trades);
    return {
      trades,
      meta: {
        trade_count: trades.length,
        needs_fix_count: trades.filter(t => t.needs_fix).length,
        skipped_lines: 0,
        scrubbed_lines: arr.filter(l => SCRUB_RE.test(String(l))).length,
        time_missing: timeMissing,
        date_missing: trades.length > 0 && trades.every(t => !t.date),
        layout: 'ths_pc',
      },
    };
  }
  // 光大对账单：一笔两行、上下错位的字段版式，优先于其他模式
  if (isGuangdaMode(arr)) {
    const trades = parseGuangda(arr);
    const timeMissing = finalizeTrades(trades);
    return {
      trades,
      meta: {
        trade_count: trades.length,
        needs_fix_count: trades.filter(t => t.needs_fix).length,
        skipped_lines: arr.length - trades.length,
        scrubbed_lines: arr.filter(l => SCRUB_RE.test(String(l))).length,
        time_missing: timeMissing,
        date_missing: trades.length > 0 && trades.every(t => !t.date),
        layout: 'guangda', // 版式标签：批次 C 用来记住上次版式，不影响解析
      },
    };
  }
  // 真实OCR三种形态分流（20261020实测）：
  // ①券商APP卡片式成交列表（东海证券）：锚点行"买 20261019 10：14：50"触发重组
  // ②TextIn表格逐单元格竖排：孤立时间行触发重组
  // ③横排一行一笔：直通
  let input = arr, cardMode = false, layout = 'horizontal';
  if (isCardMode(arr)) { input = regroupCard(arr); cardMode = true; layout = 'card'; }
  else if (isSideCellMode(arr)) {
    // 20261022新增：中邮证券等逐单元格输出，字段行顺序不固定（时间可能在方向词之前/之后）
    const trades = parseSideCells(arr) || [];
    const timeMissing = finalizeTrades(trades);
    return {
      trades,
      meta: {
        trade_count: trades.length,
        needs_fix_count: trades.filter(t => t.needs_fix).length,
        skipped_lines: 0,
        scrubbed_lines: arr.filter(l => SCRUB_RE.test(String(l))).length,
        time_missing: timeMissing,
        date_missing: trades.length > 0 && trades.every(t => !t.date),
        layout: 'side_cells',
      },
    };
  }
  else if (isVerticalMode(arr)) { input = regroupVertical(arr); layout = 'vertical'; }
  const ctx = { date: null, scrubbed: 0 };
  const trades = [];
  const seen = new Set(); // 结构级去重：OCR返回多套重复编码时同一笔只留一次（20261020实测TextIn tables/areas重复）
  let skipped = 0;
  for (const line of input) {
    const t = parseLine(line, ctx);
    if (!t) { skipped++; continue; }
    const k = [t.date, t.time, t.side, t.code, t.name, t.price, t.qty].join('|');
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    trades.push(t);
  }
  // 卡片式APP视图本身没有证券代码列（非识别失败）——代码降级为选填，不标低置信
  if (cardMode) {
    for (const t of trades) {
      t.low.code = false;
      t.needs_fix = t.low.price || t.low.qty || t.low.time || t.low.date || !t.name;
    }
  }
  const timeMissing = finalizeTrades(trades);
  return {
    trades,
    meta: {
      trade_count: trades.length,
      needs_fix_count: trades.filter(t => t.needs_fix).length,
      skipped_lines: skipped,
      scrubbed_lines: ctx.scrubbed, // 姓名/账号等敏感行丢弃数
      time_missing: timeMissing,
      date_missing: trades.length > 0 && trades.every(t => !t.date),
      layout,
    },
  };
}

// ---------- 卡片式APP成交列表（东海证券等）----------
// 形态（20261020东海实测）：每笔= 名称行/方向词行/价格行/数量行/锚点行/金额行，
// 锚点行形如 "买 20261019 10：14：50"（方向+日期+全角冒号时间），无证券代码列。
// 重组策略：锚点行触发，向前收字段（名称/价格/数量），向后收金额，拼成标准横排行。
const ANCHOR_RE = /^\s*([买卖])\s*(\d{8})\s+(\d{1,2}[：:]\d{2}(?:[：:]\d{2})?)/;
const CN_NAME_RE = /^[\u4e00-\u9fa5A-Za-z·*]+$/;

function isCardMode(lines) {
  let n = 0;
  for (const l of lines) if (ANCHOR_RE.test(String(l).trim())) n++;
  return n >= 2;
}

function regroupCard(lines) {
  const out = [];
  let buf = []; // 锚点之间的待归属字段行
  const sideWords = new Set(['买入', '卖出', '证券买入', '证券卖出', '买', '卖', '撤单', '证券撤单']);
  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i]).trim();
    const m = l.match(ANCHOR_RE);
    if (!m) { buf.push(l); continue; }
    // 锚点：方向+日期+时间
    const side = m[1] === '买' ? '证券买入' : '证券卖出';
    const d = m[2];
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const time = m[3].replace(/：/g, ':');
    // 向前收字段：价格=最后一个小数；数量=最后一个整数（取末位最贴近锚点行，
    // 防状态栏电量等杂散数字抢位——20261020东海实测电量"83"被误当数量）；
    // 名称=最后一个中文行（表头杂词在前，倒扫最稳）
    let name = null, price = null, qty = null;
    for (const b of buf) {
      if (/^\d+\.\d+$/.test(b)) price = b;
      else if (/^\d+$/.test(b)) qty = b;
    }
    for (let j = buf.length - 1; j >= 0; j--) {
      const b = buf[j];
      if (CN_NAME_RE.test(b) && !sideWords.has(b) && b.length >= 2) { name = b; break; }
    }
    buf = [];
    // 向后收金额：紧跟的纯数字行
    let amount = null;
    if (i + 1 < lines.length && /^\d+(?:\.\d+)?$/.test(String(lines[i + 1]).trim())) {
      amount = String(lines[i + 1]).trim();
      i++;
    }
    const parts = [date, time, side];
    if (name) parts.push(name);
    if (price !== null) parts.push(price);
    if (qty !== null) parts.push(qty);
    if (amount !== null) parts.push(amount);
    out.push(parts.join(' '));
  }
  return out;
}

// ---------- 竖排模式（逐单元格输出）检测与重组 ----------
// 模式特征：出现≥3条"孤立时间行"（整行只有时间）——横排时时间永远与其他字段同行
const ISO_TIME_LINE_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
const HEADER_WORD_RE = /^(成交时间|成交日期|业务名称|业务类型|业务方向|操作|操作方向|委托方向|买卖方向|证券代码|证券名称|证券简称|成交价格|成交数量|成交数|成交|成交金额|发生金额|发生数量|备注|订单号|合同编号)$/;
const SIDE_LINE_RE = /^(证券买入|证券卖出|担保品买入|担保品卖出|融资买入|融券卖出|证券撤单|撤单|买入|卖出)$/;
const CODE_LINE_RE = /^[0-9]{6}$/;
const NUM_LINE_RE = /^\d+(?:\.\d+)?$/;
const GROUP_END_RE = /合计|小计|印花税|过户费|手续费|佣金|规费|杂费|利息|声明|打印|提示|备注:|本样例|演示/;

function isVerticalMode(lines) {
  let isoTimes = 0;
  for (const l of lines) if (ISO_TIME_LINE_RE.test(String(l).trim())) isoTimes++;
  return isoTimes >= 3;
}

// 时间锚点重组法：孤立时间行开一条新记录，收集到下一时间行/终止词为止。
// 缺格（如某笔没识别出价格）自然兼容——组内按特征归位，不依赖固定列数。
function regroupVertical(lines) {
  const out = [];
  let cur = null; // { time, side, parts:[] }
  const flush = () => {
    if (!cur) return;
    const c = cur; cur = null;
    if (!c.side || /撤/.test(c.side)) return; // 无方向或撤单/废单：整组丢弃
    let code = null, name = null;
    const nums = [];
    for (const p of c.parts) {
      if (!code && CODE_LINE_RE.test(p)) code = p;
      else if (NUM_LINE_RE.test(p)) nums.push(p);
      else if (!name) name = p;
    }
    const parts = [c.time, c.side];
    if (code) parts.push(code);
    if (name) parts.push(name);
    parts.push(...nums);
    out.push(parts.join(' '));
  };
  for (const raw of lines) {
    const l = String(raw).trim();
    if (!l) continue;
    if (HEADER_WORD_RE.test(l)) continue; // 表头词丢弃
    if (ISO_TIME_LINE_RE.test(l)) { flush(); cur = { time: l, side: null, parts: [] }; continue; }
    if (cur && !cur.side && SIDE_LINE_RE.test(l)) { cur.side = l; continue; }
    if (cur && cur.side && !GROUP_END_RE.test(l)) { cur.parts.push(l); continue; }
    // 组外行 / 终止词：结束当前组并透传（日期行/敏感行/合计行交回主解析层处理）
    flush();
    out.push(l);
  }
  flush();
  return out;
}

// ---------- 方向词锚定重组（20261022 中邮证券实测新增）----------
// 形态：TextIn 逐单元格输出，但字段顺序不固定——
//   样本A（历史成交）：名称 → 方向 → 价格 → 数量 → 时间 → 金额
//   样本B（委托成交）：名称 → 价格 → 方向 → 时间 → 数量 → 金额
//   样本C（明细卡片）：名称 → 代码 → 方向 → 成交日期/金额/价格/数量 四组标签值
// 旧时间锚定法默认“时间总在每笔开头”，遇到样本A/B会把整笔字段甩到组外→0笔。
// 新策略：方向词每笔恰好一个（天然分隔），按“行到方向词的最短距离”归属字段，
// 再用标签字段或“价格×数量≈金额”求解三项数字，不依赖列顺序。
const SIDE_CELL_RE = /^(证券买入|证券卖出|担保品买入|担保品卖出|融资买入|融券卖出|证券撤单|撤单|买入|卖出|买|卖)$/;
const DATE_ONLY_RE = /^\s*20\d{2}\s*[-/／年.]\s*\d{1,2}\s*[-/／月.]\s*\d{1,2}\s*日?\s*$/;
const LABEL_ONLY_RE = /^(成交日期|委托日期|日期|成交金额|成交额|发生金额|金额|成交价格|成交价|委托价格|价格|成交数量|成交量|发生数量|数量)\s*[:：]?$/;
const CELL_STOP_RE = /历史成交|委托成交|当日委托|当日成交|历史委托|起始日期|截止日期|查询|全部|明细|汇总|近一周|近一月|自定义|证券名称|成交时间|成交价|成交量|成交金额|成交价格|成交数量|业务标志|业务／金额|业务\/金额|成交额|类型|状态|方向/;
const CELL_SKIP_RE = /港股通|组合费|收取|利息|印花税|过户费|手续费|佣金|规费|杂费|合计|小计|声明|打印/;

const isIntLike = v => Number.isInteger(v) || Math.abs(v - Math.round(v)) < 1e-6;

function isNameLike(s) {
  return /^[\u4e00-\u9fa5A-Za-z·*]{2,10}$/.test(s) && !CELL_STOP_RE.test(s) && !SIDE_CELL_RE.test(s);
}

function extractDateStr(s) {
  if (!s) return null;
  const m = String(s).match(/(20\d{2})\s*[-/／年.]\s*(\d{1,2})\s*[-/／月.]\s*(\d{1,2})\s*日?/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  const m8 = String(s).match(/(?:^|[^0-9])(20\d{6})(?![0-9])/);
  if (m8) return `${m8[1].slice(0, 4)}-${m8[1].slice(4, 6)}-${m8[1].slice(6, 8)}`;
  return null;
}

// 只有 月-日（如 "11-02" / "日期 11-02"）；完整日期交给 extractDateStr
function extractDatePart(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (extractDateStr(t)) return null;
  const m = t.match(/(?:^|\s)(\d{1,2})\s*[-/／]\s*(\d{1,2})(?![0-9])/);
  if (!m) return null;
  const mo = +m[1], da = +m[2];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${pad(mo)}-${pad(da)}`;
}

// 交易时段过滤：9:00–16:00（排除状态栏时钟 8:45、港股通 17:00 等）
function extractTimeStr(s) {
  const m = String(s).match(/(?:^|[^0-9])(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?(?![0-9])/);
  if (!m) return null;
  const h = +m[1];
  if (h < 9 || h > 16) return null;
  return `${pad(h)}:${pad(+m[2])}${m[3] ? ':' + pad(+m[3]) : ''}`;
}

// 标签与值被OCR拆成两行时合并：["成交日期","2026/10/21"] → "成交日期 2026/10/21"
function mergeLabelValues(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i]).trim();
    if (LABEL_ONLY_RE.test(l) && i + 1 < lines.length) {
      const nxt = String(lines[i + 1]).trim();
      const isDateLabel = /^(成交日期|委托日期|日期)$/.test(l);
      // 金额/价格/数量标签只吞纯数值，避免把表头"成交额"和下一行日期表头粘成"成交额 2026-10-22"
      const ok = isDateLabel
        ? (/^[\d\s\/／.\-年月日]+$/.test(nxt) && /\d/.test(nxt))
        : /^[\d.,]+$/.test(nxt);
      if (ok) { out.push(l + ' ' + nxt); i++; continue; }
    }
    out.push(l);
  }
  return out;
}

function isSideCellMode(lines) {
  let n = 0;
  for (const l of lines) if (SIDE_CELL_RE.test(String(l).trim())) n++;
  return n >= 2;
}

// 数字三元组求解：找一组 (价格, 数量, 金额) 满足 价格×数量≈金额
function solveTrio(nums) {
  let best = null;
  for (const q of nums) {
    if (!isIntLike(q) || q < 1 || q > 1e7) continue;
    for (const p of nums) {
      if (p === q || p <= 0 || p > 9999.99) continue;
      const a = p * q;
      const hit = nums.find(v => v !== p && v !== q && Math.abs(v - a) <= Math.max(1, a * 0.01));
      if (hit && (!best || Math.abs(hit - a) < best.err)) {
        best = { price: p, qty: q, amount: hit, err: Math.abs(hit - a) };
      }
    }
  }
  return best;
}

function parseSideCells(lines) {
  const merged = mergeLabelValues(lines);
  const sideIdx = [];
  merged.forEach((l, i) => { if (SIDE_CELL_RE.test(l.trim())) sideIdx.push(i); });
  if (sideIdx.length < 2) return null;

  // 日期上下文：只认整行日期（表头），标签日期在组内单独解析
  const dateCtx = new Array(merged.length).fill(null);
  const datePartCtx = new Array(merged.length).fill(null);
  let cur = null, curPart = null;
  for (let i = 0; i < merged.length; i++) {
    if (DATE_ONLY_RE.test(merged[i].trim())) {
      const d = extractDateStr(merged[i]);
      if (d) { cur = d; curPart = null; }
    } else {
      const p = extractDatePart(merged[i]);
      if (p) curPart = p;
    }
    dateCtx[i] = cur;
    datePartCtx[i] = curPart;
  }

  const used = new Set(); // 已被某一笔消费的行（名称/代码/时间/数字），防止相邻笔互相抢字段
  const numLine = (i) => /^[+-]?\d+(?:\.\d+)?$/.test(merged[i].trim());

  const trades = [];
  for (const s of sideIdx) {
    const sideLine = merged[s].trim();
    if (/撤/.test(sideLine)) continue;
    const lo = Math.max(0, s - 8), hi = Math.min(merged.length - 1, s + 8);

    // 日期：窗口内距离最近的带值日期标签优先，否则继承最近表头日期
    // 20261023实测：卡片逐笔日期不同，窗口±8会跨到相邻笔；旧逻辑从lo起取第一条，
    // 导致卖出笔/末尾笔抢到上一笔的日期（本单第3、5笔各错一天）
    let date = null, bestD = 1e9, dateLine = -1;
    for (let i = lo; i <= hi; i++) {
      if (used.has(i)) continue;
      if (!/^(成交日期|委托日期|日期)/.test(merged[i].trim())) continue;
      const d = extractDateStr(merged[i]);
      if (!d) continue;
      const dist = Math.abs(i - s);
      if (dist < bestD) { date = d; bestD = dist; dateLine = i; }
    }
    if (!date) date = dateCtx[s];

    // 只有 月-日：取窗口内最近的一条，年份由前端按当前日期推断
    let datePart = null, bestP = 1e9, partLine = -1;
    if (!date) {
      for (let i = lo; i <= hi; i++) {
        if (used.has(i)) continue;
        const p = extractDatePart(merged[i]);
        if (!p) continue;
        const dist = Math.abs(i - s);
        if (dist < bestP) { datePart = p; bestP = dist; partLine = i; }
      }
      if (!datePart) datePart = datePartCtx[s] || null;
    }

    // 名称：距离最近的未使用中文行（轻微偏好方向词之前）
    let name = null, bestN = 1e9;
    for (let i = lo; i <= hi; i++) {
      if (used.has(i)) continue;
      const l = merged[i].trim();
      if (!isNameLike(l)) continue;
      const d = Math.abs(i - s) - (i < s ? 0.25 : 0);
      if (d < bestN) { name = l; bestN = d; }
    }

    // 代码：距离最近的整行6位数字
    let code = null, bestC = 1e9;
    for (let i = lo; i <= hi; i++) {
      if (used.has(i)) continue;
      const l = merged[i].trim();
      if (!/^\d{6}$/.test(l)) continue;
      const d = Math.abs(i - s);
      if (d < bestC) { code = l; bestC = d; }
    }

    // 时间：交易时段内、距离最近的一条
    let time = null, bestT = 1e9;
    for (let i = lo; i <= hi; i++) {
      if (used.has(i)) continue;
      const t = extractTimeStr(merged[i]);
      if (t && Math.abs(i - s) < bestT) { time = t; bestT = Math.abs(i - s); }
    }

    // 标签字段：各类型取距离最近的一条
    let price = null, qty = null, amount = null;
    let priceLine = -1, qtyLine = -1, amountLine = -1;
    for (let i = lo; i <= hi; i++) {
      if (used.has(i)) continue;
      const l = merged[i].trim();
      let m;
      if ((m = l.match(/^(?:成交金额|成交额|发生金额|金额)\s*[:：]?\s*([\d,]+(?:\.\d+)?)/)) && amountLine < 0) {
        amount = +m[1].replace(/,/g, ''); amountLine = i;
      } else if ((m = l.match(/^(?:成交价格|成交价|委托价格|价格)\s*[:：]?\s*([\d,]+(?:\.\d+)?)/)) && priceLine < 0) {
        price = +m[1].replace(/,/g, ''); priceLine = i;
      } else if ((m = l.match(/^(?:成交数量|成交量|发生数量|数量)\s*[:：]?\s*([\d,]+(?:\.\d+)?)/)) && qtyLine < 0) {
        qty = +m[1].replace(/,/g, ''); qtyLine = i;
      }
    }

    // 未标注数字：在附近找一组“价格×数量≈金额”且总距离最近的三元组（排除代码/已用行）
    if (price == null || qty == null || amount == null) {
      const cand = [];
      for (let i = lo; i <= hi; i++) {
        if (used.has(i) || i === priceLine || i === qtyLine || i === amountLine) continue;
        if (!numLine(i)) continue;
        if (code && merged[i].trim() === code) continue;
        const rawNum = merged[i].trim().replace(/[+-]/, '');
        const v = Math.abs(Number(rawNum)); // 卖出数量常带负号（-100.00）
        const dec = (rawNum.split('.')[1] || '').length; // 20261104：保留原文小数位
        if (v > 0) cand.push({ v, i, dec });
      }
      let best = null;
      for (const q of cand) {
        if (!isIntLike(q.v) || q.v < 1 || q.v > 1e7) continue;
        for (const p of cand) {
          if (p === q || p.v <= 0 || p.v > 9999.99) continue;
          const a = p.v * q.v;
          for (const am of cand) {
            if (am === p || am === q) continue;
            if (Math.abs(am.v - a) > Math.max(1, a * 0.01)) continue;
            // 距离之外再按“小数位形状”加权：价格应带小数（16.000），数量应为整数（100）
            // 否则 16.000/100/1600.000 会被解成 价格=100、数量=16（金额仍对，静默错）
            const score = Math.abs(p.i - s) + Math.abs(q.i - s) + Math.abs(am.i - s)
              + (p.dec >= 2 ? 0 : 300) + q.dec * 60;
            if (!best || score < best.score) best = { p, q, am, score };
          }
        }
      }
      if (best) {
        if (price == null) { price = best.p.v; priceLine = best.p.i; }
        if (qty == null) { qty = best.q.v; qtyLine = best.q.i; }
        if (amount == null) { amount = best.am.v; amountLine = best.am.i; }
      }
    }
    // 三项互推
    if (price != null && qty != null && amount == null) amount = +(price * qty).toFixed(2);
    if (price != null && amount != null && qty == null && price > 0) qty = Math.round(amount / price);
    if (qty != null && amount != null && price == null && qty > 0) price = +(amount / qty).toFixed(3);

    // 标记已消费行，避免下一笔抢同一行
    if (name) {
      for (let i = lo; i <= hi; i++) if (!used.has(i) && merged[i].trim() === name) { used.add(i); break; }
    }
    if (code) {
      for (let i = lo; i <= hi; i++) if (!used.has(i) && merged[i].trim() === code) { used.add(i); break; }
    }
    if (time) {
      for (let i = lo; i <= hi; i++) {
        if (!used.has(i) && extractTimeStr(merged[i]) === time && Math.abs(i - s) <= 8) { used.add(i); break; }
      }
    }
    if (dateLine >= 0) used.add(dateLine);
    if (partLine >= 0) used.add(partLine);
    [priceLine, qtyLine, amountLine].forEach(i => { if (i >= 0) used.add(i); });

    const trade = {
      date, datePart, time, code, name: name || null, side: /卖/.test(sideLine) ? '卖' : '买',
      price, qty: qty == null ? null : Math.round(qty), amount,
      low: {
        price: price == null, qty: qty == null, time: !time, date: !date,
        code: false, name: !name, mismatch: false,
      },
    };
    trade.needs_fix = trade.low.price || trade.low.qty || trade.low.time ||
      trade.low.date || !trade.name;
    trades.push(trade);
  }
  return trades;
}

module.exports = { parse };
