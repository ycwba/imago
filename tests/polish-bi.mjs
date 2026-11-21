#!/usr/bin/env node
/* PolishBi（web/domain/polish-bi.cjs）的纯逻辑：
     · split：标记前主稿 / 标记后对照稿；无标记、主稿为空、对照稿为空都回退单稿；
     · stream：流式只推主稿，标记（含被片段劈开的半截）不上屏，onRef 只叫一次，
       reasoning（模型草稿）直通面板，result 优先用 chatStream 的整包回包。
   约定与各润色 Skill 正文「输出」段一致；单稿 Skill（纯朗读稿）靠这里的回退零改动兼容。
   模块是 UMD + .cjs，Node 侧**只能默认导入** —— 写成具名导入会拿到空。 */
import PolishBi from '../web/domain/polish-bi.cjs';

let bad = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

ok('模块默认导入拿到 MARK / split / stream',
  !!PolishBi && PolishBi.MARK === '【对照稿】'
  && typeof PolishBi.split === 'function' && typeof PolishBi.stream === 'function');

/* ---------- split：完整文本 ---------- */
const two = PolishBi.split('ENGLISH PROMPT\n\n【对照稿】\n\n中文对照的一段');
ok('双稿：标记前主稿、标记后对照稿，两侧都去首尾空白',
  two.main === 'ENGLISH PROMPT' && two.ref === '中文对照的一段');
const one = PolishBi.split('  就这一份稿，没有任何标记  ');
ok('单稿回退：找不到标记整份当主稿', one.main === '就这一份稿，没有任何标记' && one.ref === '');
const headMark = PolishBi.split('【对照稿】中文先出');
ok('标记写在开头（主稿为空）→ 整份当主稿，不拿对照稿当主稿',
  headMark.main === '【对照稿】中文先出' && headMark.ref === '');
const emptyRef = PolishBi.split('主稿在这\n【对照稿】');
ok('标记后没有对照稿（中途停了）→ 主稿保留、对照稿为空',
  emptyRef.main === '主稿在这' && emptyRef.ref === '');
ok('空入参 / null 不抛，回空主稿',
  PolishBi.split('').main === '' && PolishBi.split(null).ref === '');
const mid = PolishBi.split('主稿【对照稿】对照');
ok('标记不单独成行也认（切分只看这四个字）', mid.main === '主稿' && mid.ref === '对照');

/* ---------- stream：流式 ---------- */
function runStream(pieces, opts = {}) {
  const pushed = [];
  let refCalls = 0;
  const st = PolishBi.stream((piece, kind) => pushed.push({ piece, kind }), () => { refCalls++; });
  for (const p of pieces) st.feed(p, opts.reasoning ? 'reasoning' : 'content');
  return { pushed, refCalls, out: st.result(opts.finalText) };
}
const joined = rows => rows.filter(r => r.kind === 'content').map(r => r.piece).join('');

const full2 = runStream(['英文正式稿第一段。\n', '第二段。\n【对', '照稿】', '\n中文对照正文']);
ok('流式双稿：面板只收到主稿（含标记前的收尾空白），标记与对照稿不上屏',
  joined(full2.pushed) === '英文正式稿第一段。\n第二段。\n');
ok('劈成两半的标记没有漏出半截', joined(full2.pushed).indexOf('【对') < 0);
ok('onRef 恰好叫一次（提示「对照稿生成中」）', full2.refCalls === 1);
ok('result：主稿与对照稿都齐', full2.out.main === '英文正式稿第一段。\n第二段。' && full2.out.ref === '中文对照正文');

const one2 = runStream(['一段普通的', '单稿正文']);
ok('流式单稿：没有标记时全部上屏（不被扣字）', joined(one2.pushed) === '一段普通的单稿正文' && one2.refCalls === 0
  && one2.out.main === '一段普通的单稿正文' && one2.out.ref === '');

const tail = runStream(['正文写到一半写出了半个标记【对']);
ok('结尾恰好是标记前缀：扣住不上屏，result 仍按整份当主稿',
  joined(tail.pushed) === '正文写到一半写出了半个标记' && tail.out.main === '正文写到一半写出了半个标记【对');

const mid2 = runStream(['主稿', '【对照稿】', '对照稿正文']);
ok('整枚标记一次到达：主稿停推、onRef 叫一次', joined(mid2.pushed) === '主稿' && mid2.refCalls === 1
  && mid2.out.ref === '对照稿正文');

const stopped = runStream(['已出的主稿部分。\n第二行【对']);
ok('中途停止：主稿已出部分就是主稿', stopped.out.main === '已出的主稿部分。\n第二行【对' && stopped.out.ref === '');

const whole = runStream([], { finalText: '整包主稿\n【对照稿】整包对照' });
ok('有的家只给整包不给流：result 用 chatStream 的回包切分',
  joined(whole.pushed) === '' && whole.out.main === '整包主稿' && whole.out.ref === '整包对照');
const preferFinal = runStream(['流式主稿【对照稿】流式对照'], { finalText: '整包主稿\n【对照稿】整包对照' });
ok('整包与流都在时以整包为准（收尾以正规回包为准）',
  preferFinal.out.main === '整包主稿' && preferFinal.out.ref === '整包对照');

ok('空流 + 空回包不抛', PolishBi.stream(() => {}, null).result('').main === '');

/* reasoning（模型草稿）直通面板：进面板、不进正文累计、不算 onRef。 */
{
  const rows = [];
  let refCalls = 0;
  const st = PolishBi.stream((p, k) => rows.push({ p, k }), () => { refCalls++; });
  st.feed('模型在想…', 'reasoning');
  st.feed('正文A【对照稿】对照B', 'content');
  ok('reasoning 直通面板、不进正文',
    rows[0].p === '模型在想…' && rows[0].k === 'reasoning'
    && rows.filter(r => r.k === 'content').map(r => r.p).join('') === '正文A'
    && refCalls === 1);
}

console.log(bad ? `\n润色双稿切分判据：${bad}/${checks} 条红` : `\n润色双稿切分判据：${checks}/${checks} 全绿`);
process.exit(bad ? 1 : 0);
