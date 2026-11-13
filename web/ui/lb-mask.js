/* LbMask — 在已打开的灯箱（Wb.lightbox）上叠一层掩码绘画。
   调用方先 Wb.lightbox.open({src,…}) 打开一张图片，再 LbMask.enter(onSaveMask) 进入绘画。
   「✓ 完成」把掩码 PNG 交回 onSaveMask 并退回灯箱普通查看（掩码红影留在图上）；
   「✕ 退出」有改动先问丢弃。Esc 同 ✕。
   按需补载（__spaLoadScript），不进 shell 常驻。 */
(function () {
  var BRUSH = [[0.006, '极细'], [0.012, '细'], [0.025, '中'], [0.05, '粗']];
  var INK = [
    ['white', '白'], ['red', '红'], ['green', '绿'],
    ['blue', '蓝'], ['yellow', '黄'], ['cyan', '青'],
  ];
  var UNDO_MAX = 12;
  var cur = null;   // { cv, ctx, ghost, bar, st, undoStack, onKey, dlg, onSave, img }

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

  function enter(onSave) {
    exit();
    var stage = document.getElementById('lbStage');
    var img = stage ? stage.querySelector('img') : null;
    if (!img || !img.naturalWidth) {
      if (window.Toast && Toast.err) Toast.err('先等图片加载完再画');
      return;
    }
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
        maskDone(url);   // null = 没动，调用方自行判断
      } else if (b.dataset.a === 'exit') {
        if (st.dirty && window.Confirm && Confirm.ask) {
          Confirm.ask({ title: '丢弃这次的标记？', body: '还没点「完成」，这次画的会全部丢掉。', okLabel: '丢弃', danger: true })
            .then(yes => { if (yes) removeMaskUi(); });
          return;
        }
        removeMaskUi();
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
    function removeMaskUi() {
      dlg.removeEventListener('keydown', onKey, true);
      if (bar.parentElement) bar.remove();
      if (cv.parentElement) cv.remove();
      if (ghost.parentElement) ghost.remove();
      cur = null;
    }

    stage.style.position = 'relative';
    stage.appendChild(cv);
    stage.appendChild(ghost);
    stage.parentElement.insertBefore(bar, stage.nextSibling);
    fitMask();
    cur = { cv, ctx, ghost, bar, st, undoStack, onKey, dlg, onSave, removeMaskUi, img, stage };
  }

  function maskDone(url) {
    if (!cur) return;
    var cb = cur.onSave;
    cur.removeMaskUi();
    cur = null;
    if (cb && url != null) cb(url);
  }

  function exit() {
    if (!cur) return;
    cur.removeMaskUi();
    cur = null;
  }

  window.LbMask = {
    enter: function (fn) { enter(fn); },
    exit: function () { exit(); },
    isActive: function () { return !!cur; },
  };
})();
