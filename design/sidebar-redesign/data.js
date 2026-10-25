/* ============================================================================
   内容层 —— 稿子的数据。
   数字优先取 real.js（真机现读的数，跑 dump-real.cjs 生成）；没有 real.js 时
   退回这里的示例值。带「示例」标记的那几处是稿子自己编的 —— 落地时由侧栏自己取。
   ========================================================================== */
(function () {
  const R = window.__REAL || {};
  const num = (v, ex) => (typeof v === 'number' && isFinite(v)) ? v : ex;

  /* 图标几何照抄产品 web/ui/ui.js 的 ICONS（落地时直接用产品的 icon()，不另抄一份） */
  const ICONS = {
    film: '<rect x="1.9" y="3" width="12.2" height="10" rx="1.5"/><path d="M4.7 3v10M11.3 3v10M1.9 8h12.2"/>',
    users: '<circle cx="6.1" cy="5.5" r="2.4"/><path d="M2.2 13.1c0-2.2 1.8-3.7 3.9-3.7s3.9 1.5 3.9 3.7"/><path d="M10.6 3.4a2.3 2.3 0 0 1 0 4.3"/><path d="M11.7 9.8c1.6.5 2.7 1.8 2.7 3.3"/>',
    sparkles: '<path d="M6.3 2.2l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z"/><path d="M11.8 8.6l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z"/>',
    star: '<path d="M8 2.6l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5z"/>',
    box: '<path d="M8 2l5.5 3v6L8 14l-5.5-3V5z"/><path d="M2.5 5L8 8l5.5-3M8 8v6"/>',
    chart: '<path d="M2.6 13.4V2.6M2.6 13.4h10.8"/><path d="M5.6 11V7.4M8.2 11V4.8M10.8 11V8.8"/>',
    gear: '<circle cx="8" cy="8" r="2.1"/><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1"/>',
    moon: '<path d="M13 9.6A5.2 5.2 0 0 1 6.4 3 5.4 5.4 0 1 0 13 9.6z"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"/>',
    coin: '<circle cx="8" cy="8" r="5.4"/><path d="M10 6.2c-.4-.7-1.1-1-2-1-1.1 0-1.9.5-1.9 1.3 0 .9.8 1.2 1.9 1.4 1.2.2 2 .6 2 1.5s-.9 1.4-2 1.4c-1 0-1.7-.4-2.1-1.1M8 3.8v8.4"/>',
    download: '<path d="M8 2.6v7.4M5.2 7.2L8 10l2.8-2.8M3.4 12.6h9.2"/>',
  };

  const shots = num(R.shots, 6);
  const scenes = num(R.scenes, 4);
  const projects = num(R.projects, 2);
  const chars = num(R.chars, 2);
  const platforms = num(R.platforms, 4);
  const favs = num(R.favs, 1);
  const assets = num(R.assets, 362);
  const calls = num(R.calls, 287);
  const byType = R.assetsByType || { '图片': 254, '视频': 75, '音频': 33 };

  window.SB_DATA = {
    real: !!window.__REAL,
    realTs: R.ts || '',

    brand: { name: 'AI 创作工作台', sub: '本地优先 · 数据留在本机' },

    /* 三档宽度。名字照「侧栏是干什么的」取，不照像素取 ——
       轨 = 只剩图标的一条轨；列 = 有名字的一列；架 = 摆得开的架子。 */
    modes: [
      { id: 'rail', w: 60, name: '轨', hint: '只留图标 · 悬停出预告卡' },
      { id: 'column', w: 196, name: '列', hint: '有名字 · 余额收成一行' },
      { id: 'shelf', w: 256, name: '架', hint: '全开 · 分组 + 余额明细' },
    ],

    /* 导航项。count 是「这一项现在是什么」—— 右侧那一列值速记。 */
    nav: [
      { id: 'director', label: '导演台', ic: 'film', active: true,
        count: scenes + ' 场', sub: '按场次排的镜头台',
        meta: projects + ' 个项目 · ' + scenes + ' 场 · ' + shots + ' 个镜头' },
      { id: 'chars', label: '素材库', ic: 'users',
        count: String(chars), sub: '角色、形象与配音',
        meta: chars + ' 个角色' },
      { id: 'studio', label: '生成工作台', ic: 'sparkles',
        count: String(platforms), sub: '图片 · 视频 · 音频 · 文字',
        meta: platforms + ' 个平台已接入密钥' },
      { id: 'favorites', label: '我的收藏', ic: 'star',
        count: String(favs), sub: '存下来的产物',
        meta: favs + ' 条' },
      { id: 'assets', label: '资产库', ic: 'box',
        count: String(assets), sub: '落在本机的产物',
        meta: assets + ' 份 · 图片 ' + (byType['图片'] || 0) + ' · 视频 ' + (byType['视频'] || 0) + ' · 音频 ' + (byType['音频'] || 0) },
      { id: 'usage', label: '用量与余额', ic: 'chart',
        count: calls + ' 次', sub: '花了多少 · 还剩多少',
        meta: '本月 ' + calls + ' 次调用' },
    ],

    /* 余额区。**名字、金额、单位都是真机的** ——
       跑 dump-real.cjs 时让真机外壳自己去问各平台，再从画好的卡上读回来。
       第三行是**一条真实失败**（OpenRouter 的账号查不到），照样摆出来：
       失败也是产品要回答的一件事，不是稿子要藏起来的东西。 */
    balance: (() => {
      const real = Array.isArray(R.balances) && R.balances.length ? R.balances : null;
      const rows = real ? real.map(r => ({
        name: r.name, avail: r.failed ? '—' : r.avail, unit: r.unit || '',
        frozen: r.frozen || '', failed: !!r.failed, why: r.why || '',
      })) : [
        { name: 'SparkCine', avail: '1,204.6', unit: 'credits', frozen: '12.0', failed: false, why: '' },
        { name: 'VGENV', avail: '38.00', unit: 'credits', frozen: '2.0', failed: false, why: '' },
        { name: 'OpenRouter', avail: '$18.40', unit: '', frozen: '$2.10', failed: false, why: '' },
      ];
      return {
        real: !!real,
        count: rows.length,
        rows,
      };
    })(),

    /* 本机落盘进度（示例）。 */
    mirror: { title: '产物正在存进本机', done: 3, total: 5 },

    /* 底部两块 */
    foot: [
      { id: 'settings', label: '设置', ic: 'gear', sub: '供应商 · 存储 · 助手', meta: '15 项设置' },
      { id: 'theme', label: '换背景', ic: 'moon', sub: '亮色 / 暗色', meta: '当前：浅色' },
    ],

    ICONS,
  };
})();
