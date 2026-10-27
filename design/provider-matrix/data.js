/* 拾帧 · 设置 › 账户与密钥 —— 设计稿 A 的假数据
   ---------------------------------------------------------------------------
   形状照真品：
     · 真品里「一家供应商同时做多种模态」是**按模态拆成几条 provider**，
       共用同一个 keyId（sparkcine / sparkcine-video；minimax-text / minimax-tts /
       minimax-video；siliconflow-image / siliconflow-video / siliconflow），
       设置页按 keyId 归并成一张卡 —— 但归并结果只在卡底当脚注写一句
       「同一把密钥也用于：…」。
     · 型号清单来自**平台自己的 /models**（自动取回）或**自己手填**，
       存在 .data/sk_model_prefs.json（每家一份 {typed, off}）。
     · 语音识别与联网搜索不是供应商：它们从**文字类**供应商里挑一家当「渠道」，
       密钥与参数另存 .data/asr.json / .data/search.json。

   这份数据把上面两层压平成一个模型：
     账号 (account) = 一家供应商 + 一把密钥
     能力 (cap)     = 这一家能开通的每一档：图片 / 视频 / 语音合成 / 文字对话 /
                      语音识别 / 联网搜索

   数据是真的（名字、官网、接口地址、型号、状态都取自真品注册表与设置页），
   只有「哪一把已填」「型号取回的结果」是为了演示排的。 */
