/* 宽松 JSON 解析 —— 全站唯一一份（页面与导演台都从这里取）。
   AI 回的东西里常带 ```json 围栏、前后解释、或把结果包在一段话中间；
   这一段就是把这些都剥掉、取出「跨度最长的那个对象 / 数组」再去 JSON.parse。

   它不做「修半个 JSON」那种事：流式预览的逐步解析在 web/model3d/ai.js 里另有一套
   （按括号配平抓已完整的节点），两者职责不同，不要合并。 */

/* 宽松 JSON 解析：兼容 ```json 围栏、前后废话、单引号 */
export function parseJsonLoose(txt) {
  if (!txt) return null;
  let raw = String(txt).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) raw = fence[1].trim();
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  let v = tryParse(raw);
  if (v) return v;
  // 夹杂说明文字时：取「跨度最长」的候选（对象里的空数组不能当结果）
  const cands = [];
  for (const re of [/\[[\s\S]*\]/, /\{[\s\S]*\}/]) {
    const m = re.exec(raw);
    if (m) cands.push(m[0]);
  }
  cands.sort((a, b) => b.length - a.length);
  for (const c of cands) { v = tryParse(c); if (v) return v; }
  return null;
}
