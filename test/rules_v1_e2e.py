# rules_v1_e2e.py —— V1 规则配置页端到端回归（mock OCR + mock 判定）
# 运行：python test/rules_v1_e2e.py   （需先启动服务：PORT=3211 JUDGE_MODE=mock OCR_MODE=mock node server.js）
import json
import os
import sys
import tempfile
from playwright.sync_api import sync_playwright

BASE = os.environ.get('H5_BASE', 'http://127.0.0.1:3211')
SHOT = os.path.join(tempfile.gettempdir(), 'rules_v1_report.png')
SAMPLE = 'public/sample/demo_jiaogedan.jpg'
ERR = []


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        pg = b.new_page(viewport={'width': 390, 'height': 844})
        pg.on('console', lambda m: ERR.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: ERR.append(str(e)))

        pg.goto(BASE, wait_until='networkidle')
        pg.evaluate("localStorage.clear()")
        pg.reload(wait_until='networkidle')

        # 1) 未设规则 → 复核确认后应被引导到规则页
        pg.set_input_files('#file-input', SAMPLE)
        try:
            pg.wait_for_selector('#scr-review.active', timeout=20000)
        except Exception:
            pg.wait_for_timeout(1000)
            print('DEBUG active screen =', pg.evaluate("document.querySelector('.screen.active')?.id"))
            print('DEBUG toast =', pg.inner_text('#toast'))
            print('DEBUG errors =', ERR)
            pg.screenshot(path='test/debug_upload.png', full_page=True)
            raise
        # mock 数据故意留了一笔价格缺失（黄框），E2E 先补全
        fills = {'price': '13.00', 'qty': '100', 'date': '2026-10-09', 'time': '09:30', 'name': '补录标的'}
        for key, val in fills.items():
            loc = pg.locator(f'#trade-list input[data-k="{key}"]')
            for i in range(loc.count()):
                if loc.nth(i).input_value() == '':
                    loc.nth(i).fill(val)

        pg.click('#btn-confirm')
        try:
            pg.wait_for_selector('#scr-rules.active', timeout=8000)
        except Exception:
            pg.wait_for_timeout(800)
            print('DEBUG active screen =', pg.evaluate("document.querySelector('.screen.active')?.id"))
            print('DEBUG toast =', pg.inner_text('#toast'))
            print('DEBUG config =', pg.evaluate("localStorage.getItem('guanzhu_rules_v1')"))
            print('DEBUG errors =', ERR)
            pg.screenshot(path='test/debug_rules.png', full_page=True)
            raise
        print('✓ 未设规则时引导到规则配置页')


        pg.screenshot(path=os.path.join(tempfile.gettempdir(), 'rules_v1_config.png'), full_page=True)
        cards = pg.locator('#rule-list .rule-card')
        assert cards.count() == 13, f'模板数应为13，实际{cards.count()}'
        print('✓ 13 条模板渲染')
        assert pg.locator('#rule-list .rule-card.on').count() == 4, '默认应勾 4 条'
        print('✓ 默认勾选 4 条（旧版 R1-R4 映射）')

        # 2) 勾 T13 + 填账户资金 + 保存 → 自动继续判定
        pg.locator('.rule-card[data-id="T13"] [data-check]').check()
        pg.fill('#capital', '100000')
        pg.click('#btn-rules-save')
        pg.wait_for_selector('#scr-done.active', timeout=30000)
        print('✓ 保存规则后自动继续判定并出报告')

        cfg = pg.evaluate("JSON.parse(localStorage.getItem('guanzhu_rules_v1'))")
        assert len(cfg['rules']) == 5, cfg
        assert cfg['capital'] == 100000, cfg
        print('✓ localStorage 规则=5条、资金=100000')

        n_lines = pg.locator('#rep-lines .rep-line').count()
        assert n_lines >= 8, f'逐笔判定行数异常: {n_lines}'
        print(f'✓ 逐笔判定 {n_lines} 行')
        assert pg.locator('#rep-rules-block').is_visible(), '规则使用情况块应可见'
        ai = pg.inner_text('#rep-ai-label')
        assert ('AI生成' in ai) or ('规则引擎生成' in ai), ai
        print(f'✓ AI 标识：{ai}')

        pg.screenshot(path=SHOT, full_page=True)
        print(f'✓ 截图 {SHOT}')

        # 3) 回配置页复核勾选状态
        pg.click('#btn-again')
        pg.click('#btn-rules')
        pg.wait_for_selector('#scr-rules.active')
        assert pg.locator('#rule-list .rule-card.on').count() == 5
        print('✓ 再次进入配置页，勾选状态保持')

        b.close()

    if ERR:
        print('控制台错误：')
        for e in ERR:
            print('   ', e)
        sys.exit(1)
    print('\n===== E2E 全部通过 =====')


if __name__ == '__main__':
    main()
