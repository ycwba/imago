/* 模型小人（素体）—— 8 种体型、20 个姿势、连续步态。
   数据与算法按参考项目（agentic-3d-director）的比例表与公式重写，几何交给 three。

   这一份是**纯数据 + 纯函数**：产出一棵「零件树」，每个零件只描述形状参数与局部变换，
   不 import three。好处是判据能在 Node 里直接算关节世界坐标（tests/model3d-mannequin.mjs），
   而把形状变成网格的活只在 scene.js 一处。

   坐标：米，Y 向上，模型朝 +Z。关节角度一律用度；度 → 四元数的换算只在 rig.js 一处。

   与参考实现的两处有意偏差（都在下面注释里点了名）：
   1. `body.offsetY` 真的会移动身体（参考项目写了这个控制项却没消费它，蹲姿因此浮在空中）；
   2. `leftHand.* / rightHand.*` 真的会转手腕（同上，姿势表里写了却没人用）。 */

export const BODY_TYPES = ['mannequin', 'female', 'broad', 'muscular', 'slim', 'teen', 'child', 'chibi'];

const BASE = {
  hipY: 0.74,
  pelvisRadius: 0.26,
  pelvisScale: [1.34, 0.58, 0.8],
  legSpread: 0.18,
  torsoLowerRadius: 0.18,
  torsoUpperRadius: 0.22,
  torsoLowerHeight: 0.26,
  torsoUpperHeight: 0.48,
  torsoLowerScale: [0.95, 0.96, 0.78],
  torsoUpperScale: [1.42, 1.08, 0.88],
  shoulderWidth: 0.42,
  shoulderRadius: 0.14,
  upperArmRadius: 0.085,
  upperArmLength: 0.34,
  forearmRadius: 0.074,
  forearmLength: 0.3,
  elbowRadius: 0.09,
  wristRadius: 0.074,
  handRadius: 0.095,
  handScale: [0.72, 1, 0.9],
  thighRadius: 0.11,
  thighLength: 0.42,
  calfRadius: 0.095,
  calfLength: 0.4,
  kneeRadius: 0.1,
  ankleRadius: 0.08,
  footRadius: 0.095,
  footLength: 0.22,
  footScale: [0.95, 0.55, 1.42],
  neckRadius: 0.1,
  neckHeight: 0.18,
  headRadius: 0.24,
  headScale: [0.78, 1, 0.72],
  faceOffsetZ: 0.18,
  eyeRadius: 0.022,
  noseScale: [0.42, 0.58, 0.32],
  mouthScale: [0.55, 0.1, 0.08],
  jointRadiusScale: 1,
};

const preset = (bodyType, label, defaultScale, patch) => ({
  bodyType, label, defaultScale,
  p: Object.assign({}, BASE, patch || {}),
});

