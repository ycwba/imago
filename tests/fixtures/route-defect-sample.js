/* tests/fixtures/route-defect-sample.js —— 故意写坏的「样品路由」，只给 routes-smoke 的自检用。
   它模拟 pick-dir / relay 那两类真实坏法：
     · handleUndeclared：函数体里用了一个没解构、也没声明的变量（真跑时 ReferenceError）
     · handleMissingKey：读了注入点没给的 ctx key（Proxy 当场抛「没注入」）
   自检要求这两条都必须红 —— 判据不能是「永远绿」。这个文件不是运行时代码，别 require 它。 */
'use strict';

function createDefectSample(ctx) {
  const { log } = ctx;
  return {
    handleUndeclared(req, res) {
      log('sample');
      // 这一句里的 madeUpVariable 既没在参数里、也没在 ctx 解构里、也没声明 —— 就是 pick-dir 的坏法
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ v: madeUpVariableNotDeclared() }));
      return true;
    },
    handleMissingKey(req, res, c) {
      // 注入点只给了 log，这里要读 notInjected —— Proxy 必须抛「路由要的 ctx.notInjected 没注入」
      c.notInjected();
      res.writeHead(200);
      res.end('{}');
      return true;
    },
  };
}

module.exports = { createDefectSample };
