/* 建模台 —— 第八页。一句话让文字 AI 写出一棵参数化零件树（白膜），
   在 three 视口里流式长出来；模型存成库根下的真文件、按组管理；出图 / 出片进本机资产库，
   可回传给工作台 / 导演台当参考。

   页面形态与导演台同一副：整页不滚，页头 + 三栏（库 / 视口 / 右栏），底部一条轨道坞。
   内部一律命令式（库卡片、视口、对象树、时间线都是脚本灌 innerHTML）——
   这些节点会被反复重画、要保住滚动位与选中态，做成 Vue 组件反而要跟渲染时机打架
   （导演台是同一句结论：外壳是 Vue，内部按域拆成命令式模块）。Vue 只当页面壳。 */
import { ref, onMounted, onActivated, onDeactivated, onBeforeUnmount, nextTick } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/model.js';
import { createView } from '../model3d/view.js';
import { disposeAllCaches } from '../model3d/scene.js';
import * as S from '../model3d/schema.js';
import * as Vault from '../model3d/vault.js';
import * as AI from '../model3d/ai.js';
import * as Capture from '../model3d/capture.js';
import * as Loader from '../model3d/loader.js';
import { resolveRefs } from '../model3d/dsl.js';
import { entityFromModel, modelFromEntity, subtreeIds } from '../model3d/entities.js';
import { clipNamesOf, clipOf } from '../model3d/clip.js';
import { BODY_PRESETS, POSE_PRESETS } from '../model3d/mannequin.js';
import { CLAY } from '../model3d/palette.js';
import { createDock } from './model/dock.js';

const PAGE_FILE = 'model.html';
const D2R = Math.PI / 180;
const ASPECTS = ['16:9', '9:16', '1:1', '4:3'];
const CLAY_HEX = '#' + CLAY.mid.toString(16).padStart(6, '0');

const esc = s => window.esc(String(s == null ? '' : s));
const ic = (name, size) => (window.icon ? window.icon(name, size || 13) : '');

