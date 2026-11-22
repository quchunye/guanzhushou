/* 看不了三态的图形与文案（A 锁档 / B 无数据 / C 读取失败）
   一个文件给两个页面用：archive.html 取 lock()，replay.html 取 fail(code)。
   纯字符串，无 DOM 依赖；颜色在 styles/unviewable.css 里按 .uv-a / .uv-b / .uv-c 分组。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PanjiUnviewable = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const ART = {
    a: '<svg class="uv-art uv-a{ANIM}" viewBox="0 0 100 100" width="132" height="132" aria-hidden="true">'
      + '<ellipse class="uv-ground" cx="50" cy="89" rx="26" ry="3.4"/>'
      + '<g class="uv-lock"><g class="uv-shackle-g">'
      + '<path class="uv-shackle" d="M35 47 A15 15 0 0 1 65 47"/></g>'
      + '<rect class="uv-body" x="24" y="46" width="52" height="40" rx="11"/>'
      + '<line class="uv-seam" x1="28" y1="55" x2="72" y2="55"/>'
      + '<circle class="uv-warm" cx="50" cy="66" r="4.4"/>'
      + '<rect class="uv-warm" x="48.4" y="68" width="3.2" height="8.5" rx="1.6"/>'
      + '</g></svg>',
    b: '<svg class="uv-art uv-b{ANIM}" viewBox="0 0 100 100" width="128" height="128" aria-hidden="true">'
      + '<rect class="uv-frame" x="12" y="20" width="76" height="64" rx="8"/>'
      + '<path class="uv-line" d="M21 68 L31 55 L41 61 L51 46"/>'
      + '<line class="uv-gap" x1="51" y1="46" x2="66" y2="46"/>'
      + '<g class="uv-flag">'
      + '<line class="uv-pole" x1="51" y1="46" x2="51" y2="31"/>'
      + '<path class="uv-flag-s" d="M52 31 L64 35 L52 39 Z"/>'
      + '</g></svg>',
    c: '<svg class="uv-art uv-c{ANIM}" viewBox="0 0 150 100" width="150" height="100" aria-hidden="true">'
      + '<rect class="uv-socket" x="112" y="36" width="30" height="28" rx="9"/>'
      + '<rect class="uv-hole" x="113" y="44" width="7" height="4" rx="2"/>'
      + '<rect class="uv-hole" x="113" y="52" width="7" height="4" rx="2"/>'
      + '<g class="uv-plug">'
      + '<path class="uv-cord" d="M72 50 C 58 50 54 56 44 60"/>'
      + '<rect class="uv-pin" x="104" y="43" width="9" height="3.6" rx="1.8"/>'
      + '<rect class="uv-pin" x="104" y="53.4" width="9" height="3.6" rx="1.8"/>'
      + '<rect class="uv-plug-body" x="72" y="37" width="32" height="26" rx="9"/>'
      + '<circle class="uv-led" cx="86" cy="50" r="3.6"/>'
      + '</g></svg>',
  };

  function art(kind, anim) {
    const t = ART[kind] || ART.c;
    return t.replace('{ANIM}', anim ? ' uv-anim' : '');
  }

  // A：档案时间线的锁定块。整块落在页底 #070b16 上，不继承 .ac-lock 的 --card2。
  function lock(n, anim) {
    const days = Number(n) || 0;
    return '<div class="ac-lock ac-lock-art">' + art('a', anim)
      + '<b>还有 ' + days + ' 次复盘没打开</b>'
      + '<span>发生了什么：这 ' + days + ' 天的记录没进时间线，跨日期对比也对不上。</span>'
      + '<span>下一步：点下面的「解锁这只票」；暂时不解锁不影响免费层继续复盘。</span>'
      + '</div>';
  }

  // B/C：回放页的分片失败。no_shard 走 B，其余（load / timeout / forbidden）走 C。
  function fail(code) {
    const b = code === 'no_shard';
    const t = b ? '这段回放没有数据' : '这份数据没读出来';
    const what = b
      ? '发生了什么：这只票在这个窗口里没有打包，可能是当天没成交，也可能是数据还没补上。'
      : '发生了什么：这次请求没拿到数据，网络中断、通行证过期或文件损坏都会这样。';
    const next = b
      ? '下一步：换一个窗口或日期再看；图上画的是示意，不是这只票当天的走势。'
      : '下一步：再选一次标的或窗口重新加载；一直读不出来就换一个窗口。';
    return '<div class="uv-note">' + art(b ? 'b' : 'c', true)
      + '<b>' + t + '</b><p>' + what + '</p><p>' + next + '</p></div>';
  }

  return { art: art, lock: lock, fail: fail };
});
