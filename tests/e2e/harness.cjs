#!/usr/bin/env node
/* 隔离代理 + headless Chrome 的公共 harness。
   用法：
     const h = require('./harness.cjs');
     const proxy = await h.startProxy();
     const browser = await h.launchBrowser();
     const page = await browser.newPage();
     await page.goto(proxy.base + '/shell.html#director.html');
     await page.waitFor(() => document.body.innerText.length > 0);
     await page.screenshot('shot.png');
     await browser.close(); await proxy.stop();
   探针目录落在系统临时目录（`imago-probe-*`：一处 mkdtemp 父目录，data / assets / renders /
   skills 四个根都从它派生），跑完整组删除 —— 仓库根与用户数据目录一个字节都不写。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const cp = require('child_process');

const root = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function getCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return raw.map(x => String(x).split(';')[0]).join('; ');
}

/* timeout>0 时给整次请求（含读 body）兜一个硬上限：机器被几条 Chrome 一起压住时，
   一次卡住的连接会把调用方的等待窗口整个绕过去（就绪探测那种「20 秒内每 150ms 试一次」
   的循环挂在一次 fetch 上就永远走不到下一次判断）。 */
async function httpText(url, cookie = '', timeout = 0) {
  const res = await fetch(url, { headers: cookie ? { cookie } : {}, signal: timeout ? AbortSignal.timeout(timeout) : undefined });
  return { status: res.status, text: await res.text(), cookie: getCookie(res) || cookie, headers: res.headers };
}

/* 探针父目录：系统临时目录下一处 mkdtemp。判据进程被硬杀时，留下的空壳落在系统临时目录里、
   由系统回收 —— 直接建在仓库根就会攒成一片再没人清。`tag` 只用于排障时认出是哪条判据留下的。 */
function tempDir(tag = 'probe') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'imago-' + tag + '-'));
}

