/* 资产库列表层：AssetLib（读 /registry 的 list 声明，平台无关）+ 费用口径
   （AssetLib.costOf / estimateCost）。从 assetlib.js 原文件拆出；
   依赖 api.js 的 Api 与顶层函数（mediaSrc / classifyStatus / assetSrc / topBoolValue），
   加载顺序见 shell.html（api.js → assetlib.js → gen-forms.js）。
   条目：{ kind:'asset'|'task', id, genId?, type('图片'|'视频'), providerName, provider,
          format, prompt, src, dl, ts, status('done'|'running'|'queued'|'failed'), duration?, size? } */

/* ============================================================================
   AssetLib —— 生成内容列表（读 /registry 的 list 声明，平台无关）
   ========================================================================== */
(function () {
  /* 取对象点路径（'parameters.quality'） */
  function pickPath(o, path) {
    if (!path) return undefined;
    return String(path).split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
  }
  /* 媒体类型：声明优先（fixed / by+前缀），否则按 provider.kind */
  function classifyMedia(prov, spec, raw) {
    const md = spec.media || {};
    if (md.fixed) return md.fixed;
    if (md.by) {
      const v = String(pickPath(raw, md.by) || '');
      if ((md.videoPrefix || []).some(x => v.startsWith(x))) return '视频';
      if ((md.imagePrefix || []).some(x => v.startsWith(x))) return '图片';
      return md.fallback || (prov.kind === 'video' ? '视频' : '图片');
    }
    return prov.kind === 'video' ? '视频' : '图片';
  }
  /* 「这一条该按什么号去提示词归档里问」的判据只在 PromptLog.askId 一处（同文件，跨闭包走 window）：
     本机资产库里那条的 id 是 `la_xxx`，那是**本机文件号、不是任务号**，拿它去问永远 404。
     落盘时把当时的任务号一起留在了本机索引里（registry 的 `list.map.task`），所以本机条目
     也认得出自己是哪一次生成的。 */
  /* 上游条目 → 标准条目（字段全部来自 list.map 声明）。
     外面再包一层 normalize()：先按声明解析，再交给 AssetLocal.decorate 决定这条该显示
     本机副本还是平台地址 —— **全项目只有这一个地方产出条目**，所以本地镜像这一层
     不用各页自己接一遍（以前各页各写一遍的结果就是有的页看得到、有的页永远是裂图）。 */
  function normalizeRaw(prov, spec, raw) {
    const m = spec.map || {};
    const g = k => pickPath(raw, m[k]);
    const media = classifyMedia(prov, spec, raw);
    /* gstatus 保留「上游原话（statusMap 映射过）」给用量页展示；分支判定一律走 classifyStatus ——
       以前这里只认 'queued' / 'running' 是活的，creating / pending / processing 全被算成失败卡。 */
    const gstatus = (spec.statusMap || {})[g('status')] || g('status') || 'running';
    const st = classifyStatus(spec, g('status'));
    /* 扩展名走全站那一份读法（ui.js 的 `fileExtOf`）：先认平台声明的 format，
       认不出才按类型兜底。以前这一句是 `media === '视频' ? 'mp4' : (g('format') || 'png')` ——
       「png」兜到了**音频**头上：一条没声明 format 的语音任务在数据层就带着 `format:'png'`，
       于是资产库 / 收藏 / 助手卡片上的下载名（含这里拼的 `?dl=1&name=`）全是 .png，
       页面那一层再怎么改也只是在替它猜。 */
    const fmt = window.fileExtOf({ mtype: media, format: g('format') });
    const credits = (() => {
      const c = g('credits');
      if (c == null) return null;
      return (typeof c === 'object') ? (c.charged ?? c.held ?? null) : c;
    })();
    const priceMicros = g('priceMicros');
    /* 本机资产库（local:/local-assets）是**多家平台共用的一条列表来源**：
       同步返回的那几家（语音 / 生图）产物都落在同一个索引里，条目自己记着是谁生成的
       （保存时写进了 provider）。按它归属性 —— 否则先读到的那家会把后面读到的全标成自己，
       卡片「平台」那一行就成了假话（生出来的图写着「MiMo」）。 */
    const selfProvId = spec.selfAsset ? String((raw && raw.provider) || '') : '';
    const routedId = (prov.mediaProviders && prov.mediaProviders[media]) || '';
    const providerId = routedId || (selfProvId && selfProvId !== prov.id ? selfProvId : prov.id);
    const ownProv = (providerId && providerId !== prov.id && providerId !== routedId && window.Api)
      ? (window.Api.prov(providerId) || null) : null;
    /* 归属要说真话：provider 注记解析不到注册表平台（'local' /「本机」那一批）就写「本机」——
       以前一律落到来源那家的 displayName，本机 PNG 在卡片上挂着语音平台的名字。 */
    const providerName = (ownProv && (ownProv.displayName || ownProv.name))
      || ((spec.selfAsset && !routedId && providerId !== prov.id && !ownProv) ? '本机' : '')
      || prov.displayName || prov.name;
    // 上游没给 prompt 时用本机记录兜底（例如 VGENV 的接口不返回它），并标注来源
    const rawPrompt = g('prompt') || '';
    /* 归档按平台任务号查（判据只有一处：PromptLog.askId，见 refillPrompts）；
       本机条目那是索引里留下的 detail.task。这一层还认不出产物号（assetId 在下面按产物拆行时才定），
       所以只递任务号与条目 id 两个。 */
    const askId = (window.PromptLog && window.PromptLog.askId({ taskId: g('taskId'), id: g('id') })) || '';
    /* 提示词折算只有 AssetLib.promptOf 一份（工具查任务详情时也调它），这里只把本次的原料递进去 */
    const pz = (window.AssetLib && AssetLib.promptOf)
      ? AssetLib.promptOf({ prompt: rawPrompt, taskId: askId, provider: prov.id }, providerId)
      : { prompt: rawPrompt, local: false };
    const localPrompt = pz.prompt;
    const base = {
      type: media, provider: providerId, providerName, format: fmt,
      prompt: rawPrompt || localPrompt || '',
      promptLocal: !rawPrompt && !!pz.local,
      ts: g('completed') || g('created') || '',
      genId: g('id'), taskId: askId, gstatus, model: g('model'), mode: g('mode'),
      credits, creditsRaw: g('credits'),
      priceMicros: priceMicros != null ? Number(priceMicros) : null,
      currency: g('currency') || null,
      created: g('created'), completed: g('completed'),
      quality: g('quality'), ar: g('ar'), count: g('count'),
      duration: (media === '视频' || window.isAudioType(media)) ? (g('duration') ?? null) : null,
      tier: g('tier'), res: g('res'),
    };
    // 声明里多出来的字段（chars / tokens / byteLength 等）原样带到条目上，页面按需使用
    Object.keys(m).forEach(k => { if (!(k in base)) { const v = g(k); if (v !== undefined) base[k] = v; } });
    const outs = g('outputs');         // 产物 id 列表（如 output_asset_ids）
    // 或直接给可播放 URL；给不出时兜底用 retrieve 环节换回来的（raw.__url）
    const outUrl = g('outputUrl') || raw.__url || null;
    if (spec.selfAsset) base.localAsset = true;    // 本地落盘的产物：界面上可以删除
    if (st === 'done') {
      if (spec.selfAsset) {                          // 声明「条目即资产」：本地生成产物（语音等）
        return [{ ...base, kind: 'asset', id: base.genId, assetId: base.genId, status: 'done', localSelf: true,
          src: assetSrc(base.genId),
          dl: assetDl(base.genId, (base.prompt || 'file').slice(0, 20) + '.' + fmt) }];
      }
      if (Array.isArray(outs) && outs.length) {
        /* ⚠ 这一支以前**不带 rawSrc**，而 `AssetLocal.scan` 唯一认的就是 rawSrc ——
           于是「平台返回产物 id」这一族（最常见的一族）永远排不上镜像，
           「产物自动存本机」表现为「开了也没用」。dl 就是取字节的入口（`/fetch?...&dl=1`），
           代理那边照样能下（它走的是同一道同源检查），所以地址来源写在这里。 */
        return outs.map(aid => ({ ...base, kind: 'asset', id: aid, assetId: aid, status: 'done',
          /* 这一次请求出了几份产物：`AssetLib` 拿它判断「能不能用任务号认本机镜像」——
             多图任务按任务号合会把四张并成一张，一次就够毁掉整排卡。 */
          outCount: outs.length,
          src: assetSrc(aid),
          dl: assetDl(aid, (base.prompt || 'file').slice(0, 20) + '.' + fmt) }));
      }
      // 外链产物（如 VGENV 的签名地址）统一换成 /getv 本地路由：显示、抽帧、量体积都同源
      if (outUrl) return [{ ...base, kind: 'asset', id: base.genId, status: 'done', outCount: 1,
        src: mediaSrc(outUrl), rawSrc: outUrl, dl: '/fetch?url=' + encodeURIComponent(outUrl) + '&dl=1' }];
      // 状态已成功但产物字段还没写入（接口竞态）：按「生成中」处理，刷新后自愈
      return [{ ...base, kind: 'task', id: base.genId, status: 'running', failMsg: '' }];
    }
    if (st === 'queued' || st === 'running') {
      /* 卡片上写的是标准状态（'queued' / 'running'），原始措辞留在 gstatus 里给用量页展示 ——
         以前这里把 gstatus 直接当 status，陌生的中间态（creating / processing）就落进了下面的失败分支。 */
      return [{ ...base, kind: 'task', id: base.genId, status: st }];
    }
    return [{ ...base, kind: 'task', id: base.genId, status: 'failed', failMsg: g('error') || '' }];
  }
  /* 解析 + 本地镜像装饰（decorate 只对资产条目做处理，任务条目原样返回） */
  function normalize(prov, spec, raw) {
    /* 本机资产库的每一行都顺手把镜像身份认回来（浏览器那一份索引丢了也能接上，见 AssetLocal.learn）。
       认回必须在 decorate 之前 —— 同一批里平台那一条要靠这个键与本机那条合成一张卡。 */
    if (spec.selfAsset && window.AssetLocal) AssetLocal.learn(raw);
    let out;
    try { out = normalizeRaw(prov, spec, raw); } catch (e) { return []; }
    return (Array.isArray(out) ? out : []).map(e => (window.AssetLocal ? AssetLocal.decorate(e) : e));
  }
  /* ---------- 「同一个产物只留一张卡」----------
     产物自动存本机之后，一次生成在列表里出现两条：平台那一条（带任务号、型号、积分、状态）
     与本机镜像那一条（la_xxx，带当年提交时的提示词）。它们指向的是同一个文件
     —— 「优先用本机文件」时连地址都一模一样，界面上就是「同一个任务重复出现」。
     合并取向固定：**留平台那一条当载体**（它信息更全，删了还能回平台查），
     把本机那条独有的字段交给它。提示词是最常缺的一项：VGENV 的列表接口不返回 prompt，
     而镜像时把提交那一刻的提示词留在了本机索引里 —— 于是以前空白的那张卡其实有话可说。 */
  const AL_TWIN = e => (window.AssetLocal && AssetLocal.twinOf ? AssetLocal.twinOf(e) : '');
  const platSide = e => !!(e && e.mirrorKey);      // decorate 认出来的那条来自平台列表
  /* ---------- 结果级短缓存----------
     同一组参数（来源 / 类型 / 页数 / accept）在 30 秒内重复 load，直接用上一份结果：
     首屏两次 fetchMore、选择器每次打开都 3 页、资产库与工作台前后脚打开，都会各拉一遍全量，
     而上游列表在几十秒内几乎不会变。只缓存**第一次取**（带 out / cursors / more 的续拉不进缓存），
     数总数那种 `prompts:false` 也不进；`opts.noCache` 跳过命中并重写。
     条目按浅拷贝存/取：调用方会往上挂 `_grp` / 本机地址等展示态字段，不能让它改到缓存本体。 */
  const LOAD_RESULT_CACHE = new Map();
  const LOAD_RESULT_TTL = 30000;
  const loadResultKey = opts => JSON.stringify({
    pages: opts.pages ?? 2,
    kinds: opts.kinds || null,
    ids: opts.ids || null,
    accept: typeof opts.accept === 'function' ? String(opts.accept) : '',
  });
  const loadCacheable = opts => !opts.out && !opts.cursors && !opts.more && opts.prompts !== false;
  const cloneEntries = arr => (Array.isArray(arr) ? arr : []).map(e => Object.assign({}, e));
  function fillTwin(keep, drop) {
    if (!drop) return keep;
    if (!keep.prompt && drop.prompt) { keep.prompt = drop.prompt; keep.promptLocal = !!drop.promptLocal; }
    if (keep.byteLength == null && drop.byteLength != null) keep.byteLength = drop.byteLength;
    if (!keep.model && drop.model) keep.model = drop.model;
    if (!keep.dl && drop.dl) keep.dl = drop.dl;
    return keep;
  }
  /* 换成保留的那一条时要**占住原来那个位置**（列表顺序就是界面顺序，挪到末尾等于乱了时间线） */
  function swapIn(list, drop, keep) {
    if (!drop || drop === keep) return;
    const at = list.indexOf(drop);
    if (at >= 0) list[at] = keep; else list.push(keep);
  }
  /* 合并一条进 { out, twins }：**增量**（pushEntry，拉到一页合一页）与
     **整表**（collapseTwins，页面首屏那份 localStorage 缓存里还留着合并前的重复，
     只在新批次里去重不够）用的是同一条规则，所以规则只写这一份，
     两个入口只是「容器从哪来」不同 —— 以前两段 13 行几乎逐行相同，
     改一边忘了另一边，症状是同一份产物在某些页合卡、某些页不合。 */
  function collapseInto(st, e) {
    const tk = AL_TWIN(e);
    if (!tk) { st.out.push(e); return; }
    const prev = st.twins.get(tk);
    if (!prev) { st.twins.set(tk, e); st.out.push(e); return; }
    /* 留平台那一条当载体（它信息更全，删了还能回平台查），把本机那条独有的字段搬过去 */
    const cur = platSide(e) && !platSide(prev) ? e : prev;
    fillTwin(cur, cur === prev ? e : prev);
    if (cur !== prev) swapIn(st.out, prev, cur);   // 换载体时要占住原来那个位置（列表顺序就是界面顺序）
    st.twins.set(tk, cur);
  }
  const pushEntry = (st, e) => collapseInto(st, e);
  function collapseTwins(list) {
    const st = { out: [], twins: new Map() };
    (list || []).forEach(e => collapseInto(st, e));
    return st.out;
  }

  /* 拉一个来源的若干页：游标不前进 / 后续页失败 → 视为到底（不阻塞其它平台） */
  async function listOne(src, st) {
    const prov = src.prov, spec = src.spec, key = src.key;
    if (st.more[key] === false) return;
    const limitParam = spec.limitParam || 'limit';
    const cursorParam = spec.cursorParam || 'cursor';
    let cursor = st.cursors[key] || '';
    for (let page = 0; page < st.pages; page++) {
      if (st.more[key] === false) break;            // 上一页已到底：不再请求（否则会重复拉第一页）
      const query = new URLSearchParams();
      query.set(limitParam, String(spec.limit || LIST_LIMIT_DEF));
      if (cursor) query.set(cursorParam, cursor);
      let d = null;
      try {
        d = await Api.request(prov, 'list', { query, noCache: st.noCache });
      } catch (e) {
        /* 读取失败只是「本次到此为止」，**不把来源标记成到底**（不能设 more=false）——
           否则一次网络抖动 / 上游 5xx 之后，这个平台在本次会话里永远不会再翻页，
           「加载更多」点了也没反应。错误照旧交给调用方（界面提示 + 可重试）。 */
        st.errors[key] = (st.errors[key] || e.message);
        st.failed[key] = true;
        console.warn('[AssetLib] ' + (prov.name || prov.id) + (cursor ? ' 翻页失败（检查游标参数声明）' : ' 列表读取失败') + '：', e.message);
        break;
      }
      const items = (spec.dataField ? d[spec.dataField] : d.data) || [];
      /* 逐条解析并就地兜错：以前一条脏数据（缺字段、类型不对）让 normalize 抛错，
         整个来源的 promise 就 rejected —— 被 allSettled 静默吞掉，表现是「这个平台的内容全不见了」。
         现在跳过坏条目、记一条可读提示（界面会显示「部分内容加载失败」）。 */
      let skipped = 0;
      const want = (typeof st.accept === 'function') ? st.accept : null;
      items.forEach(raw => {
        try {
          normalize(prov, spec, raw).forEach(entry => { if (!want || want(entry)) pushEntry(st, entry); });
        }
        catch (e) { skipped++; console.warn('[AssetLib] 条目解析失败（已跳过）', e, raw); }
      });
      if (skipped) st.errors[key] = '有 ' + skipped + ' 条数据解析失败（已跳过，不影响其它条目）';
      const next = Api.listCursor(prov, d);
      const firstId = items.length ? pickPath(items[0], (spec.map || {}).id || 'id') : null;
      if (!next || next === cursor || (firstId != null && firstId === st.lastFirst[key])) {
        st.more[key] = false;                       // 没有下一页 / 游标没前进 → 到底
      } else {
        cursor = next; st.lastFirst[key] = firstId;
      }
      st.cursors[key] = cursor;
      st.emit();
    }
  }

  /* 索引窗口之外的任务：按任务号回源补，**不 await** —— 补完就地改写条目再 emit 重绘，
     首屏不为它多等一个请求。判据、限量与「问过就不再问」全在 PromptLog.refill 那一份里。 */
  function refillPrompts(st, limit = 20) {
    const P = window.PromptLog;
    if (!P || !P.refill) return;
    P.refill(st.out, { limit, onDone: () => st.emit() });
  }

  /* 按任务号 / 产物号反查本机缓存里的那一条。两份缓存都要扫
     （`assets_cache_v1` 资产库 / `studio_tasks_cache_v1` 工作台），同一份产物出现两次时取 ts 较新的。
     找不到返回 null（**不抛**）：调用方要把它翻成一句照实说的话。 */
  function findCached(kind, id, providerId) {
    const want = String(id == null ? '' : id).trim();
    if (!want) return null;
    const prov = String(providerId || '').trim();
    const keys = ['assets_cache_v1', 'studio_tasks_cache_v1'];
    const hits = [];
    let exact = [], loose = [];
    const score = e => {
      const t = e && e.ts;
      if (typeof t === 'number') return t > 1e12 ? t : t * 1000;
      const n = Date.parse(String(t || ''));
      return Number.isFinite(n) ? n : 0;
    };
    for (const k of keys) {
      let arr = [];
      try { arr = window.AssetLib.listCache(k).read(); } catch (e) { arr = []; }
      for (const e of (arr || [])) {
        if (!e || (prov && String(e.provider || '') !== prov)) continue;
        const ids = [e.assetId, e.genId, e.taskId, e.id].map(x => String(x == null ? '' : x));
        if (kind === 'asset' && ids[0] === want) exact.push(e);
        else if (kind === 'task' && (ids[1] === want || ids[2] === want)) exact.push(e);
        else if (ids.indexOf(want) >= 0) loose.push(e);
      }
    }
    hits.push(...exact, ...loose);
    if (!hits.length) return null;
    hits.sort((a, b) => score(b) - score(a));
    return hits[0];
  }

  window.AssetLib = {
    /* 一页多少条的兜底值（与 `Api` 那六个列表调用点同一份）：页面要把「跳到第 N 页」换算成
       「拉几批」时问这里，不许在自己文件里再写一个 100。 */
    LIST_LIMIT_DEF,
    /* 上游条目 → 媒体类型（'图片' / '视频' / …）：判定规则完全来自 registry 的 list.media 声明
       （fixed / by + 前缀 / fallback），页面不要再自己写模型名前缀正则。
       同一 relay 的图/视频共用一个列表接口时，页面要靠它分辨哪条属于自己。 */
    mediaOf(prov, raw) { return classifyMedia(prov, (prov && prov.list) || {}, raw); },
    /* 时间戳归一化为「毫秒」：兼容 ISO 字符串与数字（秒或毫秒） */
    tsMs(v) {
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return v > 1e12 ? v : Math.round(v * 1000);
      const t = Date.parse(v);
      return isNaN(t) ? 0 : t;
    },
    /* 日期闸：把界面上的「本地日」字符串（'YYYY-MM-DD'，日期输入框与 dayKey 给的都是这一种）
       折成这一天的**本地**零点与最后一毫秒。
       为什么全站要有这一份：`Date.parse('2026-10-19')` 按规范当 **UTC 午夜** 解，东八区就是
       「当天 08:00 起」—— 选「今天」时凌晨做的那几条被筛掉，而日期条上明明写着今天；
       右边 `+86400000` 那一档同样差 8 小时。资产库的日期档、AI 条件、素材选择器共用这一处。 */
    dayRange(fromKey, toKey) {
      const parts = s => {
        const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s == null ? '' : s).trim());
        return m ? [+m[1], +m[2] - 1, +m[3]] : null;
      };
      const a = parts(fromKey), b = parts(toKey);
      return {
        from: a ? new Date(a[0], a[1], a[2], 0, 0, 0, 0).getTime() : null,
        to: b ? new Date(b[0], b[1], b[2], 23, 59, 59, 999).getTime() : null,
      };
    },
    /* 一条资产被哪些地方引用：导演台工作区 / 我的收藏 / 画布工程。
       读不到的那一类放进 unknown（「不知道」不等于「没有引用」），页面据此禁用删除并说明。
       不扫 DOM、不猜路径：每一类都读它自己的持久化本体。 */
    async usages(id) {
      const target = String(id || '');
      const items = [];
      const unknown = [];
      if (!target) return { items, unknown };
      /* 只认**身份字段上的精确相等**，不再把整条记录 stringify 后做子串匹配：
         `la_12` 会命中 `la_123`（用户点删除时被一条根本没引用它的镜头拦住），
         也会命中提示词/文件名里碰巧出现的那几个字。
         地址字段允许「从中取出 /asset/<号>」再比 —— 本机产物在记录里常常只以地址形态存在。 */
      const eq = v => v != null && String(v) === target;
      const inUrl = v => {
        if (v == null) return false;
        const s = String(v);
        if (s === target) return true;
        const m = /\/asset\/([A-Za-z0-9_-]+)/.exec(s);
        return !!(m && m[1] === target);
      };
      const hitShot = sh => {
        if (!sh || typeof sh !== 'object') return false;
        if (sh.refVideo && eq(sh.refVideo.asset_id)) return true;
        if (sh.refAudio && eq(sh.refAudio.asset_id)) return true;
        if ((sh.keyframes || []).some(k => k && (eq(k.assetId) || inUrl(k.src)))) return true;
        return (sh.candidates || []).some(c => c && (eq(c.assetId) || inUrl(c.url) || inUrl(c.src)));
      };
      const hitVoice = v => !!v && typeof v === 'object'
        && (eq(v.assetId) || inUrl(v.src) || inUrl(v.refAudio) || eq(v.refAssetId));
      const hitFav = f => {
        if (!f || typeof f !== 'object') return false;
        if (eq(f.assetId) || eq(f.genId) || eq(f.localAsset) || eq(f.localAssetId)) return true;
        if (inUrl(f.src) || inUrl(f.dl) || inUrl(f.rawSrc) || inUrl(f.upstream)) return true;
        /* 收藏键是 `a:<平台>:<资产号>`：只比最后一段（整串永远不等于一个资产号） */
        const tail = String(f.key || '').split(':').pop();
        return !!tail && tail === target;
      };
      try {
        if (window.Kv && window.Kv.at) {
          const ws = await window.Kv.at('ws').get('workspace');
          if (ws) {
            for (const p of (Array.isArray(ws.projects) ? ws.projects : [])) {
              const pname = p && (p.name || p.title) ? (p.name || p.title) : '未命名';
              let n = 0;
              for (const sc of (Array.isArray(p && p.scenes) ? p.scenes : [])) {
                for (const sh of (Array.isArray(sc && sc.shots) ? sc.shots : [])) {
                  n++;
                  if (hitShot(sh)) items.push({ kind: 'workspace', label: '导演台 · ' + pname + ' · 第 ' + n + ' 镜', at: '' });
                }
              }
              for (const v of (Array.isArray(p && p.voices) ? p.voices : [])) {
                if (hitVoice(v)) items.push({ kind: 'workspace', label: '导演台 · ' + pname + ' · 配音', at: '' });
              }
            }
          }
        } else unknown.push('导演台工作区');
      } catch (e) { unknown.push('导演台工作区'); }
      try {
        if (window.Fav) {
          for (const f of window.Fav.list()) {
            if (hitFav(f)) items.push({ kind: 'favorite', label: '我的收藏 · ' + String(f.prompt || f.name || '一条').slice(0, 24), at: '' });
          }
        }
      } catch (e) { unknown.push('我的收藏'); }
      return { items, unknown };
    },
    /* 加载生成内容（支持增量/分批，平台无关）
       opts.pages     本次每个来源再拉几页（默认 2）
       opts.onBatch   每拉完一页回调一次（渐进渲染，先到的先显示）
       opts.out/seen  续拉时传入上一次的条目与去重集合
       opts.cursors/more  上次返回的游标状态（原样传回即可接着拉）
       opts.kinds/ids 只加载某类来源（如语音工作台只读 kind:'audio' 的平台，别去等其他平台）
       opts.accept    只要满足条件的**标准条目**（如资产库/工作台只数某类媒体）：
                      过滤发生在解析阶段，不关心的条目根本不会进 out（也不进 onBatch）
       opts.prompts   false = 不碰提示词归档（默认会先读索引、再给缺提示词的条目回源补）
       返回 { entries, cursors, more, hasMore } */
    async load(opts = {}) {
      if (opts.reg) Api.setRegistry(opts.reg);
      const cacheKey = loadCacheable(opts) ? loadResultKey(opts) : '';
      if (cacheKey && !opts.noCache) {
        const hit = LOAD_RESULT_CACHE.get(cacheKey);
        if (hit && Date.now() - hit.at < LOAD_RESULT_TTL) {
          const entries = cloneEntries(hit.entries);
          if (typeof opts.onBatch === 'function') {
            try { opts.onBatch(entries); } catch (e) { console.warn('[AssetLib] onBatch 回调出错：', e); }
          }
          return { entries, cursors: { ...hit.cursors }, more: { ...hit.more }, hasMore: hit.hasMore,
            errors: { ...hit.errors }, failed: { ...hit.failed }, cached: true };
        }
      }
      await Api.registry();
      /* 镜像指针从 IndexedDB 读回来再开始解析：否则首屏用 localStorage 的暖启动缓存
         （最近 2000 条）判本机副本，老产物会先显示成「云端」再跳回「本机」。
         最多等 1.2 秒，读不出来照旧往下走（缓存 + 代理列表还能认回来）。 */
      if (window.AssetLocal && AssetLocal.ready) {
        try { await Promise.race([AssetLocal.ready(), new Promise(r => setTimeout(r, 1200))]); } catch (e) {}
      }
      /* 提示词归档索引先就位（60 秒内不重复请求，失败也只是不补显示）：
         不等它的话，首屏卡片会先渲染成「（该平台接口不返回提示词）」，要手动刷新才好看齐。
         但最多只等 2 秒（第一次用要扫整个归档目录，可能好几秒）：
         没赶上的条目由 refillPrompts() 按任务号回源补，不能让它拖慢列表。 */
      if (window.PromptLog && opts.prompts !== false) {
        try { await Promise.race([PromptLog.load(), new Promise(r2 => setTimeout(r2, 2000))]); } catch (e) {}
      }
      const st = {
        pages: opts.pages ?? 2,
        cursors: (opts.cursors && typeof opts.cursors === 'object') ? { ...opts.cursors } : {},
        more: (opts.more && typeof opts.more === 'object') ? { ...opts.more } : {},
        lastFirst: {},
        seen: (opts.seen instanceof Set) ? opts.seen : new Set(),
        twins: new Map(),        // 镜像身份 → 结果里那一条（见 pushEntry）
        out: Array.isArray(opts.out) ? opts.out : [],
        /* 已经交给 `AssetLocal.scan` 过的条目。按**对象身份**记而不是按下标：
           `collapseTwins` 会把 out 就地缩短，下标会错位。scan 本身是幂等的
           （已镜像的条目在 `read().m[k]` 处就 return 'saved'），所以只喂这一批新到的即可 ——
           以前每次 emit 都对**整份不断变长的 out** 扫一遍，emit 次数 ≈ 16~24 次，是 O(n²)。
           `st` 每次 load 都是新的（续拉时 opts.out 会重新登记一遍），所以跨轮不会漏扫。 */
        emitted: new WeakSet(),
        onBatch: (typeof opts.onBatch === 'function') ? opts.onBatch : null,
        accept: (typeof opts.accept === 'function') ? opts.accept : null,
        emit() {
          /* 后到的一批会把镜像身份**认回**索引（AssetLocal.learn），可早到的那一批是在那之前
             decorate 的：地址还挂在平台外链（勾了「优先用本机文件」也换不过来），同一产物的两条
             也各占一张卡 —— 表现就是用户说的「视频没有预览图、要等下一次加载才好」「同一个任务重复出现」。
             所以每次 emit 前把这两件事现算一遍：decorate 是幂等的（没镜像时原样返回），
             合表判据仍然只有 twinOf 一处，不另编第二套。
             数组**就地改**（不换 `st.out` 的引用）：续拉时页面把自己那份数组递进来，
             引用一换它后面的合并就落在旧数组上。 */
          const A = window.AssetLocal;
          /* settleEntries 是 **AssetLib** 上的方法（不是这一份 loader 状态上的）——
             以前写成 this.settleEntries，emit 一跑就 TypeError（首屏缓存那条路因此对不上）。
             这一份只管塌表与镜像，合表判据仍然只有 AssetLib.settleEntries 一处。 */
          const AL = window.AssetLib;
          const kept = (AL && AL.settleEntries) ? AL.settleEntries(this.out) : this.out.slice();
          if (kept.length !== this.out.length) {
            /* 就地改，不换引用（同上）。twins 里因此留着已删条目的记录不要紧：
               下一次同产物的批次最多把一个不在表里的对象当 prev，紧接着这一趟塌表又会把它纠正过来。 */
            this.out.length = 0;
            kept.forEach(e => this.out.push(e));
          }
          /* 每批到达就顺手把这批产物排去存本机（而不是等整个 load 结束）：
             列表动辄十几秒才拉完，等它结束再开始镜像，用户看到的头几分钟全是没本机副本的。
             只喂**这一批新到的**条目：scan 幂等，重复扫已经镜像过的只是白跑一次
             `offer` → 一次同步 `localStorage.getItem`。 */
          try {
            if (A && A.scan) {
              const fresh = this.out.filter(e => e && !this.emitted.has(e));
              if (fresh.length) { A.scan(fresh); fresh.forEach(e => this.emitted.add(e)); }
            }
          } catch (e) {}
          if (!this.onBatch) return;
          try { this.onBatch(this.out); } catch (e) { console.warn('[AssetLib] onBatch 回调出错：', e); }
        },
      };
      st.errors = {};
      st.failed = {};                      // 本次有读取失败的来源（more 保持 true：界面可重试）
      st.noCache = !!opts.noCache;
      /* 「续拉」时页面把上次那份数组递回来（out: assets）：那里面已经有的产物先登记，
         否则这一次列表刷新会把它自己的镜像当成新条目再插一张卡（重复只会在翻页后出现）。 */
      st.out.forEach(e => { const tk = AL_TWIN(e); if (tk && !st.twins.get(tk)) st.twins.set(tk, e); });
      const srcs = Api.listSources({ kinds: opts.kinds, ids: opts.ids });
      await Promise.allSettled(srcs.map(src => listOne(src, st)));
      if (opts.prompts !== false) refillPrompts(st);
      const hasMore = srcs.some(src => st.more[src.key] !== false);
      if (cacheKey) {
        LOAD_RESULT_CACHE.set(cacheKey, {
          at: Date.now(), entries: cloneEntries(st.out),
          cursors: { ...st.cursors }, more: { ...st.more }, hasMore,
          errors: { ...st.errors }, failed: { ...st.failed },
        });
        while (LOAD_RESULT_CACHE.size > 24) LOAD_RESULT_CACHE.delete(LOAD_RESULT_CACHE.keys().next().value);
      }
      return { entries: st.out, cursors: st.cursors, more: st.more, hasMore, errors: st.errors, failed: st.failed };
    },
    /* 后台数总数（分页文案要显示精确的「共 N 页」用；界面见 Wb.tally）。
       平台的列表接口只有游标与 has_more，没有总数，只能一页页翻到底数出来 ——
       所以这里按**来源声明的 limit（一般 100）**走游标，比按页面每页 12 条翻到底便宜一个量级
       （101 条图片 = 2 个请求，而不是 9 个）。
       opts.kinds/ids/reg/pages/accept 与 load 同义；accept(entry) 用来只数这一页关心的条目
       （例如视频台只数 type:'视频'）。maxPages（默认 10 页 = 约 1000 条）到底前用完时
       返回 exact:false，让界面继续显示「共 M+ 页」，不要把用户引到「数完了」的假承诺上。
       返回 { total, exact, assetIds } —— total 是**去重后的条目数**，和右栏卡片数同一个口径
       （多图任务按 normalize 展开后的每个产物各算一条）；assetIds 是这些条目的产物 id 集合，
       页面要把它和本地任务记录混排时用来去重（语音台：还没落成资产的本地记录另算）。 */
    async countAll(opts = {}) {
      const maxPages = Math.max(1, Number(opts.maxPages) || 10);
      /* opts.from = { pages, cursors, more, entries }：调用方已经翻到的位置，从那儿接着数
         （pages 是已翻页数，所以这一趟只补剩下的预算；entries 复制一份，load 会就地塌表）。
         没有它，后台计数会把首屏已经拿回来的页每个来源再取一遍。 */
      const from = (opts.from && typeof opts.from === 'object') ? opts.from : null;
      const done = from ? Math.max(0, Number(from.pages) || 0) : 0;
      const res = await this.load({
        pages: Math.max(1, maxPages - done), kinds: opts.kinds, ids: opts.ids, reg: opts.reg,
        accept: opts.accept,            // 逐条过滤：不关心的条目根本不进结果（少占内存）
        prompts: false,                 // 只数条数，不补提示词（别为数个数去翻归档）
        out: from && Array.isArray(from.entries) ? from.entries.slice() : [],
        seen: new Set(),
        cursors: from ? from.cursors : null,
        more: from ? from.more : null,
      });
      const keys = new Set(), assetIds = new Set();
      (res.entries || []).forEach(e => {
        keys.add(window.AssetLib.entryKey(e));
        const aid = e.assetId || e.id;
        if (aid != null) assetIds.add(String(aid));
      });
      // 有任何来源读失败（res.failed）时 hasMore 也一定还是 true，所以 exact 这一条同时覆盖两种不精确
      return { total: keys.size, exact: !res.hasMore, assetIds };
    },
    /* 读某个来源「当前真的存在」的条目 key 集合（只读一页）。
       只对「一页即全量」的来源有意义：selfAsset 的本地资产库（删除文件后要据此清掉本机缓存里的旧条目）。 */
    async liveKeys(prov) {
      const spec = (prov && prov.list) || null;
      if (!spec) return null;
      const query = new URLSearchParams();
      query.set(spec.limitParam || 'limit', String(spec.limit || LIST_LIMIT_DEF));
      const d = await Api.request(prov, 'list', { query });
      const items = (spec.dataField ? d[spec.dataField] : d.data) || [];
      const keys = new Set();
      items.forEach(raw => normalize(prov, spec, raw).forEach(e => keys.add(String(e.assetId || e.id))));
      return keys;
    },
    /* 条目标识：同一条目在两次拉取之间必须得到同一个 key（增量合并去重靠它） */
    entryKey(e) {
      return [((e && e.kind) || ''), ((e && (e.id || e.assetId || e.genId)) || ''), ((e && e.assetId) || '')].join('|');
    },
    /* 「这一条该按什么号去归档里问」的判据在 PromptLog.askId（列表、收藏、这里三处共用一份）。 */
    /* 合并两批条目（增量加载的核心）：
       ① 同 key 以新数据为准；
       ② 消掉「任务 → 产物」跃迁造成的重复卡 ——
          列表接口在产物刚写好时会先返回 kind:'task'（生成中），下一批返回 kind:'asset'（已完成）；
          两者 genId 相同、但 key 不同（task 用任务号，asset 用产物号），只按 key 去重会同时留下两张卡；
       ③ 产物级去重：同一个产物 id 只留信息更全的一条（有 src / 状态 / 提示词的优先）；
       ④ 平台那一条与它的**本机镜像**那一条合成一张卡（勾了「优先用本机文件」时同一份产物
          会在两个来源各出现一次：平台的 `id=任务号` 与本机的 `assetId=la_xxx`，
          上面三条谁也认不出它们是一回事 —— 表现就是「同一个任务重复出现」，
          而且提示词只在其中一条上，另一条永远空着）。判据与交接见 `collapseTwins` / `fillTwin`。
       多图任务（同 genId 不同 assetId）不受影响 —— 它们本来就该是多条。 */
    mergeEntries(base, add) {
      const map = new Map();
      const put = e => { if (e) map.set(this.entryKey(e), e); };
      (Array.isArray(base) ? base : []).forEach(put);
      (Array.isArray(add) ? add : []).forEach(put);
      let list = [...map.values()];
      const doneGens = new Set();
      list.forEach(e => { if (e.kind === 'asset' && e.genId) doneGens.add((e.provider || '') + '|' + e.genId); });
      if (doneGens.size) {
        list = list.filter(e => !(e.kind === 'task' && e.genId && doneGens.has((e.provider || '') + '|' + e.genId)));
      }
      const score = x => (x.src ? 2 : 0) + (x.status ? 1 : 0) + (x.prompt ? 1 : 0);
      const byAsset = new Map();
      list.forEach(e => {
        const k = e.assetId ? 'a|' + (e.provider || '') + '|' + e.assetId : this.entryKey(e);
        const prev = byAsset.get(k);
        if (!prev) { byAsset.set(k, e); return; }
        byAsset.set(k, score(e) >= score(prev) ? Object.assign({}, prev, e) : Object.assign({}, e, prev));
      });
      /* ④ 平台那一条与它的本机镜像那一条合成一张（判据见 collapseTwins） */
      return collapseTwins([...byAsset.values()]);
    },
    /* 哪些条目值得进首屏缓存：**只有已完成的**。缓存里留着「生成中 / 排队中」的快照，
       下次打开就会把早已结束的旧状态当成现状，画成一条永远不动的假任务
       （新数据往往还在后面几页，覆盖不到它）。未完成的一律等接口回来说话。 */
    cacheable(e) { return !!e && (e.kind === 'asset' || e.status === 'done' || e.status === 'failed' || e.status === 'succeeded'); },
    /* 列表首屏缓存（图片 / 视频 / 语音 / 资产库 / 导演台选素材弹窗共用这一份）：
       平台的列表接口动辄 6~14 秒，接口回来前先用上次的内容把界面填上。
       放 localStorage（换标签页、重开浏览器都还在），写爆配额时退回 sessionStorage。
       四个页面以前各写一份，其中两份**没有过滤未完成条目**（就是上面那条老毛病）。
       键沿用各页原来的名字，已有的缓存不用重建。 */
    /* 一批条目**进界面之前**要做的两件事：给产物补上本机镜像信息（decorate）、
       再把「同一个产物的任务条目 + 资产条目 + 本机副本」合成一张（collapseTwins）。
       为什么收成一份：列表那条路（emit）一直在做，**首屏缓存那条路没做** ——
       于是刷新时先按缓存画出来（一个任务一张、它的镜像又来一张），
       等真列表回来 emit 里一合，就少一张：用户看到的是「卡片先出现、过一会儿又消失」。
       两条路现在都调这一个函数，画出来的第一屏就与之后一致。 */
    settleEntries(list) {
      const arr = Array.isArray(list) ? list : [];
      const A = window.AssetLocal;
      if (!A || !A.decorate) return arr;
      /* 先数「这一条的任务出了几份产物」：老镜像文件只留下任务号，
         平台列表那条带着产物号回来时按产物号认不到它。**只有整条列表里这个任务
         只对应一份产物**时，才允许拿任务号把两者认成同一份 —— 多图任务按任务号合，
         四张卡会一起指向同一个本机文件（比不合更糟）。
         数的是**不同的平台产物号**，不是条目数：平台那条 + 它自己的本机那一条
         会各出现一次，按条目数会把「单图任务」也算成两份（allowGen 永远不生效）。 */
      const gens = new Map();
      for (const e of arr) {
        if (!e || e.kind !== 'asset' || !e.genId) continue;
        const gk = String(e.provider || '') + '|' + String(e.genId);
        const set = gens.get(gk) || (gens.set(gk, new Set()), gens.get(gk));
        const aid = String(e.assetId || '');
        set.add(/^la_/.test(aid) ? '' : aid);
      }
      for (const e of arr) {
        if (!e || e.kind !== 'asset') continue;
        const gk = String(e.provider || '') + '|' + String(e.genId || '');
        const set = gens.get(gk);
        /* `outCount` 是这一批平台数据自己说的一次出几份（产物号列表长度），
           比「当前列表里数到几条」更权威：分页会把同一个任务的多张图拆到两批。
           没有 outCount 的老条目：只有**没有平台产物号**（外链那一族，一次一份）时
           才允许按任务号认；带产物号但不说明份数的，一律不猜。 */
        const one = Number(e.outCount) === 1
          || (!e.assetId && !!set && set.size === 1);
        A.decorate(e, { allowGen: !!e.genId && one });
      }
      return collapseTwins(arr);
    },
    listCache(key, cap) {
      const AL = this, LIMIT = cap || 200;
      return {
        read() {
          try {
            const c = JSON.parse(localStorage.getItem(key) || sessionStorage.getItem(key) || 'null');
            const arr = (c && Array.isArray(c.entries)) ? c.entries : [];
            /* 与真列表走同一条「进界面前的处理」（见 settleEntries）：
               不然缓存那一眼会多出几张马上要消失的卡。 */
            return AL.settleEntries(arr.filter(e => AL.cacheable(e)));
          } catch { return []; }
        },
        write(list) {
          const keep = (Array.isArray(list) ? list : []).filter(e => AL.cacheable(e));
          const payload = JSON.stringify({ ts: Date.now(), entries: keep.slice(0, LIMIT) });
          try { localStorage.setItem(key, payload); }
          catch { try { sessionStorage.setItem(key, payload); } catch (e) {} }
          return keep.length;
        },
      };
    },
    /* 取消任务：端点与方法都来自 registry 声明 */
    async cancel(entry) {
      const prov = Api.prov(entry.provider);
      if (!prov) throw new Error('找不到平台：' + entry.provider);
      return Api.cancel(prov, entry.genId || entry.id);
    },
    /* 删除来源侧素材：只对「本地落盘」的资产有效（上游没有资产存储的那种，如语音合成产物）。
       端点由 registry 声明（endpoints.remove），没声明的来源会明确报错而不是静默失败。

       **本机镜像副本走另一条路**（这一条以前是颗永远点不动的按钮）：
       `localAsset` 一个布尔身兼两义 —— 「本机自生成的产物」与「云端产物的本机副本」，
       而 deleteLocal 那条路只对前者成立（它要求来源自己声明了 endpoints.remove，
       注册表里只有三家selfAsset 平台声明了）。于是自动镜像一开（默认），
       每一条平台视频都带着这颗按钮，hover 还写着「删除后会释放磁盘空间」，
       点两下确认后**必然**抛「…的素材存放在平台侧，本地无法删除」。

       而镜像副本同样落在 /local-assets（代理那边 twin判重后回同一个 la_xxx），
       `DELETE /local-assets/<la_id>` 本来就能删 —— 代码只是没走那条路。
       返回 mirrorGone:true，让调用方**只清本机索引、不要把整条从列表摘掉**：
       平台那份还在，卡片必须留着。 */
    async remove(entry) {
      /* 条目即本机资产（/local-assets 那张列表的行）：删 /local-assets 那一条本身。索引里 provider 只是
         「谁生成的」注记（语音产物写平台 id，导入 / 盘上补账写「本机」/ 'local'），以前当平台 id 查注册表，
         'local' /「本机」查不到任何一家，这批卡的删除键一点就抛「找不到平台」（字幕残留 PNG 正是这一族）。
         `localAsset && !mirror` 是缓存里可能还留着的旧形状（与 decorate 判 selfRow 同一把尺）。 */
      const selfId = entry && entry.localSelf
        ? String(entry.assetId || entry.id || '')
        : (entry && entry.localAsset && !entry.mirror && /^la_/.test(String(entry.assetId || entry.id || '')) ? String(entry.assetId || entry.id) : '');
      if (selfId) {
        const reg = await Api.registry();
        const src = (reg.providers || []).find(p => p.list && p.list.selfAsset);
        if (!src) throw new Error('找不到本机资产库这条来源（注册表里没有声明本机端点的平台）');
        await Api.request(src, 'remove', { id: selfId, method: 'DELETE' });
        return { localGone: true, id: selfId };
      }
      if (entry && entry.mirror && entry.mirror.a) {
        const reg = await Api.registry();
        const src = (reg.providers || []).find(p => p.list && p.list.selfAsset);
        if (!src) throw new Error('找不到本机资产库这条来源（注册表里没有声明本机端点的平台）');
        await Api.request(src, 'remove', { id: entry.mirror.a, method: 'DELETE' });
        return { mirrorGone: true, id: entry.mirror.a };
      }
      const prov = Api.prov(entry.provider);
      if (!prov) throw new Error('找不到平台：' + entry.provider);
      if (!prov.endpoints || !prov.endpoints.remove) {
        throw new Error((prov.displayName || prov.name || entry.provider) + ' 的素材存放在平台侧，本地无法删除');
      }
      try {
        return await Api.request(prov, 'remove', { id: entry.assetId || entry.id, method: 'DELETE' });
      } catch (e) {
        // 服务端已经没有这条素材了（别的标签页删过 / 本机记录是旧的）：对调用方算删除成功，清掉本机记录即可
        if (e && (e.status === 404 || /不存在|not found/i.test(e.message || ''))) return { alreadyGone: true };
        throw e;
      }
    },
    /* 重试：按条目的标准字段重建任务（请求体由 registry 的 create 声明决定） */
    async retry(entry) {
      const prov = Api.prov(entry.provider);
      if (!prov) throw new Error('找不到平台：' + entry.provider);
      /* 没有型号就**不猜**：以前静默退回 `prov.models[0]`，用户按的明明是「重试这一条」，
         发出去的却是另一个型号 —— 单价可能完全不同，而界面上看不出换过。 */
      const model = entry.model;
      if (!model) throw new Error('这一条没有记录型号，重试前请先重选型号（不同型号的单价与参数都不一样）');
      return Api.create(prov, {
        model: model,
        prompt: entry.prompt, tier: entry.tier, duration: entry.duration, res: entry.res,
        ar: entry.ar, quality: entry.quality, count: entry.count, format: entry.format,
      });
    },
    /* 按任务号 / 产物号在本机缓存里找那一条（tool 查任务详情前用来补平台 id 与提示词） */
    findByTaskId(id, providerId) { return findCached('task', id, providerId); },
    findByAssetId(id, providerId) { return findCached('asset', id, providerId); },
    /* 一条记录的提示词：平台给了就直接用；没给就从本机归档（PromptLog → Api.promptFor）补。
       返回 { prompt, local } —— local=true 表示这一句来自本机归档，调用方要把这件事说出来。
       `providerId` 是调用方另知的那一家（列表归一化时 prov 与真正产出方可能不是同一个）。 */
    promptOf(entry, providerId) {
      const e = entry || {};
      const raw = String(e.prompt || '');
      if (raw) return { prompt: raw, local: false };
      const askId = String(e.taskId || (window.PromptLog && window.PromptLog.askId
        ? (PromptLog.askId({ taskId: e.genId, id: e.id }) || '') : '') || '');
      if (!askId || !window.Api || !Api.promptFor) return { prompt: '', local: false };
      const ids = [];
      [e.provider, providerId].forEach(x => {
        const s = String(x || '');
        if (s && ids.indexOf(s) < 0) ids.push(s);
      });
      for (const id of ids) {
        const p = Api.promptFor(id, askId);
        if (p) return { prompt: String(p), local: true };
      }
      return { prompt: '', local: false };
    },
    /* 任务详情：走 Api.pollTask（统一入口，认 registry 的 pollVia:'list'，详情页不可用时退回列表按 id 找）。
       以前这里直打 Api.detail —— VGENV 的详情端点是 404 空壳，资产库的轮询每轮都 reject，
       任务卡停在「生成中」再也不收敛（页面/模块只用 Api.pollTask 这类统一入口）。
       返回值按 list.map 解析后的 p（含 status / error / genId…），调用方形状不变。 */
    async generationDetail(genId, providerId) {
      if (!genId) return null;
      const prov = Api.prov(providerId);
      if (!prov) return null;
      const r = await Api.pollTask(prov, genId);
      return (r && r.p) || null;
    },
  };
})();

