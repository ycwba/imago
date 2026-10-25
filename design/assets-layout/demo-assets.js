/* 资产库布局稿的交互（设计稿专用，不进产品）。
   只做「这一屏长什么样」：真品的取数 / 轮询 / 灯箱 / 多选公共件都不碰。
   稿子里的筛选、计数、按天分槽、就地展开是**这一页自己的算法**。

   卡片的信息层是**产品自己的那一套**（.task > .tmain > .meta1 / .tprompt / .meta2）：
   状态点、状态文字、本机/云端徽标、时刻、提示词、来源行 —— 样式一行没改，
   这一稿只改「这些卡片摆在什么结构里」。 */
import { ENTRIES, MORE } from './data.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  star: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5z"/></svg>',
  starFill: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5z"/></svg>',
  down: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.8v7.4M5 7.4L8 10.4l3-3M2.8 12.6h10.4"/></svg>',
  play: '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M5 3.4l7 4.6-7 4.6z"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>',
  ext: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 2.6H13.4v4.2"/><path d="M13.4 2.6L7.8 8.2"/><path d="M12.4 9.6v2.8a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4V5a1.4 1.4 0 0 1 1.4-1.4h2.8"/></svg>',
  box: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 5.2l5.4 3 5.4-3"/><path d="M2.6 5.2v5.6l5.4 3 5.4-3V5.2L8 2.2z"/></svg>',
  warn: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.6l5.8 10.2H2.2z"/><path d="M8 6.6v3M8 11.6h.01"/></svg>',
};

/* 状态 → 产品那一套的写法（.dot 的三档 + 状态文字） */
const ST = {
  done: { text: '已完成', dot: '' },
  running: { text: '生成中', dot: 'run' },
  queued: { text: '排队中', dot: 'run' },
  failed: { text: '失败', dot: 'fail' },
  uncertain: { text: '结果未知', dot: 'uncertain' },
};

const NOW = new Date('2026-10-25T15:40');
const state = {
  type: '全部',
  prov: '全部',
  time: 'all',
  q: '',
  view: 'wall',
  multi: false,
  sel: new Set(),
  more: false,
  ai: null,
  open: null,        /* 正在就地展开的那一条 */
  showBands: true,   /* 常态那一档：没有在跑的、也没有出错的 */
};

/* ── 小工具 ─────────────────────────────────────────────────────────────── */
/* 时刻按产品原来的写法：ui.js 的 fmtWhen —— 「2026-10-25 14:32」。样式也跟着产品走。 */
const when = ts => {
  const s = String(ts || '');
  return s.length >= 16 ? s.slice(0, 10) + ' ' + s.slice(11, 16) : '';
};
function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(0) + 'KB';
  return (b / 1048576).toFixed(1) + 'MB';
}
const dayKey = ts => String(ts || '').slice(0, 10);
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dayTag(key) {
  if (key === '2026-10-25') return { d: '今天', t: '2026-10-25', now: true };
  if (key === '2026-10-24') return { d: '昨天', t: '2026-10-24', now: false };
  if (key === '2026-10-23') return { d: '前天', t: '2026-10-23', now: false };
  const d = new Date(key + 'T12:00');
  return { d: key, t: WD[d.getDay()], now: false };
}
const daysAgo = key => Math.round((NOW - new Date(key + 'T12:00')) / 86400000);
function inTimeRange(ts) {
  if (state.time === 'all') return true;
  const k = dayKey(ts);
  if (state.time === '1') return k === '2026-10-25';
  return daysAgo(k) <= Number(state.time);
}
function matchQ(e) {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return (e.prompt || '').toLowerCase().includes(q)
    || (e.id + ' ' + (e.task || '') + ' ' + (e.prov || '')).toLowerCase().includes(q);
}
/* 墙里放「已经有结果」的一切：已完成的产物 + 失败与结果未知的任务。
   还在跑的（生成中 / 排队中）不进墙 —— 它们在在制台上。 */