export const BODY_PRESETS = [
  preset('mannequin', '男性素体', [1, 1, 1]),
  preset('female', '女性素体', [1, 1, 1], {
    pelvisScale: [1.42, 0.56, 0.78], torsoLowerRadius: 0.16, torsoUpperRadius: 0.2,
    torsoLowerScale: [0.86, 0.98, 0.72], torsoUpperScale: [1.2, 1.04, 0.8],
    shoulderWidth: 0.37, shoulderRadius: 0.12, upperArmRadius: 0.074, forearmRadius: 0.066,
    thighRadius: 0.1, calfRadius: 0.082, headScale: [0.76, 1, 0.7],
  }),
  preset('broad', '宽厚素体', [1, 1, 1], {
    pelvisScale: [1.46, 0.62, 0.86], torsoLowerScale: [1.05, 0.98, 0.84],
    torsoUpperScale: [1.58, 1.08, 0.94], torsoUpperRadius: 0.27, torsoUpperHeight: 0.52,
    shoulderWidth: 0.52, shoulderRadius: 0.16, upperArmRadius: 0.105, forearmRadius: 0.09,
    thighRadius: 0.125, calfRadius: 0.108, headRadius: 0.25,
  }),
  preset('muscular', '健壮素体', [1, 1, 1], {
    pelvisScale: [1.25, 0.56, 0.78], torsoLowerRadius: 0.17, torsoUpperRadius: 0.28,
    torsoLowerScale: [0.95, 0.96, 0.78], torsoUpperScale: [1.62, 1.06, 0.9],
    shoulderWidth: 0.5, shoulderRadius: 0.17, upperArmRadius: 0.11, forearmRadius: 0.095,
    thighRadius: 0.13, calfRadius: 0.11,
  }),
  preset('slim', '纤细素体', [1, 1, 1], {
    pelvisScale: [1.08, 0.5, 0.7], torsoLowerRadius: 0.14, torsoUpperRadius: 0.17,
    torsoLowerScale: [0.78, 0.96, 0.68], torsoUpperScale: [1.04, 1.02, 0.72],
    shoulderWidth: 0.34, shoulderRadius: 0.105, upperArmRadius: 0.06, forearmRadius: 0.052,
    thighRadius: 0.082, calfRadius: 0.068, headRadius: 0.225,
  }),
  preset('teen', '少年素体', [1, 1, 1], {
    hipY: 0.64, pelvisRadius: 0.22, pelvisScale: [1.18, 0.52, 0.74], legSpread: 0.15,
    torsoLowerRadius: 0.15, torsoLowerHeight: 0.22, torsoUpperRadius: 0.18, torsoUpperHeight: 0.4,
    torsoLowerScale: [0.82, 0.94, 0.7], torsoUpperScale: [1.1, 1.02, 0.76],
    shoulderWidth: 0.34, shoulderRadius: 0.105, upperArmRadius: 0.065, upperArmLength: 0.28,
    forearmRadius: 0.056, forearmLength: 0.25, thighRadius: 0.088, thighLength: 0.35,
    calfRadius: 0.076, calfLength: 0.33, headRadius: 0.23, headScale: [0.82, 1.05, 0.76],
  }),
  preset('child', '儿童素体', [1, 1, 1], {
    hipY: 0.5, pelvisRadius: 0.18, pelvisScale: [1.05, 0.48, 0.72], legSpread: 0.12,
    torsoLowerRadius: 0.13, torsoLowerHeight: 0.18, torsoUpperRadius: 0.15, torsoUpperHeight: 0.3,
    torsoLowerScale: [0.76, 0.9, 0.68], torsoUpperScale: [0.98, 0.98, 0.72],
    shoulderWidth: 0.28, shoulderRadius: 0.085, upperArmRadius: 0.052, upperArmLength: 0.2,
    forearmRadius: 0.046, forearmLength: 0.18, elbowRadius: 0.06, wristRadius: 0.05, handRadius: 0.07,
    thighRadius: 0.07, thighLength: 0.24, calfRadius: 0.062, calfLength: 0.22,
    kneeRadius: 0.065, ankleRadius: 0.054, footRadius: 0.07, footLength: 0.16,
    headRadius: 0.255, headScale: [0.9, 1.08, 0.82],
  }),
  preset('chibi', '二头身', [1, 1, 1], {
    hipY: 0.36, pelvisRadius: 0.16, pelvisScale: [1.05, 0.48, 0.78], legSpread: 0.1,
    torsoLowerRadius: 0.12, torsoLowerHeight: 0.12, torsoUpperRadius: 0.14, torsoUpperHeight: 0.22,
    torsoLowerScale: [0.86, 0.82, 0.74], torsoUpperScale: [0.96, 0.92, 0.78],
    shoulderWidth: 0.24, shoulderRadius: 0.07, upperArmRadius: 0.044, upperArmLength: 0.14,
    forearmRadius: 0.038, forearmLength: 0.12, elbowRadius: 0.048, wristRadius: 0.04, handRadius: 0.06,
    thighRadius: 0.056, thighLength: 0.15, calfRadius: 0.05, calfLength: 0.14,
    kneeRadius: 0.052, ankleRadius: 0.042, footRadius: 0.06, footLength: 0.12,
    footScale: [1.12, 0.62, 1.55], neckRadius: 0.065, neckHeight: 0.06, headRadius: 0.34,
    headScale: [0.96, 1.04, 0.88], faceOffsetZ: 0.25, eyeRadius: 0.026,
    noseScale: [0.34, 0.46, 0.28], mouthScale: [0.45, 0.1, 0.07], jointRadiusScale: 0.9,
  }),
];

