#!/usr/bin/env node
/* Skill Hub 判据：
   - skills-store：安装 / 同 contract 只留一份（启一份 → 别的直接停）/ 场景恒有一份（停最后一份被拒、
     卸载最后一份把内置顶回来、开机修老状态）/ expectedHash 409 / id 一致性 / 根目录读取上限
   - zip 只在浏览器内存里解：store/deflate 两种方式、路径穿越 / 可执行文件 / 超量拒绝
   不碰真实 .skills / .data：全部在临时目录。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSkillsStore } = require('../server/skills-store.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-skill-'));
const write = (rel, text) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};
write('skills/builtin-a/SKILL.md', '---\nid: builtin-a\nname: 内置 A\ndescription: 内置测试\ntriggers: ["测试"]\npages: ["assets.html"]\ncontract: polish.image\nversion: 1\n---\n\n内置正文\n');
const store = createSkillsStore({ root, userDir: path.join(root, '.skills'), dataDir: path.join(root, '.data'), log: () => {} });

const sk = (id, contract, extra = {}) => [{
  path: 'SKILL.md',
  text: '---\nid: ' + id + '\nname: ' + (extra.name || id) + '\ndescription: 测试用\ntriggers: ["测试"]\npages: ["assets.html"]\ncontract: ' + contract + '\nversion: 1\n---\n\n# 测试\n' + (extra.body || ''),
}];

/* 安装 + 同 contract 只留一份：启一份就把原来那份**直接停掉**（不报错、不拦着） */
const a = store.install(sk('my-a', 'polish.image'), { enable: true });
assert.equal(a.skill.id, 'my-a');
assert.equal(store.get('my-a').enabled, true);
assert.equal(store.get('builtin-a').enabled, false, '启用用户 Skill 时应自动停用同 contract 的内置');
assert.deepEqual(a.displaced, ['builtin-a'], '装上去时应报出「谁让了位」');
let items = store.list();
assert.ok(items.some(x => x.id === 'my-a' && x.source === 'user'));
/* 第二份「我的」不再被拒：装上去就把 my-a 直接停掉 */
const b = store.install(sk('my-b', 'polish.image'), { enable: true });
assert.equal(b.skill.id, 'my-b');
assert.equal(store.get('my-b').enabled, true);
assert.equal(store.get('my-a').enabled, false, '装第二份时原来那份应被直接停掉');
assert.deepEqual(b.displaced, ['my-a']);
assert.equal(store.list().filter(x => x.enabled && x.contract === 'polish.image').length, 1,
  '同一 contract 同一时刻只该有一份启用');
/* 启停这一路也一样：启一份 → 同 contract 的别的直接停，并报出谁停了 */
const dis = store.setEnabled('my-a', true);
assert.equal(store.get('my-a').enabled, true);
assert.equal(store.get('my-b').enabled, false, '启一份时同 contract 的另一份应被直接停掉');
assert.deepEqual(dis, ['my-b']);
/* 场景恒有一份：停掉场景里最后那份启用被拒；先启另一份、再回来停就没有阻碍 */
assert.throws(() => store.setEnabled('my-a', false), /至少要有一份 Skill 在用/);
store.setEnabled('my-b', true);
assert.equal(store.get('my-a').enabled, false, '启另一份时这份让位');
store.setEnabled('my-a', false);
assert.equal(store.get('my-a').enabled, false);
store.install(sk('my-b', 'polish.image'), { enable: true });
store.setEnabled('my-a', true);
assert.equal(store.get('my-b').enabled, false, '再启一份时又一份让位');
assert.equal(store.get('my-a').enabled, true);
/* 卸载场景里最后那份启用的：内置份顶回来，回执点名 */
store.install(sk('my-c', 'polish.image'), { enable: true });
assert.equal(store.get('my-a').enabled, false, '装 my-c 时 my-a 让位');
const restored = store.remove('my-c');
assert.equal(restored, 'builtin-a', '删掉最后一份启用时应回执顶回来的内置份');
assert.equal(store.get('my-c'), null);
assert.equal(store.get('builtin-a').enabled, true);
store.setEnabled('my-a', true);

/* 内置不可覆盖 / 不可删除 */
assert.throws(() => store.install([{ path: 'SKILL.md', text: '---\nid: builtin-a\nname: x\ndescription: x\ncontract: polish.image\n---\n' }]), /内置 Skill id 不可覆盖/);
assert.throws(() => store.remove('builtin-a'), /内置 Skill 不能删除/);

/* 更新：expectedHash 必须匹配；包里 id 必须与目标一致 */
const cur = store.skillHash('my-a');
assert.throws(() => store.update('my-a', sk('my-a', 'polish.image'), 'deadbeef'), e => e.status === 409 && e.currentHash === cur);
assert.throws(() => store.update('my-a', sk('other-id', 'polish.image'), cur), /与要更新的 Skill 不一致/);
const upd = store.update('my-a', sk('my-a', 'polish.image', { body: '\n第二版正文\n' }), cur);
assert.equal(upd.skill.id, 'my-a');
assert.notEqual(upd.hash, cur);
assert.match(store.readFile('my-a', 'SKILL.md'), /第二版正文/);

