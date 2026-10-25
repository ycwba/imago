/* 拾帧 · 设置 —— 重设计稿的数据层（浅色主题）
   ---------------------------------------------------------------------------
   这里的每一栏、每一行、每一句说明都取自**真机**（跑的是本机那份 .data），
   不是编的。真品出处见 DESIGN.md「数据从哪来」。

   两样东西是这一稿新加的：
   ① 值速记（railValue）—— 每一栏右侧那一小段「现在是什么」。
   ② 栏目的分组说明（groupNote）—— 一句话说清这一组管什么。
   它们在真品里也有出处（都能从现读的设置里取出来），只是今天的界面没画出来。 */
(function () {
  'use strict';

  /* ---------- 目录轨 ---------- */
  /* groupNote = 这一组管什么；fold = 低频组默认收着。
     kw = 搜索别名：轨上只显示「生成平台」，但用户会搜「密钥」「供应商」——
     这些词在真品里都指向同一栏，所以这一份别名跟着轨走，不另造。 */
  const GROUPS = [
    {
      key: 'keys', title: '账户与密钥', note: '谁在替你干活：接进来的平台各一把密钥，两种接法各一份。',
      items: [
        { id: 'providers', title: '生成平台', value: '4 家在用', kw: '供应商 密钥 key api 平台 图片 视频 语音 文字 余额 自定义 语音识别 asr 联网搜索' }
      ]
    },
    {
      key: 'ui', title: '界面与列表', note: '打开就长什么样、列表默认怎么摆、卡在哪等。',
      items: [
        { id: 'appearance', title: '外观与界面', value: '浅色 · 列表', kw: '外观 主题 浅色 深色 皮肤 侧栏 列表 紧凑 提示' },
        { id: 'paging', title: '列表分页', value: '24 / 页', kw: '分页 每页 页数 加载 翻页 滚动' },
        { id: 'network', title: '网络与刷新', value: '300 秒 · 重试 1 次', kw: '网络 超时 重试 刷新 间隔 代理' }
      ]
    },
    {
      key: 'gen', title: '生成与助手', note: '产物落在哪、素材库怎么出图、右下角那个悬浮球怎么 behave。',
      items: [
        { id: 'storage', title: '产物存放', value: '自动存本机', kw: '存放 目录 库根 下载 产物 本机 保存 文件夹' },
        { id: 'chars', title: '素材库', value: '4 张候选', kw: '素材库 角色 场景 道具 音色 候选 张数' },
        { id: 'assistant', title: 'AI 助手', value: '已开', kw: '助手 悬浮球 ai 对话 抽屉 通知 授权' },
        { id: 'polish', title: '润色行为', value: '交给 AI 判断', kw: '润色 提示词 反问 措辞 改写' },
        { id: 'skill', title: 'Skill', value: '11 份已启用', kw: 'skill 技能 场景 内置 停用' }
      ]
    },
    {
      key: 'data', title: '数据与同步', note: '东西存哪、怎么带走、坏了怎么恢复。',
      items: [
        { id: 'sync', title: '数据与同步', value: '本机 → 数据文件', kw: '同步 数据文件 云端 上传 下载 备份 持久化 网盘' },
        { id: 'prompts', title: '提示词归档', value: '195 份', kw: '归档 提示词 目录 清单' },
        { id: 'backup', title: '设置备份与恢复', value: '未导出', kw: '备份 导出 导入 恢复默认 出厂' }
      ]
    },
    {
      key: 'maint', title: '本机维护', note: '这台机器现在行不行、低频的清理。', fold: true,
      items: [
        { id: 'env', title: '本机环境', value: '正常', kw: '体检 代理 环境 端口 浏览器 成片 目录 可写' },
        { id: 'disk', title: '资产库磁盘用量', value: '0 KB', kw: '磁盘 空间 用量 占用 容量 产物 占多大' },
        { id: 'cache', title: '清理缓存', value: '6 项可清', kw: '缓存 清空 清理 缩略图 报文' }
      ]
    }
  ];

  /* ---------- 详情台：每一栏的内容 ----------
     ctl 是什么控件：
       seg     分段开关   { options:[…], active }
       input   单行输入   { value, placeholder, unit, width }
       select  下拉       { value, options:[…] }
       check   勾选       { checked, label }
       buttons 按钮组     { items:[{label, kind}] }
       dir     目录       { value, placeholder, buttons:[…] }
     status = 右侧那一格状态（可空）；note = 控件下方的说明。 */
  const CARDS = {
    providers: {
      title: '供应商与密钥', icon: 'key',
      headActions: ['＋ 添加自定义供应商'],
      intro: '按生成类型分开配（图片 / 视频 / 语音 / 文字 AI），只列本机<b>在用</b>的：添加进来的，或密钥已经有着落的（这里填了 / <code>.env</code> 里有）。找不到某家就是还没接进来，用右边的按钮加。',
      tabs: [
        { id: 'image', label: '图片', count: 1 }, { id: 'video', label: '视频', count: 2 },
        { id: 'voice', label: '语音', count: 1 }, { id: 'text', label: '文字', count: 1 },
        { id: 'asr', label: '语音识别' }, { id: 'search', label: '联网搜索' }
      ],
      blocks: {
        image: [
          { t: 'rows', items: [
            { label: '已接平台', ctl: { type: 'providers', items: [
              { name: 'SparkCine', kinds: '图片 + 视频', key: '已使用服务端环境密钥（留空即可）', meta: '官方地址 https://api.hi.run', status: '在用', actions: ['清除', '验证'] }
            ] } },
            { label: '', note: '同一把密钥还能加到「注册表里共 2 家可选」里的另一家；点「＋ 添加自定义供应商」接的是注册表以外的那家。' }
          ] }
        ],
        video: [
          { t: 'rows', items: [
            { label: '已接平台', ctl: { type: 'providers', items: [
              { name: 'SparkCine', kinds: '图片 + 视频', key: '已使用服务端环境密钥（留空即可）', meta: '官方地址 https://api.hi.run', status: '在用', actions: ['清除', '验证'] },
              { name: 'SiliconFlow', kinds: '视频', key: '已填在本机（不回显）', meta: '官方地址 https://api.siliconflow.cn', status: '在用', actions: ['清除', '验证'] }
            ] } }
          ] }
        ],
        voice: [
          { t: 'rows', items: [
            { label: '已接平台', ctl: { type: 'providers', items: [
              { name: 'SparkCine', kinds: '图片 + 视频', key: '已使用服务端环境密钥（留空即可）', meta: '官方地址 https://api.hi.run', status: '在用', actions: ['清除', '验证'] }
            ] } }
          ] }
        ],
        text: [
          { t: 'rows', items: [
            { label: '已接平台', ctl: { type: 'providers', items: [
              { name: 'DeepSeek 文字 AI', kinds: '文字', key: '已填在本机（不回显）', meta: '官方地址 https://api.deepseek.com', status: '在用', actions: ['清除', '验证'] },
              { name: 'OpenRouter 文字 AI', kinds: '文字 + 识图', key: '已填在本机（不回显）', meta: '官方地址 https://openrouter.ai', status: '在用', actions: ['清除', '验证'] }
            ] } },
            { label: '识图能力', ctl: { type: 'check', checked: true, label: '这一家能看图' }, note: '<b>识图能力是全局一项</b>，只画在当前「作用文字 AI」的那张卡下面 —— 换一家就跟着换。' }
          ] }
        ],
        /* 语音识别 / 联网搜索：**与图片 / 视频 / 语音 / 文字同一层级的两档**，
           只是它们不是「一类平台」，是另外两种接法（所以不按「家」计数）。
           产品自己的文案就是这么写的：「最后两档不是供应商：语音识别与联网搜索和它们同一层级，
           各自一份设置」—— 这一稿让结构与文案对上：它们就住在这张卡的第 5、6 档里。 */
        asr: [
          { t: 'note', text: '把音频 / 视频里的说话转成文字与 SRT。三条路：浏览器内 Whisper（模型经代理同源代下载，识别全在本机浏览器跑）、本地 whisper.cpp（不联网、不花钱）、在线走 OpenAI 兼容的 <code>/audio/transcriptions</code>。设置与密钥只存在代理那一边的 <code>.data/asr.json</code>，读回来只有「有没有密钥」，不回显。' },
          { t: 'rows', items: [
            { label: '本机运行包', status: '不可用', ctl: { type: 'static', text: '没找到 whisper-cli（放到 tools/whisper/ 或在 .env 里设 WHISPER_BIN）' }, actions: ['重新检查'] },
            { label: '浏览器内模型', status: '未下载', ctl: { type: 'static', text: '选「只走浏览器内 Whisper」后首次转写时经代理下载，约 250–500MB' } },
            { label: '走哪条路', ctl: { type: 'select', value: '自动（浏览器模型已就绪就本机识别，否则本地可用用本地，最后在线）', options: ['自动（浏览器模型已就绪就本机识别，否则本地可用用本地，最后在线）', '只走浏览器内 Whisper（首次要经代理下载模型，约 250–500MB）', '只走本地 whisper.cpp', '只走在线服务'] }, note: '本地运行时先把音轨抽成 16k 单声道 WAV，再交给 whisper-cli；浏览器内识别在页面 worker 里跑，关页就停。' },
            { label: '语言', ctl: { type: 'input', value: '', placeholder: '留空 = 自动（可填 zh / en / ja / ko）', width: 220 } },
            { label: '在线服务商', ctl: { type: 'select', value: '手动填接口地址', options: ['手动填接口地址', 'OpenAI 文字 AI', 'DeepSeek 文字 AI', '月之暗面 Kimi', '智谱 GLM', 'MiniMax 文字 AI'] }, note: '选了就从这家取默认地址与渠道密钥。' },
            { label: '型号', ctl: { type: 'input', value: '', placeholder: 'whisper-1', width: 220 } },
            { label: '接口地址', ctl: { type: 'input', value: '', placeholder: 'https://api.openai.com/v1（留空 = 用供应商默认地址）' } },
            { label: '密钥', ctl: { type: 'input', value: '', placeholder: '留空 = 复用供应商渠道 / .env 里的密钥', width: 260 }, actions: ['清掉单独存的'] }
          ] },
          { t: 'actions', items: [{ label: '保存语音识别设置', kind: 'pri' }, { label: '选一段音频测试识别' }] }
        ],
        search: [
          { t: 'note', text: '给 AI 助手补充「现在网上怎么说」：Tavily 返回标题 / 网址 / 摘要；DeepSeek 走对话模型（模型本身要能联网，结果可能没有日期）。搜索结果只在内存缓存 10 分钟，失败不自动重试、不编结果；读网页只收公网 https，15 秒超时、≤2MB。' },
          { t: 'rows', items: [
            { label: '启用联网搜索', ctl: { type: 'check', checked: false, label: '允许助手去网上查' } },
            { label: '搜索服务', ctl: { type: 'select', value: 'Tavily', options: ['Tavily', 'DeepSeek（对话模型）'] }, ctl2: { type: 'input', value: '5', width: 64, unit: '条' } },
            { label: '密钥来源', ctl: { type: 'select', value: '复用渠道密钥', options: ['复用渠道密钥', '单独一把搜索密钥'] }, note: '用渠道那把密钥：deepseek。' },
            { label: '模型', ctl: { type: 'input', value: '', placeholder: '（DeepSeek 路线用对话型号名）', width: 260 } },
            { label: '接口地址', ctl: { type: 'input', value: '', placeholder: '留空 = 用供应商默认地址' } },
            { label: '密钥', ctl: { type: 'input', value: '', placeholder: '留空 = 复用供应商渠道 / .env 里的密钥', width: 260 }, actions: ['清掉单独存的'] }
          ] },
          { t: 'actions', items: [{ label: '保存搜索设置', kind: 'pri' }, { label: '测试搜索' }] }
        ]
      }
    },

    appearance: {
      title: '外观与界面', icon: 'sun',
      intro: '界面长什么样、列表默认怎么摆，跟着数据文件走（换台机器还在）。改完就自动存进本机；主题与左栏当场跟着变。',
      rows: [
        { label: '界面主题', ctl: { type: 'seg', options: ['浅色', '深色'], active: 0 }, note: '左下角那颗太阳 / 月亮是同一个开关的快捷入口。' },
        { label: '侧栏默认展开', ctl: { type: 'check', checked: true, label: '进页面就带出「图标 + 文字」那一列' }, note: '点 logo 随时能收展。' },
        { label: '资产库', ctl: { type: 'seg', options: ['列表', '紧凑'], active: 0 } },
        { label: '素材库', ctl: { type: 'seg', options: ['列表', '紧凑'], active: 0 } },
        { label: '我的收藏', ctl: { type: 'seg', options: ['列表', '紧凑'], active: 0 } },
        { label: '操作成功也给一声提示', ctl: { type: 'check', checked: false, label: '做完也弹一次' }, note: '默认关（安静）：右上角只在出错与警告时弹。「已经做完了」这类不弹 —— 一排绿色对勾会把真正该看的错误淹掉。' }
      ]
    },

    paging: {
      title: '列表分页', icon: 'list',
      intro: '「动态加载」= 滚到列表底部自动续拉，不再有「加载更多」按钮。',
      rows: [
        { label: '生成工作台', ctl: { type: 'select', value: '动态加载（滚动自动加载）', options: ['动态加载（滚动自动加载）', '翻页'] }, ctl2: { type: 'input', value: '24', width: 72, unit: '条' } },
        { label: '资产库', ctl: { type: 'select', value: '动态加载（滚动自动加载）', options: ['动态加载（滚动自动加载）', '翻页'] }, ctl2: { type: 'input', value: '24', width: 72, unit: '条' } },
        { label: '我的收藏', ctl: { type: 'select', value: '翻页', options: ['动态加载（滚动自动加载）', '翻页'] }, ctl2: { type: 'input', value: '24', width: 72, unit: '条' } },
        { label: '素材库', ctl: { type: 'select', value: '翻页', options: ['动态加载（滚动自动加载）', '翻页'] }, ctl2: { type: 'input', value: '18', width: 72, unit: '条' } }
      ]
    },

    network: {
      title: '网络与刷新', icon: 'net',
      intro: '平台慢、平台挂、平台自己重试 —— 这三项决定一次生成最多等多久。',
      rows: [
        { label: '请求超时', ctl: { type: 'input', value: '300', width: 96, unit: '秒' } },
        { label: '失败重试', ctl: { type: 'input', value: '1', width: 96, unit: '次' }, note: '填 0 = 不重试。' },
        { label: '任务刷新间隔', ctl: { type: 'input', value: '4', width: 96, unit: '秒' } }
      ]
    },

    storage: {
      title: '产物存放', icon: 'folder',
      intro: '生成完的产物留在哪、优先从哪读、列表里要不要只显示本机有的。三项连着看：关掉「自动存本机」后，新产物只剩平台外链，而外链过一阵会过期 —— 那时卡片就变成裂图了。第三项要前两项都开着才生效，前两项没开着时这一行整个收起来（画着却不生效等于骗人去勾）。',
      rows: [
        { label: '产物自动存本机', ctl: { type: 'seg', options: ['开', '关'], active: 0 }, note: '生成完的视频 / 图像 / 音频当场把字节存进本机资产库，任务详情一并留底。关掉就退回到只留平台外链 —— 那些地址过期后卡片会变成裂图。已存的文件不会被删，只是不再新增。' },
        { label: '优先用本机文件', ctl: { type: 'seg', options: ['开', '关'], active: 0 }, note: '开 = 卡片直接读本机副本（平台挂了也照样能看）；关 = 仍然直连平台地址。本机文件被删了会自动回源平台。' },
        { label: '卡片显示「本机 / 云端」标识', ctl: { type: 'seg', options: ['显示', '不显示'], active: 0 }, note: '开 = 资产卡上标出这一份是「本机」「云端」还是两边都有；只影响显示。' },
        { label: '不显示云端任务', ctl: { type: 'check', checked: false, label: '列表里只留本机有字节的产物' }, note: '勾上 = 生成工作台与资产库的列表里只留本机有这份字节的产物。在跑的、排队中的、失败的不藏。' },
        { label: '导出目录', ctl: { type: 'dir', value: '未选择（产物会进系统下载文件夹）', buttons: ['选择文件夹', '清除'] }, note: '浏览器渲染的成片与导出的素材落到这个文件夹。没有设时产物会进系统下载文件夹。' },
        { label: '本机资产库位置', ctl: { type: 'dir', value: '默认：下载\\拾帧（留空就用它）', buttons: ['📁 选择…', '恢复默认'] }, note: '每一次生成的产物只存这一份，落在下面这个位置里按类型分的 图片/ 视频/ 音频/ 文件名是可读的那种。同名自动加 -2，不覆盖。账在 .data/local-assets/，那是应用自己的账，跟产物待在一处。' },
        { label: '自动存本机要存哪一档', ctl: { type: 'select', value: '连历史产物一起补齐（推荐默认）', options: ['连历史产物一起补齐（推荐默认）', '只存新生成的'] }, note: '第一次打开这一档会把列表里已有的产物逐个下载存进本机。产物多的时候这会占不少带宽与磁盘。' },
        { label: '左栏显示余额', ctl: { type: 'check', checked: true, label: '在侧栏显示各平台余额' } },
        { label: '左栏显示本机产物', ctl: { type: 'check', checked: true, label: '在侧栏显示已存几份' } }
      ]
    },

    chars: {
      title: '素材库', icon: 'users',
      intro: '这几项只作用于「素材库」那一页：界面上的说法与真的发给文字 AI 的参数是同一个开关。',
      rows: [
        { label: '让 AI 给角色定音色', ctl: { type: 'seg', options: ['开启', '关闭'], active: 0 }, note: '性格 → 音色描述 / 复刻。' },
        { label: '音色怎么定', ctl: { type: 'select', value: '自动（优先生成音色）', options: ['自动（优先生成音色）', '只用预设音色'] }, note: '默认「自动」：优先让 AI 按角色的外貌与性格现造嗓子，这一家没有这类型号时才退回预设音色。' },
        { label: '角色 / 场景 / 道具 一次出几张候选', ctl: { type: 'input', value: '4', width: 80, unit: '张' }, note: '调大就是多画几张：每张换一条提示词（背景 / 光线 / 表情），是几个可挑的路子；上限看生图平台一次能让几张。' }
      ]
    },

    assistant: {
      title: 'AI 助手', icon: 'chat',
      intro: '右下角那个悬浮球 / 右侧抽屉（Ctrl + / 开合）。它读本机数据不用问；动手（提交一次生成、改一项设置）默认要你在卡片上点「执行」。',
      rows: [
        { label: '启用 AI 助手', ctl: { type: 'check', checked: true, label: '右下角有悬浮球，Ctrl + / 也能开合' } },
        { label: '执行前不用我点确认', ctl: { type: 'check', checked: false, label: '卡片照画，动作自动提交' } },
        { label: '悬浮球拖到窗口边上时吸住', ctl: { type: 'check', checked: true, label: '默认开着' } },
        { label: '助手提交的任务出结果时弹一次系统通知', ctl: { type: 'check', checked: false, label: '出结果时弹一次通知' }, actions: ['现在授权'], note: '还没授权：勾上这一项之后，点一下「现在授权」，浏览器才会问你要不要弹。' }
      ]
    },

    polish: {
      title: '润色行为', icon: 'wand',
      intro: '提示词正文由 Skill 提供（见「Skill」那一栏）；这里只留「润色前要不要先反问」这一个行为开关。',
      rows: [
        { label: '润色前要不要先反问', ctl: { type: 'select', value: '交给 AI 判断（推荐）：它读完觉得缺什么才问', options: ['交给 AI 判断（推荐）：它读完觉得缺什么才问', '总是先反问一遍', '从不反问'] } }
      ]
    },

    skill: {
      title: 'Skill', icon: 'stack',
      headActions: ['添加新 Skill'],
      intro: 'Skill 是「某类任务该按什么写」的可加载说明（提示词润色、分镜、配音稿…）。按<b>使用场景</b>分着：选一个场景，告诉你这一步会拿到哪些项目上下文、现在用的是哪一份 Skill、你能怎么接管。Skill 只补充写法，输出格式与禁止项由机器契约管。',
      rows: [
        { label: '使用场景', ctl: { type: 'scenes', items: [
          { g: 'AI 助手', n: '1', rows: [] },
          { g: '生成工作台', n: '5', rows: [
            { name: '视频提示词润色', state: '内置' },
            { name: '图片提示词润色', state: '内置' },
            { name: '配音稿润色', state: '内置' },
            { name: '图片片段拆分', state: '空档' },
            { name: '再改一版', state: '冲突' }
          ] },
          { g: '导演台', n: '4', rows: [{ name: '剧本拆分镜', state: '内置' }, { name: '分镜切片规划', state: '内置' }] },
          { g: '素材库', n: '2', rows: [{ name: '角色脸 / 三视图 / 场景图提示词', state: '内置' }, { name: '给每位角色定音色', state: '内置' }] }
        ] } }
      ]
    },

    sync: {
      title: '数据与同步', icon: 'sync',
      intro: '开启后数据会同时写一份到本机项目目录的 .data/（普通 JSON 文件），可备份、可同步到你自己的网盘。',
      rows: [
        { label: '数据文件', ctl: { type: 'static', text: 'C:\\Users\\ycwb\\Desktop\\shizhen\\.data · 1 份数据 · 5 B' }, actions: ['复制路径', '刷新'] },
        { label: '浏览器存储', status: '未持久化', ctl: { type: 'static', text: '磁盘紧张时浏览器可能自动清理（已用 2.5 KB / 配额 10.0 GB）' }, actions: ['申请持久化'] },
        { label: '本机 ↔ 数据文件', ctl: { type: 'buttons', items: [{ label: '↑ 本机 → 数据文件' }, { label: '↓ 数据文件 → 本机' }, { label: '导出整包备份' }, { label: '导入整包备份' }] } },
        { label: '云端', ctl: { type: 'buttons', items: [{ label: '测试连接' }, { label: '↑ 上传到云端' }, { label: '↓ 从云端下载' }, { label: '⇅ 一键双向同步' }] }, note: '还没有同步过；提示词归档本机 195 份（未勾选跟着同步，勾上才会备份）。' },
        { label: '连密钥一起同步', ctl: { type: 'check', checked: false, label: '默认否' } },
        { label: '连提示词归档一起', ctl: { type: 'check', checked: false, label: '默认否' } }
      ]
    },

    prompts: {
      title: '提示词归档', icon: 'archive',
      intro: '生成时用过的提示词正文，一份一份存在本机。归档只是给你回头找和改的，不是给机器读的。',
      rows: [
        { label: '归档数量', ctl: { type: 'static', text: '195 份归档' } },
        { label: '归档目录', ctl: { type: 'dir', value: '下载\\拾帧\\提示词', buttons: ['打开目录', '刷新清单'] } }
      ]
    },

    backup: {
      title: '设置备份与恢复', icon: 'save',
      intro: '上面每一栏改完就自动存进本机，这里三项管的都是整份设置：导出成一个 JSON（可换电脑导入）、从 JSON 恢复、清回出厂状态。导出默认不含密钥，选了含密钥那份文件里就是明文，别外传。',
      rows: [
        { label: '整份设置', ctl: { type: 'buttons', items: [{ label: '导出设置' }, { label: '导入设置' }, { label: '恢复默认', kind: 'danger' }] } }
      ],
      note: '这份文件只含设置：素材库（角色 / 场景 / 道具）、生成历史、收藏与导演台工作区都是数据，不在这里面 —— 要整份带走请用「数据与同步」那一栏的「导出整包备份」。'
    },

    env: {
      title: '本机环境', icon: 'pulse',
      intro: '问的是这台机器现在能不能干活：代理版本、这个浏览器出不出得了成片（WebCodecs / H.264 / AAC）、三个落盘目录能不能写。全部现读，一个字节都不写。',
      kv: [
        { k: '本地代理', v: '在运行', s: 'ok', d: '注册表 v18 · 端口 11954 · Node v24.19.0' },
        { k: '代理健康', v: '正常', s: 'ok', d: '已运行 2 秒 · 最后一次干活 0 秒前 · /data' },
        { k: '出站代理', v: '走代理', s: 'ok', d: '环境变量 HTTPS_PROXY = http://127.0.0.1:7897' },
        { k: '成片导出（本浏览器）', v: '能用', s: 'ok', d: 'WebCodecs 能用 · H.264 能用 · VP9 能用 · AAC 能用' },
        { k: '平台转发闸', v: '没被限过', s: 'ok', d: '每家同时在途 8 条 · 排队上限 32 条 · 被限流最多重问 2 次（只问读请求）· 最多等 15 秒' },
        { k: '数据目录（.data）', v: '可写', s: 'ok', d: 'C:\\Users\\ycwb\\Desktop\\shizhen\\.data' },
        { k: '本机资产目录', v: '可写', s: 'ok', d: 'C:\\Users\\ycwb\\Desktop\\shizhen\\.assets' },
        { k: '成片目录', v: '可写', s: 'ok', d: 'C:\\Users\\ycwb\\Desktop\\shizhen\\.renders' }
      ],
      actions: ['重新体检', '复制体检结果'],
      footNote: '上次体检：10:21:17 · 这一轮是代理缓存的（换过浏览器或改过目录权限请点「重新体检」）'
    },

    disk: {
      title: '资产库磁盘用量', icon: 'disk',
      intro: '本机存下来的图片 / 视频 / 语音占多大地方、同一件有没有压了好几份、这块盘还剩多少。全部现读，一个字节都不写不删。',
      rows: [
        { label: '本机资产库', ctl: { type: 'static', text: '还没有产物' }, note: '没有要提醒的 —— 这一格只数不删。' }
      ],
      actions: ['重新数一遍', '复制这份读数', '去资产库删'],
      footNote: '数于 10:21:17'
    },

    cache: {
      title: '清理缓存', icon: 'broom',
      intro: '这四项都是能自己重新生成的缓存，清掉不会少任何作品（图片 / 视频 / 语音、提示词归档、收藏、历史一律不动）。换密钥、平台改了参数又不想干等过期时用这一栏最快。',
      kv: [
        { k: '平台接口应答', v: '清空', d: '平台返回的列表 / 任务详情 / 产物地址 / 能力表 / 报价的副本。换了密钥或平台改了参数时清它，下次打开重新拉。' },
        { k: '文字 AI 型号能力', v: '清空', d: '每个文字型号「能不能识图」的判定（缓存 12 小时）。' },
        { k: '缩略图与体积探测', v: '清空', d: '视频首帧与图片小图的本地副本，加上上传前的体积测量。' },
        { k: '「没归档到」标记', v: '清空', d: '哪些任务的提示词在本机归档里找不到。' },
        { k: '本地任务记录', v: '清空', d: '生图历史（合并前的旧工作台，已不再写入）：本机 0 条。' },
        { k: '本地任务记录', v: '清空', d: '语音任务：本机 0 条。' }
      ]
    }
  };

  window.SETTINGS = { GROUPS: GROUPS, CARDS: CARDS };
})();
