# local_ocr —— 盘纪本地 OCR 服务（RapidOCR / PP-OCR ONNX CPU）

> 目标：把交割单截图留在自己的服务器上，零单次 OCR 费用；先用它替换 TextIn/腾讯云做灰度。
> 当前是**候选实现**，未上生产、未改 H5 默认供应商。

## 1. 接口契约

H5 服务端 `LOCAL_OCR_URL=http://127.0.0.1:8010/ocr` 时，`server/ocr.js` 会 POST 图片字节：

```
POST /ocr
content-type: application/octet-stream
x-ocr-token: <OCR_TOKEN>（可选）

<图片二进制>
```

返回：

```json
{
  "ok": true,
  "engine": "rapidocr",
  "lines": ["09:34:55", "证券买入", "600001", "..."],
  "boxes": {
    "w": 1080, "h": 2081,
    "items": [{"text":"09:34:55","x":38,"y":32,"w":191,"h":52,
               "nx":0.0352,"ny":0.0154,"nw":0.1769,"nh":0.025,"score":0.99}]
  },
  "elapsed_ms": 820
}
```

`lines` 按“行（中心 Y 10px 分桶）+ 行内 X”排序；`boxes` 归一化坐标给 D 的原图定位用。

## 2. 部署（staging/production 同机）

```bash
# 在服务器上
mkdir -p /opt/panji-ocr && cd /opt/panji-ocr
# 上传 server.py 与 Dockerfile
docker build -t panji-ocr:1.0 .
docker run -d --name panji-ocr --restart unless-stopped \
  -p 127.0.0.1:8010:8010 \
  -e OCR_TOKEN='<随机长串>' \
  -m 900m --cpus 1.5 \
  panji-ocr:1.0
curl -s http://127.0.0.1:8010/health
```

注意：

- 只绑 `127.0.0.1`，不暴露公网；H5 与 OCR 同机时走回环。
- 生产机目前没有 Docker（20261102 核对）；要上生产需先 `apt install docker.io` 或改用 systemd + venv。
- 2C2G 机器建议 `-m 900m --cpus 1.5`，留内存给 Node/nginx；4GB swap 已存在。
- 模型首次启动会下载（约 15–30MB），需要外网；离线环境需提前把模型放进镜像。

## 3. 验收口径

1. 用 `public/sample/demo_jiaogedan.jpg` 跑一次，确认 `lines` 与 TextIn 的 75 个框量级一致。
2. 把返回的 `lines` 喂给 `server/parser.js`，确认 `trade_count=9`、`needs_fix_count` 不高于 TextIn。
3. 再用自己的另一份交割单截图跑一次，确认买卖方向/价格/数量可解析（截图不要提交进仓库）。
4. 只有以上三点通过，才把 `OCR_PROVIDER` 切到 `local`；否则保留腾讯云/TextIn。

## 4. 合规

- 本地 OCR 不把图片发给第三方；切换后隐私政策里的“上海合合信息 TextIn”处理者条款要改成自有服务器处理。
- 仍不落盘：图片只在内存中解码，返回后丢弃。
