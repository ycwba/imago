#!/usr/bin/env node
/* 一次性迁移：把旧版手改提示词（sk_polish_* 除 sk_polish_ask）导出备份，再删掉这些键。
   背景：旧版设置页能手改提示词正文，正文存 localStorage 的 sk_polish_<kind>、
   经 datasync 镜像到 .data/sk_polish_<kind>.json。现在提示词以 Skill 为准（两级优先：
   Skill 正文 → 内置默认），旧键代码不再读 —— 但那是**用户写过的字**，删前必须先备份。
   ⚠ sk_polish_ask 是「润色前要不要先反问」那一档正经设置，**不许删**。
   跑法：node tools/migrate-skills.cjs [--yes]
   幂等：再跑一遍报 0 条、什么都不删。浏览器侧 localStorage 的同名键由代码不再读自然失效；
   这个脚本管 .data 里的镜像（服务端那份）。 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, '.data');
const SKILLS = process.env.SKILLS_DIR ? path.resolve(process.env.SKILLS_DIR) : path.join(root, '.skills');
const KEEP = 'sk_polish_ask';
const dry = !process.argv.includes('--yes');

function runMigrate() {
  if (!fs.existsSync(DATA)) { console.log('.data 不存在：' + DATA + ' —— 没有要清的。'); return 0; }
  const files = fs.readdirSync(DATA).filter(f => /^sk_polish_/.test(f) && !f.startsWith(KEEP));
  /* 只收 .json 正本（.bak 交给 data-store 自己的备份机制滚，别手删） */
  const targets = files.filter(f => /\.json$/.test(f) && !/\.bak/.test(f));
  console.log('.data 里 sk_polish_* 共 ' + targets.length + ' 个正本（' + KEEP + ' 保留不删）。');
  if (!targets.length) { console.log('没有要清的，收工。'); return 0; }

  const backup = {};
  targets.forEach(f => {
    const key = f.replace(/\.json$/, '');
    const raw = fs.readFileSync(path.join(DATA, f), 'utf8');
    try { backup[key] = JSON.parse(raw); }
    catch (e) { backup[key] = raw; }   // 镜像是纯文本（提示词正文），原文照收
  });
  Object.keys(backup).forEach(k => console.log('  · ' + k));

  if (dry) {
    console.log('\n这是**预览**（没删任何东西）。确认无误后加 --yes 真删：');
    console.log('  node tools/migrate-skills.cjs --yes');
    return 0;
  }

  /* 先备份到 .data/skills/（用户数据目录，不进版本库），再删 */
  const dir = path.join(DATA, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, 'legacy-prompts-backup-' + stamp + '.json');
  fs.writeFileSync(out, JSON.stringify({ at: Date.now(), keys: backup }, null, 2));
  console.log('\n已备份到：' + out);

  let n = 0;
  targets.forEach(f => {
    fs.unlinkSync(path.join(DATA, f));
    /* 连 .bak 也一起收走（同名 .bak 归档进备份目录，不删 —— data-store 的备份语义是留档） */
    const bak = path.join(DATA, f.replace(/\.json$/, '.bak.json'));
    if (fs.existsSync(bak)) { try { fs.renameSync(bak, path.join(dir, f.replace(/\.json$/, '.bak.json'))); } catch (e) {} }
    n++;
  });
  console.log('删完了：' + n + ' 个键（' + KEEP + ' 保留，其它设置一个没动）。');
  console.log('浏览器侧 localStorage 的同名键代码不再读，自然失效（下次打开页面不再有旧版手改优先）。');
  return 0;
}

process.exit(runMigrate());