const all = () => (state.more ? ENTRIES.concat(MORE) : ENTRIES);
const liveList = () => ENTRIES.filter(e => e.kind === 'task' && (e.status === 'running' || e.status === 'queued'));
const issueList = () => ENTRIES.filter(e => e.kind === 'task' && (e.status === 'failed' || e.status === 'uncertain'));
const wallAll = () => all().filter(e => e.kind === 'asset' || e.status === 'failed' || e.status === 'uncertain');

function visible() {
  const list = wallAll().filter(e =>
    (state.type === '全部' || e.type === state.type)
    && (state.prov === '全部' || e.prov === state.prov)
    && inTimeRange(e.ts) && matchQ(e));
  /* 按时刻倒着排 —— 墙是按天分槽的，槽内也要是时间顺序。 */
  return list.slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}
function counts() {
  const list = wallAll();
  const c = { 全部: list.length, 图片: 0, 视频: 0, 音频: 0 };
  list.forEach(e => { c[e.type] = (c[e.type] || 0) + 1; });
  const byProv = {};
  list.forEach(e => { byProv[e.prov] = (byProv[e.prov] || 0) + 1; });
  return { c, byProv };
}

/* ── 一行几格：按当前宽度算出来（详情要按行插进去，所以行是显式的） ──────── */
const GAP = 14, MIN_CELL = 268, GUT = 96, GUT_GAP = 18;
function columns() {
  const w = $('#asWall').clientWidth || 1200;
  const narrow = window.innerWidth <= 1180;
  const bodyW = narrow ? w : w - GUT - GUT_GAP;
  return Math.max(1, Math.floor((bodyW + GAP) / (MIN_CELL + GAP)));
}

/* ── 一格产物 ───────────────────────────────────────────────────────────── */
function waveBars(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xffff;
  const out = [];
  for (let i = 0; i < 34; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    out.push(0.25 + ((h >> 8) % 100) / 100 * 0.75);
  }
  return out;
}
function mediaHTML(e) {
  if (e.type === '音频') {
    const wave = waveBars(e.id).map(v => `<i style="height:${Math.round(v * 34)}px" class="${v > 0.72 ? 'hi' : ''}"></i>`).join('');
    return `<div class="as-audio">
      <div class="big">00:${String(e.dur).padStart(2, '0')}</div>
      <div class="as-wave">${wave}</div>
      <div class="fmt">${(e.fmt || '').toUpperCase()} · ${esc(e.dims || '')}</div>
    </div>`;
  }
  /* 画面上只留一个「这是视频」的标记 —— 时长跟真品一样在下面的来源行里。 */
  const play = e.type === '视频' ? '<span class="as-play">' + ICON.play + '</span>' : '';
  return `<img src="${e.img}" alt="" style="object-position:${e.pos || '50% 50%'}">${play}`;
}
function meta2Of(e) {
  return [e.prov, e.type, e.fmt ? String(e.fmt).toUpperCase() : '', e.dur ? e.dur + 's' : '']
    .filter(Boolean).join(' · ');
}
function cellHTML(e) {
  const src = e.local ? '<span class="srcbadge local">本机</span>' : '<span class="srcbadge cloud">云端</span>';
  const picked = state.sel.has(e.id);
  const bad = e.status === 'failed' ? ' bad' : e.status === 'uncertain' ? ' unc' : '';
  const st = ST[e.status] || ST.done;
  const node = el('article', 'task as-cell' + bad + (picked ? ' picked' : '') + (state.open === e.id ? ' open' : ''));
  node.dataset.id = e.id;
  node.innerHTML = `
    <div class="timg">
      ${mediaHTML(e)}
      <span class="as-quick">
        <button type="button" class="${e.fav ? 'on' : ''}" data-act="fav" title="收藏">${e.fav ? ICON.starFill : ICON.star}</button>
        <button type="button" data-act="dl" title="下载">${ICON.down}</button>
      </span>
      <span class="pick${picked ? ' on' : ''}" role="checkbox" aria-checked="${picked}" title="勾选后批量下载">${picked ? '✓' : ''}</span>
    </div>
    <div class="tmain">
      <div class="meta1">
        <span class="dot${st.dot ? ' ' + st.dot : ''}"></span>
        <span>${st.text}</span>
        ${src}
        <span class="date">${when(e.ts)}</span>
      </div>
      <div class="tprompt" title="${esc(e.prompt)}">${esc(e.prompt)}</div>
      <div class="meta2">${esc(meta2Of(e))}</div>
    </div>`;
  node.addEventListener('click', ev => onCellClick(ev, e));
  return node;
}

