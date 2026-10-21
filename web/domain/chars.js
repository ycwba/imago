/* ============================================================================
   chars.js —— 素材库（公共模块，全站唯一实现）
   ----------------------------------------------------------------------------
   一条素材 = 一个角色 / 一个场景 / 一件道具：预览图、描述、声音、角色资产，跨页面复用
   （导演台的参考图候选、素材库页、AI 助手的查询都读这一份）。

   2026-10 之前本模块叫 drama.js、挂 window.Drama，是「拍短剧」页的后端。
   拍短剧页删除后，拆剧本 / 字幕轨 / 拍摄循环 / 成片渲染 / 剧集增删改那一整套
   （Subs / Shots / 剧集存储 / 成片 EDL）已整块删除，模块改名并收窄成素材库的后端。
   留下的都是**幸存页面仍在调用**的：出图（drawPreview / drawCharAsset）、
   配音（autoVoice / voiceCands / cloneFromCands）与角色卡公共标记（Cast）。

     Chars.lib    素材库：类型 / 预览图 / 描述 / 分组 / 读写与新建表单
     Chars.cast   角色卡上「声音 / 资产」那几块（只产标记，点击动作由页面自己绑）
     Chars.pipe   出图与配音两条流水线（拆剧本与拍摄已删）

   2026-10 由 `drama_chars` 改名成 `char_lib`：拍短剧页删掉之后 drama_ 前缀名不副实。
   旧名到新名的搬运由 `ui.js` 的 `migrateRenamedKeys()` 一次性做完（连 `.data/` 里那份镜像一起）。
   ========================================================================== */
