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
    /* 'wasm-unsafe-eval' 只放开 WebAssembly 编译，不是 'unsafe-eval'：
       反查时要把 wasm- 前缀那一条排掉，否则新加的 wasm 放行会被误判成放开 JS eval。 */
    const hasUnsafeEval = /(?:^|[\s;])'unsafe-eval'/.test(csp);
    if (!/script-src 'self'/.test(csp) || hasUnsafeEval) throw new Error('首屏 CSP 不是严格 script-src \'self\'：' + csp);
    if (!/'wasm-unsafe-eval'/.test(csp)) throw new Error('首屏 CSP 缺 wasm-unsafe-eval（wasm 后端加载会被拦）：' + csp);
    if (!/frame-ancestors 'none'/.test(csp)) throw new Error('首屏 CSP 缺 frame-ancestors：' + csp);
    /* 切片编码走 blob worker：响应头与 shell.html 的 meta 取交集，头里少这一条 worker 就建不起来。 */
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
    /* 备份恢复统一走 /backup/*：旧的 /cloud/backups 与 /cloud/restore 已删除。 */
    const bs = await call('/backup/status');
    if (bs.status !== 200) throw new Error('GET /backup/status 应 200，实际 ' + bs.status);
    const bsJson = await bs.json();
    if (typeof bsJson.ok !== 'boolean' || !Array.isArray(bsJson.snapshots)) {
      throw new Error('/backup/status 没回健康状态与快照清单');
    }
    const be = await call('/backup/export');
    if (be.status !== 200) throw new Error('GET /backup/export 应 200，实际 ' + be.status);
    const beJson = await be.json();
    if (!beJson.pack || beJson.pack.version !== 2) throw new Error('GET /backup/export 没回 v2 整包');
    const bv = await call('/backup/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (bv.status !== 200) throw new Error('POST /backup/verify 应 200，实际 ' + bv.status);
    const bvJson = await bv.json();
    if (typeof bvJson.ok !== 'boolean') throw new Error('POST /backup/verify 没回校验结果');
    const ct = await call('/cloud/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (ct.status !== 400) throw new Error('没配云端时 /cloud/test 应 400，实际 ' + ct.status);

    /* deepseek 自 v19 起声明了 endpoints.models（端点只活在注册表那一份）——
       /capabilities 会照声明去问上游。密钥取「请求头 > 环境变量 > 设置页」三顺位，
       而探针实例继承跑判据这台机器的 `.env`：这里要是有一把真能用的钥匙，上游就会正常答话
       （source:'api'），这一格要判的「拿不到清单时怎么兜底」根本没被执行到。
       所以点名带一把必然被拒的钥匙 —— 上游 401 与连不上两条路都落到 registry 兜底，
       判的仍是兜底这一路，与这台机器配了哪些密钥无关。 */
    const cap = await call('/capabilities?provider=deepseek', { headers: { authorization: 'Bearer probe-invalid-key' } });
    if (cap.status !== 200) throw new Error('GET /capabilities 应 200，实际 ' + cap.status);
    const capJson = await cap.json();
    if (!capJson || capJson.provider !== 'deepseek' || capJson.endpoint !== '/models' || capJson.source !== 'registry') {
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
    /* 服务端不再报渲染队列与编码器（成片在浏览器里合成）：这一格只留代理自己知道的现况，
       渲染配置若又长回来，说明有人把已删的 ffmpeg 那一族接回去了。 */
    if (sysJ && sysJ.渲染) throw new Error('/sys-status 又报起了渲染配置（服务端已经没有 ffmpeg）：' + JSON.stringify(sysJ.渲染));
    if (!sysJ || !num(sysJ.at) || !sysJ.出站代理) throw new Error('/sys-status 少了时间戳或出站代理那一格');
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

    /* 「另存第二份 / 按号补存 / 数旧落点 / 搬旧落点」整族撤销：产物只有一份，就住在库根的类型子目录里，
       写完不再拷第二遍，也没有第二个落点要收编。四条都必须 404 ——
       留着任何一条，要么一次生成写两遍同样的字节，要么留下一条没人调用却能写盘、删盘的路由。 */
    for (const [p, m] of [['/save', 'POST'], ['/save-local', 'POST'], ['/save-stale', 'GET'], ['/save-move', 'POST']]) {
      const r = await call(p, {
        method: m, headers: { 'content-type': 'application/json' },
        body: m === 'POST' ? JSON.stringify({ type: 'image', kind: 'image', name: 'probe.png', from: '@default' }) : undefined,
      });
      if (r.status !== 404) throw new Error('另存那一族已撤，' + m + ' ' + p + ' 应 404，实际 ' + r.status);
    }
    const usage = await call('/assets-usage');
    if (usage.status !== 200) throw new Error('/assets-usage 应 200，实际 ' + usage.status);

    /* 服务端没有渲染队列：成片与素材都在浏览器里合成，这一族端点必须彻底不在。 */
    for (const [p, m] of [
      ['/render/status?id=nope', 'GET'],
      ['/render', 'POST'],
      ['/render/cancel?id=nope', 'POST'],
      ['/render/dl?name=nope.mp4', 'GET'],
      ['/render/jobs', 'GET'],
    ]) {
      const r = await call(p, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
      if (r.status !== 404) throw new Error('渲染端点已删，' + m + ' ' + p + ' 应 404，实际 ' + r.status);
    }

    /* v19 起 relay 一家一段：文字 AI 不再共用 /textai，DeepSeek 的段是 /textai/deepseek */
    const relayBad = await call('/textai/deepseek/chat/completions', { headers: { 'x-up-base': 'http://127.0.0.1:1/v1' } });
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

    console.log('✓ 代理边界通过（Cookie / 同源 / POST 闸 / 系统、云同步、能力、本机资产、渲染端点已撤销、relay、出站通道与清缓存路由）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (proxy) await proxy.stop();
    try { fs.rmSync(saveDir, { recursive: true, force: true }); } catch (e) {}
  }
})();