/* 资产/任务条目 → 统一的费用 { cost, unit }：积分优先，其次金额（micros → 元） */
window.AssetLib.costOf = function (e) {
  if (!e) return { cost: null, unit: '' };
  if (e.credits != null && e.credits !== '') {
    const n = (e.credits && typeof e.credits === 'object') ? (e.credits.charged ?? e.credits.held ?? null) : Number(e.credits);
    if (n != null && !isNaN(n)) return { cost: n, unit: '积分' };
  }
  if (e.priceMicros != null) {
    const n = Number(e.priceMicros) / 1e6;
    if (!isNaN(n)) return { cost: n, unit: '元' };
  }
  return { cost: null, unit: '' };
};

/* ============================================================================
   AssetLib.estimateCost —— 生成前的费用预估（导演台 / 图片台 / 视频台 / 语音台共用）
   定价方式全部读 registry 的 provider.pricing 声明（新平台只声明，不改页面）：
     per_image_table   模型自带 price{档位:单价}，× 张数
     per_second_table  拉 endpoint（一般是 models）里的 pricing.perSecond，× 秒数 × 条数
     quote             调 endpoint 实时报价（?duration=&resolution=&tier=&aspect_ratio=）
     per_1k_chars      模型自带 price.per1kChars，× 字数/1000
   返回 { ok, text, detail, reason }：ok=false 时 reason 是「为什么没有价格」，界面照实显示。
   ok=true 时另给 `amount`（这一批的**数值**金额，没有币种符号）—— 一份算价只有一个落点，
   要把几批并成一个总数的是调用方（导演台的分镜整批估价按秒数分档，每档问一次再相加）；
   它自己**绝不另拼一份单价表**。「最低消费」那一型故意不给 amount（它不随条数变，并进求和
   等于把同一笔最低消费乘上档数）—— 缺这个字段的批必须由调用方照实说「报价不可用」，不许编。
   opts.cache：可选的按 key 缓存（平台模型表拉取很慢，页面传一个 Map/对象即可复用）
   opts.qualityLabel：把质量档位翻成中文（可选） */
