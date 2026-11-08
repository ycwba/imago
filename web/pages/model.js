/* 建模台 —— 第八页。一句话让文字 AI 写出一棵参数化零件树（白膜），
   在 three 视口里流式长出来；模型存成库根下的真文件、按组管理；出图 / 出片进本机资产库，
   可回传给工作台 / 导演台当参考。

   页面形态与导演台同一副：整页不滚，页头 + 三栏（库 / 视口 / 右栏），底部一条轨道坞。
   内部一律命令式（库卡片、视口、对象树、时间线都是脚本灌 innerHTML）——
   这些节点会被反复重画、要保住滚动位与选中态，做成 Vue 组件反而要跟渲染时机打架
   （导演台是同一句结论：外壳是 Vue，内部按域拆成命令式模块）。Vue 只当页面壳。 */
import { ref, onMounted, onActivated, onDeactivated, onBeforeUnmount, nextTick } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/model.js';
import { createView, sizeOfAspect } from '../model3d/view.js';
import { disposeAllCaches } from '../model3d/scene.js';
import * as S from '../model3d/schema.js';
import * as Vault from '../model3d/vault.js';
import * as AI from '../model3d/ai.js';
import * as Capture from '../model3d/capture.js';
import * as Loader from '../model3d/loader.js';
import { resolveRefs } from '../model3d/dsl.js';
import { clipNamesOf, clipOf } from '../model3d/clip.js';
import { BODY_PRESETS, POSE_PRESETS } from '../model3d/mannequin.js';

