#!/usr/bin/env node
/* 「走树在 worker 线程里跑」判据（常驻，不启实例、不碰用户目录）。
   跑法：`node tests/scan-worker.cjs`。

   盯住三件事：
     · worker 往返：dirScan 的走树结果与真盘一致（跳过 提示词 / FCPXML工程 / .trash 三档）；
     · 采样签名两把尺子同一量：盘上读头尾（localSigOf，异步）与内存字节（sampleSigOfBuffer，
       base64 直传那一路）对同一份文件必须逐字相同 —— 错一格「按字节认回」就永远落空；
     · 兜底可用：worker 起不来时主线程用同一枚 walkTree 把这一趟走完（行为不缺、算法唯一）。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalAssetsStore, sampleSigOfBuffer } = require('../server/local-assets-store.js');
const { walkTree } = require('../server/scan-worker.js');
const userDirs = require('../server/user-dirs.js');

let bad = 0, n = 0;
const ok = (name, cond, detail) => {
  n++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-worker-probe-'));
const assets = path.join(tmp, 'assets');
const data = path.join(tmp, 'data');
for (const d of [['图片'], ['视频'], [userDirs.PROMPTS_DIR_NAME], [userDirs.FCPXML_PROJECT_DIR, 'p1', 'media'], ['.trash', 'x']]) {
  fs.mkdirSync(path.join(assets, ...d), { recursive: true });
}
fs.mkdirSync(path.join(data, 'local-assets'), { recursive: true });

const store = createLocalAssetsStore({
  MIME: { '.png': 'image/png' },
  dataDirPath: () => data,
  log: () => {},
  spawnSync: () => {},
  localRoot: () => assets,
  fileSafe: s => String(s || 'x'),
});

(async () => {
  /* ① 走树本身的形状：跳档名单与行形状都要对 */
  const big = Buffer.alloc(3 * 1024 * 1024, 7);          // >2MB：sig 才会真的读头尾两段
  fs.writeFileSync(path.join(assets, '图片', '大头.png'), big);
  fs.writeFileSync(path.join(assets, '视频', '小段.mp4'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(assets, userDirs.PROMPTS_DIR_NAME, '归档.md'), '不该扫到');
  fs.writeFileSync(path.join(assets, userDirs.FCPXML_PROJECT_DIR, 'p1', 'media', '打包拷贝.mp4'), Buffer.from([9]));
  fs.writeFileSync(path.join(assets, '.trash', '垃圾.png'), Buffer.from([8]));

  const files = walkTree(assets);
  ok('走树结果只含产物本体（提示词 / FCPXML工程 / .trash 三档跳过）',
    files.some(f => /大头\.png$/.test(f.rel)) && files.some(f => /小段\.mp4$/.test(f.rel))
    && !files.some(f => /归档\.md$/.test(f.rel)) && !files.some(f => /打包拷贝|垃圾/.test(f.rel)),
    JSON.stringify(files.map(f => f.rel)));
  ok('行形状齐整（rel / abs / size / mtimeMs / fid）',
    files.every(f => f.rel && path.isAbsolute(f.abs) && typeof f.size === 'number'
      && typeof f.mtimeMs === 'number' && /^\d+:\d+$/.test(f.fid) && f.sig === ''),
    JSON.stringify(files[0]));

  /* ② 经 store 走一趟 worker 往返：对账把两份本体补进账，且只走了这一趟 */
  const walks0 = store.scanWalkCount();
  const ad = await store.localAdopt(true);
  ok('worker 往返把盘上两份本体都补进了账', ad.added === 2 && ad.skipped === 0, JSON.stringify(ad));
  ok('这一趟确实走了完整的树（walkCount +1）',
    store.scanWalkCount() === walks0 + 1, walks0 + ' → ' + store.scanWalkCount());
  const rowBig = store.localIndexRead().find(x => /大头\.png$/.test(String(x.file || '')));
  ok('补出来的账带着采样签名（对账那一路现算过）',
    !!rowBig && /^\d+:[0-9a-f]{16}$/.test(String(rowBig.sig)), rowBig && rowBig.sig);

  /* ③ 采样签名两把尺子同一量 */
  const sigDisk = await store.localSigOf(path.join(assets, '图片', '大头.png'), big.length);
  ok('盘上版与内存版签名逐字相同（>2MB，头尾两段都读到）',
    sigDisk === sampleSigOfBuffer(big) && /^[0-9a-f]{16}$/.test(sigDisk.slice(sigDisk.indexOf(':') + 1)),
    sigDisk + ' vs ' + sampleSigOfBuffer(big));
  const tiny = Buffer.from([1, 2, 3]);
  const sigTiny = await store.localSigOf(path.join(assets, '视频', '小段.mp4'), tiny.length);
  ok('小文件同一量（整份都在头那一段）', sigTiny === sampleSigOfBuffer(tiny), sigTiny + ' vs ' + sampleSigOfBuffer(tiny));

  /* ④ 主线程兜底：同一枚 walkTree 也能在主线程把这一趟走完（worker 起不来时的那条路） */
  const again = walkTree(assets);
  ok('兜底路径与 worker 路同一份结果',
    again.length === files.length && again.every((f, i) => f.abs === files[i].abs && f.fid === files[i].fid),
    again.length + ' 份');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过');
  process.exit(bad ? 1 : 0);
})().catch(e => {
  console.log('判据自己炸了：' + ((e && e.stack) || e));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
