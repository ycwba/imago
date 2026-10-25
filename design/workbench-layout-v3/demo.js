/* ============================================================================
   生成工作台 · 打磨稿（保留左右两栏）—— 稿子的行为（假数据，不碰真产品）。
   演示的动作：切类型、改提示词（字数跟着走）、换输入模式、
   折/开高级设置、点卡片看「最新一条」、多选、提交（状态条原地出回执）、切深浅档。
   ========================================================================== */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let type = 'video';
  let filter = 'all';
  let multi = false;
  const picked = new Set();
  let cards = BENCH.wall.slice();

  const THUMBS = ['th-1', 'th-2', 'th-3', 'th-4', 'th-5', 'th-6'];
  const WAVE = [10, 22, 34, 18, 28, 40, 14, 30, 20, 12, 26, 36, 16, 24, 10, 20];

  function thumbInner(c) {
    if (c.type === 'audio') {
      return '<div class="wave">' + WAVE.map(h => '<i style="height:' + h + 'px"></i>').join('') + '</div>';
    }
    return '<div class="frame ' + (c.th || THUMBS[0]) + '"></div>';
  }

  /* ---------- 左栏 ---------- */
  function renderLeft() {
    const t = BENCH.types[type];
    const rec = k => t.recipe.find(r => r.kind === k) || {};

    /* 标题行：型号的完整名（产品上那格只写着 "base"） */
    $('modelName').textContent = t.model;
    $('capLine').textContent = t.cap;

    /* 提示词 */
    const pr = rec('prompt');
    const ta = $('prompt');
    ta.value = pr.text || '';
    $('promptCount').textContent = (ta.value.length) + ' 字';
    $('promptHint').textContent = pr.hint || '';

    /* 输入模式 */
    const mo = rec('mode');
    $('modeVal').textContent = mo.value || '';
    $('modeChips').innerHTML = (mo.opts || []).map(o =>
      '<span class="chip' + (o === mo.value ? ' on' : '') + '" data-v="' + esc(o) + '">' + esc(o) + '</span>').join('');

    /* 参考素材：一行紧凑缩略图 */
    const sl = rec('slots');
    const items = (sl.items || []).map(s =>
      '<span class="slot"><span class="th"><span class="frame ' + s.th + '"></span></span>'
      + '<span class="nm">' + esc(s.label) + '</span><span class="ct">×' + s.n + '</span></span>').join('');
    $('slots').innerHTML = items + '<span class="slot add">＋ 拖进来 / 点选</span>';
    $('slotVal').textContent = (sl.items || []).length + ' 项';

    /* 高级设置：默认展开，参数两列一排 */
    const fl = rec('fields');
    const bo = rec('bool');
    let body = '<div class="pgrid">' + (fl.fields || []).map(f =>
      '<div class="pcell"><span class="pk">' + esc(f.k) + '</span>'
      + '<span class="pv"><span>' + esc(f.v) + '</span><span class="chev"></span></span></div>').join('') + '</div>';
    if (bo.bools) {
      body += (bo.bools || []).map(b =>
        '<div class="swrow"><span>' + esc(b.k) + '</span>'
        + '<span class="switch' + (b.v === '是' ? ' on' : '') + '"><i></i></span></div>').join('');
    }
    $('advBody').innerHTML = body;
    $('advSum').textContent = (fl.fields || []).map(f => f.v).join(' · ');

    /* 提交条 */
    $('estV').textContent = t.est;
    $('estSub').textContent = t.estSub;
    $('goBtn').textContent = t.go;
  }

  /* ---------- 右栏 ---------- */
  function visibleCards() {
    const q = ($('search').value || '').trim().toLowerCase();
    return cards.filter(c => (filter === 'all' || c.type === filter)
      && (!q || (c.prompt || '').toLowerCase().includes(q) || c.id.includes(q)));
  }

  function renderWall() {
    const list = visibleCards();
    $('wallGrid').innerHTML = list.map(c =>
      '<article class="card' + (picked.has(c.id) ? ' picked' : '') + '" data-id="' + c.id + '">'
      + '<div class="thumb"><span class="pick"></span>' + thumbInner(c) + '</div>'
      + '<div class="meta"><span class="t">' + esc(c.zh) + '</span>'
      + '<span class="state ok"><i class="dot"></i>已完成</span>'
      + (c.local ? '<span class="tag">本机</span>' : '')
      + '<span class="d">' + esc(c.time.slice(5)) + '</span></div>'
      + '<p class="p">' + esc(c.prompt || '（无提示词）') + '</p>'
      + '<div class="acts"><button class="ghost" type="button">详情</button>'
      + '<button class="ghost" type="button">放大</button>'
      + '<button class="ghost" type="button">下载</button></div></article>').join('');

    $('wallGrid').querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (multi) {
          if (picked.has(id)) picked.delete(id); else picked.add(id);
          $('bulkCnt').textContent = '已选 ' + picked.size + ' 项';
          renderWall();
        } else {
          paintLatest(cards.find(c => c.id === id));
        }
      });
    });
  }

  /* 最新一条：横条 */
  function paintLatest(c) {
    if (!c) return;
    $('latestThumb').innerHTML = c.type === 'audio'
      ? '<div class="wave">' + WAVE.map(h => '<i style="height:' + h + 'px"></i>').join('') + '</div>'
      : '<span class="frame ' + (c.th || 'th-1') + '"></span>';
    $('latestType').textContent = c.zh;
    $('latestLocal').textContent = c.local ? '本机' : '云端';
    $('latestLocal').style.display = c.local ? '' : 'none';
    $('latestTime').textContent = c.time;
    $('latestPrompt').textContent = c.prompt || '（无提示词）';
  }

  /* ---------- 类型 ---------- */
  function renderType() {
    const t = BENCH.types[type];
    $('typeSeg').innerHTML = BENCH.order.map(k =>
      '<button type="button" data-t="' + k + '" role="tab" class="' + (k === type ? 'on' : '') + '">' + BENCH.types[k].zh + '</button>').join('');
    $('typeSeg').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        if (b.dataset.t === type) return;
        type = b.dataset.t;
        renderAll();
      });
    });
  }

  /* ---------- 提交：状态条原地出回执 ---------- */
  function status(html, cls) {
    $('status').innerHTML = html;
    if (cls) $('status').querySelector('.state').className = 'state ' + cls;
  }

  function submit() {
    const t = BENCH.types[type];
    $('goBtn').disabled = true;
    status('<span class="state run"><i class="dot"></i>提交中</span><span class="muted">' + t.zh + ' · 正在等平台回话…</span>', 'run');
    setTimeout(() => {
      const fresh = {
        id: 'n' + (cards.length + 1),
        type: type === 'audio' ? 'audio' : (type === 'image' ? 'image' : 'video'),
        zh: BENCH.types[type].zh, local: true, time: '2026-10-25 13:57',
        size: type === 'audio' ? '396 KB' : '42.0 KB',
        prompt: (t.recipe[0].text || '').slice(0, 18),
        th: THUMBS[cards.length % THUMBS.length],
      };
      cards.unshift(fresh);
      $('goBtn').disabled = false;
      status('<span class="state ok"><i class="dot"></i>刚完成</span><span class="muted">local · '
        + (fresh.type === 'audio' ? 'WAV' : 'PNG') + ' · ' + fresh.size + ' · 已进历史墙</span>', 'ok');
      renderWall();
      paintLatest(fresh);
    }, 1700);
  }

  function renderAll() {
    renderType();
    renderLeft();
    renderWall();
    paintLatest(cards[0]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    /* 提示词：字数写回标题那一行 */
    $('prompt').addEventListener('input', () => {
      $('promptCount').textContent = $('prompt').value.length + ' 字';
    });
    /* 输入模式 */
    $('modeChips').querySelectorAll('.chip').forEach(c => {
      c.addEventListener('click', () => {
        $('modeChips').querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
        c.classList.add('on');
        $('modeVal').textContent = c.dataset.v;
      });
    });
    /* 高级设置：默认展开，点标题才折 */
    $('advHead').addEventListener('click', () => {
      document.querySelector('.blk-adv').classList.toggle('closed');
    });

    /* 右栏 */
    $('search').addEventListener('input', renderWall);
    $('filterSeg').innerHTML = BENCH.filters.map(f =>
      '<button type="button" data-k="' + f.k + '" class="' + (f.k === filter ? 'on' : '') + '">' + f.zh + ' ' + f.n + '</button>').join('');
    $('filterSeg').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        filter = b.dataset.k;
        $('filterSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        renderWall();
      });
    });
    $('multiBtn').addEventListener('click', () => {
      multi = !multi;
      picked.clear();
      $('bulk').hidden = !multi;
      $('multiBtn').textContent = multi ? '退出多选' : '多选';
      $('wallGrid').classList.toggle('multi', multi);
      $('bulkCnt').textContent = '已选 0 项';
      renderWall();
    });
    $('multiExit').addEventListener('click', () => $('multiBtn').click());
    $('refreshBtn').addEventListener('click', () => {
      $('refreshBtn').textContent = '取回中…';
      setTimeout(() => { $('refreshBtn').textContent = '刷新'; }, 900);
    });
    $('themeBtn').addEventListener('click', () => {
      const el = document.documentElement;
      el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark';
    });
    $('goBtn').addEventListener('click', submit);

    renderAll();
    window.__benchSetTheme = t => { document.documentElement.dataset.theme = t; };
    window.__benchSetType = t => { type = t; renderAll(); };
  });
})();
