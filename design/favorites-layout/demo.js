/* 收藏页布局稿的交互层（设计稿专用，不进产品）。
   数据来自 data.js（真机取出来的），这里只负责把「这一屏长什么样」画出来。

   真产品那一页的交互全走公共层（Fav / Wb / Chips / Confirm …）；
   这一稿是纯静态稿，所以这里自己接线，但**接的仍是产品的公共件外观**。 */
(function () {
  'use strict';

  const D = window.FAV_DATA || { items: [], counts: {}, localN: 0, cloudN: 0 };
  const NOTES = window.FAV_NOTES || {};
  const items = D.items.map(it => Object.assign({}, it, { note: NOTES[it.key] || '' }));

  const TYPES = [['all', '全部'], ['图片', '图片'], ['视频', '视频'], ['音频', '音频'], ['其它', '其它']];

  const state = { filter: 'all', q: '', view: 'rows', layout: 'new' };

  /* ── 小工具 ─────────────────────────────────────────────── */
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const typeOf = t => (t === '音频' ? '音频' : t);
  const countOf = t => {
    if (t === 'all') return items.length;
    if (t === '其它') return items.filter(x => !['图片', '视频', '音频'].includes(x.type)).length;
    return items.filter(x => x.type === t).length;
  };
  const SRC = {
    local: { label: '本机', cls: 'local', why: '只在本机（本地上传或本机资产库）' },
    cloud: { label: '云端', cls: 'cloud', why: '本机还没有这份字节，只有平台地址' },
    both: { label: '本机+云端', cls: 'both', why: '本机资产库有副本，平台也有这一条' },
  };
  const srcBadge = st => {
    const b = SRC[st] || SRC.cloud;
    return '<span class="srcbadge ' + b.cls + '" title="' + b.why + '">' + b.label + '</span>';
  };
  const ICON = {
    mic: '<svg viewBox="0 0 16 16" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="5.6" y="1.8" width="4.8" height="7.6" rx="2.4"/><path d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2"/></svg>',
    film: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1.9" y="3" width="12.2" height="10" rx="1.5"/><path d="M4.7 3v10M11.3 3v10M1.9 8h12.2"/></svg>',
    download: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2.6v7.6M5.2 7.4 8 10.2l2.8-2.8M3.4 12.8h9.2"/></svg>',
  };

  /* ── 侧栏（真结构，插进来；前后对照得是同一条侧栏） ────────── */
  $('#sidebar-host').innerHTML = window.SIDEBAR_HTML || '';
  document.documentElement.classList.add('sb-open');
  document.documentElement.style.setProperty('--sbw', '232px');

  const brand = document.querySelector('.sb-brand');
  if (brand) brand.addEventListener('click', () => {
    const open = document.documentElement.classList.toggle('sb-open');
    document.documentElement.style.setProperty('--sbw', open ? '232px' : '56px');
  });
  const themeBtn = document.getElementById('sbTheme');
  if (themeBtn) themeBtn.addEventListener('click', () => {
    const now = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
  });

  /* ── 概览条 ─────────────────────────────────────────────── */
  function renderGauge(list) {
    const local = list.filter(x => x.state === 'local').length;
    const cloud = list.length - local;
    $('#gvTotal').textContent = list.length;
    $('#gvLocal').textContent = local;
    $('#gvCloud').textContent = cloud;
    $('#gvPullN').textContent = cloud;
    $('#fvPull').style.display = cloud ? '' : 'none';
    $('#gvFill').style.width = (list.length ? (local / list.length) * 100 : 0) + '%';
    const warn = $('#gvWarn');
    /* 「过期的图这次没换回来」是产品里真会出现的提醒（回源失败），稿子里保留这一句。 */
    const stale = list.filter(x => x.state === 'cloud' && x.stale).length;
    if (stale) { warn.hidden = false; warn.textContent = '还有 ' + stale + ' 条过期的图这次没换回来（下次打开会再试）'; }
    else { warn.hidden = true; }
  }

  /* ── 筛选芯片 ───────────────────────────────────────────── */
  function renderChips() {
    $('#fvChips').innerHTML = TYPES.map(t =>
      '<button type="button" class="chip' + (state.filter === t[0] ? ' on' : '') + '" data-f="' + t[0] + '">'
      + esc(t[1]) + ' <span class="n">' + countOf(t[0]) + '</span></button>').join('');
    $('#fvChips').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
      state.filter = b.dataset.f;
      renderChips(); render();
    }));
  }

  /* ── 摘录带（签名元素） ─────────────────────────────────── */
  function bandHTML(it, small) {
    const has = !!(it.note && it.note.trim());
    const text = esc(it.note || '').replace(/"/g, '&quot;');
    return '<span class="fv-band' + (has ? '' : ' empty') + (small ? ' sm' : '') + '">'
      + '<span class="fv-band-t" contenteditable="plaintext-only" spellcheck="false"'
      + ' data-key="' + esc(it.key) + '"'
      + (has ? '' : ' data-ph="＋ 写备注"')
      + ' title="写备注：这条素材是干什么用的（搜索和 AI 都会用它）">'
      + (has ? text : '')
      + '</span></span>';
  }

  /* ── 摘录行 ─────────────────────────────────────────────── */
  function rowHTML(it) {
    const meta = [it.format ? String(it.format).toUpperCase() : '', it.size, it.duration ? it.duration + 's' : '']
      .filter(Boolean).join(' · ');
    const date = (it.date || '').slice(5);
    const src = it.state === 'local' ? '本机资产库' : it.provider;
    const frame = it.type === '音频'
      ? '<div class="audio">' + ICON.mic + '<span>' + esc(String(it.format || 'MP3').toUpperCase()) + '</span></div>'
      : (it.thumb ? '<img src="' + esc(it.thumb) + '" alt="' + esc(it.title) + '" loading="lazy">'
        : '<div class="audio">' + ICON.film + '<span>预览还没取回来</span></div>');
    const dur = it.duration ? '<span class="dur">' + esc(it.duration) + 's</span>' : '';
    return '<article class="fv-row" data-key="' + esc(it.key) + '">'
      + '<div class="fv-frame">' + frame + dur + '</div>'
      + '<div class="fv-excerpt">'
      + '<div class="fv-title" title="' + esc(it.title) + '">' + esc(it.title) + '</div>'
      + bandHTML(it)
      + '</div>'
      + '<div class="fv-src">' + srcBadge(it.state) + '</div>'
      + '<div class="fv-meta">'
      + '<div class="m1">' + esc(src) + ' · ' + esc(it.type) + '</div>'
      + '<div class="m2">' + esc([meta, it.duration ? '' : date].filter(Boolean).join(' · ')) + '</div>'
      + '<div class="m3">收藏于 ' + esc(it.date) + '</div>'
      + '</div>'
      + '<div class="fv-acts">'
      + '<button class="ghost" type="button" title="带着这条素材去生成工作台">复用</button>'
      + '<button class="ghost" type="button" title="把这一条存到本机">下载</button>'
      + '<button class="ghost more" type="button" data-more="' + esc(it.key) + '" title="更多" aria-label="更多">⋯</button>'
      + '</div>'
      + '</article>';
  }

  /* ── 缩略墙 ─────────────────────────────────────────────── */
  function tileHTML(it) {
    const frame = it.type === '音频'
      ? '<div class="audio">' + ICON.mic + '<span>' + esc(String(it.format || 'MP3').toUpperCase()) + '</span></div>'
      : (it.thumb ? '<img src="' + esc(it.thumb) + '" alt="' + esc(it.title) + '" loading="lazy">' : '');
    return '<figure class="fv-tile" data-key="' + esc(it.key) + '">'
      + '<div class="tv-frame">' + frame + '</div>'
      + '<figcaption><span class="tt-title">' + esc(it.title) + '</span>' + bandHTML(it, true) + '</figcaption>'
      + '</figure>';
  }

  /* ── 现状复刻（对照档） ─────────────────────────────────── */
  function oldHTML(list) {
    const chips = TYPES.map(t =>
      '<button type="button" class="chip' + (state.filter === t[0] ? ' on' : '') + '" data-f="' + t[0] + '">'
      + esc(t[1]) + ' <span class="n">' + countOf(t[0]) + '</span></button>').join('');
    const cards = list.map(it => {
      const meta = [it.state === 'local' ? '本地文件' : (it.provider || '资产库'), it.type,
        it.format ? String(it.format).toUpperCase() : '', it.size].filter(Boolean).join(' · ');
      const frame = it.type === '音频'
        ? '<div class="audio">' + ICON.mic + '<span>' + esc(String(it.format || 'MP3').toUpperCase()) + '</span></div>'
        : (it.thumb ? '<img src="' + esc(it.thumb) + '" alt="" loading="lazy">' : '');
      return '<div class="card card-surface" data-key="' + esc(it.key) + '">'
        + '<div class="thumb card-shell-media">' + frame + '</div>'
        + '<div class="body card-shell-body">'
        + '<div class="t">' + esc(it.title) + '</div>'
        + '<div class="m">' + srcBadge(it.state) + esc(meta) + '</div>'
        + '<div class="note"><textarea rows="2" placeholder="写备注：这条素材是干什么用的（搜索和 AI 都会用它）">'
        + esc(it.note || '') + '</textarea></div>'
        + '<div class="acts card-shell-actions">'
        + '<button class="ghost" type="button">复用</button>'
        + '<button class="ghost" type="button">下载</button>'
        + '<button class="ghost danger" type="button">移出收藏</button>'
        + '</div></div></div>';
    }).join('');
    return '<div class="fv-old">'
      + '<div class="toolbar">' + chips
      + '<input type="search" placeholder="搜索名称 / 提示词 / 备注" value="' + esc(state.q) + '">'
      + '<button class="tool acc" type="button">AI 找素材</button>'
      + '<span class="sp"></span><span class="cnt">共 ' + list.length + ' 项</span></div>'
      + '<div class="toolbar2"><span class="sp"></span>'
      + '<span class="viewtoggle"><button type="button" class="active" title="网格"><svg viewBox="0 0 14 14" width="15" height="15" fill="currentColor"><rect x="0.6" y="0.6" width="5.6" height="5.6" rx="1.4"/><rect x="7.8" y="0.6" width="5.6" height="5.6" rx="1.4"/><rect x="0.6" y="7.8" width="5.6" height="5.6" rx="1.4"/><rect x="7.8" y="7.8" width="5.6" height="5.6" rx="1.4"/></svg></button>'
      + '<button type="button" title="列表"><svg viewBox="0 0 14 14" width="15" height="15" fill="currentColor"><rect x="0.6" y="1" width="12.8" height="3.2" rx="1.2"/><rect x="0.6" y="5.4" width="12.8" height="3.2" rx="1.2"/><rect x="0.6" y="9.8" width="12.8" height="3.2" rx="1.2"/></svg></button></span>'
      + '<button class="ghost" type="button">存回本机（' + list.filter(x => x.state !== 'local').length + '）</button>'
      + '<button class="ghost" type="button">上传本地文件</button></div>'
      + '<div class="grid">' + (cards || '<div class="empty">还没有收藏</div>') + '</div>'
      + '</div>';
  }

  /* ── 主体 ───────────────────────────────────────────────── */
  function current() {
    const q = state.q.trim().toLowerCase();
    return items.filter(it => {
      if (state.filter !== 'all') {
        if (state.filter === '其它') { if (['图片', '视频', '音频'].includes(it.type)) return false; }
        else if (it.type !== state.filter) return false;
      }
      if (!q) return true;
      return (it.title + ' ' + it.note + ' ' + it.provider + ' ' + it.type).toLowerCase().includes(q);
    });
  }

  function render() {
    const list = current();
    document.body.classList.toggle('is-old', state.layout === 'old');
    renderGauge(list);
    /* 空态要分四种说（沿用产品口径）：搜索无果 / 筛选为空 / 真的还没有收藏 ——
       一律写成「还没有收藏」时，用户会以为自己把收藏弄丢了。 */
    const q = state.q.trim();
    let emptyWhy = '';
    if (!list.length) {
      if (q) emptyWhy = '没有匹配「' + q + '」的收藏：换个词，或清空搜索框看全部。';
      else if (state.filter !== 'all') emptyWhy = '这个筛选条件下没有收藏：把芯片切回「全部」就能看到。';
      else emptyWhy = '还没有收藏。去「资产库」点卡片上的 ☆，或点右上角「上传本地文件」。';
    }
    const body = $('#fvBody');
    if (state.layout === 'old') {
      body.innerHTML = oldHTML(list);
      bindOld();
    } else if (state.view === 'wall') {
      body.innerHTML = '<div class="fv-wall">' + (list.map(tileHTML).join('')
        || '<div class="fv-empty">' + esc(emptyWhy) + '</div>') + '</div>';
    } else {
      body.innerHTML = '<div class="fv-list">' + (list.map(rowHTML).join('')
        || '<div class="fv-empty">' + esc(emptyWhy) + '</div>') + '</div>';
    }
    bindBands();
    bindMore();
    $('#fvPager').style.display = list.length ? '' : 'none';
  }

  /* ── 备注就地编辑 ───────────────────────────────────────── */
  function bindBands() {
    document.querySelectorAll('.fv-band-t').forEach(el => {
      const it = items.find(x => x.key === el.dataset.key);
      if (!it) return;
      const band = el.closest('.fv-band');
      el.addEventListener('input', () => {
        it.note = el.textContent.replace(/^「|」$/g, '');
        band.classList.toggle('empty', !it.note.trim());
      });
      el.addEventListener('focus', () => {
        /* 光标落在引号外面：点一下就进到文字里。 */
        const r = document.createRange(); r.selectNodeContents(el);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      });
      el.addEventListener('blur', () => {
        it.note = it.note.trim();
        el.textContent = it.note;
      });
    });
  }

  /* ── ⋯ 菜单 ─────────────────────────────────────────────── */
  function bindMore() {
    document.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const it = items.find(x => x.key === b.dataset.more);
      if (!it) return;
      const menu = $('#fvMenu');
      menu.innerHTML = '<button type="button" data-act="copy">复制提示词</button>'
        + '<button type="button" data-act="open">打开原地址</button>'
        + '<button type="button" class="danger" data-act="drop">移出收藏</button>';
      menu.hidden = false;
      const r = b.getBoundingClientRect();
      const top = Math.min(r.bottom + 6, window.innerHeight - 120);
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 190)) + 'px';
      menu.style.top = top + 'px';
      menu.querySelectorAll('button').forEach(x => x.addEventListener('click', () => {
        if (x.dataset.act === 'drop') {
          const i = items.indexOf(it);
          if (i >= 0) items.splice(i, 1);
          renderChips(); render();
        }
        menu.hidden = true;
      }));
    }));
    document.addEventListener('click', () => { $('#fvMenu').hidden = true; });
  }

  /* ── 现状档里的事件 ─────────────────────────────────────── */
  function bindOld() {
    $('#fvBody').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
      state.filter = b.dataset.f; render();
    }));
    const s = $('#fvBody').querySelector('input[type="search"]');
    if (s) s.addEventListener('input', () => { state.q = s.value; render(); });
    $('#fvBody').querySelectorAll('textarea').forEach(t => t.addEventListener('input', () => {
      const card = t.closest('.card');
      const it = items.find(x => x.key === card.dataset.key);
      if (it) it.note = t.value;
    }));
  }

  /* ── 顶上的控件 ─────────────────────────────────────────── */
  $('#fvSearch').addEventListener('input', e => { state.q = e.target.value; render(); });
  $('#fvView').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    $('#fvView').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    render();
  }));
  $('#fvLayout').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.layout = b.dataset.layout;
    $('#fvLayout').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    render();
  }));

  renderChips();
  render();

  /* 稿子里给截图脚本用的把手。 */
  window.__favSetLayout = l => {
    state.layout = l;
    $('#fvLayout').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.layout === l));
    render();
  };
  window.__favSetView = v => {
    state.view = v;
    $('#fvView').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.view === v));
    render();
  };
  window.__favSetFilter = f => { state.filter = f; renderChips(); render(); };
  window.__favSetQuery = q => { state.q = q; $('#fvSearch').value = q; render(); };
  window.__favSetTheme = t => document.documentElement.setAttribute('data-theme', t);
})();
