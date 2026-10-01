/* ============================================================================
   ui.js —— 自定义下拉组件（与图片工作台完全同一套）
   用法：
     1) 页面 <script src="ui.js"></script>
     2) 静态下拉：DOM 就绪后 Dropdowns.build(document)；
        动态重建的下拉：重建 HTML 之后再 Dropdowns.build(容器)
     3) 页面代码改完 <select> 的 <option> 后调用 sel._ddRebuild?.()
   说明：原生 <select> 仍作为唯一数据源（保留 value / change 事件 / 表单行为），
        只是被隐藏，改用 .dd 组件渲染，观感与图片工作台一致。
   ========================================================================== */
(function () {
  const ARW = '<svg class="arw" width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" stroke="#8f97ab" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';

  function buildOne(sel) {
    if (!sel || sel._ddBuilt) return;
    if (sel.closest('.dd')) return;
    const dd = document.createElement('div');
    dd.className = 'dd';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    btn.append(lbl, fromHTML(ARW));
    const list = document.createElement('div');
    list.className = 'dd-list';

    const sync = () => {
      const o = sel.options[sel.selectedIndex];
      lbl.textContent = (o && (o.dataset.ddLabel || o.textContent)) || '请选择';
      [...list.children].forEach(it => it.classList.toggle('sel', it.dataset.val === sel.value));
    };
    const buildList = () => {
      list.innerHTML = '';
      const addOpt = o => {
        if (!o || o.tagName !== 'OPTION' || o.hidden) return;
        const item = document.createElement('div');
        item.className = 'dd-opt';
        item.dataset.val = o.value;
        item.innerHTML = `<span class="chk">✓</span><span class="tx"></span>`;
        item.querySelector('.tx').textContent = o.dataset.ddLabel || o.textContent;
        if (o.title) item.title = o.title;
        item.onclick = e => {
          e.stopPropagation();
          if (sel.value !== o.value) {
            sel.value = o.value;
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          sync();
          dd.classList.remove('open');
        };
        list.appendChild(item);
      };
      /* optgroup 也要渲染出来（模型列表按 API 来源分组：同一个平台的模型在同一组下）。
         原生 select 仍是数据源，这里只是照着它的结构重画一遍。 */
      [...sel.children].forEach(node => {
        if (node.tagName === 'OPTGROUP') {
          const g = document.createElement('div');
          g.className = 'dd-grp';
          g.textContent = node.label || '';
          list.appendChild(g);
          [...node.children].forEach(addOpt);
        } else addOpt(node);
      });
      sync();
    };
    sel._ddRebuild = () => { buildList(); sync(); };
    buildList();

    btn.onclick = e => {
      e.stopPropagation();
      const willOpen = !dd.classList.contains('open');
      document.querySelectorAll('.dd.open').forEach(x => x.classList.remove('open'));
      if (willOpen) dd.classList.add('open');
    };
    dd.append(btn, list);
    sel.before(dd);
    dd.appendChild(sel);   // 原生 select 留在里面并隐藏，作为数据源
    sel._ddBuilt = true;
  }

  function fromHTML(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  window.Dropdowns = {
    build(root) {
      const scope = root && root.querySelectorAll ? root : document;
      if (scope.matches && scope.matches('select')) buildOne(scope);
      scope.querySelectorAll('select').forEach(buildOne);
    },
    /* 页面代码直接改了 select.value 之后，同步显示文字 */
    sync(root) {
      const scope = root && root.querySelectorAll ? root : document;
      scope.querySelectorAll('select').forEach(sel => { if (sel._ddBuilt) sel._ddRebuild(); });
    },
  };

  document.addEventListener('click', () =>
    document.querySelectorAll('.dd.open').forEach(x => x.classList.remove('open')));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.dd.open').forEach(x => x.classList.remove('open'));
  });
})();

/* ============================================================================
   esc —— HTML 转义（拼 innerHTML 时统一用它包住用户/接口文本）
   场景名、镜头名、提示词、AI 摘要、平台名这些都可能带 < & " ，直接拼进模板会显示错乱甚至注入。
   用法：`<div>${esc(name)}</div>`
   ========================================================================== */
window.esc = function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

/* ============================================================================
   ICONS —— 线性 SVG 图标集（统一 1.5 描边、跟随文字颜色，替代 emoji）
   icon('trash')            → 默认 14px
   icon('film', 18)         → 指定尺寸
   <span class="ic">${icon('coin')}</span>
   ========================================================================== */
window.ICONS = {
  film: '<rect x="1.9" y="3" width="12.2" height="10" rx="1.5"/><path d="M4.7 3v10M11.3 3v10M1.9 8h12.2"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.6" r="1.1"/><path d="M3 11.6l3.2-3 2.6 2.4 2.2-2 2 1.9"/>',
  video: '<rect x="1.9" y="3.4" width="8.7" height="9.2" rx="1.5"/><path d="M10.6 8l3.5-2.2v4.4L10.6 8z"/>',
  mic: '<rect x="6.2" y="2.3" width="3.6" height="6.6" rx="1.8"/><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8V14M5.9 14h4.2"/>',
  users: '<circle cx="6" cy="6" r="2.2"/><path d="M2.6 13c0-1.9 1.5-3.4 3.4-3.4s3.4 1.5 3.4 3.4"/><path d="M10.5 4.3a2.1 2.1 0 0 1 0 4.1M11.7 10c1.4.3 2.4 1.6 2.4 3"/>',
  box: '<path d="M8 2l5.5 3v6L8 14l-5.5-3V5z"/><path d="M2.5 5L8 8l5.5-3M8 8v6"/>',
  checkBox: '<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2"/><path d="M5.4 8.1l1.8 1.8 3.6-3.7"/>',
  chart: '<path d="M2.6 13.4V2.6M2.6 13.4h10.8"/><path d="M5.6 11V7.4M8.2 11V4.8M10.8 11V8.8"/>',
  gear: '<circle cx="8" cy="8" r="2.1"/><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"/>',
  moon: '<path d="M13 9.6A5.2 5.2 0 0 1 6.4 3 5.4 5.4 0 1 0 13 9.6z"/>',
  coin: '<circle cx="8" cy="8" r="5.4"/><path d="M10 6.2c-.4-.7-1.1-1-2-1-1.1 0-1.9.5-1.9 1.3 0 .9.8 1.2 1.9 1.4 1.2.2 2 .6 2 1.5s-.9 1.4-2 1.4c-1 0-1.7-.4-2.1-1.1M8 3.8v8.4"/>',
  sparkles: '<path d="M6.3 2.2l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z"/><path d="M11.8 8.6l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z"/>',
  upload: '<path d="M8 10.6V3.2M5.2 6L8 3.2 10.8 6M3.4 12.4h9.2"/>',
  download: '<path d="M8 2.6v7.4M5.2 7.2L8 10l2.8-2.8M3.4 12.6h9.2"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.7-3.8"/><path d="M13 2.6V6h-3.4"/>',
  trash: '<path d="M2.7 4.4h10.6M6.2 4.4V2.9h3.6v1.5M4.5 4.4l.5 8.1c0 .6.5 1 1 1h4c.6 0 1-.4 1-1l.5-8.1"/><path d="M6.7 7.1v3.9M9.3 7.1v3.9"/>',
  copy: '<rect x="5.6" y="5.6" width="8" height="8" rx="1.4"/><path d="M10.4 3.4H3.8c-.8 0-1.4.6-1.4 1.4v6.6"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="6" cy="4" r="1.05"/><circle cx="10" cy="4" r="1.05"/><circle cx="6" cy="8" r="1.05"/><circle cx="10" cy="8" r="1.05"/><circle cx="6" cy="12" r="1.05"/><circle cx="10" cy="12" r="1.05"/></g>',
  lock: '<rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.7 7V5.4a2.3 2.3 0 0 1 4.6 0V7"/>',
  unlock: '<rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.7 7V5.4a2.3 2.3 0 0 1 4.3-1.2"/>',
  scissors: '<circle cx="4.4" cy="12" r="1.8"/><circle cx="11.6" cy="12" r="1.8"/><path d="M5.7 10.7L12 2.6M10.3 10.7L4 2.6"/>',
  list: '<path d="M5.6 4h8M5.6 8h8M5.6 12h8"/><path d="M2.8 4h.01M2.8 8h.01M2.8 12h.01"/>',
  play: '<path d="M4.8 3.4l7.6 4.6-7.6 4.6z"/>',
  pause: '<rect x="5.1" y="3.4" width="2.3" height="9.2" rx="0.7"/><rect x="8.6" y="3.4" width="2.3" height="9.2" rx="0.7"/>',
  export: '<path d="M8 11V2.8M5.2 5.6L8 2.8l2.8 2.8"/><path d="M3 9v3.4c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V9"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.7 10.7L14 14"/>',
  folder: '<path d="M2 5.3c0-.7.5-1.3 1.2-1.3h2.3l1.4 1.6h5.9c.7 0 1.2.6 1.2 1.3v5.3c0 .7-.5 1.3-1.2 1.3H3.2c-.7 0-1.2-.6-1.2-1.3z"/>',
  folderDoc: '<path d="M2 5.3c0-.7.5-1.3 1.2-1.3h2.3l1.4 1.6h5.9c.7 0 1.2.6 1.2 1.3v5.3c0 .7-.5 1.3-1.2 1.3H3.2c-.7 0-1.2-.6-1.2-1.3z"/><path d="M5.4 9.6h5.2M5.4 11.6h3.2"/>',
  eye: '<path d="M1.8 8S4.1 4.3 8 4.3 14.2 8 14.2 8 11.9 11.7 8 11.7 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>',
  eyeOff: '<path d="M3.3 5.5C2.3 6.4 1.8 8 1.8 8s2.3 3.7 6.2 3.7c.9 0 1.7-.2 2.4-.6M6.7 4.6c.4-.1.9-.2 1.3-.2 3.9 0 6.2 3.6 6.2 3.6s-.5 1-1.5 1.9"/><path d="M2.8 2.8l10.4 10.4"/>',
  key: '<circle cx="5.4" cy="10.6" r="2.6"/><path d="M7.5 8.5l4.9-4.9M10 5.9l1.6 1.6 1.7-1.7-1.6-1.6"/>',
  brain: '<path d="M8 2.6v10.8"/><path d="M5.4 3.9A2.6 2.6 0 0 0 3.9 8.4 2.6 2.6 0 0 0 5.4 13M10.6 3.9a2.6 2.6 0 0 1 1.5 4.5A2.6 2.6 0 0 1 10.6 13"/>',
  phone: '<rect x="5.1" y="2" width="5.8" height="12" rx="1.6"/><path d="M7.5 12.1h1"/>',
  desktop: '<rect x="2" y="3" width="12" height="8.2" rx="1.4"/><path d="M6 13.4h4M8 11.2v2.2"/>',
  book: '<path d="M3 3.2h4.1c.9 0 1.6.7 1.6 1.6v8c0-.7-.7-1.3-1.6-1.3H3zM13 3.2H8.9c-.9 0-1.6.7-1.6 1.6v8c0-.7.7-1.3 1.6-1.3H13z"/>',
  docTab: '<rect x="3.4" y="2.8" width="9.2" height="10.6" rx="1.4"/><path d="M6.2 2.8h3.6v1.7H6.2z" fill="currentColor" stroke="none"/><path d="M5.9 7.2h4.2M5.9 9.8h2.8"/>',
  speaker: '<path d="M3 6.4h2.2L8.3 3.6v8.8L5.2 9.6H3z"/><path d="M10.6 6.1a2.8 2.8 0 0 1 0 3.8M12.2 4.5a5 5 0 0 1 0 7"/>',
  speakerOff: '<path d="M3 6.4h2.2L8.3 3.6v8.8L5.2 9.6H3z"/><path d="M11 6.5l3 3M14 6.5l-3 3"/>',
  calendar: '<rect x="2.4" y="3.6" width="11.2" height="9.6" rx="1.4"/><path d="M2.4 6.6h11.2M5.6 2.4v2.4M10.4 2.4v2.4"/>',
  clock: '<circle cx="8" cy="8" r="5.4"/><path d="M8 4.6v3.6l2.4 1.4"/>',
  warning: '<path d="M8 2.9l5.4 9.3H2.6z"/><path d="M8 6.4v3.1M8 11.3h.01"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.3v3.5M8 5.5h.01"/>',
  broom: '<path d="M9.6 2.6l3.2 3.2-4.7 4.7-3.2-3.2z"/><path d="M4.9 7.3L2.6 13.5l6.2-2.3"/>',
  pencil: '<path d="M11.4 2.7l1.9 1.9L6 12l-2.6.6L4 10z"/>',
  link: '<path d="M6.7 9.3a2.6 2.6 0 0 0 3.7 0l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-1 1"/><path d="M9.3 6.7a2.6 2.6 0 0 0-3.7 0l-1.9 1.9a2.6 2.6 0 0 0 3.7 3.7l1-1"/>',
  robot: '<rect x="3.4" y="5.4" width="9.2" height="7" rx="1.6"/><path d="M8 2.6v2.8M6.2 8.4h.01M9.8 8.4h.01M6.4 10.8h3.2"/>',
  stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.1"/>',
  reuse: '<path d="M12.8 6.6A5.1 5.1 0 0 0 4 4.8"/><path d="M12.8 2.8v3.8H9"/><rect x="4.4" y="9" width="5.6" height="4.4" rx="1.1"/>',
  plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
  star: '<path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5z"/>',
  starFill: '<path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5z" fill="currentColor"/>',
  chevronLeft: '<path d="M9.8 4.4L6.2 8l3.6 3.6"/>',
  chevronRight: '<path d="M6.2 4.4L9.8 8l-3.6 3.6"/>',
  arrowLeft: '<path d="M12.6 8H3.4M7 4.4L3.4 8 7 11.6"/>',
  arrowRight: '<path d="M3.4 8h9.2M9 4.4L12.6 8 9 11.6"/>',
};
window.icon = function icon(name, size) {
  const b = window.ICONS[name];
  if (!b) return '';
  const s = size || 14;
  return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:0 0 auto">' + b + '</svg>';
};

