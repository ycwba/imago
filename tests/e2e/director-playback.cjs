#!/usr/bin/env node
/* 播放核（engine/play.js）的判据 —— 主时钟、单一预览面、转场层、字幕叠层、配音对齐：
     ① 点尺子 / 轨道空处 seek：针落到**成片秒**上，读数（#tlT0）跟着走；
     ② 转场窗口（左段尾 dur 秒）里才盖一层 `.preview-transition-layer type-<id>`，
        `--transition-progress` 从 0 走到 1；出窗即撤层，层里放的是下一段的画面；
     ③ 字幕叠层按 start/end 进出（#subWrap）；
     ④ 播放：主时钟推进（针与读数一起走）、画面元素向时钟对齐、
        每一条配音的期望位置 = 源起点 + 块内秒 × 倍速；
     ⑤ 暂停：位置与声音同时停住，读数与针一致；
     ⑥ 播到片尾：停在总长，按键回到「播放」，转场层与字幕都撤掉；
     ⑦ 切页回来（KeepAlive）：播放器还是同一个节点、针还在原来那一秒、剪辑模式没被关掉。
   跑的是产品自己的界面（点轨道空处 seek、点播放键开播），不直接调模块。 */
'use strict';
const fs = require('fs');
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) <= eps;

/* 一条 1 秒的 8kHz / 16-bit 单声道 WAV（440Hz 正弦）—— 配音块用它，
   期望位置只由主时钟算，音色无所谓，能解码、能报 currentTime 就够。 */
function wavDataUrl(seconds, rate) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), 44 + i * 2);
  return 'data:audio/wav;base64,' + buf.toString('base64');
}
const mmss = t => {
  const s = Math.max(0, Number(t) || 0);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};

