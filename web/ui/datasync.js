/* DataSync — 与本地代理的数据文件同步（信封 ts、体积 + 逐字节对账、突发写合并、整包备份）。
   从 web/ui/ui.js 拆出；依赖 Store / Kv / Net / Toast，加载顺序在这四个之后。 */
(function () {
  /* 整包备份的格式版本：导出写它、导入只认它。形状变了就升这一枚并在 importAll 里加一次
     用户数据的搬迁；旧形状的包一律拒绝，不做「读不到就当旧版」的双读。 */
  const PACK_VERSION = 1;
  /* 界面偏好那一批键名只由 ui.js 的 UI_PREFS 给（这张表同时被设置页渲染与助手白名单读），
     这里拿不到就当空表：宁可这几项这次不同步，也不让 DataSync 整块挂掉。顺序判据在 tests/settings-schema.cjs。 */
  const PREF_KEYS = (window.UI_PREFS && window.UI_PREFS.keys) ? window.UI_PREFS.keys() : [];
  /* 参与同步的键（前缀或全名）。刻意**不含**首屏缓存（*_cache_v1，可随时重建） */
  const SYNCABLE = [
    'sk_key_', 'sk_base_', 'sk_model_', 'sk_off_', 'sk_caps_', 'sk_text_vision', 'sk_polish_', 'sk_net_', 'sk_poll_sec',
    /* 文字 AI 的供应方选择与「自己填的型号」也属于「换个地方要重弄一遍」的东西，跟着数据文件走。
       `sk_text_models_` 在 v13 起已经改成一份 `sk_model_prefs`（见 gen-forms.js 的 ModelPrefs），
       这一条**先留着**：迁移是把旧键删掉的，键不在名单里就轮不到 `syncable()`，那次删除
       就不会镜像到 `.data/` —— 旧文件留在服务器上，下次对账又把它拉回来。 */
    'sk_text_prov', 'sk_text_models_',
    /* 设置页「添加自定义供应商」登记的接口（图片 / 视频 / 语音 / 文字 AI 四类都能加）：一份 JSON 数组，
       代理读它的镜像 `.data/sk_custom.json` 合并进 /registry —— 跟着数据文件走才能换机器还在。
       清单里只有「照哪一家的形状 + 地址 + 型号 id」，密钥仍按 keyId 存 `sk_key_<id>`，
       所以同步这一份不会把凭据带出去。 */
    'sk_custom',
    /* 本机资产库的根（那一份字节住在哪里）：`sk_local_dir` 存的是一个**目录路径字符串**。
       必须跟着数据文件走 —— 代理的 `localRoot()` 读的是 `.data/sk_local_dir.json`，
       界面上填了目录而它没落到服务器那份，表现就是「改了位置、产物还往老地方写」，
       而且没有任何报错。（旧的 `sk_autosave` 是「按三类分别另存到哪」，那一族已撤，
       清理在 ui.js 的 LEGACY_KEYS。） */
    'sk_local_dir',
    'ai_usage', 'sparkcine_gallery', 'audio_tasks', 'fav_items',   // 视频台不再有本地任务（卡片来自接口）
    'page_mode_', 'page_size_',
    /* 界面布局偏好里**不属于 UI_PREFS** 的那几项：分栏比例（三个工作台 + 语音台共用 wb_split、导演台 dir_split）、
       侧栏余额勾选、导演台的候选展开与静音。
       以前只存浏览器本地 → 换台机器（或清一次浏览器数据）栏宽和视图全丢，
       而它们和 dir_theme 一样属于「用户调出来的界面」，该跟着数据文件走。
       刻意不写整个 'dir_' 前缀：dir_img / dir_video / dir_audio / dir_render 是**本机磁盘路径**，
       换台机器就不成立。 */
    'wb_split', 'dir_split', 'dir_cand_expand', 'dir_muted', 'sb_bal_show',
    /* 产物镜像的「存哪 / 读哪 / 标识」开关：以前这一行是 UI_PREFS 的手抄第三份，
       抄漏的 sb_open 与 sk_media_badge 换台机器就回到默认档 —— 整批改由下面那张表带出来。 */
    ...PREF_KEYS,
    /* 素材库（角色 / 场景 / 道具）。键名 2026-10 由 drama_chars 改成 char_lib：
       拍短剧页删掉之后 drama_ 前缀已经名不副实。搬运用下面的 `migrateRenamedKeys()`。
       旧名 drama_chars **刻意不在这里**：它在名单里就意味着「服务器上有一份也要拉回来」，
       而迁移正是要把那份删掉的 —— 留着会让一次失败的 DELETE（代理不在 / 超时）变成
       「下次 boot 又拉回来」，于是每次开页面重复一遍拉回 / 删掉。
       不在名单里的代价是：那一份文件万一没删掉，它就静静躺在 .data/ 里不再被读 ——
       这比一条死循环划算得多（迁移里对每条旧键都显式发一次 DELETE ?nobak=1，绕开 .bak）。 */
    'char_lib',
    /* 素材库那一页的设置（char_ 前缀：音色怎么定、候选张数、是否让 AI 自动定音色）。
       它们和 page_mode_ / sk_polish_ 一样属于「换台机器要重配一遍」的东西。 */
    'char_',
    /* AI 助手的对话记录：换浏览器 / 换机器还想接着上次问，所以和数据文件走。
       只存问答正文（上限 60 条），工具查出来的东西不落盘 —— 那是随时能重查的。 */
    'ai_chat',
    /* 注意：提示词不再进 localStorage，改存归档文件夹（PromptLog → /prompts），
       归档位置是库根下的「提示词\」（跟着 sk_local_dir 那一格走），页面不再单独存目录键 */
  ];
  /* 前缀匹配会把「缓存」也算进来（audio_tasks_cache_v1 会被 audio_tasks 命中），所以再排一次。
     ai_chat_* 这几条是「'ai_chat' 这一条前缀顺带命中」的，必须在这里逐条点名排除（踩过：附件身份整包同步出网）：
     · ai_chat_files —— 存的是附件的名字 / 本机资产地址 / 文本快照。换到另一台机器那些 la_xxx 根本不在，
       等于把「你往助手递过哪些文件、文件里写了什么」上传到坚果云，而它一点用都没有。
     · ai_chat_auto  —— 「执行前不用我点确认」。这是**本机**的安全开关，跟着云走会变成
       「换台机器一开机，助手就已经在自动提交任务了」。
     · ai_chat_xy    —— 悬浮球坐标，窗口尺寸各台机器不一样，同步过去只会把球摆到看不见的地方。
     · ai_chat_snap  —— 「拖到边上吸住」的开关，跟着上一条走：它是本机窗口几何的事，不是用户的偏好数据。
     · ai_chat_watch —— 「助手提交、还在等结果的任务」清单 + 球上没看的条数。任务号跟着机器走：
       同步到另一台，那边会去轮这一台提交的任务、并把提醒弹在错的人面前。
     · ai_chat_notice —— 「出结果弹系统通知」的开关。浏览器的授权状态本来就不在 localStorage 里、
       同步不过去；把开关同步过去等于在没授权的机器上许诺「会弹」，而它一定弹不出来。
     · ai_chat_off —— 「这个浏览器上干脆不装 AI 助手」。和 ai_chat_auto 同理是**本机**的选择：
       在一台机器上关掉它，不该顺手把另一台也关了。
     对话记录 ai_chat 照旧同步；助手的供应方/型号只在设置页那一档（sk_text_prov / sk_model_*），
     抽屉里不再有第二份选择。 */
  const NOT_SYNC = ['_cache_v1', 'sk_model_meta_', 'ai_chat_files', 'ai_chat_auto', 'ai_chat_xy', 'ai_chat_snap', 'ai_chat_watch', 'ai_chat_notice', 'ai_chat_off',
    /* ai_chat_ref_send ——「引用发给助手时带哪些字段」是本机的一份口味：
       换台机器的人可能想全带、也可能只发图片；跟着云同步走会替别人改主意。
       它**进设置导出**（换机器导一次设置带得走），只是不跟着 .data 同步。 */
    'ai_chat_ref_send',
    /* 浮窗几何（ai_chat_h）与 ai_chat_xy 同一类：各台机器的窗宽窗高不一样，
       同步过去只会把浮窗摆到另一台看不见的地方。
       （旧的 ai_chat_fxy「浮窗被拖走」标记已作废 —— 浮窗不再能脱离球；
         盘上那份残留由 ui.js 的 LEGACY_KEYS 连镜像一起删，不在这里点名。） */
    'ai_chat_h'];

  const TOL = 3000;                          // 容忍 3 秒的时钟/写入误差，避免两边来回覆盖
  const pending = new Map();                 // key → { t: 定时器, body: 待发内容（null = 删除） }
  const sanitize = k => k.replace(/[^A-Za-z0-9_-]/g, '_');
  /* 不进 localStorage 的镜像键：本体在 IndexedDB（导演台工作区），页面把快照单独递给我们。
     下面 queue 里那道「发送前再比一眼本机当前值」的闸门对它们没有意义 —— 本机根本没有这个值，
     一比就永远「不一致」，镜像静默不落地（踩过：.data/workspace.json 停在两天前，
     换机器 / 清过浏览器缓存时恢复出来的是旧工作区，签名外链的换新也白做）。 */
  const NO_LOCAL = new Set(['workspace']);
  /* 「这条待发的内容还是不是本机的当前值」——**一处判据，三个调用点**
     （queue 的定时器 / flush / flushKeepalive 都问它）。
     以前三处各写一遍，其中只有 queue 那份带了 NO_LOCAL 豁免，于是：
     保存工程 → 800ms 内切页或切标签 → flushKeepalive 认为「本机没有这个值，不一致」
     → 把这次保存当过期任务丢掉（.data/workspace.json 停在旧内容）；
     就算当时没丢、后来进了死信，boot 里的补传（:2551 那个 flush）也会用同样的理由再丢一次 ——
     「上次没送出去的任务这里补一次」对 workspace 永远补不上。 */
  const diverged = (key, body) => {
    const cur = window.LS.get(key);
    const stale = body == null ? (cur != null && cur !== '') : cur !== body;
    return stale && !NO_LOCAL.has(key);
  };

  const syncable = key => !!key
    && !NOT_SYNC.some(x => key === x || key.endsWith(x) || key.startsWith(x))
    && SYNCABLE.some(p => key === p || key.startsWith(p));

  /* 多标签页写同一份 `.data`：以前两个标签页同时 flush 就是最后的那个覆盖前面的。
     浏览器支持 Web Locks 时把每一次写入串起来（单个键仍是最新值赢，但不再交叉写坏整表）；
     不支持就保持原样（不能因为少一个 API 让设置完全存不了）。 */
  function withDataLock(fn) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
        return navigator.locks.request('wb-data-write', fn);
      }
    } catch (e) {}
    return Promise.resolve().then(fn);
  }
  async function putData(key, body) {
    return withDataLock(async () => {
      const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, timeout: 15000, retry: 0,
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    });
  }
  async function delData(key) {
    return withDataLock(async () => {
      const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), { method: 'DELETE', timeout: 15000, retry: 0 });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return true;
    });
  }
  /* 读回某个数据文件的内容，**返回原始文本**。
     不能假设是 JSON：同步的键里有一半存的是普通字符串
     （dir_theme=dark、sk_polish_*=提示词文本、sk_key_*=密钥、page_mode_=page…），
     JSON.parse 会直接抛错。需要对象的地方由调用方自己 JSON.parse。 */
  async function getData(key) {
    const r = await window.Net.fetch('/data/' + encodeURIComponent(sanitize(key)), { timeout: 15000, retry: 0 });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  let mirrorBroken = false;                  // 已经提示过一次就别刷屏
  /* 突发写合并：同一个键 800ms 内只发最后一次（导演台每 500ms 就去抖保存，直接发会把代理刷爆）。
     队列里连**内容**一起记下来：body 为 null 表示「本地删了」，flush 时必须走删除接口 ——
     以前队列只记定时器、flush 时再去读 localStorage，删除任务就被丢掉了
     （服务器文件没删 → 下次 boot 把已删数据又拉回本地）。
     tries = 已经失败几次：失败**不能把任务丢掉**（以前一失败就只剩一句 Toast，
     那份修改永远停在浏览器里，代理重启/网络抖一下就算白写），
     按 800ms×3 的退避重试，最多 4 次；本地 localStorage 始终是写成功的，所以只是「晚一点落盘」。 */
  const RETRY_MAX = 4;
  /* 对账（boot）跑完之前，本地写入先进暂存表，不立刻镜像到 .data/。
     boot 的拉取是异步的：一个刚打开的页面 —— 尤其是一个全新的浏览器上下文
     （自动化验证、换机器、清过浏览器数据）—— 完全可能在读到数据文件之前就写了一次
     「它以为的内容」。那次写走的是「最后写入者赢」，会把还没读到的真实数据整个顶掉
     （收藏就是这么被清空的）。
     对账结束后统一补发：queue 本来就会比对本机当前值，
     已经被 boot 覆盖掉的过期暂存自然丢弃，真正属于本机的修改照常落盘。 */
  let booting = false;
  const held = new Map();                        // key → 待发内容（null = 删除）
  function releaseHeld() {
    const jobs = [...held.entries()];
    held.clear();
    for (const [k, body] of jobs) queue(k, body);
  }
  function queue(key, body, tries) {
    /* 队列按**落盘文件名**（sanitize 后）合并，但「本机当前值」必须用**原始键**比：
       含点的键（page_size_*.<x> 之类）sanitize 成下划线之后 localStorage 里根本没有，
       diverged 永远判「不一致」，那一份修改就被静默丢掉。 */
    const k = sanitize(key);
    const raw = String(key);
    const payload = body == null ? null : String(body);
    if (booting && !tries) { held.set(raw, payload); return; }
    const prev = pending.get(k);
    if (prev) clearTimeout(prev.t);
    const n = tries || 0;
    const t = setTimeout(async () => {
      pending.delete(k);
      /* 发之前再看一眼本机当前值：合并窗口里如果值被别处改写（例如 boot 刚从服务器拉回更新的一份），
         这条任务就已经过期，发出去会把旧的盖给新的。判据在 diverged 一处（NO_LOCAL 那些键本机没有值，不比）。 */
      if (diverged(raw, payload)) return;
      try {
        if (payload == null) await delData(k);
        else await putData(k, payload);
      } catch (e) {
        if (n < RETRY_MAX) {
          queue(raw, payload, n + 1);
        } else {
          /* 重试也用完：把任务**留在队列里**（没有定时器的死信），
             下次开页面（boot 里的 flush）或去设置页点同步时还会再试一次。
             以前这里是直接丢弃 + 一句 Toast，删除类任务一丢就永远丢了 ——
             服务器那份还在，之后每次启动都被它把已删的数据拉回浏览器。 */
          pending.set(k, { t: 0, body: payload, tries: n, failed: e.message, key: raw });
          if (!mirrorBroken) {
            mirrorBroken = true;
            if (window.Toast) window.Toast.warn('本机已保存，但没落到数据文件：' + e.message + '（到「设置 → 数据与同步」重试）');
          }
        }
      }
    }, n ? Math.min(20000, 800 * Math.pow(3, n)) : 800);
    pending.set(k, { t, body: payload, tries: n, key: raw });
  }
  /* 关页面 / 切到后台时把还没发出去的写送出去：
     800ms 合并窗口 + 网络往返经常来不及，「改完就关标签页」那一次修改会丢。
     keepalive 让浏览器在页面卸载后仍把请求发完（单请求上限约 64KB，超了只能尽力而为 ——
     真正的兜底是 boot() 里「本地比服务器新就补传」那段）。 */
  function flushKeepalive() {
    const jobs = [...pending.entries()];
    if (!jobs.length) return;
    for (const [key, job] of jobs) {
      clearTimeout(job.t);
      /* 和 queue 的定时器、flush 一样先过 diverged：boot 对账期间暂存的写补发之后，
         页面经常马上被刷新一次（changed→reload），这条任务很可能已经被服务器那份覆盖，
         不做这一步就会把「拉回真实数据之前那份误写」用 keepalive 送出去，用户数据又被顶掉。 */
      if (diverged(job.key || key, job.body)) continue;
      const url = '/data/' + encodeURIComponent(key);
      const keep = job.body == null || job.body.length < 60000;
      try {
        fetch(url, job.body == null
          ? { method: 'DELETE', keepalive: keep }
          : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: job.body, keepalive: keep });
      } catch {}
    }
    pending.clear();
  }
  window.addEventListener('pagehide', flushKeepalive);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushKeepalive(); });
  /* 从服务器写回本地的值不要再镜像一次：钩子会把刚拉下来的内容又 PUT 回服务器，
     于是「只是拉了一份一样的数据」也把服务器文件的 mtime 顶新 ——
     另一台机器据此以为云端更新，两边的新旧关系被自己搅乱，还会白白多发 N 个请求。 */
  let selfWrite = false;
  function localSet(key, value) {
    selfWrite = true;
    try { localStorage.setItem(key, value); } finally { selfWrite = false; }
  }
  /* 统一钩子：把 localStorage 的写入/删除接到镜像上。
     为什么不在各调用点手动调 mirror：全站有几十处直接 localStorage.setItem（任务提示词记录、
     文字 AI 用量、收藏、设置项…），漏一处那份数据就不会落盘。挂钩子能一次覆盖所有现存与将来的写入。 */
  (function hookStorage() {
    try {
      const proto = window.Storage && window.Storage.prototype;
      if (!proto || proto.__scHooked) return;
      const rawSet = proto.setItem, rawDel = proto.removeItem;
      proto.setItem = function (k, v) {
        rawSet.call(this, k, v);
        try { if (this === localStorage && !selfWrite && syncable(k)) queue(k, String(v)); } catch {}
      };
      proto.removeItem = function (k) {
        rawDel.call(this, k);
        try { if (this === localStorage && syncable(k)) queue(k, null); } catch {}
      };
      proto.__scHooked = true;
    } catch (e) { console.warn('[DataSync] 存储钩子安装失败（数据仍可用，只是不自动落盘）：', e.message); }
  })();
  window.DataSync = {
    /* 本地 → 服务器（突发写合并：同一键 800ms 内只发最后一次） */
    mirror(key, body) {
      if (!syncable(key)) return;
      queue(key, body);
    },
    /* 导演台的工作区存在 IndexedDB（不是 localStorage 键），走同一条发送管道单独镜像 */
    mirrorWs(body) { queue('workspace', body); },
    /* 取服务器上的工作区；比本地新才返回（否则 null，让页面继续用本地的） */
    async workspaceFromServer(localTs) {
      try {
        const r = await window.Net.fetch('/data', { timeout: 10000, retry: 0 });
        if (!r.ok) return null;
        const f = ((await r.json()).files || []).find(x => x.key === 'workspace');
        if (!f || f.mtime <= (Number(localTs) || 0) + TOL) return null;
        const txt = await getData('workspace');
        if (!txt) return null;
        const d = JSON.parse(txt);
        return (d && d.data) ? d.data : null;
      } catch { return null; }
    },
    /* 云端拉取之后必须让 boot() 再跑一次：它按「每页每会话只跑一次」防循环，
       而「从云端下载 → 刷新页面」正是在同一会话里发生的 —— 不清这个标记，
       刚拉下来的数据不会进浏览器（页面看起来像没同步）。 */
    resetBootFlags() {
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith('__synced_')) sessionStorage.removeItem(k);
        }
      } catch {}
    },
    /* 立即把所有待发送的写推上去（设置页/云同步前调用） */
    async flush() {
      const jobs = [...pending.entries()];
      pending.clear();
      let n = 0;
      for (const [key, job] of jobs) {
        if (job.t) clearTimeout(job.t);
        /* 队列里的内容已经不是本机当前值了（期间用户又写过，或者 boot 刚从服务器拉回更新的一份）
           → 这条任务过期，直接丢掉：再发会把较旧的内容盖到较新的上面（云端那份还会被顶掉）。
           判据同样走 diverged（workspace 那类本机没有值的键要放行，见那里的说明）。 */
        if (diverged(job.key || key, job.body)) continue;
        try {
          /* 待删除的键走删除接口：以前只对有值的键 put，删除任务被静默丢弃，
             服务器上的文件还在，下次 boot 会把已经删掉的数据拉回来。 */
          if (job.body == null) { await delData(key); n++; }
          else { await putData(key, job.body); n++; }
        } catch (e) {
          /* 还是没送出去：重新入队（再走一遍退避重试），不要只留一句注释「交给 pushAll」。
             pushAll 只推「本地有值」的键，删除类任务它不会补，于是那条删除永远停在内存里。 */
          queue(key, job.body);
        }
      }
      return n;
    },
    /* 本地已有的可同步键 */
    localKeys() {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (syncable(k)) out.push(k);
        }
      } catch {}
      return out;
    },
    /* 启用功能时的一次性补传：本地有、服务器没有的，全部推上去 */
    async pushAll() {
      const r = await window.Net.fetch('/data', { timeout: 15000, retry: 0 });
      if (!r.ok) throw new Error('读不到数据目录清单（HTTP ' + r.status + '）');
      const files = (await r.json()).files || [];
      let n = 0;
      for (const key of this.localKeys()) {
        const body = window.LS.get(key);
        if (!body) continue;
        const srv = files.find(f => f.key === sanitize(key));
        const localTs = window.Store.tsOf(key);
        if (srv && localTs <= srv.mtime + TOL) continue;        // 服务器不旧 → 不用传
        try { await putData(key, body); n++; } catch (e) { console.warn('[DataSync] 上传 ' + key + ' 失败：', e.message); }
      }
      return n;
    },
    /* 服务器 → 本地，返回被覆盖的键数 */
    async pullAll() {
      const r = await window.Net.fetch('/data', { timeout: 15000, retry: 0 });
      if (!r.ok) throw new Error('读不到数据目录清单（HTTP ' + r.status + '）');
      const files = (await r.json()).files || [];
      let n = 0;
      for (const f of files) {
        const key = f.key;
        if (!syncable(key)) continue;
        const localTs = window.Store.tsOf(key);
        if (localTs && localTs >= f.mtime - TOL) continue;      // 本地不旧 → 不覆盖
        try {
          const txt = await getData(key);
          if (txt == null) continue;
          const cur = localStorage.getItem(key);
          if (cur === txt) continue;                       // 内容一样 → 不用写
          localSet(key, txt);
          n++;
        } catch (e) { console.warn('[DataSync] 拉取 ' + key + ' 失败：', e.message); }
      }
      return n;
    },
    /* 启动时自动对账：服务器有更新就覆盖本地并刷新一次（每页每次会话只刷一次，避免循环） */
    async boot() {
      if (!window.Store.available) return;
      const page = (location.pathname.split('/').pop() || 'director.html');
      const flag = '__synced_' + page;
      try {
        if (sessionStorage.getItem(flag)) return;              // 本次会话已经同步过
        booting = true;                                        // 对账期间本地写入先暂存（见 queue 里的说明）
        const r = await window.Net.fetch('/data', { timeout: 8000, retry: 0 });
        if (!r.ok) return;
        const files = (await r.json()).files || [];
        const byKey = new Map(files.map(f => [f.key, f]));
        const localKeys = this.localKeys();
        if (!files.length && !localKeys.length) return;        // 全新环境，没什么可同步
        let changed = 0, seeded = 0, repaired = 0;
        const byteLen = s => { try { return new TextEncoder().encode(s).length; } catch { return s.length; } };
        /* 遍历「本地 ∪ 数据文件」而不是只遍历本地：
           只遍历本地的话，清掉浏览器数据后（localStorage 为空）反而什么都不会恢复 ——
           而「清缓存后自动恢复」正是这个功能的目的。 */
        for (const key of new Set([...localKeys, ...byKey.keys()])) {
          if (!syncable(key)) continue;                        // 数据文件里还有 workspace 这类非 localStorage 键
          const srv = byKey.get(sanitize(key));
          byKey.delete(sanitize(key));                         // 处理过就出队（下面只按本轮的键判断，不重复处理）
          const localRaw = localStorage.getItem(key);           // 注意：空字符串也算「本地没有」（老数据可能是空值）
          if (!localRaw) {
            /* 本地没有、数据文件里有 → 「浏览器数据被清过 / 换了台机器」：拉回来。
               以前这个情况在下面会命中两处分支：多发一次请求、changed 计数翻倍。 */
            if (!srv) continue;
            try {
              const remoteRaw = await getData(key);
              if (remoteRaw != null && remoteRaw !== '') { localSet(key, remoteRaw); changed++; }
            } catch (e) { console.warn('[DataSync] 恢复 ' + key + ' 失败：', e.message); }
            continue;
          }
          if (!srv) {                                          // 数据文件里没有 → 先把本机已有数据补传上去
            try { await putData(key, localRaw); seeded++; } catch (e) {}
            continue;
          }
          /* 两边都有：先比体积（便宜的启发式），体积相同**不能直接跳过** ——
             等长修改（grid→list、换一个等长的密钥 / 模型名）体积一模一样，
             只看体积的话另一台机器的更新永远拉不回来，两边状态静默分叉。
             体积相同但服务器文件更新时，照样取回来逐字节比对。 */
          const localTs = window.Store.tsOf(key);
          const sameSize = Math.abs(srv.size - byteLen(localRaw)) <= 1;
          /* 本地明确比数据文件新 → 这是**上次没发出去的写**（代理当时没启动 / 关页面时来不及 /
             重试也用完了）。以前这里只是「保留本地的」然后什么都不做，于是 .data/ 永远停在旧内容，
             云同步、换机器、备份拿到的都是那份旧的 —— 现在顺手补传一次。
             （只有带 ts 的信封格式能判出来；纯字符串的值 ts=0，不参与这条，交给写钩子。） */
          if (localTs && localTs > srv.mtime + TOL) {
            try { await putData(key, localRaw); repaired++; } catch (e) {}
            continue;
          }
          if (sameSize && srv.mtime <= localTs + TOL) continue;         // 体积相同且服务器不新 → 不用管
          if (localTs && srv.mtime <= localTs + TOL) continue;          // 本地不旧 → 保留本地的
          let remoteRaw = null;
          try { remoteRaw = await getData(key); } catch (e) { console.warn('[DataSync] 拉取 ' + key + ' 失败：', e.message); continue; }
          if (remoteRaw == null || remoteRaw === localRaw) continue;    // 内容一样 → 不动，也不刷新
          try { localSet(key, remoteRaw); changed++; } catch {}
        }
        /* 上面那些「上次没送出去」的任务（代理当时没启动 / 重试次数用完）在这里补一次。
           flush 会自己判过期，不会把旧内容盖到新内容上。 */
        if (pending.size) { try { await this.flush(); } catch (e) {} }
        sessionStorage.setItem(flag, '1');
        if (changed) {
          /* 这句交给**刷新之后**那份文档去说（`Toast.after`）：600 毫秒之后整页 `location.reload()`，
             当场弹的那一句 —— 无论哪一档 —— 都会被它自己宣布的那次刷新杀掉，
             而这次刷新是页面自己动的，用户没点任何东西，界面上必须留下一句「刚才发生了什么」。 */
          window.Toast.after('刚从本机数据文件同步了 ' + changed + ' 项（页面为此刷新了一次）', 'warn');
          setTimeout(() => location.reload(), 600);
        } else if (repaired) {
          console.log('[DataSync] 补传 ' + repaired + ' 项没落盘的本地修改到 .data/');
        } else if (seeded) {
          console.log('[DataSync] 首次启用：已把 ' + seeded + ' 项本机数据写入 .data/');
        }
      } catch (e) { console.warn('[DataSync] 启动同步跳过：', e.message); }
      finally { booting = false; releaseHeld(); }               // 不管对账成不成功，暂存的本地写入都要补发
    },
    /* ---------- 浏览器持久化存储（方案 B）----------
       让浏览器不因磁盘紧张自动回收 IndexedDB/localStorage（不防用户手动清理）。
       返回 { supported, granted }；设置页会显示状态。 */
    async persist() {
      if (!navigator.storage || !navigator.storage.persist) return { supported: false, granted: false };
      try {
        if (navigator.storage.persisted && await navigator.storage.persisted()) return { supported: true, granted: true };
        const granted = await navigator.storage.persist();
        return { supported: true, granted };
      } catch { return { supported: true, granted: false }; }
    },
    async persistState() {
      if (!navigator.storage || !navigator.storage.persisted) return { supported: false };
      try {
        const granted = await navigator.storage.persisted();
        let usage = null;
        if (navigator.storage.estimate) {
          const e = await navigator.storage.estimate();
          usage = { usedBytes: Number(e.usage || 0), quotaBytes: Number(e.quota || 0) };
        }
        return { supported: true, granted, usage };
      } catch { return { supported: true, granted: false }; }
    },

    /* ---------- 整包备份 / 恢复（方案 C）----------
       把「浏览器里的全部数据」打成一个 JSON：
         · localStorage 里参与同步的业务键（含密钥，导出时会明确提示）
         · IndexedDB：导演台工作区、本地导入的视频、收藏的本地文件、音色复刻的参考音频
       本地文件（Blob）按需打包：只导出数据时跳过，打包文件时转成 base64。
       要带哪几个库来自 Kv 的登记表（backup:true 的那些），这里不再抄一遍库/表名。 */
    get IDB_TARGETS() {
      return Object.entries(window.Kv.TARGETS)
        .filter(([, t]) => t.backup)
        .map(([key, t]) => ({ key, db: t.db, store: t.store, label: t.label }));
    },
    async _idbDump(dbName, storeName, withBlobs) {
      /* 走 Kv（连接按库名复用、缺仓库会补建）。以前这里自己 open(dbName, 1)：
         导演台把库补建到 v2 之后，写死版本 1 会抛 VersionError → 整份库在备份里静默消失。 */
      const rows = await Kv.entries(dbName, storeName).catch(() => []);
      const enc = [];
      for (const [k, v] of rows) {
        if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && typeof v.size === 'number') {
          if (!withBlobs) continue;                                  // 跳过大文件
          try {
            const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(v); });
            enc.push([k, { __blob: true, type: v.type || '', b64 }]);
          } catch (e) { console.warn('[DataSync] 打包文件失败 ' + k + '：', e.message); }
        } else enc.push([k, v]);
      }
      return enc;
    },
    async _idbRestore(dbName, storeName, rows) {
      const list = Array.isArray(rows) ? rows : [];
      /* 开库都失败时，这一张表里的每一条都没写进去 —— 回执必须把这笔账报出来，不能只回 0 条。 */
      if (!await Kv.open(dbName, storeName).catch(() => null)) return { ok: 0, failed: list.length };
      let ok = 0, failed = 0;
      for (const [k, v] of list) {
        let val = v;
        if (v && v.__blob) {
          try {
            val = new Blob([window.b64Bytes(v.b64)], { type: v.type || 'application/octet-stream' });
          } catch { failed++; continue; }
        }
        try {
          await Kv.put(dbName, storeName, k, val);
          ok++;
        } catch (e) { failed++; console.warn('[DataSync] 写入 ' + k + ' 失败：', e.message); }
      }
      return { ok, failed };
    },
    /* 格式闸门：界面在弹确认框之前就调一次（免得让人读完摘要才被拒），写入口自己再调一次。
       只认当前这一版 —— 更高版本的包里字段形状可能已经变了，硬读会把半份数据写进本机。 */
    assertPack(pack) {
      if (!pack || pack.type !== 'ai-workbench-backup') throw new Error('不是本工具导出的备份文件');
      if (pack.version !== PACK_VERSION) {
        throw new Error(pack.version > PACK_VERSION
          ? '这份备份来自更新版本（v' + pack.version + '），请先升级再导入'
          : '这份备份缺少可识别的格式版本');
      }
    },
    /* 导入前的差异摘要（纯读，不写任何东西）。要说清两件容易被误会的事：
       ① 导入是「覆盖备份里有的键」，不在备份里的当前数据不会被删；
       ② 提示词归档同名不覆盖，那几份不会回来。 */
    describePack(pack) {
      const lsKeys = Object.keys(pack.localStorage || {});
      const tables = Object.entries(pack.indexedDB || {});
      const rows = tables.reduce((n, [, list]) => n + (Array.isArray(list) ? list.length : 0), 0);
      const prompts = pack.prompts && Array.isArray(pack.prompts.files) ? pack.prompts.files.length : 0;
      const inPack = new Set(lsKeys);
      let kept = 0;
      for (const k of this.localKeys()) if (!inPack.has(k) && window.LS.get(k) != null) kept++;
      const text = '备份版本 v' + pack.version + '（导出于 ' + String(pack.ts || '未知时间').slice(0, 10) + '）：'
        + '将覆盖本机设置与数据 ' + lsKeys.length + ' 项、本地文件 ' + rows + ' 条（' + tables.length + ' 张表）；'
        + '提示词归档 ' + prompts + ' 份（同名不覆盖）；'
        + '不在备份里的当前数据 ' + kept + ' 项会保留，不会被删。';
      return { ls: lsKeys.length, tables: tables.length, rows, prompts, kept, text };
    },
    /* 导出整包。includeBlobs=false 时只带数据（体积小、够恢复设置与工作区）。
       includePrompts=true 时连提示词归档一起带 —— 归档是磁盘上的一堆 .md，
       既不在 .data/ 也进不了 localStorage/IndexedDB，不显式带就永远带不走。 */
    async exportAll(includeBlobs, includePrompts) {
      const ls = {};
      for (const k of this.localKeys()) {
        const v = window.LS.get(k);
        if (v != null) ls[k] = v;
      }
      const idb = {};
      for (const t of this.IDB_TARGETS) {
        const rows = await this._idbDump(t.db, t.store, includeBlobs);
        if (rows.length) idb[t.db + '/' + t.store] = rows;
      }
      const pack = {
        type: 'ai-workbench-backup', version: PACK_VERSION,
        ts: new Date().toISOString(), includeBlobs: !!includeBlobs,
        localStorage: ls, indexedDB: idb,
      };
      if (includePrompts && window.PromptLog) {
        try {
          const r = await PromptLog.exportAll();
          pack.prompts = { dir: r.dir, total: r.total, skipped: r.skipped || 0, files: r.files || [] };
        } catch (e) {
          /* 归档带不上要说出来，不能悄悄导出一个「少了提示词」的备份还报成功 ——
             那正是用户最需要它的时候。塞进 note，导出后显示。 */
          pack.promptsError = e.message;
        }
      }
      return pack;
    },
    /* 导入整包：localStorage 全量写回，IndexedDB 逐条写回。返回计数。 */
    async importAll(pack) {
      this.assertPack(pack);
      let nLs = 0, nIdb = 0, failed = 0;
      for (const [k, v] of Object.entries(pack.localStorage || {})) {
        try { localStorage.setItem(k, v); nLs++; }
        catch (e) { failed++; console.warn('[DataSync] 恢复 ' + k + ' 失败：', e.message); }
      }
      for (const [path, rows] of Object.entries(pack.indexedDB || {})) {
        const [dbName, storeName] = path.split('/');
        const r = await this._idbRestore(dbName, storeName, rows);
        nIdb += r.ok; failed += r.failed;
      }
      /* 归档恢复走代理写盘（浏览器写不了那个目录）。**一份也不覆盖**同名文件，
         代理那边会返回「本机已有同名」的数量 —— 报出来，让人知道少了几份。 */
      let nPrompt = 0, promptNote = '';
      if (pack.prompts && Array.isArray(pack.prompts.files) && pack.prompts.files.length && window.PromptLog) {
        try {
          const r = await PromptLog.importAll(pack.prompts.files);
          nPrompt = r.restored || 0;
          promptNote = r.message || ('恢复归档 ' + nPrompt + ' 份');
        } catch (e) { promptNote = '归档没恢复成：' + e.message; }
      }
      return { localStorage: nLs, indexedDB: nIdb, prompts: nPrompt, promptNote, failed };
    },
  };
  /* 页面加载后自动对账一次；并顺手申请持久化存储（不需要用户手势）。
     旧键清理**排在 boot 之后**：boot 会拿 `.data/` 里的文件去补 localStorage（清过浏览器数据后靠它恢复），
     先清本地再对账的话，那几份死文件会被「恢复」回来 —— 顺序反了就等于没清。
     `ModelPrefs.migrate()` 排在同一站，道理一模一样：它把旧的 `sk_text_models_<kid>` 并进
     `sk_model_prefs` 然后**把旧键删掉**。放在脚本求值阶段（boot 之前）删的话，正在跑的 boot
     看见「服务器有、本地没有」会把旧键拉回来，紧接着的 flush 又把手里那份 DELETE 送出去 ——
     于是每次开页面都重复一遍「拉回来 / 删掉」，还在 `.data/` 留下一串 `.bak`。 */
  const afterSynced = () => {
    try { if (window.ModelPrefs) window.ModelPrefs.migrate(); } catch (e) {}
    return migrateRenamedKeys().then(sweepLegacyKeys, sweepLegacyKeys).then(sweepLegacyDbs, sweepLegacyDbs);
  };
  const afterBoot = () => { window.DataSync.boot().then(afterSynced, afterSynced); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', afterBoot);
  else afterBoot();
  setTimeout(() => { try { window.DataSync.persist(); } catch {} }, 1500);
})();