/* HTML 静态标记里的图标：写 <span class="ic" data-icon="sparkles" data-size="17"></span>，
   由这里一次性填成 SVG。图标几何只允许有 ICONS 一份 —— 之前三台各自手抄 sparkles/trash
   的 path，改一套漏两套。 */
window.fillIcons = function fillIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = window.icon(el.getAttribute('data-icon'), +el.getAttribute('data-size') || 14);
    el.removeAttribute('data-icon');
  });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.fillIcons());
else window.fillIcons();

/* ============================================================================
   copyText —— 复制文本到剪贴板（统一入口）
   优先用 Clipboard API；被浏览器策略拒绝时回退到临时 textarea + execCommand，
   保证在 http 本地环境 / 各种内嵌浏览器里也能复制成功。
   用法：const ok = await copyText('要复制的文本')
   ========================================================================== */
window.copyText = async function copyText(txt) {
  const s = String(txt == null ? '' : txt);
  if (!s) return false;
  try { await navigator.clipboard.writeText(s); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
};

/* ============================================================================
   uploadStageText —— 素材上传的阶段文案（AssetTransfer 的 onStage 回调 → 页面状态行）
   阶段由 assetlib.js 的 AssetTransfer 报出：
     fetch     正在取回素材（外部链接经代理 /getfile 取回；同源地址直接读）
     intent    正在向平台申请上传地址（POST uploads）
     put       拿到地址，开始上传字节
     progress  真实进度（{sent,total,pct}）—— 由本地代理按「本机 → 对象存储」那一段回传，
               不是浏览器 → 本机的回环那一段（后者通常一两秒就完了，量它没有意义）
   用法：onStage: (st, info) => { const t = uploadStageText(st, info, '参考图'); if (t) setStatus(t); }
   ========================================================================== */
(function () {
  function fmtBytes(b) {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(1) : v) + ' ' + u[i];
  }
  window.fmtBytes = fmtBytes;      // 界面各处「≤ 10 MB」这类文案共用一份
  window.uploadStageText = function uploadStageText(stage, info, label) {
    const who = label || '素材';
    if (stage === 'fetch') return '正在取回' + who + '…';
    if (stage === 'prepare') return '正在检查' + who + '音轨；无音轨时自动补静音，不改变画面…';
    if (stage === 'prepared') return info ? who + '已补静音音轨，准备上传…' : who + '已有音轨，保持原文件上传…';
    if (stage === 'intent') return '正在申请' + who + '上传地址…';
    if (stage === 'put') return '正在上传' + who + '…';
    if (stage === 'progress') {
      const i = info || {};
      const fmt = (window.Wb && window.Wb.fmtSize) ? window.Wb.fmtSize : fmtBytes;
      const sent = i.sent ? fmt(i.sent) : '';
      const total = i.total ? fmt(i.total) : '';
      const size = (sent && total) ? sent + ' / ' + total : (sent || total || '');
      /* 100% 只说明「字节发完了」：对象存储还要处理一会儿才回结果（大文件可能要等几秒），
         所以这里换成「等待确认」，别让界面看着像卡住了。 */
      if (i.pct != null && i.pct >= 100) return '正在上传' + who + '… 已发完' + (size ? ' ' + size : '') + '，等待服务器确认';
      const pct = (i.pct != null && i.pct >= 0) ? i.pct + '%' : '';
      const tail = [pct, size].filter(Boolean).join(' ');
      return '正在上传' + who + '…' + (tail ? ' ' + tail : '');
    }
    return '';
  };
})();

