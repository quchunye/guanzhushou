/* 上传前可选遮挡（20261107）
   形态：选完交割单图片 → 先给预览页，可拖动涂抹遮挡块 → 「跳过遮挡，直接上传」或「确认遮挡并上传」。
   确认后把原图与遮罩合成为一张新图上传（识别接口与服务端不变）。
   记忆：只在本机存归一化坐标（0~1），不存图片、不上传；下次同版式自动套用。
   注意：本模块只在文件选择路径被调用；粘贴路径保持原样，不额外增加步骤。 */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : this;
  var KEY = 'panji_mask_last_v1';
  var RATIO_TOL = 0.12;   // 宽高比差超过 12% 视为换版式，不自动套用

  var layer = null, canvas = null, ctx = null, img = null, stage = null;
  var boxes = [], drawing = null, hintEl = null;
  var onDone = null, fileName = '', busy = false;

  var CSS = [
    '.mask-layer{position:fixed;inset:0;z-index:88;display:flex;flex-direction:column;background:#0b0d12;color:#eef2f7;}',
    '.mask-layer[hidden]{display:none;}',
    '.mask-head{padding:14px 16px 8px;flex:0 0 auto;}',
    '.mask-head h2{margin:0;font-size:17px;letter-spacing:.02em;}',
    '.mask-head p{margin:6px 0 0;font-size:13px;line-height:1.6;color:#aab6c6;}',
    '.mask-stage{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;padding:8px 12px;overflow:hidden;}',
    '.mask-canvas{max-width:100%;max-height:100%;border-radius:10px;background:#151922;box-shadow:0 8px 30px rgba(0,0,0,.45);touch-action:none;cursor:crosshair;}',
    '.mask-tools{display:flex;gap:8px;padding:6px 12px;flex-wrap:wrap;justify-content:center;}',
    '.mask-tools button{appearance:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e8eef7;font-size:13px;padding:9px 12px;border-radius:10px;min-height:40px;}',
    '.mask-tools button.on{border-color:#2f7cf6;background:rgba(47,124,246,.18);color:#dbe9ff;}',
    '.mask-tools button:disabled{opacity:.42;}',
    '.mask-hint{margin:2px 16px 0;font-size:12.5px;color:#8fd0a8;text-align:center;}',
    '.mask-hint[hidden]{display:none;}',
    '.mask-foot{flex:0 0 auto;display:flex;gap:10px;padding:10px 12px 18px;}',
    '.mask-foot button{flex:1 1 0;min-height:48px;border-radius:12px;font-size:15px;border:1px solid transparent;}',
    '#mask-skip{background:rgba(255,255,255,.08);color:#cfd8e4;border-color:rgba(255,255,255,.14);}',
    '#mask-done{background:linear-gradient(180deg,#2f7cf6,#2566d6);color:#fff;}',
    '.mask-foot button:disabled{opacity:.55;}'
  ].join('');

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'hidden') n.hidden = !!attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (text) n.textContent = text;
    return n;
  }

  function readSaved() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !Array.isArray(o.boxes) || !o.boxes.length) return null;
      var ok = o.boxes.every(function (b) {
        return b && isFinite(b.x) && isFinite(b.y) && isFinite(b.w) && isFinite(b.h)
          && b.w > 0 && b.h > 0;
      });
      return ok ? o : null;
    } catch (e) { return null; }
  }

  function saveSaved() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        v: 1,
        ratio: +(img.width / img.height).toFixed(4),
        boxes: boxes.map(function (b) {
          return { x: +b.x.toFixed(4), y: +b.y.toFixed(4), w: +b.w.toFixed(4), h: +b.h.toFixed(4) };
        }),
      }));
    } catch (e) { /* 存储被禁：不记忆也不阻断上传 */ }
  }

  function clearSaved() {
    try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
  }

  function redraw() {
    if (!ctx) return;
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    var all = boxes.concat(drawing ? [drawing] : []);
    all.forEach(function (b) {
      ctx.fillRect(Math.round(b.x * W), Math.round(b.y * H), Math.round(b.w * W), Math.round(b.h * H));
    });
  }

  function fit() {
    if (!img || !stage) return;
    var r = stage.getBoundingClientRect();
    var s = Math.min(r.width / img.width, r.height / img.height);
    if (!isFinite(s) || s <= 0) s = 1;
    canvas.style.width = Math.max(1, Math.round(img.width * s)) + 'px';
    canvas.style.height = Math.max(1, Math.round(img.height * s)) + 'px';
  }

  function pos(e) {
    var r = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  function syncUndo() {
    if (!layer) return;
    var u = layer.querySelector('[data-tool="undo"]');
    if (u) u.disabled = boxes.length === 0;
  }

  function close() {
    if (!layer) return;
    layer.parentNode && layer.parentNode.removeChild(layer);
    layer = null; canvas = null; ctx = null; img = null; stage = null;
    boxes = []; drawing = null; hintEl = null;
    busy = false;
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
  }

  function onKey(e) {
    if (e.key === 'Escape' && layer) { finish(false); }
  }

  function finish(useMask) {
    if (busy) return;
    busy = true;
    var done = onDone; onDone = null;
    var src = layer;
    var W = canvas ? canvas.width : 0;
    // 没有涂抹块：等同跳过，不重编码、不丢画质
    if (!useMask || !boxes.length || !W) {
      close();
      if (done) done(null, { skipped: true });
      return;
    }
    saveSaved();
    var btn = src && src.querySelector('#mask-done');
    if (btn) { btn.disabled = true; btn.textContent = '合成中…'; }
    canvas.toBlob(function (blob) {
      close();
      if (!blob) { if (done) done(null, { skipped: true }); return; }
      var name = (fileName || 'ticket').replace(/\.(jpe?g|png|webp|bmp)$/i, '') + '_masked.png';
      var out;
      try { out = new File([blob], name, { type: 'image/png' }); }
      catch (e) { out = blob; }
      if (done) done(out, { masked: true });
    }, 'image/png');
  }

  function build() {
    layer = el('div', { class: 'mask-layer', id: 'mask-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '上传前遮挡' });
    var head = el('div', { class: 'mask-head' });
    head.appendChild(el('h2', null, '遮挡姓名与资金账号（可选）'));
    head.appendChild(el('p', null,
      '遮掉姓名和资金账号后，成交明细仍可正常识别。识别需要联网，上传的就是这张遮好的图；只遮顶部账号信息，别遮下面的成交明细，遮住明细会影响识别。'));

    stage = el('div', { class: 'mask-stage' });
    canvas = el('canvas', { class: 'mask-canvas', id: 'mask-canvas' });
    canvas.width = img.width;
    canvas.height = img.height;
    ctx = canvas.getContext('2d');
    stage.appendChild(canvas);

    var tools = el('div', { class: 'mask-tools' });
    var pen = el('button', { type: 'button', 'data-tool': 'pen', class: 'tool on' }, '遮挡笔');
    var undo = el('button', { type: 'button', 'data-tool': 'undo' }, '撤销');
    var clr = el('button', { type: 'button', 'data-tool': 'clear' }, '清空');
    var rst = el('button', { type: 'button', 'data-tool': 'restore' }, '还原原图');
    tools.appendChild(pen); tools.appendChild(undo); tools.appendChild(clr); tools.appendChild(rst);

    hintEl = el('p', { class: 'mask-hint', id: 'mask-hint', hidden: true }, '已套用上次的遮挡位置，可微调');

    var foot = el('div', { class: 'mask-foot' });
    var skip = el('button', { type: 'button', id: 'mask-skip' }, '跳过遮挡，直接上传');
    var ok = el('button', { type: 'button', id: 'mask-done' }, '确认遮挡并上传');
    foot.appendChild(skip); foot.appendChild(ok);

    layer.appendChild(head);
    layer.appendChild(stage);
    layer.appendChild(tools);
    layer.appendChild(hintEl);
    layer.appendChild(foot);

    var style = document.createElement('style');
    style.textContent = CSS;
    layer.appendChild(style);

    pen.addEventListener('click', function () { /* 只有一支笔，点击只做状态提示 */ });
    undo.addEventListener('click', function () { boxes.pop(); redraw(); syncUndo(); });
    clr.addEventListener('click', function () { boxes = []; redraw(); syncUndo(); });
    rst.addEventListener('click', function () {
      boxes = []; hintEl.hidden = true; clearSaved(); redraw(); syncUndo();
    });
    skip.addEventListener('click', function () { finish(false); });
    ok.addEventListener('click', function () { finish(true); });

    canvas.addEventListener('pointerdown', function (e) {
      if (busy) return;
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      var p = pos(e);
      drawing = { x: p.x, y: p.y, w: 0, h: 0 };
      redraw();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      var p = pos(e);
      drawing.w = p.x - drawing.x;
      drawing.h = p.y - drawing.y;
      redraw();
    });
    function endStroke() {
      if (!drawing) return;
      var b = drawing; drawing = null;
      var x = b.w < 0 ? b.x + b.w : b.x;
      var y = b.h < 0 ? b.y + b.h : b.y;
      var w = Math.abs(b.w), h = Math.abs(b.h);
      // 太小当作误触，忽略
      if (w < 0.008 || h < 0.008) { redraw(); return; }
      boxes.push({ x: x, y: y, w: w, h: h });
      redraw(); syncUndo();
    }
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);

    document.body.appendChild(layer);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    fit();
    redraw();
    syncUndo();
  }

  function open(file, done) {
    if (!file || layer) return;
    if (!/(^image\/|\.(jpe?g|png|webp|bmp|heic|heif)$)/i.test(file.type || file.name || '')) {
      // 非图片不拦截，直接交给原流程
      if (done) done(null, { skipped: true });
      return;
    }
    onDone = done; fileName = file.name || '';
    var url = URL.createObjectURL(file);
    img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      build();
      var saved = readSaved();
      var ratio = img.width / img.height;
      if (saved && Math.abs(saved.ratio - ratio) <= RATIO_TOL) {
        boxes = saved.boxes.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h }; });
        if (hintEl) hintEl.hidden = false;
        redraw(); syncUndo();
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      close();
      if (done) done(null, { skipped: true });
    };
    img.src = url;
  }

  root.PanjiMask = { open: open };
})();
