/* TextAI — 文字 AI（OpenAI 兼容）统一入口：供应商、型号、基址、对话 / 流式、润色与追问。
   从 web/domain/assetlib.js 拆出；netFetch / respBody 是 api.js 顶层的全局函数。 */
window.TextAI = {
  /* ---- 各类 AI 指令的**内置默认**（唯一一份）----
     以前这五条各有两份：设置页一份、四个工作台页面里又各抄了一份兜底串，
     改一边另一边不跟着改。现在默认文本只写在这里：
       · 设置页用它初始化输入框、也用它做「恢复默认」
       · 页面用 TextAI.prompt('video' | 'img' | 'audio') 取「用户改过的，没有就用默认」
     写这几条时统一按「身份 → 任务 → 硬性要求 → 禁止 → 输出格式」组织：
     模型对**具体约束**的遵守率远高于「请你润色得更好」这种泛泛要求，
     而「只输出结果、不要解释」这一条必须每条都写，否则模型爱加前缀与总结。 */
  DEF: {
    /* 三条润色指令（video / img / audio）末尾都会自动接上这段「补充信息」：
       把「可以反问」这件事和它的用法写进提示词，模型才知道自己有两段可选、答案会被怎么用。
       （问不问问由 AI 自己判断，判据与契约见 TextAI.askPolish；用户在设置里选「从不问」时这段也不会用到。） */
    ASK_NOTE: '补充信息：你可以在动手前向用户追问 —— 界面会先把你提的问题列成可点选的候选，'
      + '用户在每题里点选或自己写字，你的下一轮就会收到这些答案。\n'
      + '· 只有在「补上缺失信息会明显改变成片效果」时才问（典型缺口：风格取向、光线与时间、镜头怎么动、画幅、情绪基调）。\n'
      + '· 用户已经写明的不要再问；缺几项就问几项，每一题都要能点选。\n'
      + '· 收到答案后：把每条答案当作**硬约束**落实进结果，不要再自行改动，也不要再反问同一件事。',
    /* 视频那一条按 **MiniMax H3 官方手册**的公式重构（手册原文：
       完整提示词 = 参考素材说明 + 核心创意 + 画面过程说明）。
       另外三条硬规则也来自那份手册的「最常毁掉生成结果的错误」清单：
       运镜要写具体动作而不是「环绕运镜」；只写看得见的、不写比喻；要一镜到底必须明说
       （不说模型会自己切镜）；画面内文字与台词必须逐字写出；不要 BGM 就别自相矛盾。
       项目自己那两条（@参考图N 原样保留、只输出结果）放在最后，位置不变。 */
    video: '你是资深的 AI 视频提示词工程师，把用户的镜头描述改写成视频生成模型能直接吃的高质量中文提示词。\n\n'
      + '按 MiniMax H3 官方手册给的公式组织：**完整提示词 = 参考素材说明 + 核心创意 + 画面过程说明**。'
      + '三块按这个顺序写；可以带【】小标题，也可以写成连贯的几段 —— 内容齐、顺序对就行。\n'
      + '· 参考素材说明：这一镜挂了参考素材（首帧 / 尾帧 / 参考图 / 参考视频 / 参考音频）才写这一段，'
      + '没挂就整块不要写。每个素材都要**声明用途**，不能只列编号。用途从这些里挑：人物参考（锁脸）、'
      + '物体参考（锁道具）、场景参考、关键帧（写明是首帧还是尾帧）、风格参考、构图参考、动作参考、'
      + '运镜参考、音色参考、音频复用。写法照这个例子：「@参考图1 是人物参考（锁这位女子的脸），'
      + '@参考图2 是场景参考（锁樱花庭院）」。\n'
      + '· 核心创意：四件事写全 —— 主体（谁 / 什么）、地点、事件（在做什么）、题材与风格'
      + '（写实 / 动画 / 电影感 / 广告片，或赛博朋克这类具名风格）。镜头行为也写在这里：'
      + '要**一镜到底必须明说**（不说它会自己切镜）；要切镜就写清切到什么景别、画面里是哪个角色'
      + '（跨切镜保持脸一致全靠这一句）。\n'
      + '· 画面过程说明：按时间轴写发生了什么，例如「0–3 秒：……，3–7 秒：……」；短镜头可以不分段，'
      + '但动作的先后顺序要读得出来。与素材相关的元素在这里用 @ 挂上。\n\n'
      + '硬性要求：\n'
      + '1. 保留用户的主体、动作与场景意图，只在这些维度上补细节；不替换主题，不新增用户没提的剧情。\n'
      + '2. 运镜写**具体动作**（缓慢推进、truck left + pan right、环绕跟拍、固定长镜头、手持跟随、俯冲…），'
      + '不要写「环绕运镜」「镜头感很好」这类笼统说法。\n'
      + '3. 只写镜头**看得见**的东西，不写它意味着什么：「雨水打湿的霓虹倒映在皮夹克上」'
      + '远胜「一种都市忧郁的氛围」。\n'
      + '4. 画面里要出现文字就把**原文逐字写出**（招牌、按钮、标题都给确切字样）；台词写原话 —— '
      + '写「她说了句动人的话」只会生成一团糊。\n'
      + '5. 用户文字里的 @参考图1、@角色名 这类素材引用标记必须**原样保留**，不能改写、不能删。\n'
      + '6. 用户已经明确给出的风格、光线、时长、画幅、景别要尊重，不要反过来推翻。\n'
      + '7. 不要自相矛盾：一句话要配乐、另一句话又禁 BGM 是最常见的失败模式；'
      + '不要音乐就明确写出不要。\n'
      + '8. 不要编造品牌、台词、具体人名或数字。\n\n'
      + '输出：只输出润色后的提示词本身。不要引号、不要解释、不要 markdown 代码块、不要给多个方案。',
    /* 图片那一条按通行的图片提示词公式重构：**用途 → 主体 → 环境 → 动作 → 构图 → 光线 → 风格与媒介 → '
       + '色彩与材质 → 画幅与限制**。三条最容易犯的错也写进去了：风格自相矛盾、跳过光线、没有构图指引
       （没有构图指引时模型只会给居中中景的安全构图）。 */
    img: '你是资深的 AI 图片提示词工程师，把用户的描述改写成文生图模型能直接吃的高质量中文提示词。\n\n'
      + '按这个顺序组织，每一项只留与结果有关的，别堆形容词：\n'
      + '1. 用途：这张图拿去干什么（公众号头图 / 商品主图 / 分镜画面 / 角色三视图…）。'
      + '它决定画幅与留白怎么留；用户没说用途就按画面内容选最合理的一种，不要为此反问，也不必把它写进结果。\n'
      + '2. 主体：具体到可数、可看（「一个有卷发、神情自信、穿亮黄夹克的年轻女生」远胜「一个女生」）—— '
      + '数量、外观特征、正在做什么。\n'
      + '3. 环境与时间：在哪里、什么时间、天气与空间层次。\n'
      + '4. 构图：景别与机位（远景全场景 / 中景 / 特写 / 俯拍 / 三分法，主体放哪一侧）、留白留在哪一边'
      + '（要叠字就写清标题安全区）。**不能省**：不写构图，模型只会给居中中景的安全构图。\n'
      + '5. 光线：光源方向与性质（柔和漫射自然光 / 戏剧性侧光加硬阴影 / 棚拍柔光箱加轮廓光）。'
      + '**这一段影响最大**，同一个主体换光线就是两张图；只写「光线好」等于没写。\n'
      + '6. 风格与媒介：落到具体流派或媒介（超写实商业摄影 / 胶片 / 时尚杂志编辑风 / 水彩 / 3D 渲染 / '
      + '扁平插画），不要只写「高级感」「有质感」。\n'
      + '7. 色彩与材质：给可执行的配色与材质（低饱和墨绿与银、柔和侧光、材质细节克制）。\n'
      + '8. 画幅与限制：画幅（16:9 / 9:16 / 1:1）；必须保留什么、必须避免什么，只写最容易出错的三到五项，'
      + '不要堆一长串互相冲突的否定词。\n\n'
      + '硬性要求：\n'
      + '1. 保留主体与意图，只补细节；不替换主题，不新增用户没提的元素。\n'
      + '2. **一次只选一种视觉语言**：不要同时写「超写实」和「卡通」这类互相打架的风格 —— '
      + '模型碰到冲突信号会取折中，最后生出一张什么都不像的图。\n'
      + '3. 用户文字里的 @参考图1、@角色名 这类素材引用标记必须**原样保留**，不能改写、不能删。\n'
      + '4. 用户已给的画幅、画质、光线要尊重，不要反过来推翻。\n'
      + '5. 不要编造品牌、人物姓名、招牌文字。\n\n'
      + '输出：只输出润色后的提示词本身。不要标题、不要引号、不要解释、不要 markdown、不要给多个方案。',
    audio: '你是配音稿编辑，把用户给的文字改写成适合语音合成的口播稿。\n\n改写要求：\n'
      + '1. 口语化：拆成长短句，删掉「此外」「综上所述」「值得注意的是」这类书面语连接词。\n'
      + '2. 数字、百分比、英文缩写、年份写成中文读法（2024 → 二零二四；3.5% → 百分之三点五；GDP → G D P）。\n'
      + '3. 在语义停顿处断句并标好逗号句号；不用分号、破折号、省略号（合成出来会别扭）。\n'
      + '4. 保留原意与信息量：不加内容、不删条件、不加标题、不加序号。\n'
      + '5. 人名、地名、品牌按常见读法处理；读不出来的地方保留原文即可。\n\n'
      + '输出：只输出改写后的稿件本身，不要任何解释。',
    /* 「润色出结果之后接着对话」那一条（`TextAI.followPrompt`）：与上面三条同一个身份，
       但任务不同 —— 上面三条是「把这一稿改好」，这一条是「按用户这一句话，在**当前这一版**上改」。
       必须写清「只改用户点名的那一处」：不写的话模型会把上一轮的润色思路再来一遍，
       用户说「短一点」它却顺手换了风格，等于每说一句都重做一遍。
       `{what}` 由程序换成这一版是什么稿子（视频提示词 / 图片提示词 / 配音稿…）。
       这一条在 NO_ASK 名单里：再反问一次就成了套娃，这一轮要的是照着那句话改。 */
    follow: '你刚才已经把这一稿改写过一轮了，现在用户看着**屏幕上这一版**又提了一句要求。'
      + '你的任务是**按这一句话改**，不是重新发挥。\n\n'
      + '这一版是：{what}\n\n'
      + '硬性要求：\n'
      + '1. 只改用户点名那一处，其余原样保留（措辞、顺序、`@参考图1` 这类素材引用标记都不要动）。\n'
      + '2. 用户的话与上一稿冲突时以用户这句为准；他没说的那些不要顺手改，也不要把自己上一轮的想法再补一遍。\n'
      + '3. 这句话里读不出来的细节按最常见的做法补，不要反问。\n'
      + '4. 不要编造品牌、人名、台词或数字；用户给的数字与信息量不要丢。\n\n'
      + '输出：只输出改完之后的整稿本身。不要引号、不要解释、不要说明你改了什么、不要 markdown 代码块、不要给多个方案。',
    story: '你是分镜师。根据一个镜头的描述与时长，决定需要几张关键画面，并按时间顺序给出每一张的文生图提示词。\n\n要求：\n'
      + '1. 只返回 JSON，不要任何解释、不要 markdown 代码块。格式：{"frames":[{"t":0,"prompt":"画面提示词"}]}\n'
      + '2. 3–6 张；t 从 0 开始递增、不超过镜头时长、间隔尽量均匀。\n'
      + '3. 每条 prompt 写清主体、动作、构图、光线、氛围。\n'
      + '4. 不写镜头运动（推拉摇移由程序统一加，写了会打架）。\n'
      + '5. 不编造人物姓名与品牌。',
    /* 「项目引用规则」= 这份 Skill 正文里的**变量占位符**（`{cast}` `{what}` …）：
       程序在发请求前按当前项目把实际内容填进去（`window.TplVars.fill`）。
       填不上的**原样留着** —— AI 看到 `{cast}` 三个字也知道那是要它自己补的位子。
       ⚠ 这与提示词正文里的 `@素材` 引用是两件事：
         · `@名字` —— 给**生成模型**的引用（挂参考图，提交前换成 `@参考图N`）；
         · `{变量}` —— 给**写稿的 AI** 的项目资料（这一份角色名单长什么样）。
       下面这几段里的 `{…}` 就是变量；skills 目录里那份 SKILL.md 与这里**必须逐字相同**
       （判据 tests/e2e/smoke.cjs 的「内置 Skill 正文与 TextAI.DEF 漂开了」守着）。 */
    split: '你是分镜师。把剧本或文案拆成「场景 → 镜头」，并给出适合视频生成的镜头提示词。\n\n'
      + '**这一份 Skill 能用到的项目资料（程序按当前项目填好；填不上时那一句会原样留在这里，你照着上面的剧本自己补）：**\n\n'
      + '本项目素材库里的角色 / 场景 / 物品（名字、外貌、已定的音色）：\n{cast}\n\n'
      + '这一次选中的素材（可以直接 @ 引用）：\n{assets}\n\n'
      + '要拆的正文：\n{what}\n\n'
      + '现有分镜清单（往下拆时是接着它往后写）：\n{board}\n\n'
      + '每镜时长可以取的范围：\n{dur}\n\n'
      + '要求：\n'
      + '1. 只返回 JSON，不要任何解释、不要 markdown 代码块。格式：\n'
      + '   {"title":"短片名","scenes":[{"name":"场景 1","shots":[{"prompt":"镜头提示词","duration":5,'
      + '"name":"镜头短名","note":"一句画面说明","line":"这一镜要念的台词","speaker":"说这句话的角色名","chain":"tail"}]}]}\n'
      + '2. 场景名简短（不超过 8 个字）；镜头时长按**上面给的时长范围**给整数，并按原文信息量分配'
      + '（没给范围就自己按内容定，几秒都能）。\n'
      + '3. prompt 写清主体、动作、场景、镜头运动、光线、氛围；**已经在上面的角色名单里的人物就照那份外貌写，不要另编一个样子**（前后一致靠的就是这一步）。\n'
      + '4. `name` 是给这一镜起的人看得懂的短名（不超过 12 个字，起不出就留空字符串）；'
      + '`note` 是这一镜的画面说明，**整句写出来**，程序不会拿它当名字、也不会截断它。\n'
      + '5. `line` 只放剧本里这一镜**本来就有**的对白，逐字照抄（不改写、不润色、不补全）；'
      + '这一镜没有对白就留空字符串。台词不许自己编，也不要塞进 prompt 里 —— 它是要单独合成语音的一句话，'
      + '与画面描述是两件事。\n'
      + '6. `speaker` 写说这句话的角色名，照剧本里的叫法（没有名字就写「旁白」）；没有对白就留空字符串。'
      + '它决定这句配音取素材库里哪一位的音色，不要编造剧本里没有的名字。\n'
      + '7. 原文的信息点要全部覆盖，不要合并成一句长镜头。\n'
      + '8. 时长范围已经给在上面，不用自己数；镜数由你按内容定。\n'
      + '9. `chain` 只在「这一镜的画面必须紧接着上一镜落幅往下演」时才写 "tail"（第 1 镜永远不写）；'
      + '其余镜头留空字符串。写了它的镜头生成时会自动取上一镜的尾帧当首帧，所以这一镜的 prompt 从**落幅之后**写起，'
      + '不要再把上一镜已经拍过的画面重复描述一遍。长镜头由程序按型号上限自动拆成接续段，你不用自己拆。',
    /* 导演台「拆分镜 → 修改现有分镜」：在**已经排好的**分镜上改 —— 改提示词 / 名字 / 时长 / 台词、
       加新镜头、开新场景、删镜头、调顺序。与 split 的分家：split 从剧本现拆一份全新的，这一条对着
       带序号的既有清单下刀，所以「按序号定位、只带改动、不许重新编号」是它的命门。
       消息里由页面附上当前分镜清单（`boardListText` 画的那份编号）与用户那句要求。
       delete / move 是后补的两条：删掉的后果（撤单、成片少一段）由页面在写入时兜，
       还在生成的那一条页面会拒绝删并照实报数 —— 所以这里不必给 AI 解释代价。 */
    board_edit: '你是分镜师。用户手里已经有一份排好的分镜，现在要你**在它上面改**：改写提示词、改镜头名 / 时长 / 台词、'
      + '在中间加镜头、删掉镜头、调整镜头顺序、或开一个新场景。\n\n'
      + '**这一份 Skill 能用到的项目资料（程序按当前项目填好；填不上时那一句会原样留在这里，你照着上面的清单自己补）：**\n\n'
      + '当前分镜清单（场景 / 镜头都按从 1 开始的序号编好，每条带时长与提示词；空提示词写着「还没写」，'
      + '有对白的镜头会多出一段「台词（角色名）：…」）：\n{board}\n\n'
      + '本项目素材库里的角色 / 场景 / 物品（名字、外貌、已定的音色）：\n{cast}\n\n'
      + '这一次选中的素材（可以直接 @ 引用）：\n{assets}\n\n'
      + '用户这一次的修改要求（也可能什么都不说 —— 那就是把写得不够好的提示词整体优化一遍）：\n{what}\n\n'
      + '每镜时长可以取的范围：\n{dur}\n\n'
      + '要求：\n'
      + '1. 只返回 JSON，不要任何解释、不要 markdown 代码块。格式：\n'
      + '   {"changes":[{"action":"update","scene":1,"shot":2,"prompt":"改后的提示词","name":"镜头名（可选）","duration":5,"line":"改后的台词","speaker":"说这句话的角色名","chain":"tail"},'
      + '{"action":"insert","scene":1,"after":2,"prompt":"新镜头提示词","duration":4,"line":"这一镜的台词（没有就不写）","speaker":"角色名（没有对白就不写）","chain":"tail"},'
      + '{"action":"insert","newScene":"新场景名","prompt":"新场景的第一个镜头","duration":4},'
      + '{"action":"delete","scene":1,"shot":3},'
      + '{"action":"move","scene":1,"shot":4,"after":1}]}\n'
      + '2. scene / shot / after 都照清单里的序号数（从 1 开始）；不要重新编号、不要搬动清单里没提到的镜头。\n'
      + '3. update 改一个已有镜头：prompt / name / duration / line **只带真的要改的字段**，没改的不要原样抄一遍；'
      + 'prompt 写**完整的新提示词**本身（不是只写改动的几个词）；line 要清掉这一镜的台词就写成空字符串。\n'
      + '4. insert 加新镜头：after=2 表示插在第 2 镜之后；after=0 表示插在这一场的开头；不写 after 表示加在这一场末尾。\n'
      + '5. delete 删掉那一镜（不要理由，也不要顺手删别的）；move 把 shot 指的那一镜挪到 after 那一镜之后，'
      + 'after=0 表示挪到这一场的开头 —— 它只改顺序，提示词与时长一个字都不动。\n'
      + '6. 要开新场景就写 newScene（场景名不超过 8 个字）；与清单里已有场景重名时会被并进那一场，不用你合并。\n'
      + '7. 提示词里的 @参考图1、@角色名 这类素材引用标记必须**原样保留**，不能改写、不能删。\n'
      + '8. 只在用户要的地方动手：说优化就把提示词写得更具体，说加镜头就顺着前后镜头的画面往下接；不要顺手改别的镜头。\n'
      + '9. 提示词写清主体、动作、场景、镜头运动、光线、氛围；**已经在上面角色名单里的人物就照那份外貌写，不要另编一个样子**（前后一致靠的就是这一步）；'
      + '要改时长就给**上面给的时长范围**内的整数（没给范围就是本机没有可校验的声明，别动时长）。\n'
      + '10. 台词（line）只放剧本或用户那句话里**本来就有**的句子，逐字照抄；没有对白就留空字符串，不要自己编，'
      + '也不要把它写进 prompt —— 它是要单独合成语音的一句话，与画面描述是两件事。'
      + '有台词时 speaker 写说这句话的角色名（照清单里的叫法，没有名字写「旁白」）；要清掉台词就把 line 与 speaker 都写成空字符串。\n'
      + '11. `chain` 只在「这一镜的画面必须紧接着上一镜落幅往下演」时才写 "tail"（第 1 镜永远不写）；'
      + '清单里已经标着「接上一镜」的镜头不要再抄一遍；要取消接续就写空字符串。'
      + '长镜头由程序按型号上限自动拆成接续段并自动标好，你不用自己拆，也不要把上一镜的画面在下一镜里重复描述一遍。\n\n'
      + '只输出 JSON。',
    /* 拆分镜的第 4 段：判断这份方案里有没有「该新建一条素材」的角色/场景/物品。
       与 split / board_edit 的分家：那两条**出分镜**，这一条**只出素材建议**（不改镜头）。
       判据（重复出现才算、名字要对得上、库里已有的不建）在 web/director/board-assets.js。 */
    board_assets: '你是美术指导。下面这一份分镜方案来了，你要判断：**这份方案里有没有「应当新建一条素材」的角色、场景或物品**。\n\n'
      + '「素材」指的是素材库里的一条档：角色（有人物形象与音色）、场景（一张定场图）、物品（道具）。'
      + '分镜正文里用 `@名字` 引用它们，程序会把它们的图挂成参考图 —— 所以同一个角色在整部片子里必须引用**同一条**素材，'
      + '人物与场景才能前后一致。\n\n'
      + '**这一份 Skill 能用到的项目资料（程序按当前项目填好；填不上时那一句会原样留在这里）：**\n\n'
      + '这一份分镜方案（判断「谁反复出现」就看它）：\n{board}\n\n'
      + '素材库里已经有的那些（已经有的**不要**报 —— 直接引用它就行）：\n{cast}\n\n'
      + '这一次选中的素材：\n{assets}\n\n'
      + '判据：\n\n'
      + '1. **只返回 JSON**，不要解释、不要 markdown 代码块。格式：\n'
      + '   {"newAssets":[{"name":"小雅","kind":"actor","why":"她在第 3、7、11 镜反复出现",'
      + '"look":"短发少女，灰色卫衣，左耳一颗痣","voice":"年轻女声，清亮偏慢，尾音略上扬"}]}\n'
      + '2. `name` 用**正文里出现的那个名字**（逐字照抄，不要改名、不要合并、不要发明）。'
      + '`kind` 只能是 `actor`（角色）/ `scene`（场景）/ `prop`（物品）。\n'
      + '3. **只报会反复出现的主体**（在多个镜头里出现）。只出现一次的路人、一次性背景不要报。\n'
      + '4. **不要报素材库里已经有的**（上面那份名单里有的就是已经有的）—— 已经有的直接引用，不用新建。\n'
      + '5. `why` 一句话说明「为什么值得建档」（在第几镜反复出现、承担什么作用）。\n'
      + '6. `look` 写**能直接拿去出图**的外貌描述：性别、大致年龄、发型、服装、显著特征、气质。'
      + '场景写环境与光线时段；物品写材质、颜色、年代感与使用痕迹。\n'
      + '7. `voice` 只给**角色**写（场景与物品留空）：一段 30~80 字的音色描述，说清性别与大致年龄、音质（清亮/沙哑/鼻音重）、'
      + '语速、情绪底子、说话习惯，并且**从这个人的人设与外貌推出来** —— 六十岁的老太太和二十岁的程序员不能是同一条描述。\n'
      + '8. 同一份方案里的不同主体，描述要能互相区分开。\n'
      + '9. **不要**把台词内容写进 `look` 或 `voice`。\n'
      + '10. 判定不出来就返回 `{"newAssets":[]}`，不要凑数。\n\n'
      + '只输出 JSON。',
    /* 生成工作台图像栏「拆分片段批量生成」：一段描述 → 几张各自独立成片的图片提示词。
       与 story（导演台关键帧）的区别：没有镜头时长概念，每张都是一张完整的图，
       拆分维度（时间 / 场景 / 动作阶段）由用户在页面上定，不是按秒切片。 */
    img_split: '你是美术分镜师。把一段画面描述拆成几张**各自独立成片**的图片提示词（每张都是一张完整的图，不是连环画里的格子）。\n\n要求：\n'
      + '1. 只返回 JSON，不要任何解释、不要 markdown 代码块。格式：{"frames":[{"label":"片段名（6 个字以内）","prompt":"画面提示词"}]}\n'
      + '2. 张数与拆分维度以用户给的为准；用户没指定时按内容复杂度定 2–6 张，选最自然的维度拆（时间先后 / 场景变化 / 动作或状态阶段）。\n'
      + '3. 每条 prompt 自成一体：写清主体、动作或状态、场景、构图、光线、氛围，不看其他片段也能直接用。\n'
      + '4. 几张之间主体与画风保持一致（同人、同景、同色调），只有拆分维度在变。\n'
      + '5. 消息里附了参考图时，主体长相与画风以参考图为准，别用文字复述画面细节。\n'
      + '6. 不编造人物姓名与品牌。\n\n'
      + '只输出 JSON。',
    /* ---- 素材库（chars.js）出图与配音用的两条指令 ----
       花括号 {xxx} 是本项目的占位符，由 chars.js 在提交前替换成当次的事实（画幅、外貌、角色清单…）；
       改指令时占位符可以挪位置、可以删，但别改成别的名字 —— 程序只认这一套。
       2026-10 拍短剧页删除：这一族原有 13 条，现在只剩下面两条 —— 素材库出图（char_image）
       与角色定音色（char_voice）。拆剧本 / 道具图 / 视频提示词 / 开头画面 / 细分镜头 /
       一句话改写 / 机位候选 / 设定补写那几条跟着拍短剧页一起删了。
       键名由 drama_ 改成 char_ 前缀：用户在设置页改过的文案存在 sk_polish_drama_image / _voice，
       搬运由 ui.js 的 migrateRenamedKeys() 一次性做完（连 .data 里那份镜像一起）。 */
    char_image: '你是美术设定师，为下面这一张图写出**文生图模型能直接吃的高质量中文提示词**。\n\n'
      + '这一张是：{what}\n'
      + '角色/场景：{name}\n'
      + '外貌或环境设定：{look}\n'
      + '整集画风取向：{style}\n'
      + '画幅：{ar}\n\n'
      + '硬性要求：\n'
      + '1. 按「主体 → 状态或动作 → 构图（景别/机位/背景）→ 光线与色调 → 风格与媒介 → 细节」组织成一段连贯中文。\n'
      + '2. 严格沿用上面的设定，不要替换人物、不要新增人物、不要改服装；设定里没写的细节可以自己补，但要常见且不抢戏。\n'
      + '3. 画风格落到具体流派与光线，不要只写「高级感」「有质感」。\n'
      + '4. 这一张里只会有一个人（或一个人都没有）；**不要顺手加路人、手、镜子里的第二个人**。\n'
      + '5. 结尾必须带上：无文字、无水印、无字幕。\n\n'
      + '只输出提示词本身，不要标题、引号、编号或解释。',
    /* 道具图**单独一条指令**（2026-10）：道具与角色/场景的画法不一样 ——
       要的是「一件物品的完整陈列」，提示词里写一句「不要人物/不要手/不要环境」就够，
       混在 char_image 的 {what} 里等于把这一条铁律交给调用方每次现写，
       少写一次道具图上就多出一个人，而它是要整集每段当参考图发出去的。 */
    char_voice: '你是素材库的配音导演。下面这一集的角色清单来了，你要**逐位**决定：这一位的声音从哪里来，'
      + '并把要用的东西写出来。\n\n'
      + '这家语音平台能提供的定音色方式（只能从这里选，写别的方式发不出去）：\n{ways}\n\n'
      + '可选的预设音色清单（way="preset" 时 voice 必须**一字不差**地用下面某一行的 id）：\n{preset}\n\n'
      + '本集角色：\n{cast}\n\n'
      + '硬性要求：\n'
      + '1. 每位角色一条，name 照抄清单里的名字（不要改名、不要合并、不要新增角色）。\n'
      + '2. way 的取舍：角色那一行写了「已经有本人的参考音频」→ 用 "clone"（复刻本人的嗓子，别另造）；\n'
      + '其余出镜角色一律用 "design"（按人设造一条新嗓子，人物之间才有区别）；\n'
      + '**只有这家平台完全没有 design 方式时**才允许退到 "preset"，从上面那份清单里挑最贴性格的一个。\n'
      + 'preset 是最后一档 —— 那一排嗓子是全平台共用的，谁挑都一样，不符合「每个人声音不同」这件事。\n'
      + '3. way="design" 时必须写 note：一段 30~80 字的**音色描述**，说清性别与大致年龄、音质（清亮/沙哑/鼻音重）、'
      + '语速、情绪底子、说话习惯（爱叹气、尾音上扬、咬字硬），并且要**从这个人的人设和外貌推出来** —— '
      + '六十岁的老太太和二十岁的程序员不能是同一条描述。\n'
      + '4. **同一条里不能出现两个角色**；不同角色的 note 要能听出区别，别所有人都写「温和的女声」。\n'
      + '5. 旁白（只出声的）：note 写成适合念白的那种（稳、吐字清楚、不抢戏）。\n'
      + '6. way="preset" 时必须写 voice（清单里的 id），note 可省；way="clone" 时 voice 和 note 都留空。\n\n'
      + '禁止：不要解释、不要 markdown 代码块、不要输出 JSON 以外的任何字符；'
      + '不要编造清单里没有的音色 id；不要改动角色的性格与外貌设定。\n\n'
      + '只输出 JSON，格式：\n'
      + '{"roles":[{"name":"角色名","way":"clone|design|preset","voice":"预设清单里的 id，或空",'
      + '"note":"音色描述，或空"}]}',

  },
  /* ---------- 提示词的分类表（2026-10） ----------
     设置页「提示词润色」那张卡**按这张表画**：分类标题、每条的名称、它用在哪、占位符说明全在这里。
     以前那 11 条是设置页里写死的 11 个 `.polish-block`（外加保存 / 读取 / 恢复默认三处各抄一遍键名），
     加一条指令要改四个地方，漏一处就是「设置页列出来了、存盘没存上」或者反过来。
     格式：反引号包起来的会渲染成 <code>，其余按纯文本转义。 */
  PROMPTS: [
    { id: 'gen', name: '通用润色（生成工作台 / 导演台）',
      note: '这几条是用户点「AI 润色」时用的，改它们影响所有页面。',
      items: [
        { key: 'video', label: '视频提示词润色', used: '生成工作台「视频」那一栏的「AI 润色」 · 导演台右栏「AI 润色提示词」',
          ref: '这一条按 **MiniMax H3 官方手册**的公式写：`完整提示词 = 参考素材说明 + 核心创意 + 画面过程说明`。'
            + '改它时建议保留这几条 —— 它们都来自那份手册点名的常见失败模式：运镜写具体动作（`truck left + pan right`）而不是「环绕运镜」；'
            + '要一镜到底必须明说（不说模型会自己切镜）；画面内文字与台词逐字写出；不要 BGM 就别自相矛盾。'
            + '`@参考图1` / `@角色名` 这类素材引用标记必须原样保留（导演台提交时会把它们换成平台的引用语法）。' },
        { key: 'img', label: '图片提示词润色', used: '图片工作台「AI 润色」',
          ref: '这一条按通行的图片提示词公式写：`用途 → 主体 → 环境 → 构图 → 光线 → 风格与媒介 → 色彩与材质 → 画幅与限制`。'
            + '改它时建议保留这三条最常见的坑：一次只选一种视觉语言（同时写「超写实」和「卡通」模型只会取折中）、'
            + '光线不能省（影响最大的单项）、构图不能省（不写只会给居中中景的安全构图）。' },
        { key: 'audio', label: '配音稿润色', used: '生成工作台「语音」那一栏的「AI 润色」' },
        { key: 'follow', label: '再改一版（润色结果出来之后接着对话）',
          used: '三个工作台与导演台：润色结果面板下面那一行「还要怎么改」，写完按回车就按这句话在当前那一版上再改',
          ref: '这一条不改写整稿的思路，只按用户那一句改，所以「其余原样保留」与「不要反问」两条请留着 —— '
            + '少了第一条，用户说一句「短一点」模型会把风格也一起换掉；少了第二条，这一轮又会开始追问，'
            + '而面板上根本没有再答题的地方（它不在会反问的那三条里）。占位符：`{what}` 这一版是什么稿子。' },
        { key: 'story', label: '分镜切片规划（决定张数 + 每张提示词）', used: '导演台右栏「按描述生成这一镜的画面」',
          ref: '要求文字 AI `只返回 JSON`（`{"frames":[{"t":0,"prompt":"…"}]}`），由它决定生成几张、每张在第几秒、每张画什么。改这条时请保留 JSON 格式要求，否则会退化成按 2.5 秒硬切片。' },
        { key: 'split', label: '剧本拆分镜', used: '导演台「拆分镜」→ 任务「拆一份新的 / 接着往下拆」',
          ref: '要求文字 AI `只返回 JSON`（`{"title":"…","scenes":[{"name":"场景 1","shots":[{"prompt":"…","duration":5}]}]}`）；末尾会由程序自动补上「镜头数 / 每镜时长」两条约束。改这条时请保留 JSON 格式要求。' },
        { key: 'board_edit', label: '修改现有分镜（改 / 加镜头、优化提示词）', used: '导演台「拆分镜」→ 任务选「修改现有分镜」',
          ref: '要求文字 AI `只返回 JSON`（`{"changes":[{"action":"update","scene":1,"shot":2,"prompt":"…"},{"action":"insert","scene":1,"after":2,"prompt":"…"},{"action":"insert","newScene":"新场景名","prompt":"…"}]}`）；消息里会附上按序号编好的当前分镜清单，AI 按 `scene`/`shot`/`after` 的序号改与插。改这条时请保留 JSON 格式要求与「只带真的要改的字段」那一条 —— 程序按序号定位，对不上号的会整条丢掉并计数。' },
        { key: 'img_split', label: '图片片段拆分（一段描述 → 几张图的提示词）', used: '生成工作台「图像」栏「拆分片段生成」',
          ref: '要求文字 AI `只返回 JSON`（`{"frames":[{"label":"片段名","prompt":"…"}]}`）。改这条时请保留 JSON 格式要求，否则拆分会直接报「没有给出可用的拆分方案」。' },
      ] },
    { id: 'charpic', name: '素材库 · 出图',
      note: '素材库的预览图与各类设定图出图前，先由文字 AI 把设定写成高质量提示词，再交给图片 AI。',
      items: [
        { key: 'char_image', label: '角色脸 / 三视图 / 场景图提示词', used: '素材库页画预览图、角色资产（三视图 / 表情 / 服装 / 道具）',
          ref: '占位符：`{what}` 要画什么（角色定妆照 / 三视图 / 空场景图）、`{name}` 角色或场景名、`{look}` 外貌与环境设定、`{style}` 这一段画风、`{ar}` 画幅。\n键名由 drama_ 改成 char_（2026-10），旧键由 ui.js 的 migrateRenamedKeys() 一次性搬过去。' },
      ] },
    { id: 'voice', name: '素材库 · 声音',
      note: '这一条决定「谁怎么出声」：它逐位决定每位角色的声音从哪里来。',
      items: [
        { key: 'char_voice', label: '给每位角色定音色', used: '素材库页「✧ 让 AI 给角色定声音」与「画完就给他定声音」',
          ref: '`{ways}` = 这一家语音平台真能用的定音色方式（预设 / 声音描述 / 参考音频复刻），`{preset}` = 平台声明的预设音色清单（`id｜名字 · 语言 · 性别`），`{cast}` = 这一次要定声音的角色清单（人设、外貌、有没有本人的参考音频）。\n要求文字 AI `只返回 JSON`（`{"roles":[{"name":"…","way":"preset|design|clone","voice":"…","note":"…"}]}`），改这条时请保留 JSON 格式要求：程序按 `name` 对上角色、按 `way` 挑对应型号，音色 id 只认清单里真有的那一些（编一个 id 平台不认，要到配音时才报错）。\n键名同样由 drama_ 改成 char_，旧键由 migrateRenamedKeys() 搬过去。' },
      ] },
  ],
  /* 取「用户改过的，没有就用内置默认」——页面与设置页共用这一份。
     askNote=true 时把「补充信息」那段也接上（只有会反问的三条润色指令要）。 */
  /* 这些指令是「一次把活干完」的（缺的信息由指令自己补全），
     接上「可以反问」只会让模型把输出变成问题，所以显式排除。
     **story / split / board_edit 也在这一列里**（导演台那三条）：它们要的是 JSON / 结构化分镜，
     页面拿 `parseJsonLoose` / `parseFrames` 去解 —— 模型一旦先反问，解出来就是空，
     界面报「AI 没有给出可用的分镜结构」。而设置页把 `prompt('story')` 的结果**整段写回**
     `sk_polish_story`（那是用户在设置页里能改的那一栏），只要 ASK_NOTE 被拼上去，
     下一次进设置页改动任何一项，那趟自动保存的整页 DOM 扫描会把它连 ASK_NOTE 一起写回盘上，
     导演台读到的就是带着「你可以追问」的指令。 */
  NO_ASK: ['char_image', 'char_voice', 'story', 'split', 'board_edit', 'img_split', 'follow'],
  /* 「没有存盘时这条指令应该长什么样」——**只算默认，绝不碰存盘**。
     两处共用这一份，免得各算一遍：
       · prompt()：没有存盘就返回它（用户改过的优先）
       · 设置页：textarea 初始化成它，保存时拿它当「要不要真的存盘」的判据
     加它的理由是一个反复咬人的坑：设置页那个输入框**初始化时就是默认值**，
     而保存那一步以前把 `el.value` 原样写进 sk_polish_<kind>。于是「打开设置页点一次保存」
     就把默认**盖死**成存盘副本 —— 以后再改 TextAI.DEF，这台机器永远读不到新默认。
     本项目已经被咬过一次（story / split 被拼上「补充信息」，只能靠 stripAskNote 逐条打补丁），
     2026-10 修「指令里写死人称」时又发现：修好的默认对已经存过盘的用户一条都不生效。 */
  /* 「这一条指令由哪份 Skill 提供」—— contract 是唯一身份。
     正文由 web/ui/skills.js 在启动时按已启用的 Skill 备进 window.__skillBodies；
     没备到（旧页面 / 刚装好还没刷新）就退回下面 DEF 的同源副本，行为不变。 */
  SKILL_CONTRACT: {
    video: 'polish.video', img: 'polish.image', audio: 'polish.voice', follow: 'polish.follow',
    story: 'story.json', split: 'split.json', board_edit: 'board_edit.json', img_split: 'img_split.json',
    char_image: 'char.image.json', char_voice: 'char.voice.json',
    /* 拆分镜那一条「判断哪些新角色/场景/物品要建档并出图」的指令。 */
    board_assets: 'board_assets.json',
  },
  skillBody(kind) {
    const c = this.SKILL_CONTRACT[kind];
    const all = (typeof window !== 'undefined' && window.__skillBodies) || null;
    if (!c || !all || !all[c]) return '';
    /* SKILL.md 的第一行标题是给人和清单看的，不是提示词正文；末尾空白也去掉，
       这样「同一份 DEF 生成的 Skill」与 DEF 逐字节相同，历史默认副本仍能被 prune 认出来。 */
    return String(all[c]).replace(/^\s*#\s+[^\n]*\r?\n+/, '').replace(/^\n+/, '').replace(/\s+$/, '');
  },
  defaultPrompt(kind, askNote) {
    const raw = this.skillBody(kind) || this.DEF[kind] || '';
    if (this.NO_ASK.indexOf(kind) >= 0) return this.stripAskNote(raw);
    const note = (askNote === false || !this.DEF.ASK_NOTE) ? '' : this.DEF.ASK_NOTE;
    if (!note || raw.indexOf('补充信息') >= 0) return raw;      // 默认自己已经写了就不重复追加
    return raw + '\n\n' + note;
  },
  prompt(kind, askNote) {
    const stored = window.LS.get(this.promptKey(kind));
    /* NO_ASK 那几条还要**摘掉尾部那段追问说明**：story / split 以前不在名单里，
       设置页一保存就把 ASK_NOTE 整段写进了 sk_polish_story / sk_polish_split ——
       加进 NO_ASK 只管得住「以后不再拼」，已经被污染的那一份还在用户机器上，
       下一次读出来照样带着「你可以追问」，而这两条要的是 JSON（见上面那段注释）。 */
    if (stored) return this.NO_ASK.indexOf(kind) >= 0 ? this.stripAskNote(stored) : stored;
    return this.defaultPrompt(kind, askNote);
  },
  /* 一次性收拾「存盘副本其实就是默认」的那些键。
     判据只有一条：**与当前默认逐字节相同**。人手敲不出这样一份一模一样的东西 ——
     它只可能是「打开设置页点一次保存」固化下来的，所以删掉它不可能碰到用户真写的内容。
     用户改过一个字的（哪怕只多一个标点）一律原样保留，删默认等于替他改回去。
     每次页面加载都跑一遍（只有 PROMPTS 那十几条、纯 localStorage 读，可忽略不计），
     以后再有人改 DEF，这一段就自动把「与新默认相同」的旧副本清掉，不用再逐条打补丁。 */
  pruneStoredDefaults() {
    let n = 0;
    for (const g of (this.PROMPTS || [])) {
      for (const it of ((g.items || []))) {
        const key = this.promptKey(it.key);
        const v = window.LS.get(key);
        if (v && v === this.defaultPrompt(it.key)) { window.LS.del(key); n++; }
      }
    }
    return n;
  },
  /* 只摘**结尾**那一段（我们自动拼的位置）；用户在中间自己写的同样文字不动。 */
  stripAskNote(v) {
    const s = String(v || ''), note = String(this.DEF.ASK_NOTE || '');
    if (!note || !s.endsWith(note)) return s;
    return s.slice(0, -note.length).replace(/\s+$/, '');
  },
  promptKey(kind) { return 'sk_polish_' + kind; },
  /* 旧版设置页手改过的那几条 `sk_polish_*` 现在没有编辑入口了（提示词以 Skill 为准），
     但**不静默删**：用户改过的文字仍然是他的东西。要回到 Skill 正文，由设置页那颗按钮显式清。 */
  clearManualPrompts() {
    let n = 0;
    for (const g of (this.PROMPTS || [])) {
      for (const it of ((g.items || []))) {
        const key = this.promptKey(it.key);
        try { if (localStorage.getItem(key) != null) { localStorage.removeItem(key); n++; } } catch (e) {}
      }
    }
    return n;
  },
  /* 供应方（多家并存，默认 OpenRouter）：
     文字 AI 以前只有 DeepSeek 一条，基址还写死在客户端（sk_base_deepseek）。现在每家都是
     registry 里一条正常的 provider（relay / base / keyEnv / models 各自独立），
     用哪一家由设置页选（sk_text_prov 存 provider id），密钥/基址/型号都按 keyId 各自存。
     没显式选过的：优先「默认供应方」，但它得真的能用（本机有密钥，或服务端 .env 配了），
     否则退到下一家有密钥的 —— 光换默认就把原来能用的润色弄坏，是不能接受的。 */
  all(REG) { return ((REG && REG.providers) || []).filter(p => p.kind === 'text'); },
  provKey() { return 'sk_text_prov'; },
  savedProv(REG) {
    const want = window.LS.get(this.provKey());
    if (!want) return null;
    const list = this.all(REG);
    return list.find(p => p.id === want) || list.find(p => (p.keyId || p.id) === want) || null;
  },
  /* 「能用」= 本机填了密钥，或服务端 .env 配了（_envIds 由 warm() 从 /env-status 读，60 秒缓存）。
     读 /env-status 而不是让代理往 /registry 里塞标记：registry 是同源可读但也允许跨站读的，
     往里加「这台机器有没有某平台的密钥」等于往外报配置。 */
  usable(prov) {
    if (!prov) return false;
    if (this.key(prov)) return true;
    return !!(this._envIds && this._envIds[this.keyId(prov)]);
  },
  prov(REG) {
    const list = this.all(REG);
    if (!list.length) return null;
    const saved = this.savedProv(REG);
    if (saved) return saved;
    const def = list.find(p => p.default && this.usable(p));
    if (def) return def;
    return list.find(p => this.usable(p)) || list[0];
  },
  async warm(REG) {
    /* 先看缓存：60 秒内的结果直接用，不要每次都发一次 /env-status。
       以前是先取、再判缓存 —— 判到缓存就把刚取回的结果丢掉，等于白跑一个请求，
       而且 _envIds 只在未命中那条路上重建（缓存命中时环境密钥变了也不会被发现）。 */
    const now = Date.now();
    if (this._envCache && now - this._envCache.ts < 60000) return this._envCache.data;
    try {
      const d = await netFetch('/env-status', { timeout: 8000 }).then(r => r.json());
      this._envCache = { ts: now, data: d || {} };
      this._envIds = {};
      Object.keys(d || {}).forEach(k => { if (d[k] && d[k].hasEnv) this._envIds[k] = true; });
      return d || {};
    } catch { return this._envCache ? this._envCache.data : {}; }
  },
  keyId(prov) { return (prov && (prov.keyId || prov.id)) || 'deepseek'; },
  /* 内存覆盖表（按 keyId）：设置页「获取型号列表 / 验证密钥 / 测试」这三个按钮要用**刚填还没落盘**
     的密钥与地址发一次请求。以前它们为了这件事直接写 localStorage（`sk_key_*` / `sk_base_*`），
     等于把用户填到一半的一把钥匙当成一次有效配置存进盘里 —— 用户填一半切走，盘上留下的是半成品。
     现在只把值放进这份表里，发完请求（或离开设置页）就清掉，磁盘上始终是改完（change）之后自动存的那份。 */
  formOverride: {},
  setFormOverride(prov, vals) {
    const k = this.keyId(prov);
    if (vals) this.formOverride[k] = vals; else delete this.formOverride[k];
    return this.formOverride[k] || null;
  },
  key(prov) {
    const o = this.formOverride[this.keyId(prov)];
    if (o && o.key) return o.key;
    return window.LS.get('sk_key_' + this.keyId(prov)) || '';
  },
  /* 自定义基址：按供应方各存各的（sk_base_<keyId>）；没填就用 registry 里的地址。
     有值时以 x-up-base 头临时换基址，所以「常用接口预设」对任何一家都照样能用。
     **自定义供应商不走这一条**：那一家的地址本来就是用户自己在 sk_custom 里填的，
     没有「官方地址 + 临时覆盖」这回事；代理那边也把它建条目的 baseEditable 摘了（不认这个头）。
     所以这里必须跟着返回空 —— 否则界面上填了地址、请求里带了头、代理却照原样转发，
     成了「界面说改了，其实没改」。 */
  base(prov) {
    if (prov && prov.custom) return '';
    const o = this.formOverride[this.keyId(prov)];
    if (o && o.base) return o.base;
    return window.LS.get('sk_base_' + this.keyId(prov)) || '';
  },
  /* 这个自定义地址是不是**另一家**的？
     地址是按供应方各存各的（`sk_base_<keyId>`），但用户很容易在「供应方 = DeepSeek」时
     把 OpenRouter 的地址填进去 —— 于是请求带着 **DeepSeek 的密钥**打到 OpenRouter，
     上游回一句「Your api key ****xxxx is invalid」，而界面上看着像「我明明选了 OpenRouter 啊」。
     查法：这个地址的 host 是不是 registry 里**别的**供应方的 base host。 */
  /* 判据只有一份（Api.hostOwner，比对的是**全平台**的地址）：这里留旧入口名给设置页与测试用。
     以前只比文字 AI 那几家，生成平台也能填自定义地址后就变成两份判据 —— 同一串地址在文字 AI 里报警、
     在生图平台里不报，那种「到底哪家会被串密钥」的差别没人能解释。 */
  baseOwner(REG, base, prov) { return Api.hostOwner(REG, base, prov); },
  /* ---- 模型：接口列表 / **用户自己填的型号** 两者合并 ----
     「自己添加型号」是硬要求：OpenRouter 这类聚合平台有几百个型号，/models 一次全拉回来
     未必顺滑，而用户手上往往就认准一两个写法。所以自己填的型号永远出现在下拉里，
     不依赖 /models 有没有列它。
     **存法在 v13 起换了地方**：不再是每家一个 `sk_text_models_<keyId>`，而是并进
     `ModelPrefs` 那一份 `sk_model_prefs`（同一个概念的两件事 —— 「自己填了什么」与
     「哪一个被隐藏」—— 拆成两个键迟早对不上）。下面这三颗只是旧的调用名，判据与落盘都在 ModelPrefs 里。 */
  /* 「认出这一家了吗」——**单独一处判据**。
     为什么必须单独判：keyId(null) 会兜底成 'deepseek'（早期只有一家文字 AI 时留下的行为），
     于是只要 prov 一旦是 null（注册表还没就绪、代理热重载、刚加的那家还没并进 REG），
     用户在这张卡上自己填的型号就会被写进 **DeepSeek** 的那一份，
     接着 renderCustomModels 又把 DeepSeek 的自填型号原样画到这张卡的芯片区 ——
     表现正是「我填的型号跑到了另一家供应商里」，而且没有任何报错。
     兜底键在「读」上无害（读不到就当没填），在「写」上是有害的，所以写的地方一律先问这一句。
     ModelPrefs.kid 用的是同一条判据（认不出就返回空、什么都不写）。 */
  hasProv(prov) { return !!(prov && (prov.keyId || prov.id)); },
  custom(prov) { return window.ModelPrefs ? window.ModelPrefs.typed(prov) : []; },
  addCustom(prov, id) { return window.ModelPrefs ? window.ModelPrefs.addTyped(prov, id) : []; },
  removeCustom(prov, id) { return window.ModelPrefs ? window.ModelPrefs.removeTyped(prov, id) : []; },
  /* ---- 型号：**完全动态** ----
     下拉里放两类：① 这一家接口返回的（点「获取型号列表」拿到的）② 用户自己填的。
     registry 里声明的那几个「平台内置」**既不展示、也不当内部兜底**（那是一份写死的清单，
     用户看到会以为型号是固定的，切供应方时那几行特别像串台；拿来兜底等于我们替接口猜一个型号发出去）。
     一个型号都没取到时 `model()` 返回空，由请求侧点名让人去点「获取型号列表」。
     **例外：用户自己添加的供应方**（`prov.custom`）—— 它那串型号是他在「添加自定义供应商」里一个个勾出来的，
     属于「他自己声明的这家有什么」，不是我们写死的平台表，所以照实列出来（否则刚加完一家网关、型号下拉是空的，
     还得再点一次「获取型号列表」才能用；`ownsModel` 也认这一份，免得「添加了却不让你保存」）。
     fetchList 必须是**这一家**的接口列表（以前页面里是全局一份，切了供应方还串着上一家的型号）。
     返回 { groups: [{label, ids:[]}], ids: [] }，调用方直接渲染成 <optgroup>（Dropdowns 支持）。 */
  modelGroups(prov, fetchList) {
    const seen = new Set();
    /* 隐藏判据只问 ModelPrefs.isOff 一处。这里必须自己筛一遍：文字 AI 的清单是
       「接口拉回来的 + 自己填的」在页面现拼的，不经过代理那份注册表筛选。 */
    const off = id => !!(window.ModelPrefs && window.ModelPrefs.isOff(prov, id));
    const uniq = ids => ids.map(String).filter(id => { if (!id || seen.has(id) || off(id)) return false; seen.add(id); return true; });
    const prefs = window.ModelPrefs ? ModelPrefs.of(prov) : { typed: [], off: [], got: [] };
    /* 四路并成**同一份**清单。以前这个函数与设置页那张清单各拼各的，各漏一半，于是两头对着干：
         · 下拉只收 fetchList（**页面内存里**的，刷新即空）＋自己填的；
           设置页那张清单却有注册表声明的那几条 → 点它就报「不在下拉的选项里」。
         · 反过来「获取型号列表」取回来的东西只在设置页活着 ——
           AI 助手那张型号下拉（modelGroups(cur)，压根没有 fetchList 这一路）永远看不见。
       现在统一收口到 ModelPrefs：接口给过什么存在 got 里，落盘、跨页面、刷新都在。 */
    const fromApi = uniq(prefs.got.map(m => m.id)
      .concat((fetchList || []).map(m => (m && m.id ? m.id : m))));
    const custom = uniq(this.custom(prov));
    /* 注册表里声明的那一份**只给自定义供应方**列（它那串型号是用户在「添加自定义供应商」里
       一个个勾出来的，属于「他自己声明的这家有什么」）。
       内置的文字供应方一条都不列 —— v16 起代理已经不下发任何文字型号清单（那份写死的
       `models` 全改名 `modelDocs` 了）。所以这一档的清单只有一个来源：它自己的 /models。 */
    const declared = (prov && prov.custom) ? uniq((prov.models || []).map(m => (m && m.id) || m)) : [];
    const groups = [];
    if (fromApi.length) groups.push({ label: '接口返回（' + ((prov && prov.name) || '当前接口') + '）', ids: fromApi });
    if (custom.length) groups.push({ label: '自己添加', ids: custom });
    if (declared.length) groups.push({ label: '添加这一家时勾的型号', ids: declared });
    /* 一个都没取到时，别让已保存的型号凭空消失 —— 单独一组标出来（它可能已下架，也可能是还没点获取）。
       两种原因要分开说：「被自己藏了」和「接口还没取过」是两件事，混成一句会让人去点获取。 */
    const saved = this.model(prov);
    if (saved && !seen.has(saved)) {
      groups.push({ label: off(saved) ? '当前选中（这一型号在设置页被藏起来了）' : '当前选中（这家接口还没取过列表）', ids: [saved] });
    }
    return { groups, ids: groups.reduce((a, x) => a.concat(x.ids), []) };
  },
  /* 这个型号是不是属于这一家？（设置页守门用：切了供应方却把上一家的型号存/发出去，就是错配） */
  ownsModel(prov, id, fetchList) {
    const s = String(id || '').trim();
    if (!s) return false;
    return this.modelGroups(prov, fetchList).ids.indexOf(s) >= 0;
  },
  /* 选中的模型：**只认从这一家接口动态取到的那一批，或用户自己填的**（当前选中存 sk_model_<keyId>）。
     **不再拿 registry 写死的型号顶上去** —— 以前兜底是 prov.models[0] 再兜到 'deepseek-chat'，
     于是从没点过「获取型号列表」的那一家也能被塞一个型号出去：发出去的是我们猜的，
     界面看着一切正常，能不能用要等上游报错才知道。型号完全由接口动态获取，
     没取到就是没有，由 _body() 抛一句「去点获取型号列表」。
     **认不出供应方时同样返回空**：modelGroups 会拿它填「当前选中」那一组，
     而 keyId(null) 兜底成 'deepseek' —— 于是别家保存的型号会出现在这张卡的下拉里
     （同一个坑，第二个入口）。 */
  model(prov) {
    if (!this.hasProv(prov)) return '';
    const saved = window.LS.get('sk_model_' + this.keyId(prov));
    if (saved) return saved;
    return this.custom(prov)[0] || '';
  },
  /* ---- 识图（视觉）能力判定 ----
     只有两级，**不再按模型名猜**（名字会骗人：同一家的命名五花八门，猜错就白带图浪费 tokens，
     或者该带图却不带、润色质量下降）：
       ① 设置页手动指定（sk_text_vision = on / off）
       ② **接口返回的字段**：拉 /models 时看模型条目里有没有「image / vision」这类多模态声明
          （input_modalities、architecture.input_modalities、capabilities.vision、supports_vision…）
       ③ registry 里该模型声明的 vision: true/false（接入新平台时写死）
     三个来源都没说 → **按不支持处理**（少带图只是少一层参考，不会凭空多花 tokens 或编错），
     并在界面上说清「接口与平台声明都没说，要用就手动开启」。
     为什么以接口为准：同一家的模型名会变、多家共用一套命名，名字猜错会白带图（浪费 tokens） */
  META_TTL: 12 * 60 * 60 * 1000,      // 模型能力缓存 12 小时（能力很少变，不必每次都拉）
  _meta: null,                        // { [modelId]: { vision, why } }
  visionMode() { return window.LS.get('sk_text_vision') || 'auto'; },   // auto | on | off
  /* 润色前要不要先反问（sk_polish_ask）：
       ai（默认）= **交给 AI 判断** —— 把「描述够不够写」交给模型：它读完内容自己决定
                    是先问几个问题，还是直接进润色。程序不按字数拍板（一句 30 字可能很清楚，
                    一段 200 字也可能全是废话，字数说明不了「够不够」）。
       on  = 强制先问；off = 从不问。
     「为什么可以问」这件事也写进了 AI 提示词（askPolish 的契约段与 TextAI.DEF 的「补充信息」段），
     模型才知道自己有两段可选、问到的东西会怎么被用。 */
  askMode() { return window.LS.get('sk_polish_ask') || 'ai'; },
  shouldAsk() {
    const m = this.askMode();
    return m !== 'off';                       // ai / on 都要先问模型，由它决定问不问
  },
  /* 从一条模型条目里找「能不能吃图片」的证据。返回 { vision: true|false|null, field }，
     null = 这个接口没给可用信号（交给下一级判定）。 */
  IMAGE_TOKENS: /^(image|images|vision|visual|multimodal|vl)$/i,
  detectVision(m) {
    if (!m || typeof m !== 'object') return { vision: null, field: '' };
    const hasImg = arr => Array.isArray(arr) && arr.some(x => this.IMAGE_TOKENS.test(String(x).trim()));
    /* ① 明确表达「输入模态」的字段（最可靠，别和输出模态混） */
    const named = [
      ['input_modalities', m.input_modalities],
      ['input_modalities', m.architecture && m.architecture.input_modalities],
      ['input_modalities', m.capabilities && m.capabilities.input_modalities],
      ['input_modalities', m.modalities && m.modalities.input],
      ['input_modalities', m.model_spec && m.model_spec.input_modalities],
    ];
    for (const [field, v] of named) if (Array.isArray(v)) return { vision: hasImg(v), field };
    /* ② 布尔开关：vision / supports_vision / capabilities.vision … */
    const bools = [
      ['vision', m.vision], ['vision', m.supports_vision], ['vision', m.supportsVision],
      ['vision', m.vision_enabled], ['vision', m.capabilities && m.capabilities.vision],
      ['vision', m.capabilities && m.capabilities.image], ['vision', m.architecture && m.architecture.vision],
    ];
    for (const [field, v] of bools) if (typeof v === 'boolean') return { vision: v, field };
    /* ③ 泛化的能力/标签数组（features / tags / capabilities 本身是数组） */
    const loose = [['features', m.features], ['tags', m.tags], ['capabilities', m.capabilities]];
    for (const [field, v] of loose) if (hasImg(v)) return { vision: true, field };
    return { vision: null, field: '' };
  },
  metaKey(prov) { return 'sk_model_meta_' + this.keyId(prov); },
  /* 清掉「这个模型能不能吃图片」的 12 小时判定缓存（换供应商 / 换模型后判定看着不变时用）。
     设置页的清理按钮调用；返回清了几条。 */
  clearMeta() {
    this._meta = null;
    this._metaFor = '';
    return window.Store.sweep(k => k.startsWith('sk_model_meta_'));
  },
  /* 素材清单 → 一段写给 AI 的话。
     问题：参考图能随消息附上（识图模型），**视频 / 音频附不了**。以前只在提示词里塞一句
     「这次还挂了参考视频（沿用它的运镜与节奏）」—— 模型既不知道有几个、也不知道发的是什么，
     只能靠猜。这里把**类型 + 数量 + 用途**一次说清，并明确「没附上的别凭空编造」。
     items: [{ label:'参考图 1', kind:'图片', sent:true }, { label:'参考视频', kind:'视频', sent:false, hint:'沿用它的运镜和节奏' }]
     返回可直接接在系统提示词后面的一段话。 */
  materialNote(items) {
    const list = (items || []).filter(x => x && x.label);
    if (!list.length) return '';
    const group = (pred) => {
      const m = new Map();
      list.filter(pred).forEach(x => { const k = x.kind || '素材'; m.set(k, (m.get(k) || 0) + 1); });
      return [...m.entries()].map(([k, n]) => k + ' ×' + n).join('、');
    };
    const parts = [];
    const sent = group(x => x.sent);
    const notSent = group(x => !x.sent);
    if (sent) parts.push('用户已随这条消息附上：' + sent + '（图编号见消息末尾的「随附图片」，请按 图N 引用）');
    if (notSent) {
      const hints = list.filter(x => !x.sent && x.hint).map(x => x.label + '（' + x.hint + '）');
      parts.push('用户还有**无法随消息附上**的素材：' + notSent
        + (hints.length ? '，用途分别是 ' + hints.join('、') : '')
        + '。你看不到它们的内容，只能按这里的说明理解，**不要凭空编造画面或声音细节**。');
    }
    return '【用户随这段内容附带的素材】' + parts.join('；') + '。';
  },
  /* 拉一次 /models 的**原始条目**（不裁剪字段，识图判定要用原始字段） */
  keyTail(prov) { const k = this.key(prov); return k ? k.slice(-4) : ''; },
  /* 报错时带上一句「用的是哪家、哪把钥匙」：密钥类报错最常见的坑是「以为换了这家，其实请求还发给了上一家」
     （以前基址与密钥都写死一家，切不开）。 */
  who(prov) {
    const p = prov || null;
    const name = (p && p.name) || '文字 AI';
    const kid = this.keyId(p);
    const local = this.key(p);
    return name + '（密钥：' + (local ? '本机保存，尾号 ' + local.slice(-4)
      : ((this._envIds && this._envIds[kid]) ? '服务端 .env' : '没配')) + '）';
  },
  /* 鉴权类错误补一句「谁在拒你」。OpenRouter 这类上游的原文是 "Authentication Fails, Your api key: ****b27a is invalid"，
     不指出用的是哪一把，用户根本不知道该去改哪一格。 */
  authHint(prov, status, msg) {
    const s = String(msg || '');
    if (!/^40[13]$/.test(String(status == null ? '' : status)) && !/auth|api key|密钥|unauthorized|invalid key/i.test(s)) return '';
    return '　用的是：' + this.who(prov);
  },
  /* 余额 / 额度不够时补一句「这一家的余额在哪儿看」。
     为什么必须按家分说法：`ERROR_HINT` 那句提示是「先到「用量与余额」页看看余额」——
     可**有的家压根没有余额查询接口**（MiMo 的 /v1/user/balance、/v1/dashboard/billing/* 全是 404，
     注册表里 `balance` 只能是 null），那一页上根本不会出现它。用户去看了，看到的是别家的余额，
     于是得出「我明明有余额」——然后同一个错再报一遍，来回好几轮。
     所以：声明了 balance 的家照旧指去那一页；没声明的**照实说看不见**，并给出它自己的控制台地址。
     判据是 registry 的 `balance` 声明，不在这里写死任何一家的名字。 */
  balanceHint(prov) {
    const who = this.who(prov);
    if (!prov) return '';
    return prov.balance
      ? '　（用的是 ' + who + '：这一家的余额就在「用量与余额」页上，去核一下）'
      : '　（用的是 ' + who + '：这一家没有余额查询接口，本地看不到它的余额 —— 到 '
        + (prov.site || prov.base || '它的控制台') + ' 的账户页确认这一把密钥所属账号的额度）';
  },

  /* prov 可以显式指定：设置页按下拉里**选中的那家**取型号，而不是已保存的那家
     （以前只有 prov(REG) 一条路，下拉选了没保存时会打到别家去）。 */
  async rawModels(REG, provIn) {
    const prov = provIn || this.prov(REG);
    if (!prov) throw new Error('注册表里没有可用的文字 AI 供应商');
    const r = await netFetch(prov.relay + '/models', { headers: this._headers(prov), timeout: 20000 });
    /* 文字 AI 的失败也要过 ERROR_HINT：上游只回一句「Insufficient Balance」时，
       界面得说清是余额/额度不够、去哪儿处理，而不是把英文原样甩在计数条上。
       错误体不一定是 JSON（网关的 HTML 错误页、代理那句 text/plain），所以原文一起带给 errorMessage。 */
    const { d, plain } = await respBody(r);
    if (!r.ok) {
      const m = window.Api.errorMessage(d, r.status, plain);
      throw new Error(m + this.authHint(prov, r.status, m));
    }
    return window.Api.modelRows(d);
  },
  /* 载入并缓存「模型 → 能否识图」：优先读缓存，过期或 force 时回源。
     回源失败**不写缓存**（否则一次网络抖动会把判定固化 12 小时），并保留上一次的结果。 */
  async loadModelMeta(REG, provIn, opts = {}) {
    const prov = provIn || this.prov(REG);
    if (!prov) return this._meta || {};
    const ck = this.metaKey(prov);
    if (!opts.force) {
      try {
        const c = JSON.parse(localStorage.getItem(ck) || 'null');
        if (c && c.ts && Date.now() - c.ts < this.META_TTL && c.byId) { this._meta = c.byId; this._metaFor = prov.id; return c.byId; }
      } catch {}
    }
    try {
      const raw = await this.rawModels(REG, prov);
      const byId = {};
      raw.forEach(m => {
        const id = m && (m.id || m.name);
        if (id) byId[id] = this.detectVision(m);
      });
      this._meta = byId;
      this._metaFor = prov.id;              // 内存里这份能力属于哪家（换供应方要重拉）
      try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), byId })); } catch {}
      return byId;
    } catch (e) {
      console.warn('[TextAI] 读模型能力失败（沿用上次判定）：', e.message);
      return this._meta || {};
    }
  },
  vision(REG, provIn, modelIn) {
    const prov = provIn || this.prov(REG);
    const model = modelIn || this.model(prov);
    const mode = this.visionMode();
    if (mode === 'on') return { ok: true, model, why: '设置里已开启识图' };
    if (mode === 'off') return { ok: false, model, why: '设置里已关闭识图' };
    // ② 接口字段（最权威）
    const hit = (this._meta || {})[model];
    if (hit && hit.vision !== null) {
      return { ok: !!hit.vision, model, why: '接口字段 ' + (hit.field || 'capabilities') + (hit.vision ? ' 声明支持图片' : ' 未包含 image') };
    }
    // ③ 注册表声明
    /* 两处都查：`models` 与 `modelDocs` 都是「按 id 写的声明表」，只是来路不同 ——
       `models` 是**用户自己勾的**（自定义供应方在「添加自定义供应商」里一个个勾出来的那串），
       `modelDocs` 是「文档里写过这个 id 支持什么」（内置那几家，v16 起文字型号清单全部改名成它，
       注册表不再下发任何一份写死的文字型号清单）。
       只查 models 的话，内置那几家改完名之后识图一律退回「接口与平台声明都没说」——
       而它们明明在 modelDocs 里写着 vision: true。 */
    const decl = (((prov && prov.models) || []).concat((prov && prov.modelDocs) || []))
      .find(m => m && m.id === model);
    if (decl && decl.vision !== undefined) return { ok: !!decl.vision, model, why: '平台声明' };
    /* 接口与平台声明都没说 → 按不支持。**不猜模型名**：名字会骗人（gpt-4o / claude 这类名字
       经常出现在不支持图的开源复刻上，vl 后缀也可能是纯文本微调），猜错就是白花 tokens。 */
    return { ok: false, model, why: '接口与平台声明都没说这个型号能不能吃图片' };
  },
  /* 异步版：确保拿到接口能力后再判定（润色 / 对话前调用） */
  async visionAsync(REG, provIn, modelIn) {
    const prov = provIn || this.prov(REG);
    const model = modelIn || this.model(prov);
    /* 换了供应方就重拉那家的能力（缓存按 keyId 分开存，内存这份得对上号才用） */
    if (!this._meta || this._metaFor !== (prov && prov.id)) { try { await this.loadModelMeta(REG, prov); } catch {} }
    return this.vision(REG, prov, model);
  },
  /* 图片编号说明：让模型知道「图N 是哪张素材」（图片按同一顺序附在后面） */
  imageLegend(images) {
    if (!images || !images.length) return '';
    return '【随附图片（按顺序）】' + images.map((it, i) => `图${i + 1} = ${it.label}`).join('；')
      + '。请结合图片内容润色，并在提示词里按上面的编号指代素材。';
  },
  /* 取字节：File/Blob 直接用，跨域链接经本地代理 /fetch */
  async _blob(src) {
    // 不用 instanceof：跨 iframe / 沙箱来的 File 过不了构造器判断，按能力（arrayBuffer）识别更稳
    if (src && typeof src === 'object' && typeof src.arrayBuffer === 'function') return src;
    const s = String(src || '');
    const u = /^https?:/i.test(s) && s.indexOf(location.origin) !== 0 ? '/fetch?url=' + encodeURIComponent(s) : s;
    const r = await netFetch(u, { timeout: 60000, retry: 1 });
    if (!r.ok) throw new Error('素材读取失败 HTTP ' + r.status);
    return await r.blob();
  },
  /* 缩到最长边 edge 再转 dataURL：识图只做参考，不需要原图分辨率，省流量和 tokens */
  async shrink(src, edge, quality) {
    const blob = await this._blob(src);
    if (/^(video|audio)\//.test(blob.type || '')) return null;
    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) return null;
    const max = edge || 1024;
    const scale = Math.min(1, max / Math.max(bmp.width || 1, bmp.height || 1));
    const w = Math.max(1, Math.round((bmp.width || 1) * scale)), h = Math.max(1, Math.round((bmp.height || 1) * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    try { bmp.close && bmp.close(); } catch {}
    return cv.toDataURL('image/jpeg', quality || 0.85);
  },
  /* 批量压缩（读不出来的素材直接跳过，不影响润色） */
  async prepImages(list, opts) {
    const max = (opts && opts.max) || 6, edge = (opts && opts.edge) || 1024;
    const out = [];
    for (const it of (list || []).slice(0, max)) {
      try { const url = await this.shrink(it.src, edge); if (url) out.push({ label: it.label, url }); } catch {}
    }
    return out;
  },
  /* 润色前统一入口：返回 { images, note }
     note 一句说明，直接贴到润色弹窗的 hint 里（附带了几张图 / 为什么没带图）
     opts.prov / opts.model：按「界面上选中的那一家 / 那一个型号」判识图（AI 助手就是这样，
       它选的供应方和设置页保存的可能不是同一个）；不传就沿用保存值。 */
  async polishImages(REG, list, opts) {
    const items = (list || []).filter(x => x && x.src);
    if (!items.length) return { images: [], note: '' };
    const vis = await this.visionAsync(REG, opts && opts.prov, opts && opts.model);
    if (!vis.ok) return { images: [], note: `当前文字型号（${vis.model}）未启用识图（${vis.why}），本次只按文字润色；可在设置页把「识图能力」设为支持` };
    const max = (opts && opts.max) || 6;
    const images = await this.prepImages(items, opts);
    if (!images.length) return { images: [], note: '素材图没能读出来（可能已过期或不是图片），本次只按文字润色' };
    const more = items.length > images.length ? `（素材共 ${items.length} 张，只带了前 ${images.length} 张）` : '';
    return { images, note: '已附带 ' + images.length + ' 张素材图供文字 AI 识别：' + images.map((x, i) => '图' + (i + 1) + ' = ' + x.label).join('、') + more };
  },
  _headers(prov) {
    const h = { 'Content-Type': 'application/json' };
    const k = this.key(prov);
    if (k) h['Authorization'] = 'Bearer ' + k;
    const b = this.base(prov);
    if (b) h['X-Up-Base'] = b;
    return h;
  },
  /* 拉取该接口的模型列表（OpenAI 兼容 GET /models）
     prov = 要问哪一家（设置页传下拉里选中的那个）；不传就用当前在用的那家。
     顺带把「模型 → 能否识图」的接口声明记进缓存（vision 判定优先用它） */
  async models(REG, provIn) {
    const prov = provIn || this.prov(REG);
    if (!prov) throw new Error('注册表里没有可用的文字 AI 供应商');
    const raw = await this.rawModels(REG, prov);
    // 同一次请求里顺手更新识图能力缓存，避免为了判定再拉一次 /models
    try {
      const byId = {};
      raw.forEach(m => { const id = m && (m.id || m.name); if (id) byId[id] = this.detectVision(m); });
      if (Object.keys(byId).length) {
        this._meta = byId;
        this._metaFor = prov.id;
        localStorage.setItem(this.metaKey(prov), JSON.stringify({ ts: Date.now(), byId }));
      }
    } catch (e) { console.warn('[TextAI] 识图能力缓存写入失败：', e.message); }
    return raw.map(m => ({ id: m.id || m.name, name: m.id || m.name, owned: m.owned_by || '' })).filter(m => m.id);
  },
  /* 服务端是否配了该平台的环境密钥（读 /env-status，缓存 60 秒） */
  async envHas(prov) {
    const kid = this.keyId(prov);
    const now = Date.now();
    if (this._envCache && now - this._envCache.ts < 60000) return !!(this._envCache.data[kid] || {}).hasEnv;
    try {
      const d = await netFetch('/env-status', { timeout: 8000 }).then(r => r.json());
      this._envCache = { ts: now, data: d || {} };
      this._envIds = this._envIds || {};
      Object.keys(d || {}).forEach(k => { if (d[k] && d[k].hasEnv) this._envIds[k] = true; });
      return !!(d[kid] || {}).hasEnv;
    } catch { return false; }
  },
  /* 本地用量记录：走 ui.js 的 Store（信封里的 ts 让数据文件对账能判新旧）。
     坏值（非数组 / 解析失败）一律当空处理，免得一条脏数据让后续每次调用都静默失败、用量再也记不上 */
  readUsageLog() {
    const v = window.Store && Store.read('ai_usage', []);
    return Array.isArray(v) ? v : [];
  },
  /* 能不能跑：本地填了密钥，或服务端有环境密钥（.env / 系统环境变量）。
     顺便把「哪几家在服务端配了密钥」记进 _envIds —— prov() 要靠它判断默认供应方能不能用。 */
  async canRun(REG) {
    await this.warm(REG);
    const prov = this.prov(REG);
    if (!prov) return false;
    if (this.key(prov)) return true;
    return await this.envHas(prov);
  },
  /* 文字 AI 返回的「一段 JSON」→ 对象：模型常把结果包在 ```json 代码块或前后加一句废话，
     三处（统一选择器 / 资产库 / 收藏页）以前各写一份解析，行为还不一样。统一到这里。 */
  parseJson(txt) {
    let s = String(txt == null ? '' : txt).trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  },
  /* 一次对话的请求体只拼一份：chat 与 chatStream 共用（各拼一份的话，
     识图编号、型号来源这两条迟早分叉）。 */
  async _body(REG, prov, sys, user, opts) {
    const o = Object.assign({}, opts || {});
    /* o.model = 页面当下选中的那个型号（设置页那一栏可能还没落盘）；不给就用本机保存的。
       「测试」按钮必须走它，否则会出现「下拉选了 A、实际发的是 B」。 */
    const model = o.model || this.model(prov);
    /* 没型号就别发出去（model() 不再拿写死的清单兜底，见它的注释）。
       空着发上游只会回一句多半看不懂的 4xx —— 这里点名说清要做什么。
       守卫放在 _body 是因为 chat 与 chatStream 都从这里拼请求体，只剩一处。 */
    if (!model) throw new Error('还没选「' + ((prov && prov.name) || '这一家')
      + '」的型号：到设置页点「获取型号列表」用它自己的 /models 拉一个，或在型号下面自己填一个');
    const images = (o.images || []).filter(x => x && x.url);
    const useVision = images.length > 0 && (await this.visionAsync(REG, prov, model)).ok;
    const content = useVision
      ? [{ type: 'text', text: user + '\n\n' + this.imageLegend(images) }]
        .concat(images.map(it => ({ type: 'image_url', image_url: { url: it.url } })))
      : user;
    return { model, body: {
      model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content }],
    } };
  },
  /* 用量落账也只有一份（流式与非流式都要记，否则流式上线后每日曲线会缺一块）。
     记录里的时间字段叫 at（发生时间），不叫 ts —— 信封自己占用了 ts（写入时间，
     数据文件对账比新旧用），两个含义混在一个键名里迟早算错。 */
  _logUsage(prov, model, d) {
    try {
      const u = (d && d.usage) || {};
      const arr = this.readUsageLog();
      arr.push({ at: Date.now(), prov: this.keyId(prov), model,
        pt: u.prompt_tokens || u.input_tokens || 0, ct: u.completion_tokens || u.output_tokens || 0 });
      Store.write('ai_usage', arr.slice(-500), { label: '文字 AI 用量' });
    } catch {}
  },
  /* 对话：返回纯文本（不强制本地密钥：留空时由代理注入环境变量里的密钥）
     opts.images = [{ label, url(dataURL) }]：模型支持识图时按 OpenAI 多模态格式带上，
     并在正文末尾附「图N = 哪张素材」的编号说明（模型据此在提示词里指代素材）。 */
  async chat(REG, sys, user, opts, provIn) {
    const prov = provIn || this.prov(REG);
    if (!prov) throw new Error('注册表里没有可用的文字 AI 供应商');
    const { model, body } = await this._body(REG, prov, sys, user, opts);
    const r = await netFetch(prov.relay + (prov.endpoints?.chat || '/chat/completions'), {
      method: 'POST',
      headers: this._headers(prov),
      body: JSON.stringify(body),
      timeout: 120000,     // 长剧本拆解 / 带图润色本来就慢：给足时间，但不要无限等
      retry: 0,            // POST 不重试（没有幂等键，重试可能重复计费）
    });
    /* 同 rawModels：错误文案统一走 Api.errorMessage（闭包外的 TextAI 不能直接调 errorMessage，
       那是 Api 闭包里的私有函数 —— 以前这么调会抛 ReferenceError），原文一起带上兜住非 JSON 的响应体。 */
    const { d, plain } = await respBody(r);
    if (!r.ok) {
      const m = window.Api.errorMessage(d, r.status, plain);
      throw new Error(m + this.authHint(prov, r.status, m));
    }
    const out = ((d.choices || [])[0] || {}).message?.content;
    if (!out || !String(out).trim()) throw new Error('文字 AI 没有返回内容');
    this._logUsage(prov, model, d);
    return String(out).trim();
  },
  /* 流式对话：边收边把片段交给 onDelta(片段, 'content'|'reasoning')，返回正文全文。
     为什么要它：写剧本 / 分镜这种长文本动辄十几秒，一次性等回来界面只能干转圈，
     人看不到 AI 正在写什么，也就无从判断方向对不对、要不要中途停。
     opts.signal 传给 Net.fetch —— 调用方要能真的中断这一次生成。
     降级有三条，任何一条都不报错（用户的「流式」只是体验，不该变成新的失败面）：
       ① 上游/代理没按 SSE 回（content-type 不是 event-stream）→ 当成一次性 chat 解析；
       ② 4xx 且请求体里的流式参数被拒（一些第三方中转把 stream_options 当未知字段）→ 先去掉这个
          可选参数再试一次流式，仍被拒才彻底退回非流式；
       ③ 退回只在**请求还没被受理**时成立 —— 已经收到过内容说明这次多半已受理，
          重发等于说两遍话、花两次钱，那种情况直接把错误抛回调用方。
     非 2xx 的错误文案与非流式同一条路（Api.errorMessage + authHint），别让人只看得到英文原文。 */
  async chatStream(REG, sys, user, opts, onDelta, provIn) {
    const prov = provIn || this.prov(REG);
    if (!prov) throw new Error('注册表里没有可用的文字 AI 供应商');
    const o = Object.assign({}, opts || {});
    if (o.stream === false) return await this.chat(REG, sys, user, o, prov);
    const { model, body } = await this._body(REG, prov, sys, user, o);
    const url = prov.relay + (prov.endpoints?.chat || '/chat/completions');
    const hdr = Object.assign({}, this._headers(prov), { accept: 'text/event-stream' });
    /* 长等：流式本来就是一点点往外吐，Net 的默认超时会在模型思考时把连接掐掉。
       超时关掉（timeout:0），但不重试（retry:0）—— POST 没有幂等键。 */
    const ask = (extra) => netFetch(url, {
      method: 'POST', headers: hdr, body: JSON.stringify(Object.assign({}, body, extra)),
      timeout: 0, retry: 0, signal: o.signal,
    });
    let r = null, sentStreamOpts = true;
    try {
      /* include_usage：不带这一条，流式请求就再也记不到 tokens，用量页会静默少一块 */
      r = await ask({ stream: true, stream_options: { include_usage: true } });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('已经取消这次生成');
      throw e;
    }
    if (!r.ok) {
      const { d, plain } = await respBody(r);
      const m = window.Api.errorMessage(d, r.status, plain);
      /* 可以安全重发的只有「请求被拒」这一类 4xx：没受理、没扣费，去掉一个可选参数再试一次不会说两遍话。
       鉴权 / 欠费那种重发也还是同一个错（而且文案里带 key/余额，改它没意义），直接抛回去。
       判据不能只认 stream_options 这个字面（上游的说法五花八门：unknown parameter / not supported / extra field），
       也不能反过来什么 4xx 都重试 —— 那会把一次真正的坏请求变成两次。 */
      const hard = /40[13]|api.?key|密钥|auth|balance|credit|quota|insufficient|payment/i;
      if (!(r.status >= 400 && r.status < 500) || hard.test(m)) throw new Error(m + this.authHint(prov, r.status, m));
      sentStreamOpts = false;
      r = await ask({ stream: true });          // 只退回「不认这个可选参数」，仍是流式
      if (!r.ok) {
        const again = await respBody(r);
        const m2 = window.Api.errorMessage(again.d, r.status, again.plain);
        if (!/stream|流式/i.test(m2)) throw new Error(m2 + this.authHint(prov, r.status, m2));
        return await this.chat(REG, sys, user, o, prov);   // ② 这家压根不流式
      }
    }
    /* content-type 要在**每一次**请求之后现取：退回重试时它是新响应的头，
       拿第一次那一份会一直停在「application/json」，于是流式响应被当成整包 JSON 去 parse，
       报出来的是「没有返回内容」这种和真实原因毫无关系的话（实测踩过）。 */
    const ct = String(r.headers.get('content-type') || '');
    if (!ct.includes('event-stream')) {
      /* ① 没流式：整包 JSON 也照样能用，只是没有过程显示 */
      const { d, plain } = await respBody(r);
      const out = ((d.choices || [])[0] || {}).message?.content;
      if (!out || !String(out).trim()) {
        const m = window.Api.errorMessage(d, r.status, plain);
        throw new Error((m && m !== 'HTTP ' + r.status ? m : '文字 AI 没有返回内容') + this.authHint(prov, r.status, m));
      }
      this._logUsage(prov, model, d);
      const txt = String(out);
      if (onDelta) { try { onDelta(txt, 'content'); } catch (e) {} }
      return txt.trim();
    }
    /* 中途断掉时「已经收到多少字」要如实说出来：面板上明明有字，只报一句「连接中断」
       会让人以为一个字都没拿到、又重发一次（那次是白花一轮 tokens 的）。 */
    let got = 0;
    let s = null;
    try {
      s = await readSseStream(r, (piece, kind) => {
        if (kind === 'content') got += piece.length;
        if (onDelta) { try { onDelta(piece, kind); } catch (e) {} }
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('已经取消这次生成');
      if (got) throw new Error('这次生成中途断了（已经收到 ' + got + ' 字，界面里能看到）：' + e.message);
      /* 只有「还没收到任何内容 + 明确 4xx 拒收」才能改走非流式重发。
         流已经建起来之后（got === 0 也可能是上游已经受理、只是没吐字）重发等于说两遍话、
         花两次钱；读流的错误没有状态码，一律如实抛。 */
      const st = Number(e && e.status) || 0;
      if (sentStreamOpts && st >= 400 && st < 500 && /stream_options|unknown|unsupported|extra/i.test(e.message)) {
        return await this.chat(REG, sys, user, o, prov);
      }
      throw e;
    }
    if (!s.text.trim()) {
      if (s.reasoning.trim()) throw new Error('文字 AI 只回了思考过程，没有正文（换个型号试试）');
      throw new Error('文字 AI 没有返回内容');
    }
    this._logUsage(prov, model, { usage: s.usage });
    return s.text.trim();
  },
  /* ---- 反问（两段式润色的第一段）----
     润色之前先问几个最影响成片的要点，让用户点选或自己写；拿到回答再润色第二段。
     约定只回 JSON {"questions":[{"q":"…","options":["…"]}]}；模型不听话就按纯文本兜底解析，
     再不行返回 [] —— 调用方据此跳过问答直接润色，绝不因为「模型没按格式回」把功能卡死。 */
  QA_O_MAX: 6,
  /* 「一道问答」长什么样只在这一处归一：问题认 q / question / title 三个别名，候选认
     options / choices 两键、每项再认 label / text，剥掉空串并按 oMax 夹；
     cut 告诉调用方「这里夹掉了」，要不要说由它决定（AI 助手那一屏要写明裁掉多少，润色这一头不吭声）。
     以前 ai-chat 的 askOf 自己抄了一遍这四个别名，抄出两份不同的上限（一份 6 个候选不限题数、
     另一份 8 题 ×10 候选）—— 同一个模型回同一段 JSON，两处解析出的题数与候选数可以不一样。 */
  qaOf(arg, oMax) {
    const max = Math.max(1, Number(oMax) || this.QA_O_MAX);
    const arr = Array.isArray(arg) ? arg : (arg && Array.isArray(arg.questions) ? arg.questions : []);
    const out = [];
    arr.forEach(x => {
      const q = String((x && (x.q || x.question || x.title)) || '').trim();
      if (!q) return;
      const os = (Array.isArray(x.options) ? x.options : (Array.isArray(x.choices) ? x.choices : []))
        .map(o => String((o && (o.label || o.text)) || o || '').trim()).filter(Boolean);
      out.push({ q, options: os.slice(0, max), cut: os.length > max });
    });
    return out;
  },
  parseQuestions(txt) {
    const out = this.qaOf(this.parseJson(txt), this.QA_O_MAX);
    if (out.length) return out;
    /* 兜底：回的是「1. 问题」+「- 选项」这种纯文本 */
    let cur = null;
    String(txt || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).forEach(l => {
      const m = /^(?:\d+[.、)]|[-*•])\s*(.+)$/.exec(l);
      if (!m) return;
      const body = m[1].trim();
      if (!body) return;
      if (/[?？]$/.test(body)) { cur = { q: body, options: [] }; out.push(cur); return; }
      if (cur && cur.options.length < this.QA_O_MAX) cur.options.push(body);
    });
    return out.filter(x => x.q);
  },
  /* 两段式润色的第一段：**让 AI 自己决定要不要问**，并把问题一次问完。
     判据不按字数（字数说明不了「够不够写」），由模型读完内容判断：缺了会明显影响成片的信息就问，
     已经够具体就 need=false，直接进润色。
     契约（写进提示词里，模型才知道自己有两段可选、答案会被怎么用）：
       {"need": true|false, "questions":[{"q":"问题","options":["候选1","候选2"]}]}
     返回 { need, questions }：调用方（InlinePolish.interactive / 导演台）据此决定要不要出问答面板。 */
  async askPolish(REG, sys, user, opts) {
    const sysAsk = String(sys || '')
      + '\n\n【这一轮你的任务：判断这段内容值不值得先问问题】\n'
      + '判断标准：如果补上缺失信息能明显改变成片效果，就问；如果内容已经足够具体（主体、动作、场景/氛围、'
      + '风格取向都说了），就直接说 need=false，别为了显得认真而提问。\n'
      + '提问要求：\n'
      + '1. 只问「缺的那部分」，缺几项问几项；不要复述用户已经写明的内容，也不要为了显得认真而把已经说清的再问一遍。\n'
      + '2. 每个问题都要具体到**能点选**（例：「光线与时间？黄金时刻 / 冷调夜景 / 阴天柔光」），'
      + '不要问「你还有什么要求」这种空问题。\n'
      + '3. options 给 3–4 个互斥的中文候选，覆盖常见选择；不要加解释、不要加「其它」。\n'
      + '4. 用户会在这些候选之外自己写字（每题都有一个自由输入框），所以候选不必穷尽。\n'
      + '5. 只输出 JSON，不要任何解释、不要 markdown 代码块：'
      + '{"need":true,"questions":[{"q":"问题","options":["候选1","候选2","候选3"]}]}\n'
      + '   不问就写 {"need":false,"questions":[]}。';
    let raw = '';
    try { raw = await this.chat(REG, sysAsk, user, opts); }
    catch (e) { return { need: false, questions: [], error: e.message }; }
    const j = this.parseJson(raw) || {};
    const questions = this.parseQuestions(raw);
    /* need 明确为 false 就别问；字段缺失时按「有问题就问」处理（保守：多问一次不至于毁掉结果） */
    const need = j && j.need === false ? false : questions.length > 0;
    return { need, questions };
  },
  /* ---- 润色那几处「同一句话」收成一份（2026-10）----
     以前这几句在三个地方逐字抄过：`请润色以下X，直接返回润色结果：`、
     `用户已经回答了你先前的追问，请严格按这些回答来写…`、`消息末尾的「随附图片」列出了…`。
     抄三遍的后果不是难看，是**同一句回答在不同页面对模型的意思不一样** ——
     改契约的人只会改自己刚碰的那一处。数量、措辞都是数据，数据只应有一份。 */
  /* 第二段（真的去润色）发给模型的那句话 */
  polishUser(what, text) {
    return '请润色以下' + String(what || '内容') + '，直接返回润色结果：\n' + String(text || '');
  },
  /* 第一段（反问要点）发给模型的那句话：`o.count` 说清问几个（配音那处一句台词，问 2–3 个就够），
     `o.tail` 是给括号里那句补的说明（有没有附素材图、素材清单在哪）。 */
  askUser(what, text, o) {
    const opt = o || {};
    return '这是一段' + String(what || '内容') + '：\n' + String(text || '')
      + '\n\n请针对它提出 ' + (opt.count || '2–4') + ' 个最影响成片的追问'
      + (opt.tail ? '（' + opt.tail + '）。' : '（素材清单见系统提示）。');
  },
  /* 用户对先前那几题的回答怎么交代：空回答就不说（不说比「按空回答写」好）。 */
  answersNote(answers) {
    const t = String(answers || '').trim();
    return t ? '用户已经回答了你先前的追问，请严格按这些回答来写，不要再自行改动用户已定的选择：\n' + t : '';
  },
  /* 一次润色（或一次反问）要额外交代的那几句（随附图片 / 素材标记 / 素材清单 / 用户的回答）
     ——**顺序也只有一份**：清单在回答之前，模型先看清手上有什么素材，再看用户定了什么。
     `o.stage === 'ask'` 时那一句改成「结合图片提问」（反问那一轮还没有结果可润）；
     `o.text` 里有 `@参考图1` / `@角色名` 这类素材引用标记才追加「原样保留」那一句。 */
  polishExtra(o) {
    const opt = o || {};
    const out = [];
    if ((opt.images || []).length) {
      out.push(opt.stage === 'ask'
        ? '消息末尾附了参考图，请结合图片内容提问。'
        : '消息末尾的「随附图片」列出了每张图对应哪张素材，请结合图片内容润色。');
    }
    if (opt.text && /@参考图\s*\d+|@[^\s，。；、]+/.test(String(opt.text))) {
      out.push('提示词里的 @参考图1、@角色名 这类标记是素材引用，必须原样保留，不要改写或删除。');
    }
    const mn = this.materialNote(opt.materials || []);
    if (mn) out.push(mn);
    const an = this.answersNote(opt.answers);
    if (an) out.push(an);
    return out;
  },
  /* 把上面那几句拼到这一族的系统提示词后面（`prompt('video'|'img'|'audio')` 那份）。 */
  polishSys(sysBase, extras) {
    const list = (extras || []).filter(Boolean);
    return String(sysBase || '') + (list.length ? ' ' + list.join('') : '');
  },
  /* 「按用户这一句话，在当前这一版上再改」：返回 { sys, user }，页面只管发。
     `what` 同时写进系统提示词的 `{what}` 与正文那一行 —— 用户在设置里把占位符删掉也不至于没说清。 */
  followPrompt(o) {
    const opt = o || {};
    const what = String(opt.what || '这一稿');
    const sys = this.polishSys(this.prompt('follow').replace(/\{what\}/g, what), opt.extra);
    const user = '这一版是' + what + '。\n\n'
      + '用户这一轮的要求：\n' + String(opt.ask || '') + '\n\n'
      + '当前这一版：\n' + String(opt.current || '');
    return { sys, user };
  },
};
/* 模块一装好就收拾一次「存盘副本其实就是默认」的键（见 pruneStoredDefaults 的注释）。
   放在这里而不是各页面 boot 里：这一份是**所有**页面共用的，漏一个页面就等于没修。
   判据是逐字节相同，删掉它不可能碰到用户真写的内容；重复跑也是幂等的。 */
