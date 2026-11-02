/* 拆分生成的「占位符先填入视频栏」：确认拆分方案那一刻，先把每一段的占位卡
   填进视频栏收图片的那一格（优先「参考图」，没有就看首尾帧），任务号随提交认领；
   每张图生成完在原位换成真图，失败的当场摘掉并出声 —— 与导演台「按描述生成这一镜的画面」
   同一套交互。占位卡不是素材：不进提交体、不参与上传，只是占着格子等人来。 */
export function createVideoFill(d) {
  const {
    type, setType, slots, slotItems, slotRoom, blockedSlotKinds,
    renderInputArea, writeLS, readLS, toast,
  } = d;

  const IMG_KINDS = ['image', 'frame_first', 'frame_last'];
  const PREF_KEY = 'studio_split_fill_video';
  let seq = 0;
  const fills = new Map();          // 段序号 → 占位卡 fid（空串 = 这一段没填上）
  /* 填充那一刻的数组本体（fid → { kind, arr }）。解卡不能按「当前那一栏」现找：
     图生成要等几十秒，这期间人切到图像栏看一眼是常事 —— 那时 slotItems() 问的是
     图像栏的数组，视频栏那几张占位卡就永远等不到人，回来还是占位状态。 */
  const arenas = new Map();

  const pref = () => readLS(PREF_KEY, '1') !== '0';
  const setPref = on => writeLS(PREF_KEY, on ? '1' : '0');

  function targetKind() {
    for (const k of IMG_KINDS) {
      const sl = slots().find(x => x.kind === k);
      if (sl && !blockedSlotKinds().has(k) && slotRoom(sl) > 0) return k;
    }
    return '';
  }

  /* 确认方案那一刻调用：先把占位卡一格一格填进去，返回填写张数。
     格子放不下（被互斥挡住 / 槽满 / 型号没有入口）的那几段照常生成，
     只是不占格 —— 数量在回执里说清。 */
  function fillSlots(segs) {
    fills.clear();
    arenas.clear();
    if (type() !== 'video') setType('video', true);
    let placed = 0;
    for (let i = 0; i < segs.length; i++) {
      const kind = targetKind();
      if (!kind) { fills.set(i, ''); continue; }
      const fid = 'pf' + (++seq);
      const arr = slotItems(kind);
      arr.push({
        pending: true, fid, seg: i, label: String(segs[i].label || ''),
        name: '拆分·' + String(segs[i].label || ''), type: '图片', kind, fromLib: false, taskId: '',
      });
      fills.set(i, fid);
      arenas.set(fid, { kind, arr });
      placed++;
    }
    if (placed) renderInputArea();
    return placed;
  }

  /* 解卡要找的那几份数组：填充时记下的 + 当前栏的（草稿重建过数组时，占位卡在旧数组里，
     当前数组里没有，两份都要查；同一份数组不重复算）。 */
  function arenaList() {
    const seen = new Set(), out = [];
    for (const a of arenas.values()) { if (!seen.has(a.arr)) { seen.add(a.arr); out.push(a); } }
    for (const k of IMG_KINDS) {
      const arr = slotItems(k);
      if (!seen.has(arr)) { seen.add(arr); out.push({ kind: k, arr }); }
    }
    return out;
  }

  const findPending = fid => {
    for (const a of arenaList()) {
      const i = a.arr.findIndex(it => it.pending && it.fid === fid);
      if (i >= 0) return { k: a.kind, arr: a.arr, i, it: a.arr[i] };
    }
    return null;
  };

  /* 每段可能分多次请求（张数按单请求上限切开）：占位卡认领第一个回来的任务号。 */
  function markTask(i, taskId) {
    const fid = fills.get(i);
    if (!fid || !taskId) return;
    const hit = findPending(fid);
    if (hit && hit.it.pending && !hit.it.taskId) hit.it.taskId = String(taskId);
  }

  /* 轮询回执钩子：done → 原位换真图；failed → 摘卡并出声。没认领到就 false（与别的任务无关）。 */
  function resolveByTask(taskId, upd) {
    const id = String(taskId || '');
    if (!id) return false;
    for (const a of arenaList()) {
      const i = a.arr.findIndex(it => it.pending && String(it.taskId || '') === id);
      if (i < 0) continue;
      const it = a.arr[i];
      const done = upd && upd.kind === 'asset' && (upd.media || upd.assetId);
      if (done) {
        a.arr[i] = { assetId: upd.assetId || '', src: upd.media || '', url: upd.media || '',
          name: it.label || '拆分图', type: '图片', kind: a.kind, fromLib: true };
      } else if (upd && (upd.status === 'failed' || upd.error)) {
        a.arr.splice(i, 1);
        toast.err('「' + (it.label || '拆分片段') + '」没生成出来，已从参考素材移除');
      } else return false;
      if (it.fid) arenas.delete(it.fid);
      if (type() === 'video') renderInputArea();
      return true;
    }
    return false;
  }

  /* 同步出图的那一路（平台一次给齐字节，没有任务号）：按段序号直接换真图。 */
  function resolveSaved(i, saved) {
    const fid = fills.get(i);
    const list = saved || [];
    if (!fid || !list.length) return;
    const hit = findPending(fid);
    if (!hit) return;
    const s = list[0];
    hit.arr[hit.i] = { assetId: s.id || s.assetId || '', src: s.url || '', url: s.url || '',
      name: hit.it.label || '拆分图', type: '图片', kind: hit.k, fromLib: true };
    fills.delete(i);
    arenas.delete(fid);
    if (type() === 'video') renderInputArea();
  }

  /* 提交那一段失败：占位卡没有任务号可等，当场摘掉。unknown = 结果未知（可能已受理）。 */
  function fail(i, why) {
    const fid = fills.get(i);
    if (!fid) return;
    fills.delete(i);
    const hit = findPending(fid);
    if (!hit) return;
    const label = hit.it.label || '拆分片段';
    hit.arr.splice(hit.i, 1);
    arenas.delete(fid);
    if (type() === 'video') renderInputArea();
    if (why === 'unknown') toast.err('「' + label + '」可能已受理（以右栏列表为准），占位卡已摘掉');
    else if (why) toast.err('「' + label + '」没提交出去，占位卡已摘掉');
  }

  /* 收尾：这一批里始终没等到任务号的占位卡（提交没跑完就结束的）全部摘掉。 */
  function sweep() {
    let n = 0;
    for (const a of arenaList()) {
      for (let i = a.arr.length - 1; i >= 0; i--) {
        if (a.arr[i].pending && !a.arr[i].taskId) { a.arr.splice(i, 1); n++; }
      }
    }
    fills.clear();
    arenas.clear();
    if (n && type() === 'video') renderInputArea();
    return n;
  }

  const pendingCount = () => arenaList().reduce((a, x) => a + x.arr.filter(it => it.pending).length, 0);

  return { pref, setPref, fill: fillSlots, markTask, resolveByTask, resolveSaved, fail, sweep, pendingCount };
}
