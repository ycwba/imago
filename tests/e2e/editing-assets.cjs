#!/usr/bin/env node
/* 剪辑闭环：导入本机视频 → 入轨 → 剪 → 改倍速 → 写字幕 → 导出成片 →
   存进资产库，全程在同一个页面里跑完，不换页、不刷新。
   成片在页面里逐帧合成（MediaExport / WebCodecs），产品侧不需要 ffmpeg；
   ffmpeg 只用来造这一段 2 秒的输入视频 —— 本机没有就跳过并报明，
   浏览器没有 H.264 编码器时同样跳过（成片导不出来，不是这一页坏了）。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./harness.cjs');

/* 下载目录里的成片：Chrome 先落 .crdownload，跳过半成品。 */
function pickFilm(dir) {
  let list = [];
  try { list = fs.readdirSync(dir).filter(f => /\.mp4$/i.test(f) && !/\.crdownload$/i.test(f)); } catch (e) { return ''; }
  if (!list.length) return '';
  const f = path.join(dir, list[list.length - 1]);
  return fs.existsSync(f) && fs.statSync(f).size > 0 ? f : '';
}

(async () => {
  if (!h.hasFfmpeg()) { console.log('- 跳过剪辑闭环（本机没有 ffmpeg，造不出这颗 2 秒的输入视频；产品导出本身不用它）'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-edit-'));
  const clip = h.makeClip(work);
  const dlDir = path.join(work, 'dl');
  fs.mkdirSync(dlDir);
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);

    /* 这个浏览器能不能出片，问的是页面自己那一份探测（设置页「成片环境」读同一处）。 */
    const caps = await page.eval(() => window.Api.exportCaps());
    if (!caps || !caps.ok) {
      console.log('- 跳过剪辑闭环（' + ((caps && caps.chip) || '没读到') + '）：这个浏览器导不了成片 —— ' + ((caps && caps.why) || '没给原因'));
      return;
    }

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
      /* 新桥按身份对账：check 记下这一次要动谁，run 再解析一遍对身份。 */
      const arg = { candId: hit.id };
      const k = A.check('select', arg);
      if (!k || k.ok === false) return { err: '选用候选没过校验：' + JSON.stringify(k) };
      const sel = A.run('select', arg);
      const c = A.context();
      const f = c.成片 || {};
      const seg0 = (f.段 || [])[0] || {};
      return { vid: hit.id, 候选: (c.候选 || []).length, sel, 选用: c.选用, clipId: seg0.id || '',
        总秒: f.总秒, 段数: f.段数, hash: location.hash };
    });
    if (before.err) throw new Error(JSON.stringify(before));
    if (!before.sel.ok) throw new Error('选用导入的那一条失败：' + JSON.stringify(before.sel));
    if (!(before.总秒 > 1.5)) throw new Error('候选时长没读到真实视频秒数（应是 2 秒）：' + JSON.stringify(before));
    if (before.段数 !== 1) throw new Error('新导入的候选应该是整段：' + JSON.stringify(before));
    if (!before.clipId) throw new Error('选用之后成片里没有那一段：' + JSON.stringify(before));

    /* 剪 → 倍速 → 字幕：全部走唯一写入桥（每一步先 check 再 run，凭据是块 id）。 */
    const steps = await page.eval(async clipId => {
      const A = window.WBBridge.get('director');
      const doIt = (op, arg) => {
        const k = A.check(op, arg);
        if (!k || k.ok === false) return { ok: false, err: (k && k.err) || 'check 没过' };
        return A.run(op, arg);
      };
      const cut = doIt('cut', { id: clipId, way: 'split', at: 1.0 });
      const seg2 = ((A.context().成片 || {}).段 || [])[1] || {};
      const set = doIt('set', { kind: 'clip', id: seg2.id, speed: 2 });
      const sub = doIt('set', { kind: 'subtitle',
        entries: [{ start: 0.2, end: 0.9, text: '探针字幕一句' }] });
      /* 反面：切点贴边（距段头 0.01 秒）必须在 check 阶段就被拒。 */
      const bad = A.check('cut', { id: clipId, way: 'split', at: 0.01 });
      const c = A.context();
      const f = c.成片 || {};
      return { cut, set, sub, bad, 段数: f.段数, 成片秒: f.总秒, 字幕: c.字幕, 可撤销: c.可撤销 };
    }, before.clipId);
    if (!steps.cut.ok) throw new Error('剪切失败：' + JSON.stringify(steps.cut));
    if (!steps.set.ok) throw new Error('改倍速失败：' + JSON.stringify(steps.set));
    if (!steps.sub.ok) throw new Error('写字幕失败：' + JSON.stringify(steps.sub));
    if (steps.段数 !== 2) throw new Error('剪完应该是两段：' + JSON.stringify(steps.段数));
    if (!(steps.成片秒 > 1.4 && steps.成片秒 < 1.7)) throw new Error('第二段 2 倍速没落到成片秒上（应约 1.5 秒）：' + steps.成片秒);
    if (!(steps.字幕 && steps.字幕.条数 === 1)) throw new Error('字幕条数不对：' + JSON.stringify(steps.字幕));
    if (!steps.bad || steps.bad.ok !== false) throw new Error('贴边的切点没在 check 阶段被拒：' + JSON.stringify(steps.bad));
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
    if (fin.条数.段 !== 2) throw new Error('导出回执里段数不对：' + JSON.stringify(fin.条数));
    if (!fin.文件) throw new Error('导出回执里没有文件名：' + JSON.stringify(fin));

    /* 盘上那份就是用户拿到的东西：成片走 Net.save 交给浏览器下载，没有服务端渲染目录。 */
    let filmPath = '';
    const dlUntil = Date.now() + 20000;
    while (Date.now() < dlUntil) {
      filmPath = pickFilm(dlDir);
      if (filmPath) break;
      await h.sleep(250);
    }
    if (!filmPath) throw new Error('浏览器下载目录里没有成片（等 20 秒）：' + dlDir);
    if (path.basename(filmPath) !== fin.文件) throw new Error('下载文件名与导出回执对不上：' + path.basename(filmPath) + ' vs ' + fin.文件);
    const filmBytes = fs.readFileSync(filmPath);
    if (filmBytes.length < 1024) throw new Error('下载到的成片是空的（' + filmBytes.length + ' 字节）');

    /* 同一份字节存进资产库：取回来要一模一样 —— 这一路只走会话缓存 + /local-assets，不经渲染目录。 */
    const saved = await page.eval(n => window.WBBridge.get('director').saveToAssets({ name: n, title: '探针成片' }), fin.文件);
    if (!saved.ok || !saved.id) throw new Error('存进资产库失败：' + JSON.stringify(saved));
    const la = await fetch(proxy.base + '/asset/' + encodeURIComponent(saved.id), { headers: { cookie: proxy.cookie } });
    if (la.status !== 200) throw new Error('刚存进资产库的那一份取不回来（HTTP ' + la.status + '）：' + saved.id);
    const laBytes = Buffer.from(await la.arrayBuffer());
    if (!laBytes.equals(filmBytes)) {
      throw new Error('资产库里那份与成片字节对不上：' + laBytes.length + ' vs ' + filmBytes.length + ' 字节');
    }

    const after = await page.eval(() => ({ mark: window.__noReloadMark || 0, hash: location.hash,
      引擎还在: !!(window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready()) }));
    if (after.mark !== 1) throw new Error('页面 reload 过（窗口标记丢了）：' + JSON.stringify(after));
    if (after.hash !== before.hash) throw new Error('地址变了：' + before.hash + ' → ' + after.hash);
    if (!after.引擎还在) throw new Error('剪辑引擎在导出过程中被拆掉');
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));

    console.log('✓ 剪辑闭环通过（导入 2 秒本机视频 → 剪两段 → 第二段 2 倍速（成片 ' + steps.成片秒.toFixed(2) +
      ' 秒）→ 1 条字幕 → 页面内合成并烧字幕 → ' + Math.round(filmBytes.length / 1024) +
      'KB 成片（浏览器下载）→ 存进资产库，全程同一页）');
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
