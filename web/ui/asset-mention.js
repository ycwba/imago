/* 提示词里的 @素材：候选浮层、镜像高亮、悬停小卡、角色资产二级菜单、光标处插入。
   导演台与工作台共用这一份；页面只提供上下文（候选从哪来、选中之后做什么），
   浮层 DOM、键盘、命中与插入都住在这里。

   高亮做法：textarea 自己没法给某几个字上色，所以它下面铺一层**镜像层**（同字号同内边距的副本），
   只给 @片段 画一块底；镜像层的文字一律透明，看得见的还是 textarea 里那行字 ——
   这样中文输入法正在拼的那几个字照旧看得见，不会被镜像层盖住。 */
const MENTION_MAX = 30;

/* 光标前面那一段是不是「正在打一个 @」：是就返回 {start, end, q}，不是返回 null。
   判据只有一条：`@` 前面**不能是字母 / 数字**（那是邮箱 a@b.com 那种），中间不能有空白。
   ⚠ 别把「前面必须是空白或标点」写进来 —— 中文句子本来就不打空格，
   「一个女孩站在@小雅旁边」里 @ 前面是「在」，那样写会让中文环境下**永远弹不出来**。 */
export function mentionAt(ta) {
  if (!ta || ta.selectionStart !== ta.selectionEnd) return null;
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const q = before.slice(at + 1);
  if (q.length > 24 || /[\s\u3000]/.test(q)) return null;
  const prev = at > 0 ? before[at - 1] : '';
  if (prev && /[A-Za-z0-9._%+-]/.test(prev)) return null;
  return { start: at, end: pos, q: q };
}

/* 把 `@名字` 写进提示词：range 给了就替换掉那一段（打字触发时是 `@` 到光标），
   没给就插在当前光标处；前面挨着非空白字符时补一个空格，免得粘成一坨。
   返回插入后的光标位置（重画编辑器之后要还回去）。 */
export function insertToken(ta, token, range) {
  const v = ta.value;
  let s, e;
  if (range) { s = range.start; e = range.end; }
  else if (ta.selectionStart === 0 && ta.selectionEnd === 0 && v && (ta.ownerDocument || document).activeElement !== ta) {
    /* 框**从来没聚焦过**（一进页面就点了 `@ 素材`）：浏览器给的是 0/0，插到开头很怪，
       这种情况接在末尾。已经聚焦过再失焦时 selectionStart 是**上一次的光标位置**，照用。 */
    s = e = v.length;
  } else { s = ta.selectionStart; e = ta.selectionEnd; }
  const before = v.slice(0, s);
  const sep = (before && !/[\s\u3000]$/.test(before)) ? ' ' : '';
  const head = before + sep + token + ' ';
  ta.value = head + v.slice(e);
  return head.length;
}

/* 光标在 textarea 里的像素位置：用一个同款镜像层量（字体 / 内边距 / 行高 / 宽度必须与它一致）。 */
function caretXY(ta, doc, win) {
  const cs = win.getComputedStyle(ta);
  const d = doc.createElement('div');
  d.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow:hidden;'
    + 'border:0;font:' + cs.font + ';padding:' + cs.padding + ';line-height:' + cs.lineHeight
    + ';letter-spacing:' + cs.letterSpacing + ';width:' + ta.clientWidth + 'px;';
  d.textContent = ta.value.slice(0, ta.selectionStart);
  const mark = doc.createElement('span');
  mark.textContent = '\u200b';
  d.appendChild(mark);
  doc.body.appendChild(d);
  const r = ta.getBoundingClientRect();
  const out = { x: r.left + mark.offsetLeft - ta.scrollLeft, y: r.top + mark.offsetTop - ta.scrollTop, h: mark.offsetHeight || 18 };
  d.remove();
  return out;
}

