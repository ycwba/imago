/* AI 建模 —— 契约调用、流式渐进解析、复用判定、ops 修改。
   契约正文在 `skills/model3d/SKILL.md`（与 `TextAI.DEF.model3d` 同源），这里只管五件事：

   1. **喂什么**：用户这一句 + 勾选的白模库模型清单（可多库）+ 库里有动画的摆件清单 + 当前场景
      （全部节点 / 机位 / 轨道，不截断；选中的子树完整再给一份）+ 参考图；
   2. **新建怎么收**：模型是一棵树，`"nodes":[…]` 里每收全一个对象就能建一个零件出来 ——
      `scanNodes` 按括号配平把它捞出来，调用方每个节点重建一次场景（这就是「实时预览」）；
   3. **修改怎么收**：默认只收 `{"say":"…","ops":[…]}`，在克隆上经 `schema.applyDocOps` 应用；
      坏 op 跳过并计数；只有新建 / 复用才收整份 `model`；
   4. **复用**：AI 可以回 `reuse:{id,mode}` —— `as-is` 表示「不用改，就用那一个」，
      `base` 表示「以它当底稿改」；
   5. **坏数据**：单个节点解析不出来只丢那一个（`dropped` 计数交给界面照实报），
      整份没有就返回 null 让页面保留上一版。

   CSP 不放行 eval，所以 AI 只能交数据；这条路走的是「写一棵参数化树」，不是 text-to-3D 服务。 */

import { parseJsonLoose } from '../domain/json-loose.js';
import { normalizeDoc, applyDocOps, findNode } from './schema.js';

const CONTRACT = 'model3d.json';

const line = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/* AI 明确给出的时间轴设置（duration / fps / loop）。normalizeDoc 会补默认值，
   所以只认原始 model.anim 里真的写出来的字段；没写的不要覆盖用户当前设置。 */
function animSpecOf(model) {
  const a = model && model.anim;
  if (!a || typeof a !== 'object') return null;
  return {
    duration: Number(a.duration) > 0 ? Number(a.duration) : 0,
    fps: Number(a.fps) > 0 ? Math.round(Number(a.fps)) : 0,
    loop: a.loop == null ? null : a.loop !== false,
  };
}

/* 可调用的白模库清单：一行一条，够 AI 判断「要不要复用」。
   `library` 只在跨库清单里出现，写进 id 让复用能回到正确的库。
   条数与每行长度都不设上限 —— 清单太长时用户自己少勾几个库。 */
export function catalogText(models) {
  const rows = (models || []).map(m => {
    const nodes = Number(m.nodes) > 0 ? '（' + m.nodes + ' 个零件）' : '';
    const why = m.note ? '：' + String(m.note) : '';
    const id = m.library ? String(m.library) + ' :: ' + m.id : m.id;
    return '- ' + id + nodes + why;
  });
  return rows.length ? rows.join('\n') : '（勾选的白模库里还没有模型）';
}

/* 库里有动画的摆件清单：AI 写 clip 时只能填这里列出的 clip 名。
   条数、文件名、clip 名与整行长度都不设上限。 */
export function animationText(entries) {
  const rows = [];
  for (const it of (entries || [])) {
    const file = String((it && it.file) || '');
    const clips = ((it && it.clips) || []).map(c => String(c == null ? '' : c).trim()).filter(Boolean);
    if (!file || !clips.length) continue;
    rows.push('- ' + file + '：' + clips.join(' / '));
  }
  return rows.length ? '库里带动画的摆件（clip 只能从这里列出的名字里选）：\n' + rows.join('\n') : '';
}

/* 给 AI 看的紧凑节点：省略默认值，但所有几何字段与所有节点都保留，不截断。 */
function compactNode(n) {
  const o = {};
  for (const k of Object.keys(n)) {
    if (k === 'children') continue;
    o[k] = n[k];
  }
  if (o.at && o.at[0] === 0 && o.at[1] === 0 && o.at[2] === 0) delete o.at;
  if (o.rot && o.rot[0] === 0 && o.rot[1] === 0 && o.rot[2] === 0) delete o.rot;
  if (o.scale && o.scale[0] === 1 && o.scale[1] === 1 && o.scale[2] === 1) delete o.scale;
  if (n.kind === 'asset') {
    if (!o.clip) delete o.clip;
    if (o.clipSpeed === 1) delete o.clipSpeed;
    if (o.clipLoop === 'loop') delete o.clipLoop;
    if (o.clipOffset === 0) delete o.clipOffset;
    if (o.clay === true) delete o.clay;
  }
  if (n.kind === 'prim' && o.tone === 'hi') delete o.tone;
  if (n.kind === 'mannequin' && o.tone === 'hi') delete o.tone;
  if (n.kind === 'crowd' && o.tone === 'mid') delete o.tone;
  if (n.children && n.children.length) o.children = n.children.map(compactNode);
  return o;
}

