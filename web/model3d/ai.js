/* AI 建模 —— 契约调用、流式渐进解析、复用判定。
   契约正文在 `skills/model3d/SKILL.md`（与 `TextAI.DEF.model3d` 同源），这里只管四件事：

   1. **喂什么**：用户这一句 + 历史白膜清单（可关）+ 库里有动画的摆件清单 + 当前模型（改模型时）+ 画幅；
   2. **边收边建**：模型是一棵树，`"nodes":[…]` 里每收全一个对象就能建一个零件出来 ——
      `scanNodes` 按括号配平把它捞出来，调用方每个节点重建一次场景（这就是「实时预览」）；
   3. **复用**：AI 可以回 `reuse:{id,mode}` —— `as-is` 表示「不用改，就用那一个」，
      `base` 表示「以它当底稿改」。判据在这里落成两种返回，页面照它决定要不要替换当前模型；
   4. **坏数据**：单个节点解析不出来只丢那一个（`dropped` 计数交给界面照实报），
      整份没有就返回 null 让页面保留上一版。

   CSP 不放行 eval，所以 AI 只能交数据；这条路走的是「写一棵参数化树」，不是 text-to-3D 服务。 */

import { parseJsonLoose } from '../domain/json-loose.js';
import { normalizeDoc } from './schema.js';

const CONTRACT = 'model3d.json';

/* 历史白膜清单：一行一条，够 AI 判断「要不要复用」。控制在 40 条、每条 60 字以内 ——
   清单太长会把真正的要求挤掉，而且用户等的是模型不是目录。 */
export function catalogText(models, limit = 40) {
  const rows = (models || []).slice(0, limit).map(m => {
    const nodes = Number(m.nodes) > 0 ? '（' + m.nodes + ' 个零件）' : '';
    const why = m.note ? '：' + String(m.note).slice(0, 40) : '';
    return '- ' + m.id + nodes + why;
  });
  return rows.length ? rows.join('\n') : '（还没有存过的白膜）';
}

/* 库里有动画的摆件清单：AI 写 `asset.clip` 时只能填这里列出的名字。
   一条 = 「文件名：clip1 / clip2」，最多 20 条、每条 60 字以内 —— 中文文件名很占 token，
   不截断会把真正的要求挤掉。没有带动画的文件时返回空串（调用方用空格顶掉占位符）。 */
export function animationText(entries, limit = 20) {
  const rows = [];
  for (const it of entries || []) {
    const file = String((it && it.file) || '').slice(0, 36);
    const clips = (Array.isArray(it && it.clips) ? it.clips : [])
      .map(c => String(c == null ? '' : c).trim()).filter(Boolean).map(c => c.slice(0, 20));
    if (!file || !clips.length) continue;
    const line = '- ' + file + '：' + clips.join(' / ');
    rows.push(line.length > 60 ? line.slice(0, 59) + '…' : line);
    if (rows.length >= limit) break;
  }
  return rows.length
    ? '**库里有动画的摆件**（`asset` 节点写 `clip` 时只能填这里列出的名字）：\n' + rows.join('\n')
    : '';
}

/* 当前模型给 AI 看的那一份：去掉时间戳这类噪音，节点数太多时只留结构摘要。
   为什么要截断：一整棵树动辄几千 token，改一个零件不值得把上下文全花在它上面。 */
export function currentText(doc, maxNodes = 60) {
  if (!doc) return '（这是新建，没有旧模型）';
  const nodes = (doc.scene && doc.scene.nodes) || [];
  const slim = n => {
    const o = { id: n.id, kind: n.kind };
    if (n.name) o.name = n.name;
    if (n.shape) o.shape = n.shape;
    if (n.kind === 'mannequin' || n.kind === 'crowd') { o.body = n.body; o.pose = n.pose; }
    if (n.kind === 'asset') {
      o.file = n.file;
      if (n.clip) {
        o.clip = n.clip;
        if (n.clipSpeed !== 1) o.clipSpeed = n.clipSpeed;
        if (n.clipLoop && n.clipLoop !== 'loop') o.clipLoop = n.clipLoop;
        if (n.clipOffset) o.clipOffset = n.clipOffset;
      }
    }
    if (n.at) o.at = n.at;
    if (n.rot && (n.rot[0] || n.rot[1] || n.rot[2])) o.rot = n.rot;
    if (n.children) o.children = n.children.map(slim);
    return o;
  };
  const body = {
    scene: { nodes: nodes.slice(0, maxNodes).map(slim), camera: doc.scene.camera, view: doc.scene.view },
    anim: doc.anim,
  };
  const txt = JSON.stringify(body);
  return txt.length > 9000 ? txt.slice(0, 9000) + '…（后面截断了，按结构改就行）' : txt;
}

/* 流式里「已经收全的那些节点」：从 `"nodes":[` 开始按括号配平扫，
   每收全一个顶层对象就试 JSON.parse —— 解不出来就当它还没收全（下一个 chunk 再试）。 */
