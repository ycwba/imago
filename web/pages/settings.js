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
   Confirm.arm 的武装态都与原来完全一致。
   「供应商与密钥」那一块的账号卡流住在 `web/pages/settings/accounts.js`（一张账号一张卡、
   卡顶能力格、卡里的档位行与状态牌、密钥 / 停用 / 文字档那一份草稿、手动档位声明、
   型号面板的槽名、整片重画与事件委托）；这一页留下注册表 / 环境密钥 / 自动保存 / 两条通道的设置 /
   型号面板的读写 / 目录轨，并把它们经 createAccountCards(deps) 递进去。 */
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/settings.js';
import { capZh, capGlyph, createAccountCards } from './settings/accounts.js';

const SAVE_DEBOUNCE_MS = 400;

/* ---------- 声明式清单（分组 + 「一处声明」） ----------
   五组导航：id、顺序、显示名**只写在模板那一节 DOM 上**（`<section data-group>` 里的
   `<h2 class="set-group-h">`，折叠那一组在 `.fold-title` 里）—— 新增一组 = 模板里加一节，
   这里没有第二份名单要抄。
   普通设置行的声明在 ui.js 的 UI_PREFS.setRows（kind 只有 num / check / sel 三种）：
   渲染、自动保存写盘、设置导出、恢复默认、助手可改白名单都从那一份现取。
   **新增一项普通设置 = 在 UI_PREFS.setRows 里加一行**，模板里只留对应的容器
   `<div class="kcols" ref="…BoxEl">`。
   特殊控件（供应商卡 / ASR / 联网搜索 / Skill / 云同步 / 体检 / 用量 / 清理缓存）
   不是「一行一个键」的形状，仍由各自的 renderXxx 画，只在分组里占一个栏位。 */
const SET_ROWS = (window.UI_PREFS && window.UI_PREFS.setRows) || [];