export default {
  name: 'ModelView',
  setup() {
    const pageEl = ref(null);
    let active = { value: true };
    let view = null;
    let built = false;
    let disposed = false;

    /* ---------------- 页面状态 ---------------- */
    const st = {
      doc: null,
      savedId: '',            // 当前场景 id（场景组/名）
      lastSceneId: '',        // 上一个打开过的已保存场景（丢弃 / 删除当前后退回这里）
      savedGroup: '',         // 当前场景组
      docLibrary: '',         // 当前场景所在的白模库
      savedDigest: '',        // 用来判「有没有改动」
      selectedId: '',
      selectedCam: '',
      selIds: [],             // 场景树多选（编组 / 批量删除）
      dragId: '',             // 正在拖的树行
      renameId: '',           // 正在行内改名的节点 / 场景
      railTab: 'scene',       // scene | lib
      sideTab: 'ai',          // ai | props | cam
      refImages: [],          // 交接口袋带来的参考图（只给 AI 看）
      origin: null,           // { page:'studio'|'director', type?, shot? }
      prevDoc: null,          // AI 修改前的快照（「撤销这次修改」）
      library: '',            // 当前白模库 id
      libraries: [],
      libGroup: '',           // 白模库里的组筛选：'' 全部 / '__none' 未分组 / 组名
      groups: [],
      models: [],
      scenes: [],
      sceneGroups: [],
      sceneGroup: '',         // 新建场景落在哪个组；'' = 未分组
      sceneEdit: '',          // 正在行内改名的场景 id
      sceneMove: '',          // 正在选组的场景 id
      sceneGroupEdit: '',     // 正在行内改名的场景组
      sceneGroupDraft: false, // 正在行内新建场景组
      search: '',
      busy: '',
      shortEdge: 720,
      note: '',
      showRig: true,          // 相机标识（视锥）显示开关；页面偏好，不进 doc
      navMode: 'rotate',      // 导演视角左键：rotate | pan
      aiText: '',             // 上一轮 AI 的说明（生成结束后留在面板上）
      aiSay: '',              // 正在流式输出的那一句（边收边显示）
      aiRaw: '',              // AI 的原始输出（JSON 流，面板里回显尾巴）
      aiCount: 0,             // 流式过程中已收全的零件数
      aiLibs: [],             // AI 可调用的白模库（多选）
      aiModels: new Map(),    // 非当前库的模型清单缓存（库 id → rows）
      previewDoc: null,       // 流式过程中的临时树（不写进 doc，取消就回到原样）
      outOpen: true,          // 出片条展开 / 收起
      assets: new Map(),      // 3D 文件 → 已解析原型（loader.js 填；scene 只 clone）
    };
    const assetPending = new Set();   // 正在读的导入件（同一份文件不至于被并发读两次）
    let dock = null;                   // 时间轴坞：播放时钟 / 轨道行 / 播放头唯一所有者

    const $ = id => pageEl.value && pageEl.value.querySelector('[data-r="' + id + '"]');
    const refreshPhead = () => {
      const name = $('mmName');
      const dirty = $('mmDirty');
      const sub = $('mmSub');
      if (name) name.textContent = (st.doc && st.doc.name) || '未命名场景';
      if (sub) sub.textContent = st.library
        ? st.library + (st.savedGroup ? ' / ' + st.savedGroup : '') + ' / 场景'
        : '先选白模库，再建或打开场景';
      if (dirty) {
        const isDirty = st.doc && S.digest(st.doc) !== st.savedDigest;
        dirty.textContent = !st.savedId ? '未保存' : (isDirty ? '有改动' : '已保存');
        dirty.className = 'phead-chip' + (isDirty ? '' : '');
      }
    };

    /* ---------------- 视口 ---------------- */
    function mountView() {
      const host = $('mmViewport');
      if (!host) return;
      view = createView(host, { assets: () => st.assets });
      /* 相机标识是编辑辅助：开关存在页面偏好里（不进模型文件，导出给别人的 .json 不会带着它） */
      st.showRig = window.LS.get('sk_model_rig', '1') !== '0';
      view.setRigVisible(st.showRig);
      st.navMode = window.LS.get('sk_model_nav', 'rotate') === 'pan' ? 'pan' : 'rotate';
      view.setNavMode(st.navMode);
      const isActive = window.__spaActivity ? window.__spaActivity.forPage(PAGE_FILE) : (() => true);
      view.setActive(() => active.value && isActive());
      view.onPick = sel => {
        if (sel && typeof sel === 'object' && sel.kind === 'cam') {
          selectCam(sel.id);
          return;
        }
        st.selectedCam = '';
        st.selectedId = sel || '';
        st.selIds = sel ? [sel] : [];
        paintTree();
        paintProps();
        paintTools();
        view.setSelection(st.selectedId);
      };
      view.onTransform = (id, t) => {
        const node = S.findNode(st.doc.scene.nodes, id);
        if (!node || node.locked) return;
        if (t.at) node.at = t.at;
        if (t.rot) node.rot = t.rot;
        if (t.scale) node.scale = t.scale;
        refreshPhead();
        paintTree();
        if (st.sideTab === 'props') paintProps();
      };
      view.onCamTransform = (id, t) => {
        const cam = S.camOf(st.doc, id);
        if (!cam) return;
        cam.pos = t.pos;
        if (t.target) cam.target = t.target;
        const tr = cameraTrackOf(id);
        if (tr) {
          const time = Math.round((view ? view.time : 0) * 100) / 100;
          tr.keys = tr.keys.filter(k => Math.abs(k.t - time) > 0.001);
          tr.keys.push({ t: time, at: cam.pos.slice(), target: cam.target.slice(), fov: cam.fov });
          tr.keys.sort((a, b) => a.t - b.t);
        }
        refreshPhead();
        if (view) view.applyCamera(view.time);
        paintCam();
        paintCams();
      };
      view.onCameraChange = () => { /* 导演视角的机位不写回模型：那是「看」的位置，不是作品的一部分 */ };
      /* 建场景时记下的话（没这条动画 / 摆件没加载）落到状态行；同一份 doc 只报一次。
         条数不截断：状态行自己换行 / 滚动，不替用户丢信息。 */
      view.onNotes = notes => { if (notes && notes.length) note(notes.join('；'), 'err'); };
    }

    /* ---------------- 白模库 / 场景列表 ---------------- */
    function syncAiLibs() {
      const ids = new Set((st.libraries || []).map(x => x.id));
      const raw = window.LS.get('sk_model_ai_libs', '');
      if (!raw) {
        st.aiLibs = st.library && ids.has(st.library) ? [st.library] : [];
        return;
      }
      let saved = [];
      try {
        const rawList = JSON.parse(raw);
        saved = Array.isArray(rawList) ? rawList.map(String) : [];
      } catch (e) { saved = []; }
      st.aiLibs = saved.filter(id => ids.has(id));
      if (st.aiLibs.length !== saved.length) window.LS.set('sk_model_ai_libs', JSON.stringify(st.aiLibs));
    }

    async function loadLibraries() {
      try {
        const d = await Vault.list('');
        st.libraries = d.libraries || [];
        const hasLib = id => !!id && st.libraries.some(x => x.id === id);
        const want = window.LS.get('sk_model_library', '');
        const pick = hasLib(want) ? want : hasLib(st.library) ? st.library : (st.libraries[0] && st.libraries[0].id) || '';
        if (pick) await loadLibrary(pick);
        else { st.library = ''; st.models = []; st.scenes = []; st.groups = []; st.sceneGroups = []; paintLib(); paintScenes(); }
        syncAiLibs();
      } catch (e) {
        st.libraries = [];
        note('白模库读不出来：' + window.errText(e), 'err');
        paintLib();
      }
    }

    async function loadLibrary(id) {
      try {
        const d = await Vault.list(id);
        st.library = d.library || id || '';
        st.libraries = d.libraries || st.libraries;
        st.models = d.models || [];
        st.scenes = d.scenes || [];
        st.groups = d.groups || [];
        st.sceneGroups = d.sceneGroups || [];
        if (st.libGroup && st.libGroup !== '__none' && !(st.groups || []).some(g => g.name === st.libGroup)) st.libGroup = '';
        st.aiModels.clear();
        if (st.library) window.LS.set('sk_model_library', st.library);
        syncAiLibs();
        paintLib();
        paintScenes();
        refreshPhead();
        if (st.sideTab === 'ai') paintSide();
      } catch (e) {
        note('库读不出来：' + window.errText(e), 'err');
      }
    }

    /* 没有库时也要能开新场景：自动选第一个，一个都没有就建默认库。 */
    async function ensureLibrary() {
      if (st.library) return true;
      if (!(st.libraries || []).length) await loadLibraries();
      if (!(st.libraries || []).length) {
        try {
          await Vault.saveLibrary({ name: '默认库' });
          await loadLibraries();
        } catch (e) { note('建默认库失败：' + window.errText(e), 'err'); return false; }
      }
      if (!st.library) {
        const first = (st.libraries || [])[0];
        if (!first) { note('还没有白模库，先在「白模库」里建一个', 'err'); return false; }
        await loadLibrary(first.id);
      }
      return !!st.library;
    }

    async function selectLibrary(id) {
      if (id === st.library) return;
      const switchScene = !!(st.doc && st.docLibrary && st.docLibrary !== id);
      if (switchScene && st.doc && S.digest(st.doc) !== st.savedDigest) {
        const ok = await window.Confirm.ask({
          title: '切换白模库？',
          body: '当前场景还没保存。切库后会先新开一个空场景；原场景留在原来的库里。',
          okLabel: '切换',
        });
        if (!ok) return;
      }
      await loadLibrary(id);
      if (switchScene) createScene();
    }

    function visibleModels() {
      const q = st.search.trim().toLowerCase();
      return (st.models || []).filter(m => {
        if (st.libGroup === '__none' && m.group) return false;
        if (st.libGroup && st.libGroup !== '__none' && m.group !== st.libGroup) return false;
        return !q || (m.id + ' ' + (m.name || '') + ' ' + (m.group || '')).toLowerCase().indexOf(q) >= 0;
      });
    }

    function paintRailTabs() {
      const host = $('mmRailTabs');
      if (!host) return;
      host.innerHTML = '<div class="ui-seg" role="tablist">'
        + [['scene', '场景'], ['lib', '白模库']].map(([id, label]) =>
          '<button type="button" role="tab" aria-selected="' + (st.railTab === id ? 'true' : 'false') + '" class="' + (st.railTab === id ? 'on' : '') + '" data-rail="' + id + '">' + label + '</button>').join('')
        + '</div>';
      host.onclick = e => {
        const b = e.target.closest('[data-rail]');
        if (!b) return;
        setRailTab(b.dataset.rail);
      };
    }
    function setRailTab(id) {
      st.railTab = id === 'lib' ? 'lib' : 'scene';
      window.LS.set('sk_model_rail', st.railTab);
      const scene = $('mmScenePane');
      const lib = $('mmLibPane');
      if (scene) scene.hidden = st.railTab !== 'scene';
      if (lib) lib.hidden = st.railTab !== 'lib';
      paintRailTabs();
      if (st.railTab === 'scene') paintScenes();
      else paintLib();
    }

    function paintLib() {
      const bar = $('mmLibraryBar');
      const groupsHost = $('mmGroups');
      const grid = $('mmCards');
      if (!bar || !groupsHost || !grid) return;
      if (!st.library) {
        bar.innerHTML = '<div class="mm-lib-title"><b>白模库</b><button class="ghost mini" type="button" data-lib-act="newLib">' + ic('plus', 12) + ' 白模库</button></div>';
        bar.onclick = e => { if (e.target.closest('[data-lib-act="newLib"]')) newLibrary(); };
        groupsHost.innerHTML = '';
        const rows = st.libraries || [];
        grid.innerHTML = rows.length
          ? rows.map(x => '<div class="mm-library-card" data-lib-id="' + esc(x.id) + '">'
            + '<span class="mm-library-name">' + esc(x.name) + '</span>'
            + '<span class="mm-library-meta">' + x.models + ' 个模型 · ' + x.scenes + ' 个场景</span>'
            + '<span class="mm-library-acts"><button class="ui-linkbtn" type="button" data-lib-act="renameLib" data-lib-id="' + esc(x.id) + '">改名</button>'
            + '<button class="ui-linkbtn" type="button" data-lib-act="delLib" data-lib-id="' + esc(x.id) + '">删除</button></span></div>').join('')
          : '<div class="mm-empty">还没有白模库。点上面的「＋ 白模库」建一个。</div>';
        grid.onclick = e => {
          const act = e.target.closest('[data-lib-act]');
          if (act) {
            if (act.dataset.libAct === 'newLib') { newLibrary(); return; }
            if (act.dataset.libAct === 'renameLib') { renameLibrary(act.dataset.libId); return; }
            if (act.dataset.libAct === 'delLib') { deleteLibrary(act.dataset.libId); return; }
          }
          const card = e.target.closest('[data-lib-id]');
          if (card) selectLibrary(card.dataset.libId);
        };
        return;
      }
      bar.innerHTML = '<div class="mm-lib-title"><button class="ghost mini" type="button" data-lib-act="back">← 全部库</button>'
        + '<b>' + esc(st.library) + '</b><span class="mm-library-meta">' + (st.models || []).length + ' 个模型</span>'
        + '<span class="sp"></span><button class="ghost mini" type="button" data-lib-act="newGroup">' + ic('folder', 12) + ' 组</button>'
        + '<button class="ghost mini" type="button" data-lib-act="groupManage" title="模型组管理">' + ic('gear', 12) + '</button>'
        + '<button class="ui-linkbtn" type="button" data-lib-act="renameLib" data-lib-id="' + esc(st.library) + '">改名</button>'
        + '<button class="ui-linkbtn" type="button" data-lib-act="delLib" data-lib-id="' + esc(st.library) + '">删除</button></div>';
      const all = (st.models || []).length;
      const ungrouped = (st.models || []).filter(m => !m.group).length;
      const chips = [{ v: '', t: '全部 ' + all }]
        .concat((st.groups || []).map(g => ({ v: g.name, t: g.name + ' ' + g.count })))
        .concat([{ v: '__none', t: '未分组 ' + ungrouped }]);
      groupsHost.innerHTML = chips.map(c => '<button class="chip' + (st.libGroup === c.v ? ' on' : '') + '" type="button" data-lib-group="' + esc(c.v) + '">' + esc(c.t) + '</button>').join('');
      groupsHost.onclick = e => {
        const b = e.target.closest('[data-lib-group]');
        if (!b) return;
        st.libGroup = b.dataset.libGroup;
        paintLib();
      };
      const rows = visibleModels();
      if (!rows.length) {
        grid.innerHTML = '<div class="mm-empty">这个库还没有模型。<br>在场景里新建实体后，选中它点「存入白模库」。</div>';
        return;
      }
      grid.innerHTML = rows.map(m => {
        const thumb = Vault.thumbUrl(m, st.library, 'model');
        return '<div class="mm-card" data-model-id="' + esc(m.id) + '">'
          + '<button class="mm-card-open" type="button" data-model-act="insert" data-model-id="' + esc(m.id) + '" title="放进当前场景">'
          + (thumb ? '<img class="mm-card-thumb" src="' + esc(thumb) + '" alt="" loading="lazy">' : '<span class="mm-card-thumb empty">' + ic('box', 16) + '</span>')
          + '<span class="mm-card-main"><span class="mm-card-t">' + esc(m.name) + '</span>'
          + '<span class="mm-card-s">' + esc(m.group || '未分组') + ' · ' + Math.max(0, Math.round((m.bytes || 0) / 1024)) + ' KB</span></span>'
          + '</button>'
          + '<span class="mm-card-acts"><button class="ui-linkbtn" type="button" data-model-act="rename" data-model-id="' + esc(m.id) + '" title="改名">' + ic('pencil', 12) + '</button>'
          + '<button class="ui-linkbtn" type="button" data-model-act="move" data-model-id="' + esc(m.id) + '" title="移到组">' + ic('folder', 12) + '</button>'
          + '<button class="ui-linkbtn" type="button" data-model-act="del" data-model-id="' + esc(m.id) + '" title="删除">' + ic('trash', 12) + '</button></span></div>';
      }).join('');
      grid.onclick = e => {
        const b = e.target.closest('[data-model-act]');
        if (!b) return;
        const id = b.dataset.modelId;
        if (b.dataset.modelAct === 'insert') insertModel(id);
        else if (b.dataset.modelAct === 'rename') renameLibraryModel(id);
        else if (b.dataset.modelAct === 'move') moveLibraryModel(id);
        else if (b.dataset.modelAct === 'del') deleteLibraryModel(id);
      };
      bar.onclick = e => {
        const b = e.target.closest('[data-lib-act]');
        if (!b) return;
        if (b.dataset.libAct === 'back') { st.library = ''; paintLib(); paintScenes(); return; }
        if (b.dataset.libAct === 'newGroup') createModelGroupPrompt();
        else if (b.dataset.libAct === 'groupManage') manageModelGroups();
        else if (b.dataset.libAct === 'renameLib') renameLibrary(b.dataset.libId);
        else if (b.dataset.libAct === 'delLib') deleteLibrary(b.dataset.libId);
      };
    }

    function sceneGroupsView() {
      const list = (st.sceneGroups || []).map(g => ({
        name: g.name,
        scenes: (st.scenes || []).filter(s => s.group === g.name),
      }));
      const none = (st.scenes || []).filter(s => !s.group);
      if (none.length) list.push({ name: '', scenes: none, none: true });
      /* 还没落盘的当前场景也要看得见：否则刚点「＋ 场景」时列表还是空的。 */
      if (st.doc && !st.savedId) {
        const group = st.doc.group || '';
        let g = list.find(x => (x.name || '') === group);
        if (!g) { g = { name: group, scenes: [], none: !group }; list.push(g); }
        g.scenes.unshift({ id: '', name: st.doc.name || '未命名场景', group, unsaved: true });
      }
      return list;
    }

    /* 在某个场景组里挑一个不与已保存场景重名的名字。 */
    function uniqueSceneName(base, group) {
      const stem = String(base || '').trim() || '未命名场景';
      const rows = (st.scenes || []).filter(s => (s.group || '') === group);
      if (!rows.some(s => s.name === stem)) return stem;
      let n = 2;
      while (rows.some(s => s.name === stem + ' ' + n)) n += 1;
      return stem + ' ' + n;
    }

    function nextSceneName(group) {
      const names = new Set((st.scenes || []).filter(s => (s.group || '') === group).map(s => s.name));
      /* 当前还没落盘的那一份也算：连点「＋ 场景」不会每次得到同名空场景。 */
      if (st.doc && !st.savedId && (st.doc.group || '') === group && st.doc.name) names.add(st.doc.name);
      if (!names.has('未命名场景')) return '未命名场景';
      let n = 2;
      while (names.has('未命名场景 ' + n)) n += 1;
      return '未命名场景 ' + n;
    }

    function paintScenes() {
      const host = $('mmScenes');
      if (!host) return;
      const head = '<div class="mm-scenes-head"><span>场景</span>'
        + '<button class="ghost mini" type="button" data-scene-act="new">' + ic('plus', 12) + ' 场景</button>'
        + '<button class="ghost mini" type="button" data-scene-act="newGroup">' + ic('folder', 12) + ' 组</button></div>';
      if (!st.library) {
        host.innerHTML = head + '<div class="mm-empty">还没有选白模库；点「＋ 场景」会自动用第一个库。</div>';
        host.onclick = e => {
          if (e.target.closest('[data-scene-act="new"]')) createScene(null, null, { announce: true, forceSave: true });
          if (e.target.closest('[data-scene-act="newGroup"]')) newSceneGroup();
        };
        return;
      }
      const rows = [];
      for (const g of sceneGroupsView()) {
        const editing = !!g.name && st.sceneGroupEdit === g.name;
        rows.push('<div class="mm-scene-group' + (g.none ? ' none' : '') + '" data-group="' + esc(g.name) + '">'
          + (editing
            ? '<input class="ui-inp mm-scene-group-edit" data-group-input="' + esc(g.name) + '" value="' + esc(g.name) + '">'
            : '<span class="gname">' + esc(g.name || '未分组') + '</span>')
          + '<span class="cnt">' + g.scenes.length + '</span><span class="sp"></span>'
          + (g.name ? '<span class="ops">'
            + '<button class="ui-linkbtn" type="button" data-scene-act="renameGroup" data-group="' + esc(g.name) + '">改名</button>'
            + '<button class="ui-linkbtn" type="button" data-scene-act="delGroup" data-group="' + esc(g.name) + '">删除</button>'
            + '</span>' : '')
          + '</div>');
        for (const s of g.scenes) {
          if (s.unsaved) {
            rows.push('<div class="mm-scene-row on unsaved"><div class="mm-scene-open static">'
              + '<span class="nm">' + esc(s.name) + '</span><span class="mini">未保存</span></div>'
              + '<span class="mm-scene-acts always"><button class="ui-linkbtn" type="button" data-scene-act="discard" title="丢弃未保存的场景">' + ic('trash', 11) + ' 丢弃</button></span></div>');
            continue;
          }
          const on = st.savedId === s.id && st.docLibrary === st.library;
          const edit = st.sceneEdit === s.id;
          const moving = st.sceneMove === s.id;
          rows.push('<div class="mm-scene-row' + (on ? ' on' : '') + (moving ? ' moving' : '') + '" data-scene-id="' + esc(s.id) + '">'
            + (edit
              ? '<input class="ui-inp mm-scene-edit" data-scene-input="' + esc(s.id) + '" value="' + esc(s.name) + '">'
              : '<button class="mm-scene-open" type="button" data-scene-act="open" data-scene-id="' + esc(s.id) + '">'
                + '<span class="nm">' + esc(s.name) + '</span></button>')
            + '<span class="mm-scene-acts">'
            + '<button class="ui-linkbtn" type="button" data-scene-act="rename" data-scene-id="' + esc(s.id) + '" title="改名">' + ic('pencil', 11) + '</button>'
            + '<button class="ui-linkbtn" type="button" data-scene-act="move" data-scene-id="' + esc(s.id) + '" title="移到场景组">' + ic('folder', 11) + '</button>'
            + '<button class="ui-linkbtn" type="button" data-scene-act="del" data-scene-id="' + esc(s.id) + '" title="删除">' + ic('trash', 11) + '</button>'
            + '</span>'
            + (moving ? '<select class="ui-inp mm-scene-move" data-scene-move="' + esc(s.id) + '">'
              + '<option value="">未分组</option>'
              + (st.sceneGroups || []).map(x => '<option value="' + esc(x.name) + '"' + (x.name === (s.group || '') ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('')
              + '</select>' : '')
            + '</div>');
        }
      }
      const draft = st.sceneGroupDraft
        ? '<div class="mm-scene-group-edit"><input class="ui-inp" data-group-draft placeholder="新场景组名" aria-label="新场景组名"></div>'
        : '';
      host.innerHTML = head + draft + '<div class="mm-scene-list">' + rows.join('')
        + (rows.length ? '' : '<div class="mm-empty">还没有场景。点「＋ 场景」新建一个。</div>') + '</div>';
      host.onclick = e => {
        const b = e.target.closest('[data-scene-act]');
        if (!b) return;
        const act = b.dataset.sceneAct;
        const id = b.dataset.sceneId;
        const group = b.dataset.group;
        if (act === 'new') createScene(null, null, { announce: true, forceSave: true });
        else if (act === 'newGroup') { st.sceneGroupDraft = true; paintScenes(); const inp = host.querySelector('[data-group-draft]'); if (inp) window.focusQuiet && window.focusQuiet(inp); }
        else if (act === 'open') openScene(id);
        else if (act === 'rename') { st.sceneEdit = id; paintScenes(); const inp = host.querySelector('[data-scene-input]'); if (inp) { window.focusQuiet && window.focusQuiet(inp); inp.select(); } }
        else if (act === 'move') { st.sceneMove = st.sceneMove === id ? '' : id; paintScenes(); }
        else if (act === 'renameGroup') { st.sceneGroupEdit = group; paintScenes(); const inp = host.querySelector('[data-group-input]'); if (inp) { window.focusQuiet && window.focusQuiet(inp); inp.select(); } }
        else if (act === 'delGroup') { if (window.Confirm.arm(b, '删除组', { key: 'mg:' + group, note: '组里的场景会移到未分组，不会被删掉' })) return; deleteSceneGroup(group); }
        else if (act === 'del') { if (window.Confirm.arm(b, '删除', { key: 'ms:' + id, note: '只删除场景文件，白模库里的模型不受影响' })) return; deleteScene(id); }
        else if (act === 'discard') { if (window.Confirm.arm(b, '确认丢弃', { key: 'ms:unsaved', note: '这个场景还没保存，丢弃后无法找回' })) return; discardCurrentScene(); }
      };
      host.onchange = e => {
        const sel = e.target.closest('[data-scene-move]');
        if (!sel) return;
        const id = sel.dataset.sceneMove;
        st.sceneMove = '';
        moveSceneTo(id, sel.value);
      };
      host.onkeydown = e => {
        const gInp = e.target.closest('[data-group-input]');
        if (gInp) {
          if (e.key === 'Enter') { e.preventDefault(); st.sceneGroupEdit = ''; renameSceneGroup(gInp.dataset.groupInput, gInp.value); }
          else if (e.key === 'Escape') { e.preventDefault(); st.sceneGroupEdit = ''; paintScenes(); }
          return;
        }
        const sInp = e.target.closest('[data-scene-input]');
        if (sInp) {
          if (e.key === 'Enter') { e.preventDefault(); st.sceneEdit = ''; renameSceneInline(sInp.dataset.sceneInput, sInp.value); }
          else if (e.key === 'Escape') { e.preventDefault(); st.sceneEdit = ''; paintScenes(); }
          return;
        }
        const dInp = e.target.closest('[data-group-draft]');
        if (dInp) {
          if (e.key === 'Enter') { e.preventDefault(); st.sceneGroupDraft = false; createSceneGroup(dInp.value); }
          else if (e.key === 'Escape') { e.preventDefault(); st.sceneGroupDraft = false; paintScenes(); }
        }
      };
    }

    /* ---------------- 场景 / 库模型 ---------------- */
    function blankScene(name, group) {
      const doc = S.emptyScene(name || '未命名场景', group || '');
      doc.kind = 'scene';
      return doc;
    }

    async function applyRefs(doc, library) {
      if (!doc) return;
      const lib = library || st.library;
      let hasRef = false;
      S.walkNodes(doc.scene.nodes, n => { if (n.kind === 'ref') hasRef = true; });
      if (!hasRef) return;
      const r = await resolveRefs(doc.scene.nodes, async id => S.normalizeDoc(await Vault.readModel(lib, id)).doc);
      doc.scene.nodes = r.nodes;
      if (r.notes.length) note(r.notes.join('；'), 'err');
    }

    async function syncAssets() {
      if (!st.doc || !st.library) return;
      const want = new Map();
      S.walkNodes(st.doc.scene.nodes, n => {
        if (n.kind !== 'asset' || !n.file) return;
        const key = Loader.assetLookupKey(n);
        if (!want.has(key)) want.set(key, n.lib || st.library);
      });
      const todo = Array.from(want.keys()).filter(key => !st.assets.has(key) && !assetPending.has(key));
      for (const key of todo) {
        assetPending.add(key);
        try {
          const at = key.indexOf('::');
          const file = at >= 0 ? key.slice(at + 2) : key;
          st.assets.set(key, await Loader.load(file, { library: want.get(key) }));
          if (st.doc) { paintProps(); paintDock(); }
          if (view && st.doc) view.setDoc(st.doc, {});
        } catch (e) {
          note('摆件读不出来（' + key + '）：' + window.errText(e), 'err');
        } finally {
          assetPending.delete(key);
        }
      }
    }

    /* 切场景 / 新建之前先把上一个场景落盘。force=true 时连空场景也存（「＋ 场景」用）；
       其余入口只在有改动 / 有内容时存，空白临时场景不落盘。 */
    async function autoSaveCurrent(force) {
      if (!st.doc || !st.library) return true;
      if (!st.docLibrary) st.docLibrary = st.library;
      if (st.docLibrary !== st.library) return true;
      if (!force) {
        const dirty = S.digest(st.doc) !== st.savedDigest;
        const hasContent = S.countNodes(st.doc) > 0 || (st.doc.out || []).length > 0 || (st.doc.anim && (st.doc.anim.tracks || []).length);
        if (!((dirty || !st.savedId) && (hasContent || st.savedId))) return true;
      }
      if (!st.savedId) {
        const group = st.doc.group || '';
        const name = String(st.doc.name || '').trim();
        if (!name || (st.scenes || []).some(s => (s.group || '') === group && s.name === name)) {
          st.doc.name = uniqueSceneName(name || '未命名场景', group);
        }
      }
      /* 切场景前自动存：不截图（截图要等一帧，用户会以为「＋ 场景」没反应）。 */
      return await save(false, { quiet: true, noThumb: true });
    }

    /* 把工作区换成一个全新的空白场景（不碰上一个场景、不读盘）。 */
    function setBlankScene(name, group) {
      const g = Vault.cleanGroup(group || '');
      st.doc = blankScene(name || nextSceneName(g), g);
      st.savedId = '';
      st.savedGroup = st.doc.group;
      st.docLibrary = st.library;
      st.savedDigest = '';
      st.selectedId = '';
      st.selectedCam = '';
      st.selIds = [];
      st.sceneEdit = '';
      st.sceneMove = '';
      st.sceneGroupEdit = '';
      st.sceneGroupDraft = false;
      st.prevDoc = null;
      st.refImages = [];
      view.setDoc(st.doc, { refit: true, resetTime: true });
      view.setSelection('');
      paintAll();
      return st.doc.name;
    }

    async function createScene(name, group, opts = {}) {
      if (!await ensureLibrary()) return false;
      if (!opts.skipSave && !await autoSaveCurrent(!!opts.forceSave)) return false;
      if (st.savedId) st.lastSceneId = st.savedId;
      const g = Vault.cleanGroup(group != null ? group : (st.savedGroup || st.sceneGroup || ''));
      setBlankScene(name, g);
      if (opts.announce) note('已新建场景：' + st.doc.name, 'ok');
      return true;
    }

    async function openScene(id, opts = {}) {
      if (!st.library) return false;
      if (st.savedId === id && st.docLibrary === st.library) return true;
      if (!opts.skipSave && !await autoSaveCurrent()) return false;
      const fromId = st.savedId;
      if (!opts.skipSave && fromId && fromId !== id) st.lastSceneId = fromId;
      try {
        const raw = await Vault.readScene(st.library, id);
        const out = S.normalizeDoc(raw);
        out.doc.kind = 'scene';
        st.doc = out.doc;
        st.docLibrary = st.library;
        st.savedId = id;
        st.savedGroup = out.doc.group || '';
        st.sceneGroup = out.doc.group || '';
        st.savedDigest = S.digest(out.doc);
        st.selectedId = '';
        st.selectedCam = '';
        st.selIds = [];
        st.prevDoc = null;
        st.refImages = [];
        await applyRefs(st.doc);
        await syncAssets();
        view.setDoc(st.doc, { refit: true, resetTime: true });
        view.setSelection('');
        paintAll();
        const dropped = out.dropped ? (out.dropped.bad + out.dropped.extra + out.dropped.anim + out.dropped.cam + out.dropped.out) : 0;
        if (dropped) note('载入时有 ' + dropped + ' 个条目读不出来，已经跳过', 'err');
        return true;
      } catch (e) {
        note('打开场景失败：' + window.errText(e), 'err');
        return false;
      }
    }

    async function thumbB64() {
      try {
        const blob = await view.shot(320, 200, 'image/png');
        if (!blob) return '';
        return await new Promise(res => {
          const r = new FileReader();
          r.onload = () => res(String(r.result || ''));
          r.onerror = () => res('');
          r.readAsDataURL(blob);
        });
      } catch (e) { return ''; }
    }

    async function save(saveAs, opts = {}) {
      if (!st.doc || st.busy) return false;
      if (!st.library) { note('先在「白模库」里选一个库', 'err'); return false; }
      const quiet = !!opts.quiet;
      let name = st.doc.name;
      let group = st.doc.group;
      if (saveAs) {
        const v = await window.PromptForm.open({
          title: '场景另存为',
          sub: '场景组可以留空；空组就是未分组',
          okLabel: '保存',
          fields: [
            { key: 'name', label: '场景名', type: 'text', value: name, placeholder: '例：雨夜街道', required: true },
            { key: 'group', label: '场景组（可留空）', type: 'text', value: group, placeholder: '例：第一幕' },
          ],
        });
        if (!v) return false;
        name = Vault.cleanName(v.name);
        group = Vault.cleanGroup(v.group);
      }
      if (!name) { note('场景名不能是空的', 'err'); return false; }
      st.busy = 'save';
      if (!quiet) note('正在保存场景…');
      try {
        st.doc.name = name;
        st.doc.group = group;
        const thumb = opts.noThumb ? '' : await thumbB64();
        const r = await Vault.saveScene({ library: st.docLibrary || st.library, id: st.savedId || '', name, group, model: st.doc, thumb });
        st.savedId = r.id;
        st.savedGroup = group;
        st.sceneGroup = group;
        st.docLibrary = st.library;
        st.savedDigest = S.digest(st.doc);
        refreshPhead();
        await loadLibrary(st.library);
        paintScenes();
        if (!quiet) note('已保存场景：' + r.id, 'ok');
        return true;
      } catch (e) {
        note('保存失败：' + window.errText(e), 'err');
        return false;
      } finally {
        st.busy = '';
      }
    }

    async function commitSceneMeta(id, name, group, raw) {
      const r = await Vault.saveScene({ library: st.library, id, name, group, model: raw });
      if (st.savedId === id && st.docLibrary === st.library) {
        st.doc.name = name; st.doc.group = group; st.savedId = r.id; st.savedGroup = group; st.sceneGroup = group;
        st.savedDigest = S.digest(st.doc); paintAll();
      }
      await loadLibrary(st.library);
      return r;
    }

    /* 场景改名走行内输入（不再弹表单）；组名跟着原样保留。 */
    async function renameSceneInline(id, value) {
      const name = Vault.cleanName(value);
      if (!name) { note('场景名不能是空的', 'err'); paintScenes(); return; }
      try {
        const raw = await Vault.readScene(st.library, id);
        if (name === raw.name) { paintScenes(); return; }
        raw.name = name;
        raw.group = Vault.cleanGroup(raw.group || Vault.splitId(id).group);
        const r = await commitSceneMeta(id, name, raw.group, raw);
        note('已改为：' + r.id, 'ok');
      } catch (e) { note('改名失败：' + window.errText(e), 'err'); paintScenes(); }
    }

    async function moveSceneTo(id, group) {
      const g = Vault.cleanGroup(group);
      try {
        const raw = await Vault.readScene(st.library, id);
        const name = raw.name || Vault.splitId(id).name;
        if (g === (raw.group || '')) { paintScenes(); return; }
        raw.group = g;
        const r = await commitSceneMeta(id, name, g, raw);
        note('已移到：' + (g || '未分组') + ' · ' + r.id, 'ok');
      } catch (e) { note('移动失败：' + window.errText(e), 'err'); paintScenes(); }
    }

    /* 丢弃 / 删除当前场景后回到哪一份：优先上一个打开过的已保存场景，
       其次同组的第一份，最后任意一份。都没有才新建空白场景。 */
    function returnSceneId(group, excludeId) {
      const rows = (st.scenes || []).filter(s => s.id !== excludeId);
      if (!rows.length) return '';
      const last = rows.find(s => s.id === st.lastSceneId);
      if (last) return last.id;
      const same = rows.find(s => (s.group || '') === (group || ''));
      return (same || rows[0]).id;
    }

    async function discardCurrentScene() {
      if (!st.doc || st.savedId) return;
      if (!await ensureLibrary()) return;
      const group = st.doc.group || '';
      const target = returnSceneId(group, '');
      if (target && await openScene(target, { skipSave: true })) {
        note('已丢弃未保存的场景，已回到：' + target, 'ok');
        return;
      }
      const name = setBlankScene(null, group);
      note('已丢弃未保存的场景；没有其它场景，已新建空白场景：' + name, 'ok');
    }

    async function deleteScene(id) {
      const wasCurrent = st.savedId === id && st.docLibrary === st.library;
      const group = wasCurrent && st.doc ? (st.doc.group || '') : '';
      try {
        await Vault.removeScene(st.library, id);
        if (wasCurrent) { st.savedId = ''; st.savedDigest = ''; }
        await loadLibrary(st.library);
        if (wasCurrent) {
          const target = returnSceneId(group, id);
          if (target && await openScene(target, { skipSave: true })) note('已删除场景：' + id + '，已回到：' + target, 'ok');
          else {
            const name = setBlankScene(null, group);
            note('已删除场景：' + id + '；没有其它场景，已新建空白场景：' + name, 'ok');
          }
          return;
        }
        note('已删除场景：' + id, 'ok');
      } catch (e) { note('删除失败：' + window.errText(e), 'err'); }
    }

    async function newLibrary() {
      const v = await window.PromptForm.open({ title: '新建白模库', okLabel: '新建', fields: [{ key: 'name', label: '库名', type: 'text', value: '', required: true }] });
      if (!v) return;
      const name = Vault.cleanName(v.name);
      if (!name) { note('库名不能是空的', 'err'); return; }
      try {
        await Vault.saveLibrary({ name });
        await loadLibraries();
        await loadLibrary(name);
        note('已新建白模库：' + name, 'ok');
      } catch (e) { note('新建失败：' + window.errText(e), 'err'); }
    }

    async function renameLibrary(id) {
      const v = await window.PromptForm.open({ title: '白模库改名', okLabel: '改', fields: [{ key: 'name', label: '库名', type: 'text', value: id, required: true }] });
      if (!v) return;
      const name = Vault.cleanName(v.name);
      if (!name) { note('库名不能是空的', 'err'); return; }
      try {
        await Vault.saveLibrary({ id, name });
        st.library = name;
        window.LS.set('sk_model_library', name);
        await loadLibraries();
        note('白模库已改为：' + name, 'ok');
      } catch (e) { note('改名失败：' + window.errText(e), 'err'); }
    }

    async function deleteLibrary(id) {
      const ok = await window.Confirm.ask({
        title: '删除白模库「' + id + '」？',
        body: '库里的模型和场景会一起移进 .trash，列表里不再显示。',
        danger: true,
        okLabel: '删除',
      });
      if (!ok) return;
      const active = st.library === id;
      try {
        await Vault.removeLibrary(id);
        if (active) { st.library = ''; window.LS.set('sk_model_library', ''); }
        await loadLibraries();
        if (active) createScene();
        note('已删除白模库：' + id, 'ok');
      } catch (e) { note('删除失败：' + window.errText(e), 'err'); }
    }

    async function newSceneGroup() {
      if (!await ensureLibrary()) return;
      st.sceneGroupDraft = true;
      paintScenes();
      const inp = $('mmScenes') && $('mmScenes').querySelector('[data-group-draft]');
      if (inp) window.focusQuiet && window.focusQuiet(inp);
    }

    async function createSceneGroup(value) {
      const name = Vault.cleanGroup(value);
      if (!name) { note('场景组名不能是空的', 'err'); paintScenes(); return; }
      try {
        await Vault.createSceneGroup(st.library, name);
        st.sceneGroup = name;
        await loadLibrary(st.library);
        note('已新建场景组：' + name, 'ok');
      } catch (e) { note('新建失败：' + window.errText(e), 'err'); paintScenes(); }
    }

    async function renameSceneGroup(from, value) {
      const to = Vault.cleanGroup(value);
      if (!to || to === from) { paintScenes(); return; }
      try {
        await Vault.renameSceneGroup(st.library, from, to);
        const prefix = from + '/';
        if (st.savedId.startsWith(prefix)) {
          st.savedId = to + st.savedId.slice(from.length);
          st.savedGroup = to;
          if (st.doc) st.doc.group = to;
        }
        if (st.sceneGroup === from) st.sceneGroup = to;
        await loadLibrary(st.library);
        note('场景组已改为：' + to, 'ok');
      } catch (e) { note('改名失败：' + window.errText(e), 'err'); paintScenes(); }
    }

    async function deleteSceneGroup(from) {
      try {
        await Vault.removeSceneGroup(st.library, from);
        const prefix = from + '/';
        if (st.savedId.startsWith(prefix)) { st.savedId = st.savedId.slice(prefix.length); st.savedGroup = ''; if (st.doc) st.doc.group = ''; }
        if (st.sceneGroup === from) st.sceneGroup = '';
        await loadLibrary(st.library);
        note('已删场景组：' + from + '（场景已移到未分组）', 'ok');
      } catch (e) { note('删除失败：' + window.errText(e), 'err'); }
    }

    async function insertModel(id, libraryIn) {
      const library = libraryIn || st.library;
      if (!library) { note('先选白模库', 'err'); return; }
      try {
        const raw = S.normalizeDoc(await Vault.readModel(library, id)).doc;
        await applyRefs(raw, library);
        if (library !== st.library) {
          S.walkNodes(raw.scene.nodes, n => { if (n.kind === 'asset' && n.file) n.lib = library; });
        }
        const made = entityFromModel(raw, library === st.library ? id : library + ' :: ' + id, { includeCams: true });
        st.doc.scene.nodes.push(made.entity);
        st.doc.anim.tracks = (st.doc.anim.tracks || []).concat(made.tracks);
        addCamsToScene(made, false);
        if (made.duration > st.doc.anim.duration) st.doc.anim.duration = made.duration;
        st.selectedId = made.entity.id;
        st.selIds = [made.entity.id];
        st.selectedCam = '';
        view.setDoc(st.doc, {});
        view.setSelection(made.entity.id);
        refreshPhead();
        paintAll();
        note('已放入场景：' + (raw.name || id) + (library === st.library ? '' : '（来自 ' + library + '）'), 'ok');
      } catch (e) { note('放进场景失败：' + window.errText(e), 'err'); }
    }

    async function renameLibraryModel(id) {
      const raw = S.normalizeDoc(await Vault.readModel(st.library, id)).doc;
      const cur = Vault.splitId(id);
      const v = await window.PromptForm.open({ title: '模型改名', okLabel: '改', fields: [{ key: 'name', label: '模型名', type: 'text', value: raw.name || cur.name, required: true }] });
      if (!v) return;
      const name = Vault.cleanName(v.name);
      if (!name) return;
      try {
        await Vault.saveModel({ library: st.library, id: raw.group ? raw.group + '/' + raw.name : raw.name, name, group: raw.group || '', model: raw });
        await loadLibrary(st.library);
        note('模型已改为：' + name, 'ok');
      } catch (e) { note('改名失败：' + window.errText(e), 'err'); }
    }

    async function deleteLibraryModel(id) {
      const ok = await window.Confirm.ask({ title: '删除模型「' + id + '」？', body: '只删除白模库里的模板；场景里已经放进去的副本不受影响。', danger: true, okLabel: '删除' });
      if (!ok) return;
      try {
        await Vault.removeModel(st.library, id);
        await loadLibrary(st.library);
        note('已删除模型：' + id, 'ok');
      } catch (e) { note('删除失败：' + window.errText(e), 'err'); }
    }

    async function moveLibraryModel(id) {
      const cur = Vault.splitId(id);
      const v = await window.PromptForm.open({
        title: '移到模型组', sub: '留空 = 未分组；填新名字会顺手建组', okLabel: '移动',
        fields: [{ key: 'group', label: '模型组', type: 'text', value: cur.group, placeholder: '例：角色 / 家具' }],
      });
      if (!v) return;
      const group = Vault.cleanGroup(v.group);
      if (group === cur.group) { note('已经在这个组里', ''); return; }
      try {
        const raw = S.normalizeDoc(await Vault.readModel(st.library, id)).doc;
        const name = raw.name || cur.name;
        await Vault.saveModel({ library: st.library, id, name, group, model: raw });
        if (st.libGroup && st.libGroup !== group && st.libGroup !== '__none') st.libGroup = group;
        await loadLibrary(st.library);
        note('已移到：' + (group || '未分组'), 'ok');
      } catch (e) { note('移动失败：' + window.errText(e), 'err'); }
    }

    async function createModelGroupPrompt() {
      if (!st.library) return;
      const v = await window.PromptForm.open({
        title: '新建模型组', okLabel: '新建',
        fields: [{ key: 'name', label: '组名', type: 'text', value: '', placeholder: '例：角色', required: true }],
      });
      if (!v) return;
      const name = Vault.cleanGroup(v.name);
      if (!name) { note('组名不能是空的', 'err'); return; }
      try {
        await Vault.createModelGroup(st.library, name);
        st.libGroup = name;
        await loadLibrary(st.library);
        note('已新建模型组：' + name, 'ok');
      } catch (e) { note('新建失败：' + window.errText(e), 'err'); }
    }

    async function manageModelGroups() {
      if (!(st.groups || []).length) { note('还没有模型组', 'err'); return; }
      const pick = await window.Confirm.choose({
        title: '模型组管理', body: '选一个模型组',
        options: st.groups.map(g => ({ value: g.name, label: g.name, hint: g.count + ' 个模型' })),
      });
      if (!pick) return;
      const act = await window.Confirm.choose({
        title: '模型组「' + pick + '」',
        options: [
          { value: 'rename', label: '改名' },
          { value: 'delete', label: '删除（模型移到未分组）' },
        ],
      });
      if (!act) return;
      try {
        if (act === 'rename') {
          const v = await window.PromptForm.open({ title: '模型组改名', okLabel: '改', fields: [{ key: 'name', label: '新组名', type: 'text', value: pick, required: true }] });
          if (!v) return;
          const name = Vault.cleanGroup(v.name);
          if (!name || name === pick) return;
          await Vault.renameModelGroup(st.library, pick, name);
          if (st.libGroup === pick) st.libGroup = name;
        } else {
          const ok = await window.Confirm.ask({ title: '删除模型组「' + pick + '」？', body: '组里的模型会移到未分组，不会被删掉。', danger: true, okLabel: '删除组' });
          if (!ok) return;
          await Vault.removeModelGroup(st.library, pick);
          if (st.libGroup === pick) st.libGroup = '';
        }
        await loadLibrary(st.library);
        note('模型组已更新', 'ok');
      } catch (e) { note('模型组操作失败：' + window.errText(e), 'err'); }
    }

    function selectedEntities() {
      if (!st.doc) return [];
      const top = new Set(st.doc.scene.nodes.map(n => n.id));
      return (st.selIds || []).map(id => (top.has(id) ? S.findNode(st.doc.scene.nodes, id) : null)).filter(Boolean);
    }

    async function saveSelectionToLibrary() {
      const entities = selectedEntities();
      if (!entities.length) { note('先在场景里选中一个实体', 'err'); return; }
      if (!st.library) { note('先选白模库', 'err'); return; }
      const tracks = st.doc.anim.tracks || [];
      for (const entity of entities) {
        let name = entity.name || '实体';
        let id = '';
        let group = st.libGroup && st.libGroup !== '__none' ? st.libGroup : '';
        let overwrite = false;
        let saveLib = st.library;
        const fromAt = entity.fromModel ? entity.fromModel.indexOf(' :: ') : -1;
        const fromLib = fromAt >= 0 ? entity.fromModel.slice(0, fromAt) : '';
        const fromId = fromAt >= 0 ? entity.fromModel.slice(fromAt + 4) : (entity.fromModel || '');
        if (entities.length === 1 && fromId) {
          const act = await window.Confirm.choose({
            title: '存入白模库',
            body: '这个实体来自模型「' + (fromLib ? fromLib + ' / ' : '') + fromId + '」',
            options: [{ value: 'overwrite', label: '覆盖原模型' }, { value: 'new', label: '另存为新模型' }],
          });
          if (!act) return;
          overwrite = act === 'overwrite';
          if (overwrite) {
            const parts = Vault.splitId(fromId);
            saveLib = fromLib || st.library;
            id = fromId;
            group = parts.group;
            name = parts.name;
          }
        }
        if (!overwrite) {
          if (entities.length === 1) {
            const v = await window.PromptForm.open({
              title: '存入白模库', sub: '可以顺手归到一个模型组；留空 = 未分组', okLabel: '存入',
              fields: [
                { key: 'name', label: '模型名', type: 'text', value: name, required: true },
                { key: 'group', label: '模型组（可留空）', type: 'text', value: group, placeholder: '例：角色 / 家具' },
              ],
            });
            if (!v) return;
            name = Vault.cleanName(v.name);
            group = Vault.cleanGroup(v.group);
            if (!name) return;
          }
          const siblings = saveLib === st.library ? st.models : (st.aiModels.get(saveLib) || []);
          let base = name;
          let n = 2;
          while ((siblings || []).some(m => m.name === name && m.group === group)) { name = base + '-' + n; n += 1; }
        }
        const doc = modelFromEntity(entity, name, {
          library: saveLib,
          tracks,
          duration: st.doc.anim.duration,
          fps: st.doc.anim.fps,
          loop: st.doc.anim.loop !== false,
        });
        const thumb = await thumbB64();
        await Vault.saveModel({ library: saveLib, id, name, group, model: doc, thumb });
        if (!entity.fromModel && !overwrite) {
          entity.fromModel = (saveLib === st.library ? '' : saveLib + ' :: ') + (group ? group + '/' : '') + name;
        }
      }
      await loadLibrary(st.library);
      note('已存入白模库：' + entities.length + ' 个实体', 'ok');
      paintAll();
    }

    function addEntity(kind) {
      if (!st.doc) return;
      const node = kind === 'mannequin'
        ? { kind: 'mannequin', id: S.newId('m'), name: '小人', body: 'mannequin', pose: 'stand', at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], tone: 'hi' }
        : kind === 'group'
          ? { kind: 'group', id: S.newId('e'), name: '组', at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], children: [] }
          : { kind: 'prim', id: S.newId('n'), name: '立方体', shape: 'box', size: [1, 1, 1], at: [0, 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1], tone: 'hi' };
      st.doc.scene.nodes.push(node);
      st.selectedId = node.id;
      st.selIds = [node.id];
      st.selectedCam = '';
      view.setDoc(st.doc, {});
      view.setSelection(node.id);
      refreshPhead();
      paintAll();
    }

    /* ---------------- 右栏：AI ---------------- */
    const modelRowId = m => (m.group ? m.group + '/' : '') + m.name;

    /* AI 可调用的白模库范围：勾了哪几个库，清单就只列哪几个库的模型。
       多库时每条带 `库名 :: 模型id`，AI 原样回填 reuse.id。 */
    async function aiCatalogText() {
      const ids = (st.aiLibs || []).filter(id => (st.libraries || []).some(x => x.id === id));
      if (!ids.length) return '（这次没有可调用的白模库）';
      const rows = [];
      for (const id of ids) {
        let list = id === st.library ? st.models : st.aiModels.get(id);
        if (!list) {
          try { list = (await Vault.list(id)).models || []; }
          catch (e) { note('白模库读不出来（' + id + '）：' + window.errText(e), 'err'); continue; }
          st.aiModels.set(id, list);
        }
        for (const m of list) rows.push({
          id: modelRowId(m),
          library: id,
          nodes: 0,
          note: m.group ? '组：' + m.group : '',
        });
      }
      return AI.catalogText(rows);
    }

    function resolveReuseId(raw) {
      const text = String(raw == null ? '' : raw);
      const at = text.indexOf(' :: ');
      if (at >= 0) {
        const library = text.slice(0, at).trim();
        const id = text.slice(at + 4).trim();
        const known = (st.libraries || []).some(x => x.id === library);
        return { library: known ? library : st.library, id };
      }
      /* AI 偶尔会只回模型 id：先在当前库找，再在勾选的库里找。 */
      if ((st.models || []).some(m => modelRowId(m) === text)) return { library: st.library, id: text };
      for (const lib of (st.aiLibs || [])) {
        if (lib === st.library) continue;
        const list = st.aiModels.get(lib) || [];
        if (list.some(m => modelRowId(m) === text)) return { library: lib, id: text };
      }
      return { library: st.library, id: text };
    }

    /* 库里有动画的摆件：只从这次会话里已经解析过的文件来。 */
    function aiAnimations() {
      return Array.from(st.assets, ([file, entry]) => ({ file, clips: clipNamesOf(entry) }))
        .filter(it => it.file.indexOf('::') < 0 && it.clips.length);
    }

    function entityNameFromPrompt(prompt) {
      const text = String(prompt || '').replace(/\s+/g, ' ').trim();
      const cut = text.split(/[，。,.!?;；：:]/)[0].trim();
      return (cut || text || '新实体').slice(0, 24);
    }

    /* 把模型带进来的机位并进场景：名字不重复、相机轨道一起并；可顺手切到第一台新机位。 */
    function addCamsToScene(made, activate) {
      const cams = made && made.cams ? made.cams : [];
      if (!cams.length) return;
      const names = new Set((st.doc.scene.cams || []).map(c => c.name));
      for (const cam of cams) {
        const base = cam.name || '机位';
        let name = base;
        let n = 2;
        while (names.has(name)) { name = base + ' ' + n; n += 1; }
        cam.name = name;
        names.add(name);
      }
      st.doc.scene.cams = (st.doc.scene.cams || []).concat(cams);
      st.doc.anim.tracks = (st.doc.anim.tracks || []).concat(made.camTracks || []);
      if (activate && cams[0]) st.doc.scene.active = cams[0].id;
    }

    function appendEntity(doc, anim, name) {
      /* AI 生成的是场景里的新实体，不是从白模库复用的那一份：不写 fromModel。 */
      const made = entityFromModel(doc, '', { includeCams: true });
      if (name) made.entity.name = String(name).replace(/\s+/g, ' ').trim().slice(0, 24);
      st.doc.scene.nodes.push(made.entity);
      st.doc.anim.tracks = (st.doc.anim.tracks || []).concat(made.tracks);
      addCamsToScene(made, true);
      if (made.duration > st.doc.anim.duration) st.doc.anim.duration = made.duration;
      if (anim) {
        if (Number(anim.duration) > 0) st.doc.anim.duration = Math.max(st.doc.anim.duration, Number(anim.duration));
        if (Number(anim.fps) > 0) st.doc.anim.fps = Math.round(Number(anim.fps));
        if (anim.loop != null) st.doc.anim.loop = anim.loop !== false;
      }
      st.selectedId = made.entity.id;
      st.selIds = [made.entity.id];
      st.selectedCam = '';
      return made.entity;
    }

    async function generate() {
      const prompt = ($('mmPrompt') && $('mmPrompt').value || '').trim();
      if (!prompt) { note('先写一句要建什么', 'err'); return; }
      if (!st.doc && !await createScene()) { note('先在「白模库」里选一个库', 'err'); return; }
      if (!st.doc || !st.library) { note('先在「白模库」里选一个库', 'err'); return; }
      if (st.busy) return;
      const selected = st.selectedId ? S.findNode(st.doc.scene.nodes, st.selectedId) : null;
      st.busy = 'ai';
      st.aiText = '';
      st.aiSay = '';
      st.aiRaw = '';
      st.aiCount = 0;
      note(selected ? '正在按你说的修改选中实体…' : '正在生成实体…');
      paintSide();
      const ctl = new AbortController();
      st.aiCtl = ctl;
      const base = S.cloneDoc(st.doc);
      const scope = selected ? Array.from(subtreeIds(selected)) : null;
      try {
        const catalog = await aiCatalogText();
        let images = [];
        if (st.refImages.length && window.TextAI) {
          try {
            const REG = await window.Api.registry();
            const prep = await window.TextAI.polishImages(REG, st.refImages.map(x => ({ label: x.label, src: x.src })));
            images = prep.images || [];
            if (prep.note) note(prep.note, '');
          } catch (e) { note('参考图没能交给 AI：' + window.errText(e), 'err'); }
        }
        const r = await AI.run({
          prompt,
          mode: 'auto',
          doc: base,
          selectedId: st.selectedId,
          scope,
          images,
          catalog,
          animations: aiAnimations(),
          aspect: view ? view.aspect : ((st.doc && st.doc.scene.view.aspect) || '16:9'),
          signal: ctl.signal,
          onNodes: () => { /* 场景模式不边收边替换，避免误删其他实体 */ },
          onSay: t => { st.aiSay = t; paintStreamSoon(); },
          onText: (text, count) => { st.aiRaw = text; st.aiCount = count; paintStreamSoon(); },
        });
        if (r.reuse && r.reuse.mode === 'as-is') {
          const reuse = resolveReuseId(r.reuse.id);
          await insertModel(reuse.id, reuse.library);
          note('沿用了白模库模型「' + reuse.library + ' :: ' + reuse.id + '」' + (r.reuse.why ? '：' + r.reuse.why : ''), 'ok');
          return;
        }
        if (!r.doc) { note(r.why || '这一轮没有可用的模型', 'err'); return; }
        const edited = !!(r.ops && r.ops.length && r.fallback !== 'model');
        st.prevDoc = base;
        if (edited) {
          st.doc = r.doc;
          st.doc.kind = 'scene';
        } else {
          /* 没要求改选中实体：AI 交回来的是一整件新实体，只追加，不替换场景。 */
          const aiName = r.name && !/^未命名/.test(r.name) ? r.name : entityNameFromPrompt(prompt);
          appendEntity(r.doc, r.anim, aiName);
        }
        st.savedDigest = '';
        await syncAssets();
        if (view) view.setDoc(st.doc, { refit: false });
        paintAll();
        const parts = [];
        if (edited) parts.push('应用 ' + (r.applied || 0) + ' 条修改');
        else parts.push('新增一个实体');
        if (r.anim && (r.anim.duration > 0 || r.anim.fps > 0 || r.anim.loop != null)) {
          parts.push('时间轴 ' + st.doc.anim.duration + ' 秒 · ' + st.doc.anim.fps + ' fps' + (st.doc.anim.loop === false ? ' · 不循环' : ''));
        }
        if (r.skipped) parts.push('跳过 ' + r.skipped + ' 条坏 op');
        const dropped = r.dropped ? (r.dropped.bad + r.dropped.extra + r.dropped.anim + r.dropped.cam + r.dropped.out) : 0;
        if (dropped) parts.push('丢了 ' + dropped + ' 个条目');
        st.aiText = r.say || '';
        note(parts.join(' · '), (r.skipped || dropped) ? 'err' : 'ok');
        archivePrompt(prompt);
      } catch (e) {
        if (view && st.doc) view.setDoc(st.doc, {});
        const msg = e && e.name === 'AbortError' ? '已停止' : window.errText(e);
        note((e && e.name === 'AbortError' ? '' : '生成失败：') + msg, 'err');
      } finally {
        st.busy = '';
        st.aiCtl = null;
        stopStreamSoon();
        paintSide();
      }
    }

    function undoAi() {
      if (!st.prevDoc) { note('没有可撤销的 AI 修改', 'err'); return; }
      st.doc = st.prevDoc;
      st.prevDoc = null;
      st.selectedId = '';
      st.selectedCam = '';
      st.selIds = [];
      st.savedDigest = '';
      view.setDoc(st.doc, { refit: true });
      paintAll();
      note('已撤销上一次 AI 修改', 'ok');
    }

    /* 建模提示词也进提示词归档（与资产库里看到的提示词是同一份） */
    function archivePrompt(prompt) {
      try {
        if (!window.PromptLog || !window.Api) return;
        window.Api.registry().then(REG => {
          window.PromptLog.save(REG, { prompt, type: '3D建模', provider: '本机', model: '3D白膜' });
        }).catch(() => {});
      } catch (e) { /* 归档失败不该影响建模 */ }
    }

    /* ---------------- 右栏：场景 ---------------- */
    function nodeLabel(n) {
      if (n.name) return n.name;
      if (n.kind === 'mannequin') return '小人';
      if (n.kind === 'crowd') return '群众 ' + n.rows + '×' + n.cols;
      if (n.kind === 'prim') return n.shape || '零件';
      if (n.kind === 'asset') return '摆件';
      if (n.kind === 'ref') return '引用';
      return '组';
    }

    /* 树里不再贴「实体 / 形状 / 人台」这类徽标：进场景的都是实体，
       层级只靠缩进与引导线表达；类型只留在图标上。 */
    const kindIcon = n => (n.kind === 'mannequin' || n.kind === 'crowd') ? 'users'
      : n.kind === 'prim' ? 'box' : n.kind === 'asset' ? 'image' : 'list';

    function selectCam(id) {
      const cam = st.doc && S.camOf(st.doc, id);
      if (!cam) return;
      st.selectedCam = id;
      st.selectedId = '';
      st.selIds = [];
      view.setActiveCam(id);
      view.setSelection({ kind: 'cam', id });
      paintTools();
      if (st.sideTab !== 'cam') { st.sideTab = 'cam'; window.LS.set('sk_model_side', 'cam'); paintSide(); }
      else { paintCams(); paintCam(); }
    }

    function selectNode(id, additive) {
      st.selectedCam = '';
      if (additive) {
        const set = new Set(st.selIds);
        if (set.has(id)) set.delete(id); else set.add(id);
        st.selIds = Array.from(set);
        st.selectedId = set.has(id) ? id : (st.selIds[st.selIds.length - 1] || '');
      } else {
        st.selectedId = id || '';
        st.selIds = id ? [id] : [];
      }
      view.setSelection(st.selectedId);
      paintTree();
      paintProps();
      paintTools();
    }

    function paintTreeActs() {
      const host = $('mmTreeActs');
      if (!host || !st.doc) return;
      const n = st.selIds.length;
      const onlyNode = n === 1 ? S.findNode(st.doc.scene.nodes, st.selIds[0]) : null;
      const iconAct = (act, icon, title, disabled, cls) => '<button class="ghost mini icon' + (cls ? ' ' + cls : '') + '" type="button" data-tree-act="' + act + '" title="' + title + '"' + (disabled ? ' disabled' : '') + '>' + ic(icon, 12) + '</button>';
      host.innerHTML = '<div class="mm-tree-create">'
        + '<button class="pri mini" type="button" data-tree-act="new">' + ic('plus', 12) + ' 实体</button>'
        + '<button class="ghost mini" type="button" data-tree-act="fromLib">' + ic('box', 12) + ' 从库添加</button>'
        + iconAct('import3d', 'upload', '导入 3D 文件')
        + '</div>'
        + (n ? '<div class="mm-tree-edit">'
          + iconAct('toLib', 'download', '存入白模库')
          + iconAct('group', 'users', '编组')
          + iconAct('ungroup', 'box', '解组', !(onlyNode && onlyNode.kind === 'group'))
          + iconAct('dup', 'copy', '复制', !onlyNode)
          + iconAct('del', 'trash', '删除', false, 'danger')
          + '</div>' : '');
      host.onclick = async e => {
        const b = e.target.closest('[data-tree-act]');
        if (!b) return;
        const act = b.dataset.treeAct;
        if (act === 'new') newEntityMenu();
        else if (act === 'fromLib') chooseFromLibrary();
        else if (act === 'toLib') saveSelectionToLibrary();
        else if (act === 'import3d') { const f = $('mmFile3d'); if (f) f.click(); }
        else if (act === 'group') groupSelection();
        else if (act === 'ungroup') ungroupSelection();
        else if (act === 'dup') duplicateSelection();
        else if (act === 'del') deleteSelection();
      };
    }

    async function chooseFromLibrary() {
      if (!st.library) { note('先选白模库', 'err'); return; }
      if (!(st.models || []).length) { note('这个库还没有模型', 'err'); return; }
      const pick = await window.Confirm.choose({
        title: '从白模库添加',
        body: '选一个模型放进当前场景',
        options: (st.models || []).map(m => ({ value: m.id, label: m.name, hint: m.group || '' })),
      });
      if (pick) await insertModel(pick);
    }

    async function newEntityMenu() {
      const kind = await window.Confirm.choose({
        title: '新建实体',
        options: [
          { value: 'mannequin', label: '小人' },
          { value: 'prim', label: '立方体' },
          { value: 'group', label: '空组' },
          { value: 'import3d', label: '导入 3D 文件' },
        ],
      });
      if (!kind) return;
      if (kind === 'import3d') { const f = $('mmFile3d'); if (f) f.click(); return; }
      addEntity(kind);
    }

    function paintTree() {
      const host = $('mmTree');
      if (!host || !st.doc) return;
      paintTreeActs();
      const rows = [];
      const selected = new Set(st.selIds.length ? st.selIds : (st.selectedId ? [st.selectedId] : []));
      const stack = [{ list: st.doc.scene.nodes, depth: 0, i: 0 }];
      while (stack.length) {
        const f = stack[stack.length - 1];
        if (f.i >= f.list.length) { stack.pop(); continue; }
        const n = f.list[f.i++];
        const hidden = n.visible === false;
        const locked = !!n.locked;
        const renaming = st.renameId === n.id;
        const isEntity = f.depth === 0;
        const rowTitle = nodeLabel(n) + (n.fromModel ? '（来自白模库：' + n.fromModel + '）' : '');
        rows.push('<div class="mm-tree-row' + (isEntity ? ' is-entity' : ' is-part') + (selected.has(n.id) ? ' on' : '')
          + (hidden ? ' off' : '') + (locked ? ' lk' : '')
          + '" data-id="' + esc(n.id) + '" data-drop="' + (n.kind === 'group' ? '1' : '') + '" draggable="true" role="treeitem" tabindex="0" title="' + esc(rowTitle) + '" style="--depth:' + f.depth + '">'
          + (n.color ? '<i class="mm-tree-color" style="background:' + esc(n.color) + '" title="颜色 ' + esc(n.color) + '"></i>' : '')
          + '<span class="ic">' + ic(kindIcon(n), 12) + '</span>'
          + (renaming
            ? '<input class="ui-inp mm-tree-rename" data-rename-input="' + esc(n.id) + '" value="' + esc(n.name || '') + '">'
            : '<span class="nm" title="' + esc(nodeLabel(n)) + '">' + esc(nodeLabel(n)) + '</span>')
          + (n.kind === 'asset' && n.clip ? '<span class="mm-tree-anim" title="带动画：' + esc(n.clip) + '">' + ic('speaker', 11) + '</span>' : '')
          + '<span class="mm-tree-ops">'
          + '<span class="mm-tree-acts">'
          + '<button class="mm-tree-mini" type="button" data-tree-act="rename" data-id="' + esc(n.id) + '" title="改名">' + ic('pencil', 11) + '</button>'
          + '<button class="mm-tree-mini" type="button" data-tree-act="dup" data-id="' + esc(n.id) + '" title="复制">' + ic('copy', 11) + '</button>'
          + '<button class="mm-tree-mini" type="button" data-tree-act="del" data-id="' + esc(n.id) + '" title="删除">' + ic('trash', 11) + '</button>'
          + '</span>'
          + '<button class="mm-tree-mini' + (hidden ? ' on' : '') + '" type="button" data-tov="' + esc(n.id)
          + '" title="' + (hidden ? '显示' : '隐藏') + '" aria-pressed="' + (hidden ? 'true' : 'false') + '">'
          + ic(hidden ? 'eyeOff' : 'eye', 12) + '</button>'
          + '<button class="mm-tree-mini' + (locked ? ' on' : '') + '" type="button" data-lock="' + esc(n.id)
          + '" title="' + (locked ? '解锁' : '锁定') + '" aria-pressed="' + (locked ? 'true' : 'false') + '">'
          + ic('lock', 12) + '</button></span></div>');
        if (n.children && n.children.length) stack.push({ list: n.children, depth: f.depth + 1, i: 0 });
      }
      host.innerHTML = rows.join('') || '<div class="mm-empty">这个场景还没有实体。点「实体」新建，或从白模库添加。</div>';
      host.onclick = e => {
        const tv = e.target.closest('[data-tov]');
        if (tv) { toggleVisible(tv.dataset.tov); return; }
        const lk = e.target.closest('[data-lock]');
        if (lk) { toggleLocked(lk.dataset.lock); return; }
        const act = e.target.closest('[data-tree-act]');
        if (act) {
          const id = act.dataset.id;
          if (act.dataset.treeAct === 'rename') { st.renameId = id; paintTree(); const input = host.querySelector('[data-rename-input]'); if (input) { window.focusQuiet && window.focusQuiet(input); input.select(); } return; }
          if (act.dataset.treeAct === 'dup') { st.selIds = [id]; st.selectedId = id; duplicateSelection(); return; }
          if (act.dataset.treeAct === 'del') { st.selIds = [id]; st.selectedId = id; deleteSelection(); return; }
        }
        const b = e.target.closest('[data-id]');
        if (!b || e.target.closest('[data-rename-input]')) return;
        selectNode(b.dataset.id, e.metaKey || e.ctrlKey || e.shiftKey);
      };
      host.onkeydown = e => {
        if (e.key === 'Enter' || e.key === ' ') {
          const input = e.target.closest('[data-rename-input]');
          if (input) { e.preventDefault(); commitTreeRename(input.dataset.renameInput, input.value); return; }
          const b = e.target.closest('[data-id]');
          if (!b || e.target.closest('[data-tov],[data-lock]')) return;
          e.preventDefault();
          selectNode(b.dataset.id, e.metaKey || e.ctrlKey || e.shiftKey);
        } else if (e.key === 'Escape') {
          const input = e.target.closest('[data-rename-input]');
          if (input) { e.preventDefault(); st.renameId = ''; paintTree(); }
        }
      };
      host.onchange = e => {
        const input = e.target.closest('[data-rename-input]');
        if (input) commitTreeRename(input.dataset.renameInput, input.value);
      };
      host.ondragstart = e => {
        const row = e.target.closest('[data-id]');
        if (!row) return;
        st.dragId = row.dataset.id;
        try { e.dataTransfer.setData('text/plain', st.dragId); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* 拖拽数据拿不到也不影响页面内拖动 */ }
        row.classList.add('dragging');
      };
      host.ondragend = () => {
        st.dragId = '';
        host.classList.remove('drag-root');
        for (const el of host.querySelectorAll('.drag-over')) el.classList.remove('drag-over');
      };
      host.ondragover = e => {
        if (!st.dragId) return;
        const target = e.target.closest('[data-drop="1"]');
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 拖拽数据拿不到不影响页面内拖动 */ }
        for (const el of host.querySelectorAll('.drag-over')) el.classList.remove('drag-over');
        if (target) {
          host.classList.remove('drag-root');
          const id = target.dataset.id;
          if (id !== st.dragId) target.classList.add('drag-over');
        } else {
          host.classList.add('drag-root');
        }
      };
      host.ondragleave = e => {
        const target = e.target.closest('[data-drop="1"]');
        if (target) target.classList.remove('drag-over');
        if (!host.contains(e.relatedTarget)) host.classList.remove('drag-root');
      };
      host.ondrop = e => {
        if (!st.dragId) return;
        const target = e.target.closest('[data-drop="1"]');
        e.preventDefault();
        host.classList.remove('drag-root');
        for (const el of host.querySelectorAll('.drag-over')) el.classList.remove('drag-over');
        if (target && target.dataset.id === st.dragId) return;
        moveSceneNode(st.dragId, target ? target.dataset.id : null);
        st.dragId = '';
      };
    }

    function commitTreeRename(id, value) {
      const node = S.findNode(st.doc.scene.nodes, id);
      if (!node) return;
      node.name = String(value || '').trim();
      st.renameId = '';
      refreshPhead();
      view.setDoc(st.doc, {});
      paintTree();
      paintProps();
    }

    function moveSceneNode(id, parentId) {
      if (id === parentId) return;
      const r = S.applyDocOps(st.doc, [{ op: 'move', id, parent: parentId, index: 999999 }]);
      if (r.skipped) { note('移不过去：' + (r.errors[0] && r.errors[0].why || '目标不合法'), 'err'); return; }
      st.doc = r.doc;
      view.setDoc(st.doc, {});
      refreshPhead();
      paintTree();
      paintProps();
      note('已移动实体', 'ok');
    }

    function groupSelection() {
      if (!st.selIds.length) return;
      const r = S.applyDocOps(st.doc, [{ op: 'group', ids: st.selIds, name: '组' }]);
      if (r.skipped) { note('编组失败：' + (r.errors[0] && r.errors[0].why || '这些节点不在同一层'), 'err'); return; }
      st.doc = r.doc;
      st.selectedId = '';
      st.selIds = [];
      view.setDoc(st.doc, {});
      refreshPhead();
      paintTree();
      paintProps();
      note('已编组', 'ok');
    }

    function ungroupSelection() {
      if (st.selIds.length !== 1) return;
      const r = S.applyDocOps(st.doc, [{ op: 'ungroup', id: st.selIds[0] }]);
      if (r.skipped) { note('解组失败：' + (r.errors[0] && r.errors[0].why || '只能解组组节点'), 'err'); return; }
      st.doc = r.doc;
      st.selectedId = '';
      st.selIds = [];
      view.setDoc(st.doc, {});
      refreshPhead();
      paintTree();
      paintProps();
      note('已解组', 'ok');
    }

    function reidTree(n) {
      const copy = S.cloneDoc(n);
      const walk = list => {
        for (const x of list || []) {
          x.id = S.newId(x.kind === 'mannequin' ? 'm' : x.kind === 'crowd' ? 'c' : 'n');
          if (x.children) walk(x.children);
        }
      };
      copy.id = S.newId(copy.kind === 'mannequin' ? 'm' : copy.kind === 'crowd' ? 'c' : 'n');
      if (copy.children) walk(copy.children);
      return copy;
    }

    function duplicateSelection() {
      if (st.selIds.length !== 1) return;
      const hit = S.findEntry(st.doc.scene.nodes, st.selIds[0]);
      if (!hit) return;
      const copy = reidTree(hit.node);
      copy.at = [copy.at[0] + 0.4, copy.at[1], copy.at[2] + 0.4];
      const r = S.applyDocOps(st.doc, [{ op: 'add', parent: hit.parent ? hit.parent.id : null, node: copy }]);
      if (r.skipped) { note('复制失败：' + (r.errors[0] && r.errors[0].why || ''), 'err'); return; }
      st.doc = r.doc;
      st.selectedId = copy.id;
      st.selIds = [copy.id];
      view.setDoc(st.doc, {});
      refreshPhead();
      paintTree();
      paintProps();
      note('已复制', 'ok');
    }

    async function deleteSelection() {
      if (!st.selIds.length) return;
      const ids = st.selIds.slice();
      const ok = await window.Confirm.ask({
        title: ids.length > 1 ? '删除这 ' + ids.length + ' 个实体？' : '删除这个实体？',
        body: '只从当前模型里删掉；已经存过的白膜文件和出图不受影响。',
        danger: true,
        okLabel: '删除',
      });
      if (!ok) return;
      for (const id of ids) S.removeNode(st.doc.scene.nodes, id);
      st.doc.anim.tracks = st.doc.anim.tracks.filter(t => t.of && t.of.kind === 'node' && S.findNode(st.doc.scene.nodes, t.of.id));
      st.selectedId = '';
      st.selIds = [];
      view.setDoc(st.doc, {});
      refreshPhead();
      paintTree();
      paintProps();
      note('已删除 ' + ids.length + ' 个实体', 'ok');
    }

    /* 机位列表：机位不在实体树里，单独一列。改名 / 删除只在这里做；
       右栏「机位」只负责切换与改值。 */
    function paintCams() {
      const host = $('mmCams');
      if (!host || !st.doc) return;
      const rows = st.doc.scene.cams.map((c, i) => {
        const active = c.id === st.doc.scene.active;
        const renaming = st.renameId === c.id;
        return '<div class="mm-cam-row' + (active ? ' on' : '') + '" data-cam-id="' + esc(c.id) + '">'
          + '<button class="mm-cam-pick" type="button" data-cam-act="use" data-cam-id="' + esc(c.id) + '" title="切到这个机位">' + ic('video', 12) + '</button>'
          + (renaming
            ? '<input class="ui-inp mm-cam-rename" data-cam-rename="' + esc(c.id) + '" value="' + esc(c.name) + '">'
            : '<button class="mm-cam-name" type="button" data-cam-act="use" data-cam-id="' + esc(c.id) + '">' + esc(c.name) + '</button>')
          + '<span class="mini">' + (active ? '在用' : '') + '</span>'
          + '<button class="mm-tree-mini" type="button" data-cam-act="rename" data-cam-id="' + esc(c.id) + '" title="改名">' + ic('pencil', 11) + '</button>'
          + '<button class="mm-tree-mini" type="button" data-cam-act="del" data-cam-id="' + esc(c.id) + '" title="删除">' + ic('trash', 11) + '</button>'
          + '</div>';
      }).join('');
      host.innerHTML = '<div class="mm-cams-head"><span>机位 ' + st.doc.scene.cams.length + '</span>'
        + '<button class="ghost mini" type="button" data-cam-act="add">' + ic('plus', 12) + ' 机位</button></div>'
        + (rows || '<div class="mm-empty">还没有机位</div>');
      host.onclick = e => {
        const b = e.target.closest('[data-cam-act]');
        if (!b) return;
        const id = b.dataset.camId;
        if (b.dataset.camAct === 'use') { selectCam(id); return; }
        if (b.dataset.camAct === 'rename') { st.renameId = id; paintCams(); const input = host.querySelector('[data-cam-rename]'); if (input) { window.focusQuiet && window.focusQuiet(input); input.select(); } return; }
        if (b.dataset.camAct === 'del') { deleteCam(id); return; }
        if (b.dataset.camAct === 'add') { addCam(); return; }
      };
      host.onkeydown = e => {
        const input = e.target.closest('[data-cam-rename]');
        if (!input) return;
        if (e.key === 'Enter') { e.preventDefault(); commitCamRename(input.dataset.camRename, input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); st.renameId = ''; paintCams(); }
      };
      host.onchange = e => {
        const input = e.target.closest('[data-cam-rename]');
        if (input) commitCamRename(input.dataset.camRename, input.value);
      };
    }

    function commitCamRename(id, value) {
      const cam = S.camOf(st.doc, id);
      if (cam) cam.name = String(value || '').trim() || cam.name;
      st.renameId = '';
      refreshPhead();
      paintCams();
      paintCam();
    }

    async function deleteCam(id) {
      if (st.doc.scene.cams.length <= 1) { note('至少要留一个机位', 'err'); return; }
      const cam = S.camOf(st.doc, id);
      if (!cam) return;
      const ok = await window.Confirm.ask({ title: '删除机位「' + cam.name + '」？', body: '机位上的关键帧轨道会一起删掉。', danger: true, okLabel: '删除' });
      if (!ok) return;
      st.doc.scene.cams = st.doc.scene.cams.filter(c => c.id !== id);
      st.doc.anim.tracks = st.doc.anim.tracks.filter(t => !(t.of && t.of.kind === 'cam' && t.of.id === id));
      if (st.selectedCam === id) st.selectedCam = '';
      if (st.doc.scene.active === id) st.doc.scene.active = st.doc.scene.cams[0].id;
      view.setDoc(st.doc, {});
      refreshPhead();
      paintAll();
      note('已删除机位「' + cam.name + '」', 'ok');
    }

    function addCam() {
      const src = S.camOf(st.doc, st.doc.scene.active) || st.doc.scene.cams[0];
      const cam = {
        id: S.newId('cam'), name: '机位 ' + (st.doc.scene.cams.length + 1),
        pos: src.pos.slice(), target: src.target.slice(), fov: src.fov, follow: '',
      };
      st.doc.scene.cams.push(cam);
      st.doc.scene.active = cam.id;
      st.selectedCam = cam.id;
      view.setDoc(st.doc, {});
      refreshPhead();
      paintAll();
      note('已加机位「' + cam.name + '」', 'ok');
    }

    /* 任意实体都能隐藏 / 锁定。
       隐藏只影响渲染（树里还在、面板里还能改回来）；锁定只影响交互
       （视口点不中、不挂变换手柄、数值框只读），不改变它在场景里的样子。 */
    function walkSubtree(node, fn) {
      const stack = [node];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        fn(n);
        if (Array.isArray(n.children)) stack.push(...n.children);
      }
    }

    function toggleVisible(id) {
      const n = S.findNode(st.doc.scene.nodes, id);
      if (!n) return;
      const show = n.visible === false;
      walkSubtree(n, x => { x.visible = show; });
      if (view) view.setDoc(st.doc, {});
      paintTree();
      paintProps();
      note((show ? '已显示「' : '已隐藏「') + nodeLabel(n) + '」', 'ok');
    }

    function toggleLocked(id) {
      const n = S.findNode(st.doc.scene.nodes, id);
      if (!n) return;
      const lock = !n.locked;
      walkSubtree(n, x => { x.locked = lock; });
      if (view) view.setSelection(st.selectedId);      // 锁上就当场摘手柄
      paintTree();
      paintProps();
      note((lock ? '已锁定「' : '已解锁「') + nodeLabel(n) + '」', 'ok');
    }

    function numInput(key, value, step, ro) {
      return '<input class="ui-inp" type="number" step="' + (step || '0.01') + '" data-prop="' + key + '" value="' + (Number(value) || 0) + '"' + (ro ? ' disabled' : '') + '>';
    }

    function paintProps() {
      const host = $('mmProps');
      if (!host) return;
      if (st.selIds.length > 1) {
        host.innerHTML = '<div class="mm-empty">已选 ' + st.selIds.length + ' 个实体：可以编组、复制或删除；改数值请只选一个。</div>';
        return;
      }
      const node = st.doc && st.selectedId ? S.findNode(st.doc.scene.nodes, st.selectedId) : null;
      if (!node) {
        host.innerHTML = '<div class="mm-empty">在「场景 → 实体」里点一个实体，这里改它的数值。</div>';
        return;
      }
      const bodyOpts = BODY_PRESETS.map(b => '<option value="' + b.bodyType + '"' + ((node.body || '') === b.bodyType ? ' selected' : '') + '>' + esc(b.label) + '</option>').join('');
      const poseOpts = POSE_PRESETS.map(p => '<option value="' + p.id + '"' + ((node.pose || '') === p.id ? ' selected' : '') + '>' + esc(p.label) + '</option>').join('');
      const toneOpts = ['hi', 'mid', 'lo'].map(t => '<option value="' + t + '"' + ((node.tone || 'hi') === t ? ' selected' : '') + '>'
        + ({ hi: '亮（主体）', mid: '中（次要）', lo: '暗（点缀）' })[t] + '</option>').join('');
      let html = '<div class="mm-row"><label>显示</label>'
        + '<input type="checkbox" data-prop="visible"' + (node.visible === false ? '' : ' checked') + '>'
        + '<span class="mm-empty" style="flex:1">关掉 = 视口里看不见，树里还在</span></div>'
        + '<div class="mm-row"><label>锁定</label>'
        + '<input type="checkbox" data-prop="locked"' + (node.locked ? ' checked' : '') + '>'
        + '<span class="mm-empty" style="flex:1">锁上 = 点不中、不挂手柄、数值只读</span></div>';
      html += '<div class="mm-field"><label>名字</label><input class="ui-inp" data-prop="name" value="' + esc(node.name || '') + '"></div>';
      html += '<div class="mm-row"><label>颜色</label>'
        + '<input class="mm-color" type="color" data-prop="color" value="' + esc(node.color || CLAY_HEX) + '" aria-label="节点颜色">'
        + '<button class="ghost mini" type="button" data-act="colorClear"' + (node.color ? '' : ' disabled') + '>白模</button></div>';
      const ro = !!node.locked;
      html += '<div class="mm-field"><label>位置（x / y / z，米）</label><div class="mm-num3">'
        + numInput('at.0', node.at[0], null, ro) + numInput('at.1', node.at[1], null, ro) + numInput('at.2', node.at[2], null, ro) + '</div></div>';
      html += '<div class="mm-field"><label>旋转（度）</label><div class="mm-num3">'
        + numInput('rot.0', node.rot[0], 1, ro) + numInput('rot.1', node.rot[1], 1, ro) + numInput('rot.2', node.rot[2], 1, ro) + '</div></div>';
      html += '<div class="mm-field"><label>缩放</label><div class="mm-num3">'
        + numInput('scale.0', node.scale[0], null, ro) + numInput('scale.1', node.scale[1], null, ro) + numInput('scale.2', node.scale[2], null, ro) + '</div></div>';
      if (node.kind === 'mannequin' || node.kind === 'crowd') {
        html += '<div class="mm-row"><label>体型</label><select class="ui-inp" data-prop="body">' + bodyOpts + '</select></div>';
        html += '<div class="mm-row"><label>姿势</label><select class="ui-inp" data-prop="pose">' + poseOpts + '</select></div>';
      }
      if (node.kind === 'crowd') {
        html += '<div class="mm-row"><label>行 / 列</label>' + numInput('rows', node.rows, 1) + numInput('cols', node.cols, 1) + '</div>';
        html += '<div class="mm-row"><label>间距 X / Z</label>' + numInput('gapX', node.gapX) + numInput('gapZ', node.gapZ) + '</div>';
        html += '<div class="mm-field"><label>抖动（站姿微差）</label>' + numInput('jitter', node.jitter) + '</div>';
      }
      if (node.kind === 'prim') {
        html += '<div class="mm-row"><label>灰阶</label><select class="ui-inp" data-prop="tone">' + toneOpts + '</select></div>';
      }
      if (node.kind === 'asset') {
        const entry = st.assets.get(node.file);
        const names = clipNamesOf(entry);
        const loopOpts = ['loop', 'once', 'hold'].map(v => '<option value="' + v + '"'
          + ((node.clipLoop || 'loop') === v ? ' selected' : '') + '>'
          + ({ loop: '循环', once: '播完停', hold: '播完停在末帧' })[v] + '</option>').join('');
        html += '<div class="mm-row"><label>文件</label><input class="ui-inp" value="' + esc(node.file) + '" disabled></div>';
        /* 白膜化：导入件默认统一换成黏土材质（白膜只收灰阶）；关掉就保留文件原来的材质 */
        html += '<div class="mm-row"><label>白膜化</label>'
          + '<input type="checkbox" data-prop="clay"' + (node.clay !== false ? ' checked' : '') + '>'
          + '<span class="mm-empty" style="flex:1">勾上 = 统一黏土材质</span></div>';
        /* 文件里没有动画就照实说一行，而不是把下拉藏起来（藏起来用户会以为坏了） */
        if (!names.length) {
          html += '<div class="mm-row"><label>动画</label>'
            + '<span class="mm-empty" style="flex:1">这个文件里没有动画</span></div>';
        } else {
          const clipOpts = '<option value=""' + (node.clip ? '' : ' selected') + '>无（停在绑定姿势）</option>'
            + names.map(nm => '<option value="' + esc(nm) + '"' + (node.clip === nm ? ' selected' : '') + '>'
              + esc(nm) + '</option>').join('');
          const cur = clipOf(entry, node.clip);
          html += '<div class="mm-row"><label>动画</label><select class="ui-inp" data-prop="clip">' + clipOpts + '</select></div>'
            + '<div class="mm-row"><label>速度</label>' + numInput('clipSpeed', node.clipSpeed || 1, 0.1)
            + '<label>循环</label><select class="ui-inp" data-prop="clipLoop">' + loopOpts + '</select></div>'
            + '<div class="mm-row"><label>偏移（秒）</label>' + numInput('clipOffset', node.clipOffset || 0, 0.1)
            + (cur ? '<span class="mm-empty" style="flex:1">这条 ' + (Number(cur.duration) || 0).toFixed(1) + ' 秒</span>' : '') + '</div>';
        }
      }
      html += '<div class="mm-row"><span class="sp"></span><button class="ghost mini danger" type="button" data-act="delNode">' + ic('trash', 12) + ' 删掉这个实体</button></div>';
      host.innerHTML = html;
      host.onchange = e => {
        const f = e.target.closest('[data-prop]');
        if (!f) return;
        applyProp(node, f.dataset.prop, f.type === 'checkbox' ? f.checked : f.value);
      };
      host.onclick = e => {
        if (e.target.closest('[data-act="colorClear"]')) {
          delete node.color;
          refreshPhead();
          view.setDoc(st.doc, {});
          paintTree();
          paintProps();
          return;
        }
        const b = e.target.closest('[data-act="delNode"]');
        if (!b) return;
        S.removeNode(st.doc.scene.nodes, node.id);
        st.doc.anim.tracks = st.doc.anim.tracks.filter(t => !(t.of && t.of.kind === 'node' && t.of.id === node.id));
        st.selectedId = '';
        st.selIds = [];
        refreshPhead();
        view.setDoc(st.doc, {});
        paintTree();
        paintProps();
      };
    }

    function applyProp(node, key, raw) {
      const n = Number(raw);
      if (key === 'name') node.name = String(raw || '').trim();
      else if (key === 'visible') node.visible = raw !== false;
      else if (key === 'locked') node.locked = raw === true;
      else if (key === 'clay') node.clay = raw !== false;
      else if (key === 'clip') node.clip = String(raw == null ? '' : raw).trim();
      else if (key === 'clipSpeed') node.clipSpeed = Number.isFinite(n) && n > 0 ? n : 1;
      else if (key === 'clipLoop') node.clipLoop = S.CLIP_LOOPS.includes(raw) ? raw : 'loop';
      else if (key === 'clipOffset') node.clipOffset = Number.isFinite(n) ? n : 0;
      else if (key === 'body') node.body = String(raw);
      else if (key === 'pose') node.pose = String(raw);
      else if (key === 'tone') node.tone = ['hi', 'mid', 'lo'].includes(raw) ? raw : 'hi';
      else if (key === 'color') {
        let c = String(raw == null ? '' : raw).trim().toLowerCase();
        if (/^#[0-9a-f]{3}$/.test(c)) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
        if (/^#[0-9a-f]{6}$/.test(c)) node.color = c;
        else delete node.color;
      }
      else if (key === 'rows' || key === 'cols') node[key] = Math.max(1, Math.round(Number(raw) || 1));
      else if (key === 'gapX' || key === 'gapZ') node[key] = Math.max(0, Number.isFinite(n) ? n : 0.9);
      else if (key === 'jitter') node.jitter = Math.max(0, Number.isFinite(n) ? n : 0);
      else if (/^(at|rot|scale)\.\d$/.test(key)) {
        const [k, i] = key.split('.');
        node[k][Number(i)] = Number.isFinite(n) ? n : 0;
        if (k === 'scale' && node.scale[Number(i)] === 0) node.scale[Number(i)] = 1;
      }
      refreshPhead();
      view.setDoc(st.doc, {});
      paintTree();
      /* 显示 / 锁定会改这一格自己的开关与只读态，得跟着重画（其余输入框不重画，
         免得正在敲数字时被换掉） */
      if (key === 'visible' || key === 'locked' || key === 'color') paintProps();
      /* 换 clip 会多出一条时间线条：轨道不跟着重画的话，带子与可拖的进度条要等下一次
         别的原因触发重画才出现 —— 用户会以为「选了动画但时间线没反应」 */
      if (key === 'clip' || key === 'clipSpeed' || key === 'clipLoop' || key === 'clipOffset') paintDock();
    }

    /* ---------------- 右栏：两档 ---------------- */
    function paintSide() {
      const tabs = $('mmSideTabs');
      const body = $('mmSideBody');
      if (!tabs || !body) return;
      tabs.innerHTML = '<div class="ui-seg" role="tablist">'
        + [['ai', 'AI'], ['props', '属性'], ['cam', '机位']].map(([t, label]) =>
          '<button type="button" role="tab" aria-selected="' + (st.sideTab === t ? 'true' : 'false') + '" class="' + (st.sideTab === t ? 'on' : '') + '" data-tab="' + t + '">' + label + '</button>').join('') + '</div>';
      tabs.onclick = e => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        st.sideTab = b.dataset.tab;
        window.LS.set('sk_model_side', st.sideTab);
        paintSide();
      };

      if (st.sideTab === 'ai') {
        const refs = st.refImages.map((x, i) => '<span class="chip on">' + esc(x.label || ('图片 ' + (i + 1)))
          + '<button class="ui-linkbtn" type="button" data-ref-remove="' + i + '" title="移除">×</button></span>').join('');
        const libChips = (st.libraries || []).map(x => '<button class="chip' + (st.aiLibs.includes(x.id) ? ' on' : '')
          + '" type="button" data-ai-lib="' + esc(x.id) + '">' + esc(x.name) + '</button>').join('');
        body.innerHTML =
          '<div class="mm-field"><label>要生成什么 / 改什么（一句话就行）</label>'
          + '<textarea class="ui-inp mm-prompt" data-r="mmPrompt" placeholder="例：一个穿长外套的少女；或者把选中的小人改成坐姿">' + esc(st.prompt || '') + '</textarea></div>'
          + '<div class="mm-line">' + (st.selectedId ? '选中实体：' + esc(st.selectedId) + '（AI 会按你说的改它）' : '未选中实体（AI 会新增一件）') + '</div>'
          + '<div class="mm-row"><label>图片</label><button class="ghost mini" type="button" data-act="addImage">' + ic('image', 12) + ' 加图片</button>'
          + '<span class="mm-empty" style="flex:1">给 AI 看参考图</span></div>'
          + (refs ? '<div class="mm-groups">' + refs + '</div>' : '')
          + '<div class="mm-field"><label>AI 可调用的白模库（可多选）</label><div class="mm-groups">'
          + (libChips || '<span class="mm-line">还没有白模库</span>') + '</div></div>'
          + '<div class="mm-row"><span class="sp"></span>'
          + (st.prevDoc ? '<button class="ghost mini" type="button" data-act="undoAi">' + ic('undo', 12) + ' 撤销这次修改</button>' : '')
          + (st.busy === 'ai'
            ? '<button class="ghost" type="button" data-act="stop">' + ic('pause', 12) + ' 停止</button>'
            : '<button class="pri" type="button" data-act="gen">' + ic('sparkles', 13) + ' 生成 / 修改</button>')
          + '</div>'
          + (st.busy === 'ai'
            ? '<div class="mm-stream" data-r="mmStream">'
              + '<div class="mm-stream-say wait" data-r="mmStreamSay">正在想…</div>'
              + '<div class="mm-stream-meta" data-r="mmStreamMeta"></div>'
              + '<div class="mm-stream-raw" data-r="mmStreamRaw"></div>'
              + '</div>'
            : '')
          + (st.aiText ? '<div class="mm-note">上一轮：' + esc(st.aiText) + '</div>' : '')
          + '<div class="mm-empty">不用先选模式：没选中实体时 AI 新增一件；选中后它会按你说的话改选中的实体。</div>';
        body.onclick = e => {
          const stop = e.target.closest('[data-act="stop"]');
          if (stop) { if (st.aiCtl) st.aiCtl.abort(); return; }
          const gen = e.target.closest('[data-act="gen"]');
          if (gen) { generate(); return; }
          if (e.target.closest('[data-act="undoAi"]')) { undoAi(); return; }
          if (e.target.closest('[data-act="addImage"]')) { const f = $('mmImgInput'); if (f) f.click(); return; }
          const lib = e.target.closest('[data-ai-lib]');
          if (lib) {
            const id = lib.dataset.aiLib;
            const set = new Set(st.aiLibs);
            if (set.has(id)) set.delete(id); else set.add(id);
            st.aiLibs = Array.from(set);
            window.LS.set('sk_model_ai_libs', JSON.stringify(st.aiLibs));
            paintSide();
            return;
          }
          const rm = e.target.closest('[data-ref-remove]');
          if (rm) { st.refImages.splice(Number(rm.dataset.refRemove), 1); paintSide(); }
        };
        body.oninput = e => {
          const ta = e.target.closest('[data-r="mmPrompt"]');
          if (ta) st.prompt = ta.value;
        };
        return;
      }

      if (st.sideTab === 'cam') {
        body.innerHTML = '<div data-r="mmCams"></div><div class="mm-field"><label>机位值</label><div data-r="mmCam"></div></div>';
        paintCams();
        paintCam();
        return;
      }

      body.innerHTML =
        '<div data-r="mmProps"></div>'
        + '<div class="mm-field"><label>背景（全景球）</label><div class="mm-row"><span class="sp"></span>'
        + '<button class="ghost mini" type="button" data-act="pano">' + ic('image', 12) + ' 选全景图</button>'
        + '<button class="ghost mini" type="button" data-act="panoClear">清空</button></div>'
        + '<div data-r="mmPano"></div></div>';
      body.onclick = e => {
        if (e.target.closest('[data-act="pano"]')) { pickPanorama(); return; }
        if (e.target.closest('[data-act="panoClear"]')) {
          st.doc.scene.panorama = { src: '', yaw: 0, radius: 20 };
          view.setDoc(st.doc, {});
          refreshPhead();
          paintPano();
        }
      };
      paintProps();
      paintPano();
    }

    /* 生成时的流式回显：AI 说的那一句 + 它正在写的原文尾巴 + 已收零件数。
       只改这一块的三行字，不整个重画右栏 —— 整块重画会把输入框重建掉，
       用户正在补一句话的时候焦点会跳走。 */
    function paintStream() {
      const say = $('mmStreamSay');
      const meta = $('mmStreamMeta');
      const raw = $('mmStreamRaw');
      if (!say && !meta && !raw) return;
      if (say) {
        say.textContent = st.aiSay || '正在想…';
        say.classList.toggle('wait', !st.aiSay);
      }
      if (meta) {
        meta.textContent = '已收 ' + st.aiCount + ' 个零件 · ' + (st.aiRaw.length / 1024).toFixed(1) + ' KB';
      }
      if (raw) {
        raw.textContent = st.aiRaw.slice(-480);
        raw.scrollTop = raw.scrollHeight;      // 永远停在最新那几行
      }
    }

    /* 每个 chunk 都重画太密（一秒几十次）；60ms 一次，肉眼看到的就是连续的 */
    let streamTimer = 0;
    function paintStreamSoon() {
      if (streamTimer) return;
      streamTimer = setTimeout(() => { streamTimer = 0; paintStream(); }, 60);
    }
    function stopStreamSoon() {
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = 0; }
    }

    function cameraTrackOf(id) {
      return st.doc.anim.tracks.find(t => t.of && t.of.kind === 'cam' && t.of.id === id) || null;
    }

    function ensureCameraTrack(id) {
      let tr = cameraTrackOf(id);
      if (!tr) {
        tr = {
          id: S.newId('t'), of: { kind: 'cam', id }, enabled: true, color: 0,
          interp: 'smooth', motion: '', joint: '', path: null, keys: [],
        };
        st.doc.anim.tracks.push(tr);
      }
      return tr;
    }

    function keyCamera(id) {
      const cam = S.camOf(st.doc, id);
      if (!cam) return;
      const tr = ensureCameraTrack(id);
      const t = Math.round((view ? view.time : 0) * 100) / 100;
      tr.keys = tr.keys.filter(k => Math.abs(k.t - t) > 0.001);
      tr.keys.push({ t, at: cam.pos.slice(), target: cam.target.slice(), fov: cam.fov });
      tr.keys.sort((a, b) => a.t - b.t);
      refreshPhead();
      view.applyCamera(view.time);
      paintDock();
      paintCam();
      note('在 ' + t.toFixed(1) + ' 秒给「' + cam.name + '」打了机位关键帧', 'ok');
    }

    function paintCam() {
      const host = $('mmCam');
      if (!host || !st.doc) return;
      const c = S.camOf(st.doc, st.doc.scene.active) || st.doc.scene.cams[0];
      if (!c) return;
      const nodes = [];
      S.walkNodes(st.doc.scene.nodes, n => nodes.push(n));
      const followOpts = '<option value="">不跟随</option>'
        + nodes.map(n => '<option value="' + esc(n.id) + '"' + (c.follow === n.id ? ' selected' : '') + '>' + esc(nodeLabel(n)) + '</option>').join('');
      const camOpts = st.doc.scene.cams.map(x => '<option value="' + esc(x.id) + '"' + (x.id === c.id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
      const tr = cameraTrackOf(c.id);
      host.innerHTML =
        '<div class="mm-field"><label>当前机位</label><select class="ui-inp" data-cam-pick>' + camOpts + '</select></div>'
        + '<div class="mm-field"><label>位置（x / y / z，米）</label><div class="mm-num3">' + numInput('cam.pos.0', c.pos[0]) + numInput('cam.pos.1', c.pos[1]) + numInput('cam.pos.2', c.pos[2]) + '</div></div>'
        + '<div class="mm-field"><label>看向（x / y / z，米）</label><div class="mm-num3">' + numInput('cam.target.0', c.target[0]) + numInput('cam.target.1', c.target[1]) + numInput('cam.target.2', c.target[2]) + '</div></div>'
        + '<div class="mm-row"><label>FOV</label>' + numInput('cam.fov', c.fov, 1)
        + '<label>跟随</label><select class="ui-inp" data-cam-follow>' + followOpts + '</select></div>'
        + '<div class="mm-row"><span class="sp"></span>'
        + '<button class="ghost mini" type="button" data-cam-act="key">' + ic('key', 12) + ' 在播放头打机位关键帧</button>'
        + (tr ? '<span class="mm-empty">这个机位已有动画轨道（' + tr.keys.length + ' 帧）</span>' : '')
        + '</div>'
        + '<div class="mm-row"><label>取景预设</label>'
        + '<button class="ghost mini" type="button" data-shot="near">近景</button>'
        + '<button class="ghost mini" type="button" data-shot="mid">中景</button>'
        + '<button class="ghost mini" type="button" data-shot="wide">全景</button></div>';
      host.onchange = e => {
        const pick = e.target.closest('[data-cam-pick]');
        if (pick) { view.setActiveCam(pick.value); refreshPhead(); paintCams(); paintCam(); return; }
        const follow = e.target.closest('[data-cam-follow]');
        if (follow) { c.follow = follow.value; refreshPhead(); view.applyCamera(view.time); paintCam(); return; }
        const f = e.target.closest('[data-prop]');
        if (!f) return;
        const k = f.dataset.prop;
        const v = Number(f.value);
        if (k === 'cam.fov') {
          if (Number.isFinite(v) && v > 0 && v < 180) c.fov = v;
        } else {
          const [, key, i] = k.split('.');
          if (Number.isFinite(v)) c[key][Number(i)] = v;
        }
        /* 当前机位已有轨道时，值改动 = 在播放头自动打一个关键帧（没有轨道就改静态值）。 */
        if (cameraTrackOf(c.id)) {
          const tr2 = ensureCameraTrack(c.id);
          const t = Math.round((view ? view.time : 0) * 100) / 100;
          tr2.keys = tr2.keys.filter(x => Math.abs(x.t - t) > 0.001);
          tr2.keys.push({ t, at: c.pos.slice(), target: c.target.slice(), fov: c.fov });
          tr2.keys.sort((a, b) => a.t - b.t);
          paintDock();
        }
        refreshPhead();
        view.applyCamera(view.time);
        view.invalidate();
        paintCam();
      };
      host.onclick = e => {
        const key = e.target.closest('[data-cam-act="key"]');
        if (key) { keyCamera(c.id); return; }
        const b = e.target.closest('[data-shot]');
        if (!b) return;
        applyCameraPreset(b.dataset.shot);
      };
    }

    /* 全景球：朝向（绕 Y）与半径（球多大）。半径只影响「墙有多远」，白膜的机位在球内，
       给大一点远景不容易穿帮；图换了就重新贴一次。 */
    function paintPano() {
      const host = $('mmPano');
      if (!host || !st.doc) return;
      const p = st.doc.scene.panorama;
      if (!p.src) {
        host.innerHTML = '<div class="mm-empty">还没有全景图：没有底图时用摄影棚的纯色底。</div>';
        return;
      }
      host.innerHTML = '<div class="mm-row"><label>朝向 / 半径</label>'
        + numInput('pano.yaw', p.yaw, 1) + numInput('pano.radius', p.radius, 1) + '</div>';
      host.onchange = e => {
        const f = e.target.closest('[data-prop]');
        if (!f) return;
        const v = Number(f.value);
        if (f.dataset.prop === 'pano.yaw') { if (Number.isFinite(v)) p.yaw = v; }
        else if (Number.isFinite(v) && v > 0) p.radius = v;
        refreshPhead();
        view.setDoc(st.doc, {});
        paintPano();
      };
    }

    /* 机位预设：从模型包围盒现算（近景看上半身、中景看全身、全景装下整个场景）。
       包围盒只有一份（view.bounds → scene.boundsOf），这里只做「按包围盒摆机位」这一件事。 */
    function applyCameraPreset(kind) {
      if (!st.doc || !view) return;
      const box = view.bounds();
      const c = S.camOf(st.doc, st.doc.scene.active) || st.doc.scene.cams[0];
      if (!c) return;
      const center = [
        (box.min.x + box.max.x) / 2,
        (box.min.y + box.max.y) / 2,
        (box.min.z + box.max.z) / 2,
      ];
      const size = Math.max(0.6, box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
      const target = kind === 'near' ? [center[0], box.max.y - size * 0.12, center[2]] : [center[0], center[1], center[2]];
      const fov = kind === 'near' ? 32 : kind === 'wide' ? 46 : 38;
      const k = kind === 'near' ? 0.7 : kind === 'wide' ? 1.6 : 1.08;
      const dist = (size / 2) / Math.tan((fov * D2R) / 2) * k;
      const dir = [0.62, 0.34, 1];
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      c.pos = [target[0] + (dir[0] / len) * dist, target[1] + (dir[1] / len) * dist, target[2] + (dir[2] / len) * dist];
      c.target = target;
      c.fov = fov;
      if (cameraTrackOf(c.id)) {
        const tr = ensureCameraTrack(c.id);
        const t = Math.round((view ? view.time : 0) * 100) / 100;
        tr.keys = tr.keys.filter(x => Math.abs(x.t - t) > 0.001);
        tr.keys.push({ t, at: c.pos.slice(), target: c.target.slice(), fov: c.fov });
        tr.keys.sort((a, b) => a.t - b.t);
        paintDock();
      }
      refreshPhead();
      view.applyCamera(view.time);
      view.invalidate();
      paintCam();
    }

    async function pickPanorama() {
      try {
        const got = await window.AssetPicker.open({ types: ['图片'], multiple: false, limit: 1, title: '选一张全景图（等距柱状）' });
        if (!got || !got.length) return;
        const it = got[0];
        const src = it.src || it.url;
        if (!src) { note('这张图取不到地址', 'err'); return; }
        st.doc.scene.panorama = Object.assign({ yaw: 0, radius: 20 }, st.doc.scene.panorama, { src: window.Api.mediaSrc(src) });
        view.setDoc(st.doc, {});
        refreshPhead();
        paintPano();
        note('背景已换成全景图', 'ok');
      } catch (e) {
        note('选全景图失败：' + window.errText(e), 'err');
      }
    }

    /* ---------------- 工具条 ---------------- */
    function paintTools() {
      const host = $('mmTools');
      if (!host || !st.doc) return;
      const v = st.doc.scene.view;
      host.innerHTML = '<div class="ui-seg" data-g="view">'
        + '<button type="button" class="' + (v.mode === 'director' ? 'on' : '') + '" data-v="director">导演视角</button>'
        + '<button type="button" class="' + (v.mode === 'camera' ? 'on' : '') + '" data-v="camera">机位视角</button></div>'
        + '<span class="mm-tools-group"><span class="mm-tools-lab">视角</span><div class="ui-seg" data-g="nav">'
        + '<button type="button" class="' + (st.navMode === 'rotate' ? 'on' : '') + '" data-v="rotate" title="左键拖动：围着目标转">转动</button>'
        + '<button type="button" class="' + (st.navMode === 'pan' ? 'on' : '') + '" data-v="pan" title="左键拖动：把视角整体挪动">平移</button></div></span>'
        + '<div class="ui-seg" data-g="aspect">' + ASPECTS.map(a => '<button type="button" class="' + (v.aspect === a ? 'on' : '') + '" data-v="' + a + '">' + a + '</button>').join('') + '</div>'
        + '<button class="tool" type="button" data-toggle="grid" title="网格" aria-pressed="' + (v.grid ? 'true' : 'false') + '">' + ic('grid', 14) + '</button>'
        + '<button class="tool" type="button" data-toggle="ground" title="地面" aria-pressed="' + (v.ground ? 'true' : 'false') + '">' + ic('layers', 14) + '</button>'
        + '<button class="tool" type="button" data-toggle="outline" title="描边" aria-pressed="' + (v.outline ? 'true' : 'false') + '">' + ic('box', 14) + '</button>'
        + '<button class="tool" type="button" data-rig="1" title="相机标识（视锥）" aria-pressed="' + (st.showRig ? 'true' : 'false') + '">' + ic('video', 14) + '</button>'
        + '<span class="mm-tools-group"><span class="mm-tools-lab">取景</span><div class="ui-seg" data-g="frame">'
        + ['near', 'mid', 'wide'].map(k => '<button type="button" data-frame="' + k + '" title="导演视角取景：' + ({ near: '近景（看上半身）', mid: '中景（整体）', wide: '全景（再退一档）' }[k]) + '">' + ({ near: '近景', mid: '中景', wide: '全景' }[k]) + '</button>').join('')
        + '</div></span>'
        + '<span class="sp"></span>'
        + '<button class="ghost" type="button" data-act="shot">' + ic('image', 13) + ' 出图</button>'
        + '<button class="ghost" type="button" data-act="record">' + ic('video', 13) + ' 出片</button>';
      host.onclick = e => {
        const fr = e.target.closest('[data-frame]');
        if (fr) { if (view) view.frameTo(fr.dataset.frame); return; }
        const b = e.target.closest('[data-v]');
        if (b) {
          const group = b.parentElement.dataset.g;
          const val = b.dataset.v;
          if (group === 'view') { st.doc.scene.view.mode = val; view.setViewMode(val); }
          if (group === 'nav') { st.navMode = val; view.setNavMode(val); window.LS.set('sk_model_nav', val); }
          if (group === 'aspect') { st.doc.scene.view.aspect = val; view.setAspect(val); }
          paintTools();
          refreshPhead();
          return;
        }
        const t = e.target.closest('[data-toggle]');
        if (t) {
          const k = t.dataset.toggle;
          st.doc.scene.view[k] = !st.doc.scene.view[k];
          view.setDoc(st.doc, {});
          paintTools();
          refreshPhead();
          return;
        }
        /* 相机标识不进 doc（它是编辑辅助，不是作品的一部分），所以单独一条，只动页面偏好 */
        if (e.target.closest('[data-rig]')) {
          st.showRig = !st.showRig;
          view.setRigVisible(st.showRig);
          window.LS.set('sk_model_rig', st.showRig ? '1' : '0');
          paintTools();
          note(st.showRig ? '相机标识：显示' : '相机标识：隐藏', 'ok');
          return;
        }
        if (e.target.closest('[data-act="shot"]')) { doShot(); return; }
        if (e.target.closest('[data-act="record"]')) { doRecord(); return; }
      };
    }

    /* ---------------- 出图 / 出片 ---------------- */
    async function doShot() {
      if (!view || st.busy) return;
      st.busy = 'shot';
      note('正在出图…');
      try {
        const a = await Capture.shoot(view, { doc: st.doc, shortEdge: st.shortEdge, prompt: promptText() });
        addOut(a);
        note('已出图：' + a.name + '（已存进本机资产库）', 'ok');
      } catch (e) {
        note('出图失败：' + window.errText(e), 'err');
      } finally {
        st.busy = '';
      }
    }

    async function doRecord() {
      if (!view || st.busy) return;
      st.busy = 'record';
      const seconds = Math.max(0.001, Number(st.doc.anim.duration) || 3);
      const wasPlaying = !!(dock && dock.playing);
      if (dock) dock.pause();
      note('正在出片（' + seconds + ' 秒）…');
      try {
        const a = await Capture.record(view, {
          doc: st.doc,
          shortEdge: st.shortEdge,
          duration: seconds,
          prompt: promptText(),
          onProgress: p => { if (p && p.msg) note(p.msg + (p.progress ? '（' + p.progress + '%）' : '')); },
        });
        addOut(a);
        note('已出片：' + a.name + '（已存进本机资产库）', 'ok');
      } catch (e) {
        note((e && e.name === 'AbortError' ? '已取消' : '出片失败：' + window.errText(e)), 'err');
      } finally {
        st.busy = '';
        if (wasPlaying && dock) dock.play();
      }
    }

    const promptText = () => (st.prompt || '').trim() || ($('mmPrompt') ? $('mmPrompt').value.trim() : '') || st.doc.name || '';

    function addOut(a) {
      if (!st.doc) return;
      st.doc.out = Array.isArray(st.doc.out) ? st.doc.out : [];
      st.doc.out.unshift({
        id: S.newId('o'), assetId: a.assetId || '', url: a.url || a.src || '',
        type: a.type === 'video' ? 'video' : 'image', name: a.name || '白膜产物',
        at: Date.now(), picked: true,
      });
      st.outOpen = true;
      window.LS.set('sk_model_out_open', '1');
      refreshPhead();
      paintOut();
    }

    function outChecked() {
      return ((st.doc && st.doc.out) || []).filter(it => it.picked !== false);
    }

    async function chooseOutTarget() {
      const pick = await window.Confirm.choose({
        title: '发回哪个页面？',
        options: [
          { value: 'studio', label: '工作台', hint: '放进参考素材' },
          { value: 'director', label: '导演台', hint: '加入当前镜头' },
        ],
      });
      if (!pick) return;
      st.origin = {
        page: pick,
        type: st.origin && st.origin.type ? st.origin.type : 'image',
        shot: st.origin && st.origin.page === pick ? (st.origin.shot || '') : '',
      };
      paintOut();
    }

    async function confirmOut() {
      const items = outChecked();
      if (!items.length) { note('先勾选要选用的截图或视频', 'err'); return; }
      if (!window.Model3D || !window.Model3D.handoffTo) { note('回传通道没装上', 'err'); return; }
      let target = st.origin;
      if (!target) {
        const pick = await window.Confirm.choose({
          title: '送到哪个页面？',
          body: '从侧栏直接进来时没有回传目标，选一个页面接收这些截图 / 视频',
          options: [
            { value: 'studio', label: '工作台', hint: '放进参考素材' },
            { value: 'director', label: '导演台', hint: '加入当前镜头' },
          ],
        });
        if (!pick) return;
        target = { page: pick, type: 'image', shot: '' };
        st.origin = target;
      }
      const assets = items.map(a => ({
        assetId: a.assetId || '', url: a.url || a.src || '', name: a.name || '',
        type: a.type === 'video' ? 'video' : 'image',
      }));
      const payload = { assets };
      if (target.page === 'director' && target.shot) payload.shot = target.shot;
      window.Model3D.handoffTo(target.page, payload);
      if (target.page === 'studio') window.GoPage.go('studio.html?t=' + encodeURIComponent(target.type || 'image'));
      else window.GoPage.go('director.html');
    }

    /* 单条存资产库：出图 / 出片本来就已经落库；这里给没落成的那一条补一次，
       并让用户看得见「这一条已经在资产库」。 */
    async function saveOutAsset(it) {
      if (!it) return;
      if (it.assetId) { note('已在资产库：' + it.name, 'ok'); return; }
      const src = it.url || it.src;
      if (!src) { note('这一条没有可保存的地址', 'err'); return; }
      try {
        const ext = it.type === 'video'
          ? ((String(it.name).match(/\.([a-z0-9]+)$/i) || [])[1] || 'mp4')
          : 'png';
        const saved = await window.Api.saveLocalFromUrl({
          url: src,
          name: it.name,
          mime: it.type === 'video' ? 'video/mp4' : 'image/png',
          format: ext,
          media_type: it.type === 'video' ? 'video' : 'image',
          meta: { provider: '本机', model: '3D白膜', prompt: st.doc ? st.doc.name : '' },
        });
        const id = saved.assetId || saved.id;
        if (!id) throw new Error('没有拿到资产号');
        it.assetId = id;
        it.url = saved.url || window.Api.assetSrc(id);
        it.src = it.url;
        if (window.AssetLocal && window.AssetLocal.learn) window.AssetLocal.learn(saved);
        paintOut();
        note('已存资产库：' + it.name, 'ok');
      } catch (e) { note('存资产库失败：' + window.errText(e), 'err'); }
    }

    function paintOut() {
      const host = $('mmOut');
      if (!host) return;
      const list = (st.doc && st.doc.out) || [];
      if (!list.length) { host.innerHTML = ''; host.hidden = true; return; }
      host.hidden = false;
      host.classList.toggle('collapsed', !st.outOpen);
      const checked = outChecked().length;
      host.innerHTML = '<div class="mm-out-head">'
        + '<button class="mm-tree-mini" type="button" data-out-act="toggle" title="' + (st.outOpen ? '收起' : '展开') + '">' + ic(st.outOpen ? 'chevronDown' : 'chevronUp', 12) + '</button>'
        + '<b>出图 / 出片 · ' + list.length + '</b>'
        + '<span class="mm-out-count">已选 ' + checked + ' / ' + list.length + '</span>'
        + '<span class="sp"></span>'
        + '<button class="ui-linkbtn" type="button" data-out-act="all">全选</button>'
        + '<button class="ui-linkbtn" type="button" data-out-act="none">全不选</button>'
        + '<button class="ui-linkbtn" type="button" data-out-act="target" title="选择接收页面">'
        + (st.origin ? '发回：' + (st.origin.page === 'studio' ? '工作台' : '导演台') : '选接收页面') + '</button>'
        + '<button class="pri" type="button" data-out-act="confirm" title="' + (st.origin ? '发回 ' + st.origin.page : '选一个页面接收') + '">确认选用截图和视频</button>'
        + '</div>'
        + (st.outOpen ? '<div class="mm-out-strip">' + list.map((it, i) => {
          const src = it.url || (it.assetId ? window.Api.assetSrc(it.assetId) : '');
          const thumb = it.type === 'video'
            ? '<span class="mm-out-ph">' + ic('video', 16) + '</span>'
            : (src ? '<img src="' + esc(src) + '" alt="" loading="lazy">' : '<span class="mm-out-ph">' + ic('image', 16) + '</span>');
          return '<div class="mm-out-item' + (it.picked === false ? ' off' : '') + '">'
            + '<input type="checkbox" data-out-pick="' + i + '"' + (it.picked === false ? '' : ' checked') + '>'
            + '<button class="mm-out-open" type="button" data-out-act="pick" data-out-index="' + i + '" title="勾选 / 取消">' + thumb + '</button>'
            + '<span class="mm-out-name" title="' + esc(it.name) + '">' + (it.type === 'video' ? '视频 · ' : '图片 · ') + esc(it.name) + '</span>'
            + '<button class="ui-linkbtn mm-out-asset" type="button" data-out-act="asset" data-out-index="' + i + '" title="' + (it.assetId ? '这一条已在本机资产库' : '单独保存到本机资产库') + '">'
            + (it.assetId ? '已存资产库' : '存资产库') + '</button>'
            + '</div>';
        }).join('') + '</div>' : '');
      host.onclick = e => {
        const b = e.target.closest('[data-out-act]');
        if (!b) return;
        if (b.dataset.outAct === 'toggle') {
          st.outOpen = !st.outOpen;
          window.LS.set('sk_model_out_open', st.outOpen ? '1' : '0');
          paintOut();
          return;
        }
        if (b.dataset.outAct === 'target') { chooseOutTarget(); return; }
        if (b.dataset.outAct === 'confirm') { confirmOut(); return; }
        if (b.dataset.outAct === 'all') { for (const it of list) it.picked = true; paintOut(); return; }
        if (b.dataset.outAct === 'none') { for (const it of list) it.picked = false; paintOut(); return; }
        const i = Number(b.dataset.outIndex);
        if (b.dataset.outAct === 'asset' && list[i]) { saveOutAsset(list[i]); return; }
        if (b.dataset.outAct === 'pick' && list[i]) { list[i].picked = list[i].picked === false; paintOut(); }
      };
      host.onchange = e => {
        const cb = e.target.closest('[data-out-pick]');
        if (!cb) return;
        const i = Number(cb.dataset.outPick);
        if (list[i]) { list[i].picked = cb.checked; paintOut(); }
      };
    }

    /* ---------------- 底部轨道坞 ----------------
       一条轨道 = 一份 anim.tracks 记录（节点 × 时间）。播放头画在每条的条带上（同一格红色竖线），
       点条带即定位；播放时由一颗 80ms 的定时器挪它 —— 三维那边自己按帧走，这里只管「看到第几秒」。 */
    /* ---------------- 底部轨道坞 ----------------
       播放时钟 / 轨道行 / 播放头全部归 dock.js。本页只把 doc / view / 选中对象递进去，
       并在它改完轨道之后统一 refreshPhead + 重画。 */
    function paintDock() { if (dock) dock.renderDock(); }

    function initDock() {
      if (dock) { dock.destroy(); dock = null; }
      dock = createDock({
        host: $('mmDock'),
        getDoc: () => st.doc,
        getView: () => view,
        getSelectedId: () => st.selectedId,
        getAssets: () => st.assets,
        getNote: () => ({ text: st.note, kind: st.noteKind }),
        note,
        onChange: () => { refreshPhead(); paintOut(); },
        onTime: () => { if (view) view.invalidate(); },
      });
      dock.renderDock();
    }

    /* ---------------- 导入 / 导出 ---------------- */
    async function import3DFile(file) {
      if (!file) return;
      if (!st.library) { note('先在「白模库」里选一个库', 'err'); return; }
      note('正在导入「' + file.name + '」…');
      try {
        const r = await Vault.upload(file, st.library);
        const node = {
          kind: 'asset', id: S.newId('a'), name: String(r.name || file.name),
          file: r.file, at: [0, 0, 1], rot: [0, 0, 0], scale: [1, 1, 1], clay: true,
        };
        st.doc.scene.nodes.push(node);
        st.selectedId = node.id;
        st.selIds = [node.id];
        await syncAssets();
        view.setDoc(st.doc, {});
        view.setSelection(node.id);
        paintAll();
        note('已导入「' + r.file + '」并放到场景里', 'ok');
      } catch (e) {
        note('导入失败：' + window.errText(e), 'err');
      }
    }

    async function importModelFile(file) {
      if (!file) return;
      if (!st.library) { note('先在「白模库」里选一个库', 'err'); return; }
      try {
        const raw = await Vault.readJsonFile(file);
        if (raw.kind === 'scene') { note('这是场景文件，请用「导入场景」', 'err'); return; }
        const out = S.normalizeDoc(raw);
        out.doc.kind = 'model';
        const v = await window.PromptForm.open({
          title: '导入模型到白模库',
          okLabel: '导入',
          fields: [{ key: 'name', label: '模型名', type: 'text', value: out.doc.name, required: true }],
        });
        if (!v) return;
        const name = Vault.cleanName(v.name);
        if (!name) return;
        out.doc.name = name;
        await Vault.saveModel({ library: st.library, name, group: '', model: out.doc });
        await loadLibrary(st.library);
        note('已导入模型：' + name, 'ok');
      } catch (e) { note('导入模型失败：' + window.errText(e), 'err'); }
    }

    async function importSceneFile(file) {
      if (!file) return;
      if (!st.library) { note('先在「白模库」里选一个库', 'err'); return; }
      try {
        const raw = await Vault.readJsonFile(file);
        if (raw.kind === 'library-pack') { await importLibraryPack(raw); return; }
        if (raw.kind === 'scene-pack') { await importScenePack(raw); return; }
        if (raw.kind === 'model') { note('这是模型文件，请用「导入模型到白模库」', 'err'); return; }
        const out = S.normalizeDoc(raw);
        out.doc.kind = 'scene';
        const v = await window.PromptForm.open({
          title: '导入场景',
          okLabel: '导入',
          fields: [
            { key: 'name', label: '场景名', type: 'text', value: out.doc.name, required: true },
            { key: 'group', label: '场景组（可留空）', type: 'text', value: out.doc.group || st.sceneGroup || '' },
          ],
        });
        if (!v) return;
        const name = Vault.cleanName(v.name);
        const group = Vault.cleanGroup(v.group);
        if (!name) return;
        out.doc.name = name;
        out.doc.group = group;
        const r = await Vault.saveScene({ library: st.library, name, group, model: out.doc });
        await loadLibrary(st.library);
        st.sceneGroup = group;
        await openScene(r.id);
        note('已导入场景：' + r.id, 'ok');
      } catch (e) { note('导入场景失败：' + window.errText(e), 'err'); }
    }

    async function importScenePack(pack) {
      const list = Array.isArray(pack.scenes) ? pack.scenes : [];
      if (!list.length) { note('场景组包里没有场景', 'err'); return; }
      let n = 0;
      for (const item of list) {
        const out = S.normalizeDoc(item.doc || item.model || item);
        out.doc.kind = 'scene';
        const name = Vault.cleanName(item.name || out.doc.name || '导入场景');
        const group = Vault.cleanGroup(item.group || out.doc.group || '');
        out.doc.name = name;
        out.doc.group = group;
        await Vault.saveScene({ library: st.library, name, group, model: out.doc });
        n += 1;
      }
      await loadLibrary(st.library);
      note('已导入 ' + n + ' 个场景', 'ok');
    }

    async function importLibraryPack(pack) {
      const v = await window.PromptForm.open({
        title: '导入白模库包',
        okLabel: '导入',
        fields: [{ key: 'name', label: '新库名', type: 'text', value: (pack.library && pack.library.name) || '导入库', required: true }],
      });
      if (!v) return;
      const lib = Vault.cleanName(v.name);
      if (!lib) return;
      await Vault.saveLibrary({ name: lib });
      for (const m of (pack.models || [])) {
        const doc = S.normalizeDoc(m.doc || m.model || m).doc;
        doc.kind = 'model';
        doc.name = Vault.cleanName(m.name || doc.name || '导入模型');
        await Vault.saveModel({ library: lib, name: doc.name, group: m.group || doc.group || '', model: doc });
      }
      for (const s of (pack.scenes || [])) {
        const doc = S.normalizeDoc(s.doc || s.model || s).doc;
        doc.kind = 'scene';
        doc.name = Vault.cleanName(s.name || doc.name || '导入场景');
        doc.group = Vault.cleanGroup(s.group || doc.group || '');
        await Vault.saveScene({ library: lib, name: doc.name, group: doc.group, model: doc });
      }
      await loadLibraries();
      await loadLibrary(lib);
      note('已导入白模库：' + lib, 'ok');
    }

    async function readAllScenes(filterGroup) {
      const rows = (st.scenes || []).filter(s => !filterGroup || s.group === filterGroup);
      const out = [];
      for (const row of rows) {
        const doc = S.normalizeDoc(await Vault.readScene(st.library, row.id)).doc;
        out.push({ group: row.group || '', name: row.name, doc });
      }
      return out;
    }

    async function readAllModels() {
      const out = [];
      for (const row of (st.models || [])) {
        const doc = S.normalizeDoc(await Vault.readModel(st.library, row.id)).doc;
        out.push({ group: row.group || '', name: row.name, doc });
      }
      return out;
    }

    async function exportCurrentEntity() {
      const entities = selectedEntities();
      if (entities.length !== 1) { note('先选中一个实体', 'err'); return; }
      const e = entities[0];
      const doc = modelFromEntity(e, e.name || '实体', {
        library: st.library,
        tracks: st.doc.anim.tracks,
        duration: st.doc.anim.duration,
        fps: st.doc.anim.fps,
        loop: st.doc.anim.loop !== false,
      });
      Vault.exportDoc(doc, Vault.cleanName(e.name || '实体') + '.json');
      note('已导出实体：' + (e.name || '实体'), 'ok');
    }

    function exportCurrentScene() {
      if (!st.doc) return;
      Vault.exportDoc(st.doc, Vault.cleanName(st.doc.name || '场景') + '.json');
      note('已导出当前场景', 'ok');
    }

    async function exportSceneGroup() {
      if (!st.library) return;
      const group = st.sceneGroup || '';
      const scenes = await readAllScenes(group);
      const pack = { kind: 'scene-pack', v: 1, library: st.library, group, scenes };
      Vault.exportDoc(pack, '场景组-' + Vault.cleanName(group || '全部') + '-' + Date.now() + '.json');
      note('已导出 ' + scenes.length + ' 个场景', 'ok');
    }

    async function exportLibraryPack() {
      if (!st.library) return;
      const models = await readAllModels();
      const scenes = await readAllScenes('');
      const pack = {
        kind: 'library-pack', v: 1,
        library: { name: st.library },
        models, scenes,
      };
      Vault.exportDoc(pack, '白模库-' + Vault.cleanName(st.library) + '-' + Date.now() + '.json');
      note('已导出白模库：' + models.length + ' 个模型 · ' + scenes.length + ' 个场景', 'ok');
    }

    async function openImportMenu() {
      const pick = await window.Confirm.choose({
        title: '导入',
        options: [
          { value: 'scene', label: '导入场景 .json', hint: '放进当前白模库' },
          { value: 'model', label: '导入模型到当前白模库 .json', hint: st.library || '先选库' },
          { value: 'scenePack', label: '导入场景组包 .json', hint: '当前库' },
          { value: 'libraryPack', label: '导入白模库包 .json', hint: '新建库' },
          { value: '3d', label: '导入 3D 文件到当前场景', hint: 'FBX / OBJ / GLB / GLTF' },
        ],
      });
      if (!pick) return;
      if (pick === '3d') { const f = $('mmFile3d'); if (f) f.click(); return; }
      const f = pick === 'scene' ? $('mmFileSceneJson') : pick === 'model' ? $('mmFileModelJson') : $('mmFileJson');
      if (f) f.click();
    }

    async function openExportMenu() {
      const entities = selectedEntities();
      const groupName = st.sceneGroup || '全部';
      const pick = await window.Confirm.choose({
        title: '导出范围',
        options: [
          { value: 'entity', label: entities.length === 1 ? '当前实体：' + (entities[0].name || '实体') : '当前实体（先选一个）', hint: '模型 .json' },
          { value: 'scene', label: '当前场景：' + ((st.doc && st.doc.name) || '未命名'), hint: '场景 .json' },
          { value: 'group', label: '当前场景组：' + groupName, hint: (st.sceneGroups || []).find(g => g.name === st.sceneGroup) ? '包内场景' : '未分组场景' },
          { value: 'library', label: '当前白模库：' + (st.library || '未选'), hint: '模型 + 场景' },
        ],
      });
      if (!pick) return;
      if (pick === 'entity') exportCurrentEntity();
      else if (pick === 'scene') exportCurrentScene();
      else if (pick === 'group') exportSceneGroup();
      else exportLibraryPack();
    }

    /* ---------------- 装配 ---------------- */
    function paintAll() {
      paintRailTabs();
      paintLib();
      paintScenes();
      paintTree();
      paintCams();
      paintTools();
      paintSide();
      paintDock();
      paintOut();
      refreshPhead();
    }

    /* 状态行只有一处（轨道坞那条横带里）：两档右栏来回切也不会把回执弄丢 */
    function note(text, kind) {
      st.note = String(text || '');
      st.noteKind = kind || '';
      const host = $('mmSay') || (pageEl.value && pageEl.value.querySelector('[data-dock="say"]'));
      if (host) {
        host.textContent = st.note;
        host.className = 'mm-dock-note' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
      }
      if (kind === 'err' && window.Toast) window.Toast.err(st.note);
    }

    async function importAnyJson(file) {
      if (!file) return;
      try {
        const raw = await Vault.readJsonFile(file);
        if (raw.kind === 'library-pack') { await importLibraryPack(raw); return; }
        if (raw.kind === 'scene-pack') { await importScenePack(raw); return; }
        if (raw.kind === 'scene') { await importSceneFile(file); return; }
        await importModelFile(file);
      } catch (e) { note('导入失败：' + window.errText(e), 'err'); }
    }

    async function boot() {
      if (built) return;
      built = true;
      try {
        if (!window.Api || !window.AssetLocal) throw new Error('公共模块没就绪');
        mountView();
        st.railTab = window.LS.get('sk_model_rail', 'scene') === 'lib' ? 'lib' : 'scene';
        st.sideTab = ['ai', 'props', 'cam'].includes(window.LS.get('sk_model_side', 'ai')) ? window.LS.get('sk_model_side', 'ai') : 'ai';
        st.outOpen = window.LS.get('sk_model_out_open', '1') !== '0';
        initDock();
        st.doc = blankScene('未命名场景');
        st.docLibrary = '';
        st.savedDigest = '';
        st.selectedId = '';
        st.selectedCam = '';
        view.setDoc(st.doc, { refit: true, resetTime: true });
        if (window.Dropdowns) window.Dropdowns.build(pageEl.value);
        if (window.fillIcons) window.fillIcons(pageEl.value);
        bindChrome();
        setRailTab(st.railTab);
        paintAll();
        await loadLibraries();
        await consumeHandoff();
      } catch (e) {
        console.error('[model] 启动失败：', e);
        if (window.PageReport) window.PageReport.pageFail('建模台', String(window.errText(e)), e);
        note('启动失败：' + window.errText(e), 'err');
      }
    }

    function refImageOf(file) {
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve({
          label: file.name || '图片',
          src: String(reader.result || ''),
        });
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    async function addRefImages(files) {
      const list = Array.from(files || []).filter(f => /^image\//i.test(String(f.type || '')) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(String(f.name || '')));
      if (!list.length) { note('只收图片文件', 'err'); return; }
      const made = (await Promise.all(list.map(refImageOf))).filter(Boolean);
      st.refImages = st.refImages.concat(made);
      if (made.length) { paintSide(); note('已加入 ' + made.length + ' 张图片', 'ok'); }
    }

    function bindChrome() {
      $('mmSave').onclick = () => save(false);
      $('mmSaveAs').onclick = () => save(true);
      $('mmImport').onclick = () => openImportMenu();
      $('mmExport').onclick = () => openExportMenu();
      $('mmSearch').oninput = e => { st.search = e.target.value; paintLib(); };

      const f3d = $('mmFile3d');
      f3d.onchange = async () => {
        const file = f3d.files && f3d.files[0];
        f3d.value = '';
        await import3DFile(file);
      };
      const fmodel = $('mmFileModelJson');
      fmodel.onchange = async () => {
        const file = fmodel.files && fmodel.files[0];
        fmodel.value = '';
        await importModelFile(file);
      };
      const fscene = $('mmFileSceneJson');
      fscene.onchange = async () => {
        const file = fscene.files && fscene.files[0];
        fscene.value = '';
        await importSceneFile(file);
      };
      const fjson = $('mmFileJson');
      fjson.onchange = async () => {
        const file = fjson.files && fjson.files[0];
        fjson.value = '';
        await importAnyJson(file);
      };
      const fimg = $('mmImgInput');
      fimg.onchange = async () => {
        const files = fimg.files;
        fimg.value = '';
        await addRefImages(files);
      };
      const side = $('mmSideBody');
      side.ondragover = e => {
        if (!Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      };
      side.ondrop = async e => {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        e.preventDefault();
        await addRefImages(files);
      };
      side.onpaste = e => {
        const files = e.clipboardData && e.clipboardData.files;
        if (!files || !files.length) return;
        e.preventDefault();
        addRefImages(files);
      };
    }

    /* 从工作台 / 导演台带过来的那一句（bridge 写的口袋）：填进提示词并直接开跑 */
    async function consumeHandoff() {
      const M = window.Model3D;
      if (!M || !M.consume) return;
      let box = null;
      try { box = M.consume('model'); } catch (e) { box = null; }
      if (!box) return;
      st.origin = box.origin || (box.from ? {
        page: box.from === 'director' ? 'director' : 'studio',
        type: box.type || 'image',
        shot: box.shot || '',
      } : null);
      st.prompt = box.prompt || '';
      st.refImages = (Array.isArray(box.images) ? box.images : []).map((x, i) => ({
        label: x.label || x.name || ('参考图 ' + (i + 1)),
        src: window.Api.mediaSrc ? window.Api.mediaSrc(x.url || x.src || '') : (x.url || x.src || ''),
      })).filter(x => x.src);
      if (!st.library) {
        await loadLibraries();
        if (st.libraries.length) await loadLibrary(st.libraries[0].id);
      }
      if (!st.library) { note('还没有白模库，先建一个再生成实体', 'err'); return; }
      if (!st.doc || st.docLibrary !== st.library) await createScene();
      paintSide();
      const from = box.from === 'director' ? '导演台' : box.from === 'studio' ? '工作台' : '别的页面';
      note('已从' + from + '带入这一句' + (st.refImages.length ? '和 ' + st.refImages.length + ' 张参考图' : '') + '，正在生成实体…');
      await generate();
    }

    onMounted(async () => { await nextTick(); await boot(); });
    onActivated(() => {
      active.value = true;
      if (view) { view.setActive(() => active.value); view.invalidate(); }
      if (built && st.library) loadLibrary(st.library);
      /* 第二次以后进来也要能接住口袋：工作台 → 建模 → 工作台 → 建模是常走的一条路 */
      if (built) consumeHandoff().catch(e => note('带入失败：' + window.errText(e), 'err'));
    });
    onDeactivated(() => {
      active.value = false;
      stopStreamSoon();
      if (view) { view.playing = false; view.setActive(() => false); }
      if (dock) dock.pause();
    });
    onBeforeUnmount(() => {
      disposed = true;
      stopStreamSoon();
      if (dock) { dock.destroy(); dock = null; }
      Loader.clearAssetCache();
      if (view) { view.dispose(); view = null; }
      disposeAllCaches();
    });
    void disposed;

    return { pageEl };
  },
  render,
};
