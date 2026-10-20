#!/usr/bin/env node
/* 依赖式批量调度（web/director/chain.js 的 runWithDeps）：
   接续镜必须等上一镜出画面才提交；上一镜失败要级联、不能偷偷接错帧；
   等待依赖的时间不占提交名额；一条失败不终止别的分支。用假 stateOf / 假 wait，不发请求。 */
import assert from 'node:assert/strict';
import { runWithDeps } from '../web/director/chain.js';

const tick = () => new Promise(r => setTimeout(r, 0));

/* ---------- 上一镜成功之后才提交 ---------- */
{
  const state = new Map([['a', 'running'], ['b', 'todo']]);
  let releaseA = null;
  const ran = [];
  const p = runWithDeps({
    items: ['b'],
    deps: new Map([['b', 'a']]),
    limit: 1,
    stateOf: i => state.get(i),
    wait: () => new Promise(r => { releaseA = r; }),
    run: async it => { ran.push(it); return 'ok'; },
  });
  await tick();
  assert.deepEqual(ran, [], '上一镜还在跑时不许提交接续镜');
  state.set('a', 'done');
  releaseA();
  const outs = await p;
  assert.deepEqual(ran, ['b'], '上一镜出画面后接续镜才提交');
  assert.equal(outs[0].ok, true);
}

/* 依赖已经就绪时不必再等 */
{
  let waited = 0;
  const outs = await runWithDeps({
    items: ['b'],
    deps: new Map([['b', 'a']]),
    stateOf: i => (i === 'a' ? 'done' : 'todo'),
    wait: () => { waited++; return Promise.resolve(); },
    run: async () => 'ok',
  });
  assert.equal(waited, 0, '上一镜已经有尾帧就不进等待');
  assert.equal(outs[0].ok, true);
}

/* ---------- 上一镜失败：不提交，并级联到后面等它的镜头 ---------- */
{
  const state = new Map([['a', 'running'], ['b', 'todo'], ['c', 'todo']]);
  const waits = new Map();
  const arm = dep => {
    const st = state.get(dep);
    if (st === 'done' || st === 'failed') return Promise.resolve();
    return new Promise(r => waits.set(dep, r));
  };
  const wake = dep => { const w = waits.get(dep); if (w) { waits.delete(dep); w(); } };
  const ran = [], blocked = [];
  const outs = await runWithDeps({
    items: ['a', 'b', 'c'],
    deps: new Map([['b', 'a'], ['c', 'b']]),
    limit: 1,
    stateOf: i => state.get(i),
    wait: arm,
    onBlocked: (it, dep) => {
      blocked.push([it, dep]);
      state.set(it, 'failed');
      wake(it);
    },
    run: async it => {
      ran.push(it);
      if (it === 'a') {
        state.set('a', 'failed');
        wake('a');
        throw new Error('这一镜全部失败');
      }
      state.set(it, 'done');
      return 'ok';
    },
  });
  assert.deepEqual(ran, ['a'], '只提交了第一镜；失败的上一镜不做任何接续提交');
  assert.deepEqual(blocked, [['b', 'a'], ['c', 'b']], '失败要沿着依赖链一路标下去');
  assert.ok(outs.every(o => o.ok === false));
  assert.equal(outs[1].blocked, true);
  assert.equal(outs[2].blocked, true);
}

/* 等待上一镜被中断（切走短片 / 上一镜没成）→ blocked，不提交 */
{
  let ran = 0;
  const outs = await runWithDeps({
    items: ['b'],
    deps: new Map([['b', 'a']]),
    stateOf: () => 'running',
    wait: () => Promise.resolve(false),
    run: async () => { ran++; },
  });
  assert.equal(ran, 0, '等不到上一镜就不提交');
  assert.equal(outs[0].blocked, true);
}

/* ---------- 等待依赖不占提交名额：limit=1 时，别的镜头可以先用满 ---------- */
{
  const state = new Map([['dep', 'running']]);
  let wakeDep = null;
  let releaseZ = null;
  let active = 0, maxActive = 0;
  const ran = [];
  const p = runWithDeps({
    items: ['w', 'z'],
    deps: new Map([['w', 'dep']]),
    limit: 1,
    stateOf: i => state.get(i),
    wait: () => new Promise(r => { wakeDep = r; }),
    run: async it => {
      ran.push(it);
      active++;
      maxActive = Math.max(maxActive, active);
      if (it === 'z') await new Promise(r => { releaseZ = r; });
      active--;
      return it;
    },
  });
  await tick();
  assert.deepEqual(ran, ['z'], 'w 在等上一镜时，z 照样拿到唯一的提交名额');
  state.set('dep', 'done');
  wakeDep();
  await tick();
  assert.deepEqual(ran, ['z'], 'z 还占着名额时，w 不许并行提交');
  releaseZ();
  const outs = await p;
  assert.deepEqual(ran, ['z', 'w'], '名额空出来后 w 才提交');
  assert.equal(maxActive, 1, '同时在提交的永远不超过 limit');
  assert.ok(outs.every(o => o.ok));
}

/* 一条抛错不影响别的分支 */
{
  const ran = [];
  const outs = await runWithDeps({
    items: ['bad', 'good'],
    limit: 2,
    stateOf: () => 'done',
    run: async it => {
      ran.push(it);
      if (it === 'bad') throw new Error('提交失败');
      return 'ok';
    },
  });
  assert.deepEqual(ran.sort(), ['bad', 'good'], '一条失败，另一条照常提交');
  assert.equal(outs[0].ok, false);
  assert.equal(outs[1].ok, true);
}

console.log('✓ 依赖式批量：等上一镜后才提交 / 失败级联 / 中断不提交 / 等待不占名额 / 单条失败不断链');
