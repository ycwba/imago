#!/usr/bin/env node
/* 分镜结构化纯函数：快照 / 清单正文 / 统一格式解析与落盘点 / 新短片命名判据。
   用最小镜头工厂与状态桩，不碰 DOM / 网络。
   ⚠ `matchSceneOf` 用的是 `window.nameKey`（公共层那份归一）：Node 里没有 window，
   这里挂一个与 createBoardTools 注入同口径的桩。 */
import assert from 'node:assert/strict';
import { createBoardTools, matchSceneOf, isUntouchedShot, isDefaultSceneName, isDefaultProjName } from '../web/director/board.js';

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
  /* AI 点的随附图挂镜（bindShotPics 的桩）：按图号全收，够验证挂图账的形状。 */
  bindShotPics: (sh, idxs) => ({ n: idxs.length, shots: idxs.length ? 1 : 0, dup: 0, why: '', unknown: 0 }),
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
assert.equal(snap[0].shots[0].ref, 's1-1', '快照行带 ref 锚点（s场-镜）');
assert.equal(snap[0].shots[1].ref, 's1-2');
assert.ok(!('line' in snap[0].shots[0]), '快照不再喂台词（拆分镜不产出 line/speaker）');
const text = tools.boardListText(snap);
assert.ok(text.includes('场景 1') && text.includes('s1-1') && text.includes('旧提示词'), text);
assert.ok(!text.includes('台词'), '清单正文不再列台词段');

/* ---------- 统一格式解析：改（带 ref）+ 加（不带 ref）一份方案 ---------- */
{
  const pics = [{ src: 'data:image/png;base64,x' }, { src: 'data:image/png;base64,y' }];
  const j = {
    title: '测试短片',
    scenes: [
      { name: '场景一', shots: [
        { ref: 's1-1', prompt: '新提示词', duration: 8, name: '改后名', note: '画面说明' },
        { prompt: '新增的一镜', duration: 4 },
        { ref: 's9-9', prompt: '对不上的也当新镜' },
      ] },
      { name: '新场景', shots: [{ prompt: '别场镜头', chain: 'tail', pics: ['图1'] }] },
    ],
  };
  const parsed = tools.boardFullItemsOf(j, snap, pics);
  assert.equal(parsed.title, '测试短片');
  assert.equal(parsed.updN, 1);
  assert.equal(parsed.addN, 3);
  assert.equal(parsed.kept, 1, '没被 ref 提到的现有镜头数（s2）');
  assert.equal(parsed.unknownRefs, 1, '对不上的 ref 照实计数');
  assert.equal(parsed.skipped, 0);
  const up = parsed.items[0];
  assert.equal(up.upd, true);
  assert.equal(up.shotId, 's1');
  assert.equal(up.text, '新提示词');
  assert.equal(up.dur, 8);
  assert.equal(up.name, '改后名');
  const chainNew = parsed.items[3];
  assert.equal(chainNew.chain, 'tail');
  assert.deepEqual(chainNew.pics, [], '接上一镜的新镜不挂图（互斥）');
  assert.deepEqual(parsed.picChain, [0], '冲突图号进账，审查弹窗报数');
  /* 空正文的新镜没有意义：跳过并计数。 */
  const j2 = { scenes: [{ name: '场景一', shots: [{ prompt: '' }] }] };
  assert.equal(tools.boardFullItemsOf(j2, snap, pics).skipped, 1);
  /* ref 行 prompt 空着 = 保持原文（只改名 / 时长的行合法）。 */
  const j3 = { scenes: [{ name: '场景一', shots: [{ ref: 's1-1', prompt: '', name: '只改名' }] }] };
  const p3 = tools.boardFullItemsOf(j3, snap, pics);
  assert.equal(p3.updN, 1);
  assert.equal(p3.items[0].text, '旧提示词', '改镜行 prompt 空着回落到原文');
}

