/* 导演台「项目文件」（.json）：一部或几部短片的**完整工程快照**。
   与页头那四种导出不是一回事：成片 / FCPXML / 媒体包 / 工程目录都只带「选中的画面」，
   是交给剪辑软件或观众的产物；这一份带的是**作品本身** —— 每一镜的所有候选（含没选用、
   失败、草稿占位）、每一段提示词与台词、参考图与首尾帧、选用 / 锁定 / 裁剪、成片轨
   （clips / voices / captions / markers / tracks）、画幅与项目组名。导入回导演台就能接着剪。

   为什么不直接 `JSON.stringify(proj)` 了事：
     · 工作区里有「我现在看着哪一镜」这类视口游标、`blob:` 这种刷新即失效的运行时地址、
       `_objUrl` 这种内存标记 —— 打包带出去，到了另一台机器就是一片破图；
     · 在途的生成任务（creating / queued / running）认的是这台机器上那一轮轮询，
       原样导入会永远转圈；
     · 项目 id 与现有短片撞上时不能悄悄覆盖别人的作品。
   所以「清洗 / 格式闸门 / 校验和 / 导入归一化」都在这一份纯函数里，engine 只管取文件与落盘。
   纯算法、不碰 DOM / 网络，判据在 tests/director-project-pack.mjs。

   格式版本只认当前这一版：更高 / 没有版本一律拒绝且零写入（旧形状不做兼容层）。 */

export const PROJECT_PACK_TYPE = 'ai-workbench-director-project';
export const PROJECT_PACK_VERSION = 1;

/* 这几种状态是「这一轮的生成任务还在跑」，任务号只对导出它的那台机器有意义。 */
const PROJ_PACK_IN_FLIGHT = new Set(['creating', 'queued', 'running']);

/* 校验和不用 crypto：浏览器与 Node 都得能算同一枚，且要能挡住「没下完整 / 被人手改过」。
   两轮不同参数的 32 位散列拼成 16 位十六进制 —— 对这一族文件足够，且不需要异步。 */
export function projectPackChecksum(text) {
  const s = String(text == null ? '' : text);
  let h1 = 0x811c9dc5, h2 = 0x9dc5811c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
}

function projPackClone(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

/* ---------- 内容指纹：这部短片和本机某部是不是「完全一致」 ----------
   两处口径都是**为了认得出「同一部作品」**，不是逐字节相同：
   · id / 名字 / 组 不进指纹 —— id 是这台机器的身份，名字会被上一次导入改成「X（导入）」；
   · 空值（''/null/[]/{}）与「这个键压根没写」视为一回事 —— 界面渲染时会自动补一批默认值
     （`adv` 面板、`refMeta` 标签、`tracks` 空表…），同一部短片隔一会儿看就多出几把空键；
   · `combo` / `adv` / `duration` 在镜头上是面板算出来 / 补上去的，不参与比对 ——
     真正的时长与画面在 `film` 那几段剪辑里，那一段照比不误；
   · `blob:` 地址按导出同一条规矩折成空串（导出会清、本机还留着）。
   键按字典序排，同一份数据在任何机器上都算出同一枚指纹。 */
function projPackCanon(v) {
  if (Array.isArray(v)) return v.map(projPackCanon).filter(x => !projPackEmpty(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === '_objUrl' || k === '_mirrorAnnounced') continue;   // 内存标记，导出时就删了
      let x = v[k];
      if (k === 'url' && projPackMediaKind(x) === 'blob') x = '';
      const c = projPackCanon(x);
      if (projPackEmpty(c)) continue;                 // 「没写」与「写了空值」等同
      out[k] = c;
    }
    return out;
  }
  return v;
}
function projPackEmpty(v) {
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}
/* 这些是**镜头面板**渲染时算/补的，不属于作品内容（见上面那段说明）。
   只从镜头那一层摘，别在整棵树里删 `duration` —— 成片轨的片段时长正是要照比的那一部分。 */
const PROJ_PACK_FP_VOLATILE = new Set(['combo', 'adv', 'duration']);

