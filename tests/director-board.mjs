#!/usr/bin/env node
/* 分镜结构化纯函数：快照 / 清单正文 / changes 对账 / 落盘点。
   用最小镜头工厂与状态桩，不碰 DOM / 网络。 */
import assert from 'node:assert/strict';
import { createBoardTools } from '../web/director/board.js';

let seq = 0;
const tools = createBoardTools({
  durWritable: () => true,
  nameKey: s => String(s || '').trim().toLowerCase(),
  newShot: () => ({ id: 'new' + (++seq), prompt: '', name: '', duration: 0, candidates: [] }),
  setShotDur: (sh, v) => { sh.duration = v; },
  removeShot: (sc, sh) => {
    const i = sc.shots.indexOf(sh);
    if (i < 0 || sc.shots.length <= 1) return false;
    sc.shots.splice(i, 1);
    return true;
  },
  uid: () => 'scene-new',
  Wb: { stLive: () => false },
  feedScenePics: () => ({ added: 0, why: '' }),
  clampShotDurations: () => ({ fixed: 0, detail: '', more: 0 }),
});

const scenes = [{
  id: 'sc1', name: '场景一', shots: [
    { id: 's1', name: '镜头 1', prompt: '旧提示词', line: '', lineWho: '', duration: 5, candidates: [] },
    { id: 's2', name: '镜头 2', prompt: '第二镜', line: '', lineWho: '', duration: 5, candidates: [] },
  ],
}];
const snap = tools.snapBoard(scenes);
assert.equal(snap.length, 1);
assert.equal(snap[0].shots[0].sh.id, 's1');
assert.equal(snap[0].shots[0].dur, 5);
const text = tools.boardListText(snap);
assert.ok(text.includes('场景 1') && text.includes('镜头 1') && text.includes('旧提示词'), text);

const plan = tools.boardPlanOf([
  { action: 'update', scene: 1, shot: 1, prompt: '新提示词', duration: 8 },
  { action: 'insert', scene: 1, after: 1, prompt: '插入的一镜', duration: 4 },
  { action: 'delete', scene: 1, shot: 2 },
], snap, { style: '' });
assert.equal(plan.items.length, 3);
assert.equal(plan.skipped, 0);

const out = tools.applyBoardPlan(plan.items, scenes);
assert.equal(out.upd, 1);
assert.equal(out.add, 1);
assert.equal(out.del, 1);
assert.equal(out.skipped, 0);
assert.equal(scenes[0].shots.length, 2);
assert.equal(scenes[0].shots[0].prompt, '新提示词');
assert.equal(scenes[0].shots[0].duration, 8);
assert.equal(scenes[0].shots[1].prompt, '插入的一镜');
assert.equal(out.touched.length, 2, '改到的与新插的都要交给调用方夹时长');
console.log('✓ 导演台分镜工具：快照 / 清单 / 对账 / 落盘点');
