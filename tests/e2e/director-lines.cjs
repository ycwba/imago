#!/usr/bin/env node
/* 台词只剩一处面板：剪辑右栏「台词」那一档（镜头编辑右栏那一份已删，剧本里也没有台词了）。
   这一条走真实界面，盯住本轮改动的五条判据：
   ① 镜头编辑右栏一件台词控件都不剩；
   ② 剪辑右栏「台词」分本镜 / 全片两段：每行左边是说话人在素材库里的样子（对不上画占位图、名字照留），
      每行带「第 N 镜 + 本镜秒 + 全片秒」三个读数，那两个时间与轨道上斜纹占位用的是同一把尺子；
   ③ 写完一句自己就上本镜与全片那两条「待生成配音」轨，不用点任何按钮；
   ④ 改台词一个字节不动提示词，改提示词（剧本里改画面）也不动台词；
   ⑤ 说话人名字对上素材库时缩略图立刻换成那一位（台词仍由 AI 按画面生成，审阅里改得动）。 */
'use strict';
const h = require('./harness.cjs');

/* 素材库里就一位「林夏」：图用 1×1 的 dataURL，mediaSrc 原样放过（同源 CSP 的 img-src 认 data:）。 */
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const shot = (id, name, prompt, line, lineWho, dur) => ({
    id, name, prompt, line, lineWho,
    ar: '16:9', res: '768p', tier: 'fast', draw: 1,
    refImages: [], keyframes: [], selId: 'v-' + id,
    /* 一条选用的候选，只给时长、不给可播地址：两个时间读数要的是几何，不是字节。
       没有 segs 就是一整段（入 0 出 duration）。 */
    candidates: [{ vid: 'v-' + id, provider: 'local', status: 'succeeded', progress: 100,
      url: '', duration: dur, shotId: id }],
  });
  const project = {
    id: 'p-lines', name: '台词探针', curScene: 0, curShot: 0,
    scenes: [{ id: 'sc1', name: '场景 1', shots: [
      shot('sh1', '镜头 A', 'A 的画面', '第一句台词', '林夏', 6),
      shot('sh2', '镜头 B', 'B 的画面', '', '', 4),
    ] }],
    /* 三句配音：两句同一角色、一句另一个角色。分轨按声音来源归行、合轨全部回第 1 行；
       三句都带着 who / voice / src，验证「谁在说」这一级在真实数据上成立（而不是永远落到音色 / 素材）。 */
    voices: [
      { id: 'vo1', shotId: 'sh2', candId: 'v-sh2', seg: 0, at: 0.5, dur: 1, vol: 1, src: '/asset/voice-1',
        name: '小美一', text: '一句配音', who: '小美', voice: 'qing', provider: '本机', model: '' },
      { id: 'vo2', shotId: 'sh2', candId: 'v-sh2', seg: 0, at: 2, dur: 1, vol: 0.8, src: '/asset/voice-2',
        name: '小美二', text: '再来一句', who: '小美', voice: 'qing', provider: '本机', model: '' },
      { id: 'vo3', shotId: 'sh2', candId: 'v-sh2', seg: 0, at: 3, dur: 1, vol: 1, src: '/asset/voice-3',
        name: '阿强一', text: '阿强的配音', who: '阿强', voice: 'shen', provider: '本机', model: '' },
    ],
  };
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    /* 工作区落在 IndexedDB（`Kv.at('ws')`），素材库落在 localStorage 信封（`char_lib`）：
       都先种好再进导演台，第一帧画出来的台词行才带着「库里有这一位」的缩略图。 */
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Kv, 15000);
    await page.eval(async rec => { await window.Kv.at('ws').put('workspace', rec); },
      { projects: [project], curId: project.id, roles: [], ts: Date.now() });
    await page.eval((k, env) => { localStorage.setItem(k, JSON.stringify({ data: env, ts: Date.now() })); },
      'char_lib', [{ name: '林夏', anchor: PNG1 }]);
    await page.goto(proxy.base + '/shell.html#director.html');
    await page.waitFor(() => window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').ready(), 25000);
    /* waitFor 只回布尔；这里要读回一次现算的快照 */
    const readWhen = async (fn, timeout = 10000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const v = await page.eval(fn);
        if (v) return v;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('等待超时：' + String(fn).slice(0, 80));
    };

    await page.waitFor(() => !!document.querySelector('.shot-item[data-sid="sh2"]'), 15000);

    /* ① 镜头编辑右栏（提示词下面那一片）已经把台词整块交出去了 */
    const outside = await page.eval(() => ({
      panel: !!document.getElementById('lineList'),
      cnt: !!document.getElementById('lineCnt'),
      btn: !!document.getElementById('lineToVoice'),
      rows: document.querySelectorAll('.line-row').length,
      editors: document.querySelectorAll('[data-line-text], [data-line-who]').length,
    }));
    if (outside.panel || outside.cnt || outside.btn) throw new Error('镜头编辑右栏还留着台词组件：' + JSON.stringify(outside));
    if (outside.rows || outside.editors) throw new Error('没进剪辑就不该有台词行与台词控件：' + JSON.stringify(outside));

    /* 进剪辑：本镜那一排此刻只有第一镜的斜纹占位（第二镜还没台词） */
    await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (t && !t.classList.contains('active')) t.click();
    });
    await page.waitFor(() => !!document.querySelector('#vcTabs [data-vctab="lines"]'), 15000);
    const lane0 = await page.eval(() => ({
      pend: [...document.querySelectorAll('#tlBar .tl-vp')].map(e => e.dataset.shot).join(','),
      linesShown: (() => { const g = document.getElementById('grpLines'); return !!g && !g.hidden; })(),
    }));
    if (lane0.linesShown) throw new Error('没点「台词」那一档时那一格就该收起（#grpLines 没 hidden）');
    if (lane0.pend !== 'sh1') throw new Error('本镜那一排的待生成占位应只有带台词的那一镜：' + lane0.pend);

    /* ② 切到「台词」这一档：只有这一块露出来，标题跟着换 */
    await page.eval(() => document.querySelector('#vcTabs [data-vctab="lines"]').click());
    const tab = await readWhen(() => {
      const g = document.getElementById('grpLines');
      if (!g || g.hidden) return null;
      const shown = ['grpPic', 'grpVoice', 'grpVoiceAdd', 'grpVoiceList', 'grpSub']
        .filter(id => { const e = document.getElementById(id); return e && !e.hidden; });
      return {
        title: (document.getElementById('edTitle') || {}).textContent || '',
        onlyOne: shown.length === 0,
        mineCnt: (document.getElementById('lineCntMine') || {}).textContent || '',
        allCnt: (document.getElementById('lineCntAll') || {}).textContent || '',
        mineRows: [...document.querySelectorAll('#lineListMine .line-row')].map(r => r.dataset.lineshot),
        allRows: [...document.querySelectorAll('#lineListAll .line-row')].map(r => r.dataset.lineshot),
        hint: (document.querySelector('#lineListAll .hint') || {}).textContent || '',
        dlOptions: [...document.querySelectorAll('#lineWhoList option')].map(o => o.value),
      };
    }, 8000);
    if (tab.title !== '台词') throw new Error('右栏标题应是「台词」：' + tab.title);
    if (!tab.onlyOne) throw new Error('切到台词那一档后别的那些格没收起：' + JSON.stringify(tab));
    /* 当前是镜头 A：它自己有台词 → 本镜那一行；镜头 B 还没写 → 全片那一栏空着并说清 */
    if (tab.mineRows.join(',') !== 'sh1') throw new Error('本镜台词应只列当前这一镜：' + tab.mineRows.join(','));
    if (tab.allRows.length) throw new Error('第二镜还没台词，全片那一栏不该列出它：' + tab.allRows.join(','));
    if (!/还没有别的台词/.test(tab.hint)) throw new Error('全片那一栏空着时应说清：' + tab.hint);
    if (tab.mineCnt !== '5 字 · 待生成') throw new Error('本镜那句读数不对：' + tab.mineCnt);
    if (tab.allCnt !== '1 句 · 待生成 1') throw new Error('全片那句读数不对：' + tab.allCnt);
    if (!tab.dlOptions.includes('林夏')) throw new Error('说话人下拉应带上素材库那一位：' + tab.dlOptions.join(','));

    /* 本镜那一行：素材库对得上的说话人画真缩略图，三个读数齐（第 N 镜 / 本镜秒 / 全片秒） */
    const row1 = await readWhen(() => {
      const r = document.querySelector('#lineListMine .line-row[data-lineshot="sh1"]');
      if (!r) return null;
      const when = [...r.querySelectorAll('.lr-when span')].map(s => s.textContent.trim());
      return {
        img: !!r.querySelector('.lr-thumb img'),
        ph: !!r.querySelector('.lr-thumb.ph'),
        thumbSrc: (r.querySelector('.lr-thumb img') || {}).src || '',
        who: (r.querySelector('input.lr-name') || {}).value || '',
        text: (r.querySelector('textarea[data-line-text="sh1"]') || {}).value || '',
        state: (r.querySelector('.lr-top em') || {}).textContent || '',
        when,
      };
    }, 8000);
    if (!row1.img || row1.ph) throw new Error('说话人「林夏」在素材库里，缩略图该画那一位：' + JSON.stringify(row1));
    if (!/^data:image\/png/.test(row1.thumbSrc)) throw new Error('缩略图地址没走素材的 anchor：' + row1.thumbSrc);
    if (row1.who !== '林夏' || row1.text !== '第一句台词') throw new Error('这一行读的不是镜头上的那一份：' + JSON.stringify(row1));
    if (row1.state !== '待生成') throw new Error('有台词没配音时状态应是待生成：' + row1.state);
    if (row1.when.join('|') !== '第 1 镜|本镜 0–1.2 秒|全片 0–1.2 秒') throw new Error('本镜那一行三个读数不对：' + row1.when.join('|'));

    /* 切到还没写台词的那一镜：本镜那一行留着空行（否则「在本镜台词里写第一句」指向一片空气），
       第一镜那句挪到「全片台词」里，仍然一行、仍然可改 */
    await page.eval(() => document.querySelector('.shot-item[data-sid="sh2"]').click());
    const flip = await readWhen(() => {
      const mine = document.querySelector('#lineListMine .line-row[data-lineshot="sh2"]');
      const all = document.querySelector('#lineListAll .line-row[data-lineshot="sh1"]');
      if (!mine || !all) return null;
      const em = mine.querySelector('.lr-top em');
      const when = [...all.querySelectorAll('.lr-when span')].map(s => s.textContent.trim());
      return {
        state: (em || {}).textContent || '',
        cntMine: (document.getElementById('lineCntMine') || {}).textContent || '',
        cntAll: (document.getElementById('lineCntAll') || {}).textContent || '',
        editableMine: !!mine.querySelector('textarea[data-line-text="sh2"]'),
        ph: !!mine.querySelector('.lr-thumb.ph'),
        whoPh: (mine.querySelector('input.lr-name') || {}).placeholder || '',
        dupWho: !!mine.querySelector('.lr-who'),
        when,
      };
    }, 8000);
    if (flip.state !== '未写') throw new Error('当前这一镜没台词时那一行应写「未写」：' + flip.state);
    if (flip.cntMine !== '还没写') throw new Error('本镜读数应直说还没写：' + flip.cntMine);
    if (!flip.editableMine) throw new Error('空镜那一行也得能就地写：' + JSON.stringify(flip));
    if (!flip.ph) throw new Error('没写说话人时应留占位图：' + JSON.stringify(flip));
    if (flip.whoPh !== '说话的人' || flip.dupWho) throw new Error('说话的人只该有一件控件：' + JSON.stringify(flip));
    if (flip.cntAll !== '1 句 · 待生成 1') throw new Error('全片读数按整片算，不该跟着本镜走：' + flip.cntAll);
    /* 两个时间各走各的尺子，各自带单位。第一镜在全片开头，两处都是 0 起（这本身也是一条判据：
       它说明「全片」读的是成片秒，不是随手抄的本镜秒 —— 第二镜那一行才是两者分开的地方） */
    if (flip.when[0] !== '第 1 镜') throw new Error('全片那一行要写镜号：' + flip.when.join('|'));
    if (flip.when.join('|') !== '第 1 镜|本镜 0–1.2 秒|全片 0–1.2 秒') throw new Error('第一镜那一行三个读数不对：' + flip.when.join('|'));

    /* ③ 就地写第一句 + 说话人：写完它自己上两条待生成轨（不点任何按钮） */
    const typed = await page.eval(() => {
      const ta = document.querySelector('#lineListMine textarea[data-line-text="sh2"]');
      ta.value = '第二句台词';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const row = ta.closest('.line-row');
      return {
        state: (row.querySelector('.lr-top em') || {}).textContent || '',
        cntMine: (document.getElementById('lineCntMine') || {}).textContent || '',
        cntAll: (document.getElementById('lineCntAll') || {}).textContent || '',
        when: [...row.querySelectorAll('.lr-when span')].map(s => s.textContent.trim()),
        pend: [...document.querySelectorAll('#tlBar .tl-vp')].map(e => e.dataset.shot).join(','),
      };
    });
    if (typed.state !== '待生成') throw new Error('写了台词之后状态应变成待生成：' + typed.state);
    if (typed.cntMine !== '5 字 · 待生成') throw new Error('本镜读数没跟上：' + typed.cntMine);
    if (typed.cntAll !== '2 句 · 待生成 2') throw new Error('全片读数没跟上：' + typed.cntAll);
    if (!/^第 2 镜$/.test(typed.when[0])) throw new Error('每行要带镜号：' + typed.when.join('|'));
    /* 这一行才是那两把尺子分开的地方：本镜那一排从这一镜自己的 0 起，
       全片那一排接着前一镜（6 秒）往后摆 —— 两个数不是抄同一份 */
    if (typed.when.join('|') !== '第 2 镜|本镜 0–1.2 秒|全片 6–7.2 秒') {
      throw new Error('第二镜那一行的本镜 / 全片时间不对：' + typed.when.join('|'));
    }
    /* input 只改数据（不重画整栏，否则光标跳走）；失焦那一下才上轨 */
    if (/sh2/.test(typed.pend)) throw new Error('还在敲的时候不该重画轨道（光标会跳）：' + typed.pend);

    const landed = await page.eval(() => {
      const ta = document.querySelector('#lineListMine textarea[data-line-text="sh2"]');
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return [...document.querySelectorAll('#tlBar .tl-vp')].map(e => e.dataset.shot).sort().join(',');
    });
    if (landed !== 'sh2') throw new Error('台词写完没自己上本镜那一排的「待生成配音」轨：' + landed);

    /* 全片那一排同样长出第二个占位，位置跟台词行里读的那两个数是同一把尺子 */
    await page.eval(() => document.querySelector('.tl-tabs [data-tab="film"]').click());
    const film = await readWhen(() => {
      const vp = [...document.querySelectorAll('#tlBar .tl-vp')];
      if (vp.length < 2) return null;
      return {
        shots: vp.map(e => e.dataset.shot).sort().join(','),
        sh2Left: vp.find(e => e.dataset.shot === 'sh2').style.left,
        sh1Left: vp.find(e => e.dataset.shot === 'sh1').style.left,
        cntAll: (document.getElementById('lineCntAll') || {}).textContent || '',
      };
    }, 8000);
    if (film.shots !== 'sh1,sh2') throw new Error('全片那一排的待生成占位不齐：' + film.shots);
    if (film.cntAll !== '2 句 · 待生成 2') throw new Error('切轨之后台词读数仍是同一份：' + film.cntAll);
    if (!(parseFloat(film.sh2Left) > parseFloat(film.sh1Left))) throw new Error('第二镜的占位应排在第一镜之后：' + film.sh1Left + ' vs ' + film.sh2Left);

    /* ⑤ 说话人名字对上素材库 → 缩略图立刻换成那一位（素材关联仍在这里，音色是合成那一步取） */
    const who = await page.eval(() => {
      const inp = document.querySelector('#lineListMine input[data-line-who="sh2"]');
      inp.value = '林夏';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const row = inp.closest('.line-row');
      return {
        img: !!row.querySelector('.lr-thumb img'),
        ph: !!row.querySelector('.lr-thumb.ph'),
        title: (row.querySelector('.lr-thumb') || {}).title || '',
      };
    });
    if (!who.img || who.ph) throw new Error('名字对上素材库后缩略图没换：' + JSON.stringify(who));
    if (who.title !== '林夏') throw new Error('素材库里有这一位时不该写「不在素材库」：' + who.title);
    /* 素材库没有的那一位：名字照留、画占位图并说明（不能吞掉用户写的名字） */
    const miss = await page.eval(() => {
      const inp = document.querySelector('#lineListMine input[data-line-who="sh2"]');
      inp.value = '路人甲';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const row = inp.closest('.line-row');
      return { ph: !!row.querySelector('.lr-thumb.ph'), title: (row.querySelector('.lr-thumb') || {}).title || '' };
    });
    if (!miss.ph || !/不在素材库/.test(miss.title)) throw new Error('素材库没有这一位时应画占位图并注明：' + JSON.stringify(miss));

    /* ④ 剧本里只有画面：改台词不动画面，改画面（剧本）也不动台词 */
    await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (t && t.classList.contains('active')) t.click();
    });
    await page.eval(() => document.getElementById('scriptEditBtn').click());
    const script0 = await readWhen(() => {
      const ta = document.querySelector('#scriptEditDlg textarea');
      return ta ? { text: ta.value } : null;
    }, 8000);
    if (!/## 镜头 1[\s\S]*画面：A 的画面/.test(script0.text)) throw new Error('剧本里没有第一镜的画面：' + script0.text.slice(0, 200));
    if (!/## 镜头 2[\s\S]*画面：B 的画面/.test(script0.text)) throw new Error('剧本里没有第二镜的画面：' + script0.text.slice(0, 200));
    if (/台词|说话人/.test(script0.text)) throw new Error('剧本还带着台词 / 说话人（台词只在该栏改）：' + script0.text.slice(0, 200));
    await page.eval(() => {
      const dlg = document.getElementById('scriptEditDlg');
      const ta = dlg.querySelector('textarea');
      ta.value = ta.value.replace('画面：A 的画面', '画面：剧本改的画面');
      dlg.querySelector('.pr-foot .pri').click();
    });
    await readWhen(() => !document.getElementById('scriptEditDlg'), 8000);
    /* 剧本改完之后：台词那一句与说话人一个字都不动 */
    await page.eval(() => {
      const t = document.getElementById('trimBtn');
      if (t && !t.classList.contains('active')) t.click();
    });
    await readWhen(() => {
      const g = document.getElementById('grpLines');
      if (!g) return null;
      if (g.hidden) {
        const b = document.querySelector('#vcTabs [data-vctab="lines"]');
        if (b) b.click();
      }
      return !g.hidden && document.getElementById('lineListAll') ? { ok: true } : null;
    }, 12000);
    const untouch = await readWhen(() => {
      const r1 = document.querySelector('#lineListAll .line-row[data-lineshot="sh1"]');
      const ta1 = r1 && r1.querySelector('textarea[data-line-text="sh1"]');
      const who1 = r1 && r1.querySelector('input[data-line-who="sh1"]');
      const ta2 = document.querySelector('#lineListMine textarea[data-line-text="sh2"]');
      if (!ta1 || !ta2) return null;
      return { line1: ta1.value, who1: (who1 || {}).value || '', line2: ta2.value,
        state1: (r1.querySelector('.lr-top em') || {}).textContent || '' };
    }, 8000);
    if (untouch.line1 !== '第一句台词' || untouch.who1 !== '林夏') {
      throw new Error('在剧本里改画面把台词 / 说话人带跑了：' + JSON.stringify(untouch));
    }
    if (untouch.line2 !== '第二句台词') throw new Error('退出剪辑再回来，台词不是那一份了：' + untouch.line2);
    if (untouch.state1 !== '待生成') throw new Error('第一镜那句还没配音，状态应仍是待生成：' + untouch.state1);

    /* 反向确认：剧本里那句画面真的写回镜头了（台词不参与，画面参与） */
    await page.eval(() => document.getElementById('scriptEditBtn').click());
    const script1 = await readWhen(() => {
      const ta = document.querySelector('#scriptEditDlg textarea');
      return ta ? { text: ta.value } : null;
    }, 8000);
    if (!/画面：剧本改的画面/.test(script1.text)) throw new Error('剧本改的画面没写回镜头：' + script1.text.slice(0, 200));
    await page.eval(() => {
      const dlg = document.getElementById('scriptEditDlg');
      const no = dlg && dlg.querySelector('.pr-foot .ghost');
      if (no) no.click();
    });

    /* 台词仍由 AI 按画面生成：拆分镜的审阅弹窗（lineEditable 那一档）里台词 / 说话人看得见、改得动，
       确认后交回的对象带着改过的那一份（拆分镜落盘读的就是这两项）。 */
    await page.eval(() => {
      window.__prOut = null;
      window.PromptReview.openList({
        title: '台词审阅探针', mode: 'board', lineEditable: true,
        items: [{ key: '场景 1·1', scene: '场景 1', name: '镜头 A', dur: 5,
          text: '原来的画面', line: '原来的台词', who: '林夏' }],
      }).then(v => { window.__prOut = v; });
    });
    await page.waitFor(() => !!document.querySelector('#prDlg .pb-line'), 8000);
    const prSeen = await page.eval(() => {
      const line = document.querySelector('#prDlg .pb-line');
      const who = document.querySelector('#prDlg .pb-who');
      const text = document.querySelector('#prDlg .pb-text');
      const before = { line: line.value, who: who.value, text: text.value };
      line.value = '审阅里改的台词';
      line.dispatchEvent(new Event('input', { bubbles: true }));
      who.value = '周岚';
      who.dispatchEvent(new Event('input', { bubbles: true }));
      text.value = '审阅里改的画面';
      text.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('prOk').click();
      return before;
    });
    if (prSeen.line !== '原来的台词' || prSeen.who !== '林夏' || prSeen.text !== '原来的画面') {
      throw new Error('审阅弹窗没把 AI 给的台词 / 说话人列出来：' + JSON.stringify(prSeen));
    }
    const prOut = await readWhen(() => window.__prOut, 5000);
    if (!prOut || !prOut.length) throw new Error('审阅弹窗确认后没有交回条目');
    if (prOut[0].line !== '审阅里改的台词' || prOut[0].who !== '周岚' || prOut[0].text !== '审阅里改的画面') {
      throw new Error('审阅弹窗交回的不是改过的台词 / 画面：' + JSON.stringify(prOut[0]));
    }

    /* ⑥ 分轨 / 合轨：全片配音按声音来源归行；只改 ln，时间 / 音量 / 选区一个字节不动；
       两颗按钮放在「这一镜有没有配音」之外，指画面轨时整块收起。 */
    await page.eval(() => {
      const tab = document.querySelector('.tl-tabs [data-tab="shot"]');
      if (tab) tab.click();
      const list = document.querySelector('#vcTabs [data-vctab="list"]');
      if (list) list.click();
    });
    const laneBtns = await readWhen(() => {
      const g = document.getElementById('grpVoiceList');
      const sp = document.getElementById('voiceSplit');
      const mg = document.getElementById('voiceMerge');
      if (!g || g.hidden || !sp || !mg) return null;
      return { split: sp.textContent.trim(), merge: mg.textContent.trim(),
        splitTitle: sp.title, mergeTitle: mg.title, disabled: sp.disabled || mg.disabled };
    }, 8000);
    if (!/分轨 3 句/.test(laneBtns.split)) throw new Error('「分轨」按钮该带全片句数：' + laneBtns.split);
    if (laneBtns.disabled) throw new Error('全片已有 3 句配音，两颗按钮不该禁用');
    if (!/全片/.test(laneBtns.splitTitle) || !/只改排版/.test(laneBtns.splitTitle)) {
      throw new Error('分轨的 title 没说清「全片 / 只改排版」：' + laneBtns.splitTitle);
    }
    if (!/全片/.test(laneBtns.mergeTitle) || !/不改成片/.test(laneBtns.mergeTitle)) {
      throw new Error('合轨的 title 没说清「全片 / 不改成片」：' + laneBtns.mergeTitle);
    }

    const readVoiceRows = () => {
      const out = {};
      document.querySelectorAll('#tlBar .tl-lane').forEach(l => {
        l.querySelectorAll('.tl-v[data-vid]').forEach(b => { out[b.dataset.vid] = Number(l.dataset.ln); });
      });
      return out;
    };
    const readSavedVoices = async () => {
      const rec = await window.Kv.at('ws').get('workspace');
      const p = rec && (rec.projects || []).find(x => x.id === 'p-lines');
      if (!p || !Array.isArray(p.voices) || p.voices.length !== 3) return null;
      return { rows: (p.lane && p.lane.voice && p.lane.voice.rows) || 1, voices: p.voices };
    };
    const doubleClick = sel => page.eval(s => {
      const b = document.querySelector(s);
      if (!b) throw new Error('找不到按钮 ' + s);
      b.click(); b.click();
      return true;
    }, sel);
    const startRows = await page.eval(readVoiceRows);
    if (Object.keys(startRows).length !== 3) throw new Error('三句配音没画出块：' + JSON.stringify(startRows));
    if (Object.values(startRows).some(n => n !== 0)) throw new Error('种子配音该都在第 1 行：' + JSON.stringify(startRows));
    const startSaved = await page.eval(readSavedVoices);
    if (!startSaved || startSaved.rows !== 1) throw new Error('种子配音的持久化状态不对：' + JSON.stringify(startSaved));

    /* 分轨（两颗按钮都要二次确认：第一下武装、第二下执行） */
    await doubleClick('#voiceSplit');
    const splitRows = await readWhen(() => {
      const lanes = document.querySelectorAll('#tlBar .tl-lane').length;
      const out = {};
      document.querySelectorAll('#tlBar .tl-lane').forEach(l => {
        l.querySelectorAll('.tl-v[data-vid]').forEach(b => { out[b.dataset.vid] = Number(l.dataset.ln); });
      });
      return lanes >= 2 && Object.keys(out).length === 3 ? { lanes, ln: out } : null;
    }, 8000);
    if (splitRows.ln.vo1 !== splitRows.ln.vo2) throw new Error('同一角色（小美）的两句该落在同一行：' + JSON.stringify(splitRows.ln));
    if (splitRows.ln.vo3 === splitRows.ln.vo1) throw new Error('不同角色（阿强）该落到另一行：' + JSON.stringify(splitRows.ln));
    const splitSaved = await readWhen(async () => {
      const rec = await window.Kv.at('ws').get('workspace');
      const p = rec && (rec.projects || []).find(x => x.id === 'p-lines');
      if (!p || !Array.isArray(p.voices)) return null;
      const rows = (p.lane && p.lane.voice && p.lane.voice.rows) || 1;
      const byId = {};
      p.voices.forEach(v => { byId[v.id] = Number(v.ln) || 0; });
      return rows === 2 ? { rows, byId, voices: p.voices } : null;
    }, 10000);
    if (splitSaved.byId.vo1 !== splitSaved.byId.vo2 || splitSaved.byId.vo3 === splitSaved.byId.vo1) {
      throw new Error('存盘的 ln 没按声音来源分组：' + JSON.stringify(splitSaved.byId));
    }
    splitSaved.voices.forEach((v, i) => {
      const strip = o => { const { ln, ...rest } = o; return JSON.stringify(rest); };
      if (strip(v) !== strip(startSaved.voices[i])) {
        throw new Error('分轨动了 ln 以外的字段：' + JSON.stringify(v) + ' vs ' + JSON.stringify(startSaved.voices[i]));
      }
    });

    /* Ctrl+Z 一步退回分轨前（不是退到「分到一半」），Ctrl+Y 再回来。
       撤销/重做会把视口带回第一镜（`curShot` 不进快照），所以每次回到第二镜再读画面上的块。 */
    await page.eval(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); });
    await readWhen(() => document.querySelectorAll('#tlBar .tl-lane').length === 1 ? { ok: true } : null, 8000);
    const undoneSaved = await readWhen(async () => {
      const rec = await window.Kv.at('ws').get('workspace');
      const p = rec && (rec.projects || []).find(x => x.id === 'p-lines');
      if (!p || !Array.isArray(p.voices)) return null;
      const rows = (p.lane && p.lane.voice && p.lane.voice.rows) || 1;
      return rows === 1 && p.voices.every(v => !v.ln || Number(v.ln) === 0) ? { ok: true } : null;
    }, 10000);
    if (!undoneSaved) throw new Error('Ctrl+Z 没把 ln 与行数退回分轨前');
    await page.eval(async () => {
      document.querySelector('.shot-item[data-sid="sh2"]').click();
      await new Promise(r => setTimeout(r, 300));
    });
    const undone = await readWhen(() => {
      const out = {};
      document.querySelectorAll('#tlBar .tl-lane').forEach(l => {
        l.querySelectorAll('.tl-v[data-vid]').forEach(b => { out[b.dataset.vid] = Number(l.dataset.ln); });
      });
      return Object.keys(out).length === 3 ? out : null;
    }, 8000);
    if (Object.values(undone).some(n => n !== 0)) throw new Error('Ctrl+Z 没退回分轨前：' + JSON.stringify(undone));
    await page.eval(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true })); });
    await readWhen(() => document.querySelectorAll('#tlBar .tl-lane').length >= 2 ? { ok: true } : null, 8000);
    await page.eval(async () => {
      const item = document.querySelector('.shot-item[data-sid="sh2"]');
      if (!item.classList.contains('sel')) item.click();
      await new Promise(r => setTimeout(r, 300));
    });
    const redone = await readWhen(() => {
      const lanes = document.querySelectorAll('#tlBar .tl-lane').length;
      const out = {};
      document.querySelectorAll('#tlBar .tl-lane').forEach(l => {
        l.querySelectorAll('.tl-v[data-vid]').forEach(b => { out[b.dataset.vid] = Number(l.dataset.ln); });
      });
      return lanes >= 2 && Object.keys(out).length === 3 ? { lanes, ln: out } : null;
    }, 8000);
    if (redone.ln.vo1 !== redone.ln.vo2 || redone.ln.vo3 === redone.ln.vo1) {
      throw new Error('Ctrl+Y 没回到分轨之后：' + JSON.stringify(redone.ln));
    }

    /* 合轨：全部回第 1 行，行数回到 1（工程里的 rows 键随之删掉） */
    await doubleClick('#voiceMerge');
    await readWhen(() => {
      const lanes = document.querySelectorAll('#tlBar .tl-lane').length;
      if (lanes !== 1) return null;
      const lns = [...document.querySelectorAll('#tlBar .tl-lane .tl-v[data-vid]')]
        .map(b => Number(b.closest('.tl-lane').dataset.ln));
      return lns.length >= 3 && lns.every(n => n === 0) ? { ok: true } : null;
    }, 8000);
    await readWhen(async () => {
      const rec = await window.Kv.at('ws').get('workspace');
      const p = rec && (rec.projects || []).find(x => x.id === 'p-lines');
      if (!p || !Array.isArray(p.voices)) return null;
      const allZero = p.voices.every(v => !v.ln || Number(v.ln) === 0);
      const hasRows = !!(p.lane && p.lane.voice && ('rows' in p.lane.voice));
      return allZero && !hasRows ? { ok: true } : null;
    }, 10000);

    /* 这一镜一句配音都没有：两颗按钮仍在（放在 n ? … : … 之外），且因为全片还有配音而可用 */
    await page.eval(() => document.querySelector('.shot-item[data-sid="sh1"]').click());
    const emptyShot = await readWhen(() => {
      const g = document.getElementById('grpVoiceList');
      const sp = document.getElementById('voiceSplit');
      const mg = document.getElementById('voiceMerge');
      if (!g || g.hidden || !sp || !mg) return null;
      return { rows: document.querySelectorAll('#grpVoiceList .vc-row').length, disabled: sp.disabled || mg.disabled };
    }, 8000);
    if (emptyShot.rows !== 0) throw new Error('这一镜本该没有配音：' + JSON.stringify(emptyShot));
    if (emptyShot.disabled) throw new Error('全片还有 3 句配音，分轨 / 合轨不该因为这一镜没有而禁用');

    /* 点一格画面 → 目标轨换成画面那一侧 → 整块配音清单收起，两颗按钮跟着看不见 */
    await page.eval(() => {
      const seg = document.querySelector('#tlBar .tl-seg[data-seg="0"]');
      if (seg) seg.click();
    });
    await readWhen(() => {
      const g = document.getElementById('grpVoiceList');
      return g && g.hidden ? { hidden: true } : null;
    }, 8000);

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    if (errs.length) throw new Error('页面异常：' + errs.join(' | '));
    console.log('✓ 台词只剩剪辑右栏那一档（本镜 / 全片两段 · 双时间读数 · 写完自动上待生成轨 · 与提示词互不带动 · 说话人认素材库）'
      + ' · 配音分轨 / 合轨（按声音来源归行 · 只改 ln · 一步撤销 · 空镜仍可见 · 画面轨收起）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
