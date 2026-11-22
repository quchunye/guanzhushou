/* compat.js —— 老 WebKit 兼容层（20261104）
 *
 * 背景：iPad 第 7 代 / iPadOS 18.7 Safari 上 AbortSignal.timeout 不存在，
 *       复核页「确认无误，生成档案」在 app.js:772 评估 signal 参数时直接抛异常，
 *       请求根本没发出，只剩一条「AbortSignal.timeout is not a function」错误条。
 *
 * 原则：只在原生缺失时兜底，原生存在时不覆盖；不改变现有调用点。
 */
(function (win) {
  'use strict';

  var AS = win.AbortSignal;
  if (!AS) return;   // 连 AbortSignal 都没有的老环境，本项目也不支持

  var TIMER = '__panjiCompatTimer';   // 定时器句柄挂在信号上，供 fetch 结束后清理
  var installedTimeout = false;

  function timeoutError() {
    try {
      return new DOMException('signal timed out', 'TimeoutError');
    } catch (e) {
      var err = new Error('signal timed out');
      err.name = 'TimeoutError';
      return err;
    }
  }

  function defineStatic(name, fn) {
    try {
      Object.defineProperty(AS, name, { value: fn, writable: true, configurable: true, enumerable: false });
    } catch (e) {
      AS[name] = fn;
    }
  }

  if (typeof AS.timeout !== 'function' && typeof win.AbortController === 'function') {
    defineStatic('timeout', function (ms) {
      var ctrl = new win.AbortController();
      var id = setTimeout(function () {
        try { delete ctrl.signal[TIMER]; } catch (e) { /* 忽略 */ }
        ctrl.abort(timeoutError());
      }, ms);
      try { ctrl.signal[TIMER] = id; } catch (e) { /* 忽略 */ }
      // 提前 abort 时立刻清钟，不让 75 秒的定时器空转
      ctrl.signal.addEventListener('abort', function () {
        clearTimeout(id);
        try { delete ctrl.signal[TIMER]; } catch (e) { /* 忽略 */ }
      });
      return ctrl.signal;
    });
    installedTimeout = true;
  }

  // 只有真的装了兜底才包 fetch：原生可用时一行都不动，避免行为漂移
  if (installedTimeout && typeof win.fetch === 'function') {
    var rawFetch = win.fetch;
    var clearTimer = function (sig) {
      if (!sig) return;
      var id = sig[TIMER];
      if (id === undefined) return;
      if (Array.isArray(id)) {
        for (var i = 0; i < id.length; i++) clearTimeout(id[i]);
      } else {
        clearTimeout(id);
      }
      try { delete sig[TIMER]; } catch (e) { /* 忽略 */ }
    };
    win.fetch = function (input, init) {
      var p = rawFetch.apply(this, arguments);
      var sig = init && init.signal;
      // 请求正常返回或失败都必须清钟：每次请求留一个 75 秒定时器会越积越多
      if (sig) {
        p.then(function () { clearTimer(sig); }, function () { clearTimer(sig); });
      }
      return p;
    };
  }
})(window);
