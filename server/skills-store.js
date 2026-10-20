/* Skill 的唯一解析 / 校验 / 安装实现（server 侧）。
   - 内置 skills/ 只读；用户 .skills/ 可写；启用状态存 DATA_DIR/skills.json
   - frontmatter 只支持受限子集：key: value、[a, b]、字符串/数字/布尔
   - 一个 contract 只允许一个启用 Skill；用户 Skill 用 replaces 覆盖内置
   - 安装先写临时目录再原子替换；zip 解压在路由层完成并只提交文本文件 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite, renameWithRetry } = require('./fs-atomic.js');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
/* contract 白名单：一份 Skill 的正文由 contract 唯一标识（TextAI.SKILL_CONTRACT 是同一张表的页面侧）。
   `board_assets.json` = 拆分镜那一条「判断哪些新角色/场景/物品要建档并出图」的指令。 */
const CONTRACTS = new Set(['polish.video', 'polish.image', 'polish.voice', 'polish.follow', 'story.json', 'split.json', 'board_edit.json', 'img_split.json', 'char.image.json', 'char.voice.json', 'board_assets.json']);
const ALLOWED_EXT = new Set(['.md', '.txt', '.json']);

function parseFrontmatter(text) {
  const s = String(text || '');
  if (!s.startsWith('---')) return { meta: {}, body: s };
  const end = s.indexOf('\n---', 3);
  if (end < 0) throw new Error('frontmatter 没有结束的 ---');
  const head = s.slice(3, end).replace(/\r/g, '');
  const body = s.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error('frontmatter 行无法解析：' + line);
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (!val) { meta[key] = ''; continue; }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (val === 'true' || val === 'false') meta[key] = val === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(val)) meta[key] = Number(val);
    else meta[key] = val.replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