/* 读取：根目录 / references 都可读；路径与扩展名限制只有一份 */
store.install(sk('my-a', 'polish.image', { body: '\n第二版正文\n' }).concat([{ path: 'references/ref.md', text: '参考内容' }]), { enable: true });
assert.equal(store.readFile('my-a', 'references/ref.md'), '参考内容');
assert.throws(() => store.readFile('my-a', '../x.md'), /非法文件/);
assert.throws(() => store.readFile('my-a', '/abs.md'), /非法文件/);
assert.throws(() => store.readFile('my-a', 'a.js'), /非法文件/);

/* 单文件 1MB / 1000 行上限 */
const dir = path.join(root, '.skills', 'my-a');
fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(1024 * 1024 + 1));
assert.throws(() => store.readFile('my-a', 'big.md'), /超过 1MB/);
fs.writeFileSync(path.join(dir, 'lines.md'), Array(1002).fill('x').join('\n'));
assert.throws(() => store.readFile('my-a', 'lines.md'), /超过 1000 行/);
fs.rmSync(path.join(dir, 'big.md'));
fs.rmSync(path.join(dir, 'lines.md'));

/* 重启后启停状态还在 */
const store2 = createSkillsStore({ root, userDir: path.join(root, '.skills'), dataDir: path.join(root, '.data'), log: () => {} });
assert.equal(store2.get('my-a').enabled, true);

/* 开机修一次老状态文件：多份启用的留 [builtin, user] 顺序里最后那份；一份都不启用的拉回内置 */
write('skills/builtin-b/SKILL.md', '---\nid: builtin-b\nname: 内置 B\ndescription: 内置测试\ntriggers: ["测试"]\npages: ["assets.html"]\ncontract: story.json\nversion: 1\n---\n\n内置正文\n');
write('.data/skills.json', JSON.stringify({ enabled: { 'builtin-a': true, 'my-a': true, 'builtin-b': false } }));
const store3 = createSkillsStore({ root, userDir: path.join(root, '.skills'), dataDir: path.join(root, '.data'), log: () => {} });
assert.equal(store3.get('builtin-a').enabled, false, '同 contract 多份启用 → 留顺序里最后那份（my-a）');
assert.equal(store3.get('my-a').enabled, true);
assert.equal(store3.get('builtin-b').enabled, true, '一份都不启用的场景把内置拉回来');

/* ---------- 浏览器 zip 读取器 ---------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function buildZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const data = Buffer.from(e.text == null ? '' : e.text, 'utf8');
    const method = e.method == null ? 8 : e.method;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const rawSize = e.rawSize == null ? data.length : e.rawSize;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(rawSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const block = Buffer.concat([local, name, comp]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(rawSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(off, 42);
    locals.push(block);
    centrals.push(Buffer.concat([central, name]));
    off += block.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const win = {};
const ctx = vm.createContext({
  window: win, console, TextDecoder, Uint8Array, ArrayBuffer, DataView, Blob, Response, DecompressionStream,
});
new vm.Script(fs.readFileSync(path.join(process.cwd(), 'web/domain/zip-read.js'), 'utf8')).runInContext(ctx);
const asFile = buf => ({ arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });

const zip = buildZip([
  { path: 'my-skill/SKILL.md', text: '# 测试\n' },
  { path: 'my-skill/references/a.md', text: '参考', method: 0 },
]);
const out = await win.ZipRead.read(asFile(zip));
assert.equal(out.files.map(f => f.path).join('|'), 'my-skill/SKILL.md|my-skill/references/a.md');
assert.match(out.files[0].text, /# 测试/);
assert.equal(out.files[1].text, '参考');

await assert.rejects(win.ZipRead.read(asFile(buildZip([{ path: '../evil.md', text: 'x' }]))), /路径穿越/);
await assert.rejects(win.ZipRead.read(asFile(buildZip([{ path: 'run.js', text: 'x' }]))), /只接受/);
await assert.rejects(win.ZipRead.read(asFile(buildZip([{ path: 'a.md', text: 'x', method: 12 }]))), /不支持的压缩方式/);
const five = Array.from({ length: 6 }, (_, i) => ({ path: 'f' + i + '.md', text: '', rawSize: 900 * 1024 }));
await assert.rejects(win.ZipRead.read(asFile(buildZip(five))), /超过 5MB/);
const many = Array.from({ length: 51 }, (_, i) => ({ path: 'f' + i + '.md', text: 'x' }));
await assert.rejects(win.ZipRead.read(asFile(buildZip(many))), /超过 50 个/);

fs.rmSync(root, { recursive: true, force: true });
console.log('✓ Skill Hub 判据通过（store / hash / 路径 / zip）');
