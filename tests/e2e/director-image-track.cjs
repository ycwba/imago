#!/usr/bin/env node
/* 图片素材进画面轨的闭环：本机资产库的绿图经「生成工作台 → 导演台」的交接载荷落进画面轨，
   轨道上平铺缩略格、没有静音钮 / 波纹带 / 灰遮罩；右把手能**拖长**（越出格子也要改时长）；
   桥的五把剪子对图片段各走各的支路（切开 / 删成黑场并放回 / 融合被拒 / 两把切边被 0.2 秒闸拦）；
   拖走一段原位自动空（并撤销回去）。最后导出成片逐帧验色（红视频 + 静态绿图，三个时刻的像素账），
   再导出 FCPXML 验 still 引用（读回判据随 FCPXML 导入入口一起撤了）。
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

    /* 3) 剪辑模式的 DOM：图片格平铺、没有静音钮 / 波纹（画面轨的波纹带已整条撤掉），
       名称与时长是盖在切片上的覆盖件。 */
    await page.eval(() => document.getElementById('trimBtn').click());
    await page.waitFor(() => !!document.querySelector('#tlBar .tl-seg[data-seg="1"]'), 10000, 200);
    const dom = await page.eval(() => {
      const img = document.querySelector('#tlBar .tl-seg[data-seg="1"]');
      const vid = document.querySelector('#tlBar .tl-seg[data-seg="0"]');
      const q = (root, sel) => root.querySelector(sel);
      return {
        name: q(img, '.seg-name').textContent,
        dur: q(img, '.seg-dur').textContent,
        /* 与页面同一把尺子：Wb 没加载时界面回退成「2s」这种裸读数。 */
        durRef: (window.Wb && window.Wb.fmtClock) ? window.Wb.fmtClock(2) : '2s',
        tiles: img.querySelectorAll('.frs i.fr').length,
        hasDataFrs: !!img.querySelector('[data-frs]'),
        cutL: !!q(img, '.cut[data-edge="l"]'), cutR: !!q(img, '.cut[data-edge="r"]'),
        mute: !!q(img, '.seg-mute'), canvas: !!q(img, 'canvas'), vol: !!q(img, '.wv-vol'),
        mask: !!q(img, '.mask'),
        vidMute: !!q(vid, '.seg-mute'), vidCanvas: !!q(vid, 'canvas[data-wv]'), vidMask: !!q(vid, '.mask'),
        imgWv: !!q(img, '.wv-box'), vidWv: !!q(vid, '.wv-box'),
      };
    });
    if (dom.name.indexOf('探针绿图') < 0) throw new Error('图片格名称覆盖件不对：' + dom.name);
    if (dom.dur !== dom.durRef) throw new Error('图片格时长读数不对：' + dom.dur + ' vs ' + dom.durRef);
    if (!(dom.tiles > 1)) throw new Error('图片格没有平铺缩略格（>84px 宽应不止一格）：' + dom.tiles);
    if (dom.hasDataFrs) throw new Error('图片格不该带 data-frs（fillSlices 会去解码取帧）');
    if (!dom.cutL || !dom.cutR) throw new Error('图片格两端没有拖动把手');
    if (dom.mute || dom.canvas || dom.vol) throw new Error('图片格不该有静音钮 / 波纹 canvas / 音量条');
    if (dom.imgWv) throw new Error('图片格不该再有波纹带（画面轨的波纹已撤）');
    if (dom.vidCanvas) throw new Error('视频格不该再画波纹 canvas（画面轨的波纹已撤）');
    if (!dom.vidMute) throw new Error('视频格该有的静音小钮缺了（盖在切片右上角那枚 .seg-mute）');
    /* 剪掉的头尾不占轨道上的秒，也不再画成遮挡：两格都不该有 `.mask` 那一层 */
    if (dom.mask || dom.vidMask) throw new Error('格子里画出了遮挡层 —— 格子画的就是选区，剪掉的头尾根本不进这一排');

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

    /* 5) 桥的五把剪子：图片段各支路（切开 / 切边 / 删成黑场并放回 / 融合被拒）。 */
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

    /* 6) 空段那一档不再有按钮入口：「空一段 / 摘掉空段」两颗必须不在工具条上
       （空段唯一的来处 = 把某一格左右拖走，engine 的 order 支；判据细节在 tests/director-gap.mjs）。 */
    const gapBtns = await page.eval(() => ({
      gap: !!document.querySelector('#tlTools [data-cut="gap"]'),
      close: !!document.querySelector('#tlTools [data-cut="close"]'),
      segName: (document.querySelector('#tlBar .tl-seg[data-seg="1"] .seg-name') || {}).textContent || '',
    }));
    if (gapBtns.gap || gapBtns.close) throw new Error('「空一段 / 摘掉空段」两颗按钮还在工具条上（已随拖走自动空撤掉）');
    if (gapBtns.segName.indexOf('探针绿图') < 0) throw new Error('图片格名称覆盖件丢了：' + gapBtns.segName);

    /* 6b) 拖走自动空：把左半张图（data-seg=1）横拖到最左 → 原位自动空出一段同长空段，
       别的段一个不挪；Ctrl+Z 撤销后段列表回到拖走之前（后面的导出账不变）。 */
    const dragAway = await page.eval(() => {
      const cell = document.querySelector('#tlBar .tl-seg[data-seg="1"]');
      const inner = document.getElementById('tlInner');
      if (!cell || !inner) return null;
      const r = cell.getBoundingClientRect(), b = inner.getBoundingClientRect();
      const opts = x => ({ bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1,
        clientX: x, clientY: r.top + r.height / 2 });
      cell.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + r.width / 2)));
      window.dispatchEvent(new PointerEvent('pointermove', opts(b.left + 4)));
      window.dispatchEvent(new PointerEvent('pointerup', opts(b.left + 4)));
      return true;
    });
    if (!dragAway) throw new Error('拖走手势没找到图片格');
    await page.waitFor(() => {
      const segs = window.WBBridge.get('director').context().这一条.段;
      return segs.length === 4 && segs.some(x => x.黑场);
    }, 8000, 200).catch(async () => {
      const diag = await page.eval(() => ({
        segs: window.WBBridge.get('director').context().这一条.段.map(x => [x.in, x.out, x.黑场]),
        errs: (window.__errSink || []),
      }));
      throw new Error('拖走后段数没变：' + JSON.stringify(diag) + ' | pageErrors: ' + (page.errors || []).slice(0, 3).join(' | '));
    });
    const away = await page.eval(() => window.WBBridge.get('director').context().这一条.段);
    /* 被拖走的左半张（0.3s）挪到最前；原位自动空出一段**同长**空段（虚拟坐标不丢）；其余段一个不挪。 */
    if (!(away[0].in > 3.05) || Math.abs((away[0].out - away[0].in) - 0.3) > 0.01) throw new Error('被拖走的图片段没到最前：' + JSON.stringify(away.map(x => [x.in, x.out])));
    const gapSeg = away.find(x => x.黑场);
    if (!gapSeg || Math.abs((gapSeg.out - gapSeg.in) - 0.3) > 0.01) throw new Error('原位自动空的时长不对：' + JSON.stringify(away.map(x => [x.in, x.out])));
    if (!(away.some(x => !x.黑场 && x.in === 0 && Math.abs((x.out - x.in) - 3) < 0.01))) throw new Error('视频段被动了：' + JSON.stringify(away.map(x => [x.in, x.out])));
    await page.eval(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); });
    await page.waitFor(() => window.WBBridge.get('director').context().这一条.段数 === 3, 8000, 200);

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

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    const faults = h.logFaults(proxy.log);
    if (faults.length) throw new Error('代理故障：' + faults.slice(0, 3).join(' | '));
    console.log('✓ 图片段闭环：交接载荷入轨 · 平铺格与三不带 · 右把手拖长 · 五把剪子各支路 · 拖走自动空并撤销 · 成片像素账 · FCPXML still 读回');
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
