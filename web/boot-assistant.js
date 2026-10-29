/* 空闲时补上 AI 助手那一层（悬浮球 / 抽屉 / 任务看护），只在外壳加载一次。 */
(function () {
  'use strict';
  /* 助手关着就不下载那一份：chat.js 自己在装之前也判同一条键，
     但那道闸在文件里面 —— 关着的人依旧白下一次 389KB 并求值一遍。判据只有一条，
     就是 chat.js 的 K_OFF：默认开（键不在 = 开着），只有明确存了 '1' 才算关。
     这一项是本机这一扇窗口的事，不跟着云同步（见 datasync.js 的 NOT_SYNC），所以直接读 localStorage。
     行为没有变：以前关着时也只是「下载了但 early return，球不画」，现在连下载都省了；
     在设置页把助手重新打开，两种写法都要刷新一次才出球。 */
  var chatOff = false;
  try { chatOff = localStorage.getItem('ai_chat_off') === '1'; } catch (e) { /* 无痕 / 禁存储时读不到偏好：当作没关，照常加载助手 */ }
  var files = ['web/ui/workbench.js', 'web/domain/chars.js', 'web/domain/export-formats.js'];
  /* 工具循环与动作目录单独一份：chat.js 求值时就要用它组装 window.AiChat。
     两份都只在助手开着时下载。 */
  if (!chatOff) files.push('web/features/chat-tools.js');
  var tests = { 'web/ui/workbench.js': 'Wb', 'web/domain/chars.js': 'Chars',
    'web/domain/export-formats.js': 'ExportFormats', 'web/features/chat-tools.js': 'AiChatTools',
    'web/features/chat.js': 'AiChat' };
  var started = false;
  function one(f) {
    return window.__spaLoadScript(f, function () { return window[tests[f]]; }).catch(function () {});
  }
  function load() {
    if (started) return;
    started = true;
    /* 路由级按需的那几份（capabilities / text-ai / asset-picker / datasync）在这一趟一并补齐：
       助手在任何一页都可能用到它们，而这一页未必声明了欠哪几份。名单**从路由表现取**
       （WB_ROUTES.needAll），不在这里抄第二份；认全局那一步也只有 routes.js 的 NEED_GLOBAL 一处。
       并发取（__spaNeeds 内部 Promise.all），与下面那一批互不排队。 */
    window.__spaNeeds(window.WB_ROUTES && window.WB_ROUTES.needAll).catch(function () {});
    /* 上面那句不带 catch 的时候，四份 needs 里任意一份失败就是一条 unhandled rejection
       （而且失败的那份脚本会被永久记住 —— 路由表那边已改成「失败不缓存」）。
       助手的取数本来就各自带兜底，这里吞掉的只是「补载没成」这个事实本身。 */
    /* 这几份互不依赖（各自往 window 上挂自己那一面），一起取 —— 以前逐份串着等，
       四趟往返叠在空闲窗里，助手球要晚几百毫秒才出来。chat.js 单独排最后：
       它求值时要读 Wb / Chars / ExportFormats，也要用到 chat-tools 的目录。 */
    Promise.all(files.map(one)).then(function () {
      if (!chatOff) one('web/features/chat.js');
    });
  }
  if (window.requestIdleCallback) window.requestIdleCallback(load, { timeout: 1200 });
  else setTimeout(load, 400);
})();
