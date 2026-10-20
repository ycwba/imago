/* 生成表单族：型号偏好 / 生成参数 / 配音与字数闸 / 口播说明 / 流式面板。
   八个 window 面（ModelPrefs / AiGen / AdvParams / AdvExtras / TtsAdv / CharLimits /
   VoiceNote / AiStream）从 assetlib.js 拆出（报告 §6.1-2：按已有的 window 面切文件）。
   加载顺序见 shell.html：api.js → assetlib.js → gen-forms.js；方法体只读
   Api / AssetLib / Capabilities / TextAI / InlinePolish 这些公开面与 api.js 的顶层函数。 */

/* ============================================================================
   ModelPrefs —— 「这一家有哪些型号、哪一个被藏起来」的唯一一份本机记录
   ----------------------------------------------------------------------------
   一条 keyId 一份 `{ typed:[手填的 id], off:[被勾掉「隐藏」的 id] }`，整包存 `sk_model_prefs`
   （ui.js 的 DataSync 按 `sk_model_` 前缀镜像成 `.data/sk_model_prefs.json`，代理在 allProviders()
   里把它并进注册表 —— 所以「藏起来的型号在工作台消失」这件事不需要每个页面各判一遍）。

   为什么要有 typed：v13 起注册表不再写死型号清单。有型号接口的家（SparkCine / VGENV / MiMo）
   清单现取；没有的（MiniMax 视频与语音、硅基流动、智谱 —— 它们的 /models 只列**对话**模型，
   接上去只会把视频台变成聊天模型下拉）就只能由用户自己填 id。
   为什么要有 off：现取的清单动辄上百个型号（硅基流动 160+、vgenv 一整排档位），
   「这一家我只用两个」以前没有出口 —— 只能整个停用这一家（`sk_off_`），那是把密钥与历史一起停了。

   三条硬约定（都是本项目踩过的那一类）：
   ① **每个读写口都要先认出 keyId**（`of()` 里的判据），认不出就返回空 / 不写。
      以前 `keyId(null)` 会兜底成 'deepseek'，于是「填在 OpenRouter 的型号跑到另一家」；
   ② **旧键 `sk_text_models_<kid>` 一次性搬进来**（`migrate`），搬完就把旧键删掉 ——
      留着会变成「同一个概念两份记录」，谁新谁旧没人说得清。
      `migrate` 由 `ui.js` 在 **DataSync 对账之后**调一次，不在模块加载时跑（顺序反了会被对账拉回来）；
   ③ 界面要判「这个型号藏了没」只问 `isOff()` 一处，别在页面里再 `getItem('sk_model_prefs')` 数一遍。
   ========================================================================== */
window.ModelPrefs = {
  KEY: 'sk_model_prefs',
  LEGACY_PREFIX: 'sk_text_models_',
  _raw() {
    try {
      const v = JSON.parse(localStorage.getItem(this.KEY) || '{}');
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch { return {}; }             // 读坏了就当没勾过，绝不拿脏数据当写入底座
  },
  /* 认出这一家：与 TextAI.hasProv 同一条判据（认不出就不读写，宁可不加也不能写到别家去）。 */
  kid(prov) { const k = prov && (prov.keyId || prov.id); return k ? String(k) : ''; },
  of(prov) {
    const k = this.kid(prov);
    if (!k) return { typed: [], off: [], got: [] };
    const e = this._raw()[k] || {};
    const list = a => (Array.isArray(a) ? a.map(x => String(x).trim()).filter(Boolean) : []);
    /* got = 「这一家的接口给过哪些型号」，落盘的一份。
       为什么必须落盘：以前它只活在设置页的内存 Map 里，于是
       ① 刷新一次那张清单就空了，界面上写着「这一家一个型号都还没有」；
       ② 别的页面（AI 助手的型号下拉）根本没有这份数据，只能看见自己填的那一两个。
       存 `{id, name}` 而不是光存 id：名字是接口给的，重新取一次不一定还带着，
       而清单上只有一串 id 时谁也认不出那是哪个型号。 */
    const got = (Array.isArray(e.got) ? e.got : [])
      .map(m => (m && typeof m === 'object'
        ? { id: String(m.id || '').trim(), name: String(m.name || '').trim() }
        : { id: String(m || '').trim(), name: '' }))
      .filter(m => m.id);
    return { typed: list(e.typed), off: list(e.off), got };
  },
  typed(prov) { return this.of(prov).typed; },
  got(prov) { return this.of(prov).got; },
  /* 取回来的型号清单存下来（按 id 合并，**保留先到的那份名字**）。
     合并而不是整份替换：分页/多次取回、或用户手填的那几条不能被一次重取抹掉。
     不设条数上限 —— 滚动框就是为「很多条」准备的。 */
  setGot(prov, list) {
    if (!this.kid(prov)) return this.got(prov);
    const cur = this.of(prov).got;
    const map = new Map(cur.map(m => [m.id, m]));
    (Array.isArray(list) ? list : []).forEach(m => {
      const id = String((m && m.id) || m || '').trim();
      if (!id) return;
      const name = String((m && m.name) || '').trim();
      const old = map.get(id);
      map.set(id, { id, name: name || (old ? old.name : '') });
    });
    const all = [...map.values()];
    this._set(prov, { got: all });
    if (window.Api && Api.clearCaches) { try { Api.clearCaches(); } catch {} }
    return all;
  },
  isOff(prov, id) {
    const s = String(id || '');
    return !!s && this.of(prov).off.includes(s);
  },
  _set(prov, patch) {
    const k = this.kid(prov);
    if (!k) return false;                       // 认不出这一家就不写：见上面第 ① 条
    const all = this._raw();
    const cur = all[k] || {};
    /* 三个字段**都要**先带出来再打 patch：早先这里只带 typed 与 off，
       于是 setOff(勾一下「展示」) 会把同一格里的 got 整份抹掉 ——
       表现为「我刚获取的型号列表，勾了一下就没了」，而勾选与获取看着毫无关系。 */
    all[k] = Object.assign({ typed: cur.typed || [], off: cur.off || [], got: cur.got || [] }, patch);
    try { localStorage.setItem(this.KEY, JSON.stringify(all)); } catch {}
    return true;
  },
  addTyped(prov, id) {
    const s = String(id || '').trim();
    if (!s) return this.typed(prov);
    const t = this.typed(prov);
    if (!t.includes(s)) t.push(s);
    /* **不设条数上限**（以前是 `t.slice(-200)`，那行是「防 localStorage 写爆」想出来的，
       但它砍掉的是**最早的**那几条 —— 而那几条恰恰是用户最先手填、最可能还在用的。
       症状不像「存不下」，像「我填过的型号莫名少了几条」，而且没有任何提示。
       真要担心体积，滚轮条就是答案：设置页那块清单限高自滚，几百条也只占一屏。 */
    this._set(prov, { typed: t, off: this.of(prov).off.filter(x => x !== s) });
    /* 手填一次就把代理那份注册表缓存抵掉：不抵的话「填了型号，下拉里没有」要等到 60 秒缓存过期，
       而这一页的用户刚做完添加动作，那句话看起来就像填错了地方。 */
    if (window.Api && Api.clearCaches) { try { Api.clearCaches(); } catch {} }
    return this.typed(prov);
  },
  removeTyped(prov, id) {
    const s = String(id || '');
    this._set(prov, { typed: this.typed(prov).filter(x => x !== s), off: this.of(prov).off.filter(x => x !== s) });
    if (window.Api && Api.clearCaches) { try { Api.clearCaches(); } catch {} }
    return this.typed(prov);
  },
  setOff(prov, id, off) {
    const s = String(id || '');
    if (!s) return;
    /* 文字 AI 不记「藏起来」：那一档的型号清单是**单选**（选中的那个就是全站润色模型），
       界面上根本没有勾选框 —— 藏了就是藏了没人看得见、也勾不回来。
       而下拉仍然按 isOff 筛（同一个判据），于是一条被藏住的文字型号会：
       画在设置页那张清单里，点下去却报「不在下拉的选项里」。
       挡住写入口，这一类就再也不会产生「藏得住、看不见」的记录。 */
    if (off && prov && prov.kind === 'text') return;
    const list = this.of(prov).off.filter(x => x !== s);
    if (off) list.push(s);
    this._set(prov, { off: list });
    /* 与 addTyped 同一件事：藏/展示改的是「注册表里那一份 models」，而浏览器与代理都缓存着它。
       不抵掉的话「勾掉了，工作台下拉里它还挂着」要等到 60 秒，而这一页刚点完的人只会以为没生效。 */
    if (window.Api && Api.clearCaches) { try { Api.clearCaches(); } catch {} }
  },
  /* 一家整个从本机消失时（设置页删掉自定义那一家）把它名下的记录摘掉，
     不然死数据跟着云同步出网，换台机器还多出一份没人认领的清单。 */
  drop(keyId) {
    const k = String(keyId || '');
    if (!k) return;
    const all = this._raw();
    if (!(k in all)) return;
    delete all[k];
    try { localStorage.setItem(this.KEY, JSON.stringify(all)); } catch {}
  },
  /* 旧键 `sk_text_models_<kid>`（文字 AI 那份「自己填的型号」）搬进 typed。
     只在模块装好时跑一次：搬完删旧键（localStorage 的 removeItem 会经 DataSync 变成
     DELETE /data/<键>，服务端那份也跟着没 —— 留着就是「两个键都说这一家自己填了什么」）。
     新键里已经有这一家时**不搬**（以新键为准）：万一旧键是另一台机器同步回来的陈旧值，
     拿它覆盖本机刚填的那一批就是倒退。 */
  migrate() {
    const moved = [];
    let all = null;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(this.LEGACY_PREFIX)) continue;
        const kid = key.slice(this.LEGACY_PREFIX.length);
        if (!kid) continue;
        let old = [];
        try { const v = JSON.parse(localStorage.getItem(key) || '[]'); old = Array.isArray(v) ? v.map(String) : []; } catch {}
        all = all || this._raw();
        const cur = (all[kid] || {}).typed || [];
        const merged = [...new Set(cur.concat(old.map(x => x.trim()).filter(Boolean)))];
        if (merged.length !== cur.length || JSON.stringify(merged) !== JSON.stringify(cur)) all[kid] = Object.assign({}, all[kid], { typed: merged });
        localStorage.removeItem(key);
        moved.push(kid);
      }
    } catch { return moved; }              // localStorage 不可用（隐私模式）：什么都不动
    if (moved.length) { try { localStorage.setItem(this.KEY, JSON.stringify(all || {})); } catch {} }
    return moved;
  },
};
/* `migrate()` **不在这里跑**：由 `ui.js` 的 DataSync 对账之后调一次（见那里 `afterSynced`）。
   在这里跑等于「先删旧键、再去对账」—— boot 看见服务器有本地没有会把它拉回来，
   每次开页面重复一遍拉回 / 删掉，还在 `.data/` 留一串 `.bak`。 */



