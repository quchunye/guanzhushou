/* 档案页 · 解锁入口（独立模块）
 *
 * 挂载点由 archive.js 提供：锁定提示模板里留 <div class="ac-unlock-slot"></div>，
 * render() 在 el.innerHTML = html 之后调 mount(slot, code)。本模块不监听 DOM，
 * 每次 mount 先清空容器再渲染当前状态，因此五处重绘不会叠加出多个按钮。
 *
 * 显示条件（硬要求）：
 *   window.PJL_GATE.ready === true && PanjiLicenseUI.gateActive() === true
 *   且 PJL_GATE.canView('stock:NNNNNN') === false
 *   任一不满足 → 清空容器并 hidden，零元素。
 *   刚解锁成功的 4 秒内例外，只显示「已解锁」反馈。
 *
 * 点击流程：
 *   入口 → 确认（这只票 / 消耗 1 解锁点 / 剩余 N 点，N 来自 remaining().total）
 *        → PanjiLicenseUI.unlock()（走 license.js 的 pending → 请求 → 写账本）
 *        → 成功：原地显示「已解锁」，不刷新、不弹窗；档案深度区由 archive.js
 *          既有的 PanjiLicenseUI.onChange 订阅重绘。
 *        → 失败：按 license.js 分类给文案，402 / 409 / PENDING 三套严格分开。
 *   余额 0：按钮 disabled，附一行按 QUOTA_PERIOD 生成的说明。
 *   无会话：显示登录引导 + 「去登录」，不静默。
 *
 * 额度周期事实（2026-11-08 拍板：免费档按周发放）：
 *   每个自然周（周一 00:00 到周日 23:59:59.999，上海时区）首次签发发满 giftAmount（默认 2），当周有效；
 *   同周重复签发不叠加、保留剩余，跨周重新发满，用不完不结转。
 *   QUOTA_PERIOD.reset=true，三处可见文案带「本周 / 下周一」。
 *
 * 文案来源：能从 PanjiLicenseFactory.MESSAGES 取的一律取，避免两套措辞漂移。
 * 样式：只用 archive.html 已有 class 与 token，不新增色值和字号。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PanjiArchiveUnlock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var G = typeof globalThis !== 'undefined' ? globalThis : {};

  var SUCCESS_MS = 4000;
  var LOGIN_URL = 'login.html';

  // 额度周期是唯一取值：按周发放（上海时区自然周），reset=true 时文案自动带「本周 / 下周一」。
  // 若有一天回到一次性赠送，只把 reset 改回 false，三处文案自动去掉「本周」。
  var QUOTA_PERIOD = {
    reset: true,
    unit: '本周',
    next: '下周一'
  };

  var TXT = {
    ENTRY: '解锁这只票 · 消耗 1 点',
    CONFIRM_BTN: '确认解锁 · 消耗 1 点',
    CANCEL: '取消',
    BUSY: '正在解锁，请稍候…',
    SUCCESS_CHIP: '已解锁',
    SUCCESS_NOTE: '这只票的深度档案已打开。',
    QUOTA: '本周解锁点已用完；已解锁档案仍可查看',
    CONFLICT: '解锁请求冲突，请重新发起',
    PENDING: '额度已扣，档案将于下次打开时恢复',
    NO_SESSION: '解锁需要登录。登录后回到这一页，再点一次解锁。',
    LOGIN_BTN: '去登录',
    CLOCK: '检测到系统时间被调早，新解锁已暂停；已解锁的档案仍可查看。校正系统时间后刷新即可恢复。',
    BAD_CODE: '这只票的代码无法识别，暂时不能解锁。',
    STORAGE: '本机存储写入失败，暂时不能解锁。请检查浏览器存储设置后再试。',
    DEFAULT: '解锁没有成功，请稍后再试。'
  };

  var state = {
    container: null,
    code: '',
    mode: 'idle',          // idle | confirm | busy | success | error
    error: null,
    successUntil: 0,
    successCode: '',
    timer: null
  };

  /* ---------------- 底座 ---------------- */

  function dom() {
    return G.document || null;
  }

  function now() {
    return Date.now();
  }

  function digits(v) {
    return String(v == null ? '' : v).replace(/\D/g, '');
  }

  function code6() {
    return state.code.slice(-6);
  }

  function stockKey() {
    var s = digits(state.code);
    if (!/^\d{6}$/.test(s)) return '';
    var gate = G.PJL_GATE;
    if (gate && typeof gate.normalizeCode === 'function') {
      return String(gate.normalizeCode('stock:' + s) || '');
    }
    return 'stock:' + s;
  }

  function msgText(key, fallback) {
    var f = G.PanjiLicenseFactory;
    var m = f && f.MESSAGES;
    return (m && typeof m[key] === 'string' && m[key]) ? m[key] : fallback;
  }

  function later(fn, ms) {
    var st = G.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
    if (!st) return null;
    var t = st(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();   // 测试进程不被 4 秒定时器拖住
    return t;
  }

  function clearLater(t) {
    var ct = G.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : null);
    if (t && ct) ct(t);
  }

  function mk(tag, cls, text) {
    var d = dom();
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clearChildren(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function action(node, name, fn) {
    node.setAttribute('data-action', name);
    node.addEventListener('click', fn);
    return node;
  }

  /* ---------------- 判定 ---------------- */

  function balance() {
    var ui = G.PanjiLicenseUI;
    if (!ui || typeof ui.remaining !== 'function') return { total: 0, periodEnd: 0 };
    var r = ui.remaining() || {};
    return {
      total: Math.max(0, Number(r.total) || 0),
      periodEnd: Number(r.periodEnd) || 0
    };
  }

  /** 快照：visible=false 时调用方必须清空容器，不能留任何元素 */
  function snapshot() {
    var gate = G.PJL_GATE;
    var ui = G.PanjiLicenseUI;
    if (!gate || gate.ready !== true) return { visible: false };
    if (!ui || typeof ui.gateActive !== 'function' || !ui.gateActive()) return { visible: false };

    var key = stockKey();
    if (!key) return { visible: false };

    var canView = typeof gate.canView === 'function' ? !!gate.canView(key) : true;
    var success = state.mode === 'success' && state.successCode === key && now() < state.successUntil;
    if (canView && !success) return { visible: false };

    var r = balance();
    return {
      visible: true,
      success: success,
      key: key,
      code: code6(),
      mode: success ? 'success' : state.mode,
      error: state.error,
      total: r.total,
      periodEnd: r.periodEnd
    };
  }

  /* ---------------- 文案 ---------------- */

  function resetText() {
    // 周周期固定：下一个周一 00:00 恢复，不再按 period_end 算「几号」
    return QUOTA_PERIOD.next === '下周一' ? '下周一恢复' : QUOTA_PERIOD.next + '恢复';
  }

  function emptyText() {
    if (!QUOTA_PERIOD.reset) return '解锁点已用完，已解锁的档案不受影响。';
    return QUOTA_PERIOD.unit + '解锁点已用完，' + resetText() + '。已解锁的档案仍可查看。';
  }

  function confirmText(code, n) {
    var left = QUOTA_PERIOD.reset ? QUOTA_PERIOD.unit + '还剩 ' + n + ' 点' : '还剩 ' + n + ' 点';
    return '解锁「' + code + '」的完整档案？消耗 1 点，' + left + '。';
  }

  /** license.js 的失败分类 → 页面文案。402 / 409 / PENDING 绝不混用 */
  function mapError(res) {
    res = res || {};
    var code = String(res.code || '');
    var status = Number(res.status) || 0;

    if (code === 'NO_SESSION' || code === 'ONLINE_REQUIRED') {
      return { code: code, message: TXT.NO_SESSION, tone: 'calm', login: true, retry: false };
    }
    if (code === 'QUOTA_EXHAUSTED' || status === 402) {
      return { code: code, message: res.message || msgText('QUOTA', TXT.QUOTA), tone: 'calm', login: false, retry: false };
    }
    if (code === 'UNLOCK_ID_CONFLICT' || status === 409) {
      return { code: code, message: res.message || msgText('CONFLICT', TXT.CONFLICT), tone: 'warn', login: false, retry: true };
    }
    if (code === 'PENDING') {
      return { code: code, message: res.message || msgText('PENDING', TXT.PENDING), tone: 'calm', login: false, retry: false };
    }
    if (code === 'CLOCK_SUSPECT') {
      return { code: code, message: TXT.CLOCK, tone: 'warn', login: false, retry: false };
    }
    if (code === 'BAD_CODE' || code === 'BAD_NAMESPACE' || code === 'BAD_UNLOCK_ID') {
      return { code: code, message: TXT.BAD_CODE, tone: 'warn', login: false, retry: false };
    }
    if (code === 'STORAGE_FAILED') {
      return { code: code, message: TXT.STORAGE, tone: 'warn', login: false, retry: true };
    }
    return { code: code || 'UNKNOWN', message: TXT.DEFAULT, tone: 'warn', login: false, retry: true };
  }

  /* ---------------- 交互 ---------------- */

  function onEntry() {
    if (state.mode === 'busy') return;
    var snap = snapshot();
    if (!snap.visible || snap.total <= 0) { paint(); return; }
    state.mode = 'confirm';
    state.error = null;
    paint();
  }

  function onCancel() {
    state.mode = 'idle';
    state.error = null;
    paint();
  }

  function onLogin() {
    try {
      if (G.location) G.location.href = LOGIN_URL;
    } catch (e) { /* 极端环境不能跳转也不静默：按钮本身已说明需要登录 */ }
  }

  function afterUnlock(res) {
    if (res && res.ok) {
      state.mode = 'success';
      state.error = null;
      state.successCode = stockKey();
      state.successUntil = now() + SUCCESS_MS;
      clearLater(state.timer);
      state.timer = later(function () {
        state.timer = null;
        state.mode = 'idle';
        state.successUntil = 0;
        state.successCode = '';
        paint();
      }, SUCCESS_MS);
      paint();
      return;
    }
    state.mode = 'error';
    state.error = mapError(res || {});
    paint();
  }

  function onConfirm() {
    if (state.mode === 'busy') return;
    var ui = G.PanjiLicenseUI;
    var key = stockKey();
    if (!ui || typeof ui.unlock !== 'function' || !key) {
      state.mode = 'error';
      state.error = mapError({ code: 'ONLINE_REQUIRED' });
      paint();
      return;
    }
    state.mode = 'busy';
    state.error = null;
    paint();

    var p;
    try {
      p = ui.unlock(key, { from: 'archive' });
    } catch (e) {
      p = Promise.reject(e);
    }
    Promise.resolve(p).then(function (res) {
      afterUnlock(res);
    }).catch(function () {
      afterUnlock({ ok: false, code: 'NETWORK' });
    });
  }

  /* ---------------- 渲染 ---------------- */

  function paint() {
    var c = state.container;
    if (!c) return;
    var snap = snapshot();
    var sig = [
      snap.visible ? '1' : '0',
      snap.success ? 's' : '',
      snap.mode || '',
      snap.error ? snap.error.code : '',
      snap.total == null ? '' : snap.total,
      snap.periodEnd == null ? '' : snap.periodEnd,
      snap.code || ''
    ].join('|');

    c.hidden = !snap.visible;
    if (c.__pjlUnlockSig === sig) return;
    c.__pjlUnlockSig = sig;

    clearChildren(c);
    if (!snap.visible) return;

    if (snap.success) {
      var row = mk('div', 'ac-wins');
      row.appendChild(mk('span', 'ac-chip ok', TXT.SUCCESS_CHIP));
      row.appendChild(mk('span', 'ac-empty', TXT.SUCCESS_NOTE));
      c.appendChild(row);
      return;
    }

    if (snap.mode === 'busy') {
      c.appendChild(mk('p', 'ac-empty', TXT.BUSY));
      return;
    }

    if (snap.mode === 'confirm') {
      c.appendChild(mk('p', 'ac-empty', confirmText(snap.code, snap.total)));
      var act = mk('div', 'ac-wins');
      var okBtn = action(mk('button', 'ac-claim', TXT.CONFIRM_BTN), 'confirm', onConfirm);
      okBtn.type = 'button';
      var cancelBtn = action(mk('button', 'ac-export', TXT.CANCEL), 'cancel', onCancel);
      cancelBtn.type = 'button';
      act.appendChild(okBtn);
      act.appendChild(cancelBtn);
      c.appendChild(act);
      return;
    }

    if (snap.mode === 'error' && snap.error) {
      c.appendChild(mk('div', snap.error.tone === 'calm' ? 'ac-empty' : 'ac-plead', snap.error.message));
      if (snap.error.login) {
        var loginBtn = action(mk('button', 'ac-claim', TXT.LOGIN_BTN), 'login', onLogin);
        loginBtn.type = 'button';
        c.appendChild(loginBtn);
      } else if (snap.error.retry) {
        var retryBtn = action(mk('button', 'ac-claim', TXT.ENTRY), 'unlock', onEntry);
        retryBtn.type = 'button';
        retryBtn.disabled = snap.total <= 0;
        c.appendChild(retryBtn);
      }
      return;
    }

    var btn = action(mk('button', 'ac-claim', TXT.ENTRY), 'unlock', onEntry);
    btn.type = 'button';
    btn.disabled = snap.total <= 0;
    c.appendChild(btn);
    if (snap.total <= 0) c.appendChild(mk('p', 'ac-empty', emptyText()));
  }

  /* ---------------- 挂载 ---------------- */

  function mount(container, code) {
    // 幂等：每次进来先断开旧容器、清空新容器，再按当前状态渲染
    if (state.container && state.container !== container) {
      clearChildren(state.container);
      state.container.hidden = true;
    }
    state.container = container || null;
    state.code = digits(code);
    state.mode = 'idle';
    state.error = null;
    state.successUntil = 0;
    state.successCode = '';
    clearLater(state.timer);
    state.timer = null;

    if (container) {
      clearChildren(container);
      container.__pjlUnlockSig = '';
      paint();
    }

    return {
      refresh: function () { paint(); },
      unmount: function () {
        if (state.container) {
          clearChildren(state.container);
          state.container.hidden = true;
          state.container.__pjlUnlockSig = '';
        }
        state.container = null;
      },
      state: function () {
        return { code: state.code, mode: state.mode, error: state.error };
      }
    };
  }

  function refresh() {
    paint();
  }

  return {
    mount: mount,
    refresh: refresh
  };
});
