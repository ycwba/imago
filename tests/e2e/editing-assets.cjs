#!/usr/bin/env node
/* 剪辑闭环：导入本机视频 → 入轨 → 剪 → 改倍速 → 写字幕 → 导出成片 →
   存进资产库，全程在同一个页面里跑完，不换页、不刷新。
   需要 ffmpeg（导出那一步）；没有就跳过并报明。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./harness.cjs');

(async () => {
  if (!h.hasFfmpeg()) { console.log('- 跳过剪辑闭环（本机没有 ffmpeg，导出那一步跑不了）'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-edit-'));
  const clip = h.makeClip(work);
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(work, 'dl') });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);

    /* 导入：把一段真视频塞进「导入本地视频」那颗文件选择器（与用户点同一颗）。 */
    await page.setFile('#importMediaFile', clip);
    /* 导入完的那一条状态是 succeeded；镜头本身可能先带一条 draft 占位，所以判据要认状态。 */
    const okCand = () => {
      const c = window.WBBridge.get('director').context();
      return !!(c && c.候选 && c.候选.some(x => x.状态 === 'succeeded'));
    };
    await page.waitFor(okCand, 20000, 200).catch(async () => {
      await page.eval(() => { const f = document.getElementById('importMediaFile'); if (f) f.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitFor(okCand, 30000, 200);
    });

    const before = await page.eval(async () => {
      window.__noReloadMark = (window.__noReloadMark || 0) + 1;
      const A = window.WBBridge.get('director');
      const c0 = A.context();
      const hit = (c0.候选 || []).find(x => x.状态 === 'succeeded');
      if (!hit) return { err: '没有导入成功的候选' };
      const sel = await A.run('select', { candId: hit.id, expectedRevision: c0.revision });
      const c = A.context();
      return { vid: hit.id, 候选: (c.候选 || []).length, sel, 选用: c.选用,
        总秒: c.这一条 && c.这一条.总秒, 段数: c.这一条 && c.这一条.段数, revision: c.revision, hash: location.hash };
    });
    if (before.err) throw new Error(JSON.stringify(before));
    if (!before.sel.ok) throw new Error('选用导入的那一条失败：' + JSON.stringify(before.sel));
    if (!(before.总秒 > 1.5)) throw new Error('候选时长没读到真实视频秒数（应是 2 秒）：' + JSON.stringify(before));
    if (before.段数 !== 1) throw new Error('新导入的候选应该是整段：' + JSON.stringify(before));

    /* 剪 → 倍速 → 字幕：全部走唯一写入桥，写动作带 expectedRevision。 */
    const steps = await page.eval(async vid => {
      const A = window.WBBridge.get('director');
      const rev = () => A.context().revision;
      const cut = await A.run('cut', { candId: vid, way: 'split', at: 1.0, expectedRevision: rev() });
      const set = await A.run('set', { candId: vid, seg: 2, speed: 2, expectedRevision: rev() });
      const sub = await A.run('set', { kind: 'subtitle', candId: vid,
        entries: [{ index: 1, startMs: 200, endMs: 900, text: '探针字幕一句' }], expectedRevision: rev() });
      const bad = await A.check('cut', { candId: vid, way: 'split', at: 0.5, expectedRevision: rev() + 77 });
      const c = A.context();
      return { cut, set, sub, bad, 段数: c.这一条 && c.这一条.段数, 成片秒: c.这一条 && c.这一条.成片秒,
        字幕: c.字幕, revision: c.revision, 可撤销: c.可撤销 };
    }, before.vid);
    if (!steps.cut.ok) throw new Error('剪切失败：' + JSON.stringify(steps.cut));
    if (!steps.set.ok) throw new Error('改倍速失败：' + JSON.stringify(steps.set));
    if (!steps.sub.ok) throw new Error('写字幕失败：' + JSON.stringify(steps.sub));
    if (steps.段数 !== 2) throw new Error('剪完应该是两段：' + JSON.stringify(steps.段数));
    if (!(steps.成片秒 > 1.4 && steps.成片秒 < 1.7)) throw new Error('第二段 2 倍速没落到成片秒上（应约 1.5 秒）：' + steps.成片秒);
    if (!(steps.sub.subtitleCount === 1)) throw new Error('字幕回执条数不对：' + JSON.stringify(steps.sub));
    if (steps.bad && steps.bad.code !== 'revision_mismatch') throw new Error('过期修订号没被拒：' + JSON.stringify(steps.bad));
    if (!(steps.可撤销 >= 3)) throw new Error('三次写入至少压了三个撤销快照：' + steps.可撤销);

    /* 导出成片（助手入口 = 页面同一套导出函数），把字幕一起烧进去。 */
    const started = await page.eval(() => window.WBBridge.get('director').exportNow({ format: 'film' }));
    if (!started.ok || !started.jobId) throw new Error('导出没起来：' + JSON.stringify(started));
    await page.eval(j => localStorage.setItem('__probeJob', JSON.stringify(j)), started.jobId);
    let fin = null;
    const until = Date.now() + 180000;
    while (Date.now() < until) {
      fin = await page.eval(() => window.WBBridge.get('director').exportStatus({ jobId: JSON.parse(localStorage.getItem('__probeJob') || 'null') }));
      if (fin && fin.state && fin.state !== 'running') break;
      await h.sleep(1000);
    }
    if (!fin || fin.state !== 'done') throw new Error('导出没跑完：' + JSON.stringify(fin));
    if (!fin.条数 || !(fin.条数.字幕 >= 1)) throw new Error('导出回执里字幕条数缺失：' + JSON.stringify(fin.条数));

    /* 盘上那一份 + 下载 + 存进资产库 */
    const jobs = await fetch(proxy.base + '/render/jobs', { headers: { cookie: proxy.cookie } }).then(r => r.json());
    const done = (jobs.jobs || []).filter(j => j.state === 'done' && j.exists);
    if (!done.length) throw new Error('最近导出里没有已完成的成片：' + JSON.stringify((jobs.jobs || []).map(j => j.state)));
    const name = done[0].out;
    if (!fs.existsSync(path.join(proxy.renderDir, name))) throw new Error('成片不在探针的 RENDER_DIR 里：' + name);
    const dl = await fetch(proxy.base + done[0].url, { headers: { cookie: proxy.cookie } });
    const bytes = Buffer.from(await dl.arrayBuffer());
    if (bytes.length < 1024) throw new Error('下载到的成片是空的（' + bytes.length + ' 字节）');
    const saved = await page.eval(n => window.WBBridge.get('director').saveToAssets({ name: n, title: '探针成片' }), name);
    if (!saved.ok || !saved.id) throw new Error('存进资产库失败：' + JSON.stringify(saved));
    const la = await fetch(proxy.base + '/asset/' + encodeURIComponent(saved.id), { headers: { cookie: proxy.cookie } });
    if (la.status !== 200) throw new Error('刚存进资产库的那一份取不回来（HTTP ' + la.status + '）：' + saved.id);
    const laBytes = Buffer.from(await la.arrayBuffer());
    if (Math.abs(laBytes.length - bytes.length) > 512) {
      throw new Error('资产库里那份与成片字节数对不上：' + laBytes.length + ' vs ' + bytes.length);
    }

    const after = await page.eval(() => ({ mark: window.__noReloadMark || 0, hash: location.hash,
      引擎还在: !!(window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready()) }));
    if (after.mark !== 1) throw new Error('页面 reload 过（窗口标记丢了）：' + JSON.stringify(after));
    if (after.hash !== before.hash) throw new Error('地址变了：' + before.hash + ' → ' + after.hash);
    if (!after.引擎还在) throw new Error('剪辑引擎在导出过程中被拆掉');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));

    console.log('✓ 剪辑闭环通过（导入 2 秒本机视频 → 剪两段 → 第二段 2 倍速（成片 ' + steps.成片秒.toFixed(2) +
      ' 秒）→ 1 条字幕 → 导出烧字幕 → ' + Math.round(bytes.length / 1024) + 'KB 成片 → 存进资产库，全程同一页）');
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
