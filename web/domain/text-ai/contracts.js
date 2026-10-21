/* 机器契约：Skill 只能补充“怎么写”，不能覆盖这些输出格式 / 禁止项。
   调用点传入 contract key；PromptLog 记录 skill/contract 版本。 */
export const CONTRACTS = {
  'polish.video': '只输出润色后的视频提示词本身。不要解释、不要引号、不要 markdown、不要给多个方案。保留用户的主体、动作、场景与 @参考图N 标记；不编造品牌、台词或数字。',
  'polish.image': '只输出润色后的图片提示词本身。不要解释、不要标题、不要 markdown、不要多个方案。保留 @参考图N 标记；不编造品牌与人名；一次只选一种视觉语言。',
  'polish.voice': '只输出改写后的口播稿本身。不要解释。数字、百分比、英文缩写写成中文读法；保留原意与信息量。',
  'polish.follow': '只输出改完之后的整稿本身。只改用户点名的那一处，其余原样保留；不要解释改了什么，不要给多个方案。',
  'story.json': '只返回 JSON：{"frames":[{"t":0,"prompt":"..."}]}。不要解释、不要 markdown 代码块。',
  'split.json': '只返回 JSON：{"title":"...","scenes":[{"name":"...","shots":[{"prompt":"...","duration":5,"name":"...","note":"...","line":"...","speaker":"..."}]}]}。不要解释、不要 markdown 代码块。',
  'board_edit.json': '只返回 JSON 改动清单；按既有分镜序号定位，不重新编号，不返回完整分镜。',
  'img_split.json': '只返回 JSON 拆分方案；不要解释、不要 markdown 代码块。',
  'char.image.json': '只返回 JSON：{"prompt":"..."}；不要解释。',
  'char.voice.json': '只返回 JSON：{"roles":[{"name":"…","way":"preset|design|clone","voice":"…","note":"…"}]}；音色只能取清单里真有的 id。',
};

export function contractFor(key) {
  return CONTRACTS[key] || '';
}
export function contractKeys() {
  return Object.keys(CONTRACTS);
}
