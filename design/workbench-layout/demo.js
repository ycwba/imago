/* ============================================================================
   生成工作台 · 布局重构稿「作业台」—— 稿子的行为（假数据，不碰真产品）。
   演示这几件事：
     · 配方轨：点标题就地展开/收起，收起时摘要行仍带着当前值
     · 类型切换：视频 / 图像 / 音频 三套配方与估价
     · 舞台：点历史墙上的任意一条，它跳到舞台上放大看
     · 多选：进多选 → 勾选 → 批量条
     · 提交：提交坞原地出回执（进行中 → 已完成），新的一条插进历史墙
     · 深浅档：同一份稿子切两档（不是另设计一版）
   ========================================================================== */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let type = 'video';
  let filter = 'all';
  let selId = 'a1';
  let multi = false;
  let picked = new Set();
  let cards = BENCH.wall.slice();

  /* ---------- 缩略图的「画面」：几档不同色调的暗底片 ---------- */
  const THUMBS = ['th-1', 'th-2', 'th-3', 'th-4', 'th-5', 'th-6'];
  const WAVE = [10, 22, 34, 18, 28, 40, 14, 30, 20, 12, 26, 36, 16, 24, 10, 20];

  function thumbInner(c) {
    if (c.type === 'audio') {
      const bars = WAVE.map(h => '<i style="height:' + h + 'px"></i>').join('');
      return '<div class="wave">' + bars + '</div>';
    }
    return '<div class="frame ' + (c.th || THUMBS[0]) + '"></div>';
  }

  /* ---------- 配方轨 ---------- */
  function bodyHtml(r) {
    if (r.kind === 'prompt' || r.kind === 'style') {
      return '<textarea class="' + (r.kind === 'style' ? 'one' : '') + '" data-role="prompt">' + esc(r.text || '') + '</textarea>'
        + (r.kind === 'prompt'
          ? '<div class="rcp-tools"><button class="tool acc" type="button">✦ AI 润色</button>'
          + '<button class="tool" type="button">✦ 拆分片段生成</button><span class="sp"></span>'
          + '<button class="tool" type="button">清空</button></div>'
          : '<div class="rcp-tools"><button class="tool" type="button">取一位素材的音色描述</button></div>')
        + '<div class="rcp-hint">' + esc(r.hint || '') + '</div>';
    }
    if (r.kind === 'mode') {
      return '<div class="chips">' + r.opts.map(o =>
        '<span class="chip' + (o === r.value ? ' on' : '') + '" data-role="mode" data-v="' + esc(o) + '">' + esc(o) + '</span>').join('')
        + '</div><div class="rcp-hint">' + esc(r.hint || '') + '</div>';
    }
    if (r.kind === 'slots') {
      const items = (r.items || []).map(s =>
        '<span class="slot"><span class="th"><span class="frame ' + s.th + '"></span></span>'
        + '<span class="nm">' + esc(s.label) + '</span><span class="ct">×' + s.n + '</span></span>').join('');
      return '<div class="slots">' + items
        + '<span class="slot add">＋ 拖进来 / 点选</span></div>'
        + '<div class="rcp-hint">' + esc(r.empty || r.hint || '') + '</div>';
    }
    if (r.kind === 'fields') {
      return r.fields.map(f =>
        '<div class="frow"><span class="fk">' + esc(f.k) + '</span>'
        + '<span class="fv">' + esc(f.v) + '<span class="chev"></span></span></div>').join('');
    }
    if (r.kind === 'bool') {
      return r.bools.map(b =>
        '<span class="switch' + (b.v === '是' ? ' on' : '') + '"><i></i>' + esc(b.k) + '</span>').join('');
    }
    if (r.kind === 'cost') {
      return r.lines.map(l =>
        '<div class="costrow"><span class="ck">' + esc(l[0]) + '</span><span class="cv">' + esc(l[1]) + '</span></div>').join('');
    }
    return '';
  }

  function rowHtml(r) {
    return '<section class="rcp' + (r.open ? ' on' : '') + (r.value ? ' set' : '') + '" data-kind="' + r.kind + '">'
      + '<button class="rcp-hd" type="button">'
      + '<span class="rcp-dot"></span><span class="rcp-k">' + esc(r.label) + '</span>'
      + '<span class="rcp-v">' + esc(r.value) + '</span><span class="chev" aria-hidden="true"></span>'
      + '</button>'
      + '<div class="rcp-body"><div class="rcp-in"><div class="rcp-pad">' + bodyHtml(r) + '</div></div></div>'
      + '</section>';
  }

  function renderRail() {
    const t = BENCH.types[type];
    $('railList').innerHTML = t.recipe.map(rowHtml).join('');
    const pending = t.recipe.filter(r => r.value === '0 项' || r.value === '必填').length;
    $('railNote').textContent = t.recipe.length + ' 组 · ' + (pending ? pending + ' 组待补' : '都已填');

    $('railList').querySelectorAll('.rcp-hd').forEach(hd => {
      hd.addEventListener('click', () => {
        const r = hd.parentElement;
        const on = r.classList.toggle('on');
        hd.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
    });
    /* 提示词：边打字边把字数写回摘要行（收起时也看得见） */
    $('railList').querySelectorAll('textarea[data-role="prompt"]').forEach(ta => {
      ta.addEventListener('input', () => {
        const r = ta.closest('.rcp');
        const n = ta.value.length;
        const label = type === 'audio' ? '待合成文本' : (r.querySelector('.rcp-k').textContent);
        r.querySelector('.rcp-v').textContent = n + ' 字';
        r.classList.toggle('set', n > 0);
        if (type === 'audio') r.querySelector('.rcp-k').textContent = label;
      });
    });
    /* 输入模式：点一下换档，摘要行跟着换 */
    $('railList').querySelectorAll('.chip[data-role="mode"]').forEach(c => {
      c.addEventListener('click', () => {
        c.parentElement.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
        c.classList.add('on');
        c.closest('.rcp').querySelector('.rcp-v').textContent = c.dataset.v;
      });
    });
  }

  /* ---------- 历史墙 ---------- */
  function visibleCards() {
    const q = ($('search').value || '').trim().toLowerCase();
    return cards.filter(c => (filter === 'all' || c.type === filter)
      && (!q || (c.prompt || '').toLowerCase().includes(q) || c.id.includes(q)));
  }

  function renderWall() {
    const list = visibleCards();
    $('wallGrid').innerHTML = list.map(c =>
      '<article class="card' + (c.id === selId ? ' on' : '') + (picked.has(c.id) ? ' picked' : '') + '" data-id="' + c.id + '">'
      + '<div class="thumb"><span class="pick"></span>' + thumbInner(c) + '</div>'
      + '<div class="cap"><span class="t">' + esc(c.zh) + '</span>'
      + '<span class="p">' + esc(c.prompt || '（无提示词）') + '</span>'
      + '<span class="d">' + esc(c.time.slice(5)) + '</span></div></article>').join('');

    $('wallGrid').querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (multi) {
          if (picked.has(id)) picked.delete(id); else picked.add(id);
          $('bulkCnt').textContent = '已选 ' + picked.size + ' 项';
          renderWall();
        } else {
          selId = id;
          renderWall();
          paintStage(cards.find(c => c.id === id));
        }
      });
    });
  }

  /* ---------- 舞台 ---------- */
  function paintStage(c) {
    if (!c) return;
    $('stageFrame').className = 'frame ' + (c.type === 'audio' ? '' : (c.th || 'th-1'));
    if (c.type === 'audio') {
      $('stageFrame').innerHTML = '<div class="wave">' + WAVE.map(h => '<i style="height:' + (h * 2.2).toFixed(0) + 'px"></i>').join('') + '</div>';
    } else {
      $('stageFrame').innerHTML = '';
    }
    $('stageType').textContent = c.zh;
    $('stageLocal').textContent = c.local ? '本机' : '云端';
    $('stageLocal').style.display = c.local ? '' : 'none';
    $('stageTime').textContent = c.time;
    $('stagePrompt').textContent = c.prompt || '（无提示词）';
    $('stageMeta').textContent = (c.local ? 'local' : 'remote') + ' · ' + (c.type === 'audio' ? 'WAV' : 'PNG') + ' · ' + c.size;
    $('stagePlay').style.display = c.type === 'image' ? 'none' : '';
    /* 这一条是用什么配方做的 —— 舞台上认出它的那一版 */
    const t = BENCH.types[c.type] || BENCH.types.video;
    const modeRow = t.recipe.find(r => r.kind === 'mode');
    const slotRow = t.recipe.find(r => r.kind === 'slots');
    const fieldRow = t.recipe.find(r => r.kind === 'fields');
    const costRow = t.recipe.find(r => r.kind === 'cost');
    const rows = [];
    if (modeRow) rows.push(['输入模式', modeRow.value]);
    if (slotRow) rows.push(['参考素材', (slotRow.items || []).map(s => s.label + ' ×' + s.n).join(' · ') || '无']);
    if (fieldRow) fieldRow.fields.slice(0, 3).forEach(f => rows.push([f.k, f.v]));
    if (costRow) rows.push(['消耗', costRow.value]);
    $('stageParams').innerHTML = rows.map(r =>
      '<div class="srow"><span class="sk">' + esc(r[0]) + '</span><span class="sv">' + esc(r[1]) + '</span></div>').join('');
    const mediaK = ['尺寸', '画质', '时长（秒）', '画面比例', '输出格式', '格式'];
    const spec = fieldRow ? fieldRow.fields.filter(f => mediaK.indexOf(f.k) >= 0).map(f => f.v) : [];
    $('stageSpec').textContent = spec.join(' · ');
  }

  /* ---------- 类型 / 头 / 估价 ---------- */
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
    $('modelName').textContent = t.model;
    $('modelCap').textContent = t.cap;
    $('bal').textContent = t.bal;
    $('estV').textContent = t.est;
    $('estSub').textContent = t.estSub;
    $('goBtn').textContent = t.go;
  }

  /* ---------- 提交（演示回执） ---------- */
  function receipt(html, cls) {
    $('receipt').innerHTML = html;
    if (cls) $('receipt').querySelector('.state').className = 'state ' + cls;
  }

  function submit() {
    const t = BENCH.types[type];
    $('goBtn').disabled = true;
    receipt('<span class="state run"><i class="dot"></i>提交中</span><span class="muted">' + t.zh + ' · 正在等平台回话…</span>', 'run');
    setTimeout(() => {
      const n = cards.filter(c => c.type === type).length + 1;
      const fresh = {
        id: 'n' + n, type: type === 'audio' ? 'audio' : (type === 'image' ? 'image' : 'video'),
        zh: BENCH.types[type].zh, local: true, time: '2026-10-25 13:06',
        size: type === 'audio' ? '396 KB' : '42.0 KB',
        prompt: (t.recipe[0].text || '').slice(0, 18),
        th: THUMBS[cards.length % THUMBS.length],
      };
      cards.unshift(fresh);
      selId = fresh.id;
      $('goBtn').disabled = false;
      receipt('<span class="state ok"><i class="dot"></i>刚完成</span><span class="muted">local · '
        + (fresh.type === 'audio' ? 'WAV' : 'PNG') + ' · ' + fresh.size + ' · 已进历史墙</span>', 'ok');
      renderWall();
      paintStage(fresh);
    }, 1700);
  }

  /* ---------- 组装 ---------- */
  function renderAll() {
    renderType();
    renderRail();
    renderWall();
    paintStage(cards.find(c => c.id === selId));
  }

  document.addEventListener('DOMContentLoaded', () => {
    /* 类型 / 搜索 / 多选 / 刷新 / 主题 */
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
      $('wallGrid').parentElement.classList.toggle('multi', multi);
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
    $('clearBtn').addEventListener('click', () => {
      receipt('<span class="state"><i class="dot"></i>这一栏已清空</span><span class="muted">8 秒内可以撤销</span>', '');
    });

    renderAll();
    window.__benchSetTheme = t => { document.documentElement.dataset.theme = t; };
    window.__benchSetType = t => { type = t; renderAll(); };
    window.__benchOpenRecipe = key => {
      document.querySelectorAll('.rcp').forEach(r => r.classList.remove('on'));
      const r = document.querySelector('.rcp[data-kind="' + key + '"]');
      if (r) r.classList.add('on');
    };
  });
})();
