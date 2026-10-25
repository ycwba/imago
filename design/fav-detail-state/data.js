/* 收藏页设计稿的内容层。
   ── 前 15 条是**真机取出来的**（`design/favorites-layout/dump-data.cjs` 读过真机 .data/）：
      名字 / 大小 / 格式 / 日期 / 类型 / 缩略图都是真值，来源见那份稿子的 DESIGN.md §6。
   ── 后 2 条是**稿子专用的演示条目**（真机上没有这两个状态）：
      一条「只剩外链」（签名过期、这次没换回来），一条「本地上传的文件」。
      备注文案也都是稿子专用的（真机那批收藏基本没写备注）。
   字节归属：local = 字节在本机；cloud = 只在平台上；stale = 只剩外链且外链已过期；
             upload = 本地上传的文件（字节在浏览器里）。 */
window.FAV_ITEMS = [
  {
    key: 'la:la_mvm5arxotol0', title: '深夜雨幕中的便利店门口空景_潮湿窄街被雨',
    type: '图片', format: 'PNG', size: '2.2 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arxotol0.jpg',
    note: '开场镜头的暖调参考', credits: null, taskId: '', assetId: 'la_mvm5arxotol0',
  },
  {
    key: 'la:la_mvm5arxgpu6y', title: '深夜雨夜中便利店门口的窄街空景_无人物_',
    type: '图片', format: 'PNG', size: '2.4 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arxgpu6y.jpg',
    note: '便利店雨街的霓虹底子，要的那种湿漉漉的反射', credits: null, taskId: '', assetId: 'la_mvm5arxgpu6y',
  },
  {
    key: 'la:la_mvm5arxc26dp', title: '深夜空无一人的便利店门口雨街_落地玻璃窗',
    type: '图片', format: 'PNG', size: '2.4 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arxc26dp.jpg',
    note: '女主的过场：站在走廊尽头，灯只亮一半', credits: null, taskId: '', assetId: 'la_mvm5arxc26dp',
  },
  {
    key: 'la:la_mvm5arwujwwb', title: '深夜暴雨的旧城巷口_瘦高个28岁的外卖员',
    type: '图片', format: 'PNG', size: '2.9 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arwujwwb.jpg',
    note: '开场镜头的暖调参考', credits: null, taskId: '', assetId: 'la_mvm5arwujwwb',
  },
  {
    key: 'la:la_mvm5arwqdg6s', title: '深夜旧城巷口暴雨巷道_暴雨如帘倾泻_路面',
    type: '图片', format: 'PNG', size: '2.5 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arwqdg6s.jpg',
    note: '便利店雨街的霓虹底子，要的那种湿漉漉的反射', credits: null, taskId: '', assetId: 'la_mvm5arwqdg6s',
  },
  {
    key: 'la:la_mvm5arx7dgzn', title: '深夜空无一人的便利店门口雨街_落地玻璃窗-3',
    type: '图片', format: 'PNG', size: '2.4 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arx7dgzn.jpg',
    note: '女主的过场：站在走廊尽头，灯只亮一半', credits: null, taskId: '', assetId: 'la_mvm5arx7dgzn',
  },
  {
    key: 'la:la_mvm5arphfl3x', title: '一只白猫坐在窗台上看雨_写实摄影',
    type: '图片', format: 'PNG', size: '2.1 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arphfl3x.jpg',
    note: '开场镜头的暖调参考', credits: null, taskId: '', assetId: 'la_mvm5arphfl3x',
  },
  {
    key: 'la:la_mvm5arpda39t', title: '一只白猫坐在窗台上看雨_写实摄影-4',
    type: '图片', format: 'PNG', size: '2.3 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arpda39t.jpg',
    note: '便利店雨街的霓虹底子，要的那种湿漉漉的反射', credits: null, taskId: '', assetId: 'la_mvm5arpda39t',
  },
  {
    key: 'la:la_mvm5arxu980h', title: '狭窄旧书店空场景_无人物_深夜静谧_高至',
    type: '图片', format: 'PNG', size: '2.1 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: 'assets/la_mvm5arxu980h.jpg',
    note: '', credits: null, taskId: '', assetId: 'la_mvm5arxu980h',
  },
  {
    key: 'la:la_mvm5as3daurf', title: '15秒竖幅916_夜晚暴雨中的回字形老-10',
    type: '视频', format: 'MP4', size: '2.7 MB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: '', duration: 15,
    note: '片尾镜头，节奏要慢，最后停在招牌上', credits: null, taskId: 'task_5ee21a08', assetId: 'la_mvm5as3daurf',
  },
  {
    key: 'la:la_mvm5as8tcq2a', title: 'vlc-record-2025-06-03-12h34m18s-梦想启动-',
    type: '音频', format: 'OGG', size: '686 KB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: '', duration: 96,
    note: '片头环境音，凌晨的街道', credits: null, taskId: '', assetId: 'la_mvm5as8tcq2a',
  },
  {
    key: 'la:la_mvm5as8q76st', title: 'narrator-候选1-kz44',
    type: '音频', format: 'WAV', size: '165 KB', date: '2026-10-21',
    provider: '本机', model: '', state: 'local', thumb: '', duration: 12,
    note: '片头环境音，凌晨的街道', credits: null, taskId: '', assetId: 'la_mvm5as8q76st',
  },
  {
    key: 'a:sparkcine:e3b8c852-8acf-40d9-b05b-26b3d347de83', title: '一只白猫趴在窗台上，暖色灯光',
    type: '图片', format: 'PNG', size: '—', date: '2026-09-30',
    provider: 'SparkCine', model: 'img-2-5t', state: 'cloud', thumb: 'assets/cloud_e3b8c852-8acf-40d9-b05b-26b3d347de83.jpg',
    note: '', credits: null, taskId: 'task_6c10f2a9', assetId: 'e3b8c852-8acf-40d9-b05b-26b3d347de83',
  },
  {
    key: 'a:sparkcine:981b9773-4b38-4d4d-b4e7-16970fac513c', title: '一只白猫坐在窗边',
    type: '图片', format: 'PNG', size: '—', date: '2026-09-29',
    provider: 'SparkCine', model: 'img-2-5s', state: 'cloud', thumb: 'assets/cloud_981b9773-4b38-4d4d-b4e7-16970fac513c.jpg',
    note: '', credits: 2, taskId: 'task_44b7de71', assetId: '981b9773-4b38-4d4d-b4e7-16970fac513c',
  },
  {
    key: 'a:sparkcine:d13f6cd2-5151-4947-aeef-595de570c70c', title: '一只花猫趴在书上',
    type: '图片', format: 'PNG', size: '—', date: '2026-09-29',
    provider: 'SparkCine', model: 'img-2-5s', state: 'cloud', thumb: 'assets/cloud_d13f6cd2-5151-4947-aeef-595de570c70c.jpg',
    note: '', credits: 1, taskId: 'task_2d77ab30', assetId: 'd13f6cd2-5151-4947-aeef-595de570c70c',
  },

  /* ── 稿子专用的两条（真机上没有这两个状态） ── */
  {
    key: 'a:sparkcine:7f0c51aa-0c3e-4a2f-9b44-1d0f5a2e8c11', title: '雨夜便利店的霓虹反光_竖构图_无人物',
    type: '图片', format: 'PNG', size: '—', date: '2026-09-28',
    provider: 'SparkCine', model: 'img-2-5t', state: 'stale', thumb: '',
    note: '第 9 集要用的那条竖图', credits: 2, taskId: 'task_9ab3e6d2', assetId: '7f0c51aa-0c3e-4a2f-9b44-1d0f5a2e8c11',
    staleWhy: '签名外链已过期，这次回源没换回来（平台那边已经查不到这条产物）',
  },
  {
    key: 'l:f7a2k91x', title: '分镜表_第二幕.txt',
    type: '文件', format: 'TXT', size: '4 KB', date: '2026-10-22',
    provider: '本地上传', model: '', state: 'upload', thumb: '', duration: null,
    note: '第二幕的镜头顺序，和场景号对一下', credits: null, taskId: '', assetId: '',
  },
];
