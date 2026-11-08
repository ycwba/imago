/* AssetPicker — 统一素材选择器（库 / 收藏 / 素材库 + 本次上传；规则、计数、调度）。
   从 web/domain/assetlib.js 拆出；只依赖 window.Api / AssetLib / Wb / AiChip / PickSel / Chars
   这些公开面（反向依赖界面层的那几条已登记在 tests/support.cjs 的分层表里，只许减）。 */
window.AssetPicker = {
  open(opts) {
    const o = Object.assign({ types: ['图片', '视频'], multiple: true, limit: 0, title: '从资产库选择', search: '' }, opts || {});
    /* rule = Capabilities.rule(模型, role) 的原样：{ max, accept, maxBytes }。
       数量上限、收什么类型、单文件多大**全部来自平台的能力声明**（registry 兜底或上游 /models），
       页面不再自己写「最多 9 张 / 只收 mp3 / ≤10MB」；本弹窗把它们显示出来并在选择时强制。 */
    const rule = o.rule || {};
    if (!o.limit) o.limit = Math.max(0, Number(rule.max) || 0);
    const cap = Math.max(0, Number(o.limit) || 0);          // 本次还能加几个
    const total = Math.max(0, Number(rule.max) || 0);       // 这个槽位一共能收几个
    const ruleText = (window.Capabilities && Capabilities.ruleLineOf) ? Capabilities.ruleLineOf(rule) : '';
    const maxBytes = Math.max(0, Number(rule.maxBytes) || 0);
    // 只选音频时不必等图片/视频平台（kinds 交给统一加载器过滤来源）
    if (!o.kinds && o.types.length && o.types.every(t => window.isAudioType(t))) o.kinds = ['audio'];
    const wantAudio = o.types.some(t => window.isAudioType(t));
    const wantImage = o.types.includes('图片');
    const wantVideo = o.types.includes('视频');
    const upAccept = (o.upload && o.upload.accept) || [
      wantImage ? 'image/jpeg,image/png,image/webp' : '',
      wantVideo ? 'video/*' : '',
      wantAudio ? 'audio/*' : '',
    ].filter(Boolean).join(',');
    const wantUpload = o.upload !== false && !!upAccept;
    /* 「3D 白膜」这一档只在收图片 / 视频时出现：音频槽位摆一个建模入口没有意义。
       门面没装上（旧页面 / 刚装好还没刷新）就整颗不画 —— 点了没反应的按钮比没有更糟。 */
    const want3d = !!(window.Model3D && window.Model3D.quick)
      && (o.types.includes('图片') || o.types.includes('视频'));
    return new Promise(resolve => {
      /* 「在一堆卡片里点选多个」的语义只有一份（ui.js 的 PickSel）：点一下选/取消这一张、
         Shift 连选一段、到上限当场拦下并说明、可见顺序变了锚点作废。
         这一层只管画卡片、加载缩略图与交出条目。 */
      const pick = window.PickSel({ multiple: !!o.multiple, limit: cap, total,
        keyOf: e => dKey(e), onSync: () => syncSel(), onNote: t => say(t) });
      let ready = false;
      /* 视图档只有这三个取值：'lib' 资产库 / 'fav' 我的收藏 / 'char' 素材库。
         以前它是一个 `favOnly` 布尔 —— 加第三个来源时布尔就不够用了（两档开关拼不出三档）。
         本地上传那一批不归任何一档（`inView` 里它恒为真），因为那是这次弹窗里的临时条目。 */
      /* 「只要素材库」的两档：音色描述（note）与参考音频（audio）。
         这两样东西**只存在于素材身上**（资产库 / 收藏 / 本机上传里根本没有这一类），
         所以这两档只显示「素材库」那一档 —— 摆着空档只会让人以为是自己找错了地方。 */
      const charsOnly = o.chars === 'note' || o.chars === 'audio';
      let view = charsOnly ? 'char' : 'lib';
      let typeTab = '全部';
      let aiCond = null;                         // AI 搜索给出的筛选条件（{keywords, after, order, limit}）

      const $ = id => dlg.querySelector('#' + id);
      const esc = s => window.esc(s);        // 属性与正文用同一份转义（漏转 < 的那一族以前会在这里注入）
      // 先把弹窗显示出来（带加载动画），再去取数据，避免"点了没反应"
      const dlg = document.createElement('dialog');
      dlg.id = 'apDlg';
      dlg.innerHTML = `<div class="ap-head"><b>${esc(o.title)}</b>
        <input id="apSearch" class="search" placeholder="搜索提示词 / 描述要找的素材…" value="${esc(o.search || '')}" disabled>
        ${o.aiSearch ? AiFind.btnHTML('apAiBtn') + '<span id="apAiChip"></span>' : ''}
      </div>
        <!-- 来源档与类型档都用全站那一份芯片几何（.chip）；「本地上传」是动作按钮，不带选中态 -->
        <div class="ap-chips" id="apChips">
          ${charsOnly ? '' : `<button class="chip${view === 'lib' ? ' on' : ''}" data-view="lib">资产库</button>
          <button class="chip${view === 'fav' ? ' on' : ''}" data-view="fav">${window.icon ? window.icon('star', 12) : ''} 我的收藏</button>`}
          ${o.chars ? `<button class="chip${view === 'char' ? ' on' : ''}" data-view="char">${window.icon ? window.icon('users', 12) : ''} 素材库</button>` : ''}
          ${wantUpload ? `<button class="chip" data-act="upload">${window.icon ? window.icon('upload', 12) : ''} 本地上传</button>` : ''}
          ${want3d ? `<button class="chip" data-act="model3d">${window.icon ? window.icon('model', 12) : ''} 3D 白膜</button>` : ''}
        </div>
        <div class="ap-types" id="apTypes" hidden></div>
        ${o.note ? `<div class="ap-sub">${o.note}</div>` : ''}
        ${(cap || ruleText) ? `<div class="ap-ruleline">${
          /* 本次还能加几个 vs 这个槽位一共能收几个，是两件事，分开写清楚
             （页面上已经选了一半时，只写「最多 4 个」会让人以为这个槽位只收 4 个） */
          (total && cap && total > cap ? ['本槽位最多 ' + total + ' 个', '还能加 ' + cap + ' 个'] : (cap ? ['最多选 ' + cap + ' 个'] : (total ? ['最多 ' + total + ' 个'] : [])))
            .concat([ruleText]).filter(Boolean).map(esc).join(' · ')
        }${o.multiple ? '　·　<b>Shift</b> 连选一段' : ''}</div>` : ''}
        <div class="ap-body">
          <div class="ap-grid" id="apGrid"></div>
          <div class="ap-empty" id="apEmpty" hidden></div>
          <div class="ap-more" id="apMore" hidden></div>
          <div class="ap-loading" id="apLoad"><span class="ap-spin"></span>正在加载资产库…</div>
        </div>
        <div class="ap-foot"><span class="cnt" id="apCnt"></span><span class="sp"></span>
          ${o.extraLabel ? `<button class="ghost" id="apExtra">${o.extraLabel}</button>` : ''}
          <button class="ghost" id="apCancel">取消</button><button class="pri" id="apOk" disabled>确定</button></div>`;
      document.body.appendChild(dlg);
      dlg.showModal();

      const grid = $('apGrid');
      const cnt = $('apCnt');
      const okBtn = $('apOk');
      const load = $('apLoad');
      const empty = $('apEmpty');
      const more = $('apMore');
      const bodyEl = dlg.querySelector('.ap-body');
      const search = $('apSearch');
      const typesBox = $('apTypes');

      /* 关窗的唯一出口。取消 / 额外动作这两条路**没有把条目交出去**，所以上传时造的、
         以及从素材库现取字节换来的那些 blob 地址要在这里收掉 —— 以前它们随条目一起被丢掉，
         blob URL 无人 revoke，每次「上传 → 又取消」就漏一份（视频一条可达几十 MB）。
         确定那条路（entries 非空）**绝不能 revoke**：页面会把 src 拿去真取字节（转存/引用），
         revoke 早了就是静默破图。所以判据是「这一次有没有把条目交出去」。 */
      const close = out => {
        /* 交出去的那几条**绝不能 revoke**（页面还要拿 src 真取字节）；没交出去的按差集收掉 ——
           以前只在「一条都没交」时 revoke，传了三条只选一条，另外两条的 blob 就永远挂着。 */
        const kept = new Set((out || []).map(e => e && e.src).filter(Boolean));
        const seen = new Set();
        upPool.concat(hydra).forEach(e => {
          const u = e && e.src;
          if (!u || !String(u).startsWith('blob:') || kept.has(u) || seen.has(u)) return;
          seen.add(u);
          try { URL.revokeObjectURL(u); } catch (err) {}
        });
        try { io.disconnect(); } catch {} try { dlg.close(); } catch {} dlg.remove(); resolve(out);
      };
      $('apCancel').onclick = () => close([]);
      dlg.addEventListener('cancel', e => { e.preventDefault(); close([]); });
      /* 交出去之前把选中的收藏条目换成新鲜地址：渲染时那一批（最多 12 条）已经换过一轮，
         没轮到的仍然带着过期外链 —— 页面拿它去转存/引用是「真要字节」的，旧地址只会收到 403
         （表现是「转存失败 HTTP 403」，而用户看到的是刚刚才选的素材）。 */
      const resignPicked = entries => {
        const recs = (entries || []).filter(e => e && e._favRec && Fav.expired && Fav.expired(e.src));
        if (!recs.length) return Promise.resolve(entries);
        say('正在更新选中收藏的地址…');
        return Fav.resignSome(recs.map(e => e._favRec), (rec, next) => {
          const e = recs.find(x => x._favRec === rec);
          if (e) { e.src = next; e.dl = next; }
        }, { limit: recs.length }).then(() => entries, () => entries);
      };
      /* 素材库那一位身上的音频，字节一直留在 IndexedDB（或那条地址）里，弹窗只拿到一个取法。
         交出去之前现换成「条目 + file + src」—— 页面接到的和本地上传那一条是**同一个形状**，
         它们不必知道这条从哪一档来（否则每个页面都要再判一次来源，判据就三份了）。
         取不到字节的**标上 dead 照样交出去**，由页面回执那一句 —— 这里静默丢掉就是
         「点确定后槽里少一个，界面还说已加入 N 个」。 */
      const hydra = [];
      const hydrate = entries => Promise.all((entries || []).map(async e => {
        if (!e || !e.getBlob || e.file) return;
        say('正在取素材库里那一段的字节…');
        try {
          const b = await e.getBlob();
          if (!b) { e.dead = missWhy(); return; }
          const f = new File([b], window.fileSafe(e.name || '素材音频', 60) + '.wav',
            { type: b.type || 'audio/wav' });
          e.file = f; e.bytes = b.size;
          const u = URL.createObjectURL(f);
          e.src = u; e.dl = u;
          hydra.push(e);
        } catch { e.dead = missWhy(); }
      })).then(() => entries);
      /* 确定也走 finish：它除了交出 Promise，还会对每个条目调一次 o.onPick。
         以前确定按钮直接 close(entries)，**只 resolve 不回调** —— 导演台的槽位全是靠 onPick 落地的
         （它不接 Promise 的返回值），于是点确定等于什么都没发生。 */
      okBtn.onclick = () => finish(pick.list());
      // 额外动作（例如导演的「接上一镜结尾」）：先关掉选择器，再交给调用方处理
      const extraBtn = $('apExtra');
      if (extraBtn) extraBtn.onclick = () => { close(null); try { o.extraAction && o.extraAction(); } catch {} };
      const finish = entries => {
        hydrate(entries).then(hs => resignPicked(hs)).then(es => {
          /* 取不到字节的那几条**照样递出去**（带着 `dead` 那句话），这里不悄悄筛掉：
             槽位落几个是页面自己的账，它必须能数出「用户选了 3 条、其中 1 条没落地」并说出来。 */
          /* 本机没有字节、但平台有地址的那几条：不拦（用户可能就要云端那条），
             但不能让人以为「选好了」= 生成时一定取得到 —— 过期/清理之后就是失败。 */
          try {
            const AL = window.AssetLocal;
            const cloudOnly = es.filter(e => {
              if (!AL || !AL.stateOf) return false;
              const st = AL.stateOf(e);
              return st.cloud && !st.local;
            }).length;
            if (cloudOnly && window.Toast) Toast.warn('有 ' + cloudOnly + ' 条素材本机没有字节，地址过期会失败；建议先「存回本机」。');
          } catch (err) {}
          if (o.onPick) { try { es.forEach(e => o.onPick(e)); } catch {} }
          close(es);
        });
      };

      const isAudio = window.isAudioType;
      /* 「那一段字节取不到」这句话的出处在 `chars.js`（只有它知道要去素材库页给哪一位重挂）。
         只有带 `getSrc` / `getBlob` 的素材库条目会走到这里，而那些条目只可能由 chars.js 递过来，
         所以这一层不替它编一份兜底措辞。 */
      const missWhy = () => window.Chars.Pipe.refAudioMiss();
      const okType = t => o.types.includes(t) || (isAudio(t) && o.types.some(isAudio));
      /* 类型筛选只在真的要选两类以上时出现（音乐/音频算同一类）。
         出现的那几颗按全站那一副顺序排（视频 → 图片 → 音频，ui.js 的 mediaKindRank）；
         档位**只列这一槽收的类型** —— 配音槽摆一颗「视频」不是「一次给全」，是点下去选不出东西。 */
      const typeTabs = (() => {
        const t = [...new Set(o.types.map(x => isAudio(x) ? '音频' : x))]
          .sort((a, b) => window.mediaKindRank(a) - window.mediaKindRank(b));
        return t.length > 1 ? ['全部'].concat(t) : [];
      })();

      /* ---------- 条目池：资产库 / 我的收藏 / 本次本地上传 ----------
         三个来源合成一个池，按产物号去重，并且**资产库那条优先**：收藏存的是「按下收藏那一刻」的地址，
         外链签名一过期就 403（表现就是「我的收藏的缩略图加载不出来」），而列表每次都是现场取的新鲜地址。
         排序和资产库页一致：按完成时间倒序、图片与视频混排，最新的永远在最上面。 */
      const tsOf = e => AssetLib.tsMs(e.ts) || 0;
      const idOf = e => String((e && (e.assetId || e.genId || e.id)) || '');
      const dKey = e => {
        if (e._ukey) return 'u:' + e._ukey;         // 本次本地上传：blob 地址每次都变，不能拿来当键
        /* 素材库那一位身上的素材：键是「哪位素材 + 哪一列」（`chars.js` 里拼好了递出来）。
           **每列各占一格**，不与资产库/收藏并卡 —— 并卡的前提是「两份来路指的是同一个文件」，
           而这里并的是「同一个人的两种不同东西」，并完就是「显示的是小雅、拿的是阿May」。 */
        if (e._ckey) return 'c:' + e._ckey;
        /* 同一份文件的几种来路合成一格：资产库里那条（la_xxx）、平台列表那条、我的收藏那条。
           判据只有 AssetLocal.twinOf 一处，这里不另编一套 —— 以前只比 provider+产物号，
           于是「列表里那条已经换成本机文件、收藏里那条还挂着老产物号」的两张卡谁也认不出谁，
           表现就是用户说的「同一个视频任务在选择器里出现两遍」。 */
        const tk = (window.AssetLocal && AssetLocal.twinOf) ? AssetLocal.twinOf(e) : '';
        if (tk) return 't:' + tk;
        const i = idOf(e);
        if (i) return 'a:' + (e.provider || '') + ':' + i;
        return e.favItem ? 'f:' + e.favItem.key : (e.src ? 's:' + e.src : 'n:' + (e.name || ''));
      };
      let libPool = [];        // 资产库列表（分批到达）
      let favPool = [];        // 只在收藏里出现的条目（本地文件收藏 + 列表还没翻到的收藏）
      let charPool = [];       // 素材库那几位身上的素材（参考音频 / 音色描述；`chars.js` 给的名单）
      let charErr = '';        // 名单没取出来的原因（空 = 取到了；「没加载出来」不等于「一位都没有」）
      const upPool = [];       // 本次「本地上传」的本地文件
      let base = [];
      const compose = () => {
        const map = new Map();
        /* 素材库排在最前只是**摆放顺序**，不参与并卡：那些条目的键是 `c:` 开头的，
           和资产库/收藏的键永远不同形，所以「一位素材的参考音频」不会被资产库里
           同一段上传过的 wav 顶掉（顶掉了就拿不到那位身上的音色复刻材料了）。 */
        charPool.forEach(e => { e._grp = 'char'; map.set(dKey(e), e); });
        libPool.forEach(e => { e._grp = 'lib'; map.set(dKey(e), e); });
        favPool.forEach(e => {
          const k = dKey(e), hit = map.get(k);
          if (hit) {
            hit.fav = true; hit._favRec = hit._favRec || e._favRec;
            /* 用户在这条并掉之前点中过它（收藏那一批先画出来、列表要几秒才到）→
               选中跟着挪到留任的那一条上，别因为「同一份文件换了个来路」把已选的丢掉 */
            if (pick.replace(e, hit)) {
              const d = nodes.get(e);
              if (d) { nodes.delete(e); nodes.set(hit, d); d._apEntry = hit; }
            }
          } else map.set(k, e);
        });
        upPool.forEach(e => { e._grp = 'local'; map.set(dKey(e), e); });
        base = [...map.values()].sort((a, b) => tsOf(b) - tsOf(a));
        pick.prune(new Set(base));
      };
      const refresh = () => { compose(); paint(); };

      const inView = e => e._grp === 'local' ? true      // 本次上传的临时条目不归任何一档
        : view === 'fav' ? (e._grp === 'fav' || !!e.fav)
        : view === 'char' ? e._grp === 'char' : e._grp === 'lib';
      const matchesType = e => !typeTabs.length || typeTab === '全部'
        || e.type === typeTab || (typeTab === '音频' && isAudio(e.type));
      /* hay 每条只拼一次：搜索框每敲一键，`matched()` 就要对**每一条**重拼一遍
         （join + toLowerCase），一屏 200 条就是 200 次。按条目缓存，键里带上唯一会变的那一项
         （收藏备注 `_favRec.note`），所以备注改了照样立刻生效。 */
      const hayCache = new WeakMap();
      const hay = e => {
        const note = (e._favRec && e._favRec.note) || '';
        const c = hayCache.get(e);
        if (c && c.note === note) return c.s;
        const s = [e.prompt, e.name, e.providerName, note].join(' ').toLowerCase();
        hayCache.set(e, { note, s });
        return s;
      };
      /* 筛选指纹：以前是 `JSON.stringify(aiCond)` —— 每次 paint 都把整份条件序列化一遍。
         改成只取真正参与判定的那几个字段（aiMatch 用 keywords/after，visible 用 order/limit）。 */
      const aiFp = () => aiCond
        ? [aiCond.order || '', aiCond.limit || '', aiCond.after || '', (aiCond.keywords || []).join('|')].join('~')
        : '';
      const aiMatch = e => {
        const kw = (aiCond.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
        if (kw.length && !kw.some(k => hay(e).includes(k))) return false;
        /* 本地日界线只有一份算法（AssetLib.dayRange）：Date.parse('YYYY-MM-DD') 是 UTC 午夜，
           东八区筛「今天」会把凌晨那几条筛掉 —— 选择器与资产库必须同一个口径，
           否则「资产库里有这条、选择器里找不到」这种对不上会一直存在。 */
        const after = window.AssetLib.dayRange(aiCond.after, '').from;
        if (after != null && tsOf(e) && tsOf(e) < after) return false;
        return true;
      };
      /* 一次只画 200 条，**滚到底再追加 200 条** —— 不是「只给 200 条」。
         以前是 GRID_CAP 硬截断：几百条时排在第 200 条以后的那一类一张都不出现，
         用户只会以为「这个库里没有这一类」，而真实原因只是窗口没往下翻。 */
      const GRID_PAGE = 200;
      let shownCap = GRID_PAGE;      // 当前渲染窗口的大小（每滚到底 += GRID_PAGE）
      let rest = 0;                  // 命中了、但当前窗口还没画出来的条数
      let aiCut = 0;                 // 命中了、但被 AI 的「只要 N 条」裁掉的条数
      let winAll = 0;                // 当前筛选命中的总条数
      let winKey = '';               // 筛选状态指纹：变了就把窗口收回第一屏
      const matched = () => {
        /* AI 条件生效时，搜索框里那句原话不再参与过滤：整句几乎不可能是某条提示词的子串，
           再 AND 一层就等于「AI 挑完了又全部筛掉」。框里的字保留着，改一下就会重新按普通关键词筛
           （见 search.oninput），点 ✕ 也能退回普通筛选。 */
        const q = aiCond ? '' : search.value.trim().toLowerCase();
        let out = base.filter(e => inView(e) && matchesType(e) && (!q || hay(e).includes(q)) && (!aiCond || aiMatch(e)));
        if (aiCond && aiCond.order === 'asc') out = out.slice().reverse();
        return out;
      };
      const visible = () => {
        const all = matched();
        /* 换了筛选条件（搜索框里的字 / 类型档 / 来源视图 / AI 条件）就把窗口收回第一屏：
           带着「已经翻到第 800 条」去看一个新筛选，第一眼看到的是不相干的一段。
           判据只有这一处（筛选指纹），不要在每个改筛选的按钮里各写一遍「重置」。 */
        const key = [search.value, typeTab, view, aiFp()].join('\u0001');
        if (key !== winKey) { winKey = key; shownCap = GRID_PAGE; }
        const capN = aiCond ? Math.max(1, Number(aiCond.limit) || 30) : Infinity;
        const want = Math.min(all.length, capN);        // AI 钉住的那一条线以下才归窗口管
        const take = Math.min(want, shownCap);
        winAll = all.length;
        rest = want - take;                              // 命中了、窗口还没画到的
        aiCut = all.length - want;                       // 命中了、被 AI 的条数上限裁掉的
        return all.slice(0, take);
      };

      /* 缩略图与卡片复用：每次筛选都 grid.innerHTML 重建的话，视频缩略图就重新取一次元数据
         （观感是"闪一下、又要等一会儿"）。卡片节点按条目留着，只把新增的插到正确位置，
         已经在位的一个字都不动；缩略图统一走 Wb.thumbs（同一份首帧缓存 + 懒加载 + 并发上限）。 */
      const nodes = new Map();          // entry → 卡片元素
      /* 计数条：从一开始就写「已选 0 / 8」，上限来自能力声明，不是选满一个才出现。
         选满时立刻说清「已选满」，不让用户以为点不动是坏了（那句话本身在 PickSel 里）。
         noteT = 正在显示的那条一次性说明的定时器句柄（0 = 现在没有说明，计数条归 countText 管）。 */
      let noteT = 0;
      const syncSel = () => {
        nodes.forEach((d, e) => d.classList.toggle('sel', pick.has(e)));
        if (!noteT) cnt.textContent = pick.countText();     // 有提示在显示时别把它顶掉
        okBtn.disabled = !pick.size;
      };
      /* 计数条两条通道（以前都直接写 #apCnt，结果提示会被下一次 paint() 当场覆盖）：
         syncSel 写常驻的「已选 N / 上限」，say 写一次性说明并在几秒后自动让位。 */
      const say = t => {
        clearTimeout(noteT);
        if (!t) { noteT = 0; cnt.textContent = pick.countText(); return; }
        cnt.textContent = t;
        noteT = setTimeout(() => { noteT = 0; cnt.textContent = pick.countText(); }, 4000);
      };
      /* 选择器里也标出本机 / 云端（与资产卡同一个 sk_media_badge 开关），
         免得用户在这里挑中一条本机没有字节、生成时才被过期外链坑掉。
         徽标本身（文案 / class / title）只有 ui/badge-state.js 那一份。 */
      const srcMarkOf = e => {
        if (!window.AssetLocal || !AssetLocal.showBadge || !AssetLocal.showBadge() || !AssetLocal.stateOf) return '';
        return window.badgeHTML(AssetLocal.stateOf(e));
      };
      const metaOf = e => [e._grp === 'local' ? '本地文件' : e._grp === 'fav' ? '我的收藏' : (e.providerName || ''),
        e.type, e.format ? e.format.toUpperCase() : '', e.duration ? e.duration + 's' : '', srcMarkOf(e)].filter(Boolean).join(' · ');
      /* ---------- 网格媒体的加载调度（慢的根因就在这里）----------
         以前一次把上百张卡片的媒体**全塞进 DOM**：图片直接请求**原图**（经代理取回，
         一张几百 KB ~ 几 MB），视频 `preload="metadata"` 也要回一段 Range —— 98 张一起抢连接，
         弹窗要等很久才出图，视频更慢。
         现在：卡片先画**占位格**（立刻能看、能点、能多选），媒体滚到附近才创建，并且**并发封顶**
         （图 8 / 视频 2）—— 首屏只加载十来张，往下滚再续。缓存命中的（Wb.thumbs 已有的小图）不受排队影响。 */
      const MEDIA_CONC = { image: 8, video: 2 };
      const mediaWait = [];
      const mediaActive = { image: 0, video: 0 };
      const pendingMedia = new Map();          // 卡片 → true
      /* 卡片被筛掉 / 换掉时连排队一起撤：pendingMedia 只写不删的话 Map 一直攥着已移除的 DOM，
         队里那些活也会照样给看不见的卡片取图。 */
      const dropMedia = d => {
        pendingMedia.delete(d);
        for (let i = mediaWait.length - 1; i >= 0; i--) if (mediaWait[i].el === d) mediaWait.splice(i, 1);
      };
      /* 「这张卡现在就摆在滚动区可视带里」的判据只有一份（放 400px 余量，与观察器的 rootMargin 同一条）。
         上面那个观察器负责「什么时候把卡片交给调度器」，这里负责「先给谁」—— 两者必须是同一个 400px，
         否则会出现「观察器说在附近、调度器说不在」而每张都走第二轮。 */
      const nearView = el => {
        const r = el.getBoundingClientRect(), b = bodyEl.getBoundingClientRect();
        if (!r.width || !r.height || !b.height) return false;
        return r.bottom > b.top - 400 && r.top < b.bottom + 400;
      };
      const pumpMedia = () => {
        /* 先服务**眼下看得见**的那几张，再补剩下的（第二轮）。
           以前是纯 FIFO：快速滚到底时一次进队几百张，排在最前面的是**刚被滚过去、
           谁也没在看**的那一批，而用户正盯着的底部那几张排在最末 ——
           实测每张约 1.6 秒、视频并发只有 2，底部视口里的 14 张要等三分多钟才轮到，
           这段时间里它们连 `<video>` 都没有（占位符「…」），看着就是「往下滚视频卡全是灰」。
           判据用同一个 nearView（和观察器的 rootMargin 一样放 400px 余量）。 */
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < mediaWait.length; i++) {
            const job = mediaWait[i];
            const lim = MEDIA_CONC[job.kind] || 4;
            /* 这一类满了要**跳过它继续看后面的**，不是 break 整个循环：
               写成 break 时「视频槽位被占满」会连带把后面的图片也一起堵死，
               而且上面那句注释本来写的就是「后面别的类还能走」。 */
            if (mediaActive[job.kind] >= lim) continue;
            if (pass === 0 && !nearView(job.el)) continue;
            mediaWait.splice(i--, 1);
            mediaActive[job.kind]++;
            Promise.resolve().then(job.run).catch(() => {}).then(() => { mediaActive[job.kind]--; pumpMedia(); });
          }
        }
      };
      const fillMedia = (d, e) => {
        const tb = window.Wb && window.Wb.thumbs;
        const isVid = e.type === '视频';
        const host = isVid ? d.querySelector('.ap-media') : d;
        if (!host || host.dataset.filled) return;
        host.dataset.filled = '1';
        const wait = host.querySelector('.ap-wait') || (isVid ? null : d.querySelector('.ap-wait'));
        if (wait) wait.remove();
        if (isVid) {
          host.innerHTML = tb ? tb.mediaHTML(e.src, { key: e._tkey, videoAttrs: 'preload="metadata" muted playsinline' })
            : `<video preload="metadata" muted playsinline></video><span class="tph"></span>`;
        } else {
          /* 注意这里**故意不写 loading="lazy"**：放行与否由上面的调度器说了算（视口 ±400px），
             再叠一层浏览器自己的懒加载，屏幕外那几张会被一直压着不取，
             我们的并发插槽就白占着（甚至等到 15 秒兜底才放行），反而更慢。 */
          host.insertAdjacentHTML('afterbegin', tb ? tb.mediaHTML(e.src, { type: 'image', key: e._tkey, mediaAttrs: 'decoding="async"' })
            : `<img src="${esc(e.src)}" decoding="async">`);
        }
        const m = isVid ? host.querySelector('video, img') : (host.matches && host.matches('img, video') ? host : host.querySelector('img, video'));
        if (m && tb) tb.bind(isVid ? host : d, m, e.src, null, e._tkey);
        return isVid ? videoSettled(host, tb, e) : loaded(m, false);
      };
      /* 视频的插槽要等**抽帧真的落地**，不能等 `<video>` 自己的 load 事件：
         mediaHTML 给视频的标记只有 `data-src`（地址由 Wb.thumbs 拿到游离元素里去抽，抽成功后
         `_show` 把这个 `<video>` **整个换成 `<img>`**）—— 挂在这个节点上的 load/error 永远不会触发，
         于是每条视频都白占满 MEDIA_CONC.video=2 的槽位直到 15 秒兜底。
         一屏超过两条时画面就按「每 15 秒放两张」的节奏出，观感正是「视频缩略图老是加载不出来」。
         改成盯容器：出现 <img>（换图）或 .ready（标记成功）就放行，占位格里写了失败文案也放行。 */
      const videoSettled = (host, tb, e) => new Promise(res => {
        let done = false, mo = null, tm = 0;
        /* fin 会先于下面那两行执行（缓存命中就直接收工），所以 mo/tm 必须先声明再赋值：
           写成 const 就是 TDZ，报「Cannot access 'tm' before initialization」，
           整条视频卡片当场抛错 —— 表现是「筛出来的视频缩略图一个都不出」。 */
        const fin = () => { if (done) return; done = true; clearTimeout(tm); if (mo) try { mo.disconnect(); } catch {} res(); };
        const settled = () => !!host.querySelector('img') || host.classList.contains('ready')
          || (host.querySelector('.tph') || {}).textContent;
        if (!tb || settled()) return fin();                       // 缓存命中或没有缩略图层：不排队
        mo = ('MutationObserver' in window) ? new MutationObserver(() => { if (settled()) fin(); }) : null;
        if (mo) mo.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });
        tm = setTimeout(fin, 22000);                              // 抽帧自身上限 20 秒，这里只多留 2 秒
      });
      /* 并发封顶要数的是**在飞的网络请求**，不是「插进 DOM 的动作」：
         插完就放行的话，一次能塞进几十个 <img>，浏览器自己再去抢连接（等于没封顶）。
         所以插槽一直占到这张图真的 load（或 error）才释放。视频走上面那条 videoSettled。 */
      const loaded = m => new Promise(res => {
        if (!m) return res();
        if (m.complete) return res();                             // 已经就绪（多半是缓存命中）
        let done = false;
        const fin = () => { if (done) return; done = true; clearTimeout(tm); res(); };
        const tm = setTimeout(fin, 15000);                        // 别让一张拉不回来的图把整队堵死
        m.addEventListener('load', fin, { once: true });
        m.addEventListener('error', fin, { once: true });
      });
      const scheduleMedia = (d, e) => {
        if (!d || pendingMedia.get(d)) return;
        /* 音频没有画面、「音色描述」压根没有媒体，这两类一个媒体节点都不排：
           这条队列只认两种活（取图 / 抽帧），音频进来被当成图片，
           `fillMedia` 就把 `<img src="一段 wav">` 插进格子 → 当场 error → `onMediaError` 那两级回退
           （本机号、索引里的外链）也都取不到「图」→ 每张音频卡挂一颗「已丢失」，
           而它自己那颗试听按钮一直放得出声。观察器与直接排队两条入口都从这一行走，闸只设这一处。 */
        if (isAudio(e.type) || e.noMedia) return;
        pendingMedia.set(d, true);
        const kind = e.type === '视频' ? 'video' : 'image';
        // 缓存里已经有小图的（多半刚刚在别处看过）直接放行，不用排队
        const cached = (window.Wb && window.Wb.thumbs) ? Wb.thumbs.get(e.src, e._tkey) : '';
        if (cached) { fillMedia(d, e); return; }
        mediaWait.push({ kind, el: d, run: () => fillMedia(d, e) });
        pumpMedia();
      };
      const io = ('IntersectionObserver' in window)
        ? new IntersectionObserver(ents => { for (const en of ents) { if (!en.isIntersecting) continue;
            /* 条目要**从元素上取**（el._apEntry）：nodes 那张表是「条目 → 元素」，
               反过来 nodes.get(元素) 永远是 undefined —— 踩过一次，症状是占位格一个都填不上：
               观察器明明回调了，每张卡却都被当成「取不到条目」直接丢掉。 */
            const e = en.target._apEntry; if (e) scheduleMedia(en.target, e);
            io.unobserve(en.target); } },
          { root: dlg.querySelector('.ap-body'), rootMargin: '400px 0px' })
        : null;
      /* 滚到底追加下一批：判据与 `Wb.pager` 的「滚到底自动续拉」同一形状 —— 量的是滚动位置。
         原来挂的是 IntersectionObserver（看见尾巴才追加），实测在页面处于后台时观察器
         根本不发回调，怎么滚都停在 200 条；而「后面明明有 131 条却拿不到」是不能接受的。
         这颗尾巴同时能点（more.onclick）—— 人工那条出口任何时候都要留着。 */
      const grow = () => {
        if (rest <= 0) return;
        shownCap += GRID_PAGE;
        paint();
      };
      bodyEl.addEventListener('scroll', () => {
        if (bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 260) grow();
      }, { passive: true });
      more.onclick = grow;
      const build = e => {
        const d = document.createElement('div');
        d.className = 'ap-item';
        d._apEntry = e;                      // 观察器回调里回查条目用（见上）
        /* 音频没有画面，给一张能试听的卡片；以前按图片渲染，表现就是「收藏里的音频全是一片灰」。
           音色描述那一类连声音都没有，只摆一颗图标（借音频那个盒子，不另起一份 CSS）。 */
        let media;
        if (e.noMedia) {
          media = `<span class="ap-audio">${window.icon ? window.icon('mic', 22) : '♪'}</span>`;
        } else if (isAudio(e.type)) {
          media = `<span class="ap-audio">${window.icon ? window.icon('speaker', 22) : '♪'}</span>`;
        } else if (e.type === '视频') {
          /* 只先画占位：真正的 <video> 滚到附近才由调度器补上（见上面的 fillMedia） */
          media = '<span class="ap-media"><span class="ap-wait">…</span></span>';
        } else {
          media = '<span class="ap-wait">…</span>';
        }
        d.innerHTML = media + `<span class="chk">✓</span>
          <div class="m"><div class="t">${esc(e.prompt || e.name || '(无名称)')}</div>${metaOf(e)}</div>`;
        if (isAudio(e.type)) {
          const b = d.querySelector('.ap-audio');
          let au = null;
          /* 素材库里那一位的参考音频**开弹窗时不取字节**（几十位素材就是几十 MB 白读），
             地址由条目自带的 `getSrc()` 现场换：第一次点试听才换，换到的地址记回 `e.src` 复用。 */
          b.onclick = async ev => {
            ev.stopPropagation();
            if (!e.src && e.getSrc) {
              b.title = '正在取这一段…';
              try { e.src = await e.getSrc() || ''; } catch { e.src = ''; }
              b.title = '试听';
            }
            if (!e.src) { say(missWhy()); return; }
            if (!au) { au = new window.Audio(e.src); au.onended = () => { au = null; b.classList.remove('playing'); }; }
            if (au.paused) { au.play().catch(() => { cnt.textContent = '这个音频放不出来（地址可能已过期）'; }); b.classList.add('playing'); }
            else { au.pause(); b.classList.remove('playing'); }
          };
          b.title = '试听';
        }
        /* 点选语义全在 ui.js 的 PickSel 里（与素材库挑选共用一份）：普通点 = 选中 / 取消这一张（不要求按 Ctrl）、
           Shift = 连选一段、到上限当场说明原因。单选也是「点选 → 底部确定」，不再点一下就关窗（选错了只能重开一次）。 */
        d.onclick = ev => pick.click(visible(), e, ev.shiftKey);
        /* 音频卡一条媒体都不排（闸在 `scheduleMedia` 开头，两条入口都从那儿过）。
           旧版这里挡过一次（`if (tb && !isAudio(...))`），但那个 if 体是空的、排队的闸写在下面那行，
           于是音频照样被收进队列，每张挂着「已丢失」。 */
        /* 本次上传的本地文件是 blob 地址（字节已经在内存里，没有网络开销），
           不排观察器的队 —— 以前它们按文件修改时间排序，位置常常在网格很下面，
           不滚动就永远是占位符「…」，看着就是「传了文件却没有缩略图」。 */
        if (io && !e.fromLocal) io.observe(d); else scheduleMedia(d, e);
        return d;
      };
      const paint = () => {
        const shown = visible();
        /* 可见顺序变了（筛选 / 切档位 / 翻页）→ 连选锚点作废，否则 Shift 会选到不相邻的一段 */
        pick.reflow(shown);
        const keep = new Set(shown);
        for (const [e, d] of [...nodes]) {
          if (keep.has(e)) continue;
          if (io) { try { io.unobserve(d); } catch {} }     // 别让观察器攒着已删的节点
          dropMedia(d);                                    // 同时撤掉媒体队列与 pendingMedia 里那一份
          d.remove(); nodes.delete(e);
        }
        let ref = grid.firstChild;
        shown.forEach(e => {
          let d = nodes.get(e);
          if (!d) { d = build(e); nodes.set(e, d); }
          if (d !== ref) grid.insertBefore(d, ref);   // 只有新增/换序才搬，已在位的不碰
          ref = d.nextSibling;
        });
        empty.hidden = !!shown.length || !ready;
        if (!shown.length && ready) {
          const kw = (search.value || '').trim();
          const names = o.types.join(' / ');
          /* 空态那句要**认得此刻这一档**，还要给一条真出路（只说「没有」等于让人自己猜去哪加）。
             素材库那一档另说：「名单没取出来」与「库里一位都没有」是两件事，前一句不能冒充后一句。 */
          const v = view === 'fav' ? ['我的收藏里还没有', names + '，去资产库或收藏页加几条']
            : view === 'char' ? [charErr ? '素材库没能加载：' + charErr : '素材库里还没有可取的',
              charErr ? '，修好上面那一句再重开这个弹窗'
                : (o.chars === 'note' ? '音色描述，到素材库页给某一位写一段' : '参考音频，到素材库页给某一位挂一段干净人声')]
              : ['资产库里还没有', names + '，先去生成或上传吧'];
          empty.textContent = aiCond ? 'AI 没在这堆素材里挑出匹配的'
            : kw ? '没有匹配「' + kw.slice(0, 20) + '」的' + names + '，换个说法试试'
              : v[0] + v[1];
        }
        /* 窗口下面还有多少条没说 —— 这句必须在格子上摆着：
           库里几百条时「这一类一张都没出现」看着就像「这个库里没有这一类」，
           而真实原因只是窗口还停在最前面那 200 条（往下滚就来，点那一句也直接补）。 */
        if (!shown.length) { more.hidden = true; more.classList.remove('go'); }
        else if (rest > 0) {
          more.hidden = false;
          more.classList.add('go');
          more.textContent = '往下滚加载后面的 ' + rest + ' 条（已列出 ' + shown.length + ' / ' + winAll + '）';
        } else if (aiCut > 0) {
          more.hidden = false;
          more.classList.remove('go');
          more.textContent = 'AI 只要这一类里的 ' + shown.length + ' 条（筛中了 ' + winAll + ' 条）';
        } else {
          more.hidden = true;
          more.classList.remove('go');
        }
        syncSel();
      };
      /* 单卡重画：后台换地址后必须重建那一格。paint() 只复用已在位的节点，
         而图片签名过期时 onerror 会把 display 设成 none —— 只改 e.src 的话那一格永远空白，
         表现就是「我的收藏里的缩略图加载不出来」。 */
      const repaint = e => {
        const old = nodes.get(e);
        if (!old) return;
        if (io) { try { io.unobserve(old); } catch {} }
        dropMedia(old);
        const d = build(e);
        nodes.set(e, d);
        old.replaceWith(d);
        // 新格子别等观察器：直接排进调度（滚动位置没变，它本来就在视口里）
        scheduleMedia(d, e);
        syncSel();
      };
      /* 改了搜索框里的字，之前编译出来的 AI 条件就不再对应这句话了：清掉它，回到普通关键词筛选 */
      search.oninput = () => { if (aiCond) { aiCond = null; paintAiChip(); } paint(); };

      const renderTypes = () => {
        if (!typeTabs.length) { typesBox.hidden = true; typesBox.innerHTML = ''; return; }
        typesBox.hidden = false;
        /* 类型档是「两到几个互斥选项」= 分段开关，用公共类 `.ui-seg`（画法只有 ui.css 那一份）。
           以前这里调的是 ui 层的 `Chips.render`：筛选芯片是「多选收窄」，与这一排「选一整档」不是一件事，
           而且让 domain 的选择器反过来驱动界面组件 —— 分层表里 `asset-picker.js → Chips [ui]` 就是这一条。 */
        typesBox.innerHTML = '<span class="ui-seg" role="tablist" aria-label="素材类型">'
          + typeTabs.map(t => '<button type="button" role="tab" data-t="' + esc(t) + '"'
            + (t === typeTab ? ' class="on" aria-selected="true"' : '') + '>' + esc(t) + '</button>').join('')
          + '</span>';
        typesBox.querySelectorAll('button').forEach(b => {
          b.onclick = () => { typeTab = b.dataset.t; renderTypes(); paint(); };
        });
      };
      const setView = v => {
        view = v;
        dlg.querySelectorAll('#apChips .chip[data-view]').forEach(x => x.classList.toggle('on', x.dataset.view === v));
        paint();
      };
      /* 顶部档位分两类：data-view 是来源视图切换，data-act 是动作（本地上传）。
         以前这里把所有芯片都当视图切换，多一个动作按钮就会把列表清空。 */
      dlg.querySelectorAll('#apChips .chip').forEach(ch => {
        if (ch.dataset.view) { ch.onclick = () => setView(ch.dataset.view); return; }
        if (ch.dataset.act === 'upload') ch.onclick = () => uploadFiles(ch);
        if (ch.dataset.act === 'model3d') ch.onclick = () => openModel3d(ch);
      });
      renderTypes();

      /* ---------- 本地上传：条目只活在这次弹窗里（src 是 blob 地址，带 file 供调用方取本体） ---------- */
      const uploadFiles = chBtn => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = upAccept;
        if (o.multiple) inp.multiple = true;
        inp.onchange = () => {
          const files = [...(inp.files || [])];
          if (!files.length) return;
          const added = [];
          let tooBig = 0, wrongType = 0;
          files.forEach(f => {
            const t = (/^video\//.test(f.type) || /\.(mp4|mov|webm|m4v)$/i.test(f.name)) ? '视频'
              : (/^audio\//.test(f.type) || /\.(mp3|wav|m4a|ogg|oga|flac|aac)$/i.test(f.name)) ? '音频' : '图片';
            if (!okType(t)) { wrongType++; return; }
            /* 单文件体积按能力声明当场拦：传上去才发现超限，素材已经白传一遍了 */
            if (maxBytes && f.size > maxBytes) { tooBig++; return; }
            const url = URL.createObjectURL(f);
            /* 缩略图键里不能有 '#'：Wb.thumbs.keyOf 会先 split('#')[0]，
               文件名带 # 时键被截断，缓存永远命不中（症状是每次开弹窗都重抽一遍帧）。 */
            const fkey = encodeURIComponent(f.name) + '|' + f.size + '|' + (f.lastModified || 0);
            added.push({ kind: 'local', localFav: true, localAsset: true, fromLocal: true, file: f, name: f.name,
              type: t, provider: 'local', providerName: '本地文件', prompt: f.name.replace(/\.[^.]+$/, ''),
              /* 排序用「刚传上来的时刻」而不是文件修改时间：重传一个旧文件沉到网格最底部，
                 缩略图要靠滚动才出得来，看着就像「传了文件但没有缩略图」。 */
              src: url, dl: url, ts: Date.now(), _grp: 'local', duration: null,
              format: (f.name.split('.').pop() || '').toLowerCase(),
              _ukey: fkey, _tkey: 'fav-file:' + fkey });
          });
          if (!added.length) {
            say((wrongType ? '这个位置不收其中的 ' + wrongType + ' 个文件（类型不符）' : '')
              + (tooBig ? (wrongType ? '　·　' : '') + '有 ' + tooBig + ' 个超过' + (ruleText || '平台声明的上限') : ''));
            return;
          }
          /* 单值槽位：上传 = 换选这一个，与点卡片同一套语义（先清后加）。
             以前这里直接 finish(added[0]) 关窗：既和规则条上写的「点一张选中，按确定」对不上，
             又会把用户刚点中的那一条无声丢掉（槽位里落的是新文件，不是他选的那个）。 */
          if (!o.multiple) pick.clear();
          added.forEach(e => { const i = upPool.findIndex(x => x._ukey === e._ukey); if (i >= 0) upPool.splice(i, 1); upPool.unshift(e); });
          chBtn && chBtn.classList.add('on');
          /* 上传的条目在**任何**一档都看得见（`inView` 里 `_grp==='local'` 恒真），
             所以这里只重画、不切档 —— 以前那句 `setView(false)` 会把用户正看的「素材库」档
             无声换成「资产库」，传完一个文件眼前整排换了内容。 */
          refresh();
          /* 传上来的条目**也要进选中集合**：以前只 upPool.unshift，于是
             ① 计数条里没有它们，「已选 3 / 8」和实际拿到的 8 个对不上；
             ② 点「确定」交出的是 pick.list()，一个都传不出去 → 选完「加不进参考文件」。 */
          const got = pick.addMany(added);
          const bits = [];
          if (got) bits.push('已加入 ' + got + ' 个并选中');
          if (added.length > got) bits.push('最多 ' + cap + ' 个，多传的 ' + (added.length - got) + ' 个没选中（先取消一个再传）');
          if (tooBig) bits.push('有 ' + tooBig + ' 个超过' + (ruleText || '平台声明的上限') + '，没加进来');
          if (wrongType) bits.push('有 ' + wrongType + ' 个类型不符，没加进来');
          say(bits.join('　·　') || null);
        };
        inp.click();
      };

      /* ---------- 3D 白膜：现建 / 现挑一份，出成参考图或参考视频，直接进选中集合 ----------
         出的那一份**已经在本机资产库里**（capture.js 走 Api.saveLocalAsset），所以这里拿到的是一条
         正常的库条目：assetId + /asset/<id>。它进 upPool 之后与「本地上传」同一套语义 ——
         单值槽位先清后加、多个就累加、计数与选中集合都跟着走。 */
      const openModel3d = async chBtn => {
        if (!window.Model3D || !window.Model3D.quick) { say('建模台入口没装上：刷新页面再试'); return; }
        const want = o.types.includes('图片') ? 'image' : 'video';
        let got = null;
        try {
          got = await window.Model3D.quick({ want });
        } catch (e) {
          say('白膜弹窗打不开：' + window.errText(e));
          return;
        }
        if (!got) return;
        const t = got.type === '视频' ? '视频' : '图片';
        if (!okType(t)) { say('这个位置不收' + t); return; }
        if (maxBytes && Number(got.bytes) > maxBytes) { say('这一份超过这个槽位的体积上限'); return; }
        const name = String(got.name || '白膜');
        const entry = {
          assetId: got.assetId, src: got.src, dl: got.src, name, type: t,
          provider: 'local', providerName: '本机白膜', prompt: name.replace(/\.[^.]+$/, ''),
          ts: Date.now(), _grp: 'local', duration: null,
          format: (name.split('.').pop() || '').toLowerCase(),
          _ukey: 'm3d:' + got.assetId, _tkey: 'm3d:' + got.assetId,
        };
        if (!o.multiple) pick.clear();
        const i = upPool.findIndex(x => x._ukey === entry._ukey);
        if (i >= 0) upPool.splice(i, 1);
        upPool.unshift(entry);
        chBtn && chBtn.classList.add('on');
        refresh();
        const n = pick.addMany([entry]);
        say(n ? '已加入并选中「' + name + '」' : '最多 ' + cap + ' 个，先取消一个再加');
      };

      /* ---------- AI 搜索：把一句自然语言变成筛选条件（只筛现有条目，不生成） ---------- */
      const paintAiChip = () => {
        /* AI 挑出来的那句话要写在 chip 上而不是计数条上：paint() 每次重画都会覆盖 #apCnt，
           放那里的话「挑成功了」这条信息一闪就没了（看起来像点了没反应）。 */
        const sum = aiCond ? String(aiCond.summary || '') : '';
        window.AiChip.show('apAiChip', aiCond ? {
          cls: 'ap-aitag', clearId: 'apAiClear', iconSize: 11, tip: sum,
          text: window.AiChip.text([AiFind.LABEL, sum.slice(0, 18)]),
          onClear: () => { aiCond = null; paintAiChip(); paint(); },
        } : { on: false });
      };
      const runAiSearch = async () => {
        if (!window.TextAI) { cnt.textContent = '文字 AI 没加载出来：刷新页面再试'; return; }
        /* 要找的话就是上面搜索框里的文字：不再另外弹一个「输入需求」的窗口（两个框填同一件事，
           用户要在两处来回切换）。框里没写东西就当场说清楚并把光标送回去。 */
        const q = search.value.trim();
        /* 这一句与素材库 / 收藏 / 资产库那三处同一个字、同一个字数（公共层 `AiFind.shortWhy`），
           写在这里的副本以前还带一个「上面」—— 弹窗里本来就只有一个搜索框，指不着别的。 */
        const why = AiFind.shortWhy(q);
        if (why) {
          cnt.textContent = why;
          window.focusQuiet(search);
          return;
        }
        const btn = $('apAiBtn');
        window.aiBtnState(btn, true);
        cnt.textContent = AiFind.BUSY;
        try {
          const reg = await Api.registry();
          const names = base.slice(0, 200).map(e => ({
            名称: String(e.prompt || e.name || '').slice(0, 80), 类型: e.type,
            来源: e.providerName || '', 备注: (e._favRec && e._favRec.note) || '',
            日期: tsOf(e) ? new Date(tsOf(e)).toISOString().slice(0, 10) : null,
          }));
          const txt = await TextAI.chat(reg,
            '你是素材检索助手，只返回 JSON，不要解释或代码块标记。把需求翻译成：{"keywords":["关键词"],"after":"YYYY-MM-DD 或 null","order":"asc|desc","limit":30,"summary":"一句话"}',
            JSON.stringify({ 需求: q, 素材: names }));
          const j = TextAI.parseJson(txt);
          if (!j) throw new Error('AI 没有给出可用的条件');
          aiCond = j;
          paintAiChip(); paint();
          /* paint() 会重写计数条，所以这句要放在它后面，否则「AI 搜索：…」一闪就没了 */
          cnt.textContent = AiFind.LABEL + '：' + String(j.summary || q).slice(0, 46);
        } catch (e) {
          cnt.innerHTML = '<span class="err">' + esc(AiFind.failText(e))
            + ' —— 改一下搜索框里的说法再试</span>';
        } finally {
          window.aiBtnState(btn, false);
        }
      };
      const aiBtn = $('apAiBtn');
      if (aiBtn) aiBtn.onclick = runAiSearch;

      // 异步取数据：分批到达就分批画（慢的平台不影响先到的那批先显示）
      (async () => {
        const take = entries => {
          libPool = (entries || []).filter(e => e && e.kind === 'asset' && okType(e.type));
          ready = true;
          if (load.isConnected) load.remove();
          search.disabled = false;
          refresh();
        };
        try {
          /* 素材库那一档**先画**：名单是本机现读的（不等网络），而资产库那一批要几秒才到。
             库里那一列叫什么、字节存在哪，都留在 chars.js —— 这一层只按 `okType` 收这一次要的那一类。 */
          if (o.chars) {
            if (!window.Chars || !Chars.Pipe || !Chars.Pipe.libVoiceEntries) charErr = '这一页没加载素材库（chars.js）';
            else {
              try { charPool = Chars.Pipe.libVoiceEntries(o.chars).filter(e => okType(e.type)); }
              catch (er) { charErr = errText(er); }
            }
            ready = true;
            if (load.isConnected) load.remove();
            search.disabled = false;
            refresh();
          }
          /* 「音色描述」只可能写在素材身上，资产库 / 收藏 / 本机上传里根本没有这一类：
             那一档不必等注册表、也不必取资产库，取回来一个都用不上。 */
          if (charsOnly) { try { window.focusQuiet(search); } catch {} return; }
          /* 先用资产库页写下的列表缓存画一版底：列表在几十秒内几乎不变，
             而联网那 3 页要等一两秒 —— 以前这段时间弹窗里只有转圈，用户以为没打开。
             缓存只当底稿，真数据到了 take() 会整份覆盖（onBatch 每批都给全量）。 */
          try {
            const warm = AssetLib.listCache('assets_cache_v1').read()
              .filter(e => e && e.kind === 'asset' && okType(e.type));
            if (warm.length) take(warm);
          } catch (e) { /* 缓存只是一版底稿：读坏了就等真数据，弹窗照常往下走 */ }
          await Api.registry();                     // 收藏回源换地址要先有注册表
          const mine = window.Fav ? Fav.list().filter(x => okType(x.type)) : [];
          /* 收藏条目一次并发取地址（本地文件要读 IndexedDB）：
             以前渲染时才同步取 blob，第一次打开弹窗时地址还没就位 → 「我的收藏一片空白」。 */
          favPool = (await Promise.all(mine.map(async x => {
            const e = await Fav.asEntry(x).catch(() => null);
            if (!e) return null;
            e._grp = 'fav'; e.fav = true; e._favRec = x;
            /* 缩略图键：只有**本地文件收藏**要自己给一个稳定键（blob 地址每次都变，
               拿它当键等于永远命不中缓存）。平台产物那一类**不再另起键名** ——
               键只由 Wb.thumbs.keyOf(地址) 归一化算出（签名剥掉、有本机副本就并到 /asset/ 那一条）。
               以前这儿自造了一个 'fav-asset:平台:id'，于是同一份视频在「我的收藏」这一档抽一次、
               在资产库/列表那一档再抽一次，两份缓存互不相干 —— 就是「各个页面的预览不复用」。 */
            e._tkey = x.kind === 'local' && x.fileKey ? 'fav-file:' + x.fileKey : '';
            return e;
          }))).filter(Boolean);
          refresh();
          const res = await AssetLib.load({
            ...(opts && opts.pages ? { pages: opts.pages } : { pages: 3 }),
            kinds: o.kinds,
            onBatch: take,
          });
          take((res && res.entries) || []);
          try { window.focusQuiet(search); } catch {}
          /* 列表覆盖不到的收藏：按任务号现场回源换新鲜地址（签名过期的 /getv 会 403）。
             放后台跑，别让它拖住列表；限量与并发都在 Fav.resignSome 里。 */
          if (!window.Fav) return;
          const covered = new Set(libPool.map(dKey));
          const byKey = {};
          favPool.forEach(e => { if (e._favRec && !covered.has(dKey(e))) byKey[e._favRec.key] = e; });
          await Fav.resignSome(Object.keys(byKey).map(k => byKey[k]._favRec), (rec, next) => {
            const e = byKey[rec.key];
            if (!e || next === e.src) return;
            e.src = next; e.dl = next; repaint(e);
          });
        } catch (e) {
          if (load.isConnected) load.innerHTML = '<span style="color: var(--err)">资产库加载失败：' + window.esc(errText(e, '请检查网络或密钥')) + '</span>';
        }
      })();
    });
  },
};
