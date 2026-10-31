/* ============================================================================
   设置页「供应商与密钥」的账号卡流 —— 一家账号一张卡，卡里列着这一家会做的每一档
   ---------------------------------------------------------------------------
   这一层是设置页的一个板块，不是一张新页面：它管「账号卡」这一整块的
     · 归并（注册表那几条 provider 声明按存密钥的那一格并成一家 + 本机 / 浏览器内识别那张常驻卡）；
     · 每一档的状态牌（主位 / 在用 / 备用 / 停用）与点它做什么；
     · 卡上的草稿（密钥、清除、暂时不用、「作用文字 AI」那一家）—— 改完先留在内存，由页面的自动保存落盘；
     · 手动声明一档能力（sk_caps_<keyId>）与型号面板的槽位（keyId:档）；
     · 「添加供应商」那张虚线卡的常态形态（预设清单）与整片重画 / 事件委托。
   界面里的档位 = ui.js 的 provKinds()（图片 / 视频 / 语音 / 文字，全站唯一那份）
   再加上 EXTRA_CAPS（语音识别 / 联网搜索）：这两档不是「一类平台」，是文字那一家另外的两种接法。

   数据与副作用**一件都不重写**：注册表、环境密钥、型号面板的读写、两条通道的设置、自动保存
   与目录轨都留在页面那一份里 —— 跨这一层只走 createAccountCards(deps) 递进来的那几样，
   这一层也不往外挂 window。

   凭什么不继续拆：卡顶能力格、卡里每一行、型号面板与「添加供应商」那张虚线卡共用同一份草稿
   与槽位状态（draftKey / panelOpen / slotKey），拆开就得两份各存一份「哪一格展开、哪一家停着」，
   那正是这一层要收口的事。要再切只能按「画卡」与「管状态」切，不是按能力档切。
   ========================================================================== */

import { ref, nextTick } from '../../../vue.runtime.esm-browser.prod.js';

/* 档位名与那一格图标页面也要读（搜索渠道那一行、目录轨的当前值），所以这两枚 export 出去给页面 import —— 没有第二份名单。 */
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
export const capZh = id => (EXTRA_CAPS.find(kv => kv[0] === id) || [])[1]
  || (window.provKindZh ? window.provKindZh(id) : String(id || ''));
export const capGlyph = id => CAP_GLYPH[id] || '·';
/* 单选档 = 同一时刻只有一家顶着（点状态牌就是换一家上位）；
   多选档 = 几家可以同时开着（点状态牌是在用 / 停用）。 */
const SOLO_CAP = new Set(['text', 'asr', 'search']);

/* createAccountCards(deps)：账号卡流的整块状态与画法。
   deps 里三份是**页面持有的可变状态**，只给读取口（regOf / envOf / textFormOf）——
   注册表与环境密钥是页面 load 时整份换掉的，型号面板那份表单也是后建出来的。 */