/* 一部短片的内容指纹。导出侧与导入侧都调它 —— 两边同一把尺子，才有「完全一致」。 */
export function projPackFingerprint(project) {
  const p = projPackClone(project);
  if (!p || typeof p !== 'object') return '';
  delete p.id; delete p.name; delete p.groupName; delete p.groupId;
  delete p.curScene; delete p.curShot; delete p.curCand;
  for (const sc of projPackArray(p.scenes)) {
    sc.shots = projPackArray(sc.shots).map(sh => {
      if (!sh || typeof sh !== 'object') return sh;
      const s = { ...sh };
      for (const k of PROJ_PACK_FP_VOLATILE) delete s[k];
      return s;
    });
  }
  return projectPackChecksum(JSON.stringify(projPackCanon(p)));
}
function projPackText(v) { return String(v == null ? '' : v); }
function projPackArray(v) { return Array.isArray(v) ? v : []; }

/* 项目形状的最低要求：少一样都不算一部短片。
   「读不出来」不等于「本来就没有」—— 这里宁可拒绝，也不给一个半份工程。 */
function projPackShape(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '短片不是对象';
  if (!projPackText(p.id).trim()) return '短片没有 id';
  if (!projPackArray(p.scenes).length) return '短片里一个场景都没有';
  for (const sc of p.scenes) {
    if (!sc || typeof sc !== 'object' || !projPackArray(sc.shots).length) return '有场景里一个镜头都没有';
  }
  return '';
}

/* 每条候选的视频地址分三类：本机资产库（换机器要连素材一起搬）、平台签名地址（会过期）、
   blob:（当前标签页的 objectURL，出了这个标签页就是死链）。第三类一律置空并计数。 */
function projPackMediaKind(url) {
  const u = projPackText(url);
  if (!u) return 'none';
  if (/^blob:/i.test(u)) return 'blob';
  if (/^\/asset\//i.test(u)) return 'local';
  return 'remote';
}

/* ---------- 随包带走的本机素材线索 ----------
   新机器上只拷视频文件、不搬 .data\local-assets\ 索引时，光有 `/asset/la_xxx` 是不够的：
   号只活在旧账里。包里因此附上每一枚本机号的「落点 / 文件名 / 字节数 / 平台身份」，
   导入时交给 `POST /local-assets/rebind` 按盘认回同一枚号 —— 不用重新导入素材。
   线索只是提示，不是作品本身：`checksum` 仍只盖 `projects`，另给 `mediaChecksum` 盖这一份，
   对不上时**只丢线索、照常导入**（见 projectPackMedia）；老包（没有 media）照旧认。 */
function projPackMediaHints(projects, hintOf) {
  const out = [], seen = new Set();
  const take = typeof hintOf === 'function' ? hintOf : () => null;
  const visit = v => {
    if (typeof v === 'string') {
      if (!/^\/asset\/la_[A-Za-z0-9_-]+/i.test(v)) return;
      const id = (/^\/asset\/(la_[A-Za-z0-9_-]+)/i.exec(v) || [])[1] || '';
      if (!id || seen.has(id)) return;
      seen.add(id);
      let h = null;
      try { h = take(v); } catch (e) { /* 别名表还没就位也照样带上号 */ }
      out.push(Object.assign({ id }, (h && typeof h === 'object') ? {
        name: projPackText(h.name), file: projPackText(h.file),
        bytes: Number(h.bytes) || 0,
        upstream: projPackText(h.upstream), assetId: projPackText(h.assetId), taskId: projPackText(h.taskId),
      } : {}));
      return;
    }
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) visit(v[k]); }
  };
  visit(projects);
  return out;
}

/* 导出前的清洗：只去掉「出了这台机器就没意义」的字段，作品本身一个字节不改。 */
function projPackClean(project, groupName) {
  const why = projPackShape(project);
  if (why) throw new Error('这部短片导不出去：' + why);
  const p = projPackClone(project);
  /* 组是工作区里的实体（带 id），项目文件只带组名：导入那边按名字认领或重建。
     `groupId` 必须抹掉 —— 它是**导出那台机器**工作区里的身份：带到另一台机器上，
     要么指向一个不存在的组（载入时被当成坏值退回未分组），要么撞上这边另一组的 id，
     短片就悄悄落进错误的组里。组只按名字跨机器认。 */
  p.groupName = projPackText(groupName).trim();
  delete p.groupId;
  /* 三个游标是视口状态，不是作品内容（与 snapOf 同一条口径）。 */
  delete p.curScene; delete p.curShot; delete p.curCand;
  for (const sc of projPackArray(p.scenes)) {
    for (const sh of projPackArray(sc.shots)) {
      for (const c of projPackArray(sh.candidates)) {
        if (!c || typeof c !== 'object') continue;
        delete c._objUrl;
        /* 「这条投过自动镜像」是纯内存标记（导演台现在放在 WeakSet 里）；老包 / 手改过的包
           可能把它带进来，落地前抹掉 —— 否则新机器上的历史补扫会整批跳过这一条。 */
        delete c._mirrorAnnounced;
        if (projPackMediaKind(c.url) === 'blob') c.url = '';
      }
    }
  }
  return p;
}