/* ============================================================================
   Fav —— 我的收藏（跨页面共用）
     · 收藏资产库文件：{ key:'a:<provider>:<assetId>', kind:'asset', provider, providerName,
                        assetId, type, prompt, src, dl, format, duration, ts }
     · 收藏本地文件：  { key:'l:<fileKey>', kind:'local', fileKey, name, mime, type, size, ts }
       文件本体存在 IndexedDB（fav_db / files），显示时取 blob URL
     · 页面用 Fav.list() 画列表；收藏按钮用 Fav.toggle(...)；变化时派发 'fav-change' 事件
   ========================================================================== */
;

/* ============================================================================
   AiGen —— 「就地生成一张图」的最小实现（导演台的开头画面 / 时间切片用它；选择器不含生成入口）
     · 只走统一层：Api.create（幂等键 / 提示词归档 / 长超时都在里面）+ Api.pollTask
       （Api.pollTask 认 registry 的 pollVia:'list'，页面自己写轮询循环就会踩 VGENV 那个坑）
     · 产物统一包成 AssetLib 同构条目，调用方拿到就能直接当素材用
   ========================================================================== */
/* 同步合成（没有平台任务号那几家）的产物字节在本机落盘失败时先留在内存里，
   让用户「再存一次本机」而不是重花钱再合成一次。只留最近三条，换页就没了 ——
   留的是救命用的兜底，不是一条持久队列（本机镜像队列在 AssetLocal，别在这里再造一份）。 */
