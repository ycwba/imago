#!/usr/bin/env node
/* 生成前校验一致性判据（常驻）—— 跑法：`node tests/gen-rules.mjs`
   治的是报告 §6.1-3：同一件「能不能提交」的事，工作台（`web/pages/studio.js` 的
   `submitBlockReason`）与助手（`web/features/chat-tools.js` 的 `genCheck`）各写一套，
   于是同一组参数一边拦一边放。现在判据只有 `web/domain/gen-rules.js` 一份，
   两侧各自把 code 翻成自己那句中文。

   这个文件要能真的拦住「又漂回两套」，四件事都判：
     ① 真值矩阵：一组 (型号 × 参数 × 素材组合) 的 fixture，**两侧的路径各跑一遍**
        （surface = page / assistant），结论逐条比对；两侧本来就该一致的，code 必须一样。
     ② 两侧都必须**用**这一份权威：`submitBlockReason` / `genCheck` 的函数体里不许再出现
        自己排规则的痕迹（`Api.isOff` / `Capabilities.specs` / `CharLimits.why` / 那句文案……），
        出现就是第二份判据。
     ③ 两侧那张 code → 中文 的表**必须把每一个 code 都翻出来**：`BLOCK_ZH` 与 `genBlockText`
        从源码里取出来真跑一遍 —— 翻出空串或落到 default 的算红
        （工作台那边空串 = `Wb.ready` 当作「可以提交」= 新加的判据被静默放行）。
     ④ 不对称登记表必须是空的（还剩只有一侧的判据，就说明没抽对）。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('./support.cjs');

const ROOT = S.root;
const abs = p => path.resolve(ROOT, p);
const read = p => fs.readFileSync(abs(p), 'utf8');

const MODULE = 'web/domain/gen-rules.js';
const CAPS = 'web/domain/capabilities.js';
const STUDIO = { file: 'web/pages/studio.js', re: /function\s+(submitBlockReason)\s*\(\s*\)\s*\{/ };
const CHAT = { file: 'web/features/chat-tools.js', re: /(?:async\s+)?function\s+(genCheck)\s*\([^)]*\)\s*\{/ };

let bad = 0, checks = 0;
function ok(cond, name, detail) {
  checks++;
  if (cond) return true;
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
  return false;
}

/* ================= 取源码片段（搬走就红，不静悄悄变绿） ================= */
function fnAt(file, headerRe) {
  const src = read(file);
  const m = headerRe.exec(src);
  if (!m) return { file, error: '找不到函数头：' + headerRe + '（搬走了就把新的位置写进这条判据）' };
  const open = src.indexOf('{', m.index + m[0].length - 1);
  const close = open < 0 ? -1 : S.matchBrace(src, open);
  if (close < 0) return { file, error: '函数头后面括号没配平' };
  return { file, name: m[1] || 'fn', text: src.slice(m.index, close + 1), body: src.slice(open, close + 1) };
}
function objAt(file, headerRe) {
  const src = read(file);
  const m = headerRe.exec(src);
  if (!m) return { file, error: '找不到对象：' + headerRe };
  const open = src.indexOf('{', m.index + m[0].length - 1);
  const close = open < 0 ? -1 : S.matchBrace(src, open);
  if (close < 0) return { file, error: '对象括号没配平' };
  return { file, text: src.slice(open, close + 1) };
}

/* ================= 一台小沙箱：真的 Capabilities + 假的平台层 ================= */
/* 型号声明与 comboGaps 用真的（判据要跑真的那一套归一化），
   平台层（密钥、停用、提交形状）与字数/语音那两条是桩：桩成「声明了什么就答什么」。 */
const REF = { max: 2, accept: 'image/png,image/jpeg', maxBytes: 10 * 1024 * 1024 };
const modelOf = (id, extra) => Object.assign(
  { id, name: id + '名', options: { aspect_ratios: ['1:1', '16:9'], max_outputs: 2, durations: [3, 5] } },
  extra || {});
