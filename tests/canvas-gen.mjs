#!/usr/bin/env node
/* 画布生成桥：参数解析、能不能生成的判据、输入素材按声明收、状态判定都借公共层。 */
import assert from 'node:assert/strict';
import { nodeKindOf, provsFor, provOf, modelsOf, inputSpec, resolve, whyReady, submit, waitImage, pollOnce, announce }
  from '../web/domain/canvas/gen.js';

/* ---------- 公共层桩：只桩到「声明了什么就答什么」 ---------- */
const calls = [];
const model = { id: 'm-img', name: '出图的', __specs: [{ role: 'reference_image', max: 2 }, { role: 'prompt', max: 0 }] };
const modelFF = { id: 'm-ff', __specs: [{ role: 'first_frame', max: 1 }, { role: 'reference_image', max: 4 }] };
const modelNone = { id: 'm-bare', __specs: [] };
const modelOnly = { id: 'm-only', __specs: [{ role: 'prompt', max: 1 }] };
const prov = { id: 'P1', displayName: '平台一', models: [model, modelFF, modelNone, modelOnly, { id: 'm-aud', __specs: [{ role: 'audio', max: 1 }] }, { id: 'm-vid', __specs: [{ role: 'image', max: 3 }] }] };
const off = { id: 'P2', models: [] };
globalThis.window = {
  /* ui.js 的公共媒体判据：这里只桩「认得三档、别的算空」。 */
  mediaKindFrom: t => (['image', 'video', 'audio'].indexOf(t) >= 0 ? t : ''),
  Api: {
    forKind: k => { calls.push(['forKind', k]); return [prov, off]; },
    prov: id => (id === 'P1' ? prov : null),
    isOff: p => p.id === 'P2',
    /* 桩成「一看就知道过没过媒体层」：判据是 pollOnce 不许把上游外链原样交回页面 */
    mediaSrc: u => 'MSRC(' + u + ')',
    errorMessage: e => '接口说：' + (e && e.message ? e.message : String(e)),
    create: async (p, o) => { calls.push(['create', o]); return { id: 'tk_v1' }; },
    pollTask: async (p, id) => { calls.push(['poll', id]); return { raw: (globalThis.__raw || { status: 'running' }) }; },
    parseItem: (p, raw) => raw.__parsed || {},
  },
  Capabilities: { specs: m => m.__specs || [] },
  AiGen: {
    create: async o => { calls.push(['aigen.create', o]); if (o.onTask) o.onTask({ id: 'tk_i1' }); return { id: 'tk_i1', want: 1, fmt: 'png' }; },
    wait: async t => { calls.push(['aigen.wait', t.id]); return { assetId: 'as_9', src: '/asset/as_9', entries: [1, 2], genId: 'tk_i1' }; },
    synthTts: async (p, o) => { calls.push(['synth', o]); return { assetId: 'la_5', url: '/asset/la_5', format: 'mp3', bytes: 2048 }; },
    outputIds: (p, raw) => raw.__ids || [],
  },
  dispatchEvent: e => { (globalThis.__ev = globalThis.__ev || []).push(e); },
};
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = (o && o.detail) || null; } };

const N = (id, type, meta) => ({ id, type, title: type + ' ' + id, metadata: meta || {} });
const C = (from, to) => ({ id: 'cn_' + from + to, fromNodeId: from, toNodeId: to });

/* ---------- 类型档 / 供应商列表 ---------- */
assert.equal(nodeKindOf('image'), 'image');
assert.equal(nodeKindOf('text'), '');
assert.equal(nodeKindOf('config'), '');
assert.deepEqual(provsFor('image').map(p => p.id), ['P1'], '没添加密钥的那一家不排进来');
assert.deepEqual(modelsOf(prov).slice(0, 2).map(m => m.name), ['出图的', 'm-ff'], '没起名就用 id');
assert.equal(provOf('不存在'), null);
assert.equal(provOf('P1').id, 'P1');

/* ---------- 输入槽按声明挑 ---------- */
assert.equal(inputSpec(model, 'image').role, 'reference_image');
assert.equal(inputSpec(model, 'image').max, 2, '上限跟着 role 一起交回');
assert.equal(inputSpec(modelFF, 'image').role, 'first_frame', '首帧槽优先于参考图');
assert.equal(inputSpec(modelNone, 'image'), null);
assert.equal(inputSpec(modelOnly, 'image'), null, '声明里只有 prompt 槽时不借别人的位');
assert.equal(inputSpec({ id: 'x', __specs: [{ role: 'audio', max: 1 }] }, 'audio').role, 'audio');
assert.equal(inputSpec(null, 'image'), null);