/* ============================================================================
   InlinePolish —— 就地润色面板（不弹窗，展开在提示词输入框下方）
     · InlinePolish.loading(host, text)          占位：显示「正在润色…」
     · InlinePolish.show(host, o)                结果面板（结果可编辑，用户决定是否替换）
         o.after      润色后的文本
         o.note       小字说明（附带了几张素材图 / 为什么没带图…）
         o.before     原文（只用于显示字数对比）
         o.applyLabel 「替换」按钮文案，默认「替换原提示词」
         o.onEdit(v)  用户改动结果文本时回调（页面可把值存进自己的状态，重渲染不丢）
         o.onApply(v) 点「替换」时回调（页面在这里写回输入框）
         o.onRetry()  点「重新润色」时回调 → Promise<{after, note}|string>
         o.onClose()  点「放弃」时回调
     · InlinePolish.clear(host)                  收起面板（纯 DOM 清理，不触发 onClose）
   ========================================================================== */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  window.InlinePolish = {
    clear(host) {
      if (!host) return;
      host.innerHTML = '';
      host.hidden = true;
    },
    loading(host, text) {
      if (!host) return;
      host.hidden = false;
      host.innerHTML = `<div class="pinl"><div class="pinl-load"><span class="spin-dot"></span>${esc(text || '正在润色…')}</div></div>`;
    },
    show(host, o) {
      if (!host) return null;
      o = o || {};
      host.hidden = false;
      host.innerHTML = `<div class="pinl">
        <div class="pinl-hd">
          <span class="pinl-tt">${icon('sparkles', 13)} AI 润色结果</span>
          <span class="pinl-note">${esc(o.note || '')}</span>
        </div>
        <textarea class="pinl-ta" spellcheck="false" placeholder="润色结果（可直接改）"></textarea>
        <div class="pinl-ft">
          <button class="pri" data-act="apply">${esc(o.applyLabel || '替换原提示词')}</button>
          <button class="ghost" data-act="retry">${icon('refresh', 13)} 重新润色</button>
          <button class="ghost" data-act="close">放弃</button>
          <span class="pinl-len"></span>
        </div>
      </div>`;
      const el = host.firstElementChild;
      const ta = el.querySelector('.pinl-ta');
      const lenEl = el.querySelector('.pinl-len');
      const before = String(o.before == null ? '' : o.before);
      const paintLen = () => {
        lenEl.textContent = (before ? '原文 ' + before.trim().length + ' 字 → ' : '') + '润色后 ' + ta.value.trim().length + ' 字';
      };
      const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 92), Math.round(window.innerHeight * 0.4)) + 'px'; };
      ta.value = o.after || '';
      paintLen(); grow();
      ta.oninput = () => { paintLen(); grow(); if (o.onEdit) o.onEdit(ta.value); };
      ta.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); } };
      const applyBtn = el.querySelector('[data-act="apply"]');
      function apply() {
        const v = ta.value.trim();
        if (!v) return;
        if (o.onApply) o.onApply(v);
        window.InlinePolish.clear(host);
      }
      applyBtn.onclick = apply;
      el.querySelector('[data-act="close"]').onclick = () => { if (o.onClose) o.onClose(); window.InlinePolish.clear(host); };
      const retry = el.querySelector('[data-act="retry"]');
      retry.onclick = async () => {
        if (!o.onRetry) return;
        const keep = ta.value;
        retry.disabled = true; applyBtn.disabled = true;
        el.querySelector('.pinl-note').textContent = '正在重新润色…';
        try {
          const r = await o.onRetry();
          const next = (r && typeof r === 'object') ? r : { after: r };
          ta.value = next.after || '';
          el.querySelector('.pinl-note').textContent = next.note || '';
          paintLen(); grow();
          if (o.onEdit) o.onEdit(ta.value);
        } catch (e) {
          ta.value = keep;
          el.insertAdjacentHTML('afterbegin', `<div class="pinl-err">重新润色失败：${esc(e.message || e)}</div>`);
          el.querySelector('.pinl-note').textContent = o.note || '';
        }
        retry.disabled = false; applyBtn.disabled = false;
      };
      return el;
    },
  };
})();

/* ============================================================================
   PromptReview —— AI 结果确认弹窗（多条规划结果用；单段润色走 InlinePolish 就地面板）
     · PromptReview.open({ title, sub, before, after, hint, applyLabel, retry })
         → 单段文本：左原文 / 右可编辑结果；resolve(编辑后的文本) 或 null（取消）
         · retry: async () => newText   「重新润色」按钮用
     · PromptReview.openList({ title, sub, items:[{label,text}], hint, applyLabel, retry })
         → 多段（如分镜切片）：逐条可编辑 / 可删除；resolve([{label,text}]) 或 null
   ========================================================================== */
(function () {
  function mount(title, sub) {
    const dlg = document.createElement('dialog');
    dlg.id = 'prDlg';
    dlg.innerHTML = `<div class="pr-head"><b>${title}</b><div class="sub">${sub || ''}</div></div>
      <div class="pr-body" id="prBody"></div>
      <div class="pr-foot"><button class="ghost" id="prRetry">${icon('refresh', 13)} 重新润色</button>
        <span class="hint" id="prHint"></span><span class="sp"></span>
        <button class="ghost" id="prCancel">取消</button>
        <button class="pri" id="prOk"></button></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    return dlg;
  }
  function close(dlg, out, resolve) { try { dlg.close(); } catch {} dlg.remove(); resolve(out); }

  window.PromptReview = {
    open(o) {
      return new Promise(resolve => {
        const dlg = mount(o.title || 'AI 润色结果（确认后再采用）', o.sub);
        const body = dlg.querySelector('#prBody');
        const okBtn = dlg.querySelector('#prOk');
        okBtn.textContent = o.applyLabel || '采用这段提示词';
        dlg.querySelector('#prHint').textContent = o.hint || '右侧内容可以直接编辑';
        const paint = after => {
          body.innerHTML = `<div class="pr-cols">
            <div class="pr-col"><h4>原始内容</h4><div class="ro" id="prBefore"></div></div>
            <div class="pr-col"><h4>AI 润色后（可编辑）</h4><textarea id="prAfter"></textarea></div>
          </div>`;
          body.querySelector('#prBefore').textContent = o.before || '(空)';
          body.querySelector('#prAfter').value = after;
          body.querySelector('#prAfter').focus();
        };
        paint(o.after || '');
        okBtn.onclick = () => close(dlg, (body.querySelector('#prAfter').value || '').trim() || null, resolve);
        dlg.querySelector('#prCancel').onclick = () => close(dlg, null, resolve);
        dlg.addEventListener('cancel', e => { e.preventDefault(); close(dlg, null, resolve); });
        const retry = dlg.querySelector('#prRetry');
        if (o.retry) {
          retry.onclick = async () => {
            retry.disabled = true; retry.textContent = '润色中…';
            body.innerHTML = '<div class="pr-loading"><span class="spin-dot"></span>正在重新润色…</div>';
            try { paint(await o.retry()); } catch (e) { paint(''); body.insertAdjacentHTML('afterbegin', `<div style="color:var(--err,#dc2626);font-size:12px;margin-bottom:8px">重新润色失败：${esc(e.message)}</div>`); }
            retry.disabled = false; retry.innerHTML = icon('refresh', 13) + ' 重新润色';
          };
        } else retry.style.display = 'none';
      });
    },

    openList(o) {
      return new Promise(resolve => {
        const dlg = mount(o.title || 'AI 规划结果（确认后再生成）', o.sub);
        const body = dlg.querySelector('#prBody');
        const okBtn = dlg.querySelector('#prOk');
        okBtn.textContent = o.applyLabel || '采用并开始生成';
        dlg.querySelector('#prHint').textContent = o.hint || '可以逐条修改或删掉不想生成的画面';
        let items = (o.items || []).map(x => ({ label: x.label, text: x.text }));
        const paint = () => {
          body.innerHTML = items.length ? items.map((it, i) => `<div class="pr-row" data-i="${i}">
              <span class="tt">${esc(it.label)}</span>
              <textarea data-i="${i}">${esc(it.text || '')}</textarea>
              <button class="x" data-del="${i}" title="删掉这一张">×</button>
            </div>`).join('') : '<div class="pr-loading">没有可用的画面，请点「重新润色」或取消</div>';
          okBtn.disabled = !items.length;
          body.querySelectorAll('textarea').forEach(ta => ta.oninput = () => { items[+ta.dataset.i].text = ta.value; });
          body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { items.splice(+b.dataset.del, 1); paint(); });
        };
        paint();
        okBtn.onclick = () => close(dlg, items.filter(x => (x.text || '').trim()), resolve);
        dlg.querySelector('#prCancel').onclick = () => close(dlg, null, resolve);
        dlg.addEventListener('cancel', e => { e.preventDefault(); close(dlg, null, resolve); });
        const retry = dlg.querySelector('#prRetry');
        if (o.retry) {
          retry.innerHTML = icon('refresh', 13) + ' 重新规划';
          retry.onclick = async () => {
            retry.disabled = true; retry.textContent = '规划中…';
            body.innerHTML = '<div class="pr-loading"><span class="spin-dot"></span>正在重新规划…</div>';
            try { items = (await o.retry()).map(x => ({ label: x.label, text: x.text })); }
            catch (e) { items = []; body.insertAdjacentHTML('afterbegin', `<div style="color:var(--err,#dc2626);font-size:12px;margin-bottom:8px">重新规划失败：${esc(e.message)}</div>`); }
            retry.disabled = false; retry.innerHTML = icon('refresh', 13) + ' 重新规划';
            paint();
          };
        } else retry.style.display = 'none';
      });
    },
  };
})();

/* ============================================================================
   Confirm —— 页内确认 / 选择弹窗（替代浏览器原生 confirm；样式与润色弹窗同一套）
   const ok = await Confirm.ask({ title, body, okLabel, cancelLabel, danger, sub });
   const v  = await Confirm.choose({ title, body, options: [{ value, label, hint }] });  // 取消返回 null
   ========================================================================== */
(function () {
  function shell(title, sub) {
    const dlg = document.createElement('dialog');
    dlg.id = 'cfDlg';
    dlg.innerHTML = `<div class="pr-head"><b>${window.esc(title)}</b>${sub ? `<div class="sub">${window.esc(sub)}</div>` : ''}</div>
      <div class="pr-body" id="cfBody"></div>
      <div class="pr-foot" id="cfFoot"></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    return { dlg, body: dlg.querySelector('#cfBody'), foot: dlg.querySelector('#cfFoot') };
  }
  const shut = (dlg, resolve, v) => { try { dlg.close(); } catch {} dlg.remove(); resolve(v); };
  window.Confirm = {
    ask(o) {
      return new Promise(resolve => {
        const { dlg, body, foot } = shell(o.title || '确认操作', o.sub);
        body.innerHTML = '<div class="cf-msg"></div>';
        body.querySelector('.cf-msg').textContent = o.body || '';
        const no = document.createElement('button');
        no.className = 'ghost'; no.textContent = o.cancelLabel || '取消';
        const yes = document.createElement('button');
        yes.className = 'pri' + (o.danger ? ' danger' : ''); yes.textContent = o.okLabel || '确定';
        foot.appendChild(Object.assign(document.createElement('span'), { className: 'sp' }));
        foot.appendChild(no); foot.appendChild(yes);
        no.onclick = () => shut(dlg, resolve, false);
        yes.onclick = () => shut(dlg, resolve, true);
        dlg.addEventListener('cancel', e => { e.preventDefault(); shut(dlg, resolve, false); });
        yes.focus();
      });
    },
    choose(o) {
      return new Promise(resolve => {
        const { dlg, body, foot } = shell(o.title || '请选择', o.sub);
        if (o.body) { body.innerHTML = '<div class="cf-msg" style="margin-bottom:12px"></div>'; body.querySelector('.cf-msg').textContent = o.body; }
        const box = document.createElement('div');
        box.className = 'cf-opts';
        (o.options || []).forEach(op => {
          const b = document.createElement('button');
          b.className = 'cf-opt';
          b.innerHTML = '<b></b><span></span>';
          b.querySelector('b').textContent = op.label || '';
          b.querySelector('span').textContent = op.hint || '';
          if (!op.hint) b.querySelector('span').remove();
          b.onclick = () => shut(dlg, resolve, op.value);
          box.appendChild(b);
        });
        body.appendChild(box);
        const no = document.createElement('button');
        no.className = 'ghost'; no.textContent = o.cancelLabel || '取消';
        foot.appendChild(Object.assign(document.createElement('span'), { className: 'sp' }));
        foot.appendChild(no);
        no.onclick = () => shut(dlg, resolve, null);
        dlg.addEventListener('cancel', e => { e.preventDefault(); shut(dlg, resolve, null); });
        const first = box.querySelector('.cf-opt');
        if (first) first.focus();
      });
    },
  };
})();