/* ── 详情：就地展开的一条（插在它那一行的下面，并且和那张卡连着） ─────────── */
function detailBand(e) {
  const src = e.local
    ? '<span class="srcbadge local">本机已有</span>'
    : '<span class="srcbadge cloud">只在平台那边</span>';
  const refs = e.refs
    ? Array.from({ length: e.refs }, (_, i) =>
        `<img src="assets/${['char-linwan.jpg', 'scene-gate.jpg', 'prop-recorder.jpg'][i % 3]}" alt="">`).join('')
    : '';
  const band = el('div', 'as-rowdet');
  band.dataset.id = e.id;
  band.dataset.anchorId = e.id;
  band.innerHTML = `
    <i class="as-tip"></i>
    <div class="dm">${e.type === '音频' ? mediaHTML(e) : `<img src="${e.img}" alt="" style="object-position:${e.pos || '50% 50%'}">`}</div>
    <div class="di">
      <div class="t">
        <span class="a">${esc(e.prompt)}</span>
        <span class="x">${src}</span>
      </div>
      <div class="m">${esc(e.prov)} · ${esc(e.model)} · ${esc(e.type)}${e.dur ? ' · ' + e.dur + 's' : ''} · ${esc(e.fmt || '').toUpperCase()}</div>
      <div class="kv">
        <span class="k">尺寸</span><span class="v">${esc(e.dims || '—')}</span>
        <span class="k">体积</span><span class="v">${e.size ? fmtSize(e.size) : '—'}</span>
        <span class="k">计费</span><span class="v">${e.credits || 0} 币</span>
        <span class="k">任务号</span><span class="v">${esc(e.task || '—')}</span>
        <span class="k">生成于</span><span class="v when">${when(e.ts)}</span>
        <span class="k">在哪</span><span class="v">${e.local ? '本机有一份' : '本机没有（外链可能过期）'}</span>
      </div>
      ${refs ? `<div class="refs">${refs}</div>` : ''}
      <div class="acts">
        <button class="pri" type="button">${ICON.down} 下载</button>
        <button class="ghost" type="button">拿去做生成</button>
        <button class="ghost" type="button">${ICON.box} 存回本机</button>
        <button class="ghost" type="button">${e.fav ? ICON.starFill : ICON.star} ${e.fav ? '已收藏' : '收藏'}</button>
        <button class="ghost" type="button" data-act="close" title="收起">${ICON.close} 收起</button>
      </div>
    </div>`;
  band.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act="close"]');
    if (b) { ev.stopPropagation(); state.open = null; render(); }
  });
  return band;
}

/* ── 在制台 ─────────────────────────────────────────────────────────────── */
function liveHTML(e) {
  const run = e.status === 'running';
  const node = el('div', 'as-lv');
  node.dataset.id = e.id;
  node.innerHTML = `
    <span class="as-lv-thumb">${e.img ? `<img src="${e.img}" alt="" style="object-position:${e.pos || '50% 50%'}">` : ''}${run ? '<i class="bar"></i>' : ''}</span>
    <span class="as-lv-name">
      <span class="a" title="${esc(e.prompt)}">${esc(e.prompt)}</span>
      <span class="b">${esc(e.prov)} · ${esc(e.type)}</span>
    </span>
    <span class="as-lv-state${run ? '' : ' q'}"><i class="dot"></i>${run ? '生成中' : '排队中'}</span>
    <span class="as-lv-time">${esc(e.elapsed)}</span>
    <button class="ghost" data-act="cancel" type="button">取消</button>`;
  node.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (b && b.dataset.act === 'cancel') { ev.stopPropagation(); return; }
    if (!b) { state.open = state.open === e.id ? null : e.id; render(); }
  });
  return node;
}