/* ---------- resolve：谁的参数赢、哪些算输入、哪些是空线头 ---------- */
const doc = { nodes: [
  N('cf', 'config', { prov: 'P1', model: 'm-img', prompt: '配置里的提示词', params: { ar: '16:9', count: 2 } }),
  N('t1', 'text', { content: '文本里的提示词' }),
  N('i0', 'image', { assetId: 'as_0' }),
  N('i1', 'image', { assetId: 'as_1' }),
  N('i2', 'image', { assetId: 'as_2' }),
  N('i3', 'image', {}),                                     // 空线头
  N('ar', 'asset-ref', { sourceAssetId: 'la_7', assetKind: 'image' }),
  N('target', 'image', {}),
], connections: [C('cf', 'target'), C('t1', 'target'), C('i0', 'target'), C('i1', 'target'), C('i2', 'target'), C('i3', 'target'), C('ar', 'target')] };
const r = resolve(doc, doc.nodes.find(n => n.id === 'target'));
assert.equal(r.prov, 'P1');
assert.equal(r.model, 'm-img');
assert.equal(r.prompt, '配置里的提示词', '配置节点先占提示词，文本节点就不覆盖');
assert.deepEqual(r.params, { ar: '16:9', count: 2 });
assert.equal(r.inputs.length, 4, '三张出图的 + 一个资产引用（空线头与文本/配置都不算输入）');
assert.deepEqual(r.inputs.map(x => x.assetId), ['as_0', 'as_1', 'as_2', 'la_7']);
assert.equal(r.inputs[3].kind, 'image', '资产引用按它自己声明的种类算');
assert.deepEqual(r.missing, ['image i3'], '空线头单独记一笔');
/* 节点自己写死的 > 配置节点 */
const own = resolve({ ...doc, nodes: doc.nodes.map(n => n.id === 'target' ? { ...n, metadata: { prov: 'P1', model: 'm-img', prompt: '自己的', params: { ar: '1:1' } } } : n) },
  { id: 'target', type: 'image', metadata: { prov: 'P1', model: 'm-img', prompt: '自己的', params: { ar: '1:1' } } });
assert.equal(own.prompt, '自己的');
assert.equal(own.params.ar, '1:1', '节点自己的参数盖过配置节点的');
assert.equal(own.params.count, 2, '配置节点里节点没写的参数照样接过来');

/* ---------- whyReady：每一条都要说得出为什么不能生成 ---------- */
assert.match(whyReady(doc, N('x', 'text')), /不生成东西/);
assert.match(whyReady(doc, N('x', 'image', {})), /还没有平台/);
assert.match(whyReady({}, N('x', 'image', { prov: 'P1' })), /还没有型号/);
assert.match(whyReady({}, N('x', 'image', { prov: 'P1', model: 'm-img', prompt: '   ' })), /提示词是空的/);
assert.equal(whyReady({}, N('x', 'video', { prov: 'P1', model: 'm-vid' })), '', '视频可以没提示词（图生视频）');
assert.equal(whyReady({}, N('x', 'image', { prov: '不存在的一家', model: 'm-img', prompt: 'p' })), '这一家平台现在不在注册表里了（可能被删掉或改了 id）');
assert.match(whyReady({}, N('x', 'image', { prov: 'P1', model: '早下线了', prompt: 'p' })), /现在的清单里/);
/* 空线头排在缺平台前面：那才是用户此刻真正要解决的问题 */
assert.match(whyReady(doc, doc.nodes.find(n => n.id === 'target')), /还没有产物：image i3/);

/* ---------- submit：语音同步合成、图片两段、输入按上限收 ---------- */
const ready = { nodes: [N('cf', 'config', { prov: 'P1', model: 'm-img', prompt: '画一只猫', params: { ar: '3:2', count: 1 } }),
  N('a', 'image', { assetId: 'as_a' }), N('b', 'image', { assetId: 'as_b' }), N('c', 'image', { assetId: 'as_c' }),
  N('t', 'image', {})], connections: [C('cf', 't'), C('a', 't'), C('b', 't'), C('c', 't')] };
const tNode = ready.nodes.find(n => n.id === 't');
let out = await submit(ready, tNode, { onTask: id => calls.push(['ontask', id]) });
assert.equal(out.kind, 'image');
assert.equal(out.taskId, 'tk_i1');
const created = calls[calls.length - 2][1];
assert.equal(created.prompt, '画一只猫');
assert.equal(created.ar, '3:2');
assert.equal(created.inputEntries.length, 2, 'm-img 声明只收 2 路参考：第三路不发');
assert.deepEqual(created.inputEntries.map(e => e.role), ['reference_image', 'reference_image']);
assert.equal(out.droppedInputs, 1, '挤掉的那一路要报出来');
assert.deepEqual(calls[calls.length - 1], ['ontask', 'tk_i1'], '任务号一拿到就回调，页面据此落盘');

/* 首帧型号：走 first_frame，而不是按连线顺序把三张都塞参考图 */
const ff = { ...ready, nodes: ready.nodes.map(n => n.id === 'cf' ? { ...n, metadata: { ...n.metadata, model: 'm-ff' } } : n) };
out = await submit(ff, tNode, {});
const ffCall = calls[calls.length - 1][1];
assert.equal(ffCall.inputEntries[0].role, 'first_frame');
assert.equal(ffCall.inputEntries.length, 1, 'm-ff 声明收 1 路 → 只发第一张');
assert.equal(out.droppedInputs, 2);

