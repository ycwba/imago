#!/usr/bin/env node
/* 一次性迁移：把白膜库里的旧版模型 / 场景文件升到目标版本（v1 / v2 → v3）。
   迁移 = 归一化补齐：老形状（scene.camera、tr.nodeId）由 migrateDoc 翻成 v3，缺的默认值一并填上；
   写出的是服务端同一份稀疏形态，读回来再归一化与迁移结果逐字段一致。
   跑法：node tools/migrate-model.cjs --from 2 --to 3 --dir <库根> [--yes]
   --dir 给库根（下面有「白膜」）或直接给白膜根都行；只扫 .json，跳过 _模型文件 与 .trash。
   幂等：再跑一遍报 0 份、什么都不写；改过的原文件先整份备份到 <白膜根>/.trash/model-migrate-<stamp>/。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const DIR_NAME = '白膜';
const SKIP_DIRS = new Set(['_模型文件', '.trash']);

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function jsonFilesIn(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) stack.push(abs);
      } else if (/\.json$/i.test(ent.name)) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

function versionOf(raw) {
  if (raw.v == null || raw.v === '') return { v: 1, missing: true };
  const v = Number(raw.v);
  return { v: Number.isInteger(v) && v >= 0 ? v : -1, missing: false };
}

async function main() {
  const argv = process.argv.slice(2);
  const from = Number(argOf(argv, '--from'));
  const to = Number(argOf(argv, '--to'));
  const dirArg = argOf(argv, '--dir');
  const dry = !argv.includes('--yes');

  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || !dirArg) {
    console.log('用法：node tools/migrate-model.cjs --from <旧版> --to <新版> --dir <库根> [--yes]');
    console.log('  例：node tools/migrate-model.cjs --from 2 --to 3 --dir "D:\\作品\\成像"');
    return 2;
  }
  const input = path.resolve(dirArg);
  if (!fs.existsSync(input)) {
    console.error('目录不存在：' + input);
    return 2;
  }
  const root = fs.existsSync(path.join(input, DIR_NAME)) ? path.join(input, DIR_NAME) : input;

  const { migrateDoc, sparseDoc, MIGRATIONS, MODEL_VERSIONS } = await import(
    pathToFileURL(path.join(ROOT, 'web', 'model3d', 'schema.js')).href
  );
  if (!MIGRATIONS[from + '>' + to]) {
    console.error('没有 ' + from + ' → ' + to + ' 的迁移。认识的版本：'
      + MODEL_VERSIONS.map(x => 'v' + x.v).join(' / ')
      + '；认识的迁移：' + Object.keys(MIGRATIONS).join(' / '));
    return 2;
  }

  const files = jsonFilesIn(root);
  const todo = [];
  const report = { done: 0, other: 0, bad: 0, guessed: 0 };

  for (const file of files) {
    const rel = path.relative(root, file);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      report.bad += 1;
      console.log('  ! 读不出来，跳过：' + rel + '（' + e.message + '）');
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      report.bad += 1;
      console.log('  ! 不是一份文档，跳过：' + rel);
      continue;
    }
    const at = versionOf(raw);
    if (at.missing) {
      report.guessed += 1;
      console.log('  · 没有版本号，按 v1 处理：' + rel);
    } else if (at.v < 0) {
      report.bad += 1;
      console.log('  ! 版本号不认识（v=' + JSON.stringify(raw.v) + '），跳过：' + rel);
      continue;
    }
    if (at.v === to) { report.done += 1; continue; }
    if (at.v !== from) {
      report.other += 1;
      console.log('  · 是 v' + at.v + '，不是 v' + from + '，不动：' + rel);
      continue;
    }
    try {
      const doc = migrateDoc(raw, at.v, to);
      todo.push({ file, rel, doc });
      console.log('  → v' + from + ' → v' + to + '：' + rel);
    } catch (e) {
      report.bad += 1;
      console.log('  ! 迁移失败，跳过：' + rel + '（' + e.message + '）');
    }
  }

  console.log('\n白膜根：' + root);
  console.log('扫到 .json ' + files.length + ' 份：待迁移 ' + todo.length
    + ' / 已是 v' + to + ' ' + report.done
    + ' / 别的版本 ' + report.other
    + ' / 读不出或迁移失败 ' + report.bad + (report.guessed ? '（按 v1 处理 ' + report.guessed + '）' : ''));

  if (!todo.length) { console.log('没有要迁的，收工。'); return 0; }

  if (dry) {
    console.log('\n这是**预览**（没写任何东西）。确认无误后加 --yes 真迁：');
    console.log('  node tools/migrate-model.cjs --from ' + from + ' --to ' + to + ' --dir "' + input + '" --yes');
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, '.trash', 'model-migrate-' + stamp);
  for (const item of todo) {
    const bak = path.join(backupDir, item.rel);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(item.file, bak);
    const tmp = item.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sparseDoc(item.doc), null, 2));
    fs.renameSync(tmp, item.file);
  }
  console.log('迁完 ' + todo.length + ' 份；原文件备份在：' + backupDir);
  return 0;
}

main().then(code => process.exit(code)).catch(e => {
  console.error('迁移器出错：' + (e && e.message ? e.message : e));
  process.exit(1);
});