const TTS_KEEP = new Map();
function keepTtsBytes(pack) {
  const key = 'tk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  TTS_KEEP.set(key, pack);
  while (TTS_KEEP.size > 3) TTS_KEEP.delete(TTS_KEEP.keys().next().value);
  return key;
}
window.AiGen = {
  /* 把留底的那一份再存一次本机；成功就删掉留底。 */
  async retrySaveTts(key) {
    const pack = TTS_KEEP.get(key);
    if (!pack) throw new Error('这一条的音频留底已经不在了（换过页或已被更新的顶掉），只能重新合成');
    const saved = await Api.saveLocalAsset(pack);
    TTS_KEEP.delete(key);
    return { assetId: saved.assetId || saved.id, url: saved.url || assetSrc(saved.assetId || saved.id),
      format: pack.format, bytes: saved.bytes || 0 };
  },
  hasTtsBytes(key) { return !!key && TTS_KEEP.has(key); },
  QUALITY_ZH: { draft: '草稿', standard: '标准', final: '精修' },
  /* 任务响应里的产物资产 id：既认 registry 列表映射声明的字段，也认几种常见写法 */
  outputIds(prov, raw) {
    if (!raw) return [];
    const m = ((prov && prov.list) || {}).map || {};
    const ids = [];
    const push = v => { const id = typeof v === 'string' ? v : (v && (v.asset_id || v.assetId || v.id)); if (id) ids.push(String(id)); };
    const flat = v => (Array.isArray(v) ? v : (v ? [v] : []));
    if (m.outputs) flat(Api.pick(raw, m.outputs)).forEach(push);
    flat(raw.output_asset_ids).forEach(push);
    flat(raw.outputs).forEach(push);
    flat(raw.output).forEach(push);
    return [...new Set(ids)];
  },
  /* 十六进制 → base64。MiniMax 的 t2a_v2 把音频放在 data.audio，官方文档写的是**十六进制**
     （官方 WebSocket 指南明确写「用十六进制解码，别当 base64」），而 /local-assets 收的是 base64。
     文档与第三方示例在这一点上不一致，所以认不出合法十六进制时**退回按 base64 试一次**，
     两种都解不出才报错 —— 宁可多试一次，也不要让人对着一个能用的接口发愣。 */
  hexToB64(hex) {
    const h = String(hex || '').trim();
    if (!h || h.length % 2 || !/^[0-9a-fA-F]+$/.test(h)) return '';
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  /* 语音合成这一整条链（提交 → 按 tts 声明解码 → pcm16 封 WAV → 存成能播能导的本机资产）。
     全站只有这一份：生成工作台的语音栏与导演台剪辑的声音轨都要「合成一句话、拿回一个地址」，
     各写一遍的结局是「声明 encoding=hex 却按 base64 处理」这类偏差只修好一边（AGENTS §3「同一个功能只应有一份实现」）。
     「这一家怎么定音色」（预设 / 描述 / 参考音频）是页面自己的事，所以 `voice` 由调用方算好递进来。
     o = { model, text, style, voice, format, bools, name, meta } → { assetId, url, format, bytes, usage } */
  async synthTts(prov, o) {
    const tts = (prov && prov.tts) || {};
    const res = await Api.create(prov, {
      model: o.model, text: o.text, style: o.style || '', voice: o.voice || '',
      format: o.format || ((tts.formats || [])[0] || ''),
      textRole: tts.textRole || 'assistant', styleRole: tts.styleRole || 'user',
      ...(o.bools || {}),
      log: false,                       // 同步合成没有平台任务号：归档由调用方按自己的本地号做
    });
    let b64 = Api.pickPath(res, tts.responsePath || 'choices.0.message.audio.data');
    if (b64 && tts.encoding === 'hex') {
      const hx = this.hexToB64(b64);
      if (hx) b64 = hx;
      else console.warn('[AiGen] 声明 tts.encoding=hex，但返回值不是合法十六进制，按 base64 处理');
    }
    if (!b64) throw new Error('接口没有返回音频数据（检查 registry 里 tts.responsePath 声明）');
    let fmt = o.format || ((tts.formats || [])[0] || '');
    if (fmt === 'pcm16') { b64 = this.b64FromBuf(this.pcm16ToWav(b64, tts.pcmSampleRate || 24000)); fmt = 'wav'; }
    const mime = (tts.mime || {})[fmt] || 'audio/wav';
    const name = o.name || ('语音-' + String(o.text || '').replace(/\s+/g, ' ').trim().slice(0, 18) + '.' + fmt);
    const meta = Object.assign({ prompt: o.text, model: o.model, voice: o.voice, provider: prov.id,
      chars: String(o.text || '').length, usage: (res && res.usage) || null }, o.meta || {});
    let saved = null;
    try {
      saved = await Api.saveLocalAsset({ name, mime, format: fmt, data: b64, meta });
    } catch (e) {
      /* 到这一步平台那一份**已经合成、已经扣费**，失败的是本机落盘。绝不能把它报成「合成失败、可重试」
         —— 用户点重试就是第二次付费。字节先留在内存里（最近三条），页面给一颗「再存一次本机」。 */
      const key = keepTtsBytes({ name, mime, format: fmt, data: b64, meta });
      throw Object.assign(new Error('平台已经合成（这一条已经扣费），但产物没能存进本机资产库：'
        + errText(e)), { afterPaid: true, savedFailed: true, keepKey: key });
    }
    return { assetId: saved.assetId || saved.id, url: saved.url || assetSrc(saved.assetId || saved.id),
      format: fmt, bytes: saved.bytes || 0, usage: (res && res.usage) || null };
  },
  /* PCM16 裸流封成 WAV（语音平台的同步产物要能直接播放/保存） */
  pcm16ToWav(b64, sampleRate) {
    const pcm = atob(b64);
    const n = pcm.length;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate || 24000, true); v.setUint32(28, (sampleRate || 24000) * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, pcm.charCodeAt(i));
    return buf;
  },
  b64FromBuf(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); },
  _entry(prov, o) {
    return { kind: 'asset', id: o.assetId || o.id, assetId: o.assetId || '', genId: o.genId || '', status: 'done',
      type: o.type, provider: prov.id, providerName: 'AI 生成 · ' + (prov.displayName || prov.name || ''),
      prompt: o.prompt || '', format: o.format || '', duration: o.duration || null,
      ts: new Date().toISOString(), src: o.src || assetSrc(o.assetId),
      dl: o.dl || assetDl(o.assetId) };
  },
  /* 图片一出结果就通知自动镜像（不再等某个列表页加载 AssetLib）：投事件这一件事不在这里，
     `_entry` 出来的条目直接交给 `AssetLocal.announce` 归一化并投（四个生产点都只调那一条，
     见 local.js 的 announce 说明）。 */
  /* 生成图：create → 轮询到 done → 取产物 id。
     `o.count` = 想要几张（候选一次出多张就靠它）。上限**不在这写死**：调用方按能力声明
     `max_outputs` 传进来，这里只兜底成 1；一张时返回的就是这一条条目（旧调用方照旧用 `.src`），
     多张时额外带 `entries[]`（`src` 仍是第一张，所以没有一处要改）。

     **拆成 create / wait 两段是为了「切页之后还能把任务认领回来」**：外壳换页会把这一页的 JS
     整个丢掉，可平台那边的任务还在跑。`o.onTask({prov, id})` 在拿到任务号的那一刻回调一次，
     调用方把它落盘；下次打开这一页用 `adopt(provId, id)` 接着等 —— **不重发、不重复花钱**。 */
  async create(o) {
    const prov = o.prov, m = o.model || {};
    const fmts = (m.options && m.options.output_formats) || ['png'];
    /* 格式：调用方（导演台的高参设置按平台声明渲染的下拉）选过就照它选的，没选过才退回「优先 png」。
       选中的值不在这一份清单里也退回默认 —— 那个值可能是上一次那份声明（换过型号 / 平台改口）留下的。 */
    const fmt = (o.format && fmts.indexOf(o.format) >= 0) ? o.format : (fmts.includes('png') ? 'png' : fmts[0]);
    const want = Math.max(1, Number(o.count) || 1);
    const gen = await Api.create(prov, {
      model: m.id, prompt: o.prompt, quality: o.quality, ar: o.ar, count: want, format: fmt,
      /* 尺寸（WxH）：平台在 create.body / nest 里映射了才会进提交体，没映射的传过去是空转 ——
         所以这里不带「有没有声明」的判断，判断留给调用方（它按下拉的显隐决定传不传）。 */
      size: o.size,
      /* 参考图条目（素材库的「三视图按预览图生成」用它）：形状由 registry 的 inputTemplates 决定，
         调用方给的是 AssetTransfer.entryFor 出来的 { role, assetId|url }。没传就不带这个字段。 */
      inputEntries: o.inputEntries,
      /* 高级设置那三排「AdvParams 四档之外」的声明驱动项（型号布尔 / create.topBools / create.shapeFields）：
         与生成工作台图像栏同一份读法（AdvExtras.read 的产物），原样转给 Api.createBody，
         由它按 hide / need / from 声明决定哪些真的进提交体。不带 = 这一家声明的顶层开关一个都不发，
         于是同一个平台在工作台能勾「平台提示词优化」，在导演台的画面生成里连控件都没有。 */
      params: o.params, shape: o.shape,
      log: o.log || { type: '图片生成', meta: { 画质: o.quality || '', 画幅: o.ar || '' } },
    });
    const p0 = Api.parseItem(prov, gen);
    const id = (p0 && p0.genId) || (gen && (gen.id || gen.task_id || gen.job_id));
    if (!id) throw new Error((gen && (gen.message || gen.code)) || '接口没有返回任务号');
    if (typeof o.onTask === 'function') { try { o.onTask({ prov: prov, id: id }); } catch (e) {} }
    return { prov: prov, id: id, want: want, fmt: fmt, prompt: o.prompt || '' };
  },
  /* 等一个**已经存在**的任务出结果（自己刚建的，或切页之前建的那一个）。 */
  async wait(t, o) {
    o = o || {};
    const prov = t.prov, id = t.id;
    const want = Math.max(1, Number(t.want) || 1);
    const fmt = t.fmt || 'png';
    const prompt = t.prompt || o.prompt || '';
    /* 轮询只看得到什么就取什么：产物号 / 外链先出现就立刻收（状态字段常常比产物字段晚一两个心跳）。
       失败以 Api.parseItem 的判定为准 —— 它已经把「认不出的中间态」归到进行中，不会一次就误报失败。 */
    for (let i = 0; i < 120; i++) {
      /* 先问一次再等：切页之前发出去的那一批多半早就在平台做完了，
         「睡 2.5 秒才问第一回」等于每条白等一轮 —— 而认领那一趟是逐条串着的，几条就是几轮。
         首问不多发请求：本来每一轮也要问一次。 */
      if (i) await new Promise(r => setTimeout(r, 2500));
      let raw = null;
      try { raw = (await Api.pollTask(prov, id)).raw; } catch (e) { continue; }
      const p = raw ? Api.parseItem(prov, raw) : null;
      const ids = this.outputIds(prov, raw);
      /* 多张时要等到凑齐（或平台已经判完成）再收：只取 ids[0] 的话，
         「一次出 3 张候选」会变成「一次出 1 张、另外 2 张永远看不见」，
         而界面已经写了「正在出第 2、3 张」。 */
      if (ids.length && (ids.length >= want || (p && p.done))) {
        const list = ids.slice(0, want).map(a => this._entry(prov, { assetId: a, genId: id, type: '图片', prompt: prompt, format: fmt }));
        window.AssetLocal.announce(list);
        return Object.assign(list[0], { entries: list });
      }
      /* 产物是外链的不是资产 id（VGENV 这类）：一样换成 /getv 本地路由再回给调用方，
         否则拿到的是过期就 403 的签名地址。 */
      if (p && p.url) {
        const one = this._entry(prov, { id: id, genId: id, type: '图片', prompt: prompt, format: fmt,
          src: Api.mediaSrc(p.url), dl: '/fetch?url=' + encodeURIComponent(p.url) + '&dl=1' });
        window.AssetLocal.announce(one);
        return Object.assign(one, { entries: [one] });
      }
      const why = p && p.error && (p.error.message || p.error);
      if (why) throw new Error(why);
      if (p && p.failed) throw new Error('图片生成失败' + (p.status ? '（' + p.status + '）' : ''));
    }
    throw new Error('生成超时（可能还在排队），稍后可在资产库看到它');
  },
  async image(o) { return this.wait(await this.create(o), o); },
  /* 认领一个「切页之前发出去」的任务：只接着等，不重新提交。
     第一参可以给平台对象，也可以给平台 id（落盘时存的是 id，重启后只能按 id 找回来）。 */
  adopt(provRef, id, o) {
    const list = this.providers() || [];
    const prov = (provRef && typeof provRef === 'object') ? provRef
      : list.find(p => p && (p.id === provRef || p.keyId === provRef));
    if (!prov) return Promise.reject(new Error('这一家平台现在不在注册表里了（可能被删掉或改了 id）'));
    if (!id) return Promise.reject(new Error('没有任务号'));
    return this.wait({ prov: prov, id: id, want: (o && o.want) || 1, fmt: (o && o.fmt) || 'png', prompt: (o && o.prompt) || '' }, o);
  },
};

/* ============================================================================
   AdvParams —— 「高级设置里那几档参数」的取值口径，只有一份（生成工作台 + 导演台共用）
     为什么要有这一块：同一件事以前有四份实现 ——
       · 工作台图像栏 `renderImageParams` + `fillSel`（选项现读声明、回落看「用户点过没有」）
       · 工作台视频栏 `renderVideoParams`（同一套判据，另写一遍）
       · 导演台画面块 `kfOpt` / `kfImgParams`（又是同一套，多了「跟随这一镜」）
       · 导演台视频块（`tiers` / `ars` / `ress` 直接在模板串里 `=== 现值 ? 'selected' : ''`，
         连回落都没有：存的档位被平台下架之后，界面显示第一项、发出去的是另一项）
     四份各自漂开的结果本项目已经反复撞上：「界面写着 A、提交体里是 B」「摘要与下拉各格式化一次」
     （`png` vs `PNG`）、`TIER_ZH` 在两个页面各抄一份。所以这里收口成一份**纯判据**：
     算出每一档的「清单 / 当前值（含回落）/ 显示名 / 这一档出现吗 / 真正发出去的那个值」，
     再顺手拼出摘要与提交体要带的那一份。
     **页面各自的 DOM 画法不在这里**：工作台是「控件常驻 DOM、换类型不重建」（故意的，
     否则换一次档用户挑过的值全丢），导演台是「整块随编辑器重绘」——
     两种都从同一份 `plan()` 取值，就只剩「怎么把值摆进 select」这一层是各页的。
     折叠外壳（`fold`）也在这一层：三块面板各自写「点标题 → toggle closed → 落盘」迟早写成三种。
   ========================================================================== */
