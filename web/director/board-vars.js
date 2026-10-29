/* 导演台的「项目引用规则」：**Skill 正文里的变量占位符**该填什么。
   从 web/director/engine.js 拆出；纯算法在这里，engine 只调用。

   一份 Skill 的正文里可以写占位符（`{what}` `{cast}` `{board}` …），
   程序在发请求前把**这个项目里的实际内容**填进去 —— 这就是「项目引用规则」：
   **Skill 写变量，程序按项目填料**。

   与 `@素材` 的引用**是两件事**：
     · `@小雅` 是**提示词正文里**的引用（要挂参考图，提交前会换成 `@参考图N`）；
     · `{cast}` 是**给 AI 的上下文里**的占位符（这一段的角色名单长什么样，填进去）。
   两者不互相替代：素材清单进正文要写成 `@名字`（那是给生成模型的引用），
   进 Skill 上下文要写成 `{cast}`（那是给写稿的 AI 看的名单）。

   变量表只有这一份：拆分镜 / 改分镜 / 新素材判定三处共用 ——
   三处各写一份就意味着「这一处认 {cast} 那一处不认」，用户改了 Skill 却只有一半生效。 */

export function createBoardVars(ctx) {
  const { nameKey } = ctx;

  /* 素材库里的角色表（`{cast}`）：名字 + 外貌 + 音色描述 ——
     AI 要的是「这一位长什么样、声音什么样」才能把人物前后写一致。
     场景与物品也列上（它们同样是「这一镜里会反复出现的主体」），只是不写音色。 */
  function castOf(entries) {
    const out = [];
    (entries || []).forEach(x => {
      if (!x) return;
      const nm = String(x.name || '').trim();
      if (!nm) return;
      const kind = ctx.kindZhOf ? ctx.kindZhOf(x) : '';
      const look = String(x.look || x.desc || x.bio || '').trim();
      const voice = String(x.voiceNote || '').trim();
      const bits = [];
      if (kind) bits.push(kind);
      if (look) bits.push(look);
      if (voice) bits.push('音色：' + voice);
      out.push('- ' + nm + (bits.length ? '（' + bits.join(' · ') + '）' : ''));
    });
    return out.join('\n');
  }

  /* 这一次选中的素材清单（`{assets}`）：名字 + 完整描述（比 `{cast}` 长 ——
     这一份是「AI 要参考着写」的那一份，描述要全）。 */
  function assetsOf(entries, descOf) {
    const out = [];
    (entries || []).forEach(x => {
      if (!x) return;
      const nm = String(x.name || '').trim();
      if (!nm) return;
      const d = String((descOf ? descOf(x) : (x.look || x.desc || x.bio)) || '').trim();
      out.push('- @' + nm + (d ? '：' + d : ''));
    });
    return out.join('\n');
  }

  /* 这一份变量表（给一次拆分镜 / 改分镜 / 新素材判定用）。
     每个键都可能缺（那一段就留空 → 变量原样留着，AI 自己补）。 */
  function vars(o) {
    const x = o || {};
    return {
      what: x.what || '',
      cast: x.cast || '',
      assets: x.assets || '',
      board: x.board || '',
      dur: x.dur || '',
      title: x.title || '',
    };
  }

  return { castOf, assetsOf, vars };
}