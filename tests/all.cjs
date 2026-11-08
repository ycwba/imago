#!/usr/bin/env node
/* 一键测试 —— 跑法：`node tests/all.cjs`（浏览器档：加 `--e2e` 全量 / `--e2e:fast` 冒烟档 / ALL_E2E=1 同 --e2e）
   顺序：常驻测试（并发池，含语法）→（按需）浏览器 e2e（全量分道 / 冒烟档 4 路并发）。
   作为重构与回归的固定入口。日常不必整包跑这一份：`npm run check`（<3 秒）与 `npm run test:fast`
   （按改动挑判据）才是提交前的常手，这一份是合并前的全量（三档流程的第三档）。
   语法判据不在这里重写：与 `npm run check` 共用 `tests/syntax.cjs` 那一份。它进池跑
   （子进程里 syntax.cjs 会自带给 --experimental-vm-modules 的快路）；旧写法在 all.cjs 进程内
   require 直跑，父进程没有模块 API，退成 248 次 `node --check`（约 10.4s，比整个池还慢）。

   2026-10-21 本轮落地：
     常驻判据并发执行：run() 从串行 spawnSync 改为「排队 + 并发池」，默认并发 min(8, CPU 核数)。
        每条判据的输出**整块缓冲、按完成顺序一次性打**（不交错、看得出谁红的）；池里任一条红，
        退出码就非 0；子进程挂住有 per-task 超时（ALL_TIMEOUT_MS / ALL_E2E_TIMEOUT_MS 可改）直接杀掉。
        **写入型判据只跑隔离实例**：凡写共享 .data/.assets/.renders/.skills 的
        一律进 SERIAL_WRITE 串行白名单、不进并发池（data-snapshot 本就不在这里跑，属手工档；
        常驻判据实测全部只写 os.tmpdir 的 mkdtemp 探针目录，白名单先登记 data-snapshot 防今后误加）。
     测试用 Node 选型：判据子进程优先用系统 node（NODE 环境变量可指定，拿不到回落 execPath），
        与 map.cjs / watch.cjs 共用同一份 resolveNode（不另存第二张选型表）。
     e2e 分档：--e2e:fast 只跑冒烟档 6 个（清单见 FAST_E2E），--e2e 全量。
        两条档都靠**隔离实例**并发（每条自起隔离 proxy + 独立 Chrome：harness 用 freePort 与
        带 pid 的独立探针目录，并发互不踩 —— 写入隔离天然满足）。
        冒烟档限 4 路并发；全量档先跑读数型那 4 条（截图指纹 / 帧预算 / 实时播放对齐 / 冷启动，
        并发负载会让读数失真），其余（含 7 条不起 Chrome 的服务端链路）再走 4 路并发。共享 batch 入口这轮没动。
   判据进程内打包与 harness 共享 batch 入口这两件没做，待主线导演台 e2e 拆分收口后再接，
   这里不留半截实现。
   注意：tests/map.cjs 的 registry() 按源码文本现读本文件的登记行（run 首参 'tests/<名字>.cjs'）与
   e2e 段的分段标记（下面那句 if 的字面量）—— 本文件任何注释里都不许再出现那句字面量，
   否则分段会被注释里的那一处截走；改这两处的写法要把 map.cjs 一起改。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const M = require('./map.cjs');

const root = path.resolve(__dirname, '..');
/* 判据子进程用的 node（系统 node 优先；见 map.cjs 的 resolveNode 注释）。 */
const NODE = M.resolveNode();

/* 并发度：min(8, CPU 核数)；ALL_CONCURRENCY 可临时压小（调试 / 低配机）。 */
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.ALL_CONCURRENCY) || os.cpus().length));
/* 超时：常驻 120s、e2e 600s（冒烟档里 smoke 单条约 35s）。挂住的子进程直接 SIGKILL，名额照还。 */
const TIMEOUT_MS = Number(process.env.ALL_TIMEOUT_MS || 120000);
const E2E_TIMEOUT_MS = Number(process.env.ALL_E2E_TIMEOUT_MS || 600000);
/* 写入型串行白名单：会写共享 .data/.assets/.renders/.skills 的判据不进并发池。
   每条都要有原因；常驻判据目前没有一个写共享目录（都落 os.tmpdir 的 mkdtemp），这一档是给
   data-snapshot 一类「要对着真实目录比」的判据留的闸 —— 谁把它们加进 all.cjs，就在这里登记。 */
const SERIAL_WRITE = [
  'tests/data-snapshot.cjs',   // 对真实 .data/.renders 与库根本体比基线，并发跑会读到别的判据的中间态
];

const residentQueue = [];
const browserQueue = [];
let bad = 0;

/* run() 保持与旧串行版同样的调用形状（name/cmd/args/env），map.cjs 的登记表照读得动；
   差别只有一条：不再当场 spawnSync，而是排队，最后由并发池统一跑。
   浏览器档在 --e2e:fast 时只留 FAST_E2E 挑中的 6 条（登记行仍逐条在源码里，map.cjs 照数得到全量）。 */
const run = (name, cmd, args, opts = {}) => {
  const isBrowser = opts.tier === 'browser' || /^tests\/e2e\//.test(name);
  if (isBrowser && FAST_ONLY && !fastPick(name)) return;
  (isBrowser ? browserQueue : residentQueue).push({ name, cmd, args, opts });
};
/* 浏览器判据的挑选：--e2e 全量，--e2e:fast 只跑冒烟档。 */
const FULL_E2E = process.argv.includes('--e2e') || process.env.ALL_E2E === '1';
const FAST_ONLY = process.argv.includes('--e2e:fast') && !FULL_E2E;
/* 冒烟档 6 个（验收：3 分钟以内）：smoke 兜「各页都能加载、控制台无错」，
   ui-contract / ui-shared 兜公共件契约与列表页，director-perf 兜导演台热路径预算，
   lock 兜单实例锁（最便宜的一条代理判据）。 */
