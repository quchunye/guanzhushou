// builtin-catalog.js —— 内置回放「目录」构建（20261107）
// 目录只含 [code,name]，不含 bars/bytes/days 等索引字段：首屏选股下拉够用，
// 体积从全量索引 756,902 B 降到 50,244 B（全市场 gzip9 实测口径，见内部研判 §8.1 D 行）。
// 版本与 index.json 同源；签名由版本派生，长期不变，可走 immutable 缓存。
'use strict';
const crypto = require('node:crypto');

const CATALOG_SCHEMA = 'panji.builtin.catalog.v1';
const CATALOG_SIG_LEN = 24;

// 与分片分域：'catalog:v1:' 前缀，避免目录签名与分片签名互相复用
function catalogSig(key, version) {
  return crypto.createHmac('sha256', key).update('catalog:v1:' + String(version)).digest('hex').slice(0, CATALOG_SIG_LEN);
}

function buildCatalog(indexObj) {
  const version = String((indexObj && indexObj.version) || '');
  const symbols = ((indexObj && indexObj.symbols) || []).map(function (s) {
    return [String(s.code), String(s.name == null ? '' : s.name)];
  });
  return { schema: CATALOG_SCHEMA, version: version, count: symbols.length, symbols: symbols };
}

function catalogJson(indexObj) {
  return Buffer.from(JSON.stringify(buildCatalog(indexObj)));
}

function catalogUrl(version, sig) {
  return '/api/builtin/catalog/' + encodeURIComponent(version) + '/' + sig + '.json.gz';
}

// 元信息：给客户端拼版本化地址用；version 缺失时返回 null（调用方按 503 处理）
function catalogMeta(key, indexObj) {
  const version = String((indexObj && indexObj.version) || '');
  if (!version) return null;
  const sig = catalogSig(key, version);
  return {
    schema: CATALOG_SCHEMA,
    version: version,
    sig: sig,
    count: ((indexObj && indexObj.symbols) || []).length,
    url: catalogUrl(version, sig),
  };
}

module.exports = { CATALOG_SCHEMA, CATALOG_SIG_LEN, catalogSig, buildCatalog, catalogJson, catalogUrl, catalogMeta };
