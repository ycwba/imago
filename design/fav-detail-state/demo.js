/* 我的收藏 ·「卡片同形 + 详情就地展开」设计稿的交互层。
   稿子不连真数据：内容在 data.js 里（前 15 条是真机取出来的，后 2 条是稿子专用的演示状态）。
   交互只演示两件事：
     ① 各种收藏都是一张卡（同宽同形），状态只换内容
     ② 点「详情」→ **那张卡就地打开**（网格档 = 行下面接一条带子；清单档 = 卡自己变高）
   展开的接线走**公共件**（Kit.expand），与资产库那一稿是同一份。 */
const ITEMS = window.FAV_ITEMS || [];

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const $ = s => document.querySelector(s);
const state = { q: '', type: 'all', view: 'grid', theme: 'light', openKey: '' };

/* 筛选档位：**照抄真品那份**（web/pages/favorites.js:14）——
   内部值是「文件」，芯片上写的是「其它」。这一稿保留真品的这个写法：
   同一个屏幕上芯片写「其它」、卡面 meta 行写「文件」，两处叫法不一致
   —— 那是真品的现状，值得在稿子里看得见（见 DESIGN.md §9）。 */
const TYPES = [['all', '全部'], ['图片', '图片'], ['视频', '视频'], ['音频', '音频'], ['文件', '其它']];

/* ─────────────────────────── 这一页的状态 = 字节在哪 ─────────────────────────── */

const STATE_META = {
  local: { label: '本机', badge: 'local', kind: 'ok' },
  cloud: { label: '云端', badge: 'cloud', kind: 'idle' },
  /* 「只剩外链」在徽标那一层仍然是**云端**（它确实只在平台上）——
     坏在哪由媒体格里的琥珀牌与展开后的诊断块说，徽标不另造一档。 */
  stale: { label: '云端', badge: 'cloud', kind: 'warn' },
  upload: { label: '本地上传', badge: 'local', kind: 'ok' },
};

const isStale = it => it.state === 'stale';
const hasPicture = it => !!it.thumb && !isStale(it);

/* ─────────────────────────── 筛选 ─────────────────────────── */

function passScope(it) {
  if (state.type !== 'all' && it.type !== state.type) return false;
  const q = state.q.trim().toLowerCase();
  if (!q) return true;
  const hay = ((it.title || '') + ' ' + (it.note || '') + ' ' + (it.provider || '') + ' ' + (it.assetId || '')).toLowerCase();
  return hay.includes(q);
}

function filtered() { return ITEMS.filter(passScope); }

/* ─────────────────────────── 卡片 ───────────────────────────
   **同一副骨骸**：产品公共的竖排卡壳（.card / .card-surface / .card-shell-*）。
   状态只换**媒体格里的内容**与**多出的一行**。 */

function mediaHTML(it) {
  if (hasPicture(it)) {
    return '<img src="' + esc(it.thumb) + '" alt="" loading="lazy" decoding="async">';
  }
  if (isStale(it)) {
    return '<span class="plate plate--stale"><span class="plate-st">只剩外链</span>'
      + '<span class="plate-t">外链已过期</span></span>';
  }
  if (it.type === '音频') {
    return '<span class="plate plate--audio"><span class="plate-st">音频</span>'
      + '<span class="plate-t">' + esc(it.format) + (it.duration ? ' · ' + it.duration + 's' : '') + '</span></span>';
  }
  if (it.type === '视频') {
    return '<span class="plate plate--plain"><span class="plate-st">视频</span>'
      + '<span class="plate-t">' + esc(it.format) + (it.duration ? ' · ' + it.duration + 's' : '') + '</span></span>';
  }
  return '<span class="plate plate--file"><span class="plate-st">文件</span>'
    + '<span class="plate-t">' + esc(it.format) + '</span></span>';
}

function noteHTML(it) {
  const has = !!(it.note && it.note.trim());
  return '<div class="fv-note' + (has ? '' : ' empty') + '">'
    + '<textarea rows="1" data-note="' + esc(it.key) + '" placeholder="写备注：这条素材是干什么用的（搜索和 AI 都会用它）">'
    + esc(it.note || '') + '</textarea></div>';
}

function badgeHTML(it) {
  const m = STATE_META[it.state] || STATE_META.local;
  return '<span class="srcbadge ' + m.badge + '">' + m.label + '</span>';
}

function metaOf(it) {
  /* 徽标已经说了「字节在哪」，来源行就别再说一遍（本机 · 本机 · 图片…那种重复）。 */
  const m = STATE_META[it.state] || STATE_META.local;
  const src = (it.state === 'local' || it.state === 'upload') ? '' : (it.provider || '');
  return [src, it.type, it.format, it.size !== '—' ? it.size : '', it.date]
    .filter(Boolean).join(' · ');
}

