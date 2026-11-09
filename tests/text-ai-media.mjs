#!/usr/bin/env node
/* 文字 AI 的多模态判定与随附素材：
   ① 能力字段：input_modalities / 布尔开关 / 能力数组 → 图片 / 声音 / 视频三类；
   ② 判定优先级：设置页手动指定 > 接口字段 > 平台声明 > 不支持；
   ③ content part 形状：image_url / input_audio / video_url 与平台可声明的两种替换形状；
   ④ 编号说明按类各数各的；润色提示里说清附了哪几类；
   ⑤ prepareMedia 只放行能力支持的那几类，并逐条报出「没带 / 为什么」。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

/* ---- 在 vm 里加载真实的 text-ai.js（浏览器脚本，只要一个 window 壳）---- */
const store = new Map();
const ctx = {
  window: {
    LS: {
      get: k => (store.has(k) ? store.get(k) : ''),
      set: (k, v) => store.set(k, v),
    },
    Store: { read: () => [], write: () => {}, sweep: () => 0 },
    Api: { errorMessage: () => 'err', modelRows: () => [] },
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
ok(TextAI && Array.isArray(TextAI.MEDIA_KINDS) && TextAI.MEDIA_KINDS.length === 3, 'text-ai.js 没能加载出多模态判定');

/* ---- ① 能力字段 ---- */
const D = m => TextAI.detectModalities(m);
ok(D({ input_modalities: ['text', 'image'] }).image === true, 'input_modalities 里的 image 要认成支持图片');
ok(D({ input_modalities: ['text', 'image'] }).audio === false, 'input_modalities 没写 audio 就是不吃声音');
ok(D({ architecture: { input_modalities: ['text', 'audio', 'video'] } }).audio === true
  && D({ architecture: { input_modalities: ['text', 'audio', 'video'] } }).video === true, 'architecture.input_modalities 也要认');
ok(D({ supports_video: true }).video === true, 'supports_video 布尔要认');
ok(D({ capabilities: ['vision', 'audio', 'video'] }).image === true
  && D({ capabilities: ['vision', 'audio', 'video'] }).audio === true
  && D({ capabilities: ['vision', 'audio', 'video'] }).video === true, '能力数组里的三种写法都要认');
ok(D({ input_modalities: ['text', 'vision'] }).image === true, 'vision 是图片那一类的同义词');
ok(D({}).image === null && D({}).audio === null && D({}).video === null, '没给任何信号时返回 null（交给下一级判定）');

/* ---- ② 判定优先级 ---- */
const prov = { id: 'p1', keyId: 'p1', name: '测试家', models: [{ id: 'm-no' }, { id: 'm-decl', vision: true, audio: false, video: true }] };
TextAI._meta = { 'm-meta': { image: true, audio: true, video: false, fields: { image: 'input_modalities' } } };
TextAI._metaFor = 'p1';
let r = TextAI.media(null, prov, 'm-meta');
ok(r.image.ok && r.audio.ok && !r.video.ok, '接口字段：三类各按自己的值判');
ok(/接口字段 input_modalities/.test(r.image.why), '图片的 why 要指出是哪个字段说的');
/* 型号自己的输入能力覆盖（ModelPrefs）优先于账号级旧开关与接口字段。 */
ctx.window.ModelPrefs = { mediaOf: (p2, id) => (id === 'm-meta' ? { video: 'off', audio: 'on' } : {}) };
r = TextAI.media(null, prov, 'm-meta');
ok(!r.video.ok && /这个型号手动指定不支持/.test(r.video.why), '型号级覆盖：视频设为不支持');
ok(r.audio.ok && /这个型号手动指定支持/.test(r.audio.why), '型号级覆盖：声音设为支持');
delete ctx.window.ModelPrefs;
r = TextAI.media(null, prov, 'm-decl');
ok(r.image.ok && !r.audio.ok && r.video.ok, '接口没这型号时用平台声明（vision/audio/video）');
r = TextAI.media(null, prov, 'm-no');
ok(!r.image.ok && /都没说/.test(r.image.why), '三级都没说 → 不支持，并说清没声明');
store.set('sk_text_video', 'on');
r = TextAI.media(null, prov, 'm-meta');
ok(r.video.ok && /设置里已开启/.test(r.video.why), '设置页手动开启要压过接口字段');
store.set('sk_text_audio', 'off');
r = TextAI.media(null, prov, 'm-meta');
ok(!r.audio.ok && /设置里已关闭/.test(r.audio.why), '设置页手动关闭要压过接口字段');
store.clear();
/* 异步版沿用同一份内存能力（不重新拉接口） */
const asyncMedia = await (async () => {
  TextAI.rawModels = async () => { throw new Error('不该在能力已就位时回源'); };
  return await TextAI.mediaAsync(null, prov, 'm-meta');
})();
ok(asyncMedia.image.ok && asyncMedia.audio.ok, 'mediaAsync 在内存能力就位时直接用，不回源');

/* ---- ③ content part 形状 ---- */
const img = TextAI._mediaParts({ kind: 'image', url: 'data:image/jpeg;base64,AAA' }, prov);
ok(img.length === 1 && img[0].type === 'image_url' && img[0].image_url.url.indexOf('data:image') === 0, '图片走 image_url');
const au = TextAI._mediaParts({ kind: 'audio', url: 'data:audio/wav;base64,QUJD' }, prov);
ok(au.length === 1 && au[0].type === 'input_audio' && au[0].input_audio.data === 'QUJD' && au[0].input_audio.format === 'wav',
  '声音默认走 input_audio（纯 base64 + 格式）');
const au2 = TextAI._mediaParts({ kind: 'audio', url: 'data:audio/mpeg;base64,QUJD' }, { mediaInput: { audio: 'audio_url' } });
ok(au2.length === 1 && au2[0].type === 'audio_url', '平台声明 audio_url 时换成那个形状');
const vi = TextAI._mediaParts({ kind: 'video', url: 'data:video/mp4;base64,QUJD' }, prov);
ok(vi.length === 1 && vi[0].type === 'video_url', '视频默认走 video_url');
const vi2 = TextAI._mediaParts({ kind: 'video', url: 'data:video/mp4;base64,QUJD' }, { mediaInput: { video: 'input_video' } });
ok(vi2.length === 1 && vi2[0].type === 'input_video' && vi2[0].input_video.format === 'mp4', '平台声明 input_video 时换成 base64 + 格式');

/* ---- ③-b 一轮真正发出去的正文：三类素材按能力合并进 content[] ---- */
TextAI._meta = { 'm-multi': { image: true, audio: true, video: true } };
TextAI._metaFor = 'p1';
const built = await TextAI._body(null, { id: 'p1', keyId: 'p1', name: '测试家' }, '系统', '正文', {
  model: 'm-multi',
  media: [
    { kind: 'image', label: '图', url: 'data:image/jpeg;base64,AAA' },
    { kind: 'audio', label: '声', url: 'data:audio/wav;base64,QUJD' },
    { kind: 'video', label: '片', url: 'data:video/mp4;base64,QUJD' },
  ],
});
const content = built.body.messages[1].content;
ok(Array.isArray(content) && content.length === 4 && content[0].type === 'text'
  && content.slice(1).map(x => x.type).join(',') === 'image_url,input_audio,video_url',
  '正文之后按顺序接三类素材：' + JSON.stringify(content.map(x => x.type)));
ok(/图1 = 图/.test(content[0].text) && /视频1 = 片/.test(content[0].text) && /音频1 = 声/.test(content[0].text),
  '正文末尾带三类素材的编号说明');

/* ---- ④ 编号说明与润色提示 ---- */
const legend = TextAI.mediaLegend([
  { kind: 'image', label: '图·首帧' }, { kind: 'video', label: '参考视频' }, { kind: 'image', label: '图·尾帧' }, { kind: 'audio', label: '参考音频' },
]);
ok(/图1 = 图·首帧/.test(legend) && /视频1 = 参考视频/.test(legend) && /图2 = 图·尾帧/.test(legend) && /音频1 = 参考音频/.test(legend),
  '三类各按自己的顺序编号');
const pe = TextAI.polishExtra({ media: [{ kind: 'image' }, { kind: 'video' }] });
ok(pe.some(x => /图片 \/ 视频/.test(x) && /随附素材/.test(x)), '有素材时要说清附了哪几类');
ok(TextAI.polishExtra({ images: [{ label: 'a' }] }).some(x => /图片/.test(x)), '老的 images 入口也要说「图片」');
ok(TextAI.polishExtra({ text: '@参考图1 和 @小雅' }).some(x => /原样保留/.test(x)), '@引用标记要交代原样保留');
const mn = TextAI.materialNote([
  { label: '首帧', token: '@参考图1', sent: true },
  { label: '参考视频', token: '@视频1', sent: false, hint: '沿用它的运镜' },
]);
ok(/已随这条消息附上/.test(mn) && /无法随消息附上/.test(mn) && /@视频1/.test(mn), '素材清单要分开写「附上了」与「附不了」');

/* ---- ⑤ prepareMedia：只放行能力支持的，并逐条报原因 ---- */
TextAI._meta = { 'm-all': { image: true, audio: true, video: false } };
TextAI.prepImages = async list => list.map(x => ({ kind: 'image', label: x.label, url: 'data:image/jpeg;base64,AAA' }));
TextAI._mediaDataUrl = async (src, kind) => 'data:' + (kind === 'audio' ? 'audio/wav' : 'video/mp4') + ';base64,QUJD';
const pm = await TextAI.prepareMedia(null, [
  { kind: 'image', label: '看图', src: 'a' },
  { kind: 'audio', label: '听声', src: 'b' },
  { kind: 'video', label: '看片', src: 'c' },
], { prov, model: 'm-all' });
ok(pm.media.length === 2 && pm.media[0].kind === 'image' && pm.media[1].kind === 'audio', '只带能力支持的那两类');
ok(/视频「看片」没带/.test(pm.note), '没带的那一类要逐条说清');
ok(pm.caps && pm.caps.video && pm.caps.video.ok === false, 'caps 要一起交回去（页面据此决定要不要抽帧）');
/* 旧入口仍只交图片，且「一张都没带」时给一句人话 */
const legacy = await TextAI.polishImages(null, [], { prov, model: 'm-all' });
ok(legacy.images.length === 0 && legacy.note === '', '没有图片时旧入口安静返回');

console.log('文字 AI 多模态判定与随附素材：' + n + ' 条断言通过');
