/* AI 建模 —— 契约调用、流式渐进解析、复用判定、ops 修改。
   契约正文在 `skills/model3d/SKILL.md`（与 `TextAI.DEF.model3d` 同源），这里只管五件事：

   1. **喂什么**：用户这一句 + 服务端按这一句在全部白模库里检索到的模型清单 + 库里有动画的摆件清单 + 当前场景
      （大纲只给骨架；选中的子树给全字段且只给一遍；两段合计超过预算时子树也退成骨架）+ 参考图；
   2. **新建怎么收**：模型是一棵树，`"nodes":[…]` 里每收全一个对象就能建一个零件出来 ——
      `scanNodes` 按括号配平把它捞出来，调用方每个节点重建一次场景（这就是「实时预览」）；
   3. **修改怎么收**：默认只收 `{"say":"…","ops":[…]}`，在克隆上经 `schema.applyDocOps` 应用；
      坏 op 跳过并计数；只有新建 / 复用才收整份 `model`；
   4. **复用**：AI 可以回 `reuse:{id,mode}` —— `as-is` 表示「不用改，就用那一个」，
      `base` 表示「以它当底稿改」；
   5. **坏数据**：单个节点解析不出来只丢那一个（`dropped` 计数 + 明细交给界面照实报），
      整份没有就返回 null 让页面保留上一版；
   6. **几何体检**：整份模型进场景前过 `lint.js`（悬空落地 / 身高夹取 / 出画幅缩放），
      修了什么并进 `say`；体检结论、丢件明细与被跳过的修改一起整理成「上一轮的问题」，
      随结果交回页面，下一轮原样喂回提示词；
   7. **自查工具**：拿不准空间与构图时，AI 可以先要一次测量（当前场景包围盒 / 选中子树包围盒 /
      当前视口缩略图），程序量完把结果交回去再让它继续 —— 只开这三条，没有别的工具。

   CSP 不放行 eval，所以 AI 只能交数据；这条路走的是「写一棵参数化树」，不是 text-to-3D 服务。 */

import { parseJsonLoose } from '../domain/json-loose.js';
import { normalizeDoc, applyDocOps, findNode, outlineOf, sparseTrack, round3 } from './schema.js';
import { subtreeIds } from './entities.js';
import { lintDoc, boundsOfScene } from './lint.js';

const CONTRACT = 'model3d.json';

/* 「当前场景」那一段的字符预算（大纲 + 选中子树的完整字段）。超了就把选中子树退成骨架。
   不做配置项：这是提示词的硬上限，不是可调的画质 —— 文档本身多大都照收。 */
const SCENE_MAX_CHARS = 16000;

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

/* 整份模型进场景之前先过几何体检：站不站得住、进不进画幅。只修位置与比例、不丢零件；
   明细随结果交回页面（并进 say，下一轮再喂回提示词）。改选中实体的 ops 不走这里 ——
   那是用户已经在编辑的场景，把既有零件挪到地上比不动更意外。 */
function lintedModel(model, aspect) {
  const out = normalizeDoc(model);
  const lint = lintDoc(out.doc, { aspect });
  return {
    doc: lint.doc,
    dropped: out.dropped,
    lint: { fixes: lint.fixes, warnings: lint.warnings },
  };
}

/* 几何体检的结论并进 say：模型自己那句话在前，改了什么 / 提醒什么跟在后面。
   什么都没发现就原样交回，不往 say 里塞空话。 */
export function lintSayOf(say, lint) {
  const text = String(say || '');
  const lines = [];
  const fixes = (lint && lint.fixes) || [];
  const warns = (lint && lint.warnings) || [];
  if (fixes.length) lines.push('几何体检：' + fixes.join('；'));
  if (warns.length) lines.push('体检提醒：' + warns.join('；'));
  if (!lines.length) return text;
  const tail = '（' + lines.join('。') + '）';
  return text ? text.replace(/\s+$/, '') + '\n' + tail : tail;
}

/* 上一轮的问题：丢掉的条目、被跳过的修改、几何体检的结论，整理成一小段文字。
   下一轮把它当 {problems} 喂回提示词 —— AI 才知道上一轮错在哪，不会对着一棵少了零件的树
   继续引用已不存在的 id（那条 op 再被 scope 拒掉，用户只看到「什么也没发生」）。
   没有问题时给一个空格：TplVars 把空串当「这一项没料」、占位符会原样留着，
   一个空格才让整段从提示词里消失。 */
