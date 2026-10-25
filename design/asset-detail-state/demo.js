/* 资产库 ·「卡片同形 + 详情就地展开」设计稿的交互层（v2）。
   稿子不连真数据：数据在 data.js 里（编的），交互只演示两件事怎么工作：
     ① 各种状态都是一张卡（同宽同形），状态只换内容
     ② 点「详情」→ **那张卡就地打开**（不另起一层），下面几行顺移 */
import { ITEMS, STATE_META, BUCKETS } from './data.js';

/* 稿子里「今天」是固定的一天：出图要可复现，不能跟着机器的日期跑。 */
const NOW = new Date('2026-10-25T15:23:00');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const $ = s => document.querySelector(s);
const state = {
  q: '', type: '全部', provider: '全部', time: 'all', bucket: '',
  view: 'list', theme: 'light', hideAnomalies: false,
};

/* ─────────────────────────── 工具 ─────────────────────────── */

const isAnomaly = it => it.state === 'failed' || it.state === 'uncertain';
const isLive = it => it.state === 'running' || it.state === 'queued';

function bucketOf(it) {
  if (it.state === 'running' || it.state === 'queued') return 'live';
  if (it.state === 'failed') return 'failed';
  if (it.state === 'uncertain') return 'uncertain';
  return '';
}

function daysAgo(ts) {
  const d = new Date(String(ts).replace(' ', 'T'));
  if (isNaN(d.getTime())) return 999;
  return Math.floor((NOW - d) / 86400000);
}

function badgeHTML(it) {
  if (it.local === true) return '<span class="srcbadge local">本机</span>';
  if (it.local === false) return '<span class="srcbadge cloud">云端</span>';
  return '';
}

/* 计数与筛选的口径（这一页自己的一条规矩）：
   页头三档 = **当前其它筛选条件下的**那一档有多少条（点一下就得到这个数，不会对不上）；
   计数为 0 的那一档不占地方（库里没有失败的时候，页头就不该挂着一颗「失败 0」）。 */
