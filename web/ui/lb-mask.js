/* LbMask — 在已打开的公共灯箱（Wb.lightbox）上叠一层「编号批注」。
   涂鸦层完全重写：点 / 框 / 画笔 / 箭头四种工具 + 撤销 / 重做 / 清空；图上编号圆点与右侧批注
   列表一一对应，支持内联填写与删除；删除哪一条，后面的编号都顺次往前顶；完成时交回 {png, doc}，
   png 仍走原来的 isMask 链路。
   公共灯箱一行不改：左工具条与右列表挂在 #lightbox（stage 的兄弟），覆盖层挂 #lbStage 内，
   stage 被 show()/close() 清空时由 MutationObserver 自动保存并收尾。
   enter 会等图就绪再起层：灯箱 show() 是异步的，第二次起脚本已缓存，调用会跑在图片加载前面。
   条目字段：mask = 编号图 PNG dataURL（下游兼容），annots = 结构化文档（真相）。
   按需补载（__spaLoadScript），不进 shell 常驻。 */
(function () {
  var TOOLS = [['point', '点'], ['box', '框'], ['brush', '画笔'], ['arrow', '箭头']];
  var KINDS = ['point', 'box', 'brush', 'arrow'];
  var UNDO_MAX = 30;
  var MIN_DRAG = 0.004;                 // 归一化坐标：短于这个距离不算框 / 箭头
  var WAIT_TICKS = 80, WAIT_MS = 50;    // enter 等图就绪：4 秒上限，到了才提示
  var cur = null;
  var enterSeq = 0;                     // 每次 enter 发一枚号：只有最新一枚能起层，旧等待作废

  /* 颜色只从令牌取：canvas / SVG 不认 var()，用 1px 画布把令牌换算成 rgb，
     这样深浅主题与配色块切换时标注颜色跟着走，也不会有裸十六进制色值散在代码里。 */
  function rgbOf(name, fallback) {
    var v = '';
    try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) { /* 主题还没起来就走兜底色 */ }
    var t = document.createElement('canvas');
    t.width = t.height = 1;
    var g = t.getContext('2d');
    g.fillStyle = v || fallback;
    g.fillRect(0, 0, 1, 1);
    var d;
    try { d = g.getImageData(0, 0, 1, 1).data; } catch (e) { return [255, 255, 255]; }
    return [d[0], d[1], d[2]];
  }
  function css(list) { return 'rgb(' + list[0] + ',' + list[1] + ',' + list[2] + ')'; }
  function escAnn(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(x) { return JSON.parse(JSON.stringify(x || {})); }

  /* 读文档：涂鸦层自己认自己的形状，不反过来读 domain 层（分层方向只允许 ui → ui）。
     老条目只有一张 PNG 字符串 → 收进 legacyMask 当只读参考层，不伪装成结构化批注。 */
  function readDoc(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') return /^data:image\//.test(raw)
      ? { v: 1, seq: 1, items: [], legacyMask: raw } : null;
    if (typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1 || !Array.isArray(raw.items)) return null;
    var items = [], max = 0;
    raw.items.forEach(function (x) {
      if (!x || KINDS.indexOf(x.type) < 0 || !Number(x.n) || !Array.isArray(x.points) || !x.points.length) return;
      var pts = x.points.filter(function (p) { return Array.isArray(p) && p.length === 2
        && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])); })
        .map(function (p) { return [Number(p[0]), Number(p[1])]; });
      if (!pts.length) return;
      items.push({ id: String(x.id || 'k' + x.n), n: Number(x.n), type: x.type, points: pts,
        text: String(x.text || ''), w: Math.max(1, Number(x.w) || 3) });
      if (Number(x.n) > max) max = Number(x.n);
    });
    return { v: 1, seq: Math.max(Number(raw.seq) || 0, max + 1),
      items: items, legacyMask: String(raw.legacyMask || '') };
  }
  function blankDoc() { return { v: 1, seq: 1, items: [], legacyMask: '' }; }

  /* 起层本体：只在图片已就绪时被 enter 调进来 */
  function begin(img, onSave, o) {
    var lb = document.getElementById('lightbox');
    var stage = document.getElementById('lbStage');
    if (!lb || !stage) return;
    /* 幂等：重入时先摘干净自己的旧节点，绝不碰灯箱自己的 DOM */
    lb.querySelectorAll('.lb-ann-tools,.lb-ann-list,.lb-ann-inline').forEach(function (n) { n.remove(); });
    stage.querySelectorAll('.lb-ann-overlay,.lb-ann-echo,.lb-ann-legacy').forEach(function (n) { n.remove(); });

    var colors = {
      bg: css(rgbOf('--media-bg', 'black')),
      red: css(rgbOf('--err', 'red')),
      white: css(rgbOf('--on-acc', 'white')),
      acc: css(rgbOf('--acc', 'red')),
    };
    var dims = { w: Math.round(img.naturalWidth) || 1, h: Math.round(img.naturalHeight) || 1 };
    var doc = readDoc(o.existing) || blankDoc();
    var st = {
      tool: 'point', sel: '', draft: null, dirty: false, saved: false,
      undo: [], redo: [],
    };

    var tools = document.createElement('div');
    tools.className = 'lb-ann-tools';
    tools.innerHTML = '<div class="lb-ann-hd">批注方式</div>'
      + TOOLS.map(function (t, i) {
        return '<button type="button" class="ghost mini lb-ann-tool' + (i === 0 ? ' on' : '')
          + '" data-t="' + t[0] + '" aria-pressed="' + (i === 0) + '">' + t[1] + '</button>';
      }).join('')
      + '<div class="lb-ann-sep"></div>'
      + '<button type="button" class="ghost mini" data-act="undo" disabled>撤销</button>'
      + '<button type="button" class="ghost mini" data-act="redo" disabled>重做</button>'
      + '<button type="button" class="ghost mini" data-act="clear">清空</button>';

    var list = document.createElement('div');
    list.className = 'lb-ann-list';
    list.innerHTML = '<div class="lb-ann-hd">批注 <span class="lb-ann-count">0</span>'
      + '<button type="button" class="pri mini" data-act="done">完成</button></div>'
      + '<div class="lb-ann-items"></div>';

    var overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('class', 'lb-ann-overlay');
    overlay.setAttribute('viewBox', '0 0 ' + dims.w + ' ' + dims.h);
    overlay.setAttribute('preserveAspectRatio', 'none');

    var inline = document.createElement('div');
    inline.className = 'lb-ann-inline';
    inline.hidden = true;
    inline.innerHTML = '<span class="lb-ann-inline-n">1</span>'
      + '<input class="ui-inp" type="text" maxlength="200" placeholder="这里改成什么?">'
      + '<button type="button" class="pri mini" data-act="ok">好</button>';

    stage.style.position = 'relative';
    stage.appendChild(overlay);
    stage.appendChild(inline);
    lb.insertBefore(tools, stage);
    lb.appendChild(list);
    fit();

    function fit() {
      var im = stage.querySelector('img');
      if (!im) return;
      var ir = im.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      var l = (ir.left - sr.left) + 'px', t = (ir.top - sr.top) + 'px';
      var layers = [overlay].concat(Array.prototype.slice.call(stage.querySelectorAll('.lb-ann-echo,.lb-ann-legacy')));
      layers.forEach(function (n) {
        n.style.left = l; n.style.top = t; n.style.width = ir.width + 'px'; n.style.height = ir.height + 'px';
      });
    }

    function svg(tag, attrs, text) {
      var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (text != null) n.textContent = text;
      return n;
    }
    function scaled(points) {
      return points.map(function (p) {
        return [Math.max(0, Math.min(1, p[0])) * dims.w, Math.max(0, Math.min(1, p[1])) * dims.h];
      });
    }
    function firstOf(a) { return scaled(a.points)[0] || [0, 0]; }
    function badge(n, p, active) {
      var g = svg('g', { opacity: active ? '1' : '.9' });
      g.appendChild(svg('circle', { cx: p[0], cy: p[1] - dims.h * 0.032, r: Math.max(9, dims.h * 0.016),
        fill: colors.white, stroke: colors.red, 'stroke-width': active ? 3 : 1.5 }));
      g.appendChild(svg('text', { x: p[0], y: p[1] - dims.h * 0.032, fill: colors.red,
        'font-size': Math.max(10, dims.h * 0.016), 'font-weight': '700',
        'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(n)));
      return g;
    }
    function shapeOf(a, draft) {
      var P = scaled(a.points), g = svg('g', { opacity: draft ? '.65' : '1' });
      var sw = Math.max(2, a.w || 3);
      if (a.type === 'point') {
        g.appendChild(svg('circle', { cx: P[0][0], cy: P[0][1], r: sw * 2,
          fill: 'none', stroke: colors.red, 'stroke-width': sw }));
      } else if (a.type === 'box' && P.length >= 2) {
        var x = Math.min(P[0][0], P[1][0]), y = Math.min(P[0][1], P[1][1]);
        g.appendChild(svg('rect', { x: x, y: y, width: Math.abs(P[1][0] - P[0][0]),
          height: Math.abs(P[1][1] - P[0][1]), fill: 'none', stroke: colors.red, 'stroke-width': sw }));
      } else if (a.type === 'brush' && P.length >= 2) {
        g.appendChild(svg('polyline', { points: P.map(function (p) { return p[0] + ',' + p[1]; }).join(' '),
          fill: 'none', stroke: colors.red, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      } else if (a.type === 'arrow' && P.length >= 2) {
        g.appendChild(svg('line', { x1: P[0][0], y1: P[0][1], x2: P[1][0], y2: P[1][1],
          stroke: colors.red, 'stroke-width': sw, 'stroke-linecap': 'round' }));
        var ang = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]), head = Math.max(9, sw * 3.5);
        [-0.5, 0.5].forEach(function (d) {
          g.appendChild(svg('line', { x1: P[1][0], y1: P[1][1],
            x2: P[1][0] - head * Math.cos(ang + d), y2: P[1][1] - head * Math.sin(ang + d),
            stroke: colors.red, 'stroke-width': sw, 'stroke-linecap': 'round' }));
        });
      }
      return g;
    }
    function renderOverlay() {
      overlay.textContent = '';
      doc.items.forEach(function (a) {
        overlay.appendChild(shapeOf(a, false));
        overlay.appendChild(badge(a.n, firstOf(a), a.id === st.sel));
      });
      if (st.draft) overlay.appendChild(shapeOf(st.draft, true));
    }
    function renderList() {
      var host = list.querySelector('.lb-ann-items');
      host.innerHTML = doc.items.length ? doc.items.map(function (a) {
        return '<div class="lb-ann-row' + (a.id === st.sel ? ' is-sel' : '') + '" data-id="' + escAnn(a.id) + '">'
          + '<span class="lb-ann-num">' + a.n + '</span>'
          + '<span class="lb-ann-txt">' + escAnn(a.text || '还没写改成什么') + '</span>'
          + '<button type="button" class="lb-ann-del" data-del="' + escAnn(a.id) + '" title="删除这条批注">×</button></div>';
      }).join('') : '<div class="lb-ann-empty">图上点一下，加第一条批注</div>';
      list.querySelector('.lb-ann-count').textContent = String(doc.items.length);
      tools.querySelector('[data-act="undo"]').disabled = !st.undo.length;
      tools.querySelector('[data-act="redo"]').disabled = !st.redo.length;
      tools.querySelector('[data-act="clear"]').disabled = !doc.items.length && !doc.legacyMask;
    }
    function hideInline() { inline.hidden = true; }
    function showInline(a) {
      if (!a) { hideInline(); return; }
      var im = stage.querySelector('img');
      if (!im) { hideInline(); return; }
      var ir = im.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      var p = scaled(a.points)[0];
      var x = ir.left - sr.left + p[0] / dims.w * ir.width;
      var y = ir.top - sr.top + p[1] / dims.h * ir.height;
      inline.style.left = Math.max(4, Math.min(sr.width - 300, x - 30)) + 'px';
      inline.style.top = Math.max(4, Math.min(sr.height - 48, y + 16)) + 'px';
      inline.querySelector('.lb-ann-inline-n').textContent = String(a.n);
      var ip = inline.querySelector('input');
      ip.value = a.text || '';
      inline.hidden = false;
      try { ip.focus(); } catch (e) { /* 焦点给不出去不影响批注本身 */ }
    }
    function renderAnn() { renderOverlay(); renderList(); }

    function pushUndo() {
      st.undo.push(clone(doc));
      if (st.undo.length > UNDO_MAX) st.undo.shift();
      st.redo.length = 0;
    }
    function mutateAnn(fn) {
      pushUndo();
      fn();
      st.dirty = true;
      renderAnn();
    }
    function undoAnn() {
      if (!st.undo.length) return;
      st.redo.push(clone(doc));
      doc = st.undo.pop();
      st.dirty = true;
      hideInline(); renderAnn();
    }
    function redoAnn() {
      if (!st.redo.length) return;
      st.undo.push(clone(doc));
      doc = st.redo.pop();
      st.dirty = true;
      hideInline(); renderAnn();
    }
    function byId(id) { return doc.items.find(function (x) { return x.id === id; }); }
    function select(a) {
      st.sel = a ? a.id : '';
      renderAnn();
      showInline(a);
    }

    function posOf(e) {
      var r = overlay.getBoundingClientRect();
      return [
        Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))),
        Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height))),
      ];
    }
    function far(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) >= MIN_DRAG; }
    function addAnnot(kind, points) {
      var a = { id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        n: doc.seq++, type: kind, points: points, text: '', w: 3 };
      mutateAnn(function () { doc.items.push(a); });
      st.sel = a.id;
      renderAnn(); showInline(a);
    }
    function removeAnnot(id) {
      mutateAnn(function () {
        doc.items = doc.items.filter(function (x) { return x.id !== id; });
        /* 删哪条都重排：右栏与图上编号始终连着 1..N，产物 PNG 与文档用同一套号 */
        doc.items.forEach(function (x, i) { x.n = i + 1; });
        doc.seq = doc.items.length + 1;
      });
    }

    overlay.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* 有的指针不给捕获 / 已释放 */ }
      var p = posOf(e);
      if (st.tool === 'point') { addAnnot('point', [p]); return; }
      st.draft = { type: st.tool, points: [p, p], w: 3 };
      renderOverlay();
    });
    overlay.addEventListener('pointermove', function (e) {
      if (!st.draft) return;
      var p = posOf(e), pts = st.draft.points;
      if (st.tool === 'brush') {
        if (!far(pts[pts.length - 1], p)) return;
        pts.push(p);
      } else pts[1] = p;
      renderOverlay();
    });
    var stop = function (e) {
      if (!st.draft) return;
      var d = st.draft;
      st.draft = null;
      try { overlay.releasePointerCapture(e.pointerId); } catch (err) { /* 有的指针不给捕获 / 已释放 */ }
      if (d.type === 'brush' ? d.points.length >= 2 : far(d.points[0], d.points[1] || d.points[0])) addAnnot(d.type, d.points);
      else renderOverlay();
    };
    overlay.addEventListener('pointerup', stop);
    overlay.addEventListener('pointercancel', stop);

    tools.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.t) {
        st.tool = b.dataset.t;
        tools.querySelectorAll('[data-t]').forEach(function (x) {
          var on = x === b;
          x.classList.toggle('on', on);
          x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        return;
      }
      if (b.dataset.act === 'undo') undoAnn();
      else if (b.dataset.act === 'redo') redoAnn();
      else if (b.dataset.act === 'clear') {
        hideInline();
        mutateAnn(function () { doc.items = []; doc.seq = 1; doc.legacyMask = ''; });
      }
    };
    list.onclick = function (e) {
      var b = e.target.closest('button');
      if (b && b.dataset.del) {
        e.stopPropagation();
        removeAnnot(b.dataset.del);
        if (st.sel === b.dataset.del) { st.sel = ''; hideInline(); }
        return;
      }
      if (b && b.dataset.act === 'done') { finishAnnot(); return; }
      if (b && b.dataset.act === 'ok') { commitInline(); return; }
      var row = e.target.closest('.lb-ann-row');
      if (row) select(byId(row.dataset.id));
    };
    function commitInline() {
      var a = byId(st.sel);
      if (!a) { hideInline(); return; }
      var v = inline.querySelector('input').value.trim();
      hideInline();
      if ((a.text || '') === v) { renderList(); return; }
      mutateAnn(function () { a.text = v; });
    }
    inline.onclick = function (e) {
      if (e.target.closest('[data-act="ok"]')) commitInline();
    };
    inline.querySelector('input').addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitInline(); }
      else if (e.key === 'Escape') { e.preventDefault(); hideInline(); }
    });

    var onKey = function (e) {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      var mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) redoAnn(); else undoAnn();
      } else if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault(); e.stopPropagation(); redoAnn();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel) {
        e.preventDefault(); e.stopPropagation();
        removeAnnot(st.sel);
        st.sel = ''; hideInline();
      } else if (e.key === 'Escape') {
        /* 输入框里的 Esc 已自己吃掉；这里只保存退出编辑态，不拦公共灯箱关窗 */
        finishAnnot(true);
      }
    };
    lb.addEventListener('keydown', onKey, true);

    function drawLegacy(g, im) {
      if (im && im.complete && im.naturalWidth) g.drawImage(im, 0, 0, dims.w, dims.h);
    }
    function exportPng(legacy) {
      if (!dims.w || !dims.h) return '';
      var out = document.createElement('canvas');
      out.width = dims.w; out.height = dims.h;
      var g = out.getContext('2d');
      g.fillStyle = colors.bg;
      g.fillRect(0, 0, dims.w, dims.h);
      drawLegacy(g, legacy);
      doc.items.forEach(function (a) {
        var P = scaled(a.points), sw = Math.max(3, a.w || 3);
        g.strokeStyle = colors.red;
        g.fillStyle = colors.red;
        g.lineWidth = sw; g.lineCap = 'round'; g.lineJoin = 'round';
        if (a.type === 'point') {
          g.beginPath(); g.arc(P[0][0], P[0][1], sw * 2, 0, Math.PI * 2); g.stroke();
        } else if (a.type === 'box' && P.length >= 2) {
          g.strokeRect(Math.min(P[0][0], P[1][0]), Math.min(P[0][1], P[1][1]),
            Math.abs(P[1][0] - P[0][0]), Math.abs(P[1][1] - P[0][1]));
        } else if (a.type === 'brush' && P.length >= 2) {
          g.beginPath(); P.forEach(function (p, i) { i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }); g.stroke();
        } else if (a.type === 'arrow' && P.length >= 2) {
          g.beginPath(); g.moveTo(P[0][0], P[0][1]); g.lineTo(P[1][0], P[1][1]); g.stroke();
          var ang = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]), head = Math.max(12, sw * 3.5);
          [-0.5, 0.5].forEach(function (d) {
            g.beginPath(); g.moveTo(P[1][0], P[1][1]);
            g.lineTo(P[1][0] - head * Math.cos(ang + d), P[1][1] - head * Math.sin(ang + d)); g.stroke();
          });
        }
        var p = P[0], r = Math.max(9, dims.h * 0.016), cy = p[1] - dims.h * 0.032;
        g.beginPath(); g.arc(p[0], cy, r, 0, Math.PI * 2);
        g.fillStyle = colors.white; g.fill();
        g.strokeStyle = colors.red; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = colors.red;
        g.font = '700 ' + Math.max(10, dims.h * 0.016) + 'px sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(a.n), p[0], cy);
      });
      return out.toDataURL('image/png');
    }
    function echo(png) {
      var stage2 = document.getElementById('lbStage');
      var img2 = stage2 ? stage2.querySelector('img') : null;
      if (!stage2 || !img2 || !png) return;
      stage2.querySelectorAll('.lb-ann-echo').forEach(function (n) { n.remove(); });
      var layer = document.createElement('img');
      layer.className = 'lb-ann-echo';
      layer.src = png;
      stage2.style.position = 'relative';
      stage2.appendChild(layer);
      fit();
    }
    function detach(keepEcho, png) {
      if (!cur) return;
      try { lb.removeEventListener('keydown', onKey, true); } catch (e) { /* 灯箱已不在就没什么可摘 */ }
      try { if (cur.mo) cur.mo.disconnect(); } catch (e) { /* 观察器已断就不再断一次 */ }
      tools.remove(); list.remove(); overlay.remove(); inline.remove();
      stage.querySelectorAll('.lb-ann-legacy').forEach(function (n) { n.remove(); });
      cur = null;
      if (keepEcho) echo(png);
      if (o.onExit) o.onExit();
    }
    function finishAnnot(silent) {
      if (!cur || st.saved) return;
      st.saved = true;
      var png = (doc.items.length || doc.legacyMask) ? exportPng(cur.legacy) : '';
      if (png && onSave) { try { onSave(png, clone(doc)); } catch (e) { /* 回调挂了也不能卡住灯箱收尾 */ } }
      detach(!silent, png);
    }
    function shouldSave() { return st.dirty || doc.items.length > 0 || !!doc.legacyMask; }

    /* stage 被灯箱 show()/close() 清空：overlay 脱链即收尾。此时不画回显（图上已经换新或没了）*/
    var mo = new MutationObserver(function () {
      if (cur && overlay && !overlay.isConnected) {
        if (shouldSave()) finishAnnot(true); else detach(false, '');
      }
    });
    mo.observe(stage, { childList: true });
    var legacy = null;
    if (doc.legacyMask) {
      legacy = new Image();
      legacy.src = doc.legacyMask;
      var layer = legacy.cloneNode();
      layer.className = 'lb-ann-legacy';
      stage.insertBefore(layer, overlay);
      fit();
    }
    cur = { lb: lb, stage: stage, img: img, overlay: overlay, tools: tools, list: list,
      inline: inline, legacy: legacy, mo: mo, onKey: onKey, getDoc: function () { return doc; } };
    renderAnn();
  }

  function enter(onSave, opts) {
    exit();
    var o = opts || {};
    var tok = ++enterSeq;
    var lb = document.getElementById('lightbox');
    var stage = document.getElementById('lbStage');
    if (!lb || !stage) {
      if (window.Toast && Toast.err) Toast.err('先等图片加载完再批注');
      return;
    }
    /* 灯箱 show() 是异步补图：脚本已缓存时这里会比图片加载先到 —— 等图就绪再起层。
       灯箱关掉（display 归 none）或有更新的 enter 接手时安静作废，只有等满上限才提示。 */
    (function wait(ticks) {
      if (tok !== enterSeq || lb.style.display === 'none') return;
      var im = stage.querySelector('img');
      if (im && im.naturalWidth) { begin(im, onSave, o); return; }
      if (ticks >= WAIT_TICKS) {
        if (window.Toast && Toast.err) Toast.err('先等图片加载完再批注');
        return;
      }
      setTimeout(function () { wait(ticks + 1); }, WAIT_MS);
    })(0);
  }

  function exit() {
    if (!cur) return;
    var c = cur;
    cur = null;
    try { c.lb.removeEventListener('keydown', c.onKey, true); } catch (e) { /* 灯箱已不在就没什么可摘 */ }
    try { if (c.mo) c.mo.disconnect(); } catch (e) { /* 观察器已断就不再断一次 */ }
    c.tools.remove(); c.list.remove(); c.overlay.remove(); c.inline.remove();
    c.stage.querySelectorAll('.lb-ann-legacy').forEach(function (n) { n.remove(); });
  }
  function echo(url) {
    var stage = document.getElementById('lbStage');
    var img = stage ? stage.querySelector('img') : null;
    if (!stage || !img || !url) return;
    stage.querySelectorAll('.lb-ann-echo').forEach(function (n) { n.remove(); });
    var layer = document.createElement('img');
    layer.className = 'lb-ann-echo';
    layer.src = url;
    stage.style.position = 'relative';
    var ir = img.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    layer.style.left = (ir.left - sr.left) + 'px';
    layer.style.top = (ir.top - sr.top) + 'px';
    layer.style.width = ir.width + 'px';
    layer.style.height = ir.height + 'px';
    stage.appendChild(layer);
  }

  window.LbMask = {
    enter: function (fn, opts) { enter(fn, opts); },
    exit: function () { exit(); },
    echo: function (url) { echo(url); },
    isActive: function () { return !!cur; },
    /* 只读快照：入口层与判据要在编辑途中看当前文档（完成前 onSave 还没调） */
    current: function () { return cur && cur.getDoc ? clone(cur.getDoc()) : null; },
  };
})();
