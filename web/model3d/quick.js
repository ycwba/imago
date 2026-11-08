/* 「3D 白膜」快速弹窗 —— 素材选择器与工作台那颗按钮共用的一小块：
   挑一份已经存过的白膜（或现说一句生成一份临时白膜），调一下机位，直接出一张静帧或一段动画，
   产出一份本机资产并把它交回去（调用方塞进参考槽）。**不落盘模型**：要存模型请去建模台。

   为什么要这一层而不是让人先跳建模台：用户此刻在写提示词，缺的是一张参考图，
   跳过去再回来会把上下文断掉。这里只有「选 / 看一眼 / 出图」三件事。 */

const esc = s => window.esc(String(s == null ? '' : s));
const ic = (n, s) => (window.icon ? window.icon(n, s || 13) : '');
const ASPECTS = ['16:9', '9:16', '1:1', '4:3'];

export async function open(opts = {}) {
  const [{ createView }, S, Vault, AI, Capture, Loader] = await Promise.all([
    import('./view.js'),
    import('./schema.js'),
    import('./vault.js'),
    import('./ai.js'),
    import('./capture.js'),
    import('./loader.js'),
  ]);
  const want = opts.want === 'video' ? 'video' : 'image';

  return await new Promise((resolve, reject) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ui-dlg mq';
    dlg.innerHTML =
      '<div class="pr-head"><b>3D 白膜</b><div class="sub">挑一份白膜，调好机位，直接出参考图 / 参考视频</div></div>'
      + '<div class="pr-body mq-body">'
      + '  <aside class="mq-rail">'
      + '    <select class="ui-inp" data-q="library" aria-label="白模库"></select>'
      + '    <input class="search" data-q="search" type="search" placeholder="搜模型…">'
      + '    <div class="mq-list" data-q="list"></div>'
      + '    <div class="mq-field"><label>或者现说一句（不存模型）</label>'
      + '      <textarea class="ui-inp" data-q="prompt" rows="2" placeholder="例：一个坐着的老人"></textarea></div>'
      + '    <button class="ghost mini" type="button" data-q="gen">' + ic('sparkles', 12) + ' 生成预览</button>'
      + '  </aside>'
      + '  <section class="mq-stage">'
      + '    <div class="mq-view" data-q="view" tabindex="0"></div>'
      + '    <div class="mq-bar">'
      + '      <div class="ui-seg" data-q="aspect">' + ASPECTS.map(a => '<button type="button" data-v="' + a + '">' + a + '</button>').join('') + '</div>'
      + '      <button class="ghost mini" type="button" data-q="mv">' + ic('image', 12) + ' 静帧</button>'
      + '      <button class="ghost mini" type="button" data-q="mv3">' + ic('video', 12) + ' 3 秒动画</button>'
      + '    </div>'
      + '    <div class="mq-say" data-q="note"></div>'
      + '  </section>'
      + '</div>'
      + '<div class="pr-foot"><span class="cnt" data-q="cnt"></span><span class="sp"></span>'
      + '<button class="ghost" type="button" data-q="cancel">取消</button>'
      + '<button class="pri" type="button" data-q="ok" disabled>用这一份</button></div>';
    document.body.appendChild(dlg);
    dlg.showModal();

    const q = sel => dlg.querySelector('[data-q="' + sel + '"]');
    let doc = null;
    let modelId = '';
    let aspect = (doc && doc.scene.view.aspect) || '16:9';
    let picked = null;            // 刚出的资产
    let busy = false;
    let view = null;
    let libraries = [];
    let library = '';
    let lib = { models: [], groups: [] };
    let assets = new Map();      // 摆件原型（loader 读；见模型时先读一遍，视口才看得见导入件）

    const note = (t, kind) => {
      const el = q('note');
      if (!el) return;
      el.textContent = String(t || '');
      el.className = 'mq-say' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
    };

    function close(v) {
      try { if (view) view.dispose(); } catch (e) { /* 关窗时释放失败不影响结果 */ }
      view = null;
      try { Loader.clearAssetCache(); } catch (e) { /* 缓存释放失败不影响关窗 */ }
      try { dlg.close(); } catch (e) { /* 已经关掉 */ }
      dlg.remove();
      if (v) resolve(v); else resolve(null);
    }

    function paintAspect() {
      for (const b of dlg.querySelectorAll('[data-q="aspect"] button')) b.classList.toggle('on', b.dataset.v === aspect);
    }

    function paintLibraryOptions() {
      const sel = q('library');
      if (!sel) return;
      sel.innerHTML = libraries.map(x => '<option value="' + esc(x.id) + '"' + (x.id === library ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
    }

    function paintList() {
      const host = q('list');
      const kw = String(q('search').value || '').trim().toLowerCase();
      const rows = ((lib && lib.models) || []).filter(m => !kw || (m.id + ' ' + m.name).toLowerCase().indexOf(kw) >= 0);
      if (!rows.length) {
        host.innerHTML = '<div class="mq-empty">这个库还没有模型。<br>右边说一句也能先看。</div>';
        return;
      }
      host.innerHTML = rows.map(m => {
        const thumb = Vault.thumbUrl(m, library, 'model');
        return '<button class="mq-item' + (modelId === m.id ? ' on' : '') + '" type="button" data-id="' + esc(m.id) + '">'
          + (thumb ? '<img src="' + esc(thumb) + '" alt="">' : '<span class="ph">' + ic('box', 14) + '</span>')
          + '<span class="nm">' + esc(m.name) + '</span></button>';
      }).join('');
    }

    function mountView() {
      const host = q('view');
      if (!host) return;
      view = createView(host, { assets: () => assets });
      view.setActive(() => true);
      view.setDoc(doc, { refit: true });
      view.setAspect(aspect);
      view.setEditable(false);
    }

    async function loadModel(id) {
      try {
        const raw = await Vault.readModel(library, id);
        const out = S.normalizeDoc(raw);
        doc = out.doc;
        doc.kind = 'model';
        modelId = id;
        /* 摆件先读一遍：不然视口里那些 asset 节点只是占位盒子 */
        const rd = await Loader.loadAll(Loader.filesOf(doc.scene.nodes), { library });
        assets = rd.assets;
        if (rd.notes.length) note('有摆件读不出来：' + rd.notes[0], 'err');
        aspect = doc.scene.view.aspect || aspect;
        paintAspect();
        paintList();
        q('cnt').textContent = modelId;
        if (!view) mountView(); else { view.setDoc(doc, { refit: true, resetTime: true }); view.setAspect(aspect); }
        q('ok').disabled = true;
        picked = null;
        note('转一下视角看看构图，然后点「静帧」或「3 秒动画」');
      } catch (e) {
        note('读不出来：' + window.errText(e), 'err');
      }
    }

    async function generatePreview() {
      if (busy) return;
      const prompt = String(q('prompt').value || '').trim();
      if (!prompt) { note('先写一句要建什么', 'err'); return; }
      busy = true;
      note('正在生成…');
      const ctl = new AbortController();
      try {
        const r = await AI.run({
          prompt, doc: null, mode: 'new', catalog: '（这次不参考历史白膜）', aspect, signal: ctl.signal,
          onNodes: nodes => {
            const draft = S.emptyDoc('预览');
            draft.scene.nodes = S.normalizeDoc({
              scene: { nodes, cams: draft.scene.cams, active: draft.scene.active, view: draft.scene.view },
            }).doc.scene.nodes;
            doc = draft;
            if (!view) mountView(); else view.setDoc(doc, { refit: true, resetTime: true });
          },
        });
        if (!r.doc) { note(r.why || '这一轮没有可用的模型', 'err'); return; }
        doc = r.doc;
        modelId = '';
        assets = new Map();
        paintList();
        q('cnt').textContent = '未保存的临时白膜';
        if (!view) mountView(); else view.setDoc(doc, { refit: true, resetTime: true });
        note('预览好了。要存下来就去建模台；这里只出参考图。', 'ok');
      } catch (e) {
        note('生成失败：' + window.errText(e), 'err');
      } finally {
        busy = false;
      }
    }

    async function shoot(kind) {
      if (!view || !doc) { note('先选一份白膜', 'err'); return; }
      if (busy) return;
      busy = true;
      q('ok').disabled = true;
      note(kind === 'video' ? '正在出 3 秒动画…' : '正在出图…');
      try {
        if (kind === 'video') {
          picked = await Capture.record(view, {
            doc, shortEdge: 720, duration: 3,
            prompt: String(q('prompt').value || '').trim(),
            onProgress: p => { if (p && p.msg) note(p.msg + (p.progress ? '（' + p.progress + '%）' : '')); },
          });
        } else {
          picked = await Capture.shoot(view, { doc, shortEdge: 720, prompt: String(q('prompt').value || '').trim() });
        }
        note('好了：' + picked.name + '（已存进本机资产库）', 'ok');
        q('ok').disabled = false;
      } catch (e) {
        note((e && e.name === 'AbortError' ? '已取消' : '出图失败：' + window.errText(e)), 'err');
      } finally {
        busy = false;
      }
    }

    dlg.addEventListener('click', e => {
      if (e.target.closest('[data-q="cancel"]')) return close(null);
      if (e.target.closest('[data-q="ok"]')) {
        if (!picked) return;
        return close({
          assetId: picked.assetId, src: picked.src, name: picked.name,
          type: picked.type === 'video' ? '视频' : '图片',
          url: picked.src, bytes: picked.bytes,
        });
      }
      if (e.target.closest('[data-q="gen"]')) return generatePreview();
      if (e.target.closest('[data-q="mv"]')) return shoot('image');
      if (e.target.closest('[data-q="mv3"]')) return shoot('video');
      const a = e.target.closest('[data-q="aspect"] button');
      if (a) {
        aspect = a.dataset.v;
        paintAspect();
        if (view) view.setAspect(aspect);
        return;
      }
      const item = e.target.closest('[data-id]');
      if (item) return loadModel(item.dataset.id);
    });
    dlg.addEventListener('input', e => {
      if (e.target.matches('[data-q="search"]')) paintList();
    });
    dlg.addEventListener('change', async e => {
      if (!e.target.matches('[data-q="library"]')) return;
      library = e.target.value;
      try {
        lib = await Vault.list(library);
        paintList();
        if (lib.models && lib.models.length) await loadModel(lib.models[0].id);
      } catch (err) { note('库读不出来：' + window.errText(err), 'err'); }
    });
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(null); });

    (async () => {
      try {
        const all = await Vault.list('');
        libraries = all.libraries || [];
        library = (libraries[0] && libraries[0].id) || '';
        if (library) lib = await Vault.list(library);
        paintLibraryOptions();
      } catch (e) {
        note('库读不出来：' + window.errText(e), 'err');
      }
      paintList();
      paintAspect();
      if (lib.models && lib.models.length) await loadModel(lib.models[0].id);
      else note('左边没有存过的白膜 —— 在右边说一句，先看一份临时的。');
      if (want === 'video') note('这次要的是参考视频：调好之后点「3 秒动画」');
    })().catch(err => { note('打不开：' + window.errText(err), 'err'); reject(err); });
  });
}
