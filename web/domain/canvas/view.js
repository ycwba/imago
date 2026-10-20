/* 画布表面：节点 DOM、连线、框选、平移缩放、小地图、就地改名与正文编辑。
   这一层不存状态 —— 文档在页面手上，任何改动都提交一组 op 让页面走同一条校验与撤销。
   DOM 是缓存的：拖动只改 transform，不重建节点，也不重解码媒体。 */
import { createIndex, containedIds, snap } from './spatial.js';
import { NODE_TYPES } from './registry.js';
import { LIMITS } from './doc.js';

/* 缩放区间只有文档那一档说了算：这里再写一遍数字，界面允许的范围就能算出文档不收的倍率。 */
const MIN_SCALE = LIMITS.scaleMin, MAX_SCALE = LIMITS.scaleMax;
const MOUNTED_MAX = LIMITS.nodes;        // DOM 预算：与文档上限同一个数，超了先按面积大的少挂

const E = s => (window.esc ? window.esc(s) : String(s == null ? '' : s));
const M = (el, k, v) => { if (el) el.style[k] = v; };

export function createSurface(o) {
  const stage = o.stage, layer = o.layer, svg = o.edges, mini = o.mini;
  const getDoc = o.getDoc, commit = o.commit, notify = o.notify || (() => {});
  const onSelect = o.onSelect || (() => {}), onRun = o.onRun || (() => {});
  const onNodeMenu = o.onNodeMenu || (() => {}), onInspect = o.onInspect || (() => {});
  const onDropFiles = o.onDropFiles || (() => {}), onAddAt = o.onAddAt || (() => {});

  const els = new Map();           // nodeId → DOM
  const paths = new Map();         // connectionId → <path>
  const index = createIndex({});
  let tool = 'select', space = false, scale = 1, ox = 0, oy = 0;
  let gridOn = true, suppress = false;
  let raf = 0, dirty = false, low = false;
  let drag = null, marquee = null, ghost = null;
  let bound = false;
  const listeners = [];

  const doc = () => getDoc() || { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, selection: [] };
  const sel = () => doc().selection || [];
  const nodeOf = id => doc().nodes.find(n => n.id === id) || null;
  /* 拖动中的预览几何只活在 drag.now 里：文档仍是旧坐标，松手才用 op 正式写入。
     这样提交失败（版本不匹配）时不会留下「看着挪了、其实没存」的位置。 */
  const geom = n => { const p = drag && drag.now ? drag.now.get(n.id) : null; return p ? Object.assign({}, n, p) : n; };
  const size = () => { const r = stage.getBoundingClientRect(); return { w: r.width || 800, h: r.height || 600, r }; };
  const toDocPt = (cx, cy) => { const r = stage.getBoundingClientRect(); return { x: (cx - r.left - ox) / scale, y: (cy - r.top - oy) / scale }; };

  /* ---------- 视口 ---------- */
  function readViewport() {
    const v = doc().viewport || { x: 0, y: 0, scale: 1 };
    ox = Number(v.x) || 0; oy = Number(v.y) || 0;
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(v.scale) || 1));
  }
  function applyTransform() {
    M(layer, 'transform', 'translate(' + ox + 'px,' + oy + 'px) scale(' + scale + ')');
    M(svg, 'transform', 'translate(' + ox + 'px,' + oy + 'px) scale(' + scale + ')');
    M(layer, '--cv-s', String(scale));
    low = scale < 0.45;
    layer.classList.toggle('cv-far', low);
  }
  function writeViewport(commitIt) {
    applyTransform();
    if (commitIt) commit([{ op: 'set_viewport', viewport: { x: ox, y: oy, scale } }], { view: true });
    schedule();
  }
  function setViewport(v, c) { const n = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(v.scale) || 1)); ox = Number(v.x) || 0; oy = Number(v.y) || 0; scale = n; writeViewport(c !== false); }
  function zoomAt(cx, cy, factor) {
    const r = stage.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    if (next === scale) return;
    const k = next / scale;
    ox = px - (px - ox) * k; oy = py - (py - oy) * k; scale = next;
    writeViewport(false);
  }
  function fitAll(ids) {
    const s = size();
    const list = doc().nodes;
    const box = (Array.isArray(ids) && ids.length ? list.filter(n => ids.includes(n.id)) : list)
      .reduce((a, n) => ({ x0: Math.min(a.x0, n.x), y0: Math.min(a.y0, n.y),
        x1: Math.max(a.x1, n.x + n.width), y1: Math.max(a.y1, n.y + n.height) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    if (!Number.isFinite(box.x0)) return;
    const m = 48;
    const k = Math.max(MIN_SCALE, Math.min(1, Math.min((s.w - m * 2) / Math.max(1, box.x1 - box.x0), (s.h - m * 2) / Math.max(1, box.y1 - box.y0))));
    setViewport({ x: (s.w - (box.x1 + box.x0) * k) / 2, y: (s.h - (box.y1 + box.y0) * k) / 2, scale: k });
  }

  /* ---------- 节点 DOM ---------- */
  /* 这个节点画的是哪一份产物 / 地址是什么，只有这两处判据：
     bodyHTML 用它取地址，contentSig 也用它 —— 开关（「优先用本机文件」）一改，
     地址就变了而资产号没变，签名必须跟着变，否则画面上还挂着旧地址。 */
  function nodeAssetId(n) {
    const m = n.metadata || {};
    return n.type === 'asset-ref' ? String(m.assetId || m.sourceAssetId || '') : String(m.assetId || '');
  }
  function nodeMediaSrc(n) {
    const id = nodeAssetId(n);
    if (!id || !window.Api) return '';
    return Api.mediaSrc(id.indexOf('http') === 0 ? id : Api.assetSrc(id));
  }
  function bodyHTML(n) {
    const m = n.metadata || {};
    const st = m.status || 'idle';
    if (n.type === 'text') return '<div class="cv-body cv-text" data-edit="content">' + (E(m.content) || '<span class="cv-ph">双击写点什么</span>') + '</div>';
    if (n.type === 'config') {
      const rows = [m.prov ? '平台 ' + E(m.prov) : '平台未选', m.model ? '型号 ' + E(m.model) : '型号未选',
        m.prompt ? E(String(m.prompt).slice(0, 160)) : '还没有提示词'];
      return '<div class="cv-body cv-cfg">' + rows.map(x => '<div class="cv-cfg-r">' + x + '</div>').join('') + '</div>';
    }
    if (n.type === 'asset-ref') {
      if (!nodeAssetId(n)) return '<div class="cv-body cv-empty">没有指向任何资产</div>';
      const kind = String(m.assetKind || 'image').toLowerCase();
      const src = nodeMediaSrc(n);
      if (kind.indexOf('video') >= 0) return mediaHTML('video', src, n);
      if (kind.indexOf('audio') >= 0) return mediaHTML('audio', src, n);
      return mediaHTML('img', src, n);
    }
    if (st === 'loading') return '<div class="cv-body cv-wait"><span class="ui-wait"></span><span>正在生成…</span></div>';
    if (st === 'error') return '<div class="cv-body cv-err">' + E(m.error || '上一次生成失败了') + '</div>';
    const src = nodeMediaSrc(n);
    if (!src) return '<div class="cv-body cv-empty">' + (st === 'success' ? '产物已经不在了' : '还没有产物 —— 按「生成」或拖一个素材进来') + '</div>';
    return mediaHTML(n.type === 'video' ? 'video' : n.type === 'audio' ? 'audio' : 'img', src, n);
  }
  function mediaHTML(kind, src, n) {
    /* 离屏不挂 <video>：解码器是按个数的稀缺资源，一屏 40 条视频同时解码必定卡。
       图片走 loading=lazy，浏览器自己管。 */
    if (kind === 'video') return '<video class="cv-m" src="' + E(src) + '" preload="metadata" controls playsinline data-nid="' + E(n.id) + '"></video>';
    if (kind === 'audio') return '<div class="cv-au"><span class="cv-au-ic">' + (window.icon ? icon('mic', 16) : '') + '</span>'
      + '<audio class="cv-m" src="' + E(src) + '" preload="metadata" controls></audio></div>';
    return '<img class="cv-m" src="' + E(src) + '" alt="" loading="lazy" decoding="async">';
  }
  function headHTML(n) {
    const d = NODE_TYPES[n.type] || {};
    return '<div class="cv-nh"><span class="cv-ic">' + (window.icon ? icon(d.icon || 'box', 14) : '') + '</span>'
      + '<span class="cv-tt" data-edit="title">' + (E(n.title) || E(d.label || '节点')) + '</span>'
      + (d.generationMode === 'asset' ? '<button class="cv-nb" data-act="run" title="按这个节点的配置生成">' + (window.icon ? icon('sparkles', 13) : '') + '</button>' : '')
      + '<button class="cv-nb" data-act="menu" title="更多操作">' + (window.icon ? icon('gear', 13) : '') + '</button></div>';
  }
  function shell(n) {
    return headHTML(n) + bodyHTML(n) + '<i class="cv-port cv-in" data-port="in"></i><i class="cv-port cv-out" data-port="out"></i><i class="cv-rs" data-rs="1"></i>';
  }
  function makeEl(n) {
    const el = document.createElement('div');
    el.dataset.id = n.id;
    layer.appendChild(el);
    return el;
  }
  /* 节点画出来的东西 = 类型 + 标题 + 正文 + 产物身份 + 状态 + 配置。
     一次拖动提交几十个节点，每次都重建 innerHTML 的话 `<video>` 会重新走一遍加载，
     画面当场闪一下 —— 所以 paint 先比这块「内容签名」：真变了才重画，
     纯位移与改尺寸只走 place()。 */
  function contentSig(n) {
    const m = n.metadata || {};
    /* 签名要罩住 bodyHTML 真正画出去的每一个值：正文是整段画的不截断，
       提示词只画前 160 字所以签名也只看那一段。漏一个字段就是「改了不重画」。 */
    return [n.type, n.title, m.status || '', nodeAssetId(n), nodeMediaSrc(n), m.assetKind || '',
      String(m.content || ''), String(m.prompt || '').slice(0, 160),
      m.prov || '', m.model || '', m.error || ''].join('\u0001');
  }
  function paint(el, n, force) {
    el.className = 'cv-node cv-' + n.type + (sel().includes(n.id) ? ' on' : '') + (n.metadata && n.metadata.status === 'loading' ? ' busy' : '');
    const s = contentSig(n);
    /* force：取消就地编辑时那串字只活在 DOM 里，签名照不出来，必须整块按文档重画。 */
    if (force || el._sig !== s) { el.innerHTML = shell(n); el._sig = s; }
    place(el, n);
  }
  function place(el, n) {
    M(el, 'width', n.width + 'px'); M(el, 'height', n.height + 'px');
    M(el, 'transform', 'translate(' + n.x + 'px,' + n.y + 'px)');
  }

  /* ---------- 连线 ---------- */
  function portOf(n, which) {
    return { x: which === 'in' ? n.x : n.x + n.width, y: n.y + n.height / 2 };
  }
  function pathD(a, b) {
    const p = portOf(a, 'out'), q = portOf(b, 'in');
    const dx = Math.max(28, Math.abs(q.x - p.x) * 0.45);
    return 'M' + p.x + ' ' + p.y + ' C' + (p.x + dx) + ' ' + p.y + ' ' + (q.x - dx) + ' ' + q.y + ' ' + q.x + ' ' + q.y;
  }
  function drawEdges() {
    const d = doc(), have = new Set();
    for (const c of d.connections) {
      const a = nodeOf(c.fromNodeId), b = nodeOf(c.toNodeId);
      if (!a || !b) continue;
      if (!els.has(a.id) || !els.has(b.id)) continue;
      have.add(c.id);
      let p = paths.get(c.id);
      if (!p) {
        p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('class', 'cv-edge'); p.dataset.id = c.id;
        svg.appendChild(p); paths.set(c.id, p);
      }
      p.setAttribute('d', pathD(geom(a), geom(b)));
    }
    for (const [id, p] of paths) if (!have.has(id)) { p.remove(); paths.delete(id); }
    if (ghost && ghost._from) {
      const a = nodeOf(ghost._from) || { x: 0, y: 0, width: 0, height: 0 };
      ghost.setAttribute('d', pathD(geom(a), { x: ghost._x, y: ghost._y, width: 0, height: 0 }));
    }
  }
  function drawMini() {
    if (!mini) return;
    const d = doc(), s = size();
    if (!d.nodes.length) { mini.innerHTML = ''; return; }
    const list = d.nodes.map(geom);
    const box = list.reduce((a, n) => ({ x0: Math.min(a.x0, n.x), y0: Math.min(a.y0, n.y),
      x1: Math.max(a.x1, n.x + n.width), y1: Math.max(a.y1, n.y + n.height) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const w = Math.max(1, box.x1 - box.x0), h = Math.max(1, box.y1 - box.y0);
    const k = Math.min(150 / w, 96 / h);
    mini.innerHTML = list.slice(0, 400).map(n => '<i class="cv-md' + (n.type === 'text' ? ' tx' : '')
      + (sel().includes(n.id) ? ' on' : '') + '" style="left:' + ((n.x - box.x0) * k).toFixed(1) + 'px;top:'
      + ((n.y - box.y0) * k).toFixed(1) + 'px;width:' + Math.max(2, n.width * k).toFixed(1) + 'px;height:'
      + Math.max(2, n.height * k).toFixed(1) + 'px"></i>').join('')
      + '<i class="cv-vp" style="left:' + ((-ox / scale - box.x0) * k).toFixed(1) + 'px;top:' + ((-oy / scale - box.y0) * k).toFixed(1)
      + 'px;width:' + ((s.w / scale) * k).toFixed(1) + 'px;height:' + ((s.h / scale) * k).toFixed(1) + 'px"></i>';
    mini.dataset.k = String(k); mini.dataset.bx = String(box.x0); mini.dataset.by = String(box.y0);
  }

  /* ---------- 一次同步 ---------- */
  /* 要挂 DOM 的那一些：视口里的 + 选中的 + 这一批刚改过的。
     索引始终覆盖全部节点（命中、框选、连线判据要的是数据，不是 DOM）。 */
  function wanted(d, changed) {
    const s = size();
    const byId = new Map((d.nodes || []).map(n => [n.id, n]));
    const area = id => { const n = byId.get(id); return n ? Math.max(1, n.width * n.height) : 1; };
    /* 选中与这一批刚改过的排在预算之前：用户正在摸的东西不能因为缩放而消失。
       剩下的名额按面积**从小到大**给视口里的节点 —— 一个占满屏幕的节点解码与布局最贵，
       先让它让位，同一屏里能多留几个看得清的小节点。以前是随手 slice 掉一批，
       被挤掉的可能是视口正中央那一个，表现是「缩到很小再回来，中间那块永远空白」。 */
    const want = new Set();
    const push = id => { if (byId.has(id) && !want.has(id) && want.size < MOUNTED_MAX) want.add(id); };
    (d.selection || []).forEach(push);
    if (changed && Array.isArray(changed.nodes)) changed.nodes.forEach(push);
    index.queryViewport({ x: ox, y: oy, scale }, s.w, s.h)
      .filter(id => !want.has(id)).sort((a, b) => area(a) - area(b)).forEach(push);
    return want;
  }
  function sync(changed) {
    const d = doc();
    readViewport();
    index.rebuild(d.nodes);
    const byId = new Map(d.nodes.map(n => [n.id, n]));
    for (const [id, el] of els) if (!byId.has(id)) { el.remove(); els.delete(id); }
    if (!changed || changed.all) { els.forEach(el => el.remove()); els.clear(); }   // 撤销/重做/整份换掉：按视口重挂一次
    const want = wanted(d, changed);
    for (const id of want) {
      const n = byId.get(id); if (!n) continue;
      let el = els.get(id);
      if (!el) { el = makeEl(n); els.set(id, el); paint(el, n); continue; }
      if (!changed || !changed.nodes || changed.nodes.includes(id)) paint(el, n);
      else place(el, n);
    }
    for (const [id, el] of els) if (!want.has(id)) { el.remove(); els.delete(id); }
    applySelection();
    applyTransform();
    drawEdges(); drawMini();
  }
  function applySelection() {
    const on = new Set(sel());
    for (const [id, el] of els) el.classList.toggle('on', on.has(id));
  }
  /* 平移/缩放之后重算挂载集合：离屏节点连 DOM 都不留，720 个节点也只是一份数据。 */
  function remount() {
    const d = doc();
    const want = wanted(d, null);
    for (const [id, el] of els) if (!want.has(id)) { el.remove(); els.delete(id); }
    for (const id of want) {
      if (els.has(id)) continue;
      const n = nodeOf(id); if (!n) continue;
      const el = makeEl(n); els.set(id, el); paint(el, n);
    }
    drawEdges(); drawMini();
  }
  function schedule() {
    dirty = true;
    if (raf) return;
    /* remount 收尾已经画过连线与小地图，这里再点一次等于每帧白做一遍全表（5000 条那份）。 */
    raf = requestAnimationFrame(() => { raf = 0; if (!dirty) return; dirty = false; remount(); });
  }

  /* ---------- 就地编辑（不弹新窗口：改的就是眼前这个框） ---------- */
  function edit(target, field, n) {
    const was = field === 'title' ? n.title : ((n.metadata || {}).content || '');
    target.setAttribute('contenteditable', 'plaintext-only');
    target.classList.add('cv-editing');
    target.focus();
    const range = document.createRange(); range.selectNodeContents(target);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    const done = keep => {
      target.removeAttribute('contenteditable');
      target.classList.remove('cv-editing');
      const text = String(target.textContent || '').replace(/\r/g, '');
      if (!keep || text === was) {
        /* 取消或没改：整块按文档重画，占位文字与图标才会回来（往这个框里塞 bodyHTML 会套出一层 div）。 */
        const host = target.closest('.cv-node');
        const cur = host && nodeOf(host.dataset.id);
        if (cur) paint(host, cur, true);
        return;
      }
      const op = field === 'title' ? { op: 'update_node', id: n.id, patch: { title: text } }
        : { op: 'update_node', id: n.id, patch: { metadata: { content: text } } };
      commit([op], { label: field === 'title' ? '改名' : '改正文' });
    };
    const onKey = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(false); target.blur(); }
      if (ev.key === 'Enter' && (field === 'title' || (ev.metaKey || ev.ctrlKey))) { ev.preventDefault(); done(true); target.blur(); }
    };
    const onBlur = () => { target.removeEventListener('keydown', onKey); target.removeEventListener('blur', onBlur); done(true); };
    target.addEventListener('keydown', onKey);
    target.addEventListener('blur', onBlur, { once: true });
  }

  /* ---------- 指针交互 ---------- */
  function hit(e) {
    const el = e.target.closest ? e.target.closest('.cv-node') : null;
    if (!el) return null;
    const n = nodeOf(el.dataset.id);
    return n ? { el, n, port: (e.target.dataset || {}).port || '', rs: !!(e.target.dataset || {}).rs, edit: (e.target.dataset || {}).edit || '', act: (e.target.dataset || {}).act || '' } : null;
  }
  function onDown(e) {
    if (e.button === 2) return;
    const h = hit(e);
    if (h && h.act) {
      suppress = true;                                    // 这两个按钮不该再顺带打开检查器
      if (h.act === 'run') onRun(h.n); else onNodeMenu(h.n, e.clientX, e.clientY);
      e.preventDefault(); return;
    }
    /* 正在编辑时才把指针让给 contenteditable；没编辑时按标题/正文也要能拖动节点，
       否则节点顶栏成了「只能双击、不能拖」的死区（一个画布上标题栏占的面积不小）。 */
    if (h && h.edit && e.target.isContentEditable) return;
    /* 带控制条的媒体不抢指针：按下就拖动的话，播放/进度条一次都点不到。 */
    if (h && /^(video|audio)$/i.test(e.target.tagName || '')) return;
    if (h && h.port === 'out') { startLink(e, h.n); return; }
    if (h && h.rs) { startResize(e, h.n); return; }
    const pan = tool === 'hand' || space || e.button === 1 || (h === null && e.button === 0 && e.altKey);
    if (!h && e.button === 0 && !pan) { startMarquee(e); return; }
    if (h && !pan) { startMove(e, h.n); return; }
    startPan(e);
  }
  function startPan(e) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox, oy };
    stage.classList.add('cv-grabbing');
  }
  function startMarquee(e) {
    const p = toDocPt(e.clientX, e.clientY);
    const el = document.createElement('div'); el.className = 'cv-marq'; stage.appendChild(el);
    marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, el, add: e.shiftKey, toggle: e.altKey,
      base: (e.shiftKey || e.altKey) ? (doc().selection || []).slice() : [] };
  }
  function marqueeIds() {
    const inside = containedIds(doc().nodes, marquee.x0, marquee.y0, marquee.x1, marquee.y1);
    if (marquee.add) return [...new Set(marquee.base.concat(inside))];
    if (marquee.toggle) return inside.filter(id => !marquee.base.includes(id))
      .concat(marquee.base.filter(id => !inside.includes(id)));
    return inside;
  }
  function startMove(e, n) {
    const list = sel().includes(n.id) ? sel().slice() : [n.id];
    if (e.shiftKey && !list.includes(n.id)) list.push(n.id);
    commit([{ op: 'select_nodes', ids: list }], { view: true });
    onSelect(list); applySelection();
    drag = { kind: 'move', ids: list, sx: e.clientX, sy: e.clientY, now: new Map(),
      at: new Map(list.map(id => { const x = nodeOf(id); return [id, { x: x.x, y: x.y }]; })) };
    stage.classList.add('cv-grabbing');
  }
  function startResize(e, n) {
    drag = { kind: 'resize', id: n.id, sx: e.clientX, sy: e.clientY, w: n.width, h: n.height, now: new Map(),
      ar: (NODE_TYPES[n.type] || {}).keepAspectRatio && n.height > 0 ? n.width / n.height : 0 };
  }
  function startLink(e, n) {
    ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    ghost.setAttribute('class', 'cv-ghost'); ghost._from = n.id; svg.appendChild(ghost);
    const p = toDocPt(e.clientX, e.clientY); ghost._x = p.x; ghost._y = p.y;
    drag = { kind: 'link', from: n.id };
  }
  function onMove(e) {
    if (marquee) {
      const p = toDocPt(e.clientX, e.clientY);
      marquee.x1 = p.x; marquee.y1 = p.y;
      M(marquee.el, 'left', Math.min(marquee.x0, marquee.x1) * scale + ox + 'px');
      M(marquee.el, 'top', Math.min(marquee.y0, marquee.y1) * scale + oy + 'px');
      M(marquee.el, 'width', Math.abs(marquee.x1 - marquee.x0) * scale + 'px');
      M(marquee.el, 'height', Math.abs(marquee.y1 - marquee.y0) * scale + 'px');
      const next = marqueeIds();
      onSelect(next);
      for (const [id, el] of els) el.classList.toggle('on', next.includes(id));
      e.preventDefault(); return;
    }
    if (!drag) return;
    if (drag.kind === 'pan') { ox = drag.ox + (e.clientX - drag.sx); oy = drag.oy + (e.clientY - drag.sy); writeViewport(false); }
    else if (drag.kind === 'move') {
      const dx = (e.clientX - drag.sx) / scale, dy = (e.clientY - drag.sy) / scale;
      const step = gridOn && scale > 0.5 ? 8 : 0;
      for (const id of drag.ids) {
        const n = nodeOf(id), el = els.get(id); if (!n || !el) continue;
        const a = drag.at.get(id);
        const nx = snap(a.x + dx, step), ny = snap(a.y + dy, step);
        M(el, 'transform', 'translate(' + nx + 'px,' + ny + 'px)');
        drag.now.set(id, { x: nx, y: ny });
        index.update(id, Object.assign({}, n, { x: nx, y: ny }));
      }
      drawEdges(); drawMini();
    } else if (drag.kind === 'resize') {
      const n = nodeOf(drag.id), el = els.get(drag.id); if (!n || !el) return;
      let w = Math.max(60, drag.w + (e.clientX - drag.sx) / scale);
      let h = Math.max(40, drag.h + (e.clientY - drag.sy) / scale);
      if (drag.ar) h = w / drag.ar;
      drag.now.set(drag.id, { width: w, height: h });
      place(el, Object.assign({}, n, { width: w, height: h }));
      index.update(n.id, Object.assign({}, n, { width: w, height: h }));
      drawEdges(); drawMini();
    } else if (drag.kind === 'link') {
      const p = toDocPt(e.clientX, e.clientY); ghost._x = p.x; ghost._y = p.y;
      const over = e.target.closest ? e.target.closest('.cv-node') : null;
      if (over && over.dataset.id !== drag.from) over.classList.add('cv-linkable');
      for (const [id, el] of els) if (el !== over || id === drag.from) el.classList.remove('cv-linkable');
      drawEdges();
    }
    e.preventDefault();
  }
  function onUp(e) {
    if (marquee) {
      const next = marqueeIds();
      marquee.el.remove(); marquee = null;
      suppress = true;
      commit([{ op: 'select_nodes', ids: next }], { view: true });
      onSelect(next); applySelection();
      onInspect(next.length ? nodeOf(next[0]) : null);
      return;
    }
    stage.classList.remove('cv-grabbing');
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'pan') { suppress = true; commit([{ op: 'set_viewport', viewport: { x: ox, y: oy, scale } }], { view: true }); return; }
    if (d.kind === 'move') {
      const ops = [];
      for (const id of d.ids) {
        const p = d.now.get(id), a = d.at.get(id);
        if (p && (p.x !== a.x || p.y !== a.y)) ops.push({ op: 'update_node', id, patch: { x: Math.round(p.x), y: Math.round(p.y) } });
      }
      if (!ops.length) return;                                  // 只点了一下：剩下的交给 click 开检查器
      suppress = true;
      const r = commit(ops, { label: ops.length > 1 ? '移动 ' + ops.length + ' 个节点' : '移动节点' });
      if (!r.ok) sync({ nodes: d.ids });                        // 提交没成：把预览坐标收回文档值
    } else if (d.kind === 'resize') {
      const p = d.now.get(d.id), n = nodeOf(d.id);
      if (!p || !n) return;
      suppress = true;
      if (Math.abs(p.width - n.width) > 0.5 || Math.abs(p.height - n.height) > 0.5) {
        const r = commit([{ op: 'update_node', id: n.id, patch: { width: Math.round(p.width), height: Math.round(p.height) } }], { label: '改尺寸' });
        if (!r.ok) sync({ nodes: [n.id] });
      }
    } else if (d.kind === 'link') {
      ghost.remove(); ghost = null;
      suppress = true;
      const over = e.target.closest ? e.target.closest('.cv-node') : null;
      for (const [, el] of els) el.classList.remove('cv-linkable');
      if (!over) return;
      const to = nodeOf(over.dataset.id); if (!to || to.id === d.from) return;
      commit([{ op: 'connect_nodes', from: d.from, to: to.id }], { label: '连一条线' });
    }
  }

  function onWheel(e) {
    e.preventDefault();
    if (e.shiftKey || space) { ox -= e.deltaX + e.deltaY; oy -= e.deltaY; writeViewport(true); return; }
    zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
    if (Math.abs(e.deltaY) > 0) writeViewport(true);
  }
  function onDbl(e) {
    const h = hit(e); if (!h) return;
    if (h.edit) { edit(e.target.closest('[data-edit]'), h.edit, h.n); return; }
    if (h.n.type === 'text') { const t = h.el.querySelector('[data-edit="content"]'); if (t) edit(t, 'content', h.n); }
    else { const t = h.el.querySelector('[data-edit="title"]'); if (t) edit(t, 'title', h.n); }
  }
  function onCtx(e) {
    const h = hit(e); if (!h) return;
    e.preventDefault(); onNodeMenu(h.n, e.clientX, e.clientY);
  }
  function onClick(e) {
    if (suppress) { suppress = false; return; }          // 刚完成一次拖动/框选/连线：这一次 click 不算“点开检查器”
    const h = hit(e);
    if (h) { onInspect(h.n); return; }
    if (e.target === stage || e.target === layer || e.target === svg) {
      commit([{ op: 'select_nodes', ids: [] }], { view: true });
      onSelect([]); applySelection(); onInspect(null);
    }
  }
  function onKey(ev) {
    if (!o.isActive || !o.isActive()) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /input|textarea|select/i.test(t.tagName || ''))) return;
    if (ev.key === ' ') { if (!space) { space = true; stage.classList.add('cv-space'); } ev.preventDefault(); return; }
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); const ids = doc().nodes.map(n => n.id);
      commit([{ op: 'select_nodes', ids }], { view: true }); onSelect(ids); applySelection(); return; }
    if (ev.key === 'Escape') { commit([{ op: 'select_nodes', ids: [] }], { view: true }); onSelect([]); applySelection(); }
  }
  function onKeyUp(ev) { if (ev.key === ' ') { space = false; stage.classList.remove('cv-space'); } }
  function onDrop(e) {
    if (!e.dataTransfer) return;
    stage.classList.remove('cv-over');
    /* 在画布里拖节点上的图，浏览器也会把它当文件 —— 只认从窗口外拖进来的（公共层判据）。 */
    if (!window.isExternalFileDrag(e)) return;
    e.preventDefault();
    const p = toDocPt(e.clientX, e.clientY);
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) onDropFiles(files, p);
  }
  function onDragOver(e) { if (window.isExternalFileDrag(e)) { e.preventDefault(); stage.classList.add('cv-over'); } }
  function onDragLeave(e) { if (e.target === stage) stage.classList.remove('cv-over'); }

  function add(kind) {
    const s = size();
    const c = { x: (s.w / 2 - ox) / scale, y: (s.h / 2 - oy) / scale };
    onAddAt(kind || 'text', c);
  }

  function bind() {
    if (bound) return; bound = true;
    const on = (el, ev, fn, opt) => { if (!el) return; el.addEventListener(ev, fn, opt); listeners.push([el, ev, fn, opt]); };
    on(stage, 'pointerdown', onDown);
    on(window, 'pointermove', onMove);
    on(window, 'pointerup', onUp);
    on(stage, 'wheel', onWheel, { passive: false });
    on(stage, 'dblclick', onDbl);
    on(stage, 'click', onClick);
    on(stage, 'contextmenu', onCtx);
    on(window, 'keydown', onKey);
    on(window, 'keyup', onKeyUp);
    on(stage, 'drop', onDrop); on(stage, 'dragover', onDragOver); on(stage, 'dragleave', onDragLeave);
  }

  return {
    mount(d) { index.rebuild(d.nodes || []); sync({ all: true }); bind(); },
    sync, remount, fitAll, add, readViewport,
    setViewport, get viewport() { return { x: ox, y: oy, scale }; },
    setTool(t) { tool = t === 'hand' ? 'hand' : 'select'; stage.classList.toggle('cv-hand', tool === 'hand'); },
    setGrid(on) { gridOn = !!on; },
    get tool() { return tool; },
    zoomBy(f) { const s = size(); zoomAt(s.r.left + s.w / 2, s.r.top + s.h / 2, f); writeViewport(true); },
    zoomTo(k) { const s = size(); const cur = scale; const nk = Math.max(MIN_SCALE, Math.min(MAX_SCALE, k));
      const kk = nk / cur; ox = s.w / 2 - (s.w / 2 - ox) * kk; oy = s.h / 2 - (s.h / 2 - oy) * kk; scale = nk; writeViewport(true); },
    nodeEl: id => els.get(id) || null,
    toDocPt, destroy() {
      listeners.forEach(([el, ev, fn, opt]) => { try { el.removeEventListener(ev, fn, opt); } catch (e) {} }); listeners.length = 0;
      els.forEach(el => el.remove()); els.clear();
      paths.forEach(p => p.remove()); paths.clear();
      if (marquee) { marquee.el.remove(); marquee = null; }
      if (ghost) { ghost.remove(); ghost = null; }
      if (raf) cancelAnimationFrame(raf);
      bound = false;
    },
  };
}