const REG = {
  providers: [
    { id: 'smoke', name: '冒烟台', kind: 'image', models: [
      modelOf('m1', { inputRoles: { reference_image: REF, reference_video: { max: 1 } } }),
      modelOf('i2i', { inputRoles: { reference_image: Object.assign({}, REF, { min: 1 }) } }),
      modelOf('m2', { inputRoles: { mask: { max: 1 } } }),
      /* 一个「什么参数都没声明」的型号：用来跑 `undeclared` 那一条（其余型号都带 durations）。 */
      modelOf('nd', { options: { aspect_ratios: ['1:1'] } }),
      modelOf('ff', { inputRoles: { first_frame: { max: 1 }, reference_image: REF } }),
    ] },
    { id: 'nokey', name: '没配密钥那家', kind: 'image', models: [modelOf('m1')] },
    { id: 'off', name: '停用那家', kind: 'image', models: [modelOf('m1')] },
    { id: 'textai', name: '文字台', kind: 'text', models: [modelOf('t1')] },
    { id: 'ttsprov', name: '语音台', kind: 'audio', models: [modelOf('a1')], tts: { minChars: 5, maxChars: 100 } },
  ],
};
const NO_TEMPLATE = ['mask'];          // 注册表没给这一槽的提交形状
const sandbox = {
  console, Math, JSON, String, Number, Boolean, Array, Object, Set, Map, WeakMap, RegExp, Date, Error,
  Promise, encodeURIComponent, decodeURIComponent,
};
sandbox.window = {
  fmtBytes: n => (Number(n) / 1024 / 1024).toFixed(1) + ' MB',
  esc: s => String(s == null ? '' : s),
  Api: {
    providers: () => REG.providers,
    prov(ref) { return ref ? (REG.providers.find(p => p.id === ref) || null) : null; },
    keyId: p => p.id,
    isOff: p => p.id === 'off',
    envKnown: () => true,
    provUsable: p => p.id !== 'nokey',
    inputTemplate: (p, role) => (p && role && !NO_TEMPLATE.includes(role) ? { role } : null),
  },
  /* 字数与语音方式这两条判据本身仍留在公共层（CharLimits / TtsAdv），这里桩成同一语义：
     有声明就判、没声明一个字都不编。 */
  CharLimits: {
    tts(t) { const o = t || {}; return { min: Number(o.minChars) || 0, max: Number(o.maxChars) || 0 }; },
    has(b) { return !!(b && (b.min || b.max)); },
    count(s) { return String(s == null ? '' : s).trim().length; },
    why(text, b) {
      if (!sandbox.window.CharLimits.has(b)) return '';
      const n = sandbox.window.CharLimits.count(text);
      if (b.min && n < b.min) return '这一家要求至少 ' + b.min + ' 个字（现在 ' + n + ' 个字）';
      if (b.max && n > b.max) return '这一家要求最多 ' + b.max + ' 个字（现在 ' + n + ' 个字）';
      return '';
    },
  },
  TtsAdv: {
    wayWhy(way, o) {
      const d = o || {};
      if (!way || way.mode === 'none') return (way && way.why) || '这一家没有能直接合成的型号';
      if (way.mode === 'design' && !String(d.design || '').trim()) return '「音色设计」型号要先写一段声音描述';
      if (way.mode === 'clone' && !d.ref) return '「音色复刻」型号要先选一条参考音频';
      return '';
    },
  },
};
sandbox.globalThis = sandbox;
for (const f of [CAPS, MODULE]) vm.runInNewContext(read(f), sandbox, { filename: f, timeout: 8000 });
const GenRules = sandbox.window.GenRules;
ok(!!GenRules && typeof GenRules.whyNot === 'function', MODULE + ' 暴露 window.GenRules.whyNot');
ok(!!sandbox.window.Capabilities, CAPS + ' 装进了沙箱（判据要用真的 comboGaps）');
if (!GenRules || typeof GenRules.whyNot !== 'function') {
  console.log('\n✗ 判据跑不起来：' + MODULE + ' 没有 window.GenRules.whyNot');
  process.exit(1);
}
const CODES = GenRules.CODES || [];
ok(Array.isArray(CODES) && CODES.length >= 12, 'GenRules.CODES 是一份清单', JSON.stringify(CODES));

/* ================= ① fixture 矩阵：型号 × 参数 × 素材组合 ================= */
const ATT = [{ name: '猫.png', src: '/asset/la_1?v=2', size: 1024, mime: 'image/png' }];
const MAT = (role, o) => Object.assign({ role, source: true, bytes: null, mime: '', name: '猫.png' }, o || {});
const LONG = '一'.repeat(200);
/* 每一条都给两侧的输入：`page` = 工作台折算出来的那份（只有槽位计数、没有附件序号），
   `asst` = 助手折算出来的那份（有条目、有附件表、有卡片钉）。
   `want` 是这一条两侧各自**应该**落到的 code；`same: true` = 两侧必须同码。 */
