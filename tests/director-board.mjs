#!/usr/bin/env node
/* 分镜结构化纯函数：快照 / 清单正文 / changes 对账 / 落盘点。
   用最小镜头工厂与状态桩，不碰 DOM / 网络。
   ⚠ `matchSceneOf` 用的是 `window.nameKey`（公共层那份归一）：Node 里没有 window，
   这里挂一个与 createBoardTools 注入同口径的桩。 */
import assert from 'node:assert/strict';
import { createBoardTools, matchSceneOf } from '../web/director/board.js';

globalThis.window = globalThis.window || { nameKey: s => String(s || '').trim().toLowerCase() };

let seq = 0;
const tools = createBoardTools({
  durWritable: () => true,
  nameKey: s => String(s || '').trim().toLowerCase(),
  /* 新镜头 = 一镜 + 一条默认候选（描述与配置都在候选身上）。 */
  newShot: () => ({ id: 'new' + (++seq), name: '', candidates: [{ vid: 'c' + (++seq), status: 'draft', origin: 'auto', prompt: '', dur: 0 }] }),
  setShotDur: (sh, v) => { const c = (sh.candidates || [])[0]; if (c) c.dur = v; },
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
    { id: 's1', name: '镜头 1', line: '', lineWho: '',
      candidates: [{ vid: 'c1', status: 'draft', origin: 'auto', prompt: '旧提示词', dur: 5 }] },
    { id: 's2', name: '镜头 2', line: '', lineWho: '',
      candidates: [{ vid: 'c2', status: 'draft', origin: 'auto', prompt: '第二镜', dur: 5 }] },
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
], snap);
assert.equal(plan.items.length, 3);
assert.equal(plan.skipped, 0);

const out = tools.applyBoardPlan(plan.items, scenes);
assert.equal(out.upd, 1);
assert.equal(out.add, 1);
assert.equal(out.del, 1);
assert.equal(out.skipped, 0);
assert.equal(scenes[0].shots.length, 2);
assert.equal(scenes[0].shots[0].candidates[0].prompt, '新提示词', '改稿写进这一镜的默认候选');
assert.equal(scenes[0].shots[0].candidates[0].dur, 8);
assert.equal(scenes[0].shots[1].candidates[0].prompt, '插入的一镜');
assert.equal(out.touched.length, 2, '改到的与新插的都要交给调用方夹时长');

/* ---------- 首尾帧与参考图互斥：接续镜不挂图；有图的镜头不改接续 ---------- */
{
  const sc2 = [{ id: 'sc2', name: '场景', shots: [
    { id: 's3', name: '接续镜', line: '', lineWho: '',
      candidates: [{ vid: 'c3', status: 'draft', origin: 'auto', prompt: '接续', dur: 5, linkPrev: 'tail' }] },
    { id: 's4', name: '有图镜', line: '', lineWho: '',
      candidates: [{ vid: 'c4', status: 'draft', origin: 'auto', prompt: '有图', dur: 5, refImages: ['/asset/la_x'] }] },
  ] }];
  const snap2 = tools.snapBoard(sc2);
  assert.equal(snap2[0].shots[0].refs, false);
  assert.equal(snap2[0].shots[1].refs, true, '快照要标出已有参考素材');
  assert.equal(tools.snapBoard([{ id: 's', name: '场', shots: [{ id: 'x', name: '', line: '', lineWho: '',
    candidates: [{ vid: 'c', status: 'draft', origin: 'auto', prompt: '', dur: 5,
      keyframes: [{ assetId: 'la_k' }] }] }] }])[0].shots[0].refs, true, '画面切片也占参考素材槽位');
  assert.equal(tools.snapBoard([{ id: 's', name: '场', shots: [{ id: 'x', name: '', line: '', lineWho: '',
    candidates: [{ vid: 'c', status: 'draft', origin: 'auto', prompt: '', dur: 5,
      refVideo: { src: 'x' } }] }] }])[0].shots[0].refs, true, '参考视频也占参考素材槽位');
  const list2 = tools.boardListText(snap2);
  assert.ok(list2.includes('接上一镜') && list2.includes('有参考素材'), list2);

  const pics2 = [{ src: 'data:image/png;base64,x' }];
  const p2 = tools.boardPlanOf([
    { action: 'update', scene: 1, shot: 1, prompt: '接续改', pics: ['图1'] },
    { action: 'update', scene: 1, shot: 2, prompt: '有图改', chain: 'tail' },
    { action: 'insert', scene: 1, after: 2, prompt: '新接续', chain: 'tail', pics: ['图1'] },
  ], snap2, pics2);
  assert.deepEqual(p2.items[0].patch.pics, null, '接续镜这次点的图不挂');
  assert.ok(p2.items[0].sub.includes('互斥，没挂'), p2.items[0].sub);
  assert.equal(p2.items[1].patch.chain, null, '已有参考素材的镜头没改成接续');
  assert.ok(p2.items[1].sub.includes('已有参考素材，没改成接上一镜'), p2.items[1].sub);
  assert.deepEqual(p2.items[2].patch.pics, [], '新插的接续镜也不挂图');
  assert.deepEqual(p2.picChain, [0], '冲突图号进账，审查弹窗报数');
  assert.equal(p2.chainRefused, 1);

  const p3 = tools.boardPlanOf([
    { action: 'update', scene: 1, shot: 1, prompt: '改成参考图', chain: '', pics: ['图1'] },
  ], snap2, pics2);
  assert.equal(p3.items[0].patch.chain, '', '同一条 update 里取消接续');
  assert.deepEqual(p3.items[0].patch.pics, [0], '取消接续后图可以挂');
  assert.deepEqual(p3.picChain, []);
  assert.equal(p3.chainRefused, 0);
}

/* ---------- 场景归并的认场（接着往下拆的落盘只用这一份）----------
   用户实测：现有「xxx」，AI 回「场景1 xxx」——直接同名匹配就会另起一场。
   剥编号前缀后要认回同一场；精确名优先；剥不动的照旧算新场景。 */
{
  const list = [{ name: 'xxx', shots: [] }, { name: '街头夜谈', shots: [] }];
  assert.equal(matchSceneOf('xxx', list), list[0], '精确名优先');
  assert.equal(matchSceneOf('场景1 xxx', list), list[0], '「场景1 xxx」剥掉编号前缀认回「xxx」');
  assert.equal(matchSceneOf('第2场 街头夜谈', list), list[1], '「第N场 」前缀同样剥');
  assert.equal(matchSceneOf('场景 1：街头夜谈', list), list[1], '带分隔符的前缀也剥');
  assert.equal(matchSceneOf('完全新的场景名', list), null, '剥不出前缀的照旧算新场景');
  assert.equal(matchSceneOf('', list), null, '空名不算任何一场');
}

console.log('✓ 导演台分镜工具：快照 / 清单 / 对账 / 落盘点 / 场景认回');
