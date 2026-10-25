/* ============================================================================
   左栏（两形态版）—— 交互
   ---------------------------------------------------------------------------
   两种形态（满 232 / 窄 56）互切、窄形态的悬停名牌、换深浅主题。
   纯静态稿：不碰产品代码，不连任何外部数据。
   ========================================================================== */
(function () {
  const D = window.SB2;
  const $ = s => document.querySelector(s);

  const shellEl = $('#shell');
  const sbEl = $('#sb');
  const modesEl = $('#modes');
  const notesEl = $('#notes');

  const icon = (name, size) => {
    const b = D.ICONS[name];
    if (!b) return '';
    const s = size || 16;
    return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor"'
      + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
      + ' style="flex:0 0 auto">' + b + '</svg>';
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- 导航项 ---------- */
  const itemHTML = it => '<a class="sb-item' + (it.active ? ' on' : '') + '" href="#" data-id="' + esc(it.id) + '"'
    + ' data-label="' + esc(it.label) + '" aria-label="' + esc(it.label) + '">'
    + '<span class="sb-ic">' + icon(it.ic, 19) + '</span>'
    + '<span class="sb-lb">' + esc(it.label) + '</span>'
    + '<span class="sb-short">' + esc(it.short || '') + '</span>'
    + '</a>';

  /* ---------- 余额行：名字 + 金额一行，冻结 / 原因一行 ---------- */
  const balRowHTML = r => '<div class="sb-bal-row' + (r.failed ? ' bad' : '') + '"'
    + (r.failed ? ' title="' + esc(r.why) + '"' : '') + '>'
    + '<div class="sb-bal-l">'
    + '<span class="nm">' + esc(r.name) + '</span>'
    + '<span class="sub">' + (r.failed ? esc(r.why)
      : '冻结 ' + esc(r.frozen) + (r.unit ? ' ' + esc(r.unit) : '')) + '</span>'
    + '</div>'
    + '<span class="am">' + esc(r.avail) + (r.unit && !r.failed ? ' ' + esc(r.unit) : '') + '</span>'
    + '</div>';

  /* 窄形态那排状态点的说明：几家取到了、几家取不到（取不到的那家是谁） */
  const dotsTitle = (() => {
    const rows = D.balance.rows;
    const ok = rows.filter(r => !r.failed);
    const bad = rows.filter(r => r.failed);
    const parts = [D.balance.count + ' 家余额'];
    if (ok.length) parts.push(ok.length + ' 家取到');
    if (bad.length) parts.push(bad.length + ' 家取不到（' + bad.map(r => r.name).join('、') + '）');
    return parts.join(' · ');
  })();

  sbEl.innerHTML =
    '<div class="sb-top">'
    + '<button class="sb-tile" id="sbTile" type="button" title="点击收起 / 展开侧栏">AI</button>'
    + '<div class="sb-brand"><div class="sb-name">' + esc(D.brand.name) + '</div>'
    + '<div class="sb-sub">' + esc(D.brand.sub) + '</div></div>'
    + '</div>'
    + '<nav class="sb-nav">' + D.nav.map(itemHTML).join('') + '</nav>'
    + '<div class="sb-live">'
    + '<div class="sb-now">'
    + '<div class="sb-now-t">账户余额 <span>' + D.balance.count + ' 家</span></div>'
    + D.balance.rows.map(balRowHTML).join('')
    + '<div class="sb-now-sep"></div>'
    + '<div class="sb-mirror-t">产物正在存进本机 <b>' + D.mirror.done + ' / ' + D.mirror.total + ' 份</b></div>'
    + '<div class="sb-mirror-bar"><i style="width:'
    + Math.round(D.mirror.done / D.mirror.total * 100) + '%"></i></div>'
    + '</div>'
    /* 窄形态：同一份内容的压缩版 —— 家数 + 每家一个状态点 + 落盘进度 */
    + '<div class="sb-slim">'
    + '<div class="sb-slim-bal">' + icon('coin', 12) + '<b>' + D.balance.count + '</b></div>'
    + '<div class="sb-dots" title="' + esc(dotsTitle) + '">'
    + D.balance.rows.map(r => '<i class="' + (r.failed ? 'bad' : 'ok') + '"></i>').join('')
    + '</div>'
    + '<div class="sb-slim-sep"></div>'
    + '<div class="sb-slim-mirror" title="产物正在存进本机 · 本次会话已存 '
    + D.mirror.done + ' / ' + D.mirror.total + ' 份">'
    + '<div class="sb-mirror-bar"><i style="width:'
    + Math.round(D.mirror.done / D.mirror.total * 100) + '%"></i></div>'
    + '<span class="sb-mirror-n">' + D.mirror.done + '/' + D.mirror.total + '</span>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="sb-foot">'
    + D.foot.map(f => '<a class="sb-item" href="#" data-id="' + esc(f.id) + '" aria-label="' + esc(f.label) + '">'
      + '<span class="sb-ic">' + icon(f.ic, 18) + '</span>'
      + '<span class="sb-lb">' + esc(f.label) + '</span></a>').join('')
    + '</div>';

  /* ---------- 顶栏的两颗切换按钮 ---------- */
  modesEl.innerHTML = D.forms.map(f =>
    '<button type="button" role="tab" data-form="' + f.id + '" aria-selected="false">'
    + '<b>' + esc(f.name) + ' ' + f.w + '</b><span>' + esc(f.hint) + '</span></button>').join('');

  /* ---------- 三段说明 ---------- */
  notesEl.innerHTML = [
    ['满 · 232px', '读得全',
      '图标 + 完整名字 + 一张<b>「此刻」卡</b>（余额三家 + 落盘进度）。'
      + '卡是这一形态里唯一的一块「信息」：别的都是入口，只有它会自己变。'],
    ['窄 · 56px', '认得出',
      '图标下面直接压<b>两字短标签</b>（导演 / 素材 / 生成 / 收藏 / 资产 / 用量）—— '
      + '所以收起之后<b>不必悬停也知道这一项是什么</b>，悬停只是补全全名。'
      + '整条比现在窄 10px，内容区多让出 10px。'],
    ['切换', '一个控件',
      '收 / 展是顶行右端<b>单独一颗按钮</b>，不是品牌块 —— '
      + '品牌块是品牌，不是控件。当前项在满形态是淡紫底，在窄形态变成<b>实心方块</b>：'
      + '56px 里最认得出的一种「你在哪」。'],
  ].map(x => '<div class="dg-note"><h3>' + x[0] + '<em>' + x[1] + '</em></h3><p>' + x[2] + '</p></div>').join('');

  /* ============================================================================
     切形态
     ========================================================================== */
  let form = 'full';
  /* 收 / 展的开关是**左上角那块品牌砖**（像原来那样，点它收展）——
     侧栏里没有第二样收展标识：不画箭头、不画拉片。两个形态里它是同一块砖，
     手指不用记位置。 */
  const tileBtn = $('#sbTile');

  function setForm(next) {
    if (!D.forms.some(f => f.id === next)) return;
    form = next;
    sbEl.dataset.form = next;
    document.querySelectorAll('#modes button').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.form === next)));
    if (tileBtn) {
      tileBtn.title = next === 'full' ? '点击收成窄栏（56px）' : '点击展开侧栏（232px）';
      tileBtn.setAttribute('aria-label', tileBtn.title);
    }
    hideTip();
  }

  modesEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-form]');
    if (b) setForm(b.dataset.form);
  });
  if (tileBtn) tileBtn.addEventListener('click', () => setForm(form === 'full' ? 'slim' : 'full'));

  /* 导航项：点一下换高亮（稿子里不跳页） */
  sbEl.querySelectorAll('.sb-item').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      if (a.dataset.id === 'settings' || a.dataset.id === 'theme') return;
      sbEl.querySelectorAll('.sb-nav .sb-item').forEach(x => x.classList.remove('on'));
      a.classList.add('on');
    });
  });

  /* 键盘：← → 切形态 */
  document.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    setForm(form === 'full' ? 'slim' : 'full');
    e.preventDefault();
  });

  /* ============================================================================
     窄形态的悬停名牌（补全全名）
     ========================================================================== */
  const tip = document.createElement('div');
  tip.className = 'sb-tip';
  document.body.appendChild(tip);
  function hideTip() { tip.classList.remove('on'); }
  function showTip(a) {
    if (form !== 'slim') return hideTip();
    const label = a.dataset.label || '';
    if (!label) return hideTip();
    tip.textContent = label;
    const r = a.getBoundingClientRect();
    tip.style.left = (r.right + 8) + 'px';
    tip.style.top = Math.round(r.top + r.height / 2 - 14) + 'px';
    tip.classList.add('on');
  }
  sbEl.querySelectorAll('.sb-item').forEach(a => {
    a.addEventListener('mouseenter', () => showTip(a));
    a.addEventListener('mouseleave', hideTip);
    a.addEventListener('focus', () => showTip(a));
    a.addEventListener('blur', hideTip);
  });
  window.addEventListener('resize', hideTip);
  window.addEventListener('scroll', hideTip, true);

  /* ============================================================================
     换主题：夜间档是同一份稿子切 data-theme 派生出来的
     ========================================================================== */
  const themeBtn = $('#dgTheme');
  const setTheme = t => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('dir_theme', t); } catch (e) {}
    if (themeBtn) themeBtn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon', 17);
  };
  if (themeBtn) {
    let saved = null;
    try { saved = localStorage.getItem('dir_theme'); } catch (e) {}
    setTheme(saved === 'dark' ? 'dark' : 'light');
    themeBtn.addEventListener('click', () => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  }

  setForm('full');
  window.__sbSetForm = setForm;
  window.__sbSetTheme = setTheme;
})();
