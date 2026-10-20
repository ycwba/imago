/* 画布里的「生成」：一条链都不新写，只把节点参数翻译成公共层的调用。
   图片 = AiGen.create + AiGen.wait（两段是为了切页后能按任务号认领回来，不重发不重复扣费）；
   音频 = AiGen.synthTts（同步合成，没有平台任务号）；
   视频 = Api.create + Api.pollTask（状态判定交给 Api.parseItem，页面不自己认状态词）。 */
import { labelOf, MEDIA_KINDS } from './registry.js';

/* 产物类型直接读注册表那三档：这里再列一遍字面量，注册表加一档就又多一份「过时名单」。 */
const kindOf = t => (MEDIA_KINDS.includes(t) ? t : '');

/* 平台与型号都从注册表现取：这一页没有添加过供应商时列表是空的，界面要照实说。 */
export function provsFor(kind) {
  const A = window.Api;
  if (!A || !A.forKind) return [];
  try { return (A.forKind(kind) || []).filter(p => !A.isOff || !A.isOff(p)); } catch (e) { return []; }
}

export function provOf(id) {
  const A = window.Api;
  if (!A || !id) return null;
  try { return A.prov(id) || null; } catch (e) { return null; }
}

export function modelsOf(prov) {
  const list = (prov && prov.models) || [];
  return list.map(m => ({ id: m.id, name: m.name || m.id, raw: m }));
}

/* 一个型号收哪些 role 只问 Capabilities：这里按「产物类型」挑第一个能收的输入槽。
   交回的是整份声明 —— 「收哪个 role」与「一次收几路」是同一份数据里的两件事，
   只回 role 的话，超上限的那几路就只能默默发出去、让平台回一个 400。 */
export function inputSpec(model, kind) {
  const C = window.Capabilities;
  if (!C || !model) return null;
  const specs = C.specs(model) || [];
  const want = kind === 'image' ? ['image', 'first_frame', 'reference_image']
    : kind === 'video' ? ['image', 'first_frame', 'video'] : ['audio'];
  for (const w of want) { const s = specs.find(x => x.role === w); if (s) return s; }
  /* 挑不到就不借别人的槽：宁可一个不发并照实报「挤掉了几路」，也不能把参考图塞进
     一个声明里根本没有图像输入位的型号 —— 那是平台一句 400，界面上看不出为什么。 */
  return null;
}

/* 参数优先级：节点自己写死的 > 连进来的配置节点 > 连进来的文本节点当提示词。
   返回 { prov, model, prompt, params, inputs, missing, title }；prov/model 缺任何一个都是「还没配」。 */
export function resolve(doc, node) {
  const meta = node.metadata || {};
  const out = { prov: meta.prov || '', model: meta.model || '', prompt: meta.prompt || '', title: '',
    params: { ...(meta.params || {}) }, inputs: [], missing: [], from: [] };
  const ins = (doc.connections || []).filter(c => c.toNodeId === node.id);
  for (const c of ins) {
    const src = (doc.nodes || []).find(n => n.id === c.fromNodeId);
    if (!src) continue;
    if (src.type === 'config') {
      const m = src.metadata || {};
      if (!out.prov && m.prov) out.prov = m.prov;
      if (!out.model && m.model) out.model = m.model;
      if (!out.prompt && m.prompt) out.prompt = m.prompt;
      if (m.params && Object.keys(m.params).length) out.params = { ...m.params, ...out.params };
      out.from.push(src.id);
    } else if (src.type === 'text') {
      if (!out.prompt && (src.metadata || {}).content) out.prompt = String(src.metadata.content).slice(0, 20000);
      if (!out.title) out.title = src.title;
      out.from.push(src.id);
    } else {
      const sm = src.metadata || {};
      const id = sm.assetId || (src.type === 'asset-ref' ? sm.sourceAssetId : '');
      if (id) { out.inputs.push({ from: src.id, assetId: id, kind: src.type === 'asset-ref' ? sm.assetKind || 'image' : src.type }); continue; }
      /* 线那头是一个还没出东西的素材节点：记进 missing，让 whyReady 拦一下。
         默默丢掉这一路等于「用户接了参考图，生成出来跟没接一样」—— 那是最难查的错。 */
      out.missing.push(String(src.title || '').trim() || labelOf(src.type));
      out.from.push(src.id);
    }
  }
  return out;
}

export function whyReady(doc, node) {
  const kind = kindOf(node.type);
  if (!kind) return '这种节点不生成东西';
  const r = resolve(doc, node);
  if (r.missing.length) {
    return '连过来的素材还没有产物：' + r.missing.slice(0, 3).join('、')
      + (r.missing.length > 3 ? ' 等 ' + r.missing.length + ' 个' : '') + ' —— 先让那一些出东西，或把线断开';
  }
  if (!r.prov) return '还没有平台：在配置节点里选一家，或在这个节点上直接选';
  if (!r.model) return '还没有型号';
  if (!String(r.prompt || '').trim() && kind !== 'video') return '提示词是空的';
  const p = provOf(r.prov);
  if (!p) return '这一家平台现在不在注册表里了（可能被删掉或改了 id）';
  if (!(p.models || []).some(m => m.id === r.model)) return '这个型号不在「' + (p.displayName || p.name || p.id) + '」现在的清单里，重选一个';
  return '';
}

/* 提交：拿到任务号的那一刻回调 onTask（页面立刻落盘），然后交给调用方继续等。
   音频是同步合成，没有任务号 —— 这条照实说明，界面上不画「取消」。 */
