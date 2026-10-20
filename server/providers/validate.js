/* 供应商声明校验：id 唯一、必填字段、kind、relay 形状、型号来源、端点对象。
   启动时调用；坏条目只报告并标记 invalid，不在这里抛错打断整个代理。
   两条**故意的宽松**（照实登记，别当成漏判）：
   · relay 可以重复 —— 同一个上游的图片与视频共用前缀（sparkcine / sparkcine-video），
     九家文字 AI 也共用 /textai，靠 keyId / 端点内部再分；按 relay 判重会把正常工作的一批全标红。
   · 型号来源有四种：models / modelDocs / newModelDefaults / endpoints.models。
     v13 起清单归平台接口，声明里只剩「文档写过什么」，任何一种都算说清了这一家的型号从哪来。 */
'use strict';
const KINDS = new Set(['image', 'video', 'audio', 'text']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

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
    if (!p || !/^\/[a-z0-9-]+$/i.test(String(p.relay || ''))) errs.push('relay 必须是以 / 开头的单段路径');
    else relays.set(p.relay.toLowerCase(), (relays.get(p.relay.toLowerCase()) || 0) + 1);
    if (!p || !p.name) errs.push('缺少 name');
    if (p && p.kind !== 'text' && !hasModelSource(p)) errs.push('缺少型号来源（models / modelDocs / newModelDefaults / endpoints.models）');
    if (p && p.kind === 'text' && !(p.endpoints && p.endpoints.chat)) errs.push('文字供应商缺少 endpoints.chat');
    if (p && p.endpoints && typeof p.endpoints !== 'object') errs.push('endpoints 必须是对象');
    if (errs.length) {
      invalid.push({ id: id || '(无 id)', errors: errs });
      errors.push((id || '(无 id)') + '：' + errs.join('；'));
    }
  }
  return {
    ok: errors.length === 0,
    valid: list.filter(p => !invalid.some(x => x.id === (p && p.id))),
    invalid, errors,
    sharedRelays: [...relays].filter(([, n]) => n > 1).map(([relay]) => relay),
  };
}
module.exports = { validateProviders, validateAssetStore, KINDS };
