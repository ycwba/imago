/* Capabilities — 模型能力动态获取（归一化 / 兜底 / 报价 / 输入模式 combos）。
   数据源：provider 在 /registry 里声明了 endpoints.models 的平台
     · SparkCine: GET /api/open/v1/models → 每个模型的 parameters.allowedValues
       （画质 / 分辨率 / 比例 / 输出格式 / 时长范围 / 张数上限）+ pricing（积分价）
     · VGENV: configurations 数组（一档一个完整组合，见 NORM_SHAPES.vgenvConfigurations）
     · 没有能力接口的家（VGENV 之外那几家 / 404）自动回退到 registry 里声明的 options
   用法：先 fetch('/registry')，再 await Capabilities.load(REG)，之后 REG 里每个
        model.options 已被真实能力覆盖（registry 声明仅作兜底）。
   依赖只有 window.Api / Net 与 registry 声明：判据与归一化都在本文件顶层，
   不反向引用 api.js 里的局部名（那是「浏览器能跑、node 一跑就 ReferenceError」的那一类）。 */
/* ---- 「这一次请求的形状」的判据 + 上游 models 响应形状的归一化 ----
   判据与归一化的本体都在这一个文件里；提交体那一路（api.js 的 Api.createBody / 报价体）
   与页面（Capabilities.fieldState / shapeFieldState / shapeState）问的都是同一个出口，
   不在 api.js 里留第二份 —— 那边只按 window 面调用，加载顺序在它之前也不怕。 */

/* 「这一次请求的形状」（Capabilities 的 combo：{mode, intent}）决定某个声明字段成不成立。
   判据只有这一份，界面画不画、默认值取哪一边、提交体发不发、报价体带不带都问它 ——
   声明里写 `when: { intent: 'person_replacement' }`，值拿去和这一次的形状比，
   所以页面与代理都不需要 `if (平台 id)`（AGENTS.md §2）。
   没有形状声明的平台（combos 为空 → 这里收到 null / 空对象）一律「不隐藏、用普通默认值」，
   行为与加这一档之前逐字相同。 */
function whenMatches(when, ctx) {
  if (!when || typeof when !== 'object' || !ctx) return false;
  return Object.entries(when).every(([k, v]) => String(ctx[k] || '') === String(v));
}
/* 「这一次的形状能不能用某个**逐行能力**」不在 {mode, intent} 里，而在上游能力清单的**每一行**里：
   VGENV 的 /v3/models 把 turbo 与 2x 超分写在 (tier × 这一批素材组合) 上（同一 chip 的八种素材组合里，
   凡是带参考视频的那几种 turbo 一律 false；enhanced 档根本没有 2x），
   所以「并起来这个型号有 turbo」不足以下结论 —— 得问**这一次**的那一行。
   归一化把每一行存进 `combo.states[tier][素材组合键]`（见 NORM_SHAPES.vgenvConfigurations），
   这里只认 `caps.<位名>` 这一种写法、读一次：界面画不画、提交发不发、报价带不带全问它。
   caps 为 null（这一家没有逐行声明）或 known:false（这一档上游根本没列过这一组）都算**不提供** ——
   宁可少一个开关，也不要发一个平台可能拒收的字段（这一家「未知字段会被拒绝」是实测过的）。 */
function capsValue(caps, path) {
  if (!caps || !caps.known || !path) return undefined;
  return caps[String(path).replace(/^caps\./, '')];
}
function capsOffers(caps, path) {
  const v = capsValue(caps, path);
  return Array.isArray(v) ? v.length > 0 : v === true;
}
/* 「这一批素材种类」在上游逐行清单里的键：去重、按名字排序，再用一个 role 名里不可能出现的
   分隔符连起来。归一化那一边（NORM_SHAPES 建 `combo.states`）与界面查这一档那一边
   （Capabilities.shapeState）**必须用同一个函数** —— 两边各拼一次就会出现「清单里明明有这一行，
   界面却查不到」，而症状是那个开关凭空不出现。 */
function shapeRolesKey(roles) {
  return [...new Set((roles || []).map(x => String(x || '')).filter(Boolean))].sort().join('\u0002');
}
/* `create.shapeFields`（超分档 / 随机种子 / 换人的动作起点这一类**顶层非布尔**字段）
   「这一项在不在、给哪些值」的判据。与 topBoolState 同一层（模块顶层一份），
   因为**页面画不画**与**提交体发不发**必须问同一个函数：
   只在 Capabilities 上给一个方法、createBody 里再判一遍 intent 字符串，就会出现
   「界面藏着、其实照样发出去了」（这一家未知字段直接被拒）。
   · `only:{when,why}` = 只有这种请求形状才有这个字段（换人的动作起点发到普通生成是 422）
   · `from:'caps.xxx'` = 取值清单来自**这一次的那一行能力**（Capabilities.shapeState），
     那一行没给就整项不画、不发；`none` 是界面自己给的空值选项（空串不进任何请求体）。 */
/* 「这一项为什么没有」有三种，不能只写两句：
   ① 能力清单还没取到（加载期）→ 说「还在读」；
   ② 取到了，但**这一行不在上游那份逐行清单里**（这一档要求的素材还没放齐，或手上这批的组合
      上游根本没列过）→ 说「还看不出来」；
   ③ 这一行确实没有这一项 → 才是「平台没给」。
   把 ② 说成 ③ 就是替平台下结论：用户看到的是一句「这一档不支持」，
   而真要做的事是把素材放齐 —— 与 AGENTS.md「能力声明回来之前不许说你没配」是同一类毛病。
   两处判据（topBoolState / shapeFieldState）共用这一份，别再各写一套按键名取文案的分支。 */
function whyNote(caps, d, missKey, unkKey, noKey) {
  const k = !caps ? missKey : (caps.known === false ? unkKey : noKey);
  return String(d[k] || d[noKey] || d[missKey] || '');
}
function shapeFieldState(decl, caps, ctx) {
  const d = decl && typeof decl === 'object' ? decl : {};
  if (d.only && !whenMatches(d.only.when, ctx)) return { shown: false, why: String(d.only.why || '') };
  if (d.from) {
    const v = capsValue(caps, d.from);
    const values = Array.isArray(v) ? v.slice() : (v === undefined || v === null || v === false ? [] : [v]);
    if (!values.length) return { shown: false, why: whyNote(caps, d, 'missingNote', 'unknownNote', 'emptyNote') };
    return { shown: true, values, min: d.min, max: d.max, none: d.none || null };
  }
  return { shown: true, values: [], min: d.min, max: d.max, none: d.none || null };
}
function topBoolState(decl, ctx) {
  const d = decl && typeof decl === 'object' ? decl : {};
  const caps = (ctx && ctx.caps) || null;
  /* `need: 'caps.xxx'` —— 这一项**存在**还要看这一档给不给（给不给是逐行能力，不是请求形状）。
     说不给的原因有三句（加载期 / 这一行还没认出来 / 这一行确实没有），见 whyNote。 */
  const needMiss = !!(d.need && !capsOffers(caps, d.need));
  const hidden = needMiss || !!(d.hide && whenMatches(d.hide.when, ctx));
  let def;
  if (d.def && typeof d.def === 'object') def = whenMatches(d.def.when, ctx) ? d.def.then !== false : d.def.else === true;
  else def = d.def !== false && !!d.def;
  let note = '';
  if (hidden) note = needMiss ? whyNote(caps, d, 'needMissingNote', 'needUnknownNote', 'needNote')
    : String(d.hideNote || '');
  return { hidden, def, note, needMiss };
}

/* 界面上一行「收什么文件」的短名（能力声明里写的是 MIME，人看的是格式名） */
const MIME_SHORT = {
  'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WebP', 'image/*': '图片',
  'video/mp4': 'MP4', 'video/quicktime': 'MOV', 'video/*': '视频',
  'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/*': '音频',
};
/* 上游 models 响应**不是**「parameters 对象」那种形状时的归一化，一处一种。
   注册表用 `modelsShape: '<键>'` 点名，按形状而不是按平台 id 分派（换一家同形状的厂商不用改代码）。 */
