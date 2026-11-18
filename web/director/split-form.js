/* 「拆分镜」那一档的文案闸门（纯函数，页面与判据共用这一份）。
   「接着往下拆」**只挡空**：以前它和「拆一份新的」共用一条 20 字下限，
   「再加一个特写」这种短要求根本发不出去。
   「改现有分镜」那一档用「修改要求」那一格，不走这道闸。 */
export function splitScriptGate(task, script) {
  if (task === 'edit') return '';
  if (!(script || '').trim()) return '要接着拆的文案不能为空';
  return '';
}
