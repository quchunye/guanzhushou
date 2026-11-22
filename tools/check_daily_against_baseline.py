#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0 对表脚本：外部不复权基准 vs 重新导出的全市场日线。

用法：
  python tools/check_daily_against_baseline.py --daily-dir "E:\\ths数据\\不复权_20261107"

输出三块：
  1) 50 只 x 3 日期 逐只差值 + PASS/FAIL
  2) 200 只随机抽样：与内置 5 分钟（不复权）末根收盘比对的差异数 / 最大偏差
  3) 结论行：P0_PASS 或 P0_FAIL

判定：
  - 某单元格基准值为 null（该股当日无成交）→ SKIP，不计 FAIL
  - |日线收盘 - 基准收盘| <= --tol（默认 0.005 元）→ PASS
  - 200 只抽样要求差异数 = 0，否则 FAIL

只读脚本：不写任何数据目录，不改仓库。
"""

import argparse
import csv
import gzip
import json
import random
import re
import sys
from pathlib import Path

BASELINE_DEFAULT = r"D:\Trae CN\论文\创业\盘纪MVP\内部研判\外部不复权基准_20261107.json"
PACK_DEFAULT = r"D:\Trae CN\论文\创业\盘纪MVP\h5\public"
DATES = ["2025-09-30", "2025-12-31", "2026-09-30"]


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "gbk", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "ignore")


def norm_date(s: str) -> str:
    s = (s or "").strip().replace("/", "-").replace(".", "-")
    if len(s) == 8 and s.isdigit():
        return "{}-{}-{}".format(s[:4], s[4:6], s[6:])
    return s[:10]


def pick_col(fieldnames, candidates):
    low = {(f or "").strip().lower(): f for f in fieldnames}
    for c in candidates:
        if c in low:
            return low[c]
    return None


def load_daily_dir(root: Path):
    """返回 {code: {date: (close, volume)}}，以及文件统计。"""
    files = sorted(root.rglob("*.csv"))
    data = {}
    bad = []
    for fp in files:
        try:
            text = read_text(fp)
        except Exception as e:
            bad.append((fp.name, "read:" + str(e)[:40]))
            continue
        rows = list(csv.reader(text.splitlines()))
        if not rows:
            bad.append((fp.name, "empty"))
            continue
        header = rows[0]
        c_date = pick_col(header, ["date", "日期", "trade_date", "时间"])
        c_close = pick_col(header, ["close", "收盘价", "收盘"])
        c_vol = pick_col(header, ["volume", "成交量", "vol"])
        c_code = pick_col(header, ["code", "代码", "symbol", "股票代码"])
        if not (c_date and c_close):
            bad.append((fp.name, "no date/close column"))
            continue
        idx = {h: i for i, h in enumerate(header)}
        i_d, i_c = idx[c_date], idx[c_close]
        i_v = idx[c_vol] if c_vol else None
        i_k = idx[c_code] if c_code else None
        per = {}
        for r in rows[1:]:
            if len(r) <= max(i_d, i_c):
                continue
            d = norm_date(r[i_d])
            if not d:
                continue
            try:
                close = float(r[i_c])
            except ValueError:
                continue
            vol = None
            if i_v is not None and len(r) > i_v:
                try:
                    vol = float(r[i_v])
                except ValueError:
                    vol = None
            per[d] = (close, vol)
        code = None
        if i_k is not None and len(rows) > 1 and len(rows[1]) > i_k:
            code = re.sub(r"\D", "", rows[1][i_k])[-6:]
        if not code:
            m = re.search(r"(\d{6})", fp.stem)
            if m:
                code = m.group(1)
        if not code or not per:
            bad.append((fp.name, "no code"))
            continue
        # 同代码多文件时做并集，日期冲突以后读到的为准（正常不会冲突）
        data.setdefault(code, {}).update(per)
    return data, files, bad


def builtin_5m_close(pack_root: Path, code: str):
    for prefix in ("", "sh", "sz", "bj"):
        p = pack_root / "data" / "kline" / "5m" / (prefix + code) / "2025-09.json.gz"
        if not p.exists():
            continue
        try:
            with gzip.open(p, "rt", encoding="utf-8") as f:
                obj = json.load(f)
        except Exception:
            continue
        bars = obj.get("bars") or []
        if not bars:
            continue
        parts = bars[-1].split(",")
        if len(parts) >= 5:
            try:
                return float(parts[4])
            except ValueError:
                continue
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--daily-dir", required=True, help="新导出的日线目录")
    ap.add_argument("--baseline", default=BASELINE_DEFAULT)
    ap.add_argument("--pack-root", default=PACK_DEFAULT)
    ap.add_argument("--tol", type=float, default=0.005, help="收盘价容差（元）")
    ap.add_argument("--sample", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20261107)
    args = ap.parse_args()

    root = Path(args.daily_dir)
    if not root.exists():
        print("P0_FAIL 日线目录不存在: %s" % root)
        return 2

    baseline = json.loads(read_text(Path(args.baseline)))
    base_rows = {r["code"]: r for r in baseline["rows"]}

    data, files, bad = load_daily_dir(root)
    print("== 输入检查 ==")
    print("目录: %s" % root)
    print("CSV 文件: %d   解析成功代码: %d   跳过文件: %d" % (len(files), len(data), len(bad)))
    for name, why in bad[:8]:
        print("  跳过 %s (%s)" % (name, why))
    if bad[8:]:
        print("  ... 其余 %d 个" % (len(bad) - 8))
    print()

    # ---------- 1) 50 x 3 ----------
    print("== 1) 50 只 x 3 日期（基准 = 外部不复权）==")
    print("%-8s %-10s %-12s %-10s %-10s %-8s" % ("代码", "名称", "日期", "基准", "日线", "结论"))
    per_stock_fail = {}
    per_date_fail = {d: 0 for d in DATES}
    per_date_skip = {d: 0 for d in DATES}
    rows_missing_code = []
    for code, base in sorted(base_rows.items()):
        if code not in data:
            rows_missing_code.append(code)
            per_stock_fail[code] = per_stock_fail.get(code, 0) + 3
            print("%-8s %-10s %-12s %-10s %-10s %-8s" % (code, base.get("name", ""), "*", "有", "缺文件", "FAIL"))
            continue
        for d in DATES:
            exp = (base.get("close") or {}).get(d)
            got = data[code].get(d)
            if exp is None:
                per_date_skip[d] += 1
                print("%-8s %-10s %-12s %-10s %-10s %-8s" % (code, base.get("name", ""), d, "-", "%.2f" % got[0] if got else "缺", "SKIP"))
                continue
            if got is None:
                per_date_fail[d] += 1
                per_stock_fail[code] = per_stock_fail.get(code, 0) + 1
                print("%-8s %-10s %-12s %-10s %-10s %-8s" % (code, base.get("name", ""), d, "%.2f" % exp, "缺", "FAIL"))
                continue
            diff = got[0] - exp
            ok = abs(diff) <= args.tol
            if not ok:
                per_date_fail[d] += 1
                per_stock_fail[code] = per_stock_fail.get(code, 0) + 1
            print("%-8s %-10s %-12s %-10.2f %-10.2f %+8.3f %s" % (
                code, base.get("name", ""), d, exp, got[0], diff, "PASS" if ok else "FAIL"))
    if rows_missing_code:
        print("缺少文件的基准代码: %s" % ",".join(rows_missing_code))
    stock_pass = len(base_rows) - len(per_stock_fail)
    print("\n逐只: PASS %d / %d   逐日: %s   跳过单元格: %s" % (
        stock_pass, len(base_rows),
        ", ".join("%s FAIL=%d" % (d, per_date_fail[d]) for d in DATES),
        ", ".join("%s SKIP=%d" % (d, per_date_skip[d]) for d in DATES)))
    print()

    # ---------- 2) 200 只随机抽样 vs 内置 5 分钟 ----------
    print("== 2) %d 只随机抽样（日线 vs 内置 5 分钟末根，2025-09-30）==" % args.sample)
    pool = [c for c in data if c not in base_rows and "2025-09-30" in data[c]]
    random.seed(args.seed)
    picked = random.sample(pool, min(args.sample, len(pool))) if pool else []
    checked = 0
    diffs = 0
    missing = 0
    worst = (0.0, "", 0.0, 0.0)
    for code in picked:
        daily_close = data[code]["2025-09-30"][0]
        ref = builtin_5m_close(Path(args.pack_root), code)
        if ref is None:
            missing += 1
            continue
        checked += 1
        d = daily_close - ref
        if abs(d) > args.tol:
            diffs += 1
            if abs(d) > abs(worst[0]):
                worst = (d, code, daily_close, ref)
    print("抽样池: %d   抽取: %d   有内置对照: %d   无对照: %d" % (len(pool), len(picked), checked, missing))
    print("差异数: %d / %d   最大偏差: %+.3f (%s 日线 %.2f vs 5m %.2f)" % (
        diffs, checked, worst[0], worst[1] or "-", worst[2], worst[3]))
    print()

    # ---------- 成交量单位自检 ----------
    print("== 附：成交量单位自检（日线 vs 基准 vol_lots=手）==")
    ratios = []
    for code in base_rows:
        if code not in data:
            continue
        for d in DATES:
            base_v = (base_rows[code].get("vol_lots") or {}).get(d)
            got = data[code].get(d)
            if base_v and got and got[1]:
                ratios.append(got[1] / float(base_v))
    if ratios:
        s = sorted(ratios)
        med = s[len(s) // 2]
        unit = "股（应为手 x100）" if 50 <= med <= 150 else ("手" if med < 1.5 else "未知")
        print("样本 %d   比值中位数 %.3f   最小 %.3f   最大 %.3f   推断单位: %s" % (
            len(ratios), med, s[0], s[-1], unit))
    else:
        print("无可用成交量对照")
    print()

    # ---------- 3) 结论 ----------
    sample_fail = diffs
    total_fail = sum(per_date_fail.values())
    passed = (total_fail == 0) and (sample_fail == 0) and (len(rows_missing_code) == 0)
    print("== 3) 结论 ==")
    print("50x3 失败单元格 = %d   缺文件代码 = %d   200 只抽样差异 = %d" % (
        total_fail, len(rows_missing_code), sample_fail))
    print("P0_PASS" if passed else "P0_FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
