#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""合成交割单截图生成器（仅用于示例图与测试样本）。

原则：
1. 所有字段都是虚构值：账号固定 9999 开头，姓名为「示例」池，股票为「示例甲/乙/丙」。
2. 固定随机种子，同一 seed 出同一张图，方便回归比对。
3. 每张图页脚强制带「合成样本 · 非真实交易」，防止被当成真实数据流转。

用法：
    python tools/fixtures/gen_ticket.py --out public/sample/demo_jiaogedan.jpg
    python tools/fixtures/gen_ticket.py --seed 7 --rows 10 --layout ths_pc --out /tmp/a.png
"""
import argparse
import random
from PIL import Image, ImageDraw, ImageFont

W, H = 900, 1200
BG = (255, 255, 255)
FG = (34, 34, 34)
DIM = (120, 120, 120)

SIDES = ["买入", "卖出"]
NAMES = ["示例甲", "示例乙", "示例丙", "示例丁", "示例戊", "示例己"]


def font(size):
    for p in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_rows(rng, n):
    rows = []
    for i in range(n):
        price = round(rng.uniform(5, 60), 2)
        qty = rng.choice([100, 200, 300, 500, 1000])
        amount = round(price * qty, 2)
        rows.append({
            "time": "%02d:%02d:%02d" % (rng.randint(9, 14), rng.randint(0, 59), rng.randint(0, 59)),
            "name": rng.choice(NAMES),
            "side": rng.choice(SIDES),
            "price": price,
            "qty": qty,
            "amount": amount,
        })
    return rows


def render(rows, date_str):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title = font(34)
    f_head = font(22)
    f_body = font(22)
    f_small = font(17)

    d.text((36, 40), "历史成交", font=f_title, fill=FG)
    d.text((36, 96), "资金账号 9999****   户名 示例用户   期间 %s" % date_str, font=f_small, fill=DIM)

    y = 150
    cols = [(36, "成交时间"), (200, "证券名称"), (340, "操作"), (420, "成交价"), (520, "成交数量"), (660, "成交金额")]
    for x, label in cols:
        d.text((x, y), label, font=f_head, fill=DIM)
    y += 40
    d.line([(36, y), (W - 36, y)], fill=(210, 210, 210), width=1)
    y += 14

    for r in rows:
        d.text((36, y), r["time"], font=f_body, fill=FG)
        d.text((200, y), r["name"], font=f_body, fill=FG)
        d.text((340, y), r["side"], font=f_body, fill=(180, 60, 60) if r["side"] == "买入" else (40, 120, 90))
        d.text((420, y), "%.2f" % r["price"], font=f_body, fill=FG)
        d.text((520, y), str(r["qty"]), font=f_body, fill=FG)
        d.text((660, y), "%.2f" % r["amount"], font=f_body, fill=FG)
        y += 46

    d.line([(36, H - 110), (W - 36, H - 110)], fill=(210, 210, 210), width=1)
    d.text((36, H - 92), "合成样本 · 非真实交易 · 仅用于演示与测试", font=f_small, fill=DIM)
    d.text((36, H - 66), "该图由 tools/fixtures/gen_ticket.py 生成，不含任何真实账户或成交数据", font=f_small, fill=DIM)
    return img


def render_app_history(rows, date_str):
    """券商 App「历史成交」列表样式（1080x2167），用于首页示例图。"""
    W2, H2 = 1080, 2167
    img = Image.new("RGB", (W2, H2), BG)
    d = ImageDraw.Draw(img)
    f_tab = font(34)
    f_head = font(26)
    f_body = font(32)
    f_small = font(22)
    f_big = font(38)
    BLUE = (27, 111, 214)
    RED = (214, 48, 48)
    GREEN = (32, 132, 96)

    # 顶部页签
    d.text((40, 120), "当日委托", font=f_tab, fill=DIM)
    d.text((280, 120), "当日成交", font=f_tab, fill=DIM)
    d.text((520, 120), "历史委托", font=f_tab, fill=DIM)
    d.text((760, 120), "历史成交", font=f_tab, fill=FG)
    d.line([(760, 168), (940, 168)], fill=RED, width=4)
    # 红框 + 「点这里」
    d.rectangle([744, 86, 966, 186], outline=RED, width=5)
    d.rectangle([800, 26, 950, 80], fill=RED)
    d.text((812, 36), "点这里", font=f_small, fill=(255, 255, 255))

    # 日期区间
    d.text((40, 226), date_str[0] + " ▼", font=f_body, fill=FG)
    d.text((300, 226), "至", font=f_body, fill=DIM)
    d.text((370, 226), date_str[1] + " ▼", font=f_body, fill=FG)
    d.rectangle([860, 214, 1030, 284], fill=RED)
    d.text((905, 228), "确定", font=f_body, fill=(255, 255, 255))
    d.line([(40, 306), (W2 - 40, 306)], fill=(220, 220, 220), width=1)

    # 表头
    d.text((40, 336), "成交时间", font=f_head, fill=DIM)
    d.text((430, 336), "成交价", font=f_head, fill=DIM)
    d.text((640, 336), "成交量", font=f_head, fill=DIM)
    d.text((850, 336), "成交额", font=f_head, fill=DIM)
    d.line([(40, 396), (W2 - 40, 396)], fill=(220, 220, 220), width=1)

    y = 430
    for r in rows:
        buy = r["side"] == "买入"
        d.text((40, y), r["name"], font=f_body, fill=BLUE)
        d.text((430, y), "%.3f" % r["price"], font=f_body, fill=FG)
        d.text((640, y), str(r["qty"]), font=f_body, fill=FG)
        amt = "%.3f" % r["amount"]
        tw = d.textlength(amt, font=f_body)
        d.text((W2 - 40 - tw, y), amt, font=f_body, fill=FG)
        d.text((W2 - 40 - d.textlength(r["side"], font=f_big), y + 44), r["side"], font=f_big, fill=RED if buy else BLUE)
        # 方向小标签 + 日期时间
        d.rectangle([40, y + 52, 84, y + 88], fill=RED if buy else GREEN)
        d.text((52, y + 56), "买" if buy else "卖", font=f_small, fill=(255, 255, 255))
        d.text((96, y + 54), r["when"], font=f_small, fill=DIM)
        y += 132
        d.line([(40, y - 24), (W2 - 40, y - 24)], fill=(238, 238, 238), width=1)

    # 底部水印（强制）
    d.line([(40, H2 - 150), (W2 - 40, H2 - 150)], fill=(210, 210, 210), width=1)
    d.text((40, H2 - 130), "合成样本 · 非真实交易 · 仅用于演示与测试", font=f_small, fill=DIM)
    d.text((40, H2 - 98), "由 tools/fixtures/gen_ticket.py 生成，不含任何真实账户或成交数据", font=f_small, fill=DIM)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=20261115)
    ap.add_argument("--rows", type=int, default=10)
    ap.add_argument("--date", default="2026-10-19")
    ap.add_argument("--layout", default="ticket", choices=["ticket", "app_history"])
    args = ap.parse_args()

    if args.layout == "app_history":
        rows = [
            {"name": "示例环保", "side": "卖出", "price": 15.380, "qty": 100, "amount": 1538.000, "when": "20260917 10:14:50"},
            {"name": "示例材料", "side": "买入", "price": 8.190, "qty": 100, "amount": 819.000, "when": "20260917 10:13:06"},
            {"name": "示例材料", "side": "买入", "price": 8.180, "qty": 300, "amount": 2454.000, "when": "20260917 10:13:02"},
            {"name": "示例环保", "side": "卖出", "price": 15.330, "qty": 100, "amount": 1533.000, "when": "20260917 10:08:51"},
            {"name": "示例材料", "side": "买入", "price": 8.200, "qty": 700, "amount": 5740.000, "when": "20260917 10:08:02"},
            {"name": "示例材料", "side": "买入", "price": 8.210, "qty": 700, "amount": 5747.000, "when": "20260917 10:05:10"},
            {"name": "示例建设", "side": "买入", "price": 6.200, "qty": 400, "amount": 2480.000, "when": "20260917 09:31:39"},
            {"name": "示例环保", "side": "卖出", "price": 15.400, "qty": 100, "amount": 1540.000, "when": "20260917 09:31:01"},
            {"name": "示例材料", "side": "买入", "price": 8.600, "qty": 4100, "amount": 35260.000, "when": "20260917 09:30:21"},
        ]
        img = render_app_history(rows, ("2026-09-17", "2026-09-24"))
        img.save(args.out, quality=88)
        print("written:", args.out)
        return

    rng = random.Random(args.seed)
    img = render(make_rows(rng, args.rows), args.date)
    img.save(args.out, quality=88)
    print("written:", args.out)


if __name__ == "__main__":
    main()