window.AdvParams = {
  /* 中文名表只在这里有一份。导演台与工作台以前各抄了一份 `TIER_ZH`（一字不差），
     平台新增一个档位时两边都会显示成英文原值，而界面看起来「已经支持了」。 */
  TIER_ZH: { fast: '快速', standard: '标准', enhanced: '增强', quality: '品质' },
  RATIO_ZH: { '1:1': '方形 1:1', '16:9': '横屏 16:9', '9:16': '竖屏 9:16', '4:3': '横版 4:3', '3:4': '竖版 3:4',
    '3:2': '横版 3:2', '2:3': '竖版 2:3', '21:9': '超宽 21:9', '4:5': '竖版 4:5' },
  /* 每一档：清单从 `options` 的哪个字段来、默认值从 `defaults` 的哪个键来、
     提交体里叫什么（与 `Api.createBody` 的标准字段同名）、界面上叫什么、摘要里带什么单位。
     `label` 是**这一档在界面上的名字**，两个页面的控件标题与摘要里那句「按平台默认」都读它
     （以前工作台写「画面比例 / 质量」、导演台写「画幅 / 画质」，同一个档两套叫法）。
     `unit` 除了摘要里的单位，还决定按档计价那句「· N积分/张」的尾巴 —— 生图只有「张」这一种计量，
     所以写在这一档的声明里，而不是让页面各传一份（工作台传了「/张」、导演台没传，
     同一档在两个页面上就一个写「12积分」一个写「12积分/张」）。
     `keepEmpty` = 空串是这一档的**一个真取值**（「跟随画面自己的比例」），不是「还没选」；
     `many` = 只有一项时不必摆下拉（只有一个格式可选的下拉是假控件），但**声明了照发** ——
     「界面没这一档」与「提交体没这个字段」是两件事，前者看 `on`、后者看有没有声明。 */
  SPEC: {
    tier: { opt: 'tiers', def: 'tier', field: 'tier', label: '档位' },
    quality: { opt: 'qualities', def: 'quality', field: 'quality', label: '画质', unit: '张' },
    resolution: { opt: 'resolutions', def: 'resolution', field: 'res', label: '画质' },
    aspect_ratio: { opt: 'aspect_ratios', def: 'aspect_ratio', field: 'ar', label: '画面比例', keepEmpty: true },
    size: { opt: 'sizes', def: 'size', field: 'size', label: '尺寸' },
    output_format: { opt: 'output_formats', def: 'output_format', field: 'format', label: '格式', many: true },
    duration: { opt: 'durations', def: 'duration', field: 'duration', label: '时长', unit: '秒', numeric: true },
    count: { opt: 'max_outputs', def: 'output_count', field: 'count', label: '生成条数', unit: '条', many: true, numeric: true },
  },
  IMAGE_KINDS: ['quality', 'aspect_ratio', 'size', 'output_format', 'count'],
  VIDEO_KINDS: ['tier', 'resolution', 'aspect_ratio', 'size', 'duration', 'count'],
  /* 显示名只有一份：下拉里的文字、摘要里的那一项、归档日志里的写法，全部过它。
     （撞过的红：下拉写 `png`、摘要写 `PNG` —— 同一个值格式化两次，改一处就对不上。） */
  label(kind, v, model, unit) {
    if (v === undefined || v === null || v === '') return '';
    const s = String(v);
    let t = kind === 'quality' ? ((window.AiGen && AiGen.QUALITY_ZH[s]) || s)
      : kind === 'tier' ? (this.TIER_ZH[s] || s)
        : kind === 'aspect_ratio' ? (this.RATIO_ZH[s] || s)
          : kind === 'output_format' ? s.toUpperCase()
            : kind === 'duration' ? s + ' 秒'
              : kind === 'count' ? s + ' ' + (unit || '条')
                : s;
    /* 价格挂在型号上（`model.price[档位]`），只有按档计价的平台才有；单位跟着这一档的计量走
       （图片是「积分/张」、视频是「积分/条」），别在页面各拼一句。 */
    const p = model && model.price && model.price[s];
    if (p != null && (kind === 'quality' || kind === 'tier' || kind === 'resolution')) t += ' · ' + p + '积分' + (unit ? '/' + unit : '');
    return t;
  },
  /* 一族的参数全算一遍：`o.kinds` 要算哪几档、`o.ids` 页面控件名（回显给调用方接线用）、
     `o.cur` 页面现在存的值、`o.touched` 用户亲手点过哪几档（没有这份账就传 null）、
     `o.follow` 空值时借用谁（只在型号声明里收这个值时才借，借不上就照实说）、
     `o.combo` + `o.scoped` 按输入模式取档（Capabilities.scopedOptions）。 */
  plan(model, o) {
    o = o || {};
    const m = model || {};
    const raw = (o.scoped && window.Capabilities && Capabilities.scopedOptions)
      ? (Capabilities.scopedOptions(m, o.combo) || {}) : (m.options || {});
    const defs = raw.defaults || {};
    const cur = o.cur || {}, touched = o.touched || null, follow = o.follow || {}, ids = o.ids || {}, units = o.units || {};
    const kinds = {};
    const payload = {};
    (o.kinds || Object.keys(this.SPEC)).forEach(k => {
      const s = this.SPEC[k];
      if (!s) return;
      let list = [];
      if (k === 'count') {
        const n = Number(raw.max_outputs) > 0 ? Math.max(1, Math.floor(Number(raw.max_outputs))) : 0;
        list = n > 0 ? Array.from({ length: n }, (_, i) => i + 1) : [];
      } else if (k === 'duration') {
        /* 时长只有「区间」声明（[4,15]）才展开成每一秒一档；写成两个数而后者更小会得到 NaN */
        const d = raw.durations;
        list = (Array.isArray(d) && d.length === 2 && Number(d[1]) >= Number(d[0]) && Number(d[0]) > 0)
          ? Array.from({ length: Number(d[1]) - Number(d[0]) + 1 }, (_, i) => Number(d[0]) + i) : [];
      } else list = (raw[s.opt] || []).map(String);
      const has = v => v !== undefined && v !== null && v !== '' && list.some(x => String(x) === String(v));
      const dflt = s.def ? defs[s.def] : undefined;
      const prev = cur[k];
      const f = follow[k];
      /* 回落的顺序就是这五条（每一页以前都在这里各写一遍，写法还不一样）：
         ① 「跟随」是一个真取值 → 空串留着，不参与回落；
         ② 用户没点过这一档、而声明里有默认档 → 用默认档（能力刷新时自动跟上平台改口）；
         ③ 现值还在清单里 → 保住用户挑的那个；
         ④ 数字档（秒数 / 条数）且现值是个数 → **夹到最近的那一档**：导演台的时长是个滑块，
            12 秒的镜头换到 4–6 秒的型号上应该是 6 秒，跳回最短的那一档等于把人家排好的时间轴打乱
            （这是导演台原来的 clamp 语义，收进公共层一份，不再两处各写）；
         ⑤ 剩下的（档位被平台下架、换过型号）→ 默认档，再没有就第一项。 */
      let value;
      const near = () => {
        const n = Number(prev);
        let best = list[0], bd = Infinity;
        list.forEach(x => { const d = Math.abs(Number(x) - n); if (d < bd) { bd = d; best = x; } });
        return String(best);
      };
      if (s.keepEmpty && (prev === '' || prev === undefined || prev === null) && f) value = '';
      else if (touched && !touched[k] && has(dflt)) value = String(dflt);
      else if (has(prev)) value = String(prev);
      else if (s.numeric && Number.isFinite(Number(prev)) && prev !== '' && prev !== null && prev !== undefined) value = near();
      else if (has(dflt)) value = String(dflt);
      else value = list.length ? String(list[0]) : '';
      /* 真正进提交体的那一个：跟随档在「型号确实收这个值」时才借得到，否则一个字都不发
         （借一个平台不收的写法进去必被拒，这正是导演台画面块上一轮修掉的那件事）。 */
      let sent = value, note = '';
      if (!value && f) {
        if (has(f.value)) { sent = String(f.value); note = (f.note || '跟随画面') + '（' + sent + '）'; }
        else { sent = undefined; note = '按平台默认（不收 ' + (f.value || '这一档') + '）'; }
      }
      const unit = units[k] || s.unit || '';
      kinds[k] = {
        id: ids[k] || k, name: k, label: s.label, list: list, value: value, sent: sent, unit: unit,
        on: !!list.length && !(s.many && list.length < 2),
        min: k === 'duration' && list.length ? list[0] : 0,
        max: k === 'duration' && list.length ? list[list.length - 1] : 0,
        note: note,
        text: v => this.label(k, v === undefined ? value : v, m, unit),
      };
      if (list.length && sent !== undefined && sent !== '') payload[s.field] = sent;
    });
    /* 摘要：只列**这一族真会用到的**那几档 —— 画出来的、以及「声明了但只有一个取值、
       所以不摆下拉却照样发出去」的那几档（不列的话折叠状态下那句「发的是什么」就少一项，
       而少写一项与多写一项一样是编）。没声明的档一个字都不上账。
       顺序按 kinds 传的次序，单位与显示名与下拉同一份 `label`。 */
    const bits = [];
    if (o.prefix) bits.push(o.prefix);
    (o.kinds || Object.keys(this.SPEC)).forEach(k => {
      const x = kinds[k];
      if (!x) return;
      /* 有取值时只写取值（下拉里也是这样，两处同一句）；只有「借来的 / 发不出去」这种
         note 才带档名 —— 它没有值可指，不带名字就不知道在说哪一档。 */
      if (x.on) bits.push(x.note ? x.label + x.note : x.text());
      else if (x.note) bits.push(x.label + x.note);
      else if (x.sent !== undefined && x.list.length === 1) bits.push(x.text());
    });
    return { model: m, options: raw, defaults: defs, kinds: kinds, payload: payload, summary: bits.filter(Boolean).join(' · ') };
  },
  /* 一档的 `<option>` 列表：`value` 属性是**声明里的原始值**（提交体用的那一个），
     看得见的文字过 `label()` —— 下拉与摘要因此永远不会一个写 `png` 一个写 `PNG`。
     `o.first` 是页面自己那一行「跟随 …」：它的值必须是空串，且只有 plan 真的把这一档
     判成空值时才带上 selected（借不到值时 plan 已经回落成实值，选它就得选实值那一项）。
     两种画法都吃这一份：导演台整块重绘拼字符串，工作台给常驻的 select 换 innerHTML。 */
  optionsHTML(k, o) {
    if (!k) return '';
    o = o || {};
    const one = (v, txt, on) => '<option value="' + window.esc(v) + '"' + (on ? ' selected' : '') + '>' + window.esc(txt) + '</option>';
    return (o.first ? one('', o.first, k.value === '') : '')
      + k.list.map(v => one(String(v), k.text(v), String(v) === k.value)).join('');
  },
  /* 折叠外壳：点标题收起/展开，并把状态按调用方给的键落盘（工作台一块、导演台两块，键各一个）。
     打开时写空串而不是 '0'：工作台那份存量数据就是空串，别为了统一去改用户已经存着的键。
     「这一档面板现在是收起的」只有 `closed()` 一份判据，模板据此写初始 class ——
     页面再存一份模块变量的话，点过折叠之后那份变量就是旧的，重绘时面板自己弹开/收起。 */
  closed(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
  },
  fold(head, box, key) {
    if (!head || !box) return () => { };
    box.classList.toggle('closed', this.closed(key));
    const fn = () => {
      box.classList.toggle('closed');
      try { localStorage.setItem(key, box.classList.contains('closed') ? '1' : ''); } catch (e) { }
    };
    head.addEventListener('click', fn);
    return () => head.removeEventListener('click', fn);
  },
};