/* 报价接口打不通的平台（VGENV 的 /v2/pricing 是 404 空壳）：一次判定记下来，整个会话不再问。
   不记的话用户每改一次档位/时长都要白打一次请求（一次 15 秒超时），列表和参数区跟着发抖。 */
const QUOTE_UNAVAILABLE = new Set();
const QUOTE_INFLIGHT = {};      // 同参数正在飞的报价请求 → 共享同一个 Promise
/* 判定要落到本机：以前只在内存里记，于是每次刷新页面都要重新吃一串 404
   （导演台一次重排就给每个分镜估一次价）。记一小时，过期后再探一次，平台真开了报价也不用改代码。 */
const QUOTE_MARK_KEY = 'sk_quote_unavailable';
const QUOTE_MARK_TTL = 3600 * 1000;
function quoteMarks() {
  try {
    const m = JSON.parse(localStorage.getItem(QUOTE_MARK_KEY) || '{}');
    const now = Date.now();
    Object.keys(m).forEach(k => { if (!(m[k] > now)) delete m[k]; });
    return m;
  } catch (e) { return {}; }
}
function quoteDead(k) { return QUOTE_UNAVAILABLE.has(k) || Object.prototype.hasOwnProperty.call(quoteMarks(), k); }
function markQuoteDead(k) {
  QUOTE_UNAVAILABLE.add(k);
  try {
    const m = quoteMarks();
    m[k] = Date.now() + QUOTE_MARK_TTL;
    localStorage.setItem(QUOTE_MARK_KEY, JSON.stringify(m));
  } catch (e) {}
}
function clearQuoteMarks() {
  QUOTE_UNAVAILABLE.clear();
  try { localStorage.removeItem(QUOTE_MARK_KEY); } catch (e) {}
}
/* 报价的**结果**缓存（ukey → { at, r }）。并发去重只挡住「同一时刻的两个请求」，
   挡不住「导演台每次重渲染都问一遍」—— 那会让报价行在同一个数之间来回闪。
   换个键就自然过期（键里有平台/端点/请求体），所以参数一变立刻重新问。 */
