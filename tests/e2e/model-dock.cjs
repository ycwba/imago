#!/usr/bin/env node
/* 建模台时间轴坞的关键帧编辑（真浏览器）：
   ① 选中轨道与一帧：逐帧表单出现，没写过的字段留空显示「不变」；
   ② 逐帧写字段：缩放按采样值锚住另外两格 / 显隐三态 / 缓入三档，读回文档都对；
   ③ 清掉一个字段 = 这一帧不再改它；清掉最后一个字段 = 整帧自动删掉；
   ④ 拖菱形改时间：跟手、松手排序落位、回执念出新时刻；输入框改时间同样经同一份夹算；
   ⑤ 「删掉这一帧」按钮与轨道行的帧数读数跟着变；全程零控制台错误。
   跑法：`node tests/e2e/model-dock.cjs` */
'use strict';
const h = require('./harness.cjs');

(async () => {
  let proxy, browser, page;
  const bad = [];
  const ok = (cond, what, extra) => {
    if (cond) console.log('  ✓ ' + what);
    else { bad.push(what + (extra ? '（' + extra + '）' : '')); console.log('  ✗ ' + what + (extra ? '（' + extra + '）' : '')); }
  };
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    const url = proxy.base + '/shell.html#model.html';
    await page.goto(url);

    /* 新探针里一个白模库都没有：先建一个默认库再重载，开机才会选中它。 */
    await page.eval(async () => {
      const v = await import('/web/model3d/vault.js');
      const d = await v.list('');
      if (!d.libraries || !d.libraries.length) await v.saveLibrary({ name: '默认库' });
      return true;
    });
    await page.goto(proxy.base + '/shell.html?seed=1#model.html');
    await page.waitFor(() => {
      const b = window.WBBridge && window.WBBridge.get('model3d');
      return !!(b && b.ready());
    }, 30000);

    /* 一件实体 + 一条两帧的节点轨道，帧上带 at / rot。 */
    const seeded = await page.eval(async () => {
      const b = window.WBBridge.get('model3d');
      const n = await b.run('new', { name: '探针件' });
      if (!n || !n.ok) return { err: (n && n.err) || 'new 失败' };
      const id = (b.list().实体[0] || {}).id || '';
      if (!id) return { err: '新建之后 list 里没有实体' };
      const r = await b.run('edit', {
        ops: [{
          op: 'track',
          add: {
            of: { kind: 'node', id },
            keys: [
              { t: 0, at: [0, 0, 0], rot: [0, 0, 0] },
              { t: 2, at: [0, 1, 0], rot: [0, 90, 0] },
            ],
          },
        }],
      });
      if (!r || !r.ok) return { err: (r && r.err) || 'edit 失败' };
      return { id };
    });
    if (seeded.err) throw new Error('种子失败：' + seeded.err);

    const probe = () => page.eval(() => {
      const host = document.querySelector('[data-r="mmDock"]');
      const row = host && host.querySelector('.mm-track-row[data-track-id]');
      const edit = host && host.querySelector('.mm-keyedit');
      const say = host && host.querySelector('[data-dock="say"]');
      const time = host && host.querySelector('[data-dock="time"]');
      const field = p => {
        const el = edit && edit.querySelector('[data-dock-field="' + p + '"]');
        return el ? String(el.value) : null;
      };
      return {
        rowOn: !!row && row.classList.contains('on'),
        trackId: row ? row.dataset.trackId : '',
        chips: host ? host.querySelectorAll('.mm-key-chip').length : 0,
        chipText: host ? Array.from(host.querySelectorAll('.mm-key-chip')).map(c => c.textContent) : [],
        dots: host ? host.querySelectorAll('.mm-key').length : 0,
        edit: !!edit,
        t: field('key.t'),
        at: [0, 1, 2].map(i => field('key.at.' + i)),
        scale: [0, 1, 2].map(i => field('key.scale.' + i)),
        scalePh: (() => {
          const el = edit && edit.querySelector('[data-dock-field="key.scale.0"]');
          return el ? el.getAttribute('placeholder') : null;
        })(),
        visible: field('key.visible'),
        ease: field('key.ease'),
        say: say ? say.textContent : '',
        time: time ? time.textContent : '',
        frames: row ? (row.querySelector('.mm-track-n') || {}).textContent : '',
      };
    });
    const read = () => page.eval(async id => {
      const b = window.WBBridge.get('model3d');
      const r = b.read({ id });
      const tr = (r.轨道 || [])[0] || null;
      return { keys: tr ? (tr.keys || []) : [] };
    }, seeded.id);
    const click = sel => page.eval(s => {
      const el = document.querySelector(s);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      return true;
    }, sel);
    const change = (sel, value) => page.eval((s, v) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, sel, value);

    /* ① 选轨道、选一帧 */
    ok(await click('[data-r="mmDock"] .mm-track-row[data-track-id]'), '轨道行点得中');
    let st = await probe();
    ok(st.rowOn && st.chips === 2 && st.dots === 2, '轨道选中、两帧都在', JSON.stringify({ on: st.rowOn, chips: st.chips, dots: st.dots }));

    ok(await click('[data-r="mmDock"] .mm-key-chip [data-dock-act="selKey"][data-key-index="0"]'), '点第一帧的票签');
    st = await probe();
    ok(st.edit && st.t === '0.00', '逐帧表单出现且时刻读作 0.00', st.t);
    ok(st.scalePh === '不变' && st.scale[0] === '', '没写过的缩放留空显示「不变」', JSON.stringify({ ph: st.scalePh, v: st.scale[0] }));
    ok(st.visible === '' && st.ease === '', '显隐 / 缓入默认都停在「不变 / 跟轨道」', JSON.stringify({ vis: st.visible, ease: st.ease }));

    /* ② 逐帧写字段 */
    await change('[data-dock-field="key.scale.1"]', '3');
    let doc = await read();
    ok(JSON.stringify(doc.keys[0].scale) === '[1,3,1]', '改一格缩放，另外两格按当前值锚住', JSON.stringify(doc.keys[0].scale));
    await change('[data-dock-field="key.visible"]', '0');
    doc = await read();
    ok(doc.keys[0].visible === false, '显隐写成「隐藏」', String(doc.keys[0].visible));
    await change('[data-dock-field="key.ease"]', 'hold');
    doc = await read();
    ok(doc.keys[0].ease === 'hold', '缓入写成「保持」', String(doc.keys[0].ease));

    /* ③ 清掉一个字段 ≠ 删帧；清掉最后一个字段 = 删帧 */
    await click('.mm-keyedit [data-dock-act="clrKeyField"][data-key-field="scale"]');
    doc = await read();
    st = await probe();
    ok(doc.keys[0].scale === undefined && st.say.indexOf('这一帧不再改缩放') >= 0,
      '× 清掉缩放后这一帧不再改它', JSON.stringify({ scale: doc.keys[0].scale, say: st.say }));

    /* ④ 拖菱形改时间（从 2 秒拖到 1 秒附近） */
    const drag = await page.eval(() => {
      const host = document.querySelector('[data-r="mmDock"]');
      const row = host.querySelector('.mm-track-row[data-track-id]');
      const bar = row.querySelector('.mm-track-bar');
      const dot = row.querySelector('.mm-key[data-dock-key="1"]');
      if (!bar || !dot) return { err: '找不到第二帧的菱形' };
      const br = bar.getBoundingClientRect();
      const dr = dot.getBoundingClientRect();
      const x0 = dr.left + dr.width / 2;
      const y0 = dr.top + dr.height / 2;
      const x1 = br.left + br.width * 0.25;
      const fire = (el, type, x, y, buttons) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: buttons || 0,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      fire(dot, 'pointerdown', x0, y0, 1);
      fire(window, 'pointermove', x0 + 8, y0, 1);
      fire(window, 'pointermove', x1 - 8, y0, 1);
      fire(window, 'pointermove', x1, y0, 1);
      fire(window, 'pointerup', x1, y0, 0);
      return { ok: true };
    });
    if (drag.err) throw new Error(drag.err);
    doc = await read();
    st = await probe();
    const t1 = doc.keys.length === 2 ? doc.keys[1].t : -1;
    ok(doc.keys.length === 2 && Math.abs(t1 - 1) <= 0.05, '拖到 25% 处 = 第 1 秒附近', 't=' + t1);
    ok(st.say.indexOf('关键帧已移到 1.0') >= 0, '回执念出新时刻', st.say);
    ok(st.time.indexOf('1.0') >= 0, '播放头跟着落在新时刻', st.time);

    /* 拖动松手会短暂吞掉同位置的 click：等过这一小段再继续点。 */
    await h.sleep(500);

    /* ④b 输入框改时间（同一份夹算：两位小数 + 重排） */
    await change('[data-dock-field="key.t"]', '1.5');
    doc = await read();
    ok(Math.abs(doc.keys[1].t - 1.5) < 0.001, '输入框把这一帧改成 1.5 秒', String(doc.keys[1].t));

    /* ③b 把拖动过的那一帧清到没有内容 = 整帧自动删掉 */
    await click('.mm-keyedit [data-dock-act="clrKeyField"][data-key-field="at"]');
    st = await probe();
    ok(st.chips === 2 && st.say.indexOf('这一帧不再改位置') >= 0, '清掉位置后这一帧还在（还有旋转）', st.say);
    await click('.mm-keyedit [data-dock-act="clrKeyField"][data-key-field="rot"]');
    doc = await read();
    st = await probe();
    ok(doc.keys.length === 1 && st.chips === 1 && st.say.indexOf('这一帧已经没有内容，已删掉') >= 0,
      '清掉最后一个字段后整帧自动删掉', JSON.stringify({ n: doc.keys.length, chips: st.chips, say: st.say }));

    /* ⑤ 「删掉这一帧」按钮 */
    await click('[data-r="mmDock"] .mm-key-chip [data-dock-act="selKey"][data-key-index="0"]');
    ok((await probe()).edit, '剩下的那一帧还能选回来');
    await click('.mm-keyedit [data-dock-act="delKeySel"]');
    doc = await read();
    st = await probe();
    ok(doc.keys.length === 0 && st.chips === 0 && !st.edit, '「删掉这一帧」清空轨道且表单收起', JSON.stringify({ n: doc.keys.length, chips: st.chips, edit: st.edit }));
    ok(String(st.frames).indexOf('0 帧') >= 0, '轨道行的帧数读数跟着变', st.frames);

    if (page.errors.length) bad.push('控制台错误：' + page.errors.slice(-3).join(' | '));
    if (bad.length) throw new Error(bad.length + ' 处不符合');
    console.log('\n✓ 建模台时间轴坞的关键帧编辑通过');
  } catch (e) {
    console.error('\n✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
