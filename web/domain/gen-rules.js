/* GenRules —— 「这一单能不能提交」全站只有这一份判据。
   修的是哪一件事：同一句「现在能不能按生成」有两套写法 ——
     · 工作台 `web/pages/studio.js` 的 `submitBlockReason`（+ shapeGaps / blockedSlotKinds / advExtras），
     · 助手 `web/features/chat.js` 的 `genCheck`（+ checkParam，一百多行）。
   两边都读 `Capabilities`，但**规则怎么排、哪条先拦、拦哪种情况各写各的**，
   于是同一组参数一边拦一边放：最典型的是「型号声明必带一张参考图、这次一张没带」——
   助手拦，工作台放（它只在有「输入模式」声明时查 min），撞上去就是平台一句 422。

   这里的立场：
     ① 只出**结论**（`{ code, args }`），绝不出句子。措辞是两个界面各自的事：
        工作台要说「请输入要合成的文本」，助手要对模型说「generate 要写 prompt（提示词）」，
        说法本来就该不同；但「拦不拦、为什么拦」必须是同一个理由码 ——
        所以调用方只做 `code → 文案` 这一层翻译，翻不出来的码就是漏判据（判据 tests/gen-rules.mjs 会红）。
     ② 具体某一条判据本身仍留在它原来那一处（`Capabilities` 的槽位声明、`CharLimits` 的字数、
        `TtsAdv.wayWhy` 的语音方式、`AdvExtras` 的扩展字段），这个模块负责的是**编排**：
        先后顺序、缺哪一样算哪一样、哪些情况根本不适用。以前缺的正是这一份编排。
     ③ 纯函数：不碰 DOM、不读 Toast/Confirm、不 await。平台、型号、素材、参数都由调用方
        折算成 plain 数据递进来；递不进来的事实（比如工作台没有「附件序号」）= 那一条不适用，
        而不是两边各判各的。
     ④ `window` 上只挂 `GenRules` 一个面。 */