const QUOTE_CACHE = new Map();
const QUOTE_TTL = 45 * 1000, QUOTE_FAIL_TTL = 10 * 1000;
/* 只增不删的 Map 会跟着「每组不同参数」一直长（导演台每改一次时长就是一个新键）。
   读的时候顺手删这条过期项，写的时候清一遍过期项、再按插入序把最老的清到上限内。 */
const QUOTE_CACHE_MAX = 200;
function sweepQuoteCache() {
  const now = Date.now();
  for (const [k, v] of QUOTE_CACHE) {
    if (now - v.at >= (v.r && v.r.ok ? QUOTE_TTL : QUOTE_FAIL_TTL)) QUOTE_CACHE.delete(k);
  }
  while (QUOTE_CACHE.size > QUOTE_CACHE_MAX) QUOTE_CACHE.delete(QUOTE_CACHE.keys().next().value);
}
function clearQuoteCache() { QUOTE_CACHE.clear(); }
/* 平台的**实时定价表**：按 provider 现拉一次 /models，带 60 秒 TTL。
   为什么不用页面上那份：图片那一档以前读的是能力表归一化出来的 `price[quality]`（客户端缓存
   12 小时），视频那一档虽然是自己拉的、却一次都不重取（页面开着就是老价）——
   平台调了价，两边都要刷新页面才看得到。60 秒 TTL 与注册表缓存一致：
   连着改几次参数只打一趟，���过一分钟自动跟上。
   拉不到就退回注册表里声明的那份（离线时也还能给个数）。 */
