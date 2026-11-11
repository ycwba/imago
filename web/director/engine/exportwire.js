/* 导演台导出按钮 / 轨道坞 / 灯箱的接线域：页头那颗导出拆分按钮按格式表现画现绑
   （加一种导出不再动模板）、导入媒体文件的选择器、轨道坞的上下把手（公共件 Wb.split）、
   以及灯箱声明的取地址口径。区间内的代码由 engine.js 逐字搬出；
   document / window 用参数名遮蔽全局。 */


export function createExportWire(E, document, window) {
  'use strict';
  const {
    $,
    Export,
    ExportFormats,
    importMediaFile,
  } = E;

/* 页头那一排导出按钮由格式表现画现绑（web/domain/export-formats.js）：加一种导出不再动模板与这一排。
   绑定也只有这一处：剪辑栏每 3 秒随整列重建，把出口绑在那里等于每次重建都要重绑，
   导出中写在按钮上的那句「取消渲染 45%」会被下一次重画冲掉。
   **「播放成片」那一颗已删**：看效果走剪辑态那条轨的实时预览（`#pbBtn` → Play），
   它从不为播放合成；要一个文件才点这里的「导出成片」。 */
/* 每个 kind 给一个「返回点击处理器」的工厂：film 直接交现成函数，
   xml 按这一行是裸 FCPXML、媒体包 zip 还是持久工程目录现包一个（三档同一份拼装器）。 */
const EXPORT_RUN = {
  film: () => Export.filmClick,
  xml: f => f.project ? () => Export.project()
    : () => Export.fcp({ bundle: !!f.bundle }),
};
/* 页头导出区只有一颗**拆分按钮**：主钮「导出成片」（表里第一行），尾部 chevron 的浮层里
   收其余去向（FCPXML / 媒体包 / 工程目录）—— 同一份时间线不用平铺四颗按钮。 */
const expFirst = ExportFormats.list()[0];
$('exportBtns').innerHTML = '<span class="exp-split">'
  + '<button type="button" class="pri" id="' + expFirst.button + '" title="' + esc(expFirst.title) + '">'
  + icon(expFirst.icon, 13) + ' ' + esc(expFirst.label) + '</button>'
  + '<button type="button" class="pri exp-more" id="exportMore" title="其它导出方式">'
  + icon('chevronDown', 12) + '</button>'
  + '<span class="exp-menu" id="exportMenu" hidden></span></span>';
$('exportMenu').innerHTML = ExportFormats.list().slice(1).map(f =>
  '<button type="button" id="' + f.button + '" title="' + esc(f.title) + '">'
  + esc(f.label) + '</button>').join('');
ExportFormats.list().forEach(f => {
  const b = $(f.button);
  if (b) b.onclick = EXPORT_RUN[f.kind](f);
});
{
  const menu = $('exportMenu');
  const more = $('exportMore');
  const dismissMenu = () => { menu.hidden = true; };
  more.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  menu.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.closest('button')) dismissMenu();
  });
  document.addEventListener('click', dismissMenu);
}
$('importMediaFile').onchange = e => {
  const f = e.target && e.target.files && e.target.files[0];
  if (e.target) e.target.value = '';       // 同一份文件再选一次也要能触发 change
  if (f) importMediaFile(f);
};
/* 轨道坞的高度：走**公共件 Wb.split 的上下轴**（与左右栏同一套把手 —— 同样的外观、
   悬停光标、双击复位、落盘口径），不再手写第二套指针拖动。
   拖动改的是 --dock-h（落在 .page-main 上）：坞高**就是那个数**（flex-basis），
   上面三栏被顶矮 —— 这就是「像左右栏一样能移并且影响布局」的那一条。
   ⚠ 变量名必须是 'dock-h'：Wb.split 写的是 '--' + varName，写成 dock_h 会落到 --dock_h 上，
   而 CSS 读的是 --dock-h —— 两边对不上号时把手看着能拖、坞却纹丝不动（存的值还越拖越偏）。
   旧键 dir_dock_h 是那套手写把手留下的（一个裸数字），那份是真生效过的，迁移期读出来按同样意思用一次就清掉；
   同一份记录里的 dock_h 一并作废：那是写错变量名那版存下来的死值，从来没生效过 ——
   用户没见过的尺寸不算偏好，留着会在修好之后突然把坞顶高一截。 */
{
  const old = Number(window.LS.get('dir_dock_h')) || 0;
  const rec = (function () { const r = window.LS.json('dir_dock', null); return (r && typeof r === 'object') ? r : {}; })();
  delete rec.dock_h;                       // 写错变量名那版留下的死值：作废
  if (old >= 120) rec['dock-h'] = old;     // 手写把手那版是真生效过的，搬过来
  try { window.LS.set('dir_dock', JSON.stringify(rec)); } catch (e) { /* 写不进去就用默认值 */ }
  window.LS.del('dir_dock_h');
  Wb.split.enable({
    box: '.page-main', axis: 'y', key: 'dir_dock',
    cols: [{ el: '#tlBoard' }],
    /* 下限放到 48：允许一路拖到底、把轨道整块「盖住」（只剩一条抓手），
       想看回来再往上拖 —— 用户点名的「轨道栏应该能拖到最底下」。 */
    handles: [{ left: 0, right: 0, resize: 0, varName: 'dock-h', min: 48, max: 720 }],
  });
}

/* ---------- 灯箱：DOM 与翻页/键盘/关闭/信息条全在 Wb.lightbox，页面只声明怎么取地址 ---------- */
Wb.lightbox.init({
  /* 本页没有列表视图：翻页范围由打开灯箱那一次自己带（`Wb.lightbox.open(item, pages)`）。 */
  list: () => [],
  keyOf: it => (it && it.src) || '',
  srcOf: it => (it && it.src) || '',
  kindOf: it => (it && it.video ? 'video' : 'image'),
  /* 下载名按 kindOf 给扩展名：本批 viewShotMedia 把首帧 / 尾帧 / 画面 / 参考图也点亮了灯箱
     （全是图片）—— 以前恒给 .mp4，图片存下来叫「参考图 1.mp4」。 */
  nameOf: it => window.fileSafe((it && it.label) || 'merged', 60) + ((it && it.video) ? '.mp4' : '.png'),
  info: it => [(it && it.label) || ''],
});

  return {
  };
}
