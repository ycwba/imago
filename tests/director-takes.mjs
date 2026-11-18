#!/usr/bin/env node
/* 候选镜头语义（web/director/takes.js）：一镜 = 一组候选镜头。
   每条候选自带描述与拍摄配置（**没有「画面」那一层**：谁也不回落到谁）、
   克隆、批量口径（就地更新已有候选 + 张数不够才补建），
   以及旧工程的一次性形状转换（描述下沉 / 配置复制 / 默认候选补齐）。 */
import assert from 'node:assert/strict';
import {
  TAKE_ORIGINS, TAKE_CFG_KEYS, originOf, takePromptOf, setTakePrompt, shotPromptOf, setShotPrompt,
  promptTextsOf, anyPromptOf, draftTakesOf, shotHasVideo, shotVideoDone, takeStatusZh,
  takeBatchOf, cloneTakeOf, defaultTakeOf, cfgOf, sanitizeTakes,
} from '../web/director/takes.js';

assert.deepEqual(TAKE_ORIGINS, ['auto', 'manual', 'imported']);

/* ---------- 每条候选自带描述：不再有「沿用画面」那一层 ---------- */
const sh = {
  candidates: [
    { vid: 'a', status: 'draft', prompt: '默认那条', origin: 'auto' },
    { vid: 'b', status: 'draft', prompt: '自己的句', origin: 'manual' },
    { vid: 'c', status: 'draft', prompt: '', origin: 'manual' },
    { vid: 'd', status: 'succeeded', prompt: '当时那句', origin: 'imported' },
  ],
};
assert.equal(takePromptOf(sh, sh.candidates[0]), '默认那条');
assert.equal(takePromptOf(sh, sh.candidates[1]), '自己的句');
assert.equal(takePromptOf(sh, sh.candidates[2]), '', '显式空串就是空串，不回落到别人');
assert.equal(takePromptOf(sh, null), '默认那条', '没指定候选时读这一镜的主描述（默认候选那一句）');
assert.equal(shotPromptOf(sh), '默认那条');
assert.equal(defaultTakeOf(sh).vid, 'a', '默认候选 = origin auto 的那一条');

/* ---------- 写回只动那一条 ---------- */
setTakePrompt(sh, sh.candidates[0], '改过的默认');
assert.equal(sh.candidates[0].prompt, '改过的默认', '默认候选改的是它自己那份');
assert.equal(sh.candidates[1].prompt, '自己的句', '别的候选一个字不动');
setShotPrompt(sh, '主描述改了');
assert.equal(sh.candidates[0].prompt, '主描述改了', '写主描述 = 写默认候选那一句');
assert.equal(sh.candidates[1].prompt, '自己的句', '写主描述不碰别的候选');
const imported = { status: 'succeeded', prompt: null };
sh.candidates.push(imported);
setTakePrompt(sh, imported, '导入后补一句');
assert.equal(imported.origin, 'imported', '缺 origin 的成品按 imported 补');
assert.equal(imported.prompt, '导入后补一句');
const bareDraft = { status: 'draft', prompt: null };
setTakePrompt(sh, bareDraft, '草稿补一句');
assert.equal(bareDraft.origin, 'manual', '缺 origin 的草稿按 manual 补');
assert.equal(bareDraft.prompt, '草稿补一句');
assert.equal(originOf({ status: 'draft' }), 'manual');
assert.equal(originOf({ status: 'failed' }), 'imported');
assert.equal(originOf({ status: 'draft', origin: 'auto' }), 'auto');

/* ---------- 汇总读取 ---------- */
assert.deepEqual(promptTextsOf(sh), ['主描述改了', '自己的句', '当时那句', '导入后补一句'], '只收非空的描述');
assert.equal(anyPromptOf(sh), true);
assert.equal(anyPromptOf({ candidates: [{ status: 'draft', prompt: '' }] }), false);
assert.equal(anyPromptOf({ candidates: [{ status: 'draft', prompt: '候选里有一句' }] }), true);
assert.deepEqual(draftTakesOf(sh).map(c => c.vid), ['a', 'b', 'c'], '草稿按数组顺序');

/* ---------- 视频现状 ---------- */
assert.equal(shotHasVideo(sh), true, '有一条已完成候选');
assert.equal(shotVideoDone(sh), true);
assert.equal(shotHasVideo({ candidates: [{ status: 'draft' }, { status: 'failed' }, { status: 'cancelled' }] }), false);
assert.equal(shotVideoDone({ candidates: [{ status: 'running' }] }), false, '在跑不算已生成完');
assert.equal(shotHasVideo({ candidates: [{ status: 'running' }] }), true);

/* ---------- 状态词 ---------- */
assert.equal(takeStatusZh({ status: 'draft' }), '草稿');
assert.equal(takeStatusZh({ status: 'creating' }), '创建中');
assert.equal(takeStatusZh({ status: 'queued' }), '排队中');
assert.equal(takeStatusZh({ status: 'running' }), '生成中');
assert.equal(takeStatusZh({ status: 'succeeded' }), '已完成');
assert.equal(takeStatusZh({ status: 'failed' }), '生成失败');
assert.equal(takeStatusZh({ status: 'cancelled' }), '已取消');
assert.equal(takeStatusZh(null), '草稿');

/* ---------- 配置持有者：候选本身；给镜头时是当前查看那条 ---------- */
const cfgSh = { candidates: [{ vid: 'x', prompt: '一', model: 'm1' }, { vid: 'y', prompt: '二', model: 'm2' }] };
assert.equal(cfgOf(cfgSh, 0).vid, 'x');
assert.equal(cfgOf(cfgSh, 1).vid, 'y');
assert.equal(cfgOf(cfgSh, 9).vid, 'x', '越界退回第一条');
assert.equal(cfgOf(cfgSh.candidates[1], 0).vid, 'y', '给候选就是它自己');
assert.equal(cfgOf(null), null);