const FIX = [
  { id: '图-能提交', want: { page: '', asst: '' }, same: true,
    page: { slots: {} }, asst: { materials: [] } },
  { id: '图-没有这一家', want: { page: 'no-provider', asst: 'no-provider' }, same: true,
    page: { provider: 'ghost' }, asst: { provider: 'ghost' } },
  { id: '图-平台 id 空', want: { page: 'no-provider', asst: 'no-provider' }, same: true,
    page: { provider: '' }, asst: { provider: '' } },
  { id: '图-没有这个型号', want: { page: 'no-model', asst: 'no-model' }, same: true,
    page: { model: 'ghost-model' }, asst: { model: 'ghost-model' } },
  { id: '图-空提示词', want: { page: 'empty-prompt', asst: 'empty-prompt' }, same: true,
    page: { prompt: '   ' }, asst: { prompt: '   ' } },
  { id: '文字台-两侧都不提交', want: { page: 'kind-text', asst: 'kind-text' }, same: true,
    page: { provider: 'textai', model: 't1' }, asst: { provider: 'textai', model: 't1' } },
  { id: '语音-工作台放行', want: { page: '', asst: 'kind-audio' },
    page: { provider: 'ttsprov', kind: 'audio', model: 'a1', prompt: '念一句话吧', tts: { mode: 'preset' } },
    asst: { provider: 'ttsprov', model: 'a1', prompt: '念一句话吧' } },
  { id: '语音-字数超了', want: { page: 'char-limits', asst: 'kind-audio' },
    page: { provider: 'ttsprov', kind: 'audio', model: 'a1', prompt: LONG, tts: { mode: 'preset' } },
    asst: { provider: 'ttsprov', model: 'a1', prompt: LONG } },
  { id: '语音-复刻没带参考音频', want: { page: 'tts-way', asst: 'kind-audio' },
    page: { provider: 'ttsprov', kind: 'audio', model: 'a1', prompt: '念一句话吧', tts: { mode: 'clone', ref: 0 } },
    asst: { provider: 'ttsprov', model: 'a1', prompt: '念一句话吧' } },
  { id: '语音-定音色没写描述', want: { page: 'tts-way', asst: 'kind-audio' },
    page: { provider: 'ttsprov', kind: 'audio', model: 'a1', prompt: '念一句话吧', tts: { mode: 'design', design: '' } },
    asst: { provider: 'ttsprov', model: 'a1', prompt: '念一句话吧' } },
  { id: '参数-画幅不在声明里', want: { page: 'param-value', asst: 'param-value' }, same: true,
    page: { params: { ar: '99:99' } }, asst: { params: { ar: '99:99' } } },
  { id: '参数-张数超上限', want: { page: 'param-value', asst: 'param-value' }, same: true,
    page: { params: { count: 9 } }, asst: { params: { count: 9 } } },
  { id: '参数-不是通用字段', want: { page: 'param-value', asst: 'param-value' }, same: true,
    page: { params: { watermark: true } }, asst: { params: { watermark: true } } },
  { id: '参数-没声明这一项', want: { page: 'param-value', asst: 'param-value' }, same: true,
    page: { model: 'nd', params: { duration: 4 } }, asst: { model: 'nd', params: { duration: 4 } } },
  /* 这一族是本轮的正主：型号声明「必须带一张参考图」、这次一张没带。 */
  { id: '素材-缺必带的那一张', want: { page: 'slot-shape', asst: 'slot-shape' }, same: true,
    page: { model: 'i2i', slots: {} }, asst: { model: 'i2i', materials: [] } },
  { id: '素材-参考图超上限', want: { page: 'slot-shape', asst: 'slot-shape' }, same: true,
    page: { model: 'i2i', slots: { reference_image: 3 } },
    asst: { model: 'i2i', materials: [MAT('reference_image'), MAT('reference_image'), MAT('reference_image')] } },
  { id: '素材-这一型号不收这一槽', want: { page: 'slot-shape', asst: 'slot-shape' }, same: true,
    page: { model: 'i2i', slots: { reference_video: 1 } },
    asst: { model: 'i2i', materials: [MAT('reference_video')] } },
  { id: '素材-互斥的两组同时用', want: { page: 'slot-pairs', asst: 'slot-pairs' }, same: true,
    page: { model: 'ff', slots: { first_frame: 1, reference_image: 1 } },
    asst: { model: 'ff', materials: [MAT('first_frame'), MAT('reference_image')] } },
  { id: '素材-密钥没配（两侧同一码）', want: { page: 'key-not-configured', asst: 'key-not-configured' }, same: true,
    page: { provider: 'nokey', keyConfigured: false }, asst: { provider: 'nokey', keyConfigured: false } },
  { id: '素材-这家被本机停用', want: { page: 'provider-off', asst: 'provider-off' }, same: true,
    page: { provider: 'off' }, asst: { provider: 'off' } },
  /* 下面三条只有助手那一侧表达得出来（页面没有附件序号、没模板兜底、也没扩展字段那一排）。 */
  { id: '素材-第几项取不到来源', want: { page: '', asst: 'slot-source' },
    page: { slots: { reference_image: 1 } },
    asst: { materials: [MAT('reference_image', { source: false })] } },
  { id: '素材-注册表没这一槽的提交形状', want: { page: '', asst: 'slot-template' },
    page: { model: 'm2', slots: { mask: 1 } },
    asst: { model: 'm2', materials: [MAT('mask')] } },
  { id: '素材-单文件超上限', want: { page: '', asst: 'slot-bytes' },
    page: { model: 'i2i', slots: { reference_image: 1 } },
    asst: { model: 'i2i', materials: [MAT('reference_image', { bytes: 11 * 1024 * 1024 })] } },
  { id: '素材-文件类型不收', want: { page: '', asst: 'slot-accept' },
    page: { model: 'i2i', slots: { reference_image: 1 } },
    asst: { model: 'i2i', materials: [MAT('reference_image', { mime: 'video/mp4' })] } },
  { id: '扩展字段-平台那一排不合格', want: { page: 'shape-field', asst: '' },
    page: { extrasBad: ['运动幅度要填整数'] }, asst: {} },
  { id: '附件-序号漂到别的文件', want: { page: '', asst: 'attachment-drift' },
    page: { slots: { reference_image: 1 } },
    asst: { materials: [MAT('reference_image')], attachments: ATT,
      pin: [{ slot: 0, idx: 0, name: '别的.png', src: '/asset/la_1?v=2' }] } },
  { id: '附件-序号与名字都在（放行）', want: { page: '', asst: '' }, same: true,
    page: { slots: { reference_image: 1 } },
    asst: { materials: [MAT('reference_image')], attachments: ATT,
      pin: [{ slot: 0, idx: 0, name: '猫.png', src: '/asset/la_1?v=2' }] } },
];
const BASE = { provider: 'smoke', model: 'm1', prompt: '一只猫', kind: '', params: null, combo: '',
  slots: null, materials: null, attachments: null, pin: null, tts: null, extrasBad: null, keyConfigured: null };
