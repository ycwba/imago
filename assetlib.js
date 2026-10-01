/* 资产库共享模块：统一拉取与归一化各平台生成内容
   —— 接口调用全部「注册路由驱动」：端点 / 分页 / 字段映射 / 媒体类型 / 创建体 / 余额解析
      都读 /registry 的声明（见 proxy.js 的 REGISTRY 里 list / create / balance）。
      新接入一个平台 = 只在 REGISTRY 里加一条，本文件与各页面都不用改。
   条目：{ kind:'asset'|'task', id, genId?, type('图片'|'视频'), providerName, provider,
          format, prompt, src, dl, ts, status('done'|'running'|'queued'|'failed'), duration?, size? } */

/* ----------------------------------------------------------------------------
   mediaSrc —— 外链媒体（上游签名地址 / 对象存储地址）一律改走本地代理
   页面里的 <img>/<video>/fetch 只碰本地地址，字节由代理取回（/getv 支持 Range，
   播放、抽帧、量体积、下载都能用），所以「所有外部访问都经过本地路由」这条规则没有例外，
   也不会因为上游没给 CORS 头而抽不出帧。
   已经是本地路由的（/asset/、/getv?、/fetch?、/local-assets/）与 data:/blob: 原样返回。

   注意：它必须定义在**模块作用域**（而不是某个 IIFE 里）——
   以前它只写在 Api 闭包内，而 normalize()（AssetLib 闭包）与 Fav 里都是裸调用，
   于是那几处一执行就抛 ReferenceError：VGENV 的每条列表数据在归一化时全挂
   （被 Promise.allSettled 静默吞掉 → 界面上 VGENV 任务永远不出现），收藏资产也一并坏掉。
   Api.mediaSrc 仍然对外暴露同一个实现（页面统一用 Api.mediaSrc）。 */
function mediaSrc(url) {
  const u = String(url == null ? '' : url);
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? '/getv?url=' + encodeURIComponent(u) : u;
}
/* 统一取数出口：优先走 ui.js 的 Net（带超时、退避重试、可读错误文案）；
   没有 Net（极少见）时退回原生 fetch。
   —— 页面与模块里的每一次取数都应该走它：裸 fetch 没有超时，
   上游挂起时请求会永久挂着（按钮一直转、状态永远不变），错误文案也是原始英文。 */
function netFetch(url, opts) {
  return (window.Net && window.Net.fetch) ? window.Net.fetch(url, opts) : fetch(url, opts);
}

/* ============================================================================
   Api —— 统一接口层（全站唯一出口）
     Api.setRegistry(REG) / Api.registry()      注册表（页面已有的 REG 传进来即可，避免重复请求）
     Api.prov(id|keyId|kind|relay)              找平台
     Api.key(prov) / Api.keyId(prov)            密钥（keyId 由 registry 声明，兼容早期别名）
     Api.request(prov, 'create'|'poll'|'list'…) 按端点名拼 URL 并请求（自动带密钥、错误可读）
     Api.create(prov, fields)                   按 registry 的 create 声明拼请求体
     Api.cancel(prov, id) / Api.detail(prov, id)
     Api.balance(prov, raw)                     按 balance.style 解析余额
     Api.listSources()                          按 relay+list 去重后的列表来源
   ========================================================================== */
