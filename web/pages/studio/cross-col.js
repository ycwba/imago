/* 视频栏 ⇄ 图像栏的两条「送过去」。
   载荷只在页面里拼，不新造写入格式：提示词把三处一起写（textarea 节点 + 该型草稿 + 盘上那份），
   素材落进槽位的唯一出口仍是 refIntoSlot（拖放那一路走 AssetRef，两条不许各长一份）。
   参考图必须在切栏**之前**抓住：切过去之后 inputs() 问的就是图像栏那一份了。 */
export function createCrossCol(d) {
  const {
    $, type, st, setType, inputs, slotDef, slots, slotItems, slotRoom,
    blockedSlotKinds, slotTakesType, clearSlot, fitComboFor, setCombo,
    bestRefModel, refIntoSlot, renderInputArea, updateMode, updateGoState,
    paintToVideoBtn, confirm, toast, setStatus, writeLS, cur, provGroups,
  } = d;

  /* 当前这一栏有没有「参考图」这一格；被组合藏掉时先按声明切回来。 */
  function openImageSlot() {
    if (slots().some(x => x.kind === 'image')) return;
    const fit = fitComboFor([slotDef.image.role]);
    if (fit && fit.id !== cur().combo) setCombo(fit.id);
  }
  const roomNow = k => { const x = slots().find(s => s.kind === k); return x ? slotRoom(x) : 0; };

  /* 视频栏 → 图像栏：提示词与参考图一起搬。
     卡在「放不下 / 被互斥挡住 / 型号不收」时先问一句，不静默改用户选好的型号，
     也不假装放成功了 —— 与反方向那一份同一套判据。 */
  async function promptIntoImage() {
    const text = ($('prompt').value || '').trim();
    if (text.length < 2) { toast.warn('先写一段提示词'); return; }
    const carried = (inputs().image || []).slice();
    /* 要保护的是「即将被写进去的那一栏」—— 每型各存一份草稿，读的始终是图像栏那一份。 */
    const draft = (st.image.prompt || '').trim();
    if (draft && draft !== text) {
      const ok = await confirm.ask({
        title: '替换左栏正在写的提示词？',
        body: '图像栏里已经有 ' + draft.length + ' 字，这一句是 ' + text.length + ' 字，替换后原来那句就不在了。'
          + '替换完还要你自己点「生成」。',
        okLabel: '替换', cancelLabel: '留着我现在写的', danger: true,
      });
      if (!ok) { setStatus('<span class="warn">已取消</span>'); return; }
    }
    if (type() !== 'image') setType('image', true);
    $('prompt').value = text;
    cur().prompt = text;
    writeLS('studio_prompt_image', text);
    updateGoState();
    window.focusQuiet($('prompt'));
    /* 填进去是真的填了，可这一栏一家能用的型号都没有时不能只说「好了」—— 点生成只会再撞一次。 */
    if (!provGroups().length) { setStatus('<span class="warn">已填进图像栏 · 图像栏还没有可用型号，去设置加一家</span>'); return; }
    if (!carried.length) {
      setStatus('<span class="ok">✓ 已送进图像栏</span><span class="warn">　确认后点「生成图像」。</span>');
      return;
    }
    const LBL = slotDef.image.label;
    openImageSlot();
    const sl = slots().find(x => x.kind === 'image');
    const blocked = !!sl && blockedSlotKinds().has('image');
    let kind = 'image';
    if (sl && !blocked) {
      const cap = sl.max;
      const room = slotRoom(sl);
      if (room === 0) {
        const ok = await confirm.ask({
          title: '「' + LBL + '」已经放满',
          body: '图像栏当前型号一次最多 ' + cap + ' 张，里面已经占了 ' + slotItems('image').length + ' 张。'
            + '清空这一栏，再把这次要带的 ' + Math.min(cap, carried.length) + ' 张放进去？',
          okLabel: '清空再放', cancelLabel: '不动图像栏', danger: true,
        });
        if (!ok) { setStatus('<span class="warn">已取消：参考图没带过去（提示词已经填好）</span>'); return; }
        clearSlot('image');
      } else if (room < carried.length) {
        const ok = await confirm.ask({
          title: '这一栏只放得下 ' + room + ' 张',
          body: '图像栏当前型号一次最多 ' + cap + ' 张参考图，里面还空 ' + room + ' 格。带前 ' + room
            + ' 张，其余 ' + (carried.length - room) + ' 张这次不带。',
          okLabel: '就带 ' + room + ' 张', cancelLabel: '先不动',
        });
        if (!ok) { setStatus('<span class="warn">已取消：参考图没带过去（提示词已经填好）</span>'); return; }
      }
    } else {
      const why = blocked ? '「' + LBL + '」与图像栏已选素材互斥' : '图像栏当前型号没有「' + LBL + '」这个入口';
      const opts = [];
      const alt = bestRefModel();
      const n = alt ? Math.min(alt.max, carried.length) : 0;
      if (alt) opts.push({ value: 'model', label: '换成「' + (alt.m.name || alt.m.id) + '」',
        hint: (alt.p.name ? alt.p.name + ' · ' : '') + '一次收 ' + alt.max + ' 张参考图（这次带 ' + n + ' 张）' });
      /* 首尾帧那两格也收图片（SLOT_CANDS 里就写着）：型号不收参考图时是唯一的落点。 */
      const other = ['frame_first', 'frame_last'].find(k => slots().some(x => x.kind === k)
        && !blockedSlotKinds().has(k) && slotTakesType(k, '图片') && roomNow(k) > 0);
      if (other) opts.push({ value: 'frame', label: '放进「' + slotDef[other].label + '」',
        hint: '这一格还空 ' + roomNow(other) + ' 处（这次带 ' + Math.min(roomNow(other), carried.length) + ' 张）' });
      if (!opts.length) {
        setStatus('<span class="err">' + window.esc(why) + '，图像栏也没有别的格子收图片 · 换型号或清空已选素材再试</span>');
        return;
      }
      const go = await confirm.choose({
        title: why, sub: '要带走 ' + carried.length + ' 张图片', options: opts, cancelLabel: '先不动',
      });
      if (!go) { setStatus('<span class="warn">已取消：参考图没带过去（提示词已经填好）</span>'); return; }
      if (go === 'model') {
        $('model').value = alt.p.id + '::' + alt.m.id;
        $('model').dispatchEvent(new Event('change'));
        openImageSlot();
        if (roomNow('image') <= 0) { setStatus('<span class="err">换了型号还是放不进「' + LBL + '」</span>'); return; }
      } else kind = other;
    }
    let done = 0;
    const full = [], drops = [];
    for (const it of carried) {
      if (roomNow(kind) <= 0) { full.push(it); continue; }
      /* `file` 一起递过去：本地上传的素材已经带着字节，refIntoSlot 直接放进槽，
         不用照着地址再回取一次（取回来还可能因为签名过期失败）。 */
      const r = await refIntoSlot('图片', { src: it.media || it.raw || it.src || it.url || '',
        assetId: it.assetId, dl: it.dl, fileKey: it.fileKey, file: it.file,
        name: it.name || it.prompt }, { forceKind: kind });
      if (r.ok) done++; else drops.push(r.why);
    }
    renderInputArea(); updateMode(); updateGoState();
    const tail = [];
    if (full.length) tail.push(full.length + ' 张放不下（「' + slotDef[kind].label + '」最多 '
      + (slots().find(x => x.kind === kind) || { max: 0 }).max + ' 张）');
    const reasons = [...new Set(drops)];
    const head = done
      ? '<span class="ok">✓ 已送进图像栏：提示词 + ' + done + ' / ' + carried.length + ' 张参考图</span><span class="warn">　确认后点「生成图像」。</span>'
      : '<span class="err">提示词已送进图像栏，参考图一张都没放进去</span>';
    setStatus(head
      + (reasons.length ? '<span class="err">　' + window.esc(reasons.slice(0, 2).join('；')
        + (reasons.length > 2 ? ' 等 ' + reasons.length + ' 类原因' : '')) + '</span>' : '')
      + (tail.length ? '<span class="warn">　' + window.esc(tail.join(' · ')) + '</span>' : ''));
  }

  /* 图片 → 视频栏的参考素材。能力闸必须在切栏**之后**现读：slots / currentModel / provGroups
     都问当前那一栏，不切过去就量不到视频栏的真相（切栏本身无损，三栏各留一份草稿）。
     收不下、被互斥挡住、压根没有这一格 —— 三种都先问一句再动手，不静默改用户选好的型号，
     也不假装放成功了。 */
  async function imagesIntoVideoRef(items) {
    const all = items || [];
    const imgs = all.filter(it => window.mediaKindOf(it.mtype) === 'image');
    if (!imgs.length) { toast.warn(all.length ? '这些里没有图片' : '先勾选要带走的图片'); return; }
    const notImg = all.length - imgs.length;
    const LBL = slotDef.image.label;
    if (type() !== 'video') setType('video', true);
    /* 一次请求能用哪几类素材由组合声明，那一格也可能被当前组合藏掉：先按声明把它切回来。 */
    openImageSlot();
    const slotLbl = k => slotDef[k].label;
    let kind = 'image';
    const sl = slots().find(x => x.kind === 'image');
    const blocked = !!sl && blockedSlotKinds().has('image');
    if (sl && !blocked) {
      const cap = sl.max;
      const room = slotRoom(sl);
      if (room === 0) {
        const ok = await confirm.ask({
          title: '「' + LBL + '」已经放满',
          body: '当前型号一次最多 ' + cap + ' 张，里面已经占了 ' + slotItems('image').length + ' 张。'
            + '清空这一栏，再把这次要带的 ' + Math.min(cap, imgs.length) + ' 张放进去？',
          okLabel: '清空再放', cancelLabel: '不动视频栏', danger: true,
        });
        if (!ok) { setStatus('<span class="warn">已取消</span>'); return; }
        clearSlot('image');
      } else if (room < imgs.length) {
        const ok = await confirm.ask({
          title: '这一栏只放得下 ' + room + ' 张',
          body: '当前型号一次最多 ' + cap + ' 张参考图，里面还空 ' + room + ' 格。带前 ' + room
            + ' 张，其余 ' + (imgs.length - room) + ' 张这次不带。',
          okLabel: '就带 ' + room + ' 张', cancelLabel: '先不动',
        });
        if (!ok) { setStatus('<span class="warn">已取消</span>'); return; }
      }
    } else {
      const why = blocked ? '「' + LBL + '」与已选素材互斥' : '当前型号没有「' + LBL + '」这个入口';
      const opts = [];
      const alt = bestRefModel();
      const n = alt ? Math.min(alt.max, imgs.length) : 0;
      if (alt) opts.push({ value: 'model', label: '换成「' + (alt.m.name || alt.m.id) + '」',
        hint: (alt.p.name ? alt.p.name + ' · ' : '') + '一次收 ' + alt.max + ' 张参考图（这次带 ' + n + ' 张）' });
      /* 首尾帧那两格也收图片（SLOT_CANDS 里就写着）：型号不收参考图时是唯一的落点。 */
      const other = ['frame_first', 'frame_last'].find(k => slots().some(x => x.kind === k)
        && !blockedSlotKinds().has(k) && slotTakesType(k, '图片') && roomNow(k) > 0);
      if (other) opts.push({ value: 'frame', label: '放进「' + slotLbl(other) + '」',
        hint: '这一格还空 ' + roomNow(other) + ' 处（这次带 ' + Math.min(roomNow(other), imgs.length) + ' 张）' });
      if (!opts.length) {
        setStatus('<span class="err">' + window.esc(why) + '，这一栏也没有别的格子收图片 · 换型号或清空已选素材再试</span>');
        return;
      }
      const go = await confirm.choose({
        title: why, sub: '要带走 ' + imgs.length + ' 张图片', options: opts, cancelLabel: '先不动',
      });
      if (!go) { setStatus('<span class="warn">已取消</span>'); return; }
      if (go === 'model') {
        $('model').value = alt.p.id + '::' + alt.m.id;
        $('model').dispatchEvent(new Event('change'));
        openImageSlot();
        if (roomNow('image') <= 0) { setStatus('<span class="err">换了型号还是放不进「' + LBL + '」</span>'); return; }
      } else kind = other;
    }
    let done = 0;
    const full = [], drops = [];
    for (const it of imgs) {
      if (roomNow(kind) <= 0) { full.push(it); continue; }
      /* 地址取 media（`Api.assetSrc` / `Api.mediaSrc` 现算的那一份），不取 raw：raw 是上游原始地址，
         签名会过期，带它进槽就只能走取字节那一路，还常常当场失败。 */
      const r = await refIntoSlot('图片', { src: it.media || it.raw || '', assetId: it.assetId,
        dl: it.dl, fileKey: it.fileKey, name: it.name || it.prompt }, { forceKind: kind });
      if (r.ok) done++; else drops.push(r.why);
    }
    renderInputArea(); updateMode(); updateGoState();
    paintToVideoBtn();
    const tail = [];
    if (full.length) tail.push(full.length + ' 张放不下（「' + slotLbl(kind) + '」最多 '
      + (slots().find(x => x.kind === kind) || { max: 0 }).max + ' 张）');
    if (notImg) tail.push(notImg + ' 条不是图片，没带走');
    const head = done
      ? '<span class="ok">✓ 已放 ' + done + ' 张进「' + slotLbl(kind) + '」</span><span class="warn">　确认后点「生成视频」。</span>'
      : '<span class="err">一张都没放进去</span>';
    const reasons = [...new Set(drops)];
    setStatus(head
      + (reasons.length ? '<span class="err">　' + window.esc(reasons.slice(0, 2).join('；')
        + (reasons.length > 2 ? ' 等 ' + reasons.length + ' 类原因' : '')) + '</span>' : '')
      + (tail.length ? '<span class="warn">　' + window.esc(tail.join(' · ')) + '</span>' : ''));
  }

  return { promptIntoImage, imagesIntoVideoRef };
}
