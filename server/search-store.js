/* 联网搜索设置（server 侧唯一实现）。
   - .data/search.json：开关 / 服务 / 结果数 / 凭据来源。`key` 只留在盘上，读接口只回 hasKey。
   - 原子写 + 覆盖前 .bak.json；与 asr-store 同一种写盘纪律。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fs-atomic.js');

const PROVIDERS = new Set(['tavily', 'deepseek']);
const SOURCES = new Set(['channel', 'manual']);

const def = () => ({
  revision: 1,
  enabled: false,
  provider: 'tavily',
  maxResults: 5,
  credentialSource: 'channel',
  channelId: 'deepseek',
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
      provider: PROVIDERS.has(raw.provider) ? raw.provider : d.provider,
      maxResults: Math.max(1, Math.min(10, Number(raw.maxResults) || d.maxResults)),
      credentialSource: SOURCES.has(raw.credentialSource) ? raw.credentialSource : d.credentialSource,
      channelId: clean(raw.channelId, 60) || d.channelId,
      model: clean(raw.model, 120),
      baseUrl: clean(raw.baseUrl, 500),
      key: clean(raw.key, 500),
      updatedAt: clean(raw.updatedAt, 40),
    };
    return cur;
  };
  const atomic = obj => {
    const body = JSON.stringify(obj, null, 2);
    try {
      if (fs.existsSync(file)) {
        const old = fs.readFileSync(file, 'utf8');
        /* 内容相同不留备份；备份写不成不阻挡主写（普通写，不参与 fsync/rename） */
        if (old !== body) fs.writeFileSync(file.replace(/\.json$/, '.bak.json'), old);
      }
    } catch (e) {}
    /* 写盘纪律只有 fs-atomic 一处（与 asr-store 同一份）：tmp → fsync → 占用时退避重试的 rename */
    atomicWrite(file, body);
  };
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
      channelId: s.channelId, model: s.model, baseUrl: s.baseUrl,
      hasKey: !!s.key, updatedAt: s.updatedAt,
    };
  };
  const patch = p => {
    const o = p && typeof p === 'object' ? p : {};
    const s = load();
    if (o.enabled != null) s.enabled = o.enabled === true;
    if (o.provider != null) {
      if (!PROVIDERS.has(o.provider)) throw new Error('搜索服务只支持 tavily / deepseek');
      s.provider = o.provider;
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
    if (o.channelId != null) {
      const id = clean(o.channelId, 60);
      if (id && !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('渠道 id 不合法');
      s.channelId = id;
    }
    if (o.model != null) s.model = clean(o.model, 120);
    if (o.baseUrl != null) {
      const base = clean(o.baseUrl, 500).replace(/\/+$/, '');
      if (!urlOk(base)) throw new Error('接口地址要以 http:// 或 https:// 开头');
      s.baseUrl = base;
    }
    if (o.clearKey === true) s.key = '';
    else if (o.key != null && String(o.key).trim()) s.key = clean(o.key, 500);
    return persist();
  };
  return { file, settings: pub, raw: load, patch };
}

module.exports = { createSearchStore };
