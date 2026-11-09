/* 供应商声明校验：id 唯一、必填字段、kind、relay 形状、型号来源、端点对象。
   启动时调用；坏条目只报告并标记 invalid，不在这里抛错打断整个代理。
   型号来源有四种：models / modelDocs / newModelDefaults / endpoints.models。
   v13 起清单归平台接口，声明里只剩「文档写过什么」，任何一种都算说清了这一家的型号从哪来。 */
'use strict';
const KINDS = new Set(['image', 'video', 'audio', 'text']);
/* 「这家还会做哪些不在 kind 里的档」：语音识别与联网搜索。拼错一个字母不会报错，
   只会让设置页少一格 —— 所以这里按白名单查，值错了当场红。
   两档都要同时有两样东西：`extraCaps` 里的一项（画不画）与一份端点声明（怎么调）——
   只有前者会在界面上多一行、点下去才失败；只有后者会没人看得见。 */
const EXTRA_CAPS = new Set(['asr', 'search']);
const ASR_STYLES = new Set(['openai', 'chat-audio']);
const SEARCH_STYLES = new Set(['api', 'chat']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

function validateExtraCaps(p, errs) {
  const caps = Array.isArray(p.extraCaps) ? p.extraCaps : [];
  caps.forEach(c => {
    if (!EXTRA_CAPS.has(c)) return;
    const d = p[c];
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      errs.push('extraCaps 声明了 ' + c + '，但没有 ' + c + ' 端点声明（只有一行界面、点下去必失败）');
      return;
    }
    if (!/^\/[^\s]*$/.test(String(d.path || ''))) errs.push(c + '.path 必须以 / 开头：' + d.path);
    if (c === 'asr') {
      if (!ASR_STYLES.has(d.style)) errs.push('asr.style 只能是 openai / chat-audio：' + d.style);
      if (!String(d.model || '')) errs.push('asr.model 不能为空（默认型号只在声明里写一次）');
      if (d.language != null && !['form', 'header', 'body', 'none'].includes(d.language)) {
        errs.push('asr.language 只能是 form / header / body / none：' + d.language);
      }
      if (d.models != null && !Array.isArray(d.models)) errs.push('asr.models 必须是数组');
    } else {
      if (!SEARCH_STYLES.has(d.style)) errs.push('search.style 只能是 api / chat：' + d.style);
      if (d.style === 'api') {
        if (!d.body || !d.body.query) errs.push('search.body.query 必须写明「我们的搜索词放到上游哪个字段」');
        if (!d.results) errs.push('search.results 必须写明结果数组在响应的哪个字段');
        if (!d.fields || !d.fields.url) errs.push('search.fields.url 必须写明网址落在结果的哪个字段');
      }
      if (d.style === 'chat' && !(d.tool && d.tool.type)) {
        errs.push('search.tool.type 必须写明对话接口里怎么开联网（如 openrouter:web_search）');
      }
    }
  });
  ['asr', 'search'].forEach(c => {
    if (p[c] != null && !caps.includes(c)) {
      errs.push('声明了 ' + c + ' 端点，但 extraCaps 里没有它（界面不会画这一档，等于白写）');
    }
  });
}

function hasModelSource(p) {
  if (Array.isArray(p.models) || Array.isArray(p.modelDocs)) return true;
  if (p.newModelDefaults && typeof p.newModelDefaults === 'object') return true;
  return !!(p.endpoints && p.endpoints.models);
}

/* assetStore 声明（顶层一条）：/asset/<id>、渲染素材解析、本机补存三处都靠它知道「去问哪一家、
   换成哪个字段里的地址」。没有声明是合法的（这家就没有资产接口），当错误会把代理启动日志吵红；
   声明了但点名的供应商不存在、retrieve 少了 {id}、urlFields 空着，则必须当场报出来 ——
   这三样坏任一样，运行期表现都是「资产永远取不回」，且没有任何一处会抛错。 */
function validateAssetStore(reg) {
  const d = reg && reg.assetStore;
  if (!d) return { ok: true, declared: false, errors: [], info: null };
  const errs = [];
  const list = (reg && reg.providers) || [];
  const p = list.find(x => x && x.id === d.provider);
  if (!p) errs.push('点名的供应商不存在：' + (d.provider || '(空)'));
  else {
    if (!p.base) errs.push('供应商 ' + p.id + ' 没有 base（拼资产地址要用它）');
    if (!p.keyEnv) errs.push('供应商 ' + p.id + ' 没有 keyEnv（代理按这个名字读密钥）');
  }
  if (!d.retrieve) errs.push('缺少 retrieve（资产详情端点）');
  else if (!/\{id\}/.test(String(d.retrieve))) errs.push('retrieve 里没有 {id} 占位：' + d.retrieve);
  if (!Array.isArray(d.urlFields) || !d.urlFields.length) errs.push('urlFields 必须是非空数组（下载地址在响应的哪个字段）');
  return { ok: errs.length === 0, declared: true, errors: errs, info: d };
}