const NORM_SHAPES = {
  /* VGENV /v3/models：{ id, object, configurations:[ { tier, mode, creation_intent,
     duration:{min,max,default}, resolutions:[], default_resolution, aspect_ratios:[], default_aspect_ratio,
     upscale, inputs:{role:{min,max}}, turbo } ] }
     每一项 configuration 就是「一档完整组合」，所以把各档**并起来**才是这个型号的可用范围
     （分辨率/比例取并集、时长取 min..max 的并集、默认值取第一档带 default 的那个）。
     ⚠ 并集只用来回答「这个型号总共能干什么」；「一次请求能同时用哪些素材」是另一件事 ——
     上游把答案写在 `mode` + `creation_intent` 这一对键上（同一次的各档只有 tier/时长不同，
     输入角色完全一致），所以这里**同时**按这一对键归并出 `combos`，界面拿它当「输入模式」。 */
  vgenvConfigurations(m, prov) {
    const cfgs = Array.isArray(m && m.configurations) ? m.configurations : [];
    if (!cfgs.length) return null;
    const uniq = a => [...new Set(a.filter(x => x !== undefined && x !== null && x !== ''))];
    /* 上游的 role 写法与本项目内部名只有这一处不一致：`reference` = 参考图。
       提交模板（create.inputTemplates.reference_image）、互斥分组（ROLE_GROUP）、统一选择器
       全按 `reference_image` 走，所以**在这个形状里翻一次**，往上不出现上游的写法。 */
    const canon = r => (r === 'reference' ? 'reference_image' : String(r));
    /* 上游把「不超分」也写成一个值（`upscale: "none"`），它不是一个档位。
       以前 `if (c.upscale)` 把它一起收进清单，界面上就多出一个「none」选项。 */
    const isUpLevel = v => !!v && String(v) !== 'none';
    /* 这一行**接受**的那几类素材（不收的 role 上游也列出来，写 max:0）。
       键只用「接受哪些 role」，不看数量 —— 实测同一个 (tier, role 集合) 的多行只在 upscale 上不同，
       min / max / duration / resolutions / aspect_ratios 完全一致（2026-10 全 204 行逐行核过）。
       **这个键由这里生成一次**，界面查这一档时也走 shapeRolesKey 同一份，两边不会漂。 */
    const acceptedOf = c => Object.entries(c.inputs || {})
      .filter(([, r]) => Number(r && r.max) > 0).map(([k]) => canon(k)).sort();
    /* 「收什么文件、单个多大」上游 /v3/models 根本不给（它只给数量），所以这两条规矩写在
       注册表的平台级 `roleRules` 里，归一化时并进每一条输入规格 —— 界面不必按平台 id 找补。
       写在平台级而不是型号级：v13 起注册表不再按型号列清单，`models[].inputRoles` 已删。 */
    const rules = (prov && prov.roleRules) || {};
    const buckets = new Map();
    cfgs.forEach(c => {
      const intent = c.creation_intent ? String(c.creation_intent) : '';
      const id = intent ? String(c.mode || '') + '|' + intent : String(c.mode || '');
      let b = buckets.get(id);
      if (!b) { b = { id, mode: String(c.mode || ''), intent, roles: new Map(),
        _t: new Set(), _r: new Set(), _a: new Set(), _u: new Set(),
        _min: null, _max: null, turbo: false, defaults: {}, _rows: new Map() }; buckets.set(id, b); }
      if (c.tier) b._t.add(c.tier);
      (c.resolutions || []).forEach(x => b._r.add(x));
      (c.aspect_ratios || []).forEach(x => b._a.add(x));
      if (isUpLevel(c.upscale)) b._u.add(c.upscale);
      if (c.turbo === true) b.turbo = true;
      /* 逐行能力：键 = tier + 这一行的素材组合。同一键出现两行 = 一行 none 一行 2x，
         所以这里把 upscale **并起来**（2x 有就是有），turbo 同一键下只会是一个值（实测无冲突）。 */
      const tier = String(c.tier || '');
      const rk = shapeRolesKey(acceptedOf(c));
      const rowKey = tier + '\u0001' + rk;
      let row = b._rows.get(rowKey);
      if (!row) { row = { tier, rolesKey: rk, turbo: c.turbo === true, _u: new Set() }; b._rows.set(rowKey, row); }
      if (isUpLevel(c.upscale)) row._u.add(c.upscale);
      const d = c.duration || {};
      if (d.min != null) b._min = b._min === null ? d.min : Math.min(b._min, d.min);
      if (d.max != null) b._max = b._max === null ? d.max : Math.max(b._max, d.max);
      /* 默认值取这一组里**第一条带 default 的**：同组各档只有 tier 不同，默认值是一样的 */
      if (b.defaults.duration === undefined && d.default != null) b.defaults.duration = d.default;
      if (!b.defaults.resolution && c.default_resolution) b.defaults.resolution = c.default_resolution;
      if (!b.defaults.aspect_ratio && c.default_aspect_ratio) b.defaults.aspect_ratio = c.default_aspect_ratio;
      if (!b.defaults.tier && c.tier) b.defaults.tier = c.tier;
      Object.entries(c.inputs || {}).forEach(([role, r]) => {
        const key = canon(role);
        const hit = b.roles.get(key) || { role: key, min: Infinity, max: 0 };
        hit.min = Math.min(hit.min, Number(r && r.min) || 0);
        hit.max = Math.max(hit.max, Number(r && r.max) || 0);
        b.roles.set(key, hit);
      });
    });
    /* 把这一档攒下的逐行归并成一份**纯 JSON**（`{ tier: { 素材组合键: { turbo, upscale } } }`）：
       Set 与 Map 进不了 localStorage / 代理的缓存，界面也拿不到；键只用字符串。 */
    const statesOf = b => {
      const o = {};
      b._rows.forEach(r => {
        const t = o[r.tier] || (o[r.tier] = {});
        t[r.rolesKey] = { turbo: r.turbo, upscale: [...r._u].sort() };
      });
      return o;
    };
    let combos = [...buckets.values()].map(b => ({
      id: b.id, mode: b.mode, intent: b.intent,
      /* max 为 0 的 role 是「这一档根本不接受这种素材」，不是「能收 0 个」——
         上游在每一条 configuration 里把五个 role 全列出来，不收的写 max:0。 */
      roles: [...b.roles.values()].filter(x => x.max > 0).map(x => ({ role: x.role, min: Math.max(0, x.min === Infinity ? 0 : x.min), max: x.max })),
      tiers: [...b._t], resolutions: [...b._r], aspect_ratios: [...b._a], upscale: [...b._u],
      /* 逐行能力：`states[tier][素材组合键] = { turbo, upscale:[…] }`。
         为什么要到「这一 tier × 这一批素材」这么细：实测同一 chip 里凡是带参考视频的那几种组合
         turbo 一律 false，而 enhanced 档根本没有 2x —— 「这个型号总共有 turbo」是真话，
         「这一次能用 turbo」却是另一件事，界面按前者画开关、提交就按后者发，会被平台拒。
         全 204 行里没有 (tier × 素材组合) 的空档，所以查不到键只可能是「素材还没选齐 / 选了清单外的一批」。 */
      states: statesOf(b),
      turbo: b.turbo, durations: (b._min != null && b._max != null && b._max >= b._min) ? [b._min, b._max] : undefined,
      defaults: b.defaults,
    }));
    /* 上游按 (mode, creation_intent) 一档一档列，而**不带意图的那几档不该变成几颗芯片**：
       实测每个型号的 t2va / ref2va / fl2va 三档在 tiers、分辨率、比例、时长区间上完全一致
       （2026-10-12 逐行核过 /v3/models：base 83 行、cinematic 73 行、origin 48 行，
       三档之间只有 defaults.tier 因为「取这一组里第一条带值的」而不同），
       差别只在「这一次送上来的是哪一批素材」—— 而这一族**不把 mode 当请求字段**
       （见 `Api.createBody` 那一段：平台按送上来的素材自己推断，多发一个 mode 就是 400）。
       所以给三颗芯片 = 让用户先替平台回答「我要送哪一批素材」，答错了再被「这一档收不下」拦一次；
       而「纯文字」与「参考素材档一张都没放」发出去的 body 逐字相同 —— 两个按钮做的是同一件事。
       于是把**不带意图的档并成一颗「智能参考」**：槽位全摆出来，互斥那几组按 group 判据当场置灰
       （导演台一直就是这套画法），逐行能力仍按「这一批素材」的那一行查 ——
       并的只是界面形状，`states[tier][素材组合键]` 一行没动、也没多造。
       ⚠ 只把「纯文字」芯片藏掉、默认停在参考素材档是不够的（第一版就这么错过一次）：
       cinematic 的 `ref2va` 里**没有空载那一行**（base / origin 有），什么都不放时 `shapeState`
       查不到键、回 `known:false`，超分档与「平台自动润色」整块消失 —— 空载反而比原来少一批能用的字段。
       带意图的档（视频换人）**不并**：那是另一种请求（素材恰好一条参考视频 + 一张人物图，
       而且平台自己分析素材，提示词优化这一项在这一档根本不存在），必须在界面上单独选。
       上游只列一档、或不带意图的档只有一档 → 不并：并否由接口列出的那几行决定，不替平台编形状。 */
    const refRoleOf = r => /^reference/.test(String((r && r.role) || ''));
    const smartSrc = combos.filter(c => !c.intent);
    if (smartSrc.length > 1) {
      const keep = smartSrc[0];
      /* id 由并进来的那几档的 mode 排序拼出来（与上游行序无关，换机器/换 Key 都是同一个串）：
         界面上选中的那一档要落进 localStorage，旧的那三个 id 不再存在 —— 页面的 `ensureCombo`
         认不到就按「收得下当前素材的那一档」回落，这是有意的迁移，不是留着三个别名。 */
      keep.id = 'smart:' + smartSrc.map(c => c.mode).sort().join('+');
      keep.label = '智能参考';
      /* 这颗芯片与别的不一样：它不是「一种请求形状」，而是「形状由送上来的那批素材决定」，
         所以界面要在说明行把这句话讲出来（两个页面都读这一个字段，别在页面里按名字分支）。 */
      keep.hint = '不放素材就是纯文字，放哪一批就是哪一种请求';
      keep.mode = '';    // 并档后没有唯一 mode；它本来也不是请求字段，只是声明的上下文（`when` 只比 intent）
      const roles = new Map();
      smartSrc.forEach(c => {
        c.roles.forEach(r => {
          const hit = roles.get(r.role) || { role: r.role, min: Infinity, max: 0 };
          hit.min = Math.min(hit.min, r.min); hit.max = Math.max(hit.max, r.max);
          roles.set(r.role, hit);
        });
        ['tiers', 'resolutions', 'aspect_ratios', 'upscale'].forEach(k => {
          (c[k] || []).forEach(v => { if (!keep[k].includes(v)) keep[k].push(v); });
        });
        /* defaults 与桶内那条同一口径：按源档顺序「第一个给了值的算」 */
        Object.entries(c.defaults || {}).forEach(([k, v]) => { if (keep.defaults[k] === undefined) keep.defaults[k] = v; });
        keep.turbo = keep.turbo || !!c.turbo;
        if (c.durations) {
          keep.durations = keep.durations
            ? [Math.min(keep.durations[0], c.durations[0]), Math.max(keep.durations[1], c.durations[1])]
            : c.durations.slice();
        }
        Object.keys(c.states || {}).forEach(t => {
          const rows = (keep.states[t] = keep.states[t] || {});
          Object.entries(c.states[t]).forEach(([k, v]) => {
            const mine = rows[k];
            /* 同一个 (tier × 素材组合) 两档都列过就取并（有 turbo 算有、超分档并起来）——
               与桶内多行归并同一口径，这里并的是「同一种请求的两种写法」。 */
            rows[k] = mine ? { turbo: !!mine.turbo || !!v.turbo,
              upscale: [...new Set((mine.upscale || []).concat(v.upscale || []))].sort() } : v;
          });
        });
      });
      keep.roles = [...roles.values()].map(r => ({
        role: r.role,
        /* 并档后的 min 只能是「**每一个**被并进来的形状都要求它」时才成立：
           上游把不收的 role 写成 max:0，而上面建 combo 时按 `max > 0` 过滤掉了 ——
           于是「只有 fl2va 要求首帧图至少 1 张」会被并成「智能参考这一档要求首帧图」，
           纯文字与只带参考图那两种请求（正是这颗芯片最主要的用法）当场被自己人拦住。
           取 min 也要留着：某个源档写着 min 2、另一个写 min 0，并档后要求就是 0。 */
        min: smartSrc.every(c => c.roles.some(x => x.role === r.role && (x.min || 0) > 0)) ? r.min : 0,
        max: r.max,
      }));
      const gone = new Set(smartSrc.slice(1).map(c => c.id));
      combos = combos.filter(c => !gone.has(c.id));
    }
    /* 排在最前的那一条就是界面上的默认档（页面 `ensureCombo` 的回落取 list[0]）：
       「智能参考」优先，其次只给首尾帧的型号，带意图的（视频换人）排最后 ——
       它要求恰好一条参考视频加一张人物图，素材没备齐时点它只会撞上「这一档收不下」那条拦截。 */
    const rankOf = c => (c.intent ? 3 : (c.roles.some(refRoleOf) ? 0 : (c.roles.length ? 1 : 2)));
    combos.sort((x, y) => rankOf(x) - rankOf(y));
    const cap = {
      tiers: uniq(cfgs.map(c => c.tier)),
      resolutions: uniq(cfgs.map(c => c.resolutions || []).flat()),
      aspect_ratios: uniq(cfgs.map(c => c.aspect_ratios || []).flat()),
      /* 型号总表的 upscale = 各档的**并集**（回答「这个型号总共能不能超分」）；
         「这一次能不能」在 states 里，界面按那一行的读数画选项。`"none"` 不是档位，别收进来。 */
      upscale: uniq(cfgs.map(c => c.upscale).filter(isUpLevel)),
      turbo: cfgs.some(c => c.turbo === true),
      modes: uniq(cfgs.map(c => c.mode)),
      combos,
    };
    /* 时长：上游给的是 {min,max} 区间，我们内部按 [min,max] 存 */
    const mins = cfgs.map(c => c.duration && c.duration.min).filter(v => v != null);
    const maxs = cfgs.map(c => c.duration && c.duration.max).filter(v => v != null);
    if (mins.length && maxs.length) cap.durations = [Math.min(...mins), Math.max(...maxs)];
    const defs = {};
    const c0 = cfgs.find(c => c.duration && c.duration.default != null) || cfgs[0] || {};
    if (c0.duration && c0.duration.default != null) defs.duration = c0.duration.default;
    if (c0.default_resolution) defs.resolution = c0.default_resolution;
    if (c0.default_aspect_ratio) defs.aspect_ratio = c0.default_aspect_ratio;
    if (c0.tier) defs.tier = c0.tier;
    if (Object.keys(defs).length) cap.defaults = defs;
    /* 输入规格：各模式的**并集**（modelsFor / 素材跨页 / providerLimit 这些不知道用户选了哪个模式，
       只能按「这个型号总共收不收这种素材」判）；每一角色记下它属于哪些模式，
       界面上的「输入模式」切换与「这一档不收」的说明都读 combos。 */
    const bag = new Map();
    combos.forEach(cb => cb.roles.forEach(r => {
      const hit = bag.get(r.role) || { role: r.role, min: Infinity, max: 0, modes: [] };
      hit.min = Math.min(hit.min, r.min);
      hit.max = Math.max(hit.max, r.max);
      if (!hit.modes.includes(cb.id)) hit.modes.push(cb.id);
      bag.set(r.role, hit);
    }));
    const spec = [...bag.values()].map(sp => {
      const d = rules[sp.role] || {};
      return { role: sp.role, media: d.media || '', min: Math.max(0, sp.min === Infinity ? 0 : sp.min), max: sp.max,
        accept: d.accept || '', maxBytes: d.maxBytes || 0, modes: sp.modes };
    });
    if (spec.length) cap.inputSpecs = spec;
    let maxRef = 0;
    spec.forEach(sp => { if (sp.role === 'reference_image') maxRef = Math.max(maxRef, sp.max); });
    if (maxRef) cap.max_ref_images = maxRef;
    return cap;
  },
};

