#!/usr/bin/env node
/* 图片素材进画面轨的闭环：本机资产库的绿图经「生成工作台 → 导演台」的交接载荷落进画面轨，
   轨道上平铺缩略格、没有静音钮 / 波纹带 / 灰遮罩；右把手能**拖长**（越出格子也要改时长）；
   桥的五把剪子对图片段各走各的支路（切开 / 删成黑场并放回 / 融合被拒 / 两把切边被 0.2 秒闸拦）；
   空段插进来再摘掉。最后导出成片逐帧验色（红视频 + 静态绿图，三个时刻的像素账），
   再把 FCPXML 导出读回来：still 引用、start="0s"、没有 timeMap，导入后图片段按原时长落回。
   产品侧不用 ffmpeg：它只负责造输入（红视频 / 绿图）与最后对成片逐帧验色。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const h = require('./harness.cjs');

/* 下载目录里的成片 / FCPXML：Chrome 先落 .crdownload，跳过半成品。 */
function pickIn(dir, re) {
  let list = [];
  try { list = fs.readdirSync(dir).filter(f => re.test(f) && !/\.crdownload$/i.test(f)); } catch (e) { return ''; }
  if (!list.length) return '';
  const f = path.join(dir, list[list.length - 1]);
  return fs.existsSync(f) && fs.statSync(f).size > 0 ? f : '';
}

/* 对成片某一时刻取一帧，回 signalstats 的三个均值（Y/U/V）。
   `-ss` 放在 `-i` 之后 = 精确定位（六秒的片子慢不到哪里去），帧是平色，均值就是那一格的颜色。 */
function frameAvg(film, t) {
  const r = cp.spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', film,
    '-ss', String(t), '-frames:v', '1', '-vf', 'signalstats,metadata=print', '-f', 'null', '-'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = { Y: NaN, U: NaN, V: NaN };
  String(r.stderr || '').replace(/lavfi\.signalstats\.([YUV])AVG=([\d.]+)/g, (s, k, v) => { m[k] = Number(v); return s; });
  return m;
}

