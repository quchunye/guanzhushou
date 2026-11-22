# -*- coding: utf-8 -*-
"""wx_ua_test.py —— 微信 UA（MicroMessenger）弹窗文案逻辑验证（备案前可测项）
双上下文对照：普通浏览器 UA vs 微信 WebView UA，注入同一 verdict 后点「生成分享卡」，
断言 share-tip / 下载按钮 的文案与样式分支。截图写入系统临时目录。
跑法：先起本地服务（node server/server.js），再 python wx_ua_test.py
"""
import sys, io, os, tempfile
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright

SHOT_DIR = tempfile.gettempdir()

BASE = "http://127.0.0.1:3210"
WX_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
         "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003133) "
         "NetType/WIFI Language/zh_CN")

# 注入的模拟 verdict（结构与 server/judge.js 返回一致）
VERDICT_JS = """
state.verdict = {
  case_no: '冲动案例档案 No.001',
  one_liner: '尾盘追高两次都是同一只票，下次挂单前先看一眼昨天的自己。',
  summary: { violations: 2, suspects: 1, worst: { text: '-3,240元' } },
  lines: [
    { idx: 0, date: '2026-10-20', time: '09:31:05', side: '买', name: '示例材料', code: '600001', qty: 2000, price: 12.34, flag: '合规', rule: '', reason: '计划内买入' },
    { idx: 1, date: '2026-10-20', time: '14:52:41', side: '买', name: '示例材料', code: '600001', qty: 3000, price: 12.80, flag: '违规', rule: '尾盘追高', reason: '14:50后追高买入' },
    { idx: 2, date: '2026-10-20', time: '14:56:12', side: '卖', name: '示例材料', code: '600001', qty: 3000, price: 12.55, flag: '违规', rule: 'T+0冲动', reason: '买入4分钟后恐慌卖出' }
  ],
  suspects: [{ text: '第2笔价格异常放大，请核对截图' }],
  fixes: ['尾盘14:50后不追高：挂单前默数10秒再看一眼分时'],
  disclaimer: '本报告基于本人确认的记录生成，仅供纪律复盘，不构成投资建议。'
};
state.caseNo = '冲动案例档案 No.001';
'set';
"""

def run_case(ctx, name, shot):
    page = ctx.new_page()
    page.goto(BASE, wait_until="load")
    page.evaluate(VERDICT_JS)
    page.evaluate("go('#scr-done')")
    page.click("#btn-share")
    page.wait_for_selector("#share-mask.show", timeout=5000)
    page.wait_for_function("document.querySelector('#share-img').src.startsWith('data:image/png')", timeout=5000)
    tip = page.inner_text("#share-tip")
    dl_text = page.inner_text("#btn-share-dl").strip()
    dl_ghost = page.evaluate("document.querySelector('#btn-share-dl').classList.contains('ghost')")
    ua_hit = page.evaluate("/MicroMessenger/i.test(navigator.userAgent)")
    page.screenshot(path=shot)
    page.close()
    return {"name": name, "ua_hit": ua_hit, "tip": tip.replace("\n", " / "), "dl": dl_text, "ghost": dl_ghost}

with sync_playwright() as p:
    browser = p.chromium.launch()
    # 用例1：普通浏览器（桌面 chromium 默认 UA，手机尺寸模拟普通手机浏览器）
    c1 = browser.new_context(viewport={"width": 390, "height": 844})
    r1 = run_case(c1, "普通浏览器UA", os.path.join(SHOT_DIR, "wx_ua_normal.png"))
    # 用例2：微信 WebView UA
    c2 = browser.new_context(viewport={"width": 390, "height": 844}, user_agent=WX_UA)
    r2 = run_case(c2, "微信MicroMessenger UA", os.path.join(SHOT_DIR, "wx_ua_wechat.png"))
    browser.close()

ok = True
for r in (r1, r2):
    print(f"[{r['name']}] UA判定={r['ua_hit']} | tip: {r['tip']} | 按钮: {r['dl']} | ghost: {r['ghost']}")

# 断言
a1 = (not r1["ua_hit"]) and r1["tip"] == "长按 / 右键保存图片，发到你想发的地方" and r1["dl"] == "下载图片" and not r1["ghost"]
a2 = r2["ua_hit"] and "长按上方图片" in r2["tip"] and "发送给朋友" in r2["tip"] and "···" in r2["tip"] and r2["dl"] == "保存图片" and r2["ghost"]
print(f"用例1 普通浏览器分支: {'PASS' if a1 else 'FAIL'}")
print(f"用例2 微信UA分支:     {'PASS' if a2 else 'FAIL'}")
sys.exit(0 if (a1 and a2) else 1)
