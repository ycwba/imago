/* 分镜结构化纯函数：快照 / 给 AI 的清单 / changes 对账 / 唯一落盘点。
   从 web/director/engine.js 拆出；镜头工厂、时长夹取、场景图与状态判据由 createBoardTools 注入。 */
import { ctxClip, BOARD_CTX_PROMPT, BOARD_CTX_SHORT } from './util.js';

export function createBoardTools(ctx) {
  const { durWritable, nameKey, newShot, setShotDur, removeShot, uid, Wb, feedScenePics, clampShotDurations } = ctx;

function snapBoard(scenes) {
  return (scenes || []).map((sc, si) => ({
    n: si + 1, sc, name: sc.name || ('场景 ' + (si + 1)),
    shots: (sc.shots || []).map((sh, hi) => ({
      n: hi + 1, sh, name: sh.name || '',
      prompt: String(sh.prompt || '').trim(),
      line: String(sh.line || '').trim(),
      who: String(sh.lineWho || '').trim(),
      dur: Number(sh.duration) > 0 ? Number(sh.duration) : 0,
      /* 接上一镜：AI 改稿时要看得见「这镜的首帧来自上一镜结尾」，否则它会把这条接续当成
         普通镜头改提示词，或者把已经接好的两镜拆开。 */
      chain: sh.linkPrev === 'tail' ? 'tail' : '',
    })),
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
      /* 台词只在这一镜真挂着那句时才写：AI 看不见它就改不了它（`update` 带 `line` 那一路），
         而给没台词的镜头写一行空的「台词：」，等于请它编一句。 */
      const ln = t.line ? '（台词' + (t.who ? '（' + t.who + '）' : '') + '：' + ctxClip(t.line, BOARD_CTX_PROMPT) + '）' : '';
      const chain = t.chain === 'tail' ? ' · 接上一镜' : '';
      out.push(`  镜头 ${t.n}${nm}（${t.dur ? t.dur + ' 秒' : '时长未定'}${chain}）${ln}：${body}`);
    });
  });
  return out.join('\n');
}
/* 把 AI 回的 changes 翻成一份对账，opt = {style}。
   每条 item 带着 op 与目标 id（shotId / sceneId + afterId）—— 审查弹窗里用户能改正文、能删条目，
   落盘只按这些 id 找，不会再拿序号回查一遍（那时序号已经会漂）。
   返回 {items, skipped, noop}：两个计数是「AI 交的东西没全采纳」的原因账，
   报告时要照实说 —— 静默吞掉 = 用户以为它改了，其实一个字没动。
   ⚠ 这里**不再有任何镜数上限、也不 clamp 时长**：以前 `cap` 会把超出的几条
   默默压掉不列出来，以前 `sbSec` 拿一份全站都没有的 2–15 把 AI 的秒数「洗」成合法 ——
   洗过的值落进镜头、再进提交体，界面上那句「2–15」就成了假话。现在 AI 给多少条就列多少条，
   秒数原样带着，越界由落盘后的 `clampShotDurations` 按**这一镜自己的型号**夹回去并报数。 */
