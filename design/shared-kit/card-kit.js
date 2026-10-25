/* ════════════════════════════════════════════════════════════════════════════
   公共卡片件的**接线** —— 就地展开。

   落地时进 `web/ui/workbench.js` 的 `Wb`（`Wb.expand` / `Wb.close` / `Wb.closeAll`），
   两页共用：资产库与收藏页的「详情」按钮都接它，不各写一套展开逻辑。

   为什么要有这一件：展开的**行为**（一次只开一条、Esc 收起、按钮的字跟着变）
   与展开的**长相**（`.exp` / `.is-open`）是同一件事的两半 ——
   两页各写一半，早晚会长歪。
   ════════════════════════════════════════════════════════════════════════════ */
window.Kit = window.Kit || {};

(function () {
  const K = window.Kit;

  /* 打开 / 收起一张卡。
     opts: { force: true|false }   不给就切换
     返回：现在是不是开着 */
  K.expand = function (card, opts) {
    if (!card) return false;
    const o = opts || {};
    const want = o.force === undefined ? !card.classList.contains('is-open') : !!o.force;
    /* 一次只开一条：同时开几条会把页面拉扯得不像话。
       同一页的卡在同一个「范围」里（scope），范围默认是最近的列表容器。 */
    const scope = o.scope || card.closest('[data-kit-scope]') || document;
    scope.querySelectorAll('.is-open').forEach(c => { if (c !== card) K.close(c); });
    card.classList.toggle('is-open', want);
    const btn = card.querySelector('[data-kit-toggle]');
    if (btn) btn.textContent = want ? '收起' : '详情';
    return want;
  };

  K.close = function (card) {
    if (!card) return;
    card.classList.remove('is-open');
    const btn = card.querySelector('[data-kit-toggle]');
    if (btn) btn.textContent = '详情';
  };

  K.closeAll = function (scope) {
    (scope || document).querySelectorAll('.is-open').forEach(K.close);
  };

  /* 连线落在哪儿是**量出来的**，不是猜的：量那个格子与带子的矩形，
     把横坐标写进带子上的 CSS 变量（--kit-anchor）。
     换成第 2 列、第 3 列，线也跟着挪。 */
  K.anchor = function (band, tile) {
    if (!band || !tile) return;
    const b = band.getBoundingClientRect();
    const t = tile.getBoundingClientRect();
    band.style.setProperty('--kit-anchor', Math.round(t.left - b.left + t.width / 2) + 'px');
  };
})();
