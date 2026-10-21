/* 注册表 / 自定义供应商取型号：/registry 的合并清单与 /custom/models 的现场查询。 */
'use strict';
const { modelRowsOf } = require('../registry-config.js');
const { sendJson } = require('./http');

function createRegistryRoutes(ctx) {
  const { REGISTRY, allProviders, customNotice, modelPrefsNotice, MODEL_PREFS_KEY, readBody, guardOutboundUrl, upRequest } = ctx;

  function handleRegistry(req, res, urlObj) {
    const dataPath = (urlObj && urlObj.pathname) || req.url.split('?')[0];
    if (dataPath === '/registry') {
      // 供客户端按能力过滤模型；设置页添加的自定义平台合并在这里（清单来自 .data/sk_custom.json）
      sendJson(res, 200, {
        ...REGISTRY,
        providers: allProviders(),
        /* 有哪些条目被丢掉、为什么：界面据此说清「我明明添加了，下拉里没有」，
           而不是让人去猜是不是功能坏了（原因文本见 customProblem） */
        custom: { dropped: customNotice.dropped, reason: customNotice.reason },
        /* 型号清单偏好读不动时要说出来（与上面 custom.notice 同一立场）：
           不然「我把这个型号藏了，下拉里怎么还在」只能靠猜。 */
        modelPrefs: { reason: modelPrefsNotice.reason, key: MODEL_PREFS_KEY },
      }, { 'Access-Control-Allow-Origin': '*' });
      return;
    }
    /* 添加自定义供应商时的「获取型号列表」：拿**表单里现填的**形状 + 地址 + 密钥，问一次它自己的型号表。
       为什么必须留在代理里、不能由页面直连：这条路由要把用户的密钥递到他自己填的那个主机，
       「只收公网 https / 拒回环与内网 / 域名解析到内网也拒」那套判据（safeOutboundUrl，
       与 buildCustom 用的是同一个）以及「绝不回退 .env 里的内置密钥」都在这一层。
       页面自己发就等于把这套安全判据抄第二份 —— 而漏一份就是「密钥发去了不该去的主机」。
       走已有平台的 relay 也不行：图片/视频/语音那几家都没有 baseEditable，
       代理会拒掉 x-up-base（那是故意的，见 relay 转发那段注释）。 */
    if (dataPath === '/custom/models' && req.method === 'POST') {
      readBody(req, res, 8 * 1024).then(raw => {
        if (raw == null) return;
        let q = {};
        try { q = JSON.parse(raw.toString('utf8')) || {}; } catch {}
        const tpl = REGISTRY.providers.find(p => p.id === String(q.shape || ''));
        if (!tpl) { sendJson(res, 400, { ok: false, error: '找不到当模板的内置平台：' + (q.shape || '(空)') }); return; }
        const key = String(q.key || '').replace(/^\s*Bearer\s+/i, '').trim();
        if (!key) { sendJson(res, 400, { ok: false, error: '没有密钥 —— 型号列表是要鉴权的接口' }); return; }
        /* 地址校验用**异步那份** guardOutboundUrl（除了字面量 IP 还会解析域名、拦住 *.nip.io
           这类「看着是公网、实际指向 127.0.0.1」的写法），与取外链字节那条路同一套判据。
           buildCustom 落盘时用的是同步那份 —— 那是「先存下来、真正发请求时再判」；
           这里马上就要把密钥递出去，必须先判干净。 */
        guardOutboundUrl(String(q.base || '')).then(base => {
          /* 型号表端点：声明了就用它；OpenAI 兼容的那一族都在 base + /models（文字 AI 也走这条，
             TextAI.rawModels 拼的就是 relay + '/models'）。没有声明就算 /models 而不是报错 ——
             报「这一类没有型号列表接口」会让「其实有」的平台没法用。 */
          const ep = (tpl.endpoints && tpl.endpoints.models) || '/models';
          const url = base.replace(/\/+$/, '') + ep;
          /* 这条路由对「问不到型号」的回答一直是 200 + { ok:false, error }（上游回了非 200 也这么答），
             连不通也走同一份 —— 设置页那一句 `d.error` 才拿得到真实原因。
             以前只有 ur 上挂了 failUpstream，而**域名解析不出来**的错误是发在请求对象上的
             （ur 压根没被创建），于是这个响应永远不结束：页面只能等到自己的超时，
             报出来的是「连不上本地代理（proxy.js 没启动？）」—— 而代理活得好好的。 */
          const out = o => {
            if (res.headersSent) { try { res.destroy(); } catch {} return; }
            sendJson(res, 200, o);
          };
          const fail = e => out({ ok: false, from: url, error: '连不通（打到 ' + url + '）：' + String((e && e.message) || e || '') });
          const rq = upRequest(url, { method: 'GET', headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, timeoutMs: 20000 }, ur => {
            const bufs = [];
            let total = 0, dead = false;
            /* 边收边累计：型号表正常只有几十 KB，8MiB 还收不完多半是打到了别的东西。
               以前是全收下来再解析，一个超大响应会先把代理内存吃掉。 */
            ur.on('data', c => {
              if (dead) return;
              total += c.length;
              if (total > 8 * 1024 * 1024) {
                dead = true;
                try { ur.destroy(); } catch (e) {}
                out({ ok: false, from: url, error: '型号列表响应超过 8MB，已中止（这个地址回的不是型号列表）' });
                return;
              }
              bufs.push(c);
            });
            ur.on('end', () => {
              if (dead) return;
              const buf = Buffer.concat(bufs);
              if (ur.statusCode !== 200) {
                const txt = buf.toString('utf8', 0, 400).replace(/\s+/g, ' ').trim();
                out({ ok: false, from: url, error: '它回了 HTTP ' + ur.statusCode + (txt ? '：' + txt : '') });
                return;
              }
              let d = {};
              try { d = JSON.parse(buf.toString('utf8')) || {}; } catch (e) {}
              /* 形状只认注册表顶层 modelList.fields（与页面 Api.modelRows 同一处声明）：
                 以前这里只认 data / models / result，页面 verify 只认 data / items / models，
                 同一家的同一个接口在设置页与资产库得到两种结论。 */
              const arr = modelRowsOf(REGISTRY, d);
              const models = (Array.isArray(arr) ? arr : [])
                .map(m => { const id = m && (m.id || m.name); if (!id) return null; return { id: String(id), name: String((m && (m.display_name || m.name)) || id) }; })
                .filter(Boolean);
              out({ ok: models.length > 0, from: url, count: models.length, models,
                error: models.length ? '' : '它回了 200，但响应里没有型号列表（不是 id 数组）' });
            });
            ur.on('error', e => { if (!dead) fail(e); });
          });
          /* upRequest 的 timeoutMs 是**空闲**超时：域名解析那一步还没有 socket，不受它管。
             不加这道墙钟的话，一个解析不出来的地址会让设置页的「获取型号列表」一直转圈。 */
          const wall = setTimeout(() => { try { rq.destroy(new Error('等待上游超过 25 秒')); } catch (e) {} }, 25000);
          rq.on('close', () => clearTimeout(wall));
          rq.on('error', e => { clearTimeout(wall); fail(e); });
          /* GET 没有请求体，但**照样要 end()**：Node 的 ClientRequest 不在 end/flushHeaders
             就一个字节都不发，回调永远不来。缺这一句时上面那两道监听器都挂好了，于是页面
             要等满 25 秒墙钟才拿到一句「连不通（打到 …）」—— 设置页点「获取型号列表」看起来
             就是卡住。`routes-smoke` 那条假 upRequest 故意不替调用点补 end，专门盯这一句。 */
          rq.end();
        }).catch(e => sendJson(res, 400, { ok: false, error: '地址不可用：' + e.message }));
      });
      return;
    }
    /* ============================================================================
       弹系统原生的「选择文件夹」（POST /pick-dir）
       ---------------------------------------------------------------------------
       为什么是代理干的活：设置页那个目录输入框，用户要的是「点一下、弹资源管理器、自己挑」。
       纯前端做不到 —— 浏览器的 `<input type=file webkitdirectory>` **只给文件夹名不给全路径**，
       File System Access API 给的是句柄、不是字符串、也存不下来。老老实实只留一个输入框
       是把平台的限制原样甩给用户，所以这条路由让**本机代理**去弹系统自带的那个对话框
       （和 `probeTool` 探 ffmpeg、`/local-assets/open` 开资源管理器是同一类：只有本机进程能弹）。
    
       **用哪个 PowerShell 决定弹出来的是哪个框**（实测，两者不是同一个东西）：
         · `pwsh`（PowerShell 7，.NET 8 的 WinForms，程序集在 `Program Files\PowerShell\7\`）
           → `FolderBrowserDialog` 是**现代 IFileDialog** 实现：左边有快速访问/此电脑，
             上面有地址栏、可搜索、能新建文件夹 —— **和 Chrome 选「下载文件夹」是同一个壳**。
         · `powershell.exe`（5.1，GAC 里的 .NET Framework WinForms）
           → 老式 `SHBrowseForFolder` 树形框，没有地址栏、不能搜索。
       所以**优先找 pwsh，找不到才退回 5.1**，并且把用的哪一个回报给页面（`modern` 字段），
       别让人以为选了个框其实弹出来的是另一个。
    
       注入防护：start/title **一律走环境变量传进子进程**，脚本文本里不拼任何用户输入，
       再用 `-EncodedCommand`（UTF-16LE base64）传脚本本身 —— PowerShell 不会对参数做二次解析，
       所以路径里有引号、括号、分号、反引号都不会被当成命令。
    
       路径走 **base64(UTF-8)** 回传，不直接写文本：子进程 stdout 是管道，走的是
       「重定向输出」那套编码而不是控制台编码，`D:\AI生成\图片` 这种中文路径有变成乱码的
       可能 —— 路径一旦存错，界面显示「已保存」而文件永远落在别处，且不报错。
    
       退出码：0 = 选好了（stdout 一行 base64 路径）；3 = 用户取消（**不是失败**，页面不该弹红字）；
               其它 = 真出错了，把 stderr 的话照实带回页面。
       ========================================================================== */
    return false;
  }

  return { handleRegistry };
}

module.exports = { createRegistryRoutes };
