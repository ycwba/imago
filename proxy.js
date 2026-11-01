/* 薄入口：真正的本地代理在 server/app.js（路由拆分进行中）。 */
/* 线程池大小只在进程第一次用到池子之前可改，所以这两行必须排在 require 之前。
   这个进程里走池子的不只是 fs（余量、对账、静态读盘），还有静态文本的 brotli / gzip：
   开机预热一口气压上百份时，4 条线程会把首屏那几份排在后面（实测 12 份串着压要 740ms）。
   8 条是「压得动、又不跟媒体流抢成一团」的档；显式给过就听显式那份。 */
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8';
/* 启动耗时埋点的原点在 require 之前 —— 「双击到服务答话」里 require 链自己也是一段。 */
globalThis.__bootT0 = performance.now();
require('./server/app.js');