function mkInput(surface, o) {
  return Object.assign({}, BASE, { surface }, o || {});
}
console.log('生成前校验：工作台 × 助手 一致性（' + FIX.length + ' 组 fixture × 两侧 / '
  + CODES.length + ' 个 code / 不对称登记 ' + 0 + ' 条）');
const seen = new Set();
for (const fx of FIX) {
  const got = {};
  for (const side of ['page', 'asst']) {
    const v = GenRules.whyNot(mkInput(side, fx[side]));
    got[side] = (v && v.code) || '';
    seen.add(got[side]);
    ok(got[side] === fx.want[side], 'fixture ' + fx.id + '（' + side + '）结论 = ' + (fx.want[side] || '放行'),
      '实际 ' + (got[side] || '放行') + '，args=' + JSON.stringify(v && v.args));
  }
  if (fx.same) {
    ok(got.page === got.asst, 'fixture ' + fx.id + ' 两侧同码', '工作台 ' + (got.page || '放行') + ' / 助手 ' + (got.asst || '放行'));
  }
}
/* 每个 code 都要至少被一条 fixture 跑到：新加判据却没有 fixture = 没人保证两侧一致。 */
for (const code of CODES) ok(seen.has(code), 'code ' + code + ' 有 fixture 覆盖', '矩阵里没有任何一条落到这个码');

