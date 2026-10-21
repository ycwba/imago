/* 能力接口（/capabilities）—— 页面问某个平台的型号能力只走这一条本地路由。
   上游清单落盘一天、内存 60 秒、在途合并；失败按 registry 兜底并写明原因。
   allProviders / keyOf / DEFAULTS / upRequest 由 app 注入。 */
'use strict';
const fs = require('fs');
const path = require('path');

function createCapabilities(opts) {
  const dataDirPath = opts.dataDirPath;
  const allProviders = opts.allProviders;
  const keyOf = opts.keyOf;
  const DEFAULTS = opts.DEFAULTS;
  const upRequest = opts.upRequest;
/* ============================================================================
   能力接口（/capabilities）—— 页面问「这个平台的模型都有什么能力」只走这一条本地路由
   ---------------------------------------------------------------------------
     GET /capabilities?provider=<id|keyId>[&noCache=1]
   代理负责：
     · 按 registry 找到该平台声明的能力端点（endpoints.models）
     · 带上密钥请求上游，把返回的模型数组按 id 整理好
     · 上游没有这个端点 / 请求失败 → 返回 registry 里的兜底声明，并说明原因（note）
   这样页面不需要知道每个平台的能力接口地址、密钥和返回格式；接入新平台
   只要在 registry 里写上 endpoints.models，能力的读取与回退全自动。
   返回：{ provider, source:'api'|'registry', models:{id:原始模型对象},
           registryModels:[...], endpoint, note, fetchedAt, cached }
   —— 模型能力不会秒变，服务端缓存 60 秒；noCache=1 强制回源（设置页「重新读取」用）。
   ========================================================================== */
const capCache = new Map();          // base|endpoint → { ts, payload }
const CAP_TTL = 60 * 1000;
/* 在途合并。⚠️ `noCache=1`（设置页「重新读取」）必须走旁路：它既**不读**缓存，
   也**不加入**在途合并 —— 否则「强制刷新」会拿到别人那一次的结果，看着像刷新没生效。
   所以注册与加入都以 `!noCache` 为前提。 */
const capInflight = new Map();       // cacheKey → { p, resolve }
/* **落盘的一层**（2026-10）。以前 capCache 是纯内存的，于是「工作台的型号怎么这么慢」
   有一个固定的、每天第一次都会重演一遍的成因：代理重启（或 60 秒一过）之后，第一个打开工作台的
   页面必须**等回源**才看得到型号 —— 实测 vgenv 一次 6.9 秒、SparkCine 两家各 1.1 秒，
   而上一轮把注册表里的兜底型号清单删掉之后，这段时间里型号下拉是**空的**（不是慢，是「没有」）。
   现在把每次真取到的上游清单落到 `.data/.cap-cache.json`：
   · 只要拿得出**一天以内**的真清单（内存过期的那份或落盘的那份，取较新的）就先照它答（`stale:true`），
     同时后台回源刷新一轮 —— **有别人正在飞也一样先答**，不等那一次往返（见 handleCapabilities）；
   · 一份旧副本都没有（冷启动 / 过期）→ 照旧阻塞回源。
   文件名以点开头 = 代理自己的内部状态，和 `.cloud-state.json` 一样不进 `/data` 清单、不参与云同步
   （它记的是「上游平台有什么型号」，那是平台的事，不是用户的数据，换台机器本来就该重新问一遍）。
   ⚠ 只缓存**用服务端 .env 密钥取到的**那些家：自定义供应商的密钥只在浏览器那一侧，
   代理存不了它的清单，那些家照旧每次现问（设置页的型号清单走 /custom/models，另有自己的在途合并）。 */
const capDiskFile = () => path.join(dataDirPath(), '.cap-cache.json');
const CAP_DISK_TTL = 24 * 60 * 60 * 1000;
let capDisk = null;                  // cacheKey → { ts, payload }
function capDiskLoad() {
  if (capDisk) return capDisk;
  try { capDisk = JSON.parse(fs.readFileSync(capDiskFile(), 'utf8')) || {}; }
  catch { capDisk = {}; }
  return capDisk;
}
let capDiskWriteAt = 0;
function capDiskPut(cacheKey, payload) {
  const d = capDiskLoad();
  d[cacheKey] = { ts: Date.now(), payload };
  /* 整表重写，所以自己夹一个 2 秒的下限：一次开机十几个后台刷新挤在一起时，
     没必要为每一条都写一遍同一个文件（写的是同一个内存表，少写几次不丢东西）。 */
  if (Date.now() - capDiskWriteAt < 2000) return;
  capDiskWriteAt = Date.now();
  try {
    fs.mkdirSync(dataDirPath(), { recursive: true });
    fs.writeFileSync(capDiskFile(), JSON.stringify(d));
  } catch (e) { console.warn('[capabilities] 落盘缓存写不了：', e.message); }
}
/* 后台刷新一轮：命中落盘答完之后悄悄把上游问一遍，写进两层缓存，供下一次（或下一台页面）用。
   与 handleCapabilities 用同一个 capInflight 键，所以「同时在飞」的只有这一条。 */
function capWarm(cacheKey, prov, endpoint, apiKey) {
  if (capInflight.has(cacheKey)) return;
  let r0 = null;
  const p = new Promise(r => { r0 = r; });
  capInflight.set(cacheKey, { p, resolve: r0 });
  capFetchPayload(prov, endpoint, apiKey)
    .then(payload => {
      /* 只把真清单写进两层缓存：一次 404 / 断连不该把上一次的好清单从落盘里顶掉
         （内存那一份照旧写 —— 它 60 秒就过期，本来就该如实反映「刚刚问过」）。 */
      capCache.set(cacheKey, { ts: Date.now(), payload });
      if (payload.source === 'api') capDiskPut(cacheKey, payload);
    })
    .catch(() => {})
    .finally(() => { capInflight.delete(cacheKey); r0(); });
}

/* 真去上游问一次型号清单。四种结果各回一句话（页面那句「能力来源」直接把 note 原样显示，
   压成一句「上游接口没给或不可用」等于零信息 —— 见 assetlib.js 的 Capabilities.srcTextOf）。 */
async function capFetchPayload(prov, endpoint, apiKey) {
  const registryModels = (prov.models || []).map(m => ({
    id: m.id, name: m.name, modes: m.modes, options: m.options, price: m.price,
  }));
  const base = { provider: prov.id, name: prov.name, displayName: prov.displayName || prov.name, endpoint, registryModels };
  try {
    /* 网络层失败重问一次（2.5 秒退避）：开机头几秒出站系统代理的 TLS 链常没热，
       实测 12:25 一波「socket disconnected」正好打在工作台首屏取型号上 —— 冷启动又没有落盘旧副本时，
       一次失败就把空清单答给了页面（「获取型号失败，刷新一下才好」）。GET 清单无副作用，重问安全；
       4xx 不重问（密钥/路径问题再来一次也一样）。 */
    let r = null, netErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        r = await new Promise((resolve, reject) => {
          const up = upRequest(prov.base + endpoint, {
            method: 'GET',
            headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json', 'accept-encoding': 'identity' },
            keepAlive: true,              // 目标主机来自注册表声明（见 keepAliveAgent / agentFor）
          }, ur => {
            const bufs = [];
            ur.on('data', c => bufs.push(c));
            ur.on('end', () => resolve({ status: ur.statusCode, body: Buffer.concat(bufs) }));
            ur.on('error', reject);
          });
          up.on('error', reject);
          up.end();
        });
        netErr = null;
        break;
      } catch (e) {
        netErr = e;
        if (attempt === 0) await new Promise(res => setTimeout(res, 2500));
      }
    }
    if (netErr) throw netErr;
    if (r.status >= 400) {
      return { ...base, source: 'registry', models: {}, note: '上游能力接口返回 ' + r.status + '（按平台声明兜底）' };
    }
    const j = JSON.parse(r.body.toString('utf8'));
    const list = j.data || j.models || (Array.isArray(j) ? j : []);
    const models = {};
    list.forEach(m => { if (m && m.id) models[m.id] = m; });
    if (!Object.keys(models).length) {
      return { ...base, source: 'registry', models: {}, note: '上游能力接口没有返回模型列表（按平台声明兜底）' };
    }
    return { ...base, source: 'api', models, fetchedAt: Date.now(), note: '' };
  } catch (e) {
    return { ...base, source: 'registry', models: {}, note: '上游能力接口请求失败：' + e.message + '（按平台声明兜底）' };
  }
}