export function problemsTextOf(r) {
  const lines = [];
  const details = (r && r.dropped && Array.isArray(r.dropped.details)) ? r.dropped.details : [];
  for (const d of details) {
    const what = d.what === 'cam' ? '一个机位' : d.what === 'track' ? '一条轨道'
      : d.what === 'out' ? '一条出片记录' : '一个零件';
    const label = d.id ? (d.id + (d.name ? '「' + d.name + '」' : '')) : what;
    lines.push('丢了 ' + label + '（' + d.why + '）');
  }
  for (const e of ((r && Array.isArray(r.errors)) ? r.errors : [])) {
    if (e && e.why) lines.push('跳过一条修改：' + e.why);
  }
  const lint = (r && r.lint) || {};
  for (const f of (Array.isArray(lint.fixes) ? lint.fixes : [])) lines.push('几何体检改过：' + f);
  for (const w of (Array.isArray(lint.warnings) ? lint.warnings : [])) lines.push('体检提醒：' + w);
  if (r && r.why) lines.push('这一轮的结果：' + r.why);
  if (!lines.length) return ' ';
  return '**上一轮的问题**（程序按上一轮结果整理；这一轮别重犯）：\n' + lines.map(x => '- ' + x).join('\n');
}

/* ---------- 自查工具（只在建模这一轮开着） ---------- */

/* 三条只读工具：量当前场景 / 量选中子树 / 看一眼视口。AI 拿不准空间与构图时先问一句，
   程序量完把结果交回去，它再继续写最终的树 —— 比盲猜「主体居中偏下」可靠。
   工具结果只给模型看；最终输出仍是契约要求的那份 JSON。
   轮次照联网工具那一套收口：几轮之后不再接 CALL，收一次尾让它直接交结果。 */
const TOOL_MAX_ROUNDS = 3;
const TOOL_NOTE = '【自查工具（这次建模里可用）】拿不准场景的空间与构图时，先只输出一行 CALL，'
  + '程序量完把结果交回给你，你再继续完成原任务；不需要就完全不要提这些工具。\n'
  + '量当前场景的包围盒：CALL: get_scene_bbox {}\n'
  + '量当前选中子树的包围盒：CALL: get_selected_bbox {}\n'
  + '看一眼当前构图：CALL: render_thumbnail {}\n'
  + 'CALL 单独占一行，不要和 JSON 混在一起写。最终结果只按原要求输出，不要提工具、调用或缩略图这些过程。';

/* 与 TextAI 的联网工具同一套 CALL 写法，但只认这三条 —— 这一层没有别的工具可用。 */
function toolCallOf(txt) {
  let s = String(txt == null ? '' : txt).trim();
  const fence = /^```(?:json|text)?\s*([\s\S]*?)```$/i.exec(s);
  if (fence) s = fence[1].trim();
  const m = /^CALL\s*[:：]\s*(get_scene_bbox|get_selected_bbox|render_thumbnail)\b/i.exec(s);
  return m ? m[1].toLowerCase() : '';
}

const boxText = box => {
  const r = v => String(round3(v));
  const dimOf = i => round3(box.max[i] - box.min[i]);
  return 'min(' + box.min.map(r).join(', ') + ') → max(' + box.max.map(r).join(', ') + ')，'
    + '中心(' + [0, 1, 2].map(i => r((box.min[i] + box.max[i]) / 2)).join(', ') + ')，'
    + '尺寸 ' + dimOf(0) + ' × ' + dimOf(1) + ' × ' + dimOf(2) + ' 米';
};

