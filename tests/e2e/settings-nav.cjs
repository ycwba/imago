#!/usr/bin/env node
/* 设置页「找到一项设置」这条路（目录轨 B1 / 连续文档 B6 / 关键词命中到行 B2 / 回车落点 B4 / Esc 清空 B5）。
   判据要的是**能定位、能落盘、滚动落点真的让开钉住的组标题**，不是「页面能打开」：
     壳：这一页是**两栏两滚** —— 页面自己不滚，目录轨与右栏那条文档各滚各的
         （跟产品 `.wb` 工作台同一套做法）。切栏时整页不跳；
     B1 目录轨：左边是一棵 5 组 17 行的目录，每行带它的**当前值**（值速记）；
        组名与栏目标题都从 DOM 现读（JS 里不许有第二份清单）；
        点一行 → 右栏平滑滚到那一栏，当场就亮、落定不回跳；
     B6 滚动定位：右栏滚到哪一栏，轨上那一行就跟着亮；组标题钉在顶上；
     B4 展开不写盘：折叠状态是界面偏好，但「为了跳过去而展开」那一下不许落进 localStorage；
     B2 行级命中：搜索词命中落到**行**上（.set-hit）并带计数，回车滚到第一处命中且该行整条可见，
        高亮短暂之后自己清掉；Esc 一键清空筛选；
     B5 一行声明即渲染 + 写盘：改清单里的一行（sb_bal_on）→ 值落进 localStorage，改回去也落；
     保存回执：这一页没有「保存」按钮，「改完就存本机」那句话必须还在（状态行里）；
     滚动只有一个出口：这一页不许有第二处裸 `scrollIntoView`。
   只跑隔离实例（harness 自建 .data-probe-*），浏览器档位干净，不动用户 LS。 */