(function () {
  let _reg = null;
  let _regTs = 0;
  const REG_TTL = 60 * 1000;        // 注册表缓存 1 分钟：代理加了平台，刷新页面就能看到
  const KEY_ALIAS = { 'sparkcine-video': 'sparkcine' };   // 兼容早期只填过别名的密钥

  /* 错误详情：上游（SparkCine 等）把「哪个字段不对」放在 error.details.issues 里，
     但顶层 message 往往只是一句「部分内容需要检查。」——只显示它等于没说。这里把 issues 拼成人话。 */
  const ISSUE_ZH = { too_small: '太短/太小', too_big: '太长/太大', invalid_type: '类型不对',
    invalid_value: '取值不在允许范围内', invalid_enum_value: '取值不在允许范围内',
    invalid_format: '格式不对', invalid_string: '格式不对', above_maximum: '超过上限',
    below_minimum: '低于下限', unrecognized_keys: '包含多余字段', not_multiple_of: '不是允许的倍数' };
  function describeIssue(it) {
    if (!it) return '';
    if (typeof it === 'string') return it;
    const raw = String(it.message || '');
    const zh = ISSUE_ZH[it.code] || '';
    const num = /expected string to have >=(\d+)/.exec(raw) ? '至少 ' + RegExp.$1 + ' 个字符'
      : /at most (\d+)/.exec(raw) ? '最多 ' + RegExp.$1
      : /at least (\d+)/.exec(raw) ? '至少 ' + RegExp.$1
      : /Invalid UUID/i.test(raw) ? '不是合法的 asset id（UUID）' : '';
    const part = [zh, num].filter(Boolean).join('，') || raw || it.code || '';
    const path = it.path || it.key || '';
    return (path ? path + '：' : '') + part;
  }
  /* 上游有些错误只有一句泛化提示（没有字段级 details），这里补一句能落地的解释。
     顺序有意义：越具体的放前面。 */
  const ERROR_HINT = [
    [/PROMPT_COMPILER|PROMPT_OPTIMI|prompt compiler/i, '平台的「提示词编译/优化」服务这次出错了（VGENV 侧，间歇性）——**这条任务没有创建、没有扣费**，稍后重试即可（本页会自动重试一次）'],
    [/需要检查|需人工|under review/i, '平台这次把提交拦下来了（上游只回这一句，实测是间歇性的：同一句提示词过一会儿就能过）——隔几十秒再来一次通常就好'],
    [/余额不足|insufficient|quota|not enough/i, '平台账户余额/额度不够，先到「用量与余额」页看看余额'],
    [/rate limit|too many|频繁|429/i, '请求太频繁，等几十秒再试'],
    [/unauthorized|invalid.*(api|token|key)|401/i, '密钥无效或过期：到「设置」重新填这个平台的密钥（或在 .env 里更新）'],
    [/forbidden|403|permission/i, '这个密钥没有调用该接口的权限（可能是账号未开通 / 权限范围不对）'],
    [/not found|unknown model|does not exist|404/i, '接口或资源不存在：模型可能已被平台下线，任务可能已过期/被清理 —— 换一个模型，或刷新列表看看'],
    [/too large|payload|413|文件过大/i, '素材太大：压缩后再传（视频/音频建议压到几十 MB 以内）'],
    [/unsupported|not support|不支持/i, '平台不支持这次请求的参数组合：换一个参数（分辨率 / 时长 / 比例）再试'],
    [/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i, '与平台的连接中断（网络抖动）：稍后重试；若是大素材上传，先确认网络稳定'],
  ];
  /* 上游「泛化校验失败」：只有一句 message、没有字段级 issues —— 实测是间歇性的（同一请求稍后就能过），
     界面会据此提示「隔一会儿再试」；但**不自动重试**（重试会连发请求、把平台限流顶得更死）。 */
  const isTransient = err => err && err.status === 400 && /VALIDATION_FAILED/i.test(err.code || '') && !(err.issues || []).length;
  function errorMessage(d, status) {
    const e = (d && d.error) || {};
    const issues = (e.details && Array.isArray(e.details.issues)) ? e.details.issues
      : (Array.isArray(e.issues) ? e.issues : []);
    const base = e.message || e.code || (d && (d.message || d.code)) || ('HTTP ' + status);
    const detail = issues.map(describeIssue).filter(Boolean).join('；');
    const hint = (ERROR_HINT.find(([re]) => re.test(base)) || [])[1] || '';
    // 有字段级明细就用明细；没有明细（上游只给了一句泛化提示）就补人能看懂的下一步
    if (detail) return base + '（' + detail + '）';
    return hint ? base.replace(/[。.]+$/, '') + '：' + hint : base;
  }
  /* 外链媒体（上游签名地址、对象存储地址）一律改走本地代理：
     页面里的 <img>/<video>/fetch 只碰本地地址，字节由代理取回（/getv 支持 Range，
     播放、抽帧、量体积、下载都能用）。这样「所有外部访问都经过本地路由」这条规则没有例外，
     也不会因为上游没给 CORS 头而抽不出帧。
     已经是本地路由的（/asset/、/getv?、/fetch?、/local-assets/）与 data:/blob: 原样返回。 */
  /* 请求：统一走 Net（带超时 + 退避重试 + 可读错误）。
     HTTP 状态先判、非 JSON 给可读提示；网络/5xx 重试 1 次（4xx 不重试）。 */
  async function rawFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    // Net 在 ui.js 里定义（各页面都先加载 ui.js）；万一没有就退回原生 fetch，不让功能整体失效
    const r = (window.Net && window.Net.fetch)
      ? await window.Net.fetch(url, { ...opts, retry: opts.retry === undefined ? 1 : opts.retry })
      : await fetch(url, opts);
    const txt = await r.text();
    let d = null, parseErr = null;
    try { d = txt ? JSON.parse(txt) : null; } catch (e) { parseErr = e; }
    if (!r.ok) {
      const err = new Error(errorMessage(d, r.status));
      err.status = r.status;
      err.code = (d && d.error && d.error.code) || (d && d.code) || '';
      err.issues = (d && d.error && d.error.details && d.error.details.issues) || (d && d.issues) || [];
      err.transient = isTransient(err);
      /* 提交类请求 + 5xx/超时：**不知道平台收没收到**。页面据此提示「可能已受理、先核对列表」，
         而不是让用户以为失败直接重试（那会在平台上留下两条重复任务）。 */
      if (['POST', 'PUT', 'PATCH'].includes(method) && (r.status >= 500 || r.status === 408 || r.status === 429)) err.maybeSubmitted = true;
      throw err;
    }
    if (d === null && parseErr) throw new Error('返回了非 JSON 内容（HTTP ' + r.status + '）');
    return d;
  }

  /* 平台的「提示词编译器」偶发失败（VGENV 的 PROMPT_COMPILER_UPSTREAM_ERROR）：
     这种错误说明任务**没有创建**，重试是安全的（不像超时/连接中断那样可能已受理）。
     页面据此自动重试一次，不要各自写正则。 */
  function isRetryableCreateError(e) {
    const t = String((e && (e.code || e.message)) || e);
    return /PROMPT_COMPILER|PROMPT_OPTIMI|prompt compiler/i.test(t);
  }

  /* 列表快照的存活时间：轮询器一轮里会把每个在跑的任务各问一次（见 Api.pollMany），
     同一轮里的请求共用一份列表，所以这个窗口只要盖住「同一轮」就够（轮询间隔 3~4 秒）。 */
  const LIST_SNAP_TTL = 1500;
  const LIST_SNAP = new Map();       // 平台 → { at, promise }（只按平台分，不按任务号）

  window.Api = {
    mediaSrc,                       // 外链媒体 → 本地 /getv 路由（页面渲染统一用它）
    /* 上游错误 → 人话（带 ERROR_HINT 的中文下一步）。TextAI 自己发请求、不走上面的 rawFetch，
       但错误文案必须一致 —— 所以这份格式化对外公开，而不是在 TextAI 里再抄一份。
       （踩过：以前 TextAI 直接调闭包内的 errorMessage，运行期 ReferenceError，界面显示
         「检索失败：errorMessage is not defined」。） */
    errorMessage,
    isRetryableCreateError,         // 平台提示词编译失败等「任务肯定没建」的错误 → 可安全重试
    setRegistry(r) { if (r && r.providers) _reg = r; },
    /* 清掉本机那些「自己会长回来」的接口缓存（设置页的清理按钮用它）：
       换密钥、代理接入新平台、上游改了能力声明却不想等 TTL 时，不必刷新整页。
       只清缓存，不动任何用户数据（历史、收藏、归档都在别处）。 */
    clearCaches() {
      _reg = null; _regTs = 0;
      LIST_SNAP.clear();
      clearQuoteMarks();              // 内存 + 本机记录一起清（否则下次开机又被标「不可用」）
      Object.keys(QUOTE_INFLIGHT).forEach(k => delete QUOTE_INFLIGHT[k]);
      if (window.Capabilities) { Capabilities.unavailable = false; Capabilities.sources = {}; }
    },
    async registry() {
      // 带 TTL：代理改了注册表（接入新平台）后，页面刷新即可看到，不用清缓存
      const now = Date.now();
      if (!_reg || now - _regTs > REG_TTL) {
        /* 取数走统一层：裸 fetch 没有超时也没有重试，代理刚重启时会直接落到「空注册表」 */
        try {
          const r = window.Net ? await Net.fetch('/registry', { timeout: 15000, retry: 2 }) : await fetch('/registry');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          _reg = await r.json(); _regTs = now;
        }
        catch { if (!_reg) _reg = { providers: [] }; }
      }
      return _reg;
    },
    providers() { return (_reg && _reg.providers) || []; },
    /* 按 id / keyId / kind / relay 找平台 */
    prov(ref) {
      const list = this.providers();
      if (!ref) return list[0] || null;
      return list.find(p => p.id === ref || p.keyId === ref)
        || list.find(p => p.kind === ref)
        || list.find(p => p.relay === ref) || null;
    },
    keyId(prov) { return (prov && (prov.keyId || prov.id)) || ''; },
    /* 密钥：只认该平台自己的 keyId（含 registry 声明的别名）。
       绝不跨平台兜底 —— 把 A 平台的密钥发给 B 平台会直接 401（B 原本靠代理注入环境密钥可用） */
    key(prov) {
      const id = this.keyId(prov);
      if (!id) return '';
      return localStorage.getItem('sk_key_' + id) ||
        (KEY_ALIAS[id] ? (localStorage.getItem('sk_key_' + KEY_ALIAS[id]) || '') : '');
    },
    /* 端点 URL：端点名 → relay + 模板（{id} 用 sub 替换） */
    url(prov, name, sub) {
      const ep = prov && prov.endpoints && prov.endpoints[name];
      if (!ep) throw new Error(((prov && prov.name) || '该平台') + ' 没有声明「' + name + '」接口（请在 proxy.js 的 REGISTRY 里补上）');
      // 'local:/xxx' = 代理本地端点（如本地资产库），不加 relay 前缀
      const local = ep.startsWith('local:');
      const path = local ? ep.slice('local:'.length) : prov.relay + ep;
      return sub != null ? path.replace('{id}', encodeURIComponent(sub)) : path;
    },
    headers(prov, extra) {
      const h = { ...(extra || {}) };
      const k = this.key(prov);
      if (k) h['Authorization'] = 'Bearer ' + k;
      return h;
    },
    async request(prov, name, opts = {}) {
      const method = (opts.method || 'GET').toUpperCase();
      const q = opts.query ? ('?' + (opts.query instanceof URLSearchParams ? opts.query.toString() : String(opts.query))) : '';
      const headers = this.headers(prov, opts.headers);
      if (opts.body != null) headers['Content-Type'] = 'application/json';
      if (opts.noCache) headers['x-no-cache'] = '1';        // 强制回源，跳过代理的列表短缓存
      /* 幂等键由 registry 声明决定（create.idempotencyKey，默认支持）：
         · 支持（如 SparkCine）：带上。缺了它上游直接 400，只回一句「部分内容需要检查。」——
           所以统一在路由层兜底补上，页面封装漏传 headers 也不会再踩这个坑。
           带键的 POST 才允许 Net 层自动重试（服务端按键去重，重试不会建出第二条任务）。
         · 不支持（如 VGENV / MiMo）：不但补，还要把页面显式塞进来的删掉 ——
           没有去重保证时重试会重复建任务、重复扣费（见 ui.js 的 Net.fetch 重试策略）。 */
      const wantIdem = !((prov && prov.create && prov.create.idempotencyKey) === false);
      if (method === 'POST') {
        if (wantIdem && !headers['Idempotency-Key'] && !headers['idempotency-key']) {
          headers['Idempotency-Key'] = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : 'k-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        } else if (!wantIdem) {
          delete headers['Idempotency-Key']; delete headers['idempotency-key'];
        }
      }
      /* 创建任务的响应可能很慢（平台要排队 / 校验，实测 VGENV 有超过 60 秒的）：
         给它更长的总超时。否则浏览器先掐断 → 页面以为失败、平台其实已受理 → 用户重试就重复建任务。
         其它请求保持默认（「设置 → 网络与刷新」可调）。代理侧对 create 也放宽到 120 秒（见 proxy.js）。 */
      const timeout = opts.timeout != null ? opts.timeout
        : (method === 'POST' && name === 'create' ? 150000 : undefined);
      const d = await rawFetch(this.url(prov, name, opts.id) + q, {
        method: opts.method || 'GET',
        headers,
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
        timeout,
      });
      /* 任何页面创建任务都归档一份提示词（存进归档文件夹，见 PromptLog）：
         平台不返回 prompt 时（如 VGENV），资产库要靠它把提示词补显示出来。
         归档只在这一处发生（Api.create 也走这里，它不再自己存第二份）。 */
      try {
        // log:false = 页面自己归档（如语音那种没有平台任务号的），别再存一份
        // log.prompt = 界面想归档**原文**时用（导演台提交的是平台语法的描述，归档要原始描述）
        const archPrompt = (opts.log && opts.log.prompt) || (opts.body && opts.body.prompt) || '';
        if (name === 'create' && archPrompt && opts.log !== false && window.PromptLog) {
          const p = this.parseItem(prov, d);
          const id = (p && p.genId) || (d && (d.id || d.task_id || d.job_id));
          /* 注册表用本模块自己的 _reg（不是页面的 REG）：
             以前这里裸写 REG，靠「页面恰好在全局声明了 let REG」才不抛 ReferenceError —
             没有那个绑定的页面（shell、以及任何只用 Api 的脚本）会被外层那个空 catch 静默吞掉，
             表现就是「任务建了、归档里却压根没有这条」。 */
          if (id) PromptLog.save(_reg, { type: (opts.log && opts.log.type) || PromptLog.ctxType(prov),
            prompt: archPrompt, model: (opts.log && opts.log.model) || (opts.body && opts.body.model),
            provider: prov.id, task: id,
            title: opts.log && opts.log.title, meta: opts.log && opts.log.meta });
        }
      } catch (e) {}
      return d;
    },
    /* 创建任务：标准字段 → registry 声明的请求体（nest 决定哪些要嵌进 parameters） */
    createBody(prov, f = {}) {
      const spec = (prov && prov.create) || null;
      if (!spec) throw new Error(((prov && prov.name) || '该平台') + ' 没有声明 create（请在 proxy.js 的 REGISTRY 里补上）');
      const std = { model: f.model, prompt: f.prompt, tier: f.tier, duration: f.duration, res: f.res,
        ar: f.ar, quality: f.quality, count: f.count, format: f.format };
      const body = {};
      Object.entries(spec.body || {}).forEach(([k2, src]) => {
        const v = std[src];
        if (v !== undefined && v !== null && v !== '') body[k2] = v;
      });
      Object.assign(body, spec.constants || {});
      Object.entries(spec.nest || {}).forEach(([parent, pairs]) => {
        const o = {};
        (pairs || []).forEach(pair => {
          // 声明写法：[上游字段名, 标准字段名]；也兼容直接写 [字段名]（同名）
          const up = Array.isArray(pair) ? pair[0] : pair;
          const from = Array.isArray(pair) ? (pair[1] || pair[0]) : pair;
          const v = std[from];
          if (v !== undefined && v !== null && v !== '') o[up] = v;
        });
        if (Object.keys(o).length) body[parent] = { ...(body[parent] || {}), ...o };
      });
      /* 泛型参数：页面把「上游字段名 → 值」原样交过来（如能力接口声明的 generate_audio）。
         放进 registry 声明的那个嵌套对象里（SparkCine 是 parameters），没有嵌套就放顶层。
         这样平台声明了新的参数，页面不用改、registry 也不用加映射。 */
      if (f.params && typeof f.params === 'object') {
        const keys = Object.keys(f.params).filter(k => f.params[k] !== undefined && f.params[k] !== null);
        if (keys.length) {
          const parent = Object.keys(spec.nest || {})[0];
          if (parent) { const o = {}; keys.forEach(k => o[k] = f.params[k]); body[parent] = { ...(body[parent] || {}), ...o }; }
          else keys.forEach(k => body[k] = f.params[k]);
        }
      }
      /* 素材输入：按 registry 的 inputTemplates 拼成平台要的形状。
         entries = [{ role, url? , assetId? }]（url = DataURL/公网地址，assetId = 已上传的资产）。
         没声明模板的平台退回老的 inputs 数组写法。 */
      if (Array.isArray(f.inputEntries) && f.inputEntries.length) {
        const tpls = (spec.inputTemplates) || null;
        const groups = new Map();     // to → { many, tmpl, items:[] }
        const legacy = [];
        f.inputEntries.forEach(en => {
          const t = (tpls && (tpls[en.role] || tpls.__default)) || null;
          if (!t) { if (en.assetId) legacy.push({ role: en.role, asset_id: en.assetId }); return; }
          const fill = v => {
            if (typeof v === 'string') return v.replace(/\$url/g, en.url || '').replace(/\$assetId/g, en.assetId || '').replace(/\$role/g, en.role || '');
            if (Array.isArray(v)) return v.map(fill);
            if (v && typeof v === 'object') { const o = {}; Object.entries(v).forEach(([k2, v2]) => o[k2] = fill(v2)); return o; }
            return v;
          };
          if (!groups.has(t.to)) groups.set(t.to, { many: !!t.many, tmpl: t.tmpl, items: [] });
          groups.get(t.to).items.push(fill(t.tmpl));
        });
        groups.forEach((g, to) => { if (g.items.length) body[to] = g.many ? g.items : g.items[0]; });
        if (legacy.length) body.inputs = (body.inputs || []).concat(legacy);
      }
      if (f.note) body.note = String(f.note).slice(0, 200);          // 页面指定优先（如导演台写镜头名）
      else if (spec.note) body.note = spec.note;
      if (Array.isArray(f.inputs) && f.inputs.length) body.inputs = f.inputs;
      if (f.extra && typeof f.extra === 'object') Object.assign(body, f.extra);   // 平台特有的输入字段（参考图/首尾帧等）
      return body;
    },
    /* 某个 role 的输入模板（registry 的 create.inputTemplates 声明）：
       返回 { to, many, tmpl, needsUpload }；没声明就退回 __default，再没有就返回 null（调用方按老写法处理）。 */
    inputTemplate(prov, role) {
      const t = (prov && prov.create && prov.create.inputTemplates) || null;
      if (!t) return null;
      return t[role] || t.__default || null;
    },

    /* 请求体模板：把 {{字段}} 替换成实际值；值为空则整项省略（如没有风格描述就不发那条 message） */
    renderTemplate(tpl, vars) {
      const sub = s => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
      const walk = v => {
        if (typeof v === 'string') return sub(v);
        if (Array.isArray(v)) {
          return v.map(walk).filter(x => {
            if (x === '') return false;
            if (x && x.__drop) return false;
            if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0) return false;
            return true;
          });
        }
        if (v && typeof v === 'object') {
          const o = {};
          let dropped = false;
          Object.entries(v).forEach(([k, v2]) => {
            const w = walk(v2);
            if (w === '') { dropped = true; return; }                                   // 空占位 → 省略该项
            if (w && typeof w === 'object' && !Array.isArray(w) && !Object.keys(w).length) { dropped = true; return; }
            o[k] = w;
          });
          // 消息类对象（带 content）内容被删空时，整条省略（例如没有风格描述就不发 user 消息）
          if (dropped && Object.prototype.hasOwnProperty.call(v, 'content') && o.content === undefined) return { __drop: true };
          return o;
        }
        return v;
      };
      return walk(tpl);
    },
    async create(prov, fields) {
      const spec = (prov && prov.create) || {};
      const body = spec.template ? this.renderTemplate(spec.template, fields) : this.createBody(prov, fields);
      /* 归档交给 request 那一处统一做（以前这里又存一份：同一条任务落两个归档文件、
         还各自起一次 AI 标题）。这里只负责把「界面上真正输入的文字」传下去：
         语音那种请求体里没有 prompt 字段的，靠 fields.text 也能归档到。 */
      const log = fields.log === false ? false : {
        ...(fields.log && typeof fields.log === 'object' ? fields.log : {}),
        prompt: (fields.log && fields.log.prompt) || fields.prompt || fields.text || body.prompt || '',
      };
      return await this.request(prov, spec.endpoint || 'create', { method: 'POST', body, log });
    },
    /* 提示词补显示：平台不返回 prompt 时，从归档索引里取（见 PromptLog，同步读内存缓存）
       先按「平台|任务号」精确查，再退到只按任务号查 —— 归档里写的平台名可能和列表来源不是一套
       （媒体路由把同一上游的条目归到另一个 provider id），只查前者就会误报「本机没归档」。 */
    promptFor(provId, id) {
      const P = window.PromptLog;
      if (!P || !id) return '';
      return P.cached(provId, id) || P.cachedById(id) || '';
    },
    /* 本地生成产物落盘：同步返回的二进制（语音等）存成本地资产，返回 { id, url, ... } */
    async saveLocalAsset({ name, mime, format, data, meta }) {
      return rawFetch('/local-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mime, format, data, meta: meta || {} }),
      });
    },
    /* 取响应里的点路径（'choices.0.message.audio.data'），数组下标也支持 */
    pickPath(raw, path) {
      return String(path || '').split('.').reduce((v, k) => (v == null ? undefined : v[/^\d+$/.test(k) ? Number(k) : k]), raw);
    },
    async cancel(prov, id) {
      return this.request(prov, 'cancel', { id, method: (prov && prov.cancelMethod) || 'POST' });
    },
    /* 详情：优先 detail 端点，没声明就用 poll */
    async detail(prov, id) {
      const hasDetail = prov && prov.endpoints && prov.endpoints.detail;
      return this.request(prov, hasDetail ? 'detail' : 'poll', { id });
    },
    /* 轮询单条任务：返回 { raw, p }（p = parseItem 结果，可能为 null）。
       优先用 detail/poll 端点；**端点不可用时退回列表端点按任务号找** ——
       VGENV 的 /v2/videos/{id} 实测是 404 空壳错误（只有 statusCode/code/message），
       只认它的后果是「任务永远停在排队中」，而且 404 还会被误判成「任务已被清理」把任务号清掉，
       于是同一个任务在界面上裂成两张：一张假的失败卡 + 列表里真实的已完成卡。
       平台也可以用 registry 的 provider.pollVia:'list' 直接声明走列表。 */
    async pollTask(prov, id) {
      const viaList = String((prov && prov.pollVia) || '') === 'list';
      let firstErr = null;
      if (!viaList) {
        try {
          const raw = await this.detail(prov, id);
          const p = this.parseItem(prov, raw);
          if (p && p.status) return { raw: raw, p: p };
          // 响应里没有状态字段（平台没实现详情接口）→ 落到下面的列表兜底
        } catch (e) { firstErr = e; }
      }
      const spec = (prov && prov.list) || {};
      if (!spec || !prov.endpoints || !prov.endpoints.list) {
        if (firstErr) throw firstErr;                       // 既没有列表声明又请求失败：如实抛出
        return { raw: null, p: null };
      }
      const query = new URLSearchParams();
      query.set(spec.limitParam || 'limit', String(spec.limit || 100));
      let d = await this.request(prov, 'list', { query, noCache: true });
      const items = (spec.dataField ? d[spec.dataField] : d.data) || [];
      const idPath = (spec.map || {}).id || 'id';
      let raw = items.find(x => String(this.pick(x, idPath)) === String(id));
      /* 第一页没找到时按游标继续翻（最多再翻 2 页）：
         「一页到底」的平台翻不动，但列表很长时老任务只在后面几页，
         只查第一页会把它误判成「平台已清理」→ 卡片被结掉、任务号被清掉。 */
      let cursor = this.listCursor(prov, d);
      for (let page = 0; !raw && cursor && page < 2; page++) {
        const q2 = new URLSearchParams();
        q2.set(spec.limitParam || 'limit', String(spec.limit || 100));
        q2.set(spec.cursorParam || 'cursor', String(cursor));
        d = await this.request(prov, 'list', { query: q2, noCache: true });
        const more = (spec.dataField ? d[spec.dataField] : d.data) || [];
        raw = more.find(x => String(this.pick(x, idPath)) === String(id));
        const next = this.listCursor(prov, d);
        if (!next || String(next) === String(cursor)) break;      // 游标没前进 → 到底
        cursor = next;
      }
      return { raw: raw || null, p: raw ? this.parseItem(prov, raw) : null };
    },
    /* 列表下一页游标：registry 声明的 cursorField 优先（显式声明成空串 = 这接口不支持翻页，认了）。
       声明的字段在响应里没有时现认几个常见名字 —— 只翻第一页的话，稍老的任务在第一页找不到，
       会被误判成「平台已清理」而结掉、清掉任务号。 */
    listCursor(prov, d) {
      if (!d || typeof d !== 'object') return null;
      const cf = ((prov && prov.list) || {}).cursorField;
      if (cf === '') return null;
      const keys = ['next_cursor', 'nextCursor', 'next_token', 'nextToken', 'next_page', 'nextPage', 'next'];
      if (cf && !keys.includes(cf)) keys.unshift(cf);
      const at = o => { for (const k of keys) { const v = o && o[k]; if (v != null && v !== '') return String(v); } return null; };
      return at(d) || at(d.pagination) || at(d.meta);
    },
    /* 批量取状态：一次问回多个任务的状态（轮询器一轮里会对每个在跑的任务各调一次）。
       · 有 detail 端点的平台 → 逐条问（语义与 pollTask 完全一致，单条失败不影响同一批里的其它条）；
       · registry 声明了 pollVia:'list' 的平台（VGENV）→ **一次列表请求解出这一批**：
         逐条问的话 N 个任务每轮就是 N 次「100 条的列表」请求（VGENV 列表实测 2.4 秒/次），
         上游被打爆、请求互相排队，状态反而更不准 —— 一条都刷不出来还一直转圈。
       同一轮（LIST_SNAP_TTL 内）的多次调用共用同一份列表快照，所以 N 条任务只打一次列表。
       返回 Map<任务号, { raw, p }>；单条出错写 { error }（页面按 404/查不到分别处置）。 */
    async pollMany(prov, ids) {
      const A = this;
      const want = [...new Set((ids || []).filter(Boolean).map(String))];
      const out = new Map();
      if (!want.length) return out;
      const spec = (prov && prov.list) || {};
      const viaList = String((prov && prov.pollVia) || '') === 'list';
      if (viaList && prov.endpoints && prov.endpoints.list) {
        const idPath = (spec.map || {}).id || 'id';
        const rows = d => (Array.isArray(d) ? d : ((d && (spec.dataField ? d[spec.dataField] : d.data)) || []));
        const snap = (key, build) => {          // 同一轮里的调用共用一次请求
          const now = Date.now(), hit = LIST_SNAP.get(key);
          if (hit && now - hit.at < LIST_SNAP_TTL) return hit.promise;
          const promise = build();
          LIST_SNAP.set(key, { at: now, promise });
          promise.catch(() => LIST_SNAP.delete(key));      // 失败不缓存，下一轮重新打
          return promise;
        };
        const pid = prov.id || prov.relay || 'list';
        const q1 = new URLSearchParams();
        q1.set(spec.limitParam || 'limit', String(spec.limit || 100));
        /* 状态刷新用代理的短缓存（列表端点的 cacheTtl）就够：视频生成以分钟计，
           为「快 2 秒」把上游那份 100 条列表每 4 秒重拉一遍不值当。 */
        const page1 = await snap(pid + '|p1', () => A.request(prov, 'list', { query: q1 }));
        const found = new Map();
        rows(page1).forEach(x => { const id = String(A.pick(x, idPath)); if (want.includes(id)) found.set(id, x); });
        /* 第一页没找全的按游标继续翻（最多再翻 2 页，与 pollTask 同一口径：
           列表很长时老任务只在后面几页）。 */
        const cursor0 = A.listCursor(prov, page1);
        if (cursor0 && want.some(id => !found.has(id))) {
          const pages = await snap(pid + '|more', async () => {
            const acc = [];
            let cursor = cursor0;
            for (let i = 0; i < 2 && cursor; i++) {
              const q = new URLSearchParams();
              q.set(spec.limitParam || 'limit', String(spec.limit || 100));
              q.set(spec.cursorParam || 'cursor', String(cursor));
              const d = await A.request(prov, 'list', { query: q });
              acc.push(d);
              const next = A.listCursor(prov, d);
              if (!next || String(next) === String(cursor)) break;      // 游标没前进 → 到底
              cursor = next;
            }
            return acc;
          });
          pages.forEach(d => rows(d).forEach(x => {
            const id = String(A.pick(x, idPath));
            if (want.includes(id) && !found.has(id)) found.set(id, x);
          }));
        }
        want.forEach(id => { const raw = found.get(id); if (raw) out.set(id, { raw, p: A.parseItem(prov, raw) }); });
        return out;      // 没找到的就不进 Map —— 页面据此判断「列表里查不到这条任务」
      }
      await Promise.all(want.map(async id => {
        try { const r = await A.pollTask(prov, id); out.set(id, { raw: (r && r.raw) || null, p: (r && r.p) || null }); }
        catch (e) { out.set(id, { error: e }); }
      }));
      return out;
    },
    /* 余额：按 balance.style 解析成统一结构 { unit, available, frozen, spent?, note?, ok } */
    balance(prov, raw) {
      const style = (prov && prov.balance && prov.balance.style) || 'micros';
      const entry = Array.isArray(raw) ? raw[0] : ((raw && raw.data ? raw.data[0] : raw) || {});
      if (style === 'wallet-credits') {
        return { unit: '积分', available: entry.available ?? '?', frozen: entry.reserved ?? 0,
          note: entry.status || '', ok: entry.available != null };
      }
      const pick = v => (typeof v === 'object' && v ? (v.amount_micros ?? 0) : (v ?? 0));
      const yuan = v => Number(pick(v)) / 1e6;
      return { unit: '', available: yuan(entry.availableMicros ?? entry.available),
        frozen: yuan(entry.reservedMicros ?? entry.frozen ?? 0),
        spent: entry.spentMicros != null ? yuan(entry.spentMicros) : null,
        ok: entry.availableMicros != null || entry.available != null };
    },
    /* 取对象点路径（'parameters.quality'）—— 列表/轮询解析共用 */
    pick(raw, path) {
      if (!path) return undefined;
      return String(path).split('.').reduce((v, k) => (v == null ? undefined : v[k]), raw);
    },
    /* 把「列表条目 / 轮询响应」按 registry 的 list.map 解析成标准字段
       （轮询响应与列表条目同构，所以共用一份映射；平台差异全部在 REGISTRY 里） */
    parseItem(prov, raw) {
      if (!raw || typeof raw !== 'object') return null;
      const spec = (prov && prov.list) || {};
      const m = spec.map || {};
      const g = k => this.pick(raw, m[k]);
      const outs = g('outputs');
      const firstOut = Array.isArray(outs) ? outs[0] : null;
      const cRaw = g('credits');
      const credits = cRaw == null ? null
        : (typeof cRaw === 'object' ? (cRaw.charged ?? cRaw.held ?? null) : cRaw);
      const pm = g('priceMicros');
      const rawStatus = g('status') || '';
      const declared = (spec.statusMap || {})[rawStatus];
      const mapped = declared || rawStatus;
      const isDone = mapped === 'done';
      const isLive = mapped === 'queued' || mapped === 'running';
      /* 认不出的状态不当终局：平台在产物字段写全之前，常常先回一个空/陌生的状态串
         （SparkCine 的 statusMap 只声明了 succeeded，中间态全落在这类）。
         把它算成 failed 会让卡片显示「生成失败」、轮询提前结掉，而真任务还在跑。
         只有① 平台在 statusMap 里明确把它映射成非 done/queued/running，② 状态串本身就是失败词根，才算失败。 */
      const isFail = !isDone && !isLive && (!!declared || /(fail|error|cancel|abort|reject|expire|invalid)/i.test(rawStatus));
      // 上游没给 prompt 时用本机记录兜底（例如 VGENV 的列表与详情都不返回它），并标注来源
      const rawPrompt = g('prompt') || '';
      const localPrompt = rawPrompt ? '' : (window.Api ? window.Api.promptFor(prov.id, g('id')) : '');
      return {
        prompt: rawPrompt || localPrompt || '',
        promptLocal: !rawPrompt && !!localPrompt,
        raw,
        genId: g('id'),              // 任务号也按 list.map 声明取（创建响应把 id 嵌在别处时，靠 d.id 猜会拿不到）
        status: rawStatus,            // 原样状态（页面展示用）
        done: isDone,            // 通用判定：成功 / 进行中 / 失败（各平台措辞不同，看这三个就够）
        running: !isDone && !isFail,   // 认不出的状态归到「进行中」，由调用方继续等
        failed: isFail,
        progress: (raw.progress ?? 0),
        duration: g('duration') ?? null,
        assetId: firstOut || null,
        url: g('outputUrl') || null,
        expires: g('expires') ?? null,        // 签名地址的过期时间（registry 里声明 expires 才有）
        credits, priceMicros: pm != null ? Number(pm) : null, currency: g('currency') || null,
        error: g('error') || null,
        model: g('model'), tier: g('tier'), res: g('res'), ar: g('ar'),
        quality: g('quality'), count: g('count'), format: g('format'),
        created: g('created'), completed: g('completed'),
      };
    },
    /* 费用文案：按 list.priceStyle 决定「积分」还是「¥」（sparkcine 积分 / vgenv 金额） */
    priceText(prov, p) {
      if (!p) return '';
      const style = (prov && prov.list && prov.list.priceStyle) || 'micros';
      if (style === 'credits') return p.credits == null ? '' : (p.credits + ' 积分');
      return p.priceMicros == null ? '' : ('¥' + (p.priceMicros / 1e6).toFixed(4));
    },
    /* 列表来源：按 relay + list 端点去重（同一上游只拉一次） */
    listSources(filter) {
      const out = [], seen = new Set();
      const kinds = (filter && filter.kinds) || null;      // 只要某几类来源（如语音工作台只要 audio）
      const ids = (filter && filter.ids) || null;
      this.providers().forEach(p => {
        if (!p.list || !p.endpoints || !p.endpoints.list) return;
        if (kinds && !kinds.includes(p.kind)) return;
        if (ids && !ids.includes(p.id)) return;
        const k = p.relay + '|' + p.endpoints.list;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ key: p.id, prov: p, spec: p.list });
      });
      return out;
    },
  };
})();

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
  /* 上游条目 → 标准条目（字段全部来自 list.map 声明） */
  function normalize(prov, spec, raw) {
    const m = spec.map || {};
    const g = k => pickPath(raw, m[k]);
    const media = classifyMedia(prov, spec, raw);
    const gstatus = (spec.statusMap || {})[g('status')] || g('status') || 'running';
    const fmt = media === '视频' ? 'mp4' : String(g('format') || 'png').toLowerCase();
    const credits = (() => {
      const c = g('credits');
      if (c == null) return null;
      return (typeof c === 'object') ? (c.charged ?? c.held ?? null) : c;
    })();
    const priceMicros = g('priceMicros');
    const providerId = (prov.mediaProviders && prov.mediaProviders[media]) || prov.id;
    // 上游没给 prompt 时用本机记录兜底（例如 VGENV 的接口不返回它），并标注来源
    const rawPrompt = g('prompt') || '';
    const localPrompt = rawPrompt ? '' : (window.Api
      ? (Api.promptFor(prov.id, g('id')) || Api.promptFor(providerId, g('id'))) : '');
    const base = {
      type: media, provider: providerId, providerName: prov.displayName || prov.name, format: fmt,
      prompt: rawPrompt || localPrompt || '',
      promptLocal: !rawPrompt && !!localPrompt,
      ts: g('completed') || g('created') || '',
      genId: g('id'), gstatus, model: g('model'), mode: g('mode'),
      credits, creditsRaw: g('credits'),
      priceMicros: priceMicros != null ? Number(priceMicros) : null,
      currency: g('currency') || null,
      created: g('created'), completed: g('completed'),
      quality: g('quality'), ar: g('ar'), count: g('count'),
      duration: (media === '视频' || media === '音乐' || media === '音频') ? (g('duration') ?? null) : null,
      tier: g('tier'), res: g('res'),
    };
    // 声明里多出来的字段（chars / tokens / byteLength 等）原样带到条目上，页面按需使用
    Object.keys(m).forEach(k => { if (!(k in base)) { const v = g(k); if (v !== undefined) base[k] = v; } });
    const outs = g('outputs');         // 产物 id 列表（如 output_asset_ids）
    const outUrl = g('outputUrl');     // 或直接给可播放 URL
    if (spec.selfAsset) base.localAsset = true;    // 本地落盘的产物：界面上可以删除
    if (gstatus === 'done') {
      if (spec.selfAsset) {                          // 声明「条目即资产」：本地生成产物（语音等）
        return [{ ...base, kind: 'asset', id: base.genId, assetId: base.genId, status: 'done',
          src: '/asset/' + base.genId + '?v=2',
          dl: '/asset/' + base.genId + '?dl=1&name=' + encodeURIComponent((base.prompt || 'file').slice(0, 20) + '.' + fmt) }];
      }
      if (Array.isArray(outs) && outs.length) {
        return outs.map(aid => ({ ...base, kind: 'asset', id: aid, assetId: aid, status: 'done',
          src: '/asset/' + aid + '?v=2',
          dl: '/asset/' + aid + '?dl=1&name=' + encodeURIComponent((base.prompt || 'file').slice(0, 20) + '.' + fmt) }));
      }
      // 外链产物（如 VGENV 的签名地址）统一换成 /getv 本地路由：显示、抽帧、量体积都同源
      if (outUrl) return [{ ...base, kind: 'asset', id: base.genId, status: 'done',
        src: mediaSrc(outUrl), rawSrc: outUrl, dl: '/fetch?url=' + encodeURIComponent(outUrl) + '&dl=1' }];
      // 状态已成功但产物字段还没写入（接口竞态）：按「生成中」处理，刷新后自愈
      return [{ ...base, kind: 'task', id: base.genId, status: 'running', failMsg: '' }];
    }
    if (gstatus === 'queued' || gstatus === 'running') {
      return [{ ...base, kind: 'task', id: base.genId, status: gstatus }];
    }
    return [{ ...base, kind: 'task', id: base.genId, status: 'failed', failMsg: g('error') || '' }];
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
      query.set(limitParam, String(spec.limit || 100));
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
          normalize(prov, spec, raw).forEach(entry => { if (!want || want(entry)) st.out.push(entry); });
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

  /* 索引窗口（最近 800 条）之外的任务：按任务号回源补，**不 await** —— 补完就地改写条目再 emit 重绘，
     首屏不为它多等一个请求。数量有限（默认 20 条），查过的会进 PromptLog 的 missed 集合，不会反复问。 */
  function refillPrompts(st, limit = 20) {
    const P = window.PromptLog;
    if (!P) return;
    const want = [];
    for (const e of st.out) {
      if (want.length >= limit) break;
      if (!e.prompt && e.genId && !P.missedFor(e.provider, e.genId)) want.push(e);
    }
    if (!want.length) return;
    Promise.allSettled(want.map(e => P.findByTask(e.provider, e.genId))).then(() => {
      want.forEach(e => {
        const p = P.cached(e.provider, e.genId) || P.cachedById(e.genId);
        if (p) { e.prompt = p; e.promptLocal = true; }
      });
      st.emit();          // 查到没查到都要重绘：没查到的卡片要从「正在归档里找」改成「两边都没有」
    });
  }

  window.AssetLib = {
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
      await Api.registry();
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
        out: Array.isArray(opts.out) ? opts.out : [],
        onBatch: (typeof opts.onBatch === 'function') ? opts.onBatch : null,
        accept: (typeof opts.accept === 'function') ? opts.accept : null,
        emit() {
          if (!this.onBatch) return;
          try { this.onBatch(this.out); } catch (e) { console.warn('[AssetLib] onBatch 回调出错：', e); }
        },
      };
      st.errors = {};
      st.failed = {};                      // 本次有读取失败的来源（more 保持 true：界面可重试）
      st.noCache = !!opts.noCache;
      const srcs = Api.listSources({ kinds: opts.kinds, ids: opts.ids });
      await Promise.allSettled(srcs.map(src => listOne(src, st)));
      if (opts.prompts !== false) refillPrompts(st);
      const hasMore = srcs.some(src => st.more[src.key] !== false);
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
      const res = await this.load({
        pages: maxPages, kinds: opts.kinds, ids: opts.ids, reg: opts.reg,
        accept: opts.accept,            // 逐条过滤：不关心的条目根本不进结果（少占内存）
        prompts: false,                 // 只数条数，不补提示词（别为数个数去翻归档）
        out: [], seen: new Set(),
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
      query.set(spec.limitParam || 'limit', String(spec.limit || 100));
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
    /* 合并两批条目（增量加载的核心）：
       ① 同 key 以新数据为准；
       ② 消掉「任务 → 产物」跃迁造成的重复卡 ——
          列表接口在产物刚写好时会先返回 kind:'task'（生成中），下一批返回 kind:'asset'（已完成）；
          两者 genId 相同、但 key 不同（task 用任务号，asset 用产物号），只按 key 去重会同时留下两张卡；
       ③ 产物级去重：同一个产物 id 只留信息更全的一条（有 src / 状态 / 提示词的优先）。
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
      return [...byAsset.values()];
    },
    /* 取消任务：端点与方法都来自 registry 声明 */
    async cancel(entry) {
      const prov = Api.prov(entry.provider);
      if (!prov) throw new Error('找不到平台：' + entry.provider);
      return Api.cancel(prov, entry.genId || entry.id);
    },
    /* 删除来源侧素材：只对「本地落盘」的资产有效（上游没有资产存储的那种，如语音合成产物）。
       端点由 registry 声明（endpoints.remove），没声明的来源会明确报错而不是静默失败。 */
    async remove(entry) {
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
      return Api.create(prov, {
        model: entry.model || (prov.models && prov.models[0] && prov.models[0].id),
        prompt: entry.prompt, tier: entry.tier, duration: entry.duration, res: entry.res,
        ar: entry.ar, quality: entry.quality, count: entry.count, format: entry.format,
      });
    },
    /* 任务详情：走 Api.pollTask（统一入口，认 registry 的 pollVia:'list'，详情页不可用时退回列表按 id 找）。
       以前这里直打 Api.detail —— VGENV 的详情端点是 404 空壳，资产库的轮询每轮都 reject，
       任务卡停在「生成中」再也不收敛（AGENTS.md：页面/模块只用 Api.pollTask 这类统一入口）。
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

/* ============================================================================
   Capabilities —— 模型能力动态获取（统一入口）
   数据源：provider 在 /registry 里声明了 endpoints.models 的平台
     · SparkCine: GET /api/open/v1/models  → 每个模型的 parameters.allowedValues
       （画质 / 分辨率 / 比例 / 输出格式 / 时长范围 / 张数上限）+ pricing（积分价）
     · VGENV: 无能力接口（404），自动回退到 registry 里声明的 options
   用法：先 fetch('/registry')，再 await Capabilities.load(REG)，之后 REG 里每个
        model.options 已被真实能力覆盖（registry 声明仅作兜底）。
   ========================================================================== */
/* 界面上一行「收什么文件」的短名（能力声明里写的是 MIME，人看的是格式名） */
const MIME_SHORT = {
  'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WebP', 'image/*': '图片',
  'video/mp4': 'MP4', 'video/quicktime': 'MOV', 'video/*': '视频',
  'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/*': '音频',
};
window.Capabilities = {
  /* 把上游 models 结构归一化成前端用的 options */
  norm(m) {
    const P = m.parameters || {};
    const av = k => (P[k] && Array.isArray(P[k].allowedValues)) ? P[k].allowedValues.slice() : undefined;
    const rng = k => (P[k] && P[k].minimum !== undefined) ? [P[k].minimum, P[k].maximum] : undefined;
    const cap = {
      qualities: av('quality'),
      aspect_ratios: av('aspect_ratio'),
      output_formats: av('output_format'),
      resolutions: av('resolution'),
      durations: rng('duration'),
      source: 'api',
    };
    // 一次请求出几张：上游 output_count.maximum（视频一般是 1，图片可能到 4）
    cap.max_outputs = (P.output_count && P.output_count.maximum) || undefined;
    /* 上游还给了每个参数的**默认值**，界面应该用它当初始值 ——
       不然会落到下拉的第一项（例如平台默认 768p/6 秒，界面却选成 480p/4 秒，出片质量对不上）。 */
    const defs = {};
    Object.entries(P).forEach(([k, v]) => { if (v && v.default !== undefined) defs[k] = v.default; });
    if (Object.keys(defs).length) cap.defaults = defs;
    /* 布尔型参数（如 generate_audio）：界面按这份声明动态生成「开 / 关」选项，
       新平台声明了新的布尔参数就能自动出现，不用改页面。 */
    const bools = {};
    Object.entries(P).forEach(([k, v]) => { if (v && v.valueType === 'boolean') bools[k] = { def: v.default === true }; });
    if (Object.keys(bools).length) cap.bools = bools;
    const price = {};
    ((m.pricing && m.pricing.perOutput) || []).forEach(x => { if (x.quality) price[x.quality] = x.credits; });
    if (Object.keys(price).length) cap.price = price;
    if (m.pricing && m.pricing.perSecond && m.pricing.perSecond.length) {
      cap.perSecond = m.pricing.perSecond;
      cap.minimumCredits = m.pricing.minimumCredits;
    }
    // 输入规格：上游 modes.inputs 声明的输入类型与数量上限（参考图 / 参考视频 / 参考音频 / 首尾帧…）
    const modes = m.modes || {};
    // 模式名（text_to_video / voice_design / voice_clone…）：界面按它决定展示哪些输入项
    const modes0 = Object.keys(modes);
    if (modes0.length) cap.modes = modes0;
    const specs = [], seenSpec = new Set();
    Object.entries(modes).forEach(([mode, def]) => {
      (def.inputs || []).forEach(i => {
        if (!i || !i.role) return;
        const key = i.role + '|' + (i.media_type || '');
        if (seenSpec.has(key)) {
          const hit = specs.find(x => x.role + '|' + x.media === key);
          if (hit) { hit.max = Math.max(hit.max, i.max || 1); hit.modes = [...new Set([...hit.modes, mode])]; }
          return;
        }
        seenSpec.add(key);
        specs.push({ role: i.role, media: i.media_type || '', min: i.min || 0, max: i.max || 1, modes: [mode] });
      });
    });
    if (specs.length) cap.inputSpecs = specs;
    let maxRef = 0;
    specs.forEach(sp => { if (sp.role === 'reference_image') maxRef = Math.max(maxRef, sp.max); });
    if (maxRef) cap.max_ref_images = maxRef;
    return cap;
  },
  /* ---- 输入槽位与「互斥」推导（参考图 / 参考视频 / 参考音频 / 首尾帧）----
     依据只有一个：模型的能力声明。
       · 上游 /models 的 modes 是「一次请求的形状」——每个输入 role 属于哪些 mode；
         两个 role 的 mode 集合不相交，说明一次请求只能二选一 → 界面上互斥。
         例：REFERENCE_IMAGE 在 ref 模式、FIRST_FRAME 在首尾帧模式 → 传了参考图就不能再传首尾帧。
       · registry 兜底时 modes 只是能力清单（不代表请求形状），用 __reference 合成 mode 表达
         「参考图 / 参考视频 / 参考音频可共存（Ref2VA），但与首尾帧互斥（FL2VA）」。 */
  REF_ROLES: ['reference_image', 'reference_video', 'reference_audio'],
  ROLE_MODES: {
    reference_image: ['reference_images', 'image_to_video', 'multimodal_reference'],
    reference_video: ['reference_video', 'multimodal_reference'],
    reference_audio: ['reference_audio', 'multimodal_reference'],
    first_frame: ['first_last_frame'],
    last_frame: ['first_last_frame'],
  },
  /* role 的默认分组：**不同组的 role 互斥**（一次请求只能选一组）。
     首尾帧是一组，参考素材（参考图 / 参考视频 / 参考音频）是另一组 ——
     这正是「传了首尾帧就不能再传参考图」这条规则，界面据此把它们互相置灰。 */
  ROLE_GROUP: {
    first_frame: 'frame', last_frame: 'frame',
    reference_image: 'ref', reference_video: 'ref', reference_audio: 'ref',
  },
  groupOf(role, spec) { return (spec && spec.group) || this.ROLE_GROUP[role] || role; },
  /* 该模型接受哪些输入 role、上限多少。
     来源优先级：registry 的 model.inputRoles（我们按官方文档写的，最准，决定提交模板能不能真的发出去）
             > 上游能力接口的 modes.inputs（能补上我们没声明的 role，如 mask）
             > registry 的 modes 推导（老兜底）。 */
  specs(model) {
    const o = (model && model.options) || {};
    const out = new Map();
    const declared = (model && model.inputRoles) || null;
    const api = o.inputSpecs || [];
    /* 平台自己声明了输入 role（/models 的 modes.inputs）→ **以它为准**：
       界面上的参考素材入口就按平台声明显隐（模型声明支持什么，就出现什么）。
       registry 的 inputRoles 只在同一个 role 上补上限与分组 —— 因为提交模板决定了
       「一次能收几个」，比如参考音频平台写着 max 3，但模板是单个对象，就按 1 来。 */
    if (api.length) {
      api.forEach(sp => {
        const d = (declared && declared[sp.role]) || null;
        out.set(sp.role, { role: sp.role, media: sp.media || (d && d.media) || '',
          min: sp.min || 0, max: (d && d.max) || sp.max || 1,
          accept: (d && d.accept) || '', maxBytes: (d && d.maxBytes) || 0,
          group: this.groupOf(sp.role, d || sp), modes: (sp.modes || []).slice(), src: d ? 'both' : 'api' });
      });
      return [...out.values()];
    }
    if (declared) {
      Object.entries(declared).forEach(([role, d]) => {
        if (!d) return;
        out.set(role, { role, media: d.media || '', min: d.min || 0, max: d.max || 1,
          accept: d.accept || '', maxBytes: d.maxBytes || 0,
          group: this.groupOf(role, d), modes: (d.modes || []).slice(), src: 'registry' });
      });
      return [...out.values()];
    }
    const modes = (model && model.modes) || [];
    /* max 为 0（没声明）就不推这个 role：没有声明就当作平台不接受，
       而不是猜一个数 —— 猜出来的上限和平台真实上限对不上，用户传到上限才被上游拒。 */
    const push = (role, max) => {
      if (!max) return;
      const own = (this.ROLE_MODES[role] || []).filter(m => modes.includes(m));
      if (!own.length) return;
      out.set(role, { role, media: '', min: 0, max, group: this.groupOf(role),
        modes: this.REF_ROLES.includes(role) ? own.concat('__reference') : own, src: 'modes' });
    };
    // 参考图上限：只认声明（接口给的 model.maxRefImages > registry options.max_ref_images），没声明就不出现这个槽位
    push('reference_image', model && model.maxRefImages ? model.maxRefImages : (o.max_ref_images || 0));
    push('first_frame', 1);
    push('last_frame', 1);
    push('reference_video', 1);
    push('reference_audio', 1);
    return [...out.values()];
  },
  /* 某个模型某个槽位「收什么」：数量上下限 + 接受的文件类型 + 单文件字节上限。
     界面文案、统一选择器的档位与本地上传 accept、上传前的体积校验都只读这里，
     不要在页面里写死「9 张 / 10MB / mp3-wav」。没声明就是 0 / 空串（界面要显示「平台未声明」而不是猜）。 */
  rule(model, role) {
    const sp = this.specs(model).find(x => x.role === role) || {};
    return { role, max: sp.max || 0, min: sp.min || 0, accept: sp.accept || '', maxBytes: sp.maxBytes || 0, group: sp.group || '' };
  },
  /* 槽位声明 →  AssetPicker 的 types（先看声明的 media / accept；都没写就按 role 本身推） */
  slotTypes(model, role) {
    const sp = this.specs(model).find(x => x.role === role) || {};
    const s = ((sp.media || '') + ' ' + (sp.accept || '')).toLowerCase();
    if (/audio/.test(s)) return ['音频', '音乐'];
    if (/video/.test(s)) return ['视频'];
    if (/image/.test(s)) return ['图片'];
    const byRole = {
      reference_image: ['图片'], reference_video: ['视频'], reference_audio: ['音频', '音乐'],
      /* 首尾帧槽收图片，也收「选一段视频就地取帧」（见 SLOT_DEF.videoFrame）→ 两类都给 */
      first_frame: ['图片', '视频'], last_frame: ['图片', '视频'],
    };
    return byRole[role] || ['图片', '视频', '音频', '音乐'];
  },
  /* 槽位声明 → 一行提示：「MP3 / WAV，≤10MB」；什么都没声明就返回空串（界面不显示假规矩） */
  ruleText(model, role) {
    const r = this.rule(model, role);
    const kinds = (r.accept || '').split(',').map(x => MIME_SHORT[(x || '').trim()] || (x || '').trim()).filter(Boolean);
    return [kinds.length ? kinds.join(' / ') : '', r.maxBytes ? '≤ ' + window.fmtBytes(r.maxBytes) : ''].filter(Boolean).join('，');
  },
  /* 平台级（跨模型）的槽位字节上限：上传前校验用（那时只知道平台、不知道模型）。
     同一 role 在各模型上声明不同就取最严的一条 —— 宁可当场拦下，也不要传上去被平台拒。
     没有声明返回 0 = 不额外限制（仍受 AssetTransfer.MAX_BYTES 那道总闸管）。 */
  providerLimit(REG, providerId, role) {
    const prov = (((REG && REG.providers) || []).find(p => p && (p.id === providerId || (p.keyId || p.id) === providerId)) || {});
    let bytes = 0;
    (prov.models || []).forEach(m => {
      const b = this.rule(m, role).maxBytes;
      if (b && (!bytes || b < bytes)) bytes = b;
    });
    return bytes;
  },
  /* 互斥表（对称）：{ role: [不能与它同时使用的 role…] } —— 不同 group 即互斥 */
  conflictMap(model) {
    const specs = this.specs(model);
    const map = {};
    specs.forEach(a => {
      const ga = a.group || this.groupOf(a.role, a);
      map[a.role] = specs.filter(b => b.role !== a.role && (b.group || this.groupOf(b.role, b)) !== ga).map(b => b.role);
    });
    return map;
  },
  /* 已经同时用上的互斥组合（界面兜底 / 提交前拦截都看它）：
     返回 [[a, b], …]，空数组表示没有冲突。blockedRoles 只给「还没被用上、但已被挡住」的 role，
     判断「当前状态本身是否已经非法」必须用这个（导入 / 历史数据可能带上非法组合）。 */
  illegalPairs(model, usedRoles) {
    const map = this.conflictMap(model);
    const used = [...new Set(usedRoles || [])];
    const pairs = [];
    used.forEach((r, i) => used.slice(i + 1).forEach(r2 => {
      if ((map[r] || []).includes(r2)) pairs.push([r, r2]);
    }));
    return pairs;
  },
  /* 已经用上、但当前模型根本不接受的 role（换模型后会遇到：旧素材还在，新模型没有这个输入） */
  unsupportedRoles(model, usedRoles) {
    const have = new Set(this.specs(model).map(s => s.role));
    return [...new Set(usedRoles || [])].filter(r => !have.has(r));
  },
  /* 按「这次要用到的输入 role」挑模型：需要哪些 role，模型声明里就得都有（空 = 只要文字生成） */
  modelsFor(providers, needRoles) {
    const need = (needRoles || []).filter(Boolean);
    return (providers || []).map(p => ({
      p,
      models: ((p && p.models) || []).filter(m => {
        const have = new Set(this.specs(m).map(s => s.role));
        return need.every(r => have.has(r));
      }),
    })).filter(g => g.models.length);
  },
  /* 界面上该禁用的 role：已用到的 role 与它们互斥、且自己还没被用上 */
  blockedRoles(model, usedRoles) {
    const map = this.conflictMap(model);
    const used = new Set(usedRoles || []);
    const blocked = new Set();
    used.forEach(r => (map[r] || []).forEach(x => { if (!used.has(x)) blocked.add(x); }));
    return blocked;
  },
  /* 提交前的兜底：互斥的输入里只保留一组（界面已阻止新造出这种状态，这里只兜住导入的历史数据）
     优先级：首尾帧 > 参考图 > 参考视频 > 参考音频 */
  submitRoles(model, usedRoles) {
    const map = this.conflictMap(model);
    const PRIORITY = ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'];
    const rank = r => { const i = PRIORITY.indexOf(r); return i < 0 ? PRIORITY.length : i; };
    const keep = new Set(), drop = new Set();
    [...new Set(usedRoles || [])].sort((a, b) => rank(a) - rank(b)).forEach(r => {
      if ([...keep].some(k => (map[k] || []).includes(r))) drop.add(r);
      else keep.add(r);
    });
    return { keep, drop };
  },
  /* ---- 本地能力接口（/capabilities）----
     页面不再直连各平台的能力端点（地址 / 密钥 / 返回格式各不相同），统一问代理这一条路由；
     代理负责找端点、注入密钥、失败时回退到 registry 声明，并附上 source / note 说明来源。
     新增平台只要在 registry 里写 endpoints.models，这里无需改动。 */
  async fetchCaps(prov, opts) {
    if (this.unavailable) return null;                 // 代理版本太旧（没有这条路由）：不再反复试
    const q = '/capabilities?provider=' + encodeURIComponent(prov.id) + ((opts && opts.force) ? '&noCache=1' : '');
    let r;
    try { r = await window.Net.fetch(q, { timeout: 25000, retry: 0 }); }
    catch (e) { console.warn('[Capabilities] 能力接口不可用：', e.message); return null; }
    if (r.status === 404) { this.unavailable = true; console.warn('[Capabilities] 代理没有 /capabilities 路由（重启 proxy.js 即可）'); return null; }
    if (!r.ok) throw new Error('能力接口 HTTP ' + r.status);
    return await r.json();
  },
  /* 把能力合并进 REG 里对应平台的模型声明：接口优先，registry 声明兜底 */
  apply(REG, providerId, capsById) {
    const list = (REG && REG.providers) || [];        // 注册表还没就绪时不要抛错
    const prov = list.find(p => p.id === providerId || (p.keyId || p.id) === providerId);
    if (!prov) return 0;
    let n = 0;
    (prov.models || []).forEach(m => {
      const cap = capsById[m.id];
      const base = Object.assign({}, m.options || {});
      if (!cap) { m.options = base; return; }          // 接口没给这个模型 → 保留声明
      const merged = Object.assign(base, {});
      /* forceOptions：registry 里声明「这一项不许被能力接口覆盖」。
         用在平台声明与实测不符的地方 —— 例如 SparkCine 生图声明了 jpeg/webp，
         实测（产物字节头 / mime_type / 文件名）却永远是 png，那就以实测为准，不给假选项。 */
      const forced = new Set(m.forceOptions || []);
      Object.keys(cap).forEach(k => { if (cap[k] !== undefined && !forced.has(k)) merged[k] = cap[k]; });
      m.options = merged;
      /* 下面几个字段以前无条件被能力接口覆盖：forceOptions 保护不到它们，
         「平台声明与实测不符」时（例如 SparkCine 只出 PNG、价格表要锁死）会出现假信息。 */
      if (cap.price && !forced.has('price')) m.price = Object.assign({}, m.price || {}, cap.price);
      if (cap.perSecond && !forced.has('perSecond')) m.perSecond = cap.perSecond;
      if (cap.max_ref_images && !forced.has('max_ref_images')) m.maxRefImages = cap.max_ref_images;
      n++;
    });
    return n;
  },
  /* 拉某个平台的最新能力并合并；返回代理给的原始答复（含 source / note） */
  async refreshProvider(REG, prov, opts) {
    const d = await this.fetchCaps(prov, opts);
    if (!d) return null;
    const byId = {};
    Object.entries(d.models || {}).forEach(([id, raw]) => { byId[id] = this.norm(raw); });
    const n = this.apply(REG, prov.id, byId);
    this.sources = this.sources || {};
    this.sources[prov.id] = { from: d.source, note: d.note || '', at: Date.now(), cached: !!d.cached, models: n };
    return d;
  },
  /* 这个平台的能力是哪来的（界面用它提示「上游接口」还是「平台声明兜底」） */
  sourceOf(prov) { return ((this.sources || {})[prov && prov.id]) || null; },
  /* 启动时把所有平台的能力拉一遍（保持原签名；失败静默，界面用 registry 兜底） */
  async load(REG, opts) {
    const byId = {};
    this.sources = {};
    const provs = (REG.providers || []).filter(p => (p.models || []).length);
    for (const p of provs) {
      try {
        const d = await this.refreshProvider(REG, p, { force: opts && opts.force });
        if (d && d.models) Object.assign(byId, d.models);
      } catch (e) { console.warn('[Capabilities] ' + p.id + ' 能力读取失败：', e.message); }
    }
    const n = Object.keys(byId).length;
    if (n) console.log('[Capabilities] 已取得 ' + n + ' 个模型的能力：', Object.keys(byId).join(', '));
    else console.warn('[Capabilities] 未取得模型能力（平台可能没有能力接口），使用 registry 兜底声明');
    this.models = byId;
    return byId;
  },
};

/* ============================================================================
   Fav —— 我的收藏（跨页面共用）
     · 收藏资产库文件：{ key:'a:<provider>:<assetId>', kind:'asset', provider, providerName,
                        assetId, type, prompt, src, dl, format, duration, ts }
     · 收藏本地文件：  { key:'l:<fileKey>', kind:'local', fileKey, name, mime, type, size, ts }
       文件本体存在 IndexedDB（fav_db / files），显示时取 blob URL
     · 页面用 Fav.list() 画列表；收藏按钮用 Fav.toggle(...)；变化时派发 'fav-change' 事件
   ========================================================================== */
(function () {
  const KEY = 'fav_items';
  const DB = 'fav_db', STORE = 'files';
  let dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open(DB, 1); } catch (e) { dbP = null; rej(e); return; }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => {
        const d = r.result;
        // 别的标签页要升级版本 / 本连接被强制关闭：放掉缓存，下次重新打开
        d.onversionchange = () => { try { d.close(); } catch {} dbP = null; };
        d.onclose = () => { dbP = null; };
        res(d);
      };
      // 失败（隐私模式 / 存储被禁用）：**不缓存这个失败的 Promise**，否则后续收藏永远写不进去
      r.onerror = () => { dbP = null; rej(r.error); };
      r.onblocked = () => { dbP = null; rej(new Error('IndexedDB 被其他标签页占用，请关掉旧标签页重试')); };
    });
    return dbP;
  }
  function idbPut(k, v) { return db().then(d => new Promise((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); })); }
  function idbGet(k) { return db().then(d => new Promise((res, rej) => { const t = d.transaction(STORE, 'readonly'); const q = t.objectStore(STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })); }
  function idbDel(k) { return db().then(d => new Promise(res => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(k); t.oncomplete = res; t.onerror = res; })).catch(() => {}); }

  /* blob URL 缓存：**有上限 + 可回收 + 按最近使用淘汰（LRU）**
     （以前只增不减，翻收藏列表会一直吃内存；只按插入顺序淘汰时，
       反复打开的同一个收藏项会因为被「续期」而把其它项挤掉 —— 命中时重新插入即可） */
  const urlCache = new Map();                  // fileKey → blobURL
  const URL_CACHE_MAX = 60;
  function cacheUrl(fileKey, url) {
    if (urlCache.has(fileKey)) urlCache.delete(fileKey);
    while (urlCache.size >= URL_CACHE_MAX) {
      const [k, u] = urlCache.entries().next().value;
      try { URL.revokeObjectURL(u); } catch {}
      urlCache.delete(k);
    }
    urlCache.set(fileKey, url);
  }
  /* 命中即续期（LRU）：返回地址的同时把它挪到队尾 */
  function touchUrl(fileKey) {
    const u = urlCache.get(fileKey);
    if (u === undefined) return '';
    urlCache.delete(fileKey);
    urlCache.set(fileKey, u);
    return u;
  }
  function releaseUrl(fileKey) {
    const u = urlCache.get(fileKey);
    if (u) { try { URL.revokeObjectURL(u); } catch {} urlCache.delete(fileKey); }
  }
  // 页面卸载时统一回收
  window.addEventListener('beforeunload', () => { urlCache.forEach(u => { try { URL.revokeObjectURL(u); } catch {} }); urlCache.clear(); });
  /* 收藏项变了：只更新本地缓存，不主动重画（页面自己决定怎么刷新，避免打字时被重绘打断） */
  const list = () => { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  function write(arr, opts) {
    let ok = true;
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (e) {
      ok = false;
      if (window.Toast) window.Toast.err('收藏没能保存：浏览器本地存储已满（先在资产库清理，或减少本地文件收藏）');
      console.warn('[Fav] 写入失败：', e);
    }
    if (opts && opts.silent) return ok;      // 静默写：不广播事件（编辑备注时用，免得页面重画打断输入）
    /* 事件里带上 failed：写不进去时页面重画出来的就是**真实**状态（未收藏），
       不能按「已收藏」渲染然后刷新后消失。 */
    try { window.dispatchEvent(new CustomEvent('fav-change', { detail: { local: true, failed: !ok } })); } catch (e) {}
    return ok;
  }
  const typeOfName = n => (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(n) ? '图片'
    : (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(n) ? '视频'
    : (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(n) ? '音频' : '文件')));

  /* 收藏一条「接口不返回提示词」的资产时，如果这条的提示词还没补上（列表那一轮回源没赶上），
     后台按任务号从本机归档补一次再写回 —— 否则「先收藏、提示词后到」的记录会永远空着，
     收藏页的卡片、搜索和导出 CSV 都跟着缺。只问声明了 noPromptField 的平台，别白跑请求。 */
  function fillFavPrompt(item) {
    const P = window.PromptLog;
    if (!P || !item || item.prompt) return;
    const id = item.genId || item.assetId || '';
    if (!id) return;
    const prov = window.Api && Api.prov ? Api.prov(item.provider) : null;
    if (!prov || !prov.noPromptField) return;
    P.findByTask(item.provider, id).then(p => {
      if (!p) return;
      const arr = list();
      const hit = arr.find(x => x.key === item.key);
      if (!hit || hit.prompt) return;
      hit.prompt = p;
      write(arr, { silent: true });      // 静默写：不广播 fav-change，免得打断正在输入的备注（下次渲染自然带上）
    }).catch(() => {});
  }

  /* 签名外链的过期时刻（毫秒）：/getv?url=<内层带 Expires> 一眼能判新旧，不用发请求。
     读不到过期参数就返回 0（本地 /asset/<id>、平台长期地址都不该反复回源）。 */
  function signedExpiry(u) {
    const s = String(u || '');
    if (!s) return 0;
    try {
      const outer = /^\/getv\?/i.test(s) ? new URL(s, location.href) : null;
      const inner = new URL(outer ? (outer.searchParams.get('url') || '') : s, location.href);
      const e = Number(inner.searchParams.get('Expires') || inner.searchParams.get('expires')
        || inner.searchParams.get('x-oss-expires') || 0);
      if (!e || !isFinite(e)) return 0;
      return e < 1e11 ? e * 1000 : e;
    } catch (err) { return 0; }
  }
  const RESIGNED = new Map();     // 收藏项 key → 本次会话已换回的新鲜地址
  const RESIGNING = new Map();    // 同一个收藏并发只回源一次
  /* 换到的新地址写回收藏记录（合并着写，一批回源只落盘一次）：下次打开就不用再等 */
  let pendingUrls = null, urlWriteTimer = 0;
  function writeUrlBack(key, url) {
    pendingUrls = pendingUrls || new Map();
    pendingUrls.set(key, url);
    clearTimeout(urlWriteTimer);
    urlWriteTimer = setTimeout(() => {
      const todo = pendingUrls; pendingUrls = null;
      if (!todo || !todo.size) return;
      const arr = list();
      let hit = 0;
      arr.forEach(x => { const u = todo.get(x.key); if (u) { x.src = u; x.dl = u; hit++; } });
      if (hit) write(arr, { silent: true });      // 静默：换地址不该把正在渲染的列表打断
    }, 600);
  }

  window.Fav = {
    list,
    has(key) { return list().some(x => x.key === key); },
    assetKey(e) { return 'a:' + (e.provider || '') + ':' + (e.assetId || e.id || ''); },
    /* 把一条资产条目变成收藏项 */
    fromEntry(e) {
      const it = { key: this.assetKey(e), kind: 'asset', provider: e.provider, providerName: e.providerName,
        assetId: e.assetId || e.id, genId: e.genId || '', type: e.type, prompt: e.prompt || '',
        src: mediaSrc(e.src || ''), dl: e.dl || '', rawSrc: e.rawSrc || '',
        format: e.format || '', duration: e.duration || null, ts: Date.now() };
      fillFavPrompt(it);
      return it;
    },
    /* add 返回收藏项（落盘失败返回 null）；remove 返回是否删成功（写不进去 = false） */
    add(item) { return write([item].concat(list().filter(x => x.key !== item.key))) ? item : null; },
    remove(key) {
      const hit = list().find(x => x.key === key);
      if (hit && hit.kind === 'local' && hit.fileKey) { idbDel(hit.fileKey); releaseUrl(hit.fileKey); }
      return write(list().filter(x => x.key !== key));
    },
    /* 返回「这条现在在不在收藏里」。落盘失败时返回**真实状态**：
       以前无条件返回 true/false，页面按「已收藏」渲染，刷新后又消失。 */
    toggle(item) {
      if (this.has(item.key)) { this.remove(item.key); return this.has(item.key); }
      this.add(item);
      return this.has(item.key);
    },
    /* 备注：收藏的用途说明，搜索和文字 AI 都会用 */
    note(key) { const hit = list().find(x => x.key === key); return (hit && hit.note) || ''; },
    /* opts.silent：只落盘不广播 fav-change（页面正在编辑备注时用，避免整列表重画把输入打断） */
    setNote(key, note, opts) {
      const arr = list();
      const hit = arr.find(x => x.key === key);
      if (!hit) return;
      hit.note = String(note || '').trim().slice(0, 300);
      write(arr, opts);
      return hit.note;
    },
    /* 命中备注的搜索（页面搜索框用） */
    search(q) {
      const s2 = String(q || '').trim().toLowerCase();
      if (!s2) return list();
      return list().filter(x => ((x.note || '') + ' ' + (x.prompt || '') + ' ' + (x.name || '') + ' ' + (x.providerName || '') + ' ' + (x.type || '')).toLowerCase().includes(s2));
    },
    /* 给文字 AI 看的清单：名称 / 类型 / 备注（备注是重点，AI 据此判断用途） */
    text(limit) {
      return list().slice(0, limit || 80).map((x, i) => ({
        序号: i + 1, 名称: (x.prompt || x.name || '').slice(0, 80) || '(无名称)', 类型: x.type,
        来源: x.kind === 'local' ? '本地上传' : (x.providerName || '资产库'),
        备注: x.note || '', 收藏ID: x.key,
      }));
    },
    /* 上传本地文件到收藏（本体进 IndexedDB）。失败会让调用方拿到异常，不再静默 */
    async addLocalFile(file) {
      if (!file || !file.size) throw new Error('文件是空的');
      const fileKey = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try {
        await idbPut(fileKey, file);
      } catch (e) {
        throw new Error('存不进浏览器本地库（' + (e && e.message ? e.message : '可能是隐私模式或空间不足') + '）');
      }
      return this.add({ key: 'l:' + fileKey, kind: 'local', fileKey, name: file.name || '未命名文件',
        mime: file.type || '', type: typeOfName(file.name || ''), size: file.size || 0, ts: Date.now() });
    },
    async localUrl(fileKey) {
      const hit = touchUrl(fileKey);
      if (hit) return hit;
      const b = await idbGet(fileKey).catch(() => null);
      if (!b) return '';
      const u = URL.createObjectURL(b);
      cacheUrl(fileKey, u);
      return u;
    },
    /* 显示地址：本地文件取 blob，远程用资产地址 */
    /* 同步版本：本地文件若已经取过 blob 地址就直接给（弹窗列表渲染时用） */
    localUrlSync(fileKey) { return touchUrl(fileKey); },
    async urlOf(item) {
      if (!item) return '';
      if (item.kind === 'local') return await this.localUrl(item.fileKey);
      /* 本次会话刚回源换到的新鲜地址优先（writeUrlBack 落盘前也别再画旧图）。
         只是查内存表，不发包，所以不会拖住首屏。 */
      const cached = item.key && RESIGNED.get(item.key);
      if (cached) return cached;
      // 老收藏里可能存着外链 src：这里统一换成 /getv 本地路由（显示与取字节都同源）
      return mediaSrc(item.src || item.dl || '');
    },
    /* 这条地址是不是「签名已过期」的外链（只看地址里的 Expires，不发请求）。
       页面首屏一律先给旧地址画出来，过期的那份放后台按任务号回源换新再局部重画 ——
       urlOf 里直接 await 回源的话，收藏一多首屏就被几个平台的慢接口拖住。 */
    expired(u) { const exp = signedExpiry(u); return !!exp && exp <= Date.now(); },
    /* 按任务号换一条新鲜的产物地址；不是签名外链 / 没有任务号 / 平台接口失败 → 空串 */
    async refreshUrl(item, cur) {
      if (!item || item.kind === 'local') return '';
      const s = cur || mediaSrc(item.src || item.dl || '');
      if (!/^\/getv\?/i.test(String(s))) return '';
      const id = item.genId || item.assetId;
      /* Api.prov 读的是注册表缓存，收藏页/资产页不一定有人先取过注册表 → 自己取一次（有 60 秒缓存，不重复发包） */
      if (window.Api && Api.registry) await Api.registry().catch(() => {});
      const prov = window.Api && Api.prov ? Api.prov(item.provider) : null;
      if (!prov || !id) return '';
      const ck = String(item.key || id);
      if (RESIGNED.has(ck)) return RESIGNED.get(ck);
      if (RESIGNING.has(ck)) return RESIGNING.get(ck);
      const job = (async () => {
        try {
          /* 只换回同类地址：这条收藏是 /getv?<外链>，说明该平台产物就是外链，
             所以新鲜地址也只认接口给的外链。别拿 assetId 拼 /asset/<id> —— 那条本地路由
             只服务「本工作台落盘的产物」和它自己的资产库，别平台的资产号进去就是 404 破图。
             pollTask 认 registry 的 pollVia:'list'（VGENV 的详情端点是 404 空壳），返回 { raw, p }。 */
          const { p } = await Api.pollTask(prov, id);
          const u = p && p.done && p.url;
          const next = u ? Api.mediaSrc(u) : '';
          return next && next !== s ? next : '';
        } catch (e) { return ''; }
      })();
      RESIGNING.set(ck, job);
      let out = '';
      try { out = await job; } finally { RESIGNING.delete(ck); }
      if (out) {
        if (RESIGNED.size > 400) RESIGNED.delete(RESIGNED.keys().next().value);
        RESIGNED.set(ck, out);
        writeUrlBack(item.key, out);
      }
      return out;
    },
    /* 一批收藏的后台回源：限量 + 限并发。收藏可能有好几百条，全放出去就是同时打几百次
       平台列表接口（一次动辄 6~14 秒），既拖死浏览器也把上游打爆。
       每轮最多换 limit 条、同时只跑 conc 个，剩下的等下一次渲染再换；
       onDone(收藏项, 新地址) 由页面决定怎么局部重画。 */
    async resignSome(recs, onDone, opts) {
      const limit = (opts && opts.limit) || 12;
      const conc = (opts && opts.concurrency) || 3;
      const stale = [];
      for (const r of (recs || [])) {
        if (!r || r.kind === 'local') continue;
        const u = await this.urlOf(r);
        if (this.expired(u)) stale.push({ rec: r, u });
        if (stale.length >= limit) break;
      }
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(conc, stale.length) }, async () => {
        while (i < stale.length) {
          const cur = stale[i++];
          const next = await this.refreshUrl(cur.rec, cur.u);
          if (next) { try { onDone && onDone(cur.rec, next); } catch (e) {} }
        }
      }));
      return stale.length;
    },
    /* 取回文件本体（交给上传/转存流程用）：先判 HTTP 状态，别把 404 页面当素材 */
    async blobOf(item) {
      if (!item) return null;
      let u = await this.urlOf(item);
      /* 这里是真要拿字节的，跟渲染不一样：地址过期就先回源换新的，
         否则请求过去只会收到 403（签名外链放几天必然如此）。 */
      if (u && this.expired(u)) u = (await this.refreshUrl(item, u)) || u;
      if (!u) return null;
      const b = await window.Net.blob(u, { timeout: 120000 });
      return b;
    },
    /* 收藏项 → 选择器里那种"条目"（localFav 标记让调用方知道要转 dataURL/上传） */
    async asEntry(item) {
      const u = await this.urlOf(item);
      return { kind: 'asset', id: item.key, assetId: item.assetId || '', provider: item.provider || 'fav-local',
        providerName: item.kind === 'local' ? '我的收藏（本地）' : (item.providerName || '我的收藏'),
        type: item.type, prompt: item.prompt || item.name || '', src: u, dl: u,
        format: item.format || ((item.name || '').split('.').pop() || ''), duration: item.duration || null,
        localFav: true, favItem: item, localAsset: item.kind === 'local' };
    },
  };
})();