/* ── 问题台：一条异常说清三件事 ───────────────────────────────────────── */
function issueHTML(e) {
  const unc = e.status === 'uncertain';
  const node = el('div', 'as-iss' + (unc ? ' unc' : ''));
  node.dataset.id = e.id;
  node.innerHTML = `
    <div class="r1">
      <span class="ui-tag ${unc ? 'warn' : 'err'}">${unc ? '结果未知' : '失败'}</span>
      <span class="p" title="${esc(e.prompt)}">${esc(e.prompt)}</span>
      <span class="when">提交于 ${when(e.ts)}</span>
    </div>
    <div class="r2">
      <span class="why">${esc(e.failMsg || '')}</span>
      <span class="who">${esc(e.prov)} · ${esc(e.task)}</span>
    </div>
    <div class="r3">
      <span class="cost">${ICON.warn} ${unc ? '可能已经受理并计费' : '已经扣了 ' + (e.credits || 0) + ' 币'}</span>
      <span class="acts">
        <button class="ghost" type="button" data-act="open">${ICON.ext} 去平台看这条</button>
        <button class="ghost ${unc ? 'warn' : ''}" type="button" data-act="retry">重试${unc ? '（可能重复扣费）' : '（会再扣 ' + (e.credits || 0) + ' 币）'}</button>
        <button class="ghost" type="button" data-act="cancel">取消这条</button>
      </span>
    </div>`;
  node.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) { state.open = state.open === e.id ? null : e.id; render(); return; }
    if (b.dataset.act === 'open') { ev.stopPropagation(); state.open = state.open === e.id ? null : e.id; render(); }
  });
  return node;
}

/* ── 各段渲染 ───────────────────────────────────────────────────────────── */
function renderLive() {
  const box = $('#asLive');
  const list = state.showBands === false ? [] : liveList();
  box.innerHTML = '';
  box.style.display = list.length ? '' : 'none';
  if (!list.length) return;
  const head = el('div', 'as-live-head');
  head.innerHTML = `
    <span class="as-live-title"><i class="live-dot"></i>在制<span class="n">${list.length}</span></span>
    <span class="as-live-hint">跑完会自动落到下面的片墙里</span>
    <span class="as-live-acts">
      <button class="ghost" type="button" id="asCancelAll">取消全部进行中</button>
    </span>`;
  box.appendChild(head);
  const row = el('div', 'as-live-row');
  list.forEach(e => row.appendChild(liveHTML(e)));
  box.appendChild(row);
  if (state.open && list.some(e => e.id === state.open)) {
    box.appendChild(detailBand(list.find(e => e.id === state.open)));
  }
}

function renderIssue() {
  const box = $('#asIssue');
  const list = state.showBands === false ? [] : issueList();
  box.innerHTML = '';
  box.style.display = list.length ? '' : 'none';
  if (!list.length) return;
  const unc = list.filter(e => e.status === 'uncertain').length;
  const head = el('div', 'as-issue-head');
  head.innerHTML = `
    <span class="as-issue-title">需要你处理<span class="n">${list.length}</span></span>
    <span class="as-issue-note">${unc ? '其中 ' + unc + ' 条结果未知 —— 平台可能已经受理并计费，重发可能重复扣费，先去平台那边看一眼。' : '重试会再扣一次费，确认平台那边没有这条再重试。'}</span>`;
  box.appendChild(head);
  const row = el('div', 'as-issue-row');
  list.forEach(e => row.appendChild(issueHTML(e)));
  box.appendChild(row);
  if (state.open && list.some(e => e.id === state.open)) {
    box.appendChild(detailBand(list.find(e => e.id === state.open)));
  }
}

