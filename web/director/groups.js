/* 项目组：导演台的短片可以归进「项目组」，一个组下挂多个短片。
   从 web/director/engine.js 拆出；纯算法在这里，engine 只调用。

   为什么组名就是素材组名（用户已定）：素材库的分组本来就是一个自由文本字段
   （`Chars.Lib` 的 `group`，按 `nameKey` 合并近名），不是实体。
   所以「项目组名 = 素材组名」这一条让两边天然对齐 —— 同一个组名下的短片，
   拆分镜建出来的新素材自动落进素材库的那个同名组里，不需要任何同步动作。
   代价是：两个**不同**的组如果碰巧同名，素材会混在一起（组名是唯一的身份）。

   数据模型（都在工作区那一份里，不另开存储）：
     groups:   [{ id, name }]
     project:  { id, name, scenes, groupId }   —— groupId 空 = 未分组

   **老工程零迁移**：`groups` 缺失补 `[]`、项目没有 `groupId` 就是未分组，
   行为与今天完全一样 —— 现有工程全部落在未分组，用户不需要做任何操作。 */

export function createGroups(ctx) {
  const { nameKey, uid } = ctx;

  /* 组的名单（按名字排，同名合并 —— 与素材库那把尺子一样）。
     `groups` 缺失 / 不是数组时返回空表：老工程读回来就是这一份。 */
  function list(ws) {
    const raw = (ws && Array.isArray(ws.groups)) ? ws.groups : [];
    const out = [];
    const seen = new Set();
    raw.forEach(g => {
      if (!g || !g.id) return;
      const name = String(g.name || '').trim();
      if (!name) return;
      const k = nameKey(name);
      if (!k || seen.has(k)) return;      // 同名只留第一条
      seen.add(k);
      out.push({ id: g.id, name: name });
    });
    // 显式 zh：不传 locale 时中文序随机器默认语言漂（en 按码点，甲 > 乙）
    out.sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name), 'zh'));
    return out;
  }

  /* 一个组名对应的组（认不出就是 null —— 组被删了 / 从没归过组）。 */
  function find(ws, name) {
    const k = nameKey(String(name || ''));
    if (!k) return null;
    return list(ws).find(g => nameKey(g.name) === k) || null;
  }

  /* 这个短片在哪个组（未分组返回 null）。 */
  function groupOf(ws, project) {
    if (!project || !project.groupId) return null;
    return list(ws).find(g => g.id === project.groupId) || null;
  }

  /* 这个短片的**素材组名** —— 拆分镜建新素材时用它。
     未分组时返回空串（= 落到素材库的未分组里，界面上要照实说明）。 */
  function assetGroupName(ws, project) {
    const g = groupOf(ws, project);
    return g ? g.name : '';
  }

  /* 建一个组（同名的直接返回那一个，不重复建 —— 组名就是身份）。 */
  function ensure(ws, name) {
    const nm = String(name || '').trim();
    if (!nm) return null;
    const hit = find(ws, nm);
    if (hit) return hit;
    const g = { id: uid(), name: nm };
    if (!Array.isArray(ws.groups)) ws.groups = [];
    ws.groups.push(g);
    return g;
  }

  /* 改组名。**不动素材库里的 group 字段** —— 那是用户数据，可能还有别的来源；
     界面上只提示「素材库里有 N 条在旧组名下，要不要一起改」（由调用方去问）。
     返回旧名与新名，调用方拿它去问。 */
  function rename(ws, id, name) {
    const nm = String(name || '').trim();
    const g = list(ws).find(x => x.id === id);
    if (!g || !nm) return null;
    const raw = (ws && Array.isArray(ws.groups)) ? ws.groups : [];
    const hit = raw.find(x => x && x.id === id);
    if (!hit) return null;
    const old = String(hit.name || '');
    if (nameKey(old) === nameKey(nm)) return null;
    hit.name = nm;
    return { id, old, name: nm };
  }

  /* 删组：组内的短片**退回未分组**（一条都不删），这是必须的 ——
     删组只是整理，不是删作品。返回被退回的短片数。 */
  function remove(ws, id) {
    const raw = (ws && Array.isArray(ws.groups)) ? ws.groups : [];
    let n = 0;
    (ws.projects || []).forEach(p => {
      if (p && p.groupId === id) { p.groupId = ''; n++; }
    });
    ws.groups = raw.filter(g => g && g.id !== id);
    return n;
  }

  /* 把短片放进某个组（groupId 空 = 移出组）。 */
  function assign(ws, projectId, groupId) {
    const p = (ws.projects || []).find(x => x && x.id === projectId);
    if (!p) return null;
    p.groupId = groupId || '';
    return p;
  }

  /* 同组里新建短片的默认名：`<base> <序号>`。
     序号**只数同一个组**里已经叫这个名字的短片（未分组单独算一组），所以每组各自的
     第 1 部都从 1 起、连点就是 1 / 2 / 3，不会因为别的组占了号而跳成 1 / 3。
     不同组之间允许同名：菜单是按组画成树的，组名已经把这层区分开了；
     硬要「全工作区不重名」就得让后建的组接着别人的号往下排，反而把本组的序号打出空洞。
     老工程里光秃秃的 `<base>`（没有序号）按第 1 部算 —— 下一部就是 2。 */
  const DEFAULT_PROJECT_NAME = '未命名短片';
  function nextProjectName(ws, groupId, base) {
    const b = String(base || DEFAULT_PROJECT_NAME).trim() || DEFAULT_PROJECT_NAME;
    const gid = String(groupId || '');
    const projects = Array.isArray(ws && ws.projects) ? ws.projects : [];
    const escRe = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numbered = new RegExp('^' + escRe + '\\s+(\\d+)$');
    let max = 0;
    const taken = new Set();
    for (const p of projects) {
      if (!p) continue;
      if (String(p.groupId || '') !== gid) continue;
      const nm = String(p.name || '').trim();
      taken.add(nm);
      if (nm === b) max = Math.max(max, 1);
      const m = numbered.exec(nm);
      if (m) max = Math.max(max, Number(m[1]) || 0);
    }
    let n = max + 1;
    while (taken.has(b + ' ' + n)) n++;
    return b + ' ' + n;
  }

  /* 按组分组的短片清单：先列各组（组内按短片原来的顺序），最后列未分组。
     界面上画成树 —— 组是父、短片是子。 */
  function tree(ws) {
    const gs = list(ws);
    const used = new Set();
    const out = gs.map(g => {
      const items = (ws.projects || []).filter(p => p && p.groupId === g.id);
      items.forEach(p => used.add(p.id));
      return { kind: 'group', id: g.id, name: g.name, items: items.map(p => ({ kind: 'project', p })) };
    });
    const none = (ws.projects || []).filter(p => p && !used.has(p.id));
    if (none.length) out.push({ kind: 'none', id: '', name: '未分组', items: none.map(p => ({ kind: 'project', p })) });
    return out;
  }

  return { list, find, groupOf, assetGroupName, ensure, rename, remove, assign, tree,
    nextProjectName, DEFAULT_PROJECT_NAME };
}