export function bodyOf(type) {
  const hit = BODY_PRESETS.find(b => b.bodyType === type);
  return hit || BODY_PRESETS[0];
}

/* 姿势表：`controls` 是「关节.轴 → 度」。键名与关节树里的关节同名，ai.js 的提示词也读这份名单。 */
export const POSE_PRESETS = [
  { id: 'stand', label: '站立', controls: {} },
  { id: 't-pose', label: 'T 型', controls: { 'leftShoulder.spread': -70, 'rightShoulder.spread': 70, 'leftShoulder.pitch': 15, 'rightShoulder.pitch': 15, 'leftElbow.bend': 10, 'rightElbow.bend': 10 } },
  { id: 'walk', label: '行走', controls: { 'leftShoulder.pitch': 20, 'rightShoulder.pitch': -20, 'leftHip.pitch': -20, 'rightHip.pitch': 20, 'leftKnee.bend': 12, 'rightKnee.bend': 4 } },
  { id: 'run', label: '跑步', controls: { 'leftShoulder.pitch': 42, 'rightShoulder.pitch': -42, 'leftHip.pitch': -35, 'rightHip.pitch': 40, 'leftKnee.bend': 28, 'rightKnee.bend': 18 } },
  { id: 'sit', label: '坐姿', controls: { 'torso.pitch': -10, 'leftHip.pitch': 80, 'rightHip.pitch': 80, 'leftKnee.bend': 90, 'rightKnee.bend': 90 } },
  { id: 'crouch', label: '蹲下', controls: { 'body.offsetY': -0.43, 'body.pitch': -26, 'torso.pitch': -24, 'head.pitch': 22, 'leftHip.pitch': 92, 'rightHip.pitch': 92, 'leftKnee.bend': 112, 'rightKnee.bend': 112, 'leftShoulder.pitch': 52, 'rightShoulder.pitch': 50, 'leftShoulder.spread': -10, 'rightShoulder.spread': 10, 'leftElbow.bend': 80, 'rightElbow.bend': 76 } },
  { id: 'kneel-one', label: '单膝跪', controls: { 'body.offsetY': -0.42, 'body.pitch': -16, 'torso.pitch': -10, 'head.pitch': 12, 'leftHip.pitch': 68, 'leftKnee.bend': 86, 'leftFoot.pitch': 20, 'rightHip.pitch': -15, 'rightKnee.bend': 80, 'rightFoot.pitch': 60, 'leftShoulder.pitch': 5, 'leftShoulder.spread': 10, 'leftShoulder.twist': -10, 'leftElbow.bend': 30, 'rightShoulder.pitch': -18, 'rightShoulder.spread': 10, 'rightElbow.bend': 18 } },
  { id: 'kneel-two', label: '双膝跪', controls: { 'body.offsetY': -0.4, 'body.pitch': 2, 'torso.pitch': 8, 'head.pitch': -2, 'leftShoulder.pitch': -10, 'rightShoulder.pitch': -10, 'leftShoulder.spread': -5, 'rightShoulder.spread': 5, 'leftElbow.bend': 8, 'rightElbow.bend': 8, 'leftHip.pitch': -8, 'rightHip.pitch': -8, 'leftKnee.bend': 126, 'rightKnee.bend': 126, 'leftFoot.pitch': -20, 'rightFoot.pitch': -20 } },
  { id: 'hands-on-hips', label: '叉腰', controls: { 'leftShoulder.pitch': -36, 'rightShoulder.pitch': -36, 'leftShoulder.twist': 80, 'rightShoulder.twist': -80, 'leftElbow.bend': 86, 'rightElbow.bend': 86, 'leftHand.roll': -35, 'rightHand.roll': 35 } },
  { id: 'lean', label: '倚靠', controls: { 'body.roll': -10, 'leftHip.spread': -8, 'rightHip.spread': 8, 'head.roll': 6 } },
  { id: 'bow', label: '鞠躬', controls: { 'body.pitch': -46, 'torso.pitch': -10, 'head.pitch': 20, 'leftHip.pitch': 49, 'rightHip.pitch': 49, 'leftShoulder.pitch': 5, 'rightShoulder.pitch': 5, 'leftShoulder.spread': 10, 'rightShoulder.spread': -10, 'leftElbow.bend': 12, 'rightElbow.bend': 12 } },
  { id: 'think', label: '思考', controls: { 'rightShoulder.pitch': 8, 'rightShoulder.twist': -40, 'rightElbow.bend': 90, 'rightHand.roll': -40, 'rightHand.pitch': 15, 'rightHand.twist': -10, 'leftShoulder.pitch': 8, 'leftShoulder.twist': 40, 'leftElbow.bend': 90 } },
  { id: 'fight', label: '格斗', controls: { 'body.yaw': -10, 'body.pitch': 5, 'torso.yaw': 8, 'head.yaw': 8, 'leftShoulder.pitch': 48, 'leftShoulder.spread': -16, 'leftShoulder.twist': 22, 'rightShoulder.pitch': 30, 'rightShoulder.twist': -22, 'leftElbow.bend': 86, 'rightElbow.bend': 84, 'leftHip.spread': -18, 'rightHip.spread': 22, 'leftHip.pitch': 4, 'rightHip.pitch': -6, 'leftKnee.bend': 12, 'rightKnee.bend': 18 } },
  { id: 'kick', label: '踢球', controls: { 'leftHip.pitch': -8, 'rightHip.pitch': 58, 'rightKnee.bend': 35, 'leftShoulder.pitch': 18, 'rightShoulder.pitch': -24 } },
  { id: 'throw', label: '投掷', controls: { 'body.offsetY': -0.12, 'body.pitch': 5, 'body.yaw': 14, 'torso.yaw': -10, 'head.yaw': 8, 'rightShoulder.pitch': 76, 'rightShoulder.spread': -14, 'rightShoulder.twist': 28, 'rightElbow.bend': 86, 'rightHand.roll': 18, 'rightHand.pitch': -12, 'leftShoulder.pitch': 34, 'leftShoulder.spread': 10, 'leftShoulder.twist': 8, 'leftElbow.bend': 54, 'leftHand.pitch': -10, 'leftHip.spread': -12, 'rightHip.spread': 18, 'leftHip.pitch': 24, 'rightHip.pitch': -10, 'leftKnee.bend': 30, 'rightKnee.bend': 14, 'leftFoot.pitch': -8, 'rightFoot.roll': 6 } },
  { id: 'push', label: '推进', controls: { 'body.offsetY': -0.16, 'body.pitch': 5, 'body.yaw': 38, 'torso.pitch': -4, 'head.pitch': 6, 'leftShoulder.pitch': 92, 'rightShoulder.pitch': 92, 'leftShoulder.spread': -11, 'rightShoulder.spread': 11, 'leftShoulder.twist': 6, 'rightShoulder.twist': -6, 'leftElbow.bend': 6, 'rightElbow.bend': 6, 'leftHand.pitch': -14, 'rightHand.pitch': -14, 'leftHip.spread': -12, 'rightHip.spread': 14, 'leftHip.pitch': 38, 'rightHip.pitch': -20, 'leftKnee.bend': 42, 'rightKnee.bend': 20, 'leftFoot.pitch': -6, 'rightFoot.roll': 8 } },
  { id: 'wave', label: '招手', controls: { 'rightShoulder.pitch': 60, 'rightShoulder.twist': 30, 'rightElbow.bend': 90, 'rightHand.roll': -20, 'rightHand.pitch': 12, 'rightHand.twist': 10, 'leftShoulder.pitch': -10, 'leftShoulder.spread': 8, 'leftElbow.bend': 18, 'leftHand.pitch': -8 } },
  { id: 'reach', label: '伸手', controls: { 'rightShoulder.pitch': 50, 'rightElbow.bend': 12 } },
  { id: 'cross-arms', label: '抱臂', controls: { 'leftShoulder.pitch': 50, 'leftShoulder.spread': -55, 'leftShoulder.twist': 75, 'leftElbow.bend': 50, 'leftHand.pitch': -10, 'rightShoulder.pitch': 90, 'rightShoulder.spread': 55, 'rightShoulder.twist': -45, 'rightElbow.bend': 50, 'rightHand.roll': 18, 'rightHand.pitch': -10 } },
  { id: 'phone', label: '看手机', controls: { 'head.pitch': 18, 'rightShoulder.pitch': 20, 'rightShoulder.spread': -4, 'rightShoulder.twist': -30, 'rightElbow.bend': 82, 'rightHand.roll': -30, 'rightHand.pitch': 14, 'rightHand.twist': 60, 'leftShoulder.pitch': -10, 'leftShoulder.spread': 8, 'leftElbow.bend': 16, 'leftHand.pitch': -8 } },
];

