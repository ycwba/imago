/* ============================================================================
   drama.js —— 拍短剧（公共模块，全站唯一实现）
   ----------------------------------------------------------------------------
   一部短剧 = 一段故事 → 分场剧本 → 角色与场景 → 一段段拍出来 → 拼成整集。
   这里是「拍短剧」页面（drama.html）背后的全部业务逻辑，页面只管画界面与接事件。

   四个关键能力（都放在这一份，页面不许各写一套）：
     Drama.store  短剧数据的读写（Store + 云同步键）
     Drama.lib    素材库：脸 / 声音 / 角色资产，跨剧复用
     Drama.subs   字幕组件：台词 → 字幕轨（播放器叠加 + SRT 下载 + 交给 ffmpeg 烧录）
     Drama.pipe   流水线：拆剧本 / 画脸 / 配音 / 拍这一段 / 出成片

   拍完一条只有两种结局：**出了画面**（done）或**平台报错/素材没送上去**（failed）。
   「拍出来像不像那个角色」**不由本项目判断** —— 界面只如实报平台给了什么画面、报了什么错，
   要不要再来一条由用户点。

   字幕**不是**视频平台生成的（那边出的片子不带字幕）——台词由本模块排成字幕轨，
   播放时叠在画面上，导出时交给本机 ffmpeg（proxy.js 的 /render 烧 ass 滤镜）烧进去。
   ========================================================================== */
