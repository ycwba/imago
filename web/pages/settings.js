/* 设置 —— 从 settings.html 迁到 Vue 3 的页面组件（无构建步骤，Vue 由本地 vendored 的
   vue.runtime.esm-browser.prod.js 提供）。行为一律照旧：
   · 改完一项就自动存本机（400ms 合并），顶栏那一格是唯一的回执出口；没有「保存全部」按钮；
   · 供应商 / 密钥 / 自定义供应商 / 文字 AI 型号与识图 / 导出目录 / 本机资产库位置 /
     数据与云同步 / 本机体检 / 磁盘用量 / 清理缓存 / 提示词归档 / 整份设置的导出导入与恢复默认；
   · 下拉、弹窗、提示、数据同步、注册表、素材库设置全部仍走公共层那一份实现
     （Dropdowns / UiDialog / Confirm / Toast / DataSync / Api / TextAI / ModelPrefs /
      AssetLocal / PromptLog / Chars.SET / Wb.History），页面不复制第二份判据。
   组件只负责「这一屏长什么样」；需要逐块重画的几处（供应商卡、型号清单、分页表、
   外观偏好、本机资产库、体检 / 用量行、云同步面板）沿用原来的 renderXxx 形状，
   容器由 Vue 的 ref 持有 —— 这样 Dropdowns 重包下拉、initFolds 绑折叠、
   Confirm.arm 的武装态都与原来完全一致。 */
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/settings.js';

const SAVE_DEBOUNCE_MS = 400;

/* ---------- 六档能力（一张账号卡里「这一家会做什么」的那一排） ----------
   前四档是「一类平台」（图片 / 视频 / 语音合成 / 文字对话），名字、顺序与取值都现读
   ui.js 的 provKinds() / provKindZh()（那份唯一清单）—— 这里不抄第二份名单。
   后两档（语音识别 / 联网搜索）与四类平台**同一层级**，但不是「一类平台」：它们是另外两种接法，
   住在「有文字对话档」的那几家卡里（谁能当在线识别 / 搜索的渠道，就是那几家文字账号 ——
   与 serviceProvOpts() 的判据同一份）。 */
const EXTRA_CAPS = [['asr', '语音识别'], ['search', '联网搜索']];
/* 「本机 / 浏览器内识别」这一家的账号 id：它不是注册表里的云供应商，是设置页合成的
   一张常驻账号卡（永远可用、不用密钥）。本机运行包与浏览器内模型都归它，
   云供应商卡里只留在线识别。 */
const LOCAL_ASR_KID = '__local_asr__';
/* 卡顶那一格里的一个字：图 / 视 / 音 / 字 / 识 / 搜。 */
const CAP_GLYPH = { image: '图', video: '视', audio: '音', text: '字', asr: '识', search: '搜' };
const capZh = id => (EXTRA_CAPS.find(kv => kv[0] === id) || [])[1]
  || (window.provKindZh ? window.provKindZh(id) : String(id || ''));
const capGlyph = id => CAP_GLYPH[id] || '·';
/* 单选档 = 同一时刻只有一家顶着（点状态牌就是换一家上位）；
   多选档 = 几家可以同时开着（点状态牌是在用 / 停用）。 */
const SOLO_CAP = new Set(['text', 'asr', 'search']);

/* ---------- 声明式清单（分组 + 「一处声明」） ----------
   五组导航：id、顺序、显示名**只写在模板那一节 DOM 上**（`<section data-group>` 里的
   `<h2 class="set-group-h">`，折叠那一组在 `.fold-title` 里）—— 新增一组 = 模板里加一节，
   这里没有第二份名单要抄。
   普通设置行：kind 只有 num / check / sel 三种；渲染、自动保存写盘、导出名单
   （EXPORTABLE 末尾的展开）都从这一份现取。**新增一项普通设置 = 这里加一行**，
   模板里只留对应的容器 `<div class="kcols" ref="…BoxEl">`。
   特殊控件（供应商卡 / ASR / 联网搜索 / Skill / 云同步 / 体检 / 用量 / 清理缓存）
   不是「一行一个键」的形状，仍由各自的 renderXxx 画，只在分组里占一个栏位。
   界面偏好那一批（主题 / 视图档位 / 产物三开关）的真相仍在 ui.js 的 UI_PREFS
   （同步名单与助手白名单从那里派生，见 tests/settings-schema.cjs 判据①）。 */
/* 组名单不在这里：id 与显示名都现读 DOM（`<section data-group>` + `<h2 class="set-group-h">`）。 */
/* check 行的三态写盘规则：on/off 各存什么值，null = 删键；def = 键不存在时算不算勾上。 */
const SET_ROWS = [
  /* 网络与刷新（取值区间仍由 Net.NUMS 现取，这里只声明行本身） */
  { card: 'net', kind: 'num', name: 'timeout', label: '请求超时', unit: '秒' },
  { card: 'net', kind: 'num', name: 'retry', label: '失败重试', unit: '次', hint: '填 0 = 不重试' },
  { card: 'net', kind: 'num', name: 'poll', label: '任务刷新间隔', unit: '秒' },
  /* 产物存放：三行（自动存档位 + 左栏两块开关）。库根位置不在这里 —— 那是代理读的配置，
     由「本机资产库」那一卡直接写 `sk_local_dir`。 */
  { card: 'store', kind: 'sel', key: 'sk_media_local_scope', label: '自动存本机要存哪一档', def: 'all', keep: 1,
    opts: [['all', '连历史一起补齐（推荐）'], ['new', '只存新生成的']], hintDyn: 'saveScope' },
  { card: 'store', kind: 'check', key: 'sb_bal_on', label: '左栏显示余额', on: '1', off: '0', def: true, keep: 1 },
  { card: 'store', kind: 'check', key: 'sb_mirror_on', label: '左栏显示本机产物', on: '1', off: '0', def: true, keep: 1 },
  /* AI 助手：四颗开关（after: 'notice' 在通知那一行追加「现在授权」与授权状态说明） */
  { card: 'assistant', kind: 'check', key: 'ai_chat_off', label: '启用 AI 助手', on: null, off: '1', def: true, keep: 1 },
  { card: 'assistant', kind: 'check', key: 'ai_chat_auto', label: '执行前不确认', on: '1', off: null, def: false },
  { card: 'assistant', kind: 'check', key: 'ai_chat_snap', label: '悬浮球拖到边上时吸住', on: null, off: '0', def: true },
  { card: 'assistant', kind: 'check', key: 'ai_chat_notice', label: '任务出结果时系统通知', on: '1', off: null, def: false, after: 'notice' },
  /* 引用发给助手时带哪些字段（默认全带）。
     ⚠ 它只裁**给助手看的那份清单**（refBlock）—— 工具侧（asset_open 按序号取）读的是这一轮
        真正发出去的那份完整记录，所以裁了清单，助手照样能按序号把字节取回来。
        你拖进来的东西、输入框里的高亮、消息下方那排记录，一样都不受影响。 */
  { card: 'assistant', kind: 'sel', key: 'ai_chat_ref_send', label: '引用发给助手时带哪些', def: 'all',
    opts: [['all', '全带（推荐）'],
           ['image', '只带地址'],
           ['task', '只带任务号'],
           ['asset', '只带资产号'],
           ['name', '只带名字与类型']] },
  /* 润色行为（导演台的拆分镜 / 改分镜反问也读这一档） */
  { card: 'polish', kind: 'sel', key: 'sk_polish_ask', label: 'AI 动手前要不要先反问', def: 'ai',
    opts: [['ai', 'AI 判断（推荐）'], ['on', '强制先问'], ['off', '从不问']],
    hint: '管两处：各工作台的「AI 润色」与导演台的「拆分镜 / 改分镜」。问出来的答案会当作硬约束落实进结果。' },
];

