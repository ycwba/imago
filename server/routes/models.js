/* /models/* —— 浏览器内 ASR 模型的代理代下载（唯一入口）。
   transformers.js 的每一次模型文件取数都打到同源的 /models/<id>/<file>：
   - 本机 .data/models/ 里已有 → 直接流回去（缓存只有这一份，浏览器侧 HTTP 缓存 no-store 不落第二份）；
   - 没有 → 代理出站去镜像拉（ModelScope + HuggingFace 双镜像按序试；第一次成功的源在本进程内粘住，
     失败立即换另一个；镜像的 30x 重定向自己接住接着跳 —— HF 的 resolve 会 302 到 CDN，最多 4 跳），
     边拉边写 <file>.part，收完整再原子改名 —— 中途断开不留下半个真文件。
   同一个文件只发起一次下载：并发的取数都挂在同一条在途下载上；客户端全部断开就掐掉上游并删 .part
   （没有断点续传，下次照实重来）。
   进 LOCAL_ONLY（同源 + wb_session 双闸）；出站目标只有下面写死的两个镜像域名，
   一律先过 guardOutboundUrl（含 DNS 核对），不吃任何请求参数里的 URL。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('./http');

const MIRRORS = [
  { name: 'modelscope', urlOf: (id, file) => 'https://modelscope.cn/models/' + id + '/resolve/master/' + file },
  { name: 'huggingface', urlOf: (id, file) => 'https://huggingface.co/' + id + '/resolve/main/' + file },
];
const MAX_DL_BYTES = 700 * 1024 * 1024;   // 单文件上限（whisper-small q8 的 decoder 约 300MB 级）
const DL_TIMEOUT_MS = 10 * 60 * 1000;

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
/* 模型路径只认「org/name/file/…」这种安全段：每段字母数字与 . _ -，不许 .. 、不许绝对路径。 */
function parseRel(raw) {
  const rel = clean(decodeURIComponent(String(raw || '')), 400);
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length || segs.length > 8) return null;
  for (const s of segs) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(s) || s === '.' || s === '..') return null;
  }
  return { rel: segs.join('/'), id: segs.slice(0, 2).join('/'), file: segs.slice(2).join('/') };
}

