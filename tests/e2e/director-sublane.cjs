#!/usr/bin/env node
/* 字幕与待生成轨的真实界面走一遍，盯住这几条判据：
   ① 字幕块 .tl-sub 带左右把手 .sub-cut：拖把手直接改起止（字幕没有「黑场」），
      拖块体 = 出现时间整体挪；本镜与全片两排同一套手势，写盘只落 subWrite 一处；
      点块体 = 把针放到**点击处**（右栏留在「字幕」那一档）；
   ② 待生成占位 .tl-vp：点一下 = 把这一句的落点搬到点击处（块左沿的轴秒、插针与右栏那句「段内 +X 秒」
      三者同一个数；落盘的是段内源秒 = 它 + 这一段的入点）并填进右栏「生成配音」；
      按住左右拖 = 块自己跟手走（宽度不变），松手才落盘；
      刚拖完 600ms 内补的那一下 click 不算，过了这一阵再点必须开面板；
   ③ 右栏「字幕」的 x 秒到 x 秒两个输入框：已进成片收**成片秒**（mapFromFilm 折回源秒）、
      没进成片收源秒 —— 第二镜那一条是两把尺子分开的地方（成片 6.5 秒 = 源 0.5 秒）；
   ④ 入出点那一行（#trimS/#trimE）：指着一句配音时调它的保留片段（夹取与块上把手同一套，
      退不出框左沿 / 音频第 0 秒之前，越到音频尽头把框撑到那儿），指着画面段时调这一段的
      入出 —— 输入的范围 = 进成片的那一截；截掉的头尾**不再画成遮挡**，块 / 格子当场按选区变窄，
      后面的格子在轴上整体前移（所以本镜那一排的轴总长会跟着这一行改）；
   ⑤ 拖字幕块 / 待生成块时跟手卡用的是它们自己那一张（`.tl-ghost.sub` / `.tl-ghost.pend`，
      图位整块不画）—— 借一格画面切片来显示「一句话」，等于把手里拿的东西说成别的；
      拖完字幕块 / 拉完把手补发的那一下 click 不放针、也不翻右栏；
   ⑥ 四条轨是同一把尺子画的：轨名那一格与右边那一排同高、配音 / 待生成 / 字幕三排同高、
      三块块体同高，三排把手同宽且贴满块沿（不留缝），块上是 grab、把手是 ew-resize、
      攥着那一档 grabbing 各有规则；框内那层灰遮挡（`.mask` / `.vo-off`）一个节点都不留。 */
'use strict';
const h = require('./harness.cjs');