async function startProxy(opts = {}) {
  const port = opts.port || await freePort();
  const probeRoot = opts.probeRoot ? path.resolve(opts.probeRoot) : tempDir('probe');
  const dataDir = path.join(probeRoot, 'data');
  const assetsDir = path.join(probeRoot, 'assets');
  const renderDir = path.join(probeRoot, 'renders');
  const skillsDir = path.join(probeRoot, 'skills');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(renderDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const log = [];
  const proc = cp.spawn(process.execPath, ['proxy.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir, ASSETS_DIR: assetsDir,
      RENDER_DIR: renderDir, SKILLS_DIR: skillsDir,
      /* 「下载」基座也一起指走：提示词归档（`下载\成像\提示词`）与默认库根都从它派生，
         上面那四枚管不到它 —— 少指这一枚，判据里任何一次归档写入都落在用户真实的成品目录上
         （`/prompts` 整目录兜底重建索引时会重写 `_index.json`）。`opts.env` 在后面展开，
         要点名另一处的判据照样能盖掉这一默认。 */
      AUTOSAVE_DIR: path.join(probeRoot, 'downloads'),
      ...(opts.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', b => log.push(b.toString()));
  proc.stderr.on('data', b => log.push(b.toString()));
  const base = 'http://127.0.0.1:' + port;
  /* 起不来时**必须**先把子进程杀掉再抛：它的 stdout/stderr 管道是本进程的事件循环句柄，
     不杀就等于「判据已经打印过「未就绪」了，却还挂在那里」—— 外层只好等 600 秒超时才 SIGKILL，
     端口与四个探针目录也跟着白占十分钟。 */
  const abort = async () => {
    try { proc.kill(); } catch (e) {}
    await sleep(150);
    /* Windows 上刚被杀的进程可能还握着目录句柄，rmSync 会 EBUSY —— 多试几次再放弃。
       实在删不掉也只是系统临时目录里的一组空壳，由系统回收，仓库根不受影响。 */
    for (let i = 0; i < 4; i++) {
      try { fs.rmSync(probeRoot, { recursive: true, force: true }); break; } catch (e) { if (i === 3) break; await sleep(150); }
    }
  };
  let cookie = '';
  let status = null;
  const until = Date.now() + 20000;
  /* `probe:false` —— 不等就绪探测，改等监听回调自己打的那一行「已启动」。
     默认那两条探测（`GET /` 与 `GET /sys-status`）**就是这个实例收到的头两个响应**，而启动收尾
     那三段（清扫 / 重建 / 磁盘对账）排在「第一个响应收尾」之后 —— 用它起实例，等 return 回来时
     重活已经跑完了，任何「重活有没有给在途请求让路」都无从下手。要自己掌握第一笔请求的判据
     换这一条出口：只改「怎么确认真的在听」，探针目录、超时先杀子进程再抛、收尾整组删都照旧。 */
  const readyLine = 'proxy 已启动: http://localhost:' + port;
  if (opts.probe === false) {
    while (Date.now() < until && !log.join('').includes(readyLine)) {
      if (proc.exitCode !== null) { await abort(); throw new Error('proxy 提前退出：\n' + log.join('')); }
      await sleep(60);
    }
    if (!log.join('').includes(readyLine)) {
      await abort();
      throw new Error('proxy 起了但 20 秒没打出「已启动」那一行：\n' + log.join(''));
    }
  }
  while (opts.probe !== false && Date.now() < until) {
    if (proc.exitCode !== null) { await abort(); throw new Error('proxy 提前退出：\n' + log.join('')); }
    try {
      const home = await httpText(base + '/', cookie, 3000);
      cookie = home.cookie || cookie;
      const r = await httpText(base + '/sys-status', cookie, 3000);
      if (r.status === 200) {
        status = JSON.parse(r.text);
        const got = status && status['目录'] && status['目录']['数据'] && status['目录']['数据']['路径'];
        if (got && path.resolve(got) !== path.resolve(dataDir)) {
          throw new Error('答话的不是本探针实例：' + got + ' ≠ ' + dataDir);
        }
        break;
      }
    } catch (e) {
      if (/答话的不是本探针实例/.test(e.message)) { await abort(); throw e; }
    }
    await sleep(150);
  }
  if (opts.probe !== false && !status) {
    await abort();
    /* 就绪探测打的就是 `/sys-status`，所以「路由里抛了未声明的变量」在这一层的表象是
       「proxy 未就绪」—— 不点名日志里的异常，下一步就会去查端口、查进程，白绕一圈。 */
    const f = logFaults(log);
    if (f.length) throw new Error('proxy 起了但 /sys-status 一直没回 200 —— 日志里的异常：\n  '
      + f.join('\n  ') + '\n（先修这个，不是端口问题）');
    throw new Error('proxy 未就绪：\n' + log.join(''));
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    await abort();
  };
  return { base, port, probeRoot, dataDir, assetsDir, renderDir, skillsDir, proc, log, status, cookie, stop };
}

/* 一段 2 秒的样本视频（tests/fixtures/media/probe-clip.mp4：testsrc 128×72 · 12fps ·
   每秒一个关键帧）。剪辑 / 播放 / 字幕这些判据拿它当输入素材。
   输入素材入库而不是现场转码：判据只依赖 Node + Chrome，不要求机器上装转码工具。 */
const CLIP_FIXTURE = path.join(root, 'tests/fixtures/media/probe-clip.mp4');
function clipFixture() {
  if (!fs.existsSync(CLIP_FIXTURE)) throw new Error('缺少测试样本视频：tests/fixtures/media/probe-clip.mp4');
  return CLIP_FIXTURE;
}

/* 联网搜索的假上游（Tavily 形状）+ 把代理的搜索设置指过去。
   测「搜索引用」的几个探针共用这一台：rows(query) 决定回哪几条，hits() 数打过几次。
   只监听 127.0.0.1，密钥也是探针自己造的假密钥。 */
async function startFakeSearch(rows) {
  const http = require('http');
  let hits = 0;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      hits++;
      let body = {};
      try { body = JSON.parse(raw); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: rows(String((body && body.query) || '')) || [] }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    port, baseUrl: 'http://127.0.0.1:' + port + '/search',
    hits: () => hits,
    stop() { try { if (srv.closeAllConnections) srv.closeAllConnections(); } catch (e) {} srv.close(); },
  };
}
/* 启用联网搜索并指向这台假上游；密钥只落探针目录里的 search.json，接口不回显。 */
async function useFakeSearch(proxy, fake, key) {
  const r = await fetch(proxy.base + '/search/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie: proxy.cookie },
    body: JSON.stringify({ enabled: true, provider: 'tavily', maxResults: 5,
      credentialSource: 'manual', baseUrl: fake.baseUrl, key }),
  });
  const text = await r.text();
  if (r.status !== 200) throw new Error('保存假搜索上游设置失败：' + r.status + ' ' + text);
  return true;
}

function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge，设置 CHROME_PATH');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of (this.listeners.get(msg.method) || [])) { try { fn(msg.params); } catch (e) {} }
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
      }, 30000);
    });
  }
  on(method, fn) {
    const a = this.listeners.get(method) || [];
    a.push(fn); this.listeners.set(method, a);
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

class Page {
  constructor(cdp, info = {}) {
    this.cdp = cdp;
    this.targetId = info.targetId || '';
    this.browserCdp = info.browserCdp || null;
    this.errors = [];
    /* 只记 text 会得到一句「Uncaught」，真错在 exception.description（含调用栈首行）。 */
    cdp.on('Runtime.exceptionThrown', p => {
      const d = (p && p.exceptionDetails) || {};
      this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
    });
    cdp.on('Runtime.consoleAPICalled', p => {
      if (p.type === 'error') this.errors.push((p.args || []).map(a => a.value || a.description || '').join(' '));
    });
  }
  async init() {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  /* Page.navigate 的回执要等**导航提交**才回来；机器忙时首字节慢，回执能迟到 30 秒以上，
     CDP 层就报「CDP 超时：Page.navigate」—— 但导航其实可能照常进行中，也可能这一次根本没起来。
     所以成败只看一件事：页面地址换成目标了、文档不再 loading。
     6 秒还没提交就重发一次导航（同一个 URL 重发是无副作用的），
     真的到不了时下面这一句会带 CDP 原话失败，而不是留一个含糊的超时。
     默认等到 90 秒：这台机器一边在跑别的程序时一次提交能压到半分钟以上（空机器上是 0.2 秒），
     而这一层只判「页面到不到得了」，页面内容各条测试自己另有断言，多等不会把白屏等成通过。 */
  async goto(url, timeout = 90000) {
    const target = url.split('#')[0];
    let navErr = '';
    const send = () => this.cdp.send('Page.navigate', { url }).catch(e => { navErr = String((e && e.message) || e); });
    send();
    const until = Date.now() + timeout;
    let again = true;
    while (Date.now() < until) {
      const at = await this.eval(() => location.href.split('#')[0]).catch(() => '');
      const rs = await this.eval(() => document.readyState).catch(() => 'loading');
      if (at === target && rs !== 'loading') return true;
      if (again && Date.now() > until - timeout + 6000) { again = false; send(); }
      await sleep(120);
    }
    throw new Error('页面没导航过去：' + url + (navErr ? '（CDP：' + navErr + '）' : '（CDP 没报错，是没提交）'));
  }
  /* 在文档里**任何页面脚本之前**跑一段（CDP 的 addScriptToEvaluateOnNewDocument，下一次导航生效）。
     要数「这个监听一共绑了几次」的判据只能用这个：灯箱那类幂等闸是在页面挂载那一次装的，
     等页面跑完再去包 addEventListener，第一次绑定已经过去了，数出来永远是 0 或 1 —— 假绿。 */
  async addInitScript(fn) {
    const expression = typeof fn === 'function' ? '(' + fn.toString() + ')()' : String(fn);
    const r = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: expression });
    return r && r.identifier;
  }
  async eval(fn, ...args) {
    const expression = typeof fn === 'function' ? '(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')' : String(fn);
    const r = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'evaluate 失败');
    }
    return r.result && r.result.value;
  }
  async waitFor(fn, timeout = 10000, every = 100, ...args) {
    const until = Date.now() + timeout;
    let last = null;
    while (Date.now() < until) {
      try { if (await this.eval(fn, ...args)) return true; } catch (e) { last = e; }
      await sleep(every);
    }
    throw new Error('等待超时' + (last ? '：' + last.message : ''));
  }
  async screenshot(file) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  /* 往页面里那颗 file 入口塞一个真文件（导入类判据唯一的合法入口： FileReader 读的确实是盘上的字节）。
     有些实现要在 change 里自己读 files，光 setFileInputFiles 不派发事件就不会跑，所以补一次派发。 */
  async setFile(selector, files) {
    const list = Array.isArray(files) ? files : [files];
    await this.cdp.send('DOM.enable');
    const dom = await this.cdp.send('DOM.getDocument', { depth: -1 });
    const q = await this.cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector });
    if (!q || !q.nodeId) throw new Error('页面上找不到这个 file 入口：' + selector);
    await this.cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: list });
    await this.eval(sel => { const i = document.querySelector(sel); if (i) i.dispatchEvent(new Event('change', { bubbles: true })); }, selector);
  }
  async setSize(width, height) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  /* 清掉这台浏览器里某个源的本机存储（IndexedDB + localStorage）。
     只能在**这个源还没有任何文档装载**时调（新标签停在 about:blank 就行）：
     装载中的页面握着 IndexedDB 连接，删除要等它让出版本，那一句 CDP 会一直悬到超时。 */
  async clearStorage(origin) {
    await this.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb' });
  }
  /* 开机对账（DataSync.boot）在「本地空 + 数据文件里有」时会把它拉回 localStorage，
     拉到东西就整页刷新一次（600ms 后，见 web/ui/datasync.js）。同一台代理连着跑几档开局时，
     上一档留在 .data 里的界面偏好（吸附 / 波纹 / 分栏…）会让下一档在装完探针之后被那次刷新连锅端走。
     要测**界面**（不是测对账）的多档判据在 goto 之前调这一句：把本会话标成「已同步」，
     DataSync.boot 整段跳过 —— 探针与刚装好的界面状态不再被页面自己那次刷新抹掉。
     要测对账本身的判据（cloud-sync 那一类）不要调它。 */
  async skipDataSyncBoot() {
    await this.addInitScript(() => {
      try {
        const seg = location.pathname.split('/').pop() || 'shell.html';
        sessionStorage.setItem('__synced_' + seg, '1');
      } catch (e) { /* 拿不到 sessionStorage 就照常对账：判据自己会看出来 */ }
    });
  }
  /* 只断开 CDP 连接的话标签页还活着：页面里的定时器、落盘和关标签那一次 flush 照跑，
     同一台代理 + 同一个 profile 的下一档开局读到的就是上一档留下的那一份。
     所以 close 真的把这张标签关掉（等效于用户点关闭）；关不掉（比如拦在离开上的弹窗）
     也要把连接断了继续跑，不能把整条判据卡在 close 上。 */
  async close() {
    if (this.browserCdp && this.targetId) {
      await this.browserCdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    }
    this.cdp.close();
  }
}

