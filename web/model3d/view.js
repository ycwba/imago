/* 三维视口 —— 唯一一处碰 WebGL / 相机 / 控制器 / 画幅 / 截图的地方。
   场景内容归 scene.js，这一层只管「怎么看、怎么拍」：

   · 两套相机：导演视角（自由 orbit）与机位视角（`doc.scene.cams` 里的活动机位）；
   · 多机位：出图 / 出片永远用活动机位，导演视角里显示所有机位的视锥标识；
   · 画幅 letterbox：屏幕上看到的那块矩形与导出时的尺寸**同源**（frameRect 一份算法）；
   · 截图与逐帧出片：走离屏 RenderTarget 读回像素，不改画布尺寸 —— 出片时界面不会跳一下；
   · 脏标记循环：不播放、没拖动、没改模型时一帧都不画（建模台要长时间开着，不能空转烧电）。

   播放时钟不在这里：`web/pages/model/dock.js` 是唯一时钟，逐帧调 `setTime(t)`。
   出片所需的 `preserveDrawingBuffer` 在这里打开：离屏渲染完立刻读回，但有些驱动在
   `await` 之后会清缓冲，留着它最省事（代价是一次多余的拷贝）。 */

import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { TransformControls } from '../vendor/three/TransformControls.js';
import {
  createStage, setPanorama, buildContent, disposeContent, disposeStage,
  boundsOf, updateCameraRig, setCameraRigs, setTrackPaths,
  setStageLights, applyLightSample, tightenStageShadows, updateLightRig, setLightRigs,
  setSketchMarks, screenToCamPaths,
} from './scene.js';
import { sampleAnim, sampleCams, sampleLights } from './anim.js';
import { findNode, round3 } from './schema.js';
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
  const se = Math.max(2, Math.round(shortEdge) || 720);
  return ar >= 1 ? { w: Math.round(se * ar), h: se } : { w: se, h: Math.round(se / ar) };
}

