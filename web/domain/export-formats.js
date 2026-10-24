/* 导演台导出格式：一张表管到底。
   页头按钮（engine 现画现绑）、export_start 的校验 / 分派 / 文案、助手 export_start 的
   schema enum 与动作说明，全部从这一份派生。加一种导出 = 表里加一行（kind 是已有那三种之一）
   + engine 里接一个 builder；模板按钮、接线、校验、文案不再各改一处。
   放在 domain 而不是 director：助手（web/features/chat.js）也要读同一份，而它是经典脚本，
   按需加载时只能拿 window 面（加载点见 web/boot-assistant.js 与 web/director/index.js）。
   kind：film=整片合成；xml=交换文件（bundle 再带媒体包，
   nle 生成持久工程并送到剪映 / 达芬奇）。 */
(function () {
  'use strict';
  const FORMATS = [
    { id: 'film', button: 'exportFilm', kind: 'film', label: '导出成片', icon: 'download',
      renders: true, cancelable: true, cancelLabel: '取消渲染',
      title: '按当前时间线合并已选用镜头，存到「设置 → 剪辑成片」目录；导出中再点 = 取消',
      assistant: '合成成片（在这个浏览器里逐帧编码）',
      doc: '合成成片（浏览器内合成，进度能查、能取消）',
      startNote: '已在页面里开始合成；进度用 export_status 查，取消用 export_cancel' },
    { id: 'fcpxml', button: 'exportFcp', kind: 'xml', label: '导出 FCPXML', icon: 'film',
      title: '把当前时间线导出成 Final Cut Pro / 达芬奇可导入的 FCPXML：保留镜头顺序、入出点、倍速与配音位置；本机没有落盘的素材会在文件开头列出来',
      assistant: '导出 FCPXML（当前字幕一起写入）',
      doc: '导出交换文件（**当前字幕自动一起写入**，没有单独开关）',
      startNote: '正在导出 FCPXML（字幕随导出一起写入）' },
    { id: 'bundle', button: 'exportFcpBundle', kind: 'xml', label: '导出媒体包', icon: 'film',
      bundle: true,
      title: '导出 FCPXML + 素材的 zip（project.fcpxml + media/）：换一台机器也能直接导入，不用重新链接；取不到的素材写进 missing.txt',
      assistant: '导出 FCPXML 媒体包（含字幕 subtitles.srt）',
      doc: 'FCPXML 媒体包（另带 subtitles.srt）',
      startNote: '正在导出 FCPXML 媒体包（字幕随导出一起写入）' },
    { id: 'resolve', button: 'exportResolve', kind: 'xml', nle: true, label: '导出到达芬奇', icon: 'film',
      title: '生成一份持久工程（project.fcpxml + media/ + subtitles.srt），尽量启动达芬奇 Resolve 并打开工程目录；最后一步在软件里点一次导入',
      assistant: '生成达芬奇 Resolve 的导入工程（启动软件 + 打开目录，不替你在软件里点导入）',
      doc: '导出到达芬奇（生成可导入工程；启动 Resolve + 打开目录）',
      startNote: '正在生成达芬奇 Resolve 的导入工程' },
    { id: 'jianying', button: 'exportJianying', kind: 'xml', nle: true, label: '导出到剪映', icon: 'film',
      title: '生成一份剪映专业版草稿（draft_content.json + media/），尽量启动剪映并打开草稿目录；最后一步在软件里点一次导入',
      assistant: '生成剪映专业版草稿（启动软件 + 打开草稿目录，不替你在软件里点导入）',
      doc: '导出到剪映（生成剪映草稿；启动剪映 + 打开草稿目录）',
      startNote: '正在生成剪映专业版草稿' },
  ];
  const byId = {};
  FORMATS.forEach(f => { byId[f.id] = f; });
  const ids = FORMATS.map(f => f.id);
  window.ExportFormats = {
    list: () => FORMATS.slice(),
    ids: () => ids.slice(),
    of: id => byId[id] || null,
    hint: () => ids.join(' / '),
  };
})();