window.Capabilities = {
  /* 把上游 models 结构归一化成前端用的 options。
     `shape`：注册表用 `modelsShape` 点名一种**形状**（不是平台 id），
     由下面的 NORM_SHAPES 接住 —— 上游形状不是「parameters 对象」的那种
     （VGENV 的 /v3/models 是 configurations 数组，一项一档组合），
     归一化得按形状走，不能把 `parameters` 当对象硬读（读到空 → 整块能力消失）。 */
  norm(m, shape, prov) {
    const custom = shape && NORM_SHAPES[shape];
    if (custom) return Object.assign({ source: 'api' }, custom(m, prov) || {});
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
    Object.entries(P).forEach(([k, v]) => {
      if (!v || v.valueType !== 'boolean') return;
      /* `bills`（billingRelevant）一起留着。平台自己声明「这个开关不参与计价」时，
         界面要能照实说，而不是让用户拨一下发现报价纹丝不动、以为是坏了 ——
         SparkCine 的 mute_reference_video 就是这一类：billingRelevant:false、routingRelevant:true，
         它只影响路由（参考视频要不要保留声音），钱不变。 */
      bools[k] = { def: v.default === true, bills: v.billingRelevant !== false };
    });
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
          if (hit) {
            hit.max = Math.max(hit.max, i.max || 1);
            hit.min = Math.min(hit.min, i.min || 0);
            hit.modes = [...new Set([...hit.modes, mode])];
          }
          return;
        }
        seenSpec.add(key);
        specs.push({ role: i.role, media: i.media_type || '', min: i.min || 0, max: i.max || 1, modes: [mode] });
      });
    });
    /* 型号级 `min` 的意思只能是「**每一档请求形状都要求它**」，不是并集：
       平台把「必须带参考图」写在 image_edit 这一档（min 1），同一型号还有一档 text_to_image
       一个素材都不收 —— 拿任何一档的 min 当型号级下限，纯文字那一路会被自己人拦住
       （工作台图片台选这种型号时就是这样：不带参考图就不让生成，而平台明明收纯文字）。
       某一档没列这个 role、或写了 min 0，都说明存在一种不需要它的请求 → 型号级 min 归 0。
       `max` 相反：并集回答「最多能收几个」，任取一档的上限都成立。 */
    specs.forEach(sp => {
      const requiredInAll = modes0.every(m => (((modes[m] || {}).inputs) || [])
        .some(x => x && x.role === sp.role && (x.media_type || '') === sp.media && Number(x.min) > 0));
      if (!requiredInAll) sp.min = 0;
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
    /* 记忆化。以前每次调用都 new Map + 为每个 role new 对象 + 建新数组，而
       `rule()` = 整表 specs + find，`providerLimit()` = 遍历 prov.models 逐个 rule() ——
       N 个模型就是 N 次全量重建，而它在每次上传前都调（studio 的 findModelWithSlot 一次最多 45 次）。
       失效判据挂在 `model.options` 的**引用**上，是免费且正确的：Capabilities.apply() 每次刷新
       都给每个模型赋一个**新对象**（`m.options = base` 那句），所以能力一刷新记忆自动失效，
       不会读到陈旧能力 —— 界面照旧跟着能力声明变。只加记忆、不改判据。 */
    const memo = model && typeof model === 'object' ? this._specsMemo.get(model) : null;
    if (memo && memo.opts === o) return memo.specs;
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
        /* accept / maxBytes 两条规矩**先读声明再读 model.inputRoles**：v13 起注册表不再按型号写
           inputRoles，文件类型与单文件体积改在平台级 `roleRules` 声明，归一化时并到每一条规格上
           （见 NORM_SHAPES.vgenvConfigurations）。以前这一行只从 d 取，于是「接口给了 role、
           注册表没按型号声明」时界面上「收什么文件 / 单个多大」整块消失 —— 那是白丢的规矩。 */
        out.set(sp.role, { role: sp.role, media: sp.media || (d && d.media) || '',
          min: sp.min || 0, max: (d && d.max) || sp.max || 1,
          accept: sp.accept || (d && d.accept) || '', maxBytes: sp.maxBytes || (d && d.maxBytes) || 0,
          group: this.groupOf(sp.role, d || sp), modes: (sp.modes || []).slice(), src: d ? 'both' : 'api' });
      });
      /* 上游没列、注册表按官方文档写了的 role 也要补上（上限取声明）——
         以前 api 一存在就整份 return，上游 /models 少列一个 role（有些型号不列参考音频），
         注册表写明的那个槽位在界面上整个不见，用户以为平台不支持。 */
      if (declared) {
        Object.entries(declared).forEach(([role, d]) => {
          if (!d || out.has(role)) return;
          out.set(role, { role, media: d.media || '', min: d.min || 0, max: d.max || 1,
            accept: d.accept || '', maxBytes: d.maxBytes || 0,
            group: this.groupOf(role, d), modes: (d.modes || []).slice(), src: 'registry' });
        });
      }
      return this._memoSpecs(model, o, [...out.values()]);
    }
    if (declared) {
      Object.entries(declared).forEach(([role, d]) => {
        if (!d) return;
        out.set(role, { role, media: d.media || '', min: d.min || 0, max: d.max || 1,
          accept: d.accept || '', maxBytes: d.maxBytes || 0,
          group: this.groupOf(role, d), modes: (d.modes || []).slice(), src: 'registry' });
      });
      return this._memoSpecs(model, o, [...out.values()]);
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
    return this._memoSpecs(model, o, [...out.values()]);
  },
  /* 记忆化的落点只有这一处（三条 return 都过它）：model 不是对象时（外部可能传空）不记忆 ——
     WeakMap.set 对非对象键会抛 TypeError。 */
  _specsMemo: new WeakMap(),
  _memoSpecs(model, opts, specs) {
    if (model && typeof model === 'object') this._specsMemo.set(model, { opts, specs });
    return specs;
  },
  /* ---- 「输入模式」：一次请求的形状 ----
     specs() 回答的是「这个型号总共收哪些素材」，而**一次**能同时用哪些是另一件事：
     VGENV 把答案写在 /v3/models 的 (mode, creation_intent) 上（首尾帧与参考素材互斥、
     「动作换人」只收一条参考视频 + 恰好一张人物图），归一化成 options.combos 交到这里。
     没有这一份的平台（能力接口不区分请求形状，或根本没给）combos() 返回空数组 ——
     界面就不画那一排模式芯片，继续按 group 的互斥判据把槽位置灰，行为一字不变。 */
  combos(model) {
    const o = (model && model.options) || {};
    return Array.isArray(o.combos) ? o.combos : [];
  },
  comboOf(model, id) { return id ? (this.combos(model).find(c => c.id === id) || null) : null; },
  /* 这一个模式接受哪些 role；没有任何模式声明时返回 null（= 不按模式过滤）。
     只有一份判据：界面渲染槽位、拖拽落点、就绪判定都问它，不许在页面里自己比 mode 字符串。 */
  comboRoles(model, id) {
    const cb = this.comboOf(model, id);
    return cb ? new Set(cb.roles.map(r => r.role)) : null;
  },
  /* ---- 素材名与模式名：全站只在这里点一次名 ----
     以前 `ROLE_ZH` 与「这一档叫什么」在工作台里各有一份，导演台又抄了一份短名表
     （同一个 role 一边写「首帧图」一边写「首帧」），而模式名是页面按 role 现拼的 ——
     归一化那边已经能给「智能参考」这种整档名字（`combo.label`），页面那份拼接读不到它。
     名字与档位清单都是数据，抄一遍就会各自漂，所以两处都收到这里。 */
  ROLE_ZH: { first_frame: '开头画面', last_frame: '结尾画面', reference_image: '参考图',
    reference_video: '参考视频', reference_audio: '参考音频' },
  roleZh(role) { return this.ROLE_ZH[role] || String(role || ''); },
  INTENT_ZH: { person_replacement: '视频换人' },
  /* 模式名：归一化给了 `label` 的用那个（「智能参考」这一档的名字**不是**从 role 拼得出来的，
     它是并档那一步的语义），没给的才从数据现拼 —— 先说这一档带哪一组素材，再补意图。
     不写一张「t2va = 文生视频」的固定表：上游哪天加一个 mode，界面上顶多露出原始名，
     不会像写死表那样直接少一档（与公共层那两张档位 / 比例中文名表同一套做法）。 */
  comboLabel(cb) {
    if (!cb) return '';
    if (cb.label) return String(cb.label);
    const roles = (cb.roles || []).map(r => r.role);
    const g = [];
    if (roles.some(r => r === 'first_frame' || r === 'last_frame')) g.push('首尾帧');
    if (roles.some(r => String(r).indexOf('reference') === 0)) g.push('参考素材');
    const intent = cb.intent ? (this.INTENT_ZH[cb.intent] || cb.intent) : '';
    const base = g.length ? g.join(' + ') : '纯文字';
    return intent ? base + ' · ' + intent : base;
  },
  /* 这一档收得下这批素材吗 —— **双向**判据只有一份。
     `counts` 传 `{ role: 实际几条 }`（也接受 role 数组，按每个 role 一条算）。
     为什么要强调双向：工作台原来只查「这一档要求带、却没带的」（min 那一头），
     于是「已经放了 9 张参考图，再切到要求恰好 1 张的换人档」界面上四个绿灯、
     提交体带着 9 张去撞平台一句 422；而导演台原来整套模式判据都没接。四种说不通一次判全：
       · `missing`  = 这一档声明 min > 0、实际没带够      → `{ role, min, got }`
       · `over`     = 带了、但超过这一档声明的 max        → `{ role, max, got }`
       · `rejected` = 已经放进来的、这一档（或这个型号）根本不收 → `{ role, got, why:'combo'|'model' }`
       · `conflicts`= 已经同时用上的互斥成对（group 判据，见 conflictMap）
     `why` 要分开是因为「换个模式就能用」与「换个型号才能用」是两条出路，页面按它给不同的链接。
     没有模式声明（comboId 空 / 这一族 combos 为空）时 `missing` 与 `over` 一律空、
     `rejected` 退回型号总表 —— 没有声明就不替平台编一个上下限，行为与加这一档之前逐字相同。 */
  comboGaps(model, comboId, counts) {
    const have = {};
    (Array.isArray(counts) ? counts.map(r => [r, 1]) : Object.entries(counts || {}))
      .forEach(([r, n]) => { if (r) have[r] = Number(n) || 0; });
    const roles = Object.keys(have).filter(r => have[r] > 0);
    const out = { missing: [], over: [], rejected: [], conflicts: [], lines: [], ok: true };
    const cb = this.comboOf(model, comboId);
    if (cb) {
      const declared = new Set();
      (cb.roles || []).forEach(r => {
        declared.add(r.role);
        const got = have[r.role] || 0;
        if ((r.min || 0) > 0 && got < r.min) out.missing.push({ role: r.role, min: r.min, got, max: r.max || 0 });
        if (got > 0 && (r.max || 0) < got) out.over.push({ role: r.role, max: r.max || 0, got, min: r.min || 0 });
      });
      const specs = new Set(this.specs(model).map(s => s.role));
      roles.filter(r => !declared.has(r)).forEach(r =>
        out.rejected.push({ role: r, got: have[r], why: specs.has(r) ? 'combo' : 'model' }));
    } else {
      this.unsupportedRoles(model, roles).forEach(r =>
        out.rejected.push({ role: r, got: have[r], why: 'model' }));
    }
    out.conflicts = this.illegalPairs(model, roles);
    out.ok = !(out.missing.length || out.over.length || out.rejected.length || out.conflicts.length);
    /* 那句人话也只在这里拼一次：两个页面的黄条与「提交前先拦住」都读 `lines`，
       页面再各写一遍措辞就是第二份判据（数量、名字都得自己抄，抄一次漂一次）。 */
    const at = cb ? '当前输入模式（「' + this.comboLabel(cb) + '」）' : '当前型号';
    if (out.missing.length) out.lines.push(at + '必须带上：' + out.missing
      .map(m => this.roleZh(m.role) + '（至少 ' + m.min + '，现在 ' + m.got + '）').join('、'));
    if (out.over.length) out.lines.push(at + '最多收：' + out.over
      .map(m => this.roleZh(m.role) + ' ' + m.max + ' 个，现在 ' + m.got + ' 个，多出来的发不出去').join('、'));
    out.rejected.forEach(x => out.lines.push(
      (x.why === 'combo' && cb ? at + '不收已选的' : '当前型号不支持已选的')
      + this.roleZh(x.role) + '（已放 ' + x.got + ' 个）'));
    if (out.conflicts.length) out.lines.push('已同时选了互斥的两组：' + out.conflicts
      .map(([a, b]) => '「' + this.roleZh(a) + ' + ' + this.roleZh(b) + '」').join('、')
      + '，一次请求只能用一组，请清空其中一组');
    return out;
  },
  /* 「有没有哪一档收得下这批素材」全站只有这一份判据：换型号 / 能力刷新后的回落、
     黄条上那句「切到『X』」、拖素材进来时的落点候选，三个地方都问它。
     页面各比一遍 role 字符串就是第二份判据 —— 一定会和提交体那套过滤漂开。
     ⚠ 只看 `max > 0`（收不收），不看 `min`（必须带）：这一问是「手上这批放不放得进去」，
       要求多带几样不算放不下，缺的那部分由 `comboGaps.missing` 说。 */
  comboCovering(model, roles) {
    const need = (roles || []).filter(Boolean);
    return this.combos(model).find(c => need.every(r => (c.roles || []).some(x => x.role === r && (x.max || 0) > 0))) || null;
  },
  /* 选中的那一档还成立吗（换型号、能力刷新之后 id 会变）：成立就原样返回；
     不成立先退到**收得下当前这批素材**的那一档，再没有就退到归一化排在最前的那一档
     （并档后的「智能参考」= 空载也能用，所以它排第一）。
     退档**不删素材** —— 收不下的那一些交给 `comboGaps` 摆出来并拦住提交，
     静默丢掉用户传进去的东西是本项目反复拦的那一类。
     返回应该落到的 comboId；这个型号压根没有模式声明时返回空串（界面不画那一排，行为与加这一档之前相同）。 */
  fallbackCombo(model, comboId, roles) {
    const list = this.combos(model);
    if (!list.length) return '';
    if (comboId && list.some(c => c.id === comboId)) return comboId;
    const fit = this.comboCovering(model, roles) || list[0];
    return fit.id;
  },
  /* 「这一档收哪几类素材、各几个」那一行说明：数字（min / max）与名字全部现读那一档的声明，
     页面抄一句就会漂 —— 工作台与导演台原来各写了一份逐字相同的字符串，
     其中一份改了「空档那一档怎么说法」，另一份还挂着「这一档收：」的空尾巴。
     `cb.hint` 是归一化并档时给的整档说明（「智能参考」= 送上来哪批素材就是哪一种请求），
     有就补在后面：那一档的名字讲不清它和别档的区别，这句话才讲得清。 */
  comboScopeNote(cb) {
    if (!cb) return '';
    const s = (cb.roles || []).length
      ? '这一档收：' + cb.roles.map(r => this.roleZh(r.role)
        + (r.min > 0 ? '（至少 ' + r.min + '）' : '') + ' ≤' + (r.max || 0)).join(' · ')
      : '这一档只用文字提示词，不需要参考素材';
    return cb.hint ? s + ' · ' + cb.hint : s;
  },
  /* 「输入模式」那一排芯片的画法（与上面 `AdvExtras.html.*` 同一立场：判据 + 画法一份，页面只接线）：
     两个页面只剩「什么时候整块不出现」「id 挂在哪」「点下去调谁」这三件各自的事。
     只有一档时返回空串 —— 点下去什么都不变的按钮就是「看着能点、其实什么都不做」的死控件，
     而说明行照旧留着（它讲得清用户被限定成了什么形状）。 */
  comboChipsHTML(list, currentId) {
    if (!list || list.length < 2) return '';
    const E = window.esc;
    return (list || []).map(c => '<button type="button" class="ui-pill' + (c.id === currentId ? ' on' : '')
      + '" data-cid="' + E(c.id) + '">' + E(this.comboLabel(c)) + '</button>').join('')
      + '<span class="why">换模式只改「这一次能同时用哪几类素材」，已放好的不清掉；'
      + '收不下的那一类会标出来，并在提交前拦住。</span>';
  },
  /* 当前模式下这一组参数的**取值范围与默认值**：有模式声明就按那一档的，
     没有就退回型号总表。平台在换人档里只给 768p / 没有 2x，界面就只给 768p ——
     页面不许另写一句「选了换人就少几个档」（那是第二份判据）。 */
  scopedOptions(model, id) {
    const base = (model && model.options) || {};
    const cb = this.comboOf(model, id);
    if (!cb) return base;
    const o = Object.assign({}, base);
    ['tiers', 'resolutions', 'aspect_ratios', 'upscale', 'durations'].forEach(k => {
      if (cb[k] !== undefined && cb[k] !== null) o[k] = cb[k];
    });
    if (cb.defaults) o.defaults = Object.assign({}, base.defaults || {}, cb.defaults);
    return o;
  },
  /* 某个声明字段（create.topBools 里那几项）在**这一次的形状**下成不成立：{ hidden, def, note }。
     判据只在模块顶层那一份（topBoolState），这里只是对外的入口 ——
     页面不许自己比 intent 字符串（那是第二份判据，一定会和提交体的过滤漂开）。 */
  fieldState(decl, ctx) { return topBoolState(decl, ctx || null); },
  /* 声明里的 `when: { mode, intent }` 与**这一次的形状**匹不匹配 —— 判据只有这一份，
     提交体、报价体（`pricing.noQuote.when`）与界面三处都问它；页面不许自己比字符串。 */
  whenMatches,
  /* ---- 「这一次的那一行」：逐行能力 ----
     VGENV 把 turbo 与 2x 超分写在 (tier × 这一批素材组合) 上，实测同一个模式里：
     带参考视频的那几种组合 turbo 一律 false；enhanced 档没有 2x；而 quality 档与换人档又给 turbo。
     所以「这个型号总共有没有 turbo」（options.turbo，并集）**回答不了**「这一次能不能用」——
     按并集画开关、按并集发字段，就会被平台以未知/不支持的组合拒掉。
     这份判据只在这里算一次，界面画不画、提交发不发、报价带不带全问它。
     返回 `{ known, perRow, turbo, upscale }`：
     · `perRow:false` = 这一家没有逐行清单（combos 里没有 states）→ 退回型号总表的并集，
       行为与加这一档之前逐字相同；
     · `known:false`  = 有逐行清单，但**上游没列过这一档**（素材还没选齐、或选了清单外的一批）。
       实测全 204 行不存在 (tier × 素材组合) 的空档，所以走到这一支必然是界面这边的问题，
       一律「不给字段」而不是猜一个 —— 这一家「未知字段会被拒绝」是实测过的。 */
  shapeState(model, comboId, roles, tier) {
    const o = (model && model.options) || {};
    const cb = this.comboOf(model, comboId);
    const fb = { known: true, perRow: false, turbo: o.turbo === true, upscale: (o.upscale || []).slice() };
    if (!cb || !cb.states) return fb;
    const t = String(tier || (cb.defaults && cb.defaults.tier) || '');
    const key = shapeRolesKey(roles);
    const row = (cb.states[t] || {})[key];
    if (!row) return { known: false, perRow: true, turbo: false, upscale: [], tier: t, rolesKey: key };
    return { known: true, perRow: true, turbo: !!row.turbo, upscale: (row.upscale || []).slice(), tier: t, rolesKey: key };
  },
  /* `create.shapeFields` 里声明的那些**不是布尔**的顶层字段（超分档、随机种子、换人的动作起点）：
     与 topBools 同一套思路 —— 页面只为声明出来的项渲染控件，取值与提交都按这一份判据。
     判据本体在模块顶层（shapeFieldState），提交体那一路（Api.createBody）问的是同一个函数，
     所以「界面画不画」「提交发不发」「报价带不带」不会漂。这里只是对外的入口。 */
  shapeFieldState,
  /* 某个模型某个槽位「收什么」：数量上下限 + 接受的文件类型 + 单文件字节上限。
     界面文案、统一选择器的档位与本地上传 accept、上传前的体积校验都只读这里，
     不要在页面里写死「9 张 / 10MB / mp3-wav」。没声明就是 0 / 空串（界面要显示「平台未声明」而不是猜）。
     `comboId`（当前输入模式）传进来时，数量按**那一档**的声明：同一个人物图角色在
     「参考素材」里能到 9 张，在「视频换人」里必须恰好 1 张 —— 只看并集就会让用户传到第 2 张才被平台拒。 */
  rule(model, role, comboId) {
    const sp = this.specs(model).find(x => x.role === role) || {};
    let min = sp.min || 0, max = sp.max || 0;
    const cb = this.comboOf(model, comboId);
    if (cb) {
      const r = cb.roles.find(x => x.role === role);
      min = r ? r.min : 0;
      max = r ? r.max : 0;
    }
    return { role, max, min, accept: sp.accept || '', maxBytes: sp.maxBytes || 0, group: sp.group || '' };
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
  /* 规则 → 一行人话：「MP3 / WAV，≤ 10.0 MB」。规则对象（Capabilities.rule）与人话这一份是共用的：
     槽位标题、就绪判定、统一选择器的提示条都调它，页面不要再各拼一次。 */
  ruleLineOf(r) {
    if (!r) return '';
    const kinds = String(r.accept || '').split(',').map(x => MIME_SHORT[(x || '').trim()] || (x || '').trim()).filter(Boolean);
    return [kinds.length ? kinds.join(' / ') : '', r.maxBytes ? '≤ ' + window.fmtBytes(r.maxBytes) : ''].filter(Boolean).join('，');
  },
  /* 槽位声明 → 一行提示：「MP3 / WAV，≤10MB」；什么都没声明就返回空串（界面不显示假规矩） */
  ruleText(model, role) { return this.ruleLineOf(this.rule(model, role)); },
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
    /* 本机刚启动那阵，出站系统代理（7897）的 TLS 链常常还没热 —— 实测 12:25 一波
       「Client network socket disconnected」把首屏的型号清单全打挂，用户看到的是
       「获取型号失败」，手动刷新一下才好。/capabilities 是同源只读 GET，
       重问一次没有任何副作用，所以这里自己带一次退避重试，不要等用户手动刷新。 */
    let r = null, lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { r = await window.Net.fetch(q, { timeout: 25000, retry: 0 }); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(res => setTimeout(res, 2500));
      }
    }
    if (!r) { console.warn('[Capabilities] 能力接口不可用（重试一次仍失败）：', lastErr && lastErr.message); return null; }
    if (r.status === 404) { this.unavailable = true; console.warn('[Capabilities] 代理没有 /capabilities 路由（重启 proxy.js 即可）'); return null; }
    if (!r.ok) throw new Error('能力接口 HTTP ' + r.status);
    return await r.json();
  },
  /* 这一家的这一个型号是哪种媒体（'图片' / '视频' / '' = 判不出）。
     判据用平台自己的 `list.media` 前缀声明（与列表分类同一份），不是我们猜的名字规律。 */
  mediaOf(prov, id) {
    const md = (prov && prov.list && prov.list.media) || {};
    const s = String(id || '').toLowerCase();
    const low = a => (a || []).map(x => String(x).toLowerCase());
    if (low(md.imagePrefix).some(p => s.startsWith(p))) return '图片';
    if (low(md.videoPrefix).some(p => s.startsWith(p))) return '视频';
    return '';
  },
  /* 一份 /models 常常同时列图片与视频（SparkCine：两条 provider 共用一个上游）。
     这一家的清单只留 `modelMedia` 点名的那一类 —— 判据只有这一处：
     合并进注册表时用它（apply），设置页列「这一家都有哪些型号」时也用同一个，
     各判一遍就会出现「下拉里没有它，设置页却列着一行能用」。 */
  skipMedia(prov, id) {
    const want = (prov && prov.modelMedia) || '';
    if (!want) return false;
    const got = this.mediaOf(prov, id);
    return !!(got && got !== want);
  },
  /* 每家型号**注册表声明**那一份的底稿（第一次合并前原样记下）。
     为什么要留底：接口答复是「当前状态」，撤销回去的档位不能靠单向合并永远留在下拉里，
     所以每次合并都从声明那一份重新长。WeakMap：注册表重取后对象换了自然释放。 */
  _decl: typeof WeakMap === 'function' ? new WeakMap() : null,
  /* 把能力合并进 REG 里对应平台的模型声明：接口优先，registry 声明兜底 */
  apply(REG, providerId, capsById) {    const list = (REG && REG.providers) || [];        // 注册表还没就绪时不要抛错
    const prov = list.find(p => p.id === providerId || (p.keyId || p.id) === providerId);
    if (!prov) return 0;
    let n = 0;
    /* 同一家平台同时做图与视频时（SparkCine：两条 provider 共用同一个上游），
       /models 返回的是**一份合在一起的清单** —— 不切分的话视频台会列出 img-*、
       图片台会列出 h3-video-*。切分判据只有一份，见上面的 skipMedia。 */
    const skip = id => this.skipMedia(prov, id);
    /* 「这一个型号被本机勾了隐藏」只问 ModelPrefs.isOff 一处（判据跟着数据走，不在页面里数一遍）。
       注册表里那一份已经被代理按偏好筛过了，但**能力接口这一份是上游的原始清单** ——
       不在下面第二个循环筛一次的话，「隐藏」过的型号会被能力刷新重新塞回 `prov.models`，
       表现就是「在设置里藏掉了，过一会儿又出现在工作台下拉里」。 */
    const hidden = id => !!(window.ModelPrefs && window.ModelPrefs.isOff(prov, id));
    /* cap → 型号：两条路共用这一份合并（清单里已有的型号就地合并 / 接口新出的型号先长出来再合并）。
       以前只有第一支有这一段，长出来的那一支只读 `cap.options` 那一层 —— 而 `norm()` 交的是一份
       **扁平** cap（inputSpecs / combos / durations / bools / defaults / source 全铺在顶层，
       压根没有 options 这一层）。v13 起注册表不再下发型号清单，于是**每一个型号都是第一次刷新时
       长出来的**，那份扁平 cap 就在第一次刷新里整个丢掉：options 是空的 → 参考素材槽位、参数档位、
       价格表全都不出现，要等第二次刷新（走「已有型号 → 合并」那一支，它读全部键）才补回来。
       用户看到的形状正是「导演台右栏参考文件框要切换一下模型才加载出来」。 */
    const mergeCap = (m, cap) => {
      /* forceOptions：registry 里声明「这一项不许被能力接口覆盖」。
         用在平台声明与实测不符的地方 —— 例如 SparkCine 生图声明了 jpeg/webp，
         实测（产物字节头 / mime_type / 文件名）却永远是 png，那就以实测为准，不给假选项。 */
      const forced = new Set(m.forceOptions || []);
      /* 起点是**注册表声明**那一份，不是上一次合并的结果：
         上一轮接口声明过、这一轮撤掉的档位，不能靠单向合并永远留在下拉里。 */
      let decl = this._decl.get(m);
      if (!decl) {
        decl = { options: Object.assign({}, m.options || {}), price: m.price,
          perSecond: m.perSecond, maxRefImages: m.maxRefImages };
        this._decl.set(m, decl);
      }
      /* `options` 深合一次：能力那一侧可能只有 source 之类的几个键，浅盖会把声明里的 formats 抹掉 */
      const merged = Object.assign({}, decl.options);
      Object.keys((cap && cap.options) || {}).forEach(k => { if (!forced.has(k)) merged[k] = cap.options[k]; });
      Object.keys(cap || {}).forEach(k => {
        if (k === 'options') return;                    // 那一层上面已经合过了，别在这儿再套一层
        if (cap[k] !== undefined && !forced.has(k)) merged[k] = cap[k];
      });
      /* 每次都赋一个**新对象**：`specs()` 的记忆化挂在 options 的引用上，能力一刷新就该失效 */
      m.options = merged;
      /* 下面几个字段以前无条件被能力接口覆盖：forceOptions 保护不到它们，
         「平台声明与实测不符」时（例如 SparkCine 只出 PNG、价格表要锁死）会出现假信息。 */
      if (cap.price && !forced.has('price')) m.price = Object.assign({}, decl.price || {}, cap.price);
      m.perSecond = (cap.perSecond !== undefined && !forced.has('perSecond')) ? cap.perSecond : decl.perSecond;
      m.maxRefImages = (cap.max_ref_images !== undefined && !forced.has('max_ref_images'))
        ? cap.max_ref_images : decl.maxRefImages;
    };
    (prov.models || []).forEach(m => {
      if (skip(m.id)) return;
      const cap = capsById[m.id];
      /* 接口没给这个模型 → 回到声明那一份（仍然换新 options，让上面那条记忆化判据成立）。
         不回退的话，上一轮从接口长出来的档位会一直挂在一条已经撤掉的型号上。 */
      if (!cap) {
        const decl = this._decl.get(m);
        m.options = Object.assign({}, (decl ? decl.options : m.options) || {});
        if (decl) { m.price = decl.price; m.perSecond = decl.perSecond; m.maxRefImages = decl.maxRefImages; }
        return;
      }
      mergeCap(m, cap);
      n++;
    });
    /* 接口给了、声明里没有的型号 → **照样长出来**。
       以前只遍历 prov.models，所以「型号清单」实际上是由 registry 声明决定的，
       能力接口只能给已声明的那些补能力 —— 于是「去掉兜底声明」等于「把这一家的型号全删掉」。
       现在型号清单来自接口（声明退化成接口形状与必要映射），平台上新一个型号刷新就能看到。 */
    for (const [id, cap] of Object.entries(capsById || {})) {
      if ((prov.models || []).some(m => m.id === id)) continue;
      if (skip(id) || hidden(id)) continue;            // 不是这一类媒体的型号（见上面 modelMedia）/ 本机已经藏起来的那一个
      prov.models = prov.models || [];
      /* 长出来的这一条要**先铺上注册表声明的那一层**（`models` 与 `modelDocs` 都算）。
         以前这里只写 id/name/modes/options，于是「上游只回 id」的家在第一次能力刷新之后
         就把 per-id 声明整块丢了：MiMo 语音正是这种家（`prov.models` 本来就是空的，
         全部事实都写在 `modelDocs` 里）—— 丢掉的恰好是 modes（能不能做**音色复刻 / 音色设计**）、
         inputRoles（**参考音频槽**在不在）与 options.formats（格式清单）。
         界面表现就是用户报的那两条：「模仿音色没有参考素材的卡片了」「音色设计/复刻的入口不见了」。
         能力接口给的**优先**（它是实测到的现状），只是它没给的键要保住声明那一份。 */
      const d = (prov.models || []).concat(prov.modelDocs || []).find(x => x && x.id === id) || null;
      const grown = Object.assign({}, d || {}, { id: id, name: (cap && cap.name) || (d && d.name) || id });
      /* 先铺声明那一层，再走上面同一份 `mergeCap`（两条路只有一份合并，别在这里再拼一遍 cap） */
      grown.options = Object.assign({}, (d && d.options) || {});
      mergeCap(grown, cap);
      /* 归一化没认出这一家的形状时（`modelsShape` 为空），cap 里还留着上游原样那串
         （id / object / owned_by）—— 那几个键不是生成参数，别混进 options。 */
      if (!(prov && prov.modelsShape)) {
        delete grown.options.id; delete grown.options.object; delete grown.options.owned_by;
      }
      if (cap && Array.isArray(cap.modes) && cap.modes.length) grown.modes = cap.modes;
      prov.models.push(grown);
      n++;
    }
    return n;
  },
  /* 拉某个平台的最新能力并合并；返回代理给的原始答复（含 source / note） */
  async refreshProvider(REG, prov, opts) {
    const d = await this.fetchCaps(prov, opts);
    if (!d) return null;
    const byId = {};
    Object.entries(d.models || {}).forEach(([id, raw]) => { byId[id] = this.norm(raw, prov.modelsShape, prov); });
    const n = this.apply(REG, prov.id, byId);
    this.sources = this.sources || {};
    this.sources[prov.id] = { from: d.source, note: d.note || '', at: Date.now(), cached: !!d.cached,
      stale: !!d.stale, models: n };
    return d;
  },
  /* 这个平台的能力是哪来的（界面用它提示「上游接口」还是「平台声明兜底」） */
  sourceOf(prov) { return ((this.sources || {})[prov && prov.id]) || null; },
  /* 能力来源那句话：全站只此一份（界面三处 + AI 助手一处都调它）。
     以前 studio.html 里有三处各写一遍 —— 型号下拉下的副注、格式下拉下的提示、
     换平台后的 #capHint —— 措辞两套（「能力来自上游接口」与「来自上游 /models」）、
     缓存标记两套（有 vs 没有），而格式下拉那处还把 note 整个丢了；ai-chat.js 那一处同样丢。
     note 不是可有可无的说明，是「这家为什么没拿到上游能力」的唯一原因：proxy.js 的四处兜底
     各给了不同的话（没声明该端点 / 返回 404 / 没返回模型列表 / 请求失败），压成一句
     「上游接口没给或不可用」等于零信息，而同一屏上另一处正写着真正的原因。
     措辞向原有的多数派收敛；端点名 /models 是代理侧的事，界面不必报。 */
  srcTextOf(src) {
    if (!src) return '';
    if (src.from === 'api') {
      /* stale = 这一份是代理**本机落盘的上次真清单**（上游这次还没答回来，后台正在刷新）。
         它和 cached 必须分开说：「（缓存）」会被读成「60 秒内的新鲜答复」，
         而 stale 那份可能是几小时前的 —— 平台刚上新型号时用户看到的清单少一条，
         界面上得有一句真话解释为什么少。 */
      if (src.stale) return '能力来自上游接口（本机上次取回的清单，正在后台刷新）';
      return '能力来自上游接口' + (src.cached ? '（缓存）' : '');
    }
    return src.note || '按平台声明兜底';
  },
  /* 能力清单整体落定没有：load() 把在用的平台全试完（成或败都算）才置真，新的一轮 load() 先翻回假。
     清单是逐家到货的，落定之前「清单里没有某个型号」只说明那一家还没回来 ——
     「下架、换型号」这种动了用户数据的结论只许落定之后下（chain.js 的 chainModelRepick）。 */
  settled: false,
  /* 启动时把所有平台的能力拉一遍（保持原签名；失败静默，界面用 registry 兜底）
     **并发限流，不是一个一个来**：注册表里十几家平台，每家一次请求、各自最多 25 秒超时，
     串行的话慢的那一家就把「能力声明还没回来」这件事拖到几十秒 —— 各页首屏因此会长时间
     显示「还没配接口 / 一次只能出一张 / 型号下拉空」，而密钥其实好好地配着。
     4 路并发：既能把这段时间压到几秒，又不至于把上游打出限流。
     结果按模型 id 汇总（byId 是字典，合并顺序不影响结果），与串行版完全等价。 */
  async load(REG, opts) {
    this.settled = false;
    const byId = {};
    this.sources = {};
    /* 只向**本机已经在用**的平台问能力，判据只有一份：`Api.provUsable`
       （自定义添加的 / 设置页填了密钥的 / `.env` 里有环境密钥的 —— 设置页「供应商与密钥」那张卡
       与侧栏余额用的是同一个函数，这里再用第三份就会出现「只配了 3 家却挨个问了十几家」）。
       原来按注册表全量问：注册表里十几家平台，每家一次能力请求，用户根本没碰过的那些也照问不误 ——
       白等好几秒、白耗上游额度，界面上还完全看不出区别。 */
    let env = {};
    let envKnown = false;
    try {
      if (window.Api && Api.envStatus) {
        env = await Api.envStatus();
        envKnown = !!(Api.envKnown && Api.envKnown());
      }
    } catch (e) { env = {}; envKnown = false; }
    /* 问哪几家：看**有没有能力端点**（声明了 endpoints.models），或本地还留着型号声明。
       以前是「有兜底 models 才问」—— 那一改把两件事绑死了：删掉兜底声明 = 这一家永远不会被问。
       现在能力端点是主路径，声明只是「还没拉到时的样子」。 */
    const all = (REG.providers || []).filter(p => (p.endpoints && p.endpoints.models) || (p.models || []).length);
    const usable = p => !window.Api || !Api.provUsable ? true : Api.provUsable(p, env);
    /* 知道「哪几家有环境密钥」才敢筛；`/env-status` 没取到时退回全量 ——
       那时是**不知道**哪几家在用，不是「一家都没有」，拿「不知道」当「没有」
       会把真正在用的那几家能力全丢掉，界面上表现为型号下拉全空且不报错。 */
    const canJudge = !!(envKnown && window.Api && Api.provUsable);
    const provs = canJudge ? all.filter(usable) : all;
    console.log('[Capabilities] 问 ' + provs.length + '/' + all.length + ' 家'
      + (canJudge ? '（本机在用的：' + provs.map(p => p.id).join(', ') + '）'
        : '（/env-status 没取到，退回全量：不知道哪几家在用）')
      + '｜跳过：' + (canJudge ? all.filter(p => !usable(p)).map(p => p.id).join(', ') : '无'));
    const one = async (p) => {
      let ok = false;
      try {
        const d = await this.refreshProvider(REG, p, { force: opts && opts.force });
        if (d && d.models) Object.assign(byId, d.models);
        ok = true;
      } catch (e) { console.warn('[Capabilities] ' + p.id + ' 能力读取失败：', e.message); }
      /* 一家落定就广播一次（`wb:cap-ready`）：模型数据其实每家落地时就已经并进
         `prov.models`（apply() 在 refreshProvider 里），缺的只是「可以补画了」的通知 ——
         以前界面只认 `.then` 那一次，上游慢的那一家就把右栏拖到分钟级。
         失败的那一家也投：等着的界面照常补一次，算不出来的照样保持上一份。 */
      try { window.dispatchEvent(new CustomEvent('wb:cap-ready', { detail: { id: p.id, ok } })); } catch (e) { /* 广播只是通知不是数据通道，投不出去也不许拖垮 load */ }
    };
    const CAP_CONC = 4;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CAP_CONC, provs.length) }, async () => {
      while (i < provs.length) { const p = provs[i++]; await one(p); }
    }));
    const n = Object.keys(byId).length;
    if (n) console.log('[Capabilities] 已取得 ' + n + ' 个模型的能力：', Object.keys(byId).join(', '));
    else console.warn('[Capabilities] 未取得模型能力（平台可能没有能力接口），使用 registry 兜底声明');
    this.models = byId;
    this.settled = true;
    return byId;
  },
};
