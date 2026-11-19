/* 分镜结构化纯函数：快照 / 给 AI 的清单 / 统一格式解析与唯一落盘点 / 新短片命名判据。
   从 web/director/engine.js 拆出；镜头工厂、时长夹取、场景图与状态判据由 createBoardTools 注入。 */
import { ctxClip, BOARD_CTX_PROMPT } from './util.js';
import { defaultTakeOf, setShotPrompt, takeStatusZh } from './takes.js';

/* ---------- 新短片的「没动过」判据（拆分镜自动命名的三件套） ----------
   全是**默认值**比对，不近似、不猜：动过一格就不算没动过。
   · isUntouchedShot    新建镜头的占位（名「新镜头」、单条空 draft、无任何素材与台词）
   · isDefaultSceneName 「场景 1」这一族默认场名
   · isDefaultProjName  「未命名短片 / 未命名短片 2」这一族默认片名（空名也算未命名） */
export function isUntouchedShot(sh) {
  if (!sh || typeof sh !== 'object') return false;
  if (String(sh.name || '') !== '新镜头') return false;
  if (Number(sh.draw) !== 1) return false;
  if (String(sh.line || '').trim() || String(sh.lineWho || '').trim() || String(sh.note || '').trim()) return false;
  const cands = Array.isArray(sh.candidates) ? sh.candidates : [];
  if (cands.length !== 1) return false;
  const c = cands[0];
  if (!c || c.status !== 'draft') return false;
  if (String(c.prompt == null ? '' : c.prompt).trim()) return false;
  if ((Array.isArray(c.refImages) && c.refImages.some(Boolean))
    || (Array.isArray(c.keyframes) && c.keyframes.some(k => k && k.assetId && !k.deleted))
    || c.refVideo || c.refAudio || c.firstFrame || c.lastFrame || c.linkPrev) return false;
  return true;
}
export const isDefaultSceneName = n => /^场景\s*\d+$/.test(String(n == null ? '' : n).trim());
export const isDefaultProjName = n => !String(n == null ? '' : n).trim()
  || /^未命名短片(\s*\d+)?$/.test(String(n == null ? '' : n).trim());

/* 「AI 说的图N」翻成随附素材表里的下标，全站只有这一处（拆分镜三档共用）。
   raw 收数组或「图1、图3」这类串；只认 1 ≤ N ≤ 随附素材张数，编造 / 越界的进 unknown
   照实报数 —— 静默吞掉会让用户以为 AI 看到了没附上的图。 */
export function picsIdxOf(raw, pics) {
  const n = (pics || []).length;
  const arr = Array.isArray(raw) ? raw
    : (raw == null || raw === '' ? [] : String(raw).split(/[,，;；、\s]+/));
  const idxs = []; const unknown = [];
  arr.forEach(s => {
    const t = String(s == null ? '' : s).trim();
    if (!t) return;
    const m = /^图\s*(\d+)$/.exec(t);
    const i = m ? Number(m[1]) : 0;
    if (i >= 1 && i <= n) idxs.push(i - 1);
    else unknown.push(t);
  });
  return { idxs: [...new Set(idxs)], unknown };
}

/* 「AI 说的这一场」认回现有清单里的哪一场（接着往下拆的落盘归并只用这一份）。
   nameKey 精确优先；不中再剥**编号前缀**重比 —— AI 爱在现有场景名前加编号
   （用户实测：现有「xxx」，AI 回「场景1 xxx」），直接同名匹配就会另起一场。
   剥不动（没有前缀，或剥完与原名一样）就返回 null = 按新场景落。 */
const SCENE_NO_RE = /^\s*(?:(?:场景|scene)\s*[0-9一二三四五六七八九十百]+|第\s*[0-9一二三四五六七八九十百]+\s*场)\s*[:：、.\-·]?\s*/i;
export function matchSceneOf(name, scenes) {
  const raw = String(name == null ? '' : name).trim();
  const list = Array.isArray(scenes) ? scenes : [];
  const keyOf = window.nameKey || (s => String(s || '').trim());
  const k = keyOf(raw);
  if (!k) return null;
  const exact = list.find(sc => keyOf((sc && sc.name) || '') === k);
  if (exact) return exact;
  const stripped = raw.replace(SCENE_NO_RE, '').trim();
  if (!stripped || stripped === raw) return null;
  const k2 = keyOf(stripped);
  if (!k2 || k2 === k) return null;
  return list.find(sc => keyOf((sc && sc.name) || '') === k2) || null;
}

