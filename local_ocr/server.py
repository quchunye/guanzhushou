# local_ocr/server.py —— 盘纪本地 OCR 服务（RapidOCR / PP-OCR ONNX，CPU）
#
# 只做一件事：POST 图片字节 → {ok, lines, boxes}；不落盘、不记内容。
# 运行：python server.py（默认 0.0.0.0:8010；环境变量 OCR_PORT / OCR_TOKEN）
# H5 服务端用 LOCAL_OCR_URL=http://127.0.0.1:8010/ocr 接入。

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

MAX_BYTES = 8 * 1024 * 1024
TOKEN = os.environ.get('OCR_TOKEN', '')
PORT = int(os.environ.get('OCR_PORT', '8010'))
ENGINE = RapidOCR()
ANCHOR_RE = re.compile(r'([买卖])(\d{8})(\d{1,2}[：:]\d{2}(?:[：:]\d{2})?)')


def fix_anchor(s):
    return ANCHOR_RE.sub(
        lambda m: m.group(1) + ' ' + m.group(2) + ' ' + m.group(3).replace('：', ':'),
        str(s or ''),
    )


def normalize_box(box, text, score, w_img, h_img):
    pts = []
    for p in box or []:
        try:
            pts.append((float(p[0]), float(p[1])))
        except Exception:
            pass
    if not pts:
        return None
    x = min(p[0] for p in pts)
    y = min(p[1] for p in pts)
    w = max(p[0] for p in pts) - x
    h = max(p[1] for p in pts) - y
    if w <= 0 or h <= 0:
        return None
    return {
        'text': str(text or ''),
        'x': round(x), 'y': round(y), 'w': round(w), 'h': round(h),
        'nx': round(x / w_img, 4), 'ny': round(y / h_img, 4),
        'nw': round(w / w_img, 4), 'nh': round(h / h_img, 4),
        'score': round(float(score or 0), 4),
    }


def run_ocr(body):
    buf = np.frombuffer(body, np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('图片解码失败（仅支持 JPG/PNG/WebP）')
    h_img, w_img = img.shape[0], img.shape[1]
    t0 = time.time()
    result, elapse = ENGINE(img)
    items = []
    for row in result or []:
        if not row or len(row) < 2:
            continue
        box, text = row[0], row[1]
        score = row[2] if len(row) > 2 else 0
        it = normalize_box(box, fix_anchor(text), score, w_img, h_img)
        if it:
            items.append(it)
    if not items:
        raise ValueError('未识别到文字')
    # 与腾讯映射同口径：中心 Y 分 10px 桶，桶内按 X；一行多单元格还原成一行
    items.sort(key=lambda b: (round((b['y'] + b['h'] / 2) / 10), b['x']))
    return {
        'ok': True,
        'engine': 'rapidocr',
        'lines': [b['text'] for b in items],
        'boxes': {'w': w_img, 'h': h_img, 'items': items},
        'elapsed_ms': int((time.time() - t0) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {'ok': True, 'engine': 'rapidocr'})
        return self._json(404, {'ok': False, 'error': 'not_found'})

    def do_POST(self):
        if self.path != '/ocr':
            return self._json(404, {'ok': False, 'error': 'not_found'})
        if TOKEN and self.headers.get('x-ocr-token', '') != TOKEN:
            return self._json(403, {'ok': False, 'error': 'forbidden'})
        try:
            n = int(self.headers.get('content-length', '0'))
        except Exception:
            n = 0
        if n <= 0:
            return self._json(400, {'ok': False, 'error': 'empty_body'})
        if n > MAX_BYTES:
            return self._json(413, {'ok': False, 'error': 'too_large'})
        body = self.rfile.read(n)
        try:
            return self._json(200, run_ocr(body))
        except ValueError as e:
            return self._json(400, {'ok': False, 'error': str(e)})
        except Exception as e:
            return self._json(500, {'ok': False, 'error': 'ocr_failed: ' + str(e)})

    def log_message(self, fmt, *args):
        # 不打印图片内容；只保留启动/错误由 systemd 收
        return


if __name__ == '__main__':
    print('local_ocr listening on 0.0.0.0:%d engine=rapidocr token=%s' % (PORT, 'on' if TOKEN else 'off'))
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