function passScope(it, skipType) {
  if (!skipType && state.type !== '全部' && it.type !== state.type) return false;
  if (state.provider !== '全部' && it.provider !== state.provider) return false;
  if (state.time === '1' && daysAgo(it.ts) > 0) return false;
  if (state.time === '7' && daysAgo(it.ts) > 6) return false;
  const q = state.q.trim().toLowerCase();
  if (q) {
    const hay = (it.prompt + ' ' + it.taskId + ' ' + (it.assetId || '') + ' ' + it.provider).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function scope(skipType) {
  return ITEMS.filter(it => !(state.hideAnomalies && isAnomaly(it)) && passScope(it, skipType));
}

function filtered() {
  return scope().filter(it => !state.bucket || bucketOf(it) === state.bucket);
}

/* ─────────────────────────── 卡片 ───────────────────────────
   **五种状态共用同一副骨骸**：左边一格 132×96 的槽，右边一列字。
   状态只换槽里的内容与字里的几行 —— 宽度、结构、左边缘全都一样。 */

function slotHTML(it) {
  /* 没有画面时，槽里是一块「状态牌」：与音频块同一副骨架，只换底色与字 */
  if (it.state === 'running') {
    return '<div class="timg"><span class="plate plate--live">'
      + '<span class="plate-st">生成中</span>'
      + '<span class="plate-t">已跑 ' + esc(it.elapsed) + '</span>'
      + '<span class="plate-bar"><i style="width:' + (it.progress || 0) + '%"></i></span>'
      + '</span></div>';
  }
  if (it.state === 'queued') {
    return '<div class="timg"><span class="plate plate--plain">'
      + '<span class="plate-st">排队中</span>'
      + '<span class="plate-t">第 ' + (it.queue || 1) + ' 位</span>'
      + '</span></div>';
  }
  if (it.state === 'failed') {
    return '<div class="timg"><span class="plate plate--fail">'
      + '<span class="plate-st">生成失败</span>'
      + '<span class="plate-t">' + esc(it.short || '') + '</span>'
      + '</span></div>';
  }
  if (it.state === 'uncertain') {
    return '<div class="timg"><span class="plate plate--unc">'
      + '<span class="plate-st">结果未知</span>'
      + '<span class="plate-t">可能已扣费</span>'
      + '</span></div>';
  }
  if (it.type === '音频') {
    return '<div class="timg"><span class="plate plate--audio">'
      + '<span class="plate-st">MP3</span>'
      + '<span class="plate-t">' + (it.dur || 0) + 's</span>'
      + '</span></div>';
  }
  return '<div class="timg"><img src="' + esc(it.thumb) + '" alt="" loading="lazy" decoding="async"'
    + ' style="object-position:' + esc(it.pos || 'center') + '"></div>';
}

function dotClass(it) {
  if (it.state === 'done') return 'dot';
  if (it.state === 'running') return 'dot run';
  if (it.state === 'queued') return 'dot as2-dot idle';
  return 'dot as2-dot unc';
}

/* 代价 + 「再点一下要花多少」写在按钮上 */
function costText(it) {
  if (!it.charged) {
    return it.needsChange
      ? '这次<span class="warn">没有扣积分</span> · 改完提示词再重试不花钱'
      : '这次<span class="warn">没有扣积分</span> · 重试不会重复扣费';
  }
  return '已扣 <b>' + it.charged + '</b> 积分 · '
    + (it.state === 'uncertain' ? '重发可能再扣' : '重试会再扣') + ' <b>' + it.retryCredits + '</b> 积分';
}

function retryLabel(it) {
  if (it.state === 'uncertain') return '重发（可能重复扣费）';
  return it.retryCredits ? '重试（会再扣 ' + it.retryCredits + ' 积分）' : '重试（不花钱）';
}

/* 卡面上那一排：成功卡留两颗，异常卡留三个能立刻用的（代价写在按钮上） */
function actsHTML(it) {
  const b = [];
  if (it.state === 'done') b.push('<button class="ghost" data-act="dl">下载</button>');
  if (it.state === 'running' || it.state === 'queued') b.push('<button class="ghost danger" data-act="cancel">取消</button>');
  if (isAnomaly(it)) {
    b.push('<button class="ghost" data-act="platform">去平台看</button>');
    b.push('<button class="ghost as2-retry" data-act="retry">' + esc(retryLabel(it)) + '</button>');
  }
  b.push('<button class="ghost as2-open" data-act="open" data-kit-toggle>详情</button>');
  return b.join('');
}

function cardHTML(it) {
  const meta = STATE_META[it.state];
  const why = isAnomaly(it)
    ? '<div class="why"><span class="why-k">平台原话</span>'
      + '<span class="why-t ' + (it.state === 'uncertain' ? 'warn' : 'err') + '" title="' + esc(it.err) + '">'
      + esc(it.err) + '</span></div>'
    : '';
  const meta2 = [it.provider, it.type, it.format, it.dur ? it.dur + 's' : '']
    .concat(isAnomaly(it) && it.charged ? ['已扣 ' + it.charged + ' 积分'] : [])
    .filter(Boolean).join(' · ');
  return '<article class="task as2-card" data-id="' + esc(it.id) + '">'
    + slotHTML(it)
    + '<div class="tmain">'
    + '<div class="meta1"><span class="' + dotClass(it) + '"></span><span>' + meta.label + '</span>'
    + badgeHTML(it) + '<span class="date">' + esc(it.ts) + '</span></div>'
    + '<div class="tprompt" title="' + esc(it.prompt) + '">' + esc(it.prompt) + '</div>'
    + why
    + '<div class="meta2">' + esc(meta2) + '</div>'
    + '<div class="acts">' + actsHTML(it) + '</div>'
    + '<div class="exp"><div class="exp-in"><div class="exp-body">'
    + expBodyHTML(it)
    + '</div></div></div>'
    + '</div></article>';
}

/* ─────────────────────────── 展开的详情（原界面里就地打开） ─────────────────── */

function ledgerHTML(it) {
  const meta = STATE_META[it.state];
  const rows = [
    ['状态', meta.label, false],
    ['型号', it.model, true],
    ['平台', it.provider, false],
    ['类型', it.type, false],
    ['格式', it.format, false],
    ['比例', it.ar, false],
    ['分辨率', it.res, false],
    ['画质', it.quality, false],
    ['时长', it.dur ? it.dur + ' 秒' : '', false],
    ['体积', it.size, true],
    ['费用', it.cost, true],
    ['积分', it.credits ? it.credits + ' 已扣 / 0 冻结' : '0', true],
    ['创建', it.created, true],
    ['耗时', it.elapsed, false],
    ['任务号', it.taskId, true],
    ['资产号', it.assetId, true],
  ].filter(r => r[1] && r[1] !== '—');   /* 这一条没有的字段不占一行 */
  return rows.map(r => '<div class="led-i"><span class="k">' + esc(r[0]) + '</span>'
    + '<span class="v' + (r[2] ? ' mono' : '') + '">' + esc(r[1]) + '</span></div>').join('');
}

function diagBlockHTML(it) {
  if (!isAnomaly(it)) return '';
  /* 这一块只说「出了什么事、代价多少」—— 动作不在这里：
     卡面那一排（去平台看 / 重试 / 取消）一直都在，不该在同一张卡里出现两遍。 */
  return '<div class="diag' + (it.state === 'uncertain' ? ' diag--warn' : '') + '">'
    + '<div class="why"><span class="why-k">平台原话</span>'
    + '<span class="why-t ' + (it.state === 'uncertain' ? 'warn' : 'err') + '">' + esc(it.err) + '</span></div>'
    + '<div class="diag-cost">' + costText(it) + '</div>'
    + '</div>';
}

/* 展开后**多出来的**动作：卡面那一排（下载 / 详情 或 去平台看 / 重试 / 取消）一直都在，
   这一行只放还没出现过的那些（收藏 / 复用 / 删除本机这一份）。 */
function expActsHTML(it) {
  if (it.state !== 'done') return '';
  return '<button class="ghost" data-act="fav">收藏</button>'
    + '<button class="ghost" data-act="reuse">复用</button>'
    + '<span class="sp"></span>'
    + (it.local ? '<button class="ghost as2-danger" data-act="del" title="只删本机这一份，平台那边的素材不动">删除本机这一份</button>' : '');
}

function expBodyHTML(it) {
  const acts = expActsHTML(it);
  return diagBlockHTML(it)
    + '<div class="sec-hd">这一条的账</div>'
    + '<div class="led">' + ledgerHTML(it) + '</div>'
    + '<div class="det-prompt-hd">完整提示词<button class="ghost mini" data-act="copy">复制</button></div>'
    + '<div class="det-prompt">' + esc(it.prompt) + '</div>'
    + (it.refs && it.refs.length
      ? '<div class="det-k">参考图 / 输入图（' + it.refs.length + '）</div><div class="det-refs">'
        + it.refs.map(r => '<img src="' + esc(r) + '" alt="">').join('') + '</div>'
      : '')
    + (acts ? '<div class="exp-acts">' + acts + '</div>' : '');
}

/* ─────────────────────────── 列表 ─────────────────────────── */

function renderList() {
  const list = filtered();
  renderSum();
  const box = $('#as2List');
  $('#as2Pgi').textContent = '共 ' + ITEMS.length + ' 条 · 本页 ' + list.length + ' 条';
  $('#as2Count').textContent = '当前 ' + list.length + ' 条';
  const localN = ITEMS.filter(x => x.local === true).length;
  const provN = new Set(ITEMS.map(x => x.provider)).size;
  $('#as2Sub').textContent = ITEMS.length + ' 条 · ' + provN + ' 家平台 · 本机 ' + localN + ' 条';

  if (state.view === 'tiles') { renderTiles(box, list); return; }

  box.classList.remove('is-tiles');
  if (!list.length) {
    box.innerHTML = '<div class="empty">按现在这些条件一条都没有。<br>清掉条件再看全部 14 条。</div>';
  } else {
    box.innerHTML = list.map(cardHTML).join('');
  }
}

/* ─────────────────────────── 方块档：行 + 行下的带子 ───────────────────────────
   格子长高会把**同一行**别的格子底下留出空洞 —— 网格最怕这种。
   所以这一档的做法是：**那一行保持原样**，展开的内容在它下面接一条**整行宽的带子**，
   一根连线从带子的上沿指回那个格子。

   落地的代价是明摆着的：**一行几格必须先分好组**，展开才能插在它那一行的下面。
   稿子里是 JS 按容器宽度算出一行几格（`colsNow`）再显式分行，
   真品那边也得这么写 —— 自动分列（auto-fill）与「插在行下面」不能同时成立。 */

function colsNow() {
  const box = $('#as2List');
  const w = box.clientWidth || 1;
  const min = 200;      /* --sz-card-sm */
  const gap = 10;       /* --sp-10 */
  return Math.max(1, Math.floor((w + gap) / (min + gap)));
}

function tileHTML(it) {
  const meta = STATE_META[it.state];
  const why = isAnomaly(it)
    ? '<div class="why"><span class="why-k">平台原话</span>'
      + '<span class="why-t ' + (it.state === 'uncertain' ? 'warn' : 'err') + '" title="' + esc(it.err) + '">'
      + esc(it.err) + '</span></div>'
    : '';
  return '<article class="task as2-card' + (state.openId === it.id ? ' is-open' : '') + '" data-id="' + esc(it.id) + '">'
    + slotHTML(it)
    + '<div class="tmain">'
    + '<div class="meta1"><span class="' + dotClass(it) + '"></span><span>' + meta.label + '</span>'
    + badgeHTML(it) + '</div>'
    + '<div class="tprompt" title="' + esc(it.prompt) + '">' + esc(it.prompt) + '</div>'
    + why
    + '</div></article>';
}

function bandHTML(it) {
  const meta = STATE_META[it.state];
  /* 带子的头只说「这是哪一条」（状态 + 平台 + 任务号）：
     提示词在下面的「完整提示词」里，标题里再写一遍是重复。 */
  return '<div class="band-in">'
    + '<div class="band-hd">'
    + '<span class="t">' + meta.label + ' · ' + esc(it.provider) + ' · ' + esc(it.taskId || '') + '</span>'
    + '<span class="sp"></span>'
    + '<button class="ghost as2-open" data-act="close">收起</button>'
    + '</div>'
    + expBodyHTML(it)
    + '</div>';
}

function renderTiles(box, list) {
  box.classList.add('is-tiles');
  if (!list.length) {
    box.innerHTML = '<div class="empty">按现在这些条件一条都没有。<br>清掉条件再看全部 14 条。</div>';
    return;
  }
  const cols = colsNow();
  box.style.setProperty('--as2-cols', String(cols));
  const rows = [];
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols));
  box.innerHTML = rows.map(row => {
    const open = row.find(it => it.id === state.openId);
    return '<div class="as2-row">' + row.map(tileHTML).join('') + '</div>'
      + (open ? '<div class="band" data-for="' + esc(open.id) + '">'
        + '<span class="band-tether"></span>' + bandHTML(open) + '</div>' : '');
  }).join('');
  measureBand();
}

