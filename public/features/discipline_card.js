/* 纪律随身卡：悬浮窗 / 画中画 / 首页入口共用的唯一取数与字段清单（20261109）
 *
 * 存储键：guanzhu_discipline_v1 → { v, saved_at, card: { slots:{ban1..edge1}, times:{t1,t2} } }
 * 取数优先级：页面 DOM（输入有 300ms 防抖，可能还没落盘）> 存储（已落盘）。
 *   - 只认整份卡片：DOM 有字就用 DOM；DOM 整份为空才回退存储。
 *   - 两形态都只渲染 items() 返回的同一个数组，字段清单不再各写一套。
 */
(function () {
  'use strict';
  if (window.PanjiDisciplineCard) return;

  var KEY = 'guanzhu_discipline_v1';
  var TITLE = '纪律随身卡';
  var SLOT_ORDER = ['ban1', 'ban2', 'ban3', 'ask1', 'ask2', 'ask3', 'edge1'];
  var GROUP_LABEL = { ban: '三条禁止', ask: '下单前三问', edge: '一句话边界' };
  var TIME_LABEL = '读卡时点';

  function clean(v) { return String(v == null ? '' : v).trim(); }

  function readStored() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { o = {}; }
    return (o && o.card && typeof o.card === 'object') ? o.card : null;
  }

  function readDom() {
    if (typeof document === 'undefined') return null;
    var root = document.querySelector('.dw');
    if (!root || !root.querySelector('.slot')) return null;
    var out = { slots: {}, times: {} };
    Array.prototype.forEach.call(root.querySelectorAll('.slot'), function (s) {
      var id = s.getAttribute('data-slot');
      if (!id) return;
      var t = s.querySelector('[data-f="title"]');
      var b = s.querySelector('[data-f="body"]');
      out.slots[id] = { title: t ? t.value : '', body: b ? b.value : '' };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-time]'), function (i) {
      var k = i.getAttribute('data-time');
      if (k) out.times[k] = i.value || '';
    });
    return out;
  }

  function hasContent(card) {
    if (!card) return false;
    var slots = card.slots || {};
    var times = card.times || {};
    if (clean(times.t1) || clean(times.t2)) return true;
    return SLOT_ORDER.some(function (id) {
      var s = slots[id] || {};
      return !!clean(s.title) || !!clean(s.body);
    });
  }

  function current() {
    var dom = readDom();
    if (hasContent(dom)) return dom;
    var stored = readStored();
    if (hasContent(stored)) return stored;
    return dom || stored || { slots: {}, times: {} };
  }

  function items(card) {
    card = card || current();
    var slots = card.slots || {};
    var times = card.times || {};
    var out = [];
    var last = '';
    SLOT_ORDER.forEach(function (id) {
      var s = slots[id] || {};
      var t = clean(s.title);
      var b = clean(s.body);
      if (!t && !b) return;
      var g = id.replace(/\d+$/, '');
      if (GROUP_LABEL[g] && GROUP_LABEL[g] !== last) {
        last = GROUP_LABEL[g];
        out.push({ label: last, title: '', body: '' });
      }
      out.push({ label: '', title: t, body: b });
    });
    var t1 = clean(times.t1);
    var t2 = clean(times.t2);
    if (t1 || t2) out.push({ label: TIME_LABEL, title: '', body: [t1, t2].filter(Boolean).join(' · ') });
    return out;
  }

  function payload(card) {
    var c = card || current();
    var its = items(c);
    return {
      title: TITLE,
      items: its,
      json: JSON.stringify({ title: TITLE, items: its }),
      count: its.length,
      empty: !hasContent(c)
    };
  }

  window.PanjiDisciplineCard = {
    KEY: KEY,
    TITLE: TITLE,
    SLOT_ORDER: SLOT_ORDER,
    readStored: readStored,
    readDom: readDom,
    hasContent: hasContent,
    current: current,
    items: items,
    payload: payload
  };
})();