(async () => {
  const shot = (id, name, prompt, line, lineWho, dur) => ({
    id, name, prompt, line, lineWho,
    ar: '16:9', res: '768p', tier: 'fast', draw: 1,
    refImages: [], keyframes: [], selId: 'v-' + id,
    candidates: [{ vid: 'v-' + id, provider: 'local', status: 'succeeded', progress: 100,
      url: '', duration: dur, shotId: id }],
  });
  const project = {
    id: 'p-sublane', name: '字幕拖动探针', curScene: 0, curShot: 0,
    /* 一句已合成的配音（镜头 A 第 1 段 +1 秒起、念 2 秒，框 1–4 / 源音频 4 秒）：
       没有文字 → 待生成占位照旧在、字幕也不从它派生；src 留空 → 波形那一步对空地址直接跳过。 */
    voices: [{ id: 'vc1', shotId: 'sh1', candId: 'v-sh1', seg: 0, at: 1, dur: 2, vol: 1,
      src: '', name: '第一句', spd: 1, off: 0, fa: 1, fb: 4, srcDur: 4 }],
    scenes: [{ id: 'sc1', name: '场景 1', shots: [
      shot('sh1', '镜头 A', 'A 的画面', '第一句台词', '林夏', 6),
      shot('sh2', '镜头 B', 'B 的画面', '第二句台词', '', 4),
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
    const readWhen = async (fn, timeout = 10000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn);
        if (v) return v;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('等待超时：' + String(fn).slice(0, 80));
    };
    /* 一次拖动拆成三步发（按下 / 移动 / 松手），中途的插针与跟手卡才看得见。 */
    const down = sel => page.eval(sel => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('找不到 ' + sel);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
      return { x, y };
    }, sel);
    const moveTo = (x, y) => page.eval((x, y) => {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
      const pin = document.querySelector('.tl-pin');
      const g = document.querySelector('.tl-ghost');
      const gi = g ? g.querySelector('i') : null;
      const vp = document.querySelector('#tlBar .tl-vp');
      return {
        pinLeft: pin ? pin.style.left : '',
        ghost: !!g, ghostText: g ? g.lastChild.textContent : '',
        ghostCls: g ? g.className : '', ghostKind: g ? (g.classList.contains('sub') ? 'sub' : g.classList.contains('pend') ? 'pend' : '') : '',
        ghostShown: gi ? getComputedStyle(gi).display : '',
        ghostBg: gi ? gi.style.backgroundImage : '',
        vpLeft: vp ? vp.style.left : '', vpWidth: vp ? vp.style.width : '',
      };
    }, x, y);
    const up = (x, y) => page.eval((x, y) => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
      return (document.getElementById('opState') || {}).textContent || '';
    }, x, y);
    /* #tlBar 的几何（拖动落点 = bar 左沿 + bar 宽 × 秒/轴长）：处理与探针读的是同一张矩形。 */
    const barRect = () => page.eval(() => {
      const b = document.getElementById('tlBar');
      const r = b.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });

    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh2"]'), 15000);

    /* 进剪辑（本镜页签）。两条轨此刻的账：镜头 A 6 秒（轴 = 源，没切没倍速）、镜头 B 4 秒，
       全片轴 = 10 秒 —— 下面所有秒数都是照这两个数手算的。 */
    await page.eval(() => { const t = document.getElementById('trimBtn'); if (t && !t.classList.contains('active')) t.click(); });
    await page.waitFor(() => !!document.querySelector('#tlBar .tl-sub[data-shot="sh1"]'), 15000);

    /* ① 字幕块带把手，读数是这一排的尺子（镜头 A 在成片开头，成片秒 = 源秒） */
    const sub0 = await page.eval(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      return {
        cuts: el.querySelectorAll('.sub-cut').length,
        l: !!el.querySelector('.sub-cut.l'), r: !!el.querySelector('.sub-cut.r'),
        title: el.title, left: el.style.left, width: el.style.width,
      };
    });
    if (sub0.cuts !== 2 || !sub0.l || !sub0.r) throw new Error('字幕块该带左右两枚把手：' + JSON.stringify(sub0));
    if (!/0–1\.2 秒（成片秒）/.test(sub0.title)) throw new Error('字幕块读数不对（第一镜 0–1.2 秒）：' + sub0.title);
    if (sub0.left !== '0%') throw new Error('第一条字幕应从 0 摆起：' + sub0.left);
    const seeded = await page.eval(() => ({
      v: !!document.querySelector('#tlBar .tl-v[data-vid="vc1"]'),
      vp: !!document.querySelector('#tlBar .tl-vp[data-shot="sh1"]'),
    }));
    if (!seeded.v) throw new Error('种下的配音块没画出来');
    if (!seeded.vp) throw new Error('有台词没配音的镜头该有待生成占位');

    /* 拖右把手 +0.6 秒：只长右端，起点不动 */
    const h0 = await down('#tlBar .tl-sub[data-shot="sh1"] .sub-cut.r');
    const dx06 = Math.round(0.6 * (await barRect()).width / 6);
    await moveTo(h0.x + dx06, h0.y);
    const upSt = await up(h0.x + dx06, h0.y);
    const sub1 = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      return el ? { title: el.title, width: el.style.width, left: el.style.left } : null;
    }, 8000);
    if (!/0–1\.8 秒（成片秒）/.test(sub1.title)) throw new Error('拖右把手后终点应是 1.8 秒：' + sub1.title);
    if (sub1.left !== '0%') throw new Error('拖右把手不该动起点：' + sub1.left);
    if (parseFloat(sub1.width) <= parseFloat(sub0.width)) throw new Error('拖右把手后块该变宽：' + sub0.width + ' → ' + sub1.width);
    if (!/✓ 这一条字幕改为 0 – 1\.8 秒（成片秒）/.test(upSt)) throw new Error('松手回执不对：' + upSt);

    /* 拖块体 +0.4 秒：头尾一起挪，长度不变（位移从按下点起算，与手势同一条基线） */
    const b0 = await down('#tlBar .tl-sub[data-shot="sh1"]');
    const dx04 = Math.round(0.4 * (await barRect()).width / 6);
    await moveTo(b0.x + dx04, b0.y);
    const upSt2 = await up(b0.x + dx04, b0.y);
    const sub2 = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      return el ? { title: el.title, width: el.style.width, left: el.style.left } : null;
    }, 8000);
    if (!/0\.4–2\.2 秒（成片秒）/.test(sub2.title)) throw new Error('拖块体后头尾应一起挪到 0.4–2.2：' + sub2.title);
    if (sub2.width !== sub1.width) throw new Error('拖块体不该改长度：' + sub1.width + ' → ' + sub2.width);
    if (!/✓ 这一条字幕改为 0\.4 – 2\.2 秒（成片秒）/.test(upSt2)) throw new Error('挪块回执不对：' + upSt2);

    /* ② 待生成占位：按住拖 = 挪插针到第 2 秒（跟手卡 + 针当场跟上），松手报合成落点 */
    const vp = await down('#tlBar .tl-vp[data-shot="sh1"]');
    const bar3 = await barRect();
    const tx = bar3.left + bar3.width * (2 / 6);
    const mid = await moveTo(tx, 300);
    if (!mid.ghost) throw new Error('拖待生成占位时该有跟手卡');
    if (mid.ghostKind !== 'pend') throw new Error('待生成块的跟手卡该是待生成自己那一张：' + mid.ghostCls);
    if (!/秒/.test(mid.ghostText)) throw new Error('跟手卡该报当前秒数：' + mid.ghostText);
    if (Math.abs(parseFloat(mid.pinLeft) - 100 * 2 / 6) > 1.5) throw new Error('拖动中插针该跟到第 2 秒：' + mid.pinLeft);
    const vpSt = await up(tx, 300);
    if (!/下一句配音会合成在「镜头 A」第 1\/1 段的 \+2 秒/.test(vpSt)) throw new Error('拖完该报合成落点：' + vpSt);
    const hint = await page.eval(() => (document.getElementById('tlHint') || {}).textContent || '');
    if (!/插针 2 秒/.test(hint)) throw new Error('插针读数该跟上：' + hint);
    /* 刚拖完的那一下 click 不算「点进生成配音」 */
    const suppressed = await page.eval(() => {
      const el = document.querySelector('#tlBar .tl-vp[data-shot="sh1"]');
      if (!el || !el.isConnected) return { alive: false };
      el.click();
      return { alive: true, text: (document.getElementById('voiceText') || {}).value || '' };
    });
    if (!suppressed.alive) throw new Error('松手后占位符不该被整栏重建换掉');
    if (suppressed.text) throw new Error('刚拖完的 click 不该把台词填进「生成配音」：' + suppressed.text);
    await new Promise(r => setTimeout(r, 700));
    await page.eval(() => { const el = document.querySelector('#tlBar .tl-vp[data-shot="sh1"]'); if (el) el.click(); });
    const gen = await readWhen(() => {
      const ta = document.getElementById('voiceText');
      return ta && ta.value ? { text: ta.value } : null;
    }, 8000);
    if (gen.text !== '第一句台词') throw new Error('点占位符该把这一句填进「生成配音」：' + gen.text);

    /* ③ 右栏「字幕」：两个输入框收的是右栏那一把尺子上的秒（这一镜已进成片 = 成片秒） */
    await page.eval(() => document.querySelector('#vcTabs [data-vctab="sub"]').click());
    const subTab = await readWhen(() => {
      const g = document.getElementById('grpSub');
      const st = document.querySelector('.sub-row[data-subi="0"] .sub-t[data-subt="start"]');
      const en = document.querySelector('.sub-row[data-subi="0"] .sub-t[data-subt="end"]');
      return g && !g.hidden && st && en ? { start: st.value, end: en.value } : null;
    }, 8000);
    if (subTab.start !== '0.4' || subTab.end !== '2.2') {
      throw new Error('右栏起止读数该与轨道同账（0.4–2.2）：' + JSON.stringify(subTab));
    }
    await page.eval(() => {
      document.querySelector('.sub-row[data-subi="0"] .sub-t[data-subt="end"]').value = '2.4';
      document.querySelector('.sub-row[data-subi="0"] .sub-t[data-subt="end"]')
        .dispatchEvent(new Event('change', { bubbles: true }));
    });
    const sub3 = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      return el && /2\.4 秒（成片秒）/.test(el.title) ? { title: el.title } : null;
    }, 8000);
    if (!/0\.4–2\.4 秒/.test(sub3.title)) throw new Error('输入终点 2.4 后块该落在 0.4–2.4：' + sub3.title);

    /* 全片页签：镜头 B 那条是两把尺子分开的地方（成片 6 秒 = 源 0 秒） */
    await page.eval(() => document.querySelector('.tl-tabs [data-tab="film"]').click());
    const film0 = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh2"]');
      return el ? { title: el.title } : null;
    }, 8000);
    if (!/成片 6–7\.2 秒/.test(film0.title)) throw new Error('全片那排镜头 B 的字幕应报成片 6–7.2 秒：' + film0.title);

    /* 全片那排拖右把手 +0.6 秒（只能在镜头 B 自己的框区间里走；位移同样从按下点起算） */
    const f0 = await down('#tlBar .tl-sub[data-shot="sh2"] .sub-cut.r');
    const dxB = Math.round(0.6 * (await barRect()).width / 10);
    await moveTo(f0.x + dxB, f0.y);
    const upSt3 = await up(f0.x + dxB, f0.y);
    const film1 = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh2"]');
      return el && /7\.8 秒/.test(el.title) ? { title: el.title } : null;
    }, 8000);
    if (!/成片 6–7\.8 秒/.test(film1.title)) throw new Error('全片拖右把手后该是成片 6–7.8 秒：' + film1.title);
    if (!/✓ 这一条字幕改为 6 – 7\.8 秒（成片秒）/.test(upSt3)) throw new Error('全片拖动回执该按成片秒报：' + upSt3);

    /* 全片那一排的待生成占位：拖 = filmApplyAt（焦点切过去 + 针放到那儿） */
    await down('#tlBar .tl-vp[data-shot="sh2"]');
    const bar5 = await barRect();
    const tx8 = bar5.left + bar5.width * (8 / 10);
    await moveTo(tx8, 300);
    const vpSt2 = await up(tx8, 300);
    if (!/已跳到全片轨第 8 秒，焦点切到「镜头 B」第 1\/1 段/.test(vpSt2)) {
      throw new Error('全片拖占位该走 filmApplyAt 报焦点：' + vpSt2);
    }

    /* 右栏给镜头 B 的字幕行：起点收**成片秒** 6.5，折回源秒 0.5 —— 两个读数从此各走各的尺子 */
    await page.eval(() => document.querySelector('#vcTabs [data-vctab="sub"]').click());
    const sh2Row = await readWhen(() => {
      const st = document.querySelector('.sub-row[data-subi="0"] .sub-t[data-subt="start"]');
      const en = document.querySelector('.sub-row[data-subi="0"] .sub-t[data-subt="end"]');
      return st && en ? { start: st.value, end: en.value } : null;
    }, 8000);
    if (sh2Row.start !== '6' || sh2Row.end !== '7.8') {
      throw new Error('镜头 B 的右栏读数该是成片秒 6–7.8：' + JSON.stringify(sh2Row));
    }
    await page.eval(() => {
      document.querySelector('.sub-row[data-subi="0"] .sub-t[data-subt="start"]').value = '6.5';
      document.querySelector('.sub-row[data-subi="0"] .sub-t[data-subt="start"]')
        .dispatchEvent(new Event('change', { bubbles: true }));
    });
    const sh2Set = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh2"]');
      return el && /成片 6\.5–7\.8 秒/.test(el.title) ? { title: el.title } : null;
    }, 8000);
    if (!/成片 6\.5–7\.8 秒/.test(sh2Set.title)) throw new Error('输入成片 6.5 后全片读数该是 6.5–7.8：' + JSON.stringify(sh2Set));

    /* 回本镜页签验证同一件事：镜头 B 那排的块摆在源 0.5 秒处（0.5/4 = 12.5%），读数仍是成片秒 */
    await page.eval(() => document.querySelector('.tl-tabs [data-tab="shot"]').click());
    const sh2Shot = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh2"]');
      return el && el.dataset.src === '0.5' ? { left: el.style.left, title: el.title } : null;
    }, 8000);
    if (Math.abs(parseFloat(sh2Shot.left) - 12.5) > 1.5) throw new Error('本镜那排该按源秒 0.5/4 摆：' + sh2Shot.left);
    if (!/6\.5–7\.8 秒（成片秒）/.test(sh2Shot.title)) throw new Error('本镜读数也该报成片秒：' + sh2Shot.title);

    /* ④a 入出点那一行指着一句配音：两框调它的保留片段（夹取与块上把手同一套） */
    await page.eval(() => document.querySelector('.shot-item[data-sid="sh1"]').click());
    await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-v[data-vid="vc1"]');
      return el ? { ok: true } : null;
    }, 8000);
    await page.eval(() => document.querySelector('#tlBar .tl-v[data-vid="vc1"]').click());
    const trimV = await readWhen(() => {
      const lab = document.getElementById('trimSegLab');
      return lab && /这一句配音/.test(lab.textContent)
        ? { s: document.getElementById('trimS').value, e: document.getElementById('trimE').value,
            note: (document.getElementById('trimNote') || {}).textContent || '' } : null;
    }, 8000);
    if (trimV.s !== '1' || trimV.e !== '3') throw new Error('配音那两框该是选区 1–3（源秒）：' + JSON.stringify(trimV));
    if (!/从第 0 秒起/.test(trimV.note)) throw new Error('提示该说音频自己的偏移：' + trimV.note);
    const setTrim = (s, e) => page.eval((s, e) => {
      const is = document.getElementById('trimS'), ie = document.getElementById('trimE');
      is.value = s; ie.value = e;
      ie.dispatchEvent(new Event('change', { bubbles: true }));
      return (document.getElementById('opState') || {}).textContent || '';
    }, s, e);
    /* 区间内：at/off/dur 各走各的量纲（at 源秒、off/dur 音频文件秒） */
    const v1 = await setTrim('1.5', '2.5');
    if (!/这一句配音改为 1\.5–2\.5 秒；音频从第 0\.5 秒起、放 1 秒/.test(v1)) throw new Error('配音区间内输入不对：' + v1);
    const vb1 = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-v[data-vid="vc1"]');
      return el ? { left: el.style.left, width: el.style.width,
        lab: (el.querySelector('.vt') || {}).textContent || '' } : null;
    }, 8000);
    /* 剪过头尾之后**块画的就是选区**：1.5–2.5 那 1 秒摆在 6 秒轴上 = 左沿 25%、宽 16.67%，
       框 [1,3] 不再占地方，也不再画成块里的一块灰（旧的那一层已删 —— 界面上不许有「看着占位但不进成片」的东西）。 */
    if (Math.abs(parseFloat(vb1.left) - 150 / 6) > 1.5) throw new Error('块左沿该跟到选区起点 1.5 秒：' + JSON.stringify(vb1));
    if (Math.abs(parseFloat(vb1.width) - 100 / 6) > 1.5) throw new Error('留 1 秒该占 1/6：' + JSON.stringify(vb1));
    if (!/·\s*1s/.test(vb1.lab)) throw new Error('块上那行秒数该报选区（1 秒）而不是框：' + vb1.lab);
    /* 越到音频尽头：右端顶在 5（1.5 + (4−0.5)），框跟着撑到那儿 */
    const v2 = await setTrim('1.5', '5');
    if (!/这一句配音改为 1\.5–5 秒（框跟着撑到新的保留范围）；音频从第 0\.5 秒起、放 3\.5 秒/.test(v2)) {
      throw new Error('越到音频尽头的输入没按 lim 夹：' + v2);
    }
    /* 退到音频第 0 秒之前：左端顶在 1（off 一路写到 0，不写负） */
    const v3 = await setTrim('0.5', '5');
    if (!/这一句配音改为 1–5 秒；音频从第 0 秒起、放 4 秒/.test(v3)) throw new Error('左端退不过音频 0 秒：' + v3);
    /* v3 之后选区起点与框左沿重合（都退到了 1 秒）：这一步验证的是块的位置与长度 ——
       选区 [1,5] 摆在 6 秒轴上 = 左沿 1/6、宽 4/6（块画的就是选区，框不再占地方）。 */
    const vb = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-v[data-vid="vc1"]');
      return el ? { left: el.style.left, width: el.style.width } : null;
    }, 8000);
    if (Math.abs(parseFloat(vb.left) - 100 / 6) > 1.5) throw new Error('退到音频 0 秒后块左沿该钉在框左沿 1 秒：' + vb.left);
    if (Math.abs(parseFloat(vb.width) - 400 / 6) > 1.5) throw new Error('这一句留 4 秒该占 4/6：' + vb.width);

    /* ④b 指着画面段：两框调这一段的入出 —— 输入的范围 = 进成片的那一截，区间之外**不再画遮挡**：
       这一格当场按选区排版（后面的格子在轴上整体前移），名称行那格报的就是选区那 5 秒，
       title 另外把「框 0–6 秒 = 把手往外拖的上限」说出来。 */
    await page.eval(() => document.querySelector('#tlBar .tl-seg[data-seg="0"]').click());
    const trimP = await readWhen(() => {
      const lab = document.getElementById('trimSegLab');
      return lab && /正在调第/.test(lab.textContent)
        ? { s: document.getElementById('trimS').value, e: document.getElementById('trimE').value } : null;
    }, 8000);
    if (trimP.s !== '0' || trimP.e !== '6') throw new Error('画面段那两框该是整段 0–6：' + JSON.stringify(trimP));
    const p1 = await setTrim('0.5', '5.5');
    if (!/已保留 5 秒/.test(p1)) throw new Error('画面入出输入没生效（0.5–5.5 = 留 5 秒）：' + p1);
    const cells = await readWhen(() => {
      const seg = document.querySelector('#tlBar .tl-seg[data-seg="0"]');
      const t1 = document.getElementById('tlT1');
      return seg && t1 ? { w: parseFloat(seg.style.width), ax: t1.textContent,
        dur: (seg.querySelector('.seg-dur') || {}).textContent || '',
        tip: seg.title, mask: !!seg.querySelector('.mask') } : null;
    }, 8000);
    if (cells.mask) throw new Error('剪掉的头尾不再画成遮挡（那一层已删）：' + JSON.stringify(cells));
    if (!(cells.w > 98)) throw new Error('选区 5 秒就是这一排的整条轴，格子该占满：' + JSON.stringify(cells));
    /* 名称行那格报的是**进成片的那一截**（5 秒），不再是框那 6 秒。 */
    if (cells.dur !== '00:05') throw new Error('格子小字该报选区 5 秒：' + JSON.stringify(cells));
    if (!/用源视频 0\.5–5\.5 秒，成片里占 5 秒/.test(cells.tip)) throw new Error('格子 title 该报选区：' + cells.tip);
    /* 框只剩一个用处：把手往外拖的上限 —— title 必须把这两个数也说出来。 */
    if (!/框是 0–6 秒，把手往外拖最多恢复到这儿/.test(cells.tip)) throw new Error('格子 title 该报框上限：' + cells.tip);
    if (Math.abs(parseFloat(cells.ax) - 5) > 0.05) throw new Error('轴总长该跟着选区缩到 5 秒（剪掉的 1 秒不占地方）：' + cells.ax);

    /* ⑤ 点字幕块中部：针落在点击处（不是字幕起点），右栏留在「字幕」那一档 */
    const innerRect = () => page.eval(() => {
      const r = document.getElementById('tlInner').getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    const clickAt = (sel, fx) => page.eval((sel, fx) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('找不到 ' + sel);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width * fx, y = r.top + r.height / 2;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      return { x: x, y: y, left: r.left, width: r.width };
    }, sel, fx);
    const pinState = () => page.eval(() => {
      const p = document.querySelector('#tlBar .tl-pin');
      return p ? { left: parseFloat(p.style.left) } : null;
    });
    /* ④b 已在 6 秒的候选上剪掉一头一尾共 1 秒，本镜那一排按**选区**摊开 → 轴总长只剩 5 秒
       （上面 `#tlT1` 已经盯过这一个数）。这一段候选没切没倍速，所以轴秒 = 源秒 − 入点。
       ⚠ `readWhen` 的回调在页面里跑、拿不到这里的闭包变量，那几处换算把 5 写死。 */
    const axS = 5;
    const ir0 = await innerRect();
    const subHit = await clickAt('#tlBar .tl-sub[data-shot="sh1"]', 0.5);
    const wantSub = (subHit.x - ir0.left) / Math.max(1, ir0.width) * axS;
    if (Math.abs(wantSub - 0.4) < 0.2) throw new Error('点击处贴着字幕起点，判不出「落在点击处」：' + wantSub);
    const pinAfterSub = await readWhen(() => {
      const p = document.querySelector('#tlBar .tl-pin');
      return p ? { left: parseFloat(p.style.left) } : null;
    }, 8000);
    if (Math.abs(pinAfterSub.left / 100 * axS - wantSub) > 0.2) {
      throw new Error('点字幕块中部，针该落在点击处 ' + wantSub + ' 秒：' + pinAfterSub.left + '%');
    }
    const subPanel = await page.eval(() => ({
      sub: !(document.getElementById('grpSub') || {}).hidden,
      title: (document.getElementById('edTitle') || {}).textContent || '',
    }));
    if (!subPanel.sub || subPanel.title !== '字幕') throw new Error('点字幕块右栏该留在「字幕」：' + JSON.stringify(subPanel));

    /* ⑥ 点待生成块：块、针、右栏那行读数三者恒等，且右栏翻到「生成配音」 */
    await page.eval(() => {
      window.__errs = [];
      window.addEventListener('error', e => window.__errs.push(String(e.message)));
      window.addEventListener('unhandledrejection', e => window.__errs.push('rej:' + String((e.reason && e.reason.message) || e.reason)));
    });
    const ir1 = await innerRect();
    const vpHit = await clickAt('#tlBar .tl-vp[data-shot="sh1"]', 0.5);
    const wantVp = (vpHit.x - ir1.left) / Math.max(1, ir1.width) * axS;
    const inv = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-vp[data-shot="sh1"]');
      const p = document.querySelector('#tlBar .tl-pin');
      const gen = document.getElementById('grpVoiceAdd');
      const pos = document.getElementById('voicePos');
      if (!el || !p || !gen || gen.hidden) return null;
      return { left: parseFloat(el.style.left), width: parseFloat(el.style.width), pin: parseFloat(p.style.left),
        pos: pos ? pos.textContent : '', title: (document.getElementById('edTitle') || {}).textContent || '' };
    }, 8000).catch(async () => {
      const d = await page.eval(() => {
        const el = document.querySelector('#tlBar .tl-vp[data-shot="sh1"]');
        return {
          vp: [...document.querySelectorAll('#tlBar .tl-vp')].map(e => (e.dataset.shot || '') + '@' + e.style.left),
          vpOn: el ? typeof el.onclick : '(none)', vpConn: el ? el.isConnected : null,
          pin: !!document.querySelector('#tlBar .tl-pin'),
          gen: (document.getElementById('grpVoiceAdd') || {}).hidden,
          ed: (document.getElementById('edTitle') || {}).textContent,
          on: [...document.querySelectorAll('#vcTabs [data-vctab].on')].map(e => e.dataset.vctab),
          op: (document.getElementById('opState') || {}).textContent,
          text: (document.getElementById('voiceText') || {}).value,
          errs: (window.__errs || []).slice(0, 8),
        };
      });
      throw new Error('点待生成之后右栏没翻到「生成配音」：' + JSON.stringify(d));
    });
    if (Math.abs(inv.left / 100 * axS - wantVp) > 0.2) {
      throw new Error('点待生成块，块该跳到点击处 ' + wantVp + ' 秒：' + inv.left + '%');
    }
    if (Math.abs(inv.pin / 100 * axS - wantVp) > 0.2) {
      throw new Error('点待生成块，针该在点击处 ' + wantVp + ' 秒：' + inv.pin + '%');
    }
    if (inv.title !== '加一句配音') throw new Error('点待生成块右栏该翻到「生成配音」：' + inv.title);
    /* 右栏那一行报**两个**数：段内偏移与「源里第几秒」。④b 把入点改到 0.5 之后这两个数不再相等：
       块左沿与插针读的是轴秒，而这一段是第 1 格（从轴 0 起、没倍速），所以轴秒 = 段内偏移；
       源里 = 段内偏移 + 入点。 */
    const posBoth = /段的 \+([\d.]+) 秒（源里 ([\d.]+) 秒/.exec(inv.pos);
    if (!posBoth) throw new Error('右栏那句落点该同时报段内偏移与源里第几秒：' + inv.pos);
    if (Math.abs(Number(posBoth[1]) - wantVp) > 0.2) {
      throw new Error('右栏的段内偏移该与块左沿（轴秒）是同一个数（期望 + ' + wantVp + ' 秒）：' + inv.pos);
    }
    if (Math.abs(Number(posBoth[2]) - (wantVp + 0.5)) > 0.2) {
      throw new Error('「源里」该是段内偏移 + 入点 0.5（期望 ' + (Math.round((wantVp + 0.5) * 10) / 10) + ' 秒）：' + inv.pos);
    }

    /* ⑦ 拖待生成块：块自己跟手走、宽度不变、针同步；跟手卡是待生成自己那一张（不借画面切片）；
       松手落盘，台词本身一个字都不动 */
    const vpLeft0 = inv.left, vpWidth0 = inv.width;
    const pd = await down('#tlBar .tl-vp[data-shot="sh1"]');
    const ir2 = await innerRect();
    const tx45 = ir2.left + ir2.width * (4.5 / axS);
    const pdm = await moveTo(tx45, 320);
    if (!pdm.ghost) throw new Error('拖待生成块时该有跟手卡');
    if (pdm.ghostKind !== 'pend' || pdm.ghostShown !== 'none' || pdm.ghostBg) {
      throw new Error('待生成的跟手卡不该借画面切片（该是自己的虚线卡）：'
        + JSON.stringify({ cls: pdm.ghostCls, shown: pdm.ghostShown, bg: pdm.ghostBg }));
    }
    if (!(parseFloat(pdm.vpLeft) > parseFloat(vpLeft0) + 5)) {
      throw new Error('拖动中块自己该跟着走：' + vpLeft0 + '% → ' + pdm.vpLeft + '%');
    }
    if (Math.abs(parseFloat(pdm.vpWidth) - vpWidth0) > 0.01) {
      throw new Error('挪落点不该改块宽：' + vpWidth0 + '% → ' + pdm.vpWidth + '%');
    }
    if (Math.abs(parseFloat(pdm.pinLeft) / 100 * axS - 4.5) > 0.2) {
      throw new Error('拖待生成块时针该跟到 4.5 秒：' + pdm.pinLeft);
    }
    const vpUp = await up(tx45, 320);
    /* 报的是合成落点 = 段内偏移。块按**选区**排版之后段内偏移与轴秒是同一个数（这一格是第 1 格，
       选区左沿就摆在轴 0）；源里那一秒还要再加 ④b 的入点 0.5 = 5.0。 */
    if (!/下一句配音会合成在「镜头 A」第 1\/1 段的 \+4\.5 秒/.test(vpUp)) throw new Error('拖完该报新的合成落点：' + vpUp);
    const vpAfter = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-vp[data-shot="sh1"]');
      const p = document.querySelector('#tlBar .tl-pin');
      if (!el || !p || Math.abs(parseFloat(el.style.left) / 100 * 5 - 4.5) > 0.2) return null;
      return { left: parseFloat(el.style.left), pin: parseFloat(p.style.left) };
    }, 8000);
    if (Math.abs(vpAfter.pin / 100 * axS - 4.5) > 0.2) throw new Error('松手后针该停在 4.5 秒：' + vpAfter.pin);
    /* 落盘的是 `sh.lineAt` = **段内源秒**（从这一段的起点数，这一段 a=0），
       而块左沿、插针与回执说的是轴秒 / 成片秒（选区那一截）：④b 之后两者差一个入点 0.5，
       所以拖到轴 4.5 秒 = 源里 5.0 秒。两个数各归各的尺子，这里盯的是「差值恰好是入点」。 */
    const saved = await readWhen(async () => {
      const rec = await window.Kv.at('ws').get('workspace');
      const p = (rec && rec.projects || []).find(x => x.id === 'p-sublane');
      const sh = p && p.scenes && p.scenes[0] && p.scenes[0].shots[0];
      return sh && sh.lineAt != null && Math.abs(Number(sh.lineAt) - 5) < 0.2
        ? { line: sh.line, who: sh.lineWho, at: sh.lineAt, seg: sh.lineSeg } : null;
    }, 8000).catch(async () => {
      const raw = await page.eval(async () => {
        const rec = await window.Kv.at('ws').get('workspace');
        const p = (rec && rec.projects || []).find(x => x.id === 'p-sublane');
        const sh = p && p.scenes && p.scenes[0] && p.scenes[0].shots[0];
        return { at: sh && sh.lineAt, seg: sh && sh.lineSeg, line: sh && sh.line };
      });
      throw new Error('拖完待生成块，落点该以段内源秒 5.0 落盘（轴 4.5 秒 + 入点 0.5）：' + JSON.stringify(raw));
    });
    if (saved.line !== '第一句台词' || saved.who !== '林夏') {
      throw new Error('挪落点不该动台词本身：' + JSON.stringify(saved));
    }
    if (Number(saved.seg) !== 0) throw new Error('落点该在第 1 段：' + JSON.stringify(saved));

    /* ⑧ 点回字幕块取一个已知的针位，再拖块体 / 拖把手：两下拖动都不该把针带走，
       松手补发的那一下 click 也不该放针（真浏览器在拖完松手会补一次 click）。
       ④b 之前这一条字幕是源 0.4–2.4 —— 剪过一刀之后**头那一截不再进成片**：
       块夹在轴 0、只画选区里剩下的 1.9 秒，成片读数跟着报 0–1.9（块画的就是选区，没有遮挡层）。 */
    const subGeo = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      return el ? { left: parseFloat(el.style.left), width: parseFloat(el.style.width), title: el.title } : null;
    }, 8000);
    if (subGeo.left > 0.5 || Math.abs(subGeo.width - 100 * 1.9 / axS) > 2) {
      throw new Error('剪过头之后字幕块该夹在轴 0、只占选区里剩下的 1.9 秒：' + JSON.stringify(subGeo));
    }
    if (!/·\s*0–1\.9 秒（成片秒）/.test(subGeo.title)) throw new Error('夹过的字幕该报成片 0–1.9 秒：' + subGeo.title);
    await clickAt('#tlBar .tl-sub[data-shot="sh1"]', 0.5);
    /* 针落点由 ⑤ 那条判据盯（点击处 = 针），这里只取「拖动之前针在哪」这一个基准。 */
    const pinBase = await pinState();
    if (!pinBase) throw new Error('点字幕块之后插针没了：' + JSON.stringify(subGeo));
    const sd = await down('#tlBar .tl-sub[data-shot="sh1"]');
    const irS = await innerRect();
    const txS = sd.x + irS.width * (0.5 / axS);
    const sm = await moveTo(txS, sd.y);
    if (!sm.ghost) throw new Error('拖字幕块时该有跟手卡');
    if (sm.ghostKind !== 'sub' || sm.ghostShown !== 'none' || sm.ghostBg) {
      throw new Error('字幕块的跟手卡不该借画面切片（该是自己的那张字幕卡）：'
        + JSON.stringify({ cls: sm.ghostCls, shown: sm.ghostShown, bg: sm.ghostBg }));
    }
    await up(txS, sd.y);
    /* 块体往右 0.5 秒：起算点是**看得见的那一块**的左沿（轴 0），不是被剪掉的那个源 0.4 ——
       所以到源 1.0，成片尺子上是 0.5–2.4（长度还是 1.9 秒，块体挪动不改它）。 */
    const bodyAfter = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      return el && /0\.5–2\.4 秒（成片秒）/.test(el.title) ? { title: el.title } : null;
    }, 8000).catch(async () => {
      const v = await page.eval(() => {
        const el = document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
        return el ? { title: el.title, src: el.dataset.src, left: el.style.left, width: el.style.width } : null;
      });
      throw new Error('拖块体 +0.5 秒之后该报成片 0.5–2.4 秒：' + JSON.stringify(v));
    });
    /* 拖动补发的 click：目标就是松手处那一个节点（重画之后按坐标重新取） */
    await page.eval((x, y) => {
      const el = document.elementFromPoint(x, y) || document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, txS, sd.y);
    const pinAfterBody = await pinState();
    if (Math.abs(pinAfterBody.left / 100 * axS - pinBase.left / 100 * axS) > 0.2) {
      throw new Error('拖完字幕块补发的那一下 click 不该放针：' + JSON.stringify({ before: pinBase, after: pinAfterBody, title: bodyAfter.title }));
    }
    const hd = await down('#tlBar .tl-sub[data-shot="sh1"] .sub-cut.r');
    const irH = await innerRect();
    const txH = hd.x + irH.width * (0.3 / axS);
    await moveTo(txH, hd.y);
    await up(txH, hd.y);
    /* 右把手再往右 0.3 秒：起点跟着上一步的 0.5，终点 2.4 + 0.3 = 2.7。 */
    await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      return el && /0\.5–2\.7 秒（成片秒）/.test(el.title) ? { title: el.title } : null;
    }, 8000);
    await page.eval((x, y) => {
      const el = document.elementFromPoint(x, y) || document.querySelector('#tlBar .tl-sub[data-shot="sh1"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, txH, hd.y);
    const pinAfterCut = await pinState();
    if (Math.abs(pinAfterCut.left - pinBase.left) > 0.3) {
      throw new Error('拉字幕把手松手后的 click 不该放针：' + JSON.stringify({ before: pinBase, after: pinAfterCut }));
    }
    const stillSub = await page.eval(() => !(document.getElementById('grpSub') || {}).hidden);
    if (!stillSub) throw new Error('拖字幕把手不该把右栏翻走');

    /* ⑨ 刷新之后：块仍停在新落点（落盘的是 sh.lineAt/lineSeg）；针回到 ⑧ 那一下手点的位置
       （它随 cutAt 一起落了盘）—— 两份状态各落各的。 */
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    await page.eval(() => { const t = document.getElementById('trimBtn'); if (t && !t.classList.contains('active')) t.click(); });
    const reloaded = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-vp[data-shot="sh1"]');
      const p = document.querySelector('#tlBar .tl-pin');
      if (!el || !p || Math.abs(parseFloat(el.style.left) / 100 * 5 - 4.5) > 0.25) return null;
      return { left: parseFloat(el.style.left), pin: parseFloat(p.style.left),
        line: (document.querySelector('#lineListMine [data-line-text]') || {}).textContent || '' };
    }, 15000);
    if (Math.abs(reloaded.pin - pinBase.left) > 0.3) {
      throw new Error('刷新后针该回到 ⑧ 那一下手点的位置（' + pinBase.left + '%）：' + reloaded.pin + '%');
    }
    if (!/第一句台词/.test(reloaded.line)) throw new Error('刷新后台词该原样还在：' + reloaded.line);

    /* ⑩ 拖到别处之后再点：落点按点击处重写，不被拽回第一段起点 */
    const ir3 = await innerRect();
    const vp2 = await clickAt('#tlBar .tl-vp[data-shot="sh1"]', 0.5);
    const want2 = (vp2.x - ir3.left) / Math.max(1, ir3.width) * axS;
    if (want2 < 4) throw new Error('这一次点击该落在拖过去之后的位置：' + want2);
    const moved2 = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-vp[data-shot="sh1"]');
      const p = document.querySelector('#tlBar .tl-pin');
      const gen = document.getElementById('grpVoiceAdd');
      /* 只等「块确实停在右端」这一步（左沿 ≥80% = ⑦ 拖过去的那个落点还在），
         具体秒数交给下面两条按现算的 `want2` / `axS` 去比 —— 别在这里写死一个轴的刻度。 */
      if (!el || !p || !gen || gen.hidden || parseFloat(el.style.left) < 80) return null;
      return { left: parseFloat(el.style.left), pin: parseFloat(p.style.left) };
    }, 8000).catch(async () => {
      const dbg = await page.eval(() => {
        const els = Array.from(document.querySelectorAll('#tlBar .tl-vp')).map(e => ({
          shot: e.dataset.shot, left: e.style.left, width: e.style.width, title: e.title }));
        return { els, pin: (document.querySelector('#tlBar .tl-pin') || {}).style?.left,
          gen: !!(document.getElementById('grpVoiceAdd') && !document.getElementById('grpVoiceAdd').hidden) };
      });
      throw new Error('待生成块没停在右端：' + JSON.stringify(dbg));
    });
    if (moved2.left / 100 * axS < 4) throw new Error('再点一次不该把块拽回第一段起点：' + moved2.left);
    if (Math.abs(moved2.pin / 100 * axS - want2) > 0.25) {
      throw new Error('再点一次针该落在新的点击处 ' + want2 + ' 秒：' + moved2.pin);
    }

    /* ⑪ 四条轨是同一把尺子画的（用户点名「轨道高度、悬停与拖动时的光标要统一」）：
       以前每排各写各的 —— 把手 9px 与 13px 并存、块离轨框 3px 与 4px 并存、光标一处 default
       一处 ns-resize，鼠标扫过轨道一直在变形状，看起来像四件不同的东西。这里量的是界面现状：
       左右两列的行高、三块块体自己的高、三排把手的宽与贴沿、抓取与改起止两档光标。 */
    const uni = await page.eval(() => {
      const grid = document.querySelector('.tl-grid');
      const gv = k => Math.round(parseFloat(getComputedStyle(grid).getPropertyValue(k)));
      const miss = [];
      const q = (sel, name) => { const e = document.querySelector(sel); if (!e) miss.push(name + '（' + sel + '）'); return e; };
      const box = e => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height),
          bt: Math.round(parseFloat(s.borderTopWidth) || 0), bb: Math.round(parseFloat(s.borderBottomWidth) || 0),
          bl: Math.round(parseFloat(s.borderLeftWidth) || 0), br: Math.round(parseFloat(s.borderRightWidth) || 0) }; };
      const out = { miss, vars: { pic: gv('--tlh-pic'), voice: gv('--tlh-voice'), inset: gv('--tlh-inset') },
        rows: {}, blocks: {}, handles: {}, cursors: {} };
      /* 左列那一格轨名 ↔ 右列那一排轨道：同一档只从同一枚变量取高（错开一格 = 「这个名字指着哪一轨」是假话） */
      [['pic', '.tl-hrow.pic', '#tlBar .tl-vrow'], ['voice', '.tl-hrow.voice', '#tlBar .tl-lane'],
        ['pend', '.tl-hrow.pend', '#tlBar .tl-vp-lane'], ['sub', '.tl-hrow.sub', '#tlBar .tl-sub-lane']]
        .forEach(([k, a, b]) => {
          const ea = q(a, k + ' 轨名'), eb = q(b, k + ' 轨道');
          out.rows[k] = { lab: ea ? Math.round(parseFloat(getComputedStyle(ea).height)) : null,
            lane: eb ? Math.round(parseFloat(getComputedStyle(eb).height)) : null };
        });
      /* 三条块状轨上的块：同一种「上下各留 --tlh-inset」，所以三块必须逐像素同高 */
      [['vo', '#tlBar .tl-lane .tl-v'], ['pend', '#tlBar .tl-vp-lane .tl-vp'], ['sub', '#tlBar .tl-sub-lane .tl-sub']]
        .forEach(([k, s]) => { const e = q(s, k + ' 块'); out.blocks[k] = e ? box(e).h : null; });
      /* 三排把手：宽、光标、抓手线，还有「贴不贴块沿」（用户报的「左右把手和片段间有空隙」量的就是最后这条） */
      [['pic', '#tlBar .tl-vrow .tl-seg', '.cut'], ['voice', '#tlBar .tl-lane .tl-v', '.vo-cut'],
        ['sub', '#tlBar .tl-sub-lane .tl-sub', '.sub-cut']].forEach(([k, blockSel, cutSel]) => {
        const bl = q(blockSel, k + ' 块体');
        const l = q(blockSel + ' ' + cutSel + '.l', k + ' 左把手'), r = q(blockSel + ' ' + cutSel + '.r', k + ' 右把手');
        const cl = l && getComputedStyle(l);
        const pb = l && getComputedStyle(l, '::before'), pa = l && getComputedStyle(l, '::after');
        out.handles[k] = bl && l && r ? {
          w: Math.round(parseFloat(cl.width)), cursor: cl.cursor,
          block: box(bl), l: box(l), r: box(r),
          grip: [Math.round(parseFloat(pb.width)), Math.round(parseFloat(pb.height)),
            Math.round(parseFloat(pa.width)), Math.round(parseFloat(pa.height))],
        } : null;
      });
      /* 块上的光标：按下去是「拿起来挪」，四排同一档 grab（把手才是 ew-resize） */
      [['seg', '#tlBar .tl-vrow .tl-seg'], ['v', '#tlBar .tl-lane .tl-v'],
        ['vp', '#tlBar .tl-vp-lane .tl-vp'], ['sub', '#tlBar .tl-sub-lane .tl-sub']]
        .forEach(([k, s]) => { const e = document.querySelector(s); out.cursors[k] = e ? getComputedStyle(e).cursor : null; });
      /* 攥着那一档（:active → grabbing）写在样式表里：合成事件点不出 :active，所以从 CSSOM 现读，
         要递归进 @scope / @media 那几层嵌套。 */
      const act = {};
      const walk = rs => { for (const rr of rs || []) {
        if (rr.cssRules && rr.cssRules.length) { walk(rr.cssRules); continue; }
        const st = rr.selectorText || '';
        if (!/:active\b/.test(st) || !rr.style || rr.style.cursor !== 'grabbing') continue;
        for (const k of ['tl-seg', 'tl-v', 'tl-vp', 'tl-sub']) if (st.includes('.' + k + ':active')) act[k] = st;
      } };
      for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) { /* 跨源的表不读 */ } }
      out.active = act;
      return out;
    });
    if (uni.miss.length) throw new Error('本镜那一屏缺轨道节点，统一性没法量：' + uni.miss.join('、'));
    Object.keys(uni.rows).forEach(k => {
      const v = uni.rows[k];
      if (v.lab !== v.lane) throw new Error('轨名那一格与右边那一排轨道不同高（' + k + '）：' + JSON.stringify(v));
    });
    const picH = uni.rows.pic.lane, voiceH = uni.rows.voice.lane;
    if (picH !== uni.vars.pic) throw new Error('画面那一排该是 --tlh-pic（' + uni.vars.pic + '）高：' + JSON.stringify(uni.rows));
    if (voiceH !== uni.vars.voice || uni.rows.pend.lane !== voiceH || uni.rows.sub.lane !== voiceH) {
      throw new Error('配音 / 待生成 / 字幕三排该同高（都吃 --tlh-voice=' + uni.vars.voice + '）：' + JSON.stringify(uni.rows));
    }
    const bs = uni.blocks;
    if (!(bs.vo === bs.pend && bs.pend === bs.sub)) {
      throw new Error('三条块状轨上的块该逐像素同高（同一枚 --tlh-inset=' + uni.vars.inset + '）：' + JSON.stringify({ blocks: bs, rows: uni.rows }));
    }
    if (!(bs.vo > 0 && bs.vo < voiceH)) throw new Error('块该比轨道矮一截（上下各留 inset），不是铺死：' + JSON.stringify({ blocks: bs, voiceH }));
    const hs = uni.handles;
    Object.keys(hs).forEach(k => {
      const v = hs[k];
      if (v.cursor !== 'ew-resize') throw new Error(k + ' 那一排的把手光标该是 ew-resize（改起止，不是挪块）：' + v.cursor);
      if (v.w !== hs.pic.w) throw new Error('三排把手该同宽（画面 13px 那一档）：' + JSON.stringify(hs));
      if (v.grip.join() !== hs.pic.grip.join() || v.grip[0] !== 1 || v.grip[1] !== 18) {
        throw new Error('把手上那两条抓手线该逐排相同（1×18px）：' + JSON.stringify(hs));
      }
      /* 把手是块内的绝对定位件（`left/right: 0`、`top/bottom: 0`）：量的基准是**去掉边框**那一圈，
         所以贴沿 / 贴高都按边框补偿后的数比 —— 不补偿的话每排都差那 1px 边框，看着像留了缝。 */
      const inner = v.block.h - v.block.bt - v.block.bb;
      if (Math.abs(v.l.l - (v.block.l + v.block.bl)) > 1 || Math.abs(v.r.r - (v.block.r - v.block.br)) > 1) {
        throw new Error('左右把手该贴在块沿上（中间没有缝）：' + JSON.stringify({ 块: v.block, 左: v.l, 右: v.r }));
      }
      if (Math.abs(v.l.h - inner) > 1 || Math.abs(v.r.h - inner) > 1) {
        throw new Error('把手该贴满块高（块高扣上下边框 = ' + inner + '）：' + JSON.stringify({ 块: v.block, 左: v.l.h, 右: v.r.h }));
      }
    });
    Object.keys(uni.cursors).forEach(k => {
      if (uni.cursors[k] !== 'grab') throw new Error('块上的光标该是 grab（按下去拿起来挪）：' + JSON.stringify(uni.cursors));
    });
    ['tl-seg', 'tl-v', 'tl-vp', 'tl-sub'].forEach(k => {
      if (!uni.active[k]) throw new Error('缺「攥着那一块时变 grabbing」那一档（.' + k + ':active）：' + JSON.stringify(uni.active));
    });
    /* 剪掉的头尾不再画遮挡 —— 这条判据在这一屏顺手数一遍（三排块/格子里一个都不该留） */
    const oldMask = await page.eval(() => {
      const n = document.querySelectorAll('#tlBar .mask, #tlBar .vo-off').length;
      return n;
    });
    if (oldMask) throw new Error('框内那层灰遮挡已整个删掉，轨道上不该再有 .mask / .vo-off 节点：' + oldMask);

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    const fl = h.logFaults(proxy.log);
    if (fl.length) throw new Error('代理日志有未声明异常：\n' + fl.join('\n'));
    console.log('✓ 字幕块可拖（把手改起止 / 块体挪出现）· 待生成拖 = 挪插针 · 右栏起止两把尺子各收各的秒 · 配音 / 画面入出行可输 · 点块 = 针落在点击处 · 字幕与待生成的跟手卡各是自己的那一张 · 落点刷新后还在 · 四轨同高同把手同光标且框内无遮挡');
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
