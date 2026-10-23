/* 文件名片段清洗（Node 侧唯一一份）。浏览器那一份在 `web/ui/ui.js` 的 `fileSafe`，同一算法、
   两边各自可用 —— 这是 AGENTS §7 登记在案的「浏览器与 Node 各一份」例外：Node 里没有 window，
   代理与 tools/*.cjs 都读这一份，不许再抄第三份。
   规则：Windows 最严那一套（\ / : * ? " < > | 加控制字符）一律换成 -，空白压成一个空格，
   首尾的点 / 空格 / - 去掉（尾随一个点会让资源管理器拒绝打开），最后按 max 截断。 */
'use strict';

function fileSafe(s, max) {
  const out = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 60);
  return out.replace(/^[.\s-]+|[.\s-]+$/g, '');
}

module.exports = { fileSafe };
