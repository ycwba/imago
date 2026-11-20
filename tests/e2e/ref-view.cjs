'use strict';
/* 灯箱编号批注 e2e（公共灯箱保持原样，只验新的涂鸦层）：
   ① 仍用公共灯箱，左右面板不进 #lbStage；② 覆盖层几何与 stage 清空后重建；
   ③ 点 / 框 / 画笔 / 箭头四种工具落结构化坐标；④ 撤销 → 重做、新操作清 redo、清空可撤销；
   ⑤ 选中行 → 内联输入 → 好；⑥ 删除不重编号；⑦ 完成交回 PNG+doc 并留回显；
   ⑧ 带 doc 重开可继续编辑；⑨ 旧 PNG 只读兼容；⑩ 零页面错误。 */
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page, bad = 0;
  const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++; };
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => document.body.innerText.length > 0, 20000);

    await page.eval(async () => {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'web/ui/lb-mask.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
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
      window.__rv = { saved: 'unset', doc: null };
      window.__rv.src = cv.toDataURL('image/png');
      if (!Wb.lightbox.cfg) {
        Wb.lightbox.init({
          keyOf: it => (it && it.src) || '', srcOf: it => (it && it.src) || '',
          kindOf: it => (it && it.kind) || 'image', list: () => [],
          nameOf: it => (it && it.label) || 'ref', info: it => [it.label || ''],
        });
      }
      Wb.lightbox.open({ src: window.__rv.src, label: 'e2e', kind: 'image' },
        [{ src: window.__rv.src, label: 'e2e', kind: 'image' }]);
    });
    await page.waitFor(() => {
      const im = document.querySelector('#lbStage img');
      return !!(im && im.complete && im.naturalWidth > 0);
    }, 8000);
    await page.eval(() => {
      LbMask.enter((png, doc) => { window.__rv.saved = png; window.__rv.doc = doc; });
    });
    await page.waitFor(() => document.querySelector('.lb-ann-overlay'), 8000);

    /* ①② 公共灯箱没被替换；覆盖层跟着图片显示矩形 */
    const mount = await page.eval(() => {
      const lb = document.getElementById('lightbox'), stage = document.getElementById('lbStage');
      const im = stage.querySelector('img'), ov = stage.querySelector('.lb-ann-overlay');
      const ir = im.getBoundingClientRect(), or = ov.getBoundingClientRect();
      return {
        open: lb.style.display === 'flex',
        panels: !!lb.querySelector(':scope > .lb-ann-tools') && !!lb.querySelector(':scope > .lb-ann-list'),
        notInStage: !stage.querySelector('.lb-ann-tools') && !stage.querySelector('.lb-ann-list'),
        viewBox: ov.getAttribute('viewBox'),
        geom: Math.abs(ir.left - or.left) < 2 && Math.abs(ir.top - or.top) < 2
          && Math.abs(ir.width - or.width) < 2 && Math.abs(ir.height - or.height) < 2,
      };
    });
    ok(mount.open && mount.panels && mount.notInStage, '仍用公共灯箱，左右面板是 #lightbox 的子节点');
    ok(mount.geom && mount.viewBox === '0 0 1024 640', '覆盖层按图片显示矩形与原图尺寸对齐：' + JSON.stringify(mount));

    /* ③ 四种工具；坐标归一化 0..1 */
    const draw = await page.eval(async () => {
      const ov = document.querySelector('.lb-ann-overlay');
      const r = ov.getBoundingClientRect();
      const fire = (type, fx, fy, buttons) => ov.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: buttons || 0,
        clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      const tool = t => document.querySelector('.lb-ann-tools [data-t="' + t + '"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const drag = (from, to, steps) => {
        const n = steps || 4;
        fire('pointerdown', from[0], from[1], 1);
        for (let i = 1; i <= n; i++) {
          fire('pointermove', from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n, 1);
        }
        fire('pointerup', to[0], to[1], 0);
      };
      tool('point'); fire('pointerdown', .30, .25, 1); fire('pointerup', .30, .25, 0);
      tool('box'); drag([.34, .25], [.50, .40]);
      tool('brush'); drag([.34, .50], [.55, .55], 6);
      tool('arrow'); drag([.60, .25], [.75, .45]);
      await new Promise(res => setTimeout(res, 40));
      document.querySelectorAll('.lb-ann-inline').forEach(n => { n.hidden = true; });
      const rows = document.querySelectorAll('.lb-ann-row').length;
      const d = LbMask.current();
      return { rows, types: d ? d.items.map(x => x.type) : [], nums: d ? d.items.map(x => x.n) : [],
        norm: d ? d.items.every(a => a.points.every(p => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1)) : false,
        list: document.querySelector('.lb-ann-count').textContent };
    });
    ok(draw.types.join(',') === 'point,box,brush,arrow' && draw.norm && draw.rows === 4,
      '四种工具都落成结构化批注、坐标归一化：' + JSON.stringify(draw));

    /* ④ 撤销 / 重做 / 新操作清 redo / 清空可撤销 */
    const history = await page.eval(() => {
      const act = a => document.querySelector('.lb-ann-tools [data-act="' + a + '"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const count = () => Number(document.querySelector('.lb-ann-count').textContent);
      const redoOff = () => document.querySelector('.lb-ann-tools [data-act="redo"]').disabled;
      const before = count();
      act('undo'); const afterUndo = count();
      act('redo'); const afterRedo = count();
      act('undo');
      document.querySelector('.lb-ann-tools [data-t="point"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const ov = document.querySelector('.lb-ann-overlay'), r = ov.getBoundingClientRect();
      ov.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true,
        button: 0, buttons: 1, clientX: r.left + r.width * .8, clientY: r.top + r.height * .8,
        pointerId: 2, pointerType: 'mouse', isPrimary: true }));
      const afterNew = count(), redoCleared = redoOff();
      act('clear'); const afterClear = count();
      act('undo'); const afterClearUndo = count();
      return { before, afterUndo, afterRedo, afterNew, afterClear, afterClearUndo, redoCleared };
    });
    ok(history.afterUndo === history.before - 1 && history.afterRedo === history.before,
      '撤销 → 重做恢复：' + JSON.stringify(history));
    ok(history.afterNew === history.before && history.redoCleared, '新批注清空 redo 栈');
    ok(history.afterClear === 0 && history.afterClearUndo === history.before, '清空可撤销');

    /* ⑤ 选中行 → 内联输入 → 好；补一句 */
    const text = await page.eval(async () => {
      const row = document.querySelector('.lb-ann-row');
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(res => setTimeout(res, 30));
      const inline = document.querySelector('.lb-ann-inline');
      const shown = inline && !inline.hidden;
      if (shown) {
        inline.querySelector('input').value = '改成草地';
        inline.querySelector('[data-act="ok"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      const add = document.querySelector('.lb-ann-add');
      add.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const note = document.querySelector('.lb-ann-note');
      note.value = '整体淡一点';
      note.dispatchEvent(new Event('input', { bubbles: true }));
      const now = LbMask.current();
      return { shown, first: now.items[0].text, note: now.note,
        listText: document.querySelector('.lb-ann-row .lb-ann-txt').textContent };
    });
    ok(text.shown && text.first === '改成草地' && text.listText === '改成草地',
      '选中编号后内联输入并写回文案：' + JSON.stringify(text));
    ok(text.note === '整体淡一点', '补一句写进文档');

    /* ⑥ 删除不重编号（删 2 号，3 号不变） */
    const del = await page.eval(() => {
      const before = LbMask.current().items.map(x => x.n);
      const btn = document.querySelectorAll('.lb-ann-row [data-del]')[1];
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { before, after: LbMask.current().items.map(x => x.n) };
    });
    ok(del.before.length - 1 === del.after.length && del.after.indexOf(del.before[2]) >= 0 && del.after.indexOf(del.before[1]) < 0,
      '删除后编号不重排：' + JSON.stringify(del));

    /* ⑦ 完成：PNG + doc 交回，编辑面板收走、编号图回显 */
    const done = await page.eval(async () => {
      window.__rv.saved = 'unset';
      document.querySelector('.lb-ann-list [data-act="done"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(res => setTimeout(res, 80));
      return { png: String(window.__rv.saved).slice(0, 22), hasDoc: !!window.__rv.doc,
        echo: !!document.querySelector('#lbStage .lb-ann-echo'),
        gone: !document.querySelector('.lb-ann-tools') && !document.querySelector('.lb-ann-list') && !document.querySelector('.lb-ann-overlay') };
    });
    ok(/^data:image\/png/.test(done.png) && done.hasDoc, '完成交回编号 PNG 与结构化文档：' + JSON.stringify(done));
    ok(done.echo && done.gone, '完成后编辑层收走、编号图常驻回显');

    /* ⑧ 带 doc 重开继续编辑；⑨ 旧 PNG 只读兼容 */
    const reopen = await page.eval(async () => {
      const saved = window.__rv.doc;
      Wb.lightbox.open({ src: window.__rv.src, label: 'e2e', kind: 'image' },
        [{ src: window.__rv.src, label: 'e2e', kind: 'image' }]);
      for (let i = 0; i < 40 && !document.querySelector('#lbStage img'); i++) await new Promise(res => setTimeout(res, 50));
      LbMask.enter(() => {}, { existing: saved });
      await new Promise(res => setTimeout(res, 60));
      const rows = document.querySelectorAll('.lb-ann-row').length;
      const first = document.querySelector('.lb-ann-row .lb-ann-txt').textContent;
      Wb.lightbox.close();
      await new Promise(res => setTimeout(res, 60));
      Wb.lightbox.open({ src: window.__rv.src, label: 'e2e', kind: 'image' },
        [{ src: window.__rv.src, label: 'e2e', kind: 'image' }]);
      for (let i = 0; i < 40 && !document.querySelector('#lbStage img'); i++) await new Promise(res => setTimeout(res, 50));
      LbMask.enter(() => {}, { existing: window.__rv.src });
      await new Promise(res => setTimeout(res, 60));
      return { rows, first, total: saved.items.length, legacy: !!document.querySelector('.lb-ann-legacy'),
        noFake: document.querySelectorAll('.lb-ann-row').length === 0 };
    });
    ok(reopen.rows === reopen.total && reopen.first === '改成草地',
      '带 doc 重开：编号、文案、坐标原样回显：' + JSON.stringify(reopen));
    ok(reopen.legacy && reopen.noFake, '旧 PNG 只作只读参考层，不伪装成结构化批注');
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
