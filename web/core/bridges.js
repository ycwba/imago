/* 页面写入桥：导演台 / 建模台这类命令式编辑器把「只读快照 + 校验 + 执行」注册在这里。
   从前是一个专用全局（`window.__directorActions`），每加一个页面就多一个；现在只有这一个
   命名空间，桥的名字就是路由 id（`director` / `model3d`）。安装返回一个卸载函数，页面销毁时自己摘掉。 */
(function () {
  'use strict';
  const B = window.WBBridge = window.WBBridge || {};
  B.install = function (name, api) {
    if (!name) throw new Error('bridge name required');
    const prev = B[name] || null;
    B[name] = api || null;
    return function () { if (B[name] === api) B[name] = prev; };
  };
  B.get = function (name) {
    const api = B[name];
    return api && typeof api === 'object' ? api : null;
  };
})();