/* relay 前缀的归属判据（一条硬约束，2026-10-25 起）：
   转发按「req.url 前缀命中的第一家」认家 —— 前缀挂了多家，第二家的请求与密钥就会
   打到第一家的 base 上（v19 以前八家文字 AI 共用 /textai，OpenAI 的密钥被原样发给
   api.deepseek.com）。所以共用同一段前缀只允许**等价声明**：base、keyEnv、endpoints
   三样完全一致（sparkcine 两家是同一上游同一套端点，合法）；差任何一样都当场红。
   声明等价时（同 keyId / 同 base / 同端点）取到哪一家行为都一样，闸与 create 判定也不会串。 */
function relayEquivalent(a, b) {
  return a.base === b.base && (a.keyEnv || '') === (b.keyEnv || '')
    && JSON.stringify(a.endpoints || null) === JSON.stringify(b.endpoints || null);
}

function validateProviders(providers) {
  const errors = [];
  const ids = new Map(), relays = new Map();
  const invalid = [];
  const list = Array.isArray(providers) ? providers : [];
  for (const p of list) {
    const id = String((p && p.id) || '');
    const errs = [];
    if (!id) errs.push('缺少 id');
    else if (!ID_RE.test(id)) errs.push('id 只能用小写字母、数字与连字符：' + id);
    else if (ids.has(id)) errs.push('id 重复：' + id);
    if (id) ids.set(id, p);
    if (!p || !KINDS.has(p.kind)) errs.push('kind 非法：' + (p && p.kind));
    if (!p || !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/i.test(String(p.relay || ''))) errs.push('relay 必须是以 / 开头的路径段（可多段）：' + (p && p.relay));
    if (!p || !p.name) errs.push('缺少 name');
    if (p && p.kind !== 'text' && !hasModelSource(p)) errs.push('缺少型号来源（models / modelDocs / newModelDefaults / endpoints.models）');
    if (p && p.kind === 'text' && !(p.endpoints && p.endpoints.chat)) errs.push('文字供应商缺少 endpoints.chat');
    if (p && p.modelsExclude != null && typeof p.modelsExclude !== 'string') errs.push('modelsExclude 必须是正则文本（字符串）：' + p.modelsExclude);
    if (p && p.extraCaps != null) {
      if (!Array.isArray(p.extraCaps)) errs.push('extraCaps 必须是数组（asr / search）：' + p.extraCaps);
      else {
        p.extraCaps.forEach(c => { if (!EXTRA_CAPS.has(c)) errs.push('extraCaps 里有未登记的档：' + c); });
        if (p.kind !== 'text') errs.push('extraCaps 只能声明在文字供应商上（这一家的 kind 是 ' + p.kind + '）');
      }
    }
    if (p) validateExtraCaps(p, errs);
    /* refSyntax：素材引用语法（H3 那一族用 <Picture {n}> / <Video {n}> / <Audio {n}>）。
       少了 {n} 的模板会把每一张素材都写成同一个标签，编号只在正文里、平台那边全指第一项。 */
    if (p && p.refSyntax != null) {
      const map = typeof p.refSyntax === 'string' ? { picture: p.refSyntax } : p.refSyntax;
      if (!map || typeof map !== 'object' || Array.isArray(map)) errs.push('refSyntax 必须是字符串或 { picture, video, audio } 对象');
      else {
        const allowed = new Set(['picture', 'video', 'audio']);
        Object.keys(map).forEach(k => {
          if (!allowed.has(k)) errs.push('refSyntax 里有未登记的档：' + k);
          const v = map[k];
          if (v != null && !/\{n\}/.test(String(v))) errs.push('refSyntax.' + k + ' 缺少 {n} 占位：' + v);
        });
      }
    }
    if (p && p.endpoints && typeof p.endpoints !== 'object') errs.push('endpoints 必须是对象');
    /* 声明了输入槽位（inputRoles）就必须有把它放进提交体的模板：
       槽位照声明画得出来、提交那一刻却因为「没有模板」被整个丢掉 ——
       用户放了首尾帧、钱照扣，出的是文生视频，界面上一个字都不提示。
       例外：TTS 模板族（p.tts 存在的那几家）。它们的输入递法是**约定**——
       复刻的参考音频按约定走 create.template 里的 {{voice}}（收口在 gen-forms.synthTts
       与导演台 voice.js，三档给法：预设递音色 id / 设计递空串 / 复刻递 base64），
       不走 inputTemplates，这一族不按槽位查模板。 */
    if (p && p.create && !p.tts && (p.models || p.modelDocs)) {
      const tpls = p.create.inputTemplates || null;
      (p.models || []).concat(p.modelDocs || []).forEach(m => {
        if (!m || !m.inputRoles) return;
        Object.keys(m.inputRoles).forEach(role => {
          if (!tpls || !(role in tpls)) errs.push('型号 ' + m.id + ' 声明了输入槽位 ' + role
            + '，但 create.inputTemplates 里没有它（画得出来就发得出去，差一个就是静默丢素材）');
        });
      });
    }
    if (errs.length) {
      invalid.push({ id: id || '(无 id)', errors: errs });
      errors.push((id || '(无 id)') + '：' + errs.join('；'));
    }
  }
  /* relay 归属：同一段前缀挂多家时，只允许等价声明共用。 */
  const sharedRelays = [];
  const byRelay = new Map();
  list.forEach(p => {
    if (!p || !p.relay) return;
    const k = String(p.relay).toLowerCase();
    if (!byRelay.has(k)) byRelay.set(k, []);
    byRelay.get(k).push(p);
  });
  byRelay.forEach((group, relay) => {
    if (group.length < 2) return;
    sharedRelays.push(relay);
    const bad = [];
    for (let i = 1; i < group.length; i++) {
      if (!relayEquivalent(group[0], group[i])) {
        bad.push(group[i].id + '（base / keyEnv / endpoints 与 ' + group[0].id + ' 不一致）');
      }
    }
    if (bad.length) {
      /* 只标与第一家不等价的那几家：第一家是前缀命中的「赢家居」，等价的成员跟着它走没有行为差；
         不等价的那些才是请求与密钥会被打错地址的。 */
      const msg = 'relay 前缀 ' + relay + ' 与 ' + group[0].id + ' 共用但声明不等价 —— 转发按前缀取第一家，'
        + '这一家的请求与密钥会打到 ' + group[0].id + ' 的地址上；给这一家一段独立前缀（'
        + bad.map(b => b.split('（')[0]).join('、') + ' 的 base / keyEnv / endpoints 与 ' + group[0].id + ' 不一致）';
      group.forEach(p => {
        if (!bad.some(b => b.startsWith(p.id + '（'))) return;
        invalid.push({ id: p.id, errors: [msg] });
        errors.push(p.id + '：' + msg);
      });
    }
  });
  return {
    ok: errors.length === 0,
    invalid, errors,
    sharedRelays,
  };
}

