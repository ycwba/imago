#!/usr/bin/env node
/* Skill 路由：清单 / 全文 / 安装 / 启停 / 删除 / contract 冲突 / 路径拒绝。 */
'use strict';
const h = require('./harness.cjs');

async function call(proxy, method, path, body) {
  const r = await fetch(proxy.base + path, {
    method,
    headers: { cookie: proxy.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, text, json };
}
const skill = (id, contract, name) => ({
  path: id + '/SKILL.md',
  text: `---\nid: ${id}\nname: ${name || id}\ndescription: 测试用\ntriggers: ["测试"]\npages: ["director.html"]\ntools: []\ncontract: ${contract}\nversion: 1\n---\n# 测试\n`,
});
(async () => {
  let proxy;
  try {
    proxy = await h.startProxy();
    let r = await call(proxy, 'GET', '/skills');
    if (r.status !== 200 || !r.json.items.some(x => x.id === 'video-prompt')) throw new Error('清单缺少内置 video-prompt：' + r.text);
    r = await call(proxy, 'GET', '/skills/video-prompt');
    if (r.status !== 200 || !/AI 视频提示词工程师/.test(r.json.skill.body)) throw new Error('全文读取失败：' + r.text);

    r = await call(proxy, 'POST', '/skills/install', { files: [skill('my-video', 'polish.image')] });
    if (r.status !== 200) throw new Error('安装失败：' + r.text);
    r = await call(proxy, 'GET', '/skills');
    if (!r.json.items.some(x => x.id === 'my-video' && x.source === 'user')) throw new Error('用户 Skill 未出现');

    r = await call(proxy, 'POST', '/skills/install', { files: [skill('my-video-2', 'polish.image')] });
    if (r.status === 200) throw new Error('同 contract 第二个应被拒绝');
    r = await call(proxy, 'POST', '/skills/install', { files: [{ path: '../evil/SKILL.md', text: 'x' }] });
    if (r.status === 200) throw new Error('路径穿越应被拒绝');

    r = await call(proxy, 'PUT', '/skills/my-video', { enabled: false });
    if (r.status !== 200) throw new Error('停用失败：' + r.text);
    r = await call(proxy, 'DELETE', '/skills/my-video');
    if (r.status !== 200) throw new Error('删除失败：' + r.text);
    console.log('✓ Skill 路由通过');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally { if (proxy) await proxy.stop(); }
})();