/* ============================================================================
   PromptForm —— 通用表单弹窗（AI 剪辑指令 / 剧本分镜 / 素材检索 共用）
   const v = await PromptForm.open({
     title, sub, okLabel,
     fields: [{ key, label, type:'textarea'|'text'|'number'|'select', value, placeholder, hint, options:[{v,t}] }],
   });   // 取消返回 null
   ========================================================================== */
(function () {
  window.PromptForm = {
    open(o) {
      return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.id = 'pfDlg';
        const fields = o.fields || [];
        dlg.innerHTML = `<div class="pf-head"><b>${esc(o.title || '输入')}</b>${o.sub ? `<div class="sub">${esc(o.sub)}</div>` : ''}</div>
          <div class="pf-body">${fields.map((f, i) => {
            const id = 'pf_' + i;
            let ctl;
            if (f.type === 'textarea') ctl = `<textarea id="${id}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`;
            else if (f.type === 'select') ctl = `<select id="${id}">${(f.options || []).map(x => `<option value="${esc(x.v)}"${String(x.v) === String(f.value) ? ' selected' : ''}>${esc(x.t)}</option>`).join('')}</select>`;
            else ctl = `<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value == null ? '' : String(f.value))}" placeholder="${esc(f.placeholder || '')}">`;
            return `<div class="pf-field" data-key="${esc(f.key)}"><label>${esc(f.label || '')}</label>${ctl}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
          }).join('')}</div>
          <div class="pf-foot"><span class="hint" id="pfMsg"></span><span class="sp"></span>
            <button class="ghost" id="pfCancel">取消</button><button class="pri" id="pfOk">${esc(o.okLabel || '确定')}</button></div>`;
        document.body.appendChild(dlg);
        dlg.showModal();
        const done = out => { try { dlg.close(); } catch {} dlg.remove(); resolve(out); };
        dlg.querySelector('#pfCancel').onclick = () => done(null);
        dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
        dlg.querySelector('#pfOk').onclick = () => {
          const out = {};
          dlg.querySelectorAll('.pf-field').forEach(el => {
            const k = el.dataset.key, ctl = el.querySelector('textarea,input,select');
            out[k] = ctl.value.trim();
          });
          if (o.validate) {
            const err = o.validate(out);
            if (err) { dlg.querySelector('#pfMsg').textContent = err; return; }
          }
          done(out);
        };
        const first = dlg.querySelector('textarea,input,select');
        if (first) setTimeout(() => first.focus(), 60);
      });
    },
  };
})();

/* ============================================================================
   Net —— 统一网络层（全站唯一的 fetch 出口）
     · 默认带超时（AbortController）：不会再有「按钮永久禁用、请求还挂着」的状态
     · 网络错误 / 5xx / 429 自动重试（退避）；4xx 不重试（参数错，重试也没用）
     · 非 JSON 响应给可读错误，而不是把 HTML 错误页当数据用
     · blob() 先判 r.ok —— 下载/另存/取素材统一走它，不再把 404 页面存成 .mp4
   用法：
     await Net.json(url, { timeout: 8000, retry: 2 })
     const b = await Net.blob(url, { timeout: 120000 })
     await Net.save(b, 'xxx.mp4')          // 触发浏览器下载（自动回收 blob URL）
   ========================================================================== */
(function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const DEFAULT_TIMEOUT = 30000;
  const RETRY_DELAY = 600;
  /* 超时 / 重试次数可在「设置 → 网络与刷新」里改（存 localStorage，改完立即生效） */
  const cfg = { timeout: DEFAULT_TIMEOUT, retry: 1 };
  /* 读数字配置：没存过（null）不能当成 0 —— 那会把「重试 1 次」的默认值悄悄变成「不重试」，
     网络一抖动就不重试了，很难查。 */
  function readNum(key, def, min, max) {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  }
  function reloadConfig() {
    cfg.timeout = readNum('sk_net_timeout', DEFAULT_TIMEOUT / 1000, 5, 300) * 1000;
    cfg.retry = readNum('sk_net_retry', 1, 0, 5);
  }
  try { reloadConfig(); } catch {}
  window.addEventListener('storage', e => { if (!e.key || String(e.key).startsWith('sk_net_')) reloadConfig(); });

  function readable(e, timeout) {
    if (!e) return new Error('请求失败');
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return new Error(timeout ? `请求超时（${Math.max(1, Math.round(timeout / 1000))} 秒没有响应）` : '请求已取消');
    }
    const m = String(e.message || e);
    if (/Failed to fetch|NetworkError|ERR_|fetch failed/i.test(m)) {
      const err = new Error('连不上本地代理（proxy.js 没启动？改完 proxy.js 要重启）');
      err.__net = true;                       // 网络层失败：交给 fetch 判断代理到底活没活着（见下）
      return err;
    }
    return e instanceof Error ? e : new Error(m);
  }
  /* 代理是否活着 —— 只在「网络层失败」时探一次，用来区分两件完全不同的事：
       · 代理真没起来 / 端口不通  → 提示重启 proxy.js 是对的；
       · 代理活着，只是这次连接被掐断（代理刚重启、上游把连接 RST、系统掐了长连接）→ 让人去重启是误导。
     这个区分在提交类请求上尤其要紧：POST 被掐断时平台很可能已经受理了，
     提示成「失败」会诱导用户再点一次 → 平台上出现两条重复任务。 */
  let aliveAt = 0, aliveOk = false, aliveProbe = null;
  function proxyAlive() {
    if (Date.now() - aliveAt < 3000) return Promise.resolve(aliveOk);
    if (aliveProbe) return aliveProbe;
    /* 探测也要有超时：端口被丢弃包（而非拒绝）时 fetch 会挂很久，错误就迟迟不显示 */
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    aliveProbe = fetch('/registry', { method: 'GET', cache: 'no-store', signal: ctl.signal })
      .then(r => { aliveOk = !!r && r.ok; return aliveOk; })
      .catch(() => { aliveOk = false; return false; })
      .then(v => { clearTimeout(timer); return v; })
      .then(v => { aliveAt = Date.now(); aliveProbe = null; return v; });
    return aliveProbe;
  }

  window.Net = {
    DEFAULT_TIMEOUT,
    reloadConfig,        // 设置页改完超时/重试后调用
    /* 返回原始 Response（已判超时与重试；状态码交给调用方处理） */
    async fetch(url, opts = {}) {
      const method = String(opts.method || 'GET').toUpperCase();
      const timeout = opts.timeout === undefined ? cfg.timeout : opts.timeout;
      /* 重试策略：网络抖动 / 5xx / 429 才重试，且**默认只重试幂等方法**（GET/HEAD/PUT/DELETE/OPTIONS）。
         POST 只有在带幂等键时才允许重试 —— 服务端按键去重，重试不会建出第二条任务；
         没带键的 POST 一律不重试：请求已发出但响应超时的情况下，重试会重复建任务、重复扣费。
         （哪些平台支持幂等键由 registry 的 create.idempotencyKey 声明，见 proxy.js / assetlib.js） */
      const hdr = opts.headers;
      const hasIdem = !!(hdr && (typeof hdr.get === 'function'
        ? hdr.get('Idempotency-Key')
        : (hdr['Idempotency-Key'] || hdr['idempotency-key'])));
      const idempotent = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(method);
      const retryCfg = opts.retry === undefined ? cfg.retry : opts.retry;
      const retry = (idempotent || hasIdem) ? retryCfg : 0;
      let lastErr = null;
      for (let attempt = 0; attempt <= retry; attempt++) {
        const ctl = new AbortController();
        const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : null;
        const ext = opts.signal;
        /* 区分「自己超时」与「调用方主动取消」：两者都是 AbortError，
           不记下来会把用户点的取消报成「请求超时」。 */
        let cancelled = false;
        const onExt = () => { cancelled = true; ctl.abort(); };
        if (ext) { if (ext.aborted) { cancelled = true; ctl.abort(); } else ext.addEventListener('abort', onExt, { once: true }); }
        try {
          const r = await fetch(url, { ...opts, signal: ctl.signal });
          // 5xx / 429 才重试：4xx 是请求本身的问题
          if (!r.ok && (r.status >= 500 || r.status === 429) && attempt < retry) {
            lastErr = new Error('HTTP ' + r.status);
            await sleep(RETRY_DELAY * (attempt + 1));
            continue;
          }
          return r;
        } catch (e) {
          lastErr = cancelled ? new Error('请求已取消') : readable(e, timeout);
          if (attempt < retry) { await sleep(RETRY_DELAY * (attempt + 1)); continue; }
          break;      // 重试也用完了：跳出循环，交给循环外的统一收尾（在那里判断「代理是否还活着」并富化文案）
        } finally {
          if (timer) clearTimeout(timer);
          if (ext) ext.removeEventListener('abort', onExt);
        }
      }
      /* 走到这里说明重试也用完了。若是网络层失败，先探一下代理：
         活着 → 说清是「连接中断」而不是「没启动」；提交类再补一句「可能已受理」，
         免得用户把一次已经成功的提交当成失败、重复点。 */
      if (lastErr && lastErr.__net) {
        const alive = await proxyAlive();
        if (alive) {
          const writing = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
          lastErr = new Error(writing
            ? '与本地代理的连接在提交过程中中断了（代理可能刚重启，或长连接被掐断）。'
              + '**这次提交可能已经到达平台**：先刷新列表核对有没有这条任务，确认没有再用「重试」，避免重复提交／重复扣费。'
            : '与本地代理的连接中断了（代理可能刚重启，或长连接被掐断）：重试一次通常就好。');
          lastErr.maybeSubmitted = writing;
        }
      }
      throw lastErr || new Error('请求失败');
    },
    /* 取 JSON：非 2xx 抛带 status 的错误（错误文案优先用上游给的 message） */
    async json(url, opts = {}) {
      const r = await this.fetch(url, opts);
      const txt = await r.text();
      let d = null, parseErr = null;
      try { d = txt ? JSON.parse(txt) : null; } catch (e) { parseErr = e; }
      if (!r.ok) {
        const e = new Error(upstreamMsg(d) || ('HTTP ' + r.status));
        e.status = r.status;
        e.data = d;
        throw e;
      }
      if (d === null && parseErr) throw new Error('返回了非 JSON 内容（HTTP ' + r.status + '）');
      return d;
    },
    /* 取二进制：**先判 HTTP 状态**再转 blob，避免把错误页当成品存盘 */
    async blob(url, opts = {}) {
      const r = await this.fetch(url, opts);
      if (!r.ok) { const e = new Error('下载失败 HTTP ' + r.status); e.status = r.status; throw e; }
      const b = await r.blob();
      if (!b.size) throw new Error('下载到的内容是空的');
      return b;
    },
    /* 触发下载（统一回收 blob URL，避免内存泄漏） */
    save(blob, filename) {
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = filename || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000);
    },
    errorText(e) { return (e && e.message) ? e.message : String(e || '未知错误'); },
  };
  function upstreamMsg(d) {
    if (!d) return '';
    return (d.error && (d.error.message || d.error.code)) || d.message || d.error || '';
  }
})();

