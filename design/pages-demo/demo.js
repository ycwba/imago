/* 独立静态设计预览：作品只在内存，只有三项 pages-demo 偏好使用 localStorage。 */
(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const byId = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const text = (selector, value) => { const el = $(selector); if (el) el.textContent = String(value); };
  const focusQuiet = el => { if (el && el.isConnected && !el.closest('[hidden]')) el.focus({ preventScroll: true }); };
  const pad = n => String(n).padStart(2, '0');
  const clock = value => `${pad(Math.floor(value / 60))}:${pad(Math.floor(value % 60))}`;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let nextId = 20;
  const uid = prefix => `${prefix}-${nextId++}`;

  const ICONS = {
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m-4 8h4M17 8h4m-4 8h4M7 12h10"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
    sparkles: '<path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3ZM4 2v4M2 4h4M20 18v4m-2-2h4"/>',
    bookmark: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4Z"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    chart: '<path d="M3 3v18h18M7 16v-5m5 5V6m5 10v-7"/>',
    settings: '<path d="m9 3 1-1h4l1 3 3 1 3 1v4l-2 2-1 3 1 3-3 2-3-1-3 1-3-2v-3l-2-2-2-1V9l3-1 2-2Z"/><circle cx="12" cy="12" r="3"/>',
    moon: '<path d="M20.8 13.5A9 9 0 0 1 10.5 3.2a9 9 0 1 0 10.3 10.3Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 3m0 3h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    'chevron-right': '<path d="m9 5 7 7-7 7"/>',
    'chevron-down': '<path d="m5 9 7 7 7-7"/>',
    'arrow-right': '<path d="M3 12h18m-7-7 7 7-7 7"/>',
    export: '<path d="M12 15V3m-5 5 5-5 5 5M4 13v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M3 17v4h18v-4"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    timeline: '<path d="M4 3v18M2 7h20M2 17h20M9 7v10m7-10v10"/><path d="M8 3h6m-3 0v4"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    play: '<path d="m8 4 12 8-12 8Z" fill="currentColor"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
    'skip-back': '<path d="M5 5v14m14-14L8 12l11 7Z"/>',
    'skip-forward': '<path d="M19 5v14M5 5l11 7-11 7Z"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
    audio: '<path d="M10 17V5l10-2v12M10 9l10-2"/><ellipse cx="6.5" cy="17.5" rx="3.5" ry="2.5"/><ellipse cx="16.5" cy="15.5" rx="3.5" ry="2.5"/>',
    link: '<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 0 6 6l3-3m1-11 2-2a4 4 0 0 0-6-6L9 4" transform="translate(0 -1)"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 4 4 4-6 5 7"/>',
    'image-plus': '<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8m5-1v8m-4-4h8M3 17l5-5 4 4 3-3 6 6"/><circle cx="8" cy="7" r="1"/>',
    'hard-drive': '<path d="m3 15 3-11h12l3 11"/><rect x="3" y="15" width="18" height="6" rx="2"/><path d="M7 18h.01M17 18h.01"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h1m-1 6h1m-1 6h1"/>',
    wallet: '<path d="M20 7V4H5a2 2 0 0 0 0 4h16v12H5a2 2 0 0 1-2-2V6m18 7h-6v4h6m-3-2h.01"/>',
    refresh: '<path d="M20 7V2m0 5h-5M4 17v5m0-5h5M5 7a8 8 0 0 1 13-2l2 2M4 17l2 2a8 8 0 0 0 13-2"/>',
    key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-5-5 3-3m0 6 3-3"/>',
    sliders: '<path d="M4 7h5m4 0h7M4 17h11m4 0h1M9 3v8m6 2v8"/>',
    shield: '<path d="m12 2 9 4v6c0 5-5 9-9 10-4-1-9-5-9-10V6Zm-4 10 3 3 5-6"/>',
    users: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M17 3a4 4 0 0 1 0 8m2 3a6 6 0 0 1 3 5v2"/>',
    camera: '<path d="M3 7h4l2-3h6l2 3h4v14H3Z"/><circle cx="12" cy="13" r="4"/>',
    box: '<path d="m12 2 10 5v10l-10 5-10-5V7Zm-10 5 10 5 10-5M12 12v10"/>'
  };
  function icon(name) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.info}</svg>`;
  }
  function fillIcons(root = document) {
    $$('[data-icon]', root).forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  }
  function pressed(el, active) {
    el.classList.toggle('active', active);
    el.setAttribute('aria-pressed', String(active));
  }
  function setSwitch(el, active) {
    el.classList.toggle('active', active);
    el.setAttribute('aria-checked', String(active));
  }
  function busy(el, active, label) {
    el.disabled = active;
    el.setAttribute('aria-busy', String(active));
    const span = $('span', el);
    if (span && label) span.textContent = label;
  }

  const prefKeys = new Set(['theme', 'reduce-motion', 'default-ratio']);
  function readPref(key, fallback) {
    if (!prefKeys.has(key)) return fallback;
    try { return localStorage.getItem(`pages-demo:${key}`) || fallback; } catch (_) { return fallback; }
  }
  function writePref(key, value) {
    if (!prefKeys.has(key)) return;
    let saved = true;
    try { localStorage.setItem(`pages-demo:${key}`, String(value)); } catch (_) { saved = false; }
    byId('settingsStatus').innerHTML = `<span class="status-dot"></span>${saved ? '演示偏好已保存' : '浏览器禁止存储 · 本次仍生效'}`;
  }
  const ratios = ['16:9', '9:16', '1:1'];
  const savedRatio = readPref('default-ratio', '16:9');
  let defaultRatio = ratios.includes(savedRatio) ? savedRatio : '16:9';
  let reducedMotion = readPref('reduce-motion', window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'true' : 'false') === 'true';
  function setTheme(theme, save = true) {
    const dark = theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $$('[data-theme-choice]').forEach(el => pressed(el, el.dataset.themeChoice === (dark ? 'dark' : 'light')));
    byId('themeToggle').innerHTML = `${icon(dark ? 'sun' : 'moon')}<span>${dark ? '浅色' : '深色'}</span>`;
    byId('themeToggle').setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题');
    if (save) writePref('theme', dark ? 'dark' : 'light');
  }
  function applyMotion(save = true) {
    document.body.classList.toggle('reduce-motion', reducedMotion);
    document.documentElement.dataset.reduceMotion = String(reducedMotion);
    setSwitch(byId('reduceMotion'), reducedMotion);
    if (save) writePref('reduce-motion', reducedMotion);
  }

  let toastTimer = 0;
  let undoToast = null;
  function toast(message, undo) {
    clearTimeout(toastTimer);
    const el = byId('toast');
    undoToast = typeof undo === 'function' ? undo : null;
    el.innerHTML = `<span>${esc(message)}</span>${undoToast ? '<button class="text-button" type="button" data-toast-undo>撤销</button>' : ''}`;
    el.hidden = false;
    toastTimer = window.setTimeout(hideToast, undoToast ? 9000 : 4500);
  }
  function hideToast() {
    if (byId('toast').contains(document.activeElement)) return;
    byId('toast').hidden = true;
    undoToast = null;
  }
  byId('toast').addEventListener('focusout', () => { clearTimeout(toastTimer); toastTimer = window.setTimeout(hideToast, 2500); });

  const media = {
    street: 'assets/rain-street.jpg', city: 'assets/night-city.jpg', store: 'assets/store.webp', portrait: 'assets/portrait.jpg'
  };
  const catalog = new Map();
  const register = item => { catalog.set(item.id, item); return item; };
  const materials = [
    { id: 'portrait', name: '林晚', category: '角色', project: 'rain', src: media.portrait, description: '夜班归来的女孩，话不多，却总在观察这座城。' },
    { id: 'chen', name: '陈默', category: '角色', project: 'rain', src: '', description: '便利店店员 · 待添加角色参考图。' },
    { id: 'narrator', name: '旁白', category: '角色', project: 'coast', src: '', kind: '音频', description: '温和、克制的叙述者 · 待添加声音。' },
    { id: 'street', name: '雨夜街头', category: '场景', project: 'rain', src: media.street, description: '雨水与霓虹，在空旷的街口交汇。' },
    { id: 'store', name: '便利店', category: '场景', project: 'rain', src: media.store, description: '街角便利店，玻璃后留着一盏暖灯。' },
    { id: 'city', name: '城市', category: '场景', project: 'rain', src: media.city, description: '蓝色夜幕下的城市天际线。' },
    { id: 'coast', name: '海岸', category: '场景', project: 'coast', src: '', description: '海岸来信的故事发生地 · 待添加参考图。' },
    { id: 'camera', name: '旧相机', category: '物品', project: 'rain', src: '', description: '一台有使用痕迹的旧相机 · 待添加参考图。' }
  ].map(item => register({ kind: '图片', source: 'material', sample: true, ...item }));
  const assets = [
    { id: 'asset-street', name: '雨停之前 · 雨中的街口', kind: '视频', src: media.street, duration: 6, description: '缓慢推进的街口镜头 · 静态样图，并非视频。' },
    { id: 'asset-store', name: '雨停之前 · 不期而遇', kind: '视频', src: media.store, duration: 8, description: '便利店门口的相遇 · 静态样图，并非视频。' },
    { id: 'asset-city', name: '雨停之前 · 城市的呼吸', kind: '视频', src: media.city, duration: 6, description: '夜色中的城市 · 静态样图，并非视频。' },
    { id: 'asset-portrait', name: '林晚 · 角色定妆', kind: '图片', src: media.portrait, description: '角色视觉参考 · 本地样图。' },
    { id: 'asset-rain', name: '雨夜 · 氛围参考', kind: '图片', src: media.street, description: '冷蓝色、雨水、路面反光 · 本地样图。' },
    { id: 'asset-audio', name: '城市的呼吸 · 雨声', kind: '音频', src: '', duration: 39, description: '环境音占位记录 · 此演示未附音频。' }
  ].map(item => register({ source: 'asset', project: 'rain', sample: true, ...item }));
  const results = [
    { id: 'result-store', name: '雨停之后，灯还亮着', kind: '视频', src: media.store, model: '可灵 2.6', prompt: '深夜的便利店，暖黄色灯光透过玻璃，门外的雨渐渐小了。一个人安静地等着雨停。固定镜头，胶片色彩。', duration: '5 秒' },
    { id: 'result-city', name: '城市的呼吸', kind: '视频', src: media.city, model: 'Seedance 1.5 Pro', prompt: '夜晚的城市，路灯点点，远景，冷蓝色调。', duration: '10 秒' },
    { id: 'result-portrait', name: '林晚 · 情绪定帧', kind: '图片', src: media.portrait, model: 'Seedream 4.0', prompt: '林晚的角色参考，安静克制，柔和光线。' }
  ].map(item => register({ source: 'result', project: 'rain', sample: true, state: 'ready', ratio: '16:9', description: '预置样例 · 不是真实生成作品。', ...item }));
  const favorites = new Set(['asset-street', 'asset-store', 'asset-city', 'asset-portrait', 'asset-rain', 'portrait']);
  const scenes = [{ id: '0', name: '雨夜街头' }, { id: '1', name: '不期而遇' }, { id: '2', name: '雨后告别' }];
  const shots = [
    ['雨中的街口', media.street, 6, '0', '一场雨，让城市慢了下来。', '雨夜的城市街头，霓虹灯映在湿漉漉的路面上。行人撑伞走过，镜头缓慢向前推进，冷蓝色调，电影质感。'],
    ['城市的呼吸', media.city, 6, '0', '每一盏灯，都在等一个归人。', '远景俯瞰雨夜城市，车灯沿街道延伸，镜头缓慢平移，冷蓝色调。'],
    ['街角的灯', media.store, 8, '1', '有人为这场雨，留着一盏灯。', '深夜便利店的暖灯照亮雨中的人行道，固定镜头，冷暖对比，胶片色彩。'],
    ['隔着玻璃', media.store, 5, '1', '没有说出口的话，藏在雨声里。', '透过便利店玻璃看向门外的雨，水珠划过前景，安静克制的氛围。'],
    ['雨慢慢停了', media.street, 8, '2', '雨慢慢停了，故事还没有。', '雨后的街道，路面仍有霓虹反光，低机位缓慢向前，留出开阔空间。'],
    ['告别之前', media.city, 6, '2', '我们各自走进，亮着灯的城市。', '城市的夜色渐渐安静下来，远景停留，克制的电影结尾。']
  ].map((row, index) => ({ id: `shot-${index + 1}`, name: row[0], src: row[1], duration: row[2], scene: row[3], caption: row[4], prompt: row[5], model: '可灵 2.6', ratio: '16:9', refs: ['portrait', index === 2 || index === 3 ? 'store' : 'street'], sound: true, busy: false, state: '样例就绪' }));
  let currentShot = shots[0];
  let currentPage = 'director';
  let position = 0;
  let playing = false;
  let playFrame = 0;
  let lastTick = 0;
  const totalDuration = () => shots.reduce((sum, shot) => sum + shot.duration, 0);
  const startOf = shot => shots.slice(0, shots.indexOf(shot)).reduce((sum, row) => sum + row.duration, 0);
  const shotAt = time => { let end = 0; return shots.find(shot => { end += shot.duration; return time < end; }) || shots[shots.length - 1]; };

  const pages = [
    { id: 'director', name: '导演台', icon: 'film' }, { id: 'chars', name: '素材库', icon: 'layers' },
    { id: 'studio', name: '生成工作台', icon: 'sparkles' }, { id: 'favorites', name: '我的收藏', icon: 'bookmark' },
    { id: 'assets', name: '资产库', icon: 'folder' }, { id: 'usage', name: '用量与余额', icon: 'chart' },
    { id: 'settings', name: '设置', icon: 'settings' }
  ];
  const pageScroll = new Map();
  function showPage(name, moveFocus = false) {
    if (!pages.some(page => page.id === name)) return;
    const changed = currentPage !== name;
    if (changed) {
      pageScroll.set(currentPage, { workspace: byId('workspace').scrollTop, window: window.scrollY });
      stopPlayback();
      currentPage = name;
    }
    $$('[data-view]').forEach(el => { el.hidden = el.dataset.view !== name; });
    $$('.app-nav [data-go]').forEach(el => {
      const active = el.dataset.go === name;
      el.classList.toggle('active', active);
      if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
    document.title = `${pages.find(page => page.id === name).name} · 拾帧设计预览`;
    if (changed) {
      const scroll = pageScroll.get(name) || { workspace: 0, window: 0 };
      byId('workspace').scrollTop = scroll.workspace;
      window.scrollTo({ top: scroll.window, behavior: 'instant' });
    }
    if (moveFocus) focusQuiet(byId('workspace'));
    if (name === 'settings') requestAnimationFrame(syncSettingsNav);
  }

  const dialog = byId('appDialog');
  let dialogOpener = null;
  let afterClose = null;
  let dialogEvents = new AbortController();
  function pauseDialogMedia() { $$('video, audio', byId('dialogBody')).forEach(el => el.pause()); }
  function openDialog(title, html, setup) {
    stopPlayback();
    pauseDialogMedia();
    dialogEvents.abort();
    dialogEvents = new AbortController();
    if (!dialog.open) dialogOpener = document.activeElement;
    afterClose = null;
    byId('dialogTitle').textContent = title;
    byId('dialogBody').innerHTML = html;
    fillIcons(byId('dialogBody'));
    if (!dialog.open) dialog.showModal();
    if (setup) setup(byId('dialogBody'));
    focusQuiet($('[autofocus], input:not([type="hidden"]), textarea', byId('dialogBody')) || byId('closeDialog'));
  }
  function closeDialog(next) {
    if (typeof next === 'function') afterClose = next;
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    pauseDialogMedia();
    dialogEvents.abort();
    const next = afterClose;
    afterClose = null;
    const fallback = $(`.app-nav [data-go="${currentPage}"]`);
    focusQuiet(dialogOpener && dialogOpener.isConnected && !dialogOpener.closest('[hidden]') ? dialogOpener : fallback);
    if (next) next();
  });
  byId('closeDialog').addEventListener('click', () => closeDialog());

  function mediaLabel(item) {
    if (item.state === 'busy') return '演示处理中';
    if (item.imported) return `${item.kind} · 本次导入`;
    if (item.kind === '视频') return '视频样例 · 静帧';
    if (item.kind === '音频') return item.src ? '音频' : '声音待添加';
    return item.src ? (item.category || '图片样例') : '参考图待添加';
  }
  function placeholderIcon(item) {
    return item.kind === '音频' ? 'audio' : item.kind === '视频' ? 'film' : item.category === '角色' ? 'users' : item.category === '物品' ? 'camera' : 'image';
  }
  function artHTML(item) {
    if (item.src && !(item.imported && item.kind !== '图片')) return `<img src="${esc(item.src)}" alt="${esc(item.name)}" loading="lazy">`;
    return `<span class="${item.kind === '音频' ? 'audio-art' : 'object-art'}">${icon(placeholderIcon(item))}<span>${esc(item.kind === '音频' ? (item.imported ? '本次导入的音频' : '暂无音频') : item.imported ? '本次导入的视频' : '暂无参考图')}</span></span>`;
  }
  function cardHTML(item, extra = '') {
    const favorite = favorites.has(item.id);
    const description = item.description || item.prompt || '本次浏览器会话中的素材。';
    return `<article class="asset-card${extra ? ` ${extra}` : ''}" data-card="${esc(item.id)}">
      <button class="asset-media" type="button" data-open="${esc(item.id)}" aria-label="查看${esc(item.name)}">${artHTML(item)}<span class="media-kind">${esc(mediaLabel(item))}</span></button>
      <div class="asset-card-body"><h3>${esc(item.name)}</h3><p>${esc(description)}</p><div class="asset-card-meta"><span>${esc(item.model || (item.project === 'coast' ? '海岸来信' : '雨停之前'))}</span><span>${esc(item.state === 'busy' ? '处理中…' : item.imported ? '仅本次会话' : '演示样例')}</span></div></div>
      <div class="asset-card-actions"><button class="text-button" type="button" data-reuse="${esc(item.id)}"${item.state === 'busy' ? ' disabled' : ''}>${icon('sparkles')}使用提示词</button><button class="icon-button${favorite ? ' active' : ''}" type="button" data-favorite="${esc(item.id)}" aria-label="${favorite ? '取消收藏' : '收藏'}${esc(item.name)}" aria-pressed="${favorite}"${item.state === 'busy' ? ' disabled' : ''}>${icon('bookmark')}</button></div>
    </article>`;
  }
  function repaint(host, html) {
    const scrollTop = host.scrollTop;
    const scrollLeft = host.scrollLeft;
    const active = host.contains(document.activeElement) ? document.activeElement : null;
    const key = active && ['open', 'favorite', 'reuse', 'shot', 'scene'].find(name => active.dataset[name] != null);
    const value = key ? active.dataset[key] : null;
    host.innerHTML = html;
    host.scrollTop = scrollTop;
    host.scrollLeft = scrollLeft;
    if (key) {
      const replacement = $$(`[data-${key}]`, host).find(el => el.dataset[key] === value);
      focusQuiet(replacement || $('button:not(:disabled)', host) || $(`.app-nav [data-go="${currentPage}"]`));
    }
  }

  const filters = {
    chars: { kind: 'all', query: '', collection: 'all' }, favorites: { kind: 'all', query: '' }, assets: { kind: 'all', query: '' }
  };
  const rowsFor = group => group === 'chars' ? materials : group === 'assets' ? assets : Array.from(favorites, id => catalog.get(id)).filter(Boolean);
  const matchesQuery = (item, query) => `${item.name} ${item.description || ''} ${item.prompt || ''} ${item.category || ''} ${item.kind} ${item.model || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  function renderCollection(group) {
    const state = filters[group];
    const rows = rowsFor(group);
    const base = rows.filter(item => matchesQuery(item, state.query) && (group !== 'chars' || state.collection === 'all' || item.project === state.collection));
    const shown = base.filter(item => state.kind === 'all' || (group === 'chars' ? item.category : item.kind) === state.kind);
    repaint(byId(`${group}Grid`), shown.map(item => cardHTML(item, group === 'favorites' ? 'favorite-card' : '')).join(''));
    byId(`${group}Empty`).hidden = shown.length > 0;
    $$(`[data-filter-group="${group}"] [data-filter]`).forEach(el => {
      pressed(el, el.dataset.filter === state.kind);
      const count = base.filter(item => el.dataset.filter === 'all' || (group === 'chars' ? item.category : item.kind) === el.dataset.filter).length;
      let span = $('span', el);
      if (!span) { span = document.createElement('span'); el.append(' ', span); }
      span.textContent = String(count);
    });
    if (group === 'chars') {
      text('#charsCount', `${shown.length} / ${materials.length} 条素材`);
      $$('[data-collection]').forEach(el => {
        pressed(el, el.dataset.collection === state.collection);
        const count = materials.filter(item => (el.dataset.collection === 'all' || item.project === el.dataset.collection) && matchesQuery(item, state.query) && (state.kind === 'all' || item.category === state.kind)).length;
        $('span:last-child', el).textContent = String(count);
      });
    }
    if (group === 'assets') text('#localAssetCount', assets.length);
  }
  function resetFilters(group) {
    if (!filters[group]) return;
    Object.assign(filters[group], { kind: 'all', query: '', ...(group === 'chars' ? { collection: 'all' } : {}) });
    $(`[data-search="${group}"]`).value = '';
    renderCollection(group);
  }
  function renderResults() {
    repaint(byId('studioResults'), results.map((item, index) => cardHTML(item, `result-card${index === 0 ? ' featured' : ''}`)).join(''));
    const pending = results.filter(item => item.state === 'busy').length;
    text('#resultCount', `${results.length} 条记录${pending ? ` · ${pending} 条处理中` : ''}`);
  }
  function refreshCards() {
    ['chars', 'assets', 'favorites'].forEach(renderCollection);
    renderResults();
    $$('[data-dialog-favorite]').forEach(el => {
      const on = favorites.has(el.dataset.dialogFavorite);
      el.innerHTML = `${icon('bookmark')}<span>${on ? '取消收藏' : '收藏'}</span>`;
      el.setAttribute('aria-pressed', String(on));
    });
  }
  function toggleFavorite(id) {
    const item = catalog.get(id);
    if (!item || item.state === 'busy') return;
    const was = favorites.has(id);
    if (was) favorites.delete(id); else favorites.add(id);
    refreshCards();
    toast(`${was ? '已取消收藏' : '已收藏'}：${item.name}`, () => {
      if (was) favorites.add(id); else favorites.delete(id);
      refreshCards();
      toast('已撤销收藏更改');
    });
  }

  function renderReferences() {
    const list = $('.reference-list');
    list.innerHTML = currentShot.refs.map(id => catalog.get(id)).filter(Boolean).map(item => `<button class="reference" type="button" data-asset="${esc(item.id)}" aria-label="查看参考：${esc(item.name)}">${item.src ? `<img src="${esc(item.src)}" alt="${esc(item.name)}">` : icon(placeholderIcon(item))}<span>${esc(item.name)}</span></button>`).join('') + (currentShot.refs.length < 3 ? '<button class="reference reference-add" type="button" data-action="pickAsset" aria-label="添加参考素材">' + icon('plus') + '</button>' : '');
    $('.tiny-label', list.previousElementSibling).textContent = `${currentShot.refs.length} / 3`;
  }
  function paintPlay() {
    $$('[data-action="play"]').forEach(el => {
      el.innerHTML = icon(playing ? 'pause' : 'play');
      el.setAttribute('aria-label', playing ? '暂停分镜预览' : '播放分镜预览（静帧轮播，非视频）');
      el.setAttribute('aria-pressed', String(playing));
    });
    byId('cinemaScreen').classList.toggle('playing', playing);
  }
  function updatePosition() {
    position = clamp(position, 0, totalDuration());
    text('#playTime', clock(position));
    byId('playRange').value = String(position);
    byId('playRange').setAttribute('aria-valuetext', `${clock(position)} / ${clock(totalDuration())}，分镜预览`);
    byId('timelineClips').style.setProperty('--play-progress', `${totalDuration() ? position / totalDuration() * 100 : 0}%`);
  }
  function renderShot() {
    const index = shots.indexOf(currentShot);
    const sceneIndex = scenes.findIndex(scene => scene.id === currentShot.scene);
    const frame = byId('mainFrame');
    if (frame.getAttribute('src') !== currentShot.src) {
      frame.hidden = false;
      frame.src = currentShot.src;
    }
    frame.alt = `${currentShot.name} · 分镜静态参考图`;
    text('#frameShot', `SCENE ${pad(sceneIndex + 1)} / SHOT ${pad(index + 1)}`);
    text('#frameCaption', currentShot.caption || currentShot.name);
    text('.frame-quality', '分镜预览 · 非视频');
    text('.frame-aspect', currentShot.ratio.replace(':', ' : '));
    text('#inspectorIndex', `${pad(index + 1)} / ${pad(shots.length)}`);
    text('#shotOrdinal', `SHOT ${pad(index + 1)}`);
    text('#shotTitle', currentShot.name);
    text('#shotStatus', currentShot.busy ? '演示处理中…' : currentShot.state);
    byId('shotStatus').classList.toggle('success', !currentShot.busy);
    byId('shotPrompt').value = currentShot.prompt;
    byId('shotPrompt').setCustomValidity('');
    byId('shotModel').value = currentShot.model;
    byId('shotDuration').value = String(currentShot.duration);
    byId('shotRatio').value = currentShot.ratio;
    setSwitch($('.inspector [role="switch"]'), currentShot.sound);
    busy(byId('generateShot'), currentShot.busy, currentShot.busy ? '演示处理中…' : '重新生成这一镜');
    renderReferences();
    $$('[data-shot]').forEach(el => pressed(el, el.dataset.shot === currentShot.id));
    $$('[data-scene]').forEach(el => pressed(el, el.dataset.scene === currentShot.scene));
    $('[data-action="previousShot"]').disabled = index === 0;
    $('[data-action="nextShot"]').disabled = index === shots.length - 1;
    updatePosition();
  }
  function renderSequence() {
    const total = totalDuration();
    text('#projectShotCount', shots.length);
    text('#sequenceCount', `${shots.length} 镜 / ${total} 秒`);
    $('.project-name p').innerHTML = `<span class="status-dot"></span>演示项目 · 仅本次会话 <span class="dot-separator">·</span> ${scenes.length} 个场景 <span class="dot-separator">·</span> <span id="projectShotCount">${shots.length}</span> 个分镜`;
    text('.transport .timecode.muted', clock(total));
    text('#timelinePanel h3 span', `${total} 秒 / 静帧预览`);
    text('.waveform-track', '雨声 · 示意轨道，无音频播放');
    byId('playRange').max = String(total);
    $('.timeline-ruler').innerHTML = [0, .25, .5, .75, 1].map(part => `<span>${clock(total * part)}</span>`).join('');
    repaint($('.scene-tabs'), scenes.map((scene, index) => `<button type="button" data-scene="${esc(scene.id)}" aria-pressed="false"><span>${pad(index + 1)}</span> ${esc(scene.name)}</button>`).join(''));
    repaint(byId('shotList'), shots.map((shot, index) => `<button class="shot-card" type="button" data-shot="${esc(shot.id)}" aria-label="第 ${index + 1} 镜：${esc(shot.name)}，${shot.duration} 秒" aria-pressed="false"><span class="shot-thumb"><img src="${esc(shot.src)}" alt="${esc(shot.name)}" loading="lazy"><span class="shot-number">${pad(index + 1)}</span><span class="shot-duration">${shot.duration}s</span></span><span class="shot-info"><b>${esc(shot.name)}</b><span class="shot-state">${esc(shot.busy ? '演示处理中…' : shot.state)}</span></span></button>`).join(''));
    repaint(byId('timelineClips'), shots.map((shot, index) => `<button class="timeline-clip" type="button" data-shot="${esc(shot.id)}" style="flex:${shot.duration} 1 0%" aria-label="第 ${index + 1} 镜：${esc(shot.name)}，${shot.duration} 秒"><img src="${esc(shot.src)}" alt="" loading="lazy"><span>${pad(index + 1)} · ${shot.duration}s</span></button>`).join(''));
    renderShot();
  }
  function selectShot(shot) {
    if (!shot) return;
    stopPlayback();
    currentShot = shot;
    position = startOf(shot);
    renderShot();
  }
  function stopPlayback() {
    playing = false;
    cancelAnimationFrame(playFrame);
    paintPlay();
  }
  function tick(now) {
    if (!playing) return;
    if (document.hidden || currentPage !== 'director') { stopPlayback(); return; }
    position += (now - lastTick) / 1000;
    lastTick = now;
    const next = shotAt(position);
    if (next !== currentShot) { currentShot = next; renderShot(); }
    updatePosition();
    if (position >= totalDuration()) { stopPlayback(); return; }
    playFrame = requestAnimationFrame(tick);
  }
  function togglePlayback() {
    if (playing) { stopPlayback(); return; }
    if (currentPage !== 'director' || document.hidden) return;
    if (position >= totalDuration()) { position = 0; currentShot = shots[0]; renderShot(); }
    playing = true;
    lastTick = performance.now();
    paintPlay();
    playFrame = requestAnimationFrame(tick);
  }
  function requiredTrim(input) {
    input.setCustomValidity(input.value.trim() ? '' : '请填写内容，不能只输入空格。');
    if (!input.reportValidity()) { focusQuiet(input); return ''; }
    return input.value.trim();
  }
  function generateShot() {
    const mine = currentShot;
    if (mine.busy) return;
    const prompt = requiredTrim(byId('shotPrompt'));
    if (!prompt) return;
    mine.prompt = prompt;
    mine.busy = true;
    mine.lastRequest = { prompt, model: mine.model, duration: mine.duration, ratio: mine.ratio, refs: [...mine.refs], sound: mine.sound };
    renderSequence();
    window.setTimeout(() => {
      mine.busy = false;
      mine.state = '样例就绪';
      // 回执只改提交时抓住的镜头；切走后不覆盖别的描述、型号或候选。
      $$(`#shotList [data-shot="${mine.id}"] .shot-state`).forEach(el => { el.textContent = mine.state; });
      if (currentShot === mine) renderShot();
      toast(`${mine.name}：样例就绪，未生成真实视频、未扣费`);
    }, 1600);
  }

  const studioSpecs = {
    '视频': { models: ['可灵 2.6', 'Seedance 1.5 Pro', 'Veo 3.1'], label: '你想创造什么？', placeholder: '描述画面、镜头运动和氛围…', options: ['5 秒', '10 秒'], optionLabel: '时长', src: media.store },
    '图片': { models: ['Seedream 4.0', 'FLUX.1'], label: '描述你想要的图片', placeholder: '描述主体、光线和构图…', options: ['1 张', '2 张', '4 张'], optionLabel: '数量（样例合为一条记录）', src: media.street },
    '语音': { models: ['MiniMax Speech 2.6', 'MiMo TTS'], label: '朗读文本', placeholder: '输入要朗读的文字…', options: ['自然', '舒缓', '明亮'], optionLabel: '语气', src: '' }
  };
  const studioState = {
    '视频': { prompt: byId('studioPrompt').value, model: '可灵 2.6', ratio: defaultRatio, option: '5 秒', refs: [] },
    '图片': { prompt: '', model: 'Seedream 4.0', ratio: defaultRatio, option: '1 张', refs: [] },
    '语音': { prompt: '', model: 'MiniMax Speech 2.6', ratio: defaultRatio, option: '自然', refs: [] }
  };
  let genType = '视频';
  let studioBusy = false;
  function paintStudioButton() { busy(byId('studioGenerate'), studioBusy, studioBusy ? '演示处理中…' : '开始生成'); }
  function renderStudio() {
    const spec = studioSpecs[genType];
    const state = studioState[genType];
    $$('[data-gen-type]').forEach(el => pressed(el, el.dataset.genType === genType));
    text('#studioPromptLabel', spec.label);
    byId('studioPrompt').placeholder = spec.placeholder;
    byId('studioPrompt').value = state.prompt;
    byId('studioPrompt').setCustomValidity('');
    byId('studioModel').innerHTML = spec.models.map(model => `<option>${esc(model)}</option>`).join('');
    byId('studioModel').value = state.model;
    byId('studioRatio').value = state.ratio;
    byId('studioRatio').closest('.field').hidden = genType === '语音';
    byId('studioDuration').innerHTML = spec.options.map(option => `<option>${esc(option)}</option>`).join('');
    byId('studioDuration').value = state.option;
    text('label[for="studioDuration"]', spec.optionLabel);
    const pick = $('#studioForm [data-action="pickAsset"]');
    $('b', pick).textContent = state.refs.length ? '已选择参考素材' : genType === '语音' ? '引用素材描述' : '添加参考素材';
    $('span', pick).textContent = state.refs.length ? state.refs.map(id => catalog.get(id)?.name || '').join('、') : '从素材库选取';
    paintStudioButton();
  }
  function submitStudio(event) {
    if (event) event.preventDefault();
    if (studioBusy) return;
    const prompt = requiredTrim(byId('studioPrompt'));
    if (!prompt) return;
    const type = genType;
    studioState[type].prompt = prompt;
    const config = { ...studioState[type], refs: [...studioState[type].refs] };
    const record = register({ id: uid('result'), source: 'result', kind: type === '语音' ? '音频' : type, project: 'rain', sample: true, state: 'busy', name: `${type}演示 · ${prompt.slice(0, 18)}${prompt.length > 18 ? '…' : ''}`, description: '本地计时演示中，不请求 AI。', src: '', ...config });
    results.unshift(record);
    studioBusy = true;
    paintStudioButton();
    renderResults();
    window.setTimeout(() => {
      // 结果身份与参数快照属于这次提交，不读取当前页或当前生成类型。
      record.state = 'ready';
      record.src = studioSpecs[type].src;
      record.description = type === '语音' ? '语音演示记录 · 未合成声音，暂无音频。' : `固定本地样图 · 非真实生成${type}，不代表提示词效果。`;
      studioBusy = false;
      paintStudioButton();
      renderResults();
      toast(`${type}演示记录已就绪 · 未调用 AI、未扣费`);
    }, 1800);
  }
  function reuseItem(id) {
    const item = catalog.get(id);
    if (!item || item.state === 'busy') return;
    const type = item.kind === '音频' ? '语音' : item.kind === '视频' ? '视频' : '图片';
    studioState[type].prompt = item.prompt || `${item.name}。${item.description || ''}`;
    studioState[type].refs = item.source === 'material' ? [item.id] : [];
    genType = type;
    const go = () => { showPage('studio'); renderStudio(); focusQuiet(byId('studioPrompt')); toast('已带入提示词 · 尚未提交'); };
    if (dialog.open) closeDialog(go); else go();
  }

  const ownedURLs = new Set();
  function objectURL(blob) { const url = URL.createObjectURL(blob); ownedURLs.add(url); return url; }
  function revokeURL(url) { if (ownedURLs.delete(url)) URL.revokeObjectURL(url); }
  const safeName = value => String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100).trim() || '演示文件';
  function download(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName(name);
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  }
  function downloadText(content, mime, name) {
    const url = objectURL(new Blob([content], { type: mime }));
    download(url, name);
    // 下载交给浏览器后留足读取时间；导入媒体则保留到本次文档离开。
    window.setTimeout(() => revokeURL(url), 60000);
  }
  function downloadItem(id) {
    const item = catalog.get(id);
    if (!item || !item.src) { toast('此样例没有媒体文件可下载'); return; }
    const ext = item.src.endsWith('.webp') ? 'webp' : 'jpg';
    download(item.src, item.imported ? item.fileName : `${safeName(item.name)}-样图.${ext}`);
    toast(item.imported ? '已请求下载本次导入的原文件' : '已请求下载真实样图，不是视频');
  }
  function detailHTML(item) {
    let content;
    if (item.imported && item.kind === '视频') content = `<video class="dialog-media" src="${esc(item.src)}" controls playsinline preload="metadata"></video>`;
    else if (item.imported && item.kind === '音频') content = `<audio class="dialog-media" src="${esc(item.src)}" controls preload="metadata"></audio>`;
    else if (item.src) content = `<img class="dialog-media" src="${esc(item.src)}" alt="${esc(item.name)}">`;
    else content = artHTML(item);
    return `${content}<p>${esc(item.description || item.prompt || '')}</p><p class="tiny-label">${esc(mediaLabel(item))}${item.imported ? ' · 仅本次浏览器会话，未上传' : ' · 未连接任何生成平台'}</p>
      <div class="dialog-actions"><button class="button secondary" type="button" data-reuse="${esc(item.id)}"${item.state === 'busy' ? ' disabled' : ''}>使用提示词</button><button class="button secondary" type="button" data-dialog-favorite="${esc(item.id)}" aria-pressed="${favorites.has(item.id)}"${item.state === 'busy' ? ' disabled' : ''}>${icon('bookmark')}<span>${favorites.has(item.id) ? '取消收藏' : '收藏'}</span></button>${item.src ? `<button class="button primary" type="button" data-download="${esc(item.id)}">${icon('download')}${item.imported ? '下载原文件' : '下载样图'}</button>` : ''}</div>`;
  }
  function openItem(id) {
    const item = catalog.get(id);
    if (item) openDialog(item.name, detailHTML(item));
  }
  function pickAsset() {
    const targetShot = currentPage === 'director' ? currentShot : null;
    const type = genType;
    const selected = targetShot ? targetShot.refs : studioState[type].refs;
    if (targetShot && selected.length >= 3) { toast('每镜最多 3 个参考素材'); return; }
    openDialog(targetShot ? `参考素材 · ${targetShot.name}` : `${type} · 选择参考素材`, `<p class="tiny-label">${targetShot ? '添加到这一镜，最多 3 个。' : '选择一项，替换本类型的参考素材。'} 仅引用名称与描述，不发起请求。</p><div class="asset-grid">${materials.map(item => `<article class="asset-card"><button class="asset-media" type="button" data-pick="${esc(item.id)}" aria-label="选择${esc(item.name)}"${targetShot && selected.includes(item.id) ? ' disabled' : ''}>${artHTML(item)}<span class="media-kind">${selected.includes(item.id) ? '已选择' : esc(item.category)}</span></button><div class="asset-card-body"><h3>${esc(item.name)}</h3><p>${esc(item.description)}</p><div class="asset-card-meta">${esc(item.project === 'rain' ? '雨停之前' : '海岸来信')}</div></div><div class="asset-card-actions"><button class="text-button" type="button" data-pick="${esc(item.id)}"${targetShot && selected.includes(item.id) ? ' disabled' : ''}>选择</button></div></article>`).join('')}</div>`, body => {
      body.addEventListener('click', event => {
        const button = event.target.closest('[data-pick]');
        if (!button || button.disabled) return;
        const item = catalog.get(button.dataset.pick);
        if (!item) return;
        if (targetShot) {
          if (targetShot.refs.length >= 3 || targetShot.refs.includes(item.id)) return;
          targetShot.refs.push(item.id);
          if (currentShot === targetShot) renderReferences();
        } else {
          studioState[type].refs = [item.id];
          if (genType === type) renderStudio();
        }
        closeDialog();
        toast(`已引用：${item.name}`);
      }, { signal: dialogEvents.signal });
    });
  }
  function previewShot() {
    const mine = currentShot;
    openDialog(`${mine.name} · 分镜预览`, `<img class="dialog-media" src="${esc(mine.src)}" alt="${esc(mine.name)}"><p>${esc(mine.prompt)}</p><p class="tiny-label">静帧参考 · 非视频 · ${mine.duration} 秒 · ${esc(mine.ratio)}</p>`);
  }
  function openExport() {
    openDialog('导出作品', `<p>静态演示不能导出视频、音频或剪辑工程。</p><p class="tiny-label">可下载当前内存中的分镜 JSON：${shots.length} 镜，${totalDuration()} 秒；不包含媒体字节。</p><div class="dialog-actions"><button class="button primary" type="button" data-action="downloadStoryboard">${icon('download')}下载分镜 JSON</button></div>`);
  }
  function exportStoryboard() {
    const value = {
      demo: true, note: '独立静态设计预览，媒体为本地参考图，非生成视频。', title: '雨停之前', totalDuration: totalDuration(),
      scenes: scenes.map(scene => ({ ...scene })),
      shots: shots.map(shot => ({ id: shot.id, scene: shot.scene, name: shot.name, prompt: shot.prompt, duration: shot.duration, model: shot.model, ratio: shot.ratio, image: shot.src, sound: shot.sound, references: shot.refs.map(id => ({ id, name: catalog.get(id)?.name || id })) }))
    };
    downloadText(JSON.stringify(value, null, 2), 'application/json;charset=utf-8', '雨停之前-演示分镜.json');
    toast('已请求下载分镜 JSON · 不包含视频');
  }

  function formDialog(title, fields, onSubmit) {
    openDialog(title, `<form id="demoForm">${fields}<p class="tiny-label">仅保留在本次浏览器会话，不写入作品库。</p><div class="dialog-actions"><button class="button secondary" type="button" data-cancel-form>取消</button><button class="button primary" type="button" data-submit-form>添加</button></div></form>`, body => {
      const form = $('#demoForm', body);
      $('[data-cancel-form]', form).addEventListener('click', () => closeDialog());
      $('[data-submit-form]', form).addEventListener('click', () => form.requestSubmit());
      form.addEventListener('submit', event => {
        event.preventDefault();
        const nameInput = $('[name="name"]', form);
        const name = requiredTrim(nameInput);
        if (!name) return;
        onSubmit(new FormData(form), name);
      });
      $('[name="name"]', form).addEventListener('input', event => event.target.setCustomValidity(''));
    });
  }
  function nameField(label, placeholder) { return `<div class="field"><label for="newName">${esc(label)}</label><input id="newName" name="name" maxlength="80" placeholder="${esc(placeholder)}" required autofocus></div>`; }
  function newShot(sceneId, name, prompt, duration) {
    return { id: uid('shot'), scene: sceneId, name, prompt: prompt || name, duration, model: '可灵 2.6', ratio: defaultRatio, src: media.street, caption: name, refs: [], sound: true, busy: false, state: '待生成 · 样图' };
  }
  function addShot() {
    const sceneId = currentShot.scene;
    formDialog('添加分镜', nameField('镜头名称', '例如：街角的告别') + `<div class="field"><label for="newScene">所属场景</label><select id="newScene" name="scene">${scenes.map(scene => `<option value="${esc(scene.id)}"${scene.id === sceneId ? ' selected' : ''}>${esc(scene.name)}</option>`).join('')}</select></div><div class="field"><label for="newPrompt">画面描述</label><textarea id="newPrompt" name="prompt" rows="3" maxlength="5000"></textarea></div><div class="field"><label for="newDuration">时长</label><select id="newDuration" name="duration"><option value="6">6 秒</option><option value="5">5 秒</option><option value="8">8 秒</option><option value="10">10 秒</option></select></div><p class="tiny-label">新镜头使用雨夜街头样图占位，不是真实生成。</p>`, (form, name) => {
      const scene = String(form.get('scene'));
      if (!scenes.some(row => row.id === scene)) return;
      const shot = newShot(scene, name, String(form.get('prompt')).trim(), Number(form.get('duration')));
      let last = -1;
      shots.forEach((row, index) => { if (row.scene === scene) last = index; });
      shots.splice(last + 1, 0, shot);
      currentShot = shot;
      position = startOf(shot);
      renderSequence();
      closeDialog();
      toast(`已添加分镜：${name}`);
    });
  }
  function addScene() {
    formDialog('新增场景', nameField('场景名称', '例如：天亮之前') + '<p class="tiny-label">同时添加一镜，初始 6 秒，使用街景样图占位。</p>', (_form, name) => {
      const scene = { id: uid('scene'), name };
      scenes.push(scene);
      const shot = newShot(scene.id, `${name} · 第一镜`, name, 6);
      shots.push(shot);
      currentShot = shot;
      position = startOf(shot);
      renderSequence();
      closeDialog();
      toast(`已添加场景：${name}`);
    });
  }
  function newAsset() {
    formDialog('新建素材', nameField('素材名称', '角色、场景或物品的名称') + '<div class="field"><label for="newCategory">类型</label><select id="newCategory" name="category"><option>角色</option><option>场景</option><option>物品</option></select></div><div class="field"><label for="newProject">所属项目</label><select id="newProject" name="project"><option value="rain">雨停之前</option><option value="coast">海岸来信</option></select></div><div class="field"><label for="newDescription">描述</label><textarea id="newDescription" name="description" rows="3" maxlength="5000"></textarea></div>', (form, name) => {
      const item = register({ id: uid('material'), name, source: 'material', kind: '图片', src: '', sample: true, category: String(form.get('category')), project: String(form.get('project')), description: String(form.get('description')).trim() || '待添加参考图。' });
      materials.push(item);
      resetFilters('chars');
      closeDialog(() => showPage('chars'));
      toast(`已添加素材：${name}`);
    });
  }
  function openProjects() {
    openDialog('我的项目', `<div class="asset-grid"><article class="asset-card"><div class="asset-card-body"><h3>雨停之前</h3><p>当前演示项目 · ${scenes.length} 个场景 · ${shots.length} 镜 · ${totalDuration()} 秒</p><div class="asset-card-meta">所有修改仅在内存</div></div><div class="asset-card-actions"><button class="button primary" type="button" data-action="currentProject">回到导演台</button></div></article><article class="asset-card"><div class="asset-card-body"><h3>海岸来信</h3><p>项目概念预览 · ${materials.filter(item => item.project === 'coast').length} 条素材</p><div class="asset-card-meta">未建立分镜工程，不支持切换</div></div><div class="asset-card-actions"><button class="button secondary" type="button" data-action="coastPreview">查看素材预览</button></div></article></div>`);
  }
  function openSearch() {
    openDialog('搜索工作空间', '<label class="search-field"><i data-icon="search"></i><input id="globalSearch" type="search" placeholder="搜索页面、素材或作品" aria-label="搜索页面、素材或作品" autofocus></label><div id="globalSearchResults"></div>', body => {
      const input = $('#globalSearch', body);
      const render = () => {
        const query = input.value.trim().toLocaleLowerCase();
        const pageMatches = pages.filter(page => page.name.toLocaleLowerCase().includes(query));
        const itemMatches = Array.from(catalog.values()).filter(item => matchesQuery(item, query)).slice(0, 30);
        const host = $('#globalSearchResults', body);
        host.innerHTML = pageMatches.map(page => `<button class="rail-item" type="button" data-search-page="${page.id}">${icon(page.icon)}<b>${esc(page.name)}</b><span>页面</span></button>`).join('') + itemMatches.map(item => `<button class="rail-item" type="button" data-search-item="${esc(item.id)}">${icon(placeholderIcon(item))}<b>${esc(item.name)}</b><span>${item.source === 'material' ? '素材' : item.source === 'asset' ? '资产' : '记录'}</span></button>`).join('') || '<p class="empty-state">没有匹配结果</p>';
      };
      input.addEventListener('input', render);
      body.addEventListener('click', event => {
        const page = event.target.closest('[data-search-page]');
        const item = event.target.closest('[data-search-item]');
        if (page) closeDialog(() => showPage(page.dataset.searchPage, true));
        else if (item) {
          const row = catalog.get(item.dataset.searchItem);
          if (!row) return;
          closeDialog(() => {
            showPage(row.source === 'material' ? 'chars' : row.source === 'asset' ? 'assets' : 'studio');
            openItem(row.id);
          });
        }
      }, { signal: dialogEvents.signal });
      render();
    });
  }

  const costs = [1.8, 2.4, 1.6, 3.2, 2.8, 4, 2.6, 4.4, 3.6, 2.8, 4.6, 5, 4.2, 5.6];
  const works = [1, 2, 1, 2, 2, 3, 2, 3, 3, 2, 4, 4, 3, 4];
  function usageRows() {
    const days = Number(byId('usagePeriod').value) === 7 ? 7 : 14;
    return costs.slice(-days).map((cost, index) => ({ day: 29 - days + index, cost, works: works[14 - days + index] }));
  }
  function renderUsage() {
    const rows = usageRows();
    const cost = rows.reduce((sum, row) => sum + row.cost, 0);
    const count = rows.reduce((sum, row) => sum + row.works, 0);
    text('#totalCost', cost.toFixed(2));
    text('#totalWorks', count);
    const metrics = $$('.metric-card');
    $('strong', metrics[2]).innerHTML = `<small>¥</small>${(cost / count).toFixed(2)}`;
    $('p', metrics[0]).textContent = '固定示例账单 · 非实际消费';
    $('p', metrics[1]).textContent = rows.length === 14 ? '视频 18 · 图片 12 · 语音 6（示例）' : '视频 12 · 图片 7 · 语音 4（示例）';
    $('p', metrics[2]).textContent = '按所选时段示例数据计算';
    byId('usageChart').innerHTML = rows.map(row => `<button class="chart-bar" type="button" style="height:${row.cost / 12 * 100}%" data-usage-day="${row.day}" title="10 月 ${row.day} 日：¥${row.cost.toFixed(2)}，${row.works} 件（示例）" aria-label="10 月 ${row.day} 日，示例消费 ${row.cost.toFixed(2)} 元，${row.works} 件"><span>${row.cost.toFixed(1)}</span></button>`).join('');
    $('.chart-dates').innerHTML = [rows[0], rows[Math.floor((rows.length - 1) / 2)], rows[rows.length - 1]].map(row => `<span>10 月 ${row.day} 日</span>`).join('');
    text('.ledger h2', '最近账单 · 示例');
  }
  function exportBill() {
    const csv = '\uFEFF' + ['性质,日期,示例消费（元）,示例作品数', ...usageRows().map(row => `静态演示数据,2026-10-${row.day},${row.cost.toFixed(2)},${row.works}`)].join('\r\n');
    downloadText(csv, 'text/csv;charset=utf-8', '拾帧-示例账单.csv');
    toast('已请求下载所选时段示例 CSV，非真实账单');
  }

  const settingIds = $$('[data-setting-nav]').map(el => el.dataset.settingNav);
  let settingLock = '';
  let settingLockUntil = 0;
  let settingsFrame = 0;
  function highlightSetting(id) {
    $$('[data-setting-nav]').forEach(el => {
      const active = el.dataset.settingNav === id;
      el.classList.toggle('active', active);
      if (active) el.setAttribute('aria-current', 'location'); else el.removeAttribute('aria-current');
    });
  }
  function settingsScrollHost() {
    let el = $('.settings-document');
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  }
  function syncSettingsNav() {
    settingsFrame = 0;
    if (currentPage !== 'settings') return;
    if (settingLock && performance.now() < settingLockUntil) { highlightSetting(settingLock); return; }
    settingLock = '';
    const host = settingsScrollHost();
    const top = host === document.scrollingElement ? 0 : host.getBoundingClientRect().top;
    let chosen = settingIds[0];
    settingIds.forEach(id => { if (byId(id).getBoundingClientRect().top <= top + 96) chosen = id; });
    if (host.scrollHeight > host.clientHeight + 1 && host.scrollTop + host.clientHeight >= host.scrollHeight - 3) chosen = settingIds[settingIds.length - 1];
    highlightSetting(chosen);
  }
  function goSetting(id) {
    if (!settingIds.includes(id)) return;
    settingLock = id;
    settingLockUntil = performance.now() + 1000;
    highlightSetting(id);
    const host = settingsScrollHost();
    const top = host === document.scrollingElement ? 0 : host.getBoundingClientRect().top;
    host.scrollTo({ top: Math.max(0, host.scrollTop + byId(id).getBoundingClientRect().top - top - 16), behavior: reducedMotion ? 'instant' : 'smooth' });
    window.setTimeout(() => { if (settingLock === id) { settingLockUntil = 0; syncSettingsNav(); } }, 1050);
  }
  document.addEventListener('scroll', () => {
    if (currentPage === 'settings' && !settingsFrame) settingsFrame = requestAnimationFrame(syncSettingsNav);
  }, true);
  ['wheel', 'touchstart'].forEach(name => document.addEventListener(name, () => { settingLock = ''; }, { passive: true }));

  function honestyLabels() {
    text('.storage-title h2 .status-tag', '会话演示');
    text('.storage-title p', '示例作品 + 本次浏览器导入 · 未访问磁盘作品库');
    const stat = $$('.storage-stat')[1];
    $('strong', stat).innerHTML = '1.28 <small>GB</small>';
    $('span', stat).textContent = '示例容量 · 非实测';
    text('.storage-meter div span', '示例可用空间');
    text('.date-heading > span', '预置样例 / 本次导入 · 刷新后重置');
    text('#storage .settings-row p', '仅本次浏览器会话，未选择本机目录');
    const autosave = $('#defaults [role="switch"]');
    autosave.setAttribute('aria-label', '自动保留演示记录');
    text('#defaults .settings-row:last-child b', '自动保留演示记录');
    text('#defaults .settings-row:last-child p', '仅示例开关，不写盘；记录在刷新后清空');
    $$('.provider-settings-row .status-tag').forEach(el => { el.textContent = '示例连接'; });
    text('.page-foot > span:first-child', '演示项目与导入文件仅留在本次会话。');
    $('.page-foot > span:last-child').innerHTML = '静帧分镜预览 <b>·</b> 非视频 <b>·</b> 无真实生成';
  }

  const actions = {
    search: openSearch, projects: openProjects, export: openExport, downloadStoryboard: exportStoryboard,
    play: togglePlayback, preview: previewShot, addShot, addScene, newAsset, pickAsset,
    previousShot: () => selectShot(shots[shots.indexOf(currentShot) - 1]),
    nextShot: () => selectShot(shots[shots.indexOf(currentShot) + 1]),
    currentProject: () => closeDialog(() => showPage('director')),
    coastPreview: () => closeDialog(() => { resetFilters('chars'); filters.chars.collection = 'coast'; renderCollection('chars'); showPage('chars'); toast('海岸来信素材预览 · 当前分镜项目仍为雨停之前'); }),
    import: () => byId('assetFile').click(),
    polish: () => {
      const prompt = requiredTrim(byId('shotPrompt'));
      if (!prompt) return;
      const suffix = ' 保持主体清晰，光线自然，镜头运动克制。';
      const mine = currentShot;
      const previous = mine.prompt;
      mine.prompt = prompt.includes(suffix.trim()) ? prompt : prompt + suffix;
      byId('shotPrompt').value = mine.prompt;
      toast('已应用固定润色示例 · 未调用 AI', () => { mine.prompt = previous; if (currentShot === mine) byId('shotPrompt').value = previous; toast('已撤销润色'); });
    },
    help: () => openDialog('关于这个预览', '<p>七页独立静态演示，可直接用 file:// 打开。</p><p>所有生成、余额、账单与连接均为样例。不联网、不请求 AI、不收集密钥、不读写真实作品库。</p><p>播放只按镜头时长轮播静帧，不是视频。导入文件仅由本浏览器持有，刷新后清空。仅主题、减少动效、默认比例三项偏好保存在 pages-demo 前缀下。</p><p>Ctrl / ⌘ K 搜索；Escape 关闭弹窗。导出仅支持分镜 JSON 与示例账单 CSV。</p>'),
    provider: () => openDialog('供应商 · 演示边界', '<p>这里没有真实连接，也不提供密钥输入。</p><p>型号名称与连接状态用于展示界面；此演示不会向可灵、Seedance、DeepSeek 或其他服务发送请求、检测账户或扣费。</p>'),
    refreshBalance: button => {
      if (button.disabled) return;
      busy(button, true);
      window.setTimeout(() => { busy(button, false); toast('示例余额已刷新，数值未变 · 未查询真实账户'); }, 700);
    },
    exportBill
  };

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    if (!target) return;
    const button = target.closest('button');
    if (button?.disabled) return;
    const setting = target.closest('[data-setting-nav]');
    if (setting) { event.preventDefault(); goSetting(setting.dataset.settingNav); return; }
    const skip = target.closest('.skip-link');
    if (skip) { event.preventDefault(); focusQuiet(byId('workspace')); return; }
    const go = target.closest('[data-go]');
    if (go) { showPage(go.dataset.go); return; }
    const action = target.closest('[data-action]');
    if (action) { const run = actions[action.dataset.action]; if (run) run(action); else toast('此操作仅为静态演示'); return; }
    if (target.closest('[data-toast-undo]')) {
      const run = undoToast;
      undoToast = null;
      if (run) run();
      return;
    }
    const shot = target.closest('[data-shot]');
    if (shot) { selectShot(shots.find(row => row.id === shot.dataset.shot)); return; }
    const scene = target.closest('[data-scene]');
    if (scene) { selectShot(shots.find(row => row.scene === scene.dataset.scene)); return; }
    const mode = target.closest('[data-mode]');
    if (mode) {
      $$('[data-mode]').forEach(el => pressed(el, el === mode));
      byId('storyboardPanel').hidden = mode.dataset.mode !== 'storyboard';
      byId('timelinePanel').hidden = mode.dataset.mode !== 'timeline';
      return;
    }
    const theme = target.closest('[data-theme-choice]');
    if (theme) { setTheme(theme.dataset.themeChoice); return; }
    const filter = target.closest('[data-filter]');
    if (filter) { const group = filter.closest('[data-filter-group]').dataset.filterGroup; filters[group].kind = filter.dataset.filter; renderCollection(group); return; }
    const collection = target.closest('[data-collection]');
    if (collection) { filters.chars.collection = collection.dataset.collection; renderCollection('chars'); return; }
    const reset = target.closest('[data-reset]');
    if (reset) { resetFilters(reset.dataset.reset); return; }
    const view = target.closest('[data-assets-view]');
    if (view) {
      $$('[data-assets-view]').forEach(el => pressed(el, el === view));
      byId('assetsGrid').classList.toggle('is-list', view.dataset.assetsView === 'list');
      byId('assetsGrid').dataset.layout = view.dataset.assetsView;
      return;
    }
    const type = target.closest('[data-gen-type]');
    if (type) { genType = type.dataset.genType; renderStudio(); return; }
    const open = target.closest('[data-open], [data-asset]');
    if (open) { openItem(open.dataset.open || open.dataset.asset); return; }
    const favorite = target.closest('[data-favorite], [data-dialog-favorite]');
    if (favorite) { toggleFavorite(favorite.dataset.favorite || favorite.dataset.dialogFavorite); return; }
    const reuse = target.closest('[data-reuse]');
    if (reuse) { reuseItem(reuse.dataset.reuse); return; }
    const save = target.closest('[data-download]');
    if (save) { downloadItem(save.dataset.download); return; }
    const day = target.closest('[data-usage-day]');
    if (day) { toast(day.title); return; }
    const toggle = target.closest('[role="switch"]');
    if (toggle && toggle.id !== 'reduceMotion') {
      const active = toggle.getAttribute('aria-checked') !== 'true';
      setSwitch(toggle, active);
      if (toggle.closest('.inspector')) { currentShot.sound = active; toast(`环境音${active ? '已启用' : '已关闭'} · 仅参数演示，无声音合成`); }
      else toast('仅切换演示状态，不写盘或自动下载');
    }
  });
  byId('toggleNav').addEventListener('click', () => {
    const expanded = document.body.classList.toggle('nav-expanded');
    byId('toggleNav').setAttribute('aria-expanded', String(expanded));
    byId('toggleNav').setAttribute('aria-label', expanded ? '收起导航' : '展开导航');
  });
  byId('themeToggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  byId('reduceMotion').addEventListener('click', () => { reducedMotion = !reducedMotion; applyMotion(); });
  byId('defaultRatio').addEventListener('change', event => {
    if (!ratios.includes(event.target.value)) return;
    defaultRatio = event.target.value;
    writePref('default-ratio', defaultRatio);
  });
  $$('[data-search]').forEach(input => input.addEventListener('input', () => { filters[input.dataset.search].query = input.value; renderCollection(input.dataset.search); }));
  byId('shotPrompt').addEventListener('input', event => { currentShot.prompt = event.target.value; event.target.setCustomValidity(''); });
  byId('shotModel').addEventListener('change', event => { currentShot.model = event.target.value; });
  byId('shotRatio').addEventListener('change', event => { currentShot.ratio = event.target.value; text('.frame-aspect', currentShot.ratio.replace(':', ' : ')); });
  byId('shotDuration').addEventListener('change', event => {
    const value = Number(event.target.value);
    if (![5, 6, 8, 10].includes(value)) return;
    stopPlayback();
    const offset = position - startOf(currentShot);
    currentShot.duration = value;
    position = startOf(currentShot) + clamp(offset, 0, Math.max(0, value - .1));
    renderSequence();
  });
  byId('generateShot').addEventListener('click', generateShot);
  byId('playRange').addEventListener('input', event => {
    stopPlayback();
    position = Number(event.target.value);
    currentShot = shotAt(position);
    renderShot();
  });
  byId('studioPrompt').addEventListener('input', event => { studioState[genType].prompt = event.target.value; event.target.setCustomValidity(''); });
  byId('studioModel').addEventListener('change', event => { studioState[genType].model = event.target.value; });
  byId('studioRatio').addEventListener('change', event => { studioState[genType].ratio = event.target.value; });
  byId('studioDuration').addEventListener('change', event => { studioState[genType].option = event.target.value; });
  byId('studioForm').addEventListener('submit', submitStudio);
  byId('usagePeriod').addEventListener('change', renderUsage);
  byId('assetFile').addEventListener('change', event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^(image|video|audio)\/[a-z0-9.+-]+$/i.test(file.type) || !file.size) {
      toast('请选择非空的图片、视频或音频文件（需有效 MIME 类型）');
      return;
    }
    const kind = file.type.startsWith('image/') ? '图片' : file.type.startsWith('video/') ? '视频' : '音频';
    try {
      const item = register({ id: uid('import'), source: 'asset', project: 'rain', kind, imported: true, sample: false, name: file.name, fileName: file.name, mime: file.type, size: file.size, src: objectURL(file), description: '本次浏览器导入 · 未上传、未复制到磁盘作品库。' });
      assets.unshift(item);
      resetFilters('assets');
      showPage('assets');
      toast(`已导入：${file.name} · 仅本次会话`);
    } catch (_) { toast('无法读取该文件，请重新选择'); }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
    if (event.key === 'Escape') stopPlayback();
    if (['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp'].includes(event.key)) settingLock = '';
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPlayback(); pauseDialogMedia(); } });
  window.addEventListener('pagehide', event => {
    stopPlayback();
    pauseDialogMedia();
    if (!event.persisted) Array.from(ownedURLs).forEach(revokeURL);
  });
  // 缺失图片只在它自己的媒体槽显示空态，不用别的街景冒充人物或物品。
  document.addEventListener('error', event => {
    const el = event.target;
    if (el instanceof HTMLImageElement) {
      el.hidden = true;
      const host = el.parentElement;
      if (!host || host.querySelector('[data-missing-media]')) return;
      const hint = document.createElement('span');
      hint.className = 'object-art';
      hint.dataset.missingMedia = 'true';
      hint.innerHTML = `${icon('image')}<span>图片暂不可用</span>`;
      host.insertBefore(hint, el.nextSibling);
    } else if (el instanceof HTMLMediaElement) {
      toast('浏览器无法解码这个文件，可下载原文件后使用本机播放器');
    }
  }, true);
  document.addEventListener('load', event => {
    const el = event.target;
    if (!(el instanceof HTMLImageElement)) return;
    el.hidden = false;
    const hint = el.parentElement?.querySelector('[data-missing-media]');
    if (hint) hint.remove();
  }, true);

  fillIcons();
  setTheme(readPref('theme', 'light'), false);
  applyMotion(false);
  byId('defaultRatio').value = defaultRatio;
  byId('studioForm').noValidate = true;
  honestyLabels();
  renderSequence();
  renderStudio();
  refreshCards();
  renderUsage();
  showPage('director');
})();
