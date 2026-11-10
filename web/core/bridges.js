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
  /* 能力声明与运行时桥是同一座桥的两半：install 挂「现在真的能不能做」（ready/check/run），
     declare 挂「这一页给助手哪些工具」的纯数据声明（查询 / 动作 / 路由 / 裁剪档 / 参数形状）。
     声明在页面模块求值时登记，助手的目录由它现拼 —— 新增一页的能力只改那一页的声明，
     不改助手代码。声明不依赖页面是否在前台：工具按 route 过滤，轮到那一页时模块早已求值。 */
  const DECL = Object.create(null);
  B.declare = function (name, decl) {
    if (!name) throw new Error('bridge name required');
    if (!decl || typeof decl !== 'object') throw new Error('bridge declaration required');
    DECL[name] = decl;
  };
  B.declarations = function () {
    return Object.keys(DECL).map(name => ({ name, decl: DECL[name] }));
  };
})();
