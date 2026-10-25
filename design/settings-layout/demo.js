/* 拾帧 · 设置 —— 重设计稿的交互层
   ---------------------------------------------------------------------------
   这一稿的结构：
     左 = 目录轨（索引：5 组 17 行，每行带它的**当前值**）
     右 = 一条**连续的滚动文档**：5 组、15 张卡从上到下排成一条，
         滚到哪一栏就接着滚到下一栏 —— 每一栏不是独立的一屏。
   轨上点一项 = 滚到那一栏（平滑滚动 + 钉住的组标题 + 滚到位的项高亮）。

   稿子里的数据是静态的（data.js），控件点了会变，但不会真的改任何东西。 */
(function () {
  'use strict';

  const { GROUPS, CARDS } = window.SETTINGS;
  const $ = (s, r) => (r || document).querySelector(s);

  /* ---------- 图标：描边式，16px，跟产品那一套一个画法 ---------- */
  const ICONS = {
    key: '<circle cx="7.5" cy="10.5" r="3.5"/><path d="M10.5 8.5 15 4M13 6l2 2"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4"/>',
    list: '<path d="M5 4h9M5 8h9M5 12h9"/><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
    net: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.2 2 9.8 0 12M8 2c-2 2.2-2 9.8 0 12"/>',
    folder: '<path d="M2 13V4a1 1 0 0 1 1-1h3l1.5 2H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/>',
    users: '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><path d="M11 3.6a2.5 2.5 0 0 1 0 4.8M12 9.8c1.6.5 2.5 1.8 2.5 3.7"/>',
    chat: '<path d="M14 7.5A5.5 5.5 0 0 1 3.8 10.7L2 14l3.3-1.5A5.5 5.5 0 1 1 14 7.5Z"/>',
    wand: '<path d="M3 13 11 5M12 2.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z"/>',
    stack: '<path d="M8 1.8 14.2 5 8 8.2 1.8 5Z"/><path d="m1.8 8 6.2 3.2L14.2 8M1.8 11l6.2 3.2L14.2 11"/>',
    sync: '<path d="M14 7A6 6 0 0 0 3.4 4.2"/><path d="M2 9a6 6 0 0 0 10.6 2.8"/><path d="M3.4 1.6v2.8h2.8M12.6 14.4v-2.8H9.8"/>',
    archive: '<path d="M2 4h12v2H2zM3 6v8h10V6"/><path d="M6.5 9h3"/>',
    save: '<path d="M3 2h8l2 2v10H3z"/><path d="M5.5 2v4h5V2M5.5 14v-4h5v4"/>',
    pulse: '<path d="M1.5 8h3l1.6-3.5L9 12l1.6-4h3.9"/>',
    disk: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.6"/>',
    mic: '<rect x="6" y="1.8" width="4" height="7" rx="2"/><path d="M3.8 7.2a4.2 4.2 0 0 0 8.4 0M8 11.4v2.8M5.6 14.2h4.8"/>',
    broom: '<path d="M9.5 2.5 13 6M11 4 4 11l1 1 7-7"/><path d="M3 12.5 5.5 15"/>',
    gear: '<circle cx="8" cy="8" r="2.4"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 4 4"/>',
    chevron: '<path d="m4 6 4 4 4-4"/>'
  };
  function icon(name, cls) {
    const p = ICONS[name] || '';
    return '<svg class="' + (cls || 'ic') + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function mark(text, q) {
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  /* ---------- 目录：拍平一份清单，滚动定位与搜索都用它 ---------- */
  const FLAT = [];
  GROUPS.forEach(g => g.items.forEach(it => FLAT.push({ group: g, item: it })));

  const activeTab = { providers: 'image' };  /* 带标签页的卡，当前停在哪一档 */
  const railEl = $('#railScroll');
  const detailEl = $('#detail');
  const scrollEl = $('#dtScroll');
  const searchEl = $('#railSearch');

  let query = '';
  let curItemId = 'providers';
  let cardEls = [];        /* 文档里那些卡（按文档顺序） */
  let groupH = 32;         /* 钉住的组标题高度 */

  /* ======================================================================
     左：目录轨
     ==================================================================== */
  function renderRail() {
    const q = query.trim().toLowerCase();
    let shown = 0;
    let html = '';

    GROUPS.forEach(g => {
      /* 搜的是「这一栏是什么」，不只是它的名字：别名（关键词）也算命中，
         否则用户搜「密钥」会搜不到「生成平台」那一栏。 */
      const hit = it => !q || it.title.toLowerCase().indexOf(q) >= 0 ||
        (it.value || '').toLowerCase().indexOf(q) >= 0 ||
        (it.kw || '').toLowerCase().indexOf(q) >= 0;
      const items = g.items.filter(hit);
      if (q && !items.length) return;
      shown += items.length;

      const folded = g.fold && !g.open && !q;
      html += '<section class="rl-group' + (g.fold ? ' fold' : '') + (folded ? '' : ' open') +
        (g.key === groupOf(curItemId) ? ' cur' : '') + '" data-group="' + g.key + '">';
      if (g.fold) {
        html += '<button class="rl-fold" type="button" data-fold="' + g.key + '" aria-expanded="' + (!folded) + '">' +
          icon('chevron', 'ar') + '<span class="rl-group-t">' + g.title + '</span>' +
          '<span class="rl-group-n">' + g.items.length + '</span></button>';
      } else {
        html += '<div class="rl-group-h"><span class="rl-group-t">' + g.title + '</span>' +
          '<span class="rl-group-n">' + g.items.length + '</span></div>';
      }
      html += '<div class="rl-group-nt">' + g.note + '</div>';
      html += '<div class="rl-items">';
      items.forEach(it => {
        const on = it.id === curItemId;
        const name = q ? mark(it.title, q) : esc(it.title);
        html += '<a class="rl-item' + (on ? ' on' : '') + '" href="#" data-item="' + it.id + '" data-group="' + g.key + '">' +
          '<span class="rl-name">' + name + '</span>' +
          '<span class="rl-lead"></span>' +
          '<span class="rl-val">' + esc(it.value || '') + '</span></a>';
      });
      html += '</div></section>';
    });

    if (!shown) html = '<div class="rl-empty">没有一项设置叫「' + esc(query) + '」<br>换个词试试：密钥、目录、分页、润色</div>';
    railEl.innerHTML = html;
  }

  function groupOf(itemId) {
    const f = FLAT.find(x => x.item.id === itemId);
    return f ? f.group.key : '';
  }

  /* ======================================================================
     右：一条连续的文档
     ==================================================================== */
  function renderDoc() {
    let html = '';
    GROUPS.forEach(g => {
      html += '<section class="set-group" data-group="' + g.key + '">';
      html += '<h2 class="set-group-h"><span class="sg-t">' + g.title + '</span>' +
        '<span class="sg-n">' + g.items.length + ' 项</span>' +
        '<span class="sg-nt">' + g.note + '</span></h2>';
      /* 「语音识别」「联网搜索」是供应商那张卡里的两档（同一层级，不是另一张卡）——
         轨上只索引「卡」，这两档不另占行。 */
      g.items.forEach(it => { html += renderCard(it, g); });
      html += '</section>';
    });
    scrollEl.innerHTML = html;

    cardEls = Array.prototype.map.call(scrollEl.querySelectorAll('.card'), el => ({
      id: el.getAttribute('data-item'),
      el: el
    }));
    const h = scrollEl.querySelector('.set-group-h');
    if (h) {
      groupH = Math.round(h.getBoundingClientRect().height);
      /* 卡顶停在哪：钉住的组标题下面（组标题多高，卡就让多少） */
      document.documentElement.style.setProperty('--anchor', (groupH + 8) + 'px');
    }

    applyTabs();
    spy();
  }

  function renderCard(it, g) {
    const c = CARDS[it.id];
    if (!c) return '';
    const cardId = it.id;
    let html = '';

    html += '<article class="card' + (c.tabs ? ' has-tabs' : '') + '" data-item="' + cardId + '" data-group="' + g.key + '">';

    html += '<header class="card-h">' + icon(c.icon || 'gear', 'card-ic') +
      '<h2 class="card-t">' + esc(c.title) + '</h2>' +
      (c.headActions ? '<div class="card-h-acts">' + c.headActions.map(a =>
        '<button class="btn' + (a.indexOf('添加') === 0 ? ' pri' : '') + '" type="button">' + esc(a) + '</button>').join('') +
        '</div>' : '') + '</header>';

    if (c.intro) html += '<div class="card-intro">' + c.intro + '</div>';

    if (c.tabs) {
      html += '<div class="card-tabs">';
      c.tabs.forEach(t => {
        html += '<button class="card-tab" type="button" data-tab="' + t.id + '">' + esc(t.label) +
          (t.count ? '<span class="n">' + t.count + '</span>' : '') + '</button>';
      });
      html += '</div><div class="card-body">';
      c.tabs.forEach(t => {
        html += '<div class="tabpane" data-tab="' + t.id + '">' + renderPane(c, t.id) + '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="card-body">' + renderPane(c, null) + '</div>';
    }

    html += '</article>';
    return html;
  }

  function renderPane(c, tabId) {
    let html = '';
    if (c.blocks && c.blocks[tabId]) html += renderBlocks(c.blocks[tabId]);
    if (c.rows) html += renderRows(c.rows);
    if (c.kv) html += renderKv(c.kv);
    if (c.note) html += '<div class="blk-note" style="margin-top:var(--sp-16)">' + c.note + '</div>';
    if (c.actions && c.actions.length) html += '<div class="btn-row">' +
      c.actions.map(a => '<button class="btn' + (a === '添加新 Skill' ? ' pri' : '') + '" type="button">' + esc(a) + '</button>').join('') +
      '</div>';
    if (c.footNote) html += '<div class="foot-note">' + esc(c.footNote) + '</div>';
    return html;
  }

  function renderBlocks(blocks) {
    let html = '';
    blocks.forEach(b => {
      if (b.t === 'note') html += '<div class="blk-note">' + b.text + '</div>';
      else if (b.t === 'rows') html += renderRows(b.items);
      else if (b.t === 'actions') html += '<div class="btn-row">' + b.items.map(i =>
        '<button class="btn ' + (i.kind || '') + '" type="button">' + esc(i.label) + '</button>').join('') + '</div>';
    });
    return html;
  }

  function renderRows(rows) {
    let html = '<div class="rows">';
    rows.forEach(r => {
      /* 列表型内容（供应商、Skill 场景）整块占满，不塞进那一行窄的控件位 */
      const block = r.ctl && (r.ctl.type === 'providers' || r.ctl.type === 'scenes');
      html += '<div class="rw">';
      html += '<div class="rw-l">' + (r.label ? esc(r.label) : '') + '</div>';
      html += '<div class="rw-m">';
      if (block) {
        html += renderCtl(r.ctl);
        if (r.note) html += '<div class="rw-n">' + r.note + '</div>';
      } else {
        html += '<div class="rw-inline">';
        html += renderCtl(r.ctl);
        if (r.ctl2) html += renderCtl(r.ctl2);
        if (r.actions && r.actions.length) {
          html += '<span class="rw-acts">' + r.actions.map(a => '<button class="btn ghost" type="button">' + esc(a) + '</button>').join('') + '</span>';
        }
        html += '</div>';
        if (r.note) html += '<div class="rw-n">' + r.note + '</div>';
      }
      html += '</div>';
      html += '<div class="rw-s' + (r.statusKind ? ' ' + r.statusKind : '') + '">' + (r.status ? esc(r.status) : '') + '</div>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderCtl(c) {
    if (!c) return '';
    if (c.type === 'seg') {
      return '<span class="seg">' + c.options.map((o, i) =>
        '<button type="button" class="' + (i === c.active ? 'on' : '') + '">' + esc(o) + '</button>').join('') + '</span>';
    }
    if (c.type === 'input') {
      return '<span class="rw-inline"><input class="inp" type="text" value="' + esc(c.value || '') + '"' +
        (c.width ? ' style="width:' + c.width + 'px"' : '') + ' placeholder="' + esc(c.placeholder || '') + '">' +
        (c.unit ? '<span class="unit">' + esc(c.unit) + '</span>' : '') + '</span>';
    }
    if (c.type === 'select') {
      return '<select class="sel">' + c.options.map(o =>
        '<option' + (o === c.value ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    }
    if (c.type === 'check') {
      return '<label class="chk"><input type="checkbox"' + (c.checked ? ' checked' : '') + '><span>' + esc(c.label) + '</span></label>';
    }
    if (c.type === 'static') {
      return '<span class="stat">' + esc(c.text) + '</span>';
    }
    if (c.type === 'dir') {
      return '<span class="dircell"><input class="inp" type="text" value="' + esc(c.value || '') + '">' +
        c.buttons.map(b => '<button class="btn" type="button">' + esc(b) + '</button>').join('') + '</span>';
    }
    if (c.type === 'buttons') {
      return '<span class="rw-inline">' + c.items.map(i =>
        '<button class="btn' + (i.kind ? ' ' + i.kind : '') + '" type="button">' + esc(i.label) + '</button>').join('') + '</span>';
    }
    if (c.type === 'providers') {
      let h = '';
      c.items.forEach(p => {
        h += '<div class="pv"><div class="pv-h">' +
          '<span class="pv-n">' + esc(p.name) + '</span>' +
          '<span class="pv-k">' + esc(p.kinds) + '</span>' +
          '<span class="pv-key"><input class="inp" type="password" value="" placeholder="' + esc(p.key) + '"></span>' +
          '<span class="pv-acts">' + p.actions.map(a => '<button class="btn ghost" type="button">' + esc(a) + '</button>').join('') +
          '<span class="pv-tag">' + esc(p.status) + '</span></span></div>' +
          '<div class="pv-meta">' + esc(p.meta) + '</div></div>';
      });
      return h;
    }
    if (c.type === 'scenes') {
      let h = '<div class="sc">';
      c.items.forEach(g => {
        h += '<div class="sc-g">' + esc(g.g) + '<span class="n">' + g.n + '</span></div>';
        g.rows.forEach(r => {
          const st = r.state === '空档' ? ' gap' : (r.state === '冲突' ? ' bad' : '');
          h += '<div class="sc-i"><span>' + esc(r.name) + '</span><span class="st' + st + '">' + esc(r.state) + '</span></div>';
        });
      });
      return h + '</div>';
    }
    return '';
  }

  function renderKv(kv) {
    let html = '<div class="kv">';
    kv.forEach(r => {
      html += '<div class="kv-r"><div class="kv-k">' + esc(r.k) + '</div>' +
        '<div class="kv-v ' + (r.s === 'warn' ? 'warn' : '') + '">' + esc(r.v) + '</div>' +
        '<div class="kv-d">' + esc(r.d) + '</div></div>';
    });
    return html + '</div>';
  }

  /* ======================================================================
     标签页：只切显示，不重画文档（重画会把滚动位置甩掉，就不叫「无缝」了）
     ==================================================================== */
  function applyTabs() {
    scrollEl.querySelectorAll('.card.has-tabs').forEach(card => {
      const id = card.getAttribute('data-item');
      const active = activeTab[id] || 'image';
      card.querySelectorAll('.tabpane').forEach(p => {
        p.hidden = p.getAttribute('data-tab') !== active;
      });
      card.querySelectorAll('.card-tab').forEach(b => {
        b.classList.toggle('on', b.getAttribute('data-tab') === active);
      });
    });
  }

  /* ======================================================================
     滚动定位：轨上点一项 → 平滑滚到那一栏；滚到哪里 → 轨上亮哪一项
     ==================================================================== */
  function railItemFor(cardId) { return cardId; }

  function gotoItem(id, smooth) {
    const f = FLAT.find(x => x.item.id === id);
    if (!f) return;
    const cardId = f.item.id;
    const card = scrollEl.querySelector('.card[data-item="' + cardId + '"]');
    if (card) {
      /* 卡顶停在钉住的组标题下面（.card 的 scroll-margin-top 管这件事） */
      card.scrollIntoView({ behavior: smooth === false ? 'auto' : 'smooth', block: 'start' });
    }
    setCur(id);
  }

  function setCur(id) {
    if (id === curItemId) { return; }
    curItemId = id;
    railEl.querySelectorAll('.rl-item').forEach(el => {
      el.classList.toggle('on', el.getAttribute('data-item') === id);
    });
    railEl.querySelectorAll('.rl-group').forEach(sec => {
      sec.classList.toggle('cur', sec.getAttribute('data-group') === groupOf(id));
    });
    updateFoot();
  }

  /* 滚动到哪儿，轨上就亮哪一项：
     拿视口上三分之一那条线当锚点 —— 锚点落在哪张卡里，就亮哪张；
     锚点正好在两张卡之间（组标题那一段）就亮刚过去的那张。 */
  function spy() {
    if (!cardEls.length) return;
    const dtRect = scrollEl.getBoundingClientRect();
    const anchor = dtRect.top + Math.min(180, Math.round(scrollEl.clientHeight * 0.32));
    let best = null;
    let above = null;
    for (let i = 0; i < cardEls.length; i++) {
      const r = cardEls[i].el.getBoundingClientRect();
      if (r.top <= anchor) above = cardEls[i];
      if (r.top <= anchor && anchor < r.bottom) { best = cardEls[i]; break; }
    }
    if (!best) best = above || cardEls[0];
    /* 滚到底了：最后一张卡算当前（否则最后一栏永远亮不到） */
    if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 6) best = cardEls[cardEls.length - 1];
    if (best) setCur(railItemFor(best.id));
  }

  let ticking = false;
  scrollEl.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; spy(); });
  }, { passive: true });

  function updateFoot() {
    const i = FLAT.findIndex(f => f.item.id === curItemId);
    const f = i >= 0 ? FLAT[i] : null;
    const el = $('#dtPos');
    if (el && f) el.textContent = '第 ' + (i + 1) + ' / ' + FLAT.length + ' 项 · ' + f.item.title;
  }

  /* ======================================================================
     事件
     ==================================================================== */
  document.addEventListener('click', function (e) {
    const item = e.target.closest('.rl-item');
    if (item) { e.preventDefault(); gotoItem(item.getAttribute('data-item')); return; }

    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const g = GROUPS.find(x => x.key === fold.getAttribute('data-fold'));
      g.open = !g.open;
      renderRail();
      return;
    }

    const tab = e.target.closest('.card-tab');
    if (tab) {
      const card = tab.closest('.card');
      const cardId = card.getAttribute('data-item');
      activeTab[cardId] = tab.getAttribute('data-tab');
      applyTabs();
      /* 卡里那排标签页与目录轨是一件事：轨上「生成平台」那一行指的就是这张卡的
         图片 / 视频 / 语音 / 文字四档。点哪边都把两边点成同一个。 */
      const owner = { image: 'providers', video: 'providers', voice: 'providers', text: 'providers' };
      if (owner[tab.getAttribute('data-tab')]) setCur(owner[tab.getAttribute('data-tab')]);
      return;
    }

    /* 分段开关 / 勾选：只改样子 */
    const segb = e.target.closest('.seg button');
    if (segb) {
      const seg = segb.parentNode;
      Array.prototype.forEach.call(seg.children, b => b.classList.remove('on'));
      segb.classList.add('on');
      return;
    }
  });

  searchEl.addEventListener('input', function () { query = searchEl.value; renderRail(); });
  searchEl.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { searchEl.value = ''; query = ''; renderRail(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); const first = railEl.querySelector('.rl-item'); if (first) first.focus(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.target === searchEl) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = FLAT.findIndex(f => f.item.id === curItemId);
    const j = e.key === 'ArrowDown' ? Math.min(FLAT.length - 1, i + 1) : Math.max(0, i - 1);
    if (j !== i) { e.preventDefault(); gotoItem(FLAT[j].item.id); }
  });

  renderRail();
  renderDoc();
  updateFoot();
})();
