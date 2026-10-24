#!/usr/bin/env node
/* 时间轴缩放控件走一遍（.tl-tabs 右边那一撮 = [−] [滑块] [+] [读数] [自适应]），盯住这几条判据：
   ① 加减一步 ≈ 1.15 倍（不是 1.6）：自适应档铺满 → 点「＋」读数 = 铺满档 × 1.15，连点按同一倍率走；
   ② 滑块是对数位置：pos ↔ px/秒 与「min=24/总长、max=600」的 log 映射对得上；
      一格一变（连续）、等距三档倍率相等（对数），低档位不挤在左端；
   ③ 「自适应」是独立按钮：初始（自适应档）它一开始就 disabled；缩放后可点，点它回到自适应、
      读数写「自适应」、按钮变 disabled、落盘键清掉、滑块停在自适应对应的那一档；
   ④ 缩放围绕视野中心那一秒：拖滑块前后「视野中心对应的秒数」不变；
   ⑤ 缩放只重排时间轴：候选缩略图还是同一个节点、中间栏滚动位置不跳、播放器不进/出全屏；
   ⑥ 换页签（本镜 ⇄ 全片）滑块两端跟着总长重算：同一个 px/秒 在两把尺子上位置不同、都还在 0–1000 里；
   ⑦ 1024 宽不溢出：.tl-tabs 那一行 scrollWidth ≤ clientWidth，滑块与「自适应」钮不出行右沿；
   ⑧ 滑块与「自适应」钮不进页签绑定（只认 button[data-tab]）：点它们不切「本镜 / 全片」。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  const shot = (id, name, prompt, dur) => ({
    id, name, prompt,
    ar: '16:9', res: '768p', tier: 'fast', draw: 1,
    refImages: [], keyframes: [], selId: 'v-' + id,
    candidates: [{ vid: 'v-' + id, provider: 'local', status: 'succeeded', progress: 100,
      url: '', duration: dur, shotId: id }],
  });
  const project = {
    id: 'p-zoom', name: '缩放探针', curScene: 0, curShot: 0, voices: [],
    scenes: [{ id: 'sc1', name: '场景 1', shots: [
      shot('sh1', '镜头 A', 'A 的画面', 6),
      shot('sh2', '镜头 B', 'B 的画面', 4),
    ] }],
  };
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project], curId: project.id, roles: [], ts: Date.now() });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh2"]'), 15000);
    await page.eval(() => { const t = document.getElementById('trimBtn'); if (t && !t.classList.contains('on')) t.click(); });
    await page.waitFor(() => !!document.querySelector('#tlBar .tl-seg'), 15000);

    const readWhen = async (fn, timeout = 8000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn);
        if (v) return v;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('等待超时：' + String(fn).slice(0, 80));
    };
    /* 读数 → 数字；null = 还写着「自适应」（readWhen 等的就是这一份页面侧函数） */
    const readNum = () => readWhen(() => {
      const t = ((document.getElementById('tlZoomVal') || {}).textContent || '').trim();
      return /^[\d.]+ px\/秒$/.test(t) ? Number(t.replace(/[^0-9.]/g, '')) : null;
    });
    /* 滑块拖到某一档：真 input 事件走的是「拖动中」那一条路（只改内存、不落盘） */
    const setPos = pos => page.eval(pos => {
      const r = document.getElementById('tlZoomRange');
      if (!r) return null;
      r.value = String(pos);
      r.dispatchEvent(new Event('input', { bubbles: true }));
      const t = ((document.getElementById('tlZoomVal') || {}).textContent || '').trim();
      return /^[\d.]+ px\/秒$/.test(t) ? Number(t.replace(/[^0-9.]/g, '')) : null;
    }, pos);
    /* 本镜页签的映射（候选 6 秒、没切没倍速：min = 24/6 = 4、max = 600） */
    const MIN_SHOT = 4, MAX_ZOOM = 600;
    const posFor = (pps, min) => Math.round(Math.log(pps / min) / Math.log(MAX_ZOOM / min) * 1000);

    /* ① 初始 = 自适应档：读数、按钮一开始就不可点、滑块停在自适应对应的那一档 */
    const st0 = await page.eval(() => {
      const v = document.getElementById('tlZoomVal'), a = document.getElementById('tlZoomAuto'),
        r = document.getElementById('tlZoomRange');
      return { text: (v || {}).textContent || '', dis: a ? a.disabled : null, pos: r ? Number(r.value) : null,
        barW: (document.getElementById('tlBar') || {}).clientWidth || 0,
        /* 内容层的宽 = 总长 × 像素/秒（实现里内容层就是照这个算的）：
           用它反推铺满档，比事后量容器准 —— 容器宽会因为滚动条出现/消失而变，
           内容层的宽不会（那正是实现当时用的那个数）。 */
        innerW: (document.getElementById('tlInner') || {}).clientWidth || 0 };
    });
    if (st0.text !== '自适应') throw new Error('初始读数该写「自适应」：' + st0.text);
    if (st0.dis !== true) throw new Error('自适应档里「自适应」钮该一开始就 disabled：' + st0.dis);
    const fit = (st0.innerW || st0.barW) / 6;         // 自适应 = 铺多满（这条候选 6 秒）
    if (Math.abs(st0.pos - posFor(fit, MIN_SHOT)) > 1) {
      throw new Error('滑块没停在自适应对应的那一档：' + st0.pos + ' ≠ ' + posFor(fit, MIN_SHOT));
    }

    /* ② 加减一步 ≈ 1.15 倍 */
    await page.eval(() => document.getElementById('tlZoomIn').click());
    const p1 = await readNum();
    if (Math.abs(p1 - fit * 1.15) > 1.2) throw new Error('点「＋」该是铺满档 × 1.15：' + p1 + ' ≠ ' + (fit * 1.15));
    await page.eval(() => document.getElementById('tlZoomIn').click());
    const p2 = await readNum();
    if (Math.abs(p2 / p1 - 1.15) > 0.01) throw new Error('再点「＋」步进不是 1.15：' + p1 + ' → ' + p2);
    await page.eval(() => document.getElementById('tlZoomOut').click());
    const p3 = await readNum();
    if (Math.abs(p3 / p2 - 1 / 1.15) > 0.01) throw new Error('点「−」步进不是 1/1.15：' + p2 + ' → ' + p3);
    const man1 = await page.eval(() => {
      const a = document.getElementById('tlZoomAuto');
      return { dis: a.disabled, title: a.title, stored: window.LS.get('dir_tl_pps') };
    });
    if (man1.dis !== false) throw new Error('手动档里「自适应」钮该可点');
    if (!/回到「自适应」/.test(man1.title)) throw new Error('「自适应」钮该接住说明（含回自适应）：' + man1.title);
    if (!Number(man1.stored)) throw new Error('按钮缩放该落盘 dir_tl_pps：' + man1.stored);

    /* ③ 滑块对数映射：三档位置对照公式，连续一格一小步、等距倍率相等 */
    for (const pos of [500, 700, 900]) {
      const got = await setPos(pos);
      const want = MIN_SHOT * Math.pow(MAX_ZOOM / MIN_SHOT, pos / 1000);
      if (!got || Math.abs(got - want) > Math.max(1.2, want * 0.02)) {
        throw new Error('滑块位置 ' + pos + ' 的 px/秒不对：' + got + ' ≠ ' + want.toFixed(1));
      }
    }
    const lo = await setPos(500), mid = await setPos(700), hi = await setPos(900);
    const r1 = mid / lo, r2 = hi / mid;
    if (Math.abs(r1 - r2) / r1 > 0.03) throw new Error('等距三档倍率该相等（对数）：' + r1 + ' vs ' + r2);
    /* 连续性：读数在小档位是整数显示（0.5% 的一步会被它吃掉），
       改量 #tlInner 的宽度（= 总长 × px/秒，无取整损失）—— 拖一格长一点、拖十格长约十倍 */
    const innerW = () => page.eval(() => (document.getElementById('tlInner') || {}).clientWidth || 0);
    await setPos(500);
    const w1 = await innerW();
    await setPos(501);
    const w2 = await innerW();
    await setPos(510);
    const w3 = await innerW();
    if (!(w2 > w1 && w3 > w2)) throw new Error('拖一格该连续变宽：' + w1 + ' → ' + w2 + ' → ' + w3);
    const d10 = (w3 - w1) / (w2 - w1);
    if (d10 < 4 || d10 > 25) throw new Error('拖十格的增量该约是拖一格的十倍（连续、不跳档）：' + d10);

    /* ④ 围绕视野中心那一秒：取两档都「整条比轨道宽」的位置（内容比容器窄时中心无从保持），
       拖动前后视野中心对应的秒数不变 */
    const barW = st0.barW;
    const posLo = posFor(barW / 6 * 1.3, MIN_SHOT), posHi = posFor(barW / 6 * 1.7, MIN_SHOT);
    await setPos(posLo);
    const c1 = await page.eval(() => {
      const b = document.getElementById('tlBar'), i = document.getElementById('tlInner');
      return (b.scrollLeft + b.clientWidth / 2) / (i.clientWidth / 6);
    });
    await setPos(posHi);
    const c2 = await page.eval(() => {
      const b = document.getElementById('tlBar'), i = document.getElementById('tlInner');
      return (b.scrollLeft + b.clientWidth / 2) / (i.clientWidth / 6);
    });
    if (Math.abs(c1 - c2) > 0.15) throw new Error('拖滑块该围绕视野中心那一秒：' + c1.toFixed(2) + ' → ' + c2.toFixed(2));

    /* ⑤ 只重排时间轴：候选缩略图同一个节点、中间栏滚动不跳、播放器不进/出全屏 */
    const soft0 = await page.eval(() => {
      const th = document.querySelector('#candThumbs > *');
      if (th) th.__zoomProbe = 1;
      const pl = document.querySelector('.player-box') || document.querySelector('#player') || document.querySelector('.player-empty');
      if (pl) pl.__zoomProbe = 1;
      const col = document.getElementById('midCol');
      return { hasTh: !!th, hasPl: !!pl, top: col ? col.scrollTop : 0, fs: !!document.fullscreenElement };
    });
    /* 剪辑态**不画候选条**（用户点名的形状：轨道坞 + 播放器就是剪辑的全部，换候选回生成态点），
       所以这一档验的是**播放器**那个节点不被重建；候选条那一半在生成态才有，有就一起验。 */
    if (!soft0.hasPl) throw new Error('剪辑态该有播放器可验');
    await setPos(posLo + 40);
    const soft1 = await page.eval(() => {
      const th = document.querySelector('#candThumbs > *');
      const pl = document.querySelector('.player-box') || document.querySelector('#player') || document.querySelector('.player-empty');
      const col = document.getElementById('midCol');
      return { sameTh: !!(th && th.__zoomProbe === 1), samePl: !!(pl && pl.__zoomProbe === 1),
        top: col ? col.scrollTop : 0, fs: !!document.fullscreenElement };
    });
    if (soft0.hasTh && !soft1.sameTh) throw new Error('缩放不该把候选缩略图换成新节点（那是整列重画的旧病）');
    if (soft0.hasPl && !soft1.samePl) throw new Error('缩放不该重建播放器节点');
    if (soft1.top !== soft0.top) throw new Error('缩放不该动中间栏的滚动位置：' + soft0.top + ' → ' + soft1.top);
    if (soft1.fs) throw new Error('缩放不该进全屏');

    /* ⑥ 换页签：总长 6 → 10，min 变 2.4 —— 同一个 px/秒 位置不同、不越界 */
    const v1 = await page.eval(() => Number(document.getElementById('tlZoomRange').value));
    await page.eval(() => document.querySelector('.tl-tabs [data-tab="film"]').click());
    await page.waitFor(() => !!document.querySelector('#tlBar .tl-film'), 15000);
    const filmSt = await page.eval(() => ({
      text: (document.getElementById('tlZoomVal') || {}).textContent || '',
      pos: Number(document.getElementById('tlZoomRange').value),
    }));
    if (!/^[\d.]+ px\/秒$/.test(filmSt.text)) throw new Error('换页签后还是手动档，读数该仍是数字：' + filmSt.text);
    const ppsNow = Number(filmSt.text.replace(/[^0-9.]/g, ''));
    const wantPos = posFor(ppsNow, 2.4);
    if (Math.abs(filmSt.pos - wantPos) > 2) {
      throw new Error('全片页签的滑块该按新端点重算：' + filmSt.pos + ' ≠ ' + wantPos);
    }
    if (filmSt.pos < 0 || filmSt.pos > 1000) throw new Error('换页签后滑块越界：' + filmSt.pos);
    if (filmSt.pos === v1) throw new Error('总长变了滑块位置该跟着变（两端重算）');
    await page.eval(() => document.querySelector('.tl-tabs [data-tab="shot"]').click());
    await page.waitFor(() => !!document.querySelector('#tlBar .tl-seg'), 15000);

    /* ⑦ 1024 宽不溢出：说明文字让位（整句藏掉），控件不出行右沿 */
    await page.setSize(1024, 800);
    await new Promise(r => setTimeout(r, 400));
    const wide = await page.eval(() => {
      /* 缩放那一组现在住在**工具条**里（`.tl-dock-tools`），页签（`.tl-tabs`）是它左边那一颗 ——
         量「有没有出行」要拿它真正所在的那一行的右沿当界，不是页签那一颗。 */
      const row = document.querySelector('.tl-dock-tools') || document.querySelector('.tl-tabs');
      const r = document.getElementById('tlZoomRange').getBoundingClientRect();
      const a = document.getElementById('tlZoomAuto').getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const tip = row.querySelector('.tl-tip');
      return { sw: row.scrollWidth, cw: row.clientWidth, maxRight: Math.max(r.right, a.right),
        rowRight: rr.right, tipHidden: tip ? getComputedStyle(tip).display === 'none' : true };
    });
    if (!wide.tipHidden) throw new Error('1024 宽说明文字该整句藏掉（宽预算让给控件）');
    if (wide.sw > wide.cw + 1) throw new Error('1024 宽工具条该不溢出：' + wide.sw + ' > ' + wide.cw);
    if (wide.maxRight > wide.rowRight + 1) throw new Error('滑块 / 自适应钮出行了：' + wide.maxRight + ' > ' + wide.rowRight);

    /* ⑧ 新控件不进页签绑定：点「＋」/ 滑块 /「自适应」都不会切「本镜 / 全片」，缩放照常工作 */
    const tabOf = () => page.eval(() => {
      const on = document.querySelector('.tl-tabs button[data-tab].on');
      return on ? on.dataset.tab : '';
    });
    if (await tabOf() !== 'shot') throw new Error('回到本镜页签后页签该在「本镜」');
    await page.eval(() => document.getElementById('tlZoomIn').click());
    const afterIn = await readNum();
    if (!afterIn) throw new Error('页签换过后「＋」该照常缩放（绑定没被页签那路整批换掉）');
    if (await tabOf() !== 'shot') throw new Error('点「＋」不该切页签');
    await page.eval(() => {
      const r = document.getElementById('tlZoomRange');
      r.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    if (await tabOf() !== 'shot') throw new Error('点滑块不该切页签');
    await page.eval(() => document.getElementById('tlZoomAuto').click());
    const back = await readWhen(() => {
      const a = document.getElementById('tlZoomAuto');
      const v = (document.getElementById('tlZoomVal') || {}).textContent || '';
      return a && a.disabled && v === '自适应' ? { text: v, pos: Number(document.getElementById('tlZoomRange').value) } : null;
    });
    if (await tabOf() !== 'shot') throw new Error('点「自适应」不该切页签');
    const stored = await page.eval(() => window.LS.get('dir_tl_pps'));
    if (stored) throw new Error('回到自适应该清掉落盘键：' + stored);
    /* 铺满档按**现在**的尺子算（上面刚缩到 1024，tlBar 比开头 1440 时窄得多），
       不能拿 ① 里抓的旧 fit 对照；自适应下限 12px/秒 与实现同一条式子。
       尺子取内容层的宽（= 总长 × 像素/秒，就是实现当时用的那个数）：事后量容器会踩到滚动条。 */
    const barW2 = await page.eval(() => ({
      bar: (document.getElementById('tlBar') || {}).clientWidth || 0,
      inner: (document.getElementById('tlInner') || {}).clientWidth || 0 }));
    const fit2 = Math.max(12, (barW2.inner || barW2.bar) / 6);
    if (Math.abs(back.pos - posFor(fit2, MIN_SHOT)) > 1) throw new Error('回自适应后滑块该停回铺满档：' + back.pos + ' ≠ ' + posFor(fit2, MIN_SHOT));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    const fl = h.logFaults(proxy.log);
    if (fl.length) throw new Error('代理日志有未声明异常：\n' + fl.join('\n'));
    console.log('✓ 缩放控件：加减一步 1.15 · 滑块对数无极（连续 / 等距等倍率 / 位置↔px/秒同一对端点）· 自适应独立钮（初始 disabled / 一点回位 / 清落盘）· 围绕视野中心那一秒 · 只重排时间轴 · 换页签两端重算 · 1024 不溢出 · 新控件不进页签绑定');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    const errs = (page && page.errors || []).filter(Boolean).slice(0, 5);
    if (errs.length) console.error('页面异常：\n' + errs.join('\n'));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
