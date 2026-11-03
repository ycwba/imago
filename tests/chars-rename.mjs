/* 素材改名回填 `Chars.renameShotRefs` 的三条 token 边界（纯函数，vm 装载 domain/chars.js）：
   ① `@小雅` 整名 → 换；② `@小雅·三视图` 只换名字段；③ `@小雅雅` 是另一位 → 不动。
   另核 refMeta：id 对上的刷 label，老数据没 id 的按 label 兜底（只改 label 不写 id）。 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'web/domain/chars.js'), 'utf8');

const sandbox = {
  window: {
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])),
    icon: () => '',
    nameKey: s => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' },
    LS: { get: () => null, set: () => {} },
    Store: { read: (_k, d) => d, write: () => ({ ok: true }) },
  },
  console,
  setTimeout, clearTimeout,
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, parseInt, parseFloat, isNaN,
};
sandbox.window.window = sandbox.window;
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox, { filename: 'web/domain/chars.js' });
const Chars = sandbox.window.Chars;
if (!Chars || typeof Chars.renameShotRefs !== 'function') {
  console.error('✗ Chars.renameShotRefs 没挂出来');
  process.exit(1);
}

let bad = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
};

const ID = 'c_abc123';
const shot = (prompt, refMeta) => ({ prompt, refMeta: refMeta || [], candidates: [] });
const projOf = shots => [{ id: 'p1', scenes: [{ id: 's1', shots }] }];

/* ① 整名边界：@小雅 → @小美；串尾 / 空白 / 标点都算名字结束 */
{
  const shots = [shot('镜头里 @小雅 站着，@小雅。走'), shot('结尾 @小雅')];
  const n = Chars.renameShotRefs(projOf(shots), { id: ID, oldName: '小雅', newName: '小美' });
  ok('整名 @小雅 → @小美（空白 / 标点 / 串尾都算边界）',
    n === 2 && shots[0].prompt === '镜头里 @小美 站着，@小美。走' && shots[1].prompt === '结尾 @小美',
    'n=' + n + ' p0=' + shots[0].prompt + ' p1=' + shots[1].prompt);
}

/* ② 资产 token：@小雅·三视图 只换名字段，后缀留着 */
{
  const shots = [shot('用 @小雅·三视图 这张')];
  const n = Chars.renameShotRefs(projOf(shots), { id: ID, oldName: '小雅', newName: '小美' });
  ok('资产 token @小雅·三视图 → @小美·三视图（只换名字段）',
    n === 1 && shots[0].prompt === '用 @小美·三视图 这张',
    'n=' + n + ' p=' + shots[0].prompt);
}

/* ③ 更长的另一位：@小雅雅 一个字都不能动 */
{
  const shots = [shot('主角是 @小雅雅，配角是 @小雅')];
  const n = Chars.renameShotRefs(projOf(shots), { id: ID, oldName: '小雅', newName: '小美' });
  ok('更长的 @小雅雅 不动，@小雅 照换',
    n === 1 && shots[0].prompt === '主角是 @小雅雅，配角是 @小美',
    'n=' + n + ' p=' + shots[0].prompt);
}

/* ④ refMeta：id 对上的刷 label（整名 / 带 · 后缀 / 老数据带 @ 前缀） */
{
  const shots = [shot('', [
    { id: ID, label: '小雅' },
    { id: ID, label: '小雅·三视图' },
    { id: ID, label: '@小雅·设定' },
    { id: 'other', label: '小雅' },
  ])];
  const n = Chars.renameShotRefs(projOf(shots), { id: ID, oldName: '小雅', newName: '小美' });
  const ms = shots[0].refMeta;
  ok('refMeta：id 对上的三种 label 都换名段，别人的不动',
    n === 1 && ms[0].label === '小美' && ms[1].label === '小美·三视图'
    && ms[2].label === '@小美·设定' && ms[3].label === '小雅',
    JSON.stringify(ms.map(x => x.label)) + ' n=' + n);
}

/* ⑤ 老工程 refMeta 没 id：按 label 兜底认一次，只改 label 不写 id */
{
  const shots = [shot('', [{ id: null, label: '小雅·三视图' }, { label: '别人' }])];
  const n = Chars.renameShotRefs(projOf(shots), { id: ID, oldName: '小雅', newName: '小美' });
  const ms = shots[0].refMeta;
  ok('老条目没 id：label 命中才改、不补写 id',
    n === 1 && ms[0].label === '小美·三视图' && ms[0].id == null && ms[1].label === '别人',
    JSON.stringify(ms));
}

/* ⑥ 一镜多处只算一次；候选的 prompt 也跟着换 */
{
  const sh = shot('@小雅 和 @小雅·三视图', []);
  sh.candidates = [{ prompt: '候选里的 @小雅' }, { prompt: '没引用' }];
  const n = Chars.renameShotRefs([{ id: 'p1', scenes: [{ id: 's1', shots: [sh] }] }], { id: ID, oldName: '小雅', newName: '小美' });
  ok('一镜多处计一次；候选 prompt 一起换',
    n === 1 && sh.prompt === '@小美 和 @小美·三视图'
    && sh.candidates[0].prompt === '候选里的 @小美' && sh.candidates[1].prompt === '没引用',
    'n=' + n + ' p=' + sh.prompt + ' c0=' + sh.candidates[0].prompt);
}

/* ⑦ 名字没变 / 旧名为空 → 0 */
{
  const shots = [shot('@小雅')];
  ok('名字没变不动数据', Chars.renameShotRefs(projOf(shots), { id: ID, oldName: '小雅', newName: '小雅' }) === 0
    && shots[0].prompt === '@小雅');
  ok('旧名为空不动数据', Chars.renameShotRefs(projOf(shots), { id: ID, oldName: '', newName: '小美' }) === 0
    && shots[0].prompt === '@小雅');
}

/* ⑧ 旧名里的正则特殊字符不炸 */
{
  const shots = [shot('用 @小(雅) 看')];
  const n = Chars.renameShotRefs(projOf(shots), { id: ID, oldName: '小(雅)', newName: '小美' });
  ok('旧名含正则特殊字符照换', n === 1 && shots[0].prompt === '用 @小美 看', shots[0].prompt);
}

console.log(bad ? '\n' + bad + ' 项未通过' : '\n全部通过');
process.exit(bad ? 1 : 0);
