#!/usr/bin/env node
/* git 范围判据：盯住「什么该进库、什么不该进库」这条边界。
   为什么要有这一份：.gitignore 是**唯一**决定提交范围的闸，而它不报错 ——
   一次 `git add -A` 就能把真实密钥、几百 MB 用户作品、探针残留推进历史，
   而历史里的那一份要清得重写远端。

   范围：库里已有的文件（跟踪状态）+ 忽略规则与规范正文的一致性。
   不管工作区里还没被 add 的东西 —— 那是 .gitignore 的活，不是这里的活。

   判据：
     S1 库里没有命中 .gitignore 的文件 —— 忽略规则与跟踪状态不许打架
        （.zcodeignore 就是这么打架的：忽略规则挡着它，它却还在库里）。
     S2 库里没有密钥族（根级证书与私钥）。
     S3 库里没有用户数据族（.data / .renders / .skills / 库根四类 / 提示词归档 / 历史默认名）。
     S4 仓库根没有散落的媒体与归档。
     S5 vendored 依赖必须留在库里（被忽略掉的 vendored 文件会让新克隆缺依赖）。
     S6 规范正文点名的每一族路径都必须真的被挡住
        （文档与实际一致：文档说挡了、实际没挡，等于没写）。
     S7 判据自检：合成违例必须被探到、正确写法不误报。 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let bad = 0, n = 0;
function ok(cond, msg) {
  n++;
  if (!cond) { bad++; console.log('  ✗ ' + msg); }
}

/* ---------- git 取数 ---------- */
function git(args) {
  try {
    return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return ''; }
}
const tracked = () => git(['ls-files']).split(/\r?\n/).filter(Boolean);
/* 忽略规则与跟踪状态打架的那一批：既被跟踪、又命中 .gitignore。 */
const trackedButIgnored = () => git(['ls-files', '-i', '-c', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
const isIgnored = p => {
  try {
    cp.execFileSync('git', ['check-ignore', '-q', '--no-index', '--', p], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
};

/* ---------- 族表：文档点名的那一族 ↔ 库里不许出现的那一族 ↔ 探针路径 ---------- */
const FAMILIES = [
  { doc: '.data/', probe: '.data/state.json', label: '状态仓' },
  { doc: '.renders/', probe: '.renders/a.json', label: '成片目录' },
  { doc: '.skills/', probe: '.skills/x/SKILL.md', label: '用户 Skill' },
  { doc: 'node_modules/', probe: 'node_modules/x/index.js', label: '依赖' },
  { doc: '.env', probe: '.env', label: '平台密钥' },
  { doc: '成像/', probe: '成像/白膜/a.json', label: '库根顶层' },
  { doc: '图片/', probe: '图片/a.png', label: '库根 · 图片' },
  { doc: '视频/', probe: '视频/a.mp4', label: '库根 · 视频' },
  { doc: '音频/', probe: '音频/a.wav', label: '库根 · 音频' },
  { doc: '其他/', probe: '其他/a.bin', label: '库根 · 其他' },
  { doc: '提示词/', probe: '提示词/a.md', label: '提示词归档' },
  { doc: '.assets/', probe: '.assets/a.json', label: '历史默认名' },
  { doc: '文件/', probe: '文件/a.json', label: '历史默认名' },
  { doc: 'prompts/', probe: 'prompts/a.json', label: '历史默认名' },
];
/* 密钥族：根级钉死（tests/fixtures/pki 里那两份是判据自己用的自签证书，必须留在库里）。 */
const KEY_AT_ROOT = [/^\/[^/]*\.(pem|key|p12|pfx)$/, /^\/(id_rsa|id_ed25519)/];
/* 用户数据族：库里出现即错（这些是用户机器上长出来的东西）。 */
const DATA_FAMILIES = ['.data/', '.renders/', '.skills/', 'node_modules/',
  '成像/', '图片/', '视频/', '音频/', '其他/', '提示词/', '.assets/', '文件/', 'prompts/'];
/* 仓库根散落的媒体与归档（历史上根目录那个 probe-clip.mp4 就是这么进库的）。
   只认**根级**：tests/fixtures/ 里的媒体是判据自己的素材，必须留在库里。 */
const ROOT_MEDIA = /^[^/]+\.(mp4|mov|webm|avi|mkv|mp3|wav|flac|png|jpg|jpeg|gif|webp|zip|7z|tar|gz)$/;

const files = tracked();

/* ---------- S1 忽略规则与跟踪状态不许打架 ---------- */
for (const f of trackedButIgnored()) {
  ok(false, '库里有个文件同时被 .gitignore 挡住（规则与事实打架）：' + f);
}

/* ---------- S2 库里没有密钥族 ---------- */
for (const f of files) {
  if (KEY_AT_ROOT.some(re => re.test('/' + f))) {
    ok(false, '库里有疑似密钥文件：' + f);
  }
}

/* ---------- S3 库里没有用户数据族 ---------- */
for (const f of files) {
  const hit = DATA_FAMILIES.some(p => f === p.replace(/\/$/, '') || f.startsWith(p));
  if (hit) ok(false, '库里有用户数据路径：' + f);
}

/* ---------- S4 仓库根没有散落的媒体与归档 ---------- */
for (const f of files) {
  if (ROOT_MEDIA.test(f)) ok(false, '仓库根有散落的媒体 / 归档：' + f);
}

/* ---------- S5 vendored 依赖必须留在库里 ---------- */
const vendorDir = path.join(ROOT, 'web', 'vendor');
if (fs.existsSync(vendorDir)) {
  const set = new Set(files);
  const walkVendor = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkVendor(full);
      else {
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        ok(set.has(rel), 'vendored 依赖不在库里（新克隆会缺件）：' + rel);
      }
    }
  };
  walkVendor(vendorDir);
}

/* ---------- S6 文档点名的每一族都必须真的被挡住 ---------- */
const doc = read('AGENTS.md');
const boundaryAt = doc.indexOf('### 提交边界与用户数据');
const boundary = boundaryAt >= 0 ? doc.slice(boundaryAt, doc.indexOf('\n### ', boundaryAt + 5) > 0 ? doc.indexOf('\n### ', boundaryAt + 5) : undefined) : '';
for (const fam of FAMILIES) {
  ok(boundary.includes(fam.doc), 'AGENTS.md「提交边界与用户数据」没点名这一族：' + fam.doc + '（' + fam.label + '）');
  ok(isIgnored(fam.probe), '文档点名了 ' + fam.doc + '，但 .gitignore 没挡住它（探针：' + fam.probe + '）');
}

/* ---------- S7 判据自检 ---------- */
/* 合成违例必须被探到：伪造一条「库里出现用户数据路径」的记录。 */
const synthData = ['视频/我的片子.mp4'];
ok(synthData.some(f => DATA_FAMILIES.some(p => f.startsWith(p))), '判据自检：合成的用户数据路径没被探出来');
/* 合成违例必须被探到：伪造一条「根级散落媒体」。 */
const synthMedia = ['probe-clip.mp4'];
ok(synthMedia.some(f => ROOT_MEDIA.test(f)), '判据自检：合成的根级散落媒体没被探出来');
/* 合成违例必须被探到：伪造一条「根级私钥」。 */
const synthKey = ['id_rsa'];
ok(synthKey.some(f => KEY_AT_ROOT.some(re => re.test('/' + f))), '判据自检：合成的根级私钥没被探出来');
/* 正确写法不误报：判据自用的自签证书与 vendored 文件必须算作合法。 */
ok(!ROOT_MEDIA.test('tests/fixtures/media/probe-clip.mp4'), '判据自检：判据自己的 fixture 被误判成根级媒体');
ok(!DATA_FAMILIES.some(p => 'tests/fixtures/pki/tunnel-test-key.pem'.startsWith(p)), '判据自检：判据自己的 fixture 被误判成用户数据');
ok(files.some(f => f.startsWith('web/vendor/')), '判据自检：vendored 依赖一个都不在库里（不该发生）');

console.log(bad ? '\n✗ git 范围：' + bad + ' / ' + n + ' 条对不上' : '\n✓ git 范围：' + n + ' 条与实际一致');
process.exit(bad ? 1 : 0);