const PAGE_FILE = 'model.html';
const D2R = Math.PI / 180;
const GIZMO_MODES = [{ id: 'translate', label: '移动' }, { id: 'rotate', label: '旋转' }, { id: 'scale', label: '缩放' }];
const ASPECTS = ['16:9', '9:16', '1:1', '4:3'];
const REUSE_MODES = [
  { id: 'group', label: '当前组' },
  { id: 'all', label: '全部组' },
  { id: 'off', label: '不启用' },
];

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
      savedId: '',            // 已存过的那一份 id（`组/名`）；空 = 还没落过盘
      savedDigest: '',        // 用来判「有没有改动」
      selectedId: '',
      tab: 'ai',              // ai | scene
      groupFilter: '',        // '' = 全部；'__none' = 未分组；其它 = 组名
      search: '',
      lib: { groups: [], models: [], dir: '' },
      busy: '',
      reuseMode: 'group',
      shortEdge: 720,
      videoSeconds: 3,
      lastShot: null,
      note: '',
      showRig: true,          // 相机标识（视锥）显示开关；页面偏好，不进 doc
      aiText: '',             // 上一轮 AI 的说明（生成结束后留在面板上）
      aiSay: '',              // 正在流式输出的那一句（边收边显示）
      aiRaw: '',              // AI 的原始输出（JSON 流，面板里回显尾巴）
      aiCount: 0,             // 流式过程中已收全的零件数
      catalogNote: '',
      previewDoc: null,       // 流式过程中的临时树（不写进 doc，取消就回到原样）
      assets: new Map(),      // 3D 文件 → 已解析原型（loader.js 填；scene 只 clone）
    };
    const assetPending = new Set();   // 正在读的导入件（同一份文件不至于被并发读两次）
    let headTimer = 0;                 // 播放头：只在播放时走，切页 / 暂停就停
    let clipEndKey = '';               // 上一次报过的「播完」那条（同一条只写一次状态行）

    const $ = id => pageEl.value && pageEl.value.querySelector('[data-r="' + id + '"]');
    const refreshPhead = () => {
      const name = $('mmName');
      const dirty = $('mmDirty');
      if (name) name.textContent = (st.doc && st.doc.name) || '未命名白膜';
      if (dirty) {
        const isDirty = st.doc && S.digest(st.doc) !== st.savedDigest;
        dirty.textContent = !st.savedId ? '新建' : (isDirty ? '有改动' : '已保存');
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
      const isActive = window.__spaActivity ? window.__spaActivity.forPage(PAGE_FILE) : (() => true);
      view.setActive(() => active.value && isActive());
      view.onPick = id => { st.selectedId = id || ''; paintTree(); view.setSelection(st.selectedId); };
      view.onTransform = (id, t) => {
        const node = S.findNode(st.doc.scene.nodes, id);
        if (!node || node.locked) return;
        node.at = t.at; node.rot = t.rot; node.scale = t.scale;
        refreshPhead();
        paintTree();
      };
      view.onCameraChange = () => { /* 导演视角的机位不写回模型：那是「看」的位置，不是作品的一部分 */ };
      /* 建场景时记下的话（超上限 / 没这条动画 / 超预算）落到状态行；同一份 doc 只报一次 */
      view.onNotes = notes => { if (notes && notes.length) note(notes.slice(0, 3).join('；'), 'err'); };
    }

    /* ---------------- 库 ---------------- */
    async function loadLib() {
      try {
        const d = await Vault.list();
        st.lib = d;
      } catch (e) {
        st.lib = { groups: [], models: [], dir: '' };
        note('库读不出来：' + window.errText(e), 'err');
      }
      paintLib();
    }

    function visibleModels() {
      const q = st.search.trim().toLowerCase();
      return (st.lib.models || []).filter(m => {
        if (st.groupFilter === '__none') { if (m.group) return false; }
        else if (st.groupFilter && m.group !== st.groupFilter) return false;
        if (!q) return true;
        return (m.id + ' ' + (m.name || '')).toLowerCase().indexOf(q) >= 0;
      });
    }

    function paintLib() {
      const groupsHost = $('mmGroups');
      const grid = $('mmCards');
      if (!groupsHost || !grid) return;
      const counts = new Map();
      for (const m of st.lib.models || []) {
        const g = m.group || '__none';
        counts.set(g, (counts.get(g) || 0) + 1);
      }
      const chips = [{ v: '', t: '全部 ' + (st.lib.models || []).length }]
        .concat((st.lib.groups || []).map(g => ({ v: g.name, t: g.name + ' ' + g.count })))
        .concat(counts.get('__none') ? [{ v: '__none', t: '未分组 ' + counts.get('__none') }] : []);
      if (window.Chips) {
        window.Chips.render(groupsHost, chips.map(c => [c.v, c.t]), st.groupFilter, v => {
          st.groupFilter = v;
          paintLib();
        });
      }

      const rows = visibleModels();
      if (!rows.length) {
        grid.innerHTML = '<div class="mm-empty">'
          + ((st.lib.models || []).length ? '这个筛选下没有模型' : '还没有白膜。<br>用右边那栏说一句话，或者点下面「新建 / 导入」。')
          + '</div>';
        return;
      }
      grid.innerHTML = rows.map(m => {
        const thumb = Vault.thumbUrl(m);
        const on = st.savedId === m.id;
        return '<button class="mm-card' + (on ? ' on' : '') + '" type="button" data-id="' + esc(m.id) + '">'
          + (thumb
            ? '<img class="mm-card-thumb" src="' + esc(thumb) + '" alt="" loading="lazy">'
            : '<span class="mm-card-thumb empty">' + ic('box', 16) + '</span>')
          + '<span class="mm-card-main"><span class="mm-card-t">' + esc(m.name) + '</span>'
          + '<span class="mm-card-s">' + esc(m.group || '未分组') + ' · ' + Math.max(0, Math.round((m.bytes || 0) / 1024)) + ' KB</span></span>'
          + '</button>';
      }).join('');
    }

    /* ---------------- 打开 / 新建 / 保存 ---------------- */
    async function openModel(id) {
      try {
        const raw = await Vault.read(id);
        const out = S.normalizeDoc(raw);
        st.doc = out.doc;
        st.savedId = id;
        st.savedDigest = S.digest(out.doc);
        st.selectedId = '';
        st.previewDoc = null;
        await applyRefs();
        await syncAssets();
        view.setDoc(st.doc, { refit: true });
        view.setSelection('');
        paintAll();
        if (out.dropped && (out.dropped.bad || out.dropped.extra || out.dropped.anim)) {
          note('载入时有 ' + (out.dropped.bad + out.dropped.extra + out.dropped.anim) + ' 个零件读不出来，已经跳过', 'err');
        }
      } catch (e) {
        note('打开失败：' + window.errText(e), 'err');
      }
    }

    /* 引用（`ref`）要先把被引用的模型读进来铺平：这一层是异步的，所以放在进场景之前 */
    async function applyRefs() {
      if (!st.doc) return;
      const hasRef = (() => { let hit = false; S.walkNodes(st.doc.scene.nodes, n => { if (n.kind === 'ref') hit = true; }); return hit; })();
      if (!hasRef) return;
      const r = await resolveRefs(st.doc.scene.nodes, async id => S.normalizeDoc(await Vault.read(id)).doc);
      st.doc.scene.nodes = r.nodes;
      if (r.notes.length) note(r.notes.slice(0, 3).join('；'), 'err');
    }

    /* 摆件：文件读进来才有得 clone。读好一份就重建一次 —— 用户看到的是「摆件一个个到位」，
       而不是等所有文件都读完才一起出现；读不出来的照实说，不影响别的摆件。 */
    async function syncAssets() {
      if (!st.doc) return;
      const todo = Loader.filesOf(st.doc.scene.nodes)
        .filter(f => !st.assets.has(f) && !assetPending.has(f));
      for (const f of todo) {
        assetPending.add(f);
        try {
          st.assets.set(f, await Loader.load(f));
          /* 文件到位的这一刻 clip 名单才知道：摆件卡与轨道坞跟着换一次，
             否则卡上会一直停在「这个文件里没有动画」。 */
          if (st.doc) { paintProps(); paintDock(); }
          if (view && st.doc) view.setDoc(st.doc, {});
        } catch (e) {
          note('摆件读不出来（' + f + '）：' + window.errText(e), 'err');
        } finally {
          assetPending.delete(f);
        }
      }
    }

    function blankDoc(name) {
      const doc = S.emptyDoc(name || '未命名白膜', st.groupFilter && st.groupFilter !== '__none' ? st.groupFilter : '');
      doc.scene.nodes.push({ kind: 'mannequin', id: S.newId('m'), name: '素体', body: 'mannequin', pose: 'stand', at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], tone: 'hi' });
      doc.scene.nodes.push({ kind: 'prim', id: S.newId('p'), name: '地台', shape: 'box', size: [3, 0.06, 3], at: [0, -0.03, 0], rot: [0, 0, 0], scale: [1, 1, 1], tone: 'mid' });
      return doc;
    }

    function newDoc(name) {
      st.doc = blankDoc(name);
      st.savedId = '';
      st.savedDigest = '';
      st.selectedId = st.doc.scene.nodes[0].id;
      view.setDoc(st.doc, { refit: true });
      view.setSelection(st.selectedId);
      paintAll();
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

    async function save(saveAs) {
      if (!st.doc || st.busy) return;
      let name = st.doc.name;
      let group = st.doc.group;
      if (saveAs) {
        const v = await window.PromptForm.open({
          title: '另存为',
          sub: '组可以留空；下划线开头的组名留给导入的 3D 文件',
          okLabel: '保存',
          fields: [
            { key: 'name', label: '名字', type: 'text', value: name, placeholder: '例：奔跑的少女', required: true },
            { key: 'group', label: '组（可留空）', type: 'text', value: group, placeholder: '例：角色' },
          ],
        });
        if (!v) return;
        name = Vault.cleanName(v.name);
        group = Vault.cleanGroup(v.group);
      }
      if (!name) { note('名字不能是空的', 'err'); return; }
      if (group.startsWith('_')) { note('组名不能以下划线开头（下划线目录留给导入的 3D 文件）', 'err'); return; }
      st.busy = 'save';
      note('正在保存…');
      try {
        st.doc.name = name;
        st.doc.group = group;
        const thumb = await thumbB64();
        const r = await Vault.save({ id: st.savedId || '', name, group, model: st.doc, thumb });
        st.savedId = r.id;
        st.savedDigest = S.digest(st.doc);
        refreshPhead();
        await loadLib();
        note('已保存：' + r.id, 'ok');
      } catch (e) {
        note('保存失败：' + window.errText(e), 'err');
      } finally {
        st.busy = '';
      }
    }

    async function renameCurrent() {
      if (!st.savedId) { note('先保存一次再改名', 'err'); return; }
      const cur = Vault.splitId(st.savedId);
      const v = await window.PromptForm.open({
        title: '改名 / 移组',
        okLabel: '改',
        fields: [
          { key: 'name', label: '名字', type: 'text', value: cur.name, required: true },
          { key: 'group', label: '组（留空 = 未分组）', type: 'text', value: cur.group },
        ],
      });
      if (!v) return;
      const name = Vault.cleanName(v.name);
      const group = Vault.cleanGroup(v.group);
      if (!name) { note('名字不能是空的', 'err'); return; }
      try {
        st.doc.name = name;
        st.doc.group = group;
        const r = await Vault.save({ id: st.savedId, name, group, model: st.doc });
        st.savedId = r.id;
        st.savedDigest = S.digest(st.doc);
        await loadLib();
        refreshPhead();
        note('已改为：' + r.id, 'ok');
      } catch (e) {
        note('改名失败：' + window.errText(e), 'err');
      }
    }

    async function removeCurrent() {
      if (!st.savedId) { note('这一份还没存过，没有可删的文件', 'err'); return; }
      const ok = await window.Confirm.ask({
        title: '删除这份白膜？',
        body: '会把库根下的「白膜/' + st.savedId + '.json」连同缩略图一起删掉，退不回来。'
          + '已经生成的白膜图片 / 视频还在资产库里。',
        danger: true,
        okLabel: '删除',
      });
      if (!ok) return;
      try {
        await Vault.remove(st.savedId);
        note('已删除：' + st.savedId, 'ok');
        st.savedId = '';
        st.savedDigest = '';
        await loadLib();
        refreshPhead();
      } catch (e) {
        note('删除失败：' + window.errText(e), 'err');
      }
    }

    /* ---------------- 右栏：AI ---------------- */
    function aiCatalogText() {
      if (st.reuseMode === 'off') return '（这次不参考历史白膜，一律建新的）';
      const list = (st.lib.models || []).filter(m => st.reuseMode === 'all' || !st.doc.group || m.group === st.doc.group);
      return AI.catalogText(list, 40);
    }

    /* 库里有动画的摆件：只从这次会话里已经解析过的文件来（不在生成前扫盘 —— 解析一遍大 FBX 要几秒）。
       没打开过的文件不会出现在清单里，AI 就用不了它的 clip，但也不会编一个不存在的名字。 */
    function aiAnimations() {
      return Array.from(st.assets, ([file, entry]) => ({ file, clips: clipNamesOf(entry) }))
        .filter(it => it.clips.length);
    }

    async function generate() {
      const prompt = ($('mmPrompt') && $('mmPrompt').value || '').trim();
      if (!prompt) { note('先写一句要建什么', 'err'); return; }
      if (st.busy) return;
      st.busy = 'ai';
      st.aiText = '';
      st.aiSay = '';
      st.aiRaw = '';
      st.aiCount = 0;
      note('正在生成…');
      paintSide();
      const ctl = new AbortController();
      st.aiCtl = ctl;
      const base = st.doc ? S.cloneDoc(st.doc) : null;
      try {
        const r = await AI.run({
          prompt,
          doc: st.previewDoc || base,
          catalog: aiCatalogText(),
          animations: aiAnimations(),
          aspect: view ? view.aspect : ((st.doc && st.doc.scene.view.aspect) || '16:9'),
          signal: ctl.signal,
          onNodes: nodes => {
            /* 流式预览：每收全一批节点就重建一次场景（相机不动，人眼看着模型长出来） */
            const draft = base ? S.cloneDoc(base) : S.emptyDoc('生成中');
            const out = S.normalizeDoc({ scene: { nodes, camera: (base && base.scene.camera) || draft.scene.camera, view: draft.scene.view } });
            draft.scene.nodes = out.doc.scene.nodes;
            st.previewDoc = draft;
            if (view) { view.setDoc(draft, {}); }
          },
          onSay: t => { st.aiSay = t; paintStreamSoon(); },
          onText: (text, count) => { st.aiRaw = text; st.aiCount = count; paintStreamSoon(); },
        });
        if (r.reuse && r.reuse.mode === 'as-is') {
          st.previewDoc = null;
          await openModel(r.reuse.id);
          note('沿用了历史白膜「' + r.reuse.id + '」' + (r.reuse.why ? '：' + r.reuse.why : ''), 'ok');
          return;
        }
        if (!r.doc) { st.previewDoc = null; if (view && st.doc) view.setDoc(st.doc, {}); note(r.why || '这一轮没有可用的模型', 'err'); return; }
        st.doc = r.doc;
        st.previewDoc = null;
        st.selectedId = '';
        st.savedDigest = '';
        await syncAssets();                 // AI 可能引用了一个已导入的摆件
        if (view) view.setDoc(st.doc, { refit: true });
        paintAll();
        const wrote = r.note || ('建了 ' + S.countNodes(st.doc) + ' 个零件');
        const reused = r.reuse && r.reuse.mode === 'base' ? '（以「' + r.reuse.id + '」为底稿）' : '';
        const dropped = r.dropped ? (r.dropped.bad + r.dropped.extra) : 0;
        st.aiText = r.say || '';            // 收完把 AI 那句话留在面板上（「上一轮：…」）
        note(wrote + reused + (dropped ? '；丢了 ' + dropped + ' 个零件' : ''), dropped ? 'err' : 'ok');
        archivePrompt(prompt);
      } catch (e) {
        st.previewDoc = null;
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

    /* 实体类别：树里显示的徽标。这里不把「人台」当特殊品类叫「角色」——
       一切进场景的东西都是**实体**，人台只是其中一种；隐藏 / 锁定对人台、图元、
       摆件、组一视同仁（不是只有角色才配）。 */
    const KIND_CN = { group: '组', prim: '图元', mannequin: '人台', crowd: '群像', asset: '摆件', ref: '引用' };
    const kindIcon = n => (n.kind === 'mannequin' || n.kind === 'crowd') ? 'users'
      : n.kind === 'prim' ? 'box' : n.kind === 'asset' ? 'image' : 'list';

    function paintTree() {
      const host = $('mmTree');
      if (!host || !st.doc) return;
      const rows = [];
      const paintRow = (list, depth) => {
        for (const n of list) {
          const hidden = n.visible === false;
          const locked = !!n.locked;
          rows.push('<div class="mm-tree-row' + (st.selectedId === n.id ? ' on' : '')
            + (hidden ? ' off' : '') + (locked ? ' lk' : '')
            + '" data-id="' + esc(n.id) + '" role="button" tabindex="0" style="padding-left:' + (4 + depth * 10) + 'px">'
            + '<span class="ic">' + ic(kindIcon(n), 12) + '</span>'
            + '<span class="nm">' + esc(nodeLabel(n)) + '</span>'
            + (n.kind === 'asset' && n.clip ? '<span class="mm-tree-anim" title="带动画：' + esc(n.clip) + '">' + ic('speaker', 11) + '</span>' : '')
            + '<span class="mini">' + esc(KIND_CN[n.kind] || n.kind) + '</span>'
            + '<button class="mm-tree-mini' + (hidden ? ' on' : '') + '" type="button" data-tov="' + esc(n.id)
            + '" title="' + (hidden ? '显示' : '隐藏') + '" aria-pressed="' + (hidden ? 'true' : 'false') + '">'
            + ic(hidden ? 'eyeOff' : 'eye', 12) + '</button>'
            + '<button class="mm-tree-mini' + (locked ? ' on' : '') + '" type="button" data-lock="' + esc(n.id)
            + '" title="' + (locked ? '解锁' : '锁定') + '" aria-pressed="' + (locked ? 'true' : 'false') + '">'
            + ic('lock', 12) + '</button></div>');
          if (n.children) paintRow(n.children, depth + 1);
        }
      };
      paintRow(st.doc.scene.nodes, 0);
      host.innerHTML = rows.join('') || '<div class="mm-empty">这个模型还没有实体</div>';
      host.onclick = e => {
        const tv = e.target.closest('[data-tov]');
        if (tv) { toggleVisible(tv.dataset.tov); return; }
        const lk = e.target.closest('[data-lock]');
        if (lk) { toggleLocked(lk.dataset.lock); return; }
        const b = e.target.closest('[data-id]');
        if (!b) return;
        st.selectedId = b.dataset.id;
        view.setSelection(st.selectedId);
        paintTree();
        paintProps();
      };
      host.onkeydown = e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const b = e.target.closest('[data-id]');
        if (!b || e.target.closest('[data-tov],[data-lock]')) return;
        e.preventDefault();
        st.selectedId = b.dataset.id;
        view.setSelection(st.selectedId);
        paintTree();
        paintProps();
      };
    }

    /* 任意实体都能隐藏 / 锁定。
       隐藏只影响渲染（树里还在、面板里还能改回来）；锁定只影响交互
       （视口点不中、不挂变换手柄、数值框只读），不改变它在场景里的样子。 */
    function toggleVisible(id) {
      const n = S.findNode(st.doc.scene.nodes, id);
      if (!n) return;
      n.visible = n.visible === false;
      if (view) view.setDoc(st.doc, {});
      paintTree();
      paintProps();
      note((n.visible === false ? '已隐藏「' : '已显示「') + nodeLabel(n) + '」', 'ok');
    }

    function toggleLocked(id) {
      const n = S.findNode(st.doc.scene.nodes, id);
      if (!n) return;
      n.locked = !n.locked;
      if (view) view.setSelection(st.selectedId);      // 锁上就当场摘手柄
      paintTree();
      paintProps();
      note((n.locked ? '已锁定「' : '已解锁「') + nodeLabel(n) + '」', 'ok');
    }

    function numInput(key, value, step, ro) {
      return '<input class="ui-inp" type="number" step="' + (step || '0.01') + '" data-prop="' + key + '" value="' + (Number(value) || 0) + '"' + (ro ? ' disabled' : '') + '>';
    }

    function paintProps() {
      const host = $('mmProps');
      if (!host) return;
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
        html += '<div class="mm-row"><label>形状</label><input class="ui-inp" value="' + esc(node.shape) + '" disabled></div>';
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
        const b = e.target.closest('[data-act="delNode"]');
        if (!b) return;
        S.removeNode(st.doc.scene.nodes, node.id);
        st.selectedId = '';
        refreshPhead();
        view.setDoc(st.doc, {});
        paintTree();
        paintProps();
      };
    }

    function applyProp(node, key, raw) {
      if (key === 'name') node.name = String(raw).slice(0, 24);
      else if (key === 'visible') node.visible = raw !== false;
      else if (key === 'locked') node.locked = raw === true;
      else if (key === 'clay') node.clay = raw !== false;
      else if (key === 'clip') node.clip = String(raw == null ? '' : raw).slice(0, 40);
      else if (key === 'clipSpeed') node.clipSpeed = Math.max(0.1, Math.min(4, Number(raw) || 1));
      else if (key === 'clipLoop') node.clipLoop = S.CLIP_LOOPS.includes(raw) ? raw : 'loop';
      else if (key === 'clipOffset') node.clipOffset = Math.max(0, Math.min(60, Number(raw) || 0));
      else if (key === 'body') node.body = String(raw);
      else if (key === 'pose') node.pose = String(raw);
      else if (key === 'tone') node.tone = ['hi', 'mid', 'lo'].includes(raw) ? raw : 'hi';
      else if (key === 'rows' || key === 'cols') node[key] = Math.max(1, Math.min(20, Math.round(Number(raw) || 1)));
      else if (key === 'gapX' || key === 'gapZ') node[key] = Math.max(0.3, Math.min(6, Number(raw) || 0.9));
      else if (key === 'jitter') node.jitter = Math.max(0, Math.min(2, Number(raw) || 0));
      else if (/^(at|rot|scale)\.\d$/.test(key)) {
        const [k, i] = key.split('.');
        node[k][Number(i)] = Number(raw) || 0;
        if (k === 'scale') node.scale[Number(i)] = Math.max(0.01, node.scale[Number(i)]);
      }
      refreshPhead();
      view.setDoc(st.doc, {});
      paintTree();
      /* 显示 / 锁定会改这一格自己的开关与只读态，得跟着重画（其余输入框不重画，
         免得正在敲数字时被换掉） */
      if (key === 'visible' || key === 'locked') paintProps();
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
        + ['ai', 'scene'].map(t => '<button type="button" class="' + (st.tab === t ? 'on' : '') + '" data-tab="' + t + '">'
          + (t === 'ai' ? 'AI 建模' : '场景') + '</button>').join('') + '</div>';
      tabs.onclick = e => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        st.tab = b.dataset.tab;
        paintSide();
      };

      if (st.tab === 'ai') {
        const reuseChips = REUSE_MODES.map(m => '<button class="chip' + (st.reuseMode === m.id ? ' on' : '') + '" type="button" data-reuse="' + m.id + '">' + m.label + '</button>').join('');
        body.innerHTML =
          '<div class="mm-field"><label>要建什么（一句话就行）</label>'
          + '<textarea class="ui-inp mm-prompt" data-r="mmPrompt" placeholder="例：一个穿长外套的少女在走，前面有一张矮桌">' + esc(st.prompt || '') + '</textarea></div>'
          + '<div class="mm-row"><span class="sp"></span>'
          + (st.busy === 'ai'
            ? '<button class="ghost" type="button" data-act="stop">' + ic('pause', 12) + ' 停止</button>'
            : '<button class="pri" type="button" data-act="gen">' + ic('sparkles', 13) + ' ' + (st.doc && S.countNodes(st.doc) ? '继续改' : '生成') + '</button>')
          + '</div>'
          + (st.busy === 'ai'
            ? '<div class="mm-stream" data-r="mmStream">'
              + '<div class="mm-stream-say wait" data-r="mmStreamSay">正在想…</div>'
              + '<div class="mm-stream-meta" data-r="mmStreamMeta"></div>'
              + '<div class="mm-stream-raw" data-r="mmStreamRaw"></div>'
              + '</div>'
            : '')
          + '<div class="mm-field"><label>复用历史白膜</label><div class="mm-groups">' + reuseChips + '</div></div>'
          + (st.aiText ? '<div class="mm-note">上一轮：' + esc(st.aiText) + '</div>' : '')
          + '<div class="mm-empty">生成过程会边收边建：模型在中间那块视口里一个零件一个零件长出来。'
          + '改模型就在上面那句话里说「把外套改成斗篷」这种，AI 会照着当前这棵树改。</div>';
        body.onclick = e => {
          const stop = e.target.closest('[data-act="stop"]');
          if (stop) { if (st.aiCtl) st.aiCtl.abort(); return; }
          const gen = e.target.closest('[data-act="gen"]');
          if (gen) { generate(); return; }
          const r = e.target.closest('[data-reuse]');
          if (r) { st.reuseMode = r.dataset.reuse; paintSide(); }
        };
        body.oninput = e => {
          const ta = e.target.closest('[data-r="mmPrompt"]');
          if (ta) st.prompt = ta.value;
        };
        return;
      }

      body.innerHTML =
        '<div class="mm-field"><label>实体（任意一个都能隐藏 / 锁定）</label><div class="mm-tree" data-r="mmTree"></div></div>'
        + '<div class="mm-field"><label>选中的零件</label><div data-r="mmProps"></div></div>'
        + '<div class="mm-field"><label>机位（机位视角用的那一台）</label><div data-r="mmCam"></div></div>'
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
      paintTree();
      paintProps();
      paintCam();
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

    function paintCam() {
      const host = $('mmCam');
      if (!host || !st.doc) return;
      const c = st.doc.scene.camera;
      host.innerHTML =
        '<div class="mm-num3">' + numInput('cam.pos.0', c.pos[0]) + numInput('cam.pos.1', c.pos[1]) + numInput('cam.pos.2', c.pos[2]) + '</div>'
        + '<div class="mm-num3" style="margin-top:var(--sp-4)">' + numInput('cam.target.0', c.target[0]) + numInput('cam.target.1', c.target[1]) + numInput('cam.target.2', c.target[2]) + '</div>'
        + '<div class="mm-row" style="margin-top:var(--sp-4)"><label>机位预设</label>' + numInput('cam.fov', c.fov, 1)
        + '<button class="ghost mini" type="button" data-shot="near">近景</button>'
        + '<button class="ghost mini" type="button" data-shot="mid">中景</button>'
        + '<button class="ghost mini" type="button" data-shot="wide">全景</button></div>';
      host.onchange = e => {
        const f = e.target.closest('[data-prop]');
        if (!f) return;
        const k = f.dataset.prop;
        const v = Number(f.value) || 0;
        if (k === 'cam.fov') st.doc.scene.camera.fov = Math.max(10, Math.min(120, v));
        else {
          const [, key, i] = k.split('.');
          st.doc.scene.camera[key][Number(i)] = v;
        }
        refreshPhead();
        view.setDoc(st.doc, {});
      };
      host.onclick = e => {
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
        const v = Number(f.value) || 0;
        if (f.dataset.prop === 'pano.yaw') p.yaw = Math.max(-360, Math.min(360, v));
        else p.radius = Math.max(5, Math.min(200, v));
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
      const c = st.doc.scene.camera;
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
      refreshPhead();
      view.setDoc(st.doc, {});
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
      host.innerHTML =
        '<div class="ui-seg" data-g="gizmo">' + GIZMO_MODES.map(m => '<button type="button" class="' + (st.gizmo === m.id ? 'on' : '') + '" data-v="' + m.id + '">' + m.label + '</button>').join('') + '</div>'
        + '<div class="ui-seg" data-g="view">'
        + '<button type="button" class="' + (v.mode === 'director' ? 'on' : '') + '" data-v="director">导演视角</button>'
        + '<button type="button" class="' + (v.mode === 'camera' ? 'on' : '') + '" data-v="camera">机位视角</button></div>'
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
          if (group === 'gizmo') { st.gizmo = val; view.setGizmoMode(val); }
          if (group === 'view') { st.doc.scene.view.mode = val; view.setViewMode(val); }
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
        st.lastShot = a;
        note('已出图：' + a.name + '（已存进本机资产库）', 'ok');
        paintResult();
      } catch (e) {
        note('出图失败：' + window.errText(e), 'err');
      } finally {
        st.busy = '';
      }
    }

    async function doRecord() {
      if (!view || st.busy) return;
      st.busy = 'record';
      note('正在出片（' + st.videoSeconds + ' 秒）…');
      try {
        const a = await Capture.record(view, {
          doc: st.doc,
          shortEdge: st.shortEdge,
          duration: st.videoSeconds,
          prompt: promptText(),
          onProgress: p => { if (p && p.msg) note(p.msg + (p.progress ? '（' + p.progress + '%）' : '')); },
        });
        st.lastShot = a;
        note('已出片：' + a.name + '（已存进本机资产库）', 'ok');
        paintResult();
      } catch (e) {
        note((e && e.name === 'AbortError' ? '已取消' : '出片失败：' + window.errText(e)), 'err');
      } finally {
        st.busy = '';
      }
    }

    const promptText = () => (st.prompt || '').trim() || ($('mmPrompt') ? $('mmPrompt').value.trim() : '') || st.doc.name || '';

    function paintResult() {
      const host = $('mmResult');
      if (!host) return;
      const a = st.lastShot;
      if (!a) { host.innerHTML = ''; return; }
      host.innerHTML = '<div class="mm-note ok">刚出的这一份：' + esc(a.name) + '</div>'
        + '<div class="mm-row"><span class="sp"></span>'
        + '<button class="ghost mini" type="button" data-act="dl">下载</button>'
        + '<button class="ghost mini" type="button" data-act="toStudio">回传工作台</button>'
        + '<button class="ghost mini" type="button" data-act="toDirector">回传导演台</button></div>';
      host.onclick = e => {
        if (e.target.closest('[data-act="dl"]')) { downloadShot(a); return; }
        if (e.target.closest('[data-act="toStudio"]')) { handBack('studio', a); return; }
        if (e.target.closest('[data-act="toDirector"]')) { handBack('director', a); return; }
      };
    }

    async function downloadShot(a) {
      try {
        const blob = await window.Net.blob(a.src);
        window.Net.save(blob, a.name);
      } catch (e) {
        note('下载失败：' + window.errText(e), 'err');
      }
    }

    function handBack(to, asset) {
      if (!window.Model3D || !window.Model3D.handoffTo) { note('回传通道没装上（web/model3d/bridge.js）', 'err'); return; }
      window.Model3D.handoffTo(to, { asset });
      window.GoPage.go(to === 'studio' ? 'studio.html?t=image' : 'director.html');
    }

    /* ---------------- 底部轨道坞 ----------------
       一条轨道 = 一份 anim.tracks 记录（节点 × 时间）。播放头画在每条的条带上（同一格红色竖线），
       点条带即定位；播放时由一颗 80ms 的定时器挪它 —— 三维那边自己按帧走，这里只管「看到第几秒」。 */
    function paintDock() {
      const host = $('mmDock');
      if (!host || !st.doc) return;
      const anim = st.doc.anim;
      const all = [];
      S.walkNodes(st.doc.scene.nodes, n => all.push(n));
      const head = '<div class="mm-dock-head">'
        + '<button class="tool" type="button" data-act="play" title="播放 / 暂停">' + ic(view && view.playing ? 'pause' : 'play', 12) + '</button>'
        + '<span data-r="mmTime">' + timeLabel() + '</span>'
        + '<label class="mm-dock-lab">时长</label><input class="ui-inp mm-dock-num" type="number" min="0.5" max="60" step="0.5" data-anim="duration" value="' + (anim.duration || 4) + '">'
        + '<label class="mm-dock-lab">fps</label><input class="ui-inp mm-dock-num" type="number" min="12" max="60" step="1" data-anim="fps" value="' + (anim.fps || 24) + '">'
        + '<span class="mm-dock-note' + (st.noteKind === 'err' ? ' err' : st.noteKind === 'ok' ? ' ok' : '') + '" data-r="mmSay">' + esc(st.note) + '</span>'
        + '<span class="sp"></span>'
        + '<span class="mm-dock-lab">轨迹</span>'
        + '<button class="ghost mini" type="button" data-path="line">直线</button>'
        + '<button class="ghost mini" type="button" data-path="circle">圆</button>'
        + '<button class="ghost mini" type="button" data-path="rect">矩形</button>'
        + '<button class="ghost mini" type="button" data-act="key">打关键帧</button>'
        + '<button class="ghost mini" type="button" data-act="clearAnim">清空动画</button>'
        + '</div>';
      const rows = anim.tracks.map(tr => {
        const node = all.find(n => n.id === tr.nodeId);
        const keys = (tr.keys || []).map(k => {
          const left = Math.max(0, Math.min(100, (k.t / Math.max(0.1, anim.duration)) * 100));
          return '<span class="mm-key" style="left:' + left + '%" title="' + k.t + 's"></span>';
        }).join('');
        const label = (node ? nodeLabel(node) : '（节点已不在）')
          + (tr.motion ? ' · ' + (tr.motion === 'run' ? '跑' : '走') : '');
        const pathLabel = tr.path ? (tr.path.kind === 'line' ? '直线' : tr.path.kind === 'circle' ? '圆' : '矩形') : '定点';
        return '<div class="mm-track-row" data-track="' + esc(tr.id) + '">'
          + '<span class="mm-track-name" title="' + esc(label + ' · ' + pathLabel) + '">' + esc(label) + '</span>'
          + '<span class="mm-track-bar" data-scrub="' + esc(tr.id) + '" title="' + esc(pathLabel) + '（点一下定位）">'
          + keys + '<span class="mm-playhead"></span></span></div>';
      }).join('');
      /* 导入件的 clip 各占一行：循环的画满整条，播完停的画到它停的那一刻。
         它不是 anim.tracks 里的一条（时间由 mixer 现算），只画色带与播放头。 */
      const dur = Math.max(0.1, anim.duration || 4);
      const clipRows = [];
      S.walkNodes(st.doc.scene.nodes, n => {
        if (n.kind !== 'asset' || !n.clip) return;
        const clip = clipOf(st.assets.get(n.file), n.clip);
        if (!clip) return;
        const speed = Math.max(0.1, Math.min(4, Number(n.clipSpeed) || 1));
        const offset = Math.max(0, Math.min(60, Number(n.clipOffset) || 0));
        const loop = n.clipLoop || 'loop';
        const clipSec = Math.max(0, Number(clip.duration) || 0);
        const endSec = loop === 'loop' ? dur : Math.max(0, clipSec / speed - offset);
        const pct = Math.max(0, Math.min(100, (endSec / dur) * 100));
        const loopZh = loop === 'loop' ? '循环' : '播完停';
        const tip = '动画「' + n.clip + '」 ' + speed.toFixed(1) + '× · ' + loopZh + ' · ' + clipSec.toFixed(1) + ' 秒';
        clipRows.push('<div class="mm-track-row" data-track="' + esc(n.id) + '">'
          + '<span class="mm-track-name" title="' + esc(tip) + '">'
          + '<span class="mm-tree-anim">' + ic('speaker', 11) + '</span>' + esc(nodeLabel(n)) + '</span>'
          + '<span class="mm-track-bar" data-scrub="' + esc(n.id) + '" title="' + esc(tip + '（点一下定位）') + '">'
          + '<span class="mm-clip-band" style="width:' + pct.toFixed(2) + '%"></span>'
          + '<span class="mm-playhead"></span></span></div>');
      });
      const empty = '<div class="mm-dock-empty">还没有动画。点「加走位」给选中的小人排一条走动轨迹，<br>或者用「轨迹 / 打关键帧」自己排，再出片就能看到白膜动画。</div>';
      host.innerHTML = head + '<div class="mm-tracks">'
        + ((rows || clipRows.length) ? rows + clipRows.join('') : empty)
        + '</div>';
      host.onclick = e => {
        if (e.target.closest('[data-act="play"]')) { togglePlay(); return; }
        if (e.target.closest('[data-act="clearAnim"]')) {
          st.doc.anim.tracks = [];
          view.setDoc(st.doc, {});
          refreshPhead();
          paintDock();
          return;
        }
        if (e.target.closest('[data-act="key"]')) { addKeyframe(); return; }
        const pb = e.target.closest('[data-path]');
        if (pb) { applyPathPreset(pb.dataset.path); return; }
        const bar = e.target.closest('[data-scrub]');
        if (bar) { scrubTo(bar, e); return; }
      };
      host.onchange = e => {
        const f = e.target.closest('[data-anim]');
        if (!f) return;
        const v = Number(f.value) || 0;
        if (f.dataset.anim === 'duration') st.doc.anim.duration = Math.max(0.5, Math.min(60, v));
        else st.doc.anim.fps = Math.max(12, Math.min(60, Math.round(v)));
        refreshPhead();
        paintDock();
      };
      paintHead();
    }

    const timeLabel = () => {
      const dur = (st.doc && st.doc.anim.duration) || 4;
      const t = view ? Math.min(dur, view.time || 0) : 0;
      return t.toFixed(1) + ' / ' + dur + ' 秒';
    };

    /* 播放头：每条的条带里那根红线 + 头部那行「第几秒」。播放时才起定时器。 */
    function paintHead() {
      const host = $('mmDock');
      if (!host || !st.doc) return;
      const dur = Math.max(0.1, st.doc.anim.duration || 4);
      const t = view ? Math.min(dur, view.time || 0) : 0;
      const pct = (t / dur) * 100;
      for (const el of host.querySelectorAll('.mm-playhead')) el.style.left = pct + '%';
      const txt = $('mmTime');
      if (txt) txt.textContent = timeLabel();
      /* once / hold 播完只报一次：`clipsEnded` 是「这一帧刚跨过末帧」的边沿，重画不会重复刷屏。 */
      const ended = view && view.clipEnded ? view.clipEnded() : [];
      if (ended.length) {
        const e = ended[0];
        const key = e.id + ':' + e.name + ':' + (Number(e.duration) || 0).toFixed(3);
        if (key !== clipEndKey) {
          clipEndKey = key;
          const n = st.doc ? S.findNode(st.doc.scene.nodes, e.id) : null;
          note('「' + (n ? nodeLabel(n) : '摆件') + '」的动画已播完（' + (Number(e.duration) || 0).toFixed(1) + ' 秒）', 'ok');
        }
      } else clipEndKey = '';
    }
    function stopHeadTimer() {
      if (headTimer) { clearInterval(headTimer); headTimer = 0; }
    }
    function startHeadTimer() {
      stopHeadTimer();
      headTimer = setInterval(() => {
        if (!view || !view.playing || !active.value) { paintHead(); return; }
        paintHead();
      }, 80);
    }

    function togglePlay() {
      if (!view) return;
      const playing = !view.playing;
      view.playing = playing;
      if (playing) { view.invalidate(); startHeadTimer(); } else stopHeadTimer();
      paintDock();
    }

    function scrubTo(bar, ev) {
      if (!view) return;
      const r = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width)));
      const dur = st.doc.anim.duration || 4;
      view.playing = false;
      stopHeadTimer();
      view.setTime(ratio * dur);
      paintHead();
    }

    /* 轨迹预设：给「选中节点」的那条轨道换一种路线（没有轨道就新建一条）。
       三种路线就是 anim.js 采样的三种 path.kind —— 界面只负责填参数。 */
    function applyPathPreset(kind) {
      const node = selectedMovable();
      if (!node) return;
      const tr = trackFor(node.id);
      const dur = st.doc.anim.duration || 4;
      tr.motion = tr.motion || 'walk';
      if (kind === 'line') tr.path = { kind: 'line', from: [-1.6, 0, 0], to: [1.6, 0, 0], radius: 1.5, clockwise: false };
      else if (kind === 'circle') tr.path = { kind: 'circle', from: [0, 0, 0], to: [0, 0, 1.6], radius: 1.6, clockwise: false };
      else tr.path = { kind: 'rect', from: [-1.4, 0, -1], to: [1.4, 0, 1], radius: 1.4, clockwise: false };
      tr.keys = [];
      view.setDoc(st.doc, {});
      refreshPhead();
      paintDock();
      note('「' + nodeLabel(node) + '」的轨迹换成' + ({ line: '直线', circle: '圆', rect: '矩形' })[kind] + '（' + dur + ' 秒一圈）', 'ok');
    }

    /* 关键帧：把「现在这一刻」的位姿记在这个节点上（播放 / 出片时按时间插值）。 */
    function addKeyframe() {
      const node = selectedMovable();
      if (!node) return;
      const tr = trackFor(node.id);
      const dur = st.doc.anim.duration || 4;
      const t = Math.round((view ? view.time : 0) * 100) / 100;
      const at = node.at.slice();
      const wrap = view && view.content ? view.content.byId.get(node.id) : null;
      if (wrap) { at[0] = Math.round(wrap.position.x * 1000) / 1000; at[1] = Math.round(wrap.position.y * 1000) / 1000; at[2] = Math.round(wrap.position.z * 1000) / 1000; }
      tr.keys = (tr.keys || []).filter(k => Math.abs(k.t - t) > 0.001);
      tr.keys.push({ t: Math.min(t, dur), at, rot: node.rot.slice(), pose: node.pose || '' });
      tr.keys.sort((a, b) => a.t - b.t);
      view.setDoc(st.doc, {});
      refreshPhead();
      paintDock();
      note('在 ' + t.toFixed(1) + ' 秒给「' + nodeLabel(node) + '」打了一个关键帧', 'ok');
    }

    function selectedMovable() {
      const node = st.selectedId && st.doc ? S.findNode(st.doc.scene.nodes, st.selectedId) : null;
      if (node && (node.kind === 'mannequin' || node.kind === 'crowd')) return node;
      const first = st.doc.scene.nodes.find(n => n.kind === 'mannequin' || n.kind === 'crowd');
      if (!first) note('先在对象树里选一个小人（或先建一个）', 'err');
      return first || null;
    }
    function trackFor(id) {
      let tr = st.doc.anim.tracks.find(t => t.nodeId === id);
      if (!tr) {
        tr = { id: S.newId('t'), nodeId: id, joint: '', motion: 'walk', path: null, keys: [] };
        st.doc.anim.tracks.push(tr);
      }
      return tr;
    }

    /* 加走位：给选中的小人 / 群众排一条沿 X 的直线走动（最常用的一种，参数给默认值） */
    function addWalk() {
      const node = st.selectedId ? S.findNode(st.doc.scene.nodes, st.selectedId) : st.doc.scene.nodes.find(n => n.kind === 'mannequin');
      if (!node) { note('先在对象树里选一个（或先建一个小人）', 'err'); return; }
      if (node.kind !== 'mannequin' && node.kind !== 'crowd') { note('只有小人 / 群众能加走位', 'err'); return; }
      st.doc.anim.tracks = st.doc.anim.tracks.filter(t => t.nodeId !== node.id);
      st.doc.anim.tracks.push({
        id: S.newId('t'),
        nodeId: node.id,
        joint: '',
        motion: 'walk',
        path: { kind: 'line', from: [-1.6, 0, 0], to: [1.6, 0, 0], radius: 1.5, clockwise: false },
        keys: [],
      });
      if (!st.doc.anim.duration) st.doc.anim.duration = 4;
      view.setDoc(st.doc, {});
      paintDock();
      refreshPhead();
      note('给「' + nodeLabel(node) + '」加了一条 3.2 米的走位（4 秒内走完）', 'ok');
    }

    /* ---------------- 装配 ---------------- */
    function paintAll() {
      paintLib();
      paintTools();
      paintSide();
      paintDock();
      paintResult();
      refreshPhead();
    }

    /* 状态行只有一处（轨道坞那条横带里）：两档右栏来回切也不会把回执弄丢 */
    function note(text, kind) {
      st.note = String(text || '');
      st.noteKind = kind || '';
      const host = $('mmSay');
      if (host) {
        host.textContent = st.note;
        host.className = 'mm-dock-note' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
      }
      if (kind === 'err' && window.Toast) window.Toast.err(st.note);
    }

    async function boot() {
      if (built) return;
      built = true;
      try {
        if (!window.Api || !window.AssetLocal) throw new Error('公共模块没就绪');
        mountView();
        st.doc = blankDoc('未命名白膜');
        st.savedDigest = '';
        st.selectedId = st.doc.scene.nodes[0].id;
        view.setDoc(st.doc, { refit: true });
        view.setGizmoMode('translate');
        st.gizmo = 'translate';
        if (window.Dropdowns) window.Dropdowns.build(pageEl.value);
        if (window.fillIcons) window.fillIcons(pageEl.value);
        bindChrome();
        paintAll();
        await loadLib();
        await consumeHandoff();
      } catch (e) {
        console.error('[model] 启动失败：', e);
        if (window.PageReport) window.PageReport.pageFail('建模台', String(window.errText(e)), e);
        note('启动失败：' + window.errText(e), 'err');
      }
    }

    function bindChrome() {
      $('mmSave').onclick = () => save(false);
      $('mmSaveAs').onclick = () => save(true);
      $('mmExportJson').onclick = () => {
        if (!st.doc) return;
        Vault.exportDoc(st.doc);
        note('已导出 ' + st.doc.name + '.json', 'ok');
      };
      $('mmNew').onclick = () => newDoc();
      $('mmRename').onclick = () => renameCurrent();
      $('mmDelete').onclick = () => removeCurrent();
      $('mmMove').onclick = () => renameCurrent();
      $('mmSearch').oninput = e => { st.search = e.target.value; paintLib(); };

      const f3d = $('mmFile3d');
      $('mmImport3d').onclick = () => f3d.click();
      f3d.onchange = async () => {
        const file = f3d.files && f3d.files[0];
        f3d.value = '';
        if (!file) return;
        note('正在导入「' + file.name + '」…');
        try {
          const r = await Vault.upload(file);
          const node = {
            kind: 'asset', id: S.newId('a'), name: String(r.name || file.name).slice(0, 24),
            file: r.file, at: [0, 0, 1], rot: [0, 0, 0], scale: [1, 1, 1], clay: true,
          };
          st.doc.scene.nodes.push(node);
          await syncAssets();
          view.setDoc(st.doc, {});
          refreshPhead();
          note('已导入「' + r.file + '」并放到场景里（白膜化已开）', 'ok');
        } catch (e) {
          note('导入失败：' + window.errText(e), 'err');
        }
      };

      const fjson = $('mmFileJson');
      $('mmImportJson').onclick = () => fjson.click();
      fjson.onchange = async () => {
        const file = fjson.files && fjson.files[0];
        fjson.value = '';
        if (!file) return;
        try {
          const raw = await Vault.readJsonFile(file);
          const out = S.normalizeDoc(raw);
          st.doc = out.doc;
          st.savedId = '';
          st.savedDigest = '';
          st.selectedId = '';
          await syncAssets();
          view.setDoc(st.doc, { refit: true });
          paintAll();
          note('已导入「' + st.doc.name + '」（还没存进库里，点保存就落盘）', 'ok');
        } catch (e) {
          note('导入失败：' + window.errText(e), 'err');
        }
      };

      const cards = $('mmCards');
      cards.addEventListener('click', e => {
        const b = e.target.closest('[data-id]');
        if (b) openModel(b.dataset.id);
      });
    }

    /* 从工作台 / 导演台带过来的那一句（bridge 写的口袋）：填进提示词并直接开跑 */
    async function consumeHandoff() {
      const M = window.Model3D;
      if (!M || !M.consume) return;
      let box = null;
      try { box = M.consume('model'); } catch (e) { box = null; }
      if (!box) return;
      st.prompt = box.prompt || '';
      st.reuseMode = 'group';
      paintSide();
      const from = box.from === 'director' ? '导演台' : box.from === 'studio' ? '工作台' : '别的页面';
      note('已从' + from + '带入这一句，正在生成…');
      await generate();
    }

    onMounted(async () => { await nextTick(); await boot(); });
    onActivated(() => {
      active.value = true;
      if (view) { view.setActive(() => active.value); view.invalidate(); }
      if (built && st.doc) loadLib();
      /* 第二次以后进来也要能接住口袋：工作台 → 建模 → 工作台 → 建模是常走的一条路 */
      if (built) consumeHandoff().catch(e => note('带入失败：' + window.errText(e), 'err'));
    });
    onDeactivated(() => {
      active.value = false;
      stopHeadTimer();
      stopStreamSoon();
      if (view) { view.playing = false; view.setActive(() => false); }
    });
    onBeforeUnmount(() => {
      disposed = true;
      stopHeadTimer();
      stopStreamSoon();
      Loader.clearAssetCache();
      if (view) { view.dispose(); view = null; }
      disposeAllCaches();
    });
    void disposed;

    return { pageEl };
  },
  render,
};