window.Drama = (function () {
  'use strict';

  /* ---------- 存储键（都在 ui.js 的 SYNCABLE 白名单里，跟着云同步走）---------- */
  const K_DRAMAS = 'dramas';            // 全部短剧
  const K_CHARS = 'drama_chars';        // 素材库（跨剧复用，不随某一集清掉）
  const K_ACTIVE = 'drama_active';      // 当前打开的短剧 id
  const CAP_DRAMAS = 40, CAP_CHARS = 300;
  /* 一份素材身上最多留几张候选图（预览图与各类设定图共用这一条上限）：
     这是**本机留着挑的张数**，不是平台一次能出几张 —— 一次出几张看设置里的「候选张数」与
     `max_outputs` 声明（previewCap）。上限取 8：设置页那一档最大就是 8，
     上限比它小就会出现「我设了 8、界面上只有 4 格」。 */
  const FACE_CAP = 8;
  /* 一条角色身上最多留几条**声音**候选（同一句台词合成几条让你试听挑）。
     声音没有 `max_outputs` 那类声明，所以一次能出几条要另算（见 Pipe.voiceCap）：
     预设音色那位看这一型号声明的音色清单有几把，描述 / 复刻那位没有清单，只按这个上限多试几遍。
     同样跟设置里的「候选张数」走（默认 3），上限留 8。 */
  const VOICE_CAND_CAP = 8;

  /* ---------- 小工具 ---------- */
  const uid = p => (p || 'd') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => window.esc(s);          // 唯一实现在 ui.js
  /* 图标同理：几何只有 ui.js 的 ICONS 一份，本文件不手写任何 path。
     默认带 `<span class="ic">` 外壳（ui.css 那条 :where(button,…) .ic 靠它消掉
     SVG 的 baseline 缝）；只有嵌进已有外壳时才传第三个参数 1。 */
  const ic = (name, size, bare) => {
    const s = window.icon(name, size);
    return bare ? s : '<span class="ic">' + s + '</span>';
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const nowTs = () => Date.now();
  function read(k, def) { try { return (window.Store && Store.read) ? Store.read(k, def) : def; } catch { return def; } }
  function write(k, v, cap) {
    if (!(window.Store && Store.write)) return { ok: false, error: '存储不可用' };
    return Store.write(k, v, { cap });
  }

  /* ============================================================================
     一、数据模型
     ========================================================================== */

  /* 整集时长：界面上是**下拉档位**（DUR_PRESETS 这些常用档），选到「自定义…」才给分钟数字框。
     **画风与单段时长不在界面上选** —— 交给文字 AI 按剧本内容自己决定（每段各写 style 与 wantSec），
     整集时长它也允许按剧情密度改一个数（见 normalizeScript 采纳 AI 回的 duration）。
     **画幅 / 分辨率 / 单段时长的可选档位不在这里写死** —— 一律按视频模型自己声明的取值来
     （`videoChoices` / `videoCaps`，兜底表只有 FALLBACK_RATIOS 那一份）。 */
  const DUR_PRESETS = [60, 120, 180, 300];      // 秒；芯片上的分钟数由它现算
  const DUR_MAX_SEC = 1800;                     // 30 分钟：再长就是几十上百段，这一页会被自己的任务队列拖死
  const DUR_FALLBACK_MIN = 4;                   // 没有视频平台时的兜底下限（有平台一律用它声明的最短一档）
  /* 下限跟着视频平台声明走：整集比「一段」还短就没法拍 */
  function durationBounds(REG, opts) {
    const v = videoOf(REG || { providers: [] }, opts && opts.videoModel);
    const durs = (((v && v.model.options) || {}).durations || []).map(Number).filter(x => x > 0);
    return { min: durs.length ? Math.min.apply(null, durs) : DUR_FALLBACK_MIN, max: DUR_MAX_SEC };
  }
  /* 界面输入分钟（用户说的是「这一集大概多少分钟」），数据里一律存秒 */
  function durationFromMinutes(m, bounds) {
    const b = bounds || { min: DUR_FALLBACK_MIN, max: DUR_MAX_SEC };
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) return b.min;
    return clamp(Math.round(n * 60), b.min, b.max);
  }
  const durationMinutes = sec => round2((Number(sec) || 0) / 60);
  /* ---------- 这一页的设置项：默认值与取值只在这里点一次名 ----------
     界面上的文案（「AI 会自己改时长」「让 AI 定音色」）与**真的发给 AI 的那份参数**必须同一份判据 ——
     各写一份就会出现「提示说会、其实没发」。设置页也照这张表渲染控件（§2 能力/声明驱动）。 */
  const SET = {
    durMin: { key: 'dr_dur_min', kind: 'num', def: '1', label: '新一集的整集时长（分钟）',
      hint: '只是目标：AI 拆剧本时觉得这个长度装不下（或只能靠空镜凑）会自己改一个数' },
    aiDur: { key: 'dr_ai_dur', kind: 'bool', def: '1', label: '让 AI 按剧情自己改整集时长' },
    aiVoice: { key: 'dr_ai_voice', kind: 'bool', def: '1', label: '让 AI 给角色定音色（性格 → 音色描述 / 复刻）' },
    /* 音色方式（2026-10 用户要求：「不应该使用固定音色的模型让我选择音色」）：
       默认 auto = 自动挑**这一家最好的那一种**，顺序是生成音色 > 音色复刻 > 预设音色。
       换一家只有预设型号的语音平台时，auto 落到预设上并照实说明，
       而不是把一排固定音色摆出来让人猜哪个像。 */
    ttsMode: { key: 'dr_tts_mode', kind: 'opt', def: 'auto', label: '音色怎么定',
      hint: '默认「自动」：优先用生成音色的模型（按角色外貌与性格写一段描述，那把嗓子由模型现造）。只有这一家没有这类型号时才退回预设音色。',
      options: [{ id: 'auto', label: '自动（优先生成音色）' }, { id: 'design', label: '按描述生成音色' },
        { id: 'clone', label: '复刻参考音频' }, { id: 'preset', label: '从固定音色里挑' }] },
    inherit: { key: 'dr_next_inherit', kind: 'opt', def: 'all', label: '做下一集时默认沿用什么',
      options: [{ id: 'all', label: '角色 + 场景' }, { id: 'char', label: '只沿用角色' }, { id: 'none', label: '全新（都不沿用）' }] },
    /* 重拍上限以前写死在 newDrama 的 opts 里（dr.opts.maxTakes），界面上一个控件都没有，
       而 tooltip、拍片记录与批量拍摄三处都拿它当「最多几次」的承诺 —— 说了却改不了。
       搬进设置项之后：设置页照这张表自动渲染控件，AI 助手也自动能改，页面上只管读。 */
    maxTakes: { key: 'dr_maxtakes', kind: 'num', def: '3', unit: '次', step: '1', label: '每段最多重拍几次',
      hint: '每次重拍都是一条真任务、单独计费；拍坏了的那次可以在「拍片记录」里删掉再拍' },
    /* 候选张数（2026-10 按用户要求加回）：角色、场景、道具**一次出几张**让你挑，机位候选同一档。
       它是**下限**，实际张数由两个数取小的那个：
         ① 这个设置（这里，1~8）；
         ② 这一次用的生图型号声明的 `max_outputs`（`previewCap`）——
            上游只让一次出一张时，摆 3 个格子也没用，界面上照实说是 1 张。
       一次出 3 张 = 3 倍的钱，所以默认值取 3（够挑、又不像「再出 4 张」那么肉疼），
       想要更省就改 1（等于回到只出一张、挑不了）。 */
    candN: { key: 'dr_cand_n', kind: 'num', def: '3', unit: '张', step: '1', min: '1', max: '8',
      label: '角色 / 场景 / 道具 一次出几张候选',
      hint: '画一次就多一张的钱；实际张数还要看生图平台一次能让出几张（上游只让出一张时就只能出一张）' },
    /* 机位候选出几张：机位图是**每段单独**画的，段数一多就是段数 × 这个数，
       所以默认比素材候选少（3 张够挑方向），并在界面上写明会乘以段数。 */
    camN: { key: 'dr_cam_n', kind: 'num', def: '3', unit: '张', step: '1', min: '1', max: '9',
      label: '机位一次出几张候选',
      hint: '机位是**每一段**单独出的：8 段的片子 × 3 张 = 24 张的钱。只想看看构图就不出，想挑就调大' },
  };
  /* 「这一次要出几张候选」：**判据只有这一处**（页面按钮文案、生图提交、界面上标的上限都读它）。
     夹到 `previewCap`（上游声明的上限）—— 请求一个上游只让出 1 张的模型出 3 张，
     要么被拒、要么只回 1 张，界面上写 3 就是骗人。 */
  function candCount(REG, opts, id, model) {
    const want = Math.round(Number(setting(id || 'candN'))) || Number(SET.candN.def);
    /* 型号没给就自己按这一集选的生图接口挑一个（与 drawPreview 同一个 pickProvModel）——
       页面要显示「再画 3 张」那个数字时手里只有 REG 与 opts，不该自己再写一遍挑法。
       连生图平台都没配时 previewCap(undefined) = 1，界面照实显示 1 张。 */
    let m = model;
    if (!m) {
      const v = pickProvModel(REG || { providers: [] }, 'image', (opts || {}).imgModel, 'text_to_image');
      m = v && v.model;
    }
    return Math.max(1, Math.min(want, previewCap(m)));
  }
  function setting(id) {
    const it = SET[id]; if (!it) return '';
    let raw = null;
    try { raw = localStorage.getItem(it.key); } catch { return it.def; }
    return raw == null || raw === '' ? it.def : raw;
  }
  const flagOn = id => setting(id) !== '0';
  /* 新建一集时的默认整集长度：读设置里那个分钟数，再按视频平台声明的档位夹一下 */
  function defaultDuration(REG, opts) {
    return durationFromMinutes(setting('durMin'), durationBounds(REG, opts));
  }
  const aiDurOn = () => flagOn('aiDur');
  const aiVoiceOn = () => flagOn('aiVoice');
  const nextInherit = () => setting('inherit');
  /* 「这一段最多重拍几次」—— 一个数，页面上四处（tooltip / 拍片记录 / 拍摄循环 / 助手快照）都读它。
     换算照 durationFromMinutes 那套：不是个 ≥1 的数就当没配过，回 SET 里声明的默认值。 */
  const maxTakes = () => { const n = Number(setting('maxTakes')); return Number.isFinite(n) && n >= 1 ? Math.round(n) : Number(SET.maxTakes.def); };
  const candN = () => { const n = Number(setting('candN')); return Number.isFinite(n) && n >= 1 ? Math.round(n) : Number(SET.candN.def); };
  const camN = () => { const n = Number(setting('camN')); return Number.isFinite(n) && n >= 1 ? Math.round(n) : Number(SET.camN.def); };
  const ROLE_SOURCES = [
    { id: 'new', label: '全新角色' },
    { id: 'lib', label: '从素材库选' },
  ];
  const TIME_OFS = [{ id: '深夜', label: '深夜' }, { id: '白天', label: '白天' }, { id: '黄昏', label: '黄昏' }, { id: '清晨', label: '清晨' }];

  function newDrama(o) {
    o = o || {};
    return {
      id: uid('m'),
      title: o.title || '未命名短剧',
      story: o.story || '',
      opts: Object.assign({
        /* style 留空 = 画风由文字 AI 按剧本自己决定（每段各写一条 shot.style） */
        style: '', ratio: '9:16', res: '', duration: 60, roleSource: 'new',
        /* 入口页「从素材库选」里点名要用的那批素材 id。空 = 不点名，整个库都作为候选列给 AI。 */
        libPick: [],
        /* quality 原来在这里占一个位、每次拍摄都当 `quality: ''` 发出去。它从来没有写入点，
           而 `Api.createBody` 会把空串丢掉（`v !== ''`），所以它**从来没到过平台** ——
           一个看着像「画质档」其实什么都不做的字段。画质由 res（分辨率）承载，没有独立的质量档。 */
        videoModel: '', imgModel: '', ttsModel: '',
    /* 音色方式：'' = 跟设置项 `dr_tts_mode`（默认 auto = 优先生成音色）。
       写在 opts 上是为了**逐集**也能改 —— 同一个项目里可能有一集就是全用同一位配音演员。 */
    ttsMode: '',
        /* 重拍上限不在这里：它是一个设置项（SET.maxTakes / dr_maxtakes），页面上有控件可改。
           点一次「拍这一段」只发一条任务 —— 不自动重试：重拍是花钱动作，没有替用户点第二次的道理。 */
        bgm: '', subFont: 'Microsoft YaHei',
        manual: false,        // true = 不靠 AI 拆剧本，角色/场景/分段自己排
        autoFace: true,       // false = 「认角色」不替用户画脸，等他自己挑或上传
        autoScene: true,      // false = 不替用户画场景图
        /* 道具图有**自己一格**开关（2026-10，用户拍板）。以前它跟场景共用 autoScene：
           界面上「场景图」那行写着自动、实际连道具一起画，关掉也一起关 ——
           三个键管两件事，用户想「自动画场景但道具自己挑」根本做不到。
           旧短剧没有这个键时按「自动」算（页面 autoOn() 判的是 `!== false`），不用迁移。 */
        autoProp: true,
        /* 导出成片时的两个开关（都默认要）。它们只改**送给代理的 EDL**，不改预演、也不改下载的 SRT ——
           预演始终是「画面 + 配音 + 字幕」，字幕文件始终是完整的台词。 */
        dub: true,            // 把逐句配音混进成片
        sub: true,            // 把字幕烧进成片
      }, o.opts || {}),
      /* props = 道具（2026-10）。它与 characters / scenes 平级，但**只在拍摄时被读**：
         道具的图进 planMaterials 的参考图，名字与描述进这一段的提示词。
         读的一律带 `|| []`（老库里没有这个键），所以旧短剧不用迁移。 */
      characters: [], scenes: [], props: [], shots: [],
      step: 1,                          // 1 讲故事 / 2 认角色 / 3 看预演 / 4 拍成片
      cover: '', finalVideo: '', finalName: '',
      createdAt: nowTs(), updatedAt: nowTs(),
    };
  }

  /* 角色：kind='actor' 出镜，kind='narrator' 只出声（旁白）。
     素材库里的条目有「角色 / 场景 / 道具」三种（见下面 LIB_KINDS），旁白是角色的一种出声方式。 */
  function newChar(o) {
    o = o || {};
    return {
      id: uid('c'),
      name: o.name || '新角色',
      kind: o.kind || 'actor',                 // actor | narrator（库条目：actor | scene）
      voiceOnly: !!o.voiceOnly,                 // 库里存的「这一位只出声」：拉进某一集时还原成 narrator
      group: String(o.group || '').slice(0, 20), // 素材分组：整组一起交给 AI 用（库与剧侧都带）
      bio: o.bio || '',                         // 一句话人设
      look: o.look || '',                       // 外貌（画脸与一致性都用它）
      /* faces 字段**留着但不再攒了**（2026-10）：老库里存着的那几张还在，
         界面上不再有候选排也就不再往里加 —— 这个字段现在只作为「读老数据」的容器。
         出预览图一律 count:1，主图直接写 face / img。 */
      faces: Array.isArray(o.faces) ? o.faces : [],   // [{src, name}] 老的多张候选（只读）
      face: o.face || '',                       // 选中的那张（预览图 + 传给生图/生视频 AI 的脸）
      /* 角色资产：一个列表，每张有类型与关联道具 ——
         [{ id, kind:'three'|'expr'|'costume'|'custom', src, note, propIds:['p1'] }]。
         2026-10 之前是 `{ three: src, … }` 那种「每类只能一张」的字典；老数据不删，
         读的那一处（`Cast.assetsOf`）见到字典会现算成列表。这里只在**新建**时归一，
         存着的旧对象在下次被改动时也会被 assetsSave 改写成列表。 */
      assets: assetsOf({ assets: (o && o.assets) || {} }),
      assetCands: o.assetCands || {},           // 每类资产的其余候选：{ three: [{src}], … }，挑中才写进 assets
      voice: o.voice || '',                     // 预设音色 id（preset 型号用）
      voiceName: o.voiceName || '',
      voiceNote: o.voiceNote || '',             // 音色描述（design 型号用）
      voiceMode: o.voiceMode || '',             // 这一位用哪种方式定声音：'' = 跟界面上选中的语音型号，preset/design/clone
      voiceBy: o.voiceBy || '',                 // 'ai' = 这一位的声音是「让 AI 定音色」写上的（界面要标出来，人可以直接改）
      refAudio: o.refAudio || '',               // 参考音频（本机资产地址，clone 型号用它做音色复刻）
      refAudioName: o.refAudioName || '',
      voiceCands: Array.isArray(o.voiceCands) ? o.voiceCands : [],   // 一次合成几条候选试听：[{voice, name, src, dur}]，挑中才写 voice
      /* 自动定音色的两条留痕（`autoVoice` 写）：`voiceErr` 是**没定成的原因**，
         `voiceAuto` 是定成的那句摘要。缺了 voiceErr，一次失败在界面上就是无声消失，
         用户只能看到第 4 步卡在「还没配声音」，不知道是没配语音平台还是 AI 没给方案。 */
      voiceErr: o.voiceErr || '',
      voiceAuto: o.voiceAuto || '',
      inLib: !!o.inLib,                         // 是否已存进素材库
      libId: o.libId || '',
    };
  }
  function newScene(o) {
    o = o || {};
    /* kind='scene' 显式写出来：库里「同类型 + 同名才算同一条」的合并判据要靠它，
       以前场景对象只有 desc / time 两个字段可猜 —— 一建出来就被 libKindOf 认成角色，
       于是整组加入时场景跑进了角色名单。 */
    return { id: uid('s'), kind: 'scene', name: o.name || '新场景', desc: o.desc || '', img: o.img || '',
      /* 场景也有「多角度 / 时段 / 陈设」这些设定图（库里存进 assets / assetCands 两个字段），
         字段不在对象上就会出现「出了图、回库里找不到那张备选」。 */
      assets: assetsOf({ assets: (o && o.assets) || {} }), assetCands: o.assetCands || {},
      time: o.time || '深夜', group: String(o.group || '').slice(0, 20) };
  }
  /* 道具（2026-10，与角色 / 场景平级的第三种类型）：
     字段沿用库那套（look = 描述、face = 预览图），**不**有声音、不有时段、没有资产子项 ——
     道具只有一张图就是它自己，表情表与服装那一套对它没有意义。
     `id` 前缀用 'p'：库里「同类型 + 同名才算同一条」的合并判据靠 libKindOf，不靠前缀，
     但前缀不同能在 log / 报错里一眼看出这条是哪一类。 */
  function newProp(o) {
    o = o || {};
    return { id: uid('p'), kind: 'prop', name: o.name || '新道具',
      look: o.look || '',                                  // 道具描述（出图就靠它）
      bio: o.bio || '',                                     // 一句话用途（发给文字 AI）
      face: o.face || '',                                   // 预览图（出图或自己传）
      group: String(o.group || '').slice(0, 20),
      faces: Array.isArray(o.faces) ? o.faces : [],
      assets: o.assets || {}, assetCands: o.assetCands || {},
      inLib: !!o.inLib, libId: o.libId || '' };
  }
  /* 一段（= 剧本里的一个场次） */
  function newShot(o) {
    o = o || {};
    /* 「是不是第 1 段」两个入口：`no`（调用方已经知道段号）或 `at`（只知道自己在数组里的下标）。
       **两者都不给时一律按第 1 段算** —— 以前只有 `no`，而 duplicateShot 建副本时不传 `no`
       （位置要等 splice 完由 resequence 定），于是 `(o.no || 1) === 1` 恒成立：
       「复制写法」明明把 link 一起照抄了，出来的副本却一律 `off`（不接上一段末帧），
       而它落在 i+1、上面明明有上一段。 */
    const first = o.at == null ? (o.no || 1) === 1 : (o.at === 0);
    return {
      id: uid('h'),
      no: o.no || 1,
      title: o.title || '第 1 段',
      sceneId: o.sceneId || '',
      time: o.time || '深夜',
      style: o.style || '',                     // 这一段的画风（文字 AI 按剧情决定，界面上不预先选）
      /* auto 同场景自动接上一段末帧 / off 各拍各的（可并发）。
         **第 1 段一律 off**：它没有上一段可接，这个标记对它什么也不改变 ——
         但留在数据里就制造了两边不一致（拍摄链路只对 k>0 取帧，而它写着 auto），
         界面与数据各说各的。默认值只在这里定一次，页面与拍摄循环都按「有没有上一段」判。 */
      link: first ? 'off' : (o.link || 'auto'),
      chars: Array.isArray(o.chars) ? o.chars : [],   // 出场角色 id
      lines: Array.isArray(o.lines) ? o.lines : [],   // [{who, whoId, text}] 台词
      shots: Array.isArray(o.shots) ? o.shots : [],   // [{desc, camera, sec}] 镜头
      openDesc: o.openDesc || '',                      // 开头画面描述（画首帧用）
      startImg: o.startImg || '', endImg: o.endImg || '',
      /* `openNote` 是**警告**不是失败：开头画面画出来了，只是「参考图没能发给生图 AI」
         「这个型号没有参考图槽位」这类（图可能与场景图 / 角色脸对不上）。
         与 `openErr` 分开存 —— 混在一起的话界面只有一种语气，要么把警告说成失败、要么把失败说成还行。 */
      openErr: o.openErr || '', openNote: o.openNote || '',
      /* 机位候选（2026-10）：`camCands` 是一次出 N 张的构图图 + 各自那个机位的画面描述，
         `camShot` 是用户挑中的那一张 —— 它会跟着这一段的参考图发给视频 AI，
         于是「在候选里挑的构图」与「拍出来的那一镜」是同一个，而不是只在文字里像。 */
      camCands: Array.isArray(o.camCands) ? o.camCands : [],
      camShot: o.camShot || '', camErr: o.camErr || '', camNote: o.camNote || '',
      refImgs: Array.isArray(o.refImgs) ? o.refImgs : [],
      wantSec: o.wantSec || 8,
      takes: [],                          // 每次「拍」出来的一条
      chosen: '',                         // 选用了哪一条
    };
  }
  /* 一次拍摄（take）：视频、配音与字幕都挂在它下面 */
  function newTake(o) {
    o = o || {};
    return {
      id: uid('t'), no: o.no || 1,
      state: o.state || 'pending',   // pending 排队 / dubbing 配音在跑 / shooting 拍中 / dubbed 只配了音（还没画面）/ done 出了画面 / failed 没成
      stage: o.stage || '',
      applied: null,                 // 这一次实际发出去的参数（对齐后的档位 + 真的发出去的素材用途名 `mats`），界面上照实显示
      taskId: '', taskProvider: '',  // 视频平台的任务号
      video: '', videoUrl: '',
      linkFrame: o.linkFrame || '',    // 上一段自动取的最后一帧（本机资产地址）；空 = 用本段开头画面
      /* linkFrame 是**一张图**，看不出它是哪一次拍的末帧 —— 于是「上一段重拍过，后面那几段
         还接着旧的末帧」这件事谁也查不出来（画面上接不接得上只能靠肉眼，成片里一点提示都没有）。
         记下**来源那一次的 id**，staleChains 才能判出来。 */
      linkFrom: o.linkFrom || '',
      notes: Array.isArray(o.notes) ? o.notes : [],   // 非致命的实拍说明（如参考图超上限被挤掉）
      lines: [],                     // [{who, text, audio, dur, start, end}] 这一条带的配音与字幕
      error: '',
      createdAt: nowTs(),
    };
  }

  /* ============================================================================
     二、短剧存储
     ========================================================================== */
  /* 老数据里停在 `state:'qc'` 的那一条 = 「视频平台已经出了画面，正准备让文字 AI 看一眼」。
     那一整套已经删掉了，可这条还按「在等」对待：`runningTakes` 收它、`resumeTake` 因为
     没有「正在质检」那条分支而去问平台，于是刷新一次就白问一次，界面上永远停在「质检中」。
     它其实**已经有画面了**（走到 qc 这一步说明 waitVideo 成功返回过），所以归一成 done；
     没有画面的那种仍然算失败（用户看不到成片）。`take.qc` 一并删掉，别让旧结论留在盘上冒充现状。 */
  function fixTakes(d) {
    let n = 0;
    for (const sh of ((d && d.shots) || [])) {
      for (const t of ((sh && sh.takes) || [])) {
        if (!t) continue;
        if (t.qc) { delete t.qc; n++; }
        if (t.state === 'qc') {
          const hasVideo = !!(t.videoUrl || t.video);
          t.state = hasVideo ? 'done' : 'failed';
          t.stage = hasVideo ? '完成' : '失败';
          if (!hasVideo && !t.error) t.error = '这一条没留下画面（以前拍到一半就断在这里了）';
          if (hasVideo && !(sh.chosen)) sh.chosen = t.id;
          n++;
        }
      }
    }
    return n;
  }
  function list() { const xs = read(K_DRAMAS, []) || []; for (const d of xs) fixTakes(d); return xs; }
  /* 把停在「配音中」的 take 结算回真实状态 —— 只在**页面刚打开**时调（见 `drama.html` 的 `boot`）。
     判得准是因为那一刻本机不可能有配音在跑：`resumePending` 只认带 `taskId` 的那几条，
     而配音是同步合成、没有任务号。正在跑的那一轮由 `dubShot` 自己在收尾时落终态，用不着这里。
     要结算的是历史上留下来的两种：配音跑到一半关掉页面、以及「`dubShot` 收尾没写终态」那一版留下的。 */
  function settleStuckDubbing() {
    if (listBroken()) return 0;   // 读不出来就别拿这份空清单当底座写回去（见 put 那一段）
    const xs = list();
    let n = 0;
    for (const d of xs) {
      for (const sh of ((d && d.shots) || [])) {
        for (const t of ((sh && sh.takes) || [])) {
          if (!t || t.state !== 'dubbing' || t.taskId) continue;
          const has = !!(t.lines && t.lines.length);
          t.state = has ? 'dubbed' : 'failed';
          t.stage = '';
          if (!has && !t.error) t.error = '这一段配音没出来（上次配音跑到一半就断了）';
          n++;
        }
      }
    }
    if (n) saveList(xs);
    return n;
  }
  function saveList(xs) { return write(K_DRAMAS, xs, CAP_DRAMAS); }
  function get(id) { return list().find(d => d && d.id === id) || null; }
  /* list() 读不出来的时候**不能当成「本来就没有」**。
     Store.read 为了「别让一条脏数据卡死整页」，解析失败与「不是信封」都直接返回默认值 []；
     但 put 是拿 list() 的结果当写入底座的 —— 那一刻一次普通保存就会把
     「空列表 + 当前这一集」写回去，磁盘上还完好的其它短剧整批消失，且随 storage 钩子
     同步覆盖到 .data/dramas.json。原始值非空而读出来是空 = 读坏了，不是没有。 */
  function listBroken() {
    let raw = null;
    try { raw = localStorage.getItem(K_DRAMAS); } catch { return '本机存储读不出来（隐私模式？）'; }
    if (raw == null || raw === '') return '';
    let p = null;
    try { p = JSON.parse(raw); } catch { return '这份短剧数据在本机解析不了（可能写坏了）'; }
    const isEnv = p && typeof p === 'object' && !Array.isArray(p) && 'data' in p;
    /* 不是信封 = 旧格式（历史上存过裸值）。Store.read 对它也返回默认值，同样是「看起来没有」。 */
    if (!isEnv) return '这份短剧数据是旧格式（不是 { data, ts } 信封），现在读不出来';
    if (!Array.isArray(p.data)) return '这份短剧数据的结构不对（不是一串短剧）';
    return '';
  }
  function put(d) {
    const broken = listBroken();
    if (broken) {
      return { ok: false, error: broken + '：已停止保存，磁盘上原来的数据一个字没动。'
        + '先别在这个页面上操作（继续操作会拿空列表把它整批覆盖掉）；'
        + '到「设置」导出一次整包备份确认数据还在，再回来。' };
    }
    d.updatedAt = nowTs();
    const xs = list();
    const i = xs.findIndex(x => x && x.id === d.id);
    if (i >= 0) xs[i] = d; else xs.unshift(d);
    return saveList(xs);
  }
  /* 还在平台上跑的拍摄：dropTake 与 remove 共用这一份判据。
     记着 taskId 的那一份一旦没了，resumePending 就再也接不回来 —— 等于「钱花了、片子接不上」。 */
  function runningTakes(d) {
    const out = [];
    for (const sh of ((d && d.shots) || [])) {
      for (const t of ((sh && sh.takes) || [])) {
        if (t && t.taskId && !t.abandoned && t.state !== 'done' && t.state !== 'failed') {
          out.push({ no: sh.no, tno: t.no || 0, stage: t.stage || '在平台上跑着' });
        }
      }
    }
    return out;
  }
  function remove(id) {
    const xs = list();
    const d = xs.find(x => x && x.id === id) || null;
    const busy = d ? runningTakes(d) : [];
    if (busy.length) {
      return { ok: false, why: '这部短剧还有 ' + busy.length + ' 次拍摄在平台上跑着（'
        + busy.slice(0, 3).map(x => '第 ' + x.no + ' 段第 ' + x.tno + ' 次').join('、')
        + (busy.length > 3 ? ' 等' : '') + '）。'
        + '删掉之后任务号就接不回来了 —— 先在拍片记录里把那些「不等了」，或者等它们出结果。' };
    }
    const r = saveList(xs.filter(x => x && x.id !== id));
    if (read(K_ACTIVE, '') === id) write(K_ACTIVE, '');
    if (r && r.ok === false) return r;
    return { ok: true };
  }
  const activeId = () => read(K_ACTIVE, '') || '';
  const setActive = id => write(K_ACTIVE, id || '');

  /* ============================================================================
     二·五、段落列表本身的编辑（不涉及生成，纯数据）
     ----------------------------------------------------------------------------
     实际行为：`edlCheck` / `renderSpec` 按 `drama.shots` 的数组顺序拼成片，
     `sh.no` 是显示用的段号。四个函数都改数组，并在改完后 `resequence`（`no` = 下标 + 1）。
     三条增删移都按 **shot id** 定位，返回那一段改完之后在数组里的下标（页面自己的
     `shotIdx` 是数组下标，必须按返回值改回去）。
     ========================================================================== */
  function resequence(drama) {
    const xs = drama.shots || [];
    xs.forEach((sh, i) => { if (sh) sh.no = i + 1; });
    /* 第 1 段一律 `link:'off'` —— 它没有上一段可接。
       newShot 建出来时已经这么写了，但**上移/下移/复制**都会把一个 link=auto 的段挪到第一位，
       于是数据说「接上一段」、界面说「第 1 段没有上一段可接」（sideAct 里就是那一句），
       两边各说各的。判据只在这一处定，所以在这里补齐：任何改过顺序之后都成立。 */
    if (xs[0] && xs[0].link !== 'off') xs[0].link = 'off';
    return drama;
  }
  /* dir: -1 上移 / +1 下移。到头/到尾返回 {ok:false, why}，不静默什么都不做 */
  function moveShot(drama, id, dir) {
    const xs = drama.shots || [];
    const i = xs.findIndex(x => x && x.id === id);
    if (i < 0) return { ok: false, why: '这一段已经不在了' };
    const j = i + (dir < 0 ? -1 : 1);
    if (j < 0) return { ok: false, why: '这一段已经是第一段，上面没有了' };
    if (j >= xs.length) return { ok: false, why: '这一段已经是最后一段，下面没有了' };
    xs.splice(j, 0, xs.splice(i, 1)[0]);
    resequence(drama);
    return { ok: true, at: j };
  }
  /* 复制 = 复写「写法」（画面描述、台词、镜头、参考素材），**不带拍片记录**：
     每一次拍摄都是平台上真跑过的一条，混进新段落的记录里会让人以为已经拍过了。 */
  function duplicateShot(drama, id) {
    const xs = drama.shots || [];
    const i = xs.findIndex(x => x && x.id === id);
    if (i < 0) return { ok: false, why: '这一段已经不在了' };
    const src = xs[i];
    const copy = newShot({
      /* `at`：副本落在 i+1，绝不是第 1 段 —— 不给的话 newShot 会按「第 1 段」把它收成 off，
         「复制写法」照抄了 link 也会丢。 */
      at: i + 1,
      title: String(src.title || '新段').slice(0, 40) + '（副本）',
      sceneId: src.sceneId || '', time: src.time || '', style: src.style || '',
      link: src.link || 'auto', wantSec: src.wantSec || 8,
      chars: (src.chars || []).slice(),
      lines: (src.lines || []).map(l => ({ who: l.who || '', whoId: l.whoId || '', text: l.text || '' })),
      shots: (src.shots || []).map(k => ({ desc: k.desc || '', camera: k.camera || '', sec: Number(k.sec) || 3 })),
      openDesc: src.openDesc || '', startImg: src.startImg || '', endImg: src.endImg || '',
      refImgs: (src.refImgs || []).slice(),
    });
    xs.splice(i + 1, 0, copy);
    resequence(drama);
    return { ok: true, at: i + 1, shot: copy };
  }
  /* 删除只去掉这一集里的引用，**不动本机资产文件**（那些是用户存下来的产物，
     别的段落、收藏、资产库可能还在用）。调用方负责先问用户一句。 */
  function dropShot(drama, id) {
    const xs = drama.shots || [];
    const i = xs.findIndex(x => x && x.id === id);
    if (i < 0) return { ok: false, why: '这一段已经不在了' };
    /* 还在平台上跑的拍摄：与 dropTake / remove **同一份判据**（runningTakes）。
       以前这里不管，警告只写在确认框正文里 —— 删一次拍摄会拦、删整集会拦，唯独删一段不拦，
       于是「删掉还在跑的那一段」是最容易出事的那个。现在真拦，并说清下一步怎么走
       （先在拍片记录里按「不等了」，或者等它出结果）。 */
    const busy = runningTakes(drama).filter(b => b.no === xs[i].no);
    if (busy.length) {
      return { ok: false, why: '第 ' + xs[i].no + ' 段还有 ' + busy.length + ' 次拍摄正在平台上跑着（第 '
        + busy[0].tno + ' 次，' + (busy[0].stage || '在跑') + '）—— 删掉之后任务照样跑完、照样计费，'
        + '而这一边再也接不回它。先在拍片记录里把那些「不等了」，或者等它们出结果' };
    }
    xs.splice(i, 1);
    resequence(drama);
    /* 下一段还留着「上一段末帧」这张参考图：那段已经没了，接下去的画面会自己重排，
       但界面上要能从「靠上一段末帧」改成用本段开头画面，所以把标记清掉，别继续声称接得上。 */
    const nx = xs[i];
    if (nx) (nx.takes || []).forEach(t => { if (t && !t.video && t.linkFrame) t.linkFrame = ''; });
    return { ok: true, at: Math.min(i, xs.length - 1), removed: i + 1 };
  }
  /* 删掉一次拍摄（拍片记录里那一行的「删掉这次」）：同样**只去掉这一集里的这一次**，
     本机存下来的视频不动（收藏、资产库、别的段可能还在用）。删完剩下的重排 t.no。
     还在跑的那一次要先「不等了」（见 abandon）—— 直接删等于丢一次已付的钱。 */
  function dropTake(drama, shotId, takeId) {
    const sh = (drama.shots || []).find(x => x && x.id === shotId);
    if (!sh) return { ok: false, why: '这一段已经不在了' };
    const ts = sh.takes || [];
    const i = ts.findIndex(x => x && x.id === takeId);
    if (i < 0) return { ok: false, why: '这一次已经不在了' };
    const t = ts[i], no = t.no || i + 1;
    if (t.taskId && t.state !== 'done' && t.state !== 'failed' && !t.abandoned) {
      return { ok: false, why: '第 ' + no + ' 次还在拍（' + (t.stage || '任务在平台上跑着') + '）—— 先按「不等了」把它停下来再删' };
    }
    ts.splice(i, 1);
    ts.forEach((x, j) => { if (x) x.no = j + 1; });
    /* 删掉的正是选中的那一条：把 chosen 挪到还剩下的最后一条通过（没有就空着）。
       留着会指到一个不存在的 id，播放/导出时那一段就没画面了。 */
    if (sh.chosen === takeId) {
      const okT = ts.filter(x => x && x.state === 'done');
      sh.chosen = okT.length ? okT[okT.length - 1].id : '';
    }
    return { ok: true, at: Math.min(i, ts.length - 1), removed: no };
  }
  /* 「不等了」：拍片记录里正在跑的那一次，用户不想接着等了。
     原来只有两条出路 —— 等满 15 分钟，或者关掉网页（回来 resumePending 又要接着等）。
     这里做两件事：先按 registry 声明的 cancel 端点去平台那头撤单（撤不掉也照实说），
     再把这一次标成 abandoned：waitVideo 下一轮就收手、resumePending 也不再等它。
     **任务号留着** —— 撤单失败时它仍是一次真实存在的任务，留着才有机会在视频工作台里找到。 */
  async function abandon(REG, drama, shotId, takeId) {
    const sh = (drama.shots || []).find(x => x && x.id === shotId);
    if (!sh) return { ok: false, why: '这一段已经不在了' };
    const t = (sh.takes || []).find(x => x && x.id === takeId);
    if (!t) return { ok: false, why: '这一次已经不在了' };
    if (t.abandoned) return { ok: true, already: true, cancelled: false, note: '这一次已经不等了' };
    if (!t.taskId || t.state === 'done' || t.state === 'failed') {
      return { ok: false, why: '这一次已经出结果了，不用停' };
    }
    t.abandoned = true;
    t.state = 'abandoned';
    t.stage = '不等了';
    let cancelled = false, note = '';
    const prov = t.taskProvider ? Api.prov(t.taskProvider) : null;
    if (prov && prov.endpoints && prov.endpoints.cancel) {
      try { await Api.cancel(prov, t.taskId); cancelled = true; }
      catch (e) { note = '平台上撤不掉（' + ((e && e.message) || e) + '）—— 那条任务可能还在跑、也还可能计费，可以到视频工作台里看看'; }
    } else {
      note = '这家平台没有提供撤单接口，那条任务撤不掉、可能还在计费（可以到视频工作台里看看）';
    }
    return { ok: true, cancelled: cancelled, note: note, no: t.no || 0 };
  }
  /* 这一段在哪个场景：原来只由文字 AI 写（AI 认错场景时界面上没有自救路径），
     而场景决定提示词里的环境与人物出场。空 = 不指定（AI 拆出来的默认值就是第一个场景）。 */
  function setScene(drama, shotId, sceneId) {
    const sh = (drama.shots || []).find(x => x && x.id === shotId);
    if (!sh) return { ok: false, why: '这一段已经不在了' };
    const sid = String(sceneId || '');
    if (sid && !(drama.scenes || []).some(s => s && s.id === sid)) return { ok: false, why: '这一集里已经没有这个场景了' };
    sh.sceneId = sid;
    return { ok: true };
  }
  /* 要不要接上一段末帧：取值只有 AI 写的那两个（auto / off，认 chat 里 String(link).toLowerCase() === 'off'），
     别的值一律按 auto 收 —— 宁可接上，也不要因为一个脏值把链式调度悄悄关掉。 */
  function setLink(drama, shotId, link) {
    const sh = (drama.shots || []).find(x => x && x.id === shotId);
    if (!sh) return { ok: false, why: '这一段已经不在了' };
    sh.link = (link === 'off') ? 'off' : 'auto';
    return { ok: true };
  }

  /* ---------- 删一个角色 / 删一个场景（这一集里的） ----------
     同页的段、拍片、台词、整集都能删，唯独角色与场景只增不减：AI 拆出 8 个角色，
     其中「路人甲」不要了却无处可删，而重名校验又不许再加同名 —— 唯一的出路是回第 1 步重拆，
     把已经画好的 8 张脸、配好的音色全丢掉。**用户能撤回自己造成的结果**是硬要求。
     与 dropShot 同一条约定：只摘掉**这一集**里的引用，不动素材库那一条（那是跨剧复用的）。 */
  function dropChar(drama, id) {
    const cs = drama.characters || [];
    const i = cs.findIndex(x => x && x.id === id);
    if (i < 0) return { ok: false, why: '这一位已经不在了' };
    const name = cs[i].name || '（没起名）';
    cs.splice(i, 1);
    let shots = 0, lines = 0;
    for (const sh of (drama.shots || [])) {
      if (Array.isArray(sh.chars) && sh.chars.includes(id)) {
        sh.chars = sh.chars.filter(x => x !== id);
        shots++;
      }
      /* 台词的说话人下拉列的是**全集**角色：这位可能没在出场名单里、却在替别人念词。
         清掉 whoId 但**留着那句台词**（配音那一步会按名字落到旁白上），别连台词一起删。 */
      for (const l of (sh.lines || [])) {
        if (l && l.whoId === id) { l.whoId = ''; lines++; }
      }
    }
    return { ok: true, removed: name, at: Math.min(i, cs.length - 1), shots: shots, lines: lines };
  }
  function dropScene(drama, id) {
    const ss = drama.scenes || [];
    const i = ss.findIndex(x => x && x.id === id);
    if (i < 0) return { ok: false, why: '这个场景已经不在了' };
    const name = ss[i].name || '（没起名）';
    ss.splice(i, 1);
    /* 段上的场景清空：渲染时按「不指定」走（用这一段的文字描述），而不是留一个指不到的 id */
    let shots = 0;
    for (const sh of (drama.shots || [])) if (sh && sh.sceneId === id) { sh.sceneId = ''; shots++; }
    return { ok: true, removed: name, at: Math.min(i, ss.length - 1), shots: shots };
  }
  /* 删一件道具。它**没有** shot 级引用（不像角色挂在出场名单、场景挂在段上）——
     道具是整集一份，拍摄时 planMaterials 现算，所以这里只要把它从 props 里拿掉。
     段上的台词、场景、出场名单都不动：道具本来就不占那些位置。 */
  function dropProp(drama, id) {
    const ps = drama.props || [];
    const i = ps.findIndex(x => x && x.id === id);
    if (i < 0) return { ok: false, why: '这件道具已经不在了' };
    const name = ps[i].name || '（没起名）';
    ps.splice(i, 1);
    return { ok: true, removed: name, at: Math.min(i, ps.length - 1) };
  }

  /* ============================================================================
     三、素材库
     ----------------------------------------------------------------------------
     存进来的角色跨剧复用：脸、声音、三视图都跟着走。场景存描述、时段与那张图；
     道具（2026-10）存描述与它自己那一张图。
     不存也照常拍 —— 素材仍然属于这一集，只是删掉短剧时一起没了。
     ========================================================================== */
  /* ---------- 素材库的三种类型：角色 / 场景 / 道具 ----------
     库里不再有「旁白」这一种类型：旁白只是**某一集里**这位角色只出声，
     所以读库时归成「角色 + voiceOnly」，拉进某一集时再还原成 kind='narrator'（配音链路照旧）。
     场景与道具条目沿用角色的字段名（look = 描述、face = 预览图），
     进出某一集时才换成 scene 自己的 desc / img —— 两套名字只在下面那几个边界函数里换。
     **道具**（2026-10）是与角色、场景平级的第三种类型：它有自己的名字、描述与预览图，
     出图不靠别人的脸（照描述直接出），也没有表情 / 服装 / 三视图那一套 —— 只有一张图就是它自己。 */
  const LIB_KINDS = { actor: '角色', scene: '场景', prop: '道具' };
  /* 只在来源值非空时覆盖库值 —— 否则用户在库里手改的脸 / 音色会被「存进素材库」无声覆盖 */
  const nz = (v, base) => (v && String(v).length ? v : base);
  /* 候选列表（脸 / 设定图 / 声音）入库时的合并：**新的排在前面**、按 keyOf 去重、按上限裁掉。
     去重按内容而不是对象引用（库里每次读写都是新对象）；上限是全项目那两条（FACE_CAP / VOICE_CAND_CAP）。 */
  function mergeCands(fresh, old, cap, keyOf) {
    const key = keyOf || (x => x && x.src);
    const seen = new Set(); const out = [];
    for (const x of (Array.isArray(fresh) ? fresh : []).concat(Array.isArray(old) ? old : [])) {
      const k = x && key(x);
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(x);
      if (out.length >= cap) break;
    }
    return out;
  }
  /* 声音候选的去重键：**preset** 按音色 id 算（同一把嗓子不必并排两条），
     **design / clone** 按本机资产地址算 —— 那一位身上可能还留着上一代预设的 voice id，
     四条候选的 voice 一模一样，都按 voice 去重会把一批吸成一条。 */
  const voiceKey = x => (x ? ((x.mode || '') + '#' + ((x.mode === 'preset' ? x.voice : '') || x.src || '')) : '');
  function libKindOf(x) {
    /* 库条目自己存过 kind（`Lib.save` 每次都按它写）就**照它**，不要拿字段形状猜：
       猜的那套（`episodeKindOf`）认的是「有 desc / time 而没有 look」= 场景，而一条外貌还没填过的角色
       存进库时 `look` 是 undefined —— JSON 存盘会把这个键整个丢掉，读回来就「没有 look」了，
       于是它被认成场景：「加入这一集」把角色塞进 drama.scenes，
       而「同类型 + 同名才算重复」那道拦截也失效（库里能攒出两个一样的角色）。
       kind 只可能是 actor / scene / narrator（剧侧旁白），narrator 落到下面那行按形状判 —— 它带 look，判得出角色。 */
    if (x && (x.kind === 'scene' || x.kind === 'actor' || x.kind === 'prop')) return x.kind;
    return episodeKindOf(x) === 'scene' ? 'scene' : 'actor';
  }
  function voiceOnlyOf(x) { return !!x && (x.kind === 'narrator' || x.voiceOnly === true); }
  /* 「这一条是道具吗」——库条目与剧侧道具用同一个判据，不在两处各写一遍。
     走 libKindOf 就够了：它先认对象上存的 kind，认不到才按形状猜，而形状猜也只会猜出角色 / 场景。 */
  function isPropItem(x) { return libKindOf(x) === 'prop'; }
  /* 库条目 → 某一集里的角色对象 */
  function toEpisodeChar(src) {
    return { kind: voiceOnlyOf(src) ? 'narrator' : 'actor', name: src.name, group: src.group || '',
      bio: src.bio || '', look: src.look || '', face: src.face || '', faces: (src.faces || []).slice(0, FACE_CAP),
      /* 一次出多张设定图时的其余候选也要跟着带进这一集：只拷 assets 的话，
         库里那几「备选张」在这集里挑不到，等于界面上说「出了 4 张」而这里只有一张。 */
      assetCands: Object.assign({}, src.assetCands || {}),
      /* 资产走 assetsOf 归一：老库条目是 `{three: src}` 字典，库里新存的是列表，
         两边形状不一样 —— 直接 `Object.assign({}, src.assets)` 在列表形状下会把数组摊成
         `{"0":…}`，不报错，但每张图都读不到、界面上整格消失。 */
      assets: assetsOf({ assets: src.assets || {} }),
      voice: src.voice || '', voiceName: src.voiceName || '',
      voiceNote: src.voiceNote || '', voiceMode: src.voiceMode || '', voiceBy: src.voiceBy || '',
      /* 自动定音色那两条也一样跟着走：`voiceErr` 是「这一位为什么没声音」（没定成的要能带过来，
         否则拉进这一集就变成一位既没声音、界面也不说原因的角色）；`voiceAuto` 是定成的那句摘要。 */
      voiceErr: src.voiceErr || '', voiceAuto: src.voiceAuto || '',
      /* 声音候选也在拷贝清单里：漏了它，库里那几条试听拉进这一集就全没了，
         界面上一眼看得出「出过候选」，格子却是空的（§5 那类字段拷贝漏字段）。 */
      voiceCands: (src.voiceCands || []).slice(0, VOICE_CAND_CAP),
      refAudio: src.refAudio || '', refAudioName: src.refAudioName || '' };
  }
  /* 库条目 → 某一集里的道具对象。道具没有声音那一套，也不换字段名（库里就是 look / face，
     与剧侧道具同名）—— 所以它比角色 / 场景都简单，别照抄角色那份带一堆空字段。 */
  function toEpisodeProp(src) {
    return newProp({ name: src.name, look: src.look || '', bio: src.bio || '', face: src.face || '',
      group: src.group || '', faces: (src.faces || []).slice(0, FACE_CAP) });
  }
  /* 某一集里的角色 / 场景 → 库条目（存进素材库时按库的类型写，字段名换成库的那一套） */
  function toLibItem(x, kind) {
    if (kind === 'scene') {
      const o = Object.assign({}, x, { kind: 'scene', look: x.look || x.desc || '', face: x.face || x.img || '' });
      delete o.desc; delete o.img;            // 库里只认 look / face，留两份会各改一处不一致
      return o;
    }
    if (kind === 'prop') {
      /* 道具只带它自己的那几个字段：剧侧道具身上可能还挂着 inLib / libId 之外的东西，
         照 Object.assign 全量搬过去会让库里多出一堆这一类型根本不认的键。 */
      return { kind: 'prop', name: x.name, look: x.look || '', bio: x.bio || '', face: x.face || '',
        faces: (x.faces || []).slice(0, FACE_CAP), group: x.group || '' };
    }
    return Object.assign({}, x, { kind: 'actor', voiceOnly: voiceOnlyOf(x) });
  }
  /* 这一集里的这一条是角色、场景还是道具：场景有 desc 没有 look（AI 拆出来的那些字段都不全，所以两个都看） */
  function episodeKindOf(x) {
    if (!x) return 'actor';
    if (x.kind === 'scene' || x.kind === 'prop') return x.kind;
    return ('desc' in x || 'time' in x) && !('look' in x) ? 'scene' : 'actor';
  }

  /* 「这一种类型在这一集里的名单」——**只有这一份**：`inEpisode`（认重复）与 `pullInto`（放进去）
     都要按类型找对应的那一栏。写成 `kind === 'scene' ? scenes : characters` 那种三元，
     加第三种类型时**漏掉的那一支会静默落到 characters**：道具被当成角色塞进角色名单，
     然后它开始找音色、开始要求脸 —— 界面上看不出哪里错了。
     放在 Lib 里、认 kind 字符串，认不出的一律当角色（老数据没有 kind 时也不至于崩）。 */
  function episodePool(drama, kind) {
    if (!drama) return [];
    if (kind === 'scene') return (drama.scenes = drama.scenes || []);
    if (kind === 'prop') return (drama.props = drama.props || []);
    return (drama.characters = drama.characters || []);
  }

  /* 「库里这一条，在这一集里是不是已经有人」—— **只有这一份判据**（找不到返回 null）。
     `pullInto` 按它找人做合并；素材库挑选卡片上那个「已在本集」角标（`drama.html` 的 `inEp`）也按它判断。
     以前两边各写一遍 `libId || 同名`，今天恰好一致，所以看不出问题 —— 但只要一边加上
     「同名还要同类型」或别的信号，另一边就开始说谎，而那个角标恰恰是「要不要再挑一次」的判断依据。
     三种类型各查各的名单：libId 不会跨类型撞，名字会（角色「天台」与场景「天台」是两条）。 */
  function inEpisode(drama, src) {
    if (!drama || !src) return null;
    const pool = episodePool(drama, libKindOf(src));
    return pool.find(c => c && (c.libId === src.id || (c.name && c.name === src.name))) || null;
  }

  const Lib = {
    list() { return read(K_CHARS, []) || []; },
    /* 挂出来是因为页面要拿它判断卡片上那个「已在本集」角标 —— 同一份判据，
       别在 drama.html 里再写一遍 `libId || 同名`。找不到返回 null。 */
    inEpisode,
    save(char, o) {
      const xs = Lib.list();
      /* 同名 = 同一个人（与 pullInto 的合并规则同一套）：以前只按 id 认，
         「阿May 存了、改名再存、另一集又存一个阿May」会在库里越攒越多，
         而「加入这一集」到底进哪一位就没人说得清了。 */
      const byId = xs.findIndex(x => x && x.id === char.id);
      /* 同名合并还要**同类型**：库里可以有一个叫「天台」的角色和一个叫「天台」的场景，
         只看名字会把场景存成角色（或反过来），于是类型悄悄变了。 */
      const byName = byId < 0 ? xs.findIndex(x => x && x.name && x.name === char.name && libKindOf(x) === libKindOf(char)) : -1;
      const merge = byId >= 0 ? xs[byId] : byName >= 0 ? xs[byName] : null;
      /* 以库为底、剧侧只覆盖**非空**字段 —— 否则用户在库里手改的脸/音色会被
         「存进素材库」无声覆盖（库 → 剧 → 库 往返一圈，手改全丢）。
         但素材库页**就地编辑那一条**时必须照实写（`{exact:true}`）：
         在那里把分组清空、把描述删干净就是真的要清空，否则「改了没反应」。 */
      const ex = !!(o && o.exact);
      /* 空白一律落成 ''，不能留 undefined：`Store.write` 是 JSON 存盘，undefined 的键会被丢掉，
         于是读回来的那条**根本没有这个字段** —— 任何「这个键在不在」的判断（`libKindOf` 以前那套
         按形状猜类型）都会跟着翻；也让「这条素材有没有外貌」在库里/剧里两种答案。 */
      const keep = (v, b) => { const r = ex ? (v == null ? '' : v) : nz(v, b); return r == null ? '' : r; };
      const base = merge || {};
      const c = Object.assign({}, base, {
        id: base.id || uid('c'),
        savedAt: nowTs(),
        /* 名字与类型必须一起拷：这两个字段以前不在拷贝清单里，于是**第一次入库**
           （base 是空的）就丢了名字 —— 素材库页里建的角色显示成「(无名)」，
           而「同名 = 同一个人」的合并判据也跟着失效（name 为空时 byName 永远找不到）。 */
        name: String(char.name || base.name || '新角色').trim().slice(0, 20),
        /* 类型只有「角色 / 场景」两种：库里存过 narrator 的（旧的旁白类型）归成角色 + voiceOnly，
           拉进某一集时再还原。场景条目沿用 look / face 两个字段名（desc / img 在这里换掉）。 */
        kind: libKindOf(char),
        voiceOnly: ex ? voiceOnlyOf(char) : (voiceOnlyOf(char) || base.voiceOnly === true),
        group: String(keep(char.group, base.group) || '').trim().slice(0, 20),
        look: keep(char.look || char.desc, base.look),        // 角色=外貌 / 场景=场景描述
        face: keep(char.face || char.img, base.face),         // 预览图（两种类型都有）
        time: char.time || base.time || '',                   // 场景的光线时段
        bio: keep(char.bio, base.bio),
        voice: keep(char.voice, base.voice),
        voiceName: keep(char.voiceName, base.voiceName),
        voiceNote: keep(char.voiceNote, base.voiceNote),
        /* 「这一位用哪种方式定声音」也要入库：库里的小雅是复刻（带参考音频），
           拉进下一集时如果只拷了 mode 而没拷 refAudio，配音仍会按界面上选中的那个预设型号走 ——
           参考音频白存了。 */
        voiceMode: keep(char.voiceMode, base.voiceMode),
        /* 「这一位的声音是 AI 定的」那个标记也在拷贝清单里：以前只拷了 voice / voiceNote 而没拷 voiceBy，
           于是存进库、再拉回界面就看不出哪位是 AI 定的（那条「AI 定 ·」的标签整排消失）。 */
        voiceBy: keep(char.voiceBy, base.voiceBy),
        refAudio: keep(char.refAudio, base.refAudio),
        refAudioName: keep(char.refAudioName, base.refAudioName),
        // faces 和 assets 需要特殊处理：数组和对象要合并而非简单覆盖
        /* 去重要按 **src** 比：库里存的是 JSON，每次读写都是新对象，
           `new Set([...a, ...b])` 认引用不认内容，等于没去重 —— 往返几轮就攒出一排一样的脸，
           而「认角色」那一排候选格全是重复图。上限和画脸那边一致。
           **新出的那一批排前面**：以前是 base 在前，库里的 4 张一攒满，重画出来的那几张
           就被上限裁掉 —— 表现是「明明重画了、界面上还是原来那四张」。 */
        faces: mergeCands(char.faces, base.faces, FACE_CAP),
        /* 资产是**列表**了，不能再 `Object.assign({}, …)`（那会把数组摊成 {"0":…}，
           不报错但每张图都读不到、界面上整格消失）。走 assetsOf + mergeAssetLists：
           老字典会在 assetsOf 里现算成列表，两边形状不同也能合。 */
        assets: mergeAssetLists(assetsOf({ assets: base.assets || {} }), assetsOf({ assets: char.assets || {} })),
        /* 设定图的其余候选也必须进拷贝清单：不在拷贝清单里就等于「一次出 4 张」只有一张落进库，
           刷新后那几备选全消失（§5 里那类字段拷贝漏字段的坑）。按 kind 各并一组、按 src 去重。 */
        assetCands: (() => {
          const out = Object.assign({}, base.assetCands || {});
          const src = char.assetCands || {};
          for (const k of Object.keys(src)) out[k] = mergeCands(src[k], out[k], FACE_CAP);
          return out;
        })(),
        /* 声音候选同样要进库：只拷 char.voice 那一条的话，界面出了 4 条试听、刷新后只剩现在选中的那条。
           预设音色按「同一种方式 + 同一个音色」去重（重合成同一把嗓子不必并排两条），
           描述 / 复刻那一位没有音色 id，按本机资产地址各算一条。 */
        voiceCands: mergeCands(char.voiceCands, base.voiceCands, VOICE_CAND_CAP, voiceKey),
      });
      const i = merge ? (byId >= 0 ? byId : byName) : 0;
      if (merge) xs[i] = c; else xs.unshift(c);
      write(K_CHARS, xs, CAP_CHARS);
      return c;
    },
    get(id) { return Lib.list().find(c => c && c.id === id) || null; },
    /* 分组名单（素材页与拍短剧页都靠它渲染「整组」那一排）：按名字排，未分组不进来 */
    groups() {
      const m = new Map();
      for (const x of Lib.list()) {
        const g = String((x && x.group) || '').trim();
        if (!g) continue;
        m.set(g, (m.get(g) || 0) + 1);
      }
      return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    },
    ofGroup(name) {
      const g = String(name || '').trim();
      return Lib.list().filter(x => x && String(x.group || '').trim() === g);
    },
    remove(id) {
      // 删掉库里这一位时，清掉各集里指向它的标记 —— 否则「存进素材库」按钮
      // 永久 disabled 且显示「已在素材库」，用户看着像坏了。**三种类型都要清**。
      const xs = read(K_DRAMAS, []);
      let changed = false;
      for (const d of xs) {
        for (const arr of [d.characters || [], d.scenes || [], d.props || []]) {
          for (const c of arr) if (c && c.libId === id) { c.inLib = false; c.libId = ''; changed = true; }
        }
      }
      if (changed) write(K_DRAMAS, xs, CAP_DRAMAS);
      write(K_CHARS, Lib.list().filter(c => c && c.id !== id), CAP_CHARS);
    },
    /* 把一集里的角色 / 场景 / 道具收进素材库（页面上的「存进素材库」按钮）。
       找人的顺序 = 三种类型各查一次：id 在全集里唯一，但同一次查找要覆盖三栏，
       漏掉一栏就是「道具卡上的「存进素材库」点了没反应」。 */
    adopt(drama, id) {
      const c = (drama.characters || []).find(x => x && x.id === id)
        || (drama.scenes || []).find(x => x && x.id === id)
        || (drama.props || []).find(x => x && x.id === id);
      if (!c) return null;
      const saved = Lib.save(toLibItem(c, episodeKindOf(c)));
      c.inLib = true; c.libId = saved.id;
      return saved;
    },
    /* 整组收进库：一次把这一集的角色、场景与道具都存进某个组（素材页「分组」的入口） */
    adoptAll(drama, group) {
      const ids = [];
      for (const c of (drama.characters || [])) { Lib.adopt(drama, c.id); ids.push(c.libId); }
      for (const s of (drama.scenes || [])) { Lib.adopt(drama, s.id); ids.push(s.libId); }
      for (const p of (drama.props || [])) { Lib.adopt(drama, p.id); ids.push(p.libId); }
      if (group) for (const id of ids.filter(Boolean)) { const x = Lib.get(id); if (x) { x.group = group; Lib.save(x); } }
      return ids.length;
    },
    /* 把库里的素材拉进这一集：
       同名的**合并**（把库里的脸/音色/资产拷过去），不要加成第二个同名角色 ——
       短剧里出现两个「小雅」比少一个更糟。类型是「场景」的进 drama.scenes。 */
    pullInto(drama, libIds, opts) {
      /* o.force = 「从素材库刷新」那一下：库里那份**直接盖过**本集的这一位。
         默认那套只补本集没有的字段 —— 那是「加入这一集」要的（别把用户手动改的盖掉）。
         两套规则只在这个函数里分叉一次，字段清单还是同一份。 */
      const force = !!(opts && opts.force);
      const lib = Lib.list();
      const libById = new Map(lib.map(c => [c.id, c]));
      const out = [];
      for (const id of libIds || []) {
        const src = libById.get(id);
        if (!src) continue;
        /* 认「本集已经有这一位 / 这一个场景 / 这件道具」：判据只有 `inEpisode` 一份 —— 先按库 id，
           只按 id 认会造出两个「小雅」—— 这一集里 AI 拆出来的那位还没有 libId，
           从库里点一次「加入这一集」就多一位同名角色（而短剧里出现两个同名人比少一个更糟：
           台词按名字找人，永远说不清是哪一位）。放哪一栏同样只认类型（`episodePool`）。 */
        const kind = libKindOf(src);
        const isScene = kind === 'scene';
        const isProp = kind === 'prop';
        const pool = episodePool(drama, kind);
        const same = inEpisode(drama, src);
        if (same) {
          // 库里非空的值：force 时直接盖过，否则只补本集没有的那些（别覆盖用户手动改的）
          const take = (k, v) => { if (!v) return; if (force || !same[k]) same[k] = v; };
          if (isScene) {
            take('desc', src.look);
            take('img', src.face);
            take('time', src.time);
          } else if (isProp) {
            /* 道具只补它自己的那几个字段：声音那一路对它没有意义，拷过去只会让
               `toLibItem` 之后又原样带回来，看着像「道具也定了音色」。 */
            take('look', src.look);
            take('bio', src.bio);
            take('face', src.face);
            if (src.faces && src.faces.length && (force || !(same.faces || []).length)) same.faces = src.faces.slice(0, FACE_CAP);
          } else {
            take('look', src.look);
            take('bio', src.bio);
            take('face', src.face);
            if (src.faces && src.faces.length && (force || !(same.faces || []).length)) same.faces = src.faces.slice(0, FACE_CAP);
            if (!same.assetCands) same.assetCands = {};
            Object.assign(same.assetCands, src.assetCands || {});
            take('voice', src.voice);
            take('voiceName', src.voiceName);
            take('voiceNote', src.voiceNote);
            take('refAudio', src.refAudio);
            take('refAudioName', src.refAudioName);
            take('voiceMode', src.voiceMode);
            /* 「这一位的声音是 AI 定的」与那几条声音候选也照同一规则拷：只拷 voice 的话，
               拉进这一集就看不出是 AI 定的、候选那一排是空的（界面写着出过 4 条）。 */
            take('voiceBy', src.voiceBy);
            if (src.voiceCands && src.voiceCands.length && (force || !(same.voiceCands || []).length)) {
              same.voiceCands = src.voiceCands.slice(0, VOICE_CAND_CAP);
            }
            if (!same.assets) same.assets = {};
            Object.assign(same.assets, src.assets);
          }
          take('group', src.group);
          same.inLib = true; same.libId = src.id;
          out.push(same);
          continue;
        }
        // 新增：保持库里内容，只换本集用的 id 并打上库标记
        const c = isScene
          ? newScene({ name: src.name, desc: src.look || '', img: src.face || '', time: src.time || '深夜', group: src.group || '',
            /* 场景的多角度图 / 其余候选也要一起带进来：以前只搬了 name / desc / img，
               库里那一组设定图拉进这一集等于没拉（拍摄时 planMaterials 认的就是 assets）。 */
            assets: Object.assign({}, src.assets), assetCands: Object.assign({}, src.assetCands) })
          : isProp ? toEpisodeProp(src) : newChar(toEpisodeChar(src));
        c.inLib = true; c.libId = src.id;
        pool.push(c);
        out.push(c);
      }
      return out;
    },
    /* 整组拉进这一集（拍短剧页「这一组素材全给 AI」）：角色进 characters、场景进 scenes，
       返回值就是 pullInto 那份「真正加进来的条目」，调用方按 isSceneItem 自己分类。 */
    pullGroup(drama, name) {
      return Lib.pullInto(drama, Lib.ofGroup(name).map(x => x.id));
    },
    /* 已入库的那几位 / 那几个地方，库里那份与这一集**已经不是同一份**了：
       素材库页（chars.html）是就地编辑，写的是 drama_chars，不碰这一集的 dramas，
       于是用户在库里给「小雅」换了脸、给「河岸」改了描述，回到拍短剧看到的还是旧的那一份、
       拍摄时用的也是旧的。**角色与场景都要查** —— `adoptAll` 存进去的就是两类，
       提示条也摆在角色与场景之间，只查角色等于场景改了永远没人提醒。
       只比**会真的影响拍摄**的字段（角色：预览图 / 外貌 / 音色 / 音色描述 / 参考音频；
       场景：预览图 / 描述 / 时段），返回 [{item, libId, name, what}]：
       页面据此摆一行提示 + 一个「用库里那份」，刷新那一下走 pullInto(..., {force:true}) ——
       字段映射只有那一份，不在这里另写一遍。 */
    staleIn(drama) {
      const out = [];
      const byId = new Map(Lib.list().map(c => [c.id, c]));
      /* [显示名, 库里那个字段怎么取, 这一集里怎么取] —— 库侧永远是 face / look，
         剧侧角色是 face / look、剧侧场景是 img / desc（这一处差别只在 `Lib` 里换，别在页面判）。 */
      const PAIRS = {
        actor: [['预览图', s => s.face, s => s.face], ['外貌', s => s.look, s => s.look],
          ['音色', s => s.voice, s => s.voice], ['音色描述', s => s.voiceNote, s => s.voiceNote],
          ['参考音频', s => s.refAudio, s => s.refAudio]],
        scene: [['预览图', s => s.face, s => s.img], ['描述', s => s.look, s => s.desc],
          ['时段', s => s.time, s => s.time]],
        /* 道具同样要查：它进 planMaterials 的参考图，也进这一段的提示词 ——
           库里换了图而这一集还发着旧图，成片里那个物件就换了样。字段名与库侧一致（face / look）。 */
        prop: [['预览图', s => s.face, s => s.face], ['描述', s => s.look, s => s.look]],
      };
      const scan = (items, kind) => {
        for (const c of (items || [])) {
          if (!c || !c.inLib || !c.libId) continue;
          const src = byId.get(c.libId);
          if (!src) continue;
          const what = [];
          for (const [label, fromLib, fromDrama] of PAIRS[kind]) {
            const a = fromLib(src);
            if (a && a !== fromDrama(c)) what.push(label);
          }
          if (what.length) out.push({ item: c, libId: src.id, name: c.name || src.name || '', what: what });
        }
      };
      scan(drama.characters, 'actor');
      scan(drama.scenes, 'scene');
      scan(drama.props, 'prop');
      return out;
    },
  };

  /* ============================================================================
     四、字幕组件
     ----------------------------------------------------------------------------
     台词 → 字幕轨。字幕不是视频平台给的，是这里按「每句配音的真实时长」排出来的：
       · 播放器上叠一层（随 currentTime 切）
       · 导出时交给 ffmpeg 烧进画面（clips[].subs，时间**相对该段起点**，偏移由代理累加）
       · 还能单独下载 SRT
     旁白/角色名一起进字幕（参考产品就是这样：粉色旁白 + 白色角色名）。
     ========================================================================== */
  const CN_PER_SEC = 4.2;                      // 中文配音约每秒几个字（估时用）
  const LINE_GAP = 0.28;                        // 每句之间留一点空隙
  const RESUME_WAIT_MS = 2 * 60 * 1000;         // 续拍时最多等多久（超过就把决定权交回界面）

  function estDur(text) { return Math.max(0.8, String(text || '').replace(/[，。！？、,.!?\s]/g, '').length / CN_PER_SEC); }
  /* 这一段台词按字数估要念多久（句间空隙算进去，不含收尾）——
     「拍几秒的档位」与「界面上说几秒」必须同一个来源，各算一份就会两边数字不一样。 */
  function estLineSec(sh) {
    let n = 0;
    for (const l of ((sh && sh.lines) || [])) n += estDur(l.text) + LINE_GAP;
    return n;
  }
  const LINE_TAIL = 1.2;   // 念完之后留的收尾时间（选档位与界面显示都用它）
  /* 这一段台词实际念多久：这一条已经有真配音（take.lines[].dur 是合成回来的真实时长）
     就用真的，没有才按字数估。界面用它，别再自己数一遍字。
     **台词在拍完之后被改过时不能拿真配音来量**（lineDrift）：那串时长是**旧台词**的，
     而右栏摆着的是新台词 —— 于是「台词含收尾约 5 秒（按真实配音）」配着一屏新长出来的句子，
     「比平台最长的档还长，拍出来话会被截」那道闸也永远不会响。
     宁可给一个按字数估的数（并由 `from` 写明是哪一种），也不能拿旧台词的时长冒充新台词的；
     这么改还顺带和 shootFields 的档位吸附（一直按 estLineSec 算当前台词）对上了。 */
  function lineSec(sh, take) {
    let real = 0;
    if (!lineDrift(sh, take)) for (const l of ((take && take.lines) || [])) real += Number(l.dur) || 0;
    return {
      real: round2(real),
      est: round2(estLineSec(sh) + LINE_TAIL),
      from: real > 0 ? 'dub' : 'est',
      sec: round2(real > 0 ? real + LINE_TAIL : estLineSec(sh) + LINE_TAIL),
    };
  }

  /* 台词在拍完之后被改过没有 —— 这是**只读**判据，不花钱、不碰平台。
     配音与字幕都是**拍摄那一刻**的快照：dubShot 把每句真实的文本、音频与时间轴存进 take.lines[]，
     takeSubs/takeVoices 一律先读那份快照。所以用户拍完再改剧本，改的是 sh.lines，
     已经拍好的那一条里说、烧的仍是原来那几句 —— 而右栏摆着新的，中间一个字都没有提示。
     对不上时成片与下载的字幕都会用旧的（配音的时间轴只对旧文本成立，套不上新文本）。
     判据：**去掉空句之后，(说话人, 文本) 的序列对不上**。空句既不配音也不进字幕（dubShot 直接 continue），
     留着它比「少一句/多一句」更能说明问题；反过来 take.lines 是空的（这段本来就没台词）时不算漂移 ——
     takeSubs 那时本就退回按 shot.lines 现排，改了立刻生效。
     分隔符用 U+0001 而不是空串：空串会让「说话人 A + 台词 BC」和「说话人 AB + 台词 C」撞成同一条。 */
  function lineDrift(shot, take) {
    if (!shot || !take || !Array.isArray(take.lines) || !take.lines.length) return null;
    const key = l => String((l && l.who) || '').trim() + '\u0001' + String((l && l.text) || '').trim();
    const snap = take.lines.filter(l => l && String(l.text || '').trim()).map(key);
    const now = (shot.lines || []).filter(l => l && String(l.text || '').trim()).map(key);
    if (!snap.length && !now.length) return null;
    if (snap.length === now.length && snap.every((x, i) => x === now[i])) return null;
    return { shot: snap.length, now: now.length };
  }

  /* 这一句的说话人是谁（**纯读**）。先按 whoId —— 那是配音与字幕真正认的凭据 ——
     再按名字兜一层（早期数据、从素材库拉进来的角色可能只有名字没有 id）。
     **两个都认不出来时返回 null**，页面据此把下拉摆成「未指定」；
     页面绝不能让它自己落到列表第一项：`<select>` 里一项 `selected` 都没有时浏览器
     默认显示第一项，于是右栏写着第一位角色念这句，而 dubShot 只认 whoId（='' 就落到旁白上），
     界面与真正发出去的声音对不上，一个字的提示都没有。
     常见触发：那位角色被从这一集里删掉了 —— dropChar 清掉 `whoId`、**留着那句台词**，
     `who` 也还是旧名字但那位已经不在角色表里了。 */
  function lineSpeaker(drama, line) {
    const cs = (drama && drama.characters) || [];
    const l = line || {};
    return cs.find(c => c && c.id && c.id === l.whoId)
      || cs.find(c => c && c.name && l.who && c.name === l.who)
      || null;
  }

  /* 这一段「要用到」哪些角色 = 出场名单 ∪ 每一句的说话人。**判据只有这一份**，
     `prereqs`（开拍前的前置条件）与配音那一步都读它。
     以前两边各查各的、查的还都不一样：说话人一律走 `lineSpeaker`（先 id 再名字），
     与右栏那个下拉同一份判据 —— 只有名字没有 id 的台词（早期数据、拉库进来的角色），
     那位没画脸没定音色时前置条件照样全绿，拍出来的人声与选定的不是同一个人。 */
  function usedCharsOf(drama, shot) {
    const cs = (drama && drama.characters) || [];
    const out = [], seen = new Set();
    const add = c => { if (!c || !c.id || seen.has(c.id)) return; seen.add(c.id); out.push(c); };
    for (const id of ((shot && shot.chars) || [])) add(cs.find(c => c && c.id === id));
    for (const l of ((shot && shot.lines) || [])) add(lineSpeaker(drama, l));
    return out;
  }

  /* 一段（shot）+ 某一次拍摄（take）→ 字幕条目 [{start,end,text,speaker}]，相对这条片子的起点。
     **时间基准只有一份**：配音那一步（dubShot）已经把每句真实的 start/end 存进 take.lines[] 了
     （它跳过空句、空句不占时间），字幕就必须照那份画。以前这里自己从 0.35 重新累加，
     还给每句垫 0.6 秒下限、空句占 0.2 秒 —— 于是「烧进画面的字幕」与「听到的人声」逐句漂，
     段越长偏得越明显。 */
  function takeSubs(shot, take) {
    const out = [];
    const real = (take && take.lines && take.lines.length) ? take.lines : null;
    if (real) {
      for (const l of real) {
        const text = String(l.text || '').trim();
        if (!text) continue;
        const s = Number(l.start), e = Number(l.end), dur = Number(l.dur) || estDur(text);
        out.push({
          start: round2(Number.isFinite(s) ? s : 0.35),
          end: round2(Number.isFinite(e) && e > s ? e : (Number.isFinite(s) ? s : 0.35) + dur),
          text: text, speaker: String(l.who || '').trim(),
        });
      }
      return out;
    }
    /* 还没配音（预览 / 预演）时没有真实时间轴，才按字数现排一份。 */
    let t = 0.35;                                  // 开头留半秒静场，别一上来就压字
    for (const l of (shot.lines || [])) {
      const text = String(l.text || '').trim();
      if (!text) { t += 0.2; continue; }
      const dur = Math.max(0.6, estDur(text));
      out.push({ start: round2(t), end: round2(t + dur), text: text, speaker: String(l.who || '').trim() });
      t += dur + LINE_GAP;
    }
    return out;
  }
  const round2 = n => Math.round(n * 100) / 100;

  /* 整集（含每段用的是哪一条）→ 一条连续的字幕轨；段与段之间按每段真实时长顺延 */
  function dramaSubs(drama) {
    const out = [];
    let base = 0;
    for (const sh of (drama.shots || [])) {
      const take = chosenTake(drama, sh);
      if (!take) continue;
      const subs = takeSubs(sh, take);
      for (const s of subs) out.push({ start: round2(base + s.start), end: round2(base + s.end), text: s.text, speaker: s.speaker });
      base += Math.max(1, Number(take.sec) || 0);
    }
    return out;
  }

  function srtTime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n, w) => String(Math.floor(n)).padStart(w || 2, '0');
    return p(h) + ':' + p(m) + ':' + p(ss) + ',' + p((ss - Math.floor(ss)) * 1000, 3);
  }
  function toSrt(list) {
    const xs = Array.isArray(list) ? list : [];
    return xs.map((s, i) => (i + 1) + '\n' + srtTime(s.start) + ' --> ' + srtTime(s.end)
      + '\n' + (s.speaker ? s.speaker + '：' : '') + s.text).join('\n\n') + '\n';
  }

  /* 播放器上当前该显示哪条（随 currentTime 切；预览态也用它） */
  function activeAt(list, t) {
    for (const s of list || []) { if (t >= s.start && t < s.end) return s; }
    return null;
  }
  /* 预览时按比例把时间映射到某一条：预演里没成片，用「台词总长」当时间轴 */
  function previewSubs(shot) {
    const list = [];
    let t = 0.4;
    for (const l of (shot.lines || [])) {
      const text = String(l.text || '').trim();
      if (!text) continue;
      const dur = estDur(text);
      list.push({ start: round2(t), end: round2(t + dur), text: text, speaker: String(l.who || '').trim() });
      t += dur + LINE_GAP;
    }
    return list;
  }

  const Subs = { takeSubs, dramaSubs, toSrt, activeAt, previewSubs };

  /* ============================================================================
     六、流水线（拆剧本 / 画脸 / 配音 / 拍这一段 / 出成片）
     ========================================================================== */

  /* ---------- 6.1 拆剧本：一句故事 → 角色 / 场景 / 分段 ----------
     指令文本只在 `assetlib.js` 的 TextAI.DEF.drama_split 有一份，设置页能改；
     这里只负责把**当次的事实**填进占位符（总时长、单段上限、画幅、素材库名单）。
     单段上限不许写死成「15 秒」：那是视频模型自己声明的（两家给的是 4 和 15），
     声明变了拆分粒度就要跟着变，否则拆出来的段根本发不出去。 */
  const MAX_SHOT_FALLBACK = 15;
  function maxShotSec(REG, opts) {
    const v = videoOf(REG || { providers: [] }, opts && opts.videoModel);
    const durs = (((v && v.model && v.model.options) || {}).durations || []).map(Number).filter(x => x > 0);
    return durs.length ? Math.max.apply(null, durs) : MAX_SHOT_FALLBACK;
  }
  /* 占位符填充：{xxx} → 值。用户在设置页里把某条挪走或删掉都不会炸（对不上就不替换）。 */
  function fillTpl(tpl, vals) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vals[k] == null ? m : String(vals[k])));
  }
  /* 拆分镜时喂给 AI 的「已经有的人与场景」，两类来源：
     ① 这一集本身已经带着的（「做下一集」沿留下来的那批）—— 不管角色从哪来都要给，
        否则 AI 一起新名字，上一集攒下的脸 / 音色 / 场景图就在这一集对不上号；
     ② 「从素材库选」时库里的人设。
     AI 用回同一个名字 → normalizeScript 复用那一个对象（脸、声音、资产、场景图都跟着走）。 */
  /* 「这一集点名要用库里哪几条」—— **只有这一份判据**（castNote 与页面上那行摘要都读它）。
       · 没点名（opts.libPick 空）= 整个库都是候选，AI 按剧情自己认名字（这是以前唯一的行为）；
       · 点名了 = 只给这几条。库攒到几十条以后「一整锅倒给模型」等于让模型替用户挑人，
         而用户在入口页明明知道自己要用哪几个。
     点名的 id 在库里已经没了就当没有（`libPick` 存的是 id，库条目删了以后对不上），
     **不退回整个库** —— 悄悄换一批人正是「界面上写着 A、实际发出去的是 B」那种骗人。 */
  const picked = d => ((d && d.opts && d.opts.libPick) || []).map(String);
  function libFor(drama) {
    const lib = Lib.list().filter(c => c && c.name);
    const ids = picked(drama);
    return ids.length ? lib.filter(c => ids.indexOf(String(c.id)) >= 0) : lib;
  }
  function castNote(drama) {
    const voiceOfNote = c => c.refAudio ? '（已有复刻音色）'
      : ((c.voiceName || c.voice) ? '（已有音色 ' + (c.voiceName || c.voice) + '）' : '');
    const parts = [];
    const mine = ((drama && drama.characters) || []).filter(c => c && c.name);
    if (mine.length) {
      parts.push('这一集已经定下了这些角色，剧情里再出现同一个人时**用同样的名字**（脸、声音、资产都挂在名字上）：\n'
        + mine.slice(0, 20).map(c => '· ' + c.name + '：' + (c.bio || '') + (c.look ? '；外貌：' + c.look : '') + voiceOfNote(c)).join('\n'));
    }
    const scenes = ((drama && drama.scenes) || []).filter(s => s && s.name);
    if (scenes.length) {
      parts.push('这一集已经定下了这些场景，能复用就**用同样的名字**（场景图挂在名字上）；确实需要新地方再起一个名字：\n'
        + scenes.slice(0, 20).map(s => '· ' + s.name + '：' + (s.desc || '')).join('\n'));
    }
    /* 道具（2026-10）：剧情里该出现的东西**用认下来的这些**，别临时另起一个同名近似的道具 ——
       它的图会作为参考图发给视频 AI，名字对不上就等于画了一个不认的东西。 */
    const props = ((drama && drama.props) || []).filter(p => p && p.name);
    if (props.length) {
      parts.push('这一集已经定下了这些道具，剧情里需要某件东西时**优先用它们**（道具图挂在名字上），'
        + '不要另起一个名字相近的：\n'
        + props.slice(0, 20).map(p => '· ' + p.name + (p.look ? '：' + p.look : '')).join('\n'));
    }
    if (drama && drama.opts.roleSource === 'lib') {
      const use = libFor(drama);
      const acts = use.filter(c => libKindOf(c) === 'actor');
      const scs = use.filter(c => libKindOf(c) === 'scene');
      /* 名单里可能有已经被删掉的条目：libPick 存的是 id，库条目删了以后这里会少几个。
         一条都没剩就是「点名的那几个都不在了」，照实说，不能悄悄退回整个库。 */
      const lost = (drama.opts.libPick || []).length && !use.length;
      if (acts.length) {
        parts.push((picked(drama) ? '这一集点名要用下面这些人' : '素材库（跨剧复用的角色 / 场景）里已经有这些人')
          + '，剧情对得上就**用同样的名字**并沿用下面的人设与外貌，别另起一套：\n'
          + acts.slice(0, 20).map(c => '· ' + c.name + (c.group ? '（分组：' + c.group + '）' : '')
            + '：' + (c.bio || '') + (c.look ? '；外貌：' + c.look : '') + voiceOfNote(c)).join('\n'));
      }
      if (scs.length) {
        parts.push((picked(drama) ? '这一集点名要用下面这些地方' : '素材库里已经有这些地方')
          + '，能复用就**用同样的名字**（场景图挂在名字上）：\n'
          + scs.slice(0, 20).map(s => '· ' + s.name + (s.group ? '（分组：' + s.group + '）' : '') + '：' + (s.look || '')).join('\n'));
      }
      /* 道具也进这份名单：入口页「从素材库选」现在能点名道具了，拆剧本时就得看见它 ——
         只在第 2 步把道具加进这一集、却不在这里告诉 AI，成片里那个物件仍是它自己编的。 */
      const prs = use.filter(c => libKindOf(c) === 'prop');
      if (prs.length) {
        parts.push((picked(drama) ? '这一集点名要用下面这些道具' : '素材库里已经有这些道具')
          + '，剧情里需要某件东西就用它们（道具图挂在名字上），别临时另起一个名字相近的：\n'
          + prs.slice(0, 20).map(p => '· ' + p.name + (p.group ? '（分组：' + p.group + '）' : '') + (p.look ? '：' + p.look : '')).join('\n'));
      }
      if (lost) {
        parts.push('（原先点名的 ' + picked(drama).length + ' 条素材在库里已经找不到了 —— 这次没有可复用的人设，'
          + '角色与场景按新的一样画。）');
      }
    }
    return parts.join('\n\n');
  }
  /* 平台声明的时长档位，升序、**照实**给 AI（两家给的是 4 和 15，写成「4~15」会让
     AI 以为中间的值也能用，于是每段都填一个中间数、再被吸到某一档 —— 这正是
     「每段都是 15 秒」的来路：AI 填 8，吸到 4 秒装不下台词，于是升到 15）。 */
  function shotDurs(REG, opts) {
    const c = videoCaps(REG || { providers: [] }, { videoModel: opts && opts.videoModel });
    const list = (c.durs || []).slice().sort((a, b) => a - b);
    return list.length ? list : [MAX_SHOT_FALLBACK];
  }
  /* 每个时长档大约装得下多少字（中文口语）—— 由 `estDur` 那个语速现算，
     所以比「秒数 × 4.2」小一圈。**它是一句给 AI 的容量参考，不是限制**：
     真正选哪一档由下面的 `durFor` 按台词实长算。
     为什么非要有这一句：两家平台只声明 4 / 15 秒，AI 若不知道 4 秒只装得下十来个字，
     就会把一整场戏写进一段再填 15 秒 —— 技术上没毛病，拍出来是十几秒空镜。

     ⚠ 算式必须与 `shootFields` 的 need 完全同源：need = Σ字数/语速 + 句间空隙×句数 + 收尾，
     解出「装得下」就是 **(档 − 收尾 − 空隙) × 语速**，空隙要在**乘之前**减掉。
     以前写成 `(d - LINE_TAIL) * CN_PER_SEC - LINE_GAP`（先乘后减），每档都多报一个来字：
     4 秒报「装得下 11 个字」，而 11 个字实测 need = 4.10 秒 > 4，`durFor` 于是翻到 15 秒 ——
     **给 AI 的容量比本项目自己的选档宽松**，等于让 AI 按一个做不到的数字写台词，
     然后拍出来全是长档（正是这个功能要消灭的现象）。
     一句给 AI 的话必须和执行它的那个判据一致，否则两处各算一份就一定对不上。 */
  function durCharCaps(durs) {
    const out = [];
    for (const d of durs) {
      const room = (d - LINE_TAIL - LINE_GAP) * CN_PER_SEC;
      const chars = Math.floor(Math.max(1, room));
      out.push(d + ' 秒一档大约只放得下 ' + chars + ' 个字');
    }
    return out.join('，') + '。';
  }
  function splitSystem(drama, REG) {
    const caps = videoCaps(REG || { providers: [] }, { ratio: drama.opts.ratio, res: drama.opts.res,
      videoModel: drama.opts.videoModel });
    const durs = shotDurs(REG, drama.opts);
    return fillTpl(TextAI.prompt('drama_split'), {
      duration: Number(drama.opts.duration) || 60,
      maxShot: maxShotSec(REG, drama.opts),
      durs: durs.join('、'),
      caps: durCharCaps(durs),
      ratio: (caps && caps.ar) || drama.opts.ratio || '9:16',
      cast: castNote(drama),
    });
  }
  /* 拆剧本是这一条流水线上最长的一次文字 AI 调用（一整集的分场剧本），
     所以 onDelta 一路传到底：界面要能边收边画，让人看到它正在写哪一场 ——
     以前只有「AI 导演正在读故事、拆分镜」一句干等的文案，十几秒里根本判断方向对不对。
     onDelta 只给文字流，不改返回值（normalizeScript 仍按一次完整的 JSON 解析）。 */
  async function splitScript(drama, story, onDelta, opts, o) {
    const reg = await Api.registry();
    const sys = splitSystem(drama, reg);
    const user = '故事：\n' + story;
    const txt = onDelta
      ? await TextAI.chatStream(reg, sys, user, Object.assign({}, opts || {}), onDelta)
      : await TextAI.chat(reg, sys, user, opts || {});
    const j = TextAI.parseJson(txt);
    if (!j || !Array.isArray(j.shots) || !j.shots.length) throw new Error('AI 没给出可用的分镜，换个说法再试一次');
    return normalizeScript(drama, j, story, {
      maxShot: maxShotSec(reg, drama.opts),
      durs: shotDurs(reg, drama.opts),
      bounds: durationBounds(reg, drama.opts),
      aiDur: !(o && o.aiDur === false),
    });
  }
  /* 「哪几段台词念不完最短那一档、只能拍长档」—— 拆完立刻算出来交给界面提示。
     判据与选档位同一份（`estLineSec + LINE_TAIL` 与 `shotDurs`），
     页面拿到的是「第 3、7 段」这样的具体段号，能直接去点开那一段拆。
     没有它就只能等开拍之后看右栏那句「为装下台词多留了一段空镜」—— 钱已经花了。 */
  function overlongShots(drama, REG) {
    const durs = shotDurs(REG, drama && drama.opts);
    if (durs.length < 2) return [];              // 只有一个档位时不存在「最短档装不下」
    const min = durs[0];
    return (drama.shots || []).filter(sh => sh && estLineSec(sh) + LINE_TAIL > min)
      .map(sh => ({ no: sh.no, need: round2(estLineSec(sh) + LINE_TAIL), min: min }));
  }
  /* 把 AI 回来的剧本对齐成本项目的数据模型（角色/场景按名字建档并回填 id） */
  /* 角色来源：「全新角色」让 AI 画脸；「从素材库选」优先复用库里**同名的**那一位
     （脸 / 音色 / 资产全跟着走），库里没有的照常画 —— 别让这个下拉只是个摆设，
     界面上摆一个点了没反应的选项比没有更糟。库里类型是「场景」的那些对到 drama.scenes。 */
  function applyRoleSource(drama) {
    if (!drama || drama.opts.roleSource !== 'lib') return { hit: 0, miss: [] };
    const lib = Lib.list();
    const libById = new Map(lib.map(x => [x.id, x]));
    let hit = 0; const miss = [];
    for (const c of (drama.characters || [])) {
      // 优先按角色 id 匹配（库里保存了 libId，比名字更准）
      let src = null;
      if (c.libId) src = libById.get(c.libId);
      if (!src) src = lib.find(x => x && x.name === c.name && libKindOf(x) === 'actor');
      if (!src) { miss.push(c.name); continue; }
      /* 库里那位是「只出声的角色」→ 这一集里还原成旁白（配音链路认的是 kind） */
      c.kind = voiceOnlyOf(src) ? 'narrator' : 'actor';
      if (src.group) c.group = src.group;
      c.look = src.look || c.look;
      c.bio = src.bio || c.bio;
      c.face = src.face || c.face;
      c.faces = (src.faces && src.faces.length ? src.faces : c.faces);
      c.voice = src.voice || c.voice;
      c.voiceName = src.voiceName || c.voiceName;
      c.voiceNote = src.voiceNote || c.voiceNote;
      c.refAudio = src.refAudio || c.refAudio;
      c.refAudioName = src.refAudioName || c.refAudioName;
      /* 方式也要跟着拷：库里那位是「参考音频复刻」，只拷了 refAudio 而没拷 voiceMode，
         配音还是按界面上选中的预设型号走 —— 音频白存了，人还以为是复刻没生效 */
      c.voiceMode = src.voiceMode || c.voiceMode;
      c.assets = Object.assign({}, src.assets, c.assets);
      c.inLib = true; c.libId = src.id;
      hit++;
    }
    /* 场景同样按名字对上：库里存过的场景（描述 + 预览图）直接进这一集，
       不然「从素材库选」只对上了人，场景还是每次重画一遍。 */
    for (const s of (drama.scenes || [])) {
      let src = s.libId ? libById.get(s.libId) : null;
      if (!src) src = lib.find(x => x && x.name === s.name && libKindOf(x) === 'scene');
      if (!src) continue;
      if (!s.desc) s.desc = src.look || '';
      if (!s.img) s.img = src.face || '';
      if (!s.time) s.time = src.time || '';
      if (src.group) s.group = src.group;
      s.inLib = true; s.libId = src.id;
      hit++;
    }
    return { hit, miss };
  }
  function normalizeScript(drama, j, story, extra) {
    /* 单段时长的上限来自视频模型的声明（由调用方算好传进来），不是这里拍的数 */
    const maxShot = Math.max(4, Number(extra && extra.maxShot) || MAX_SHOT_FALLBACK);
    /* 平台声明的时长档位（升序）。落库时就把 wantSec 吸到最近的那一档 —— 界面上那个
       「约 X 秒」与真正会发出去的 `dur` 必须是同一个数，否则右栏写 8 秒、平台出 15 秒。
       平台没声明时留空数组：下面 `snapDur` 原样返回，行为与从前一致。 */
    const durs = ((extra && extra.durs) || []).map(Number).filter(x => x > 0).sort((a, b) => a - b);
    const snapDur = v => {
      const n = Number(v);
      if (!durs.length) return n;
      if (durs.some(x => x === n)) return n;
      return durs.slice().sort((a, b) => Math.abs(a - n) - Math.abs(b - n))[0];
    };
    const bounds = (extra && extra.bounds) || { min: DUR_FALLBACK_MIN, max: DUR_MAX_SEC };
    drama.title = String(j.title || drama.title || '未命名短剧').slice(0, 40);
    drama.story = story || drama.story;
    /* 整集时长：入口页给的是**目标**，文字 AI 按剧情密度可以回一个它认为合适的数（顶层 duration）。
       采纳它的数，但把用户那一个留在 durationAsked —— 底栏那句「AI 排成 Y 秒（你写的是 Z）」
       要说得出这两个数，不是悄悄改。设置里关掉自主权（dr_ai_dur=off）就一直按用户写的走。 */
    const asked = Number(drama.opts.duration) || 0;
    const aiSec = Math.round(Number(j.duration) || 0);
    if (extra && extra.aiDur !== false && aiSec >= bounds.min && aiSec <= bounds.max && aiSec !== asked) {
      drama.opts.duration = aiSec; drama.opts.durationAsked = asked; drama.opts.durationBy = 'ai';
    } else {
      drama.opts.durationBy = 'user'; drama.opts.durationAsked = 0;
    }
    /* 上一集沿留下来的角色与场景先按名字建一张表：AI 又写到同一个名字时**复用那一个对象**
       （脸 / 音色 / 参考音频 / 资产 / libId 都跟着走），只用 AI 新写的人设与外貌补进去。
       不这么做的话「做下一集」拷进来的那批角色会在拆分镜这一步被整批换成新的。 */
    const charOld = {}, sceneOld = {};
    for (const c of (drama.characters || [])) if (c && c.name && !charOld[c.name]) charOld[c.name] = c;
    for (const s of (drama.scenes || [])) if (s && s.name && !sceneOld[s.name]) sceneOld[s.name] = s;
    const byName = {};
    drama.characters = [];
    for (const c of (j.characters || [])) {
      if (!c || !c.name) continue;
      const nm = String(c.name).slice(0, 20);
      const kind = c.kind === 'narrator' ? 'narrator' : 'actor';
      const old = charOld[nm];
      if (old) {
        old.kind = kind;
        if (c.bio) old.bio = String(c.bio).slice(0, 300);
        if (c.look) old.look = String(c.look).slice(0, 500);
        drama.characters.push(old); byName[nm] = old.id;
        continue;
      }
      const ch = newChar({ name: nm, kind: kind,
        bio: String(c.bio || '').slice(0, 300), look: String(c.look || '').slice(0, 500) });
      drama.characters.push(ch); byName[ch.name] = ch.id;
    }
    const sceneByName = {};
    drama.scenes = [];
    for (const s of (j.scenes || [])) {
      if (!s || !s.name) continue;
      const nm = String(s.name).slice(0, 30);
      const old = sceneOld[nm];
      if (old) {
        if (s.desc) old.desc = String(s.desc).slice(0, 500);
        drama.scenes.push(old); sceneByName[nm] = old.id;
        continue;
      }
      const sc = newScene({ name: nm, desc: String(s.desc || '').slice(0, 500) });
      drama.scenes.push(sc); sceneByName[sc.name] = sc.id;
    }
    /* 道具（2026-10）：按名字建档，同角色 / 场景一样**复用**上一集沿留下来的那一个
       （它的图、inLib、libId 都挂在对象上，重建一个就等于把图丢了）。
       以前这一段**整段不存在** —— 拆分镜的指令压根没要道具，返回的 props 也被直接丢掉，
       于是「道具」这个类型只能靠用户一个一个手加：一部戏里那件推动剧情的东西（信、名单、伞）
       明明在剧本里写着，却永远不在这一集里，视频 AI 每次都自己编一个样子。 */
    const propOld = {};
    for (const p of (drama.props || [])) if (p && p.name && !propOld[p.name]) propOld[p.name] = p;
    const propByName = {};
    drama.props = [];
    for (const p of (j.props || [])) {
      if (!p || !p.name) continue;
      const nm = String(p.name).trim().slice(0, 20);
      if (!nm) continue;
      const old = propOld[nm];
      if (old) {
        if (p.bio) old.bio = String(p.bio).slice(0, 200);
        if (p.look) old.look = String(p.look).slice(0, 500);
        drama.props.push(old); propByName[nm] = old;
        continue;
      }
      const pr = newProp({ name: nm, bio: String(p.bio || '').slice(0, 200), look: String(p.look || '').slice(0, 500) });
      drama.props.push(pr); propByName[nm] = pr;
    }
    /* 段里引用的场景名 → 这一集的场景 id。原来的写法是
       `sceneByName[…] || drama.scenes[0].id`：查不到就静默落到**第一个场景**。
       实测这不是理论问题 —— 用户那一集七个场景名都叫「场景二：暴风雨降临」这样，
       而 AI 在段里写的是「暴风雨降临」，精确匹配对不上，于是**七段全被塞进场景一**：
       提示词写的是剧情里的地方、界面上那个下拉显示着场景一，
       而 linkSource / chainPlan 又拿这个 sceneId 判「接不接上一段的末帧」，
       整条链的接帧判断跟着一起错了。查的三级顺序：
         ① 完全相同 → 就是它；
         ② 互相包含（「暴风雨降临」⊂「场景二：暴风雨降临」，或反过来）→ **只有一个**候选时用它；
         ③ 还是没有 → **当场建一个**，别拿别的场景顶。
       名字真的是空的才留空 —— 界面上有「不指定场景」这一项，存得住也显示得出来。 */
    const sceneFor = name => {
      const nm = String(name || '').trim().slice(0, 30);
      if (!nm) return '';
      if (sceneByName[nm]) return sceneByName[nm];
      const has = drama.scenes.filter(s => s && s.name
        && (s.name.indexOf(nm) >= 0 || nm.indexOf(s.name) >= 0));
      if (has.length === 1) { sceneByName[nm] = has[0].id; return has[0].id; }
      const sc = newScene({ name: nm });
      drama.scenes.push(sc);
      sceneByName[nm] = sc.id;
      return sc.id;
    };
    drama.shots = (j.shots || []).map((s, i) => newShot({
      no: i + 1,
      title: String(s.title || ('第 ' + (i + 1) + ' 段')).slice(0, 30),
      sceneId: sceneFor(s.scene),
      /* 时段照 AI 写的存：TIME_OFS 只有深夜/白天/黄昏/清晨，模型写「傍晚」「凌晨」时
         原来一律悄悄改成「深夜」，提示词与右栏都跟着说错。界面上那个下拉
         （`Cast.timeOptsHTML`）会把表外的值照实列出来，用户自己能改回表里的档。 */
      time: String(s.time || '').trim().slice(0, 10) || '深夜',
      /* 画风与「要不要接上一段的末帧」由文字 AI 按剧情逐段给（界面上不再让人先选） */
      style: String(s.style || '').slice(0, 200),
      link: String(s.link || '').toLowerCase() === 'off' ? 'off' : 'auto',
      chars: (s.chars || []).map(n => byName[String(n)]).filter(Boolean),
      lines: (s.lines || []).filter(l => l && l.text).map(l => ({ who: String(l.who || '').slice(0, 20), whoId: byName[String(l.who || '')] || '', text: String(l.text).slice(0, 120) })),
      shots: (s.shots || []).slice(0, 5).map(k => ({ desc: String(k.desc || '').slice(0, 200), camera: String(k.camera || '').slice(0, 60), sec: clamp(Number(k.sec) || 3, 1, 10) })),
      openDesc: String(s.openDesc || '').slice(0, 400),
      wantSec: snapDur(clamp(Number(s.wantSec) || 8, 3, maxShot)),
    }));
    drama.step = Math.max(2, drama.step);
    applyRoleSource(drama);
    return drama;
  }

  /* ---------- 6.2 画脸 / 画角色资产 / 画场景图 ----------
     生图与语音的型号也和视频一样：**跨平台列全、按 provId/modelId 认用户选的那一个**。
     以前只取 `(providers||[]).filter(kind)[0]`，等于「谁在注册表里排前面就用谁」，
     界面上那两个下拉选了也不生效。 */
  function provModels(REG, kind) {
    /* Api.pickable：设置页勾掉「暂时不用」的那一家不出现在型号下拉里
       （拍短剧的生图 / 语音 / 视频三个入口都走这一句） */
    return Api.pickable(((REG && REG.providers) || [])
      .filter(p => p.kind === kind && (p.models || []).length))
      .flatMap(p => (p.models || []).map(m => ({
        prov: p, model: m, key: (p.id || p.keyId) + '/' + (m.id || m.name),
      })));
  }
  /* 型号按平台分组（界面上是二级菜单：组头 = 平台显示名，选项文字 = 平台那边真正的调用名，
     友好名放 title）。以前选项文字是「MiMo 语音合成 · MiMo TTS（音色设计）」一整串 ——
     把「怎么定音色」写进了名字里，看着像型号自己带的说明，也和视频台/导演台不一致。 */
  function modelGroups(REG, kind, mode) {
    const out = [];
    for (const x of provModels(REG, kind)) {
      if (mode && !(x.model.modes || []).includes(mode)) continue;
      const pk = String(x.prov.id || x.prov.keyId || '');
      let g = out.find(v => v.pk === pk);
      if (!g) { g = { pk: pk, label: String(x.prov.displayName || x.prov.name || x.prov.id || ''), items: [] }; out.push(g); }
      g.items.push({ key: x.key, id: String(x.model.id || x.model.name || ''), name: String(x.model.name || x.model.id || '') });
    }
    return out;
  }
  /* 一个完整的 <select>（含分组），值仍是 provId/modelId —— 跨平台选型号靠这个键，
     只写型号名会在两家都有同名型号时打到别家去。 */
  function modelSelectHTML(REG, o) {
    o = o || {};
    const groups = modelGroups(REG, o.kind, o.mode);
    if (!groups.length) return '<span class="ui-hint">' + esc(o.emptyText || '注册路由里没有这一类平台') + '</span>';
    const cur = String(o.value || '');
    return '<select id="' + esc(o.id || '') + '">' + groups.map(g =>
      '<optgroup label="' + esc(g.label) + '">' + g.items.map(it =>
        '<option value="' + esc(it.key) + '"' + (it.key === cur ? ' selected' : '')
        + ' title="' + esc(it.name) + '">' + esc(it.id) + '</option>').join('') + '</optgroup>').join('') + '</select>';
  }
  /* 取用户选中的那一个（key = provId/modelId）；没选、或选的那个已经不在了 → 退回**声明了这个 mode** 的第一个 */
  function pickProvModel(REG, kind, key, mode) {
    const all = provModels(REG, kind);
    if (!all.length) return null;
    const hit = key ? all.find(x => x.key === key) : null;
    if (hit && (!mode || (hit.model.modes || []).includes(mode))) return hit;
    const byMode = mode ? all.filter(x => (x.model.modes || []).includes(mode)) : all;
    return byMode[0] || hit || all[0];
  }
  /* ---------- 文字 AI 熔断：润色这条路问不通时，别再每次都白等一次超时 ----------
     提示词润色（`imagePrompt` / `videoPrompt`）天生带一份 `plain` 兜底 —— 文字 AI 挂了只是
     「少润色一次」，图照样出得来。但兜底发生在**问不通之后**：从前的顺序是每出一张图、每拍一段都
     先等满一次超时。一部 7 段的剧（1 角色 + 1 场景 + 7 段开头画面）就是 9 次 × 60 秒 ≈ 9 分钟
     纯等待 —— 而图片 / 视频 / 语音三家的密钥是好的，卡住的不是生成，是润色。
     所以连续问不通 `AI_BAD_MAX` 次就断开一段时间，期间**直接**走兜底不再问；成功一次立刻复位。
     判据只有 `aiOk()` 这一份，两个提示词函数都问它（页面不许自己数失败次数）。
     刻意不做进 `TextAI`：那只影响拍短剧。另外十页的 AI 动作（拆剧本 / 定音色 / 改分镜）**没有**
     兜底 —— 它们问不通就该当场报错，不该被这一处的熔断顺手关掉。 */
  const AI_BAD_MAX = 2;                 // 连续问不通几次就断开
  const AI_OFF_MS = 5 * 60 * 1000;      // 断开多久（页面照实告诉用户还要等多久）
  let aiBad = 0, aiOffUntil = 0;
  function aiOk() { return Date.now() >= aiOffUntil; }
  function aiMarkOk() { aiBad = 0; aiOffUntil = 0; }
  function aiMarkBad() { if (++aiBad >= AI_BAD_MAX) aiOffUntil = Date.now() + AI_OFF_MS; }
  /* 界面照实播报这一档：`ok` 为 false 时带「还有多久自动再试」，用户也可以立刻手动再试一次。 */
  function aiState() {
    return { ok: aiOk(), bad: aiBad, leftMs: Math.max(0, aiOffUntil - Date.now()) };
  }
  function aiRetry() { aiBad = 0; aiOffUntil = 0; }

  /* 图片 AI 的提示词：设定（外貌 / 环境）→ 文字 AI 按设置页那条指令写成高质量提示词 → 图片 AI 出图。
     指令默认文本在 assetlib.js 的 TextAI.DEF.drama_image，设置页⑦能改；这里只填当次的占位符。
     文字 AI 没配或失败就退回用设定原文 —— 那是「少润色一次」，不是「什么都做不了」。 */
  async function imagePrompt(REG, vals) {
    const tpl = TextAI.prompt('drama_image');
    const plain = vals.look + '。' + vals.what + '。画幅 ' + vals.ar + '，无文字、无水印。';
    if (!tpl || !TextAI.prov(REG)) return plain;
    /* 熔断中就不问了：再问一次的结果和上一次一样，只是又让用户等满一个超时。 */
    if (!aiOk()) return plain;
    try {
      const one = await TextAI.chat(REG, fillTpl(tpl, vals), '请写出这张图的提示词。', {});
      aiMarkOk();
      const t = String(one || '').trim().replace(/^["'「]|["'」]$/g, '');
      return t.length >= 8 ? t : plain;
    } catch (e) { aiMarkBad(); return plain; }
  }
  /* 整集画风取向：入口页不再让人选（`opts.style` 留空），所以取文字 AI 为第一段定的那一句话。
     画脸/画场景时需要一个贯穿全片的调子，否则「认角色」画出来的是写实、拍出来是动漫。 */
  function episodeStyle(drama) {
    return (drama && drama.opts && drama.opts.style) || ((drama && drama.shots && drama.shots[0]) || {}).style || '';
  }
  /* ---------- 预览图 → 三视图：两种素材类型共用一条生成顺序 ----------
     「预览图」是这一位/这一个场景的**样子凭据**：卡片缩略图，也是生图与生视频认脸、认景的锚点。
     以前三视图只吃文字描述，于是「三视图里的人」和「预览图里的人」是两张脸 ——
     现在预览图先出，三视图把预览图当 reference_image 一起发；型号没这个槽位时照实说明（不假装一致）。 */
  /* 「预览图」这一个概念在三种对象上的字段名不同（库条目与剧侧角色用 face，剧侧场景用 img），只在这里判一次 */
  function picOf(x) { return (x && (x.face || x.img)) || ''; }
  function setPic(x, src) { if (x && 'face' in x) x.face = src; else x.img = src; return src; }
  function descOf(x) { return (x && (x.look || x.desc || x.bio)) || ''; }
  function isSceneItem(x) { return libKindOf(x) === 'scene' || episodeKindOf(x) === 'scene'; }
  /* 这个型号有没有「参考图」槽位、能收几张 —— 只问能力声明，不按平台名猜 */
  function refImageRule(model) {
    try {
      const r = window.Capabilities && Capabilities.rule(model, 'reference_image');
      return r && Number(r.max) > 0 ? r : null;
    } catch (e) { return null; }
  }
  /* 本机那张预览图 → 这个平台这个槽位认的输入条目（要不要先上传由 registry 的 inputTemplates 决定）。
     拿不到就返回 null：这一张退回「只按文字重画」，并把原因写进 notes 让人看得见。 */
  async function refEntryFor(v, src, name) {
    if (!src) return null;
    try { return await AssetTransfer.entryFor(v.prov, 'reference_image', src, { name: name || '预览图' }); }
    catch (e) { return { err: (e && e.message) || String(e) }; }
  }
  /* 出预览图：角色 = 正面半身定妆照，场景 = 无人物的空镜，道具 = 单件物品陈列。
     三种类型以前只有前两种各写一份；现在这一份里按类型取 `what` 与画幅，改画风只改一处。
     `o.count` = 一次出几张候选 —— **上限看这个生图型号声明的 `max_outputs`**（不在这里写死）。
     2026-10 起两页都只传 `count: 1`（多张候选那一排已下掉），但 `count` 这个口仍然留着：
     `o.replace` 与候选合并是数据层的事，页面只是不再摆那一排。
     返回实际出好的张数（型号只支持 1 张时就回 1，界面据此说「这一家一次只能出一张」）。 */
  async function drawPreview(REG, drama, item, o) {
    const v = pickProvModel(REG, 'image', drama.opts.imgModel, 'text_to_image');
    if (!v) throw new Error('没有可用的生图平台，先在设置页配好生图接口');
    /* 出几张：调用方给了 `o.count` 就照它（单张替换那颗按钮要的就是 1），
       没给就按设置里的「候选张数」再夹到这个型号声明的上限（`candCount` 那一处判据）。 */
    const want = Math.max(1, Math.min(previewCap(v.model), Number(o && o.count) || candN()));
    const scene = isSceneItem(item);
    const prop = isPropItem(item);
    const ratio = drama.opts.ratio || '9:16';
    /* 画幅：道具是单件物品，给竖幅反而浪费像素（1:1 最贴近「陈列一张图」）；
       场景跟整集画幅走（它就是这一集的取景框）；角色远景跟画幅走、近景给 1:1 定妆照。 */
    const ar = prop ? '1:1' : scene ? ratio : (ratio === '9:16' ? '9:16' : '1:1');
    const what = prop
      /* 道具**没有脸可照**：它的图就靠这句描述，所以「只按文字画、别加人物」这两句必须写死 ——
         生图模型很容易给一件雨伞配上一个拿着它的人，而道具是拿去当参考图的，
         参考图里带个人会让视频 AI 在每一段都凭空多出一个人。 */
      ? '这件道具的单件陈列图：只有这一件物品本身，完整入镜、居中、纯净浅色背景，不要人物、不要手、不要环境，不要加别的配件'
      : scene ? '空场景图：无人物，构图留出人物站位，' + (item.time || '') + '的光线'
        : (item.kind === 'narrator' || item.voiceOnly ? '这位角色的正面半身定妆照（只出声也要有个形象）' : '角色定妆照：正面半身，纯净浅色背景，五官清晰');
    const prompt = await imagePrompt(REG, {
      what: what,
      name: item.name, look: descOf(item) || item.name, style: episodeStyle(drama), ar: ar,
    });
    const e = await AiGen.image({ prov: v.prov, model: v.model, prompt: prompt, ar: ar, count: want,
      log: { type: prop ? '短剧-道具' : scene ? '短剧-场景' : '短剧-角色定妆',
        meta: prop ? { 道具: item.name, 画幅: ar } : scene ? { 场景: item.name } : { 角色: item.name, 画幅: ar } } });
    const list = (e.entries || [e]).filter(x => x && x.src);
    /* 候选一律攒进 faces（旧的排在后面，多的按上限裁掉）；已经选中的那张不动 ——
       重画几张不该把人选好的预览图顶掉。`o.replace` 是「AI 重出预览图」那颗按钮：
       单张替换，没有候选可挑时不换就是点了没反应。 */
    const old = (item.faces || []).slice();
    item.faces = list.map((x, i) => ({ src: x.src, name: '第 ' + (old.length + i + 1) + ' 张' }))
      .concat(old).slice(0, FACE_CAP);
    if (!picOf(item) || (o && o.replace)) setPic(item, list[0].src);
    return { src: list[0].src, n: list.length, cap: previewCap(v.model) };
  }
  /* 一次能出几张候选：只问能力声明（max_outputs），没声明就当 1 张。
     界面上那颗「一次出 N 张」的按钮文字也用这一条，不要页面自己写个 3。 */
  function previewCap(model) {
    const n = Number(((model && model.options) || {}).max_outputs) || 1;
    return clamp(Math.floor(n), 1, FACE_CAP);
  }
  /* 角色资产的**出图模板**（一张表 = 一个模板）。
     模板 ≠ 资产的类别：存下来的资产是扁平的、名字自己起（见下面那段），
     这里只管「点『AI 出』时用哪段提示词」。
     2026-10 之前这里只有 `three`，表情表 / 服装被从两页下掉了，理由是「只给人看、
     拍摄时不发给视频 AI，画一次的钱不产生任何拍摄效果」。
     **这个理由现在不成立了** —— 拍摄时这些图会作为参考图发出去（见 planMaterials）：
     表情图锁住表情（不拍出木头脸），服装图锁住这一段穿什么（一个角色有多套衣服时
     不再每段都长成同一件），手持道具图让拿在手上的东西长对。所以三类都重新开放。 */
  const ASSET_PROMPTS = {
    three: '角色三视图：同一人物的正面、侧面、背面全身排列，服装一致，浅色底',
    expr: '角色表情表：同一张脸的六种情绪并排（平静、微笑、大笑、愤怒、悲伤、惊讶），'
      + '五官与发型完全一致，只有表情变化，浅色底',
    costume: '角色服装图：这一位角色的全套服装正面平铺展示（完整上身与下身、鞋、随身小物），'
      + '与参考图里是同一个人、同一身形，浅色底',
    prop: '角色手持道具图：这一位角色手里拿着的那件东西单独陈列（与参考图里是同一个人拿着它），'
      + '中性背景，突出物件本身的形制与材质',
    /* `custom` 没有固定提示词 —— 用户自己写「画什么」。见下面 `what` 的取法。 */
    custom: '',
  };
  /* 场景与道具**没有任何资产子项**（2026-10 起）：场景只有它自己那一张图，
     多角度 / 不同时段 / 陈设细节 / 物件那一套不再出图。老场景对象上可能还挂着
     `assets.three`（那时它叫「多角度」），界面照旧给它名字、能看能删，
     但不再有出图入口 —— 所以这里没有它们的提示词表，调用会走下面那句明确的错。 */
  const SCENE_ASSET_PROMPTS = {};
  /* `tpl` = 出图模板；`o.name` = 这一张叫什么（用户可改，存进资产）；`o.what` = 自定义描述
     （`tpl` 是 custom、或模板表里没有这一档时用它当提示词主体）。
     ⚠ 出完**一律追加**，不顶掉已经选中的那张：角色资产会作为参考图进生图与生视频，
       悄悄换掉人选好的那张 = 换一个人。`o.replaceId` 才是「换掉这一张」，指明是哪一张。 */
  async function drawCharAsset(REG, drama, item, tpl, o) {
    const table = isSceneItem(item) ? SCENE_ASSET_PROMPTS : ASSET_PROMPTS;
    const what = String((o && o.what) || '').trim();
    /* 没有模板、也没写描述 → 说清这一类**为什么**出不了，而不是甩一个空提示词出去
       （那会变成「按描述画一个」，出来的东西与用户点的那一栏毫无关系）。 */
    if (!table[tpl] && !what) {
      throw new Error(isSceneItem(item)
        ? '场景不再出' + (assetLabel(item, tpl) || tpl) + '了：场景只有它自己那一张图'
        : (isPropItem(item) ? '道具不再出「' + tpl + '」：道具的图就是它自己那一张预览图'
          : '得先写清楚要画什么：现在能选的模板是 ' + (assetTplsOf(item) || []).map(k => assetLabel(item, k)).join('、')
            + '，也可以选「自定义」自己写一句'));
    }
    const v = pickProvModel(REG, 'image', drama.opts.imgModel, 'text_to_image');
    if (!v) throw new Error('没有可用的生图平台');
    const want = Math.max(1, Math.min(previewCap(v.model), Number(o && o.count) || 1));
    const name = String((o && o.name) || '').trim() || assetLabel(item, tpl) || tpl || '资产';
    const label = name;
    const base = picOf(item);
    if (!base) throw new Error('先出预览图，再出' + label + '：没有预览图就只能凭文字重画一个样子');
    const notes = [];
    let inputEntries = null;
    if (refImageRule(v.model)) {
      const en = await refEntryFor(v, base, item.name + '-预览图');
      if (en && en.err) notes.push('预览图没能发给生图 AI（' + en.err + '），这一张是按文字重画的');
      else if (en) inputEntries = [en];
    } else {
      notes.push('这个生图型号没有「参考图」槽位，' + label + '只能按文字描述重画，样子可能对不上预览图');
    }
    const prompt = await imagePrompt(REG, {
      what: (table[tpl] || what) + (inputEntries ? '。严格沿用参考图里的同一个人与同一套服装，不要换脸、不要改发型' : ''),
      name: item.name, look: descOf(item), style: episodeStyle(drama), ar: '16:9',
    });
    const e = await AiGen.image({ prov: v.prov, model: v.model, prompt: prompt, ar: '16:9', count: want,
      inputEntries: inputEntries,
      log: { type: '短剧-角色资产', meta: { 角色: item.name, 资产: name, 模板: tpl } } });
    const list = (e.entries || [e]).filter(x => x && x.src);
    /* 候选一律攒进 assetCands[tpl]，**已经存着的那张不因此被顶掉**（与预览图同一套做法）。
       写回走 `assetsSave`（落盘是列表）。资产没有「某一类只能一张」这回事了，
       所以默认**追加**；`replaceId` 指明了要换掉哪一张时才替换那一张。 */
    let mine = assetsOf(item);
    const first = list[0];
    if (o && o.replaceId) {
      mine = mine.filter(x => x.id !== o.replaceId);
      mine.push(normAsset({ id: o.replaceId, name: name, tpl: tpl, src: first.src }));
    } else {
      mine.push(normAsset({ name: name, tpl: tpl, src: first.src }));
    }
    assetsSave(item, mine);
    item.assetCands = item.assetCands || {};
    item.assetCands[tpl] = mergeCands(list.map(x => ({ src: x.src })), item.assetCands[tpl], FACE_CAP);
    return { src: first.src, n: list.length, notes: notes, name: name };
  }
  /* 旧名字留着当入口（五个调用方都在调）：现在都走 drawPreview 那一条 */
  function drawFace(REG, drama, char, o) { return drawPreview(REG, drama, char, o); }
  function drawScene(REG, drama, scene, o) { return drawPreview(REG, drama, scene, o); }
  /* 某一段的开头画面（预演第一帧）：和画脸/画场景同一条路 —— 用 opts.imgModel 选中的型号、
     用设置页那条 drama_image 指令写成提示词，并把这一段出场角色的外貌写进去。
     以前这一段长在页面里：型号是自己挑的第一个（选了也不生效），画风还拼着 opts.style 的旧写死值。
     **参考图（2026-10 补上）**：这一段的场景图 + 出场角色的脸作为 `reference_image` 发过去。
     以前只按文字画，于是预演里那个客厅和认角色时画的场景图毫无关系 —— 用户在第 3 步看到的背景
     与开拍后真实用到的场景对不上，等于拿一张假画面当预览。发不出去（型号没有这一槽 / 上传失败）
     就退回纯文字并把原因写进 `openNote`，照实说而不是假装一致。 */
  async function drawOpen(REG, drama, shot) {
    const v = pickProvModel(REG, 'image', drama.opts.imgModel, 'text_to_image');
    if (!v) throw new Error('没有可用的生图平台');
    const cast = (shot.chars || []).map(id => (drama.characters || []).find(c => c && c.id === id)).filter(Boolean);
    const who = cast.map(c => c.name + '：' + (c.look || c.bio || '')).join('；');
    const ar = (drama.opts.ratio || '9:16');
    const notes = [];
    let inputEntries = null;
    /* 场景图排第一：这一段就发生在这个地方，它决定整张画面的空间与光线。
       角色脸排后面（一个场景里常有两三位，脸比场景更吃重图位）——但两者都发不出去时照旧画。 */
    const sc = (drama.scenes || []).find(x => x && x.id === shot.sceneId);
    const sources = [];
    if (sc && sc.img) sources.push([sc.img, (sc.name || '场景') + '-场景图']);
    for (const c of cast) if (c.face) sources.push([c.face, c.name + '-预览图']);
    if (sources.length) {
      if (!refImageRule(v.model)) {
        notes.push('这个生图型号没有「参考图」槽位，开头画面只能按文字画，与场景图 / 角色脸可能对不上');
      } else {
        const list = [];
        for (const [src, name] of sources) {
          const en = await refEntryFor(v, src, name);
          if (en && en.err) notes.push(name + '没能发给生图 AI（' + en.err + '）');
          else if (en) list.push(en);
        }
        if (list.length) inputEntries = list;
      }
    }
    const prompt = await imagePrompt(REG, {
      what: '这一段短剧的开头画面（第一帧）：构图留出人物站位，无字幕、无水印'
        + (inputEntries ? '。严格沿用参考图里的场景与人物，不要换地方、不要换人' : '')
        + (who ? '。出场人物（按设定画，保持一致）：' + who : ''),
      name: drama.title || '短剧',
      look: (shot.openDesc || shot.title || '') + (who ? '。' + who : ''),
      style: episodeStyle(drama), ar: ar,
    });
    const e = await AiGen.image({ prov: v.prov, model: v.model, prompt: prompt, ar: ar,
      inputEntries: inputEntries,
      log: { type: '短剧-开头画面', meta: { 短剧: drama.title, 段: shot.no } } }).catch(err => {
        /* 原因留在这一段上（页面的那一格会读 `openErr`）：只 toast 一句的话，
           五秒之后「为什么这一段没有开头画面」就再也查不到了。 */
        shot.openErr = (err && err.message) || String(err);
        throw err;
      });
    shot.startImg = e.src;
    shot.openErr = '';
    /* notes 落在段上：图画出来了、只是可能对不上原图/原人 —— 与失败（openErr）不是一回事。 */
    shot.openNote = notes.join('；') || '';
    return e.src;
  }

  /* ---------- 6.3 配音：逐句合成，按真实时长排字幕 ----------
     语音型号也和视频一样按用户选的那个取（`opts.ttsModel` = provId/modelId），
     并且**按声明认「这个型号怎么定音色」**（registry 的 models[].ttsMode）：
       preset 预设音色 → 发 char.voice 那个音色 id
       design 音色设计 → 发 char.voiceNote 那段描述
       clone  音色复刻 → 发 char.refAudio 那段参考音频（data:…;base64）
     不在页面里猜、也不编「声音 1/2/3」。 */
  /* 真正会发出去的那个 TTS 型号：配音与试听都必须用它 ——
     随手取 `(prov.models||[])[0]` 时，平台上第一个型号不是 TTS 就会拿到一个根本不认音色的型号。 */
  function pickTtsModel(prov) {
    const ms = (prov && prov.models) || [];
    return ms.find(m => (m.modes || []).includes('text_to_speech')) || ms[0] || null;
  }
  const ttsModeOf = model => {
    if (!model) return 'preset';
    /* registry 的 `ttsMode` 优先（那是本项目自己声明的）；
       认不到就**从平台自己声明的 `modes` 推**（`voice_design` / `voice_clone`）。
       以前只认 `ttsMode`：一家平台只在自己 `/models` 里声明了 voice_design、registry 没写那一行时，
       这一页会说「这个语音平台没有音色设计型号」而画不出描述框，
       而语音台（studio）读的是 live `modes`、同一个型号能正常用 —— 同一件事两个说法。 */
    if (model.ttsMode) return model.ttsMode;
    const md = model.modes || [];
    if (md.includes('voice_design')) return 'design';
    if (md.includes('voice_clone')) return 'clone';
    return 'preset';
  };
  /* 这个型号**能不能**按某种方式定音色 —— 有些平台的请求体模板里根本没有对应的字段位：
     声明了 design 而模板里没有 `{{style}}` 的话，那段音色描述会被**静默丢掉**（不报错），
     界面看着「按描述生成音色」，发出去的却还是默认嗓子。所以先确认模板有位置放。 */
  function ttsModeUsable(prov, model, mode) {
    if (!model) return false;
    if (mode === 'design') {
      /* 描述走 `{{style}}`（MiMo 那样放在 messages 里的一个 role），
         也可能走 `{{style}}` 直接当顶层字段 —— 有这个占位符就认。 */
      const t = (prov && prov.create && prov.create.template) || null;
      if (t && !/style/.test(JSON.stringify(t))) return false;
    }
    if (mode === 'clone') {
      const ir = ((prov && prov.inputRoles) || {});
      if (!Object.keys(ir).some(r => /audio/.test(r))) return false;
    }
    return true;
  }
  /* 配音色时**优先用哪一个型号**（用户要求：自动调用生成音色的模型，而不是让人挑固定音色）。
     顺序是「生成音色 > 音色复刻 > 预设音色」：
       · 一家语音平台往往同时有预设 / 设计 / 复刻三个型号，registry 里 preset 排在第一个 ——
         于是默认命中的永远是预设，界面上就变成「从几个固定音色里挑一个」。
       · 复刻排第二是因为它需要参考音频，没有就退给设计；
       · 预设排最后：它是**兜底**，不是首选 —— 只有这一家只有预设型号时才轮到它。 */
  function preferTtsModel(prov) {
    const by = ttsModelsOf(prov);
    for (const k of ['design', 'clone', 'preset']) if (by[k]) return by[k];
    return pickTtsModel(prov);
  }
  /* 用户选的 ttsModel 只决定「用哪一家」；**默认落到哪一档由这一家有没有生成音色的型号决定**。
     角色显式要的方式（char.voiceMode）仍然最优先 —— 那是人点的，不能被默认值盖掉。 */
  function ttsOf(REG, opts, mode) {
    const v = pickProvModel(REG, 'audio', opts && opts.ttsModel, 'text_to_speech');
    if (!v) return v;
    /* 三层，后者盖前者：角色显式指定的那一位 > 这一集 opts 里的 > 设置项 `dr_tts_mode`（默认 auto）。
       `setting` 取不到（没配这一项）时退回 SET 里的默认值，而不是 undefined → 那会让
       `want` 变成 'undefined'，既不匹配任何一档，最后落到 preset —— 正好是用户要改掉的那个默认。 */
    let def = SET.ttsMode.def;
    try { const s = setting('ttsMode'); if (s) def = String(s); } catch (e) { /* 没读到就用默认值 */ }
    const want = mode || (opts && opts.ttsMode) || def || 'auto';
    if (want === 'auto') {
      const m = preferTtsModel(v.prov);
      return m ? { prov: v.prov, model: m, key: (v.prov.id || v.prov.keyId) + '/' + (m.id || m.name) } : v;
    }
    if (want === ttsModeOf(v.model)) return v;
    /* 同一个平台上「定音色」的方式往往挂在**不同的型号**上（MiMo：预设 / 设计 / 复刻三个型号）。
       角色要的是哪一种，就去这个平台拿声明了那一种的型号 —— 一直用 opts.ttsModel 那一个的话，
       界面说「这位用音色复刻」而实际发的还是预设音色型号，参考音频根本没出网。 */
    const m = ttsModelsOf(v.prov)[want];
    if (!m) return v;
    return { prov: v.prov, model: m, key: (v.prov.id || v.prov.keyId) + '/' + (m.id || m.name) };
  }
  /* 一个语音平台上按「定音色的方式」分出来的型号（同一方式只留声明里的第一个）。
     认不出方式、或者那个方式在请求体里**没有位置放**的型号不进这张表 ——
     否则界面画出一个「写声音描述」的输入框，而发出去的那句描述被上游静默丢掉。 */
  function ttsModelsOf(prov) {
    const out = { preset: null, design: null, clone: null };
    for (const m of ((prov && prov.models) || [])) {
      if (!(m.modes || []).includes('text_to_speech')) continue;
      const k = ttsModeOf(m);
      if (out[k] == null && ttsModeUsable(prov, m, k)) out[k] = m;
    }
    return out;
  }
  /* 这一家到底能怎么定声音（AI 定音色与界面都读它，不许猜）：
     preset 给平台声明的音色清单，design / clone 给对应型号（没有就 null）。 */
  function ttsWays(REG, opts) {
    const v = pickProvModel(REG, 'audio', opts && opts.ttsModel, 'text_to_speech');
    if (!v) return { ok: false, why: '还没配语音接口 —— 到设置页填一个语音平台的密钥', preset: [], design: null, clone: null, prov: null };
    const by = ttsModelsOf(v.prov);
    const preset = by.preset ? voices(REG, opts, 'preset') : [];
    return { ok: !!(by.design || by.clone || preset.length), why: '这个语音平台既没有可选的预设音色，也没有音色设计 / 复刻的型号',
      preset: preset, design: by.design || null, clone: by.clone || null, prov: v.prov, model: v.model };
  }
  /* 当前语音型号用哪种方式定音色（界面据此决定「选预设音色 / 写一段声音描述 / 上传参考音频」）。
     传 mode 就是问「这个方式落在哪一个型号上」。
     没有语音平台时回 'none'，由页面写明原因，不要摆一排假控件。 */
  function voiceMode(REG, opts, mode) {
    const v = ttsOf(REG, opts, mode);
    return v ? ttsModeOf(v.model) : 'none';
  }
  /* 机位候选（2026-10 用户要求）。
     以前机位是从页面那七条 `CAMERAS` 里挑一个**词**（固定镜头 / 俯拍 / 过肩…），
     写进这一段的镜头描述，**不出一张图** —— 而「左前方·中景」和「右后方·远景」在文字里只差几个字，
     在画面里是两回事。用户只能照着词脑补，脑补不出来就只能瞎选。
     现在一次出 N 张构图图供挑：
       ① 文字 AI 按这一段的开头画面 + 出场人物 + 场景，出 N 个**彼此真的不同**的机位方案
          （`TextAI.prompt('drama_camera')`，设置页「拍短剧 · 拍摄与画面」里能改）；
       ② 每个方案各出一张图，这一段的**场景图 / 角色脸**当参考图发过去
          （与 `drawOpen` 同一套 `refEntryFor`，发不出去就退回纯文字并把原因带回来）；
       ③ 挑一张 = 把那个机位的描述写进这一段的每一个镜头（页面 `applyCamera` 那条路）。
     成本是 N 倍生图，所以张数走**单独一档**设置（`SET.camN`，默认 3，最大 9），
     不与素材候选（`SET.candN`）共用 —— 机位是每段一次，素材是一集一次，成本量级不同。 */
  async function drawCameras(REG, drama, shot, o) {
    o = o || {};
    const v = pickProvModel(REG, 'image', drama.opts.imgModel, 'text_to_image');
    if (!v) throw new Error('没有可用的生图平台，先在设置页配好生图接口');
    /* 出几张：设置里的「机位一次出几张」再夹生图型号声明的上限（`candCount` 那一处判据，
       换 id 换成 camN —— 与素材候选分开算，理由见上面那段）。 */
    const n = candCount(REG, drama.opts, 'camN', v.model);
    const sc = (drama.scenes || []).find(x => x && x.id === shot.sceneId);
    const cast = (shot.chars || []).map(id => (drama.characters || []).find(c => c && c.id === id)).filter(Boolean);
    const curCam = (shot.shots && shot.shots[0] && shot.shots[0].camera) || '';
    const sys = fillTpl(TextAI.prompt('drama_camera'), {
      n: n,
      desc: shot.openDesc || shot.title || '',
      cast: cast.map(c => c.name + '：' + (c.look || c.bio || '')).join('；') || '（这一段没有人物）',
      scene: sc ? (sc.name + '：' + (sc.desc || '')) : '（这一段没指定场景）',
      cur: curCam || '（还没设）',
    });
    if (o.onStage) o.onStage('正在想 ' + n + ' 个机位…');
    let txt = '';
    try { txt = await TextAI.chat(REG, sys, '请给上面这一段出 ' + n + ' 个不同的机位方案，只输出 JSON。', o); }
    catch (e) { throw new Error('机位方案没出来：' + ((e && e.message) || e)); }
    const j = TextAI.parseJson(txt);
    const cams = ((j && j.cams) || []).filter(x => x && String(x.desc || '').trim()).slice(0, n);
    if (!cams.length) throw new Error('文字 AI 没给出可用的机位方案（换个说法再试一次）');
    /* 参考图：场景图 + 出场角色的脸。与 drawOpen 同一套取法（那边写清了为什么必须有）——
       没有它，出来的机位图里那个客厅与认角色时画的场景图对不上，等于白出这一批。 */
    const notes = [];
    let inputEntries = null;
    const sources = [];
    if (sc && sc.img) sources.push([sc.img, (sc.name || '场景') + '-场景图']);
    for (const c of cast) if (c.face) sources.push([c.face, c.name + '-预览图']);
    if (sources.length) {
      if (!refImageRule(v.model)) notes.push('这个生图型号没有「参考图」槽位，机位图只能按文字画，场景与人物可能对不上');
      else {
        const list = [];
        for (const [src, name] of sources) {
          const en = await refEntryFor(v, src, name);
          if (en && en.err) notes.push(name + '没能发给生图 AI（' + en.err + '）');
          else if (en) list.push(en);
        }
        if (list.length) inputEntries = list;
      }
    }
    const ar = drama.opts.ratio || '9:16';
    const made = [];
    for (let i = 0; i < cams.length; i++) {
      const c = cams[i];
      const label = String(c.label || ('机位 ' + (i + 1))).trim().slice(0, 12);
      if (o.onStage) o.onStage('正在出第 ' + (i + 1) + ' / ' + cams.length + ' 张：' + label);
      try {
        const prompt = await imagePrompt(REG, {
          what: '短剧这一段的机位构图参考图：' + String(c.desc).trim()
            + (inputEntries ? '。严格沿用参考图里的场景与人物，只换机位与景别' : '')
            + '。无字幕、无水印',
          name: drama.title || '短剧',
          look: (shot.openDesc || shot.title || ''),
          style: episodeStyle(drama), ar: ar,
        });
        const e = await AiGen.image({ prov: v.prov, model: v.model, prompt: prompt, ar: ar, inputEntries: inputEntries,
          log: { type: '短剧-机位', meta: { 短剧: drama.title, 段: shot.no, 机位: label } } });
        made.push({ label: label, desc: String(c.desc).trim(), src: e.src });
      } catch (e) { made.push({ label: label, desc: String(c.desc).trim(), err: (e && e.message) || String(e) }); }
    }
    /* 出成的进候选（新的排前面），出砸的**留在段上**而不是悄悄丢掉 ——
       用户点了「出 3 个机位」只看到 1 个时，必须有一句「另外 2 个没出来：原因」。 */
    const ok = made.filter(x => x.src);
    shot.camCands = ok.concat((shot.camCands || []).filter(x => x && x.src)).slice(0, 9);
    shot.camErr = made.filter(x => x.err).map(x => x.label + '：' + x.err).join('；');
    shot.camNote = notes.join('；') || '';
    return { cands: shot.camCands, made: ok.length, failed: made.length - ok.length, want: n, notes: notes };
  }
  /* 可选音色：顺序与语音台一致（当前型号的 options.voices → 平台级 tts.voices 兜底）。
     别自己编音色名 —— 编出来的 id 平台根本不认，提交时才报错。
     复刻 / 设计那两个型号**没有预设音色**（一个认参考音频、一个认描述），这时返回空数组。 */
  function voices(REG, opts, mode) {    const v = ttsOf(REG, opts, mode);
    if (!v) return [];
    if (ttsModeOf(v.model) !== 'preset') return [];
    const tts = v.prov.tts || {};
    const list = (v.model.options || {}).voices || tts.voices || [];
    return (Array.isArray(list) ? list : []).map(x => (typeof x === 'string' ? { id: x, name: x } : x))
      .filter(x => x && x.id).map(x => ({ id: String(x.id), name: String(x.name || x.id), lang: x.lang || '', gender: x.gender || '' }));
  }
  const blobToBase64 = b => new Promise((res, rej) => {
    const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(',')[1] || ''); rd.onerror = rej; rd.readAsDataURL(b);
  });
  /* 复刻用的参考音频存在本机 IndexedDB，角色对象里只存键 —— 一段声音十几 MB，
     存进 JSON 会把这一集的读写和同步全拖死（和语音台同一套做法）。 */
  const refAudioCache = new Map();
  async function saveRefAudio(char, blob, name) {
    const key = await Wb.Blobs.save(blob);
    if (char.refAudio && char.refAudio !== key) { try { await Wb.Blobs.del(char.refAudio); } catch {} refAudioCache.delete(char.refAudio); }
    char.refAudio = key;
    char.refAudioName = name || char.refAudioName || '参考音频';
    refAudioCache.set(key, { base64: await blobToBase64(blob), mime: blob.type || 'audio/mpeg' });
    return key;
  }
  /* 去掉参考音频：本机那块字节也要删掉，不然这一集不用了它还占着 IndexedDB */
  async function clearRefAudio(char) {
    if (!char || !char.refAudio) return;
    try { await Wb.Blobs.del(char.refAudio); } catch {}
    refAudioCache.delete(char.refAudio);
    char.refAudio = ''; char.refAudioName = '';
  }
  async function refAudioOf(char) {
    const key = char && char.refAudio;
    if (!key) return null;
    const hit = refAudioCache.get(key);
    if (hit) return hit;
    const b = await Wb.Blobs.get(key);
    if (!b) return null;
    const val = { base64: await blobToBase64(b), mime: b.type || 'audio/mpeg' };
    refAudioCache.set(key, val);
    return val;
  }

  /* 这一位角色的声音到底怎么来：角色身上记了 voiceMode（AI 定音色、或用户自己挑/上传时写的）
     就按它去那一家取声明了这种方式的型号；没记就按界面上选中的那个语音型号。
     返回里 fellback 为真 = 要的方式这一家没有型号，实际会退回原来那个 —— 界面必须说出来。 */
  function voiceWay(char, REG, opts) {
    const want = char && char.voiceMode;
    const v = ttsOf(REG, opts, want || undefined);
    if (!v) return { mode: 'none', model: null, prov: null, want: want || '', fellback: false };
    const real = ttsModeOf(v.model);
    return { mode: real, model: v.model, prov: v.prov, want: want || '', fellback: !!(want && want !== real) };
  }
  /* 把「这位用哪种方式」记在角色身上：这一家真有那种型号才记，没有就记实际会用的那种
     （悄悄记一个发不出去的方式，界面就会说「会自动复刻」而实际发的是预设型号）。 */
  function setVoiceWay(REG, opts, char, mode) {
    const w = voiceWay({ voiceMode: mode }, REG, opts);
    if (char) char.voiceMode = w.mode;
    return w;
  }
  /* ---------- 让文字 AI 给整集定声音 ----------
     每位角色**分开定**：出镜的按人设与外貌写一段音色描述（design 型号），或从平台声明的预设清单里挑一个（preset）；
     库里带进来的、身上已经有她本人参考音频的那位改走复刻（clone）—— 这正是「同一个平台、不同角色不同嗓子」的来处。
     两条硬规矩：
       · 音色 id **只从 voices() 那份真清单里选**（编一个 id 平台不认，要到提交时才报错）；
       · 记在角色身上的方式要这一家真有对应型号（setVoiceWay 现校验），否则记成实际会发出去的那种。 */
  /* 把文字 AI 给**一位**角色的那一条方案落到这位身上（整集 `assignVoices` 与
     「画完脸自动定音色」`autoVoice` 走的是同一份判据）。
     降级全部在这一处发生，且**每一步降级都带原因** —— AI 说「复刻」而这位没有参考音频时，
     照发下去只会得到一句平台的参数错误；静默改成预设又会让用户以为复刻成功了。
     返回 `{ ok, label, why, mode }`：不 ok 时 why 就是界面上该写的那句话。 */
  function applyVoiceRow(REG, drama, c, r, ways) {
    const want = String((r || {}).way || '').toLowerCase();
    let mode = want === 'clone' || want === 'design' || want === 'preset' ? want : '';
    let why = '';
    /* 每一次降级都**记下来并一路带到最后**。以前中途 return 的那几句只报「后来那一步」的原因，
       用户看到的是「AI 没写这段音色描述」—— 完全看不出本来要的是复刻、
       是因为没挂参考音频才退到描述这一步的。链子一长就查不出是哪一环出的问题。 */
    const bail = msg => ({ ok: false, why: (why ? why + '；' : '') + msg });
    /* 同一句原因只记一次：`bail` 会把累积的 why 再接上一句，写死赋值就会出现
       「没有本人参考音频；没有本人参考音频」这种输出 —— 看起来像程序出了鬼。 */
    const said = t => { if (!why) why = t; };
    if (!mode) return { ok: false, why: 'AI 没给这一位的方式' };
    if (mode === 'clone' && !c.refAudio) { mode = ways.design ? 'design' : (ways.preset.length ? 'preset' : ''); said('没有本人参考音频'); }
    if (mode === 'design' && !ways.design) { mode = ways.preset.length ? 'preset' : ''; said('这一家没有音色描述型号'); }
    if (mode === 'preset' && !ways.preset.length) { mode = ways.design ? 'design' : ''; said('这一家没有可选的预设音色'); }
    if (!mode) return bail(why || '这个平台没有能用的定音色方式');
    const w = setVoiceWay(REG, drama.opts, c, mode);
    if (w.mode === 'preset') {
      const hit = ways.preset.find(v => v.id === String(r.voice || '').trim()) || voiceOf(REG, drama, c).list[0];
      if (!hit) return bail('预设清单里没对上任何音色');
      c.voice = hit.id; c.voiceName = hit.name;
    }
    if (w.mode === 'design') {
      const note = String(r.note || '').trim().slice(0, 200);
      if (!note && !String(c.voiceNote || '').trim()) return bail('AI 没写这段音色描述');
      if (note) c.voiceNote = note;
    }
    if (w.mode === 'clone' && !c.refAudio) return bail('还是缺参考音频');
    c.voiceBy = 'ai';
    return { ok: true, mode: w.mode, fellback: w.fellback || !!why, why: why,
      label: w.mode === 'clone' ? '参考音频复刻'
        : w.mode === 'design' ? '声音描述：' + String(c.voiceNote || '').slice(0, 24)
        : (c.voiceName || c.voice) };
  }
  async function assignVoices(REG, drama, o) {
    o = o || {};
    const ways = ttsWays(REG, drama.opts);
    if (!ways.ok) throw new Error(ways.why);
    const chars = (drama.characters || []).filter(c => c && c.name);
    if (!chars.length) return { changed: [], skipped: [], why: '这一集还没有角色 —— 先拆完剧本或自己加两位' };
    const can = [];
    /* 顺序即优先级（2026-10 用户要求：「自动调用生成音色的模型，而不是让我选择音色」）。
       以前三行平铺，文字 AI 经常挑 preset —— 从一份固定清单里选一个 id，于是每个角色的嗓子
       都来自那十来把预置嗓子，界面上还摆一排「声音 1/2/3」让人选。
       现在把生成音色排在最前并写明「首选」，preset 明确降级为「这家没有生成音色型号时再用」。 */
    if (ways.design) can.push('design（**首选**）：写一段音色描述，这个型号照描述现造一把嗓子');
    if (ways.clone) can.push('clone：只给**已经有本人参考音频**的角色用');
    if (ways.preset.length) can.push('preset（**这家没有生成音色型号时**才用）：从下面那份预设清单里挑一个 id');
    const cast = chars.map(c => '- ' + c.name + '（' + (c.kind === 'narrator' ? '只出声的旁白' : '出镜角色') + '）：'
      + (c.bio || '') + (c.look ? '；外貌：' + c.look : '')
      + (c.refAudio ? '；已经有她本人的参考音频' : '')
      + (String(c.voiceNote || '').trim() ? '；已有的声音描述：' + String(c.voiceNote).trim() : '')).join('\n');
    const sys = fillTpl(TextAI.prompt('drama_voice'), {
      ways: can.join('\n') || '（这个平台没有可用的定音色方式）',
      preset: ways.preset.length ? ways.preset.map(v => '- ' + v.id + '｜' + [v.name, v.lang, v.gender].filter(Boolean).join(' ')).join('\n') : '（没有预设音色清单）',
      cast: cast,
    });
    const txt = o.onDelta
      ? await TextAI.chatStream(REG, sys, '请给上面每一位角色定声音，只输出 JSON。', o, o.onDelta)
      : await TextAI.chat(REG, sys, '请给上面每一位角色定声音，只输出 JSON。', o);
    const j = TextAI.parseJson(txt);
    const rows = (j && (j.roles || j.characters)) || [];
    if (!Array.isArray(rows) || !rows.length) throw new Error('文字 AI 没给出可用的音色方案（换个说法再试一次）');
    const changed = [], skipped = [];
    for (const c of chars) {
      const r = rows.find(x => x && String(x.name || '').trim() === c.name) || {};
      const got = applyVoiceRow(REG, drama, c, r, ways);
      if (!got.ok) { skipped.push({ name: c.name, why: got.why }); continue; }
      changed.push({ name: c.name, mode: got.mode, fellback: got.fellback, label: got.label, why: got.why });
    }
    if (changed.length) put(drama);
    return { changed: changed, skipped: skipped, model: (((ttsOf(REG, drama.opts) || {}).model) || {}).name || '' };
  }
  /* 「画完这位就给他定声音，并当场合成几条试听」—— 2026-10 用户要求：
     以前定音色是「认角色」之外单独一颗按钮，于是「认完角色、配音还是空的」是常态。
     这一条把顺序接上：脸与三视图画完 → 按人设定音色 → 合成 N 条试听供挑。
     **已经配好声音的一位不动**（用户自己挑过的音色 / 写过的描述不该被顺手改掉）。
     `o.onStage` 报进度，`o.cands` 传 true 时顺带合成候选（`voiceCands` 一处实现）。 */
  async function autoVoice(REG, drama, c, o) {
    o = o || {};
    const ways = ttsWays(REG, drama.opts);
    if (!ways.ok) return { ok: false, why: ways.why };
    if (voiceReady(REG, drama.opts, c).ok) return { ok: false, why: '这一位已经配好声音了，没动' };
    const stage = o.onStage || function () {};
    const can = [];
    /* 同 `assignVoices`：生成音色排最前、preset 降级为兜底。理由与措辞见那里。 */
    if (ways.design) can.push('design（**首选**）：写一段音色描述，这个型号照描述现造一把嗓子');
    if (ways.clone) can.push('clone：只给**已经有本人参考音频**的角色用');
    if (ways.preset.length) can.push('preset（**这家没有生成音色型号时**才用）：从下面那份预设清单里挑一个 id');
    const who = c.bio || c.look || c.name;
    const sys = fillTpl(TextAI.prompt('drama_voice'), {
      ways: can.join('\n') || '（这个平台没有可用的定音色方式）',
      preset: ways.preset.length ? ways.preset.map(v => '- ' + v.id + '｜' + [v.name, v.lang, v.gender].filter(Boolean).join(' ')).join('\n') : '（没有预设音色清单）',
      cast: '- ' + c.name + '（' + (c.kind === 'narrator' ? '只出声的旁白' : '出镜角色') + '）：' + who,
    });
    stage('正在按人设定「' + c.name + '」的声音…');
    let txt = '';
    try { txt = await TextAI.chat(REG, sys, '请只给上面这一个人定声音，只输出 JSON。', o); }
    catch (e) { return { ok: false, why: '定音色没成：' + ((e && e.message) || e) }; }
    const j = TextAI.parseJson(txt);
    const rows = (j && (j.roles || j.characters)) || [];
    const row = Array.isArray(rows) && rows.length ? (rows.find(x => x && String(x.name || '').trim() === c.name) || rows[0]) : {};
    const got = applyVoiceRow(REG, drama, c, row, ways);
    if (!got.ok) return { ok: false, why: got.why };
    let vc = null;
    if (o.cands) {
      stage('正在给「' + c.name + '」合成 ' + candN() + ' 条试听…');
      try { vc = await voiceCands(REG, drama.opts, c, { onStep: o.onCands }); }
      catch (e) { vc = { made: 0, failed: 0, err: (e && e.message) || String(e) }; }
    }
    return { ok: true, mode: got.mode, label: got.label, fellback: got.fellback, why: got.why, cands: vc };
  }
  /* 合成一次语音（不落盘）：试听与正式配音共用这一条，参数完全一样，
     免得「试听听着是 A、拍出来是 B」 */
  /* 语音这一步的失败要说清是**哪一家、哪个型号**：上游 502/503 时代理只回一个 `HTTP 502`，
     而 `dubShot` 把这句话原样存进 `take.error` 摆在拍片记录上 —— 用户看到的是「配音按了没动静，
     原因是一句没有主语的 HTTP 502」，完全不知道该去设置页换一家语音平台。
     这一页不做任何与钱有关的文案，所以只报「哪一家不通」，不报单价。 */
  function ttsErrText(prov, model, msg) {
    return '配音没出来：' + ((prov && (prov.displayName || prov.name)) || '语音平台')
      + ' · ' + ((model && (model.name || model.id)) || '未知型号') + ' —— ' + msg
      + '（这一家此刻不通或密钥不对；到设置页「语音」那一档换一家，或先点那一张卡上的「测试」）';
  }
  async function ttsOnce(REG, o) {
    const mode = o.mode || (o.char && o.char.voiceMode) || '';
    const v = ttsOf(REG, o.opts, mode || undefined);
    if (!v) throw new Error('没有可用的语音平台，先在设置页配好语音接口');
    const prov = v.prov, model = v.model, tts = prov.tts || {};
    /* 输出格式也按声明取（优先 wav，方便抽时长与试听）；pcm16 裸流在本地封成 WAV */
    const fmts = ((model.options || {}).formats || []);
    const fmt = fmts.length ? (fmts.includes('wav') ? 'wav' : fmts[0]) : 'wav';
    const real = ttsModeOf(model);
    let voice = o.voice || '';
    if (real === 'clone') {
      const ref = o.refAudio || await refAudioOf(o.char);
      if (!ref || !ref.base64) {
        throw new Error('「' + model.name + '」是音色复刻型号，要有参考音频：到「认角色」那一步给'
          + ((o.char && o.char.name) || '这个角色') + '上传一段声音（或换一个预设音色型号）');
      }
      voice = 'data:' + (ref.mime || 'audio/mpeg') + ';base64,' + ref.base64;
    }
    const body = { model: model.id, text: o.text, style: o.style || '', voice: voice, format: fmt,
      textRole: tts.textRole || 'assistant', styleRole: tts.styleRole || 'user', log: false };
    let res;
    try {
      res = await Api.create(prov, body);
    } catch (e) {
      const m = (e && e.message) || String(e);
      /* 已经点名是哪一家的（例如上面那两句）就别再套一层 */
      throw new Error(/^配音没出来/.test(m) ? m : ttsErrText(prov, model, m));
    }
    let b64 = Api.pickPath(res, tts.responsePath || 'choices.0.message.audio.data');
    if (!b64) throw new Error(ttsErrText(prov, model, '接口回包里找不到音频'));
    let outFmt = fmt;
    if (fmt === 'pcm16') { b64 = AiGen.b64FromBuf(AiGen.pcm16ToWav(b64, tts.pcmSampleRate || 24000)); outFmt = 'wav'; }
    return { b64: b64, format: outFmt, model: model.id, mode: real, asked: mode, provider: prov.id, usage: res.usage || null };
  }
  const AUDIO_MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac' };
  const b64ToWavBlobUrl = b64 => {
    const bin = atob(String(b64 || ''));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  };
  /* 音色试听：合成两句就够听出性格了（会真的花一点点钱，所以先问一句）。
     和正式配音走同一个 ttsOnce，所以复刻型号在这里也会用同一段参考音频。 */
  async function previewVoice(REG, char, voiceId, opts) {
    const who = (char && char.name) || '这个角色';
    /* 试听与正式配音共用 ttsOnce，音色也要走同一个 voiceOf 校验：
       否则「试听听着是 A、拍出来是 B」（角色身上是别家的旧音色 id 时最容易撞上）。 */
    const r = await ttsOnce(REG, { opts: opts, char: char,
      text: '深夜了，' + who + '还没睡。' + (char && char.voiceNote ? '（' + String(char.voiceNote).slice(0, 20) + '）' : ''),
      voice: voiceId || voiceOf(REG, { opts: opts }, char).id, style: (char && char.voiceNote) || '' });
    return b64ToWavBlobUrl(r.b64);
  }
  /* 音频时长：没有现成探测，用 <audio> 读 metadata（10 秒兜底） */
  function audioDuration(url) {
    return new Promise(res => {
      const a = new Audio();
      let done = false;
      const fin = v => { if (done) return; done = true; try { a.removeAttribute('src'); a.load(); } catch {} res(Number(v) || 0); };
      a.preload = 'metadata';
      a.onloadedmetadata = () => fin(a.duration);
      a.ondurationchange = () => { if (a.duration && isFinite(a.duration)) fin(a.duration); };
      a.onerror = () => fin(0);
      setTimeout(() => fin(0), 10000);
      a.src = url;
    });
  }
  /* 角色身上存的音色 id 可能是**别的平台的**（换了语音型号、或从素材库拉进来的那位带着旧 id）：
     照原样发过去，平台要么报错、要么静默换成默认嗓子 —— 界面写着「小雅的声音」，听到的却是另一个。
     所以按**这一位自己那个方式对应的型号**声明的清单校一眼：清单里没有就退回该型号的第一个音色，
     并让界面能说清这事。（复刻 / 设计那两个型号没有预设音色清单，清单为空时不做替换。） */
  function voiceOf(REG, drama, char) {
    const saved = (char && char.voice) || '';
    const vs = voices(REG, (drama && drama.opts) || {}, char && char.voiceMode);
    if (!vs.length) return { id: saved, stale: false, list: vs };
    if (!saved) return { id: vs[0].id, stale: false, list: vs };
    if (vs.some(v => v.id === saved)) return { id: saved, stale: false, list: vs };
    return { id: vs[0].id, stale: true, saved: saved, list: vs };
  }
  /* ---------- 声音候选：一次合成几条让你试听、挑一条 ----------
     两种情况必须分开说，因为「挑一条」改变的东西完全不同（界面按返回的 pickable 写文案）：
       · preset：候选 = 这个型号声明的音色清单里前 N 把嗓子（清单只有 2 把就只出 2 条，不摆空格），
         挑一条**真的写进 char.voice**，以后这一位的配音就按它念。
       · design / clone：这一家没有音色清单，多条只是「同一句多试几遍」。挑一条**不会**改变以后
         拍出来的声音（那声音是照描述 / 参考音频现造的）—— 所以 pickable=false，界面只给试听、
         不给一个看着能选其实什么都不换的「用这一条」（和「别编假检查」同一条规矩）。
     一次能出几条不写死：跟着设置里的「候选张数」走（默认 3），preset 再夹到清单长度。 */
  function voiceCap(REG, opts, char) {
    const w = voiceWay(char, REG, opts);
    if (w.mode === 'none') {
      const ways = ttsWays(REG, opts);
      return { n: 0, pickable: false, mode: 'none', list: [], why: ways.why || '还没配语音接口' };
    }
    const list = voices(REG, opts, w.mode);
    /* 描述 / 复刻：没有清单，一次能出几条就照设置的「候选张数」（默认 3）。 */
    if (w.mode !== 'preset') return { n: candN(), pickable: false, mode: w.mode, list: [], why: '' };
    if (!list.length) return { n: 0, pickable: true, mode: 'preset', list: [], why: '这个预设音色型号没有声明任何音色，出不了候选' };
    return { n: Math.min(candN(), list.length), pickable: true, mode: 'preset', list: list, why: '' };
  }
  /* 出候选的顺序：这位**现在用的那把**排第一 —— 一排里没有对照，就听不出新挑的那把到底换没换。 */
  function voiceCandPicks(REG, opts, char, cap) {
    if (!cap.pickable) return [];
    const cur = voiceOf(REG, { opts: opts }, char).id;
    const list = cap.list.slice();
    const i = list.findIndex(x => x && x.id === cur);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
    return list.slice(0, cap.n);
  }
  async function voiceCands(REG, opts, char, o) {
    o = o || {};
    const cap = voiceCap(REG, opts, char);
    if (!cap.n) throw new Error(cap.why || '这个平台出不了声音候选');
    const text = String(o.text || '').trim() || ('深夜了，' + ((char && char.name) || '这个角色') + '还没睡。');
    const picks = voiceCandPicks(REG, opts, char, cap);
    const n = cap.pickable ? picks.length : cap.n;
    const made = [];
    for (let i = 0; i < n; i++) {
      const v = cap.pickable ? picks[i] : null;
      const voice = v ? v.id : voiceOf(REG, { opts: opts }, char).id;
      if (o.onStep) o.onStep(i + 1, n, v ? v.name : '');
      const rec = { voice: voice, name: v ? v.name : voiceName(REG, opts, voice, cap.mode), mode: cap.mode };
      /* 一条挂了不毁整批：这一条留一句原因摆在格子里，其余的照样出（和候选图那一排同一套做法）。 */
      try {
        const r = await ttsOnce(REG, { opts: opts, char: char, text: text, voice: voice, style: (char && char.voiceNote) || '' });
        const fmt = r.format || 'wav';
        const saved = await Api.saveLocalAsset({ name: ((char && char.name) || '角色') + '-候选' + (i + 1) + '-' + Math.random().toString(36).slice(2, 6) + '.' + fmt,
          mime: AUDIO_MIME[fmt] || 'audio/wav', format: fmt, data: r.b64,
          meta: { prompt: text, model: r.model, voice: cap.mode === 'clone' ? '参考音频复刻' : (rec.name || voice),
            provider: r.provider, chars: text.length, usage: r.usage } });
        rec.src = saved.url; rec.assetId = saved.id; rec.dur = round2(await audioDuration(saved.url));
        /* 字节数记下来：「拿这条去克隆」要按 `refAudioRule` 判体积（这一家收不收得下），
           事后再去量一次既慢又可能量不到（那是本机资产地址）。 */
        rec.bytes = saved.bytes || Math.ceil((r.b64 || '').length * 3 / 4);
      } catch (e) { rec.err = (e && e.message) || String(e); }
      made.push(rec);
    }
    /* 新出的这一批排在前面（同一位同一方式下的旧候选留着，攒满上限才裁；换过一次定音色方式的旧候选不再并列）。
       只落**成了的那几条**：挂了的那几条没有地址，留在库里就是一片能点、点不开的格子。 */
    const fresh = made.filter(x => x.src);
    char.voiceCands = mergeCands(fresh, (char.voiceCands || []).filter(x => x && x.mode === cap.mode), VOICE_CAND_CAP, voiceKey);
    const errs = made.filter(x => x.err);
    return { cands: char.voiceCands, made: fresh.length, failed: errs.length,
      err: errs.length ? errs.map(x => x.err).join('；') : '',
      pickable: cap.pickable, mode: cap.mode, n: n };
  }
  /* 拿**已经生成的那条音频**去克隆（用户要求：「以后生成同一个角色可以使用之前的音色
     提示词或者使用生成的语音进行克隆」）。
     做法：把那条本机资产地址挂成 `refAudio`、方式切到 `clone`。
     之后这一位（含**下一集** —— `refAudio` / `voiceMode` 在 Lib.save / pullInto / toEpisodeChar
     三份拷贝清单里都带着）就一直按这段声音念，不会每次重新生成、每次换个样。
     为什么放在数据层：两页各写一份的话迟早对不上（素材页切了方式、拍短剧页还按描述生成）。
     判据只有两处：`ttsWays` 说这一家有没有复刻型号、`refAudioRule` 说它收不收得下这一段。 */
  function cloneFromCands(REG, opts, char, src, name) {
    const w = ttsWays(REG, opts);
    if (!w.ok) return { ok: false, why: w.why };
    if (!w.clone) return { ok: false, why: '这个平台没有「音色复刻」型号 —— 拿生成的语音去克隆要它有那一档' };
    const cand = ((char && char.voiceCands) || []).find(x => x && x.src === src);
    if (!cand) return { ok: false, why: '这一条试听已经不在了' };
    /* 体积判据走 `refAudioRule(REG, opts).rule` —— **与界面上传参考音频读的是同一份**。
       这里自己 `Capabilities.rule(型号, 'reference_audio')` 抄一遍的话，
       平台改了上限就会出现「上传不让传、拿已生成的那条却传得进去」这种前后不一；
       而传上去的是一个必失败的请求，报错还来自上游。 */
    const rule = (refAudioRule(REG, opts) || {}).rule || {};
    if (rule.maxBytes) {
      const bytes = Number(cand.bytes || 0);
      if (bytes && bytes > rule.maxBytes) {
        return { ok: false, why: '这一段 ' + Math.round(bytes / 1048576) + 'MB，超过这一家参考音频的上限 '
          + Math.round(rule.maxBytes / 1048576) + 'MB' };
      }
    }
    char.refAudio = src;
    char.refAudioName = String(name || cand.name || '生成的那一条').slice(0, 40);
    char.voiceMode = 'clone';
    /* 预设音色 id 要清掉：留着的话「方式那一排」切到预设时仍会命中它，
       而这一位现在是复刻 —— 两份配置同时成立，下一次配音取哪份就成了看运气。 */
    char.voice = '';
    char.voiceName = '';
    char.voiceBy = '';
    return { ok: true, refAudio: char.refAudio, name: char.refAudioName };
  }
  async function dubLine(REG, drama, char, text, idx) {
    const voice = voiceOf(REG, drama, char).id;
    const r = await ttsOnce(REG, { opts: drama.opts, char: char, text: text, voice: voice, style: (char && char.voiceNote) || '' });
    const fmt = r.format || 'wav';
    const name = ((char && char.name) || '旁白') + '-' + (idx + 1) + '-' + Math.random().toString(36).slice(2, 6) + '.' + fmt;
    const saved = await Api.saveLocalAsset({ name: name, mime: AUDIO_MIME[fmt] || 'audio/wav', format: fmt, data: r.b64,
      meta: { prompt: text, model: r.model, voice: r.mode === 'clone' ? '参考音频复刻' : voice,
        provider: r.provider, chars: text.length, usage: r.usage } });
    return { url: saved.url, id: saved.id };
  }

  /* 「这一句现在配好的是哪一条音频」—— 界面上「听这一句」按它取值。
     优先按 `li`（配音时记下的原台词序号），老数据没有这个字段就退回按文本匹配；
     台词被改过之后（lineDrift）一律取不到：那一格摆占位并让人重配，不放**旧台词**的音 ——
     放着会让人以为「改完这句听听就行」，其实听到的根本不是屏幕上这一句。 */
  function lineAudio(shot, take, idx) {
    const l = (shot && shot.lines || [])[idx];
    if (!l || !String(l.text || '').trim()) return { why: '' };
    if (lineDrift(shot, take)) return { why: '台词在配完这一版之后改过了，这一段的配音是旧台词的 —— 重配这一段才能听到现在这句' };
    const lines = (take && take.lines) || [];
    let hit = lines.find(x => x && Number(x.li) === Number(idx));
    if (!hit) hit = lines.find(x => x && String(x.text || '').trim() === String(l.text).trim());
    if (!hit || !hit.audio) return { why: '这一句还没配音' };
    return { src: hit.audio, dur: hit.dur, who: hit.who };
  }
  /* 一段的全部台词逐句配音（可并发，但别一次开太多） */
  async function dubShot(REG, drama, shot, take, onStep, persistCallback) {
    take.state = 'dubbing';
    take.stage = '配音'; take.error = '';
    const lines = shot.lines || [];
    const out = [];
    let t = 0.35;
    /* 三种结局都要离开 'dubbing'：配好了、已经有画面了、抛错了。
       以前这一句收尾都没写 —— take 永远停在「配音中」，于是**四件事同时坏**：
       段条与拍片记录上那条「配音中」永远不消失（其实什么都没在跑）、成片清单把这一条当成还在处理、
       `toPreview` 那句「已经配过就跳过」永远不成立（再点一次出预演 = 每一段重新合成一遍），
       而「这一条配音失败了」也永远读不出来（`t.state === 'failed'` 那句判据压根到不了）。 */
    try {
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const text = String(l.text || '').trim();
        if (!text) continue;
        if (onStep) onStep('配音 ' + (i + 1) + '/' + lines.length, i / Math.max(1, lines.length));
        /* 说话人走 lineSpeaker（先 id、再按名字兜一层），与右栏那个下拉、prereqs 同一份判据 ——
           以前这里只认 id：只有名字没有 id 的台词，右栏显示那位角色、实际发出去却是旁白的嗓子。
           id 优先仍保住了「同名不同人」那一条（剧本里有两位「阿May」不会互相抢音色）。 */
        const c = lineSpeaker(drama, l);
        const r = await dubLine(REG, drama, c || newChar({ name: l.who || '旁白', kind: 'narrator' }), text, i);
        const dur = (await audioDuration(r.url)) || estDur(text);
        out.push({ who: l.who, text: text, audio: r.url, audioId: r.id, dur: round2(dur), start: round2(t), end: round2(t + dur),
          /* `li` = 这条对应**原台词**的第几句（上面 `if (!text) continue` 会跳过空句，
             所以 out 的下标与 shot.lines 的下标从某一处起就对不上了）。
             没有它，右栏「听这一句」按序号取音会取到隔壁那句 —— 听起来像是配音配错了。 */
          li: i });
        t += dur + LINE_GAP;
        // 持久化每完成一句配音后的进度
        if (persistCallback) persistCallback();
      }
      take.lines = out;
      /* 配过音的那一条本来就已经是终态：拍片记录与预演都按这份 lines 排字幕和配音轨。
         已经有画面的那条（拍完再补配音）照旧算 done —— 「有画面」才是 done 的定义。 */
      take.state = (take.video || take.videoUrl) ? 'done' : 'dubbed';
      take.stage = ''; take.error = '';
    } catch (e) {
      /* 已经合成出来的那几句留着（每一句都是真出来的音频），但这一条整体是失败的。
         **照样把错抛给调用方** —— `shootLoop` 靠这一抛停住「别再拿这一段去拍」，
         吞掉就等于配音没成还继续拍。 */
      if (out.length) take.lines = out;
      take.state = 'failed';
      take.stage = '';
      take.error = (e && e.message) || String(e);
      throw e;
    }
    return out;
  }

  /* ---------- 6.4 拍这一段：首帧 → 视频 → 字幕 ---------- */
  /* ---------- 视频模型与它声明的档位 ----------
     短剧的画幅 / 分辨率 / 单段时长**全部来自「当前选中的视频模型」的声明**。
     入口页那几个下拉不许再写死（以前是 720p/1080p + 4:3/1:1，那是本项目自己编的一份假能力表：
     两家视频平台压根不收 720p，时长只有 4 和 15 秒）。换模型，下拉跟着变。 */
  function videoModels(REG) {
    /* Api.pickable：设置页勾掉「暂时不用」的那一家不出现在这里的档位与拍摄路径里
       （和上面 provModels 同一条路 —— 两边不一致就会出现「下拉没有它、拍的时候却用它」）。
       存着的 opts.videoModel 指向被停用的那家时，这里取不到 → videoOf 退到第一个可用型号，
       下拉里没有那一项、显示的也是同一个第一项，界面与实际发的不会分家。 */
    return Api.pickable(((REG && REG.providers) || [])
      .filter(p => p.kind === 'video' && (p.models || []).length))
      .flatMap(p => (p.models || []).map(m => ({ prov: p, model: m, key: (p.id || p.keyId) + '/' + (m.id || m.name) })));
  }
  /* 选中的那个视频模型；没选就用第一个（并记下来，别每处各选一次） */
  function videoOf(REG, modelKey) {
    const all = videoModels(REG);
    if (!all.length) return null;
    return all.find(x => x.key === modelKey) || all[0];
  }
  /* 参考图槽位的规则（数量 / 类型 / 体积上限都来自当前视频模型的声明）。
     页面以前写死「最多 4 张」—— 那个数既不是平台给的，也和统一选择器显示的依据对不上；
     平台没声明这一项时返回 max:0，界面就该明说「这个模型不收参考图」，而不是照样让人加。 */
  function refRule(REG, drama) {
    const v = videoOf(REG, drama && drama.opts && drama.opts.videoModel);
    if (!v || !window.Capabilities || !Capabilities.rule) return null;
    try { return Capabilities.rule(v.model, 'reference_image'); } catch (e) { return null; }
  }
  /* 画幅：先用模型声明的；模型没声明（没接能力接口）才退回一组常见的竖屏短剧值 */
  const FALLBACK_RATIOS = [
    { id: '9:16', label: '竖屏 9:16', w: 720, h: 1280 },
    { id: '16:9', label: '横屏 16:9', w: 1280, h: 720 },
    { id: '1:1', label: '方形 1:1', w: 960, h: 960 },
  ];
  function videoChoices(REG, opts) {
    opts = opts || {};
    const v = videoOf(REG, opts.videoModel);
    if (!v) return { ok: false, ars: [], ress: [], durs: [] };
    const o = v.model.options || {};
    const ars = o.aspect_ratios || [];
    const ress = o.resolutions || [];
    const durs = (o.durations || []).map(Number).filter(x => x > 0);
    const ratioList = (ars.length ? ars : FALLBACK_RATIOS.map(x => x.id)).map(id => {
      const f = FALLBACK_RATIOS.find(x => x.id === id);
      return { id: id, label: (f && f.label) || id, w: f ? f.w : 0, h: f ? f.h : 0 };
    });
    return {
      ok: true, prov: v.prov, model: v.model, key: v.key,
      ars: ratioList, ress: ress, durs: durs,
      declared: !!(ars.length || ress.length || durs.length),
      /* 出片尺寸按「画幅 + 分辨率」现算：画幅给宽高比、分辨率给高度，两者一拼才是真实的像素 */
      sizeOf: (ratioId, resId) => {
        const r = FALLBACK_RATIOS.find(x => x.id === ratioId) || { w: 720, h: 1280 };
        const px = Number(String(resId || '720p').match(/(\d+)/)?.[1] || 720);
        const h = px, w = Math.round(r.w / r.h * h / 2) * 2;
        return { w: w, h: h };
      },
    };
  }
  /* 画幅 / 分辨率 / 单段时长：一律按**视频模型自己声明的取值** ----------
     别拿「720p / 8 秒」这种自己定的数直接发给平台：两家视频平台声明的分辨率是
     480p/768p/960p/1080p、时长只有 **4 和 15 秒**（见 proxy.js 的 options）。
     发一个没声明的值，上游要么拒要么悄悄按默认值出片 —— 界面还写着「720p」，用户拿到的是别的东西。
     所以这里做「对齐」：选中的值不在声明里就吸到最近的那个，并把**真正会发出去的**写进 opts。 */
  function videoCaps(REG, opts) {
    const v = videoOf(REG, opts && opts.videoModel);
    const o = (v && v.model.options) || {};
    const ars = o.aspect_ratios || [];
    const ress = o.resolutions || [];
    const durs = (o.durations || []).map(Number).filter(x => x > 0);
    const tiers = o.tiers || [];
    const snap = (list, want, dflt) => {
      if (!list.length) return want;
      if (list.some(x => String(x) === String(want))) return want;
      /* 档位可能带单位（'720p' / '1080p'），所以**两边都要取出数字**再比 ——
         直接 `a - target` 在字符串上是 NaN，sort 的比较器返回 NaN 等于不排序，
         结果是所有没声明的档位全被吸到列表第一项（实测 960p/1080p 都被吸成 480p）。 */
      const nOf = v => { const m = String(v).match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
      const target = nOf(want);
      if (target == null) return dflt != null && list.includes(dflt) ? dflt : list[0];
      const scored = list.map(v => ({ v: v, n: nOf(v) }))
        .filter(x => x.n != null)
        .sort((a, b) => Math.abs(a.n - target) - Math.abs(b.n - target));
      if (scored.length) return scored[0].v;
      return dflt != null && list.includes(dflt) ? dflt : list[0];
    };
    /* 时长：**台词要念多久才是第一判据**，`want`（AI 建议 / 界面上的值）只是参考。
       以前是「先吸到离 want 最近的一档，装不下再往上调」—— 两家平台只声明 **4 和 15 秒**，
       而 AI 习惯把 wantSec 填 8：吸到 4 秒装不下 5.7 秒的台词，于是升到 15 秒。
       结果是**每一段都取 15 秒**，台词后面拖一串空镜（实测 8 段全 15 秒），正是用户报的
       「每段不必都是 15 秒」。现在反过来：先找装得下 need 的**最小**那一档。
       只有一段没有台词（need 很小）时才轮到 want 参与，而那时吸附到的正是最短档。 */
    const need = Number((opts && opts.needSec) || 0);
    const durFor = () => {
      const want = Number((opts && opts.wantSec) || 8);
      if (!durs.length) return want;
      const asc = durs.slice().sort((a, b) => a - b);
      if (need > 0) {
        const fit = asc.filter(x => x >= need)[0];
        /* 装得下就取最小那一档；连最长的都装不下时只能取最长，
           调用方靠 `tight` 知道「台词比平台能出的最长一档还长」。 */
        if (fit) return fit;
        return asc[asc.length - 1];
      }
      return snap(durs, want, (o.defaults || {}).duration);
    };
    const dur = durFor();
    return {
      prov: v && v.prov, model: v && v.model,
      ars: ars, ress: ress, durs: durs, tiers: tiers,
      ar: snap(ars, (opts && opts.ratio) || '9:16', (o.defaults || {}).aspect_ratio),
      res: snap(ress, (opts && opts.res) || '720p', (o.defaults || {}).resolution),
      dur: dur,
      tight: !!(need && durs.length && need > Math.max.apply(null, durs)),   // 台词比最长的档还长（声明的顺序不保证升序，所以现算最大值）
      padded: !!(need && dur >= need + 2),                             // 为了装下台词多出来的空镜时间
      needSec: need,
      /* 底栏那行要照实写「每段 1 条 · 重拍最多 3 次 · 768p · 每段 4 或 15 秒」 */
      line: (() => {
        const bits = [];
        if (ress.length) bits.push(snap(ress, (opts && opts.res) || '720p', (o.defaults || {}).resolution));
        if (durs.length) bits.push('每段 ' + durs.join(' 或 ') + ' 秒');
        return bits.join(' · ');
      })(),
      ok: !!v,
    };
  }
  /* 一次拍摄真正要发出去的参数（对齐后的） */
  function shootFields(REG, drama, shot) {
    /* needSec = 这一段台词念完要多久（配音按真实时长，没有就按字数估），末尾留一点收尾时间 */
    const need = estLineSec(shot) + LINE_TAIL;
    const c = videoCaps(REG, { ratio: drama.opts.ratio, res: drama.opts.res, wantSec: shot && shot.wantSec,
      needSec: need, videoModel: drama.opts.videoModel });
    return { ar: c.ar, res: c.res, dur: c.dur, model: c.model, prov: c.prov, caps: c };
  }
  /* 视频提示词：和画脸那一步一样，先让文字 AI 按设置页⑨那条指令把这一段写成
     视频模型能吃的高质量提示词；文字 AI 没配 / 失败就退回原文拼接（少润色一次，不是拍不了）。
     每段拍之前现算，所以「一句话改这一段」之后重拍一定用的是新内容。
     「人物特点」（性格、背景、外貌细节）**交给文字 AI 自己取舍**：
     以前是把 look/bio 整条无条件拼进提示词，于是一段远景里也塞着「她左手腕有颗痣」——
     无关细节挤满了提示词，真正该有的动作与镜头语言反而被冲淡。
     长相另有其人负责：角色的脸与三视图本来就作为参考图发给视频 AI，不必再用文字复述一遍。
     所以退回 plain（没配文字 AI，没人在替人判断）时只留名字。 */
  async function videoPrompt(REG, drama, shot, f) {
    const sec = (f && f.dur) || shot.wantSec || 8;
    const ar = (f && f.ar) || drama.opts.ratio || '9:16';
    const lines = (shot.lines || []).map(l => (l.who ? l.who + '：' : '') + l.text).join(' / ');
    const scene = ((drama.scenes || []).find(x => x && x.id === shot.sceneId) || {});
    const onStage = (shot.chars || []).map(id => (drama.characters || []).find(c => c && c.id === id)).filter(Boolean);
    /* 道具：整集一份，所以每段都写进提示词 —— 但**只写名字与描述，不写长相**
       （它那张图作为参考图一起发过去了，再复述一遍就是重复描述）。
       一句「道具：」把这一集认下来的物件点个名，AI 才知道哪一件该出现在画面里哪个位置。 */
    const props = (drama.props || []).filter(p => p && p.name);
    const vals = {
      open: shot.openDesc || '', shots: (shot.shots || []).map(k => k.desc
        + (k.size ? '（' + k.size + '）' : '') + (k.camera ? '（' + k.camera + '）' : '')).join('；'),
      lines: lines,
      cast: onStage.map(c => c.name).join('、'),
      traits: onStage.map(c => c.name + '：' + [c.bio, c.look].filter(Boolean).join('；')).join('\n'),
      scene: (scene.desc || scene.name || ''),
      props: props.map(p => p.name + (p.look ? '（' + p.look + '）' : '')).join('、'),
      style: shot.style || episodeStyle(drama) || '', sec: sec, ar: ar,
    };
    /* 道具那一段**拼在 plain 里而不是写进模板**：文字 AI 那条指令（drama_video）是用户自己写的，
       没有 {props} 占位符时它就整段被丢掉 —— 界面看着像「认下了道具」，成片里却还是没有那件东西。
     * `{props}` 这一个占位符留给想用它的用户；默认那句永远带得上，不靠用户改指令。 */
    const plain = fillTpl('短剧片段。{open}。镜头：{shots}。台词（角色用中文原声说出来）：{lines}。人物：{cast}（长相见参考图）。场景：{scene}'
      + (props.length ? '。道具：{props}（样子见参考图）' : '') + '。时长 {sec} 秒，{ar}，画面干净，不要字幕、不要水印。', vals);
    const tpl = TextAI.prompt('drama_video');
    if (!tpl || !TextAI.prov(REG)) return plain;
    if (!aiOk()) return plain;          /* 与生图同一条判据，不另数一份失败次数 */
    try {
      /* 道具清单**追加在指令后面**而不是塞进 {props}：那条指令是用户自己写的，
         没有这个占位符时 fillTpl 会把它整段丢掉 —— 于是「这一集认下了道具」，
         成片里却还是没有那件东西，而界面上没有任何一处提示它没进去。 */
      const ask = '请写这一段（' + sec + ' 秒）的视频提示词。'
        + (props.length ? '\n这一集认下的道具（样子见参考图，不要凭空换成别的物件）：' + vals.props : '');
      const one = await TextAI.chat(REG, fillTpl(tpl, vals), ask, {});
      aiMarkOk();
      const t = String(one || '').trim().replace(/^["'「]|["'」]$/g, '');
      return t.length >= 20 ? t : plain;
    } catch (e) { aiMarkBad(); return plain; }
  }
  /* 这一段「会发出去的素材」清单只算一份（planMaterials）：
     · 拍摄时 buildEntries 照它逐项送上去；
     · 界面照它摆「这次会自动带上什么」的芯片。
     两边各算各的话，界面上写着「三视图会作为参考图」、拍摄时却被张数上限挤掉，就是骗人。
     同步计算（只看角色身上有没有这些字段），取字节留给 buildEntries —— 芯片要能在重渲染里随手画。 */
  function planMaterials(drama, shot, model) {
    const out = { startImg: (shot && shot.startImg) || '', refs: [], audios: [], notes: [] };
    /* 机位参考图（2026-10）：用户挑中的那张机位构图图，跟着这一段发过去。
       排在**最前面** —— 它决定这一镜怎么看，人物与场景在它之后；
       放在上限检查之前，被张数挤掉时它也是最后才轮到的那一个（先保它）。 */
    if (shot && shot.camShot) out.refs.push({ src: shot.camShot, what: '这一段挑中的机位构图' });
    const chars = (shot.chars || [])
      .map(id => (drama.characters || []).find(x => x && x.id === id)).filter(Boolean);
    for (const c of chars) if (c.face) out.refs.push({ src: c.face, what: c.name + ' 的脸' });
    /* 角色的资产图紧跟在脸后面（2026-10 调整）：脸 + 资产是**身份锚点**，资产是花钱画出来的，
       道具只是这一集认下的物件。原来道具排在资产前面，而资产是「有位置才补」的那一档 ——
       一集里认了三四件道具时，资产就被整批挤出去了：钱花了，拍摄时一张都没用上。
       道具与手挑参考图都排在身份锚点之后。
       ⚠ 这一段以前是**静默整批丢弃**：`refMax > out.refs.length` 不成立时（脸刚好占满）
         整个循环都不进，界面上一个字提示都没有 —— 一个角色挂多张资产后，
         「多画的图一张没用上」就完全不可见，而上面那段注释写的设计前提恰恰是
         「界面说会带、拍摄时就真带」。所以现在：截断处**照实写进 notes**，
         并且带关联道具的资产排在同角色的其他资产前面（道具跟着人走比道具多一张更要紧）。 */
    let refMax = null;
    try { const r = window.Capabilities && Capabilities.rule(model, 'reference_image'); refMax = r && r.max != null ? Number(r.max) : null; } catch (e) { refMax = null; }
    /* 摊平成「谁的一张什么图」再排：带道具的排前面，同类型里三视图排最前（身份锚点） */
    const assetQueue = [];
    for (const c of chars) {
      const list = assetsOf(c);
      if (!list.length) continue;
      const rank = x => (x.propIds && x.propIds.length ? 0 : 2) + (x.kind === 'three' ? 0 : 1);
      list.slice().sort((a, b) => rank(a) - rank(b)).forEach(x => {
        if (!out.refs.some(r => r.src === x.src)) assetQueue.push({ c: c, a: x });
      });
    }
    if (refMax == null) {
      /* 模型没声明这个槽位上限：以前是「三视图整批跳过」，现在照实说明为什么发不出去。
         报的是**用户自己起的名字**（`assetName`）—— 这句话是给用户看「哪几张没发」，
         用模板名会和他界面上看到的对不上。 */
      if (assetQueue.length) out.notes.push('这个视频模型没有声明「参考图」槽位，' + assetQueue.length
        + ' 张角色资产（' + assetQueue.slice(0, 3).map(q => q.c.name + ' 的' + assetName(q.a)).join('、')
        + (assetQueue.length > 3 ? ' 等' : '') + '）这次一张都发不出去 —— 换一个声明了参考图的平台再拍');
    } else {
      const dropped = [];
      for (const q of assetQueue) {
        if (out.refs.length >= refMax) { dropped.push(q.c.name + ' 的' + assetName(q.a)); continue; }
        out.refs.push({ src: q.a.src, what: q.c.name + ' 的' + assetName(q.a)
          + (q.a.propIds && q.a.propIds.length ? '（连带 ' + q.a.propIds.map(pid => (drama.props || []).find(p => p && p.id === pid) || {}).filter(p => p.name).map(p => p.name).join('、') + '）' : '') });
      }
      if (dropped.length) out.notes.push(dropped.join('、')
        + ' 超出了该模型的参考图上限（' + refMax + ' 张），这次没发 —— 想让它们都发去换一个上限更大的视频型号');
    }
    /* 场景图（2026-10 补上）：这一段的场景图是「像那个地方」的根，原来**根本没进参考图** ——
       于是拍摄时角色脸对得上、场景每次都不一样，预演里画的场景图与拍出来的画面毫无关系。
       排在脸与三视图之后（身份锚点优先）、道具之前：一个场景一张，而道具整集都在，
       段数一多先被挤掉的应该是道具不是它。
       没有场景图（还没画 / 手动模式）就跳过，不占位。 */
    const sc = (drama.scenes || []).find(x => x && x.id === (shot || {}).sceneId);
    if (sc && sc.img && !out.refs.some(r => r.src === sc.img)) out.refs.push({ src: sc.img, what: (sc.name || '场景') + ' 的场景图' });
    /* 道具（2026-10）：整集一份，**每一段都带**，不像角色要挂在出场名单上。
       排在三视图与场景图之后、手挑参考图之前。 */
    for (const p of (drama.props || [])) if (p.face) out.refs.push({ src: p.face, what: p.name + '（道具）' });
    for (const s of (shot.refImgs || [])) out.refs.push({ src: s, what: '手挑的参考图' });
    /* 被上限挤掉的写进 notes（这是正常取舍，不能进 failed —— failed 会让 shoot 当场停下不拍，
       而「超出上限少发一张」不是素材坏了）。 */
    if (refMax != null && out.refs.length > refMax) {
      out.notes.push(out.refs.slice(refMax).map(x => x.what).join('、')
        + ' 超出了该模型的参考图上限（' + refMax + ' 张），这次没发');
      out.refs.length = refMax;
    }
    /* 首帧与参考图互斥（VGENV 明确「传了 frame_images 就不能再传 reference_images」）：
       界面靠 `Capabilities.blockedRoles` 早就把另一组置灰，但短剧这条路上「开头画面 + 角色脸 + 三视图」
       是默认全都想发 —— 结果第一次拍就撞 FRAME_AND_REFERENCE_INPUTS_CANNOT_BE_MIX，一段都开不出去。
       判据现算：若 model 声明 first_frame 与 reference_image 属于两个互斥 group，
       **优先保住参考图**（那是「像那个角色」的根），把「开头画面」降级成第一张参考图，
       并把这件事写进 notes —— 界面与提交体读同一份。 */
    if (out.startImg && out.refs.length && window.Capabilities && window.Capabilities.conflictMap) {
      let conflicting = false;
      try { conflicting = (Capabilities.conflictMap(model).first_frame || []).includes('reference_image'); } catch (e) { conflicting = false; }
      if (conflicting) {
        /* 有余位就把开头画面当第一张参考图带上（挤掉最后一张三视图），没有余位就直接不发首帧 ——
           两种都不如「首帧 + 参考图」齐发理想，但那是平台自己不给的组合。 */
        let demoted = false;
        if (refMax == null || out.refs.length < refMax) {
          out.refs.unshift({ src: out.startImg, what: '开头画面（当参考图）' });
          if (refMax != null && out.refs.length > refMax) out.refs.length = refMax;
          demoted = true;
        }
        out.notes.push('这个视频模型不允许「首帧」与「参考图」齐发 —— '
          + (demoted ? '这次把开头画面当参考图带过去（保住角色像不像），成片的首帧交给提示词描述。'
            : '参考图已经占满了这个模型的上限，这一次的「开头画面」没发过去（首帧由提示词描述）。'));
        out.startImg = '';
      }
    }
    /* 参考音频：两个视频平台都声明了 reference_audio 槽位（都是 1 条），
       带上它，视频 AI 的人物声音才与这位角色的音色接近；没这个槽位就不发（平台会拒）。
       多位角色各有一段参考音频时只能带一条 —— 按这一段的**说话人**优先，其次按出场顺序。 */
    let audMax = 0;
    try { const r2 = window.Capabilities && Capabilities.rule(model, 'reference_audio'); audMax = r2 && r2.max != null ? Number(r2.max) : 0; } catch (e) { audMax = 0; }
    const withAudio = chars.filter(c => c.refAudio);
    if (audMax > 0 && withAudio.length) {
      /* 「这一段的主说话人」= 第一句认得出角色的那句（lineSpeaker 同一份判据）。
         以前只找第一条带 whoId 的，名字派的那几句会直接被跳过。 */
      const speakerId = ((shot.lines || []).map(l => lineSpeaker(drama, l)).find(Boolean) || {}).id || '';
      const ordered = withAudio.filter(c => c.id === speakerId).concat(withAudio.filter(c => c.id !== speakerId));
      ordered.slice(0, audMax).forEach(c => out.audios.push({ char: c, what: c.name + ' 的参考音频' }));
      if (ordered.length > audMax) {
        out.notes.push('这个视频模型只收 ' + audMax + ' 条参考音频：带上「' + out.audios.map(x => x.char.name).join('、')
          + '」，' + ordered.slice(audMax).map(c => c.name).join('、') + ' 的声音这次没发');
      }
    } else if (withAudio.length) {
      out.notes.push('这个视频型号没有「参考音频」槽位 —— ' + withAudio.map(c => c.name).join('、')
        + ' 的参考音频不会发给视频 AI（配音照旧用它）。');
    }
    return out;
  }
  /* 输入条目：首帧 + 角色参考图 + 参考音频（字段名由 registry 的 inputTemplates 决定，页面不拼上游字段）。
     **非上传路径必须转成 dataURL**：模板是 `image_url: {url}` 的平台（VGENV）收的是一个
     能被它自己取到的公网地址，我们本机的 `/getv?url=…` 回环地址它根本访问不到 ——
     发过去的表现是「参考图被静默丢掉」或上游取图报错。视频台那边也是这么做的
     （`video-gen.html` 的 `srcToDataURL`），这里跟着同一套。 */
  async function buildEntries(REG, drama, shot, prov, model, o) {
    const entries = [];
    const failed = [];
    /* soft：这项没送上去不至于拍错人（参考音频就是 —— 成片的人声来自本机配音，
       视频平台自己那条音轨会被压掉），所以只写进 notes 说明，不让 shoot 当场停下。 */
    const notes = [];
    /* 真的进了提交体的那几项（按用途名）：拍完要能在「拍片记录」那一行回看
       「这一次到底发出去了哪些素材」—— 右栏那排芯片说的是**现在**这份数据，
       而「上一次拍的时候三视图有没有发过去」问的是那一次。 */
    const sent = [];
    const push = async (role, src, what, soft) => {
      if (!src) return;
      const bad = why => { if (soft) notes.push(what + '没能发给视频 AI（' + why + '）'); else failed.push({ role: role, what: what, why }); };
      try {
        /* 形状（要不要先上传、提交体长什么样）只在 AssetTransfer.entryFor 一处判 ——
           注册表没声明这个槽位时它给 null，这一项就不发（和以前一致）。 */
        const en = await AssetTransfer.entryFor(prov, role, src, { reg: REG, name: (shot.title || '短剧') + '-' + role });
        if (en) { entries.push(en); sent.push(what); }
      } catch (e) { bad(e.message || String(e)); }
    };
    const plan = planMaterials(drama, shot, model);
    /* 首帧有两种来源：这一段的「开头画面」（AI 画的或用户上传的），以及
       上一段拍完后自动取的**最后一帧**（link=auto 的接续，见 takeLastFrame）——
       有 linkFrame 时用它，人的样子和场景才和上一段接得上。
       **互斥模型下** linkFrame 也不能占 first_frame 槽（`planMaterials` 只处理 `sh.startImg`，
       接帧是 `o.firstFrame` 从外面递进来的 —— 于是「#1 刚拍完 → #2 用它的末帧当首帧」这条
       看起来完全正常的路劲又撞一次 FRAME_AND_REFERENCE_INPUTS_CANNOT_BE_MIXED）。
       这里把接帧当成第一张参考图，仍然把它带过去，只是换个槽位。 */
    let firstRole = 'first_frame';
    let firstWhat = (o && o.firstFrame) ? '上一段的最后一帧' : '开头画面';
    let firstSrc = (o && o.firstFrame) || plan.startImg;
    const linkIsRef = !!(o && o.firstFrame);
    if (linkIsRef && plan.refs.length && window.Capabilities && window.Capabilities.conflictMap) {
      let conflict = false;
      try { conflict = (Capabilities.conflictMap(model).first_frame || []).includes('reference_image'); } catch (e) { conflict = false; }
      if (conflict) {
        firstRole = 'reference_image';
        firstWhat = '上一段的最后一帧（当参考图）';
        notes.push('这个视频模型不允许「首帧」与「参考图」齐发 —— 这次把上一段的最后一帧当参考图带过去（角色像不像与画面接续都在），首帧交给提示词描述。');
      }
    }
    await push(firstRole, firstSrc, firstWhat);
    for (const r of plan.refs) await push('reference_image', r.src, r.what);
    /* 参考音频的字节存在本机 IndexedDB（角色对象里只有键），到这一步才去取 */
    for (const a of plan.audios) {
      let ref = null;
      try { ref = await refAudioOf(a.char); } catch (e) { ref = null; }
      if (!ref || !ref.base64) { notes.push(a.what + '在本机找不到字节（重新上传一次才能发给视频 AI）'); continue; }
      await push('reference_audio', 'data:' + (ref.mime || 'audio/mpeg') + ';base64,' + ref.base64, a.what, true);
    }
    return { entries, failed, notes: notes.concat(plan.notes), sent };
  }
  async function waitVideo(prov, taskId, onStage, timeoutMs, alive) {
    const t0 = Date.now();
    const limit = timeoutMs || 15 * 60 * 1000;
    for (;;) {
      await sleep(4000);
      /* 用户在拍片记录里按了「不等了」：立刻收手，不必再等满 15 分钟。
         任务号还留着（平台上那条多半还在跑、可能还会扣费），由 abandon 一并去取消。 */
      if (alive && !alive()) { const e = new Error('不等了'); e.abandoned = true; throw e; }
      if (Date.now() - t0 > limit) throw new Error('等了太久还没出结果，先到视频工作台看看这条任务');
      let p = null;
      /* `pollTask` 返回的 `p` **已经是 parseItem 规范化过的条目**了 ——
         再解一次会把 `output.url` 映射到已不存在的 `p.output` 上，url 直接变 undefined，
         于是「拍完了却拿不到画面」：EDL 没段、成片是空的。 */
      try { const hit = await Api.pollTask(prov, taskId); p = hit && (hit.p || hit); } catch (e) { if (onStage) onStage('拉状态失败，重试'); continue; }
      if (!p) { if (onStage) onStage('还在排队…'); continue; }
      const it = p.url || p.src ? p : (Api.parseItem(prov, p) || {});
      if (it.failed) throw new Error(it.error || '平台报这一条失败');
      if (it.done) {
        /* 产物有三种给法：外链 url（VGENV 的 output.url）、本机直链 src、资产号 assetId
           （SparkCine 的产出是资产 id，**没有** url）。以前这里只认前两种，
           用 SparkCine 拍的时候任务明明做完了却抛「没给产物地址」→ 这一段被记成失败，
           而下面 take.video 那行本来就支持 assetId（两处口径不一致）。 */
        const has = it.url || it.src || it.assetId;
        if (!has) throw new Error('平台说这条做完了，但没给产物地址（到视频工作台看这条任务的详情）');
        return it;
      }
      if (onStage) onStage(it.progress ? ('拍摄中 ' + it.progress + '%') : '拍摄中…');
    }
  }
  /* 产物 → 本机能播的地址，**只有这一份**。
     产物有三种给法：外链 url（VGENV 的 output.url）、本机直链 src、资产号 assetId
     （SparkCine 的产出是资产 id，**没有** url；签名外链会过期，走本机 /asset 直链不会）。
     以前 `shoot` 认全三种、`resumeTake` 只认前两种 —— 断点续拍接回来的是**平台已经做成功、
     钱也已经扣掉**的那一条，拿到的却是空地址：段条写「✓已选用」、播放器全黑，
     导出还报「选用的那一条没有画面（可能上次没拍完或素材丢了）」。用户看到的是「这一段白花了」。 */
  const takeVideoSrc = it => Api.mediaSrc(it.url || it.src || (it.assetId ? '/asset/' + it.assetId + '?v=2' : ''));

  /* 拍一条完整的 take */
  async function shoot(REG, drama, shot, take, onStage, persistCallback) {
    take.state = 'shooting'; take.stage = '提交'; take.error = '';
    const f = shootFields(REG, drama, shot);
    if (!f.model) throw new Error('没有可用的视频平台，先在设置页配好视频接口');
    const prov = f.prov, model = f.model;
    /* 提示词里写的是「这一段实际会发出去的那一档」，别写用户选的那个没声明的值 */
    take.applied = { ar: f.ar, res: f.res, dur: f.dur, model: model.id, provider: prov.id,
      chained: take.linkFrame ? '上一段末帧' : '本段开头画面' };
    const { entries, failed, notes, sent } = await buildEntries(REG, drama, shot, prov, model, { firstFrame: take.linkFrame });
    take.notes = notes || [];
    /* 这一条真的发出去过哪些素材（用途名，不是地址）—— 拍片记录那一行据此回看得住。 */
    take.applied.mats = sent;
    /* 素材没送上去**不能当作没事发生**：短剧的脸与首帧就是「像不像那个角色」的根，
       少了它们平台照样出一段片、照样扣钱，用户拿到的是毫不相干的一条。
       所以这里当场停下并说清楚是哪几项、为什么 —— 不花那笔钱。 */
    if (failed.length) {
      throw new Error('这一段的' + failed.map(x => x.what).join('、') + '没能送上去（'
        + failed.map(x => x.why).join('；') + '）—— 拍出来就不是那个角色了。先把图传上去，或换一个平台再拍。');
    }
    const fields = { model: model.id, prompt: await videoPrompt(REG, drama, shot, f), duration: f.dur,
      res: f.res, ar: f.ar, inputEntries: entries };
    if (onStage) onStage('提交拍摄任务（' + f.res + ' · ' + f.ar + ' · ' + f.dur + ' 秒）…');
    const d = await Api.request(prov, 'create', {
      method: 'POST',
      headers: { 'Idempotency-Key': take.id || crypto.randomUUID() },
      /* ⚠ `prompt` **必须显式写进 log**，不能指望 `Api.request` 从 `body` 里捡：
         `body` 是 `Api.createBody` 按注册表映射过的（各家把 prompt 放在顶层还是 parameters 里各不相同），
         而 `Api.create` 那条路会先把 fields.prompt 注入 log —— `shoot` 直接调 `Api.request`，
         绕过了那一段注入。vgenv / minimax 这类平台**接口本身不返回提示词**，
         资产库显示提示词全靠本机归档（PromptLog → `/prompts`），漏了这一句的表现是
         资产库那条视频写着「（该平台接口不返回提示词，本机归档里也没有这条）」——
         而钱已经花了、画面就在库里，只是没人记得当时用的是哪句话。 */
      log: { type: '短剧-拍摄', prompt: fields.prompt,
        meta: { 短剧: drama.title, 段: shot.no + ' ' + shot.title, 画幅: f.ar, 分辨率: f.res, 时长: f.dur + 's' } },
      body: Api.createBody(prov, fields),
    });
    if (d && d.error) throw new Error(d.error.message || '创建失败');
    const p0 = Api.parseItem(prov, d) || {};
    take.taskId = d.id || p0.assetId || '';
    take.taskProvider = prov.id;
    if (!take.taskId) throw new Error('平台没给任务号');
    /* 任务号是**提交之后**才有的，而归档要按任务号索引（资产库是拿它去查提示词的）。
       提交那一刻归档接口只从 create 响应的顶层猜 id（`d.id` / `d.task_id` / `d.job_id`），
       有的平台把 id 嵌在别处（`data.id` 之类）就一条都写不出来 —— 那是「平台接口不返回提示词、
       本机归档里也没有这条」最常见的成因。所以这里拿准了的任务号**再兜一次**：
       已经有记录就不重复写（同一份提示词存两遍，归档列表会出现两条一模一样的）。 */
    try {
      if (window.PromptLog && fields.prompt && take.taskId) {
        const have = Api.promptFor(prov.id, take.taskId);
        if (!have) {
          PromptLog.save(REG || { providers: [] }, { type: '短剧-拍摄', prompt: fields.prompt,
            model: model.id, provider: prov.id, task: take.taskId,
            meta: { 短剧: drama.title, 段: shot.no + ' ' + shot.title, 画幅: f.ar, 分辨率: f.res, 时长: f.dur + 's' } });
        }
      }
    } catch (e) { /* 归档失败不该让这一段算拍失败：画面已经出来了 */ }
    // 持久化任务ID
    if (persistCallback) persistCallback();
    const it = await waitVideo(prov, take.taskId, onStage, undefined, () => !take.abandoned);
    /* 产出是资产号时（SparkCine）走本机 /asset 直链：签名外链会过期，直链不会（判据见 takeVideoSrc） */
    take.videoUrl = takeVideoSrc(it);
    take.video = it.assetId || take.videoUrl;
    take.sec = Number(it.duration) || f.dur;
    take.state = 'done'; take.stage = '完成';
    if (!shot.chosen) shot.chosen = take.id;
    return take;
  }

  /* ---------- 断点续拍：刷新 / 关掉网页再回来，接着等上一次没等完的活 ----------
     take.taskId 是**已经提交出去**的任务号（提交那一刻就写盘了），所以重新打开页面
     只要拿它去问一次平台就知道结果了 —— 不用重新提交（重新提交会重复扣费）。
     这是「关掉网页也会接着拍」能落地的部分：活交给平台跑，本机这边只负责等。 */
  async function resumeTake(REG, drama, shot, take, onStage) {
    if (!take || take.state === 'done' || take.state === 'failed') return false;
    const prov = ((REG && REG.providers) || []).find(p => p.id === take.taskProvider);
    /* 其余情况要去平台问结果，必须有任务号（提交那一刻就写盘了） */
    if (!take.taskId || !prov) return false;
    /* 还在跑：接着等。**等要有上限** —— 续拍是打开页面时的后台活，
       平台一直报错时不能对着一个 15 分钟的循环干等用户（`waitVideo` 本身是给「正在拍」用的长等）。 */
    if (onStage) onStage('这一条上次提交过了，接着等结果…');
    try {
      const it = await waitVideo(prov, take.taskId, onStage, RESUME_WAIT_MS);
      take.videoUrl = takeVideoSrc(it);
      take.video = it.assetId || take.videoUrl;
      take.sec = Number(it.duration) || take.sec || shot.wantSec;
      take.state = 'done'; take.stage = '完成';
      if (!shot.chosen) shot.chosen = take.id;
      return true;
    } catch (e) {
      take.state = 'failed';
      take.error = /等了太久/.test(e.message)
        ? '等了很久平台还没给出结果，任务号 ' + take.taskId + ' —— 到视频工作台能找到这一条'
        : ('接着等的时候失败：' + e.message);
      return false;
    }
  }
  /* 开拍前的前置条件 —— **缺了就在开拍前说清楚**，别让人拍完才发现、又白花一次视频的钱。
     这里现在就是**唯一**一道「配齐了才准花钱」的闸门（以前还有一道拍完的质检，那是钱花完才判）：
     角色没定音色照样能点「开始拍」，拍出来的那一条用户只能丢掉重来（每次都真扣钱），
     而根子只是没去点一下音色。
     只查**这一集真正要用到**的角色/段：旁白不用脸，但旁白也要有声音（它念台词）。 */
  /* 「音色这一项到底要什么」跟着当前语音型号声明的 ttsMode 走：
     用错判据就会出现「明明配好了，界面还一直喊没定音色」，或者反过来 —— 配音当场失败。 */
  /* 前置条件里的「声音」那一栏：按**每一个角色自己**的定音色方式判（voiceReady 是同一份判据，
     不再整集套一个 mode）—— AI 可能把小雅定成复刻、把旁白定成预设，套一个 mode 就会说错「缺什么」：
     界面让人去上传参考音频，而那位其实用的是预设音色。 */
  function voiceMiss(REG, opts, c) {
    const r = voiceReady(REG, opts, c);
    return r.ok ? null : { mode: r.mode, why: r.why };
  }
  const VOICE_LABEL = { preset: '还没定音色', design: '还没写声音描述', clone: '还没上传参考音频', none: '还没配语音接口' };
  function prereqs(drama, shot, REG) {
    const out = [];
    if (!drama) return out;
    const shots = shot ? [shot] : (drama.shots || []);
    /* 要用到哪些角色只有一份判据（usedCharsOf）：出场名单 ∪ 每一句的说话人。
       说话人下拉列的是**全集**角色、不限于出场名单 —— 只按 sh.chars 查的话，
       把某句改派给一位没画脸、没定音色的角色，前置条件照样全绿，
       而配音那一步会静默拿第一把嗓子顶上去，出来的人声与选定的不是同一个人。
       取值仍按**角色表顺序**过一遍（原来就是这么排的）——「点一下去修」要指向同一个人。 */
    const usedIds = new Set();
    for (const sh of shots) for (const c of usedCharsOf(drama, sh)) usedIds.add(c.id);
    const inUse = (drama.characters || []).filter(c => c && usedIds.has(c.id));
    const noFace = inUse.filter(c => c.kind !== 'narrator' && !c.face);
    if (noFace.length) out.push({ key: 'face', label: '还没画脸', who: noFace.map(c => c.name).join('、'),
      why: '画不了脸就认不出同一个人，视频平台也没法保持这一集里她的样子一致。', fix: 'cast', cid: noFace[0].id });
    const miss = inUse.map(c => ({ c: c, m: voiceMiss(REG, drama.opts, c) })).filter(x => x.m);
    if (miss.length) {
      /* 同一类原因合并成一行（三位角色都缺参考音频，别排三条一样的话） */
      const byLabel = {};
      for (const x of miss) {
        const k = VOICE_LABEL[x.m.mode] || '还没定声音';
        (byLabel[k] || (byLabel[k] = { who: [], why: x.m.why, mode: x.m.mode, first: x.c.id })).who.push(x.c.name);
      }
      for (const k of Object.keys(byLabel)) {
        const g = byLabel[k];
        out.push({ key: 'voice', label: k, who: g.who.join('、'),
          why: g.why + '（' + g.who.join('、') + '）', fix: g.mode === 'none' ? 'settings' : 'cast', cid: g.first });
      }
    }
    /* 「没有台词」只对**确实写了台词行、却一行字都没填**的那些段成立。
       一段里根本没有台词行是正常的空镜 —— 右栏那一格本来就写着「纯空镜也行」，
       以前这里把两种都算「没有台词」：该点的没点，和不该拦的拦了（纯空镜不让拍），
       界面自己打自己的脸。 */
    const blankLine = shots.filter(sh => (sh.lines || []).length
      && !(sh.lines || []).some(l => String(l.text || '').trim()));
    if (blankLine.length) out.push({ key: 'line', label: '台词都空着',
      who: blankLine.map(sh => '第 ' + sh.no + ' 段').join('、'),
      why: '这几段留了台词行、但一行字都没写 —— 拍出来那几句既没内容也没有声音。',
      fix: 'shot', shot: blankLine[0] });
    return out;
  }

  /* ---------- 6.5 拍摄调度：同场景串行接帧，异场景并发 ----------
     文字 AI 在每段上写了 link：'auto' = 和上一段同一个场景、人接着上一段的状态；
     'off' = 换了场景或不需要相接。所以拍摄顺序是这样算出来的：
       · link=auto 的段**必须等前一段拍完**才能取到它的最后一帧，于是它们串成一条链；
       · 链与链之间没有依赖，**可以并发**跑。
     并发上限从 2 提到 6（2026-10 用户要求「多段应该同时提交」）：8 段全是 link=off 时
     就是 8 条链，原来一次只跑 2 条、其余排队 —— 平台那边是等得起的（每段各发一次），
     而用户看到的是「8 段要跑十几分钟」。6 是与生图那边 FILL_CONC 同一个取法：
     再高就容易撞上游的速率限制，一次被拒就是整批重来。 */
  const PARALLEL_CHAINS = 6;
  /* 简易并发池：给一批任务 + 一个上限，池子按上限开工，谁先完谁腾位。
     以前长在 drama.html 里（补画角色 / 场景两条池子共用），素材库页「一次出齐这一档」要的是
     同一件事 —— 抄第二份就会出现「一边串行 6 张、一边并发 6 张」两种手感。
     任何一条抛错都吞掉（调用方的记账自己落 err），池子继续跑；
     整批不因为某一位画砸就停 —— 那是「一张都没出来」的成因。 */
  async function runPool(list, cap, worker) {
    if (!list || !list.length) return;
    const q = list.slice();
    const n = Math.max(1, Math.min(cap | 0, q.length));
    const runners = [];
    for (let i = 0; i < n; i++) {
      runners.push((async () => {
        while (q.length) {
          const item = q.shift();
          try { await worker(item); } catch (e) { /* 调用方已经记过账，这里不再吞第二次 */ }
        }
      })());
    }
    await Promise.all(runners);
  }
  function chainPlan(drama) {
    const shots = (drama.shots || []).slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    const chains = [];
    let cur = null, prevSid = '';
    for (const sh of shots) {
      const link = (sh.link || 'auto') === 'auto';
      /* 串链的两个条件缺一不可：**link=auto**（AI 说人接着上一段的状态）**且还在同一个场景**。
         以前只看 link，于是 AI 把「换了地点」那一段也写成 auto 时，
         那一段会拿**上一个场景**的最后一帧当开头画面 —— 等于把镜头从别的场地接过来，
         画面里的人物姿态和背景都对不上。链内串行的前提是「同一场戏的下一镜」，
         地点变了就该断开（断开的段还能并发拍，反而更快）。 */
      const sameScene = !prevSid || !sh.sceneId || sh.sceneId === prevSid;
      if (link && cur && sameScene) cur.push(sh);
      else { cur = [sh]; chains.push(cur); }
      if (sh.sceneId) prevSid = sh.sceneId;
    }
    /* 链上除第一段外都会走「末帧 → 首帧」这条接续（判据与上面那一行同源，别各写一套） */
    return chains.map(list => ({
      shots: list,
      chained: list.filter((s, i) => i > 0 && (s.link || 'auto') === 'auto' && sameSceneAs(list, s)).map(s => s.no),
    }));
  }
  const sameSceneAs = (list, sh) => {
    const i = list.indexOf(sh);
    if (i <= 0) return false;
    const a = list[i - 1].sceneId, b = sh.sceneId;
    return !a || !b || a === b;
  };
  /* 「这一段要不要接上一段的末帧、接的是谁的那一条」—— 判据只有一份，批量与单段都读它。
     两个条件缺一不可：link=auto（AI 说人接着上一段的状态）**且还在同一个场景**。
     以前单段重拍那条路只判 link，于是会出现「批量拍接得上、重拍这一段接不上」
     （或者反过来：跨了场景还硬接，把上一个场地的末帧当这一段的首帧）。 */
  function linkSource(drama, shot) {
    if (!shot || (shot.link || 'auto') !== 'auto') return null;
    const list = (drama.shots || []).slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    const i = list.findIndex(x => x && x.id === shot.id);
    if (i <= 0) return null;
    const prev = list[i - 1];
    if (!prev) return null;
    const a = prev.sceneId, b = shot.sceneId;
    if (a && b && a !== b) return null;              // 换了地点，接过来就是从别的场地拉一个镜头
    return { prev: prev, take: chosenTake(drama, prev) };
  }
  /* 上一段的最后一帧 → 本机资产（/local-assets）。
     为什么不直接用 blob：buildEntries 要能把它取回字节（转 dataURL 或上传成平台资产），
     blob: 地址在刷新后就没了、也跨不了标签页；存成本机资产才扛得住「关掉网页接着拍」。 */
  async function takeLastFrame(drama, shot, take) {
    const src = takeVideo(drama, shot, take);
    if (!src) throw new Error('上一段没有画面，取不到最后一帧');
    if (!window.Wb || !Wb.vframe) throw new Error('取帧组件没加载（workbench.js）');
    const g = await Wb.vframe.grab(src, 'last');
    const b64 = await new Promise((res, rej) => {
      const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(',')[1] || ''); rd.onerror = rej; rd.readAsDataURL(g.blob);
    });
    const saved = await Api.saveLocalAsset({
      name: '短剧末帧-' + (shot.no || 0) + '-' + Math.random().toString(36).slice(2, 6) + '.png',
      mime: 'image/png', format: 'png', data: b64,
      meta: { prompt: '第 ' + shot.no + ' 段最后一帧（自动作下一段的首帧参考）', provider: 'local' },
    });
    return saved.url;
  }

  /* ---------- 6.6 步骤闸门 ----------
     讲故事 → 认角色 → 看预演 → 拍成片。**前面没做完不给跳**（跳过去看到的是空界面，
     点了只会报「还没有…」），但「我自己排」（opts.manual）是**另一条合法的路**：
     不靠文字 AI 拆剧本，角色 / 场景 / 分段都在界面上手动加 —— 这条路照样要过同一道前置条件，
     只是不再要求「AI 已经拆过」。 */
  function stepGate(drama, no, reg) {
    const shots = (drama && drama.shots) || [];
    const manual = !!(drama && drama.opts && drama.opts.manual);
    if (no <= 1) return { ok: true };
    if (!shots.length) {
      return { ok: manual, why: manual ? '手动模式：在第 2 步自己加角色、场景和段落' : '还没有剧本 —— 先回到第 1 步写故事，或到「高级设置」勾上「我自己排」再手动加段落', fix: 1 };
    }
    if (no >= 4) {
      /* 开拍这一关就是前置条件本身：缺脸 / 缺声音 / 缺台词都会白拍一条 */
      const bad = prereqs(drama, null, reg);
      if (bad.length) return { ok: false, why: bad.map(x => x.label + '：' + x.who).join('；'), fix: 2, pre: bad };
    }
    return { ok: true };
  }

  /* 扫全片，把没等完的都接上。
     shouldStop 是「□ 停下」：原来这个按钮在这里也按一下 toast「收到」就继续等 ——
     续拍是**串行**的（一次一条），三条没等完就是六分钟，按了停下却一条都不停。 */
  async function resumeAll(REG, drama, onStep, shouldStop) {
    const out = [];
    let stopped = 0;
    for (const sh of (drama.shots || [])) {
      for (const t of (sh.takes || [])) {
        if (t && t.abandoned) continue;          // 用户已经说「不等了」：刷新回来也不该又把它等一遍
        if (shouldStop && shouldStop()) { stopped++; continue; }   // 剩下的原样留在 takes 里，下次刷新接着接
        if (onStep) onStep('第 ' + sh.no + ' 段 · ' + (t.stage || t.state));
        try { if (await resumeTake(REG, drama, sh, t, onStep)) out.push({ sh: sh, take: t }); } catch {}
      }
    }
    if (stopped) out.stopped = stopped;
    return out;
  }

  /* 这一段选中的那条片子用什么地址播 —— 页面别自己读 take.videoUrl。
     再过一次 mediaSrc：存下来的是当时的 /getv?url=<签名外链>，放几天就过期；
     公共层只查会话内的回源表（不发请求），换到过就顶上新地址，没换到仍给旧的。 */
  function takeVideo(drama, shot, take) {
    if (!take) return '';
    if (take.videoUrl) return Api.mediaSrc(take.videoUrl);
    if (take.video) return Api.mediaSrc(take.video);
    return '';
  }
  /* 拍完的片子存的是**当时**的签名外链（VGENV 的 OSS 地址只管一天）。放两天再打开这一集，
     每条 take 都是「点了没画面」，而界面完全说不出原因。过期判定与按平台整批回源只在
     `Api.healMedia` 有一份，这里只负责把换到的新地址写回 take 并叫页面落盘重画。 */
  async function healTakes(drama, onFresh) {
    if (!drama || !Api.healMedia) return 0;
    const recs = [];
    for (const sh of (drama.shots || [])) for (const t of (sh.takes || [])) {
      if (t && t.taskId && t.videoUrl && Api.mediaExpired(t.videoUrl)) {
        recs.push({ provider: t.taskProvider, id: t.taskId, url: t.videoUrl, _t: t });
      }
    }
    if (!recs.length) return 0;
    return Api.healMedia(recs, {
      limit: 60,
      onFresh(rec, next) { rec._t.videoUrl = next; if (onFresh) onFresh(rec._t); },
    });
  }
  const chosenTake = (drama, shot) => {
    const takes = (shot && shot.takes) || [];
    if (shot && shot.chosen) {
      const t = takes.find(x => x && x.id === shot.chosen);
      if (t) return t;
    }
    // 兜底只在 state === 'done' 的里面取（最后一条），不看有没有画面
    const done = takes.filter(t => t && t.state === 'done');
    if (done.length) return done[done.length - 1];
    return null;
  };

  /* 这一段的逐句配音（成片里要有声音，靠的就是这条轨）。
     每条 { src, start, dur } 的 start/dur 来自**配音那次的真实时长**（ttsOnce 量出来的），
     与字幕轨同一套约定：相对本段起点，由代理按本段实际长度对齐，绝不在客户端累加绝对偏移。 */
  function takeVoices(shot, take) {
    const lines = (take && take.lines && take.lines.length) ? take.lines : [];
    return lines.filter(l => l && l.audio).map(l => ({
      src: l.audio, start: round2(Math.max(0, Number(l.start) || 0)),
      dur: round2(Math.max(0.1, Number(l.dur) || estDur(l.text || ''))), vol: 1,
    }));
  }
  /* 成片的 EDL。**没有画面的段要能被看见**：
     静默跳过的后果是「导出来的成片少了那几段，而下载的字幕里还有它们的台词」——
     字幕和画面对不上，比直接报错更难查。所以返回时一并带上缺哪几段。 */
  function edlCheck(drama) {
    const clips = [], missing = [], warns = [];
    for (const sh of (drama.shots || [])) {
      const t = chosenTake(drama, sh);
      if (!t) { missing.push({ no: sh.no, title: sh.title, why: '还没选用任何一条' }); continue; }
      const src = takeVideo(drama, sh, t);
      if (!src) { missing.push({ no: sh.no, title: sh.title, why: '选用的那一条没有画面（可能上次没拍完或素材丢了）' }); continue; }
      /* 外链过期且**没有回源可能**的那条也要摆进 missing：地址非空，上面那道判不出来，
         一路送到 ffmpeg 才 403，界面报的是「渲染失败」—— 真正的原因是「素材链接过期」，
         那是重拍或等 healTakes 回源换新才能解决的，重试渲染没有用。
         判据与 healTakes 一致：有 taskId + taskProvider 才回源得到新地址。 */
      const canHeal = !!(t.taskId && t.taskProvider);
      if (!canHeal && t.videoUrl && Api.mediaExpired && Api.mediaExpired(t.videoUrl)) {
        missing.push({ no: sh.no, title: sh.title, why: '素材链接已过期，而且这一条没有任务号可以回源换新 —— 只能重拍一次' });
        continue;
      }
      /* 「成片里要不要有配音、要不要烧字幕」是导出时的两个开关（drama.opts.dub / .sub，默认都要）。
         volume: 0 = 压掉视频平台自己生成的那路人声 —— 那是因为台词是逐句合成好的，
         两路人声叠在一起既听不清也会串味。**所以关掉配音时要把 volume 放回 1**：
         再压着就是一条又没配音、又没原声的哑片（那不是任何人想要的）。
         两条都要真的从 EDL 里去掉，代理只认 EDL；预演与下载的 SRT 不受这两个开关影响。 */
      const o = drama.opts || {};
      const dub = o.dub !== false, sub = o.sub !== false;
      /* 「拍完之后又改了台词」也得摆进同一张告诫表。它和上面那条是同一类问题：
         成片照渲不误，渲完才发现里面说的一直是旧那几句 —— 而右栏剧本摆着的是新的。
         **只报不拦**：这一段本来就能进成片（也可能用户要的正是已经拍好的那一版），
         判据是 lineDrift，配音与字幕一律按拍摄那一刻的快照来。 */
      const drift = lineDrift(sh, t);
      if (drift) {
        warns.push({ no: sh.no, title: sh.title, kind: 'lines',
          why: '拍完之后改过台词（拍的时候 ' + drift.shot + ' 句，现在 ' + drift.now
            + ' 句），成片里说、烧的仍是原来那几句 —— 要换新的得重新配音' });
      }
      clips.push({ src: src, in: 0, out: Number(t.sec) || (sh.wantSec || 8), volume: dub ? 0 : 1,
        subs: sub ? takeSubs(sh, t) : [], voices: dub ? takeVoices(sh, t) : [] });
    }
    return { clips, missing, warns };
  }

  /* 「后面几段接的还是上一段的旧末帧」—— 链路接续是这一整集能连上看的原因，
     而它**会悄悄作废**：1|2|3 串成一条链时，第 3 段是拿第 2 段**那一次**的最后一帧去拍开头画面的。
     用户回头把第 2 段重拍了一次，第 3 段选用的那一条仍然是拿**上一版**第 2 段接的 ——
     人物在两段之间的姿态对不上，成片里一眼能看出接缝，而界面上没有任何一个字提到这件事。
     判据只有一条：某段选用的那一条 `linkFrom` 记的那一次，已经不是它上一段现在选用的那一条。
     **只报，不拦**：接不接得上由用户定（也可能那一段拍得本来就看不出差别）。 */
  function staleChains(drama) {
    const out = [];
    if (!drama) return out;
    const list = (drama.shots || []).slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    for (let i = 1; i < list.length; i++) {
      const sh = list[i];
      if ((sh.link || 'auto') !== 'auto') continue;         // 这一段本来就不接上一段
      /* 跨了场景的段现在**根本不会接帧**（见 linkSource），拿它去比「接的还是不是旧末帧」
         是一条永远成立的假警报 —— 每渲一次就弹一次，弹到第三次用户就不看了。 */
      if (list[i - 1] && list[i - 1].sceneId && sh.sceneId && list[i - 1].sceneId !== sh.sceneId) continue;
      const t = chosenTake(drama, sh);
      if (!t || !t.linkFrom) continue;                       // 没接帧，或拍的时候上一段还没拍好
      const prev = list[i - 1];
      const pt = chosenTake(drama, prev);
      if (!pt || pt.id === t.linkFrom) continue;             // 还是接着现在这一版 —— 没问题
      const from = (prev.takes || []).find(x => x && x.id === t.linkFrom);
      out.push({ no: sh.no, title: sh.title, prevNo: prev.no, fromNo: from ? from.no : 0, toNo: pt.no || 0 });
    }
    return out;
  }

  /* 一段文本的短指纹（只为了别把整篇台词塞进成片指纹里）—— djb2 变体，够判「变了没有」用。
     判据只用在这一处：成片指纹。页面拿 finalStamp 与 renderSpec().stamp 直接比字符串，
     两者都由这里算，所以页面自己看不到这个函数、也不该另写一份。 */
  function strHash(s) {
    let h = 5381;
    const t = String(s || '');
    for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function renderSpec(drama, REG) {
    /* 成片尺寸按「当前视频模型声明的画幅 × 分辨率」现算，不再用页面自己那张写死的表 */
    const ch = videoChoices(REG || { providers: [] }, { videoModel: drama.opts && drama.opts.videoModel });
    const cap = videoCaps(REG || { providers: [] }, { videoModel: drama.opts && drama.opts.videoModel,
      ratio: drama.opts && drama.opts.ratio, res: drama.opts && drama.opts.res });
    const size = (ch.ok ? ch.sizeOf(cap.ar, cap.res) : { w: 720, h: 1280 });
    /* EDL 与「缺哪几段」必须**同一次扫描**出来（edlCheck 一次给全）：
       以前这里只取 clips，missing 由 `render()` 去读 spec.missing —— 那字段根本不存在，
       `undefined.length` 当场 TypeError，于是点「导出整集」必抛错、界面看着像按钮没反应。 */
    const edl = edlCheck(drama);
    const w = Math.max(64, Math.round(size.w / 2) * 2), h = Math.max(64, Math.round(size.h / 2) * 2);
    /* 成片指纹：这一版是**按什么**渲出来的（每条用哪一次、什么开关、什么画幅、有没有配乐）。
       导出成功时存进 drama.finalStamp；之后任何一次改动（重拍、改台词、改配音/字幕开关、换画幅、
       换配乐）都会让它对不上 —— 页面据此说「成片是旧的」并给一条重新导出。
       以前只要 finalVideo 非空，那个位置就永久变成下载按钮：重拍过也照样给旧成片，一句提示都没有。
       **字幕与配音按内容取指纹，不按条数**（以前只有 `.length`）：改一个字的台词、或者重新配了一遍音，
       条数一点没变、指纹照样对得上，于是「成片是旧的」永远不出现 —— 而成片里说的一直是旧的那几句。
       整篇台词拼进 JSON 会让指纹长到几 KB，所以过一道短哈希；哈希算法只在这里，页面不许自己拼。 */
    const stamp = JSON.stringify({
      c: edl.clips.map(x => [x.src, x.out, x.volume,
        strHash((x.voices || []).map(v => v.src).join(',')),
        strHash((x.subs || []).map(s => s.start + '~' + s.end + '\u0001' + (s.speaker || '') + '\u0001' + s.text).join('|'))]),
      w: w, h: h, b: (drama.opts && drama.opts.bgm) || '',
    });
    return {
      name: (drama.title || '短剧') + ' 整集',
      width: w, height: h,
      fps: 25, crf: 21,
      subFont: drama.opts.subFont || 'Microsoft YaHei',
      bgm: drama.opts.bgm || null,
      clips: edl.clips,
      missing: edl.missing,
      stamp: stamp,
    };
  }
  /* 提交渲染 + 轮询（本地长任务：不设超时、不自动重试）
     shouldStop 是页面那个「□ 停下」：ffmpeg 卡住、素材大的时候原来只能干等满 900 秒。
     代理那边 `/render/cancel` 早就写好了（杀 ffmpeg 子进程 + 从队列摘掉），只是没人调它。 */
  async function render(drama, onStage, REG, shouldStop) {
    const spec = renderSpec(drama, REG);
    if (spec.missing.length) {
      throw new Error('有 ' + spec.missing.length + ' 段还进不了成片：'
        + spec.missing.map(x => ('第 ' + x.no + ' 段' + (x.title ? ' ' + x.title : '') + '（' + x.why + '）')).join('；')
        + ' —— 先把它们拍出来、选用一条再导出。');
    }
    if (!spec.clips.length) throw new Error('还没有拍好的段落');
    /* 导出前先问一句本机有没有 ffmpeg：没装 / 不在 PATH / 装的是 Windows 商店那个占位壳，
       代理那边都只回「无法启动 ffmpeg」，看不出是哪一种，而且这一步已经等了几十秒。
       取法与「不能用」那句话说成什么都走 Api.sysStatus / Api.sysTool（设置页那一栏、助手体检同一份）。
       只有**探明不能用**才拦：旧代理没有这个接口（404）、或这一问本身超时/断连，都不该拦住一次正常导出 ——
       代理那一步本来就会给出它自己看到的错，多一道闸只会把「体检读不到」说成「你 ffmpeg 坏了」。 */
    let ffWhy = '';
    try {
      const sy = await Api.sysStatus();
      const t = Api.sysTool(sy && sy.ffmpeg);
      if (t.chip === '不能用') ffWhy = t.why || '不能用';
    } catch (e) { /* 读不到就当没探到，照常提交 */ }
    if (ffWhy) {
      throw new Error('这台机器合成不了成片：ffmpeg ' + ffWhy
        + ' —— 装好（或把它加进 PATH）再点导出，设置页「本机环境」那一栏可以重新探一次');
    }
    const r = await Net.fetch('/render', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec), timeout: 0, retry: 0 });
    if (!r.ok) throw new Error('提交渲染失败 HTTP ' + r.status);
    const j = await r.json();
    for (let i = 0; i < 900; i++) {
      await sleep(1000);
      /* 停下 = 真的把 ffmpeg 杀掉，不是界面不再等了（不减本地 CPU/磁盘） */
      if (shouldStop && shouldStop()) {
        try {
          await Net.fetch('/render/cancel?id=' + encodeURIComponent(j.id), { method: 'POST', timeout: 10000, retry: 0 });
        } catch (e) { /* 取消请求本身失败也照样收工，别把人卡在这一步 */ }
        const err = new Error('已取消渲染（底栏「停下」按的）');
        err.cancelled = true;
        throw err;
      }
      const s = await Net.fetch('/render/status?id=' + encodeURIComponent(j.id), { timeout: 15000 });
      if (!s.ok) continue;
      const st = await s.json();
      if (onStage) onStage((st.stage || '渲染') + ' ' + (st.progress || 0) + '%', st.progress);
      if (st.state === 'done') { drama.finalVideo = st.out; drama.finalName = st.out; drama.finalStamp = spec.stamp; return st; }
      if (st.state === 'failed') throw new Error(st.err || '渲染失败');
      if (st.state === 'cancelled') { const e2 = new Error('已取消渲染'); e2.cancelled = true; throw e2; }
    }
    throw new Error('渲染超时了');
  }
  const renderDl = name => '/render/dl?name=' + encodeURIComponent(name);

  /* 台词总时长：底部那句「按台词排下来约 N 秒」 */
  function spokenSec(drama) {
    let n = 0;
    for (const sh of (drama.shots || [])) n += estLineSec(sh);
    return round2(n);
  }

  /* ============================================================================
     角色卡片上「声音 / 资产」那几块（Cast）—— 拍短剧页与素材库页共用一份
     ----------------------------------------------------------------------------
     以前只长在 drama.html 里：声音那一块要按**当前语音型号怎么定音色**渲染
     （preset 一排胶囊 / design 一个描述输入框 / clone 上传参考音频 / none 明说没配），
     素材库页要复用就只能整段抄走 —— 抄一份就会慢慢走样（AGENTS.md「发现重复实现就收敛」）。
     这一层**只产字符串**：点击动作仍由各页自己绑（data-act 的名字两边一致），
     因为「画完之后要不要重拍、要不要写进某一集」是页面自己的事。
     ========================================================================== */
  /* 这张表是**出图模板**的名字，不是资产的「类别」。
     2026-10-05 起角色资产不再按类别分栏 —— 用户要的是「角色资产」**一个**功能：
     可以加任意种类、不限数量、每一张自己起名字。所以三视图 / 表情表 / 服装
     退化成**出图时选的一个模板**，出完存下来的只是一张名叫「三视图」的角色资产。
     界面因此不再有「表情图」「服装」这些单独的格子（那是第二份实现，
     用户加一张「雨天造型」或「侧脸特写」时无处安放）。 */
  const ASSET_KINDS = { three: '三视图', expr: '表情表', costume: '服装', prop: '手持道具', custom: '自定义' };
  /* 场景身上的同类资产不叫「表情 / 服装」——同一份 tpl 键，两种类型各有一套说法 */
  const SCENE_ASSET_KINDS = { three: '多角度', expr: '不同时段', costume: '陈设细节', prop: '物件', custom: '自己加的' };

  /* ---------- 角色资产：一个角色可以挂**任意多张**，每张自己一个名字 ----------
     2026-10 之前 `assets` 是 `{ three: src, expr: src, … }` —— 每类**只能一张**，
     所以「三视图」天然就是一个坑位，用户想再加一张表情图或第二套衣服就没有地方放。
     接着改成按类别分栏的列表，也还是「类别」在前面 —— 用户要的是**一张图一个名字**。

     现在它是**一个扁平列表**：`[{ id, name, tpl, src, note, propIds }]`。
       · `name` —— 这一张叫什么，界面上唯一显示的东西，**用户可以自己改**。
       · `tpl`  —— 用哪个出图模板生成的，只是**出处**（界面上不再按它分栏）。
       · 两者都没有硬上限：种类是用户自己写的字符串，张数由「＋加一张」决定。

     ⚠ 老数据是这个字典形状，而且**不能删**（用户花钱画出来的图）——
       所以 `assetsOf()` 是**唯一的读入口**，它见到字典就现算成列表（同一个 src、propIds 空），
       见到列表就直接用。写回一律 `assetsSave()`，落盘就是列表。
       ⚠ 上一版的列表条目存的是 `kind`（类别）。`kind` 在这里现算成 `tpl`，
         名字取模板名 —— 用户改过的名字优先（`name` 存在就用它）。
       绝不能在别处再写一份 `item.assets[kind]` —— 那会产生一个谁也读不到的影子副本。 */
  let _assetSeq = 0;
  const newAssetId = () => 'as' + (Date.now().toString(36).slice(-5)) + (_assetSeq++).toString(36);
  /* 一条资产归一化：`kind` → `tpl`，名字缺省取模板名。
     **返回新对象**（不是引用）—— 库里与剧集是同一批数据的两份拷贝（toLibItem / toEpisodeChar），
     共用条目对象的话，在一边改名字或关联道具，另一边跟着变，而界面上看着是两份独立数据。 */
  const normAsset = (x, fbTpl) => {
    const tpl = x.tpl || x.kind || fbTpl || 'custom';
    return {
      id: x.id || newAssetId(),
      name: String(x.name || '').trim() || ASSET_KINDS[tpl] || SCENE_ASSET_KINDS[tpl] || tpl || '资产',
      tpl, src: x.src, note: x.note || '', propIds: (x.propIds || []).slice(),
    };
  };
  function assetsOf(item) {
    const a = item && item.assets;
    if (!a) return [];
    if (Array.isArray(a)) return a.filter(x => x && x.src).map(x => normAsset(x));
    /* 老字典 → 列表。只在读的时候现算，不改原对象：
       一条只读的查询顺手把用户的数据结构改掉，是很难查的一类副作用
       （保存时机一变，那次改写就跟着丢了）。 */
    return Object.keys(a).filter(k => a[k]).map(k => normAsset({ id: k + ':' + newAssetId(), kind: k, src: a[k] }));
  }
  function assetsSave(item, list) {
    item.assets = (list || []).filter(x => x && x.src).map(x => normAsset(x));
    return item.assets;
  }
  /* 界面上显示的名字 —— **唯一**的一份。两个入口：
     ① 存着的资产：`assetName(a)`
     ② 出图模板：`assetLabel(item, tpl)`（模板还没有变成资产之前的说法） */
  const assetName = a => (a && a.name) || '资产';
  /* 按 id 找一张（找不到返回 null，不抛 —— 界面上「这一张已经没了」就当没有这一格） */
  const assetById = (item, id) => assetsOf(item).find(x => x.id === id) || null;
  const assetsOfTpl = (item, tpl) => assetsOf(item).filter(x => x.tpl === tpl);
  /* 挑主图用：某一类的第一张（老数据只有一张，行为与从前一致） */
  const firstAssetOf = (item, tpl) => assetsOfTpl(item, tpl)[0] || null;
  function addAsset(item, o) {
    if (!o || !o.src) return null;
    const list = assetsOf(item).slice();
    const a = normAsset({ id: newAssetId(), name: o.name, tpl: o.tpl || o.kind, src: o.src, note: o.note, propIds: o.propIds });
    list.push(a);
    assetsSave(item, list);
    return a;
  }
  function removeAsset(item, id) {
    const list = assetsOf(item).filter(x => x.id !== id);
    assetsSave(item, list);
  }
  /* 改名字：界面上一个可就地改的输入框。空名字**不许存** ——
     空的那一张在列表里就是一个没有标签的缩略图，用户根本分不清哪张是哪张。 */
  function setAssetName(item, id, name) {
    const nm = String(name == null ? '' : name).trim();
    const list = assetsOf(item);
    const a = list.find(x => x.id === id);
    if (!a) return null;
    if (!nm) return a;                      /* 空名不改：留原来的，不把标签抹成空串 */
    a.name = nm.slice(0, 24);
    assetsSave(item, list);
    return a;
  }
  /* 关联道具：这一张图上带着哪几件（换衣服那张要连同那顶帽子一起发） */
  function setAssetProps(item, id, propIds) {
    const list = assetsOf(item);
    const a = list.find(x => x.id === id);
    if (!a) return null;
    a.propIds = (propIds || []).slice();
    assetsSave(item, list);
    return a;
  }
  /* 这一位身上挂着某件道具的**所有**资产（拍这一段时道具要跟着人一起出现） */
  function assetsUsingProp(item, propId) {
    return assetsOf(item).filter(x => (x.propIds || []).includes(propId));
  }
  /* 库 ↔ 剧 两边合并一份资产列表：按 **src** 去重（库里存的是 JSON，每次读写都是新对象，
     `new Set` 认引用不认内容，等于没去重），剧侧（add）覆盖库侧，**新出的排前面**。
     ⚠ 以前这里是 `Object.assign({}, base.assets, char.assets)` —— 那写法对**字典**成立，
        资产改成列表之后它会把数组摊成 `{"0":…,"1":…}`：不报错，但 `Array.isArray` 变 false，
        于是每一张图都变成「读不到」，界面上整格消失。 */
  function mergeAssetLists(baseList, addList, cap) {
    const seen = new Set(), out = [];
    for (const x of (addList || []).concat(baseList || [])) {
      if (!x || !x.src || seen.has(x.src)) continue;
      seen.add(x.src);
      /* 归一化走 `normAsset`（它接受 `kind` 也接受 `tpl`）——这里手搓一份字段清单的话，
         漏掉 `name` 的迁移就会把用户改过的名字退回模板名。 */
      out.push(normAsset({ id: x.id, name: x.name, tpl: x.tpl || x.kind, src: x.src, note: x.note, propIds: x.propIds }));
    }
    const n = cap || FACE_CAP * 4;
    return out.length > n ? out.slice(0, n) : out;
  }
  /* 「出图模板」的标签（ASSET_KINDS / SCENE_ASSET_KINDS）。
     ⚠ 它**不是**存着的资产在界面上显示的名字 —— 那个走 `assetName(a)`。
       以前两者是一回事（界面上按类别分栏），现在资产有了自己的名字，
       再拿模板名去显示就会把用户起的名盖掉。 */
  function assetLabel(item, tpl) {
    /* 道具没有资产子项，它那张图就是它自己：这里返回空串而不是硬套角色那套标签
       （「道具的道具」这种话说出来没法看）。界面上道具那一栏本来就不画这一块。 */
    if (isPropItem(item)) return '';
    const t = isSceneItem(item) ? SCENE_ASSET_KINDS : ASSET_KINDS;
    return t[tpl] || ASSET_KINDS[tpl] || tpl || '';
  }
  /* 「点『AI 出』时能给哪几个模板」—— **只有这一份判据**，两页都读它。
     这不是资产的分类，是**出图时的选项**；存下来的资产是扁平的、名字自己起。
     道具与场景返回空数组：它们只有自己那一张图，没有资产子项。 */
  function assetTplsOf(item) {
    if (!item || isPropItem(item) || isSceneItem(item)) return [];
    return Object.keys(ASSET_KINDS);
  }
  /* 场景「时段」那一列的选项。时间基准只有 `TIME_OFS` 一份，但**存着的值未必在里面**：
     AI 会写「傍晚」「凌晨」，素材库里那条也可能是人自己敲的。选项里没有它时整个 select
     一项 selected 都没有 → 浏览器默认显示第一项「深夜」，于是下拉写着深夜、
     提示词里却是那个真时段（AGENTS.md「每个 `<select>` 都得有兜底项」）。
     所以：不在表里的值**照实列出来并选中**，既不骗人，也让用户能直接改回表里的档。
     以前这一段只长在 drama.html 里，素材库页要画同一个下拉就只能再抄一份。 */
  function timeOptsHTML(item) {
    const list = (TIME_OFS || []).slice();
    const cur0 = String((item && item.time) || '深夜');
    if (cur0 && !list.some(t => t.id === cur0)) list.push({ id: cur0, label: cur0 });
    return list.map(t => `<option value="${esc(t.id)}"${t.id === cur0 ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  }
  /* 声波条：一串高低不同的竖杠，纯装饰（不假装是真实波形） */
  const WAVE = (() => { let s = ''; for (let i = 0; i < 22; i++) { const h = 25 + ((i * 37) % 70); s += '<i style="height:' + h + '%"></i>'; } return s; })();
  /* 「这一条身上有哪几张角色资产」一句话 —— 现在报的是**用户自己起的名字**。
     一张都没有时返回**空串**（那一行整个不出现），而不是「还没画」：
     资产是**自己加**的（任意种类、不限张数），系统不再认定「缺哪几类」，
     说「还没画」是在报一件根本不存在的事 —— 界面上看着像欠了债，实际一行就能跳过。 */
  function assetNames(c) {
    const list = assetsOf(c);
    return list.length ? list.map(a => esc(assetName(a))).join('、') : '';
  }
  function voiceName(REG, opts, id, mode) { const v = voices(REG, opts, mode).find(x => x.id === id); return v ? v.name : (id || ''); }
  /* 音色：真从注册表取（平台 preset 音色就那几个，不编名），
     没配语音平台时明说「设置页配好语音接口才有音色」，不摆三个假的「声音 1/2/3」。 */
  function voiceChips(REG, opts, c) {
    const vs = voices(REG, opts, c && c.voiceMode);
    if (!vs.length) return '<span class="ui-hint">这个语音型号没有可选的预设音色 —— 它靠下面那一栏定声音</span>';
    /* 角色身上那个 id 可能是**别家的**（换了语音型号、或从素材库拉进来的）：
       配音时会退回这个型号的第一个音色，但这件事必须当场说出来，不能让人以为还在用自己挑的那个。 */
    const v = voiceOf(REG, { opts: opts }, c);
    return (v.stale ? `<span class="ui-tag warn">存的「${esc(v.saved)}」不是这个型号的声音，这次按「${esc((v.list[0] || {}).name || '')}」念</span>` : '')
      + vs.slice(0, 6).map(x => `<button class="ui-pill${c.voice === x.id ? ' on' : ''}" data-act="voice" data-vid="${esc(x.id)}"
        title="${esc([x.name, x.lang, x.gender].filter(Boolean).join(' · '))}">${esc(x.name)}</button>`).join('')
      + (vs.length > 6 ? `<span class="ui-hint">共 ${vs.length} 个</span>` : '');
  }
  /* 「这一位用哪种方式定声音」那一排：只列**这一家真有型号**的方式（ttsWays 现算），
     只有一种时整排不出现（摆一个只有一项的开关等于骗人点一下）。
     AI 定过音色（voiceBy='ai'）也在这一行说一声，人可以直接改。 */
  function voiceWaySeg(REG, opts, c) {
    const ways = ttsWays(REG, opts);
    if (!ways.ok) return '';
    const list = [];
    if (ways.preset.length) list.push({ id: 'preset', label: '预设音色' });
    if (ways.design) list.push({ id: 'design', label: '写声音描述' });
    if (ways.clone) list.push({ id: 'clone', label: '复刻参考音频' });
    if (list.length < 2) return '';
    const cur = (c && c.voiceMode) || voiceWay(c, REG, opts).mode;
    return '<span class="ui-seg" role="group" aria-label="这一位的声音怎么定">' + list.map(x =>
      `<button class="${x.id === cur ? 'on' : ''}" data-act="voiceway" data-way="${esc(x.id)}"
        title="${x.id === cur ? '这位现在用：' + x.label : '改成：' + x.label}">${x.label}</button>`).join('') + '</span>';
  }
  /* 声音那一块按**这一位角色自己**的定音色方式渲染（voiceWay → 注册表声明的 ttsMode，
     AI 定过音色之后每位角色可能各不相同）：
       preset → 一排预设音色胶囊
       design → 一个「声音描述」输入框（这个型号压根没有预设音色）
       clone  → 上传一段参考音频做音色复刻
       none   → 说清还没配语音接口
     以前整集只问一次「当前型号是哪一种」：AI 把小雅定成复刻、旁白定成预设时，
     卡片上摆的控件与真正发出去的对不上。 */
  function voiceBoxHTML(REG, opts, c) {
    const w = voiceWay(c, REG, opts);
    const vm = w.mode;
    if (vm === 'none') return '<span class="ui-hint">还没配语音接口 —— 到设置页填一个语音平台的密钥，才能定声音</span>';
    const mn = esc((w.model || {}).name || '这个型号');
    /* 要的方式这一家没有型号：界面必须说「其实这次按 X 念」，不能继续显示复刻上传框 */
    const fb = w.fellback ? `<span class="ui-tag warn">这位想要「${esc(WAY_LABEL[w.want] || w.want)}」，这个平台没有对应型号 —— 现在按「${esc(WAY_LABEL[vm])}」的型号出声</span>` : '';
    if (vm === 'design') return fb + '<input class="ui-in" data-act="voicenote" placeholder="描述这个人的声音：男/女、年纪、清亮还是沙哑、语速快慢、情绪底子" '
      + 'value="' + esc(c.voiceNote || '') + '">'
      + `<span class="ui-hint">「${mn}」按这段描述出声，写完就能试听${(c.voiceBy === 'ai' && String(c.voiceNote || '').trim()) ? '（这段是 AI 按人设写的，可以直接改）' : ''}`
      /* 说清它会跟着这一位走（用户要求「同一个角色下次用之前的音色提示词」）：
         描述随角色进素材库、拉进下一集时一起带过去，所以同一个人不用每集重写一遍。 */
      + '。这段描述随这一位进素材库，拉进下一集也带过去</span>';
    if (vm === 'clone') return fb + (c.refAudio
        ? `<span class="ui-tag ok">参考音频：${esc(String(c.refAudioName || '已挂的那一段').slice(0, 18))}</span>`
        : '<span class="ui-hint">还没有参考音频 —— 这个型号靠参考音频克隆音色（3~10 秒干净的人声即可）</span>')
      + `<button class="ghost mini" data-act="refaudio">${c.refAudio ? '换一段' : ic('upload', 12) + ' 上传参考音频'}</button>`
      + (c.refAudio ? '<button class="ui-linkbtn" data-act="refclear">去掉</button>' : '');
    return fb + '<span class="ui-voice-list">' + voiceChips(REG, opts, c) + '</span>';
  }
  const WAY_LABEL = { preset: '预设音色', design: '声音描述', clone: '参考音频复刻' };
  const wayLabel = m => WAY_LABEL[m] || m || '';
  /* 占位那一格：转圈 + 一句「这一项正在生成，好了会自动出现」。
     要换行就写 \n，逐段转义后再拼 <br> —— 占位文字里会混进角色名，整句当 HTML 直拼就是一条 XSS。
     `cls` 只换外形：默认是行内那一颗小胶囊（候选排里用），传 'fill' 就是铺满一个格子
     （拍短剧页那些深色缩略槽）。标记与转义只有这一份，页面各自再写一份就会漏转义。 */
  function waitHTML(t, cls) {
    return '<span class="ui-wait' + (cls ? ' ' + cls : '') + '"><i></i>'
      + String(t).split('\n').map(x => esc(x)).join('<br>') + '</span>';
  }
  /* 图片候选那一排（预览图的 faces / 某类设定图的 assetCands[kind] 共用这一段）：
     选中的那张标 on，其余给一个「用这一张」。动作名由页面传（o.act / o.zoom），两页用同一套名字：
     useface / useacand / zoom —— 因为「换完这张要不要重拍」是页面自己的事，标记只有一份。
     `o.extra` 是这一格要多带的属性（例如设定图的 data-kind="three"），`o.tail` 是接在行尾的标记
     （那颗「一次出 N 张」的按钮）—— 带 tail 时哪怕一张候选还没有也要把这一排行画出来，
     否则「还没有候选」和「连出候选的入口都没有」在界面上长成同一个样子。 */
  function picCandsHTML(list, cur, o) {
    o = o || {};
    const arr = (Array.isArray(list) ? list : []).filter(x => x && x.src);
    if (!arr.length && !o.tail) return '';
    const nm = o.name || '';
    /* 动作挂在哪个属性上：**两页的派发方式不同** —— 角色 / 场景 / 道具卡（`bindCastCard`）
       与素材库页按 `data-act` 派发，右栏（`bindSideCtl`）按 `data-a`。
       写死 `data-act` 时，机位候选那一排（摆在右栏里）点「用这一张」什么都不会发生 ——
       那一列只认 `data-a`。所以这里让调用方说一声，两边各自接上。 */
    const A = o.attr || 'data-act';
    return '<div class="ui-cands"><span class="lab">' + esc(o.label || '候选') + '</span>'
      + arr.map((x, i) => {
        const on = cur && x.src === cur;
        const label = esc(String(x.name || ('第 ' + (i + 1) + ' 张')));
        return '<span class="ui-cand' + (on ? ' on' : '') + '">'
          + '<img src="' + esc(Api.mediaSrc(x.src)) + '" ' + A + '="' + esc(o.zoom || 'zoom') + '"'
          + ' data-src="' + esc(x.src) + '" data-name="' + esc((nm ? nm + ' · ' : '') + label) + '" alt="">'
          + '<span class="t">' + label + '</span>'
          + '<button class="ui-linkbtn" ' + A + '="' + esc(o.act || '') + '" data-src="' + esc(x.src) + '"'
          + (o.extra || '') + (on ? ' disabled' : '') + '>' + (on ? '在用' : '用这一张') + '</button></span>';
      }).join('') + (o.tail || '') + '</div>';
  }
  /* 声音候选那一排：一次合成几条试听、挑一条当这一位的声音。
     「用这一条」那颗按钮**只在预设音色那一位出现** —— 描述 / 复刻那一位挑哪条都不改变
     以后拍出来的声音，摆一颗能点、点了什么都不换的按钮比不摆更糟（见 Pipe.voiceCap 的 pickable）。
     「拿这条去克隆」是**另一件事**（用户要求）：把这一条**已经存下来的音频**挂成这一位的
     参考音频、方式切到复刻 —— 于是这一位以后（包括下一集）都按这段声音念，
     而不是每次重新按描述生成一遍（那一次生成出来的声音每次都不一样）。
     判据 `ttsWays(...).clone`：这一家没有复刻型号时**不摆**那颗按钮 ——
     点了会静默退回描述/预设，界面上却写着「克隆」，那是骗人。 */
  function voiceCandsHTML(REG, opts, c, o) {
    o = o || {};
    const cap = voiceCap(REG, opts, c);
    const all = (c && c.voiceCands) || [];
    const list = all.filter(x => x && x.src);
    /* 没出来的那几条**要报出来**，不能整个滤掉：出 3 条挂 2 条时界面上只剩 1 条能播，
       用户以为只出了 1 条 —— 于是反复点「一次出 3 条」，一次又一次地花 Synthesize 的钱。
       voiceCands 已经把失败原因记在 rec.err 上，这里把它摆出来（与图片候选排的失败显示对齐）。 */
    const failed = all.filter(x => x && !x.src && x.err);
    if (cap.mode === 'none' || (!list.length && !failed.length && !(cap.n > 1))) return '';
    /* 正在出的那几条要有格子（`o.waiting` 是页面那一轮现在的文案）：
       只有底栏一句忙碌文字，界面这里看着就像「出了 0 条」或者「卡住了」。
       那颗「一次出几条」的按钮也留着（禁用）：整排只剩一个转圈，看着就像入口没了。 */
    if (o.waiting) {
      return '<div class="ui-cands"><span class="lab">声音候选</span>' + waitHTML(o.waiting)
        + (cap.n > 1 ? '<button class="ghost mini" data-act="vgen" data-n="' + cap.n + '" disabled>一次出 ' + cap.n + ' 条试听</button>' : '')
        + '</div>';
    }
    const canClone = !!ttsWays(REG, opts).clone;
    const rows = list.map(x => {
      const on = cap.pickable && x.voice && x.voice === c.voice;
      const nm = String(x.name || voiceName(REG, opts, x.voice, x.mode) || wayLabel(x.mode)).slice(0, 18);
      const cloned = !!(c.refAudio && c.refAudio === x.src);
      return '<span class="ui-cand' + (on ? ' on' : '') + '">'
        + '<button class="ui-linkbtn" data-act="vplay" data-src="' + esc(x.src) + '"'
        + ' title="播本机存着的这一段（就是刚才合成的那一条，不再合一遍）">' + ic('play', 11) + '</button>'
        + '<span class="t">' + esc(nm) + (x.dur ? ' · ' + x.dur + 's' : '') + '</span>'
        + (cap.pickable ? '<button class="ui-linkbtn" data-act="vuse" data-vid="' + esc(x.voice || '')
          + '" data-vname="' + esc(nm) + '"' + (on ? ' disabled' : '') + '>' + (on ? '在用' : '用这一条') + '</button>' : '')
        + (canClone ? '<button class="ui-linkbtn" data-act="vclone" data-src="' + esc(x.src) + '"'
          + ' data-name="' + esc(nm) + '"' + (cloned ? ' disabled' : '')
          + ' title="把这一条存下来的音频挂成这一位的参考音频、方式切到复刻 —— 以后（包括下一集）都按这个声音念">' + (cloned ? '正在用它' : '拿这条去克隆') + '</button>' : '')
        + '</span>';
    }).join('');
    const gen = cap.n > 1 ? '<button class="ghost mini" data-act="vgen" data-n="' + cap.n + '">一次出 ' + cap.n + ' 条试听</button>' : '';
    const why = cap.why ? '<span class="ui-hint">' + esc(cap.why) + '</span>' : '';
    const bad = failed.length
      ? '<span class="ui-hint err">有 ' + failed.length + ' 条没出来：' + esc(failed.map(x => x.err).join('；').slice(0, 160)) + '</span>' : '';
    const note = (!cap.pickable && list.length)
      ? '<span class="ui-hint">这几条是同一种声音多试几遍，挑哪条都不改变以后拍出来的声音'
        + (canClone ? '；想固定其中一条，按「拿这条去克隆」' : '') + '</span>' : '';
    return '<div class="ui-cands"><span class="lab">声音候选</span>' + rows + bad + gen + why + note + '</div>';
  }
  /* 试听圆钮 + 声波 + 方式选择 + 声音控件 + 声音候选那一排
     （两页同一段标记，样式在 ui.css 的 .ui-vrow / .ui-voice / .ui-cands；
      `o.waiting` 透给候选那一排，正在合成时格子要有占位） */
  /* 「这一条会不会说话」——**只有这一份判据**，两页都读它。
     2026-10 有了道具之后，「哪几类有声音」变成一个会漏的判断：写成
     `!isSceneItem(c) ? … : ''` 那种二元判断，道具会落到「有声音」那一支，
     于是道具卡上摆出一整块音色胶囊与试听按钮 —— 点下去 TTS 那边收到一个「角色名」
     当台词念出来。改判据的地方越多，越要把它收在一处。 */
  function isVoiced(item) { return !!item && !isSceneItem(item) && !isPropItem(item); }
  function voiceRowHTML(REG, opts, c, o) {
    /* 场景与道具不出这一块（它们不出声）：返回空串而不是在页面里各自 if 一次 ——
       少一处判断就少一处「这一页忘了改」。 */
    if (!isVoiced(c)) return '';
    return '<div class="ui-vrow"><div class="ui-voice"><button class="play" data-act="play" title="试听（会真的合成一小段）">' + ic('play', 12) + '</button>'
      + '<div class="wv">' + WAVE + '</div>' + voiceBoxHTML(REG, opts, c) + '</div>'
      + voiceWaySeg(REG, opts, c)
      /* 两条留痕：定成了说一句「AI 按人设定的」（人可以直接改），没定成写清**为什么** ——
         不写的话「自动定音色」失败在界面上就是无声消失，用户到第 4 步才发现没人说话。 */
      + (c.voiceAuto ? '<div class="ui-hint">画完角色时 AI 按人设定成了这个声音：' + esc(String(c.voiceAuto).slice(0, 40))
          + '（下面可以直接改）</div>' : '')
      + (c.voiceErr ? '<div class="ui-note err">没定成声音：' + esc(String(c.voiceErr).slice(0, 160))
          + '<button class="ui-linkbtn" data-act="revoice">再让 AI 定一次</button></div>' : '')
      + voiceCandsHTML(REG, opts, c, o) + '</div>';
  }
  /* 「这一位身上有没有声音」的一枚状态芯片（素材库列表与详情都要用） */
  function voiceTag(c) {
    if (!isVoiced(c)) return '';
    const way = (c && c.voiceMode) && WAY_LABEL[c.voiceMode] ? WAY_LABEL[c.voiceMode] : '';
    const who = c && c.voiceBy === 'ai' ? 'AI 定' : (way || '');
    const tag = who ? who + ' · ' : '';
    return c.refAudio
      ? `<span class="ui-tag ok">${tag}参考音频 · ${esc(String(c.refAudioName || '已存的那一段').slice(0, 12))}</span>`
      : (c.voice
        ? `<span class="ui-tag">${tag}音色 · ${esc(String(c.voiceName || c.voice).slice(0, 14))}</span>`
        : (String(c.voiceNote || '').trim()
          ? `<span class="ui-tag">${tag}声音描述 · ${esc(c.voiceNote.trim().slice(0, 14))}</span>`
          : '<span class="ui-tag warn">还没有声音</span>'));
  }
  /* 参考音频「能收哪些」：类型 / 单个大小都现读**复刻那个型号**的能力声明（不是界面上当前选中的
     那个预设型号 —— 它压根没有 reference_audio 这一槽，规则会算成空）。 */
  function refAudioRule(REG, opts) {
    const hit = ttsOf(REG, opts, 'clone') || {};
    const rule = (window.Capabilities && Capabilities.rule && hit.model)
      ? Capabilities.rule(hit.model, 'reference_audio') : { max: 1, accept: '', maxBytes: 0 };
    const types = (window.Capabilities && Capabilities.slotTypes && hit.model)
      ? Capabilities.slotTypes(hit.model, 'reference_audio') : ['音频', '音乐'];
    return { types: types, rule: Object.assign({}, rule, { max: 1 }), upload: rule.accept ? { accept: rule.accept } : undefined,
      model: hit.model || null, can: ttsModeOf(hit.model) === 'clone' };
  }
  /* 「能不能试听 / 够不够开拍条件」按**这一位自己**的方式判（以前整集问一次当前型号，
     AI 把不同角色定成不同方式后就会说错话）。返回带 mode，前置条件那一栏据此分组。 */
  function voiceReady(REG, opts, c) {
    const w = voiceWay(c, REG, opts);
    const vm = w.mode;
    if (vm === 'none') return { ok: false, mode: 'none', why: '还没配语音接口 —— 到设置页填一个语音平台的密钥' };
    if (vm === 'clone') return c.refAudio ? { ok: true, mode: vm } : { ok: false, mode: vm, why: '这位用音色复刻，要有参考音频：先「上传参考音频」（3~10 秒干净人声）' };
    if (vm === 'design') return String(c.voiceNote || '').trim()
      ? { ok: true, mode: vm } : { ok: false, mode: vm, why: '这位用声音描述出声：先写一句（男/女、年纪、清亮还是沙哑）' };
    const vs = voices(REG, opts, vm);
    if (c.voice) return { ok: true, mode: vm };
    return vs.length ? { ok: false, mode: vm, why: '先在下面挑一个音色' } : { ok: false, mode: vm, why: '这个型号没有可选的预设音色' };
  }
  /* 试听这一整段流程两页都要（拍短剧页认角色、素材库页），包括那三个容易写漏的点：
     ① 先按型号判「缺什么」，② 会真的花钱所以先 Confirm 一句，③ opts 一定传下去 ——
     不传就退回「注册表里第一个语音型号」，于是试听的是 A、拍出来是 B。
     返回值而不是抛错：{ why } 缺条件、{ cancelled } 用户自己关掉、{ label } 真放出来了。 */
  let previewAud = null;
  async function preview(REG, opts, c, o) {
    const stage = (o && o.onStage) || function () {};
    if (previewAud) { try { previewAud.pause(); } catch (e) {} }
    previewAud = null;
    const rdy = voiceReady(REG, opts, c);
    if (!rdy.ok) return { why: rdy.why };
    /* 试听不再先弹一层模态问「会合成一小段」（2026-10 依用户要求去掉弹窗）：
       合成一小段本身就在按钮下方就地显示进度（onStage），结果直接放音，
       按错了关掉播放器就完事，比一层拦截弹窗更贴合「就地试听」。 */
    stage('正在合成「' + ((c && c.name) || '') + '」的试听…');
    try {
      /* 刻意**不传 c.voice**：previewVoice 里 `voiceId || voiceOf(...)` 会让存下来的那个 id 短路掉校验，
         于是「存的 X 不是这个型号的声音」（界面已经挂了黄标）时，试听放的是 X、拍出来的是 Y ——
         正是这里注释声称已避免的「试听听着是 A、拍出来是 B」。传 null 让它自己走 voiceOf。 */
      const url = await previewVoice(REG, c, null, opts);
      previewAud = new Audio(url);
      previewAud.play().catch(() => { if (window.Toast) Toast.err('浏览器拦了自动播放，点一下再放'); });
      const vm = voiceWay(c, REG, opts).mode;
      return { label: vm === 'clone' ? '参考音频复刻' : vm === 'design' ? ((c.voiceNote || '按描述出声').slice(0, 20)) : voiceName(REG, opts, c.voice, vm), mode: vm };
    } finally { stage(''); }
  }
  /* 播**本机已经存着**的那一段（候选试听）：不再合成、不再花一次，所以不问那一句。
     和 preview 共用同一个 previewAud —— 两条候选各放各的就会叠成一团噪音。 */
  async function playAsset(src) {
    if (!src) return { why: '这一段不在了，重新出一次候选' };
    if (previewAud) { try { previewAud.pause(); } catch (e) {} previewAud = null; }
    const a = new Audio(Api.mediaSrc(src));
    previewAud = a;
    try { await a.play(); } catch (e) { return { why: '浏览器没让自动播放：' + ((e && e.message) || e) }; }
    return { ok: true };
  }

  /* 下载的文件名。剧名是用户自己起的，可能带 \ / : * ? " < > | 这些文件系统不许用的字符 ——
     浏览器会各自换成一个下划线或直接截断，出来的名字就散了（一个「第1段_第2次」看不出是哪一集）。
     所以**统一在这一处洗**，页面不许自己拼 `(cur.title||'短剧') + …`：
     成片、字幕、每一次单独下载都走它，名字长得一模一样。 */
  function fileSafe(s, max) {
    const t = String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|]+/g, '_')       // 文件系统保留字符
      .replace(/[\r\n\t]+/g, ' ')           // 换行/制表（会截断成两半）
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')                // 结尾的点与空格：Windows 上会被悄悄去掉
      .trim();
    return (t || '短剧').slice(0, max || 24);
  }
  /* 一次拍摄单独下载时的名字：哪一集、哪一段、第几次 —— 三个信息缺一不可，
     否则下载目录里是一堆「第2次.mp4」，谁也分不出是哪一段的。 */
  function takeName(drama, sh, take) {
    return fileSafe(drama && drama.title) + '_第' + ((sh && sh.no) || 0) + '段_第' + ((take && take.no) || 0) + '次';
  }
  /* 整集剧本（纯文本）。成片 mp4 拿在手里就只剩画面了，而「这份片子到底是什么」在别处
     只能靠成片清单反推 —— 用户真正想要的往往就是同一份东西：拿去做配音、拿给别处改、存一份底。
     **纯读**：不提交任何任务、不碰平台、不花钱，所以它不经过 genWhy 那道花钱闸门。
     排版按「能直接念、能直接照着改」来：抬头 → 角色表 → 场景表 → 分段 → 你写的故事。
     换行用 \n，与同层的 Subs.toSrt 一致（不要在这里另起一套换行规则）。 */
  function scriptText(d, REG) {
    if (!d) return '';
    const L = [];
    const nameOf = id => { const c = (d.characters || []).find(x => x && x.id === id); return c ? (c.name || '') : ''; };
    const sceneOf = id => { const s = (d.scenes || []).find(x => x && x.id === id); return s ? (s.name || '') : ''; };
    const shots = (d.shots || []).filter(Boolean);
    /* 计划时长按**每段真正会发出去的那一档**算（`shootFields`），不是拿 `wantSec` 加起来：
       两者不一样（AI 填 8 而平台只有 4/15、台词短的段实际出 4 秒），剧本文上一句
       「计划 120 秒」而实际只有 96 秒，就成了整份文档里唯一那句对不上的话。 */
    const total = shots.reduce((n, s) => n + (REG ? Number(shootFields(REG, d, s).dur) || 0 : (Number(s.wantSec) || 0)), 0);
    L.push('《' + (d.title || '未命名短剧') + '》');
    L.push('画幅 ' + ((d.opts || {}).ratio || '未设') + ' · 共 ' + shots.length + ' 段 · 计划 ' + total + ' 秒'
      + (d.createdAt ? ' · ' + new Date(d.createdAt).toLocaleString('zh-CN') : ''));
    L.push('');
    if ((d.characters || []).length) {
      L.push('【角色】');
      (d.characters || []).forEach(c => {
        if (!c) return;
        L.push('- ' + (c.name || '（未命名）') + (c.kind === 'narrator' ? '（旁白，只出声）' : '') + (c.bio ? '：' + c.bio : ''));
        if (c.look) L.push('  外貌：' + c.look);
        if (c.voiceName || c.voiceNote) L.push('  声音：' + (c.voiceName || c.voiceNote));
      });
      L.push('');
    }
    if ((d.scenes || []).length) {
      L.push('【场景】');
      (d.scenes || []).forEach(s => { if (s) L.push('- ' + (s.name || '（未命名）') + (s.time ? '（' + s.time + '）' : '') + (s.desc ? '：' + s.desc : '')); });
      L.push('');
    }
    /* 道具（2026-10）与角色、场景平级，所以这份「这一集有什么」的清单里也占一栏 ——
       漏了它，用量统计与 AI 对话看到的上下文都当这一集没有道具。 */
    if ((d.props || []).length) {
      L.push('【道具】');
      (d.props || []).forEach(p => { if (p) L.push('- ' + (p.name || '（未命名）') + (p.look ? '：' + p.look : '')); });
      L.push('');
    }
    L.push('【分段】');
    if (!shots.length) L.push('（还没有分段）');
    shots.forEach(sh => {
      L.push('');
      L.push('第 ' + sh.no + ' 段 · ' + (sh.title || '未命名')
        + '（约 ' + (REG ? Number(shootFields(REG, d, sh).dur) || 0 : Number(sh.wantSec) || 0) + ' 秒）');
      L.push('场景：' + (sceneOf(sh.sceneId) || '不指定') + (sh.time ? ' · ' + sh.time : ''));
      const who = (sh.chars || []).map(nameOf).filter(Boolean);
      if (who.length) L.push('出场：' + who.join('、'));
      if (sh.style) L.push('画风：' + sh.style);
      if (sh.openDesc) L.push('开头画面：' + sh.openDesc);
      /* 说话人跟右栏、配音同一份判据（lineSpeaker）；认不出才照 `l.who` 原样写出来
         —— 角色被删掉之后那几句照样留在剧本里，写「旁白」会让人以为剧本本来就那么写的。 */
      (sh.lines || []).forEach(l => { if (l && l.text) L.push('台词 ' + ((lineSpeaker(d, l) || {}).name || l.who || '旁白') + '：' + l.text); });
      (sh.shots || []).forEach((k, i) => {
        if (k) L.push('镜' + (i + 1) + '：' + (k.desc || '') + (k.camera ? '（' + k.camera + '）' : '') + (k.sec ? ' ' + Math.round(k.sec) + ' 秒' : ''));
      });
    });
    if (d.story) { L.push(''); L.push('【你写的故事】'); L.push(d.story); }
    return L.join('\n') + '\n';
  }

  /* 对外只列页面会用的入口（window.Drama.*）；没列到的（normalizeScript / resumeTake /
     ttsOnce / applyRoleSource…）是本模块内部的单一实现，跨闭包别直接调 ——
     调用一律走这里声明的接口（见 AGENTS.md「复用公共模块」）。 */
  const Pipe = { splitScript, drawPreview, drawFace, drawCharAsset, drawScene, drawOpen, drawCameras, dubShot,
    shoot, render, edlCheck, renderDl, spokenSec, lineSec, lineAudio, fileSafe, takeName, scriptText,
    /* renderSpec 必须导出：页面要读它的 `stamp`（成片指纹）判断手上那份是不是按现在这段数据渲出来的。
       指纹的算法只在这一处，页面不许自己拼一份 —— 两处各拼一份就会「永远对不上」或「永远对得上」。 */
    renderSpec,
    resumeAll, prereqs, staleChains, lineDrift, lineSpeaker,
    videoOf, takeVideo, healTakes, videoChoices, videoCaps, shootFields, refRule, planMaterials, chosenTake,
    overlongShots,
    pickProvModel, modelGroups, modelSelectHTML,
    voices, voiceMode, voiceOf, ttsOf, previewVoice, ttsWays, voiceWay, setVoiceWay, assignVoices, autoVoice,
    /* 「拿已经生成的那条音频去克隆」——两页共用一份。页面不要再自己写
       `c.refAudio = …; c.voiceMode = 'clone'`：漏掉清 voice / voiceName 那两句，
       预设音色 id 就还留着，两份配置同时成立。 */
    cloneFromCands,
    /* 配音色时优先挑哪一个型号（生成音色 > 复刻 > 预设）——设置页与拍短剧页都要显示
       「现在实际会用哪一个型号」，页面自己再算一遍就是第二份判据。 */
    ttsModeOf, ttsModelsOf, ttsModeUsable, preferTtsModel,
    voiceCap, voiceCands, previewCap,
    /* 文字 AI 熔断这一档：页面只渲染 `aiState()` 的结果、点「再试一次」调 `aiRetry()`，
       不许自己数失败次数 —— 两处各数一份就会出现「条子写着已恢复、实际还在等」。 */
    aiState, aiRetry,
    saveRefAudio, clearRefAudio, refAudioOf, takeLastFrame, chainPlan, linkSource, stepGate, maxShotSec, episodeStyle,
    /* fillTpl 要导出：drama.html 那几处「AI 优化」现在也用 `TextAI.prompt('drama_look')` 之类的指令，
       占位符填充**只有这一份实现**（`{xxx}` → 值，对不上的原样留着不炸）。
       页面自己再写一个 replace 就是第二份判据 —— 改了一边另一边填法就不一样。 */
    fillTpl,
    PARALLEL_CHAINS, runPool };

  return {
    DUR_PRESETS, ROLE_SOURCES, SET, TIME_OFS,
    durationBounds, durationFromMinutes, durationMinutes,
    setting, defaultDuration, aiDurOn, aiVoiceOn, nextInherit, maxTakes, candN, camN, previewCap, candCount,
    newDrama, newChar, newScene, newProp, newShot, newTake, uid, esc,
    /* 素材库的「类型 / 分组 / 预览图」三件套：字段名只在这几个函数里换（库 face/look ↔ 剧侧 img/desc），
       页面自己判 kind === 'scene' 就会和 pullInto 走岔。`episodePool` 也挂出来 ——
       页面要增删某一栏（拍短剧第 2 步加道具）就得按类型找对那一栏，不能自己拼三元。 */
    LIB_KINDS, libKindOf, voiceOnlyOf, isSceneItem, isPropItem, picOf, setPic, descOf, episodePool,
    list, get, put, remove, activeId, setActive, runningTakes, dropChar, dropScene, dropProp,
    /* `listBroken` **有页面调用方**（drama.html 的 storage 钩子要分「真被删」与
       「整份读不出来」—— 以前它只在 `put` 里自查，页面只能看着 `get` 返回 null
       就断言「被删了」，那是在数据明明读不出来时撒一个假话）。
       判据要只有一份：页面问它，不许自己再去猜信封格式。 */
    listBroken,
    /* 开机结算停在「配音中」的旧 take（页面只在 boot 调一次，理由见函数上那段注释）。 */
    settleStuckDubbing,
    /* `Shots.resequence` 曾经挂在这儿，但**外部零调用**（只在
       `moveShot`/`duplicateShot`/`dropShot` 里调）—— 挂出来只会让人以为页面在用它们。 */
    Shots: { moveShot, duplicateShot, dropShot, dropTake, abandon, setScene, setLink },
    Lib, Subs, Pipe,
    /* 「这一集要用库里哪几条」对外露一份：页面上那行「已点名 N 条」的摘要要报同样的数，
       两处各数一遍就会出现「框里勾了 3 个、下面写着 4 个」。 */
    libFor, libPickOf: picked,
    /* `assetTplsOf` = 点「AI 出」时能给哪几个**出图模板**（两页唯一判据，只有角色有）；
       存着的资产是**扁平**的一份，名字自己起（`assetName`），不再按类别分栏。
       两者刻意分开：拿「已经存着的」当「能出什么」会让用户加过一张「雨天造型」之后，
       出图入口反而按那一类走。 */
    Cast: { ASSET_KINDS, SCENE_ASSET_KINDS, assetLabel, assetTplsOf, assetName,
      /* 角色资产的读写**只有这一套**（`assets` 是扁平列表：任意种类、不限张数、
         每张一个名字 + 一组关联道具）。页面不要再写 `c.assets[kind]` —— 那是旧字典形状的读法，
         在列表形状下恒为 undefined，表现是「界面永远显示没有资产」。 */
      assetsOf, assetsSave, assetsOfTpl, firstAssetOf, assetById, addAsset, removeAsset, setAssetName,
      setAssetProps, assetsUsingProp, mergeAssetLists,
      isVoiced, timeOptsHTML, WAVE, assetNames, voiceName, voiceChips, voiceBoxHTML, voiceRowHTML, voiceTag, refAudioRule, voiceReady, preview, playAsset, wayLabel, voiceWaySeg,
      /* 候选那一排的公共标记（两页共用一份，样式在 ui.css 的 .ui-cands / .ui-wait）：
         页面只提供「绑哪个动作」和「这一格正在出第几张」，不要再各写一套占位与格子。 */
      waitHTML, picCandsHTML, voiceCandsHTML },
  };
})();
