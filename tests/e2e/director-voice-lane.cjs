#!/usr/bin/env node
/* 新加一句配音落在哪一行：目标时间窗里没被占的行才落，全被占就新开一行；
   12 行全占着这一秒时，合成前就拒绝（不发请求、不计费），铺音频那一路在落库时拒绝并说明音频在哪。
   两条入口共用同一个落库函数与同一个纯判据（web/director/voice-lanes.js 的 pickVoiceLane）。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  const shot = (id, name, dur) => ({
    id, name, prompt: name + ' 的画面', line: '', lineWho: '',
    ar: '16:9', res: '768p', tier: 'fast', draw: 1,
    refImages: [], keyframes: [], selId: 'v-' + id,
    /* 一条选用的候选：只给时长。落点 / 矩形要的是几何，不是可播字节。 */
    candidates: [{ vid: 'v-' + id, provider: 'local', status: 'succeeded', progress: 100,
      url: '', duration: dur, shotId: id }],
  });
  const V = (id, at, ln) => ({
    id, shotId: 'sh1', candId: 'v-sh1', seg: 0, at, dur: 1, vol: 1,
    src: '/asset/' + id, name: id, text: '', provider: '本机', model: '',
    ...(ln ? { ln } : {}),
  });
  const project = {
    id: 'p-vlane', name: '配音落行探针', curScene: 0, curShot: 0,
    /* 插针停在 2.5 秒：这一句的落点就是第 1 段 +2.5 秒。 */
    cutAt: 2.5,
    scenes: [{ id: 'sc1', name: '场景 1', shots: [shot('sh1', '镜头 A', 10)] }],
    /* 第 1 行在 2.5 秒上已经有一句（新句的目标窗被占），另有一句在 6 秒上只说明这一行别处有内容。 */
    voices: [V('vo-a', 2.5, 0), V('vo-b', 6, 0)],
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

    const readWhen = async (fn, timeout = 10000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn);
        if (v) return v;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('等待超时：' + String(fn).slice(0, 80));
    };
    const status = () => page.eval(() => (document.getElementById('opState') || {}).textContent || '');
    const lanes = () => page.eval(() => document.querySelectorAll('#tlBar .tl-lane').length);
    const blocks = () => page.eval(() => document.querySelectorAll('#tlBar .tl-v[data-vid]').length);

    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh1"]'), 15000);
    await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (t && !t.classList.contains('active')) t.click();
      const v = document.querySelector('#vcTabs [data-vctab="list"]');
      if (v) v.click();
    });
    await page.waitFor(() => !!document.querySelector('#vcTabs [data-vctab="list"]'), 15000);
    if (await lanes() !== 1) throw new Error('种子的两句配音都应画在第 1 行');
    if (await blocks() !== 2) throw new Error('种子的两句配音没画出来');

    /* 铺一条本机音频（不发请求、不计费）：它走的是与合成同一个落库函数。
       资源选择器用桩，音频地址指向一个取不到字节的站内路径 —— 量不出时长就按 0.5 秒记。 */
    await page.eval(() => {
      window.__picked = 0;
      window.AssetPicker.open = async () => [{ name: '铺一句', src: '/asset/stub-voice-' + (++window.__picked) }];
    });
    const addByFile = async () => {
      await page.eval(() => {
        const b = document.getElementById('voiceFile');
        if (!b) throw new Error('找不到「放一条音频」那颗按钮');
        b.click();
      });
    };

    await addByFile();
    const first = await readWhen(() => {
      const list = [...document.querySelectorAll('#tlBar .tl-v[data-vid]')];
      if (list.length < 3) return null;
      const fresh = list.find(b => !String(b.dataset.vid).startsWith('vo-'));
      if (!fresh) return null;
      const laneEl = fresh.closest('.tl-lane');
      return { lanes: document.querySelectorAll('#tlBar .tl-lane').length,
        ln: Number(laneEl && laneEl.dataset.ln),
        st: (document.getElementById('opState') || {}).textContent || '' };
    }, 15000);
    if (first.ln !== 1) throw new Error('第 1 行在目标时间窗里已被占，新句该落到第 2 行：' + JSON.stringify(first));
    if (first.lanes !== 2) throw new Error('新开了一行，轨道上应该画两条：' + first.lanes);
    if (!/新开的第 2 条配音轨/.test(first.st)) throw new Error('回执没说清新开的是哪一条轨：' + first.st);
    if (!/这个时间窗/.test(first.st)) throw new Error('回执该说清判据是时间窗：' + first.st);

    /* 存盘也要是同一份：ln = 1、整条轨 2 行。 */
    await readWhen(async () => {
      const rec = await window.Kv.at('ws').get('workspace');
      const p = rec && (rec.projects || []).find(x => x.id === 'p-vlane');
      if (!p || !Array.isArray(p.voices) || p.voices.length !== 3) return null;
      const fresh = p.voices.find(v => !String(v.id).startsWith('vo-'));
      /* 行数不再单独落盘（行由内容长出来：轨有几行 = 各句行号的最大值 + 1）——
         落盘的那份事实就是每句自己的 `ln`。 */
      const rows = Math.max.apply(null, p.voices.map(v => Number(v.ln) || 0)) + 1;
      return rows === 2 && fresh && Number(fresh.ln) === 1 ? { rows, ln: fresh.ln } : null;
    }, 12000);

    /* 把 12 行都占在这个位置上：每铺一条就落在新开的一行（行号一路加到 12）。 */
    for (let want = 3; want <= 12; want++) {
      await addByFile();
      await page.eval(n => { window.__wantLanes = n; }, want);
      await page.waitFor(() => document.querySelectorAll('#tlBar .tl-lane').length >= window.__wantLanes, 15000);
    }
    if (await lanes() !== 12) throw new Error('12 行没铺满：' + await lanes());
    const fullBlocks = await blocks();
    if (fullBlocks !== 13) throw new Error('铺满 12 行应有 13 句配音（种子 2 + 新铺 11）：' + fullBlocks);

    /* 再铺一条：12 行都占着这一秒 → 落库时拒绝。错误那一路走顶部错误横幅（`#banner`，
       `setStatus` 只把非错误回执放进 `#opState`），音频已经生成出来但一个字节都不入轨。 */
    const bannerWhen = async (re, timeout = 20000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const t = await page.eval(() => {
          const b = document.getElementById('banner');
          return b && !b.hidden ? ((b.querySelector('.msg') || {}).textContent || '') : '';
        });
        if (re.test(t)) return t;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('横幅里没等到 ' + re + '：' + await bannerText());
    };
    const bannerText = () => page.eval(() => {
      const b = document.getElementById('banner');
      return b && !b.hidden ? ((b.querySelector('.msg') || {}).textContent || '') : '';
    });
    await addByFile();
    const refused = await bannerWhen(/放不下/);
    if (!/12 行/.test(refused)) throw new Error('拒绝时该点明 12 行都占着：' + refused);
    if (!/音频已经生成/.test(refused)) throw new Error('钱已经花了，放不下时必须说明音频在哪：' + refused);
    if (await blocks() !== fullBlocks) throw new Error('放不下的那一句不许硬塞进最后一行');

    /* 合成那一颗：发请求**之前**先问「目标左沿这一秒有没有空行」，12 行全占就当场拒绝。
       合成函数换成计数桩：只要它被调用一次，就说明闸在发请求之后才拦（多花了一次钱）。 */
    await page.eval(() => {
      window.__synth = 0;
      window.AiGen.synthTts = async () => { window.__synth++; return { url: '/asset/should-not' }; };
      const b = document.getElementById('voiceAdd');
      if (!b) throw new Error('找不到「合成并加到这一轨」那颗按钮');
      b.disabled = false;                      // 探针里没有配语音平台，按钮本身是压暗的；这里只验闸
      b.click(); b.click();                    // 第一下武装，第二下执行
    });
    const pre = await bannerWhen(/没有发请求/, 8000);
    if (!/12 行都占着这个位置/.test(pre)) throw new Error('预检那句没说清哪 12 行占着：' + pre);
    if (!/没有计费/.test(pre)) throw new Error('预检那句该说清没有计费：' + pre);
    if (await page.eval(() => window.__synth || 0) !== 0) throw new Error('预检拦下之后仍调了合成（会花一次钱）');
    if (await blocks() !== fullBlocks) throw new Error('预检拦下之后轨道上不该多出块');

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    console.log('✓ 新配音落空轨（时间窗判据 · 行满 12 报数不硬塞 · 合成前预检不发请求）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
