/* 剧本视图：把分镜上的**画面**写成一份可编辑的稿子，反向解析回同一批镜头的 `sh.prompt`。
   它不是第二份数据 —— 打开时按当前分镜现算，写入只落 `sh.prompt`，所以右栏改一句画面说明，
   下次打开剧本就是新的；剧本里改一句，右栏读到的也是新的。
   台词不在这份稿子里：它有自己的面板（剪辑右栏「台词」那一档），由 AI 按画面生成或手写给，
   与提示词互不带动 —— 一份稿子同时握着画面与台词，改画面就会连着改台词，那是两件事。

   格式（人可读、程序也好认）：
     # 场景 1 · 河岸
     ## 镜头 1 · 开场
     画面：…
   镜头号是**全片连续号**（与左栏从上往下数的一致）；场景行只用来分组，不参与定位。
   一个值可以写多行：续行缩进两个空格。要把这一镜的画面清空就把冒号后面留空；
   删掉整段不等于删镜头（镜头结构只在左栏改）。 */
const FIELD_OF = { '画面': 'prompt' };
const HEAD = /^##\s*镜头\s*(\d+)/;
const FIELD = /^(画面)\s*[：:]\s?(.*)$/;

function linesOf(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n');
}
function fieldText(label, v) {
  const ls = linesOf(v);
  return label + '：' + ls[0] + (ls.length > 1 ? '\n' + ls.slice(1).map(x => '  ' + x).join('\n') : '');
}

/* 当前分镜 → 剧本正文。所有镜头都写出来（画面还没写的也留一行空「画面：」，
   否则用户没法在一份空稿子上给某一镜补第一段描述）。 */
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
      out.push(fieldText('画面', sh && sh.prompt));
      out.push('');
    });
  });
  return out.length ? out.join('\n').replace(/\s+$/, '') + '\n' : '';
}

/* 剧本正文 → 段落表。认不出的正文一律不写：这是「按稿子改现有分镜」，不是「把稿子随便塞进镜头」。
   返回 { blocks:[{ n, fields:{ prompt? } }] }；`n` 是镜头号（从 1 开始）。 */
export function parseScript(text) {
  const blocks = [];
  let cur = null;
  let fld = '';
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(raw => {
    /* 续行：缩进两个空格。续行里出现什么字都不当标记（提示词里写「台词：」也不会误拆）。 */
    if (/^ {2}/.test(raw)) {
      if (cur && fld) cur.fields[fld] += '\n' + raw.slice(2);
      return;
    }
    const line = raw.trimEnd();
    if (!line.trim()) { fld = ''; return; }
    const h = HEAD.exec(line);
    if (h) {
      const n = parseInt(h[1], 10);
      cur = Number.isFinite(n) && n > 0 ? { n, fields: {} } : null;
      if (cur) blocks.push(cur);
      fld = '';
      return;
    }
    if (/^#\s/.test(line)) { cur = null; fld = ''; return; }   // 场景行：只分组，不定位
    const m = FIELD.exec(line);
    if (m && cur) {
      fld = FIELD_OF[m[1]];
      cur.fields[fld] = m[2] || '';
      return;
    }
    /* 段落里既不是字段、也不是场景 / 镜头标记的自由文字：不猜它属于哪一项，直接忽略。 */
    fld = '';
  });
  return { blocks };
}

/* 写入唯一落点：按镜头号找到那一条，只改稿子里真的出现的那一项。
   返回计数给界面照实报数：认出的段落 / 写进去的镜头 / 对不上号被跳过的段落。 */
export function applyScript(scenes, parsed) {
  const list = (scenes || []).flatMap(sc => (sc && sc.shots) || []);
  const blocks = (parsed && parsed.blocks) || [];
  const seen = new Set();
  const r = { upd: 0, promptUpd: 0, skipped: 0, blocks: blocks.length, total: list.length };
  blocks.forEach(b => {
    const i = (Number(b && b.n) || 0) - 1;
    if (i < 0 || i >= list.length || seen.has(i)) { r.skipped++; return; }
    seen.add(i);
    const sh = list[i];
    const f = (b && b.fields) || {};
    if ('prompt' in f) {
      const v = String(f.prompt).replace(/\s+$/, '');
      if (v !== String(sh.prompt || '').replace(/\s+$/, '')) { sh.prompt = v; r.promptUpd++; r.upd++; }
    }
  });
  return r;
}
