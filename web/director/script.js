/* 剧本视图：把分镜上**每一条候选镜头自己的描述**写成一份可编辑的稿子，
   反向解析回同一批候选的 `c.prompt`。
   它不是第二份数据 —— 打开时按当前分镜现算，写入只落候选自己的那一句；
   右栏改一句，下次打开剧本就是新的；剧本里改一句，右栏读到的也是新的。
   台词不在这份稿子里：它有自己的面板（剪辑右栏「台词」那一档），由 AI 按画面生成或手写给，
   与提示词互不带动 —— 一份稿子同时握着提示词与台词，改提示词就会连着改台词，那是两件事。

   格式（人可读、程序也好认）：
     # 场景 1 · 河岸
     ## 镜头 1 · 开场
     候选 1（草稿）：这一条候选自己的描述
     候选 2（已完成）：
   「画面」这一层已经退役：描述只长在候选上，一镜下面是一排候选镜头，各占一行。
   每一行都带冒号 —— 冒号后面就是那一条候选自己的描述（留空 = 把那一句清空）。
   旧稿里的「画面：…」那一行不再认：它现在没有任何落点。
   镜头号是**全片连续号**（与左栏从上往下数的一致）；场景行只用来分组，不参与定位。
   一个值可以写多行：续行缩进两个空格。删掉整段不等于删镜头（镜头结构只在左栏改）。 */
import { defaultTakeOf, setTakePrompt, takeStatusZh } from './takes.js';

const HEAD = /^##\s*镜头\s*(\d+)/;
const CAND = /^候选\s*(\d+)\s*[（(]([^）)]*)[）)]\s*[：:]\s?(.*)$/;

function linesOf(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n');
}
/* 一句描述写进稿子：第一行跟在冒号后面，其余行缩进两个空格当续行。
   （名字不叫 bodyText：web/ui/raw-request.js 那一份是「请求预览的正文排版」，两件事别撞名。） */
function bodyLine(v) {
  const ls = linesOf(v);
  return ls[0] + (ls.length > 1 ? '\n' + ls.slice(1).map(x => '  ' + x).join('\n') : '');
}
function shotList(scenes) {
  return (scenes || []).flatMap(sc => (sc && sc.shots) || []);
}

/* 当前分镜 → 剧本正文。每个镜头一行标题，下面每条候选各占一行「候选 N（状态）：描述」。
   没有描述的候选照样写出来（冒号后面留空）—— 那是这一条现在还没写，不是不存在。 */
export function scriptTextOf(scenes) {
  const out = [];
  let no = 0;
  (scenes || []).forEach((sc, si) => {
    const scName = String((sc && sc.name) || '').trim();
    out.push('# 场景 ' + (si + 1) + (scName ? ' · ' + scName : ''));
    ((sc && sc.shots) || []).forEach(sh => {
      no++;
      const nm = String((sh && sh.name) || '').trim();
      out.push('## 镜头 ' + no + (nm ? ' · ' + nm : ''));
      ((sh && sh.candidates) || []).forEach((c, i) => {
        if (!c) return;
        out.push('候选 ' + (i + 1) + '（' + takeStatusZh(c) + '）：' + bodyLine(c.prompt));
      });
      out.push('');
    });
  });
  return out.length ? out.join('\n').replace(/\s+$/, '') + '\n' : '';
}

/* 剧本正文 → 段落表。认不出的正文一律不写：这是「按稿子改现有分镜」，不是「把稿子随便塞进镜头」。
   返回 { blocks:[{ n, cands:[{ n, text }] }] }；`n` 是镜头号（从 1 开始），
   候选行的 `n` 是这一镜里的第几条候选，`text` 恒为字符串（空串 = 把那一句清空）。
   旧格式的「画面：…」行不再解析 —— 它现在没有落点，认了也是白认。 */