(function () {
  'use strict';

  /* 通用参数键 → 型号声明里的字段名。只有这一份：助手以前自己拿着这张表，
     工作台的下拉则是另一套键名（size ↔ res），所以页面那侧不递参数、由界面本身按声明画。 */
  const STD = { count: 'max_outputs', duration: 'durations', res: 'resolutions', ar: 'aspect_ratios',
    quality: 'qualities', tier: 'tiers', format: 'output_formats' };

  /* 理由码清单：调用方的文案表必须每条都翻得出来，多一条或少一条都算漂（判据比的是这个清单）。 */
  const CODES = ['no-provider', 'provider-off', 'key-not-configured', 'kind-text', 'kind-audio',
    'no-model', 'empty-prompt', 'param-value', 'tts-way', 'char-limits', 'slot-shape', 'slot-pairs',
    'slot-source', 'slot-template', 'slot-bytes', 'slot-accept', 'shape-field', 'attachment-drift'];

  const caps = () => window.Capabilities || null;
  const api = () => window.Api || null;
  const zh = role => { const C = caps(); return C && C.roleZh ? C.roleZh(role) : String(role || ''); };

  function optList(o, key) {
    const v = o[key];
    return Array.isArray(v) ? v : (v == null ? null : [v]);
  }

  /* 单个参数按型号声明校验。返回 `{ 值 }`（归一化后的取值）或 `{ 错 }` ——
     错是**结构化**的（`why` + 数字），界面据此拼自己那句话。
     判据逐条与助手原来那份一致：不在通用字段表里、没给值、声明里压根没这一项、
     数量上下限、时长的区间与档位、其余取值得在声明的清单里（`768` 认 `768p`）。 */
  function checkParam(model, key, val) {
    const o = (model && model.options) || {};
    if (!Object.prototype.hasOwnProperty.call(STD, key)) return { 错: { why: 'not-standard', key } };
    if (val === undefined || val === null || val === '') return { 错: { why: 'no-value', key } };
    const decl = optList(o, STD[key]);
    if (!decl) return { 错: { why: 'undeclared', key, field: STD[key], modelId: (model && model.id) || '' } };
    if (key === 'count') {
      const n = Number(val), max = Number(decl[0]);
      if (!Number.isFinite(n) || n < 1) return { 错: { why: 'count-min', key } };
      if (Number.isFinite(max) && n > max) return { 错: { why: 'count-max', key, max } };
      return { 值: Math.round(n) };
    }
    if (key === 'duration') {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) return { 错: { why: 'duration-nan', key } };
      const nums = decl.map(Number).filter(Number.isFinite);
      /* durations 给两个升序数字 = 区间（与注册表归一化同一套约定），否则是离散档位 */
      if (nums.length === 2 && nums[1] >= nums[0]) {
        if (n < nums[0] || n > nums[1]) return { 错: { why: 'duration-range', key, from: nums[0], to: nums[1] } };
        return { 值: n };
      }
      if (!nums.includes(n)) return { 错: { why: 'duration-steps', key, steps: nums } };
      return { 值: n };
    }
    const want = String(val);
    const hit = decl.find(x => String(x) === want);
    if (hit === undefined) {
      /* 分辨率这类写成 '768p'，数值相同也算（用户和模型都会写 768） */
      const asNum = v => Number(String(v).replace(/[^0-9.]/g, ''));
      const eq = decl.find(x => asNum(x) && asNum(x) === asNum(want));
      if (eq !== undefined) return { 值: String(eq) };
      return { 错: { why: 'not-in-list', key, want, decl: decl.map(String) } };
    }
    return { 值: want };
  }

  /* 型号：按 id 或按显示名找（助手收的是模型写的字符串），也接页面已经解析好的对象。 */
  function pickModel(prov, ref) {
    if (ref && typeof ref === 'object' && ref.id) return ref;
    const list = (prov && prov.models) || [];
    const s = String(ref == null ? '' : ref).trim();
    if (!s) return list[0] || null;
    return list.find(x => x && (x.id === s || x.name === s)) || null;
  }

  /* 素材条目归一：`{ role, source, bytes, mime, name, i }`。
     页面那侧只有「每个槽位几条」（counts），助手那侧有「第几项、来源、多大、什么类型」——
     没有的事实留 null，对应的判据就不适用（不是各判各的）。 */
  function materials(I) {
    if (Array.isArray(I.materials)) {
      return I.materials.map((m, i) => ({
        role: String((m && m.role) || '').trim(), source: !!(m && m.source),
        bytes: m && Number.isFinite(Number(m.bytes)) ? Number(m.bytes) : null,
        mime: String((m && m.mime) || ''), name: String((m && m.name) || ''), i,
      }));
    }
    const counts = I.slots && typeof I.slots === 'object' ? I.slots : {};
    const out = [];
    Object.entries(counts).forEach(([role, n]) => {
      for (let k = 0; k < (Number(n) || 0); k++) out.push({ role: String(role), source: true, bytes: null, mime: '', name: '', i: out.length });
    });
    return out;
  }

  function countsOf(mats) {
    const out = {};
    mats.forEach(m => { if (m.role) out[m.role] = (out[m.role] || 0) + 1; });
    return out;
  }

  /* 形状差集：有「输入模式」声明就整份走 `Capabilities.comboGaps`（那一句人话也只在那一处拼）；
     没有模式声明的平台，`comboGaps` 按它自己的契约**不替平台编上下限**（min/max 两头一律空），
     而助手原来是自己按型号总表查的 —— 抽取之后取严的那一条：缺必带的、超上限的都拦。
     这一条是本轮唯一「工作台由拦变放…反过来，由放变拦」的改动，理由与判据都写在这里。 */
  function gapsFor(model, combo, counts) {
    const C = caps();
    const out = { missing: [], over: [], rejected: [], conflicts: [], lines: [], declared: [], hasCombo: false };
    if (!C) return out;
    out.declared = (C.specs ? C.specs(model) : []).map(s => s.role);
    const g = C.comboGaps ? C.comboGaps(model, combo, counts) : null;
    if (!g) return out;
    out.missing = (g.missing || []).slice(); out.over = (g.over || []).slice();
    out.rejected = (g.rejected || []).slice(); out.conflicts = (g.conflicts || []).slice();
    out.lines = (g.lines || []).slice();
    out.hasCombo = !!(C.comboOf && C.comboOf(model, combo));
    if (out.hasCombo) return out;
    const at = '当前型号';
    out.declared.forEach(role => {
      const s = (C.specs ? C.specs(model) : []).find(x => x.role === role) || {};
      const got = counts[role] || 0;
      if ((s.min || 0) > 0 && got < s.min) out.missing.push({ role, min: s.min, got, max: s.max || 0 });
      if (got > 0 && (s.max || 0) > 0 && got > s.max) out.over.push({ role, max: s.max, got, min: s.min || 0 });
    });
    if (out.missing.length) out.lines.push(at + '必须带上：' + out.missing
      .map(m => zh(m.role) + '（至少 ' + m.min + '，现在 ' + m.got + '）').join('、'));
    if (out.over.length) out.lines.push(at + '最多收：' + out.over
      .map(m => zh(m.role) + ' ' + m.max + ' 个，现在 ' + m.got + ' 个，多出来的发不出去').join('、'));
    return out;
  }

  /* 附件序号漂移：卡片画的那一刻记的是「第几个附件叫什么、本机地址是什么」，
     用户中途加/删/换过附件，序号就落到别的文件上 —— 只按 (序号, 名字, 地址) 复核，
     对不上就退回重问，绝不凭序号猜一份素材替用户提交。 */
  function driftOf(I) {
    const pins = Array.isArray(I.pin) ? I.pin.filter(Boolean) : [];
    if (!pins.length || !Array.isArray(I.attachments)) return [];
    return pins.filter(x => {
      const rec = I.attachments[x.idx];
      return !rec || String(rec.name || '') !== String(x.name || '') || String(rec.src || '') !== String(x.src || '');
    });
  }

  /* ============================ 唯一入口 ============================
     `whyNot(input)` → `{ code, args }` | `null`（null = 可以提交）。
     input（缺哪样就是那条判据不适用，不猜）：
       surface    'page'（生成工作台/导演台：能提交语音） | 'assistant'（助手：只提交图与视频）
       prov / provider   平台对象，或注册表里的 id / keyId
       kind     不传就按 prov.kind
       model    型号对象，或型号 id / 显示名
       prompt   原始文本（内部 trim）
       params   { 键: 值 }（助手：值由模型写，必须逐条查；页面：不递，下拉本身按声明画）
       combo    「输入模式」id
       slots    { role: 条数 }（页面）
       materials [{ role, source, bytes, mime, name }]（助手）
       attachments 助手那一侧的附件表（供序号复核）· pin 卡片钉住的 (序号,名字,地址)
       extrasBad  平台扩展字段的不合格项（AdvExtras 判的，这里只决定「有就不许提交」）
       keyConfigured  布尔；null/undefined = 不知道（环境密钥没取到时也不许瞎拦） */
  function whyNot(input) {
    const I = input || {};
    const A = api();
    const page = I.surface === 'page';
    const prov = I.prov || (A && A.prov ? A.prov(I.provider) : null);
    if (!prov || !prov.id) return { code: 'no-provider', args: { ref: String(I.provider || ''), kind: String(I.kind || '') } };
    const kind = String(I.kind || prov.kind || '');
    /* 文字与语音不是「这一单参数写错了」，是「这个地方不提交这种东西」：
       文字归助手自己对话，语音是同步合成、上游没有任务号可跟（那套管子在页面那一栏里）。 */
    if (kind === 'text') return { code: 'kind-text', args: { kind } };
    if (kind === 'audio' && !page) return { code: 'kind-audio', args: { kind } };
    if (I.keyConfigured === false) {
      return { code: 'key-not-configured', args: { name: prov.name || prov.displayName || prov.id, id: prov.id } };
    }
    /* 停用是**本机**开关（sk_off_<kid>），不在注册表里也不在密钥白名单里：
       各页下拉按它过滤，所以递进来的平台本不该是被停用的那一家；助手能查得到它，就得照实拦。 */
    if (A && A.isOff && A.isOff(prov)) return { code: 'provider-off', args: { name: prov.name || prov.displayName || prov.id } };
    const model = pickModel(prov, I.model);
    if (!model || !model.id) {
      return { code: 'no-model', args: { ref: String(I.model && (I.model.id || I.model) || ''), id: prov.id,
        ids: (prov.models || []).map(x => x && x.id).filter(Boolean) } };
    }
    const prompt = String(I.prompt == null ? '' : I.prompt).trim();
    if (!prompt) return { code: 'empty-prompt', args: { kind } };

    if (I.params) {
      for (const [k, v] of Object.entries(I.params)) {
        const c = checkParam(model, k, v);
        if (c.错) return { code: 'param-value', args: Object.assign({ modelId: model.id }, c.错) };
      }
    }

    /* 语音这一路到这就判完：方式（定音色缺的那一样）+ 字数上下限，都没有槽位与扩展字段的事。 */
    if (kind === 'audio') {
      const t = I.tts || null;
      if (t && window.TtsAdv && window.TtsAdv.wayWhy) {
        const ww = window.TtsAdv.wayWhy({ mode: t.mode }, { design: t.design || '', ref: t.ref });
        if (ww) return { code: 'tts-way', args: { mode: t.mode || '', why: ww } };
      }
      if (window.CharLimits && window.CharLimits.why) {
        const lw = window.CharLimits.why(prompt, window.CharLimits.tts((prov && prov.tts) || {}));
        if (lw) return { code: 'char-limits', args: { why: lw } };
      }
      return null;
    }

    const mats = materials(I);
    const gaps = gapsFor(model, I.combo, countsOf(mats));
    /* 先后顺序照助手原来那一条链（它更长）：不接受的槽位 → 互斥成对 → 单项来源/形状 → 数量上下限
       → 体积/类型 → 扩展字段 → 序号漂移。同一步里两侧措辞不同，但**结论码**只有一个。 */
    if (gaps.rejected.length) {
      return { code: 'slot-shape', args: { why: 'rejected', modelId: model.id, rejected: gaps.rejected,
        declared: gaps.declared, lines: gaps.lines } };
    }
    if (gaps.conflicts.length) {
      return { code: 'slot-pairs', args: { modelId: model.id, conflicts: gaps.conflicts, lines: gaps.lines } };
    }
    /* 「提交形状」这一条只对**按条目**递进来的调用方判（助手）：它每条素材都要落进模板里。
       页面按槽位计数递进来，是因为它自己有不走模板的出路（`buildInputEntries` 没模板就转成 data URL 直发），
       在这里替它判等于凭空多拦一道 —— 体积与文件类型两条同理：页面没递 bytes/mime，本来就不适用。 */
    const perItem = Array.isArray(I.materials);
    for (const m of mats) {
      if (!m.source) return { code: 'slot-source', args: { i: m.i, role: m.role } };
      if (perItem && A && A.inputTemplate && !A.inputTemplate(prov, m.role)) {
        return { code: 'slot-template', args: { i: m.i, role: m.role } };
      }
    }
    if (gaps.over.length) {
      return { code: 'slot-shape', args: { why: 'over', modelId: model.id, over: gaps.over,
        declared: gaps.declared, lines: gaps.lines } };
    }
    if (gaps.missing.length) {
      return { code: 'slot-shape', args: { why: 'missing', modelId: model.id, missing: gaps.missing,
        declared: gaps.declared, lines: gaps.lines } };
    }
    const C = caps();
    for (const m of mats) {
      if (!C || !C.rule || !m.role) continue;
      const r = C.rule(model, m.role, I.combo) || {};
      if (r.maxBytes && m.bytes != null && m.bytes > r.maxBytes) {
        return { code: 'slot-bytes', args: { i: m.i, role: m.role, name: m.name, bytes: m.bytes, maxBytes: r.maxBytes } };
      }
      if (r.accept && m.mime) {
        const allow = String(r.accept).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
        if (allow.length && !allow.some(x => x === m.mime || (x.endsWith('/*') && m.mime.startsWith(x.slice(0, -2))))) {
          return { code: 'slot-accept', args: { i: m.i, role: m.role, name: m.name, mime: m.mime, accept: r.accept } };
        }
      }
    }
    const bad = Array.isArray(I.extrasBad) ? I.extrasBad : [];
    if (bad.length) return { code: 'shape-field', args: { why: String(bad[0] || ''), count: bad.length } };
    const drift = driftOf(I);
    if (drift.length) return { code: 'attachment-drift', args: { list: drift } };
    return null;
  }

  window.GenRules = {
    CODES, STD, whyNot, checkParam,
    /* 形状差集也挂出去：黄条那一行与提交前那一句必须读同一份（页面自己再算一遍就是第二份判据）。 */
    gaps: gapsFor,
    /* 参数取值这一条给助手复用：查完判据还要拿**归一化后的值**（768 → '768p' 那种）。 */
    paramZhKey(key) { return STD[key] || key; },
  };
})();