function renderTypeSeg() {
  const { c } = counts();
  const box = $('#asType');
  box.innerHTML = '';
  ['全部', '图片', '视频', '音频'].forEach(t => {
    const b = el('button', state.type === t ? 'on' : '',
      t + '<span class="seg-n">' + (c[t] || 0) + '</span>');
    b.type = 'button';
    b.addEventListener('click', () => { state.type = t; render(); });
    box.appendChild(b);
  });
}

function renderProv() {
  const { byProv } = counts();
  const sel = $('#asProv');
  const cur = sel.value || '全部';
  sel.innerHTML = '';
  const opt = (v, label) => { const o = el('option', null, label); o.value = v; return o; };
  sel.appendChild(opt('全部', '全部平台（' + wallAll().length + '）'));
  Object.keys(byProv).sort((a, b) => byProv[b] - byProv[a]).forEach(p => {
    sel.appendChild(opt(p, p + '（' + byProv[p] + '）'));
  });
  sel.value = Object.prototype.hasOwnProperty.call(byProv, cur) ? cur : '全部';
}

function renderWall() {
  const wall = $('#asWall');
  wall.innerHTML = '';
  const list = visible();
  if (!list.length) {
    const why = filterWhy();
    wall.appendChild(el('div', 'as-empty', `
      <div>按现在这些条件，一条都没有。</div>
      <div class="why">${why.length ? '现在生效的是：' + why.join(' · ') : '库里还没有已入库的产物。'}</div>
      <button class="ghost" type="button" id="asClear">清掉这些条件</button>`));
    const c = $('#asClear');
    if (c) c.onclick = () => {
      state.type = '全部'; state.prov = '全部'; state.time = 'all'; state.q = ''; state.ai = null;
      $('#asQ').value = ''; $('#asTime').value = 'all'; $('#asAiChip').hidden = true;
      render();
    };
    return;
  }
  const cols = columns();
  wall.style.setProperty('--as-cols', cols);
  const slots = new Map();
  list.forEach(e => {
    const k = dayKey(e.ts);
    if (!slots.has(k)) slots.set(k, []);
    slots.get(k).push(e);
  });
  slots.forEach((items, key) => {
    const tag = dayTag(key);
    const slot = el('section', 'as-slot');
    slot.appendChild(el('div', 'as-gut', `
      <div class="d${tag.now ? ' now' : ''}">${tag.d}</div>
      <div class="t">${tag.t}</div>
      <div class="n">${items.length} 条</div>`));
    const body = el('div', 'as-slot-body');
    /* 一行一行地铺：详情展开时正好插在它那一行的下面，不动别的格子的位置。 */
    for (let i = 0; i < items.length; i += cols) {
      const chunk = items.slice(i, i + cols);
      const row = el('div', 'as-wrow');
      chunk.forEach(e => row.appendChild(cellHTML(e)));
      body.appendChild(row);
      const open = chunk.find(e => e.id === state.open);
      if (open) body.appendChild(detailBand(open));
    }
    slot.appendChild(body);
    wall.appendChild(slot);
  });
}

function renderList() {
  const wall = $('#asWall');
  wall.innerHTML = '';
  const list = visible();
  if (!list.length) {
    wall.appendChild(el('div', 'as-empty', '按现在这些条件，一条都没有。'));
    return;
  }
  const head = el('div', 'as-list-head',
    '<span class="tm">时刻</span><span>缩略图</span><span>提示词 / 来源</span><span></span>');
  const box = el('div', 'as-list');
  let lastDay = '';
  list.forEach(e => {
    const k = dayKey(e.ts);
    if (k !== lastDay) {
      lastDay = k;
      const tag = dayTag(k);
      box.appendChild(el('div', 'as-row-day',
        `<span class="d${tag.now ? ' now' : ''}">${tag.d}</span><span class="t">${tag.t}</span>`));
    }
    const src = e.local ? '<span class="srcbadge local">本机</span>' : '<span class="srcbadge cloud">云端</span>';
    const st = ST[e.status] || ST.done;
    const thumb = e.type === '音频'
      ? `<span class="mini">${waveBars(e.id).slice(0, 14).map(v => `<i style="height:${Math.max(2, Math.round(v * 22))}px"></i>`).join('')}</span>`
      : `<img src="${e.img}" alt="" style="object-position:${e.pos || '50% 50%'}">`;
    const row = el('div', 'as-row' + (state.open === e.id ? ' open' : ''));
    row.dataset.id = e.id;
    row.innerHTML = `
      <span class="tm">${when(e.ts)}</span>
      <span class="th">${thumb}</span>
      <span class="tx">
        <span class="p">${esc(e.prompt)}</span>
        <span class="m"><span class="dot${st.dot ? ' ' + st.dot : ''}" style="display:inline-block;margin-right:var(--sp-4)"></span>${st.text} · ${esc(meta2Of(e))}</span>
      </span>
      <span class="ra">${src}<button class="ghost" data-act="dl" type="button">下载</button></span>`;
    row.addEventListener('click', ev => onCellClick(ev, e));
    box.appendChild(row);
    if (state.open === e.id) box.appendChild(detailBand(e));
  });
  wall.appendChild(head);
  wall.appendChild(box);
}

