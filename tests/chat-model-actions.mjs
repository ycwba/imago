#!/usr/bin/env node
/* 助手进建模台（快档，不开浏览器）：
   ① TOOLS / ACTS / 路由 / 策略表里都有建模台那一族，且只对 model.html 出现；
   ② `model_edit` 的 check/run 只转发给 WBBridge.model3d（校验在页面那一份）；
   ③ `model_list` / `model_read` 走桥的只读面，不在建模台时照实说；
   ④ 工具结果裁剪有分档（大列表短、单文件长），默认仍是 7000；
   ⑤ chat.js 的接线：按工具档位裁剪 + 兜底把「问不通」写回上下文。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

/* ---- 在 vm 里装 chat-tools.js（经典脚本，挂 window.AiChatTools） ---- */
const win = { fmtBytes: x => String(x) + 'B' };
win.window = win;
const ctx = { window: win, console, errText: e => String((e && e.message) || e) };
vm.createContext(ctx);
vm.runInContext(read('web/features/chat-tools.js'), ctx);
const api = win.AiChatTools.build({
  cap: s => String(s),
  TOOL_OUT: 7000,
  RESULT_MAX: 8192,
  EF: { ids: () => ['fcp', 'zip'], list: () => [{ id: 'fcp', doc: 'FCPXML 工程' }, { id: 'zip', doc: '媒体包' }] },
  page: () => 'model.html',
});
const { TOOLS, ACTS, ACTION_META, TOOL_ROUTE, toolCap } = api;

/* ---- ① 表与路由 ---- */
for (const k of ['model_list', 'model_read', 'model_view']) ok(!!TOOLS[k], '有查询 ' + k);
for (const k of ['model_edit', 'model_new', 'model_add_to_scene', 'model_undo']) ok(!!ACTS[k], '有动作 ' + k);
ok(TOOL_ROUTE.model_list === 'model.html' && TOOL_ROUTE.model_read === 'model.html'
  && TOOL_ROUTE.model_view === 'model.html', '三个查询都挂 model.html');
for (const k of ['model_edit', 'model_new', 'model_add_to_scene', 'model_undo']) {
  ok(ACTION_META[k] && ACTION_META[k].route === 'model.html' && ACTION_META[k].effect === 'write',
    k + ' 的 route / effect 齐了');
}
ok(ACTION_META.model_edit.undo === 'model_undo' && ACTION_META.model_new.undo === 'model_undo'
  && ACTION_META.model_add_to_scene.undo === 'model_undo', '三个写动作都能用 model_undo 退');
const visModel = api.visibleActs('model.html');
const visDir = api.visibleActs('director.html');
ok(visModel.includes('model_edit') && visModel.includes('model_undo'), '建模台上看得见建模动作');
ok(!visDir.includes('model_edit') && !visDir.includes('model_new'), '导演台上看不见建模动作（不跨页泄漏）');

/* ---- ② check / run 只转发给桥 ---- */
const calls = [];
const bridge = {
  ready: () => true,
  list: () => ({ 白模库: '探针库', 实体: [{ id: 'n1', name: '桌子', kind: 'group', parts: 5 }] }),
  read: a => ({ 实体: { id: a.id, name: '桌子', kind: 'group', children: [] }, 轨道: [], 大纲: ['n1「桌子」(group) 子0'] }),
  thumbnail: async () => 'data:image/png;base64,AAAA',
  check: (op, a) => { calls.push(['check', op, a]); return { ok: true, text: '改白膜（应用 1 条修改）', lines: ['应用 1 条修改'] }; },
  run: async (op, a) => { calls.push(['run', op, a]); return { ok: true, text: '改白膜（应用 1 条修改）' }; },
};
win.WBBridge = { get: name => (name === 'model3d' ? bridge : null) };

const chk = ACTS.model_edit.check({ scope: 'selection', ops: [{ op: 'update', id: 'n1', set: { at: [1, 0, 0] } }] });
ok(chk && chk.说明 === '改白膜（应用 1 条修改）' && chk.人话[0] === '应用 1 条修改', 'check 把桥的话原样转出来');
ok(calls[0][0] === 'check' && calls[0][1] === 'edit', 'check 走桥的 edit');
const ran = await ACTS.model_edit.run({ ops: [{ op: 'update', id: 'n1', set: { at: [1, 0, 0] } }] });
ok(ran.ok === true && calls.some(c => c[0] === 'run' && c[1] === 'edit'), 'run 转发给桥');

/* 桥拒绝时把原因说清 */
win.WBBridge = { get: () => ({ ready: () => true, check: () => ({ ok: false, err: '现在没有选中实体' }), run: async () => ({ ok: false, err: '现在没有选中实体' }) }) };
const bad = ACTS.model_edit.check({ scope: 'selection', ops: [{ op: 'update', id: 'n1' }] });
ok(bad && bad.err === '现在没有选中实体', '桥拒绝了就把原因交回去');
let threw = '';
try { await ACTS.model_new.run({ name: '桌子' }); } catch (e) { threw = String(e.message || e); }
ok(threw === '现在没有选中实体', 'run 被拒时抛错（动作层统一处理）');

/* ---- ③ 只读查询走桥；不在建模台时照实说 ---- */
win.WBBridge = { get: () => bridge };
const list = await TOOLS.model_list.run({});
ok(list && list.白模库 === '探针库' && list.实体[0].id === 'n1', 'model_list 读桥的 list');
const one = await TOOLS.model_read.run({ id: 'n1' });
ok(one && one.实体.id === 'n1' && one.大纲[0].includes('桌子'), 'model_read 读实体树');
win.WBBridge = { get: () => null };
const none = await TOOLS.model_list.run({});
ok(none && none.错误 && none.错误.includes('建模台'), '桥没挂时照实说先切过去');

/* ---- ④ 分档裁剪 ---- */
ok(toolCap('tasks') === 2000 && toolCap('subtitle_list') === 20000 && toolCap('model_read') === 8000,
  '档位声明生效：' + [toolCap('tasks'), toolCap('subtitle_list'), toolCap('model_read')].join(','));
ok(toolCap('nope') === 0, '没声明 = 0（运行处回默认 7000）');

/* ---- ⑤ chat.js 的接线 ---- */
{
  const src = read('web/features/chat.js');
  ok(src.includes('toolCap(ins.name) || TOOL_OUT'), '结果裁剪按工具档位（默认 TOOL_OUT）');
  ok(src.includes('Math.max(RESULT_MAX, maxOut)'), '落盘阈值跟着档位抬（长结果不被 8KB 线先截）');
  ok(src.includes('连着 \' + stale + \' 次没有拿到新结果'), '兜底把「问不通」写回上下文');
}

console.log('✓ chat-model-actions：' + n + ' 项通过');
