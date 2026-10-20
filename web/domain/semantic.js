/* 轻量本地语义检索（全站一份）。
   目标不是替代向量库，而是把「中文近义 / 多词 / 备注 / 台词」从 substring 提升到可用的排序：
     · 中文按 bigram（雨天/天台）切，英文按词；
     · 标题 / 备注 / 提示词 / 台词 / 类型 / 平台 / 型号分别加权；
     · 原文整句命中额外加分，时间只做很轻的 tie-break。
   返回 { item, score, why }，调用方自己决定画什么、要不要再交给文字 AI 重排。 */
(function () {
  const STOP = new Set(['的', '了', '和', '与', '及', '在', '是', '有', '把', '被', '这', '那', '一', '个', '请', '帮', '我', '找', '一下', '哪些', '什么']);
  const CJK = /[\u3400-\u9fff]/;
  const norm = s => String(s == null ? '' : s).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

  function tokens(s) {
    const n = norm(s);
    if (!n) return [];
    const out = [];
    const seen = new Set();
    const add = t => { if (t && !STOP.has(t) && !seen.has(t)) { seen.add(t); out.push(t); } };
    for (const w of n.split(' ')) {
      if (!w) continue;
      if (CJK.test(w)) {
        /* 中文：整段 + 相邻两字；单字只在整段只有一个字时留 */
        if (w.length === 1) add(w);
        else { for (let i = 0; i < w.length - 1; i++) add(w.slice(i, i + 2)); add(w); }
      } else add(w);
    }
    return out;
  }

  const FIELDS = [
    ['title', 4.0], ['name', 4.0],
    ['note', 3.2], ['desc', 2.4], ['bio', 2.0], ['look', 2.0],
    ['prompt', 2.2], ['transcript', 2.2], ['text', 2.0],
    ['group', 1.6], ['type', 1.2], ['providerName', 1.2], ['provider', 1.0], ['model', 1.4],
    ['tags', 1.8], ['voice', 1.2], ['kind', 1.0],
  ];
  const fieldText = (it, k) => {
    const v = it && it[k];
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(x => (x && (x.name || x.label || x.id)) || x).join(' ');
    return typeof v === 'object' ? '' : String(v);
  };
  const fullText = it => FIELDS.map(([k]) => fieldText(it, k)).filter(Boolean).join(' \n ');

  function rank(items, query, opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(200, Number(o.limit) || 20));
    const list = Array.isArray(items) ? items : [];
    const qn = norm(query);
    if (!qn) return list.slice(0, limit).map(item => ({ item, score: 0, why: '未输入关键词' }));
    const qt = tokens(qn);
    if (!qt.length) return list.slice(0, limit).map(item => ({ item, score: 0, why: '未输入关键词' }));
    const qtSet = new Set(qt);
    const scored = [];
    for (const item of list) {
      let score = 0;
      const hitFields = [];
      const hitTerms = new Set();
      let bestField = '';
      for (const [k, w] of FIELDS) {
        const t = norm(fieldText(item, k));
        if (!t) continue;
        let fscore = 0;
        for (const term of qtSet) {
          if (t.includes(term)) { fscore += w; hitTerms.add(term); }
        }
        /* 整句原文命中：比 zero散命中强，避免「雨天」与「天台」各中一个却排在真正那句前面 */
        if (t.includes(qn)) fscore += 6;
        if (fscore > 0) { score += fscore; hitFields.push(k); if (!bestField) bestField = k; }
      }
      if (!score) continue;
      /* 覆盖度：命中的 query token 比例越高越可信；只中一个词的长 query 要降权 */
      const cover = hitTerms.size / Math.max(1, qtSet.size);
      score *= (0.55 + 0.45 * cover);
      /* 时间只做同分附近的 tie-break，不让新条目压过准确匹配 */
      const ts = Number(item.ts || item.at || 0);
      if (ts > 0) score += Math.min(0.6, Math.max(0, (ts - 1e12) / 1e15));
      scored.push({
        item,
        score: Math.round(score * 1000) / 1000,
        why: '命中：' + [...hitTerms].slice(0, 8).join('、') + (hitFields.length ? '（' + hitFields.slice(0, 3).join('/') + '）' : ''),
      });
    }
    /* 一个词都没命中时退一档：中文按单字找交集（「追人」→「追逐戏」至少能碰到「追」），
       只给很低的分数并标明是弱匹配。它只用于兜底，不会挤掉正常命中。 */
    if (!scored.length) {
      const chars = [...new Set([...qn].filter(ch => CJK.test(ch) && !STOP.has(ch)))];
      if (chars.length) {
        for (const item of list) {
          const t = norm(fullText(item));
          let n = 0;
          for (const ch of chars) if (t.includes(ch)) n++;
          const need = chars.length >= 2 ? 2 : 1;   // 两字以上至少中两字，避免单字把整库都捞出来
          if (n < need) continue;
          const cov = n / chars.length;
          scored.push({ item, score: Math.round(cov * 80) / 100, why: '弱匹配：' + chars.filter(ch => t.includes(ch)).join('、') });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score || (Number(b.item.ts || 0) - Number(a.item.ts || 0)));
    return scored.slice(0, limit);
  }

  window.SemanticSearch = { norm, tokens, rank, fullText };
})();