/* ============================================================================
   Toast —— 全站统一的轻提示（替代「只 console.log」与「中性消息被丢弃」）
     Toast.ok('已保存') / Toast.err(e) / Toast.warn('…') / Toast.info('…')
     toast('一句话', 'ok')    ← 简写
     堆叠在内容区右上角，几秒后自动消失；同一句话短时间内不重复弹。
   ========================================================================== */
(function () {
  let box = null, last = { t: '', ts: 0 };
  function host() {
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.className = 'toast-box';
    document.body.appendChild(box);
    return box;
  }
  const ICON = { ok: '✓', err: '!', warn: '!', info: 'i' };
  window.Toast = {
    show(text, type, ms) {
      const msg = String(text == null ? '' : text).trim();
      if (!msg) return;
      const kind = ICON[type] ? type : 'info';
      const now = Date.now();
      if (msg === last.t && now - last.ts < 1500) return;    // 去重：同一句话不连弹
      last = { t: msg, ts: now };
      const el = document.createElement('div');
      el.className = 'toast ' + kind;
      el.innerHTML = `<span class="ic"></span><span class="tx"></span>`;
      el.querySelector('.ic').textContent = ICON[kind];
      el.querySelector('.tx').textContent = msg;
      const h = host();
      h.appendChild(el);
      while (h.children.length > 4) h.firstElementChild.remove();
      const life = ms || (kind === 'err' ? 6000 : 3200);
      const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
      el.onclick = kill;
      setTimeout(kill, life);
    },
    ok(t, ms) { this.show(t, 'ok', ms); },
    err(t, ms) { this.show(typeof t === 'object' ? Net.errorText(t) : t, 'err', ms); },
    warn(t, ms) { this.show(t, 'warn', ms); },
    info(t, ms) { this.show(t, 'info', ms); },
  };
  window.toast = (t, type, ms) => window.Toast.show(t, type, ms);
})();

/* ============================================================================
   Store —— 带版本与上限的本地存储（各页面历史记录统一走它）
     · 统一信封 { v: 版本, data: 值 }：以后改字段结构可以按版本迁移，
       读到旧格式（裸数组）自动当上一版迁移，不再「改了结构老数据就崩」
     · 写入失败（配额满 / 隐私模式）会**返回错误并提示**，不再静默丢数据
   用法：
     const list = Store.read('img_hist', [], { version: 2, migrate: (d, from) => [...] });
     Store.write('img_hist', list, { cap: 200, label: '图片历史' });
   ========================================================================== */
(function () {
  const ok = () => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch { return false; } };
  window.Store = {
    available: ok(),
    read(key, def, opts = {}) {
      let raw = null;
      try { raw = localStorage.getItem(key); } catch { return def; }
      if (raw == null) return def;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { return def; }        // 坏值：当空处理，别让一条脏数据卡死整页
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && Object.prototype.hasOwnProperty.call(parsed, 'data') && Object.prototype.hasOwnProperty.call(parsed, 'v')) {
        const from = Number(parsed.v) || 0;
        const to = Number(opts.version) || 0;
        if (from !== to && typeof opts.migrate === 'function') {
          try { return opts.migrate(parsed.data, from); } catch (e) { console.warn('[Store] ' + key + ' 迁移失败：', e); return def; }
        }
        return parsed.data;
      }
      // 旧格式（裸值）：交给 migrate 升级，没有 migrate 就原样用
      if (opts.version && typeof opts.migrate === 'function') {
        try { return opts.migrate(parsed, 0); } catch { return parsed; }
      }
      return parsed;
    },
    /* 返回 { ok, error }；cap 会对数组自动截断（总量控制，避免写爆配额） */
    write(key, val, opts = {}) {
      let v = val;
      if (opts.cap && Array.isArray(v) && v.length > opts.cap) v = v.slice(0, opts.cap);
      /* 序列化也要包在 try 里：数据里混进 BigInt / 循环引用时 JSON.stringify 会直接抛，
         以前它在 try 之外 —— 一次脏数据就把整个保存流程打断（页面后续逻辑全不执行）。 */
      let body;
      try {
        body = JSON.stringify({ v: Number(opts.version) || 0, data: v, ts: Date.now() });
      } catch (e) {
        const msg = `${opts.label || '本地记录'}保存失败：数据里有无法序列化的内容（${e.message}）`;
        if (window.Toast) window.Toast.err(msg);
        console.warn('[Store] 序列化失败 ' + key + '：', e);
        return { ok: false, error: e, serialize: true };
      }
      try {
        localStorage.setItem(key, body);
        return { ok: true, bytes: body.length };
      } catch (e) {
        const quota = /quota|exceed|full/i.test(String(e && e.name) + String(e && e.message));
        const msg = quota
          ? `${opts.label || '本地记录'}已占满浏览器存储（上限约 5MB），本次没能保存：请到「资产库」清理或用「另存为」保存到本地`
          : `${opts.label || '本地记录'}保存失败：${e.message}`;
        if (window.Toast) window.Toast.err(msg);
        console.warn('[Store] 写入失败 ' + key + '：', e);
        return { ok: false, error: e, quota };
      }
    },
    /* 信封里的写入时间（同步时比新旧用；老数据没有这个字段当 0） */
    tsOf(key) {
      try {
        const p = JSON.parse(localStorage.getItem(key) || 'null');
        return (p && typeof p === 'object' && !Array.isArray(p) && p.ts) ? Number(p.ts) : 0;
      } catch { return 0; }
    },
  };
})();

/* ============================================================================
   SbBal —— 侧栏「账户余额」显示哪几个接口的余额（设置页勾选，侧栏现读）
   ---------------------------------------------------------------------------
   存的是**隐藏**名单而不是显示名单：这样新接入的平台默认就会出现在侧栏，
   不用回到设置页再勾一次。读写只有这一份实现（设置页跑在 iframe 里、侧栏在外壳里，
   两边靠 storage 事件联动，所以必须共用键名与结构）。
   ========================================================================== */
(function () {
  const KEY = 'sb_bal_show';
  window.SbBal = {
    KEY,
    off() { return (window.Store && Store.read(KEY, {}, { label: '侧栏余额显示设置' }) || {}).off || []; },
    isOff(kid) { return this.off().indexOf(kid) >= 0; },
    setOff(kid, off) {
      const s = new Set(this.off());
      if (off) s.add(kid); else s.delete(kid);
      Store.write(KEY, { off: [...s] }, { label: '侧栏余额显示设置' });
      return [...s];
    },
    /* 按勾选过滤余额行（rows 里每条要带 kid = registry 的 keyId） */
    filter(rows) { const s = new Set(this.off()); return (rows || []).filter(r => !s.has(r.kid)); },
  };
})();

