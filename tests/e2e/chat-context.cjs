#!/usr/bin/env node
/* 助手上下文：页面快照、Skill 按页面/触发词加载、token 预算与密钥脱敏。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    /* 一份超预算的 Skill：验证 activeFor 截断并在回合元数据里写清楚「只带了前 N 字」。 */
    const longBody = '长'.repeat(12000);
    const ins = await fetch(proxy.base + '/skills/install', {
      method: 'POST',
      headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        enable: true,
        files: [{
          path: 'SKILL.md',
          text: '---\nid: budget-probe\nname: 预算探针\ndescription: 测试预算截断\ntriggers: ["预算截断探针"]\npages: ["settings.html"]\ncontract: polish.follow\nversion: 1\n---\n\n' + longBody,
        }],
      }),
    });
    if (!ins.ok) throw new Error('安装预算探针失败：' + ins.status + ' ' + await ins.text());
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#studio.html?t=video');
    await page.waitFor(() => !!(window.__acPageCtx && window.WbSkills && window.AiChat), 15000);
    await page.waitFor(() => document.body.innerText.includes('工作台'), 10000);
    const out = await page.eval(async () => {
      const pc = window.__acPageCtx();
      const sk = await window.WbSkills.activeFor('studio.html', '视频 提示词 镜头 润色');
      const long = await window.WbSkills.activeFor('settings.html', '预算截断探针');
      const u = await import('/web/domain/chat/text-util.js');
      const raw = '密钥 sk-abcdefghijklmnopqrstuvwxyz012345 和 Bearer abcdefghijklmnop';
      const red = u.redactSecrets(raw);
      return {
        page: pc && pc['页面'],
        keys: pc ? Object.keys(pc).length : 0,
        brief: JSON.stringify(pc || {}).length,
        skills: sk.length,
        hasBody: sk.every(s => s.body && s.contract),
        hasHash: sk.every(s => !!s.contentHash),
        tokens: sk.reduce((n, s) => n + (Number(s.tokens) || 0), 0),
        long: long.length === 1 ? {
          id: long[0].id, truncated: long[0].truncated, chars: long[0].chars,
          body: long[0].body.length, truncatedChars: long[0].truncatedChars,
          tokens: long[0].tokens, hash: long[0].contentHash,
        } : null,
        token: u.estimateTokens('中文提示词测试，带一些 English words。'),
        leaked: /sk-abcdefghijklmnopqrstuvwxyz|Bearer abcdefghijklmnop/.test(red),
      };
    });
    if (!out.page || !/工作台/.test(out.page)) throw new Error('页面快照没有认出当前页：' + out.page);
    if (out.keys < 2) throw new Error('页面快照字段过少：' + out.keys);
    if (out.brief > 3000) throw new Error('页面快照没有压缩：' + out.brief + ' 字符');
    if (out.skills < 1 || out.skills > 2) throw new Error('Skill 自动加载数量不对：' + out.skills);
    if (!out.hasBody) throw new Error('加载到的 Skill 缺正文或契约');
    if (!out.hasHash) throw new Error('Skill 快照缺少 contentHash');
    if (!(out.tokens <= 3000)) throw new Error('Skill 正文超出 3000 token 预算：' + out.tokens);
    if (!out.long) throw new Error('超预算的 Skill 没有被触发加载');
    if (!out.long.truncated || !out.long.truncatedChars || out.long.body > out.long.chars) throw new Error('超预算 Skill 没有按预算截断：' + JSON.stringify(out.long));
    if (out.long.body !== out.long.truncatedChars) throw new Error('truncatedChars 与实际正文长度不一致');
    if (!(out.long.tokens <= 3000)) throw new Error('单份 Skill 超出预算：' + out.long.tokens);
    if (!out.long.hash) throw new Error('截断后的 Skill 仍应保留 contentHash');
    if (!(out.token > 0)) throw new Error('estimateTokens 没给出估算');
    if (out.leaked) throw new Error('redactSecrets 没有抹掉密钥形状');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 助手上下文通过（页面快照 / Skill≤2 / token 估算 / 密钥脱敏）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
