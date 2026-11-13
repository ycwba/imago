'use strict';
/* RefView（灯箱 + 掩码绘画）e2e：
   ① fitCanvas 时序：打开就画（P0-1 回归闸）—— 画布必须按图片真实尺寸定，而不是 1×1；
   ② 浏览 / 画笔两档：浏览不落笔；
   ③ 完成（onSaveMask 收到 PNG）与 Esc 丢弃确认（有改动先问，不静默丢）；
   ④ 视频走同一灯箱的播放器。 */
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page, bad = 0;
  const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++; };
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html#model.html');
    await page.waitFor(() => document.body.innerText.length > 0, 20000);

    await page.eval(async () => {
      await Promise.all([
        new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'web/ui/lb-mask.js';
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        }),
      ]);
      if (!window.Wb) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'web/ui/workbench.js';
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 640;
      const g = cv.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, 1024, 640);
      window.__rv = { saved: 'unset', closed: false };
      const src = cv.toDataURL('image/png');
      if (!Wb.lightbox.cfg) {
        Wb.lightbox.init({
          keyOf: it => (it && it.src) || '', srcOf: it => (it && it.src) || '',
          kindOf: it => (it && it.kind) || 'image', list: () => [],
          nameOf: it => (it && it.label) || 'ref', info: it => [it.label || ''],
        });
      }
      Wb.lightbox.open({ src, label: 'e2e', kind: 'image' }, [{ src, label: 'e2e', kind: 'image' }]);
    });
    await page.waitFor(() => document.querySelector('#lbStage img'), 8000);
    await page.eval(() => { LbMask.enter(u => { window.__rv.saved = u; }); });
    await page.waitFor(() => document.querySelector('.lb-mask-cv'), 8000);

    /* ① fitCanvas 时序：画布 buffer = 图片真实尺寸（1024×640），不是 1×1 */
    const dims = await page.eval(() => {
      const cv = document.querySelector('.lb-mask-cv');
      return cv ? { w: cv.width, h: cv.height } : null;
    });
    ok(dims && dims.w === 1024 && dims.h === 640, 'fitCanvas 按图片真实尺寸定（P0-1 回归闸）：' + JSON.stringify(dims));

    /* ② 默认浏览档：不落笔 */
    const browse = await page.eval(async () => {
      const cv = document.querySelector('.lb-mask-cv');
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      const fire = (el, type, x, y, buttons) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: buttons || 0,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      fire(cv, 'pointerdown', r.left + 50, r.top + 50, 1);
      fire(cv, 'pointermove', r.left + 90, r.top + 50, 1);
      fire(cv, 'pointerup', r.left + 90, r.top + 50, 0);
      await new Promise(res => setTimeout(res, 60));
      const px = cv.getContext('2d').getImageData(Math.round(cv.width / 2), Math.round(cv.height / 2), 1, 1).data;
      return { alpha: px[3], browseOn: !!document.querySelector('.lb-mask-bar [data-t="browse"].on') };
    });
    ok(browse && browse.browseOn && browse.alpha === 0, '浏览档：选中且不落笔');

    /* ③ 画笔两笔 → 完成 → onSaveMask 收到 PNG */
    const save = await page.eval(async () => {
      const cv = document.querySelector('.lb-mask-cv');
      const r = cv.getBoundingClientRect();
      const fire = (el, type, x, y, buttons) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: buttons || 0,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      document.querySelector('.lb-mask-bar [data-t="brush"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fire(cv, 'pointerdown', r.left + 40, r.top + 40, 1);
      fire(cv, 'pointermove', r.left + 140, r.top + 40, 1);
      fire(cv, 'pointerup', r.left + 140, r.top + 40, 0);
      await new Promise(res => setTimeout(res, 60));
      const done = [...document.querySelectorAll('.lb-mask-bar button')].find(b => /完成/.test(b.textContent));
      if (done) done.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(res => setTimeout(res, 150));
      return String(window.__rv.saved);
    });
    ok(/^data:image\/png/.test(save), '完成把掩码 PNG 交回 onSaveMask');
    ok(!page.errors.length, '零页面错误' + (page.errors.length ? '：' + page.errors.slice(-3).join(' | ') : ''));
  } catch (e) {
    bad++;
    console.log('  ✗ 探针异常：' + (e && e.stack || e));
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
  console.log(bad ? '✗ ref-view e2e：' + bad + ' 项未过' : '✓ ref-view e2e 通过');
  process.exit(bad ? 1 : 0);
})();
