/* 建模台的跨页门面（经典脚本，挂 `window.Model3D`）。
   工作台 / 导演台 / 素材选择器只需要「写一句话带过去」「把刚出的白膜送回来」这两件事，
   不该为了它们把 2.5 MB 的 three 拖进那几页 —— 所以这一层只有几十行，重活都在按需 import 里。

   交接用一枚一次性口袋（`model3d_handoff`，走 Store 信封）：
   · 口袋里有 `to`（`model` / `studio` / `director`）与 `at`（写入口袋的时刻）；
   · 目标页启动时调 `consume('目标')`，对得上才取走并**当场清空**；
   · 超过 10 分钟的口袋作废 —— 用户关掉页面第二天再进来，不该被昨天的提示词偷袭。

   口袋不进云同步（`DataSync` 的 NOT_SYNC 点名了它）：这是同一台机器上两个页面之间递的东西。 */
(function () {
  'use strict';
  var KEY = 'model3d_handoff';
  var TTL = 10 * 60 * 1000;

  function read() {
    try { return window.Store ? window.Store.read(KEY, null) : null; } catch (e) { return null; }
  }
  function write(v) {
    try { if (window.Store) window.Store.write(KEY, v, { label: '白膜交接' }); } catch (e) { /* 存不进去就当这次没交接 */ }
  }

  window.Model3D = {
    /* 把东西交给某个页面：`payload` 里放 `{ prompt }` 或 `{ asset }` */
    handoffTo: function (to, payload) {
      var box = Object.assign({ to: String(to || ''), at: Date.now() }, payload || {});
      write(box);
      return box;
    },
    /* 取走属于本页的那一份（取完就清）；不是给这一页的、或过期了，返回 null */
    consume: function (to) {
      var box = read();
      if (!box || box.to !== to) return null;
      if (!box.at || Date.now() - box.at > TTL) { write(null); return null; }
      write(null);
      return box;
    },
    /* 快速白膜弹窗（素材选择器与工作台那几颗按钮用）：按需把 ESM 拉进来 */
    quick: function (opts) {
      return import('./quick.js').then(function (m) { return m.open(opts || {}); });
    },
    /* 给素材选择器判断「这一页/这一次要不要显示 3D 白膜入口」用：有模型才值得给 */
    hasModels: function () {
      return import('./vault.js')
        .then(function (m) { return m.list(); })
        .then(function (d) { return !!(d && d.models && d.models.length); })
        .catch(function () { return false; });
    },
  };
})();