async function handleCapabilities(req, res, urlObj) {
  const want = String(urlObj.searchParams.get('provider') || '');
  const noCache = urlObj.searchParams.get('noCache') === '1';
  const prov = allProviders().find(p => p.id === want || (p.keyId || p.id) === want);
  if (!prov) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '找不到平台：' + want + '（检查 registry 里的 id）' } }));
    return true;
  }
  const endpoint = (prov.endpoints && prov.endpoints.models) || null;
  const apiKey = (req.headers.authorization || '').replace(/^Bearer\s*/, '')
    || keyOf(prov.keyEnv) || DEFAULTS[prov.keyId || prov.id] || '';
  const send = payload => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return true;
  };
  const cacheKey = prov.base + '|' + endpoint;
  let capResolve = null;
  if (endpoint && !noCache) {
    const hit = capCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CAP_TTL) return send({ ...hit.payload, cached: true });
    /* 手上「还能用、但可能不是刚刚问过」的那一份清单：内存里过期的与落盘里一天内的，取较新的。
       只认真清单（source==='api'）—— 兜底那一份现在可能压根没有型号，答出去等于下拉是空的。 */
    const staleCopy = () => {
      const cand = [];
      if (hit && hit.payload && hit.payload.source === 'api') cand.push(hit);
      const d = capDiskLoad()[cacheKey];
      if (d && d.payload && d.payload.source === 'api' && Date.now() - d.ts < CAP_DISK_TTL) cand.push(d);
      return cand.sort((a, b) => b.ts - a.ts)[0] || null;
    };
    /* 已经在取同一家的能力声明 → 同一轮里几个页面同时开时会一起打上游。
       ⚠ 但「有别人在飞」**不等于**「我必须干等那一轮」：上一版这里无条件 `await wait.p`，
       于是哪怕落盘里就躺着一份一天以内的真清单，第二个、第三个请求也要等满一次上游往返
       （实测 vgenv 一次 6.8 秒 —— 用户看到的就是「工作台型号出来好慢」，而慢的那一段本来能答）。
       现在顺序是**先答旧副本、后台那一轮照旧刷**；只有旧副本一个都没有才真的等。 */
    const wait = capInflight.get(cacheKey);
    if (wait) {
      const st0 = staleCopy();
      if (st0) return send({ ...st0.payload, cached: true, stale: true });
      try { await wait.p; } catch {}
      const hit2 = capCache.get(cacheKey);
      if (hit2) return send({ ...hit2.payload, cached: true });
      /* 在途那次连兜底都没写进缓存（极少见）：自己照常往下走，回源一次 */
    } else {
      /* 内存没命中、但有一天内落盘的 → 先照那份答（型号下拉立刻就有内容），后台再回源刷新一轮
         （capWarm 自己认在途，所以这里不会重复派一整批上游请求）。 */
      const st = staleCopy();
      if (st) {
        capWarm(cacheKey, prov, endpoint, apiKey);
        return send({ ...st.payload, cached: true, stale: true });
      }
      let r0 = null;
      const p = new Promise(r => { r0 = r; });
      capInflight.set(cacheKey, { p, resolve: r0 });
      capResolve = r0;
    }
  }
  const reply = payload => {
    if (endpoint) {
      capCache.set(cacheKey, { ts: Date.now(), payload });
      if (payload.source === 'api') capDiskPut(cacheKey, payload);
      /* 以前 capCache 是**唯一一份完全没有淘汰**的缓存（全文 cacheSweep 三处调用都没它），
         而 v11 起自定义供应商不设家数上限，条目只增不减。CAP_TTL 只有 60 秒，整表清掉没代价。 */
      if (capCache.size > 200) capCache.clear();
    }
    const out = send(payload);
    if (capResolve) { const r = capResolve; capResolve = null; capInflight.delete(cacheKey); r(payload); }
    return out;
  };
  if (!endpoint) {
    return reply({ provider: prov.id, name: prov.name, displayName: prov.displayName || prov.name,
      endpoint: null, registryModels: (prov.models || []).map(m => ({ id: m.id, name: m.name,
        modes: m.modes, options: m.options, price: m.price })),
      source: 'registry', models: {}, note: '这家没有开放的型号列表接口，参数按本项目的默认声明走' });
  }
  return reply(await capFetchPayload(prov, endpoint, apiKey));
}

  return { handleCapabilities, capCache };
}
module.exports = { createCapabilities };
