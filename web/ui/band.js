/* 行尾展开带：网格档里卡片详情不把格子撑高，而是接在**那一行下面**成一条整行宽的带子。
   一次只开一条，连线从带子上沿指回那个格子（Wb.expand.anchor 量出来）。
   资产库与工作台共用这一份；收藏页那条带是 Vue 模板声明的，不走这里。 */
export function createBand(o) {
  const { keyOf, cardOf, hostOf, renderDetail, labelOf } = o || {};
  let key = '';
  let el = null;

  const expandOf = () => (window.Wb && window.Wb.expand) || null;

  function cardFor(k) {
    try { return k && cardOf ? cardOf(k) : null; } catch (e) { return null; }
  }

  function closeBand() {
    const k = key;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    key = '';
    const c = cardFor(k);
    const ex = expandOf();
    if (c && ex) {
      c.classList.remove('is-band');
      ex.sync(c);
    }
  }

  /* 这一行最后一张卡：**量出来的**（同一行的卡 offsetTop 一样），不重排整片网格。 */
  function rowEndOf(card) {
    let last = card;
    let n = card.nextElementSibling;
    while (n && n.classList && !n.classList.contains('band') && n.offsetTop === card.offsetTop) {
      last = n;
      n = n.nextElementSibling;
    }
    return last;
  }

  /* 重画之后把带子放回它那一行的下面：卡片列表只挪卡片，带子是插在容器里的另一个孩子，
     重画一遍它就跑到容器末尾去了。 */
  function afterPaint() {
    if (!el || !key) return;
    const card = cardFor(key);
    if (!card) { closeBand(); return; }
    const rowEnd = rowEndOf(card);
    if (rowEnd && rowEnd.parentNode) rowEnd.parentNode.insertBefore(el, rowEnd.nextSibling);
    const t = el.querySelector('.band-hd .t');
    const item = card._item;
    if (t && labelOf && item) {
      const s = String(labelOf(item) || '');
      if (t.textContent !== s) t.textContent = s;
    }
    const ex = expandOf();
    if (ex) ex.anchor(el, card);
  }

  function toggleBand(card, item) {
    const box = hostOf ? hostOf() : null;
    if (!box || !card || !item) return;
    const k = String(keyOf(item));
    if (key === k) { closeBand(); return; }
    closeBand();
    const band = document.createElement('div');
    band.className = 'band';
    band.innerHTML = '<span class="band-tether"></span>'
      + '<div class="band-in"><div class="band-hd">'
      + '<span class="t"></span><span class="sp"></span>'
      + '<button type="button" class="ghost" data-act="closeband">收起</button></div>'
      + '<div class="cdet"></div></div>';
    const tl = band.querySelector('.t');
    if (tl) tl.textContent = String((labelOf && labelOf(item)) || '');
    const rowEnd = rowEndOf(card);
    if (rowEnd && rowEnd.parentNode) rowEnd.parentNode.insertBefore(band, rowEnd.nextSibling);
    else box.appendChild(band);
    el = band;
    key = k;
    card.classList.add('is-band');
    const ex = expandOf();
    if (ex) ex.sync(card);
    const host = band.querySelector('.cdet');
    if (host && renderDetail) renderDetail(item, host);
    const cb = band.querySelector('[data-act="closeband"]');
    if (cb) cb.onclick = e => { e.stopPropagation(); closeBand(); };
    if (ex) ex.anchor(band, card);
  }

  return {
    toggle: toggleBand,
    close: closeBand,
    afterPaint,
    isOpen: k => !!key && key === String(k),
    openKey: () => key,
  };
}