/* ---------- 克隆：提示词与全套配置一起复制 ---------- */
const src = { vid: 'src', prompt: '克隆源', model: 'm1', tier: 'fast', res: '768p', ar: '16:9', dur: 5,
  refImages: ['a.png'], keyframes: [{ t: 1, assetId: 'la_1' }], combo: 'cb', linkPrev: 'tail', origin: 'auto' };
const host = { id: 'sh1', candidates: [src] };
let seq = 0;
const clone = cloneTakeOf(host, src, () => 'id' + (++seq));
assert.equal(clone.prompt, '克隆源', '克隆带自己的描述');
assert.equal(clone.model, 'm1');
assert.equal(clone.dur, 5);
assert.equal(clone.combo, 'cb');
assert.equal(clone.linkPrev, 'tail', '接续标记跟着克隆走');
assert.equal(clone.origin, 'manual', '克隆出来的是用户自己加的那一条');
assert.equal(clone.status, 'draft');
assert.notEqual(clone.vid, src.vid, '克隆是新的一条');
assert.deepEqual(clone.refImages, ['a.png'], '参考图数组复制一份');
assert.notEqual(clone.refImages, src.refImages);
assert.equal(clone.keyframes[0].assetId, 'la_1', '切片按资产号复用（不重新花钱）');
assert.notEqual(clone.keyframes[0], src.keyframes[0], '切片对象复制一份：改一条不牵连另一条');

/* ---------- 批量口径：已有的待生成候选就地更新，张数不够才补建 ---------- */
const b1 = { draw: 1, candidates: [{ vid: 'd1', status: 'draft', prompt: '已有那句' }] };
const r1 = takeBatchOf(b1);
assert.equal(r1.pending.length, 1);
assert.equal(r1.usable.length, 1, '描述非空的草稿是可提交单元');
assert.equal(r1.need, 0, '张数够了就不补建');
assert.equal(r1.total, 1);
const b2 = { draw: 3, candidates: [{ vid: 'd1', status: 'draft', prompt: '已有那句' }] };
const r2 = takeBatchOf(b2);
assert.equal(r2.need, 2, '还差两张才补建克隆');
assert.equal(r2.total, 3, '总数仍等于这一镜设的张数');
const b3 = { draw: 1, candidates: [{ vid: 'd1', status: 'draft', prompt: '' }, { vid: 'd2', status: 'draft', prompt: '有' }] };
const r3 = takeBatchOf(b3);
assert.equal(r3.usable.length, 1, '空描述的不提交（发出去就是一句 400）');
assert.equal(r3.need, 0);
assert.equal(r3.total, 1);
const b4 = { draw: 2, candidates: [] };
const r4 = takeBatchOf(b4);
assert.equal(r4.usable.length, 0);
assert.equal(r4.need, 2, '一条候选都没有就按张数补建');
assert.equal(r4.total, 2);

/* ---------- 旧工程的一次性形状转换 ---------- */
const old = {
  prompt: '基准', duration: 6, tier: 'slow', res: '1080p', ar: '4:3', linkPrev: 'tail',
  candidates: [
    { vid: 'x', status: 'draft', prompt: null },
    { vid: 'y', status: 'draft', prompt: '另一句' },
    { vid: 'w', status: 'succeeded', prompt: '当时提交的那句' },
  ],
};
sanitizeTakes(old);
assert.equal(old.candidates[0].prompt, '基准', '旧的「沿用画面」冻结成当时那一句');
assert.equal(old.candidates[0].origin, 'auto', '第一条草稿是默认候选（主描述的落点）');
assert.equal(old.candidates[0].dur, 6, '镜头级的时长下沉到候选');
assert.equal(old.candidates[0].tier, 'slow');
assert.equal(old.candidates[0].res, '1080p');
assert.equal(old.candidates[0].ar, '4:3');
assert.equal(old.candidates[0].linkPrev, 'tail', '接续标记下沉到候选');
assert.equal(old.candidates[1].prompt, '另一句', '自带一句的草稿原样保留');
assert.equal(old.candidates[1].origin, 'manual');
assert.equal(old.candidates[2].origin, 'imported');
assert.equal(old.candidates[2].prompt, '当时提交的那句', '成品的描述原样保留');
assert.equal(old.prompt, undefined, '镜头级那份描述不再留着');
assert.equal(old.duration, undefined, '镜头级那份配置不再留着');

/* 一条候选都没有的镜头：补一条默认候选，带上原来那份描述与配置 */
const empty = { prompt: '基准', duration: 7, candidates: [] };
sanitizeTakes(empty, { makeDefault: s => ({ vid: 'made', status: 'draft', origin: 'auto', prompt: '', keyframes: [], refImages: [], refMeta: [] }) });
assert.equal(empty.candidates.length, 1, '补一条默认候选');
assert.equal(empty.candidates[0].prompt, '基准');
assert.equal(empty.candidates[0].dur, 7);
assert.equal(empty.candidates[0].origin, 'auto');

/* 多余的默认候选（以前的批量占位）改成 manual：它们本来就是独立的出片条目 */
const many = { prompt: '基准', candidates: [{ vid: 'a', status: 'draft', prompt: null, origin: 'auto' }, { vid: 'b', status: 'draft', prompt: null, origin: 'auto' }] };
sanitizeTakes(many);
assert.equal(many.candidates[0].origin, 'auto', '第一条是默认候选');
assert.equal(many.candidates[1].origin, 'manual', '其余归 manual');

console.log('✓ director-takes');
