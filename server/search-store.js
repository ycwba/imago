/* 联网搜索设置（server 侧唯一实现）。
   - .data/search.json：开关 / 服务 / 结果数 / 凭据来源。`key` 只留在盘上，读接口只回 hasKey。
   - 原子写 + 覆盖前 .bak.json；与 asr-store 同一种写盘纪律。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { writeJsonWithBak } = require('./fs-atomic.js');

/* `provider` 是搜索**引擎**：'auto'（挑第一家声明了 search 且配了密钥的供应商）/
   'tavily'（独立搜索接口，只认单独填的那把密钥）/ 供应商 id（deepseek、zhipu、moonshot…）。
   不在这一层校验 id 是否存在 —— 注册表是动态的，未知 id 由 /search/query 按「这家没有搜索接口」报。 */
const SOURCES = new Set(['channel', 'manual']);
const def = () => ({
  revision: 1,
  enabled: false,
  provider: 'auto',
  maxResults: 5,
  credentialSource: 'channel',
  model: '',
  baseUrl: '',
  key: '',
  updatedAt: '',
});
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
function urlOk(v) {
  if (!v) return true;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && String(v).length <= 500;
  } catch { return false; }
}

function createSearchStore(opts) {
  const dataDir = opts.dataDir;
  const log = opts.log || (() => {});
  const file = path.join(dataDir, 'search.json');
  let cur = null;

  const load = () => {
    if (cur) return cur;
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
    catch (e) { if (e && e.code !== 'ENOENT') log('[search] 读不出来 search.json：' + e.message); }
    const d = def();
    cur = {
      revision: Number(raw.revision) || 1,
      enabled: raw.enabled === true,
      provider: clean(raw.provider, 60) || d.provider,
      maxResults: Math.max(1, Math.min(10, Number(raw.maxResults) || d.maxResults)),
      credentialSource: SOURCES.has(raw.credentialSource) ? raw.credentialSource : d.credentialSource,
      model: clean(raw.model, 120),
      baseUrl: clean(raw.baseUrl, 500),
      key: clean(raw.key, 500),
      updatedAt: clean(raw.updatedAt, 40),
    };
    return cur;
  };
  /* 覆盖写 + `.bak` 备份与写盘纪律都在 fs-atomic（writeJsonWithBak），与 asr-store 同一份。 */
  const atomic = obj => writeJsonWithBak(file, obj);
  const persist = () => {
    const s = load();
    s.revision = (Number(s.revision) || 0) + 1;
    s.updatedAt = new Date().toISOString();
    atomic(s);
    return pub();
  };
  const pub = () => {
    const s = load();
    return {
      revision: s.revision, enabled: s.enabled, provider: s.provider,
      maxResults: s.maxResults, credentialSource: s.credentialSource,
      model: s.model, baseUrl: s.baseUrl,
      hasKey: !!s.key, updatedAt: s.updatedAt,
    };
  };
  const patch = p => {
    const o = p && typeof p === 'object' ? p : {};
    const base = load();
    /* 先在副本上改、全部校验通过再落回缓存：以前中途抛错（例如结果数填 50）时，
       前面几项已经改在内存里、磁盘却没写，运行中的搜索就按一份半截配置走。 */
    const s = { ...base };
    const prevProvider = s.provider;
    if (o.enabled != null) s.enabled = o.enabled === true;
    if (o.provider != null) {
      const id = clean(o.provider, 60);
      if (id && id !== 'auto' && id !== 'tavily' && !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error('搜索服务只能是 auto / tavily / 供应商 id');
      }
      s.provider = id || 'auto';
    }
    if (o.maxResults != null) {
      const n = Math.round(Number(o.maxResults));
      if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error('结果数只能是 1–10');
      s.maxResults = n;
    }
    if (o.credentialSource != null) {
      if (!SOURCES.has(o.credentialSource)) throw new Error('凭据来源只支持 channel / manual');
      s.credentialSource = o.credentialSource;
    }
    if (o.model != null) s.model = clean(o.model, 120);
    if (o.baseUrl != null) {
      const base = clean(o.baseUrl, 500).replace(/\/+$/, '');
      if (!urlOk(base)) throw new Error('接口地址要以 http:// 或 https:// 开头');
      s.baseUrl = base;
    }
    if (o.clearKey === true) s.key = '';
    else if (o.key != null && String(o.key).trim()) s.key = clean(o.key, 500);
    /* 换搜索服务：接口地址 / 对话型号 / 单独那把密钥都属于「上一家」，一并作废。
       不清的话，上一家的密钥会被发到新那家的域名上（Tavily 与供应商两个方向都会漏），
       上一家的接口地址也会顶掉新那家声明的默认地址。同一趟显式给了新值就以新值为准。 */
    if (s.provider !== prevProvider) {
      if (!String(o.baseUrl == null ? '' : o.baseUrl).trim()) s.baseUrl = '';
      if (o.model == null) s.model = '';
      if (o.clearKey !== true && !String(o.key == null ? '' : o.key).trim()) s.key = '';
      if (o.credentialSource == null) s.credentialSource = 'channel';
    }
    Object.assign(base, s);
    return persist();
  };
  return { file, settings: pub, raw: load, patch };
}

module.exports = { createSearchStore };
