/* 拆分镜的「新素材」：AI 判定哪些**会重复出现**的角色 / 场景 / 物品要建档并出图，
   以及它们在提示词里怎么被引用（占位符 → 真名）。

   从 web/director/engine.js 拆出；纯算法在这里，engine 只调用。

   这一族的判据（谁算「重复出现」、名字怎么归一、占位符怎么写、怎么变成引用）
   全在这里，engine 不再自己排一遍 —— 拆镜那一路本来就有好几处要认这个名字
   （写提示词、挂参考图、出图后回填），各认一次迟早对不上。

   三个角色：
     · plan     —— 判定：AI 说的那批「该新建的」里，哪几个真该建（重复出现的才算），
                    以及每个要建到什么程度（出图？绑音色描述？）。
     · token    —— 占位符词法：`@待建:小雅` 怎么认、怎么换成 `@小雅`。
     · libSpec  —— 建档时要写进素材库的那一份（类型、组名、外貌、音色描述）。 */
import { reEscape } from './util.js';

export function createBoardAssets(ctx) {
  const { nameKey, MIN_REPEAT, PREFIX } = ctx;

  /* 一个名字在这次拆分结果里出现了几次 —— 「会重复出现」的判据是**程序数一遍**，
     不是全信 AI（AI 常常把只出现一次的路人也报成「主要角色」）。

     **最长优先**是这里的关键：中文没有词边界，「小雅」与「小雅丽」都可能出现。
     简单的「名字后面跟的不是汉字」会把「小雅在门口」也判成不命中（后面是「在」），
     而放开门槛又会让「小雅丽」被算成「小雅」出现。
     所以先把这一批**所有候选名**按长度降序排，长的先从文本里吃掉，再数短的 ——
     「小雅丽」先占掉那处，「小雅」就只在自己真正出现的地方被数到。
     数的是**镜头正文与台词里**的名字出现次数。 */
  function repeatCounts(shots, names) {
    const cand = (names || []).map(n => String(n || '').trim()).filter(Boolean);
    /* 同名归一（近名合并），长的在前 */
    const seen = new Set();
    const uniq = [];
    cand.sort((a, b) => b.length - a.length).forEach(nm => {
      const k = nameKey(nm);
      if (!k || seen.has(k)) return;
      seen.add(k);
      uniq.push(nm);
    });
    const out = new Map();
    uniq.forEach(nm => out.set(nameKey(nm), 0));
    (shots || []).forEach(sh => {
      let hay = [String((sh && sh.prompt) || ''), String((sh && sh.line) || ''),
        String((sh && sh.lineWho) || ''), String((sh && sh.name) || '')].join('\n');
      uniq.forEach(nm => {
        const k = nameKey(nm);
        if (out.get(k) === undefined) return;
        const re = new RegExp(reEscape(nm), 'g');
        /* **按镜头数**，不是按文本里的出现次数：
           同一镜里正文出现一次、说话人又写一次，那是**一镜**（出现 2 次 ≠ 2 镜）。
           「会重复出现」说的是「在几个地方出现」—— 一镜里反复提同一个名字不算。 */
        if (re.test(hay)) out.set(k, out.get(k) + 1);
        re.lastIndex = 0;
        /* 长的先吃掉：把这一处从文本里抹掉，短的就不会再数到它。 */
        hay = hay.replace(new RegExp(reEscape(nm), 'g'), ' ');
      });
    });
    return out;
  }
  /* 只问一个名字的次数（没有候选名单时的用法）。 */
  function repeatCount(shots, name) {
    const m = repeatCounts(shots, [name]);
    return m.get(nameKey(name)) || 0;
  }
  /* 名字归一：AI 可能写「小雅」「小雅 」「Xiaoya」——按 nameKey 合并。
     返回 { name, key }；空名返回 null。 */
  function nameRefOf(name) {
    const nm = String(name || '').trim();
    if (!nm) return null;
    const k = nameKey(nm);
    return k ? { name: nm, key: k } : null;
  }

  /* AI 回的那批「要新建的」→ **真要建**的那批。
     三条规矩：
       ① 只出现一次的不建（用户要的是「会重复出现的角色或场景或物品」）；
       ② 名字必须**它自己给的清单里**有 —— AI 编的名字不建，并计数报出来；
       ③ 已经有同名的素材了就不建（那是「复用」，不是「新建」）。
     返回 { plan, skipped }：
       plan    —— 要建的 [{ name, key, kind, why, look, voice, count, repeat }]
       skipped —— [{ name, why }] 没建成的与原因（界面上要照实说，不静默丢）。 */
  function plan(aiList, shots, existing) {
    const out = [];
    const skipped = [];
    const exIdx = new Map();
    (existing || []).forEach(x => {
      const k = nameRefOf(x && x.name);
      if (k && !exIdx.has(k.key)) exIdx.set(k.key, x);
    });
    /* 出现次数**一次算完**（最长优先那一层需要看到全部候选名），
       不能一个一个问 —— 那样「小雅」会把「小雅丽」那处也数进去。 */
    const names = (aiList || []).map(a => (a && typeof a === 'object') ? a.name : '').filter(Boolean);
    const counts = repeatCounts(shots, names);
    const seen = new Set();
    (aiList || []).forEach(a => {
      if (!a || typeof a !== 'object') { skipped.push({ name: '', why: '这一条不是对象' }); return; }
      const kk = nameRefOf(a.name);
      if (!kk) { skipped.push({ name: '', why: '没有名字' }); return; }
      if (seen.has(kk.key)) { skipped.push({ name: kk.name, why: '清单里重复了' }); return; }
      seen.add(kk.key);
      const n = counts.get(kk.key) || 0;
      if (n < MIN_REPEAT) {
        skipped.push({ name: kk.name, why: '只出现 ' + n + ' 次（重复出现才建）' });
        return;
      }
      if (exIdx.has(kk.key)) {
        skipped.push({ name: kk.name, why: '素材库里已经有同名的了（直接引用它）' });
        return;
      }
      out.push({
        name: kk.name, key: kk.key,
        kind: castKind(a.kind),
        why: String(a.why || '').trim(),
        look: String(a.look || a.desc || '').trim(),
        voice: String(a.voice || a.voiceNote || '').trim(),
        count: n,
      });
    });
    return { plan: out, skipped };
  }

  /* 类型：只认三种（角色 / 场景 / 物品）。认不出来的当角色 ——
     角色是那一类里最常见的，而「当成道具」会让它没有音色。 */
  function castKind(k) {
    const s = String(k == null ? '' : k).trim().toLowerCase();
    if (s === 'scene' || s === '场景' || s === 'location') return 'scene';
    if (s === 'prop' || s === '物品' || s === '道具' || s === 'thing' || s === 'object') return 'prop';
    return 'actor';
  }

  /* 占位符词法：
       写进提示词时用 `@待建:小雅`（PREFIX + ':' + 名字）——
       素材还没出图，引用它没有可挂的图，占位符让「这里本该有个小雅」在正文里看得见；
       素材出图后换成 `@小雅`（真名），于是那一条的参考图能挂上。
     `isToken` 认一个 token 是不是占位符；`parse` 把它拆成名字。 */
  const tokenRe = new RegExp('@' + reEscape(PREFIX) + ':([^\\s@，,。.、；;：:！!？?()（）\\[\\]【】"\'“”《》]+)', 'g');
  function isToken(text) {
    const s = String(text || '');
    tokenRe.lastIndex = 0;
    return tokenRe.test(s);
  }
  function parse(text) {
    const s = String(text || '');
    const out = [];
    tokenRe.lastIndex = 0;
    let m;
    while ((m = tokenRe.exec(s)) !== null) {
      const nm = String(m[1] || '').trim();
      if (nm) out.push(nm);
    }
    return out;
  }
  /* 把占位符换成真名（出图后回填时用）。只换**占位符本身**，正文一个字不动。 */
  function resolve(text, name, realName) {
    const nm = String(name || '').trim();
    if (!nm) return String(text || '');
    const re = new RegExp('@' + reEscape(PREFIX) + ':' + reEscape(nm) + '(?![\\u3400-\\u9fffA-Za-z0-9])', 'g');
    return String(text || '').replace(re, '@' + String(realName || nm));
  }
  /* 这个镜头里有哪些待建素材（按出现顺序，去重）。 */
  function pendingIn(text) {
    const seen = new Set();
    const out = [];
    parse(text).forEach(nm => {
      const k = nameKey(nm);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(nm);
    });
    return out;
  }

  /* 全片里哪些镜头**引用了**这个待建素材（占位符还在的那些）。
     素材出图后要把图补进这些镜头 —— 先在这里把「哪几镜要补」认出来，
     别到那时满屏扫一遍（工程大了就是几百个镜头）。 */
  function shotsPending(shots, name) {
    const nm = String(name || '').trim();
    if (!nm) return [];
    const out = [];
    (shots || []).forEach(sh => {
      if (!sh) return;
      if (pendingIn(String(sh.prompt || '')).some(x => nameKey(x) === nameKey(nm))) out.push(sh);
    });
    return out;
  }

  /* 建档要写进素材库的那一份（组名 = 项目组名）。
     `group` 为空串 = 落到未分组（调用方要在界面上说明）。
     音色描述存进 `voiceNote`（全站只有这一个字段描述音色）。 */
  function libSpec(item, groupName) {
    const g = String(groupName || '').trim();
    const base = {
      name: item.name,
      group: g,
      bio: item.why || '',
    };
    if (item.kind === 'scene') return Object.assign(base, { kind: 'scene', desc: item.look || item.why || '', time: '' });
    if (item.kind === 'prop') return Object.assign(base, { kind: 'prop', look: item.look || '', face: '' });
    return Object.assign(base, {
      kind: 'actor', look: item.look || '',
      voiceNote: item.voice || '', voiceMode: item.voice ? 'design' : '',
      voiceBy: item.voice ? 'ai' : '',
    });
  }

  /* 问文字 AI「这份方案里哪些主体该新建」。
     指令正文来自 Skill（contract `board_assets.json`）—— 判据是**声明**的，不写死在代码里
     （与用户「增加完善决定是否生成相应素材以及生成素材等各种 skill」的诉求一致）。
     问失败**往上抛**：怎么办是调用方的政策，这一层只负责契约。
     返回 { raw, plan, skipped } —— raw 是 AI 原样回的那批（审查弹窗要显示它）。 */
  async function stage(ctx2) {
    const c = ctx2 || {};
    const reg = c.reg, shots = c.shots || [], existing = c.existing || [];
    const sys = c.sys || '';
    const text = c.text || '';
    if (!String(text).trim()) return { raw: [], plan: [], skipped: [] };
    const chat = c.TextAI && c.TextAI.chat;
    if (!chat) return { raw: [], plan: [], skipped: [] };
    /* 这一处能不能联网由调用方按「导演台拆分镜」那一档开关给；没给就是纯本地判定。 */
    const opts = c.search ? { search: c.search } : {};
    const j = c.parseJsonLoose ? c.parseJsonLoose(await chat(reg, sys, text, opts)) : null;
    const raw = (j && (j.newAssets || j.assets || j.new)) || [];
    const r = plan(Array.isArray(raw) ? raw : [], shots, existing);
    return { raw: Array.isArray(raw) ? raw : [], plan: r.plan, skipped: r.skipped };
  }

  return { plan, stage, repeatCount, repeatCounts, nameRefOf, castKind, isToken, parse, resolve, pendingIn, shotsPending, libSpec };
}