window.Chars = (function () {
  'use strict';

  /* ---------- 存储键（都在 ui.js 的 SYNCABLE 白名单里，跟着云同步走）----------
     本模块只认新名；旧名的兼容与搬运全在 ui.js 那一站，别在这里再加一层回退。 */
  const K_CHARS = 'char_lib';           // 素材库
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
  const nowTs = () => Date.now();
  function read(k, def) { try { return (window.Store && Store.read) ? Store.read(k, def) : def; } catch { return def; } }
  function write(k, v, cap) {
    if (!(window.Store && Store.write)) return { ok: false, error: '存储不可用' };
    return Store.write(k, v, { cap });
  }
  /* 素材库整份读盘缓存：库里每条都带 faces / assets / bio / look，一条几百 KB 很常见，
     而页面每画一张卡就要重新 `getItem` + `JSON.parse` 一遍（一次 render 要解析 4 + 卡片数 次）。
     写盘与别的标签页改过时立刻作废（`writeLib` 与下面的 storage 监听）；
     另加 2 秒软过期，兜住「别处直写 localStorage」那条路（云同步写回不走本标签页的 storage 事件）。
     ⚠ 返回的是**同一份引用**：本文件里直接改元素的地方都是「改了立刻 writeLib」；
     新加「读出来 → 改 → 不写」的路径时别拿它当私有副本。 */
  let _libCache = null, _libAt = 0;
  const TTL_LIB = 2000;
  function listLib() {
    if (_libCache && Date.now() - _libAt < TTL_LIB) return _libCache;
    const a = read(K_CHARS, []);
    _libCache = Array.isArray(a) ? a : [];
    _libAt = Date.now();
    return _libCache;
  }
  window.addEventListener('storage', e => { if (!e.key || e.key === K_CHARS) { _libCache = null; _libAt = 0; } });
  /* ---------- 素材库的设置项：默认值与取值只在这里点一次名 ----------
     界面上的文案与**真的发给 AI 的那份参数**必须同一份判据 —— 各写一份就会出现「提示说会、其实没发」。
     设置页也照这张表渲染控件（§2 能力/声明驱动）。
     键名一律带 char_ 前缀（2026-10 由 dr_ 改过来）。搬运见 ui.js 的 migrateRenamedKeys()。 */
  const SET = {
    aiVoice: { key: 'char_ai_voice', kind: 'bool', def: '1', label: '让 AI 给角色定音色（性格 → 音色描述 / 复刻）' },
    /* 音色方式（2026-10 用户要求：「不应该使用固定音色的模型让我选择音色」）：
       默认 auto = 自动挑**这一家最好的那一种**，顺序是生成音色 > 音色复刻 > 预设音色。
       换一家只有预设型号的语音平台时，auto 落到预设上并照实说明，
       而不是把一排固定音色摆出来让人猜哪个像。 */
    ttsMode: { key: 'char_tts_mode', kind: 'opt', def: 'auto', label: '音色怎么定',
      hint: '默认「自动」：优先让 AI 按角色的外貌与性格现造嗓子，这一家没有这类型号时才退回预设音色。',
      options: [{ id: 'auto', label: '自动（优先生成音色）' }, { id: 'design', label: '按描述生成音色' },
        { id: 'clone', label: '复刻参考音频' }, { id: 'preset', label: '从固定音色里挑' }] },
    /* 候选张数：角色、场景、道具**一次出几张**让你挑。
       它是**下限**，实际张数由两个数取小的那个：
         ① 这个设置（这里，1~8）；
         ② 这一次用的生图型号声明的 `max_outputs`（`previewCap`）——
            上游只让一次出一张时，摆 3 个格子也没用，界面上照实说是 1 张。
       一次出 3 张 = 3 倍的钱，所以默认值取 3（够挑、又不像「再出 4 张」那么肉疼），
       想要更省就改 1（等于回到只出一张、挑不了）。 */
    candN: { key: 'char_cand_n', kind: 'num', def: '3', unit: '张', step: '1', min: '1', max: '8',
      label: '角色 / 场景 / 道具 一次出几张候选',
      hint: '调大就是多画几张：每张换一条提示词（背景 / 光线 / 表情），是几个可挑的路子；上限看生图平台一次能让几张' },
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
  const aiVoiceOn = () => flagOn('aiVoice');
  const candN = () => { const n = Number(setting('candN')); return Number.isFinite(n) && n >= 1 ? Math.round(n) : Number(SET.candN.def); };
  const TIME_OFS = [{ id: '深夜', label: '深夜' }, { id: '白天', label: '白天' }, { id: '黄昏', label: '黄昏' }, { id: '清晨', label: '清晨' }];

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
      /* faces 是**候选排**（界面上的「候选脸」那一排，见 picCandsHTML）。
         一次出 N 张 = N 条不同的提示词（见 CAND_VAR），攒在这里让用户挑。
         candTurn = 已经轮转到第几条差异轴：靠它保证「再画 N 张」拿到的是**下一批**轴，
         而不是把同一批重画一遍（那等于让用户花两次钱挑同一组图）。 */
      faces: Array.isArray(o.faces) ? o.faces : [],   // [{src, name}] 候选
      candTurn: Number(o.candTurn) || 0,              // 差异轴轮转位（不归一成 0 以外的也没关系，只取数值）
      face: o.face || '',                       // 选中的那张（预览图 + 传给生图/生视频 AI 的脸）
      /* 身份锚点：出图 / 出资产 / 导演台取参考图时**优先**用这一张。
         与 `face` 分开是有意的：`face` 是卡片上展示的那张，锚点是「认人最准的那张」
         （正脸、白底、五官清楚）。没设 = 跟随预览图，老数据一个字节不用迁移。 */
      anchor: o.anchor || '',
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
      anchor: o.anchor || '',
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
      anchor: o.anchor || '',
      group: String(o.group || '').slice(0, 20),
      faces: Array.isArray(o.faces) ? o.faces : [],
      candTurn: Number(o.candTurn) || 0,               // 差异轴轮转位（与库条目同义，见 CAND_VAR）
      assets: o.assets || {}, assetCands: o.assetCands || {},
      inLib: !!o.inLib, libId: o.libId || '' };
  }

  /* ============================================================================
     二、素材库那份「读得出来吗」的判据
     ----------------------------------------------------------------------------
     库里的东西读不出来的时候**不能当成「本来就没有」**。
     Store.read 为了「别让一条脏数据卡死整页」，解析失败与「不是信封」都直接返回默认值 []；
     而 Lib.save / Lib.remove 都是「list() → 改一处 → 写回去」——
     那一刻一次普通保存就会把「空列表 + 当前这一条」写回去，磁盘上还完好的其它素材整批消失，
     且随 storage 钩子同步覆盖到 .data/char_lib.json。原始值非空而读出来是空 = 读坏了，不是没有。
     ========================================================================== */
  function brokenOf(key, label) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { return '本机存储读不出来（隐私模式？）'; }
    if (raw == null || raw === '') return '';
    let p = null;
    try { p = JSON.parse(raw); } catch { return '这份' + label + '在本机解析不了（可能写坏了）'; }
    const isEnv = p && typeof p === 'object' && !Array.isArray(p) && 'data' in p;
    /* 不是信封 = 旧格式（历史上存过裸值）。Store.read 对它也返回默认值，同样是「看起来没有」。 */
    if (!isEnv) return '这份' + label + '是旧格式（不是 { data, ts } 信封），现在读不出来';
    if (!Array.isArray(p.data)) return '这份' + label + '的结构不对（不是一串记录）';
    return '';
  }
  function libBroken() { return brokenOf(K_CHARS, '素材库数据'); }

  /* ============================================================================
     三、素材库
     ----------------------------------------------------------------------------
     存进来的角色跨剧复用：脸、声音、三视图都跟着走。场景存描述、时段与那张图；
     道具（2026-10）存描述与它自己那一张图。
     ========================================================================== */
  /* ---------- 素材库的三种类型：角色 / 场景 / 道具 ----------
     库里不再有「旁白」这一种类型：旁白只是**某一集里**这位角色只出声，
     所以读库时归成「角色 + voiceOnly」，拉进某一集时再还原成 kind='narrator'（配音链路照旧）。
     场景与道具条目沿用角色的字段名（look = 描述、face = 预览图），
     进出某一集时才换成 scene 自己的 desc / img —— 两套名字只在下面那几个边界函数里换。
     **道具**（2026-10）是与角色、场景平级的第三种类型：它有自己的名字、描述与预览图，
     出图不靠别人的脸（照描述直接出），也没有表情 / 服装 / 三视图那一套 —— 只有一张图就是它自己。 */
  const LIB_KINDS = { actor: '角色', scene: '场景', prop: '道具' };
  /* 三种类型各自「这一栏叫什么、给个什么例子、建完提醒什么」—— **全站只有这一份表**。
     新建弹窗与素材库卡片的编辑区都读它：以前同一个字段在两处是两个名字（编辑区写「场景描述（出场景图靠它）」、
     新建写「外貌 / 场景 / 道具描述（出图就靠它）」），而新建那一版把三种例子塞进一个占位里，
     选了什么类型都看到同一句又长又杂的话。
     ⚠ 这里**只管措辞**。「这一类到底有没有声音 / 时段 / 角色资产」仍然问 `isVoiced` /
        `isSceneItem` / `isPropItem` 那三份判据（数据层的字段形状说的），不在表里再立一套 ——
        两处各判一次就会出现「表说场景没时段、编辑区却画出来了」。
     放在数据层而不是页面里，是因为「新建一条素材」曾经有**两个入口**（素材库页、拍短剧的挑选弹窗）：
     写在页面里第二处就会漂 —— 事实正是漂过：短剧那份没有场景的「时段」一行（建出来的场景只能事后
     回编辑区补），例子还是三种类型混在一格。拍短剧页 2026-10 删除，现在只剩素材库页一个入口，
     但表仍然留在数据层 —— 表单一旦挪回页面，再加第二个入口时就会重新漂一遍。 */
  const KIND_FIELDS = {
    actor: {
      look: { lab: '外貌 / 人物特点（预览图与角色资产都靠它）', ph: '例：二十出头，齐肩黑发，总穿米色风衣' },
      bio: { lab: '一句话人设（发给文字 AI 当「人物特点」）', ph: '例：嘴硬心软的师姐，嘴上不饶人但每次都替别人收尾' },
      tip: '预览图与角色资产在这里出，声音也在这里定',
    },
    scene: {
      look: { lab: '场景描述（出场景图靠它）', ph: '例：教学楼天台，傍晚，铁栏杆与晾衣绳' },
      bio: { lab: '一句话说明（这一处是什么地方：只进搜索与文字 AI，不影响出图）', ph: '例：两人摊牌的地方，视野开阔但没有能躲的角落' },
      time: { lab: '时段（出这张场景图时那句「…的光线」用的就是它）', hint: '不在下面几档里的值会照实列出来，改回哪一档由你点' },
      tip: '光线按上面那一档「时段」走（没动就还是默认的深夜），出图那句「…的光线」用的就是它',
    },
    prop: {
      look: { lab: '道具描述（出道具图就靠它）', ph: '例：牛皮纸旧信封，边角磨白，盖一枚红蓝邮票' },
      bio: { lab: '一句话用途（剧情里这件东西干什么用，发给文字 AI）', ph: '例：用来交代那半页没写完的地址' },
      tip: '道具就靠上面那句描述画一张图，没有角色资产那一套，也不出声',
    },
  };
  const kindF = k => KIND_FIELDS[k] || KIND_FIELDS.actor;
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
       于是它被认成场景（这条路随拍短剧页删了，但判据还在，别为了删页面把库里的类型认错）：
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
  /* 这一集里的这一条是角色、场景还是道具：场景有 desc 没有 look（AI 拆出来的那些字段都不全，所以两个都看） */
  function episodeKindOf(x) {
    if (!x) return 'actor';
    if (x.kind === 'scene' || x.kind === 'prop') return x.kind;
    return ('desc' in x || 'time' in x) && !('look' in x) ? 'scene' : 'actor';
  }

  /* ⚠ toEpisodeProp / toLibItem / inEpisode / episodePool 这一族「剧侧 ↔ 库」的互转，
     2026-10 随拍短剧页（pullInto / adopt / adoptAll 那一族）一并删除 ——
     素材库页是**就地编辑** char_lib，不再往任何一集里塞条目，所以没有第二份数据要对齐。 */

  /* 素材库存盘的两种「没存进去」都在这一处留话，页面只问一次：
     存盘失败必须看得见，不能界面照旧写「改完就地存」）。
     ① 配额撞满 / 存储不可用 —— `Store.write` 返回 {ok:false}，以前这里的返回值被整句丢掉；
     ② 库里那份读不出来（`libBroken`）—— 这时**根本不写**，写下去就是把整库洗成一条。 */
  let libWriteErr = '';
  function writeLib(xs) {
    /* 不传 cap：素材库**不再有 300 条的截断**（2026-10 用户要求：各种功能都不要加限制）。
       以前这里传 300，而 `Store.write` 的 cap 是**静默丢弃**（只 console.warn 一句）——
       用户看到的只是「我最老的素材凭空没了」。现在条数不限：
       真到浏览器 5MB 额度满时，Store.write 会**报出来**（带一句「到资产库清理或先下载再清」），
       那时候是响的失败，不是悄悄删人的东西。 */
    const r = write(K_CHARS, xs);
    /* 写盘之后缓存必须作废：返回同一份引用会让下一次 `Lib.list()` 读到的还是写入前那份。 */
    _libCache = null; _libAt = 0;
    libWriteErr = (r && r.ok === false) ? String(r.error || '本机存储写不进去') : '';
    return r;
  }
  const LIB_STOP = '：已停止保存，磁盘上原来的数据一个字没动。先别在素材库页上继续改'
    + '（继续改会拿这一条把整库覆盖掉）；到「设置」导出一次整包备份确认数据还在，再回来。';

  /* 「这一条素材能被搜到哪些字」只有这一份表。三个读它的地方：
     ① 素材库页的关键词过滤；② 那一行搜索说明（从这张表现拼，加一栏就一起变）；
     ③ AI 助手的 `chars` 查询。以前页面只查名字 / 人设 / 外貌 / 分组、助手只查名字，
     于是「深夜」「琪琪的常服」「中年男声」这些卡片上明摆着写的字，页面上搜不出、
     助手还要回一句「库里没有这一位」。
     时段只有场景有、设定图只有角色与老场景有、道具那些声音字段本来就不存在 ——
     取不到就并进空串，不按类型分叉。 */
  const SEARCH_FIELDS = [
    ['名字', c => c.name],
    ['人设', c => c.bio],
    ['描述', c => c.look || c.desc],
    ['分组', c => c.group],
    ['时段', c => c.time],
    ['设定图', c => assetsOf(c).map(a => a.name).join(' ')],
    ['声音', c => [c.voiceName, c.voiceNote, c.refAudioName].join(' ')],
  ];
  function hayOf(c, lower) {
    const s = SEARCH_FIELDS.map(f => String((f[1] || (() => ''))(c || {}) || '')).join('\n');
    return lower ? s.toLowerCase() : s;
  }

  /* ============================================================================
     素材库的对外接口 —— **这一份清单是「有哪些 API」的答案**
     ----------------------------------------------------------------------------
     为什么把它写成代码而不是文档：文档会过期，而这一层每个函数头上都有判据说明。
     `Chars.Lib.api()` 返回它（也挂成 `Chars.Lib.API`），页面、助手与新代码都能现查 ——
     「素材库能不能从外部调」这件事从此是可核对的事实，不用记。
     2026-10 拍短剧页删除后，这一族原来分三组（读 / 写 / 与某一集打交道），
     第三组整个没有了 —— 素材库不再往任何一集里塞条目。
     ========================================================================== */
  const LIB_API = [
    /* ---- 读（不花钱、不写盘）---- */
    ['list()', '库里全部条目（角色 / 场景 / 道具混在一个数组里，用 libKindOf 分类型）'],
    ['get(id)', '按 id 取一条；找不到 null'],
    ['hayOf(c)', '把一条拼成可搜索的一串文本（配合 SEARCH_FIELDS）'],
    ['SEARCH_FIELDS', '搜索覆盖哪几个字段（一份表，页面不要自己再列一遍）'],
    ['broken()', '这一份读得出来吗（空串 = 没问题）；读坏了时任何写入都会被拒'],
    ['groups()', '分组名单与每组条数（按名字排，未分组不进来；组名按 nameKey 合并）'],
    ['groupMatch(x, want)', '这一条算不算在这一组（__none = 未分组 / 组名按 nameKey 比）；筛组与数条数共用这一份'],
    ['groupNameOf(x)', '这一条落在名单里的哪一组（返回名单那种写法；没分组返回空串）'],
    ['Chars.toEpisodeChar(src)', '库里那一条 → 剧侧角色对象（唯一的字段映射，外部不要自己拼）'],

    /* ---- 写（会落盘；save/remove 会自己拒「读坏了」）---- */
    ['save(char, {exact})', '存一条。默认按「同类型 + 同名」合并（库里手改的字段优先），exact:true 则原样覆盖'],
    ['remove(id)', '删一条。库读坏了时返回 false 并把原因留在 writeError() 里，**调用方必须接**'],
    ['newForm({group, onlyFields})', '新建素材的表单。默认填完就建档；onlyFields:true 只做校验与归一、把字段交回（配commitForm 用）'],
    ['commitForm(fields)', '拿一份字段 + 挑好的图与音色**建档**（只有Fields 那条路用；这是那一路唯一写库的一下）'],
    ['writeError()', '取走最近一次写入失败的原因（取完即清）'],
  ];
  const Lib = {
    /* 接口清单（自描述）：`Chars.Lib.API` 或 `Chars.Lib.api()`。
       加了新接口就往那张表里加一行 —— 它是给人看的，也是给新代码找路的。 */
    API: LIB_API,
    api() { return LIB_API.slice(); },
    /* 搜索的字段表与那份「拼成一串」的文本：页面与助手都读这一处（见上面 SEARCH_FIELDS） */
    SEARCH_FIELDS,
    hayOf(c) { return hayOf(c, true); },
    list() { return listLib(); },
    /* 这一份读得出来吗（'' = 没问题）。页面在**任何**写入之前不需要问，因为 save / remove 自己会拒；
       要主动在界面上摆一句「这一页现在存不进去」时才用它。 */
    broken: libBroken,
    /* 取走最近一次素材库写入失败的原因（取完即清，避免下一次成功写入还带着旧账）。 */
    writeError() { const e = libWriteErr; libWriteErr = ''; return e; },
    /* 库里只有「素材」这一种东西了：2026-10 之前这里还挂着 inEpisode / episodePool / pullInto
       那一族（「把这一条拉进某一集」），拍短剧页删除后连同唯一调用方一起去掉了。 */
    save(char, o) {
      const broken = libBroken();
      if (broken) { libWriteErr = broken + LIB_STOP; return char; }
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
        anchor: keep(char.anchor, base.anchor),               // 身份锚点（空 = 跟随预览图）
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
        /* 自动定音色的两条留痕（与 `newChar` 的字段表同一批）：`voiceErr` 是「这一位为什么没声音」，
           `voiceAuto` 是定成的那句摘要。库里不存它们，素材库页上「没定成声音：…（再让 AI 定一次）」
           那一块就是刷新即消失 —— 而这块的唯一用处正是让用户知道下一步该按哪一颗。 */
        voiceErr: keep(char.voiceErr, base.voiceErr),
        voiceAuto: keep(char.voiceAuto, base.voiceAuto),
        /* 差异轴的轮转位也必须入库：`drawPreview` 每次出完 N 张就把它加 N，
           不落盘就等于下一次出候选又从第一条轴开始 —— 用户花两次钱挑同一批图。 */
        candTurn: Number(char.candTurn || base.candTurn) || 0,
      });
      const i = merge ? (byId >= 0 ? byId : byName) : 0;
      if (merge) xs[i] = c; else xs.unshift(c);
      writeLib(xs);
      return c;
    },
    get(id) { return Lib.list().find(c => c && c.id === id) || null; },
    /* 分组名单（素材库页渲染「整组」那一排、导演台拆分镜列「素材范围」都读它）：按名字排，未分组不进来。
       组名是自由文本，所以**按 `window.nameKey` 合并**：「校园篇」「校园篇 」「校园 篇」在用户眼里是一组，
       以前按字面 trim 各算一份，表现是下拉写着「校园篇（12）」而筛出来只有 10 条 ——
       名单与筛组用的是两把尺子。名单里显示的是**库里第一次出现的那一种写法**。 */
    groups() {
      const m = new Map();
      for (const x of Lib.list()) {
        const g = String((x && x.group) || '').trim();
        if (!g) continue;
        const k = window.nameKey(g);
        const hit = m.get(k);
        if (hit) hit.n++; else m.set(k, { name: g, n: 1 });
      }
      return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    },
    /* 「这一条算不算在 `want` 这一组里」全站只这一份：素材库页筛组、数「未分组有几条」、
       导演台按组取素材范围都问它 —— 名单（上面 groups）与筛组必须是同一把尺子，
       否则那个数字就成了「点下去筛不出这么多」的承诺。
       `want` 用页面上那两个哨兵：`'__none'` = 未分组；其它字符串 = 某一组的显示名（按 nameKey 比）。
       **空串不在这里判**：它在这一页的意思是「全部组」，调用方自己短路。 */
    groupMatch(x, want) {
      const g = String((x && x.group) || '').trim();
      if (want === '__none') return !g;
      const k = window.nameKey(want);
      return !!g && !!k && window.nameKey(g) === k;
    },
    /* 下拉要怎么落：`want` 可能是一个**已经改掉的组名**（用户把那一组整体改名了）。
       直接拿字面去比 `<option>`，没有任何一项 selected，浏览器显示第一项「全部组」，
       而筛的仍是那个已不存在的名字 —— 界面上「全部组」却一条都筛不出来。
       这里按 `nameKey` 对回名单里的写法；对不上就回空串（= 全部组）。 */
    reconcileGroup(want, gs, hasNone) {
      const list = Array.isArray(gs) ? gs : Lib.groups();
      const w = String(want || '');
      if (!w) return '';
      if (w === '__none') return hasNone ? '__none' : '';
      const hit = list.find(g => window.nameKey(g.name) === window.nameKey(w));
      return hit ? hit.name : '';
    },
    /* 这一条**落在名单里的哪一组**（返回的是名单那一种写法，不是条目自己存的那一种）：
       素材库页「编辑完把档切过去」要用它 —— 直接拿 `c.group` 原文去选，可能选到一个下拉里没有的变体，
       下拉显示「全部组」而筛的却是那一组。没分组的返回空串（调用方按哨兵 `'__none'` 摆）。 */
    groupNameOf(x) {
      const hit = Lib.groups().find(g => Lib.groupMatch(x, g.name));
      return hit ? hit.name : '';
    },
    /* **把一整组素材改到另一个组名**（导演台「项目组改名」那一路）。
       组名是自由文本，所以「同一组」的判据是 `groupMatch`（按 nameKey 合并近名）——
       组里可能存着「校园篇」「校园篇 」两种写法，改组时**全部**改成新写法，
       只改其中一种写法的话，改完那组就裂成两半（名单与筛组的尺子各认一种）。
       返回 { n, why }：n = 改了几条；why = 没改成的原因（读坏了 / 库里没有那一组）。
       ⚠ 这是**改用户数据**：调用方必须先问过用户（导演台那一路只提示、问过才调）。 */
    renameGroup(oldName, newName) {
      const o = String(oldName || '').trim();
      const nw = String(newName || '').trim();
      if (!o || !nw) return { n: 0, why: '组名不能是空的' };
      if (window.nameKey(o) === window.nameKey(nw)) return { n: 0, why: '' };
      const lb = libBroken();
      if (lb) return { n: 0, why: '这一组没改：' + lb + '。已停手，磁盘上原来的数据一个字没动。' };
      const list = Lib.list();
      /* 按 `groupMatch` 认这一组（含近名变体），不是按字面比。 */
      const hit = list.filter(c => c && Lib.groupMatch(c, o));
      if (!hit.length) return { n: 0, why: '' };
      const next = list.map(c => (c && Lib.groupMatch(c, o)) ? Object.assign({}, c, { group: nw }) : c);
      writeLib(next);
      const e = Lib.writeError();
      if (e) return { n: 0, why: '这一组没改掉：' + e };
      return { n: hit.length, why: '' };
    },
    remove(id) {
      /* 删之前先问一次「这一份读得出来吗」：下面拿的正是 `Lib.list()` 的结果当写入底座，
         读坏了还照旧写回去，磁盘上完好的那一整批就没了（与 `save` 同一立场，见 `brokenOf`）。 */
      const lb = libBroken();
      if (lb) {
        libWriteErr = '这一条没删掉：' + lb
          + '。已停手，磁盘上原来的数据一个字没动；到「设置」导出一次整包备份确认数据还在，再来删。';
        return false;
      }
      writeLib(Lib.list().filter(c => c && c.id !== id));
      return true;
    },
    /* 「新建一条素材」那一张表单：字段、措辞、重名拦截、按类型建对象、存进库 —— 只有这一份。
       两个入口（素材库页的「新建」与当年的拍短剧挑选弹窗）各写一份时漂成了两副样子，
       短剧那一份连场景的「时段」都没给（见上面 KIND_FIELDS 那段）。
       页面之间的差异只有两件，都从参数进来 / 交回页面自己做：
       ① 分组默认值（素材库正筛着某一组时带过去）；
       ② 建完之后干什么（素材库要松开挡住它的筛选、开编辑区并滚过去）。
       返回值：`null` = 用户取消；`{ error }` = 没建成（那句话直接给人看）；
       `{ item, kind, tip }` = 建好了，`tip` 是这一类「接下来在哪儿出图 / 出声」的那句说明。 */
    /* 措辞表对外只有这一个口子：素材库页的卡片编辑区与新建回执都读它，页面不再自己抄一份。 */
    kindF,
    async newForm(o) {
      const opt = o || {};
      const kf = kindF('actor');
      /* 选了类型就把那一类的说法换上来。`PromptForm` 的 `onChange` 只交出「读值 / 改文字 / 藏一行」
         三个口子，整张表单不重画 —— 重画会把刚打进去的字清掉。 */
      const paint = (k, api) => {
        const f = kindF(k);
        api.set('look', { label: f.look.lab, placeholder: f.look.ph });
        api.set('bio', { label: f.bio.lab, placeholder: f.bio.ph });
        /* 时段只有场景有：给角色摆一行「填了也没地方存」的控件，比不给更让人糊涂。 */
        api.set('time', { hidden: k !== 'scene' });
      };
      const v = await PromptForm.open({
        title: '新建一条素材（存进素材库）', okLabel: '存进库',
        fields: [
          { key: 'name', label: '名字', type: 'text', placeholder: '例：小雅 / 天台 / 旧信封' },
          { key: 'kind', label: '类型', type: 'select', value: 'actor',
            options: Object.keys(LIB_KINDS).map(k => ({ v: k, t: LIB_KINDS[k] })) },
          /* 分组带当前这一档：正看着「校园篇主要角色」这一组、顺手新建一位，
             十有八九是要加进这一组 —— 让人再抄一遍组名是多余的一步（筛到「未分组」时不带）。 */
          { key: 'group', label: '分组（可留空；素材库页能按整组筛与查找）', type: 'text',
            value: opt.group || '', placeholder: '例：校园篇主要角色' },
          /* 描述排在「人设」前面：它是出图与出资产的依据，先写「长什么样」再写「是什么人」更顺。
             （以前两行是反的，填表时很容易把外貌写成性格。） */
          { key: 'look', label: kf.look.lab, type: 'textarea', placeholder: kf.look.ph },
          /* 预览图**在建档这一步就能配**（用户要求）：不靠生成，直接从资产库 / 我的收藏 /
             本机文件里拿一张现成的。留空也行 —— 存好之后还能出图或再挑。
             选来的那张会先落成本机资产（本地上传的 blob: 地址一刷新就没了，
             生成工作台与资产库那边也认不出它）。 */
          { key: 'pic', label: '预览图（可留空）', type: 'pic', pickLabel: '挑一张',
            hint: '从资产库 / 我的收藏 / 本机文件里挑一张现成的；留空也行，存好后还能按描述出图',
            pick: async api => {
              const got = await window.AssetPicker.open({ types: ['图片'], multiple: false, limit: 1,
                title: '给这一条选一张预览图' });
              if (!got || !got[0]) return;
              const it = got[0];
              const r = await window.AssetTransfer.toLocalAsset(it.file || it.dl || it.src || it.url,
                { name: ((api.values().name || '素材') + '-预览图').slice(0, 40), from: it.provider || 'picker' });
              api.set('pic', { value: r.src });
            } },
          { key: 'bio', label: kf.bio.lab, type: 'textarea', placeholder: kf.bio.ph },
          /* 一开是收着的（默认类型是角色）；选到场景才露出来。选项现读 `TIME_OFS`，
             不在页面里另写一份时段名单。 */
          { key: 'time', label: kindF('scene').time.lab, hint: kindF('scene').time.hint,
            type: 'select', value: '深夜', options: TIME_OFS.map(t => ({ v: t.id, t: t.label })),
            hidden: true },
        ],
        onChange: (key, api) => { paint(api.values().kind, api); },
        /* 重名**必须在这一步拦**：放到提交之后再报的话表单已经关了 ——
           用户刚打进去的名字、描述、人设一起丢掉，只剩一句 toast。
           validate 返回非空就停在表单里，输入全在。 */
        validate: f => {
          const nm = String(f.name || '').trim();
          if (!nm) return '名字不能空着';
          const cut = nm.slice(0, 20);
          if (Lib.list().some(x => x && x.name === cut && libKindOf(x) === f.kind)) {
            return '素材库里已经有「' + cut + '」这条' + (LIB_KINDS[f.kind] || '') + '了：同名会被当成同一条，换个名字';
          }
          return '';
        },
      });
      if (!v) return null;
      const name = String(v.name || '').trim().slice(0, 20);
      /* 兜底再查一次：表单开着的时候库可能被别的标签页改过（storage 事件那边会重画页面）。
         走到这里才失败属于极少数，照旧返回 error 由调用方说话。 */
      if (Lib.list().some(x => x && x.name === name && libKindOf(x) === v.kind)) {
        return { error: '素材库里已经有「' + name + '」这条' + LIB_KINDS[v.kind] + '了：同名会被当成同一条' };
      }
      /* 场景也带上那句说明：`newScene` 是给剧侧用的（那边场景只有描述 / 图 / 时段三项，没有这一栏），
         而**库里**这一条的 bio 有人读 —— 关键词搜索（`Lib.SEARCH_FIELDS` 的「人设」）、
         素材库页的「AI 找素材」、以及描述空时 `descOf` 的退路。所以在这里补这一项，
         不动剧侧的对象：那一集里根本不存在放它的地方，硬加字段只会多一个没人读的键。 */
      /* 「先出后选」那条路要**只填不建**：`onlyFields` 为真时这里只做校验（名字 / 重名）与归一，
         把表单值原样交回去，由页面拿它去出图出声、让用户挑完再调 `commitForm` 建档。
         **必须排在建档之前** —— 放在 `Lib.save` 之后就等于「先出后选」这条路已经偷偷建了一条空记录，
         用户挑完图再 commit 时，那条重名记录会把它挡下来（同名即同一条）。
         以前只有「填完立刻建」一种走法，于是出图与出声只能发生在建之后 ——
         用户要么接受一张没挑选过的图，要么手动再重出一次。 */
      if (o && o.onlyFields) {
        return { fields: { name, kind: v.kind, group: String(v.group || ''), look: String(v.look || ''),
          bio: String(v.bio || ''), time: String(v.time || '深夜'), pic: v.pic || '' }, kind: v.kind };
      }
      const item = v.kind === 'scene'
        ? Object.assign(newScene({ name, desc: v.look, time: v.time, group: v.group }), { bio: v.bio || '' })
        : v.kind === 'prop' ? newProp({ name, look: v.look, bio: v.bio, group: v.group })
          : newChar({ name, kind: v.kind, bio: v.bio, look: v.look, group: v.group });
      /* 建档时挑好的那张预览图：`setPic` 按类型写到该写的字段上（角色/道具 face、场景 img），
         页面不必知道这一条存的是哪个键。 */
      if (v.pic) setPic(item, v.pic);
      const saved = Lib.save(item, { exact: true });
      /* 存不进去（配额撞满 / 库里那份读不出来）就别让页面接着说「建好了」：原因由数据层留着，
         取出来交回调用方去说（两个入口的提示组件不一样，话只能说一句）。 */
      const e = Lib.writeError();
      if (e) return { error: e };
      return { item: saved, kind: v.kind, tip: kindF(v.kind).tip };
    },
    /* 「先出后选」的第二半：拿一份字段 + 用户挑好的图与音色**建档**。
       建档这一下是唯一写库的地方（与 commitForm 是同一段），所以「哪些字段进了库」
       永远只有一个实现。`pic` 是挑中的那一张；`voice` 那几项直接写进库里那一条。 */
    commitForm(f, opts) {
      const o2 = opts || {};
      const kind = String((f && f.kind) || 'actor');
      const name = String((f && f.name) || '').trim().slice(0, 20);
      if (!name) return { error: '名字不能空着' };
      if (Lib.list().some(x => x && x.name === name && libKindOf(x) === kind)) {
        return { error: '素材库里已经有「' + name + '」这条' + (LIB_KINDS[kind] || '') + '了：同名会被当成同一条' };
      }
      const item = kind === 'scene'
        ? Object.assign(newScene({ name, desc: f.look, time: f.time || '深夜', group: f.group }), { bio: f.bio || '' })
        : kind === 'prop' ? newProp({ name, look: f.look, bio: f.bio, group: f.group })
          : newChar({ name, kind, bio: f.bio, look: f.look, group: f.group });
      if (f.pic) setPic(item, f.pic);
      /* 挑好的音色（design 写描述 / preset 选 id / clone 带参考音频）—— 直接写进库里那一条，
         界面上「声音」那一块立刻认得出是 AI 定的还是用户挑的。 */
      if (f.voice) {
        item.voice = f.voice.voice || '';
        item.voiceName = f.voice.voiceName || '';
        item.voiceNote = f.voice.voiceNote || '';
        item.voiceMode = f.voice.voiceMode || 'preset';
        if (f.voice.refAudio) { item.refAudio = f.voice.refAudio; item.refAudioName = f.voice.refAudioName || ''; }
        item.voiceBy = f.voice.voiceBy || 'user';
      }
      if (Array.isArray(f.faces) && f.faces.length) item.faces = f.faces.slice(0, FACE_CAP);
      /* 候选里**不许**再自动把 faces[0] 顶成主图：以前有这一句，于是页面说了「只用文字创建（不带主图）」，
         库里那条还是带着一张 —— 而且带的是用户没点过的那一张。主图只有一个来路：`f.pic`，
         也就是挑选窗里被点中的那一张（自己传的也算，它就在候选第一格）。 */
      const saved2 = Lib.save(item, { exact: true });
      const e2 = Lib.writeError();
      if (e2) return { error: e2 };
      return { item: saved2, kind, tip: kindF(kind).tip, dropped: o2.faceDrop || 0 };
    },
  };
  const round2 = n => Math.round(n * 100) / 100;
  /* 占位符填充：{xxx} → 值。用户在设置页里把某条挪走或删掉都不会炸（对不上就不替换）。
     **实现在公共层 `window.TplVars.fill`**（Skill 正文里的变量占位符只有那一份填法）——
     这里只留一个薄壳，免得这一处与公共层各写一份正则、规则迟早对不上。 */
  function fillTpl(tpl, vals) {
    return (window.TplVars && TplVars.fill) ? TplVars.fill(tpl, vals)
      : String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vals[k] == null ? m : String(vals[k])));
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
    if (!groups.length) return '<span class="ui-hint">' + esc(o.emptyText || '注册表里没有这一类平台') + '</span>';
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
     刻意不做进 `TextAI`：它只影响这一份画预览图的流程。另外各页的 AI 动作（定音色 / 拆镜头）**没有**
     兜底 —— 它们问不通就该当场报错，不该被这一处的熔断顺手关掉。 */
  const AI_BAD_MAX = 2;                 // 连续问不通几次就断开
  const AI_OFF_MS = 5 * 60 * 1000;      // 断开多久（页面照实告诉用户还要等多久）
  let aiBad = 0, aiOffUntil = 0;
  function aiOk() { return Date.now() >= aiOffUntil; }
  function aiMarkOk() { aiBad = 0; aiOffUntil = 0; }
  function aiMarkBad() { if (++aiBad >= AI_BAD_MAX) aiOffUntil = Date.now() + AI_OFF_MS; }

  /* 图片 AI 的提示词：设定（外貌 / 环境）→ 文字 AI 按设置页那条指令写成高质量提示词 → 图片 AI 出图。
     指令默认文本在 text-ai.js 的 TextAI.DEF.char_image，设置页能改；这里只填当次的占位符。
     文字 AI 没配或失败就退回用设定原文 —— 那是「少润色一次」，不是「什么都做不了」。 */
  async function imagePrompt(REG, vals) {
    const tpl = TextAI.prompt('char_image');
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
  /* 「认人最准的那一张」：身份锚点优先，否则退回预览图。
     出图、出角色资产、导演台取参考图**只许**读这一处 —— 与显示用的 `picOf` 分开：
     卡片上可以摆一张更好看的，而送去当参考的必须是用户指定的那张正脸。 */
  function refPicOf(x) { return (x && (x.anchor || x.face || x.img)) || ''; }
  /* 写预览图。**只有一个入口**（素材库页与导演台都走它），所以这里顺手投一个事件：
     「这条素材现在有图了」—— 导演台靠它把拆分镜写下的 `@待建:名字` 占位符换成真名，
     并把那张图补进引用它的镜头（=「生成完自动显示图片」那一条）。
     用普通事件而不是 `window.__*` 钩子：后者是跨脚本层的私有通道，
     AGENTS §8 的 G8 判据数着它们，新增一枚要登记理由 —— 这里不需要那种特权。 */
  function setPic(x, src) {
    if (x && 'face' in x) x.face = src; else x.img = src;
    try {
      window.dispatchEvent(new CustomEvent('wb:char-pic', { detail: { item: x, src: src } }));
    } catch (e) { /* 投不出去不影响写图 */ }
    return src;
  }
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
    catch (e) { return { err: errText(e)}; }
  }
  /* ---------- 候选之间要有差异：一次出 N 张 = N 条**不同的**提示词 ----------
     以前是「一条提示词 + count:N」：同一条提示词下出的 N 张，长相与构图高度相似，
     于是「出 3 张让你挑」挑出来的是同一张的三个抖动 —— 钱按 3 张付，挑的却不是三个方向。
     现在改成 **N 次单张请求、每次换一条差异轴**。钱不变（还是 N 张），变的是「彼此像不像」。 */
  /* 差异轴按对象分三种。角色的基准是**正面白底证件照**（见下面 baseWhat），
     所以差异只在合规范围内动：背景远近、表情、留白。
     **刻意不放「换角度/换发型/换服装」这类轴** —— 脸就是后面认脸与三视图的锚点，
     轴一动就等于把人选好的那一张预览图作废（挑中了谁，另一几张却是另一个人）。 */
  const CAND_VAR = {
    char: [
      '胸部以上构图，表情平静自然，肩线端正',
      '胸像构图，面带轻微自然微笑，嘴角微微上扬',
      '略近的胸像构图，五官在画面中占比更大，细节更清晰',
      '肩部以上构图，头部居中，四周留白均衡',
      '胸部以上构图，表情沉稳严肃，双唇自然闭合',
      '胸像构图，双眼平视镜头，头部略微前倾，颈肩线条清晰',
    ],
    scene: [
      '清晨侧光，光线低角度斜射，空气清冷，影子较长',
      '正午顶光，影子短而硬，色彩明亮通透',
      '黄昏暖光，光线压得很低，空间层次被拉长',
      '阴天散射光，明暗对比柔和，色调偏冷灰',
      '夜晚，以人工光源为主，局部暖色点缀，远景压暗',
      '雨后，地面有积水反光，天空云层较厚',
    ],
    prop: [
      '正侧 45 度视角，柔和均匀布光，形制与材质都看得清',
      '正对镜头的平视视角，背景纯净，轮廓完整',
      '略俯视视角，突出顶部轮廓与表面质感',
      '正面视角，偏向表现材质纹理与做工细节',
      '正侧视角，用轮廓光把边缘勾出来，形状从背景里分开',
      '略仰视视角，物品显得更挺立，底座与支撑看得清',
    ],
  };
  /* 第 n 张该配哪条差异轴。按 `item.candTurn` 轮转：连点两次「出 N 张」拿到的是**下一批**轴，
     而不是把同一批重画一遍（那等于让用户花两次钱挑同一组图）。 */
  function candVarOf(item, n) {
    const bank = CAND_VAR[isPropItem(item) ? 'prop' : isSceneItem(item) ? 'scene' : 'char'];
    if (!bank || !bank.length) return '';
    const turn = Number(item.candTurn || 0), i = Number(n) || 0;
    return bank[(((turn + i) % bank.length) + bank.length) % bank.length];
  }
  /* 出预览图：角色 = 正面白底证件照，场景 = 无人物的空镜，道具 = 单件物品陈列。
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
    const total = Math.max(1, Math.min(previewCap(v.model), Number(o && o.count) || candN()));
    const scene = isSceneItem(item);
    const prop = isPropItem(item);
    const ratio = drama.opts.ratio || '9:16';
    /* 画幅：道具是单件物品，给竖幅反而浪费像素（1:1 最贴近「陈列一张图」）；
       场景跟整集画幅走（它就是这一集的取景框）；角色远景跟画幅走、近景给 1:1 定妆照。 */
    const ar = prop ? '1:1' : scene ? ratio : (ratio === '9:16' ? '9:16' : '1:1');
    /* 基准提示词。角色的那句从「正面半身，纯净浅色背景」改成**正面白底证件照**：
       预览图是后面认脸、三视图、生图与生视频的锚点，锚点越中性、背景越干净，
       视频 AI 越不容易把背景、发型、构图一起搬进每一段；「浅色背景」还会被理解成米色/灰蓝，
       白底才没有可被发挥的余地。 */
    const baseWhat = prop
      /* 道具**没有脸可照**：它的图就靠这句描述，所以「只按文字画、别加人物」这两句必须写死 ——
         生图模型很容易给一件雨伞配上一个拿着它的人，而道具是拿去当参考图的，
         参考图里带个人会让视频 AI 在每一段都凭空多出一个人。 */
      ? '这件道具的单件陈列图：只有这一件物品本身，完整入镜、居中、纯净浅色背景，不要人物、不要手、不要环境，不要加别的配件'
      : scene ? '空场景图：无人物，构图留出人物站位，' + (item.time || '') + '的光线'
        : (item.kind === 'narrator' || item.voiceOnly
          ? '这位角色的正面白底证件照（只出声也要有个形象）：纯白背景、正面平视、胸像构图、五官清晰无遮挡、表情自然'
          : '角色正面白底证件照：纯白背景、正面平视看向镜头、胸像构图、五官清晰无遮挡、头发不遮脸、均匀柔和的正面光、无多余饰品');
    const notes = [];
    const list = [];
    /* 两段式：先把 N 条提示词**一次写完**（每条换一条差异轴），再把这 N 次生图**一起发出去**。
       串着跑的话 3 张要等 3 倍时间 —— 而它们互不依赖，谁也不需要等谁。
       （第 1 步的「写提示词」是文字 AI 调用，第 2 步才是花钱的生图；两段都并行。） */
    const whatOf = i => {
      const dif = total > 1 ? candVarOf(item, i) : '';
      return dif ? (baseWhat + '；' + dif) : baseWhat;
    };
    const whats = Array.from({ length: total }, (_, i) => whatOf(i));
    /* 润色失败退回**设定原文**而不是不出图：imagePrompt 本身已有这层回退，
       这里再兜一次是因为现在 N 条并行，文字 AI 限流时挂掉的是其中几条。 */
    const prompts = await Promise.all(whats.map(w =>
      imagePrompt(REG, { what: w, name: item.name, look: descOf(item) || item.name, style: episodeStyle(drama), ar: ar })
        .catch(() => w)));
    /* 身份锚点：用户指定了「认人最准的那一张」时，重出预览图也拿它当参考 ——
       只按文字重画，同一个角色每换一次就换一张脸，而锚点存在的意义正是防止这件事。
       型号没有参考图槽位就照实说一句（不能假装用了）。 */
    let inputEntries = null;
    const anchor = String(item.anchor || '');
    if (anchor) {
      if (refImageRule(v.model)) {
        const en = await refEntryFor(v, anchor, item.name + '-身份锚点');
        if (en && en.err) notes.push('身份锚点没能发给生图 AI（' + en.err + '），这一批是按文字重画的');
        else if (en) inputEntries = [en];
      } else {
        notes.push('这个生图型号没有「参考图」槽位：这一批按文字重画，身份锚点没有发出去');
      }
    }
    const usePrompts = inputEntries
      ? prompts.map(p => p + '。严格沿用参考图里的同一个人：脸型、五官、发型都不要变')
      : prompts;
    const type = prop ? '素材-道具' : scene ? '素材-场景' : '素材-角色定妆';
    const snapTag = 'chars:' + (prop ? 'prop' : scene ? 'scene' : 'char') + ':' + item.id;
    const meta0 = prop ? { 道具: item.name, 画幅: ar } : scene ? { 场景: item.name } : { 角色: item.name, 画幅: ar };
    const settled = await Promise.allSettled(usePrompts.map((prompt, i) =>
      AiGen.image({ prov: v.prov, model: v.model, prompt: prompt, ar: ar, count: 1,
        snapTag, snapLabel: item.name,
        inputEntries: inputEntries,
        /* 任务号回传给调用方落盘：切页之后这一轮 JS 就没了，但任务还在平台上跑 ——
           存下号来，下次打开这一页能把它认领回来（见 assetlib 的 AiGen.adopt）。 */
        onTask: o && o.onTask,
        log: { type: type, meta: total > 1 ? Object.assign({ 候选: (i + 1) + '/' + total }, meta0) : meta0 } })
        .then(e => (e.entries || [e]).filter(x => x && x.src))));
    /* 一张没成不打断整批，但一定要照实说「出了几张、哪几次没成」——
       默默少给一张，用户还以为是自己挑走了。全部没成才抛出去（那通常是系统性的：
       没配生图接口、没余额、全部被限流），把每一条原因都带上。 */
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') list.push(...r.value);
      else notes.push('第 ' + (i + 1) + '/' + total + ' 张没出成：' + ((r.reason && r.reason.message) || String(r.reason)));
    });
    if (total > 1) item.candTurn = Number(item.candTurn || 0) + total;
    if (!list.length) throw new Error(notes.join('；') || '一张都没出成');
    /* 候选一律攒进 faces（旧的排在后面，多的按上限裁掉）；已经选中的那张不动 ——
       重画几张不该把人选好的预览图顶掉。`o.replace` 是「AI 重出预览图」那颗按钮：
       单张替换，没有候选可挑时不换就是点了没反应。 */
    const old = (item.faces || []).slice();
    /* 每张候选连同**身份**一起存（provider + 任务号 / 资产号）：只存地址的话，
       上游签名过期之后（/getv?url=… 只管一天）库里就只剩一张「已丢失」的破图，
       页面连回源都做不到。收藏页一直在用同一份 `Api.healMedia`，这里补上同一份凭据。 */
    const merged = list.map((x, i) => ({
      src: x.src, name: '第 ' + (old.length + i + 1) + ' 张',
      provider: x.provider || '', genId: x.genId || '', assetId: x.assetId || '',
    })).concat(old);
    /* 攒到上限之后最早的几张会被裁掉 —— 那几张是真金白银出的，不能不吭声。
       裁法与读数在这里算一次，页面卡上的红字由 `genRun` 统一把 notes 画出来。 */
    const dropped = Math.max(0, merged.length - FACE_CAP);
    item.faces = merged.slice(0, FACE_CAP);
    if (dropped) notes.push('候选最多留 ' + FACE_CAP + ' 张：这次换掉了最早的 ' + dropped + ' 张');
    if (!picOf(item) || (o && o.replace)) setPic(item, list[0].src);
    return { src: list[0].src, n: list.length, cap: previewCap(v.model), notes: notes, want: total, dropped: dropped };
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
    three: '角色三视图：同一人物的正面、侧面、背面全身排列，服装一致，纯白背景',
    expr: '角色表情表：同一张脸的六种情绪并排（平静、微笑、大笑、愤怒、悲伤、惊讶），'
      + '五官与发型完全一致，只有表情变化，纯白背景',
    costume: '角色服装图：这一位角色的全套服装正面平铺展示（完整上身与下身、鞋、随身小物），'
      + '与参考图里是同一个人、同一身形，纯白背景',
    prop: '角色手持道具图：这一位角色手里拿着的那件东西单独陈列（与参考图里是同一个人拿着它），'
      + '纯白背景，突出物件本身的形制与材质',
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
    const base = refPicOf(item);
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
    /* 用户在这一行填的名字**要进提示词**，不能只当标签：填「雨天造型」却按通用「角色服装图」
       去画，出来的东西跟他要的不是一回事（名字以前只写进了 `assetName`，图是按模板那句画的）。
       名字放在最前面当主语，模板那句照旧跟在后面。 */
    const typed = String((o && o.name) || '').trim();
    const prompt = await imagePrompt(REG, {
      what: (typed ? typed + '。' : '') + (table[tpl] || what)
        + (inputEntries ? '。严格沿用参考图里的同一个人与同一套服装，不要换脸、不要改发型' : ''),
      name: item.name, look: descOf(item), style: episodeStyle(drama), ar: '16:9',
    });
    const e = await AiGen.image({ prov: v.prov, model: v.model, prompt: prompt, ar: '16:9', count: want,
      snapTag: 'chars:' + (isSceneItem(item) ? 'scene' : 'char') + ':' + item.id, snapLabel: item.name + ' · ' + name,
      inputEntries: inputEntries,
      onTask: o && o.onTask,        // 同上：任务号回传给页面落盘，切页回来能认领
      log: { type: '素材-角色资产', meta: { 角色: item.name, 资产: name, 模板: tpl } } });
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

  /* ---------- 6.3 配音：按用户选的那个语音型号逐句合成 ----------
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
      /* inputRoles 声明在**型号**上 —— 本项目所有平台都是这么写的（sparkcine / vgenv 的
         reference_audio、mimo 的 voiceclone 都在 `models[i].inputRoles`），provider 那一层通常是空的。
         以前这里只读 `prov.inputRoles`，于是 mimo 的复刻型号明明声明了 reference_audio 槽
         （带 accept / maxBytes，参考音频就走 `voice` 字段发出去，模板里 `"voice":"{{voice}}"` 有位置），
         却被判成「请求体里没有位置放音频」—— 守卫把一个**能用**的能力挡掉了，
         界面上「拿这条去克隆」那颗按钮一颗都不出现，而哪里都没说明为什么。
         顺序：型号自己声明的优先，没有再看 provider 那一层（认错了就当没有，不猜）。 */
      const ir = (model && model.inputRoles) || (prov && prov.inputRoles) || {};
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
    /* 三层，后者盖前者：角色显式指定的那一位 > 这一集 opts 里的 > 设置项 `char_tts_mode`（默认 auto）。
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
  /* 「下拉里选中的那一个型号，这一句就照它的方式定音色」—— 工作台语音栏一直是这么做的
     （`studio.html` 的 `curTtsMode()` 直接读选中型号的 `modes`），而导演台声音栏以前按
     「这一家有没有预设音色」排优先级（preset > design > clone）：三家挂在不同型号上的时候，
     用户在下拉里选了「音色设计」那个型号，界面画的却还是预设音色下拉 —— 描述框整块不出现；
     选「音色复刻」时连「选参考音频」那张卡都没有（用户报的「模仿音色没有卡片、生成音色没有描述框」）。
     这一份把两件事一起判完：方式由**选中的型号**决定，并且这一家的请求体**放得下它**才算 ok。
     放不下时不能画一个输入框再让那句话被上游静默丢掉（那是 `ttsModeUsable` 存在的原因），
     要当场写明原因、让调用方把合成按钮压暗。 */
  function ttsWayOfChosen(REG, opts) {
    const v = pickProvModel(REG, 'audio', opts && opts.ttsModel, 'text_to_speech');
    if (!v) return { ok: false, chosen: null, target: null, model: null, prov: null, mode: 'none',
      why: '还没有可用的语音平台：到设置页「语音」那一档填一家并勾上' };
    const mode = ttsModeOf(v.model);
    if (!ttsModeUsable(v.prov, v.model, mode)) {
      return { ok: false, chosen: v, target: v, model: v.model, prov: v.prov, mode: 'none',
        why: (mode === 'design'
          ? '这个型号的声音描述在这一家的请求体里没有位置放（发出去会被上游静默丢掉）'
          : '这个型号在请求体里没有位置放参考音频') + ' —— 换一家声明了它的型号，或改用预设音色那一个' };
    }
    return { ok: true, chosen: v, target: v, model: v.model, prov: v.prov, mode: mode, why: '' };
  }
  /* 当前语音型号用哪种方式定音色（界面据此决定「选预设音色 / 写一段声音描述 / 上传参考音频」）。
     传 mode 就是问「这个方式落在哪一个型号上」。
     没有语音平台时回 'none'，由页面写明原因，不要摆一排假控件。 */
  function voiceMode(REG, opts, mode) {
    const v = ttsOf(REG, opts, mode);
    return v ? ttsModeOf(v.model) : 'none';
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
  /* 参考音频这一格**有两种存法，读法只有一份**（2026-10-17）：
     · 键   —— 从选择器或本机文件挂上来的那一段，字节在 IndexedDB，JSON 里只留一个短键（`saveRefAudio`）；
     · 地址 —— 「拿已经生成的那条语音去克隆」写进去的本机资产地址（`cloneFromCands`）。
     以前 `refAudioOf` 只认键：地址那一种在界面上显示得好好的（「参考音频：生成的那一条」），
     一配音却抛「要有参考音频」—— 挂上了却用不了；反过来把键当地址交给 `AssetTransfer.blobOf`，
     它认不出形状就当成相对路径去 fetch，取回来的是一个 404 页面。 */
  function refAudioForm(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    return /^(https?:|data:|blob:|\/)/i.test(s) ? 'url' : 'key';
  }
  /* 取字节：键 → IndexedDB；地址 → 公共层那一条取字节通道（本机资产 / 外链都认它）。
     取不到一律返回 null，**由调用方说清为什么**，这里不抛也不静默换成别的素材。 */
  async function refAudioBlob(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    if (refAudioForm(s) === 'key') return await Wb.Blobs.get(s);
    try { return await AssetTransfer.blobOf(s); } catch (e) { return null; }
  }
  /* 能播的那一份地址（试听问它，页面别自己判形状）：
     地址形态换成本机代理地址；键形态从 IndexedDB 现取字节封 blob: 地址，按那个键缓存一份。
     缓存的回收挂在 `saveRefAudio` / `clearRefAudio` 那两条换掉或撤掉参考音频的路上。 */
  const refAudioUrls = new Map();
  function dropRefUrl(v) {
    const u = refAudioUrls.get(String(v || '').trim());
    if (!u) return;
    refAudioUrls.delete(String(v || '').trim());
    try { URL.revokeObjectURL(u); } catch (e) { /* blob 忘了释放也会被浏览器回收，不影响功能 */ }
  }
  async function refAudioSrc(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (refAudioForm(s) === 'url') return Api.mediaSrc(s);
    const hit = refAudioUrls.get(s);
    if (hit) return hit;
    const b = await Wb.Blobs.get(s);
    if (!b) return '';
    const u = URL.createObjectURL(b);
    refAudioUrls.set(s, u);
    return u;
  }
  const refAudioCache = new Map();
  /* 把一段**音色描述**写回素材库那一位（导演台声音栏「存回素材库」那一颗）。
     为什么需要它：导演台声音栏的「声音描述」原本只活在这一次配音里 ——
     同一个角色下一集、下一条镜头又要再写一遍，而两遍写法迟早不一样。
     写回 `voiceNote` 之后，素材库那一位就有了这份描述，`voicePrefillOf` 那一族自然能取到它。
     判据只有一份：按**名字**找（`nameKey` 合并近名），找得到就写并存库。
     返回 { ok, name, why }：why 照实说（找不到那一位 / 库里读不出来 / 写失败）。 */
  function saveVoiceNote(name, note) {
    const nm = String(name || '').trim();
    const t = String(note || '').trim();
    if (!nm) return { ok: false, why: '这一句没有说话人：写回素材库要靠名字找人' };
    if (!t) return { ok: false, why: '没有音色描述可写' };
    const lb = libBroken();
    if (lb) return { ok: false, why: '没写回去：' + lb + '。已停手，磁盘上原来的数据一个字没动。' };
    const k = window.nameKey ? window.nameKey(nm) : nm.toLowerCase();
    const hit = Lib.list().find(x => x && window.nameKey
      ? window.nameKey(String(x.name || '').trim()) === k
      : String(x.name || '').trim().toLowerCase() === k);
    if (!hit) return { ok: false, why: '素材库里没有叫「' + nm + '」的那一位（先到素材库建一位，或改这一句的说话人）' };
    /* 已经有描述且与新写的不同 → 不覆盖（用户自己写的那段更该留着）。 */
    const old = String(hit.voiceNote || '').trim();
    if (old && old !== t) {
      return { ok: false, why: '「' + hit.name + '」已经有一段音色描述了，没有覆盖（要改就到素材库页改那一位）' };
    }
    const next = Object.assign({}, hit, { voiceNote: t, voiceMode: hit.voiceMode || 'design' });
    Lib.save(next, { exact: true });
    const e = Lib.writeError && Lib.writeError();
    if (e) return { ok: false, why: '没写回去：' + e };
    return { ok: true, name: hit.name };
  }
  async function saveRefAudio(char, blob, name) {
    const key = await Wb.Blobs.save(blob);
    if (char.refAudio && char.refAudio !== key) {
      try { await Wb.Blobs.del(char.refAudio); } catch { /* 旧的本机参考音频删不掉只多留一份字节，不拦这次替换 */ }
      refAudioCache.delete(char.refAudio); dropRefUrl(char.refAudio);
    }
    char.refAudio = key;
    char.refAudioName = name || char.refAudioName || '参考音频';
    refAudioCache.set(key, { base64: await blobToBase64(blob), mime: blob.type || 'audio/mpeg' });
    return key;
  }
  /* 去掉参考音频：本机那块字节也要删掉，不然这一集不用了它还占着 IndexedDB */
  async function clearRefAudio(char) {
    if (!char || !char.refAudio) return;
    try { await Wb.Blobs.del(char.refAudio); } catch { /* 旧的本机参考音频删不掉只多留一份字节，不拦这次替换 */ }
    refAudioCache.delete(char.refAudio); dropRefUrl(char.refAudio);
    char.refAudio = ''; char.refAudioName = '';
  }
  /* base64 那份缓存的键**就是 `char.refAudio` 那个原值**（键与地址同表）：
     地址形态取一次字节要走代理回源，同一位反复试听不该每次重来一遍。 */
  async function refAudioOf(char) {
    const raw = String((char && char.refAudio) || '').trim();
    if (!raw) return null;
    const hit = refAudioCache.get(raw);
    if (hit) return hit;
    const b = await refAudioBlob(raw);
    if (!b) return null;
    const val = { base64: await blobToBase64(b), mime: b.type || 'audio/mpeg' };
    refAudioCache.set(raw, val);
    return val;
  }
  /* 「那一段字节取不到」全站只这一句：素材库页试听、统一选择器试听与交出条目、导演台与工作台的
     落地回执都读它。三处各拼一遍迟早有一处在骗人（而这一句的出路只有一条：回素材库页重挂）。 */
  function refAudioMiss() {
    return '这一段字节在本机取不到：到素材库页给那位重新挂一段参考音频';
  }
  /* 素材库能给「定声音」当料的那几位，一次列全 —— 统一选择器（`AssetPicker`）第四个来源读它。
     字段名不出这一层：选择器与页面拿到的只有 name / text / getSrc / getBlob，
     它们不知道也不该知道库里那一列叫 `refAudio` 还是 `voiceNote`。
       · way='note'  → 写过音色描述的（音色设计取料处）
       · way='audio' → 身上挂了参考音频的（音色复刻取料处）
     字节**到试听/确定那一刻才现取**（一段人声几 MB，开弹窗时不该为每一条读一遍 IndexedDB）；
     取不到由选择器当场说清，这里不预先筛掉 ——「读不出来」不等于「本来就没有」。 */
  /* 「按说话人名字去素材库取这一句现成的音色料」整链只这一份：找同名素材、读音色描述（设计档）
     或取参考音频字节（复刻档），字段名不出这一层。返回 `{found, name, refName, note, blob, why}`：
     `why` 非空就是页面上该说的那句话；`note` / `blob` 才是填进那一格的东西。
     ⚠ 它**不是** `libVoiceEntries` 的第二份：那份是「选择器里列哪几位」，这份是「这一句找谁」。 */
  async function voicePrefillOf(name, mode) {
    const nm = String(name || '').trim();
    const m = String(mode || '');
    if (!nm) return { found: false, name: '', refName: '', note: '', blob: null,
      why: '台词里没写说话人：音色请在下拉里手挑（AI 拆分时写进 speaker 的那一句会自动找素材库）' };
    const kOf = window.nameKey || (x => String(x || '').trim().toLowerCase());
    const key = kOf(nm);
    const ch = key ? Lib.list().find(x => x && kOf(x.name) === key) : null;
    if (!ch) return { found: false, name: nm, refName: '', note: '', blob: null,
      why: '说话人「' + nm + '」在素材库里没有同名素材：音色仍要手挑，或到素材库补一位同名的' };
    const who = String(ch.name || nm);
    if (m === 'design') {
      const note = String(ch.voiceNote || '').trim();
      if (!note) return { found: true, name: who, refName: '', note: '', blob: null,
        why: '素材库「' + who + '」还没写音色描述：这一格仍是空的，补一段或换一位' };
      return { found: true, name: who, refName: '', note, blob: null, why: '' };
    }
    if (m === 'clone') {
      const raw = String(ch.refAudio || '').trim();
      if (!raw) return { found: true, name: who, refName: '', note: '', blob: null,
        why: '素材库「' + who + '」没挂参考音频：复刻仍缺料，到素材库给她挂一段' };
      const label = String(ch.refAudioName || '参考音频').trim() || '参考音频';
      let blob = null;
      try { blob = await refAudioBlob(raw); } catch (e) { blob = null; }
      if (!blob) return { found: true, name: who, refName: '', note: '', blob: null, why: refAudioMiss() };
      return { found: true, name: who, refName: who + ' · ' + label, note: '', blob, why: '' };
    }
    return { found: true, name: who, refName: '', note: '', blob: null, why: '' };
  }

  function libVoiceEntries(way) {
    const out = [];
    for (const c of Lib.list()) {
      if (!c) continue;
      const nm = String(c.name || '新角色').trim() || '新角色';
      const ts = Number(c.savedAt || 0) || 0;
      if (way === 'note') {
        const t = String(c.voiceNote || '').trim();
        if (!t) continue;
        out.push({ kind: 'asset', charId: c.id, provider: 'char', providerName: '素材库',
          name: nm, prompt: nm + ' · ' + t, text: t, type: '音色描述', noMedia: true,
          format: '', duration: null, src: '', dl: '', ts,
          _grp: 'char', _ckey: 'n:' + c.id });
        continue;
      }
      if (way !== 'audio') continue;
      const raw = String(c.refAudio || '').trim();
      if (!raw) continue;
      const label = String(c.refAudioName || '参考音频').trim() || '参考音频';
      out.push({ kind: 'asset', charId: c.id, provider: 'char', providerName: '素材库',
        name: nm + ' · ' + label, prompt: nm + ' · ' + label, type: '音频',
        format: '', duration: null, src: '', dl: '', ts,
        _grp: 'char', _ckey: 'a:' + c.id,
        getSrc: () => refAudioSrc(raw), getBlob: () => refAudioBlob(raw) });
    }
    return out;
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
    /* `only`：**只给这几位定声音**（素材库页新建一位时只想定这一位，
       不必为了它临时凑一整集角色出来 —— 那样一次要花的钱是它的好几倍）。
       判据还是「名字非空 + 在 o.only 里」，与上面那道同一份，不另立一套。 */
    const pick = o.only && o.only.length ? chars.filter(c => o.only.indexOf(c.name) >= 0) : chars;
    if (!chars.length) return { changed: [], skipped: [], why: '这一集还没有角色 —— 先拆完剧本或自己加两位' };
    if (!pick.length) return { changed: [], skipped: [], why: '挑中的那几位在库里找不到（可能已经删掉了）' };
    const can = [];
    /* 顺序即优先级（2026-10 用户要求：「自动调用生成音色的模型，而不是让我选择音色」）。
       以前三行平铺，文字 AI 经常挑 preset —— 从一份固定清单里选一个 id，于是每个角色的嗓子
       都来自那十来把预置嗓子，界面上还摆一排「声音 1/2/3」让人选。
       现在把生成音色排在最前并写明「首选」，preset 明确降级为「这家没有生成音色型号时再用」。 */
    if (ways.design) can.push('design（**首选**）：写一段音色描述，这个型号照描述现造一把嗓子');
    if (ways.clone) can.push('clone：只给**已经有本人参考音频**的角色用');
    if (ways.preset.length) can.push('preset（**这家没有生成音色型号时**才用）：从下面那份预设清单里挑一个 id');
    const cast = pick.map(c => '- ' + c.name + '（' + (c.kind === 'narrator' ? '只出声的旁白' : '出镜角色') + '）：'
      + (c.bio || '') + (c.look ? '；外貌：' + c.look : '')
      + (c.refAudio ? '；已经有本人的参考音频' : '')
      + (String(c.voiceNote || '').trim() ? '；已有的声音描述：' + String(c.voiceNote).trim() : '')).join('\n');
    const sys = fillTpl(TextAI.prompt('char_voice'), {
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
    for (const c of pick) {
      const r = rows.find(x => x && String(x.name || '').trim() === c.name) || {};
      const got = applyVoiceRow(REG, drama, c, r, ways);
      if (!got.ok) { skipped.push({ name: c.name, why: got.why }); continue; }
      changed.push({ name: c.name, mode: got.mode, fellback: got.fellback, label: got.label, why: got.why });
    }
    /* ⚠ 2026-10：拍短剧页删除前，这里最后一句是 `if (changed.length) put(drama);` ——
       把改完的音色写回那一集。素材库页传进来的是**现搭的壳**（fakeDrama），没有可落盘的宿主，
       真正的落盘在页面拿到返回的 changed 之后自己 `Lib.save` —— 所以这一句连同 put 一起去掉了。 */
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
    const sys = fillTpl(TextAI.prompt('char_voice'), {
      ways: can.join('\n') || '（这个平台没有可用的定音色方式）',
      preset: ways.preset.length ? ways.preset.map(v => '- ' + v.id + '｜' + [v.name, v.lang, v.gender].filter(Boolean).join(' ')).join('\n') : '（没有预设音色清单）',
      cast: '- ' + c.name + '（' + (c.kind === 'narrator' ? '只出声的旁白' : '出镜角色') + '）：' + who,
    });
    stage('正在按人设定「' + c.name + '」的声音…');
    let txt = '';
    /* 与 `assignVoices` 同一份写法：调用方给了 `onDelta` 就边收边显（那里是页面上的流式面板），
       没给就还是普通一次性调用 —— 判据不在这里拍，看调用方要不要过程。 */
    try {
      txt = o.onDelta
        ? await TextAI.chatStream(REG, sys, '请只给上面这一个人定声音，只输出 JSON。', o, o.onDelta)
        : await TextAI.chat(REG, sys, '请只给上面这一个人定声音，只输出 JSON。', o);
    }
    catch (e) { return { ok: false, why: '定音色没成：' + errText(e) }; }
    const j = TextAI.parseJson(txt);
    const rows = (j && (j.roles || j.characters)) || [];
    const row = Array.isArray(rows) && rows.length ? (rows.find(x => x && String(x.name || '').trim() === c.name) || rows[0]) : {};
    const got = applyVoiceRow(REG, drama, c, row, ways);
    if (!got.ok) return { ok: false, why: got.why };
    let vc = null;
    if (o.cands) {
      stage('正在给「' + c.name + '」合成 ' + candN() + ' 条试听…');
      try { vc = await voiceCands(REG, drama.opts, c, { onStep: o.onCands }); }
      catch (e) { vc = { made: 0, failed: 0, err: errText(e)}; }
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
    /* 输出格式也按声明取（优先 wav，方便抽时长与试听）；pcm16 裸流在本地封成 WAV。
       判据统一问 `TtsAdv.formats`（型号 options.formats 优先、平台 tts.formats 回退）：
       这里以前只读型号那一层，平台只在 tts.formats 里声明格式时整份清单是空的，
       于是永远按 wav 发 —— 而那一家的 wav 可能根本没人认（B27）。 */
    const fmts = window.TtsAdv ? window.TtsAdv.formats(prov, model)
      : ((model.options || {}).formats || tts.formats || []);
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
      textRole: tts.textRole || 'assistant', styleRole: tts.styleRole || 'user', log: false,
      snapTag: o.snapTag || ('chars:voice:' + ((o.char && o.char.id) || '')), snapLabel: (o.char && o.char.name) || '' };
    let res;
    try {
      res = await Api.create(prov, body);
    } catch (e) {
      const m = errText(e);
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
  /* Blob 的 type 得按真实格式给 —— 和下面正式配音那两条走的是同一张 AUDIO_MIME 表。
     这一条以前写死 audio/wav：模型出 mp3 / m4a 时，试听拿到的 Blob 头上贴着一个假类型。 */
  const b64ToAudioBlobUrl = (b64, fmt) => {
    const buf = window.b64Bytes(b64);
    return URL.createObjectURL(new Blob([buf], { type: AUDIO_MIME[fmt] || 'audio/wav' }));
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
    return b64ToAudioBlobUrl(r.b64, r.format);
  }
  /* 音频时长：没有现成探测，用 <audio> 读 metadata（10 秒兜底） */
  function audioDuration(url) {
    return new Promise(res => {
      const a = new Audio();
      let done = false;
      const fin = v => { if (done) return; done = true; try { a.removeAttribute('src'); a.load(); } catch { /* 临时 audio 收尾：释放失败也不影响已经算出来的时长 */ } res(Number(v) || 0); };
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
    if (w.mode !== 'preset') {
      /* **描述/复刻这两种方式，请求本体就是这一位身上的东西**：
         按描述出声时那段描述是 `ttsOnce` 的 style 字段，复刻时要挂上参考音频。
         缺了还照发，平台只会回一句 Param Incorrect —— 用户看到的是「参数不对」，
         而他能改的那件事（写一句描述 / 点「AI 定音色」/ 挂一段参考音频）一个字都没提。
         2026-10 实测：关掉自动补画（于是没跑自动定音色）的新角色，点「一次出 3 条试听」
         就是这个下场：3 次请求、3 条失败、界面上只挂一句平台原话。
         判据用 `voiceReady`（与第 2/3 步那份前置条件清单**同一份**，不另写条件）。
         n=0 → `voiceCandsHTML` 不摆那颗按钮，并把 why 当原因写出来。 */
      const r = voiceReady(REG, opts, char);
      if (!r.ok) {
        return { n: 0, pickable: false, mode: w.mode, list: [],
          why: (r.why || '这一位还没定声音') + ' —— 先在上面写一句声音描述，或点「AI 定音色」让文字 AI 按人设写，再出试听' };
      }
      return { n: candN(), pickable: false, mode: w.mode, list: [], why: '' };
    }
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
      /* 描述 / 复刻这两种方式**没有音色名**（`voiceName` 对它们回空），于是一次出的那几条
         在界面上全都显示成同一个「声音描述」—— 一排一模一样的格子。
         而「拿这条去克隆」点下去是「以后都按这一条的声音念」，用户根本分不清点的是哪一条。
         所以按序号给个能分辨的名字（预设音色有真名，不动它）。 */
      if (!v && !rec.name) rec.name = wayLabel(cap.mode) + ' 第 ' + (i + 1) + ' 条';
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
      } catch (e) { rec.err = errText(e); }
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
     为什么放在数据层：调用方各写一份的话迟早对不上（素材库页切了方式、别处还按描述生成）。
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
        return { ok: false, why: '这一段 ' + window.fmtBytes(bytes) + '，超过这一家参考音频的上限 '
          + window.fmtBytes(rule.maxBytes) };
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
  /* 拿**素材库里另一位**的参考音频来克隆（用户要求：「使用素材进行描述或克隆」——
     即用另一个素材的声音当这一位的嗓子）。
     与 `cloneFromCands` 的差别只在于**源**：那一条取的是「这一位自己合成过的候选」，
     这一条取的是「库里另一位挂着的参考音频」。
     走的是同一条落点（`char.refAudio` + `voiceMode='clone'` + 清掉预设音色 id），
     所以之后的配音、下一集、保存都按同一份口径 —— 不另写一条克隆路径。
     体积判据仍走 `refAudioRule`（与界面上传参考音频同一把尺子）。 */
  function cloneFromLibEntry(REG, opts, char, entry) {
    const w = ttsWays(REG, opts);
    if (!w.ok) return { ok: false, why: w.why };
    if (!w.clone) return { ok: false, why: '这个平台没有「音色复刻」型号 —— 拿别人的参考音频来克隆要它有那一档' };
    const src = String((entry && entry.refAudio) || '').trim();
    if (!src) return { ok: false, why: '素材库里的「' + String((entry && entry.name) || '那一位') + '」没有挂参考音频 —— 先给它传一段或用它合成一条' };
    if (char && entry && char.id && entry.id && char.id === entry.id) {
      return { ok: false, why: '这一位就是它自己' };
    }
    const rule = (refAudioRule(REG, opts) || {}).rule || {};
    const bytes = Number((entry && entry.refAudioBytes) || 0);
    if (rule.maxBytes && bytes && bytes > rule.maxBytes) {
      return { ok: false, why: '那一位的参考音频 ' + window.fmtBytes(bytes) + '，超过这一家参考音频的上限 '
        + window.fmtBytes(rule.maxBytes) };
    }
    char.refAudio = src;
    char.refAudioName = String((entry && entry.name) || '参考音频').slice(0, 40) + ' 的声音';
    char.voiceMode = 'clone';
    char.voice = '';
    char.voiceName = '';
    char.voiceBy = '';
    return { ok: true, refAudio: char.refAudio, name: char.refAudioName };
  }
  /* 简易并发池：给一批任务 + 一个上限，池子按上限开工，谁先完谁腾位。
     以前长在拍短剧页里（补画角色 / 场景两条池子共用），素材库页「一次出齐这一档」要的是
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

  /* ============================================================================
     角色卡片上「声音 / 资产」那几块（Cast）—— 素材库页与导演台的参考图选择共用一份
     ----------------------------------------------------------------------------
     以前只长在拍短剧页里：声音那一块要按**当前语音型号怎么定音色**渲染
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
    /* id 必须稳定：以前拼了 newAssetId()，每次读都是新 id，setAssetName / removeAsset /
       setAssetProps 按 id 定位全部失效（点改名改的是下一次读才出现的另一张）。
       用字典键本身（对象键唯一且落盘前后不变）；落盘一次后就是列表里的同一枚 id。 */
    return Object.keys(a).filter(k => a[k]).map(k => normAsset({ id: k, kind: k, src: a[k] }));
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
     以前这一段只长在拍短剧页里，素材库页要画同一个下拉就只能再抄一份。 */
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
    /* 「用素材库里的另一位」这两条（用户要求：「使用素材进行描述或克隆」）：
       · description 档 —— 拿别人写好的**音色描述**填进这一格（不另造一段）；
       · clone 档 —— 拿别人挂着的**参考音频**当这一位的嗓子。
       候选名单只有 `libVoiceEntries` 那一份（页面与选择器都读它），这里不另列。
       库里没有可拿的就不摆那颗按钮（摆一颗点了没反应的更糟）。 */
    const libNotes = vm === 'design' ? libVoiceEntries('note') : [];
    const libAudios = vm === 'clone' ? libVoiceEntries('audio') : [];
    const takeNote = libNotes.length
      ? `<button class="ghost mini" data-act="vnotepick" title="从素材库里挑一位，把他写的那段音色描述填进这一格">${ic('users', 12)} 用素材的音色描述</button>` : '';
    const takeAudio = libAudios.length
      ? `<button class="ghost mini" data-act="vaudiopick" title="从素材库里挑一位，用他挂着的参考音频克隆这一位的声音">${ic('users', 12)} 用素材的声音克隆</button>` : '';
    if (vm === 'design') return fb + '<input class="ui-in" data-act="voicenote" placeholder="描述这个人的声音：男/女、年纪、清亮还是沙哑、语速快慢、情绪底子" '
      + 'value="' + esc(c.voiceNote || '') + '">'
      + `<span class="ui-hint">「${mn}」按这段描述出声，写完就能试听${(c.voiceBy === 'ai' && String(c.voiceNote || '').trim()) ? '（这段是 AI 按人设写的，可以直接改）' : ''}`
      /* 说清它会跟着这一位走（用户要求「同一个角色下次用之前的音色提示词」）：
         描述随角色进素材库、拉进下一集时一起带过去，所以同一个人不用每集重写一遍。 */
      + '。这段描述随这一位进素材库，拉进下一集也带过去</span>'
      + takeNote;
    if (vm === 'clone') return fb + (c.refAudio
        ? `<span class="ui-tag ok">参考音频：${esc(String(c.refAudioName || '已挂的那一段').slice(0, 18))}</span>`
        : '<span class="ui-hint">还没有参考音频 —— 这个型号靠参考音频克隆音色（3~10 秒干净的人声即可）</span>')
      + `<button class="ghost mini" data-act="refaudio">${c.refAudio ? '换一段' : ic('upload', 12) + ' 上传参考音频'}</button>`
      + (c.refAudio ? '<button class="ui-linkbtn" data-act="refclear">去掉</button>' : '')
      + takeAudio;
    return fb + '<span class="ui-voice-list">' + voiceChips(REG, opts, c) + '</span>';
  }
  const WAY_LABEL = { preset: '预设音色', design: '声音描述', clone: '参考音频复刻' };
  const wayLabel = m => WAY_LABEL[m] || m || '';
  /* 占位那一格：转圈 + 一句「这一项正在生成，好了会自动出现」。
     要换行就写 \n，逐段转义后再拼 <br> —— 占位文字里会混进角色名，整句当 HTML 直拼就是一条 XSS。
     `cls` 只换外形：默认是行内那一颗小胶囊（候选排里用），传 'fill' 就是铺满一个格子
     （那些深色缩略槽）。标记与转义只有这一份，页面各自再写一份就会漏转义。 */
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
  /* 从候选排里删掉一张 —— **只有这一份**（素材库页的角色 / 场景 / 道具卡共用）。
     为什么要有：攒了一排不满意的候选，原来只能「用这一张」或整个重出，
     挑剩下来的永远留在那儿 —— 而「出4 张里3 张不要」是最常见的结局。
     `pick` 是「这一类的候选放在哪个字段」：`faces`（角色/场景/道具的预览图）
     或机位构图那种别的字段；`got/set` 是读写那个「正在用的」字段（`face` / `img`）。
     删掉正在用的那一张时**顺位递补**成第一张，而不是把这一类清空 ——
     清空的话用户会发现「我删了一张预览图，整张卡的脸也没了」。 */
  function dropFaceCand(item, src, io2) {
    const a2 = io2 || {};
    const before = (item.faces || []).slice();
    const next = before.filter(x => x && x.src !== src);
    if (next.length === before.length) return { ok: false, why: '这一张已经不在了' };
    item.faces = next;
    if (a2.got && a2.got(item) === src) {
      /* 正在用的那张被删了：顺位递补（原来那张位置上的下一张；没有了就空）。 */
      const idx = before.findIndex(x => x && x.src === src);
      const fill = next[idx] || next[0] || null;
      if (a2.set) a2.set(item, fill ? fill.src : '');
    }
    return { ok: true, left: next.length };
  }

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
          + (o.extra || '') + (on ? ' disabled' : '') + '>' + (on ? '在用' : '用这一张') + '</button>'
          /* 删掉这一张候选（`o.del` 由调用方给动作名）：攒了一排不满意的，得能一张张清掉 ——
             以前只能「用这一张」或整个重出，挑剩下的永远留在那儿。 */
          + (o.del ? '<button class="ui-linkbtn danger" ' + A + '="' + esc(o.del) + '" data-src="' + esc(x.src) + '"'
            + (o.extra || '') + '>删掉</button>' : '')
          + '</span>';
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
    /* **有理由要说的时候不许整块藏起来**。
       以前这一行是 `cap.mode === 'none' || (!list.length && !failed.length && !(cap.n > 1))`，
       于是「这一位还没写声音描述」这类新的守卫（cap.n=0 + cap.why 有话）会让整块直接返回空串 ——
       按钮没了、原因也跟着没了，界面上一点痕迹都不留：那正是「按了没反应」的另一种样子。
       现在只要 `cap.why` 有话就把这一块画出来（按钮仍然不摆，理由写在下面）。
       顺带把「还没配语音接口」也纳进来：以前它在候选区一个字都不说。 */
    if (!list.length && !failed.length && !(cap.n > 1) && !cap.why) return '';
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
          + ' title="把这条音频挂成这一位的参考音频、方式切到复刻 —— 以后都按这个声音念">' + (cloned ? '正在用它' : '拿这条去克隆') + '</button>' : '')
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
  /* 试听这一整段流程素材库页要用，包括那三个容易写漏的点：
     ① 先按型号判「缺什么」，② 会真的花钱所以先 Confirm 一句，③ opts 一定传下去 ——
     不传就退回「注册表里第一个语音型号」，于是试听的是 A、拍出来是 B。
     返回值而不是抛错：{ why } 缺条件、{ cancelled } 用户自己关掉、{ label } 真放出来了。 */
  let previewAud = null;
  /* 当前试听那个 blob 地址（D9）。`b64ToAudioBlobUrl` 是全项目**唯一**一处 createObjectURL，
     而以前零处 revoke —— 每点一次试听就漏一个 URL（旧 previewAud 置空后可被 GC，
     但 blob URL 本身要显式 revoke 才回收，是「依赖 GC 的软泄漏」）。换一条时把上一条收掉。
     注意顺序：先 revoke **旧**的，再 new Audio(新 url) —— 反了会让刚拿到的地址变死链。 */
  let previewAudUrl = '';
  function dropPreviewUrl() {
    if (!previewAudUrl) return;
    try { URL.revokeObjectURL(previewAudUrl); } catch (e) { /* blob 忘了释放也会被浏览器回收，不影响试听 */ }
    previewAudUrl = '';
  }
  async function preview(REG, opts, c, o) {
    const stage = (o && o.onStage) || function () {};
    if (previewAud) { try { previewAud.pause(); } catch (e) { /* 本来就停着就没有需要停的 */ } }
    previewAud = null;
    dropPreviewUrl();
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
      previewAudUrl = url;
      previewAud = new Audio(url);
      previewAud.play().catch(() => { if (window.Toast) Toast.err('浏览器拦了自动播放，点一下再放'); });
      const vm = voiceWay(c, REG, opts).mode;
      return { label: vm === 'clone' ? '参考音频复刻' : vm === 'design' ? ((c.voiceNote || '按描述出声').slice(0, 20)) : voiceName(REG, opts, c.voice, vm), mode: vm };
    } finally { stage(''); }
  }
  /* 播**本机已经存着**的那一段（候选试听、也播身上挂着的那条参考音频）：不再合成、不再花一次，所以不问那一句。
     和 preview 共用同一个 previewAud —— 两条候选各放各的就会叠成一团噪音。
     地址从 `refAudioSrc` 现算（键与地址两种存法都认，见上面那一段）：以前这里直接 `Api.mediaSrc(src)`，
     于是 IndexedDB 那个短键被当相对路径去 fetch，素材库页点「试听她自己的那段」只回一句失败。 */
  async function playAsset(src) {
    if (!src) return { why: '这一段不在了，重新出一次候选' };
    if (previewAud) { try { previewAud.pause(); } catch (e) { /* 本来就停着就没有需要停的 */ } previewAud = null; }
    dropPreviewUrl();                                  // 换成资产地址了，上一条试听的 blob 地址收掉
    const u = await refAudioSrc(src);
    if (!u) return { why: refAudioMiss() };
    const a = new Audio(u);
    previewAud = a;
    try { await a.play(); } catch (e) { return { why: '浏览器没让自动播放：' + errText(e) }; }
    return { ok: true };
  }

  /* 下载的文件名不在这里洗：判据全站只有 `ui.js` 的 `fileSafe` 一份（§J ⑲ 守着）。
     这一族以前有三份换法（这里换下划线、页面那两处换连字符、assetlib 那份直接删字符），
     而「第 1 段第 2 次」这类名字全靠长度与分隔对得上，换法不一致下载目录里就认不出是哪一集。 */
  return {
    /* ---- 设置项：设置页照 SET 这张表渲染控件，页面读 setting / aiVoiceOn / candCount ---- */
    SET, setting, aiVoiceOn, candN, candCount, previewCap,
    /* 一份素材身上最多留几张候选图：页面在「认领切页前没等完的出图」时要把新图并进 faces，
       上限必须与 drawPreview 用的**同一个数**，所以把它导出去（页面别自己写一个 8）。 */
    FACE_CAP,
    uid, esc,
    /* ---- 素材库的「类型 / 预览图 / 描述」三件套：字段名只在这几个函数里换（库 face/look ↔ 剧侧 img/desc），
       页面自己判 kind === 'scene' 就会和数据层走岔。 ---- */
    LIB_KINDS, libKindOf, voiceOnlyOf, isPropItem, isSceneItem, picOf, refPicOf, setPic, descOf,
    newChar, newScene, newProp,
    Lib,
    /* ---- 出图与配音两条流水线。拆剧本 / 拍摄 / 成片那一族 2026-10 随拍短剧页一并删除 ---- */
    Pipe: { drawPreview, drawCharAsset, modelSelectHTML, pickProvModel, runPool,
      /* 语音那三档（哪家在用 / 有哪些可选音色 / 这一家能怎么定声音）的判据在这里，不在页面里：
         导演台剪辑的声音轨要画同一套下拉，若它自己读 `model.options.voices`，
         「型号声明 → 平台级兜底」那个顺序就会有两份、漂开只是时间问题。 */
      provModels, voices, ttsWays, ttsOf,
      /* 「选中型号 → 这一句按哪种方式定音色」的判据（含「请求体放得不下」那句原因），
         导出去给导演台声音栏用 —— 页面自己按平台排优先级就会和工作台两套说法。 */
      ttsWayOfChosen,
      voiceMode, setVoiceWay, assignVoices, autoVoice, cloneFromCands, voiceCands,
      /* 「拿素材库里另一位的参考音频来克隆」：与 cloneFromCands 同一落点，只是源换了。 */
      cloneFromLibEntry,
      /* 「素材库里有哪几位能拿来定声音」那份名单（统一选择器第四个来源读它）：
         库里那一列叫什么只有这一层知道，页面与选择器都不认字段名。 */
      libVoiceEntries, refAudioMiss, voicePrefillOf,
      /* 把一段音色描述写回素材库那一位（导演台声音栏「存回素材库」）。 */
      saveVoiceNote,
      saveRefAudio, clearRefAudio },
    /* ---- 角色卡上「声音 / 资产」那几块。素材库页与导演台共用一份，
       这一层**只产字符串**：点击动作仍由页面自己绑（data-act 的名字两边一致），
       因为「画完之后要不要写进哪一处」是页面自己的事。 ---- */
    Cast: { ASSET_KINDS, SCENE_ASSET_KINDS, assetLabel, assetTplsOf, assetName,
      /* 角色资产的读写**只有这一套**（`assets` 是扁平列表：任意种类、不限张数、
         每张一个名字 + 一组关联道具）。页面不要再写 `c.assets[kind]` —— 那是旧字典形状的读法，
         在列表形状下恒为 undefined，表现是「界面永远显示没有资产」。 */
      assetsOf, assetsSave, assetsOfTpl, assetById, addAsset, removeAsset, setAssetName, dropFaceCand,
      setAssetProps, mergeAssetLists,
      isVoiced, timeOptsHTML, WAVE, assetNames, voiceName, voiceChips, voiceBoxHTML, voiceRowHTML, voiceTag, refAudioRule, voiceReady, preview, playAsset, wayLabel, voiceWaySeg,
      /* 候选那一排的公共标记（样式在 ui.css 的 .ui-cands / .ui-wait）：
         页面只提供「绑哪个动作」和「这一格正在出第几张」，不要再各写一套占位与格子。 */
      waitHTML, picCandsHTML, voiceCandsHTML },
    /* 库里那一条 → 剧侧角色对象。**唯一一份**：素材库页「新建时就让 AI 定音色」走它 ——
       `assignVoices` 要的是「一集的角色」，而那一集是现搭的壳，
       壳里那一位必须是这条素材按同一套映射转出来的对象，否则两边字段对不上
       （voiceMode / refAudio 这些只在转的时候拷）。页面不要自己拼那一个壳里的字段。 */
    toEpisodeChar,
  };
})();