/* 型号声明里没有图像输入位：一个都不发，并照实报「三路都没发出去」 */
const bare = { ...ready, nodes: ready.nodes.map(n => n.id === 'cf' ? { ...n, metadata: { ...n.metadata, model: 'm-only' } } : n) };
out = await submit(bare, tNode, {});
assert.equal(calls[calls.length - 1][1].inputEntries.length, 0);
assert.equal(out.droppedInputs, 3);

/* 语音：同步合成，没有任务号 */
const aud = { nodes: [N('cf', 'config', { prov: 'P1', model: 'm-aud', prompt: '念一句', params: { voice: 'v-1' } }), N('t', 'audio', {})], connections: [C('cf', 't')] };
out = await submit(aud, aud.nodes[1], {});
assert.equal(out.sync, true);
assert.equal(out.assetId, 'la_5');
assert.equal(out.taskId, undefined);
assert.equal(calls[calls.length - 1][1].voice, 'v-1');
assert.equal(calls[calls.length - 1][1].meta.canvasNodeId, 't');

/* 视频：走 Api.create，任务号取自 parseItem */
const vid = { nodes: [N('cf', 'config', { prov: 'P1', model: 'm-vid', prompt: '让它动起来' }), N('i', 'image', { assetId: 'as_i' }), N('t', 'video', {})], connections: [C('cf', 't'), C('i', 't')] };
out = await submit(vid, vid.nodes[2], {});
assert.equal(out.taskId, 'tk_v1');
assert.equal(out.kind, 'video');
const vCall = calls[calls.length - 1][1];
assert.equal(vCall.inputEntries[0].role, 'image');
assert.equal(vCall.note, '画布提交');
/* 接口没回任务号 = 没扣费，照实报错而不是挂一个空轮询 */
globalThis.window.Api.create = async () => ({ message: '排队满了' });
await assert.rejects(() => submit(vid, vid.nodes[2], {}), /排队满了/);
globalThis.window.Api.create = async (p, o) => { calls.push(['create', o]); return { id: 'tk_v1' }; };

/* 判据不过就不提交：一次请求都不该发出去 */
const before = calls.length;
await assert.rejects(() => submit({ nodes: [N('t', 'image', {})], connections: [] }, N('t', 'image', {}), {}), /还没有平台/);
assert.equal(calls.length, before, '被拒绝的提交不碰网络');
await assert.rejects(() => submit({}, N('t', 'text', {}), {}), /不生成东西/);

/* ---------- 等与问 ---------- */
const w = await waitImage({ id: 'tk_i1' });
assert.equal(w.assetId, 'as_9');
assert.equal(w.entries, 2, '一次出几张要报数');
globalThis.__raw = { __parsed: { genId: 'tk_v1', url: 'https://x/y.mp4' }, __ids: ['as_7', 'as_8'] };
let p = await pollOnce('P1', 'tk_v1');
assert.equal(p.done, true);
assert.equal(p.assetId, 'as_7');
assert.equal(p.src, 'MSRC(https://x/y.mp4)', '外链一律过 Api.mediaSrc 再交回界面');
assert.deepEqual(p.all, ['as_7', 'as_8']);
assert.match(p.dl, /^\/fetch\?url=https/, '下载走同源代理那一条');
globalThis.__raw = { __parsed: { status: 'RUNNING' } };
p = await pollOnce('P1', 'tk_v1');
assert.equal(p.running, true);
assert.equal(p.status, 'RUNNING');
globalThis.__raw = { __parsed: { failed: true, status: 'FAILED', error: { message: '内容不合规' } } };
p = await pollOnce('P1', 'tk_v1');
assert.equal(p.failed, true);
assert.equal(p.why, '内容不合规');
globalThis.__raw = { __parsed: { failed: true, status: 'FAILED' } };
assert.match((await pollOnce('P1', 'tk_v1')).why, /生成失败（FAILED）/);
assert.match((await pollOnce('没这一家', 'tk')).why, /不在注册表里/);
globalThis.__raw = { __parsed: { status: 'RUNNING' } };
p = await pollOnce(prov, 'tk_v1');
assert.equal(p.running, true, '传整份供应商也行');

/* ---------- 镜像事件：画布这一处只是转发 ----------
   归一化、`la_` / 没地址的挡掉、同批去重都在 `AssetLocal.announce` 那一条里（local.js 是经典
   脚本，Node 这边装不起来整层），那几件事由 tests/e2e/ui-contract.cjs 在真浏览器里对着
   真 `AssetLocal` 验。这里只钉接线：条目原样交给唯一出口，`null` 不去打扰公共层。 */
const announced = [];
globalThis.window.AssetLocal = { announce: list => { announced.push(list); return list.length; } };
announce({ src: '/asset/as_1', assetId: 'as_1' });
assert.equal(announced.length, 1, '单条也要成一批交给 AssetLocal.announce');
assert.deepEqual(announced[0].map(e => e.assetId), ['as_1']);
assert.deepEqual(announced[0].map(e => e.src), ['/asset/as_1']);
announce(null);
assert.equal(announced.length, 1, 'null 不该惊动公共层');
console.log('✓ 画布生成桥：参数解析 / 判据 / 输入按声明收 / 两段提交 / 状态判定 / 镜像事件');