/* ============================================================================
   AiGen —— 「就地生成一张图」的最小实现（导演台的开头画面 / 时间切片用它；选择器不含生成入口）
     · 只走统一层：Api.create（幂等键 / 提示词归档 / 长超时都在里面）+ Api.pollTask
       （Api.pollTask 认 registry 的 pollVia:'list'，页面自己写轮询循环就会踩 VGENV 那个坑）
     · 产物统一包成 AssetLib 同构条目，调用方拿到就能直接当素材用
   ========================================================================== */
window.AiGen = {
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
      ts: new Date().toISOString(), src: o.src || ('/asset/' + o.assetId + '?v=2'),
      dl: o.dl || ('/asset/' + o.assetId + '?dl=1') };
  },
  /* 生成一张图：create → 轮询到 done → 取产物 id */
  async image(o) {
    const prov = o.prov, m = o.model || {};
    const fmts = (m.options && m.options.output_formats) || ['png'];
    const fmt = fmts.includes('png') ? 'png' : fmts[0];
    const gen = await Api.create(prov, {
      model: m.id, prompt: o.prompt, quality: o.quality, ar: o.ar, count: 1, format: fmt,
      log: o.log || { type: '图片生成', meta: { 画质: o.quality || '', 画幅: o.ar || '' } },
    });
    const p0 = Api.parseItem(prov, gen);
    const id = (p0 && p0.genId) || (gen && (gen.id || gen.task_id || gen.job_id));
    if (!id) throw new Error((gen && (gen.message || gen.code)) || '接口没有返回任务号');
    /* 轮询只看得到什么就取什么：产物号 / 外链先出现就立刻收（状态字段常常比产物字段晚一两个心跳）。
       失败以 Api.parseItem 的判定为准 —— 它已经把「认不出的中间态」归到进行中，不会一次就误报失败。 */
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 2500));
      let raw = null;
      try { raw = (await Api.pollTask(prov, id)).raw; } catch (e) { continue; }
      const p = raw ? Api.parseItem(prov, raw) : null;
      const ids = this.outputIds(prov, raw);
      if (ids.length) return this._entry(prov, { assetId: ids[0], genId: id, type: '图片', prompt: o.prompt, format: fmt });
      /* 产物是外链的不是资产 id（VGENV 这类）：一样换成 /getv 本地路由再回给调用方，
         否则拿到的是过期就 403 的签名地址。 */
      if (p && p.url) return this._entry(prov, { id: id, genId: id, type: '图片', prompt: o.prompt, format: fmt,
        src: Api.mediaSrc(p.url), dl: '/fetch?url=' + encodeURIComponent(p.url) + '&dl=1' });
      const why = p && p.error && (p.error.message || p.error);
      if (why) throw new Error(why);
      if (p && p.failed) throw new Error('图片生成失败' + (p.status ? '（' + p.status + '）' : ''));
    }
    throw new Error('生成超时（可能还在排队），稍后可在资产库看到它');
  },
};