const LIVE_PRICE_TTL = 60 * 1000;
const livePrice = new Map();          // prov.id → { at, list }
async function liveModelsOf(prov) {
  const id = (prov && prov.id) || '';
  const hit = livePrice.get(id);
  if (hit && Date.now() - hit.at < LIVE_PRICE_TTL) return hit.list;
  /* 拉失败也要记进那张表（list 记成 null）：不记的话每一次估价都要重新问一趟一个正在挂掉的接口，
     60 秒 TTL 就成了「只缓存成功」的半边 —— 而调用方本来就已经会退回注册表声明的价。 */
  try {
    const r = await Api.request(prov, (prov && prov.pricing && prov.pricing.endpoint) || 'models');
    const list = (r && (r.data || r.models)) || [];
    livePrice.set(id, { at: Date.now(), list });
    return list;
  } catch (e) {
    livePrice.set(id, { at: Date.now(), list: null });
    throw e;
  }
}
window.AssetLib.estimateCost = async function (prov, model, p = {}, opts = {}) {
  const pr = (prov && prov.pricing) || null;
  if (!pr) return { ok: false, reason: '该 API 未声明定价方式' };
  const n = Number(p.count || 1) || 1;
  const cur = pr.currency || '';
  /* 现拉一次定价表；拉不到就只用注册表声明（离线也有个数），并在明细里说明来源。
     **只有真的读这张表的两个分支才拉**（`per_image_table` 读 `liveEntry.pricing.perOutput`、
     `per_second_table` 读 `liveEntry.pricing.perSecond`）—— 判据是「下面有没有读」，不是「有没有 pricing」。
     以前不分类型先拉一次，而 `liveModelsOf` 取的端点写的是 `pricing.endpoint`：
     VGENV 声明的那一个是**报价接口**（POST /v3/videos/quote），于是它被当成型号清单 GET 了一遍，
     上游回 400 抛错 → 这一句被 try 吞掉、而 `livePrice` 因为抛错**不落缓存** →
     每次估价（导演台每改一次时长、每次重渲染）都白打一趟平台接口，界面上却什么都看不出来。
     `quote` 的价全部来自下面那一次实时报价，`per_1k_chars` 只按字数现算 —— 两个都一个字段都不读。 */
  let live = null, liveWhy = '';
  if (pr.type === 'per_image_table' || pr.type === 'per_second_table') {
    try { live = await liveModelsOf(prov); } catch (e) { liveWhy = errText(e, '取价失败'); }
  }
  const liveEntry = live ? live.find(x => x && x.id === (model && model.id)) : null;
  const where = liveEntry ? '实时价' : '平台声明价';
  try {
    if (pr.type === 'per_image_table') {
      let unit = model && model.price ? model.price[p.quality] : null;
      let src = '平台声明价';
      const row = liveEntry && liveEntry.pricing && (liveEntry.pricing.perOutput || []).find(x => x && x.quality === p.quality);
      if (row && row.credits != null) { unit = Number(row.credits); src = '实时价'; }
      if (unit == null) {
        const q = opts.qualityLabel ? (opts.qualityLabel[p.quality] || p.quality) : p.quality;
        return { ok: false, reason: '该型号没有「' + (q || '?') + '」档定价' };
      }
      return { ok: true, amount: unit * n, text: '约 ' + (unit * n) + ' ' + cur, detail: unit + ' ' + cur + '/张 × ' + n + ' 张 · ' + src };
    }
    if (pr.type === 'per_second_table') {
      const m = liveEntry || null;
      const sec = Number(p.duration) || 0;
      /* 没有时长就报不了按秒价：以前这里兜底成写死的 5 秒，等于替平台编了一个规格 ——
         用户选的明明是 8 秒，报价却按 5 秒算。 */
      if (!sec) return { ok: false, reason: '没有时长，无法按秒计价' };
      const ps = ((m && m.pricing && m.pricing.perSecond) || []).find(x => x.resolution === p.res);
      if (ps) {
        let total = Math.round(ps.credits * sec * n * 100) / 100;
        const detail = [ps.credits + ' ' + cur + '/秒 × ' + sec + '秒 × ' + n + ' 条'];
        /* 平台在 create.topBools 里声明的**顶层**开关可能单独计价（声明里写 priceKey，
           指向上游定价表里的那个字段，例如 SparkCine 的 promptOptimizationCredits）。
           按声明算，不按字段名写死 —— 平台再加一个带价的顶层开关，页面不用改。
           以前这里完全没算这一段，开关拨了报价纹丝不动，看着像开关没生效。 */
        const tDecl = (prov && prov.create && prov.create.topBools) || {};
        for (const [field, on] of Object.entries(p.topBools || {})) {
          if (!on) continue;
          const pk = tDecl[field] && tDecl[field].priceKey;
          const add = pk ? Number(((m && m.pricing) || {})[pk]) || 0 : 0;
          if (add) { total = Math.round((total + add * n) * 100) / 100; detail.push(((tDecl[field] && tDecl[field].label) || field) + ' +' + add + ' ' + cur); }
        }
        return { ok: true, amount: total, text: '约 ' + total + ' ' + cur, detail: detail.join(' · ') + ' · ' + where };
      }
      /* 「最低消费」这一型**故意不给 `amount`**：它不随条数变（一次任务与十次任务都是这个数），
         把它并进多档求和等于把同一个最低消费乘上档数 —— 那是个凭空的数。
         要合档的调用方（导演台的分镜整批估价）见 `amount` 缺失就照实说「报价不可用」。 */
      if (m && m.pricing && m.pricing.minimumCredits) return { ok: true, text: '最低 ' + m.pricing.minimumCredits + ' ' + cur };
      /* 实时表里没有这一档：退回声明的单价（能力归一化后的 model.perSecond，或注册表兜底
         声明的 options.perSecond），别直接说「没有价」 */
      const declRows = (model && (model.perSecond || (model.options && model.options.perSecond))) || [];
      const dps = declRows.find(x => x && x.resolution === p.res);
      if (dps && dps.credits != null) {
        const total = Math.round(dps.credits * sec * n * 100) / 100;
        return { ok: true, amount: total, text: '约 ' + total + ' ' + cur, detail: dps.credits + ' ' + cur + '/秒 × ' + sec + '秒 × ' + n + ' 条 · 平台声明价' };
      }
      return { ok: false, reason: '型号清单里没有 ' + (p.res || '?') + ' 的单价' + (liveWhy ? '（实时取价失败：' + liveWhy + '）' : '') };
    }
    if (pr.type === 'quote') {
      const ep = pr.endpoint || 'price';
      const qk = (prov && prov.id ? prov.id : String(ep)) + '|' + ep;
      if (quoteDead(qk)) return { ok: false, reason: '该平台未开放报价接口' };
      /* 报价可以声明成 **POST + JSON 体**（VGENV 的 /v3/videos/quote 就是），
         默认仍是 GET + 查询串。判据读声明，页面不按平台 id 分支。
         请求体的字段映射也从声明来：`body: { 上游字段名: 本地参数名 }`，
         取值与 create.body 同一套本地参数名（model/prompt/tier/duration/res/resolution/ar）。 */
      const method = String(pr.method || 'GET').toUpperCase();
      const qbody = {};
      /* 「这一次的形状」在这里只有一份：mode + creation_intent + 逐行能力（`p.caps`，
         由页面按 Capabilities.shapeState 现算后递进来）。
       顶层开关要不要进报价体问它，「这一档根本不报价」也问它 ——
       判据与提交体、界面三处共用同一份（capabilities.js 顶层的 topBoolState / whenMatches），
       不传 caps 的话声明了 `need:'caps.xxx'` 的开关会被判成「不提供」，报价就少算那一档的加价。 */
      const qctx = { mode: p.mode, intent: '', caps: p.caps || null };
      if (method !== 'GET') {
        /* 取值口径：声明右边写的是**本地参数名**，而 `model` 在 estimateCost 的签名里是
           单独的第二个参数、不在 p 里 —— 不把它并进来，body 就少了 model 字段，
           上游回 400「model must be a string」，而界面只会显示一句「报价接口要这些…」。 */
        const src = Object.assign({}, p, { model: (model && model.id) || p.model });
        /* `consts`：上游**必填、但内容不参与计价**的字段（VGENV 的 prompt）。
           它按文档要求 5–30000 字，可报价那一路明确「不运行提示词优化或换人分析」——
           内容根本不影响价钱。发调用方的真提示词只会平白多出两种挂法：
           用户提示词不足 5 字、或超过 30000 字，报价就问不成了。
           所以占位串写在注册表里（`consts`），调用方真给了值也盖得住它。 */
        Object.assign(qbody, pr.consts || {});
        for (const [remote, local] of Object.entries(pr.body || {})) {
          const v = src[local];
          if (v != null && v !== '') qbody[remote] = v;
        }
        qctx.intent = qbody.creation_intent || '';
        /* 顶层开关也带上：文档说报价「使用**创建接口的相同参数**」——
           不带的话报价回来的是一个我们根本不会创建的规格（比如平台默认开了提示词优化，
           而用户恰好关了它），价差就落到生成那一刻才暴露。开/关各发什么值由同一处判决定。 */
        const tDecl2 = (prov && prov.create && prov.create.topBools) || {};
        for (const [field, on] of Object.entries(p.topBools || {})) {
          if (tDecl2[field] && !window.Capabilities.fieldState(tDecl2[field], qctx).hidden) qbody[field] = topBoolValue(tDecl2[field], on);
        }
      }
      /* `noQuote: { when, why }` —— 这一档**没有报价这条路**，不是「报价失败了」。
         VGENV 的动作换人在报价时要求带上那段参考视频（文档写明），而报价是纯参数查询、
         拿不到用户手里的字节 —— 实测十二种换人参数全回 422 `PERSON_REPLACEMENT_INPUT_INVALID`。
         以前界面把这件事显示成「报价不可用（…INVALID）」，用户以为是接口坏了；
         现在回 `skip`，由界面照实说一句「这一档平台不问价」，并且**不去发那一次注定失败的请求**。 */
      if (pr.noQuote && window.Capabilities.whenMatches(pr.noQuote.when, qctx)) {
        return { ok: false, skip: true, reason: String(pr.noQuote.why || '这一档平台不提供询价') };
      }
      const q = '?duration=' + sec0(p.duration) + '&resolution=' + (p.res || '') + '&tier=' + (p.tier || '') + '&aspect_ratio=' + (p.ar || '');
      const full = Api.url(prov, ep) + (method === 'GET' ? q : '');
      /* 同参数的并发只发一趟：导演台一次重排会给每个分镜估一次价，参数常常一模一样，
         报价接口又是 15 秒超时的那种 —— 七条一样的请求既白等也打上游。 */
      const ukey = full + (method === 'GET' ? '' : '|' + JSON.stringify(qbody));
      /* 结果缓存（不只是并发去重）：导演台的 refreshEst 挂在「每次重渲染」上，
         而重渲染在输入、选中、切镜头时都会发生 —— 同一组参数于是被反复问一遍上游，
         报价那行也跟着「估价中… → 同一个数」来回闪（实测两次 refreshEst 发了 4 次请求，
         数字一次没变）。加上 TTL 之后：同参数直接读缓存，回调在同一帧里落地，界面不闪。
         TTL 定 45 秒：平台自己也说「报价后库存可能变化，创建会重新核验并返回最终金额」，
         所以短缓存不会让用户按着一个过时的价去提交。失败只缓存 10 秒，别把一次网络抖动
         钉成一分半钟的「报不出来」。 */
      const hit = QUOTE_CACHE.get(ukey);
      if (hit && Date.now() - hit.at < (hit.r && hit.r.ok ? QUOTE_TTL : QUOTE_FAIL_TTL)) return hit.r;
      if (hit) QUOTE_CACHE.delete(ukey);
      if (QUOTE_INFLIGHT[ukey]) return await QUOTE_INFLIGHT[ukey];
      const one = (async () => {
        const opt = { headers: Api.headers(prov), timeout: 15000, retry: 0 };
        if (method !== 'GET') {
          opt.method = 'POST';
          opt.headers['Content-Type'] = 'application/json';
          opt.body = JSON.stringify(qbody);
        }
        const r0 = await Net.fetch(full, opt);
        if (r0.status === 404) { markQuoteDead(qk); return { ok: false, reason: '该平台未开放报价接口' }; }
        if (r0.status === 400) {
          /* 上游把「缺哪个字段」写在 message 里（VGENV 回的是数组），照实说给用户，
             别一律压成「未开放报价接口」—— 那是另一个意思。 */
          let msg = '';
          try { const j = await r0.json(); msg = [].concat(j.message || j.error || '').join('；'); } catch (e) {}
          return { ok: false, reason: msg ? ('报价接口要这些：' + msg.slice(0, 120)) : ('报价接口 HTTP 400') };
        }
        if (!r0.ok) return { ok: false, reason: '报价接口 HTTP ' + r0.status };
        const d = await r0.json();
        const micros = (d.price && d.price.amount_micros) ?? d.amount_micros ?? (d.data && d.data.price && d.data.price.amount_micros);
        if (micros) {
          const each = Number(micros) / 1e6;
          return { ok: true, amount: each * n, text: '约 ¥' + (each * n).toFixed(2), detail: '¥' + each.toFixed(2) + '/条 × ' + n + ' 条' };
        }
        return { ok: false, reason: d.message || '报价接口未返回价格' };
      })();
      QUOTE_INFLIGHT[ukey] = one;
      try {
        const r = await one;
        if (QUOTE_CACHE.size >= QUOTE_CACHE_MAX) sweepQuoteCache();
        QUOTE_CACHE.set(ukey, { at: Date.now(), r });
        return r;
      } finally { delete QUOTE_INFLIGHT[ukey]; }
    }
    if (pr.type === 'per_1k_chars') {
      const unit = model && model.price ? model.price.per1kChars : null;
      if (unit == null) return { ok: false, reason: '平台未提供价格' };
      const chars = Number(p.chars || 0);
      if (!chars) return { ok: false, reason: '还没有文本，无法预估' };
      const total = chars / 1000 * Number(unit);
      return { ok: true, amount: total, text: '约 ' + (pr.currency || '¥') + total.toFixed(4),
        detail: chars + ' 字 × ' + (pr.currency || '¥') + unit + '/千字' };
    }
    return { ok: false, reason: '未知的定价类型 ' + pr.type };
  } catch (e) { return { ok: false, reason: errText(e, '报价请求失败') }; }
};
function sec0(v) { return Number(v || 5); }