export const POSE_IDS = POSE_PRESETS.map(p => p.id);
export function poseOf(id) {
  return POSE_PRESETS.find(p => p.id === id) || POSE_PRESETS[0];
}

const R2D = 180 / Math.PI;
/* 各体型的关节活动上限（度）。二头身 / 儿童不按成年人那样掰。 */
export function poseLimitOf(bodyType) {
  if (bodyType === 'chibi') return 58;
  if (bodyType === 'child') return 72;
  return 90;
}
const clampDeg = (v, limit) => Math.max(-limit, Math.min(limit, Number.isFinite(v) ? v : 0));

function rotFromControls(c, prefix, limit) {
  return [
    clampDeg(c[prefix + '.pitch'], limit),
    clampDeg(c[prefix + '.yaw'], limit),
    clampDeg(c[prefix + '.roll'], limit),
  ];
}
function rotSingle(c, key, limit) {
  return [clampDeg(c[key], limit), 0, 0];
}
function rotLimb(c, prefix, limit) {
  return [
    clampDeg(c[prefix + '.pitch'], limit),
    clampDeg(c[prefix + '.twist'], limit),
    clampDeg(c[prefix + '.spread'], limit),
  ];
}

/* 连续步态：走 / 跑都是相位上的正弦。基准常数与参考项目一致（步频 1.65 / 2.45，
   臂摆 26 / 48），这样同一个「行走」在两边的节奏一致。`motion` 可以是字符串
   （walk / run），也可以是 {kind, speed, stride, arm}：speed 调步频、stride 调步幅 /
   腿摆、arm 调臂摆。 */