export function scanNodes(text) {
  const s = String(text || '');
  const at = s.indexOf('"nodes"');
  if (at < 0) return [];
  const open = s.indexOf('[', at);
  if (open < 0) return [];
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = open + 1; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (depth === 0) break;                       // nodes 数组到头了
      depth -= 1;
      if (depth === 0 && start >= 0 && ch === '}') {
        try { out.push(JSON.parse(s.slice(start, i + 1))); } catch (e) { /* 还没收全，跳过 */ }
        start = -1;
      }
      continue;
    }
  }
  return out;
}

/* 这一轮的 system / user：占位符由 TextAI.prompt 填（填不上时占位符原样留着，AI 会自己补） */
function messages(vars) {
  const sys = window.TextAI.prompt('model3d', false, vars);
  const user = '按上面的要求输出 JSON。这一句是用户的要求：' + String(vars.prompt || '');
  return { sys, user };
}

/* 跑一轮。返回 { say, reuse, doc, dropped, raw }：
   · `reuse.mode === 'as-is'` 时 `doc` 为 null（页面该去加载 `reuse.id` 那一份）；
   · `doc` 为 null 且没有 reuse 时表示这一轮没拿到可用的树（页面保留上一版并报错）。
   流式过程中每收到新的完整节点就回调一次 `onNodes(nodes, text)`。 */
export async function run(opts) {
  const { prompt, doc, catalog, animations, aspect, signal, onNodes, onSay, onText } = opts || {};
  const TextAI = window.TextAI;
  if (!TextAI) throw new Error('文字 AI 没就绪');
  const REG = await window.Api.registry();
  if (!TextAI.prov(REG)) throw new Error('没有可用的文字 AI');
  if (!(await TextAI.canRun(REG))) throw new Error('请先在「设置」填文字 AI 密钥');

  /* 清单为空时给一个空格：TplVars 把空串当「这一项没料」、占位符会原样留着，
     一个空格才让整段从提示词里消失（不占 token，也不会让 AI 以为漏了材料）。 */
  const anims = animationText(animations);
  const vars = {
    prompt: String(prompt || '').slice(0, 1200),
    catalog: String(catalog || '（这次不参考历史白膜）'),
    animations: anims || ' ',
    current: currentText(doc),
    aspect: String(aspect || '16:9'),
  };
  const m = messages(vars);
  let buf = '';
  let lastCount = 0;
  const push = chunk => {
    buf += chunk;
    const nodes = scanNodes(buf);
    if (nodes.length !== lastCount) {
      lastCount = nodes.length;
      if (onNodes) { try { onNodes(nodes, buf); } catch (e) { /* 预览重建失败不该打断生成 */ } }
    }
    /* 原文逐块交出去：界面上「AI 正在写什么」是实时可见的（不是等收完才显示） */
    if (onText) { try { onText(buf, nodes.length); } catch (e) { /* 回显失败不影响生成 */ } }
    /* status 那一行用第一句「say」：模型通常会先说一句再给树 */
    if (onSay) {
      const hit = /"say"\s*:\s*"([^"]{0,120})/.exec(buf);
      if (hit) onSay(hit[1]);
    }
  };

  const txt = await TextAI.chatStream(REG, m.sys, m.user, { signal, noTools: true }, push);
  const loose = parseJsonLoose(txt) || tryParseTail(buf);
  if (!loose || typeof loose !== 'object') {
    return { say: '', reuse: null, doc: null, dropped: null, raw: txt, why: '这一轮没有拿到 JSON' };
  }
  const say = String(loose.say || '').slice(0, 300);
  const reuseRaw = loose.reuse;
  const reuse = (reuseRaw && reuseRaw.id) ? {
    id: String(reuseRaw.id).slice(0, 120),
    mode: reuseRaw.mode === 'as-is' ? 'as-is' : 'base',
    why: String(reuseRaw.why || '').slice(0, 160),
  } : null;
  if (reuse && reuse.mode === 'as-is') return { say, reuse, doc: null, dropped: null, raw: txt };
  const model = loose.model || loose;
  const out = normalizeDoc(model);
  /* 复用关系写进 doc.src：模型文件自己记得「我是照着谁改的」 */
  out.doc.src = { prompt: String(prompt || '').slice(0, 2000), reuse };
  return {
    say, reuse,
    doc: out.doc,
    dropped: out.dropped,
    raw: txt,
    why: (!out.doc.scene.nodes.length ? '这一轮没有任何零件' : ''),
  };
}

/* 兜底：AI 把 JSON 写在最后一段、`parseJsonLoose` 也没捞到时，从尾巴上找最外层对象 */
function tryParseTail(text) {
  const s = String(text || '');
  const end = s.lastIndexOf('}');
  if (end < 0) return null;
  for (let start = s.indexOf('{'); start >= 0 && start < end; start = s.indexOf('{', start + 1)) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { /* 从下一个 { 再试 */ }
  }
  return null;
}

export { CONTRACT };
