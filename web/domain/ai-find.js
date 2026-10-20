/* AiFind — 「写一句话，让文字 AI 在本机这一堆里挑几条」整链（闸门 / JSON 契约 / 记账 / 清原话）。
   从 web/domain/assetlib.js 拆出；只依赖 window.TextAI / Toast 这些公开面。 */
window.AiFind = {
  MIN_Q: 2,          // 少于这个字数，模型拿到的是一句没法理解的「需求」
  WHY_MAX: 40,       // 芯片那一行只放得下这么长一句理由（`AiChip.picked` 的前半截是「AI 挑的 N 条」）
  /** 闸门上那句「先写字再点」—— 三页（素材库 / 收藏 / 资产库的 AI 检索）共用这一句，只换入口名 */
  needMsg(label) { return '先在搜索框里写要找什么（至少两个字），再点「' + String(label || 'AI 找素材') + '」'; },
  /** 闸门现算：字不够就返回那句话，够就返回空串（调用方 `if (why) { 就地写出去; return; }`）。
   *  为什么单独露出来：`run` 之外还有两处「产出的是筛选条件、不是挑选集合」的 AI 检索
   *  （资产库与统一选择器），它们不走 `run`，可那个 2 与那句话必须还是同一份 ——
   *  页面写一遍 `q.length < 2` 就是把字数与话各存了一份，改公共层的字数时它不会跟着改口。 */
  shortWhy(q, label) {
    return String(q || '').trim().length < AiFind.MIN_Q ? AiFind.needMsg(label) : '';
  },
  /** AI 报回来的那一串号：先丢掉重复的，再丢掉本机不认识的。
   *  重复必须在这儿丢：`rank` 是 `Map`，同一个号出现两次会**取最后一次**的名次，
   *  而芯片按 `Set` 数出「N 条」—— 排序与读数于是各说一遍。 */
  idsOf(raw, known) {
    const out = [], seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach(x => {
      if (seen.has(x)) return;
      seen.add(x);
      if (!known || known(x)) out.push(x);
    });
    return out;
  },
  /** 那三个字段一次给全：挑中了才有集合与名次，没挑中就是三个空值（清空 = 调它，别再手写一遍 `= null`）。
   *  以前「清掉 AI 条件」那处只清了两个、名次还挂着 —— 集合没了而整列仍按 AI 那句已作废的话排序。 */
  state(ids, why) {
    const list = Array.isArray(ids) ? ids : [];
    return list.length
      ? { pick: new Set(list), rank: new Map(list.map((k, i) => [k, i])), why: String(why || '').slice(0, AiFind.WHY_MAX) }
      : { pick: null, rank: null, why: '' };
  },
  /** 清掉这一页的 AI 条件：三个字段一起收回，再让页面重画一次（名次不收，顺序还挂在废话上）。 */
  clear(o) {
    const oo = o || {}, st = AiFind.state([]);
    if (oo.apply) oo.apply(st);
    if (oo.done) oo.done();
    return st;
  },
  /** o = { label, btn, ask, focus, roster, payload, field, known, sys, reg,
   *        emptyMsg, noneMsg, busyText, apply, onPick, done, say } → `{ picked, state, msg }`
   *  `apply` 只写那三个字段（`clear` 也走它，所以把「放开类型档」这类页面副作用放这儿，
   *  清一下芯片就会顺手把人挑过的档位改掉）；挑中之后要改的那些走 `onPick`。 */
  async run(o) {
    const oo = o || {};
    const lab = oo.label || 'AI 找素材';
    let msg = '', st = AiFind.state([]);
    const q = String((oo.ask ? oo.ask() : '') || '').trim();
    const roster = (oo.roster ? oo.roster() : []) || [];
    const btn = typeof oo.btn === 'function' ? oo.btn() : oo.btn;
    const was = btn ? btn.innerHTML : '';
    const gate = AiFind.shortWhy(q, lab);
    if (gate) {
      msg = gate;
      if (oo.focus) oo.focus();
    } else if (!roster.length) {
      msg = oo.emptyMsg || ('这里还没有可挑的素材，先放几条进来再点「' + lab + '」');
    } else {
      if (btn) { btn.disabled = true; btn.textContent = oo.busyText || 'AI 正在挑…'; }
      try {
        const reg = oo.reg || await Api.registry();
        const txt = await TextAI.chat(reg, oo.sys, JSON.stringify(oo.payload(q, roster)));
        const j = TextAI.parseJson(txt) || {};
        const ids = AiFind.idsOf(j[oo.field], oo.known);
        st = AiFind.state(ids, j.summary);
        /* 挑没挑中都交回页面：没挑中时上一次的「AI 挑的那批」必须收回 ——
           挂着的话，芯片还在说 AI 的话而这一轮它其实什么都没选。 */
        if (oo.apply) oo.apply(st);
        /* 搜索框里的原话已经翻译成号了：必须清掉，否则整句还会再 AND 过滤一遍（整句几乎不可能是
           某条备注的子串 —— 结果永远 0 条）。类型档同理：AI 挑的是跨档的一批，档还锁着就看不见。 */
        if (ids.length) { if (oo.onPick) oo.onPick(); }
        else msg = oo.noneMsg || ('AI 没挑到合适的（换个说法再试）');
      } catch (e) {
        /* 失败**不**交回 `apply`：这一页上一次的挑选还有效，别因为这一次问坏了就替人清掉。 */
        msg = 'AI 找素材失败：' + errText(e);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = was; }
      }
    }
    if (oo.done) oo.done();
    if (msg && oo.say) oo.say(msg);
    return { picked: !!st.pick, state: st, msg };
  },
};
