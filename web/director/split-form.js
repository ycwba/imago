/* 「拆分镜」那一档的文案闸门（纯函数，页面与判据共用这一份）。
   统一格式之后只剩一个输入格：新剧情 / 续写 / 修改要求都从这一格走，
   所以只挡空 —— 短要求（例：再加一个特写）也是有效要求。 */
export function splitScriptGate(script) {
  if (!(script || '').trim()) return '要拆的文案不能为空';
  return '';
}