try { window.TextAI.pruneStoredDefaults(); } catch (e) { /* localStorage 不可用（隐私模式）就跳过 */ }

/* ============================================================================
   TextAI 余额（不再折算金额：文字 AI 只记录 tokens 用量，展示见「用量与余额」页）
   ========================================================================== */
/* 各平台余额接口规格（只有声明了 url 的能精确查询） */
window.TextAI.BALANCE = {
  deepseek: { url: '/user/balance', parse: d => {
    const b = (Array.isArray(d && d.balance_infos) ? d.balance_infos[0] : null) || null;
    /* 读不到余额字段就是「没验成」，不是「余额 0 且密钥可用」—— 空对象折成 ok:true 会让
       设置页把一把只能查余额却查不出数的钥匙报成可用。 */
    if (!b || b.total_balance == null) return { ok: false };
    return { ok: true, currency: b.currency || 'CNY', amount: Number(b.total_balance || 0),
      extra: `充值 ${b.topped_up_balance ?? '—'} · 赠送 ${b.granted_balance ?? '—'}`, available: d.is_available !== false };
  } },
  moonshot: { url: '/users/me/balance', parse: d => {
    const b = (d && d.data) || null;
    if (!b || b.available_balance == null) return { ok: false };
    const amount = Number(b.available_balance ?? 0);
    return { ok: true, currency: 'CNY', amount, extra: `现金 ${b.cash_balance ?? '—'} · 代金券 ${b.voucher_balance ?? '—'}`, available: true };
  } },
  siliconflow: { url: '/user/info', parse: d => {
    const b = (d && d.data) || null;
    const raw = b ? (b.totalBalance ?? b.balance) : null;
    if (raw == null) return { ok: false };
    const amount = Number(raw || 0);
    return { ok: true, currency: 'CNY', amount, extra: b.chargeBalance != null ? `充值余额 ${b.chargeBalance}` : '', available: true };
  } },
  /* OpenRouter 的 /credits 只认**管理密钥**，普通 API key 会回 403 —— 那是正常的，
     页面会照实显示原因。侧栏余额卡不画它（那边只有 micros / 积分两种解析形状，硬套会显示成 ¥0.00）。 */
  openrouter: { url: '/credits', parse: d => {
    const b = (d && d.data) || null;
    if (!b || b.total_credits == null) return { ok: false };
    const total = Number(b.total_credits ?? 0), used = Number(b.total_usage ?? 0);
    return { ok: true, currency: 'USD', amount: Math.max(0, total - used),
      extra: `充值 $${total.toFixed(2)} · 已用 $${used.toFixed(2)}`, available: true };
  } },
};
/* 查询某文字 AI 平台的余额（未声明接口的返回 {ok:false, reason}）
   带出 status：鉴权类判定要用它（401 = 密钥无效；403 = 密钥有效但权限不够，例如 OpenRouter 只让管理密钥查余额）。 */