export function createBoardTools(ctx) {
  const { durWritable, nameKey, newShot, setShotDur, removeShot, uid, Wb, feedScenePics, clampShotDurations, bindShotPics } = ctx;

function snapBoard(scenes) {
  return (scenes || []).map((sc, si) => ({
    n: si + 1, sc, name: sc.name || ('场景 ' + (si + 1)),
    shots: (sc.shots || []).map((sh, hi) => {
      const cs = (sh.candidates || []).filter(Boolean);
      /* 这一镜的主描述落在**默认候选**身上（origin 'auto' 的那一条）：描述与配置都在候选上，
         镜头本身只留公共信息。 */
      const def = defaultTakeOf(sh);
      return {
      n: hi + 1, sh, name: sh.name || '',
      /* `ref` 是给 AI 的**稳定锚点**（s场-镜）：统一格式里改哪一镜、原样保留哪一镜都靠它认。
         只对 AI 那一次有效，解析时就翻成镜头 id（见 boardFullItemsOf）。 */
      ref: 's' + (si + 1) + '-' + (hi + 1),
      prompt: String((def && def.prompt) || '').trim(),
      dur: Number(def && def.dur) > 0 ? Number(def.dur) : 0,
      /* 接上一镜：AI 改稿时要看得见「这镜的首帧来自上一镜结尾」，否则它会把这条接续当成
         普通镜头改提示词，或者把已经接好的两镜拆开。 */
      chain: (def && def.linkPrev === 'tail') ? 'tail' : '',
      /* 已有参考素材：首尾帧与参考素材互斥，AI 要看得见这一镜已经有图 / 视频 / 音频，
         才不会把它改成接上一镜。画面切片与手动参考图同属参考图槽位（与 `shotUsedRoles` 同一口径）。 */
      refs: !!((def && Array.isArray(def.refImages) && def.refImages.some(Boolean))
        || (def && Array.isArray(def.keyframes) && def.keyframes.some(k => k && k.assetId && !k.deleted))
        || (def && def.refVideo) || (def && def.refAudio)),
      /* 候选镜头摘要（只读）：AI 改稿时看得见这一镜已经有哪几条候选、各自要什么，
         免得把同一条重造一遍或当作没有。只列前 4 条，其余报数量。 */
      takes: cs.slice(0, 4).map(c => ({ status: takeStatusZh(c),
        text: ctxClip(String(c.prompt == null ? '' : c.prompt).replace(/\s+/g, ' ').trim(), 60) })),
      takeMore: Math.max(0, cs.length - 4),
      };
    }),
  }));
}
/* 给 AI 的那段清单正文。单条提示词截到 300 字：几十条长提示词会把上下文撑爆，
   而 AI 只需要认得出「哪一条是哪一条」；真要改的那条用户会在要求里点名。
   末尾那个省略号是「后面还有字」的意思，两份截断（分镜清单 / 素材描述）共用 `ctxClip` 这一份写法。 */
function boardListText(snap) {
  const out = [];
  (snap || []).forEach(s => {
    out.push(`场景 ${s.n} · ${s.name}（${s.shots.length} 个镜头）`);
    if (!s.shots.length) out.push('  （这一场还没有镜头）');
    s.shots.forEach(t => {
      const nm = t.name && t.name !== ('镜头 ' + t.n) ? `「${t.name}」` : '';
      const body = t.prompt ? ctxClip(t.prompt, BOARD_CTX_PROMPT) : '（还没写）';
      const chain = t.chain === 'tail' ? ' · 接上一镜' : '';
      /* 已有参考素材：与「接上一镜」互斥，AI 改稿时要看得见（见 snapBoard 的 refs）。 */
      const refs = t.refs ? ' · 有参考素材' : '';
      /* 已有候选（只读）：让人工智能看得见这一镜已经有哪几条候选、各自要什么，
         免得把同一条重造一遍。候选各自的描述加引号；超过 4 条只报数量。 */
      const takes = (Array.isArray(t.takes) && t.takes.length)
        ? ' · 已有候选 ' + t.takes.map((c, i) => '候选 ' + (i + 1) + '（' + c.status + '）'
          + (c.text ? '「' + c.text + '」' : '（还没写）')).join('、')
          + (t.takeMore ? '，另 ' + t.takeMore + ' 条未列' : '')
        : '';
      out.push(`  镜头 ${t.ref}${nm}（${t.dur ? t.dur + ' 秒' : '时长未定'}${chain}${refs}）：${body}${takes}`);
    });
  });
  return out.join('\n');
}
/* 统一格式解析：AI 回的那份完整镜头清单 → 审查行。
   输入 `j` = {"title","scenes":[{"name","shots":[{"ref","prompt","duration","name","note","chain","pics"]}]}]}；
   `snap` 是 snapBoard 那份带 `ref` 的快照，`pics` 是这次随附的**图片**表（图N → 下标）。
   每行当场把 ref 翻成镜头 id（shotId / sceneId）—— 审查弹窗里用户能改能删，落盘只认 id。
   返回 {items, skipped, unknownRefs, updN, addN, kept, title}：
     · ref 认得上的行是「改这一镜」（updN）；没带 ref 的行是「新增」（addN）；
     · `kept` = 现有镜头里没被任何 ref 提到的条数 —— 落盘时它们**原样保留**（统一格式不做删除，
       想删在左栏删；这样 AI 漏抄几条也不会误删用户已生成的内容），sub 里要报数；
     · 对不上号的 ref 照实计数（unknownRefs），那一行按新镜头处理。
   ⚠ 不 clamp 时长、不设镜数上限：AI 给多少列多少，秒数原样带，
   越界由落盘后的 `clampShotDurations` 按这一镜自己的型号夹回去并报数。
   **首尾帧与参考图互斥**：`chain:"tail"` 的行不挂图，图号进 `picChain` 报数；
   ref 行已有参考素材时不再改成接续（链上已有素材的镜头改接续会丢素材），落盘那一步拒并计数。 */
function boardFullItemsOf(j, snap, pics) {
  const canDur = durWritable();
  const rawSec = v => {
    if (!canDur) return null;
    const x = Number(v == null || v === '' ? null : v);
    return Number.isFinite(x) && x > 0 ? Math.round(x) : null;
  };
  /* ref → 「场行 + 镜行」。只认「s<场>-<镜>」这一种写法（AI 照清单抄的）；写成别的就当没带。 */
  const byRef = new Map();
  (snap || []).forEach(s => (s.shots || []).forEach(t => byRef.set(String(t.ref || '').toLowerCase(), { S: s, t })));
  const refAt = v => {
    const k = String(v == null ? '' : v).trim().toLowerCase();
    return /^s\d+-\d+$/.test(k) ? (byRef.get(k) || null) : null;
  };
  const items = []; let skipped = 0, unknownRefs = 0, updN = 0, addN = 0;
  const picChain = new Set();
  const seenRef = new Set();
  ((j && j.scenes) || []).forEach((sc, sci) => {
    const scName = String((sc && sc.name) || '').trim();
    ((sc && sc.shots) || []).forEach((s, shi) => {
      if (!s || typeof s !== 'object') { skipped++; return; }
      const hit = refAt(s.ref);
      const t = hit && hit.t;
      const text = String(s.prompt == null ? '' : s.prompt).trim();
      const note = String(s.note == null ? '' : s.note).trim();
      const nm = String(s.name == null ? '' : s.name).trim().slice(0, 12);
      const dur = rawSec(s.duration);
      const chain = String(s.chain == null ? '' : s.chain) === 'tail' ? 'tail' : '';
      /* 随附图：图号在这里翻成下标。接上一镜的行不挂图（互斥），图号进冲突账报数 ——
         但 ref 行已有参考素材时，落盘会拒绝把它改成接续（见 applyBoardFull），图照常带上。 */
      const pr = picsIdxOf(s.pics, pics);
      const chainDrops = chain === 'tail' && !(t && t.refs);
      const picIdxs = chainDrops ? [] : pr.idxs.slice();
      if (chainDrops && pr.idxs.length) pr.idxs.forEach(i => picChain.add(i));
      if (t) {
        /* 改现有镜头：prompt 空着 = 保持原文（用户可能只想改名 / 时长）；其余字段照行落。 */
        if (!seenRef.has(t.ref)) { seenRef.add(t.ref); updN++; }
        items.push({
          key: String(t.ref),
          ref: String(t.ref), shotId: t.sh.id,
          scene: scName || hit.S.name,      // 展示用：AI 给的场名（落盘不动现有镜头的场景归属）
          curScene: hit.S.name,             // 这一镜现在的场名（label 与报数用它）
          name: nm, dur, note, text: text || t.prompt,
          chain, pics: picIdxs,
          upd: true,
          label: '改 · ' + hit.S.name + ' · ' + t.ref + (dur ? '（' + dur + 's）' : ''),
        });
        return;
      }
      /* 新镜头：没有提示词的行没有意义（改镜可以空、新镜不行）。 */
      if (!text) { skipped++; return; }
      if (s.ref != null && String(s.ref).trim()) unknownRefs++;     // 写了 ref 但对不上：照实计数
      addN++;
      items.push({
        key: (scName || ('场景 ' + (sci + 1))) + '·' + (shi + 1),
        ref: '', scene: scName, curScene: '',
        name: nm, dur, note, text,
        chain, pics: picIdxs,
        upd: false,
        label: (scName ? scName + ' · ' : '') + '新镜头' + (dur ? '（' + dur + 's）' : ''),
      });
    });
  });
  const totalExisting = (snap || []).reduce((n, s) => n + (s.shots || []).length, 0);
  return { items, skipped, unknownRefs, updN, addN, kept: Math.max(0, totalExisting - updN),
    picChain: [...picChain], title: String((j && j.title) || '').trim() };
}
/* 统一格式落盘（这条链唯一的写点）。
   · ref 行按 id **就地改**那一条：prompt 只在真的变了才写（没变的别拿空串盖掉）；
     name / 时长照行落（AI 整份回的）；接续照行落 —— 但已有参考素材的镜头不改成接续
     （互斥，照实计 chainRefused），取消接续时顺手清「程序选的型号」标记。
     镜头对象是活引用：候选、生成结果、选用全跟着它走。
   · 无 ref 的行建新镜头，按场景名归并：`matchSceneOf` 认得出已有场景（nameKey 精确之外
     再剥编号前缀）就追加到那一场末尾；认不出才新开一场（按 AI 首现顺序排在现有场景之后）。
     场景图只喂**这一次新建的**镜头（与 placeScenesInto 同一立场）。
   · 没被任何 ref 提到的现有镜头**原样保留**（kept 计数）—— 统一格式不做删除，
     AI 漏抄几条不会误删用户已生成的内容；想删在左栏删。
   随附图排在场景图之后挂（同一镜头两层各挂各的，`bindShotPics` 按图去重）。
   返回 {upd, add, newScenes, kept, unknownRefs, skipped, chained, unchained, chainRefused,
         pics, at, touched, picN, picShots, picDup, picWhy, picUnknown, clamped}。 */
function applyBoardFull(items, scenes, pics) {
  const list = scenes || [];
  const total0 = list.reduce((n, sc) => n + ((sc && sc.shots) || []).length, 0);
  const findShot = id => {
    for (const sc of list) { const sh = (sc.shots || []).find(x => x.id === id); if (sh) return { sc, sh }; }
    return null;
  };
  const r = { upd: 0, add: 0, newScenes: 0, kept: 0, unknownRefs: 0, skipped: 0,
    chained: 0, unchained: 0, chainRefused: 0 };
  const touched = [];                 // 改到的 + 新建的（活引用）：时长兜底与素材图只落这一批
  const picJobs = [];                 // AI 点了随附图的那几镜（ref 行与新镜都收）
  /* 新镜头按场景名分组（首现顺序）；ref 行不参与场景重建（镜头留在原地）。 */
  const newG = new Map();             // nameKey → { name, items }
  let atRef = null;
  (items || []).forEach(it => {
    if (!it) return;
    if (it.upd && it.shotId) {
      const h = findShot(it.shotId);
      if (!h) { r.skipped++; return; }
      const sh = h.sh, def = defaultTakeOf(sh);
      const np = String(it.text == null ? '' : it.text).trim();
      if (np && np !== String((def && def.prompt) || '')) setShotPrompt(sh, np);
      if (String(it.name || '').trim()) sh.name = String(it.name).trim();
      if (it.dur != null) setShotDur(sh, it.dur);
      if (String(sh.note || '') !== String(it.note || '')) sh.note = String(it.note || '');
      /* 接续照行落；已有参考素材的镜头不改成接续（互斥）。 */
      if (it.chain === 'tail') {
        if (def && def.linkPrev !== 'tail') {
          const hasRefs = (Array.isArray(def.refImages) && def.refImages.some(Boolean))
            || (Array.isArray(def.keyframes) && def.keyframes.some(k => k && k.assetId && !k.deleted))
            || def.refVideo || def.refAudio;
          if (hasRefs) r.chainRefused++;
          else { def.linkPrev = 'tail'; r.chained++; }
        }
      } else if (def && def.linkPrev === 'tail') {
        def.linkPrev = '';
        def.modelAuto = '';
        r.unchained++;
      }
      if (it.pics && it.pics.length) picJobs.push({ sh, idxs: it.pics });
      r.upd++; touched.push(sh);
      if (!atRef) atRef = sh;
      return;
    }
    const key = nameKey(String(it.scene || '').trim());
    let g = key ? newG.get(key) : null;
    if (!g) { g = { name: String(it.scene || '').trim(), items: [] }; if (key) newG.set(key, g); }
    g.items.push(it);
  });
  /* 新镜头一场一场落：认得出已有场景就追加到末尾，认不出才新开（排在现有场景之后）。 */
  const madeOf = new Map();
  newG.forEach(g => {
    const dst = g.name ? matchSceneOf(g.name, list) : null;
    const sc = dst || { id: uid(), name: g.name || ('场景 ' + (list.length + 1)), shots: [] };
    const made = madeOf.get(sc) || [];
    g.items.forEach(it => {
      const sh = newShot();
      const def = defaultTakeOf(sh);
      setShotPrompt(sh, String(it.text || '').trim());
      sh.name = String(it.name || '').trim() || ('镜头 ' + ((sc.shots || []).length + 1));
      sh.note = String(it.note || '');
      if (it.dur != null) setShotDur(sh, it.dur);
      if (it.chain === 'tail' && def) def.linkPrev = 'tail';
      /* 长镜头拆段那一路算好的接续型号照落（秒数是照它的区间分的）。 */
      if (it.chainModel && def) { def.model = String(it.chainModel); def.modelAuto = 'chain'; }
      if (it.pics && it.pics.length) picJobs.push({ sh, idxs: it.pics });
      sc.shots.push(sh);
      made.push(sh); touched.push(sh); r.add++;
      if (!atRef) atRef = sh;
    });
    if (!dst) { list.push(sc); r.newScenes++; }
    madeOf.set(sc, made);
  });
  /* 场景图只喂这一次新建的镜头；AI 随附图排在场景图之后挂（bindShotPics 按图去重）。 */
  const scenePics = { added: 0, why: '' };
  madeOf.forEach((made, sc) => {
    const x = feedScenePics(sc, made);
    scenePics.added += x.added; if (x.why && !scenePics.why) scenePics.why = x.why;
  });
  const picRes = { n: 0, shots: 0, dup: 0, why: '', unknown: 0 };
  if (typeof bindShotPics === 'function' && picJobs.length && pics) {
    picJobs.forEach(j => {
      const x = bindShotPics(defaultTakeOf(j.sh), j.idxs, pics);
      if (x.n) { picRes.n += x.n; picRes.shots++; }
      picRes.dup += x.dup || 0; picRes.unknown += x.unknown || 0;
      if (x.why && !picRes.why) picRes.why = x.why;
    });
  }
  let at = null;
  if (atRef) {
    for (let i = 0; i < list.length; i++) {
      const k = (list[i].shots || []).indexOf(atRef);
      if (k >= 0) { at = { scene: i, shot: k }; break; }
    }
  }
  /* `touched` 交出去：调用方拿它做「按 @名字 挂素材图」与接续型号收正，不再按 id 回查。 */
  r.kept = Math.max(0, total0 - r.upd);
  return { upd: r.upd, add: r.add, newScenes: r.newScenes, kept: r.kept, unknownRefs: r.unknownRefs,
    skipped: r.skipped, chained: r.chained, unchained: r.unchained, chainRefused: r.chainRefused,
    pics: scenePics, at, touched,
    picN: picRes.n, picShots: picRes.shots, picDup: picRes.dup, picWhy: picRes.why, picUnknown: picRes.unknown,
    clamped: clampShotDurations(touched.map(sh => ({ ...sh, candidates: [defaultTakeOf(sh)].filter(Boolean) }))) };
}
  return { snapBoard, boardListText, boardFullItemsOf, applyBoardFull };
}
