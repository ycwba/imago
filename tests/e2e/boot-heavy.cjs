#!/usr/bin/env node
/* 启动收尾那三段（清扫 / 重建 / 磁盘对账）不许压在「首屏正在下载」的那几秒里。
   跑法：node tests/e2e/boot-heavy.cjs（起一份隔离实例，不开 Chrome）

   三段里最重的一段是磁盘对账：它扫整个库根（readdir + stat，大库上几百毫秒到几秒），
   而它的触发点恰好是「第一个响应收尾」—— 那正是浏览器在抓外壳与上百份静态文件、
   SPA 在发第一个本机资产请求的那一秒。所以抽干是一个轮次跑一项、**只要还有请求在途就让出一轮**，
   让路又有上限（3 秒），到点照跑。这一条盯的就是这两句各自成立：

   ① 让路：先派一条**永远不写完请求体**的 POST（转发那一路是先读完体再打上游，
      所以它就挂在读体上、不占任何真实网络），把「在途」顶住；再让一个普通请求正常收尾。
      首个响应收尾之后如果立刻就去扫全库，等于没让路（界面那一秒就是冻住的）。
      这条 POST 走注册表里真实的一段 relay 前缀（`/sparkcine`）—— 那一路除同境外还要求会话
      Cookie，而唯一能种 Cookie 的请求本身就是一个「会收尾的响应」（它会把启动收尾顶跑），
      所以这里直接取代理自己落盘的那一枚 `<数据目录>\.session`（令牌跨重启不变，监听之前就写好了）。
   ② 不饿死：让路有 3 秒的闸。在途那一条从头到尾没有结束，重活也必须照样跑起来 ——
      不然对账永远不跑，用户手工拷进库根的那一批成品在界面上就一直「没存过」。
   ③ 三段都真跑了：预置一份过龄的 `.tmp-<pid>-<串>` 残留与一份没记账的 png，
      跑完必须分别是「残留没了」「账里多了一条」；重建那一段留下 `local-assets\rebuild.json` 那枚标记。
      少跑任何一段都是用户看得见的坏事：残留不清就一直占着盘，对账不跑就报「文件已不在」。

   计时口径：从**首个响应拿回字节**那一刻起算，收尾那一行日志必须在 1.5 秒之后、6 秒之内出现。
   另盯一句源码形状：`bootHeavyFlushed = true` 必须落在队列抽干**之后** —— 置位在抽干之前时，
   抽干期间任何新注册的任务都会被 afterFirstResponse 当场执行，排到它本该让路的重活前面。
   今天三个注册点都在监听回调里同步注册，这一步没有可观测的行为差别，只能由这一条静态判据盯着。

   ⚠ 探针目录由 harness 现建在系统临时目录里（这里再预置两个文件），跑完整组删除；
     用户真实的 下载\成像 一个字节都不碰。 */
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* 一张 1x1 PNG（磁盘对账只按扩展名归类，不校验图像内容） */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const fails = [];
let n = 0;
const check = (name, cond, detail) => {
  ++n;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || detail === undefined ? '' : ' —— ' + JSON.stringify(detail)));
  if (!cond) fails.push(name);
  return !!cond;
};
/* 后面每一条都建立在前一条成立之上（计时与落盘效果都是），红了就别往下数：
   接着跑只会把「同一个原因」报成五处。 */
const must = (name, cond, detail) => { if (!check(name, cond, detail)) throw new Error('停在这里：' + name); };

