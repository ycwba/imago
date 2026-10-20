#!/usr/bin/env node
/* Skill Hub 端到端：
   - 清单读取、内置只读（可复制、不可卸载）、用户 Skill 详情与文件预览
   - 启用 → 下一轮生效（服务端状态）→ 停用 → 卸载
   只写 harness 的 .skills-probe-* / .data-probe-*。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    const call = async (p, opt = {}) => {
      const r = await fetch(proxy.base + p, { ...opt, headers: { cookie: proxy.cookie, ...(opt.headers || {}) } });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { status: r.status, json, text };
    };
    const marker = '技能正文标记-' + Date.now();
    const install = await call('/skills/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enable: false,
        files: [{
          path: 'SKILL.md',
          text: '---\nid: e2e-skill\nname: E2E 技能\ndescription: 端到端测试用\ntriggers: ["端到端"]\npages: ["assets.html"]\ncontract: polish.image\nversion: 1\n---\n\n# E2E\n\n' + marker + '\n',
        }],
      }),
    });
    if (install.status !== 200) throw new Error('安装测试 Skill 失败：' + install.status + ' ' + install.text);

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => !!(document.querySelector('.settings-page') && document.querySelector('#skillCard') && document.querySelector('#skillCard .chip')), 20000);
    await page.waitFor(() => document.querySelectorAll('.sk-item').length >= 2, 20000);

    const basics = await page.eval(() => ({
      oldPage: !!(window.WB_ROUTES && window.WB_ROUTES.pages.some(p => p.file === 'skills.html')),
      alias: window.WB_ROUTES && window.WB_ROUTES.alias['skills.html'],
      ids: [...document.querySelectorAll('.sk-item')].map(x => x.dataset.skillId),
      filters: [...document.querySelectorAll('#skillCard .chip')].map(x => x.textContent.trim()),
    }));
    if (basics.oldPage) throw new Error('Skill Hub 不该再是独立页面');
    if (basics.alias !== 'settings.html') throw new Error('旧地址 skills.html 没有指到设置：' + basics.alias);
    if (!basics.ids.includes('e2e-skill')) throw new Error('列表里没有刚安装的 Skill：' + JSON.stringify(basics.ids));
    if (!basics.filters.some(x => /已启用/.test(x))) throw new Error('缺少启停筛选：' + JSON.stringify(basics.filters));

    /* 内置：可看正文、有复制、卸载禁用 */
    await page.eval(() => document.querySelector('.sk-item[data-skill-id="video-prompt"]').click());
    await page.waitFor(() => /AI 视频提示词工程师/.test((document.querySelector('pre.sk-pre') || {}).textContent || ''), 12000);
    const builtin = await page.eval(() => ({
      copy: !!document.querySelector('#skCopy'),
      removeDisabled: !!(document.querySelector('#skRemove') || {}).disabled,
      fileCount: document.querySelectorAll('.sk-file').length,
    }));
    if (!builtin.copy) throw new Error('内置 Skill 没有「复制为我的 Skill」');
    if (!builtin.removeDisabled) throw new Error('内置 Skill 的卸载按钮应当禁用');
    if (!builtin.fileCount) throw new Error('文件树是空的');

    /* 用户 Skill：详情 / 预览 / 启用 / 停用 */
    await page.eval(() => document.querySelector('.sk-item[data-skill-id="e2e-skill"]').click());
    await page.waitFor(() => /E2E/.test((document.querySelector('pre.sk-pre') || {}).textContent || ''), 12000);
    const preview = await page.eval(() => document.querySelector('pre.sk-pre').textContent);
    if (!preview.includes(marker)) throw new Error('预览没有显示 SKILL.md 正文');

    await page.eval(() => document.querySelector('#skToggle').click());
    await page.waitFor(() => (document.querySelector('#skToggle') || {}).textContent === '停用', 12000);
    let state = await call('/skills');
    if (!(state.json.items || []).some(x => x.id === 'e2e-skill' && x.enabled)) throw new Error('点启用后服务端状态没变');

    await page.eval(() => document.querySelector('#skToggle').click());
    await page.waitFor(() => (document.querySelector('#skToggle') || {}).textContent === '启用', 12000);
    state = await call('/skills');
    if ((state.json.items || []).some(x => x.id === 'e2e-skill' && x.enabled)) throw new Error('点停用后服务端状态没变');

    /* 更新要求当前 hash：先改一次文件，再用页面上的旧 hash 更新应被 409 拦下 */
    const before = await call('/skills/e2e-skill');
    if (before.status !== 200 || !before.json.skill.contentHash) throw new Error('详情没有 contentHash');
    const changed = before.json.skill.body + '\n外部改动\n';
    const upd = await call('/skills/e2e-skill/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedHash: 'stale-hash',
        files: [{ path: 'SKILL.md', text: '---\nid: e2e-skill\nname: E2E 技能\ndescription: 端到端测试用\ntriggers: ["端到端"]\npages: ["assets.html"]\ncontract: polish.image\nversion: 2\n---\n\n' + changed }],
      }),
    });
    if (upd.status !== 409) throw new Error('旧 hash 更新应当 409：HTTP ' + upd.status + ' ' + upd.text);

    /* 卸载：两次点击（第二次才真删） */
    await page.eval(() => document.querySelector('#skRemove').click());
    await page.eval(() => document.querySelector('#skRemove').click());
    await page.waitFor(() => !document.querySelector('.sk-item[data-skill-id="e2e-skill"]'), 15000);
    const gone = await call('/skills');
    if ((gone.json.items || []).some(x => x.id === 'e2e-skill')) throw new Error('卸载后服务端仍列着它');

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ Skill 管理端到端通过（设置内清单 / 旧地址别名 / 内置只读 / 预览 / 启停 / 旧 hash 409 / 卸载）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
