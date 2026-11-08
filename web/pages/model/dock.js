/* 建模台底部轨道坞 —— 播放时钟、轨道行、播放头、路径 / 关键帧编辑的唯一所有者。
   页面只把 doc / view / 选中对象递进来；这里改完轨道后调 view.rebuild()，
   再通过 onChange 让页面刷新页头与出片条。

   为什么时钟必须只有这一份：view.js 只接收 `setTime(t)`，不再自己按 dt 累加；
   两处同时推进会让播放速度、出片取帧与播放头读数互相漂移。 */

import * as S from '../../model3d/schema.js';
import { clipOf } from '../../model3d/clip.js';
import { trackColorOf } from '../../model3d/palette.js';

const dEsc = s => window.esc(String(s == null ? '' : s));
const dIcon = (name, size) => (window.icon ? window.icon(name, size || 12) : '');
const dNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function trackName(doc, tr) {
  if (!tr || !tr.of) return '（轨道）';
  if (tr.of.kind === 'cam') {
    const cam = S.camOf(doc, tr.of.id);
    return cam ? cam.name : '（机位已不在）';
  }
  const node = S.findNode(doc.scene.nodes, tr.of.id);
  if (!node) return '（节点已不在）';
  if (node.name) return node.name;
  if (node.kind === 'mannequin') return '小人';
  if (node.kind === 'crowd') return '群众 ' + node.rows + '×' + node.cols;
  if (node.kind === 'prim') return node.shape || '零件';
  if (node.kind === 'asset') return '摆件';
  return '组';
}

function trackIcon(tr) {
  return tr && tr.of && tr.of.kind === 'cam' ? 'video' : 'users';
}

function pathKindZh(kind) {
  return ({ line: '直线', circle: '圆', rect: '矩形', free: '自由' })[kind] || '定点';
}

function makeTrack(doc, of) {
  return {
    id: S.newId('t'), of, enabled: true, color: 0, interp: 'smooth',
    motion: of.kind === 'node' ? 'walk' : '', joint: '', path: null, keys: [],
  };
}