(function () {
  'use strict';

  /* 一条型号：id（真品里的模型 id）、名字、支持哪几种用法、是否被藏起来 */
  function M(id, name, modes, off) {
    return { id: id, name: name, modes: modes, off: !!off };
  }

  var DATA = {
    /* 六档能力。multi=false 的两档（语音识别 / 联网搜索）同一时刻只能有一家在线上顶着 ——
       真品里它们是单选（asr.service.providerId 一个、search.channelId 一个）。 */
    CAPS: [
      { id: 'image', zh: '图片', glyph: '图', multi: true, hint: '文生图 · 图生图' },
      { id: 'video', zh: '视频', glyph: '视', multi: true, hint: '文生视频 · 首尾帧 · 参考图' },
      { id: 'audio', zh: '语音合成', glyph: '音', multi: true, hint: '文字转语音 · 音色试听' },
      { id: 'text', zh: '文字对话', glyph: '字', multi: false, hint: '助手 · 润色 · 识图（全局只走一家）' },
      { id: 'asr', zh: '语音识别', glyph: '识', multi: false, hint: '音频转文字与 SRT' },
      { id: 'search', zh: '联网搜索', glyph: '搜', multi: false, hint: '给助手补「现在网上怎么说」' }
    ],

    /* 本机跑的两条识别路线 —— 不绑任何账号，也不花钱。 */
    LOCAL: [
      { id: 'browser', zh: '浏览器内 Whisper', state: 'bad', stateZh: '模型未下载',
        note: '模型经代理同源下载（250–500MB），识别全在本机浏览器里跑，关页就停。' },
      { id: 'local', zh: '本地 whisper.cpp', state: 'bad', stateZh: '不可用',
        note: '没找到 whisper-cli（放到 tools/whisper/，或在 .env 里设 WHISPER_BIN）。' }
    ],

    /* 账号。key: local = 设置页里存着的一把；env = 服务端 .env / 环境变量里的；none = 还没填。 */
    ACCOUNTS: [
      {
        id: 'siliconflow', name: '硅基流动 SiliconFlow', site: 'https://cloud.siliconflow.cn',
        key: 'local', base: 'https://api.siliconflow.cn/v1',
        balance: true, off: false, custom: false,
        keyNote: '设置页里存着的一把（sk_key_siliconflow.json）。',
        caps: {
          image: {
            state: 'on', model: 'FLUX.1-schnell',
            models: [
              M('FLUX.1-schnell', 'FLUX.1 Schnell', ['文生图', '图生图']),
              M('Kwai-Kolors/Kolors', 'Kolors', ['文生图', '图生图']),
              M('stabilityai/stable-diffusion-3.5-large', 'SDXL 3.5', ['文生图'], true)
            ],
            fetch: { state: 'done', n: 12, ms: 840, src: '/models 自动取回' }
          },
          video: {
            state: 'on', model: 'Wan2.1-I2V-14B',
            models: [
              M('Wan2.1-I2V-14B', 'Wan2.1 I2V 14B', ['首尾帧', '参考图']),
              M('Wan2.1-T2V-1.3B', 'Wan2.1 T2V 1.3B', ['文生视频'])
            ],
            fetch: { state: 'done', n: 12, ms: 840, src: '/models 自动取回（同一次取回，按媒体类型分开）' }
          },
          text: {
            state: 'alt', model: 'Qwen/Qwen3-32B',
            models: [
              M('deepseek-ai/DeepSeek-V3', 'DeepSeek V3', ['对话', '识图']),
              M('Qwen/Qwen3-32B', 'Qwen3 32B', ['对话'])
            ],
            fetch: { state: 'done', n: 12, ms: 840, src: '/models 自动取回' }
          },
          asr: {
            state: 'alt', model: 'whisper-1',
            models: [M('whisper-1', 'Whisper v1', ['转写'])],
            fetch: { state: 'na' }
          },
          search: {
            state: 'alt', model: 'deepseek-ai/DeepSeek-V3',
            models: [M('deepseek-ai/DeepSeek-V3', 'DeepSeek V3（能联网的型号）', ['对话', '联网'])],
            fetch: { state: 'done', n: 12, ms: 840, src: '/models 自动取回' }
          }
        }
      },
      {
        id: 'minimax', name: 'MiniMax', site: 'https://platform.minimax.io',
        key: 'env', base: 'https://api.minimax.io/v1',
        balance: false, off: false, custom: false,
        keyNote: '服务端 .env 里的 MINIMAX_API_KEY。',
        caps: {
          video: {
            state: 'on', model: 'Hailuo-02',
            models: [
              M('Hailuo-02', 'Hailuo 02', ['文生视频', '首尾帧', '动作参考']),
              M('Hailuo-02-1080P', 'Hailuo 02 1080P', ['文生视频'])
            ],
            fetch: { state: 'idle' }
          },
          audio: {
            state: 'on', model: 'speech-02-hd',
            models: [
              M('speech-02-hd', 'Speech 02 HD', ['音色']),
              M('speech-02-turbo', 'Speech 02 Turbo', ['音色', '快速'])
            ],
            fetch: { state: 'idle' }
          },
          text: {
            state: 'pri', model: 'MiniMax-M2',
            models: [
              M('MiniMax-M2', 'MiniMax M2', ['对话']),
              M('MiniMax-M1', 'MiniMax M1', ['对话'])
            ],
            fetch: { state: 'done', n: 6, ms: 510, src: '/models 自动取回' }
          },
          asr: {
            state: 'alt', model: 'whisper-1',
            models: [M('whisper-1', 'Whisper v1', ['转写'])],
            fetch: { state: 'na' }
          },
          search: {
            state: 'alt', model: 'MiniMax-M2',
            models: [M('MiniMax-M2', 'MiniMax M2（能联网的型号）', ['对话', '联网'])],
            fetch: { state: 'done', n: 6, ms: 510, src: '/models 自动取回' }
          }
        }
      },
      {
        id: 'sparkcine', name: 'SparkCine', site: 'https://hi.hi.run',
        key: 'env', base: 'https://hi.hi.run',
        balance: true, off: false, custom: false,
        keyNote: '服务端 .env 里的 SPARKCINE_API_KEY。',
        caps: {
          image: {
            state: 'on', model: 'img-general-v2',
            models: [
              M('img-general-v2', '通用生图 v2', ['文生图', '图生图']),
              M('img-detail-v2', '细节生图 v2', ['图生图'])
            ],
            fetch: { state: 'done', n: 9, ms: 1200, src: '/models 自动取回（一个接口，图与视频混在一份清单里）' }
          },
          video: {
            state: 'on', model: 'h3-video-pro',
            models: [
              M('h3-video-pro', 'H3 Video Pro', ['文生视频']),
              M('h3-video-lite', 'H3 Video Lite', ['文生视频'], true)
            ],
            fetch: { state: 'done', n: 9, ms: 1200, src: '/models 自动取回（同一次取回，按媒体类型分开）' }
          }
        }
      },
      {
        id: 'deepseek', name: 'DeepSeek', site: 'https://platform.deepseek.com',
        key: 'local', base: 'https://api.deepseek.com/v1',
        balance: true, off: false, custom: false,
        keyNote: '设置页里存着的一把（sk_key_deepseek.json）。',
        caps: {
          text: {
            state: 'alt', model: 'deepseek-chat',
            models: [
              M('deepseek-chat', 'DeepSeek Chat', ['对话']),
              M('deepseek-reasoner', 'DeepSeek Reasoner', ['对话'])
            ],
            fetch: { state: 'done', n: 2, ms: 320, src: '/models 自动取回' }
          },
          asr: {
            state: 'pri', model: 'whisper-1',
            models: [M('whisper-1', 'Whisper v1', ['转写'])],
            fetch: { state: 'na' }
          },
          search: {
            state: 'pri', model: 'deepseek-chat',
            models: [M('deepseek-chat', 'DeepSeek Chat（能联网的型号）', ['对话', '联网'])],
            fetch: { state: 'done', n: 2, ms: 320, src: '/models 自动取回' }
          }
        }
      },
      {
        id: 'tavily', name: 'Tavily', site: 'https://tavily.com',
        key: 'local', base: 'https://api.tavily.com/search',
        balance: false, off: false, custom: false, separateKey: true,
        keyNote: '单独存的一把搜索密钥（search.json）。',
        caps: {
          search: {
            state: 'alt', model: 'tavily-search',
            models: [M('tavily-search', 'Tavily Search', ['搜索'])],
            fetch: { state: 'na' }
          }
        }
      },
      {
        id: 'mygw', name: '我的中转站', site: '',
        key: 'local', base: 'https://gw.example.com/api/v1',
        balance: false, off: false, custom: true, shapeName: 'OpenAI 兼容对话',
        keyNote: '这一家自己的密钥，不回退 .env。',
        caps: {
          text: {
            state: 'off', model: 'gpt-4o-mini',
            models: [
              M('gpt-4o-mini', 'GPT-4o mini', ['对话']),
              M('qwen-max', 'Qwen Max', ['对话'], true)
            ],
            fetch: { state: 'done', n: 2, ms: 430, src: '/models 自动取回' }
          }
        }
      }
    ],

    /* 预设供应商：注册表里还接着、但本机还没接进来的那些。
       「添加供应商」就摆这一份 —— 点一下就加进来（加进来以后密钥那一格是空的，填一把就能用）。
       与真品的注册表一致：名字、官网、接口地址、能力都对得上。 */
    PRESETS: [
      { id: 'zhipu', name: '智谱 GLM', site: 'https://open.bigmodel.cn',
        base: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPU_API_KEY',
        caps: ['text', 'video'], note: '文字对话 + 视频（CogVideoX）' },
      { id: 'vgenv', name: 'VGENV 视频', site: 'https://vgenv.example.com',
        base: 'https://api.vgenv.ai', keyEnv: 'VGENV_API_KEY',
        caps: ['video'], note: '视频（建任务 → 按任务列表轮询）' },
      { id: 'mimo', name: 'MiMo 语音合成', site: 'https://mimo.mi.com',
        base: 'https://api.xiaomimimo.com', keyEnv: 'MIMO_API_KEY',
        caps: ['audio'], note: '语音合成' },
      { id: 'openai', name: 'OpenAI 文字 AI', site: 'https://platform.openai.com',
        base: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY',
        caps: ['text'], note: '文字对话（OpenAI 兼容）' },
      { id: 'moonshot', name: '月之暗面 Kimi', site: 'https://platform.moonshot.cn',
        base: 'https://api.moonshot.cn/v1', keyEnv: 'MOONSHOT_API_KEY',
        caps: ['text'], note: '文字对话' },
      { id: 'volcengine', name: '火山方舟 豆包', site: 'https://console.volcengine.com',
        base: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ARK_API_KEY',
        caps: ['text'], note: '文字对话' },
      { id: 'dashscope', name: '通义千问 百炼', site: 'https://bailian.console.aliyun.com',
        base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY',
        caps: ['text'], note: '文字对话（OpenAI 兼容）' },
      { id: 'openrouter', name: 'OpenRouter 文字 AI', site: 'https://openrouter.ai',
        base: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY',
        caps: ['text'], note: '文字对话（一家顶多家）' }
    ],

    /* 待接入的一档：注册表里还有，但一把密钥都没着落。 */
    PENDING: [
      { id: 'tavily2', name: 'Tavily 联网搜索', caps: '联网搜索' },
      { id: 'sparkcine2', name: 'SparkCine（另一个账号）', caps: '图片 · 视频' }
    ],

    /* 语音识别那一档的全局设置（真品里在 .data/asr.json）。 */
    ASR: {
      route: 'auto', language: '',
      routeHint: '自动 —— 浏览器模型已就绪就本机识别，否则本地可用用本地，最后在线。',
      model: 'whisper-1',
      baseUrl: 'https://api.deepseek.com/v1/audio/transcriptions',
      channel: 'deepseek',
      hasKey: true
    },

    /* 联网搜索那一档的全局设置（真品里在 .data/search.json）。 */
    SEARCH: {
      enabled: false, provider: 'tavily', maxResults: 5,
      cred: 'manual', channel: 'deepseek',
      model: 'tavily-search',
      baseUrl: 'https://api.tavily.com/search',
      hasKey: true
    },

    /* 目录轨：真品是 5 组 15 张卡；这一稿把「语音识别」「联网搜索」并进「账户与密钥」那一张
       （它们是同一副骨架的两张卡，同属账户那一栏），所以这里是 5 组 13 张。 */
    RAIL: [
      { group: '账户与密钥', cards: [
        { nav: 'accounts', zh: '账户与密钥', val: '6 家 · 图片 2 / 视频 3', live: true }
      ]},
      { group: '界面与列表', cards: [
        { nav: 'network', zh: '网络与刷新', val: '300 秒 · 2 次' },
        { nav: 'paging', zh: '列表分页', val: '24 / 页' },
        { nav: 'appearance', zh: '外观与界面', val: '浅色 · 列表' }
      ]},
      { group: '生成与助手', cards: [
        { nav: 'storage', zh: '产物存放', val: '自动存本机' },
        { nav: 'chars', zh: '素材库', val: '4 候选' },
        { nav: 'assistant', zh: 'AI 助手', val: '已开' },
        { nav: 'polish', zh: '润色行为', val: '交稿 AI 判别' },
        { nav: 'skill', zh: 'Skill', val: '11 已启用' }
      ]},
      { group: '数据与同步', cards: [
        { nav: 'cloud', zh: '云同步', val: '本机 + 云端文件' },
        { nav: 'prompts', zh: '提示词归档', val: '195 份' },
        { nav: 'backup', zh: '设置备份与恢复', val: '未导出' }
      ]}
    ]
  };

  window.DEMO = DATA;
})();
