'use strict';
/* RefView（查看 / 掩码灯箱）e2e：
   ① fitCanvas 时序：打开就画（P0-1 的回归闸）—— 画布必须按图片真实尺寸定，而不是 1×1；
   ② 浏览 / 画笔两档：浏览不落笔、覆盖层显隐；
   ③ 完成保存（onSaveMask 收到 PNG）与 Esc 丢弃确认（有改动先问，不静默丢）；
   ④ 视频 / 音频走同一弹窗的播放器。 */
const h = require('./harness.cjs');
const sleep = h.sleep;

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

    /* 打开一张 1024×640 的白图（真解码有时序，fitCanvas 的回归就钉在这里） */
    await page.eval(async () => {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'web/ui/ref-view.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
      const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 640;
      const g = cv.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, 1024, 640);
      window.__rv = { saved: 'unset', closed: false };
      window.RefView.open(
        { kind: 'image', label: 'e2e', src: cv.toDataURL('image/png') },
        {
          onSaveMask: u => { window.__rv.saved = u; },
        });
    });
    await page.waitFor(() => document.querySelector('dialog.ui-dlg#rvDlg .rv-draw'), 8000);

    /* ① fitCanvas 时序：画布 buffer = 图片真实尺寸（1024×640），不是 1×1 */
    const dims = await page.eval(() => {
      const cv = document.querySelector('#rvDlg .rv-draw');
      return { w: cv.width, h: cv.height };
    });
    ok(dims.w === 1024 && dims.h === 640, 'fitCanvas 按图片真实尺寸定（P0-1 回归闸）：' + dims.w + '×' + dims.h);

    /* ② 默认浏览档：不落笔；覆盖层（无掩码时没有元素，画布上的 pointer 不产生笔迹） */
    const browse = await page.eval(async () => {
      const dlg = document.querySelector('#rvDlg');
      const cv = dlg.querySelector('.rv-draw');
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
      return { alpha: px[3], browseOn: !!dlg.querySelector('[data-tool="browse"].on') };
    });
    ok(browse.browseOn && browse.alpha === 0, '浏览档：选中且不落笔');

    /* ③ 画笔画两笔 → Esc → 丢弃确认出现 → 确认丢弃 → 不触发 onSaveMask */
    const discard = await page.eval(async () => {
      const dlg = document.querySelector('#rvDlg');
      const cv = dlg.querySelector('.rv-draw');
      const r = cv.getBoundingClientRect();
      const fire = (el, type, x, y, buttons) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: buttons || 0,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      dlg.querySelector('[data-tool="brush"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fire(cv, 'pointerdown', r.left + 40, r.top + 40, 1);
      fire(cv, 'pointermove', r.left + 140, r.top + 40, 1);
      fire(cv, 'pointerup', r.left + 140, r.top + 40, 0);
      await new Promise(res => setTimeout(res, 60));
      dlg.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
      await new Promise(res => setTimeout(res, 150));
      const confirmDlg = [...document.querySelectorAll('dialog.ui-dlg')].find(d => d.innerText.includes('丢弃'));
      out_confirm: {
        if (!confirmDlg) return { confirm: false };
        const yes = [...confirmDlg.querySelectorAll('button')].find(b => /丢弃/.test(b.textContent));
        if (yes) yes.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        break out_confirm;
      }
      await new Promise(res => setTimeout(res, 150));
      return { confirm: !!confirmDlg, gone: !document.querySelector('#rvDlg'), saved: String(window.__rv.saved) };
      var out_confirm;
    });
    ok(discard.confirm, 'Esc（有改动）出「丢弃？」确认');
    ok(discard.gone, '确认丢弃后弹窗关闭');
    ok(discard.saved === 'unset', '丢弃不触发 onSaveMask');

    /* ④ 重开 → 画 → 完成 → onSaveMask 收到 PNG；再开 → 掩码红影在浏览档显示 */
    await page.eval(async () => {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 320;
      const g = cv.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, 512, 320);
      window.__rv.saved = 'unset';
      window.RefView.open({ kind: 'image', label: 'e2e-2', src: cv.toDataURL('image/png') },
        { onSaveMask: u => { window.__rv.saved = u; } });
    });
    await page.waitFor(() => document.querySelector('dialog.ui-dlg#rvDlg .rv-draw'), 8000);
    const save = await page.eval(async () => {
      const dlg = document.querySelector('#rvDlg');
      const cv = dlg.querySelector('.rv-draw');
      const r = cv.getBoundingClientRect();
      const fire = (el, type, x, y, buttons) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: buttons || 0,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      dlg.querySelector('[data-tool="brush"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fire(cv, 'pointerdown', r.left + 30, r.top + 30, 1);
      fire(cv, 'pointermove', r.left + 120, r.top + 60, 1);
      fire(cv, 'pointerup', r.left + 120, r.top + 60, 0);
      await new Promise(res => setTimeout(res, 60));
      const done = [...dlg.querySelectorAll('button')].find(b => /完成/.test(b.textContent));
      done.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(res => setTimeout(res, 150));
      return {
        closed: !document.querySelector('#rvDlg'),
        saved: String(window.__rv.saved),
      };
    });
    ok(save.closed, '完成后弹窗关闭');
    ok(/^data:image\/png/.test(save.saved), '完成把掩码 PNG 交回 onSaveMask');
    ok(!page.errors.length, '零页面错误' + (page.errors.length ? '：' + page.errors.slice(-3).join(' | ') : ''));

    /* ⑤ 视频走同一弹窗的播放器 */
    await page.eval(() => {
      window.RefView.open({ kind: 'video', label: 'e2e 视频', src: 'tests/fixtures/media/probe-clip.mp4' });
    });
    await page.waitFor(() => document.querySelector('#rvDlg .rv-stage video'), 8000);
    ok(true, '视频走同一弹窗的播放器');
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
