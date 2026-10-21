#!/usr/bin/env node
/* 代理边界：会话 Cookie / 同源 / 方法闸。
   没有 Cookie 的本机进程不能读 /data、/sys-status；跨站带 Cookie 也进不来；
   首屏静态响应负责种 Cookie（HttpOnly + SameSite=Strict）。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./harness.cjs');

(async () => {
  let proxy;
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-save-'));
  try {
    proxy = await h.startProxy({ env: { AUTOSAVE_DIR: saveDir } });
    const call = (path, opt = {}) => fetch(proxy.base + path, {
      method: opt.method || 'GET',
      headers: Object.assign({}, opt.cookie === null ? {} : { cookie: opt.cookie == null ? proxy.cookie : opt.cookie }, opt.headers || {}),
      redirect: opt.redirect || 'follow',
      body: opt.body,
    });

    const shell = await call('/shell.html', { cookie: null, redirect: 'manual' });
    if (shell.status !== 200) throw new Error('首屏必须 200，实际 ' + shell.status);
    const setCookie = (shell.headers.getSetCookie ? shell.headers.getSetCookie() : [shell.headers.get('set-cookie') || '']).join(';');
    if (!/wb_session=/.test(setCookie)) throw new Error('首屏没有种会话 Cookie');
    if (!/HttpOnly/i.test(setCookie) || !/SameSite=Strict/i.test(setCookie)) throw new Error('Cookie 属性不完整：' + setCookie);
    const csp = shell.headers.get('content-security-policy') || '';
    if (!/script-src 'self'/.test(csp) || /unsafe-eval/.test(csp)) throw new Error('首屏 CSP 不是严格 script-src \'self\'：' + csp);
    if (!/frame-ancestors 'none'/.test(csp)) throw new Error('首屏 CSP 缺 frame-ancestors：' + csp);
    /* 切片编码走 blob worker（P4）：响应头与 shell.html 的 meta 取交集，头里少这一条 worker 就建不起来。 */
    if (!/worker-src 'self' blob:/.test(csp)) throw new Error('首屏响应头缺 worker-src blob：切片 worker 会被 CSP 拦掉 —— ' + csp);
    if (shell.headers.get('x-content-type-options') !== 'nosniff') throw new Error('首屏缺 nosniff');

    const noCookie = await call('/data', { cookie: null });
    if (noCookie.status !== 401) throw new Error('无 Cookie 读 /data 应 401，实际 ' + noCookie.status);
    const wrong = await call('/sys-status', { cookie: 'wb_session=deadbeef' });
    if (wrong.status !== 401) throw new Error('错 Cookie 应 401，实际 ' + wrong.status);
    const okData = await call('/data');
    if (okData.status !== 200) throw new Error('带 Cookie 读 /data 应 200，实际 ' + okData.status);
    const open = await call('/registry', { cookie: null });
    if (open.status !== 200) throw new Error('/registry 不需要 Cookie，实际 ' + open.status);
    const who = await call('/whoami', { cookie: null });
    if (who.status !== 200) throw new Error('/whoami 不需要 Cookie（启动器要用），实际 ' + who.status);

    const cross = await call('/data', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    if (cross.status !== 403) throw new Error('跨站应 403，实际 ' + cross.status);
    const cross2 = await call('/data', { cookie: null, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    if (cross2.status !== 403) throw new Error('跨站（无 Cookie）也应 403，实际 ' + cross2.status);

    const getSync = await call('/cloud/sync');
    if (getSync.status !== 405) throw new Error('GET /cloud/sync 应 405，实际 ' + getSync.status);

    const cs = await call('/cloud/status');
    if (cs.status !== 200) throw new Error('GET /cloud/status 应 200，实际 ' + cs.status);
    const cb = await call('/cloud/backups');
    if (cb.status !== 200) throw new Error('GET /cloud/backups 应 200，实际 ' + cb.status);
    const ct = await call('/cloud/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (ct.status !== 400) throw new Error('没配云端时 /cloud/test 应 400，实际 ' + ct.status);

    const cap = await call('/capabilities?provider=deepseek');
    if (cap.status !== 200) throw new Error('GET /capabilities 应 200，实际 ' + cap.status);
    const capJson = await cap.json();
    if (!capJson || capJson.provider !== 'deepseek' || capJson.endpoint !== null || capJson.source !== 'registry') {
      throw new Error('/capabilities 回包不对：' + JSON.stringify(capJson));
    }
    const cap404 = await call('/capabilities?provider=no-such-provider');
    if (cap404.status !== 404) throw new Error('未知平台应 404，实际 ' + cap404.status);
    const cc = await call('/clear-cache', { method: 'POST' });
    if (cc.status !== 200) throw new Error('POST /clear-cache 应 200，实际 ' + cc.status);
    const ccJson = await cc.json();
    if (!ccJson || !ccJson.ok || !ccJson.cleared) throw new Error('/clear-cache 回包不对：' + JSON.stringify(ccJson));
    const env = await call('/env-status');
    if (env.status !== 200) throw new Error('/env-status 应 200，实际 ' + env.status);

    /* /sys-status 的**成功那一路**（上面只打了错 Cookie 的 401，那条在闸里就返回了，
       压根没跑到 sysStatus()）。这一格是设置页「代理体检」唯一的数据源，也是每个 e2e
       脚本认领「答话的是不是我刚起的那一份」凭据的地方 —— 它挂了的表象是「proxy 未就绪」，
       看着像探针起不来，其实是路由里抛了 ReferenceError（少注入一个配置就是这种死法）。 */
    const sys = await call('/sys-status');
    if (sys.status !== 200) throw new Error('/sys-status 应 200，实际 ' + sys.status);
    const sysJ = await sys.json();
    const num = v => typeof v === 'number' && isFinite(v);
    if (!sysJ || !sysJ.渲染 || !num(sysJ.渲染.队列上限) || !num(sysJ.渲染.同时) || !num(sysJ.渲染.保留分钟)) {
      throw new Error('/sys-status 的渲染那几个数没算出来（配置没交给渲染域？）：'
        + JSON.stringify(sysJ && sysJ.渲染));
    }
    if (!sysJ.渲染.中文名 || !/RENDER_VCODEC/.test(String(sysJ.渲染.来源 || ''))) {
      throw new Error('/sys-status 的渲染「来源」那一串没把生效值与出处一起说清：' + JSON.stringify(sysJ.渲染));
    }
    if (!sysJ.目录 || !sysJ.目录.数据 || !sysJ.目录.资产 || !sysJ.目录.渲染) {
      throw new Error('/sys-status 少了三个目录里某一个：' + JSON.stringify(sysJ && sysJ.目录));
    }
    if (!sysJ.健康 || !sysJ.转发) throw new Error('/sys-status 少了健康或转发那一格');
    if (sysJ.代理 && sysJ.代理.端口 !== proxy.port) {
      throw new Error('/sys-status 报的端口不是本探针这一份：' + sysJ.代理.端口 + ' ≠ ' + proxy.port);
    }
    const sysFresh = await call('/sys-status?fresh=1');
    if (sysFresh.status !== 200) throw new Error('/sys-status?fresh=1 应 200，实际 ' + sysFresh.status);

    const wav = Buffer.alloc(128);
    wav.write('RIFF', 0); wav.write('WAVE', 8);
    const laRes = await call('/local-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'route-probe.wav', data: wav.toString('base64'), format: 'wav', mime: 'audio/wav', meta: {} }),
    });
    const la = await laRes.json();
    if (laRes.status !== 200 || !la || !la.id) throw new Error('POST /local-assets 失败：' + JSON.stringify(la));
    const listRes = await call('/local-assets');
    const list = await listRes.json();
    if (listRes.status !== 200 || !list || !(list.data || []).some(x => x.id === la.id)) {
      throw new Error('GET /local-assets 没列出刚存的素材：' + JSON.stringify(list));
    }
    const del = await call('/local-assets/' + encodeURIComponent(la.id), { method: 'DELETE' });
    if (del.status !== 200) throw new Error('DELETE /local-assets/<id> 应 200，实际 ' + del.status);

    const saveRes = await call('/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'image', name: 'probe.png', format: 'png', data: Buffer.from('hello').toString('base64') }),
    });
    const saved = await saveRes.json();
    if (saveRes.status !== 200 || !saved || !saved.ok || !fs.existsSync(saved.path)) {
      throw new Error('POST /save 失败：' + JSON.stringify(saved));
    }
    const stale = await call('/save-stale');
    if (stale.status !== 200) throw new Error('/save-stale 应 200，实际 ' + stale.status);
    const usage = await call('/assets-usage');
    if (usage.status !== 200) throw new Error('/assets-usage 应 200，实际 ' + usage.status);

    const rs = await call('/render/status?id=nope');
    if (rs.status !== 404) throw new Error('/render/status 未知任务应 404，实际 ' + rs.status);
    const rp = await call('/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (rp.status !== 400) throw new Error('POST /render 缺 clips 应 400，实际 ' + rp.status);
    const rc = await call('/render/cancel?id=nope', { method: 'POST' });
    if (rc.status !== 404) throw new Error('/render/cancel 未知任务应 404，实际 ' + rc.status);
    const rd = await call('/render/dl?name=nope.mp4');
    if (rd.status !== 404) throw new Error('/render/dl 缺文件应 404，实际 ' + rd.status);

    const relayBad = await call('/textai/chat/completions', { headers: { 'x-up-base': 'http://127.0.0.1:1/v1' } });
    if (relayBad.status !== 400) throw new Error('relay 自定义地址到回环应 400，实际 ' + relayBad.status);

    for (const [p, m] of [
      ['/getfile?url=' + encodeURIComponent('http://127.0.0.1:1/x'), 'GET'],
      ['/getv?url=' + encodeURIComponent('file:///etc/passwd'), 'GET'],
      ['/fetch?url=' + encodeURIComponent('http://[::1]/x'), 'GET'],
      ['/s3put?url=' + encodeURIComponent('http://127.0.0.1:1/x'), 'PUT'],
    ]) {
      const r = await call(p, { method: m });
      if (r.status !== 400) throw new Error('出站通道应拒绝非公网 https：' + m + ' ' + p + ' → ' + r.status);
    }

    /* 上面这一趟打了三十来条端点：只要有一条在处理器里抛了没声明的变量 / 崩在 catch 之外，
       代理自己会在日志里记账。状态码可以靠兜底蒙过去，日志蒙不过去。 */
    const faults = h.logFaults(proxy.log);
    if (faults.length) throw new Error('代理日志里有未处理的异常（' + faults.length + ' 行）：\n  ' + faults.join('\n  '));

    console.log('✓ 代理边界通过（Cookie / 同源 / POST 闸 / 系统、云同步、能力、本机资产、渲染、relay、出站通道与清缓存路由）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (proxy) await proxy.stop();
    try { fs.rmSync(saveDir, { recursive: true, force: true }); } catch (e) {}
  }
})();