function actsHTML(it) {
  const b = [];
  if (it.state !== 'upload') b.push('<button class="ghost" data-act="reuse">复用</button>');
  b.push('<button class="ghost" data-act="dl">下载</button>');
  b.push('<button class="ghost fv-open" data-act="open" data-kit-toggle>详情</button>');
  return b.join('');
}

function cardHTML(it) {
  return '<article class="card card-surface fv-card" data-key="' + esc(it.key) + '">'
    + '<div class="card-shell-media thumb" data-act="lb">' + mediaHTML(it) + '</div>'
    + '<div class="card-shell-body">'
    + noteHTML(it)
    + '<div class="t" data-act="lb" title="' + esc(it.title) + '">' + esc(it.title) + '</div>'
    + '<div class="m">' + badgeHTML(it) + esc(metaOf(it)) + '</div>'
    + '<div class="acts card-shell-actions">' + actsHTML(it) + '</div>'
    + '<div class="exp"><div class="exp-in"><div class="exp-body">'
    + expBodyHTML(it)
    + '</div></div></div>'
    + '</div></article>';
}

/* ─────────────────────────── 展开的详情 ─────────────────────────── */

function ledgerHTML(it) {
  const m = STATE_META[it.state] || STATE_META.local;
  const rows = [
    ['字节在哪', m.label, false],
    /* 来源与「字节在哪」是同一件事时不重复列（本机就是本机） */
    ['来源', it.provider === m.label ? '' : it.provider, false],
    /* 「只剩外链」是两件事：字节在平台上（=云端），而**外链过期了**（另一件事） */
    ['外链', isStale(it) ? '已过期 · 这次没换回来' : '', false],
    ['类型', it.type, false],
    ['格式', it.format, false],
    ['大小', it.size !== '—' ? it.size : '', true],
    ['时长', it.duration ? it.duration + ' 秒' : '', false],
    ['收藏时间', it.date, true],
    ['任务号', it.taskId, true],
    ['资产号', it.assetId, true],
  ].filter(r => r[1]);
  return rows.map(r => '<div class="led-i"><span class="k">' + esc(r[0]) + '</span>'
    + '<span class="v' + (r[2] ? ' mono' : '') + '">' + esc(r[1]) + '</span></div>').join('');
}

function diagBlockHTML(it) {
  if (!isStale(it)) return '';
  /* 「只剩外链」也要说清代价：这一条**看不了**，得先回源换一份新的地址，
     换不回来就得重新生成 —— 那是要花钱的。 */
  return '<div class="diag diag--warn">'
    + '<div class="why"><span class="why-k">为什么看不了</span>'
    + '<span class="why-t warn">' + esc(it.staleWhy || '签名外链已过期，这次回源没换回来') + '</span></div>'
    + '<div class="diag-cost">这一条<span class="warn">不能直接看</span> · 回源换地址不花钱，'
    + '换不回来只能重新生成（<b>要再扣一次费</b>）</div>'
    + '</div>';
}

function expBodyHTML(it) {
  const acts = expActsHTML(it);
  return diagBlockHTML(it)
    + '<div class="sec-hd">这一条的账</div>'
    + '<div class="led">' + ledgerHTML(it) + '</div>'
    + '<div class="det-prompt-hd">' + (it.state === 'upload' ? '文件名' : '完整提示词')
    + '<button class="ghost mini" data-act="copy">复制</button></div>'
    + '<div class="det-prompt">' + esc(it.title) + '</div>'
    + (it.note ? '<div class="det-prompt-hd">备注</div><div class="det-prompt">' + esc(it.note) + '</div>' : '')
    + (acts ? '<div class="exp-acts">' + acts + '</div>' : '');
}

/* 展开后**多出来的**动作：卡面那一排（复用 / 下载 / 详情）一直都在，
   这一行只放还没出现过的那些 —— 破坏性的「移出收藏」在这里，不在卡面上。 */
function expActsHTML(it) {
  const b = [];
  if (isStale(it)) b.push('<button class="ghost" data-act="resign">回源换新地址</button>');
  if (it.state === 'cloud' || isStale(it)) b.push('<button class="ghost" data-act="pull">存回本机</button>');
  b.push('<span class="sp"></span>');
  b.push('<button class="ghost danger" data-act="drop">移出收藏</button>');
  return b.join('');
}

/* ─────────────────────────── 列表 ─────────────────────────── */