function createModelsRoutes(ctx) {
  const log = ctx.log || (() => {});
  const dirOf = () => path.join(ctx.dataDirPath(), 'models');
  const localOf = rel => path.join(dirOf(), rel.replace(/\//g, path.sep));
  let sticky = -1;                         // 会话粘住：第一次成功的镜像下标；失败立即清掉
  const inflight = new Map();              // rel → 下载会话（同一条文件只发起一次）

  /* 本次按哪个顺序试：点名 > 会话粘住 > 默认序（中文工作台默认 ModelScope 在前）。 */
  function orderFor(asked) {
    if (asked === 'huggingface' || asked === 'modelscope') {
      return [MIRRORS.find(m => m.name === asked), ...MIRRORS.filter(m => m.name !== asked)];
    }
    if (sticky >= 0 && MIRRORS[sticky]) return [MIRRORS[sticky], ...MIRRORS.filter((_, i) => i !== sticky)];
    return MIRRORS;
  }
  function cleanupPart(key) {
    try { fs.unlinkSync(localOf(key) + '.part'); } catch (e) { /* 本来就没有 */ }
  }

  /* 一条在途下载：上游 → .part（边写边推给所有挂着的学生）；收完改名、按成功与否收尾。
     mirror 顺序在入口（handleModels）读好传进来，会话本身不认请求参数。 */
  function startDownload(key, parsed, mirror) {
    const clients = new Set();
    const session = { done: false, aborted: false, res: null };
    let settled = false;
    const promise = new Promise(resolve => {
      const finishOk = bytes => {
        if (settled || session.aborted) return;
        settled = true; session.done = true;
        for (const cl of clients) { try { cl.end(); } catch (e) { /* 客户端先断就算了 */ } }
        clients.clear();
        resolve({ ok: true, bytes });
      };
      const fail = why => {
        if (settled || session.aborted) return;
        settled = true;
        cleanupPart(key);
        /* 已经发过头的客户端只能断流收场；没发过头的不动 —— downloadAndServe 会给它们补一句干净的 502。 */
        for (const cl of clients) { try { if (cl.headersSent) cl.destroy(new Error(why)); } catch (e) { /* 已经断了 */ } }
        clients.clear();
        resolve({ ok: false, why });
      };
      const attempt = async list => {
        if (session.aborted) { settled = true; return resolve({ ok: false, why: '已取消' }); }
        const m = list[0];
        if (!m) return resolve({ ok: false, why: '两个镜像都取不到：' + key + '（网络不通，或这份模型没镜到那里）' });
        openHop(m, m.urlOf(parsed.id, parsed.file), list, 0);
      };
      /* 一跳取数：镜像地址与每一跳重定向都先过出站护栏。huggingface 的 resolve 会 302 到 CDN
         （anyRequest 不自动跟），所以 30x 要自己接住接着跳；最多 4 跳，防被恶意重定向挂住。 */
      const openHop = async (m, url, list, hops) => {
        try { await ctx.guardOutboundUrl(url); }
        catch (e) { sticky = -1; return attempt(list.slice(1)); }
        if (session.aborted) { settled = true; return resolve({ ok: false, why: '已取消' }); }
        log(hops ? '[models] 跟随重定向（第 ' + (hops + 1) + ' 跳）' : '[models] 从 ' + m.name + ' 拉 ' + key);
        let req;
        try {
          req = ctx.anyRequest(url, { method: 'GET' }, res => {
            const st = res.statusCode;
            if ([301, 302, 307, 308].includes(st) && res.headers.location && hops < 4) {
              res.resume();
              let next = '';
              try { next = new URL(res.headers.location, url).toString(); } catch (e) {}
              if (next) { openHop(m, next, list, hops + 1); return; }
              attempt(list.slice(1));
              return;
            }
            if (st !== 200) { res.resume(); attempt(list.slice(1)); return; }
            const total = Number(res.headers['content-length']) || 0;
            if (total > MAX_DL_BYTES) { res.resume(); attempt(list.slice(1)); return; }
            /* 挂在这次下载上的学生从这里开始收字节：头先发（无 Content-Length，走 chunked） */
            for (const cl of Array.from(clients)) {
              try { cl.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); }
              catch (e) { clients.delete(cl); }
            }
            const part = localOf(key) + '.part';
            try { fs.mkdirSync(path.dirname(part), { recursive: true }); } catch (e) { return fail('建模型目录失败：' + ((e && e.message) || e)); }
            const out = fs.createWriteStream(part);
            let got = 0;
            res.on('data', c => {
              got += c.length;
              if (got > MAX_DL_BYTES) { try { req.destroy(new Error('超出大小上限')); } catch (e) {} return; }
              for (const cl of Array.from(clients)) { try { cl.write(c); } catch (e) { clients.delete(cl); } }
            });
            res.on('error', () => { sticky = -1; fail('镜像连接中断'); });
            out.on('error', () => fail('写盘失败（磁盘满或被占用）'));
            out.on('finish', () => {
              if (session.aborted) return;
              try { fs.renameSync(part, localOf(key)); }
              catch (e) { return fail('落盘改名失败：' + clean((e && e.message) || e, 300)); }
              sticky = MIRRORS.indexOf(m);
              finishOk(got);
            });
            res.pipe(out);
          });
          req.setTimeout(DL_TIMEOUT_MS, () => { try { req.destroy(new Error('镜像下载超时')); } catch (e) {} });
          req.on('error', e => { sticky = -1; attempt(list.slice(1)); });
          req.end();                                  // 不 end 就一个字节都不发（假件判据专治这一类）
          session.res = req;
        } catch (e) { resolve({ ok: false, why: '镜像请求起不动：' + clean((e && e.message) || e, 300) }); }
      };
      attempt(orderFor(mirror));
    });
    const handle = { promise, clients, session };
    promise.finally(() => { if (inflight.get(key) === handle) inflight.delete(key); });
    return handle;
  }

  async function downloadAndServe(req, res, parsed, mirror) {
    const key = parsed.rel;
    let h = inflight.get(key);
    if (!h) {
      h = startDownload(key, parsed, mirror);
      inflight.set(key, h);
      h.clients.add(res);
      const drop = () => {
        h.clients.delete(res);
        /* 全部客户端都断开：掐上游、删 .part —— 下次重新拉。 */
        if (!h.session.done && !h.session.aborted && h.clients.size === 0) {
          h.session.aborted = true;
          try { if (h.session.res) h.session.res.destroy(new Error('客户端全部断开')); } catch (e) {}
          cleanupPart(key);
        }
      };
      req.on('aborted', drop);
      res.on('close', drop);
      const r = await h.promise;
      if (r.ok) return true;
      if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: clean(r.why, 500) });
      return false;
    }
    /* 后来者：挂到同一条在途下载上等收尾；收完从盘上再走一遍（不走完不发头）。 */
    res.on('close', () => { h.clients.delete(res); });
    const r = await h.promise;
    if (r.ok) return serveLocal(res, key);
    if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: clean(r.why, 500) });
    return false;
  }

  function serveLocal(res, key) {
    const file = localOf(key);
    let st;
    try { st = fs.statSync(file); } catch (e) { return false; }
    if (!st.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    const out = fs.createReadStream(file);
    out.on('error', () => { try { res.destroy(); } catch (e) { /* 已经断了 */ } });
    out.pipe(res);
    return true;
  }

  /* GET /models/status?id=<id>：模型目录里已完整落盘的文件与大小（.part 不算）。 */
  function status(id) {
    const root = path.join(dirOf(), id.replace(/\//g, path.sep));
    const files = [];
    let bytes = 0;
    const walk = d => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        let st = null;
        try { st = fs.statSync(p); } catch (e) { continue; }
        if (st.isDirectory()) walk(p);
        else if (!name.endsWith('.part')) {
          files.push({ file: path.relative(root, p).replace(/\\/g, '/'), bytes: st.size });
          bytes += st.size;
        }
      }
    };
    try { walk(root); } catch (e) { /* 目录还没有 → 空清单 */ }
    return { id, files, bytes, present: files.length > 0 };
  }

  async function handleModels(req, res) {
    const url = new URL(req.url, 'http://local');
    const rest = url.pathname.replace(/^\/models\/?/, '');
    try {
      if (rest === 'status' && req.method === 'GET') {
        const id = clean(url.searchParams.get('id'), 260);
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(id)) {
          sendJson(res, 400, { error: '模型 id 形如 org/name（字母数字与 . _ -）' });
          return true;
        }
        sendJson(res, 200, status(id));
        return true;
      }
      if (req.method !== 'GET') { sendJson(res, 405, { error: '只支持 GET' }); return true; }
      const parsed = parseRel(rest);
      if (!parsed || !parsed.file) { sendJson(res, 400, { error: '模型路径不合法（只认 org/name/file 形式的安全段）' }); return true; }
      if (serveLocal(res, parsed.rel)) return true;
      /* mirror 只在这里读一次，下载会话本身不认请求参数 */
      await downloadAndServe(req, res, parsed, clean(url.searchParams.get('mirror'), 20));
      return true;
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: clean((e && e.message) || e, 500) });
      return true;
    }
  }

  return { handleModels, status, orderFor };
}

module.exports = { createModelsRoutes, parseRel };