export function parseScript(text) {
  const blocks = [];
  let cur = null;
  let fld = '';
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(raw => {
    /* 续行：缩进两个空格。续行里出现什么字都不当标记（提示词里写「候选 2（…）」也不会误拆）。 */
    if (/^ {2}/.test(raw)) {
      if (cur && fld === 'cand') {
        const cc = cur.cands[cur.cands.length - 1];
        if (cc) cc.text += '\n' + raw.slice(2);
      }
      return;
    }
    const line = raw.trimEnd();
    if (!line.trim()) { fld = ''; return; }
    const h = HEAD.exec(line);
    if (h) {
      const n = parseInt(h[1], 10);
      cur = Number.isFinite(n) && n > 0 ? { n, cands: [] } : null;
      if (cur) blocks.push(cur);
      fld = '';
      return;
    }
    if (/^#\s/.test(line)) { cur = null; fld = ''; return; }   // 场景行：只分组，不定位
    const m = CAND.exec(line);
    if (m && cur) {
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n <= 0) { fld = ''; return; }
      /* 冒号后面就是那一条候选自己的描述；没有冒号的那一行不认（当年「沿用画面」的写法没了）。 */
      cur.cands.push({ n, text: m[3] || '' });
      fld = 'cand';
      return;
    }
    /* 段落里既不是镜头标记、也不是候选行的自由文字（包括旧格式的「画面：」那一行）：
       不猜它属于哪一项，直接忽略。 */
    fld = '';
  });
  return { blocks };
}

/* 稿子里的每一项 → 可写回的落点：镜头 id + 候选 vid + 文本。
   镜头号是全片连续号，按它对回镜头；候选按**打开那一刻的顺序表**（opts.order）对回 vid ——
   顺序表是快照：编辑期间删掉的那一条会落空（ok:false），写回时跳过并计数，
   不会把第 N 行写到别的候选身上。 */
export function scriptItemsOf(scenes, parsed, opts) {
  const list = shotList(scenes);
  const order = (opts && opts.order) || null;
  const blocks = (parsed && parsed.blocks) || [];
  const items = [];
  let skipped = 0;
  const seen = new Set();
  blocks.forEach(b => {
    const i = (Number(b && b.n) || 0) - 1;
    if (i < 0 || i >= list.length || seen.has(i)) { skipped++; return; }
    seen.add(i);
    const sh = list[i];
    const live = ((sh && sh.candidates) || []).filter(Boolean);
    const fixed = order && typeof order.get === 'function' ? order.get(sh.id) : null;
    ((b && b.cands) || []).forEach(cc => {
      const k = Number(cc && cc.n) || 0;
      const vid = (fixed && fixed.length >= k) ? fixed[k - 1]
        : ((live[k - 1] && live[k - 1].vid) || '');
      const c = vid ? live.find(x => x.vid === vid) : null;
      items.push({ shotId: sh.id, vid: vid || '', text: String(cc.text == null ? '' : cc.text), ok: !!c });
    });
  });
  return { items, skipped };
}

/* 写入唯一落点：按稿子认出的那一项，只改那一条候选自己的描述。
   `opts.order`（Map<镜头 id, vid[]>）是打开剧本那一刻的候选顺序 —— 候选行按那一份对号，
   编辑期间新增 / 删掉的候选不会让第 N 行写到别的候选身上（对不上就跳过并计数）。
   返回计数给界面照实报数：认出的段落 / 写进去的主描述与候选 / 对不上号被跳过的段落与候选。
   `promptUpd` 记的是**主描述**（这一镜默认那条候选）被改写的条数 —— 当年「画面：」那一行
   的落点就是它；`takeUpd` 记的是其余候选各自被改写的条数。 */
export function applyScript(scenes, parsed, opts) {
  const list = shotList(scenes);
  const blocks = (parsed && parsed.blocks) || [];
  const { items, skipped } = scriptItemsOf(scenes, parsed, opts);
  const byId = new Map(list.map(sh => [sh.id, sh]));
  const r = { upd: 0, promptUpd: 0, takeUpd: 0, takeSkipped: 0, skipped,
    blocks: blocks.length, total: list.length };
  items.forEach(it => {
    if (!it.ok) { r.takeSkipped++; return; }          // 候选被删了：跳过并计数
    const sh = byId.get(it.shotId);
    if (!sh) { r.takeSkipped++; return; }
    const c = (sh.candidates || []).find(x => x && x.vid === it.vid);
    if (!c) { r.takeSkipped++; return; }
    const v = String(it.text).replace(/\s+$/, '');
    if (v === String(c.prompt == null ? '' : c.prompt).replace(/\s+$/, '')) return;
    setTakePrompt(sh, c, v);
    if (defaultTakeOf(sh) === c) r.promptUpd++; else r.takeUpd++;
    r.upd++;
  });
  return r;
}