function boardPlanOf(changes, snap, opt) {
  const o = opt || {};
  const wantStyle = String(o.style || '').trim();
  const withStyle = t => (!wantStyle || String(t).indexOf(wantStyle) >= 0) ? t : (String(t) + '，' + wantStyle).trim();
  /* 原样取 AI 的秒数（只认「是个正数」），整数化一下就停：夹区间是落盘那一步按型号做的事。
     而**一家都没声明区间时这条链压根没有能判合法的依据** —— 当「这一项没给」处理，
     并由 sub 那句话照实说清（不是默默丢掉，用户看得见这一条没写入时长）。 */
  const canDur = durWritable();
  const rawSec = (v, dflt) => {
    if (!canDur) return null;
    const x = Number(v == null || v === '' ? dflt : v);
    return Number.isFinite(x) && x > 0 ? Math.round(x) : null;
  };
  const durSub = d => (d == null
    ? (canDur ? '时长按这一镜的型号现算' : '本机没有声明时长区间的型号，这一镜的秒数不写入')
    : d + ' 秒');
  const sceneOf = ref => {
    if (ref == null || ref === '') return snap.length === 1 ? snap[0] : null;
    /* 先按名字认，认不出再按序号：场景名以数字开头（「3 号站台」）时，
       parseInt 先跑会把它当序号指到第 3 场 —— 名字优先，AI 用名字指代就落到名字上。 */
    const key = nameKey(ref);
    if (key) {
      const byName = snap.find(x => nameKey(x.name) === key);
      if (byName) return byName;
    }
    const n = parseInt(ref, 10);
    if (Number.isFinite(n) && n >= 1 && n <= snap.length) return snap[n - 1];
    return null;
  };
  /* 「AI 说的第 N 镜」翻成那一条镜头，全站只有这一处（加了「删镜头」「挪顺序」两条分支之后，
     同一句 `S.shots[parseInt(ch.shot, 10) - 1]` 在三个分支里各抄了一遍 —— 只要有一支漏掉那个 `-1`
     或忘了往下翻 id，「AI 说第 2 镜」就动到第 3 镜，而审查弹窗里每一行都看着像对的。 */
  const shotAt = ch => {
    const S = sceneOf(ch.scene);
    const n = parseInt(ch.shot, 10);
    const t = S && Number.isFinite(n) ? S.shots[n - 1] : null;
    return t ? { S, t } : null;
  };
  const items = []; let skipped = 0, noop = 0;
  const put = it => { items.push(it); };
  (changes || []).forEach(ch => {
    if (!ch || typeof ch !== 'object') { skipped++; return; }
    const action = String(ch.action || 'update');
    if (action === 'update') {
      const h = shotAt(ch);
      if (!h) { skipped++; return; }
      const S = h.S, t = h.t;
      /* 「只带真的要改的字段」：没带的项一个都不动（原样抄一遍会被算成「与现状相同」而无意义）。 */
      const raw = String(ch.prompt == null ? '' : ch.prompt).trim();
      const pChg = !!raw && raw !== t.prompt;
      const durN = ch.duration == null || ch.duration === '' ? null : rawSec(ch.duration);
      const durChg = durN != null && durN !== t.dur ? durN : null;
      const nm = String(ch.name == null ? '' : ch.name).trim().slice(0, 12);
      const nameChg = nm && nm !== t.name ? nm : '';
      /* 台词：`null`（没带这一项）与 `''`（带了、但要求清掉）是两件事 —— 拿 trim 之后是否为空来判
         「有没有改」就会把「把这句台词删掉」当成没发生，用户点写入后界面上那句还挂在镜头上。 */
      const lnRaw = ch.line == null ? null : String(ch.line).trim();
      const lineChg = lnRaw != null && lnRaw !== t.line ? lnRaw : null;
      /* 说话人（`speaker`，人话里也叫「角色」）：它只跟着台词走 —— 台词被清掉时它一起清
         （一句没有台词的「说话人」是条死数据，下一次合成会拿它去问一个不存在的音色）。
         台词没动而只改说话人是有效改动（同一句话换个人念），单独放行。 */
      const whoRaw = ch.speaker == null && ch.who == null ? null
        : String(ch.speaker != null ? ch.speaker : ch.who).trim();
      const whoChg = lineChg === '' ? ''
        : (whoRaw != null && whoRaw !== t.who ? whoRaw : null);
      /* 接续：`null` = 没带这一项、保持原样；`'tail'` = 改成接上一镜；空串 = 取消接续。 */
      const chainRaw = ch.chain == null && ch.linkPrev == null ? null
        : (String(ch.chain != null ? ch.chain : ch.linkPrev) === 'tail' ? 'tail' : '');
      const chainChg = chainRaw != null && chainRaw !== (t.chain === 'tail' ? 'tail' : '') ? chainRaw : null;
      if (!pChg && !nameChg && durChg == null && lineChg == null && whoChg == null && chainChg == null) { noop++; return; }
      const bits = [];
      if (pChg) bits.push('原：' + (t.prompt ? (t.prompt.length > 60 ? t.prompt.slice(0, 60) + '…' : t.prompt) : '（还没写）'));
      if (durChg != null) bits.push(t.dur ? ('时长 ' + t.dur + ' → ' + durChg + ' 秒') : ('时长设为 ' + durChg + ' 秒'));
      if (nameChg) bits.push('名字改成「' + nameChg + '」');
      if (lineChg != null) bits.push(lineChg
        ? ('台词改成「' + (lineChg.length > 30 ? lineChg.slice(0, 30) + '…' : lineChg) + '」')
        : '这一镜的台词清掉');
      if (whoChg) bits.push('说话人改成「' + whoChg + '」');
      if (chainChg != null) bits.push(chainChg === 'tail' ? '改为接上一镜尾帧' : '取消接上一镜');
      put({
        op: 'update', shotId: t.sh.id, sceneId: S.sc.id,
        patch: { name: nameChg, duration: durChg, line: lineChg, who: whoChg, chain: chainChg },   // 空串 / null = 这一项没改，落盘时跳过
        label: '改 · ' + S.name + ' · 镜头 ' + t.n,
        sub: bits.join(' · '),
        text: pChg ? withStyle(raw) : t.prompt,
        keep: !pChg,                                        // 只改名字 / 时长 / 台词时正文可以本来就是空的
      });
      return;
    }
    if (action === 'insert') {
      const raw = String(ch.prompt == null ? '' : ch.prompt).trim();
      if (!raw) { skipped++; return; }                      // 没有提示词的新镜头没有意义
      const dur = rawSec(ch.duration);
      const patch = { name: String(ch.name == null ? '' : ch.name).trim().slice(0, 12), duration: dur,
        line: ch.line == null ? '' : String(ch.line).trim(),
        who: (ch.line == null ? '' : String(ch.speaker != null ? ch.speaker : (ch.who == null ? '' : ch.who)).trim()),
        chain: ch.chain === 'tail' ? 'tail' : '',
        chainModel: String(ch.chainModel || '') };
      const nsc = String(ch.newScene == null ? '' : ch.newScene).trim().slice(0, 12);
      if (nsc) {
        put({ op: 'insert', newScene: nsc, patch, label: '新增 · 新场景「' + nsc + '」',
          sub: '新建一场放在最后 · ' + durSub(dur), text: withStyle(raw) });
        return;
      }
      const S = sceneOf(ch.scene);
      if (!S) { skipped++; return; }
      const len = S.shots.length;
      const aRaw = ch.after == null || ch.after === '' ? null : parseInt(ch.after, 10);
      let afterId, where;
      if (aRaw == null || !Number.isFinite(aRaw) || aRaw >= len) { afterId = len ? S.shots[len - 1].sh.id : null; where = '末尾'; }
      else if (aRaw <= 0) { afterId = null; where = '开头'; }   // 0 = 插在这一场的开头
      else { afterId = S.shots[aRaw - 1].sh.id; where = '第 ' + aRaw + ' 镜之后'; }
      put({ op: 'insert', sceneId: S.sc.id, afterId, patch,
        label: '新增 · ' + S.name + ' · ' + where, sub: durSub(dur), text: withStyle(raw) });
      return;
    }
    /* 删镜头与挪顺序。序号在这里就翻成 id（与 update / insert 同一立场）——
       审查弹窗里用户还能删条目、在一场内拖动，落盘只认 id 才不会挪错地方。 */
    if (action === 'delete') {
      const h = shotAt(ch);
      if (!h) { skipped++; return; }
      const S = h.S, t = h.t;
      const nc = (t.sh.candidates || []).filter(x => x.status !== 'draft').length;
      put({
        op: 'delete', shotId: t.sh.id, sceneId: S.sc.id, keep: true, text: '',
        label: '删掉 · ' + S.name + ' · 镜头 ' + t.n,
        /* 后果照实列出来（与左栏那颗「×」的三句同一个口径）：这一路没有按钮上的就地二次确认，
           弹窗里这一行小字是用户唯一能看见代价的地方。 */
        sub: [t.name || ('镜头 ' + t.n), t.dur ? t.dur + ' 秒' : '时长未定',
          nc > 1 ? ('这一镜里 ' + nc + ' 条生成结果会一起没') : (nc === 1 ? '这一镜已经生成的那条画面会一起没' : ''),
          '挂在它上面的配音也会删掉'].filter(Boolean).join(' · '),
      });
      return;
    }
    if (action === 'move') {
      const h = shotAt(ch);
      if (!h) { skipped++; return; }
      const S = h.S, t = h.t;
      const len = S.shots.length;
      const aRaw = ch.after == null || ch.after === '' ? null : parseInt(ch.after, 10);
      let afterId, where;
      if (aRaw == null || !Number.isFinite(aRaw) || aRaw >= len) { afterId = len ? S.shots[len - 1].sh.id : null; where = '末尾'; }
      else if (aRaw <= 0) { afterId = null; where = '开头'; }
      else { afterId = S.shots[aRaw - 1].sh.id; where = '第 ' + aRaw + ' 镜之后'; }
      /* 「挪到它自己后面」「本来就在第一场还要挪到开头」都是一条空改动：AI 经常把
         「第 3 镜（末场末条）挪到末尾」当成一次移动。照 noop 计，落盘不该为它动一次数组。 */
      if (afterId === t.sh.id || (afterId === null && t.n === 1)) { noop++; return; }
      put({
        op: 'move', shotId: t.sh.id, sceneId: S.sc.id, afterId, keep: true, text: '',
        label: '挪位 · ' + S.name + ' · 镜头 ' + t.n,
        sub: '挪到' + where + '（只改这一场里的先后，镜头本身一个字不动）',
      });
      return;
    }
    skipped++;                                              // 认不出的 action：照实计数，不静默
  });
  return { items, skipped, noop };
}
/* 落盘（这条链唯一的写点）。update 按 shotId 就地改那一条：正文只在真的变了才写
   （用户没动的那一格别拿它去覆盖），名字 / 时长 / 台词只在 patch 里带了才写
   （台词那一项 `null` = 没带、`''` = 要求清掉，两者都不能当成「什么都没改」跳过）。
   insert 按 sceneId + afterId 分组，一场一场重建镜头数组（同一位置连插几条时顺序按 AI 给的来）；
   afterId 指向的镜头在这期间没了（弹窗开着时被删）就并进那一场末尾 —— 不丢、也不塞到别处。
   newScene 与现有场景重名（nameKey 是同一把尺子）就并进那一场，否则在末尾新开一场。
   delete 走左栏那颗「×」摘出来的同一份 `removeShot`；move 先把那一条从数组里摘出来（**不**回收地址、
   **不**删空场景，它马上要被放回去），再交给同一套 head / after 分组放回去 —— 落点算式只有一份。
   还在生成的那一条不许删（`Wb.stLive`），单独计 `busy` 照实报数：这一路没有按钮上的就地二次确认，
   而任务号一落盘就等于一次已付的钱（AGENTS §6.2）。
   返回 {upd, add, newScenes, skipped, del, mov, busy, lined, pics, at, clamped}：pics 是新镜头认领场景图的结果，
   at 指回第一个被落笔的镜头（调用方把光标放过去），clamped 是这一次夹回的时长有几镜（报数用），
   lined 是这一次真的写上台词的有几镜（报数用 —— 「带上了台词」与「点哪儿去合成」是同一句话的两半）。 */