/* 提示词 → 「只给 @片段 画底」的镜像 HTML。不是素材名的 @（邮箱、@某人）不画。 */
function atBackHTML(names, text, esc) {
  const src = String(text == null ? '' : text);
  const re = /(^|[^A-Za-z0-9._%+-])@([^\s\u3000@，。；、,.!?！？：:（）()【\[\]「」『』"']{1,24})/g;
  let out = '', last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    const at = m.index + m[1].length, nm = m[2];
    if (!names.has(nm)) continue;
    out += esc(src.slice(last, at)) + '<span class="ta-at" data-nm="' + esc(nm) + '">@' + esc(nm) + '</span>';
    last = at + 1 + nm.length;
    re.lastIndex = last;
  }
  /* 末尾补一个换行：textarea 最后一行是空行时镜像层的高度才对得上（经典做法）。 */
  return out + esc(src.slice(last)) + '\n';
}

/* 上下文接口（都由调用方给，create 时就位，内部按次现取）：
     ta()              当前 textarea（编辑器整栏重画会换节点）
     back()            镜像层
     names()           Set<string>：哪些 @名字 算素材引用（画底 + 悬停都只认它）
     cands(q)          候选行 [{ kind:'lib'|'ref', name, pic, meta, entry, sub, off, ic }]
     metaOf(name)      悬停小卡：{ pic, meta, ico }；返回 null 不弹
     subChoices(entry) 二级菜单的图 [{ src, note, tag }]；不足 2 条不弹
     tokenOf(cand, pick) 选中之后写进提示词的 @ 后面那串
     onPick(cand, pick, info) 选中之后的副作用（加参考图 / 重画 / 提示）
     emptyHTML()       候选为空时那一句
     idPrefix          浮动层的 id 前缀（默认 mention / mentionSub / atPeek）
     doc / win         页面作用域岛可以递代理进来 */
export function createAssetMention(o) {
  const opt = o || {};
  const doc = opt.doc || document;
  const win = opt.win || window;
  const escHtml = s => (typeof win.esc === 'function' ? win.esc(s) : String(s == null ? '' : s));
  const iconOf = (name, size) => (typeof win.icon === 'function' ? win.icon(name, size) : '');
  const mediaUrl = src => (win.Api && win.Api.mediaSrc) ? win.Api.mediaSrc(src) : src;
  const focusCaret = el => { if (typeof win.focusQuiet === 'function') win.focusQuiet(el); else { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } } };
  const prefix = opt.idPrefix || 'mention';

  let box = null, sub = null, peek = null;
  let state = null;
  let subTimer = null, subRow = null;
  let boundTa = null;
  let typoDone = false;

  function newEl(tag, id, cls) {
    const n = doc.createElement(tag);
    if (id) n.id = id;
    if (cls) n.className = cls;
    n.hidden = true;
    return n;
  }
  function boxEl() {
    if (box && box.isConnected) return box;
    box = newEl('div', prefix === 'mention' ? 'mentionBox' : prefix + 'Box', 'am-box');
    doc.body.appendChild(box);
    return box;
  }
  function subEl() {
    if (sub && sub.isConnected) return sub;
    sub = newEl('div', prefix === 'mention' ? 'mentionSub' : prefix + 'Sub', 'am-sub');
    doc.body.appendChild(sub);
    return sub;
  }
  function peekEl() {
    if (peek && peek.isConnected) return peek;
    peek = newEl('div', prefix === 'mention' ? 'atPeek' : prefix + 'Peek', 'am-peek');
    doc.body.appendChild(peek);
    return peek;
  }
  function hidePeek() { if (peek) peek.hidden = true; }
  function hideSub() {
    clearTimeout(subTimer); subTimer = null;
    subRow = null;
    if (sub) sub.hidden = true;
  }
  function hide() { state = null; if (box) box.hidden = true; hideSub(); }

  /* 什么时候真的收掉二级菜单：**到点了再看一眼鼠标在哪儿**。
     只写「进入时 clearTimeout」是不够的 —— 鼠标从那一行挪到右边那一列，途中必然先离开那一行，
     那个 mouseleave 一定先于 mouseenter 触发；只要两者之间有任何一次顺序意外（或者鼠标
     在 180ms 里没走到），定时器就没人清，菜单当场收掉（用户看到的就是「一进去就自动关了」）。 */
  function scheduleHideSub(ms) {
    clearTimeout(subTimer);
    subTimer = setTimeout(() => {
      subTimer = null;
      if (sub && !sub.hidden && sub.matches(':hover')) return;
      if (subRow && subRow.matches(':hover')) return;
      hideSub();
    }, ms || 260);
  }
  function placeBox(rect) {
    const b = boxEl();
    const w = b.offsetWidth || 320;
    const left = Math.max(8, Math.min(rect.left, win.innerWidth - w - 10));
    let top = rect.bottom + 4;
    const h = b.offsetHeight || 240;
    if (top + h > win.innerHeight - 8) top = Math.max(8, rect.top - h - 4);   // 底下放不下就翻到上面
    b.style.left = left + 'px';
    b.style.top = top + 'px';
  }
  /* 悬停在某一行的角色上 → 右边滑出「挑一张当参考图」。
     **只有真的有的挑（预览图之外还有资产）才弹** —— 只有一张图时弹一个只有一项的菜单是噪音。 */
  function showSub(cand, rowEl) {
    const choices = opt.subChoices ? (opt.subChoices(cand.entry) || []) : [];
    if (choices.length < 2) return hideSub();
    const b = subEl();
    subRow = rowEl;
    b.hidden = false;
    b.innerHTML = '<div class="ms-h">@' + escHtml(cand.name) + ' · 挑一张当参考图</div>'
      + choices.map((ch, i) => '<div class="ms-i" data-msi="' + i + '">'
        + '<span class="ms-t">' + (ch.src ? '<img src="' + escHtml(mediaUrl(ch.src)) + '" alt="" loading="lazy">' : iconOf('image', 15)) + '</span>'
        + '<span class="ms-n">' + escHtml(ch.note || ch.tag) + '</span>'
        + '<span class="ms-k">' + escHtml(ch.tag) + '</span></div>').join('');
    b.querySelectorAll('[data-msi]').forEach(n => {
      n.onmousedown = e => {
        e.preventDefault();
        pickRow(cand, choices[Number(n.dataset.msi)]);
      };
    });
    /* 贴着那一行的右边放，**与行重叠 6px**：中间留缝的话鼠标要跨过去，跨的那一瞬
       既不在行里也不在列里，定时器就有机会先烧掉。重叠一点，鼠标一动就已经在列里了。
       右边放不下就翻到左边（同样重叠 6px）。 */
    const r = rowEl.getBoundingClientRect();
    const w = b.offsetWidth || 272, h = b.offsetHeight || 200;
    let left = r.right - 6;
    if (left + w > win.innerWidth - 8) left = Math.max(8, r.left - w + 6);
    b.style.left = left + 'px';
    b.style.top = Math.max(8, Math.min(r.top, win.innerHeight - h - 8)) + 'px';
    b.onmouseenter = () => clearTimeout(subTimer);
    b.onmouseleave = () => scheduleHideSub();
  }

  function showMenu(cands, range, rect) {
    const b = boxEl();
    state = { cands: cands, i: 0, range: range || null };
    b.hidden = false;
    b.innerHTML = cands.length
      ? cands.map((c, i) => {
        const pic = c.pic ? mediaUrl(c.pic) : '';
        const t = pic ? '<img src="' + escHtml(pic) + '" alt="" loading="lazy">' : iconOf(c.ic || 'image', 15);
        return '<div class="mt-i' + (i === 0 ? ' on' : '') + (c.off ? ' off' : '') + (c.sub ? ' has-sub' : '') + '" data-mi="' + i + '">'
          + '<span class="mt-t">' + t + '</span>'
          + '<span class="mt-n">@' + escHtml(c.name) + '</span>'
          + '<span class="mt-k">' + escHtml(c.meta || '') + '</span></div>';
      }).join('')
      : '<div class="mt-empty">' + (opt.emptyHTML ? opt.emptyHTML() : '没有可引用的素材') + '</div>';
    /* 用 mousedown + preventDefault 而不是 click：click 之前 textarea 会先 blur，
       浮层一收这一下就落空了（经典坑）。 */
    b.querySelectorAll('[data-mi]').forEach(n => {
      const cand = cands[Number(n.dataset.mi)];
      n.onmousedown = e => {
        e.preventDefault();
        const st = state;
        if (st) pickRow(cand);
      };
      /* 二级菜单：鼠标停在这一行上就滑出来。没有第二项可选时不弹。 */
      if (cand && opt.subChoices && (opt.subChoices(cand.entry) || []).length > 1) {
        n.onmouseenter = () => { clearTimeout(subTimer); showSub(cand, n); };
        n.onmouseleave = () => scheduleHideSub();
      } else {
        n.onmouseenter = hideSub;
      }
    });
    b.onmouseenter = () => clearTimeout(subTimer);
    b.onmouseleave = () => scheduleHideSub();
    placeBox(rect);
  }

  function moveCursor(d) {
    if (!state || !box || !state.cands.length) return;
    state.i = (state.i + d + state.cands.length) % state.cands.length;
    box.querySelectorAll('[data-mi]').forEach((n, i) => n.classList.toggle('on', i === state.i));
    const on = box.querySelector('.mt-i.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function key(e) {
    if (!state || !box || box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickRow(state.cands[state.i]); return; }
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
  }

  function refreshMirror() {
    const ta = opt.ta ? opt.ta() : null;
    const back = opt.back ? opt.back() : null;
    if (!ta || !back) return;
    /* 字号 / 行高 / 内边距 / 边框宽度按这一只 textarea 现算：两个页面的输入框不是同一套尺寸，
       写死在样式表里总有一边会错位。 */
    if (!typoDone) {
      const cs = win.getComputedStyle(ta);
      back.style.fontFamily = cs.fontFamily;
      back.style.fontSize = cs.fontSize;
      back.style.fontWeight = cs.fontWeight;
      back.style.fontStyle = cs.fontStyle;
      back.style.lineHeight = cs.lineHeight;
      back.style.letterSpacing = cs.letterSpacing;
      back.style.padding = cs.padding;
      back.style.borderWidth = cs.borderWidth;
      back.style.borderStyle = 'solid';
      typoDone = true;
    }
    back.innerHTML = atBackHTML((opt.names ? opt.names() : new Set()), ta.value, escHtml);
    /* 滚动位置读的是 onscroll 记在节点上的那一份：刚重建完整栏的那一下，
       读 ta.scrollTop 会把整份布局同步催起来。没滚过就一个字都不写。 */
    const top = ta.__atScroll || 0;
    if (top) back.scrollTop = top;
  }

  function syncMenu() {
    const ta = opt.ta ? opt.ta() : null;
    if (!ta || doc.activeElement !== ta) return hide();
    const m = mentionAt(ta);
    if (!m) return hide();
    const c = caretXY(ta, doc, win);
    showMenu(opt.cands ? opt.cands(m.q) : [], { start: m.start, end: m.end },
      { left: c.x, top: c.y, bottom: c.y + c.h });
  }

  /* 输入框旁那颗 `@素材`：不打字也能打开同一份候选。
     插到光标处（框里还留着上次的光标位置）；框从来没聚焦过就追加到末尾。 */
  function openMenu(anchor) {
    const ta = opt.ta ? opt.ta() : null;
    const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect()
      : (ta ? ta.getBoundingClientRect() : null);
    if (!rect) return;
    const m = ta ? mentionAt(ta) : null;
    showMenu(opt.cands ? opt.cands('') : [], m ? { start: m.start, end: m.end } : null, rect);
    if (state) state.anchor = anchor || null;   // 再点一次那颗按钮就收起来（见调用处）
  }

  function pickRow(cand, chosen) {
    const ta = opt.ta ? opt.ta() : null;
    const st = state;
    if (!cand || !ta) return hide();
    const tail = opt.tokenOf ? String(opt.tokenOf(cand, chosen) || '') : String(cand.name || '');
    const token = '@' + tail;
    const caret = insertToken(ta, token, st && st.range);
    hide();
    ta.dispatchEvent(new Event('input'));
    const restoreCaret = () => {
      const t2 = opt.ta ? opt.ta() : null;
      if (!t2) return;
      focusCaret(t2);
      try { t2.setSelectionRange(caret, caret); } catch (e) { /* 光标位置恢复不了（不是可选文本域）不影响这次输入 */ }
    };
    let r = null;
    if (opt.onPick) { try { r = opt.onPick(cand, chosen, { token: token, caret: caret }); } catch (e) { restoreCaret(); throw e; } }
    if (r && typeof r.then === 'function') r.then(restoreCaret, restoreCaret);
    else restoreCaret();
    return r;
  }

  function hover(e) {
    const back = opt.back ? opt.back() : null;
    if (!back) return hidePeek();
    const hit = [...back.querySelectorAll('.ta-at')].find(n => {
      const r = n.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (!hit) return hidePeek();
    const nm = hit.dataset.nm || '';
    const info = opt.metaOf ? opt.metaOf(nm) : null;
    if (!info) return hidePeek();
    const b = peekEl();
    b.hidden = false;
    b.innerHTML = '<span class="pk-t">' + (info.pic ? '<img src="' + escHtml(mediaUrl(info.pic)) + '" alt="">' : iconOf(info.ico || 'image', 15)) + '</span>'
      + '<span><span class="pk-n">@' + escHtml(nm) + '</span><br><span class="pk-k">' + escHtml(info.meta || '') + '</span></span>';
    const r = hit.getBoundingClientRect();
    const w = b.offsetWidth || 200, h = b.offsetHeight || 52;
    b.style.left = Math.max(8, Math.min(r.left, win.innerWidth - w - 10)) + 'px';
    b.style.top = Math.max(8, (r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6)) + 'px';
  }

  /* 把输入框上的那几颗监听挂上。编辑器每次重画会换节点，重挂一次就好；
     同一个节点重复调用不重复挂。 */
  function bindInput(ta) {
    typoDone = false;
    if (!ta || boundTa === ta) return;
    boundTa = ta;
    ta.onkeydown = e => key(e);
    ta.onkeyup = e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') syncMenu(); };
    ta.onclick = () => syncMenu();
    /* 镜像层与悬停小卡：框内滚动时要跟着走，否则高亮会停在错位的行上。 */
    ta.onscroll = () => {
      ta.__atScroll = ta.scrollTop;
      const back = opt.back ? opt.back() : null;
      if (back) back.scrollTop = ta.scrollTop;
    };
    ta.onmousemove = e => hover(e);
    ta.onmouseleave = hidePeek;
    refreshMirror();
  }

  /* 浮层跟着编辑器走：任何一层滚动 / 窗口变化 / 重画都先收起来，免得停在一个对不上的位置上。
     例外：**浮层与二级菜单自己内部的滚动不算** —— 它们都是 overflow-y:auto。 */
  const onScroll = e => {
    const t = e.target;
    if (t && t.nodeType === 1 && ((box && box.contains(t)) || (sub && sub.contains(t)))) return;
    hide();
  };
  const onWinResize = () => hide();
  const onDown = e => {
    if (!box || box.hidden) return;
    /* `@ 素材` 那颗按钮不算「外面」：它自己就是开合开关，交给它的 onclick 处理。 */
    if (box.contains(e.target) || (sub && sub.contains(e.target)) || e.target === (opt.ta ? opt.ta() : null)
      || (e.target && e.target.closest && e.target.closest('[data-at-btn]'))) return;
    hide();
  };
  win.addEventListener('scroll', onScroll, true);
  win.addEventListener('resize', onWinResize);
  doc.addEventListener('mousedown', onDown, true);

  function destroyMention() {
    hide(); hidePeek();
    win.removeEventListener('scroll', onScroll, true);
    win.removeEventListener('resize', onWinResize);
    doc.removeEventListener('mousedown', onDown, true);
    if (box) box.remove();
    if (sub) sub.remove();
    if (peek) peek.remove();
    box = sub = peek = null;
    boundTa = null;
  }

  return { show: showMenu, open: openMenu, hide, key, sync: syncMenu, syncBack: refreshMirror, hover, hidePeek, bind: bindInput, pick: pickRow, destroy: destroyMention,
    get state() { return state; }, set state(v) { state = v; } };
}

export { MENTION_MAX };

/* 素材库那一条身上**有哪几张图**：预览图在前，然后是每一张角色资产。
   二级菜单与「选中之后加哪一张」都读它这一份 —— 两处各列一遍迟早对不上。 */
export function libraryPicChoices(entry) {
  const D = typeof window !== 'undefined' ? window.Chars : null;
  if (!D || !entry) return [];
  const out = [];
  const pic = (D.refPicOf ? D.refPicOf(entry) : D.picOf(entry)) || '';
  const shown = D.picOf(entry) || '';
  if (pic) out.push({ src: pic, note: '', kind: 'preview', tag: entry.anchor ? '身份锚点' : '预览图' });
  if (shown && shown !== pic) out.push({ src: shown, note: '', kind: 'preview', tag: '预览图' });
  (D.Cast.assetsOf(entry) || []).forEach(a => {
    if (!a || !a.src) return;
    if (out.some(x => x.src === a.src)) return;      // 锚点就是这张资产时不重复列
    const nm = (D.Cast.assetName(a) || '资产');
    out.push({ src: a.src, note: nm, kind: 'asset', tag: '资产' });
  });
  return out;
}

/* 这一张图在提示词里的写法 —— 它同时也是参考图的来源标签、芯片上显示的那串。
   挑角色资产时写 `小雅·三视图`，不是光写 `小雅`，否则输入栏里看不出引的是哪一张。 */
export function libraryTokenOf(name, note) {
  const n = String(name == null ? '' : name);
  const t = String(note == null ? '' : note).trim();
  return t ? (n + '·' + t) : n;
}
