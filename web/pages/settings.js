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

import { ensureCss } from '../core/page-css.js';

/* 外壳只引了 tokens / ui / sidebar / spa-director，不引任何页面样式；
   这一页的样式自己挂一次 —— 无构建步骤，也不要求别人记得在 shell.html 里补一行。
   与 spa-chars / spa-studio / spa-assets 同一套：已经由别处引过时不再插第二张。 */
ensureCss('web/styles/spa-settings.css', 'spa-settings');

const CUS_KINDS = [['image', '图片'], ['video', '视频'], ['audio', '语音'], ['text', '文字']];
/* 供应商卡里那两档不是「一类平台」，而是同一层级的两种接法：语音识别与联网搜索。
   它们共用同一排分段按钮，但下面画的是自己的表单，不列供应商卡。 */
const VIRTUAL_TABS = [['asr', '语音识别'], ['search', '联网搜索']];
const isVirtualTab = k => VIRTUAL_TABS.some(t => t[0] === k);
const CUS_CUSTOM = '__custom__';           // 「供应商」下拉里那一项「自定义」的值
const KIND_MNEW = {
  text: '自己填一个型号，例如 openai/gpt-4o-mini、glm-4-flash',
  image: '自己填一个型号 id（它没有列型号的接口时只能这样加）',
  video: '自己填一个型号 id（它没有列型号的接口时只能这样加）',
  audio: '自己填一个型号 id（它没有列型号的接口时只能这样加）',
};

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
    opts: [['all', '连历史产物一起补齐（推荐默认）'], ['new', '只存开启之后新生成的']], hintDyn: 'saveScope' },
  { card: 'store', kind: 'check', key: 'sb_bal_on', label: '左栏显示余额', on: '1', off: '0', def: true, keep: 1 },
  { card: 'store', kind: 'check', key: 'sb_mirror_on', label: '左栏显示本机产物（正在存几份 / 已存多少）', on: '1', off: '0', def: true, keep: 1 },
  /* AI 助手：四颗开关（after: 'notice' 在通知那一行追加「现在授权」与授权状态说明） */
  { card: 'assistant', kind: 'check', key: 'ai_chat_off', label: '启用 AI 助手（默认开；关掉后右下角不再有悬浮球，Ctrl + / 也不生效）', on: null, off: '1', def: true, keep: 1 },
  { card: 'assistant', kind: 'check', key: 'ai_chat_auto', label: '执行前不用我点确认（卡片照画，动作自动提交）', on: '1', off: null, def: false },
  { card: 'assistant', kind: 'check', key: 'ai_chat_snap', label: '悬浮球拖到窗口边上时吸住（默认开）', on: null, off: '0', def: true },
  { card: 'assistant', kind: 'check', key: 'ai_chat_notice', label: '助手提交的任务出结果时弹一次系统通知', on: '1', off: null, def: false, after: 'notice' },
  /* 润色行为 */
  { card: 'polish', kind: 'sel', key: 'sk_polish_ask', label: '润色前要不要先反问', def: 'ai',
    opts: [['ai', '交给 AI 判断（推荐）：它读完觉得缺什么才问'], ['on', '强制先问'], ['off', '从不问，直接润色']] },
];