export function gaitControls(motion, t) {
  const conf = (motion && typeof motion === 'object') ? motion : { kind: motion };
  if (conf.kind !== 'walk' && conf.kind !== 'run') return null;
  const running = conf.kind === 'run';
  const speedK = Number(conf.speed) > 0 ? Number(conf.speed) : 1;
  const strideK = Number(conf.stride) > 0 ? Number(conf.stride) : 1;
  const armK = Number.isFinite(Number(conf.arm)) && Number(conf.arm) >= 0 ? Number(conf.arm) : 1;
  const cadence = (running ? 2.45 : 1.65) * speedK;
  const phase = t * cadence * Math.PI * 2;
  const stride = Math.sin(phase);
  const opposite = Math.sin(phase + Math.PI);
  const footCycle = Math.sin(phase + Math.PI / 2);
  const bounce = Math.abs(Math.sin(phase));
  const armSwing = (running ? 48 : 26) * armK;
  const hipSwing = (running ? 46 : 28) * strideK;
  const kneeBase = running ? 16 : 4;
  const kneeLift = (running ? 48 : 26) * strideK;
  return {
    'body.offsetY': bounce * (running ? 0.07 : 0.035),
    'body.pitch': running ? 7 : 1.5,
    'torso.yaw': stride * (running ? 5 : 3),
    'leftShoulder.pitch': stride * armSwing,
    'rightShoulder.pitch': opposite * armSwing,
    'leftElbow.bend': running ? 70 + stride * 8 : 8 + Math.max(0, stride) * 12,
    'rightElbow.bend': running ? 70 + opposite * 8 : 8 + Math.max(0, opposite) * 12,
    'leftHip.pitch': stride * hipSwing,
    'rightHip.pitch': opposite * hipSwing,
    'leftKnee.bend': kneeBase + Math.max(0, stride) * kneeLift,
    'rightKnee.bend': kneeBase + Math.max(0, opposite) * kneeLift,
    'leftFoot.pitch': Math.max(0, footCycle) * (running ? 22 : 12),
    'rightFoot.pitch': Math.max(0, -footCycle) * (running ? 22 : 12),
  };
}

