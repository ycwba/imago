#!/usr/bin/env node
/* 剪辑引擎里那几段**纯函数**的常驻回归：取帧块的排队顺序、语义检索排序。
   跑法：`node tests/editing.cjs`（不启动浏览器，也不碰真实数据）。
   磁贴「就近落格」那一档已随取帧管线换成 strip 的就近顶上（`frameAtTime`），
   判据搬进 tests/director-strip.mjs（显示层帧计划那一份）。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
/* 剪辑与导出的纯函数现在分在 engine 那一层的两份以上：engine.js 自己（热区）与
   engine/frames.js（取帧块）、engine/export.js（成片计划），往后还会继续按域搬。
   判据按名字找函数体，所以语料是**整层**而不是点名的几份文件 —— 搬家不需要同步改这里，
   也不会出现「函数搬走了、判据还在老地方找、找不到就当没这回事」那种静默失效。 */
const engineDir = path.join(root, 'web/director/engine');
const frags = ['web/director/engine.js',
  ...fs.existsSync(engineDir) ? fs.readdirSync(engineDir).filter(f => f.endsWith('.js')).map(f => 'web/director/engine/' + f) : []]
  .map(f => fs.readFileSync(path.join(root, f), 'utf8'));
const frag = frags.join('\n');
let bad = 0, n = 0;
function ok(name, cond, detail) { n++; if (cond) { console.log('  ✓ ' + name); return; } bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
function fn(name) {
  const at = frag.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('找不到函数：' + name);
  let i = frag.indexOf('{', at), d = 0;
  for (let j = i; j < frag.length; j++) {
    if (frag[j] === '{') d++;
    else if (frag[j] === '}' && --d === 0) return frag.slice(at, j + 1);
  }
  throw new Error('函数没有闭合：' + name);
}

const ctx = { console, Math, Number, Date, URL: { revokeObjectURL() {} } };
vm.createContext(ctx);
vm.runInContext(fn('chunkHot'), ctx);

const hot = ctx.chunkHot([[0, 1], [5, 6], [10, 11]], 6.4);
ok('热区块排到队头', hot[0][0] === 5, JSON.stringify(hot));
ok('没有热区时块序不动', ctx.chunkHot([[0, 1], [5, 6], [10, 11]], -1)[0][0] === 0);
ok('只有一块时原样返回', ctx.chunkHot([[2, 3]], 2)[0][0] === 2);

const sem = { window: {} };
vm.createContext(sem);
vm.runInContext(fs.readFileSync(path.join(root, 'web/domain/semantic.js'), 'utf8'), sem);
const docs = [
  { name: '雨夜天台', prompt: '两个人在下雨的天台摊牌', ts: 1 },
  { name: '晴天教室', prompt: '阳光照进教室', ts: 2 },
  { name: '旧仓库', prompt: '深夜的仓库', ts: 3 },
];
const ranked = sem.window.SemanticSearch.rank(docs, '下雨 天台', { limit: 3 });
ok('语义检索把真正相关的一条排第一', ranked.length === 1 && ranked[0].item.name === '雨夜天台', JSON.stringify(ranked.map(x => [x.item.name, x.score])));

console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
process.exit(bad ? 1 : 0);