export function createAccountCards(deps) {
  const {
    ic, q, qa,
    provEpoch, setDocEl, acctToolsEl, provListEl, provErrEl, acctParkEl,
    asrFormEl, asrLocalFormEl, searchFormEl, cusCardEl, cusShown,
    regOf, envOf, textFormOf,
    markChanged, msgOf, useFormCreds, autofetchTried, onPanelClick, onPanelChange,
    syncServiceProvs, scrollToEl, openCus, hideCus, pickCusCap, editCus, removeCus,
    asr, asrLocal, asrBrowser, search,
  } = deps;

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

  function curTextId() {
    const list = window.TextAI ? TextAI.all(regOf()) : [];
    if (!list.length) return '';
    if (textPickDraft) return textPickDraft;
    const saved = TextAI.savedProv(regOf());
    return saved ? saved.id : ((TextAI.prov(regOf()) || list[0]).id);
  }
  /* 「顶着这一档的那一家」的 keyId：单选档（文字对话 / 语音识别 / 联网搜索）靠它判主位。
     语音识别与联网搜索的真相在服务端那两份设置里（.data/asr.json / .data/search.json），
     与卡上那些 localStorage 键各管各的 —— 这里只**读**，改它们仍走各自的表单。 */
  const kidOfProv = id => {
    const p = (regOf().providers || []).find(x => x.id === id);
    return p ? String(p.keyId || p.id) : '';
  };
  /* 「自动」时是哪一家顶着：按注册表顺序挑第一家**声明了这一档、并且已经接上**的账号。
     设置页只读它来画主位，不改服务端那份设置（真正挑哪一家在 /asr、/search 里同一口径）。 */
  function autoServiceKid(cap) {
    const list = (regOf().providers || []).filter(p => p.kind === 'text'
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
    (regOf().providers || []).forEach(p => {
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
      if (p.endpoints && p.endpoints.credits && !m.credits) m.credits = { relay: p.relay, ep: p.endpoints.credits, p };
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
    if ((envOf()[m.keyId] || {}).hasEnv) return '用服务端密钥';
    return '还没填密钥';
  }
  function provUsable(m) {
    if (m.local) return true;
    return (window.Api && Api.provUsable) ? Api.provUsable({ keyId: m.keyId, id: m.prov.id, custom: m.custom }, envOf())
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
    const env = !!(envOf()[kid] && envOf()[kid].hasEnv);
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
      : (envOf()[m.keyId] || {}).hasEnv ? '服务端密钥，留空即可' : '填写密钥，或使用默认';
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
      + '<div class="acct-mid" data-mid="' + kid + '">'
        + m.caps.map(cap => capRowHTML(m, cap) + priFormHTML(m, cap)).join('')
      + '</div>'
      + '<div class="fcard-acts"><span class="hint sm">路线在下面选；本机运行包放 tools/whisper/</span></div>'
      + '</div>';
  }
  /* 卡底右侧那枚余额：取数 / 解析 / 缓存都在外壳那一份（`window.SbBalance`，与侧栏「账户余额」
     同一个口），这里只画。那本「侧栏余额」勾选只管左侧栏显示，这张卡上始终显示这一家的余额；
     没有余额接口的账号不画这一枚（勾选框那一行已经说明了为什么）。 */
  function balChipHTML(m) {
    if (!m.credits || !window.SbBalance) return '';
    const r = SbBalance.rowOf(m.keyId);
    const unit = r ? String(r.unit || '').trim() : '';
    const body = !r ? '<b>…</b>'
      : r.failed ? '<b>读取失败</b>'
        : '<b>' + window.esc(r.avail) + '</b>' + (unit ? '<span class="u">' + window.esc(unit) + '</span>' : '');
    const tip = !r ? '正在查这一家的余额…'
      : r.failed ? String(r.why || '查询失败')
        : '可用 ' + r.avail + (unit ? ' ' + unit : '') + ' · 冻结 ' + r.frozen + (unit ? ' ' + unit : '');
    return '<span class="balnow' + (r && r.failed ? ' err' : '') + '" data-balnow="' + window.esc(m.keyId) + '"'
      + ' title="' + window.esc(tip) + '"><span class="k">余额</span>' + body + '</span>';
  }
  /* 余额换了（外壳取回一轮 / 某一家刚补问回来）就地换掉这几枚，不整片重画卡片。 */
  function paintAccountBalances() {
    qa('[data-balnow]').forEach(el => {
      const m = provRows.get(el.dataset.balnow);
      if (!m) return;
      const box = document.createElement('span');
      box.innerHTML = balChipHTML(m);
      if (box.firstElementChild) el.replaceWith(box.firstElementChild);
    });
  }
  /* 缓存里还没有的那几家补问一次：默认全勾时侧栏每一轮都问过，这里一个请求都不发。
     间隔按分钟级闸住，不跟着每一次重画反复问；失败的行不在这一份里重试（侧栏那一轮会重问）。 */
  let balAskAt = 0, balAsking = false;
  function ensureBalances() {
    const S = window.SbBalance;
    if (!S || !S.fetchRows || balAsking) return;
    if (Date.now() - balAskAt < 60000) return;
    const want = lastAcctShown.filter(m => m.credits && m.credits.p && !S.rowOf(m.keyId));
    if (!want.length) return;
    balAskAt = Date.now();
    balAsking = true;
    S.fetchRows(want.map(m => ({ kid: m.keyId, name: m.name, p: m.credits.p })))
      .then(paintAccountBalances).catch(() => {}).then(() => { balAsking = false; });
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
      + '<div class="acct-mid" data-mid="' + kid + '">' + mid + '</div>'
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
        + balChipHTML(m)
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
      + ((envOf()[m.keyId] || {}).hasEnv ? ' · <code>.env</code> 里已有密钥' : '') + '</span></div>'
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
        ? '<div class="acct-mid" data-mid="__add__"><div class="formslot" data-formslot="cus"></div></div>'
        : '<div class="acct-mid" data-mid="__add__">'
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
    const cu = regOf().custom;
    const dropped = (cu && cu.dropped) || [];
    if (dropped.length || (cu && cu.reason)) {
      lines.push('有 ' + dropped.length + ' 条自定义平台没被本地代理认：'
        + dropped.map(d => '「' + d.id + '」' + d.why).join('；') + (cu.reason ? '（' + cu.reason + '）' : '') + '。');
    }
    const mp = regOf().modelPrefs;
    if (mp && mp.reason) {
      lines.push('「自己填的型号」与「隐藏 / 展示」那份记录读不懂：' + mp.reason
        + ' —— 修好之前在这里勾了也不会变，工作台上看到的仍是接口给的那一份原始清单。');
    }
    el.innerHTML = lines.map(t => '<div class="msg err">' + window.esc(t) + '</div>').join('');
  }

  /* 卡片等高（--sz-acct）+ 卡内那一段自己滚：展开密钥行、展开型号面板都不改卡的外形，
     所以整片重画要还回去的是「那条文档滚到哪儿」加上「每一张卡里那一段滚到哪儿」——
     两样都由公共件 Wb.viewport.keep 按锚点还（.acct-mid 带 data-mid="<kid>" 当身份，
     卡片流重排 / 增删时才不会把 A 卡的视口还到 B 卡上）。 */
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
    const repaintGrid = () => {
      lastAcctAll = provGroups();
      provEpoch.value++;
      provRows.clear();
      lastAcctAll.forEach(m => provRows.set(m.keyId, m));
      lastAcctShown = filteredAccounts();
      paintTools();
      paintRegErr();
      provListEl.value.innerHTML = lastAcctShown.map(accountCardHTML).join('') + addTileHTML(lastAcctAll);
      /* 本机存的和服务端内置的是同一把 → 说明是误存的默认密钥，清掉，保持输入框为空。
         判据带长度（不止末 4 位）：tail 相同的两把不同密钥概率虽小但不是零；server 的 /env-status 带 len。
         走 keyCleared 那一套（跟「清除」按钮同一条路）：删除排队进自动保存、顶栏回执照说 ——
         以前在渲染里直接 LS.del，绕过了「改完就存本机 · 刚刚存过」的状态行。 */
      lastAcctShown.forEach(m => {
        if (m.custom || !(envOf()[m.keyId] || {}).hasEnv) return;
        const lk = keyFor(m.keyId);
        if (!lk || lk.slice(-4) !== envOf()[m.keyId].tail || lk.length !== envOf()[m.keyId].len) return;
        keyDraft.delete(m.keyId);
        keyCleared.add(m.keyId);
        markChanged();
        const inp = q('[data-key="' + window.esc(m.keyId) + '"]');
        if (inp) inp.value = '';
      });
      const tf = textFormOf(); if (tf) tf.paint();
      placeForms();
      wireAcct();
      if (window.Dropdowns && provListEl.value) Dropdowns.build(provListEl.value);
    };
    /* 整片重画那一条文档里的一整块卡流：外层是这一页唯一的文档滚动容器（.set-doc-scroll），
       卡里那一段（.acct-mid）与型号清单（.mlist）在它下面，公共件一趟全罩住。
       ⚠ 要「展开面板就把那一格滚进视野」的那些点击，reveal 必须写在 renderProv **之后** ——
       keep 在重画完就把视口钉回去了，先滚后钉等于没滚。 */
    window.Wb.viewport.keep(setDocEl.value, repaintGrid);
    /* 手加 / 撤掉一档语音识别之后，「在线服务商」那份候选要跟着变。 */
    syncServiceProvs();
    ensureBalances();
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
        r = await TextAI.verifyKey(regOf(), p);
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
      /* 展开完把那一格滚进卡内视野，并把点中的那一行（型号那一排，收起按钮就在它上面）
         钉在视野里：面板比卡内可视区高，超出的一截留在 .acct-mid 里自己滚。
         重画换掉了整棵子树，行与块都要重新 q 一次才是在文档里的那一颗。 */
      if (panelOpen.has(slot)) {
        window.Wb.viewport.reveal(q('[data-mblk="' + window.esc(slot) + '"]'),
          { pin: q('[data-crow="' + window.esc(slot) + '"]') });
      }
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
      /* 加完就把这一档的型号面板摊开 —— 型号得自己填，这是下一步唯一要做的事。
         摊开要写在重画**之前**：一次点击只许重画一次，两次 keep 会各自抓一份锚点快照，
         第二次抓到的已经是第一次还完位的那一帧。 */
      panelOpen.add(slotKey(kid3, cap3));
      renderProv();
      const slot3 = slotKey(kid3, cap3);
      window.Wb.viewport.reveal(q('[data-mblk="' + window.esc(slot3) + '"]'),
        { pin: q('[data-crow="' + window.esc(slot3) + '"]') });
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
      /* 摊开的是密钥那一行：reveal 把输入框带进卡内视野，pin 让它所属的那一行不被顶出去。 */
      if (inp) { window.focusQuiet(inp); window.Wb.viewport.reveal(inp, { pin: inp.closest('.krow') }); }
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

  /* 最近一次归并出来的全部账号：页面算「自动那一家」的名字时要读，但它只由重画写。 */
  const acctAll = () => lastAcctAll;
  /* 文字档「点了但还没落盘」那一家：草稿在本层，落盘在页面 —— 两头各拿一个口。 */
  const textPick = () => textPickDraft;
  const setTextPick = v => { textPickDraft = v || ''; };

  return {
    /* 归并与读数：页面画目录轨那一行的当前值、算渠道、判「这一家接上了没有」都问这里。 */
    provGroups, provUsable, curTextId, autoServiceKid, hostKidOf, allCaps, acctAll,
    draftKey, keyFor, keyCleared, keyDraft, acctOffSet, panelOpen, fetchNote,
    manualCapsOf, setManualCaps,
    /* 型号面板的槽名（面板那一份按 keyId:档 存「展开的是哪一格 / 刚取回的那一份」）。 */
    slotKey, slotKid, slotCap, slotOfProv, provBySlot,
    /* 重画与就地补画：账号卡整片重画、余额那几枚就地换、密钥来源那一行就地换。 */
    renderProv, refreshProvNotes, paintAccountBalances, acctMsg,
    textPick, setTextPick,
  };
}