const FAST_E2E = ['smoke', 'ui-contract', 'ui-shared', 'director-perf', 'director-core', 'lock'];
const fastPick = name => {
  const id = String(name).replace(/^tests\/e2e\//, '').replace(/\.(cjs|mjs)$/, '');
  return FAST_E2E.includes(id);
};

function spawnBuffered(task) {
  return new Promise(resolve => {
    const cmd = task.cmd === process.execPath ? NODE : task.cmd;
    const t0 = Date.now();
    let out = '';
    let killed = '';
    const child = cp.spawn(cmd, task.args, {
      cwd: root,
      env: { ...process.env, ...(task.opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    const errs = [];
    child.stdout.on('data', b => chunks.push(b));
    child.stderr.on('data', b => errs.push(b));
    const limit = task.opts.timeout || (task.opts.tier === 'browser' || /e2e/.test(task.name) ? E2E_TIMEOUT_MS : TIMEOUT_MS);
    const timer = setTimeout(() => {
      killed = '超时 ' + limit + 'ms，已杀掉子进程（pid ' + child.pid + '）';
      /* Windows：SIGKILL 只杀直接子进程，e2e 自己拉起的 proxy/Chrome 孙进程会成孤儿（清理闸）。
         有 taskkill 就整树端掉；没有（*nix / 端不掉）回落 SIGKILL，名额照样归还。 */
      let treeKilled = false;
      if (process.platform === 'win32' && child.pid) {
        const r = cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        treeKilled = r.status === 0;
      }
      if (!treeKilled) { try { child.kill('SIGKILL'); } catch (e) {} }
    }, limit);
    let settled = false;
    const done = (status, spawnErr) => {
      if (settled) return;                 // 名额恰好归还一次：kill 之后 exit 与 error 可能都来
      settled = true;
      clearTimeout(timer);
      if (spawnErr) killed = '起不来：' + spawnErr.message;
      resolve({ task, ms: Date.now() - t0, status, out: Buffer.concat(chunks).toString('utf8'),
        err: Buffer.concat(errs).toString('utf8'), killed });
    };
    child.on('error', e => done(-1, e));
    child.on('close', code => done(code == null ? -1 : code, null));
  });
}

function report(r) {
  console.log('\n=== ' + r.task.name + '（' + r.ms + ' ms）' + (r.status === 0 && !r.killed ? ' ✓' : ' ✗') + ' ===');
  if (r.out) process.stdout.write(r.out.endsWith('\n') ? r.out : r.out + '\n');
  if (r.err) process.stderr.write(r.err);
  if (r.killed) { console.log('✗ ' + r.task.name + ' —— ' + r.killed); bad++; return; }
  if (r.status !== 0) { console.log('✗ ' + r.task.name + '（退出码 ' + r.status + '）'); bad++; }
}

/* 并发池：并发档先进池（min(8, cores)），串行白名单等池排空后一条条跑；
   输出按**完成顺序**整块打印（含各判据耗时），不会交错。 */
async function flushResident() {
  const par = residentQueue.filter(t => !SERIAL_WRITE.includes(t.name));
  const ser = residentQueue.filter(t => SERIAL_WRITE.includes(t.name));
  const t0 = Date.now();
  let next = 0;
  const workers = [];
  const worker = async () => {
    while (next < par.length) {
      const task = par[next++];
      report(await spawnBuffered(task));
    }
  };
  for (let i = 0; i < Math.min(CONCURRENCY, par.length); i++) workers.push(worker());
  await Promise.all(workers);
  for (const task of ser) report(await spawnBuffered(task));
  console.log('\n常驻池：' + residentQueue.length + ' 项（并发 ' + CONCURRENCY + '，串行白名单 ' + ser.length
    + ' 条），墙钟 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

/* 全量 e2e 分两道跑：
   ① 读数型判据（画面指纹 / 帧预算 / 冷启动 / 实时播放的媒体对齐 / 启动让路的计时窗口）先单独串行 ——
      并发负载会让截图、耗时读数与媒体元素的归位速度失真（播放对齐读到的会是「正在归位途中」的瞬时值）；
   ② 其余（含 7 条不起 Chrome 的服务端链路）走 4 路并发。每条判据自起隔离 proxy + 独立探针目录，
      并发互不写脏；输出与常驻池一样按完成顺序整块打印、带每条耗时。 */
const E2E_SOLO = ['e2e/ui-visual', 'e2e/director-perf', 'e2e/director-playback', 'perf/boot', 'e2e/boot-heavy'];
const e2eIdOf = name => String(name).replace(/^tests\//, '').replace(/\.(cjs|mjs)$/, '');
const e2eRowOf = r => r.task.name.replace(/^tests\/(e2e\/)?/, '') + ' ' + Math.round(r.ms / 1000) + 's'
  + (r.status === 0 && !r.killed ? '' : ' ✗');

async function flushBrowser() {
  const t0 = Date.now();
  const solo = browserQueue.filter(t => E2E_SOLO.includes(e2eIdOf(t.name)));
  const pool = browserQueue.filter(t => !E2E_SOLO.includes(e2eIdOf(t.name)));
  const rows = [];
  console.log('\n全量 e2e：独跑 ' + solo.length + ' 项 → 并发 ' + pool.length + ' 项（4 路）');
  for (const task of solo) {
    console.log('\n=== ' + task.name + '（独跑）===');
    const r = await spawnBuffered(task);
    report(r);
    rows.push(e2eRowOf(r));
  }
  const lanes = Math.min(4, CONCURRENCY, pool.length);
  let next = 0;
  const workers = [];
  const worker = async () => {
    while (next < pool.length) {
      const r = await spawnBuffered(pool[next++]);
      report(r);
      rows.push(e2eRowOf(r));
    }
  };
  for (let i = 0; i < lanes; i++) workers.push(worker());
  await Promise.all(workers);
  console.log('\ne2e（全量）：' + browserQueue.length + ' 项（独跑 ' + solo.length + '，并发 ' + lanes + ' 路），墙钟 '
    + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (rows.length) console.log('  逐条耗时：' + rows.join(' ｜ '));
}

/* 冒烟档：限 4 路并发（6 条各起一套 Chrome，8 路同开内存吃不住；4 路是耗时与噪音的折中）。
   输出与常驻池一样按完成顺序整块打印、带每条耗时；每条自起隔离 proxy + 独立探针目录，互不写脏。 */
async function flushBrowserFast() {
  const lanes = Math.min(4, CONCURRENCY, browserQueue.length);
  const t0 = Date.now();
  let next = 0;
  const workers = [];
  const worker = async () => {
    while (next < browserQueue.length) report(await spawnBuffered(browserQueue[next++]));
  };
  for (let i = 0; i < lanes; i++) workers.push(worker());
  await Promise.all(workers);
  console.log('\ne2e（冒烟档，并发 ' + lanes + '）：' + browserQueue.length + ' 项，墙钟 '
    + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

/* ---------- 常驻测试（进并发池；写入型见 SERIAL_WRITE） ---------- */
/* 语法判据：作为普通一条进池，子进程走 syntax.cjs 自己的快路
   （--experimental-vm-modules 重拉 → 进程内 vm 解析，约 0.4s）。
   判据本体不变，仍与 npm run check 同一份文件。 */
run('tests/syntax.cjs', process.execPath, ['tests/syntax.cjs']);
/* selfcheck 不再同步代跑 spa.cjs —— 那条 spawnSync 是它的慢点本体。
   spa.cjs 由此成为下面这条独立判据，登记不变、判据项一条不减（map.cjs 的 DELEGATED 同步清空）。 */
run('tests/selfcheck.cjs', process.execPath, ['tests/selfcheck.cjs']);
run('tests/spa.cjs', process.execPath, ['tests/spa.cjs']);
run('tests/editing.cjs', process.execPath, ['tests/editing.cjs']);
run('tests/local-first.cjs', process.execPath, ['tests/local-first.cjs']);
/* 列表结果级短缓存：同参数 30 秒内第二次调用 0 次上游请求；续拉 / 数总数 / noCache 不吃缓存。 */
run('tests/assetlib-cache.cjs', process.execPath, ['tests/assetlib-cache.cjs']);
/* 能力缓存认的是「哪一个注册表对象」：load(REG) 的产物是**就地改掉那个对象里的 prov.models**，
   所以设置页取回 / 手填一个型号（invalidateModels 交回全新对象）之后必须重走一轮 ——
   不认身份就是把新对象当成「30 秒里已经问过」，工作台那一栏的参数档位与价格整块消失 30 秒。 */
run('tests/capabilities-cache.mjs', process.execPath, ['tests/capabilities-cache.mjs']);
/* 本机条目删除路由与归属显示：localSelf 行直连 /local-assets（provider 注记 'local'/'本机' 不再当平台 id 查）；
   解析不到平台的本机行显示「本机」（字幕残留 PNG 那一族「删不掉 / 挂语音平台名」的回归）。 */
run('tests/asset-remove.cjs', process.execPath, ['tests/asset-remove.cjs']);
run('tests/pull-scope.mjs', process.execPath, ['tests/pull-scope.mjs']);
run('tests/relay-retry.cjs', process.execPath, ['tests/relay-retry.cjs']);
/* 出站 keep-alive：复用只发生在同 host:port 的池里，建连仍过内网闸 —— 不通过就不启用。 */
run('tests/outbound-keepalive.cjs', process.execPath, ['tests/outbound-keepalive.cjs']);
/* CONNECT 隧道（系统/环境代理）：假代理 + 本地 TLS 目标，离线跑。抓「2xx 之后的 close
   被当成提前关闭」那道竞态 —— 命中它时走系统代理的出站条条失败。 */
run('tests/proxy-tunnel.cjs', process.execPath, ['tests/proxy-tunnel.cjs']);
run('tests/index-store.cjs', process.execPath, ['tests/index-store.cjs']);
/* 库根那一条算法：盘上那一格（.data/sk_local_dir.json，正文就是 localStorage 原值）必须真被读出来，
   否则现象是「设置页改了位置、产物还往老地方写」，而且一句错都不报。 */
run('tests/local-root.cjs', process.execPath, ['tests/local-root.cjs']);
/* 覆盖前那一份备份：`.bak` 最少留 10 分钟、同内容不留、备份没成就不许覆盖。
   连续两次误写（第一次是坏数据、第二次把它盖掉）会让界面承诺的「覆盖前会留一份」落空，
   而那两份正是密钥与识别/搜索设置 —— 所以这三条判据由服务端一处实现、由这一条盯着。 */
run('tests/fs-atomic.cjs', process.execPath, ['tests/fs-atomic.cjs']);
/* 本机有一份、云端没了：地址层要退回本机副本（按账里的来源地址 / 平台产物号认，不靠浏览器会话里的别名表）。
   治的是「卡片写着本机+云端，画面却是一张破图」—— 平台把资产清掉 / 签名过期之后本机那份照样要看得见。 */
run('tests/local-fallback.cjs', process.execPath, ['tests/local-fallback.cjs']);
/* 磁盘对账补的裸行没有来源地址也没有平台号，按平台产物号查不到 → 字节在盘上、卡片却加载不出来。
   「存回本机」取回的字节签名对上时，把身份补写到已有那一行：不重落字节、不新开账、不抢别人那张卡的身份。 */
run('tests/local-byte-reclaim.cjs', process.execPath, ['tests/local-byte-reclaim.cjs']);
/* 批量读「问了几次盘」：别名表 / 批量定位不逐条 existsSync、一批落空的本体只翻得起一趟磁盘对账；
   提示词归档的整目录兜底与索引各自缓住，但刚落盘与刚导入的那一条当场要查得到。
   量的是磁盘问话次数（不是墙钟），所以机器负载不会让它假红。 */
run('tests/read-cache.cjs', process.execPath, ['tests/read-cache.cjs']);
run('tests/core.mjs', process.execPath, ['tests/core.mjs']);
run('tests/ui-catalog.cjs', process.execPath, ['tests/ui-catalog.cjs']);
/* 建模台：模型文件归一化兜底 / 流式节点抓取与坏节点计数 / 小人 20 姿势落地与步态 /
   群众阵列与合批 / 图元与引用展开 / 3D 文件导入与归一 / 动画采样 /
   关节写回（路径与短名两套键、限位夹取、子关节叠加）/ 导入件 clip 播放（只按绝对时间、蒙皮克隆互不串骨）/
   白膜库服务端路由（隔离库根，不碰用户目录）。 */
run('tests/model3d-schema.mjs', process.execPath, ['tests/model3d-schema.mjs']);
run('tests/model3d-entities.mjs', process.execPath, ['tests/model3d-entities.mjs']);
run('tests/model3d-dsl.mjs', process.execPath, ['tests/model3d-dsl.mjs']);
run('tests/model3d-mannequin.mjs', process.execPath, ['tests/model3d-mannequin.mjs']);
run('tests/model3d-crowd.mjs', process.execPath, ['tests/model3d-crowd.mjs']);
run('tests/model3d-scene.mjs', process.execPath, ['tests/model3d-scene.mjs']);
run('tests/model3d-loader.mjs', process.execPath, ['tests/model3d-loader.mjs']);
run('tests/model3d-anim.mjs', process.execPath, ['tests/model3d-anim.mjs']);
run('tests/model3d-rig.mjs', process.execPath, ['tests/model3d-rig.mjs']);
run('tests/model3d-clip.mjs', process.execPath, ['tests/model3d-clip.mjs']);
run('tests/model3d-vault.cjs', process.execPath, ['tests/model3d-vault.cjs']);
run('tests/editor-media.mjs', process.execPath, ['tests/editor-media.mjs']);
run('tests/local-edit.cjs', process.execPath, ['tests/local-edit.cjs']);
run('tests/fcpxml-client.mjs', process.execPath, ['tests/fcpxml-client.mjs']);
run('tests/director-util.mjs', process.execPath, ['tests/director-util.mjs']);
run('tests/director-board.mjs', process.execPath, ['tests/director-board.mjs']);
/* 素材计划：编号与发送顺序同源 / 上限只夹参考图 / 切片去重 / @ 标记与平台引用语法。 */
run('tests/director-ref-plan.mjs', process.execPath, ['tests/director-ref-plan.mjs']);
run('tests/director-split-assets.mjs', process.execPath, ['tests/director-split-assets.mjs']);
/* 拆分镜的「新素材」：重复出现才建 / 名字对不上不建 / 占位符词法 / 建档落点。 */
run('tests/director-board-assets.mjs', process.execPath, ['tests/director-board-assets.mjs']);
/* 拆分镜 / 改分镜的「AI 反问」：Skill 与 DEF 逐字一致（快档）/ 回答是硬约束的契约 /
   NO_ASK 不破 / askPolish 的 focus 拼装 / splitUI → renderSplitPanel 四处接线。 */
run('tests/director-split-ask.mjs', process.execPath, ['tests/director-split-ask.mjs']);
/* 「拆成几张 / 按什么拆」那一排选项的公共件：两家的表与 id / 那两行的口径 /
   「自动」那句与契约兜底同一把尺子 / 导演台的值存模块变量并落盘 / story 两份正文 / 样式一份。 */
run('tests/split-plan.mjs', process.execPath, ['tests/split-plan.mjs']);
/* 项目组：老工程零迁移 / 建组 / 归组 / 删组 / 改名 / 树 / 组名即素材组名。 */
run('tests/director-groups.mjs', process.execPath, ['tests/director-groups.mjs']);
/* 项目文件（导出 / 导入完整工程）：全部候选与提示词 / 剪辑状态往返、格式闸门与校验和、
   零写入、导入时撞 id / 撞名 / 在途任务 / 临时地址归一化。 */
run('tests/director-project-pack.mjs', process.execPath, ['tests/director-project-pack.mjs']);
/* 素材改名回填：@旧名 → @新名 的 token 边界（整名 / 资产 token 只换名段 / 更长的另一位不动）。 */
run('tests/chars-rename.mjs', process.execPath, ['tests/chars-rename.mjs']);
/* 发送前预览（dry-run）：预览与实发同源 / 不发网络请求 / 占位符 / 展示形状。 */
run('tests/raw-preview.mjs', process.execPath, ['tests/raw-preview.mjs']);
/* 项目引用规则：Skill 正文里的变量占位符（{cast} {what} …）按项目填料。 */
run('tests/skill-refvars.mjs', process.execPath, ['tests/skill-refvars.mjs']);
/* 接续拆分镜的纯算法：顺序 / 依赖原因码 / 选型 / 拆分守恒 / 报价键与合计。 */
run('tests/director-chain.mjs', process.execPath, ['tests/director-chain.mjs']);
/* 依赖式批量调度：等上一镜、失败级联、等待不占提交名额。 */
run('tests/director-genall.mjs', process.execPath, ['tests/director-genall.mjs']);
/* 场景镜头命名：本机素材名与 FCPXML 包内名同源（补零 / 截断 / 单扩展名 / 去重）。 */
run('tests/director-naming.mjs', process.execPath, ['tests/director-naming.mjs']);
run('tests/director-slice.mjs', process.execPath, ['tests/director-slice.mjs']);
/* 成片模型 proj.film（新剪辑核）：顺序唯一真相 / 折算 / 转场窗 / 行规划 / 派生时间线。 */
run('tests/director-film.mjs', process.execPath, ['tests/director-film.mjs']);
/* 胶片条计划（显示层）：格宽档位 / 采样时刻 / 图片平铺 / 就近顶上。 */
run('tests/director-strip.mjs', process.execPath, ['tests/director-strip.mjs']);
/* 时间线编辑纯件：切刀融合 / 裁剪滑移滑动 / 波纹 / 重排跨行 / 吸附 / 波形 / 刻度像素换算。 */
run('tests/director-tl-edit.mjs', process.execPath, ['tests/director-tl-edit.mjs']);
/* 切片持久格式：写与读同一张排布表（错位时盘上有二十张、读出来两张，且写入一路 200）。 */
run('tests/director-slice-pack.mjs', process.execPath, ['tests/director-slice-pack.mjs']);
/* 模板样式的挂根：每条选择器加零权重 `:where(.director-page)` 前缀（@scope 会被强制夜间扩展整块跳过），
   分组规则递归、关键帧不碰；真实模板整份转一遍。 */
run('tests/director-style-scope.mjs', process.execPath, ['tests/director-style-scope.mjs']);
/* 拖素材的引用载荷：字段白名单、两个 MIME、标签拼装；老载荷与本机号都只按号走。 */
run('tests/asset-ref.mjs', process.execPath, ['tests/asset-ref.mjs']);
/* 任务详情：号反查 / 六种原因码 / 批量共用一轮；平台用桩替，不发一个真请求。 */
run('tests/task-detail.mjs', process.execPath, ['tests/task-detail.mjs']);
/* 剧本视图：分镜现算成稿、改稿只写回镜头上的画面（台词不在稿子里，也不跟着画面动）。 */
run('tests/director-script.mjs', process.execPath, ['tests/director-script.mjs']);
/* 导出格式只有一张表：页头按钮 / engine 分派 / 助手枚举都从它派生。 */
run('tests/export-formats.cjs', process.execPath, ['tests/export-formats.cjs']);
run('tests/providers-validate.cjs', process.execPath, ['tests/providers-validate.cjs']);
run('tests/asr-settings.mjs', process.execPath, ['tests/asr-settings.mjs']);
/* 浏览器内 ASR 的纯算法面（worker 与判据共用）：WAV 拆 PCM / 词级成段 / 中文转写清理；
   静态档顺带盯住 vendor 四件在场与 worker 的同源约束（模型与 wasm 从 CDN 直取在 CSP 下必死）。 */
run('tests/director-asr-text.mjs', process.execPath, ['tests/director-asr-text.mjs']);
/* 设置键一张账：界面偏好只由 ui.js 的 UI_PREFS 决定，
   同步 / 导出 / 恢复默认三份名单从它现取；新加一项设置没登记就在这里红。 */
run('tests/settings-schema.cjs', process.execPath, ['tests/settings-schema.cjs']);
run('tests/skill-hub.mjs', process.execPath, ['tests/skill-hub.mjs']);
run('tests/zip.cjs', process.execPath, ['tests/zip.cjs']);
/* 生成前校验一致性：页面与助手对同一组 fixture 必须给同一个结论。
   写好了没登记就等于没跑过 —— 这一条与下面两条同批登记（「孤儿判据」那一类）。 */
run('tests/gen-rules.mjs', process.execPath, ['tests/gen-rules.mjs']);
/* 路由工厂的 ctx 注入 + 每条端点走一遍假 req/res：
   pick-dir 那一类「函数体用了没解构的变量 / 少注入一个 key」的坏法，只有真调一次才会红。 */
run('tests/routes-smoke.cjs', process.execPath, ['tests/routes-smoke.cjs']);
/* 静态纪律：内联事件、创建点缺「结果未知」判据、空 catch 没写原因、
   裸 #RRGGBB、页面侧碰 Dropdowns 私有物、裸 localStorage、第二处 createElement('link')、
   同一条 CSS 规则写两遍。存量违例登记在案，只许减不许增。 */
run('tests/static-guards.cjs', process.execPath, ['tests/static-guards.cjs']);
/* 文档契约： 那份设计规范（令牌名 / 主题分段 / 两种外壳 / 公共类 /
   断点档 / 判据条数 / 画面档数）必须与代码一致 —— 文档不许说谎，
   代码改了而文档没改，下一个人就照着过期文档写。 */
run('tests/doc-contract.cjs', process.execPath, ['tests/doc-contract.cjs']);
run('tests/data-pack.cjs', process.execPath, ['tests/data-pack.cjs']);
/* 集中状态仓与快照仓：一次性迁移、校验和拒写、逻辑视图、轮转 / 校验 / 恢复、/backup/* 端点。
   整份在 os.tmpdir 的探针目录里跑，不写共享 .data。 */
run('tests/data-hub.cjs', process.execPath, ['tests/data-hub.cjs']);
run('tests/command-palette.cjs', process.execPath, ['tests/command-palette.cjs']);
/* 静态预压缩：br→gzip→原文 退档、ETag 带表示名、缓存命中不再压。
   常驻这一档不起实例（进程内驱动 serveStatic）；线上响应头与体积比对在同一条文件的 `--live` 档，
   登记在下面 e2e 段。 */
run('tests/static-encoding.cjs', process.execPath, ['tests/static-encoding.cjs']);
/* 作用域判据：引用了解析不到的裸名字（`node --check` 看不见，跑到那一行才 ReferenceError）。
   搬函数与「helper 只留一份」这两条路最容易留这种疤，本轮抓到过四处。 */
run('tests/scope-guards.cjs', process.execPath, ['tests/scope-guards.cjs']);
/* 按域搬线那一层的名单纪律：域模块顶上 `const { … } = E` 点名的每一位，engine.js 那只接线对象里必须真有的。
   漏一位不是报错，是那条分支解构出 undefined 才炸（抓到过：预览轴那一位漏 → 悬停取帧整条静默失效）。 */
run('tests/director-e-deps.cjs', process.execPath, ['tests/director-e-deps.cjs']);
/* 同一实现别写第二份（唯一实现清单）：跨 web/server/tools 数定义点，新增同名重复直接红。 */
run('tests/dup-guard.mjs', process.execPath, ['tests/dup-guard.mjs']);
run('tests/architecture.cjs', process.execPath, ['tests/architecture.cjs']);
/* metrics：--strict 恒开。管的是总量基线（M1 基线可读、M2 总行数/代码行不超基线 +5%）；
   单文件行数只打印不判红。本地跑也按同一把尺子量。 */
run('tests/metrics.cjs', process.execPath, ['tests/metrics.cjs', '--strict']);

/* ---------- 浏览器（按需；分档。这行 if 的文本是 map.cjs 登记表的分段标记，别改写法） ---------- */
if (process.argv.includes('--e2e') || process.env.ALL_E2E === '1' || process.argv.includes('--e2e:fast')) {
  run('tests/e2e/smoke.cjs', process.execPath, ['tests/e2e/smoke.cjs'], { tier: 'browser' });
  run('tests/e2e/ui-visual.cjs', process.execPath, ['tests/e2e/ui-visual.cjs'], { tier: 'browser' });
  run('tests/e2e/proxy.cjs', process.execPath, ['tests/e2e/proxy.cjs'], { tier: 'browser' });
/* 静态预压缩的线上那一半（同一份判据文件，`--live` 才起隔离实例）：响应头与三档体积真的到了线上。 */
run('tests/static-encoding.cjs', process.execPath, ['tests/static-encoding.cjs', '--live'], { tier: 'browser' });
  run('tests/e2e/cloud-sync.cjs', process.execPath, ['tests/e2e/cloud-sync.cjs'], { tier: 'browser' });
  /* 本机资产一条链：落点/双身份（fid + 采样签名）/改名挪目录认回/重复下载并成一张卡/删一张卡带走 altPaths
     /磁盘对账只补一次。两条都不开 Chrome，只起隔离实例。 */
  run('tests/e2e/local-chain.cjs', process.execPath, ['tests/e2e/local-chain.cjs'], { tier: 'browser' });
  /* 启动收尾那三段（清扫 / 重建 / 磁盘对账）：有请求在途就让路、让路有 3 秒上限、三段都真跑了。
     计时判据，独跑（见 E2E_SOLO）。它不开 Chrome，只起一份隔离实例并自己掌握第一笔请求。 */
  run('tests/e2e/boot-heavy.cjs', process.execPath, ['tests/e2e/boot-heavy.cjs'], { tier: 'browser' });
  run('tests/e2e/asr.cjs', process.execPath, ['tests/e2e/asr.cjs'], { tier: 'browser' });
  run('tests/e2e/search.cjs', process.execPath, ['tests/e2e/search.cjs'], { tier: 'browser' });
  run('tests/e2e/chat-actions.cjs', process.execPath, ['tests/e2e/chat-actions.cjs'], { tier: 'browser' });
  run('tests/e2e/chat-receipt.cjs', process.execPath, ['tests/e2e/chat-receipt.cjs'], { tier: 'browser' });
  run('tests/e2e/assistant-dock.cjs', process.execPath, ['tests/e2e/assistant-dock.cjs'], { tier: 'browser' });
  /* 拖素材卡到球 = 引用（真实拖放：载荷有号、输入框高亮、外部文件仍走上传、球不动）。 */
  run('tests/e2e/assistant-ref-drop.cjs', process.execPath, ['tests/e2e/assistant-ref-drop.cjs'], { tier: 'browser' });
  /* 凭号取图：正文清单同下标、asset_open 真的取到本机字节、取不到照实说、悬停/弹层/×。 */
  run('tests/e2e/assistant-ref-open.cjs', process.execPath, ['tests/e2e/assistant-ref-open.cjs'], { tier: 'browser' });
  run('tests/e2e/drag-guard.cjs', process.execPath, ['tests/e2e/drag-guard.cjs'], { tier: 'browser' });
  run('tests/e2e/actions.cjs', process.execPath, ['tests/e2e/actions.cjs'], { tier: 'browser' });
  run('tests/e2e/actions-feedback.cjs', process.execPath, ['tests/e2e/actions-feedback.cjs'], { tier: 'browser' });
  run('tests/e2e/chat-context.cjs', process.execPath, ['tests/e2e/chat-context.cjs'], { tier: 'browser' });
  run('tests/e2e/chat-search-cite.cjs', process.execPath, ['tests/e2e/chat-search-cite.cjs'], { tier: 'browser' });
  run('tests/e2e/director-perf.cjs', process.execPath, ['tests/e2e/director-perf.cjs'], { tier: 'browser' });
  /* 剪辑核冒烟（一次装配）：板 / 切一刀 / 撤销 / 转场 / 标记 / 字幕 / 缩放 / 就地刷 / 历史。
     日常验证走 `npm run test:director`（纯件 4 条 + 这一条，约 35 秒）；重交互仍靠 director-edit。 */
  run('tests/e2e/director-core.cjs', process.execPath, ['tests/e2e/director-core.cjs'], { tier: 'browser' });
  /* 冷启动基线：FCP/TTI/首屏脚本字节/JS 解析时间 + 堆用量；--soak 另做驻留对比。 */
  run('tests/perf/boot.cjs', process.execPath, ['tests/perf/boot.cjs'], { tier: 'browser' });
  run('tests/e2e/skills.cjs', process.execPath, ['tests/e2e/skills.cjs'], { tier: 'browser' });
  run('tests/e2e/skill-hub.cjs', process.execPath, ['tests/e2e/skill-hub.cjs'], { tier: 'browser' });
  run('tests/e2e/fcpxml.cjs', process.execPath, ['tests/e2e/fcpxml.cjs'], { tier: 'browser' });
  run('tests/e2e/editing-assets.cjs', process.execPath, ['tests/e2e/editing-assets.cjs'], { tier: 'browser' });
  /* 审阅弹窗「按这句再改」（PromptReview.onFollow）：行随 onFollow 出现、snapshot 带手改、
     就地流式 / 换清单 / 对话记录 / 失败退回、「重新规划」让路、平铺审阅同套。 */
  run('tests/e2e/split-follow.cjs', process.execPath, ['tests/e2e/split-follow.cjs'], { tier: 'browser' });
  /* 剪辑态左栏「历史编辑记录」：描述精确（哪一镜的哪一段 · 几秒 · 调到多少）· 非线性分支不丢 · 点历史即回退 · 撤销重做同一条路。 */
  run('tests/e2e/director-history.cjs', process.execPath, ['tests/e2e/director-history.cjs'], { tier: 'browser' });
  /* 剪辑核的交互面（新片模型）：四档各管一路 ——
     ① 落点与选择（点块 / 空白 / 轨名 / 刻度尺的归属 · 六档选择工具 · 滑移与滑动）；
     ② 拖动（把手 trim · 块体换行换序 · 吸附线 · 波纹那一句回执 · 锁定行拒绝）；
     ③ 标记一族（M / Shift+M / 面板过滤 · 拎块体与拎止点 · 范围两条读数）与转场浮层（预设 / 时长 / 去掉）；
     ④ 工具条全量（剪子 / 合并 / 复制 / 新增一段 / 摘掉一段 / 缩短拉长 / 回到播放头 / 缩放三颗 / 撤销重做）。 */
  run('tests/e2e/director-edit.cjs', process.execPath, ['tests/e2e/director-edit.cjs'], { tier: 'browser' });
  /* 播放核：seek 落在成片秒 / 转场窗口内出层出效果 / 字幕按起止进出 / 播放推进时画面与配音随主时钟对齐 /
     暂停冻住 / 到片尾停住 / 切页回来同一个预览面与播放头与剪辑态。 */
  run('tests/e2e/director-playback.cjs', process.execPath, ['tests/e2e/director-playback.cjs'], { tier: 'browser' });
  /* 导演台装配窗口里的关标签保存：没装配完不许把工作区写成空的（IndexedDB 与 .data/workspace.json 两份）。 */
  run('tests/e2e/director-boot-flush.cjs', process.execPath, ['tests/e2e/director-boot-flush.cjs'], { tier: 'browser' });
  /* 导演台开机结算：按声明补齐参数 = 静默落盘（不占撤销、不推进修订号），
     把存过的非法值收正 = 一次真编辑（撤销 + 标签 + 修订号 + 状态行那句「可 Ctrl+Z 退回」）。 */
  run('tests/e2e/director-boot-quiet.cjs', process.execPath, ['tests/e2e/director-boot-quiet.cjs'], { tier: 'browser' });
  /* 原始请求折叠条：脱敏 / 默认收起 / 导演台重画后仍展开 / 工作台三型标签。 */
  run('tests/e2e/raw-request.cjs', process.execPath, ['tests/e2e/raw-request.cjs'], { tier: 'browser' });
  /* 发送前预览：不用点生成就能看到将要发出的请求体 / 改提示词跟着变 / 预览不发请求。 */
  run('tests/e2e/raw-preview.cjs', process.execPath, ['tests/e2e/raw-preview.cjs'], { tier: 'browser' });
  /* 导演台项目组：分树 / 新建 / 老工程零迁移 / 删组不删短片。 */
  run('tests/e2e/director-groups.cjs', process.execPath, ['tests/e2e/director-groups.cjs'], { tier: 'browser' });
  /* 导演台项目文件：下拉底部默认折叠 / 两颗同级入口（导出拆分按钮、导入）缩进在一条竖线里、
     用正文色不用强调色 / 尾钮摊开「当前项目组」「全部」、未归组时按组导出不可用 /
     项目组随包往返（只认组名；撞名先问「并入 / 改名」，没有则现建）/
     内容完全一致的短片先问「跳过 / 照导并重命名」、全跳过时一部都不写 /
     导出全量候选与剪辑状态、导入追加不覆盖、撞名按「（导入）」→「（导入 2）」往后编号、坏包零写入。 */
  run('tests/e2e/director-project-pack.cjs', process.execPath, ['tests/e2e/director-project-pack.cjs'], { tier: 'browser' });
  run('tests/e2e/editing-assistant.cjs', process.execPath, ['tests/e2e/editing-assistant.cjs'], { tier: 'browser' });
  run('tests/e2e/ui-contract.cjs', process.execPath, ['tests/e2e/ui-contract.cjs'], { tier: 'browser' });
  run('tests/e2e/ui-shared.cjs', process.execPath, ['tests/e2e/ui-shared.cjs'], { tier: 'browser' });
  /* 页头组件：各页面共用那一条 .phead（全站唯一一份）。写好了没登记 = 全量档永远跑不到它。
     导演台正在重构，暂不在这一条里（接回来时 page-head.cjs 的 PAGES 补一行）。 */
  run('tests/e2e/page-head.cjs', process.execPath, ['tests/e2e/page-head.cjs'], { tier: 'browser' });
  /* 工作台左右两栏可拖：把手在本页 .layout（不是文档级选择器命中别的页）·
    拖得动且跟手 · **拖动全程页面左右两端的空白不变**（两栏块不许按内容定宽）· 落盘 · 复位 · 切页不丢。 */
  run('tests/e2e/wb-split.cjs', process.execPath, ['tests/e2e/wb-split.cjs'], { tier: 'browser' });
  /* 工作台左栏两段式：正文一段滚（.wb-body）+ 生成区钉在栏底（.wb-dock）。
     内容短时按钮也得贴栏底（不许浮在半空）、内容长时正文滚而按钮不动、换类型不丢、
     单列（≤1100）时 dock 改 sticky 贴视口底。 */
  run('tests/e2e/studio-dock.cjs', process.execPath, ['tests/e2e/studio-dock.cjs'], { tier: 'browser' });
  /* 文件类型筛选（图片 / 视频 / 音频）：收藏 / 工作台 / 资产库共用公共件 Wb.kindFilter
     （分段 + 每档计数 · 点一下换档 · 空档不画）。用户点名：这几页该用工作台那一副。 */
  run('tests/e2e/kind-filter.cjs', process.execPath, ['tests/e2e/kind-filter.cjs'], { tier: 'browser' });
  /* 资产库筛选 / 翻页链：平台下拉生效 · 改条件回第 1 页 · 搜索重画每档条数 ·
     翻页滚回列表顶（Wb.pageHead.scrollToList）· 多选条粘顶时贴着页头下缘。 */
  run('tests/e2e/assets-filters.cjs', process.execPath, ['tests/e2e/assets-filters.cjs'], { tier: 'browser' });
  run('tests/e2e/favorites-pager.cjs', process.execPath, ['tests/e2e/favorites-pager.cjs'], { tier: 'browser' });
  /* 翻页行在四页都得**画出来**（用户报过「翻页组件不显示」：工作台那一处是宿主从未登记，
     整行从未填过）。这一条盯「宿主登记 + 行可见 + 上一/下一页在」；翻页之后的行为
     由 favorites-pager 那一条盯（它点「下一页」看缩略图换页）。 */
  run('tests/e2e/pager-row.cjs', process.execPath, ['tests/e2e/pager-row.cjs'], { tier: 'browser' });
  /* 滚动位：点一颗按钮不该把视口甩回最上面（用户报过「有的页面点击按钮等组件后视角会移动到页面最上方」）。
     根因是「整片重画把滚动容器一起换掉了」—— 公共件 Wb.viewport.keep（web/ui/workbench.js）
     在重画点按锚点把视口还回去；列表那一族由 Wb.cards.paint 统一调用。这一条盯对照（裸重画确实丢位）、
     机制（套 keep 还原）与共享列表件（整箱重画不吃位）。 */
  run('tests/e2e/viewport-keep.cjs', process.execPath, ['tests/e2e/viewport-keep.cjs'], { tier: 'browser' });
  /* 真点真量：七页各挑几颗会整片重画的击点**真点一遍**（设置账号卡 / 工作台 / 导演台 / 资产库 /
     收藏 / 素材库详情 / 侧栏余额卡），量两条纪律 —— 视野不许回到最上面；展开完，点中的那一行
     还得留在视野里。合成宿主与静态判据够不着的形状（跨函数的存取对、对象属性攒位、
     嵌套工厂里的间接还原）由这一条的浏览器实测兜住。 */
  run('tests/e2e/viewport-clicks.cjs', process.execPath, ['tests/e2e/viewport-clicks.cjs'], { tier: 'browser' });
  /* 代理 stdout 断了不许自旋：启动器窗口一关，管道就断；写日志 → 抛 EPIPE → 被「未捕获异常」
     接住 → 又写日志 → 再抛一次，无限自旋（实测一个实例 1.6 小时烧掉 800 多秒 CPU，
     端口在听却不回话）。它起隔离实例，不开 Chrome。 */
  run('tests/e2e/proxy-stdout.cjs', process.execPath, ['tests/e2e/proxy-stdout.cjs'], { tier: 'browser' });
  /* 「存回本机」只存**多选勾选的那几条**（工作台 / 资产库 / 收藏三页）：那颗按钮住在多选条里，
     多选之后才出现；点下去只排勾选的那些。工作台的翻页行住在右栏顶上（搜索那一排下面）。
     顺带盯「多选时勾选框看得见」—— 勾选框隐形的话，「存选中的」就是盲存。 */
  run('tests/e2e/pull-selected.cjs', process.execPath, ['tests/e2e/pull-selected.cjs'], { tier: 'browser' });
  /* 资产库取数四档：首屏「取列表」请求数、后台计数不许重回第 1 页、
     同参数第二次 load 命中结果级短缓存、有缓存时选择器打开 ≤300ms。
     上游指到一个没人听的端口（判的是页面自己的取数轮次，不是平台通不通），并归零传输层重试。 */
  run('tests/e2e/asset-requests.cjs', process.execPath, ['tests/e2e/asset-requests.cjs'], { tier: 'browser' });
  /* 设置页找项这条路（含滚动唯一出口）：组锚点、行级命中、回车落点、Esc 清空、1024 溢出。 */
  run('tests/e2e/settings-nav.cjs', process.execPath, ['tests/e2e/settings-nav.cjs'], { tier: 'browser' });
  /* 主题两根轴：5 套配色 × 浅/深、跟随系统（CDP 模拟系统深色）、侧栏那颗日/夜按钮、
     坏值回落。深色由浅色现算 —— 判的是算完以后真的变了（亮度上去了、强调色跟着配色走）。 */
  run('tests/e2e/theme-modes.cjs', process.execPath, ['tests/e2e/theme-modes.cjs'], { tier: 'browser' });
  /* 左栏余额与导航这一列（含「余额区滚动条 = 0」）：六家全开 + 传输中，
     480–1100 共 8 档 × 展开/收起都不许出现内滚动条，收起态点开走公共弹窗。 */
  run('tests/e2e/sidebar-balance.cjs', process.execPath, ['tests/e2e/sidebar-balance.cjs'], { tier: 'browser' });
  /* 工作台右栏一次生成一张卡、且不空转：四条探针任务号各盯一个「列表与详情对不上」的真实形状
     （列表先出图 / 详情先出图 / 详情一直 404 / 详情一直答在跑），整个分歧窗口逐档采样。
     上游由页面里的状态机答复 + 代理再叠一层「指到一个没人听的端口」，一次真请求都不发。 */
  run('tests/e2e/task-cards.cjs', process.execPath, ['tests/e2e/task-cards.cjs'], { tier: 'browser' });
  run('tests/e2e/lock.cjs', process.execPath, ['tests/e2e/lock.cjs'], { tier: 'browser' });
} else {
  console.log('\n=== 浏览器 e2e ===\n  - 跳过（加 --e2e 全量 / --e2e:fast 冒烟档 6 个 / ALL_E2E=1）');
}

(async () => {
  console.log('判据子进程 node：' + NODE + (NODE === process.execPath ? '（= 当前进程，PATH 里没找到别的可跑的 node）' : '（系统 node，与 managed 分开）'));
  console.log('常驻并发池：min(8, ' + os.cpus().length + ' 核) = ' + CONCURRENCY + ' ｜ 常驻 ' + residentQueue.length
    + ' 项（串行白名单 ' + residentQueue.filter(t => SERIAL_WRITE.includes(t.name)).length + ' 项不进池）'
    + (FAST_ONLY ? ' ｜ e2e 冒烟档 ' + browserQueue.length + ' 项' : FULL_E2E ? ' ｜ e2e 全量 ' + browserQueue.length + ' 项' : ' ｜ e2e 跳过'));
  if (!FULL_E2E && FAST_ONLY) {
    console.log('  --e2e:fast 选中：' + [...browserQueue].map(t => t.name.replace(/^tests\/e2e\//, '')).join(', ')
      + '（挑档见 FAST_E2E）');
  }
  await flushResident();
  if (browserQueue.length) {
    if (FAST_ONLY) await flushBrowserFast();
    else await flushBrowser();
  }
  console.log('\n' + (bad ? '✗ ' + bad + ' 项失败' : '✓ 全部通过'));
  process.exitCode = bad ? 1 : 0;
})().catch(e => {
  console.error('✗ 跑测入口自己坏了：' + (e && e.stack || e));
  process.exitCode = 1;
});