class Browser {
  constructor(proc, userDir, cdp, port) {
    this.proc = proc; this.userDir = userDir; this.cdp = cdp; this.port = port;
  }
  static async launch(opts = {}) {
    const exe = opts.executable || findBrowser();
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-chrome-'));
    const proc = cp.spawn(exe, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-sync', '--disable-extensions',
      '--remote-debugging-port=0', '--user-data-dir=' + userDir,
      ...(Array.isArray(opts.args) ? opts.args : []),
      'about:blank',
    ], { stdio: 'ignore' });
    const portFile = path.join(userDir, 'DevToolsActivePort');
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (fs.existsSync(portFile)) {
        const [p, wsPath] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        if (p && wsPath) {
          const cdp = await CDP.connect('ws://127.0.0.1:' + p + wsPath);
          return new Browser(proc, userDir, cdp, Number(p));
        }
      }
      if (proc.exitCode !== null) throw new Error('浏览器提前退出');
      await sleep(100);
    }
    throw new Error('浏览器未就绪');
  }
  async newPage() {
    let r = await fetch('http://127.0.0.1:' + this.port + '/json/new?about:blank', { method: 'PUT' }).then(x => x.json()).catch(() => null);
    if (!r) r = await fetch('http://127.0.0.1:' + this.port + '/json/new?about:blank').then(x => x.json());
    const target = Array.isArray(r) ? r[0] : r;
    if (!target || !target.webSocketDebuggerUrl) throw new Error('创建页面失败');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    const page = new Page(cdp, { targetId: target.id, browserCdp: this.cdp });
    await page.init();
    return page;
  }
  async close() {
    try { this.cdp.close(); } catch (e) {}
    try { this.proc.kill(); } catch (e) {}
    await sleep(100);
    try { fs.rmSync(this.userDir, { recursive: true, force: true }); } catch (e) {}
  }
}

