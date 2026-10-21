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
    return d && d.skill;
  }

  async function install(files, opts) {
    var d = await window.Net.json('/skills/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, retry: 0,
      body: JSON.stringify({ files: files || [], enable: !opts || opts.enable !== false }),
    });
    invalidate();
    prime();
    return d && d.skill;
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

  async function exportOne(id) {
    var d = await window.Net.json('/skills/' + encodeURIComponent(id) + '/export', { timeout: 15000, retry: 0 });
    return d || { files: [] };
  }

  /* 旧版设置页手改过的 sk_polish_<kind> → 用户 Skill（.skills/legacy-<kind>）。
     迁移成功才删旧键；装不上就原样留着并报出来，绝不半途丢掉用户的文字。 */
  var KIND_CONTRACT = {
    video: 'polish.video', img: 'polish.image', audio: 'polish.voice', follow: 'polish.follow',
    story: 'story.json', split: 'split.json', board_edit: 'board_edit.json', img_split: 'img_split.json',
    char_image: 'char.image.json', char_voice: 'char.voice.json',
  };
  var ALL_PAGES = ['director.html', 'studio.html', 'chars.html', 'assets.html', 'favorites.html', 'settings.html', 'usage.html'];
  async function migrateLegacyPrompts() {
    var TA = window.TextAI;
    if (!TA || !TA.PROMPTS) return { moved: 0, skipped: ['文字 AI 模块没加载'] };
    var moved = 0, skipped = [];
    var groups = TA.PROMPTS || [];
    for (var gi = 0; gi < groups.length; gi++) {
      var items = (groups[gi] && groups[gi].items) || [];
      for (var ii = 0; ii < items.length; ii++) {
        var it = items[ii];
        var key = TA.promptKey(it.key);
        var text = '';
        try { text = localStorage.getItem(key) || ''; } catch (e) { text = ''; }
        if (!text.trim()) continue;
        var contract = KIND_CONTRACT[it.key];
        if (!contract) { skipped.push(it.key); continue; }
        var id = 'legacy-' + String(it.key).replace(/_/g, '-');
        var fm = '---\nid: ' + id + '\nname: 旧版：' + String(it.label || it.key).replace(/[\r\n]/g, ' ')
          + '\ndescription: 从旧版设置页迁移的手改提示词\ntriggers: []\npages: [' + ALL_PAGES.join(', ')
          + ']\ncontract: ' + contract + '\nversion: 1\n---\n\n' + text + '\n';
        try {
          await install([{ path: 'SKILL.md', text: fm }], { enable: true });
          try { localStorage.removeItem(key); } catch (e) {}
          moved++;
        } catch (e) { skipped.push(it.key + '（' + errText(e) + '）'); }
      }
    }
    if (moved) { invalidate(); await prime(); }
    return { moved: moved, skipped: skipped };
  }

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
  var SKILL_BUDGET = 3000;

  /* 助手一轮用哪几份：最多两份、一份 contract 只取第一个。加载失败的那份跳过并返回原因。
     返回的 body 已经是**预算内**的正文（不是原始全文）；truncated/truncatedChars 供界面与回合记录明示。 */
  async function activeFor(page, text, opts) {
    var items = await list();
    var picked = match(items, page, text).slice(0, 2);
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
    remove: remove, exportOne: exportOne, migrateLegacyPrompts: migrateLegacyPrompts,
    match: match, activeFor: activeFor, prime: prime, invalidate: invalidate, refRule: refRule, TTL: TTL };
  window.__skillBodies = window.__skillBodies || {};
  /* shell 里紧跟 ui.js 加载；不抢首屏，但要在第一次润色之前把正文备好。 */
  setTimeout(function () { prime(); }, 700);
})();
