/* 拆分片段批量生成：文字 AI 拆条 → 人工确认 → 按图像栏的设置快照逐条提交。
   设置只读一处（advPlan / val / advExtras / topBoolCtx），提交仍走 createImageOnce ——
   一条拆分不等于一次请求：一条要出 N 张时按平台单请求上限切开，与普通「生成图像」同一套算法。 */
export function createSplit(d) {
  const {
    $, setStatus, reg, polishImageList, polishMaterials, userLines, inputs,
    uploadImageRefs, createImageOnce, withCreateRetry, saveSyncImages,
    adoptTasks, loadServer, tallyRun, maybeSubmitErr, updateGoState,
    modelLimits, val, advPlan, advExtras, topBoolCtx,
  } = d;
  let visionNote = '', warnedVision = false;

  /* 宽松布尔：缺省为 true（旧回执里没有这个字段时保持「带参考图」的原有行为），
     只有明确写成 false / no / 0 / off 才算不带。 */
  function useRefOf(f) {
    const o = f && typeof f === 'object' ? f : {};
    const v = o.useRef !== undefined ? o.useRef : o.use_ref;
    if (v === undefined || v === null || v === '') return true;
    if (typeof v === 'string') return !/^(false|no|0|off)$/i.test(v.trim());
    return !!v;
  }

  function parseSegs(txt) {
    let s = String(txt || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let v = null;
    try { v = JSON.parse(s); } catch (e) {
      const m = s.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
      if (m) { try { v = JSON.parse(m[1]); } catch (e2) {} }
    }
    const list = Array.isArray(v) ? v : (v && (v.frames || v.segments || v.shots || v.list));
    if (!Array.isArray(list)) return [];
    return list.map((f, i) => {
      let label = String(f && (f.label || f.name || f.title) || '').trim();
      if (!label) {
        const t = f && (f.t ?? f.time);
        const sec = (t !== undefined && t !== null && t !== '') ? parseFloat(t) : NaN;
        label = isFinite(sec) ? ('第 ' + sec + ' 秒') : ('片段 ' + (i + 1));
      }
      return {
        label: label.slice(0, 12),
        prompt: String(f && (f.prompt || f.desc || f.text) || '').trim().slice(0, 600),
        useRef: useRefOf(f),
      };
    }).filter(x => x.prompt).slice(0, 8);
  }

  async function planImageSegments() {
    const src = ($('prompt').value || '').trim();
    let user = '把下面这段描述拆成图片提示词：\n' + src + userLines();
    const pm = polishMaterials();
    if (pm.length) user += '\n' + window.TextAI.materialNote(pm);
    user += '\n只返回 JSON。';
    const refList = polishImageList();
    let images = [];
    visionNote = '';
    try {
      const picked = await window.TextAI.polishImages(reg(), refList);
      images = picked.images || [];
      if (refList.length && !images.length) {
        visionNote = '未能看图，按带参考图处理';
        if (!warnedVision) {
          warnedVision = true;
          console.warn('[拆分] 文字 AI 这次没看到参考图：', picked.note || '未启用识图');
        }
      }
    } catch (e) { console.warn('[拆分] 参考图附带失败：', e.message); }
    const txt = await window.AiStream.text(reg(), window.TextAI.prompt('img_split'), user,
      { images, host: $('polishInline'), title: 'AI 正在拆分片段…' });
    const segs = parseSegs(txt);
    if (!segs.length) throw new Error('文字 AI 没有给出可用的拆分方案，换一条描述或再试一次');
    /* 图像栏一张参考图都没有时，「带参考图」这个决定没有可发的东西 —— 全部按不带处理，
       回执与任务卡上的读数才不会说一件没发生的事。 */
    const hasRefs = (inputs().image || []).length > 0;
    return hasRefs ? segs : segs.map(sg => Object.assign({}, sg, { useRef: false }));
  }

  /* 这一批要用的设置快照：提交前取一次，逐条复用（批次中途改界面不会只影响后面几条）。 */
  function imageBatchPlan(model) {
    const ap = advPlan(model, 'image');
    const ex = advExtras();
    const pick = (...vs) => { for (const v of vs) if (v !== undefined && v !== null && v !== '') return v; return ''; };
    return {
      model: (model && model.id) || '',
      payload: ap.payload || {},
      count: Math.max(1, Number(val('count')) || 1),
      params: ex.params || {},
      shape: topBoolCtx(),
      perReq: Math.max(1, modelLimits(model).maxOut),
      summary: ex.summary || '',
      tier: val('tier'), res: val('res'),
      quality: pick(ap.payload && ap.payload.quality, val('quality')),
      ar: pick(ap.payload && ap.payload.ar, val('ratio'), val('ar')),
      size: pick(ap.payload && ap.payload.size, val('size')),
      format: pick(ap.payload && ap.payload.format, val('format')),
    };
  }

  function settingsLine(model) {
    const p = imageBatchPlan(model);
    const bits = [(model && (model.name || model.id)) || '当前型号', '每条 ' + p.count + ' 张'];
    if (p.quality) bits.push('画质 ' + p.quality);
    if (p.ar) bits.push('比例 ' + p.ar);
    if (p.size) bits.push('尺寸 ' + p.size);
    if (p.format) bits.push('格式 ' + p.format);
    return bits.join(' · ');
  }

  function reviewSub(sg) {
    return (sg && sg.useRef ? '带参考图' : '不带参考图')
      + (sg && sg.useRef && visionNote ? ' · ' + visionNote : '');
  }

  /* 估价那一句：与主生成路径同一份估价器（AssetLib.estimateCost），count = 全部片段的总张数。
     算不出来就给空串 —— 回执里少一句，不编一句。 */
  async function estimateLine(prov, model, total) {
    try {
      const params = Object.assign({}, advPlan(model, 'image').payload,
        { prompt: '', count: total, topBools: advExtras().topBools });
      const r = await window.AssetLib.estimateCost(prov, model, params, {});
      if (r && r.ok) return '预计 ' + r.text + (r.detail ? '（' + r.detail + '）' : '');
      if (r && r.skip) return String(r.reason || '这一档平台不提供询价');
      return '报价不可用，仍可生成';
    } catch (e) { return ''; }
  }

  /* opts 回调只服务「占位符填入视频栏」那一路：onTask 认领任务号、onSync 同步出图就位、
     onFail 摘卡（why='unknown' 表示结果未知）。不传就是纯批量提交，行为不变。
     `opts.plan`：调用方趁界面还停在图像栏时先取好的设置快照（交给视频栏占位那一步会把
     界面切到视频栏，到这里再读 advExtras 取到的是视频那一栏的顶层开关 —— 图片请求带上
     turbo / prompt_optimization 会被平台整条拒收：「not available for text_to_image」）。 */
  async function submitImageBatch(segs, prov, model, opts) {
    const o = opts || {};
    const plan = o.plan || imageBatchPlan(model);
    const totalImgs = segs.length * plan.count;
    const withRef = segs.filter(s => s.useRef).length;
    $('go').disabled = true;
    try {
      let assetIds = [];
      if (withRef) {
        if (o.refs) {
          /* 调用方已把参考图传好（占位符那一路要在切栏**之前**上传 —— 切到视频栏之后
             inputs() 问的就是另一栏了），这里只收资产号。 */
          assetIds = o.refs.map(r => (typeof r === 'string' ? r : r.assetId)).filter(Boolean);
        } else {
          setStatus('批量生成 ' + totalImgs + ' 张：正在上传参考图…');
          assetIds = await uploadImageRefs(prov);
        }
      } else {
        setStatus('批量生成 ' + totalImgs + ' 张：按图像栏的设置提交…');
      }
      const created = [];
      let failed = 0, uncertain = 0, syncN = 0;
      const failWhy = [];
      const syncNotes = [];
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        const refs = sg.useRef ? assetIds : [];
        const chunks = [];
        for (let left = plan.count; left > 0; left -= plan.perReq) chunks.push(Math.min(plan.perReq, left));
        for (let j = 0; j < chunks.length; j++) {
          const n = chunks[j];
          try {
            setStatus('批量生成 ' + totalImgs + ' 张（第 ' + (i + 1) + '/' + segs.length + ' 条'
              + (chunks.length > 1 ? ' 第 ' + (j + 1) + '/' + chunks.length + ' 次' : '') + '）：' + window.esc(sg.label));
            const out = await withCreateRetry(() => createImageOnce(prov, model, sg.prompt, refs, n, plan),
              '第 ' + (i + 1) + ' 条「' + window.esc(sg.label) + '」创建失败，');
            if (out.taskId) {
              created.push({ provider: prov.id, id: out.taskId, prompt: sg.prompt,
                extra: { tier: plan.tier, res: plan.res, ar: plan.ar, quality: plan.quality,
                  size: plan.size, format: plan.format, count: n, model: plan.model } });
              if (o.onTask) o.onTask(i, out.taskId);
            } else if (out.sync) {
              const sv = await saveSyncImages(prov, model, sg.prompt, out.sync, plan.format);
              if (o.onSync) o.onSync(i, sv);
              syncN += sv.length;
              (sv.notes || []).forEach(t => syncNotes.push('「' + sg.label + '」' + t));
            }
          } catch (e) {
            if (maybeSubmitErr(e)) { uncertain++; if (o.onFail) o.onFail(i, 'unknown'); console.warn('[拆分] 片段「' + sg.label + '」结果未知：', e.message); }
            else { failed++; if (o.onFail) o.onFail(i, 'err'); failWhy.push('「' + sg.label + '」' + window.errText(e)); console.warn('[拆分] 片段「' + sg.label + '」提交失败：', e.message); }
          }
        }
      }
      if (created.length) await adoptTasks(created);
      try { await loadServer(1); } catch (e) {}
      tallyRun();
      if (uncertain) { try { await loadServer(1, true); } catch (e) {} }
      const taskImgs = created.reduce((a, x) => a + (Number(x.extra && x.extra.count) || 1), 0);
      const accepted = taskImgs + syncN;
      const parts = ['已提交 ' + accepted + ' / ' + totalImgs + ' 张'];
      parts.push(withRef + ' 条带参考图 / ' + (segs.length - withRef) + ' 条不带');
      if (failed) parts.push(failed + ' 次失败：' + failWhy.slice(0, 2).join('；') + (failWhy.length > 2 ? ' 等' : ''));
      if (syncNotes.length) parts.push(syncNotes.length + ' 张没存进资产库：' + syncNotes.slice(0, 2).join('；') + (syncNotes.length > 2 ? ' 等' : ''));
      if (uncertain) parts.push(uncertain + ' 次当时没等到平台响应（可能已受理，以右栏列表为准，别重复生成）');
      const msg = parts.join('；');
      setStatus(msg);
      return msg;
    } finally { updateGoState(); }
  }

  return { parseSegs, planImageSegments, imageBatchPlan, settingsLine, reviewSub, estimateLine, submitImageBatch };
}