/* 当前模型：机位、节点、轨道全部给；节点只省略默认值。不截断节点数 / 字符数。 */
export function currentText(doc, selectedId) {
  if (!doc || !doc.scene || !doc.scene.nodes || !doc.scene.nodes.length) {
    return '（新建：当前没有模型；这是全新生成，不是修改）';
  }
  const body = {
    kind: doc.kind || 'model',
    name: doc.name,
    group: doc.group,
    scene: {
      view: doc.scene.view,
      panorama: doc.scene.panorama,
      cams: doc.scene.cams,
      active: doc.scene.active,
      nodes: doc.scene.nodes.map(compactNode),
    },
    anim: doc.anim,
  };
  if (selectedId) {
    const n = findNode(doc.scene.nodes, selectedId);
    if (n) body.selected = n;
  }
  return JSON.stringify(body);
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

/* 跑一轮。返回 { say, reuse, doc, ops, applied, skipped, errors, dropped, raw, fallback }：
   · `reuse.mode === 'as-is'` 时 `doc` 为 null（页面该去加载 `reuse.id` 那一份）；
   · `doc` 为 null 且没有 reuse 时表示这一轮没拿到可用的树 / ops（页面保留上一版并报错）。
   新建模式流式过程中每收到新的完整节点就回调一次 `onNodes(nodes, text)`；
   修改模式只回显正文，不边收边改（ops 必须整份收全才能可靠应用）。 */
export async function run(opts) {
  const {
    prompt, doc, mode: modeIn, catalog, animations, aspect, selectedId, images, scope,
    signal, onNodes, onSay, onText,
  } = opts || {};
  const TextAI = window.TextAI;
  if (!TextAI) throw new Error('文字 AI 没就绪');
  const REG = await window.Api.registry();
  if (!TextAI.prov(REG)) throw new Error('没有可用的文字 AI');
  if (!(await TextAI.canRun(REG))) throw new Error('请先在「设置」填文字 AI 密钥');

  const mode = modeIn === 'auto' ? 'auto'
    : (modeIn === 'edit' ? 'edit' : (modeIn === 'entity' ? 'entity' : (modeIn === 'new' ? 'new' : (doc && doc.scene.nodes.length ? 'edit' : 'new'))));
  /* 清单为空时给一个空格：TplVars 把空串当「这一项没料」、占位符会原样留着，
     一个空格才让整段从提示词里消失（不占 token，也不会让 AI 以为漏了材料）。 */
  const anims = animationText(animations);
  const refs = (images || []).map((x, i) => {
    const label = line(x && (x.label || x.name)) || ('图' + (i + 1));
    return '图' + (i + 1) + ' = ' + label;
  });
  const vars = {
    prompt: String(prompt || ''),
    catalog: String(catalog || '（这次没有可调用的白模库）'),
    animations: anims || ' ',
    current: currentText(doc, selectedId),
    selected: selectedId ? ('当前选中：' + selectedId) : '（当前没有选中对象）',
    refImages: refs.length ? refs.join('、') : '（这次没有参考图）',
    aspect: String(aspect || '16:9'),
    mode: mode === 'auto' ? '自动判断：没选中就新增实体；选中了就按用户的话修改选中的实体'
      : mode === 'edit' ? '修改选中实体'
        : (mode === 'entity' ? '在场景里新增一个实体' : '新建一个模型'),
  };
  const m = messages(vars);
  let buf = '';
  let lastCount = 0;
  const push = chunk => {
    buf += chunk;
    if (mode === 'new') {
      const nodes = scanNodes(buf);
      if (nodes.length !== lastCount) {
        lastCount = nodes.length;
        if (onNodes) { try { onNodes(nodes, buf); } catch (e) { /* 预览重建失败不该打断生成 */ } }
      }
    }
    /* 原文逐块交出去：界面上「AI 正在写什么」是实时可见的（不是等收完才显示） */
    if (onText) { try { onText(buf, lastCount); } catch (e) { /* 回显失败不影响生成 */ } }
    /* status 那一行用第一句「say」：模型通常会先说一句再给树 / ops */
    if (onSay) {
      const hit = /"say"\s*:\s*"([^"]*)/.exec(buf);
      if (hit) onSay(hit[1]);
    }
  };

  const txt = await TextAI.chatStream(REG, m.sys, m.user, { signal, noTools: true, images }, push);
  const loose = parseJsonLoose(txt) || tryParseTail(buf);
  if (!loose || typeof loose !== 'object') {
    return { say: '', reuse: null, doc: null, ops: [], applied: 0, skipped: 0, errors: [], dropped: null, raw: txt, why: '这一轮没有拿到 JSON' };
  }
  const say = String(loose.say || '');
  const reuseRaw = loose.reuse;
  const reuse = (reuseRaw && reuseRaw.id) ? {
    id: String(reuseRaw.id),
    mode: reuseRaw.mode === 'as-is' ? 'as-is' : 'base',
    why: String(reuseRaw.why || ''),
  } : null;
  if (reuse && reuse.mode === 'as-is') {
    return { say, reuse, doc: null, ops: [], applied: 0, skipped: 0, errors: [], dropped: null, raw: txt };
  }

  /* 自动：选中了且回 ops → 改选中实体；否则回 model → 新增一个实体。
     不把 ops 应用到没选中的场景上 —— 那是「AI 自己删了别的东西」的那条路。 */
  if (mode === 'auto' && doc) {
    const ops = Array.isArray(loose.ops) ? loose.ops : [];
    if (ops.length && selectedId) {
      const r = applyDocOps(doc, ops, { scope: Array.isArray(scope) ? new Set(scope) : null });
      return {
        say, reuse, doc: r.doc, ops,
        applied: r.applied, skipped: r.skipped, errors: r.errors,
        dropped: r.dropped, raw: txt, fallback: '',
        why: (!r.doc.scene.nodes.length ? '这一轮把模型改空了' : ''),
      };
    }
    const model = (loose.model && typeof loose.model === 'object') ? loose.model
      : (loose.scene && typeof loose.scene === 'object' ? loose : null);
    if (model) {
      const out = normalizeDoc(model);
      return {
        say, reuse, doc: out.doc, ops: [], applied: 0, skipped: 0, errors: [],
        dropped: out.dropped, raw: txt, fallback: 'model', anim: animSpecOf(model),
        name: line(model && model.name),
        why: (!out.doc.scene.nodes.length ? '这一轮没有任何零件' : ''),
      };
    }
    return {
      say, reuse, doc: null, ops: [], applied: 0, skipped: 0, errors: [], dropped: null, raw: txt,
      why: selectedId ? '这一轮既没有 ops，也没有新实体' : '这一轮没有拿到新实体',
    };
  }

  /* 修改：默认 ops。整份 model 只在新建 / 复用时收；编辑模式收到 model 也接受，
     但明确标成 fallback，界面照实说「AI 返回了完整模型」。 */
  if (mode === 'edit' && doc) {
    const ops = Array.isArray(loose.ops) ? loose.ops : [];
    if (ops.length) {
      const r = applyDocOps(doc, ops, { scope: Array.isArray(scope) ? new Set(scope) : null });
      return {
        say, reuse, doc: r.doc, ops,
        applied: r.applied, skipped: r.skipped, errors: r.errors,
        dropped: r.dropped, raw: txt, fallback: '',
        why: (!r.doc.scene.nodes.length ? '这一轮把模型改空了' : ''),
      };
    }
    if (loose.model && typeof loose.model === 'object') {
      const out = normalizeDoc(loose.model);
      return {
        say, reuse, doc: out.doc, ops: [], applied: 0, skipped: 0, errors: [],
        dropped: out.dropped, raw: txt, fallback: 'model',
        why: (!out.doc.scene.nodes.length ? '这一轮没有任何零件' : ''),
      };
    }
    return { say, reuse, doc: null, ops: [], applied: 0, skipped: 0, errors: [], dropped: null, raw: txt, why: '修改模式没有拿到 ops' };
  }

  const model = loose.model || loose;
  const out = normalizeDoc(model);
  /* 复用关系写进 doc.src：模型文件自己记得「我是照着谁改的」 */
  out.doc.src = { prompt: String(prompt || ''), reuse };
  return {
    say, reuse, doc: out.doc, ops: [], applied: 0, skipped: 0, errors: [],
    dropped: out.dropped, raw: txt, fallback: '', anim: animSpecOf(model),
    name: line(model && model.name),
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
