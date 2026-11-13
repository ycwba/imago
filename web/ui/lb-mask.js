/* LbMask — 在已打开的灯箱（Wb.lightbox）上叠一层掩码绘画。
   调用方先 Wb.lightbox.open({src,…}) 打开一张图片，再 LbMask.enter(onSaveMask, opts) 进入绘画：
   opts.existing = 已存的掩码 PNG（打开就把旧笔画原色画回画布 —— 编辑是接着上一版画，不是重画）；
   opts.onExit   = 编辑层整个收掉之后调（✕ 退出 / 丢弃确认后），调用方用它把已存掩码的回显再画上。
   「✓ 完成」把掩码 PNG 交回 onSaveMask，画布**留在图上**转半透明回显（标记一直看得见，白笔画
   回显时染主题红：浅色图上白笔画看不见）；「✕ 退出」有改动先问丢弃。Esc 同 ✕。
   灯箱关掉 / 换条目时 stage 被清空，画布随 DOM 一起没、监听由 MutationObserver 自清。
   LbMask.echo(url) 是不进编辑态的独立回显（调用方在打开带旧掩码的图时用）。
   按需补载（__spaLoadScript），不进 shell 常驻。 */
(function () {
  var BRUSH = [[0.006, '极细'], [0.012, '细'], [0.025, '中'], [0.05, '粗']];
  var INK = [
    ['white', '白'], ['red', '红'], ['green', '绿'],
    ['blue', '蓝'], ['yellow', '黄'], ['cyan', '青'],
  ];
  var UNDO_MAX = 12;
  var cur = null;   // { cv, ctx, ghost, bar, st, undoStack, onKey, dlg, onSave, img, stage, mo }

  function inkRgb(name) {
    var t = document.createElement('canvas'); t.width = t.height = 1;
    var tg = t.getContext('2d'); tg.fillStyle = name; tg.fillRect(0, 0, 1, 1);
    var d = tg.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }
  function hasStroke(c) {
    try {
      var g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (var i = 3; i < g.length; i += 28) { if (g[i] > 8) return true; }
    } catch (e) { return true; }
    return false;
  }
  /* 掩码 PNG（黑底 + 彩笔）→ 透明底画布：黑底抠掉，彩色笔画保本色；
     tintWhite 时白笔画染主题红 —— 回显给人在浅色图上看，编辑画布保持原色不改语义。 */
  function maskAlphaLayer(pngUrl, tintWhite, cb) {
    var im = new Image();
    im.onload = () => {
      var out = document.createElement('canvas');
      out.width = im.naturalWidth || 1; out.height = im.naturalHeight || 1;
      var og = out.getContext('2d');
      og.drawImage(im, 0, 0);
      try {
        var d = og.getImageData(0, 0, out.width, out.height), px = d.data;
        var tint = null;
        if (tintWhite) {
          var acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || 'red';
          var t = document.createElement('canvas'); t.width = t.height = 1;
          var tg = t.getContext('2d'); tg.fillStyle = acc; tg.fillRect(0, 0, 1, 1);
          var rgb = tg.getImageData(0, 0, 1, 1).data;
          tint = [rgb[0], rgb[1], rgb[2]];
        }
        for (var i = 0; i < px.length; i += 4) {
          if (px[i + 3] === 0) continue;
          if (px[i] + px[i + 1] + px[i + 2] < 90) { px[i + 3] = 0; continue; }   // 黑底 → 透明
          if (tint && px[i] > 216 && px[i + 1] > 216 && px[i + 2] > 216) {
            px[i] = tint[0]; px[i + 1] = tint[1]; px[i + 2] = tint[2];
          }
        }
        og.putImageData(d, 0, 0);
      } catch (e) { /* 跨域图解不了像素就整层退回不透明度兜底（白笔画认命） */ }
      cb(out);
    };
    im.onerror = () => cb(null);
    im.src = pngUrl;
  }
  /* 把回显画布按灯箱里 img 的显示矩形摆好（与编辑画布同一副几何） */
  function placeEcho(cvEcho, stage, img) {
    var ir = img.getBoundingClientRect();
    var sr = stage.getBoundingClientRect();
    cvEcho.style.left = (ir.left - sr.left) + 'px';
    cvEcho.style.top = (ir.top - sr.top) + 'px';
    cvEcho.style.width = ir.width + 'px';
    cvEcho.style.height = ir.height + 'px';
    cvEcho.width = Math.round(img.naturalWidth) || 1;
    cvEcho.height = Math.round(img.naturalHeight) || 1;
  }
  function oldEcho(stage) { return stage.querySelector('.lb-mask-echo'); }
  /* 独立回显：把一张已存掩码画到当前灯箱图上（半透明、黑底抠掉、白染主题红）。 */
  function echo(url) {
    var stage = document.getElementById('lbStage');
    var img = stage ? stage.querySelector('img') : null;
    var old = stage ? oldEcho(stage) : null;
    if (old) old.remove();
    if (!url || !img || !img.naturalWidth) return;
    maskAlphaLayer(url, true, layer => {
      if (!layer) return;
      var st2 = document.getElementById('lbStage');
      var im2 = st2 ? st2.querySelector('img') : null;
      if (!im2) return;
      layer.className = 'lb-mask-echo';
      placeEcho(layer, st2, im2);
      if (st2.style.position !== 'relative') st2.style.position = 'relative';
      st2.appendChild(layer);
    });
  }

  function enter(onSave, opts) {
    exit();
    var o = opts || {};
    var stage = document.getElementById('lbStage');
    var img = stage ? stage.querySelector('img') : null;
    if (!img || !img.naturalWidth) {
      if (window.Toast && Toast.err) Toast.err('先等图片加载完再画');
      return;
    }
    var old = oldEcho(stage);
    if (old) old.remove();
    var dlg = document.getElementById('lightbox');
    var bar = document.createElement('div');
    bar.className = 'lb-mask-bar';
    bar.innerHTML =
      '<span class="rv-tools" role="group">'
      + '<button type="button" class="ghost mini on" data-t="browse" aria-pressed="true">浏览</button>'
      + '<button type="button" class="ghost mini" data-t="brush" aria-pressed="false">画笔</button>'
      + '<button type="button" class="ghost mini" data-t="erase" aria-pressed="false">橡皮</button></span>'
      + '<span class="rv-tools" role="group">'
      + BRUSH.map((b, i) => '<button type="button" class="ghost mini' + (i === 1 ? ' on' : '') + '" data-w="' + i + '">' + b[1] + '</button>').join('')
      + '</span>'
      + '<span class="rv-tools" role="group">'
      + INK.map(c => '<button type="button" class="rv-swatch' + (c[0] === 'white' ? ' on' : '')
        + '" data-ink="' + c[0] + '" style="background:' + c[0]
        + '" aria-label="' + c[1] + '色区域" title="' + c[1] + '色 · 按颜色点名"></button>').join('')
      + '</span>'
      + '<button type="button" class="ghost mini" data-a="undo" title="撤掉上一步（Ctrl+Z）">撤一步</button>'
      + '<button type="button" class="ghost mini" data-a="clearink" title="只擦当前颜色">清此色</button>'
      + '<button type="button" class="ghost mini" data-a="clear">清空</button>'
      + '<span class="rv-hint">彩色＝要改，黑＝不动</span>'
      + '<span style="flex:1"></span>'
      + '<button type="button" class="pri mini" data-a="done">✓ 完成</button>'
      + '<button type="button" class="ghost mini" data-a="exit" title="退出绘画（有改动先问）">✕</button>';
    var cv = document.createElement('canvas');
    cv.className = 'lb-mask-cv';
    var ghost = document.createElement('div');
    ghost.className = 'rv-ghost';
    var st = { tool: 'browse', w: 1, ink: 'white', drawing: false, last: null, dirty: false };
    var undoStack = [];
    var ctx = cv.getContext('2d');
    var lw = () => Math.max(2, BRUSH[st.w][0] * Math.min(cv.width, cv.height));

    function fitMask() {
      var ir = img.getBoundingClientRect();
      var sr = stage.getBoundingClientRect();
      cv.style.left = (ir.left - sr.left) + 'px';
      cv.style.top = (ir.top - sr.top) + 'px';
      cv.style.width = ir.width + 'px';
      cv.style.height = ir.height + 'px';
      cv.width = Math.round(img.naturalWidth) || 1;
      cv.height = Math.round(img.naturalHeight) || 1;
    }

    function posOf(e) {
      var r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * (cv.width / Math.max(1, r.width)),
              (e.clientY - r.top) * (cv.height / Math.max(1, r.height))];
    }
    function strokeTo(p) {
      ctx.globalCompositeOperation = st.tool === 'erase' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = st.ink;
      ctx.lineWidth = lw();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(st.last[0], st.last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      st.last = p; st.dirty = true;
    }
    function pushUndo() {
      try { undoStack.push(cv.toDataURL('image/png')); if (undoStack.length > UNDO_MAX) undoStack.shift(); } catch (e) { /* 编不出快照就不入栈 */ }
    }
    function undoMask() {
      var prev = undoStack.pop();
      if (!prev) { if (window.Toast && Toast.err) Toast.err('没有可撤的了'); return; }
      var im = new Image();
      im.onload = () => { ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(im, 0, 0); };
      im.src = prev; st.dirty = true;
    }
    function clearInk() {
      pushUndo();
      try {
        var rgb = inkRgb(st.ink);
        var im = ctx.getImageData(0, 0, cv.width, cv.height), px = im.data;
        for (var i = 0; i < px.length; i += 4) {
          if (px[i + 3] > 0 && Math.abs(px[i] - rgb[0]) < 60 && Math.abs(px[i + 1] - rgb[1]) < 60 && Math.abs(px[i + 2] - rgb[2]) < 60) px[i + 3] = 0;
        }
        ctx.putImageData(im, 0, 0); st.dirty = true;
      } catch (e) { undoStack.pop(); }
    }
    function moveGhost(e) {
      var d = lw() * (cv.getBoundingClientRect().width / Math.max(1, cv.width));
      var r = cv.getBoundingClientRect();
      ghost.style.width = d + 'px'; ghost.style.height = d + 'px';
      ghost.style.left = (e.clientX - r.left - d / 2) + 'px';
      ghost.style.top = (e.clientY - r.top - d / 2) + 'px';
      ghost.style.borderColor = st.ink;
      ghost.classList.toggle('erase', st.tool === 'erase');
    }

    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0 || st.tool === 'browse') return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 有的指针不给捕获 / 已释放 */ }
      pushUndo(); st.drawing = true; st.last = posOf(e); st.dirty = true;
      strokeTo([st.last[0] + 0.01, st.last[1] + 0.01]);
    });
    cv.addEventListener('pointermove', e => { moveGhost(e); if (st.drawing) strokeTo(posOf(e)); });
    cv.addEventListener('pointerleave', () => { ghost.style.display = 'none'; });
    cv.addEventListener('pointerenter', e => { moveGhost(e); if (st.tool !== 'browse') ghost.style.display = 'block'; });
    var stop = e => { if (!st.drawing) return; st.drawing = false; try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* 有的指针不给捕获 / 已释放 */ } };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);

    function paintToggles() {
      bar.querySelectorAll('[data-t],[data-ink]').forEach(x => x.setAttribute('aria-pressed', x.classList.contains('on') ? 'true' : 'false'));
    }
    var onKey = e => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'z' && e.key !== 'Z')) return;
      e.preventDefault(); e.stopPropagation(); undoMask();
    };
    dlg.addEventListener('keydown', onKey, true);

    bar.onclick = e => {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.t) {
        st.tool = b.dataset.t;
        bar.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x === b));
        paintToggles();
        ghost.style.display = st.tool === 'browse' ? 'none' : 'block';
      } else if (b.dataset.ink) {
        st.ink = b.dataset.ink;
        if (st.tool === 'browse') { st.tool = 'brush'; bar.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x.dataset.t === 'brush')); }
        bar.querySelectorAll('[data-ink]').forEach(x => x.classList.toggle('on', x === b));
        paintToggles();
      } else if (b.dataset.w != null) {
        st.w = Number(b.dataset.w);
        bar.querySelectorAll('[data-w]').forEach(x => x.classList.toggle('on', x === b));
      } else if (b.dataset.a === 'undo') { undoMask();
      } else if (b.dataset.a === 'clearink') { clearInk();
      } else if (b.dataset.a === 'clear') {
        pushUndo(); ctx.clearRect(0, 0, cv.width, cv.height); st.dirty = true;
      } else if (b.dataset.a === 'done') {
        var url = st.dirty ? (hasStroke(cv) ? flatten() : '') : null;
        maskDone(url);   // null = 没动（回显现状），'' = 存空，非空 = 新掩码
      } else if (b.dataset.a === 'exit') {
        if (st.dirty && window.Confirm && Confirm.ask) {
          Confirm.ask({ title: '丢弃这次的标记？', body: '还没点「完成」，这次画的会全部丢掉。', okLabel: '丢弃', danger: true })
            .then(yes => { if (yes) finishUi(); });
          return;
        }
        finishUi();
      }
    };
    function flatten() {
      var out = document.createElement('canvas');
      out.width = cv.width; out.height = cv.height;
      var og = out.getContext('2d');
      og.fillStyle = 'black';
      og.fillRect(0, 0, out.width, out.height);
      og.drawImage(cv, 0, 0);
      return out.toDataURL('image/png');
    }
    /* 编辑层收掉 / 回显的共同出口在模块级（maskDone 与 LbMask.exit 都够得着 cur），这里只装配 */

    stage.style.position = 'relative';
    stage.appendChild(cv);
    stage.appendChild(ghost);
    stage.parentElement.insertBefore(bar, stage.nextSibling);
    fitMask();
    /* stage 被灯箱清空（关掉 / 翻页重画）时画布会一起脱链：监听趁还在时自清，不留悬空引用 */
    var mo = new MutationObserver(() => { if (cur && !cv.isConnected) cleanupCur(); });
    mo.observe(stage, { childList: true });
    cur = { cv, ctx, ghost, bar, st, undoStack, onKey, dlg, onSave, img, stage, mo, onExitFx: o.onExit || null };
    /* 上一版掩码先画回画布：编辑从旧笔画接着画；undo 栈此刻起也可撤回旧版 */
    if (o.existing) {
      maskAlphaLayer(o.existing, false, layer => {
        if (!layer || !cur) return;
        ctx.drawImage(layer, 0, 0, cv.width, cv.height);
      });
    }
  }

  function maskDone(url) {
    if (!cur) return;
    var cb = cur.onSave;
    var cv = cur.cv;
    if (url != null && cb) cb(url);                 // '' = 存空（清掉），非空 = 新掩码
    if (url) { echoFrom(url); return; }
    if (hasStroke(cv)) { echoFrom(flattenInCur()); return; }   // 没动过但有旧笔画：回显现状
    finishUi();                                     // 空画布上点 ✓：等于退出
  }
  function flattenInCur() {
    if (!cur) return '';
    var cv = cur.cv;
    var out = document.createElement('canvas');
    out.width = cv.width; out.height = cv.height;
    var og = out.getContext('2d');
    og.fillStyle = 'black';
    og.fillRect(0, 0, out.width, out.height);
    og.drawImage(cv, 0, 0);
    return out.toDataURL('image/png');
  }
  /* 监听、观察器、cur 都清；返回 onExit 给调用链接「重新回显旧掩码」 */
  function cleanupCur() {
    if (!cur) return null;
    var fx = cur.onExitFx;
    try { cur.dlg.removeEventListener('keydown', cur.onKey, true); } catch (e) { /* 弹窗已不在就没什么可摘 */ }
    try { if (cur.mo) cur.mo.disconnect(); } catch (e) { /* 观察器已断就不再断一次 */ }
    cur = null;
    return fx;
  }
  /* ✕ / 丢弃之后的收尾：编辑层整个收掉，onExit 让调用方把已存掩码的回显画回来 */
  function finishUi() {
    if (!cur) return;
    var fx = cur.onExitFx;
    if (cur.bar && cur.bar.parentElement) cur.bar.remove();
    if (cur.cv && cur.cv.parentElement) cur.cv.remove();
    if (cur.ghost && cur.ghost.parentElement) cur.ghost.remove();
    cleanupCur();
    if (fx) fx();
  }
  /* ✓ 之后的常驻回显：编辑层收走，换一枚半透明、黑底抠掉的回显层留在图上 */
  function echoFrom(pngUrl) {
    if (!cur) return;
    if (cur.bar && cur.bar.parentElement) cur.bar.remove();
    if (cur.ghost && cur.ghost.parentElement) cur.ghost.remove();
    if (cur.cv && cur.cv.parentElement) cur.cv.remove();
    cleanupCur();
    echo(pngUrl);
  }

  function exit() {
    if (!cur) return;
    if (cur.bar && cur.bar.parentElement) cur.bar.remove();
    if (cur.cv && cur.cv.parentElement) cur.cv.remove();
    if (cur.ghost && cur.ghost.parentElement) cur.ghost.remove();
    cleanupCur();
  }

  window.LbMask = {
    enter: function (fn, opts) { enter(fn, opts); },
    exit: function () { exit(); },
    echo: function (url) { echo(url); },
    isActive: function () { return !!cur; },
  };
})();