/* ============================================================================
   AdvExtras —— 高级设置里「AdvParams 那几档之外」的三排声明驱动控件，判据与画法只有一份
     对象：· options.bools        型号能力里的布尔参数（进嵌套 parameters）
           · create.topBools      提交体**顶层**的布尔开关（SparkCine 的平台自动润色 / VGENV 的 Turbo）
           · create.shapeFields   提交体**顶层**的非布尔字段（成片超分档 / 随机种子 / 换人的动作起点）
     为什么要收成这一份：这三排的**判据**本来就在公共层（Capabilities.fieldState / shapeFieldState /
     shapeState），可**画法与取值**只有生成工作台写过一份 —— 于是导演台整块没有这三排：
     同一个平台在工作台上能勾「Turbo 加速档」，在导演台上一个字都不发（界面没画、提交体也没有，
     用户以为两处走的是同一套参数）。页面各自再抄一份 innerHTML 迟早和工作台漂开，所以这里连**标记**
     也一起给出（`html.*`），工作台与导演台都只把它塞进自己的容器，读回来走 `read()` 同一处。
     「这一次的那一行能力」（caps）由调用方算好递进来：它需要「当前输入模式 + 画质档 + 手上这批素材的种类」，
     那些是页面自己的状态，公共层不认识 DOM。
   ========================================================================== */
window.AdvExtras = {
  /* 中文名表只在这里有一份（画在「开/关」那一排的标签上）。平台没给中文名时原样显示字段名，
     而不是让页面自己编一个 —— 编出来的名字与平台文档对不上，用户去查接口时找不到这一项。 */
  BOOL_ZH: { generate_audio: '生成音频', sound: '生成音频', with_audio: '生成音频', mute_reference_video: '静音参考视频' },
  boolDecls(model) {
    return ((model && model.options && model.options.bools) || {});
  },
  topBoolDecls(prov) {
    const t = (prov && prov.create && prov.create.topBools) || null;
    return t && typeof t === 'object' ? Object.entries(t) : [];
  },
  shapeFieldDecls(prov) {
    const t = (prov && prov.create && prov.create.shapeFields) || null;
    return t && typeof t === 'object' ? Object.entries(t) : [];
  },
  /* 某个顶层开关在不在、默认开还是关 —— 判据 Capabilities.fieldState 一份（提交体问的是同一个）。 */
  topBoolStateOf(d, ctx) {
    if (window.Capabilities && Capabilities.fieldState) return Capabilities.fieldState(d, ctx);
    return { hidden: false, def: !!(d && d.def), note: '' };
  },
  shapeFieldStateOf(d, caps, ctx) {
    if (window.Capabilities && Capabilities.shapeFieldState) return Capabilities.shapeFieldState(d, caps, ctx);
    return { shown: true, values: [], min: d && d.min, max: d && d.max, none: (d && d.none) || null };
  },
  /* 「这三排在这一家 / 这一个形状上到底画得出几项」。
     给「高级设置整块要不要出现」用：被形状藏掉的那一项不占数（它们只在原位留一句说明），
     所以必须按 topBoolStateOf / shapeFieldStateOf 现判，不能只数声明的长度。
     页面不许自己数第二份 —— 数少了把真有开关的一家整块藏掉，数多了摆一个空盒子骗人。 */
  visibleCount(prov, model, ctx) {
    const Y = window.AdvExtras, c = ctx || {};
    const caps = c.caps || null;
    let n = Object.keys(Y.boolDecls(model || {})).length;
    Y.topBoolDecls(prov).forEach(pair => { if (!Y.topBoolStateOf(pair[1], c).hidden) n++; });
    Y.shapeFieldDecls(prov).forEach(pair => { if (Y.shapeFieldStateOf(pair[1], caps, c).shown) n++; });
    return n;
  },
  /* 换平台/型号后把声明里没有的旧值清掉：留着会被带进提交体，
     而那一族的判据是「没声明的字段进嵌套对象」= 往 parameters 里塞一个别家的键。 */
  prune(state, decls) {
    const names = decls.map(x => (Array.isArray(x) ? x[0] : x));
    Object.keys(state || {}).forEach(f => { if (!names.includes(f)) delete state[f]; });
  },
  html: {
    /* options.bools：开/关两个取值的小下拉，画在 .adv-grid 里与别的档并排。
       `o.av` 是页面那份「用户点过没有」的账（工作台存 autoVals，导演台直接存这一镜），
       没动过的项按声明默认、动过的项保住用户挑的那个；`o.forceDef` = 换了型号那一次，
       声明的默认值直接赢过账上那份（新型号的参数是另一套，拿旧型号的手动选择去压住它才是错的）。 */
    bools(model, o) {
      const opt = o || {};
      const bools = window.AdvExtras.boolDecls(model);
      const store = opt.av || {};
      const html = Object.keys(bools).map(k => {
        const d = bools[k] || {};
        const prev = store['bool_' + k];
        const on = (opt.forceDef || prev === undefined) ? (d.def !== false) : (prev === '1');
        return '<div><label>' + window.esc(window.AdvExtras.BOOL_ZH[k] || k)
          + (d.bills === false ? '<span class="sel-hint">不影响计价</span>' : '')
          + '</label><select data-bool="' + window.esc(k) + '">'
          + '<option value="1"' + (on ? ' selected' : '') + '>开</option>'
          + '<option value="0"' + (on ? '' : ' selected') + '>关</option></select></div>';
      }).join('');
      return { html: html, count: Object.keys(bools).length };
    },
    /* create.topBools：一颗磁贴（`.tool.on` 公共类），声明几项画几颗。
       被形状藏掉的那一项不是「消失了」，是「这一档没有这个开关」—— 照声明把原因写在原位，
       否则用户刚在别的模式下见过它，切一档就凭空不见，只能自己猜是不是坏了。 */
    topBools(prov, model, ctx, st) {
      const Y = window.AdvExtras;
      const decl = Y.topBoolDecls(prov);
      const shown = [], muted = [];
      decl.forEach(([f, d]) => {
        const s = Y.topBoolStateOf(d, ctx);
        if (s.hidden) { if (s.note) muted.push(s.note); return; }
        const on = st[f] === undefined ? s.def : !!st[f];
        shown.push('<div><span class="ed-label">' + window.esc((d && d.label) || f) + '</span>'
          + '<button type="button" class="tool' + (on ? ' on' : '') + '" data-tb="' + window.esc(f) + '"'
          + ((d && d.hint) ? ' title="' + window.esc(d.hint) + '"' : '') + '>'
          + '<span class="ic" data-icon="wand" data-size="13"></span>' + (on ? '已开启' : '未开启') + '</button></div>');
      });
      return {
        html: shown.join('')
          + (muted.length ? '<div class="hint" style="font-size:11.5px;color:var(--sub)">' + muted.map(window.esc).join('<br>') + '</div>' : ''),
        count: decl.length, model: model, decl: decl,
      };
    },
    /* create.shapeFields：声明几项画几项，每一项再问一次「这一次的那一行能力给不给」。
       不给的项不留一格点了没反应的空控件，原因写在原位（why 来自声明，页面不编）。 */
    shapeFields(prov, caps, ctx, st) {
      const Y = window.AdvExtras;
      const decl = Y.shapeFieldDecls(prov);
      const cells = [], muted = [];
      decl.forEach(([f, d]) => {
        const s = Y.shapeFieldStateOf(d, caps, ctx);
        const name = (d && d.label) || f;
        if (!s.shown) { if (s.why) muted.push(name + '：' + s.why); return; }
        const label = '<label' + (d.hint ? ' title="' + window.esc(d.hint) + '"' : '') + '>' + window.esc(name) + '</label>';
        const have = st[f] === undefined || st[f] === null ? '' : String(st[f]);
        const vals = s.values || [];
        if (vals.length) {
          /* 取值清单来自**这一行的能力**（from:'caps.xxx'），一项不写死；
             声明里的 `none` 是界面给的空值选项（「不超分」在上游不是档位，是「不发这个字段」）。 */
          const keep = vals.some(x => String(x) === have) ? have
            : (d.none && String(d.none.value) === have ? have : String(vals[0]));
          st[f] = keep;
          cells.push('<div>' + label + '<select data-sf="' + window.esc(f) + '">'
            + (d.none ? '<option value="' + window.esc(String(d.none.value)) + '"'
              + (String(d.none.value) === keep ? ' selected' : '') + '>' + window.esc(d.none.label || '不设') + '</option>' : '')
            + vals.map(x => '<option value="' + window.esc(String(x)) + '"' + (String(x) === keep ? ' selected' : '') + '>'
              + window.esc(String(x)) + '</option>').join('') + '</select></div>');
        } else {
          const num = d.kind === 'int' || d.kind === 'number';
          cells.push('<div>' + label + '<input class="ui-inp" type="' + (num ? 'number' : 'text') + '"'
            + (num && d.kind === 'int' ? ' step="1"' : '')
            + (d.min !== undefined ? ' min="' + d.min + '"' : '')
            + (d.max !== undefined ? ' max="' + d.max + '"' : '')
            + ' data-sf="' + window.esc(f) + '" value="' + window.esc(have) + '" placeholder="'
            + window.esc(d.placeholder || (num ? '留空 = 不发这一项' : '')) + '"></div>');
        }
      });
      return {
        html: cells.join('')
          + (muted.length ? '<div class="hint" style="font-size:11.5px;color:var(--sub)">' + muted.map(window.esc).join('<br>') + '</div>' : ''),
        count: decl.length, shownCount: cells.length, muted: muted,
      };
    },
  },
  /* 读回界面：顶层开关 + 顶层非布尔字段一次读完，返回
       { params, bools, topBools, shapeFields, summary, bad }。
     o = { root, prov, ctx, caps, topBoolState, shapeState, bools }
       · root          装 `data-sf` 控件的容器（没有容器就退回 shapeState 里那份状态）
       · ctx           「这一次的那一行能力」的上下文 { mode, intent, caps }
       · caps          同一个 caps（判「这一行给不给」用它，不重复算）
       · topBoolState  页面那份顶层**布尔**开关状态（工作台的 cur().topBools、导演台的 sh.topBools）
       · shapeState    页面那份顶层**非布尔**字段状态 —— 与上面是两个口径，合成一个对象迟早互相踩
                       （布尔按 `!!` 判、非布尔按取值与越界判，重名时更会直接盖）。
       · bools         页面自己读完的 `options.bools`（**故意不在这里读**：那一排是型号能力里的布尔，
         画不画由页面按类型决定 —— 生成工作台只在视频台画它，图像台没有这些控件；
         公共层去 DOM 里扫 `data-bool` 会把上一个类型留下的旧控件当成这一条任务的参数发出去。）
     · params  = 递进 Api.createBody 的 `params`（bools 与顶层开关/字段同名混在一起没关系：
       createBody 按声明决定哪一项走顶层、哪一项进嵌套）。
     · summary = 归档与折叠摘要里那句「这次真带了哪几项」，只报真发出去的（与提交体同一个判据）。
     · bad     = 填了却明显越界的值（边界只读声明里的 min/max），当场拦住比让平台回一句 400 好。 */
  read(o) {
    const opt = o || {};
    const Y = window.AdvExtras;
    const bst = opt.topBoolState || {};
    const sst = opt.shapeState || {};
    const bools = opt.bools || {};
    const topBools = Y.topBoolStateMap(opt.prov, opt.ctx, bst);
    const shapeFields = {}, summary = [], bad = [];
    /* 摘要要把「型号布尔 + 顶层开关 + 顶层非布尔字段」三排都写进去，而不是只写最后那一排：
       这三项都是**真的进提交体**的（params 里就是它们三份合并），摘要只报其中一类，
       折叠行就变成「勾了平台自动润色而那一行一个字不提」—— 与本项目反复拦的
       「摘要写着 A、请求里没有 A」是同一个毛病的反方向。开与关都写：关也是发出去的一项。 */
    Object.keys(bools).forEach(k => summary.push((Y.BOOL_ZH[k] || k) + (bools[k] ? ' 开' : ' 关')));
    Y.topBoolDecls(opt.prov).forEach(([f, d]) => {
      if (!(f in topBools)) return;   // 被形状藏掉的那一项根本没进 params，摘要也不提
      summary.push(((d && d.label) || f) + (topBools[f] ? ' 已开启' : ' 未开启'));
    });
    const root = opt.root;
    /* 找「这一档当前画出来的那个控件」：按属性值逐个比，不把字段名拼进选择器
       （`CSS.escape` 是 CSSOM 草案里的东西，浏览器基本没有实现；而字段名来自注册表，
       哪天带一个引号或点就会把选择器拆坏，并且静态语法检查一个字都不报）。 */
    const findSf = f => {
      if (!root || !root.querySelectorAll) return null;
      for (const el of root.querySelectorAll('[data-sf]')) {
        if (el.getAttribute('data-sf') === f) return el;
      }
      return null;
    };
    Y.shapeFieldDecls(opt.prov).forEach(([f, d]) => {
      if (!Y.shapeFieldStateOf(d, opt.caps, opt.ctx).shown) return;
      const el = findSf(f);
      const raw = el ? el.value : sst[f];
      if (raw === undefined || raw === null || String(raw) === '') return;
      if (d.kind === 'int' || d.kind === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) { bad.push(((d && d.label) || f) + '要填一个数'); return; }
        if (d.min !== undefined && n < Number(d.min)) { bad.push(((d && d.label) || f) + '不能小于 ' + d.min); return; }
        if (d.max !== undefined && n > Number(d.max)) { bad.push(((d && d.label) || f) + '不能大于 ' + d.max); return; }
        if (d.kind === 'int' && !Number.isInteger(n)) { bad.push(((d && d.label) || f) + '要填整数'); return; }
        shapeFields[f] = n;
      } else shapeFields[f] = String(raw);
      summary.push(((d && d.label) || f) + ' ' + shapeFields[f]);
    });
    return {
      params: Object.assign({}, bools, topBools, shapeFields),
      bools: bools, topBools: topBools, shapeFields: shapeFields,
      summary: summary.join(' · '), bad: bad,
    };
  },
  /* 界面上「现在开着哪些顶层开关」——摘要与估价都读这一份，别按 DOM 现找。 */
  topBoolStateMap(prov, ctx, st) {
    const Y = window.AdvExtras, out = {};
    Y.topBoolDecls(prov).forEach(([f, d]) => {
      const s = Y.topBoolStateOf(d, ctx);
      if (!s.hidden) out[f] = st[f] === undefined ? s.def : !!st[f];
    });
    return out;
  },
  /* 把画出来的 `options.bools` 那一排读回来，并顺手记进 `store`（`bool_<字段>` = 控件里的 '1'/'0'）。
     记这本账是为了「用户点过没有」：换型号重画时，点过的保住、没点过的跟新声明的默认值走
     （见 `html.bools` 的 forceDef）。两个页面各写一遍 querySelectorAll 迟早漂，所以画法与读法都在这里。 */
  boolsFromDom(root, store) {
    const out = {};
    if (!root || !root.querySelectorAll) return out;
    root.querySelectorAll('[data-bool]').forEach(sel => {
      out[sel.dataset.bool] = sel.value === '1';
      if (store) store['bool_' + sel.dataset.bool] = sel.value;
    });
    return out;
  },
};

