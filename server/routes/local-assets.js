/* 本机资产库路由：/local-assets/from-url（流式落盘）/ POST（base64 落盘）/ GET（列表，一份产物一条）/ DELETE。
   业务助手函数与目录口径由 app 注入（都在 server/local-assets-store.js）；这里只做请求解析与响应。
   落点只有一个：库根的类型子目录（下载\拾帧\图片\ 那一层），文件名是资产库里看到的那个规范名。
   两个写入口都有类别闸：只收图片 / 视频 / 音频（isMediaExt，判据就是存储层那张类别表）——
   字幕 / 文本进不了账，也就不会在页面上显示成一条「认不出类型」的假音频。
   以前「存进资产库」之外还要再另存一份到别的文件夹，于是 359 份产物里有 344 份字节完全相同的副本
   —— 本体本来就落在用户翻得到的地方，第二份只是占地方。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renameWithRetry, fsyncPath, atomicWrite } = require('../fs-atomic.js');
const { sendJson, fail } = require('./http');
/* 类别闸直接连存储层的那张表（LOCAL_KIND_BY_EXT → isMediaExt）：落点、对账、用量与这道闸
   必须读同一份名单；它是纯函数、不碰实例状态，所以走模块导出，不经组合根的注入清单转发。 */
const { isMediaExt, isDocExt, identityOf } = require('../local-assets-store.js');

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
  /* 队列写入口与「怎么动这一条」的规则：见 server/index-store.js 的 update / putInto / dropFrom。 */
  const localIndexUpdate = ctx.localIndexUpdate;
  const localIndexPut = ctx.localIndexPut;
  const localIndexDrop = ctx.localIndexDrop;
  const localAssetSiblings = ctx.localAssetSiblings;
  const localFillMissing = ctx.localFillMissing;
  const localAliases = ctx.localAliases;
  const localLocateBatch = ctx.localLocateBatch;
  const whyNoSpace = ctx.whyNoSpace;
  const localAssetFile = ctx.localAssetFile;
  const localAssetPaths = ctx.localAssetPaths;
  const localMediaType = ctx.localMediaType;
  const localAssetWhen = ctx.localAssetWhen;
  const localFileFromEntry = ctx.localFileFromEntry;
  const localSigOf = ctx.localSigOf;
  /* fid 只由存储层算（那一份算法与磁盘对账共用，见 server/local-assets-store.js 的 fileFidOf）。 */
  const fileFidOf = ctx.fileFidOf;
  const newBodyPlace = ctx.newBodyPlace;
  const bodyDirOf = ctx.bodyDirOf;
  const bodyDirNameOf = ctx.bodyDirNameOf;
  const mintAssetId = ctx.mintAssetId;
  const localAdopt = ctx.localAdopt;
  const invalidateScan = ctx.invalidateScan;
  const localRootDir = ctx.localRootDir;
  const MIME = ctx.MIME;

  /* 本文件的错误体是 `{error:{message}}`（设置页与 domain/local.js 读的是 error.message），
     与公共 fail 的扁平 `{error}` 不同：这里只做形状适配，头字段仍交给 ./http。 */
  const failMsg = (res, code, msg) => sendJson(res, code, { error: { message: msg } });

  /* 内容指纹兜底：只在「算不出 upstream 去重键」时懒算一次（有键的走键判重，零额外开销）。
     全量 sha256 不截断：找同内容要精确相等；索引里懒写（有 upstream 的不写这个字段）。 */
  const sha256Of = buf => { try { return crypto.createHash('sha256').update(buf).digest('hex'); } catch { return ''; } };

  /* 一条账缺的字段用新到的那份补上、然后落账 —— 三条复用分支同一句，别各写一遍。 */
  const fillAndSave = (twin, patch) => { if (localFillMissing(twin, patch)) localIndexUpsert(twin); };
  /* 平台身份从声明里提出来写到账的最上层：`assetId` / `taskId` 是寻址字段，
     `detail` 里那份是任务详情的留底。老客户端只递 detail 时同样认得出。 */
  const identOfMeta = meta => identityOf({
    assetId: meta && meta.assetId, taskId: meta && meta.taskId,
    detail: meta && meta.detail,
  });

  function handleLocalAssets(req, res, urlObj) {
    const dataPath = (urlObj && urlObj.pathname) || req.url.split('?')[0];
    if (dataPath === '/local-assets/from-url' && req.method === 'POST') {
      readBody(req, res, 1024 * 1024).then(async raw => {
        if (raw == null) return;
        let spec = null;
        try { spec = JSON.parse(raw.toString('utf8')); } catch {}
        if (!spec || !spec.url) return failMsg(res, 400, '缺少 url');
        const meta = (spec.meta && typeof spec.meta === 'object') ? spec.meta : {};
        const ident = identOfMeta(meta);
        let target = '';
        try { target = await resolveSrc(String(spec.url), assetStore ? keyOf(assetStore.keyEnv) : ''); }
        catch (e) { return failMsg(res, 400, e.message); }
        const localPath = /^http:\/\/127\.0\.0\.1:\d+\/asset\/([A-Za-z0-9_-]+)$/.exec(target);
        const localId = localPath ? localPath[1] : '';
        const up = safeOutboundUrl(String(meta.upstream || '')) || (/^https:\/\//i.test(target) ? target : '');
        const upKey = localUpKey(up);
        /* 地址上的扩展名是字节的真相，优先于客户端声明：
           · 认得出且是文档类（字幕 / 文本）→ 整个拒收 —— 客户端猜不出格式会声明成 mp4，
             这一枚声明不能把媒体闸绕开（字幕 / 文本的去处是下载目录与提示词归档）；
           · 认得出且是媒体 → 压过声明（声明错了至少落点与类型是对的）；
           · 认不出（.bin 等）→ 不猜，仍按声明走，免得误伤真实的媒体下载。 */
        const urlExt = extInUrl(target) || extInUrl(spec.name);
        if (urlExt && isDocExt(urlExt)) return failMsg(res, 400,
          '本机资产库只收图片 / 视频 / 音频；这一份的地址是 .' + urlExt + '（字幕 / 文本请放下载或提示词目录）');
        const fmt = (urlExt && isMediaExt(urlExt) ? urlExt : '')
          || String(spec.format || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
          || urlExt || extOfMime(spec.mime) || 'mp4';
        /* 类别闸：算出扩展名就先验，一个字节都不落 —— 字幕 / 文本没有类型档位，
           存进来只会落进 其他\，再被列表「认不出兜底成音频」画成一条假音频
           （见 server/local-assets-store.js 的 isMediaExt）。 */
        if (!isMediaExt(fmt)) return failMsg(res, 400,
          '本机资产库只收图片 / 视频 / 音频；字幕 / 文本请放下载或提示词目录（这一份认出的格式是 ' + fmt + '）');
        const mime = spec.mime || MIME['.' + fmt] || 'application/octet-stream';
        const lockKey = upKey ? 'up:' + upKey : (localId ? 'la:' + localId : 'url:' + target);
        try {
          const out = await withLocalSaveLock(lockKey, async () => {
            const list0 = localIndexRead();
            const twin = upKey ? list0.find(x => x && localUpKey(x.upstream) === upKey) : (localId ? list0.find(x => x && x.id === localId) : null);
            if (twin) {
              fillAndSave(twin, { prompt: meta.prompt || '', model: meta.model || '',
                voice: meta.voice || '', priceText: meta.priceText || '', duration: meta.duration ?? null,
                credits: meta.credits ?? null, chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
                usage: meta.usage || null, assetId: ident.assetId, taskId: ident.taskId,
                detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null });
              return { ...twin, status: 'succeeded', url: '/asset/' + twin.id, reused: true };
            }
            /* 落点先算目录（类型只由扩展名与 mime 决定，这时候两个都已知），字节先落在**同一个目录**里：
               跨卷 rename 不是改名而是复制，半路失败就在两个卷各留一份。文件名等下载完再定（要按名字防撞）。 */
            const dir = bodyDirOf(bodyDirNameOf({ format: fmt, mime }));
            const whySpace = whyNoSpace(dir, 0, '把这一份产物存进本机资产库');
            if (whySpace) throw new Error(whySpace);
            fs.mkdirSync(dir, { recursive: true });
            const id = mintAssetId();
            const tmp = path.join(dir, id + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
            let size = 0;
            let itemSha = '';
            let place = null;
            try {
              if (localId) {
                const src = localAssetFile(localId);
                if (!src) throw new Error('本机资产 ' + localId + ' 的文件已经不在了');
                fs.copyFileSync(src, tmp);
                size = fs.statSync(tmp).size;
              } else {
                size = await downloadTo(target, tmp);
              }
              /* 按字节认回：磁盘对账补建的那一族裸行（没有 upstream、没有 detail）按平台产物号、
                 按来源地址都查不到 —— 于是「文件明明在盘上，卡片却一直加载不出来」。
                 这一份的字节与那一行同签名时，把身份（来源地址 + 任务号 / 产物号）写到那一行上，
                 不再落第二份字节、不再开第二条账：「存回本机」因此兼是修复，坏掉那一张按一次就认回来。
                 只认「两头都没有身份」的那一行 —— 已经有号的可能是同内容的另一份产物，
                 把这一份的身份盖上去会把它那张卡换掉（接错比不接更糟）。 */
              const itemSig = localSigOf(tmp, size);
              const bare = itemSig ? localIndexRead().find(x => x && x.sig === itemSig
                && !String(x.upstream || '').trim()
                && !identityOf(x).assetId && !identityOf(x).taskId) : null;
              if (bare) {
                try { fs.unlinkSync(tmp); } catch {}
                invalidateScan();               // 落点目录里刚多出又少掉一个 .tmp，那份快照不能留给下一轮列表
                fillAndSave(bare, { prompt: meta.prompt || '', model: meta.model || '',
                  voice: meta.voice || '', priceText: meta.priceText || '', duration: meta.duration ?? null,
                  credits: meta.credits ?? null, chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
                  usage: meta.usage || null, upstream: up, assetId: ident.assetId, taskId: ident.taskId,
                  detail: (meta.detail && typeof meta.detail === 'object') ? Object.assign({}, meta.detail, { bytes: size }) : null });
                log('[local-assets] 按字节认回 ' + bare.id + '（' + bare.file + '，裸行补上身份，不重存字节）');
                return { ...bare, status: 'succeeded', url: '/asset/' + bare.id, reused: true };
              }
              /* 内容指纹兜底：upstream 算不出键时按 sha256 找同内容的那条 ——
                 找到就复用（扔掉刚下载的 tmp，不新开、不重写文件），治「同一份产物存两遍」。 */
              if (!upKey && !localId) {
                itemSha = sha256Of(fs.readFileSync(tmp));
                const twin2 = itemSha ? localIndexRead().find(x => x && x.sha256 === itemSha) : null;
                if (twin2) {
                  try { fs.unlinkSync(tmp); } catch {}
                  fillAndSave(twin2, { prompt: meta.prompt || '', model: meta.model || '',
                    voice: meta.voice || '', priceText: meta.priceText || '', duration: meta.duration ?? null,
                    credits: meta.credits ?? null, chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
                    usage: meta.usage || null, assetId: ident.assetId, taskId: ident.taskId,
                    detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null });
                  log('[local-assets] 内容指纹命中 ' + twin2.id + '（同内容已存过，不新开）');
                  return { ...twin2, status: 'succeeded', url: '/asset/' + twin2.id, reused: true };
                }
              }
              place = newBodyPlace({ name: spec.name, id, format: fmt, mime });
              const why2 = whyNoSpace(place.dir, size, '把这一份产物存进本机资产库');
              if (why2) throw new Error(why2);
              renameWithRetry(tmp, place.abs);
              fsyncPath(place.abs);           // 退避重试也带上 fsync：与 .data 里的写盘纪律同一份
            } catch (e) {
              try { fs.unlinkSync(tmp); } catch {}
              throw e;
            }
            invalidateScan();
            const item = {
              id, file: place.file, name: spec.name || place.name, mime,
              format: fmt, byte_length: size, created_at: new Date().toISOString(),
              media_type: localMediaType({ format: fmt, mime, media_type: spec.media_type }),
              prompt: meta.prompt || '', model: meta.model || '', voice: meta.voice || '',
              provider: meta.provider || 'local', duration: meta.duration ?? null,
              credits: meta.credits ?? null, priceText: meta.priceText || '',
              chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
              usage: meta.usage || null, upstream: up,
              /* 平台身份写在账的最上层：来源地址与产物号 / 任务号是两种独立凭据 ——
                 外链会过期，产物号不会；列表里那一条带的是产物号，本机这一份也必须有。 */
              assetId: ident.assetId, taskId: ident.taskId,
              /* 双身份：fid 挡同卷改名 / 移动，采样签名挡跨盘、跨机、被同步盘重写的那几种。
                 用户改文件名、把整堆挪到别的盘，下一轮磁盘对账就靠这两个把它认回来。 */
              fid: fileFidOf(place.abs), sig: localSigOf(place.abs, size),
              /* 内容指纹（懒写：有 upstream 的不算不写）——下次同内容再来时靠它认出「已经存过了」。 */
              ...(itemSha ? { sha256: itemSha } : {}),
              detail: (meta.detail && typeof meta.detail === 'object') ? Object.assign({}, meta.detail, { bytes: size }) : null,
            };
            /* 这一条走队列，不走同步的 upsert：从上面那次 `localIndexRead()` 到这里隔着一次
               真下载（`await downloadTo`），期间别的请求完全可能写了索引。fn 里拿到的
               永远是**队首时刻**的当前表，`localIndexPut` 只动这一条。 */
            await localIndexUpdate(list => localIndexPut(list, item));
            log('[local-assets] 新增 ' + id + '（' + place.file + '，' + (size / 1024).toFixed(0) + ' KB，from-url）');
            return { ...item, status: 'succeeded', url: '/asset/' + id };
          });
          sendJson(res, 200, out);
        } catch (e) {
          log('[local-assets/from-url] 保存失败：' + e.message);
          const msg = e && e.indexWrite
            ? ('字节已经写进本机资产库了，但索引没写成：' + e.message + '。腾出磁盘空间后再试')
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
          /* 同一道类别闸（见上面 from-url 那一段）：base64 直传也不例外，非媒体的扩展名当场 400，
             不落字节也不记账。 */
          if (!isMediaExt(fmt)) return failMsg(res, 400,
            '本机资产库只收图片 / 视频 / 音频；字幕 / 文本请放下载或提示词目录（这一份认出的格式是 ' + fmt + '）');
          const mime = spec.mime || (MIME['.' + fmt] || 'application/octet-stream');
          const meta = spec.meta || {};
          const ident = identOfMeta(meta);
          // WAV 头里能直接算出时长（字节率），不用客户端再解析
          let duration = meta.duration || null;
          if (fmt === 'wav' && buf.length > 44 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WAVE') {
            try {
              const byteRate = buf.readUInt32LE(28);
              const dataSize = buf.readUInt32LE(40);
              if (byteRate > 0 && dataSize > 0) duration = Math.round((dataSize / byteRate) * 10) / 10;
            } catch {}
          }
          const patch = { prompt: meta.prompt || '', model: meta.model || '',
            voice: meta.voice || '', priceText: meta.priceText || '', duration, credits: meta.credits ?? null,
            chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
            usage: meta.usage || null, assetId: ident.assetId, taskId: ident.taskId,
            detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null };
          /* 来源外链先算出来：它是「这份产物本机有没有存过」的凭据（见 localUpKey）。
             算不出键（upstream 为空 —— base64 直传的附件就走这条）再用内容指纹兜底：
             懒算一次 sha256 去索引找同内容的那条，找到就复用不新开。 */
          const up = safeOutboundUrl(String(meta.upstream || '')) || '';
          const upKey = localUpKey(up);
          const sha = upKey ? '' : sha256Of(buf);
          const list0 = (upKey || sha) ? localIndexRead() : [];
          const twin = upKey ? list0.find(x => x && localUpKey(x.upstream) === upKey)
            : (sha ? list0.find(x => x && x.sha256 === sha) : null);
          if (twin) {
            /* 已经有一份了：**不再落第二个文件**。客户端那份镜像键丢了（换端口 / 清浏览器数据 /
               平台这次没给产物号）不代表盘上没有 —— 这里挡住才是唯一跨源有效的一道闸。
               顺手复用它的 id：别的页面、收藏、导演台工作区里存过的 `/asset/<那个 id>` 照样能播。 */
            const fp = localFileFromEntry(twin);
            let size = -1;
            try { size = fp ? fs.statSync(fp).size : -1; } catch {}
            if (size !== buf.length) {
              /* 补回来也是一次真写入：字节没了（用户手动删过 / 盘满了没落住）就按原 id、原落点重写。 */
              const dir = bodyDirOf(bodyDirNameOf({ format: fmt, mime: twin.mime || mime }));
              fs.mkdirSync(dir, { recursive: true });
              const place = fp ? { abs: fp } : newBodyPlace({ name: twin.name || spec.name, id: twin.id, format: fmt, mime });
              const whySpace = whyNoSpace(dir, buf.length, '把本机副本补回来');
              if (whySpace) throw new Error(whySpace);
              atomicWrite(place.abs, buf);
              twin.file = fp ? twin.file : path.relative(localRootDir(), place.abs);
              twin.fid = fileFidOf(place.abs);
              twin.sig = localSigOf(place.abs, buf.length);
              twin.byte_length = buf.length;
              if (twin.format !== fmt) { twin.format = fmt; twin.mime = mime; }
              invalidateScan();
            }
            fillAndSave(twin, patch);
            log(`[local-assets] 已有本机副本 ${twin.id}（同一份产物，第 ${list0.filter(x => localUpKey(x && x.upstream) === upKey).length} 次镜像被挡下）`);
            sendJson(res, 200, { ...twin, status: 'succeeded', url: '/asset/' + twin.id, reused: true });
            return;
          }
          const id = mintAssetId();
          const place = newBodyPlace({ name: spec.name, id, format: fmt, mime });
          /* 落字节之前先问一次余量：这条路由是「产物自动镜像本机」的唯一出口，
             盘满时以前是 ENOSPC 抛出来再被外面那道 catch 转成一句 500，
             而那句只说「no space left on device」，用户不知道该清哪一块。 */
          const whySpace = whyNoSpace(place.dir, buf.length, '把这一份产物存进本机资产库');
          if (whySpace) throw new Error(whySpace);
          atomicWrite(place.abs, buf);
          /* ^ 与 .data 同一份写盘纪律：落完 fsync 再 rename。
             直接 writeFileSync 时，掉电/崩溃会留下「索引里有一条、盘上是半个文件」的资产，
             离线看得到缩略图却播不出来，而这条路由是产物镜像本机唯一的出口。 */
          invalidateScan();
          const item = {
            id, file: place.file, name: spec.name || place.name, mime,
            format: fmt, byte_length: buf.length, created_at: new Date().toISOString(),
            media_type: localMediaType(spec),
            prompt: meta.prompt || '', model: meta.model || '', voice: meta.voice || '',
            provider: meta.provider || 'local', duration,
            credits: meta.credits ?? null, priceText: meta.priceText || '',
            chars: meta.chars != null ? Number(meta.chars) : (meta.prompt ? String(meta.prompt).length : null),
            usage: meta.usage || null,
            /* 平台身份写在账的最上层：外链会过期，产物号 / 任务号不会。 */
            assetId: ident.assetId, taskId: ident.taskId,
            /* 镜像回源用：这份文件是从哪个外链取回来的字节。
               /asset/<id> 在**本地文件被删掉**时靠它回源（见 /asset 那段），这是三级回退的中间一级 ——
               以前本地文件一没就只剩 404，界面据此判成「已删除」，其实上游那份可能还能取。 */
            upstream: up,
            fid: fileFidOf(place.abs), sig: localSigOf(place.abs, buf.length),
            /* 内容指纹（懒写：有 upstream 的不算不写）——下次同内容再来时靠它认出「已经存过了」。 */
            ...(sha ? { sha256: sha } : {}),
            /* 任务详情原样带走：提示词、参数、费用、耗时、状态变迁。
               平台那边的记录会随时间被清理，索引里这一份是「任务当时是什么样」的本地留底。 */
            detail: (meta.detail && typeof meta.detail === 'object') ? meta.detail : null,
          };
          localIndexUpsert(item);
          log(`[local-assets] 新增 ${id}（${place.file}，${(buf.length / 1024).toFixed(0)} KB）`);
          sendJson(res, 200, { ...item, status: 'succeeded', url: '/asset/' + id });
        } catch (e) {
          log('[local-assets] 保存失败：' + e.message);
          /* 索引写不成时把话说到位：字节确实已经写进库根了，缺的只是索引那一行。
             不这么说的话，调用方看到 500 会当「整件事都没成」而丢掉已经存好的那份，
             或者反过来（以前）看到 200 而当「成了」—— 两种说法都和盘上的实情对不上。 */
          const msg = e && e.indexWrite
            ? ('字节已经写进本机资产库了，但索引没写成：' + e.message
              + '。库里面现在看不到它。腾出磁盘空间后再保存一次；'
              + '磁盘对账会把它当作一份没登记过的产物补回来。')
            : e.message;
          failMsg(res, 500, msg);
        }
      });
      return;
    }
    /* 浏览器那份「平台产物 → 本机哪一份」的字典改由这里现问：代理手里有账与字节，
       外链过期、换端口、清站点数据之后答案都还在。只读，不下载、不补建。 */
    if (dataPath === '/local-assets/aliases' && req.method === 'GET') {
      sendJson(res, 200, localAliases());
      return;
    }
    /* 批量问「这几件平台产物在本机是哪一份」：资产列表先拿结果再决定卡片上的地址。
       条数封顶 2000：一屏列表最多也就几百条，超出的请求是异常调用，不替它扫全表。 */
    if (dataPath === '/local-assets/locate' && req.method === 'POST') {
      readBody(req, res, 4 * 1024 * 1024).then(raw => {
        if (raw == null) return;
        let spec = null;
        try { spec = JSON.parse(raw.toString('utf8')); } catch {}
        const items = (spec && Array.isArray(spec.items)) ? spec.items.slice(0, 2000) : [];
        sendJson(res, 200, { rows: localLocateBatch(items) });
      });
      return;
    }
    if (req.url.startsWith('/local-assets/') && req.method === 'DELETE') {
      // 删除本地生成资产（上游没有资产存储、文件只在本机的，比如语音合成产物）
      const id = safeDecode(req.url.slice('/local-assets/'.length).split('?')[0]);
      const allRows = localIndexRead();
      const hit = allRows.find(x => x && x.id === id);
      if (!hit) return failMsg(res, 404, '本地资产不存在：' + id);
      /* **文件删不掉就不许裁索引**。为什么这条最要紧：索引是这些文件唯一的查找途径 ——
         条目一没，那个 mp4 在资产库里看不见、/asset/<id> 也 404，而它明明还躺在库里，
         只是再也没人能按名字找回来。
         什么情况下删不掉：文件正被播放器 / 预览器打开、被同步盘（OneDrive 之类）占着、
         被杀毒软件扫着 —— 都是常见情形，不是罕见边角。
         立场与 /data 的 DELETE 完全一样（那边注释写得很清楚：删不掉必须回错误，
         否则用户看到「删了又回来」）。
         删的是**这一张卡背后的每一条、每一份**（同内容并进来的 altPaths，加上别的账各自名下的
         本体 —— 判据与列表并卡同一份，见 server/local-assets-store.js 的 localAssetSiblings）：
         界面上只有一张卡，卡下面却可能是两条账两份字节（换了中转地址重下的那一份落的就是新 id），
         只收眼前这一条的话，另一条下一轮又自成一张卡 —— 还是「删了又回来」。 */
      const group = [hit].concat(localAssetSiblings(allRows, hit));
      const paths = [];
      group.forEach(r => localAssetPaths(r).forEach(p => { if (!paths.includes(p)) paths.push(p); }));
      const undeled = [];
      for (const f of paths) {
        try { fs.unlinkSync(f); }
        catch (e) { undeled.push(f + '（' + (e.code || e.message) + '）'); }
      }
      if (undeled.length) {
        log('[local-assets] 删除文件失败，索引没有动：' + undeled.join('、'));
        failMsg(res, 500, '文件删不掉：' + undeled.join('、')
          + ' 它可能正被播放器 / 同步盘 / 杀毒软件占着。这一条原样留着（资产库里还在，还能打开）——'
          + '关掉占着它的程序再删一次。');
        return;
      }
      /* 整组一次写回：串行队列里一趟走完，不留「文件没了、账还剩一半」那个窗口。
         ⚠ 这一条是**排队**的（见 server/index-store.js 的 update）：同步 try/catch 罩不住它，
         写盘失败会在几十年后的微任务里 reject —— 那时这句已经回完 200，
         用户看见「已删除」而账还留着，下一轮列表又把这一条补成一张卡（那条「删了又回来」）。
         所以出口挂在 then/catch 上，不靠 try/catch。 */
      localIndexUpdate(list => group.forEach(r => localIndexDrop(list, r.id))).then(() => {
        invalidateScan();
        log(`[local-assets] 已删除 ${id}（一张卡：${group.length} 条账、${paths.length} 份字节）`);
        sendJson(res, 200, { ok: true, id, files: paths.length, rows: group.length });
      }).catch(e => {
        /* 文件已经删掉了，但索引没写回去：这一条会「复活」成一条指向不存在文件的记录，
           下次打开会显示成「已丢失」。如实说，别回「已删除」——那会让用户以为干净了。 */
        log('[local-assets] 文件已删、索引未更新：' + e.message);
        failMsg(res, 500, '文件已经删掉了，但索引没能更新（' + e.message
          + '）：下次打开这一条会显示成「已丢失」。再删一次它就能从列表里清掉。');
      });
      return;
    }
    if (dataPath === '/local-assets' && req.method === 'GET') {
      // 列表：形状与上游列表一致（data + next_cursor），资产库用 registry 的 list 声明直接读
      /* 先把盘上有、账里没有的那一份补进账（手动拖进库根的、从别的机器拷来的、被上限挤出去的）。
         dirScan 有 30 秒缓存，同一次列表的重复请求不会反复扫盘。 */
      try { localAdopt(); } catch (e) { log('[local-assets] 磁盘对账没跑成（列表照常用现有账）：' + e.message); }
      // 大类型每次现算 —— 老索引里写死过 'audio'，按扩展名重算才能把那张 PNG 认回图片
      // 时间也每次现算：索引里那份 created_at 是**落盘**时刻，一次回源能把几百条老产物写成「今天」，
      // 按它排序就把资产库里唯一的图片挤出选择器「全部」那一档的前 200 条（见 localAssetWhen）。
      /* 同一份产物的多份字节只报一条：来源键相同（同一外链的两次镜像）或内容签名相同
         （换过中转地址重下、改过名字再存一遍）都算同一件作品。文件仍在盘上，只是不再当成 N 张卡
         摆在界面上；`duplicates` 报出还压着多少份，要清理由用户自己决定 —— 删文件是删用户数据。 */
      const all = localIndexRead().map(x => ({ ...x, created_at: localAssetWhen(x), media_type: localMediaType(x), status: 'succeeded', object: 'asset' }));
      const items = [];
      const seenUp = new Set(), seenSig = new Set();
      let dups = 0;
      for (const x of all) {                               // 顺序就是索引顺序（新→旧）
        const k = localUpKey(x.upstream);
        const s = String(x.sig || '');
        if ((k && seenUp.has(k)) || (s && seenSig.has(s))) { dups++; continue; }
        if (k) seenUp.add(k);
        if (s) seenSig.add(s);
        items.push(x);
      }
      sendJson(res, 200, { object: 'list', data: items, has_more: false, next_cursor: null, duplicates: dups });
      return;
    }
    return false;
  }

  return { handleLocalAssets };
}

module.exports = { createLocalAssets };
