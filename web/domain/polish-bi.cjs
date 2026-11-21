/* 润色双稿 —— 「主稿 + 对照稿」的切分器（全站只有这一份）。
 *
 * 为什么单独一个文件：这条约定同时被两个运行环境用 ——
 *   · 浏览器（润色链路把流式回包按标记切两段：主稿上屏，对照稿进参照块）
 *   · Node（tests/polish-bi.mjs 直接 require 做单元判据）
 * 两边各写一份切分迟早漂。没有构建步骤，所以写成双模式（与 ident.cjs / asset-ref.cjs
 * 同一套 .cjs + UMD 写法）：浏览器当普通 <script> 引（挂 window.PolishBi），Node 侧 require。
 *
 * 约定（与各润色 Skill 正文的「输出」段一致，正文真相在 skills 目录的 SKILL.md）：
 *   主稿结束后单独一行写【对照稿】（就这四个字加全角括号），随后是对照稿正文。
 *   找不到标记 / 主稿为空 / 中途停止 → 整份当主稿（单稿回退）：
 *   单稿 Skill（纯朗读稿）与旧版正文不需要任何改动就继续按一份稿走。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.PolishBi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MARK = '【对照稿】';

  /* 完整文本切分：标记前是主稿，标记后是对照稿。
     只在「标记存在且主稿非空」时才算双稿 —— 模型把标记写歪（写在开头）也退回单稿，
     面板与存盘按一份稿走，行为与单稿版完全一致。 */
  function splitAtMark(full) {
    const s = String(full == null ? '' : full);
    const i = s.indexOf(MARK);
    if (i < 0) return { main: s.trim(), ref: '' };
    const main = s.slice(0, i).trim();
    if (!main) return { main: s.trim(), ref: '' };
    return { main, ref: s.slice(i + MARK.length).trim() };
  }

  /* 流式切分：只把主稿那一段推给面板，标记（以及它的半截尾巴）不上屏。
     feed(piece, kind)：reasoning（模型草稿）原样直通；正文累计后把安全区的增量推给 push ——
     没见到整枚标记时，只在「尾巴恰好是标记的前缀」时扣住那几个字，防止标记被两个
     片段劈开后漏出半截上屏；普通正文照常全推。见到整枚标记就停推，并调一次 onRef()
     （调用方拿它提示「对照稿生成中…」）；对照稿阶段一个字都不进面板。
     result(finalText)：收尾切分。finalText 是 chatStream 的正规回包（有的家只给整包
     不给流），有就用它，没有用累计的那份。中途停止时也照此切 —— 主稿已出的部分就是主稿。 */
  function stream(push, onRef) {
    let full = '', sent = 0, told = false, done = false;
    const emitUpTo = n => { if (n > sent) { push(full.slice(sent, n), 'content'); sent = n; } };
    const feedPiece = (piece, kind) => {
      if (kind === 'reasoning') { if (!done && piece) push(piece, kind); return; }
      if (!piece) return;
      full += piece;                     // 对照稿阶段照常累计：result() 还要从这里切
      if (done) return;
      const i = full.indexOf(MARK);
      if (i >= 0) {
        done = true;
        emitUpTo(i);
        if (!told) { told = true; if (onRef) { try { onRef(); } catch (e) { /* 提示语不成功不影响收稿 */ } } }
        return;
      }
      let hold = 0;
      for (let n = Math.min(MARK.length - 1, full.length); n > 0; n--) {
        if (full.endsWith(MARK.slice(0, n))) { hold = n; break; }
      }
      emitUpTo(full.length - hold);
    };
    const result = finalText => {
      const src = (finalText == null || finalText === '') ? full : String(finalText);
      return splitAtMark(src);
    };
    return { feed: feedPiece, result };
  }

  return { MARK, split: splitAtMark, stream };
});