const SettingsView = {
  name: 'SettingsView',
  setup() {
    /* ---------- 容器（全部走 ref；组件里不出现 document.getElementById） ---------- */
    const rootEl = ref(null);
    const setNavEl = ref(null);
    const setQEl = ref(null);
    const setChipsEl = ref(null);
    const setSubEl = ref(null);
    const provTabsEl = ref(null);
    const provListEl = ref(null);
    const cusCardEl = ref(null);
    const cusNameEl = ref(null);
    const cusBaseEl = ref(null);
    const cusKeyEl = ref(null);
    const cusExtraEl = ref(null);
    const cusProvEl = ref(null);
    const cusShapeEl = ref(null);
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
    const win = window;
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
    /* 供应商卡 */
    const provSumText = ref('');
    const provSumErr = ref(false);

    /* ---------- 供应商：类型档 / 草稿 / 归并 ---------- */
    let provTab = window.LS.get('sk_prov_tab');
    if (!window.provKinds || (!isVirtualTab(provTab) && window.provKinds().indexOf(provTab) < 0)) provTab = 'image';
    /* 模板里的 v-show 认这个镜像：provTab 是命令式重画用的局部量，两个入口都走 setProvTab。 */
    const provTabView = ref(provTab);
    function setProvTab(k) {
      provTab = k;
      provTabView.value = k;
      window.LS.set('sk_prov_tab', k);
    }
    const provSel = new Map();          // kind → 这一类里最后看过的 keyId（只用于默认展开哪张卡）
    /* 「作用文字 AI」点过、还没落盘的那一个。为什么需要它：换一家会整块重画（识图那一段只画在
       当前那一家的卡上），而重画会先把旧卡片整个换掉 —— 那时 DOM 里已经没有那个刚点中的单选框，
       `curTextId()` 只能回落到盘上的旧值，点一下看起来像「弹回去了」。记一份草稿（与密钥 / 型号
       同一套「改完先留在内存、由自动保存统一落盘」的写法），重画时按它选回去；落盘后清掉。 */
    let textPickDraft = '';
    const keyDraft = new Map();         // keyId → 还没落盘的密钥
    const baseDraft = new Map();        // keyId → 还没落盘的接口地址
    const keyCleared = new Set();       // 点了「清除」、还没落盘的 keyId
    const provRows = new Map();         // keyId → 归并后的那一条（验证 / 地址归属要用）
    let provSumPainter = null;

    const keyFor = id => window.LS.get('sk_key_' + id) || '';
    const draftKey = kid => (keyCleared.has(kid) ? ''
      : (keyDraft.has(kid) ? keyDraft.get(kid) : keyFor(kid)));
    const draftBase = kid => (baseDraft.has(kid) ? baseDraft.get(kid) : (window.LS.get('sk_base_' + kid) || ''));

    function setREG(d) {
      REG = d && d.providers ? d : { providers: [] };
      return REG;
    }

    function curTextId() {
      const list = window.TextAI ? TextAI.all(REG) : [];
      if (!list.length) return '';
      const picked = q('[data-tpick]:checked');
      if (picked && picked.dataset.tpick) return picked.dataset.tpick;
      if (textPickDraft) return textPickDraft;
      const saved = TextAI.savedProv(REG);
      return saved ? saved.id : ((TextAI.prov(REG) || list[0]).id);
    }

    /* 按「存密钥的那一格」（keyId）归并：一家平台同时服务图片与视频时共用一把 sk_key_<keyId>，
       界面上也就只该有一条 —— 同一次保存里两个框抢同一把钥匙，后写的会把前一个盖掉。 */
    function provGroups() {
      const merged = new Map();
      (REG.providers || []).forEach(p => {
        const keyId = p.keyId || p.id;
        let m = merged.get(keyId);
        if (!m) {
          m = { keyId, names: [], kindIds: [], credits: null, site: '', base: p.base || '', prov: p,
            custom: !!p.custom, shapeName: p.customShapeName || '' };
          merged.set(keyId, m);
        }
        m.names.push(p.name);
        if (!m.site && p.site) m.site = p.site;
        m.kindIds.push(p.kind);
        if (p.endpoints && p.endpoints.credits && !m.credits) m.credits = { relay: p.relay, ep: p.endpoints.credits };
      });
      const all = [...merged.values()];
      all.forEach(m => {
        m.name = (m.names[0] || '').split(' ')[0];
        m.kindSet = [...new Set(m.kindIds)];
        m.kindLabel = m.kindSet.map(k => window.provKindZh(k)).join('+');
      });
      return all;
    }
    function keyState(m) {
      if (draftKey(m.keyId)) return '已填密钥';
      if ((envInfo[m.keyId] || {}).hasEnv) return '用服务端密钥';
      return '还没填密钥';
    }
    function provUsable(m) {
      return (window.Api && Api.provUsable) ? Api.provUsable({ keyId: m.keyId, id: m.prov.id, custom: m.custom }, envInfo)
        : (!!m.custom || keyState(m) !== '还没填密钥');
    }
    /* 这一把密钥**现在是从哪来的** —— 写在卡上（三种来源：设置页 / .env / 刚清除还没落盘）。 */
    function keySourceNote(kid) {
      if (keyCleared.has(kid) && window.LS.get('sk_key_' + kid)) {
        return '密钥来源：刚刚点了「清除」，这一项正在自动存进本机 —— 存好之前磁盘上那把还在，'
          + '别的地方现在用的仍是它。（顶栏一直写着「没存进本机」时，说明这一趟没成。）';
      }
      const local = !!draftKey(kid);
      const env = !!(envInfo[kid] && envInfo[kid].hasEnv);
      if (local && env) return '密钥来源：设置页里存着一把（与 .env 无关；留空即改回用 .env 那把）';
      if (local) return '密钥来源：<b>设置页里存着的</b>（存在 <code>.data/sk_key_' + window.esc(kid) + '.json</code>，与 .env 无关）—— 点「清除」才会真的没有';
      if (env) return '密钥来源：服务端环境密钥（.env 或系统环境变量）';
      return '密钥来源：还没有（在上面填一把，或在 <code>.env</code> 里配同名变量）';
    }
    function refreshProvNotes() {
      qa('[data-ksrc]').forEach(sp => {
        const kid = sp.dataset.ksrc;
        if (kid) sp.innerHTML = keySourceNote(kid);
      });
      if (provSumPainter) provSumPainter();
    }

    /* 「型号清单」这一段：四类供应方都画，长在**自己那张供应商卡**里，默认折叠。
       只画骨架：认家、取型号列表、画每一行都在 textForm 里（paint 时填）。 */
    function modelsBlock(m) {
      const kid = window.esc(m.keyId);
      const text = provTab === 'text';
      const p = m.prov || {};
      const canFetch = text || !!(p.endpoints && p.endpoints.models);
      const head = text
        ? '<div class="krow thin"><span class="kn">型号</span>'
          + '<select data-tmodel="' + kid + '"></select>'
          + '<span class="acts"><button class="ghost xs" data-ttest="' + kid + '"'
          + ' title="给这一家发一条测试消息（用左边下拉里当前这个型号）">测试</button></span></div>'
        : '';
      return '<div class="tai mblk foldable" data-mblk="' + kid + '" data-fold-key="set_fold_models_' + kid + '" data-fold-once>'
        + head
        + '<div class="mb-head">'
        + '<button class="tool fold-toggle" type="button" aria-expanded="false"'
        + ' title="展开可以自己填型号、从接口取一次清单，并逐个决定哪一个出现在工作台下拉里">'
        + '型号清单<span class="fold-txt">展开</span></button>'
        + '<span class="hint sm" data-mcount="' + kid + '"></span>'
        + '</div>'
        + '<div class="fold-body">'
        + '<div class="krow tight">'
        + '<input data-tmnew="' + kid + '" placeholder="' + window.esc(KIND_MNEW[provTab] || KIND_MNEW.text) + '">'
        + '<button class="ghost wide" data-tadd="' + kid + '">添加型号</button>'
        + (canFetch ? '<button class="ghost xs" data-tfetch="' + kid + '"'
          + ' title="用这一栏里现在的密钥与接口地址问一次它的型号清单（不花钱、不建任务）">获取型号列表</button>' : '')
        + '</div>'
        + '<div class="mlist" data-tchips="' + kid + '"></div>'
        + '</div>'
        + '</div>';
    }
    function visionBlock(m) {
      const kid = window.esc(m.keyId);
      return '<div class="tai-h">' + ic('eye', 13) + '识图能力'
        + '<span class="hint sm">润色时要不要把参考图一起发给它（这一项对所有文字供应商生效）</span></div>'
        + '<div class="krow"><span class="kn">参考图</span>'
        + '<select data-tvision="' + kid + '">'
        + '<option value="auto" title="按接口返回与平台声明自动判断">自动</option>'
        + '<option value="on" title="强制把图片一起发给它">支持识图</option>'
        + '<option value="off" title="强制只发文字">不支持</option>'
        + '</select></div>'
        + '<div class="pb-tip" data-vtip="' + kid + '"></div>';
    }

    function setMsg(kid, text, cls) {
      const el = q('[data-msg="' + kid + '"]');
      if (!el) return;
      el.className = cls; el.textContent = text;
    }

    function renderProv() {
      if (!provTabsEl.value || !provListEl.value) return;
      const all = provGroups();
      const listed = k => all.filter(m => m.kindSet.includes(k) && provUsable(m)).length;
      /* ① 类型分段：按钮后面那个数字 = 这一类现在列着几家（= 在用的几家）。
         语音识别 / 联网搜索排在最后两档：它们与四类平台同一层级，但不按「家」计数。 */
      const tabs = provTabsEl.value;
      tabs.innerHTML = window.provKinds().map(k => '<button data-tab="' + k + '"' + (k === provTab ? ' class="on"' : '') + '>'
        + window.esc(window.provKindZh(k)) + '<b class="seg-n">' + listed(k) + '</b></button>').join('')
        + VIRTUAL_TABS.map(([k, zh]) => '<button data-tab="' + k + '"' + (k === provTab ? ' class="on"' : '') + '>'
          + window.esc(zh) + '</button>').join('');
      tabs.querySelectorAll('[data-tab]').forEach(b => {
        b.onclick = () => {
          if (b.dataset.tab === provTab) return;
          setProvTab(b.dataset.tab);
          renderProv();
          if (!isVirtualTab(provTab)) cusKindChanged();
        };
      });
      /* 这两个是表单，不是供应商清单：清掉上面那一批卡，留着分段按钮。 */
      if (isVirtualTab(provTab)) {
        provRows.clear();
        provSumErr.value = false;
        provSumText.value = '';
        provSumPainter = () => {};
        provListEl.value.innerHTML = '';
        return;
      }
      /* ② 只列「已经在用的」那几家（自己加的 / 密钥有着落的）。 */
      const gs = all.filter(m => m.kindSet.includes(provTab) && provUsable(m));
      const avail = all.filter(m => m.kindSet.includes(provTab));
      provRows.clear();
      gs.forEach(m => provRows.set(m.keyId, m));
      const paintSum = () => {
        if (window.Api && Api.regFailed && Api.regFailed()) {
          provSumText.value = '读不到注册表 —— 本地代理没连上或还没启动'
            + (Api.regError ? '（原因：' + Api.regError() + '）' : '')
            + '。先把 proxy.js 启动起来（启动.bat 选 1，或 node proxy.js）再刷新这一页；'
            + '在它起来之前，下面这些「配没配密钥 / 能出几张 / 这个型号支持什么」都是错的。';
          provSumErr.value = true;
          return;
        }
        provSumErr.value = false;
        const g2 = all.filter(m => m.kindSet.includes(provTab) && provUsable(m));
        const noKey = g2.filter(m => keyState(m) === '还没填密钥').length;
        provSumText.value = g2.length
          ? window.provKindZh(provTab) + '类：已接 ' + g2.length + ' 家 · 注册表里共 ' + avail.length + ' 家可选'
            + (noKey ? ' · 有 ' + noKey + ' 家还没填密钥' : ' · 密钥都配好了')
          : window.provKindZh(provTab) + '类还没有在用的平台 —— 注册表里共 ' + avail.length
            + ' 家可选，点右边的「＋ 添加自定义供应商」把要用的接进来（选它、填上密钥，地址会自动填好官网的）';
      };
      provSumPainter = paintSum;
      paintSum();
      /* ③ 一家一张卡（一次一把钥匙只对应一个输入框）。 */
      const box = provListEl.value;
      box.innerHTML = '';
      const order = gs.slice().sort((a, b) => (a.custom === b.custom ? 0 : (a.custom ? 1 : -1)));
      for (const cur of order) {
        const m = cur, kid = m.keyId, off = window.Api ? Api.isOff(m.prov) : false;
        provRows.set(kid, m);
        const wrap = document.createElement('div');
        wrap.className = 'prov' + (off ? ' off' : '') + (m.custom ? ' cus' : '');
        const nameHtml = m.site
          ? '<a class="site" href="' + window.esc(m.site) + '" target="_blank" rel="noopener" title="打开官网 ' + window.esc(m.site) + '">' + window.esc(m.name) + '</a>'
          : window.esc(m.name);
        const others = m.kindSet.filter(k => k !== provTab).map(k => window.provKindZh(k));
        const meta = m.custom
          ? ('转发到 <code>' + window.esc(m.prov.base) + '</code> · 接口形状取自「' + window.esc(m.shapeName) + '」 · 型号 '
            + ((m.prov.models || []).length) + ' 个 —— 名字 / 地址 / 型号清单点下面那颗「编辑」改')
          : (m.prov.baseEditable
            ? '官方地址 <code>' + window.esc(m.base) + '</code>（可改成任意 OpenAI 兼容地址，按供应商各存各的）'
            : '官方地址 <code>' + window.esc(m.base) + '</code>（不收地址：中转站请添加成自定义供应商）');
        wrap.innerHTML =
          '<div class="krow">' +
            '<span class="kicon">' + ic('key', 15) + '</span><span class="kn">' + nameHtml
              + '<div class="kinds">' + window.esc(m.kindLabel) + (m.custom ? ' · 自定义' : '') + '</div></span>' +
            '<input type="password" data-key="' + window.esc(kid) + '" value="' + window.esc(draftKey(kid)) + '" placeholder="'
              + (m.custom ? '填写这一家自己的密钥（不会用内置平台的密钥）'
                : envInfo[kid] && envInfo[kid].hasEnv ? '已使用服务端环境密钥（留空即可）' : '填写密钥，或使用默认') + '">' +
            '<span class="acts">' +
              '<button class="ghost eye" data-eye="' + window.esc(kid) + '" title="显示 / 隐藏密钥">' + ic('eye', 13) + '</button>' +
              '<button class="ghost clr" data-clr="' + window.esc(kid) + '">清除</button>' +
              '<button class="ghost xs" data-vfy="' + window.esc(kid) + '"'
                + ' title="拿这一栏现在填的密钥问一次只读接口（余额 / 型号清单 / 列表）：不建任务、不扣费，还没自动存进本机也能问">验证</button>' +
              '<label class="sbshow' + (m.credits ? '' : ' dim') + '" title="'
              + (m.credits
                ? '勾选后在左侧栏「账户余额」里显示这个接口的余额（改完自动存进本机）'
                : '这家平台没有提供余额查询接口，勾了也不会显示余额')
              + '"><input type="checkbox" data-bal="' + window.esc(kid) + '"' + (window.SbBal && SbBal.isOff(kid) ? '' : ' checked') + '>侧栏余额</label>' +
              '<label class="sbshow" title="勾上 = 这一家不进该工作台的型号下拉（历史任务照常能看）。改完自动存进本机">'
                + '<input type="checkbox" data-off="' + window.esc(kid) + '"' + (off ? ' checked' : '') + '>暂时不用</label>' +
              (m.custom ? '<button class="ghost xs" data-cedit="' + window.esc(kid) + '">编辑</button>'
                + '<button class="ghost xs danger" data-cdel="' + window.esc(kid) + '">删除</button>' : '') +
              (provTab === 'text' ? '<label class="sbshow" title="润色、识图、发送消息都发给这一家（改完自动存进本机）">'
                + '<input type="radio" name="textProvPick" data-tpick="' + window.esc(m.prov.id) + '"'
                + (curTextId() === m.prov.id ? ' checked' : '') + '>作用文字 AI</label>' : '') +
            '</span>' +
          '</div>' +
          (m.prov.baseEditable
            ? '<div class="krow thin"><span class="kn">接口地址</span>'
              + '<input data-base="' + window.esc(kid) + '" value="' + window.esc(draftBase(kid)) + '" placeholder="留空则用：' + window.esc(m.base) + '">'
              + '<span class="hint sm" data-basehint="' + window.esc(kid) + '"></span></div>'
            : '') +
          '<div class="meta">' + meta
          + (others.length ? '<br>同一把密钥也用于：' + window.esc(others.join(' / ')) + '（切上面那一档，看到的还是这一把）' : '')
          + '<br><span data-ksrc="' + window.esc(kid) + '">' + keySourceNote(kid) + '</span>'
          + '</div>' +
          '<div class="msg" data-msg="' + window.esc(kid) + '"></div>' +
          modelsBlock(m)
          + (provTab === 'text' && curTextId() === m.prov.id ? visionBlock(m) : '');
        box.appendChild(wrap);
        // 本机存的和服务端内置的是同一把 → 说明是误存的默认密钥，直接清掉，保持输入框为空
        if (!m.custom && envInfo[kid] && envInfo[kid].hasEnv) {
          const lk = keyFor(kid);
          if (lk && lk.slice(-4) === envInfo[kid].tail) {
            window.LS.del('sk_key_' + kid);
            keyDraft.delete(kid);
            const inp = wrap.querySelector('[data-key]');
            if (inp) inp.value = '';
          }
        }
      }
      /* 代理把清单里读不懂的条目丢掉时必须当场说出来。 */
      const cu = REG && REG.custom;
      const dropped = (cu && cu.dropped) || [];
      if (dropped.length || (cu && cu.reason)) {
        const line = document.createElement('div');
        line.className = 'msg err';
        line.textContent = '有 ' + dropped.length + ' 条自定义平台没被本地代理认：'
          + dropped.map(d => '「' + d.id + '」' + d.why).join('；') + (cu.reason ? '（' + cu.reason + '）' : '') + '。';
        box.appendChild(line);
      }
      /* 「自己填的型号」与「藏了哪几个」的记录读不懂时也必须说一句。 */
      const mp = REG && REG.modelPrefs;
      if (mp && mp.reason) {
        const line = document.createElement('div');
        line.textContent = '⚠ ' + mp.reason + ' —— 这一家的「自己填的型号」和「隐藏 / 展示」现在都没生效，'
          + '工作台上看到的仍是接口给的那一份原始清单。修好之前别在这里勾（勾了也不会变）。';
        line.className = 'msg err';
        box.appendChild(line);
      }
      /* 「验证」用的是**这一栏现在的值**（含还没保存的那把）。 */
      box.querySelectorAll('[data-vfy]').forEach(btn => {
        btn.onclick = async () => {
          const k = btn.dataset.vfy, m = provRows.get(k);
          if (!m) return;
          btn.disabled = true;
          const to = () => draftBase(k) || m.prov.base;
          const via = window.Api ? Api.verifyTarget(m.prov) : { via: '', label: '' };
          /* 文字 AI 的 registry 只声明了 chat（没有余额 / 模型清单端点），验证口径是问一次它的余额接口。
             用的是**这一栏刚填的**密钥与地址（TextAI.setFormOverride，只进内存不写盘）。 */
          if (!via.via) {
            setMsg(k, via.label || '', 'msg');
            let r = { state: 'unknown', text: '' };
            try {
              useFormCreds(m.prov);
              r = await TextAI.verifyKey(REG, m.prov);
            } catch (e) { r.text = errText(e); }
            btn.disabled = false;
            const ok = r.state === 'ok';
            setMsg(k, (ok ? '✓ ' : r.state === 'invalid' ? '✗ ' : '· ') + (r.text || '') + '（转发到 ' + to() + '）',
              'msg ' + (ok ? 'ok' : r.state === 'invalid' ? 'err' : ''));
            return;
          }
          setMsg(k, '正在用这一栏里的密钥问一次「' + via.label + '」…', 'msg');
          let r = { ok: false, detail: '', why: '' };
          try { r = await Api.verify(m.prov, { key: draftKey(k), base: draftBase(k) || null }); } catch (e) { r.why = errText(e); }
          btn.disabled = false;
          setMsg(k, (r.ok ? '✓ ' : '✗ ') + (r.ok ? r.detail : r.why) + '（转发到 ' + to() + '）', 'msg ' + (r.ok ? 'ok' : 'err'));
        };
      });
      /* 接口地址：输入时现算一次「这个 host 是不是别家的官方地址」，当场写在名字后面的提示里。 */
      box.querySelectorAll('[data-base]').forEach(inp => {
        inp.oninput = () => {
          baseDraft.set(inp.dataset.base, inp.value.trim());
          const m = provRows.get(inp.dataset.base);
          const hint = q('[data-basehint="' + inp.dataset.base + '"]');
          const v = inp.value.trim();
          if (!hint || !m) return;
          const own = Api.hostOwner(REG, v, m.prov);
          hint.textContent = !v ? '留空 = 用官方地址' : (own && own.kind === 'other-provider')
            ? '⚠ 这是「' + own.name + '」的官方地址，用这家的密钥会被上游拒绝' : '';
          hint.style.color = (own && own.kind === 'other-provider') ? 'var(--err)' : '';
        };
      });
      /* 暂时不用：改的是勾选状态 + 那张卡的明暗，落盘跟着这一页统一的自动保存。 */
      box.querySelectorAll('[data-off]').forEach(cb => {
        cb.onchange = () => {
          const card = cb.closest('.prov');
          if (card) card.classList.toggle('off', cb.checked);
        };
      });
      box.querySelectorAll('[data-cedit]').forEach(b => { b.onclick = () => editCus(b.dataset.cedit); });
      box.querySelectorAll('[data-cdel]').forEach(b => { b.onclick = () => removeCus(b.dataset.cdel); });
      /* 作用文字 AI：换一家就整块重画（识图那一段只画在当前这一家的卡上）。 */
      box.querySelectorAll('[data-tpick]').forEach(rb => {
        rb.onchange = () => { textPickDraft = rb.dataset.tpick || ''; renderProv(); };
      });
      /* 密钥输入只记进那份未保存的草稿；逐字敲时不存盘。 */
      box.querySelectorAll('[data-key]').forEach(inp => {
        inp.oninput = () => {
          keyCleared.delete(inp.dataset.key);
          if (inp.value.trim()) keyDraft.set(inp.dataset.key, inp.value.trim());
          else keyDraft.delete(inp.dataset.key);
        };
      });
      /* 密钥默认密文，点眼睛可切换明文查看。 */
      box.querySelectorAll('[data-eye]').forEach(b => {
        b.onclick = () => {
          const inp = b.closest('.krow').querySelector('[data-key]');
          if (!inp) return;
          inp.type = inp.type === 'password' ? 'text' : 'password';
          b.innerHTML = ic(inp.type === 'password' ? 'eye' : 'eyeOff', 13);
          b.title = inp.type === 'password' ? '显示密钥' : '隐藏密钥';
        };
      });
      /* 型号块先画骨架、后填内容（取型号列表要等 TextAI 就绪）。 */
      initFolds(box);
      if (textForm) textForm.paint();
      /* 清除本机密钥：不在这里 removeItem，跟着自动保存排队落盘。 */
      box.querySelectorAll('[data-clr]').forEach(b => {
        b.onclick = () => {
          const kid = b.dataset.clr;
          const inp = b.closest('.krow').querySelector('[data-key]');
          if (inp) inp.value = '';
          keyDraft.delete(kid);
          keyCleared.add(kid);
          markChanged();
          b.textContent = '已清除';
          b.title = '这一项已经排队存进本机（顶栏那一句会说存好了没有）';
          setTimeout(() => { b.textContent = '清除'; b.title = '清掉本机存的这把密钥（存进本机后生效）'; }, 1500);
          refreshProvNotes();
        };
      });
    }

    /* ---------- 添加自定义供应商 ----------
       界面只收四样：照哪一家的接口形状、显示名、地址、型号清单；密钥按 sk_key_<新 id> 单独存。
       清单写成 sk_custom（DataSync 镜像成 .data/sk_custom.json，代理读那份合并进 /registry）。 */
    const cusShown = ref(false);
    const cusEditing = ref('');
    const cusProvSel = ref('');
    const cusShapeSel = ref('');
    const cusProvOpts = ref([]);
    const cusShapeOpts = ref([]);
    const cusShapeShown = ref(false);
    const cusShapeHint = ref('');
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
    let cusAutoName = '';
    let cusAutoBase = '';

    const cusHost = u => { try { return new URL(u).host; } catch (e) { return String(u || ''); } };
    const cusKind = () => (window.provKinds().indexOf(provTab) >= 0 ? provTab : 'image');
    function cusBuiltins(kind) {
      return (REG.providers || []).filter(p => !p.custom && p.kind === kind);
    }
    function cusFamilies(kind) {
      return ((REG && REG.interfaceShapes) || {})[kind] || [];
    }
    const cusProvById = id => (REG.providers || []).find(p => p.id === id) || null;
    function cusTemplate() {
      const kind = cusKind();
      const pv = cusProvSel.value;
      if (pv && pv !== CUS_CUSTOM) return cusProvById(pv);
      const fam = cusFamilies(kind).find(f => f.id === cusShapeSel.value);
      return fam ? cusProvById(fam.template) : null;
    }
    function cusSetMsg(text, cls) {
      cusMsg.value = text || '';
      cusMsgCls.value = cls || '';
    }
    function paintCusCount() {
      if (!cusCount) return;
      const kind = cusKind();
      const list = Api.customList();
      const n = list.length;
      const mine = list.filter(e => e && (e.kind || '') === kind).length;
      cusCount.value = window.provKindZh(kind) + '类 · 四种类型合计已接 ' + n + ' 家 · 这一类 ' + mine + ' 家';
    }
    /* 显示名预填跟着「照哪一家」走（内置那家填它自己的平台名，「自定义」按类型编号）。 */
    function cusDefaultName(kind) {
      const pv = cusProvSel.value;
      const b = pv && pv !== CUS_CUSTOM ? cusProvById(pv) : null;
      const zh = (CUS_KINDS.find(k => k[0] === kind) || [, kind])[1];
      const stem = String((b && (b.displayName || b.name)) || '').trim() || zh;
      const taken = new Set(Api.customList().filter(e => e && (e.kind || 'image') === kind).map(e => (e.name || '').trim()));
      for (let i = 1; i < 200; i++) { const n = i === 1 ? stem : stem + ' ' + i; if (!taken.has(n)) return n; }
      return stem;
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
    /* 「已添加的几家」列在这张卡里：在哪一档加的就回到哪一档改 / 删。 */
    function paintCusMine() {
      const list = Api.customList().filter(e => e && e.id);
      cusMineShown.value = !!list.length;
      cusMineGroups.value = CUS_KINDS.map(kv => {
        const mine = list.filter(e => (e.kind || 'image') === kv[0]);
        return {
          kind: kv[0], zh: kv[1],
          items: mine.map(e => ({ id: e.id, name: e.name || e.id, modelsN: (e.models || []).length })),
        };
      }).filter(g => g.items.length);
    }
    function openCus() {
      cusShown.value = true;
      if (cusEditing.value) cusReset();
      cusProvSel.value = '';
      cusShapeSel.value = '';
      renderCus();
      nextTick(() => {
        if (cusCardEl.value) scrollToEl(cusCardEl.value);
        const focus = String(cusName.value || '').trim() ? cusBaseEl.value : cusNameEl.value;
        if (focus) focus.focus();
      });
    }
    /* 类型 → 供应商 → 接口形状 → 型号 联动：清单全取自 /registry 的声明。 */
    function renderCus() {
      const kind = cusKind();
      paintCusCount();
      paintCusMine();
      /* ---- 供应商（内置那几家 + 末尾「自定义」） ---- */
      const provs = cusBuiltins(kind);
      const prev = cusProvSel.value;
      cusProvOpts.value = provs.map(p => ({ id: p.id, label: p.displayName || p.name }))
        .concat([{ id: CUS_CUSTOM, label: '自定义（我跑的是别的厂商的协议）' }]);
      const okIds = provs.map(p => p.id).concat([CUS_CUSTOM]);
      if (!cusProvSel.value || okIds.indexOf(cusProvSel.value) < 0) {
        cusProvSel.value = (prev && okIds.indexOf(prev) >= 0) ? prev : (provs[0] ? provs[0].id : CUS_CUSTOM);
      }
      /* ---- 接口形状：只在「自定义」时出现 ---- */
      const isCustom = cusProvSel.value === CUS_CUSTOM;
      cusShapeShown.value = isCustom;
      if (isCustom) {
        const fams = cusFamilies(kind);
        cusShapeOpts.value = fams.length
          ? fams.map(f => ({ id: f.id, label: f.name }))
          : [{ id: '', label: '这一类还没有登记接口形状' }];
        const sk = cusShapeSel.value;
        cusShapeSel.value = fams.some(f => f.id === sk) ? sk : ((fams[0] && fams[0].id) || '');
        if (!fams.length) {
          cusModelsEmpty.value = '这一类在注册表里还没有登记接口形状 —— 接口形状完全不一样的平台需要改代理的注册表，这里不猜字段。';
          cusModelRows.value = [];
          cusShapeHint.value = '';
          cusSyncBase();
          cusSyncName();
          nextTick(syncCusDropdowns);
          return;
        }
        const f = fams.find(x => x.id === cusShapeSel.value);
        const tpl = f ? cusProvById(f.template) : null;
        cusShapeHint.value = (f && f.note ? f.note + ' ' : '') + '照「' + ((tpl && (tpl.displayName || tpl.name)) || '—') + '」那一家的声明走。';
      }
      cusSyncBase();
      cusSyncName();
      nextTick(syncCusDropdowns);
      rebuildCusModels();
    }
    function syncCusDropdowns() {
      if (!window.Dropdowns) return;
      if (cusProvEl.value) { Dropdowns.build(cusProvEl.value.parentElement || cusProvEl.value); Dropdowns.sync(cusProvEl.value); }
      if (cusShapeEl.value) { Dropdowns.build(cusShapeEl.value.parentElement || cusShapeEl.value); Dropdowns.sync(cusShapeEl.value); }
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
        : '点右边「获取型号列表」用它自己的接口问一次，拿回来的型号会全部勾上（用不上的再自己勾掉）；也可以用下面「自己填 id」手打。'
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
    function cusKindChanged() {
      if (!cusShown.value) return;
      cusProvSel.value = '';
      cusShapeSel.value = '';
      renderCus();
    }
    function onCusProvChange(ev) { if (ev && ev.target) cusProvSel.value = ev.target.value; renderCus(); }
    function onCusShapeChange(ev) { if (ev && ev.target) cusShapeSel.value = ev.target.value; renderCus(); }
    function cusReset() {
      cusEditing.value = '';
      cusAddText.value = '添加这一家';
      cusCancelShown.value = false;
      cusName.value = ''; cusBase.value = ''; cusKey.value = ''; cusExtra.value = '';
      cusAutoName = '';
      cusFetched.value = []; cusFetchFrom.value = ''; cusOff.clear();
      renderCus();
    }
    async function editCus(kid) {
      const e = Api.customList().find(x => x && x.id === kid);
      if (!e) { setMsg(kid, '清单里找不到这一条（可能刚被删掉）—— 刷新一次页面看看。', 'msg err'); return; }
      if (e.kind && e.kind !== provTab) {
        setProvTab(e.kind);
        if (e.kind !== 'text') provSel.set(e.kind, kid);
        renderProv();
      }
      cusShown.value = true;
      cusEditing.value = kid;
      cusOff.clear();
      cusAutoName = '';
      cusAutoBase = '';
      cusProvSel.value = '';
      cusShapeSel.value = '';
      renderCus();
      /* 还原「当初是怎么选的」 */
      const fams = cusFamilies(e.kind);
      if (e.prov && cusProvById(e.prov)) cusProvSel.value = e.prov;
      else if (e.shapeId && fams.some(f => f.id === e.shapeId)) { cusProvSel.value = CUS_CUSTOM; cusShapeSel.value = e.shapeId; }
      else if (cusProvById(e.shape)) cusProvSel.value = e.shape;
      else {
        cusProvSel.value = CUS_CUSTOM;
        const f = fams.find(x => x.template === e.shape);
        if (f) cusShapeSel.value = f.id;
      }
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
        if (cusProvEl.value) scrollToEl(cusProvEl.value, 'center');
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
          + (wasText ? '\n\n注意：这一家正是现在「作用文字 AI」的那一家，删掉之后 AI 润色 / 拆分 / 助手会改用别家'
            + '（在「文字 AI」那一档重新选一家，或先切过去再回来）。' : ''),
      });
      if (!go) return;
      Api.customDrop(kid);
      if (cusEditing.value === kid) cusReset();
      await afterCustomChanged(kid);
      cusSetMsg('已删掉「' + ((e && e.name) || kid) + '」。', 'ok');
    }
    async function addCus() {
      const t = cusTemplate();
      const isCustom = cusProvSel.value === CUS_CUSTOM;
      if (!t) {
        cusSetMsg(isCustom ? '在「接口形状」里选一套协议（OpenAI 兼容 / H3 兼容…）。' : '在「供应商」里选一家内置平台，或选「自定义」再挑一套接口形状。', 'err');
        return;
      }
      const name = String(cusName.value || '').trim();
      if (!name) { cusSetMsg('写个显示名 —— 型号下拉的分组名与收藏里的筛选项认的就是它。', 'err'); return; }
      const base = String(cusBase.value || '').trim().replace(/\/+$/, '');
      if (!/^https:\/\//i.test(base)) {
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
        prov: isCustom ? '' : cusProvSel.value,
        shapeId: isCustom ? cusShapeSel.value : '',
        base, models,
      });
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
      Api.customSet(list);
      if (t.kind !== 'text') {
        setProvTab(t.kind);
        provSel.set(t.kind, id);
      }
      await afterCustomChanged();
      const wasEditing = cusEditing.value;
      cusReset();
      const via = Api.verifyTarget({ endpoints: t.endpoints });
      cusSetMsg('已' + (wasEditing ? '保存' : '添加') + '「' + name + '」，界面已经切到这一家。'
        + (t.kind === 'text'
          ? '它的密钥 / 地址 / 型号清单都在这一张卡里（要成为默认的那家，点它卡上的「作用文字 AI」，改完自动存进本机；'
            + '地址与型号清单以后用「编辑」改）。'
          : window.provKindZh(t.kind) + '台与素材库的型号下拉里现在都有它。'
            + '要确认地址与密钥通不通，点上面那张卡上的「验证」（问一次' + via.label + '，不建任务、不扣费）。'), 'ok');
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
      if (!/^https:\/\//i.test(base)) { cusSetMsg('先填上面的接口地址（要 https:// 开头），获取型号要用它。', 'err'); return; }
      const key = String(cusKey.value || '').replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '').trim();
      if (!key) { cusSetMsg('先填密钥 —— 型号列表是要鉴权的接口。', 'err'); if (cusKeyEl.value) cusKeyEl.value.focus(); return; }
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

    /* ---------- 文字 AI：型号 + 识图（供应方 / 密钥 / 地址都在供应商卡里） ----------
       取回的型号列表按供应方各存各的；型号与识图也有草稿（切档回来不丢）。
       这一段整体在 textForm 里，而 saveAllNow 在外面 —— 跨这一层只走 textForm 的公开口。 */
    const fetched = new Map();      // providerId → [{id,name}]（本轮内存副本）
    const fetchedOf = p => fetched.get((p && (p.keyId || p.id)) || '') || [];
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
    /* 认家按整份注册表找；同一把 keyId 可能对应两条 provider，优先取**当前这一档**的。 */
    const provByKid = kid => {
      const list = (REG.providers || []);
      const same = list.filter(p => String(p.keyId || p.id) === String(kid));
      if (!same.length) return null;
      return same.find(p => p.kind === provTab) || same[0];
    };
    const kidOf = el => {
      if (!el || !el.dataset) return '';
      const blk = el.closest && el.closest('[data-mblk]');
      return el.dataset.tkid || el.dataset.tmodel || el.dataset.tvision
        || el.dataset.tfetch || el.dataset.ttest || el.dataset.tadd
        || (blk ? blk.dataset.mblk : '');
    };
    const selOf = kid => q('[data-tmodel="' + kid + '"]');
    const msgOf = kid => q('[data-msg="' + kid + '"]');
    const countOf = kid => q('[data-mcount="' + kid + '"]');
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
    function setCount(kid) {
      const el = countOf(kid);
      if (!el) return;
      const p = provByKid(kid);
      if (!p) { el.textContent = '（没认出这一家，刷新一下页面再试）'; return; }
      const list = allModelsOf(p);
      const empty = '还没有型号：点「获取型号列表」问一次它的接口，或在下面自己填一个 id';
      if (!list.length) { el.textContent = empty; return; }
      if (p.kind === 'text') {
        const cur = ((selOf(kid) || {}).value) || '';
        el.textContent = '共 ' + list.length + ' 个 · ' + (cur ? '现在用 ' + cur : '还没选（在下面点一行）');
        return;
      }
      const off = list.filter(x => window.ModelPrefs && ModelPrefs.isOff(p, x.id)).length;
      el.textContent = '共 ' + list.length + ' 个 · 工作台列 ' + (list.length - off) + ' 个' + (off ? ' · 藏着 ' + off + ' 个' : '');
    }
    /* 型号下拉：只显示这一家的型号，按来源分组。keep：明确要选中的那个。 */
    function fillModelOptions(kid, keep) {
      const sel = selOf(kid);
      if (!sel) return;
      const p = provByKid(kid);
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
      if (!list.length) {
        const cur = (msgOf(kid) || {}).textContent || '';
        if (!cur || cur.indexOf('还没有型号') === 0) {
          setMsg(kid, '还没有型号：点「获取型号列表」从它的 /models 拉，或在下面自己填一个（填的只属于这家）。'
            + '型号完全由接口给你，我们不预置一份固定清单。', 'msg');
        }
      }
      const row = sel.closest('.krow');
      if (window.Dropdowns && row) { Dropdowns.build(row); Dropdowns.sync(row); }
    }
    /* 每一行 = 一个型号 + 一个「在工作台上展示」的勾选 +（自己填的那几条）一颗「移除」。
       文字 AI 是单选（点一行 = 全站润色用它），生成三类是多选（勾选 = 出现在工作台下拉里）。 */
    function renderModelRows(kid) {
      const box = q('[data-tchips="' + kid + '"]');
      if (!box) return;
      const p = provByKid(kid);
      if (!p) { box.innerHTML = ''; return; }
      const list = allModelsOf(p);
      const cur = ((selOf(kid) || {}).value) || '';
      if (!list.length) {
        box.innerHTML = '<div class="mlist-empty">这一家一个型号都还没有。'
          + '它有列型号的接口就点上面「获取型号列表」；没有就在上面填一个型号 id —— 我们不会替它编一份清单。</div>';
        return;
      }
      const text = p.kind === 'text';
      box.innerHTML = list.map(x => {
        const id2 = window.esc(x.id);
        const src = x.typed ? '自己填的' : (x.api ? '接口给的' : '本机记的');
        const del = x.typed
          ? '<button class="ghost xs" title="移除这个型号（只清本机记录，平台那边不受影响）"'
            + ' data-tdel="' + id2 + '" data-tkid="' + window.esc(kid) + '">' + ic('close', 10) + '</button>' : '';
        if (text) {
          const on = x.id === cur;
          return '<div class="mlist-row' + (on ? ' pick' : '') + '" role="button" tabindex="0"'
            + ' data-tpick-model="' + id2 + '" data-tkid="' + window.esc(kid) + '"'
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
          + '<input type="checkbox" data-mshow="' + id2 + '" data-tkid="' + window.esc(kid) + '"' + (off ? '' : ' checked') + '>'
          + '<span>' + ((x.name && x.name !== x.id) ? '<b>' + window.esc(x.name) + '</b> ' : '') + '<code>' + id2 + '</code></span>'
          + '</label>'
          + '<span class="mlist-src">' + src + '</span>' + del
          + '</div>';
      }).join('');
    }
    /* 点清单上一行 = 选中这一个（与型号下拉写同一个键 sk_model_<keyId>，两处必须同时动）。 */
    function pickTextModel(kid, id) {
      const p = provByKid(kid);
      const sel = selOf(kid);
      const m = String(id || '');
      if (!p || !sel || !m) return;
      if (![...sel.options].some(o => o.value === m)) {
        setMsg(kid, '这一行不在下拉的选项里（清单与下拉对不上）—— 点「获取型号列表」重新取一次。', 'msg err');
        return;
      }
      if (sel.value === m && modelDraft.get(kid) === m) return;
      sel.value = m;
      modelDraft.set(kid, m);
      renderModelRows(kid);
      setCount(kid);
      refreshVisionTip(kid);
      setMsg(kid, '已选择型号：' + m + '（全站润色都用它；改完就自动存进本机，「测试」会直接用这个）', 'msg');
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
      qa('[data-mblk]').forEach(blk => {
        const kid = blk.dataset.mblk;
        forgetTextOff(provByKid(kid));
        fillModelOptions(kid);
        renderModelRows(kid);
        setCount(kid);
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
    /* 识图能力：自动 / 支持 / 不支持（存 sk_text_vision）。 */
    async function refreshVisionTip(kid) {
      const el = q('[data-vtip="' + kid + '"]');
      if (!el || !window.TextAI) return;
      const seq = ++visionTipSeq;
      const REG2 = REG || { providers: [] };
      const p2 = provByKid(kid);
      if (!p2) { el.textContent = '没认出这一家供应商，识图能力判不了 —— 刷新一下页面再试。'; return; }
      const mdl = ((selOf(kid) || {}).value) || '';
      el.textContent = '正在读取型号能力…';
      let v;
      try { v = await TextAI.visionAsync(REG2, p2, mdl); }
      catch (e) { v = TextAI.vision(REG2, p2, mdl); }
      if (seq !== visionTipSeq) return;
      if (!v.model) {
        el.textContent = '还没选型号，识图能力判不了 —— 先点「获取型号列表」用它自己的 /models 拉一个，'
          + '或在上面的输入框里自己填一个。';
        return;
      }
      el.textContent = v.ok
        ? '当前型号 ' + v.model + '：润色时会带上参考图 / 首尾帧一起发给它（判定依据：' + v.why + '）。'
        : '当前型号 ' + v.model + '：润色时只发文字（判定依据：' + v.why + '）。若该型号确实能识图，把上面选成「支持识图」即可强制启用。';
    }
    const cleanKey = s => String(s == null ? '' : s).replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '').trim();
    const draftOf = kid => draftKey(kid);
    const draftBaseOf = kid => draftBase(kid);
    function useFormCreds(p) {
      if (!p) return '';
      const kid = p.keyId || p.id;
      const raw = cleanKey(draftOf(kid));
      const base = (draftBaseOf(kid) || '').trim();
      TextAI.setFormOverride(p, { key: raw, base });
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
    async function runFetchModels(p, kid) {
      const list = p.kind === 'text' ? await fetchTextModels(p, kid) : await fetchMediaModels(p);
      if (!list.length) throw new Error('接口没有返回型号');
      fetched.set(kid, list);
      if (window.ModelPrefs) ModelPrefs.setGot(p, list);
      renderModelRows(kid);
      setCount(kid);
      fillModelOptions(kid);
      return list;
    }
    const autofetchTried = new Set();
    let autofetchRunning = false;
    async function autofetchModels() {
      if (autofetchRunning) return;
      autofetchRunning = true;
      try {
        for (const blk of qa('[data-mblk]')) {
          const kid = blk.dataset.mblk;
          if (autofetchTried.has(kid)) continue;
          const p = provByKid(kid);
          if (!p || p.kind === 'text') continue;
          if (!(p.endpoints && p.endpoints.models)) continue;
          if (allModelsOf(p).length) { autofetchTried.add(kid); continue; }
          autofetchTried.add(kid);
          try { await runFetchModels(p, kid); } catch (e) { /* 取不到就照旧显示那句提示 */ }
        }
      } finally { autofetchRunning = false; }
    }
    function scheduleAutofetch() {
      if (scheduleAutofetch._busy) return;
      scheduleAutofetch._busy = true;
      setTimeout(() => { scheduleAutofetch._busy = false; autofetchModels(); }, 400);
    }
    async function onProvClick(ev) {
      const row = ev.target.closest('[data-tpick-model]');
      if (row && !ev.target.closest('[data-tdel]')) {
        ev.preventDefault();
        pickTextModel(kidOf(row), row.dataset.tpickModel);
        return;
      }
      const b = ev.target.closest('[data-tfetch],[data-ttest],[data-tadd],[data-tdel]');
      if (!b) return;
      ev.preventDefault();
      const kid = kidOf(b);
      const prov = provByKid(kid);
      if (!prov) {
        setMsg(kid, '没认出「' + kid + '」这一家（注册表可能刚变过，或这家已经被删了）。'
          + '先刷新一下页面再填 —— 宁可不加，也不能把型号写到别家去。', 'msg err');
        return;
      }
      if (b.dataset.tdel != null) {
        const id2 = b.dataset.tdel, sel2 = selOf(kid);
        const was = sel2 && sel2.value === id2;
        TextAI.removeCustom(prov, id2);
        renderModelRows(kid);
        setCount(kid);
        fillModelOptions(kid);
        if (was) refreshVisionTip(kid);
        setMsg(kid, '已移除型号「' + id2 + '」（只清本机记录；接口自己列出的那些不受影响）', 'msg ok');
        return;
      }
      if (b.dataset.tadd != null) {
        const inp = q('[data-tmnew="' + kid + '"]');
        const id2 = ((inp || {}).value || '').trim();
        if (!id2) { if (inp) inp.focus(); return; }
        TextAI.addCustom(prov, id2);
        if (inp) inp.value = '';
        renderModelRows(kid);
        setCount(kid);
        fillModelOptions(kid, id2);
        setMsg(kid, '已添加型号 ' + id2 + '（当场存进本机；只属于「' + (prov.name || '这一家')
          + '」，切到别家不会出现。工作台的型号下拉下一次打开就有它）', 'msg ok');
        refreshVisionTip(kid);
        return;
      }
      if (b.dataset.tfetch != null) {
        const p = prov;
        b.disabled = true; const label0 = b.textContent; b.textContent = '获取中…';
        try {
          const list = await runFetchModels(p, kid);
          const from = (p.kind === 'text' ? (TextAI.base(p) || p.base) : (p.base || '')) || '这一家的默认地址';
          setMsg(kid, '从「' + from + '」获取到 ' + list.length + ' 个型号（只属于「' + p.name + '」），当前选中 ' + (((selOf(kid) || {}).value) || '—'), 'msg ok');
          refreshVisionTip(kid);
          markChanged();
          if (p.kind === 'text') {
            try {
              const v = await TextAI.verifyKey(await Api.registry(), p);
              setMsg(kid, ((msgOf(kid) || {}).textContent || '') + '　|　' + v.text
                + (/OpenRouter|聚合/.test(p.name) ? '（它的型号表公开，所以这一步才有必要）' : ''), 'msg ok');
            } catch (e) { /* 验证失败不拖累取列表 */ }
          }
        } catch (e) {
          const hint = p.kind === 'text' ? ''
            : '（生成平台的型号清单是拿「已经存进本机」的那把密钥去问的：刚贴上去的等顶栏那一句变成「✓ 已存本机」再取一次）';
          setMsg(kid, '获取失败：' + errText(e) + hint, 'msg err');
        }
        finally { b.disabled = false; b.textContent = label0; }
        return;
      }
      if (b.dataset.ttest != null) {
        const p = prov;
        b.disabled = true; const label0 = b.textContent; b.textContent = '测试中…';
        try {
          useFormCreds(p);
          const model = ((selOf(kid) || {}).value) || '';
          if (!model) throw new Error('先在上面选一个型号，或自己填一个');
          if (TextAI.ownsModel && !TextAI.ownsModel(p, model, fetchedOf(p))) {
            throw new Error('「' + model + '」不属于「' + (p.name || '这一家') + '」的型号列表 —— 多半是刚切供应商时留下的旧值，重新选一个或点「获取型号列表」');
          }
          const out = await TextAI.chat(await Api.registry(), '你是助手，回答要极简。', '只回复：ok', { model }, p);
          setMsg(kid, '✓ 测试成功（' + (p.name || '') + ' · ' + model + '）：' + out.slice(0, 60), 'msg ok');
        } catch (e) { setMsg(kid, '✗ 测试失败：' + errText(e), 'msg err'); }
        finally { b.disabled = false; b.textContent = label0; }
      }
    }
    function onProvChange(ev) {
      const cb = ev.target.closest && ev.target.closest('[data-mshow]');
      if (cb) {
        const kid = kidOf(cb), id2 = cb.dataset.mshow;
        const p = provByKid(kid);
        if (!p || !window.ModelPrefs) {
          cb.checked = !cb.checked;
          setMsg(kid, '没认出这一家（注册表可能刚变过）。先刷新页面再勾 —— 藏 / 展示不能写到别家去。', 'msg err');
          return;
        }
        const hide = !cb.checked;
        ModelPrefs.setOff(p, id2, hide);
        const wasCur = ((selOf(kid) || {}).value) === id2;
        renderModelRows(kid);
        setCount(kid);
        fillModelOptions(kid);
        const sel2 = selOf(kid);
        if (sel2) modelDraft.set(kid, sel2.value);
        refreshVisionTip(kid);
        setMsg(kid, (hide ? '已隐藏 ' : '已展示 ') + id2
          + '（当场存进本机' + (hide ? '；这不是删掉，勾回来它就在工作台上了' : '') + '）'
          + (hide && wasCur ? '　|　它原本是这一家选中的型号，下拉已换到清单里的第一个；要把别的那个存成默认，在下面重选一次（选完自动存进本机）' : ''),
          'msg ok');
        return;
      }
      const s = ev.target.closest('[data-tmodel],[data-tvision]');
      if (!s) return;
      const kid = s.dataset.tmodel || s.dataset.tvision;
      if (s.dataset.tvision) { visionDraft.v = s.value; refreshVisionTip(kid); return; }
      modelDraft.set(kid, s.value);
      renderModelRows(kid);
      setCount(kid);
      setMsg(kid, '已选择型号：' + (s.value || '（空）') + '（全站润色都用它；改完就自动存进本机，「测试」会直接用这个）', 'msg');
      refreshVisionTip(kid);
    }
    function initTextForm() {
      textForm = {
        prov: curTextProv, list: textProvList, provByKid, fetchedOf, paint: paintTextCards,
        clearDrafts() { modelDraft.clear(); visionDraft.v = null; },
        flushDrafts(W, Wdel, skipped, domKeys) {
          for (const [kid, m] of modelDraft) {
            if (domKeys && domKeys.has(kid)) continue;
            if (!m) continue;
            const p = provByKid(kid);
            if (p && TextAI.ownsModel && !TextAI.ownsModel(p, m, fetchedOf(p))) { skipped.push('型号「' + m + '」（不属于' + (p.name || '这一家') + '）'); continue; }
            W('sk_model_' + kid, m);
          }
          if (visionDraft.v != null && !q('[data-tvision]')) W('sk_text_vision', visionDraft.v);
        },
      };
      /* textForm 只给这一页自己用（以前还挂过 window.__textForm，全站没有读它的地方）。 */
      if (window.Dropdowns && rootEl.value) Dropdowns.build(rootEl.value);
      if (provListEl.value) {
        provListEl.value.addEventListener('click', onProvClick);
        provListEl.value.addEventListener('change', onProvChange);
      }
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
              : '产物自动存本机已关闭：卡片只留平台地址，地址过期后只能靠「优先用本机文件」之外的手段找回。';
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
        + '没有选时产物会进系统下载文件夹。这一档用浏览器的目录句柄，与下面「本机资产库」（服务端路径，代理写）是两件事。';
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
        btn.title = '这个浏览器不支持选目录（File System Access 只在 Chromium 系可用）';
        why.textContent = '这个浏览器不支持选目录，产物会进系统下载文件夹';
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
        setLibNote('已恢复默认：下一次生成起存到系统「下载」下的 拾帧\\。已经在别的目录里的文件一个都不动。');
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
          : '位置已留空 → 用默认的 下载\\拾帧（下一次生成才落到这里，已经在库里的文件不动）。');
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
      try {
        const th = window.LS.get('dir_theme') || 'light';
        if (top.__sbApplyTheme) top.__sbApplyTheme(th); else document.documentElement.dataset.theme = th;
      } catch (e) {}
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

    /* ---------- 素材库的设置（控件、默认值、文案全部来自 Chars.SET） ---------- */
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
        saveFailed = '本机存储写不进去了，刚才那一项没有保存。先到本页「清理缓存」那一栏的「本地任务记录」'
          + '删掉不用的历史（那一步真的会腾出 localStorage），或删掉素材库里不要的条目；'
          + '腾出来之后再改任何一项都会自动重试。';
        paintSaveState();
        return false;
      }
      const skipped = [];
      /* 先把「本轮改过、但此刻没画出来」的草稿落盘（卡片按类型档过滤渲染）。 */
      const domKeys = new Set(qa('[data-key]').map(i => i.dataset.key));
      for (const [kid, v] of keyDraft) if (!domKeys.has(kid)) W('sk_key_' + kid, v);
      for (const kid of keyCleared) if (!domKeys.has(kid)) Wdel('sk_key_' + kid);
      const domBases = new Set(qa('[data-base]').map(i => i.dataset.base));
      for (const [kid, v] of baseDraft) if (!domBases.has(kid) && v) W('sk_base_' + kid, v);
      if (textForm && textForm.flushDrafts) textForm.flushDrafts(W, Wdel, skipped, domKeys);
      qa('[data-key]').forEach(inp => {
        if (inp.value.trim()) W('sk_key_' + inp.dataset.key, inp.value.trim());
        else Wdel('sk_key_' + inp.dataset.key);
      });
      /* 接口地址：必须以 http(s):// 开头；属于别家官方地址时问一次「仍然保存吗」。 */
      for (const inp of qa('[data-base]')) {
        const v = String(inp.value || '').trim();
        if (!v) { Wdel('sk_base_' + inp.dataset.base); continue; }
        if (!/^https?:\/\//.test(v)) { skipped.push('接口地址（要以 http:// 或 https:// 开头）'); continue; }
        const row = provRows.get(inp.dataset.base);
        const own = row && row.prov ? Api.hostOwner(REG, v, row.prov) : null;
        if (own && own.kind === 'other-provider') {
          const go = await Confirm.ask({
            title: '接口地址与供应商不是一家，仍然保存吗？',
            okLabel: '仍然保存', danger: true,
            sub: '这个地址属于「' + own.name + '」，而供应商是「' + ((row && row.name) || '当前家') + '」。'
              + '用后者的密钥发这个地址，上游多半会以「密钥无效」拒绝。'
              + '如果这是你的中转网关 / 自建代理、且它接受这把密钥，就存下来。',
            body: '选「取消」= 这一项不写盘（其它设置照存，你的输入原样保留）。',
          });
          if (go) W('sk_base_' + inp.dataset.base, v);
          else skipped.push('接口地址（与选中的供应商不是一家）');
        } else W('sk_base_' + inp.dataset.base, v);
      }
      baseDraft.clear();
      keyDraft.clear();
      keyCleared.clear();
      if (textForm && textForm.clearDrafts) textForm.clearDrafts();
      /* 「暂时不用」在这里落盘（表单里其它地方一律不写盘）。 */
      qa('[data-off]').forEach(cb => {
        if (cb.checked) W('sk_off_' + cb.dataset.off, '1');
        else Wdel('sk_off_' + cb.dataset.off);
      });
      /* 侧栏余额勾选：在现有名单上按这一行勾选增删，再顺手剪掉已经不存在的 kid。 */
      if (window.SbBal) {
        const off = new Set(SbBal.off());
        qa('[data-bal]').forEach(cb => { if (cb.checked) off.delete(cb.dataset.bal); else off.add(cb.dataset.bal); });
        const live = new Set((REG.providers || []).map(p => p.keyId || p.id));
        SbBal.setList([...off].filter(k => live.has(k)));
      }
      const tp = textForm ? textForm.prov() : null;
      if (tp) {
        const pickedEl = q('[data-tpick]:checked');
        if (pickedEl && pickedEl.dataset.tpick) W(TextAI.provKey(), pickedEl.dataset.tpick);
        else if (!window.LS.get(TextAI.provKey())) W(TextAI.provKey(), tp.id);
        textPickDraft = '';
        TextAI.setFormOverride(tp, null);
      }
      /* 型号：每张卡上自己那个下拉，存进这一家的 sk_model_<keyId>（不按「当前那一家」筛）。 */
      qa('[data-tmodel]').forEach(sel => {
        const kid = sel.dataset.tmodel, m = sel.value;
        if (!m) return;
        const p = (textForm && textForm.provByKid) ? textForm.provByKid(kid) : null;
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
    const EXPORTABLE = ['sk_key_', 'sk_base_', 'sk_model_', 'sk_off_', 'sk_text_', 'sk_polish_', 'sk_dir_',
      'dir_', 'page_mode_', 'page_size_', 'sk_net_', 'sk_poll_sec', 'wb_split', 'sb_bal_show', 'char_',
      'sk_custom', 'sk_prov_tab', 'sk_local_dir',
      /* AI 助手卡片上那四颗开关：设置页存得进去、导出文件里却没有 —— 换机器导一次设置就全回到默认档。
         刻意不写 'ai_chat_' 前缀：ai_chat（对话记录）与 ai_chat_files / _xy / _watch 是数据与本机窗口的事。 */
      'ai_chat_auto', 'ai_chat_off', 'ai_chat_snap', 'ai_chat_notice', 'ai_chat_dock',
      ...SET_ROWS.filter(r => r.key).map(r => r.key),
      ...((window.UI_PREFS && window.UI_PREFS.keys) ? window.UI_PREFS.keys() : [])
    ];
    const DATA_KEYS = ['char_lib'];
    const isSettingKey = k => !DATA_KEYS.includes(k) && EXPORTABLE.some(p => k === p || k.startsWith(p));
    const RESET_KEEP = ['sk_prov_tab', 'sk_local_dir',
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
        body: '会清掉：平台密钥、文字 AI 接口地址与型号、你「添加自定义供应商」那几家（清单与它们的密钥/停用勾选）、润色指令、分页方式与每页条数、素材库的音色与候选张数那几项、网络超时与轮询间隔、分栏比例、提示词归档目录。\n'
          + '不会清掉：主题、列表视图、各页折叠面板的开合偏好；生成历史、资产、收藏与素材库本身都不受影响。\n'
          + '清空之前会先把当前设置（含密钥）导出一份 JSON 到下载目录，清错了可以用它导回来。' });
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
    async function refreshDataInfo() {
      try {
        const r = await Net.fetch('/data', { timeout: 15000 });
        const d = await r.json();
        const n = (d.files || []).length;
        const kb = (d.files || []).reduce((a, f) => a + f.size, 0);
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
        body: '会用 .data/ 里的数据覆盖浏览器当前数据（设置、历史、收藏、工作区），然后自动刷新页面。\n'
          + '覆盖之前会先把当前数据导出一份整包备份（只含数据、不含本机文件字节）到下载目录，'
          + '恢复错了可以用它导回来。' });
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
          { value: 'all', label: '连本地文件一起导出', hint: '文件会转成 base64 一起打包，体积可能很大（几百 MB）。不含提示词归档 —— 那份另见上一项' },
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
          const nP = (pack.prompts && pack.prompts.files && pack.prompts.files.length) || 0;
          const ok = await Confirm.ask({ title: '导入整包备份？', danger: true, okLabel: '导入并刷新',
            body: '会用备份里的内容覆盖浏览器当前数据（设置、历史、收藏、工作区，以及备份里带的本地文件'
              + (nP ? '，还有 ' + nP + ' 份提示词归档' : '')
              + '），然后自动刷新。' + (nP ? '归档不会覆盖本机已有的同名文件。' : '')
              + '\n覆盖之前会先把当前数据导出一份整包备份（只含数据、不含本机文件字节）到下载目录，'
              + '导错了可以用它导回来。' });
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
    function paintCacheUsage() {
      let total = 0; const rows = [];
      for (const k of window.LS.keys()) {
        const b = (k.length + String(window.LS.get(k) || '').length) * 2;
        total += b; rows.push([k, b]);
      }
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
    function paintPrompt(d) {
      const rows = d.recent || [];
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
      const active = on[0] || null;
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
        await window.WbSkills.setEnabled(id, on);
        skillMsg.value = '✓ ' + (on ? '已启用 ' : '已停用 ') + id + '：下一轮助手请求生效';
        Toast.receipt((on ? '已启用 ' : '已停用 ') + id + '：下一轮助手请求生效');
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
          const s = await window.WbSkills.install(files, { enable: true });
          skillMsg.value = '✓ 已新建 ' + s.id + '（并已启用：同一 contract 上原来那份自动让位）';
          Toast.receipt('已新建 ' + s.id);
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
          const s = await window.WbSkills.importBundle(next, { enable: false });
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
      service: { providerId: '', model: 'whisper-1', baseUrl: '', hasKey: false },
    });
    const asrKey = ref('');
    const asrLocal = ref(null);
    const asrBrowser = ref(null);
    const asrBusy = ref(false);
    const asrMsg = ref('');
    const asrTestText = ref('');
    const asrProvOpts = ref([]);
    const search = reactive({
      enabled: false, provider: 'tavily', maxResults: 5,
      credentialSource: 'channel', channelId: 'deepseek', model: '', baseUrl: '', hasKey: false,
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
    const searchCredText = computed(() => {
      if (search.hasKey) return '已单独存了一把搜索密钥（不会回显）';
      if (search.credentialSource === 'channel') return '用渠道那把密钥：' + (search.channelId || '（还没选）');
      return '还没填密钥';
    });

    function serviceProvOpts() {
      const seen = new Set();
      return (REG.providers || []).filter(p => p.kind === 'text').filter(p => {
        const k = p.keyId || p.id;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).map(p => ({ id: p.id, name: p.name + (p.custom ? '（我的）' : '') }));
    }
    function syncServiceProvs() {
      asrProvOpts.value = serviceProvOpts();
      searchChannelOpts.value = serviceProvOpts();
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
      search.credentialSource, search.channelId, search.model, search.baseUrl, String(searchKey.value || '').trim()]);
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
        asr.service.model = (s.service && s.service.model) || 'whisper-1';
        asr.service.baseUrl = (s.service && s.service.baseUrl) || '';
        asr.service.hasKey = !!(s.service && s.service.hasKey);
        asrKey.value = '';
        asrLocal.value = d.local || null;
        asrMsg.value = '';
        asrSavedSig = asrSig();
      } catch (e) { asrMsg.value = '读不到语音识别设置：' + errText(e); }
      /* 浏览器内模型的状态单独问（/models/status）：它不属于 asr.json，读不到也不影响上面那一组 */
      if (window.Asr && window.Asr.browserStatus) {
        window.Asr.browserStatus()
          .then(st => { asrBrowser.value = st; })
          .catch(() => { asrBrowser.value = null; });
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
        search.provider = s.provider || 'tavily';
        search.maxResults = Number(s.maxResults) || 5;
        search.credentialSource = s.credentialSource || 'channel';
        search.channelId = s.channelId || 'deepseek';
        search.model = s.model || '';
        search.baseUrl = s.baseUrl || '';
        search.hasKey = !!s.hasKey;
        searchKey.value = '';
        searchMsg.value = '';
        searchSavedSig = searchSig();
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
            credentialSource: search.credentialSource, channelId: search.channelId,
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

    /* ---------- 栏目导航与关键词筛选（组锚点 + 命中到行；从 DOM 现读，不手抄标题清单） ---------- */
    let navSig = '';
    let navSubSig = '';
    let navQueued = 0;
    let navRO = null;
    let navMO = null;
    let navScrollQueued = 0;
    let flashTimer = null;
    let settleTimer = 0;
    let curGroup = '';
    let scrollHolding = false;
    /* 这一轮每张卡里命中的行（syncNav 现算一次，卡标题那枚「N 处命中」与二级行都读它）。 */
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
    /* 卡标题里只认文字：命中数那枚 .set-hcnt 是自己塞进去的，读数前先摘掉。 */
    function navTitleOf(c) {
      const h = c.querySelector('h2');
      if (!h) return '（这一栏没有标题）';
      const clone = h.cloneNode(true);
      clone.querySelectorAll('.set-hcnt').forEach(x => x.remove());
      return clone.textContent.trim() || '（这一栏没有标题）';
    }
    function setNavH() {
      if (!setNavEl.value || !rootEl.value) return;
      const h = Math.round(setNavEl.value.getBoundingClientRect().height);
      if (h > 0) rootEl.value.style.setProperty('--setnavh', h + 'px');
    }
    /* 这一页**唯一**的滚动出口（自定义供应商卡、组锚点、二级行、搜索命中行五处都走它）：
       导航是 sticky 的，卡顶要停在导航下面，靠的是 CSS 里那条 scroll-margin-top = --setnavh + 一档间距。
       可是那条只覆盖 `.card / .set-group`，二级行（组内标题那一排）正好在**点下锚点这一刻**
       才冒出来、命中行（.krow / .sub …）根本不带那条 margin —— 按旧高度算出来的位置就差那一截
       （实测停在 263px，导航已经 158px 高）。所以先重测高度再滚，并在滚动落定后补一次校正：
       折叠里那几栏的行是异步补出来的（体检 / 用量 / 清单行），高度会在滚动途中变。
       跳转途中 scrollHolding 挂起滚动跟随（onScrollNav），落定才交还 —— 不然平滑滚动路过
       上一组时，事件会把点完的 curGroup 与二级行改回去，一闪再闪。
       ⚠ 别再在这一页写第二处裸 `scrollIntoView`：那一种滚法不给 sticky 导航让位，也不会补校正。 */
    function scrollToEl(el, block) {
      const root = rootEl.value;
      if (!root || !el) return;
      scrollHolding = true;
      setNavH();
      el.scrollIntoView({ block: block || 'start', behavior: 'smooth' });
      let tries = 0;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(settleJump, 520);
      function settleJump() {
        settleTimer = 0;
        if (!rootEl.value) { scrollHolding = false; return; }
        if (!el.isConnected) { scrollHolding = false; navFollow(); return; }
        setNavH();
        const r = el.getBoundingClientRect(), rr = root.getBoundingClientRect();
        const navH = setNavEl.value ? setNavEl.value.getBoundingClientRect().height : 0;
        const want = block === 'center' ? Math.round(rr.height / 2) : Math.round(navH + 14);
        if (Math.abs((r.top - rr.top) - want) > 10) {
          /* 补校正也是平滑滚，落定再验一遍；最多补三回，用户中途抢滚就不拉扯了。 */
          if (++tries > 3) { scrollHolding = false; navFollow(); return; }
          root.scrollTo({ top: root.scrollTop + (r.top - rr.top) - want, behavior: 'smooth' });
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
    /* 组锚点：一共 5 颗。筛选时芯片后面的数字是这一组命中几行。 */
    function paintChips(secs, groupHits, filtering) {
      if (!setChipsEl.value) return;
      const sig = secs.map(s => s.dataset.group + ':' + (groupHits[s.dataset.group] || 0)).join('|');
      if (sig === navSig) return;
      navSig = sig;
      window.Chips.render(setChipsEl.value, secs.map(s => [s.dataset.group, groupNameOf(s)]), curGroup,
        gid => {
          const sec = secs.find(s => s.dataset.group === gid);
          if (!sec) { Toast.err('这一组刚被移走了，滚一下重画后再试'); return; }
          openFold(sec);
          curGroup = gid;
          paintSubChips(sec);
          paintChipOn();
          scrollToEl(sec);
        },
        {
          cls: 'set-chip',
          count: filtering ? (gid => groupHits[gid] || 0) : null,
          title: gid => {
            const sec = secs.find(s => s.dataset.group === gid);
            return groupNameOf(sec) + '：' + (sec ? cardsOf(sec).map(navTitleOf).join('、') : '');
          },
        });
    }
    /* 二级行：当前这一组的栏目标题（点它滚到那张卡）。 */
    function paintSubChips(sec) {
      const box = setSubEl.value;
      if (!box) return;
      const cards = sec ? cardsOf(sec) : [];
      const filtering = !!(setQ.value || '').trim();
      const sig = (sec ? sec.dataset.group : '-') + '|'
        + cards.map(c => navTitleOf(c) + ':' + (filtering ? (cardHits.get(c) || []).length : 0)).join('|');
      if (sig === navSubSig) return;
      navSubSig = sig;
      if (!cards.length) { box.innerHTML = ''; box.hidden = true; return; }
      box.hidden = false;
      window.Chips.render(box, cards.map((c, i) => [String(i), navTitleOf(c)]), '',
        i => {
          const el = cards[+i];
          if (!el) return;
          if (el.classList.contains('set-off')) { setQ.value = ''; syncNav(); }
          scrollToEl(el);
        },
        { cls: 'set-chip set-chip-sub', count: filtering ? (i => (cardHits.get(cards[+i]) || []).length) : null });
    }
    /* 搜的是这一行里看得见的字（标题、说明、标签、提示），不含输入框里用户自己敲的内容。 */
    const hayOf = c => ((c.textContent || '') + ' '
      + [...c.querySelectorAll('input,textarea,select,button')].map(x => x.placeholder || x.title || '').join(' ')).toLowerCase();
    /* 命中落到**行**上。一行 = 一个 krow / 一张供应商卡 / 一段说明 …
       大盒里套小盒的（供应商卡里面有 krow）只标最里面那一条，免得两层底色叠在一起。
       几个词凑不齐在同一行时退回「含任一个词的行」—— 搜「密钥 同步」这种，别一个命中都不给。 */
    const ROW_SEL = '.krow, .sub, .pb-tip, .prov, .polish-block, .cloud-box, .cloud-row, .sk-item,'
      + ' .ui-note, .cus-acts, .search-hit, .ref, .sk-hint, .mlist-row';
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
    /* 命中也可能落在**没画出来的行**上：「供应商与密钥」那张卡里，语音识别 / 联网搜索两块靠
       分段开关切显隐（v-show），字在 DOM 里、屏幕上没有。按回车滚到那样一行时落点被夹回页面顶，
       用户看见的是「什么都没发生」。口径：计数照实算（那一段确实写着这些字），
       跳转只滚到**画得出来的第一处**，并把另外几行所在的档点名说出去 ——
       不替用户偷偷切档（`sk_prov_tab` 是要落盘的界面偏好，为了跳过去不该改它）。 */
    const painted = el => !!el && el.offsetParent !== null;
    function hitSecName(el) {
      const sec = el.closest ? el.closest('.prov-sec') : null;
      const h = sec && sec.querySelector('.prov-sec-h');
      return h ? h.textContent.replace(/\s+/g, ' ').trim() : '';
    }
    /* 命中的行都在这儿：画得出来的、藏在没打开的档里的，分开数。 */
    function hitSplit() {
      const all = qa('.set-hit');
      return { all, shown: all.filter(painted), hidden: all.filter(el => !painted(el)) };
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
      if (!curGroup || !secs.some(s => s.dataset.group === curGroup)) curGroup = secs.length ? secs[0].dataset.group : '';
      paintChips(secs, groupHits, filtering);
      paintSubChips(secs.find(s => s.dataset.group === curGroup));
      navHasFilter.value = filtering;
      navSumErr.value = filtering && !hitRows;
      const total = navCards().length;
      const split = filtering ? hitSplit() : null;
      const offNames = split ? [...new Set(split.hidden.map(hitSecName).filter(Boolean))] : [];
      navSum.value = !filtering
        ? ('共 ' + secs.length + ' 组 / ' + total + ' 栏 · 点组名跳到那一组，下面那一排是这一组里的栏目；也可以输入关键词直接命中到行')
        : ('「' + terms.join(' ') + '」命中 ' + hitRows + ' 行（在 ' + hitCards + ' / ' + total + ' 栏里）'
          + (hitRows
            ? (split.shown.length
              ? '，按回车跳到第一处；组名后面的数字是这一组命中几行，其余栏目先收起来'
                + (offNames.length ? '（其中 ' + split.hidden.length + ' 行在没打开的一档里：'
                  + offNames.join(' / ') + ' —— 点上面那一档才看得见）' : '')
              : ' —— 这些行都在没打开的一档里：' + offNames.join(' / ') + '，点上面那一档才看得见')
            : ' —— 这一页没有含这些词的行。换个说法试试（密钥 / 地址 / 目录 / 分页 / 润色 / 备份 / 缓存），'
              + '或者问右下角的 AI 助手这一项在哪一栏'));
    }
    function clearNav() {
      setQ.value = '';
      syncNav();
      if (setQEl.value) setQEl.value.focus();
    }
    /* 回车滚到第一处**画得出来的**命中，再短暂亮一下（底色本来就在，闪的是「就是这一行」）。 */
    function gotoFirstHit() {
      const split = hitSplit();
      const first = split.shown[0];
      if (!first) {
        if (split.all.length) {
          const names = [...new Set(split.all.map(hitSecName).filter(Boolean))];
          Toast.warn('这一轮命中的 ' + split.all.length + ' 行都在没打开的一档里：'
            + (names.join(' / ') || '收着的那一段') + '，点上面那一档再跳');
        } else if ((setQ.value || '').trim()) Toast.warn('这一轮没有命中行，改一两个字再试');
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
    /* 滚到哪儿，二级行就跟着换成哪一组的标题（上面那排组锚点也跟着挪亮）。
       判定线要落在「跳转落点」下面：点锚点滚完，组顶正好停在 scroll-margin 那条线
       （spa-settings.css：--setnavh + --sp-14），也就是导航底下 14px。线只加 8px 时
       刚跳到的那组顶永远比线低 6px —— 落定的滚动事件把它判回上一组，二级行与锚点
       高亮要再往下滚一点才翻过来（2026-10-21 报告）。margin 里含导航高，减回去才是
       导航底下的空档；再放宽 12px，兜住 scrollToEl 落定补校正的 ±10 容差。 */
    function activeGroup() {
      const secs = groupEls();
      if (!secs.length) return null;
      const nav = setNavEl.value;
      const navB = nav ? nav.getBoundingClientRect().bottom : 0;
      const navH = nav ? nav.getBoundingClientRect().height : 0;
      const margin = parseFloat(getComputedStyle(secs[0]).scrollMarginTop) || 0;
      const line = navB + Math.max(8, margin - navH + 12);
      let best = secs[0];
      secs.forEach(s => { if (s.getBoundingClientRect().top <= line) best = s; });
      return best;
    }
    function paintChipOn() {
      if (!setChipsEl.value) return;
      [...setChipsEl.value.querySelectorAll('.chip')].forEach(b => b.classList.toggle('on', b.dataset.v === curGroup));
    }
    /* 按当前滚动位置改判一次活动组（滚动事件与程序化跳转落定共用这一份）。 */
    function navFollow() {
      const sec = activeGroup();
      if (!sec || sec.dataset.group === curGroup) return;
      curGroup = sec.dataset.group;
      paintSubChips(sec);
      paintChipOn();
    }
    function onScrollNav() {
      if (navScrollQueued || scrollHolding) return;
      navScrollQueued = requestAnimationFrame(() => {
        navScrollQueued = 0;
        navFollow();
      });
    }
    function setupNav() {
      setNavH();
      if (setNavEl.value && window.ResizeObserver) { navRO = new ResizeObserver(setNavH); navRO.observe(setNavEl.value); }
      window.addEventListener('resize', setNavH);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(setNavH).catch(() => {});
      if (rootEl.value) rootEl.value.addEventListener('scroll', onScrollNav, { passive: true });
      /* 两类变化都要跟着重算：① 某一栏被页面自己临时打开 / 收起（hidden 一变，芯片就该变）；
         ② 栏里的行是异步补出来的（体检、用量、供应商卡、清单行）—— 命中数与底色得跟上。
         自己刚写进去的那几处（.set-nav 里的芯片、卡标题上那枚命中数）不算「页面变了」，否则就是自己勾自己。 */
      try {
        const main = rootEl.value;
        navMO = new MutationObserver(ms => {
          if (!ms.some(x => {
            const t = x.target;
            return !!t && t.nodeType === 1 && !(t.closest && (t.closest('.set-nav') || t.closest('.set-hcnt')));
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
        await window.__spaLoadScript('web/ui/workbench.js', () => window.Wb);
        await window.__spaLoadScript('web/domain/chars.js', () => window.Chars);
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
      renderCharsSet();
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
      loadAsr();
      loadSearch();
      ready.value = true;
      syncNav();
    });
    onBeforeUnmount(() => {
      if (rootEl.value) rootEl.value.removeEventListener('change', onRootChange);
      window.removeEventListener('resize', setNavH);
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
      rootEl, failed, ready,
      setNavEl, setQEl, setChipsEl, setSubEl, setQ, syncNav, onNavKey, navHasFilter, clearNav, navSum, navSumErr,
      saveText, saveKind,
      provTabsEl, provTabView, provSumText, provSumErr, provListEl, openCus,
      cusCardEl, cusShown, cusMineShown, cusMineGroups, cusEditing, editCus, removeCus,
      cusProvEl, cusProvSel, cusProvOpts, onCusProvChange,
      cusShapeEl, cusShapeSel, cusShapeOpts, cusShapeShown, cusShapeHint, onCusShapeChange,
      cusNameEl, cusName, cusBaseEl, cusBase, cusKeyEl, cusKey, cusKeyShown,
      cusExtraEl, cusExtra, rebuildCusModels, cusModelRows, cusOff, onCusModelToggle, cusModelsEmpty,
      cusFetchBusy, fetchCusModels, addCus, cusAddText, cusCancelShown, cancelCus, cusCount, cusMsg, cusMsgCls,
      net,
      pageBoxEl, uiPrefsBoxEl, storePrefsBoxEl, charsBoxEl,
      netBoxEl, storeRowsEl, assistantBoxEl, polishBoxEl, markChanged,
      askNotice, paintNoticeState,
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
      skillItems, skillReady, skillMsg, skillBusy, skillFileEl, skillChipsEl, skillPreEl,
      skillSceneKey, skillMode, skillTree, skillScene, skillSceneNow, skillSceneVars, skillSceneUnknown,
      skillSceneState, isSceneActive, pickSkillScene, openSkillAll, closeSkillAll, skillSceneNameOf,
      skillQ, skillAllQ, skillAllFilter, skillAllFiltered, skillSelId, skillActive,
      skillFiles, skillFilePath, skillFileNote, skillCntText, skillPages,
      paintSkillChips, onSkillSearch, onSkillAllSearch, reloadSkills, toggleSkillOpen, setSkillPreEl,
      openSkillFile, toggleSkillEnabled, pickSkillFile, onImportSkillFile, removeSkill, fmtSkillSize,
      skillForm, openSkillNew, openSkillEdit, saveSkillNew, cancelSkillNew,
      asr, asrKey, asrLocal, asrLocalText, asrBrowser, asrBrowserText, asrBusy, asrMsg, asrTestText, asrProvOpts, asrProvEl,
      loadAsr, saveAsr, clearAsrKey, testAsr,
      search, searchKey, searchBusy, searchMsg, searchTestQ, searchResults, searchTested, searchRead,
      searchChannelOpts, searchChannelEl, searchCredText, saveSearch, clearSearchKey, testSearch, readFirstSearch,
      exportSetup, pickImportSetup, onImportSetupFile, resetSetup, impSetFileEl,
      icGear: ic('gear', 18), icKey: ic('key', 15), icRefresh: ic('refresh', 15), icList: ic('list', 15),
      icSun: ic('sun', 15), icFolder: ic('folder', 15), icUsers: ic('users', 15), icBrain: ic('brain', 15),
      icPencil: ic('pencil', 15), icUpload: ic('upload', 15), icPlus: ic('plus', 13), icClock: ic('clock', 15), icLink: ic('link', 15),
      icLayers: ic('layers', 15), icTrash: ic('trash', 15), icFolderDoc: ic('folderDoc', 15),
      icMic: ic('mic', 15), icSearch: ic('search', 15),
      icEye: ic('eye', 13), icEyeOff: ic('eyeOff', 13),
    };
  },
  render,
};

export default SettingsView;