const SettingsView = {
  name: 'SettingsView',
  setup() {
    /* ---------- 容器（全部走 ref；组件里不出现 document.getElementById） ---------- */
    const rootEl = ref(null);
    /* 账号卡片流每次重画 +1：那几个「自动挑哪一家」的读数（识别 / 搜索）靠它重算 ——
       卡流里那份「全部账号」是普通数组，Vue 不会替它做依赖追踪。 */
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
    const cusCapEl = ref(null);
    const cusCapsBoxEl = ref(null);
    const pageBoxEl = ref(null);
    const uiPrefsBoxEl = ref(null);
    const storePrefsBoxEl = ref(null);
    const charsBoxEl = ref(null);
    const netBoxEl = ref(null);
    const storeRowsEl = ref(null);
    const assistantBoxEl = ref(null);
    const polishBoxEl = ref(null);
    const modelBoxEl = ref(null);
    const sysRowsEl = ref(null);
    const usageRowsEl = ref(null);
    const usageGoSlotEl = ref(null);
    const histBoxEl = ref(null);
    const promptRecentEl = ref(null);
    const impAllFileEl = ref(null);
    const impSetFileEl = ref(null);
    const cloudConflictsEl = ref(null);
    const backupListEl = ref(null);

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
    /* 注册表整份换掉只有这一个出口（账号卡流那边通过 regOf() 现读同一份）。 */
    function setREG(d) {
      REG = d && d.providers ? d : { providers: [] };
      return REG;
    }

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

    /* ---------- 添加 / 编辑供应商（一个条目 = 一张账号卡 + 多档能力） ----------
       六档能力同一层级：图片生成 / 视频生成 / 语音合成 / 文字 AI / 语音识别 / 联网搜索。
       每一档各自选接口形状与型号 —— 清单写成 sk_custom 的 caps[]，代理按档各建声明、
       共用同一个 keyId，设置页仍是一张账号卡。 */
    const CUS_KIND_ZH = {
      image: '图片生成', video: '视频生成', audio: '语音合成', text: '文字 AI',
      asr: '语音识别', search: '联网搜索',
    };
    const cusKindZh = id => CUS_KIND_ZH[id] || capZh(id);
    const cusKinds = () => window.provKinds().concat(['asr', 'search']);
    const cusShown = ref(false);
    const cusEditing = ref('');
    const cusName = ref('');
    const cusBase = ref('');
    const cusKey = ref('');
    const cusKeyShown = ref(false);
    const cusMsg = ref('');
    const cusMsgCls = ref('');
    const cusCount = ref('');
    const cusAddText = ref('添加这一家');
    const cusCancelShown = ref(false);
    const cusFetchBusy = ref('');
    const cusMineGroups = ref([]);
    const cusMineShown = ref(false);
    const cusCaps = ref(['image']);          /* 选中的能力（顺序 = 卡片里那一排的顺序） */
    const cusNamePh = ref('例如「我的中转站」');
    /* kind → { shapeId, models:[{id,name,on,vision,audio,video}] } */
    const cusCfg = new Map();
    let cusAutoName = '';
    let cusAutoBase = '';

    function cusFamilies(kind) { return ((REG && REG.interfaceShapes) || {})[kind] || []; }
    const cusProvById = id => (((REG && REG.providers) || []).find(p => p.id === id) || null);
    function cusTplOf(kind) {
      const cfg = cusCfg.get(kind);
      const fam = cusFamilies(kind).find(f => f.id === (cfg && cfg.shapeId)) || cusFamilies(kind)[0];
      return fam ? cusProvById(fam.template) : null;
    }
    function cusDefaultModels(kind, shapeId) {
      const fams = cusFamilies(kind);
      const fam = fams.find(f => f.id === shapeId) || fams[0];
      const tpl = fam ? cusProvById(fam.template) : null;
      if (!tpl) return [];
      if (kind === 'asr' || kind === 'search') {
        const decl = tpl[kind] || {};
        const ids = Array.isArray(decl.models) ? decl.models.map(m => (m && m.id) || m) : [];
        if (!ids.length && decl.model) ids.push(decl.model);
        return [...new Set(ids.map(String).filter(Boolean))].map(id => ({ id, name: '', on: true }));
      }
      return [...new Set(((tpl.models || []).map(m => m && m.id).filter(Boolean)).map(String))]
        .map(id => ({ id, name: '', on: true }));
    }
    function cusCfgOf(kind) {
      let c = cusCfg.get(kind);
      if (!c) {
        const shapeId = (cusFamilies(kind)[0] || {}).id || '';
        c = { shapeId, models: cusDefaultModels(kind, shapeId) };
        cusCfg.set(kind, c);
      }
      return c;
    }
    function cusSetMsg(text, cls) { cusMsg.value = text || ''; cusMsgCls.value = cls || ''; }

    /* 只认新形状：启动时 `migrateProviderStorage` 已把旧条目抬成 caps[]。 */
    function cusCapsOfEntry(e) {
      return (e && Array.isArray(e.caps)) ? e.caps : [];
    }
    function loadCusEntry(e) {
      cusCaps.value = [];
      cusCfg.clear();
      cusCapsOfEntry(e).forEach(cap => {
        const kind = String((cap && cap.kind) || '');
        if (cusKinds().indexOf(kind) < 0 || cusCaps.value.indexOf(kind) >= 0) return;
        cusCaps.value.push(kind);
        const fams = cusFamilies(kind);
        const shapeId = (cap.shapeId && fams.some(f => f.id === cap.shapeId)) ? cap.shapeId
          : ((fams.find(f => f.template === cap.shape) || {}).id || (fams[0] || {}).id || '');
        const cfg = { shapeId, models: [] };
        const defaults = cusDefaultModels(kind, shapeId);
        const byId = new Map(defaults.map(m => [m.id, m]));
        (cap.models || []).forEach(m => {
          const id = String((m && m.id) || (typeof m === 'string' ? m : '') || '').trim();
          if (!id) return;
          cfg.models.push({ id, name: String((m && m.name) || ''), on: true,
            vision: m && m.vision, audio: m && m.audio, video: m && m.video,
            _default: byId.has(id) });
        });
        cusCfg.set(kind, cfg);
      });
      if (!cusCaps.value.length) { cusCaps.value = ['image']; cusCfgOf('image'); }
    }
    /* 显示名预填：按第一类自动编号（「图片生成 1 / 视频生成 2」这种），换类型跟着换，用户改过就不再动。 */
    function cusDefaultName() {
      const kind = cusCaps.value[0] || 'image';
      const zh = cusKindZh(kind);
      const taken = new Set(Api.customList().filter(e => {
        const caps = cusCapsOfEntry(e);
        return caps.length && caps[0].kind === kind;
      }).map(e => (e.name || '').trim()));
      for (let i = 1; i < 200; i++) { const n = i === 1 ? zh : zh + ' ' + i; if (!taken.has(n)) return n; }
      return zh;
    }
    function cusFillName() { cusAutoName = cusDefaultName(); cusName.value = cusAutoName; }
    function cusSyncName() {
      if (cusEditing.value) return;
      const cur = String(cusName.value || '').trim();
      if (!cur || cur === cusAutoName) cusFillName();
    }
    function cusFillBase() {
      const t = cusTplOf(cusCaps.value[0] || 'image');
      cusAutoBase = (t && t.base) || '';
      cusBase.value = cusAutoBase;
    }
    function cusSyncBase() {
      const cur = String(cusBase.value || '').trim();
      if (!cur || cur === cusAutoBase) cusFillBase();
    }
    function paintCusCount() {
      if (!cusCount) return;
      const chosen = cusCaps.value.map(cusKindZh).join(' + ') || '还没选类型';
      cusCount.value = chosen + ' · 合计已接 ' + Api.customList().filter(e => cusCapsOfEntry(e).length).length + ' 家';
    }
    /* 「已添加的几家」：按第一类分组、全部列出来；一行里把它会做的几类都念出来。 */
    function paintCusMine() {
      /* 搬迁之后这里只剩真正的供应商条目（keyId-only 的补能力条目不在这一列里）。 */
      const list = Api.customList().filter(e => e && !e.keyId && e.id && cusCapsOfEntry(e).length);
      cusMineShown.value = !!list.length;
      const cusGroupOf = e => { const caps = cusCapsOfEntry(e); return (caps[0] && caps[0].kind) || 'image'; };
      const kinds = cusKinds();
      const extra = [...new Set(list.map(cusGroupOf))].filter(k => kinds.indexOf(k) < 0);
      cusMineGroups.value = kinds.concat(extra).map(k => {
        const mine = list.filter(e => cusGroupOf(e) === k);
        return {
          kind: k, zh: k === 'text' ? '文字 AI' : cusKindZh(k),
          items: mine.map(e => ({
            id: e.id,
            name: e.name || e.id,
            capsZh: cusCapsOfEntry(e).map(c => cusKindZh(c && c.kind)).join(' / '),
            modelsN: cusCapsOfEntry(e).reduce((n, c) => n + ((c && c.models) || []).length, 0),
          })),
        };
      }).filter(g => g.items.length);
    }
    function openCus() {
      cusShown.value = true;
      if (cusEditing.value) cusReset();
      renderCus();
      nextTick(() => {
        /* 表单是固定浮层，不需要把文档滚过来；把光标放在该填的那一格。 */
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
    function renderCus() {
      paintCusCaps();
      paintCusNamePh();
      paintCusCount();
      paintCusMine();
      cusSyncBase();
      cusSyncName();
      paintCusCapBlocks();
    }
    /* 能力那一排：**可多选**，六档平级（图片 / 视频 / 语音 / 文字 / 识别 / 搜索）。
       选中一档就在下面画那一档的接口形状与型号；不再把识别 / 搜索当文字档的开关。 */
    function paintCusCaps() {
      const el = cusCapEl.value;
      if (!el) return;
      el.innerHTML = cusKinds().map(c => {
        const on = cusCaps.value.indexOf(c) >= 0;
        return '<button class="capcell' + (on ? ' on main' : '') + '" type="button"'
          + ' data-cuscap="' + window.esc(c) + '" title="' + window.esc(cusKindZh(c) + (on ? ' · 已选' : ' · 点一下选上')) + '">'
          + capGlyph(c) + '</button>';
      }).join('') + '<span class="hint">可多选 · 六档能力平级</span>';
    }
    function pickCusCap(cap) {
      if (cusKinds().indexOf(cap) < 0) return;
      if (cusCaps.value.indexOf(cap) >= 0) {
        if (cusCaps.value.length === 1) { cusSetMsg('至少要留一档能力。', 'err'); return; }
        cusCaps.value = cusCaps.value.filter(k => k !== cap);
        cusCfg.delete(cap);
      } else {
        cusCaps.value = cusCaps.value.concat([cap]);
        cusCfgOf(cap);
      }
      renderCus();
    }
    function paintCusNamePh() { cusNamePh.value = '例如「我的中转站」'; }
    /* 每一档的配置块：接口形状 · 型号清单 ·（文字档）每行能收的输入。 */
    function capBlockHTML(kind) {
      const cfg = cusCfgOf(kind);
      const es = window.esc(kind);
      const fams = cusFamilies(kind);
      const shapeOpts = fams.length
        ? fams.map(f => '<option value="' + window.esc(f.id) + '"' + (f.id === cfg.shapeId ? ' selected' : '') + '>'
          + window.esc(f.name) + '</option>').join('')
        : '<option value="">这一档还没有登记接口形状</option>';
      const rows = cfg.models.map(m => {
        const id = window.esc(m.id);
        if (kind !== 'text') {
          return '<label class="cfg-model"><input type="checkbox" data-cfg-model="' + id + '" data-cfg-kind="' + es + '"'
            + (m.on ? ' checked' : '') + '><span><code>' + id + '</code>'
            + (m.name && m.name !== m.id ? ' <i>' + window.esc(m.name) + '</i>' : '') + '</span></label>';
        }
        const mediaTagOf = (field, zh) => {
          const v = m[field];
          const cls = v === true ? ' on' : v === false ? ' off' : '';
          const tip = v === true ? '已声明支持' + zh + '输入（点一下改为不支持）'
            : v === false ? '已声明不支持' + zh + '输入（点一下改回自动）'
              : '自动判断' + zh + '输入（点一下声明支持）';
          return '<button class="med-tag' + cls + '" type="button" data-cfg-med="' + field + '"'
            + ' data-cfg-kind="' + es + '" data-cfg-id="' + id + '" title="' + window.esc(tip) + '">' + zh + '</button>';
        };
        return '<label class="cfg-model cfg-model-text"><input type="checkbox" data-cfg-model="' + id + '" data-cfg-kind="' + es + '"'
          + (m.on ? ' checked' : '') + '><span><code>' + id + '</code>'
          + (m.name && m.name !== m.id ? ' <i>' + window.esc(m.name) + '</i>' : '') + '</span>'
          + '<span class="med-tags"><span class="med-tag fixed" title="文字输入始终支持">字</span>'
          + mediaTagOf('vision', '图') + mediaTagOf('audio', '音') + mediaTagOf('video', '视') + '</span></label>';
      }).join('');
      return '<section class="capcfg" data-capcfg="' + es + '">'
        + '<header class="capcfg-h"><span class="cg">' + capGlyph(kind) + '</span>'
          + '<b>' + window.esc(cusKindZh(kind)) + '</b><span class="sp"></span>'
          + '<button class="ghost mini" type="button" data-cfg-del="' + es + '" title="移除这一档">移除</button></header>'
        + '<div class="krow thin"><span class="kn">接口形状</span>'
          + '<select data-cfg-shape="' + es + '">' + shapeOpts + '</select></div>'
        + '<div class="krow thin align-start"><span class="kn">型号</span>'
          + '<div class="cfg-models">' + (rows || '<span class="hint sm">还没有型号：下面填 id 或点「取一次」。</span>') + '</div></div>'
        + '<div class="krow thin"><span class="kn">添加型号</span>'
          + '<input data-cfg-new="' + es + '" placeholder="型号 id，逗号分隔多个">'
          + '<button class="ghost mini" type="button" data-cfg-add="' + es + '">添加</button>'
          + ((kind === 'asr' || kind === 'search') ? ''
            : '<button class="ghost mini" type="button" data-cfg-fetch="' + es + '"'
              + (cusFetchBusy.value === kind ? ' disabled' : '') + '>' + (cusFetchBusy.value === kind ? '获取中…' : '取一次') + '</button>')
          + '</div>'
        + '<div class="msg" data-cfg-msg="' + es + '"></div>'
        + '</section>';
    }
    function paintCusCapBlocks() {
      const el = cusCapsBoxEl.value;
      if (!el) return;
      el.innerHTML = cusCaps.value.map(capBlockHTML).join('');
    }
    function cusCfgMsg(kind, text, cls) {
      const el = cusCapsBoxEl.value && cusCapsBoxEl.value.querySelector('[data-cfg-msg="' + window.esc(kind) + '"]');
      if (!el) { cusSetMsg(text, cls); return; }
      el.className = 'msg ' + (cls || '');
      el.textContent = text;
    }
    function cusAddIds(kind, raw) {
      const cfg = cusCfgOf(kind);
      const ids = String(raw || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
      if (!ids.length) return 0;
      ids.forEach(id => {
        if (!cfg.models.some(m => m.id === id)) cfg.models.push({ id, name: '', on: true });
      });
      paintCusCapBlocks();
      return ids.length;
    }
    async function fetchCusModelsFor(kind, btn) {
      if (kind === 'asr' || kind === 'search') {
        cusCfgMsg(kind, '这一档没有型号清单接口：直接在下面添加型号。', '');
        return;
      }
      const t = cusTplOf(kind);
      if (!t) { cusCfgMsg(kind, '先选一个「接口形状」。', 'err'); return; }
      const base = String(cusBase.value || '').trim().replace(/\/+$/, '');
      if (!httpsBaseOk(base)) { cusCfgMsg(kind, '先填接口地址（要 https:// 开头）。', 'err'); return; }
      const key = String(cusKey.value || '').replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '').trim();
      if (!key) { cusCfgMsg(kind, '先填密钥。', 'err'); if (cusKeyEl.value) window.focusQuiet(cusKeyEl.value); return; }
      cusFetchBusy.value = kind;
      if (btn) { btn.disabled = true; btn.textContent = '获取中…'; }
      try {
        const r = await Net.fetch('/custom/models', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shape: t.id, base, key }), timeout: 25000, retry: 0,
        });
        let d = {};
        try { d = (await r.json()) || {}; } catch (e) { throw new Error('代理没有返回 JSON（HTTP ' + r.status + '）'); }
        const list = Array.isArray(d.models) ? d.models : [];
        if (!list.length) throw new Error(d.error || ('它没有返回型号列表（HTTP ' + r.status + '）'));
        const cfg = cusCfgOf(kind);
        list.forEach(m => {
          const id = String((m && (m.id || m.name)) || '').trim();
          if (!id) return;
          const hit = cfg.models.find(x => x.id === id);
          if (hit) { if (!hit.name) hit.name = String((m && m.name) || ''); }
          else cfg.models.push({ id, name: String((m && m.name) || ''), on: true });
        });
        paintCusCapBlocks();
        cusCfgMsg(kind, '从「' + (d.from || base) + '」拿到 ' + list.length + ' 个型号，已全部勾上。', 'ok');
      } catch (e) { cusCfgMsg(kind, '获取失败：' + errText(e), 'err'); }
      finally {
        cusFetchBusy.value = '';
        if (btn) { btn.disabled = false; btn.textContent = '取一次'; }
      }
    }
    function cusCycleMedia(kind, id, field) {
      const cfg = cusCfgOf(kind);
      const m = cfg.models.find(x => x.id === id);
      if (!m) return;
      const cur = m[field];
      m[field] = cur === undefined ? true : cur === true ? false : undefined;
      paintCusCapBlocks();
    }
    let cusWired = false;
    function initCusForm() {
      if (cusWired) return;
      cusWired = true;
      /* 类型那一排的点击由账号卡流的委托（provListEl 上的 [data-cuscap]）接住 ——
         表单被搬进那张卡里，不要再绑第二份：两个 handler 各 toggle 一次等于没点。 */
      if (!cusCapsBoxEl.value) return;
      cusCapsBoxEl.value.addEventListener('click', ev => {
        const t = ev.target;
        const rm = t.closest && t.closest('[data-cfg-del]');
        if (rm) { ev.preventDefault(); pickCusCap(rm.dataset.cfgDel); return; }
        const add = t.closest && t.closest('[data-cfg-add]');
        if (add) {
          ev.preventDefault();
          const kind = add.dataset.cfgAdd;
          const inp = cusCapsBoxEl.value.querySelector('[data-cfg-new="' + window.esc(kind) + '"]');
          const n = cusAddIds(kind, (inp || {}).value || '');
          if (n && inp) inp.value = '';
          return;
        }
        const ft = t.closest && t.closest('[data-cfg-fetch]');
        if (ft) { ev.preventDefault(); fetchCusModelsFor(ft.dataset.cfgFetch, ft); return; }
        const med = t.closest && t.closest('[data-cfg-med]');
        if (med) { ev.preventDefault(); cusCycleMedia(med.dataset.cfgKind, med.dataset.cfgId, med.dataset.cfgMed); return; }
      });
      cusCapsBoxEl.value.addEventListener('change', ev => {
        const t = ev.target;
        const sh = t.closest && t.closest('[data-cfg-shape]');
        if (sh) {
          const cfg = cusCfgOf(sh.dataset.cfgShape);
          cfg.shapeId = sh.value;
          cfg.models = cusDefaultModels(sh.dataset.cfgShape, cfg.shapeId);
          paintCusCapBlocks();
          return;
        }
        const m = t.closest && t.closest('[data-cfg-model]');
        if (m) { const cfg = cusCfgOf(m.dataset.cfgKind); const hit = cfg.models.find(x => x.id === m.dataset.cfgModel); if (hit) hit.on = !!m.checked; paintCusCount(); return; }
      });
      cusCapsBoxEl.value.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter') return;
        const inp = ev.target.closest && ev.target.closest('[data-cfg-new]');
        if (!inp) return;
        ev.preventDefault();
        const kind = inp.dataset.cfgNew;
        const n = cusAddIds(kind, inp.value);
        if (n) inp.value = '';
      });
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
    function cusReset() {
      cusEditing.value = '';
      cusAddText.value = '添加这一家';
      cusCancelShown.value = false;
      cusName.value = ''; cusBase.value = ''; cusKey.value = '';
      cusAutoName = '';
      cusAutoBase = '';
      cusCaps.value = ['image'];
      cusCfg.clear();
      cusCfgOf('image');
      renderCus();
    }
    async function editCus(kid) {
      const e = Api.customList().find(x => x && x.id === kid);
      if (!e) { acctMsg(kid, '清单里找不到这一条，刷新一次页面。', 'err'); return; }
      loadCusEntry(e);
      cusShown.value = true;
      /* 「哪一张卡里有这一格」要重画网格才知道：添加卡里那个落点是 cusShown 变了才画出来的。 */
      renderProv();
      cusEditing.value = kid;
      cusAutoName = '';
      cusAutoBase = '';
      cusName.value = e.name || '';
      cusBase.value = e.base || '';
      cusKey.value = keyFor(kid);
      cusAddText.value = '保存这一家';
      cusCancelShown.value = true;
      renderCus();
      cusSetMsg('正在改「' + (e.name || kid) + '」。', '');
      nextTick(() => { if (cusNameEl.value) window.focusQuiet(cusNameEl.value); });
    }
    async function removeCus(kid) {
      const e = Api.customList().find(x => x && x.id === kid);
      const wasText = (() => { try { return curTextId() === kid; } catch (err) { return false; } })();
      const go = await Confirm.ask({
        title: '删掉这一家？', danger: true, okLabel: '删除',
        sub: '删掉「' + ((e && e.name) || kid) + '」，连它名下的密钥、型号选择与「暂时不用」勾选一起清。',
        body: '重新添加同一家网关要重填密钥。'
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
      const name = String(cusName.value || '').trim();
      if (!name) { cusSetMsg('写个显示名', 'err'); return; }
      const base = String(cusBase.value || '').trim().replace(/\/+$/, '');
      if (!httpsBaseOk(base)) {
        cusSetMsg('地址要以 https:// 开头。', 'err');
        return;
      }
      const caps = [];
      for (const kind of cusCaps.value) {
        const cfg = cusCfgOf(kind);
        const fams = cusFamilies(kind);
        const fam = fams.find(f => f.id === cfg.shapeId) || fams[0];
        if (!fam) { cusSetMsg('「' + cusKindZh(kind) + '」没有可用的接口形状。', 'err'); return; }
        const tpl = cusProvById(fam.template);
        if (!tpl) { cusSetMsg('找不到「' + fam.name + '」对应的模板声明。', 'err'); return; }
        if (kind === 'asr' || kind === 'search') {
          if (!tpl[kind] || (tpl.extraCaps || []).indexOf(kind) < 0) {
            cusSetMsg('「' + fam.name + '」没有声明' + cusKindZh(kind) + '，换一个接口形状。', 'err');
            return;
          }
        } else if (tpl.kind !== kind) {
          cusSetMsg('「' + fam.name + '」不是' + cusKindZh(kind) + '那一类。', 'err');
          return;
        }
        const models = cfg.models.filter(m => m.on && m.id).map(m => {
          const one = { id: m.id };
          if (m.name && m.name !== m.id) one.name = m.name;
          ['vision', 'audio', 'video'].forEach(k => { if (m[k] !== undefined) one[k] = !!m[k]; });
          return one;
        });
        if (!models.length && kind !== 'asr' && kind !== 'search') { cusSetMsg('「' + cusKindZh(kind) + '」至少加一个型号。', 'err'); return; }
        const clash = Api.hostOwner(REG, base, tpl);
        if (clash && clash.kind === 'other-provider' && !clash.custom) {
          cusSetMsg('这个地址是「' + clash.name + '」的官方地址，接口形状要换成它自己那一档。', 'err');
          return;
        }
        caps.push({ kind, shape: tpl.id, shapeId: fam.id, models });
      }
      if (!caps.length) { cusSetMsg('至少选一档能力。', 'err'); return; }
      const id = cusEditing.value || Api.customId();
      const beforeCaps = cusEditing.value
        ? cusCapsOfEntry(Api.customList().find(e => e && e.id === id) || {}) : [];
      const list = Api.customList().filter(e => e && e.id !== id);
      list.push({ id, name, base, caps });
      const key = String(cusKey.value || '').replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '').trim();
      /* 先落密钥、再落那份清单：密钥这一格写不进去（配额满 / 隐私模式）时当场收工，
         不会出现「卡片说已添加、下一次调用才发现根本没有密钥」。写盘走 `window.LS`
         （本机存储的唯一包装），它把「写不进去」变成 false 而不是一条控制台红字。 */
      let keySaved = true;
      if (key) keySaved = window.LS.set('sk_key_' + id, key);
      else if (cusEditing.value) keySaved = window.LS.del('sk_key_' + id);
      if (!keySaved) {
        cusSetMsg('「' + name + '」没有保存：本机存储写不进密钥这一格，先清一次缓存再重填。', 'err');
        return;
      }
      /* 清单这一格写不进去（配额满 / 隐私模式）时当场收工，顺手把刚写进去的密钥摘掉
         —— 留下一把没人认领的 sk_key_<id>，它会跟着导出 / 云同步跑到别的机器上。 */
      if (!Api.customSet(list)) {
        window.LS.del('sk_key_' + id);
        cusSetMsg('「' + name + '」没有保存：本机存储写不进清单这一格，先清一次缓存再重试。', 'err');
        return;
      }
      /* 编辑时删掉的那几类：把它们的型号偏好槽一起摘掉，免得下次加回同一类时旧清单又冒出来。 */
      if (window.ModelPrefs && window.ModelPrefs.dropKind) {
        beforeCaps.forEach(c => {
          if (caps.every(x => x.kind !== c.kind)) window.ModelPrefs.dropKind(id, c.kind);
        });
      }
      await afterCustomChanged();
      const wasEditing = cusEditing.value;
      cusReset();
      /* 加完 / 存完就收起来（回到「预设」形态）：这张卡平时是清单，展开只是临时填一填。
         回执走 Toast —— 收起之后表单里那一行字没人看得见。 */
      cusShown.value = false;
      renderProv();
      Toast.receipt('已' + (wasEditing ? '保存' : '添加') + '「' + name + '」（'
        + caps.map(c => cusKindZh(c.kind)).join(' / ') + '）。', 'ok');
    }
    function cancelCus() {
      const n = cusEditing.value;
      cusReset();
      cusSetMsg(n ? '已取消编辑。' : '', '');
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
        : saveSkipped ? '这几项没写进去：' + saveSkipped
        : savePending ? '正在存进本机…'
        : fresh ? '✓ 已存本机'
        : '改一项就自动存本机';
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
    /* ---------- 旧供应商数据的最后一次搬迁 ----------
       旧版本有两条落盘形状：一条只有 `kind + shape + models`，以及「给已有账号补识别 / 搜索」
       的 `keyId + extras[]`。新实现只认 `caps[]`，启动时一次性把两者转过来，随后删掉
       更老的 `sk_caps_<keyId>`（那一份连型号都没有，已无法还原成可用声明）。
       搬迁失败不抛：下一次启动再试，界面上按空清单画，不拿旧形状当第二套真相。 */
    function migrateProviderStorage() {
      let changed = false;
      try {
        window.LS.keys().filter(k => k.indexOf('sk_caps_') === 0).forEach(k => {
          window.LS.del(k);
          /* 这一枚也可能是服务器镜像里的旧键：只删本机的话，下次开机 DataSync 又把它拉回来。 */
          try {
            if (window.Net && Net.fetch) {
              Net.fetch('/data/' + encodeURIComponent(k) + '?nobak=1', { method: 'DELETE', timeout: 8000, retry: 0 })
                .catch(() => {});
            }
          } catch (e) { /* 镜像删不掉下次启动会再清一遍，不拦本机这次搬迁 */ }
          changed = true;
        });
        const list = Api.customList();
        let dirty = false;
        list.forEach(e => {
          if (!e || typeof e !== 'object') return;
          if (Array.isArray(e.caps) && e.caps.length) {
            let changedCaps = false;
            const next = [];
            e.caps.forEach(c => {
              if (!c || typeof c !== 'object') return;
              const kind = String(c.kind || '');
              if (kind === 'text' && (c.asr || c.search)) {
                const textCap = { ...c };
                delete textCap.asr; delete textCap.search;
                next.push(textCap);
                ['asr', 'search'].forEach(field => {
                  if (!c[field]) return;
                  const from = String((c[field] && c[field].from) || '');
                  const fams = cusFamilies(field);
                  const shapeId = (fams.find(f => f.template === from) || {}).id || '';
                  next.push({ kind: field, shape: from, shapeId, models: cusDefaultModels(field, shapeId) });
                });
                changedCaps = true;
              } else next.push(c);
            });
            if (changedCaps) { e.caps = next; dirty = true; }
            if ('extras' in e) { delete e.extras; dirty = true; }
            return;
          }
          const caps = [];
          if (e.kind && e.shape) {
            caps.push({ kind: e.kind, shape: e.shape, shapeId: e.shapeId || '', models: e.models || [] });
          }
          if (Array.isArray(e.extras)) {
            e.extras.forEach(x => {
              const kind = String((x && x.kind) || '');
              if (kind !== 'asr' && kind !== 'search') return;
              const from = String((x && x.from) || '');
              const fams = cusFamilies(kind);
              const shapeId = (fams.find(f => f.template === from) || {}).id || '';
              caps.push({ kind, shape: from, shapeId, models: cusDefaultModels(kind, shapeId) });
            });
          }
          if (!caps.length) return;
          e.caps = caps;
          delete e.kind; delete e.shape; delete e.shapeId; delete e.models; delete e.extras;
          dirty = true;
        });
        if (dirty) { Api.customSet(list); changed = true; }
      } catch (e) { /* 搬迁不成功就照空清单画，下一次启动再试 */ }
      return changed;
    }
    async function loadReg() {
      try { setREG(await Api.registry()); } catch (e) { setREG(null); }
      if (window.Api) Api.setRegistry(REG);
      try { envInfo = (window.Api && Api.envStatus) ? await Api.envStatus() : {}; } catch (e) { envInfo = {}; }
      const migrated = migrateProviderStorage();
      if (migrated) {
        try { Api.clearCaches(); setREG(await Api.registry()); } catch (e) { /* 刷新失败：下一次进设置页再来 */ }
        if (window.Api) Api.setRegistry(REG);
      }
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
      else if (p && !p.serviceOnly && p.endpoints && p.endpoints.models && slotCap(slot) !== 'asr' && slotCap(slot) !== 'search') { el.className = 'st alt'; el.textContent = '还没取过'; }
      else { el.className = 'st off'; el.textContent = '这一档没有型号接口'; }
      const btn = q('[data-tfetch="' + window.esc(slot) + '"]');
      if (btn) btn.textContent = f.state === 'busy' ? '取回中…' : '取一次型号清单';
      const note = noteOf(slot);
      if (note) {
        const p2 = provBySlot(slot);
        const n = p2 ? allModelsOf(p2).length : 0;
        const vis = p2 ? allModelsOf(p2).filter(x => !(window.ModelPrefs && ModelPrefs.isOff(p2, x.id))).length : 0;
        const text = slotCap(slot) === 'text' && !!(p2 && p2.kind === 'text' && !p2.serviceOnly);
        note.textContent = '共 ' + n + ' 个 · ' + (text ? '全站润色在用那一个'
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
      /* 型号清单还要过这一条自己的 modelsFilter / modelsExclude（与代理、TextAI 同一套判据）：
         MiMo 的文字档排掉 -tts、语音档只留 -tts；旧数据里混进来的另一类型号也在这里被挡住。 */
      const modelAllowed = id => (window.TextAI && TextAI.modelAllowed) ? TextAI.modelAllowed(p, id) : true;
      const put = (id, name, api) => {
        const s = String(id || '').trim();
        if (!s || skip(s) || !modelAllowed(s)) return;
        const cur = map.get(s);
        if (cur) { if (!cur.name && name) cur.name = String(name).trim(); cur.api = cur.api || api; }
        else map.set(s, { id: s, name: String(name || '').trim(), api, typed: false });
      };
      const prefs = (window.ModelPrefs && p) ? ModelPrefs.of(p) : { typed: [], off: [], got: [] };
      const svc = !!(p && (p.modelKind === 'asr' || p.modelKind === 'search'));
      const ownModels = svc && !p.serviceOnly
        ? ((p.serviceModels && p.serviceModels[p.modelKind]) || [])
        : ((p && p.models) || []);
      (prefs.got || []).forEach(m => put(m && (m.id || m), (m && m.name) || '', true));
      fetchedOf(p).forEach(m => put(m && (m.id || m), (m && m.name) || '', true));
      ownModels.forEach(m => put(m && (m.id || m), (m && m.name) || '', true));
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
      if (!p) { el.textContent = '—'; el.title = '没认出这一家，刷新一次页面'; return; }
      const list = allModelsOf(p);
      const shown = list.filter(x => !(window.ModelPrefs && ModelPrefs.isOff(p, x.id))).length;
      el.textContent = shown + '/' + list.length;
      el.title = '下拉里列 ' + shown + ' 个 · 一共知道 ' + list.length + ' 个';
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
      const box = q('[data-tchips="' + window.esc(slot) + '"]');
      if (!box) return;
      /* 那一格清单自己滚（`.mlist` 有 max-height）：整排行是 innerHTML 换掉的，滚动位会被夹回 0 ——
         勾一条「展示 / 隐藏」、点一行选文字型号、移除一条自己填的，清单就弹回第一条。
         容器没被换掉（换的是它的子节点），所以点名 box 自己就够，公共件按行的下标还位。 */
      window.Wb.viewport.keep(box, () => fillModelRows(box, slot));
    }
    function fillModelRows(box, slot) {
      const kid = slotKid(slot);
      const p = provBySlot(slot);
      if (!p) { box.innerHTML = ''; return; }
      const list = allModelsOf(p);
      const cur = ((selOf(kid) || {}).value) || '';
      if (!list.length) {
        box.innerHTML = '<div class="mlist-empty">还没有型号。</div>';
        return;
      }
      const text = slotCap(slot) === 'text' && p.kind === 'text' && !p.serviceOnly;
      const es = window.esc(slot);
      box.innerHTML = list.map(x => {
        const id2 = window.esc(x.id);
        const src = x.typed ? '自己填的' : (x.api ? '接口给的' : '本机记的');
        const del = x.typed
          ? '<button class="ghost mini" title="移除这个型号（只清本机记录）"'
            + ' data-tdel="' + id2 + '" data-tkid="' + es + '">' + ic('close', 10) + '</button>' : '';
        if (text) {
          const on = x.id === cur;
          const mm = window.ModelPrefs ? ModelPrefs.mediaOf(p, x.id) : {};
          const mediaTag = (kind, zh) => {
            const mode = mm[kind] || '';
            const cls = mode === 'on' ? ' on' : mode === 'off' ? ' off' : '';
            const tip = mode === 'on' ? '这个型号支持' + zh + '输入（点一下改为不支持）'
              : mode === 'off' ? '这个型号不支持' + zh + '输入（点一下改回自动）'
                : '自动判断' + zh + '输入（点一下改为支持）';
            return '<button class="med-tag' + cls + '" type="button" data-tmedit="' + kind + '"'
              + ' data-tkid="' + es + '" title="' + window.esc(tip) + '">' + zh + '</button>';
          };
          return '<div class="mlist-row text-model' + (on ? ' pick' : '') + '" role="button" tabindex="0"'
            + ' data-tpick-model="' + id2 + '" data-tkid="' + es + '"'
            + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
            + ' title="' + (on ? '全站润色在用这一个'
              : '设为全站润色用的型号') + '">'
            + '<span class="mrow-line">'
            + '<span>' + ((x.name && x.name !== x.id) ? '<b>' + window.esc(x.name) + '</b> ' : '') + '<code>' + id2 + '</code></span>'
            + '<span class="mlist-src">' + (on ? '正在用' : src) + '</span>' + del + '</span>'
            + '<span class="med-tags" title="模型能收的输入（点一下切换）">'
            + '<span class="med-tag fixed" title="文字输入始终支持">字</span>'
            + mediaTag('image', '图') + mediaTag('audio', '音') + mediaTag('video', '视')
            + '</span></div>';
        }
        const off = window.ModelPrefs ? ModelPrefs.isOff(p, x.id) : false;
        return '<div class="mlist-row' + (off ? ' off' : '') + '">'
          + '<label title="' + (off ? '勾上 = 出现在型号下拉里'
            : '勾掉 = 从型号下拉里藏掉') + '">'
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
        panelMsg(slot, '这一行不在下拉的选项里，点「取一次型号清单」重新取一次。', 'msg err');
        return;
      }
      if (sel.value === m && modelDraft.get(kid) === m) return;
      sel.value = m;
      /* 下拉是公共件包出来的，程序化改值之后要让它把显示文字与选项列表跟上。 */
      if (window.Dropdowns) Dropdowns.sync(sel);
      modelDraft.set(kid, m);
      renderModelRows(slot);
      paintFetchNote(slot);
      panelMsg(slot, '已选择型号：' + m + '（全站润色都用它）', 'msg');
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
      (raw || []).forEach(m => {
        const id = String((m && (m.id || m.name)) || m || '').trim();
        if (!id || seen.has(id)) return;
        if (window.TextAI && TextAI.modelAllowed && !TextAI.modelAllowed(p, id)) return;
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
       与卡上那一族开关（账号卡流那份 onAcctClick）各认各的 data-*，挂在同一颗网格上互不抢。 */
    async function onPanelClick(ev) {
      /* 型号行上的 图 / 音 / 视：点一下在自动 → 支持 → 不支持之间切换，按型号存。 */
      const mt = ev.target.closest && ev.target.closest('[data-tmedit]');
      if (mt && ev.target.closest('[data-tpick-model]')) {
        ev.preventDefault(); ev.stopPropagation();
        const slot = slotOfEl(mt), p = provBySlot(slot);
        const id2 = ev.target.closest('[data-tpick-model]').dataset.tpickModel;
        const kind = mt.dataset.tmedit;
        if (p && id2 && ['image', 'audio', 'video'].indexOf(kind) >= 0 && window.ModelPrefs) {
          const cur2 = ModelPrefs.mediaOf(p, id2)[kind] || '';
          ModelPrefs.setMedia(p, id2, kind, cur2 === '' ? 'on' : cur2 === 'on' ? 'off' : '');
          renderModelRows(slot);
          markChanged();
        }
        return;
      }
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
        panelMsg(slot, '没认出这一档，先刷新一下页面再填。', 'msg err');
        return;
      }
      if (b.dataset.tdel != null) {
        const id2 = b.dataset.tdel, sel2 = selOf(kid);
        const was = sel2 && sel2.value === id2;
        TextAI.removeCustom(prov, id2);
        markChanged();
        renderModelRows(slot);
        fillModelOptions(slot);
        setCount(slot);
        if (was) fillModelOptions(slot);
        panelMsg(slot, '已移除型号「' + id2 + '」（只清本机记录）', 'msg ok');
        return;
      }
      if (b.dataset.tadd != null) {
        const inp = (b.closest('.mpanel') || document).querySelector('[data-tmnew]');
        const raw = ((inp || {}).value || '').trim();
        if (!raw) { if (inp) window.focusQuiet(inp); return; }
        /* 逗号分隔一次填多个：一行的输入框，多次落盘 —— 与「自己填」那一格的说法一致。 */
        const ids = raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
        ids.forEach(id2 => TextAI.addCustom(prov, id2));
        markChanged();
        if (inp) inp.value = '';
        renderModelRows(slot);
        fillModelOptions(slot, ids[ids.length - 1]);
        setCount(slot);
        panelMsg(slot, '已添加 ' + ids.join('、') + '（只属于「' + (prov.name || '这一家') + '」这一家）', 'msg ok');
        return;
      }
      if (b.dataset.tfetch != null) {
        const p = prov;
        b.disabled = true;
        try {
          const list = await runFetchModels(p, slot, b);
          const from = (p.kind === 'text' ? (TextAI.base(p) || p.base) : (p.base || '')) || '这一家的默认地址';
          panelMsg(slot, '从「' + from + '」取回 ' + list.length + ' 个型号，当前选中 '
            + (((selOf(kid) || {}).value) || '—'), 'msg ok');
          markChanged();
          if (p.kind === 'text') {
            try {
              const v = await TextAI.verifyKey(await Api.registry(), p);
              const el = q('[data-pmsg="' + window.esc(slot) + '"]');
              if (el) el.textContent += '　|　' + v.text;
            } catch (e) { /* 验证失败不拖累取列表 */ }
          }
        } catch (e) {
          const hint = p.kind === 'text' ? ''
            : '（刚贴的密钥要等状态行变成「刚刚存过」再取）';
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
            throw new Error('「' + model + '」不属于「' + (p.name || '这一家') + '」的型号列表，重新选一个或点「取一次型号清单」');
          }
          const out = await TextAI.chat(await Api.registry(), '你是助手，回答要极简。', '只回复：ok', { model, noTools: true }, p);
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
        markChanged();
        const wasCur = ((selOf(kid) || {}).value) === id2;
        renderModelRows(slot);
        fillModelOptions(slot);
        setCount(slot);
        const sel2 = selOf(kid);
        if (sel2) modelDraft.set(kid, sel2.value);
        panelMsg(slot, (hide ? '已隐藏 ' : '已展示 ') + id2 + '（按账号存）'
          + (hide && wasCur ? '　|　它原本是选中的型号，下拉已换到清单里的第一个' : ''),
          'msg ok');
        return;
      }
      const s = ev.target.closest('[data-tmodel]');
      if (!s) return;
      const kid = s.dataset.tmodel;
      modelDraft.set(kid, s.value);
      const slot = slotKey(kid, 'text');
      renderModelRows(slot);
      setCount(slot);
      panelMsg(slot, '已选择型号：' + (s.value || '（空）') + '（全站润色都用它）', 'msg');
    }
    function initTextForm() {
      textForm = {
        prov: curTextProv, list: textProvList, provBySlot, textProvOf, fetchedOf, paint: paintTextCards,
        clearDrafts() { modelDraft.clear(); },
        flushDrafts(W, Wdel, skipped, domKeys) {
          for (const [kid, m] of modelDraft) {
            if (domKeys && domKeys.has(kid)) continue;
            if (!m) continue;
            const p = textProvOf(kid);
            if (p && TextAI.ownsModel && !TextAI.ownsModel(p, m, fetchedOf(p))) { skipped.push('型号「' + m + '」（不属于' + (p.name || '这一家') + '）'); continue; }
            W('sk_model_' + kid, m);
          }
        },
      };
      /* textForm 只给这一页自己用（以前还挂过 window.__textForm，全站没有读它的地方）。
         面板与卡片上的接线都挂在网格那一个节点上，由账号卡流的 wireAcct 一次绑齐（重画只换 innerHTML，
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
            + (m === 'page' ? '翻页' : '动态加载') + '</option>').join('')
          + '</select>'
          + '<span style="font-size: var(--fs-13);color:var(--sub)">每页</span>'
          + '<input type="number" min="' + SZ.min + '" max="' + SZ.max + '" data-size="' + window.esc(t.key) + '" value="' + window.pageSizeOf(t.key) + '" style="flex:0 0 90px">'
          + '<span style="font-size: var(--fs-13);color:var(--sub)">条</span>';
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
              : '历史产物补存已关闭；导演台刚生成的产物仍会存进本机（工作台按这一档走）。';
            const parts = [okLine];
            if (st.on && st.lastAt) {
              parts.push(st.lastErr
                ? '最后一次没存成：' + st.lastErr
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
      const row = document.createElement('div');
      row.className = 'krow';
      const lab = document.createElement('span');
      lab.className = 'kn';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool';
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'ghost';
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
            why.textContent = '';
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
          btn.textContent = '等待选择…';
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
       产物**只有一份**：库根\类型\<规范名>.<ext>，默认根就是用户翻得到的 下载\成像。
       「按类型另存到指定文件夹」那一族（三档开关 + 三格目录 + 补存 + 上次没存成）整块撤掉 ——
       实测一次生成写两遍同样的字节，两份都躺在用户自己的盘上。
       这一卡只做一件事：把库根指到哪儿（只有**一个**目录）。
       库根不是浏览器里的偏好：代理的 localRoot() 读的是 .data\sk_local_dir.json，
       所以这里写 localStorage 的 sk_local_dir，由 DataSync 镜像过去（同步名单在 datasync.js）。
       ⚠ 换根**不搬文件**，这一页也没有「把旧根搬进来」的入口：代理只扫当前根，
          旧根里那些产物在库里读不到文件（回源外链与费用记录照样在）。
          要接着用得自己在文件管理器里把旧根那一堆挪进新根 —— 挪进去就按 fid / 内容签名认回。 */
    const NO_PROXY_TXT = '没接到本机代理，读不到现在的位置 —— 先确认代理在跑。';
    const libRootDir = () => String(window.LS.get('sk_local_dir') || '').trim();
    function libRootSet(dir) {
      const v = String(dir || '').trim();
      /* 空串是「用默认」，不是「没配过」：把键删掉，代理那侧就读回落下载\成像。
         留一个空字符串在盘上，下次对账会把它当成一份有内容的配置拉回另一台机器。 */
      if (v) window.LS.set('sk_local_dir', v); else window.LS.del('sk_local_dir');
    }

    function renderLocalLib(box) {
      if (!box) return;
      const head = document.createElement('div');
      head.className = 'sect-t';
      head.textContent = '本机资产库';
      box.appendChild(head);

      const row = document.createElement('div');
      row.className = 'krow';
      const kn = document.createElement('span');
      kn.className = 'kn'; kn.textContent = '位置';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.dataset.libdir = '1';
      inp.placeholder = '默认：下载\\成像';
      inp.value = libRootDir();
      inp.style.minWidth = '260px';
      /* 只有 change 才落盘，没有 oninput：半截路径一旦进盘，那几毫秒里正好存回的产物
         会新建并写进一个谁都没挑过的目录。 */
      inp.onchange = () => { saveLibDir(); };
      const why = document.createElement('span');
      why.className = 'hint sm'; why.dataset.libNote = '1';
      const pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'tool'; pick.textContent = '📁 选择…';
      pick.onclick = () => pickLibDir(inp, pick, why);
      const rst = document.createElement('button');
      rst.type = 'button'; rst.className = 'ghost'; rst.textContent = '恢复默认';
      rst.title = '清空这一格 → 产物回到系统「下载」下的 成像\\';
      rst.onclick = async () => {
        if (Confirm.arm(rst, '确认恢复默认', { key: 'lib-rst', hint: '再点一次就清空这一格目录' })) return;
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
      where.textContent = '加载中…';
      box.appendChild(where);

      /* 口径说清楚：索引 / 对账 / 播放都只看这一个目录，**不翻机器上其它地方**。
         换机器时把「导出媒体包」里的 media\ 挪进这个目录，再导入项目文件 —— 按文件名 + 字节数认回原号，
         不用重新导入素材。这一行不是装饰：用户问过「会不会去下载夹、桌面找」，答案必须写在设置页上。 */
      const scope = document.createElement('div');
      scope.className = 'hint sm';
      scope.textContent = '只认这个目录里的文件（图片\\ 视频\\ 音频\\，含子目录）：资产库索引、磁盘对账、'
        + '导演台导入项目都只在这里找，不会去本机其它地方翻。换机器时把「导出媒体包」里的 media\\ '
        + '挪进这个目录，再导入项目文件即可。';
      box.appendChild(scope);
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
      btn.textContent = '等待选择…';
      if (why) why.textContent = '文件夹选择框已弹出（可能在窗口后面）';
      try {
        const r = await Api.pickDir({ title: '选择本机资产库放在哪里', start: String(inp.value || '').trim() });
        if (r && r.cancelled) { if (why) why.textContent = '你取消了，位置没改。'; return; }
        if (!r || !r.ok || !r.dir) {
          if (why) why.innerHTML = '<b style="color:var(--err)">没选到文件夹：</b>' + window.esc((r && r.error && r.error.message) || '代理没有回路径');
          return;
        }
        inp.value = r.dir;
        await saveLibDir();
        if (why) why.textContent = '已选好 · 下一次生成才落到这里';
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
      /* 库根是代理读**盘上那一份**：先把镜像写落定（LS.set 只写 localStorage，
         DataSync 那 800ms 的合并还没发出去），再问代理 —— 否则这两行读数一新一旧。
         提示词归档就住在这个根下面，它显示的那条路径也得当场跟着换。 */
      try { if (window.DataSync && DataSync.flush) await DataSync.flush(); } catch (e) { /* 代理不在就先看旧读数，下次刷新再对齐 */ }
      await refreshLibRoot();
      await refreshPrompt();
      if (prev !== want) {
        setLibNote(want ? ('位置已改（下一次生成才落到这里，库里的文件不动）。')
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
      /* 开关读的是 AssetLocal 那一份谓词（缺省「没存过 = 开」）：这里手抄一次 `LS.get(...) !== 'off'`
         就是第二套默认值，两边漂开的表现是「界面说开着，队列一条不排」。 */
      const __wasSaveOn = AssetLocal.saveOn();
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
      /* 刚把这颗开关从关拨到开：记下开启时刻，「只存新产物」那一档据此划界。 */
      if (AssetLocal.saveOn() && !__wasSaveOn) AssetLocal.markSaveOn();
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
      if (!SET) { box.innerHTML = '<span class="hint sm">读不到「素材库」的设置表，刷新一下这一页</span>'; return; }
      box.innerHTML = '';
      Object.keys(SET).forEach(id => {
        const it = SET[id];
        const val = Chars.setting(id);
        let ctl;
        if (it.kind === 'bool') {
          ctl = '<label class="crow" style="flex:0 0 auto"><input type="checkbox" data-set="' + id + '"' + (val === '0' ? '' : ' checked') + '> 开启</label>';
        } else if (it.kind === 'num') {
          ctl = '<input type="number" min="0" step="' + window.esc(it.step || '0.5') + '" data-set="' + id + '" value="' + window.esc(val) + '" style="flex:0 0 110px">'
            + (it.unit ? '<span style="font-size: var(--fs-13);color:var(--sub)">' + window.esc(it.unit) + '</span>' : '');
        } else if (it.kind === 'model') {
          ctl = modelCtl(id, it, val);
        } else {
          ctl = '<select data-set="' + id + '" style="flex:0 0 210px">'
            + (it.options || []).map(o => '<option value="' + window.esc(o.id) + '"' + (o.id === val ? ' selected' : '') + '>' + window.esc(o.label) + '</option>').join('')
            + '</select>';
        }
        const row = document.createElement('div');
        row.className = 'krow thin';
        row.innerHTML = '<span class="kn">' + window.esc(it.label) + '</span>' + ctl;
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
      if (!window.Notification) return '这个浏览器不给网页弹通知';
      const p = Notification.permission;
      if (p === 'granted') return '浏览器已授权';
      if (p === 'denied') return '浏览器已拒绝授权 —— 去地址栏左边的「网站设置」里放开';
      return '还没授权';
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

    /* ---------- SET_ROWS 的渲染与写盘（一处声明，两处现取） ---------- */
    const MANIFEST_HOSTS = () => ({
      net: netBoxEl.value, store: storeRowsEl.value, assistant: assistantBoxEl.value, polish: polishBoxEl.value,
      model: modelBoxEl.value,
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
          /* data-mkey 用存储键（r.num），Net.NUMS 的名字（r.name）只管取值区间与回调 ——
             写盘那头按存储键找回这一行，再交给 Net.setNum。 */
          const nk = r.num || r.name;
          const sp = (window.Net && window.Net.NUMS && window.Net.NUMS[r.name]) || NET_SP[r.name] || {};
          row.innerHTML = '<span class="kn">' + window.esc(r.label) + '</span>'
            + '<input type="number" data-mkey="' + window.esc(nk) + '" min="' + (sp.min || 0)
            + '" max="' + (sp.max || 999) + '" step="' + (sp.step || 1) + '" value="' + window.esc(String(net[r.name])) + '" style="width:84px">'
            + (r.unit ? '<span class="hint sm">' + window.esc(r.unit) + '</span>' : '');
          row.querySelector('input').addEventListener('change', ev => onNetChange(r.name, ev));
        } else if (r.kind === 'check') {
          row.innerHTML = '<label class="crow" style="flex:1 1 240px"><input type="checkbox" data-mkey="'
            + window.esc(r.key) + '"' + (checkedOf(r) ? ' checked' : '') + '> ' + window.esc(r.label) + '</label>';
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
            + '</select>';
        }
        box.appendChild(row);
      });
      if (window.Dropdowns) Object.keys(hosts).forEach(k => { const b = hosts[k]; if (b) Dropdowns.build(b); });
      paintNoticeState();
    }
    /* 自动保存写盘的那一段：屏幕上每一项按声明的三态落盘。
       新增行没进导出名单时当场说出来（isSettingKey 由 UI_PREFS.exportOf 现算），不静默丢。 */
    function saveManifestRows(W, Wdel) {
      qa('[data-mkey]').forEach(el => {
        const k = el.dataset.mkey;
        if (el.type === 'number') {
          const r = SET_ROWS.find(x => x.kind === 'num' && (x.num || x.name) === k);
          if (window.Net && r) Net.setNum(r.name, el.value);
          return;
        }
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
        const pick = textPick();
        if (pick) W(TextAI.provKey(), pick);
        else if (!window.LS.get(TextAI.provKey())) W(TextAI.provKey(), tp.id);
        setTextPick('');
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
        skipped.push('语音识别那一张卡');
      }
      if (searchSig() !== searchSavedSig && !(await saveSearch())) {
        skipped.push('联网搜索那一张卡');
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
    /* 「什么算设置」只问 ui.js 的 UI_PREFS：导出、导入过滤、恢复默认三处同一套判据。
       认不出的键一律 false（不说「能动」）—— 设置声明没加载出来时宁可这次什么都不导。 */
    const isSettingKey = k => !!(window.UI_PREFS && window.UI_PREFS.exportOf) && window.UI_PREFS.exportOf(k);
    const RESET_KEEP = (window.UI_PREFS && window.UI_PREFS.keepKeys) ? window.UI_PREFS.keepKeys() : [];
    function exportSettings(includeKeys) {
      const out = {};
      for (const k of window.LS.keys()) {
        if (!k) continue;
        if (!isSettingKey(k)) continue;
        if (!includeKeys && window.UI_PREFS.secretOf(k)) continue;
        out[k] = window.LS.get(k);
      }
      return { type: 'ai-workbench-settings', version: 1, ts: new Date().toISOString(), includeKeys: !!includeKeys, data: out };
    }
    /* 覆盖前的唯一退路：代理的快照仓（.data/backup.json）。
       以前是往浏览器下载目录丢一份 JSON —— 下载可能被拦、可能被清理，而且没人看得见
       它到底存没存成。现在统一留一份带校验和的快照，设置页那张卡随时能列出来恢复。
       留不成不拦路，但回执必须如实说「这一次撤不回来」。 */
    async function snapshotBefore(tag) {
      try {
        const r = await DataSync.backupCreate('before-' + tag);
        return (r && r.id) ? String(r.id) : '';
      } catch (e) { return ''; }
    }
    const undoNote = snap => snap
      ? '。撤销：到「数据与备份」恢复快照 ' + snap
      : '。⚠ 覆盖前没能留下快照，这一次撤不回来';
    async function exportSetup() {
      if (!(await flushPending())) { Toast.err('设置没能完整存进本机：' + saveFailed); return; }
      const withKeys = await Confirm.choose({
        title: '导出设置', body: '平台密钥要不要一起导出？',
        options: [
          { value: 'nokeys', label: '不含密钥（推荐）', hint: '只导接口地址、目录、分页、润色指令等设置' },
          { value: 'keys', label: '含密钥', hint: '文件里会有明文密钥，别外传' },
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
            body: '将写入 ' + (n - extra.length) + ' 项设置，同名项覆盖，然后刷新页面。'
              + (extra.length ? '\n文件里另有 ' + extra.length + ' 项不是设置项，会跳过：'
                + extra.slice(0, 5).join('、') + (extra.length > 5 ? ' 等' : '') : '') });
          if (!ok) return;
          await stopPendingSave();
          const snap = await snapshotBefore('导入设置');
          const bad = [];
          Object.entries(d.data).forEach(([k, v]) => {
            if (extra.includes(k)) return;
            if (!window.LS.set(k, v)) bad.push(k);
          });
          const wrote = n - bad.length - extra.length;
          if (bad.length) {
            Toast.after('已导入 ' + wrote + ' 项，' + bad.length + ' 项没写进去（本机存储满，先清一点再试）：'
              + bad.slice(0, 3).join('、') + (bad.length > 3 ? ' 等' : '')
              + undoNote(snap), 'err');
          } else if (extra.length) {
            Toast.after('已导入 ' + wrote + ' 项；文件里另有 ' + extra.length + ' 项不是设置（' + extra.slice(0, 3).join('、')
              + (extra.length > 3 ? ' 等' : '') + '），已跳过'
              + undoNote(snap));
          } else {
            Toast.after('已导入 ' + wrote + ' 项设置（页面为此刷新了一次）'
              + undoNote(snap));
          }
          reloadAfter(900);
        } catch (err) { Toast.err('导入失败：' + errText(err)); }
      };
      r.onerror = () => Toast.err('读取文件失败');
      r.readAsText(f);
    }
    async function resetSetup() {
      /* fail-safe：声明缺失时 isSettingKey 恒 false、RESET_KEEP 为空 —— 看起来「清了」其实什么都没清；
         反过来要是哪天判反了就会把不该清的清掉。宁可当场拒绝这一次。 */
      if (!window.UI_PREFS || !window.UI_PREFS.exportOf || !window.UI_PREFS.keepKeys) {
        Toast.err('设置声明没加载出来，这次「恢复默认」没有执行');
        return;
      }
      const ok = await Confirm.ask({ title: '恢复默认设置？', danger: true, okLabel: '清空设置',
        body: '会清掉：密钥、接口地址与型号、自定义供应商、润色指令、分页、网络与分栏等全部设置。\n'
          + '不会清掉：主题、视图偏好、生成历史、资产、收藏与素材库。\n'
          + '清空前会在「数据与备份」留一份本机快照，随时能撤回。' });
      if (!ok) return;
      await stopPendingSave();
      const snap = await snapshotBefore('恢复默认');
      const n = Store.sweep(k => !RESET_KEEP.includes(k) && isSettingKey(k));
      Toast.after('已清除 ' + n + ' 项设置，其余各项回到内置默认（页面为此刷新了一次）'
        + undoNote(snap));
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
    /* ---------- 备份中心：本机快照的唯一界面（端点只经 DataSync 走 /backup/*） ----------
       健康提示必须说清「哪一份坏了」：state.json 校验不过时代理会拒绝写入，
       这时界面上要是还写「正常」，用户就会一直以为自己的修改存下来了。 */
    const backupInfo = ref('读取中…');
    const backupMsg = ref('');
    const backupRows = ref([]);
    const backupBusy = reactive({ create: false, verify: false, refresh: false });
    async function refreshBackupCenter() {
      if (backupBusy.refresh) return;
      backupBusy.refresh = true;
      try {
        const st = await DataSync.backupStatus();
        const bad = [];
        if (st.stateDegraded) bad.push('状态仓：' + st.stateDegraded);
        if (st.degraded) bad.push('快照仓：' + st.degraded);
        if (!st.verified) bad.push('快照校验没过：' + (st.bad || []).join('、'));
        backupInfo.value = st.ok
          ? '✓ 正常 · ' + st.count + '/5 份快照 · 最近 ' + (st.lastAt ? fmtTime(st.lastAt) : '尚无')
            + (st.fsyncDegraded ? ' · 落盘同步退化：' + st.fsyncDegraded : '')
          : '⚠ ' + (bad.join('；') || '备份状态异常，先别覆盖数据');
        backupRows.value = st.snapshots || [];
        if (st.legacy && st.legacy.migrated) backupMsg.value = '旧数据文件已转成 state.json（' + st.legacy.migrated + ' 个业务键），原文件已删除';
      } catch (e) {
        backupInfo.value = '读不到备份状态（代理没在运行？）';
        backupRows.value = [];
      }
      renderBackupRows();
      backupBusy.refresh = false;
    }
    function renderBackupRows() {
      const box = backupListEl.value;
      if (!box) return;
      const rows = backupRows.value || [];
      if (!rows.length) { box.innerHTML = ''; return; }
      box.innerHTML = panelBox('本机快照（' + rows.length + ' 份，最多留 5 份）')
        + rows.map(x => '<div class="cloud-row">'
          + '<span class="cloud-key">' + escH(x.reason) + '</span>'
          + '<span class="cloud-meta">' + escH(fmtTime(x.ts)) + ' · ' + Number(x.keys || 0) + ' 键 / '
          + Number(x.prompts || 0) + ' 归档' + (x.assetsIndex ? ' / 含资产索引' : '') + '</span>'
          + '<button class="ghost mini xs" data-snap="' + escH(x.id) + '" data-act="preview">看差异</button>'
          + '<button class="ghost mini xs" data-snap="' + escH(x.id) + '" data-act="restore">恢复这份</button>'
          + '</div>').join('') + '</div>';
      box.querySelectorAll('[data-snap]').forEach(b => { b.onclick = () => backupRowAct(b.dataset.snap, b.dataset.act); });
    }
    async function backupRowAct(id, act) {
      try {
        if (act === 'preview') {
          const d = await DataSync.backupPreview(id);
          const go = await Confirm.ask({ title: '恢复这份快照？', danger: true, okLabel: '恢复并刷新',
            body: (d.text || '') + ' 恢复前会再留一份当前数据的快照。' });
          if (!go) return;
        } else {
          const go = await Confirm.ask({ title: '恢复这份快照？', danger: true, okLabel: '恢复并刷新',
            body: '会用这份快照覆盖当前业务键与提示词归档，然后刷新页面。恢复前会再留一份当前数据的快照。' });
          if (!go) return;
        }
        await doRestore(id);
      } catch (e) { backupMsg.value = '失败：' + errText(e); }
    }
    async function doRestore(id) {
      await stopPendingSave();
      try {
        const r = await DataSync.backupRestore(id);
        Toast.after((r.message || '已从快照恢复') + '（页面为此刷新了一次）');
        try { DataSync.resetBootFlags(); } catch (e) {}
        reloadAfter(900);
      } catch (e) { backupMsg.value = '恢复失败：' + errText(e); }
    }
    async function createBackup() {
      if (backupBusy.create) return;
      backupBusy.create = true;
      try {
        const r = await DataSync.backupCreate('manual');
        backupMsg.value = r && r.created === false ? '已有相同内容的快照（' + (r.why || '内容没变') + '）' : '✓ 已留一份快照';
        await refreshBackupCenter();
      } catch (e) { backupMsg.value = '留快照失败：' + errText(e); }
      finally { backupBusy.create = false; }
    }
    async function verifyBackup() {
      if (backupBusy.verify) return;
      backupBusy.verify = true;
      try {
        const r = await DataSync.backupVerify();
        backupMsg.value = r.ok ? '✓ 全部 ' + r.count + ' 份快照校验通过' : '✗ 校验没过：' + (r.bad || []).join('、');
        await refreshBackupCenter();
      } catch (e) { backupMsg.value = '校验失败：' + errText(e); }
      finally { backupBusy.verify = false; }
    }
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
      persistInfo.value = (st.granted ? '✓ 已持久化' : '⚠ 未持久化：磁盘紧张时浏览器可能自动清理') + use;
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
    function reloadDataInfo() { refreshDataInfo(); refreshPersistInfo(); refreshBackupCenter(); }
    async function askPersist() {
      const r = await DataSync.persist();
      dataMsg.value = r.granted ? '✓ 已获得持久化存储' : '浏览器没有授予（多用几次再来）';
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
        body: '会覆盖当前数据并自动刷新。覆盖前会在「数据与备份」留一份本机快照。' });
      if (!ok) return;
      if (dataBusy.pull) return;
      dataBusy.pull = true; dataMsg.value = '正在留一份快照…';
      try {
        await stopPendingSave();
        const snap = await snapshotBefore('从数据文件恢复');
        dataMsg.value = '正在恢复…';
        const n = await DataSync.pullAll();
        Toast.after('已从数据文件恢复 ' + n + ' 项（页面为此刷新了一次）' + undoNote(snap));
        reloadAfter(800);
      } catch (e) { dataMsg.value = '失败：' + errText(e); dataBusy.pull = false; }
    }
    /* v2 整包恒带服务端快照（业务键 / 资产索引 / 提示词归档 / 云同步状态），
       所以「要不要带归档」不再是一个选项 —— 少那一段就不算整包。
       唯一还能选的是本地文件字节（视频 / 参考音频那些大 Blob）。 */
    async function exportAll() {
      const pick = await Confirm.choose({
        title: '导出整包备份', body: '本地文件（视频、参考音频）要不要一起打包？',
        options: [
          { value: 'data', label: '只导出数据（推荐）', hint: '设置、历史、收藏、工作区 + 服务端整份快照；体积小' },
          { value: 'all', label: '连本地文件一起导出', hint: '再把 IndexedDB 里的大文件转成 base64，体积可能很大' },
        ],
      });
      if (!pick) return;
      if (dataBusy.exp) return;
      dataBusy.exp = true; dataMsg.value = '正在打包…';
      try {
        const pack = await DataSync.exportAll(pick === 'all');
        const json = JSON.stringify(pack);
        const name = 'ai-workbench-整包备份-v2-' + new Date().toISOString().slice(0, 10)
          + (pick === 'all' ? '-含文件' : '') + '.json';
        const blob = new Blob([json], { type: 'application/json' });
        Net.save(blob, name);
        const sp = (pack.server && pack.server.prompts) || {};
        const skipped = Number(sp.skipped) || 0;
        dataMsg.value = '✓ 已导出（' + mbOf(blob.size) + '，服务端 ' + Object.keys(pack.server.state || {}).length
          + ' 项业务键、提示词归档 ' + ((sp.files || []).length) + ' 份'
          + (skipped ? '（另有 ' + skipped + ' 份超出上限没带上）' : '') + '）';
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
          /* 版本闸门放在弹确认框之前：高版本的包连「将覆盖什么」都不该让人白读一遍。
             写入口 importAll 里还有同一道（调的是同一个 assertPack）。 */
          DataSync.assertPack(pack);
          const desc = DataSync.describePack(pack);
          const ok = await Confirm.ask({ title: '导入整包备份？', danger: true, okLabel: '导入并刷新',
            body: '会覆盖当前数据并自动刷新。覆盖前会在「数据与备份」留一份本机快照。 ' + desc.text });
          if (!ok) return;
          dataMsg.value = '正在留一份快照…';
          await stopPendingSave();
          await snapshotBefore('导入整包');
          dataMsg.value = '正在导入…';
          /* 服务端那一段先校验 checksum，对不上就一项都不写（DataSync.importAll 里排在最前）。 */
          const res = await DataSync.importAll(pack);
          Toast.after('已从备份导入：' + res.localStorage + ' 项浏览器数据'
            + (res.indexedDB ? '、' + res.indexedDB + ' 个本地文件' : '')
            + (res.server ? '；服务端 ' + res.server.written + ' 项业务键、归档 ' + res.server.prompts + ' 份' : '')
            + (res.failed ? '；⚠ 有 ' + res.failed + ' 项没写进去（本机存储写满或被占用）' : '')
            + '；恢复前的当前数据已另留一份快照（页面为此刷新了一次）');
          reloadAfter(900);
        } catch (err) { dataMsg.value = '导入失败：' + errText(err); }
      };
      r.onerror = () => { dataMsg.value = '读取文件失败'; };
      r.readAsText(f);
    }

    /* ---------- 云同步（WebDAV） ---------- */
    const CK = { url: 'sk_cloud_url', user: 'sk_cloud_user', pass: 'sk_cloud_pass', keys: 'sk_cloud_keys', prompts: 'sk_cloud_prompts' };
    /* 默认云端地址的唯一一份在代理侧（server/data-hub.js 的 CLOUD_DEFAULT_URL）：
       页面留空 → .env → 两处都没填才轮到它。这里只从 /cloud/status 取回来做输入提示，
       绝不预填进输入框 —— 预填会被当成「页面填了」，反而把 .env 写的地址压掉。 */
    const cloudUrl = ref('');
    const cloudDefaultUrl = ref('');
    const cloudUrlHint = computed(() => cloudDefaultUrl.value
      ? '留空 = 用 .env；都没填就用 ' + cloudDefaultUrl.value
      : '留空 = 用 .env；都没填用内置默认');
    const cloudUser = ref('');
    const cloudPass = ref('');
    const cloudKeys = ref(false);
    const cloudPrompts = ref(false);
    const cloudMsg = ref('');
    const cloudState = ref('读取同步状态…');
    const cloudBusy = reactive({ test: false, push: false, pull: false, sync: false });
    /* 三格与 .env 的 CLOUD_WEBDAV_* 一一对应：留空 = 请求头不带这一项、代理回退到 .env，
       地址那一格连 .env 也空时再由代理用内置默认；填了 = 以页面为准。
       本机没存过这个键、或存的就是空串，输入框都保持空（以前会把默认地址顶回来）。 */
    function initCloud() {
      const g = k => window.LS.get(CK[k]);
      cloudUrl.value = g('url') || '';
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
      cloudMsg.value = '✗ 云端设置没存进本机：本机存储写不进去。'
        + '这一次仍按当前填的走，但刷新后会回到旧配置。';
      Toast.warn('云端设置没存进本机 —— 刷新后会回到旧配置');
      return false;
    }
    function cloudHeaders() {
      saveCloud();
      /* 三格一律只在非空时才带请求头：留空的那一格由代理读 .env 补上，填了的压过 .env。 */
      const h = { 'Content-Type': 'application/json' };
      const u = String(cloudUrl.value || '').trim(), n = String(cloudUser.value || '').trim(), p = String(cloudPass.value || '');
      if (u) h['x-cloud-url'] = u;
      if (n) h['x-cloud-user'] = n;
      if (p) h['x-cloud-pass'] = p;
      if (cloudKeys.value) h['x-cloud-keys'] = '1';
      return h;
    }
    /* 归档目录不在正文里：代理按库根现算「提示词\」，页面没有第二个位置可发。 */
    const cloudBody = () => JSON.stringify(cloudPrompts.value ? { prompts: 1 } : {});
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
          extra += '；用云端覆盖了本机较旧的 ' + d.overwritten.length + ' 份（覆盖前已留一份本机快照：' + list + '）';
        }
        if ((d.averted || []).length) {
          extra += '；另有 ' + d.averted.length + ' 份' + (cmd === 'push'
            ? '云端更新，本次没上传'
            : '本机更新，本次没下载');
        }
        if ((d.conflicts || []).length) {
          extra += '；' + d.conflicts.length + ' 份两边都改过，列为冲突待选择';
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
              + (cmd === 'push' ? '（这次只上传；点「↓ 从云端下载」或「⇅ 一键双向同步」取回）' : '');
            if (p.failed && p.failed.length) extra += '；归档 ' + p.failed.length + ' 份失败：' + p.failed.slice(0, 3).join('、') + (p.failed.length > 3 ? '…' : '');
          }
        } else if (cloudPrompts.value) {
          extra += '；提示词归档没有参与这次同步';
        }
        const note = (d.message || '完成') + extra;
        cloudMsg.value = '✓ ' + note;
        if ((cmd === 'pull' || cmd === 'sync') && (d.down || d.count)) {
          try { DataSync.resetBootFlags(); } catch (e) {}
          Toast.after(note + '（页面为此刷新了一次）');
          reloadAfter(900);
        }
        refreshDataInfo();
        refreshCloudPanel();
      } catch (e) {
        const m = String(errText(e)|| '');
        cloudMsg.value = timedOut
          ? '✗ 等了满 ' + Math.round(CLOUD_MAX_MS / 1000) + ' 秒还没回来，已经不等了。'
            + '代理那一头可能仍在跑：先看下面的同步状态，别连着重发。'
          : /^请求已取消/.test(m)
            ? '✗ 已中止这次等待：代理那一头仍在跑，先看下面的同步状态。'
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
    const panelBox = title => '<div class="cloud-box">'
      + '<div class="cb-title">' + title + '</div>';
    async function refreshCloudPanel() {
      if (!cloudState) return;
      let d = null;
      try { d = await Net.json('/cloud/status', { timeout: 10000 }); }
      catch (e) { cloudState.value = '读不到同步状态（代理没在运行？）'; return; }
      /* 默认地址只从代理这一份拿，页面不写第二遍；代理是老版本时保留旧提示文案。 */
      cloudDefaultUrl.value = String(d.defaultUrl || '');
      cloudState.value = (d.lastAt ? '上次同步 ' + fmtTime(d.lastAt) + '：' + (d.lastResult || '') : '还没有同步过')
        + (d.envConfigured ? ' · 凭据在代理侧（账号密码留空即用）' : '')
        + (d.prompts ? (d.prompts.error ? '；提示词归档：' + window.esc(d.prompts.error)
          : '；提示词归档 ' + d.prompts.count + ' 份' + (cloudPrompts.value ? ' · 随同步' : ' · 未随同步'))
          : '');
      /* 冲突：每条两个按钮，选完立即执行（选云端会先留一份本机快照） */
      const cf = d.conflicts || [];
      const cBox = cloudConflictsEl.value;
      if (cBox) {
        /* 整块是 innerHTML 重来的：一份冲突选完，那一行没了（面板可能整块塌掉）——
           用户就站在这块上面点的手，塌掉的又是他视野上方的东西，得按锚点把那一行钉住。
           这一页在滚的是右边那条文档，所以点名它。 */
        window.Wb.viewport.keep(setDocEl.value, () => {
          if (!cf.length) { cBox.innerHTML = ''; return; }
          cBox.innerHTML = panelBox('冲突待选择（' + cf.length + ' 份）')
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
                  body: '会覆盖本机这份数据（覆盖前自动留一份本机快照可恢复），然后刷新页面。' });
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
        });
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
      return ['成像 本机环境体检 ' + window.fmtWhen(s.at || Date.now())]
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
        /* 「重新体检」这一次点下去，这一格的行数与高度都会变（错误占位比正常那一叠短得多）：
           用户就站在这张卡上，塌掉的又在他视野上方 —— 点名这一页在滚的那条文档。 */
        if (sysRowsEl.value) {
          window.Wb.viewport.keep(setDocEl.value, () => {
            sysRowsEl.value.innerHTML = e && e.status === 404
              ? '<div class="ui-note info">本地代理的版本太旧，这一项它还不支持。'
                + '用「启动.bat → 2 停止 → 1 启动」重启一下，回来点「重新体检」。</div>'
              : '<div class="ui-note err">读不到本机环境：' + window.esc(errText(e)) + '</div>';
          });
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
        (p.产品版本 ? '成像 v' + p.产品版本 + ' · ' : '')
          + '注册表 v' + (p.版本 || '?') + ' · 端口 ' + (p.端口 || '?') + ' · Node ' + (p.进程 || '?'),
        '代理目录：' + (p.目录 || ''));
      const hh = Api.sysHealth(s.健康);
      const healthSub = s.健康
        ? ('已运行 ' + hh.存活 + ' · 最后一次干活 ' + hh.最后请求
          + (hh.cls !== 'ok' ? ' —— 出路：回到启动器点「重启」' : ''))
        : hh.why;
      html += chipRow('代理健康', hh.cls, hh.chip, healthSub,
        (s.健康 ? [(hh.why || ''), Api.sysFaultLines(hh.最近, 3).join('\n')] : []).concat(Api.SYS_WHY.健康).filter(Boolean).join('\n'));
      const op = s.出站代理;
      if (op) {
        const on = /^走 /.test(op.状态 || '');
        html += chipRow('出站代理', on ? 'ok' : 'warn', on ? '走代理' : '直连',
          (op.来源 || '没检测到代理'), op.绕过 || '');
      }
      html += capsRow(caps);
      const rl = s.转发;
      if (rl) {
        html += chipRow('平台转发闸', rl.档 || 'warn', rl.芯片 || '?',
          '每家同时在途 ' + (rl.同时在途 || '?') + ' 条 · 排队上限 ' + (rl.排队上限 || '?') + ' 条 · 被限流最多重问 '
          + (rl.重试上限 || '?') + ' 次 · 最多等 ' + (rl.最多等秒 || '?') + ' 秒',
          (rl.说明 || '') + '\n' + Api.relayLines(rl, 3).join('\n') + '\n' + (rl.来源 || ''));
      }
      const dirs = s.目录 || {};
      html += dirRow('数据目录（.data）', dirs.数据);
      html += dirRow('本机资产目录', dirs.资产);
      html += dirRow('成片目录', dirs.渲染);
      if (old) html += '<div class="ui-note err">' + window.esc(old) + '</div>';
      if (sysRowsEl.value) window.Wb.viewport.keep(setDocEl.value, () => { sysRowsEl.value.innerHTML = html; });
      sysMsg.value = '上次体检：' + window.fmtHMS(s.at || Date.now())
        + (fresh ? ' · 刚重新探过' : ' · 这一轮是代理缓存的（换过浏览器请点「重新体检」）');
    }
    async function recheckSys() {
      if (sysBusy.value) return;
      sysBusy.value = true;
      try { await refreshSys(true); } finally { sysBusy.value = false; }
    }
    async function copySys() {
      if (!lastSys) { sysMsg.value = '✗ 现在没有可复制的体检结果：先点「重新体检」'; return; }
      const okc = await window.copyText(sysText(lastSys));
      sysMsg.value = okc ? '✓ 已复制 ' + sysText(lastSys).split('\n').length + ' 行体检结果'
        : '✗ 浏览器不让写剪贴板；体检结果还在上面这一栏，手动选也行';
    }

    /* ---------- 资产库磁盘用量（GET /assets-usage，纯读） ---------- */
    const usageMsg = ref('');
    const usageCopyDisabled = ref(true);
    const usageBusy = ref(false);
    let lastUsage = null;
    const SHOW_TOP = 3;
    function usageText(u) {
      return ['成像 本机资产库用量 ' + (window.fmtWhen ? window.fmtWhen(u.at || Date.now()) : '')]
        .concat(Api.usageLines(u)).join('\n');
    }
    function syncUsageCopyBtn() { usageCopyDisabled.value = !lastUsage; }
    async function refreshUsage() {
      /* 这一格三条出口都整块 innerHTML 重来（读不到 / 代理太旧 / 真读数，高度差很多）：
         「重新数一遍」那一下用户就站在这张卡上，所以点名这一页在滚的那条文档还视口。 */
      const writeRows = html => {
        if (usageRowsEl.value) window.Wb.viewport.keep(setDocEl.value, () => { usageRowsEl.value.innerHTML = html; });
      };
      usageMsg.value = '';
      let u = null;
      try { u = await Api.assetsUsage(); }
      catch (e) {
        lastUsage = null; syncUsageCopyBtn();
        writeRows('<div class="ui-note err">数不出本机资产库：' + window.esc(errText(e)) + '</div>');
        return;
      }
      lastUsage = u; syncUsageCopyBtn();
      /* 404 → Api.assetsUsage 交回 null：说「这一项旧代理不支持」，不说「0 字节」。 */
      if (!u) {
        writeRows('<div class="ui-note info">本地代理的版本太旧，这一项它还不支持。'
          + '用「启动.bat → 2 停止 → 1 启动」重启一下，回来点「重新数一遍」。</div>');
        return;
      }
      const d = u.目录 || {};
      let html = chipRow('本机资产库', u.档 || 'warn', u.芯片 || '?',
        (u.因由 || []).join(' · ') || '没有要提醒的', d.路径 || '');
      html += '<div class="dir-name" style="white-space:pre-wrap;line-height:1.85;margin-top: var(--sp-4)">'
        + window.esc(Api.usageLines(u, SHOW_TOP).join('\n')) + '</div>';
      writeRows(html);
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
      usageMsg.value = okc ? '✓ 已复制 ' + txt.split('\n').length + ' 行读数'
        : '✗ 浏览器不让写剪贴板；读数还在上面这一栏，手动选也行';
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
        + (total > 3.5 * 1024 * 1024 ? ' —— 快满了：清理「本地任务记录」或素材库里不要的条目' : '')
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
          + ' 条';
      });
    }
    function clearMetaCache() {
      return runClear('meta', async () => '✓ 已清掉 ' + TextAI.clearMeta() + ' 个型号的接口形状/识图判定');
    }
    function clearThumbCache() {
      return runClear('thumb', async () => {
        const n = await Wb.thumbs.clearAll();
        return '✓ 已清掉 ' + n + ' 张缩略图与 ' + Wb.clearSizes() + ' 条体积探测结果';
      });
    }
    function clearMissedCache() {
      return runClear('missed', async () => '✓ 已清掉 ' + PromptLog.clearMissed() + ' 条「本机没有归档」标记');
    }
    /* 本地任务记录：kind / 键名 / 显示名都从 Wb.History 的声明现取，这里不写死平台。 */
    function renderHistRows() {
      const host = histBoxEl.value;
      if (!host) return;
      const kinds = (window.Wb && Wb.History.kinds()) || [];
      const repaint = () => {
        host.innerHTML = kinds.map(k => {
          const n = Wb.History.read(k.kind).length;
          return '<div class="krow" style="gap: var(--sp-8);flex-wrap:wrap;margin-top: var(--sp-8)">'
            + '<span class="kn">本地任务记录</span>'
            + '<span class="sub-line">' + window.esc(k.label) + '：本机 ' + n + ' 条。'
            + (n ? '清掉后本机存的任务号与提示词就没了，删除还会同步进数据文件与云端。'
                 : '本机没有记录。')
            + '</span>'
            + '<button class="ghost mini danger wide" data-hist="' + window.esc(k.kind) + '"'
            + (n ? '' : ' disabled') + '>清空</button></div>';
        }).join('');
        host.querySelectorAll('[data-hist]').forEach(b => { b.onclick = () => clearHist(b.dataset.hist); });
      };
      /* 「清空」按下去之后这一栏的说明会变（有条数 → 「本机没有记录」），
         旁边还有缓存那一节跟着缩 —— 点名这一页在滚的那条文档。 */
      window.Wb.viewport.keep(setDocEl.value, repaint);
    }
    async function clearHist(kind) {
      const k = ((Wb.History.kinds() || []).find(x => x.kind === kind)) || { label: kind };
      const n = Wb.History.read(kind).length;
      const yes = await Confirm.ask({
        title: '清空' + k.label + '？', danger: true, okLabel: '确定清空',
        body: '这会删掉本机 ' + n + ' 条' + k.label + '（任务号、提示词、产物地址）。'
          + '删除会同步到数据文件（.data/）和云端，云端会保留一份覆盖前的备份。',
      });
      if (!yes) return;
      if (!Wb.History.clear(kind)) { cacheMsg.value = '✗ 清空失败：浏览器存储写不进去'; return; }
      cacheMsg.value = '✓ 已清空 ' + k.label + '（' + n + ' 条）';
      renderHistRows();
      paintCacheUsage();
    }

    /* ---------- 提示词归档 ----------
       归档目录**不给位置**：它固定跟着「本机资产库」那个根走（根下 `提示词\`），
       这里只把代理现算出来的路径读出来显示。以前这一格让用户另存一个 prompt_dir，
       与库根各指一处 —— 换了库根，归档还留在老地方，用户得记住两个位置。 */
    const promptDir = ref('读取中…');
    const promptInfo = ref('读取中…');
    const promptMsg = ref('');
    const promptOpenBusy = ref(false);
    function paintPrompt(d) {
      const rows = d.recent || [];
      promptInfo.value = rows.length ? (d.count + ' 份归档') : '还没有归档';
      promptDir.value = d.dir || '';
      if (!promptRecentEl.value) return;
      /* 最近清单从 8 行缩成一句占位（或反过来）：这一格的高度跟着变，点名这一页在滚的那条文档。 */
      window.Wb.viewport.keep(setDocEl.value, () => {
        if (!rows.length) { promptRecentEl.value.textContent = '还没有归档'; return; }
        promptRecentEl.value.innerHTML = rows.slice(0, 8).map(r => {
          const t = window.fmtWhenSec(r.ts);
          return '<div>· <b>' + window.esc(r.t || r.f) + '</b> <span style="color:var(--sub)">' + window.esc(r.k || '') + ' · ' + window.esc(t) + '</span></div>';
        }).join('') + (rows.length > 8 ? '<div>…共 ' + d.count + ' 份，仅列最近 8 份</div>' : '');
      });
    }
    async function refreshPrompt() {
      try { paintPrompt(await PromptLog.list()); }
      catch (e) {
        /* 路径是代理现算的：读不到时不能继续挂着上一次那一格（换过库根就会骗人） */
        promptInfo.value = '读不到（本地代理没在运行？）';
        promptDir.value = '读不到（本地代理没在运行）';
        if (promptRecentEl.value) promptRecentEl.value.textContent = '';
      }
    }
    function initPromptArchive() {
      if (!window.PromptLog) return;
      refreshPrompt();
    }
    function promptRefresh() { promptMsg.value = ''; refreshPrompt(); }
    async function openPromptDir() {
      if (promptOpenBusy.value) return;
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

    /* 这个场景里的 Skill 与槽位状态。服务端口径（skills-store）：占 contract 的场景
       **恰好一份启用** —— 停掉最后一份被拒、卸载最后一份把内置顶回来、开机修老状态，
       所以「谁在生效」就是启用中的那一份；没有 conflict 一说。 */
    function skillSceneState(sc) {
      const items = skillItems.value || [];
      if (!sc) return { list: [], active: null, lamp: 'empty', text: '空档' };
      if (sc.assistant) {
        const on = items.filter(x => x && x.enabled);
        return { list: on, active: null, lamp: 'asst', text: on.length + ' 份已启用' };
      }
      const list = items.filter(x => x && x.contract === sc.contract);
      const active = list.find(x => x.enabled) || null;
      return {
        list, active,
        lamp: active ? (active.source === 'user' ? 'mine' : 'builtin') : 'empty',
        text: active ? (active.source === 'user' ? '我的' : '内置') : '空档',
      };
    }
    const skillSceneNow = computed(() => skillSceneState(skillScene.value));
    function isSceneActive(s) {
      const st = skillSceneNow.value;
      return !!(st.active && st.active.id === s.id);
    }
    /* 这份 Skill 是它场景里最后一份启用的 → 停用按钮就地压住（服务端也会拒）。
       助手那些不占 contract 的不受限。 */
    function isLastEnabled(s) {
      if (!s || !s.enabled || !s.contract) return false;
      return !(skillItems.value || []).some(x => x && x.enabled && x.contract === s.contract && x.id !== s.id);
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
      if (!window.WbSkills) { skillMsg.value = 'Skill 客户端没有加载'; return; }
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
        const tail = dis.length ? '（原来的 ' + dis.join('、') + ' 已自动停用）' : '';
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
        Toast.err('助手那一项不占固定位');
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
      if (!String(skillForm.description || '').trim()) { Toast.err('写一句它管什么'); return; }
      if (!String(skillForm.body || '').trim()) { Toast.err('正文是空的'); return; }
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
          const tail = dis.length ? '（并已启用：原来的 ' + dis.join('、') + ' 已自动停用）' : '（并已启用）';
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
          skillMsg.value = '✓ 已导入 ' + s.id + '（默认停用）';
          Toast.receipt('已导入 ' + s.id + '（默认停用）');
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
        const d = (await window.WbSkills.remove(id)) || {};
        /* 删的是场景里最后那份启用时，服务端已把内置份顶回来 —— 回执要点名。 */
        const tail = d.restored ? '（内置 ' + d.restored + ' 已顶回来）' : '';
        skillMsg.value = '✓ 已卸载 ' + id + tail;
        Toast.receipt('已卸载 ' + id + tail);
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
      if (!b.files || !b.files.length) return '还没下载';
      return '缺 ' + b.missing.length + ' 个文件（已有 ' + mbOf(b.bytes || 0) + '）：再跑一次浏览器内识别会接着补齐';
    });
    const searchEngineName = computed(() => {
      provEpoch.value;
      const id = String(search.provider || '');
      if (id === 'tavily') return 'Tavily';
      if (!id || id === 'auto') {
        const kid = autoServiceKid('search');
        const m = acctAll().find(x => x.keyId === kid);
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
        return '单独那把当前不用（渠道密钥生效）';
      }
      if (search.hasKey && search.credentialSource === 'manual') return '已单独存了一把搜索密钥';
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
    const asrModelPh = computed(() => {
      const p = asrProvider.value;
      const first = p && Array.isArray(p.models) && p.models[0] && p.models[0].id ? String(p.models[0].id) : '';
      return first || (p && p.asr && p.asr.model) || 'whisper-1';
    });
    /* 在线识别有没有落点：没有的话，本机识别卡里的「在线服务 / 自动」要说明先接一家云供应商。 */
    const asrOnlineReady = computed(() => {
      provEpoch.value;
      return !!hostKidOf('asr');
    });
    const asrProviderText = computed(() => {
      provEpoch.value;
      const p = asrProvider.value;
      if (!p) {
        if (String(asr.service.baseUrl || '').trim()) return '手填的接口地址';
        const names = (REG.providers || []).filter(x => x.kind === 'text' && x.asr)
          .map(x => x.name).slice(0, 4).join(' / ');
        return names
          ? '已声明语音识别，还没配密钥：' + names
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
        if ((p.extraCaps || []).indexOf(cap) < 0) return;
        if (!(cap === 'asr' ? p.asr : p.search)) return;
        const kid = String(p.keyId || p.id);
        if (seen.has(kid)) return;
        seen.add(kid);
        list.push({ id: p.id, name: p.name + (p.custom ? '（我的）' : '') });
      });
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
          asrMsg.value = '✓ 已保存（密钥只存在代理那一边）';
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
        { note: '清掉后只能重新填写；渠道与 .env 里那把不受影响。' })) return;
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
          searchMsg.value = '✓ 已保存（密钥只存在代理那一边）';
          return true;
        } catch (e) { searchMsg.value = '✗ ' + errText(e); return false; }
        finally { searchBusy.value = false; searchSaving = null; }
      })();
      return searchSaving;
    }
    /* 换在线服务商：型号回到这一家的默认值（placeholder 里写着），接口地址与单独那把密钥
       都属于上一家、一并清掉（服务端 patch 里有同一道）——不清的话，上一家的地址会把
       这一家的密钥发到别人的域名上。表单本身也搬到新那家的账号卡里（能力在哪家、设置就在哪家）。 */
    function onAsrProvChange() {
      asr.service.model = '';
      asr.service.baseUrl = '';
      asr.service.hasKey = false;
      asrKey.value = '';
      asr.route = 'service';
      asrMsg.value = '换了在线服务商：上一家的接口地址 / 型号 / 单独密钥已清空';
      renderProv();
    }
    /* 语音识别路线（本机识别那张卡里）：换路线会改变「谁顶着这一档」，重画一次状态牌。 */
    function onAsrRouteChange() {
      renderProv();
    }
    function onSearchProvChange() {
      /* 换一家 = 上一家的接口地址 / 型号 / 单独密钥都作废（服务端 patch 里也有同一道）。
         留在框里的上一家地址会把这一家的密钥发到别人的域名上；界面上先把值清掉，
         免得下一次自动保存又把旧值原样发回去。 */
      search.baseUrl = '';
      search.model = '';
      search.credentialSource = 'channel';
      searchKey.value = '';
      search.hasKey = false;
      searchMsg.value = '换了搜索服务：上一家的接口地址 / 型号 / 单独密钥已清空';
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
        { note: '清掉后只能重新填写；渠道与 .env 里那把不受影响。' })) return;
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
       这一页有两栏：左边是目录（5 组 15 行，一行一个栏目标题），
       右边是 15 张卡排成的一条文档（组标题钉在顶上，状态行钉在底下）。
       目录、组名、栏目标题全部**从 DOM 现读**（下面这几个函数），JS 里没有第二份清单 ——
       否则轨上那一行与卡里画着的那一项就会各说各话。 */
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

    /* ---------- 目录轨：画那棵树 ----------
       一行 = 图标 + 栏目标题。只做索引：不摆当前值（用户点名：左栏右边那一列压短字太吵，
       值到右边那张卡里看）。 */
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
        rows.forEach(c => {
          const id = c.dataset.nav;
          const hits = cardHits.get(c) || [];
          const on = id === curNavId;
          const icEl = c.querySelector('.card-h .card-ic');
          const ico = (icEl && icEl.innerHTML) || window.icon('folder', 16);
          html += '<a class="set-rail-i' + (on ? ' on' : '') + (filtering && !hits.length ? ' dim' : '')
            + '" href="#" data-nav="' + window.esc(id) + '" title="' + window.esc(navTitleOf(c)) + '">'
            + '<span class="set-rail-ic">' + ico + '</span>'
            + '<span class="set-rail-n">' + window.esc(navTitleOf(c)) + '</span></a>';
        });
      });
      /* 整棵树是 innerHTML 重来的，而这一栏自己就是滚动容器（宽窗竖滚 / 窄窗横滚）：
         筛选时每敲一个字重画一次，滚到下半截的目录轨会被夹回起点。公共件按「第几行」还位。
         ⚠ 轨上那一行的跳转（scrollToEl）走的是**右边那条文档**，不在这一次重画里，不受影响。 */
      window.Wb.viewport.keep(box, () => {
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
      /* Skill 轨的 max-height 要按**这条文档的滚动口**算：100vh 里还含着页头与状态行，
         矮窗下按它算出来的轨比滚动口还高，轨底被裁掉。0 是还没排版的读数，不覆盖。 */
      const h = Math.round(doc.clientHeight);
      if (h > 0) doc.style.setProperty('--setdoc-h', h + 'px');
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
    const ROW_SEL = '.krow, .sub-line, .acct, .crow, .capadd, .polish-block, .cloud-box, .cloud-row, .sk-item,'
      + ' .ui-note, .cus-acts, .search-hit, .ref, .mlist-row, .preset';
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
      /* 轨上那一句只在「一个字都没命中」时出现：命中数已经在轨底那一行里。 */
      navSum.value = navSumErr.value
        ? ('「' + terms.join(' ') + '」没有命中')
        : '';
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
          /* 文档滚动口自己的高度也跟着窗口 / 状态行变（--setdoc-h 的来路）。 */
          try { navRO.observe(doc); } catch (e) {}
        }
      }
      window.addEventListener('resize', setDocAnchor);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(setDocAnchor).catch(() => {});
      /* 两类变化都要跟着重算：① 某一栏被页面自己临时打开 / 收起（hidden 一变，目录就该变）；
         ② 栏里的行是异步补出来的（体检、用量、供应商卡、清单行）—— 命中数与底色得跟上。
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
        ? '刚才那一项改动还没落到本机：现在离开这一页，那几项可能还是旧的。' : '';
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
        failed.value = '公共模块没有就绪';
        if (window.PageReport) PageReport.pageFail('设置', failed.value);
        return;
      }
      if (window.Dropdowns) Dropdowns.build(rootEl.value);
      initCusForm();
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
      /* 外壳那一轮余额取回来 → 卡底那几枚余额就地换新（不整片重画卡片）。 */
      window.addEventListener('sb-balance-updated', paintAccountBalances);
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
      refreshBackupCenter();
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
      window.removeEventListener('sb-balance-updated', paintAccountBalances);
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

    /* ---------- 账号卡流（`settings/accounts.js`）----------
       一张账号卡 = 存密钥的那一格（keyId）。那一块的归并 / 状态牌 / 卡面 HTML / 事件委托 /
       手动档位声明 / 型号面板的槽名都在里面；这一页递进去的是**跨层共享的那几样**：
       DOM 容器（卡片流本体 + 三块表单的落点）、注册表与环境密钥的现读口、型号面板的读写口、
       自动保存的出口（markChanged）、两条通道的当前设置（asr / search）。
       草稿（密钥 / 清除 / 暂时不用 / 「作用文字 AI」那一家）住在这一层，落盘仍由这一页统一做。 */
    const {
      provGroups, provUsable, curTextId, autoServiceKid, hostKidOf, allCaps, acctAll,
      draftKey, keyFor, keyCleared, keyDraft, acctOffSet, panelOpen, fetchNote,
      slotKey, slotKid, slotCap, slotOfProv, provBySlot,
      renderProv, refreshProvNotes, paintAccountBalances, acctMsg,
      textPick, setTextPick,
    } = createAccountCards({
      ic, q, qa,
      provEpoch, setDocEl, acctToolsEl, provListEl, provErrEl, acctParkEl,
      asrFormEl, asrLocalFormEl, searchFormEl, cusCardEl, cusShown,
      regOf: () => REG, envOf: () => envInfo, textFormOf: () => textForm,
      markChanged, msgOf, useFormCreds, autofetchTried, onPanelClick, onPanelChange,
      syncServiceProvs, openCus, hideCus, pickCusCap, editCus, removeCus, afterCustomChanged,
      asr, asrLocal, asrBrowser, search,
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      rootEl, failed,
      setRailEl, setDocEl, setQEl, setQ, syncNav, onNavKey, navHasFilter, clearNav, navSum, navSumErr,
      navSumShort, navPos,
      saveText, saveKind,
      acctToolsEl, provListEl, provErrEl, acctParkEl,
      asrFormEl, asrLocalFormEl, searchFormEl,
      cusCardEl, cusShown, cusMineShown, cusMineGroups, cusEditing, editCus, removeCus, hideCus,
      cusCapEl, cusCapsBoxEl, cusNamePh,
      cusNameEl, cusName, cusBaseEl, cusBase, cusKeyEl, cusKey, cusKeyShown,
      cusFetchBusy, addCus, cusAddText, cusCancelShown, cancelCus, cusCount, cusMsg, cusMsgCls,
      pageBoxEl, uiPrefsBoxEl, storePrefsBoxEl, charsBoxEl,
      netBoxEl, storeRowsEl, assistantBoxEl, polishBoxEl, modelBoxEl,
      dataInfo, dataInfoTitle, dataMsg, persistInfo, persistGranted, dataBusy,
      copyDataDir, reloadDataInfo, askPersist, pushData, pullData, exportAll, pickImportAll, onImportAllFile,
      backupInfo, backupMsg, backupRows, backupBusy, backupListEl, refreshBackupCenter, createBackup, verifyBackup,
      impAllFileEl,
      cloudUrl, cloudUrlHint, cloudUser, cloudPass, cloudKeys, cloudPrompts,
      saveCloud, cloudMsg, cloudState,
      cloudBusy, cloudCall, cloudAbort, cloudPush, cloudSync, cloudPull, cloudConflictsEl,
      sysRowsEl, sysMsg, sysCopyDisabled, sysBusy, recheckSys, copySys,
      usageRowsEl, usageMsg, usageCopyDisabled, usageBusy, recountUsage, copyUsage, usageGoSlotEl,
      cacheBusy, clearApiCache, clearMetaCache, clearThumbCache, clearMissedCache, histBoxEl, cacheUsage, cacheMsg,
      promptDir, promptInfo, promptMsg, promptRefresh,
      openPromptDir, promptOpenBusy, promptRecentEl,
      skillItems, skillMsg, skillBusy, skillFileEl, skillChipsEl,
      skillMode, skillTree, skillScene, skillSceneNow, skillSceneVars, skillSceneUnknown,
      skillSceneState, isSceneActive, isLastEnabled, pickSkillScene, openSkillAll, closeSkillAll, skillSceneNameOf,
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
