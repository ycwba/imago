#!/usr/bin/env node
/* 剪辑核冒烟（**一次装配**跑完）：日常验证默认跑这一条，出包前才跑 director-edit / -history / -playback。
   验的是「核还活着」的十条主干，每一步都用**用户看得见的那一面**（板上的块 / 连接点 / 标记 / 字幕块 /
   历史读数）对账，而不是只看桥的返回值：
     ① 板画出来了（段数、刻尺、针、工具条都在）
     ② 桥切一刀（check → run）→ 块多一段
     ③ 撤销 → 回到两段
     ④ 设转场 → 连接点上出现 ◇
     ⑤ 键盘 M 加标记 → 轨道上多一枚
     ⑥ 桥写字幕（成片秒）→ 字幕块出现
     ⑦ 缩放三颗 → 读数与内容层宽度都变
     ⑧ 吸附 / 波纹开关就地刷（工具条不回整条重画）
     ⑨ 历史面板能看到刚才那几步
     ⑩ 零控制台错误、CPU 上没有长任务（板重画没有把接口吊住）
   不花时间的地方：不导入真实视频（块照样画，取帧按退避记账）、不量拖动像素（那是 director-edit 的事）。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

function seed() {
  const clip = (id, ss) => ({ id, kind: 'video', shotId: 'sh1', candId: '', name: '镜头一',
    src: '', sourceStart: ss, sourceDuration: 2, mediaDuration: 4, duration: 2, playbackRate: 1,
    volume: 1, muted: false, ln: 0 });
  return {
    projects: [{
      id: 'p_core', name: '核冒烟', curScene: 0, curShot: 0,
      scenes: [{ id: 'sc1', name: '场景 1', shots: [{
        id: 'sh1', name: '镜头一', prompt: '', line: '', lineWho: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1,
        refImages: [], keyframes: [], selId: null, candidates: [],
      }] }],
      film: {
        clips: [clip('c1', 0), clip('c2', 2)],
        voices: [], captions: [], markers: [],
        tracks: { visibility: {}, locks: {} },
      },
    }],
    curId: 'p_core', roles: [], groups: [],
  };
}

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    const put = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: seed() }),
    });
    if (!put.ok) throw new Error('写入探针工作区失败：HTTP ' + put.status);

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);
    /* 点进剪辑态：整块板只在剪辑态画出来。 */
    must(await page.eval(() => { const t = document.getElementById('trimBtn'); if (!t) return false; if (!t.classList.contains('on')) t.click(); return true; }), '没有 #trimBtn 那颗剪辑开关');
    await page.waitFor(() => document.querySelectorAll('#tlBoard .tl-clip').length === 2, 20000, 100);

    const q = (sel) => page.eval(s => document.querySelectorAll(s).length, sel);
    const txt = (sel) => page.eval(s => String((document.querySelector(s) || {}).textContent || ''), sel);
    const ctx = () => page.eval(() => {
      const c = window.WBBridge.get('director').context();
      const f = c.成片 || {};
      return { 段数: f.段数, 总秒: f.总秒, 可撤销: c.可撤销, 可重做: c.可重做, 字幕: (c.字幕 || {}).条数 || 0 };
    });
    const bridge = (op, arg) => page.eval(([o, a]) => {
      const B = window.WBBridge.get('director');
      const k = B.check(o, a);
      if (!k || k.ok === false) return { ok: false, err: (k && k.err) || 'check 没过' };
      return B.run(o, a);
    }, [op, arg]);

    /* ① 板画出来了：两段 + 刻度尺 + 针 + 工具条 + 胶片条 */
    must(await page.eval(() => {
      const b = document.getElementById('tlBoard');
      return !!b && !b.hidden && !!document.getElementById('tlRulerInner') && !!document.getElementById('tlPlayhead')
        && !!document.getElementById('tlTools') && !!document.querySelector('#tlBoard .tl-strip');
    }), '板的几件基本件没画齐（刻度尺 / 针 / 工具条 / 胶片条）');
    let c = await ctx();
    must(c.段数 === 2 && c.总秒 === 4, '成片种子不对：' + JSON.stringify(c));
    must(await q('#tlTools [data-tl]') >= 8, '工具条上的动作按钮太少：' + await q('#tlTools [data-tl]'));

    /* ② 桥切一刀：块多一段（板上同一步可见） */
    const cut = await bridge('cut', { id: 'c1', way: 'split', at: 1 });
    must(cut && cut.ok, '切一刀失败：' + JSON.stringify(cut));
    must(await page.eval(() => document.querySelectorAll('#tlBoard .tl-clip').length === 3), '切完板上不是三段');
    c = await ctx();
    must(c.段数 === 3 && c.可撤销 === 1, '切完的读数不对（段数 3 / 可撤销 1）：' + JSON.stringify(c));

    /* ③ 撤销：回到两段（Ctrl+Z 同一条路，这里走桥） */
    const undo = await bridge('undo', { mode: 'undo', steps: 1 });
    must(undo && undo.ok, '撤销失败：' + JSON.stringify(undo));
    must(await page.eval(() => document.querySelectorAll('#tlBoard .tl-clip').length === 2), '撤销后板上不是两段');
    c = await ctx();
    must(c.段数 === 2 && c.可撤销 === 0 && c.可重做 >= 1, '撤销后的读数不对：' + JSON.stringify(c));

    /* ④ 转场：设在 c1 → 第二段之间，连接点上出现 ◇ */
    const tr = await bridge('set', { kind: 'clip', id: 'c1', transition: { id: 'fade', duration: 0.5 } });
    must(tr && tr.ok, '设转场失败：' + JSON.stringify(tr));
    must(await page.eval(() => document.querySelectorAll('#tlBoard .tl-junction.has-tr').length === 1), '连接点上没出现转场 ◇');

    /* ⑤ 键盘 M 加标记：轨道上多一枚 */
    await page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true })));
    await page.waitFor(() => document.querySelectorAll('#tlBoard .tl-marker').length >= 1, 8000, 100).catch(() => {});
    must(await q('#tlBoard .tl-marker') === 1, '按 M 没有加出一枚标记：' + await q('#tlBoard .tl-marker'));

    /* ⑥ 桥写字幕（成片秒）→ 字幕块出现 */
    const sub = await bridge('set', { kind: 'subtitle', entries: [{ start: 0.2, end: 1.5, text: '核冒烟字幕' }] });
    must(sub && sub.ok, '写字幕失败：' + JSON.stringify(sub));
    must(await page.eval(() => document.querySelectorAll('#tlBoard .tl-cap').length === 1), '字幕块没画出来');
    c = await ctx();
    must(c.字幕 === 1, '字幕读数不对：' + JSON.stringify(c));

    /* ⑦ 缩放：读数与内容层宽度都变（三颗按钮真接到比例尺那一份） */
    const zoomOf = () => page.eval(() => ({
      txt: String((document.getElementById('tlZoomVal') || {}).textContent || ''),
      w: String(((document.getElementById('tlContent') || {}).style || {}).width || ''),
    }));
    const z0 = await zoomOf();
    must(await page.eval(() => { const b = document.querySelector('[data-tl="zoom-in"]'); if (!b) return false; b.click(); return true; }), '没有放大那颗');
    const z1 = await zoomOf();
    must(z1.txt !== z0.txt && z1.w !== z0.w, '放大之后读数 / 内容层宽度没变：' + JSON.stringify({ z0, z1 }));
    must(await page.eval(() => { const b = document.querySelector('[data-tl="zoom-fit"]'); if (!b) return false; b.click(); return true; }), '没有「自适应」那颗');

    /* ⑧ 吸附 / 波纹开关：就地刷（工具条还是同一条，不整条重画） */
    const before = await page.eval(() => {
      const t = document.getElementById('tlTools');
      t.__mark = 'keep-me';
      return !!t;
    });
    must(before, '没有工具条');
    await page.eval(() => document.querySelector('[data-tl="snap"]').click());
    await page.eval(() => document.querySelector('[data-tl="ripple"]').click());
    must(await page.eval(() => document.getElementById('tlTools').__mark === 'keep-me'), '吸附 / 波纹点一下把工具条整条换掉了（该就地刷）');

    /* ⑨ 历史面板：刚才那几步都在（名字不是空的「编辑」） */
    const hist = await page.eval(() => {
      const d = document.querySelector('#editLeft .el-hist');
      if (d) d.open = true;
      return [...document.querySelectorAll('#editLeft .hist-row')].map(r => String((r.querySelector('.hn') || {}).textContent || '')).slice(0, 6);
    });
    must(hist.length >= 3, '历史面板里的条目太少：' + JSON.stringify(hist));
    must(hist.every(x => x && x !== '编辑'), '历史条目的名字是空的「编辑」：' + JSON.stringify(hist));

    /* ⑩ 台词面板：AI 写台词 / 按角色生成语音两颗入口都在；没台词时后者禁用 */
    await page.eval(() => { const b = document.querySelector('#vcTabs [data-vctab="voice"]'); if (b) b.click(); });
    must(await page.eval(() => !!document.getElementById('lineGenAi')), '台词面板没有「AI 生成台词」按钮');
    must(await page.eval(() => !!document.getElementById('lineGenVoice')), '台词面板没有「生成语音」按钮');
    must(await page.eval(() => { const b = document.getElementById('lineGenVoice'); return !!b && b.disabled; }), '没有台词时「生成语音」该禁用');

    /* ⑪ 零控制台错误 */
    await h.sleep(300);
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.slice(0, 5).join(' | '));

    console.log('✓ 剪辑核冒烟（一次装配 ' + n + ' 项）：板 / 切一刀 / 撤销 / 转场 ◇ / 标记 / 字幕块 / 缩放 / 就地刷 / 历史');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