/* ---------- 统一格式落盘：ref 行就地改、新行按场景归并追加、未提及原样保留 ---------- */
{
  const scenes2 = [{
    id: 'sc1', name: '场景一', shots: [
      { id: 's1', name: '镜头 1', line: '', lineWho: '',
        candidates: [{ vid: 'c1', status: 'draft', origin: 'auto', prompt: '旧提示词', dur: 5 }] },
      { id: 's2', name: '镜头 2', line: '', lineWho: '',
        candidates: [{ vid: 'c2', status: 'draft', origin: 'auto', prompt: '第二镜', dur: 5 }] },
    ],
  }];
  const snap2 = tools.snapBoard(scenes2);
  const j = { scenes: [{ name: '场景一', shots: [
    { ref: 's1-1', prompt: '新提示词', duration: 8, name: '改后名' },
    { prompt: '新增的一镜', duration: 4 },
  ] }, { name: '新场景', shots: [{ prompt: '别场镜头' }] }] };
  const parsed = tools.boardFullItemsOf(j, snap2, []);
  const out = tools.applyBoardFull(parsed.items, scenes2, []);
  assert.equal(out.upd, 1);
  assert.equal(out.add, 2);
  assert.equal(out.newScenes, 1);
  assert.equal(out.kept, 1, '没被 ref 提到的 s2 原样保留');
  assert.equal(out.skipped, 0);
  assert.equal(scenes2[0].shots.length, 3, '新镜追加进同名那一场的末尾');
  assert.equal(scenes2[0].shots[0].candidates[0].prompt, '新提示词', '改稿写进这一镜的默认候选');
  assert.equal(scenes2[0].shots[0].candidates[0].dur, 8);
  assert.equal(scenes2[0].shots[0].name, '改后名');
  assert.equal(scenes2[0].shots[2].candidates[0].prompt, '新增的一镜');
  assert.equal(scenes2[1].name, '新场景');
  assert.equal(scenes2[1].shots[0].candidates[0].prompt, '别场镜头');
  assert.equal(out.touched.length, 3, '改到的与新插的都要交给调用方夹时长');
}

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
  /* AI 把有图的镜头改成接续还点了图：接续被拒，图照常带上（这次是用户手里的唯一线索）。
     ref 按场的序号编：这里只有一场，两镜是 s1-1（接续镜）/ s1-2（有图镜）。 */
  const jBad = { scenes: [{ name: '场景', shots: [
    { ref: 's1-2', chain: 'tail', pics: ['图1'] },
    { ref: 's1-1', chain: 'tail', pics: ['图1'] },
  ] }] };
  const pBad = tools.boardFullItemsOf(jBad, snap2, pics2);
  assert.deepEqual(pBad.items[0].pics, [0], '有参考素材的 ref 行图照常带上（落盘会拒接续）');
  assert.deepEqual(pBad.items[1].pics, [], '本来就接续的行摘图并进冲突账');
  assert.deepEqual(pBad.picChain, [0]);
  const outBad = tools.applyBoardFull(pBad.items, sc2, pics2);
  assert.equal(outBad.chainRefused, 1, '已有参考素材的镜头没改成接续');
  assert.equal(sc2[0].shots[0].candidates[0].linkPrev, 'tail', '本来就接续的那一镜保持原样');
  assert.ok(!sc2[0].shots[1].candidates[0].linkPrev, '有图镜没有被改成接续');
  assert.equal(outBad.picN, 1, '被拒的那一行图照常挂');
  /* 取消接续：chain 空串落下去，程序选的型号标记一起清。 */
  const sc3 = [{ id: 'sc3', name: '场景', shots: [
    { id: 's5', name: '接续镜', line: '', lineWho: '',
      candidates: [{ vid: 'c5', status: 'draft', origin: 'auto', prompt: '接续', dur: 5, linkPrev: 'tail', modelAuto: 'chain' }] },
  ] }];
  const pOff = tools.boardFullItemsOf({ scenes: [{ name: '场景', shots: [{ ref: 's1-1', chain: '' }] }] },
    tools.snapBoard(sc3), []);
  const outOff = tools.applyBoardFull(pOff.items, sc3, []);
  assert.equal(outOff.unchained, 1);
  assert.equal(sc3[0].shots[0].candidates[0].linkPrev, '', '取消接续落到候选上');
  assert.equal(sc3[0].shots[0].candidates[0].modelAuto, '', '程序选的型号标记一起清掉');
}

/* ---------- 新短片命名判据：默认值比对，动过一格就不算没动过 ---------- */
{
  const mkShot = over => Object.assign({ id: 'x', name: '新镜头', draw: 1, line: '', lineWho: '', note: '',
    candidates: [{ vid: 'c', status: 'draft', origin: 'auto', prompt: '' }] }, over || {});
  assert.equal(isUntouchedShot(mkShot()), true, '新建镜头的占位 = 没动过');
  assert.equal(isUntouchedShot(mkShot({ candidates: [{ vid: 'c', status: 'draft', origin: 'auto', prompt: '写了' }] })), false, '写了提示词就算动过');
  assert.equal(isUntouchedShot(mkShot({ name: '手改名' })), false, '改过名不算没动过');
  assert.equal(isUntouchedShot(mkShot({ draw: 3 })), false, '改过张数不算没动过');
  assert.equal(isUntouchedShot(mkShot({ candidates: [
    { vid: 'c', status: 'draft', origin: 'auto', prompt: '' },
    { vid: 'c2', status: 'draft', origin: 'manual', prompt: '' },
  ] })), false, '加过候选不算没动过');
  assert.equal(isUntouchedShot(mkShot({ candidates: [{ vid: 'c', status: 'draft', origin: 'auto', prompt: '', refImages: ['x'] }] })), false, '挂过图不算没动过');
  assert.equal(isUntouchedShot(mkShot({ line: '有台词' })), false, '写过台词不算没动过');
  assert.equal(isDefaultSceneName('场景 1'), true);
  assert.equal(isDefaultSceneName('场景 12'), true);
  assert.equal(isDefaultSceneName('雨夜街头'), false);
  assert.equal(isDefaultProjName('未命名短片'), true);
  assert.equal(isDefaultProjName('未命名短片 2'), true);
  assert.equal(isDefaultProjName(''), true);
  assert.equal(isDefaultProjName('雨夜'), false);
}

/* ---------- 场景归并的认场（统一格式的落盘只用这一份）----------
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

console.log('✓ 导演台分镜工具：快照 / 清单 / 统一格式解析与落盘 / 命名判据 / 场景认回');