export function createView(host, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.domElement.className = 'mm-canvas';
  host.appendChild(renderer.domElement);

  const stage = createStage();
  const camD = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 400);
  camD.position.set(3.4, 2.2, 4.6);
  const camC = stage.camC;
  const orbit = new OrbitControls(camD, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.target.set(0, 0.95, 0);
  orbit.maxPolarAngle = Math.PI * 0.495;      // 不许钻到地台下面
  orbit.minDistance = 0.4;
  /* 中键拖 = 平移视角：滚轮已经负责缩放，中键留给「把视角挪个地方」最顺手。 */
  orbit.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  renderer.domElement.title = '左键拖动旋转 / 平移视角 · 右键或中键拖动平移 · 滚轮缩放';

  /* 一个手柄同时画平移箭头与旋转环：两套 TransformControls 挂在同一个对象上，
     各自只处理自己命中的轴，不再让用户先切「移动 / 旋转」。 */
  const gizmo = new TransformControls(camD, renderer.domElement);
  const gizmoR = new TransformControls(camD, renderer.domElement);
  const draggingControls = new Set();
  const watchDrag = g => e => {
    const other = g === gizmo ? gizmoR : gizmo;
    if (e.value) {
      draggingControls.add(g);
      other.enabled = false;          // 一次只让一套手柄接管指针，避免又平移又旋转
    } else {
      draggingControls.delete(g);
      if (!draggingControls.size) { gizmo.enabled = true; gizmoR.enabled = true; }
    }
    dragging = draggingControls.size > 0;
    syncOrbitEnabled();
  };
  for (const [g, mode] of [[gizmo, 'translate'], [gizmoR, 'rotate']]) {
    g.setSize(0.85);
    g.setMode(mode);
    g.addEventListener('dragging-changed', watchDrag(g));
    stage.scene.add(g.getHelper());
  }

  const helper = new THREE.BoxHelper(new THREE.Object3D(), SELECT);
  helper.visible = false;
  helper.material.depthTest = false;
  helper.material.transparent = true;
  helper.renderOrder = 999;
  stage.scene.add(helper);
  const camGizmo = new THREE.Object3D();
  camGizmo.name = 'camera-gizmo';
  camGizmo.visible = false;
  stage.scene.add(camGizmo);
  /* 灯的拖动代理：与 camGizmo 同一副用法（移动改位置，旋转环改看向）。 */
  const lightGizmo = new THREE.Object3D();
  lightGizmo.name = 'light-gizmo';
  lightGizmo.visible = false;
  stage.scene.add(lightGizmo);
  let doc = null;
  let content = null;
  let mode = 'director';
  let navMode = 'rotate';              // 导演视角左键：rotate | pan
  let editable = true;                 // 白膜快速弹窗里关掉手柄
  let aspect = '16:9';
  let selectedId = '';
  let selectedCam = '';
  let selectedLight = '';
  let dragging = false;
  let rigOn = true;                    // 相机标识开关（页面偏好，不进模型文件）
  let dirty = true;
  let playing = false;
  let playT = 0;
  let raf = 0;
  let disposed = false;
  let active = () => true;             // 页面可见性（外层塞 __spaActivity 判据进来）
  let onPick = null;
  let onTransform = null;
  let onCamTransform = null;
  let onLightTransform = null;
  let onCameraChange = null;
  let onNotes = null;
  let onSketchChange = null;
  let lastNotesKey = '';
  let lastPoseKey = '';
  /* 涂鸦层：标注只存在页面手里（不进 doc），这里只负责画、采集与拾取。 */
  let sketchOn = false;
  let sketchTool = 'select';
  let sketchColor = 'blue';
  let sketchText = '';
  let sketchMarks = [];
  let stroke = null;
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
    if (stage.rigs) stage.rigs.visible = rigOn && mode === 'director';
    if (stage.lightRigs) stage.lightRigs.visible = rigOn && mode === 'director';
    if (stage.paths) stage.paths.visible = mode === 'director';
  }
  /* 导演视角能不能转，只看「在导演视角 && 没在拖手柄」。
     选中 / 换手柄 / 松手都从这里收一次，避免某次拖动把 orbit 永久锁死。 */
  function syncOrbitEnabled() {
    orbit.enabled = mode === 'director' && !dragging;
  }

  function applyCamSample(cam, sample) {
    const pos = (sample && sample.at) || cam.pos;
    const target = (sample && sample.target) || cam.target;
    const fov = sample && sample.fov != null ? sample.fov : cam.fov;
    camC.position.set(pos[0], pos[1], pos[2]);
    camC.fov = fov;
    camC.lookAt(new THREE.Vector3(target[0], target[1], target[2]));
    camC.updateProjectionMatrix();
    camC.updateMatrixWorld(true);
  }

  function syncCamGizmo(cam, sample) {
    if (!cam) return;
    const pos = (sample && sample.at) || cam.pos;
    const target = (sample && sample.target) || cam.target;
    camGizmo.position.set(pos[0], pos[1], pos[2]);
    const tmp = new THREE.PerspectiveCamera();
    tmp.position.set(pos[0], pos[1], pos[2]);
    tmp.lookAt(new THREE.Vector3(target[0], target[1], target[2]));
    camGizmo.quaternion.copy(tmp.quaternion);
    camGizmo.updateMatrixWorld(true);
  }

  const lightLook = new THREE.Object3D();
  function syncLightGizmo(light, sample) {
    if (!light) return;
    const at = (sample && sample.at) || light.at;
    const target = (sample && sample.target) || light.target || [0, 0, 0];
    lightGizmo.position.set(at[0], at[1], at[2]);
    lightLook.position.set(at[0], at[1], at[2]);
    lightLook.lookAt(new THREE.Vector3(target[0], target[1], target[2]));
    lightGizmo.quaternion.copy(lightLook.quaternion);
    lightGizmo.updateMatrixWorld(true);
  }

  /* 灯每帧跟着采样走：灯对象、标识、选中代理三处一起写。 */
  function applyLights(time, nodeSamples) {
    if (!doc) return;
    const ns = nodeSamples || sampleAnim(doc.anim, time, doc);
    const lights = sampleLights(doc.anim, doc, time, ns);
    for (const light of (doc.scene.lights || [])) {
      const s = lights[light.id] || light;
      const rec = stage.lightMap.get(light.id);
      if (rec) applyLightSample(rec, s);
      updateLightRig(stage, light, s, light.id === selectedLight);
      if (light.id === selectedLight && !dragging) syncLightGizmo(light, s);
    }
  }

  /* 把当前时刻的活动机位写进 camC，并把所有机位的视锥标识同步到这一帧。 */
  function applyCamera(t, nodeSamples) {
    if (!doc) return;
    const time = t == null ? playT : Math.max(0, Number(t) || 0);
    const ns = nodeSamples || sampleAnim(doc.anim, time, doc);
    const cams = sampleCams(doc.anim, doc, time, ns);
    const activeId = doc.scene.active;
    const activeCam = doc.scene.cams.find(c => c.id === activeId) || doc.scene.cams[0];
    if (activeCam) applyCamSample(activeCam, cams[activeCam.id]);
    if (stage.rigs) {
      for (const cam of doc.scene.cams) {
        const s = cams[cam.id] || cam;
        updateCameraRig(stage, {
          id: cam.id, pos: s.at || cam.pos, target: s.target || cam.target, fov: s.fov != null ? s.fov : cam.fov,
        }, ASPECTS[aspect] || 16 / 9, cam.id === activeId);
        if (cam.id === selectedCam && !dragging) syncCamGizmo(cam, s);
      }
    }
    applyLights(time, ns);
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
    /* 建场景时记下的话要在界面说一次：文件里没这条动画、摆件没加载……
       同一份 doc 只报一次（播放中姿势变化也会重建，重复刷会把状态行一直压在警示上）。 */
    const notesKey = content.notes.join('\n');
    if (notesKey && notesKey !== lastNotesKey && onNotes) onNotes(content.notes.slice());
    lastNotesKey = notesKey;
    stage.ground.visible = doc.scene.view.ground;
    stage.floor.visible = doc.scene.view.ground;
    stage.grid.visible = doc.scene.view.grid;
    setCameraRigs(stage, doc.scene.cams, doc.scene.active, ASPECTS[aspect] || 16 / 9);
    setStageLights(stage, doc.scene.lights, doc.scene.light);
    setLightRigs(stage, doc.scene.lights, selectedLight);
    setTrackPaths(stage, doc);
    applyCamera(playT);
    if (selectedLight) setSelection({ kind: 'light', id: selectedLight });
    else if (selectedCam) setSelection({ kind: 'cam', id: selectedCam });
    else setSelection(selectedId);
    const box = boundsOf(content);
    const span = Math.max(1, box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    /* 阴影相机按内容收紧：白膜的自阴影条纹主要来自阴影贴图铺得太开 */
    tightenStageShadows(stage, span);
    markDirty();
  }

  function setDoc(next, o = {}) {
    const first = !doc;
    doc = next;
    poseOverrides.clear();
    lastPoseKey = '';
    lastNotesKey = '';
    if (first || o.resetTime) playT = 0;
    if (selectedCam && (!doc || !doc.scene.cams.some(c => c.id === selectedCam))) selectedCam = '';
    if (selectedLight && (!doc || !doc.scene.lights.some(l => l.id === selectedLight))) selectedLight = '';
    if (o.aspect) aspect = o.aspect; else if (doc) aspect = doc.scene.view.aspect;
    mode = doc ? doc.scene.view.mode : mode;
    rebuild();
    if (doc && doc.anim && doc.anim.tracks && doc.anim.tracks.length) applyTime(playT);
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

  /* 取景预设：近景（对上半身）/ 中景（整体装进画面）/ 全景（再退一档）。 */
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

  function attachGizmos(obj) {
    gizmo.enabled = true;
    gizmoR.enabled = true;
    gizmo.attach(obj);
    gizmoR.attach(obj);
  }
  function detachGizmos() {
    if (gizmo.object) gizmo.detach();
    if (gizmoR.object) gizmoR.detach();
  }

  function setSelection(sel) {
    syncOrbitEnabled();
    if (sel && typeof sel === 'object' && sel.kind === 'cam') {
      selectedCam = String(sel.id || '');
      selectedLight = '';
      selectedId = '';
      const cam = doc && doc.scene.cams.find(c => c.id === selectedCam);
      const rig = cam && stage.rigMap.get(cam.id);
      if (!cam || !rig) {
        helper.visible = false;
        detachGizmos();
        markDirty();
        return;
      }
      syncCamGizmo(cam);
      helper.setFromObject(rig.pick);
      helper.visible = true;
      if (editable && mode === 'director') attachGizmos(camGizmo);
      else detachGizmos();
      markDirty();
      return;
    }
    if (sel && typeof sel === 'object' && sel.kind === 'light') {
      selectedLight = String(sel.id || '');
      selectedCam = '';
      selectedId = '';
      const light = doc && doc.scene.lights.find(l => l.id === selectedLight);
      const rig = light && stage.lightRigMap.get(light.id);
      if (!light || !rig) {
        helper.visible = false;
        detachGizmos();
        markDirty();
        return;
      }
      syncLightGizmo(light);
      helper.setFromObject(rig.pick);
      helper.visible = true;
      if (editable && mode === 'director') attachGizmos(lightGizmo);
      else detachGizmos();
      markDirty();
      return;
    }
    selectedCam = '';
    selectedLight = '';
    selectedId = sel || '';
    const wrap = selectedId && content ? content.byId.get(selectedId) : null;
    /* 锁定的实体只画选中框、不挂手柄：手柄一挂上，拖一下就把锁定的东西挪了 */
    const node = (doc && selectedId) ? findNode(doc.scene.nodes, selectedId) : null;
    const locked = !!(node && node.locked);
    if (!wrap) {
      helper.visible = false;
      detachGizmos();
    } else {
      helper.setFromObject(wrap);
      helper.visible = true;
      if (editable && mode === 'director' && !locked) attachGizmos(wrap);
      else detachGizmos();
    }
    markDirty();
  }

  function setEditable(v) {
    editable = v !== false;
    if (!editable) detachGizmos();
    else if (selectedLight) setSelection({ kind: 'light', id: selectedLight });
    else if (selectedCam) setSelection({ kind: 'cam', id: selectedCam });
    else setSelection(selectedId);
    syncOrbitEnabled();
    markDirty();
  }

  function setViewMode(m) {
    mode = m === 'camera' ? 'camera' : 'director';
    syncOrbitEnabled();
    syncRig();
    if (selectedLight) setSelection({ kind: 'light', id: selectedLight });
    else if (selectedCam) setSelection({ kind: 'cam', id: selectedCam });
    else setSelection(selectedId);
    markDirty();
  }

  /* 导演视角的左键手势：旋转（围着目标转）或平移（把目标与相机一起挪）。 */
  function setNavMode(m) {
    navMode = m === 'pan' ? 'pan' : 'rotate';
    orbit.mouseButtons.LEFT = navMode === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    markDirty();
  }

  function setActiveCam(id) {
    if (!doc || !doc.scene.cams.some(c => c.id === id)) return false;
    doc.scene.active = id;
    applyCamera(playT);
    return true;
  }

  function setAspect(a) {
    aspect = ASPECTS[a] ? a : '16:9';
    setCameraRigs(stage, doc ? doc.scene.cams : [], doc ? doc.scene.active : '', ASPECTS[aspect] || 16 / 9);
    if (doc) applyCamera(playT);
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
    playT = Math.max(0, Number(t) || 0);
    const samples = sampleAnim(doc.anim, playT, doc);
    const ids = Object.keys(samples);
    let needPose = false;
    const keyParts = [];
    for (const id of ids) {
      const s = samples[id];
      const motionKey = s.motion ? (typeof s.motion === 'object' ? JSON.stringify(s.motion) : s.motion) : '';
      if (s.pose || s.motion) {
        const node = findNode(doc.scene.nodes, id);
        if (node && (node.kind === 'mannequin' || node.kind === 'crowd')) {
          needPose = true;
          poseOverrides.set(id, { pose: s.pose || node.pose, motion: s.motion || '' });
        }
      }
      keyParts.push(id + ':' + (s.pose || '') + ':' + motionKey);
    }
    const key = keyParts.join('|');
    const poseChanged = key !== lastPoseKey;
    lastPoseKey = key;
    if (needPose && poseChanged) {
      /* 姿势 / 步态变了 —— 重建（白膜的动；一帧三十来个零件，24fps 下够用） */
      const keep = selectedId;
      const keepCam = selectedCam;
      const keepLight = selectedLight;
      rebuild();
      if (keepLight) setSelection({ kind: 'light', id: keepLight });
      else if (keepCam) setSelection({ kind: 'cam', id: keepCam });
      else setSelection(keep);
    }
    for (const id of ids) {
      const s = samples[id];
      const wrap = content.byId.get(id);
      if (wrap) {
        if (s.at) wrap.position.set(s.at[0], s.at[1], s.at[2]);
        if (s.rot) wrap.rotation.set(s.rot[0] * D2R, s.rot[1] * D2R, s.rot[2] * D2R);
        /* 缩放键覆盖节点自身的 scale（镜像在 x 上取负：负号留给镜像） */
        if (s.scale) {
          const sx = wrap.scale.x < 0 ? -Math.abs(s.scale[0]) : Math.abs(s.scale[0]);
          wrap.scale.set(sx, s.scale[1], s.scale[2]);
        }
        /* 显隐键只管「轨道让它出现 / 消失」；节点自己 hidden 的仍然不显示 */
        if (s.visible != null) {
          const node = findNode(doc.scene.nodes, id);
          wrap.visible = s.visible && !(node && node.visible === false);
        }
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
    applyCamera(playT, samples);
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

  /* 循环只在「有事发生」时活着：阻尼还没停、有脏标记。页面不可见时直接不排下一帧
     （建模台会长时间开着，空转 rAF 是在烧电）。事件负责把链子重新踢起来（kick）。
     播放时钟在 dock.js：它逐帧调 setTime，这里只负责把脏标记画出来。 */
  function tick() {
    raf = 0;
    if (disposed || !active()) return;
    let more = false;
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

  /* 手柄拖到画布外松手时，TransformControls 只在 canvas 上收 pointerup：
     它收不到就会把 dragging 留在 true、把 orbit 一起锁死（之后导演视角拖不动）。
     补一条 window 级收尾：不管在哪松手都把拖动状态与 orbit 放回来。 */
  function stopGizmoDrag() {
    if (!dragging && !gizmo.dragging && !gizmoR.dragging) return;
    dragging = false;
    draggingControls.clear();
    if (gizmo.dragging) { gizmo.dragging = false; gizmo.axis = null; }
    if (gizmoR.dragging) { gizmoR.dragging = false; gizmoR.axis = null; }
    gizmo.enabled = true;
    gizmoR.enabled = true;
    syncOrbitEnabled();
    markDirty();
  }
  window.addEventListener('pointerup', stopGizmoDrag, true);
  window.addEventListener('pointercancel', stopGizmoDrag, true);
  window.addEventListener('blur', () => { cancelStroke(); stopGizmoDrag(); });

  /* ---------------- 涂鸦（标注只存在页面手里，不进 doc） ---------------- */
  function liveMarkOfStroke() {
    if (!stroke) return null;
    if (stroke.type === 'arrow') return { type: 'arrow', color: stroke.color, from: stroke.from, to: stroke.to };
    if (stroke.pts.length < 2) return null;
    return { type: stroke.type, color: stroke.color, pts: stroke.pts.slice() };
  }
  function syncSketch() {
    const live = liveMarkOfStroke();
    setSketchMarks(stage, live ? sketchMarks.concat([live]) : sketchMarks);
    markDirty();
  }
  function notifySketch() {
    if (!onSketchChange) return;
    try { onSketchChange(sketchMarks.map(m => JSON.parse(JSON.stringify(m)))); } catch (e) { /* 页面自己不刷新不影响画 */ }
  }
  /* 参考深度面：选中实体的中心；机位视角取机位看向的点；否则取导演视角的焦点。 */
  function sketchFocusPoint() {
    if (selectedId && content) {
      const o = content.byId.get(selectedId);
      if (o) return o.getWorldPosition(new THREE.Vector3());
    }
    if (mode === 'camera' && doc) {
      const c = doc.scene.cams.find(x => x.id === doc.scene.active) || doc.scene.cams[0];
      if (c && Array.isArray(c.target)) return new THREE.Vector3().fromArray(c.target);
    }
    return orbit.target.clone();
  }
  function sketchPoint(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, activeCamera());
    const fwd = new THREE.Vector3();
    activeCamera().getWorldDirection(fwd);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, sketchFocusPoint());
    const out = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, out)) return null;
    return [round3(out.x), round3(out.y), round3(out.z)];
  }
  function strokePoints(from, to) {
    const cam = activeCamera();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const f = new THREE.Vector3().fromArray(from);
    const d = new THREE.Vector3().fromArray(to).sub(f);
    const u = d.dot(right);
    const v = d.dot(up);
    const ptOf = (vec) => [round3(vec.x), round3(vec.y), round3(vec.z)];
    if (stroke.type === 'rect') {
      const a = f.clone();
      const b = f.clone().addScaledVector(right, u);
      const c = b.clone().addScaledVector(up, v);
      const d2 = f.clone().addScaledVector(up, v);
      return [ptOf(a), ptOf(b), ptOf(c), ptOf(d2)];
    }
    const r = Math.hypot(u, v);
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push(ptOf(f.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r)));
    }
    return pts;
  }
  function eraseNear(pt) {
    const point = new THREE.Vector3().fromArray(pt);
    let best = -1;
    let bestD = 0.25;
    sketchMarks.forEach((m, i) => {
      const pts = m.type === 'arrow' ? [m.from, m.to] : (m.type === 'text' ? [m.at] : (m.pts || []));
      for (const q of pts) {
        if (!Array.isArray(q)) continue;
        const d = point.distanceTo(new THREE.Vector3().fromArray(q));
        if (d < bestD) { bestD = d; best = i; }
      }
    });
    if (best >= 0) { sketchMarks.splice(best, 1); syncSketch(); notifySketch(); }
  }
  function beginStroke(e, surfaceAt) {
    /* surfaceAt：Alt 起笔时射线打在模型表面上的那个点（箭头 / 画笔才能从主体身上起笔）；
       不给就落回参考深度面。继续的笔画点仍走深度面 —— 起笔锚一次，后面不混锚。 */
    const pt = surfaceAt
      ? [round3(surfaceAt.x), round3(surfaceAt.y), round3(surfaceAt.z)]
      : sketchPoint(e);
    if (!pt) return;
    if (sketchTool === 'eraser') { eraseNear(pt); return; }
    if (sketchTool === 'text') {
      const txt = String(sketchText || '').trim();
      if (!txt) return;
      sketchMarks.push({ type: 'text', color: sketchColor, at: pt, text: txt.slice(0, 60) });
      syncSketch();
      notifySketch();
      return;
    }
    stroke = { type: sketchTool, color: sketchColor, pts: [pt], from: pt, to: pt };
    orbit.enabled = false;
  }
  function moveStroke(e) {
    if (!stroke) return;
    const pt = sketchPoint(e);
    if (!pt) return;
    if (stroke.type === 'arrow') { stroke.to = pt; syncSketch(); return; }
    if (stroke.type === 'circle' || stroke.type === 'rect') {
      stroke.to = pt;
      stroke.pts = strokePoints(stroke.from, pt);
      syncSketch();
      return;
    }
    const last = stroke.pts[stroke.pts.length - 1];
    if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1], pt[2] - last[2]) > 0.02) {
      stroke.pts.push(pt);
      syncSketch();
    }
  }
  function endStroke() {
    if (!stroke) return;
    const m = liveMarkOfStroke();
    if (m) sketchMarks.push(m);
    stroke = null;
    syncOrbitEnabled();
    syncSketch();
    if (m) notifySketch();
  }
  function cancelStroke() {
    if (!stroke) return;
    stroke = null;
    syncOrbitEnabled();
    syncSketch();
  }

  /* ---------------- 拾取 ---------------- */
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', e => {
    /* 涂鸦档：gizmo 优先，其次实体，空白处才画；中键 / 右键永远归视口。 */
    if (sketchOn && sketchTool !== 'select' && e.button === 0) {
      if (gizmo.axis || gizmoR.axis || gizmo.dragging || gizmoR.dragging) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(pointer, activeCamera());
      const hit = content ? ray.intersectObject(content.group, true).find(h => !h.object.isLineSegments) : null;
      /* 点在实体上仍是普通点选；按住 Alt 才在模型表面起笔（涂鸦不抢实体的选中）。 */
      if (hit && !e.altKey) return;
      e.preventDefault();
      beginStroke(e, hit ? hit.point : null);
      return;
    }
    downAt = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener('pointermove', e => { if (stroke) moveStroke(e); });
  renderer.domElement.addEventListener('pointercancel', () => { cancelStroke(); });
  renderer.domElement.addEventListener('pointerup', e => {
    if (stroke) { endStroke(); downAt = null; return; }
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4 || !content) return;            // 拖动视角不算点选
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, activeCamera());
    const picks = [];
    if (mode === 'director' && rigOn && stage.rigMap) {
      for (const rig of stage.rigMap.values()) if (rig.pick) picks.push(rig.pick);
    }
    if (mode === 'director' && rigOn && stage.lightRigMap) {
      for (const rig of stage.lightRigMap.values()) if (rig.pick) picks.push(rig.pick);
    }
    const hits = ray.intersectObjects([content.group, ...picks], true);
    for (const h of hits) {
      let o = h.object;
      if (o.isLineSegments) continue;             // 描边不参与拾取
      while (o && !o.userData.camId && !o.userData.lightId && !o.userData.nodeId) o = o.parent;
      if (o && o.userData.camId) { if (onPick) onPick({ kind: 'cam', id: o.userData.camId }); return; }
      if (o && o.userData.lightId) { if (onPick) onPick({ kind: 'light', id: o.userData.lightId }); return; }
      if (!o || !o.userData.nodeId) continue;
      /* 锁定的实体点不中（它自己也隐藏时更要点不中）——「锁住」在视口里就该是碰不到的 */
      const n = doc ? findNode(doc.scene.nodes, o.userData.nodeId) : null;
      if (n && n.locked) continue;
      if (onPick) onPick(o.userData.nodeId);
      return;
    }
    if (onPick) onPick('');
  });

  /* 平移箭头只回写位置；旋转环只回写朝向。两套手柄挂在同一个对象上，
     但 objectChange 各归各的，不会互相覆盖。 */
  gizmo.addEventListener('objectChange', () => {
    if (selectedCam) {
      if (!onCamTransform) return;
      const pos = [round3(camGizmo.position.x), round3(camGizmo.position.y), round3(camGizmo.position.z)];
      onCamTransform(selectedCam, { pos });
      return;
    }
    if (selectedLight) {
      if (!onLightTransform) return;
      const at = [round3(lightGizmo.position.x), round3(lightGizmo.position.y), round3(lightGizmo.position.z)];
      onLightTransform(selectedLight, { at });
      return;
    }
    const obj = gizmo.object;
    if (!obj || !onTransform) return;
    const id = obj.userData.nodeId;
    if (!id) return;
    onTransform(id, { at: [round3(obj.position.x), round3(obj.position.y), round3(obj.position.z)] });
    if (helper.visible) helper.setFromObject(obj);
    markDirty();
  });

  gizmoR.addEventListener('objectChange', () => {
    if (selectedCam) {
      if (!onCamTransform || !doc) return;
      const cam = doc.scene.cams.find(c => c.id === selectedCam);
      if (!cam) return;
      const pos = [round3(camGizmo.position.x), round3(camGizmo.position.y), round3(camGizmo.position.z)];
      const dx = cam.target[0] - cam.pos[0];
      const dy = cam.target[1] - cam.pos[1];
      const dz = cam.target[2] - cam.pos[2];
      const dist = Math.max(0.001, Math.hypot(dx, dy, dz));
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camGizmo.quaternion).normalize();
      const target = [round3(pos[0] + dir.x * dist), round3(pos[1] + dir.y * dist), round3(pos[2] + dir.z * dist)];
      onCamTransform(selectedCam, { pos, target });
      return;
    }
    if (selectedLight) {
      if (!onLightTransform || !doc) return;
      const light = doc.scene.lights.find(l => l.id === selectedLight);
      if (!light) return;
      const at = [round3(lightGizmo.position.x), round3(lightGizmo.position.y), round3(lightGizmo.position.z)];
      const t = light.target || [0, 0, 0];
      const dist = Math.max(0.001, Math.hypot(t[0] - at[0], t[1] - at[1], t[2] - at[2]));
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(lightGizmo.quaternion).normalize();
      const target = [round3(at[0] + dir.x * dist), round3(at[1] + dir.y * dist), round3(at[2] + dir.z * dist)];
      onLightTransform(selectedLight, { at, target });
      return;
    }
    const obj = gizmoR.object;
    if (!obj || !onTransform) return;
    const id = obj.userData.nodeId;
    if (!id) return;
    onTransform(id, {
      rot: [round3(obj.rotation.x / D2R), round3(obj.rotation.y / D2R), round3(obj.rotation.z / D2R)],
    });
    if (helper.visible) helper.setFromObject(obj);
    markDirty();
  });

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

  /* 把某一刻渲成 w×h 的像素，画进调用方给的 2D canvas（PNG 与视频帧共用这一条）。
     走 RenderTarget 而不是改画布尺寸：出片时界面不跳，也不依赖屏幕上那块 letterbox 的大小。
     出图 / 出片永远用活动机位（camC），与当前界面是导演视角还是机位视角无关。
     `opts.time` 给了就先 setTime 一次；这是出片每帧唯一的 applyTime 入口。 */
  function grab(w, h, outCanvas, opts = {}) {
    const W = Math.max(2, Math.round(w));
    const H = Math.max(2, Math.round(h));
    const when = opts.time != null ? opts.time : playT;
    applyTime(when);
    const cam = camC;
    const prevAspect = cam.aspect;
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    const t = targetFor(W, H);
    const prevTarget = renderer.getRenderTarget();
    /* 出图 / 出片是交付物：视锥标识、路径线、选中框这类视口辅助物一个都不能进画面。 */
    const prevRigs = stage.rigs ? stage.rigs.visible : false;
    const prevLightRigs = stage.lightRigs ? stage.lightRigs.visible : false;
    const prevSketch = stage.sketch ? stage.sketch.visible : false;
    const prevPaths = stage.paths ? stage.paths.visible : false;
    const prevHelper = helper.visible;
    const prevGizmo = gizmo.getHelper().visible;
    const prevGizmoR = gizmoR.getHelper().visible;
    if (stage.rigs) stage.rigs.visible = false;
    if (stage.lightRigs) stage.lightRigs.visible = false;
    if (stage.sketch) stage.sketch.visible = false;
    if (stage.paths) stage.paths.visible = false;
    helper.visible = false;
    gizmo.getHelper().visible = false;
    gizmoR.getHelper().visible = false;
    renderer.setRenderTarget(t);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.setClearColor(SKY, 1);
    renderer.clear();
    renderer.render(stage.scene, cam);
    const buf = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(t, 0, 0, W, H, buf);
    renderer.setRenderTarget(prevTarget);
    if (stage.rigs) stage.rigs.visible = prevRigs;
    if (stage.lightRigs) stage.lightRigs.visible = prevLightRigs;
    if (stage.sketch) stage.sketch.visible = prevSketch;
    if (stage.paths) stage.paths.visible = prevPaths;
    helper.visible = prevHelper;
    gizmo.getHelper().visible = prevGizmo;
    gizmoR.getHelper().visible = prevGizmoR;
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

  function shot(w, h, type = 'image/png', quality, opts = {}) {
    const cv = grab(w, h, null, opts);
    return new Promise(resolve => cv.toBlob(b => resolve(b), type, quality));
  }

  function clearTargets() {
    for (const t of rt.values()) { try { t.dispose(); } catch (e) { /* 释放失败不影响下一次 */ } }
    rt.clear();
  }

  return {
    el: renderer.domElement,
    stage, orbit, gizmo, gizmoR, renderer,
    get content() { return content; },
    get doc() { return doc; },
    setDoc, rebuild, fit, frameTo, applyCamera, setActiveCam,
    setRigVisible(v) { rigOn = v !== false; syncRig(); markDirty(); },
    setSelection, setEditable, setViewMode, setAspect, setNavMode,
    /* 涂鸦：页面手里那一份 + 视口渲染。标注不进 doc；出图 / 出片时整组摘掉。 */
    setSketch(o) {
      const opt = o || {};
      if (opt.on != null) sketchOn = !!opt.on;
      if (opt.tool) sketchTool = String(opt.tool);
      if (opt.color) sketchColor = String(opt.color);
      if (opt.text != null) sketchText = String(opt.text);
      if (!sketchOn) { stroke = null; syncOrbitEnabled(); }
      syncSketch();
      markDirty();
    },
    getSketch() { return sketchMarks.map(m => JSON.parse(JSON.stringify(m))); },
    setSketchMarks(list) {
      sketchMarks = Array.isArray(list) ? list.map(m => JSON.parse(JSON.stringify(m))) : [];
      syncSketch();
    },
    clearSketch() { sketchMarks = []; syncSketch(); notifySketch(); },
    /* 撤上一笔（只回退标注，不碰 doc 的撤销栈）。空表时是空操作。 */
    sketchUndo() {
      if (!sketchMarks.length) return false;
      sketchMarks.pop();
      syncSketch();
      notifySketch();
      return true;
    },
    getSketchCamPaths() {
      const c = doc && ((doc.scene.cams.find(x => x.id === doc.scene.active)) || doc.scene.cams[0]);
      return c ? screenToCamPaths(sketchMarks, { pos: c.pos }) : [];
    },
    set onSketchChange(fn) { onSketchChange = fn; },
    setActive(fn) { active = fn || (() => true); markDirty(); kick(); },
    set onPick(fn) { onPick = fn; },
    set onTransform(fn) { onTransform = fn; },
    set onCamTransform(fn) { onCamTransform = fn; },
    set onLightTransform(fn) { onLightTransform = fn; },
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
    cameraPose() {
      if (!doc) return { pos: camC.position.toArray(), target: [0, 1, 0], fov: camC.fov };
      const ns = sampleAnim(doc.anim, playT, doc);
      const cams = sampleCams(doc.anim, doc, playT, ns);
      const active = doc.scene.cams.find(c => c.id === doc.scene.active) || doc.scene.cams[0];
      const s = cams[active.id] || active;
      return { pos: (s.at || active.pos).slice(), target: (s.target || active.target).slice(), fov: s.fov != null ? s.fov : active.fov };
    },
    dispose() {
      disposed = true;
      window.removeEventListener('pointerup', stopGizmoDrag, true);
      window.removeEventListener('pointercancel', stopGizmoDrag, true);
      window.removeEventListener('blur', stopGizmoDrag);
      if (raf) cancelAnimationFrame(raf);
      try { ro.disconnect(); } catch (e) { /* 观察器断开失败不影响卸载 */ }
      if (content) disposeContent(content);
      clearTargets();
      try { gizmo.detach(); gizmo.dispose(); } catch (e) { /* 控制器释放失败不影响卸载 */ }
      try { gizmoR.detach(); gizmoR.dispose(); } catch (e) { /* 同上 */ }
      try { orbit.dispose(); } catch (e) { /* 同上 */ }
      try { disposeStage(stage); } catch (e) { /* 同上 */ }
      try { renderer.dispose(); } catch (e) { /* 同上 */ }
      try { renderer.domElement.remove(); } catch (e) { /* 同上 */ }
    },
  };
}