/* ============================================================================
   DataSync —— 与本地代理的数据文件同步（方案 A：把浏览器私有数据变成磁盘上的普通文件）
   ---------------------------------------------------------------------------
   为什么要有它：localStorage / IndexedDB 是「浏览器私有且随时可能被清掉」的 —— 清一次浏览器数据、
   换浏览器、开无痕，工作区和设置就没了。这里把业务数据同时写一份到项目目录 .data/ 下的 JSON 文件，
   于是它看得见、能备份、也能被云盘或 /cloud 同步。
     · mirror(key, body)  写完 localStorage 后顺带写一份到服务器（提前 800ms 合并突发写）
     · boot()             启动时和服务器比时间戳：谁新用谁（服务器新 → 覆盖本地并刷新一次）；
                          本地有而服务器没有（首次启用）也会补传上去
     · pushAll()/pullAll()  手动全量推/拉（设置页按钮与云同步前用）
   ========================================================================== */
(function () {
  /* 参与同步的键（前缀或全名）。刻意**不含**首屏缓存（*_cache_v1，可随时重建）与一次性的 sk_reuse */
  const SYNCABLE = [
    'sk_key_', 'sk_base_', 'sk_model_', 'sk_text_vision', 'sk_polish_', 'sk_net_', 'sk_poll_sec',
    'ai_usage', 'sparkcine_gallery', 'audio_tasks', 'fav_items',   // 视频台不再有本地任务（卡片来自接口）
    'page_mode_', 'page_size_', 'dir_theme',
    /* 界面布局偏好：分栏比例（三个工作台 + 语音台共用 wb_split、导演台 dir_split）、
       资产库/收藏的视图档位、侧栏开合与余额勾选、导演台的候选展开与静音。
       以前只存浏览器本地 → 换台机器（或清一次浏览器数据）栏宽和视图全丢，
       而它们和 dir_theme 一样属于「用户调出来的界面」，该跟着数据文件走。
       刻意不写整个 'dir_' 前缀：dir_img / dir_video / dir_audio / dir_render 是**本机磁盘路径**，
       换台机器就不成立（和 prompt_dir 同理，见下面的注释）。 */
    'wb_split', 'dir_split', 'dir_asset_view', 'dir_fav_view', 'dir_cand_expand', 'dir_muted', 'sb_open', 'sb_bal_show',
    /* 注意：提示词不再进 localStorage，改存归档文件夹（PromptLog → /prompts），
       归档目录 prompt_dir 也刻意不在这里 —— 换台机器路径就不一样，跟着云同步反而添乱 */
  ];
  /* 前缀匹配会把「缓存」也算进来（audio_tasks_cache_v1 会被 audio_tasks 命中），所以再排一次 */
  const NOT_SYNC = ['_cache_v1', 'sk_reuse', 'sk_model_meta_'];
  const TOL = 3000;                          // 容忍 3 秒的时钟/写入误差，避免两边来回覆盖
  const pending = new Map();                 // key → { t: 定时器, body: 待发内容（null = 删除） }
  const sanitize = k => k.replace(/[^A-Za-z0-9_-]/g, '_');

  const syncable = key => !!key
    && !NOT_SYNC.some(x => key === x || key.endsWith(x) || key.startsWith(x))
    && SYNCABLE.some(p => key === p || key.startsWith(p));

  async function putData(key, body) {
    const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, timeout: 15000, retry: 0,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }
  async function delData(key) {
    const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), { method: 'DELETE', timeout: 15000, retry: 0 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  }
  /* 读回某个数据文件的内容，**返回原始文本**。
     不能假设是 JSON：同步的键里有一半存的是普通字符串
     （dir_theme=dark、sk_polish_*=提示词文本、sk_key_*=密钥、page_mode_=page…），
     JSON.parse 会直接抛错。需要对象的地方由调用方自己 JSON.parse。 */
  async function getData(key) {
    const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), { timeout: 15000, retry: 0 });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  let mirrorBroken = false;                  // 已经提示过一次就别刷屏
  /* 突发写合并：同一个键 800ms 内只发最后一次（导演台每 500ms 就去抖保存，直接发会把代理刷爆）。
     队列里连**内容**一起记下来：body 为 null 表示「本地删了」，flush 时必须走删除接口 ——
     以前队列只记定时器、flush 时再去读 localStorage，删除任务就被丢掉了
     （服务器文件没删 → 下次 boot 把已删数据又拉回本地）。
     tries = 已经失败几次：失败**不能把任务丢掉**（以前一失败就只剩一句 Toast，
     那份修改永远停在浏览器里，代理重启/网络抖一下就算白写），
     按 800ms×3 的退避重试，最多 4 次；本地 localStorage 始终是写成功的，所以只是「晚一点落盘」。 */
  const RETRY_MAX = 4;
  /* 对账（boot）跑完之前，本地写入先进暂存表，不立刻镜像到 .data/。
     boot 的拉取是异步的：一个刚打开的页面 —— 尤其是一个全新的浏览器上下文
     （自动化验证、换机器、清过浏览器数据）—— 完全可能在读到数据文件之前就写了一次
     「它以为的内容」。那次写走的是「最后写入者赢」，会把还没读到的真实数据整个顶掉
     （收藏就是这么被清空的）。
     对账结束后统一补发：queue 本来就会比对本机当前值，
     已经被 boot 覆盖掉的过期暂存自然丢弃，真正属于本机的修改照常落盘。 */
  let booting = false;
  const held = new Map();                        // key → 待发内容（null = 删除）
  function releaseHeld() {
    const jobs = [...held.entries()];
    held.clear();
    for (const [k, body] of jobs) queue(k, body);
  }
  function queue(key, body, tries) {
    const k = sanitize(key);
    const payload = body == null ? null : String(body);
    if (booting && !tries) { held.set(k, payload); return; }
    const prev = pending.get(k);
    if (prev) clearTimeout(prev.t);
    const n = tries || 0;
    const t = setTimeout(async () => {
      pending.delete(k);
      /* 发之前再看一眼本机当前值：合并窗口里如果值被别处改写（例如 boot 刚从服务器拉回更新的一份），
         这条任务就已经过期，发出去会把旧的盖给新的。 */
      const cur = localStorage.getItem(k);
      if (payload == null ? (cur != null && cur !== '') : cur !== payload) return;
      try {
        if (payload == null) await delData(k);
        else await putData(k, payload);
      } catch (e) {
        if (n < RETRY_MAX) {
          queue(k, payload, n + 1);
        } else {
          /* 重试也用完：把任务**留在队列里**（没有定时器的死信），
             下次开页面（boot 里的 flush）或去设置页点同步时还会再试一次。
             以前这里是直接丢弃 + 一句 Toast，删除类任务一丢就永远丢了 ——
             服务器那份还在，之后每次启动都被它把已删的数据拉回浏览器。 */
          pending.set(k, { t: 0, body: payload, tries: n, failed: e.message });
          if (!mirrorBroken) {
            mirrorBroken = true;
            if (window.Toast) window.Toast.warn('本机已保存，但数据文件（.data/）没写成功：' + e.message + '（不影响使用，可稍后到「设置 → 数据与同步」重试）');
          }
        }
      }
    }, n ? Math.min(20000, 800 * Math.pow(3, n)) : 800);
    pending.set(k, { t, body: payload, tries: n });
  }
  /* 关页面 / 切到后台时把还没发出去的写送出去：
     800ms 合并窗口 + 网络往返经常来不及，「改完就关标签页」那一次修改会丢。
     keepalive 让浏览器在页面卸载后仍把请求发完（单请求上限约 64KB，超了只能尽力而为 ——
     真正的兜底是 boot() 里「本地比服务器新就补传」那段）。 */
  function flushKeepalive() {
    const jobs = [...pending.entries()];
    if (!jobs.length) return;
    for (const [key, job] of jobs) {
      clearTimeout(job.t);
      /* 和 queue 的定时器、flush 一样先看本机当前值：boot 对账期间暂存的写补发之后，
         页面经常马上被刷新一次（changed→reload），这条任务很可能已经被服务器那份覆盖，
         不做这一步就会把「拉回真实数据之前那份误写」用 keepalive 送出去，用户数据又被顶掉。 */
      const cur = localStorage.getItem(key);
      if (job.body == null ? (cur != null && cur !== '') : cur !== job.body) continue;
      const url = '/data/' + encodeURIComponent(key);
      const keep = job.body == null || job.body.length < 60000;
      try {
        fetch(url, job.body == null
          ? { method: 'DELETE', keepalive: keep }
          : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: job.body, keepalive: keep });
      } catch {}
    }
    pending.clear();
  }
  window.addEventListener('pagehide', flushKeepalive);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushKeepalive(); });
  /* 从服务器写回本地的值不要再镜像一次：钩子会把刚拉下来的内容又 PUT 回服务器，
     于是「只是拉了一份一样的数据」也把服务器文件的 mtime 顶新 ——
     另一台机器据此以为云端更新，两边的新旧关系被自己搅乱，还会白白多发 N 个请求。 */
  let selfWrite = false;
  function localSet(key, value) {
    selfWrite = true;
    try { localStorage.setItem(key, value); } finally { selfWrite = false; }
  }
  /* 统一钩子：把 localStorage 的写入/删除接到镜像上。
     为什么不在各调用点手动调 mirror：全站有几十处直接 localStorage.setItem（任务提示词记录、
     文字 AI 用量、收藏、设置项…），漏一处那份数据就不会落盘。挂钩子能一次覆盖所有现存与将来的写入。 */
  (function hookStorage() {
    try {
      const proto = window.Storage && window.Storage.prototype;
      if (!proto || proto.__scHooked) return;
      const rawSet = proto.setItem, rawDel = proto.removeItem;
      proto.setItem = function (k, v) {
        rawSet.call(this, k, v);
        try { if (this === localStorage && !selfWrite && syncable(k)) queue(k, String(v)); } catch {}
      };
      proto.removeItem = function (k) {
        rawDel.call(this, k);
        try { if (this === localStorage && syncable(k)) queue(k, null); } catch {}
      };
      proto.__scHooked = true;
    } catch (e) { console.warn('[DataSync] 存储钩子安装失败（数据仍可用，只是不自动落盘）：', e.message); }
  })();
  window.DataSync = {
    SYNCABLE, syncable, TOL,
    /* 本地 → 服务器（突发写合并：同一键 800ms 内只发最后一次） */
    mirror(key, body) {
      if (!syncable(key)) return;
      queue(key, body);
    },
    /* 导演台的工作区存在 IndexedDB（不是 localStorage 键），走同一条发送管道单独镜像 */
    mirrorWs(body) { queue('workspace', body); },
    /* 取服务器上的工作区；比本地新才返回（否则 null，让页面继续用本地的） */
    async workspaceFromServer(localTs) {
      try {
        const r = await window.Net.fetch('/data', { timeout: 10000, retry: 0 });
        if (!r.ok) return null;
        const f = ((await r.json()).files || []).find(x => x.key === 'workspace');
        if (!f || f.mtime <= (Number(localTs) || 0) + TOL) return null;
        const txt = await getData('workspace');
        if (!txt) return null;
        const d = JSON.parse(txt);
        return (d && d.data) ? d.data : null;
      } catch { return null; }
    },
    /* 云端拉取之后必须让 boot() 再跑一次：它按「每页每会话只跑一次」防循环，
       而「从云端下载 → 刷新页面」正是在同一会话里发生的 —— 不清这个标记，
       刚拉下来的数据不会进浏览器（页面看起来像没同步）。 */
    resetBootFlags() {
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith('__synced_')) sessionStorage.removeItem(k);
        }
      } catch {}
    },
    /* 立即把所有待发送的写推上去（设置页/云同步前调用） */
    async flush() {
      const jobs = [...pending.entries()];
      pending.clear();
      let n = 0;
      for (const [key, job] of jobs) {
        if (job.t) clearTimeout(job.t);
        /* 队列里的内容已经不是本机当前值了（期间用户又写过，或者 boot 刚从服务器拉回更新的一份）
           → 这条任务过期，直接丢掉：再发会把较旧的内容盖到较新的上面（云端那份还会被顶掉）。 */
        const cur = localStorage.getItem(key);
        if (job.body == null ? (cur != null && cur !== '') : cur !== job.body) continue;
        try {
          /* 待删除的键走删除接口：以前只对有值的键 put，删除任务被静默丢弃，
             服务器上的文件还在，下次 boot 会把已经删掉的数据拉回来。 */
          if (job.body == null) { await delData(key); n++; }
          else { await putData(key, job.body); n++; }
        } catch (e) {
          /* 还是没送出去：重新入队（再走一遍退避重试），不要只留一句注释「交给 pushAll」。
             pushAll 只推「本地有值」的键，删除类任务它不会补，于是那条删除永远停在内存里。 */
          queue(key, job.body);
        }
      }
      return n;
    },
    /* 本地已有的可同步键 */
    localKeys() {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (syncable(k)) out.push(k);
        }
      } catch {}
      return out;
    },
    /* 启用功能时的一次性补传：本地有、服务器没有的，全部推上去 */
    async pushAll() {
      const r = await window.Net.fetch('/data', { timeout: 15000, retry: 0 });
      if (!r.ok) throw new Error('读不到数据目录清单（HTTP ' + r.status + '）');
      const files = (await r.json()).files || [];
      const onServer = new Set(files.map(f => f.key));
      let n = 0;
      for (const key of this.localKeys()) {
        const body = localStorage.getItem(key);
        if (!body) continue;
        const srv = files.find(f => f.key === sanitize(key));
        const localTs = window.Store.tsOf(key);
        if (srv && localTs <= srv.mtime + TOL) continue;        // 服务器不旧 → 不用传
        try { await putData(key, body); n++; } catch (e) { console.warn('[DataSync] 上传 ' + key + ' 失败：', e.message); }
      }
      return n;
    },
    /* 服务器 → 本地，返回被覆盖的键数 */
    async pullAll() {
      const r = await window.Net.fetch('/data', { timeout: 15000, retry: 0 });
      if (!r.ok) throw new Error('读不到数据目录清单（HTTP ' + r.status + '）');
      const files = (await r.json()).files || [];
      let n = 0;
      for (const f of files) {
        const key = f.key;
        if (!syncable(key)) continue;
        const localTs = window.Store.tsOf(key);
        if (localTs && localTs >= f.mtime - TOL) continue;      // 本地不旧 → 不覆盖
        try {
          const txt = await getData(key);
          if (txt == null) continue;
          const cur = localStorage.getItem(key);
          if (cur === txt) continue;                       // 内容一样 → 不用写
          localSet(key, txt);
          n++;
        } catch (e) { console.warn('[DataSync] 拉取 ' + key + ' 失败：', e.message); }
      }
      return n;
    },
    /* 启动时自动对账：服务器有更新就覆盖本地并刷新一次（每页每次会话只刷一次，避免循环） */
    async boot() {
      if (!window.Store.available) return;
      const page = (location.pathname.split('/').pop() || 'index.html');
      const flag = '__synced_' + page;
      try {
        if (sessionStorage.getItem(flag)) return;              // 本次会话已经同步过
        booting = true;                                        // 对账期间本地写入先暂存（见 queue 里的说明）
        const r = await window.Net.fetch('/data', { timeout: 8000, retry: 0 });
        if (!r.ok) return;
        const files = (await r.json()).files || [];
        const byKey = new Map(files.map(f => [f.key, f]));
        const localKeys = this.localKeys();
        if (!files.length && !localKeys.length) return;        // 全新环境，没什么可同步
        let changed = 0, seeded = 0, repaired = 0;
        const byteLen = s => { try { return new TextEncoder().encode(s).length; } catch { return s.length; } };
        /* 遍历「本地 ∪ 数据文件」而不是只遍历本地：
           只遍历本地的话，清掉浏览器数据后（localStorage 为空）反而什么都不会恢复 ——
           而「清缓存后自动恢复」正是这个功能的目的。 */
        for (const key of new Set([...localKeys, ...byKey.keys()])) {
          if (!syncable(key)) continue;                        // 数据文件里还有 workspace 这类非 localStorage 键
          const srv = byKey.get(sanitize(key));
          byKey.delete(sanitize(key));                         // 处理过就出队（下面只按本轮的键判断，不重复处理）
          const localRaw = localStorage.getItem(key);           // 注意：空字符串也算「本地没有」（老数据可能是空值）
          if (!localRaw) {
            /* 本地没有、数据文件里有 → 「浏览器数据被清过 / 换了台机器」：拉回来。
               以前这个情况在下面会命中两处分支：多发一次请求、changed 计数翻倍。 */
            if (!srv) continue;
            try {
              const remoteRaw = await getData(key);
              if (remoteRaw != null && remoteRaw !== '') { localSet(key, remoteRaw); changed++; }
            } catch (e) { console.warn('[DataSync] 恢复 ' + key + ' 失败：', e.message); }
            continue;
          }
          if (!srv) {                                          // 数据文件里没有 → 先把本机已有数据补传上去
            try { await putData(key, localRaw); seeded++; } catch (e) {}
            continue;
          }
          /* 两边都有：先比体积（便宜的启发式），体积相同**不能直接跳过** ——
             等长修改（grid→list、换一个等长的密钥 / 模型名）体积一模一样，
             只看体积的话另一台机器的更新永远拉不回来，两边状态静默分叉。
             体积相同但服务器文件更新时，照样取回来逐字节比对。 */
          const localTs = window.Store.tsOf(key);
          const sameSize = Math.abs(srv.size - byteLen(localRaw)) <= 1;
          /* 本地明确比数据文件新 → 这是**上次没发出去的写**（代理当时没启动 / 关页面时来不及 /
             重试也用完了）。以前这里只是「保留本地的」然后什么都不做，于是 .data/ 永远停在旧内容，
             云同步、换机器、备份拿到的都是那份旧的 —— 现在顺手补传一次。
             （只有带 ts 的信封格式能判出来；纯字符串的值 ts=0，不参与这条，交给写钩子。） */
          if (localTs && localTs > srv.mtime + TOL) {
            try { await putData(key, localRaw); repaired++; } catch (e) {}
            continue;
          }
          if (sameSize && srv.mtime <= localTs + TOL) continue;         // 体积相同且服务器不新 → 不用管
          if (localTs && srv.mtime <= localTs + TOL) continue;          // 本地不旧 → 保留本地的
          let remoteRaw = null;
          try { remoteRaw = await getData(key); } catch (e) { console.warn('[DataSync] 拉取 ' + key + ' 失败：', e.message); continue; }
          if (remoteRaw == null || remoteRaw === localRaw) continue;    // 内容一样 → 不动，也不刷新
          try { localSet(key, remoteRaw); changed++; } catch {}
        }
        /* 上面那些「上次没送出去」的任务（代理当时没启动 / 重试次数用完）在这里补一次。
           flush 会自己判过期，不会把旧内容盖到新内容上。 */
        if (pending.size) { try { await this.flush(); } catch (e) {} }
        sessionStorage.setItem(flag, '1');
        if (changed) {
          if (window.Toast) window.Toast.info('已从本机数据文件同步 ' + changed + ' 项，正在刷新…');
          setTimeout(() => location.reload(), 600);
        } else if (repaired) {
          console.log('[DataSync] 补传 ' + repaired + ' 项没落盘的本地修改到 .data/');
        } else if (seeded) {
          console.log('[DataSync] 首次启用：已把 ' + seeded + ' 项本机数据写入 .data/');
        }
      } catch (e) { console.warn('[DataSync] 启动同步跳过：', e.message); }
      finally { booting = false; releaseHeld(); }               // 不管对账成不成功，暂存的本地写入都要补发
    },
    /* ---------- 浏览器持久化存储（方案 B）----------
       让浏览器不因磁盘紧张自动回收 IndexedDB/localStorage（不防用户手动清理）。
       返回 { supported, granted }；设置页会显示状态。 */
    async persist() {
      if (!navigator.storage || !navigator.storage.persist) return { supported: false, granted: false };
      try {
        if (navigator.storage.persisted && await navigator.storage.persisted()) return { supported: true, granted: true };
        const granted = await navigator.storage.persist();
        return { supported: true, granted };
      } catch { return { supported: true, granted: false }; }
    },
    async persistState() {
      if (!navigator.storage || !navigator.storage.persisted) return { supported: false };
      try {
        const granted = await navigator.storage.persisted();
        let usage = null;
        if (navigator.storage.estimate) {
          const e = await navigator.storage.estimate();
          usage = { usedMB: +(e.usage / 1048576).toFixed(1), quotaMB: Math.round(e.quota / 1048576) };
        }
        return { supported: true, granted, usage };
      } catch { return { supported: true, granted: false }; }
    },

    /* ---------- 整包备份 / 恢复（方案 C）----------
       把「浏览器里的全部数据」打成一个 JSON：
         · localStorage 里参与同步的业务键（含密钥，导出时会明确提示）
         · IndexedDB：导演台工作区、本地导入的视频、收藏的本地文件、音色复刻的参考音频
       本地文件（Blob）按需打包：只导出数据时跳过，打包文件时转成 base64。
       IndexedDB 的库/表清单来自实际使用：director_db/kv、fav_db/files、wb_blobs/blobs。 */
    IDB_TARGETS: [
      { db: 'director_db', store: 'kv', label: '导演台工作区与本地视频' },
      { db: 'fav_db', store: 'files', label: '收藏的本地文件' },
      { db: 'wb_blobs', store: 'blobs', label: '音色复刻的参考音频' },
    ],
    _idbOpen(dbName, storeName) {
      return new Promise(res => {
        let r;
        try { r = indexedDB.open(dbName, 1); } catch { return res(null); }
        r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(storeName)) r.result.createObjectStore(storeName); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
    },
    async _idbDump(dbName, storeName, withBlobs) {
      const d = await this._idbOpen(dbName, storeName);
      if (!d) return [];
      const rows = await new Promise(res => {
        const out = [];
        try {
          const t = d.transaction(storeName, 'readonly');
          const q = t.objectStore(storeName).openCursor();
          q.onsuccess = e => {
            const c = e.target.result;
            if (!c) { res(out); return; }
            out.push([c.key, c.value]); c.continue();
          };
          q.onerror = () => res(out);
        } catch { res(out); }
      });
      const enc = [];
      for (const [k, v] of rows) {
        if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && typeof v.size === 'number') {
          if (!withBlobs) continue;                                  // 跳过大文件
          try {
            const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(v); });
            enc.push([k, { __blob: true, type: v.type || '', b64 }]);
          } catch (e) { console.warn('[DataSync] 打包文件失败 ' + k + '：', e.message); }
        } else enc.push([k, v]);
      }
      return enc;
    },
    async _idbRestore(dbName, storeName, rows) {
      const d = await this._idbOpen(dbName, storeName);
      if (!d || !rows || !rows.length) return 0;
      let n = 0;
      for (const [k, v] of rows) {
        let val = v;
        if (v && v.__blob) {
          try {
            const bin = atob(v.b64 || '');
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            val = new Blob([arr], { type: v.type || 'application/octet-stream' });
          } catch { continue; }
        }
        try {
          await new Promise((res, rej) => {
            const t = d.transaction(storeName, 'readwrite');
            t.objectStore(storeName).put(val, k);
            t.oncomplete = res; t.onerror = () => rej(t.error);
          });
          n++;
        } catch (e) { console.warn('[DataSync] 写入 ' + k + ' 失败：', e.message); }
      }
      return n;
    },
    /* 导出整包。includeBlobs=false 时只带数据（体积小、够恢复设置与工作区） */
    async exportAll(includeBlobs) {
      const ls = {};
      for (const k of this.localKeys()) {
        const v = localStorage.getItem(k);
        if (v != null) ls[k] = v;
      }
      const idb = {};
      for (const t of this.IDB_TARGETS) {
        const rows = await this._idbDump(t.db, t.store, includeBlobs);
        if (rows.length) idb[t.db + '/' + t.store] = rows;
      }
      return {
        type: 'ai-workbench-backup', version: 1,
        ts: new Date().toISOString(), includeBlobs: !!includeBlobs,
        localStorage: ls, indexedDB: idb,
      };
    },
    /* 导入整包：localStorage 全量写回，IndexedDB 逐条写回。返回计数。 */
    async importAll(pack) {
      if (!pack || !['ai-workbench-backup', 'sparkcine-full-backup'].includes(pack.type)) throw new Error('不是本工具导出的备份文件');
      let nLs = 0, nIdb = 0;
      for (const [k, v] of Object.entries(pack.localStorage || {})) {
        try { localStorage.setItem(k, v); nLs++; } catch (e) { console.warn('[DataSync] 恢复 ' + k + ' 失败：', e.message); }
      }
      for (const [path, rows] of Object.entries(pack.indexedDB || {})) {
        const [dbName, storeName] = path.split('/');
        nIdb += await this._idbRestore(dbName, storeName, rows);
      }
      return { localStorage: nLs, indexedDB: nIdb };
    },
  };
  /* 页面加载后自动对账一次；并顺手申请持久化存储（不需要用户手势） */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { window.DataSync.boot(); });
  else window.DataSync.boot();
  setTimeout(() => { try { window.DataSync.persist(); } catch {} }, 1500);
})();

