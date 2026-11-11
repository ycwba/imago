/* RefView — 参考框里那份素材的「点开看」弹窗（图片 / 视频 / 声音），图片可以在上面画掩码。
   各页的参考框（建模台右栏、工作台素材槽、助手附件）都只有一颗小 × 删得掉东西，
   本体点了没反应；这一份给「看」一个统一出口，顺带把「图上标记要改的区域」做掉 ——
   画出来的是一张彩笔掩码（PNG），页面把它挂回素材条目上，随图一起发给文字 AI。
   只依赖常驻的 UiDialog / Confirm / Toast；本文件按需补载（__spaLoadScript），不进 shell 常驻。

   RefView.open(item, opts)
     item = { kind:'image'|'video'|'audio', label, src, mask? }   mask = 彩笔掩码 dataURL（可无）
     opts = { onSaveMask(url|null), meta }                        meta 是信息行里追加的一段
   掩码语义（发给 AI 时也是这一句）：黑 = 其余部分不动；彩色笔画标出要局部编辑 / 重点看的区域，
   每种颜色是一个独立的区域，用户在提示词里按颜色点名（「红色那块改成草地」）。
   onSaveMask 的 url：dataURL = 存了新掩码；'' = 全擦掉了（清空）；null 只在「返回」时出现 ——
   页面侧统一「空串 / null 都算清掉」，这一层保证不把一次没动的编辑当成清空。 */