/* 工具的执行只有这一处。`thumbnail` 由页面递进来（视口与视口里的相机只在页面手里）。 */
async function runCheckTool(name, ctx) {
  const doc = ctx && ctx.doc;
  if (name === 'get_scene_bbox') {
    const box = boundsOfScene(doc);
    if (!box) return { text: '【场景包围盒】当前场景没有能量尺寸的零件（空的，或只有导入的摆件 —— 外观未知不参与量尺寸）。' };
    return { text: '【场景包围盒】' + boxText(box) + '。地面是 y=0。' };
  }
  if (name === 'get_selected_bbox') {
    const sel = (doc && ctx.selectedId && Array.isArray(doc.scene && doc.scene.nodes))
      ? findNode(doc.scene.nodes, ctx.selectedId) : null;
    if (!sel) return { text: '【选中子树包围盒】当前没有选中任何节点（先在场景里点中一件再量）。' };
    const head = '【选中子树包围盒】' + (sel.name ? '「' + sel.name + '」' : '') + '（' + sel.id + '）';
    const box = boundsOfScene({ scene: { nodes: [sel] } });
    if (!box) return { text: head + '：这棵子树没有能量尺寸的零件（导入的摆件外观未知，不参与）。' };
    return { text: head + '：' + boxText(box) + '。' };
  }
  if (name === 'render_thumbnail') {
    let url = '';
    try { url = ctx.thumbnail ? String((await ctx.thumbnail()) || '') : ''; } catch (e) { url = ''; }
    if (!url) return { text: '【视口缩略图】现在拿不到视口画面（不在建模台或画布还没起来）；只按包围盒判断。' };
    return {
      text: '【视口缩略图】当前构图已经附在这一轮后面（最后一张图；当前型号支持识图就能看到，看不到就只按包围盒判断）。'
        + '看图核一遍主体的大小与位置，再决定要不要调 at / scale。',
      image: { label: '当前视口', url },
    };
  }
  return { text: '【工具失败】不认识的工具：' + name + '。' };
}

/* 白模库检索清单：一行一条，够 AI 判断「要不要复用」。
   服务端检索出来的一行本来就带 `库名 :: 模型id`；只有 id 还没带库名时这里补上。
   结构摘要（`brief`）比零件名多一层形状与阵列份数，是「能不能当餐桌用」这类判断的第二眼；
   旧数据没有它时退回零件名。条数与每行长度都不设上限 —— 库大就列全，不替用户截断。 */
