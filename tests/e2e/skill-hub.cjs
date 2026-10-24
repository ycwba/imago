#!/usr/bin/env node
/* Skill 管理端到端：
   - 一级菜单 = 使用场景（场景轨，11 个 contract + 助手）；点场景 → 变量表 + 这一场景的 Skill
   - 「全部 Skill」退到二级入口（筛选芯片 + 清单）
   - 启停（服务端状态）、正文预览、旧 hash 409、卸载
   - 「添加新 Skill」：在浏览器里写一份新的 → 装上 → 同一 contract 的内置那份自动让位
   - 「编辑正文」：同一张表单改自己那一份
   ⚠「复制为我的 Skill」「导出」两条已整族删除：界面上不许再出现这两个按钮。
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
    await page.waitFor(() => !!(document.querySelector('.settings-page') && document.querySelector('#skillCard') && document.querySelector('#skillCard .sk-srow')), 20000);

    /* ① 一级菜单 = 场景轨；「复制为我的」「导出」两条按钮不许再出现 */
    const basics = await page.eval(() => ({
      oldPage: !!(window.WB_ROUTES && window.WB_ROUTES.pages.some(p => p.file === 'skills.html')),
      alias: window.WB_ROUTES && window.WB_ROUTES.alias['skills.html'],
      scenes: [...document.querySelectorAll('#skillCard .sk-srow')].map(x => x.dataset.scene),
      copy: !!document.querySelector('#skCopy'),
      exportBtn: !!document.querySelector('#skExport'),
      newBtn: !!document.querySelector('#skNewBtn'),
      lamps: document.querySelectorAll('#skillCard .sk-lamp').length,
    }));
    if (basics.oldPage) throw new Error('Skill Hub 不该再是独立页面');
    if (basics.alias !== 'settings.html') throw new Error('旧地址 skills.html 没有指到设置：' + basics.alias);
    if (basics.scenes.length < 12) throw new Error('场景数不对（11 个 contract + 助手）：' + basics.scenes.length);
    if (!basics.scenes.includes('video') || !basics.scenes.includes('assistant')) throw new Error('场景轨缺行：' + JSON.stringify(basics.scenes));
    if (basics.copy) throw new Error('「复制为我的 Skill」应当已经删掉');
    if (basics.exportBtn) throw new Error('「导出」应当已经删掉');
    if (!basics.newBtn) throw new Error('场景详情里没有「添加新 Skill」');
    if (!basics.lamps) throw new Error('场景轨上没有槽位灯');

    /* ② 变量表跟着**场景**走（不是跟着某一份 Skill 走）：拆剧本那一格有五个变量 */
    await page.eval(() => document.querySelector('.sk-srow[data-scene="split"]').click());
    await page.waitFor(() => document.querySelectorAll('#skillCard .sk-vrow').length >= 5, 12000);
    const vars = await page.eval(() => [...document.querySelectorAll('#skillCard .sk-vrow .sk-vk')].map(x => x.textContent.trim()));
    if (!vars.includes('{what}') || !vars.includes('{dur}')) throw new Error('变量表不对：' + JSON.stringify(vars));

    /* ③ 场景详情里能看到这一场景的 Skill（测试那份的 contract 是 polish.image） */
    await page.eval(() => document.querySelector('.sk-srow[data-scene="img"]').click());
    await page.waitFor(() => !!document.querySelector('.sk-item[data-skill-id="e2e-skill"]'), 12000);
    const scene = await page.eval(() => ({
      title: (document.querySelector('.sk-d-title') || {}).textContent || '',
      code: (document.querySelector('.sk-code') || {}).textContent || '',
      items: [...document.querySelectorAll('#skillCard .sk-item')].map(x => x.dataset.skillId),
    }));
    if (!/图片/.test(scene.title)) throw new Error('场景详情标题不对：' + scene.title);
    if (scene.code.indexOf('polish.image') < 0) throw new Error('场景的 contract 不对：' + scene.code);
    if (!scene.items.includes('e2e-skill')) throw new Error('这一场景里没有刚装的那份：' + JSON.stringify(scene.items));

    /* ④ 正文预览（展开那一行） */
    await page.eval(() => document.querySelector('.sk-open-btn[data-skill-id="e2e-skill"]').click());
    await page.waitFor(() => /E2E/.test((document.querySelector('pre.sk-pre') || {}).textContent || ''), 12000);
    const preview = await page.eval(() => document.querySelector('pre.sk-pre').textContent);
    if (!preview.includes(marker)) throw new Error('预览没有显示 SKILL.md 正文');

    /* ⑤ 内置那份：只读（没有编辑按钮、卸载禁用），但能看正文与文件树 */
    await page.eval(() => document.querySelector('.sk-srow[data-scene="video"]').click());
    await page.waitFor(() => !!document.querySelector('.sk-item[data-skill-id="video-prompt"]'), 12000);
    await page.eval(() => document.querySelector('.sk-open-btn[data-skill-id="video-prompt"]').click());
    await page.waitFor(() => /AI 视频提示词工程师/.test((document.querySelector('pre.sk-pre') || {}).textContent || ''), 12000);
    const builtin = await page.eval(() => ({
      fileCount: document.querySelectorAll('#skillCard .sk-file').length,
      removeDisabled: !!(document.querySelector('.sk-remove[data-skill-id="video-prompt"]') || {}).disabled,
      hasEdit: !!document.querySelector('.sk-edit-btn[data-skill-id="video-prompt"]'),
    }));
    if (!builtin.fileCount) throw new Error('文件树是空的');
    if (!builtin.removeDisabled) throw new Error('内置 Skill 的卸载按钮应当禁用');
    if (builtin.hasEdit) throw new Error('内置 Skill 不该有「编辑正文」');

    /* ⑥ 启停：服务端状态跟着变 */
    await page.eval(() => document.querySelector('.sk-srow[data-scene="img"]').click());
    await page.waitFor(() => !!document.querySelector('.sk-toggle[data-skill-id="e2e-skill"]'), 12000);
    await page.eval(() => document.querySelector('.sk-toggle[data-skill-id="e2e-skill"]').click());
    await page.waitFor(() => /停用/.test((document.querySelector('.sk-toggle[data-skill-id="e2e-skill"]') || {}).textContent || ''), 12000);
    let state = await call('/skills');
    if (!(state.json.items || []).some(x => x.id === 'e2e-skill' && x.enabled)) throw new Error('点启用后服务端状态没变');
    await page.eval(() => document.querySelector('.sk-toggle[data-skill-id="e2e-skill"]').click());
    await page.waitFor(() => /启用/.test((document.querySelector('.sk-toggle[data-skill-id="e2e-skill"]') || {}).textContent || ''), 12000);
    state = await call('/skills');
    if ((state.json.items || []).some(x => x.id === 'e2e-skill' && x.enabled)) throw new Error('点停用后服务端状态没变');

    /* ⑦ 「全部 Skill」：原来的全量清单退到二级入口，筛选芯片还在 */
    await page.eval(() => document.querySelector('#skAllBtn').click());
    await page.waitFor(() => document.querySelectorAll('#skillCard .sk-allrow').length >= 2, 12000);
    const all = await page.eval(() => ({
      ids: [...document.querySelectorAll('#skillCard .sk-allrow')].map(x => x.dataset.skillId),
      filters: [...document.querySelectorAll('#skillCard .chip')].map(x => x.textContent.trim()),
    }));
    if (!all.ids.includes('e2e-skill')) throw new Error('全部清单里没有刚安装的 Skill：' + JSON.stringify(all.ids));
    if (!all.filters.some(x => /已启用/.test(x))) throw new Error('缺少启停筛选：' + JSON.stringify(all.filters));

    /* ⑧ 更新要求当前 hash：拿旧 hash 更新应被 409 拦下 */
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

    /* ⑨ 卸载：两次点击（第二次才真删） */
    await page.eval(() => document.querySelector('.sk-srow[data-scene="img"]').click());
    await page.waitFor(() => !!document.querySelector('.sk-remove[data-skill-id="e2e-skill"]'), 12000);
    await page.eval(() => document.querySelector('.sk-remove[data-skill-id="e2e-skill"]').click());
    await page.eval(() => document.querySelector('.sk-remove[data-skill-id="e2e-skill"]').click());
    await page.waitFor(() => !document.querySelector('.sk-item[data-skill-id="e2e-skill"]'), 15000);
    const gone = await call('/skills');
    if ((gone.json.items || []).some(x => x.id === 'e2e-skill')) throw new Error('卸载后服务端仍列着它');

    /* ⑩ 「添加新 Skill」：在浏览器里写一份 → 装上 → 同一 contract 的内置那份自动让位 */
    const madeId = 'e2e-made-' + Date.now();
    await page.eval(() => document.querySelector('.sk-srow[data-scene="video"]').click());
    await page.waitFor(() => !!document.querySelector('#skNewBtn'), 12000);
    await page.eval(() => document.querySelector('#skNewBtn').click());
    await page.waitFor(() => !!document.querySelector('#skSaveBtn'), 12000);
    const formPrefill = await page.eval(() => (document.querySelector('.sk-code') || {}).textContent || '');
    if (formPrefill.indexOf('polish.video') < 0) throw new Error('新建表单没有预填当前场景的 contract：' + formPrefill);
    await page.eval((id, body) => {
      const set = (sel, val) => { const el = document.querySelector(sel); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('#skFId', id);
      set('#skFName', '端到端写的那份');
      set('#skFDesc', '端到端在浏览器里写的');
      set('#skFTrig', '端到端、写法');
      set('#skFBody', body);
    }, madeId, '# 我写的\n\n' + marker + '\n');
    await page.eval(() => document.querySelector('#skSaveBtn').click());
    await page.waitFor(id => !!document.querySelector('.sk-item[data-skill-id="' + id + '"]'), 15000, 100, madeId);
    const made = await call('/skills/' + encodeURIComponent(madeId));
    if (made.status !== 200) throw new Error('新装的那份读不到：' + made.status + ' ' + made.text);
    if (made.json.skill.contract !== 'polish.video') throw new Error('新装的那份 contract 不对：' + made.json.skill.contract);
    if (!made.json.skill.body.includes(marker)) throw new Error('新装的那份正文不对');
    if (!made.json.skill.triggers.includes('端到端')) throw new Error('新装的那份触发词不对：' + JSON.stringify(made.json.skill.triggers));
    const after = await call('/skills');
    const builtinAfter = (after.json.items || []).find(x => x.id === 'video-prompt');
    if (builtinAfter && builtinAfter.enabled) throw new Error('同 contract 的内置那份应当自动让位（停用）');

    /* ⑪ 「编辑正文」：同一张表单改自己那一份 */
    await page.eval(id => { const b = document.querySelector('.sk-edit-btn[data-skill-id="' + id + '"]'); if (b) b.click(); }, madeId);
    await page.waitFor(() => !!document.querySelector('#skSaveBtn'), 12000);
    await page.eval(() => { const el = document.querySelector('#skFBody'); el.value = '# 改过的\n'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.eval(() => document.querySelector('#skSaveBtn').click());
    await page.waitFor(id => !!document.querySelector('.sk-item[data-skill-id="' + id + '"]'), 15000, 100, madeId);
    const edited = await call('/skills/' + encodeURIComponent(madeId));
    if (!edited.json.skill.body.includes('改过的')) throw new Error('编辑没落盘：' + edited.json.skill.body);

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ Skill 管理端到端通过（场景轨 / 场景级变量表 / 全部 Skill 二级入口 / 正文预览 / 启停 / 旧 hash 409 / 卸载 / 浏览器内新建与编辑）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
