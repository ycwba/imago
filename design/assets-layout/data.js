/* 资产库布局稿的假数据（设计稿专用，不进产品）。
   一个校园题材的小剧组的产出：平台 9 家、三种类型、跨越一周。
   时间戳写死（今天 = 2026-10-25），截图才稳定。

   9 张缩略图是从别的小组剧集里生成的剧照（低饱和 + 浅景深 + 胶片颗粒），
   这一稿里靠 object-position 换取景，让同一张图在不同格里看起来像不同镜头。 */
export const NOW = '2026-10-25T15:40';

/* kind: 'asset' = 已入库的产物；'task' = 还挂在平台上的任务。
   status: done / running / queued / failed / uncertain（与产品那一份口径同名）。 */
export const ENTRIES = [
  /* ── 在制 ─────────────────────────────────────────────── */
  {
    id: 't-run-1', kind: 'task', status: 'running', type: '视频',
    prov: '可灵 2.1', model: 'kling-v2-1-master', prompt: '雨夜天台 · 人物转身，积水里映着霓虹',
    ts: '2026-10-25T13:26', elapsed: '2:14', size: 0, dur: 5, fmt: 'mp4',
    local: false, fav: false, credits: 12, img: 'assets/scene-rooftop.jpg', pos: '50% 55%',
    dims: '1920×1080', task: 'task_9f21c4', refs: 2,
  },
  {
    id: 't-run-2', kind: 'task', status: 'running', type: '图片',
    prov: '即梦 3.0', model: 'jimeng-3.0', prompt: '少女 · 走廊侧脸，窗光打在蓝白校服上',
    ts: '2026-10-25T15:02', elapsed: '0:38', size: 0, dur: 0, fmt: 'png',
    local: false, fav: false, credits: 2, img: 'assets/char-linwan.jpg', pos: '50% 35%',
    dims: '2048×2048', task: 'task_7bd310', refs: 1,
  },
  {
    id: 't-q-1', kind: 'task', status: 'queued', type: '视频',
    prov: 'Runway Gen-4', model: 'gen4-turbo', prompt: '天台远景 · 黄昏城市天际线',
    ts: '2026-10-25T15:30', elapsed: '第 2 位', size: 0, dur: 5, fmt: 'mp4',
    local: false, fav: false, credits: 8, img: 'assets/scene-rooftop.jpg', pos: '50% 28%',
    dims: '1920×1080', task: 'task_c104ae', refs: 0,
  },

  /* ── 有问题 ───────────────────────────────────────────── */
  {
    id: 't-fail-1', kind: 'task', status: 'failed', type: '视频',
    prov: 'Seedance 1.5', model: 'seedance-1.5-pro', prompt: '空教室 · 粉笔划过黑板的特写',
    ts: '2026-10-24T15:38', failMsg: '平台返回 429：这一分钟请求太多，已扣 6 币',
    size: 0, dur: 0, fmt: 'mp4', local: false, fav: false, credits: 6,
    img: 'assets/scene-classroom.jpg', pos: '50% 50%', dims: '1920×1080', task: 'task_5ee77a', refs: 1,
  },
  {
    id: 't-unc-1', kind: 'task', status: 'uncertain', type: '图片',
    prov: '通义万相', model: 'wanx2.1-t2i', prompt: '少女 · 雨后回眸，湿发贴着额角',
    ts: '2026-10-24T20:15', failMsg: '列表里没有这一条，可能已被平台受理',
    size: 0, dur: 0, fmt: 'png', local: false, fav: false, credits: 3,
    img: 'assets/char-sunian.jpg', pos: '50% 30%', dims: '1536×1536', task: 'task_2a90f8', refs: 0,
  },

  /* ── 已入库 · 今天 ────────────────────────────────────── */
  {
    id: 'a-01', kind: 'asset', status: 'done', type: '视频',
    prov: '可灵 2.1', model: 'kling-v2-1-master', prompt: '雨夜天台 · 人物转身，积水里映着霓虹',
    ts: '2026-10-25T14:32', size: 2412544, dur: 5, fmt: 'mp4',
    local: true, fav: true, credits: 12, img: 'assets/scene-rooftop.jpg', pos: '50% 55%',
    dims: '1920×1080', task: 'task_9f21c4', refs: 2,
  },
  {
    id: 'a-02', kind: 'asset', status: 'done', type: '图片',
    prov: '即梦 3.0', model: 'jimeng-3.0', prompt: '少女 · 走廊侧脸，窗光打在蓝白校服上',
    ts: '2026-10-25T13:05', size: 3188224, dur: 0, fmt: 'png',
    local: true, fav: false, credits: 2, img: 'assets/char-linwan.jpg', pos: '50% 35%',
    dims: '2048×2048', task: 'task_7bd310', refs: 1,
  },
  {
    id: 'a-03', kind: 'asset', status: 'done', type: '视频',
    prov: 'Runway Gen-4', model: 'gen4-turbo', prompt: '天台远景 · 黄昏城市天际线',
    ts: '2026-10-25T11:48', size: 4299161, dur: 5, fmt: 'mp4',
    local: false, fav: false, credits: 8, img: 'assets/scene-rooftop.jpg', pos: '50% 28%',
    dims: '1920×1080', task: 'task_c104ae', refs: 0,
  },
  {
    id: 'a-04', kind: 'asset', status: 'done', type: '图片',
    prov: 'FLUX.1', model: 'flux.1-dev', prompt: '空教室 · 午后的光柱与浮尘',
    ts: '2026-10-25T10:22', size: 2411724, dur: 0, fmt: 'png',
    local: true, fav: false, credits: 1, img: 'assets/scene-classroom.jpg', pos: '50% 50%',
    dims: '1536×1024', task: 'task_31ff0c', refs: 0,
  },
  {
    id: 'a-05', kind: 'asset', status: 'done', type: '音频',
    prov: 'MiniMax', model: 'speech-02', prompt: '少女旁白 · 雨夜天台独白（音色：清冷女声）',
    ts: '2026-10-25T09:07', size: 1476543, dur: 18, fmt: 'wav',
    local: true, fav: true, credits: 2, img: '', pos: '',
    dims: '48kHz · 单声道', task: 'task_88b7d2', refs: 0,
  },

  /* ── 已入库 · 昨天 ────────────────────────────────────── */
  {
    id: 'a-06', kind: 'asset', status: 'done', type: '视频',
    prov: '可灵 2.1', model: 'kling-v2-1-master', prompt: '黑色雨伞 · 雨夜校门，人物撑伞走过',
    ts: '2026-10-24T21:40', size: 3350528, dur: 5, fmt: 'mp4',
    local: true, fav: false, credits: 12, img: 'assets/prop-umbrella.jpg', pos: '50% 45%',
    dims: '1920×1080', task: 'task_1d9a55', refs: 3,
  },
  {
    id: 'a-07', kind: 'asset', status: 'done', type: '图片',
    prov: 'Midjourney v7', model: 'mj-v7', prompt: '少年 · 逆光半身，教室窗边',
    ts: '2026-10-24T19:12', size: 2879000, dur: 0, fmt: 'png',
    local: false, fav: false, credits: 3, img: 'assets/char-ache.jpg', pos: '50% 35%',
    dims: '1536×2048', task: 'task_62aa73', refs: 2,
  },
  {
    id: 'a-08', kind: 'asset', status: 'done', type: '图片',
    prov: '即梦 3.0', model: 'jimeng-3.0', prompt: '雨夜校门 · 湿地面反光',
    ts: '2026-10-24T17:55', size: 3512727, dur: 0, fmt: 'png',
    local: true, fav: false, credits: 2, img: 'assets/scene-gate.jpg', pos: '50% 60%',
    dims: '2048×2048', task: 'task_9e0b41', refs: 0,
  },
  {
    id: 'a-09', kind: 'asset', status: 'done', type: '视频',
    prov: '海螺', model: 'hailuo-02', prompt: '褪色录音机 · 桌面特写，磁带缓缓转动',
    ts: '2026-10-24T16:03', size: 5842880, dur: 6, fmt: 'mp4',
    local: false, fav: false, credits: 6, img: 'assets/prop-recorder.jpg', pos: '50% 50%',
    dims: '1920×1080', task: 'task_44c2e9', refs: 0,
  },
  {
    id: 'a-10', kind: 'asset', status: 'done', type: '音频',
    prov: 'MiniMax', model: 'speech-02', prompt: '旁白 · 少年回信（音色：温润男声）',
    ts: '2026-10-24T11:26', size: 1770135, dur: 22, fmt: 'wav',
    local: true, fav: false, credits: 2, img: '', pos: '',
    dims: '48kHz · 单声道', task: 'task_0f7a63', refs: 0,
  },

  /* ── 已入库 · 10月23日 ───────────────────────────────── */
  {
    id: 'a-11', kind: 'asset', status: 'done', type: '图片',
    prov: '通义万相', model: 'wanx2.1-t2i', prompt: '少女 · 雨后回眸，湿发贴着额角',
    ts: '2026-10-23T20:15', size: 2752512, dur: 0, fmt: 'png',
    local: true, fav: true, credits: 3, img: 'assets/char-sunian.jpg', pos: '50% 30%',
    dims: '1536×1536', task: 'task_2a90f8', refs: 0,
  },
  {
    id: 'a-12', kind: 'asset', status: 'done', type: '视频',
    prov: 'Seedance 1.5', model: 'seedance-1.5-pro', prompt: '空教室 · 粉笔划过黑板的特写',
    ts: '2026-10-23T15:38', size: 3120456, dur: 5, fmt: 'mp4',
    local: true, fav: false, credits: 6, img: 'assets/scene-classroom.jpg', pos: '50% 50%',
    dims: '1920×1080', task: 'task_5ee77a', refs: 1,
  },
  {
    id: 'a-13', kind: 'asset', status: 'done', type: '图片',
    prov: 'FLUX.1', model: 'flux.1-dev', prompt: '男主角 · 走廊远景背影',
    ts: '2026-10-23T12:02', size: 2048113, dur: 0, fmt: 'png',
    local: false, fav: false, credits: 1, img: 'assets/char-chenyan.jpg', pos: '50% 40%',
    dims: '1536×1024', task: 'task_7b31de', refs: 1,
  },
  {
    id: 'a-14', kind: 'asset', status: 'done', type: '音频',
    prov: '海螺', model: 'hailuo-audio', prompt: '环境音 · 雨声与远处车流',
    ts: '2026-10-23T10:44', size: 2961408, dur: 31, fmt: 'mp3',
    local: false, fav: false, credits: 1, img: '', pos: '',
    dims: '44.1kHz · 立体声', task: 'task_19f0a2', refs: 0,
  },

  /* ── 已入库 · 10月21日 ───────────────────────────────── */
  {
    id: 'a-15', kind: 'asset', status: 'done', type: '视频',
    prov: '可灵 2.1', model: 'kling-v2-1-master', prompt: '天台 · 双人并肩，衣角被风吹起',
    ts: '2026-10-21T22:41', size: 3906120, dur: 5, fmt: 'mp4',
    local: true, fav: true, credits: 12, img: 'assets/scene-rooftop.jpg', pos: '50% 42%',
    dims: '1920×1080', task: 'task_ab12f0', refs: 2,
  },
  {
    id: 'a-16', kind: 'asset', status: 'done', type: '图片',
    prov: '即梦 3.0', model: 'jimeng-3.0', prompt: '道具 · 褪色录音机静物',
    ts: '2026-10-21T19:30', size: 2299820, dur: 0, fmt: 'png',
    local: true, fav: false, credits: 2, img: 'assets/prop-recorder.jpg', pos: '50% 55%',
    dims: '2048×2048', task: 'task_3ca9b1', refs: 0,
  },
  {
    id: 'a-17', kind: 'asset', status: 'done', type: '图片',
    prov: 'Midjourney v7', model: 'mj-v7', prompt: '黑伞 · 桌面俯拍，雨水顺着伞骨滑下',
    ts: '2026-10-21T14:12', size: 3101450, dur: 0, fmt: 'png',
    local: false, fav: false, credits: 3, img: 'assets/prop-umbrella.jpg', pos: '50% 60%',
    dims: '1536×2048', task: 'task_5d88e4', refs: 0,
  },

  /* ── 已入库 · 10月18日 ───────────────────────────────── */
  {
    id: 'a-18', kind: 'asset', status: 'done', type: '图片',
    prov: 'Runway Gen-4', model: 'gen4-image', prompt: '少年 · 窗边侧影，光勾出轮廓',
    ts: '2026-10-18T16:05', size: 2611260, dur: 0, fmt: 'png',
    local: true, fav: false, credits: 4, img: 'assets/char-ache.jpg', pos: '50% 30%',
    dims: '1536×2048', task: 'task_77ac30', refs: 1,
  },
  {
    id: 'a-19', kind: 'asset', status: 'done', type: '视频',
    prov: '可灵 2.1', model: 'kling-v2-1-master', prompt: '雨夜校门 · 车辆驶过，溅起水花',
    ts: '2026-10-18T11:20', size: 3611044, dur: 5, fmt: 'mp4',
    local: false, fav: false, credits: 12, img: 'assets/scene-gate.jpg', pos: '50% 55%',
    dims: '1920×1080', task: 'task_ee2019', refs: 0,
  },
  {
    id: 'a-20', kind: 'asset', status: 'done', type: '图片',
    prov: '海螺', model: 'hailuo-image', prompt: '教室 · 空镜，桌面上一层粉笔灰',
    ts: '2026-10-18T09:44', size: 1980421, dur: 0, fmt: 'png',
    local: true, fav: false, credits: 1, img: 'assets/scene-classroom.jpg', pos: '50% 42%',
    dims: '1536×1024', task: 'task_9e44b7', refs: 0,
  },
];