'use strict';
const h = require('./harness.cjs');
const fs = require('fs');
const path = require('path');

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => {
      const rail = document.querySelector('.settings-page .set-rail-scroll');
      return !!rail && rail.querySelectorAll('.set-rail-i').length > 0;
    }, 60000);
    await h.sleep(1500);

    /* ---------- 壳：页面自己不滚，文档列自己滚，目录轨常驻 ---------- */
    const shell = await page.eval(() => {
      const root = document.querySelector('.settings-page');
      const doc = document.querySelector('.set-doc-scroll');
      const rail = document.querySelector('.set-rail');
      const rr = rail.getBoundingClientRect(), dr = doc.getBoundingClientRect();
      return {
        pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 2,
        docScrollable: doc.scrollHeight > doc.clientHeight + 4,
        docH: doc.scrollHeight,
        docClient: doc.clientHeight,
        railH: Math.round(rr.height),
        railTop: Math.round(rr.top),
        docTop: Math.round(dr.top),
        anchor: getComputedStyle(doc).getPropertyValue('--setanchor').trim(),
        railRows: document.querySelectorAll('.set-rail-i').length,
        groups: document.querySelectorAll('.set-rail-g').length,
        notes: document.querySelectorAll('.set-rail-scroll .set-rail-note').length,
        pos: (document.querySelector('.set-pos') || {}).textContent || '',
        save: (document.querySelector('.set-save') || {}).textContent || '',
        values: [...document.querySelectorAll('.set-rail-i .set-rail-v')].map(x => x.textContent.trim()),
      };
    });
    must(!shell.pageScrolls, '页面自己在滚（整页高度 ' + shell.docH + 'px）—— 这一页是「两栏两滚」：页面不滚，滚的是目录轨与右栏那条文档');
    must(shell.docScrollable, '右栏那条文档不滚（内容 ' + shell.docH + ' / 视口 ' + shell.docClient + '）：15 张卡排成一条，就得能一路滚到底');
    must(shell.railRows === 15, '目录轨只有 ' + shell.railRows + ' 行（5 组 15 张卡：一张卡一行）');
    must(shell.groups === 5, '目录轨不是 5 组：' + shell.groups);
    must(shell.notes === 5, '不是每一组都有一句说明（' + shell.notes + ' 条）');
    must(shell.values.filter(Boolean).length >= 15, '值速记没填满：只有 ' + shell.values.filter(Boolean).length + ' 行有值');
    must(/第 \d+ \/ \d+ 项/.test(shell.pos), '状态行没说得出「现在在第几项」：' + shell.pos);
    must(/自动存|已存|存进本机/.test(shell.save), '保存回执不见了（这一页没有「保存」按钮，那句话得在状态行里）：' + shell.save);
    must(!!shell.anchor && parseFloat(shell.anchor) > 0, '停靠位（卡顶让开钉住的组标题那一条）没量出来');

    /* ---------- B1「一处声明」：目录轨上的字逐字等于模板里那一节 / 那一处 ---------- */
    const decl = await page.eval(() => {
      const titleOf = c => {
        const h = c.querySelector('h2');
        if (!h) return '';
        const clone = h.cloneNode(true);
        clone.querySelectorAll('.set-hcnt').forEach(x => x.remove());
        return clone.textContent.trim();
      };
      const secTitles = [...document.querySelectorAll('.set-group[data-group]')].map(sec => {
        const hd = sec.querySelector('.set-group-h');
        return hd ? (((hd.querySelector('.fold-title') || hd).textContent) || '').trim() : '';
      });
      const railGroups = [...document.querySelectorAll('.set-rail-g .t')].map(x => x.textContent.trim());
      const railTitles = [...document.querySelectorAll('.set-rail-i .set-rail-n')].map(x => x.textContent.trim());
      /* 文档里的「去处」= 每一张卡 + 卡里的每一档（供应商那张卡的语音识别 / 联网搜索两档） */
      const destTitles = [];
      document.querySelectorAll('.set-group[data-group]').forEach(sec => {
        [...sec.querySelectorAll(':scope > .card, :scope > .fold-body > .card')].forEach(c => {
          if (c.hidden || !c.dataset.nav) return;
          destTitles.push(titleOf(c));
          c.querySelectorAll('[data-nav]').forEach(p => destTitles.push(titleOf(p)));
        });
      });
      return { secTitles, railGroups, railTitles, destTitles };
    });
    must(decl.secTitles.length === 5 && decl.secTitles[decl.secTitles.length - 1] === '本机维护',
      '组不是一共 5 组或最后一组不是默认折叠的「本机维护」：' + decl.secTitles.join('、'));
    must(decl.railGroups.length === decl.secTitles.length && decl.railGroups.every((t, i) => t === decl.secTitles[i]),
      '目录轨上的组名与模板标题对不上（组名只许声明一处，两边读同一份 DOM）：' + JSON.stringify(decl.railGroups) + ' vs ' + JSON.stringify(decl.secTitles));
    must(decl.railTitles.length === decl.destTitles.length && decl.railTitles.every((t, i) => t === decl.destTitles[i]),
      '目录轨上的标题与文档里那处对不上（标题只许声明一处）：' + JSON.stringify(decl.railTitles) + ' vs ' + JSON.stringify(decl.destTitles));
    /* 「语音识别」「联网搜索」是供应商那张卡里的两档（与图片 / 视频 / 语音 / 文字同一层级）——
       轨上只索引「卡」，这两档不另占行（卡里那排档位就是它们的入口）。 */
    must(decl.railTitles.indexOf('语音识别（ASR）') < 0 && decl.railTitles.indexOf('联网搜索') < 0,
      '轨上多出了「语音识别」「联网搜索」两行（它们是供应商那张卡里的档位，轨上只索引卡）');

    /* ---------- B1b：语音识别 / 联网搜索是供应商那张卡里的两档（与图片 / 视频同一层级） ---------- */
    const tabJump = await page.eval(async () => {
      const tabs = () => [...document.querySelectorAll('#provTabs [data-tab]')].map(b => b.textContent.trim());
      const on = () => (document.querySelector('#provTabs [data-tab].on') || {}).textContent || '';
      const asrVisible = () => document.querySelector('#asrCard').offsetParent !== null;
      const before = { tabs: tabs(), on: on(), asrVisible: asrVisible() };
      /* 点卡里那排档位的「语音识别」 */
      const b = [...document.querySelectorAll('#provTabs [data-tab]')].find(x => x.textContent.indexOf('语音识别') === 0);
      if (b) b.click();
      await new Promise(r => setTimeout(r, 700));
      return {
        before,
        after: { tabs: tabs(), on: on(), asrVisible: asrVisible() },
        railOn: (document.querySelector('.set-rail-i.on .set-rail-n') || {}).textContent || '',
      };
    });
    must(tabJump.before.tabs.length === 6, '供应商那张卡只有 ' + tabJump.before.tabs.length + ' 档（图片 / 视频 / 语音 / 文字 + 语音识别 + 联网搜索，一共六档）');
    must(tabJump.before.tabs[4].indexOf('语音识别') === 0 && tabJump.before.tabs[5].indexOf('联网搜索') === 0,
      '语音识别 / 联网搜索不在同一排档位上：' + tabJump.before.tabs.join(' / '));
    must(!tabJump.before.asrVisible, '语音识别那一档一开始就是开着的（默认停在第一档）');
    must(tabJump.after.asrVisible, '点卡里「语音识别」那一档，语音识别那一段没有画出来');
    must(tabJump.after.on.indexOf('语音识别') >= 0, '点卡里那一档，档位没切过去（现在在 ' + tabJump.after.on + '）');
    must(tabJump.railOn.indexOf('供应商') >= 0, '切档之后轨上亮的不是那张卡（亮的是「' + tabJump.railOn + '」—— 轨上索引的是卡，不是卡里的档）');

    /* ---------- B1 + B6：点一行 → 右栏滚到那一栏，当场就亮、落定不回跳 ---------- */
    const jump = await page.eval(async () => {
      const row = [...document.querySelectorAll('.set-rail-i')].find(x => x.querySelector('.set-rail-n').textContent.indexOf('产物存放') >= 0);
      if (!row) return { missing: true };
      const doc = document.querySelector('.set-doc-scroll');
      const before = doc.scrollTop;
      row.click();
      await new Promise(r => setTimeout(r, 200));            /* 当场：不许等滚动 */
      const atClick = {
        on: !!document.querySelector('.set-rail-i.on'),
        onText: (document.querySelector('.set-rail-i.on .set-rail-n') || {}).textContent || '',
        pos: (document.querySelector('.set-pos') || {}).textContent || '',
      };
      await new Promise(r => setTimeout(r, 1900));           /* 平滑滚动 + 落定校正全过完 */
      const card = document.querySelector('.card[data-nav="storage"]');
      const r = card.getBoundingClientRect(), dr = doc.getBoundingClientRect();
      return {
        atClick,
        scrolled: doc.scrollTop !== before,
        cardTop: Math.round(r.top - dr.top),
        settledOn: (document.querySelector('.set-rail-i.on .set-rail-n') || {}).textContent || '',
        settledPos: (document.querySelector('.set-pos') || {}).textContent || '',
      };
    });
    must(!jump.missing, '目录轨上找不到「产物存放」那一行');
    must(jump.scrolled, '点轨上那一行，右栏根本没滚');
    must(jump.atClick.on, '点轨上那一行当场没亮（高亮要等滚动事件才跟上）');
    must(jump.atClick.onText.indexOf('产物存放') >= 0, '点完亮的是别的行：' + jump.atClick.onText);
    must(/产物存放/.test(jump.atClick.pos), '点完状态行没跟着换：' + jump.atClick.pos);
    must(jump.cardTop >= 0 && jump.cardTop <= 120, '卡顶没让开钉住的组标题（卡顶在容器上方 ' + jump.cardTop + 'px）');
    must(jump.settledOn.indexOf('产物存放') >= 0, '滚动落定后轨上的高亮被改回别的行了：' + jump.settledOn);
    must(/产物存放/.test(jump.settledPos), '落定之后状态行不是这一项：' + jump.settledPos);

    /* ---------- B6：右栏滚到哪一栏，轨上那一行就跟着亮；组标题钉在顶上 ---------- */
    const follow = await page.eval(async () => {
      const doc = document.querySelector('.set-doc-scroll');
      doc.scrollTop = Math.round(doc.scrollHeight * 0.72);
      await new Promise(r => setTimeout(r, 900));
      const dr = doc.getBoundingClientRect();
      let pinned = null;
      document.querySelectorAll('.set-group-h').forEach(g => {
        const gr = g.getBoundingClientRect();
        if (Math.abs(gr.top - dr.top) < 3) pinned = g.textContent.trim();
      });
      return {
        on: (document.querySelector('.set-rail-i.on .set-rail-n') || {}).textContent || '',
        pos: (document.querySelector('.set-pos') || {}).textContent || '',
        pinned: pinned,
      };
    });
    must(!!follow.on, '右栏滚了，轨上没有任何一行亮着（滚动定位没接上）');
    must(follow.on !== '产物存放', '右栏已经滚到别处，轨上还亮着「产物存放」：' + follow.on);
    must(!!follow.pinned, '组标题没有钉在顶上（这一条 7000px 的文档里，「我在哪」的锚没了）');

    /* ---------- B4：点最后一组（默认折叠的本机维护）→ 展开 + 不写盘 ---------- */
    await page.eval(() => {
      document.querySelectorAll('.set-group.foldable').forEach(f => f.classList.remove('open'));
      document.querySelector('.set-doc-scroll').scrollTop = 0;
      return 1;
    });
    await h.sleep(400);
    const b4 = await page.eval(async () => {
      const row = [...document.querySelectorAll('.set-rail-i')].find(x => x.querySelector('.set-rail-n').textContent.indexOf('本机环境') >= 0);
      if (!row) return { missing: true };
      row.click();
      await new Promise(r => setTimeout(r, 1900));
      const g = document.querySelector('.set-group[data-group="maint"]');
      const doc = document.querySelector('.set-doc-scroll');
      const card = document.querySelector('.card[data-nav="env"]');
      const r = card ? card.getBoundingClientRect() : null;
      const dr = doc.getBoundingClientRect();
      return {
        maintOpen: g.classList.contains('open'),
        foldKey: (() => { try { return localStorage.getItem('set_fold_maint'); } catch (e) { return 'ERR'; } })(),
        cardTop: r ? Math.round(r.top - dr.top) : -1,
        on: (document.querySelector('.set-rail-i.on .set-rail-n') || {}).textContent || '',
      };
    });
    must(!b4.missing, '目录轨上找不到「本机环境」那一行');
    must(b4.maintOpen, '点那一行没有把默认折叠的「本机维护」展开（命中藏在收着的组里等于没找到）');
    must(b4.foldKey === null, '「为了跳过去」把折叠状态写进了 localStorage（B4：展开这一动作不写盘），实到 ' + b4.foldKey);
    must(b4.cardTop >= 0 && b4.cardTop <= 120, '展开后落点没让开钉住的组标题（卡顶 ' + b4.cardTop + 'px）');
    must(b4.on.indexOf('本机环境') >= 0, '落定之后轨上亮的不是这一行：' + b4.on);

    /* ---------- B2：搜索 → 行级命中 → 回车定位 → 高亮自清 → Esc 清空 ---------- */
    const b2 = await page.eval(async () => {
      const q = document.querySelector('.set-rail-top input[type=search]');
      q.value = '缓存';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 900));
      const hits = [...document.querySelectorAll('.settings-page .set-hit')];
      const doc = document.querySelector('.set-doc-scroll');
      const before = doc.scrollTop;
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const flashNow = document.querySelectorAll('.settings-page .set-flash').length;
      const target = document.querySelector('.settings-page .set-flash');
      await new Promise(r => setTimeout(r, 1900));
      const r1 = target ? target.getBoundingClientRect() : null;
      const rb = doc.getBoundingClientRect();
      return {
        hitRows: hits.length,
        targetText: target ? target.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : '',
        sum: (document.querySelector('.set-rail-note') || {}).textContent || '',
        counts: [...document.querySelectorAll('.settings-page .set-hcnt')].map(x => x.textContent.trim()),
        offCards: document.querySelectorAll('.settings-page .card.set-off').length,
        scrolled: doc.scrollTop !== before,
        targetPainted: !!target && target.offsetParent !== null,
        firstVisible: !!r1 && r1.top >= rb.top - 4 && r1.bottom <= rb.bottom + 4,
        flashOnEnter: flashNow,
        flashCleared: document.querySelectorAll('.settings-page .set-flash').length,
        scrollTop: Math.round(doc.scrollTop),
      };
    });
    must(b2.hitRows > 0, '搜「缓存」一个行级命中都没有（命中要落到 .set-hit 那一行，不是整张卡）');
    must(b2.counts.length > 0 && b2.counts.some(c => /\d/.test(c)), '命中计数没画出来：' + JSON.stringify(b2.counts));
    must(b2.offCards > 0, '没命中的栏没收起来（筛选时该藏的没藏）');
    must(b2.flashOnEnter >= 1, '回车后没有短暂高亮（.set-flash 一处都没有）');
    must(b2.targetPainted, '回车跳到了一行画不出来的命中（屏幕上什么都没有）：' + JSON.stringify(b2.targetText));
    must(b2.scrolled, '回车没有滚到第一处可见命中（scrollTop 还是 ' + b2.scrollTop + '）');
    must(b2.firstVisible, '回车之后落点那一行不在可视区里');
    must(b2.flashCleared === 0, '高亮没有自己清掉，还留着 ' + b2.flashCleared + ' 处');

    const esc = await page.eval(async () => {
      const q = document.querySelector('.set-rail-top input[type=search]');
      q.focus();
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      return {
        off: document.querySelectorAll('.settings-page .set-off').length,
        hits: document.querySelectorAll('.settings-page .set-hit').length,
        value: q.value,
      };
    });
    must(!esc.value && !esc.hits && !esc.off, 'Esc 没把筛选清干净：值「' + esc.value + '」/ 命中 ' + esc.hits + ' / 被压下的行 ' + esc.off);

    /* ---------- B5：改一行声明就落盘 ---------- */
    const b5 = await page.eval(async () => {
      const cb = document.querySelector('[data-mkey="sb_bal_on"]');
      if (!cb) return { missing: true };
      const was = cb.checked;
      cb.checked = !was; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1300));
      const first = (() => { try { return localStorage.getItem('sb_bal_on'); } catch (e) { return 'ERR'; } })();
      cb.checked = was; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1300));
      const back = (() => { try { return localStorage.getItem('sb_bal_on'); } catch (e) { return 'ERR'; } })();
      return { first, back };
    });
    must(!b5.missing, '清单里那一行 sb_bal_on 没渲染出来（B5 的「新增一项设置只改一行声明」不成立）');
    must(String(b5.first) !== String(b5.back), '改开关前后 localStorage 没跟着变（' + b5.first + ' → ' + b5.back + '）：这一行没落盘');

    /* ---------- 1024 档：不横向溢出、行不出现内部滚动条 ---------- */
    await page.setSize(1024, 800);
    await h.sleep(800);
    const m = await page.eval(() => {
      const root = document.querySelector('.settings-page');
      const over = [...root.querySelectorAll('.krow, .card')].filter(el => el.scrollWidth > el.clientWidth + 2).length;
      return {
        docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        overflowEls: over,
        railRows: document.querySelectorAll('.set-rail-i').length,
      };
    });
    must(!m.docOverflow, '1024 档整页出现横向溢出（文档宽 1024 之外还有东西）');
    must(m.overflowEls === 0, m.overflowEls + ' 个设置行在 1024 档里被撑出自己内部的横向滚动');

    /* ---------- 滚动只有一个出口 ---------- */
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'pages', 'settings.js'), 'utf8');
    /* 只数**调用**（前面带点的），注释里提到这个词不算 */
    const inCalls = (src.match(/\.scrollIntoView\s*\(/g) || []).length;
    must(inCalls === 1, '这一页有 ' + inCalls + ' 处 scrollIntoView：滚动只有一个出口（scrollToEl），'
      + '别处裸调不给钉住的组标题让位、也不会补校正');

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 设置页找项：两栏两滚（页面不滚、文档 ' + shell.docH + 'px 自己滚、目录轨 ' + shell.railRows
      + ' 行 5 组带值速记）· 点一行当场亮、落定不回跳（卡顶 ' + jump.cardTop + 'px 让开组标题）· 滚到哪一栏轨上跟到哪一栏'
      + '（组标题钉顶）· 折叠组自动展开且不写盘 · 行级命中 ' + b2.hitRows + ' 处、回车落点可见、高亮自清、Esc 清空'
      + ' · 1024 档零溢出 · 滚动只有一个出口');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
