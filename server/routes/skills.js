/* Skill HTTP 路由：只做参数/响应，解析与写盘全在 server/skills-store.js。
   挂载点由 server/app.js 或 proxy.js 的 handleRequest 在 LOCAL_ONLY 闸之后调用。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('./http');

async function handleSkills(req, res, ctx) {
  const store = ctx.store;
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;
  const prefix = '/skills';
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length).replace(/^\/+/, '');
  const part = rest.split('/').filter(Boolean);
  const method = req.method;
  try {
    if (!rest && method === 'GET') {
      sendJson(res, 200, { items: store.list(), state: store.statePath });
      return true;
    }
    if (part[0] === 'install' && method === 'POST') {
      const body = await ctx.readJson(req, 6 * 1024 * 1024);
      const r = store.install(body.files || [], { enable: body.enable !== false });
      sendJson(res, 200, { ok: true, skill: { id: r.skill.id, source: r.skill.source }, displaced: r.displaced || [] });
      return true;
    }
    if (part[0] === 'import' && method === 'POST') {
      const body = await ctx.readJson(req, 6 * 1024 * 1024);
      const r = store.importBundle(body.files || [], { enable: body.enable !== false });
      sendJson(res, 200, { ok: true, skill: { id: r.skill.id, source: r.skill.source }, displaced: r.displaced || [] });
      return true;
    }
    const id = part[0];
    if (!id) { sendJson(res, 404, { error: '没有指定 Skill' }); return true; }
    if (part[1] === 'files' && method === 'GET') {
      sendJson(res, 200, { files: store.listFiles(id), hash: store.skillHash(id) });
      return true;
    }
    if (part[1] === 'update' && method === 'POST') {
      const body = await ctx.readJson(req, 6 * 1024 * 1024);
      const out = store.update(id, body.files || [], body.expectedHash || '');
      sendJson(res, 200, { ok: true, skill: { id: out.skill.id, source: out.skill.source }, hash: out.hash });
      return true;
    }
    if (part[1] === 'read' && method === 'GET') {
      sendJson(res, 200, { text: store.readRef(id, url.searchParams.get('file') || '') });
      return true;
    }
    if (!part[1] && method === 'GET') {
      const x = store.get(id);
      if (!x) throw new Error('没有这个 Skill');
      const refs = [];
      const dir = path.join(x.dir, 'references');
      if (fs.existsSync(dir)) for (const ent of fs.readdirSync(dir, { withFileTypes: true })) if (ent.isFile()) refs.push(ent.name);
      const hash = store.skillHash(id);
      sendJson(res, 200, { skill: { id: x.id, name: x.name, description: x.description, triggers: x.triggers || [], pages: x.pages || [], tools: x.tools || [], contract: x.contract, version: x.version || 1, source: x.source, enabled: !!x.enabled, body: x.body, contentHash: hash,
        /* 「素材范围优先」：与 list() 同一份（设置页的详情面板要显示并编辑它们）。
           ⚠ 「项目引用规则」不在这里 —— 那是**正文里的变量占位符**，页面自己扫正文。 */
        assetGroups: Array.isArray(x.assetGroups) ? x.assetGroups : [] }, refs, files: store.listFiles(id), hash });
      return true;
    }
    if (!part[1] && method === 'PUT') {
      const body = await ctx.readJson(req, 64 * 1024);
      /* 同 contract 的原来那份被**直接停掉**了 —— 把让位的那几份报回去，
         界面上要当场说清「哪一份停了」，不能只让人看状态自己猜。 */
      const displaced = store.setEnabled(id, body.enabled !== false);
      sendJson(res, 200, { ok: true, displaced: displaced || [] });
      return true;
    }
    if (!part[1] && method === 'DELETE') {
      store.remove(id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, { error: '不认识的 Skill 路由' });
    return true;
  } catch (e) {
    sendJson(res, (e && e.status) || 400, { error: (e && e.message) || String(e), currentHash: e && e.currentHash || undefined });
    return true;
  }
}
module.exports = { handleSkills };
