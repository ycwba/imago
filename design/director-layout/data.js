/* 导演台布局重构稿 —— 内容数据（稿子里的字都取自真品，不另编一套）。
   字段名与文案口径对着 web/director/engine/* 与 web/ui/workbench.js 的状态词表。 */
'use strict';

window.DIR = {
  proj: { name: '雨夜便利店', list: '我的短片', count: 3 },

  /* 场次 —— 左栏分组 */
  scenes: [
    { id: 's1', name: '雨夜街口', shots: ['sh1', 'sh2', 'sh3'] },
    { id: 's2', name: '便利店内', shots: ['sh4', 'sh5', 'sh6'] },
    { id: 's3', name: '天台', shots: ['sh7', 'sh8'] },
  ],

  /* 镜头 —— shotStatusOf 的那套状态：已选用 / 待选用 / 生成失败 / 未生成 / 待写描述 */
  shots: {
    sh1: {
      no: '01', name: '雨落在卷帘门上', scene: 's1', dur: 2.4, state: 'used',
      thumb: 'assets/scene-gate.jpg', cands: [
        { id: 'c11', no: 1, state: 'done', thumb: 'assets/scene-gate.jpg', dur: 2.4, local: '本机', sel: true, desc: '雨点砸在卷帘门上，霓虹在水里散开' },
        { id: 'c12', no: 2, state: 'done', thumb: 'assets/scene-gate.jpg', dur: 2.1, local: '云端', locked: true, desc: '低机位仰拍，卷帘门占满画幅' },
      ],
    },
    sh2: {
      no: '02', name: '招牌在雨里亮起', scene: 's1', dur: 0, state: 'run', prog: 62,
      thumb: '', cands: [
        { id: 'c21', no: 1, state: 'running', dur: 0, thumb: '', local: '本机', desc: '招牌在雨里亮起，暖光晕开', prog: 62, queue: 2 },
      ],
    },
    sh3: {
      no: '03', name: '推门的手', scene: 's1', dur: 0, state: 'draft', thumb: '', cands: [],
    },
    sh4: {
      no: '04', name: '收银台空无一人', scene: 's2', dur: 3.2, state: 'used',
      thumb: 'assets/scene-classroom.jpg', cands: [
        { id: 'c41', no: 1, state: 'done', thumb: 'assets/scene-classroom.jpg', dur: 3.2, local: '本机', sel: true, desc: '空无一人的收银台，冷白灯管在地上反着光，镜头缓慢横移' },
        { id: 'c42', no: 2, state: 'done', thumb: 'assets/scene-classroom.jpg', dur: 3.4, local: '本机+云端', desc: '推门视角进门，货架排到画面深处' },
      ],
    },
    sh5: {
      no: '05', name: '柜台上的旧收音机', scene: 's2', dur: 0, state: 'failed', thumb: 'assets/prop-recorder.jpg',
      cands: [
        { id: 'c51', no: 1, state: 'failed', thumb: 'assets/prop-recorder.jpg', dur: 0, local: '本机', desc: '柜台上那台旧收音机，旋钮停在半路', err: '上游返回 502：这一条没有生成出来' },
      ],
    },
    sh6: {
      no: '06', name: '店员从货架后抬头', scene: 's2', dur: 4.0, state: 'used',
      thumb: 'assets/char-chenyan.jpg', cands: [
        { id: 'c61', no: 1, state: 'done', thumb: 'assets/char-chenyan.jpg', dur: 4.0, local: '本机', locked: true, desc: '店员从货架后抬起头，灯光只照到半张脸' },
      ],
    },
    sh7: {
      no: '07', name: '雨落天台栏杆', scene: 's3', dur: 3.5, state: 'used',
      thumb: 'assets/scene-rooftop.jpg', cands: [
        { id: 'c71', no: 1, state: 'done', thumb: 'assets/scene-rooftop.jpg', dur: 3.5, local: '云端', sel: true, desc: '雨落在天台栏杆上，城市在雨雾里退开' },
      ],
    },
    sh8: {
      no: '08', name: '栏杆边靠着一把伞', scene: 's3', dur: 2.5, state: 'used',
      thumb: 'assets/prop-umbrella.jpg', cands: [
        { id: 'c81', no: 1, state: 'done', thumb: 'assets/prop-umbrella.jpg', dur: 2.5, local: '本机', sel: true, desc: '栏杆边靠着一把湿透的黑伞' },
      ],
    },
  },

  /* 顺序（全片）：已选用的镜头按这个顺序进成片 —— 与 chain.js 的 shotPlacement 同一口径 */
  sequence: ['sh1', 'sh4', 'sh6', 'sh7', 'sh8'],

  /* 剪辑态右栏 —— 台词（lines.js 的状态词：未写 / 待生成 / 已生成） */
  lines: {
    local: [
      { who: '店员', text: '欢迎光临。要关东煮吗？', state: 'done', dur: '2.1 秒', at: '00:00:04:02' },
    ],
    film: [
      { who: '店员', text: '欢迎光临。要关东煮吗？', state: 'done', dur: '2.1 秒', at: '00:00:04:02' },
      { who: '推门的人', text: '来一份关东煮。', state: 'wait', dur: '1.4 秒', at: '00:00:11:18' },
    ],
  },

  /* 剪辑态右栏 —— 配音轨上的句子（voice.js 的行式） */
  voices: [
    { who: '店员', text: '欢迎光临。要关东煮吗？', dur: 2.1, speed: '×1.0', vol: '100%', row: 1 },
  ],

  /* 字幕（sub-lane.js 的块） */
  subs: [
    { text: '欢迎光临。要关东煮吗？', start: 4.1, dur: 2.1 },
    { text: '来一份关东煮。', start: 11.5, dur: 1.4 },
  ],

  /* 画面轨：这一镜被切成三段（engine/lanes.js 的 .tl-seg） */
  segs: [
    { name: '收银台空无一人 · 第 1 段', dur: 1.2, thumb: 'assets/scene-classroom.jpg', mute: false },
    { name: '收银台空无一人 · 第 2 段', dur: 0.8, thumb: 'assets/scene-classroom.jpg', mute: false },
    { name: '收银台空无一人 · 第 3 段', dur: 1.2, thumb: 'assets/scene-classroom.jpg', mute: true },
  ],

  /* 生成态右栏 —— 这一镜的设置（panel.js 的表单组） */
  panel: {
    prompt: '空无一人的收银台，冷白灯管在地上反着光，镜头缓慢横移，货架排到画面深处。',
    mode: '首尾帧 + 参考素材',
    model: 'VGENV · 视频换人',
    ratio: '跟随这一镜（16:9）',
    quality: '标准 · 2段分/张',
    dur: '约 3–8 张 · 按 4 张约 8 秒',
    slots: [
      { k: '开头画面', v: '首帧 · 点击选择', empty: true },
      { k: '结尾画面', v: '尾帧', empty: true },
      { k: '参考图 1', v: '已选 1 / 最多 4 张' },
      { k: '参考视频（可选）', v: '未选', empty: true },
    ],
  },

  /* 生成坞（gen.js 的估价行口径） */
  est: { can: 5, lines: 8, cost: '¥3.20', cannot: 3 },
};
