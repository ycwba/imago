/* 本机资产库路由：/local-assets/from-url（流式落盘）/ POST（base64 落盘）/ GET（列表，按来源去重）。
   业务助手函数与目录由 app 注入；这里只做请求解析与响应。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { renameWithRetry, fsyncPath, atomicWrite } = require('../fs-atomic.js');
const { sendJson, fail } = require('./http');

function createLocalAssets(ctx) {
  const readBody = ctx.readBody;
  const log = ctx.log;
  const resolveSrc = ctx.resolveSrc;
  const downloadTo = ctx.downloadTo;
  const keyOf = ctx.keyOf;
  const assetStore = ctx.assetStore;
  const safeOutboundUrl = ctx.safeOutboundUrl;
  const safeDecode = ctx.safeDecode;
  const localUpKey = ctx.localUpKey;
  const extInUrl = ctx.extInUrl;
  const extOfMime = ctx.extOfMime;
  const withLocalSaveLock = ctx.withLocalSaveLock;
  const localIndexRead = ctx.localIndexRead;
  const localIndexUpsert = ctx.localIndexUpsert;
  const localIndexRemove = ctx.localIndexRemove;
  /* 队列写入口与「只动这一条」的规则：见 server/index-store.js 的 update / putInto。 */
  const localIndexUpdate = ctx.localIndexUpdate;
  const localIndexPut = ctx.localIndexPut;
  const localFillMissing = ctx.localFillMissing;
  const whyNoSpace = ctx.whyNoSpace;
  const localAssetFile = ctx.localAssetFile;
  const localMediaType = ctx.localMediaType;
  const localAssetWhen = ctx.localAssetWhen;
  const LOCAL_DIR = ctx.LOCAL_DIR;
  const MIME = ctx.MIME;

  /* 本文件的错误体是 `{error:{message}}`（设置页与 domain/local.js 读的是 error.message），
     与公共 fail 的扁平 `{error}` 不同：这里只做形状适配，头字段仍交给 ./http。 */
  const failMsg = (res, code, msg) => sendJson(res, code, { error: { message: msg } });

  function handleLocalAssets(req, res, urlObj) {
    const dataPath = (urlObj && urlObj.pathname) || req.url.split('?')[0];
    if (dataPath === '/local-assets/from-url' && req.method === 'POST') {
      readBody(req, res, 1024 * 1024).then(async raw => {
        if (raw == null) return;
        let spec = null;
        try { spec = JSON.parse(raw.toString('utf8')); } catch {}
        if (!spec || !spec.url) return failMsg(res, 400, '缺少 url');
        const meta = (spec.meta && typeof spec.meta === 'object') ? spec.meta : {};
        let target = '';
        try { target = await resolveSrc(String(spec.url), assetStore ? keyOf(assetStore.keyEnv) : ''); }
        catch (e) { return failMsg(res, 400, e.message); }
        const localPath = /^http:\/\/127\.0\.0\.1:\d+\/asset\/([A-Za-z0-9_-]+)$/.exec(target);
        const localId = localPath ? localPath[1] : '';
        const up = safeOutboundUrl(String(meta.upstream || '')) || (/^https:\/\//i.test(target) ? target : '');
        const upKey = localUpKey(up);
        const fmt = String(spec.format || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
          || extInUrl(target) || extInUrl(spec.name) || extOfMime(spec.mime) || 'mp4';
        const mime = spec.mime || MIME['.' + fmt] || 'application/octet-stream';
        const lockKey = upKey ? 'up:' + upKey : (localId ? 'la:' + localId : 'url:' + target);
        try {
          const out = await withLocalSaveLock(lockKey, async () => {
            const list0 = localIndexRead();
            const twin = upKey ? list0.find(x => x && localUpKey(x.upstream) === upKey) : (localId ? list0.find(x => x && x.id === localId) : null);
            if (twin) {
              const filled = localFillMissing(twin, { prompt: meta.prompt || '', model: meta.model || '',
                voice: meta.voice || '', priceText: meta.priceText || '', duration: meta.duration ?? null,
                credits: meta.credits ?? null, chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
                usage: meta.usage || null, detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null });
              if (filled) localIndexUpsert(twin);              // 只改这一条，别拿整表覆盖别人的新条目
              return { ...twin, status: 'succeeded', url: '/asset/' + twin.id, reused: true };
            }
            const whySpace = whyNoSpace(LOCAL_DIR, 0, '把这一份产物存进本机资产库');
            if (whySpace) throw new Error(whySpace);
            fs.mkdirSync(LOCAL_DIR, { recursive: true });
            const id = 'la_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const file = id + '.' + fmt;
            const dest = path.join(LOCAL_DIR, file);
            const tmp = dest + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
            let size = 0;
            try {
              if (localId) {
                const src = localAssetFile(localId);
                if (!src) throw new Error('本机资产 ' + localId + ' 的文件已经不在了');
                fs.copyFileSync(src, tmp);
                size = fs.statSync(tmp).size;
              } else {
                size = await downloadTo(target, tmp);
              }
              const why2 = whyNoSpace(LOCAL_DIR, size, '把这一份产物存进本机资产库');
              if (why2) throw new Error(why2);
              renameWithRetry(tmp, dest);
              fsyncPath(dest);           // 退避重试也带上 fsync：与 .data 里的写盘纪律同一份
            } catch (e) {
              try { fs.unlinkSync(tmp); } catch {}
              throw e;
            }
            const item = {
              id, file, name: spec.name || file, mime,
              format: fmt, byte_length: size, created_at: new Date().toISOString(),
              media_type: localMediaType({ format: fmt, mime, media_type: spec.media_type }),
              prompt: meta.prompt || '', model: meta.model || '', voice: meta.voice || '',
              provider: meta.provider || 'local', duration: meta.duration ?? null,
              credits: meta.credits ?? null, priceText: meta.priceText || '',
              chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
              usage: meta.usage || null, upstream: up,
              detail: (meta.detail && typeof meta.detail === 'object') ? Object.assign({}, meta.detail, { bytes: size }) : null,
            };
            /* 这一条走队列，不走同步的 upsert：从上面那次 `localIndexRead()` 到这里隔着一次
               真下载（`await downloadTo`），期间别的请求完全可能写了索引。fn 里拿到的
               永远是**队首时刻**的当前表，`localIndexPut` 只动这一条。 */
            await localIndexUpdate(list => localIndexPut(list, item));
            log('[local-assets] 新增 ' + id + '（' + fmt + '，' + (size / 1024).toFixed(0) + ' KB，from-url）');
            return { ...item, status: 'succeeded', url: '/asset/' + id };
          });
          sendJson(res, 200, out);
        } catch (e) {
          log('[local-assets/from-url] 保存失败：' + e.message);
          const msg = e && e.indexWrite
            ? ('字节已经写进本机资产库（.assets）了，但索引没写成：' + e.message + '。腾出磁盘空间后再试')
            : e.message;
          failMsg(res, 500, msg);
        }
      });
      return;
    }
    if (dataPath === '/local-assets' && req.method === 'POST') {
      // 保存一份本地生成产物（语音 / 自动镜像的图像视频），返回可供资产库引用的 id / url
      /* 288 MiB：客户端递的是 base64（比原文件大 4/3），一段 100MB 的视频 base64 就有 133MB。
         128 MiB 那道闸是给「同步合成的音频」设的，开了产物镜像之后视频必然撞墙
         （撞墙的表现是代理回 413，而页面只显示「保存失败」，看不出是体积上限）。 */
      readBody(req, res, 288 * 1024 * 1024).then(raw => {      // base64 媒体较大，给足
        if (raw == null) return;
        let spec = null;
        try { spec = JSON.parse(raw.toString('utf8')); } catch {}
        if (!spec || !spec.data) return fail(res, 400, '缺少 data(base64)');
        try {
          const buf = Buffer.from(String(spec.data), 'base64');
          const fmt = String(spec.format || 'wav').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'wav';
          const mime = spec.mime || (MIME['.' + fmt] || 'application/octet-stream');
          const meta = spec.meta || {};
          // WAV 头里能直接算出时长（字节率），不用客户端再解析
          let duration = meta.duration || null;
          if (fmt === 'wav' && buf.length > 44 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WAVE') {
            try {
              const byteRate = buf.readUInt32LE(28);
              const dataSize = buf.readUInt32LE(40);
              if (byteRate > 0 && dataSize > 0) duration = Math.round((dataSize / byteRate) * 10) / 10;
            } catch {}
          }
          /* 来源外链先算出来：它是「这份产物本机有没有存过」的凭据（见 localUpKey）。 */
          const up = safeOutboundUrl(String(meta.upstream || '')) || '';
          const upKey = localUpKey(up);
          const list0 = upKey ? localIndexRead() : [];
          const twin = upKey ? list0.find(x => x && localUpKey(x.upstream) === upKey) : null;
          if (twin) {
            /* 已经有一份了：**不再落第二个文件**。客户端那份镜像键丢了（换端口 / 清浏览器数据 /
               平台这次没给产物号）不代表盘上没有 —— 这里挡住才是唯一跨源有效的一道闸。
               顺手复用它的 id：别的页面、收藏、导演台工作区里存过的 `/asset/<那个 id>` 照样能播。 */
            const fp = path.join(LOCAL_DIR, path.basename(String(twin.file || '')));
            let size = -1;
            try { size = fs.statSync(fp).size; } catch {}
            if (size !== buf.length) {
              fs.mkdirSync(LOCAL_DIR, { recursive: true });
              /* 补回来也是一次真写入 —— 盘满了这一句要说得出差多少（抛出走外面那道 catch，
                 它已经把「字节 vs 索引」两种失败分开说了，这里只补第三种）。 */
              const whySpace = whyNoSpace(LOCAL_DIR, buf.length, '把本机副本补回来');
              if (whySpace) throw new Error(whySpace);
              atomicWrite(fp, buf);                          // 文件被删过 / 字节数不符：按原 id 补回来
              twin.byte_length = buf.length;
              if (twin.format !== fmt) { twin.format = fmt; twin.mime = mime; twin.file = path.basename(fp); }
            }
            const filled = localFillMissing(twin, { prompt: meta.prompt || '', model: meta.model || '',
              voice: meta.voice || '', priceText: meta.priceText || '', duration, credits: meta.credits ?? null,
              chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
              usage: meta.usage || null, detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null });
            if (filled) localIndexUpsert(twin);              // 一个字段都没补上就不动盘（只改这一条）
            log(`[local-assets] 已有本机副本 ${twin.id}（同一份产物，第 ${list0.filter(x => localUpKey(x && x.upstream) === upKey).length} 次镜像被挡下）`);
            sendJson(res, 200, { ...twin, status: 'succeeded', url: '/asset/' + twin.id, reused: true });
            return;
          }
          const id = 'la_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const file = id + '.' + fmt;
          fs.mkdirSync(LOCAL_DIR, { recursive: true });
          /* 落字节之前先问一次余量：这条路由是「产物自动镜像本机」的唯一出口，
             盘满时以前是 ENOSPC 抛出来再被外面那道 catch 转成一句 500，
             而那句只说「no space left on device」，用户不知道该清哪一块。 */
          const whySpace = whyNoSpace(LOCAL_DIR, buf.length, '把这一份产物存进本机资产库');
          if (whySpace) throw new Error(whySpace);
          atomicWrite(path.join(LOCAL_DIR, file), buf);
          /* ^ 与 .data 同一份写盘纪律：落完 fsync 再 rename。
             直接 writeFileSync 时，掉电/崩溃会留下「索引里有一条、盘上是半个文件」的资产，
             离线看得到缩略图却播不出来，而这条路由是产物镜像本机唯一的出口。 */
          const item = {
            id, file, name: spec.name || file, mime,
            format: fmt, byte_length: buf.length, created_at: new Date().toISOString(),
            media_type: localMediaType(spec),
            prompt: meta.prompt || '', model: meta.model || '', voice: meta.voice || '',
            provider: meta.provider || 'local', duration,
            credits: meta.credits ?? null, priceText: meta.priceText || '',
            chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
            usage: meta.usage || null,
            /* 镜像回源用：这份文件是从哪个外链取回来的字节。
               /asset/<id> 在**本地文件被删掉**时靠它回源（见 /asset 那段），这是三级回退的中间一级 ——
               以前本地文件一没就只剩 404，界面上直接判成「已删除」，其实上游那份可能还能取。 */
            upstream: up,
            /* 任务详情原样带走：提示词、参数、费用、耗时、状态变迁。
               平台那边的记录会随时间被清理，索引里这一份是「任务当时是什么样」的本地留底。 */
            detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null,
          };
          localIndexUpsert(item);
          log(`[local-assets] 新增 ${id}（${item.format}，${(buf.length / 1024).toFixed(0)} KB）`);
          sendJson(res, 200, { ...item, status: 'succeeded', url: '/asset/' + id });
        } catch (e) {
          log('[local-assets] 保存失败：' + e.message);
          /* 索引写不成时把话说到位（L50）：字节确实已经写进 .assets 了，缺的只是索引那一行。
             不这么说的话，调用方看到 500 会当「整件事都没成」而丢掉已经存好的那份，
             或者反过来（以前）看到 200 而当「成了」—— 两种说法都和盘上的实情对不上。 */
          const msg = e && e.indexWrite
            ? ('字节已经写进本机资产库（.assets）了，但索引没写成：' + e.message
              + '。库里面现在看不到它。腾出磁盘空间后再保存一次；'
              + '索引缺失的那一条会在下次读取时按文件名自动补回来。')
            : e.message;
          failMsg(res, 500, msg);
        }
      });
      return;
    }
    if (req.url.startsWith('/local-assets/') && req.method === 'DELETE') {
      // 删除本地生成资产（上游没有资产存储、文件只在本机的，比如语音合成产物）
      const id = safeDecode(req.url.slice('/local-assets/'.length).split('?')[0]);
      const hit = localIndexRead().find(x => x && x.id === id);
      if (!hit) return failMsg(res, 404, '本地资产不存在：' + id);
      /* **文件删不掉就不许裁索引**（L49）。为什么这条最要紧：索引是这些文件唯一的查找途径 ——
         条目一没，那个 mp4 在资产库里看不见、/asset/<id> 也 404，而它明明还躺在 .assets 里，
         只是再也没人能按名字找回来（文件名是 la_xxx.mp4，人认不出来）。
         什么情况下删不掉：文件正被播放器 / 预览器打开、被同步盘（OneDrive 之类）占着、
         被杀毒软件扫着 —— 都是常见情形，不是罕见边角。
         立场与 /data 的 DELETE 完全一样（那边注释写得很清楚：删不掉必须回错误，
         否则用户看到「删了又回来」）—— 这条路由当时是同一件事的第二份实现，这边漏了。 */
      if (hit.file) {
        const f = path.join(LOCAL_DIR, path.basename(hit.file));
        if (fs.existsSync(f)) {
          try { fs.unlinkSync(f); }
          catch (e) {
            log('[local-assets] 删除文件失败，索引没有动：' + e.message);
            failMsg(res, 500, '文件删不掉（' + (e.code || e.message)
              + '）：它可能正被播放器 / 同步盘 / 杀毒软件占着。这一条原样留着（资产库里还在，还能打开）——'
              + '关掉占着它的程序再删一次。');
            return;
          }
        }
      }
      try { localIndexRemove(id); }
      catch (e) {
        /* 文件已经删掉了，但索引没写回去：这一条会「复活」成一条指向不存在文件的记录，
           下次打开会显示成「已丢失」。如实说，别回「已删除」——那会让用户以为干净了。 */
        log('[local-assets] 文件已删、索引未更新：' + e.message);
        failMsg(res, 500, '文件已经删掉了，但索引没能更新（' + e.message
          + '）：下次打开这一条会显示成「已丢失」。再删一次它就能从列表里清掉。');
        return;
      }
      log(`[local-assets] 已删除 ${id}`);
      sendJson(res, 200, { ok: true, id });
      return;
    }
    if (dataPath === '/local-assets' && req.method === 'GET') {
      // 列表：形状与上游列表一致（data + next_cursor），资产库用 registry 的 list 声明直接读
      // 大类型每次现算 —— 老索引里写死过 'audio'，按扩展名重算才能把那张 PNG 认回图片
      // 时间也每次现算：索引里那份 created_at 是**落盘**时刻，一次回源能把几百条老产物写成「今天」，
      // 按它排序就把资产库里唯一的图片挤出选择器「全部」那一档的前 200 条（见 localAssetWhen）。
      /* 同一个产物的多份副本只报一份（保留索引里最靠前的那一条 = 最新的一次镜像）。
         这些重复是**镜像键丢了**那段历史留下的（POST 那一道闸已经把它挡住，不再新增），
         文件仍在盘上，只是不再当成 N 个任务摆在界面上。`duplicates` 报出还压着多少份，
         要清理由用户自己决定 —— 删文件是删用户数据，代理不擅自动手。 */
      const all = localIndexRead().map(x => ({ ...x, created_at: localAssetWhen(x), media_type: localMediaType(x), status: 'succeeded', object: 'asset' }));
      const items = [];
      const seen = new Set();
      let dups = 0;
      for (const x of all) {                               // 顺序就是索引顺序（新→旧）
        const k = localUpKey(x.upstream);
        if (k) { if (seen.has(k)) { dups++; continue; } seen.add(k); }
        items.push(x);
      }
      sendJson(res, 200, { object: 'list', data: items, has_more: false, next_cursor: null, duplicates: dups });
      return;
    }
    return false;
  }

  /* 把盘上已有的一份文件登记进本机资产库（「最近导出」里的成品「存到资产库」用）。
     不重新下载、不 base64、不改渲染目录 —— 只复制字节 + 追加一条与 POST 同形状的索引。
     同一份成品按 detail.renderFile 认（渲染路由把成品文件名作为 marker 传进来）：
     第二次点「存到资产库」复用那一条，不落第二个文件。 */
  function saveLocalCopy(srcFile, opts) {
    const o = opts || {};
    const src = String(srcFile || '');
    if (!src || !fs.existsSync(src)) throw new Error('要保存的文件已经不在了：' + (o.marker || path.basename(src)));
    const st = fs.statSync(src);
    if (!st.isFile()) throw new Error('要保存的不是一个文件：' + path.basename(src));
    const fmt = (path.extname(src).slice(1) || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    const mime = MIME['.' + fmt] || 'application/octet-stream';
    const marker = String(o.marker || '').trim();
    const title = String(o.title || o.name || marker || path.basename(src)).slice(0, 200);
    if (marker) {
      const twin = localIndexRead().find(x => x && x.detail && typeof x.detail === 'object' && x.detail.renderFile === marker);
      if (twin) {
        const fp = path.join(LOCAL_DIR, path.basename(String(twin.file || '')));
        let size = -1;
        try { size = fs.statSync(fp).size; } catch {}
        if (size !== st.size) {
          /* 盘上那一份被删过 / 被换过：用源文件补回来，**不新开一条**（否则资产库里出现两张一样的卡）。 */
          const why = whyNoSpace(LOCAL_DIR, st.size, '把这一份成品补回本机资产库');
          if (why) throw new Error(why);
          fs.mkdirSync(LOCAL_DIR, { recursive: true });
          fs.copyFileSync(src, fp);
          twin.byte_length = st.size;
          try { localIndexUpsert(twin); } catch (e) {
            log('[local-assets] 补回成品后索引没写成（文件已在盘上）：' + e.message);
          }
        }
        log(`[local-assets] 成品已在资产库：${twin.id}（${marker}）`);
        return { ...twin, status: 'succeeded', url: '/asset/' + twin.id, reused: true };
      }
    }
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    const why = whyNoSpace(LOCAL_DIR, st.size, '把这一份成品存进本机资产库');
    if (why) throw new Error(why);
    const id = 'la_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const file = id + '.' + fmt;
    fs.copyFileSync(src, path.join(LOCAL_DIR, file));
    const item = {
      id, file, name: title, mime, format: fmt, byte_length: st.size,
      created_at: new Date().toISOString(), media_type: localMediaType({ format: fmt, mime }),
      prompt: '', model: '', voice: '', provider: 'local',
      duration: null, credits: null, priceText: '', chars: null, usage: null,
      upstream: '',
      /* renderFile 是去重凭据；created 让资产库按「导出那一刻」排序，而不是复制这一刻。 */
      detail: marker ? { renderFile: marker, created: new Date(st.mtimeMs).toISOString() } : null,
    };
    localIndexUpsert(item);
    log(`[local-assets] 渲染成品入库 ${id}（${fmt}，${(st.size / 1048576).toFixed(1)} MB）`);
    return { ...item, status: 'succeeded', url: '/asset/' + id };
  }

  return { handleLocalAssets, saveLocalCopy };
}

module.exports = { createLocalAssets };