function colsNow() {
  const box = $('#fvList');
  const w = box.clientWidth || 1;
  const min = state.view === 'compact' ? 200 : 268;   /* --sz-card-sm / --sz-card */
  const gap = state.view === 'compact' ? 10 : 16;      /* --sp-10 / --sp-16 */
  return Math.max(1, Math.floor((w + gap) / (min + gap)));
}

function renderList() {
  const list = filtered();
  const box = $('#fvList');
  box.classList.remove('is-grid', 'is-compact', 'is-list');
  box.classList.add('is-' + state.view);
  $('#fvPgi').textContent = '共 ' + ITEMS.length + ' 条 · 本页 ' + list.length + ' 条';
  if (!list.length) {
    box.innerHTML = '<div class="empty">按现在这些条件一条都没有。<br>清掉条件再看全部 ' + ITEMS.length + ' 条。</div>';
    return;
  }
  /* 网格档：一行几格是**算出来的**（--fv-cols），
     展开的内容接在**它那一行的下面**（公共件 .band）——
     格子长高会把同一行别的格子底下留出空洞，网格最怕这种。 */
  const cols = state.view === 'list' ? 1 : colsNow();
  box.style.setProperty('--fv-cols', String(cols));
  const rows = [];
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols));
  box.innerHTML = rows.map(row => {
    const open = row.find(it => it.key === state.openKey);
    return '<div class="fv-row">' + row.map(cardHTML).join('') + '</div>'
      + (open && state.view !== 'list'
        ? '<div class="band" data-for="' + esc(open.key) + '">'
          + '<span class="band-tether"></span>' + bandHTML(open) + '</div>'
        : '');
  }).join('');
  measureBand();
}

function bandHTML(it) {
  return '<div class="band-in">'
    + '<div class="band-hd">'
    + '<span class="t">' + esc(it.title) + '</span>'
    + '<span class="sp"></span>'
    + '<button class="ghost fv-open" data-act="close">收起</button>'
    + '</div>'
    + expBodyHTML(it)
    + '</div>';
}

/* 连线落在哪儿是**量出来的**（公共件 Kit.anchor） */
function measureBand() {
  const band = document.querySelector('.band');
  if (!band) return;
  const card = document.querySelector('.fv-card[data-key="' + band.dataset.for + '"]');
  if (!card) return;
  window.Kit.anchor(band, card);
}

/* ─────────────────────────── 展开 / 收起 ─────────────────────────── */

function toggleCard(key, force) {
  const it = ITEMS.find(x => x.key === key);
  if (!it) return;
  const want = force === undefined ? state.openKey !== key : force;
  if (state.view === 'list') {
    /* 清单档：卡自己变高（展开的东西在卡自己这一行里） */
    const card = document.querySelector('.fv-card[data-key="' + key + '"]');
    if (!card) return;
    window.Kit.expand(card, { force: want, scope: $('#fvBody') });
    state.openKey = want ? key : '';
    if (want) card.scrollIntoView({ block: 'nearest' });
    return;
  }
  /* 网格档：行下面接一条带子（整行宽，别的格子不动） */
  state.openKey = want ? key : '';
  renderList();
  if (state.openKey) {
    const el = document.querySelector('.fv-card[data-key="' + key + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
}

function closeAll() {
  state.openKey = '';
  window.Kit.closeAll($('#fvBody'));
  if (state.view !== 'list') renderList();
}

/* ─────────────────────────── 页头 / 概览条 / 筛选 ─────────────────────────── */

function renderSum() {
  const n = { local: 0, cloud: 0, stale: 0, upload: 0 };
  ITEMS.forEach(it => { n[it.state] = (n[it.state] || 0) + 1; });
  const total = ITEMS.length || 1;
  const localN = n.local + n.upload;
  const cloudN = n.cloud;
  const staleN = n.stale;
  $('#fvSum').innerHTML = ''
    + '<span class="fv-sum-i"><i class="k local"></i>本机 <b>' + localN + '</b></span>'
    + '<span class="fv-sum-i"><i class="k cloud"></i>云端 <b>' + cloudN + '</b></span>'
    + (staleN ? '<span class="fv-sum-i stale"><i class="k stale"></i>只剩外链 <b>' + staleN + '</b></span>' : '')
    + '<span class="fv-sum-bar">'
    + '<i class="local" style="width:' + Math.round(localN / total * 100) + '%"></i>'
    + '<i class="cloud" style="width:' + Math.round(cloudN / total * 100) + '%"></i>'
    + '<i class="stale" style="width:' + Math.round(staleN / total * 100) + '%"></i>'
    + '</span>'
    + '<span class="sp" style="flex:1"></span>'
    + '<span>' + ITEMS.length + ' 条 · 收藏的是你挑过的东西</span>';
  $('#fvSub').textContent = ITEMS.length + ' 条';
}

function renderTypeSeg() {
  $('#fvType').innerHTML = TYPES.map(([v, label]) => {
    const n = v === 'all' ? ITEMS.length : ITEMS.filter(x => x.type === v).length;
    if (v !== 'all' && !n) return '';
    return '<button type="button" class="' + (state.type === v ? 'on' : '') + '" data-type="' + v + '">'
      + label + '<span class="seg-n">' + n + '</span></button>';
  }).join('');
}

/* ─────────────────────────── 接线 ─────────────────────────── */

/* 备注那一行跟着字长高（不拖右下角那个把手） */
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 76) + 'px';
}