/* 三层叠加的顺序在这里定死（契约里也写着这一条，判据 tests/model3d-anim.mjs 盯着）：
   姿势表 → 节点的 controls（覆盖同一关节）→ 步态（再覆盖它自己那几项）；
   关节轨道的 rot 不在这张表里 —— 它到 rig.applyPose 里在 base 之上叠加（最后一步）。 */
export function controlsOf({ pose, motion, t, controls }) {
  const merged = Object.assign({}, poseOf(pose).controls, controls || {});
  const gait = gaitControls(motion, t || 0);
  if (gait) Object.assign(merged, gait);
  return merged;
}

const capsule = (r, len) => ({ k: 'capsule', r, len });
const sphere = (r) => ({ k: 'sphere', r });
const cyl = (rt, rb, h) => ({ k: 'cyl', rt, rb, h });
const torus = (r, r2) => ({ k: 'torus', r, r2 });

const part = (g, at, opts) => Object.assign({ g, at, rot: [0, 0, 0], scale: [1, 1, 1], tone: 'hi' }, opts || {});
const group = (at, rot, children, opts) => Object.assign({ parts: [], children: children || [] }, opts || {}, { at: at || [0, 0, 0], rot: rot || [0, 0, 0], scale: (opts && opts.scale) || [1, 1, 1] });

/* 零件树。结构照参考项目：body → (torso → 躯干 + 头 + 双臂) + 双腿；
   关节是「带旋转的 group」，肢体是 group 里的 capsule。 */