/* 摘要里的每一项都能数出来：确认框读它，导出回执也读它，不在两处各算一遍。 */
export function projectPackStats(projects) {
  const s = {
    projects: 0, groups: 0, scenes: 0, shots: 0, candidates: 0,
    promptShots: 0, promptCandidates: 0, lines: 0, notes: 0,
    selected: 0, trimmed: 0, locked: 0,
    clips: 0, voices: 0, captions: 0, markers: 0,
    localAssets: 0, remoteUrls: 0, blobUrls: 0,
  };
  /* 组按名字数：包里没有组表，组名就是唯一身份（同组多部只算一个组）。 */
  const groupNames = new Set();
  for (const p of projPackArray(projects)) {
    if (!p || typeof p !== 'object') continue;
    s.projects++;
    const gname = projPackText(p.groupName).trim();
    if (gname) groupNames.add(gname);
    const film = (p.film && typeof p.film === 'object') ? p.film : {};
    s.clips += projPackArray(film.clips).length;
    s.voices += projPackArray(film.voices).length;
    s.captions += projPackArray(film.captions).length;
    s.markers += projPackArray(film.markers).length;
    for (const sc of projPackArray(p.scenes)) {
      s.scenes++;
      for (const sh of projPackArray(sc.shots)) {
        s.shots++;
        if (projPackText(sh.prompt).trim()) s.promptShots++;
        if (projPackText(sh.line).trim()) s.lines++;
        if (projPackText(sh.note).trim()) s.notes++;
        if (projPackText(sh.selId).trim()) s.selected++;
        for (const c of projPackArray(sh.candidates)) {
          if (!c || typeof c !== 'object') continue;
          s.candidates++;
          if (projPackText(c.prompt).trim()) s.promptCandidates++;
          if (c.locked) s.locked++;
          if (c.trimS != null || c.trimE != null) s.trimmed++;
          const kind = projPackMediaKind(c.url);
          if (kind === 'local') s.localAssets++;
          else if (kind === 'remote') s.remoteUrls++;
          else if (kind === 'blob') s.blobUrls++;
        }
      }
    }
  }
  s.groups = groupNames.size;
  return s;
}

/* 打一份包。`groupNameOf(p)` 由调用方给（组名要靠工作区那张表查，这里不认工作区）。 */
export function buildProjectPack(opts) {
  const o = opts || {};
  const raw = projPackArray(o.projects).filter(Boolean);
  if (!raw.length) throw new Error('没有可导出的短片');
  const projects = raw.map(p => projPackClean(p, o.groupNameOf ? o.groupNameOf(p) : ''));
  const media = projPackMediaHints(projects, o.hintOf);
  const stats = projectPackStats(projects);
  /* blob: 地址在清洗那一步已经置空，projects 里再也数不到 —— 但「丢了几条临时地址」
     必须对导入方说清楚，否则用户会以为那一格本来就没视频。从导出前的原件里数一次，
     这一项因此记的是「导出时清掉的条数」，与其余按包内正文数出来的项不同。 */
  stats.blobUrls = projectPackStats(raw).blobUrls;
  return {
    type: PROJECT_PACK_TYPE,
    version: PROJECT_PACK_VERSION,
    ts: projPackText(o.ts) || new Date().toISOString(),
    app: 'director',
    projects,
    stats,
    checksum: projectPackChecksum(JSON.stringify(projects)),
    media,
    mediaChecksum: projectPackChecksum(JSON.stringify(media)),
  };
}

/* 素材线索是一段「可选、可丢」的附件：它只影响「旧本机号能不能当场认回」，
   不影响作品本身。所以校验和对不上（手改过 / 没下完整）时**只丢线索、照常导入**，
   不再整包拒绝 —— 一条 file 路径写错就让人导不进来，代价与收益不成比例。 */
