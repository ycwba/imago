#!/usr/bin/env node
/* 剪辑助手：模型回包里给 RUN: 动作 → 卡片 → 用户点「执行」→ 唯一写入桥落盘。
   验的是助手这一层：动作能执行、批量写入逐条兜底、**按身份对账**（卡片停着的时候目标块被删了，
   执行必须当场拒，不许把用户那一下盖掉）、写坏的数据能撤销。
   新桥没有修订号：凭据是「这一次要动哪一块」的身份（id），check 记下来、run 再解析一遍对身份。
   TextAI.chatStream 被换成固定回包，所以不花钱、不碰真实模型。 */
'use strict';
const fs = require('fs');
const h = require('./harness.cjs');

/* 成片秒直接用；正文 15 个汉字，按 8 字重切一定切得出多条（capResegment 的下限是 8）。 */
const SRT = '1\n00:00:00,500 --> 00:00:01,400\n助手导进来的一句台词再长一点点\n';

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    const srcId = (await (await fetch(proxy.base + '/local-assets', {
      method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-src.mp4', data: fs.readFileSync(h.clipFixture()).toString('base64'),
        format: 'mp4', mime: 'video/mp4', media_type: 'video', meta: {} }),
    })).json()).id;
    if (!srcId) throw new Error('探针素材没建出来');
    const src = '/asset/' + srcId;

    /* 工作区从代理的 .data/workspace.json 恢复（headless 每次都是干净的浏览器，正好走这条路）。
       成片（proj.film）里放两段画面 + 一句配音：切 / 改参数 / 字幕都对着它演。 */
    const clip = (id, ss) => ({ id, kind: 'video', shotId: 'sh_1', candId: 'v_probe_1', name: '镜头 1',
      src, sourceStart: ss, sourceDuration: 2, mediaDuration: 2, duration: 2, ln: 0, volume: 1, muted: false });
    const project = { id: 'pr_probe', name: '探针短片', rev: 0, scenes: [{ id: 'sc_1', name: '场景 1', shots: [{
      id: 'sh_1', name: '镜头 1', prompt: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1, line: '', note: '',
      selId: 'v_probe_1', candidates: [
        { vid: 'v_probe_1', provider: 'local', status: 'succeeded', progress: 100, url: src, local: true, duration: 2, shotId: 'sh_1' },
        { vid: 'v_probe_2', provider: 'local', status: 'succeeded', progress: 100, url: src, local: true, duration: 2, shotId: 'sh_1' },
      ] }] }],
      film: {
        clips: [clip('c1', 0), clip('c2', 0)],
        voices: [{ id: 'vw_1', shotId: 'sh_1', text: '第一句', start: 0.2, duration: 1.5, sourceStart: 0, sourceDuration: 1.5,
          playbackRate: 1, volume: 1, fadeIn: 0, fadeOut: 0, lane: 0, status: 'done', src }],
        captions: [], markers: [],
        tracks: { visibility: {}, locks: {} },
      } };
    const put = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: { projects: [project], curId: 'pr_probe', roles: [] } }),
    });
    if (!put.ok) throw new Error('写入探针工作区失败：HTTP ' + put.status);

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.AiChat && window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);
    const seeded = await page.eval(() => {
      const c = window.WBBridge.get('director').context();
      return { 项目: c.项目, 选用: c.选用, 候选: (c.候选 || []).length, 段数: c.成片 && c.成片.段数 };
    });
    if (seeded.项目 !== '探针短片' || seeded.候选 !== 2 || seeded.段数 !== 2) {
      throw new Error('工作区没从数据文件恢复：' + JSON.stringify(seeded));
    }

    await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      window.TextAI.chatStream = async () => window.__nextRun || '没有 RUN 行';
      AiChat.open();
    });
    await h.sleep(600);

    /* 一次助手回合：固定回包 → 卡片 →（可选：卡片停着的时候用户自己动一下）→ 点「执行」→ 读桥的只读快照做断言。 */
    const ctxOf = () => page.eval(() => {
      const c = window.WBBridge.get('director').context();
      const f = c.成片 || {};
      return { 选用: c.选用, 段数: f.段数, 成片秒: f.总秒, 字幕: c.字幕 && c.字幕.条数,
        可撤销: c.可撤销, 可重做: c.可重做,
        片: (f.段 || []).map(x => ({ id: x.id, start: x.start, end: x.end, 音量: x.音量, 倍速: x.倍速 })) };
    });
    const lastCard = () => page.eval(() => {
      const a = [...document.querySelectorAll('.ac-run')];
      return a.length ? a[a.length - 1].innerText.slice(0, 800) : '';
    });
    const lastMsg = () => page.eval(() => {
      const a = [...document.querySelectorAll('.ac-m')];
      return a.length ? a[a.length - 1].innerText.slice(0, 500) : '';
    });
    async function turn(run, mid) {
      const n0 = await page.eval(() => document.querySelectorAll('.ac-run').length);
      await page.eval(n => { window.__n0 = n; window.__nextRun = null; }, n0);
      await page.eval(r => { window.__nextRun = r; }, run);
      await page.eval(() => AiChat.ask('按这一句来一次'));
      await page.waitFor(() => document.querySelectorAll('.ac-run').length > window.__n0, 20000, 150).catch(() => {});
      const has = await page.eval(() => !!document.querySelector('.ac-run') && document.querySelectorAll('.ac-run').length > window.__n0);
      if (!has) return { refused: true, text: await lastMsg(), ctx: await ctxOf() };
      const card = await lastCard();
      if (mid) await mid();
      const clicked = await page.eval(() => {
        const a = [...document.querySelectorAll('.ac-run')];
        const c = a[a.length - 1];
        const b = [...c.querySelectorAll('button')].find(x => x.textContent === '执行');
        if (!b) return false;
        b.click(); return true;
      });
      if (!clicked) throw new Error('卡片上没有「执行」按钮：' + card);
      await page.waitFor(() => {
        const a = [...document.querySelectorAll('.ac-run')];
        const c = a[a.length - 1];
        return ![...c.querySelectorAll('button')].some(b => b.textContent === '执行');
      }, 25000, 150);
      await h.sleep(400);
      return { card, text: await lastCard(), ctx: await ctxOf() };
    }

    /* 0) 动作与只读工具都挂在助手这一层（不在页面里另找入口） */
    const face = await page.eval(() => {
      const acts = ['select_take', 'cut_timeline', 'set_clip', 'undo_edit', 'timeline_apply', 'subtitle_update',
        'subtitle_resegment', 'subtitle_import_srt', 'media_transcribe', 'export_start', 'export_save_to_assets'];
      const tools = ['timeline_get', 'timeline_history', 'subtitle_list', 'subtitle_export_srt', 'media_info',
        'media_frames', 'media_transcription', 'export_status', 'export_list'];
      return { acts: acts.filter(k => !AiChat.ACTS[k]), tools: tools.filter(k => !AiChat.TOOLS[k]) };
    });
    if (face.acts.length || face.tools.length) throw new Error('助手面缺项：' + JSON.stringify(face));

    /* 0b) 只读工具跑一次不许动工程 */
    const before = await ctxOf();
    const read = await page.eval(() => AiChat.TOOLS.timeline_get.run({}));
    if (!read || read.错误 || !read.当前镜头 || !(read.成片 && read.成片.段数 === 2)) {
      throw new Error('timeline_get 读不出时间线：' + JSON.stringify(read));
    }
    const after = await ctxOf();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('只读工具改动了工程：' + JSON.stringify({ before, after }));

    /* 1) 写字幕（成片秒） */
    const t1 = await turn('RUN: subtitle_update {"entries":[{"start":0.2,"end":1.5,"text":"助手写的一句"}]}');
    if (t1.refused) throw new Error('字幕卡片没出来：' + t1.text);
    if (!(t1.card.includes('字幕'))) throw new Error('卡片没把字幕说清楚：' + t1.card);
    if (t1.ctx.字幕 !== 1) throw new Error('助手写的字幕没落盘：' + JSON.stringify(t1.ctx));

    /* 2) 批量：两条 op 各占一个撤销条目，两条都做完 */
    const undoBefore2 = t1.ctx.可撤销;
    const t2 = await turn('RUN: timeline_apply {"ops":[{"op":"set","kind":"clip","id":"c1","volume":0.5},{"op":"set","kind":"clip","id":"c2","speed":2}]}');
    if (t2.refused) throw new Error('批量卡片没出来：' + t2.text);
    if (t2.ctx.段数 !== 2) throw new Error('批量把画面段弄丢了：' + JSON.stringify(t2.ctx));
    if (t2.ctx.可撤销 !== undoBefore2 + 2) throw new Error('批量两条 op 应该各占一个撤销条目：' + undoBefore2 + ' → ' + t2.ctx.可撤销);
    const volOf = (ctx, id) => ((ctx.片 || []).find(x => x.id === id) || {}).音量;
    if (volOf(t2.ctx, 'c1') !== '50%') throw new Error('批量第一条没把音量改到 50%：' + JSON.stringify(t2.ctx.片));

    /* 3) 批量里有非法目标：卡片阶段就整批拒，不留半截工程 */
    const segBefore = t2.ctx.段数;
    const t3 = await turn('RUN: timeline_apply {"ops":[{"op":"set","kind":"clip","id":"c1","volume":0.9},{"op":"set","kind":"clip","id":"nope","volume":1}]}');
    if (!t3.refused && !/nope|不存在|没有|失败/.test(t3.text)) throw new Error('非法批量没被拒：' + JSON.stringify(t3));
    if (t3.ctx.段数 !== segBefore) throw new Error('非法批量改掉了数据（半截工程）：' + JSON.stringify(t3.ctx));
    if (volOf(t3.ctx, 'c1') !== '50%') throw new Error('整批拒了却动过第一条：' + JSON.stringify(t3.ctx.片));

    /* 4) 撤销：退两步（批量那两条），音量回来 */
    const t4 = await turn('RUN: undo_edit {"steps":2}');
    if (t4.refused) throw new Error('撤销卡片没出来：' + t4.text);
    if (!(t4.ctx.可撤销 < t3.ctx.可撤销)) throw new Error('撤销没真的退步：' + JSON.stringify({ before: t3.ctx, after: t4.ctx }));
    if (volOf(t4.ctx, 'c1') !== '100%') throw new Error('撤销两步没把音量退回 100%：' + JSON.stringify(t4.ctx.片));

    /* 5) 换选用的那条候选（select_take） */
    const t5 = await turn('RUN: select_take {"take":2}');
    if (t5.refused) throw new Error('选片卡片没出来：' + t5.text);
    if (t5.ctx.选用 !== '第 2 条') throw new Error('助手换选用没生效：' + JSON.stringify(t5.ctx));

    /* 6) 导入 SRT（成片秒直接用）+ 按字数重切 */
    const t6 = await turn('RUN: subtitle_import_srt {"text":' + JSON.stringify(SRT) + '}');
    if (t6.refused) throw new Error('SRT 卡片没出来：' + t6.text);
    if (!(t6.ctx.字幕 >= 1)) throw new Error('SRT 没导进来：' + JSON.stringify(t6.ctx));
    const srt = await page.eval(() => window.WBBridge.get('director').srt({}));
    if (!(srt.ok && srt.条数 >= 1 && /助手导进来的一句台词再长一点点/.test(srt.text))) throw new Error('SRT 导出对不上：' + JSON.stringify(srt));
    const t7 = await turn('RUN: subtitle_resegment {"maxChars":8}');
    if (t7.refused) throw new Error('重切卡片没出来：' + t7.text);
    if (!(t7.ctx.字幕 >= 2)) throw new Error('按 8 字重切没切出多条：' + JSON.stringify(t7.ctx));

    /* 7) 身份对账：卡片停着的时候目标块被用户删掉 → 执行必须当场拒，不许盖掉用户那一下
       （新桥没有修订号：凭据是块 id；目标不在了就重新读 context 再来）。 */
    const t8 = await turn('RUN: cut_timeline {"way":"split","at":1}', async () => {
      const del = await page.eval(() => {
        const d = window.WBBridge.get('director');
        const c = d.check('cut', { id: 'c1', way: 'remove' });
        if (!c || c.ok === false) return { check: c };
        return { check: c, run: d.run('cut', { id: 'c1', way: 'remove' }) };
      });
      if (!del.run || del.run.ok === false) throw new Error('用户删不掉 c1：' + JSON.stringify(del));
    });
    if (!/不在了|重新读|失败|没有/.test(t8.text)) throw new Error('目标块被删了，执行却没拒：' + JSON.stringify(t8.text));
    if (t8.ctx.段数 !== 1) throw new Error('被拒的执行改动了成片（该只剩用户删完的那一段）：' + JSON.stringify(t8.ctx));

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 剪辑助手通过（11 个动作 / 9 个只读工具挂齐 · 只读不动工程 · 写字幕 · 批量两条各一个撤销条目 · 非法批量整批拒 · 撤销 · 换选用 · SRT 往返 · 按字重切 · 目标被删时按身份当场拒）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
