/* 平台自带的提示词工具（声明驱动，当前只有拾帧的「H3 官方规范优化」）。
   平台自己有比文字模型更懂它自家规范的改写接口时，注册表在 provider 上声明
   `promptTools: { optimize: { endpoint, poll, taskKinds } }`，页面就能就地调用：
   · declOf(prov)                        声明在不在（endpoints 里真的有那个名）
   · taskKindOf(prov, modelId)            这一个型号的 task_kind（没映射 = 这一家不接它）
   · optimize(prov, {prompt, model, duration}) → { en, zh, skill, mode }
   全部走 Api.request（同源 relay、密钥注入、幂等键进体），页面不碰地址与密钥。 */
(function () {
  'use strict';
  const waitMs = ms => new Promise(r => setTimeout(r, ms));

  function declOf(prov) {
    const o = prov && prov.promptTools && prov.promptTools.optimize;
    if (!o || !(prov.endpoints && prov.endpoints[o.endpoint])) return null;
    return o;
  }
  function taskKindOf(prov, modelId) {
    const o = declOf(prov);
    return (o && o.taskKinds && o.taskKinds[modelId]) || '';
  }

  /* 一轮规范优化：建单（平台不扣钱）→ 按 retry_after_seconds 轮询 → 取稿。
     幂等键由 Api.request 按 create.idempotencyBody 自动写进请求体：
     断线后用同一个键再发，平台重放上一次的结果，不会写两份扣两次。 */
  async function optimize(prov, p = {}) {
    const o = declOf(prov);
    if (!o) throw new Error('这家没有声明提示词优化（promptTools.optimize）');
    const kind = taskKindOf(prov, p.model);
    if (!kind) throw new Error('这个型号没有对应的优化档（task_kind 没映射）');
    const prompt = String(p.prompt || '').trim();
    if (!prompt) throw new Error('先写几个字再优化');
    const body = { operation: 'generate_script', mode: 'prompt_optimize', prompt,
      task_kind: kind, display_language: 'zh', async: true };
    const dur = Number(p.duration);
    if (dur > 0) body.duration_seconds = Math.round(dur * 100) / 100;
    let d = await window.Api.request(prov, o.endpoint, { method: 'POST', body, log: false });
    /* 幂等重放可能直接回完整稿（没有轮询号）：那种一次都不用轮 */
    const got = j => !!j && (j.status === 'succeeded' || !!(j.draft && (j.draft.prompt || j.draft.text)));
    const LIMIT = 60;                              // 5 秒一档 × 60 = 5 分钟封顶
    for (let tries = 0; !got(d); tries++) {
      const id = d && (d.task_id || d.id);
      if (!id) throw new Error('平台没给轮询号，优化没跑成：' + window.errText(d && d.error, '原因没说'));
      if (d.status === 'failed') throw new Error('平台没写成这一稿（不扣钱）：'
        + window.errText(d && d.error, '原因没说，稍后再试'));
      if (tries >= LIMIT) throw new Error('平台写了 5 分钟还没写完，先放弃，稍后再试');
      await waitMs(Math.max(2000, Number(d.retry_after_seconds) * 1000 || 5000));
      d = await window.Api.request(prov, o.poll || o.endpoint, { id, log: false });
    }
    const draft = d.draft || {};
    const en = String(d.draft_en || draft.prompt || draft.text || '').trim();
    const zh = String(d.draft_text || '').trim();
    if (!en) throw new Error('平台没回英文稿，这一轮白跑（不扣钱）');
    return { en, zh, skill: (draft.skill && draft.skill.name) || '', mode: d.mode || kind };
  }

  window.PromptTools = { declOf, taskKindOf, optimize };
})();
