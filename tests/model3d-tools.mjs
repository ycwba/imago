#!/usr/bin/env node
/* 自查构图工具回路（快档，不开浏览器）：AI 可以先量一遍再下笔。
   ① `lint.js` 的 `boundsOfScene` 与体检 / 渲染同一把尺子（两件零件求并）；
   ② `run` 的系统提示词后面接着「自查工具」三条（CALL 写法与联网工具同一套）；
   ③ 三条工具各跑一遍：场景包围盒 / 选中子树包围盒 / 视口缩略图（图进下一轮的 images）；
   ④ 工具轮次用完要收尾（最后一次带「不要再输出 CALL」）；不认识的工具不接；
   ⑤ 工具结果只回灌给模型，最终输出仍是契约要求的那份 JSON。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeDoc } from '../web/model3d/schema.js';
import { boundsOfScene } from '../web/model3d/lint.js';
import { run, promptVarsOf } from '../web/model3d/ai.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/* ---- 真实的 text-ai.js（只要它的 prompt 与 DEF；TplVars 用同一条正则填）---- */
const ctx = {
  window: {
    LS: { get: () => '' }, Store: { read: () => [], write: () => {} },
    Api: { errorMessage: () => 'err' },
    TplVars: { fill: (tpl, vals) => String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => {
      const v = vals && vals[k];
      return (v == null || v === '') ? m : String(v);
    }) },
  },
  console,
};
vm.createContext(ctx);
vm.runInContext(read('web/domain/text-ai.js'), ctx);
const TextAI = ctx.window.TextAI;

/* ---- 参考素材的编号：三类各数各的 ---- */
const vars = promptVarsOf({ media: [
  { kind: 'image', label: '参考图' }, { kind: 'video', label: '片段' }, { kind: 'audio', label: '声音' },
] });
ok(vars.refImages === '图1 = 参考图、视频1 = 片段、音频1 = 声音', '三类素材各按自己的编号：' + vars.refImages);

/* ---- ① boundsOfScene ---- */
const docOf = raw => normalizeDoc({ scene: { nodes: raw } }).doc;
const scene = docOf([
  { kind: 'group', id: 'g1', name: '桌子', children: [
    { kind: 'prim', id: 'top', name: '桌面', shape: 'box', size: [1, 1, 1], at: [0, 0.5, 0] },
  ] },
  { kind: 'prim', id: 'n2', name: '凳子', shape: 'box', size: [1, 1, 1], at: [2, 0.5, 0] },
]);
const b = boundsOfScene(scene);
ok(b && close(b.min[0], -0.5) && close(b.max[0], 2.5) && close(b.min[1], 0) && close(b.max[1], 1),
  '两件零件求并：' + JSON.stringify(b));
ok(boundsOfScene({ scene: { nodes: [] } }) === null, '空场景量不到包围盒');

/* ---- ②③④⑤ 跑 run，工具由 stub 的 chatStream 触发 ---- */
const FINAL = JSON.stringify({ say: '好了', model: { name: '盒子', scene: { nodes: [
  { kind: 'prim', id: 'n-1', name: '盒子', shape: 'box', size: [1, 1, 1], at: [0, 0.5, 0] },
] } } });

function boot(replies, extraWindow) {
  const calls = [];
  globalThis.window = Object.assign({
    Api: { registry: async () => ({ providers: [] }) },
    TextAI: {
      prompt: (...a) => TextAI.prompt(...a),
      prov: () => ({ id: 'probe', kind: 'text' }),
      canRun: async () => true,
      chatStream: async (REG, sys, user, opts, push) => {
        calls.push({ sys, user, opts });
        const txt = replies.shift();
        if (txt == null) throw new Error('stub 的回复不够了');
        push(txt);
        return txt;
      },
    },
  }, extraWindow || {});
  return calls;
}

/* 场景包围盒：先 CALL，再交最终 JSON */
{
  const calls = boot(['CALL: get_scene_bbox {}', FINAL]);
  const r = await run({ prompt: '做个盒子', mode: 'new', doc: scene, aspect: '16:9' });
  ok(calls.length === 2, 'CALL 之后又跑了一轮');
  ok(calls[0].sys.includes('【自查工具（这次建模里可用）】') && calls[0].sys.includes('CALL: get_scene_bbox {}'),
    '系统提示词后面接着自查工具那三条');
  ok(calls[0].sys.includes('你是三维白模建模师'), '工具说明接在真契约后面，不是顶掉它');
  const extra = calls[1].opts.extraMessages || [];
  ok(extra.length === 2 && extra[0].role === 'assistant' && extra[0].content === 'CALL: get_scene_bbox {}',
    '工具调用本身作为 assistant 那一轮交回');
  ok(extra[1].role === 'user' && extra[1].content.indexOf('工具结果（不是用户的新要求）') === 0,
    '工具结果用 user 角色、明说不是新要求');
  ok(extra[1].content.includes('【场景包围盒】min(-0.5, 0, -0.5) → max(2.5, 1, 0.5)'),
    '量的是整场景的并：' + extra[1].content);
  ok(extra[1].content.includes('尺寸 3 × 1 × 1 米') && extra[1].content.includes('地面是 y=0'),
    '尺寸与地面一起说清');
  ok(r.doc && r.doc.scene.nodes.length === 1 && !/CALL/.test(r.raw), '最终结果仍是契约的 JSON');
}

