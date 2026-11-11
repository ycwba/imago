/* 建模台底部轨道坞 —— 播放时钟、轨道行、播放头、路径 / 关键帧编辑的唯一所有者。
   页面只把 doc / view / 选中对象递进来；这里改完轨道后调 view.rebuild()，
   再通过 onChange 让页面刷新页头与出片条。

   为什么时钟必须只有这一份：view.js 只接收 `setTime(t)`，不再自己按 dt 累加；
   两处同时推进会让播放速度、出片取帧与播放头读数互相漂移。 */

import * as S from '../../model3d/schema.js';
import * as A from '../../model3d/anim.js';
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

/* 关键帧时间 = 轨道局部秒，两位小数就够（0.01 秒 ≈ 一帧的四分之一）。
   拖动与手填时间都只经这一份：把这一帧挪到 t，同一时刻的另一帧被它顶掉
   （t 相同就是同一帧），返回排好序的新数组。key 的对象身份保持不变 ——
   调用方手里攥着的「正在编辑的那一帧」不能因为重排就断线。 */
export function retimeKey(keys, key, t) {
  const nt = Math.max(0, Math.round(dNum(t, 0) * 100) / 100);
  key.t = nt;
  const kept = (keys || []).filter(k => k === key || Math.abs(k.t - nt) > 0.001);
  kept.sort((a, b) => a.t - b.t);
  return kept;
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
  /* 逐帧编辑：selKey 是「正在编辑的那一帧」，按对象身份认（重排 / 改名都不丢）；
     drag 只在一只指针按住关键帧菱形到松手之间存在；swallowClickUntil 吃掉
     「拖完松手」那一下的 click —— 否则条带把它当成一次定位点击。 */
  let selKey = null;
  let drag = null;
  let swallowClickUntil = 0;
  let revealKeyEdit = false;
  /* 逐帧表单改完会整片重画；记住刚改的那一格，重画后把它滚回视野（最小滚动）。 */
  let revealKeyField = '';

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
    selKey = null;
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
    selKey = null;
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

  /* 选中那一帧只在这一条轨道的 keys 里才算数：换轨道 / 换场景后旧对象自然失效。 */
  function pickedKeyOf(tr) {
    if (!tr || !selKey) return null;
    return (tr.keys || []).indexOf(selKey) >= 0 ? selKey : null;
  }

  /* 一帧只剩时间就没有意义（读回时也会被丢掉）：清空最后一个字段就整帧删掉。 */
  function keyHasBody(key) {
    return ['at', 'rot', 'pose', 'target', 'fov', 'energy', 'color', 'scale', 'visible', 'ease']
      .some(f => key[f] != null && key[f] !== '');
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
    if (tr.of.kind === 'light') {
      const light = ((d && d.scene && d.scene.lights) || []).find(l => l.id === tr.of.id);
      if (!light) return null;
      const s = A.sampleTrack(tr, view() ? view().time : 0, durationOf());
      return {
        at: (s && s.at) || light.at.slice(),
        target: (s && s.target) || (Array.isArray(light.target) ? light.target.slice() : null),
        energy: s && s.energy != null ? s.energy : light.energy,
        color: (s && s.color) || light.color,
      };
    }
    const node = nodeOfTrack(tr);
    if (!node) return null;
    const v = view();
    const wrap = v && v.content ? v.content.byId.get(node.id) : null;
    if (wrap) {
      let at = [Math.round(wrap.position.x * 1000) / 1000, Math.round(wrap.position.y * 1000) / 1000, Math.round(wrap.position.z * 1000) / 1000];
      /* 轨道带 follow 时，播放（sampleAnim）会在采样值上再叠一次被跟随节点的位置；
         这里取到的是视口世界坐标（已含那一份），写进 key 前先减掉 —— 否则该帧起
         对象瞬间跳出约两倍跟随偏移。base 的取法照抄 sampleAnim 的 baseAtOf：
         先用被跟随节点自己采到的位置，没有再用它的静态 at。 */
      if (tr.follow) {
        const m = A.sampleAnim(d.anim, v ? v.time : 0, d);
        let base = (m && m[tr.follow] && m[tr.follow].at) || null;
        if (!base) {
          const fn = S.findNode(d.scene.nodes, tr.follow);
          base = fn ? fn.at : null;
        }
        if (base) at = [at[0] - base[0], at[1] - base[1], at[2] - base[2]].map(x => Math.round(x * 1000) / 1000);
      }
      return {
        at,
        rot: [Math.round(wrap.rotation.x * 180000 / Math.PI) / 1000, Math.round(wrap.rotation.y * 180000 / Math.PI) / 1000, Math.round(wrap.rotation.z * 180000 / Math.PI) / 1000],
        pose: node.pose || '',
      };
    }
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
    let key;
    if (tr.of.kind === 'cam') key = { t, at: pose.at, target: pose.target, fov: pose.fov };
    else if (tr.of.kind === 'light') key = { t, at: pose.at, energy: pose.energy, color: pose.color };
    else key = { t, at: pose.at, rot: pose.rot, pose: pose.pose || '' };
    tr.keys.push(key);
    tr.keys.sort((a, b) => a.t - b.t);
    selKey = key;
    revealKeyEdit = true;
    changed('在 ' + t.toFixed(1) + ' 秒打了一个关键帧');
  }

  function clearKeys() {
    const tr = selectedTrackOf();
    if (!tr) return;
    tr.keys = [];
    selKey = null;
    changed('已清空这条轨道的关键帧');
  }

  /* 这一帧还没写过的向量：按采样锚定当前实际值（叠加模式下关键帧是偏移，锚在零上）。
      锚定之后用户改哪一格，另外两格就是「此刻看起来的样子」，不会把对象甩回原点。 */
  function baseVecOf(tr, key, field) {
    if (tr.keysMode !== 'offset') {
      const s = A.sampleTrack(tr, key.t, durationOf());
      const src = s && s[field];
      if (Array.isArray(src)) return src.slice();
      const d = doc();
      if (d) {
        if (tr.of.kind === 'cam') {
          const cam = S.camOf(d, tr.of.id);
          if (cam && field === 'at') return cam.pos.slice();
          if (cam && field === 'target' && Array.isArray(cam.target)) return cam.target.slice();
        } else if (tr.of.kind === 'light') {
          const light = (d.scene.lights || []).find(l => l.id === tr.of.id);
          if (light && field === 'at' && Array.isArray(light.at)) return light.at.slice();
          if (light && field === 'target' && Array.isArray(light.target)) return light.target.slice();
        } else {
          const node = S.findNode(d.scene.nodes, tr.of.id);
          if (node && field === 'at' && Array.isArray(node.at)) return node.at.slice();
          if (node && field === 'rot' && Array.isArray(node.rot)) return node.rot.slice();
          if (node && field === 'scale' && Array.isArray(node.scale)) return node.scale.slice();
        }
      }
    }
    return field === 'scale' ? [1, 1, 1] : [0, 0, 0];
  }

  /* 「取当前姿态」：机位读视口此刻的采样姿态（活动机位），节点读视口里活的那一份
     世界变换 —— 手调过视口之后，把看到的这一下直接钉成关键帧。 */
  function keyFromView(tr) {
    const key = pickedKeyOf(tr);
    if (!key) return;
    const v = view();
    const d = doc();
    let pose = null;
    if (tr.of.kind === 'cam' && d && d.scene && d.scene.active === tr.of.id && v && v.cameraPose) {
      const p = v.cameraPose();
      pose = p ? { at: p.pos, target: p.target, fov: p.fov } : null;
    } else if (tr.of.kind === 'cam') {
      const cam = S.camOf(d, tr.of.id);
      const s = A.sampleTrack(tr, v ? v.time : key.t, durationOf());
      pose = (cam && s) ? {
        at: s.at || cam.pos,
        target: s.target || cam.target,
        fov: s.fov != null ? s.fov : cam.fov,
      } : null;
    } else {
      pose = currentPose(tr);
    }
    /* pose 为 null 有两种原因：非活动机位走了 sampleTrack，t < offset 时它返回 null（还没开播）；
       或者对象真的不在了。照实说全，别让人对着一条好端端的轨道找「对象」到底哪去了。 */
    if (!pose) { note('没取到当前姿态：轨道还没开播，或指向的对象已经不在了', 'err'); return; }
    if (tr.of.kind === 'cam') {
      key.at = pose.at.map(x => S.round3(x));
      key.target = pose.target.map(x => S.round3(x));
      key.fov = S.round3(pose.fov);
    } else if (tr.of.kind === 'light') {
      key.at = pose.at.map(x => S.round3(x));
      if (Array.isArray(pose.target)) key.target = pose.target.map(x => S.round3(x));
    } else {
      key.at = pose.at.map(x => S.round3(x));
      key.rot = pose.rot.map(x => S.round3(x));
      if (pose.pose) key.pose = pose.pose;
    }
    revealKeyField = 'key.at.0';
    changed('已把当前姿态写进这一帧');
  }

  const KEY_FIELD_ZH = {
    at: '位置', rot: '旋转', scale: '缩放', target: '看向',
    pose: '姿势', visible: '显隐', fov: '视场角', energy: '能量', color: '颜色', ease: '缓入',
  };

  /* 逐帧编辑表单的写入口：一个字段一条。坏值不落盘 —— 提示一句、控件回到盘上那一份。
     向量字段留空 = 这一帧不改它；改其中一格时先用 baseVecOf 把另外两格锚住。 */
  function editKeyField(tr, key, path, el) {
    const empty = String(el.value == null ? '' : el.value).trim() === '';
    const raw = Number(el.value);
    const vecMatch = /^key\.(at|rot|scale|target)\.([0-2])$/.exec(path);
    if (vecMatch) {
      if (empty) { renderDock(); return; }
      if (!Number.isFinite(raw)) { note('这里要填数字', 'err'); renderDock(); return; }
      const field = vecMatch[1];
      const i = Number(vecMatch[2]);
      const vec = Array.isArray(key[field]) ? key[field].slice() : baseVecOf(tr, key, field);
      vec[i] = field === 'scale' ? S.scaleOf(raw)[0] : S.round3(raw);
      if (field === 'scale' && raw === 0) note('0 缩放按 1 处理（0 的节点在场景里等于消失）');
      key[field] = vec;
    } else if (path === 'key.t') {
      if (empty || !Number.isFinite(raw)) { note('时间要填数字（秒）', 'err'); renderDock(); return; }
      if (raw < 0) { note('时间不能是负数', 'err'); renderDock(); return; }
      const before = tr.keys.length;
      tr.keys = retimeKey(tr.keys, key, raw);
      if (before > tr.keys.length) note('同一时刻的另一个关键帧被顶掉', 'err');
    } else if (path === 'key.fov') {
      if (empty) delete key.fov;
      else if (!(raw > 0 && raw < 180)) { note('视场角要在 0 到 180 之间', 'err'); renderDock(); return; }
      else key.fov = S.round3(raw);
    } else if (path === 'key.energy') {
      if (empty) delete key.energy;
      else if (!(raw >= 0)) { note('能量不能是负数', 'err'); renderDock(); return; }
      else key.energy = S.round3(raw);
    } else if (path === 'key.color') {
      if (empty) delete key.color;
      else {
        const c = S.cleanColor(el.value);
        if (!c) { note('颜色要写成 #rrggbb 或 #rgb', 'err'); renderDock(); return; }
        key.color = c;
      }
    } else if (path === 'key.pose') {
      const s = String(el.value || '').trim();
      if (s) key.pose = s; else delete key.pose;
    } else if (path === 'key.visible') {
      if (el.value === '1') key.visible = true;
      else if (el.value === '0') key.visible = false;
      else delete key.visible;
    } else if (path === 'key.ease') {
      if (['smooth', 'linear', 'hold'].indexOf(el.value) >= 0) key.ease = el.value;
      else delete key.ease;
    } else {
      return;
    }
    if (!keyHasBody(key)) {
      tr.keys = (tr.keys || []).filter(k => k !== key);
      selKey = null;
      changed('这一帧已经没有内容，已删掉');
      return;
    }
    revealKeyField = path;
    changed('');
  }

  function deleteTrack(id) {
    const d = doc();
    if (!d) return;
    d.anim.tracks = d.anim.tracks.filter(t => t.id !== id);
    if (selectedTrack === id) { selectedTrack = ''; selKey = null; }
    changed('已删除一条轨道');
  }

  function toggleEnabled(id) {
    const d = doc();
    const tr = d && d.anim.tracks.find(t => t.id === id);
    if (!tr) return;
    tr.enabled = tr.enabled === false;
    changed(tr.enabled === false ? '轨道已停用' : '轨道已启用');
  }

  function toggleSolo(id) {
    const d = doc();
    const tr = d && d.anim.tracks.find(t => t.id === id);
    if (!tr) return;
    tr.solo = tr.solo !== true;
    changed(tr.solo ? '只看这一条轨道' : '取消独奏');
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

  /* 逐帧编辑：选中一帧之后才出现。没写过的字段留空显示「不变」——
     这一帧不改它，采样时沿用路径 / 静态值 / 前后帧。 */
  function keyVecRow(key, field, label) {
    const v = Array.isArray(key[field]) ? key[field] : null;
    return '<div class="mm-row"><label>' + label + '</label>'
      + [0, 1, 2].map(i =>
        '<input class="ui-inp" type="number" step="0.01" data-dock-field="key.' + field + '.' + i + '"'
        + ' value="' + (v ? (Number(v[i]) || 0) : '') + '" placeholder="不变">').join('')
      + '<button class="ui-linkbtn mm-key-clear' + (v ? '' : ' is-hidden') + '" type="button" data-dock-act="clrKeyField" data-key-field="' + field + '" title="这一帧不再改' + KEY_FIELD_ZH[field] + '">×</button></div>';
  }

  function paintKeyEditor(tr) {
    const key = pickedKeyOf(tr);
    if (!key) return '';
    const kind = tr.of && tr.of.kind;
    const numRow = (field, label, val, step) => '<div class="mm-row"><label>' + label + '</label>'
      + '<input class="ui-inp" type="number" step="' + (step || '0.01') + '" data-dock-field="key.' + field + '"'
      + ' value="' + (val == null ? '' : val) + '" placeholder="不变"></div>';
    let fields = '';
    if (kind === 'cam') {
      fields = keyVecRow(key, 'at', '位置') + keyVecRow(key, 'target', '看向') + numRow('fov', '视场角', key.fov, '1');
    } else if (kind === 'light') {
      fields = keyVecRow(key, 'at', '位置') + keyVecRow(key, 'target', '看向')
        + numRow('energy', '能量', key.energy)
        + '<div class="mm-row"><label>颜色</label><input class="ui-inp" data-dock-field="key.color" value="' + dEsc(key.color || '') + '" placeholder="不变"></div>';
    } else {
      fields = keyVecRow(key, 'at', '位置') + keyVecRow(key, 'rot', '旋转') + keyVecRow(key, 'scale', '缩放')
        + '<div class="mm-row"><label>姿势</label><input class="ui-inp" data-dock-field="key.pose" value="' + dEsc(key.pose || '') + '" placeholder="不变"></div>'
        + '<div class="mm-row"><label>显隐</label><select class="ui-inp" data-dock-field="key.visible">'
        + '<option value=""' + (key.visible == null ? ' selected' : '') + '>不变</option>'
        + '<option value="1"' + (key.visible === true ? ' selected' : '') + '>显示</option>'
        + '<option value="0"' + (key.visible === false ? ' selected' : '') + '>隐藏</option></select></div>';
    }
    return '<div class="mm-keyedit">'
      + '<div class="mm-row mm-keyedit-head"><label>这一帧</label>'
      + '<input class="ui-inp" type="number" min="0" step="0.01" data-dock-field="key.t" value="' + key.t.toFixed(2) + '">'
      + '<button class="ghost mini" type="button" data-dock-act="keyFromView">取当前姿态</button>'
      + '<button class="ghost mini" type="button" data-dock-act="delKeySel">删掉这一帧</button></div>'
      + fields
      + '<div class="mm-row"><label>缓入</label><select class="ui-inp" data-dock-field="key.ease">'
      + '<option value=""' + (key.ease ? '' : ' selected') + '>跟轨道</option>'
      + [['smooth', '平滑'], ['linear', '线性'], ['hold', '保持']].map(([v, t]) =>
        '<option value="' + v + '"' + (key.ease === v ? ' selected' : '') + '>' + t + '</option>').join('')
      + '</select><span class="mm-keyedit-tip">从前一帧走到这一帧</span></div>'
      + '</div>';
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
    const sel = pickedKeyOf(tr);
    const keys = (tr.keys || []).map((k, i) => '<span class="mm-key-chip' + (k === sel ? ' on' : '') + '">'
      + '<button class="ui-linkbtn" type="button" data-dock-act="selKey" data-key-index="' + i + '" title="编辑这一帧">' + k.t.toFixed(2) + 's</button>'
      + '<button class="ui-linkbtn" type="button" data-dock-act="delKey" data-key-index="' + i + '" title="删掉这一帧">×</button></span>').join('');
    const numIn = (field, val, step) => '<input class="ui-inp" type="number" step="' + (step || '0.01') + '" data-dock-field="' + field + '" value="' + (Number(val) || 0) + '">';
    const look = p && p.look ? p.look : 'fixed';
    const lookRow = (tr.of && tr.of.kind === 'cam' && p)
      ? '<label>朝向</label><select class="ui-inp" data-dock-field="look">'
        + [['fixed', '保持'], ['heading', '沿切线'], ['target', '看节点']].map(([v, t]) =>
          '<option value="' + v + '"' + (look === v ? ' selected' : '') + '>' + t + '</option>').join('')
        + '</select>'
        + (look === 'target' ? '<input class="ui-inp" data-dock-field="lookAt" value="' + dEsc(p.lookAt || '') + '" placeholder="节点 id">' : '')
      : '';
    return '<div class="mm-dock-edit">'
      + '<div class="mm-row"><label>路线</label><select class="ui-inp" data-dock-field="pathKind">'
      + [['none', '定点'], ['line', '直线'], ['circle', '圆'], ['rect', '矩形'], ['free', '自由']].map(([v, t]) =>
        '<option value="' + v + '"' + (kind === v ? ' selected' : '') + '>' + t + '</option>').join('')
      + '</select><label>插值</label><select class="ui-inp" data-dock-field="interp">'
      + [['smooth', '平滑'], ['linear', '线性'], ['hold', '保持']].map(([v, t]) =>
        '<option value="' + v + '"' + ((tr.interp || 'smooth') === v ? ' selected' : '') + '>' + t + '</option>').join('')
      + '</select></div>'
      + '<div class="mm-row"><label>偏移</label>' + numIn('offset', tr.offset || 0)
      + '<label>倍速</label>' + numIn('speed', tr.speed || 1)
      + '<label>时长</label>' + numIn('trackDuration', tr.duration || 0) + '</div>'
      + '<div class="mm-row"><label>关键帧</label><select class="ui-inp" data-dock-field="keysMode">'
      + [['override', '接管'], ['offset', '叠加路径']].map(([v, t]) =>
        '<option value="' + v + '"' + ((tr.keysMode || 'override') === v ? ' selected' : '') + '>' + t + '</option>').join('')
      + '</select>' + lookRow
      + '<label>独奏</label><select class="ui-inp" data-dock-field="solo">'
      + '<option value="0"' + (tr.solo ? '' : ' selected') + '>关</option>'
      + '<option value="1"' + (tr.solo ? ' selected' : '') + '>开</option></select></div>'
      + fields
      + '<div class="mm-row"><span class="sp"></span>'
      + '<button class="ghost mini" type="button" data-dock-act="key">' + dIcon('key', 12) + ' 在播放头打关键帧</button>'
      + '<button class="ghost mini" type="button" data-dock-act="clearKeys">清空关键帧</button></div>'
      + (keys ? '<div class="mm-keys">' + keys + '</div>' : '<div class="mm-empty">这条轨道还没有关键帧。</div>')
      + paintKeyEditor(tr)
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
    const selKeyNow = pickedKeyOf(selected);
    const rows = tracks.map(tr => {
      const on = tr.id === selectedTrack;
      return '<div class="mm-track-row' + (on ? ' on' : '') + (tr.enabled === false ? ' off' : '') + (tr.solo ? ' solo' : '') + '" data-track-id="' + dEsc(tr.id) + '">'
        + '<span class="mm-track-dot" style="background:#' + trackColorOf(tr.color).toString(16).padStart(6, '0') + '"></span>'
        + '<span class="mm-track-ic">' + dIcon(trackIcon(tr), 11) + '</span>'
        + '<span class="mm-track-name" title="' + dEsc(trackName(d, tr)) + '">' + dEsc(trackName(d, tr)) + '</span>'
        + '<span class="mm-track-kind">' + (tr.of && tr.of.kind === 'cam' ? '机位' : (tr.of && tr.of.kind === 'light' ? '灯光' : '节点')) + ' · ' + pathKindZh(tr.path && tr.path.kind)
        + (tr.offset ? ' · 偏移 ' + tr.offset + 's' : '')
        + (tr.speed && tr.speed !== 1 ? ' · ' + tr.speed + '×' : '')
        + (tr.keysMode === 'offset' ? ' · 叠加' : '')
        + (tr.follow ? ' · 跟随' : '')
        + '</span>'
        + '<span class="mm-track-n">' + (tr.keys || []).length + ' 帧</span>'
        + '<button class="mm-tree-mini' + (tr.solo ? ' on' : '') + '" type="button" data-dock-act="solo" data-track-id="' + dEsc(tr.id) + '" title="' + (tr.solo ? '取消独奏' : '只看这一条轨道') + '">' + dIcon('star', 11) + '</button>'
        + '<button class="mm-tree-mini" type="button" data-dock-act="toggle" data-track-id="' + dEsc(tr.id) + '" title="' + (tr.enabled === false ? '启用' : '停用') + '">' + dIcon('eye', 11) + '</button>'
        + '<button class="mm-tree-mini" type="button" data-dock-act="delTrack" data-track-id="' + dEsc(tr.id) + '" title="删除轨道">' + dIcon('trash', 11) + '</button>'
        + '<span class="mm-track-bar" data-scrub="' + dEsc(tr.id) + '" title="点一下定位">'
        + (tr.keys || []).map((k, i) => '<span class="mm-key' + (k === selKeyNow ? ' on' : '') + '" data-dock-key="' + i + '" style="left:' + Math.max(0, Math.min(100, (k.t / Math.max(0.001, anim.duration)) * 100)) + '%" title="' + k.t.toFixed(2) + 's · 拖动改时间"></span>').join('')
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
      if (performance.now() < swallowClickUntil) { swallowClickUntil = 0; return; }
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
        if (a === 'solo') { toggleSolo(act.dataset.trackId); return; }
        if (a === 'delTrack') { deleteTrack(act.dataset.trackId); return; }
        if (a === 'key') { addKey(); return; }
        if (a === 'clearKeys') { clearKeys(); return; }
        if (a === 'selKey') {
          const tr = selectedTrackOf();
          const key = tr && tr.keys && tr.keys[Number(act.dataset.keyIndex)];
          if (key) {
            stopClock();
            selKey = key;
            revealKeyEdit = true;
            setTime(key.t);
            renderDock();
          }
          return;
        }
        if (a === 'keyFromView') { keyFromView(selectedTrackOf()); return; }
        if (a === 'delKeySel') {
          const tr = selectedTrackOf();
          const key = pickedKeyOf(tr);
          if (tr && key) {
            tr.keys.splice(tr.keys.indexOf(key), 1);
            selKey = null;
            changed('已删掉这一帧');
          }
          return;
        }
        if (a === 'clrKeyField') {
          const tr = selectedTrackOf();
          const key = pickedKeyOf(tr);
          const field = act.dataset.keyField;
          if (tr && key && field) {
            delete key[field];
            if (!keyHasBody(key)) {
              tr.keys = tr.keys.filter(k => k !== key);
              selKey = null;
              changed('这一帧已经没有内容，已删掉');
            } else {
              revealKeyField = 'key.' + field + '.0';
              changed('这一帧不再改' + (KEY_FIELD_ZH[field] || field));
            }
          }
          return;
        }
        if (a === 'delKey') {
          const tr = selectedTrackOf();
          const i = Number(act.dataset.keyIndex);
          if (tr && tr.keys && tr.keys[i]) {
            if (tr.keys[i] === selKey) selKey = null;
            tr.keys.splice(i, 1);
            changed('已删掉一个关键帧');
          }
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
      if (trackRowEl) {
        if (selectedTrack !== trackRowEl.dataset.trackId) selKey = null;
        selectedTrack = trackRowEl.dataset.trackId;
        revealKeyEdit = false;
        renderDock();
      }
    };
    host.onchange = e => {
      const f = e.target.closest('[data-dock-field]');
      if (!f) return;
      const k = f.dataset.dockField;
      if (k.indexOf('key.') === 0) {
        const tr = selectedTrackOf();
        const key = pickedKeyOf(tr);
        if (tr && key) editKeyField(tr, key, k, f);
        return;
      }
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
        else if (k === 'offset') tr.offset = Math.max(0, dNum(f.value, 0));
        else if (k === 'speed') { const v = dNum(f.value, 1); tr.speed = v > 0 ? v : 1; }
        else if (k === 'trackDuration') tr.duration = Math.max(0, dNum(f.value, 0));
        else if (k === 'keysMode') tr.keysMode = f.value === 'offset' ? 'offset' : 'override';
        else if (k === 'solo') tr.solo = f.value === '1';
        else if (k === 'look') {
          if (!tr.path) return;
          if (f.value === 'fixed') { delete tr.path.look; delete tr.path.lookAt; }
          else tr.path.look = f.value;
        } else if (k === 'lookAt') {
          if (!tr.path) return;
          tr.path.lookAt = String(f.value || '').trim();
        } else if (k === 'pathKind') { setPathKind(f.value); return; }
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
    if (revealKeyField) {
      const one = host.querySelector('[data-dock-field="' + revealKeyField + '"]');
      revealKeyField = '';
      if (one) one.scrollIntoView({ block: 'nearest' });
    } else if (revealKeyEdit) {
      revealKeyEdit = false;
      const edit = host.querySelector('.mm-dock-edit');
      if (edit) edit.scrollTop = edit.scrollHeight;
    }
  }

  /* ---------- 关键帧拖动改时间 ---------- */

  /* 重画之后按「轨道 + 序号」把那一枚菱形找回来：拖动期间只挪 key.t、
     到松手才重排，所以序号在这一段里是稳定的。 */
  function dragDot() {
    if (!drag || !host) return null;
    const i = (drag.tr.keys || []).indexOf(drag.key);
    if (i < 0) return null;
    for (const row of host.querySelectorAll('.mm-track-row[data-track-id]')) {
      if (row.dataset.trackId === drag.tr.id) return row.querySelector('.mm-key[data-dock-key="' + i + '"]');
    }
    return null;
  }

  function dragTo(x) {
    const d = durationOf();
    const ratio = Math.max(0, Math.min(1, (x - drag.rect.left) / Math.max(1, drag.rect.width)));
    const t = Math.round(ratio * d * 100) / 100;
    drag.key.t = t;
    const dot = dragDot();
    if (dot) {
      dot.style.left = (t / d) * 100 + '%';
      dot.title = t.toFixed(2) + 's · 拖动改时间';
      dot.classList.add('dragging');
    }
    const tin = host.querySelector('[data-dock-field="key.t"]');
    if (tin) tin.value = t.toFixed(2);
  }

  function releaseCapture(pid) {
    try { host.releasePointerCapture(pid); } catch (e) { /* 指针已经不在 */ }
  }

  function dragPointerDown(e) {
    if (drag) return;                           // 第二根指针不接管正在拖的那一枚（触屏双指）
    if (e.button !== 0 || !e.target.closest) return;
    const dot = e.target.closest('.mm-key[data-dock-key]');
    if (!dot) return;
    const row = dot.closest('[data-track-id]');
    const bar = dot.parentElement;
    const d = doc();
    const tr = d && row ? d.anim.tracks.find(t => t.id === row.dataset.trackId) : null;
    const key = tr && tr.keys && tr.keys[Number(dot.dataset.dockKey)];
    if (!tr || !key || !bar) return;
    e.preventDefault();
    stopClock();
    selectedTrack = tr.id;
    selKey = key;
    revealKeyEdit = true;
    drag = { tr, key, rect: bar.getBoundingClientRect(), x0: e.clientX, t0: key.t, moved: false, pid: e.pointerId };
    try { host.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败也照常拖，window 上还有监听 */ }
    renderDock();
  }

  function dragPointerMove(e) {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 3) return;
    drag.moved = true;
    dragTo(e.clientX);
  }

  function dragPointerUp() {
    if (!drag) return;
    const cur = drag;
    drag = null;
    releaseCapture(cur.pid);
    /* 只在真拖过之后才吞 click：单纯点一下菱形（选中 / 定位）不该连坐下一次点击。 */
    if (cur.moved) swallowClickUntil = performance.now() + 400;
    selKey = cur.key;
    revealKeyEdit = true;
    if (!cur.moved) {
      setTime(cur.key.t);
      renderDock();
      return;
    }
    const before = cur.tr.keys.length;
    cur.tr.keys = retimeKey(cur.tr.keys, cur.key, cur.key.t);
    setTime(cur.key.t);
    changed(before > cur.tr.keys.length
      ? '关键帧已移到 ' + cur.key.t.toFixed(2) + ' 秒；同一时刻的另一帧被顶掉'
      : '关键帧已移到 ' + cur.key.t.toFixed(2) + ' 秒');
  }

  function dragPointerCancel() {
    if (!drag) return;
    const cur = drag;
    drag = null;
    releaseCapture(cur.pid);
    cur.key.t = cur.t0;
    swallowClickUntil = performance.now() + 400;
    renderDock();
  }

  if (host) {
    host.addEventListener('pointerdown', dragPointerDown);
    window.addEventListener('pointermove', dragPointerMove);
    window.addEventListener('pointerup', dragPointerUp);
    window.addEventListener('pointercancel', dragPointerCancel);
  }

  /* 外部点名一条轨道（比如按标注生成运镜之后把新轨送到眼前）：选中 + 行滚进视野。
     轨道不存在时是空操作；这正是轨道行点选那一套（清关键帧选中、重画）。 */
  function focusTrack(id) {
    const d = doc();
    if (!d || !id || !(d.anim.tracks || []).some(t => t.id === id)) return;
    if (selectedTrack !== id) selKey = null;
    selectedTrack = id;
    revealKeyEdit = false;
    renderDock();
    const row = host ? host.querySelector('[data-track-id="' + id + '"]') : null;
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  return {
    renderDock,
    focusTrack,
    play: dockStart,
    pause: pauseClock,
    destroy() {
      stopClock();
      drag = null;
      if (host) {
        host.removeEventListener('pointerdown', dragPointerDown);
        host.innerHTML = '';
        host.replaceChildren();
      }
      window.removeEventListener('pointermove', dragPointerMove);
      window.removeEventListener('pointerup', dragPointerUp);
      window.removeEventListener('pointercancel', dragPointerCancel);
    },
    get playing() { return playing; },
  };
}