function filterWhy() {
  const bits = [];
  if (state.q) bits.push('搜索「' + state.q + '」');
  if (state.type !== '全部') bits.push('类型「' + state.type + '」');
  if (state.prov !== '全部') bits.push('平台「' + state.prov + '」');
  if (state.time !== 'all') bits.push('时间「近 ' + state.time + ' 天」');
  if (state.ai) bits.push('AI 条件「' + state.ai.text + '」');
  return bits;
}

function renderFoot() {
  const foot = $('#asFoot');
  const list = visible();
  const total = wallAll().length;
  foot.innerHTML = '';
  foot.style.display = list.length ? '' : 'none';
  if (!list.length) return;
  foot.appendChild(el('span', null, `已列出 <b>${list.length}</b> 条 · 墙上共 ${total} 条`));
  if (!state.more) {
    const b = el('button', 'ghost', '加载更早的 ' + MORE.length + ' 条');
    b.type = 'button';
    b.onclick = () => { state.more = true; render(); };
    foot.appendChild(b);
  } else {
    foot.appendChild(el('span', null, '（已经到底了）'));
  }
}

function renderCount() {
  const list = visible();
  const local = list.filter(e => e.local).length;
  const cloud = list.length - local;
  const { byProv } = counts();
  $('#asCount').innerHTML = `共 <b>${list.length}</b> 条 · 本机 <b>${local}</b> · 云端 <b>${cloud}</b>`;
  $('#asSub').textContent = `交片台 · ${wallAll().length} 条在墙上 · ${Object.keys(byProv).length} 家平台`;
}

function render() {
  /* 退出多选要把勾选清掉 —— 否则卡片上还留着「已选」的那道环（真品的 exitMulti 同样清）。 */
  if (!state.multi && state.sel.size) state.sel.clear();
  document.querySelector('.as-page').classList.toggle('multi', state.multi);
  renderLive();
  renderIssue();
  renderTypeSeg();
  renderProv();
  if (state.view === 'wall') renderWall(); else renderList();
  renderFoot();
  renderCount();
  renderBulk();
  requestAnimationFrame(anchorDetail);
}

/* ── 详情条与上面那张卡的连线 ───────────────────────────────────────────── */
function anchorDetail() {
  const band = document.querySelector('.as-rowdet');
  if (!band) return;
  const id = band.dataset.anchorId;
  const cell = document.querySelector('.as-cell[data-id="' + id + '"]');
  const row = document.querySelector('.as-row[data-id="' + id + '"]');
  const iss = document.querySelector('.as-iss[data-id="' + id + '"]');
  const lv = document.querySelector('.as-lv[data-id="' + id + '"]');
  const box = cell || row || iss || lv;
  if (!box) return;
  const b = band.getBoundingClientRect();
  const r = box.getBoundingClientRect();
  /* 清单档里那一条是横排，连线落在缩略图那一列；其余就是那一块自己的左边缘。 */
  const anchorEl = (row && row.querySelector('.th')) || box;
  const a = anchorEl.getBoundingClientRect();
  const x = Math.max(8, Math.round(a.left - b.left));
  const gap = Math.max(4, Math.round(b.top - r.bottom));
  band.style.setProperty('--as-anchor', x + 'px');
  band.style.setProperty('--as-tether', gap + 'px');
}

