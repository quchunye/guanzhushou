/* features/snapshot.js —— 快照读取层（第一段：只有读取侧）
 *
 * 目标：对外只给一个入口 resolveSnapshot()，随包源与远端快照源返回同一形状的
 * panji.builtin.index.v1；下游（parseKlines / 按日切片）不需要知道数据来自哪里。
 *
 * 约束：
 *   1) snapshotAuto 默认 false：默认仍走随包 builtin/，行为与改造前一致；
 *   2) 远端只读「清单」与清单 base 拼出的分片地址，不走旧目录/票据接口；
 *   3) 检查更新（checkUpdate）不受开关约束，常驻可用；
 *   4) 任何远端失败都回落随包数据，不出现空态。
 *
 * 本文件不修改 replay.js / replay.html；接线由后续会话按设计稿 §4.1 进行。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.PanjiSnapshot = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const MANIFEST_URL = '/api/snapshot/manifest';
  const MANIFEST_SCHEMA = 'panji.snapshot.manifest.v1';
  const INDEX_SCHEMA = 'panji.builtin.index.v1';
  const BUNDLE_DIR = 'builtin/';

  const T_MANIFEST = 4000;    // 清单 4 s（设计稿 §4.5）
  const T_SHARD = 20000;      // 分片 20 s
  const T_BUNDLE = 12000;     // 随包索引（壳内本地读，给足余量）

  const IDB_NAME = 'panji_snapshot';
  const IDB_STORE = 'files';
  const META_KEY = 'meta';
  const VERSION_PREFIX = 'snapshot/';

  function fetchImpl(o) {
    if (o && typeof o.fetch === 'function') return o.fetch;
    return (root && typeof root.fetch === 'function') ? root.fetch.bind(root) : null;
  }

  function bareCode(code) {
    const s = String(code == null ? '' : code).replace(/\D/g, '');
    return s.length >= 6 ? s.slice(-6) : '';
  }

  function bufToText(buf) {
    if (typeof buf === 'string') return buf;
    try {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(buf);
    } catch (e) { /* 走兜底 */ }
    try {
      const u = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return decodeURIComponent(escape(s));
    } catch (e) { return null; }
  }

  // 真超时：到点 abort；没有 AbortController 时退化为「到点不再等」，请求自会被丢弃
  function timedFetch(f, url, ms, init) {
    const baseInit = Object.assign({}, init || {});
    const AC = (typeof AbortController === 'function') ? AbortController : (root && root.AbortController);
    let ctl = null;
    if (AC && ms > 0) {
      try { ctl = new AC(); baseInit.signal = ctl.signal; } catch (e) { ctl = null; }
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(v);
      };
      if (ms > 0) {
        timer = setTimeout(() => {
          try { if (ctl) ctl.abort(); } catch (e) { /* 忽略 */ }
          done({ ok: false, timeout: true, status: 0 });
        }, ms);
      }
      Promise.resolve().then(() => f(url, baseInit)).then((res) => {
        if (!res || !res.ok) return done({ ok: false, status: (res && res.status) || 0 });
        if (typeof res.arrayBuffer !== 'function') {
          return Promise.resolve(res.text()).then(
            (txt) => done({ ok: true, status: res.status, buf: txt }),
            () => done({ ok: false, status: (res && res.status) || 0 })
          );
        }
        return Promise.resolve(res.arrayBuffer()).then(
          (buf) => done({ ok: true, status: res.status, buf: buf }),
          () => done({ ok: false, status: (res && res.status) || 0 })
        );
      }, () => done({ ok: false, status: 0, timeout: true }));
    });
  }

  function sha256Hex(buf) {
    const sub = root && root.crypto && root.crypto.subtle;
    if (!sub || typeof sub.digest !== 'function') return Promise.reject(new Error('verify_unsupported'));
    const bytes = (buf instanceof ArrayBuffer) ? buf : new Uint8Array(buf);
    return Promise.resolve(sub.digest('SHA-256', bytes)).then((d) => {
      const u = new Uint8Array(d);
      let hex = '';
      for (let i = 0; i < u.length; i++) hex += (u[i] < 16 ? '0' : '') + u[i].toString(16);
      return hex;
    });
  }

  /* ---------------- IndexedDB（存远端快照：index 文本 + 分片原始 gz 字节） ---------------- */
  function idbOpen() {
    const g = root && (root.indexedDB || root.webkitIndexedDB || root.mozIndexedDB);
    if (!g) return Promise.resolve(null);
    return new Promise((resolve) => {
      let req;
      try { req = g.open(IDB_NAME, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (db && !db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    }).catch(() => null);
  }

  function idbGet(key) {
    if (!key) return Promise.resolve(null);
    return idbOpen().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
          rq.onsuccess = () => resolve(rq.result == null ? null : rq.result);
          rq.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    }).catch(() => null);
  }

  function idbPut(key, val) {
    if (!key || val == null) return Promise.resolve(false);
    return idbOpen().then((db) => {
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(val, key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch (e) { resolve(false); }
      });
    }).catch(() => false);
  }

  function idbKeys(prefix) {
    return idbOpen().then((db) => {
      if (!db) return [];
      return new Promise((resolve) => {
        const out = [];
        try {
          const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).openCursor();
          rq.onsuccess = () => {
            const cur = rq.result;
            if (!cur) return resolve(out);
            const k = String(cur.key);
            if (!prefix || k.indexOf(prefix) === 0) out.push(k);
            cur.continue();
          };
          rq.onerror = () => resolve(out);
        } catch (e) { resolve(out); }
      });
    }).catch(() => []);
  }

  function idbDelete(keys) {
    if (!keys || !keys.length) return Promise.resolve();
    return idbOpen().then((db) => {
      if (!db) return;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          const st = tx.objectStore(IDB_STORE);
          keys.forEach((k) => st.delete(k));
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (e) { resolve(); }
      });
    }).catch(() => {});
  }

  /* ---------------- 开关：snapshotAuto 默认 false ---------------- */
  // 复用 ext.js 的 PanjiFlag（URL ?f=snapshotAuto、localStorage.guanzhu_flags_v1 都现成）；
  // ext.js 没加载时自己做一份同样的读法，默认一律 false。
  function wantAuto() {
    try {
      if (root && typeof root.PanjiFlag === 'function') return !!root.PanjiFlag('snapshotAuto');
    } catch (e) { /* 走兜底 */ }
    try {
      const q = new URLSearchParams((root.location && root.location.search) || '');
      const f = q.get('f');
      if (f) {
        const names = f.split(',').map((s) => s.trim()).filter(Boolean);
        for (const n of names) {
          if (n === '-snapshotAuto') return false;
          if (n === 'snapshotAuto') return true;
        }
      }
    } catch (e) { /* 非浏览器环境 */ }
    try {
      const raw = root.localStorage && root.localStorage.getItem('guanzhu_flags_v1');
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object' && 'snapshotAuto' in saved) return !!saved.snapshotAuto;
      }
    } catch (e) { /* 读不到按默认 */ }
    return false;
  }

  // 构建期注入的客户端版本（tools/inject_version.js 写 window.__PANJI_VERSION__）
  function clientVersion() {
    const v = (root && root.__PANJI_VERSION__) || {};
    const name = v.versionName == null ? null : String(v.versionName);
    const code = v.versionCode == null ? null : +v.versionCode;
    return { name: name, code: code };
  }

  /* ---------------- 随包索引 ---------------- */
  function validIndex(idx) {
    return !!(idx && idx.schema === INDEX_SCHEMA
      && Array.isArray(idx.windows) && idx.windows.length
      && Array.isArray(idx.symbols) && idx.symbols.length);
  }

  function cutoffFromIndex(idx) {
    let mx = '';
    (idx && idx.windows || []).forEach((w) => { const s = String(w.last || ''); if (s > mx) mx = s; });
    return mx;
  }

  function loadBundleIndex(o) {
    // 本仓不随包分发 builtin 数据（内容库/行情包），调用方可显式关闭，避免无意义的 4xx 请求
    if (o && o.noBundle) return Promise.resolve(null);
    const f = fetchImpl(o);
    if (!f) return Promise.resolve(null);
    const url = (o && o.bundleUrl) || (BUNDLE_DIR + 'index.json');
    const ms = (o && o.timeoutMs) || T_BUNDLE;
    return timedFetch(f, url, ms, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) return null;
      const txt = bufToText(r.buf);
      if (!txt) return null;
      let idx;
      try { idx = JSON.parse(txt); } catch (e) { return null; }
      return validIndex(idx) ? idx : null;
    }).catch(() => null);
  }

  function makePackUrl(source, base) {
    const b = String(base || BUNDLE_DIR);
    const root2 = b.endsWith('/') ? b : b + '/';
    return function packUrl(code, win) {
      const c = bareCode(code);
      if (!c || !win) return '';
      return root2 + 'pack/' + c + '.' + win + '.json.gz';
    };
  }

  /* ---------------- 远端：清单 ---------------- */
  function parseManifest(obj) {
    if (!obj || obj.schema !== MANIFEST_SCHEMA) return null;
    if (!obj.version || !obj.cutoffDay || !obj.base) return null;
    if (!Array.isArray(obj.files) || !obj.files.length) return null;
    if (!obj.index || !obj.index.path || !obj.index.sha256) return null;
    if (obj.counts && obj.counts.files != null && +obj.counts.files !== obj.files.length) return null;
    return obj;
  }

  function fetchManifest(o) {
    const f = fetchImpl(o);
    if (!f) return Promise.resolve(null);
    return timedFetch(f, MANIFEST_URL, (o && o.manifestTimeoutMs) || T_MANIFEST, { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) return null;
        const txt = bufToText(r.buf);
        if (!txt) return null;
        let obj;
        try { obj = JSON.parse(txt); } catch (e) { return null; }
        return parseManifest(obj);
      })
      .catch(() => null);
  }

  function localMeta() {
    return idbGet(META_KEY).then((m) => (m && m.version ? m : null)).catch(() => null);
  }

  function readStoredIndex(meta) {
    if (!meta || !meta.version) return Promise.resolve(null);
    return idbGet(VERSION_PREFIX + meta.version + '/index.json').then((txt) => {
      if (!txt) return null;
      let idx;
      try { idx = typeof txt === 'string' ? JSON.parse(txt) : JSON.parse(bufToText(txt)); } catch (e) { return null; }
      return validIndex(idx) ? idx : null;
    }).catch(() => null);
  }

  // 相对路径只接受 pack/<code>.<win>.json.gz，拒绝 .. 与绝对路径
  function safeRel(p) {
    const s = String(p == null ? '' : p).replace(/\\/g, '/');
    if (!/^pack\/[0-9]{6}\.[A-Za-z0-9]+\.json\.gz$/.test(s)) return '';
    return s;
  }

  function joinBase(base, rel) {
    const b = String(base || '');
    return (b.endsWith('/') ? b : b + '/') + rel;
  }

  function verifyBytes(r, expect) {
    const n = (typeof r.buf === 'string') ? r.buf.length : (r.buf.byteLength || 0);
    if (expect != null && +expect > 0 && n !== +expect) return false;
    return true;
  }

  /* 下载一个版本的 index + 全部分片，逐个校验 sha256 后落 IDB。
     任何一步失败 → 整版本作废（删已写入的半成品），抛错由调用方回落随包。 */
  function downloadSnapshot(m, o) {
    const opt = o || {};
    const f = fetchImpl(opt);
    if (!f) return Promise.reject(new Error('no_fetch'));
    const v = String(m.version);
    const base = String(m.base);
    const vsDir = VERSION_PREFIX + v + '/';
    const written = [];
    const progress = typeof opt.onProgress === 'function' ? opt.onProgress : function () {};
    const started = [];

    return idbDelete(keysForVersion(v)).then(() => {
      // 1) index.json：先校验再解析
      return timedFetch(f, joinBase(base, m.index.path), opt.shardTimeoutMs || T_SHARD, { cache: 'no-store' });
    }).then((r) => {
      if (!r || !r.ok) throw new Error('index_fetch');
      if (!verifyBytes(r, m.index.bytes)) throw new Error('index_bytes');
      return sha256Hex(r.buf).then((hex) => {
        if (hex !== String(m.index.sha256).toLowerCase()) throw new Error('index_sha256');
        const txt = bufToText(r.buf);
        let idx;
        try { idx = JSON.parse(txt); } catch (e) { throw new Error('index_json'); }
        if (!validIndex(idx)) throw new Error('index_schema');
        return idbPut(vsDir + 'index.json', txt).then((ok) => {
          if (!ok) throw new Error('idb_write');
          written.push(vsDir + 'index.json');
          return idx;
        });
      });
    }).then(() => {
      // 2) 分片：顺序下载，进度按 bytes 累计
      const files = m.files || [];
      const total = files.length;
      let doneCount = 0;
      let doneBytes = 0;
      return files.reduce((chain, file) => chain.then(() => {
        const rel = safeRel(file.path);
        if (!rel) throw new Error('bad_path');
        const key = vsDir + rel;
        return timedFetch(f, joinBase(base, rel), opt.shardTimeoutMs || T_SHARD, { cache: 'force-cache' })
          .then((r) => {
            if (!r || !r.ok) throw new Error('pack_fetch');
            if (!verifyBytes(r, file.bytes)) throw new Error('pack_bytes');
            return sha256Hex(r.buf).then((hex) => {
              if (hex !== String(file.sha256).toLowerCase()) throw new Error('pack_sha256');
              return idbPut(key, r.buf).then((ok) => {
                if (!ok) throw new Error('idb_write');
                written.push(key);
                doneCount += 1;
                doneBytes += (typeof r.buf === 'string' ? r.buf.length : (r.buf.byteLength || 0));
                progress({ phase: 'pack', done: doneCount, total: total, bytes: doneBytes });
              });
            });
          });
      }), Promise.resolve());
    }).then(() => {
      const meta = {
        version: v,
        cutoffDay: String(m.cutoffDay),
        appliedAt: new Date().toISOString(),
        base: base,
        bytes: +(m.counts && m.counts.bytes) || 0,
        files: (m.files || []).length,
        generatedAt: m.generatedAt || '',
        minClient: m.minClient || '',
        minClientCode: m.minClientCode == null ? null : +m.minClientCode,
      };
      // 先读旧 meta（覆盖前），用于「新版本 + 上一个版本」两条保留策略
      return localMeta().then((prev) => idbPut(META_KEY, meta).then((ok) => {
        if (!ok) throw new Error('idb_write');
        return { meta: meta, prev: prev };
      }));
    }).then((cur) => {
      const meta = cur.meta;
      const keep = {};
      keep[meta.version] = true;
      if (cur.prev && cur.prev.version && cur.prev.version !== meta.version) keep[cur.prev.version] = true;
      return idbKeys(VERSION_PREFIX).then((keys) => {
        const versions = new Set();
        keys.forEach((k) => {
          const rest = k.slice(VERSION_PREFIX.length);
          const i = rest.indexOf('/');
          if (i > 0) versions.add(rest.slice(0, i));
        });
        const drop = [];
        versions.forEach((ver) => { if (!keep[ver]) drop.push(ver); });
        if (!drop.length) return meta;
        const dropKeys = keys.filter((k) => {
          const rest = k.slice(VERSION_PREFIX.length);
          const i = rest.indexOf('/');
          return i > 0 && drop.indexOf(rest.slice(0, i)) >= 0;
        });
        return idbDelete(dropKeys).then(() => meta);
      });
    }).catch((err) => {
      // 半成品整版本作废，下一次仍读随包/上一个完整版本
      return idbDelete(written.length ? written : keysForVersion(v)).then(() => { throw err; });
    });

    // 本地辅助：该版本已写入的键（失败时的兜底清理）
    function keysForVersion(ver) {
      return [VERSION_PREFIX + ver + '/index.json'];
    }
  }

  /* ---------------- 对外 API ---------------- */
  /**
   * resolveSnapshot(opts) -> Promise<{
   *   source: 'bundle'|'remote',
   *   index: panji.builtin.index.v1,
   *   cutoffDay, version, appliesAt,
   *   packUrl(code, win): string,
   *   manifest
   * } | null>
   *
   * opts.auto 显式覆盖开关（缺省读 snapshotAuto，默认 false）；
   * opts.fetch / opts.bundleUrl / opts.manifestTimeoutMs 便于测试。
   */
  function resolveSnapshot(opts) {
    const o = opts || {};
    const auto = (o.auto === undefined) ? wantAuto() : !!o.auto;

    const bundle = () => loadBundleIndex(o).then((idx) => {
      if (!idx) return null;
      return {
        source: 'bundle',
        index: idx,
        cutoffDay: cutoffFromIndex(idx),
        version: String(idx.version || ''),
        appliesAt: '',
        packUrl: makePackUrl('bundle', o.bundleBase || BUNDLE_DIR),
        manifest: null,
      };
    });

    if (!auto) return bundle();

    return localMeta().then((meta) => {
      if (!meta || !meta.version) return null;
      return readStoredIndex(meta).then((idx) => {
        if (!idx) return null;
        return {
          source: 'remote',
          index: idx,
          cutoffDay: String(meta.cutoffDay || cutoffFromIndex(idx)),
          version: String(meta.version),
          appliesAt: meta.appliedAt || '',
          packUrl: makePackUrl('remote', meta.base),
          manifest: meta,
        };
      });
    }).then((remote) => remote || bundle()).catch(() => bundle());
  }

  /**
   * checkUpdate(opts) -> Promise<
   *   { ok:true, upToDate:true, version, cutoffDay } |
   *   { ok:true, updated:true, version, cutoffDay, bytes } |
   *   { ok:true, available:true, ... }（dryRun） |
   *   { ok:false, error }
   * >
   * 检查更新入口不受 snapshotAuto 约束，默认常驻。
   */
  function checkUpdate(opts) {
    const o = opts || {};
    return fetchManifest(o).then((m) => {
      if (!m) return { ok: false, error: 'manifest_unavailable' };
      const cv = clientVersion();
      if (m.minClientCode != null && cv.code != null && +cv.code < +m.minClientCode) {
        return { ok: false, error: 'client_too_old', version: m.version, needCode: +m.minClientCode };
      }
      return localMeta().then((cur) => {
        if (cur && cur.version === m.version) {
          return { ok: true, upToDate: true, version: String(m.version), cutoffDay: String(m.cutoffDay) };
        }
        if (o.dryRun) {
          return {
            ok: true,
            available: true,
            version: String(m.version),
            cutoffDay: String(m.cutoffDay),
            bytes: +(m.counts && m.counts.bytes) || 0,
            files: (m.files || []).length,
            current: cur ? cur.version : '',
          };
        }
        return downloadSnapshot(m, o).then((meta) => ({
          ok: true,
          updated: true,
          version: meta.version,
          cutoffDay: meta.cutoffDay,
          bytes: meta.bytes,
          appliesAt: meta.appliedAt,
        }), (err) => ({ ok: false, error: (err && err.message) || 'update_failed', version: String(m.version) }));
      });
    }).catch((err) => ({ ok: false, error: (err && err.message) || 'update_failed' }));
  }

  // 当前已落地的远端版本；没有返回 null
  function localSnapshotInfo() {
    return localMeta();
  }

  // 恢复出厂：删掉所有远端版本与 meta，resolveSnapshot 回到随包
  function clearLocal() {
    return idbKeys('').then((keys) => idbDelete(keys));
  }

  return {
    MANIFEST_URL: MANIFEST_URL,
    SCHEMAS: { manifest: MANIFEST_SCHEMA, index: INDEX_SCHEMA },
    resolveSnapshot: resolveSnapshot,
    checkUpdate: checkUpdate,
    fetchManifest: fetchManifest,
    localSnapshotInfo: localSnapshotInfo,
    clearLocal: clearLocal,
    wantAuto: wantAuto,
    clientVersion: clientVersion,
  };
});
