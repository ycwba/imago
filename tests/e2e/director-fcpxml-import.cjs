#!/usr/bin/env node
/* 导演台 FCPXML 导入（页头收口后的唯一「导入」入口）：
   · 页头不再有「导入文件 / 资产库 / 导入项目 / 导出项目」与尺寸下拉，只剩「导入 FCPXML」；
   · 真的从文件入口导入一份 FCPXML：镜头顺序、入出点、倍速、黑场、台词、配音位置都读得回来；
   · 导入的是一份新短片，写进工作区（IndexedDB）而不是覆盖当前工程。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./harness.cjs');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080"/>
    <asset id="a1" name="clip-one" start="0s" duration="20s" format="r1">
      <media-rep kind="original-media" src="/asset/la_probe1.mp4"/>
    </asset>
    <asset id="a2" name="voice-one" start="0s" duration="20s">
      <media-rep kind="original-media" src="/asset/la_probe_voice.mp3"/>
    </asset>
  </resources>
  <library>
    <event name="导入探针">
      <project name="导入探针">
        <sequence format="r1" duration="7s" tcStart="0s" tcFormat="NDF">
          <spine>
            <asset-clip ref="a1" name="第一段" offset="0s" start="2s" duration="3s">
              <timeMap>
                <timept time="0s" value="0s" interp="linear"/>
                <timept time="3s" value="6s" interp="linear"/>
              </timeMap>
              <asset-clip ref="a2" lane="-1" name="第一句配音" offset="0.5s" start="0s" duration="1.5s" audioRole="dialogue">
                <timeMap>
                  <timept time="0s" value="0s" interp="linear"/>
                  <timept time="1.5s" value="3s" interp="linear"/>
                </timeMap>
              </asset-clip>
              <title name="字幕" offset="0s" duration="3s"><text><text-style>第一句字幕</text-style></text></title>
            </asset-clip>
            <gap name="空档" offset="3s" duration="2s"/>
            <asset-clip ref="a1" name="第二段" offset="5s" start="10s" duration="2s"/>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-fcpimport-'));
  const file = path.join(work, 'import-probe.fcpxml');
  fs.writeFileSync(file, XML, 'utf8');
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => !!(window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready()), 25000);

    const header = await page.eval(() => ({
      fcpBtn: !!document.getElementById('importFcpBtn'),
      fcpFile: !!document.getElementById('importFcpFile'),
      gone: ['importMediaBtn', 'assetLibBtn', 'importBtn', 'exportBtn', 'compRatio']
        .filter(id => !!document.getElementById(id)),
    }));
    if (!header.fcpBtn || !header.fcpFile) throw new Error('页头没有「导入 FCPXML」入口');
    if (header.gone.length) throw new Error('用户要求去掉的页头控件还在：' + header.gone.join('、'));

    await page.setFile('#importFcpFile', file);
    await page.waitFor(() => {
      const c = window.WBBridge.get('director').context();
      return c && c.项目 === '导入探针';
    }, 20000);

    const ctx = await page.eval(() => window.WBBridge.get('director').context());
    if (ctx.镜头 !== '第一段') throw new Error('导入后停在的不是第一段：' + ctx.镜头);
    if (!ctx.这一条 || ctx.这一条.段数 !== 1) throw new Error('第一段没有读成一段：' + JSON.stringify(ctx.这一条));
    const seg = ctx.这一条.段[0];
    if (seg.in !== 2 || seg.out !== 8) throw new Error('入出点没读回来：' + JSON.stringify(seg));
    if (seg.倍速 !== 2) throw new Error('倍速没从 timeMap 读回来：' + JSON.stringify(seg));
    if (ctx.字幕.条数 !== 1) throw new Error('字幕没读成台词：' + JSON.stringify(ctx.字幕));

    /* 工作区里核对三镜顺序、黑场与配音锚点（源秒）。 */
    const ws = await page.eval(async () => {
      for (let i = 0; i < 40; i++) {
        const rec = await window.Kv.at('ws').get('workspace');
        const p = rec && (rec.projects || []).find(x => x.name === '导入探针');
        if (p) return { name: p.name, shots: p.scenes[0].shots, voices: p.voices || [], composition: p.composition || null };
        await new Promise(r => setTimeout(r, 150));
      }
      return null;
    });
    if (!ws) throw new Error('导入后的短片没写进工作区');
    const shots = ws.shots || [];
    if (shots.length !== 3) throw new Error('应导入 3 段（两段画面 + 一段黑场），实际：' + shots.length);
    if (shots[1].name !== '空档') throw new Error('中间那段黑场丢了：' + shots[1].name);
    const g = shots[1].candidates[0];
    const gs = g && g.segs && g.segs[0];
    if (!gs || gs.in !== 0 || gs.out !== 2 || !gs.off) throw new Error('黑场应是一段 2 秒的灰块：' + JSON.stringify(gs));
    if (shots[0].line !== '第一句字幕') throw new Error('第一段台词没读回来：' + shots[0].line);
    if (shots[0].candidates[0].url !== '/asset/la_probe1?v=2') throw new Error('本机素材地址没认回来：' + shots[0].candidates[0].url);
    if (ws.voices.length !== 1) throw new Error('配音条数不对：' + ws.voices.length);
    const v = ws.voices[0];
    if (v.shotId !== shots[0].id || v.seg !== 0) throw new Error('配音没锚在第一段：' + JSON.stringify(v));
    if (v.at !== 1) throw new Error('配音在成片里的位置应按画面倍速折算成源秒 1：' + v.at);
    if (v.dur !== 3 || v.off !== 0) throw new Error('配音源长/入点不对：' + JSON.stringify(v));
    if (v.src !== '/asset/la_probe_voice?v=2') throw new Error('配音地址没认回来：' + v.src);
    if (!ws.composition || ws.composition.width !== 1920 || ws.composition.height !== 1080) {
      throw new Error('画幅没从 <format> 带进来：' + JSON.stringify(ws.composition));
    }

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    console.log('✓ FCPXML 导入：页头只留这一颗 · 入出点/倍速/黑场/台词/配音锚点/画幅全部读回');
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