function applyBoardPlan(items, scenes) {
  const list = scenes || [];
  const findShot = id => {
    for (const sc of list) { const sh = (sc.shots || []).find(x => x.id === id); if (sh) return { sc, sh }; }
    return null;
  };
  const r = { upd: 0, add: 0, newScenes: 0, skipped: 0, del: 0, mov: 0, busy: 0, lined: 0, chained: 0, unchained: 0 };
  /* 这一次真的动过的镜头（改到的 + 新插的）：落盘后的时长兜底只夹这些。
     拿整部短片的镜头去夹会顺手改到没参与这次写入的镜头，而报数那句「其中 X 镜」就成了假话。
     被挪位置的那一条不进来 —— 它一个秒数都没改。 */
  const touched = [];
  const madeOf = new Map();          // sc → 本次真的插进去的镜头（场景图只喂这一批，那一场原有的不动）
  const mk = (it, nth) => {
    const sh = newShot();
    sh.prompt = String(it.text || '').trim();
    sh.name = (it.patch && it.patch.name) || ('镜头 ' + nth);
    if (it.patch && it.patch.line) { sh.line = it.patch.line; r.lined++; }
    if (it.patch && it.patch.who != null) sh.lineWho = it.patch.who;
    if (it.patch && it.patch.duration != null) setShotDur(sh, it.patch.duration);
    /* 拆分长镜头时程序已经按接续型号算过每段时长：把它记成程序选的，并写明来源。
       手写 insert 带 `chain` 但没有型号时，落盘后由 engine 的 ensureChainModel 现挑。 */
    if (it.patch && it.patch.chain === 'tail') { sh.linkPrev = 'tail'; r.chained++; }
    if (it.patch && it.patch.chainModel) { sh.model = it.patch.chainModel; sh.modelAuto = 'chain'; }
    return sh;
  };
  const groups = new Map();          // sceneId → { head: [], after: Map<shotId, items> }
  const newG = new Map();            // nameKey → { name, items }
  let atRef = null;
  items.forEach(it => {
    if (!it) return;
    if (it.op === 'update') {
      const h = findShot(it.shotId);
      if (!h) { r.skipped++; return; }
      const np = String(it.text == null ? '' : it.text).trim();
      if (np && np !== (h.sh.prompt || '')) h.sh.prompt = np;
      if (it.patch && it.patch.name) h.sh.name = it.patch.name;
      if (it.patch && it.patch.duration != null) setShotDur(h.sh, it.patch.duration);
      if (it.patch && it.patch.line != null) { h.sh.line = it.patch.line; if (it.patch.line) r.lined++; }
      /* 说话人与台词成对落：台词被清掉那一路 `boardPlanOf` 已经把 `who` 一起写成空串。 */
      if (it.patch && it.patch.who != null) h.sh.lineWho = it.patch.who;
      /* 接续只改这一个字段；关掉时顺手清掉「程序选的型号」标记，留着会让下次自动切到别处。 */
      if (it.patch && it.patch.chain != null) {
        const on = it.patch.chain === 'tail';
        if ((h.sh.linkPrev === 'tail') !== on) { if (on) r.chained++; else r.unchained++; }
        h.sh.linkPrev = on ? 'tail' : '';
        if (!on) h.sh.modelAuto = '';
      }
      r.upd++;
      touched.push(h.sh);
      if (!atRef) atRef = h.sh;
      return;
    }
    if (it.op === 'delete') {
      const h = findShot(it.shotId);
      if (!h) { r.skipped++; return; }
      if ((h.sh.candidates || []).some(c => Wb.stLive(c.status))) { r.busy++; return; }
      if (!removeShot(h.sc, h.sh)) { r.skipped++; return; }
      r.del++;
      return;
    }
    if (it.op === 'move') {
      const h = findShot(it.shotId);
      if (!h) { r.skipped++; return; }
      if (!list.some(x => x.id === it.sceneId)) { r.skipped++; return; }
      const i = (h.sc.shots || []).indexOf(h.sh);
      if (i < 0) { r.skipped++; return; }
      /* 摘出来交给插入那一套摆放：源场景不可能被清空（这一场至少还有它旁边那一条，
         只有它一场的情况在 boardPlanOf 里就已经判成 noop）。 */
      h.sc.shots.splice(i, 1);
      it.moveShot = h.sh;                           // 挂上对象本身：下面摆放那一步认得它是「已有的一镜」，不会换成空壳
      const g0 = groups.get(it.sceneId) || { head: [], after: new Map() };
      if (it.afterId) {
        const arr = g0.after.get(it.afterId) || [];
        arr.push(it); g0.after.set(it.afterId, arr);
      } else g0.head.push(it);
      groups.set(it.sceneId, g0);
      return;
    }
    if (it.op === 'insert') {
      if (it.newScene) {
        const key = nameKey(it.newScene);
        let g = newG.get(key);
        if (!g) { g = { name: it.newScene, items: [] }; newG.set(key, g); }
        g.items.push(it);
        return;
      }
      if (!list.some(x => x.id === it.sceneId)) { r.skipped++; return; }
      const g0 = groups.get(it.sceneId) || { head: [], after: new Map() };
      if (it.afterId) {
        const arr = g0.after.get(it.afterId) || [];
        arr.push(it); g0.after.set(it.afterId, arr);
      } else g0.head.push(it);
      groups.set(it.sceneId, g0);
      return;
    }
  });
  /* 先改完更新、再重建有插入的那些场景：重建读的是重建那一刻的镜头数组，
     所以「同一场里又改又插」时两件事落在同一份账上。 */
  groups.forEach((g, sid) => {
    const sc = list.find(x => x.id === sid);
    if (!sc) { r.skipped += g.head.length; g.after.forEach(arr => { r.skipped += arr.length; }); return; }
    const src = sc.shots || [];
    const out = []; const made = [];
    const take = it => {
      /* `it.moveShot` 在 = 被挪位置的那一条：**原样放回**，不新建（新建会把它的候选、配音、
         已定下的时长全丢掉，而用户只是让它换个顺序）。它也不进 `made`（场景图不喂它）
         与 `touched`（一个秒数都没改，落盘后的时长兜底不该顺手夹它）。
         ⚠ 这个名字**刻意不叫 `shot`**：`it.shot` 这个名字留给 AI 回的那个序号，
         而序号只许在 `boardPlanOf` 里翻成 id 一次 —— 这一条装的是镜头对象本身，叫 `shot` 会被
         当成序号、落盘那一步又按序号找镜头，那是尺子的红线，不是这里的语义。 */
      const s = it.moveShot || mk(it, out.length + 1);
      out.push(s);
      if (it.moveShot) r.mov++;
      else { made.push(s); touched.push(s); r.add++; }
      if (!atRef) atRef = s;
    };
    g.head.forEach(take);
    const used = new Set();
    src.forEach(sh => {
      out.push(sh);
      const arr = g.after.get(sh.id);
      if (arr) { used.add(sh.id); arr.forEach(take); }
    });
    g.after.forEach((arr, id) => { if (!used.has(id)) arr.forEach(take); });   // 目标没了 → 并到末尾
    sc.shots = out;
    madeOf.set(sc, made);
  });
  newG.forEach(g => {
    const exist = list.find(sc => nameKey(sc.name || '') === nameKey(g.name));
    const sc = exist || { id: uid(), name: g.name, shots: [] };
    const made = madeOf.get(sc) || [];
    g.items.forEach(it => {
      const s = mk(it, (sc.shots || []).length + 1);
      sc.shots = (sc.shots || []).concat(s);
      made.push(s);
      touched.push(s);
      if (!atRef) atRef = s;
      r.add++;
    });
    if (!exist) { list.push(sc); r.newScenes++; }
    madeOf.set(sc, made);
  });
  /* 场景图只喂**这一次新插的**那些镜头（那一场原有的不动 —— 与 placeScenesInto 同一个立场） */
  const pics = { added: 0, why: '' };
  madeOf.forEach((made, sc) => {
    const x = feedScenePics(sc, made);
    pics.added += x.added; if (x.why && !pics.why) pics.why = x.why;
  });
  let at = null;
  if (atRef) {
    for (let i = 0; i < list.length; i++) {
      const k = (list[i].shots || []).indexOf(atRef);
      if (k >= 0) { at = { scene: i, shot: k }; break; }
    }
  }
  /* `touched` = 这一次新建与被改过的那些镜头对象（活引用）：调用方拿它夹时长与「按 @名字 挂素材图」，
     交出去是为了让页面不要再按 id 回查一遍 —— 回查就是第二份账，而这两件事都必须落在同一批人身上。 */
  return { upd: r.upd, add: r.add, newScenes: r.newScenes, skipped: r.skipped, del: r.del, mov: r.mov, busy: r.busy,
    lined: r.lined, chained: r.chained, unchained: r.unchained, pics: pics, at: at, touched: touched,
    /* 写入期兜底：批量生成发的是 `sh.duration` 原值，而按型号回写那一句只在打开这一镜右栏时跑。
       两条落盘路径各夹一次、夹完报数，这里（改现有分镜）与 aiBoardSplit 用的是同一份实现。 */
    clamped: clampShotDurations(touched) };
}
  return { snapBoard, boardListText, boardPlanOf, applyBoardPlan };
}
