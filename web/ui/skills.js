/* Skill 客户端：清单 / 全文 / 安装 / 启停 / 删除 / 导出 / 按页面与触发词匹配。
   服务端解析与写盘只在 server/skills-store.js；这里不复制 frontmatter 规则。
   页面与助手都只读这一份缓存（30 秒），改动后调 invalidate()。 */
(function () {
  'use strict';
  var cache = null, cacheAt = 0, pending = null, gen = 0;
  var TTL = 30000;

  /* gen 是「缓存代次」：invalidate() 之后，改前发出、改后才回来的那次请求不许再写缓存
     （update → invalidate → prime 会立刻发一次，旧响应若晚到就把改前的清单盖回去）。
     force 也不复用 pending —— 要的就是重新问一次服务器。 */
  function invalidate() { cache = null; cacheAt = 0; pending = null; gen++; }

  async function list(force) {
    if (!force && cache && Date.now() - cacheAt < TTL) return cache;
    if (pending && !force) return pending;
    var g = gen;
    var p = (async function () {
      try {
        var d = await window.Net.json('/skills', { timeout: 15000, retry: 1 });
        var items = Array.isArray(d && d.items) ? d.items : [];
        if (g === gen) { cache = items; cacheAt = Date.now(); }
        return items;
      } finally { if (pending === p) pending = null; }
    })();
    if (g === gen) pending = p;
    return p;
  }

  async function full(id) {
    if (!id) throw new Error('没有指定 Skill');
    var d = await window.Net.json('/skills/' + encodeURIComponent(id), { timeout: 15000, retry: 1 });
    if (!d || !d.skill) throw new Error('没有这个 Skill：' + id);
    d.skill.contentHash = String(d.hash || '');
    return d.skill;
  }

  async function readFile(id, file) {
    var q = '/skills/' + encodeURIComponent(id) + '/read?file=' + encodeURIComponent(file || '');
    var d = await window.Net.json(q, { timeout: 15000, retry: 1 });
    return String((d && d.text) || '');
  }

  async function files(id) {
    var d = await window.Net.json('/skills/' + encodeURIComponent(id) + '/files', { timeout: 15000, retry: 1 });
    return { files: Array.isArray(d && d.files) ? d.files : [], hash: String((d && d.hash) || '') };
  }

  async function update(id, nextFiles, expectedHash) {
    var d = await window.Net.json('/skills/' + encodeURIComponent(id) + '/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, retry: 0,
      body: JSON.stringify({ files: nextFiles || [], expectedHash: expectedHash || '' }),
    });
    invalidate();
    prime();
    return d;
  }

  async function importBundle(nextFiles, opts) {
    var d = await window.Net.json('/skills/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, retry: 0,
      body: JSON.stringify({ files: nextFiles || [], enable: !opts || opts.enable !== false }),
    });
    invalidate();
    prime();
    return d || {};
  }

  async function install(files, opts) {
    var d = await window.Net.json('/skills/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, retry: 0,
      body: JSON.stringify({ files: files || [], enable: !opts || opts.enable !== false }),
    });
    invalidate();
    prime();
    return d || {};
  }

  async function setEnabled(id, on) {
    var d = await window.Net.json('/skills/' + encodeURIComponent(id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, retry: 0,
      body: JSON.stringify({ enabled: !!on }),
    });
    invalidate();
    prime();
    return d;
  }

  async function remove(id) {
    var d = await window.Net.json('/skills/' + encodeURIComponent(id), { method: 'DELETE', retry: 0 });
    invalidate();
    prime();
    return d;
  }

  /* 把「已启用的那几份 Skill 正文」按 contract 放进 window.__skillBodies。
     TextAI 是同步取提示词的（润色那一刻已经要发请求了），所以正文必须提前备好；
     取不到就保持上一份 / 空表，defaultPrompt 会退回内置 DEF（两者内容同源）。 */
  async function prime() {
    try {
      var items = await list(true);
      var out = {};
      for (var i = 0; i < items.length; i++) {
        var s = items[i];
        if (!s || !s.enabled || !s.contract || s.conflict) continue;
        try { var f = await full(s.id); if (f && f.body) out[s.contract] = String(f.body); } catch (e) {}
      }
      window.__skillBodies = out;
      return out;
    } catch (e) { return window.__skillBodies || {}; }
  }

  /* 「导出」这条整族删掉了：Skill 不再往外发文件（服务端那条 /skills/:id/export 也一并删了）。
     要留一份内容就用设置页的「编辑正文」把它拷走。 */
  /* 页面 + 触发词匹配：enabled、页面在 pages 里（或没写 pages），且正文里有一个触发词。
     返回按触发词命中数排序的元数据；真正加载全文由 activeFor 做。 */
  function match(items, page, text) {
    var pageFile = String(page || '');
    var body = String(text || '');
    var out = [];
    (Array.isArray(items) ? items : []).forEach(function (s) {
      if (!s || s.enabled === false || s.conflict) return;
      var pages = Array.isArray(s.pages) ? s.pages : [];
      if (pages.length && pageFile && pages.indexOf(pageFile) < 0 && pages.indexOf('*') < 0) return;
      var trig = Array.isArray(s.triggers) ? s.triggers : [];
      var hits = trig.filter(function (t) { return t && body.indexOf(t) >= 0; }).length;
      if (!hits) return;
      out.push({ item: s, hits: hits });
    });
    out.sort(function (a, b) { return b.hits - a.hits; });
    return out.map(function (x) { return x.item; });
  }

  /* 中文按 1 token/字、ASCII 按 4 字符/token 估：宁可保守（少带一点），也不要让提示词超预算。
     正文合计超过 SKILL_BUDGET 时按顺序截断，并在截断的那份上写清楚「只带了前 N 字」。 */
  function estTokens(s) {
    var t = String(s || '');
    var cjk = (t.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    return cjk + Math.ceil((t.length - cjk) / 4);
  }
  var SKILL_BUDGET = 2000;
  /* 预算拆两份额度：预载那份走系统提示词（最多 2 份，SKILL_BUDGET 是它的 token 总闸）；
     回合内按需读的走工具结果，另有 ON_DEMAND_BUDGET —— 不拆的话预载两份就把额度占满，
     助手自己选的那份根本拿不到预算。 */
  var ON_DEMAND_BUDGET = 1000;

  /* 助手一轮用哪几份：最多两份、一份 contract 只取第一个。加载失败的那份跳过并返回原因。
     opts.pinned = 用户点名钉死的那几个 id —— **指定优先、自动补位**（只钉一份 → 第二份按
     触发词自动补；钉了两份就都不换 —— 给「我不喜欢它自己选」留一档）。
     返回的 body 已经是**预算内**的正文（不是原始全文）；truncated/truncatedChars 供界面与回合记录明示。 */
  async function activeFor(page, text, opts) {
    var items = await list();
    var pinned = [];
    var pinSeen = {};
    (Array.isArray(opts && opts.pinned) ? opts.pinned : []).forEach(function (id) {
      var k = String(id || '');
      if (k && !pinSeen[k]) { pinSeen[k] = 1; pinned.push(k); }
    });
    var picked = [];
    var usedIds = {};
    /* 指定优先：钉死的那几个先占名额（不再按触发词排序） */
    for (var p = 0; p < pinned.length && picked.length < 2; p++) {
      var pm = null;
      for (var q0 = 0; q0 < items.length; q0++) { if (items[q0].id === pinned[p]) { pm = items[q0]; break; } }
      if (pm && !usedIds[pm.id]) { picked.push(pm); usedIds[pm.id] = 1; }
    }
    /* 自动补位：剩余名额按触发词命中顺序补 */
    var auto = match(items, page, text);
    for (var ak = 0; ak < auto.length && picked.length < 2; ak++) {
      if (!usedIds[auto[ak].id]) { picked.push(auto[ak]); usedIds[auto[ak].id] = 1; }
    }
    var usedContracts = {};
    var out = [];
    for (var i = 0; i < picked.length; i++) {
      var m = picked[i];
      if (m.contract && usedContracts[m.contract]) continue;
      try {
        var s = await full(m.id);
        if (!s.enabled) continue;
        if (s.contract && usedContracts[s.contract]) continue;
        if (s.contract) usedContracts[s.contract] = true;
        var body = String(s.body || '');
        out.push({ id: s.id, name: s.name || s.id, description: s.description || '',
          contract: s.contract || '', body: body, version: s.version || 1, source: s.source || '',
          contentHash: s.contentHash || '', truncated: false, truncatedChars: 0, chars: body.length, tokens: 0 });
      } catch (e) { /* 单份读不出来不影响这一轮；索引里仍然列着它 */ }
    }
    var budget = Math.max(200, Number(opts && opts.budget) || SKILL_BUDGET);
    var used = 0;
    for (var j = 0; j < out.length; j++) {
      var it = out[j];
      var tk = estTokens(it.body);
      var room = Math.max(0, budget - used);
      if (tk > room) {
        var keep = room > 0 ? Math.max(0, Math.floor(it.body.length * room / tk)) : 0;
        it.truncated = true;
        it.truncatedChars = keep;
        it.body = it.body.slice(0, keep);
        tk = estTokens(it.body);
      }
      it.tokens = tk;
      used += tk;
    }
    return out;
  }

  /* 「素材范围优先」：一份 Skill 声明「这个项目优先用哪几个素材组」。
     读法只有这一处：取**已启用的**那些 Skill 里声明的（停用的不参与 ——
     停用一份 Skill 就是不想用它那套写法）。
     返回 { assetGroups: [...] }：合并所有声明的组名（去重、按名排）。
     ⚠ 这**不是**「项目引用规则」：项目引用规则指的是**正文里的变量占位符**
     （`{cast}` `{what}` `{board}` …），由 `window.TplVars` 那一族填料 ——
     变量名在 Skill 正文里，不在 frontmatter 里。 */
  async function refRule() {
    let items = [];
    try { items = await list(); } catch (e) { return { assetGroups: [] }; }
    const on = (items || []).filter(s => s && s.enabled !== false && !s.conflict);
    const groups = [];
    const seen = new Set();
    on.forEach(s => {
      (Array.isArray(s.assetGroups) ? s.assetGroups : []).forEach(g => {
        const t = String(g || '').trim();
        if (!t) return;
        const k = t.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        groups.push(t);
      });
    });
    return { assetGroups: groups };
  }

  window.WbSkills = { list: list, full: full, readFile: readFile, files: files,
    install: install, importBundle: importBundle, update: update, setEnabled: setEnabled,
    remove: remove,
    match: match, activeFor: activeFor, refRule: refRule,
    estTokens: estTokens, ON_DEMAND_BUDGET: ON_DEMAND_BUDGET };
  window.__skillBodies = window.__skillBodies || {};
  /* shell 里紧跟 ui.js 加载；不抢首屏，但要在第一次润色之前把正文备好。 */
  setTimeout(function () { prime(); }, 700);
})();