/* interfaceShapes（自定义供应商的接口族）校验：template 必须是真实存在的内置 id；
   可选的 needs 数组声明「这一族承诺模板必须具备的环节」——['retrieve'] 要求模板同时有
   endpoints.retrieve 与 retrieve 配置（api.retrieveItem 两者都要才换得到地址）。 */
function validateInterfaceShapes(reg) {
  const shapes = (reg && reg.interfaceShapes) || null;
  if (!shapes) return { ok: true, errors: [] };
  const errs = [];
  const list = (reg && reg.providers) || [];
  Object.keys(shapes).forEach(kind => {
    (Array.isArray(shapes[kind]) ? shapes[kind] : []).forEach(s => {
      const t = s && list.find(p => p.id === (s && s.template));
      if (!t) { errs.push('接口形状 ' + kind + '/' + ((s && s.id) || '?') + ' 的 template 不是真实存在的内置平台 id：' + (s && s.template)); return; }
      if ((kind === 'asr' || kind === 'search') && (!t[kind] || (t.extraCaps || []).indexOf(kind) < 0)) {
        errs.push('接口形状 ' + kind + '/' + s.id + ' 的模板 ' + t.id + ' 没有声明 ' + kind + '（形状会被画出来，选的人却永远调不通）');
      }
      (Array.isArray(s.needs) ? s.needs : []).forEach(need => {
        if (need === 'retrieve' && !(t.endpoints && t.endpoints.retrieve && t.retrieve)) {
          errs.push('接口形状 ' + kind + '/' + s.id + ' 承诺了 retrieve 环节，但模板 ' + t.id
            + ' 没有 endpoints.retrieve + retrieve 配置（按这一族添加的自定义供应商永远换不到产物地址）');
        }
      });
    });
  });
  return { ok: errs.length === 0, errors: errs };
}

module.exports = { validateProviders, validateAssetStore, validateInterfaceShapes, KINDS };