/* 连线落在哪儿是**量出来的**，不是猜的：公共件 `Kit.anchor` 量那个格子与带子的矩形，
   把横坐标写进带子上的 CSS 变量。换成第 2 列、第 3 列，线也跟着挪。 */
function measureBand() {
  const band = document.querySelector('.band');
  if (!band) return;
  const tile = document.querySelector('.as2-card[data-id="' + band.dataset.for + '"]');
  if (!tile) return;
  window.Kit.anchor(band, tile);
}

/* 展开 / 收起：就地打开那张卡，不动别的卡。
   清单档 = 卡自己变高；方块档 = 行下面接一条带子。
   **接线走公共件**（Kit.expand）：一次只开一条、按钮的字跟着变，都在那一件里。 */
function toggleCard(id, force) {
  const it = ITEMS.find(x => x.id === id);
  if (!it) return;
  const want = force === undefined ? state.openId !== id : force;

  if (state.view === 'tiles') {
    state.openId = want ? id : '';
    renderList();
    if (state.openId) {
      const el = document.querySelector('.as2-card[data-id="' + id + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
    return;
  }

  const card = document.querySelector('.as2-card[data-id="' + id + '"]');
  if (!card) return;
  window.Kit.expand(card, { force: want });
  state.openId = want ? id : '';
}

function closeAll() {
  state.openId = '';
  window.Kit.closeAll(document);
  if (state.view === 'tiles') renderList();
}

/* ─────────────────────────── 页头与筛选 ─────────────────────────── */

function renderSum() {
  const box = $('#as2Sum');
  const pool = scope();
  box.innerHTML = BUCKETS.map(b => {
    const n = pool.filter(it => b.states.includes(it.state)).length;
    const dot = b.key === 'live' ? 'live' : b.key === 'failed' ? 'fail' : 'unc';
    /* 计数为 0 的那一档不画：库里没有失败的时候，页头不该挂着一颗「失败 0」 */
    if (!n) return '';
    return '<button class="as2-sum-i' + (state.bucket === b.key ? ' on' : '') + '" data-bucket="' + b.key + '"'
      + ' title="' + esc(b.hint) + '"><span class="as2-dot ' + dot + '"></span>'
      + '<span class="cap">' + esc(b.label) + '</span><b>' + n + '</b></button>';
  }).join('');
}

function renderTypeSeg() {
  const types = ['全部', '图片', '视频', '音频'];
  const pool = scope(true);   /* 类型自己的计数不受「类型」这一档筛选影响 */
  $('#as2Type').innerHTML = types.map(t => {
    const n = t === '全部' ? pool.length : pool.filter(x => x.type === t).length;
    return '<button type="button" class="' + (state.type === t ? 'on' : '') + '" data-type="' + t + '">'
      + t + '<span class="seg-n">' + n + '</span></button>';
  }).join('');
}

function renderProv() {
  const provs = ['全部', ...new Set(ITEMS.map(x => x.provider))];
  if (!$('#as2Prov').options.length) {
    $('#as2Prov').innerHTML = provs.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
  }
  $('#as2Prov').value = state.provider;
}

/* ─────────────────────────── 接线 ─────────────────────────── */

function bind() {
  $('#as2Sum').addEventListener('click', e => {
    const b = e.target.closest('[data-bucket]');
    if (!b) return;
    state.bucket = state.bucket === b.dataset.bucket ? '' : b.dataset.bucket;
    renderSum(); renderList();
  });
  $('#as2Type').addEventListener('click', e => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    state.type = b.dataset.type;
    renderTypeSeg(); renderList();
  });
  $('#as2Prov').addEventListener('change', e => { state.provider = e.target.value; renderList(); });
  $('#as2Time').addEventListener('change', e => { state.time = e.target.value; renderList(); });
  $('#as2Q').addEventListener('input', e => { state.q = e.target.value; renderList(); });
  $('#as2Ai').addEventListener('click', () => {
    $('#as2Q').value = '';
    state.q = '';
    renderList();
  });
  $('#as2View').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    document.querySelectorAll('#as2View button').forEach(x => x.classList.toggle('active', x.dataset.view === state.view));
    closeAll();
    renderList();
    /* 换档时把滚动位置归零：列表是**自己滚**的那一栏，
       上一档滚到哪，换档后不该接着从那儿看（否则第一行是半截的）。 */
    $('#as2List').scrollTop = 0;
  });
  /* 一行几格是按宽度算出来的：窗口一变，行就重新分（展开的带子跟着换行） */
  let rsTimer = null;
  window.addEventListener('resize', () => {
    if (state.view !== 'tiles') return;
    clearTimeout(rsTimer);
    rsTimer = setTimeout(renderList, 120);
  });
  $('#as2Multi').addEventListener('click', () => { /* 稿子不演示多选 */ });
  $('#as2Reload').addEventListener('click', () => renderList());

  /* 列表：点「详情」→ 那张卡就地打开；点卡身也是打开 */
  $('#as2List').addEventListener('click', e => {
    /* 方块档：展开的是行下面那条带子，带子里的「收起」也要接上 */
    const band = e.target.closest('.as2-band');
    if (band) {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'close') {
        const it = ITEMS.find(x => x.id === band.dataset.for);
        if (it) toggleCard(it.id, false);
      }
      return;
    }
    const card = e.target.closest('.as2-card');
    if (!card) return;
    const it = ITEMS.find(x => x.id === card.dataset.id);
    if (!it) return;
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'open') { toggleCard(it.id, true); return; }
      if (a === 'close') { toggleCard(it.id, false); return; }
      if (a === 'dl') return;                  /* 稿子不演示下载 */
      return;                                  /* 其余动作：稿子不落真数据 */
    }
    toggleCard(it.id);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAll();
  });

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
  open: id => toggleCard(id, true),
  close: () => closeAll(),
  set: o => {
    if (o.view) { state.view = o.view; document.querySelectorAll('#as2View button').forEach(x => x.classList.toggle('active', x.dataset.view === o.view)); }
    if (o.theme) { state.theme = o.theme; document.documentElement.setAttribute('data-theme', o.theme); }
    if (o.bucket !== undefined) state.bucket = o.bucket;
    if (o.type) state.type = o.type;
    if (o.q !== undefined) { state.q = o.q; $('#as2Q').value = o.q; }
    if (o.hideAnomalies !== undefined) state.hideAnomalies = !!o.hideAnomalies;
    closeAll();
    renderSum(); renderTypeSeg(); renderList();
    $('#as2List').scrollTop = 0;      /* 换档/重画后回到顶部 */
    if (o.open) window.__demo.open(o.open);
  },
};

bind();
renderSum();
renderTypeSeg();
renderProv();
renderList();
