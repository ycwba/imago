#!/usr/bin/env node
/* 本机账（local:/local-assets）的**平台归属**判据。用户报过两轮真故障：

     ① 账行 provider 注记缺失 / 是 'local'（盘对账补账、重绑、老数据）→ 整条挂给
        「读这张表的第一家」（注册表顺序里的 MiMo），拾帧产物写着「MiMo 语音合成」。
     ② 注记修正后按 upstream 域名认平台，但比对用了 URL.host（含端口）——
        拾帧取产物地址带 :9443（shizhenvideo.com:9443 ≠ shizhenvideo.com）永远失配 → 全落「本机」；
        且拾帧三档（视频 / 图片 / 音频）共用一个 base，同域命中只取第一家会把图片 / 音频档
        交给视频档的 id，provLabelFor 的档位守卫又把它降成「本机」。

   这一档用真实形状的账行（upstream 带 :9443 端口、注记 'local'）种进隔离账，真浏览器开工作台，
   验三件事：列表响应带 upstream；providerByUpstream 按域名 + 媒体档认出 shizhen；
   三张卡（h3_t2v 视频 / zimage_first_frame 图片 / tts_voice_design 音频）meta 平台名全是「拾帧」。
   控制台零错误。 */
'use strict';
const h = require('./harness.cjs');
const fs = require('fs');
const path = require('path');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let proxy, browser;
  const probeRoot = path.join(require('os').tmpdir(), 'imago-probe-attrib-' + Date.now());
  try {
    /* 种子先落盘再启代理：账表有内存缓存，启后再写会被空表盖住；
       rebuild.json 是「一次性重建」的标记 —— 没有它启动重建会把种子账当旧账整批清空。
       账行照真实形状种：provider 'local'（盘对账 / 重绑那一族）、upstream 带非默认端口。 */
    const dir = path.join(probeRoot, 'data', 'local-assets');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const rows = [
      { id: 'la_probe_v', provider: 'local', model: 'h3_t2v', media_type: '视频', format: 'MP4',
        upstream: 'https://shizhenvideo.com:9443/daipao/t/job-v/result', file: 'v.mp4', bytes: 1200000,
        created_at: now, sig: 'sig-probe-v', prompt: '' },
      { id: 'la_probe_i', provider: 'local', model: 'zimage_first_frame', media_type: '图片', format: 'PNG',
        upstream: 'https://shizhenvideo.com:9443/daipao/t/job-i/result', file: 'i.png', bytes: 1000000,
        created_at: now, sig: 'sig-probe-i', prompt: '' },
      { id: 'la_probe_a', provider: 'local', model: 'tts_voice_design', media_type: '音频', format: 'WAV',
        upstream: 'https://shizhenvideo.com:9443/daipao/t/job-a/result', file: 'a.wav', bytes: 150000,
        created_at: now, sig: 'sig-probe-a', prompt: '' },
    ];
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(rows));
    fs.writeFileSync(path.join(dir, 'rebuild.json'), JSON.stringify({ v: 2, at: now, trash: '', moved: 0, failed: 0, cleared: 0 }));

    proxy = await h.startProxy({ probeRoot, env: {
      HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', PROXY_OFF: '0',
    } });
    browser = await h.launchBrowser();
    const page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);

    /* ① 列表响应原样带 upstream（归属推断的唯一原料） */
    const data = await page.eval(async () => {
      const d = await (await fetch('/local-assets')).json();
      return (d.data || []).map(x => ({ model: x.model, provider: x.provider, upstream: x.upstream || '' }));
    });
    must(data.length === 3, '本机账列表应回 3 行（回 ' + data.length + ' 行）');
    must(data.every(x => x.upstream && /shizhenvideo\.com:9443/.test(x.upstream)), '列表行应带带端口的 upstream 原文');

    /* ② 帮手：域名 + 媒体档认平台 */
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(() => !!window.Api && !!window.Api.providerByUpstream, 20000);
    const byUp = await page.eval(() => window.Api.providerByUpstream('https://shizhenvideo.com:9443/x', 'image'));
    must(byUp === 'shizhen-image', '同域多档按媒体档挑那一家（image → shizhen-image，回 ' + JSON.stringify(byUp) + '）');
    const byUpV = await page.eval(() => window.Api.providerByUpstream('https://shizhenvideo.com:9443/x', 'video'));
    must(byUpV === 'shizhen', '视频档认出 shizhen（回 ' + JSON.stringify(byUpV) + '）');

    /* ③ 卡片显示：三档 meta 平台名全是「拾帧」（工作台 meta = provLabelFor） */
    await page.waitFor(() => document.querySelectorAll('.task').length >= 3, 30000).catch(() => {});
    await sleep(800);
    const metas = await page.eval(() => [...document.querySelectorAll('.task .meta2')].map(e => e.textContent));
    must(metas.length >= 3, '工作台应画出 3 张卡（画了 ' + metas.length + ' 张）');
    for (const model of ['h3_t2v', 'zimage_first_frame', 'tts_voice_design']) {
      const hit = metas.find(t => t.indexOf(model) >= 0);
      must(!!hit, '应有 ' + model + ' 的卡');
      must(/^拾帧 ·/.test(hit || ''), model + ' 的平台名应是「拾帧」（实际：' + (hit || '').slice(0, 30) + '）');
    }
    must(!(page.errors || []).length, '控制台零错误' + ((page.errors || []).length ? '（' + page.errors[0] + '）' : ''));

    console.log('本机账平台归属判据：' + n + '/' + n + ' 全绿');
  } catch (e) {
    console.error('✗ ' + (e && e.message || e));
    try { if (page && page.errors) console.error('页面异常：\n' + page.errors.join('\n')); } catch (e2) {}
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
    try { fs.rmSync(probeRoot, { recursive: true, force: true }); } catch (e) {}
    await sleep(200);
  }
})();