/* ── 多选条（公共 .bulkbar 的内容） ─────────────────────────────────────── */
function renderBulk() {
  const bar = $('#asBulk');
  bar.hidden = !state.multi;
  if (!state.multi) return;
  const n = state.sel.size;
  $('#asBulkCnt').textContent = '已选 ' + n + ' 项';
  $('#asBulkDown').disabled = n === 0;
  $('#asPull').disabled = n === 0;
}

/* ── 点一格：就地展开 / 多选 ───────────────────────────────────────────── */
function onCellClick(ev, e) {
  const b = ev.target.closest('[data-act]');
  if (b) {
    ev.stopPropagation();
    if (b.dataset.act === 'fav') { e.fav = !e.fav; render(); return; }
    if (b.dataset.act === 'dl') return;
  }
  if (state.multi) {
    if (state.sel.has(e.id)) state.sel.delete(e.id); else state.sel.add(e.id);
    render();
    return;
  }
  state.open = state.open === e.id ? null : e.id;
  render();
}

/* ── 接线 ───────────────────────────────────────────────────────────────── */
$('#asQ').addEventListener('input', ev => { state.q = ev.target.value.trim(); render(); });
$('#asProv').addEventListener('change', ev => { state.prov = ev.target.value; render(); });
$('#asTime').addEventListener('change', ev => { state.time = ev.target.value; render(); });
$('#asView').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-view]');
  if (!b) return;
  state.view = b.dataset.view;
  [...$('#asView').children].forEach(x => x.classList.toggle('active', x === b));
  render();
});
$('#asMulti').addEventListener('click', () => {
  state.multi = !state.multi;
  if (!state.multi) state.sel.clear();
  $('#asMulti').classList.toggle('active', state.multi);
  render();
});
$('#asMultiExit').addEventListener('click', () => {
  state.multi = false; state.sel.clear();
  $('#asMulti').classList.remove('active');
  render();
});
$('#asBulkClear').addEventListener('click', () => { state.sel.clear(); render(); });
$('#asBulkAll').addEventListener('click', () => { visible().forEach(e => state.sel.add(e.id)); render(); });
$('#asAi').addEventListener('click', () => {
  state.ai = state.ai ? null : { text: '夜晚 · 室外 · 人物' };
  const chip = $('#asAiChip');
  chip.hidden = !state.ai;
  chip.innerHTML = state.ai ? 'AI：夜晚 · 室外 · 人物<button type="button" id="asAiClear" title="去掉">×</button>' : '';
  const c = $('#asAiClear');
  if (c) c.onclick = () => { state.ai = null; chip.hidden = true; render(); };
});
$('#asReload').addEventListener('click', () => {
  const b = $('#asReload');
  b.textContent = '刷新中…';
  setTimeout(() => { b.textContent = '刷新'; }, 700);
});
$('#sbTheme').addEventListener('click', () => {
  const h = document.documentElement;
  h.setAttribute('data-theme', h.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});
document.querySelector('.sb-brand').addEventListener('click', () => {
  document.documentElement.classList.toggle('sb-open');
});
/* 宽度变了，行里几格要重算 —— 详情是按行插进去的，行数跟着变。 */
let rzTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(render, 150);
});

render();

/* 出图脚本要能摆出各种状态（设计稿专用）。 */
window.__demo = {
  state,
  set(patch) {
    Object.assign(state, patch);
    if ('q' in patch) $('#asQ').value = patch.q || '';
    if ('time' in patch) $('#asTime').value = patch.time;
    render();
  },
  select(id) { state.sel.add(id); render(); },
  open(id) { state.open = id; render(); },
  close() { state.open = null; render(); },
};