(async () => {
  const probeRoot = h.tempDir('boot-heavy');
  const dataDir = path.join(probeRoot, 'data');
  const assetsDir = path.join(probeRoot, 'assets');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(assetsDir, '图片'), { recursive: true });
  /* 崩溃残留：形状必须是清扫那一段只认的那一个（`.tmp-<数字>-<2~8 位小写>`），
     年龄要越过 15 分钟那道闸 —— 那道闸保护的是**别的实例正在写**的同形状文件。 */
  const stale = path.join(dataDir, 'probe.tmp-4242-ab12');
  fs.writeFileSync(stale, '半截的临时文件');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  /* 盘上有、账里没有的一份成品 —— 只有磁盘对账会把它补进账 */
  const seed = path.join(assetsDir, '图片', '拷进来的成品.png');
  fs.writeFileSync(seed, PNG);

  /* `probe:false`：默认那两条就绪探测就是实例的头两个响应，重活会被它们顶跑 ——
     这一条判据要自己掌握第一笔请求，所以「确认真的在听」改看日志那一行。 */
  const proxy = await h.startProxy({ probeRoot, probe: false, env: { AUTOSAVE_DIR: path.join(probeRoot, 'downloads') } });
  const text = () => proxy.log.join('');
  const died = () => { if (proxy.proc.exitCode !== null) throw new Error('proxy 提前退出（' + proxy.proc.exitCode + '）：\n' + text()); };
  /* 轮询日志：返回**第一次看见**这一行的时刻（粒度 50ms，对 1.5 秒 / 6 秒这两道边界够用） */
  const waitLine = async (re, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      died();
      const hit = re.exec(text());
      if (hit) return { at: Date.now(), line: hit[0], m: hit };
      await sleep(50);
    }
    throw new Error('等不到日志里的那一行：' + re + '\n—— 现有日志：\n' + text());
  };
  const rebuildMark = path.join(dataDir, 'local-assets', 'rebuild.json');

  let hung = null;
  try {
    /* ---------- 第一笔：一条挂在读体上的 POST（把「在途」顶住）---------- */
    hung = net.connect(proxy.port, '127.0.0.1');
    await new Promise((resolve, reject) => { hung.once('connect', resolve); hung.once('error', reject); });
    hung.setNoDelay(true);
    let hungGone = false, hungBytes = 0;
    hung.on('close', () => { hungGone = true; });
    hung.on('data', b => { hungBytes += b.length; });
    const tokenPath = path.join(dataDir, '.session');
    must('会话令牌已落盘（第一笔请求过会话闸靠它）', fs.existsSync(tokenPath), tokenPath);
    /* 声明 4096 字节只交一截：转发那一路读完体才打上游，于是这条请求既不占网络、也永不收尾。 */
    hung.write('POST /sparkcine/v1/tasks HTTP/1.1\r\nHost: 127.0.0.1:' + proxy.port
      + '\r\nCookie: wb_session=' + fs.readFileSync(tokenPath, 'utf8').trim()
      + '\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{"prompt":');
    /* 它被派发出去了（在途数就是从这一刻起大于 0）再往下走 */
    const first = await waitLine(/\[启动\] 首个请求 [^\n]*/, 10000);
    must('第一笔就是那条挂住的 POST', /sparkcine/.test(first.line), first.line);

    /* ---------- 第二笔：正常收尾，触发抽干 ---------- */
    const res = await fetch(proxy.base + '/shell.html', { signal: AbortSignal.timeout(10000) });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    const cookie = raw.map(x => String(x).split(';')[0]).join('; ');
    await res.text();
    const tDrain = Date.now();

    /* ---------- ① 让路：这一段时间里三段都不许动 ---------- */
    await sleep(250);
    died();
    check('让路：首个响应收尾后 250ms 内没跑收尾三段', !/\[启动\] 模块加载/.test(text()),
      text().split('\n').filter(l => /启动/.test(l)));
    check('让路：过龄的 .tmp 残留还没被删（清扫没抢跑）', fs.existsSync(stale), stale);
    check('让路：重建标记还没落盘（重建没抢跑）', !fs.existsSync(rebuildMark), rebuildMark);

    /* ---------- ② 不饿死：在途那一条始终没结束，重活也得在 3 秒的闸到点时跑完 ---------- */
    const done = await waitLine(/\[启动\] 模块加载 [^\n]*收尾（[^\n]*）[^\n]*/, 9000);
    const gap = done.at - tDrain;
    console.log('  · 首个响应收尾 → 收尾那一行：' + gap + 'ms（让路上限 3000ms）');
    must('挂住的那一条始终在途（计时成立的前提）', !hungGone && hungBytes === 0, { hungGone, hungBytes });
    check('让路：至少隔 1.5 秒才去扫全库（≥1500ms）', gap >= 1500, { gap });
    check('不饿死：3 秒的闸到点就跑（≤6000ms）', gap <= 6000, { gap });

    /* ---------- ③ 三段都真跑了：各看各的落盘效果 ---------- */
    const seg = /收尾（清扫 (\d+) · 重建 (\d+) · 对账 (\d+)，补 (\d+) 条）/.exec(done.line);
    must('收尾那一行报得出三段', !!seg, done.line);
    check('清扫跑了：过龄的 .tmp 残留没了', !fs.existsSync(stale), stale);
    check('重建跑了：落了「这一次已经重建过」的标记', fs.existsSync(rebuildMark), rebuildMark);
    check('对账跑了：补进盘上那一份没记账的成品', Number(seg[4]) >= 1, done.line);

    /* 账与接口都在：那一份 png 进了本机资产库列表，界面上才不再是「没存过」 */
    const req = async p => {
      const r = await fetch(proxy.base + p, { headers: { cookie } });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j };
    };
    let row = null;
    for (let i = 0; i < 30 && !row; i++) {
      const l = await req('/local-assets');
      row = ((l.json && l.json.data) || []).find(x => /拷进来的成品/.test(String(x.name || '')));
      if (!row) await sleep(100);
    }
    must('GET /local-assets 读得到对账补进来的那一份', !!row, '');
    check('那一条落在 图片\\ 下、记成对账来的', /^图片[\\/]/.test(String(row.file)) && row.adopted === true,
      { file: row.file, adopted: row.adopted });

    /* 认领「答话的就是本判据刚起的这一份」：数据与库两个根都点名探针目录 */
    const st = await req('/sys-status');
    const named = JSON.stringify((st.json && st.json['目录']) || {});
    check('答话的是本探针实例（数据与库两个根都点名探针目录）',
      st.status === 200 && named.includes(path.basename(dataDir)) && named.includes(path.basename(assetsDir)),
      named.slice(0, 240));

    /* ---------- 置位顺序（今天没有可观测的行为差别，只能看源码形状）---------- */
    const appSrc = fs.readFileSync(path.join(h.root, 'server/app.js'), 'utf8');
    const bootFn = appSrc.slice(appSrc.indexOf('function runBootHeavy'), appSrc.indexOf('function afterFirstResponse'));
    check('置位在抽干之后（bootHeavyFlushed 落在队列空的那一支里）',
      /if \(!bootHeavyQ\.length\)[\s\S]{0,400}bootHeavyFlushed = true/.test(bootFn),
      bootFn.slice(0, 260));
  } finally {
    try { if (hung) hung.destroy(); } catch (e) {}
    try { await proxy.stop(); } catch (e) {}
  }
  console.log('\n结论：' + (fails.length ? '未过 ' + fails.length + ' 条：' + fails.join(' / ') : '全部通过（' + n + ' 项）'));
  if (fails.length) process.exit(1);
})().catch(e => {
  console.error('✗ ' + ((e && e.stack) || e));
  process.exit(1);
});
