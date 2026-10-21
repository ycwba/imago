#!/usr/bin/env node
/* 字幕与待生成本轮的可拖动 + 右栏精确起止。真实界面走一遍，盯住四条判据：
   ① 字幕块 .tl-sub 带左右把手 .sub-cut：拖把手直接改起止（字幕没有「黑场」），
      拖块体 = 出现时间整体挪；本镜与全片两排同一套手势，写盘只落 subWrite 一处；
   ② 待生成占位 .tl-vp：按住左右拖 = 挪插针（合成落点：本镜按源秒走 setPin、全片走 filmApplyAt），
      点一下仍是「填进右栏生成配音」，刚拖完 600ms 内补的那一下 click 不算；
   ③ 右栏「字幕」的 x 秒到 x 秒两个输入框：已进成片收**成片秒**（mapFromFilm 折回源秒）、
      没进成片收源秒 —— 第二镜那一条是两把尺子分开的地方（成片 6.5 秒 = 源 0.5 秒）；
   ④ 入出点那一行（#trimS/#trimE）：指着一句配音时调它的保留片段（夹取与块上把手同一套，
      退不出框左沿 / 音频第 0 秒之前，越到音频尽头把框撑到那儿），指着画面段时调这一段的
      入出 —— 输入的范围 = 不变黑的范围，灰场只长在输入区间之外。 */
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
      return { pinLeft: pin ? pin.style.left : '', ghost: !!g, ghostText: g ? g.lastChild.textContent : '' };
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
      const off = el && el.querySelector('.vo-off:not(.r)');
      return el && off ? { off: off.style.width } : null;
    }, 8000);
    if (!(parseFloat(vb1.off) > 0)) throw new Error('选区起点在框内该长出左边那块灰：' + JSON.stringify(vb1));
    /* 越到音频尽头：右端顶在 5（1.5 + (4−0.5)），框跟着撑到那儿 */
    const v2 = await setTrim('1.5', '5');
    if (!/这一句配音改为 1\.5–5 秒（框跟着撑到新的保留范围）；音频从第 0\.5 秒起、放 3\.5 秒/.test(v2)) {
      throw new Error('越到音频尽头的输入没按 lim 夹：' + v2);
    }
    /* 退到音频第 0 秒之前：左端顶在 1（off 一路写到 0，不写负） */
    const v3 = await setTrim('0.5', '5');
    if (!/这一句配音改为 1–5 秒；音频从第 0 秒起、放 4 秒/.test(v3)) throw new Error('左端退不过音频 0 秒：' + v3);
    /* v3 之后选区起点与框左沿重合（都退到了 1 秒）：左边那块灰本来就是 0（≤0.02s 不画），
       这一步验证的是块的位置与长度 —— 框 [1,5] 摆在 6 秒轴上 = 左沿 1/6、宽 4/6。 */
    const vb = await readWhen(() => {
      const el = document.querySelector('#tlBar .tl-v[data-vid="vc1"]');
      return el ? { left: el.style.left, width: el.style.width } : null;
    }, 8000);
    if (Math.abs(parseFloat(vb.left) - 100 / 6) > 1.5) throw new Error('退到音频 0 秒后块左沿该钉在框左沿 1 秒：' + vb.left);
    if (Math.abs(parseFloat(vb.width) - 400 / 6) > 1.5) throw new Error('这一句留 4 秒该占 4/6：' + vb.width);

    /* ④b 指着画面段：两框调这一段的入出 —— 输入的范围 = 不变黑的范围，灰场长在区间外 */
    await page.eval(() => document.querySelector('#tlBar .tl-seg[data-seg="0"]').click());
    const trimP = await readWhen(() => {
      const lab = document.getElementById('trimSegLab');
      return lab && /正在调第/.test(lab.textContent)
        ? { s: document.getElementById('trimS').value, e: document.getElementById('trimE').value } : null;
    }, 8000);
    if (trimP.s !== '0' || trimP.e !== '6') throw new Error('画面段那两框该是整段 0–6：' + JSON.stringify(trimP));
    const p1 = await setTrim('0.5', '5.5');
    if (!/已保留 5 秒/.test(p1)) throw new Error('画面入出输入没生效（0.5–5.5 = 留 5 秒）：' + p1);
    const masks = await readWhen(() => {
      const seg = document.querySelector('#tlBar .tl-seg[data-seg="0"]');
      const ml = seg && seg.querySelector('.mask.l'), mr = seg && seg.querySelector('.mask.r');
      return ml && mr ? { l: ml.style.width, r: mr.style.width } : null;
    }, 8000);
    if (!(parseFloat(masks.l) > 0.5 && parseFloat(masks.r) > 0.5)) {
      throw new Error('输入区间之外该长出灰场（不变黑的范围 = 输入的区间）：' + JSON.stringify(masks));
    }

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    const fl = h.logFaults(proxy.log);
    if (fl.length) throw new Error('代理日志有未声明异常：\n' + fl.join('\n'));
    console.log('✓ 字幕块可拖（把手改起止 / 块体挪出现）· 待生成拖 = 挪插针 · 右栏起止两把尺子各收各的秒 · 配音 / 画面入出行可输');
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
