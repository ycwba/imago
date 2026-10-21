#!/usr/bin/env node
/* 剪辑助手：模型回包里给 RUN: 动作 → 卡片 → 用户点「执行」→ 唯一写入桥落盘。
   验的是助手这一层：动作能执行、批量是一条快照、过期修订号会被拒、写坏的数据能撤销。
   TextAI.chatStream 被换成固定回包，所以不花钱、不碰真实模型。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const h = require('./harness.cjs');

function hasFfmpeg() {
  try { cp.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
function makeClip(dir) {
  const f = path.join(dir, 'probe-src.mp4');
  cp.execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=128x72:rate=12:duration=2',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', f], { stdio: 'pipe' });
  return f;
}
const SRT = '1\n00:00:00,500 --> 00:00:01,400\n助手导进来的一句\n';

(async () => {
  if (!hasFfmpeg()) { console.log('- 跳过剪辑助手（本机没有 ffmpeg，造不出测试素材）'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-aedit-'));
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    const srcId = (await (await fetch(proxy.base + '/local-assets', {
      method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-src.mp4', data: fs.readFileSync(makeClip(work)).toString('base64'),
        format: 'mp4', mime: 'video/mp4', media_type: 'video', meta: {} }),
    })).json()).id;
    if (!srcId) throw new Error('探针素材没建出来');

    /* 工作区从代理的 .data/workspace.json 恢复（headless 每次都是干净的浏览器，正好走这条路）。 */
    const project = { id: 'pr_probe', name: '探针短片', rev: 0, scenes: [{ id: 'sc_1', name: '场景 1', shots: [{
      id: 'sh_1', name: '镜头 1', prompt: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1, line: '', note: '',
      selId: 'v_probe_1', candidates: [
        { vid: 'v_probe_1', provider: 'local', status: 'succeeded', progress: 100, url: '/asset/' + srcId, local: true, duration: 2, shotId: 'sh_1' },
        { vid: 'v_probe_2', provider: 'local', status: 'succeeded', progress: 100, url: '/asset/' + srcId, local: true, duration: 2, shotId: 'sh_1' },
      ] }] }] };
    const put = await fetch(proxy.base + '/data/workspace', {
      method: 'PUT', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), data: { projects: [project], curId: 'pr_probe', roles: [] } }),
    });
    if (!put.ok) throw new Error('写入探针工作区失败：HTTP ' + put.status);

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.AiChat && window.WBBridge && window.WBBridge.get('director')
      && window.WBBridge.get('director').ready(), 25000);
    const seeded = await page.eval(() => {
      const c = window.WBBridge.get('director').context();
      return { 项目: c.项目, 选用: c.选用, 候选: (c.候选 || []).length, revision: c.revision, 字幕: c.字幕 && c.字幕.条数 };
    });
    if (seeded.项目 !== '探针短片' || seeded.候选 !== 2) throw new Error('工作区没从数据文件恢复：' + JSON.stringify(seeded));

    await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      window.TextAI.chatStream = async () => window.__nextRun || '没有 RUN 行';
      AiChat.open();
    });
    await h.sleep(600);

    /* 一次助手回合：固定回包 → 卡片 → 点「执行」→ 读桥的只读快照做断言。 */
    const ctxOf = () => page.eval(() => {
      const c = window.WBBridge.get('director').context();
      return { 选用: c.选用, 段数: c.这一条 && c.这一条.段数, 成片秒: c.这一条 && c.这一条.成片秒,
        字幕: c.字幕 && c.字幕.条数, revision: c.revision, 可撤销: c.可撤销, 字幕来源: c.字幕 && c.字幕.来源 };
    });
    const lastCard = () => page.eval(() => {
      const a = [...document.querySelectorAll('.ac-run')];
      return a.length ? a[a.length - 1].innerText.slice(0, 800) : '';
    });
    async function turn(run, staleFirst) {
      const n0 = await page.eval(() => document.querySelectorAll('.ac-run').length);
      await page.eval(n => { window.__n0 = n; window.__nextRun = null; }, n0);
      await page.eval(r => { window.__nextRun = r; }, run);
      await page.eval(() => AiChat.ask('按这一句来一次'));
      await page.waitFor(() => document.querySelectorAll('.ac-run').length > window.__n0, 20000, 150).catch(() => {});
      const has = await page.eval(() => !!document.querySelector('.ac-run') && document.querySelectorAll('.ac-run').length > window.__n0);
      if (!has) return { refused: true, text: await lastMsg(), ctx: await ctxOf() };
      const card = await lastCard();
      if (staleFirst) {
        /* 卡片停在屏幕上时用户自己动了一次时间线：卡片上冻结的那份修订号当场过期。 */
        await page.eval(() => window.WBBridge.get('director').run('cut', { take: 1, way: 'split', at: 1.6,
          expectedRevision: window.WBBridge.get('director').context().revision }));
      }
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
    const lastMsg = () => page.eval(() => {
      const a = [...document.querySelectorAll('.ac-m')];
      return a.length ? a[a.length - 1].innerText.slice(0, 500) : '';
    });

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
    if (!read || read.错误 || !read.镜头) throw new Error('timeline_get 读不出时间线：' + JSON.stringify(read));
    const after = await ctxOf();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('只读工具改动了工程：' + JSON.stringify({ before, after }));

    /* 1) 写字幕 */
    const t1 = await turn('RUN: subtitle_update {"take":1,"entries":[{"index":1,"startMs":200,"endMs":1500,"text":"助手写的一句"}]}');
    if (t1.refused) throw new Error('字幕卡片没出来：' + t1.text);
    if (!(t1.card.includes('字幕'))) throw new Error('卡片没把字幕说清楚：' + t1.card);
    if (t1.ctx.字幕 !== 1) throw new Error('助手写的字幕没落盘：' + JSON.stringify(t1.ctx));

    /* 2) 卡片停在屏幕上时用户自己动了时间线 → 执行必须撞修订号，不能盖掉用户 */
    const segBefore2 = t1.ctx.段数;
    const t2 = await turn('RUN: subtitle_update {"take":1,"entries":[{"index":1,"startMs":100,"endMs":800,"text":"不该被执行的那一份"}]}', true);
    if (t2.ctx.字幕 === 1 && !/又改过|没有执行|先重新读|revision/i.test(t2.text)) {
      throw new Error('过期修订号既没拒掉也没说清：' + JSON.stringify({ text: t2.text, ctx: t2.ctx }));
    }
    if (t2.ctx.字幕 !== 1) throw new Error('被拒的写入改掉了字幕：' + JSON.stringify(t2.ctx));
    if (t2.ctx.段数 !== segBefore2 + 1) throw new Error('卡片停留期间用户那一刀没落到工程上：' + JSON.stringify(t2.ctx));

    /* 3) 批量：两条 op 只压一次撤销快照 */
    const undoBefore = t2.ctx.可撤销;
    const t3 = await turn('RUN: timeline_apply {"ops":[{"op":"set","take":1,"seg":' + t2.ctx.段数 + ',"speed":2},{"op":"cut","take":1,"way":"split","at":0.4}]}');
    if (t3.refused) throw new Error('批量卡片没出来：' + t3.text);
    if (t3.ctx.段数 !== t2.ctx.段数 + 1) throw new Error('批量没把两条 op 都做完：' + JSON.stringify({ before: t2.ctx, after: t3.ctx }));
    if (t3.ctx.可撤销 !== undoBefore + 1) throw new Error('一批写入应该只压一个撤销快照：' + undoBefore + ' → ' + t3.ctx.可撤销);

    /* 4) 批量里有非法 op：卡片阶段就整批拒，不留半截工程 */
    const segBefore = t3.ctx.段数;
    const t4 = await turn('RUN: timeline_apply {"ops":[{"op":"cut","take":1,"way":"split","at":0.5},{"op":"set","take":9,"seg":1,"speed":2}]}');
    if (!t4.refused && !/第 9 条|不存在|没有|失败/.test(t4.text)) throw new Error('非法批量没被拒：' + JSON.stringify(t4));
    if (t4.ctx.段数 !== segBefore) throw new Error('非法批量改掉了数据（半截工程）：' + JSON.stringify(t4.ctx));

    /* 5) 撤销：退两步（批量那一刀 + 用户那一刀），字幕仍在那儿 */
    const t5 = await turn('RUN: undo_edit {"steps":2}');
    if (t5.refused) throw new Error('撤销卡片没出来：' + t5.text);
    if (!(t5.ctx.可撤销 < t4.ctx.可撤销)) throw new Error('撤销没真的退步：' + JSON.stringify({ before: t4.ctx, after: t5.ctx }));

    /* 6) 换选用的那条候选（select_take） */
    const t6 = await turn('RUN: select_take {"take":2}');
    if (t6.refused) throw new Error('选片卡片没出来：' + t6.text);
    if (t6.ctx.选用 !== '第 2 条') throw new Error('助手换选用没生效：' + JSON.stringify(t6.ctx));

    /* 7) 导入 SRT（成片秒 → 候选源秒）+ 按字数重切 */
    const t7 = await turn('RUN: subtitle_import_srt {"take":2,"text":' + JSON.stringify(SRT) + '}');
    if (t7.refused) throw new Error('SRT 卡片没出来：' + t7.text);
    if (t7.ctx.字幕 !== 1) throw new Error('SRT 没导进来：' + JSON.stringify(t7.ctx));
    const srt = await page.eval(() => window.WBBridge.get('director').srt({}));
    if (!(srt.ok && srt.条数 === 1 && /助手导进来的一句/.test(srt.text))) throw new Error('SRT 导出对不上：' + JSON.stringify(srt));
    const t8 = await turn('RUN: subtitle_resegment {"take":2,"maxChars":4}');
    if (t8.refused) throw new Error('重切卡片没出来：' + t8.text);
    if (!(t8.ctx.字幕 >= 2)) throw new Error('按 4 字重切没切出多条：' + JSON.stringify(t8.ctx));

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 剪辑助手通过（11 个动作 / 9 个只读工具挂齐 · 只读不动工程 · 写字幕 · 过期修订号被拒 · 批量一条快照 · 非法批量整批拒 · 撤销 · 换选用 · SRT 往返 · 按字重切）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
})();
