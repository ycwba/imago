#!/usr/bin/env node
/* 切片自愈：本镜轨道的格子一旦解码失败（元数据 20 秒 / 定位 15 秒的超时、机器一时抢不到解码器），
   必须**自己**补回画面。轨道没有定时重画（engine 里没有 setInterval，轮询只在有任务时跑），
   所以一次失败若只压进一张长退避表，界面就是一直斜纹 —— 用户不动一下永远好不了。
   这一条先把取帧那层的 meta 换成「一律失败」（解码一定白跑），导入 → 选用 → 点进那一条候选的瓦片
   （轨道画的是「当前在看的那一条」，新导入的候选不会自己抢过焦点）→ 进剪辑模式，
   确认画面上确实留下占位，再把 meta 换回来，然后**一个界面都不碰**，等格子自己填回来。
   需要 ffmpeg（造一段真能解码的视频）；没有就跳过并报明。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./harness.cjs');

(async () => {
  if (!h.hasFfmpeg()) { console.log('- 跳过切片自愈（本机没有 ffmpeg，造不出可解码的视频）'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-slice-'));
  const clip = h.makeClip(work);
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    await page.eval(() => {
      window.__probeErrs = [];
      window.addEventListener('unhandledrejection', e => {
        window.__probeErrs.push('未处理的 reject：' + String((e.reason && e.reason.message) || e.reason));
      });
      return true;
    });

    /* 装闸：从导入之前就一律失败，保证缓存里一张帧都没有，剪辑模式那一排必定留占位。
       两条链的入口一并换掉：主链 `MediaBackend.frames`（mediabunny 批量取帧）与兜底
       `Wb.vframe.meta`（<video> 池第一步问元数据）—— 两链都能独立出图，只堵一条堵不死。 */
    const armed = await page.eval(() => {
      const V = window.Wb && window.Wb.vframe;
      if (!V || typeof V.meta !== 'function') return { err: '页面没有 Wb.vframe.meta，制造不出解码失败' };
      const M = window.MediaBackend;
      if (!M || typeof M.frames !== 'function') return { err: '页面没有 MediaBackend.frames，制造不出解码失败' };
      window.__realMeta = V.meta.bind(V);
      window.__realFrames = M.frames.bind(M);
      window.__sabHits = 0;
      V.meta = () => { window.__sabHits++; return Promise.reject(new Error('探针：这一阵解码一律失败')); };
      M.frames = () => { window.__sabHits++; return Promise.reject(new Error('探针：这一阵解码一律失败')); };
      return { ok: true };
    });
    if (armed.err) throw new Error(armed.err);

    await page.setFile('#importMediaFile', clip);
    const okCand = () => {
      const c = window.WBBridge.get('director').context();
      return !!(c && c.候选 && c.候选.some(x => x.状态 === 'succeeded'));
    };
    await page.waitFor(okCand, 20000, 200).catch(async () => {
      await page.eval(() => { const f = document.getElementById('importMediaFile'); if (f) f.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitFor(okCand, 30000, 200);
    });
    const imported = await page.eval(() => {
      const c = window.WBBridge.get('director').context();
      const hit = (c.候选 || []).find(x => x.状态 === 'succeeded');
      return hit ? hit.id : null;
    });
    if (!imported) throw new Error('导入之后没有「已出片」的候选');
    const sel = await page.eval(async id => {
      const A = window.WBBridge.get('director');
      const c = A.context();
      const r = await A.run('select', { candId: id, expectedRevision: c.revision });
      return { ok: r.ok !== false, why: r.text || r.err || JSON.stringify(r).slice(0, 160) };
    }, imported);
    if (!sel.ok) throw new Error('选用导入的那一条失败：' + sel.why);

    /* 轨道那一栏画的是「当前在看的那一条候选」（`proj.curCand`），新导入的候选不会自己抢焦点 ——
       点它那颗瓦片就是用户会做的动作，也是这一条要走的真实路径。 */
    const focus = await page.eval(id => {
      const t = [...document.querySelectorAll('.cand-thumb[data-vid]')].find(x => x.dataset.vid === id);
      if (!t) return { err: '候选条里找不到导入那一条的瓦片（data-vid=' + id + '）' };
      t.click();
      return { ok: true };
    }, imported);
    if (focus.err) throw new Error(focus.err);
    await page.waitFor(() => {
      const c = window.WBBridge.get('director').context();
      /* 桥的 waitFor 不额外传参（harness.cjs 的 waitFor 只有 fn/timeout/every），所以现读「已出片又选用」的那一条 */
      const row = (c.候选 || []).find(x => x.状态 === 'succeeded' && x.选用);
      return !!(row && row.当前);
    }, 10000, 200).catch(() => {
      throw new Error('点了瓦片也没把轨道焦点切到导入的那一条（这一条测不了自愈）');
    });

    /* 进剪辑模式（认状态再点：这颗开关是 toggle，开着时再点会关掉） */
    const trim = await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (!t) return { err: '导演台没有 #trimBtn 那颗剪辑开关' };
      if (!t.classList.contains('on')) t.click();
      return { ok: true };
    });
    if (trim.err) throw new Error(trim.err);

    const tiles = () => ({
      总: document.querySelectorAll('.tl-vrow i.fr').length,
      空: document.querySelectorAll('.tl-vrow i.fr.gap').length,
      满: document.querySelectorAll('.tl-vrow i.fr[style]').length,
    });
    await page.waitFor(() => document.querySelectorAll('.tl-vrow i.fr').length >= 1, 20000, 200).catch(() => {
      throw new Error('进了剪辑模式也没有本镜轨道的切片格子（这一条测不了自愈）');
    });
    /* 先要真留下占位：一格都没空就说明根本没解码过，自愈这条也就没被检验。 */
    await page.waitFor(() => document.querySelectorAll('.tl-vrow i.fr.gap').length >= 1, 20000, 200).catch(async () => {
      const d = await page.eval(id => {
        const c = window.WBBridge.get('director').context();
        const row = (c.候选 || []).find(x => x.id === id) || {};
        return { 闸被叫过: window.__sabHits, 闸还在: String(window.Wb.vframe.meta).slice(0, 24)
            + ' / frames=' + String(window.MediaBackend.frames).slice(0, 24),
          格子: document.querySelectorAll('.tl-vrow i.fr').length, 满: document.querySelectorAll('.tl-vrow i.fr[style]').length,
          暂停: String(window.__directorSlicePaused ? window.__directorSlicePaused() : '(没有这个口子)'),
          在看: c.当前候选, 这一条: row.状态 + ' / 选用=' + row.选用 + ' / 当前=' + row.当前,
          栏: [...document.querySelectorAll('.tl-vrow [data-frs]')].map(t => '[' + t.getAttribute('data-frs') + ']').join(' | ') };
      }, imported);
      throw new Error('解码闸装上了却没留下占位格子（一次失败都没发生，这一条测不到自愈）：' + JSON.stringify(d, null, 1));
    });
    const broken = await page.eval(tiles);
    const restored = await page.eval(() => {
      if (!window.__realMeta || !window.__realFrames) return { err: '没有装回解码入口的把手' };
      window.Wb.vframe.meta = window.__realMeta;
      window.MediaBackend.frames = window.__realFrames;
      delete window.__realMeta; delete window.__realFrames;
      return { ok: true };
    });
    if (restored.err) throw new Error(restored.err);

    /* 从这一刻起不点任何东西：只有那条退避到点的重排能把画面补回来。 */
    const t0 = Date.now();
    await page.waitFor(() => document.querySelectorAll('.tl-vrow i.fr.gap').length === 0
      && document.querySelectorAll('.tl-vrow i.fr[style]').length >= 1, 60000, 400).catch(() => {});
    const healed = await page.eval(tiles);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (healed.空) {
      throw new Error('解码失败之后过了 ' + secs + ' 秒还剩 ' + healed.空 + '/' + healed.总 +
        ' 格占位，画面没自己补回来（用户不动一下就一直是斜纹）');
    }
    if (!(healed.满 >= 1 && healed.满 === healed.总)) throw new Error('格子数量对不上：' + JSON.stringify(healed));
    const errs = await page.eval(() => (window.__probeErrs || []).slice(0, 3));
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));

    console.log('✓ 切片自愈通过（本机 2 秒视频 → ' + broken.空 + '/' + broken.总 +
      ' 格先留占位 → 换回解码器之后不点任何东西，' + secs + ' 秒自己填满 ' + healed.满 + '/' + healed.总 + '）');
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