(async () => {
  if (!h.hasFfmpeg()) { console.log('- 跳过图片段闭环（本机没有 ffmpeg，造不出红视频 / 绿图 / 像素账；产品导出本身不用它）'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-imgtrack-'));
  /* 红色 3 秒输入视频（harness 的 makeClip 是 testsrc 花纹，验色要纯色就自己造）；
     绿色静态图（640x360 一帧）转 base64 直接存进本机资产库。 */
  const clip = path.join(work, 'red.mp4');
  cp.execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:size=128x72:rate=12:duration=3',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12',
    '-movflags', '+faststart', clip], { stdio: 'pipe' });
  const png = path.join(work, 'green.png');
  /* 纯绿用 0x00ff00：ffmpeg 的具名 green 是 HTML 的 #008000（半亮），像素账会当成「不够绿」。 */
  cp.execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x00ff00:size=640x360', '-frames:v', '1', png], { stdio: 'pipe' });
  const pngB64 = fs.readFileSync(png).toString('base64');
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
    const caps = await page.eval(() => window.Api.exportCaps());
    if (!caps || !caps.ok) {
      console.log('- 跳过图片段闭环（' + ((caps && caps.chip) || '没读到') + '）：这个浏览器导不了成片 —— ' + ((caps && caps.why) || '没给原因'));
      return;
    }

    /* 1) 导入红色 3 秒视频并选用（与用户点同一颗文件入口）。 */
    await page.setFile('#importMediaFile', clip);
    const okCand = () => {
      const c = window.WBBridge.get('director').context();
      return !!(c && c.候选 && c.候选.some(x => x.状态 === 'succeeded'));
    };
    await page.waitFor(okCand, 20000, 200).catch(async () => {
      await page.eval(() => { const f = document.getElementById('importMediaFile'); if (f) f.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitFor(okCand, 30000, 200);
    });
    const sel = await page.eval(async () => {
      const A = window.WBBridge.get('director');
      const hit = A.context().候选.find(x => x.状态 === 'succeeded');
      return A.run('select', { candId: hit.id, expectedRevision: A.context().revision });
    });
    if (!sel || !sel.ok) throw new Error('选用导入的红视频失败：' + JSON.stringify(sel));

    /* 候选条上点导入那条的瓦片 = 用户真实的对焦动作：导入只置 selId，不挪 curCand，
       而中栏 / 轨道 / 剪子的一切编辑都落在 curCand 那条上 —— 不点这一下，
       后面的交接与拖动会落进草稿占位、桥的「选用」剪的却是导入那条，两半对不上。 */
    await page.eval(() => {
      const A = window.WBBridge.get('director');
      const vid = A.context().候选.find(x => x.状态 === 'succeeded').id;
      const t = document.querySelector('#midCol .cand-thumb[data-vid="' + vid + '"]');
      if (!t) throw new Error('候选条上没有导入那条的瓦片：' + vid);
      t.click();
    });
    await page.waitFor(() => {
      const c = window.WBBridge.get('director').context();
      return !!(c && c.这一条 && c.这一条.段数 === 1 && Math.abs(c.这一条.段[0].out - 3) < 0.01);
    }, 8000, 200).catch(() => {
      throw new Error('候选没有对焦到导入那条（curCand 仍指草稿占位，全片长不是 3 秒）');
    });

    /* 2) 绿图存进本机资产库，再走「生成工作台 → 导演台」的交接载荷进画面轨。 */
    const hand = await page.eval(async b64 => {
      const saved = await window.Api.saveLocalAsset({
        name: '探针绿图.png', mime: 'image/png', format: 'png', data: b64,
        media_type: 'image', meta: { provider: '本机', prompt: '', importedFrom: '探针' },
      });
      const src = (saved && (saved.url || window.Api.assetSrc(saved.id))) || '';
      window.LS.setJson('dir_add_img', { src: src, name: '探针绿图' });
      window.GoPage.go('studio.html');
      return src;
    }, pngB64);
    if (!hand || hand.indexOf('/asset/') !== 0) throw new Error('绿图没存成本机资产：' + JSON.stringify(hand));
    await page.waitFor(() => location.hash.indexOf('studio') >= 0, 15000, 200);
    await page.eval(() => window.GoPage.go('director.html'));
    await page.waitFor(() => {
      const c = window.WBBridge.get('director').context();
      return !!(c && c.这一条 && c.这一条.段数 === 2);
    }, 20000, 200);
    const ctx0 = await page.eval(() => ({
      ctx: window.WBBridge.get('director').context(),
      leftKey: window.LS.json('dir_add_img'),
    }));
    if (ctx0.leftKey) throw new Error('交接载荷没被消费掉：' + JSON.stringify(ctx0.leftKey));
    const s0 = ctx0.ctx.这一条.段[0], s1 = ctx0.ctx.这一条.段[1];
    if (s0.黑场 || s0.音量 !== '100%') throw new Error('第一段不是完整的视频段：' + JSON.stringify(s0));
    if (!(s1.in > 3.05) || Math.abs((s1.out - s1.in) - 2) > 0.01) throw new Error('图片段没按虚拟坐标落在视频之后（默认 2 秒）：' + JSON.stringify(s1));
    if (s1.音量 !== '0%' || s1.黑场) throw new Error('图片段应是静音（0%）且不是黑场：' + JSON.stringify(s1));

    /* 3) 剪辑模式的 DOM：图片格平铺、没有静音钮 / 波纹，行高与视频格一致；两格都不再画框内遮挡。 */
    await page.eval(() => document.getElementById('trimBtn').click());
    await page.waitFor(() => !!document.querySelector('#tlBar .tl-seg[data-seg="1"]'), 10000, 200);
    const dom = await page.eval(() => {
      const img = document.querySelector('#tlBar .tl-seg[data-seg="1"]');
      const vid = document.querySelector('#tlBar .tl-seg[data-seg="0"]');
      const q = (root, sel) => root.querySelector(sel);
      return {
        name: q(img, '.lab-name').textContent,
        dur: q(img, '.lab-dur').textContent,
        /* 与页面同一把尺子：Wb 没加载时界面回退成「2s」这种裸读数。 */
        durRef: (window.Wb && window.Wb.fmtClock) ? window.Wb.fmtClock(2) : '2s',
        tiles: img.querySelectorAll('.frs i.fr').length,
        hasDataFrs: !!img.querySelector('[data-frs]'),
        cutL: !!q(img, '.cut[data-edge="l"]'), cutR: !!q(img, '.cut[data-edge="r"]'),
        mute: !!q(img, '.mute'), canvas: !!q(img, 'canvas'), vol: !!q(img, '.wv-vol'),
        mask: !!q(img, '.mask'), wvNone: q(img, '.wv-none') ? q(img, '.wv-none').textContent : '',
        vidMute: !!q(vid, '.mute'), vidCanvas: !!q(vid, 'canvas[data-wv]'), vidMask: !!q(vid, '.mask'),
        imgWvH: q(img, '.wv-box').clientHeight, vidWvH: q(vid, '.wv-box').clientHeight,
      };
    });
    if (dom.name.indexOf('探针绿图') < 0 || dom.name.indexOf('第 2 段') < 0) throw new Error('图片格名称行不对：' + dom.name);
    if (dom.dur !== dom.durRef) throw new Error('图片格时长读数不对：' + dom.dur + ' vs ' + dom.durRef);
    if (!(dom.tiles > 1)) throw new Error('图片格没有平铺缩略格（>84px 宽应不止一格）：' + dom.tiles);
    if (dom.hasDataFrs) throw new Error('图片格不该带 data-frs（fillSlices 会去解码取帧）');
    if (!dom.cutL || !dom.cutR) throw new Error('图片格两端没有拖动把手');
    if (dom.mute || dom.canvas || dom.vol) throw new Error('图片格不该有静音钮 / 波纹 canvas / 音量条');
    if (dom.wvNone.indexOf('静态图') < 0) throw new Error('图片格下带没说明「静态图 · 没有原声」：' + dom.wvNone);
    if (!dom.vidMute || !dom.vidCanvas) throw new Error('视频格该有的静音钮 / 波纹缺了');
    /* 剪掉的头尾不占轨道上的秒，也不再画成遮挡：两格都不该有 `.mask` 那一层（视频 / 图片都一样） */
    if (dom.mask || dom.vidMask) throw new Error('格子里画出了遮挡层 —— 格子画的就是选区，剪掉的头尾根本不进这一排');
    if (dom.imgWvH !== dom.vidWvH) throw new Error('两格的下带高度错位：' + dom.imgWvH + ' vs ' + dom.vidWvH);

    /* 4) 右把手拖长图片段：指针拖出格子右沿 150px —— 比例不夹 0–1，越界由图片支自己的边界把住。 */
    const drag = await page.eval(w => {
      const A = window.WBBridge.get('director');
      const cell = document.querySelector('#tlBar .tl-seg[data-seg="1"]');
      const r = cell.getBoundingClientRect();
      const cut = cell.querySelector('.cut[data-edge="r"]');
      const seg = A.context().这一条.段[1];
      const a0 = seg.in, b0 = seg.out, wpx = r.width;
      const opts = x => ({ bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1,
        clientX: x, clientY: r.top + r.height / 2 });
      cut.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width / 2)));
      window.dispatchEvent(new PointerEvent('pointermove', opts(r.right + w)));
      window.dispatchEvent(new PointerEvent('pointerup', opts(r.right + w)));
      return { a0: a0, b0: b0, wpx: wpx };
    }, 150);
    const expect = (drag.b0 - drag.a0) * (1 + 150 / Math.max(1, drag.wpx));
    await page.waitFor(() => {
      const s = window.WBBridge.get('director').context().这一条.段[1];
      return s && (s.out - s.in) > 2.05;
    }, 8000, 200);
    const after = await page.eval(() => window.WBBridge.get('director').context().这一条.段[1]);
    if (Math.abs((after.out - after.in) - expect) > 0.15) {
      throw new Error('拖长后的时长不对：' + (after.out - after.in) + '，期望约 ' + expect.toFixed(2));
    }
    if (after.in !== drag.a0) throw new Error('拖右把手不该动左沿：' + JSON.stringify(after));

    /* 5) 桥的五把剪子：图片段各支路 + 空段插进来再摘掉（gap / close 只在界面上有入口）。 */
    const cuts = await page.eval(async () => {
      const A = window.WBBridge.get('director');
      const rev = () => A.context().revision;
      const segs = () => A.context().这一条.段;
      const out = {};
      out.mergeRefused = await A.check('cut', { way: 'merge', seg: 2, expectedRevision: rev() });
      out.split = await A.run('cut', { way: 'split', at: 3.6, expectedRevision: rev() });
      out.threeSegs = segs();
      out.rightTooClose = await A.run('cut', { way: 'right', at: 3.15, expectedRevision: rev() });
      out.left = await A.run('cut', { way: 'left', at: 3.3, expectedRevision: rev() });
      out.afterLeft = segs();
      out.drop = await A.run('cut', { way: 'drop', seg: 2, expectedRevision: rev() });
      out.gray = segs();
      out.back = await A.run('cut', { way: 'drop', seg: 2, expectedRevision: rev() });
      out.restored = segs();
      return out;
    });
    if (!cuts.mergeRefused || cuts.mergeRefused.ok !== false || String(cuts.mergeRefused.err || '').indexOf('图片段不合并') < 0) {
      throw new Error('融合图片段没被拒：' + JSON.stringify(cuts.mergeRefused));
    }
    if (!cuts.split.ok) throw new Error('切开图片段失败：' + JSON.stringify(cuts.split));
    if (cuts.threeSegs.length !== 3) throw new Error('切开后应三段：' + JSON.stringify(cuts.threeSegs.map(s => [s.in, s.out])));
    const half1 = cuts.threeSegs[1], tail = cuts.threeSegs[2];
    if (Math.abs((half1.out - half1.in) - 0.5) > 0.01 || !(tail.in > half1.out + 0.05)) {
      throw new Error('切开后的两半不对：' + JSON.stringify(cuts.threeSegs.map(s => [s.in, s.out])));
    }
    if (!cuts.rightTooClose || cuts.rightTooClose.ok !== false || String(cuts.rightTooClose.err || '').indexOf('0.2 秒') < 0) {
      throw new Error('离边界不到 0.2 秒没被拦：' + JSON.stringify(cuts.rightTooClose));
    }
    if (!cuts.left.ok) throw new Error('切掉左边失败：' + JSON.stringify(cuts.left));
    if (Math.abs((cuts.afterLeft[1].out - cuts.afterLeft[1].in) - 0.3) > 0.01
      || Math.abs(cuts.afterLeft[1].in - 3.3) > 0.01) {
      throw new Error('左切后的图片段不对：' + JSON.stringify(cuts.afterLeft.map(s => [s.in, s.out])));
    }
    if (!cuts.drop.ok) throw new Error('删成黑场失败：' + JSON.stringify(cuts.drop));
    if (!cuts.gray[1].黑场) throw new Error('删掉后这一段该是黑场：' + JSON.stringify(cuts.gray[1]));
    if (Math.abs((cuts.gray[1].out - cuts.gray[1].in) - 0.3) > 0.01) throw new Error('黑场的时长不该变：' + JSON.stringify(cuts.gray[1]));
    if (!cuts.back.ok || cuts.restored[1].黑场) throw new Error('再点一次没把画面放回来：' + JSON.stringify(cuts.restored[1]));

    /* 6) 空段（gap）从界面插进来，再「摘掉空段」整段去掉。 */
    await page.eval(() => document.querySelector('#tlTools [data-cut="gap"]').click());
    await page.waitFor(() => window.WBBridge.get('director').context().这一条.段数 === 4, 8000, 200);
    const gapCtx = await page.eval(() => ({
      segs: window.WBBridge.get('director').context().这一条.段,
      gapName: (document.querySelector('#tlBar .tl-seg[data-seg="2"] .lab-name') || {}).textContent || '',
    }));
    if (!gapCtx.segs[2].黑场 || Math.abs((gapCtx.segs[2].out - gapCtx.segs[2].in) - 1) > 0.01) {
      throw new Error('插进来的空段该是 1 秒黑场：' + JSON.stringify(gapCtx.segs.map(s => [s.in, s.out, s.黑场])));
    }
    if (gapCtx.gapName.indexOf('空段') < 0) throw new Error('空段的名称行没写「空段」：' + gapCtx.gapName);
    await page.waitFor(() => {
      const b = document.querySelector('#tlTools [data-cut="close"]');
      return !!b && !b.hidden;
    }, 8000, 200);
    await page.eval(() => document.querySelector('#tlTools [data-cut="close"]').click());
    await page.waitFor(() => window.WBBridge.get('director').context().这一条.段数 === 3, 8000, 200);
    const finalSegs = await page.eval(() => window.WBBridge.get('director').context().这一条.段);
    if (finalSegs.some(s => s.黑场)) throw new Error('摘掉空段后不该还剩黑场：' + JSON.stringify(finalSegs.map(s => [s.in, s.out, s.黑场])));

    /* 7) 导出成片：3 段（视频 3s + 左半张图 0.3s + 拖长后的右半张），回执说「取帧：静态图」。 */
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
    if (!fin.条数 || fin.条数.段 !== 3) throw new Error('导出回执段数不对：' + JSON.stringify(fin.条数));
    const opState = await page.eval(() => (document.getElementById('opState') || {}).textContent || '');
    /* 取帧档是逐段解出来的清单（如「取帧：顺序解 / 静态图」）：静态图必须在这一档里点过名。 */
    if (opState.indexOf('取帧') < 0 || opState.indexOf('静态图') < 0) throw new Error('成片回执没说图片段走了静态图取帧：' + opState);
    let filmPath = '';
    const dlUntil = Date.now() + 20000;
    while (Date.now() < dlUntil) {
      filmPath = pickIn(dlDir, /\.mp4$/i);
      if (filmPath) break;
      await h.sleep(250);
    }
    if (!filmPath) throw new Error('下载目录里没有成片（等 20 秒）：' + dlDir);
    if (path.basename(filmPath) !== fin.文件) throw new Error('下载文件名与导出回执对不上：' + path.basename(filmPath) + ' vs ' + fin.文件);

    /* 8) 像素账：t=1.0 是红视频；t=3.1 / 4.5 都落在静态图上 —— 都是纯绿，且两帧一模一样（不动）。 */
    const red = frameAvg(filmPath, 1.0);
    const g1 = frameAvg(filmPath, 3.1);
    const g2 = frameAvg(filmPath, 4.5);
    if (!(red.Y < 100 && red.V > 160)) throw new Error('t=1.0 不是红视频：' + JSON.stringify(red));
    if (!(g1.Y > 110 && g1.V < 110 && g1.U < 115)) throw new Error('t=3.1 不是静态绿图：' + JSON.stringify(g1));
    if (!(g2.Y > 110 && g2.V < 110 && g2.U < 115)) throw new Error('t=4.5 不是静态绿图：' + JSON.stringify(g2));
    const drift = Math.max(Math.abs(g1.Y - g2.Y), Math.abs(g1.U - g2.U), Math.abs(g1.V - g2.V));
    if (drift > 3) throw new Error('静态图两帧不一样（成片里图动了）：' + JSON.stringify({ g1, g2 }));
    if (Math.abs(red.Y - g1.Y) < 30) throw new Error('红与绿没分开（取帧可能没落到图片段上）：' + JSON.stringify({ red, g1 }));

    /* 9) FCPXML 导出：still 引用（hasVideo 没有 hasAudio）、start="0s"、没有 timeMap。 */
    const shotIdBefore = await page.eval(() => window.WBBridge.get('director').context().镜头id);
    const fcpStart = await page.eval(() => window.WBBridge.get('director').exportNow({ format: 'fcpxml' }));
    if (!fcpStart.ok || !fcpStart.jobId) throw new Error('FCPXML 导出没起来：' + JSON.stringify(fcpStart));
    let fcpFin = null;
    const fcpUntil = Date.now() + 30000;
    while (Date.now() < fcpUntil) {
      fcpFin = await page.eval(() => window.WBBridge.get('director').exportStatus({ jobId: JSON.parse(localStorage.getItem('__probeJob') || 'null') }));
      if (fcpFin && fcpFin.state && fcpFin.state !== 'running') break;
      await h.sleep(300);
    }
    if (!fcpFin || fcpFin.state !== 'done') throw new Error('FCPXML 导出没跑完：' + JSON.stringify(fcpFin));
    let fcpPath = '';
    const fcpDl = Date.now() + 20000;
    while (Date.now() < fcpDl) {
      fcpPath = pickIn(dlDir, /\.fcpxml$/i);
      if (fcpPath) break;
      await h.sleep(250);
    }
    if (!fcpPath) throw new Error('下载目录里没有 FCPXML（等 20 秒）：' + dlDir);
    const xml = fs.readFileSync(fcpPath, 'utf8');
    /* 视频素材也带 hasVideo="1"：still 的特征是 hasVideo 有、hasAudio 没有。 */
    const stillAssets = (xml.match(/<asset\b[^>]*>/g) || []).filter(t => t.indexOf('hasVideo="1"') >= 0 && t.indexOf('hasAudio') < 0);
    if (!stillAssets.length) throw new Error('FCPXML 里没有 still 引用的 asset');
    if (stillAssets.some(t => t.indexOf('hasAudio') >= 0)) throw new Error('still asset 不该带 hasAudio：' + stillAssets.join(' | '));
    if (xml.indexOf('start="0s"') < 0) throw new Error('still 的 asset-clip 该写 start="0s"');
    if (xml.indexOf('<timeMap') >= 0) throw new Error('全片没有变速段，不该出现 timeMap');
    /* 单文件 FCPXML 的 still 引用写的是 assets 目录里的真实文件（file:///…/la_xxx.png），
       不是 /asset/ 地址 —— 认本机资产号 la_xxx 本身。 */
    const laId = hand.split('/').pop();
    if (xml.indexOf(laId) < 0) throw new Error('still 的本机资产号没写进 media-rep：' + laId);

    /* 10) 读回来：导入这份 FCPXML 开成一份新短片，两张静态图按原时长落回图片段。 */
    await page.setFile('#importFcpFile', fcpPath);
    await page.waitFor(v => window.WBBridge.get('director').context().镜头id !== v, 20000, 200, shotIdBefore);
    const roundState = await page.eval(() => ({
      state: (document.getElementById('opState') || {}).textContent || '',
    }));
    if (roundState.state.indexOf('2 段图片') < 0) throw new Error('导入回执没说两张静态图（也不能把一张数成两遍）：' + roundState.state);
    /* 只认导入的那一份（note 由导入统一写）：当前工程的段列表里也有图片段，不能拿来充数。 */
    const ws = await page.eval(async () => {
      for (let i = 0; i < 40; i++) {
        const rec = await window.Kv.at('ws').get('workspace');
        const hit = (rec && rec.projects || []).find(p => (p.scenes || []).some(sc => (sc.shots || [])
          .some(sh => sh.note === 'FCPXML 导入' && (sh.candidates || []).some(c => (c.segs || []).some(s => s.img)))));
        if (hit) return hit;
        await new Promise(r => setTimeout(r, 150));
      }
      return null;
    });
    if (!ws) throw new Error('导入后的短片没进工作区（或图片段没落成 img 段）');
    const stills = [];
    (ws.scenes || []).forEach(sc => (sc.shots || []).forEach(sh => (sh.candidates || []).forEach(c => (c.segs || []).forEach(s => {
      if (s.img) stills.push({ dur: round1(s.out - s.in), name: s.imgName || '', src: s.img });
    }))));
    if (stills.length !== 2) throw new Error('读回的图片段该是两张：' + JSON.stringify(stills));
    stills.forEach(s => {
      if (s.name !== '探针绿图') throw new Error('图片段名字丢了：' + JSON.stringify(s));
      if (String(s.src).indexOf(laId) < 0) throw new Error('图片地址没认回本机资产：' + JSON.stringify(s));
    });
    const durs = stills.map(s => s.dur).sort((a, b) => a - b);
    /* 右半张的时长跟着第 4 步的拖动走：切在 3.6，右半张 = 拖长后的出点 − 3.6。 */
    const tailDur = Math.round((after.out - 3.6) * 10) / 10;
    if (Math.abs(durs[0] - 0.3) > 0.01 || Math.abs(durs[1] - tailDur) > 0.05) {
      throw new Error('两张图片段的时长没按成片秒读回来：' + JSON.stringify(durs) + '，右半张期望约 ' + tailDur);
    }

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    const faults = h.logFaults(proxy.log);
    if (faults.length) throw new Error('代理故障：' + faults.slice(0, 3).join(' | '));
    console.log('✓ 图片段闭环：交接载荷入轨 · 平铺格与三不带 · 右把手拖长 · 五把剪子各支路 · 空段插摘 · 成片像素账 · FCPXML still 读回');
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

function round1(n) { return Math.round(Number(n) * 10) / 10; }