/* 真起过一次进程之后，代理日志里不许有「请求处理异常」这一类。
   静态判据看不见「把函数搬进新文件、忘了把配置一起注入」那种改法：语法通、require 得动、
   路由也挂得上，只有真请求打进去才在 catch 里冒出来（典型样子是 `/sys-status` 整条 500、
   设置页健康那一格空转，而 `node tests/all.cjs` 全绿）。探针打过的端点越多，这一条抓到东西的概率越大，
   所以每个起过代理的脚本收尾都该调一次。 */
function logFaults(log) {
  const text = Array.isArray(log) ? log.join('') : String(log || '');
  const re = /请求处理异常|is not defined|uncaughtException|unhandledRejection|内部错误/;
  return text.split(/\r?\n/).filter(l => re.test(l)).map(l => l.slice(0, 220));
}

/* 视觉指纹：整张图缩成 24×14 的平均色格。两种画面共用这一份 —— 整页截图（ui-visual）
   与建模台活动机位出图（model-render）都缩成同一张网格，差异判据也一起住在这里。
   pngjs 是开发依赖，按需取：不起 Chrome 的判据不该被它拖住。 */
function fingerprint(buf, grid) {
  const g = grid || { w: 24, h: 14 };
  let PNG;
  try { PNG = require('pngjs').PNG; }
  catch (e) { throw new Error('缺少开发依赖 pngjs：先运行 npm install'); }
  const png = PNG.sync.read(buf);
  const cellW = png.width / g.w, cellH = png.height / g.h;
  const out = [];
  for (let gy = 0; gy < g.h; gy++) {
    for (let gx = 0; gx < g.w; gx++) {
      let r = 0, gg = 0, b = 0, n = 0;
      const x0 = Math.floor(gx * cellW), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));
      const y0 = Math.floor(gy * cellH), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
      for (let y = y0; y < Math.min(y1, png.height); y++) {
        for (let x = x0; x < Math.min(x1, png.width); x++) {
          const i = (y * png.width + x) * 4;
          r += png.data[i]; gg += png.data[i + 1]; b += png.data[i + 2]; n++;
        }
      }
      out.push([Math.round(r / n), Math.round(gg / n), Math.round(b / n)]);
    }
  }
  return out;
}
/* 两张指纹的差异：`cells` 是任一分量差 > `over` 的格子数，`mean` 是全部格子的最大分量差均值。
   数组形状不对（旧基线缺这一档）按最坏情况算，调用方照常判红。 */
function fpDiff(a, b, over = 24) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return { bad: true, cells: 999, mean: 255, max: 255 };
  let cells = 0, sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.max(
      Math.abs((a[i] && a[i][0] || 0) - (b[i] && b[i][0] || 0)),
      Math.abs((a[i] && a[i][1] || 0) - (b[i] && b[i][1] || 0)),
      Math.abs((a[i] && a[i][2] || 0) - (b[i] && b[i][2] || 0))
    );
    sum += d;
    if (d > over) cells++;
    if (d > max) max = d;
  }
  return { bad: false, cells, mean: sum / a.length, max };
}

module.exports = { startProxy, tempDir, launchBrowser: Browser.launch, Browser, Page, CDP, sleep, root, findBrowser,
  startFakeSearch, useFakeSearch, clipFixture, logFaults, fingerprint, fpDiff };