/* ============================================================================
   AssetPicker —— 全站唯一的「选择参考素材」弹窗（导演台 / 生图台 / 视频台 / 语音台共用）
     const list = await AssetPicker.open({ types: ['图片'], multiple: true, limit: 9, title: '选择参考图' });
     返回 AssetLib 同构条目数组（含 assetId / src / dl / type / prompt / duration …）。
     三个入口在同一套界面里：资产库 / 我的收藏 / 本地上传。
       · aiSearch:true —— 显示「AI 检索」入口（只在素材堆里挑，不生成）
       · upload:false  —— 关掉「本地上传」；upload:{ accept, multiple } 可覆盖按 types 推出的接受类型
       · note          —— 标题下的一行说明（例如「选视频则取它的最后一帧」）
       · onPick(entry) —— 单选时想拿到条目就走回调而不是等 Promise（弹窗会自己关掉）
     条目上可能带的来源标记：fromLocal（本机文件，src 是 blob 地址，带 file）
     这里不放生成入口：要出图 / 出视频 / 出语音都去对应的工作台，它们才是生成地方。
   ========================================================================== */
window.AssetPicker = {
  open(opts) {
    const o = Object.assign({ types: ['图片', '视频'], multiple: true, limit: 0, title: '从资产库选择', search: '' }, opts || {});
    // 只选音频时不必等图片/视频平台（kinds 交给统一加载器过滤来源）
    if (!o.kinds && o.types.length && o.types.every(t => t === '音乐' || t === '音频')) o.kinds = ['audio'];
    const wantAudio = o.types.some(t => t === '音乐' || t === '音频');
    const wantImage = o.types.includes('图片');
    const wantVideo = o.types.includes('视频');
    const upAccept = (o.upload && o.upload.accept) || [
      wantImage ? 'image/jpeg,image/png,image/webp' : '',
      wantVideo ? 'video/*' : '',
      wantAudio ? 'audio/*' : '',
    ].filter(Boolean).join(',');
    const wantUpload = o.upload !== false && !!upAccept;
    return new Promise(resolve => {
      const picked = new Set();
      let ready = false;
      let favOnly = !!o.favOnly;
      let typeTab = '全部';
      let aiCond = null;                         // AI 检索条件（{keywords, after, order, limit}）

      const $ = id => dlg.querySelector('#' + id);
      // 先把弹窗显示出来（带加载动画），再去取数据，避免"点了没反应"
      const dlg = document.createElement('dialog');
      dlg.id = 'apDlg';
      dlg.innerHTML = `<div class="ap-head"><b>${o.title}</b>
        <input id="apSearch" placeholder="搜索提示词 / 描述要找的素材…" value="${(o.search || '').replace(/"/g, '&quot;')}" disabled>
        ${o.aiSearch ? `<button class="ap-chip" id="apAiBtn" title="按左边搜索框里写的描述，用 AI 在这堆素材里挑（不用另外填表）">${window.icon ? window.icon('sparkles', 12) : ''} AI 检索</button><span id="apAiChip"></span>` : ''}
      </div>
        <div class="ap-chips" id="apChips">
          <button class="ap-chip${o.favOnly ? '' : ' on'}" data-fav="0">资产库</button>
          <button class="ap-chip${o.favOnly ? ' on' : ''}" data-fav="1">${window.icon ? window.icon('star', 12) : ''} 我的收藏</button>
          ${wantUpload ? `<button class="ap-chip" data-act="upload">${window.icon ? window.icon('upload', 12) : ''} 本地上传</button>` : ''}
        </div>
        <div class="ap-chips ap-types" id="apTypes" hidden></div>
        ${o.note ? `<div class="ap-sub">${o.note}</div>` : ''}
        <div class="ap-body">
          <div class="ap-grid" id="apGrid"></div>
          <div class="ap-empty" id="apEmpty" hidden></div>
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
      const search = $('apSearch');
      const typesBox = $('apTypes');

      const close = out => { try { dlg.close(); } catch {} dlg.remove(); resolve(out); };
      $('apCancel').onclick = () => close([]);
      dlg.addEventListener('cancel', e => { e.preventDefault(); close([]); });
      /* 交出去之前把选中的收藏条目换成新鲜地址：渲染时那一批（最多 12 条）已经换过一轮，
         没轮到的仍然带着过期外链 —— 页面拿它去转存/引用是「真要字节」的，旧地址只会收到 403
         （表现是「转存失败 HTTP 403」，而用户看到的是刚刚才选的素材）。 */
      const resignPicked = entries => {
        const recs = (entries || []).filter(e => e && e._favRec && Fav.expired && Fav.expired(e.src));
        if (!recs.length) return Promise.resolve(entries);
        cnt.textContent = '正在更新选中收藏的地址…';
        return Fav.resignSome(recs.map(e => e._favRec), (rec, next) => {
          const e = recs.find(x => x._favRec === rec);
          if (e) { e.src = next; e.dl = next; }
        }, { limit: recs.length }).then(() => entries, () => entries);
      };
      okBtn.onclick = () => resignPicked([...picked]).then(close);
      // 额外动作（例如导演的「接上一镜结尾」）：先关掉选择器，再交给调用方处理
      const extraBtn = $('apExtra');
      if (extraBtn) extraBtn.onclick = () => { close(null); try { o.extraAction && o.extraAction(); } catch {} };
      const finish = entries => {
        resignPicked(entries).then(es => {
          if (o.onPick) { try { es.forEach(e => o.onPick(e)); } catch {} }
          close(es);
        });
      };

      const isAudio = t => t === '音频' || t === '音乐';
      const okType = t => o.types.includes(t) || (isAudio(t) && o.types.some(isAudio));
      /* 类型筛选只在真的要选两类以上时出现（音乐/音频算同一类） */
      const typeTabs = (() => {
        const t = [...new Set(o.types.map(x => isAudio(x) ? '音频' : x))];
        return t.length > 1 ? ['全部'].concat(t) : [];
      })();

      /* ---------- 条目池：资产库 / 我的收藏 / 本次本地上传 ----------
         三个来源合成一个池，按产物号去重，并且**资产库那条优先**：收藏存的是「按下收藏那一刻」的地址，
         外链签名一过期就 403（表现就是「我的收藏的缩略图加载不出来」），而列表每次都是现场取的新鲜地址。
         排序和资产库页一致：按完成时间倒序、图片与视频混排，最新的永远在最上面。 */
      const tsOf = e => AssetLib.tsMs(e.ts) || 0;
      const idOf = e => String((e && (e.assetId || e.genId || e.id)) || '');
      const dKey = e => {
        const i = idOf(e);
        if (i) return 'a:' + (e.provider || '') + ':' + i;
        return e.favItem ? 'f:' + e.favItem.key : (e.src ? 's:' + e.src : 'n:' + (e.name || ''));
      };
      let libPool = [];        // 资产库列表（分批到达）
      let favPool = [];        // 只在收藏里出现的条目（本地文件收藏 + 列表还没翻到的收藏）
      const upPool = [];       // 本次「本地上传」的本地文件
      let base = [];
      const compose = () => {
        const map = new Map();
        libPool.forEach(e => { e._grp = 'lib'; map.set(dKey(e), e); });
        favPool.forEach(e => {
          const k = dKey(e), hit = map.get(k);
          if (hit) { hit.fav = true; hit._favRec = hit._favRec || e._favRec; } else map.set(k, e);
        });
        upPool.forEach(e => { e._grp = 'local'; map.set(dKey(e), e); });
        base = [...map.values()].sort((a, b) => tsOf(b) - tsOf(a));
        const keep = new Set(base);
        [...picked].forEach(e => { if (!keep.has(e)) picked.delete(e); });
      };
      const refresh = () => { compose(); paint(); };

      const inView = e => e._grp === 'local' ? true
        : favOnly ? (e._grp === 'fav' || !!e.fav) : e._grp === 'lib';
      const matchesType = e => !typeTabs.length || typeTab === '全部'
        || e.type === typeTab || (typeTab === '音频' && isAudio(e.type));
      const hay = e => [e.prompt, e.name, e.providerName, (e._favRec && e._favRec.note) || ''].join(' ').toLowerCase();
      const aiMatch = e => {
        const kw = (aiCond.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
        if (kw.length && !kw.some(k => hay(e).includes(k))) return false;
        const after = aiCond.after ? Date.parse(aiCond.after) : null;
        if (after && tsOf(e) && tsOf(e) < after) return false;
        return true;
      };
      const visible = () => {
        /* AI 条件生效时，搜索框里那句原话不再参与过滤：整句几乎不可能是某条提示词的子串，
           再 AND 一层就等于「AI 挑完了又全部筛掉」。框里的字保留着，改一下就会重新按普通关键词筛
           （见 search.oninput），点 ✕ 也能退回普通筛选。 */
        const q = aiCond ? '' : search.value.trim().toLowerCase();
        let out = base.filter(e => inView(e) && matchesType(e) && (!q || hay(e).includes(q)) && (!aiCond || aiMatch(e)));
        if (aiCond) {
          if (aiCond.order === 'asc') out = out.slice().reverse();
          out = out.slice(0, Math.max(1, Math.min(200, Number(aiCond.limit) || 30)));
        }
        return out.slice(0, 200);
      };

      /* 缩略图与卡片复用：每次筛选都 grid.innerHTML 重建的话，视频缩略图就重新取一次元数据
         （观感是"闪一下、又要等一会儿"）。卡片节点按条目留着，只把新增的插到正确位置，
         已经在位的一个字都不动；缩略图统一走 Wb.thumbs（同一份首帧缓存 + 懒加载 + 并发上限）。 */
      const nodes = new Map();          // entry → 卡片元素
      const escAttr = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const syncSel = () => {
        nodes.forEach((d, e) => d.classList.toggle('sel', picked.has(e)));
        cnt.textContent = picked.size ? ('已选 ' + picked.size + ' 个' + (o.limit ? ' / 最多 ' + o.limit : '')) : '';
        okBtn.disabled = !picked.size;
      };
      const metaOf = e => [e._grp === 'local' ? '本地文件' : e._grp === 'fav' ? '我的收藏' : (e.providerName || ''),
        e.type, e.format ? e.format.toUpperCase() : '', e.duration ? e.duration + 's' : ''].filter(Boolean).join(' · ');
      const build = e => {
        const d = document.createElement('div');
        d.className = 'ap-item';
        const tb = window.Wb && window.Wb.thumbs;
        /* 音频没有画面，给一张能试听的卡片；以前按图片渲染，表现就是「收藏里的音频全是一片灰」。 */
        let media;
        if (isAudio(e.type)) {
          media = `<span class="ap-audio">${window.icon ? window.icon('speaker', 22) : '♪'}</span>`;
        } else if (e.type === '视频') {
          media = `<span class="ap-media">${tb ? tb.mediaHTML(e.src, { key: e._tkey })
            : `<video preload="metadata" muted playsinline></video><span class="tph"></span>`}</span>`;
        } else {
          media = tb ? tb.mediaHTML(e.src, { type: 'image', key: e._tkey, mediaAttrs: 'loading="lazy" onerror="this.style.display=\'none\'"' })
            : `<img src="${escAttr(e.src)}" loading="lazy" onerror="this.style.display='none'">`;
        }
        d.innerHTML = media + `<span class="chk">✓</span>
          <div class="m"><div class="t">${String(e.prompt || e.name || '(无名称)').replace(/</g, '&lt;')}</div>${metaOf(e)}</div>`;
        if (isAudio(e.type)) {
          const b = d.querySelector('.ap-audio');
          let au = null;
          b.onclick = ev => {
            ev.stopPropagation();
            if (!au) { au = new window.Audio(e.src); au.onended = () => { au = null; b.classList.remove('playing'); }; }
            if (au.paused) { au.play().catch(() => { cnt.textContent = '这个音频放不出来（地址可能已过期）'; }); b.classList.add('playing'); }
            else { au.pause(); b.classList.remove('playing'); }
          };
          b.title = '试听';
        }
        d.onclick = () => {
          if (!o.multiple) { picked.clear(); picked.add(e); syncSel(); finish([e]); return; }
          if (picked.has(e)) picked.delete(e);
          else {
            if (o.limit && picked.size >= o.limit) { cnt.textContent = `最多选 ${o.limit} 个`; return; }
            picked.add(e);
          }
          syncSel();                         // 只改选中态，不重建卡片（否则缩略图又闪一次）
        };
        if (tb && !isAudio(e.type)) {
          const host = e.type === '视频' ? d.querySelector('.ap-media') : d;
          const m = host && host.querySelector('video, img');
          if (m) tb.bind(host, m, e.src, null, e._tkey);
        }
        return d;
      };
      const paint = () => {
        const shown = visible();
        const keep = new Set(shown);
        for (const [e, d] of [...nodes]) { if (!keep.has(e)) { d.remove(); nodes.delete(e); } }
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
          empty.textContent = aiCond ? 'AI 没在这堆素材里挑出匹配的'
            : kw ? '没有匹配「' + kw.slice(0, 20) + '」的' + o.types.join(' / ') + '，换个说法试试'
              : (favOnly ? '我的收藏里还没有' : '资产库里还没有') + o.types.join(' / ')
                + (favOnly ? '，去资产库或收藏页加几条' : '，先去生成或上传吧');
        }
        syncSel();
      };
      /* 单卡重画：后台换地址后必须重建那一格。paint() 只复用已在位的节点，
         而图片签名过期时 onerror 会把 display 设成 none —— 只改 e.src 的话那一格永远空白，
         表现就是「我的收藏里的缩略图加载不出来」。 */
      const repaint = e => {
        const old = nodes.get(e);
        if (!old) return;
        const d = build(e);
        nodes.set(e, d);
        old.replaceWith(d);
        syncSel();
      };
      /* 改了搜索框里的字，之前编译出来的 AI 条件就不再对应这句话了：清掉它，回到普通关键词筛选 */
      search.oninput = () => { if (aiCond) { aiCond = null; paintAiChip(); } paint(); };

      const renderTypes = () => {
        if (!typeTabs.length) { typesBox.hidden = true; return; }
        typesBox.hidden = false;
        typesBox.innerHTML = typeTabs.map(t => `<button class="ap-chip${t === typeTab ? ' on' : ''}" data-t="${t}">${t}</button>`).join('');
        typesBox.querySelectorAll('.ap-chip').forEach(b => b.onclick = () => { typeTab = b.dataset.t; renderTypes(); paint(); });
      };
      const setView = on => {
        favOnly = on;
        dlg.querySelectorAll('#apChips .ap-chip[data-fav]').forEach(x => x.classList.toggle('on', (x.dataset.fav === '1') === on));
        paint();
      };
      /* 顶部档位分两类：data-fav 是视图切换，data-act 是动作（本地上传）。
         以前这里把所有 .ap-chip 都当视图切换，多一个动作按钮就会把列表清空。 */
      dlg.querySelectorAll('#apChips .ap-chip').forEach(ch => {
        if (ch.dataset.fav != null) { ch.onclick = () => setView(ch.dataset.fav === '1'); return; }
        if (ch.dataset.act === 'upload') ch.onclick = () => uploadFiles(ch);
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
          files.forEach(f => {
            const t = (/^video\//.test(f.type) || /\.(mp4|mov|webm|m4v)$/i.test(f.name)) ? '视频'
              : (/^audio\//.test(f.type) || /\.(mp3|wav|m4a|ogg|oga|flac|aac)$/i.test(f.name)) ? '音频' : '图片';
            if (!okType(t)) { cnt.textContent = '这里不收 ' + t + '文件'; return; }
            const url = URL.createObjectURL(f);
            added.push({ kind: 'local', localFav: true, localAsset: true, fromLocal: true, file: f, name: f.name,
              type: t, provider: 'local', providerName: '本地文件', prompt: f.name.replace(/\.[^.]+$/, ''),
              src: url, dl: url, ts: f.lastModified || Date.now(), _grp: 'local', duration: null,
              format: (f.name.split('.').pop() || '').toLowerCase(),
              _tkey: 'fav-file:' + (f.lastModified || 0) + ':' + f.name + ':' + f.size });
          });
          if (!added.length) return;
          if (!o.multiple) { finish(added.slice(0, 1)); return; }
          added.forEach(e => upPool.unshift(e));
          chBtn && chBtn.classList.add('on');
          setView(false); refresh();
        };
        inp.click();
      };

      /* ---------- AI 检索：把一句自然语言变成筛选条件（只筛现有条目，不生成） ---------- */
      const paintAiChip = () => {
        const c = $('apAiChip');
        if (!c) return;
        /* AI 检索出来的那句话要写在 chip 上而不是计数条上：paint() 每次重画都会覆盖 #apCnt，
           放那里的话「检索成功」这条信息一闪就没了（看起来像点了没反应）。 */
        c.innerHTML = aiCond
          ? `<span class="ap-aitag" title="${escAttr(aiCond.summary || '')}">${window.icon ? window.icon('sparkles', 11) : ''} AI 检索${aiCond.summary ? ' · ' + escAttr(String(aiCond.summary).slice(0, 18)) : ''}<button id="apAiClear" title="清除 AI 条件">✕</button></span>`
          : '';
        const b = $('apAiClear');
        if (b) b.onclick = () => { aiCond = null; paintAiChip(); paint(); };
      };
      const runAiSearch = async () => {
        if (!window.TextAI) { cnt.textContent = 'AI 检索要配一个文字模型（设置页里填）'; return; }
        /* 检索词就是上面搜索框里的文字：不再另外弹一个「输入需求」的窗口（两个框填同一件事，
           用户要在两处来回切换）。框里没写东西就当场说清楚并把光标送回去。 */
        const q = search.value.trim();
        if (q.length < 2) {
          cnt.textContent = '先在上面搜索框里写要找什么（至少两个字），再点 AI 检索';
          search.focus();
          return;
        }
        cnt.textContent = 'AI 正在理解检索需求…';
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
          if (!j) throw new Error('AI 没有给出可用的检索条件');
          aiCond = j;
          paintAiChip(); paint();
          /* paint() 会重写计数条，所以这句要放在它后面，否则「AI 检索：…」一闪就没了 */
          cnt.textContent = 'AI 检索：' + String(j.summary || q).slice(0, 46);
        } catch (e) {
          cnt.innerHTML = '<span style="color:var(--err,#dc2626)">检索失败：' + escAttr((e && e.message) || String(e))
            + ' —— 改一下搜索框里的说法再试</span>';
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
          await Api.registry();                     // 收藏回源换地址要先有注册表
          const mine = window.Fav ? Fav.list().filter(x => okType(x.type)) : [];
          /* 收藏条目一次并发取地址（本地文件要读 IndexedDB）：
             以前渲染时才同步取 blob，第一次打开弹窗时地址还没就位 → 「我的收藏一片空白」。 */
          favPool = (await Promise.all(mine.map(async x => {
            const e = await Fav.asEntry(x).catch(() => null);
            if (!e) return null;
            e._grp = 'fav'; e.fav = true; e._favRec = x;
            // 稳定缩略图键：本地文件的 blob 地址每次都变，拿它当键等于永远命不中缓存
            e._tkey = x.kind === 'local' && x.fileKey ? 'fav-file:' + x.fileKey
              : ('fav-asset:' + (x.provider || '') + ':' + idOf(x));
            return e;
          }))).filter(Boolean);
          refresh();
          const res = await AssetLib.load({
            ...(opts && opts.pages ? { pages: opts.pages } : { pages: 3 }),
            kinds: o.kinds,
            onBatch: take,
          });
          take((res && res.entries) || []);
          try { search.focus(); } catch {}
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
          if (load.isConnected) load.innerHTML = '<span style="color:var(--err,#dc2626)">资产库加载失败：' + (e && e.message ? e.message : '请检查网络或密钥') + '</span>';
        }
      })();
    });
  },
};

/* ============================================================================
   TextAI —— 文字 AI（OpenAI 兼容）统一入口
     · 供应商：REG 里 kind === 'text' 的那条（默认 DeepSeek，可在设置里换接口地址）
     · 模型：设置页可「获取模型列表」后选择，存 localStorage sk_model_<providerId>
     · 基址：设置页可填自定义 OpenAI 兼容地址，存 sk_base_deepseek
   用法：await TextAI.chat(REG, systemPrompt, userPrompt)  → 返回文本
        await TextAI.chat(REG, sys, user, { images })      → 带图（模型支持识图时按 OpenAI 多模态格式提交）
        await TextAI.models(REG)                          → 返回模型 id 数组（顺带缓存「能否识图」）
        await TextAI.visionAsync(REG)                     → 先取接口能力再判定识图
        await TextAI.polishImages(REG, [{label, src}])    → 润色要附带的图片 + 给界面看的一句说明
   ========================================================================== */
window.TextAI = {
  prov(REG) { return ((REG && REG.providers) || []).find(p => p.kind === 'text') || null; },
  keyId(prov) { return (prov && (prov.keyId || prov.id)) || 'deepseek'; },
  key(prov) { return localStorage.getItem('sk_key_' + this.keyId(prov)) || ''; },
  base() { return localStorage.getItem('sk_base_deepseek') || ''; },
  /* 选中的模型：设置页存下来的优先，其次 registry 里声明的第一个 */
  model(prov) {
    const saved = localStorage.getItem('sk_model_' + this.keyId(prov));
    if (saved) return saved;
    return (prov && prov.models && prov.models[0] && prov.models[0].id) || 'deepseek-chat';
  },
  /* ---- 识图（视觉）能力判定 ----
     优先级（从高到低）：
       ① 设置页手动指定（sk_text_vision = on / off）
       ② **接口返回的字段**：拉 /models 时看模型条目里有没有「image / vision」这类多模态声明
          （input_modalities、architecture.input_modalities、capabilities.vision、supports_vision…）
       ③ 注册表 registry 里该模型声明的 vision: true/false（接入新平台时写死）
       ④ 模型名推测（最后的兜底，只认 vl / vision / omni / gpt-4o 这类明确标记）
     为什么以接口为准：同一家的模型名会变、多家共用一套命名，名字猜错会白带图（浪费 tokens）
     或者该带图却不带（润色质量下降）；平台自己声明的字段才是权威。 */
  VISION_RE: /(^|[-_/.])(vl|vlm|vision|omni)([-_.]|$)|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|glm-4v|qwen[\w.-]*vl|internvl|pixtral|llava|minicpm-v|yi-vision|step-1v|deepseek-vl|kimi[\w.-]*vision|grok-[\w.]*vision/i,
  META_TTL: 12 * 60 * 60 * 1000,      // 模型能力缓存 12 小时（能力很少变，不必每次都拉）
  _meta: null,                        // { [modelId]: { vision, why } }
  visionMode() { return localStorage.getItem('sk_text_vision') || 'auto'; },   // auto | on | off
  /* 从一条模型条目里找「能不能吃图片」的证据。返回 { vision: true|false|null, field }，
     null = 这个接口没给可用信号（交给下一级判定）。 */
  IMAGE_TOKENS: /^(image|images|vision|visual|multimodal|vl)$/i,
  detectVision(m) {
    if (!m || typeof m !== 'object') return { vision: null, field: '' };
    const hasImg = arr => Array.isArray(arr) && arr.some(x => this.IMAGE_TOKENS.test(String(x).trim()));
    /* ① 明确表达「输入模态」的字段（最可靠，别和输出模态混） */
    const named = [
      ['input_modalities', m.input_modalities],
      ['input_modalities', m.architecture && m.architecture.input_modalities],
      ['input_modalities', m.capabilities && m.capabilities.input_modalities],
      ['input_modalities', m.modalities && m.modalities.input],
      ['input_modalities', m.model_spec && m.model_spec.input_modalities],
    ];
    for (const [field, v] of named) if (Array.isArray(v)) return { vision: hasImg(v), field };
    /* ② 布尔开关：vision / supports_vision / capabilities.vision … */
    const bools = [
      ['vision', m.vision], ['vision', m.supports_vision], ['vision', m.supportsVision],
      ['vision', m.vision_enabled], ['vision', m.capabilities && m.capabilities.vision],
      ['vision', m.capabilities && m.capabilities.image], ['vision', m.architecture && m.architecture.vision],
    ];
    for (const [field, v] of bools) if (typeof v === 'boolean') return { vision: v, field };
    /* ③ 泛化的能力/标签数组（features / tags / capabilities 本身是数组） */
    const loose = [['features', m.features], ['tags', m.tags], ['capabilities', m.capabilities]];
    for (const [field, v] of loose) if (hasImg(v)) return { vision: true, field };
    return { vision: null, field: '' };
  },
  metaKey(prov) { return 'sk_model_meta_' + this.keyId(prov); },
  /* 清掉「这个模型能不能吃图片」的 12 小时判定缓存（换供应商 / 换模型后判定看着不变时用）。
     设置页的清理按钮调用；返回清了几条。 */
  clearMeta() {
    this._meta = null;
    let n = 0;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sk_model_meta_')) { localStorage.removeItem(k); n++; }
    }
    return n;
  },
  /* 拉一次 /models 的**原始条目**（不裁剪字段，识图判定要用原始字段） */
  async rawModels(REG) {
    const prov = this.prov(REG);
    if (!prov) throw new Error('注册路由里没有文字 AI 提供商');
    const r = await netFetch(prov.relay + '/models', { headers: this._headers(prov), timeout: 20000 });
    /* 文字 AI 的失败也要过 ERROR_HINT：上游只回一句「Insufficient Balance」时，
       界面得说清是余额/额度不够、去哪儿处理，而不是把英文原样甩在计数条上。
       错误体不一定是 JSON（网关的 HTML 错误页），先兜成空对象，别把真正的状态码错成解析异常。 */
    let d = {}; try { d = (await r.json()) || {}; } catch (e) {}
    if (!r.ok) throw new Error(window.Api.errorMessage(d, r.status));
    return d.data || d.models || (Array.isArray(d) ? d : []);
  },
  /* 载入并缓存「模型 → 能否识图」：优先读缓存，过期或 force 时回源。
     回源失败**不写缓存**（否则一次网络抖动会把判定固化 12 小时），并保留上一次的结果。 */
  async loadModelMeta(REG, opts = {}) {
    const prov = this.prov(REG);
    if (!prov) return this._meta || {};
    const ck = this.metaKey(prov);
    if (!opts.force) {
      try {
        const c = JSON.parse(localStorage.getItem(ck) || 'null');
        if (c && c.ts && Date.now() - c.ts < this.META_TTL && c.byId) { this._meta = c.byId; return c.byId; }
      } catch {}
    }
    try {
      const raw = await this.rawModels(REG);
      const byId = {};
      raw.forEach(m => {
        const id = m && (m.id || m.name);
        if (id) byId[id] = this.detectVision(m);
      });
      this._meta = byId;
      try { localStorage.setItem(ck, JSON.stringify({ ts: Date.now(), byId })); } catch {}
      return byId;
    } catch (e) {
      console.warn('[TextAI] 读模型能力失败（沿用上次判定）：', e.message);
      return this._meta || {};
    }
  },
  vision(REG) {
    const prov = this.prov(REG);
    const model = this.model(prov);
    const mode = this.visionMode();
    if (mode === 'on') return { ok: true, model, why: '设置里已开启识图' };
    if (mode === 'off') return { ok: false, model, why: '设置里已关闭识图' };
    // ② 接口字段（最权威）
    const hit = (this._meta || {})[model];
    if (hit && hit.vision !== null) {
      return { ok: !!hit.vision, model, why: '接口字段 ' + (hit.field || 'capabilities') + (hit.vision ? ' 声明支持图片' : ' 未包含 image') };
    }
    // ③ 注册表声明
    const decl = ((prov && prov.models) || []).find(m => m && m.id === model);
    if (decl && decl.vision !== undefined) return { ok: !!decl.vision, model, why: '注册表声明' };
    // ④ 名字兜底
    return { ok: this.VISION_RE.test(String(model || '')), model, why: '按模型名推测（接口没给能力字段）' };
  },
  /* 异步版：确保拿到接口能力后再判定（润色 / 对话前调用） */
  async visionAsync(REG) {
    if (!this._meta) { try { await this.loadModelMeta(REG); } catch {} }
    return this.vision(REG);
  },
  /* 图片编号说明：让模型知道「图N 是哪张素材」（图片按同一顺序附在后面） */
  imageLegend(images) {
    if (!images || !images.length) return '';
    return '【随附图片（按顺序）】' + images.map((it, i) => `图${i + 1} = ${it.label}`).join('；')
      + '。请结合图片内容润色，并在提示词里按上面的编号指代素材。';
  },
  /* 取字节：File/Blob 直接用，跨域链接经本地代理 /fetch */
  async _blob(src) {
    // 不用 instanceof：跨 iframe / 沙箱来的 File 过不了构造器判断，按能力（arrayBuffer）识别更稳
    if (src && typeof src === 'object' && typeof src.arrayBuffer === 'function') return src;
    const s = String(src || '');
    const u = /^https?:/i.test(s) && s.indexOf(location.origin) !== 0 ? '/fetch?url=' + encodeURIComponent(s) : s;
    const r = await netFetch(u, { timeout: 60000, retry: 1 });
    if (!r.ok) throw new Error('素材读取失败 HTTP ' + r.status);
    return await r.blob();
  },
  /* 缩到最长边 edge 再转 dataURL：识图只做参考，不需要原图分辨率，省流量和 tokens */
  async shrink(src, edge, quality) {
    const blob = await this._blob(src);
    if (/^(video|audio)\//.test(blob.type || '')) return null;
    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) return null;
    const max = edge || 1024;
    const scale = Math.min(1, max / Math.max(bmp.width || 1, bmp.height || 1));
    const w = Math.max(1, Math.round((bmp.width || 1) * scale)), h = Math.max(1, Math.round((bmp.height || 1) * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    try { bmp.close && bmp.close(); } catch {}
    return cv.toDataURL('image/jpeg', quality || 0.85);
  },
  /* 批量压缩（读不出来的素材直接跳过，不影响润色） */
  async prepImages(list, opts) {
    const max = (opts && opts.max) || 6, edge = (opts && opts.edge) || 1024;
    const out = [];
    for (const it of (list || []).slice(0, max)) {
      try { const url = await this.shrink(it.src, edge); if (url) out.push({ label: it.label, url }); } catch {}
    }
    return out;
  },
  /* 润色前统一入口：返回 { images, note }
     note 一句说明，直接贴到润色弹窗的 hint 里（附带了几张图 / 为什么没带图） */
  async polishImages(REG, list, opts) {
    const items = (list || []).filter(x => x && x.src);
    if (!items.length) return { images: [], note: '' };
    const vis = await this.visionAsync(REG);
    if (!vis.ok) return { images: [], note: `当前文字模型（${vis.model}）未启用识图（${vis.why}），本次只按文字润色；可在设置页把「识图能力」设为支持` };
    const max = (opts && opts.max) || 6;
    const images = await this.prepImages(items, opts);
    if (!images.length) return { images: [], note: '素材图没能读出来（可能已过期或不是图片），本次只按文字润色' };
    const more = items.length > images.length ? `（素材共 ${items.length} 张，只带了前 ${images.length} 张）` : '';
    return { images, note: '已附带 ' + images.length + ' 张素材图供文字 AI 识别：' + images.map((x, i) => '图' + (i + 1) + ' = ' + x.label).join('、') + more };
  },
  _headers(prov) {
    const h = { 'Content-Type': 'application/json' };
    const k = this.key(prov);
    if (k) h['Authorization'] = 'Bearer ' + k;
    const b = this.base();
    if (b) h['X-Up-Base'] = b;
    return h;
  },
  /* 拉取该接口的模型列表（OpenAI 兼容 GET /models） */
  /* 拉取该接口的模型列表（OpenAI 兼容 GET /models）
     顺带把「模型 → 能否识图」的接口声明记进缓存（vision 判定优先用它） */
  async models(REG) {
    const prov = this.prov(REG);
    if (!prov) throw new Error('注册路由里没有文字 AI 提供商');
    const raw = await this.rawModels(REG);
    // 同一次请求里顺手更新识图能力缓存，避免为了判定再拉一次 /models
    try {
      const byId = {};
      raw.forEach(m => { const id = m && (m.id || m.name); if (id) byId[id] = this.detectVision(m); });
      if (Object.keys(byId).length) {
        this._meta = byId;
        localStorage.setItem(this.metaKey(prov), JSON.stringify({ ts: Date.now(), byId }));
      }
    } catch (e) { console.warn('[TextAI] 识图能力缓存写入失败：', e.message); }
    return raw.map(m => ({ id: m.id || m.name, name: m.id || m.name, owned: m.owned_by || '' })).filter(m => m.id);
  },
  /* 服务端是否配了该平台的环境密钥（读 /env-status，缓存 60 秒） */
  async envHas(prov) {
    const kid = this.keyId(prov);
    const now = Date.now();
    if (this._envCache && now - this._envCache.ts < 60000) return !!(this._envCache.data[kid] || {}).hasEnv;
    try {
      const d = await netFetch('/env-status', { timeout: 8000 }).then(r => r.json());
      this._envCache = { ts: now, data: d || {} };
      return !!(d[kid] || {}).hasEnv;
    } catch { return false; }
  },
  /* 本地用量记录读取：坏值（非数组 / 解析失败）一律当空处理，
     免得一条脏数据让后续每次调用都在 JSON.parse 处静默失败、用量再也记不上 */
  readUsageLog() {
    try {
      const v = JSON.parse(localStorage.getItem('ai_usage') || '[]');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  },
  /* 能不能跑：本地填了密钥，或服务端有环境密钥（.env / 系统环境变量） */
  async canRun(REG) {
    const prov = this.prov(REG);
    if (!prov) return false;
    if (this.key(prov)) return true;
    return await this.envHas(prov);
  },
  /* 文字 AI 返回的「一段 JSON」→ 对象：模型常把结果包在 ```json 代码块或前后加一句废话，
     三处（统一选择器 / 资产库 / 收藏页）以前各写一份解析，行为还不一样。统一到这里。 */
  parseJson(txt) {
    let s = String(txt == null ? '' : txt).trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  },
  /* 对话：返回纯文本（不强制本地密钥：留空时由代理注入环境变量里的密钥）
     opts.images = [{ label, url(dataURL) }]：模型支持识图时按 OpenAI 多模态格式带上，
     并在正文末尾附「图N = 哪张素材」的编号说明（模型据此在提示词里指代素材）。 */
  async chat(REG, sys, user, opts) {
    const prov = this.prov(REG);
    if (!prov) throw new Error('注册路由里没有文字 AI 提供商');
    const images = ((opts && opts.images) || []).filter(x => x && x.url);
    const useVision = images.length > 0 && (await this.visionAsync(REG)).ok;
    const content = useVision
      ? [{ type: 'text', text: user + '\n\n' + this.imageLegend(images) }]
        .concat(images.map(it => ({ type: 'image_url', image_url: { url: it.url } })))
      : user;
    const r = await netFetch(prov.relay + (prov.endpoints?.chat || '/chat/completions'), {
      method: 'POST',
      headers: this._headers(prov),
      body: JSON.stringify({
        model: this.model(prov),
        messages: [{ role: 'system', content: sys }, { role: 'user', content }],
      }),
      timeout: 120000,     // 长剧本拆解 / 带图润色本来就慢：给足时间，但不要无限等
      retry: 0,            // POST 不重试（没有幂等键，重试可能重复计费）
    });
    /* 同 rawModels：错误体可能不是 JSON，先兜住；翻译统一走 Api.errorMessage（闭包外的 TextAI 不能直接
       调 errorMessage，那是 Api 闭包里的私有函数 —— 以前这么调会抛 ReferenceError）。 */
    let d = {}; try { d = (await r.json()) || {}; } catch (e) {}
    if (!r.ok) throw new Error(window.Api.errorMessage(d, r.status));   // 润色/剧本/检索的失败都要带中文下一步
    const out = ((d.choices || [])[0] || {}).message?.content;
    if (!out || !String(out).trim()) throw new Error('文字 AI 没有返回内容');
    // 记录用量（左栏「用量与余额」据此统计每日曲线与 tokens）
    try {
      const u = d.usage || {};
      const arr = this.readUsageLog();
      arr.push({ ts: Date.now(), prov: this.keyId(prov), model: this.model(prov),
        pt: u.prompt_tokens || u.input_tokens || 0, ct: u.completion_tokens || u.output_tokens || 0 });
      localStorage.setItem('ai_usage', JSON.stringify(arr.slice(-500)));
    } catch {}
    return String(out).trim();
  },
};

/* ============================================================================
   AssetTransfer —— 跨平台素材转存通用通道
   ---------------------------------------------------------------------------
   场景：素材来自 A 平台 / 本地 / 外部链接，但要用作 B 平台的输入
        （参考图、参考视频、参考音频、首尾帧…）。各平台上传流程不同，
        这里统一成三步：取字节 → 上传成目标平台资产 → 返回 asset_id。

     · blobOf(source)      统一取 Blob：
         File/Blob ｜ dataURL ｜ blob: ｜ 同源相对路径（/asset/xx）
         ｜ 外部 https 链接（自动经本地代理 /getfile 取回，绕过跨域）
     · uploadTo(provId, blob, name, opts)
         上传成该平台资产；**平台差异完全由 registry 的 endpoints 声明驱动**：
           endpoints.uploads   —— 取上传意图（POST，返回 {upload:{url}, asset_id}）
           endpoints.complete  —— 标记完成（POST，{id} 会被替换）
         未声明 uploads 的平台 → 明确抛错「暂无素材上传接口」（如 VGENV）
     · toAsset(provId, source, opts)   一步到位（带去重缓存，同一素材不重复上传）
     · crossTransfer(fromInfo, toProv, source, opts)   跨平台转存的显式写法

   以后接入新平台：只要在 proxy.js 的 registry 里给它写上 uploads/complete
   两个端点，本模块即可自动支持，业务代码无需改动。
   ========================================================================== */
(function () {
  const CACHE = new Map();          // `${provId}|${srcKey}` → asset_id
  const MAX_BYTES = 200 * 1024 * 1024;

  /* 取密钥只走 Api.key（它认 registry 声明的 keyId 与别名），不再自己拼 sk_key_xxx */
  const keyOf = prov => window.Api.key(prov);
  const pickProv = (reg, provId) => ((reg && reg.providers) || []).find(p => p.id === provId || (p.keyId || p.id) === provId) || null;

  async function sha256Hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function b64ToBlob(dataUrl, mime) {
    const bin = atob(String(dataUrl).split(',')[1] || '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  }
  function extOf(blob, name) {
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
    const m = (blob.type || '').split('/')[1] || 'bin';
    const map = { quicktime: 'mov', mpeg: 'mp3', 'x-wav': 'wav', jpeg: 'jpg' };
    return 'asset-' + Date.now() + '.' + (map[m] || m);
  }
  /* 读代理的 NDJSON 进度流（见 proxy.js 的 s3putStream）：
     progress 帧回调 onProgress(sent, total, pct)，返回最后一帧（done / error）。
     响应不是 NDJSON（代理还是旧版）时返回 null，调用方按老的「只看 HTTP 状态」处理。 */
  async function readProgressStream(res, onProgress) {
    const ct = String(res.headers.get('content-type') || '');
    if (!ct.includes('ndjson')) return null;
    let last = null;
    const feed = line => {
      const s = String(line || '').trim();
      if (!s) return;
      let f = null;
      try { f = JSON.parse(s); } catch { return; }
      if (f.t === 'progress') { if (onProgress) onProgress(f.sent || 0, f.total || 0, f.pct); }
      else if (f.t === 'done' || f.t === 'error') last = f;
    };
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      feed(buf);
    } else {
      String(await res.text()).split('\n').forEach(feed);
    }
    return last;
  }

  window.AssetTransfer = {
    MAX_BYTES,
    /* 本平台资产 id 的形态（SparkCine 是 UUID）。本地资产 la_* / 别家平台的 id 直接当 asset_id 提交会被上游判为
       「Invalid UUID」→ 顶层只回一句「部分内容需要检查。」，所以提交前先用它把不属于本平台的 id 挡掉，改走上传字节。 */
    isPlatformId(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || '')); },
    /* 统一取 Blob（自动选路：本地 / 同源 / 外部代理） */
    async blobOf(source, onStage) {
      if (!source) throw new Error('素材为空');
      if (typeof source === 'object' && typeof source.arrayBuffer === 'function' && typeof source.size === 'number') return source;   // File / Blob
      const s = String(source);
      if (s.startsWith('data:')) {
        const mime = (/^data:([^;,]+)/.exec(s) || [])[1] || 'application/octet-stream';
        const b = b64ToBlob(s, mime);
        if (!b.size) throw new Error('dataURL 内容为空');
        return b;
      }
      // 外部链接走本地代理取回（浏览器直连会被 CORS 拦）；同源相对路径直接取
      const isExternal = /^https?:\/\//i.test(s);
      const url = isExternal ? '/getfile?url=' + encodeURIComponent(s)
        : (s.startsWith('/asset/') ? s + (s.includes('?') ? '&' : '?') + 'dl=1' : s);
      if (onStage) onStage('fetch', s);
      const r = await netFetch(url, { timeout: 180000, retry: 1 });   // 大视频取回可能较久；GET 可安全重试
      if (!r.ok) throw new Error('取回素材失败 HTTP ' + r.status);
      const b = await r.blob();
      if (!b.size) throw new Error('取回的内容为空（链接可能已过期）');
      return b;
    },

    /* 上传成指定平台的资产，返回 asset_id（按 registry 声明驱动） */
    async uploadTo(provId, blob, name, opts = {}) {
      const reg = opts.reg;
      const prov = pickProv(reg, provId);
      if (!prov) throw new Error('找不到平台：' + provId);
      const ep = prov.endpoints || {};
      const up = ep.uploads || ep.upload_intent;
      if (!up) throw new Error((prov.name || provId) + ' 暂无素材上传接口（可在 registry 里为它声明 endpoints.uploads）');
      if (blob.size > MAX_BYTES) throw new Error('素材超过 ' + window.fmtBytes(MAX_BYTES) + '，无法上传');
      /* 槽位自己的体积上限（registry 的 inputRoles.maxBytes，例如 VGENV 参考音频 ≤ 50MB）：
         以前只在页面文案里写「≤ 50MB」却没人校验，超了要等上游报错才知道。 */
      const slotMax = (opts.role && window.Capabilities && Capabilities.providerLimit)
        ? Capabilities.providerLimit(opts.reg, provId, opts.role) : 0;
      if (slotMax && blob.size > slotMax) throw new Error((opts.role ? '这个槽位' : '平台') + '收不下：上限 ' + window.fmtBytes(slotMax) + '，当前 ' + window.fmtBytes(blob.size));
      const template = Api.inputTemplate(prov, opts.role);
      if (template && template.requiresAudio) {
        if (opts.onStage) opts.onStage('prepare');
        const prepared = await netFetch('/media/prepare-reference-video', {
          method: 'POST', headers: { 'Content-Type': blob.type || opts.contentType || 'application/octet-stream' },
          body: blob, timeout: 180000, retry: 0,
        });
        if (!prepared.ok) {
          const error = await prepared.json().catch(() => null);
          throw new Error((error && error.error && error.error.message) || ('参考视频预处理失败 HTTP ' + prepared.status));
        }
        const added = prepared.headers.get('X-Audio-Added') === '1';
        blob = await prepared.blob();
        if (added) {
          name = (opts.name || name || 'reference').replace(/\.[^.]+$/, '') + '.mp4';
          opts = { ...opts, name, contentType: 'video/mp4' };
        }
        if (opts.onStage) opts.onStage('prepared', added);
        if (blob.size > MAX_BYTES) throw new Error('补全音轨后的视频超过上传大小上限');
      }
      const mime = blob.type || opts.contentType || 'application/octet-stream';
      const filename = opts.name || extOf(blob, name);
      const headers = { 'Content-Type': 'application/json' };
      const k = keyOf(prov);
      if (k) headers['Authorization'] = 'Bearer ' + k;

      /* 上传意图的字段命名由 registry 声明（SparkCine 是 filename/content_type/byte_length，
         VGENV 是 fileName/contentType/sizeBytes）—— 以前这里写死成 SparkCine 的命名，
         发给 VGENV 会因为「未知字段 + 缺必填」被拒。 */
      const UF = (prov && prov.create && prov.create.uploadFields) || {};
      const body = {};
      body[UF.fileName || 'filename'] = filename;
      body[UF.contentType || 'content_type'] = mime;
      body[UF.sizeBytes || 'byte_length'] = blob.size;
      /* sha256 由 registry 决定发不发：SparkCine **必填**（不传直接 VALIDATION_FAILED），
         VGENV **拒绝未知字段**（传了回 400「property sha256 should not exist」）。
         以前这里无条件发 sha256 → VGENV 的每一次上传都 400。 */
      if (UF.sha256 && !opts.skipHash) {
        try { body[UF.sha256] = await sha256Hex(await blob.arrayBuffer()); } catch {}
      }

      if (opts.onStage) opts.onStage('intent', filename);
      const intentRes = await netFetch(prov.relay + up, {
        method: 'POST', headers, body: JSON.stringify(body), timeout: 30000, retry: 0,
      });
      if (!intentRes.ok) throw new Error('取上传地址失败 HTTP ' + intentRes.status + '（' + (prov.displayName || prov.name) + ' 的上传接口）');
      const intent = await intentRes.json();
      if (intent.error) throw new Error(intent.error.message || '上传意图获取失败');
      const assetId = intent.asset_id || intent.assetId || (intent.asset && intent.asset.id);
      if (!assetId || !intent.upload || !intent.upload.url) throw new Error('上传意图返回异常（缺少 asset_id 或 upload.url）');

      if (opts.onStage) opts.onStage('put', filename);
      const putHeaders = intent.upload.headers || {};
      if (opts.onStage) opts.onStage('progress', { sent: 0, total: blob.size, pct: 0 });   // 先报 0%，状态行立刻切成进度显示
      const put = await netFetch('/s3put?url=' + encodeURIComponent(intent.upload.url), {
        method: intent.upload.method || 'PUT', headers: putHeaders, body: blob,
        timeout: 600000,        // 大素材（视频）本机 → 对象存储这一段可能要几分钟
        retry: 0,               // 上传不做自动重试：重试 = 再传一遍整份素材
      });
      /* 代理会把「本机 → 对象存储」那一公里的真实进度按 NDJSON 帧回传（真正慢的一段；
         fetch 的 upload 事件只能看到本机回环那一段，所以进度由代理给）。
         最后一帧带上游状态与响应体：对象存储的报错（签名不符、长度不符…）以前看不到，现在能显示出来。 */
      /* 进度流必须是 NDJSON（当前代理）；不是的话说明代理是旧版，按老的「只看 HTTP 状态」处理。
         但**是 NDJSON 却没收到终帧**（done/error）时，说明流被中途掐断了 ——
         这时 put.ok 是响应头早就给的 200，不能当成功，否则会对一份没传完的素材调 complete，
         平台侧留下一份残缺素材、产出损坏还没有任何报错。 */
      const isNdjson = String(put.headers.get('content-type') || '').includes('ndjson');
      const fin = await readProgressStream(put, (sent, total, pct) => {
        if (opts.onStage) opts.onStage('progress', { sent, total: total || blob.size, pct });
      });
      if (fin) {
        if (fin.t === 'error') throw new Error('素材上传失败：' + fin.message);
        if (!(fin.status >= 200 && fin.status < 300)) {
          throw new Error('素材上传失败 HTTP ' + fin.status + (fin.body ? '（' + String(fin.body).slice(0, 180) + '）' : ''));
        }
      } else if (isNdjson) {
        throw new Error('素材上传中断（进度流没有收到结束帧）：这份素材没有传完，请重试');
      } else if (!put.ok) {
        throw new Error('素材上传失败 HTTP ' + put.status);   // 兼容旧代理（响应不是进度流）
      }

      const completeTpl = ep.complete || (up + '/{id}/complete');
      const cr = await netFetch(prov.relay + completeTpl.replace('{id}', assetId), {
        method: 'POST', headers: k ? { 'Authorization': 'Bearer ' + k } : {}, timeout: 30000, retry: 0,
      });
      if (!cr.ok) throw new Error('素材上传确认失败 HTTP ' + cr.status);
      return assetId;
    },

    /* 一步到位：取 Blob → 上传 → asset_id（同一素材+平台结果缓存，不重复上传） */
    async toAsset(provId, source, opts = {}) {
      const template = Api.inputTemplate(pickProv(opts.reg, provId), opts.role);
      const cacheKey = (await this._keyOf(provId, source)) + (template && template.requiresAudio ? '|audio-required' : '');
      if (!opts.noCache && cacheKey && CACHE.has(cacheKey)) return CACHE.get(cacheKey);
      const blob = await this.blobOf(source, opts.onStage);
      const aid = await this.uploadTo(provId, blob, opts.name, opts);
      if (cacheKey) {
        if (CACHE.size > 100) CACHE.clear();           // 容量保护
        CACHE.set(cacheKey, aid);
      }
      return aid;
    },
    /* 缓存键：优先用内容 md5（同名不同内容不会撞车），取不到再退回「名字+大小」 */
    async _keyOf(provId, source) {
      try {
        if (typeof source === 'string' && !source.startsWith('data:')) return provId + '|url|' + source;
        const blob = await this.blobOf(source);
        const buf = await blob.arrayBuffer();
        const h = await crypto.subtle.digest('SHA-256', buf);
        const hex = [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
        return provId + '|sha|' + hex;
      } catch {
        const name = (source && source.name) || '';
        return provId + '|' + name + '|' + ((source && source.size) || '');
      }
    },

    /* 跨平台转存的显式写法：素材来自 A 平台/外部，需要变成 B 平台资产 */
    async crossTransfer(from, toProv, source, opts = {}) {
      if (opts.onStage) opts.onStage('transfer', (from && from.name) || '外部来源', toProv);
      return await this.toAsset(toProv, source, opts);
    },
  };
})();

/* ============================================================================
   PromptLog —— 提示词归档
   ---------------------------------------------------------------------------
   每次创建任务都把提示词存成归档文件夹里的一份文件（走本地代理的 /prompts 落盘）。
   文件名 = <时间>-<类型>-<标题>.md，正文含标题 / 时间 / 类型 / 平台 / 模型 / 任务号。
   标题由文字 AI 起（一句短标题）；没配文字 AI 或调用失败就取提示词前 10 个字。
   目录在「设置 → 提示词归档」里改（prompt_dir，只存本机：路径换台机器就不一样了，不参与云同步）。

   为什么不用 localStorage：那份记录只在当前浏览器里、看不见也搜不了；
   存成文件夹之后能直接翻、能同步、能喂给别的工具，任务号 → 提示词也能按需查回来。
   ========================================================================== */
(function () {
  const DIR_KEY = 'prompt_dir';
  const cache = new Map();          // '平台|任务号' → 提示词（同步读，供资产库补显示）
  const byTask = new Map();         // 任务号 → 提示词：归档时写的平台名可能和列表来源不一样
                                    //（如媒体路由把 sparkcine 的视频条目归到 sparkcine-video），只按「平台|任务号」查就会 miss
  const remember = (provId, id, prompt) => {
    if (!id) return;
    const p = String(prompt || '');
    cache.set(keyOf(provId, id), p);
    if (!byTask.has(String(id))) byTask.set(String(id), p);
    if (byTask.size > 4000) { const k0 = byTask.keys().next().value; byTask.delete(k0); cache.delete(keyOf(provId, k0)); }
  };
  const titles = new Map();         // 提示词 → 标题（同一次会话里同一个提示词只问一次文字 AI）
  const inflight = new Map();
  let loadedAt = 0, loading = null, warned = false;

  const dir = () => { try { return localStorage.getItem(DIR_KEY) || ''; } catch (e) { return ''; } };
  const setDir = d => { try { d ? localStorage.setItem(DIR_KEY, d) : localStorage.removeItem(DIR_KEY); } catch (e) {} };
  const keyOf = (provId, id) => (provId || '') + '|' + id;

  async function req(path, opts) {
    const o = opts || {};
    const r = (window.Net && window.Net.fetch)
      ? await window.Net.fetch('/prompts' + path, { ...o, retry: o.retry === undefined ? 1 : o.retry })
      : await fetch('/prompts' + path, o);
    const txt = await r.text();
    let d = null;
    try { d = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!r.ok) {
      const err = new Error((d && d.error && d.error.message) || ('HTTP ' + r.status));
      err.status = r.status;
      throw err;
    }
    return d;
  }
  /* 归档失败只提示一次：创作流程不该因为存不了提示词被打断 */
  function warnOnce(e) {
    if (warned || !window.Toast) return;
    warned = true;
    Toast.warn('提示词没能归档到文件夹（' + e.message + '）：可到「设置 → 提示词归档」检查目录', 7000);
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
        const sys = '你是命名助手：把用户给的创作提示词概括成一个简短标题。'
          + '只输出标题本身，不要引号、不要标点、不要任何解释；'
          + '中文提示词给 8–16 个汉字，英文提示词给 3–6 个单词。';
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
  const cached = (provId, id) => (id ? cache.get(keyOf(provId, id)) || '' : '');
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
  } catch (e) {}
  let missedTimer = 0;
  const saveMissed = () => {
    clearTimeout(missedTimer);
    missedTimer = setTimeout(() => {
      try { sessionStorage.setItem(MISSED_KEY, JSON.stringify([...missed].slice(-3000))); } catch (e) {}
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
    if (missed.has(keyOf(provId, id)) || missed.has(keyOf('', id))) return '';
    if (finding.has(k)) return finding.get(k);
    const job = (async () => {
      const enc = encodeURIComponent;
      const get = async q => {
        try { return await req('/find?' + q, { timeout: 15000 }); } catch (e) { return null; }   // 404 = 没有归档，不是错误
      };
      /* 先按平台精确查；查不到再不带 provider 查一次 —— 归档文件头里写的平台名可能和列表来源不是一套
         （媒体路由把同上游的条目归到另一个 provider id），以前只查一次就放弃，
         于是「本机明明归档了，卡片却显示（该平台接口不返回提示词）」。 */
      let d = provId ? await get('id=' + enc(id) + '&provider=' + enc(provId)) : await get('id=' + enc(id));
      // 只有第一次是「按平台精确查」查空了才值得再放宽条件查一次；本来就没平台时第二次是同一个请求，白跑
      if (provId && (!d || !d.prompt)) d = await get('id=' + enc(id));
      finding.delete(k);
      if (d && d.prompt) {
        const p = String(d.prompt);
        setFull(id, p);
        remember(provId, id, p.slice(0, 300));
        missed.delete(keyOf(provId, id)); missed.delete(keyOf('', id));
        saveMissed();
        return p;
      }
      if (missed.size > 4000) { missed.clear(); }
      missed.add(keyOf(provId, id)); missed.add(keyOf('', id));
      saveMissed();
      return '';
    })();
    finding.set(k, job);
    return job;
  }
  /* 这条任务是不是「本机确实没有归档」（回源查过才算，没查过返回 false）：
     界面据此区分「平台不返回提示词，但本机归档里能找到」和「两边都没有」。 */
  const missedFor = (provId, id) => !!id && (missed.has(keyOf(provId, id)) || missed.has(keyOf('', id)));
  /* 归档目录信息（设置页展示） */
  const list = () => req('?dir=' + encodeURIComponent(dir()));
  const open = () => req('/open?dir=' + encodeURIComponent(dir()), { method: 'POST' });
  /* 平台默认类型：页面没指定时按平台种类给一个（图片 / 视频 / 语音 / 文字） */
  const KIND_ZH = { image: '图片生成', video: '视频生成', audio: '语音合成', text: '文字' };
  const ctxType = prov => KIND_ZH[(prov && prov.kind) || ''] || '任务';

  /* 启动后拉一次索引（资产库给不返回提示词的任务补显示要用），之后每 5 分钟对一次；
     代理没在跑就静默失败 —— 归档是锦上添花，不能挡住页面本身。 */
  setTimeout(() => load(false), 2500);
  setInterval(() => load(true), 5 * 60 * 1000);

  /* 「本机没有这条归档」的结论（sessionStorage）：清掉它会重新按任务号回源问一遍。
     刚往归档目录里手工补了文件、或换了归档目录时用它，不用刷新页面。 */
  const clearMissed = () => { const n = missed.size; missed.clear(); saveMissed(); loadedAt = 0; return n; };

  window.PromptLog = { save, load, cached, cachedById, findByTask, missedFor, clearMissed, list, open, dir, setDir, ctxType, fallbackTitle, cleanTitle };
})();

/* ============================================================================
   TextAI 余额（不再折算金额：文字 AI 只记录 tokens 用量，展示见「用量与余额」页）
   ========================================================================== */
/* 各平台余额接口规格（只有声明了 url 的能精确查询） */
window.TextAI.BALANCE = {
  deepseek: { url: '/user/balance', parse: d => {
    const b = (d.balance_infos || [])[0] || {};
    return { ok: true, currency: b.currency || 'CNY', amount: Number(b.total_balance || 0),
      extra: `充值 ${b.topped_up_balance ?? '—'} · 赠送 ${b.granted_balance ?? '—'}`, available: d.is_available !== false };
  } },
  moonshot: { url: '/users/me/balance', parse: d => {
    const b = (d.data || {});
    const amount = Number(b.available_balance ?? 0);
    return { ok: true, currency: 'CNY', amount, extra: `现金 ${b.cash_balance ?? '—'} · 代金券 ${b.voucher_balance ?? '—'}`, available: true };
  } },
  siliconflow: { url: '/user/info', parse: d => {
    const b = (d.data || {});
    const amount = Number(b.totalBalance ?? b.balance ?? 0);
    return { ok: true, currency: 'CNY', amount, extra: b.chargeBalance != null ? `充值余额 ${b.chargeBalance}` : '', available: true };
  } },
};
/* 查询某文字 AI 平台的余额（未声明接口的返回 {ok:false, reason}） */window.TextAI.fetchBalance = async function (REG, prov) {
  const kid = this.keyId(prov);
  const spec = this.BALANCE[kid];
  if (!spec) return { ok: false, unsupported: true, reason: '该平台没有公开的余额查询接口' };
  try {
    const r = await netFetch(prov.relay + spec.url, { headers: this._headers(prov), timeout: 15000 });
    const d = await r.json();
    if (!r.ok) return { ok: false, reason: (d.error && (d.error.message || d.error.code)) || ('HTTP ' + r.status) };
    const out = spec.parse(d);
    return out.ok ? out : { ok: false, reason: '返回格式不符' };
  } catch (e) { return { ok: false, reason: e.message }; }
};

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
window.AssetLib.estimateCost = async function (prov, model, p = {}, opts = {}) {
  const pr = (prov && prov.pricing) || null;
  if (!pr) return { ok: false, reason: '该 API 未声明定价方式' };
  const n = Number(p.count || 1) || 1;
  const cur = pr.currency || '';
  try {
    if (pr.type === 'per_image_table') {
      const unit = model && model.price ? model.price[p.quality] : null;
      if (unit == null) {
        const q = opts.qualityLabel ? (opts.qualityLabel[p.quality] || p.quality) : p.quality;
        return { ok: false, reason: '该模型没有「' + (q || '?') + '」档定价' };
      }
      return { ok: true, text: '约 ' + (unit * n) + ' ' + cur, detail: unit + ' ' + cur + '/张 × ' + n + ' 张' };
    }
    if (pr.type === 'per_second_table') {
      const cache = opts.cache || {};
      const ck = 'mt_' + prov.id;
      if (!cache[ck]) cache[ck] = await Api.request(prov, pr.endpoint || 'models');
      const list = cache[ck].data || cache[ck].models || [];
      const m = list.find(x => x && x.id === (model && model.id));
      const sec = Number(p.duration || 5);
      const ps = ((m && m.pricing && m.pricing.perSecond) || []).find(x => x.resolution === p.res);
      if (ps) {
        const total = Math.round(ps.credits * sec * n * 100) / 100;
        return { ok: true, text: '约 ' + total + ' ' + cur, detail: ps.credits + ' ' + cur + '/秒 × ' + sec + '秒 × ' + n + ' 条' };
      }
      if (m && m.pricing && m.pricing.minimumCredits) return { ok: true, text: '最低 ' + m.pricing.minimumCredits + ' ' + cur };
      return { ok: false, reason: '模型表中没有 ' + (p.res || '?') + ' 的单价' };
    }
    if (pr.type === 'quote') {
      const ep = pr.endpoint || 'price';
      const qk = (prov && prov.id ? prov.id : String(ep)) + '|' + ep;
      if (quoteDead(qk)) return { ok: false, reason: '该平台未开放报价接口' };
      const q = '?duration=' + sec0(p.duration) + '&resolution=' + (p.res || '') + '&tier=' + (p.tier || '') + '&aspect_ratio=' + (p.ar || '');
      const full = Api.url(prov, ep) + q;
      /* 同参数的并发只发一趟：导演台一次重排会给每个分镜估一次价，参数常常一模一样，
         报价接口又是 15 秒超时的那种 —— 七条一样的请求既白等也打上游。 */
      if (QUOTE_INFLIGHT[full]) return await QUOTE_INFLIGHT[full];
      const one = (async () => {
        const r0 = await Net.fetch(full, { headers: Api.headers(prov), timeout: 15000, retry: 0 });
        if (r0.status === 404) { markQuoteDead(qk); return { ok: false, reason: '该平台未开放报价接口' }; }
        if (!r0.ok) return { ok: false, reason: '报价接口 HTTP ' + r0.status };
        const d = await r0.json();
        const micros = (d.price && d.price.amount_micros) ?? d.amount_micros ?? (d.data && d.data.price && d.data.price.amount_micros);
        if (micros) {
          const each = Number(micros) / 1e6;
          return { ok: true, text: '约 ¥' + (each * n).toFixed(2), detail: '¥' + each.toFixed(2) + '/条 × ' + n + ' 条' };
        }
        return { ok: false, reason: d.message || '报价接口未返回价格' };
      })();
      QUOTE_INFLIGHT[full] = one;
      try { return await one; } finally { delete QUOTE_INFLIGHT[full]; }
    }
    if (pr.type === 'per_1k_chars') {
      const unit = model && model.price ? model.price.per1kChars : null;
      if (unit == null) return { ok: false, reason: '平台未提供价格' };
      const chars = Number(p.chars || 0);
      if (!chars) return { ok: false, reason: '还没有文本，无法预估' };
      const total = chars / 1000 * Number(unit);
      return { ok: true, text: '约 ' + (pr.currency || '¥') + total.toFixed(4),
        detail: chars + ' 字 × ' + (pr.currency || '¥') + unit + '/千字' };
    }
    return { ok: false, reason: '未知的定价类型 ' + pr.type };
  } catch (e) { return { ok: false, reason: (e && e.message) || '报价请求失败' }; }
};
function sec0(v) { return Number(v || 5); }