/* 「已入库」里还埋着几条更早的（10月15日往前）—— 用来演示「加载更早的」那一颗。 */
export const MORE = [
  {
    id: 'a-21', kind: 'asset', status: 'done', type: '图片',
    prov: 'FLUX.1', model: 'flux.1-dev', prompt: '旧校服 · 挂在椅背上',
    ts: '2026-10-15T16:20', size: 1822110, dur: 0, fmt: 'png',
    local: true, fav: false, credits: 1, img: 'assets/char-linwan.jpg', pos: '50% 60%',
    dims: '1536×1024', task: 'task_10b5e6', refs: 0,
  },
  {
    id: 'a-22', kind: 'asset', status: 'done', type: '视频',
    prov: '海螺', model: 'hailuo-02', prompt: '走廊 · 灯管明灭的一瞬',
    ts: '2026-10-14T20:08', size: 4102880, dur: 6, fmt: 'mp4',
    local: false, fav: false, credits: 6, img: 'assets/scene-classroom.jpg', pos: '50% 35%',
    dims: '1920×1080', task: 'task_31c7a9', refs: 0,
  },
  {
    id: 'a-23', kind: 'asset', status: 'done', type: '图片',
    prov: 'Midjourney v7', model: 'mj-v7', prompt: '天台 · 黄昏的第一张测试稿',
    ts: '2026-10-13T13:47', size: 2904533, dur: 0, fmt: 'png',
    local: true, fav: false, credits: 3, img: 'assets/scene-rooftop.jpg', pos: '50% 20%',
    dims: '1536×2048', task: 'task_6b90d2', refs: 0,
  },
];
