/* 给 AI 助手的「当前界面」只读快照（全站一份）。
   助手每次提问都会自动带上它，界面顶部的上下文芯片也读它。
   这里只读 DOM / 路由，不碰任何页面数据，也不写盘。 */
(function () {
  const q = (root, sel) => { try { return root.querySelector(sel); } catch (e) { return null; } };
  const qa = (root, sel) => { try { return [...root.querySelectorAll(sel)]; } catch (e) { return []; } };
  const txt = (root, sel) => { const el = q(root, sel); return el ? String(el.textContent || '').trim() : ''; };
  const val = (root, sel) => { const el = q(root, sel); return el ? String(el.value || '').trim() : ''; };
  const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const onChips = (root, sel) => qa(root, sel).map(x => String(x.textContent || '').trim()).filter(Boolean);
  const add = (o, k, v, n) => { if (v !== '' && v != null) o[k] = typeof v === 'string' ? cut(v, n || 80) : v; };

  const GET = {
    'favorites.html': root => {
      const o = {};
      add(o, '筛选', onChips(root, '.fav-page .toolbar .chip.on').join(' / '));
      add(o, '搜索', val(root, '.fav-page input[type=search]'));
      add(o, '条数', txt(root, '.fav-page .toolbar .cnt'));
      add(o, '当前页', txt(root, '.fav-page #favPgInfo'));
      return o;
    },
    'usage.html': root => {
      const o = {};
      add(o, '平台', txt(root, '#fPlatform option:checked'));
      add(o, '时间范围', txt(root, '#fRange option:checked'));
      add(o, '搜索', val(root, '#fQ'));
      add(o, '账单读数', txt(root, '#billCnt'));
      add(o, '余额卡', qa(root, '.usage-page .bal').length || '');
      return o;
    },
    'assets.html': root => {
      const o = {};
      add(o, '筛选', onChips(root, '.assets-page .filters .chip.on').join(' / '));
      add(o, '搜索', val(root, '.assets-page #search'));
      add(o, '条数', txt(root, '.assets-page #cnt'));
      add(o, '多选', q(root, '.assets-page #multiBtn.active') ? '已进入（' + (txt(root, '.assets-page #bulkCnt') || '未选') + '）' : '');
      add(o, '提示', txt(root, '.assets-page #loadErr'));
      return o;
    },
    'settings.html': root => {
      const o = {};
      add(o, '账号筛选', txt(root, '.settings-page .acct-tools .fchip.on span'));
      add(o, '筛选', val(root, '.settings-page input[type=search]'));
      add(o, '栏目数', qa(root, '.settings-page .card').length || '');
      add(o, '保存状态', txt(root, '.settings-page .set-nav-sum'));
      return o;
    },
    'chars.html': root => {
      const o = {};
      add(o, '筛选', onChips(root, '.chars-page .chip.on').join(' / '));
      add(o, '搜索', val(root, '.chars-page input[type=search]'));
      add(o, '条数', qa(root, '.chars-page .card').length || '');
      const open = q(root, '.chars-page .card.open');
      if (open) add(o, '正在编辑', txt(open, '.t'));
      return o;
    },
    'studio.html': root => {
      const o = {};
      const tab = q(root, '[data-r=typeSeg] button.on');
      if (tab) add(o, '类型', tab.dataset.t || tab.textContent);
      const sel = q(root, '[data-r=model]');
      if (sel && sel.options[sel.selectedIndex]) add(o, '型号', sel.options[sel.selectedIndex].textContent);
      const prompt = q(root, '[data-r=prompt]');
      if (prompt) add(o, '提示词字数', String(prompt.value || '').length);
      const modes = onChips(root, '[data-r=modeRow] button.on');
      if (modes.length) add(o, '输入模式', modes.join(' / '));
      const slots = qa(root, '[data-r=inputArea] > *').length;
      if (slots) add(o, '素材槽', slots);
      return o;
    },
    'director.html': root => {
      const o = {};
      add(o, '项目', txt(root, '#projLabel'));
      add(o, '镜头数', qa(root, '#scenesBox .shot-item').length || '');
      const sel = q(root, '#scenesBox .shot-item.sel');
      if (sel) {
        add(o, '当前镜', txt(sel, '.sname') || '第 ' + (txt(sel, '.num') || '?') + ' 镜');
        add(o, '这一镜', txt(sel, '.smeta'));
      }
      add(o, '剪辑轨', q(root, '#tlBoard') ? '已打开' : '未打开');
      add(o, '保存状态', txt(root, '#saveState'));
      /* 助手要改时间线就得知道**候选与段**（序号、状态、选用哪条、几段、倍速），
         这些不在 DOM 的可见文字里，读 `WBBridge.director.context()` 那份现算的只读快照。
         桥还没就绪（导演台还在加载）时照旧只报上面那几项。 */
      try {
        const A = window.WBBridge && window.WBBridge.get ? window.WBBridge.get('director') : null;
        if (A && A.context) {
          const c = A.context();
          Object.keys(c || {}).forEach(k => { if (c[k] !== '' && c[k] != null) o[k] = c[k]; });
        }
      } catch (e) {}
      return o;
    },
  };

  /* 根类不再在这里抄第二份：路由表每条带 `root`，GET 的覆盖率由 tests/spa.cjs 判住。 */
  window.__acPageCtx = function () {
    let r = null;
    try { r = window.__spaRoute && window.__spaRoute(); } catch (e) {}
    if (!r || !r.page) return null;
    const root = document.querySelector(r.page.root);
    if (!root) return { 页面: r.page.label || r.file };
    const o = { 页面: r.page.label || r.page.file };
    const fn = GET[r.file];
    if (fn) {
      try { Object.assign(o, fn(root)); } catch (e) { o.读取失败 = cut(errText(e), 120); }
    }
    return o;
  };
})();
