/* 三维视口 —— 唯一一处碰 WebGL / 相机 / 控制器 / 画幅 / 截图的地方。
   场景内容归 scene.js，这一层只管「怎么看、怎么拍」：

   · 两套相机：导演视角（自由 orbit）与机位视角（`doc.scene.camera`）；
   · 画幅 letterbox：屏幕上看到的那块矩形与导出时的尺寸**同源**（frameRect 一份算法）；
   · 截图与逐帧出片：走离屏 RenderTarget 读回像素，不改画布尺寸 —— 出片时界面不会跳一下；
   · 脏标记循环：不播放、没拖动、没改模型时一帧都不画（建模台要长时间开着，不能空转烧电）。

   出片所需的 `preserveDrawingBuffer` 在这里打开：离屏渲染完立刻读回，但有些驱动在
   `await` 之后会清缓冲，留着它最省事（代价是一次多余的拷贝，2 MB 的画布上可以忽略）。 */

import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { TransformControls } from '../vendor/three/TransformControls.js';
import { createStage, setPanorama, buildContent, disposeContent, boundsOf, updateCameraRig } from './scene.js';
import { sampleAnim } from './anim.js';
import { findNode } from './schema.js';
import { jointsOf, applyJoints } from './rig.js';
import { applyClip } from './clip.js';
import { SKY, SELECT } from './palette.js';

const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };
const D2R = Math.PI / 180;

/* 画幅矩形：在 canvas 的 CSS 尺寸里取「最大的、与目标画幅一致的那块」，居中。
   屏幕上的 letterbox 与 `grab(w,h)` 的比例都从这里来 —— 两处各算一次就会「看到的」≠「导出的」。 */
export function frameRect(aspect, cssW, cssH) {
  const ar = ASPECTS[aspect] || ASPECTS['16:9'];
  let w = cssW, h = Math.round(cssW / ar);
  if (h > cssH) { h = cssH; w = Math.round(cssH * ar); }
  return { x: Math.round((cssW - w) / 2), y: Math.round((cssH - h) / 2), w: Math.max(2, w), h: Math.max(2, h) };
}
export function sizeOfAspect(aspect, shortEdge) {
  const ar = ASPECTS[aspect] || ASPECTS['16:9'];
  const se = Math.max(240, Math.min(1440, Math.round(shortEdge) || 720));
  return ar >= 1 ? { w: Math.round(se * ar), h: se } : { w: se, h: Math.round(se / ar) };
}