/* ============================================================================
   TtsAdv —— 语音那一栏「合成设置」的取值口径与画法，只有一份
     生成工作台的语音栏与导演台「加一句配音」以前各画一套：
       · 输出格式：工作台读 `model.options.formats` 再回落到 `tts.formats`，导演台只读 `tts.formats`
         —— 于是「这一家某个型号多给一种格式」在工作台上能选、在导演台上一个字都不提。
       · 音色：工作台带 `lang` / `gender` 两个后缀，导演台只带 `lang`。
       · 顶层开关（create.topBools）：工作台画了**两遍**（`#topBools` 那一排公共磁贴 +
         语音格里一个私有的 `#boolBoxA`），提交时读的是后者，于是前一排「勾了不算数」；
         导演台又自己拼了第三套 `<select data-vbool>`。
     这里收成一份：清单 / 选项文案 / 顶层开关的画法与读回，两个页面都问它 ——
     声明一出现就在两处同时出现，不用再改两遍。
     「音色怎么给（预设 / 描述 / 复刻）」仍是页面自己的事：那要看这一家声明的型号与模式，
     两个页面拿到的型号清单来源本就不同（工作台用注册表，导演台会现拉 /models）。
   ========================================================================== */
window.TtsAdv = {
  /* 输出格式：型号自己声明的优先（同一家不同型号能收的格式不一样），没有再看平台级声明。 */
  formats(prov, model) {
    const tts = (prov && prov.tts) || {};
    const list = (((model && model.options) || {}).formats) || tts.formats || [];
    return (Array.isArray(list) ? list : []).map(String);
  },
  voices(prov, model) {
    const tts = (prov && prov.tts) || {};
    const list = (((model && model.options) || {}).voices) || tts.voices || [];
    return Array.isArray(list) ? list : [];
  },
  /* pcm16 要写明会自动封装成 WAV：平台真的返回裸 PCM，不封就播不出来。
     这句话以前只写在工作台的选项里，导演台同一档只有干巴巴一个 “pcm16”。 */
  formatOptionsHTML(list, cur) {
    return list.map(f => '<option value="' + window.esc(f) + '"' + (String(f) === String(cur) ? ' selected' : '') + '>'
      + window.esc(String(f).toUpperCase() + (f === 'pcm16' ? '（会自动封装成 WAV）' : '')) + '</option>').join('');
  },
  voiceOptionsHTML(list, cur) {
    return list.map(v => '<option value="' + window.esc(v.id) + '"' + (String(v.id) === String(cur) ? ' selected' : '') + '>'
      + window.esc(v.name) + (v.lang ? ' · ' + window.esc(v.lang) : '') + (v.gender ? ' · ' + window.esc(v.gender) : '')
      + '</option>').join('');
  },
  /* 顶层开关那一排（create.topBools）：画法用公共层 AdvExtras 那一套磁贴 ——
     工作台高级设置里那一排、导演台「合成设置」里那一排，因此是**同一颗磁贴**。 */
  topBoolsHTML(prov, model, ctx, st) {
    const h = window.AdvExtras.html.topBools(prov, model, ctx, st || {});
    return { html: h.html, count: h.count };
  },
  /* 磁贴的点法也只有一份：点一下翻状态、换文案。
     两个页面各写一遍就会出现「一边点了有反应、另一边点了不动」—— 而它们看起来一模一样。 */
  bindTopBools(root, st, onChange) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-tb]').forEach(b => {
      b.onclick = () => {
        const f = b.getAttribute('data-tb');
        st[f] = !st[f];
        b.classList.toggle('on', !!st[f]);
        b.innerHTML = '<span class="ic" data-icon="wand" data-size="13"></span>' + (st[f] ? '已开启' : '未开启');
        if (window.fillIcons) window.fillIcons(b);
        if (onChange) onChange(f, !!st[f]);
      };
    });
  },
  /* 读回这一次真正要发出去的顶层开关（+ 顶层非布尔字段）。
     `st` 是页面那一份状态（工作台 cur().topBools、导演台 voiceDraft.tb）——
     **不扫 DOM**：磁贴的状态就在那份对象里，扫 DOM 会把「声明里有、但这一档被藏掉」的项也读进来。 */
  read(prov, ctx, st) {
    const o = st || {};
    const ex = window.AdvExtras.read({
      root: null, prov: prov, ctx: ctx || {}, caps: (ctx && ctx.caps) || null,
      topBoolState: o, shapeState: {}, bools: {},
    });
    return { topBools: ex.topBools, summary: ex.summary, bad: ex.bad };
  },
  /* 「这一档定音色必填的那样东西缺了没有」那句 —— 两页一份措辞。
     AGENTS 早就写着「工作台 submitBlockReason 的语音分支同一套」，可以前两边各写一句：
     导演台说「「音色设计」型号要先写一段声音描述（上面那个声音描述框）」，
     工作台说「「音色设计」型号必须填写风格 / 音色描述」—— 同一个缺陷两种说法，
     而括号里那句指的路径在两页也不同名，所以换成不指着某一栏的说法。
     `o.ref` 由调用方折算成「有没有一条真拿得到字节的参考音频」（两页的存法本来就不同：
     导演台是一句 `{src, file, assetId}`，工作台是槽位里的条目数组）。 */
  wayWhy(way, o) {
    const d = o || {};
    if (!way || way.mode === 'none') return (way && way.why) || '这一家没有能直接合成的型号';
    if (way.mode === 'design' && !String(d.design || '').trim()) return '「音色设计」型号要先写一段声音描述（这一档靠描述定音色）';
    if (way.mode === 'clone' && !d.ref) return '「音色复刻」型号要先选一条参考音频（平台照它复刻音色）';
    return '';
  },
};
/* ============================================================================
   CharLimits —— 「这段文本的字数在不在这一家声明的区间里」全站只有这一份
     上下限怎么读（tts / prompt）、区间怎么写（range / note）、现在几个字与差几个字
     （count / gap）、拦住那一句怎么说（why）全在这里。页面只递自己的上下文：
     这一栏旁边指的名字是谁（`who`，默认「这一家」）、说的是哪一种文本（`noun`，如「提示词」）。
   为什么要收成一份：同一个判据原来有四个落点、四套措辞 ——
     · 工作台就绪判定「文本至少 5 个字」/「文本超长（最多 5000 字）」，
     · 工作台提示行「平台要 5–5000 字」/「还差 3 字」，
     · 导演台配音栏「这一家要求至少 5 个字（现在 2 个字）」，
     · `Api.createBody` 提交前再拼第四套（「VGENV 的提示词最多 30000 个字…」）。
     于是同一句 2 个字的台词在三处是三种话，「差几个字」只有工作台说，
     「5000 字」与「5000 个字」两种写法各漂各的。
   字数一律按 trim 之后算（与真的发出去那一份一致）—— 导演台以前初值用不 trim 的长度、
   判据用 trim 的长度，「0 字」配一句「现在是空的」就是这么对不上的。
   提示词那一路（`create.promptLimits`）**目前没有任何一家声明**（VGENV 那条 2026-10 实测之后
   整块删了：它其实没有字数限制，见 proxy.js 的 vgenv.create）。机制留着是给哪天真声明的那一家 ——
   没有声明 = 不画区间、不拦，页面一个字都不编。
   ========================================================================== */