export function mannequinTree({ body, pose, controls, motion, t } = {}) {
  const presetDef = bodyOf(body);
  const p = presetDef.p;
  const limit = poseLimitOf(presetDef.bodyType);
  const c = controlsOf({ pose, motion, t, controls });

  const bodyRot = rotFromControls(c, 'body', limit);
  const torsoRot = rotFromControls(c, 'torso', limit);
  const headRot = rotFromControls(c, 'head', limit);
  const ls = rotLimb(c, 'leftShoulder', limit);
  const rs = rotLimb(c, 'rightShoulder', limit);
  const le = rotSingle(c, 'leftElbow.bend', limit);
  const re = rotSingle(c, 'rightElbow.bend', limit);
  const lh = rotLimb(c, 'leftHip', limit);
  const rh = rotLimb(c, 'rightHip', limit);
  const lk = rotSingle(c, 'leftKnee.bend', limit);
  const rk = rotSingle(c, 'rightKnee.bend', limit);
  const lf = rotSingle(c, 'leftFoot.pitch', limit);
  const rf = rotSingle(c, 'rightFoot.pitch', limit);
  const lhHand = rotFromControls(c, 'leftHand', limit);
  const rhHand = rotFromControls(c, 'rightHand', limit);

  const abdomenY = p.hipY + p.pelvisRadius * 0.6 + p.torsoLowerHeight * 0.5;
  const chestY = abdomenY + p.torsoLowerHeight * 0.5 + p.torsoUpperHeight * 0.5 + p.torsoUpperRadius * 0.1;
  const neckY = chestY + p.torsoUpperHeight * 0.5 + p.neckHeight * 0.5 + p.torsoUpperRadius * 0.2;
  const headY = neckY + p.neckHeight * 0.5 + p.headRadius * 0.75;
  const shoulderY = chestY + p.torsoUpperHeight * 0.16 + p.shoulderRadius * 0.4;
  const armOriginY = shoulderY - p.shoulderRadius * 0.55;
  const elbowY = -(p.upperArmLength + p.upperArmRadius + p.elbowRadius);
  const wristY = -(p.forearmLength + p.forearmRadius + p.wristRadius);
  const handY = wristY - p.handRadius - 0.05;
  const hipJointY = p.hipY - p.pelvisRadius * 0.15;
  const legOriginY = p.hipY - p.pelvisRadius * 0.35;
  const kneeY = -(p.thighLength + p.thighRadius + p.kneeRadius);
  const ankleY = -(p.calfLength + p.calfRadius + p.ankleRadius);
  const footY = ankleY - p.footRadius - 0.045;
  const js = p.jointRadiusScale;

  const chestScale = p.torsoUpperScale, abdomenScale = p.torsoLowerScale;
  const torso = group([0, 0, 0], torsoRot, [], { name: 'torso' });
  torso.parts.push(
    part(capsule(p.torsoUpperRadius, p.torsoUpperHeight), [0, chestY, 0], { scale: chestScale.slice() }),
    part(torus(p.torsoUpperRadius * chestScale[0] * 0.78, Math.max(p.torsoUpperRadius * 0.028, 0.006)),
      [0, chestY - p.torsoUpperHeight * 0.38, 0], { rot: [90, 0, 0], scale: [1, chestScale[2] / chestScale[0], 1], tone: 'lo' }),
    part(capsule(p.torsoLowerRadius, p.torsoLowerHeight), [0, abdomenY, 0], { scale: abdomenScale.slice() }),
    part(torus(p.torsoLowerRadius * abdomenScale[0] * 0.92, Math.max(p.torsoLowerRadius * 0.026, 0.005)),
      [0, abdomenY - p.torsoLowerHeight * 0.46, 0], { rot: [90, 0, 0], scale: [1, abdomenScale[2] / abdomenScale[0], 1], tone: 'lo' }),
    part(sphere(p.pelvisRadius), [0, p.hipY, 0], { scale: p.pelvisScale.slice() }),
    /* 肩关节与髋关节：小球把「关节」这件事读出来，姿势才看得懂 */
    part(sphere(p.shoulderRadius), [-p.shoulderWidth * 0.86, shoulderY, 0], { scale: [js, js, js] }),
    part(sphere(p.shoulderRadius), [p.shoulderWidth * 0.86, shoulderY, 0], { scale: [js, js, js] }),
  );

  const eyeY = p.headRadius * 0.16, eyeX = p.headRadius * 0.26;
  const faceZ = p.faceOffsetZ + p.headRadius * 0.08;
  torso.children.push(group([0, neckY, 0], [0, 0, 0], [], { parts: [part(cyl(p.neckRadius * 0.9, p.neckRadius, p.neckHeight), [0, 0, 0])] }));
  const head = group([0, headY, 0], headRot, [], {
    name: 'head',
    parts: [
      part(sphere(p.headRadius), [0, 0, 0], { scale: p.headScale.slice() }),
      part(sphere(p.headRadius * 0.38), [0, -p.headRadius * 0.08, p.faceOffsetZ], { scale: [0.7, 0.52, 0.25] }),
      part(sphere(p.eyeRadius), [-eyeX, eyeY, faceZ], { scale: [1, 0.58, 0.32], tone: 'lo' }),
      part(sphere(p.eyeRadius), [eyeX, eyeY, faceZ], { scale: [1, 0.58, 0.32], tone: 'lo' }),
      part(sphere(p.headRadius * 0.11), [0, -p.headRadius * 0.04, faceZ + p.headRadius * 0.05], { scale: p.noseScale.slice() }),
      part(sphere(p.headRadius * 0.12), [0, -p.headRadius * 0.24, faceZ + p.headRadius * 0.025], { scale: p.mouthScale.slice(), tone: 'lo' }),
    ],
  });
  torso.children.push(head);

  function arm(side, shoulderRot, elbowRot, handRot) {
    const sign = side === 'left' ? -1 : 1;
    const upper = group([sign * p.shoulderWidth, armOriginY, 0], shoulderRot, [], {
      name: side + 'Shoulder',
      parts: [part(capsule(p.upperArmRadius, p.upperArmLength), [0, -(p.upperArmLength * 0.5 + p.upperArmRadius), 0])],
    });
    const fore = group([0, elbowY, 0], elbowRot, [], {
      name: side + 'Elbow',
      parts: [
        part(sphere(p.elbowRadius), [0, 0, 0], { scale: [js, js, js] }),
        part(capsule(p.forearmRadius, p.forearmLength), [0, -(p.forearmLength * 0.5 + p.forearmRadius), 0]),
        part(sphere(p.wristRadius), [0, wristY, 0], { scale: [js, js, js] }),
      ],
    });
    const hand = group([0, handY, 0.02], handRot, [], {
      name: side + 'Hand',
      scale: p.handScale.slice(),
      parts: [
        part(sphere(p.handRadius), [0, 0, 0]),
        part(capsule(p.handRadius * 0.24, p.handRadius * 0.62), [sign * p.handRadius * 0.76, -p.handRadius * 0.12, p.handRadius * 0.36],
          { rot: [0.18 * R2D, 0, sign * 0.72 * R2D], scale: [0.58, 0.85, 0.52] }),
        part(capsule(p.handRadius * 0.34, p.handRadius * 0.7), [0, -p.handRadius * 0.44, p.handRadius * 0.22],
          { rot: [0.18 * R2D, 0, 0], scale: [1.12, 0.56, 0.48] }),
      ],
    });
    fore.children.push(hand);
    upper.children.push(fore);
    return upper;
  }
  torso.children.push(arm('left', ls, le, lhHand), arm('right', rs, re, rhHand));

  function leg(side, hipRot, kneeRot, footRot) {
    const sign = side === 'left' ? -1 : 1;
    const thigh = group([sign * p.legSpread, legOriginY, 0], hipRot, [], {
      name: side + 'Hip',
      parts: [part(capsule(p.thighRadius, p.thighLength), [0, -(p.thighLength * 0.5 + p.thighRadius), 0])],
    });
    const calf = group([0, kneeY, 0], kneeRot, [], {
      name: side + 'Knee',
      parts: [
        part(sphere(p.kneeRadius), [0, 0, 0], { scale: [js, js, js] }),
        part(capsule(p.calfRadius, p.calfLength), [0, -(p.calfLength * 0.5 + p.calfRadius), 0]),
        part(sphere(p.ankleRadius), [0, ankleY, 0], { scale: [js, js, js] }),
      ],
    });
    const foot = group([0, footY, p.footRadius * 0.74], footRot, [], {
      name: side + 'Foot',
      parts: [
        part(capsule(p.footRadius, p.footLength), [0, 0, 0], { rot: [90, 0, 0], scale: p.footScale.slice() }),
        part(sphere(p.footRadius), [0, -p.footRadius * 0.04, p.footLength * 0.48],
          { scale: [p.footScale[0] * 0.92, p.footScale[1] * 0.72, p.footScale[2] * 0.48] }),
      ],
    });
    calf.children.push(foot);
    thigh.children.push(calf);
    return thigh;
  }

  const bodyGroup = group([0, 0, 0], bodyRot, [torso], { name: 'body', scale: presetDef.defaultScale.slice() });
  bodyGroup.parts.push(
    part(sphere(p.thighRadius * 1.08), [-p.legSpread, hipJointY, 0], { scale: [js, js, js] }),
    part(sphere(p.thighRadius * 1.08), [p.legSpread, hipJointY, 0], { scale: [js, js, js] }),
  );
  bodyGroup.children.push(leg('left', lh, lk, lf), leg('right', rh, rk, rf));
  /* body.offsetY 真的会移动身体：蹲 / 跪那几套姿势靠它把重心压下去（见文件头第 1 条偏差）。 */
  const offsetY = Number.isFinite(Number(c['body.offsetY'])) ? Number(c['body.offsetY']) : 0;
  bodyGroup.at = [0, offsetY, 0];
  return bodyGroup;
}

/* 小人摆在地上的高度（脚底到头顶），给相机取景与包围盒用；纯估算，够用。 */
export function mannequinHeight(bodyType) {
  const p = bodyOf(bodyType).p;
  return p.hipY + p.pelvisRadius * 0.6 + p.torsoLowerHeight + p.torsoUpperHeight
    + p.neckHeight + p.headRadius * 1.5;
}