export function createView(host, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.className = 'mm-canvas';
  host.appendChild(renderer.domElement);

  const stage = createStage();
  const camD = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 400);
  camD.position.set(3.4, 2.2, 4.6);
  /* 机位那台由 stage 一起建（它还要被视锥标识引用，见 scene.js 的 updateCameraRig） */
  const camC = stage.camC;
  const orbit = new OrbitControls(camD, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.target.set(0, 0.95, 0);
  orbit.maxPolarAngle = Math.PI * 0.495;      // 不许钻到地台下面
  orbit.minDistance = 0.4;
  orbit.maxDistance = 60;

  const gizmo = new TransformControls(camD, renderer.domElement);
  gizmo.setSize(0.85);
  gizmo.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; });
  stage.scene.add(gizmo.getHelper());

  const helper = new THREE.BoxHelper(new THREE.Object3D(), SELECT);
  helper.visible = false;
  helper.material.depthTest = false;
  helper.material.transparent = true;
  helper.renderOrder = 999;
  stage.scene.add(helper);

  let doc = null;
  let content = null;
  let mode = 'director';
  let gizmoMode = 'translate';
  let aspect = '16:9';
  let selectedId = '';
  let rigOn = true;                    // 相机标识开关（页面偏好，不进模型文件）
  let dirty = true;
  let playing = false;
  let playT = 0;
  let raf = 0;
  let disposed = false;
  let active = () => true;             // 页面可见性（外层塞 __spaActivity 判据进来）
  let onPick = null;
  let onTransform = null;
  let onCameraChange = null;
  let onNotes = null;
  let lastNotesKey = '';
  let lastPoseKey = '';
  let lastPlayAt = 0;               // 播放按墙钟计时（见 tick 里的注释）
  const rt = new Map();                // `${w}x${h}` -> WebGLRenderTarget

  /* 置脏必须连着排一帧：只把 dirty 立起来、不踢 kick 的话，rAF 循环不会醒
     （导入摆件 / 换画幅 / 选中之后画布停在旧帧，直到用户碰一下视口才动 —— 那是「改了不见」）。
     kick 自带三重闸（已在排 / 已卸 / 不可见），这里多调只是空返，不会把「闲时零帧」变成空转。 */
  function markDirty() { dirty = true; kick(); }

  function canvasSize() {
    const el = renderer.domElement;
    return { w: Math.max(2, el.clientWidth || 1), h: Math.max(2, el.clientHeight || 1) };
  }

  function resize() {
    const { w, h } = canvasSize();
    renderer.setSize(w, h, false);
    markDirty();                     // 置脏自带排帧，不用再单独踢一次
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(host);

  /* ---------------- 内容 ---------------- */
  /* 相机标识的可见性 = 用户开关 && 当前在导演视角。
     机位视角里永远不画（那套线正好糊在画面中央）；出图 / 出片另在 grab 里强制摘掉。 */
  function syncRig() {
    stage.rig.visible = rigOn && mode === 'director';
  }

  function applyCamera() {
    if (!doc) return;
    const c = doc.scene.camera;
    camC.position.set(c.pos[0], c.pos[1], c.pos[2]);
    camC.fov = c.fov;
    camC.lookAt(new THREE.Vector3(c.target[0], c.target[1], c.target[2]));
    camC.updateProjectionMatrix();
    updateCameraRig(stage, camC, ASPECTS[aspect] || 16 / 9);
    if (mode === 'director') {
      /* 导演视角不动：用户自己转。只有从「机位视角」切回来时才把 orbit 的目标收回来。 */
    }
    markDirty();
  }

  function rebuild() {
    if (!doc) return;
    if (content) { disposeContent(content); stage.scene.remove(content.group); }
    content = buildContent(doc, {
      assets: opts.assets ? opts.assets() : null,
      outline: doc.scene.view.outline,
      poseOf: id => poseOverrides.get(id) || null,
      time: playT,
    });
    stage.scene.add(content.group);
    /* 建场景时记下的话要在界面说一次：摆件超上限、文件里没这条动画、三角形超预算……
       同一份 doc 只报一次（播放中姿势变化也会重建，重复刷会把状态行一直压在警示上）。 */
    const notesKey = content.notes.join('\n');
    if (notesKey && notesKey !== lastNotesKey && onNotes) onNotes(content.notes.slice());
    lastNotesKey = notesKey;
    stage.ground.visible = doc.scene.view.ground;
    stage.floor.visible = doc.scene.view.ground;
    stage.grid.visible = doc.scene.view.grid;
    applyCamera();
    setSelection(selectedId);
    const box = boundsOf(content);
    const span = Math.max(1, box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    /* 阴影相机按内容收紧：白膜的自阴影条纹主要来自阴影贴图铺得太开 */
    const sc = stage.key.shadow.camera;
    const half = Math.max(2.5, span * 0.85);
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = 0.5; sc.far = 60;
    sc.updateProjectionMatrix();
    markDirty();
  }

  function setDoc(next, o = {}) {
    const first = !doc;
    doc = next;
    poseOverrides.clear();
    lastPoseKey = '';
    lastNotesKey = '';
    playT = 0;
    if (o.aspect) aspect = o.aspect; else if (doc) aspect = doc.scene.view.aspect;
    mode = doc ? doc.scene.view.mode : mode;
    rebuild();
    syncRig();                                   // 机位视角里不画视锥标识
    if (first || o.refit) fit();
    if (doc) setPanorama(stage, doc.scene.panorama).then(r => {
      if (r && r.ok === false && o.onPanoFail) o.onPanoFail(r.why);
      markDirty();
    });
    return content;
  }

  /* 取景：把内容装进画面（新建模型 / 加载模型时各一次，之后由用户自己转） */
  function fit() {
    const box = boundsOf(content);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(0.8, size.length() * 0.62);
    const dist = radius / Math.tan((camD.fov * D2R) / 2) * 1.15;
    const dir = new THREE.Vector3(0.62, 0.42, 1).normalize();
    camD.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    orbit.target.copy(center);
    orbit.update();
    markDirty();
  }

  /* 取景预设：近景（对上半身）/ 中景（整体装进画面）/ 全景（再退一档）。
     与 fit() 同一套包围盒，只是「看哪里」与「退多远」不同 —— 用户按一颗键
     就能在三种常用景别之间跳，不用自己拖到合适为止。 */
  function frameTo(kind) {
    if (!content) return;
    const box = boundsOf(content);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(0.6, size.length() * 0.5);
    const k = kind === 'near' ? 0.5 : kind === 'wide' ? 2.1 : 1.15;
    const dist = (radius * k) / Math.tan((camD.fov * D2R) / 2);
    const aim = kind === 'near'
      ? center.clone().setY(box.min.y + size.y * 0.72)   // 近景看胸以上，不切头
      : center.clone();
    const dir = new THREE.Vector3(0.62, 0.42, 1).normalize();
    camD.position.copy(aim.clone().add(dir.multiplyScalar(dist)));
    orbit.target.copy(aim);
    orbit.update();
    markDirty();
  }

  function setSelection(id) {
    selectedId = id || '';
    const wrap = selectedId && content ? content.byId.get(selectedId) : null;
    /* 锁定的实体只画选中框、不挂手柄：手柄一挂上，拖一下就把锁定的东西挪了 */
    const node = (doc && selectedId) ? findNode(doc.scene.nodes, selectedId) : null;
    const locked = !!(node && node.locked);
    if (!wrap) {
      helper.visible = false;
      if (gizmo.object) gizmo.detach();
    } else {
      helper.setFromObject(wrap);
      helper.visible = true;
      if (gizmoMode !== 'none' && mode === 'director' && !locked) gizmo.attach(wrap);
      else if (gizmo.object) gizmo.detach();
    }
    markDirty();
  }

  function setGizmoMode(m) {
    gizmoMode = m || 'none';
    if (gizmoMode === 'none') { if (gizmo.object) gizmo.detach(); }
    else if (selectedId) setSelection(selectedId);
    markDirty();
  }

  function setViewMode(m) {
    mode = m === 'camera' ? 'camera' : 'director';
    orbit.enabled = mode === 'director';
    syncRig();
    setSelection(selectedId);
    markDirty();
  }

  function setAspect(a) {
    aspect = ASPECTS[a] ? a : '16:9';
    updateCameraRig(stage, camC, ASPECTS[aspect] || 16 / 9);   // 画幅变了，锥体开口跟着变
    markDirty();
  }

  /* ---------------- 逐帧：动画位姿 ----------------
     位姿（姿势 / 步态）不进 doc：它每一帧都变，写回 doc 会让「保存」与「撤销」被播放污染。
     这里另存一张覆盖表，重建时由 scene.js 按 id 覆盖 —— doc 始终是用户在编辑的那一份。

     三条通道共用一个 playT：节点位姿（位置 / 朝向）→ 子关节（rig.applyPose）→
     导入件 clip（mixer.setTime）。顺序不能反：mixer 写完骨头之后必须刷一次世界矩阵，
     否则这一帧画出来的是上一帧的骨骼。 */
  const poseOverrides = new Map();
  function applyTime(t) {
    if (!doc || !content) return;
    /* 出片时也是这条：把「现在算到第几秒」写回 playT，rebuild 才能按这一帧算步态 */
    playT = Math.max(0, Number(t) || 0);
    const samples = sampleAnim(doc.anim, playT);
    const ids = Object.keys(samples);
    let needPose = false;
    const keyParts = [];
    for (const id of ids) {
      const s = samples[id];
      if (s.pose || s.motion) {
        const node = findNode(doc.scene.nodes, id);
        if (node && (node.kind === 'mannequin' || node.kind === 'crowd')) {
          needPose = true;
          poseOverrides.set(id, { pose: s.pose || node.pose, motion: s.motion || '' });
        }
      }
      keyParts.push(id + ':' + (s.pose || '') + ':' + (s.motion || ''));
    }
    const key = keyParts.join('|');
    const poseChanged = key !== lastPoseKey;
    lastPoseKey = key;
    if (needPose && poseChanged) {
      /* 姿势 / 步态变了 —— 重建（白膜的动；一帧三十来个零件，24fps 下够用） */
      const keep = selectedId;
      rebuild();
      setSelection(keep);
    }
    for (const id of ids) {
      const s = samples[id];
      const wrap = content.byId.get(id);
      if (wrap) {
        if (s.at) wrap.position.set(s.at[0], s.at[1], s.at[2]);
        if (s.rot) wrap.rotation.set(s.rot[0] * D2R, s.rot[1] * D2R, s.rot[2] * D2R);
      }
      if (s.joints && s.joints.length) {
        const joints = jointsOf(content, id);
        if (joints) applyJoints(joints, s.joints);
      }
    }
    /* 导入件的 clip 全部按同一条 playT 现算；`once` 播完按 local >= duration 判，
       不靠 finished 事件（出片不跑事件循环）。 */
    const ended = [];
    for (const [id, rec] of content.mixers) {
      const node = findNode(doc.scene.nodes, id);
      if (!node) continue;
      const r = applyClip(rec, node, playT);
      if (!r) continue;
      if (r.ended && rec.clip) {
        if (!rec.wasEnded) ended.push({ id, name: rec.clip.name || '', duration: r.duration });
        rec.wasEnded = true;
      } else {
        rec.wasEnded = false;
      }
    }
    content.clipsEnded = ended;
    if (content.group) content.group.updateMatrixWorld(true);
    if (helper.visible && selectedId && content) {
      const sel = content.byId.get(selectedId);
      if (sel) helper.setFromObject(sel);
    }
    markDirty();
  }

  /* ---------------- 渲染 ---------------- */
  function activeCamera() {
    return mode === 'camera' ? camC : camD;
  }
  function paint() {
    const { w, h } = canvasSize();
    const fr = frameRect(aspect, w, h);
    const cam = activeCamera();
    cam.aspect = fr.w / fr.h;
    cam.updateProjectionMatrix();
    /* 画幅外那一圈压暗：让「这一块才是会被导出的画面」一眼可见 */
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.setClearColor(SKY, 1);
    renderer.clear();
    renderer.setScissorTest(true);
    const y = h - fr.y - fr.h;                     // GL 的 y 从下往上
    renderer.setScissor(fr.x, y, fr.w, fr.h);
    renderer.setViewport(fr.x, y, fr.w, fr.h);
    renderer.render(stage.scene, cam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
  }

  /* 循环只在「有事发生」时活着：播放中、阻尼还没停、有脏标记。页面不可见时直接不排下一帧
     （建模台会长时间开着，空转 rAF 是在烧电）。事件负责把链子重新踢起来（kick）。 */
  function tick() {
    raf = 0;
    if (disposed || !active()) return;
    let more = false;
    if (playing) {
      /* 按墙钟走，不按帧走：屏幕 60Hz、动画 24fps 时「每帧 +1/24」会把播放放快 2.5 倍
         （出片不受影响 —— 那条路按帧计划逐秒取）。 */
      const now = performance.now();
      const dt = lastPlayAt ? Math.min(0.25, (now - lastPlayAt) / 1000) : 0;
      lastPlayAt = now;
      const anim = doc && doc.anim;
      const dur = anim ? Math.max(0.1, anim.duration) : 1;
      playT = (playT + dt) % dur;
      applyTime(playT);
      dirty = true;
      more = true;
    } else {
      lastPlayAt = 0;
    }
    if (dirty) {
      dirty = false;
      paint();
      if (onCameraChange && mode === 'director') {
        onCameraChange({
          pos: camD.position.toArray().map(n => Math.round(n * 100) / 100),
          target: orbit.target.toArray().map(n => Math.round(n * 100) / 100),
        });
      }
    }
    if (orbit.enableDamping && mode === 'director' && orbit.update()) more = true;
    if (more) kick();
  }
  function kick() {
    if (raf || disposed || !active()) return;
    raf = requestAnimationFrame(tick);
  }
  orbit.addEventListener('change', () => { markDirty(); kick(); });
  gizmo.addEventListener('change', () => { markDirty(); kick(); });
  orbit.addEventListener('start', () => kick());
  kick();

  /* ---------------- 拾取 ---------------- */
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4 || !content) return;            // 拖动视角不算点选
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, activeCamera());
    const hits = ray.intersectObjects([content.group], true);
    for (const h of hits) {
      let o = h.object;
      if (o.isLineSegments) continue;             // 描边不参与拾取
      while (o && !o.userData.nodeId) o = o.parent;
      if (!o || !o.userData.nodeId) continue;
      /* 锁定的实体点不中（它自己也隐藏时更要点不中）——「锁住」在视口里就该是碰不到的 */
      const n = doc ? findNode(doc.scene.nodes, o.userData.nodeId) : null;
      if (n && n.locked) continue;
      if (onPick) onPick(o.userData.nodeId);
      return;
    }
    if (onPick) onPick('');
  });

  gizmo.addEventListener('objectChange', () => {
    const obj = gizmo.object;
    if (!obj || !onTransform) return;
    const id = obj.userData.nodeId;
    if (!id) return;
    onTransform(id, {
      at: [round(obj.position.x), round(obj.position.y), round(obj.position.z)],
      rot: [round(obj.rotation.x / D2R), round(obj.rotation.y / D2R), round(obj.rotation.z / D2R)],
      scale: [round(obj.scale.x), round(obj.scale.y), round(obj.scale.z)],
    });
    if (helper.visible) helper.setFromObject(obj);
    markDirty();
  });
  const round = v => Math.round(v * 1000) / 1000;

  /* ---------------- 出图 / 出片 ---------------- */
  function targetFor(w, h) {
    const key = w + 'x' + h;
    let t = rt.get(key);
    if (!t) {
      t = new THREE.WebGLRenderTarget(w, h, { samples: 4, colorSpace: THREE.SRGBColorSpace });
      rt.set(key, t);
    }
    return t;
  }

  /* 把当前这一帧渲成 w×h 的像素，画进调用方给的 2D canvas（PNG 与视频帧共用这一条）。
     走 RenderTarget 而不是改画布尺寸：出片时界面不跳，也不依赖屏幕上那块 letterbox 的大小。
     `applyTime` 必须在 `setRenderTarget` 之前同步跑：出片那条路一帧一帧排着走，
     不经过 rAF；少了这一步，骨头停在上一帧（或绑定姿势）。 */
  function grab(w, h, outCanvas) {
    const W = Math.max(2, Math.round(w));
    const H = Math.max(2, Math.round(h));
    applyTime(playT);
    const cam = activeCamera();
    const prevAspect = cam.aspect;
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    const t = targetFor(W, H);
    const prevTarget = renderer.getRenderTarget();
    /* 出图 / 出片是交付物：视锥标识、选中框这类视口辅助物一个都不能进画面。
       机位视角下本来就不显示，导演视角下这里临时摘掉，渲完立刻还原。 */
    const prevRig = stage.rig.visible;
    const prevHelper = helper.visible;
    stage.rig.visible = false;
    helper.visible = false;
    renderer.setRenderTarget(t);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.setClearColor(SKY, 1);
    renderer.clear();
    renderer.render(stage.scene, cam);
    const buf = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(t, 0, 0, W, H, buf);
    renderer.setRenderTarget(prevTarget);
    stage.rig.visible = prevRig;
    helper.visible = prevHelper;
    cam.aspect = prevAspect;
    cam.updateProjectionMatrix();
    const cv = outCanvas || document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { alpha: false });
    const img = ctx.createImageData(W, H);
    /* readRenderTargetPixels 是自下而上的行序，这里翻过来 */
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4;
      img.data.set(buf.subarray(src, src + W * 4), y * W * 4);
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  function shot(w, h, type = 'image/png', quality) {
    const cv = grab(w, h);
    return new Promise(resolve => cv.toBlob(b => resolve(b), type, quality));
  }

  function clearTargets() {
    for (const t of rt.values()) { try { t.dispose(); } catch (e) { /* 释放失败不影响下一次 */ } }
    rt.clear();
  }

  return {
    el: renderer.domElement,
    stage, orbit, gizmo, renderer,
    get content() { return content; },
    get doc() { return doc; },
    setDoc, rebuild, fit, frameTo, applyCamera,
    setRigVisible(v) { rigOn = v !== false; syncRig(); markDirty(); },
    setSelection, setGizmoMode, setViewMode, setAspect,
    setActive(fn) { active = fn || (() => true); markDirty(); kick(); },
    set onPick(fn) { onPick = fn; },
    set onTransform(fn) { onTransform = fn; },
    set onCameraChange(fn) { onCameraChange = fn; },
    set onNotes(fn) { onNotes = fn; },
    get playing() { return playing; },
    set playing(v) { playing = !!v; markDirty(); kick(); },
    get time() { return playT; },
    setTime(t) { playT = Math.max(0, Number(t) || 0); lastPoseKey = ''; applyTime(playT); kick(); },
    applyTime,
    clipEnded() { return content && content.clipsEnded ? content.clipsEnded : []; },
    invalidate() { markDirty(); kick(); },
    paint, grab, shot,
    frameRect() {
      const { w, h } = canvasSize();
      return frameRect(aspect, w, h);
    },
    sizeOf(shortEdge) { return sizeOfAspect(aspect, shortEdge); },
    get aspect() { return aspect; },
    cameraState() { return { pos: camD.position.toArray(), target: orbit.target.toArray(), fov: camD.fov }; },
    /* 内容包围盒：机位预设与「装进画面」都读它（取景算法的唯一来源） */
    bounds() { return boundsOf(content); },
    cameraPose() { return { pos: camC.position.toArray(), target: doc ? doc.scene.camera.target : [0, 1, 0], fov: camC.fov }; },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      try { ro.disconnect(); } catch (e) { /* 观察器断开失败不影响卸载 */ }
      if (content) disposeContent(content);
      try { stage.rigHelper.geometry.dispose(); stage.rigHelper.material.dispose(); } catch (e) { /* 视锥标识释放失败不影响卸载 */ }
      clearTargets();
      try { gizmo.detach(); gizmo.dispose(); } catch (e) { /* 控制器释放失败不影响卸载 */ }
      try { orbit.dispose(); } catch (e) { /* 同上 */ }
      try { renderer.dispose(); } catch (e) { /* 同上 */ }
      try { renderer.domElement.remove(); } catch (e) { /* 同上 */ }
    },
  };
}
