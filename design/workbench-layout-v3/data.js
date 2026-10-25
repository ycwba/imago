/* ============================================================================
   生成工作台 · 布局重构稿「作业台」—— 稿子里的内容（假数据）。
   字段与口径贴着真产品走：
     · 参数分组与按钮叫法 → web/pages/studio.js（ADV_BODY_HTML / TYPES）
     · 素材槽 → 同文件 SLOT_DEF（参考图 / 参考视频 / 参考音频 / 开头画面 / 结尾画面）
     · 历史筛选计数、卡片字段、余额口径 → tests/fixtures/visual/actual/ 的真机画面
   这一份只是设计稿的「料」，不进运行时。
   ========================================================================== */

const BENCH = {
  /* ---------- 三种生成类型 ---------- */
  types: {
    video: {
      zh: '视频',
      go: '生成视频',
      model: 'VGENV · base · 快速',
      cap: '能力来自上游接口（缓存）· VGEN',
      bal: '余额 ¥43.75',
      est: '4 张 · 1.2 积分',
      estSub: '预计 2 分钟 · 余额 ¥43.75',
      mode: '智能参考',
      slots: ['参考图', '参考视频'],
      recipe: [
        { key: 'prompt', kind: 'prompt', label: '提示词', value: '128 字', open: true,
          text: '雨后的巷子，青苔爬满砖缝。一只橘猫踩着水洼走过，霓虹灯在水里碎成一片。镜头缓缓推近，最后停在巷口那盏还亮着的灯上。',
          hint: '智能参考：这一档收拢「缩略画面 s1 · 开头画面 s1 · 参考首图 s9 · 参考音频 s2」——素材就是纯文字，放哪一批就是哪一种请求。' },
        { key: 'mode', kind: 'mode', label: '输入模式', value: '智能参考',
          opts: ['智能参考', '纯文本', '纯参考图', '首尾帧'],
          hint: '换模式只改「素材怎么解释」，不删你填的内容。' },
        { key: 'slots', kind: 'slots', label: '参考素材', value: '3 项',
          items: [
            { label: '参考图', n: 1, th: 'th-3' },
            { label: '参考视频', n: 1, th: 'th-5' },
            { label: '参考音频', n: 1, th: 'th-2' },
          ] },
        { key: 'fields', kind: 'fields', label: '画面参数', value: '4 项已设',
          fields: [
            { k: '档位', v: '快速' },
            { k: '画质', v: '768p' },
            { k: '时长（秒）', v: '5 秒' },
            { k: '画面比例', v: '竖屏 9:16' },
            { k: '生成条数', v: '4 张' },
          ] },
        { key: 'bool', kind: 'bool', label: '平台开关', value: '生成音频 · 是',
          bools: [{ k: '生成音频', v: '是' }, { k: '平台润色', v: '否' }] },
        { key: 'cost', kind: 'cost', label: '费用', value: '1.2 积分',
          lines: [['4 张 × 0.30', '1.20 积分'], ['平台未提供价格', '按经验值估']] },
      ],
    },

    image: {
      zh: '图像',
      go: '生成图像',
      model: 'SparkCine · 通用 · 高清',
      cap: '能力来自上游接口（缓存）· SparkCine',
      bal: '可用 784 积分',
      est: '4 张 · ¥0.60',
      estSub: '预计 40 秒 · 可用 784 积分',
      mode: '纯文本',
      slots: ['参考图'],
      recipe: [
        { key: 'prompt', kind: 'prompt', label: '提示词', value: '86 字', open: true,
          text: '一张产品图：磨砂玻璃质感的香水瓶立在浅色石台上，柔光从左后方打过来，背景是一面微糙的米白墙。',
          hint: '这一档只吃图片：文字与参考图会拼成同一条请求。' },
        { key: 'mode', kind: 'mode', label: '输入模式', value: '纯文本',
          opts: ['纯文本', '参考图', '智能参考'],
          hint: '换模式只改「素材怎么解释」，不删你填的内容。' },
        { key: 'slots', kind: 'slots', label: '参考素材', value: '1 项',
          items: [{ label: '参考图', n: 1, th: 'th-1' }] },
        { key: 'fields', kind: 'fields', label: '生成设置', value: '5 项已设',
          fields: [
            { k: '质量', v: '标准' },
            { k: '画面比例', v: '16:9' },
            { k: '尺寸', v: '1024 × 1024' },
            { k: '数量', v: '4 张' },
            { k: '格式', v: 'PNG' },
          ] },
        { key: 'cost', kind: 'cost', label: '费用', value: '¥0.60',
          lines: [['4 张 × ¥0.15', '¥0.60'], ['平台未提供价格', '按经验值估']] },
      ],
    },

    audio: {
      zh: '音频',
      go: '生成音频',
      model: 'mimo-v2.5-tts',
      cap: '能力来自上游接口（缓存）· MiMo',
      bal: '可用 120 分钟',
      est: '1 段 · ¥0.12',
      estSub: '预计 15 秒 · 可用 120 分钟',
      mode: '纯文本',
      slots: ['参考音频'],
      recipe: [
        { key: 'prompt', kind: 'prompt', label: '待合成文本', value: '0 字', open: true,
          text: '',
          hint: '这一档收纯文本生成，数字、英文缩写建议写成读法。' },
        { key: 'style', kind: 'style', label: '音色描述', value: '必填',
          text: '',
          hint: '音色设计型号必填。' },
        { key: 'slots', kind: 'slots', label: '参考素材', value: '0 项',
          items: [], empty: '当前型号只支持纯文本生成，换个型号可解参考音频。' },
        { key: 'fields', kind: 'fields', label: '合成设置', value: '2 项已设',
          fields: [
            { k: '音色', v: '默认音色 · 自动' },
            { k: '输出格式', v: 'WAV' },
          ] },
        { key: 'cost', kind: 'cost', label: '费用', value: '¥0.12',
          lines: [['约 180 字 · ¥0.12', '¥0.12'], ['平台未提供价格', '按经验值估']] },
      ],
    },
  },

  order: ['video', 'image', 'audio'],

  /* ---------- 历史墙：这一台的生成历史（右栏读的是平台任务记录，不是资产库） ---------- */
  wall: [
    { id: 'a1', type: 'image', zh: '图片', local: true, time: '2026-10-22 18:50', size: '42.0 KB', prompt: '', th: 'th-1' },
    { id: 'a2', type: 'image', zh: '图片', local: true, time: '2026-10-22 18:50', size: '42.0 KB', prompt: '', th: 'th-4' },
    { id: 'a3', type: 'video', zh: '视频', local: false, time: '2026-10-22 18:44', size: '6.1 MB', prompt: '雨后的巷子，橘猫踩过水洼', th: 'th-2' },
    { id: 'a4', type: 'video', zh: '视频', local: true, time: '2026-10-22 18:31', size: '8.4 MB', prompt: '霓虹灯在水里碎成一片', th: 'th-5' },
    { id: 'a5', type: 'image', zh: '图片', local: false, time: '2026-10-22 17:58', size: '1.2 MB', prompt: '磨砂玻璃质感的香水瓶', th: 'th-3' },
    { id: 'a6', type: 'audio', zh: '音频', local: true, time: '2026-10-22 17:40', size: '380 KB', prompt: '睡前故事 · 第三段', th: 'th-6' },
    { id: 'a7', type: 'image', zh: '图片', local: true, time: '2026-10-22 16:22', size: '42.0 KB', prompt: '', th: 'th-6' },
    { id: 'a8', type: 'video', zh: '视频', local: false, time: '2026-10-22 15:10', size: '5.8 MB', prompt: '推近，停在巷口那盏灯', th: 'th-1' },
    { id: 'a9', type: 'image', zh: '图片', local: true, time: '2026-10-22 14:05', size: '960 KB', prompt: '浅色石台上的玻璃瓶', th: 'th-4' },
    { id: 'a10', type: 'audio', zh: '音频', local: false, time: '2026-10-21 22:18', size: '402 KB', prompt: '旁白 · 序章', th: 'th-2' },
    { id: 'a11', type: 'video', zh: '视频', local: true, time: '2026-10-21 21:33', size: '7.1 MB', prompt: '水面上的倒影晃动', th: 'th-3' },
    { id: 'a12', type: 'image', zh: '图片', local: true, time: '2026-10-21 20:09', size: '42.0 KB', prompt: '', th: 'th-5' },
  ],

  /* ---------- 历史筛选（真机画面上的计数） ---------- */
  filters: [
    { k: 'all', zh: '全部', n: 560 },
    { k: 'image', zh: '图片', n: 392 },
    { k: 'video', zh: '视频', n: 135 },
    { k: 'audio', zh: '音频', n: 33 },
  ],
};
