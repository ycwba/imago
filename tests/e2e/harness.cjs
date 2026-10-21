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
   所有探针只写 .data-probe-* / .assets-probe-* / .renders-probe-*，跑完删除。 */
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

async function httpText(url, cookie = '') {
  const res = await fetch(url, { headers: cookie ? { cookie } : {} });
  return { status: res.status, text: await res.text(), cookie: getCookie(res) || cookie, headers: res.headers };
}

async function startProxy(opts = {}) {
  const port = opts.port || await freePort();
  const stamp = process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const dataDir = path.join(root, '.data-probe-' + stamp);
  const assetsDir = path.join(root, '.assets-probe-' + stamp);
  const renderDir = path.join(root, '.renders-probe-' + stamp);
  const skillsDir = path.join(root, '.skills-probe-' + stamp);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(renderDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const log = [];
  const proc = cp.spawn(process.execPath, ['proxy.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ASSETS_DIR: assetsDir, RENDER_DIR: renderDir, SKILLS_DIR: skillsDir, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', b => log.push(b.toString()));
  proc.stderr.on('data', b => log.push(b.toString()));
  const base = 'http://127.0.0.1:' + port;
  let cookie = '';
  let status = null;
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error('proxy 提前退出：\n' + log.join(''));
    try {
      const home = await httpText(base + '/', cookie);
      cookie = home.cookie || cookie;
      const r = await httpText(base + '/sys-status', cookie);
      if (r.status === 200) {
        status = JSON.parse(r.text);
        const got = status && status['目录'] && status['目录']['数据'] && status['目录']['数据']['路径'];
        if (got && path.resolve(got) !== path.resolve(dataDir)) {
          throw new Error('答话的不是本探针实例：' + got + ' ≠ ' + dataDir);
        }
        break;
      }
    } catch (e) {
      if (/答话的不是本探针实例/.test(e.message)) throw e;
    }
    await sleep(150);
  }
  if (!status) {
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
    try { proc.kill(); } catch (e) {}
    await sleep(100);
    for (const d of [dataDir, assetsDir, renderDir, skillsDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  };
  return { base, port, dataDir, assetsDir, renderDir, skillsDir, proc, log, status, cookie, stop };
}

/* 本机有没有 ffmpeg（剪辑闭环与「字幕编辑区」那一档画面要一段真视频）。 */
function hasFfmpeg() {
  try { cp.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
/* 造一段可播放的测试视频（同一份 lavfi 参数每次一样，画面判据才稳）。
   `seconds` 默认 2 秒；切片性能那条要 20 秒才摆得出二十格。
   `-g 12` 让每秒都有个关键帧：切片是逐时刻 seek，全挤在一个 GOP 里时量出来的是
   解码器从头解一遍的耗时，不是切片流水线的耗时（两种都该快，但后者才是被测的东西）。 */
function makeClip(dir, seconds = 2) {
  const sec = Math.max(1, Math.min(120, Math.round(Number(seconds) || 2)));
  const f = path.join(dir, 'probe-clip.mp4');
  cp.execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=128x72:rate=12:duration=' + sec,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12',
    '-movflags', '+faststart', f], { stdio: 'pipe' });
  if (!fs.existsSync(f) || fs.statSync(f).size < 1024) throw new Error('ffmpeg 没造出测试视频');
  return f;
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
/* 启用联网搜索并指向这台假上游；密钥只落 .*-probe-* 的 search.json，接口不回显。 */
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
  constructor(cdp) {
    this.cdp = cdp;
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate 失败');
    return r.result && r.result.value;
  }
  async waitFor(fn, timeout = 10000, every = 100) {
    const until = Date.now() + timeout;
    let last = null;
    while (Date.now() < until) {
      try { if (await this.eval(fn)) return true; } catch (e) { last = e; }
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
  close() { this.cdp.close(); }
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
      '--remote-debugging-port=0', '--user-data-dir=' + userDir, 'about:blank',
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
    const page = new Page(cdp);
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
   路由也挂得上，只有真请求打进去才在 catch 里冒出来（2026-10-20 实测：`render-jobs.js`
   少注入 `RENDER_QUEUE_MAX`，`/sys-status` 整条 500，设置页健康那一格空转，
   而 `node tests/all.cjs` 全绿）。探针打过的端点越多，这一条抓到东西的概率越大，
   所以每个起过代理的脚本收尾都该调一次。 */
function logFaults(log) {
  const text = Array.isArray(log) ? log.join('') : String(log || '');
  const re = /请求处理异常|is not defined|uncaughtException|unhandledRejection|内部错误/;
  return text.split(/\r?\n/).filter(l => re.test(l)).map(l => l.slice(0, 220));
}

module.exports = { startProxy, launchBrowser: Browser.launch, Browser, Page, CDP, sleep, root, findBrowser,
  startFakeSearch, useFakeSearch, hasFfmpeg, makeClip, logFaults };