export function projectPackMedia(pack) {
  if (!pack || pack.media == null) return { list: [], why: '' };
  if (!Array.isArray(pack.media)) return { list: [], why: '素材线索格式不对，已忽略' };
  if (!pack.media.length) return { list: [], why: '' };
  if (pack.mediaChecksum !== projectPackChecksum(JSON.stringify(pack.media))) {
    return { list: [], why: '素材线索校验和对不上，已忽略（作品照常导入）' };
  }
  return { list: pack.media.slice(), why: '' };
}

/* 格式闸门：确认框弹出之前先过一次，写入口自己再过一次。
   任何一项不过都直接抛 —— 调用方在它之前不许写任何一个字节。 */
export function assertProjectPack(pack) {
  if (!pack || typeof pack !== 'object' || pack.type !== PROJECT_PACK_TYPE) {
    throw new Error('不是导演台导出的项目文件');
  }
  if (pack.version !== PROJECT_PACK_VERSION) {
    throw new Error(pack.version > PROJECT_PACK_VERSION
      ? '这份项目文件来自更新版本（v' + pack.version + '），请先升级再导入'
      : '这份项目文件缺少可识别的格式版本');
  }
  if (!projPackArray(pack.projects).length) throw new Error('项目文件里没有短片');
  for (const p of pack.projects) {
    const why = projPackShape(p);
    if (why) throw new Error('项目文件里的短片不完整：' + why);
  }
  const want = projectPackChecksum(JSON.stringify(pack.projects));
  if (pack.checksum !== want) {
    throw new Error('项目文件校验和对不上（可能没下载完整，或被人改过），已拒绝导入');
  }
  return projectPackStats(pack.projects);
}

/* 导入前给人看的一段话：覆盖什么、保留什么、什么带不走，都要说明白。 */
export function describeProjectPack(pack) {
  const s = assertProjectPack(pack);
  /* 导出时清掉的 blob: 条数记在 stats 里；手工改过的包也可能正文里还留着。取较大，不重复报。 */
  s.blobUrls = Math.max(s.blobUrls, Math.max(0, Number(pack.stats && pack.stats.blobUrls) || 0));
  const prompts = s.promptShots + s.promptCandidates + s.lines + s.notes;
  const cuts = s.clips + s.voices + s.captions + s.markers;
  const parts = [
    s.projects + ' 部短片', s.scenes + ' 场', s.shots + ' 镜',
    s.candidates + ' 条候选（含未选用 / 失败 / 草稿）',
    prompts + ' 段提示词与台词', cuts + ' 段剪辑（画面 / 配音 / 字幕 / 标记）',
  ];
  let text = '项目文件 v' + pack.version + '（导出于 ' + projPackText(pack.ts).slice(0, 10) + '）：'
    + parts.join(' · ') + '。将作为新短片追加，不覆盖现有项目；当前数据不会被删。';
  /* 组跟着包回来这件事必须先说清楚：同名组不是「悄悄并进去」也不是「悄悄另建一个」，
     导入时会就地问一次 —— 文字里把两个选项都点出来，别让人以为只有一种结果。 */
  if (s.groups) {
    text += ' 短片带着 ' + s.groups + ' 个项目组：本机没有同名组就按原名字新建；'
      + '已有同名组会先问你 —— 并入本机那个组，还是给导入的组改名。';
  }
  const carried = s.localAssets + s.remoteUrls;
  if (carried) {
    text += ' 视频字节不在包里：' + carried + ' 条候选只带地址'
      + (s.localAssets ? '（' + s.localAssets + ' 条指向本机资产库）' : '') + '。';
  }
  const pm = projectPackMedia(pack);
  if (pm.list.length) {
    text += ' 随包带了 ' + pm.list.length + ' 条本机素材线索：换机器时把视频文件放进本机资产库，'
      + '导入会按线索认回旧本机号，不用重新导入素材。';
  } else if (pm.why) {
    text += ' ' + pm.why + '；作品本身不受影响，本机素材需要重新导入一次。';
  }
  if (s.blobUrls) text += ' 另有 ' + s.blobUrls + ' 条临时视频地址已置空，导入后要重新导入本机视频。';
  return { ...s, prompts, text };
}