(function () {
  var KIND_ZH = { image: '图片', video: '视频', audio: '声音' };
  /* 掩码画布的最长边：与发给文字 AI 前那一道压缩同档，画布太大只会让笔迹变细。 */
  var MASK_EDGE = 1024;
  var BRUSH = [[0.006, '极细'], [0.012, '细'], [0.025, '中'], [0.05, '粗']];
  /* 掩码的六支笔：颜色是给 AI 的区域标记，提示词里按中文名点名。全用 CSS 颜色名，
     与画布导出 / 回显读到的像素一一对应。 */
  var INK = [
    ['white', '白'], ['red', '红'], ['green', '绿'],
    ['blue', '蓝'], ['yellow', '黄'], ['cyan', '青'],
  ];
  /* 编辑器的撤销栈上限：每步存一张 PNG 快照（稀疏笔迹很小），12 步足够回悔一整轮。 */
  var UNDO_MAX = 12;

  function rvEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function themeColor(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  /* 把彩笔掩码画成半透明覆盖层（只用于「看」，导出仍是彩笔原样）：
     黑底转透明（亮度当 alpha）、彩色笔画保本色，白色笔画染成主题红 ——
     白是「默认要改」的那支，染红才在浅色图上看得见，其余颜色按用户画的显示。
     画布 buffer 乘 devicePixelRatio：CSS 尺寸不变，高分屏上掩码回显不发虚。 */
  function paintOverlay(canvas, maskUrl) {
    var img = new Image();
    img.onload = () => {
      var box = canvas.parentElement;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = Math.max(1, Math.round(((box && box.clientWidth) || 320) * dpr));
      var h = Math.max(1, Math.round(((box && box.clientHeight) || 180) * dpr));
      canvas.width = w; canvas.height = h;
      var g = canvas.getContext('2d');
      g.clearRect(0, 0, w, h);
      try { g.drawImage(img, 0, 0, w, h); } catch (e) { return; }
      try {
        var tint = document.createElement('canvas'); tint.width = tint.height = 1;
        var tg = tint.getContext('2d');
        tg.fillStyle = themeColor('--err', 'red'); tg.fillRect(0, 0, 1, 1);
        var er = tg.getImageData(0, 0, 1, 1).data;
        var d = g.getImageData(0, 0, w, h), px = d.data;
        for (var i = 0; i < px.length; i += 4) {
          if (px[i] > 216 && px[i + 1] > 216 && px[i + 2] > 216) {
            px[i] = er[0]; px[i + 1] = er[1]; px[i + 2] = er[2];
          }
          px[i + 3] = Math.max(px[i], px[i + 1], px[i + 2]);
        }
        g.putImageData(d, 0, 0);
      } catch (e) { /* 跨源画布读不了像素：退回整层半透明原样叠 */ }
      canvas.style.opacity = '0.62';
    };
    img.src = maskUrl;
  }

  function maskCanvasSize(iw, ih) {
    var scale = Math.min(1, MASK_EDGE / Math.max(iw || 1, ih || 1));
    return [Math.max(1, Math.round((iw || 1) * scale)), Math.max(1, Math.round((ih || 1) * scale))];
  }

  /* 画布上有没有真笔画过：全透明的画布不该导出成一张全黑掩码（那等于告诉 AI「哪里都别改」）。 */
  function hasStroke(c) {
    try {
      var g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (var i = 3; i < g.length; i += 28) { if (g[i] > 8) return true; }
    } catch (e) { return true; }   // 读不出像素（跨源画布）时宁可当成「画过」
    return false;
  }

  function inkRgb(name) {
    var t = document.createElement('canvas'); t.width = t.height = 1;
    var tg = t.getContext('2d');
    tg.fillStyle = name; tg.fillRect(0, 0, 1, 1);
    var d = tg.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  /* 掩码编辑态：彩笔画在透明画布上，橡皮 destination-out；导出时垫一层黑底。
     hooks = { setEditing(on), ctl(c), setKeyOff(fn), exit(), askLeave() }：
       setEditing —— 弹窗脚上的「关闭」在编辑中藏起来（丢工作只留 rv-bar 那两条路）；
       ctl —— 把「脏没脏 / 怎么退」交回弹窗层（Esc 在那里截）；
       setKeyOff —— 编辑器的 Ctrl+Z 挂在弹窗上，退场由 applyMask 经它摘除；
       exit —— 不问直接退回看图态（没画过的「返回 / Esc」走它）；
       askLeave —— 画过但没「完成」时先问一句「丢弃？」再退。 */
  function openMaskEditor(stage, item, done, hooks) {
    var img = stage.querySelector('img');
    var dlg = stage.closest('dialog');
    var bar = document.createElement('div');
    bar.className = 'rv-bar is-edit';
    bar.innerHTML =
      '<span class="rv-tools" role="group">'
      + '<button type="button" class="ghost mini on" data-tool="brush" aria-pressed="true">画笔</button>'
      + '<button type="button" class="ghost mini" data-tool="erase" aria-pressed="false">橡皮</button></span>'
      + '<span class="rv-tools" role="group">'
      + BRUSH.map((b, i) => '<button type="button" class="ghost mini' + (i === 1 ? ' on' : '') + '" aria-pressed="' + (i === 1) + '" data-w="' + i + '">' + b[1] + '</button>').join('')
      + '</span>'
      + '<span class="rv-tools" role="group">'
      + INK.map((c, i) => '<button type="button" class="rv-swatch' + (i === 0 ? ' on' : '') + '" aria-pressed="' + (i === 0)
        + '" data-ink="' + c[0] + '" style="background:' + c[0]
        + '" aria-label="' + c[1] + '色区域" title="' + c[1] + '色区域 · 按颜色点名"></button>').join('')
      + '</span>'
      + '<button type="button" class="ghost mini" data-act="undo"' + ' title="撤掉上一步（Ctrl+Z）">撤一步</button>'
      + '<button type="button" class="ghost mini" data-act="clearink" title="只擦掉当前颜色的笔迹">清此色</button>'
      + '<button type="button" class="ghost mini" data-act="clear">清空</button>'
      + '<span class="rv-hint">彩色＝要改，黑＝不动</span>'
      + '<span class="sp" style="flex:1"></span>'
      + '<button type="button" class="pri mini" data-act="done">完成</button>'
      + '<button type="button" class="ghost mini" data-act="back">返回</button>';
    var cv = document.createElement('canvas');
    cv.className = 'rv-draw';
    var ghost = document.createElement('div');
    ghost.className = 'rv-ghost';
    var state = { tool: 'brush', w: 1, ink: 'white', drawing: false, dirty: false, primed: false };
    var undoStack = [];
    var ctx = cv.getContext('2d');
    if (hooks && typeof hooks.setEditing === 'function') hooks.setEditing(true);

    function fitCanvas() {
      var iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
      var size = maskCanvasSize(iw, ih);
      var prev = state.primed ? cv.toDataURL() : '';
      cv.width = size[0]; cv.height = size[1];
      if (prev) {
        var old = new Image();
        old.onload = () => { ctx.drawImage(old, 0, 0, cv.width, cv.height); };
        old.src = prev;
      }
      state.primed = true;
    }

    function posOf(e) {
      var r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * (cv.width / Math.max(1, r.width)),
              (e.clientY - r.top) * (cv.height / Math.max(1, r.height))];
    }
    function strokeTo(p) {
      var lw = Math.max(2, BRUSH[state.w][0] * Math.min(cv.width, cv.height));
      ctx.globalCompositeOperation = state.tool === 'erase' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = state.ink;
      ctx.lineWidth = Math.max(2, lw);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(state.last[0], state.last[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      state.last = p;
      state.dirty = true;
    }
    function pushUndo() {
      try {
        undoStack.push(cv.toDataURL('image/png'));
        if (undoStack.length > UNDO_MAX) undoStack.shift();
      } catch (e) { /* 编不出快照（跨源）就没有这一步撤销 */ }
    }
    function undoStep() {
      var prev = undoStack.pop();
      if (!prev) { if (window.Toast && Toast.err) Toast.err('没有可撤的了'); return; }
      var im = new Image();
      im.onload = () => {
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.drawImage(im, 0, 0);
      };
      im.src = prev;
      state.dirty = true;
    }
    /* 只擦当前颜色：掩码语义是分色区域，「这一色不要了」是自然手势。
       抗锯齿的边缘按色距 <60 一并清掉。 */
    function clearInk() {
      pushUndo();
      try {
        var rgb = inkRgb(state.ink);
        var im = ctx.getImageData(0, 0, cv.width, cv.height);
        var px = im.data;
        for (var i = 0; i < px.length; i += 4) {
          if (px[i + 3] > 0
            && Math.abs(px[i] - rgb[0]) < 60 && Math.abs(px[i + 1] - rgb[1]) < 60 && Math.abs(px[i + 2] - rgb[2]) < 60) {
            px[i + 3] = 0;
          }
        }
        ctx.putImageData(im, 0, 0);
        state.dirty = true;
      } catch (e) {
        undoStack.pop();
        if (window.Toast && Toast.err) Toast.err('这一笔读不出来，清不了');
      }
    }
    /* 自绘光标：圆圈直径 = 笔迹直径的屏幕尺寸，画笔显当前色、橡皮虚线 —— 不用猜会画多大。 */
    function moveGhost(e) {
      var lw = Math.max(2, BRUSH[state.w][0] * Math.min(cv.width, cv.height));
      var r = cv.getBoundingClientRect();
      var d = lw * (r.width / Math.max(1, cv.width));
      ghost.style.width = d + 'px';
      ghost.style.height = d + 'px';
      ghost.style.left = (e.clientX - r.left - d / 2) + 'px';
      ghost.style.top = (e.clientY - r.top - d / 2) + 'px';
      ghost.style.borderColor = state.ink;
      ghost.classList.toggle('erase', state.tool === 'erase');
    }

    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 有的指针不给捕获，照画 */ }
      pushUndo();
      state.drawing = true; state.last = posOf(e); state.dirty = true;
      strokeTo([state.last[0] + 0.01, state.last[1] + 0.01]);
    });
    cv.addEventListener('pointermove', e => { moveGhost(e); if (state.drawing) strokeTo(posOf(e)); });
    cv.addEventListener('pointerenter', e => { ghost.style.display = 'block'; moveGhost(e); });
    cv.addEventListener('pointerleave', () => { ghost.style.display = 'none'; });
    var stop = e => {
      if (!state.drawing) return;
      state.drawing = false;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* 指针已经没了就算了 */ }
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);

    function paintToggles() {
      bar.querySelectorAll('[data-tool],[data-w],[data-ink]').forEach(x => {
        var on = x.classList.contains('on');
        if (x.hasAttribute('aria-pressed')) x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    /* 编辑器退场前摘掉自己的 Ctrl+Z（挂在弹窗上，不摘会留在下一轮编辑里）。 */
    var onKey = e => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'z' && e.key !== 'Z')) return;
      e.preventDefault();
      e.stopPropagation();
      undoStep();
    };
    if (dlg) dlg.addEventListener('keydown', onKey, true);
    if (hooks && typeof hooks.ctl === 'function') hooks.ctl({ dirty: () => state.dirty, leave });
    if (hooks && typeof hooks.setKeyOff === 'function') {
      hooks.setKeyOff(() => { if (dlg) dlg.removeEventListener('keydown', onKey, true); });
    }
    function closeEdit(v) {
      done(v);
    }
    function leave() {
      /* 画过但没「完成」：先问一句再丢（返回 / Esc / 关闭三条路都走这里）。 */
      if (state.dirty && hooks && typeof hooks.askLeave === 'function') { hooks.askLeave(); return; }
      closeEdit(null);
    }

    bar.onclick = e => {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) {
        state.tool = b.dataset.tool;
        bar.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b));
        paintToggles();
      } else if (b.dataset.ink) {
        state.ink = b.dataset.ink;
        if (state.tool === 'erase') {   // 选颜色 = 要画了：自动从橡皮切回画笔
          state.tool = 'brush';
          bar.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x.dataset.tool === 'brush'));
        }
        bar.querySelectorAll('[data-ink]').forEach(x => x.classList.toggle('on', x === b));
        paintToggles();
      } else if (b.dataset.w != null) {
        state.w = Number(b.dataset.w);
        bar.querySelectorAll('[data-w]').forEach(x => x.classList.toggle('on', x === b));
        paintToggles();
      } else if (b.dataset.act === 'undo') {
        undoStep();
      } else if (b.dataset.act === 'clearink') {
        clearInk();
      } else if (b.dataset.act === 'clear') {
        pushUndo();
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, cv.width, cv.height);
        state.dirty = true;
      } else if (b.dataset.act === 'done') {
        if (!state.dirty) { closeEdit(null); return; }
        closeEdit(hasStroke(cv) ? flatten() : '');
      } else if (b.dataset.act === 'back') {
        leave();
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

    stage.innerHTML = '';
    stage.appendChild(img);
    stage.appendChild(cv);
    stage.appendChild(ghost);
    stage.parentElement.insertBefore(bar, stage.nextSibling);
    fitCanvas();
    if (item.mask) {
      var old = new Image();
      old.onload = () => { if (!state.dirty) ctx.drawImage(old, 0, 0, cv.width, cv.height); };
      old.src = item.mask;
    }
  }

  function rvOpen(item, opts) {
    opts = opts || {};
    if (!item || !item.src) return;
    var kind = item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : 'image';
    var canMask = kind === 'image' && typeof opts.onSaveMask === 'function';
    var editing = false, editorCtl = null, editorKeyOff = null;

    function infoLine() {
      var bits = [KIND_ZH[kind], item.label || ''];
      if (opts.meta) bits.push(opts.meta);
      if (item.mask) bits.push('已画掩码');
      return bits.filter(Boolean).map(rvEsc).join(' · ');
    }

    function viewBody(box) {
      var dlg = box.closest('dialog');
      var stage = document.createElement('div');
      stage.className = 'rv-stage';
      if (kind === 'video') {
        stage.innerHTML = '<video controls playsinline preload="metadata" src="' + rvEsc(item.src) + '"></video>';
      } else if (kind === 'audio') {
        stage.innerHTML = '<span class="rv-audio"><audio controls preload="metadata" src="' + rvEsc(item.src) + '"></audio></span>';
      } else {
        stage.innerHTML = '<img draggable="false" alt="">'
          + (item.mask ? '<canvas class="rv-maskview"></canvas>' : '');
      }
      var bar = document.createElement('div');
      bar.className = 'rv-bar';
      bar.innerHTML = (canMask
        ? '<button type="button" class="ghost mini" data-act="mask">' + (item.mask ? '改掩码' : '在图上标记要改的区域') + '</button>'
          + (item.mask ? '<button type="button" class="ghost mini" data-act="dropmask">清除掩码</button>' : '')
        : '')
        + '<span class="rv-hint">只看与标记</span>';
      var info = document.createElement('div');
      info.className = 'rv-info';
      info.innerHTML = infoLine();
      box.appendChild(stage); box.appendChild(bar); box.appendChild(info);
      if (kind === 'image') {
        var im = stage.querySelector('img');
        im.src = item.src;
        im.addEventListener('error', () => {
          stage.innerHTML = '<div class="rv-none">这一份素材的地址读不出来（可能已过期）。</div>';
        });
        if (item.mask) paintOverlay(stage.querySelector('.rv-maskview'), item.mask);
      }
      /* body 在 UiDialog 自己的 cancel 监听之前跑：编辑中把 Esc 截下来走「丢弃确认」，
         不让弹窗连工作一起收走；看图态照常放行（Esc = 关窗）。重渲染会再挂一次，
         先摘旧的那一份（闭包里的 box 已经过期）。 */
      if (dlg.__rvCancel) dlg.removeEventListener('cancel', dlg.__rvCancel);
      dlg.__rvCancel = e => {
        if (!editing || !editorCtl) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        editorCtl.leave();
      };
      dlg.addEventListener('cancel', dlg.__rvCancel);
      function applyMask(url) {
        editing = false; editorCtl = null;
        if (editorKeyOff) { editorKeyOff(); editorKeyOff = null; }
        if (dlg) { var f = dlg.querySelector('.pr-foot'); if (f) f.style.display = ''; }
        if (url !== null) {
          item.mask = url || '';
          if (opts.onSaveMask) opts.onSaveMask(url || null);
        }
        box.innerHTML = '';
        viewBody(box);
      }
      bar.onclick = e => {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.act === 'mask') {
          var img0 = stage.querySelector('img');
          /* 图已经读不出来（error 占位把 <img> 换掉了 / 坏图挂着）：没有可画的底，不给进编辑态 ——
             以前这一步会对 null 调 addEventListener 抛错，或给坏图挂一个永远不响的 load。 */
          if (!img0) return;
          if (img0.complete && !img0.naturalWidth) {
            if (window.Toast && Toast.err) Toast.err('这张图读不出来，画不了掩码');
            return;
          }
          bar.remove(); info.remove();
          var enter = () => openMaskEditor(stage, item, applyMask, {
            setEditing(on) {
              editing = on;
              var f = dlg.querySelector('.pr-foot');
              if (f) f.style.display = on ? 'none' : '';
            },
            ctl(c) { editorCtl = c; },
            setKeyOff(f) { editorKeyOff = f; },
            exit: () => applyMask(null),
            askLeave() {
              window.Confirm.ask({
                title: '丢弃这次的标记？',
                body: '还没点「完成」，这次画的会全部丢掉。',
                okLabel: '丢弃', danger: true,
              }).then(yes => { if (yes) applyMask(null); });
            },
          });
          /* 编辑器挂自己的 Ctrl+Z 在弹窗上；进编辑态后如果图才加载出来（或加载失败），照常处理。 */
          if (img0.complete && img0.naturalWidth) enter();
          else {
            img0.addEventListener('load', enter, { once: true });
            img0.addEventListener('error', () => applyMask(null), { once: true });
          }
        } else if (b.dataset.act === 'dropmask') {
          applyMask('');
        }
      };
    }

    window.UiDialog.open({
      id: 'rvDlg',
      title: '查看素材',
      sub: item.label || '',
      body: box => { viewBody(box); },
      actions: [{ label: '关闭', value: true }],
    });
  }

  window.RefView = { open: rvOpen, KIND_ZH: KIND_ZH };
})();
