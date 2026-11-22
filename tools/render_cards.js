// 生成复盘卡 / 图鉴卡样例 SVG，供设计线与人眼复核。
// 用法：node tools/render_cards.js
// 输出：docs/卡片样例/*.svg（不改 public/ 里的任何成品）
const fs = require('fs');
const path = require('path');
const cards = require('../public/features/card_svg.js');

const OUT = path.join(__dirname, '..', 'docs', '卡片样例');
fs.mkdirSync(OUT, { recursive: true });

const samples = [
  {
    file: '复盘卡_No000_示例.svg',
    svg: cards.review({
      caseNo: 'No.000',
      isDemo: true,
      stats: [
        { label: '复盘笔数', val: '12 笔', col: cards.TOKENS.frost },
        { label: '越线笔数', val: '3 处', col: cards.TOKENS.gold },
        { label: '连续复盘', val: '7 天', col: cards.TOKENS.ink },
      ],
    }),
  },
  {
    file: '复盘卡_No021_日常.svg',
    svg: cards.review({
      caseNo: 'No.021',
      stats: [
        { label: '复盘笔数', val: '24 笔', col: cards.TOKENS.frost },
        { label: '越线笔数', val: '1 处', col: cards.TOKENS.gold },
        { label: '连续复盘', val: '14 天', col: cards.TOKENS.ink },
      ],
    }),
  },
  {
    file: '图鉴卡_8of25.svg',
    svg: cards.collection({ lit: 8, total: 25, todayPlus: 1 }),
  },
  {
    file: '图鉴卡_15of25.svg',
    svg: cards.collection({ lit: 15, total: 25, todayPlus: 0 }),
  },
];

samples.forEach((s) => {
  fs.writeFileSync(path.join(OUT, s.file), s.svg, 'utf8');
  console.log('wrote', s.file, s.svg.length + 'B');
});