const SettingsView = {
  name: 'SettingsView',
  setup() {
    /* ---------- 容器（全部走 ref；组件里不出现 document.getElementById） ---------- */
    const rootEl = ref(null);
    /* 账号卡片流每次重画 +1：那几个「自动挑哪一家」的读数（识别 / 搜索）靠它重算 ——
       lastAcctAll 是普通数组，Vue 不会替它做依赖追踪。 */
    const provEpoch = ref(0);
    const setRailEl = ref(null);   /* 左：目录轨的清单（JS 现画） */
    const setDocEl = ref(null);    /* 右：那条文档 —— 这一页的滚动容器 */
    const setQEl = ref(null);
    const acctToolsEl = ref(null);
    const provListEl = ref(null);
    const provErrEl = ref(null);
    const acctParkEl = ref(null);
    const asrFormEl = ref(null);
    const asrLocalFormEl = ref(null);
    const searchFormEl = ref(null);
    const cusCardEl = ref(null);
    const cusNameEl = ref(null);
    const cusBaseEl = ref(null);
    const cusKeyEl = ref(null);
    const cusExtraEl = ref(null);
    const cusShapeEl = ref(null);
    const cusCapEl = ref(null);
    const pageBoxEl = ref(null);
    const uiPrefsBoxEl = ref(null);
    const storePrefsBoxEl = ref(null);
    const charsBoxEl = ref(null);
    const netBoxEl = ref(null);
    const storeRowsEl = ref(null);
    const assistantBoxEl = ref(null);
    const polishBoxEl = ref(null);
    const sysRowsEl = ref(null);
    const usageRowsEl = ref(null);
    const usageGoSlotEl = ref(null);
    const histBoxEl = ref(null);
    const promptDirEl = ref(null);
    const promptRecentEl = ref(null);
    const impAllFileEl = ref(null);
    const impSetFileEl = ref(null);
    const cloudConflictsEl = ref(null);
    const cloudBackupsEl = ref(null);

    /* ---------- 公共层（求值期不抓，用到时现取） ---------- */
    const ic = (n, s) => (window.icon ? window.icon(n, s) : '');
    const q = sel => (rootEl.value ? rootEl.value.querySelector(sel) : null);
    const qa = sel => (rootEl.value ? [...rootEl.value.querySelectorAll(sel)] : []);
    const mbOf = b => (window.fmtBytes ? window.fmtBytes(b) : '') || '0 KB';

    /* ---------- 页面状态 ---------- */
    const ready = ref(false);
    const failed = ref('');

    /* 注册表只有**一份真相**：本组件里所有函数都读同一个 REG（TextAI 那几处也吃它）。
       以前这里还往 `window.__REG` 挂一份「给别人读」的引用 —— 全站没有第二个文件读它，
       留着只会让人以为换 REG 要同时换两处（少换一处就是「页面看着更新了、别处还拿旧的」）。 */
    let REG = { providers: [] };
    let envInfo = {};

    /* 保存回执（顶栏那一格） */
    const saveText = ref('');
    const saveKind = ref('');
    /* 栏目导航 */
    const setQ = ref('');
    const navHasFilter = ref(false);
    const navSum = ref('');
    const navSumErr = ref(false);
    const navSumShort = ref('');   /* 轨底那一行短摘要（5 组 · 15 栏） */
    const navPos = ref('');        /* 状态行左边：现在在第几项 */

    /* ---------- 供应商：账号卡 / 筛选 / 草稿 ----------
       「按类型分档、一屏只看那一类」那一排分段开关已经撤掉：一家账号一张卡，
       卡里列着它能开通的每一档，所以「当前哪一档」这个状态本身就没有了 ——
       它的旧键 sk_prov_tab 连带导出名单一起删（不留「读旧键」的兼容层，ui.js 的 LEGACY_KEYS 负责清盘）。 */
    const acctFilter = ref('all');    /* 筛选芯片：'all' 或某一档 id（数字算的是**账号数**） */
    const keyOpen = new Set();        /* 名字右边那颗「密钥」点开了哪几家（本轮会话，不落盘） */
    const panelOpen = new Set();      /* 展开着型号清单面板的那几个槽位（keyId:档，一档一个槽） */
    const pendingAdds = new Set();    /* 刚在「添加供应商」里点了添加、还没填密钥的那几家 keyId */
    /* 「作用文字 AI」点过、还没落盘的那一个。为什么需要它：换一家会整块重画（识图那一段只画在
       当前那一家的卡上），而重画会先把旧卡片整个换掉 —— 那时 DOM 里已经没有刚点中的那一块，
       `curTextId()` 只能回落到盘上的旧值，点一下看起来像「弹回去了」。记一份草稿（与密钥 / 型号
       同一套「改完先留在内存、由自动保存统一落盘」的写法），重画时按它选回去；落盘后清掉。 */
    let textPickDraft = '';
    const keyDraft = new Map();         // keyId → 还没落盘的密钥
    const keyCleared = new Set();       // 点了「清除」、还没落盘的 keyId
    const acctOffSet = new Map();       // keyId → 点了「暂时不用 / 取消」、还没落盘
    const provRows = new Map();         // keyId → 归并后的那一条（验证要用它认出这一家）
    let lastAcctAll = [];               // 最近一次归并出来的全部账号（自动挑渠道时读它）
    let acctSumPainter = null;

    const keyFor = id => window.LS.get('sk_key_' + id) || '';
    const draftKey = kid => (keyCleared.has(kid) ? ''
      : (keyDraft.has(kid) ? keyDraft.get(kid) : keyFor(kid)));
    /* 接口地址：卡上不再单独改（预设那几家一律走官方地址），只有自定义那几家在添加 / 编辑那一格改，
       那一份写在 sk_custom 的条目里 —— 所以这一页没有「地址草稿」这一层。 */

    function setREG(d) {
      REG = d && d.providers ? d : { providers: [] };
      return REG;
    }

    function curTextId() {
      const list = window.TextAI ? TextAI.all(REG) : [];
      if (!list.length) return '';
      if (textPickDraft) return textPickDraft;
      const saved = TextAI.savedProv(REG);
      return saved ? saved.id : ((TextAI.prov(REG) || list[0]).id);
    }
    /* 「顶着这一档的那一家」的 keyId：单选档（文字对话 / 语音识别 / 联网搜索）靠它判主位。
       语音识别与联网搜索的真相在服务端那两份设置里（.data/asr.json / .data/search.json），
       与卡上那些 localStorage 键各管各的 —— 这里只**读**，改它们仍走各自的表单。 */
    const kidOfProv = id => {
      const p = (REG.providers || []).find(x => x.id === id);
      return p ? String(p.keyId || p.id) : '';
    };
    /* 「自动」时是哪一家顶着：按注册表顺序挑第一家**声明了这一档、并且已经接上**的账号。
       设置页只读它来画主位，不改服务端那份设置（真正挑哪一家在 /asr、/search 里同一口径）。 */
    function autoServiceKid(cap) {
      const list = (REG.providers || []).filter(p => p.kind === 'text'
        && (p.extraCaps || []).indexOf(cap) >= 0 && (cap === 'asr' ? p.asr : p.search));
      const seen = new Set();
      const hit = [];
      for (const p of list) {
        const kid = String(p.keyId || p.id);
        if (seen.has(kid)) continue;
        seen.add(kid);
        const m = lastAcctAll.find(x => x.keyId === kid);
        if (m && provUsable(m)) hit.push({ p, kid });
      }
      /* 搜索的「自动」优先选**接口型**那几家（DeepSeek / 智谱 / Kimi）：
         chat 那一族（OpenRouter）还要一个对话型号，自动选中它等于还要用户再填一格。 */
      if (cap === 'search') {
        const api = hit.find(x => x.p.search && x.p.search.style === 'api');
        if (api) return api.kid;
      }
      return hit.length ? hit[0].kid : '';
    }
    /* 识别这一档**实际**走哪条路：auto 先看浏览器内模型在不在、再看本机运行包，
       都不可用才落到在线（与 web/domain/asr.js 的 pickRoute 同一顺序）。 */
    function asrEffectiveRoute() {
      const r = asr.route;
      if (r !== 'auto') return r;
      if (asrBrowser.value && asrBrowser.value.complete) return 'browser';
      if (asrLocal.value && asrLocal.value.available) return 'local';
      return 'service';
    }
    function priKidOf(cap) {
      if (cap === 'text') return kidOfProv(curTextId());
      if (cap === 'asr') {
        /* 走浏览器内 / 本机时，顶着这一档的是那家合成的「本机识别」账号；
           只有真的会走到在线那一路，才算某一家云供应商顶着。 */
        const route = asrEffectiveRoute();
        if (route === 'browser' || route === 'local') return LOCAL_ASR_KID;
        const pid = asr.service.providerId;
        return kidOfProv(pid) || autoServiceKid('asr');
      }
      if (cap === 'search') {
        if (!search.enabled) return '';
        const pid = String(search.provider || '');
        if (pid === 'tavily') return '';            // Tavily 不是供应商账号，没有主位
        if (!pid || pid === 'auto') return autoServiceKid('search');
        return kidOfProv(pid);
      }
      return '';
    }

    /* 这一档的设置摆在**哪张账号卡**里：一定是「这一家声明了这一档」那一张；
       一家都没声明就不摆（留空 = 不画表单，也不往没这项能力的卡里硬塞）。
       与「谁顶着」是两件事：识别看 providerId / 搜索看 provider，没选时用自动那一家。 */
    function hostKidOf(cap) {
      if (cap === 'text') return kidOfProv(curTextId());
      if (cap !== 'asr' && cap !== 'search') return '';
      /* 在线识别只找云供应商；本机识别有一张自己的常驻卡，不参与这里的选择。 */
      const list = listedAccounts(lastAcctAll).filter(m => m.caps.indexOf(cap) >= 0 && !m.local);
      if (!list.length) return '';
      let want = '';
      if (cap === 'asr') {
        want = kidOfProv(asr.service.providerId);
        if (!want) want = autoServiceKid('asr');
      } else {
        const pid = String(search.provider || '');
        if (pid && pid !== 'auto' && pid !== 'tavily') want = kidOfProv(pid);
        else if (!pid || pid === 'auto') want = autoServiceKid('search');
      }
      if (want && list.some(m => m.keyId === want)) return want;
      const usable = list.find(m => provUsable(m));
      return (usable || list[0]).keyId;
    }

    /* ---------- 手动加一档能力（这一家其实还做某一档，只是注册表没写） ----------
       注册表里「这家会哪几档」是**声明出来的**（provider 的 kind，以及 extraCaps + asr/search
       端点声明；见 provGroups 里那段说明）—— 平台后来支持了新的一档、或者这一家其实是中转站
       而上游还有别的档时，界面上原来没有地方表达，只能改 proxy.js 的 REGISTRY 再重启代理。
       这里补一份**本机声明**：
         sk_caps_<keyId> = ["video","asr"]（与「自己填的型号」「暂时不用」同属「这一家的事」）
       它只声明「这一档在界面里存在」，型号也由你自己填（sk_model_prefs 那份清单本来就按账号存）。
       ⚠ **真能生成**还要注册表那边有一条端点声明 —— 生成三档（图片 / 视频 / 语音合成）手动加进来时，
       那一行必须把这句话写在脸上（见 capRowHTML 的 manual-note），不能让人以为加完就能出图。
       语音识别也一样：手动声明之后走的是这名账号自己的 base + 密钥 + OpenAI 兼容的
       /audio/transcriptions（这一族的形状是通用的）。**搜索不加**：每家搜索接口的端点与返回字段
       都不一样，没有一条能通用的形状 —— 手动加进来只会得到一次对不上的失败。
       **不提供手动加「文字对话」**：那一档必须是注册表里 `kind: 'text'` 的那一条（TextAI 按 kind 筛，
       不是按 keyId 认），加在别家身上点了也不会生效 —— 要另接一家文字供应商走「添加供应商」里的自定义。 */
    const MANUAL_OK = ['image', 'video', 'audio', 'asr'];
    const manualCapsOf = kid => {
      try {
        const arr = JSON.parse(window.LS.get('sk_caps_' + kid) || '[]');
        return Array.isArray(arr) ? arr.filter(c => typeof c === 'string' && MANUAL_OK.indexOf(c) >= 0) : [];
      } catch { return []; }
    };
    function setManualCaps(kid, arr) {
      const uniq = [...new Set(arr.filter(Boolean))];
      if (uniq.length) window.LS.set('sk_caps_' + kid, JSON.stringify(uniq));
      else window.LS.del('sk_caps_' + kid);
      markChanged();
    }

    /* 按「存密钥的那一格」（keyId）归并：一家平台同时服务几种模态时共用一把 sk_key_<keyId>，
       界面上也就只该有一张卡、一把密钥 —— 以前一张卡只画「当前那一档」，同一家的第二张卡在另一档里，
       卡底还要补一句「同一把密钥也用于：…」，那是把注册表的拆法直接摊给用户看。
       归并结果改成**账号 + 能力清单**：caps 是这家能开通的每一档，capProv 按档取回那一档自己的
       provider 声明（型号清单、端点、能力都按档各说各的，不能混着用）。 */
    function provGroups() {
      const merged = new Map();
      (REG.providers || []).forEach(p => {
        const keyId = p.keyId || p.id;
        let m = merged.get(keyId);
        if (!m) {
          m = { keyId, names: [], byKind: new Map(), caps: [], credits: null, site: '',
            base: p.base || '', prov: p, custom: !!p.custom, shapeName: p.customShapeName || '' };
          merged.set(keyId, m);
        }
        m.names.push(p.name);
        if (!m.site && p.site) m.site = p.site;
        if (!m.base && p.base) m.base = p.base;
        if (!m.byKind.has(p.kind)) m.byKind.set(p.kind, p);
        if (p.endpoints && p.endpoints.credits && !m.credits) m.credits = { relay: p.relay, ep: p.endpoints.credits };
      });
      const all = [...merged.values()];
      all.forEach(m => {
        m.name = (m.names[0] || '').split(' ')[0];
        /* 档的顺序跟着 ui.js 那份 provKinds()（全站唯一），自定义那几家声明了第五种也不会漏画。 */
        const kinds = window.provKinds().filter(k => m.byKind.has(k));
        const extra = [...m.byKind.keys()].filter(k => kinds.indexOf(k) < 0);
        const plat = kinds.concat(extra);
        /* 语音识别 / 联网搜索不是「有文字档就等于会」：前者要一个真的收音频的转写端点，
           后者要一套真的返回网址的搜索接口。两样都由 provider 自己声明 `extraCaps` +
           一份端点声明（`asr` / `search`）；没声明的家**不画**这两档 ——
           画上去再点，用户只会得到一次对不上的失败，还会以为是自己密钥填错了。 */
        const hasText = m.byKind.has('text');
        const extras = new Set();
        [...m.byKind.values()].forEach(p => (p.extraCaps || []).forEach(c => extras.add(c)));
        const chatCaps = hasText ? EXTRA_CAPS.map(kv => kv[0]).filter(c => extras.has(c)) : [];
        const declared = plat.concat(chatCaps);
        /* 本机手动声明的那几档排在有声明的那几档后面（它们不在注册表里，是这家「其实还做」的） */
        const manual = manualCapsOf(m.keyId)
          .filter(c => allCaps().indexOf(c) >= 0 && declared.indexOf(c) < 0);
        m.manualCaps = new Set(manual);
        m.caps = declared.concat(manual);
        m.kindLabel = m.caps.map(capZh).join('+');
        m.prov = capProv(m, m.caps[0]) || m.prov;
      });
      /* 本机 / 浏览器内识别：设置页合成的**常驻账号**（不是注册表里的云供应商）。
         它永远有一档语音识别、永远可用、不需要密钥；本机运行包与浏览器内模型都归它 ——
         云供应商卡里只留在线识别，两者不再混在一张卡上。 */
      all.push({
        keyId: LOCAL_ASR_KID, names: ['本机 / 浏览器内识别'], name: '本机 / 浏览器内识别',
        byKind: new Map(), caps: ['asr'], kindLabel: '语音识别', local: true,
        credits: null, site: '', base: '', custom: false, shapeName: '', manualCaps: new Set(),
        prov: { id: LOCAL_ASR_KID, keyId: LOCAL_ASR_KID, kind: 'text', name: '本机 / 浏览器内识别',
          base: '', endpoints: {}, extraCaps: ['asr'], local: true },
      });
      return all;
    }
    /* 这一档在这家对应的 provider 声明（型号清单 / 端点都按它算）。
       语音识别 / 联网搜索两档没有自己的 kind：它们是**文字那家**的两种用途，
       所以取这一家的文字那一条（这一档本身由 extraCaps + asr/search 声明确认过）。
       手动声明的那一档（m.manualCaps）在注册表里没有对应条目 —— 借这一家自己的身份
       （id / keyId / relay / base / keyEnv）合成一条**只用于界面**的声明：endpoints 空着，
       于是型号面板不会画「取一次」（真的没有那个接口），只剩「自己填」。
       手动声明只留语音识别（走这家自己的 OpenAI 兼容 /audio/transcriptions）；
       搜索没有可通用的接口形状，不提供手加 —— 加进来也只会得到一次对不上的失败。 */
    function capProv(m, cap) {
      if (m.local) return m.prov;
      if (cap === 'asr' || cap === 'search') {
        const hit = m.byKind.get('text');
        if (hit) return hit;
      } else {
        const hit = m.byKind.get(cap);
        if (hit) return hit;
      }
      if (m.manualCaps && m.manualCaps.has(cap)) {
        const base = m.prov || {};
        return { id: base.id || m.keyId, kind: cap, keyId: m.keyId, relay: base.relay,
          name: base.name, base: base.base || m.base, keyEnv: base.keyEnv,
          endpoints: {}, extraCaps: [], manual: true };
      }
      return null;
    }
    /* 「验证 / 取型号」该打哪一家的端点：优先有余额接口的，其次有型号接口的，最后回到文字档
       （文字那一家走 TextAI.verifyKey，注册表本来就没给它声明余额 / 型号端点）。 */
    function verifyProv(m) {
      const list = window.provKinds().map(k => m.byKind.get(k)).filter(Boolean);
      return list.find(p => p.endpoints && p.endpoints.credits)
        || list.find(p => p.endpoints && p.endpoints.models)
        || m.byKind.get('text') || list[0] || m.prov;
    }
    function keyState(m) {
      if (m.local) return '无需密钥';
      if (draftKey(m.keyId)) return '已填密钥';
      if ((envInfo[m.keyId] || {}).hasEnv) return '用服务端密钥';
      return '还没填密钥';
    }
    function provUsable(m) {
      if (m.local) return true;
      return (window.Api && Api.provUsable) ? Api.provUsable({ keyId: m.keyId, id: m.prov.id, custom: m.custom }, envInfo)
        : (!!m.custom || keyState(m) !== '还没填密钥');
    }
    /* 这一家被「暂时不用」停掉了没有：sk_off_ 按 keyId 存，所以一停就是这一家**所有**档一起停。
       acctOffSet 是「点了但还没落盘」那一档 —— 状态行那一句自动存本机是防抖之后才写的，
       不先读它，重画的一刻会按盘上的旧值把卡片弹回原样（点一下没反应）。 */
    const acctOff = m => m.local ? false : (acctOffSet.has(m.keyId)
      ? acctOffSet.get(m.keyId)
      : (window.Api ? Api.isOff(m.prov) : false));
    /* 一张卡里某一档此刻的状态牌：
       · 多选档（图片 / 视频 / 语音合成）没有「主位」，只有 在用 / 停用；
       · 单选档（文字对话 / 语音识别 / 联网搜索）多两态 —— 顶着的那家 = 主位，
         能顶但没顶着 = 备用。点状态牌做什么，见 capPlateClick。 */
    function capState(m, cap) {
      if (!provUsable(m) || acctOff(m)) return 'off';
      if (SOLO_CAP.has(cap)) return priKidOf(cap) === m.keyId ? 'pri' : 'alt';
      return 'on';
    }
    const CAP_STATE_ZH = { pri: '主位', on: '在用', alt: '备用', off: '停用' };
    /* 这一把密钥**现在是从哪来的** —— 写在卡上（三种来源：设置页 / .env / 刚清除还没落盘）。
       卡只有 300px 宽（三列），所以这里给两句：`short` 是行内那一句（一行放得下），
       `tip` 是完整解释（挂 title，含「点清除才会真的没有」这种长话）。两句话从同一处出，不会漂开。 */
    function keySourceOf(kid) {
      if (keyCleared.has(kid) && window.LS.get('sk_key_' + kid)) {
        return {
          short: '正在存进本机…',
          tip: '存好之前旧密钥还在用。',
        };
      }
      const local = !!draftKey(kid);
      const env = !!(envInfo[kid] && envInfo[kid].hasEnv);
      if (local && env) return {
        short: '设置页存着一把',
        tip: '留空 = 改回 .env。',
      };
      if (local) return {
        short: '设置页里存着的（sk_key_' + kid + '）',
        tip: '点「清除」才会真的没有。',
      };
      if (env) return { short: '服务端环境密钥（.env）', tip: '密钥来源：服务端环境密钥（.env 或系统环境变量）' };
      return { short: '还没有密钥', tip: '密钥来源：还没有（在上面填一把，或在 .env 里配同名变量）' };
    }
    const keySourceNote = kid => keySourceOf(kid).short;
    function refreshProvNotes() {
      qa('[data-ksrc]').forEach(sp => {
        const kid = sp.dataset.ksrc;
        if (!kid) return;
        const s = keySourceOf(kid);
        sp.textContent = s.short;          /* 纯文本：这一句里不再带 <b>/<code>，所以不走 innerHTML */
        sp.title = s.tip;
      });
      if (acctSumPainter) acctSumPainter();
    }

    /* ---------- 型号面板的槽位 ----------
       一格面板 = 「keyId:档」。同一把密钥下每一档各有自己的接口声明（型号清单、端点按档各说各的），
       所以「展开的是哪一格」「刚从哪一家的接口取回的那一份」都按槽存 —— 以前只有一个 keyId，
       一家同时做图片与视频时两档抢同一格（取回的清单串档）。
       ⚠ 但「自己填的 id」与「藏起来的那几个」记在**账号**上（sk_model_prefs 按 keyId 存）：
       这是存储层的事实，界面不装作按档各存一份，面板里那一行 hint 照实说出来。 */
    const slotKey = (kid, cap) => String(kid) + ':' + String(cap);
    const slotKid = s => String(s || '').slice(0, Math.max(0, String(s || '').lastIndexOf(':')));
    const slotCap = s => String(s || '').slice(String(s || '').lastIndexOf(':') + 1);
    const slotOfProv = p => (p ? slotKey(p.keyId || p.id, p.kind) : '');
    function provBySlot(slot) {
      const m = provRows.get(slotKid(slot));
      return m ? capProv(m, slotCap(slot)) : null;
    }
    const fetchNote = new Map();       // slot → {state:'busy'|'done'|'err', n, ms, why}
    const allCaps = () => (window.provKinds ? window.provKinds() : [])
      .concat(EXTRA_CAPS.map(kv => kv[0]));
    /* 状态牌的四态在卡顶能力条与每一档行上是同一枚东西：实心 = 主位、淡底 = 在用、
       白底 = 备用、压暗 = 停用 / 还没接上。点它做什么必须写在 title 里（两档的语义不一样）。 */
    function plateTitle(m, cap, st) {
      if (st === 'off') {
        if (acctOff(m)) return '这一家勾了「暂时不用」—— 点一下取消（按账号存：它名下 ' + m.kindLabel + ' 一起恢复）';
        return '这一档还没接上：点名字右边那颗「密钥」填一把才算接上';
      }
      if (!SOLO_CAP.has(cap)) {
        return '这一档在用 · 点一下把这一家「暂时不用」（按账号存，它名下 ' + m.kindLabel + ' 一起停）';
      }
      return st === 'pri'
        ? '这一档现在走这家'
        : '点一下让这一档走这家';
    }
    function capPlateClick(m, cap) {
      const st = capState(m, cap);
      if (acctOff(m)) {
        acctOffSet.set(m.keyId, false);
        markChanged();
        renderProv();
        Toast.receipt('「' + m.name + '」已重新启用', 'ok');
        return;
      }
      if (st === 'off') {
        Toast.receipt('「' + m.name + '」还没接上，点「密钥」填一把', 'warn');
        keyOpen.add(m.keyId);
        renderProv();
        return;
      }
      if (!SOLO_CAP.has(cap)) {
        acctOffSet.set(m.keyId, true);
        markChanged();
        renderProv();
        Toast.receipt('「' + m.name + '」暂时不用：这一停是按账号停的，它名下 ' + m.kindLabel + ' 一起不进型号下拉（历史任务照常能看）', 'ok');
        return;
      }
      if (st === 'pri') { Toast.receipt('这一档走「' + m.name + '」', 'info'); return; }
      const p = capProv(m, cap);
      if (cap === 'text') {
        textPickDraft = (p && p.id) || '';
        markChanged();
        renderProv();
        Toast.receipt('文字对话改走「' + m.name + '」（润色、识图、助手都发给它）—— 原本那家降为备用', 'ok');
        return;
      }
      if (cap === 'asr') {
        if (m.local) {
          /* 本机识别这一家 = 浏览器内 / 本机两条路：模型已就绪优先浏览器内，
             本机运行包可用就用本机，都没有就选浏览器内（首次识别会去下模型）。 */
          asr.route = (asrBrowser.value && asrBrowser.value.complete) ? 'browser'
            : (asrLocal.value && asrLocal.value.available) ? 'local' : 'browser';
          markChanged();
          renderProv();
          Toast.receipt('语音识别改走「本机 / 浏览器内」', 'ok');
          return;
        }
        asr.service.providerId = (p && p.id) || '';
        /* 换了一家就把型号清回「用这一家的默认值」：上一家的型号（比如 whisper-1）
           被原样发给一家根本没有这个型号的上游，只会得到一次 400。 */
        asr.service.model = '';
        /* 点的是云供应商 = 这次要在线识别；不改成 service 的话，自动模式会先被
           浏览器内 / 本机截走，点了看起来没反应。 */
        asr.route = 'service';
        markChanged();
        renderProv();
        Toast.receipt('在线识别的渠道改成「' + m.name + '」', 'ok');
        return;
      }
      /* 搜索服务 = 这家自己的搜索接口（不是把渠道换个名字）；密钥默认用这家账号那把。 */
      search.provider = (p && p.id) || 'auto';
      if (!search.enabled) search.enabled = true;
      if (search.credentialSource !== 'channel') search.credentialSource = 'channel';
      markChanged();
      renderProv();
      syncServiceProvs();
      Toast.receipt('联网搜索改走「' + m.name + '」', 'ok');
    }
    /* 一档一行：能力名 · 状态牌 ·（只有文字档带着那一个型号下拉 = 全站润色在用的 sk_model_<keyId>，
       不是「每档一个默认型号」那种新东西）·「型号 n/m」就地展开这一档的清单。
       语音识别 / 联网搜索两档没有型号清单（型号就在自己那张表单里填），所以那一格换成型号读数。 */
    function capRowHTML(m, cap) {
      const p = capProv(m, cap);
      if (!p) return '';
      const es = window.esc(slotKey(m.keyId, cap));
      const st = capState(m, cap);
      const open = panelOpen.has(slotKey(m.keyId, cap));
      const chan = cap === 'asr' || cap === 'search';
      /* 识别这一档读「实际会发的型号」：设置里没填就按这家声明的默认型号；
         本机识别那一张读的是当前路线；搜索只有 chat 那一族要型号（OpenRouter）。 */
      const asrRoute = asrEffectiveRoute();
      const model = m.local
        ? (asrRoute === 'browser' ? '浏览器内 Whisper' : asrRoute === 'local' ? '本机 whisper.cpp' : '在线服务')
        : cap === 'asr' ? (asr.service.model || (p.asr && p.asr.model) || 'whisper-1')
          : cap === 'search' ? ((p.search && p.search.style === 'chat') ? (search.model || '未填型号') : '接口默认')
            : '';
      const isManual = !!(p.manual || (m.manualCaps && m.manualCaps.has(cap)));
      return '<div class="crow' + (st === 'off' ? ' dim' : '') + '" data-crow="' + es + '">'
        + '<span class="cn"><span class="cg">' + capGlyph(cap) + '</span>' + window.esc(capZh(cap))
          + (isManual ? '<i class="manual" title="手动加的">手动</i>' : '')
        + '</span>'
        + '<button class="st st-btn ' + st + '" type="button" data-cap-toggle="' + es + '"'
          + ' title="' + window.esc(plateTitle(m, cap, st)) + '">' + CAP_STATE_ZH[st] + '</button>'
        + (chan
          ? '<span class="hint sm" title="' + window.esc(cap === 'asr' ? '这一档实际发出去的型号' : '搜索接口由这家自己的端点执行') + '">'
            + (cap === 'asr' ? '型号 ' : '') + '<code>' + window.esc(model || '默认') + '</code></span>'
          : '<button class="ghost xs' + (open ? ' active' : '') + '" type="button" data-panel="' + es + '"'
            + ' title="' + (open ? '收起型号清单' : '展开型号清单') + '">'
            + (open ? '收起型号 ' : '型号 ') + '<b data-mcount="' + es + '"></b></button>')
        + (isManual
          ? '<button class="ghost xs" type="button" data-cap-rm="' + es + '"'
            + ' title="撤掉这份声明">撤掉</button>'
          : '')
        /* 文字档的型号下拉 + 测试放在**主行之后**（.crow-sub 独占一整行）：
           主行因此只剩「能力名 + 状态牌 + 型号 n/m」，与别的档对齐；下拉拿到整行宽，型号 id 读得全。 */
        + (cap === 'text'
          ? '<div class="crow-sub"><select class="sel" data-tmodel="' + window.esc(m.keyId) + '"></select>'
            + '<button class="ghost xs" type="button" data-ttest="' + es + '"'
            + ' title="发测试消息">测试</button></div>'
          : '')
        + '</div>'
        /* 手动加的生成三档：注册表里没有端点声明 —— 不加这一句，用户会以为已经能出图。 */
        + (isManual && !chan && !SOLO_CAP.has(cap)
          ? '<div class="manual-note">注册表未声明端点，需在 REGISTRY 补。</div>'
          : '')
        + (isManual && chan
          ? '<div class="manual-note">走这家自己的地址与密钥。</div>'
          : '');
    }
    /* 账号卡里那一项的设置：文字档的识图、以及**这一家声明了的**语音识别 / 联网搜索。
       两档与图片 / 视频同一套规则：能力在哪家，设置就在那家卡里那一行下面；
       没有声明这一档的家不画、也不往它的卡里搬表单。 */
    function priFormHTML(m, cap) {
      if (cap === 'text') {
        const kid = window.esc(m.keyId);
        return '<div class="incard-form capform-text">'
          + '<div class="tai-h">' + ic('eye', 13) + '识图能力'
          + '</div>'
          + '<div class="krow thin"><span class="kn">参考图</span>'
          + '<select data-tvision="' + kid + '">'
          + '<option value="auto">自动</option>'
          + '<option value="on">支持识图</option>'
          + '<option value="off">不支持</option>'
          + '</select></div>'
          + '<div class="pb-tip" data-vtip="' + kid + '"></div>'
          + '</div>';
      }
      if (cap === 'asr') {
        return '<div class="formslot" data-formslot="' + (m.local ? 'asrLocal' : 'asr') + '"></div>';
      }
      if (cap === 'search') return '<div class="formslot" data-formslot="search"></div>';
      return '';
    }
    function modelPanelHTML(m, cap) {
      const slot = slotKey(m.keyId, cap);
      const es = window.esc(slot);
      const p = capProv(m, cap);
      const text = !!(p && p.kind === 'text');
      const canFetch = text || !!(p && p.endpoints && p.endpoints.models);
      return '<div class="mpanel" data-mblk="' + es + '">'
        + '<div class="mpanel-h"><span class="t">型号清单 · ' + window.esc(capZh(cap)) + '</span>'
          + '<span class="st alt" data-mfetch="' + es + '">还没取过</span><span class="sp"></span>'
          + (canFetch
            ? '<button class="ghost xs" type="button" data-tfetch="' + es + '"'
              + ' title="只读，不花钱">取一次型号清单</button>'
            : '<span class="hint sm">没有型号接口，自己填 id</span>')
        + '</div>'
        + '<div class="mpanel-h"><span class="hint" data-mnote="' + es + '"></span><span class="sp"></span>'
          + '<span class="hint">' + (text
            ? '点一行 = 全站润色用它。'
            : '勾掉 = 下拉里隐藏。') + '</span></div>'
        + '<div class="mlist" data-tchips="' + es + '"></div>'
        + '<div class="krow thin"><span class="kn">自己填</span>'
          + '<input data-tmnew="' + es + '" placeholder="逗号分隔">'
          + '<button class="ghost xs" type="button" data-tadd="' + es + '">添加</button></div>'
        + '<div class="msg" data-pmsg="' + es + '"></div>'
        + '</div>';
    }
    /* 「这一家还会做别的档」—— 手动声明一档（不认识的档加不出来，认识的档这里都能加）。
       展开时是一排可选档位（已经有声明的那几档不列）；加进来之后那一行带「手动」标记，
       型号清单没有「取一次」（注册表里没有那个接口），只留「自己填」。 */
    const capPickOpen = new Set();
    function capAddHTML(m) {
      const miss = allCaps().filter(c => MANUAL_OK.indexOf(c) >= 0 && m.caps.indexOf(c) < 0);
      const es = window.esc(m.keyId);
      const open = capPickOpen.has(m.keyId);
      if (!miss.length) {
        return open ? '' : '<div class="capadd"><span class="hint">这一家能手动加的那几档都加上了</span></div>';
      }
      if (!open) {
        return '<div class="capadd"><button class="ghost xs" type="button" data-cap-pick="' + es + '">'
          + '＋ 手动加一档能力</button>'
          + '<span class="hint">型号自己填</span></div>';
      }
      return '<div class="capadd capadd-open">'
        + '<div class="capadd-h"><span>手动加一档能力</span><span class="sp"></span>'
          + '<button class="ghost xs" type="button" data-cap-pick="' + es + '">收起</button></div>'
        + '<div class="pickrow">' + miss.map(c => '<button class="ghost xs pickchip" type="button"'
          + ' data-cap-add="' + es + '" data-cap="' + window.esc(c) + '">'
          + capGlyph(c) + ' ' + window.esc(capZh(c)) + '</button>').join('') + '</div>'
        + '<span class="hint">只是声明；生成类需 REGISTRY 补端点。</span>'
        + '</div>';
    }
    function capStripHTML(m) {
      return '<div class="capstrip">' + m.caps.map(cap => {
        const st = capState(m, cap);
        return '<button class="capcell ' + st + (acctFilter.value === cap ? ' hit' : '') + '" type="button"'
          + ' data-cap-toggle="' + window.esc(slotKey(m.keyId, cap)) + '"'
          + ' title="' + window.esc(capZh(cap) + ' · ' + CAP_STATE_ZH[st] + ' —— ' + plateTitle(m, cap, st)) + '">'
          + capGlyph(cap) + '</button>';
      }).join('') + '</div>';
    }
    function keyRowHTML(m) {
      const kid = window.esc(m.keyId);
      const ph = m.custom ? '这一家的密钥'
        : (envInfo[m.keyId] || {}).hasEnv ? '服务端密钥，留空即可' : '填写密钥，或使用默认';
      return '<div class="krow thin keyrow"><span class="kn">密钥</span>'
        + '<input type="password" data-key="' + kid + '" value="' + window.esc(draftKey(m.keyId)) + '"'
        + ' placeholder="' + window.esc(ph) + '">'
        + '<button class="ghost xs" type="button" data-eye="' + kid + '" title="显示 / 隐藏密钥">' + ic('eye', 13) + '</button>'
        + '<button class="ghost clr" type="button" data-clr="' + kid + '" title="清掉本机密钥">清除</button>'
        + '<button class="ghost xs" type="button" data-vfy="' + kid + '"'
        + ' title="只读验证，不扣费">验证</button>'
        + '</div>'
        + '<div class="krow thin"><span class="hint sm" data-ksrc="' + kid + '"'
          + ' title="' + window.esc(keySourceOf(m.keyId).tip) + '">' + window.esc(keySourceNote(m.keyId)) + '</span></div>'
        + '<div class="msg" data-msg="' + kid + '"></div>';
    }
    function keyBadge(m) {
      const s = keyState(m);
      return { cls: s === '已填密钥' ? 'ok' : (s === '用服务端密钥' || s === '无需密钥') ? 'on' : 'alt', zh: s };
    }
    /* 「本机 / 浏览器内识别」那一张常驻卡：没有密钥、余额、停用这些字段，
       只有一档语音识别与它的路线 / 本机运行包 / 浏览器内模型。 */
    function localAccountCardHTML(m) {
      const kid = window.esc(m.keyId);
      return '<div class="acct fcard local-asr" data-acct="' + kid + '">'
        + '<div class="fcard-h"><span class="fcard-ic">本</span>'
          + '<div class="fcard-tt"><div class="fcard-t"><span>本机 / 浏览器内识别</span></div>'
            + '<div class="fcard-d">不经过任何云供应商</div></div>'
          + '<span class="fcard-badge"><span class="st on">无需密钥</span></span></div>'
        + capStripHTML(m)
        + '<div class="acct-mid">'
          + m.caps.map(cap => capRowHTML(m, cap) + priFormHTML(m, cap)).join('')
        + '</div>'
        + '<div class="fcard-acts"><span class="hint sm">路线在下面选；本机运行包放 tools/whisper/</span></div>'
        + '</div>';
    }
    function accountCardHTML(m) {
      if (m.local) return localAccountCardHTML(m);
      const kid = window.esc(m.keyId);
      const off = acctOff(m);
      const kb = keyBadge(m);
      const open = keyOpen.has(m.keyId) || pendingAdds.has(m.keyId);
      /* 只有自定义那几家需要一句「这一家的地址在哪」：预设那几家的地址是注册表的事，
         卡上不摊官网地址、也不写「卡上不再改地址」那种话（用户点名不要）。 */
      const meta = m.custom
        ? ('转发到 <code>' + window.esc(m.prov.base) + '</code> · 接口形状取自「' + window.esc(m.shapeName) + '」'
          + ' · 名字 / 地址 / 型号清单点下面那颗「编辑」改')
        : '';
      const mid = (open ? keyRowHTML(m) : '')
        + m.caps.map(cap => capRowHTML(m, cap)
          + (((cap === 'asr' && m.local) || hostKidOf(cap) === m.keyId) ? priFormHTML(m, cap) : '')
          + (panelOpen.has(slotKey(m.keyId, cap)) ? modelPanelHTML(m, cap) : '')).join('')
        + capAddHTML(m);
      return '<div class="acct fcard' + (off ? ' acct-off' : '') + (m.custom ? ' cus' : '')
        + '" data-acct="' + kid + '">'
        + '<div class="fcard-h"><span class="fcard-ic">' + window.esc((m.name || '?').slice(0, 1).toUpperCase()) + '</span>'
          + '<div class="fcard-tt"><div class="fcard-t">'
            + (m.site
              ? '<a class="site" href="' + window.esc(m.site) + '" target="_blank" rel="noopener" title="打开官网 '
                + window.esc(m.site) + '">' + window.esc(m.name) + '</a><span class="ext">↗</span>'
              : '<span>' + window.esc(m.name) + '</span>')
            + '<button class="keytoggle' + (open ? ' on' : '') + '" type="button" data-ktoggle="' + kid + '"'
              + ' title="密钥设置' + (open ? '（点一下收起来）' : '（默认收着，点一下才摊开）') + '">密钥 '
              + (open ? '▴' : '▾') + '</button>'
            + (m.custom ? '<span class="st alt">自定义</span>' : '')
            + '</div>' + (meta ? '<div class="fcard-d">' + meta + '</div>' : '') + '</div>'
          + '<span class="fcard-badge"><span class="st ' + kb.cls + '">' + kb.zh + '</span></span></div>'
        + capStripHTML(m)
        + '<div class="acct-mid">' + mid + '</div>'
        + '<div class="fcard-acts">'
          + '<label class="check' + (m.credits ? '' : ' dim') + '" title="'
            + (m.credits ? '勾选后在左侧栏「账户余额」里显示这一家的余额（改完自动存进本机）'
              : '这一家没有提供余额查询接口，勾了也不会显示余额')
            + '"><input type="checkbox" data-bal="' + kid + '"' + (window.SbBal && SbBal.isOff(m.keyId) ? '' : ' checked') + '>侧栏余额</label>'
          + '<label class="check" title="勾上 = 这一家不进工作台的型号下拉（按账号停：它名下 '
            + window.esc(m.kindLabel) + ' 一起停；历史任务照常能看）。改完自动存进本机">'
            + '<input type="checkbox" data-off="' + kid + '"' + (off ? ' checked' : '') + '>暂时不用</label>'
          + '<span class="sp"></span>'
          + (m.custom
            ? '<button class="ghost xs" type="button" data-cedit="' + kid + '">编辑</button>'
              + '<button class="ghost xs danger" type="button" data-cdel="' + kid + '">删除</button>'
            : '')
          + '<span class="hint sm" data-acctmsg="' + kid + '"></span>'
        + '</div></div>';
    }
    /* 「添加供应商」那张卡：**两个形态、同一张卡**。
       常态 = 注册表里还接着、本机还没接进来的那几家（点「添加」把它请进界面，卡里摊开密钥行）；
       展开自定义 = 这张卡自己变成「添加自定义供应商」，字段就在卡里填（没有第二套添加界面，
       也没有另一层弹窗 / 另一张旧式 .card）。收起就是右上角那颗「返回预设」。 */
    function presetAccounts(all) {
      return all.filter(m => !m.custom && !provUsable(m) && !pendingAdds.has(m.keyId));
    }
    function presetRowHTML(m) {
      const glyphs = m.caps.map(capGlyph).join('');
      return '<div class="preset"><span class="pg">' + window.esc((m.name || '?').slice(0, 1).toUpperCase()) + '</span>'
        + '<div class="pw"><span class="pn">' + window.esc(m.name) + '</span>'
        + '<span class="pnote">' + window.esc(m.kindLabel) + ' · ' + window.esc(m.base)
        + ((envInfo[m.keyId] || {}).hasEnv ? ' · <code>.env</code> 里已有密钥' : '') + '</span></div>'
        + '<span class="pcaps" title="' + window.esc(m.kindLabel) + '">' + glyphs + '</span>'
        + '<button class="ghost xs" type="button" data-preset="' + window.esc(m.keyId) + '">添加</button></div>';
    }
    function addTileHTML(all) {
      const rest = presetAccounts(all);
      const custom = cusShown.value;
      return '<div class="acct fcard add-tile' + (custom ? ' cus-open' : '') + '" data-acct="__add__">'
        + '<div class="fcard-h">'
          + '<div class="fcard-tt"><div class="fcard-t"><span>'
            + (custom ? '添加自定义供应商' : '添加供应商') + '</span></div></div>'
        + (custom
          ? '<span class="fcard-badge"><button class="ghost xs" type="button" data-cus-close="1">返回预设</button></span>'
          : '<span class="fcard-badge"><span class="st alt">待接入 ' + rest.length + '</span></span>')
        + '</div>'
        + (custom
          ? '<div class="acct-mid"><div class="formslot" data-formslot="cus"></div></div>'
          : '<div class="acct-mid">'
            + (rest.length ? rest.map(presetRowHTML).join('')
              : '<div class="mlist-empty">注册表里的都请进来了。</div>')
            + '<button class="ghost wide" type="button" data-cus-open="1">＋ 自定义（中转站 / 网关 / 企业部署）</button>'
            + '</div>')
        + '</div>';
    }

    /* ---------- 芯片 / 摘要条 ---------- */
    let lastAcctShown = [];
    function paintSumLine() {
      const el = q('[data-fsum]');
      if (!el) return;
      const all = lastAcctAll;
      if (window.Api && Api.regFailed && Api.regFailed()) {
        el.className = 'fsum err';
        el.innerHTML = '<b>读不到注册表</b><span class="hint sm">代理未启动 —— 跑启动.bat 再刷新。</span>';
        return;
      }
      const cap = acctFilter.value;
      /* 本机识别那一张是合成的常驻账号：算账号数，但不参与「密钥配了几家」。 */
      const cloud = all.filter(m => !m.local);
      const noKey = cloud.filter(m => !provUsable(m)).length;
      const localN = all.length - cloud.length;
      if (cap === 'all') {
        el.className = 'fsum';
        el.innerHTML = '<b>' + all.length + ' 家账号</b><span class="hint sm">密钥已经配上 '
          + (cloud.length - noKey) + ' 家' + (noKey ? ' · 还差密钥 ' + noKey + ' 家' : '')
          + (localN ? ' · 本机 ' + localN + ' 家（无需密钥）' : '')
          + '</span>';
        return;
      }
      const list = lastAcctShown;
      const on = list.filter(m => { const s = capState(m, cap); return s === 'pri' || s === 'on'; }).length;
      const alt = list.filter(m => capState(m, cap) === 'alt').length;
      const off = list.length - on - alt;
      el.className = 'fsum';
      el.innerHTML = '<b>做「' + window.esc(capZh(cap)) + '」的 ' + list.length + ' 家</b>'
        + '<span class="hint sm">在用 ' + on + ' 家' + (alt ? ' · 备用 ' + alt + ' 家' : '')
        + (off ? ' · 没接上 ' + off + ' 家' : '') + ' —— 按「在用 → 备用 → 没接上」排，'
        + '同档里能力多的在前；被筛的那一格在能力条上圈了出来。</span>'
        + '<span class="sp"></span><button class="ghost xs" type="button" data-fchip="all">看全部 '
        + all.length + ' 家</button>';
    }
    let toolsWired = false;
    function paintTools() {
      const el = acctToolsEl.value;
      if (!el) return;
      const chip = (id, zh, n) => '<button class="fchip' + (acctFilter.value === id ? ' on' : '') + '"'
        + ' type="button" data-fchip="' + id + '" title="' + window.esc('只看有「' + zh + '」这一档的那几家（数字是账号数）') + '"><span>'
        + window.esc(zh) + '</span>' + (n == null ? '' : '<b class="n">' + n + '</b>') + '</button>';
      el.innerHTML = '<div class="filters">' + chip('all', '全部', lastAcctAll.length)
        + allCaps().map(c => chip(c, capZh(c), lastAcctAll.filter(m => m.caps.indexOf(c) >= 0).length)).join('')
        + '</div><div class="fsum" data-fsum></div>';
      acctSumPainter = paintSumLine;
      paintSumLine();
      if (!toolsWired) {
        toolsWired = true;
        el.addEventListener('click', ev => {
          const b = ev.target.closest && ev.target.closest('[data-fchip]');
          if (!b) return;
          ev.preventDefault();
          acctFilter.value = b.dataset.fchip;
          renderProv();
        });
      }
    }
    /* 代理把注册表里读不懂的条目丢掉、或者那份型号偏好读不出来 —— 必须通栏说出来，不藏进卡片网格。 */
    function paintRegErr() {
      const el = provErrEl.value;
      if (!el) return;
      const lines = [];
      if (window.Api && Api.regFailed && Api.regFailed()) {
        lines.push('读不到注册表：本地代理没连上或还没启动' + (Api.regError ? '（原因：' + Api.regError() + '）' : '')
          + '。先把 proxy.js 启动起来再刷新这一页。');
      }
      const cu = REG && REG.custom;
      const dropped = (cu && cu.dropped) || [];
      if (dropped.length || (cu && cu.reason)) {
        lines.push('有 ' + dropped.length + ' 条自定义平台没被本地代理认：'
          + dropped.map(d => '「' + d.id + '」' + d.why).join('；') + (cu.reason ? '（' + cu.reason + '）' : '') + '。');
      }
      const mp = REG && REG.modelPrefs;
      if (mp && mp.reason) {
        lines.push('「自己填的型号」与「隐藏 / 展示」那份记录读不懂：' + mp.reason
          + ' —— 修好之前在这里勾了也不会变，工作台上看到的仍是接口给的那一份原始清单。');
      }
      el.innerHTML = lines.map(t => '<div class="msg err">' + window.esc(t) + '</div>').join('');
    }

    /* 卡片等高（--sz-acct）+ 卡内那一段自己滚：展开密钥行、展开型号面板都不改卡的外形，
       所以整片重画时唯一要还回去的是「卡里那一段滚到了哪」。 */
    function midScrolls() {
      const out = new Map();
      qa('.acct .acct-mid').forEach(el => {
        const card = el.closest ? el.closest('.acct') : null;
        if (card) out.set(card.dataset.acct, el.scrollTop);
      });
      return out;
    }
    function restoreMidScrolls(map) {
      qa('.acct .acct-mid').forEach(el => {
        const card = el.closest ? el.closest('.acct') : null;
        const v = card ? map.get(card.dataset.acct) : 0;
        if (v) el.scrollTop = v;
      });
    }
    function listedAccounts(all) {
      return all.filter(m => provUsable(m) || pendingAdds.has(m.keyId));
    }
    function filteredAccounts() {
      const all = listedAccounts(lastAcctAll);
      const cap = acctFilter.value;
      const list = cap === 'all' ? all.slice() : all.filter(m => m.caps.indexOf(cap) >= 0);
      const rank = m => {
        if (cap === 'all') return 0;
        const s = capState(m, cap);
        return (s === 'pri' || s === 'on') ? 0 : (s === 'alt' ? 1 : 2);
      };
      return list.sort((a, b) => rank(a) - rank(b)
        || (cap === 'all' ? (a.custom === b.custom ? 0 : (a.custom ? 1 : -1)) : b.caps.length - a.caps.length));
    }

    function renderProv() {
      if (!provListEl.value) return;
      lastAcctAll = provGroups();
      provEpoch.value++;
      provRows.clear();
      lastAcctAll.forEach(m => provRows.set(m.keyId, m));
      lastAcctShown = filteredAccounts();
      paintTools();
      paintRegErr();
      const keep = midScrolls();
      provListEl.value.innerHTML = lastAcctShown.map(accountCardHTML).join('') + addTileHTML(lastAcctAll);
      restoreMidScrolls(keep);
      /* 本机存的和服务端内置的是同一把 → 说明是误存的默认密钥，清掉，保持输入框为空。
         判据带长度（不止末 4 位）：tail 相同的两把不同密钥概率虽小但不是零；server 的 /env-status 带 len。
         走 keyCleared 那一套（跟「清除」按钮同一条路）：删除排队进自动保存、顶栏回执照说 ——
         以前在渲染里直接 LS.del，绕过了「改完就存本机 · 刚刚存过」的状态行。 */
      lastAcctShown.forEach(m => {
        if (m.custom || !(envInfo[m.keyId] || {}).hasEnv) return;
        const lk = keyFor(m.keyId);
        if (!lk || lk.slice(-4) !== envInfo[m.keyId].tail || lk.length !== envInfo[m.keyId].len) return;
        keyDraft.delete(m.keyId);
        keyCleared.add(m.keyId);
        markChanged();
        const inp = q('[data-key="' + window.esc(m.keyId) + '"]');
        if (inp) inp.value = '';
      });
      if (textForm) textForm.paint();
      placeForms();
      wireAcct();
      if (window.Dropdowns && provListEl.value) Dropdowns.build(provListEl.value);
      /* 手加 / 撤掉一档语音识别之后，「在线服务商」那份候选要跟着变。 */
      syncServiceProvs();
    }

    /* ---------- 卡片流里的动作：一次绑定、整片重画后不用补绑 ----------
       网格每次都是 provListEl.innerHTML 重来，所以事件挂在**容器**上（委托）。
       旧写法每次重画都要 `[data-x].forEach(el => el.onclick = …)` 补一遍，漏一处就是那颗按钮点不动。 */
    let acctWired = false;
    function setMsg(kid, text, cls) {
      const el = msgOf(kid);
      if (!el) return;
      el.className = cls; el.textContent = text;
    }
    /* 卡底那一行的回执（型号面板没开、或这一档根本没有面板时用它）。 */
    function acctMsg(kid, text, cls) {
      const el = q('[data-acctmsg="' + window.esc(kid) + '"]');
      if (!el) return;
      el.className = 'hint sm ' + (cls || '');
      el.textContent = text;
    }
    /* 卡里那一段（.acct-mid）自己滚：就地展开型号面板时把新出来的那一格滚进视野。
       这里**不用** scrollIntoView —— 它会把外面那条文档一起滚（页面上跳），而滚卡里那一段
       只需要动 .acct-mid.scrollTop；这一页滚动的唯一出口仍是 scrollToEl（那一条只管文档）。 */
    function revealInMid(el) {
      const mid = el && el.closest ? el.closest('.acct-mid') : null;
      if (!mid) return;
      const r = el.getBoundingClientRect(), b = mid.getBoundingClientRect();
      const d = r.bottom - b.bottom, u = b.top - r.top;
      if (d > 0) mid.scrollTop += d + 8;
      else if (u > 0) mid.scrollTop -= u + 8;
    }

    /* 三块 Vue 表单往哪摆：语音识别 / 联网搜索 → 声明了这一档的那张账号卡里那一行下面；
       自定义供应商 → 「添加供应商」卡展开时的那一格。网格每次 innerHTML 重来，
       所以每次画完都要再搬一次；没有落点（没有哪家声明 / 卡没展开）就回到 hidden 的停靠格，
       屏幕上不画 —— 不往不相干的卡里硬塞。 */
    const MOVERS = () => [['asr', asrFormEl.value], ['asrLocal', asrLocalFormEl.value],
      ['search', searchFormEl.value], ['cus', cusCardEl.value]];
    function placeForms() {
      MOVERS().forEach(([cap, el]) => {
        if (!el) return;
        const slot = q('[data-formslot="' + cap + '"]');
        if (slot && el.parentNode !== slot) slot.appendChild(el);
        else if (!slot && acctParkEl.value && el.parentNode !== acctParkEl.value) acctParkEl.value.appendChild(el);
      });
    }

    /* 「验证」用的是**这一栏现在的值**（含还没保存的那把），问一次只读接口，不建任务、不扣费。 */
    async function verifyAccount(kid, btn) {
      const m = provRows.get(kid);
      if (!m) return;
      const p = verifyProv(m);
      btn.disabled = true;
      const via = window.Api ? Api.verifyTarget(p) : { via: '', label: '' };
      const to = p && p.base;
      if (!via.via) {
        setMsg(kid, via.label || '', 'msg');
        let r = { state: 'unknown', text: '' };
        try {
          useFormCreds(p);
          r = await TextAI.verifyKey(REG, p);
        } catch (e) { r.text = errText(e); }
        btn.disabled = false;
        const ok = r.state === 'ok';
        setMsg(kid, (ok ? '✓ ' : r.state === 'invalid' ? '✗ ' : '· ') + (r.text || '') + '（转发到 ' + to + '）',
          'msg ' + (ok ? 'ok' : r.state === 'invalid' ? 'err' : ''));
        return;
      }
      setMsg(kid, '正在用这一栏里的密钥问一次「' + via.label + '」…', 'msg');
      let r = { ok: false, detail: '', why: '' };
      try { r = await Api.verify(p, { key: draftKey(kid), base: null }); } catch (e) { r.why = errText(e); }
      btn.disabled = false;
      setMsg(kid, (r.ok ? '✓ ' : '✗ ') + (r.ok ? r.detail : r.why) + '（转发到 ' + to + '）', 'msg ' + (r.ok ? 'ok' : 'err'));
    }

    /* 打开「添加一家」那张卡里的自定义表：两个入口都是它（添加卡上的「＋ 自定义」、
       账户卡上的「＋ 添加一家（做…）」）—— 表单只在卡片里填，没有第二套添加界面。 */
    function openCusForm() {
      openCus();
      renderProv();
      nextTick(() => { if (cusCardEl.value) scrollToEl(cusCardEl.value); });
    }

    function onAcctClick(ev) {
      const t = ev.target;
      const kt = t.closest && t.closest('[data-ktoggle]');
      if (kt) {
        ev.preventDefault();
        const kid = kt.dataset.ktoggle;
        if (keyOpen.has(kid)) keyOpen.delete(kid); else keyOpen.add(kid);
        renderProv();
        if (keyOpen.has(kid)) { const inp = q('[data-key="' + window.esc(kid) + '"]'); if (inp) window.focusQuiet(inp); }
        return;
      }
      const cap = t.closest && t.closest('[data-cap-toggle]');
      if (cap) {
        ev.preventDefault();
        const m = provRows.get(slotKid(cap.dataset.capToggle));
        if (m) capPlateClick(m, slotCap(cap.dataset.capToggle));
        return;
      }
      const pn = t.closest && t.closest('[data-panel]');
      if (pn) {
        ev.preventDefault();
        const slot = pn.dataset.panel;
        if (panelOpen.has(slot)) panelOpen.delete(slot);
        else { panelOpen.add(slot); autofetchTried.delete(slot); }
        renderProv();
        if (panelOpen.has(slot)) revealInMid(q('[data-mblk="' + window.esc(slot) + '"]'));
        return;
      }
      const co = t.closest && t.closest('[data-cus-open]');
      if (co) { ev.preventDefault(); openCusForm(); return; }
      const cc = t.closest && t.closest('[data-cus-close]');
      if (cc) { ev.preventDefault(); hideCus(); return; }   /* hideCus 自己会把卡片流重画回「预设」那一形态 */
      /* 自定义供应商卡里那排能力档位（图标，可多选；第一个是主档） */
      const ccp = t.closest && t.closest('[data-cuscap]');
      if (ccp) { ev.preventDefault(); pickCusCap(ccp.dataset.cuscap); return; }
      /* 手动加一档能力：展开可选档位 / 加一档 / 撤掉一档 */
      const cpi = t.closest && t.closest('[data-cap-pick]');
      if (cpi) {
        ev.preventDefault();
        const kid2 = cpi.dataset.capPick;
        if (capPickOpen.has(kid2)) capPickOpen.delete(kid2); else capPickOpen.add(kid2);
        renderProv();
        return;
      }
      const cad = t.closest && t.closest('[data-cap-add]');
      if (cad) {
        ev.preventDefault();
        const kid3 = cad.dataset.capAdd, cap3 = cad.dataset.cap;
        setManualCaps(kid3, manualCapsOf(kid3).concat([cap3]));
        capPickOpen.delete(kid3);
        renderProv();
        /* 加完就把这一档的型号面板摊开 —— 型号得自己填，这是下一步唯一要做的事 */
        panelOpen.add(slotKey(kid3, cap3));
        renderProv();
        revealInMid(q('[data-mblk="' + window.esc(slotKey(kid3, cap3)) + '"]'));
        Toast.receipt('已给这一家加上「' + capZh(cap3) + '」—— 型号清单里自己填 id', 'ok');
        return;
      }
      const crm = t.closest && t.closest('[data-cap-rm]');
      if (crm) {
        ev.preventDefault();
        const kid4 = slotKid(crm.dataset.capRm), cap4 = slotCap(crm.dataset.capRm);
        setManualCaps(kid4, manualCapsOf(kid4).filter(c => c !== cap4));
        panelOpen.delete(slotKey(kid4, cap4));
        renderProv();
        Toast.receipt('已撤掉「' + capZh(cap4) + '」这一档', 'ok');
        return;
      }
      const pa = t.closest && t.closest('[data-preset]');
      if (pa) {
        ev.preventDefault();
        const kid = pa.dataset.preset;
        pendingAdds.add(kid);
        keyOpen.add(kid);
        renderProv();
        const inp = q('[data-key="' + window.esc(kid) + '"]');
        if (inp) { window.focusQuiet(inp); revealInMid(inp); }
        Toast.receipt('已把「' + ((provRows.get(kid) || {}).name || kid) + '」请进界面 —— 这一步什么都没写；'
          + '在摊开的那一栏填一把密钥才算接上（改完自动存进本机）', 'ok');
        return;
      }
      const eye = t.closest && t.closest('[data-eye]');
      if (eye) {
        ev.preventDefault();
        const inp = eye.closest('.krow') ? eye.closest('.krow').querySelector('[data-key]') : null;
        if (!inp) return;
        inp.type = inp.type === 'password' ? 'text' : 'password';
        eye.innerHTML = ic(inp.type === 'password' ? 'eye' : 'eyeOff', 13);
        eye.title = inp.type === 'password' ? '显示密钥' : '隐藏密钥';
        return;
      }
      const clr = t.closest && t.closest('[data-clr]');
      if (clr) {
        ev.preventDefault();
        const kid = clr.dataset.clr;
        const inp = clr.closest('.krow') ? clr.closest('.krow').querySelector('[data-key]') : null;
        if (inp) inp.value = '';
        keyDraft.delete(kid);
        keyCleared.add(kid);
        markChanged();
        clr.textContent = '已清除';
        clr.title = '这一项已经排队存进本机（顶栏那一句会说存好了没有）';
        setTimeout(() => { clr.textContent = '清除'; clr.title = '清掉本机存的这把密钥（存进本机后生效）'; }, 1500);
        refreshProvNotes();
        return;
      }
      const vf = t.closest && t.closest('[data-vfy]');
      if (vf) { ev.preventDefault(); verifyAccount(vf.dataset.vfy, vf); return; }
      const ce = t.closest && t.closest('[data-cedit]');
      if (ce) { ev.preventDefault(); editCus(ce.dataset.cedit); return; }
      const cd = t.closest && t.closest('[data-cdel]');
      if (cd) { ev.preventDefault(); removeCus(cd.dataset.cdel); return; }
    }
    function onAcctChange(ev) {
      const t = ev.target;
      const off = t.closest && t.closest('[data-off]');
      if (off) {
        acctOffSet.set(off.dataset.off, !!off.checked);
        markChanged();
        renderProv();
        return;
      }
      const bal = t.closest && t.closest('[data-bal]');
      if (bal) {
        if (window.SbBal) {
          const off2 = new Set(SbBal.off());
          if (bal.checked) off2.delete(bal.dataset.bal); else off2.add(bal.dataset.bal);
          SbBal.setList([...off2]);
        }
        markChanged();
      }
    }
    function onAcctInput(ev) {
      const t = ev.target;
      if (!(t.dataset && t.dataset.key)) return;
      keyCleared.delete(t.dataset.key);
      if (t.value.trim()) keyDraft.set(t.dataset.key, t.value.trim());
      else keyDraft.delete(t.dataset.key);
    }
    function wireAcct() {
      const el = provListEl.value;
      if (acctWired || !el) return;
      acctWired = true;
      /* 一张卡上有两类接线：卡自己的开关（密钥 / 状态牌 / 添加 / 验证 / 侧栏余额）与型号面板里的清单操作。
         各认各的那一族 data-*（面板那一族只出现在 [data-mblk] 里），互不抢，所以可以并挂在一个节点上。 */
      el.addEventListener('click', onAcctClick);
      el.addEventListener('click', onPanelClick);
      el.addEventListener('change', onAcctChange);
      el.addEventListener('change', onPanelChange);
      el.addEventListener('input', onAcctInput);
    }

    /* ---------- 添加自定义供应商 ----------
       界面只收：接口形状、显示名、地址、密钥、**能力档位**、型号清单；密钥按 sk_key_<新 id> 单独存。
       清单写成 sk_custom（DataSync 镜像成 .data/sk_custom.json，代理读那份合并进 /registry）。
       「能力档位」与卡顶那排能力格同一副图标、可多选：第一个选中的是**主档**（決定接口形状与端点，
       也决定这条自定义条目建出来是哪种 kind），其余按「本机手动声明」记在这一家上
       （`sk_caps_<新 id>`，与卡里「＋ 手动加一档能力」同一个键、同一套语义）。 */
    const cusShown = ref(false);
    const cusEditing = ref('');
    const cusShapeSel = ref('');
    const cusShapeOpts = ref([]);
    const cusShapeShown = ref(false);
    const cusName = ref('');
    const cusBase = ref('');
    const cusKey = ref('');
    const cusKeyShown = ref(false);
    const cusExtra = ref('');
    const cusFetched = ref([]);
    const cusFetchFrom = ref('');
    const cusOff = reactive(new Set());
    const cusModelRows = ref([]);
    const cusModelsEmpty = ref('');
    const cusMsg = ref('');
    const cusMsgCls = ref('');
    const cusCount = ref('');
    const cusAddText = ref('添加这一家');
    const cusCancelShown = ref(false);
    const cusFetchBusy = ref(false);
    const cusMineGroups = ref([]);
    const cusMineShown = ref(false);
    /* 能力档位：多选，**第一个 = 主档**（列表顺序就是选中顺序）。 */
    const cusCaps = ref(['image']);
    const cusNamePh = ref('型号下拉的分组名认的就是它');
    let cusAutoName = '';
    let cusAutoBase = '';

    /* 档 → 接口形状那一族。语音识别 / 联网搜索没有自己的接口族：它们跑在文字那一套上。 */
    const shapeKindOf = cap => (cap === 'asr' || cap === 'search') ? 'text' : cap;
    const cusKind = () => shapeKindOf(cusCaps.value[0] || 'image');
    function cusFamilies(kind) {
      return ((REG && REG.interfaceShapes) || {})[kind] || [];
    }
    const cusProvById = id => (REG.providers || []).find(p => p.id === id) || null;
    /* 照哪一家的接口形状：只按**主档**那一族找（没有了「先选一家内置平台」这一层，
       所以模板永远来自 interfaceShapes —— 这就是「你跑的是哪一套协议」那件事）。 */
    function cusTemplate() {
      const fam = cusFamilies(cusKind()).find(f => f.id === cusShapeSel.value);
      return fam ? cusProvById(fam.template) : null;
    }
    function cusSetMsg(text, cls) {
      cusMsg.value = text || '';
      cusMsgCls.value = cls || '';
    }
    function paintCusCount() {
      if (!cusCount) return;
      const caps = cusCaps.value;
      const list = Api.customList();
      cusCount.value = caps.map(capZh).join(' + ') + ' · 合计已接 ' + list.length + ' 家';
    }
    /* 显示名预填：按主档自动编号（「图片 1 / 视频 2」这种），换档跟着换，用户改过就不再动。 */
    function cusDefaultName(kind) {
      const zh = capZh(kind);
      const taken = new Set(Api.customList().filter(e => e && (e.kind || 'image') === kind).map(e => (e.name || '').trim()));
      for (let i = 1; i < 200; i++) { const n = i === 1 ? zh : zh + ' ' + i; if (!taken.has(n)) return n; }
      return zh;
    }
    function cusFillName() { cusAutoName = cusDefaultName(cusKind()); cusName.value = cusAutoName; }
    function cusSyncName() {
      if (cusEditing.value) return;
      const cur = String(cusName.value || '').trim();
      if (!cur || cur === cusAutoName) cusFillName();
    }
    function cusFillBase() {
      const t = cusTemplate();
      const b = (t && t.base) || '';
      cusAutoBase = b;
      cusBase.value = b;
    }
    function cusSyncBase() {
      const cur = String(cusBase.value || '').trim();
      if (!cur || cur === cusAutoBase) cusFillBase();
    }
    /* 「已添加的几家」列在这张卡里：按档分组、全部列出来（不再只列「当前那一档」—— 一排分段开关已经撤掉）。
       点某一家的「编辑」会把上面那一格「哪一档」切到它自己那一档，否则改了档就变成另一条声明。 */
    function paintCusMine() {
      const list = Api.customList().filter(e => e && e.id);
      cusMineShown.value = !!list.length;
      const kinds = window.provKinds();
      const extra = [...new Set(list.map(e => e.kind || 'image'))].filter(k => kinds.indexOf(k) < 0);
      cusMineGroups.value = kinds.concat(extra).map(k => {
        const mine = list.filter(e => (e.kind || 'image') === k);
        return {
          kind: k, zh: capZh(k),
          items: mine.map(e => ({ id: e.id, name: e.name || e.id, modelsN: (e.models || []).length })),
        };
      }).filter(g => g.items.length);
    }
    function openCus() {
      cusShown.value = true;
      if (cusEditing.value) cusReset();
      cusShapeSel.value = '';
      renderCus();
      nextTick(() => {
        if (cusCardEl.value) scrollToEl(cusCardEl.value);
        const focus = String(cusName.value || '').trim() ? cusBaseEl.value : cusNameEl.value;
        if (focus) window.focusQuiet(focus);
      });
    }
    /* 收起来 = 这一张卡不再占位；正在编辑的那一条原样留着（没点「保存这一家」就没动过它）。 */
    function hideCus() {
      cusShown.value = false;
      if (cusEditing.value) cusReset();
      renderProv();
      cusSetMsg('', '');
    }
    /* 能力档 → 接口形状 → 型号 联动：清单全取自 /registry 的声明。
       没有「先选一家内置平台」这一格了 —— 那条路就是「另一家内置平台」，与「添加自己的」是两件事；
       这一张卡只做后者（要接内置那几家，上面那张卡里点「添加」）。 */
    function renderCus() {
      const kind = cusKind();
      paintCusCaps();
      paintCusNamePh();
      paintCusCount();
      paintCusMine();
      const fams = cusFamilies(kind);
      cusShapeShown.value = true;
      cusShapeOpts.value = fams.length
        ? fams.map(f => ({ id: f.id, label: f.name }))
        : [{ id: '', label: '这一类还没有登记接口形状' }];
      const sk = cusShapeSel.value;
      cusShapeSel.value = fams.some(f => f.id === sk) ? sk : ((fams[0] && fams[0].id) || '');
      if (!fams.length) {
        cusModelsEmpty.value = '注册表没有这一类的接口形状。';
        cusModelRows.value = [];
        cusSyncBase();
        cusSyncName();
        nextTick(syncCusDropdowns);
        return;
      }
      cusSyncBase();
      cusSyncName();
      nextTick(syncCusDropdowns);
      rebuildCusModels();
    }
    /* 能力档位那一排图标：与卡顶那排能力格同一副（.capcell），点一下加/去；第一个选中的是主档。 */
    function paintCusCaps() {
      const el = cusCapEl.value;
      if (!el) return;
      const caps = cusCaps.value;
      el.innerHTML = allCaps().map(c => {
        const on = caps.indexOf(c) >= 0;
        const main = caps[0] === c;
        return '<button class="capcell' + (on ? ' on' : '') + (main ? ' main' : '') + '" type="button"'
          + ' data-cuscap="' + window.esc(c) + '" title="' + window.esc(capZh(c)
            + (main ? ' · 主档（决定接口形状与端点）' : on ? ' · 已选（手动声明的一档）' : ' · 点一下选中')) + '">'
          + capGlyph(c) + '</button>';
      }).join('')
        + '<span class="hint">点图标选档位，可多选；<b>第一个是主档</b>（决定接口形状与端点），'
        + '其余按「手动声明」记在这一家上。</span>';
    }
    function pickCusCap(cap) {
      const caps = cusCaps.value.slice();
      const i = caps.indexOf(cap);
      if (i >= 0) { if (caps.length === 1) return; caps.splice(i, 1); }
      else caps.push(cap);
      cusCaps.value = caps;      /* 换主档会换接口形状族 */
      renderCus();
    }
    /* 显示名的占位符按主档那几家已接的名字走（不再由「选了一家内置平台」自动填）。 */
    function paintCusNamePh() {
      cusNamePh.value = '例如「我的中转站」—— 型号下拉的分组名认的就是它';
    }
    function syncCusDropdowns() {
      if (!window.Dropdowns) return;
      [cusShapeEl.value].forEach(el => {
        if (!el) return;
        Dropdowns.build(el.parentElement || el);
        Dropdowns.sync(el);
      });
    }
    /* 型号清单：一律现取，不预填模板写死的那份；三个来源并成一份、默认全勾。 */
    function rebuildCusModels() {
      const t = cusTemplate();
      if (!t) { cusModelRows.value = []; return; }
      const saved = cusEditing.value ? (((Api.customList().find(e => e && e.id === cusEditing.value) || {}).models) || []) : [];
      const savedIds = saved.map(m => (m && m.id) || m).filter(Boolean);
      const typed = [...new Set(String(cusExtra.value || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean))];
      const all = [];
      const push = (id, name, tag) => { if (id && !all.some(x => x.id === id)) all.push({ id: String(id), name: name || id, tag }); };
      savedIds.forEach(id => push(id, (saved.find(m => (m && m.id) === id) || {}).name || id, 'saved'));
      cusFetched.value.forEach(m => push(m.id, m.name || m.id, 'fetched'));
      typed.forEach(id => push(id, id, 'typed'));
      const tagZh = { saved: '已保存', fetched: '接口返回', typed: '手填' };
      cusModelRows.value = all.map(x => ({ id: x.id, name: x.name, tag: x.tag, tagZh: tagZh[x.tag] || '' }));
      cusModelsEmpty.value = all.length ? ''
        : '可获取型号列表，或自己填 id。'
          + '这里不会替你预填内置那家的型号清单 —— 那是「内置那一家」的声明，中转站未必有。';
    }
    function onCusModelToggle(id, ev) {
      if (ev.target.checked) cusOff.delete(id); else cusOff.add(id);
    }
    function cusPicked() {
      return cusModelRows.value.filter(x => !cusOff.has(x.id)).map(x => ({ id: x.id }));
    }
    async function afterCustomChanged(droppedKid) {
      try { await DataSync.flush(); } catch (e) {}
      Api.clearCaches();
      setREG(await Api.registry().catch(() => null));
      Api.setRegistry(REG);
      renderProv();
      /* 注册表变了 → 「素材库」那张卡里的两个型号下拉要重画（型号清单换了）。 */
      renderCharsSet();
      paintCusCount();
      paintCusMine();
      try {
        if (window.SbBal) {
          const live = new Set((REG.providers || []).map(p => p.keyId || p.id).map(String));
          SbBal.setList(SbBal.off().map(String).filter(k => live.has(k)));
        }
        const top = window.top || window;
        if (droppedKid && top && typeof top.__sbBalanceDrop === 'function') top.__sbBalanceDrop(droppedKid);
      } catch (e) {}
    }
    function onCusShapeChange(ev) { if (ev && ev.target) cusShapeSel.value = ev.target.value; renderCus(); }
    function cusReset() {
      cusEditing.value = '';
      cusAddText.value = '添加这一家';
      cusCancelShown.value = false;
      cusName.value = ''; cusBase.value = ''; cusKey.value = ''; cusExtra.value = '';
      cusAutoName = '';
      cusCaps.value = ['image'];
      cusFetched.value = []; cusFetchFrom.value = ''; cusOff.clear();
      renderCus();
    }
    async function editCus(kid) {
      const e = Api.customList().find(x => x && x.id === kid);
      if (!e) { acctMsg(kid, '清单里找不到这一条（可能刚被删掉）—— 刷新一次页面看看。', 'err'); return; }
      /* 编辑哪一家：档位回填成「它自己的主档 + 手动声明的那几档」（与卡里那几行一致）。 */
      cusCaps.value = [e.kind || 'image'].concat(manualCapsOf(kid));
      cusShown.value = true;
      /* 「哪一张卡里有这一格」要重画网格才知道：添加卡里那个落点是 cusShown 变了才画出来的。 */
      renderProv();
      cusEditing.value = kid;
      cusOff.clear();
      cusAutoName = '';
      cusAutoBase = '';
      cusShapeSel.value = '';
      renderCus();
      /* 还原「当初选的是哪一族形状」：shapeId 是新写法，老条目只剩 shape（模板 provider id），
         照它反查回那一族。 */
      const fams = cusFamilies(e.kind);
      const byShapeId = e.shapeId && fams.some(f => f.id === e.shapeId) ? e.shapeId
        : ((fams.find(x => x.template === e.shape) || {}).id || '');
      if (byShapeId) cusShapeSel.value = byShapeId;
      renderCus();
      cusName.value = e.name || '';
      cusAutoName = '';
      cusAutoBase = '';
      cusBase.value = e.base || '';
      cusKey.value = keyFor(kid);
      cusExtra.value = '';
      cusFetched.value = []; cusFetchFrom.value = '';
      rebuildCusModels();
      cusAddText.value = '保存这一家';
      cusCancelShown.value = true;
      paintCusMine();
      cusSetMsg('正在改「' + (e.name || kid) + '」：改完点「保存这一家」，型号清单立刻按新的那份算。', '');
      nextTick(() => {
        syncCusDropdowns();
        /* 卡片刚从 hidden 里放出来时量位置才算数：同步那一行代码还在隐藏态里，滚不动。 */
        if (cusCapEl.value) scrollToEl(cusCapEl.value, 'center');
      });
    }
    async function removeCus(kid) {
      const e = Api.customList().find(x => x && x.id === kid);
      const wasText = (() => { try { return curTextId() === kid; } catch (err) { return false; } })();
      const go = await Confirm.ask({
        title: '删掉这一家？', danger: true, okLabel: '删除',
        sub: '删掉「' + ((e && e.name) || kid) + '」，连它名下的密钥、型号选择与「暂时不用」勾选一起清。',
        body: '已经生成的产物与历史不受影响（那些记在平台列表与本机资产里）。'
          + '以后还要用同一个网关就重新添加一家 —— 新的 id 不认旧密钥，需要重填一次。'
          + (wasText ? '\n\n注意：这一家是当前文字 AI，删掉后会改用别家。' : ''),
      });
      if (!go) return;
      if (!Api.customDrop(kid)) {
        cusSetMsg('没删掉：本机存储满，先清缓存。', 'err');
        return;
      }
      if (cusEditing.value === kid) cusReset();
      await afterCustomChanged(kid);
      cusSetMsg('已删掉「' + ((e && e.name) || kid) + '」。', 'ok');
    }
    async function addCus() {
      const t = cusTemplate();
      if (!t) {
        cusSetMsg('在「接口形状」里选一套协议（OpenAI 兼容 / H3 兼容…）。', 'err');
        return;
      }
      const name = String(cusName.value || '').trim();
      if (!name) { cusSetMsg('写个显示名 —— 型号下拉的分组名与收藏里的筛选项认的就是它。', 'err'); return; }
      const base = String(cusBase.value || '').trim().replace(/\/+$/, '');
      if (!httpsBaseOk(base)) {
        cusSetMsg('地址要以 https:// 开头（代理只放行公网 https：它会把密钥转发给这个地址，明文与内网一律拒）。', 'err');
        return;
      }
      const clash = Api.hostOwner(REG, base, t);
      if (clash && clash.kind === 'other-provider' && !clash.custom) {
        cusSetMsg('这个地址是「' + clash.name + '」的官方地址，但这一格配的是「'
          + ((t.displayName || t.name) || t.id) + '」的接口形状 —— 换成它自己那一档选它、填密钥就能用。', 'err');
        return;
      }
      const models = cusPicked();
      if (!models.length) { cusSetMsg('至少勾一个型号：型号清单就是这一家能被选到的东西。', 'err'); return; }
      const id = cusEditing.value || Api.customId();
      const list = Api.customList().filter(e => e && e.id !== id);
      list.push({
        id, name, kind: t.kind, shape: t.id,
        prov: '',
        shapeId: cusShapeSel.value,
        base, models,
      });
      /* 选了两个以上档位：第一个是主档（这条自定义条目就是它），其余记成「手动声明」——
         与卡里「＋ 手动加一档能力」同一个键、同一套语义：识别 / 搜索真能用，
         生成三档只算声明（那一行会写明还差注册表一条端点）。 */
      const extraCaps = cusCaps.value.slice(1);
      const key = String(cusKey.value || '').replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '').trim();
      /* 先落密钥、再落那份清单：密钥这一格写不进去（配额满 / 隐私模式）时当场收工，
         不会出现「卡片说已添加、下一次调用才发现根本没有密钥」。写盘走 `window.LS`
         （本机存储的唯一包装），它把「写不进去」变成 false 而不是一条控制台红字。 */
      let keySaved = true;
      if (key) keySaved = window.LS.set('sk_key_' + id, key);
      else if (cusEditing.value) keySaved = window.LS.del('sk_key_' + id);
      if (!keySaved) {
        cusSetMsg('「' + name + '」没有保存：本机存储写不进密钥这一格（配额满或浏览器在隐私模式）。'
          + '先到本页「清理缓存」那一栏删掉不用的历史，再重填一次。', 'err');
        return;
      }
      /* 清单这一格写不进去（配额满 / 隐私模式）时当场收工，顺手把刚写进去的密钥摘掉
         —— 留下一把没人认领的 sk_key_<id>，它会跟着导出 / 云同步跑到别的机器上。 */
      if (!Api.customSet(list)) {
        window.LS.del('sk_key_' + id);
        cusSetMsg('「' + name + '」没有保存：本机存储写不进清单这一格（配额满或浏览器在隐私模式）。'
          + '先到本页「清理缓存」那一栏删掉不用的历史，再重试一次。', 'err');
        return;
      }
      await afterCustomChanged();
      /* 多选的其余档：记成这一家的「手动声明」（sk_caps_<id>）。识别 / 搜索真能用；
         生成三档只算声明 —— 卡里那一行会写明还差注册表一条端点，这里不假装。 */
      setManualCaps(id, extraCaps);
      const wasEditing = cusEditing.value;
      cusReset();
      /* 加完 / 存完就收起来（回到「预设」形态）：这张卡平时是清单，展开只是临时填一填。
         回执走 Toast —— 收起之后表单里那一行字没人看得见。 */
      cusShown.value = false;
      renderProv();
      const via = Api.verifyTarget({ endpoints: t.endpoints });
      Toast.receipt('已' + (wasEditing ? '保存' : '添加') + '「' + name + '」—— 卡片流里现在就是它自己那一张卡。'
        + (extraCaps.length ? '另外 ' + extraCaps.map(capZh).join(' / ') + ' 记成了「手动声明」那一档。' : '')
        + (t.kind === 'text'
          ? '密钥 / 型号清单 / 识图都在那一张卡上（要让它顶「文字对话」这一档，点卡上那一格的状态牌；'
            + '地址要改就点卡底的「编辑」）。'
          : capZh(t.kind) + '这一档的型号下拉里现在都有它。'
            + '要确认地址与密钥通不通，点它那张卡上的「验证」（问一次' + via.label + '，不建任务、不扣费）。'), 'ok');
    }
    function cancelCus() {
      const n = cusEditing.value;
      cusReset();
      cusSetMsg(n ? '已取消编辑，那一条照原样留着。' : '', '');
    }
    /* 获取型号列表：拿表单里现在的地址与密钥去问它自己（只读接口，不建任务、不扣费）。 */
    async function fetchCusModels() {
      const t = cusTemplate();
      if (!t) { cusSetMsg('先选一个「接口形状」（照哪一家的接口）。', 'err'); return; }
      const base = String(cusBase.value || '').trim().replace(/\/+$/, '');
      if (!httpsBaseOk(base)) { cusSetMsg('先填上面的接口地址（要 https:// 开头），获取型号要用它。', 'err'); return; }
      const key = String(cusKey.value || '').replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '').trim();
      if (!key) { cusSetMsg('先填密钥 —— 型号列表是要鉴权的接口。', 'err'); if (cusKeyEl.value) window.focusQuiet(cusKeyEl.value); return; }
      cusFetchBusy.value = true;
      try {
        const r = await Net.fetch('/custom/models', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shape: t.id, base, key }), timeout: 25000, retry: 0,
        });
        let d = {};
        try { d = (await r.json()) || {}; } catch (e) { throw new Error('代理没有返回 JSON（HTTP ' + r.status + '）'); }
        const list = Array.isArray(d.models) ? d.models : [];
        if (!list.length) throw new Error(d.error || ('它没有返回型号列表（HTTP ' + r.status + '）'));
        cusFetched.value = list;
        cusFetchFrom.value = (d.from || base);
        rebuildCusModels();
        cusSetMsg('从「' + cusFetchFrom.value + '」拿到 ' + list.length + ' 个型号，已全部勾上（用不上的再自己勾掉）。'
          + '　勾选的意思只有一个：它会出现在工作台与素材库的型号下拉里。'
          + '（一个都没勾时添加会被拦下 —— 型号清单就是这一家能被选到的东西。）', 'ok');
      } catch (e) { cusSetMsg('获取失败：' + errText(e), 'err'); }
      finally { cusFetchBusy.value = false; }
    }

    /* ---------- 可折叠的一块（供应商卡里的「型号清单」） ----------
       小器一只：data-fold-key = 状态存哪个键；带 data-fold-once 的一类**不记**（每次都折着）。
       幂等靠 el._foldWired；每次 renderProv 换掉 innerHTML 之后要重新 initFolds。 */
    function initFolds(host) {
      const scope = host || rootEl.value;
      if (!scope) return;
      [...scope.querySelectorAll('[data-fold-key]')].forEach(c => {
        if (c._foldWired) return;
        const btn = c.querySelector('.fold-toggle');
        if (!btn) return;
        c._foldWired = true;
        const once = c.hasAttribute('data-fold-once');
        const paint = () => {
          const open = c.classList.contains('open');
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          const txt = btn.querySelector('.fold-txt') || btn;
          txt.textContent = open ? '收起' : '展开';
        };
        /* 程序也要能开这一处（搜到「本机维护」那一组里的行时得先展开才看得见命中）：
           留一个不写盘的口，免得外面靠 classList 手改之后按钮上的「展开/收起」文字与 aria 留在旧状态。 */
        c._foldPaint = paint;
        c._foldSet = v => { if (c.classList.contains('open') === !!v) return; c.classList.toggle('open', !!v); paint(); };
        c.classList.toggle('open', !once && window.LS.get(c.dataset.foldKey) === '1');
        paint();
        btn.onclick = () => {
          c.classList.toggle('open');
          paint();
          if (once) return;
          window.LS.set(c.dataset.foldKey, c.classList.contains('open') ? '1' : '0');
        };
      });
    }

    /* ---------- 改完一项就自动存本机 ----------
       三条不能各自漂一处的性质：① 打字中途不存（触发只有 change 委托）；
       ② 一次只跑一趟（跑的时候又改了 → 结束后再跑一趟）；
       ③ 没存成要看得见（顶栏那一格常驻，外壳的 `__spaDirty` 据此继续拦切页）。 */
    let saveTimer = null, saveOkTimer = null, saveRun = null, saveAgain = false;
    let savePending = false, saveFailed = '', saveSkipped = '', saveOkAt = 0, skLeaving = false;

    function paintSaveState() {
      const fresh = saveOkAt && (Date.now() - saveOkAt < 4200);
      saveKind.value = saveFailed ? 'err' : (saveSkipped || savePending) ? 'wait' : fresh ? 'ok' : '';
      saveText.value = saveFailed ? '没存进本机：' + saveFailed
        : saveSkipped ? '这几项没写进去：' + saveSkipped + '（改对了才会再试一次）'
        : savePending ? '正在把刚才那一项存进本机…'
        : fresh ? '✓ 已存本机'
        : '改一项就自动存本机（这一页没有「保存」按钮）';
    }
    function markChanged() {
      if (skLeaving) return;
      savePending = true;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(runSave, SAVE_DEBOUNCE_MS);
      paintSaveState();
    }
    /* 唯一的触发口：「这一项改完了」。只认落在本组件里的控件 —— 外壳同一份文档里
       还有侧栏与 AI 助手，它们也有输入框，不能拿它们的改动来存设置。 */
    function onRootChange(e) {
      const t = e && e.target;
      if (!t || !rootEl.value || !rootEl.value.contains(t)) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName || '')) markChanged();
    }
    async function runSave() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (saveRun) { saveAgain = true; return saveRun; }
      saveRun = (async () => {
        do {
          saveAgain = false;
          try { await saveAllNow(); }
          catch (err) { saveFailed = '这一趟自动保存被打断：' + String(errText(err)).slice(0, 90); }
          if (!saveFailed && !saveSkipped && !saveTimer && !saveAgain) saveOkAt = Date.now();
        } while (saveAgain);
        saveRun = null;
        savePending = !!saveTimer;
        paintSaveState();
        if (saveOkTimer) clearTimeout(saveOkTimer);
        if (saveOkAt) saveOkTimer = setTimeout(paintSaveState, 4300);
      })();
      return saveRun;
    }
    async function flushPending() {
      if (saveTimer || saveFailed) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        await runSave();
      } else if (saveRun) await saveRun;
      return !saveFailed;
    }
    function dropPending() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      savePending = false;
    }
    async function stopPendingSave() {
      dropPending();
      if (saveRun) await saveRun;
    }
    async function loadReg() {
      try { setREG(await Api.registry()); } catch (e) { setREG(null); }
      if (window.Api) Api.setRegistry(REG);
      try { envInfo = (window.Api && Api.envStatus) ? await Api.envStatus() : {}; } catch (e) { envInfo = {}; }
      renderProv();
      renderCus();
      syncServiceProvs();
    }

    /* ---------- 型号面板的读写（供应方 / 密钥都在账号卡里） ----------
       一格面板 = 一个槽（keyId:档）：同一把密钥下图片档与文字档各有自己的型号接口，
       取回的清单按槽存才不会串档。⚠ 落盘仍是按账号那一份：文字档的型号 = sk_model_<keyId>，
       「自己填的 id」与「藏起来的那几个」= sk_model_prefs（也按 keyId）—— 界面不装作按档各存一份。
       这一段整体在 textForm 里，而 saveAllNow 在外面 —— 跨这一层只走 textForm 的公开口。 */
    const fetched = new Map();      // slot → [{id,name}]（本轮内存副本，不落盘）
    const fetchedOf = p => (p ? fetched.get(slotOfProv(p)) : null) || [];
    const modelDraft = new Map();   // keyId → 还没落盘的型号
    const visionDraft = { v: null };
    let visionTipSeq = 0;
    let textForm = null;

    const textProvList = () => (window.TextAI ? TextAI.all(REG) : []);
    function curTextProv() {
      const list = textProvList();
      if (!list.length) return null;
      const picked = list.find(x => x.id === curTextId());
      return picked || TextAI.prov(REG) || list[0];
    }
    /* 识图那一格是「文字档」的属性：按 keyId 找回它自己那一条文字声明。 */
    const textProvOf = kid => provBySlot(slotKey(kid, 'text'));
    /* 面板里的控件都带槽名（keyId:档）：有的直接写在身上（tkid / panel / ttest / tfetch / tadd / tmnew），
       有的只住在面板那一格里（由 [data-mblk] 供）。外面这一层只认槽，不认 keyId。 */
    const SLOT_ATTRS = ['tkid', 'panel', 'ttest', 'tfetch', 'tadd', 'tmnew'];
    const slotOfEl = el => {
      if (!el || !el.dataset) return '';
      for (const a of SLOT_ATTRS) { if (el.dataset[a]) return el.dataset[a]; }
      const blk = el.closest && el.closest('[data-mblk]');
      return blk ? blk.dataset.mblk : '';
    };
    const selOf = kid => q('[data-tmodel="' + kid + '"]');
    const msgOf = kid => q('[data-msg="' + kid + '"]');
    const countOf = slot => q('[data-mcount="' + window.esc(slot) + '"]');
    const noteOf = slot => q('[data-mnote="' + window.esc(slot) + '"]');
    const fetchOf = slot => q('[data-mfetch="' + window.esc(slot) + '"]');
    /* 面板里那一行的回执：面板开着就写在面板底下，只点了「测试」这种没开面板的写在卡底。 */
    function panelMsg(slot, text, cls) {
      const el = q('[data-pmsg="' + window.esc(slot) + '"]');
      if (el) { el.className = 'msg ' + (cls || ''); el.textContent = text; return; }
      acctMsg(slotKid(slot), text, cls);
    }
    /* 面板顶部那一枚状态牌 + 计数（四态：还没取过 / 正在取 / 取回 n 个·耗时 / 取失败：原因）。 */
    function paintFetchNote(slot) {
      const el = fetchOf(slot);
      if (!el) return;
      const f = fetchNote.get(slot) || { state: '' };
      const p = provBySlot(slot);
      if (f.state === 'busy') { el.className = 'st warn'; el.textContent = '正在取…'; }
      else if (f.state === 'done') { el.className = 'st ok'; el.textContent = '已取回 ' + f.n + ' 个 · ' + f.ms + 'ms'; }
      else if (f.state === 'err') { el.className = 'st err'; el.textContent = '取失败：' + f.why; }
      else if (p && p.endpoints && p.endpoints.models) { el.className = 'st alt'; el.textContent = '还没取过'; }
      else { el.className = 'st off'; el.textContent = '这一档没有型号接口'; }
      const btn = q('[data-tfetch="' + window.esc(slot) + '"]');
      if (btn) btn.textContent = f.state === 'busy' ? '取回中…' : '取一次型号清单';
      const note = noteOf(slot);
      if (note) {
        const p2 = provBySlot(slot);
        const n = p2 ? allModelsOf(p2).length : 0;
        const vis = p2 ? allModelsOf(p2).filter(x => !(window.ModelPrefs && ModelPrefs.isOff(p2, x.id))).length : 0;
        const text = !!(p2 && p2.kind === 'text');
        note.textContent = '共 ' + n + ' 个 · ' + (text ? '全站润色在用那一个就是这一档的选中值'
          : '工作台列 ' + vis + ' 个') + (p2 && ((p2.models || []).length) ? ' · 注册表里写了 ' + p2.models.length + ' 个' : '');
      }
      const cb = q('[data-panel="' + window.esc(slot) + '"]');
      if (cb) cb.innerHTML = (panelOpen.has(slot) ? '收起型号 ' : '型号 ') + '<b data-mcount="' + window.esc(slot) + '"></b>';
      setCount(slot);
    }
    /* 这一家「都有哪些型号」= 三路并起来，包含被藏起来的那一些。 */
    function allModelsOf(p) {
      const map = new Map();
      const skip = id => !!(p && window.Capabilities && Capabilities.skipMedia && Capabilities.skipMedia(p, id));
      const put = (id, name, api) => {
        const s = String(id || '').trim();
        if (!s || skip(s)) return;
        const cur = map.get(s);
        if (cur) { if (!cur.name && name) cur.name = String(name).trim(); cur.api = cur.api || api; }
        else map.set(s, { id: s, name: String(name || '').trim(), api, typed: false });
      };
      const prefs = (window.ModelPrefs && p) ? ModelPrefs.of(p) : { typed: [], off: [], got: [] };
      (prefs.got || []).forEach(m => put(m && (m.id || m), (m && m.name) || '', true));
      fetchedOf(p).forEach(m => put(m && (m.id || m), (m && m.name) || '', true));
      ((p && p.models) || []).forEach(m => put(m && (m.id || m), (m && m.name) || '', true));
      prefs.off.forEach(id => put(id, '', false));
      prefs.typed.forEach(id => put(id, '', false));
      const tset = new Set(prefs.typed);
      map.forEach(x => { x.typed = tset.has(x.id); });
      const arr = [...map.values()];
      return arr.sort((a, b) => a.id.localeCompare(b.id));
    }
    /* 「型号 n/m」那一个按钮上的数：m = 这一档现在知道的总数，n = 会出现在工作台上的那几个。
       计数挂在按钮里那一枚 <b> 上，取回 / 勾选 / 自己填之后由这里刷新（不整片重画卡片）。 */
    function setCount(slot) {
      const el = countOf(slot);
      if (!el) return;
      const p = provBySlot(slot);
      if (!p) { el.textContent = '—'; el.title = '没认出这一家（注册表可能刚变过）—— 刷新一次页面'; return; }
      const list = allModelsOf(p);
      const shown = list.filter(x => !(window.ModelPrefs && ModelPrefs.isOff(p, x.id))).length;
      el.textContent = shown + '/' + list.length;
      el.title = '工作台与素材库的型号下拉里列 ' + shown + ' 个 · 这一档一共知道 ' + list.length + ' 个';
    }
    /* 型号下拉：只显示这一家的型号，按来源分组。keep：明确要选中的那个。
       这个下拉只属于「文字对话」那一档（多选档没有下拉，只有面板里的清单行）。 */
    function fillModelOptions(slot, keep) {
      if (slotCap(slot) !== 'text') return;
      const kid = slotKid(slot);
      const sel = selOf(kid);
      if (!sel) return;
      const p = provBySlot(slot);
      if (!p) {
        sel.innerHTML = '<option value="">（没认出这一家，刷新一下页面再试）</option>';
        sel.value = '';
        return;
      }
      const prev = keep || (modelDraft.has(kid) ? modelDraft.get(kid) : (window.LS.get('sk_model_' + kid) || ''));
      const g = TextAI.modelGroups(p, fetchedOf(p));
      const groups = g.groups, ids = g.ids;
      sel.innerHTML = groups.length
        ? groups.map(gr => '<optgroup label="' + window.esc(gr.label) + '">' + gr.ids.map(id2 => '<option value="' + window.esc(id2) + '">' + window.esc(id2) + '</option>').join('') + '</optgroup>').join('')
        : '<option value="">（还没有这家接口的型号）</option>';
      const list = ids.length ? ids : [];
      sel.value = list.includes(prev) ? prev : (list[0] || '');
      /* 一个型号都还没有：只有面板开着时才补那句说明（面板没开时，这一行自己的占位选项与
         「型号 0/0」已经说清，卡底再挂一段只是噪音）。 */
      if (!list.length) {
        const mEl = q('[data-pmsg="' + window.esc(slot) + '"]');
        const cur = (mEl && mEl.textContent) || '';
        if (mEl && (!cur || cur.indexOf('还没有型号') === 0)) {
          mEl.className = 'msg';
          mEl.textContent = '还没有型号。';
        }
      }
      const row = sel.closest('.crow') || sel.closest('.krow');
      if (window.Dropdowns && row) { Dropdowns.build(row); Dropdowns.sync(row); }
    }
    /* 每一行 = 一个型号 + 一个「在工作台上展示」的勾选 +（自己填的那几条）一颗「移除」。
       文字档是单选（点一行 = 全站润色用它，写的还是 sk_model_<keyId> 那一个值）；
       生成三类是多选（勾选 = 出现在工作台下拉里）。 */
    function renderModelRows(slot) {
      const kid = slotKid(slot);
      const box = q('[data-tchips="' + window.esc(slot) + '"]');
      if (!box) return;
      const p = provBySlot(slot);
      if (!p) { box.innerHTML = ''; return; }
      const list = allModelsOf(p);
      const cur = ((selOf(kid) || {}).value) || '';
      if (!list.length) {
        box.innerHTML = '<div class="mlist-empty">还没有型号。</div>';
        return;
      }
      const text = p.kind === 'text';
      const es = window.esc(slot);
      box.innerHTML = list.map(x => {
        const id2 = window.esc(x.id);
        const src = x.typed ? '自己填的' : (x.api ? '接口给的' : '本机记的');
        const del = x.typed
          ? '<button class="ghost xs" title="移除这个型号（只清本机记录，平台那边不受影响）"'
            + ' data-tdel="' + id2 + '" data-tkid="' + es + '">' + ic('close', 10) + '</button>' : '';
        if (text) {
          const on = x.id === cur;
          return '<div class="mlist-row' + (on ? ' pick' : '') + '" role="button" tabindex="0"'
            + ' data-tpick-model="' + id2 + '" data-tkid="' + es + '"'
            + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
            + ' title="' + (on ? '正在用：全站润色（导演台、素材库里的 AI 文字）都用这一个'
              : '点这一行 = 全站润色改用这个型号') + '">'
            + '<span>' + ((x.name && x.name !== x.id) ? '<b>' + window.esc(x.name) + '</b> ' : '') + '<code>' + id2 + '</code></span>'
            + '<span class="mlist-src">' + (on ? '正在用' : src) + '</span>' + del
            + '</div>';
        }
        const off = window.ModelPrefs ? ModelPrefs.isOff(p, x.id) : false;
        return '<div class="mlist-row' + (off ? ' off' : '') + '">'
          + '<label title="' + (off ? '勾上 = 让它重新出现在工作台的型号下拉里'
            : '勾掉 = 在工作台的型号下拉里藏掉这一条（不是删掉，随时能勾回来）') + '">'
          + '<input type="checkbox" data-mshow="' + id2 + '" data-tkid="' + es + '"' + (off ? '' : ' checked') + '>'
          + '<span>' + ((x.name && x.name !== x.id) ? '<b>' + window.esc(x.name) + '</b> ' : '') + '<code>' + id2 + '</code></span>'
          + '</label>'
          + '<span class="mlist-src">' + src + '</span>' + del
          + '</div>';
      }).join('');
    }
    /* 点文字档清单上一行 = 选中这一个（与上面那个下拉写同一个键 sk_model_<keyId>，两处必须同时动）。 */
    function pickTextModel(slot, id) {
      const kid = slotKid(slot);
      const p = provBySlot(slot);
      const sel = selOf(kid);
      const m = String(id || '');
      if (!p || !sel || !m) return;
      if (![...sel.options].some(o => o.value === m)) {
        panelMsg(slot, '这一行不在下拉的选项里（清单与下拉对不上）—— 点「取一次型号清单」重新取一次。', 'msg err');
        return;
      }
      if (sel.value === m && modelDraft.get(kid) === m) return;
      sel.value = m;
      /* 下拉是公共件包出来的，程序化改值之后要让它把显示文字与选项列表跟上。 */
      if (window.Dropdowns) Dropdowns.sync(sel);
      modelDraft.set(kid, m);
      renderModelRows(slot);
      paintFetchNote(slot);
      refreshVisionTip(kid);
      panelMsg(slot, '已选择型号：' + m + '（全站润色都用它；改完就自动存进本机，「测试」会直接用这个）', 'msg');
      markChanged();
    }
    /* 文字档改单选之后，「藏起来」在这一档不再有界面 —— 旧版本留下的 off 记录要摘掉。
       顺序要紧：必须在下拉填选项**之前**清，清完那一次下拉才拿得到。 */
    function forgetTextOff(p) {
      if (!window.ModelPrefs || !p || p.kind !== 'text') return;
      const off = ModelPrefs.of(p).off;
      off.forEach(id => ModelPrefs.setOff(p, id, false));
    }
    function paintTextCards() {
      /* 「型号 n/m」那枚计数每一档行上都有（不只是展开着面板的那几档）：按槽现算一遍。 */
      qa('[data-mcount]').forEach(el => setCount(el.dataset.mcount));
      /* 文字档那一个下拉**常驻**在每一行上（不随面板开合），所以先按它把选项填上；
         型号面板只在展开时才在 DOM 里，里面的清单行按槽重画。 */
      qa('[data-tmodel]').forEach(sel => {
        const slot = slotKey(sel.dataset.tmodel, 'text');
        forgetTextOff(provBySlot(slot));
        fillModelOptions(slot);
      });
      qa('[data-mblk]').forEach(blk => {
        const slot = blk.dataset.mblk;
        renderModelRows(slot);
        paintFetchNote(slot);
      });
      scheduleAutofetch();
      const tv = q('[data-tvision]');
      if (tv) {
        tv.value = visionDraft.v != null ? visionDraft.v : (window.LS.get('sk_text_vision') || 'auto');
        const tvRow = tv.closest('.krow');
        if (window.Dropdowns && tvRow) { Dropdowns.build(tvRow); Dropdowns.sync(tvRow); }
        refreshVisionTip(tv.dataset.tvision);
      }
    }
    /* 识图能力：自动 / 支持 / 不支持（存 sk_text_vision）。它跟着「文字档」那一条声明走，
       所以按 keyId 找回那一条，而不是按卡上正在展开的某一档。 */
    async function refreshVisionTip(kid) {
      const el = q('[data-vtip="' + kid + '"]');
      if (!el || !window.TextAI) return;
      const seq = ++visionTipSeq;
      const REG2 = REG || { providers: [] };
      const p2 = textProvOf(kid);
      if (!p2) { el.textContent = '没认出这一家供应商，识图能力判不了 —— 刷新一下页面再试。'; return; }
      const mdl = ((selOf(kid) || {}).value) || '';
      el.textContent = '正在读取型号能力…';
      let v;
      try { v = await TextAI.visionAsync(REG2, p2, mdl); }
      catch (e) { v = TextAI.vision(REG2, p2, mdl); }
      if (seq !== visionTipSeq) return;
      if (!v.model) {
        el.textContent = '还没选型号。';
        return;
      }
      el.textContent = v.ok
        ? '当前型号 ' + v.model + '：润色时会带上参考图 / 首尾帧一起发给它（判定依据：' + v.why + '）。'
        : '当前型号 ' + v.model + '：润色时只发文字（判定依据：' + v.why + '）。若该型号确实能识图，把上面选成「支持识图」即可强制启用。';
    }
    const cleanKey = s => String(s == null ? '' : s).replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '').trim();
    /* 接口地址的判据：代理的出站护栏只放行公网 https，http / 内网地址每一笔请求都会被代理当场拒 ——
       添加与编辑自定义那一家时不拦的话，错误发生在很久以后。 */
    const httpsBaseOk = v => /^https:\/\//i.test(String(v == null ? '' : v).trim());
    const draftOf = kid => draftKey(kid);
    /* 地址没有草稿：卡上不再改它，取型号 / 验证用的就是盘上那一份（自定义那几家由添加与编辑那一格写盘）。 */
    function useFormCreds(p) {
      if (!p) return '';
      const kid = p.keyId || p.id;
      const raw = cleanKey(draftOf(kid));
      TextAI.setFormOverride(p, { key: raw, base: null });
      return raw;
    }
    const fetchTextModels = async p => {
      useFormCreds(p);
      return TextAI.models(await Api.registry(), p);
    };
    const fetchMediaModels = async p => {
      const d = await Api.request(p, 'models');
      const raw = Api.modelRows(d);
      const seen = new Set(), out = [];
      const re = p.modelsFilter ? new RegExp(p.modelsFilter) : null;
      (raw || []).forEach(m => {
        const id = String((m && (m.id || m.name)) || m || '').trim();
        if (!id || seen.has(id) || (re && !re.test(id))) return;
        seen.add(id);
        out.push({ id, name: String((m && m.name) || '') });
      });
      return out;
    };
    async function runFetchModels(p, slot, btn) {
      if (btn) {
        fetchNote.set(slot, { state: 'busy' });
        paintFetchNote(slot);
      }
      const t0 = Date.now();
      try {
        const list = p.kind === 'text' ? await fetchTextModels(p) : await fetchMediaModels(p);
        if (!list.length) throw new Error('接口没有返回型号');
        fetched.set(slot, list);
        if (window.ModelPrefs) ModelPrefs.setGot(p, list);
        fetchNote.set(slot, { state: 'done', n: list.length, ms: Date.now() - t0 });
        renderModelRows(slot);
        fillModelOptions(slot);
        paintFetchNote(slot);
        return list;
      } catch (e) {
        fetchNote.set(slot, { state: 'err', why: errText(e), ms: Date.now() - t0 });
        paintFetchNote(slot);
        throw e;
      }
    }
    const autofetchTried = new Set();
    let autofetchRunning = false;
    async function autofetchModels() {
      if (autofetchRunning) return;
      autofetchRunning = true;
      try {
        for (const blk of qa('[data-mblk]')) {
          const slot = blk.dataset.mblk;
          if (autofetchTried.has(slot)) continue;
          const p = provBySlot(slot);
          if (!p || p.kind === 'text') continue;
          if (!(p.endpoints && p.endpoints.models)) continue;
          autofetchTried.add(slot);
          if (allModelsOf(p).length) continue;
          try { await runFetchModels(p, slot); } catch (e) { /* 取不到就照旧显示那句提示 */ }
        }
      } finally { autofetchRunning = false; }
    }
    function scheduleAutofetch() {
      if (scheduleAutofetch._busy) return;
      scheduleAutofetch._busy = true;
      setTimeout(() => { scheduleAutofetch._busy = false; autofetchModels(); }, 400);
    }
    /* 型号面板里那一格的操作：取清单 / 测试 / 自己填 / 移除 / 点一行选中。
       与卡上那一族开关（onAcctClick）各认各的 data-*，挂在同一颗网格上互不抢。 */
    async function onPanelClick(ev) {
      const row = ev.target.closest('[data-tpick-model]');
      if (row && !ev.target.closest('[data-tdel]')) {
        ev.preventDefault();
        pickTextModel(slotOfEl(row), row.dataset.tpickModel);
        return;
      }
      const b = ev.target.closest('[data-tfetch],[data-ttest],[data-tadd],[data-tdel]');
      if (!b) return;
      ev.preventDefault();
      const slot = slotOfEl(b);
      const kid = slotKid(slot);
      const prov = provBySlot(slot);
      if (!prov) {
        panelMsg(slot, '没认出这一档（注册表可能刚变过，或这一家已经被删了）。'
          + '先刷新一下页面再填 —— 宁可不加，也不能把型号写到别家去。', 'msg err');
        return;
      }
      if (b.dataset.tdel != null) {
        const id2 = b.dataset.tdel, sel2 = selOf(kid);
        const was = sel2 && sel2.value === id2;
        TextAI.removeCustom(prov, id2);
        renderModelRows(slot);
        fillModelOptions(slot);
        setCount(slot);
        if (was) refreshVisionTip(kid);
        panelMsg(slot, '已移除型号「' + id2 + '」（只清本机记录；接口自己列出的那些不受影响）', 'msg ok');
        return;
      }
      if (b.dataset.tadd != null) {
        const inp = (b.closest('.mpanel') || document).querySelector('[data-tmnew]');
        const raw = ((inp || {}).value || '').trim();
        if (!raw) { if (inp) window.focusQuiet(inp); return; }
        /* 逗号分隔一次填多个：一行的输入框，多次落盘 —— 与「自己填」那一格的说法一致。 */
        const ids = raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
        ids.forEach(id2 => TextAI.addCustom(prov, id2));
        if (inp) inp.value = '';
        renderModelRows(slot);
        fillModelOptions(slot, ids[ids.length - 1]);
        setCount(slot);
        panelMsg(slot, '已添加 ' + ids.join('、') + '（当场存进本机；只属于「' + (prov.name || '这一家')
          + '」这一家，别家不会出现。工作台的型号下拉下一次打开就有它们）', 'msg ok');
        if (prov.kind === 'text') refreshVisionTip(kid);
        return;
      }
      if (b.dataset.tfetch != null) {
        const p = prov;
        b.disabled = true;
        try {
          const list = await runFetchModels(p, slot, b);
          const from = (p.kind === 'text' ? (TextAI.base(p) || p.base) : (p.base || '')) || '这一家的默认地址';
          panelMsg(slot, '从「' + from + '」取回 ' + list.length + ' 个型号（只属于「' + p.name + '」'
            + capZh(slotCap(slot)) + '这一档），当前选中 ' + (((selOf(kid) || {}).value) || '—'), 'msg ok');
          if (p.kind === 'text') refreshVisionTip(kid);
          markChanged();
          if (p.kind === 'text') {
            try {
              const v = await TextAI.verifyKey(await Api.registry(), p);
              const el = q('[data-pmsg="' + window.esc(slot) + '"]');
              if (el) el.textContent += '　|　' + v.text
                + (/OpenRouter|聚合/.test(p.name) ? '（它的型号表公开，所以这一步才有必要）' : '');
            } catch (e) { /* 验证失败不拖累取列表 */ }
          }
        } catch (e) {
          const hint = p.kind === 'text' ? ''
            : '（生成平台的型号清单是拿「已经存进本机」的那把密钥去问的：刚贴上去的等状态行那一句变成「刚刚存过」再取一次）';
          panelMsg(slot, '取型号清单失败：' + errText(e) + hint, 'msg err');
        }
        finally { b.disabled = false; }
        return;
      }
      if (b.dataset.ttest != null) {
        const p = prov;
        b.disabled = true; const label0 = b.textContent; b.textContent = '测试中…';
        try {
          useFormCreds(p);
          const model = ((selOf(kid) || {}).value) || '';
          if (!model) throw new Error('先在上面选一个型号，或在下面自己填一个');
          if (TextAI.ownsModel && !TextAI.ownsModel(p, model, fetchedOf(p))) {
            throw new Error('「' + model + '」不属于「' + (p.name || '这一家') + '」的型号列表 —— 多半是刚切供应商时留下的旧值，重新选一个或点「取一次型号清单」');
          }
          const out = await TextAI.chat(await Api.registry(), '你是助手，回答要极简。', '只回复：ok', { model }, p);
          panelMsg(slot, '✓ 测试成功（' + (p.name || '') + ' · ' + model + '）：' + out.slice(0, 60), 'msg ok');
        } catch (e) { panelMsg(slot, '✗ 测试失败：' + errText(e), 'msg err'); }
        finally { b.disabled = false; b.textContent = label0; }
      }
    }
    function onPanelChange(ev) {
      const cb = ev.target.closest && ev.target.closest('[data-mshow]');
      if (cb) {
        const slot = slotOfEl(cb), id2 = cb.dataset.mshow;
        const kid = slotKid(slot);
        const p = provBySlot(slot);
        if (!p || !window.ModelPrefs) {
          cb.checked = !cb.checked;
          panelMsg(slot, '没认出这一档，刷新再试。', 'msg err');
          return;
        }
        const hide = !cb.checked;
        ModelPrefs.setOff(p, id2, hide);
        const wasCur = ((selOf(kid) || {}).value) === id2;
        renderModelRows(slot);
        fillModelOptions(slot);
        setCount(slot);
        const sel2 = selOf(kid);
        if (sel2) modelDraft.set(kid, sel2.value);
        refreshVisionTip(kid);
        panelMsg(slot, (hide ? '已隐藏 ' : '已展示 ') + id2
          + '（当场存进本机；按账号存 —— 这一家每一档共用那一份'
          + (hide ? '；这不是删掉，勾回来它就在工作台上了' : '') + '）'
          + (hide && wasCur ? '　|　它原本是这一家选中的型号，下拉已换到清单里的第一个（选完自动存进本机）' : ''),
          'msg ok');
        return;
      }
      const s = ev.target.closest('[data-tmodel],[data-tvision]');
      if (!s) return;
      const kid = s.dataset.tmodel || s.dataset.tvision;
      if (s.dataset.tvision) { visionDraft.v = s.value; refreshVisionTip(kid); return; }
      modelDraft.set(kid, s.value);
      const slot = slotKey(kid, 'text');
      renderModelRows(slot);
      setCount(slot);
      panelMsg(slot, '已选择型号：' + (s.value || '（空）') + '（全站润色都用它；改完就自动存进本机，「测试」会直接用这个）', 'msg');
      refreshVisionTip(kid);
    }
    function initTextForm() {
      textForm = {
        prov: curTextProv, list: textProvList, provBySlot, textProvOf, fetchedOf, paint: paintTextCards,
        clearDrafts() { modelDraft.clear(); visionDraft.v = null; },
        flushDrafts(W, Wdel, skipped, domKeys) {
          for (const [kid, m] of modelDraft) {
            if (domKeys && domKeys.has(kid)) continue;
            if (!m) continue;
            const p = textProvOf(kid);
            if (p && TextAI.ownsModel && !TextAI.ownsModel(p, m, fetchedOf(p))) { skipped.push('型号「' + m + '」（不属于' + (p.name || '这一家') + '）'); continue; }
            W('sk_model_' + kid, m);
          }
          if (visionDraft.v != null && !q('[data-tvision]')) W('sk_text_vision', visionDraft.v);
        },
      };
      /* textForm 只给这一页自己用（以前还挂过 window.__textForm，全站没有读它的地方）。
         面板与卡片上的接线都挂在网格那一个节点上，由 wireAcct 一次绑齐（重画只换 innerHTML，
         监听器留着 —— 以前每次重画重新绑一遍，重画与点击交错时就会留下死按钮）。 */
      if (window.Dropdowns && rootEl.value) Dropdowns.build(rootEl.value);
    }

    /* ---------- 列表分页 ---------- */
    function renderPageSettings() {
      const box = pageBoxEl.value;
      if (!box) return;
      const rows = window.PAGE_TARGETS.rows, SZ = window.PAGE_TARGETS.size, MD = window.PAGE_TARGETS.modes;
      box.innerHTML = '';
      rows.forEach(t => {
        const row = document.createElement('div');
        row.className = 'krow thin';
        row.innerHTML = '<span class="kn">' + window.esc(t.name) + '</span>'
          + '<select data-mode="' + window.esc(t.key) + '" style="flex:0 0 140px">'
          + MD.map(m => '<option value="' + m + '" ' + (window.pageModeOf(t.key) === m ? 'selected' : '') + '>'
            + (m === 'page' ? '翻页' : '动态加载（滚动自动加载）') + '</option>').join('')
          + '</select>'
          + '<span style="font-size: var(--fs-12-5);color:var(--sub)">每页</span>'
          + '<input type="number" min="' + SZ.min + '" max="' + SZ.max + '" data-size="' + window.esc(t.key) + '" value="' + window.pageSizeOf(t.key) + '" style="flex:0 0 90px">'
          + '<span style="font-size: var(--fs-12-5);color:var(--sub)">条</span>';
        box.appendChild(row);
      });
      if (window.Dropdowns) Dropdowns.build(box);
    }
    /* 返回「这一趟有没有真的改掉某一项」—— 分页档位是刷新页面才生效的那一类。 */
    function savePageSettings() {
      const box = pageBoxEl.value;
      if (!box) return false;
      const rows = window.PAGE_TARGETS.rows, SZ = window.PAGE_TARGETS.size;
      const defSize = k => (rows.find(r => r.key === k) || {}).defSize || SZ.min;
      let changed = false;
      const W = (k, v) => { if (window.LS.get(k) !== v) changed = true; window.LS.set(k, v); };
      box.querySelectorAll('[data-mode]').forEach(s => W('page_mode_' + s.dataset.mode, s.value));
      box.querySelectorAll('[data-size]').forEach(i =>
        W('page_size_' + i.dataset.size, String(Math.max(SZ.min, Math.min(SZ.max, Number(i.value) || defSize(i.dataset.size))))));
      return changed;
    }

    /* ---------- 外观与界面 + 产物存放（控件全部由 ui.js 的 UI_PREFS 现算） ---------- */
    const UI_PREF_CARDS = [
      { box: () => uiPrefsBoxEl.value, groups: ['look', 'list'] },
      { box: () => storePrefsBoxEl.value, groups: ['store'] },
    ];
    function uiRow(r, box) {
      const row = document.createElement('div');
      row.dataset.uik = r.key;
      if (r.kind === 'bool') {
        row.className = 'krow tight';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.ui = r.key;
        const lab = document.createElement('label');
        lab.className = 'crow';
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' ' + r.name));
        row.appendChild(lab);
        if (r.hint) { const h = document.createElement('span'); h.className = 'hint sm'; h.textContent = r.hint; row.appendChild(h); }
        box.appendChild(row);
        return;
      }
      row.className = 'krow thin';
      const kn = document.createElement('span');
      kn.className = 'kn';
      kn.textContent = r.name;
      const seg = document.createElement('div');
      seg.className = 'ui-seg';
      seg.dataset.ui = r.key;
      seg.innerHTML = r.opts.map(o => '<button type="button" data-v="' + window.esc(o[0]) + '">' + window.esc(o[1]) + '</button>').join('');
      row.appendChild(kn);
      row.appendChild(seg);
      if (r.hint) { const h = document.createElement('span'); h.className = 'hint sm'; h.textContent = r.hint; row.appendChild(h); }
      box.appendChild(row);
    }
    function renderUiPrefs() {
      const rows = (window.UI_PREFS && UI_PREFS.rows) || [];
      if (!rows.length) return;
      UI_PREF_CARDS.forEach(c => { const b = c.box(); if (b) b.innerHTML = ''; });
      rows.forEach(r => {
        const card = UI_PREF_CARDS.find(c => c.groups.indexOf(r.group) >= 0) || UI_PREF_CARDS[0];
        const box = card.box();
        if (!box) return;
        uiRow(r, box);
        let cur = window.LS.get(r.key) || '';
        if (r.kind === 'bool') {
          const cb = box.querySelector('[data-ui="' + r.key + '"]');
          if (cb) cb.checked = cur === '1';
          return;
        }
        const seg = box.querySelector('.ui-seg[data-ui="' + r.key + '"]');
        if (!seg) return;
        if (!r.opts.some(o => o[0] === cur)) cur = r.def;
        seg.querySelectorAll('[data-v]').forEach(b => {
          b.classList.toggle('on', b.dataset.v === cur);
          b.onclick = () => {
            seg.querySelectorAll('[data-v]').forEach(x => x.classList.toggle('on', x === b));
            markChanged();
          };
        });
      });
      const storeBox = storePrefsBoxEl.value;
      /* 底部一行实况：产物镜像存了多少、占了多少盘（口径只有 AssetLocal 一处）。 */
      try {
        if (window.AssetLocal && storeBox) {
          const line = document.createElement('div');
          line.className = 'hint sm';
          line.style.marginTop = '8px';
          const paint = st => {
            if (!st) return;
            const busy = st.inFlight > 0 ? '，正在存 ' + st.inFlight + ' 份' : '';
            const okLine = st.on
              ? ('本机已存 ' + st.count + ' 个产物，共 ' + mbOf(st.bytes) + busy
                + '（单个超过 200 MB 的不自动存）')
              : '自动存本机已关闭。';
            const parts = [okLine];
            if (st.on && st.lastAt) {
              parts.push(st.lastErr
                ? '最后一次没存成：' + st.lastErr + '（这一份下一轮列表刷新时会再试一次）'
                : '最后一次存成功。');
            }
            line.textContent = parts.join('　·　');
          };
          paint(AssetLocal.info ? AssetLocal.info() : AssetLocal.stats());
          if (AssetLocal.syncStats) AssetLocal.syncStats().then(paint).catch(() => {});
          if (AssetLocal.onInfo) storeStatsOff = AssetLocal.onInfo(i => paint(i));
          storeBox.appendChild(line);
        }
      } catch (e) {}
      renderExportDir(storeBox);
      renderLocalLib(storeBox);
      syncUiNeeds();
    }
    let storeStatsOff = null;
    /* ---------- 导出目录（浏览器 File System Access 句柄）----------
       成片与「导出素材」落到哪：showDirectoryPicker() 的句柄 → createWritable()；
       没有句柄时走普通下载（Wb.save）。**与「本机资产库」不是一回事**：
       那一格是服务端路径（代理写，/pick-dir），这一档是浏览器句柄（浏览器写）。 */
    function renderExportDir(box) {
      if (!box || !window.ExportDir) return;
      const head = document.createElement('div');
      head.className = 'sect-t';
      head.textContent = '导出目录';
      box.appendChild(head);
      const tip = document.createElement('div');
      tip.className = 'hint sm';
      tip.style.margin = '-4px 0 8px';
      tip.textContent = '浏览器渲染的成片与导出的素材落到这个文件夹（浏览器直接写进去）。'
        + '没选时存系统下载文件夹。';
      box.appendChild(tip);
      const row = document.createElement('div');
      row.className = 'krow';
      const lab = document.createElement('span');
      lab.className = 'kn';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool';
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'ghost xs';
      clr.textContent = '清除';
      const why = document.createElement('span');
      why.className = 'hint sm';
      if (!ExportDir.supported()) {
        lab.textContent = '未选择';
        btn.textContent = '选择文件夹';
        btn.disabled = true;
        btn.title = '浏览器不支持选目录';
        why.textContent = '不支持选目录，存系统下载文件夹';
        clr.disabled = true;
      } else {
        const paint = name => {
          if (name) {
            lab.textContent = name;
            btn.textContent = '重新选择';
            clr.disabled = false;
            why.textContent = '成片与导出素材会写进这个文件夹';
          } else {
            lab.textContent = '未选择（产物会进系统下载文件夹）';
            btn.textContent = '选择文件夹';
            clr.disabled = true;
            why.textContent = '';
          }
        };
        ExportDir.name().then(paint).catch(() => paint(''));
        btn.onclick = async () => {
          btn.disabled = true;
          const old = btn.textContent;
          btn.textContent = '等你在弹出的窗口里选…';
          try {
            const r = await ExportDir.pick();
            if (r.cancelled) { why.textContent = '你取消了，目录没改。'; }
            else if (!r.ok) { why.innerHTML = '<b style="color:var(--err)">没选到：</b>' + window.esc(r.why || ''); }
            else { paint(r.name); why.textContent = '✓ 已选好：' + r.name; }
          } finally { btn.disabled = false; btn.textContent = old; ExportDir.name().then(paint).catch(() => {}); }
        };
        clr.onclick = async () => {
          await ExportDir.forget();
          paint('');
          why.textContent = '已清除：产物会进系统下载文件夹';
        };
      }
      row.appendChild(lab); row.appendChild(btn); row.appendChild(clr); row.appendChild(why);
      box.appendChild(row);
    }
    /* 依附别的开关的那一项（needs）当场收起来 / 放出来。 */
    function syncUiNeeds() {
      const rows = (window.UI_PREFS && UI_PREFS.rows) || [];
      rows.forEach(r => {
        if (!r.needs || !r.needs.length) return;
        const el = q('[data-uik="' + r.key + '"]');
        if (el) el.hidden = !UI_PREFS.visible(r);
      });
    }

    /* ---------- 本机资产库：产物住在哪儿 ----------
       产物**只有一份**：库根\类型\<规范名>.<ext>，默认根就是用户翻得到的 下载\拾帧。
       「按类型另存到指定文件夹」那一族（三档开关 + 三格目录 + 补存 + 上次没存成）整块撤掉 ——
       实测一次生成写两遍同样的字节，两份都躺在用户自己的盘上。
       这一卡只做一件事：把库根指到哪儿（只有**一个**目录）。
       库根不是浏览器里的偏好：代理的 localRoot() 读的是 .data\sk_local_dir.json，
       所以这里写 localStorage 的 sk_local_dir，由 DataSync 镜像过去（同步名单在 datasync.js）。
       ⚠ 换根**不搬文件**，这一页也没有「把旧根搬进来」的入口：代理只扫当前根，
          旧根里那些产物在库里读不到文件（回源外链与费用记录照样在）。
          要接着用得自己在文件管理器里把旧根那一堆挪进新根 —— 挪进去就按 fid / 内容签名认回。 */
    const NO_PROXY_TXT = '这一页没接到本机代理的接口，读不到现在生效的位置 —— 请确认代理在跑。';
    const libRootDir = () => String(window.LS.get('sk_local_dir') || '').trim();
    function libRootSet(dir) {
      const v = String(dir || '').trim();
      /* 空串是「用默认」，不是「没配过」：把键删掉，代理那侧就读回落下载\拾帧。
         留一个空字符串在盘上，下次对账会把它当成一份有内容的配置拉回另一台机器。 */
      if (v) window.LS.set('sk_local_dir', v); else window.LS.del('sk_local_dir');
    }

    function renderLocalLib(box) {
      if (!box) return;
      const head = document.createElement('div');
      head.className = 'sect-t';
      head.textContent = '本机资产库';
      box.appendChild(head);
      const tip = document.createElement('div');
      tip.className = 'hint sm';
      tip.style.margin = '-4px 0 8px';
      tip.textContent = '每一次生成的产物只存这一份，落在下面这个位置里按类型分的 图片\\ / 视频\\ / 音频\\，'
        + '文件名是可读的那一种（场景-镜头-候选），同名自动加 -2、不覆盖。'
        + '自己在文件管理器里改名、挪进别的目录、整堆搬到另一块盘都还认得 —— 代理按「哪块盘上的哪个文件」'
        + '和头尾采样内容签名两级认回；账记在 .data\\local-assets\\，那是应用自己的账，跟着应用走、不跟着作品走。';
      box.appendChild(tip);

      const row = document.createElement('div');
      row.className = 'krow';
      const kn = document.createElement('span');
      kn.className = 'kn'; kn.textContent = '位置';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.dataset.libdir = '1';
      inp.placeholder = '默认：下载\\拾帧（留空就用它）';
      inp.value = libRootDir();
      inp.style.minWidth = '260px';
      /* 只有 change 才落盘，没有 oninput：半截路径一旦进盘，那几毫秒里正好存回的产物
         会新建并写进一个谁都没挑过的目录。 */
      inp.onchange = () => { saveLibDir(); };
      const why = document.createElement('span');
      why.className = 'hint sm'; why.dataset.libNote = '1';
      const pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'tool'; pick.textContent = '📁 选择…';
      pick.title = '弹出系统自带的文件夹选择框';
      pick.onclick = () => pickLibDir(inp, pick, why);
      const rst = document.createElement('button');
      rst.type = 'button'; rst.className = 'ghost xs'; rst.textContent = '恢复默认';
      rst.title = '清空这一格 → 产物回到系统「下载」下的 拾帧\\';
      rst.onclick = async () => {
        if (Confirm.arm(rst, '确认恢复默认', { key: 'lib-rst', hint: '再点一次就清空这一格目录 · 已经存下的文件一个都不动' })) return;
        inp.value = '';
        await saveLibDir();
        setLibNote('已恢复默认。');
      };
      row.appendChild(kn); row.appendChild(inp); row.appendChild(pick); row.appendChild(rst); row.appendChild(why);
      box.appendChild(row);

      /* 生效位置那一行读代理的读数，不读这一格：改了目录要重启才生效、或者那一格压根没被认，
         都只有「代理现在用的到底是哪儿」说得出真相。 */
      const where = document.createElement('div');
      where.className = 'hint sm'; where.dataset.libWhere = '1';
      where.textContent = '正在问代理现在用的是哪个位置…';
      box.appendChild(where);
      refreshLibRoot();
    }

    async function refreshLibRoot() {
      const el = q('[data-lib-where]');
      if (!el) return;
      if (!window.Api || !Api.sysStatus) { el.textContent = NO_PROXY_TXT; return; }
      try {
        const s = await Api.sysStatus(true);
        const d = (s && s.目录 && s.目录.资产) || {};
        const state = String(d.状态 || '');
        el.innerHTML = '代理现在用的位置：<b>' + window.esc(d.路径 || '（没读到）') + '</b>'
          + (state && state !== '可写' ? ' · ' + window.esc(state) : '')
          + '　·　账在 .data\\local-assets\\';
      } catch (e) {
        el.innerHTML = '<b style="color:var(--err)">读不到现在生效的位置：</b>' + window.esc(errText(e));
      }
    }

    async function pickLibDir(inp, btn, why) {
      if (!window.Api || !Api.pickDir) { if (why) why.innerHTML = '<b style="color:var(--err)">这页没加载到代理接口</b>'; return; }
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '等你在弹出的窗口里选…';
      if (why) why.textContent = '系统文件夹选择框已经弹出来了（可能在窗口后面），选完点「选择」或直接关掉它。';
      try {
        const r = await Api.pickDir({ title: '选择本机资产库放在哪里', start: String(inp.value || '').trim() });
        if (r && r.cancelled) { if (why) why.textContent = '你取消了，位置没改。'; return; }
        if (!r || !r.ok || !r.dir) {
          if (why) why.innerHTML = '<b style="color:var(--err)">没选到文件夹：</b>' + window.esc((r && r.error && r.error.message) || '代理没有回路径');
          return;
        }
        inp.value = r.dir;
        await saveLibDir();
        if (why) why.textContent = '已选好 · 路径写在上边那一格，可以直接改 · 下一次生成才落到这里';
      } catch (e) {
        if (why) why.innerHTML = '<b style="color:var(--err)">弹不出文件夹选择框：</b>' + window.esc(errText(e));
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    }

    /* 改位置**不搬文件**：新产物落新根，旧根里的字节留在原处，这一页不代用户动它。
       这里也不弹二次确认框 —— 那一格就是给用户改的，改完把「代理现在用的是哪儿」摊在眼前比弹窗有用。 */
    async function saveLibDir() {
      const el = q('[data-libdir]');
      const want = String((el && el.value) || '').trim();
      const prev = libRootDir();
      libRootSet(want);
      markChanged();
      await refreshLibRoot();
      if (prev !== want) {
        setLibNote(want ? ('位置已改成这一格（下一次生成才落到这里，已经在库里的文件不动）。')
          : '已留空，用默认位置。');
      }
    }

    function setLibNote(text, isErr) {
      const el = q('[data-lib-note]');
      if (!el) return;
      el.textContent = text;
      el.style.color = isErr ? 'var(--err)' : '';
    }
    function saveUiPrefs() {
      const __wasSaveOn = window.LS.get('sk_media_local') !== 'off';
      for (const r of ((window.UI_PREFS && UI_PREFS.rows) || [])) {
        const el = q('[data-ui="' + r.key + '"]');
        if (!el) continue;
        if (r.kind === 'bool') {
          if (el.checked) window.LS.set(r.key, '1'); else window.LS.del(r.key);
        } else {
          const b = el.querySelector('.on');
          if (b) window.LS.set(r.key, b.dataset.v);
        }
      }
      const top = window.top || window;
      /* 两根轴的偏好（dir_palette / dir_theme）刚才已写进存储；这里只让外壳**重新解析**一次 ——
         「跟随系统」要先看系统档位，所以不能把值直接写进 dataset.theme。 */
      try { if (top.__themeApply) top.__themeApply(); } catch (e) {
        /* 外壳引导脚本没跑起来：主题停在上一档，其余偏好照常保存。 */
      }
      try { if (top.__sbApplyOpen) top.__sbApplyOpen(); } catch (e) {}
      try {
        const nowSaveOn = window.LS.get('sk_media_local') !== 'off';
        if (nowSaveOn && !__wasSaveOn && window.AssetLocal && AssetLocal.markSaveOn) AssetLocal.markSaveOn();
      } catch (e) {}
      /* 「自动存档位 / 左栏两块开关」以前在这里手抄三份 LS.set —— 现在它们是 SET_ROWS 里的行，
         由自动保存那一趟的 saveManifestRows 统一落盘（一处声明，写盘只有一条路）。 */
      syncUiNeeds();
      try {
        const top = window.top || window;
        if (top.__sbApplyBalance) top.__sbApplyBalance();
        else if (top.__sbRefresh) top.__sbRefresh();
        if (top.__sbApplyOpen) top.__sbApplyOpen();
      } catch (e) {}
    }
    /* 主题两根轴的高亮以**存储**为准重画：解析可能来自别处（侧栏那颗日 / 夜按钮、
       系统深色档变化），这时两排分段要跟着亮到新档位，而不是停在旧的那一格。 */
    function syncThemePrefs() {
      const rows = (window.UI_PREFS && UI_PREFS.rows) || [];
      for (const key of ['dir_palette', 'dir_theme']) {
        const r = rows.find(x => x.key === key);
        const seg = q('.ui-seg[data-ui="' + key + '"]');
        if (!r || !seg) continue;
        let cur = window.LS.get(key) || '';
        if (!r.opts.some(o => o[0] === cur)) cur = r.def;
        seg.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === cur));
      }
      syncNav();
    }

    /* ---------- 素材库的设置（控件、默认值、文案全部来自 Chars.SET） ---------- */
    /* 型号下拉只有那一份实现（Chars.Pipe.modelSelectHTML，按平台分组）。
       「自动」那一档是**空值**：空 = 用注册表里第一个声明了这个 mode 的型号
       （顺序由设置页的「型号清单偏好」决定），也就是「不指定、按默认走」。 */
    function modelCtl(id, it, val) {
      let h = '';
      try { h = Chars.Pipe.modelSelectHTML(REG, { kind: it.modelKind, mode: it.mode, value: val, emptyText: '这一类还没有平台' }); }
      catch (e) { h = '<span class="hint sm">读不到平台清单</span>'; }
      if (h.indexOf('<select ') !== 0) return h;
      h = h.replace('<select ', '<select data-set="' + window.esc(id) + '" style="flex:0 0 260px" ');
      h = h.replace(/(<select [^>]*>)/, '$1<option value=""' + (val ? '' : ' selected') + '>自动（平台清单里第一个）</option>');
      return h;
    }
    function renderCharsSet() {
      const box = charsBoxEl.value;
      if (!box) return;
      const SET = window.Chars && window.Chars.SET;
      if (!SET) { box.innerHTML = '<span class="hint sm">读不到「素材库」的设置表（模块没加载，刷新一下这一页）</span>'; return; }
      box.innerHTML = '';
      Object.keys(SET).forEach(id => {
        const it = SET[id];
        const val = Chars.setting(id);
        let ctl;
        if (it.kind === 'bool') {
          ctl = '<label class="crow" style="flex:0 0 auto"><input type="checkbox" data-set="' + id + '"' + (val === '0' ? '' : ' checked') + '> 开启</label>';
        } else if (it.kind === 'num') {
          ctl = '<input type="number" min="0" step="' + window.esc(it.step || '0.5') + '" data-set="' + id + '" value="' + window.esc(val) + '" style="flex:0 0 110px">'
            + (it.unit ? '<span style="font-size: var(--fs-12-5);color:var(--sub)">' + window.esc(it.unit) + '</span>' : '');
        } else if (it.kind === 'model') {
          ctl = modelCtl(id, it, val);
        } else {
          ctl = '<select data-set="' + id + '" style="flex:0 0 210px">'
            + (it.options || []).map(o => '<option value="' + window.esc(o.id) + '"' + (o.id === val ? ' selected' : '') + '>' + window.esc(o.label) + '</option>').join('')
            + '</select>';
        }
        const row = document.createElement('div');
        row.className = 'krow thin';
        row.innerHTML = '<span class="kn">' + window.esc(it.label) + '</span>' + ctl
          + (it.hint ? '<span class="sub-line">' + window.esc(it.hint) + '</span>' : '');
        box.appendChild(row);
      });
      if (window.Dropdowns) Dropdowns.build(box);
    }
    function saveCharsSet() {
      const box = charsBoxEl.value;
      const SET = window.Chars && window.Chars.SET;
      if (!box || !SET) return;
      box.querySelectorAll('[data-set]').forEach(el => {
        const it = SET[el.dataset.set]; if (!it) return;
        if (it.kind === 'bool') window.LS.set(it.key, el.checked ? '1' : '0');
        else if (it.kind === 'num') {
          const n = Number(el.value);
          window.LS.set(it.key, String(Number.isFinite(n) && n > 0 ? n : Number(it.def)));
        } else if (it.kind === 'model') {
          /* 空 = 「自动」：把键**删掉**，不要留一个空串（留空串与没存过是两种意思）。 */
          if (el.value) window.LS.set(it.key, el.value); else window.LS.del(it.key);
        } else if (el.value) window.LS.set(it.key, el.value);
      });
    }

    /* ---------- 润色行为（提示词正文在 Skill 里，这里只剩「要不要先反问」；行本身在 SET_ROWS 声明） ----------
       旧版手改残留（sk_polish_* 除 ask）已由 tools/migrate-skills.cjs 一次性备份并删除，
       页面不再有「旧版清理」按钮 —— 代码也不再读那些键（优先级只剩 Skill 正文 → 内置默认）。 */

    /* ---------- AI 助手（四颗开关的行在 SET_ROWS 声明；这里只剩通知授权的说明行） ---------- */
    function noticeState() {
      if (!window.Notification) return '这个浏览器不给网页弹通知（球上的数字照旧会亮，点开就能看到结果）';
      const p = Notification.permission;
      if (p === 'granted') return '浏览器已授权：出结果会弹系统通知';
      if (p === 'denied') return '浏览器已经拒绝过授权，这里再点也不会弹 —— 要去地址栏左边的「网站设置」里放开';
      return '还没授权：勾上这一项之后，点一下「现在授权」，浏览器才会问你要不要弹';
    }
    function paintNoticeState() {
      const txt = noticeState();
      qa('[data-notice-state]').forEach(el => { el.textContent = txt; });
      const btn = q('[data-notice-btn]');
      if (btn) btn.disabled = !window.Notification || (window.Notification && Notification.permission === 'granted');
    }
    async function askNotice() {
      try { await Notification.requestPermission(); } catch (e) { Toast.err('授权失败：' + errText(e)); }
      paintNoticeState();
      if (window.Notification && Notification.permission === 'granted') {
        Toast.receipt('已授权');
        const cb = q('[data-mkey="ai_chat_notice"]');
        if (cb && !cb.checked) { cb.checked = true; markChanged(); }
      }
    }

    /* ---------- 网络与刷新（默认值与上下限只在 ui.js 的 Net.NUMS 一张表；行本身在 SET_ROWS 声明） ---------- */
    const NET_SP = (window.Net && window.Net.NUMS) || {
      timeout: { key: 'sk_net_timeout', def: 30, min: 5, max: 300 },
      retry: { key: 'sk_net_retry', def: 1, min: 0, max: 5 },
      poll: { key: 'sk_poll_sec', def: 4, min: 2, max: 60 },
    };
    const net = reactive({ timeout: 30, retry: 1, poll: 4 });
    function initNet() {
      ['timeout', 'retry', 'poll'].forEach(n => { net[n] = window.Net ? Net.num(n) : NET_SP[n].def; });
    }
    function onNetChange(name, ev) {
      if (!window.Net) return;
      const v = ev && ev.target ? ev.target.value : net[name];
      /* 回填 setNum 返回的那一个：用户填 999、真正在用的是 300，输入框就该显示 300。 */
      net[name] = Net.setNum(name, v);
      if (ev && ev.target) ev.target.value = net[name];
      markChanged();
    }

    /* ---------- 产物存放的第三档说明（文案随档位现算；行本身在 SET_ROWS 声明） ---------- */
    function saveScopeText() {
      return (currentScope() === 'new')
        ? '只存开启之后新生成的。已经生成的那些永远不会再补 —— 想补回来就切回上面那一档。'
        : '连历史产物一起补齐：第一次打开这一档会把列表里已有的产物逐个下载存进本机。'
          + '产物多的时候这会占不少带宽与磁盘（左栏会显示「正在存几份」）。';
    }
    /* 读「这一刻该按哪一档说」：优先看屏幕上刚选的值（自动保存还没落盘的那半秒）。 */
    function currentScope() {
      const el = q('[data-mkey="sk_media_local_scope"]');
      if (el && el.value) return el.value;
      const A = window.AssetLocal;
      return (A && A.saveScope) ? A.saveScope() : 'all';
    }
    function paintSaveScopeHint() {
      qa('[data-hint-of="saveScope"]').forEach(el => { el.textContent = saveScopeText(); });
    }

    /* ---------- SET_ROWS 的渲染与写盘（一处声明，两处现取） ---------- */
    const MANIFEST_HOSTS = () => ({
      net: netBoxEl.value, store: storeRowsEl.value, assistant: assistantBoxEl.value, polish: polishBoxEl.value,
    });
    function checkedOf(r) {
      const v = window.LS.get(r.key);
      if (v == null) return !!r.def;
      if (r.on != null && v === r.on) return true;
      if (r.off != null && v === r.off) return false;
      return !!r.def;
    }
    function renderManifestRows() {
      const hosts = MANIFEST_HOSTS();
      Object.keys(hosts).forEach(k => { const b = hosts[k]; if (b) b.innerHTML = ''; });
      SET_ROWS.forEach(r => {
        const box = hosts[r.card];
        if (!box) return;
        const row = document.createElement('div');
        row.className = r.kind === 'check' ? 'krow tight' : 'krow thin';
        if (r.kind === 'num') {
          const sp = (window.Net && window.Net.NUMS && window.Net.NUMS[r.name]) || NET_SP[r.name] || {};
          row.innerHTML = '<span class="kn">' + window.esc(r.label) + '</span>'
            + '<input type="number" data-mkey="' + window.esc(r.name) + '" min="' + (sp.min || 0)
            + '" max="' + (sp.max || 999) + '" step="' + (sp.step || 1) + '" value="' + window.esc(String(net[r.name])) + '" style="width:84px">'
            + '<span class="hint sm">' + window.esc((r.unit || '') + (r.hint ? ' · ' + r.hint : '')) + '</span>';
          row.querySelector('input').addEventListener('change', ev => onNetChange(r.name, ev));
        } else if (r.kind === 'check') {
          row.innerHTML = '<label class="crow" style="flex:1 1 240px"><input type="checkbox" data-mkey="'
            + window.esc(r.key) + '"' + (checkedOf(r) ? ' checked' : '') + '> ' + window.esc(r.label) + '</label>'
            + (r.hint ? '<span class="hint sm">' + window.esc(r.hint) + '</span>' : '');
          if (r.after === 'notice') {
            row.insertAdjacentHTML('beforeend',
              '<span class="acts"><button class="ghost mini" type="button" data-notice-btn>现在授权</button></span>'
              + '<span class="sub-line" data-notice-state></span>');
            row.querySelector('[data-notice-btn]').onclick = () => askNotice();
            row.querySelector('input').addEventListener('change', () => paintNoticeState());
          }
        } else {
          const cur = window.LS.get(r.key) || '';
          const val = r.opts.some(o => o[0] === cur) ? cur : r.def;
          row.innerHTML = '<span class="kn">' + window.esc(r.label) + '</span>'
            + '<select data-mkey="' + window.esc(r.key) + '" style="flex:1 1 260px;max-width:460px">'
            + r.opts.map(o => '<option value="' + window.esc(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>'
              + window.esc(o[1]) + '</option>').join('')
            + '</select>'
            + (r.hintDyn ? '<span class="hint sm" data-hint-of="' + window.esc(r.hintDyn) + '"></span>'
              : (r.hint ? '<span class="hint sm">' + window.esc(r.hint) + '</span>' : ''));
          if (r.hintDyn === 'saveScope') row.querySelector('select').addEventListener('change', () => paintSaveScopeHint());
        }
        box.appendChild(row);
      });
      if (window.Dropdowns) Object.keys(hosts).forEach(k => { const b = hosts[k]; if (b) Dropdowns.build(b); });
      paintSaveScopeHint();
      paintNoticeState();
    }
    /* 自动保存写盘的那一段：屏幕上每一项按声明的三态落盘。
       新增行没进导出名单时当场说出来（isSettingKey 由 EXPORTABLE 现算），不静默丢。 */
    function saveManifestRows(W, Wdel) {
      qa('[data-mkey]').forEach(el => {
        const k = el.dataset.mkey;
        if (el.type === 'number') { if (window.Net) Net.setNum(k, el.value); return; }
        const r = SET_ROWS.find(x => x.key === k);
        if (!r) return;
        if (r.kind === 'check') {
          const out = el.checked ? r.on : r.off;
          if (out == null) Wdel(r.key); else W(r.key, String(out));
        } else {
          W(r.key, el.value || String(r.def || ''));
        }
      });
    }

    /* ---------- 自动保存**写盘的那一份实现**：屏幕上这一份表单整个扫进 localStorage ----------
       每一项都走 W / Wdel 两个口：单项失败只记下这一项、不拖累其它项；
       结尾把失败的键逐条报出来（顶栏那一句常驻，见 paintSaveState）。 */
    async function saveAllNow() {
      saveFailed = ''; saveSkipped = '';
      const tpBefore = textForm ? textForm.prov() : null;
      const failedKeys = [];
      const W = (k, v) => { if (window.LS.set(k, v)) return true; if (failedKeys.indexOf(k) < 0) failedKeys.push(k); return false; };
      const Wdel = k => { if (window.LS.del(k)) return true; if (failedKeys.indexOf(k) < 0) failedKeys.push(k); return false; };
      /* 开写之前先探一下配额：已经满时下面几十项会逐项失败，报一长串键名不如当场说清。
         `LS.set` 把「写不进去」变成 false，探针按返回值判，不再靠异常。 */
      let quotaDead = !window.LS.set('_probe_write', '1');
      if (!quotaDead) window.LS.del('_probe_write');
      if (quotaDead) {
        saveFailed = '本机存储满，先清缓存。';
        paintSaveState();
        return false;
      }
      const skipped = [];
      /* 先把「本轮改过、但此刻没画出来」的草稿落盘（筛选芯片会把卡片收起来）。
         密钥与「验证」走同一份 cleanKey —— 以前落盘存原值、验证用清洗值，
         粘贴带 `Bearer ` 前缀的密钥（厂商控制台大多这么给）验证 ✓ 通过、
         之后所有润色 / 识图 / 助手请求 401，用户以为是自己配错了。 */
      const domKeys = new Set(qa('[data-key]').map(i => i.dataset.key));
      for (const [kid, v] of keyDraft) if (!domKeys.has(kid) && cleanKey(v)) W('sk_key_' + kid, cleanKey(v));
      for (const kid of keyCleared) if (!domKeys.has(kid)) Wdel('sk_key_' + kid);
      if (textForm && textForm.flushDrafts) textForm.flushDrafts(W, Wdel, skipped, domKeys);
      qa('[data-key]').forEach(inp => {
        if (cleanKey(inp.value)) W('sk_key_' + inp.dataset.key, cleanKey(inp.value));
        else Wdel('sk_key_' + inp.dataset.key);
      });
      keyDraft.clear();
      keyCleared.clear();
      if (textForm && textForm.clearDrafts) textForm.clearDrafts();
      /* 「暂时不用」在这里落盘（表单里其它地方一律不写盘）。先补「点过但此刻没画出来」的那几家：
         筛选芯片把卡片收起来时 DOM 里没有它们的勾选框，不清草稿下一次重画又会按盘上的旧值弹回。 */
      const domOff = new Set(qa('[data-off]').map(cb => cb.dataset.off));
      for (const [kid, v] of acctOffSet) {
        if (domOff.has(kid)) continue;
        if (v) W('sk_off_' + kid, '1'); else Wdel('sk_off_' + kid);
      }
      qa('[data-off]').forEach(cb => {
        if (cb.checked) W('sk_off_' + cb.dataset.off, '1');
        else Wdel('sk_off_' + cb.dataset.off);
      });
      acctOffSet.clear();
      /* 侧栏余额勾选：在现有名单上按这一行勾选增删，再顺手剪掉已经不存在的 kid。 */
      if (window.SbBal) {
        const off = new Set(SbBal.off());
        qa('[data-bal]').forEach(cb => { if (cb.checked) off.delete(cb.dataset.bal); else off.add(cb.dataset.bal); });
        const live = new Set((REG.providers || []).map(p => p.keyId || p.id));
        SbBal.setList([...off].filter(k => live.has(k)));
      }
      /* 「作用文字 AI」= 点某一张卡上「文字对话」那一格的状态牌（单选档换主位）。
         换一家会整块重画，DOM 里已经没有刚点中那一块，所以这一项由草稿带着落盘。 */
      const tp = textForm ? textForm.prov() : null;
      if (tp) {
        if (textPickDraft) W(TextAI.provKey(), textPickDraft);
        else if (!window.LS.get(TextAI.provKey())) W(TextAI.provKey(), tp.id);
        textPickDraft = '';
        TextAI.setFormOverride(tp, null);
      }
      /* 型号：每张卡上自己那个下拉，存进这一家的 sk_model_<keyId>（不按「当前那一家」筛）。 */
      qa('[data-tmodel]').forEach(sel => {
        const kid = sel.dataset.tmodel, m = sel.value;
        if (!m) return;
        const p = textForm ? textForm.textProvOf(kid) : null;
        if (p && TextAI.ownsModel && !TextAI.ownsModel(p, m, textForm.fetchedOf(p))) {
          skipped.push('型号「' + m + '」（不属于' + (p.name || '这一家') + '）');
        } else {
          W('sk_model_' + kid, m);
        }
      });
      const tvEl = q('[data-tvision]');
      if (tvEl) W('sk_text_vision', tvEl.value);
      /* 清单声明的那几行（润色反问 + AI 助手四颗开关 + 产物档位 + 左栏两块 + 网络三档数值）：
         值按 SET_ROWS 声明的三态现写，新增一行不用再回到这里补一句 W()。 */
      saveManifestRows(W, Wdel);
      const pgChanged = savePageSettings();
      saveUiPrefs();
      saveCharsSet();
      /* 语音识别 / 联网搜索：这两组不落 localStorage，改完也要跟着这一趟自动保存走
         （值真变过才发请求，没改不空跑）。存不进去就并进 skipped —— 页脚那句回执必须说实话。
         签名推进在 saveAsr / saveSearch 内部（手动那颗按钮走的是同一条），这里只留「变没变」这一道闸，
         不再在外层抄第二份账：手动存完之后外层还留着旧签名，下一次自动保存就把同一组值原样再发一遍。 */
      if (asrSig() !== asrSavedSig && !(await saveAsr())) {
        skipped.push('语音识别那一张卡（见卡片上那一行）');
      }
      if (searchSig() !== searchSavedSig && !(await saveSearch())) {
        skipped.push('联网搜索那一张卡（见卡片上那一行）');
      }
      const bad2 = skipped.concat(failedKeys.map(k => k + '（本机存不下）'));
      saveSkipped = bad2.length
        ? bad2.slice(0, 6).join('、') + (bad2.length > 6 ? ' 等 ' + bad2.length + ' 项' : '')
        : '';
      paintSaveState();
      /* 存完只**就地**重问「密钥来源」那一行与汇总，不整块 renderProv()（会把手指底下的节点换掉）。
         例外：换了「作用文字 AI」那一家必须重画（识图只画在当前那一家卡上）。 */
      refreshProvNotes();
      if ((textForm ? textForm.prov() : null) !== tpBefore) renderProv();
      if (pgChanged) Toast.warn('分页档位存好了 —— 要刷新页面才生效', 5000);
      return failedKeys.length === 0;
    }

    /* ---------- 设置导入 / 导出 / 恢复默认 ---------- */
    /* 界面偏好那一批（主题 / 侧栏开合 / 视图档位 / 产物开关）不在这里手抄：整批由 ui.js 的
       UI_PREFS 带出来，「恢复默认不清」那一份同表（`keep` 那一列）。这一张表以前是第三份手抄的清单，
       抄漏的是 sb_open 与 sk_media_badge 不进云同步、助手那几项不进导出。
       普通设置行那一批改由 SET_ROWS 带出来，理由一样：新增一项设置只改声明那行。
       只有助手那五颗开关**保留字面量**：tests/settings-schema.cjs 判据⑤点名要在这张数组里看到它们
       （那几条同时是「进导出 / 不进云同步 / 关掉助手不清」三项口径的证据），少一处就判不过。 */
    const EXPORTABLE = ['sk_key_', 'sk_base_', 'sk_model_', 'sk_off_', 'sk_caps_', 'sk_text_', 'sk_polish_', 'sk_dir_',
      'dir_', 'page_mode_', 'page_size_', 'sk_net_', 'sk_poll_sec', 'wb_split', 'sb_bal_show', 'char_',
      'sk_custom', 'sk_local_dir',
      /* AI 助手卡片上那四颗开关：设置页存得进去、导出文件里却没有 —— 换机器导一次设置就全回到默认档。
         刻意不写 'ai_chat_' 前缀：ai_chat（对话记录）与 ai_chat_files / _xy / _watch 是数据与本机窗口的事。 */
      'ai_chat_auto', 'ai_chat_off', 'ai_chat_snap', 'ai_chat_notice', 'ai_chat_dock', 'ai_chat_ref_send',
      ...SET_ROWS.filter(r => r.key).map(r => r.key),
      ...((window.UI_PREFS && window.UI_PREFS.keys) ? window.UI_PREFS.keys() : [])
    ];
    const DATA_KEYS = ['char_lib', 'char_groups'];
    const isSettingKey = k => !DATA_KEYS.includes(k) && EXPORTABLE.some(p => k === p || k.startsWith(p));
    const RESET_KEEP = ['sk_local_dir',
      /* 在这台机器上关掉助手是一次有意图的选择：「恢复默认」不该顺手把那颗悬浮球装回来。 */
      'ai_chat_off',
      ...SET_ROWS.filter(r => r.keep).map(r => r.key),
      ...((window.UI_PREFS && window.UI_PREFS.keepKeys) ? window.UI_PREFS.keepKeys() : [])
    ];
    function exportSettings(includeKeys) {
      const out = {};
      for (const k of window.LS.keys()) {
        if (!k) continue;
        if (!isSettingKey(k)) continue;
        if (!includeKeys && k.startsWith('sk_key_')) continue;
        out[k] = window.LS.get(k);
      }
      return { type: 'ai-workbench-settings', version: 1, ts: new Date().toISOString(), includeKeys: !!includeKeys, data: out };
    }
    function backupSettingsBefore(tag) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const name = 'ai-workbench-设置-' + stamp + '-' + tag + '.json';
        Net.save(new Blob([JSON.stringify(exportSettings(true), null, 2)], { type: 'application/json' }), name);
        return name;
      } catch (e) { return ''; }
    }
    /* 「从数据文件恢复」和「导入整包备份」都会把浏览器里当前那份数据整个盖掉，而盖下去之前
       手里这一份是唯一退路。「恢复默认」早就先导出再清（backupSettingsBefore），这两条以前是直接盖。
       这里补一份「只含数据」的整包（不带本机文件字节，体积与导出页那一档「只导出数据」一样）。
       导出没成不拦路：把「没有退路」如实写进回执，让用户知道这一次撤不回来。 */
    async function backupDataBefore(tag) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const name = 'ai-workbench-整包备份-' + stamp + '-' + tag + '.json';
        const pack = await DataSync.exportAll(false, false);
        Net.save(new Blob([JSON.stringify(pack)], { type: 'application/json' }), name);
        return name;
      } catch (e) { return ''; }
    }
    async function exportSetup() {
      if (!(await flushPending())) { Toast.err('设置没能完整存进本机：' + saveFailed); return; }
      const withKeys = await Confirm.choose({
        title: '导出设置', body: '密钥（平台 API Key）要不要一起导出？',
        options: [
          { value: 'nokeys', label: '不含密钥（推荐）', hint: '只导出接口地址、目录、分页、润色指令等设置；不含素材库与生成历史' },
          { value: 'keys', label: '含密钥', hint: '方便换电脑直接用，但文件里会有明文密钥，别外传' },
        ],
      });
      if (!withKeys) return;
      const json = JSON.stringify(exportSettings(withKeys === 'keys'), null, 2);
      const name = 'ai-workbench-设置-' + new Date().toISOString().slice(0, 10) + '.json';
      Net.save(new Blob([json], { type: 'application/json' }), name);
      Toast.receipt('已导出设置' + (withKeys === 'keys' ? '（含密钥）' : ''));
    }
    function pickImportSetup() { if (impSetFileEl.value) impSetFileEl.value.click(); }
    function onImportSetupFile(e) {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        try {
          const d = JSON.parse(r.result);
          if (!d || !['ai-workbench-settings', 'sparkcine-settings'].includes(d.type) || !d.data) throw new Error('不是本工具导出的设置文件');
          const n = Object.keys(d.data).length;
          const extra = Object.keys(d.data).filter(k => !isSettingKey(k));
          const ok = await Confirm.ask({ title: '导入设置', okLabel: '导入并覆盖',
            body: '将写入 ' + (n - extra.length) + ' 项设置（同名项会被覆盖）。导入后页面会自动刷新。'
              + (extra.length ? '\n文件里另有 ' + extra.length + ' 项不是设置项，会跳过：'
                + extra.slice(0, 5).join('、') + (extra.length > 5 ? ' 等' : '') : '') });
          if (!ok) return;
          await stopPendingSave();
          const bak = backupSettingsBefore('导入前');
          const bad = [];
          Object.entries(d.data).forEach(([k, v]) => {
            if (extra.includes(k)) return;
            if (!window.LS.set(k, v)) bad.push(k);
          });
          const wrote = n - bad.length - extra.length;
          if (bad.length) {
            Toast.after('已导入 ' + wrote + ' 项，' + bad.length + ' 项没写进去（本机存储满了，先清一点再试）：'
              + bad.slice(0, 3).join('、') + (bad.length > 3 ? ' 等' : '')
              + (bak ? '。导入前的设置已存为 ' + bak : '。导入前的设置没能导出备份'), 'err');
          } else if (extra.length) {
            Toast.after('已导入 ' + wrote + ' 项；文件里另有 ' + extra.length + ' 项不是设置（' + extra.slice(0, 3).join('、')
              + (extra.length > 3 ? ' 等' : '') + '），已跳过'
              + (bak ? '。导入前的设置已存为 ' + bak : '。导入前的设置没能导出备份'));
          } else {
            Toast.after('已导入 ' + wrote + ' 项设置（页面为此刷新了一次）'
              + (bak ? '。导入前的设置已存为 ' + bak : '。导入前的设置没能导出备份'));
          }
          reloadAfter(900);
        } catch (err) { Toast.err('导入失败：' + errText(err)); }
      };
      r.onerror = () => Toast.err('读取文件失败');
      r.readAsText(f);
    }
    async function resetSetup() {
      const ok = await Confirm.ask({ title: '恢复默认设置？', danger: true, okLabel: '清空设置',
        body: '会清掉：密钥、接口地址与型号、自定义供应商、润色指令、分页、网络与分栏等全部设置。\n'
          + '不会清掉：主题、视图偏好、生成历史、资产、收藏与素材库。\n'
          + '清空前会自动导出一份 JSON 到下载目录。' });
      if (!ok) return;
      await stopPendingSave();
      const bak = backupSettingsBefore('恢复默认前');
      const n = Store.sweep(k => !RESET_KEEP.includes(k) && isSettingKey(k));
      Toast.after('已清除 ' + n + ' 项设置，其余各项回到内置默认（页面为此刷新了一次）'
        + (bak ? '。撤销：把下载目录里的 ' + bak + ' 导回来' : '。清空前的设置没能导出备份'));
      reloadAfter(800);
    }
    async function reloadAfter(ms) {
      skLeaving = true;
      await stopPendingSave();
      setTimeout(() => location.reload(), ms || 800);
    }

    /* ---------- 数据与同步 ---------- */
    const dataInfo = ref('读取中…');
    const dataInfoTitle = ref('');
    const dataMsg = ref('');
    const persistInfo = ref('读取中…');
    const persistGranted = ref(false);
    const dataBusy = reactive({ copy: false, push: false, pull: false, exp: false, imp: false });
    /* 目录轨上「数据与同步」那一行的当前值（几份数据）—— 与 dataInfo 同源，只是短。 */
    const dataCount = ref(0);
    async function refreshDataInfo() {
      try {
        const r = await Net.fetch('/data', { timeout: 15000 });
        const d = await r.json();
        const n = (d.files || []).length;
        const kb = (d.files || []).reduce((a, f) => a + f.size, 0);
        dataCount.value = n;
        dataInfo.value = d.dir + ' · ' + n + ' 份数据 · ' + window.fmtBytes(kb);
        dataInfoTitle.value = d.dir;
      } catch (e) { dataInfo.value = '读不到（代理没在运行？）'; }
    }
    async function refreshPersistInfo() {
      if (!window.DataSync) return;
      const st = await DataSync.persistState();
      if (!st.supported) { persistInfo.value = '该浏览器不支持持久化申请'; return; }
      const use = st.usage ? '（已用 ' + mbOf(st.usage.usedBytes) + ' / 配额 ' + mbOf(st.usage.quotaBytes) + '）' : '';
      persistInfo.value = (st.granted ? '✓ 已持久化，浏览器不会自动清理' : '⚠ 未持久化：磁盘紧张时浏览器可能自动清理') + use;
      persistGranted.value = !!st.granted;
    }
    async function copyDataDir() {
      if (dataBusy.copy) return;
      dataBusy.copy = true;
      try {
        const d = await Net.json('/data', { timeout: 15000 });
        const ok = await window.copyText(d.dir);
        dataMsg.value = ok ? '✓ 路径已复制：' + d.dir : '复制失败，路径见左边';
      } catch (e) { dataMsg.value = '读不到数据目录'; }
      finally { dataBusy.copy = false; }
    }
    function reloadDataInfo() { refreshDataInfo(); refreshPersistInfo(); }
    async function askPersist() {
      const r = await DataSync.persist();
      dataMsg.value = r.granted ? '✓ 已获得持久化存储' : '浏览器这次没有授予（通常是因为站点使用度还不够，多用几次再来）';
      refreshPersistInfo();
    }
    async function pushData() {
      if (dataBusy.push) return;
      dataBusy.push = true; dataMsg.value = '正在写入…';
      try { const n = await DataSync.pushAll(); dataMsg.value = '✓ 已把本机数据写入 .data/（' + n + ' 项）'; }
      catch (e) { dataMsg.value = '失败：' + errText(e); }
      finally { dataBusy.push = false; refreshDataInfo(); }
    }
    async function pullData() {
      const ok = await Confirm.ask({ title: '从数据文件恢复？', danger: true, okLabel: '恢复并刷新',
        body: '会覆盖当前数据并自动刷新。覆盖前会自动备份到下载目录。' });
      if (!ok) return;
      if (dataBusy.pull) return;
      dataBusy.pull = true; dataMsg.value = '正在备份当前数据…';
      try {
        await stopPendingSave();
        const bak = await backupDataBefore('从数据文件恢复前');
        dataMsg.value = '正在恢复…';
        const n = await DataSync.pullAll();
        Toast.after('已从数据文件恢复 ' + n + ' 项（页面为此刷新了一次）'
          + (bak ? '。撤销：把下载目录里的 ' + bak + ' 导回来' : '。覆盖前的当前数据没能导出备份'));
        reloadAfter(800);
      } catch (e) { dataMsg.value = '失败：' + errText(e); dataBusy.pull = false; }
    }
    async function exportAll() {
      const pick = await Confirm.choose({
        title: '导出整包备份', body: '要带哪些一起？提示词归档是磁盘上的一堆 .md，不显式勾就带不走。',
        options: [
          { value: 'data', label: '只导出数据（推荐）', hint: '设置、历史、收藏列表、导演台工作区；体积小、恢复够用' },
          { value: 'prompts', label: '数据 + 提示词归档', hint: '再把归档文件夹里那几百上千份 .md 一起打包（纯文本，体积增加不大）' },
          { value: 'all', label: '连本地文件一起导出', hint: '体积可能大；不含提示词归档。' },
        ],
      });
      if (!pick) return;
      if (dataBusy.exp) return;
      dataBusy.exp = true; dataMsg.value = '正在打包…';
      try {
        const withPrompts = pick === 'prompts';
        const pack = await DataSync.exportAll(pick === 'all', withPrompts);
        const json = JSON.stringify(pack);
        const name = 'ai-workbench-整包备份-' + new Date().toISOString().slice(0, 10)
          + (pick === 'all' ? '-含文件' : '') + (withPrompts ? '-含提示词' : '') + '.json';
        const blob = new Blob([json], { type: 'application/json' });
        Net.save(blob, name);
        let extra = '';
        if (withPrompts) {
          extra = pack.prompts
            ? '，含提示词归档 ' + pack.prompts.files.length + ' 份'
              + (pack.prompts.skipped ? '（另有 ' + pack.prompts.skipped + ' 份超出上限没带上）' : '')
            : '，但提示词归档没带上：' + (pack.promptsError || '未知原因');
        }
        dataMsg.value = '✓ 已导出（' + mbOf(blob.size) + window.esc(extra) + '）';
      } catch (e) { dataMsg.value = '导出失败：' + errText(e); }
      finally { dataBusy.exp = false; }
    }
    function pickImportAll() { if (impAllFileEl.value) impAllFileEl.value.click(); }
    function onImportAllFile(e) {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        try {
          const pack = JSON.parse(r.result);
          const ok = await Confirm.ask({ title: '导入整包备份？', danger: true, okLabel: '导入并刷新',
            body: '会覆盖当前数据并自动刷新。覆盖前会自动备份到下载目录。' });
          if (!ok) return;
          dataMsg.value = '正在备份当前数据…';
          await stopPendingSave();
          const bak = await backupDataBefore('导入整包前');
          dataMsg.value = '正在导入…';
          const res = await DataSync.importAll(pack);
          Toast.after('已从备份导入：' + res.localStorage + ' 项数据' + (res.indexedDB ? '、' + res.indexedDB + ' 个本地文件' : '')
            + (res.promptNote ? '；' + res.promptNote : '')
            + (bak ? '；覆盖前的当前数据已存为 ' + bak : '；覆盖前的当前数据没能导出备份')
            + '（页面为此刷新了一次）');
          reloadAfter(900);
        } catch (err) { dataMsg.value = '导入失败：' + errText(err); }
      };
      r.onerror = () => { dataMsg.value = '读取文件失败'; };
      r.readAsText(f);
    }

    /* ---------- 云同步（WebDAV） ---------- */
    const CK = { url: 'sk_cloud_url', user: 'sk_cloud_user', pass: 'sk_cloud_pass', keys: 'sk_cloud_keys', prompts: 'sk_cloud_prompts' };
    const CLOUD_DEFAULT_URL = 'https://dav.jianguoyun.com/dav/ai-workbench/';
    const cloudUrl = ref(CLOUD_DEFAULT_URL);
    const cloudUser = ref('');
    const cloudPass = ref('');
    const cloudKeys = ref(false);
    const cloudPrompts = ref(false);
    const cloudMsg = ref('');
    const cloudState = ref('读取同步状态…');
    const cloudBusy = reactive({ test: false, push: false, pull: false, sync: false });
    function initCloud() {
      const g = k => window.LS.get(CK[k]);
      cloudUrl.value = (g('url') != null && g('url') !== '') ? g('url') : CLOUD_DEFAULT_URL;
      cloudUser.value = g('user') || '';
      cloudPass.value = g('pass') || '';
      cloudKeys.value = g('keys') === '1';
      cloudPrompts.value = g('prompts') === '1';
    }
    /* 这五格里存的是云端地址、账号与应用密码：写盘走 `window.LS`（本机存储唯一包装），
       写不进去时必须当场说清 —— 否则界面显示「已保存」，下次同步又读回空配置。 */
    function saveCloud() {
      let okAll = true;
      for (const [k, v] of [
        [CK.url, String(cloudUrl.value || '').trim()],
        [CK.user, String(cloudUser.value || '').trim()],
        [CK.pass, String(cloudPass.value || '')],
        [CK.keys, cloudKeys.value ? '1' : '0'],
        [CK.prompts, cloudPrompts.value ? '1' : '0'],
      ]) if (!window.LS.set(k, v)) okAll = false;
      if (okAll) return true;
      cloudMsg.value = '✗ 云端设置没存进本机：本机存储写不进去（配额已满，或浏览器在隐私模式）。'
        + '这一次仍按当前填的走，但刷新后会回到旧配置。';
      Toast.warn('云端设置没存进本机（本机存储写不进去）—— 刷新后会回到旧配置');
      return false;
    }
    function cloudHeaders() {
      saveCloud();
      const h = { 'Content-Type': 'application/json' };
      const u = String(cloudUrl.value || '').trim(), n = String(cloudUser.value || '').trim(), p = String(cloudPass.value || '');
      if (u) h['x-cloud-url'] = u;
      if (n) h['x-cloud-user'] = n;
      if (p) h['x-cloud-pass'] = p;
      if (cloudKeys.value) h['x-cloud-keys'] = '1';
      return h;
    }
    const cloudBody = () => JSON.stringify(cloudPrompts.value
      ? { prompts: 1, promptDir: (window.PromptLog && PromptLog.dir()) || '' } : {});
    /* 一次云端操作最多等 5 分钟。以前是 timeout:0（永不超时）又没有 AbortController：
       WebDAV 卡住时这一页会永远停在「处理中…」，只能刷新页面才能恢复。
       上限取 5 分钟而不是 2 分钟，是因为第一次同步可能整包搬提示词归档 ——
       两分钟会误伤一次本来在正常跑的操作（中止只是不再等，代理那一头还在跑，话要说清）。 */
    const CLOUD_MAX_MS = 300000;
    const cloudCtl = { test: null, push: null, pull: null, sync: null };
    /* 忙的时候那颗按钮就变成「中止这次」：不需要用户去找第二处入口 */
    function cloudAbort(cmd) {
      const c = cmd ? cloudCtl[cmd] : null;
      if (!c) return;
      try { c.abort(); } catch (e) {}
    }
    async function cloudCall(cmd) {
      if (cloudBusy[cmd]) return;
      cloudBusy[cmd] = true; cloudMsg.value = '';
      const ctl = new AbortController(); cloudCtl[cmd] = ctl;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { ctl.abort(); } catch (e) {} }, CLOUD_MAX_MS);
      try {
        const r = await Net.fetch('/cloud/' + cmd, { method: 'POST', headers: cloudHeaders(), body: cloudBody(), timeout: 0, retry: 0, signal: ctl.signal });
        const d = await r.json();
        if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
        let extra = '';
        if ((d.overwritten || []).length) {
          const list = d.overwritten.slice(0, 4).join('、') + (d.overwritten.length > 4 ? '…' : '');
          extra += '；用云端覆盖了本机较旧的 ' + d.overwritten.length + ' 份（覆盖前已在本机留 .bak.json：' + list + '）';
        }
        if ((d.averted || []).length) {
          extra += '；另有 ' + d.averted.length + ' 份' + (cmd === 'push'
            ? '云端更新，本次没上传（避免把云端覆盖成旧的）'
            : '本机更新，本次没下载（避免把本机覆盖成旧的）');
        }
        if ((d.conflicts || []).length) {
          extra += '；' + d.conflicts.length + ' 份两边都改过，已列为冲突待选择（见下方）';
        }
        if ((d.autoPicked || []).length) {
          extra += '；' + d.autoPicked.length + ' 份首次同步按时间取了较新的一份（' + d.autoPicked.slice(0, 3).join('、') + (d.autoPicked.length > 3 ? '…' : '') + '）';
        }
        if (d.prompts) {
          const p = d.prompts;
          if (p.error) extra += '；提示词归档没同步：' + p.error;
          else {
            if (p.up) extra += '；归档上传 ' + p.up + ' 份';
            if (p.down) extra += '；归档下载 ' + p.down + ' 份';
            if (p.onlyRemote) extra += '；云端有 ' + p.onlyRemote + ' 份这次没拿下来'
              + (cmd === 'push' ? '（这次是「只上传」，点「↓ 从云端下载」或「⇅ 一键双向同步」取回）' : '');
            if (p.failed && p.failed.length) extra += '；归档 ' + p.failed.length + ' 份失败：' + p.failed.slice(0, 3).join('、') + (p.failed.length > 3 ? '…' : '');
          }
        } else if (cloudPrompts.value) {
          extra += '；提示词归档没有参与这次同步（这一点不猜，见下方状态行）';
        }
        const note = (d.message || '完成') + extra;
        cloudMsg.value = '✓ ' + note;
        if ((cmd === 'pull' || cmd === 'sync') && (d.down || d.count)) {
          try { DataSync.resetBootFlags(); } catch (e) {}
          Toast.after(note + '（取回的那批要刷新才进浏览器，页面为此刷新了一次）');
          reloadAfter(900);
        }
        refreshDataInfo();
        refreshCloudPanel();
      } catch (e) {
        const m = String(errText(e)|| '');
        cloudMsg.value = timedOut
          ? '✗ 这次等了满 ' + Math.round(CLOUD_MAX_MS / 1000) + ' 秒还没回来，已经不等了。'
            + '代理那一头的同步可能仍在跑：先看下面的同步状态，别连着重发（两边同时写同一份容易互相覆盖）。'
          : /^请求已取消/.test(m)
            ? '✗ 已中止这次等待。云端那一份由代理继续跑完，先看下面的同步状态。'
            : '✗ ' + m;
      }
      finally { clearTimeout(timer); cloudCtl[cmd] = null; cloudBusy[cmd] = false; }
    }
    async function cloudPush() { await DataSync.flush(); cloudCall('push'); }
    async function cloudSync() { await DataSync.flush(); cloudCall('sync'); }
    async function cloudPull() {
      const ok = await Confirm.ask({ title: '从云端下载？', danger: true, okLabel: '下载并刷新',
        body: '云端比本机新的数据会覆盖到本机（含 .data/ 数据文件），然后自动刷新页面。' });
      if (ok) cloudCall('pull');
    }
    const fmtTime = ts => window.fmtWhenSec(ts) || '—';
    const escH = s => window.esc(s);
    const panelBox = (title, hint) => '<div class="cloud-box">'
      + '<div class="cb-title">' + title + '</div>'
      + (hint ? '<div class="cb-hint">' + hint + '</div>' : '');
    async function refreshCloudPanel() {
      if (!cloudState) return;
      let d = null;
      try { d = await Net.json('/cloud/status' + ((window.PromptLog && PromptLog.dir()) ? '?dir=' + encodeURIComponent(PromptLog.dir()) : ''), { timeout: 10000 }); }
      catch (e) { cloudState.value = '读不到同步状态（代理没在运行？）'; return; }
      cloudState.value = (d.lastAt ? '上次同步 ' + fmtTime(d.lastAt) + '：' + (d.lastResult || '') : '还没有同步过')
        + (d.envConfigured ? '（凭据来自 .env）' : '')
        + (d.prompts ? (d.prompts.error ? '；提示词归档：' + window.esc(d.prompts.error)
          : '；提示词归档本机 ' + d.prompts.count + ' 份' + (cloudPrompts.value ? '（已勾选跟着同步）' : '（未勾选跟着同步，勾上才会备份）'))
          : '');
      /* 冲突：每条两个按钮，选完立即执行（选云端会先在本机留 .bak.json 备份） */
      const cf = d.conflicts || [];
      const cBox = cloudConflictsEl.value;
      if (cBox) {
        if (!cf.length) cBox.innerHTML = '';
        else {
          cBox.innerHTML = panelBox('冲突待选择（' + cf.length + ' 份）',
            '两边都改过，为避免覆盖你的数据，这里不自动决定。选一边后立即生效。')
            + cf.map(x => '<div class="cloud-row">'
              + '<span class="cloud-key">' + escH(x.key) + '</span>'
              + '<span class="cloud-meta">本机 ' + escH(fmtTime(x.localTs)) + ' ／ 云端 ' + escH(fmtTime(x.remoteTs)) + '</span>'
              + '<button class="ghost mini xs" data-cf="' + escH(x.key) + '" data-side="local">用本机覆盖云端</button>'
              + '<button class="ghost mini xs" data-cf="' + escH(x.key) + '" data-side="remote">用云端覆盖本机</button>'
              + '</div>').join('') + '</div>';
          cBox.querySelectorAll('[data-cf]').forEach(b => {
            b.onclick = async () => {
              const key = b.dataset.cf, side = b.dataset.side;
              if (side === 'remote') {
                const ok = await Confirm.ask({ title: '用云端版本覆盖本机？', danger: true, okLabel: '覆盖本机',
                  body: '会覆盖本机这份数据（覆盖前自动留一份 .bak.json 可恢复），然后刷新页面。' });
                if (!ok) return;
              }
              b.disabled = true;
              try {
                const r = await Net.fetch('/cloud/resolve', { method: 'POST', headers: cloudHeaders(), body: JSON.stringify({ key, side }), timeout: 60000, retry: 0 });
                const rd = await r.json();
                if (!r.ok) throw new Error((rd.error && rd.error.message) || ('HTTP ' + r.status));
                if (side === 'remote') {
                  /* 只有「用云端覆盖本机」才需要刷新（那一份数据要重新进浏览器）。 */
                  Toast.after((rd.message || '已用云端版本覆盖本机') + '（页面为此刷新了一次）');
                  try { DataSync.resetBootFlags(); } catch (e) {}
                  reloadAfter(900);
                } else {
                  cloudMsg.value = '✓ ' + (rd.message || '已用本机覆盖云端');
                  refreshCloudPanel();
                }
              } catch (e) { Toast.err('解决冲突失败：' + errText(e)); b.disabled = false; }
            };
          });
        }
      }
      /* 备份：云端覆盖过本机的那些键，随时可以退回去 */
      let bk = [];
      try { bk = ((await Net.json('/cloud/backups', { timeout: 10000 })).items) || []; } catch (e) {}
      const bBox = cloudBackupsEl.value;
      if (bBox) {
        if (!bk.length) bBox.innerHTML = '';
        else {
          bBox.innerHTML = panelBox('备份（' + bk.length + ' 份）',
            '每次用云端覆盖本机之前，都会把本机那份留在 .data/ 里；恢复后刷新页面即生效。')
            + bk.slice(0, 12).map(x => '<div class="cloud-row">'
              + '<span class="cloud-key">' + escH(x.key) + '</span>'
              + '<span class="cloud-meta">' + escH(fmtTime(x.mtime)) + ' · ' + mbOf(x.size) + '</span>'
              + '<button class="ghost mini xs" data-bk="' + escH(x.key) + '">恢复这份</button>'
              + '</div>').join('')
            + (bk.length > 12 ? '<div class="cloud-more">…共 ' + bk.length + ' 份，仅列最近 12 份</div>' : '')
            + '</div>';
          bBox.querySelectorAll('[data-bk]').forEach(b => {
            b.onclick = async () => {
              const ok = await Confirm.ask({ title: '用备份覆盖当前数据？', danger: true, okLabel: '恢复并刷新',
                body: '会用 .data/ 里的那份备份覆盖本机当前数据文件（' + b.dataset.bk + '），然后刷新页面。' });
              if (!ok) return;
              b.disabled = true;
              try {
                const r = await Net.fetch('/cloud/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: b.dataset.bk }), timeout: 60000, retry: 0 });
                const rd = await r.json();
                if (!r.ok) throw new Error((rd.error && rd.error.message) || ('HTTP ' + r.status));
                Toast.after((rd.message || '已用那份备份覆盖本机') + '（页面为此刷新了一次）');
                try { DataSync.resetBootFlags(); } catch (e) {}
                reloadAfter(900);
              } catch (e) { Toast.err('恢复失败：' + errText(e)); b.disabled = false; }
            };
          });
        }
      }
    }

    /* ---------- 本机环境（GET /sys-status，纯读） ---------- */
    const sysMsg = ref('');
    const sysCopyDisabled = ref(true);
    const sysBusy = ref(false);
    let lastSys = null;
    /* 一行 = 名字 + 状态芯片 + 详情；芯片只有三档（ok / warn / err）。 */
    function chipRow(label, cls, chip, detail, title) {
      const e = s => window.esc(String(s == null ? '' : s));
      return '<div class="krow tight"><span class="kn">' + e(label) + '</span>'
        + '<span class="ui-tag ' + cls + '">' + e(chip) + '</span>'
        + '<span class="dir-name"' + (title ? ' title="' + e(title) + '"' : '') + '>' + e(detail) + '</span></div>';
    }
    /* 成片导出问的是**这个浏览器**（成片在页面里合成）：
       一行芯片 + 三个分项，分项说明进 title，与助手 doctor 读同一份 Api.exportCaps。 */
    function capsRow(c) {
      const items = c.items || [];
      const detail = items.length
        ? items.map(x => x.name + (x.ok ? ' 能用' : ' 不能用')).join(' · ')
        : (c.why || '');
      const title = [c.why || ''].concat(items.map(x => x.name + '：' + (x.ok ? '能用' : '不能用')
        + (x.detail ? ' —— ' + x.detail : ''))).filter(Boolean).join('\n');
      return chipRow('成片导出（本浏览器）', c.cls, c.chip, detail, title);
    }
    function dirRow(label, d) {
      if (!d) return chipRow(label, 'warn', '没读到', '代理没返回这一项');
      const r = Api.sysDir(d);
      return chipRow(label, r.cls, r.chip, (d.路径 || '?') + (r.why ? '（' + r.why + '）' : ''), d.路径);
    }
    function sysText(s) {
      return ['拾帧 本机环境体检 ' + window.fmtWhen(s.at || Date.now())]
        .concat(Api.sysStatusLines(s)).join('\n');
    }
    function syncSysCopyBtn() {
      sysCopyDisabled.value = !lastSys;
    }
    async function refreshSys(fresh) {
      sysMsg.value = '';
      let s = null;
      try { s = await Api.sysStatus(fresh); }
      catch (e) {
        lastSys = null; syncSysCopyBtn();
        if (sysRowsEl.value) {
          sysRowsEl.value.innerHTML = e && e.status === 404
            ? '<div class="ui-note info">本地代理的版本太旧，这一项它还不支持。'
              + '用「启动.bat → 2 停止 → 1 启动」重启一下，回来点「重新体检」。</div>'
            : '<div class="ui-note err">读不到本机环境：' + window.esc(errText(e)) + '</div>';
        }
        return;
      }
      lastSys = s; syncSysCopyBtn();
      /* 这一格不来自代理：导出能力只在浏览器里问得出来 */
      const caps = await Api.exportCaps(fresh);
      const p = s.代理 || {};
      const old = Api.oldProxyNotice(p.版本);
      let html = '';
      html += chipRow('本地代理', old ? 'err' : 'ok', old ? '版本太旧' : '在运行',
        '注册表 v' + (p.版本 || '?') + ' · 端口 ' + (p.端口 || '?') + ' · Node ' + (p.进程 || '?'),
        '代理目录：' + (p.目录 || ''));
      const hh = Api.sysHealth(s.健康);
      const healthSub = s.健康
        ? ('已运行 ' + hh.存活 + ' · 最后一次干活 ' + hh.最后请求
          + (hh.cls !== 'ok' ? ' —— 出路：回到启动器点「重启」（页面是这台代理发出来的，不能在这一页重启它），重启后这份账清零' : ''))
        : hh.why;
      html += chipRow('代理健康', hh.cls, hh.chip, healthSub,
        (s.健康 ? [(hh.why || ''), Api.sysFaultLines(hh.最近, 3).join('\n')] : []).concat(Api.SYS_WHY.健康).filter(Boolean).join('\n'));
      const op = s.出站代理;
      if (op) {
        const on = /^走 /.test(op.状态 || '');
        html += chipRow('出站代理', on ? 'ok' : 'warn', on ? '走代理' : '直连',
          (op.来源 || '没检测到代理') + (on ? '' : '（本机 / 内网地址始终直连）'), op.绕过 || '');
      }
      html += capsRow(caps);
      const rl = s.转发;
      if (rl) {
        html += chipRow('平台转发闸', rl.档 || 'warn', rl.芯片 || '?',
          '每家同时在途 ' + (rl.同时在途 || '?') + ' 条 · 排队上限 ' + (rl.排队上限 || '?') + ' 条 · 被限流最多重问 '
          + (rl.重试上限 || '?') + ' 次（只问读请求）· 最多等 ' + (rl.最多等秒 || '?') + ' 秒',
          (rl.说明 || '') + '\n' + Api.relayLines(rl, 3).join('\n') + '\n' + (rl.来源 || ''));
      }
      const dirs = s.目录 || {};
      html += dirRow('数据目录（.data）', dirs.数据);
      html += dirRow('本机资产目录', dirs.资产);
      html += dirRow('成片目录', dirs.渲染);
      if (old) html += '<div class="ui-note err">' + window.esc(old) + '</div>';
      if (sysRowsEl.value) sysRowsEl.value.innerHTML = html;
      sysMsg.value = '上次体检：' + window.fmtHMS(s.at || Date.now())
        + (fresh ? ' · 刚重新探过' : ' · 这一轮是代理缓存的（换过浏览器或改过目录权限请点「重新体检」）');
    }
    async function recheckSys() {
      if (sysBusy.value) return;
      sysBusy.value = true;
      try { await refreshSys(true); } finally { sysBusy.value = false; }
    }
    async function copySys() {
      if (!lastSys) { sysMsg.value = '✗ 现在没有可复制的体检结果：先点「重新体检」'; return; }
      const okc = await window.copyText(sysText(lastSys));
      sysMsg.value = okc ? '✓ 已复制 ' + sysText(lastSys).split('\n').length + ' 行体检结果，直接粘出去就行'
        : '✗ 浏览器不让写剪贴板（通常是因为这个标签页不在前台）；结果还摆在上面这一栏，手动选也行';
    }

    /* ---------- 资产库磁盘用量（GET /assets-usage，纯读） ---------- */
    const usageMsg = ref('');
    const usageCopyDisabled = ref(true);
    const usageBusy = ref(false);
    let lastUsage = null;
    const SHOW_TOP = 3;
    function usageText(u) {
      return ['拾帧 本机资产库用量 ' + (window.fmtWhen ? window.fmtWhen(u.at || Date.now()) : '')]
        .concat(Api.usageLines(u)).join('\n');
    }
    function syncUsageCopyBtn() { usageCopyDisabled.value = !lastUsage; }
    async function refreshUsage() {
      usageMsg.value = '';
      let u = null;
      try { u = await Api.assetsUsage(); }
      catch (e) {
        lastUsage = null; syncUsageCopyBtn();
        if (usageRowsEl.value) usageRowsEl.value.innerHTML = '<div class="ui-note err">数不出本机资产库：' + window.esc(errText(e)) + '</div>';
        return;
      }
      lastUsage = u; syncUsageCopyBtn();
      /* 404 → Api.assetsUsage 交回 null：说「这一项旧代理不支持」，不说「0 字节」。 */
      if (!u) {
        if (usageRowsEl.value) {
          usageRowsEl.value.innerHTML = '<div class="ui-note info">本地代理的版本太旧，这一项它还不支持。'
            + '用「启动.bat → 2 停止 → 1 启动」重启一下，回来点「重新数一遍」。</div>';
        }
        return;
      }
      const d = u.目录 || {};
      let html = chipRow('本机资产库', u.档 || 'warn', u.芯片 || '?',
        (u.因由 || []).join(' · ') || '没有要提醒的 —— 这一格只数不删', d.路径 || '');
      html += '<div class="dir-name" style="white-space:pre-wrap;line-height:1.85;margin-top: var(--sp-4)">'
        + window.esc(Api.usageLines(u, SHOW_TOP).join('\n')) + '</div>';
      if (usageRowsEl.value) usageRowsEl.value.innerHTML = html;
      usageMsg.value = '数于 ' + (window.fmtHMS ? window.fmtHMS(u.at || Date.now()) : '');
    }
    async function recountUsage() {
      if (usageBusy.value) return;
      usageBusy.value = true;
      try { await refreshUsage(); } finally { usageBusy.value = false; }
    }
    async function copyUsage() {
      if (!lastUsage) { usageMsg.value = '✗ 现在没有可复制的读数：先点「重新数一遍」'; return; }
      const txt = usageText(lastUsage);
      const okc = await window.copyText(txt);
      usageMsg.value = okc ? '✓ 已复制 ' + txt.split('\n').length + ' 行读数，直接粘出去就行'
        : '✗ 浏览器不让写剪贴板（通常是因为这个标签页不在前台）；读数还摆在上面这一栏，手动选也行';
    }

    /* ---------- 清理缓存 ---------- */
    const cacheMsg = ref('');
    const cacheUsage = ref('');
    const cacheBusy = reactive({ api: false, meta: false, thumb: false, missed: false });
    /* 目录轨上「清理缓存」那一行的当前值（本机 localStorage 占多少）—— 与 cacheUsage 同源，只是短。 */
    const cacheBytes = ref(0);
    function paintCacheUsage() {
      let total = 0; const rows = [];
      for (const k of window.LS.keys()) {
        const b = (k.length + String(window.LS.get(k) || '').length) * 2;
        total += b; rows.push([k, b]);
      }
      cacheBytes.value = total;
      rows.sort((a, b) => b[1] - a[1]);
      const top = rows.slice(0, 3).map(([k, b]) => k + ' ' + mbOf(b)).join('、');
      cacheUsage.value = '本机 localStorage 现在约 ' + mbOf(total)
        + '（浏览器上限通常约 5 MB）'
        + (total > 3.5 * 1024 * 1024 ? ' —— 快满了：清理下面「本地任务记录」或素材库里不要的条目才腾得出空间' : '')
        + (top ? '；占得最多：' + top : '');
    }
    async function runClear(key, fn) {
      if (cacheBusy[key]) return;
      cacheBusy[key] = true; cacheMsg.value = '';
      try { cacheMsg.value = await fn(); }
      catch (e) { cacheMsg.value = '✗ 清理失败：' + errText(e); }
      finally { cacheBusy[key] = false; paintCacheUsage(); }
    }
    const proxyCaches = async () => {
      const r = await Net.fetch('/clear-cache', { method: 'POST', timeout: 10000, retry: 0 });
      if (!r.ok) throw new Error('代理 HTTP ' + r.status + '（代理版本太旧？重启一下代理即可）');
      return (await r.json()).cleared || {};
    };
    function clearApiCache() {
      return runClear('api', async () => {
        Api.clearCaches();
        const c = await proxyCaches();
        const zh = { list: '列表', detail: '详情', assetUrl: '资产地址', cap: '能力' };
        return '✓ 本机应答缓存已清空；代理侧 ' + Object.keys(zh).map(k => zh[k] + ' ' + (c[k] || 0)).join('、')
          + ' 条（下次打开工作台会自动重新拉取）';
      });
    }
    function clearMetaCache() {
      return runClear('meta', async () => '✓ 已清掉 ' + TextAI.clearMeta() + ' 个型号的接口形状/识图判定（下次调用重新探测）');
    }
    function clearThumbCache() {
      return runClear('thumb', async () => {
        const n = await Wb.thumbs.clearAll();
        return '✓ 已清掉 ' + n + ' 张缩略图与 ' + Wb.clearSizes() + ' 条体积探测结果（列表会重新抽一次帧，之后照常秒开）';
      });
    }
    function clearMissedCache() {
      return runClear('missed', async () => '✓ 已清掉 ' + PromptLog.clearMissed() + ' 条「本机没有归档」标记（会重新去归档里找一次）');
    }
    /* 本地任务记录：kind / 键名 / 显示名都从 Wb.History 的声明现取，这里不写死平台。 */
    function renderHistRows() {
      const host = histBoxEl.value;
      if (!host) return;
      const kinds = (window.Wb && Wb.History.kinds()) || [];
      host.innerHTML = kinds.map(k => {
        const n = Wb.History.read(k.kind).length;
        return '<div class="krow" style="gap: var(--sp-8);flex-wrap:wrap;margin-top: var(--sp-10)">'
          + '<span class="kn">本地任务记录</span>'
          + '<span class="sub-line">' + window.esc(k.label) + '：本机 ' + n + ' 条。'
          + (n ? '这不是缓存：清掉后本机存的任务号与提示词就没了（平台上的任务与已生成的文件不受影响），删除还会同步进数据文件与云端。'
               : '本机没有记录。')
          + '</span>'
          + '<button class="ghost mini danger wide" data-hist="' + window.esc(k.kind) + '"'
          + (n ? '' : ' disabled') + '>清空</button></div>';
      }).join('');
      host.querySelectorAll('[data-hist]').forEach(b => { b.onclick = () => clearHist(b.dataset.hist); });
    }
    async function clearHist(kind) {
      const k = ((Wb.History.kinds() || []).find(x => x.kind === kind)) || { label: kind };
      const n = Wb.History.read(kind).length;
      const yes = await Confirm.ask({
        title: '清空' + k.label + '？', danger: true, okLabel: '确定清空',
        body: '这会删掉本机 ' + n + ' 条' + k.label + '（任务号、提示词、产物地址）。'
          + '已经生成出来的图片/语音文件本身不会被删除，平台列表里的任务也还在。'
          + '删除会同步到数据文件（.data/）和云端，云端会保留一份覆盖前的备份。',
      });
      if (!yes) return;
      if (!Wb.History.clear(kind)) { cacheMsg.value = '✗ 清空失败：浏览器存储写不进去（见上面的提示）'; return; }
      cacheMsg.value = '✓ 已清空 ' + k.label + '（' + n + ' 条）';
      renderHistRows();
      paintCacheUsage();
    }

    /* ---------- 提示词归档 ---------- */
    const promptDir = ref('');
    const promptInfo = ref('读取中…');
    const promptInfoTitle = ref('');
    const promptMsg = ref('');
    const promptOpenBusy = ref(false);
    /* 目录轨上「提示词归档」那一行的当前值（几份）—— 与 promptInfo 同源，只是短。 */
    const promptCount = ref(0);
    function paintPrompt(d) {
      const rows = d.recent || [];
      promptCount.value = d.count || 0;
      promptInfo.value = rows.length ? (d.count + ' 份归档') : '还没有归档';
      promptInfoTitle.value = d.dir || '';
      if (!promptRecentEl.value) return;
      if (!rows.length) { promptRecentEl.value.textContent = '创建任务后，提示词会自动归档到这里。'; return; }
      promptRecentEl.value.innerHTML = rows.slice(0, 8).map(r => {
        const t = window.fmtWhenSec(r.ts);
        return '<div>· <b>' + window.esc(r.t || r.f) + '</b> <span style="color:var(--sub)">' + window.esc(r.k || '') + ' · ' + window.esc(t) + '</span></div>';
      }).join('') + (rows.length > 8 ? '<div>…共 ' + d.count + ' 份，仅列最近 8 份</div>' : '');
    }
    async function refreshPrompt() {
      try { paintPrompt(await PromptLog.list()); }
      catch (e) { promptInfo.value = '读不到（本地代理没在运行？）'; if (promptRecentEl.value) promptRecentEl.value.textContent = ''; }
    }
    function initPromptArchive() {
      if (!window.PromptLog) return;
      promptDir.value = PromptLog.dir();
      refreshPrompt();
    }
    function onPromptDirChange() {
      /* 目录只存本机：换台机器路径就不一样了，跟着云同步反而添乱（所以不走 DataSync） */
      const ok = PromptLog.setDir(String(promptDir.value || '').trim());
      if (!ok) {
        promptDir.value = PromptLog.dir();
        promptMsg.value = '✗ 归档目录没能存进本机（浏览器存储写满或不允许写入）—— 这一项没改';
        return;
      }
      promptMsg.value = promptDir.value.trim() ? '✓ 归档目录已改为：' + promptDir.value.trim() : '✓ 已改回默认目录（下载\\拾帧\\提示词）';
      refreshPrompt();
    }
    function promptRefresh() { promptMsg.value = ''; refreshPrompt(); }
    async function openPromptDir() {
      if (promptOpenBusy.value) return;
      if (!PromptLog.setDir(String(promptDir.value || '').trim())) {
        promptDir.value = PromptLog.dir();
        promptMsg.value = '✗ 归档目录没能存进本机 —— 打开的仍是原来的目录';
      }
      promptOpenBusy.value = true;
      try { const d = await PromptLog.open(); promptMsg.value = '✓ 已打开：' + d.dir; }
      catch (e) { promptMsg.value = '打不开目录：' + errText(e); }
      finally { promptOpenBusy.value = false; }
    }

    /* ---------- Skill：按「使用场景」组织 ----------
       一级菜单 = 场景（分组与场景声明在 TextAI.SKILL_SCENE_GROUPS / SKILL_SCENES；
       场景名与「用在哪」沿用 PROMPTS —— 那是这条指令的唯一说明处）。
       点一个场景 → 右边给两件事：
         ① 这一步会拿到什么：变量表（TextAI.SKILL_VARS，按 contract 声明 —— **场景级**，
            不跟着某一份 Skill 走：换一份写法，喂料方式不变）
         ② 这个场景的 Skill：这一 contract 下的每一份，谁在生效、有没有冲突、怎么接管
       全量清单退到「全部 Skill」一个二级入口 —— 原来它与一级菜单并排，是那处重复的来源。
       解析与写盘全在代理的 skills-store。「复制为我的」「导出」两条已整族删除：
       要自己写一份就在浏览器里新建（下面那张 skillForm 表单）。 */
    const SKILL_FILTERS = [['all', '全部'], ['enabled', '已启用'], ['disabled', '已停用'], ['builtin', '内置'], ['user', '我的']];
    const skillItems = ref([]);
    const skillReady = ref(false);
    const skillMsg = ref('');
    const skillBusy = ref(false);
    const skillFileEl = ref(null);
    const skillChipsEl = ref(null);
    const skillPreEl = ref(null);
    /* 场景轨选中哪一个 / 右栏当前是「场景详情」「全部 Skill」还是「新建（编辑）Skill」 */
    const skillSceneKey = ref('');
    const skillMode = ref('scene');
    const skillQ = ref('');
    const skillAllQ = ref('');
    const skillAllFilter = ref('all');
    const skillSelId = ref('');        /* 展开了正文的那一份 */
    const skillActive = ref(null);     /* 当前场景里正在生效的那一份（正文用来查占位符） */
    const skillFiles = ref([]);
    const skillFilePath = ref('');
    const skillFileNote = ref('');
    let skillExpectedHash = '';
    let skillImportTarget = '';        /* 「导入同 id 更新」针对哪一份 */
    let skillFormHash = '';            /* 编辑时那份的当前 hash（更新要拿它对账） */
    /* 新建 / 编辑：浏览器里直接写一份 SKILL.md（frontmatter 由表单生成，正文自己敲） */
    const skillForm = reactive({
      mode: 'create', id: '', name: '', description: '', contract: '',
      triggers: '', pages: [], body: '', version: 1,
    });
    /* 页面能勾的页面（Skill 的 pages 字段只收页面文件名）：从路由表现取，不另抄一份 */
    const skillPages = computed(() => {
      const pages = (window.WB_ROUTES && window.WB_ROUTES.pages) || [];
      return pages.filter(p => p && p.file).map(p => p.file);
    });

    /* 场景表：分组 + 每组里的场景。场景名与「用在哪」从 PROMPTS 取（唯一说明处），
       SKILL_SCENES 里自带的那两条（助手、拆分镜素材判定）是 PROMPTS 没有的。 */
    const skillSceneTree = computed(() => {
      const TA = window.TextAI || {};
      const meta = {};
      (TA.PROMPTS || []).forEach(g => (g.items || []).forEach(it => { meta[it.key] = it; }));
      const groups = (TA.SKILL_SCENE_GROUPS || []).map(g => ({ id: g.id, name: g.name, note: g.note || '', scenes: [] }));
      const byId = {};
      groups.forEach(g => { byId[g.id] = g; });
      (TA.SKILL_SCENES || []).forEach(sc => {
        const g = byId[sc.group];
        if (!g) return;
        const pm = meta[sc.key] || null;
        g.scenes.push({
          key: sc.key, group: sc.group, assistant: !!sc.assistant,
          contract: (TA.SKILL_CONTRACT || {})[sc.key] || '',
          label: sc.label || (pm && pm.label) || sc.key,
          used: sc.used || (pm && pm.used) || '',
        });
      });
      return groups.filter(g => g.scenes.length);
    });

    /* 场景轨的搜索：场景名 / 说明 / 这一场景下的 Skill 名与 id 都算命中 */
    const skillTree = computed(() => {
      const kw = String(skillQ.value || '').trim().toLowerCase();
      if (!kw) return skillSceneTree.value;
      return skillSceneTree.value.map(g => ({
        id: g.id, name: g.name, note: g.note,
        scenes: g.scenes.filter(sc => {
          const hay = [sc.label, sc.used, sc.contract].concat(
            skillSceneState(sc).list.map(x => x.id + ' ' + x.name)
          ).join(' ').toLowerCase();
          return hay.indexOf(kw) >= 0;
        }),
      })).filter(g => g.scenes.length);
    });

    const skillScene = computed(() => {
      const tree = skillSceneTree.value;
      for (const g of tree) for (const sc of g.scenes) if (sc.key === skillSceneKey.value) return sc;
      /* 还没选过时落在第一个「占固定位」的场景上 —— 助手那一项不占位，不该是落点 */
      for (const g of tree) for (const sc of g.scenes) if (!sc.assistant) return sc;
      return tree.length ? (tree[0].scenes[0] || null) : null;
    });

    /* 这个场景里的 Skill 与槽位状态。服务端口径（skills-store.list）：
       同一 contract 下**第一个**启用的算数，后面那份被标成 conflict —— 别处也按这一份算。 */
    function skillSceneState(sc) {
      const items = skillItems.value || [];
      if (!sc) return { list: [], active: null, conflict: false, lamp: 'empty', text: '空档' };
      if (sc.assistant) {
        const on = items.filter(x => x && x.enabled);
        return { list: on, active: null, conflict: false, lamp: 'asst', text: on.length + ' 份已启用' };
      }
      const list = items.filter(x => x && x.contract === sc.contract);
      const on = list.filter(x => x.enabled);
      /* 谁在生效：**按服务端那枚 conflict 标签**取（它说谁是「被让位的那份」）。
         页面不能自己按清单顺序取第一个 —— 两份都启用时（老版本状态文件 / 手改）那会选错，
         界面说的「正在生效」和真正喂给 AI 的正文就不是同一份了。 */
      const active = on.find(x => !x.conflict) || null;
      const conflict = on.length > 1;
      return {
        list, active, conflict,
        lamp: conflict ? 'conflict' : (active ? (active.source === 'user' ? 'mine' : 'builtin') : 'empty'),
        text: conflict ? '冲突' : (active ? (active.source === 'user' ? '我的' : '内置') : '空档'),
      };
    }
    const skillSceneNow = computed(() => skillSceneState(skillScene.value));
    function isSceneActive(s) {
      const st = skillSceneNow.value;
      return !!(st.active && st.active.id === s.id);
    }
    /* 这一步会拿到什么（变量表）：场景级 —— TextAI.SKILL_VARS 按 contract 声明 */
    const skillSceneVars = computed(() => {
      const sc = skillScene.value;
      if (!sc || !sc.contract) return [];
      const TA = window.TextAI || {};
      return (TA.SKILL_VARS || {})[sc.contract] || [];
    });
    /* 生效中的那份正文用了场景说明里没登记的占位符 → 提醒（程序不会填这个位置） */
    const skillSceneUnknown = computed(() => {
      const act = skillActive.value;
      if (!act || !act.body) return [];
      const known = skillSceneVars.value.map(v => v.name);
      const names = (window.TplVars && TplVars.names) ? TplVars.names(act.body) : [];
      return names.filter(n => known.indexOf(n) < 0);
    });
    /* 「全部 Skill」里的清单（筛选 + 搜索） */
    const skillAllFiltered = computed(() => {
      const kw = String(skillAllQ.value || '').trim().toLowerCase();
      return (skillItems.value || []).filter(it => {
        if (skillAllFilter.value === 'enabled' && !it.enabled) return false;
        if (skillAllFilter.value === 'disabled' && it.enabled) return false;
        if (skillAllFilter.value === 'builtin' && it.source !== 'builtin') return false;
        if (skillAllFilter.value === 'user' && it.source !== 'user') return false;
        if (!kw) return true;
        const hay = [it.id, it.name, it.description, (it.triggers || []).join(' '), it.contract].join(' ').toLowerCase();
        return hay.indexOf(kw) >= 0;
      });
    });
    const skillCntText = computed(() => skillAllFiltered.value.length + ' / ' + (skillItems.value || []).length + ' 份 Skill');
    /* 这份 Skill 归哪个场景（全量清单里那一列） */
    function skillSceneNameOf(contract) {
      if (!contract) return '—';
      const tree = skillSceneTree.value;
      for (const g of tree) for (const sc of g.scenes) if (sc.contract === contract) return sc.label;
      return contract;
    }

    /* 点一个场景 = 右边换成这个场景的详情（变量表 + 这一场景的 Skill）。 */
    function pickSkillScene(sc) {
      if (!sc) return;
      skillSceneKey.value = sc.key;
      skillMode.value = 'scene';
      skillSelId.value = '';
      skillFiles.value = [];
      skillFilePath.value = '';
      if (skillPreEl.value) skillPreEl.value.textContent = '';
      loadSceneActive(sc);
    }
    /* 当前场景里正在生效的那一份的正文 —— 用来查它用了哪些占位符 */
    async function loadSceneActive(sc) {
      const key = sc && sc.key;
      skillActive.value = null;
      const st = skillSceneState(sc);
      if (!st.active) return;
      try {
        const d = await window.WbSkills.full(st.active.id);
        /* 等这一趟的功夫里可能已经切到别的场景了 —— 别把上一格的正文按到这一格上 */
        if (key && skillScene.value && skillScene.value.key !== key) return;
        skillActive.value = d;
      } catch (e) { /* 读不出来就不提占位符那一条，别的照常 */ }
    }
    function openSkillAll() {
      skillMode.value = 'all';
      nextTick(() => paintSkillChips());
    }
    function closeSkillAll() {
      skillMode.value = 'scene';
    }

    function paintSkillChips() {
      if (!window.Chips || !skillChipsEl.value) return;
      window.Chips.render(skillChipsEl.value, SKILL_FILTERS, skillAllFilter.value, v => {
        skillAllFilter.value = v;
        paintSkillChips();
      });
    }
    function onSkillSearch(e) { skillQ.value = e.target.value; }
    function onSkillAllSearch(e) { skillAllQ.value = e.target.value; }

    async function reloadSkills(force) {
      if (!window.WbSkills) { skillMsg.value = 'Skill 客户端没有加载（web/ui/skills.js）'; return; }
      skillBusy.value = true;
      try {
        skillItems.value = await window.WbSkills.list(!!force);
        if (skillSelId.value && !skillItems.value.some(x => x.id === skillSelId.value)) {
          skillSelId.value = '';
          skillFiles.value = [];
          skillFilePath.value = '';
          if (skillPreEl.value) skillPreEl.value.textContent = '';
        } else if (skillSelId.value) {
          await loadSkillDetail(skillSelId.value, true);
        }
        paintSkillChips();
        /* 当前场景里生效的那一份可能换人了（启停 / 卸载 / 装新的一份）→ 重读它的正文 */
        const sc = skillScene.value;
        if (sc) await loadSceneActive(sc);
      } catch (e) {
        skillMsg.value = '读不到 Skill 清单：' + errText(e);
      } finally {
        skillReady.value = true;
        skillBusy.value = false;
      }
    }

    async function loadSkillDetail(id, quiet) {
      const s = await window.WbSkills.full(id);
      const f = await window.WbSkills.files(id);
      skillFiles.value = f.files || [];
      if (!s.contentHash && f.hash) s.contentHash = f.hash;
      /* 变量表不跟着这一份走 —— 它跟着**场景**走（TextAI.SKILL_VARS 按 contract 声明）。
         这一份的正文只用来预览，以及算「它用了哪些占位符」那条提醒。 */
      const main = skillFiles.value.find(x => x.path === 'SKILL.md') || skillFiles.value[0];
      await openSkillFile(main ? main.path : '');
      if (!quiet) await nextTick();
    }

    /* 展开一份 Skill 的正文（文件树 + 预览）。同一时刻只展开一份。 */
    async function toggleSkillOpen(id) {
      if (!id) return;
      if (skillSelId.value === id) {
        skillSelId.value = '';
        skillFiles.value = [];
        skillFilePath.value = '';
        if (skillPreEl.value) skillPreEl.value.textContent = '';
        return;
      }
      skillSelId.value = id;
      skillBusy.value = true;
      try {
        await loadSkillDetail(id);
      } catch (e) {
        skillFiles.value = [];
        Toast.err('读不到这份 Skill：' + errText(e));
      } finally {
        skillBusy.value = false;
      }
    }

    /* 预览那一块 <pre> 在列表行里（v-for），普通 ref 会收成数组 —— 用函数 ref 拿准那一个。 */
    function setSkillPreEl(el) { skillPreEl.value = el; }

    async function openSkillFile(path) {
      skillFilePath.value = path || '';
      skillFileNote.value = '';
      await nextTick();
      if (!path) {
        if (skillPreEl.value) skillPreEl.value.textContent = '';
        return;
      }
      try {
        const text = await window.WbSkills.readFile(skillSelId.value, path);
        if (skillPreEl.value) skillPreEl.value.textContent = text;
        const n = text ? text.split(/\r?\n/).length : 0;
        skillFileNote.value = n + ' 行 · ' + text.length + ' 字';
      } catch (e) {
        if (skillPreEl.value) skillPreEl.value.textContent = '读不到这个文件：' + errText(e);
        skillFileNote.value = '读取失败';
      }
    }

    /* 启停：按行来（行上那一颗按钮），不再走「选中哪一份」那套。 */
    async function toggleSkillEnabled(id) {
      const it = (skillItems.value || []).filter(x => x.id === id)[0];
      if (!it) return;
      const on = !it.enabled;
      skillBusy.value = true;
      try {
        const r = await window.WbSkills.setEnabled(id, on);
        /* 同 contract 的原来那份被服务端**直接停掉**了 —— 回执里要点名，
           不然界面上突然少了一份在用，人会以为出错了。 */
        const dis = (r && r.displaced) || [];
        const tail = dis.length ? '（同一 contract 只留一份，原来的 ' + dis.join('、') + ' 已自动停用）' : '';
        skillMsg.value = '✓ ' + (on ? '已启用 ' : '已停用 ') + id + tail + '：下一轮助手请求生效';
        Toast.receipt((on ? '已启用 ' : '已停用 ') + id + tail + '：下一轮助手请求生效');
        await reloadSkills(true);
      } catch (e) {
        Toast.err(errText(e) || '切换失败');
      } finally {
        skillBusy.value = false;
      }
    }

    /* ---------- 新建 / 编辑：在浏览器里直接写一份 Skill ----------
       「添加新 Skill」开的是空白表单（contract 预填当前场景）；「编辑正文」开的是已有那一份。
       frontmatter 由表单生成，正文自己敲 —— 落盘走 /skills/install（新建）或 /skills/:id/update（改）。
       ⚠ 内置 Skill 只读：改不了内置那一份。要改就自己新建一份占同一个 contract
         （服务端会把同 contract 的内置那份自动停用）。 */
    function skillFormReset(sc) {
      skillForm.mode = 'create';
      skillForm.id = '';
      skillForm.name = '';
      skillForm.description = '';
      skillForm.contract = (sc && sc.contract) || (skillScene.value && skillScene.value.contract) || '';
      skillForm.triggers = '';
      skillForm.pages = [];
      skillForm.body = '';
      skillForm.version = 1;
      skillFormHash = '';
    }
    function openSkillNew() {
      const sc = skillScene.value;
      if (!sc || !sc.contract) {
        Toast.err('助手那一项不占固定位 —— 给某类活儿写一份，要去左栏选那个场景');
        return;
      }
      skillFormReset(sc);
      skillMode.value = 'new';
    }
    async function openSkillEdit(id) {
      const it = (skillItems.value || []).filter(x => x.id === id)[0];
      if (!it || it.source === 'builtin') { Toast.err('内置 Skill 是只读的 —— 要改就自己新建一份'); return; }
      skillBusy.value = true;
      try {
        const d = await window.WbSkills.full(id);
        skillForm.mode = 'edit';
        skillForm.id = d.id;
        skillForm.name = d.name || '';
        skillForm.description = d.description || '';
        skillForm.contract = d.contract || '';
        skillForm.triggers = (d.triggers || []).join('、');
        skillForm.pages = (d.pages || []).slice();
        skillForm.body = d.body || '';
        skillForm.version = d.version || 1;
        skillFormHash = d.contentHash || '';
        skillMode.value = 'new';
      } catch (e) {
        Toast.err('读不到这份 Skill：' + errText(e));
      } finally {
        skillBusy.value = false;
      }
    }
    /* frontmatter 由表单生成：id / name / description / triggers / pages / contract / version。
       正文原样接在后面 —— 那是这份 Skill 真正的内容。 */
    function skillFormFiles() {
      const trig = String(skillForm.triggers || '').split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean);
      const pages = (skillForm.pages || []).filter(Boolean);
      const q = s => '"' + String(s || '').replace(/"/g, '').replace(/[\r\n]/g, ' ') + '"';
      const fm = ['---',
        'id: ' + String(skillForm.id || '').trim(),
        'name: ' + String(skillForm.name || '').replace(/[\r\n]/g, ' '),
        'description: ' + String(skillForm.description || '').replace(/[\r\n]/g, ' '),
        'triggers: [' + trig.map(q).join(', ') + ']',
        'pages: [' + pages.map(q).join(', ') + ']',
        'contract: ' + skillForm.contract,
        'version: ' + (skillForm.version || 1),
        '---', ''].join('\n');
      return [{ path: 'SKILL.md', text: fm + '\n' + String(skillForm.body || '') }];
    }
    async function saveSkillNew() {
      const id = String(skillForm.id || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) { Toast.err('id 只能用小写字母、数字与连字符（2–41 个字符）'); return; }
      if (!String(skillForm.name || '').trim()) { Toast.err('给它起个名字'); return; }
      if (!String(skillForm.description || '').trim()) { Toast.err('写一句它管什么（description 必填）'); return; }
      if (!String(skillForm.body || '').trim()) { Toast.err('正文是空的 —— 这份 Skill 要告诉 AI 怎么写'); return; }
      const wasEdit = skillForm.mode === 'edit';
      skillBusy.value = true;
      try {
        const files = skillFormFiles();
        if (wasEdit) {
          /* 更新是整目录换：不带上 references 等附属文件，它们会跟着没掉 —— 一并带回去。 */
          const extra = [];
          try {
            const fl = await window.WbSkills.files(id);
            for (const f of (fl.files || [])) {
              if (f.path === 'SKILL.md') continue;
              try { extra.push({ path: f.path, text: await window.WbSkills.readFile(id, f.path) }); }
              catch (e) { /* 读不到的那一个附属文件就跳过：只更新 SKILL.md 也算数 */ }
            }
          } catch (e) { /* 读不到附属文件就只更新 SKILL.md */ }
          await window.WbSkills.update(id, files.concat(extra), skillFormHash);
          skillMsg.value = '✓ 已更新 ' + id;
          Toast.receipt('已更新 ' + id);
        } else {
          const r = await window.WbSkills.install(files, { enable: true });
          const s = r.skill || {};
          /* 装上去就等于「启用这一份」：同 contract 的原来那份**直接让位**（服务端干的），
             回执里点名是谁让的位。 */
          const dis = (r && r.displaced) || [];
          const tail = dis.length ? '（并已启用：同一 contract 上的 ' + dis.join('、') + ' 已自动停用）' : '（并已启用）';
          skillMsg.value = '✓ 已新建 ' + s.id + tail;
          Toast.receipt('已新建 ' + s.id + tail);
        }
        skillMode.value = 'scene';
        await reloadSkills(true);
        if (wasEdit) await toggleSkillOpen(id);
      } catch (e) {
        Toast.err('保存失败：' + errText(e));
      } finally {
        skillBusy.value = false;
      }
    }
    function cancelSkillNew() {
      skillMode.value = 'scene';
      skillFormReset(null);
    }

    /* 「复制为我的 Skill」这条整族删掉了：内置只读，要自己写一份就用上面那张表单新建。 */

    function pickSkillFile(mode, id) {
      skillImportTarget = mode === 'update' ? (id || '') : '';
      if (skillImportTarget) {
        const it = (skillItems.value || []).filter(x => x.id === skillImportTarget)[0];
        if (!it || it.source === 'builtin') { skillImportTarget = ''; return; }
        /* 更新要拿当前 hash 对账：现场读一次（清单里没有 hash） */
        window.WbSkills.full(skillImportTarget).then(d => {
          skillExpectedHash = d.contentHash || '';
          if (skillFileEl.value) skillFileEl.value.click();
        }).catch(e => Toast.err('读不到这一份的当前版本：' + errText(e)));
        return;
      }
      skillExpectedHash = '';
      if (skillFileEl.value) skillFileEl.value.click();
    }

    async function skillFilesFromPick(file) {
      if (/\.zip$/i.test(file.name)) {
        if (!window.ZipRead) await window.__spaLoadScript('web/domain/zip-read.js', () => window.ZipRead);
        const r = await window.ZipRead.read(file);
        return r.files;
      }
      if (!/\.md$/i.test(file.name)) throw new Error('只接受 .md 或 .zip');
      if (file.size > 1024 * 1024) throw new Error('SKILL.md 超过 1MB');
      return [{ path: 'SKILL.md', text: await file.text() }];
    }

    async function onImportSkillFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      skillBusy.value = true;
      const target = skillImportTarget;
      try {
        const next = await skillFilesFromPick(file);
        if (target) {
          await window.WbSkills.update(target, next, skillExpectedHash);
          skillMsg.value = '✓ 已更新 ' + target;
          Toast.receipt('已更新 ' + target);
          await reloadSkills(true);
        } else {
          const r = await window.WbSkills.importBundle(next, { enable: false });
          const s = r.skill || {};
          skillMsg.value = '✓ 已导入 ' + s.id + '（默认停用，需要时再启用）';
          Toast.receipt('已导入 ' + s.id + '（默认停用，需要时再启用）');
          await reloadSkills(true);
        }
      } catch (err) {
        const msg = errText(err);
        if (err && err.currentHash) Toast.err('Skill 已经变了（当前 hash ' + String(err.currentHash).slice(0, 12) + '），刷新后再更新');
        else Toast.err('导入失败：' + msg);
        if (/已经变了/.test(msg)) { try { await reloadSkills(true); } catch (e2) {} }
      } finally {
        skillImportTarget = '';
        skillExpectedHash = '';
        skillBusy.value = false;
      }
    }

    /* 「导出」这条整族删掉了：Skill 不再往外发文件；要留一份就用「编辑正文」把内容拷走。 */

    async function removeSkill(id, e) {
      const it = (skillItems.value || []).filter(x => x.id === id)[0];
      if (!it) return;
      const btn = e && e.currentTarget;
      if (window.Confirm && Confirm.arm && btn) {
        if (window.Confirm.arm(btn, '确认卸载', {
          key: id,
          note: '卸载后 .skills/' + id + ' 的文件与启用状态都会被删除。',
        })) return;
      }
      skillBusy.value = true;
      try {
        await window.WbSkills.remove(id);
        skillMsg.value = '✓ 已卸载 ' + id;
        Toast.receipt('已卸载 ' + id);
        if (skillSelId.value === id) {
          skillSelId.value = '';
          skillFiles.value = [];
          skillFilePath.value = '';
          if (skillPreEl.value) skillPreEl.value.textContent = '';
        }
        await reloadSkills(true);
      } catch (err) {
        Toast.err('卸载失败：' + errText(err));
      } finally {
        skillBusy.value = false;
      }
    }

    function fmtSkillSize(n) {
      return window.fmtBytes(Number(n) || 0);
    }

    /* ---------- 语音识别（ASR）与联网搜索：服务端设置，模块按需加载 ----------
       这两项不进 localStorage：密钥只在代理那一边的 .data/asr.json / search.json，
       页面读回来只有 hasKey。设置页只负责画表单，查询/转写仍走 window.Asr / window.Search。 */
    const asrProvEl = ref(null);
    const searchChannelEl = ref(null);
    const asr = reactive({
      route: 'auto', language: '',
      /* 型号空着 = 用这一家声明里的默认型号（whisper-1 / glm-asr-2512 / FunAudioLLM/SenseVoiceSmall…） */
      service: { providerId: '', model: '', baseUrl: '', hasKey: false },
    });
    const asrKey = ref('');
    const asrLocal = ref(null);
    const asrBrowser = ref(null);
    const asrBusy = ref(false);
    const asrMsg = ref('');
    const asrTestText = ref('');
    const asrProvOpts = ref([]);
    const search = reactive({
      enabled: false, provider: 'auto', maxResults: 5,
      credentialSource: 'channel', model: '', baseUrl: '', hasKey: false,
    });
    const searchKey = ref('');
    const searchChannelOpts = ref([]);
    const searchBusy = ref(false);
    const searchMsg = ref('');
    const searchTestQ = ref('');
    const searchResults = ref([]);
    const searchTested = ref(false);
    const searchRead = ref(null);

    const asrLocalText = computed(() => {
      const l = asrLocal.value;
      if (!l) return '读取中…';
      if (l.available) return '可用 · ' + (l.model || '（模型）') + (l.bytes ? ' · ' + mbOf(l.bytes) : '');
      return '不可用：' + (l.why || '缺少运行包');
    });
    const asrBrowserText = computed(() => {
      const b = asrBrowser.value;
      if (!b) return '读取中…';
      if (b.complete) return '已就绪 · ' + mbOf(b.bytes || 0);
      if (!b.files || !b.files.length) return '还没下载（选「只走浏览器内 Whisper」后首次转写时经代理下载，约 250–500MB）';
      return '缺 ' + b.missing.length + ' 个文件（已有 ' + mbOf(b.bytes || 0) + '）：再跑一次浏览器内识别会接着补齐';
    });
    const searchEngineName = computed(() => {
      provEpoch.value;
      const id = String(search.provider || '');
      if (id === 'tavily') return 'Tavily';
      if (!id || id === 'auto') {
        const kid = autoServiceKid('search');
        const m = lastAcctAll.find(x => x.keyId === kid);
        if (m) return '自动 · ' + m.name;
        /* 一家渠道都没有、但单独存了一把搜索密钥：服务端会退回 Tavily（它只认这一把）。 */
        return search.hasKey ? '自动 · Tavily' : '自动（还没有能用的搜索服务）';
      }
      const p = (REG.providers || []).find(x => x.id === id);
      return p ? p.name : id;
    });
    const searchCredText = computed(() => {
      if (search.provider === 'tavily') return search.hasKey ? '已单独存了一把 Tavily 密钥' : 'Tavily 要单独填一把搜索密钥';
      if ((!search.provider || search.provider === 'auto') && !autoServiceKid('search')) {
        return search.hasKey ? '自动 · 用单独那把 Tavily 密钥' : '还没有能用的搜索服务';
      }
      if (search.hasKey && search.credentialSource !== 'manual') {
        return '单独那把当前不用（渠道密钥生效）；切到「单独一把」才用它';
      }
      if (search.hasKey && search.credentialSource === 'manual') return '已单独存了一把搜索密钥（不会回显）';
      if (search.credentialSource === 'channel') return '用这家账号那把密钥：' + searchEngineName.value;
      return '还没填密钥';
    });
    /* 当前选中的搜索引擎是不是 chat 那一族（OpenRouter）：只有它需要「对话型号」这一格 */
    const searchNeedsModel = computed(() => {
      provEpoch.value;
      const id = String(search.provider || '');
      let p = null;
      if (id && id !== 'tavily' && id !== 'auto') p = (REG.providers || []).find(x => x.id === id) || null;
      else if (!id || id === 'auto') {
        const kid = autoServiceKid('search');
        p = kid ? (REG.providers || []).find(x => String(x.keyId || x.id) === kid) || null : null;
      }
      return !!(p && p.search && p.search.style === 'chat');
    });
    /* 识别这一档现在会落到谁：选了哪家就是哪家；选「自动」就是第一家声明了 asr 且接上的账号。
       型号框空着时，placeholder 用这家声明里的默认型号 —— 用户能看见「不发这一格会发什么」。 */
    const asrProvider = computed(() => {
      provEpoch.value;
      const id = String(asr.service.providerId || '');
      if (id) return (REG.providers || []).find(p => p.id === id || p.keyId === id) || null;
      /* 手填了接口地址 = 不用任何一家的声明（服务端也是这么判的），别在提示里点错名。 */
      if (String(asr.service.baseUrl || '').trim()) return null;
      const kid = autoServiceKid('asr');
      return kid ? (REG.providers || []).find(p => String(p.keyId || p.id) === kid) || null : null;
    });
    const asrModelPh = computed(() => (asrProvider.value && asrProvider.value.asr && asrProvider.value.asr.model) || 'whisper-1');
    /* 在线识别有没有落点：没有的话，本机识别卡里的「在线服务 / 自动」要说明先接一家云供应商。 */
    const asrOnlineReady = computed(() => {
      provEpoch.value;
      return !!hostKidOf('asr');
    });
    const asrProviderText = computed(() => {
      provEpoch.value;
      const p = asrProvider.value;
      if (!p) {
        if (String(asr.service.baseUrl || '').trim()) return '手填的接口地址（不走供应商声明）';
        const names = (REG.providers || []).filter(x => x.kind === 'text' && x.asr)
          .map(x => x.name).slice(0, 4).join(' / ');
        return names
          ? '这几家已经声明语音识别，但都还没配密钥：' + names
          : '还没有一家支持语音识别的供应商';
      }
      const name = p.name + (p.custom ? '（我的）' : '');
      return asr.service.providerId ? ('在线服务走「' + name + '」') : ('自动 · 在线服务走「' + name + '」');
    });

    /* 语音识别 / 联网搜索各自的「在线服务商」候选：只列注册表里**同时**声明了
       extraCaps 与端点声明（asr / search）的那几档 —— 与能力格、服务端转发读的是同一份声明。
       手加的那一档（只有语音识别可以手加）排在最后，名字后面写清「手动声明」。
       存着的那一家即便已经不在这份清单里，也照样列出来并写明原因 —— 藏掉它的话下拉会空着，
       而请求仍在用它；用户看不出该改哪儿。 */
    function serviceProvOpts(cap, curId) {
      const seen = new Set();
      const list = [];
      (REG.providers || []).forEach(p => {
        if (p.kind !== 'text') return;
        if ((p.extraCaps || []).indexOf(cap) < 0) return;
        if (!(cap === 'asr' ? p.asr : p.search)) return;
        const kid = String(p.keyId || p.id);
        if (seen.has(kid)) return;
        seen.add(kid);
        list.push({ id: p.id, name: p.name + (p.custom ? '（我的）' : '') });
      });
      if (cap === 'asr') {
        (REG.providers || []).filter(p => p.kind === 'text').forEach(p => {
          const kid = String(p.keyId || p.id);
          if (seen.has(kid) || manualCapsOf(kid).indexOf('asr') < 0) return;
          seen.add(kid);
          list.push({ id: p.id, name: p.name + '（手动声明）' });
        });
      }
      const cur = ['auto', 'tavily'].includes(String(curId || '')) ? '' : String(curId || '');
      if (cur && !list.some(x => x.id === cur)) {
        const p = (REG.providers || []).find(x => x.id === cur);
        list.unshift({ id: cur, name: (p ? p.name : cur) + '（没有注册这一档，改选一个）' });
      }
      return list;
    }
    function syncServiceProvs() {
      asrProvOpts.value = serviceProvOpts('asr', asr.service.providerId);
      searchChannelOpts.value = serviceProvOpts('search', search.provider);
      nextTick(() => {
        [asrProvEl.value, searchChannelEl.value].forEach(el => {
          if (el && window.Dropdowns) Dropdowns.sync(el);
        });
      });
    }

    /* 语音识别与联网搜索这两组的值不在 localStorage —— 它们要 POST 给代理，存 .data/asr.json
       与 .data/search.json。这两页改成自动保存之后，只有卡片里那颗「保存」会落盘，
       而页脚那句「✓ 已存本机」把没写出去的它们一起算了进去：改了渠道/型号不点保存，
       离开页面就丢。下面这一对签名只用来判断「这一组真的变了没有」，自动保存据此顺带把它们也存了。 */
    const asrSig = () => JSON.stringify([asr.route, asr.language, asr.service.providerId,
      asr.service.model, asr.service.baseUrl, String(asrKey.value || '').trim()]);
    const searchSig = () => JSON.stringify([search.enabled, search.provider, search.maxResults,
      search.credentialSource, search.model, search.baseUrl, String(searchKey.value || '').trim()]);
    let asrSavedSig = '';
    let searchSavedSig = '';
    /* 两组各自那一条在途 POST：手动按钮与页脚自动保存撞在一起时第二条等第一条（见 saveAsr / saveSearch）。 */
    let asrSaving = null;
    let searchSaving = null;

    async function loadAsr() {
      try {
        if (!window.Asr) await window.__spaLoadScript('web/domain/asr.js', () => window.Asr);
        const d = await window.Asr.settings();
        const s = d.settings || {};
        asr.route = s.route || 'auto';
        asr.language = s.language || '';
        asr.service.providerId = (s.service && s.service.providerId) || '';
        asr.service.model = (s.service && s.service.model) || '';
        asr.service.baseUrl = (s.service && s.service.baseUrl) || '';
        asr.service.hasKey = !!(s.service && s.service.hasKey);
        asrKey.value = '';
        asrLocal.value = d.local || null;
        asrMsg.value = '';
        asrSavedSig = asrSig();
      } catch (e) { asrMsg.value = '读不到语音识别设置：' + errText(e); }
      syncServiceProvs();
      /* 浏览器内模型的状态单独问（/models/status）：它不属于 asr.json，读不到也不影响上面那一组 */
      if (window.Asr && window.Asr.browserStatus) {
        window.Asr.browserStatus()
          .then(st => { asrBrowser.value = st; renderProv(); })
          .catch(() => { asrBrowser.value = null; renderProv(); });
      }
    }
    async function saveAsr() {
      /* 撞车只发一条：卡片那颗「保存」与页脚自动保存那一趟同一下撞上来时，第二条**等**第一条的结果。
         以前这里是 `if (asrBusy.value) return false` —— 手动那次明明写成功了，自动那一趟却拿到
         一个 false，回执成了「语音识别那一张卡没存进去」；同时 asrSavedSig 只在自动那一趟里推进，
         手动存完之后签名还停在旧值，下一次自动保存又把同一组值原样再 POST 一遍（多一个 .bak、
         多一次版本号）。签名现在在这一个函数里推进，两个入口共用同一份账。 */
      if (asrSaving) return asrSaving;
      if (!window.Asr) { asrMsg.value = '这一组还没加载起来：等它出来再存'; return false; }
      asrBusy.value = true; asrMsg.value = '保存中…';
      asrSaving = (async () => {
        try {
          const svc = {
            providerId: asr.service.providerId, model: asr.service.model, baseUrl: asr.service.baseUrl,
          };
          if (String(asrKey.value || '').trim()) svc.key = asrKey.value.trim();
          const d = await window.Asr.save({ route: asr.route, language: asr.language, service: svc });
          const s = d.settings || {};
          asr.service.hasKey = !!(s.service && s.service.hasKey);
          asrLocal.value = d.local || asrLocal.value;
          asrKey.value = '';
          asrSavedSig = asrSig();          // 密钥清空之后再取签名：那才是「已经落盘的那一组」的样子
          asrMsg.value = '✓ 已保存（密钥只留在代理那一边，不回显）';
          return true;
        } catch (e) { asrMsg.value = '✗ ' + errText(e); return false; }
        finally { asrBusy.value = false; asrSaving = null; }
      })();
      return asrSaving;
    }
    async function clearAsrKey(ev) {
      if (asrBusy.value || !window.Asr) return;
      /* 清掉之后只能重新填：走两下确认（Confirm.arm），点一下就删掉密钥的手感不能有 */
      if (window.Confirm && Confirm.arm(ev && ev.currentTarget, '确认清掉',
        { note: '清掉后只能重新填写；渠道与 .env 里的那把不受影响，会继续按它们走。' })) return;
      asrBusy.value = true;
      try {
        const d = await window.Asr.save({ clearKey: true });
        asr.service.hasKey = !!(d.settings && d.settings.service && d.settings.service.hasKey);
        asrMsg.value = '已清掉单独存的密钥；之后按渠道 / .env 走';
      } catch (e) { asrMsg.value = '✗ ' + errText(e); }
      finally { asrBusy.value = false; }
    }
    let asrTestCtl = null;
    let asrTestJob = '';
    /* 「测试识别」在浏览器内路线下可能是几分钟（首次还要经代理下几百 MB 模型）：
       识别中再点同一颗就是不等了 —— 掐掉 worker，代理那已建出的任务补一次取消。 */
    async function cancelAsrTest() {
      const id = asrTestJob;
      asrTestJob = '';
      try { if (asrTestCtl) asrTestCtl.abort(); } catch (e) { /* 已经在收尾 */ }
      if (id) { try { await window.Asr.cancel(id); } catch (e) { /* 跑完了 / 取消不掉：状态由那一单自己报 */ } }
      asrMsg.value = '已取消识别';
    }
    async function testAsr() {
      if (asrBusy.value) { await cancelAsrTest(); return; }
      if (!window.Asr) return;
      let got = [];
      try {
        got = await window.AssetPicker.open({ types: ['音频'], multiple: false, limit: 1, title: '选一段短音频试识别' });
      } catch (e) { Toast.err('打不开素材选择：' + errText(e)); return; }
      if (!got || !got.length) return;
      const it = got[0];
      const aid = String(it.assetId || it.id || '');
      const src = it.src || Api.assetSrc(aid);
      if (!src) { Toast.err('这条资产没有可读地址'); return; }
      asrBusy.value = true; asrTestText.value = ''; asrMsg.value = '已提交，识别中…';
      const ctl = new AbortController();
      asrTestCtl = ctl;
      try {
        const r = await window.Asr.transcribe({
          src, route: asr.route, signal: ctl.signal,
          onStage: s => { if (!ctl.signal.aborted) asrMsg.value = window.Asr.stageText(s); },
        });
        asrTestJob = r.jobId || '';
        const j = await window.Asr.wait(r.jobId, t => {
          if (!ctl.signal.aborted) asrMsg.value = '识别中… ' + Math.round((t.progress || 0) * 100) + '%';
        }, { signal: ctl.signal });
        if (j.state === 'done') {
          const segs = j.segments || [];
          asrMsg.value = '✓ 识别完成（' + segs.length + ' 段）';
          asrTestText.value = segs.slice(0, 6).map(s => s.text).join('\n');
        } else {
          asrMsg.value = '✗ ' + (j.error || j.state);
        }
      } catch (e) { asrMsg.value = ctl.signal.aborted ? '已取消识别' : '✗ ' + errText(e); }
      finally { asrBusy.value = false; asrTestCtl = null; asrTestJob = ''; }
    }

    async function loadSearch() {
      try {
        if (!window.Search) await window.__spaLoadScript('web/domain/search.js', () => window.Search);
        const d = await window.Search.settings();
        const s = d.settings || {};
        search.enabled = !!s.enabled;
        search.provider = s.provider || 'auto';
        search.maxResults = Number(s.maxResults) || 5;
        search.credentialSource = s.credentialSource || 'channel';
        search.model = s.model || '';
        search.baseUrl = s.baseUrl || '';
        search.hasKey = !!s.hasKey;
        searchKey.value = '';
        searchMsg.value = '';
        searchSavedSig = searchSig();
        syncServiceProvs();
      } catch (e) { searchMsg.value = '读不到联网搜索设置：' + errText(e); }
    }
    async function saveSearch() {
      /* 与 saveAsr 同一shape：撞车只发一条，签名在这一个函数里推进（理由见那里的注释）。 */
      if (searchSaving) return searchSaving;
      if (!window.Search) { searchMsg.value = '这一组还没加载起来：等它出来再存'; return false; }
      searchBusy.value = true; searchMsg.value = '保存中…';
      searchSaving = (async () => {
        try {
          const p = {
            enabled: search.enabled, provider: search.provider, maxResults: search.maxResults,
            credentialSource: search.credentialSource,
            model: search.model, baseUrl: search.baseUrl,
          };
          if (String(searchKey.value || '').trim()) p.key = searchKey.value.trim();
          const d = await window.Search.save(p);
          search.hasKey = !!(d.settings && d.settings.hasKey);
          searchKey.value = '';
          searchSavedSig = searchSig();            // 同样：清掉密钥输入之后再取签名
          searchMsg.value = '✓ 已保存（密钥只留在代理那一边，不回显）';
          return true;
        } catch (e) { searchMsg.value = '✗ ' + errText(e); return false; }
        finally { searchBusy.value = false; searchSaving = null; }
      })();
      return searchSaving;
    }
    /* 换在线服务商 = 型号回到这一家的默认值（placeholder 里写着）；
       表单本身也搬到新那家的账号卡里（能力在哪家、设置就在哪家）。 */
    function onAsrProvChange() {
      asr.service.model = '';
      asr.route = 'service';
      renderProv();
    }
    /* 语音识别路线（本机识别那张卡里）：换路线会改变「谁顶着这一档」，重画一次状态牌。 */
    function onAsrRouteChange() {
      renderProv();
    }
    function onSearchProvChange() {
      renderProv();
    }
    /* 在「用这家账号的密钥」那一档往框里打字，就是要单独用这一把 ——
       不暗示这一下，「填了却不生效」会看起来像坏了。 */
    function onSearchKeyInput() {
      if (String(searchKey.value || '').trim() && search.provider !== 'tavily') search.credentialSource = 'manual';
    }
    async function clearSearchKey(ev) {
      if (searchBusy.value || !window.Search) return;
      if (window.Confirm && Confirm.arm(ev && ev.currentTarget, '确认清掉',
        { note: '清掉后只能重新填写；渠道与 .env 里的那把不受影响，会继续按它们走。' })) return;
      searchBusy.value = true;
      try {
        const d = await window.Search.save({ clearKey: true });
        search.hasKey = !!(d.settings && d.settings.hasKey);
        searchMsg.value = '已清掉单独存的搜索密钥';
      } catch (e) { searchMsg.value = '✗ ' + errText(e); }
      finally { searchBusy.value = false; }
    }
    async function testSearch() {
      if (searchBusy.value || !window.Search) return;
      const qv = String(searchTestQ.value || '').trim();
      if (!qv) { Toast.err('先填一个搜索词'); return; }
      searchBusy.value = true; searchMsg.value = '搜索中…'; searchResults.value = []; searchRead.value = null;
      try {
        const r = await window.Search.search({ query: qv, limit: search.maxResults });
        searchResults.value = (r.results || []).filter(x => /^https?:\/\//i.test(String(x.url || '')));
        searchTested.value = true;
        searchMsg.value = searchResults.value.length
          ? '✓ ' + searchResults.value.length + ' 条' + (r.cached ? '（10 分钟缓存）' : '') + ' · ' + (r.provider || '')
          : '上游没有返回结果';
      } catch (e) {
        searchTested.value = true;
        searchMsg.value = '✗ ' + errText(e);
      } finally { searchBusy.value = false; }
    }
    async function readFirstSearch() {
      if (!window.Search || !searchResults.value.length) return;
      searchMsg.value = '读网页中…';
      try {
        const p = await window.Search.read(searchResults.value[0].url);
        searchRead.value = p;
        searchMsg.value = '✓ 已读正文' + (p.truncated ? '（超过 4 万字，已截断）' : '');
      } catch (e) { searchMsg.value = '✗ ' + errText(e); }
    }

    /* ---------- 左：目录轨（索引） + 右：那条连续的文档 ----------
       这一页有两栏：左边是目录（5 组 15 行，每行带它的**当前值**），
       右边是 15 张卡排成的一条文档（组标题钉在顶上，状态行钉在底下）。
       目录、组名、栏目标题全部**从 DOM 现读**（下面这几个函数），JS 里没有第二份清单；
       值速记也是现读同一份真相压成一行短字（NAV_VALUE 一族），不另存一份状态 ——
       否则轨上那个数与卡里画着的那一项就会各说各话。 */
    let navQueued = 0;
    let navRO = null;
    let navMO = null;
    let navScrollQueued = 0;
    let flashTimer = null;
    let settleTimer = 0;
    let curNavId = '';           /* 现在停在文档里的哪一栏（轨上亮的那一行） */
    let scrollHolding = false;
    /* 这一轮每张卡里命中的行（syncNav 现算一次，卡标题那枚「N 处命中」与轨上那枚数都读它）。 */
    const cardHits = new Map();
    /* 组名读 DOM 里那一行标题；折叠那一组的标题在按钮里（后面还跟着「展开」两个字，只取 .fold-title）。 */
    const groupNameOf = sec => {
      const h = sec && sec.querySelector ? sec.querySelector('.set-group-h') : null;
      const t = h ? ((h.querySelector('.fold-title') || h).textContent || '') : '';
      return t.trim() || (sec && sec.dataset ? sec.dataset.group : '') || '';
    };
    const groupEls = () => (rootEl.value ? [...rootEl.value.querySelectorAll('.set-group[data-group]')] : []);
    /* 卡 = 组下面那一层的 .card（折叠那一组的卡在 .fold-body 里）；hidden 的卡（自定义那张还没展开）不算一栏。 */
    function cardsOf(sec) {
      if (!sec) return [];
      return [...sec.querySelectorAll(':scope > .card, :scope > .fold-body > .card')].filter(c => c && !c.hidden);
    }
    function navCards() { return groupEls().flatMap(cardsOf); }
    /* 目录轨上的行 = **每一张卡**（一张卡一行）。
       语音识别 / 联网搜索各有自己的一张卡（通道设置不属于任何一家供应商），
       所以它们与别的卡一样各占一行；供应商卡里只留能力行，不再把这两张表单塞进账号卡。 */
    function navRows() { return navCards().filter(c => c.dataset && c.dataset.nav); }
    /* 卡标题里只认文字：命中数那枚 .set-hcnt 是自己塞进去的，读数前先摘掉。 */
    function navTitleOf(c) {
      const h = c.querySelector('h2');
      if (!h) return '（这一栏没有标题）';
      const clone = h.cloneNode(true);
      clone.querySelectorAll('.set-hcnt').forEach(x => x.remove());
      return clone.textContent.trim() || '（这一栏没有标题）';
    }
    /* 组说明写在 <section data-note="…"> 里 —— 目录轨上那一组管什么，现读，不抄第二份。 */
    const groupNoteOf = sec => (sec && sec.dataset ? (sec.dataset.note || '') : '');

    /* ---------- 值速记：目录轨上每一行右边那一小段「现在是什么」 ----------
       取值全部现读 —— 与那一栏里画着的是同一份真相（UI_PREFS / PAGE_TARGETS /
       Net.NUMS / SET_ROWS / 注册表 / asr / search / 体检与用量 / 归档清单）。
       这里只把同一份真相压成一行短字，不另存一份状态。 */
    function uiPrefLabel(key) {
      const rows = (window.UI_PREFS && window.UI_PREFS.rows) || [];
      const r = rows.find(x => x.key === key);
      if (!r) return '';
      if (r.kind === 'bool') return (window.UI_PREFS.isOn && UI_PREFS.isOn(key)) ? '开' : '关';
      const cur = window.LS.get(key);
      const v = cur == null ? r.def : cur;
      const o = (r.opts || []).find(x => x[0] === v);
      return o ? o[1] : '';
    }
    const NAV_VALUE = {
      /* 账号卡流：接进来几家（用得上 = 有密钥 / 自定义 / .env 配了），再给出各档各几家 ——
         轨道那一行只有一小格，给「N 家」与最常看的两档就够，别的进卡里看。 */
      providers: () => {
        /* 这一行是「供应商与密钥」：本机识别那一张没有密钥，不混进这个数。 */
        const on = provGroups().filter(m => provUsable(m) && !m.local);
        if (!on.length) return '还没接';
        const by = cap => on.filter(m => m.caps.indexOf(cap) >= 0).length;
        return on.length + ' 家 · 图 ' + by('image') + ' / 视 ' + by('video');
      },
      /* 语音识别 / 联网搜索各有自己的一张卡，所以轨上也各占一行、各给一句当前值。 */
      asr: () => {
        const route = asr.route || 'auto';
        const zh = ['local', 'browser', 'service'].includes(route)
          ? (window.Asr && Asr.routeLabel ? Asr.routeLabel(route).replace(/（.*$/, '') : route)
          : '自动';
        const p = asrProvider.value;
        return zh + (p && route !== 'browser' && route !== 'local' ? (' · ' + p.name) : '');
      },
      search: () => (search.enabled
        ? (searchEngineName.value + ' · ' + search.maxResults + ' 条')
        : '已关'),
      appearance: () => {
        /* 缺省配色（海洋）在轨上不占字；换了配色才把那一段加在最前（「莓果 · 浅色 · 列表」）。 */
        const pal = uiPrefLabel('dir_palette');
        return (pal && pal !== '海洋' ? pal + ' · ' : '')
          + (uiPrefLabel('dir_theme') || '浅色') + ' · ' + (uiPrefLabel('dir_asset_view') || '列表');
      },
      paging: () => '每页 ' + (window.pageSizeOf ? window.pageSizeOf('studio') : 24) + ' 条',
      network: () => net.timeout + ' 秒 · 重试 ' + net.retry + ' 次',
      storage: () => ((window.UI_PREFS && UI_PREFS.isOn('sk_media_local')) ? '自动存本机' : '只留外链'),
      chars: () => {
        /* 「素材库」那张卡现在管的是**默认**：出图张数、语音条数与两个默认型号。 */
        if (!window.Chars || !Chars.setting) return '';
        const n = Chars.setting('candN');
        const v = Chars.setting('voiceN');
        const pinned = ['imgModel', 'ttsModel'].filter(k => Chars.setting(k)).length;
        return (n ? (n + ' 张') : '') + (v ? (' · ' + v + ' 条') : '') + (pinned ? (' · 指定 ' + pinned + ' 个型号') : ' · 型号自动');
      },
      assistant: () => (window.LS.get('ai_chat_off') === '1' ? '已关' : '已开'),
      polish: () => ({ ai: '交给 AI 判断', on: '强制先问', off: '从不问' })[window.LS.get('sk_polish_ask') || 'ai'],
      skill: () => {
        const n = (skillItems.value || []).filter(x => x.enabled).length;
        return n ? (n + ' 份已启用') : '一份都没启用';
      },
      sync: () => (dataCount.value ? (dataCount.value + ' 份数据') : '本机 → 数据文件'),
      prompts: () => (promptCount.value ? (promptCount.value + ' 份') : '还没有归档'),
      backup: () => '整份设置',
      env: () => {
        if (!lastSys) return '读取中…';
        const h = (window.Api && Api.sysHealth) ? Api.sysHealth(lastSys.健康) : null;
        return (h && h.chip) || '已读';
      },
      disk: () => (lastUsage ? (lastUsage.芯片 || '0 KB') : '数盘中…'),
      cache: () => (cacheBytes.value ? mbOf(cacheBytes.value) : '—'),
    };
    function navValueOf(id) {
      const f = NAV_VALUE[id];
      if (!f) return '';
      try { return f() || ''; } catch (e) { return ''; }
    }

    /* ---------- 目录轨：画那棵树 ----------
       一行 = 名字 + 引点 + 值速记。引点是排版手法（说明「这一项有一个值，值在右边」），
       值速记把 15 个旋钮的当前值压成一列 —— 眼睛从上往下扫一遍就知道这台机器什么状态。 */
    function paintRail() {
      const box = setRailEl.value;
      if (!box) return;
      const filtering = !!(setQ.value || '').trim();
      let html = '';
      groupEls().forEach(sec => {
        const rows = cardsOf(sec).filter(c => c.dataset && c.dataset.nav);
        if (!rows.length) return;
        html += '<div class="set-rail-g"><span class="t">' + window.esc(groupNameOf(sec)) + '</span>'
          + '<span class="n">' + rows.length + '</span></div>';
        const note = groupNoteOf(sec);
        if (note) html += '<div class="set-rail-note">' + window.esc(note) + '</div>';
        rows.forEach(c => {
          const id = c.dataset.nav;
          const hits = cardHits.get(c) || [];
          const on = id === curNavId;
          const icEl = c.querySelector('.card-h .card-ic');
          const ico = (icEl && icEl.innerHTML) || window.icon('folder', 16);
          html += '<a class="set-rail-i' + (on ? ' on' : '') + (filtering && !hits.length ? ' dim' : '')
            + '" href="#" data-nav="' + window.esc(id) + '" title="' + window.esc(navTitleOf(c)) + '">'
            + '<span class="set-rail-ic">' + ico + '</span>'
            + '<span class="set-rail-n">' + window.esc(navTitleOf(c)) + '</span>'
            + '<span class="set-rail-lead"></span>'
            + '<span class="set-rail-v">' + window.esc(navValueOf(id)) + '</span></a>';
        });
      });
      box.innerHTML = html;
      /* 点哪一行 → 右栏平滑滚到那一张卡（走本页唯一的滚动出口 scrollToEl）。
         筛选期间点的是没命中的那一行 → 先把筛选撤了再滚过去（否则滚过去看不见）。
         这一栏在收着的组里（本机维护默认收着）→ 先展开再滚过去；
         展开这一下**不写盘**（openFold 走的是程序化展开，见 initFolds）。 */
      box.querySelectorAll('.set-rail-i').forEach(el => {
        el.onclick = e => {
          e.preventDefault();
          const id = el.getAttribute('data-nav') || '';
          if (el.classList.contains('dim')) { setQ.value = ''; syncNav(); }
          const doc = setDocEl.value;
          const card = doc ? doc.querySelector('.card[data-nav="' + id + '"]') : null;
          setCurNav(id);
          if (!card) return;
          const sec = card.closest('.set-group');
          if (sec) openFold(sec);
          requestAnimationFrame(() => scrollToEl(card));
        };
      });
    }
    /* 滚动时只换高亮，不重画整棵树（重画会把滚动位置与展开状态弄丢）。 */
    function markCurRail(id) {
      const box = setRailEl.value;
      if (!box) return;
      box.querySelectorAll('.set-rail-i').forEach(el => {
        el.classList.toggle('on', el.getAttribute('data-nav') === id);
      });
      /* 窄屏目录轨是横向条：当前项要跟着滚到能看见的位置。
         只动 scrollLeft，不调 scrollIntoView —— 这一页的滚动出口仍然只有 scrollToEl。 */
      const cur = box.querySelector('.set-rail-i.on');
      if (cur && box.scrollWidth > box.clientWidth + 2) {
        const br = box.getBoundingClientRect(), cr = cur.getBoundingClientRect();
        box.scrollLeft += (cr.left - br.left) - (box.clientWidth - cr.width) / 2;
      }
    }
    /* 底部那一行：现在在第几项（在一条 8000px 的文档里，「我在哪」得一直看得见）。 */
    function updatePos() {
      const rows = navRows();
      const i = rows.findIndex(c => (c.dataset.nav || '') === curNavId);
      navPos.value = i < 0 ? '' : ('第 ' + (i + 1) + ' / ' + rows.length + ' 项 · ' + navTitleOf(rows[i]));
    }
    function setCurNav(id) {
      if (id === curNavId) return;
      curNavId = id;
      markCurRail(id);
      updatePos();
    }

    /* 这一页**唯一**的滚动出口（目录轨跳转、搜索命中、打开自定义供应商卡都走它）：
       右边那条文档自己滚（.set-doc-scroll），卡顶要停在**钉住的组标题**下面，
       靠的是 CSS 里那条 scroll-margin-top = --setanchor（组标题多高就让多少）。
       命中行（.krow / .sub …）根本不带那条 margin —— 按旧高度算出来的位置就差那一截。
       所以先重测高度再滚，并在滚动落定后补一次校正：
       折叠里那几栏的行是异步补出来的（体检 / 用量 / 清单行），高度会在滚动途中变。
       跳转途中 scrollHolding 挂起滚动跟随（onScrollNav），落定才交还 —— 不然平滑滚动路过
       上一组时，事件会把点完的那一行改回去，一闪再闪。
       ⚠ 别再在这一页写第二处裸 `scrollIntoView`：那一种滚法不给钉住的组标题让位，也不会补校正。 */
    function anchorH() {
      const doc = setDocEl.value;
      if (!doc) return 44;
      const hs = doc.querySelectorAll('.set-group-h');
      let h = 0;
      hs.forEach(x => { const r = x.getBoundingClientRect(); if (r.height > h) h = r.height; });
      return Math.round(h) + 14;
    }
    function setDocAnchor() {
      const doc = setDocEl.value;
      if (!doc) return;
      doc.style.setProperty('--setanchor', anchorH() + 'px');
    }
    function scrollToEl(el, block) {
      const doc = setDocEl.value;
      if (!doc || !el) return;
      scrollHolding = true;
      setDocAnchor();
      el.scrollIntoView({ block: block || 'start', behavior: 'smooth' });
      let tries = 0;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(settleJump, 520);
      function settleJump() {
        settleTimer = 0;
        if (!setDocEl.value || !el.isConnected) { scrollHolding = false; navFollow(); return; }
        setDocAnchor();
        const r = el.getBoundingClientRect(), rr = doc.getBoundingClientRect();
        const want = block === 'center' ? Math.round(rr.height / 2) : anchorH();
        if (Math.abs((r.top - rr.top) - want) > 10) {
          /* 补校正也是平滑滚，落定再验一遍；最多补三回，用户中途抢滚就不拉扯了。 */
          if (++tries > 3) { scrollHolding = false; navFollow(); return; }
          doc.scrollTo({ top: doc.scrollTop + (r.top - rr.top) - want, behavior: 'smooth' });
          settleTimer = setTimeout(settleJump, 520);
          return;
        }
        scrollHolding = false;
        navFollow();
      }
    }
    /* 折叠那一段（本机维护那一组）：命中落在里面时得先展开，否则「命中 3 处」点在收着的组里看不见。
       只借这一页已有的 fold-key 机制，展开这一动作**不写盘**（下次打开照旧是收着的）。 */
    function openFold(sec) {
      if (!sec || !sec.classList.contains('foldable')) return;
      if (sec._foldSet) sec._foldSet(true); else sec.classList.add('open');
    }
    /* 搜的是这一行里看得见的字（标题、说明、标签、提示），不含输入框里用户自己敲的内容。 */
    const hayOf = c => ((c.textContent || '') + ' '
      + [...c.querySelectorAll('input,textarea,select,button')].map(x => x.placeholder || x.title || '').join(' ')).toLowerCase();
    /* 命中落到**行**上。一行 = 一个 krow / 一张账号卡 / 一段说明 …
       大盒里套小盒的（账号卡里面有 krow 与型号行）只标最里面那一条，免得两层底色叠在一起。
       几个词凑不齐在同一行时退回「含任一个词的行」—— 搜「密钥 同步」这种，别一个命中都不给。 */
    const ROW_SEL = '.krow, .sub, .pb-tip, .acct, .crow, .capadd, .polish-block, .cloud-box, .cloud-row, .sk-item,'
      + ' .ui-note, .cus-acts, .search-hit, .ref, .sk-hint, .mlist-row, .preset';
    function rowHits(card, terms) {
      if (!terms.length) return [];
      const cand = [...card.querySelectorAll(ROW_SEL)];
      const hay = cand.map(hayOf);
      const filterRows = mode => cand.filter((r, i) => (mode === 'all'
        ? terms.every(t => hay[i].indexOf(t) >= 0)
        : terms.some(t => hay[i].indexOf(t) >= 0)));
      const hits = filterRows('all');
      const list = hits.length ? hits : filterRows('any');
      return list.filter(r => !list.some(o => o !== r && r.contains(o)));
    }
    /* 卡标题后面那一枚「N 处命中」：没有命中就整枚摘掉，读数时才不会被它带进去（见 navTitleOf）。 */
    function paintCardMark(c, n) {
      const h = c.querySelector('h2');
      if (!h) return;
      const b = h.querySelector(':scope > .set-hcnt');
      if (!n) { if (b) b.remove(); return; }
      if (b) b.textContent = n + ' 处命中';
      else {
        const el = document.createElement('span');
        el.className = 'set-hcnt';
        el.textContent = n + ' 处命中';
        h.appendChild(el);
      }
    }
    function syncNav() {
      const secs = groupEls();
      const terms = (setQ.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      const filtering = !!terms.length;
      qa('.set-hit').forEach(el => el.classList.remove('set-hit'));
      const groupHits = {};
      let hitCards = 0, hitRows = 0;
      secs.forEach(sec => {
        let gRows = 0;
        cardsOf(sec).forEach(c => {
          const hits = rowHits(c, terms);
          cardHits.set(c, hits);
          c.classList.toggle('set-off', filtering && !hits.length);
          paintCardMark(c, hits.length);
          hits.forEach(r => r.classList.add('set-hit'));
          gRows += hits.length;
          if (!filtering || hits.length) hitCards++;
        });
        groupHits[sec.dataset.group] = gRows;
        /* 整组都没有命中的，连组标题一起收起来（不然筛选完只剩几栏还挂着五个组名）。 */
        sec.classList.toggle('set-off', filtering && !gRows);
        if (gRows) openFold(sec);
        hitRows += gRows;
      });
      navHasFilter.value = filtering;
      navSumErr.value = filtering && !hitRows;
      const total = navRows().length;
      navSumShort.value = !filtering
        ? (secs.length + ' 组 · ' + total + ' 项')
        : ('「' + terms.join(' ') + '」命中 ' + hitRows + ' 行 · ' + hitCards + ' / ' + total + ' 项');
      navSum.value = !filtering
        ? ('左边点一项，右边滚到那一处 —— 滚过去哪一项，那一项就亮着。也可以直接输入关键词，命中落到行。')
        : ('「' + terms.join(' ') + '」命中 ' + hitRows + ' 行（在 ' + hitCards + ' / ' + total + ' 项里）'
          + (hitRows ? '，按回车跳到第一处' : ' —— 这一页没有含这些词的行。换个说法试试（密钥 / 地址 / 目录 / 分页 / 润色 / 备份 / 缓存）'));
      paintRail();
      navFollow();
    }
    function clearNav() {
      setQ.value = '';
      syncNav();
      if (setQEl.value) window.focusQuiet(setQEl.value);
    }
    /* 回车滚到第一处**画得出来的**命中，再短暂亮一下（底色本来就在，闪的是「就是这一行」）。
       命中落在收着的那一组里时屏幕上没有：计数照实算，跳转只滚到画得出来的第一处 ——
       一处都画不出来就说明白是「收着的那一组」，不假装跳过去了。 */
    function gotoFirstHit() {
      const all = qa('.set-hit');
      const first = all.filter(painted)[0];
      if (!first) {
        if (all.length) Toast.warn('这一轮命中的 ' + all.length + ' 行在收起的那一组里 —— 先展开那一组再按回车');
        else if ((setQ.value || '').trim()) Toast.warn('这一轮没有命中行，改一两个字再试');
        return;
      }
      scrollToEl(first, 'center');
      qa('.set-flash').forEach(el => el.classList.remove('set-flash'));
      first.classList.add('set-flash');
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        qa('.set-flash').forEach(el => el.classList.remove('set-flash'));
        flashTimer = null;
      }, 1400);
    }
    function onNavKey(e) {
      if (e.key === 'Escape') { setQ.value = ''; syncNav(); return; }
      if (e.key === 'Enter') { e.preventDefault(); gotoFirstHit(); }
    }
    /* 画不出来的行（hidden 的那一块）不算命中点 —— 按回车跳到那样一行时落点被夹回页面顶，
       用户看见的是「什么都没发生」。口径：计数照实算，跳转只滚到**画得出来的第一处**。 */
    const painted = el => !!el && el.offsetParent !== null;
    /* 滚到哪儿，目录轨就亮哪一项：拿视口上三分之一那条线当锚点 ——
       锚点落在哪张卡里就亮哪张；正好在两张卡之间（组标题那一段）就亮刚过去的那张。
       滚到底了：最后一张卡算当前（否则最后一栏永远亮不到）。 */
    function activeCard() {
      const doc = setDocEl.value;
      if (!doc) return null;
      const rows = navCards().filter(c => c.dataset && c.dataset.nav);
      if (!rows.length) return null;
      const dr = doc.getBoundingClientRect();
      const line = dr.top + Math.min(180, Math.round(doc.clientHeight * 0.32));
      let best = null;
      for (const c of rows) {
        const r = c.getBoundingClientRect();
        if (r.top <= line) best = c; else break;
      }
      if (doc.scrollTop + doc.clientHeight >= doc.scrollHeight - 6) best = rows[rows.length - 1];
      return best;
    }
    /* 按当前滚动位置改判一次（滚动事件与程序化跳转落定共用这一份）。
       ⚠ 跳转途中（scrollHolding）不许改判 —— 平滑滚动路过的那几栏会把刚点的那一行改回去，
       一闪再闪。落定之后 settleJump 交还 scrollHolding 再判一次，那一次才是真的。 */
    function navFollow() {
      if (scrollHolding) return;
      const c = activeCard();
      if (!c) return;
      setCurNav(c.dataset.nav || '');
    }
    function onScrollNav() {
      if (navScrollQueued || scrollHolding) return;
      navScrollQueued = requestAnimationFrame(() => {
        navScrollQueued = 0;
        navFollow();
      });
    }
    function setupNav() {
      setDocAnchor();
      const doc = setDocEl.value;
      if (doc) {
        doc.addEventListener('scroll', onScrollNav, { passive: true });
        /* 组标题那几行的高度会随窗口宽度变（说明那一行折行）—— 停靠位跟着它挪。 */
        if (window.ResizeObserver) {
          navRO = new ResizeObserver(() => { setDocAnchor(); });
          doc.querySelectorAll('.set-group-h').forEach(h => {
            try { navRO.observe(h); } catch (e) { /* 观察不了就罢了：停靠位退回初始值 44px */ }
          });
        }
      }
      window.addEventListener('resize', setDocAnchor);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(setDocAnchor).catch(() => {});
      /* 两类变化都要跟着重算：① 某一栏被页面自己临时打开 / 收起（hidden 一变，目录就该变）；
         ② 栏里的行是异步补出来的（体检、用量、供应商卡、清单行）—— 命中数、值速记与底色得跟上。
         自己刚写进去的那几处（目录轨、卡标题上那枚命中数）不算「页面变了」，否则就是自己勾自己。 */
      try {
        const main = rootEl.value;
        navMO = new MutationObserver(ms => {
          if (!ms.some(x => {
            const t = x.target;
            return !!t && t.nodeType === 1 && !(t.closest && (t.closest('.set-rail') || t.closest('.set-hcnt')));
          })) return;
          clearTimeout(navQueued);
          navQueued = setTimeout(syncNav, 120);
        });
        navMO.observe(main, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
      } catch (e) {}
      syncNav();
    }

    /* ---------- 挂载 ---------- */
    onMounted(async () => {
      await nextTick();
      if (!rootEl.value) return;
      /* 模板里那些静态 `<span data-icon>`：ui.js 的 fillIcons 只在外壳 DOMContentLoaded 跑过一次，
         那时本页还没挂载 —— 不在这里补一遍，导出/导入那几颗按钮上的图标是空的。 */
      if (rootEl.value) window.fillIcons(rootEl.value);
      rootEl.value.addEventListener('change', onRootChange);
      /* 关标签那一道闸只在外壳 beforeunload 里问一次（读 __spaDirty）；
         这里再挂一个 beforeunload 会让 Chrome 弹两遍，而且两层读的是同一份状态。
         以前这里同时挂 `__skFlush` / `__skDirty` / `__skLeaving` 三份同义钩子（iframe 时代外壳读那三个，
         迁移后外壳只读 `__spaFlush` / `__spaDirty`）—— 那三个已经没有任何地方读，
         留着就是「改了一处、另一处还指着旧语义」的现场。 */
      window.__spaFlush = () => flushPending();
      window.__spaDirty = () => (!skLeaving && (savePending || saveFailed))
        ? '刚才那一项改动还没落到本机（正在自动保存，或上一次没存进去）：现在离开这一页，那几项可能还是旧的。' : '';
      try { if (window.__spaRegister) window.__spaRegister(window.__spaFlush, window.__spaDirty); } catch (e) {}
      paintSaveState();
      /* 「这里缺脚本」要说明白，而不是整页空白。 */
      try {
        /* 两份互不依赖，一起取 */
        await Promise.all([
          window.__spaLoadScript('web/ui/workbench.js', () => window.Wb),
          window.__spaLoadScript('web/domain/chars.js', () => window.Chars),
        ]);
      } catch (e) {
        console.warn('[settings] 公共模块没就绪：', e && e.message);
      }
      if (!window.Api || !window.AssetLib || !window.Store || !window.DataSync
        || !window.TextAI || !window.Net || !window.Toast || !window.Confirm) {
        failed.value = '公共模块没有就绪（ui.js / assetlib.js）';
        if (window.PageReport) PageReport.pageFail('设置', failed.value);
        return;
      }
      if (window.Dropdowns) Dropdowns.build(rootEl.value);
      initNet();
      /* SET_ROWS 声明的那几行（网络 / 产物档位 / 左栏两块 / 助手四颗 / 润色反问）在这里现画，
         再把这一页已有的折叠绑上（本机维护那一组默认收着 —— 键没存过就是收起，见 initFolds）。 */
      renderManifestRows();
      initFolds(rootEl.value);
      initCloud();
      renderPageSettings();
      renderUiPrefs();
      /* 主题解析发生在 shell-boot / 侧栏按钮里；每次解析完成都把两排分段的高亮对回来。 */
      document.addEventListener('sb:theme-applied', syncThemePrefs);
      initPromptArchive();
      initTextForm();
      paintSkillChips();
      reloadSkills();
      if (usageGoSlotEl.value && window.GoPage) {
        usageGoSlotEl.value.innerHTML = GoPage.btn('assets.html', '去资产库删');
        GoPage.bind(usageGoSlotEl.value);
      }
      refreshDataInfo();
      refreshPersistInfo();
      refreshSys(false);
      refreshUsage();
      renderHistRows();
      paintCacheUsage();
      refreshCloudPanel();
      setupNav();
      try { if (window.TextAI) await TextAI.warm(await Api.registry()); } catch (e) {}
      await loadReg();
      /* 「素材库」那张卡里有两行**型号下拉**：型号清单来自注册表，
         所以这一张卡必须等 loadReg() 之后才画（早画就是一个空下拉）。 */
      renderCharsSet();
      loadAsr();
      loadSearch();
      ready.value = true;
      syncNav();
    });
    onBeforeUnmount(() => {
      if (rootEl.value) rootEl.value.removeEventListener('change', onRootChange);
      document.removeEventListener('sb:theme-applied', syncThemePrefs);
      if (setDocEl.value) setDocEl.value.removeEventListener('scroll', onScrollNav);
      window.removeEventListener('resize', setDocAnchor);
      if (navRO) { try { navRO.disconnect(); } catch (e) {} navRO = null; }
      if (navMO) { try { navMO.disconnect(); } catch (e) {} navMO = null; }
      clearTimeout(navQueued);
      if (navScrollQueued) cancelAnimationFrame(navScrollQueued);
      if (flashTimer) clearTimeout(flashTimer);
      if (saveTimer) clearTimeout(saveTimer);
      if (saveOkTimer) clearTimeout(saveOkTimer);
      if (storeStatsOff) { try { storeStatsOff(); } catch (e) {} storeStatsOff = null; }
      /* 组件撤掉之后这些钩子不能再指向已经不在的页面。 */
      try { window.__spaFlush = null; window.__spaDirty = null; } catch (e) {}
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      rootEl, failed,
      setRailEl, setDocEl, setQEl, setQ, syncNav, onNavKey, navHasFilter, clearNav, navSum, navSumErr,
      navSumShort, navPos,
      saveText, saveKind,
      acctToolsEl, provListEl, provErrEl, acctParkEl,
      asrFormEl, asrLocalFormEl, searchFormEl,
      cusCardEl, cusShown, cusMineShown, cusMineGroups, cusEditing, editCus, removeCus,
      cusCapEl, cusNamePh,
      cusShapeEl, cusShapeSel, cusShapeOpts, cusShapeShown, onCusShapeChange,
      cusNameEl, cusName, cusBaseEl, cusBase, cusKeyEl, cusKey, cusKeyShown,
      cusExtraEl, cusExtra, rebuildCusModels, cusModelRows, cusOff, onCusModelToggle, cusModelsEmpty,
      cusFetchBusy, fetchCusModels, addCus, cusAddText, cusCancelShown, cancelCus, cusCount, cusMsg, cusMsgCls,
      pageBoxEl, uiPrefsBoxEl, storePrefsBoxEl, charsBoxEl,
      netBoxEl, storeRowsEl, assistantBoxEl, polishBoxEl,
      dataInfo, dataInfoTitle, dataMsg, persistInfo, persistGranted, dataBusy,
      copyDataDir, reloadDataInfo, askPersist, pushData, pullData, exportAll, pickImportAll, onImportAllFile,
      impAllFileEl,
      cloudUrl, cloudUser, cloudPass, cloudKeys, cloudPrompts, saveCloud, cloudMsg, cloudState,
      cloudBusy, cloudCall, cloudAbort, cloudPush, cloudSync, cloudPull, cloudConflictsEl, cloudBackupsEl,
      sysRowsEl, sysMsg, sysCopyDisabled, sysBusy, recheckSys, copySys,
      usageRowsEl, usageMsg, usageCopyDisabled, usageBusy, recountUsage, copyUsage, usageGoSlotEl,
      cacheBusy, clearApiCache, clearMetaCache, clearThumbCache, clearMissedCache, histBoxEl, cacheUsage, cacheMsg,
      promptDir, promptDirEl, onPromptDirChange, promptInfo, promptInfoTitle, promptMsg, promptRefresh,
      openPromptDir, promptOpenBusy, promptRecentEl,
      skillItems, skillMsg, skillBusy, skillFileEl, skillChipsEl,
      skillMode, skillTree, skillScene, skillSceneNow, skillSceneVars, skillSceneUnknown,
      skillSceneState, isSceneActive, pickSkillScene, openSkillAll, closeSkillAll, skillSceneNameOf,
      skillQ, skillAllQ, skillAllFiltered, skillSelId,
      skillFiles, skillFilePath, skillFileNote, skillCntText, skillPages,
      onSkillSearch, onSkillAllSearch, toggleSkillOpen, setSkillPreEl,
      openSkillFile, toggleSkillEnabled, pickSkillFile, onImportSkillFile, removeSkill, fmtSkillSize,
      skillForm, openSkillNew, openSkillEdit, saveSkillNew, cancelSkillNew,
      asr, asrKey, asrLocalText, asrBrowserText, asrBusy, asrMsg, asrTestText, asrProvOpts, asrProvEl,
      asrModelPh, asrProviderText, asrOnlineReady, onAsrProvChange, onAsrRouteChange,
      loadAsr, saveAsr, clearAsrKey, testAsr,
      search, searchKey, searchBusy, searchMsg, searchTestQ, searchResults, searchTested, searchRead,
      searchChannelOpts, searchChannelEl, searchCredText, searchEngineName, searchNeedsModel,
      saveSearch, clearSearchKey, onSearchKeyInput, onSearchProvChange, testSearch, readFirstSearch,
      exportSetup, pickImportSetup, onImportSetupFile, resetSetup, impSetFileEl,
      icGear: ic('gear', 18), icKey: ic('key', 15), icRefresh: ic('refresh', 15), icList: ic('list', 15),
      icSun: ic('sun', 15), icFolder: ic('folder', 15), icUsers: ic('users', 15), icBrain: ic('brain', 15),
      icPencil: ic('pencil', 15), icUpload: ic('upload', 15), icClock: ic('clock', 15), icLink: ic('link', 15),
      icLayers: ic('layers', 15), icTrash: ic('trash', 15), icFolderDoc: ic('folderDoc', 15),
      icEye: ic('eye', 13), icEyeOff: ic('eyeOff', 13),
    };
  },
  render,
};

export default SettingsView;
