/* PromptLog — 提示词归档（写 /prompts、按任务号回查、标题由文字 AI 起、整包导出恢复）。
   从 web/domain/assetlib.js 拆出；只依赖 window.Api / TextAI / Net / Store 这些公开面。 */
(function () {
  const DIR_KEY = 'prompt_dir';
  const cache = new Map();          // '平台|任务号' → 提示词（同步读，供资产库补显示）
  const byTask = new Map();         // 任务号 → 提示词：归档时写的平台名可能和列表来源不一样
                                    //（如媒体路由把 sparkcine 的视频条目归到 sparkcine-video），只按「平台|任务号」查就会 miss
  const remember = (provId, id, prompt) => {
    if (!id) return;
    const p = String(prompt || '');
    cache.set(promptKeyOf(provId, id), p);
    if (!byTask.has(String(id))) byTask.set(String(id), p);
    /* 两张表都要各自封顶：以前淘汰 byTask 时用**当前这次调用的 provId** 去拼 cache 键，
       被淘汰那条的键根本删不掉，于是 cache 一整个会话只增不减。 */
    if (cache.size > 4000) cache.delete(cache.keys().next().value);
    if (byTask.size > 4000) byTask.delete(byTask.keys().next().value);
  };
  const titles = new Map();         // 提示词 → 标题（同一次会话里同一个提示词只问一次文字 AI）
  const inflight = new Map();
  let loadedAt = 0, loading = null, warned = false;

  const dir = () => { try { return localStorage.getItem(DIR_KEY) || ''; } catch (e) { return ''; } };
  /* 写不进去（配额满 / 隐私模式）要能告诉调用方：以前 `catch (e) {}` 吞掉，
     设置页照样打 ✓，而归档目录其实还是旧的那个。 */
  const setDir = d => {
    try {
      if (d) localStorage.setItem(DIR_KEY, d); else localStorage.removeItem(DIR_KEY);
      return true;
    } catch (e) { return false; }
  };
  const promptKeyOf = (provId, id) => (provId || '') + '|' + id;

  async function req(path, opts) {
    const o = opts || {};
    const x = await window.Net.read('/prompts' + path, { ...o, retry: o.retry === undefined ? 1 : o.retry });
    if (!x.ok) {
      const err = new Error((x.d && x.d.error && x.d.error.message) || ('HTTP ' + x.status));
      err.status = x.status;
      throw err;
    }
    /* 解析失败这一步不能再吞：以前写的是 `catch (e) {}`，于是 200 + 半截 JSON 读回来是 null，
       调用方只会说「没有这一条归档」，把「代理返回的东西读不出来」这个真原因藏掉了。 */
    if (x.d === null && x.parseErr) throw new Error('提示词接口返回了非 JSON 内容（HTTP ' + x.status + '）');
    return x.d;
  }
  /* 归档失败只提示一次：创作流程不该因为存不了提示词被打断 */
  function warnOnce(e) {
    if (warned || !window.Toast) return;
    warned = true;
    Toast.warn('提示词没能归档到文件夹（' + e.message + '）：可到「设置 → 提示词归档」检查目录', 7000);
  }

  /* 归档的整包导出 / 恢复（走代理的 POST /prompts/export 与 /prompts/import）。
     以前归档只躺在磁盘上的一堆 .md 里：不在 .data/（云同步带不走），
     也不在 localStorage / IndexedDB 里（整包备份同样带不走）——
     换机器、清浏览器数据、误删目录，就只剩「没了」这一种结果。 */
  const dirQuery = () => { const d = dir(); return d ? '?dir=' + encodeURIComponent(d) : ''; };
  async function exportAll() { return await req('/export' + dirQuery(), { method: 'POST', body: '{}' }); }
  async function importAll(files) {
    return await req('/import' + dirQuery(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files || [] }), timeout: 120000, retry: 0,
    });
  }

  /* 兜底标题：提示词前 10 个字（去掉换行与多余空白） */
  const fallbackTitle = prompt => String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 10);
  function cleanTitle(s) {
    const line = String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
    return line
      .replace(/^#+\s*/, '')
      .replace(/^(标题|Title)\s*[:：]\s*/i, '')
      .replace(/^["'“”「『（(]+|["'“”」』）)]+$/g, '')
      .replace(/[。，、,.!！?？;；:：]+$/g, '')
      .trim().slice(0, 24);
  }
  /* 让文字 AI 起标题；没配文字 AI / 超时 / 返回不可用 → 空串（调用方用前 10 个字兜底） */
  async function aiTitle(REG, prompt) {
    const k = String(prompt).slice(0, 600);
    if (titles.has(k)) return titles.get(k);
    if (inflight.has(k)) return inflight.get(k);
    const job = (async () => {
      try {
        const sys = '你是命名助手：把用户给的创作提示词概括成一句能当文件名的短标题。\n'
          + '要求：中文提示词给 8–16 个汉字，英文提示词给 3–6 个单词；用名词短语，'
          + '概括画面主体与场景，不要写「一段视频」「生成图片」这类废话，不要标点。\n'
          + '只输出标题本身：不要引号、不要书名号、不要解释、不要多个方案。';
        const out = await Promise.race([
          TextAI.chat(REG, sys, k),
          new Promise((_, rej) => setTimeout(() => rej(new Error('起标题超时')), 12000)),
        ]);
        return cleanTitle(out);
      } catch (e) { return ''; }
      finally { inflight.delete(k); }
    })();
    inflight.set(k, job);
    const t = await job;
    titles.set(k, t);
    if (titles.size > 300) titles.delete(titles.keys().next().value);
    return t;
  }

  /* 归档一份提示词（不 await 也不抛错：调用方 fire-and-forget 即可，不拖慢创建任务） */
  async function save(REG, info) {
    const prompt = String((info && info.prompt) || '').trim();
    if (!prompt) return null;
    try {
      const title = String((info.title || '')).trim() || (await aiTitle(REG, prompt)) || fallbackTitle(prompt);
      const body = {
        dir: info.dir !== undefined ? info.dir : dir(),
        title, type: info.type || '任务', prompt,
        provider: info.provider || '', model: info.model || '',
        task: info.task || '', meta: info.meta || null,
      };
      const d = await req('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), timeout: 20000 });
      // 顺手更新内存索引：刚提交的任务立刻能在资产库里看到提示词，不必等下次刷新
      if (d && d.ok && info.provider && info.task) remember(info.provider, info.task, prompt.slice(0, 300));
      return d;
    } catch (e) { warnOnce(e); return null; }
  }

  /* 归档索引 → 内存缓存（资产库补显示用；同步读缓存，所以这里后台拉一次） */
  async function load(force) {
    if (!force && Date.now() - loadedAt < 60000) return cache.size;
    if (loading) return loading;
    loading = (async () => {
      try {
        // limit 默认 300 太少：索引里没有的老任务，卡片就只能显示「（该平台接口不返回提示词）」
        const d = await req('?dir=' + encodeURIComponent(dir()) + '&limit=800', { timeout: 15000 });
        (d.recent || []).forEach(r => { if (r.p && r.i) remember(r.p, r.i, r.pr || ''); });
        loadedAt = Date.now();
        return cache.size;
      } catch (e) { return cache.size; }
      finally { loading = null; }
    })();
    return loading;
  }
  const cached = (provId, id) => (id ? cache.get(promptKeyOf(provId, id)) || '' : '');
  /* 只按任务号查（归档里的平台名和列表来源对不上时用得上，见 byTask 注释） */
  const cachedById = id => (id ? byTask.get(String(id)) || '' : '');
  /* 回源查过、确认本机没有归档（'平台|任务号'）：不再重复问，界面也敢说「本机没归档」。
     这个结论要**活过页面刷新**：视频台一屏就是 20+ 条没有归档的老任务，集合只存内存的话
     每次刷新都重新回源问一遍（实测一次加载 40 多个 404 请求）。
     存 sessionStorage —— 同一标签页内有效，不进 .data/、不进云同步（它是缓存，不是用户数据）。 */
  const MISSED_KEY = 'pl_missed_v1';
  const missed = new Set();
  try {
    const raw = sessionStorage.getItem(MISSED_KEY);
    if (raw) for (const x of JSON.parse(raw)) if (typeof x === 'string') missed.add(x);
  } catch (e) { /* sessionStorage 读不到（隐私模式 / 被禁）就当失败清单是空的 */ }
  let missedTimer = 0;
  const saveMissed = () => {
    clearTimeout(missedTimer);
    missedTimer = setTimeout(() => {
      try { sessionStorage.setItem(MISSED_KEY, JSON.stringify([...missed].slice(-3000))); } catch (e) { /* 写不进去只少一次「下次提醒重试」，不拦这次的归档 */ }
    }, 300);
  };
  const fulls = new Map();            // 任务号 → 归档里的**全文**（索引只带前 300 字，够卡片用，详情面板要整份）
  const finding = new Map();          // 任务号 → 进行中的查询：同一任务并发只发一次请求
  const setFull = (id, p) => {
    if (fulls.size > 400) fulls.delete(fulls.keys().next().value);
    fulls.set(String(id), p);
  };
  /* 按任务号回源取**整份**归档提示词（详情面板、以及索引窗口外的老任务用） */
  async function findByTask(provId, id) {
    if (!id) return '';
    const k = String(id);
    if (fulls.has(k)) return fulls.get(k);
    if (missed.has(promptKeyOf(provId, id)) || missed.has(promptKeyOf('', id))) return '';
    if (finding.has(k)) return finding.get(k);
    const job = (async () => {
      const enc = encodeURIComponent;
      /* **一个任务号只发一个请求**：provider 只告诉服务端「优先返回哪一份」，
         匹配到的全部归档都在 all 里一起带回来。
         以前这里是「带 provider 查一次 → 查不到再不带 provider 查一次」，
         而第二次多半和第一次逐字节相同（本机根本没归档），于是每条老任务固定多一个 404。
         provider 传不传都一样能用，所以现在总是带上 —— 少一半请求，也少一半噪声。 */
      let d = null;
      try { d = await req('/find?id=' + enc(id) + '&provider=' + enc(provId || ''), { timeout: 15000 }); }
      catch (e) { d = null; }                        // 404 = 本机没有归档，不是错误
      finding.delete(k);
      if (d && d.prompt) {
        const p = String(d.prompt);
        setFull(id, p);
        remember(provId, id, p.slice(0, 300));
        /* 同一任务号的其它归档（换过平台 id 重复提交的那些）也记下来：
           换 provider 再查时直接命中缓存，省一次请求。 */
        (d.all || []).forEach(a => { if (a && a.provider && a.pr) remember(a.provider, id, String(a.pr)); });
        missed.delete(promptKeyOf(provId, id)); missed.delete(promptKeyOf('', id));
        saveMissed();
        return p;
      }
      if (missed.size > 4000) { missed.clear(); }
      missed.add(promptKeyOf(provId, id)); missed.add(promptKeyOf('', id));
      saveMissed();
      return '';
    })();
    finding.set(k, job);
    return job;
  }
  /* 这条任务是不是「本机确实没有归档」（回源查过才算，没查过返回 false）：
     界面据此区分「平台不返回提示词，但本机归档里能找到」和「两边都没有」。 */
  const missedFor = (provId, id) => !!id && (missed.has(promptKeyOf(provId, id)) || missed.has(promptKeyOf('', id)));
  /* 「这一条该按什么号去归档里问」只有一份判据：任务号 → 产物号，逐个字节的本机资产号（la_）不算 ——
     本机生成的那几条压根没有平台记录，拿 la_xxx 去问每一条固定一个 404、还永远问不出东西。
     为什么也要看 assetId / id：**收藏与工作区里存的那条经常只有产物号**（VGENV 的任务号就是产物号，
     而当初建卡时那条目可能就没有 genId），只认任务号就会永远跳过它 —— 归档明明有，卡片却空着一行。 */
  const askId = rec => {
    if (!rec) return '';
    for (const v of [rec.taskId, rec.genId, rec.assetId, rec.id]) {
      const s = String(v == null ? '' : v);
      if (s && !/^la_/.test(s)) return s;
    }
    return '';
  };
  /* 缺提示词的记录就地补齐（**不等它**：返回的 Promise 只给愿意等的人，首屏不为它多待一个请求）。
     查到就写 rec.prompt + promptLocal，然后回调一次让调用方重画 —— 列表（AssetLib.load）与收藏
     （Fav.refillPrompts）走的是同一份判据、同一份回源，页面不要再自己拼一次 /prompts/find。
     问过的会进 missed 集合（活过刷新），本机真没有归档的那些不会反复问。
     两条省请求的判据，都在这一处：
     ① **归档索引里已经有这句话的就当场填掉**（`load()` 已经拉过最近 800 条，一次 `/prompts/find` 都不必发）；
     ② 限量名额只给「还得回源问」的那些 —— 索引命中那条不能把名额吃掉，否则一整屏都能填时
        反而一个请求都不发、名额全浪费在没归档的行上。 */
  function refill(recs, opts = {}) {
    const limit = opts.limit > 0 ? opts.limit : 20;
    const todo = [];
    let filledNow = 0;
    for (const r of (Array.isArray(recs) ? recs : [])) {
      if (!r || r.prompt) continue;
      const id = askId(r);
      if (!id) continue;
      const hit = cached(r.provider, id) || cachedById(id);
      if (hit) { r.prompt = hit; r.promptLocal = true; filledNow++; continue; }
      if (missedFor(r.provider, id)) continue;
      if (todo.length >= limit) continue;
      todo.push({ r, id });
    }
    if (!todo.length) {
      if (opts.onDone && filledNow) { try { opts.onDone(filledNow, []); } catch (e) { console.warn('[PromptLog] 补齐后重画出错：', e); } }
      return Promise.resolve(filledNow);
    }
    return Promise.allSettled(todo.map(x => findByTask(x.r.provider, x.id))).then(() => {
      let n = filledNow;
      todo.forEach(x => {
        const p = cached(x.r.provider, x.id) || cachedById(x.id);
        if (p) { x.r.prompt = p; x.r.promptLocal = true; n++; }
      });
      /* 查到没查到都要回调：没查到的那一行要从「正在归档里找」改成「两边都没有」 */
      if (opts.onDone) { try { opts.onDone(n, todo.map(x => x.r)); } catch (e) { console.warn('[PromptLog] 补齐后重画出错：', e); } }
      return n;
    });
  }
  /* 归档目录信息（设置页展示） */
  const list = () => req('?dir=' + encodeURIComponent(dir()));
  const open = () => req('/open?dir=' + encodeURIComponent(dir()), { method: 'POST' });
  /* 平台默认类型：页面没指定时按平台种类给一个（图片 / 视频 / 语音 / 文字）。
     名字带「归档」是因为这是**提示词归档里那一行任务是什么**的说法（图片生成 / 语音合成），
     与设置页那一排档名（`ui.js` 的 `provKindZh`：图片 / 语音）不是一张表 —— 2026-10-15 把它从
     同名 `KIND_ZH` 改名，两份同名表摆在一起迟早被后来人当成重复实现合并掉。 */
  const ARCHIVE_TYPE_ZH = { image: '图片生成', video: '视频生成', audio: '语音合成', text: '文字' };
  const ctxType = prov => ARCHIVE_TYPE_ZH[(prov && prov.kind) || ''] || '任务';

  /* 启动后拉一次索引（资产库给不返回提示词的任务补显示要用），之后每 5 分钟对一次；
     代理没在跑就静默失败 —— 归档是锦上添花，不能挡住页面本身。
     `load(true)` 会**绕过** 60 秒 TTL 闸，所以这 5 分钟是硬周期；标签页藏在后台时
     照样每 5 分钟发一次 `GET /prompts?limit=800`，加一道可见性判断：
     这是本文件**唯一**的 setInterval，且只在脚本求值时注册一次，没有「每页面实例一个」的泄漏。 */
  setTimeout(() => load(false), 2500);
  setInterval(() => { if (document.hidden) return; load(true); }, 5 * 60 * 1000);

  /* 「本机没有这条归档」的结论（sessionStorage）：清掉它会重新按任务号回源问一遍。
     刚往归档目录里手工补了文件、或换了归档目录时用它，不用刷新页面。 */
  const clearMissed = () => { const n = missed.size; missed.clear(); saveMissed(); loadedAt = 0; return n; };

  window.PromptLog = { save, load, cached, cachedById, findByTask, missedFor, askId, refill, clearMissed, list, open, dir, setDir, ctxType, fallbackTitle, cleanTitle, aiTitle, exportAll, importAll };
})()