window.TextAI.fetchBalance = async function (REG, prov) {
  const kid = this.keyId(prov);
  const spec = this.BALANCE[kid];
  if (!spec) return { ok: false, unsupported: true, reason: '该平台没有公开的余额查询接口' };
  try {
    const r = await netFetch(prov.relay + spec.url, { headers: this._headers(prov), timeout: 15000 });
    const { d, plain } = await respBody(r);
    if (!r.ok) {
      /* 与非 2xx 的别处同一份文案口径（Api.errorMessage：JSON 用它的 error.message，
         不是 JSON 就用正文里那句真原因），别再退回一句没有主语的 HTTP 502。 */
      const reason = window.Api.errorMessage(d, r.status, plain);
      return { ok: false, status: r.status, reason: reason + this.authHint(prov, r.status, reason) };
    }
    const out = spec.parse(d);
    return out.ok ? out : { ok: false, status: r.status, reason: '返回格式不符' };
  } catch (e) { return { ok: false, reason: e.message }; }
};

/* 验证「这把密钥到底能不能用」——不花钱的那种判法。
   为什么需要它：OpenRouter 的 `GET /models` 是**公开**的（不鉴权也能拉到全量型号），
   所以「获取模型列表成功」完全不能证明密钥有效，等真正润色时才炸出一句
   "Authentication Fails, Your api key: ****xxxx is invalid"，很容易以为是别的地方配错了。
   判据用余额接口的状态码（免费、不计费）：
     200 → 密钥有效（顺带报余额）
     401 → 密钥无效
     403 → 密钥有效但这个接口要更高权限（OpenRouter 的 /credits 只认管理密钥）→ 当作「有效」
     无接口 / 其它 → unknown，让用户点「测试」发一条消息来验
   返回 { state, text }，设置页直接显示。 */
window.TextAI.verifyKey = async function (REG, prov) {
  const p = prov || this.prov(REG);
  if (!p) return { state: 'unknown', text: '注册表里没有可用的文字 AI 供应商' };
  const r = await this.fetchBalance(REG, p);
  if (r.ok) return { state: 'ok', text: '✓ 密钥可用（余额 ' + (r.currency || '') + (Number(r.amount) || 0).toFixed(2) + (r.extra ? ' · ' + r.extra : '') + '）' };
  if (r.status === 401) return { state: 'invalid', text: '✗ 密钥无效：上游 401 拒绝了这把钥匙（' + this.who(p) + '）' };
  if (r.status === 403) return { state: 'ok', text: '✓ 密钥可用（余额接口要更高权限，普通密钥 403 属正常；余额看 ' + (p.site || '平台后台') + '）' };
  if (r.unsupported) return { state: 'unknown', text: '这个平台没有免费的余额接口，验不了密钥：点「测试」发一条消息来验（会消耗一点额度）' };
  return { state: 'unknown', text: '没验成：' + (r.reason || '未知原因') + '　（' + this.who(p) + '）' };
};