export async function submit(doc, node, o = {}) {
  const kind = kindOf(node.type);
  if (!kind) throw new Error('这种节点不生成东西');
  const r = resolve(doc, node);
  const why = whyReady(doc, node);
  if (why) throw new Error(why);
  const prov = provOf(r.prov);
  const model = (prov.models || []).find(m => m.id === r.model) || {};
  /* 输入素材按声明收：型号不收输入就一个不发；收 N 路而线头有 N+1 个就发前 N 个，
     并把「挤掉了几路」照实带回页面 —— 上限只来自 Capabilities，这里不写死。 */
  const spec = inputSpec(model, kind);
  const role = spec ? spec.role : '';
  const cap = spec && Number(spec.max) > 0 ? Number(spec.max) : 0;
  const room = role ? Math.min(r.inputs.length, cap || r.inputs.length) : 0;
  const entries = [];
  for (let i = 0; i < room; i++) entries.push({ role, assetId: r.inputs[i].assetId });
  const droppedInputs = r.inputs.length - room;
  if (kind === 'audio') {
    const res = await window.AiGen.synthTts(prov, { model: model.id, text: String(r.prompt || ''),
      voice: (r.params && r.params.voice) || '', name: (node.title || '画布语音') + '', meta: { canvasNodeId: node.id } });
    return { kind, sync: true, assetId: res.assetId, src: res.url, format: res.format, bytes: res.bytes, droppedInputs };
  }
  /* 参数键名一律是 `Api.createBody` 认的那一份局部名（res / ar / quality / tier / format / size /
     duration / count，见 AdvParams.SPEC）：节点 metadata.params 存的也是这些。
     这里以前写 `resolution:` —— 那个名字只有能力声明的**档位键**用过，createBody 读的是 `f.res`，
     于是画布里选好的「画质」在视频提交那一趟里被静默丢掉，界面选了、平台收到默认档。 */
  const base = { prov, model, prompt: String(r.prompt || ''), ar: r.params.ar, count: r.params.count,
    quality: r.params.quality, res: r.params.res, tier: r.params.tier,
    format: r.params.format, size: r.params.size, duration: r.params.duration, inputEntries: entries };
  if (kind === 'image') {
    const t = await window.AiGen.create({ ...base,
      onTask: x => { if (o.onTask) o.onTask(String(x.id)); }, log: { type: '画布生成', meta: { 节点: node.id } } });
    return { kind, taskId: String(t.id), t, want: t.want, fmt: t.fmt, droppedInputs };
  }
  const raw = await window.Api.create(prov, { model: model.id, prompt: base.prompt,
    ar: base.ar, duration: base.duration, count: base.count, tier: base.tier, res: base.res,
    inputEntries: entries, note: '画布提交', log: { type: '画布生成', meta: { 节点: node.id } } });
  const p = window.Api.parseItem(prov, raw) || {};
  const id = String(p.genId || (raw && (raw.id || raw.task_id || raw.job_id)) || '');
  if (!id) throw new Error((raw && (raw.message || raw.code)) || '接口没有返回任务号');
  if (o.onTask) o.onTask(id);
  /* 公共层一律写 window.X：ESM 里裸 `AiGen` / `Api` 靠的是「window 属性同时是全局名」这层运气，
     一旦这个名字没挂上就是 ReferenceError（Node 侧一跑就红，浏览器里则要等用户点到那一条）。 */
  if (p.failed) throw new Error(window.Api.errorMessage ? window.Api.errorMessage(p.error || raw) : '提交就被判失败');
  return { kind, taskId: id, prov, want: 1, fmt: '', droppedInputs };
}

/* 图片的「接着等」：AiGen.wait 里已经认了 pollVia:'list'、多张凑齐、外链换 /getv。 */
export async function waitImage(t) {
  const e = await window.AiGen.wait(t);
  return { assetId: e.assetId || '', src: e.src || '', kind: 'image', genId: e.genId || '',
    entries: (e.entries || []).length };
}

/* 单次问状态：给 Wb.poller 的 pollOne 用。返回 { done, failed, assetId, src, why }。 */
export async function pollOnce(provRef, id) {
  const prov = typeof provRef === 'object' ? provRef : provOf(String(provRef || ''));
  if (!prov) return { failed: true, why: '这一家平台现在不在注册表里了（可能被删掉或改了 id）' };
  const raw = (await window.Api.pollTask(prov, id)).raw;
  const p = window.Api.parseItem(prov, raw) || {};
  const ids = (window.AiGen && window.AiGen.outputIds(prov, raw)) || [];
  if (ids.length || p.url) {
    const src = p.url ? window.Api.mediaSrc(p.url) : '';
    return { done: true, assetId: ids[0] || '', src, genId: String(id),
      all: ids, dl: p.url ? '/fetch?url=' + encodeURIComponent(p.url) + '&dl=1' : '' };
  }
  const why = p.error && (p.error.message || p.error);
  if (why) return { failed: true, why: String(why) };
  if (p.failed) return { failed: true, why: '生成失败' + (p.status ? '（' + p.status + '）' : '') };
  return { running: true, status: p.status || '进行中' };
}

/* 产物落进节点后推一次镜像事件：与工作台/导演台同一个出口 `AssetLocal.announce`
   （字段归一化、la_ 与没地址的过滤、同批去重都在那一条里，见 local.js）。 */
export function announce(entry) {
  if (!entry) return;
  window.AssetLocal.announce([entry]);
}

export { kindOf };