/* 选中子树包围盒：量的是选中那棵，不是整场景 */
{
  const calls = boot(['```text\nCALL: get_selected_bbox {}\n```', FINAL]);
  const r = await run({ prompt: '改桌子', mode: 'new', doc: scene, selectedId: 'g1', aspect: '16:9' });
  const extra = calls[1].opts.extraMessages || [];
  ok(extra[1].content.includes('【选中子树包围盒】「桌子」（g1）'),
    '点名的就是选中的那件：' + extra[1].content);
  ok(extra[1].content.includes('min(-0.5, 0, -0.5) → max(0.5, 1, 0.5)'), '量的是子树自己的盒子');
  ok(r.doc && r.doc.scene.nodes.length === 1, '照常拿到结果');
}
{
  const calls = boot(['CALL: get_selected_bbox {}', FINAL]);
  await run({ prompt: '改', mode: 'new', doc: scene, aspect: '16:9' });
  const extra = calls[1].opts.extraMessages || [];
  ok(extra[1].content.includes('当前没有选中任何节点'), '没选中时照实说');
}

/* 视口缩略图：图进下一轮的 media，文字说明也带回去 */
{
  const thumb = 'data:image/jpeg;base64,AAAA';
  const calls = boot(['CALL: render_thumbnail {}', FINAL], {});
  const r = await run({
    prompt: '做个盒子', mode: 'new', doc: scene, aspect: '16:9',
    images: [{ label: '参考图', url: 'data:image/png;base64,BBBB' }],
    thumbnail: async () => thumb,
  });
  const extra = calls[1].opts.extraMessages || [];
  ok(extra[1].content.includes('【视口缩略图】当前构图已经附在这一轮后面'), '工具结果说清图在哪');
  const imgs = calls[1].opts.media || [];
  ok(imgs.length === 2 && imgs[0].label === '参考图' && imgs[0].kind === 'image'
    && imgs[1].label === '当前视口' && imgs[1].kind === 'image' && imgs[1].url === thumb,
    '参考图在前、视口图在后：' + JSON.stringify(imgs));
  ok(r.doc && r.doc.scene.nodes.length === 1, '照常拿到结果');
}
{
  const calls = boot(['CALL: render_thumbnail {}', FINAL]);
  await run({ prompt: '做个盒子', mode: 'new', doc: scene, aspect: '16:9' });
  const extra = calls[1].opts.extraMessages || [];
  ok(extra[1].content.includes('现在拿不到视口画面'), '没有视口时照实说，不假装有图');
  ok((calls[1].opts.media || []).length === 0, '没有视口就不塞图');
}

/* 工具轮次用完：收一次尾，最后一次明说不要再 CALL */
{
  const replies = ['CALL: get_scene_bbox {}', 'CALL: get_selected_bbox {}', 'CALL: render_thumbnail {}', FINAL];
  const calls = boot(replies);
  const r = await run({ prompt: '做个盒子', mode: 'new', doc: scene, selectedId: 'g1', aspect: '16:9' });
  ok(calls.length === 4, '三轮工具之后又收了一次尾：' + calls.length);
  ok(calls[3].sys.includes('工具调用次数已用完，直接给出最终结果，不要再输出 CALL'),
    '收尾那一轮明说不许再 CALL');
  ok((calls[3].opts.extraMessages || []).length === 6, '三轮工具结果都还在上下文里');
  ok(r.doc && r.doc.scene.nodes.length === 1, '收尾照样交回结果');
}

/* 不认识的工具不接：当普通正文处理（不是 JSON → 这一轮没有结果） */
{
  const calls = boot(['CALL: delete_everything 全部删掉']);
  const r = await run({ prompt: '做个盒子', mode: 'new', doc: scene, aspect: '16:9' });
  ok(calls.length === 1, '不认识的工具不会再发一轮');
  ok(r.doc === null && r.why === '这一轮没有拿到 JSON', '照实报没拿到 JSON：' + r.why);
}

console.log('✓ model3d-tools：' + n + ' 项通过');
