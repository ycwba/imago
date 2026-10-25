#!/usr/bin/env node
/* 真机自查：起一个真代理，种几条素材，把新的素材库页面截出来看。
   （一次性探针，不进产品） */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

const PNG = 'iVBORwKGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABUlEQVR42mNkYPhfz0AEYBxVSF+FjAxQBEwSBAQDoJmM0AAAAASUVORK5CYII=';
/* 每条素材给一张能画出来的占位图（SVG data URL）：灰底 + 名字 —— 真机自查看的是版式 */
function thumb(label, bg, fg) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">'
    + '<rect width="320" height="200" fill="' + bg + '"/>'
    + '<circle cx="160" cy="78" r="34" fill="' + fg + '" opacity=".55"/>'
    + '<text x="160" y="160" font-size="26" fill="' + fg + '" text-anchor="middle" font-family="sans-serif">'
    + label + '</text></svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}
const OUT = path.resolve(__dirname, 'shots');

/* 十条素材：角色 / 场景 / 道具各几条，缺口各配齐（照着完备度那四档） */
const T = {
  lin: thumb('林晚', '#33415c', '#c9d6ef'), chen: thumb('陈砚', '#3c4a52', '#cfe0e6'),
  sun: thumb('苏念', '#4a3f52', '#e3d5ef'), ach: thumb('阿澈', '#2f3a3a', '#c6dedd'),
  zhou: thumb('老周', '#4a4038', '#ecd9c4'), roof: thumb('天台', '#5a4a3c', '#f0dcc0'),
  gate: thumb('雨夜校门', '#232c3f', '#c2d2f2'), room: thumb('空教室', '#3f4438', '#dfe4cf'),
  umb: thumb('雨伞', '#2b2b30', '#d0d0d8'), rec: thumb('录音机', '#4a3f3a', '#e8d3cc'),
  three: thumb('三视图', '#3a3f4a', '#dfe6f2'), expr: thumb('表情表', '#4a3f3a', '#f0e0d8'),
};
const ITEMS = [
  { id: 'c1', name: '林晚', kind: 'char', face: T.lin, anchor: T.lin, look: '二十出头，齐肩黑发，总穿米色风衣', bio: '嘴硬心软的师姐，嘴上不饶人但每次都替别人收尾', group: '校园篇', voice: 'yunxi', voiceName: '云希',
    assets: [{ id: 'a1', name: '三视图', tpl: 'three', src: T.three, propIds: ['p1'] },
             { id: 'a2', name: '表情表', tpl: 'expr', src: T.expr, propIds: [] }] },
  { id: 'c2', name: '陈砚', kind: 'char', face: T.chen, look: '高三男生，戴眼镜，校服外套', bio: '话不多，但每次开口都在点上', group: '校园篇' },
  { id: 'c3', name: '苏念', kind: 'char', face: T.sun, look: '短发，圆框眼镜，常年抱着两本书', bio: '值日时爱在天台待到天黑', group: '校园篇', voice: 'yunxi', voiceName: '云希' },
  { id: 'c4', name: '阿澈', kind: 'char', face: T.ach, look: '转学生，黑色卫衣，雨天也穿同一件', group: '' },
  { id: 'c5', name: '老周', kind: 'char', look: '门卫，制服，钥匙串上挂着一只旧哨子', bio: '值夜班时总开着收音机', group: '校园篇', voice: 'yunxi', voiceName: '云希' },
  { id: 's1', name: '教学楼天台', kind: 'scene', img: T.roof, desc: '教学楼天台，傍晚，铁栏杆与晾衣绳', bio: '两人摊牌的地方', time: '黄昏', group: '校园篇' },
  { id: 's2', name: '雨夜校门', kind: 'scene', img: T.gate, desc: '校门，夜里下雨，霓虹在水面上碎成一片', time: '深夜', group: '雨夜篇' },
  { id: 's3', name: '空教室', kind: 'scene', img: T.room, desc: '放学后的空教室，风把卷子翻过一页', time: '白天', group: '校园篇' },
  { id: 'p1', name: '黑色雨伞', kind: 'prop', face: T.umb, look: '黑色长柄伞，伞骨断过一根，用灰胶带缠着', bio: '用来交代那半页没写完的地址', group: '雨夜篇' },
  { id: 'p2', name: '褪色录音机', kind: 'prop', face: T.rec, look: '1998 年的口袋机，磁带还在转', group: '' },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Store && !!window.Chars, 20000, 100);
    await page.eval((items) => {
      localStorage.setItem('ai_chat_dock', '0');
      localStorage.removeItem('ai_chat_fxy');
      localStorage.setItem('char_lib', JSON.stringify({ data: items, ts: Date.now() }));
    }, ITEMS);
    await page.goto(proxy.base + '/shell.html#chars.html');
    await page.waitFor(() => document.querySelectorAll('.chars-page .card').length >= 10, 25000, 120);
    await h.sleep(600);
    await page.screenshot(path.join(OUT, '01-素材台.png'));

    /* 网格档（另一档展示样式）：动作区在正文下面那一行，固定显示 */
    await page.eval(() => {
      const b = document.querySelector('.chars-page .viewtoggle [data-v="compact"]');
      if (b) b.click();
    });
    await h.sleep(700);
    await page.screenshot(path.join(OUT, '01c-素材台-网格档.png'));
    await page.eval(() => {
      const b = document.querySelector('.chars-page .viewtoggle [data-v="list"]');
      if (b) b.click();
    });
    await h.sleep(500);

    /* ---------- 「本页默认」撤掉了没有：默认值改由设置页那张卡管 ---------- */
    const noDefault = await page.eval(() => {
      const rail = document.querySelector('.chars-page .mat-rail');
      const txt = rail ? rail.textContent : '';
      const pick = document.querySelector('.chars-page .rail-gen .rail-model');
      return {
        railHasDefault: txt.indexOf('本页默认') >= 0,
        footGone: !document.querySelector('.chars-page .rail-foot'),
        fillRow: !!document.querySelector('.chars-page .rail-gen'),
        fillModel: pick ? pick.value : '',
        fillOpts: pick ? pick.options.length : 0,
        legacyKey: localStorage.getItem('char_opts'),
      };
    });
    console.log('本页默认已撤：' + JSON.stringify(noDefault));
    /* 「出齐用哪个型号」那一行已经撤掉（2026-10-25）：「出齐」用哪个型号只有一处出处 ——
       设置页「素材库」那张卡的默认生图型号。这里反着判一次：左轨里不该再有那颗下拉。 */
    const afterCaps = await page.eval(() => ({
      hasRailGen: !!document.querySelector('.chars-page .rail-gen'),
      hasFillModel: !!document.querySelector('.chars-page [data-fill-model]'),
      fillBtn: !!document.querySelector('.chars-page [data-rail="fill"]'),
    }));
    console.log('能力落定后目录轨：' + JSON.stringify(afterCaps));
    await page.screenshot(path.join(OUT, '01b-目录轨-出齐按钮.png'));

    /* ---------- 多选态：批量条上的出图 / 声音两个型号下拉在位 ---------- */
    await page.eval(() => {
      const b = [...document.querySelectorAll('.chars-page .mat-head button.ghost')]
        .find(x => (x.textContent || '').indexOf('多选') >= 0);
      if (b) b.click();
    });
    await h.sleep(600);
    const bk = await page.eval(() => {
      const sels = [...document.querySelectorAll('.chars-page .bulkbar .bk-gen .bk-model')];
      return { n: sels.length, vals: sels.map(s => s.value), opts: sels.map(s => s.options.length) };
    });
    console.log('批量条型号：' + JSON.stringify(bk));
    await page.screenshot(path.join(OUT, '09-多选批量条.png'));
    await page.eval(() => {
      const b = [...document.querySelectorAll('.chars-page .mat-head button.ghost')]
        .find(x => (x.textContent || '').indexOf('退出多选') >= 0);
      if (b) b.click();
    });
    await h.sleep(300);

    /* 点一张卡 → 右侧检查器（点名字那一行，别点缩略图 —— 那是灯箱） */
    await page.eval(() => {
      const n = document.querySelector('.chars-page .card[data-id="c1"] .mname');
      if (n) n.click();
    });
    await h.sleep(400);
    await page.screenshot(path.join(OUT, '02-检查器.png'));

    /* 打开详情（整屏层） */
    await page.eval(() => {
      const b = document.querySelector('.chars-page .card[data-id="c1"] .macts button');
      if (b) b.click();
    });
    await h.sleep(600);
    await page.screenshot(path.join(OUT, '03-详情层.png'));

    /* ---------- 详情层：每个生成位自带型号与数量，没有「用本页默认」 ---------- */
    const genBars = await page.eval(() => {
      const bars = [...document.querySelectorAll('.md-layer .gen-bar')];
      return {
        n: bars.length,
        labs: bars.map(b => { const l = b.querySelector('.gen-lab'); return l ? l.textContent : ''; }),
        models: bars.map(b => { const s = b.querySelector('.gen-model'); return s ? s.value : ''; }),
        counts: bars.map(b => { const s = b.querySelector('.gen-count'); return s ? s.value : ''; }),
        hasDefaultLink: !!document.querySelector('.md-layer [data-d-act="gendef"]'),
      };
    });
    console.log('详情层生成位：' + JSON.stringify(genBars));

    /* 新建（空骨架） */
    await page.eval(() => {
      const back = document.querySelector('.md-layer .md-back');
      if (back) back.click();
    });
    await h.sleep(300);
    await page.eval(() => {
      const b = document.querySelector('.chars-page .mat-head .pri');
      if (b) b.click();
    });
    await h.sleep(600);
    await page.screenshot(path.join(OUT, '04-新建.png'));

    /* ---------- 新建这一路真能存进库吗：填名字 → 建好这一条 → 库里多一条 ---------- */
    const built = await page.eval(async () => {
      const inp = document.querySelector('.md-layer .md-field input[data-f="name"]');
      if (!inp) return { why: '没找到名字那一格' };
      inp.value = '探针新的一条';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      const look = document.querySelector('.md-layer textarea[data-f="look"]');
      if (look) {
        look.value = '用来验新建那一路的探针';
        look.dispatchEvent(new Event('input', { bubbles: true }));
        look.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const btn = document.querySelector('.md-layer .md-foot .pri');
      if (!btn) return { why: '没找到「建好这一条」' };
      btn.click();
      await new Promise(r => setTimeout(r, 900));
      const lib = JSON.parse(localStorage.getItem('char_lib') || '{"data":[]}');
      const hit = (lib.data || []).filter(x => x && x.name === '探针新的一条');
      return { total: (lib.data || []).length, hit: hit.length, kind: hit[0] && hit[0].kind, look: hit[0] && hit[0].look };
    });
    console.log('新建落库：' + JSON.stringify(built));
    await h.sleep(500);
    await page.screenshot(path.join(OUT, '05-新建落库后.png'));

    /* ---------- 角色资产那一节：滚到它，截特写 ---------- */
    await page.eval(() => {
      const b = document.querySelector('.chars-page .card[data-id="c1"] .macts button');
      if (b) b.click();
    });
    await h.sleep(600);
    await page.eval(() => {
      const sec = document.querySelector('.md-layer .md-sec-assets');
      if (sec) sec.scrollIntoView({ block: 'start' });
    });
    await h.sleep(400);
    await page.screenshot(path.join(OUT, '06-角色资产.png'));

    /* ---------- 「自定义」那一档能不能写描述：切过去看那一格有没有亮 ---------- */
    const what = await page.eval(() => {
      const tpl = document.querySelector('.md-layer [data-a="assettpl"]');
      if (!tpl) return { why: '没有模板下拉' };
      tpl.value = 'custom';
      tpl.dispatchEvent(new Event('change', { bubbles: true }));
      const w = document.querySelector('.md-layer [data-a="assetwhat"]');
      const nm = document.querySelector('.md-layer [data-a="assetname"]');
      return { whatExists: !!w, whatDisabled: w ? w.disabled : null, nameExists: !!nm };
    });
    console.log('自定义那一档：' + JSON.stringify(what));
    await h.sleep(300);
    await page.screenshot(path.join(OUT, '07-角色资产-自定义.png'));

    /* ---------- 行内重出参数：改了要真的记住（不能重画吃掉） ---------- */
    const rowGen = await page.eval(() => {
      const sel = document.querySelector('.md-layer .md-row-gen .gen-model');
      if (!sel) return { why: '没找到行内的型号下拉' };
      const before = sel.value;
      const opts = [...sel.options].map(o => o.value);
      const other = opts.find(v => v !== before) || before;
      sel.value = other;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const after = document.querySelector('.md-layer .md-row-gen .gen-model');
      return { has: true, before: before, picked: other, kept: after ? after.value : null,
        wired: !!(sel.dataset.rowModel), assetId: sel.dataset.rowModel || '' };
    });
    console.log('行内重出参数：' + JSON.stringify(rowGen));
    await h.sleep(300);
    await page.screenshot(path.join(OUT, '08-角色资产-行内参数.png'));

    const errs = (page.errors || []).filter(Boolean);
    console.log(errs.length ? '页面报错：\n' + errs.slice(0, 5).join('\n') : '零控制台错误');

    /* ---------- 设置页「素材库」那张卡：默认值在那儿管着 ---------- */
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => document.querySelector('#charsSet'), 25000, 120);
    await h.sleep(1500);
    const setCard = await page.eval(() => {
      const box = document.querySelector('#charsSet');
      if (!box) return { why: '没找到素材库那张卡' };
      const sels = [...box.querySelectorAll('select')];
      const card = document.querySelector('.card[data-nav="chars"]');
      if (card) card.scrollIntoView({ block: 'start' });
      return {
        rows: [...box.querySelectorAll('.kn')].map(x => x.textContent),
        modelSelects: sels.filter(s => (s.dataset.set || '').indexOf('Model') >= 0).length,
        selects: sels.length,
        firstOpts: sels.map(s => (s.options[0] || {}).value || ''),
      };
    });
    console.log('设置页素材库卡：' + JSON.stringify(setCard));
    await h.sleep(500);
    await page.screenshot(path.join(OUT, '10-设置页-素材库卡.png'));

    console.log('截图在 ' + OUT);
  } finally {
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });
