/* SplitAssets — 拆分镜「喂哪几条素材」：范围解析 / 目录清单 / AI 挑选 / 落盘挂图。
   从 web/director/engine.js 拆出；库、图片槽位与提示词常量由 createSplitAssets 注入。 */
import { parseJsonLoose, ctxClip } from './util.js';

export function createSplitAssets(ctx) {
  const { BOARD_CTX_SHORT, BOARD_CTX_PROMPT, PICK_SOFT_MAX, RULE_WITHOUT, RULE_WITH, AT_TAIL, libIdx, libPicChoices, addLibPicToShot, nameKey, TextAI } = ctx;

const SplitAssets = {
  /* 库里所有**有名**条目 —— `@名字` 认的是名字，没名字的条目喂过去 AI 也指不回来。 */
  named() {
    const D = window.Chars;
    return ((D && D.Lib && D.Lib.list()) || []).filter(x => x && String(x.name || '').trim());
  },
  /* 一个范围值对应哪些条目：'none' / 'all' / 'g:<组名>'（'g:__none' = 未分组）。 */
  resolve(v) {
    const D = window.Chars;
    const none = { kind: 'none', name: '', entries: [] };
    if (!D || !D.Lib || !v || v === 'none') return none;
    if (v === 'all') return { kind: 'all', name: '', entries: SplitAssets.named() };
    if (String(v).indexOf('g:') !== 0) return none;        // 认不出的取值（分组被删了）当不导入
    const g = String(v).slice(2);
    if (!g) return none;
    return { kind: 'group', name: g === '__none' ? '未分组' : g,
      entries: SplitAssets.named().filter(x => D.Lib.groupMatch(x, g)) };
  },
  /* 表单里那一排选项（条数这一刻现数）。库为空返回空表 —— 调用方整块不画这一行，
     「这一排存在但只有『不导入』一项可点」与「这台机器还没攒素材」是两件事。 */
  scopes() {
    const D = window.Chars;
    const cnt = v => SplitAssets.resolve(v).entries.length;
    if (!D || !D.Lib || !cnt('all')) return [];
    const out = [{ v: 'none', t: '不导入素材（AI 自己起名）' },
      { v: 'all', t: '整个素材库（' + cnt('all') + ' 条）' }];
    const n = cnt('g:__none');
    if (n) out.push({ v: 'g:__none', t: '未分组（' + n + ' 条）' });
    (D.Lib.groups() || []).forEach(x => {
      const c = cnt('g:' + x.name);
      if (c) out.push({ v: 'g:' + x.name, t: x.name + '（' + c + ' 条）' });
    });
    return out;
  },
  scopeText(v) {
    const s = SplitAssets.resolve(v);
    if (s.kind === 'group') return '分组「' + s.name + '」 ' + s.entries.length + ' 条';
    if (s.kind === 'all') return '整个素材库 ' + s.entries.length + ' 条';
    return '不导入素材';
  },
  last() {
    let v = '';
    try { v = localStorage.getItem('dir_asset_scope') || ''; } catch (e) { v = ''; }
    return SplitAssets.scopes().some(o => o.v === v) ? v : 'none';
  },
  remember(v) { try { localStorage.setItem('dir_asset_scope', String(v || 'none')); } catch (e) {} },
  /* 第 1 段：每条一行，只需要让 AI 认得出「是谁」。没有预览图的那几条照实标出来 ——
     它们挂得上名字、挂不上图，与其让 `bind` 报一句「还没有预览图」不如先让 AI 少选。 */
  catalog(entries) {
    const D = window.Chars;
    return (entries || []).map(x => {
      const kindZh = (D && D.LIB_KINDS && D.LIB_KINDS[D.libKindOf(x)]) || '素材';
      const desc = ctxClip((D && D.descOf && D.descOf(x)) || '', BOARD_CTX_SHORT);
      const pic = (D && D.picOf && D.picOf(x)) || '';
      return '- ' + String(x.name || '').trim() + ' · ' + kindZh + ' · '
        + (desc || '（没有描述）') + (pic ? '' : ' · 还没有预览图');
    }).join('\n');
  },
  /* 第 2 段：只给被挑中的那几条完整描述（引用写法那句话由 `stage` 的 rule 说，这里不重复）。 */
  fullText(entries) {
    const D = window.Chars;
    return (entries || []).map(x => {
      const kindZh = (D && D.LIB_KINDS && D.LIB_KINDS[D.libKindOf(x)]) || '素材';
      const desc = ctxClip((D && D.descOf && D.descOf(x)) || '', BOARD_CTX_PROMPT);
      return '- @' + String(x.name || '').trim() + '（' + kindZh + '）：' + (desc || '（没有描述）');
    }).join('\n');
  },
  /* 让 AI 从目录里挑几条（非流式：这一段不需要边收边显，挑完才写整份分镜）。
     返回 {picked, unknown} —— `unknown` 是「AI 编出来的、清单里没有的名字」几个，
     照实交回调用方报数（规矩二/三：名字必须来自清单、挑不出就不喂，静默丢掉等于骗人）。
     问失败**往上抛**：怎么办是 `stage` 的政策，这一层只负责契约。 */
  async pick(reg, text, entries) {
    const list = entries || [];
    if (!list.length || !String(text || '').trim()) return { picked: [], unknown: 0 };
    const sys = '你是选角指导。下面是本机素材库里的条目清单，从里面挑出这段文字用得到的那几条，只返回 JSON。\n'
      + '格式：{"assets":["素材名","素材名"]}\n'
      + '要求：\n'
      + '1. 名字必须**逐字**来自清单（不带 @、不改字、不要发明）。\n'
      + '2. 只挑文字里真出现的主体 / 场景 / 道具，一般不超过 ' + PICK_SOFT_MAX + ' 条；'
      + '标了「还没有预览图」的那几条别优先挑。\n'
      + '3. 挑不出相关的就返回 {"assets":[]}，不要凑数。';
    const j = parseJsonLoose(await TextAI.chat(reg, sys,
      '素材清单:\n' + SplitAssets.catalog(list) + '\n\n这段文字:\n' + String(text).trim()));
    const raw = (j && (j.assets || j.picked || j.names)) || [];
    const byKey = libIdx(list);
    const picked = []; const seen = new Set(); let unknown = 0;
    (Array.isArray(raw) ? raw : []).forEach(t => {
      const s = String(t == null ? '' : t).trim().replace(/^@+/, '');
      if (!s) return;
      const x = byKey.get(nameKey(s));
      if (!x) { unknown++; return; }
      const k = nameKey(x.name);
      if (!seen.has(k)) { seen.add(k); picked.push(x); }
    });
    return { picked: picked, unknown: unknown };
  },
  /* 一次拆分镜 / 改分镜只问这一趟（审查弹窗里点「重新规划」复用同一份挑中名单，不重复扣 tokens）。
     三条规矩落在这里：范围要显示出来（`sub`）、挑不出就不喂第二段（`full` 空）、
     问失败按「不导入」继续并吭声（`warn`）—— 界面不能把「没问成」演成「AI 选了不导入」。 */
  async stage(reg, text, scopeVal) {
    const v = SplitAssets.scopes().some(o => o.v === scopeVal) ? scopeVal : 'none';
    const out = { scopeVal: v, picked: [], full: '', unknown: 0, sub: '', rule: RULE_WITHOUT, warn: '' };
    const cat = SplitAssets.resolve(v);
    /* 「不导入」是默认档，也是这一趟真的什么都没做：那一条什么都不报 ——
       审查弹窗顶部那行本来就够挤了，天天挂一句「素材：不导入」等于没说。
       真选了范围才报（规矩四：范围要显示出来），选了却挑不出也要报（规矩三：两次调用都报数）。 */
    if (cat.kind === 'none') return out;
    if (!cat.entries.length || !String(text || '').trim()) {
      out.sub = '素材：' + SplitAssets.scopeText(v)
        + (!cat.entries.length ? '，这个范围里此刻一条也没有' : '，没给出用来挑素材的话，这一次没问');
      return out;
    }
    let res;
    try { res = await SplitAssets.pick(reg, text, cat.entries); }
    catch (e) {
      out.warn = '问该用哪些素材没成（' + errText(e) + '），这一次按不导入继续';
      out.sub = '素材：没问成（' + SplitAssets.scopeText(v) + ' 的清单没能挑）';
      return out;
    }
    out.picked = res.picked; out.unknown = res.unknown;
    out.full = SplitAssets.fullText(res.picked);
    if (out.full) out.rule = RULE_WITH + out.full;
    const bits = ['素材：' + SplitAssets.scopeText(v) + ' 里挑中 ' + res.picked.length + ' 条'];
    if (res.unknown) bits.push(res.unknown + ' 个名字不在清单里，已丢掉');
    out.sub = bits.join(' · ');
    return out;
  },
  /* 落盘：新镜头的 prompt 里写了 `@名字`（或 `@名字·资产名`）就把那一张挂进参考图。
     **不改写提示词本身** —— `@名字` 就是 `refMeta.label`、也就是芯片上显示的那一串，
     提交前由 `refTokenize` 现换成 `@参考图N`；在这里替换等于把同一份引用记到两个地方，
     用户之后在芯片上删一张，提示词里那句 `@小雅` 就变成一个不存在的东西。
     带不上的几种（型号没有槽位 / 这一镜已选首尾帧 / 超出上限 / 那条还没图）由
     `addLibPicToShot` 给出原因，这里只收集第一句并报出去。 */
  bind(shots, picked) {
    const r = { n: 0, shots: 0, dup: 0, why: '' };
    const list = picked || [];
    if (!list.length) return r;
    const byKey = libIdx(list);
    (shots || []).forEach(sh => {
      const p = String((sh && sh.prompt) || '');
      if (!p) return;
      const done = new Set();
      let got = 0;
      /* token 取到空白 / 另一个 @ 为止，`素材名·资产名` 连着中点一起拿；尾上标点由 `AT_TAIL` 洗。 */
      (p.match(/@[^\s@]+/g) || []).forEach(tok => {
        const cut = tok.slice(1).split('·');
        const nm = cut[0].replace(AT_TAIL, '');
        const note = (cut[1] || '').replace(AT_TAIL, '').trim();
        const x = byKey.get(nameKey(nm));
        if (!x) return;
        const id = nameKey(nm) + '·' + nameKey(note);
        if (done.has(id)) return;
        done.add(id);
        let pick;
        if (note) {
          const hit = libPicChoices(x).find(c => nameKey(c.note) === nameKey(note));
          if (!hit) return;                                  // 名字对得上但那张资产没了：不硬凑预览图
          pick = hit;
        }
        const one = addLibPicToShot(sh, x, pick);
        if (one.ok) { if (one.dup) r.dup++; else { r.n++; got++; } return; }
        if (!r.why) r.why = one.why || '';
      });
      if (got) r.shots++;
    });
    return r;
  },
};
  return SplitAssets;
}
