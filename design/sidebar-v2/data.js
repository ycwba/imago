/* ============================================================================
   内容层 —— 左栏（两形态版）
   ---------------------------------------------------------------------------
   数字取自 real.js（真机现读的数，跑 dump-real.cjs 那套流程生成）；没有就退回示例值。
   导航项**不显示任何行内数值**（那是上一稿的「值速记」，这一稿去掉了）。
   ========================================================================== */
(function () {
  const R = window.__REAL || {};
  const num = (v, ex) => (typeof v === 'number' && isFinite(v)) ? v : ex;

  /* 图标几何照抄产品 web/ui/ui.js 的 ICONS（落地时直接用产品的 icon()） */
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
    /* 收 / 展：不是箭头，是「侧栏本体」—— 一个方框 + 左边那道分栏线。
       箭头只说方向；这一枚说的是「这一条栏」。两个形态用同一枚。
       （产品 ICONS 里现成的是 panelRight，落地时要往那一份里加一枚 panelLeft。） */
    panelLeft: '<rect x="2.2" y="3" width="11.6" height="10" rx="1.5"/><path d="M6.4 3v10" stroke-width="2.2"/>',
  };

  /* 余额：名字 / 金额 / 单位都是真机的（第三行是一条真实失败，照实摆出来） */
  const balances = (() => {
    const real = Array.isArray(R.balances) && R.balances.length ? R.balances : null;
    const rows = real ? real.map(r => ({
      name: r.name, avail: r.failed ? '—' : r.avail, unit: r.unit || '',
      frozen: r.frozen || '', failed: !!r.failed, why: r.why || '',
    })) : [
      { name: 'SparkCine', avail: '784', unit: '积分', frozen: '0', failed: false, why: '' },
      { name: 'VGENV', avail: '¥43.75', unit: '', frozen: '¥0.00', failed: false, why: '' },
      { name: 'OpenRouter', avail: '—', unit: '', frozen: '', failed: true, why: '查询失败：User not found' },
    ];
    return { real: !!real, count: rows.length, rows };
  })();

  window.SB2 = {
    real: !!window.__REAL,
    realTs: R.ts || '',

    brand: { name: 'AI 创作工作台', sub: '本地优先 · 数据留在本机' },

    /* 两个形态：满（232px，把内容读全）/ 窄（56px，只剩图标 + 两字短标签） */
    forms: [
      { id: 'full', w: 232, name: '满', hint: '232px · 名字 + 余额明细' },
      { id: 'slim', w: 56, name: '窄', hint: '56px · 图标 + 两字短标签' },
    ],

    /* 导航六项。short 是窄形态下压在图标下面的两字短标签 ——
       窄形态**也要认得出**，所以不靠悬停才能知道这一项是什么。 */
    nav: [
      { id: 'director', label: '导演台', short: '导演', ic: 'film', active: true, sub: '按场次排的镜头台' },
      { id: 'chars', label: '素材库', short: '素材', ic: 'users', sub: '角色、形象与配音' },
      { id: 'studio', label: '生成工作台', short: '生成', ic: 'sparkles', sub: '图片 · 视频 · 音频 · 文字' },
      { id: 'favorites', label: '我的收藏', short: '收藏', ic: 'star', sub: '存下来的产物' },
      { id: 'assets', label: '资产库', short: '资产', ic: 'box', sub: '落在本机的产物' },
      { id: 'usage', label: '用量与余额', short: '用量', ic: 'chart', sub: '花了多少 · 还剩多少' },
    ],

    /* 底部两块 */
    foot: [
      { id: 'settings', label: '设置', ic: 'gear' },
      { id: 'theme', label: '换背景', ic: 'moon' },
    ],

    balance: balances,
    mirror: { done: num(R.balances ? 3 : 3, 3), total: 5 },

    ICONS,
  };
})();
