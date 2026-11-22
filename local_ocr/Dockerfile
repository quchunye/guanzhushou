FROM docker.m.daocloud.io/library/python:3.11-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# 不装 apt 包（Debian 源在境内机器上易卡）；opencv-python-headless 自带运行库
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
  rapidocr_onnxruntime==1.4.4 \
  && pip uninstall -y opencv-python \
  && pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
  opencv-python-headless

COPY server.py /app/server.py
EXPOSE 8010
CMD ["python", "server.py"]