/* ================= ② 两侧都必须把判据交出去 ================= */
const studioFn = fnAt(STUDIO.file, STUDIO.re);
const chatFn = fnAt(CHAT.file, CHAT.re);
ok(!studioFn.error, STUDIO.file + ' 的 submitBlockReason 取得到', studioFn.error);
ok(!chatFn.error, CHAT.file + ' 的 genCheck 取得到', chatFn.error);
const SELF_RULES = [
  { who: '工作台', ref: studioFn, probes: [
    [/CharLimits\s*\.\s*(why|tts)\s*\(/, '字数又在页面里判了一遍'],
    [/TtsAdv\s*\.\s*wayWhy\s*\(/, '语音方式又在页面里判了一遍'],
    [/shapeGaps\s*\(/, '形状差集又在页面里算了一遍'],
    [/advExtras\s*\(/, '扩展字段又在页面里判了一遍'],
    [/Capabilities\s*\.\s*(comboGaps|specs|rule|illegalPairs)\s*\(/, '页面直接问 Capabilities 排规则'],
    [/if\s*\(\s*!\s*(text|prompt|prov|model)\b/, '页面自己排「缺什么就拦」这一条'],
    [/请输入提示词|请输入要合成的文本|注册表里没有可用的/, '文案出现在判据函数里（只许出现在 code → 文案那张表里）'],
  ] },
  { who: '助手', ref: chatFn, probes: [
    [/Api\s*\.\s*isOff\s*\(/, '停用开关又在助手这里判一遍'],
    [/if\s*\(\s*!\s*ok\s*\[/, '密钥是否在白名单又排了一遍（只许算好 keyConfigured 递进判据）'],
    /* 只拦**本地再写一份**（`function checkParam`）；`GenRules.checkParam(` 那一次调用是正路，
       助手把结构化错翻成自己那句话（`paramErrZh`）不算第二条判据。 */
    [/\bfunction\s+checkParam\s*\(/, '参数取值又自己排了一遍（要归一化请调 GenRules.checkParam）'],
    [/Capabilities\s*\.\s*(specs|rule|illegalPairs)\s*\(/, '助手直接问 Capabilities 排规则'],
    [/Api\s*\.\s*inputTemplate\s*\(/, '提交形状又在助手这里查一遍'],
    [/附件已经变了|不接受输入槽位|没有平台 id|还没配密钥|要写 prompt/, '文案出现在判据函数里（只许出现在 code → 文案那张函数里）'],
  ] },
];
for (const g of SELF_RULES) {
  if (g.ref.error) continue;
  ok(/GenRules\s*\.\s*whyNot/.test(g.ref.body), g.who + ' 的校验函数走 GenRules.whyNot', '还在自己判（抽取没接上）');
  for (const [re, why] of g.probes) {
    ok(!re.test(g.ref.body), g.who + ' 的校验函数里没有第二条判据：' + why, re + ' 命中了');
  }
}

/* ================= ③ 每个 code 两侧都翻得出中文 ================= */
const ARGS = {
  'no-provider': { ref: 'ghost', kind: 'image' },
  'provider-off': { name: '停用那家' },
  'key-not-configured': { name: '没配密钥那家', id: 'nokey' },
  'kind-text': { kind: 'text' }, 'kind-audio': { kind: 'audio' },
  'no-model': { ref: 'ghost', id: 'smoke', ids: ['m1'] },
  'empty-prompt': { kind: 'audio' },
  'param-value': { key: 'ar', want: '99:99', decl: ['1:1', '16:9'], modelId: 'm1', why: 'not-in-list' },
  'tts-way': { mode: 'clone', why: '「音色复刻」型号要先选一条参考音频' },
  'char-limits': { why: '这一家要求最多 100 个字（现在 200 个字）' },
  'slot-shape': { why: 'over', modelId: 'm1', declared: ['reference_image'], lines: ['当前型号最多收：参考图 2 个'],
    over: [{ role: 'reference_image', max: 2, got: 3 }], missing: [{ role: 'reference_image', min: 1, got: 0 }],
    rejected: [{ role: 'reference_video', got: 1, why: 'model' }] },
  'slot-pairs': { modelId: 'm1', conflicts: [['first_frame', 'reference_image']], lines: ['已同时选了互斥的两组'] },
  'slot-source': { i: 0, role: 'reference_image' },
  'slot-template': { i: 1, role: 'mask' },
  'slot-bytes': { i: 0, role: 'reference_image', name: '猫.png', bytes: 11 * 1024 * 1024, maxBytes: 10 * 1024 * 1024 },
  'slot-accept': { i: 0, role: 'reference_image', name: '猫.png', mime: 'video/mp4', accept: 'image/png' },
  'shape-field': { why: '运动幅度要填整数', count: 1 },
  'attachment-drift': { list: [{ slot: 0, idx: 0, name: '猫.png', src: '/asset/la_1?v=2' }] },
};
ok(Object.keys(ARGS).sort().join() === CODES.slice().sort().join(),
  'fixture 侧的 code 清单与 GenRules.CODES 对得上',
  '多了 ' + JSON.stringify(Object.keys(ARGS).filter(k => !CODES.includes(k)))
  + ' 少了 ' + JSON.stringify(CODES.filter(k => !Object.keys(ARGS).includes(k))));

const CTX = { r: REG, a: { provider: 'ghost', model: 'ghost-model' }, p: REG.providers[0], m: REG.providers[0].models[0] };
/* 工作台那张表：把 `BLOCK_ZH` 的字面量取出来真跑（它要 TYPES / TYPE / fmtBytes）。 */
const studioTable = objAt(STUDIO.file, /const\s+(BLOCK_ZH)\s*=\s*\{/);
ok(!studioTable.error, STUDIO.file + ' 的 BLOCK_ZH 取得到', studioTable.error);
let pageText = null;
if (!studioTable.error) {
  const box = { console, String, Number, Math, Object, Array, JSON,
    TYPES: { video: { zh: '视频' }, image: { zh: '图像' }, audio: { zh: '音频' } }, TYPE: 'image',
    window: { fmtBytes: sandbox.window.fmtBytes } };
  box.globalThis = box;
  try {
    pageText = vm.runInNewContext('(' + studioTable.text + ')', box, { filename: 'BLOCK_ZH' });
  } catch (e) { pageText = null; ok(false, 'BLOCK_ZH 能取成对象', String((e && e.message) || e)); }
}
/* 助手那个函数：连 `paramErrZh` 一起取出来（它被 param-value 那一支调）。 */
const chatTable = fnAt(CHAT.file, /function\s+(genBlockText)\s*\(\s*v\s*,\s*ctx\s*\)\s*\{/);
const chatParamErr = fnAt(CHAT.file, /function\s+(paramErrZh)\s*\(\s*e\s*\)\s*\{/);
ok(!chatTable.error, CHAT.file + ' 的 genBlockText 取得到', chatTable.error);
ok(!chatParamErr.error, CHAT.file + ' 的 paramErrZh 取得到', chatParamErr.error);
let asstText = null;
if (!chatTable.error && !chatParamErr.error) {
  const box = { console, String, Number, Math, Object, Array, JSON, Set,
    cap: (s, n) => String(s == null ? '' : s).slice(0, n || 40),
    window: { fmtBytes: sandbox.window.fmtBytes, provKindZh: k => ({ image: '生图', video: '视频', audio: '语音', text: '文字' })[k] || k } };
  box.globalThis = box;
  try {
    asstText = vm.runInNewContext(chatParamErr.text + '\n' + chatTable.text + '\ngenBlockText', box, { filename: 'genBlockText' });
  } catch (e) { asstText = null; ok(false, 'genBlockText 能取成函数', String((e && e.message) || e)); }
}
const DEFAULT_MARK = { page: '（', asst: '判据这一侧还没有对应的说法' };
for (const code of CODES) {
  const v = { code, args: ARGS[code] || {} };
  for (const [who, fn, mark] of [['工作台', pageText, null], ['助手', asstText, DEFAULT_MARK.asst]]) {
    if (!fn) continue;
    const s = String(who === '工作台' ? (fn[code] ? fn[code](v) : '') : fn(v, CTX));
    if (who === '工作台') ok(!!fn[code], '工作台翻得出 code ' + code, 'BLOCK_ZH 里没有这一条');
    ok(!!s.trim(), who + ' 把 code ' + code + ' 翻成了中文', '翻出来是空串（工作台那一侧等于放行）');
    ok(!/undefined|NaN/.test(s), who + ' 那句没有 undefined/NaN（' + code + '）', s);
    if (mark) ok(s.indexOf(mark) < 0, who + ' 的 code ' + code + ' 没落到 default 分支', s);
    if (who === '工作台') ok(s.indexOf('（' + code + '）') < 0, '工作台 的 code ' + code + ' 没落到兜底说法', s);
    ok(/[一-龥]/.test(s), who + ' 那句是中文（' + code + '）', s);
  }
}

/* ================= ④ 不对称必须是零 ================= */
/* 抽取之前登记在案的五条（字符上限、语音方式、密钥、停用、附件漂移）现在都在这一个模块里；
   还剩任何一条 = 只有一侧判 = 没抽对。新增不对称就红。 */
const ASYMMETRY = [];
ok(ASYMMETRY.length === 0, '不对称登记表已清空', ASYMMETRY.map(a => a.id).join('、'));

console.log('\n' + (bad ? '✗ ' : '✓ ') + checks + ' 项判据，' + bad + ' 项未通过');
process.exit(bad ? 1 : 0);
