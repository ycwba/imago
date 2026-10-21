#!/usr/bin/env node
/* 项目组：分组 / 改名 / 删组 / 归组 / 树 / 素材组名。
   这一族的判据全在 web/director/groups.js（纯算法），这里钉死它对外的契约。 */
import assert from 'node:assert/strict';
import { createGroups } from '../web/director/groups.js';

const nameKey = s => String(s == null ? '' : s).trim().toLowerCase();
let n = 0;
const uid = () => 'id' + (++n);
const G = createGroups({ nameKey, uid });

const proj = (id, groupId) => ({ id, name: '短片' + id, groupId: groupId || '', scenes: [] });

/* ① 老工作区（没有 groups、项目没有 groupId）→ 零迁移：全落未分组，不报错。 */
{
  const ws = { projects: [proj('a'), proj('b')] };
  assert.deepEqual(G.list(ws), [], '老工作区没有组');
  assert.equal(G.groupOf(ws, ws.projects[0]), null);
  assert.equal(G.assetGroupName(ws, ws.projects[0]), '', '未分组 → 素材组名是空串');
  const t = G.tree(ws);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'none', '老工程全在「未分组」那一档');
  assert.equal(t[0].items.length, 2);
}

/* ② 建组：同名的只建一个（组名就是身份）。 */
{
  const ws = { projects: [], groups: [] };
  const g1 = G.ensure(ws, '校园篇');
  const g2 = G.ensure(ws, '校园篇');
  assert.equal(g1.id, g2.id, '同名组不该建两份');
  assert.equal(G.list(ws).length, 1);
  const g3 = G.ensure(ws, '  校园篇  ');
  assert.equal(g3.id, g1.id, '近名（前后空格）算同一个组');
  assert.equal(G.ensure(ws, '   '), null, '空名不建组');
}

/* ③ 归组：组名即素材组名。 */
{
  const ws = { projects: [proj('a'), proj('b')], groups: [] };
  const g = G.ensure(ws, '校园篇');
  G.assign(ws, 'a', g.id);
  assert.equal(G.groupOf(ws, ws.projects[0]).name, '校园篇');
  assert.equal(G.assetGroupName(ws, ws.projects[0]), '校园篇', '素材组名 = 项目组名');
  assert.equal(G.assetGroupName(ws, ws.projects[1]), '', '没归组的那部 → 空串（落未分组）');
  /* 移到未分组。 */
  G.assign(ws, 'a', '');
  assert.equal(G.groupOf(ws, ws.projects[0]), null);
}

/* ④ 删组：组内的短片退回未分组，**一条都不删**。 */
{
  const ws = { projects: [proj('a'), proj('b'), proj('c')], groups: [] };
  const g = G.ensure(ws, '校园篇');
  G.assign(ws, 'a', g.id);
  G.assign(ws, 'b', g.id);
  const back = G.remove(ws, g.id);
  assert.equal(back, 2, '退回未分组的短片数');
  assert.equal(ws.projects.length, 3, '删组不许删短片');
  assert.equal(G.list(ws).length, 0, '组没了');
  assert.ok(ws.projects.every(p => !p.groupId), '组内的短片都退回未分组');
}

/* ⑤ 改组名：返回旧名与新名（调用方拿它去问素材库要不要一起改）。
     素材库那一步**不在这里**做（那是用户数据，要问过才动）。 */
{
  const ws = { projects: [], groups: [] };
  const g = G.ensure(ws, '校园篇');
  const r = G.rename(ws, g.id, '校园季');
  assert.equal(r.old, '校园篇');
  assert.equal(r.name, '校园季');
  assert.equal(G.find(ws, '校园季').name, '校园季');
  /* 改成近名（只差大小写/空格）→ 当作没改，不惊动用户。 */
  const r2 = G.rename(ws, g.id, ' 校园季 ');
  assert.equal(r2, null, '近名不算改');
}

/* ⑥ 树：先列各组（组内保持原来的顺序），最后列未分组。 */
{
  const ws = { projects: [proj('a'), proj('b'), proj('c'), proj('d')], groups: [] };
  const g1 = G.ensure(ws, '甲组');
  const g2 = G.ensure(ws, '乙组');
  G.assign(ws, 'b', g1.id);
  G.assign(ws, 'c', g2.id);
  const t = G.tree(ws);
  const kinds = t.map(x => x.kind + ':' + x.name);
  /* 组按**名字排**（中文按拼音：甲 < 乙），未分组永远在最后。 */
  assert.deepEqual(kinds, ['group:甲组', 'group:乙组', 'none:未分组'],
    '组按名字排，未分组在最后：' + kinds.join(' / '));
  assert.equal(t[0].items.length, 1);
  assert.equal(t[2].items.length, 2, '未分组那一部是 a 与 d');
}

/* ⑦ 认不出的组 id（组被删了 / 导入的坏数据）→ 归未分组，不抛。 */
{
  const ws = { projects: [Object.assign(proj('a'), { groupId: '不存在的组' })], groups: [] };
  assert.equal(G.groupOf(ws, ws.projects[0]), null);
  assert.equal(G.assetGroupName(ws, ws.projects[0]), '');
}

console.log('✓ 导演台项目组：老工程零迁移 / 建组 / 归组 / 删组 / 改名 / 树 / 素材组名');