export function catalogText(models) {
  const rows = (models || []).map(m => {
    const rawId = String(m.id || m.model || '');
    const library = String(m.library || '');
    const id = (library && rawId.indexOf(' :: ') < 0) ? library + ' :: ' + rawId : rawId;
    const nodes = Number(m.nodes) > 0 ? '（' + m.nodes + ' 个零件）' : '';
    const brief = Array.isArray(m.brief) && m.brief.length ? ' [ ' + m.brief.join(' / ') + ' ]' : '';
    const parts = Array.isArray(m.parts) && m.parts.length ? '：' + m.parts.join('、') : '';
    const why = m.note ? '：' + String(m.note) : '';
    return '- ' + id + nodes + (brief || parts) + why;
  });
  return rows.length ? rows.join('\n') : '（白模库里还没有模型）';
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
export function compactNode(n) {
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

/* 机位、灯光与时间轴各一行：够 AI 调机位 / 灯 / 改时长，几乎不占字。 */
function sceneMetaLines(doc) {
  const scene = (doc && doc.scene) || {};
  const out = [];
  const camTracks = new Map();
  for (const tr of ((doc && doc.anim && doc.anim.tracks) || [])) {
    if (!tr || !tr.of || tr.of.kind !== 'cam') continue;
    const list = camTracks.get(tr.of.id) || [];
    list.push(tr);
    camTracks.set(tr.of.id, list);
  }
  for (const c of (Array.isArray(scene.cams) ? scene.cams : [])) {
    const name = line(c.name);
    const trs = camTracks.get(c.id) || [];
    out.push('机位 ' + line(c.id) + (name ? '「' + name + '」' : '')
      + ' pos=[' + (c.pos || []).join(',') + '] target=[' + (c.target || []).join(',') + '] fov=' + c.fov
      + (c.follow ? ' follow=' + c.follow : '')
      + (scene.active === c.id ? ' · 当前' : '')
      + (trs.length ? ' · 轨道 ' + trs.map(tr => tr.id + '('
        + (tr.path ? tr.path.kind + (tr.path.look ? '/' + tr.path.look : '') : 'keys')
        + ' ' + (tr.keys || []).length + '帧'
        + (tr.offset ? ' 偏移' + tr.offset + 's' : '')
        + (tr.speed && tr.speed !== 1 ? ' ' + tr.speed + '×' : '')
        + ')').join('；') : ''));
  }
  const lights = Array.isArray(scene.lights) ? scene.lights : [];
  if (lights.length) {
    out.push('灯 ' + lights.map(l => line(l.id) + (l.name ? '「' + l.name + '」' : '') + ' ' + l.shape
      + ' at=[' + (l.at || []).join(',') + ']'
      + (l.target ? ' target=[' + l.target.join(',') + ']' : '')
      + ' energy=' + l.energy
      + (l.color && l.color !== '#ffffff' ? ' color=' + l.color : '')
      + (l.follow ? ' follow=' + l.follow : '')
      + (l.shape === 'sun' && l.shadow && l.shadow.on ? ' 投影' : '')).join('；'));
  } else {
    out.push('灯：没有实体灯（只有半球环境光）');
  }
  const dev = scene.light || {};
  out.push('灯光装置 hemi.energy=' + ((dev.hemi && dev.hemi.energy) || 0) + ' exposure=' + (dev.exposure || 1));
  const anim = (doc && doc.anim) || {};
  out.push('时间轴 ' + (anim.duration || 0) + 's · ' + (anim.fps || 0) + 'fps · ' + (anim.loop === false ? '不循环' : '循环'));
  return out;
}

/* 当前场景：两段 —— 大纲（骨架）+ 选中子树的完整细节。
   选中的那棵子树在大纲里只占摘要行，全字段只在第二段出现：同一棵树不喂两遍。
   两段合计超过 SCENE_MAX_CHARS 时，第二段退成骨架（id 仍可用），几何字段不再给出。 */
export function currentText(doc, selectedId) {
  if (!doc || !doc.scene || !doc.scene.nodes || !doc.scene.nodes.length) {
    return '（新建：当前没有模型；这是全新生成，不是修改）';
  }
  const head = '【场景大纲】顶层不带缩进的是实体；每行 = id「名字」(形状或种类) 子n（n 是子节点数），'
    + '只够认出结构；节点坐标 / 材质 / 轨道不在这里（机位与时间轴在末尾各一行）。';
  let text = head + '\n' + outlineOf(doc).concat(sceneMetaLines(doc)).join('\n');
  const sel = selectedId ? findNode(doc.scene.nodes, selectedId) : null;
  if (!sel) return text;

  const ids = subtreeIds(sel);
  const tracks = ((doc.anim && doc.anim.tracks) || [])
    .filter(t => t && t.of && t.of.kind === 'node' && ids.has(t.of.id));
  const detailHead = '\n\n【选中实体完整细节】这棵子树给全字段（id 都在下面；改它只用这些 id），其它节点只有大纲：\n';
  const full = JSON.stringify({ node: compactNode(sel), tracks: tracks.map(sparseTrack) });
  if (text.length + detailHead.length + full.length <= SCENE_MAX_CHARS) {
    return text + detailHead + full;
  }

  const skeleton = outlineOf({ scene: { nodes: [sel] } }).join('\n');
  const trs = tracks.map(t => '- ' + t.id + ' → ' + t.of.id + '（' + (t.keys ? t.keys.length : 0) + ' 个关键帧'
    + (t.path ? '，带路径 ' + t.path.kind : '') + '）');
  return text
    + '\n\n【选中实体骨架】这棵子树共 ' + ids.size + ' 个节点，完整字段超过提示词预算（' + SCENE_MAX_CHARS + ' 字），只给骨架；'
    + '几何字段没给出，不要凭空猜坐标，只做结构改动（add / remove / move / group），或者请用户先选中更小的范围。\n'
    + skeleton
    + (trs.length ? '\n轨道摘要：\n' + trs.join('\n') : '');
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

/* 涂鸦标注：页面手里那一份（不进 doc）。这里只把它整理成给 AI 看的文字。
   颜色是语义：蓝 = 相机路径 / 黄 = 主体 / 红 = 避开 / 绿 = 保留 / 白 = 说明 / 灰黑 = 参考。
   camPaths 是程序从每段蓝线各自换算好的机位位移（多段蓝线一段不少）——
   几何让 AI 照着点走，别让它做三维换算；怎么编排以用户那句话为准。 */
function sketchTextOf(sk) {
  if (!sk || !Array.isArray(sk.marks) || !sk.marks.length) return ' ';
  const lines = [];
  if (sk.aspect || sk.duration || sk.fps) {
    lines.push('画幅 ' + (sk.aspect || '16:9') + ' · 时间轴 ' + (sk.duration || 4) + 's · ' + (sk.fps || 24) + 'fps');
  }
  for (const m of sk.marks) {
    if (!m || typeof m !== 'object') continue;
    const col = String(m.color || 'blue');
    if (m.type === 'arrow') {
      lines.push('- arrow · ' + col + '：' + JSON.stringify(m.from || []) + ' → ' + JSON.stringify(m.to || []));
    } else if (m.type === 'text') {
      lines.push('- text · ' + col + '：' + String(m.text || '') + ' @ ' + JSON.stringify(m.at || []));
    } else if (Array.isArray(m.pts) && m.pts.length) {
      /* 中间控制点也给 AI（最多 24 个，多了按序均匀抽样）：只给首尾两点的话，
         黄线 / 灰线这类不进 camPaths 的路径，AI 只能沿直线脑补中间的走向。 */
      const cap = 24;
      const step = Math.ceil(m.pts.length / cap);
      const pts = step <= 1 ? m.pts
        : m.pts.filter((_, i) => i === 0 || i === m.pts.length - 1 || i % step === 0);
      lines.push('- ' + (m.type || 'path') + ' · ' + col + '：' + JSON.stringify(pts));
    }
  }
  if (Array.isArray(sk.camPaths) && sk.camPaths.length) {
    lines.push('程序按每段蓝线各自换算好的机位位移（几何照这些点走，不要自己换算三维；'
      + '用哪几段 / 先后 / 快慢 / 要不要连成一条，以用户这句话为准）：' + JSON.stringify(sk.camPaths));
  }
  return lines.length ? lines.join('\n') : ' ';
}

/* 这一轮的占位符取值。抽出来是为了能直接对着契约正文断言「下一轮的提示词里真的
   带上了上一轮的问题」—— 纯计算，不发请求、不碰 window。
   `problems` 为空时给一个空格：整段从提示词里消失，而不是留一行空标题。
   `media` 是 prepareMedia 交回来的素材（图片 / 视频 / 声音）；老的 `images` 仍然认。 */
export function promptVarsOf(opts) {
  const o = opts || {};
  const mode = o.mode;
  const anims = animationText(o.animations);
  const media = (Array.isArray(o.media) ? o.media : [])
    .concat((o.images || []).filter(x => !(o.media || []).length));
  const n = { image: 0, video: 0, audio: 0 };
  const refs = [];
  for (const x of media) {
    if (x && x.isMask) continue;   // 掩码跟着它的图走：不占编号，原图那一行已注明
    const kind = x && x.kind === 'video' ? 'video' : x && x.kind === 'audio' ? 'audio' : 'image';
    n[kind] += 1;
    const tag = kind === 'image' ? '图' : kind === 'video' ? '视频' : '音频';
    const label = line(x && (x.label || x.name)) || (tag + n[kind]);
    refs.push(tag + n[kind] + ' = ' + label + (x && x.hasMask ? '（附彩色掩码：各色 = 要局部编辑的区域，黑 = 不动，用户按颜色点名）' : ''));
  }
  const problems = String(o.problems || '');
  return {
    prompt: String(o.prompt || ''),
    catalog: String(o.catalog || '（白模库里还没有模型）'),
    animations: anims || ' ',
    current: currentText(o.doc, o.selectedId),
    selected: o.selectedId ? ('当前选中：' + o.selectedId) : '（当前没有选中对象）',
    refImages: refs.length ? refs.join('、') : '（这次没有参考素材）',
    aspect: String(o.aspect || '16:9'),
    mode: mode === 'auto' ? '自动判断：没选中就新增实体；选中了就按用户的话修改选中的实体'
      : mode === 'edit' ? '修改选中实体'
        : (mode === 'entity' ? '在场景里新增一个实体' : '新建一个模型'),
    problems: problems.trim() ? problems : ' ',
    sketch: sketchTextOf(o.sketch),
  };
}

/* 这一轮的 system / user：占位符由 TextAI.prompt 填（填不上时占位符原样留着，AI 会自己补） */
function messages(vars) {
  const sys = window.TextAI.prompt('model3d', false, vars);
  const user = '按上面的要求输出 JSON。这一句是用户的要求：' + String(vars.prompt || '');
  return { sys, user };
}

/* 跑一轮。返回 { say, reuse, doc, ops, applied, skipped, errors, dropped, raw, fallback }：
   · `reuse.mode === 'as-is'` 时 `doc` 为 null（页面该去加载 `reuse.id` 那一份）；
   · `doc` 为 null 且没有 reuse 时表示这一轮没拿到可用的树 / ops（页面保留上一版并报错）；
   · 整份模型分支多一个 `lint: { fixes, warnings }`（几何体检改了什么 / 提醒了什么）。
   新建模式流式过程中每收到新的完整节点就回调一次 `onNodes(nodes, text)`；
   修改模式只回显正文，不边收边改（ops 必须整份收全才能可靠应用）。 */
export async function run(opts) {
  const {
    prompt, doc, mode: modeIn, catalog, animations, aspect, selectedId, images, media, scope, problems,
    sketch, thumbnail, signal, onNodes, onSay, onText,
  } = opts || {};
  const TextAI = window.TextAI;
  if (!TextAI) throw new Error('文字 AI 没就绪');
  const REG = await window.Api.registry();
  if (!TextAI.prov(REG)) throw new Error('没有可用的文字 AI');
  if (!(await TextAI.canRun(REG))) throw new Error('请先在「设置」填文字 AI 密钥');

  const mode = modeIn === 'auto' ? 'auto'
    : (modeIn === 'edit' ? 'edit' : (modeIn === 'entity' ? 'entity' : (modeIn === 'new' ? 'new' : (doc && doc.scene.nodes.length ? 'edit' : 'new'))));
  const vars = promptVarsOf({ prompt, doc, mode, catalog, animations, media, images, aspect, selectedId, problems, sketch });
  const m = messages(vars);
  /* 每一轮的结果都带一份「上一轮的问题」文本，页面存住、下一轮原样交回来 */
  const withProblems = r => { r.problems = problemsTextOf(r); return r; };
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

  const sys = m.sys + '\n\n' + TOOL_NOTE;
  const normMedia = x => ({ kind: x && (x.kind === 'video' || x.kind === 'audio') ? x.kind : 'image', label: x && x.label, url: x && x.url });
  const refMedia = (Array.isArray(media) ? media : [])
    .concat((Array.isArray(images) ? images : []).filter(x => !(media || []).length))
    .map(normMedia).filter(x => x.url);
  const extra = [];
  const toolImages = [];
  let txt = '';
  for (let round = 0; round < TOOL_MAX_ROUNDS; round += 1) {
    buf = '';
    txt = await TextAI.chatStream(REG, sys, m.user, {
      signal, noTools: true, media: refMedia.concat(toolImages), extraMessages: extra,
    }, push);
    const call = toolCallOf(txt);
    if (!call) break;
    const res = await runCheckTool(call, { doc, selectedId, thumbnail });
    extra.push({ role: 'assistant', content: txt });
    extra.push({ role: 'user', content: '工具结果（不是用户的新要求）：\n' + res.text });
    if (res.image) toolImages.push({ kind: 'image', label: res.image.label, url: res.image.url });
  }
  if (toolCallOf(txt)) {
    /* 工具轮次用完还想要：收一次尾，让它直接交结果（与联网工具同一副处理） */
    buf = '';
    txt = await TextAI.chatStream(REG, sys + '\n\n【注意】工具调用次数已用完，直接给出最终结果，不要再输出 CALL。',
      m.user, { signal, noTools: true, media: refMedia.concat(toolImages), extraMessages: extra }, push);
  }
  const loose = parseJsonLoose(txt) || tryParseTail(buf);
  if (!loose || typeof loose !== 'object') {
    return withProblems({ say: '', reuse: null, doc: null, ops: [], applied: 0, skipped: 0, errors: [], dropped: null, raw: txt, why: '这一轮没有拿到 JSON' });
  }
  const say = String(loose.say || '');
  const reuseRaw = loose.reuse;
  const reuse = (reuseRaw && reuseRaw.id) ? {
    id: String(reuseRaw.id),
    mode: reuseRaw.mode === 'as-is' ? 'as-is' : 'base',
    why: String(reuseRaw.why || ''),
  } : null;
  if (reuse && reuse.mode === 'as-is') {
    return withProblems({ say, reuse, doc: null, ops: [], applied: 0, skipped: 0, errors: [], dropped: null, raw: txt });
  }

  /* 自动：回 ops → 按选中范围改（没选中时是场景级修改：灯 / 机位 / 时间轴）；
     否则回 model → 新增一个实体。没选中时交来的 ops 只拿来改场景级对象 ——
     增删实体仍然必须交 model，那是「AI 自己删了别的东西」的那条路。 */
  if (mode === 'auto' && doc) {
    const ops = Array.isArray(loose.ops) ? loose.ops : [];
    const sceneOps = ops.length ? ops.every(op => {
      const k = String((op && op.op) || '');
      return k === 'light' || k === 'cam' || k === 'anim' || k === 'track';
    }) : false;
    if (ops.length && (selectedId || sceneOps)) {
      const r = applyDocOps(doc, ops, { scope: (selectedId && Array.isArray(scope)) ? new Set(scope) : null });
      return withProblems({
        say, reuse, doc: r.doc, ops,
        applied: r.applied, skipped: r.skipped, errors: r.errors,
        dropped: r.dropped, raw: txt, fallback: '',
        why: (!r.doc.scene.nodes.length ? '这一轮把模型改空了' : ''),
      });
    }
    const model = (loose.model && typeof loose.model === 'object') ? loose.model
      : (loose.scene && typeof loose.scene === 'object' ? loose : null);
    if (model) {
      const out = lintedModel(model, aspect);
      return withProblems({
        say: lintSayOf(say, out.lint), reuse, doc: out.doc, ops: [], applied: 0, skipped: 0, errors: [],
        dropped: out.dropped, raw: txt, fallback: 'model', anim: animSpecOf(model),
        lint: out.lint,
        name: line(model && model.name),
        why: (!out.doc.scene.nodes.length ? '这一轮没有任何零件' : ''),
      });
    }
    return withProblems({
      say, reuse, doc: null, ops: [], applied: 0, skipped: 0, errors: [], dropped: null, raw: txt,
      why: selectedId ? '这一轮既没有 ops，也没有新实体' : '这一轮没有拿到新实体',
    });
  }

  /* 修改：默认 ops。整份 model 只在新建 / 复用时收；编辑模式收到 model 也接受，
     但明确标成 fallback，界面照实说「AI 返回了完整模型」。 */
  if (mode === 'edit' && doc) {
    const ops = Array.isArray(loose.ops) ? loose.ops : [];
    if (ops.length) {
      const r = applyDocOps(doc, ops, { scope: Array.isArray(scope) ? new Set(scope) : null });
      return withProblems({
        say, reuse, doc: r.doc, ops,
        applied: r.applied, skipped: r.skipped, errors: r.errors,
        dropped: r.dropped, raw: txt, fallback: '',
        why: (!r.doc.scene.nodes.length ? '这一轮把模型改空了' : ''),
      });
    }
    if (loose.model && typeof loose.model === 'object') {
      const out = lintedModel(loose.model, aspect);
      return withProblems({
        say: lintSayOf(say, out.lint), reuse, doc: out.doc, ops: [], applied: 0, skipped: 0, errors: [],
        dropped: out.dropped, raw: txt, fallback: 'model',
        lint: out.lint,
        why: (!out.doc.scene.nodes.length ? '这一轮没有任何零件' : ''),
      });
    }
    return withProblems({ say, reuse, doc: null, ops: [], applied: 0, skipped: 0, errors: [], dropped: null, raw: txt, why: '修改模式没有拿到 ops' });
  }

  const model = loose.model || loose;
  const out = lintedModel(model, aspect);
  /* 复用关系写进 doc.src：模型文件自己记得「我是照着谁改的」 */
  out.doc.src = { prompt: String(prompt || ''), reuse };
  return withProblems({
    say: lintSayOf(say, out.lint), reuse, doc: out.doc, ops: [], applied: 0, skipped: 0, errors: [],
    dropped: out.dropped, raw: txt, fallback: '', anim: animSpecOf(model),
    lint: out.lint,
    name: line(model && model.name),
    why: (!out.doc.scene.nodes.length ? '这一轮没有任何零件' : ''),
  });
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
