/* 演示数据 —— 全部取自真品，不是编的：
     · 场景 / contract / 变量说明来自 web/domain/text-ai.js
       （SKILL_CONTRACT、SKILL_VARS、PROMPTS 里的 label 与 used）
     · Skill 条目来自 skills/<id>/SKILL.md 的 frontmatter
       （id / name / description / triggers / pages / contract / version）
     · 「我的 Skill」两条是为了演示几种信息状态而造的样例（真机上没有），
       状态规则照 server/skills-store.js：同一 contract 只能有一份启用。 */
(function () {
  'use strict';

  var GROUPS = [
    { id: 'assistant', name: 'AI 助手', note: '按需触发，不占固定位' },
    { id: 'studio', name: '生成工作台', note: '视频 · 图像 · 语音' },
    { id: 'director', name: '导演台', note: '拆分镜 · 分镜 · 成片' },
    { id: 'chars', name: '素材库', note: '角色 · 场景 · 音色' },
  ];

  /* 一个场景 = 一个 contract = 一类活儿的写法。
     vars = 这一步会拿到哪些项目上下文（程序在发请求前填进去）。 */
  var SCENES = [
    {
      group: 'studio', key: 'video', contract: 'polish.video', label: '视频提示词润色',
      used: '生成工作台「视频」那一栏的「AI 润色」 · 导演台右栏「AI 润色提示词」',
      vars: [],
    },
    {
      group: 'studio', key: 'img', contract: 'polish.image', label: '图片提示词润色',
      used: '图片工作台「AI 润色」',
      vars: [],
    },
    {
      group: 'studio', key: 'audio', contract: 'polish.voice', label: '配音稿润色',
      used: '生成工作台「语音」那一栏的「AI 润色」',
      vars: [],
    },
    {
      group: 'studio', key: 'img_split', contract: 'img_split.json', label: '图片片段拆分',
      used: '生成工作台「图像」栏「拆分片段生成」',
      vars: [],
    },
    {
      group: 'studio', key: 'follow', contract: 'polish.follow', label: '再改一版',
      used: '三个工作台与导演台：润色结果面板下面那一行「还要怎么改」',
      vars: [
        { name: 'what', from: '用户这一轮的修改要求', desc: '跟着改的具体指令' },
      ],
    },
    {
      group: 'director', key: 'story', contract: 'story.json', label: '分镜切片规划',
      used: '导演台右栏「按描述生成这一镜的画面」',
      vars: [],
    },
    {
      group: 'director', key: 'split', contract: 'split.json', label: '剧本拆分镜',
      used: '导演台「拆分镜」→ 任务「拆一份新的 / 接着往下拆」',
      vars: [
        { name: 'what', from: '用户的创作意图', desc: '要做什么类型的短片' },
        { name: 'cast', from: '素材库的角色清单', desc: '可选演员名单' },
        { name: 'assets', from: '素材库的场景/道具清单', desc: '可用素材' },
        { name: 'board', from: '现有分镜摘要', desc: '已有分镜（续写时）' },
        { name: 'dur', from: '目标总时长', desc: '期望的成片时长' },
      ],
    },
    {
      group: 'director', key: 'board_edit', contract: 'board_edit.json', label: '修改现有分镜',
      used: '导演台「拆分镜」→ 任务选「修改现有分镜」',
      vars: [
        { name: 'what', from: '用户的修改要求', desc: '要改什么' },
        { name: 'cast', from: '素材库的角色清单', desc: '可选演员名单' },
        { name: 'assets', from: '素材库的场景/道具清单', desc: '可用素材' },
        { name: 'board', from: '现有分镜', desc: '当前分镜内容' },
        { name: 'dur', from: '目标总时长', desc: '期望的成片时长' },
      ],
    },
    {
      group: 'director', key: 'board_assets', contract: 'board_assets.json', label: '拆分镜素材判定',
      used: '导演台「拆分镜」→ 判断哪些新角色/场景/物品要建档并出图',
      vars: [
        { name: 'cast', from: '素材库的角色清单', desc: '现有角色' },
        { name: 'assets', from: '素材库的场景/道具清单', desc: '现有素材' },
        { name: 'board', from: '当前分镜', desc: '分镜内容' },
      ],
    },
    {
      group: 'chars', key: 'char_image', contract: 'char.image.json', label: '角色图提示词',
      used: '素材库页画预览图、角色资产（三视图 / 表情 / 服装 / 道具）',
      vars: [
        { name: 'what', from: '用户的描述', desc: '要画什么' },
        { name: 'name', from: '角色/场景名', desc: '素材名称' },
        { name: 'look', from: '外观描述', desc: '外形特征' },
        { name: 'style', from: '画风偏好', desc: '美术风格' },
        { name: 'ar', from: '画幅比', desc: '图片宽高比' },
      ],
    },
    {
      group: 'chars', key: 'char_voice', contract: 'char.voice.json', label: '给每位角色定音色',
      used: '素材库页「✧ 让 AI 给角色定声音」与「画完就给他定声音」',
      vars: [
        { name: 'ways', from: '音色候选列表', desc: '可选音色' },
        { name: 'preset', from: '音色预设', desc: '用户选的音色档' },
        { name: 'cast', from: '角色清单', desc: '现有角色' },
      ],
    },
  ];

  /* 助手不是一个 contract —— 它按触发词自己挑，所以单列一行，语义与上面 11 个不同。 */
  var ASSISTANT = {
    group: 'assistant', key: 'assistant', contract: '', label: 'AI 助手',
    used: '助手在回合里自己判断加载：预载最多 2 份进系统提示词 + 按需最多 2 份走工具结果；用户在问题里点名的优先钉住。',
    vars: [],
  };

  var SKILLS = [
    { id: 'video-prompt', name: '视频提示词', desc: '把镜头描述改写成视频模型能直接用的提示词', triggers: ['视频', '提示词', '润色', '镜头'], pages: ['director.html', 'studio.html'], contract: 'polish.video', version: 1, source: 'builtin', enabled: true, chars: 1293, placeholders: [] },
    { id: 'image-prompt', name: '图片提示词', desc: '把描述改写成文生图提示词', triggers: ['图片', '生图', '提示词', '润色'], pages: ['director.html', 'studio.html'], contract: 'polish.image', version: 1, source: 'builtin', enabled: true, chars: 1112, placeholders: [] },
    { id: 'voice-script', name: '口播稿', desc: '把文字改成适合语音合成的口播稿', triggers: ['配音', '口播', '语音', '稿子'], pages: ['studio.html', 'director.html'], contract: 'polish.voice', version: 1, source: 'builtin', enabled: true, chars: 471, placeholders: [] },
    { id: 'image-split', name: '拆分片段', desc: '把一次生图拆成多个片段的方案', triggers: ['拆分片段', '批量生成', '图像拆分'], pages: ['studio.html'], contract: 'img_split.json', version: 1, source: 'builtin', enabled: false, chars: 563, placeholders: [] },
    { id: 'follow-edit', name: '接着改一版', desc: '按用户这一句话改当前这一版，只动点名的那一处', triggers: ['再改', '继续改', '短一点', '换个说法'], pages: ['studio.html', 'director.html'], contract: 'polish.follow', version: 1, source: 'builtin', enabled: true, chars: 518, placeholders: ['what'] },
    { id: 'storyboard-frames', name: '关键帧分镜', desc: '按镜头时长决定关键帧数量并给每张文生图提示词', triggers: ['分镜', '关键帧', '画面序列'], pages: ['director.html'], contract: 'story.json', version: 1, source: 'builtin', enabled: true, chars: 428, placeholders: [] },
    { id: 'split-script', name: '拆剧本', desc: '把剧本拆成场景与镜头', triggers: ['拆剧本', '分镜', '剧本拆分'], pages: ['director.html'], contract: 'split.json', version: 1, source: 'builtin', enabled: true, chars: 1306, placeholders: ['what', 'cast', 'assets', 'board', 'dur'] },
    { id: 'board-edit', name: '改分镜清单', desc: '按既有分镜序号给改动清单', triggers: ['改分镜', '分镜清单', '镜头调整'], pages: ['director.html'], contract: 'board_edit.json', version: 1, source: 'builtin', enabled: true, chars: 2060, placeholders: ['what', 'cast', 'assets', 'board', 'dur'] },
    { id: 'board-assets', name: '分镜新素材判定', desc: '判断哪些新角色/场景/物品要建档、出图、绑音色描述', triggers: ['拆分镜', '新素材', '角色表', '素材表'], pages: ['director.html'], contract: 'board_assets.json', version: 1, source: 'builtin', enabled: true, chars: 1310, placeholders: ['cast', 'assets', 'board'] },
    { id: 'char-image', name: '角色图', desc: '给一位素材生成定妆/三视图提示词', triggers: ['角色图', '定妆照', '三视图'], pages: ['chars.html'], contract: 'char.image.json', version: 1, source: 'builtin', enabled: false, chars: 539, placeholders: ['what', 'name', 'look', 'style', 'ar'] },
    { id: 'char-voice', name: '分角色音色', desc: '给一组角色分配音色方案', triggers: ['分角色', '音色', '配音分配'], pages: ['chars.html'], contract: 'char.voice.json', version: 1, source: 'builtin', enabled: true, chars: 1123, placeholders: ['ways', 'preset', 'cast'] },

    /* —— 我的 Skill（样例）：演示「我的在用」「已停用」「正文用了未登记的占位符」三种状态 —— */
    { id: 'my-char-image', name: '我的角色图（电影感）', desc: '按冷调侧光写角色定妆照', triggers: ['角色图', '定妆照'], pages: ['chars.html'], contract: 'char.image.json', version: 2, source: 'user', enabled: true, chars: 802, placeholders: ['what', 'name', 'look', 'style', 'ar', 'mood'] },
    { id: 'my-video-prompt', name: '我的视频提示词', desc: '一镜到底优先的写法', triggers: ['视频', '提示词'], pages: ['studio.html'], contract: 'polish.video', version: 1, source: 'user', enabled: false, chars: 640, placeholders: ['what'] },
    /* 冲突是真实存在的状态（服务端 skills-store 专门算这一条，界面上今天也有「contract 冲突」那一枚）：
       同一个 contract 下有两份都启用了 —— 常见于老版本留下的副本或手改过的启用状态。
       这时程序按「**没被标 conflict 的那份**」算数（被标的那份形同虚设），界面必须把这件事说出来。 */
    { id: 'my-follow-edit', name: '我的接着改（老副本）', desc: '老版本留下的同名副本', triggers: ['再改'], pages: ['studio.html'], contract: 'polish.follow', version: 1, source: 'user', enabled: true, chars: 300, placeholders: ['what'] },
  ];

  window.DEMO = { GROUPS: GROUPS, SCENES: SCENES, ASSISTANT: ASSISTANT, SKILLS: SKILLS };
})();