export function createDock(opts = {}) {
  const host = opts.host;
  const getDoc = opts.getDoc || (() => null);
  const getView = opts.getView || (() => null);
  const getSelectedId = opts.getSelectedId || (() => '');
  const note = opts.note || (() => {});
  const onChange = opts.onChange || (() => {});
  const getNote = opts.getNote || (() => ({ text: '', kind: '' }));

  let selectedTrack = '';
  let raf = 0;
  let playing = false;
  let startedAt = 0;
  let baseTime = 0;

  const doc = () => getDoc();
  const view = () => getView();
  const durationOf = () => Math.max(0.001, dNum(doc() && doc().anim && doc().anim.duration, 4));

  function dockTimeText() {
    const v = view();
    return (v ? v.time : 0).toFixed(1) + ' / ' + durationOf().toFixed(1) + ' 秒';
  }

  function updatePlayhead() {
    if (!host) return;
    const d = durationOf();
    const t = Math.max(0, Math.min(d, view() ? view().time : 0));
    const pct = (t / d) * 100;
    for (const el of host.querySelectorAll('[data-dock="playhead"]')) el.style.left = pct + '%';
    const txt = host.querySelector('[data-dock="time"]');
    if (txt) txt.textContent = dockTimeText();
  }

  function stopClock() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    playing = false;
    const v = view();
    if (v) v.playing = false;
  }

  function clockFrame(now) {
    raf = 0;
    if (!playing) return;
    const d = doc();
    if (!d) { stopClock(); return; }
    const dur = durationOf();
    let t = baseTime + (now - startedAt) / 1000;
    if (d.anim.loop === false) {
      if (t >= dur) {
        t = dur;
        setTime(t);
        stopClock();
        updatePlayhead();
        return;
      }
    } else if (t >= dur) {
      t = t % dur;
      baseTime = t;
      startedAt = now;
    }
    const v = view();
    if (v) v.setTime(t);
    updatePlayhead();
    raf = requestAnimationFrame(clockFrame);
  }

  function dockStart() {
    const v = view();
    const d = doc();
    if (!v || !d) return;
    const dur = durationOf();
    const cur = dNum(v.time, 0);
    if (d.anim.loop === false && cur >= dur) v.setTime(0);
    playing = true;
    v.playing = true;
    baseTime = dNum(v.time, 0);
    startedAt = performance.now();
    raf = requestAnimationFrame(clockFrame);
    renderDock();
  }

  function pauseClock() {
    stopClock();
    renderDock();
  }

  function setTime(t) {
    const v = view();
    if (!v) return;
    v.setTime(t);
    updatePlayhead();
    if (opts.onTime) opts.onTime();
  }

  function togglePlay() {
    if (playing) pauseClock(); else dockStart();
  }

  function clearAnim() {
    const d = doc();
    if (!d) return;
    d.anim.tracks = [];
    selectedTrack = '';
    changed('已清空动画轨道');
  }

  function addTrack(kind) {
    const d = doc();
    if (!d) return;
    let of = null;
    if (kind === 'cam') {
      of = { kind: 'cam', id: d.scene.active };
    } else {
      const id = getSelectedId();
      if (id && S.findNode(d.scene.nodes, id)) of = { kind: 'node', id };
    }
    if (!of || !of.id) { note(kind === 'cam' ? '先切到一个机位' : '先在左栏「场景」里选一个实体', 'err'); return; }
    let tr = d.anim.tracks.find(x => x.of && x.of.kind === of.kind && x.of.id === of.id);
    if (!tr) {
      tr = makeTrack(d, of);
      d.anim.tracks.push(tr);
    }
    selectedTrack = tr.id;
    changed('已加一条' + (of.kind === 'cam' ? '机位' : '节点') + '轨道');
  }

  function changed(message) {
    const v = view();
    if (v) { v.rebuild(); v.setTime(v.time); }
    if (message) note(message, 'ok');
    onChange();
    renderDock();
  }

  function selectedTrackOf() {
    const d = doc();
    if (!d) return null;
    return d.anim.tracks.find(t => t.id === selectedTrack) || null;
  }

  function nodeOfTrack(tr) {
    const d = doc();
    return (tr && tr.of && tr.of.kind === 'node' && d) ? S.findNode(d.scene.nodes, tr.of.id) : null;
  }

  function currentPose(tr) {
    const d = doc();
    if (!tr || !tr.of) return null;
    if (tr.of.kind === 'cam') {
      const cam = S.camOf(d, tr.of.id);
      return cam ? { at: cam.pos.slice(), target: cam.target.slice(), fov: cam.fov } : null;
    }
    const node = nodeOfTrack(tr);
    if (!node) return null;
    const v = view();
    const wrap = v && v.content ? v.content.byId.get(node.id) : null;
    if (wrap) return {
      at: [Math.round(wrap.position.x * 1000) / 1000, Math.round(wrap.position.y * 1000) / 1000, Math.round(wrap.position.z * 1000) / 1000],
      rot: [Math.round(wrap.rotation.x * 180000 / Math.PI) / 1000, Math.round(wrap.rotation.y * 180000 / Math.PI) / 1000, Math.round(wrap.rotation.z * 180000 / Math.PI) / 1000],
      pose: node.pose || '',
    };
    return { at: node.at.slice(), rot: node.rot.slice(), pose: node.pose || '' };
  }

  function addKey() {
    const d = doc();
    const tr = selectedTrackOf();
    if (!d || !tr) { note('先选一条轨道', 'err'); return; }
    const pose = currentPose(tr);
    if (!pose) { note('这条轨道指向的对象已经不在了', 'err'); return; }
    const v = view();
    const t = Math.round(dNum(v && v.time, 0) * 100) / 100;
    tr.keys = (tr.keys || []).filter(k => Math.abs(k.t - t) > 0.001);
    if (tr.of.kind === 'cam') tr.keys.push({ t, at: pose.at, target: pose.target, fov: pose.fov });
    else tr.keys.push({ t, at: pose.at, rot: pose.rot, pose: pose.pose || '' });
    tr.keys.sort((a, b) => a.t - b.t);
    changed('在 ' + t.toFixed(1) + ' 秒打了一个关键帧');
  }

  function clearKeys() {
    const tr = selectedTrackOf();
    if (!tr) return;
    tr.keys = [];
    changed('已清空这条轨道的关键帧');
  }

  function deleteTrack(id) {
    const d = doc();
    if (!d) return;
    d.anim.tracks = d.anim.tracks.filter(t => t.id !== id);
    if (selectedTrack === id) selectedTrack = '';
    changed('已删除一条轨道');
  }

  function toggleEnabled(id) {
    const d = doc();
    const tr = d && d.anim.tracks.find(t => t.id === id);
    if (!tr) return;
    tr.enabled = tr.enabled === false;
    changed(tr.enabled === false ? '轨道已停用' : '轨道已启用');
  }

  function setPathKind(kind) {
    const tr = selectedTrackOf();
    if (!tr) return;
    if (kind === 'none') tr.path = null;
    else if (kind === 'line') tr.path = { kind: 'line', from: [-1.6, 0, 0], to: [1.6, 0, 0], radius: 1.5, clockwise: false };
    else if (kind === 'circle') tr.path = { kind: 'circle', from: [0, 0, 0], to: [0, 0, 1.6], radius: 1.6, clockwise: false };
    else if (kind === 'rect') tr.path = { kind: 'rect', from: [-1.4, 0, -1], to: [1.4, 0, 1], radius: 1.4, clockwise: false };
    else tr.path = { kind: 'free', pts: [[-1.4, 0, 0], [0, 0, 1], [1.4, 0, 0]], closed: false, from: [0, 0, 0], to: [0, 0, 0], radius: 1 };
    changed('路线已改为' + pathKindZh(kind));
  }

  function paintPathEditor(tr) {
    if (!tr) return '';
    const p = tr.path;
    const kind = p ? p.kind : 'none';
    let fields = '';
    if (p && p.kind === 'free') {
      fields = '<div class="mm-field"><label>自由路径点（每行 x,y,z）</label>'
        + '<textarea class="ui-inp" data-dock-field="pts" rows="3">' + dEsc((p.pts || []).map(q => q.join(',')).join('\n')) + '</textarea></div>';
    } else if (p) {
      const pathRow = (label, key) => '<div class="mm-row"><label>' + label + '</label>'
        + [0, 1, 2].map(i => '<input class="ui-inp" type="number" step="0.01" data-dock-field="' + key + '.' + i + '" value="' + (Number(p[key][i]) || 0) + '">').join('') + '</div>';
      fields = '<div class="mm-num3">' + pathRow('起点', 'from') + pathRow('终点', 'to') + '</div>';
    }
    const keys = (tr.keys || []).map((k, i) => '<span class="mm-key-chip">' + k.t.toFixed(2) + 's'
      + '<button class="ui-linkbtn" type="button" data-dock-act="delKey" data-key-index="' + i + '" title="删掉这一帧">×</button></span>').join('');
    return '<div class="mm-dock-edit">'
      + '<div class="mm-row"><label>路线</label><select class="ui-inp" data-dock-field="pathKind">'
      + [['none', '定点'], ['line', '直线'], ['circle', '圆'], ['rect', '矩形'], ['free', '自由']].map(([v, t]) =>
        '<option value="' + v + '"' + (kind === v ? ' selected' : '') + '>' + t + '</option>').join('')
      + '</select><label>插值</label><select class="ui-inp" data-dock-field="interp">'
      + [['smooth', '平滑'], ['linear', '线性'], ['hold', '保持']].map(([v, t]) =>
        '<option value="' + v + '"' + ((tr.interp || 'smooth') === v ? ' selected' : '') + '>' + t + '</option>').join('')
      + '</select></div>'
      + fields
      + '<div class="mm-row"><span class="sp"></span>'
      + '<button class="ghost mini" type="button" data-dock-act="key">' + dIcon('key', 12) + ' 在播放头打关键帧</button>'
      + '<button class="ghost mini" type="button" data-dock-act="clearKeys">清空关键帧</button></div>'
      + (keys ? '<div class="mm-keys">' + keys + '</div>' : '<div class="mm-empty">这条轨道还没有关键帧。</div>')
      + '</div>';
  }

  function renderDock() {
    if (!host) return;
    const d = doc();
    if (!d) { host.innerHTML = ''; return; }
    const anim = d.anim;
    const status = getNote();
    const tracks = anim.tracks || [];
    const selected = selectedTrackOf();
    const rows = tracks.map(tr => {
      const on = tr.id === selectedTrack;
      return '<div class="mm-track-row' + (on ? ' on' : '') + (tr.enabled === false ? ' off' : '') + '" data-track-id="' + dEsc(tr.id) + '">'
        + '<span class="mm-track-dot" style="background:#' + trackColorOf(tr.color).toString(16).padStart(6, '0') + '"></span>'
        + '<span class="mm-track-ic">' + dIcon(trackIcon(tr), 11) + '</span>'
        + '<span class="mm-track-name" title="' + dEsc(trackName(d, tr)) + '">' + dEsc(trackName(d, tr)) + '</span>'
        + '<span class="mm-track-kind">' + (tr.of && tr.of.kind === 'cam' ? '机位' : '节点') + ' · ' + pathKindZh(tr.path && tr.path.kind) + '</span>'
        + '<span class="mm-track-n">' + (tr.keys || []).length + ' 帧</span>'
        + '<button class="mm-tree-mini" type="button" data-dock-act="toggle" data-track-id="' + dEsc(tr.id) + '" title="' + (tr.enabled === false ? '启用' : '停用') + '">' + dIcon('eye', 11) + '</button>'
        + '<button class="mm-tree-mini" type="button" data-dock-act="delTrack" data-track-id="' + dEsc(tr.id) + '" title="删除轨道">' + dIcon('trash', 11) + '</button>'
        + '<span class="mm-track-bar" data-scrub="' + dEsc(tr.id) + '" title="点一下定位">'
        + (tr.keys || []).map(k => '<span class="mm-key" style="left:' + Math.max(0, Math.min(100, (k.t / Math.max(0.001, anim.duration)) * 100)) + '%" title="' + k.t + 's"></span>').join('')
        + '<span class="mm-playhead" data-dock="playhead"></span></span>'
        + '</div>';
    }).join('');
    const clipRows = [];
    S.walkNodes(d.scene.nodes, n => {
      if (n.kind !== 'asset' || !n.clip) return;
      const entry = opts.getAssets ? opts.getAssets().get(n.file) : null;
      const clip = clipOf(entry, n.clip);
      if (!clip) return;
      const speed = Math.max(0.001, dNum(n.clipSpeed, 1));
      const offset = dNum(n.clipOffset, 0);
      const dur = durationOf();
      const end = (n.clipLoop || 'loop') === 'loop' ? dur : Math.max(0, (Number(clip.duration) || 0) / speed - offset);
      clipRows.push('<div class="mm-track-row clip">'
        + '<span class="mm-track-ic">' + dIcon('speaker', 11) + '</span>'
        + '<span class="mm-track-name">' + dEsc(n.name || '摆件') + ' · ' + dEsc(n.clip) + '</span>'
        + '<span class="mm-track-bar"><span class="mm-clip-band" style="width:' + Math.max(0, Math.min(100, end / dur * 100)).toFixed(2) + '%"></span>'
        + '<span class="mm-playhead" data-dock="playhead"></span></span></div>');
    });
    host.innerHTML =
      '<div class="mm-dock-head">'
      + '<button class="tool" type="button" data-dock-act="play" title="播放 / 暂停">' + dIcon(playing ? 'pause' : 'play', 12) + '</button>'
      + '<button class="tool" type="button" data-dock-act="stop" title="回到 0 秒">' + dIcon('stop', 12) + '</button>'
      + '<button class="mm-dock-time" type="button" data-dock-act="time" title="播放头 / 总时长；点一下改总时长"><span data-dock="time">' + dockTimeText() + '</span></button>'
      + '<label class="mm-dock-lab">时长</label><input class="ui-inp mm-dock-num" type="number" min="0.001" step="0.1" data-dock-field="duration" value="' + anim.duration + '">'
      + '<label class="mm-dock-lab">fps</label><input class="ui-inp mm-dock-num" type="number" min="1" step="1" data-dock-field="fps" value="' + anim.fps + '">'
      + '<label class="mm-dock-check"><input type="checkbox" data-dock-field="loop"' + (anim.loop !== false ? ' checked' : '') + '> 循环</label>'
      + '<span class="mm-dock-note' + (status.kind === 'err' ? ' err' : status.kind === 'ok' ? ' ok' : '') + '" data-dock="say">' + dEsc(status.text || '') + '</span>'
      + '<span class="sp"></span>'
      + '<button class="ghost mini" type="button" data-dock-act="addNode">' + dIcon('plus', 12) + ' 节点轨道</button>'
      + '<button class="ghost mini" type="button" data-dock-act="addCam">' + dIcon('video', 12) + ' 机位轨道</button>'
      + '<button class="ghost mini" type="button" data-dock-act="clearAnim">清空动画</button>'
      + '</div>'
      + '<div class="mm-tracks">'
      + (rows || clipRows.length ? rows + clipRows.join('') : '<div class="mm-dock-empty">还没有动画。选一个实体加节点轨道，或给当前机位加机位轨道。</div>')
      + '</div>'
      + paintPathEditor(selected);

    host.onclick = e => {
      const act = e.target.closest('[data-dock-act]');
      if (act) {
        const a = act.dataset.dockAct;
        if (a === 'play') { togglePlay(); return; }
        if (a === 'stop') { pauseClock(); setTime(0); renderDock(); return; }
        if (a === 'time') {
          const input = host.querySelector('[data-dock-field="duration"]');
          if (input) { window.focusQuiet && window.focusQuiet(input); input.select(); }
          return;
        }
        if (a === 'addNode') { addTrack('node'); return; }
        if (a === 'addCam') { addTrack('cam'); return; }
        if (a === 'clearAnim') { clearAnim(); return; }
        if (a === 'toggle') { toggleEnabled(act.dataset.trackId); return; }
        if (a === 'delTrack') { deleteTrack(act.dataset.trackId); return; }
        if (a === 'key') { addKey(); return; }
        if (a === 'clearKeys') { clearKeys(); return; }
        if (a === 'delKey') {
          const tr = selectedTrackOf();
          const i = Number(act.dataset.keyIndex);
          if (tr && tr.keys) { tr.keys.splice(i, 1); changed('已删掉一个关键帧'); }
          return;
        }
      }
      const bar = e.target.closest('[data-scrub]');
      if (bar) {
        pauseClock();
        const r = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
        setTime(ratio * durationOf());
        renderDock();
        return;
      }
      const trackRowEl = e.target.closest('[data-track-id]');
      if (trackRowEl) { selectedTrack = trackRowEl.dataset.trackId; renderDock(); }
    };
    host.onchange = e => {
      const f = e.target.closest('[data-dock-field]');
      if (!f) return;
      const k = f.dataset.dockField;
      const d2 = doc();
      if (k === 'duration') {
        const v = dNum(f.value, 4);
        if (v > 0) {
          d2.anim.duration = v;
          const end = S.trackEndOf(d2.anim);
          if (end > v) note('动画时长 ' + v + ' 秒短于轨道末尾 ' + end + ' 秒；超出部分不会播放', 'err');
        }
      } else if (k === 'fps') {
        const v = Math.round(dNum(f.value, 24));
        if (v > 0) d2.anim.fps = v;
      } else if (k === 'loop') d2.anim.loop = !!f.checked;
      else {
        const tr = selectedTrackOf();
        if (!tr) return;
        if (k === 'interp') tr.interp = f.value;
        else if (k === 'pathKind') { setPathKind(f.value); return; }
        else if (k === 'pts') {
          const pts = String(f.value || '').split(/\n+/).map(line => line.split(',').map(x => Number(x.trim())).filter(x => Number.isFinite(x)))
            .filter(p => p.length >= 3).map(p => [p[0], p[1], p[2]]);
          if (pts.length >= 2) { tr.path = { kind: 'free', pts, closed: false, from: [0, 0, 0], to: [0, 0, 0], radius: 1 }; }
        } else if (/^from\.\d$/.test(k) || /^to\.\d$/.test(k)) {
          if (!tr.path) return;
          const [key, i] = k.split('.');
          const v = Number(f.value);
          if (Number.isFinite(v)) tr.path[key][Number(i)] = v;
        }
      }
      changed('');
    };
    updatePlayhead();
  }

  return {
    renderDock,
    play: dockStart,
    pause: pauseClock,
    destroy() {
      stopClock();
      if (host) host.innerHTML = '';
      host && host.replaceChildren();
    },
    get playing() { return playing; },
  };
}
