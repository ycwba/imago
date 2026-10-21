#!/usr/bin/env node
/* 剪辑引擎里那几段**纯函数**的常驻回归：切片就近落格、热区排序、导出素材的时间点命名。
   跑法：`node tests/editing.cjs`（不启动浏览器，也不碰真实数据）。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
/* 剪辑与导出的纯函数现在分在 engine 那一层的两份以上：engine.js 自己（热区）与
   engine/frames.js（切片几何）、engine/export.js（成片秒命名 / 配音区间），往后还会继续按域搬。
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
vm.runInContext([fn('clipTimeLabel'), fn('voiceFilmRange'), fn('tileFrames'), fn('chunkHot')].join('\n'), ctx);

ok('成片秒命名 0 → 00m00.0s', ctx.clipTimeLabel(0) === '00m00.0s');
ok('成片秒命名 12.3 → 00m12.3s', ctx.clipTimeLabel(12.3) === '00m12.3s');
ok('成片秒命名 125.4 → 02m05.4s', ctx.clipTimeLabel(125.4) === '02m05.4s');
const vr = ctx.voiceFilmRange({ speed: 2 }, { f0: 10 }, { start: 4, dur: 2, spd: 1 });
ok('配音区间按画面倍速折算到成片秒', vr[0] === 12 && vr[1] === 13, JSON.stringify(vr));

const got = new Map([[0, 'a'], [1, 'b'], [2, 'c']]);
const tiles = ctx.tileFrames(got, [0.1, 1.1, 2.1], 0, 3, 1);
ok('切片就近落格', tiles[0] === 'a' && tiles[1] === 'b' && tiles[2] === 'c', JSON.stringify(tiles));
const hot = ctx.chunkHot([[0, 1], [5, 6], [10, 11]], 6.4);
ok('热区块排到队头', hot[0][0] === 5, JSON.stringify(hot));

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
