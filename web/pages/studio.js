/* 生成工作台（Vue 3，无构建）—— 由 studio.html 整页迁来。
   视频 / 图像 / 语音三合一：左栏一套表单按类型换内容，右栏是三类型合并的「这一台的生成历史」
   （它不是侧栏那个「资产库」—— 那一页读的是本机存下来的字节，这一栏读的是平台任务记录）。

   迁移方式：组件只负责「这一屏长什么样」（一份静态模板 + 一个根 ref），页面原来那一整段脚本
   原样搬进 `runPage()`，在挂载之后执行一次。这样每一条既有判据（能力驱动、AdvExtras、
   输入模式、拆分片段、轮询器、卡片、分页、复用、存回本机）都逐字保留，不被「重写一遍」漂开。
   与其他已迁移页一致：数据与副作用全部走公共层（Api / Capabilities / AssetLib / AssetLocal /
   Wb / TextAI / InlinePolish / Dropdowns / Toast …），这里不出现第二份实现。

   与旧页面的差异只在「宿主」这一层（都写在对应位置）：
     · `$()` 不再是 document.getElementById，而是本组件根节点下的登记表（data-r / 动态块里的 id）；
     · 类型入口 `?t=` 现在在 hash 上，且要通知外壳（`window.__spaStudioType`）——
       `window.setType(t, fromUser)` 的语义与地址同步照旧；
     · 按类型各存的提示词在切回来时真的恢复（旧页面只存不读，与它自己那句「切回来不该丢」对不上）；
     · 分页那几颗按钮的 id 加 `st` 前缀（同一份文档里还有收藏 / 资产库两套 pgInfo）。 */
import { ref, inject, watch, nextTick, onMounted, onBeforeUnmount } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/studio.js';

/* 页面样式单独一份（外壳只引 ui.css 与 spa-pages.css）。已经由别处引过就不再插第二张。 */
(function ensureCss() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-spa-studio], link[href$="spa-studio.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'web/styles/spa-studio.css';
  l.setAttribute('data-spa-studio', '1');
  document.head.appendChild(l);
})();

/* 每一档只点一次名：`zh` 既画在分段开关上，也拼进提交按钮那一句（`生成` + `zh`）。 */
const TYPES = {
  video: { zh: '视频', provKind: 'video', adv: '高级设置' },
  image: { zh: '图像', provKind: 'image', adv: '生成设置' },
  audio: { zh: '音频', provKind: 'audio', adv: '合成设置' },
};
const TYPE_LIST = ['video', 'image', 'audio'];

function newState() {
  return {
    model: '',                                  // '平台id::型号id'
    prompt: '',
    style: '',                                  // 音色设计模型的风格描述
    topBools: {},                               // 平台顶层开关（create.topBools）的当前值，按类型各存一份
    shape: {},                                  // create.shapeFields 声明的顶层非布尔字段
    autoVals: {},                               // 「上次是界面自动填的」——只记值
    touched: {},                                // 用户亲手点过哪些控件（键 = 控件 id）
    liveModels: null,                           // 语音台现取的型号：{ 平台id: [型号] }
    inputs: { image: [], video: [], audio: [], frame_first: [], frame_last: [] },
    combo: '',                                  // 选中的「输入模式」（Capabilities.combos 的一条 id）
    lastModelId: '',                            // 参数面板上一次是给哪个型号画的
  };
}

/* 高级设置里三块类型面板的骨架（控件常驻 DOM、换类型只翻 hidden：用户挑过的值原地不动）。 */
const ADV_BODY_HTML =
  '<div class="adv-type" data-t="video">'
  + '<div class="adv-grid">'
  + '<div id="tierWrap"><label>档位</label><select id="tier"></select></div>'
  + '<div id="resWrap"><label>画质</label><select id="res"></select></div>'
  + '<div id="durWrap"><label>时长（秒）</label><select id="dur"></select></div>'
  + '<div id="arWrap"><label>画面比例</label><select id="ar"></select></div>'
  + '</div><div class="adv-grid"><div id="drawWrap"><label>生成条数</label><select id="draw"></select><div class="sel-hint" id="drawHint"></div></div></div>'
  + '<div class="adv-grid" id="boolRows" style="margin-top:10px"></div>'
  + '</div>'
  + '<div class="adv-type" data-t="image" hidden>'
  + '<div class="adv-grid">'
  + '<div id="qualityWrap" hidden><label>质量</label><select id="quality"></select></div>'
  + '<div id="ratioWrap" hidden><label>画面比例</label><select id="ratio"></select><div class="sel-hint" id="ratioHint"></div></div>'
  + '<div id="sizeWrap" hidden><label>尺寸</label><select id="size"></select></div>'
  + '<div id="countWrap" hidden><label>数量</label><select id="count"></select><div class="sel-hint" id="countHint"></div></div>'
  + '<div id="formatWrap" hidden><label>格式</label><select id="format"></select><div class="sel-hint" id="formatHint"></div></div>'
  + '</div></div>'
  + '<div class="adv-type" data-t="audio" hidden>'
  + '<div class="adv-grid">'
  + '<div id="voiceCol"><label>音色</label><select id="voice"></select></div>'
  + '<div><label>输出格式</label><select id="formatA"></select></div>'
  + '</div></div>'
  + '<div class="adv-grid" id="topBools" style="margin-top:10px" hidden></div>'
  + '<div class="adv-grid" id="shapeFields" style="margin-top:10px" hidden></div>';

