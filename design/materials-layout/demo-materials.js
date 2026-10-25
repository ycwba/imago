/* ============================================================================
   素材库 · 布局稿 —— 演示用的交互（这一份是稿子的脚手架，不进产品）
   ---------------------------------------------------------------------------
   产品里这些行为都已经在数据层与公共层里实现了（Chars / Wb / AssetLocal …），
   稿子里只把**结构上的那几个动作**做成能点的，好让人看清布局怎么用：
     · 目录轨：点一行 = 换一档筛选（再点同一行 = 回到全部）
     · 卡片：点一下 = 右侧检查器开（编辑不再撑开卡片）
     · 多选：头栏那颗钮换出公共 .bulkbar，卡上冒出勾选框
     · 视图：网格 / 列表两档
     · 左下角「换背景」：切深色档（tokens.css 的深色那一段自动派生，不另设计）
   ========================================================================== */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var grid = document.getElementById('matGrid');
  var scroll = document.getElementById('matScroll');
  var bulk = document.getElementById('matBulk');
  var insp = document.getElementById('matInsp');
  var cards = Array.prototype.slice.call(grid.querySelectorAll('.mcard'));

  /* ---------- 目录轨：一次一档 ---------- */
  var filter = null;   // {f: 'kind'|'miss'|'group', v: '值'}
  var rows = Array.prototype.slice.call(document.querySelectorAll('.rail-row'));

  function cardMiss(c) { return (c.getAttribute('data-miss') || '').split(/\s+/).filter(Boolean); }

  function match(c) {
    if (!filter) return true;
    if (filter.f === 'kind') return c.getAttribute('data-kind') === filter.v;
    if (filter.f === 'group') return c.getAttribute('data-group') === filter.v;
    return cardMiss(c).indexOf(filter.v) >= 0;
  }

  function applyFilter() {
    var shown = 0;
    cards.forEach(function (c) {
      var ok = match(c);
      c.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    var empty = grid.querySelector('.mat-empty');
    if (!shown) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'empty mat-empty';
        empty.innerHTML = '这一档里一条都没有。<br>换一档看，或者点右上「新建素材」加一条。';
        grid.appendChild(empty);
      }
      empty.style.display = '';
    } else if (empty) {
      empty.style.display = 'none';
    }
    rows.forEach(function (r) {
      var on = !!filter && r.getAttribute('data-f') === filter.f && r.getAttribute('data-v') === filter.v;
      r.classList.toggle('on', on);
    });
  }

  rows.forEach(function (r) {
    r.addEventListener('click', function () {
      var f = r.getAttribute('data-f'), v = r.getAttribute('data-v');
      filter = (filter && filter.f === f && filter.v === v) ? null : { f: f, v: v };
      applyFilter();
    });
  });

  /* ---------- 卡片 → 检查器 ---------- */
  function openInsp(c) {
    cards.forEach(function (x) { x.classList.toggle('sel', x === c); });
    app.classList.add('has-insp');
    insp.scrollTop = 0;
  }
  function closeInsp() {
    cards.forEach(function (x) { x.classList.remove('sel'); });
    app.classList.remove('has-insp');
  }
  cards.forEach(function (c) {
    c.addEventListener('click', function (e) {
      if (e.target.closest('.macts')) return;   // 悬停那排动作自己处理
      openInsp(c);
    });
  });
  document.getElementById('inspClose').addEventListener('click', closeInsp);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeInsp();
  });

  /* ---------- 多选 ---------- */
  var multi = false;
  function setMulti(on) {
    multi = on;
    grid.classList.toggle('multi', on);
    bulk.hidden = !on;
    document.getElementById('btnMulti').classList.toggle('active', on);
    if (on) {
      cards.forEach(function (c) {
        var p = c.querySelector('.pick');
        if (!p) {
          p = document.createElement('span');
          p.className = 'pick';
          p.textContent = '';
          c.appendChild(p);
        }
        p.addEventListener('click', function (e) {
          e.stopPropagation();
          p.classList.toggle('on');
          p.textContent = p.classList.contains('on') ? '✓' : '';
          c.classList.toggle('picked', p.classList.contains('on'));
        });
      });
    }
  }
  document.getElementById('btnMulti').addEventListener('click', function () { setMulti(!multi); });
  document.getElementById('btnMulti2').addEventListener('click', function () { setMulti(false); });

  /* ---------- 视图档 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('#viewToggle button'), function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('#viewToggle button'), function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      grid.classList.toggle('view-list', b.getAttribute('data-view') === 'list');
    });
  });

  /* ---------- 窄窗：目录轨是覆盖抽屉 ---------- */
  var railToggle = document.getElementById('railToggle');
  if (railToggle) {
    railToggle.addEventListener('click', function () {
      app.classList.toggle('rail-open');
    });
  }
  var railClose = document.getElementById('railClose');
  if (railClose) {
    railClose.addEventListener('click', function () { app.classList.remove('rail-open'); });
  }

  /* ---------- 换背景（深色档是令牌自动派生） ---------- */
  document.getElementById('sbTheme').addEventListener('click', function () {
    var h = document.documentElement;
    h.setAttribute('data-theme', h.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  /* ---------- 给场景 / 道具那几枚图一个各自的对焦位 ---------- */
  cards.forEach(function (c) {
    var k = c.getAttribute('data-kind');
    var t = c.querySelector('.mthumb');
    if (!t) return;
    if (k === 'scene') t.classList.add('mph-scene');
    if (k === 'prop') t.classList.add('mph-prop');
  });

  applyFilter();
})();