/* 导入前的**冲突扫描**：哪些组名本机已经有了、哪几部短片与本机某部内容完全一致。
   只报事实、不替用户决定 —— 两件事各有一种「不问就做」的默认做法（并组 / 重命名），
   但那会把用户正在攒的作品悄悄改成另一个样子，所以由调用方拿着这份清单去问。
   纯函数：本机的组名与短片都由调用方递进来（这个文件不认工作区）。 */
export function scanProjectPackConflicts(pack, opts) {
  assertProjectPack(pack);
  const o = opts || {};
  const keyOf = typeof o.nameKey === 'function' ? o.nameKey : v => projPackText(v).trim().toLowerCase();
  const groupTaken = typeof o.groupTaken === 'function' ? o.groupTaken : () => false;
  const packGroupName = p => projPackText(p && p.groupName).trim();
  /* 已经决定跳过的那几部不参与「组名撞车」的判断：它们不会导进来，
     拿它们去问「这个组要并入还是改名」是白问。 */
  const skipIdx = o.skipIndexes instanceof Set ? o.skipIndexes
    : new Set(projPackArray(o.skipIndexes).map(Number));
  const live = pack.projects.filter((p, i) => !skipIdx.has(i));

  /* 组：按名字去重后报，附上「包里这个组有几部短片」，问的时候能说清影响面。 */
  const groups = [];
  const seen = new Set();
  for (const p of live) {
    const name = packGroupName(p);
    if (!name) continue;
    const k = keyOf(name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (!groupTaken(name)) continue;
    groups.push({
      name,
      count: live.filter(x => keyOf(packGroupName(x)) === k).length,
    });
  }

  /* 短片：指纹对得上就是「数据完全一致」。同一份包里若有两部一样的，都报出来 ——
     「跳过重复」在这个口径下就是「本机已经有的内容不再来一份」。 */
  const known = new Map();
  for (const p of projPackArray(o.localProjects)) {
    if (!p || typeof p !== 'object') continue;
    const fp = projPackFingerprint(p);
    if (fp && !known.has(fp)) known.set(fp, projPackText(p.name).trim() || '未命名短片');
  }
  const duplicates = [];
  pack.projects.forEach((p, index) => {
    const fp = projPackFingerprint(p);
    if (!fp || !known.has(fp)) return;
    duplicates.push({
      index,
      name: projPackText(p && p.name).trim() || '未命名短片',
      sameAs: known.get(fp),
    });
  });
  return { groups, duplicates };
}

/* 导入归一化：把包里的短片变成「可以直接 push 进 WS.projects」的形状。
   uid / existingIds / nameTaken 由调用方给（这台机器的身份在这里算不出来）。
   `groupPolicy`：'merge'（默认，同名组就并进去）或 'rename'（给导入的组加「（导入）」后缀）；
   `skipIndexes`：内容与本机完全一致、用户选择跳过的那几部（下标对 pack.projects）。
   返回 { items:[{ project, groupName }], notes } —— 不碰工作区，纯变形。 */
export function prepareProjectPackImport(pack, opts) {
  assertProjectPack(pack);
  const o = opts || {};
  const uid = typeof o.uid === 'function' ? o.uid : () => 'p' + Math.random().toString(36).slice(2, 10);
  const used = new Set(projPackArray(o.existingIds).map(String));
  const nameTaken = typeof o.nameTaken === 'function' ? o.nameTaken : () => false;
  const keyOf = typeof o.nameKey === 'function' ? o.nameKey : v => projPackText(v).trim().toLowerCase();
  const groupTaken = typeof o.groupTaken === 'function' ? o.groupTaken : () => false;
  const groupPolicy = o.groupPolicy === 'rename' ? 'rename' : 'merge';
  const skipIdx = o.skipIndexes instanceof Set ? o.skipIndexes
    : new Set(projPackArray(o.skipIndexes).map(Number));
  /* deadUrls 以包里记的「导出时清掉的条数」为底；手工改过的包也可能还留着 blob: 地址，
     扫描时一并记上（两者取较大，不重复报）。 */
  const notes = { renamed: 0, newIds: 0, inFlight: 0, skipped: 0, skippedNames: [],
    renamedGroups: 0, groupRenames: [],
    deadUrls: Math.max(0, Number(pack.stats && pack.stats.blobUrls) || 0) };
  /* 组名撞车时用户选了「给导入的组改名」：同一个原组名在这一批里只改一次、只报一次，
     否则一组的几部短片会各拿一枚后缀，反而拆成好几个组。
     新名字也要挡两处：本机已有组名，以及包里其它还没处理的组名。 */
  const groupNamesInPack = new Set();
  for (const p of pack.projects) {
    const g = projPackText(p && p.groupName).trim();
    if (g) groupNamesInPack.add(keyOf(g));
  }
  const groupFixed = new Map();
  const pickGroupName = raw => {
    const base = projPackText(raw).trim();
    if (!base) return '';
    if (groupPolicy !== 'rename' || !groupTaken(base)) return base;
    const k = keyOf(base);
    if (groupFixed.has(k)) return groupFixed.get(k);
    let name = base;
    for (let n = 1; groupTaken(name) || (name !== base && groupNamesInPack.has(keyOf(name))); n++) {
      name = base + (n === 1 ? '（导入）' : '（导入 ' + n + '）');
    }
    groupFixed.set(k, name);
    groupNamesInPack.add(keyOf(name));
    notes.renamedGroups++;
    notes.groupRenames.push({ from: base, to: name });
    return name;
  };
  /* 撞名后缀：第一次 `X（导入）`，再撞就是 `X（导入 2）`、`X（导入 3）`……
     两处都得挡：本机已有同名短片（nameTaken），以及**这一批**里刚分出去的名字（nameUsed）。
     以前只判一次，同一个包连导两次会得到两部都叫「X（导入）」的短片；包里本来就带两部
     同名短片时也一样。名字只增不减，循环必然收敛。 */
  const nameUsed = new Set();
  const pickProjectName = raw => {
    const base = projPackText(raw).trim() || '未命名短片';
    let name = base;
    for (let n = 1; nameTaken(name) || nameUsed.has(name); n++) {
      name = base + (n === 1 ? '（导入）' : '（导入 ' + n + '）');
    }
    nameUsed.add(name);
    if (name !== base) notes.renamed++;
    return name;
  };
  let scannedDead = 0;
  const items = [];
  pack.projects.forEach((raw, index) => {
    /* 用户选了「重复的不再导一份」：这一部连名字都不该占掉，直接跳过。 */
    if (skipIdx.has(index)) {
      notes.skipped++;
      notes.skippedNames.push(projPackText(raw && raw.name).trim() || '未命名短片');
      return;
    }
    const p = projPackClone(raw);
    const groupName = pickGroupName(p.groupName);
    delete p.groupName;
    /* 老包 / 手改过的包里可能还留着导出那台机器的 `groupId`：组只按名字认，
       这一枚 id 在本机没有意义；留着会把短片挂到本地另一拨巧合同 id 的组上。 */
    delete p.groupId;
    delete p.curScene; delete p.curShot; delete p.curCand;
    /* id 撞车就换一枚：内部镜头 / 候选 / 剪辑的 id 只在这部短片内部互相引用，
       不用跟着改 —— 改了反而会把 selId、clip.shotId 这些引用全部扯断。 */
    if (!p.id || used.has(String(p.id))) { p.id = uid(); notes.newIds++; }
    used.add(String(p.id));
    p.name = pickProjectName(p.name);
    for (const sc of projPackArray(p.scenes)) {
      for (const sh of projPackArray(sc.shots)) {
        for (const c of projPackArray(sh.candidates)) {
          if (!c || typeof c !== 'object') continue;
          delete c._objUrl;
          delete c._mirrorAnnounced;      // 纯内存标记，别让它跟着导入的短片一起进来
          if (projPackMediaKind(c.url) === 'blob') { c.url = ''; scannedDead++; }
          if (PROJ_PACK_IN_FLIGHT.has(String(c.status || ''))) {
            c.status = 'failed';
            c.progress = 0;
            c.error = '从项目文件导入时这条还在生成；任务不在这台机器上，可以重新生成';
            notes.inFlight++;
          }
        }
      }
    }
    items.push({ project: p, groupName });
  });
  notes.deadUrls = Math.max(notes.deadUrls, scannedDead);
  /* 素材线索原样交回：engine 在把短片追加进工作区之后，拿它去问代理「按旧号重绑」。
     纯件不碰网络，也不替调用方决定什么时候重绑。线索坏了不拦导入，只留一句给回执。 */
  const pm = projectPackMedia(pack);
  notes.mediaDropped = pm.why;
  return { items, notes, media: pm.list };
}