window.CharLimits = {
  bounds(min, max) {
    return { min: Math.max(0, Number(min) || 0), max: Math.max(0, Number(max) || 0) };
  },
  /* 语音：`tts.minChars` / `tts.maxChars`（MiMo 5–5000、MiniMax 1–10000）。 */
  tts(tts) {
    const t = tts || {};
    return window.CharLimits.bounds(t.minChars, t.maxChars);
  },
  /* 提示词：`create.promptLimits`，`byIntent` 那一档（动作换人允许省略、上限另算）只在这里合一次。
     `omitted` 只有提交那一路用得上：界面上「空」本来就走「先写提示词」那一句，不归长度闸管。 */
  prompt(pl, intent) {
    const P = pl || {}, iw = (P.byIntent || {})[intent || ''] || null;
    const b = window.CharLimits.bounds(
      iw && iw.min != null ? iw.min : P.min,
      iw && iw.max != null ? iw.max : P.max);
    b.omitted = !!(iw && iw.omitted);
    return b;
  },
  has(b) { return !!(b && (b.min || b.max)); },
  count(text) { return String(text == null ? '' : text).trim().length; },
  /* 区间的写法只有一种：`5–30000`、只给上限的是 `0–5000`、只给下限的是 `5–∞`。
     工作台以前用 `[min, max].filter(Boolean).join('–')`，只有下限时写成「（5 字）」——
     看着像「正好 5 个字」，而那一家的意思是最少 5 个。 */
  range(b) { return (b.min || 0) + '–' + (b.max || '∞'); },
  note(b, who) {
    return window.CharLimits.has(b)
      ? (who || '这一家') + ' ' + window.CharLimits.range(b) + ' 字' : '';
  },
  /* 计数那一行整句（`12 字 · 这一家 5–5000 字`）：初次渲染与就地刷新都写这一句。
     导演台以前就地那一下只写「12 字」，敲一个字声明的区间就从界面上消失了。 */
  cntLine(text, b, who) {
    const n = window.CharLimits.count(text) + ' 字';
    const nt = window.CharLimits.note(b, who);
    return nt ? n + ' · ' + nt : n;
  },
  over(text, b) { return !!(b && b.max && window.CharLimits.count(text) > b.max); },
  /* 差多少字（只在写得出来的时候说：没声明的什么都不说）。 */
  gap(text, b) {
    if (!window.CharLimits.has(b)) return '';
    const n = window.CharLimits.count(text);
    if (b.max && n > b.max) return '超了 ' + (n - b.max) + ' 字，提交会被平台拒收';
    if (b.min && n && n < b.min) return '还差 ' + (b.min - n) + ' 字';
    return '';
  },
  /* 拦住的那一句。`{ now }` 那半是判据的一部分（用户点名的：要说清现在几个字），
     出路那半按 `noun` 给 —— 只有提示词那一栏需要教人补什么，配音栏缺的是「念的话」本身。 */
  why(text, b, o) {
    const oo = o || {}, noun = oo.noun || '', who = oo.who || '这一家';
    if (!window.CharLimits.has(b)) return '';
    const req = noun ? who + ' 要求' + noun : who + '要求';
    const n = window.CharLimits.count(text), adv = noun === '提示词';
    if (b.min && n < b.min) {
      return req + '至少 ' + b.min + ' 个字（' + (n ? '现在 ' + n + ' 个字' : '现在是空的') + '）'
        + (adv ? (n ? ' —— 太短平台会拒，补一句画面/动作描述' : ' —— 写一句画面描述再提交，空提示词平台会直接拒') : '');
    }
    if (b.max && n > b.max) {
      return req + '最多 ' + b.max + ' 个字（现在 ' + n + ' 个字）' + (adv ? ' —— 先精简再提交' : '');
    }
    return '';
  },
};
/* ============================================================================
   AssetPicker —— 全站唯一的「选择参考素材」弹窗（导演台 / 生图台 / 视频台 / 语音台共用）
     const list = await AssetPicker.open({ types: ['图片'], multiple: true, limit: 9, title: '选择参考图' });
     返回 AssetLib 同构条目数组（含 assetId / src / dl / type / prompt / duration …）。
     三个入口在同一套界面里：资产库 / 我的收藏 / 本地上传。
       · aiSearch:true —— 显示「AI 检索」入口（只在素材堆里挑，不生成）
       · chars:'audio' —— 再加**第四个来源「素材库」**：素材身上挂着的参考音频（音色复刻取料处）。
         名单与取字节都在 `chars.js` 的 `Pipe.libVoiceEntries`，这一层只认条目上的 `getSrc` / `getBlob`，
         不认识库里那一列叫什么名字。
       · chars:'note'  —— 同样加「素材库」那一档，但**只有这一档**：音色描述只可能写在素材条目身上，
         资产库 / 收藏 / 本机上传里根本没有这种东西，加载它们纯属白跑一趟。
       · upload:false  —— 关掉「本地上传」；upload:{ accept, multiple } 可覆盖按 types 推出的接受类型
       · note          —— 标题下的一行说明（例如「选视频则取它的最后一帧」）
       · onPick(entry) —— 单选时想拿到条目就走回调而不是等 Promise（弹窗会自己关掉）
     条目上可能带的来源标记：fromLocal（本机文件，src 是 blob 地址，带 file）
     这里不放生成入口：要出图 / 出视频 / 出语音都去对应的工作台，它们才是生成地方。
   ========================================================================== */


