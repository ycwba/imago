/* 发送前预览：这一镜**将要发出**的请求体（纯算，一个网络请求都不发）。
   从 web/director/engine.js 拆出；纯算法在这里，engine 只调用。

   为什么单独一个模块：这个模块回答的是「如果现在按生成，会发出什么」，
   它的判据（素材槽位怎么数、占位符怎么写、型号怎么取）与「真的发出去」那条链
   （engine 的 submitCandidate + shotInputEntries）**必须一致**，但两者有一处本质不同：
   真发会**把要上传的图传到平台**（那一步有副作用、要花时间、占平台配额），
   预览绝不能触发它 —— 所以这里用占位符交出同一个形状。

   与 Api.preview 的关系：请求体的拼装完全交给 Api.buildBody（与 create 同源），
   这里只负责「这一镜手上有什么素材、每个槽位会交成什么形状」这一段。 */

export function createBoardPreview(ctx) {
  const { nameKey, shotKeyframes, Api, ROLE_ZH } = ctx;

  /* 一个槽位在预览里交成什么：`assetId`（要上传的槽位）与 `url`（直接交地址的槽位）。
     `needsUpload` 的那份在真发时会变成平台资产号，预览里换成一句占位说明。 */
  const slotEntry = (role, name, prov, tpl, src) => {
    if (!tpl) return null;
    if (tpl.needsUpload) {
      /* 预览里不传字节：交一句占位说明。真发时这一格是平台给的资产号。 */
      return { role, placeholder: '<待上传：' + name + '>' };
    }
    /* 不需要上传的槽位：交的是地址。本机资产号（/asset/xxx）在真发时会被转存，
       预览里直接写本机地址会让用户以为平台收得下 —— 所以标一句「会先转存」。 */
    const s = String(src || '');
    if (!s) return null;
    return { role, url: s.indexOf('/asset/') === 0 ? ('<本机资产，发送时先转存：' + s + '>') : s };
  };

  /* 这一镜手上的素材 → 预览用的 inputEntries（**不上传**）。
     与 `shotInputEntries` 同一份口径：首帧 / 尾帧 / 关键帧 / 参考图 / 参考视频 / 参考音频，
     同样按型号声明的 maxRef 截断、同样按 inputTemplates 决定交 url 还是交资产号。 */
  function entriesPlan(sh, prov, ic) {
    const out = [];
    const tplOf = r => (Api && Api.inputTemplate) ? Api.inputTemplate(prov, r) : null;
    const maxRef = Math.max(1, (ic && ic.maxRef) || 1);
    let refN = 0;
    const pushRef = (name, src) => {
      if (refN >= maxRef) return;               // 超出上限的那些不画（真发时也一样不带）
      const t = tplOf('reference_image');
      const e = slotEntry('reference_image', name, prov, t, src);
      if (e) { out.push(e); refN++; }
    };
    /* 首帧 / 尾帧：接续镜的首帧要等上一镜跑完才知道，预览里只标「接上一镜尾帧」。 */
    const firstSrc = sh.firstFrame || '';
    const frames = [['first_frame', firstSrc, '首帧'], ['last_frame', sh.lastFrame, '尾帧']].filter(x => x[1]);
    frames.forEach(([role, src, name]) => {
      const e = slotEntry(role, name, prov, tplOf(role), src);
      if (e) out.push(e);
    });
    (shotKeyframes(sh) || []).forEach(k => pushRef('画面切片', k.assetId ? ('/asset/' + k.assetId) : ''));
    (sh.refImages || []).forEach(() => pushRef('参考图', ''));
    /* 参考视频 / 参考音频：与真发同一份角色名（registry 的 inputTemplates）。 */
    if (ic && ic.refVideo && sh.refVideo) {
      const e = slotEntry('reference_video', '参考视频', prov, tplOf('reference_video'), sh.refVideo.src || '');
      if (e) out.push(e);
    }
    if (ic && ic.refAudio && sh.refAudio) {
      const e = slotEntry('reference_audio', '参考音频', prov, tplOf('reference_audio'), sh.refAudio.src || '');
      if (e) out.push(e);
    }
    return out;
  }

  /* 这一镜将要发出的请求体（压成可展示形状）。
     `fields` 由 engine 备好（提示词、型号、档位、时长、画幅、参考语法转换后的正文…）。
     算不出来就**抛**（engine 把原因显示出来），不返回空 JSON —— 空 JSON 会被读成
     「这次没有请求体」，那是骗人。 */
  function shotPreview(sh, prov, fields, ic) {
    const body = Api.createBody(prov, Object.assign({}, fields, {
      inputEntries: entriesPlan(sh, prov, ic),
    }));
    return Api.snapOf(body);
  }

  return { entriesPlan, shotPreview };
}
