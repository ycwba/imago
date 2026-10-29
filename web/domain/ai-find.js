/* AiFind — 「写一句话，让文字 AI 在本机这一堆里挑几条」整链（那颗按钮 / 闸门 / JSON 契约 / 记账 / 清原话）。
   四个入口（素材库、收藏、资产库、统一资源选择器）共用这一份：名字、忙话、说明句、失败回执都只在这一处，
   入口只接自己的行为 —— 同一件事在各处叫不同名字，用户按上一处记住的名字就找不到下一颗按钮。
   从 web/domain/assetlib.js 拆出；只依赖 window.TextAI / Toast 这些公开面。 */
window.AiFind = {
  WHY_MAX: 40,       // 芯片那一行只放得下这么长一句理由（`AiChip.picked` 的前半截是「AI 挑的 N 条」）
  LABEL: 'AI 搜索',
  TITLE: '按搜索框里写的描述，让 AI 筛出最合适的几条',
  BUSY: 'AI 搜索中…',
  /** 那颗按钮唯一的一副画法：外壳与**搜索组件**同一副（`.fb-ai`，与输入框同高、同方角、无图标），
   *  忙 / 闲只换 `.tx` 那一行字（`data-idle` / `data-busy` 跟着节点走，`aiBtnState` 照旧切得动）。
   *  id 只给「画完还要现取节点接自己行为」的那两处（资产库与统一资源选择器）；素材库 / 收藏 /
   *  工作台把它作为 extraHTML 交给公共工具条，再按 .fb-ai 取回。 */
  btnHTML(id) {
    return '<button class="fb-ai" type="button"'
      + (id ? ' id="' + window.esc(id) + '"' : '')
      + ' title="' + window.esc(AiFind.TITLE) + '"'
      + ' data-idle="' + window.esc(AiFind.LABEL) + '" data-busy="' + window.esc(AiFind.BUSY) + '">'
      + '<span class="tx">' + window.esc(AiFind.LABEL) + '</span></button>';
  },
  /** 失败回执那一句只在这一处拼（「AI 搜索失败：<原因>」）。 */
  failText(e) { return AiFind.LABEL + '失败：' + errText(e); },
  /** 闸门上那句「先写字再点」（四个入口共用一句，入口名就是 LABEL）。
   *  不设字数下限：一个字的说法也直接问模型；只有框里**什么都没写**才拦一下。 */
  needMsg() { return '先在搜索框里写要找什么，再点「' + AiFind.LABEL + '」'; },
  /** 闸门现算：字不够就返回那句话，够就返回空串（调用方 `if (why) { 就地写出去; return; }`）。
   *  为什么单独露出来：`run` 之外还有两处「产出的是筛选条件、不是挑选集合」的入口
   *  （资产库与统一选择器），它们不走 `run`，可那个 2 与那句话必须还是同一份 ——
   *  页面写一遍 `q.length < 2` 就是把字数与话各存了一份，改公共层的字数时它不会跟着改口。 */
  shortWhy(q) {
    return String(q || '').trim() ? '' : AiFind.needMsg();
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
  /** o = { btn, ask, focus, roster, payload, field, known, sys, reg,
   *        emptyMsg, noneMsg, apply, onPick, done, say } → `{ picked, state, msg }`
   *  `apply` 只写那三个字段（`clear` 也走它，所以把「放开类型档」这类页面副作用放这儿，
   *  清一下芯片就会顺手把人挑过的档位改掉）；挑中之后要改的那些走 `onPick`。 */
  async run(o) {
    const oo = o || {};
    let msg = '', st = AiFind.state([]);
    const q = String((oo.ask ? oo.ask() : '') || '').trim();
    const roster = (oo.roster ? oo.roster() : []) || [];
    const btn = typeof oo.btn === 'function' ? oo.btn() : oo.btn;
    const gate = AiFind.shortWhy(q);
    if (gate) {
      msg = gate;
      if (oo.focus) oo.focus();
    } else if (!roster.length) {
      msg = oo.emptyMsg || '这里还没有可挑的素材';
    } else {
      window.aiBtnState(btn, true);
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
        msg = AiFind.failText(e);
      } finally {
        window.aiBtnState(btn, false);
      }
    }
    /* 先等页面把列表重画完再写回执：素材库 / 收藏的 render 是异步的，
       重画尾部会用「N 项」覆盖刚写下的那句 —— 失败 / 没挑到时看起来就像「点了没反应」。 */
    if (oo.done) { try { await oo.done(); } catch (e) { /* 重画失败不影响这句回执 */ } }
    if (msg && oo.say) oo.say(msg);
    return { picked: !!st.pick, state: st, msg };
  },
};
