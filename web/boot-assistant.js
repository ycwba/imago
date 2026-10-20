/* 空闲时补上 AI 助手那一层（悬浮球 / 抽屉 / 任务看护），只在外壳加载一次。 */
(function () {
  'use strict';
  /* 助手关着就不下载那一份（报告 §6.2「首屏」）：chat.js 自己在装之前也判同一条键，
     但那道闸在文件里面 —— 关着的人依旧白下一次 389KB 并求值一遍。判据只有一条，
     就是 chat.js 的 K_OFF：默认开（键不在 = 开着），只有明确存了 '1' 才算关。
     这一项是本机这一扇窗口的事，不跟着云同步（见 datasync.js 的 NOT_SYNC），所以直接读 localStorage。
     行为没有变：以前关着时也只是「下载了但 early return，球不画」，现在连下载都省了；
     在设置页把助手重新打开，两种写法都要刷新一次才出球。 */
  var chatOff = false;
  try { chatOff = localStorage.getItem('ai_chat_off') === '1'; } catch (e) { /* 无痕 / 禁存储时读不到偏好：当作没关，照常加载助手 */ }
  var files = ['web/ui/workbench.js', 'web/domain/chars.js', 'web/domain/export-formats.js'];
  /* 工具循环与动作目录单独一份（报告 §6.1-2）：chat.js 求值时就要用它组装 window.AiChat，
     所以排前面。两份都只在助手开着时下载。 */
  if (!chatOff) files.push('web/features/chat-tools.js', 'web/features/chat.js');
  var tests = { 'web/ui/workbench.js': 'Wb', 'web/domain/chars.js': 'Chars',
    'web/domain/export-formats.js': 'ExportFormats', 'web/features/chat-tools.js': 'AiChatTools',
    'web/features/chat.js': 'AiChat' };
  var started = false;
  function load() {
    if (started) return;
    started = true;
    /* 一份一份装是既有行为：这层在空闲时段，不在首屏；chat.js 求值时要读 Wb / Chars /
       ExportFormats，排最后保证它起跑时前三份已在。 */
    files.reduce(function (p, f) {
      return p.then(function () {
        return window.__spaLoadScript(f, function () { return window[tests[f]]; }).catch(function () {});
      });
    }, Promise.resolve());
  }
  if (window.requestIdleCallback) window.requestIdleCallback(load, { timeout: 1200 });
  else setTimeout(load, 400);
})();
