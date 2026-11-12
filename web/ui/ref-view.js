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
  var TOOLS = [['browse', '浏览'], ['brush', '画笔'], ['erase', '橡皮']];
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

  /* 掩码编辑（灯箱式单层）：打开即大图 + 常驻工具条；「浏览」档只看不画，
     画笔 / 橡皮直接落在图上。hooks：
       save(url|null) —— 完成 / 清除掩码：存回条目并由弹窗层关窗（null = 清掉已存掩码）；
       exit() —— 没动过：直接关；
       askLeave() —— 有改动没完成：先问「丢弃？」再关；
       setEditing(on) / ctl(c) / setKeyOff(fn) —— 与弹窗层的 Esc 拦截、Ctrl+Z 摘除对接。 */
  function openMaskEditor(stage, item, hooks) {
    var img = stage.querySelector('img');
    var dlg = stage.closest('dialog');
    var bar = document.createElement('div');
    bar.className = 'rv-bar is-edit';
    bar.innerHTML =
      '<span class="rv-tools" role="group">'
      + TOOLS.map(tl => '<button type="button" class="ghost mini' + (tl[0] === 'browse' ? ' on' : '')
        + '" data-tool="' + tl[0] + '" aria-pressed="' + (tl[0] === 'browse') + '">' + tl[1] + '</button>').join('')
      + '</span>'
      + '<span class="rv-tools" role="group">'
      + BRUSH.map((b, i) => '<button type="button" class="ghost mini' + (i === 1 ? ' on' : '') + '" data-w="' + i + '">' + b[1] + '</button>').join('')
      + '</span>'
      + '<span class="rv-tools" role="group">'
      + INK.map(c => '<button type="button" class="rv-swatch' + (c[0] === 'white' ? ' on' : '')
        + '" data-ink="' + c[0] + '" style="background:' + c[0]
        + '" aria-label="' + c[1] + '色区域" title="' + c[1] + '色区域 · 按颜色点名"></button>').join('')
      + '</span>'
      + '<button type="button" class="ghost mini" data-act="undo" title="撤掉上一步（Ctrl+Z）">撤一步</button>'
      + '<button type="button" class="ghost mini" data-act="clearink" title="只擦掉当前颜色的笔迹">清此色</button>'
      + '<button type="button" class="ghost mini" data-act="clear">清空</button>'
      + '<span class="rv-hint">浏览=只看 · 彩色＝要改，黑＝不动</span>'
      + '<span class="sp" style="flex:1"></span>'
      + '<button type="button" class="pri mini" data-act="done">✓ 完成</button>'
      + '<button type="button" class="ghost mini" data-act="close" title="关闭（有改动会先问）">✕</button>';
    var cv = document.createElement('canvas');
    cv.className = 'rv-draw';
    var ov = document.createElement('canvas');
    ov.className = 'rv-maskview';
    var ghost = document.createElement('div');
    ghost.className = 'rv-ghost';
    var state = { tool: 'browse', w: 1, ink: 'white', drawing: false, dirty: false, primed: false };
    var undoStack = [];
    var ctx = cv.getContext('2d');
    if (hooks.setEditing) hooks.setEditing(true);

    function fitCanvas() {
      var iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
      var size = maskCanvasSize(iw, ih);
      var prev = state.primed ? cv.toDataURL() : '';
      cv.width = size[0]; cv.height = size[1];
      ov.width = cv.width; ov.height = cv.height;
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
      ctx.lineWidth = lw;
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
    /* 只擦当前颜色：分色区域的自然手势（抗锯齿边缘按色距 <60 一并清）。 */
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
    /* 覆盖层（已存掩码的红影）只在浏览档显示；画笔 / 橡皮时藏掉，自己的笔迹才看得清。 */
    function syncOverlay() {
      ov.style.display = (state.tool === 'browse' && item.mask) ? '' : 'none';
      ghost.style.display = state.tool === 'browse' ? 'none' : 'block';
    }

    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0 || state.tool === 'browse') return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 有的指针不给捕获，照画 */ }
      pushUndo();
      state.drawing = true; state.last = posOf(e); state.dirty = true;
      strokeTo([state.last[0] + 0.01, state.last[1] + 0.01]);
    });
    cv.addEventListener('pointermove', e => { moveGhost(e); if (state.drawing) strokeTo(posOf(e)); });
    cv.addEventListener('pointerenter', e => { moveGhost(e); if (state.tool !== 'browse') ghost.style.display = 'block'; });
    cv.addEventListener('pointerleave', () => { ghost.style.display = 'none'; });
    var stop = e => {
      if (!state.drawing) return;
      state.drawing = false;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* 指针已经没了就算了 */ }
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);

    function paintToggles() {
      bar.querySelectorAll('[data-tool],[data-ink]').forEach(x => {
        var on = x.classList.contains('on');
        if (x.hasAttribute('aria-pressed')) x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    var onKey = e => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'z' && e.key !== 'Z')) return;
      e.preventDefault();
      e.stopPropagation();
      undoStep();
    };
    if (dlg) dlg.addEventListener('keydown', onKey, true);
    if (hooks.setKeyOff) hooks.setKeyOff(() => { if (dlg) dlg.removeEventListener('keydown', onKey, true); });
    if (hooks.ctl) hooks.ctl({ dirty: () => state.dirty, leave });
    function leave() {
      if (state.dirty && hooks.askLeave) { hooks.askLeave(); return; }
      hooks.exit();
    }

    bar.onclick = e => {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) {
        state.tool = b.dataset.tool;
        bar.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b));
        paintToggles();
        syncOverlay();
      } else if (b.dataset.ink) {
        state.ink = b.dataset.ink;
        if (state.tool === 'browse') {
          state.tool = 'brush';   // 选颜色 = 要画了：从浏览直接切画笔
          bar.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x.dataset.tool === 'brush'));
          syncOverlay();
        }
        bar.querySelectorAll('[data-ink]').forEach(x => x.classList.toggle('on', x === b));
        paintToggles();
      } else if (b.dataset.w != null) {
        state.w = Number(b.dataset.w);
        bar.querySelectorAll('[data-w]').forEach(x => x.classList.toggle('on', x === b));
      } else if (b.dataset.act === 'undo') {
        undoStep();
      } else if (b.dataset.act === 'clearink') {
        clearInk();
      } else if (b.dataset.act === 'clear') {
        pushUndo();
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, cv.width, cv.height);
        state.dirty = true;
      } else if (b.dataset.act === 'dropmask') {
        pushUndo();
        ctx.clearRect(0, 0, cv.width, cv.height);
        state.dirty = true;   // 保存统一走「完成」（item.mask 在那时一并更新）
      } else if (b.dataset.act === 'done') {
        commitMask(state.dirty ? (hasStroke(cv) ? flatten() : '') : 'keep');
      } else if (b.dataset.act === 'close') {
        leave();
      }
    };
    function commitMask(url) {
      if (hooks.setEditing) hooks.setEditing(false);
      hooks.save(url);   // url: dataURL = 存；'' = 清空；'keep' = 没动过（调用方直接关）
    }
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
    stage.appendChild(ov);
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

    /* 灯箱式：打开即大图 / 播放器，工具条常驻在底部（没有「先看再进编辑」的第二层）。
       图片默认「浏览」档只看不画；「完成」把掩码存回条目并关窗；Esc / ✕ 在有改动时先问丢弃。 */
    function viewBody(box, close) {
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
      bar.className = 'rv-bar is-edit';
      var info = document.createElement('div');
      info.className = 'rv-info';
      info.innerHTML = infoLine();
      box.appendChild(stage); box.appendChild(bar); box.appendChild(info);

      /* Esc：有改动先问丢弃，没改动直接关（UiDialog 自己的 cancel 在 body 之后挂，这里先拦）。 */
      if (dlg.__rvCancel) dlg.removeEventListener('cancel', dlg.__rvCancel);
      dlg.__rvCancel = e => {
        if (editing && editorCtl) {
          e.preventDefault();
          e.stopImmediatePropagation();
          editorCtl.leave();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      };
      dlg.addEventListener('cancel', dlg.__rvCancel);

      if (kind !== 'image') {
        bar.innerHTML = '<span class="rv-hint">只读预览</span>'
          + '<span class="sp" style="flex:1"></span>'
          + '<button type="button" class="ghost mini" data-act="close">✕ 关闭</button>';
        bar.onclick = e => { if (e.target.closest('[data-act="close"]')) close(); };
        return;
      }

      /* 图片：等解码真的到手（naturalWidth > 0）再进编辑器 —— fitCanvas 按真实尺寸定画布，
         解码没完成就定尺寸会得到 1×1 画布（一笔涂满全图，掩码整条坏）。加载中先给一句提示。 */
      bar.innerHTML = '<span class="rv-hint">加载中…</span>';
      var img = stage.querySelector('img');
      img.src = item.src;
      var closeNow = () => close(true);
      img.addEventListener('load', () => {
        bar.innerHTML = '<span class="rv-hint">浏览 = 只看；画笔直接画</span>';
        openMaskEditor(stage, item, {
          /* 编辑器回给弹窗层的钩子：save = 完成（dataURL 存 / '' 清 / 'keep' 没动过直接关）。 */
          save(url) {
            if (url !== 'keep') {
              item.mask = url || '';
              if (opts.onSaveMask) opts.onSaveMask(url || null);
            }
            closeNow();
          },
          exit() { closeNow(); },
          askLeave() {
            window.Confirm.ask({
              title: '丢弃这次的标记？',
              body: '还没点「完成」，这次画的会全部丢掉。',
              okLabel: '丢弃', danger: true,
            }).then(yes => { if (yes) closeNow(); });
          },
          setEditing(on) { editing = on; },
          ctl(c) { editorCtl = c; },
          setKeyOff(f) { editorKeyOff = f; },
        });
      }, { once: true });
      img.addEventListener('error', () => {
        stage.innerHTML = '<div class="rv-none">这一份素材的地址读不出来（可能已过期）。</div>';
        bar.innerHTML = '<span class="rv-hint">读不出来，关窗重挑一份</span>';
      }, { once: true });
    }

    window.UiDialog.open({
      id: 'rvDlg',
      title: '查看素材',
      sub: item.label || '',
      body: (box, close) => { viewBody(box, close); },
      actions: [],
    });
  }

  window.RefView = { open: rvOpen, KIND_ZH: KIND_ZH };
})();