const StudioView = {
  name: 'StudioView',
  setup() {
    const pageEl = ref(null);
    const activeFile = inject('spaActiveFile', null);
    const spaRoute = inject('spaRoute', null);
    /* 前台判据只有公共层那一份：core/activity.js（外壳挂在 window.__spaActivity）。
       这里原来自己读 `spaActiveFile`：那只说明「路由选中的是这一页」，标签页整页切到后台时
       它照样为真，于是看不见的工作台还在按秒重画「还有几条没落定」那一行。 */
    const isActive = () => window.__spaActivity.visible('studio.html');
    let cleanup = null;
    let disposed = false;

    /* 本页自己的节点登记表：模板上 data-r="名字" 的节点，以及被 innerHTML 灌进来的
       `#advBody` 里那批控件（键就是它们原来的 id）。原脚本里的 `$('tier')` 全部照旧能用，
       但一个 document.getElementById 都没有。 */
    const R = {};
    function collectMain() {
      if (!pageEl.value) return;
      pageEl.value.querySelectorAll('[data-r]').forEach(n => { R[n.dataset.r] = n; });
    }
    function collectAdv() {
      const box = R.advBody;
      if (!box) return;
      box.querySelectorAll('[id]').forEach(n => { R[n.id] = n; });
    }

    /* `?t=` / `reuse=1` 在 SPA 里挂在 hash 上（#studio.html?t=image）；直接打开旧地址时退回 search。 */
    function pageQuery() {
      const h = location.hash || '';
      const i = h.indexOf('?');
      if (i >= 0) return h.slice(i);
      return location.search || '';
    }

    function runPage() {
      const $ = id => R[id] || null;
      const disposers = [];
      const on = (target, ev, fn, opts) => {
        if (!target) return;
        target.addEventListener(ev, fn, opts);
        disposers.push(() => target.removeEventListener(ev, fn, opts));
      };
      let REG = { providers: [] };

      const ST = { video: newState(), image: newState(), audio: newState() };
      const cur = () => ST[TYPE];

      /* 「一键清空」的那份内存快照。清掉的是提示词 / 音色描述 / 参考素材 / 顶层开关，
         一次点错就全没了，所以清前先压一份、按钮翻转成「撤销清空」留 8 秒窗口。
         为什么撤销挂在按钮上而不是 toast 上：Toast 没有按钮位（receipt 只有一句话），
         再为这一件事造一个浮层就是第二套确认机制。
         快照只活在页面里，不落盘：参考素材的 blob: 地址已经释放，但每条浅拷贝仍带着 `file`，
         还原时重新 createObjectURL 就能把缩略图与提交用的字节一起找回来。
         声明放在最前面（而不是清空按钮那一处）：切类型时要能把窗口关掉，而 setType 在启动序列里就被调用。 */
      const CLEAR_UNDO_MS = 8000;
      let clearedShot = null;
      let clearedTimer = 0;
      function clearButtonPaint(undo) {
        const b = $('clearAll');
        if (!b) return;
        iconSet(b, undo ? 'undo' : 'trash', 14);
        btnText(b, undo ? '撤销清空' : '一键清空');
        b.title = undo ? ('点一下把刚才清掉的提示词、素材与参数放回来（' + (CLEAR_UNDO_MS / 1000) + ' 秒内有效）')
          : '清空提示词、素材与参数（会先问你一次）';
      }
      /* 过期 / 切类型 / 真的撤销了，都走这一条收摊。 */
      function dropClearShot() {
        clearTimeout(clearedTimer); clearedTimer = 0;
        if (!clearedShot) return;
        const m = clearedShot.inputs || {};
        Object.keys(m).forEach(k => (m[k] || []).forEach(releaseItemUrl));
        clearedShot = null;
        clearButtonPaint(false);
      }
      function restoreClearShot() {
        const shot = clearedShot;
        if (!shot) return;
        dropClearShot();
        const back = { image: [], video: [], audio: [], frame_first: [], frame_last: [] };
        Object.keys(back).forEach(k => {
          back[k] = (shot.inputs[k] || []).map(it => {
            const c = Object.assign({}, it);
            if (!c.url && c.file) { try { c.url = URL.createObjectURL(c.file); } catch (e) {} }
            return c;
          });
        });
        const s = cur();
        s.inputs = back;
        s.prompt = shot.prompt; s.style = shot.style;
        s.topBools = Object.assign({}, shot.topBools);
        if ($('prompt')) $('prompt').value = shot.prompt || '';
        if ($('style')) $('style').value = shot.style || '';
        renderInputArea(); renderParams(); updateMode(); refreshEst(); updateGoState();
        Toast.receipt('已撤销清空：提示词、素材与参数都放回来了', 'ok');
      }

      /* ============================ ① 类型 ============================ */
      function readTypeFromURL() {
        const m = /[?&]t=(video|image|audio)/.exec(pageQuery() || '');
        return m ? m[1] : '';
      }
      let TYPE = '';
      function setType(t, fromUser) {
        if (!TYPES[t]) t = 'video';
        /* 清空快照是「一栏一份」的：切了类型，那一栏的东西与按钮上「撤销清空」指的就不是同一样东西。 */
        if (TYPE && TYPE !== t) dropClearShot();
        TYPE = t;
        writeLS('studio_type', t);
        /* 常驻页面池里切页不 reload：类型变了要让外壳把 hash / 上次页一起改掉，
           否则刷新后会回到进来时那一档，而不是刚才在用的这一档。 */
        try {
          if (typeof window.__spaStudioType === 'function') window.__spaStudioType(t);
          else {
            const u = new URL(location.href);
            if (u.searchParams.get('t') !== t) { u.searchParams.set('t', t); history.replaceState(null, '', u.pathname + u.search + u.hash); }
          }
        } catch (e) {}
        const seg = $('typeSeg'), adv = $('advBody');
        if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
        if (adv) adv.querySelectorAll('.adv-type').forEach(b => { b.hidden = b.dataset.t !== t; });
        $('go').textContent = '生成' + TYPES[t].zh;
        $('advTitle').textContent = TYPES[t].adv;
        /* 每种类型各记一份提示词与音色描述：切回来接着写（旧页面只存不读，与它自己那句
           「切类型再切回来，写到一半的东西不该丢」对不上）。三份都在启动时从盘上读一次，
           之后只在输入时写盘 —— 切换时不再回读，免得「清空过又切回来」把旧稿捞出来。 */
        const s = cur();
        if ($('prompt')) $('prompt').value = s.prompt || '';
        if ($('style')) $('style').value = s.style || '';
        if (fromUser) paintLeft();
      }
      $('typeSeg').innerHTML = TYPE_LIST.map(k => '<button type="button" data-t="' + k + '"'
        + (k === (TYPE || 'video') ? ' class="on"' : '') + '>' + TYPES[k].zh + '</button>').join('');
      $('typeSeg').addEventListener('click', e => {
        const b = e.target.closest('button[data-t]');
        if (!b || b.dataset.t === TYPE) return;
        InlinePolish.clear($('polishInline'));
        setType(b.dataset.t, true);
        setStatus('');
      });

      /* ============================ ② 小工具 ============================ */
      const mediaOf = it => ((window.Api && Api.mediaSrc) ? Api.mediaSrc((it && (it.src || it.url)) || '') : ((it && (it.src || it.url)) || ''));
      const srcToDataURL = async src => {
        const r = await fetch((window.Api && Api.mediaSrc) ? Api.mediaSrc(src) : src);
        if (!r.ok) throw new Error('素材读取失败 HTTP ' + r.status);
        return await AssetTransfer.toDataURL(await r.blob());
      };
      const dataURLToB64 = durl => String(durl || '').replace(/^data:[^;]*;base64,/, '');
      function setStatus(html) { const el = $('status'); if (el) el.innerHTML = window.sanitizeHTML(html || ''); }
      const escA = s => window.esc(s);
      function syncDropdowns() {
        if (window.Dropdowns && pageEl.value) { Dropdowns.build(pageEl.value); Dropdowns.sync(pageEl.value); }
      }
      /* 本地存储只走 `Store` 那一份（信封 / 上限 / 配额提示）。以前这里是裸 localStorage +
         `catch {}`：浏览器存储写满了界面一句话都不说，用户以为「这一档记住了」，刷新又回到默认。
         旧值存的是裸字符串（还没转换成信封），所以读的时候先按信封取、取不到再摸一次原始值；
         下一次写入就落进信封，两种格式不会并存太久。 */
      function readLS(k, d) {
        const v = Store.read(k, null);
        if (typeof v === 'string') return v;
        try { const raw = localStorage.getItem(k); return raw == null ? d : raw; } catch (e) { return d; }
      }
      function writeLS(k, v) { Store.write(k, v, { label: '生成工作台记住的内容' }); }
      const PICK_KEY = 'studio_pick';
      /* 型号按类型各记一份，整包是一个对象：交给 Store 存信封（旧值是裸 JSON，同样先摸一次） */
      function loadPicks() {
        const v = Store.read(PICK_KEY, null);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(PICK_KEY) || 'null'); } catch (e) { return {}; }
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      }
      function savePick(type, val) {
        const all = loadPicks();
        all[type] = val;
        Store.write(PICK_KEY, all, { label: '生成工作台记住的型号' });
      }

      /* ============================ ③ 注册表与型号 ============================ */
      const groups = () => Api.pickable((REG.providers || []).filter(p => p.kind === TYPES[TYPE].provKind));
      function provLabelOf(id) {
        const hit = (REG.providers || []).find(p => p.id === id);
        const name = (hit && hit.name) || id || '';
        return name.replace(/\s*(生图|视频|图片|音频|音乐)$/, '') || name;
      }
      function provLabelFor(it) {
        const p = provById(it.provider);
        const known = it.mtype === '图片' || it.mtype === '视频' || window.isAudioType(it.mtype);
        const want = known ? window.mediaKindOf(it.mtype) : '';
        if (it.localAsset && p && want && p.kind !== want) return '本机';
        return provLabelOf(it.provider);
      }
      const provById = id => (REG.providers || []).find(p => p.id === id) || null;
      const provGroups = () => groups();
      function currentModel() {
        const val = $('model').value;
        const g = provGroups();
        /* modelDocs 也要查，而且查到的要和 p.models 里同 id 的那份合起来（声明兜底、能力优先）。 */
        for (const p of g) {
          const base = (p.models || []).concat((p.modelDocs) || []);
          for (const m of base) if (p.id + '::' + m.id === val) {
            const d = (p.models || []).find(x => x.id === m.id) || {};
            const out = Object.assign({}, m, d);
            out.options = Object.assign({}, m.options || {}, d.options || {});
            return { prov: p, model: out };
          }
        }
        const g0 = g[0];
        return g0 ? { prov: g0, model: (g0.models || [])[0] || {} } : { prov: null, model: {} };
      }
      function audioModels(prov) {
        const p = prov || null;
        const base = (p && p.models) || [];
        const declared = new Map((base.concat((p && p.modelDocs) || [])).map(m => [m.id, m]));
        const live = ((cur().liveModels || {})[p && p.id] || null);
        const off = m => !!(window.ModelPrefs && window.ModelPrefs.isOff(p, (m && m.id) || m));
        const list = (live && live.length) ? live.filter(m => !off(m)) : base;
        return list.map(m => {
          const d = declared.get(m.id) || {};
          const out = Object.assign({}, d, m);
          out.options = Object.assign({}, d.options || {}, m.options || {});
          return out;
        });
      }
      function renderModelOptions() {
        const sel = $('model');
        if (!sel) return;
        /* 每种类型各记一个型号（studio_pick）：本类型内存里那份优先，其次盘上记的那份，
           最后才是当前下拉值（换类型时它还是上一栏的型号，多半在新型号清单里根本不存在）。 */
        const prev = cur().model || loadPicks()[TYPE] || sel.value || '';
        const g = provGroups();
        let html;
        if (TYPE === 'audio') {
          const opts = g.map(p => ({ p, ms: audioModels(p) })).filter(x => x.ms.length);
          html = opts.length ? opts.map(({ p, ms }) =>
            '<optgroup label="' + escA(p.displayName || p.name) + '">'
            + ms.map(m => '<option value="' + escA(p.id + '::' + m.id) + '" title="' + escA(m.name || '') + '">' + escA(m.id) + '</option>').join('')
            + '</optgroup>').join('')
            : '<option value="">注册表里没有语音平台</option>';
        } else {
          html = g.map(p =>
            '<optgroup label="' + escA(p.displayName || p.name) + '">'
            + (p.models || []).map(m => '<option value="' + escA(p.id + '::' + m.id) + '" title="' + escA((m.name || '').replace(/"/g, '&quot;')) + '">' + escA(m.id) + '</option>').join('')
            + '</optgroup>').join('');
        }
        /* 选项没变就别碰 DOM：型号下拉是公共 Dropdowns 画的浮层，重画一次就换掉节点。 */
        const listChanged = sel.innerHTML !== html;
        if (listChanged) sel.innerHTML = html;
        const ok = prev && [...sel.options].some(o => o.value === prev);
        const next = ok ? prev : (sel.options[0] ? sel.options[0].value : '');
        const valChanged = sel.value !== next;
        if (valChanged) sel.value = next;
        if (sel.value) { cur().model = sel.value; savePick(TYPE, sel.value); }
        if (listChanged || valChanged || !sel._ddBuilt) syncDropdowns();
        if (TYPE === 'audio') loadLiveAudioModels();
      }
      const LIVE = { key: '', busy: null };
      async function loadLiveAudioModels() {
        if (TYPE !== 'audio') return;
        if (LIVE.busy) return;
        const run = (async () => {
          const st = cur();
          let env = {}, envKnown = false;
          try { env = await Api.envStatus(); envKnown = !!(Api.envKnown && Api.envKnown()); } catch (e) { env = {}; }
          const canJudge = !!(envKnown && Api.provUsable);
          const provs = provGroups().filter(p => p.endpoints && p.endpoints.models
            && (canJudge ? Api.provUsable(p, env) : true));
          const key = provs.map(p => p.id).join(',');
          if (key === LIVE.key) return;
          LIVE.key = key;
          if (!provs.length) return;
          st.liveModels = {};
          const got = await Promise.all(provs.map(async prov => {
            try {
              const d = await Api.request(prov, 'models');
              const list = Api.modelRows(d).map(m => (m && (m.id || m.name)) || '').filter(Boolean);
              const re = prov.modelsFilter ? new RegExp(prov.modelsFilter) : null;
              const found = list.filter(id => !re || re.test(id));
              if (!found.length) return null;
              const declared = new Map((prov.models || []).concat(prov.modelDocs || []).map(m => [m.id, m]));
              return [prov.id, found.map(id => declared.get(id) || Object.assign({ id, name: id }, prov.newModelDefaults || {}))];
            } catch (e) {
              console.warn('[studio] ' + (prov.name || prov.id) + ' 的型号列表接口不可用，用注册声明：', e.message);
              return null;
            }
          }));
          const okList = got.filter(Boolean);
          if (!okList.length) LIVE.key = '';
          okList.forEach(pair => { st.liveModels[pair[0]] = pair[1]; });
          if (TYPE !== 'audio' || cur() !== st) return;
          const keep = $('model').value;
          renderModelOptions();
          if (keep && [...$('model').options].some(o => o.value === keep)) $('model').value = keep;
        })();
        LIVE.busy = run;
        try { return await run; }
        finally { if (LIVE.busy === run) LIVE.busy = null; }
      }
      $('model').addEventListener('change', () => {
        cur().model = $('model').value;
        savePick(TYPE, cur().model);
        paintLeft();
        refreshCaps();
      });
      function paintSubNote() {
        const el = $('stSub');
        if (!el) return;
        const { prov } = currentModel();
        const lead = [];
        if (TYPE === 'audio') {
          const all = Api.pickable((REG.providers || []).filter(p => p.kind === 'audio'));
          if (all.length > 1 && prov) lead.push('当前这一家：' + (prov.displayName || prov.name) + '（共 ' + all.length + ' 家，在上面的型号下拉里换）');
        }
        let txt = lead.join(' · ');
        if (prov) {
          const src = (window.Capabilities && Capabilities.sourceOf) ? Capabilities.sourceOf(prov) : null;
          const bits = [];
          if (txt) bits.push(txt);
          if (src) bits.push(Capabilities.srcTextOf(src));
          if (TYPE !== 'audio') bits.push(prov.displayName || prov.name);
          txt = bits.join(' · ');
        }
        el.textContent = txt;
        el.classList.toggle('warn', false);
      }

      /* ============================ ④ 素材槽（三种类型共用一套） ============================ */
      const ROLE_ZH = (window.Capabilities && Capabilities.ROLE_ZH) || {};
      const SLOT_DEF = {
        image: { label: '参考图', ic: 'image', accept: 'image/*', role: 'reference_image' },
        video: { label: '参考视频', ic: 'film', accept: 'video/*', role: 'reference_video' },
        audio: { label: '参考音频', ic: 'mic', accept: 'audio/*', role: 'reference_audio' },
        frame_first: { label: '开头画面', ic: 'image', accept: 'image/*,video/*', role: 'first_frame', videoFrame: 'last',
          hint: '图片；选视频则取其最后一帧' },
        frame_last: { label: '结尾画面', ic: 'image', accept: 'image/*', role: 'last_frame' },
      };
      const ROLE_KIND = { reference_image: 'image', reference_video: 'video', reference_audio: 'audio',
        first_frame: 'frame_first', last_frame: 'frame_last' };
      let slots = [];
      let overSlot = null;
      const inputs = () => cur().inputs;
      function slotItems(kind) { const m = inputs(); if (!m[kind]) m[kind] = []; return m[kind]; }
      function slotTakesType(kind, mtype) {
        const def = SLOT_DEF[kind] || {};
        const acc = String(def.accept || '');
        if (mtype === '视频') return !!def.videoFrame || acc.includes('video');
        if (window.isAudioType(mtype)) return acc.includes('audio');
        return acc.includes('image');
      }
      const comboLabel = cb => (window.Capabilities && Capabilities.comboLabel) ? Capabilities.comboLabel(cb) : '';
      function comboList() {
        const { model } = currentModel();
        return (window.Capabilities && Capabilities.combos) ? Capabilities.combos(model) : [];
      }
      function comboNow() { return comboList().find(c => c.id === cur().combo) || null; }
      function heldRoles() { return Object.keys(SLOT_DEF).filter(k => slotItems(k).length).map(k => SLOT_DEF[k].role); }
      function fitComboFor(roles) {
        return (window.Capabilities && Capabilities.comboCovering)
          ? Capabilities.comboCovering(currentModel().model, roles) : null;
      }
      const comboNote = cb => (window.Capabilities && Capabilities.comboScopeNote) ? Capabilities.comboScopeNote(cb) : '';
      const comboChips = (list, id) => (window.Capabilities && Capabilities.comboChipsHTML) ? Capabilities.comboChipsHTML(list, id) : '';
      function ensureCombo() {
        const s = cur();
        if (!window.Capabilities || !Capabilities.fallbackCombo) { if (!comboList().length) s.combo = ''; return; }
        const want = Capabilities.fallbackCombo(currentModel().model, s.combo, heldRoles());
        if (s.combo !== want) s.combo = want;
      }
      function setCombo(id) {
        const s = cur();
        if (!id || s.combo === id || !comboList().some(c => c.id === id)) return;
        s.combo = id;
        paintLeft();
      }
      function renderModeChips() {
        const head = $('modeHead'), row = $('modeRow');
        const list = comboList();
        if (!list.length) {
          if (head) head.hidden = true;
          if (row) { row.hidden = true; row.innerHTML = ''; }
          return;
        }
        const cb = comboNow();
        if (head) {
          head.hidden = false;
          const note = $('modeHeadNote');
          if (note) note.textContent = comboNote(cb);
        }
        if (!row) return;
        const chips = comboChips(list, cur().combo);
        if (!chips) { row.hidden = true; row.innerHTML = ''; return; }
        row.hidden = false;
        row.innerHTML = chips;
        row.querySelectorAll('.ui-pill').forEach(b => { b.onclick = () => setCombo(b.dataset.cid); });
      }
      function modelSlots() {
        ensureCombo();
        const { model } = currentModel();
        const specs = (window.Capabilities && model) ? Capabilities.specs(model)
          : ((model && model.options && model.options.inputSpecs) || []);
        const cb = comboNow();
        const inCombo = cb ? new Set((cb.roles || []).map(r => r.role)) : null;
        const merged = [];
        specs.forEach(sp => {
          const kind = ROLE_KIND[sp.role];
          if (!kind) return;
          if (inCombo && !inCombo.has(sp.role)) return;
          let max = sp.max || 1;
          if (inCombo && window.Capabilities && Capabilities.rule) {
            max = Capabilities.rule(model, sp.role, cur().combo).max || 0;
          }
          max = TYPE === 'audio' ? 1 : Math.max(1, max);
          const hit = merged.find(y => y.kind === kind);
          if (hit) hit.max = Math.max(hit.max, max);
          else merged.push({ kind, max, role: sp.role, group: sp.group, accept: sp.accept || '', maxBytes: sp.maxBytes || 0 });
        });
        const ORDER = ['frame_first', 'frame_last', 'image', 'video', 'audio'];
        const rank = k => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i; };
        merged.sort((a, b) => rank(a.kind) - rank(b.kind));
        return merged;
      }
      function slotCounts() {
        const counts = {};
        Object.keys(SLOT_DEF).forEach(k => { const r = SLOT_DEF[k].role; if (r) counts[r] = slotItems(k).length; });
        return counts;
      }
      /* 差集与那句人话都取自 GenRules 那一份（它内部才是 Capabilities.comboGaps）：
         黄条与提交前那一句读同一份，页面不再自己算一遍数量与名字。 */
      function shapeGaps() {
        if (window.GenRules && GenRules.gaps) {
          const g = GenRules.gaps(currentModel().model, cur().combo, slotCounts());
          return Object.assign({ ok: !(g.missing.length || g.over.length || g.rejected.length || g.conflicts.length) }, g);
        }
        if (!window.Capabilities || !Capabilities.comboGaps) return { missing: [], over: [], rejected: [], conflicts: [], lines: [], ok: true };
        return Capabilities.comboGaps(currentModel().model, cur().combo, slotCounts());
      }
      function releaseItemUrl(it) {
        const u = it && it.url;
        if (u && String(u).startsWith('blob:')) { try { URL.revokeObjectURL(u); } catch (e) {} it.url = ''; }
      }
      function removeSlotItem(kind, i) { const arr = slotItems(kind); const hit = arr[i]; if (!hit) return; arr.splice(i, 1); releaseItemUrl(hit); }
      function clearSlot(kind) { slotItems(kind).forEach(releaseItemUrl); inputs()[kind] = []; }
      function usedRoles() { return slots.filter(s => slotItems(s.kind).length).map(s => s.role).filter(Boolean); }
      function blockedSlotKinds() {
        if (!window.Capabilities || !Capabilities.blockedRoles) return new Set();
        const blocked = Capabilities.blockedRoles(currentModel().model, usedRoles());
        return new Set(slots.filter(s => s.role && blocked.has(s.role)).map(s => s.kind));
      }
      function conflictHint(blockedKinds) {
        const label = k => SLOT_DEF[k].label;
        const blockers = slots.filter(s => slotItems(s.kind).length).map(s => label(s.kind));
        const blocked = slots.filter(s => blockedKinds.has(s.kind)).map(s => label(s.kind));
        return blocked.length
          ? '「' + blockers.join(' / ') + '」与「' + blocked.join(' / ') + '」不能同时使用（本型号声明一次请求只能选一组），清空后可切换'
          : '';
      }
      let slotHintTimer = null;
      function flashSlotHint(msg) {
        const el = $('inputArea') ? $('inputArea').querySelector('.conflict-hint') : null;
        if (!el) { if (msg) setStatus('<span class="err">' + msg + '</span>'); return; }
        if (msg) el.textContent = msg;
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        clearTimeout(slotHintTimer);
        slotHintTimer = setTimeout(() => {
          el.classList.remove('flash');
          if (el.isConnected) el.textContent = conflictHint(blockedSlotKinds());
        }, 2400);
      }
      function slotRoom(sl) { return Math.max(0, sl.max - slotItems(sl.kind).length); }
      function slotNote(sl) {
        const { prov, model } = currentModel();
        const bits = [];
        if (window.Capabilities && Capabilities.ruleText) { const t = Capabilities.ruleText(model, sl.role); if (t) bits.push(t); }
        const tpl = (window.Api && Api.inputTemplate) ? Api.inputTemplate(prov, sl.role) : null;
        if (tpl && tpl.requiresAudio) bits.push('需含音频轨');
        const def = SLOT_DEF[sl.kind];
        if (def.hint) bits.push(def.hint);
        return bits.filter(Boolean).join(' · ');
      }
      function slotTypes(sl) {
        const accept = sl.accept || SLOT_DEF[sl.kind].accept || '';
        const out = [];
        if (accept.includes('image')) out.push('图片');
        if (accept.includes('video') || SLOT_DEF[sl.kind].videoFrame) out.push('视频');
        if (accept.includes('audio')) out.push('音频');
        return out.length ? out : ['图片'];
      }
      async function addSlotFiles(kind, fileList) {
        const files = [...fileList];
        const def = SLOT_DEF[kind] || SLOT_DEF.image;
        const sl = slots.find(x => x.kind === kind);
        if (!sl) { setStatus('<span class="err">当前型号不支持「' + def.label + '」这类素材（可用入口见输入框下方的小方块）</span>'); return 0; }
        const max = sl.max;
        if (blockedSlotKinds().has(kind)) { flashSlotHint(def.label + '与已选素材互斥，请先清空已选素材'); return 0; }
        let added = 0;
        for (const f of files) {
          const arr = slotItems(kind);
          if (arr.length >= max) { setStatus('<span class="err">' + def.label + '最多 ' + max + ' 个</span>'); break; }
          const isAud = f.type.startsWith('audio/'), isVid = f.type.startsWith('video/');
          if (isAud && !def.accept.includes('audio')) { setStatus('<span class="err">' + def.label + '不支持音频文件</span>'); continue; }
          if (isVid) {
            if (def.videoFrame) {
              setStatus('正在从视频《' + (f.name || '') + '》取' + (def.videoFrame === 'last' ? '尾' : '首') + '帧…');
              try { arr.push(await Wb.vframe.fromFile(f, def.videoFrame)); arr[arr.length - 1].kind = kind; added++; setStatus('<span class="ok">✓ 已取该视频的最后一帧作为' + def.label + '</span>'); }
              catch (err) { setStatus('<span class="err">取帧失败：' + err.message + '</span>'); }
              continue;
            }
            if (!def.accept.includes('video')) { setStatus('<span class="err">' + def.label + '不支持视频文件</span>'); continue; }
            arr.push({ file: f, url: URL.createObjectURL(f), name: f.name, type: '视频', kind, fromLib: false });
            added++;
            continue;
          }
          if (isAud) {
            arr.push({ file: f, url: URL.createObjectURL(f), name: f.name, type: '音频', kind, fromLib: false });
            added++; continue;
          }
          if (!def.accept.includes('image')) { setStatus('<span class="err">' + def.label + '不支持图片文件</span>'); continue; }
          arr.push({ file: f, url: URL.createObjectURL(f), name: f.name, type: '图片', kind, fromLib: false });
          added++;
        }
        renderInputArea(); updateMode();
        return added;
      }
      async function openSlotPicker(sl) {
        const def = SLOT_DEF[sl.kind];
        const room = slotRoom(sl);
        if (room <= 0) { Toast.err(def.label + '已满（最多 ' + sl.max + ' 个）'); return; }
        const { model } = currentModel();
        const rule = (window.Capabilities && Capabilities.rule) ? Capabilities.rule(model, sl.role, cur().combo) : null;
        const vidBytes = def.videoFrame && window.Capabilities && Capabilities.rule
          ? (Capabilities.rule(model, 'reference_video', cur().combo).maxBytes || 0) : 0;
        if (rule && vidBytes > (rule.maxBytes || 0)) rule.maxBytes = vidBytes;
        const upAccept = [sl.accept, def.videoFrame ? 'video/*' : ''].filter(Boolean).join(',');
        const list = await AssetPicker.open({
          types: slotTypes(sl), multiple: room > 1, limit: room,
          rule: rule || null,
          chars: String(sl.accept || def.accept || '').includes('audio') ? 'audio' : undefined,
          title: '选择' + def.label + (room > 1 ? '（还能加 ' + room + ' 个）' : ''),
          upload: upAccept ? { accept: upAccept } : undefined,
        });
        if (!list || !list.length) return;
        let added = 0, missed = 0;
        const skipped = [];
        for (let i = 0; i < list.length; i++) {
          const en = list[i];
          const arr = slotItems(sl.kind);
          if (arr.length >= sl.max) {
            skipped.push('槽位已满，剩下 ' + (list.length - i) + ' 个没加');
            break;
          }
          if (en.dead) { missed++; continue; }
          if (en.file) {
            const n = await addSlotFiles(sl.kind, [en.file]);
            if (n) added += n; else skipped.push('本地文件没加进去');
            continue;
          }
          if (en.type === '视频' && !def.accept.includes('video') && !def.videoFrame) { skipped.push('这一格不收视频'); continue; }
          if (en.type === '图片' && !def.accept.includes('image')) { skipped.push('这一格不收图片'); continue; }
          if (en.assetId && arr.some(x => x.assetId === en.assetId)) { skipped.push('已经在槽里了'); continue; }
          if (en.type === '视频' && def.videoFrame) {
            setStatus('正在从资产库视频里取' + (def.videoFrame === 'last' ? '尾' : '首') + '帧…');
            try {
              const blob = await AssetTransfer.blobOf(en.dl || en.src);
              const name = ((en.prompt || 'video').replace(/\s+/g, ' ').trim().slice(0, 14) || 'video') + '.mp4';
              const vf = new File([blob], name, { type: blob.type || 'video/mp4' });
              const it = await Wb.vframe.fromFile(vf, def.videoFrame); it.kind = sl.kind;
              arr.push(it); added++;
              setStatus('<span class="ok">✓ 已取该视频的最后一帧作为' + def.label + '</span>');
            } catch (err) { skipped.push('取帧失败：' + err.message); }
            continue;
          }
          const item = { assetId: en.assetId, url: Api.mediaSrc(en.src), name: (en.prompt || '').slice(0, 14) || '资产',
            type: en.type, kind: sl.kind, fromLib: true, src: en.src };
          const usableId = window.AssetTransfer && AssetTransfer.isPlatformId(en.assetId);
          if (en.type === '图片' && (!usableId || !/^\/asset\//.test(String(en.src || '')))) {
            try {
              const blob = await AssetTransfer.blobOf(en.dl || en.src);
              const f = new File([blob], (item.name || 'ref') + '.png', { type: blob.type || 'image/png' });
              item.file = f; item.url = URL.createObjectURL(f); item.src = item.url; delete item.assetId;
            } catch (e) {}
          }
          arr.push(item); added++;
        }
        renderInputArea(); updateMode();
        const skipTxt = skipped.length ? '；另有 ' + skipped.length + ' 个没加：'
          + skipped.slice(0, 3).join('、') + (skipped.length > 3 ? ' 等' : '') : '';
        if (missed) setStatus('<span class="err">' + escA(window.Chars.Pipe.refAudioMiss())
          + '（没加入 ' + missed + ' 个）</span>' + (added ? '　·　其余 ' + added + ' 个已加入' : '') + skipTxt);
        else if (added) setStatus('<span class="ok">✓ 已加入 ' + added + ' 个素材</span>' + skipTxt);
        else if (skipped.length) setStatus('<span class="err">一个都没加进去：' + skipped.join('；') + '</span>');
      }
      function slotTileHTML(sl, it, i, blocked) {
        const def = SLOT_DEF[sl.kind];
        const items = slotItems(sl.kind);
        const cap = def.label + (items.length > 1 ? ' ' + (i + 1) : '');
        const name = it.name || (it.fromLib ? '资产库素材' : '本地文件');
        const fromVid = it.fromVideo ? '（取自视频《' + it.fromVideo + '》的' + (def.videoFrame === 'first' ? '第一帧' : '最后一帧') + '）' : '';
        const body = window.isAudioType(it.type)
          ? '<span class="ic">' + icon('mic', 18) + '</span><span class="sub">' + escA(name) + '</span>'
          : Wb.thumbs.mediaHTML(mediaOf(it), { type: window.mediaKindOf(it.type) === 'video' ? undefined : 'image' });
        return '<div class="asset-slot' + (blocked ? ' conflict' : '') + '" data-slot="' + sl.kind + '" data-i="' + i + '"'
          + ' title="' + escA(cap + '：' + name + fromVid + '（点 × 移除）') + '">'
          + body + '<button class="x iconbtn on-dark" title="移除这个素材">' + icon('close', 11) + '</button><span class="cap">' + escA(cap) + '</span></div>';
      }
      function wideSlotHTML(sl, it, i, blocked) {
        const def = SLOT_DEF[sl.kind];
        const note = slotNote(sl);
        if (it) {
          const name = it.name || (it.fromLib ? '资产库素材' : '本地文件');
          const thumb = it.type === '视频'
            ? '<span class="rvthumb">' + Wb.thumbs.mediaHTML(mediaOf(it)) + '</span>'
            : '<span class="ic">' + icon(def.ic, 18) + '</span>';
          return '<div class="slot-wide asset-slot has-media' + (blocked ? ' conflict' : '') + '" data-slot="' + sl.kind + '" data-i="' + i + '"'
            + ' title="' + escA(def.label + '：' + name + '（点 × 移除）') + '">'
            + thumb + '<span class="rvmeta"><b>' + escA(name) + '</b><span>' + def.label + (note ? ' · ' + escA(note) : '') + '</span></span>'
            + '<button class="x iconbtn on-dark" title="移除这个素材">' + icon('close', 11) + '</button></div>';
        }
        const items = slotItems(sl.kind);
        const sub = [];
        if (items.length) sub.push('已有 ' + items.length + ' / ' + sl.max);
        if (note) sub.push(note);
        return '<div class="slot-wide asset-slot' + (blocked ? ' blocked' : '') + '" data-slot="' + sl.kind + '"'
          + ' title="' + escA(blocked ? def.label + '：与已选素材互斥（一次请求只能选一组），清空已选后可添加'
            : def.label + '：点击选择素材（资产库 / 我的收藏 / 本地上传）') + '">'
          + '<span class="ic">' + icon(def.ic, 18) + '</span><span>' + (items.length ? '再加一个' : def.label) + '</span>'
          + (sub.length ? '<span class="sub">' + escA(sub.join(' · ')) + '</span>' : '') + '</div>';
      }
      const GRID_KINDS = ['image', 'frame_first', 'frame_last'];
      function bindSlotTile(t, sl, it, i, blocked) {
        const def = SLOT_DEF[sl.kind];
        const x = t.querySelector('.x');
        if (x) x.onclick = e => { e.stopPropagation(); removeSlotItem(sl.kind, i); renderInputArea(); updateMode(); };
        t.onclick = e => {
          if (e.target.closest('.x')) return;
          e.stopPropagation();
          if (blocked) { flashSlotHint(def.label + '与已选素材互斥，请先清空已选素材'); return; }
          openSlotPicker(sl);
        };
        if (it) { const med = t.querySelector('video, img'); if (med) Wb.thumbs.bind(t, med, mediaOf(it)); }
        return t;
      }
      function paintPromptHint() {
        const ta = $('prompt'), hint = $('promptHint');
        if (!ta) return;
        const b = window.CharLimits.tts(((currentModel().prov || {}).tts) || {});
        ta.placeholder = TYPE === 'audio'
          ? '要合成的文本' + (window.CharLimits.has(b) ? '（' + window.CharLimits.range(b) + ' 字）' : '')
            + '（数字、英文缩写建议写成读法）'
          : TYPE === 'image' ? '描述人物、动作、场景或感觉…'
            : '描述这一段视频的画面、镜头运动与氛围…';
        if (!hint) return;
        if (TYPE !== 'audio' || !window.CharLimits.has(b)) { hint.hidden = true; hint.textContent = ''; return; }
        const bits = [window.CharLimits.cntLine(ta.value, b)];
        const g = window.CharLimits.gap(ta.value, b);
        if (g) bits.push(g);
        const bad = window.CharLimits.over(ta.value, b);
        hint.hidden = false;
        hint.className = 'prompt-hint' + (bad ? ' bad' : '');
        hint.textContent = bits.join(' · ');
        $('promptBox').classList.toggle('over', bad);
      }
      function renderInputArea() {
        const area = $('inputArea');
        if (!area) return;
        slots = modelSlots();
        renderModeChips();
        {
          const a = renderTopBools(), b = renderShapeFields();
          if (a || b) refreshEst();
        }
        const ta = $('prompt');
        if (ta) {
          paintPromptHint();
          ta.title = slots.length ? '下方小方块可上传素材（可用哪些、几张、收什么文件，随所选型号的能力变化）；也可以把右栏的素材卡直接拖进来'
            : (comboNow() ? '当前输入模式不带素材，想带就换上面那一档' : '当前型号只支持纯文字生成，换个型号可解锁参考素材');
        }
        area.innerHTML = '';
        clearSlotOver();
        const head = $('slotHead'), headNote = $('slotHeadNote');
        if (head) {
          head.hidden = false;
          if (headNote) headNote.textContent = slots.length ? '点槽位选素材 · 同类内顺序即提交顺序'
            : (comboNow() ? '这一档不带参考素材（换上面一档就能加）' : '当前型号只支持纯文字生成，换个型号可解锁参考素材');
        }
        if (!slots.length) { updateGoState(); return; }
        const blockedKinds = blockedSlotKinds();
        const gridSlots = slots.filter(s => GRID_KINDS.indexOf(s.kind) >= 0);
        const wideSlots = slots.filter(s => GRID_KINDS.indexOf(s.kind) < 0);
        if (gridSlots.length) {
          const box = document.createElement('div');
          box.className = 'assets-grid';
          area.appendChild(box);
          gridSlots.forEach(sl => {
            const items = slotItems(sl.kind);
            const blocked = blockedKinds.has(sl.kind);
            items.forEach((it, i) => {
              const d = document.createElement('div');
              d.innerHTML = slotTileHTML(sl, it, i, blocked);
              box.appendChild(bindSlotTile(d.firstElementChild, sl, it, i, blocked));
            });
            if (slotRoom(sl) > 0) {
              const def = SLOT_DEF[sl.kind];
              const note = slotNote(sl);
              const a = document.createElement('div');
              a.className = 'asset-slot' + (blocked ? ' blocked' : '');
              a.dataset.slot = sl.kind;
              const sub = [];
              if (items.length) sub.push('已有 ' + items.length + ' / ' + sl.max);
              if (note) sub.push(note);
              a.innerHTML = '<span class="ic">' + icon(def.ic, 18) + '</span>'
                + (items.length ? '<span>再加一个</span>' : '<span>' + escA(def.label) + '</span>')
                + (sub.length ? '<span class="sub">' + escA(sub.join(' · ')) + '</span>' : '');
              a.title = blocked ? def.label + '：与已选素材互斥（本型号一次请求只能选一组），清空已选后可添加'
                : def.label + '：点击选择素材（资产库 / 我的收藏 / 本地上传'
                  + (items.length ? '，已有 ' + items.length + ' / ' + sl.max : '') + '）';
              a.onclick = e => {
                e.stopPropagation();
                if (blocked) { flashSlotHint(conflictHint(blockedKinds) || (def.label + '与已选素材互斥，不能同时使用')); return; }
                openSlotPicker(sl);
              };
              box.appendChild(a);
            }
          });
        }
        wideSlots.forEach(sl => {
          const items = slotItems(sl.kind);
          const blocked = blockedKinds.has(sl.kind);
          items.forEach((it, i) => {
            const d = document.createElement('div');
            d.innerHTML = wideSlotHTML(sl, it, i, blocked);
            area.appendChild(bindSlotTile(d.firstElementChild, sl, it, i, blocked));
          });
          if (slotRoom(sl) > 0) {
            const d = document.createElement('div');
            d.innerHTML = wideSlotHTML(sl, null, 0, blocked);
            const t = d.firstElementChild;
            t.onclick = e => {
              e.stopPropagation();
              if (blocked) { flashSlotHint(conflictHint(blockedKinds) || (SLOT_DEF[sl.kind].label + '与已选素材互斥，不能同时使用')); return; }
              openSlotPicker(sl);
            };
            area.appendChild(t);
          }
        });
        const hint = conflictHint(blockedKinds);
        if (hint) area.insertAdjacentHTML('beforeend', '<div class="hint conflict-hint">' + escA(hint) + '</div>');
        const gaps = shapeGaps();
        const gLines = gaps.lines;
        if (gLines.length) {
          const badKinds = [...new Set(gaps.rejected.concat(gaps.over).map(x => ROLE_KIND[x.role]))].filter(Boolean);
          const fit = fitComboFor(heldRoles());
          const canSwitch = !!(fit && fit.id !== cur().combo);
          const box2 = document.createElement('div');
          box2.className = 'conflict-hint';
          box2.style.color = 'var(--warn)';
          box2.innerHTML = gLines.map(x => '<div>' + escA(x) + '</div>').join('')
            + (canSwitch ? '<a href="#" class="lnk">切到「' + escA(comboLabel(fit)) + '」</a>' : '')
            + (badKinds.length ? (canSwitch ? ' 或 ' : '') + '<a href="#" class="lnk2">清空这些素材</a>' : '')
            + (!canSwitch && !badKinds.length ? (gaps.missing.length ? '：补上缺的那一类素材，或换一档 / 换型号'
              : '：换一档或换回支持的型号') : '');
          const go = box2.querySelector('.lnk');
          if (go) go.onclick = e => { e.preventDefault(); setCombo(fit.id); };
          const cl = box2.querySelector('.lnk2');
          if (cl) cl.onclick = e => { e.preventDefault(); badKinds.forEach(k => clearSlot(k)); renderInputArea(); updateMode(); };
          area.appendChild(box2);
        }
        updateGoState();
      }
      function updateMode() {
        const m = inputs();
        const used = Object.keys(SLOT_DEF).filter(k => (m[k] || []).length);
        if (TYPE === 'audio') {
          const mode = curTtsMode();
          $('mode').textContent = mode === 'clone' ? '音色复刻' : (mode === 'design' ? '音色设计' : '文生语音');
          return;
        }
        $('mode').textContent = used.length
          ? used.map(k => SLOT_DEF[k].label + ' ×' + m[k].length).join(' · ')
          : (TYPE === 'image' ? '文生图' : '文生视频');
      }

      /* ============================ ⑤ 参数面板 ============================ */
      $('advBody').innerHTML = ADV_BODY_HTML;
      collectAdv();
      const RATIO_HINT = {
        '1:1': ['方形，适合头像与商品图', ''], '16:9': ['横屏，适合风景与视频感画面', 'land'], '9:16': ['竖屏，适合手机全屏与人物', 'port'],
        '4:3': ['横版，构图更稳', 'land'], '3:4': ['竖版，人物更显高', 'port'], '3:2': ['横版，接近相机比例', 'land'],
        '2:3': ['竖版海报比例', 'port'], '21:9': ['超宽，电影宽银幕', 'land'], '4:5': ['竖版，社交平台常用', 'port'],
      };
      function sizePxText(s) {
        const v = String(s == null ? '' : s).trim();
        if (!v) return '';
        return /^\d+\s*[x×*]\s*\d+$/.test(v) ? v.replace(/\s*[x*]\s*/g, '×') : v;
      }
      const MODE_ZH = { preset: '预设音色', design: '音色设计', clone: '音色复刻' };
      function fillSel(sel, values, fmt, defKey, id, opts) {
        if (!sel || !values || !values.length) return;
        const o = opts || {};
        const av = cur().autoVals;
        const prev = sel.value;
        const untouched = !(cur().touched || {})[id];
        const defs = o.defaults || {};
        sel.innerHTML = values.map(v => '<option value="' + escA(String(v)) + '">' + escA(fmt ? fmt(v) : String(v)) + '</option>').join('');
        const has = v => v !== undefined && v !== null && values.some(x => String(x) === String(v));
        const dflt = defKey ? defs[defKey] : undefined;
        let next;
        if (untouched && has(dflt)) next = String(dflt);
        else if (has(prev)) next = prev;
        else if (has(dflt)) next = String(dflt);
        else next = String(values[0]);
        sel.value = next;
        av[id] = next;
        if (window.Dropdowns) window.Dropdowns.sync(sel);
      }
      const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
      const val = id => { const el = $(id); return el ? el.value : ''; };
      function noteModel(m) {
        const s = cur();
        if (s.lastModelId !== (m && m.id)) { s.lastModelId = m && m.id; s.touched = {}; }
      }
      function modelLimits(m) {
        const o = (window.Capabilities && Capabilities.scopedOptions)
          ? Capabilities.scopedOptions(m, cur().combo) : ((m && m.options) || {});
        const maxOut = Number(o.max_outputs) > 0 ? Math.max(1, Math.floor(Number(o.max_outputs))) : 1;
        const maxRef = (window.Capabilities && m && m.id) ? Math.max(0, Capabilities.rule(m, 'reference_image', cur().combo).max) : 0;
        return { maxOut, maxRef, defs: o.defaults || {} };
      }
      const ADV = {
        video: { kinds: AdvParams.VIDEO_KINDS, units: { count: '条' }, prefix: true,
          ids: { tier: 'tier', resolution: 'res', aspect_ratio: 'ar', size: 'size', duration: 'dur', count: 'draw' } },
        image: { kinds: AdvParams.IMAGE_KINDS, units: { count: '张' },
          ids: { quality: 'quality', aspect_ratio: 'ratio', size: 'size', output_format: 'format', count: 'count' } },
      };
      function advPlan(model, family) {
        const a = ADV[family], ids = a.ids || {}, t = cur().touched || {};
        const now = {}, vals = {};
        a.kinds.forEach(k => {
          const id = ids[k];
          vals[k] = val(id);
          if (t[id]) now[k] = 1;
        });
        return AdvParams.plan(model, {
          kinds: a.kinds, ids: ids, cur: vals, touched: now, units: a.units,
          scoped: true, combo: cur().combo,
          prefix: a.prefix ? ((model && model.name) || '') : '',
        });
      }
      function paintSel(k) {
        const sel = $(k.id);
        if (!sel) return;
        sel.innerHTML = AdvParams.optionsHTML(k);
        sel.value = k.value;
        cur().autoVals[k.id] = k.value;
        if (window.Dropdowns) window.Dropdowns.sync(sel);
      }
      function paintAdv(plan) {
        Object.keys(plan.kinds).forEach(x => { const k = plan.kinds[x]; paintSel(k); show(k.id + 'Wrap', k.on); });
      }
      function renderVideoParams() {
        const { model } = currentModel();
        const changed = cur().lastModelId !== model.id;
        noteModel(model);
        const plan = advPlan(model, 'video');
        paintAdv(plan);
        const dc = plan.kinds.count;
        $('drawHint').textContent = dc.list.length > 1
          ? '单次最多 ' + dc.list.length + ' 条（按平台声明）· 视频一条一个任务提交' : '';
        renderBoolRows(model, changed);
        paintVideoHints(model);
      }
      function paintVideoHints(m) {
        $('advSum').textContent = advPlan(m || currentModel().model, 'video').summary;
      }
      function renderBoolRows(model, modelChanged) {
        const box = $('boolRows');
        if (!box) return;
        const b = window.AdvExtras.html.bools(model, { av: cur().autoVals, forceDef: !!modelChanged });
        box.innerHTML = b.html;
        box.hidden = !b.count;
        cur().autoVals._boolCount = b.count;
      }
      function readBoolParams() {
        return window.AdvExtras.boolsFromDom($('boolRows'), cur().autoVals);
      }
      function platTopBools() {
        return window.AdvExtras.topBoolDecls(currentModel().prov);
      }
      function shapeCaps() {
        const { model } = currentModel();
        if (TYPE === 'audio' || !model || !model.id) return null;
        if (!window.Capabilities || !Capabilities.shapeState) return null;
        return Capabilities.shapeState(model, cur().combo, heldRoles(), val('tier'));
      }
      function capRowKey() {
        const cs = shapeCaps();
        return [val('model'), cur().combo || '', val('tier'), heldRoles().join(','),
          cs ? (cs.known ? 'ok' : 'unknown') : 'nocaps'].join('|');
      }
      function topBoolCtx() {
        const cb = comboNow();
        return { mode: (cb && cb.mode) || '', intent: (cb && cb.intent) || '', caps: shapeCaps() };
      }
      function topBoolNow(d) {
        return window.AdvExtras.topBoolStateOf(d, topBoolCtx());
      }
      const BOOLS_FP = { v: '' };
      function renderTopBools(force) {
        const box = $('topBools');
        if (!box) return false;
        const prov = currentModel().prov;
        const st = cur().topBools || (cur().topBools = {});
        const decl = platTopBools();
        window.AdvExtras.prune(st, decl);
        const fp = capRowKey() + '|' + decl.map(([f, d]) => {
          const s = topBoolNow(d);
          return f + ':' + (s.hidden ? '!' + s.note : (s.def ? 'd' : 'o'));
        }).join(';');
        if (!force && fp === BOOLS_FP.v) return false;
        BOOLS_FP.v = fp;
        const h = window.AdvExtras.html.topBools(prov, currentModel().model, topBoolCtx(), st);
        box.innerHTML = h.html;
        box.hidden = !decl.length;
        if (window.fillIcons) fillIcons(box);
        return true;
      }
      function platShapeFields() {
        return window.AdvExtras.shapeFieldDecls(currentModel().prov);
      }
      function shapeFieldNow(d) {
        return window.AdvExtras.shapeFieldStateOf(d, shapeCaps(), topBoolCtx());
      }
      function shapeFingerprint() {
        return capRowKey() + '|' + platShapeFields().map(([f, d]) => {
          const s = shapeFieldNow(d);
          return f + ':' + (s.shown ? ((s.values || []).join('|') || 'free') : '!' + (s.why || ''));
        }).join(';');
      }
      let SHAPE_FP = '';
      function renderShapeFields(force) {
        const box = $('shapeFields');
        if (!box) return false;
        const fp = shapeFingerprint();
        if (!force && fp === SHAPE_FP) return false;
        SHAPE_FP = fp;
        const decl = platShapeFields();
        const st = cur().shape || (cur().shape = {});
        window.AdvExtras.prune(st, decl);
        if (!decl.length) { box.hidden = true; box.innerHTML = ''; return true; }
        const h = window.AdvExtras.html.shapeFields(currentModel().prov, shapeCaps(), topBoolCtx(), st);
        box.innerHTML = h.html;
        box.hidden = !h.shownCount && !h.muted.length;
        if (window.Dropdowns && box.querySelector('select[data-sf]')) Dropdowns.build(box);
        return true;
      }
      function advExtras(bools) {
        const { prov } = currentModel();
        const ctx = topBoolCtx();
        return window.AdvExtras.read({
          root: $('advBody'), prov: prov, ctx: ctx, caps: ctx.caps,
          topBoolState: cur().topBools || {}, shapeState: cur().shape || {}, bools: bools || {},
        });
      }
      function curImageModel() {
        const g = provGroups();
        for (const p of g) { const m = (p.models || []).find(x => p.id + '::' + x.id === $('model').value); if (m) return m; }
        const f = g[0] ? (g[0].models || [])[0] : null;
        return f || {};
      }
      function renderImageParams() {
        const m = curImageModel();
        noteModel(m);
        const plan = advPlan(m, 'image');
        paintAdv(plan);
        const cnt = plan.kinds.count, fmt = plan.kinds.output_format;
        $('countHint').textContent = cnt.list.length > 1
          ? '单次最多 ' + cnt.list.length + ' 张（按平台声明）' : '该型号单次只能 1 张';
        const src = (window.Capabilities && Capabilities.sourceOf) ? Capabilities.sourceOf(currentModel().prov) : null;
        const where = src ? Capabilities.srcTextOf(src) : '';
        $('formatHint').textContent = fmt.list.length > 1
          ? fmt.list.length + ' 种（' + (plan.defaults.output_format ? '平台默认 ' + String(plan.defaults.output_format).toUpperCase() : '未声明默认值') + '）· ' + where : '';
        paintImageHints();
      }
      function paintImageHints() {
        const r = val('ratio');
        const hint = RATIO_HINT[r];
        const px = sizePxText(val('size'));
        $('ratioHint').innerHTML = hint ? '<span class="' + hint[1] + '">' + hint[0]
          + (px ? ' · 按声明输出 ' + px : '') + '</span>' : '';
        $('advSum').textContent = advPlan(curImageModel(), 'image').summary;
      }
      function curAudioModel() {
        const list = audioModels(currentModel().prov);
        return list.find(m => $('model').value.split('::').pop() === m.id) || list[0] || {};
      }
      function curTtsMode() {
        const m = curAudioModel();
        const modes = (m.options && m.options.modes) || m.modes || [];
        if (modes.includes('voice_clone')) return 'clone';
        if (modes.includes('voice_design')) return 'design';
        if (modes.includes('text_to_speech')) return 'preset';
        return m.ttsMode || 'preset';
      }
      function renderAudioParams() {
        const prov = currentModel().prov;
        const models = audioModels(prov);
        const m = models.find(x => $('model').value.split('::').pop() === x.id) || models[0] || {};
        const fmts = window.TtsAdv.formats(prov, m);
        fillSel($('formatA'), fmts, f => f.toUpperCase() + (f === 'pcm16' ? '（会自动封装成 WAV）' : ''), null, 'formatA');
        const voices = window.TtsAdv.voices(prov, m);
        const vs = $('voice');
        const prevVoice = vs.value;
        vs.innerHTML = window.TtsAdv.voiceOptionsHTML(voices, prevVoice);
        if (prevVoice && [...vs.options].some(o => o.value === prevVoice)) vs.value = prevVoice;
        if (window.Dropdowns) window.Dropdowns.sync(vs);
        applyAudioCaps();
      }
      function syncStyleRow() {
        const row = $('styleRow');
        if (!row) return;
        row.hidden = !(TYPE === 'audio' && curTtsMode() === 'design');
      }
      function applyAudioCaps() {
        const mode = curTtsMode();
        show('voiceCol', mode === 'preset');
        syncStyleRow();
        paintPromptHint();
        $('advSum').textContent = [($('model').value.split('::').pop()), mode === 'preset' ? val('voice') : MODE_ZH[mode], val('formatA')].filter(Boolean).join(' · ');
      }
      function readAudioBools() {
        return window.TtsAdv.read(currentModel().prov, topBoolCtx(), cur().topBools || {}).topBools;
      }
      function renderParams() {
        if (TYPE === 'video') renderVideoParams();
        else if (TYPE === 'image') renderImageParams();
        else { renderAudioParams(); paintSubNote(); renderTopBools(); renderShapeFields(); updateGoState(); refreshEst(); return; }
        paintSubNote();
        renderShapeFields();
        syncDropdowns();
        renderTopBools();
        updateGoState();
        refreshEst();
      }
      $('advBody').addEventListener('click', e => {
        const tb = e.target.closest && e.target.closest('[data-tb]');
        if (!tb) return;
        const f = tb.dataset.tb;
        const st = cur().topBools || (cur().topBools = {});
        const decl = platTopBools().find(x => x[0] === f);
        st[f] = st[f] === undefined ? !topBoolNow(decl && decl[1]).def : !st[f];
        renderTopBools(true); refreshEst(); updateGoState();
      });
      $('advBody').addEventListener('change', e => {
        const tid = e.target && e.target.id;
        if (tid && cur().touched) cur().touched[tid] = 1;
        const sf = e.target && e.target.dataset ? e.target.dataset.sf : '';
        if (sf) (cur().shape || (cur().shape = {}))[sf] = e.target.value;
        if (e.target.id === 'model') { paintSubNote(); refreshEst(); updateGoState(); return; }
        if (TYPE === 'audio') applyAudioCaps();
        else if (TYPE === 'image') paintImageHints();
        else { readBoolParams(); paintVideoHints(); }
        renderShapeFields(); renderTopBools();
        refreshEst(); updateGoState();
      });
      $('advBody').addEventListener('input', e => {
        if (e.target.id === 'style') { updateGoState(); return; }
        const sf = e.target && e.target.dataset ? e.target.dataset.sf : '';
        if (sf) (cur().shape || (cur().shape = {}))[sf] = e.target.value;
      });
      const unfold = AdvParams.fold($('advHead'), $('adv'), 'studio_adv_closed');
      disposers.push(unfold);

      async function refreshCaps() {
        const { prov } = currentModel();
        if (!prov || !window.Capabilities) return;
        const hint = $('capHint');
        try {
          const d = await Capabilities.refreshProvider(REG, prov, {});
          if (!d) { hint.textContent = ''; paintSubNote(); return; }
          ensureCombo();
          renderParams(); renderInputArea();
          syncDropdowns();
          hint.textContent = Capabilities.srcTextOf(Capabilities.sourceOf(prov));
        } catch (e) {
          hint.textContent = '能力接口读取失败：' + e.message + '（仍按平台声明展示）';
        }
        paintSubNote();
      }

      /* ============================ ⑥ 费用预估 ============================ */
      let estGen = 0;
      let estShown = '';
      async function refreshEst() {
        const box = $('costTxt');
        const { prov, model } = currentModel();
        const gen = ++estGen;
        const alive = () => gen === estGen;
        if (!prov) { box.textContent = '注册表未加载'; return; }
        if (!estShown || box.textContent !== estShown) box.textContent = '估价中…';
        const put = html => { if (!alive()) return; estShown = html; if (box.innerHTML !== html) box.innerHTML = html; };
        if (TYPE === 'audio') {
          const pr = prov.pricing || {};
          const m = curAudioModel();
          const chars = ($('prompt').value || '').trim().length;
          if (pr.type === 'per_1k_chars' && m.price && m.price.per1kChars != null && chars) {
            const c = chars / 1000 * m.price.per1kChars;
            put('约 <b>' + (pr.currency || '¥') + c.toFixed(4) + '</b> <span class="note">' + chars + ' 字 × ' + (pr.currency || '¥') + m.price.per1kChars + '/千字</span>');
          } else if (pr.type === 'quote' && pr.endpoint) put('以平台实时报价为准');
          else put('<span class="note">平台未提供价格' + (chars ? '（本次 ' + chars + ' 字）' : '') + '</span>');
          return;
        }
        const cb = comboNow();
        if (!model || !model.id) { put(prov.name + ' · <span class="note">型号还没取到，取到之后自动重算</span>'); return; }
        const bools = readBoolParams();
        const ex = advExtras(bools);
        const ap = advPlan(model, TYPE === 'image' ? 'image' : 'video').payload;
        const params = Object.assign({}, ap, {
          prompt: $('prompt').value,
          count: TYPE === 'image' ? Math.max(1, Number(val('count')) || 1) : Math.max(1, Number(val('draw')) || 1),
          topBools: ex.topBools,
        });
        if (TYPE === 'video') Object.assign(params, {
          creation_intent: (cb && cb.intent) || '', mode: (cb && cb.mode) || '', caps: shapeCaps(),
        });
        Object.assign(params, ex.shapeFields);
        try {
          const r = await AssetLib.estimateCost(prov, model, params, {});
          put(r && r.ok
            ? prov.name + ' · <b>' + r.text + '</b> <span class="note">' + (r.detail || '') + '</span>'
            : (r && r.skip
              ? prov.name + ' · <span class="note">' + escA((r && r.reason) || '这一档平台不提供询价') + '，以平台结算为准</span>'
              : prov.name + ' · <span class="note">报价不可用（' + ((r && r.reason) || '平台未返回价格') + '），仍可生成</span>'));
        } catch (e) {
          put('<span class="note">估价失败：' + escAerrText(e) + '</span>');
        }
      }

      /* ============================ ⑦ 就绪判定 ============================
         判据整份在 web/domain/gen-rules.js（§6.1-3）：这里只做两件事 ——
           ① 把界面上的状态折算成 plain 数据（型号、提示词、槽位计数、语音方式、扩展字段的不合格项），
           ② 把结论码翻成**本栏的说法**。
         以前这里自己排一遍规则、助手那边再排一遍，同一组参数一边拦一边放；
         现在两侧只剩说法不同，「拦不拦、因为什么」是同一个 code。
         翻不出来的 code = 有人往 GenRules.CODES 里加了判据却没在这一侧给说法 —— 宁可说得泛，
         也绝不能返回空串（空串在 `Wb.ready` 那里等于「可以提交」，等于把新判据静默放行）。 */
      const BLOCK_ZH = {
        'no-provider': () => '注册表里没有可用的' + TYPES[TYPE].zh + '型号',
        'no-model': () => '注册表里没有可用的' + TYPES[TYPE].zh + '型号',
        'key-not-configured': v => '「' + ((v.args || {}).name || '') + '」还没配密钥，提交一定失败（设置页配好再来）',
        'provider-off': v => '「' + ((v.args || {}).name || '') + '」你在设置页里停用了，这一栏的下拉不该再有它（要去设置页重新启用）',
        'kind-text': () => '这一栏不提交文字任务（文字 AI 是给助手对话用的）',
        'kind-audio': () => '这一栏不提交语音合成',
        'empty-prompt': v => (v.args || {}).kind === 'audio' ? '请输入要合成的文本' : '请输入提示词',
        'param-value': v => '参数取值不在这一型号的声明里：' + (((v.args || {}).key) || '') + '（这一档能取的值请看「高级设置」）',
        /* 这三条的措辞本来就由公共层给（谁声明的规矩谁说话），这里只把它接出来。 */
        'tts-way': v => ((v.args || {}).why || ''),
        'char-limits': v => ((v.args || {}).why || ''),
        'shape-field': v => ((v.args || {}).why || ''),
        'slot-shape': v => (((v.args || {}).lines) || []).join('；'),
        'slot-pairs': v => (((v.args || {}).lines) || []).join('；'),
        'slot-source': v => '第 ' + (((v.args || {}).i) + 1) + ' 项素材取不到字节（换页之后本机的引用早失效了），重新选一次',
        'slot-template': v => '注册表没声明 ' + (((v.args || {}).role || '（没写槽位）')) + ' 的提交形状，这个槽位发不出去',
        'slot-bytes': v => '「' + (((v.args || {}).name) || '这份素材') + '」' + window.fmtBytes((v.args || {}).bytes || 0)
          + ' 超过 ' + ((v.args || {}).role) + ' 的单文件上限 ' + window.fmtBytes((v.args || {}).maxBytes || 0),
        'slot-accept': v => '「' + (((v.args || {}).name) || '这份素材') + '」是 ' + ((v.args || {}).mime || '未知类型')
          + '，' + ((v.args || {}).role) + ' 只收 ' + ((v.args || {}).accept || ''),
        'attachment-drift': () => '素材的来源变了，请重新选一次',
      };
      function blockText(v) {
        const f = BLOCK_ZH[v.code];
        const s = f ? String(f(v) || '') : '';
        return s || ('这一组参数还提交不了（' + v.code + '）');
      }
      function genFacts() {
        const { prov, model } = currentModel();
        const audio = TYPE === 'audio';
        return {
          surface: 'page', kind: TYPE, prov, model, prompt: $('prompt').value || '',
          combo: audio ? '' : cur().combo,
          slots: audio ? {} : slotCounts(),
          tts: audio ? { mode: curTtsMode(), design: $('style').value || '', ref: slotItems('audio').length } : null,
          /* 扩展字段（平台自己声明的那些）合格不合格由 AdvExtras 判 —— 它读的是画出来的那一排控件，
             这一条事实只有界面拿得到，所以由这里递进去，模块只决定「有不合格项就不许提交」。 */
          extrasBad: audio ? [] : advExtras().bad,
        };
      }
      function submitBlockReason() {
        /* 判据没装载完就**不许提交**（与动作注册表那侧同一立场：拿不到判据不等于判据通过）。
           正常路径下 shell.html 先把 web/domain/gen-rules.js 挂上，这里只是兜住加载顺序坏掉的情况。 */
        if (!window.GenRules || !GenRules.whyNot) return '提交判据还没有装载完（gen-rules.js 没加载），先刷新页面再试';
        const v = GenRules.whyNot(genFacts());
        return v ? blockText(v) : '';
      }
      /* 声明在 updateGoState 之前：这一带的 boot 序列里有人先调它，`let` 的暂时性死区会当场抛。 */
      let submitting = 0;
      function updateGoState() {
        if (!window.Wb) return;
        /* 「提交中」也算不就绪：Wb.ready 只看这条函数给的原因，动一下输入框就不会把在提交中的按钮重新点亮。 */
        Wb.ready({ btn: $('go'), tip: $('goWhy'), scope: $('leftCol'),
          reason: () => (submitting ? '正在提交这一轮生成（等平台响应），先等它落定' : submitBlockReason()) });
      }
      $('prompt').addEventListener('input', () => { updateGoState(); paintPromptHint(); if (TYPE === 'audio') refreshEst(); });
      $('prompt').addEventListener('change', updateGoState);
      $('clearAll').onclick = async () => {
        /* 按钮此刻是「撤销清空」→ 这一击就是撤销，不再问第二遍。 */
        if (clearedShot) { restoreClearShot(); return; }
        const m = inputs();
        const nSlots = Object.keys(m).reduce((n, k) => n + (m[k] || []).length, 0);
        const hasText = !!((($('prompt').value || '') + ' ' + ($('style').value || '')).trim());
        /* 本来就是空的：这不是「做完了」而是「你点了但什么都没发生」，必须出声（warn 一定弹）。 */
        if (!nSlots && !hasText) { Toast.warn('这一栏本来就是空的：没有提示词，也没有参考素材'); return; }
        const parts = [];
        if (hasText) parts.push(TYPE === 'audio' ? '要合成的文本与音色描述' : '提示词');
        if (nSlots) parts.push(nSlots + ' 个参考素材');
        parts.push('参数');
        const ok = await Confirm.ask({
          title: '清空这一栏？',
          body: '将清掉' + parts.join('、') + '（' + TYPES[TYPE].zh + '台当前这一栏，其他类型的不动）。'
            + '清掉后 ' + (CLEAR_UNDO_MS / 1000) + ' 秒内再点这个按钮可以撤销；过了这个窗口或切走类型就找不回来了。',
          okLabel: '清空', cancelLabel: '先不清', danger: true,
        });
        if (!ok) return;
        clearedShot = {
          type: TYPE,
          prompt: $('prompt') ? $('prompt').value : (cur().prompt || ''),
          style: $('style') ? $('style').value : (cur().style || ''),
          topBools: Object.assign({}, cur().topBools),
          inputs: Object.keys(m).reduce((o, k) => { o[k] = (m[k] || []).map(it => Object.assign({}, it)); return o; }, {}),
        };
        Object.keys(m).forEach(k => (m[k] || []).forEach(releaseItemUrl));
        cur().inputs = { image: [], video: [], audio: [], frame_first: [], frame_last: [] };
        cur().prompt = ''; cur().style = ''; cur().topBools = {};
        $('prompt').value = ''; $('style').value = '';
        InlinePolish.clear($('polishInline'));
        renderInputArea(); renderParams(); updateMode(); refreshEst(); setStatus('');
        paintPromptHint(); updateGoState();
        clearButtonPaint(true);
        clearTimeout(clearedTimer);
        clearedTimer = setTimeout(dropClearShot, CLEAR_UNDO_MS);
        Toast.receipt('已清空这一栏 · ' + (CLEAR_UNDO_MS / 1000) + ' 秒内再点「撤销清空」可以放回来', 'ok');
      };

      /* ============================ ⑧ AI 润色 ============================ */
      function polishImageList() {
        const srcOf = it => it.file || it.src || it.url;
        const out = [];
        const m = inputs();
        if (TYPE === 'audio') return out;
        (m.image || []).forEach((it, i) => { const s = srcOf(it); if (s) out.push({ label: '参考图 ' + (i + 1), src: s }); });
        (m.frame_first || []).forEach(it => { const s = srcOf(it); if (s) out.push({ label: '首帧（开头画面）', src: s }); });
        (m.frame_last || []).forEach(it => { const s = srcOf(it); if (s) out.push({ label: '尾帧（结尾画面）', src: s }); });
        return out;
      }
      function polishMaterials() {
        const m = inputs();
        if (TYPE === 'audio') {
          const n = (m.audio || []).length;
          const items = [];
          for (let i = 0; i < n; i++) items.push({ label: '参考音频' + (n > 1 ? ' ' + (i + 1) : ''), kind: '音频', sent: false, hint: '按这个音色来念' });
          return items;
        }
        const items = polishImageList().map(x => ({ label: x.label, kind: '图片', sent: true }));
        const nVid = (m.video || []).length, nAud = (m.audio || []).length;
        for (let i = 0; i < nVid; i++) items.push({ label: '参考视频' + (nVid > 1 ? ' ' + (i + 1) : ''), kind: '视频', sent: false, hint: '沿用它的运镜和节奏' });
        for (let i = 0; i < nAud; i++) items.push({ label: '参考音频' + (nAud > 1 ? ' ' + (i + 1) : ''), kind: '音频', sent: false, hint: '沿用它的节奏' });
        return items;
      }
      const POLISH_SYS = { video: 'video', image: 'img', audio: 'audio' };
      const POLISH_IDLE = '<span class="ic">' + icon('sparkles', 17) + '</span>AI 润色';
      $('polishBtn').onclick = async () => {
        const ta = $('prompt');
        /* 忙标位同样在入口第一行同步置上（与「拆分片段」同一条判据）：
           以前它在 await TextAI.canRun 之后，那一段里双击会把两条润色同时发出去，
           后回来的那份覆盖先回来的，白花一轮 tokens。 */
        const btn = $('polishBtn');
        if (btn.disabled) return;
        btn.disabled = true;
        btn.innerHTML = '<span class="ic">' + icon('sparkles', 17) + '</span>准备中…';
        const release = () => { btn.disabled = false; btn.innerHTML = POLISH_IDLE; };
        const refused = t => { release(); setStatus(t); };
        const original = ta.value.trim();
        if (original.length < 2) { refused('<span class="err">先写几个字再润色</span>'); return; }
        if (!TextAI.prov(REG)) { refused('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
        if (!(await TextAI.canRun(REG))) { refused('<span class="err">请先到「设置」填写文字 AI 密钥（或在 .env / 系统环境变量里配置）</span>'); return; }
        const sysBase = TextAI.prompt(POLISH_SYS[TYPE]);
        const host = $('polishInline');
        $('splitInline').hidden = true;
        const imgList = () => polishImageList();
        const materials = () => polishMaterials();
        let images = [];
        const call = (sys, user, ctl) => ctl
          ? TextAI.chatStream(REG, sys, user, { images, signal: ctl.signal }, ctl.push)
          : TextAI.chat(REG, sys, user, { images });
        const prep = async () => { const p = await TextAI.polishImages(REG, imgList(), { max: 6 }); images = p.images; return p; };
        const taskWord = TYPE === 'audio' ? '朗读稿' : TYPE === 'image' ? '生图提示词' : '视频提示词';
        const run = async (answers, ctl) => {
          const picked = await prep();
          const sys = TextAI.polishSys(sysBase, TextAI.polishExtra({ images, materials: materials(), answers, text: original }));
          return { after: await call(sys, TextAI.polishUser(taskWord, original), ctl), note: picked.note };
        };
        const ask = async () => {
          const picked = await prep();
          const sys = TextAI.polishSys(sysBase, TextAI.polishExtra({ images, materials: materials(), stage: 'ask' }));
          return await TextAI.askPolish(REG, sys, TextAI.askUser(taskWord, original, { tail: '素材清单见系统提示' }), { images });
        };
        const follow = async (askText, current, ctl, ctx) => {
          const picked = await prep();
          const extra = TextAI.polishExtra({ images, materials: materials(), answers: (ctx && ctx.answers) || '' });
          const p = TextAI.followPrompt({ what: taskWord, ask: askText, current, extra });
          return { after: await call(p.sys, p.user, ctl), note: picked.note };
        };
        btn.innerHTML = '<span class="ic">' + icon('sparkles', 17) + '</span>润色中…';
        try {
          await InlinePolish.interactive(host, {
            ask: TextAI.shouldAsk() ? ask : null, run, before: original,
            askTitle: 'AI 想先问几个问题', askIntro: '点一个候选；都不合适就点最后一个「其他」自己写（会原样发给 AI）；没答的按默认理解走',
            onFollow: follow,
            followPlaceholder: TYPE === 'audio'
              ? '还要怎么改？例：再口语一点 / 压到两句 / 数字写成中文读法（写完按回车）'
              : '还要怎么改？例：运镜写具体动作 / 光线改成正午 / 只留一句（写完按回车）',
            onApply: v => { ta.value = v; setStatus('<span class="ok">✓ 已替换' + (TYPE === 'audio' ? '文本' : '提示词') + '</span>'); },
            onStatus: t => setStatus(t),
          });
        } catch (e) { InlinePolish.clear(host); setStatus('<span class="err">润色失败：' + e.message + '</span>'); }
        finally { release(); }
      };

      /* ==================== ⑧-b 拆分片段批量生成（仅图像栏） ==================== */
      $('splitBtn').onclick = () => {
        const p = $('splitInline');
        const on = p.hidden;
        p.hidden = !on;
        if (on) { try { InlinePolish.clear($('polishInline')); } catch (e) {} }
      };
      $('splitCancel').onclick = () => { $('splitInline').hidden = true; };
      const DIM_CUSTOM = '__custom';
      const isCustomDim = () => $('splitDim').value === DIM_CUSTOM;
      function syncSplitDimCustom() {
        const on = isCustomDim();
        $('splitDimCustomWrap').hidden = !on;
        if (on) { try { $('splitDimCustom').focus(); } catch (e) {} }
      }
      $('splitDim').addEventListener('change', syncSplitDimCustom);
      $('splitDimCustom').addEventListener('input', () => { writeLS('studio_split_dim_custom', $('splitDimCustom').value); });
      function parseSegs(txt) {
        let s = String(txt || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        let v = null;
        try { v = JSON.parse(s); } catch (e) {
          const m = s.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
          if (m) { try { v = JSON.parse(m[1]); } catch (e2) {} }
        }
        const list = Array.isArray(v) ? v : (v && (v.frames || v.segments || v.shots || v.list));
        if (!Array.isArray(list)) return [];
        return list.map((f, i) => {
          let label = String(f && (f.label || f.name || f.title) || '').trim();
          if (!label) {
            const t = f && (f.t ?? f.time);
            const sec = (t !== undefined && t !== null && t !== '') ? parseFloat(t) : NaN;
            label = isFinite(sec) ? ('第 ' + sec + ' 秒') : ('片段 ' + (i + 1));
          }
          return { label: label.slice(0, 12), prompt: String(f && (f.prompt || f.desc || f.text) || '').trim().slice(0, 600) };
        }).filter(x => x.prompt).slice(0, 8);
      }
      async function planImageSegments() {
        const src = ($('prompt').value || '').trim();
        const cnt = ($('splitCount').value || '').trim();
        const dim = isCustomDim() ? ($('splitDimCustom').value || '').trim() : ($('splitDim').value || '').trim();
        let user = '把下面这段描述拆成图片提示词：\n' + src;
        user += '\n\n张数：' + (cnt ? ('恰好 ' + cnt + ' 张，一张不多一张不少') : '你按内容复杂度定（2 到 6 张）');
        user += '\n拆分维度：' + (dim || '你选最自然的（时间先后 / 场景变化 / 动作阶段都行，拆法写进每个片段名）');
        const pm = polishMaterials();
        if (pm.length) user += '\n' + TextAI.materialNote(pm);
        user += '\n只返回 JSON。';
        let images = [];
        try { images = (await TextAI.polishImages(REG, polishImageList(), { max: 6 })).images; }
        catch (e) { console.warn('[拆分] 参考图附带失败：', e.message); }
        const txt = await AiStream.text(REG, TextAI.prompt('img_split'), user,
          { images: images, host: $('polishInline'), title: 'AI 正在拆分片段…' });
        const segs = parseSegs(txt);
        if (!segs.length) throw new Error('文字 AI 没有给出可用的拆分方案，换一条描述或再试一次');
        return segs;
      }
      let splitBusy = false;
      $('splitGo').onclick = async () => {
        /* 忙标位在入口第一行同步置上：以前它排在 await TextAI.canRun 之后，
           那一段空档里双击会开出两条拆分（同一段描述烧两份钱）。
           所以每个提前返回都要走 release() 放行。 */
        if (splitBusy) return;
        splitBusy = true;
        const btn = $('splitGo'), prev = btn.textContent;
        btn.disabled = true;
        const release = () => { splitBusy = false; btn.disabled = false; btn.textContent = prev; };
        const refused = t => { release(); setStatus(t); };
        if (($('prompt').value || '').trim().length < 2) { refused('<span class="err">先写一段描述再拆分</span>'); return; }
        if (!TextAI.prov(REG)) { refused('<span class="err">注册表里没有可用的文字 AI 供应商</span>'); return; }
        if (!(await TextAI.canRun(REG))) { refused('<span class="err">请先到「设置」填写文字 AI 密钥（拆分方案靠它出）</span>'); return; }
        const blk = submitBlockReason();
        if (blk) { refused('<span class="err">' + escA(blk) + '</span>'); return; }
        try {
          btn.textContent = '规划片段…'; setStatus('正在请文字 AI 拆分片段…');
          const planned = await planImageSegments();
          setStatus('');
          const items = await PromptReview.openList({
            title: '片段拆分方案（文字 AI 出的提示词）', sub: '确认后按当前型号与参数逐条提交生图，每条可改、可删',
            items: planned.map(sg => ({ label: sg.label, text: sg.prompt })),
            applyLabel: '采用并生成这批图',
            hint: '逐条修改或删掉不想生成的片段',
            retry: async () => (await planImageSegments()).map(sg => ({ label: sg.label, text: sg.prompt })),
          });
          if (!items) { setStatus(''); return; }
          const segs = items.map(it => ({ label: String(it.label || '').slice(0, 12), prompt: String(it.text || '').trim() })).filter(x => x.prompt);
          if (!segs.length) { Toast.err('没有可用的片段'); return; }
          $('splitInline').hidden = true;
          const { prov, model } = currentModel();
          await submitImageBatch(segs, prov, model);
        } catch (e) {
          setStatus(''); Toast.err('拆分片段失败：' + errText(e));
        } finally { release(); }
      };
      async function submitImageBatch(segs, prov, model) {
        $('go').disabled = true;
        try {
          setStatus('批量生成 ' + segs.length + ' 张：正在上传参考图…');
          const assetIds = await uploadImageRefs(prov);
          const created = [];
          let failed = 0, uncertain = 0, syncN = 0;
          const failWhy = [];
          const syncNotes = [];
          for (let i = 0; i < segs.length; i++) {
            const sg = segs[i];
            try {
              setStatus('批量生成 ' + segs.length + ' 张（' + (i + 1) + '/' + segs.length + '）：' + escA(sg.label));
              const out = await withCreateRetry(() => createImageOnce(prov, model, sg.prompt, assetIds, 1), '第 ' + (i + 1) + ' 张「' + escA(sg.label) + '」创建失败，');
              if (out.taskId) created.push({ provider: prov.id, id: out.taskId, prompt: sg.prompt,
                extra: { tier: val('tier'), res: val('res'), ar: val('ar'), dur: Number(val('dur')) || 0, model: (model && model.id) || '' } });
              else if (out.sync) {
                const sv = await saveSyncImages(prov, model, sg.prompt, out.sync, val('format'));
                syncN += sv.length;
                (sv.notes || []).forEach(n => syncNotes.push('「' + sg.label + '」' + n));
              }
            } catch (e) {
              if (maybeSubmitErr(e)) { uncertain++; console.warn('[拆分] 片段「' + sg.label + '」结果未知：', e.message); }
              else { failed++; failWhy.push('「' + sg.label + '」' + errText(e)); console.warn('[拆分] 片段「' + sg.label + '」提交失败：', e.message); }
            }
          }
          if (created.length) await adoptTasks(created);
          try { await loadServer(1); } catch (e) {}
          tally.run(true);
          if (uncertain) { try { await loadServer(1, true); } catch (e) {} }
          const accepted = created.length + syncN;
          const parts = ['已提交 ' + accepted + ' / ' + segs.length + ' 张' + (accepted ? '（右栏已列出）' : '')];
          if (failed) parts.push(failed + ' 张失败：' + failWhy.slice(0, 2).join('；') + (failWhy.length > 2 ? ' 等' : ''));
          if (syncNotes.length) parts.push(syncNotes.length + ' 张没存进资产库：' + syncNotes.slice(0, 2).join('；') + (syncNotes.length > 2 ? ' 等' : ''));
          if (uncertain) parts.push(uncertain + ' 张当时没等到平台响应（可能已受理，以右栏列表为准，别重复生成）');
          setStatus(parts.join('；'));
        } finally { updateGoState(); }
      }

      /* ============================ ⑨ 提交 ============================ */
      const SUBMIT_UI_MS = 12000, RESUBMIT_ARM_MS = 10000;
      const pendingSubmits = [];
      let submitRun = 0, armedAt = 0;
      /* 「还有没有没落定的提交」只看 inflight / uncertain 两种状态：一次生成多条时每条都有自己的记录，
         第一条回来不等于其余的也回来了。 */
      const unresolvedSubmit = () => pendingSubmits.find(s => s.state === 'inflight' || s.state === 'uncertain') || null;
      const resubmitArmed = () => armedAt && Date.now() - armedAt < RESUBMIT_ARM_MS;
      const maybeSubmitErr = e => !!(window.Api && Api.maybeSubmitted ? Api.maybeSubmitted(e) : false);
      /* 落定的记录只留最近 8 条，未落定的一条都不许丢：以前的 `while (length > 8) shift()`
         会把仍在途的那一条挤出去，界面立刻不再拦截，用户接着点就是第二份付费任务。 */
      function prunePending() {
        const done = pendingSubmits.map((s, i) => (s.state === 'settled' ? i : -1)).filter(i => i >= 0);
        for (let i = 0; i + 8 < done.length; i++) pendingSubmits[done[i]] = null;
        for (let i = pendingSubmits.length - 1; i >= 0; i--) if (!pendingSubmits[i]) pendingSubmits.splice(i, 1);
      }
      function trackSubmit(meta, work) {
        /* 每次调用一份**独立**记录：调用方传进来的只是一个描述（哪一次运行、哪一类、什么提示词），
           状态由这里自己维护 —— 一次生成多条时循环里传的是同一个对象，共用就把别人也「落定」了。 */
        const rec = Object.assign({}, meta || {});
        const at = Date.now();
        rec.at = at; rec.state = 'inflight';
        pendingSubmits.push(rec);
        prunePending();
        renderPendingHint();
        const late = () => Date.now() - at > SUBMIT_UI_MS;
        const settled = Promise.resolve().then(work).then(r => {
          rec.state = 'settled';
          if (late()) Toast.receipt('平台刚受理（等了 ' + Math.round((Date.now() - at) / 1000) + ' 秒）：任务已取回列表');
          prunePending();
          renderPendingHint();
          return r;
        }, e => {
          rec.failed = true;
          if (e && e.afterPaid) {
            /* 平台明确已经出活（钱已经花），失败的是本机落盘那一侧：没有什么可「核对」的，
               也不许报「创建失败」—— 由调用方按 savedFailed 给出「再存一次本机」那条路。 */
            rec.state = 'settled';
            prunePending();
            renderPendingHint();
            throw e;
          }
          if (maybeSubmitErr(e)) {
            rec.state = 'uncertain'; rec.note = errText(e) || '请求中断';
            setStatus('<span class="warn">平台可能已受理（' + rec.note + '），正在后台核对列表…</span>');
            loadServer(1, true).catch(() => {}).then(r => {
              /* loadServer 把单页失败咽进 serverErrs 里照样 resolve：核对真做成了才算落定，
                 否则「已核对列表」这句话只是把「不知道」说成了「放心」。 */
              if (!r || !r.ok) {
                rec.note = '列表这次没取回来，还没核对上';
              } else {
                rec.state = 'settled';
                setStatus('<span class="warn">已核对列表：上面有这条任务就是成功了，别重复生成</span>');
              }
              prunePending();
              renderPendingHint();
            });
          } else {
            rec.state = 'settled';
            setStatus('<span class="err">创建失败：' + escAerrText(e) + '</span>');
            prunePending();
            renderPendingHint();
          }
          if (late()) Toast.err('创建失败：' + errText(e));
          throw e;
        });
        settled.catch(() => {});
        return settled;
      }
      function armResubmit() {
        armedAt = Date.now();
        Toast.warn('上一次提交还在等平台响应：再点一次「生成」就会再提交一份');
        renderPendingHint();
      }
      function renderPendingHint() {
        const box = $('pendingHint');
        if (!box) return;
        const un = unresolvedSubmit();
        if (!un) { box.style.display = 'none'; box.innerHTML = ''; stopPendingTick(); return; }
        startPendingTick();
        const secs = Math.max(1, Math.round((Date.now() - un.at) / 1000));
        box.style.display = '';
        box.innerHTML = '<span class="warn">上一条提交还在等平台响应（已 ' + secs + ' 秒）：'
          + (un.state === 'inflight' ? '请求已经发出去了，平台受理后会自己出现在右边列表里。'
            : '平台可能已受理（' + escA(un.note || '响应丢了') + '），正在核对列表。')
          + '</span> 再点生成会再提交一份（可能重复扣费）：<a href="#" data-force>仍然再提交</a>';
        const b = box.querySelector('[data-force]');
        if (b) b.onclick = e => { e.preventDefault(); armedAt = Date.now(); $('go').click(); };
      }
      let pendingTick = null;
      function startPendingTick() { if (!pendingTick) pendingTick = setInterval(() => { if (document.hidden || !isActive()) return; renderPendingHint(); }, 1000); }
      function stopPendingTick() { if (pendingTick) { clearInterval(pendingTick); pendingTick = null; } }
      const onVis = () => { if (!document.hidden && isActive()) renderPendingHint(); };
      document.addEventListener('visibilitychange', onVis);
      disposers.push(() => document.removeEventListener('visibilitychange', onVis));

      const idemHeader = prov => ((prov && prov.create && prov.create.idempotencyKey === false) || !(window.crypto && crypto.randomUUID))
        ? {} : { 'Idempotency-Key': crypto.randomUUID() };
      async function withCreateRetry(doCreate, msg) {
        try { return await doCreate(); }
        catch (e) {
          if (window.Api && Api.isRetryableCreateError && Api.isRetryableCreateError(e)) {
            setStatus('<span class="warn">' + msg + '正在自动重试一次…</span>');
            await new Promise(r => setTimeout(r, 1200));
            return await doCreate();
          }
          throw e;
        }
      }
      async function uploadToPlatform(prov, blob, name, mime, onStage, role) {
        return await AssetTransfer.toAsset(prov.id, blob, { reg: REG, name, contentType: mime, onStage, role });
      }
      async function buildInputEntries(prov, model) {
        const entries = [];
        const m = inputs();
        for (const k of Object.keys(SLOT_DEF)) {
          if (k === 'audio' && TYPE === 'audio') continue;
          for (const x of (m[k] || [])) {
            const role = SLOT_DEF[k].role;
            const tpl = (window.Api && Api.inputTemplate) ? Api.inputTemplate(prov, role) : null;
            if (tpl && tpl.needsUpload) {
              const label = SLOT_DEF[k].label;
              const onStage = (st, info) => { const t = uploadStageText(st, info, label); if (t) setStatus(t); };
              const blob = await AssetTransfer.blobOf(x.file || x.src || x.url, onStage);
              const mime = (x.file && x.file.type) || blob.type
                || (({ video: 'video/mp4', audio: 'audio/mpeg' })[window.mediaKindOf(x.type)] || 'image/png');
              const aid = await uploadToPlatform(prov, blob, x.name || (label + (mime.includes('video') ? '.mp4' : '')), mime, onStage, role);
              if (aid) entries.push({ role, assetId: aid });
            } else {
              const url = x.file ? await AssetTransfer.toDataURL(x.file) : await srcToDataURL(x.src || x.url);
              if (url) entries.push({ role, url });
            }
          }
        }
        return entries;
      }
      async function createVideoOnce(prov, model, prompt, entries) {
        const modelId = (model && model.id) || String(model || '');
        if (!modelId) throw new Error('没选出要用的视频型号 —— 在左栏「型号」里挑一个再点生成');
        const cb = comboNow();
        const shape = { mode: (cb && cb.mode) || '', intent: (cb && cb.intent) || '', caps: shapeCaps() };
        const ap = advPlan(model, 'video').payload;
        const t = { model: modelId, prompt, tier: ap.tier || '', res: ap.res || '', ar: ap.ar || '',
          dur: Number(ap.duration) || 0, size: ap.size || '', entries };
        const bools = readBoolParams();
        const ex = advExtras(bools);
        const d = await Api.request(prov, 'create', {
          method: 'POST', headers: idemHeader(prov),
          log: { type: '视频生成', meta: { 模型档位: t.tier, 分辨率: t.res, 画幅: t.ar || t.size, 时长: t.dur ? t.dur + 's' : '',
            输入模式: cb ? comboLabel(cb) : '',
            顶层参数: ex.summary,
            参考素材: entries.length ? entries.length + ' 个' : '',
            生成音频: bools.generate_audio !== undefined ? (bools.generate_audio ? '是' : '否') : '',
            平台润色: (function () { const on = Object.keys(ex.topBools).filter(k => ex.topBools[k]); return on.length ? '是' : ''; })() } },
          body: Api.createBody(prov, { model: t.model, prompt: t.prompt, tier: t.tier, duration: t.dur, res: t.res, ar: t.ar,
            size: t.size, creation_intent: shape.intent, shape, inputEntries: t.entries,
            params: ex.params }),
        });
        if (d.error) throw new Error(d.error.message || '创建失败');
        const p = Api.parseItem(prov, d) || {};
        return { taskId: p.genId || d.id || d.task_id || d.requestId || d.job_id || p.assetId, priceText: Api.priceText(prov, p) };
      }
      async function createImageOnce(prov, model, prompt, assetIds, n) {
        const inputs2 = [];
        const ap = advPlan(model, 'image').payload;
        ['quality', 'ar', 'size', 'format'].forEach(k => { if (ap[k] !== undefined) inputs2.push({ k: k, v: ap[k] }); });
        const std = { model: model.id, prompt };
        for (const x of inputs2) std[x.k] = x.v;
        if (ap.count !== undefined) std.count = n;
        if (assetIds.length) std.inputs = assetIds.map(id => ({ role: 'reference_image', asset_id: id }));
        const ex = advExtras();
        std.params = ex.params;
        std.shape = topBoolCtx();
        const d = await Api.request(prov, 'create', {
          method: 'POST', headers: idemHeader(prov),
          log: { type: '图片生成', meta: { 画质: ap.quality || '', 画幅: ap.ar || '', 格式: ap.format || '',
            本批张数: n > 1 ? n + ' 张' : '', 参考图: assetIds.length ? assetIds.length + ' 张' : '',
            顶层参数: ex.summary } },
          body: Api.createBody(prov, std),
        });
        if (d.error) throw new Error(d.error.message || '创建失败');
        const sync = Api.syncMedia(prov, d);
        if (sync) return { sync, priceText: '' };
        const p = Api.parseItem(prov, d) || {};
        return { taskId: d.id || p.assetId, priceText: Api.priceText(prov, p) };
      }
      async function saveSyncImages(prov, model, prompt, items, fmtChoice) {
        const out = [];
        const notes = [];
        const list2 = items || [];
        for (let i = 0; i < list2.length; i++) {
          const it = list2[i];
          let b64 = it.b64 || '';
          if (!b64 && it.url) {
            const onStage = (st, info) => { const t = uploadStageText(st, info, '产物'); if (t) setStatus(t); };
            let blob = null;
            try { blob = await AssetTransfer.blobOf(it.url, onStage); }
            catch (e) { notes.push('第 ' + (i + 1) + ' 张取不回字节：' + errText(e)); continue; }
            if (!blob) { notes.push('第 ' + (i + 1) + ' 张取不回字节（平台没给内容）'); continue; }
            b64 = dataURLToB64(await AssetTransfer.toDataURL(blob));
          }
          if (!b64) { notes.push('第 ' + (i + 1) + ' 张没有可保存的字节'); continue; }
          const url = it.url || '';
          const urlExt = (url.match(/\.(png|jpe?g|webp)(?:\?|$)/i) || [])[1];
          const raw = String(it.format || urlExt || fmtChoice
            || (model.options && model.options.defaults && model.options.defaults.output_format) || '').toLowerCase();
          const fmt = /^(png|jpe?g|webp)$/.test(raw) ? raw.replace('jpg', 'jpeg') : 'png';
          const ext = window.fileExtOf ? window.fileExtOf({ type: '图片', format: fmt }) : (fmt === 'jpeg' ? 'jpg' : fmt);
          let saved = null;
          try {
            saved = await Api.saveLocalAsset({
              name: '生图-' + (prompt || '').replace(/\s+/g, ' ').trim().slice(0, 16) + '.' + ext,
              mime: fmt === 'jpeg' ? 'image/jpeg' : (fmt === 'webp' ? 'image/webp' : 'image/png'),
              format: fmt === 'jpeg' ? 'jpeg' : fmt, data: b64,
              meta: { prompt, model: model.id, provider: prov.id },
            });
          } catch (e) { notes.push('第 ' + (i + 1) + ' 张存不进资产库：' + errText(e)); continue; }
          out.push({ id: saved.assetId || saved.id, url: saved.url || Api.assetSrc(saved.assetId || saved.id) });
        }
        out.notes = notes;
        return out;
      }
      async function audioRefBase64() {
        const it = slotItems('audio')[0];
        if (!it) return '';
        let blob = it.file || null;
        if (!blob && it.src) blob = await AssetTransfer.blobOf(it.src || it.url);
        if (!blob) return '';
        return await AssetTransfer.toDataURL(blob);
      }
      async function synthAudio(t) {
        const prov = currentModel().prov;
        const mode = t.voiceMode || 'preset';
        const useRef = mode === 'clone';
        const voiceValue = useRef ? (await audioRefBase64()) : (mode === 'design' ? '' : t.voice);
        const r = await AiGen.synthTts(prov, { model: t.model, text: t.text, style: t.style || '',
          voice: voiceValue, format: t.format, bools: t.bools || {},
          meta: { voice: useRef ? '参考音频复刻' : t.voice } });
        return { assetId: r.assetId, url: r.url, format: r.format, bytes: r.bytes,
          usageText: '', priceText: '', transcript: '' };
      }
      $('go').onclick = async () => {
        /* 同步守卫放在第一行：以前这里只靠 disabled，而 Wb.ready 在用户动一下提示词之后就按
           「输入合不合法」重写 disabled —— 提交还在路上，按钮却被重新点亮，再点一份就是第二次扣费。 */
        if (submitting) { setStatus('<span class="warn">这一轮还在提交中（等平台响应）：现在再点会发出第二份创建请求，已拦住</span>'); return; }
        const why = submitBlockReason();
        if (why) { setStatus('<span class="err">' + why + '</span>'); updateGoState(); return; }
        if (unresolvedSubmit() && !resubmitArmed()) { armResubmit(); return; }
        const { prov, model } = currentModel();
        const runId = ++submitRun;
        const uiDeadline = Date.now() + SUBMIT_UI_MS;
        submitting++;
        $('go').disabled = true;
        updateGoState();
        try {
          const rec = { run: runId, kind: TYPE, prompt: $('prompt').value, model: model.id };
          if (TYPE === 'audio') await submitAudio(rec);
          else if (TYPE === 'image') await submitImage(rec, prov, model);
          else await submitVideo(rec, prov, model, uiDeadline);
        } catch (e) {
          /* 记账层已经写过状态行了；这里只保证按钮状态回来 */
        } finally {
          submitting = Math.max(0, submitting - 1);
          updateGoState();
          renderPendingHint();
        }
      };
      async function submitVideo(rec, prov, model, uiDeadline) {
        const prompt = $('prompt').value.trim();
        const draw = Math.max(1, Number(val('draw')) || 1);
        const allIn = Object.keys(SLOT_DEF).flatMap(k => (inputs()[k] || []).map(x => ({ k, x })));
        let entries = [];
        if (allIn.length) {
          if (window.Capabilities) {
            const keep = Capabilities.submitRoles(model, allIn.map(({ k }) => SLOT_DEF[k].role));
            if (keep && keep.drop && keep.drop.length) {
              setStatus('<span class="warn">这个型号不收：' + keep.drop.map(r => ROLE_ZH[r] || r).join('、') + '，已不带去</span>');
            }
          }
          setStatus('处理输入素材…');
          entries = await buildInputEntries(prov, model);
        }
        const created = [];
        let failed = 0;
        for (let i = 0; i < draw; i++) {
          const left = uiDeadline - Date.now();
          const p = trackSubmit(rec, async () => {
            const r = await withCreateRetry(() => createVideoOnce(prov, model, prompt, entries), '平台的提示词编译服务这次出错（任务未创建、未扣费），');
            const dur0 = Number(val('dur')) || 0;
            if (r && r.taskId) created.push({ id: r.taskId, provider: prov.id, prompt,
              extra: { tier: val('tier'), res: val('res'), ar: val('ar'), dur: dur0, model: (model && model.id) || '' } });
            tally.run(true);
            return r;
          });
          if (left > 0) { try { await Promise.race([p, new Promise(r => setTimeout(r, left))]); } catch (e) { /* 下面记账 */ } }
          try { await p; } catch (e) { failed++; }
        }
        if (created.length) {
          setStatus('<span class="ok">✓ 已提交 ' + created.length + ' 条任务，右栏已经能看到（生成完成会自动出现在上面）</span>'
            + (failed ? '<span class="warn">（另有 ' + failed + ' 条没提交出去）</span>' : ''));
          adoptTasks(created).catch(() => {});
        } else setStatus('<span class="err">创建失败</span>' + (failed ? '（' + failed + ' 条都提交失败）' : ''));
      }
      async function uploadImageRefs(prov) {
        const assetIds = [];
        for (const p of (inputs().image || [])) {
          if (p.assetId && (!window.AssetTransfer || AssetTransfer.isPlatformId(p.assetId))) { assetIds.push(p.assetId); continue; }
          const onStage = (st, info) => { const t = uploadStageText(st, info, '参考图'); if (t) setStatus(t); };
          let file = p.file;
          if (!file) {
            const blob = await AssetTransfer.blobOf(p.url || p.src, onStage);
            file = new File([blob], 'ref.png', { type: blob.type || 'image/png' });
          }
          assetIds.push(await AssetTransfer.toAsset(prov.id, file, { reg: REG, name: file.name, onStage }));
        }
        return assetIds;
      }
      async function submitImage(rec, prov, model) {
        const prompt = $('prompt').value.trim();
        const lim = modelLimits(model);
        const total = Math.max(1, Number(val('count')) || 1);
        const assetIds = await uploadImageRefs(prov);
        const perReq = Math.max(1, lim.maxOut);
        const created = [];
        const synced = [];
        let failed = 0;
        for (let left = total; left > 0; left -= perReq) {
          const n = Math.min(perReq, left);
          const p = trackSubmit(rec, async () => {
            const r = await withCreateRetry(() => createImageOnce(prov, model, prompt, assetIds, n), '平台的提示词编译服务这次出错（任务未创建、未扣费），');
            if (r && r.taskId) created.push({ id: r.taskId, provider: prov.id, prompt,
              extra: { tier: val('tier'), res: val('res'), ar: val('ar'), quality: val('quality'), size: val('size'), model: (model && model.id) || '' } });
            else if (r && r.sync) synced.push(...r.sync);
            tally.run(true);
            return r;
          });
          try { await p; } catch (e) { failed++; }
        }
        if (synced.length) {
          setStatus('<span class="ok">✓ 已返回，正在把产物存进资产库…</span>');
          let saved = [], saveErr = '';
          try { saved = await saveSyncImages(prov, model, prompt, synced, val('format')); }
          catch (e) { saveErr = errText(e); }
          const notes = saved.notes || [];
          if (saved.length) {
            setStatus('<span class="ok">✓ 已生成 ' + saved.length + ' 张，已存入资产库</span>'
              + (notes.length ? '<span class="warn">（另有 ' + notes.length + ' 张没存进去：' + notes.slice(0, 2).join('；') + '）</span>' : ''));
          } else if (saveErr) {
            setStatus('<span class="err">产物没能存进资产库：' + saveErr + '</span>');
          } else {
            setStatus('<span class="err">产物没有存进资产库：' + (notes.slice(0, 2).join('；') || '一张都没取到') + '</span>');
          }
          loadServer(1); tally.run(true);
        }
        if (created.length) {
          setStatus('<span class="ok">✓ 已提交 ' + created.length + ' 条任务，右栏已经能看到（生成完成会自动出现在上面）</span>');
          adoptTasks(created).catch(() => {});
        } else if (!synced.length) setStatus('<span class="err">创建失败</span>');
      }
      async function submitAudio(rec) {
        const text = $('prompt').value.trim();
        const mode = curTtsMode();
        const t = { localId: 'at_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          text, style: mode === 'design' ? $('style').value.trim() : '', model: $('model').value.split('::').pop(),
          format: val('formatA'), voice: mode === 'preset' ? val('voice') : (mode === 'clone' ? '参考音频复刻' : '音色设计'),
          voiceMode: mode, bools: readAudioBools(), status: 'creating', ts: Date.now(),
          mtype: '音频', provider: (currentModel().prov || {}).id || '', local: true };
        if (mode === 'clone') {
          const it = slotItems('audio')[0];
          const blob = it && (it.file || null);
          if (blob) { try { t.voiceRefKey = await Wb.Blobs.save(blob); t.voiceRefName = it.name || ''; } catch (e) { Toast.warn('参考音频没能存到本机库：重试时需要重新选择'); } }
        }
        if (window.PromptLog) {
          PromptLog.save(REG, { type: '语音合成', prompt: t.text, model: t.model, task: t.localId, provider: t.provider,
            meta: { 音色方式: MODE_ZH[mode] || mode, 音色: mode === 'design' ? '' : t.voice, 风格描述: t.style,
              格式: t.format, 字数: t.text.length + ' 字' } });
        }
        audioTasks.unshift(t);
        saveAudioTasks();
        renderAll();
        const p = trackSubmit(rec, () => synthAudio(t).then(r => {
          if (t.provider && window.Api) Api.balOut.clear(t.provider);
          if ($('balTip')) { $('balTip').hidden = true; $('balTip').innerHTML = ''; }
          Object.assign(t, { status: 'done', assetId: r.assetId, url: r.url, dl: Api.assetDl(r.assetId, (t.text || 'voice').slice(0, 16) + '.' + r.format),
            format: r.format, bytes: r.bytes, localAsset: true, usageText: r.usageText || '', priceText: r.priceText || '', transcript: r.transcript || '' });
          setStatus('<span class="ok">✓ 合成完成，已存入资产库（大类型：音频）</span>');
          loadServer(1); tally.run(true);
          return r;
        }));
        try { await p; }
        catch (e) {
          /* 三条路分开走，写错的那条就是「用户点重试 = 第二次付费」：
             · savedFailed —— 平台已经合成、钱已经花，失败的是本机落盘：给「再存一次本机」，不给重发；
             · maybeSubmitted —— 不知道平台收没收到：写「结果未知」，重发要先过确认；
             · 其余才是真的没建任务，可以当普通失败重试。 */
          t.error = errText(e);
          if (e && e.savedFailed) {
            t.status = 'uncertain'; t.keepKey = e.keepKey || ''; t.noResend = true;
            setStatus('<span class="warn">' + escA(t.error) + ' —— 用卡片上的「再存一次本机」补存，别重发（重发会再扣一次费）</span>');
          } else if (maybeSubmitErr(e)) {
            t.status = 'uncertain';
            setStatus('<span class="warn">合成结果未知：' + escA(t.error) + '（平台可能已经合成并扣费，先刷新核对，别急着重发）</span>');
          } else {
            t.status = 'failed';
            setStatus('<span class="err">合成失败：' + escA(t.error) + '</span>');
          }
          showBalTip(e, t.provider);
        }
        finally { saveAudioTasks(); renderAll(); }
      }
      function showBalTip(e, provId) {
        const box = $('balTip');
        if (!box) return;
        if (!window.Api || !Api.isBalanceErr(e)) { box.hidden = true; box.innerHTML = ''; return; }
        if (provId) Api.balOut.mark(provId);
        box.hidden = false;
        box.innerHTML = '<div class="ui-note err" style="margin-top:8px">这一家的余额 / 额度不够（先充上再合成，'
          + '不然再点一次还是同一句拒）。'
          + '<button class="tool mini" data-balgo style="margin-left:6px">去「用量与余额」</button></div>';
        const b = box.querySelector('[data-balgo]');
        if (b) b.onclick = () => (window.GoPage ? GoPage.go('usage.html') : (location.hash = 'usage.html'));
      }

      /* ============================ ⑩ 右栏：这一台的生成历史 ============================ */
      const PAGE_MODE = window.pageModeOf('studio');
      const PAGE_SIZE = window.pageSizeOf('studio');
      const LIST_CACHE = AssetLib.listCache('studio_tasks_cache_v1');
      const MERGE_SERVER = (base, add) => AssetLib.mergeEntries(base, add);
      let serverEntries = [], serverCursors = {}, serverHasMore = true, serverGen = 0;
      let serverChain = Promise.resolve(), serverLoading = 0, serverErrs = {};
      let audioTasks = [];
      let searchQ = '', filterKind = 'all', showAll = false;
      const RECENT_MS = 30 * 24 * 3600 * 1000;
      function loadAudioTasks() {
        audioTasks = Wb.History.read('audio');
        /* 刷新时还在途的不能判成「失败、可重试」：同步合成没有任务号，页面根本问不到平台那边
           到底出没出活。写成「结果未知」，重发要先过确认；只有平台明确回失败才置 failed。 */
        audioTasks.forEach(t => {
          if (Wb.stLive(t.status)) {
            t.status = 'uncertain';
            t.error = '这一条提交时页面刷新了：平台可能已经合成并扣费（这一家没有任务号可查），先在资产库里核对，确认没有再重发';
          }
          if (t.keepKey && !(window.AiGen && AiGen.hasTtsBytes(t.keepKey))) t.keepKey = '';
        });
      }
      function saveAudioTasks() { return Wb.History.write('audio', audioTasks); }
      function priceTextOf(e) {
        const c = (window.AssetLib && AssetLib.costOf) ? AssetLib.costOf(e) : { cost: null, unit: '' };
        if (c.cost == null) return '';
        return c.unit === '元' ? '¥' + Number(c.cost).toFixed(4) : c.cost + ' ' + c.unit;
      }
      function entryToItem(e) {
        const isAsset = e.kind === 'asset';
        const aid = e.assetId || (isAsset ? (e.id || '') : '');
        return {
          mtype: e.type || '', provider: e.provider || '', providerName: e.providerName || '', model: e.model || '',
          status: isAsset ? 'succeeded' : (e.status || ''), kind: isAsset ? 'asset' : 'task',
          prompt: e.prompt || '',
          raw: e.src || '', media: isAsset ? mediaOf({ src: e.src }) : (e.src ? mediaOf({ src: e.src }) : ''),
          dl: e.dl || (aid ? Api.assetDl(aid) : ''),
          assetId: aid, taskId: isAsset ? '' : (e.genId || ''),
          ts: e.ts ? new Date(e.ts).getTime() : 0,
          tier: e.tier, res: e.res, ar: e.ar, dur: e.duration, quality: e.quality, format: e.format,
          voice: e.voice, durationSec: e.duration, credits: e.credits, size: e.byteLength,
          priceText: priceTextOf(e), error: e.failMsg || '', local: false, localAsset: !!e.localAsset,
        };
      }
      function localAudioItem(t) {
        const lp = (window.Api && Api.prov && Api.prov(t.provider)) || null;
        return {
          mtype: '音频', provider: t.provider || '', providerName: (lp && (lp.displayName || lp.name)) || t.provider || '',
          model: t.model || '', status: t.status || 'creating', kind: t.assetId ? 'asset' : 'task',
          prompt: t.text || '', raw: t.url || '', media: t.url || '', dl: t.dl || '',
          assetId: t.assetId || '', taskId: '', localId: t.localId || t.id || '', ts: t.ts || 0,
          format: t.format, voice: t.voice, durationSec: t.duration, size: t.bytes,
          usageText: t.usageText || '', priceText: t.priceText || '', transcript: t.transcript || '',
          error: t.error || '', local: true, localAsset: !!t.localAsset, voiceRefKey: t.voiceRefKey, voiceMode: t.voiceMode,
          keepKey: t.keepKey || '', noResend: !!t.noResend,
          srcRef: t,
        };
      }
      const itemKey = it => Wb.taskKey(it, [it.assetId, it.taskId, it.localId]);
      let mergedBatch = null;
      const adoptBuf = [];
      /* 缓冲区只放「平台列表还没回、但本机已经提交过」的那几条：服务端一旦带上同一条，
         本地这份就退役（下面 mergedItems 里现删）。上限是兜底 —— 一家平台永远不列某条任务时，
         这里不能只增不减，否则每轮合并都扫一份越来越长的数组。 */
      const ADOPT_CAP = 200;
      function mergedItems() {
        if (mergedBatch) return mergedBatch;
        const out = [];
        const byKey = new Map();
        for (const e of serverEntries) {
          const it = entryToItem(e);
          if (!it.mtype) continue;
          out.push(it); byKey.set(itemKey(it), it);
        }
        const srvTask = new Set(serverEntries.map(e => String(e.id || e.taskId || '')).filter(Boolean));
        const srvAsset = new Set(serverEntries.map(e => String(e.assetId || '')).filter(Boolean));
        for (let i = adoptBuf.length - 1; i >= 0; i--) {
          const a = adoptBuf[i];
          const k = itemKey(a);
          const covered = byKey.has(k)
            || (a.taskId && srvTask.has(String(a.taskId)))
            || (a.assetId && srvAsset.has(String(a.assetId)));
          if (covered) { adoptBuf.splice(i, 1); continue; }
          out.unshift(a); byKey.set(k, a);
        }
        if (adoptBuf.length > ADOPT_CAP) adoptBuf.splice(0, adoptBuf.length - ADOPT_CAP);
        const srvAssets = new Set(out.map(x => x.assetId).filter(Boolean));
        for (const t of audioTasks) {
          if (t.assetId && srvAssets.has(t.assetId)) {
            const hit = out.find(x => x.assetId === t.assetId);
            if (hit) { hit.usageText = hit.usageText || t.usageText || ''; hit.priceText = hit.priceText || t.priceText || '';
              hit.transcript = hit.transcript || t.transcript || ''; hit.voiceMode = hit.voiceMode || t.voiceMode || ''; hit.size = hit.size || t.bytes; }
            continue;
          }
          const it = localAudioItem(t);
          if (!byKey.has(itemKey(it))) { out.push(it); byKey.set(itemKey(it), it); }
        }
        return out;
      }
      function inWindow(it) { return showAll || !it.ts || (Date.now() - it.ts) <= RECENT_MS; }
      let hiddenCloud = 0;
      function matched(it) {
        if (!inWindow(it)) return false;
        if (searchQ) {
          const hay = [it.prompt, it.taskId, it.assetId, it.model].join(' ').toLowerCase();
          if (!hay.includes(searchQ)) return false;
        }
        return true;
      }
      function filteredItems() {
        return mergedItems()
          .filter(it => matched(it) && (filterKind === 'all' || it.mtype === filterKind) && !AssetLocal.hideAsCloud(it))
          .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      }
      let kindOrder = [];
      function kindTabs() {
        const seen = new Set();
        mergedItems().forEach(it => { if (it.mtype) seen.add(it.mtype); });
        const next = kindOrder.filter(t => seen.has(t));
        for (const t of seen) if (!next.includes(t)) next.push(t);
        kindOrder = next;
        return next;
      }
      function paintCounts() {
        const passable = mergedItems().filter(matched);
        const matched_ = passable.filter(it => !AssetLocal.hideAsCloud(it));
        hiddenCloud = passable.length - matched_.length;
        const total = mergedItems().length;
        const c = new Map();
        matched_.forEach(it => { if (it.mtype) c.set(it.mtype, (c.get(it.mtype) || 0) + 1); });
        const kinds = kindTabs();
        if (filterKind !== 'all' && !kinds.includes(filterKind)) kinds.push(filterKind);
        const box = $('histFilter');
        const want = ['all'].concat(kinds).join('|');
        if (box.dataset.kinds !== want) {
          box.dataset.kinds = want;
          box.innerHTML = ['all'].concat(kinds)
            .map(k => '<button type="button" data-k="' + escA(k) + '">' + escA(k === 'all' ? '全部' : k)
              + '<span class="seg-n">0</span></button>').join('');
        }
        box.querySelectorAll('button[data-k]').forEach(b => {
          const k = b.dataset.k;
          const n = k === 'all' ? matched_.length : (c.get(k) || 0);
          const el = b.querySelector('.seg-n');
          if (el) el.textContent = n;
          b.classList.toggle('on', k === filterKind);
          b.hidden = (k !== 'all' && k !== filterKind && !n);
        });
        const note = $('histNote');
        const hidden = total - matched_.length - hiddenCloud;
        note.textContent = (showAll ? '全部时间范围' : '最近 30 天')
          + (hidden > 0 ? ' · 另有 ' + hidden + ' 条更早的没显示' : '')
          + (hiddenCloud > 0 ? ' · ' + hiddenCloud + ' 条本机还没有这份字节，按「不显示云端任务」藏起来了' : '')
          + (serverLoading ? ' · 正在取回…' : '');
      }
      $('histFilter').addEventListener('click', e => {
        const b = e.target.closest('button[data-k]');
        if (!b) return;
        filterKind = b.dataset.k;
        pager.setPage(0);
        renderAll();
      });
      $('winAll').onclick = () => {
        showAll = !showAll;
        $('winAll').textContent = showAll ? '只看最近 30 天' : '查看全部';
        pager.setPage(0);
        renderAll();
      };
      function loadServer(morePages, noCache, stage) {
        const gen = serverGen;
        /* `stage`（整栏重取那两条路给的一份临时落点）：这一次取回来的先进 stage，界面上那一份
           一个字不动，调用方确认取成了再换上。不传就是老路径（增量并到 serverEntries 上）。
           以前刷新是 `serverEntries = []` 之后再请求 —— 网络一坏，右栏就空着显示「还没有历史素材」，
           那是假的：任务都在平台那边，只是这一次没取回来。 */
        const run = async () => {
          if (gen !== serverGen) return { ok: false, stale: true, errors: {} };
          serverLoading++;
          const list = () => (stage ? stage.entries : serverEntries);
          const putList = v => { if (stage) stage.entries = v; else serverEntries = v; };
          try {
            const res = await AssetLib.load({
              pages: morePages || 1, reg: REG, cursors: stage ? stage.cursors : serverCursors, noCache: !!noCache,
              kinds: ['image', 'video', 'audio'],
              seen: new Set(), out: list(),
              onBatch: list2 => {
                if (gen !== serverGen) return;
                putList(MERGE_SERVER(list(), list2));
                if (!stage) renderAll();
              },
            });
            if (gen !== serverGen) return { ok: false, stale: true, errors: {} };
            putList(MERGE_SERVER(list(), res.entries));
            const cursors = res.cursors, hasMore = res.hasMore, errs = res.errors || {};
            if (stage) { stage.cursors = cursors; stage.hasMore = hasMore; stage.errs = errs; }
            else { serverCursors = cursors; serverHasMore = hasMore; serverErrs = errs; }
            const alive = new Set(list().map(e => e.assetId || e.id).filter(Boolean));
            const before = audioTasks.length;
            audioTasks = audioTasks.filter(t => !t.assetId || alive.has(t.assetId));
            if (audioTasks.length !== before) saveAudioTasks();
            if (!stage) LIST_CACHE.write(serverEntries);
            /* 明确回成败：调用方要拿它判「这次核对到底做成了没有」，不能靠 resolve 本身。 */
            const errors = stage ? errs : serverErrs;
            return { ok: !Object.keys(errors).length, stale: false, errors };
          } catch (e) {
            console.warn('[studio] 历史列表加载失败：', e);
            const msg = errText(e);
            if (gen === serverGen) setStatus('<span class="warn">历史列表这次没取回来（' + escA(msg) + '）—— 点右上角「刷新」重试</span>');
            return { ok: false, stale: gen !== serverGen, errors: { load: msg } };
          } finally {
            serverLoading = Math.max(0, serverLoading - 1);
            if (gen === serverGen) renderAll();
          }
        };
        serverChain = serverChain.then(run, run);
        return serverChain;
      }
      /* 「整栏重取一遍」只有这一条路（右上角刷新与删掉一条之后都走它）：
         先取到临时列表，成功才换上；整体失败就留着原来那一份，并出声说这次没取回来。 */
      async function reloadHist() {
        serverGen++;
        const stage = { entries: [], cursors: {}, hasMore: true, errs: {} };
        const r = await loadServer(1, true, stage);
        const lost = !r || r.stale || !!((r.errors || {}).load);
        if (!lost) {
          serverEntries = stage.entries; serverCursors = stage.cursors;
          serverHasMore = stage.hasMore; serverErrs = stage.errs;
          adoptBuf.length = 0;
          LIST_CACHE.write(serverEntries);
        }
        return { ok: !lost, lost, errors: (r && r.errors) || {} };
      }
      const busSync = Wb.busRefresh(async () => {
        serverCursors = {}; serverHasMore = true;
        await loadServer(1, true);
        tally.run(true);
      }, 8000);
      const busOff = Wb.busOn(busSync);
      disposers.push(() => busOff());
      async function adoptTask(prov, taskId, seed) {
        if (!taskId) return false;
        const ph = Object.assign({
          mtype: (window.AssetLib && AssetLib.mediaOf) ? AssetLib.mediaOf(prov, {}) : '',
          provider: prov.id, status: 'queued', prompt: '', raw: '', media: '', dl: '',
          assetId: '', taskId, ts: Date.now(), local: false, localAsset: false,
        }, seed || {});
        ph.prompt = ph.prompt || Api.promptFor(prov.id, taskId) || '';
        upsertItem(ph);
        renderAll(); poller.kick();
        let p = null;
        try {
          const got = await Api.pollMany(prov, [taskId]);
          const hit = got.get(String(taskId));
          p = hit && hit.p;
        }
        catch (e) { console.warn('[studio] 取新任务状态失败，交给轮询器接着刷：', e && e.message); }
        if (p && p.status) {
          upgradeItem(prov, p, ph.prompt);
          renderAll(); poller.kick();
          return true;
        }
        return false;
      }
      async function adoptTasks(list2) {
        if (!list2 || !list2.length) return;
        for (const one of list2) {
          const prov = provById(one.provider) || null;
          if (!prov) continue;
          upsertItem(Object.assign({
            mtype: (window.AssetLib && AssetLib.mediaOf) ? AssetLib.mediaOf(prov, {}) : '',
            provider: prov.id, status: 'queued', prompt: one.prompt || Api.promptFor(prov.id, one.id) || '',
            raw: '', media: '', dl: '', assetId: '', taskId: one.id, ts: Date.now(),
            local: false, localAsset: false,
          }, one.extra || {}));
        }
        renderAll(); poller.kick();
        const byProv = new Map();
        for (const one of list2) {
          const prov = provById(one.provider) || null;
          if (!prov) continue;
          if (!byProv.has(prov)) byProv.set(prov, []);
          byProv.get(prov).push(one);
        }
        await Promise.allSettled([...byProv].map(async ([prov, ones]) => {
          const got = await Api.pollMany(prov, ones.map(x => x.id));
          let changed = false;
          for (const one of ones) {
            const p = (got.get(String(one.id)) || {}).p;
            if (!p || !p.status) continue;
            upgradeItem(prov, p, one.prompt || Api.promptFor(prov.id, one.id) || '');
            changed = true;
          }
          if (changed) renderAll();
        }));
        poller.kick();
      }
      function upgradeItem(prov, p, fallbackPrompt) {
        upsertItem(Object.assign(itemFromPoll(prov, p), { prompt: (p.prompt || '') || fallbackPrompt || '' }));
      }
      function itemFromPoll(prov, p) {
        const done = p.done || p.status === 'succeeded' || p.status === 'done' || p.status === 'completed';
        const aid = p.assetId || '';
        return {
          mtype: (window.AssetLib && AssetLib.mediaOf) ? AssetLib.mediaOf(prov, p) : '',
          provider: prov.id, model: p.model || '', status: p.status, kind: done ? 'asset' : 'task', prompt: p.prompt || Api.promptFor(prov.id, p.id) || '',
          raw: p.url || '', media: done ? (aid ? Api.assetSrc(aid) : Api.mediaSrc(p.url)) : '',
          dl: aid ? Api.assetDl(aid) : (p.url ? '/fetch?url=' + encodeURIComponent(p.url) : ''),
          assetId: aid, taskId: p.id || '', ts: Date.parse(p.created || '') || (p.completed ? Date.parse(p.completed) : 0) || Date.now(),
          tier: p.tier, res: p.res, ar: p.ar, dur: p.duration, durationSec: p.duration,
          priceText: Api.priceText(prov, p) || '', error: p.error || '', local: false, localAsset: false,
        };
      }
      function upsertItem(it) {
        if (!it || !it.taskId) return;
        const k = itemKey(it);
        const i = adoptBuf.findIndex(x => itemKey(x) === k);
        if (i >= 0) adoptBuf[i] = Object.assign(adoptBuf[i], it);
        else adoptBuf.push(it);
      }
      const running = it => Wb.isRunning(it) && !!it.taskId;
      const missOf = new Map();
      const missAdd = it => { const k = String(it.taskId || ''); if (!k) return 0; const n = (missOf.get(k) || 0) + 1; missOf.set(k, n); return n; };
      const missClear = it => { const k = String(it.taskId || ''); if (k) missOf.delete(k); };
      const missSweep = () => { if (missOf.size < 200) return;
        const live = new Set(mergedItems().map(it => String(it.taskId || '')).filter(Boolean));
        for (const k of [...missOf.keys()]) if (!live.has(k)) missOf.delete(k); };
      /* 「投一次生成完成」在这一处只负责两件事：同一个候选不投第二遍、把这一页的行形状
         翻成公共字段。地址有没有、是不是本机导入（la_）不由这里判 —— 那是
         `AssetLocal.announce` 那一道闸，四个生产点共用（见 local.js）。 */
      function announceMirror(it) {
        if (!it || it._mirrorAnnounced) return;
        const src = String(it.media || it.raw || '');
        if (!src) return;
        it._mirrorAnnounced = true;
        window.AssetLocal.announce([{
          kind: 'asset', provider: it.provider || '', assetId: it.assetId || '', genId: it.taskId || '',
          type: it.mtype || '', format: it.format || '', status: 'done', src,
          rawSrc: /^https?:/i.test(it.raw || '') ? it.raw : '',
          dl: it.dl || '', prompt: it.prompt || '', model: it.model || '', tier: it.tier || '',
          res: it.res || '', ar: it.ar || '', duration: it.dur ?? null,
          priceText: it.priceText || '', created: it.ts ? new Date(it.ts).toISOString() : '',
        }]);
      }
      async function pollOne(it) {
        const prov = provById(it.provider);
        if (!prov || !it.taskId) return;
        const hit = (await Api.pollMany(prov, [it.taskId])).get(String(it.taskId)) || {};
        if (hit.error) {
          const msg = String((hit.error && hit.error.message) || hit.error);
          const gone = hit.error && hit.error.status === 404 || /不存在|未找到|not\s*found/i.test(msg);
          const miss = missAdd(it);
          if (gone && miss >= 3) { it.status = 'failed'; it.error = '平台上找不到这条任务（可能已被清理或过期），可重试或重新提交'; it.taskId = ''; missClear(it); }
          throw hit.error;
        }
        const p = hit.p;
        if (!p) { const miss = missAdd(it); if (miss >= 3) { it.status = 'failed'; it.error = '平台这次问不到这条任务了，可重试或重新提交'; } throw new Error('no item'); }
        missClear(it);
        const upd = itemFromPoll(prov, p);
        Object.assign(it, upd, { taskId: it.taskId, ts: it.ts || upd.ts, local: false });
        if (upd.media && !Wb.isRunning(it)) announceMirror(it);
        missSweep();
      }
      const poller = Wb.poller({
        label: '生成', interval: 4000, page: 'studio.html',
        tasks: () => mergedItems(),
        isRunning: it => running(it),
        sig: it => [it.status, it.media, it.priceText, it.error].join('|'),
        pollOne,
        onChange: () => renderAll(),
      });

      /* ---------- 卡片 ---------- */
      const KIND_TAG = { 图片: 'image', 视频: 'video', 音频: 'mic' };
      const cardSig = it => [it.status, it.media, it.priceText, it.error, it.mtype, it.prompt, it.model,
        it.tier, it.res, it.ar, it.dur, it.voice, it.format, it.ts,
        (window.AssetLocal && AssetLocal.showBadge && AssetLocal.showBadge()) ? 'B' : '-',
        (window.AssetLocal && AssetLocal.stateOf) ? AssetLocal.stateOf(it).state : '-'].join('|');
      const openDetail = new Set();
      function mediaBox(it) {
        const run = Wb.isRunning(it), bad = Wb.isFailed(it);
        if (run) return '<div class="timg"><span class="spin-dot"></span>' + escA(Wb.stText(it.status) || '生成中') + '</div>';
        if (bad) return '<div class="timg" style="color:var(--err)">' + escA(Wb.stText(it.status) || '生成失败') + '</div>';
        if (it.mtype === '视频' && it.media) {
          return '<div class="timg playable">' + Wb.thumbs.mediaHTML(it.media, {
            inline: true, videoAttrs: 'playsinline preload=metadata',
            mediaAttrs: 'title="就地播放；要看大图点下面的「放大」"' })
            + '<button class="tplay" type="button" title="播放 / 暂停">' + icon('play', 22) + '</button></div>';
        }
        if (window.isAudioType(it.mtype) && it.media) {
          return '<div class="timg sound playable"><span class="tbg">' + icon('mic', 46) + '</span><audio preload="metadata" src="' + escA(Api.mediaSrc(it.media)) + '"></audio>'
            + '<button class="tplay" type="button" title="播放 / 暂停">' + icon('play', 22) + '</button></div>';
        }
        if (it.media) return '<div class="timg">' + Wb.thumbs.mediaHTML(it.media, { type: 'image', mediaAttrs: 'loading="lazy" title="点一下看大图"' }) + '</div>';
        if (it.mtype) return '<div class="timg">' + icon(KIND_TAG[it.mtype] || 'image', 24) + '</div>';
        return '<div class="timg">…</div>';
      }
      function bindCardPlay(d, wrap) {
        const btn = wrap && wrap.querySelector('.tplay');
        const media = wrap && wrap.querySelector('video, audio');
        if (!btn || !media) return;
        const setState = playing => { wrap.classList.toggle('playing', !!playing); btn.innerHTML = icon(playing ? 'pause' : 'play', 22); };
        btn.onclick = e => {
          e.stopPropagation();
          if (media.paused) { const pr = media.play(); if (pr && pr.catch) pr.catch(() => {}); }
          else media.pause();
        };
        ['play', 'pause', 'ended'].forEach(ev => media.addEventListener(ev, () => setState(ev === 'play')));
        setState(false);
      }
      /* 本机 / 云端标识：与资产库 / 收藏同一个开关（sk_media_badge），不参与筛选。
         哪边有只问 AssetLocal.stateOf（与「存回本机」范围同一份判据），
         徽标本身（文案 / class / title）只有 ui/badge-state.js 那一份。 */
      function srcBadgeOf(it) {
        const AL = window.AssetLocal;
        if (!AL || !AL.showBadge || !AL.showBadge() || !AL.stateOf) return '';
        return window.badgeHTML(AL.stateOf(it));
      }
      function cardHTML(it) {
        const bad = Wb.isFailed(it), unc = Wb.isUncertain(it);
        const run = running(it), cxProv = run ? provById(it.provider) : null;
        const canCx = run && window.Api.canCancel(cxProv);
        const meta = [provLabelFor(it), it.model, it.tier, it.res, it.ar,
          it.dur != null && it.dur !== '' ? it.dur + 's' : '', it.voice ? '音色 ' + it.voice : '',
          it.format ? String(it.format).toUpperCase() : '',
          it.size ? Wb.fmtSize(it.size) : '',
          it.priceText ? '费用 ' + it.priceText : '', it.usageText || ''].filter(Boolean).join(' · ');
        return '<div class="card-top"><span class="card-badge">'
          + (it.mtype ? '<span class="ui-tag">' + escA(it.mtype) + '</span>' : '')
          + '<span class="ui-tag ' + (Wb.isRunning(it) ? 'run' : bad ? 'err' : unc ? 'warn' : 'ok') + '">' + escA(Wb.stText(it.status) || '') + '</span>'
          + srcBadgeOf(it)
          + '</span><span class="date">' + escA(window.fmtWhen(it.ts)) + '</span></div>'
          + mediaBox(it)
          + '<div class="tmain">'
          + '<div class="tprompt" title="' + escA(it.prompt) + '">' + (escA(it.prompt) || '(无提示词)') + '</div>'
          + ((bad || unc) && it.error ? '<div class="terr" title="' + escA(String(it.error)) + '">' + escA(String(it.error)) + '</div>' : '')
          + '<div class="meta2">' + escA(meta) + '</div>'
          + '<div class="acts">' + Wb.actsHTML(it, {
            preview: !!it.media, previewLabel: '放大', cancel: canCx,
            cancelWhy: (run && cxProv && !canCx) ? Wb.cancelWhyNot(cxProv) : '',
            retry: (bad || unc) && !it.noResend && !!(it.prompt || it.local),
            saveLocal: !!it.keepKey,
            remove: !!(it.local && !it.localAsset), removeFile: !!(it.local && it.localAsset && it.assetId),
          }) + '</div>'
          + '<div class="tdetail" hidden></div>'
          + '</div>';
      }
      function fileNameOf(it) {
        return window.fileStamp(it.ts) + ' ' + window.fileSafe(it.prompt || it.mtype || '素材') + '.' + window.fileExtOf(it);
      }
      function bindCard(d, it) {
        const det = d.querySelector('.tdetail');
        const dtBtn = d.querySelector('.dt');
        const setOpen = now => {
          det.hidden = !now;
          d.classList.toggle('open', now);
          if (dtBtn) { iconSet(dtBtn, now ? 'chevronUp' : 'chevronDown', 13); btnText(dtBtn, now ? '收起' : '详情'); }
          if (now) { openDetail.add(itemKey(it)); renderDetail(it, det); }
          else openDetail.delete(itemKey(it));
        };
        d.dataset.tkey = itemKey(it);
        d._setOpen = setOpen; d._det = det; d._item = it;
        if (dtBtn) dtBtn.onclick = e => { e.stopPropagation(); setOpen(det.hidden); };
        const tp = d.querySelector('.tprompt');
        if (tp) tp.onclick = e => { e.stopPropagation(); setOpen(det.hidden); };
        const pv = d.querySelector('.pv');
        if (pv) pv.onclick = () => openLb(it);
        const imgWrap = d.querySelector('.timg');
        if (imgWrap && !imgWrap.querySelector('video,audio')) imgWrap.onclick = () => openLb(it);
        bindCardPlay(d, imgWrap);
        const wrap = imgWrap;
        const media = wrap ? wrap.querySelector('video[data-src], video[src], img') : null;
        if (wrap && media) Wb.thumbs.bind(wrap, media, it.media || '');
        d.draggable = true;
        d.addEventListener('dragstart', e => {
          const p = { mtype: it.mtype, assetId: it.assetId, src: it.raw || it.media, dl: it.dl, name: (it.prompt || '').slice(0, 40) };
          e.dataTransfer.setData('application/x-studio-ref', JSON.stringify(p));
          if (it.assetId) e.dataTransfer.setData('application/x-asset-id', String(it.assetId));
          e.dataTransfer.setData('text/plain', it.assetId ? Api.assetSrc(it.assetId) : (it.raw || ''));
          e.dataTransfer.effectAllowed = 'copy';
          d.classList.add('dragging');
        });
        d.addEventListener('dragend', () => d.classList.remove('dragging'));
        Wb.bindActs(d, it, {
          fileName: fileNameOf(it),
          dlUrl: it.dl || it.media || '',
          onDetail: () => setOpen(det.hidden),
          onPreview: () => openLb(it),
          onCancel: async () => { await Wb.cancelTask(provById(it.provider), it.taskId); it.status = 'cancelled'; renderAll(); Toast.receipt('已取消'); },
          onRetry: () => retryItem(it),
          onSaveLocal: async () => {
            const t = it.srcRef;
            if (!t || !t.keepKey) { Toast.err('这一条的音频留底已经不在了（换过页），只能重新合成'); return; }
            const r = await AiGen.retrySaveTts(t.keepKey);
            Object.assign(t, { status: 'done', assetId: r.assetId, url: r.url, keepKey: '', noResend: false, error: '',
              dl: Api.assetDl(r.assetId, (t.text || 'voice').slice(0, 16) + '.' + r.format),
              format: r.format, bytes: r.bytes, localAsset: true });
            saveAudioTasks(); loadServer(1); tally.run(true); renderAll();
            Toast.receipt('已补存进本机资产库（没有再花一次平台的钱）');
          },
          onRemove: () => { audioTasks = audioTasks.filter(x => x !== it.srcRef); saveAudioTasks(); renderAll(); tally.run(true); },
          onRemoveFile: () => deleteLocalAsset(it),
        });
        return d;
      }
      function paintCard(d, it) {
        const old = d.querySelector('.timg video, .timg img');
        const oldKey = old ? (old.getAttribute('data-thumb-key') || '') : '';
        const oldCls = old ? old.className : '';
        if (old) old.remove();
        const wasOpen = !det0(d).hidden;
        d.innerHTML = cardHTML(it);
        const now = d.querySelector('.timg video, .timg img');
        if (old && now && oldKey && now.getAttribute('data-thumb-key') === oldKey && now.className === oldCls) now.replaceWith(old);
        bindCard(d, it);
        if (wasOpen) { const det = d.querySelector('.tdetail'); det.hidden = false; renderDetail(it, det); }
        return d;
      }
      const det0 = d => d.querySelector('.tdetail') || { hidden: true };
      /* 左栏已经有用户自己写的东西时，「重试」不许直接把它盖掉 —— 覆盖之前先确认。
         填回之后也不自动点生成：付费任务由用户自己那一下发起。 */
      async function confirmOverwriteDraft() {
        const hasDraft = ($('prompt').value || '').trim()
          || Object.keys(SLOT_DEF).some(k => (inputs()[k] || []).length);
        if (!hasDraft) return true;
        return !!(await window.Confirm.ask({
          title: '用这一条覆盖左栏？', danger: true, okLabel: '覆盖', cancelLabel: '先不覆盖',
          body: '左栏现在写的提示词与参数会被这一条替换（参考素材不会自动带上）。覆盖之后要自己点「生成」才会发出去。',
        }));
      }
      async function retryItem(it) {
        if (submitting) { Toast.warn('这一轮还在提交中：先等它落定，再重发这一条'); return; }
        if (!await confirmOverwriteDraft()) return;
        if (it.local) {
          const rec = it.srcRef || audioTasks.find(x => (x.localId || x.id) === it.localId);
          if (!rec) { Toast.err('这条本地记录已经不在了'); return; }
          if (rec.voiceMode === 'clone' && rec.voiceRefKey && !slotItems('audio').length) {
            const blob = await Wb.Blobs.get(rec.voiceRefKey);
            if (blob) { slotItems('audio').push({ file: blob, url: URL.createObjectURL(blob), name: rec.voiceRefName || '参考音频', type: '音频', kind: 'audio', fromLib: false }); renderInputArea(); }
          }
          setType('audio', true);
          $('prompt').value = rec.text || ''; $('style').value = rec.style || '';
          rec.status = 'creating'; rec.error = ''; rec.noResend = false; saveAudioTasks(); renderAll();
          setStatus('<span class="warn">已把这一条填回左栏：确认无误后点「生成」才会发出去</span>');
          updateGoState();
          return;
        }
        const prov = provById(it.provider);
        if (!prov) { Toast.err('这家已经不在注册表里了'); return; }
        const type = it.mtype === '视频' ? 'video' : 'image';
        setType(type, true);
        const hit = ((provGroups().find(p => p.id === it.provider) || {}).models || [])
          .find(m => String(m && m.id) === String(it.model));
        if (!hit) {
          Toast.warn('这条原来的型号现在不在可选清单里（换过平台或型号下架了）：请在左栏重新选一个型号再生成');
          return;
        }
        $('model').value = prov.id + '::' + hit.id;
        $('model').dispatchEvent(new Event('change'));
        $('prompt').value = it.prompt || '';
        setStatus('<span class="warn">已按当前面板参数填回左栏（原来的参考素材不会自动带上；要带就在左栏重新选）：确认后点「生成」</span>');
        updateGoState();
      }
      async function deleteLocalAsset(it) {
        try {
          const res = await AssetLib.remove(it);
          if (res && res.alreadyGone) Toast.warn('平台上这条已经不在了：列表已经清掉，没有删成别的东西');
          else Toast.receipt('已删除这条' + (it.mtype || '文件'));
        } catch (e) { Toast.err('删除失败：' + errText(e)); return; }
        audioTasks = audioTasks.filter(t => t.assetId !== it.assetId);
        saveAudioTasks();
        /* 先把这一条从界面上摘掉（当场看得见「删掉了」），再整栏重取一份换上；
           取砸了不动列表 —— 以前是清空再请求，网络一坏右栏就空着说「还没有历史素材」。 */
        const gone = itemKey(it);
        serverEntries = serverEntries.filter(x => itemKey(x) !== gone);
        renderAll();
        const r = await reloadHist();
        if (r.lost) Toast.warn('重取列表没成功：上面还是删掉这一条之后的那一份');
        tally.run(true); renderAll();
      }
      const cardList = Wb.cards.create({
        box: $('result'),
        keyOf: it => itemKey(it),
        sigOf: it => cardSig(it),
        paint: (d, it) => paintCard(d, it),
        emptyHTML: () => (hiddenCloud
          ? '<div class="empty">这一屏的 ' + hiddenCloud + ' 条本机还没有那份字节，按「不显示云端任务」藏起来了。'
            + '要看它们就在设置页关掉这一项（它们还在平台那边，收藏与素材库也不受这一项影响）。</div>'
          : '<div class="empty">还没有历史素材。左栏写好提示词点「生成」，出来的产物会自动出现在这里；也可以把素材拖到左栏当参考。</div>'),
        notesHTML: () => Wb.loadNote(serverErrs, 'histRetry'),
        onNew: el => { try { el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 280, easing: 'ease-out' }); } catch (e) {} },
      });
      const browseList = () => filteredItems().filter(x => x.media);
      function renderAll() {
        mergedBatch = mergedItems();
        try {
          const all = filteredItems();
          const items = pager.slice(all);
          pager.update();
          paintCounts();
          cardList.paint(items);
          paintPullBtn();
          const el = $('histNote');
          if (el && serverLoading && !el.textContent.includes('正在取回')) el.textContent += ' · 正在取回…';
        } finally { mergedBatch = null; }
      }
      const tally = Wb.tally(() => AssetLib.countAll({ reg: REG, accept: e => !!e.type, maxPages: 3 }));
      tally.onDone.push(() => { try { renderAll(); } catch (e) {} });
      const pager = Wb.pager.create({
        mode: PAGE_MODE, pageSize: PAGE_SIZE,
        pgPrevId: 'stPgPrev', pgNextId: 'stPgNext', pgInfoId: 'stPgInfo', gotoPage: 'stGotoPage',
        items: () => filteredItems(),
        hasMore: () => serverHasMore,
        total: () => tally.value(),
        searchQ: () => searchQ,
        render: () => renderAll(),
        fill: async need => {
          if (need) {
            let guard = 0;
            const floor = Math.max(1, need) * PAGE_SIZE;
            while (serverHasMore && guard++ < 20 && filteredItems().length < floor) await loadServer(1);
            return;
          }
          if (!serverHasMore) return;
          return loadServer(1);
        },
      });
      $('result').addEventListener('click', e => {
        const card = e.target.closest('.task');
        if (!card || !card._setOpen) return;
        if (e.target.closest('.dt') || e.target.closest('.tprompt') || e.target.closest('button')) return;
        if (e.target.closest('.tdetail') || e.target.closest('.acts')) return;
        if (e.target.closest('video') || e.target.closest('audio')) return;
        card._setOpen(card._det.hidden);
      });
      $('result').addEventListener('click', e => {
        const b = e.target.closest('#histRetry');
        if (!b) return;
        e.stopPropagation();
        b.disabled = true;
        loadServer(1, true);
      });

      /* ---------- 详情 / 灯箱 ----------
         这两个是**全局单例**（外壳里收藏 / 资产库也各 init 过一次）：哪个页面最后 init，
         配置就归谁。所以这里把配置留成一份常量，每次打开前再挂回去 —— 否则从收藏页切过来，
         详情里「平台」那一行会按收藏那份读（Studio 的条目没有 note、名字也不一样）。
         灯箱只在没初始化过时 init（它每 init 一次就往 document 上再挂一条 keydown）。 */
      const DETAIL_CFG = {
        prompt: it => it.prompt,
        status: it => it.status,
        provider: it => provById(it.provider),
        taskId: it => it.taskId || '',
        rows: it => [
          ['平台', it.provider ? provLabelFor(it) : ''],
          ['型号', it.model],
          ['档位', it.tier], ['质量', it.quality ? AdvParams.label('quality', it.quality) : ''],
          ['分辨率', it.res], ['比例', it.ar],
          ['时长', it.dur != null && it.dur !== '' ? it.dur + ' 秒' : ''],
          ['数量', it.credits != null && it.credits !== '' ? it.credits : ''],
          ['音色', it.voice], ['格式', it.format ? String(it.format).toUpperCase() : ''],
          ['接口用量', it.usageText || ''], ['转写', it.transcript || ''],
          ['大小', it.size ? Wb.fmtSize(it.size) : ''],
          ['费用', it.priceText],
          ['错误', it.error],
          ['任务ID', it.taskId || (it.assetId ? it.assetId : '（本机记录，无任务号）')],
        ],
        actions: it => (it.media ? '<button class="ghost" data-act="reuse" title="把这条的提示词与素材填进左栏（按类型自动切过去）">'
          + icon('reuse', 12) + ' 复用这次创作</button>' : ''),
        bindActions: (host, it) => {
          const b = host.querySelector('[data-act="reuse"]');
          if (b) b.onclick = async e => { e.stopPropagation(); b.disabled = true; try { await reuseInto(it); } finally { b.disabled = false; } };
        },
      };
      const LB_CFG = {
        list: browseList,
        keyOf: it => itemKey(it),
        srcOf: it => it.media || '',
        nameOf: it => fileNameOf(it),
        kindOf: it => window.mediaKindOf(it.mtype),
        info: (it, el) => [
          provLabelFor(it), it.model,
          it.dur ? it.dur + 's' : '', it.ar, it.voice ? '音色 ' + it.voice : '',
          (el && el.videoWidth) ? el.videoWidth + '×' + el.videoHeight + 'px' : '',
          Wb.mediaSize(it.media).then(n => (n ? Wb.fmtSize(n) : '')),
        ],
      };
      /* 与收藏 / 资产库 / 素材库共用同一份登记：谁在前台就用谁那一份取数规则，
         由 spa:page 在切页时装回去。以前这里是「点开一次就硬塞自己那一份」，
         切去别的页既不归还也不重装，灯箱翻的是工作台那一份 list。 */
      function openLb(it) { Wb.lightbox.open(it, browseList()); }
      function renderDetail(it, host) { Wb.detail.render(it, host); }
      if (!Wb.lightbox.cfg) Wb.lightbox.init(LB_CFG);
      Wb.lightbox.use('studio.html', { lb: LB_CFG, detail: DETAIL_CFG });

      /* ---------- 复用：把一条历史素材的提示词 + 素材填进左栏 ---------- */
      const SLOT_CANDS = { 视频: ['video', 'frame_first'], 音频: ['audio'], 图片: ['image', 'frame_first', 'frame_last'] };
      const slotCands = mtype => SLOT_CANDS[mtype === '视频' ? '视频' : (window.isAudioType(mtype) ? '音频' : '图片')] || SLOT_CANDS['图片'];
      function slotKindFor(mtype) { return slotCands(mtype).find(k => slots.some(x => x.kind === k)) || null; }
      function findModelWithSlot(kinds) {
        const arr = (Array.isArray(kinds) ? kinds : [kinds]).map(k => (SLOT_DEF[k] || {}).role).filter(Boolean);
        if (!arr.length) return null;
        for (const p of provGroups()) for (const m of (p.models || [])) if (Capabilities.specs(m).some(sp => arr.includes(sp.role))) return { p, m };
        return null;
      }
      async function refIntoSlot(mtype, p, o) {
        const auto = !!(o && o.autoSwitch);
        let kind = (o && o.forceKind) || slotKindFor(mtype);
        if (!kind && auto) {
          const hit = findModelWithSlot(slotCands(mtype));
          if (hit) { $('model').value = hit.p.id + '::' + hit.m.id; $('model').dispatchEvent(new Event('change')); kind = slotKindFor(mtype); }
        }
        if (!kind) return { ok: false, code: 'noslot', why: (auto ? '没有哪个型号收' + mtype + '这类素材' : '当前型号没有能接收' + mtype + '的入口') };
        const def = SLOT_DEF[kind];
        if (!slots.some(x => x.kind === kind)) {
          const fit = fitComboFor([def.role]);
          if (fit && fit.id !== cur().combo) setCombo(fit.id);
        }
        const arr = slotItems(kind), sl = slots.find(x => x.kind === kind);
        if (!sl) return { ok: false, code: 'noslot', why: '当前型号没有「' + def.label + '」这个入口（换型号或清空已选素材再试）' };
        if (blockedSlotKinds().has(kind)) return { ok: false, code: 'blocked', why: def.label + '与已选素材互斥，请先清空已选素材' };
        if (arr.length >= sl.max) return { ok: false, code: 'full', why: def.label + '已满（最多 ' + sl.max + ' 个）' };
        const src = String(p.src || '');
        const idn = p.assetId ? String(p.assetId) : '';
        if (arr.some(x => (idn ? String(x.assetId) === idn : (!!src && (x.src === src || x.url === src)))))
          return { ok: false, code: 'dup', why: '这条素材已经在「' + def.label + '」里了' };
        const name = String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 14) || mtype;
        if (idn && /^\/asset\//.test(src) && !(mtype === '视频' && def.videoFrame)) {
          arr.push({ assetId: idn, url: src, src, name, type: mtype, kind, fromLib: true });
          renderInputArea(); updateMode(); updateGoState();
          return { ok: true, kind, name };
        }
        if (!src && !p.fileKey) return { ok: false, code: 'nosrc', why: '这条素材既没有本机地址也没有本机文件号，取不到字节' };
        setStatus('正在取回素材字节…');
        let blob = null;
        try {
          blob = p.fileKey ? await Fav.fileOf({ kind: 'local', fileKey: p.fileKey })
            : await AssetTransfer.blobOf(p.dl || (window.Api && Api.mediaSrc ? Api.mediaSrc(src) : src));
        } catch (err) {
          return { ok: false, code: 'nobytes', why: '取回素材失败：' + errText(err) };
        }
        if (!blob || !blob.size) return { ok: false, code: 'nobytes', why: '这条素材的字节取不到了（本机文件可能已经不在了）' };
        const f = new File([blob], name + (mtype === '视频' ? '.mp4' : window.isAudioType(mtype) ? '.mp3' : '.png'),
          { type: blob.type || 'application/octet-stream' });
        const n = await addSlotFiles(kind, [f]);
        if (!n) return { ok: false, code: 'rejected', why: def.label + '没收这条素材（类型或体积不在这一栏的声明里）' };
        return { ok: true, kind, name };
      }
      async function reuseInto(it) {
        const wantType = window.mediaKindOf(it.mtype);
        if (TYPE !== wantType) setType(wantType, true);
        /* 覆盖当前草稿前先问：这一击的本意是「照这条再来一次」，不是「把我正在写的换掉」。
           读的是切完类型之后那一条（每型各存一份草稿，要保护的就是即将被写进去的那一栏）。 */
        const draft = ($('prompt').value || '').trim();
        const incoming = String(it.prompt || '').trim();
        if (draft && incoming && draft !== incoming) {
          const ok = await Confirm.ask({
            title: '替换左栏正在写的提示词？',
            body: '这一条会带上它自己的提示词（' + incoming.length + ' 字），替换掉你现在写的 ' + draft.length
              + ' 字；型号与参数也照这一条改。生成不会自动开始 —— 替换完还要你自己点「生成」。',
            okLabel: '替换', cancelLabel: '留着我现在写的', danger: true,
          });
          if (!ok) { setStatus('<span class="warn">已取消：你写的提示词一个字没动</span>'); return; }
        }
        if (it.prompt) $('prompt').value = it.prompt;
        if (it.model) {
          const g = provGroups().find(p => (p.models || []).some(m => m.id === it.model));
          if (g) { $('model').value = g.id + '::' + it.model; $('model').dispatchEvent(new Event('change')); }
        }
        const REUSE_KEYS = ['tier', 'res', 'ar', 'dur', 'quality', 'size'];
        const want = {};
        for (const k of REUSE_KEYS) if (it[k] != null && it[k] !== '') want[k] = String(it[k]);
        if (Object.keys(want).length) {
          try { renderParams(); } catch (e) {}
          for (const k of Object.keys(want)) {
            const el = $(k);
            if (!el || el.tagName !== 'SELECT') continue;
            const opts = Array.from(el.options || []).map(o => String(o.value));
            if (opts.length && opts.indexOf(want[k]) < 0) continue;
            try {
              el.value = want[k];
              if (window.Dropdowns && Dropdowns.sync) Dropdowns.sync(el);
            } catch (e) {}
          }
          try { paintSubNote(); refreshEst(); updateGoState(); } catch (e) {}
        }
        const src = it.src || it.media || it.raw || '';
        const has = !!src || !!it.assetId || !!it.fileKey;
        const r = (has && it.asMaterial)
          ? await refIntoSlot(it.mtype, { src, assetId: it.assetId, dl: it.dl, fileKey: it.fileKey,
            name: it.name || it.prompt }, { autoSwitch: true })
          : null;
        renderInputArea(); updateMode(); updateGoState();
        if (r && !r.ok) { setStatus('<span class="' + (r.code === 'dup' ? 'warn' : 'err') + '">'
          + escA(r.why + (it.prompt ? '（提示词已经填上）' : '')) + '</span>'); return; }
        const bits = [];
        if (it.prompt) bits.push('提示词');
        if (it.model) bits.push('型号');
        if (r && r.ok) bits.push('1 个' + it.mtype + '素材');
        const dropped = (has && !it.asMaterial)
          ? (wantType === 'video'
            ? '（这一条视频本身没有进「参考视频」槽 —— 复用带过来的是提示词与参数；要拿它当参考请用「@ 素材」）'
            : '（这一条素材本身没有进槽 —— 要拿它当参考请用「@ 素材」）')
          : '';
        setStatus('<span class="ok">✓ 已复用：' + bits.join(' + ') + '</span>'
          + '<span class="warn">　确认后自己点「生成」—— 这一步没有提交任务，也没有扣费。</span>'
          + (dropped ? '<span class="warn">　' + dropped + '</span>' : ''));
      }
      async function applyReuseFromAssets() {
        let p2 = null;
        try { p2 = JSON.parse(readLS('sk_reuse', '') || 'null'); } catch (e) {}
        if (!p2) return;
        try { localStorage.removeItem('sk_reuse'); } catch (e) {}
        const mtype = p2.kind === 'video' ? '视频' : p2.kind === 'audio' ? '音频' : '图片';
        const src = p2.src || (p2.assetId ? Api.assetSrc(p2.assetId) : '');
        if (!src && !p2.fileKey && !p2.prompt) return;
        await reuseInto({ mtype, src, assetId: p2.assetId || '', dl: p2.dl || '', fileKey: p2.fileKey || '',
          name: p2.name || '', prompt: p2.prompt || '', model: '',
          tier: p2.tier, res: p2.res, ar: p2.ar, dur: p2.dur, quality: p2.quality, size: p2.size });
      }

      /* ---------- 右栏控件 ---------- */
      $('searchBtn').onclick = () => { searchQ = $('searchBox').value.trim().toLowerCase(); pager.setPage(0); renderAll(); };
      $('searchBox').addEventListener('keydown', e => { if (e.key === 'Enter') $('searchBtn').click(); });
      function pullScope() {
        const seen = new Set();
        return (mergedBatch || mergedItems()).filter(e => {
          if (!e) return false;
          if (!matched(e) || (filterKind !== 'all' && e.mtype !== filterKind)) return false;
          const u = e.src || e.dl || e.rawSrc || e.media || '';
          if (!u) return false;
          /* 范围与卡片徽标读同一份判据（local.js 的 stateOf）：以前这里自己按 kind/地址拼，
             于是同一张卡上写着「本机」、按钮却把它算进「还没存」，或者反过来一颗都不算。 */
          const st = AssetLocal.stateOf(e);
          if (!st.cloud || st.local) return false;
          const k = [e.provider, e.assetId || e.id || e.genId || e.taskId].join('|');
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      function paintPullBtn() {
        if (!$('pullLocalBtn')) return;
        AssetLocal.pullBtn($('pullLocalBtn'), pullScope().length, { what: '产物' });
      }
      $('pullLocalBtn').onclick = async () => {
        const b = $('pullLocalBtn');
        const todo = pullScope();
        if (!todo.length) {
          /* 守卫型那一句走 warn 档：ok/info 默认被安静档吞掉，按钮看起来就是「点了没反应」。 */
          Toast.warn(mergedBatch && mergedBatch.length ? '这一屏要存的本机都已经有了' : '这一屏还没有可存的产物');
          return;
        }
        AssetLocal.pullStart(b);
        const r = await AssetLocal.pullMany(todo.map(e => ({
          entry: e,
          name: String(e.prompt || e.name || '这一条').slice(0, 12),
          apply: u => { e.src = u; },
        })), { onProgress: (done, total) => btnText(b, '存回本机 ' + done + ' / ' + total) });
        AssetLocal.pullEnd(b);
        paintPullBtn();
        AssetLocal.pullReceipt(r);
        if (r.ok) renderAll();
      };
      $('sync').onclick = async () => {
        const b = $('sync');
        b.disabled = true; b.innerHTML = '<span class="spin-dot"></span> 刷新中';
        try {
          const r = await reloadHist();
          tally.run(true);
          /* 取砸了不动列表也不翻回第 1 页：用户在第 5 页找东西，一次网络失败不该把他弹回开头，
             更不该让他以为那一屏的历史没了。 */
          if (r.lost) Toast.warn('历史列表这次没取回来 —— 上面还是刷新前的那一份，点「刷新」可以再试');
          renderAll();
        } finally {
          b.disabled = false; b.innerHTML = icon('refresh', 13) + ' 刷新';
          if (PAGE_MODE === 'more') setTimeout(autoLoadMore, 60);
        }
      };
      $('gotoBtn').onclick = () => pager.gotoInput('gotoPage');
      $('stGotoPage').addEventListener('keydown', e => { if (e.key === 'Enter') pager.gotoInput('gotoPage'); });
      let pullMore = null;
      function autoLoadMore() { if (pullMore) pullMore(); }
      const onResize = () => { if (PAGE_MODE === 'more') setTimeout(autoLoadMore, 120); };
      window.addEventListener('resize', onResize);
      disposers.push(() => window.removeEventListener('resize', onResize));

      /* ---------- 从右栏 / 操作系统拖到左栏当参考素材 ---------- */
      function slotRowOver(on) { const b = $('promptBox'); if (b) b.classList.toggle('over', on); }
      /* 「这一次拖动要不要接」两半各只问一处：站内拖过来的卡片带自己的载荷类型；
         真·外部文件走 ui.js 的 `isExternalFileDrag` —— 它把「同时带 text/html / text/uri-list」
         那种排掉（在页里拖一张图、拖一段选中内容也是 Files），否则页内拖一张卡片
         会被当成一次本地上传（收藏页就多出来过那么一条）。 */
      const dragHasPayload = e => {
        const dt = e && e.dataTransfer;
        if (!dt) return false;
        const types = Array.from(dt.types || []);
        return types.some(t => t === 'application/x-studio-ref' || t === 'application/x-asset-id')
          || window.isExternalFileDrag(e);
      };
      function markSlotOver(el) {
        if (overSlot === el) return;
        if (overSlot) overSlot.classList.remove('drop-on');
        overSlot = el;
        if (el) el.classList.add('drop-on');
      }
      function clearSlotOver() { if (overSlot) { overSlot.classList.remove('drop-on'); overSlot = null; } }
      async function dropRefMediaInto(kind, p) {
        const def = SLOT_DEF[kind];
        if (!slots.some(s => s.kind === kind)) { setStatus('<span class="err">当前型号没有「' + def.label + '」这个入口</span>'); return; }
        const mtype = p.mtype || '图片';
        if (!slotTakesType(kind, mtype)) { setStatus('<span class="err">' + def.label + '不收' + mtype + '素材</span>'); return; }
        const r = await refIntoSlot(mtype, p, { forceKind: kind });
        if (r.ok) { setStatus('<span class="ok">✓ 已把《' + escA(r.name || mtype) + '》加入' + def.label + '</span>'); return; }
        if (r.code === 'blocked') { flashSlotHint(r.why); return; }
        setStatus('<span class="err">' + escA(r.why) + '</span>');
      }
      async function dropOntoSlot(kind, dt) {
        const def = SLOT_DEF[kind];
        if (!def) return;
        if (!slots.some(s => s.kind === kind)) { setStatus('<span class="err">当前型号没有「' + def.label + '」这个入口</span>'); return; }
        const raw = dt.getData('application/x-studio-ref');
        if (raw) {
          let p = null; try { p = JSON.parse(raw); } catch (err) {}
          if (p && (p.src || p.assetId)) { await dropRefMediaInto(kind, p); return; }
        }
        const aid = dt.getData('application/x-asset-id');
        if (aid) { await dropRefMediaInto(kind, { mtype: '图片', assetId: aid, src: Api.assetSrc(aid), dl: Api.assetDl(aid) }); return; }
        const files = [...(dt.files || [])];
        if (!files.length) return;
        const n = await addSlotFiles(kind, files);
        if (n) setStatus('<span class="ok">✓ 已把 ' + n + ' 个文件加入' + def.label + '</span>');
      }
      const areaEl = $('inputArea');
      ['dragover', 'dragenter'].forEach(ev => areaEl.addEventListener(ev, e => {
        const el = e.target && e.target.closest ? e.target.closest('[data-slot]') : null;
        if (!el || !dragHasPayload(e)) return;
        e.preventDefault();
        e.stopPropagation();
        slotRowOver(false);
        markSlotOver(el);
      }));
      areaEl.addEventListener('dragleave', e => {
        if (overSlot && (!e.relatedTarget || !overSlot.contains(e.relatedTarget))) clearSlotOver();
      });
      areaEl.addEventListener('drop', async e => {
        const el = e.target && e.target.closest ? e.target.closest('[data-slot]') : null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        clearSlotOver();
        slotRowOver(false);
        await dropOntoSlot(el.dataset.slot, e.dataTransfer);
      });
      window.addEventListener('drop', clearSlotOver);
      disposers.push(() => window.removeEventListener('drop', clearSlotOver));
      window.addEventListener('dragend', clearSlotOver);
      disposers.push(() => window.removeEventListener('dragend', clearSlotOver));
      const boxEl = $('promptBox');
      ['dragover', 'dragenter'].forEach(ev => boxEl.addEventListener(ev, e => {
        if (!dragHasPayload(e)) return;
        e.preventDefault(); slotRowOver(true);
      }));
      boxEl.addEventListener('dragleave', e => { if (!boxEl.contains(e.relatedTarget)) slotRowOver(false); });
      boxEl.addEventListener('drop', async e => {
        e.preventDefault(); slotRowOver(false);
        const dt = e.dataTransfer;
        if (!dt) return;
        const raw = dt.getData('application/x-studio-ref');
        if (raw) {
          let p = null;
          try { p = JSON.parse(raw); } catch (err) {}
          if (p && (p.src || p.assetId)) { await dropRefMedia(p); return; }
        }
        const aid = dt.getData('application/x-asset-id');
        if (aid) {
          await dropRefMedia({ mtype: '图片', assetId: aid, src: Api.assetSrc(aid), dl: Api.assetDl(aid) });
          return;
        }
        const files = [...(dt.files || [])];
        if (!files.length) return;
        const has = k => slots.some(x => x.kind === k);
        for (const f of files) {
          const want = f.type.startsWith('video/')
            ? (has('video') ? 'video' : (has('frame_first') ? 'frame_first' : null))
            : f.type.startsWith('audio/') ? (has('audio') ? 'audio' : null)
              : (has('image') ? 'image' : has('frame_first') ? 'frame_first' : (has('frame_last') ? 'frame_last' : null));
          if (!want) { setStatus('<span class="err">当前型号没有可接收该文件的入口</span>'); return; }
          await addSlotFiles(want, [f]);
        }
      });
      async function dropRefMedia(p) {
        const mtype = p.mtype || '图片';
        const r = await refIntoSlot(mtype, p);
        if (r.ok) { setStatus('<span class="ok">✓ 已把《' + (r.name || mtype) + '》加入' + SLOT_DEF[r.kind].label + '</span>'); return; }
        if (r.code === 'blocked') { flashSlotHint(r.why); return; }
        if (r.code === 'dup') { setStatus(escA(r.why)); return; }
        setStatus('<span class="err">' + escA(r.why) + (r.code === 'noslot' ? '（换型号或清空已选素材再试）' : '') + '</span>');
      }

      /* ---------- 左栏整块重画（切类型 / 换型号之后） ---------- */
      function paintLeft() {
        renderModelOptions();
        slots = modelSlots();
        $('splitBtn').hidden = TYPE !== 'image';
        if (TYPE !== 'image') $('splitInline').hidden = true;
        renderParams();
        renderInputArea();
        paintSubNote();
        updateMode();
        updateGoState();
        refreshEst();
        syncStyleRow();
      }

      /* ============================ ⑪ 启动 ============================ */
      let bootStopped = false;
      async function boot() {
        TYPE = readTypeFromURL() || readLS('studio_type', '') || 'video';
        if (!TYPES[TYPE]) TYPE = 'video';
        const picks = loadPicks();
        /* 型号与提示词都按类型各备一份：型号记在 studio_pick，提示词记 studio_prompt_<type>。 */
        TYPE_LIST.forEach(t => { ST[t].prompt = readLS('studio_prompt_' + t, ''); });
        ST[TYPE].model = picks[TYPE] || '';
        $('prompt').value = ST[TYPE].prompt;
        $('splitDimCustom').value = readLS('studio_split_dim_custom', '');
        setType(TYPE, false);
        try { REG = await Api.registry(); } catch (e) { REG = { providers: [] }; }
        if (bootStopped) return;
        if (window.Api) Api.setRegistry(REG);
        renderModelOptions();
        if (!serverEntries.length) {
          const cached = LIST_CACHE.read();
          if (cached.length) serverEntries = cached;
        }
        loadAudioTasks();
        paintLeft();
        Wb.thumbs.hydrate().then(n => { if (n && !bootStopped) { try { renderAll(); } catch (e) {} } }).catch(() => {});
        loadServer(1).then(() => { if (!bootStopped && PAGE_MODE === 'more') setTimeout(autoLoadMore, 60); })
          .catch(() => {})
          .then(() => { if (!bootStopped) tally.run(); });
        poller.kick();
        renderAll();
        pager.bindButtons();
        pullMore = pager.bindScroll($('result'));
        try { await Capabilities.load(REG); } catch (e) {}
        if (bootStopped) return;
        renderModelOptions();
        paintLeft();
        refreshCaps();
        if (/[?&]reuse=1/.test(pageQuery() || '')) {
          try { await applyReuseFromAssets(); } catch (e) { setStatus('<span class="err">复用失败：' + escAerrText(e) + '</span>'); }
        }
      }
      boot().catch(e => {
        setStatus('<span class="err">启动失败：' + escAerrText(e) + '</span>');
        console.error('[studio] 启动失败', e);
      });

      /* 提示词按类型各存一份（落盘 250 ms 防抖；pagehide 同步补写保证不丢） */
      let promptLsTimer = 0;
      $('prompt').addEventListener('input', () => {
        cur().prompt = $('prompt').value;
        clearTimeout(promptLsTimer);
        promptLsTimer = setTimeout(() => { promptLsTimer = 0; writeLS('studio_prompt_' + TYPE, $('prompt').value); }, 250);
      });
      $('style').addEventListener('input', () => { cur().style = $('style').value; });
      /* 「取一位素材的音色描述」：整链在公共层 `VoiceNote.run`（走统一选择器第四个来源），
         这里只交 value / write / say 三个口子。 */
      $('stylePick').onclick = () => window.VoiceNote.run({
        value: () => $('style').value,
        write: t => { $('style').value = t; cur().style = t; updateGoState(); },
        say: setStatus,
      });
      /* 关标签 / 刷新前把这一页手上的东西交出去。统一通道是 `__spaRegister(flush, dirty)`：
         外壳在 beforeunload 上问 dirty 决定要不要拦、刷新与 __spaReload 也跑同一张表。
         `pagehide` 只留作「后台标签页被系统回收」那一趟（它不经过 beforeunload），
         两边调的是同一个 flush —— 以前是「保存只挂 pagehide、拦不拦由外壳另一套判据说」，
         于是刷新时提示词那 250 ms 里的字直接没了。 */
      const flushPage = () => {
        clearTimeout(promptLsTimer); promptLsTimer = 0;
        writeLS('studio_prompt_' + TYPE, $('prompt').value);
        saveAudioTasks();
      };
      const offSaveHook = window.__spaRegister
        ? window.__spaRegister(flushPage, () => !!promptLsTimer)
        : null;
      const onPageHide = () => flushPage();
      window.addEventListener('pagehide', onPageHide);
      disposers.push(() => window.removeEventListener('pagehide', onPageHide));
      if (offSaveHook) disposers.push(offSaveHook);

      /* 外壳那条通道：类型切换与跨页复用（Vue 组件不在 iframe 里，web/app.js 的 iframe 钩子够不着）。 */
      window.setType = (t, fromUser) => setType(t, fromUser);
      window.__studioRepaint = () => { paintLeft(); renderAll(); };
      window.__studioReuse = () => applyReuseFromAssets().catch(e => setStatus('<span class="err">复用失败：' + escAerrText(e) + '</span>'));

      return () => {
        bootStopped = true;
        clearTimeout(promptLsTimer);
        clearTimeout(slotHintTimer);
        dropClearShot();
        stopPendingTick();
        try { poller.stop(); } catch (e) {}
        disposers.forEach(fn => { try { fn(); } catch (e) {} });
        if (window.setType) delete window.setType;
        if (window.__studioRepaint) delete window.__studioRepaint;
        if (window.__studioReuse) delete window.__studioReuse;
      };
    }

    onMounted(async () => {
      if (!pageEl.value) return;
      collectMain();
      try {
        await window.__spaLoadScript('web/ui/workbench.js', () => window.Wb);
        await window.__spaLoadScript('web/domain/chars.js', () => window.Chars);
      } catch (e) {
        const st = pageEl.value.querySelector('[data-r="status"]');
        if (st) st.innerHTML = '<span class="err">公共模块没有加载起来：' + window.escerrText(e) + '</span>';
        return;
      }
      if (!window.Wb || !window.Api || !window.AssetLocal || !window.AssetLib) {
        const st = pageEl.value.querySelector('[data-r="status"]');
        if (st) st.innerHTML = '<span class="err">生成工作台依赖的公共模块没有就绪（workbench.js / assetlib.js）</span>';
        return;
      }
      if (disposed) return;
      await nextTick();
      if (disposed) return;
      /* 模板里那些静态 <span data-icon>：ui.js 的 fillIcons 只在外壳 DOMContentLoaded 跑过一次，
         那时本组件还没挂载 —— 不在这里补一遍，四颗按钮上的图标全是空的。 */
      if (pageEl.value) window.fillIcons(pageEl.value);
      cleanup = runPage();
      /* 外壳从地址栏 / 别的页面切到另一档（?t=）时要真的换过去；带 reuse=1 的那次也要消费载荷。 */
      if (activeFile) {
        watch(activeFile, f => { if (f === 'studio.html') { try { if (window.__studioRepaint) window.__studioRepaint(); } catch (e) {} } });
      }
      if (spaRoute) {
        watch(() => spaRoute.route && spaRoute.route.src, src => {
          if (disposed || !src || !/^studio\.html/.test(src)) return;
          const q = src.slice(src.indexOf('?') >= 0 ? src.indexOf('?') : src.length);
          const m = /[?&]t=(video|image|audio)/.exec(q);
          if (m && window.setType) { window.setType(m[1], false); if (window.__studioRepaint) window.__studioRepaint(); }
          if (/[?&]reuse=1/.test(q) && window.__studioReuse) window.__studioReuse();
        });
      }
    });

    onBeforeUnmount(() => {
      disposed = true;
      if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }
    });

    return { pageEl };
  },
  /* 静态模板：一份标记，不参与重绘（动态区域由脚本自己灌 innerHTML，Vue 不接管它们的子节点）。
     所有 `data-r` 名字就是旧页面里的 id —— 迁过来的脚本仍然写 `$('prompt')`，只是查的是本页登记表。 */
  render,
};

export default StudioView;