(async () => {
  const clipFile = h.clipFixture();
  const mp4 = 'data:video/mp4;base64,' + fs.readFileSync(clipFile).toString('base64');
  const wav = wavDataUrl(1, 8000);
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser({ args: ['--autoplay-policy=no-user-gesture-required'] });
    page = await browser.newPage();

    /* 两段各 2 秒：第一段尾挂 0.5 秒淡入淡出（窗口 [1.5, 2.0)）；配音 0.5–1.5；字幕 0.2–1.2；标记 0.8。 */
    const shot = (id, name, vid) => ({
      id, name, prompt: '', line: '', lineWho: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1,
      refImages: [], keyframes: [], selId: vid,
      candidates: [{ vid, provider: 'local', status: 'succeeded', progress: 100, url: mp4, duration: 2, shotId: id }],
    });
    const project = {
      id: 'p-play', name: '播放探针', curScene: 0, curShot: 0,
      scenes: [{ id: 'sc1', name: '场景 1', shots: [shot('sh1', '镜头一', 'v1'), shot('sh2', '镜头二', 'v2')] }],
      film: {
        clips: [
          { id: 'cl1', kind: 'video', shotId: 'sh1', candId: 'v1', name: '镜头一', src: mp4,
            sourceStart: 0, sourceDuration: 2, mediaDuration: 2, duration: 2, transition: { id: 'fade', duration: 0.5 } },
          { id: 'cl2', kind: 'video', shotId: 'sh2', candId: 'v2', name: '镜头二', src: mp4,
            sourceStart: 0, sourceDuration: 2, mediaDuration: 2, duration: 2 },
        ],
        voices: [{ id: 'vo1', text: '这一句要念出来', who: '', start: 0.5, duration: 1,
          sourceStart: 0, sourceDuration: 1, mediaDuration: 1, src: wav, status: 'done' }],
        captions: [{ id: 'cp1', text: '探针字幕', start: 0.2, end: 1.2, position: 'bottom', style: 'default' }],
        markers: [{ id: 'mk1', type: 'marker', time: 0.8, title: '探针标记', color: 'cyan' }],
        tracks: { visibility: {}, locks: {} },
      },
    };
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project], curId: 'p-play', roles: [], groups: [], ts: Date.now() });
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);

    /* 配音元素是 `document.createElement('audio')` 造出来、**不挂进文档**的（播放核自己保活）：
       想读到它们的 currentTime，只能接住这一步。只在探针里包，产品代码不动。 */
    await page.eval(() => {
      window.__probeAudios = [];
      const orig = document.createElement.bind(document);
      document.createElement = function (tag, opts) {
        const el = orig(tag, opts);
        if (String(tag).toLowerCase() === 'audio') window.__probeAudios.push(el);
        return el;
      };
    });

    await page.eval(() => { const t = document.getElementById('trimBtn'); if (t && !t.classList.contains('on')) t.click(); });
    await page.waitFor(() => !!document.querySelector('#tlScroll'), 15000);
    await page.waitFor(() => { const v = document.getElementById('player'); return !!v && v.readyState >= 1; }, 15000, 150)
      .catch(() => { /* 元数据没到也能判针 / 读数 / 转场层；画面那一条下面按 readyState 自己跳过 */ });

    /* 一次读全：比例尺、针、读数、播放键、转场层、字幕、画面元素、配音元素。 */
    const board = () => page.eval(() => {
      const clip = document.querySelector('#tlBoard .tl-clip');
      const dur = clip ? Number(clip.getAttribute('data-dur')) : 0;
      const w = clip ? parseFloat(clip.style.width) : 0;
      const pps = clip && dur && w ? w / dur : 0;
      const head = document.getElementById('tlPlayhead');
      const x = head ? new DOMMatrix(getComputedStyle(head).transform).m41 : NaN;
      const v = document.getElementById('player');
      const voice = (window.__probeAudios || []).find(a => a.__pvVoice);
      const tr = document.getElementById('pvTr');
      return {
        pps, headX: x, t: pps > 0 ? x / pps : NaN,
        t0: (document.getElementById('tlT0') || {}).textContent || '',
        t1: (document.getElementById('tlT1') || {}).textContent || '',
        pbTime: (document.getElementById('pbTime') || {}).textContent || '',
        pbBtn: (document.getElementById('pbBtn') || {}).title || '',
        clips: document.querySelectorAll('#tlBoard .tl-clip').length,
        junctions: document.querySelectorAll('#tlBoard .tl-junction').length,
        hasTr: document.querySelectorAll('#tlBoard .tl-junction.has-tr').length,
        voices: document.querySelectorAll('#tlBoard .tl-voice').length,
        caps: document.querySelectorAll('#tlBoard .tl-cap').length,
        markers: document.querySelectorAll('#tlBoard .tl-marker').length,
        subText: [...document.querySelectorAll('#subWrap .sub-ov')].map(e => e.textContent).join('|'),
        tr: tr ? {
          hidden: tr.hidden, cls: tr.className,
          progress: Number(tr.style.getPropertyValue('--transition-progress') || 'NaN'),
          hasIncoming: !!tr.querySelector('video,img'),
        } : null,
        video: v ? { paused: v.paused, t: v.currentTime, ready: v.readyState } : null,
        voice: voice ? { paused: voice.paused, t: voice.currentTime, ready: voice.readyState } : null,
      };
    });

    /* seek = 点轨道空处的同一颗处理器（pointerdown 落在 #tlScroll 上，不碰任何块）。
       precise = 按住 Alt：那正是产品里「贴着边界也要按秒放针」的唯一走法。 */
    async function seek(t, precise) {
      await page.eval(({ time, alt }) => {
        const sc = document.getElementById('tlScroll');
        const r = sc.getBoundingClientRect();
        const clip = document.querySelector('#tlBoard .tl-clip');
        const pps = parseFloat(clip.style.width) / Number(clip.getAttribute('data-dur'));
        const x = r.left + time * pps - sc.scrollLeft;
        const opt = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: r.top + 12,
          pointerId: 1, pointerType: 'mouse', isPrimary: true, altKey: alt };
        sc.dispatchEvent(new PointerEvent('pointerdown', opt));
        window.dispatchEvent(new PointerEvent('pointerup', opt));
      }, { time: t, alt: !!precise });
      await sleep(120);
    }

    /* ---------------- ① 结构：两段 + 一个转场连接点 + 三条定时条目 ---------------- */
    let s = await board();
    if (s.clips !== 2) throw new Error('画面轨该有两段：' + s.clips);
    if (s.junctions !== 1 || s.hasTr !== 1) throw new Error('两段之间该有一个带转场的连接点：' + s.junctions + ' / ' + s.hasTr);
    if (s.voices !== 1 || s.caps !== 1 || s.markers !== 1) throw new Error('配音 / 字幕 / 标记各该画一条：' + JSON.stringify({ v: s.voices, c: s.caps, m: s.markers }));
    if (s.t1 !== '00:04') throw new Error('成片总长读数该是 00:04：' + s.t1);
    if (!(s.pps > 5)) throw new Error('这一栏太窄，量不出比例尺：' + s.pps);
    const shell = await page.eval(() => ({
      boxes: document.querySelectorAll('#playerWrap .player-box').length,
      player: !!document.querySelector('#playerWrap #player'),
      still: !!document.querySelector('#playerWrap #playerStill'),
      tr: !!document.querySelector('#playerWrap #pvTr'),
      sub: !!document.querySelector('#playerWrap #subWrap'),
    }));
    if (shell.boxes !== 1 || !shell.player || !shell.still || !shell.tr || !shell.sub) {
      throw new Error('预览面该是同一格里的一只视频 + 静止层 + 转场层 + 字幕层：' + JSON.stringify(shell));
    }

    /* ---------------- ② seek：针落到成片秒上；字幕按时间进出 ---------------- */
    await seek(0.7);
    s = await board();
    if (!near(s.t, 0.7, 0.03)) throw new Error('点尺子 seek 到 0.7 秒，针却在 ' + s.t.toFixed(3));
    if (s.t0 !== '00:00') throw new Error('0.7 秒的读数该是 00:00（mm:ss 向下取整）：' + s.t0);
    if (!/探针字幕/.test(s.subText)) throw new Error('0.2–1.2 秒里该有字幕叠层：' + JSON.stringify(s.subText));
    if (!s.tr || !s.tr.hidden) throw new Error('转场窗口之外不该有转场层：' + JSON.stringify(s.tr));

    /* ---------------- ③ 转场窗口：[1.5, 2.0)，进度从 0 到 1 ---------------- */
    await seek(1.7);
    s = await board();
    if (!near(s.t, 1.7, 0.03)) throw new Error('seek 到 1.7 秒，针却在 ' + s.t.toFixed(3));
    if (!s.tr || s.tr.hidden) throw new Error('1.5–2.0 秒该盖着转场层：' + JSON.stringify(s.tr));
    if (!/type-fade/.test(s.tr.cls)) throw new Error('转场层该是 fade：' + s.tr.cls);
    if (!near(s.tr.progress, 0.4, 0.03)) throw new Error('1.7 秒处淡入淡出的进度该是 0.4：' + s.tr.progress);
    if (!s.tr.hasIncoming) throw new Error('转场层里没有下一段的画面（只有一层底色不算转场）');
    if (s.subText) throw new Error('1.7 秒处字幕已经结束，叠层该是空的：' + JSON.stringify(s.subText));

    /* 贴着段边界点一下：吸附把针放到 2.0（边界的另一侧）—— 这是剪辑软件的本事，
       也是这一档最容易被人顺手「改成不吸附」的地方，所以两条都钉住。 */
    await seek(1.95);
    s = await board();
    if (!near(s.t, 2.0, 0.005)) throw new Error('1.95 离段边界 0.05 秒（比例尺 ' + s.pps.toFixed(1) + 'px/秒，吸附半径内），针该吸到 2.0，却在 ' + s.t.toFixed(3));
    if (s.tr && !s.tr.hidden) throw new Error('针已吸到窗口之外（2.0 秒），转场层该撤：' + JSON.stringify(s.tr));

    /* 同一处按住 Alt = 旁路吸附：针留在 1.95，转场层还在窗口里、进度到 0.9。 */
    await seek(1.95, true);
    s = await board();
    if (!near(s.t, 1.95, 0.005)) throw new Error('Alt 点该旁路吸附，针却在 ' + s.t.toFixed(3));
    if (!s.tr || s.tr.hidden) throw new Error('1.95 秒仍在转场窗口里，层不该撤：' + JSON.stringify(s.tr));
    if (!near(s.tr.progress, 0.9, 0.04)) throw new Error('1.95 秒处进度该到 0.9：' + s.tr.progress);

    await seek(1.0);
    s = await board();
    if (!s.tr || !s.tr.hidden) throw new Error('退回窗口之前（1.0 秒）转场层该撤掉：' + JSON.stringify(s.tr));

    await seek(3.2);
    s = await board();
    if (!near(s.t, 3.2, 0.03)) throw new Error('seek 到 3.2 秒，针却在 ' + s.t.toFixed(3));
    if (!s.tr || !s.tr.hidden) throw new Error('最后一段没有「下一段」，不该有转场层：' + JSON.stringify(s.tr));
    if (s.subText) throw new Error('3.2 秒处早已没有字幕：' + JSON.stringify(s.subText));

    /* ---------------- ④ 播放：主时钟推进、画面与配音向时钟对齐 ---------------- */
    await seek(0.3);
    await page.eval(() => document.getElementById('pbBtn').click());
    await page.waitFor(() => (window.__probeAudios || []).some(a => a.__pvVoice && a.readyState >= 1), 8000, 100)
      .catch(() => { /* 配音还没解码出来时下面的断言会点名（元素都没有才是真失败） */ });
    await sleep(450);
    const p1 = await board();
    if (p1.pbBtn !== '暂停') throw new Error('播放中那颗键该是「暂停」：' + p1.pbBtn);
    if (!(p1.t > 0.45 && p1.t < 1.7)) throw new Error('从 0.3 秒播 0.45 秒后针该在 0.75 上下：' + p1.t.toFixed(3));
    if (p1.video && p1.video.ready >= 2 && !p1.video.paused && !near(p1.video.t, p1.t, 0.6)) {
      throw new Error('播放中画面没跟主时钟（成片 ' + p1.t.toFixed(2) + ' 秒，元素 ' + p1.video.t.toFixed(2) + ' 秒）');
    }
    if (!p1.voice) throw new Error('播放起来之后该有一条配音元素在响');
    if (p1.voice.paused) throw new Error('播放到配音块里（0.5–1.5 秒），那一条该在响');
    if (!near(p1.voice.t, Math.max(0, p1.t - 0.5), 0.35)) {
      throw new Error('配音没随主时钟对齐：成片 ' + p1.t.toFixed(2) + ' 秒 → 期望源秒 '
        + Math.max(0, p1.t - 0.5).toFixed(2) + '，实际 ' + p1.voice.t.toFixed(2));
    }
    await sleep(500);
    const p2 = await board();
    if (!(p2.t > p1.t + 0.25)) throw new Error('主时钟没有继续推进：' + p1.t.toFixed(2) + ' → ' + p2.t.toFixed(2));
    if (p2.voice && !near(p2.voice.t, Math.max(0, p2.t - 0.5), 0.35)) {
      throw new Error('第二拍配音也没对齐：成片 ' + p2.t.toFixed(2) + ' 秒 → 期望源秒 '
        + Math.max(0, p2.t - 0.5).toFixed(2) + '，实际 ' + p2.voice.t.toFixed(2));
    }

    /* ---------------- ⑤ 暂停：位置与声音一起停住 ---------------- */
    await page.eval(() => document.getElementById('pbBtn').click());
    await sleep(120);
    const q1 = await board();
    await sleep(450);
    const q2 = await board();
    if (!near(q1.t, q2.t, 0.05)) throw new Error('暂停之后针还在走：' + q1.t.toFixed(3) + ' → ' + q2.t.toFixed(3));
    if (q2.pbBtn !== '播放') throw new Error('暂停之后那颗键该是「播放」：' + q2.pbBtn);
    if (q2.voice && !q2.voice.paused) throw new Error('暂停之后配音该停住');
    if (q2.video && !q2.video.paused) throw new Error('暂停之后画面该停住');
    const wantA = mmss(q2.t) + ' / 00:04';
    const wantB = mmss(Math.max(0, q2.t - 0.02)) + ' / 00:04';
    if (q2.pbTime !== wantA && q2.pbTime !== wantB) {
      throw new Error('暂停时那一行读数该是「' + wantA + '」：' + q2.pbTime);
    }
    if (q2.t0 !== wantA.slice(0, 5)) throw new Error('暂停时轨道读数（#tlT0）与播放键读数不一致：' + q2.t0 + ' / ' + q2.pbTime);

    /* ---------------- ⑥ 播到片尾：停在总长，按键回到「播放」，各层都撤 ---------------- */
    await seek(3.5);
    await page.eval(() => document.getElementById('pbBtn').click());
    const ended = await page.waitFor(() => {
      const el = document.getElementById('pbTime');
      return !!el && el.textContent === '00:04 / 00:04';
    }, 6000, 100).then(() => true).catch(() => false);
    if (!ended) throw new Error('播到片尾没有停住（读数没到 00:04 / 00:04）：' + (await board()).pbTime);
    await sleep(150);
    const end = await board();
    if (end.pbBtn !== '播放') throw new Error('播到片尾那颗键该回到「播放」：' + end.pbBtn);
    if (end.t0 !== '00:04') throw new Error('片尾的轨道读数该是 00:04：' + end.t0);
    if (!near(end.t, 4, 0.08)) throw new Error('片尾的针该停在 4 秒：' + end.t.toFixed(3));
    if (end.video && !end.video.paused) throw new Error('片尾画面该停住');
    if (!end.tr || !end.tr.hidden) throw new Error('片尾不该留着转场层：' + JSON.stringify(end.tr));
    if (end.subText) throw new Error('片尾不该留着字幕：' + JSON.stringify(end.subText));

    /* ---------------- ⑦ 切页回来：同一个播放器节点、针还在那一秒、剪辑模式还在 ---------------- */
    await seek(1.2);
    const before = await board();
    await page.eval(() => {
      window.__probePlayer = document.getElementById('player');
      window.__probeBoard = document.getElementById('tlBoardBody');
      window.GoPage.go('favorites.html');
    });
    await page.waitFor(() => location.hash.indexOf('favorites') >= 0, 15000, 150);
    await sleep(300);
    await page.eval(() => window.GoPage.go('director.html'));
    await page.waitFor(() => {
      const t = document.getElementById('trimBtn');
      return !!t && !!document.getElementById('tlScroll');
    }, 20000, 150);
    await sleep(300);
    const after = await board();
    const kept = await page.eval(() => ({
      player: document.getElementById('player') === window.__probePlayer && !!window.__probePlayer,
      board: document.getElementById('tlBoardBody') === window.__probeBoard && !!window.__probeBoard,
      trim: (() => { const t = document.getElementById('trimBtn'); return !!t && t.classList.contains('on'); })(),
      boardShown: (() => { const b = document.getElementById('tlBoard'); return !!b && !b.hidden; })(),
    }));
    if (!kept.player) throw new Error('切页回来播放器被换了节点（等于重新载入素材，状态丢了）');
    if (!kept.trim || !kept.boardShown) throw new Error('切页回来剪辑模式或时间线板没恢复：' + JSON.stringify(kept));
    if (after.t0 !== before.t0) throw new Error('切页回来针的读数变了：' + before.t0 + ' → ' + after.t0);
    if (!near(after.t, before.t, 0.06)) {
      throw new Error('切页回来针的位置变了：' + before.t.toFixed(3) + ' → ' + after.t.toFixed(3));
    }

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    const faults = h.logFaults(proxy.log);
    if (faults.length) throw new Error('代理故障：' + faults.slice(0, 3).join(' | '));
    console.log('✓ 播放核：seek 落成片秒 · 转场窗口内出层出进度（窗口外撤层）· 字幕按时间进出 · '
      + '播放推进且画面 / 配音向主时钟对齐 · 暂停停住 · 片尾停在总长 · 切页回来节点与针都不丢');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    try { if (page) page.close(); } catch (e) {}
    try { if (browser) await browser.close(); } catch (e) {}
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