/* ============================================================================
   VoiceNote —— 「取一位素材的音色描述，填进面前这一格」整链（唯一一份）
     2026-10-17 从导演台 design 档与生成工作台「风格 / 音色描述」那两处逐字副本收成。
     两份副本漂开的第一处永远是**措辞**（弹窗标题、那句「那一位身上没有描述」的出路、
     覆盖前那一句问话），而第二处是**顺序**：先问空不空、再问覆盖，反过来就变成
     「用户点了覆盖、结果填进去一个空串」。所以链留在这里，页面只给三个口子：
       · value()      读此刻框里是什么（判断要不要问覆盖）
       · write(t)     写回去 —— 页面自己的记账与就地重画都挂在这一步
       · say(html)    说给用户听（页面自己的那一行读数，不是公共层的 Toast）
     名单与字节都不过这里：走的是统一选择器第四个来源（`chars:'note'`），
     「哪几位写过描述」的判据留在 `chars.js`。
     ========================================================================== */
window.VoiceNote = {
  TITLE: '取一位素材的音色描述',
  async run(o) {
    const say = (o && o.say) || (() => {});
    const got = await window.AssetPicker.open({
      types: ['音色描述'], multiple: false, limit: 1, upload: false, chars: 'note',
      title: window.VoiceNote.TITLE,
      note: '这里列的是素材库里写过音色描述的那些位；挑一位，把它身上那段话填进上面那一格。',
    });
    if (!got || !got.length) return;
    const t = String(got[0].text || '').trim();
    if (!t) { say('<span class="err">那一位身上没有可用的音色描述（到素材库页给它写一段）</span>'); return; }
    const now = String((o && o.value ? o.value() : '') || '').trim();
    if (now && now !== t) {
      const yes = await window.Confirm.ask({ title: '覆盖这一格的声音描述？',
        body: '现在框里是「' + now.slice(0, 40) + '」，要换成「' + t.slice(0, 40) + '」吗？',
        okLabel: '换成它', cancelLabel: '留着我现在这句' });
      if (!yes) { say('<span class="info">没有覆盖，框里还是原来那句</span>'); return; }
    }
    if (o && o.write) o.write(t);
    say('<span class="ok">✓ 已取用「' + window.esc(String(got[0].name || '那一位')) + '」的音色描述</span>');
  },
};

/* ============================================================================
   TextAI —— 文字 AI（OpenAI 兼容）统一入口
     · 供应商：REG 里 kind === 'text' 的那几条，用哪一家存 sk_text_prov（默认 OpenRouter）
     · 模型：**只有**接口 /models 拉到的 + **用户自己填的**（自己填的那一批与「藏了哪几个」
             一起存在 `sk_model_prefs` 里，按 keyId 分格 —— 见 window.ModelPrefs），
             当前选中存 sk_model_<keyId>。**不从 registry 写死的清单里兜底** ——
             没点过「获取型号列表」就是没有型号，请求前会点名让人去点它
     · 基址：可填自定义 OpenAI 兼容地址，存 sk_base_<keyId>（走 x-up-base 头临时换基址）
   用法：await TextAI.chat(REG, systemPrompt, userPrompt)  → 返回文本
        await TextAI.chat(REG, sys, user, { images })      → 带图（模型支持识图时按 OpenAI 多模态格式提交）
        await TextAI.models(REG)                          → 返回模型 id 数组（顺带缓存「能否识图」）
        await TextAI.askPolish(REG, sys, user, opts)  → 让它判断该不该反问（返回 {need, questions[]}）
        await TextAI.visionAsync(REG)                     → 先取接口能力再判定识图
        await TextAI.polishImages(REG, [{label, src}])    → 润色要附带的图片 + 给界面看的一句说明
   ========================================================================== */

/* ============================================================================
   AiFind —— 「写一句话，让文字 AI 在本机这一堆里挑几条」只有这一份
   ---------------------------------------------------------------------------
   收成之前素材库与收藏各写一份：同样两道闸、同一个按钮 busy 态、同一份 JSON 契约、
   同一套「集合 + 名次 + 理由」记账。两份漂开的第一处**不是文案，是说出去的那一格** ——
   素材库那两道闸走 `Toast.err`（一定弹），收藏走 `Toast.info`（默认被 `sk_quiet_ok` 静音）：
   「搜索框里没写字就点 AI 找素材」在一页会说一句，在另一页**按了什么都没发生**（按钮转完圈自己复位，
   列表也没动，而那句解释一个字都没显示）。这与 §3「拿静音档当唯一出口等于一个字都没说出去」是同一条。
   公共层因此**不再让页面自选提示通道**：闸门那句由 `needMsg` 拼一次，交回 `o.say`（两页都写进按钮旁边那行读数，
   就地、不静音），并且排在 `o.done()` 之后 —— 那一趟重画会重写同一行，先写的被顶掉。
   各页真正不同的只有四件事，全由参数给：名单从哪来（`roster` / `payload`）、AI 那一轮该返回哪个字段（`field`）、
   怎么认一个本机还认识的号（`known`）、挑完之后那三个变量写回哪里（`apply`）。
   ========================================================================== */


/* ============================================================================
   AiStream —— 「让文字 AI 边写边显示」只有这一份
   ---------------------------------------------------------------------------
   以前各处的文字 AI 调用都是「转圈等十几秒 → 一次性蹦出结果」：规划分镜动辄十几秒，
   用户看不出它是在想、还是卡死了、还是早就断了（那三种在界面上长得一模一样）。
   这里把「流式 + 就地面板」收成一个口子：
     · `o.host` —— 把面板画在哪个容器里（公共 `InlinePolish.live`，与润色面板同一套样式）；
     · 返回**完整文本** —— 调用方拿它去 `parseFrames` / `parseJson`，与以前用
       `TextAI.chat()` 一模一样，所以「改成流式」对上层逻辑是零改动的替换；
     · 平台不支持流式时 `chatStream` 自己会退回整包 JSON，面板只在最后一个片段到达时才出现
       （`onDelta` 会带着完整正文回调一次），所以这一层不用再判一次平台；
     · `o.onChunk(text)` —— 想自己显示（比如往一个 textarea 里灌）就传它，不传就用面板。
   ========================================================================== */
window.AiStream = {
  /* 就地面板：把「边收边显」那一套收成一份 —— 宿主 + **被别处重画就重建并补回已收到的字**
     + 收尾收起 / 出错留着。
     为什么单独露出来：有些调用方手里是**自己发起的** chatStream（比如素材库定音色那条链，
     它要顺带处理 JSON），只要一个面板，不该为了它再抄一遍这套逻辑。 */
  panel(host, o) {
    const opt = o || {};
    if (!host || !window.InlinePolish) {
      return { push() {}, done() {}, fail() {}, text: () => '' };
    }
    let p = null, el = null, all = '';
    const ensure = () => {
      if (p && el && host.contains(el)) return p;
      p = window.InlinePolish.live(host, { title: opt.title || 'AI 正在写…', onStop: opt.onStop });
      el = host.firstElementChild;
      if (all) p.push(all, 'content');          // 面板被重画掉了：把已经收到的补回去
      return p;
    };
    return {
      push(piece, kind) {
        if (!piece) return;
        if (kind === 'reasoning') { if (p) p.push(piece, 'reasoning'); return; }
        all += piece;
        if (typeof opt.onChunk === 'function') opt.onChunk(piece, all);
        ensure().push(piece, kind);
      },
      done() { if (window.InlinePolish) window.InlinePolish.clear(host); },
      fail(msg) { if (p) { try { p.fail(msg); } catch (e) {} } },
      text: () => all,
    };
  },
  /* 一次性文字 AI 调用 + 边收边显示。REG 是注册表；`provIn` 可指定某一家（默认用当前选中那家）。 */
  async text(REG, sys, user, o) {
    const opt = o || {};
    if (!window.TextAI) throw new Error('文字 AI 模块没加载');
    const host = opt.host || null;
    /* 没有容器、也没人要 onChunk：退回普通 chat（行为与以前一致，不摆一个看不见的面板） */
    if (!host && typeof opt.onChunk !== 'function') {
      return await window.TextAI.chat(REG, sys, user, { images: opt.images });
    }
    const ctl = new AbortController();
    const live = this.panel(host, {
      title: opt.title, onStop: () => ctl.abort(), onChunk: opt.onChunk,
    });
    try {
      const txt = await window.TextAI.chatStream(REG, sys, user,
        { images: opt.images, signal: ctl.signal }, (piece, kind) => live.push(piece, kind), opt.prov);
      live.done();
      /* 面板在最后会把「正在接收…」收掉；返回值优先用 chatStream 的正规返回，
         它为空（某家只吐片段不给收尾包）时用我们攒的那一份兜底。 */
      return (txt == null || txt === '') ? live.text() : txt;
    } catch (e) {
      /* 中断 / 报错：面板**留着**（已经写出来的字就是用户唯一拿到的结果），
         只把底部那行状态换成原因 —— 直接 clear 等于把证据一起抹掉。 */
      live.fail(errText(e));
      throw e;
    }
  },
};