function bind() {
  $('#fvType').addEventListener('click', e => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    state.type = b.dataset.type;
    closeAll();
    renderTypeSeg(); renderList();
  });
  $('#fvQ').addEventListener('input', e => { state.q = e.target.value; renderList(); });
  $('#fvAi').addEventListener('click', () => { $('#fvQ').value = ''; state.q = ''; renderList(); });
  $('#fvUpload').addEventListener('click', () => { /* 稿子不演示上传 */ });
  $('#fvView').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    document.querySelectorAll('#fvView button').forEach(x => x.classList.toggle('active', x.dataset.view === state.view));
    closeAll();
    renderList();
    /* 换档时把滚动位置归零：列表是**自己滚**的那一栏，
       上一档滚到哪，換档后不该接着从那儿看（否则第一行是半截的）。 */
    $('#fvList').scrollTop = 0;
  });
  let rsTimer = null;
  window.addEventListener('resize', () => {
    if (state.view === 'list') return;
    clearTimeout(rsTimer);
    rsTimer = setTimeout(renderList, 120);
  });

  /* 卡面：点「详情」→ 那张卡就地打开；点缩略图或标题 → 灯箱（稿子不演示） */
  $('#fvList').addEventListener('click', e => {
    const band = e.target.closest('.band');
    if (band) {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'close') toggleCard(band.dataset.for, false);
      return;
    }
    const card = e.target.closest('.fv-card');
    if (!card) return;
    const it = ITEMS.find(x => x.key === card.dataset.key);
    if (!it) return;
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'open') { toggleCard(it.key, true); return; }
      if (a === 'close') { toggleCard(it.key, false); return; }
      return;                      /* 其余动作：稿子不落真数据 */
    }
    toggleCard(it.key);
  });

  /* 备注：就地编辑（写入路径在真品里是 Fav.setNote 那一个，稿子只改内存） */
  $('#fvList').addEventListener('input', e => {
    const ta = e.target.closest('textarea[data-note]');
    if (!ta) return;
    const it = ITEMS.find(x => x.key === ta.dataset.note);
    if (!it) return;
    it.note = ta.value;
    /* 空位与有字要**当场**换过来（不是等失焦）：那一行写着「＋ 写备注」而底下正打着字，
       看着像两件事。 */
    const wrap = ta.closest('.fv-note');
    if (wrap) wrap.classList.toggle('empty', !it.note.trim());
    autoGrow(ta);
  });
  $('#fvList').addEventListener('blur', e => {
    const ta = e.target.closest('textarea[data-note]');
    if (!ta) return;
    const it = ITEMS.find(x => x.key === ta.dataset.note);
    if (!it) return;
    it.note = String(it.note || '').trim();
    const wrap = ta.closest('.fv-note');
    if (wrap) wrap.classList.toggle('empty', !it.note);
  }, true);

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });

  $('#sbTheme').addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
  });
  document.querySelector('.sb-logo').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.toggle('wide');
  });
}

/* 出图脚本用的口 */
window.__demo = {
  open: key => toggleCard(key, true),
  close: () => closeAll(),
  set: o => {
    if (o.view) { state.view = o.view; document.querySelectorAll('#fvView button').forEach(x => x.classList.toggle('active', x.dataset.view === o.view)); }
    if (o.theme) { state.theme = o.theme; document.documentElement.setAttribute('data-theme', o.theme); }
    if (o.type) state.type = o.type;
    if (o.q !== undefined) { state.q = o.q; $('#fvQ').value = o.q; }
    closeAll();
    renderSum(); renderTypeSeg(); renderList();
    $('#fvList').scrollTop = 0;      /* 换档/重画后回到顶部，别停在上一档的滚动位置 */
    if (o.open) window.__demo.open(o.open);
  },
};

bind();
renderSum();
renderTypeSeg();
renderList();