function createSkillsStore(opts) {
  const root = opts.root;
  const builtinDir = path.join(root, 'skills');
  /* 用户 Skill 目录默认在项目里；隔离实例用 SKILLS_DIR 指出去 ——
     否则 e2e 安装的测试 Skill 会直接写进用户真实的那一份。 */
  const userDir = opts.userDir ? path.resolve(opts.userDir) : path.join(root, '.skills');
  const statePath = path.join(opts.dataDir || path.join(root, '.data'), 'skills.json');
  const log = opts.log || (() => {});
  let state = null;
  const loadState = () => {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch (e) { state = {}; }
    if (!state.enabled || typeof state.enabled !== 'object') state.enabled = {};
    return state;
  };
  const saveState = () => {
    /* 与其余 store 同一份写盘纪律（fs-atomic）：tmp → fsync → 占用时退避重试的 rename。
       这里以前自己写 .tmp + renameSync，Windows 上杀软/同步盘占住目标就 EPERM，
       而调用方只会看到「启停没生效」。 */
    atomicWrite(statePath, JSON.stringify(loadState(), null, 2));
  };
  const dirs = () => [
    { source: 'builtin', dir: builtinDir, readOnly: true },
    { source: 'user', dir: userDir, readOnly: false },
  ];
  const readSkillDir = (dir, source) => {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name)) continue;
      const file = path.join(dir, ent.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const id = String(meta.id || ent.name);
        if (id !== ent.name) throw new Error('id 与目录名不一致');
        out.push({ ...meta, id, source, body, dir: path.join(dir, ent.name) });
      } catch (e) {
        log('[skills] 跳过坏 Skill ' + ent.name + '：' + e.message);
      }
    }
    return out;
  };
  const all = () => {
    const st = loadState();
    return [...readSkillDir(builtinDir, 'builtin'), ...readSkillDir(userDir, 'user')]
      .map(x => ({ ...x, enabled: x.source === 'builtin' ? st.enabled[x.id] !== false : st.enabled[x.id] === true }));
  };
  const get = id => all().find(x => x.id === id) || null;
  const list = () => {
    const st = loadState();
    const items = all();
    const byContract = new Map();
    for (const x of items) if (x.enabled && x.contract) byContract.set(x.contract, x);
    return items.map(x => ({
      id: x.id, name: x.name || x.id, description: x.description || '', triggers: x.triggers || [],
      pages: x.pages || [], tools: x.tools || [], contract: x.contract || '', version: x.version || 1,
      source: x.source, enabled: !!x.enabled, replaces: x.replaces || '',
      conflict: !!(x.contract && byContract.get(x.contract) && byContract.get(x.contract).id !== x.id),
      /* 「素材范围优先」：一份 Skill 可以声明「这个项目优先用哪几个素材组」。
         拆分镜那一路的「素材范围」下拉会把这些组**排在前面**（不排除其它组）。
         ⚠ 这**不是**「项目引用规则」：项目引用规则指的是**正文里的变量占位符**
         （`{cast}` `{what}` `{board}` …），由程序按项目填料 —— 变量名在正文里，不在这里。 */
      assetGroups: Array.isArray(x.assetGroups) ? x.assetGroups : [],
    }));
  };
  const enabled = () => all().filter(x => x.enabled);
  const sameContract = (contract, exceptId) => enabled().find(x => x.contract === contract && x.id !== exceptId) || null;
  const setEnabled = (id, on) => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill：' + id);
    const st = loadState();
    if (on) {
      const other = sameContract(x.contract, id);
      if (other && other.source === 'builtin') st.enabled[other.id] = false;
      else if (other) throw new Error('同一个 contract 只能启用一个 Skill：' + other.id + ' 已启用');
    }
    st.enabled[id] = !!on;
    saveState();
  };
  const safeFiles = files => {
    if (!Array.isArray(files) || !files.length) throw new Error('没有文件');
    if (files.length > 50) throw new Error('文件超过 50 个');
    let total = 0;
    const out = [];
    for (const f of files) {
      const rel = String(f.path || '').replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || rel.includes('..') || /^[a-z]:/i.test(rel)) throw new Error('非法路径：' + rel);
      const ext = path.extname(rel).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) throw new Error('不允许的文件类型：' + rel);
      const text = String(f.text == null ? '' : f.text);
      total += Buffer.byteLength(text, 'utf8');
      if (total > 5 * 1024 * 1024) throw new Error('解压后超过 5MB');
      out.push({ rel, text });
    }
    return out;
  };
  const install = (files, opts2 = {}) => {
    const listFiles = safeFiles(files);
    const main = listFiles.find(f => f.rel === 'SKILL.md') || listFiles.find(f => /^[^/]+\/SKILL\.md$/.test(f.rel));
    if (!main) throw new Error('缺少 SKILL.md');
    const { meta } = parseFrontmatter(main.text);
    const id = String(meta.id || '').trim();
    if (!ID_RE.test(id)) throw new Error('id 不合法：' + id);
    if (readSkillDir(builtinDir, 'builtin').some(x => x.id === id)) throw new Error('内置 Skill id 不可覆盖：' + id);
    if (!meta.description) throw new Error('缺少 description');
    if (!CONTRACTS.has(String(meta.contract || ''))) throw new Error('contract 不在注册表里：' + (meta.contract || ''));
    const pages = Array.isArray(meta.pages) ? meta.pages : (meta.pages ? [meta.pages] : []);
    if (pages.some(p => !/^[a-z0-9-]+\.html$/.test(p))) throw new Error('pages 必须是页面文件名');
    const cur = get(id);
    if (cur && cur.contract && meta.contract && cur.contract !== meta.contract && cur.enabled) throw new Error('已启用的 Skill 不能换 contract');
    if (opts2.enable !== false) {
      const other = sameContract(String(meta.contract || ''), id);
      if (other && other.source !== 'builtin') throw new Error('同一个 contract 只能启用一个 Skill：' + other.id + ' 已启用');
    }
    const dst = path.join(userDir, id);
    const tmp = dst + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const prefix = main.rel.includes('/') ? main.rel.slice(0, main.rel.lastIndexOf('/') + 1) : '';
    for (const f of listFiles) {
      let rel = f.rel.startsWith(prefix) ? f.rel.slice(prefix.length) : f.rel;
      if (!rel || rel.includes('..')) continue;
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      atomicWrite(dest, f.text);        // 落盘（fsync）之后才允许那次目录 swap，否则掉电后 swap 过去的是半个文件
    }
    let bak = '';
    if (cur) {
      bak = dst + '.bak-' + Date.now();
      /* 旧版本挪不动就别往下装：renameWithRetry 只重试「此刻被占着」那一类，
         真让新目录盖上去，旧的那份就再也找不回来了（bak 是这次唯一后悔药）。 */
      try { renameWithRetry(dst, bak); } catch (e) {
        throw new Error('旧版本 Skill 挪不去备份 ' + path.basename(bak) + '（' + ((e && e.code) || '') + ' ' + ((e && e.message) || e) + '），安装已中止：' + id);
      }
    }
    try {
      renameWithRetry(tmp, dst);
    } catch (e) {
      /* 新目录没能换上位：把刚挪走的旧版本放回原处 ——
         「升级失败」不该变成「这个 Skill 凭空没了」，放回后再报错。 */
      if (bak) { try { renameWithRetry(bak, dst); } catch {} }
      throw new Error('Skill 目录换不到位（' + ((e && e.code) || '') + ' ' + ((e && e.message) || e) + '）：' + id + ' 已保持原样');
    }
    const st = loadState();
    if (!opts2.keepState) {
      if (opts2.enable !== false) {
        const other = sameContract(String(meta.contract || ''), id);
        if (other && other.source === 'builtin') st.enabled[other.id] = false;
        st.enabled[id] = true;
      }
      saveState();
    }
    return get(id);
  };
  const remove = id => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill');
    if (x.source !== 'user') throw new Error('内置 Skill 不能删除，可复制为我的 Skill');
    fs.rmSync(x.dir, { recursive: true, force: true });
    const st = loadState(); delete st.enabled[id]; saveState();
  };
  /* 根目录内的文本文件：列表 / 读取 / 整包哈希。
     路径规范化、扩展名、大小与行数上限都只在这里判一次；路由与助手不另写一套。 */
  const safeRel = rel => {
    const s = String(rel || '').replace(/\\/g, '/');
    if (!s || s.startsWith('/') || s.includes('..') || /^[a-z]:/i.test(s)) return '';
    if (!ALLOWED_EXT.has(path.extname(s).toLowerCase())) return '';
    return s;
  };
  const listFiles = id => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill');
    const out = [];
    const walk = (dir, base) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        const rel = path.relative(base, full).replace(/\\/g, '/');
        if (ent.isDirectory()) { walk(full, base); continue; }
        if (!ent.isFile() || !safeRel(rel)) continue;
        const buf = fs.readFileSync(full);
        out.push({ path: rel, size: buf.length, hash: crypto.createHash('sha1').update(buf).digest('hex') });
      }
    };
    walk(x.dir, x.dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };
  const skillHash = id => crypto.createHash('sha1')
    .update(listFiles(id).map(f => f.path + ':' + f.hash).join('\n')).digest('hex');
  const readFile = (id, file) => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill');
    const rel = safeRel(file);
    if (!rel) throw new Error('非法文件（只读 Skill 目录下的 .md / .txt / .json）');
    const full = path.join(x.dir, rel);
    if (!full.startsWith(x.dir + path.sep)) throw new Error('非法文件');
    let st;
    try { st = fs.statSync(full); } catch { throw new Error('没有这个文件：' + rel); }
    if (!st.isFile()) throw new Error('不是文件：' + rel);
    if (st.size > 1024 * 1024) throw new Error('文件超过 1MB：' + rel);
    const text = fs.readFileSync(full, 'utf8');
    if (text.split(/\r?\n/).length > 1000) throw new Error('文件超过 1000 行：' + rel);
    return text;
  };
  /* 兼容旧调用名：/skills/:id/read 现在读根目录内任意允许的文本文件。 */
  const readRef = (id, file) => readFile(id, file);
  const update = (id, files, expectedHash) => {
    const x = get(id);
    if (!x) throw new Error('没有这个 Skill');
    if (x.source !== 'user') throw new Error('内置 Skill 不能改，先复制成我的 Skill');
    const main = (Array.isArray(files) ? files : []).find(f => /(^|\/)SKILL\.md$/.test(String(f && f.path || '')));
    if (!main) throw new Error('更新包缺少 SKILL.md');
    const meta = parseFrontmatter(String(main.text || '')).meta;
    if (String(meta.id || '') !== id) throw new Error('更新包里的 id（' + (meta.id || '空') + '）与要更新的 Skill 不一致');
    const cur = skillHash(id);
    if (String(expectedHash || '') !== cur) {
      const e = new Error('Skill 已经变了（当前 hash ' + cur.slice(0, 12) + '），刷新后再改');
      e.status = 409;
      e.currentHash = cur;
      throw e;
    }
    const next = install(files, { enable: !!x.enabled, keepState: true });
    return { skill: next, hash: skillHash(id) };
  };
  const importBundle = (files, opts2 = {}) => install(files, opts2);
  return { parseFrontmatter, list, all, get, enabled, setEnabled, install, remove, readRef,
    listFiles, readFile, skillHash, update, importBundle,
    statePath, userDir, builtinDir, CONTRACTS };
}

module.exports = { createSkillsStore, parseFrontmatter, CONTRACTS, ID_RE };