/* ============================================================================
   DatePicker —— 自定义日期选择弹层（替换浏览器原生日历，与全站样式统一）
   用法：DatePicker.open(holderEl, inputEl, { onPick })   holder 需 position:relative
   ========================================================================== */
(function () {
  let openPop = null;
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

  function close() {
    if (!openPop) return;
    openPop.pop.remove();
    openPop = null;
  }
  document.addEventListener('click', e => {
    if (openPop && !e.target.closest('.dp-pop') && !e.target.closest('.datepick')) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  function paint() {
    const { pop, input, opts, view } = openPop;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cur = input.value ? new Date(input.value + 'T00:00:00') : null;
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const startIdx = (first.getDay() + 6) % 7;            // 周一为第一列
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const prevDays = new Date(view.getFullYear(), view.getMonth(), 0).getDate();
    const cells = [];
    for (let i = startIdx - 1; i >= 0; i--) cells.push({ d: new Date(view.getFullYear(), view.getMonth() - 1, prevDays - i), out: true });
    for (let i = 1; i <= daysInMonth; i++) cells.push({ d: new Date(view.getFullYear(), view.getMonth(), i), out: false });
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const last = cells[cells.length - 1].d;
      cells.push({ d: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), out: true });
      if (cells.length >= 42) break;
    }
    pop.innerHTML = `<div class="dp-head">
        <button class="dp-nav" data-nav="-1" title="上个月">‹</button>
        <b>${view.getFullYear()} 年 ${view.getMonth() + 1} 月</b>
        <button class="dp-nav" data-nav="1" title="下个月">›</button>
      </div>
      <div class="dp-week">${WEEK.map(w => `<span>${w}</span>`).join('')}</div>
      <div class="dp-grid">${cells.map(c => {
        const t = c.d.getTime();
        const cls = ['dp-day'];
        if (c.out) cls.push('out');
        if (t === today.getTime()) cls.push('today');
        if (cur && iso(c.d) === iso(cur)) cls.push('sel');
        return `<button class="${cls.join(' ')}" data-d="${iso(c.d)}">${c.d.getDate()}</button>`;
      }).join('')}</div>
      <div class="dp-foot">
        <button class="ghost mini" data-act="today">今天</button>
        <button class="ghost mini" data-act="clear">清除</button>
        <span style="flex:1"></span>
        <button class="ghost mini" data-act="close">关闭</button>
      </div>`;
    pop.querySelectorAll('[data-nav]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      view.setMonth(view.getMonth() + Number(b.dataset.nav));
      paint();
    });
    pop.querySelectorAll('[data-d]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      input.value = b.dataset.d;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick(b.dataset.d);
      close();
    });
    pop.querySelector('[data-act="today"]').onclick = e => {
      e.stopPropagation();
      input.value = iso(new Date());
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick(input.value);
      close();
    };
    pop.querySelector('[data-act="clear"]').onclick = e => {
      e.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick('');
      close();
    };
    pop.querySelector('[data-act="close"]').onclick = e => { e.stopPropagation(); close(); };
  }

  window.DatePicker = {
    open(holder, input, opts) {
      if (openPop && openPop.input === input) { close(); return; }
      close();
      const pop = document.createElement('div');
      pop.className = 'dp-pop';
      holder.appendChild(pop);
      const base = input.value ? new Date(input.value + 'T00:00:00') : new Date();
      openPop = { pop, input, opts: opts || {}, view: new Date(base.getFullYear(), base.getMonth(), 1) };
      paint();
    },
    close,
  };
})();
