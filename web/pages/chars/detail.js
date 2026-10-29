/* ============================================================================
   素材详情 —— 整屏层（新建 / 编辑一条素材）
   ---------------------------------------------------------------------------
   这一层是「素材库那一页」的一部分，不是一张新页面：
     · 编辑态：左边是**画面**（预览图 / 锚点 / 候选），右边是**文档**（基本信息 / 描述 /
       角色资产 / 声音 / 使用关系）—— 写描述的时候得能看着那张图，所以画面那一栏不动。
     · 新建态：同一副骨架，空的 —— 先把人写清楚，再出图。
   它顶掉了以前「卡内就地展开的编辑区」（那张卡会长到一千多像素，把网格撑坏）。

   **每个要生成东西的地方自带型号与数量**（生成条 `.gen-bar`）：预览图、角色资产、声音
   各自一份，改一处不动别处。
   默认值来自**设置页「素材库」那张卡**（默认生图型号 / 默认语音型号 / 默认出几张）；
   页面上**没有「本页默认」面板**了 —— 换的那一次只管那一处，不写回设置页、不写进本机
   （写回去就成了「按上次那个跑」）。
   型号下拉、声音那一块、候选排**都调数据层那几件**（`Chars.Pipe.modelSelectHTML` /
   `Chars.Cast.voiceRowHTML` / `Chars.Cast.picCandsHTML`）—— 界面只有一份。

   数据与副作用**一件都不重写**：写库走 `Chars.Lib`，出图走 `Chars.Pipe`，出声音走
   `Chars.Cast` —— 这一层只负责「长什么样」与「点了之后做什么」。
   ========================================================================== */

/** 完备度点阵（与素材库卡面同一套形状语言）：预览图 · 角色资产 · 声音 · 描述 */
export function detailDots(D, c) {
  const isActor = !D.isSceneItem(c) && !D.isPropItem(c);
  const slots = [
    { ok: !!D.picOf(c), na: false },
    { ok: isActor ? D.Cast.assetsOf(c).length > 0 : null, na: !isActor },
    { ok: isActor ? !!c.voice : null, na: !isActor },
    { ok: !!(D.descOf(c) || '').trim(), na: false },
  ];
  return '<span class="mdots">' + slots.map(x => {
    if (x.na) return '<i class="na"></i>';
    return x.ok ? '<i class="ok"></i>' : '<i class="miss"></i>';
  }).join('') + '</span>';
}
export function detailStat(D, c) {
  const isActor = !D.isSceneItem(c) && !D.isPropItem(c);
  const slots = [
    { ok: !!D.picOf(c), na: false },
    { ok: isActor ? D.Cast.assetsOf(c).length > 0 : null, na: !isActor },
    { ok: isActor ? !!c.voice : null, na: !isActor },
    { ok: !!(D.descOf(c) || '').trim(), na: false },
  ];
  const miss = slots.filter(x => !x.na && !x.ok).length;
  if (!miss) return '<span class="mstat">齐了</span>';
  return '<span class="mstat ' + (miss > 1 ? 'is-err' : 'is-warn') + '">缺 ' + miss + ' 项</span>';
}

/**
 * 建一层。ctx 由素材库页交过来（页面里那些写库 / 出图 / 记账的出口都在那边）。
 * ctx = {
 *   D, REG（getter）, refUse, DRAFT,
 *   libSave, errSet, genRun, genHas, genSet, genClear, onTaskHook,
 *   dramaWith(model), optsWith(model, count),
 *   defImgModel(), defTtsModel(), effKey(kind, mode, key),
 *   picWord, mainKind, candCount(modelKey), durablePic, thumbImg, errText,
 *   saveField, queueFieldSave, render, findSimilar, openZoom,
 *   hostEl（挂层的那一格）, onClose, onCreated,
 * }
 */
export function createDetail(ctx) {
  const D = ctx.D;
  const esc = window.esc;
  const Toast = window.Toast;
  const Confirm = window.Confirm;

  let host = null;          // 层的外壳（挂在页面根上）
  let live = null;          // 当前这一条（编辑态）
  let draft = null;         // 新建态的草稿（还没建档）
  let isNew = false;
  /* 每个生成位自己的型号与数量：pic（预览图）/ asset（角色资产）/ voice（声音）。
     型号存的是「型号键」（provId/modelId），空串 = 还没单独挑过 = 用设置页那个默认。
     数量：0 = 还没单独改过 = 用设置页那个「默认出几张」。
     ⚠ 这些**不落盘**：换的那一次只管那一处。 */
  const gens = {
    pic: { model: '', count: 0 },
    asset: { model: '', count: 0 },
    voice: { model: '', count: 0 },
  };
  /* 每一张**已有的**角色资产自己一份重出参数（型号 / 张数）——
     那一行的下拉选了要真的算数，不能还走区块那一档。 */
  const rowGens = {};
  /* 声音那一处现在用的型号：这一处挑的 → 设置页那个默认。
     这一层里**所有跟声音有关的调用**都走它（音色清单、试听、复刻、参考音频）——
     界面上换的型号要真的管用，不然「换了一处、别处照旧」等于没换。 */
  const voiceOpts = () => ctx.optsWith(gens.voice.model || ctx.defTtsModel());

  /* ---------- 型号与数量：现读平台声明 ---------- */
  function modelHTML(kind, mode, cur, rowId) {
    const empty = kind === 'image' ? '没配生图平台' : '没配语音平台';
    let html = '';
    /* 下拉里显示的是**现在生效的那一个**（这一处挑的 → 设置页那个默认 → 注册表里第一个）。 */
    try { html = D.Pipe.modelSelectHTML(ctx.REG, { kind: kind, mode: mode, value: ctx.effKey(kind, mode, cur), emptyText: empty }); }
    catch (e) { html = '<span class="ui-hint">' + empty + '</span>'; }
    return html.replace('<select ', '<select class="gen-model"'
      + (rowId ? ' data-row-model="' + esc(rowId) + '"' : '') + ' ');
  }
  /* 一次能出几张：只问能力声明（max_outputs），没声明就 1 张 —— 不在界面上写死。 */
  function capOf(kind, modelKey) {
    try {
      const mode = kind === 'image' ? 'text_to_image' : 'text_to_speech';
      const hit = D.Pipe.pickProvModel(ctx.REG, kind, modelKey || '', mode);
      return D.previewCap(hit && hit.model);
    } catch (e) { return 1; }
  }
  function countHTML(cap, cur, unit, rowId) {
    let h = '<select class="gen-count"'
      + (rowId ? ' data-row-count="' + esc(rowId) + '"' : '') + '>';
    for (let i = 1; i <= Math.max(1, cap); i++) h += '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>' + i + ' ' + (unit || '张') + '</option>';
    return h + '</select>';
  }
  /* 声音一次能出几条：跟着设置里的「默认一次出几条语音」走（那是全局设置）。
     语音型号不声明 max_outputs（那是生图那个口径），所以这一处的上限
     就是设置项自己的上限。 */
  function voiceCapOf() {
    try { return Math.max(1, Number(D.SET.voiceN.max) || 8); }
    catch (e) { return 8; }
  }
  /* 声音的默认条数：设置里那一项（与图的张数是两项，各调各的）。 */
  function voiceDefOf() {
    try { return Math.max(1, Number(D.voiceN()) || 3); }
    catch (e) { return 3; }
  }
  /* 这一处现在要出几张：这一行自己改过的 → 设置页那个默认 → 上限。 */
  function siteCountOf(site, cap, def) {
    const g = gens[site];
    return Math.max(1, Math.min(g.count || def || cap, cap));
  }
  /* 生成条：型号 + 数量 + 动作 + 一句「依据什么」 */
  function genBar(o) {
    const cap = o.cap;                                    // 这个型号一次能让几张（上限）
    const def = Math.max(1, Math.min(o.def || cap, cap)); // 默认几张（设置页那一项）
    const n = siteCountOf(o.site, cap, def);
    return '<div class="gen-bar" data-gen="' + o.site + '">'
      + '<div class="gen-row"><span class="gen-lab">' + esc(o.label) + '</span>'
      + modelHTML(o.kind, o.mode, gens[o.site].model)
      + countHTML(cap, n, o.unit)
      + (o.extra || '')
      + '<span class="sp"></span>'
      + '<button class="pri gen-act" type="button" data-d-act="gen" data-site="' + o.site + '">' + esc(o.act) + '</button>'
      + '</div>'
      + (o.extra2 ? '<div class="gen-row gen-row-acts">' + o.extra2 + '</div>' : '')
      + '<div class="gen-why"><span>' + esc(o.why) + '</span></div>'
      + '</div>';
  }

  /* ---------- 画面那一栏（左边） ---------- */
  function mediaHTML(c) {
    const pic = D.picOf(c);
    const kind = ctx.mainKind(c);
    const kf = ctx.kindFields(c);
    const hero = pic
      ? '<div class="md-hero">' + ctx.thumbImg(pic) + '</div>'
      : '<div class="md-hero"><div class="none"><b>还没有预览图</b><span>' + (D.isSceneItem(c)
        ? '照下面描述出图。'
        : D.isPropItem(c) ? '照下面描述出图。'
          : '写清长什么样，或传一张。') + '</span></div></div>';
    /* 这一处（预览图）现在用哪个型号：这一行挑的 → 设置页那个默认。 */
    const picModel = gens.pic.model || ctx.defImgModel();
    const cap = capOf('image', picModel);
    const picDef = ctx.candCount(picModel);
    /* 这一条上一次没出来的那几项，原因要落在看得见的地方（真品是写在卡上那一行）。 */
    const errHTML = ctx.errsHTML ? ctx.errsHTML(c) : '';
    const bar = genBar({
      site: 'pic', label: '出图', kind: 'image', mode: 'text_to_image', cap: cap, def: picDef,
      act: pic ? '重出' + ctx.picWord(c) : 'AI 出第一张',
      why: '照「' + shortLab(kf.look.lab) + '」这一句画'
        + (D.isSceneItem(c) ? ' · 光线按「' + (c.time || '深夜') + '」走' : ''),
      extra: '<button class="ghost" type="button" data-d-act="pickface">' + (window.icon ? window.icon('upload', 12) : '') + '自己传一张</button>',
    });
    /* 候选排：出过的那些都在这里，能换能删（标记用数据层那一份） */
    const faces = (c.faces || []).filter(x => x && x.src);
    const cands = faces.length
      ? '<div class="md-mrow"><div class="md-mt">预览图候选<span class="n">' + faces.length + ' 张</span></div>'
        + D.Cast.picCandsHTML(faces, pic, { act: 'usecand', del: 'canddel', label: '候选', name: c.name, extra: ' data-k="' + esc(kind) + '"' })
        + '<div class="gen-row gen-row-inline"><span class="gen-lab">再出</span>'
        + modelHTML('image', 'text_to_image', gens.pic.model)
        + countHTML(cap, siteCountOf('pic', cap, picDef))
        + '<button class="ghost" type="button" data-d-act="morecand" data-k="' + esc(kind) + '">再出 ' + siteCountOf('pic', cap, picDef) + ' 张</button></div>'
        + '</div>'
      : '';
    /* 身份锚点：认人最准的那一张 */
    const anchors = faces.length > 1
      ? '<div class="md-mrow"><div class="md-mt">身份锚点</div>'
        + '<div class="ui-hint">出图与参考优先用它。</div>'
        + '<div class="md-anchors">' + faces.map((f, i) => {
          const on = f.src === c.anchor;
          return '<button class="md-anchor' + (on ? ' on' : '') + '" type="button" data-d-act="setanchor" data-src="' + esc(f.src) + '">'
            + ctx.thumbImg(f.src) + '<span>' + (f.src === pic ? '预览图' : '候选 ' + (i + 1)) + '</span></button>';
        }).join('') + '</div>'
        + '<div class="ui-hint" style="margin-top:var(--sp-8)">参考图质量：<span data-q="' + esc(c.id) + '">正在量…</span></div>'
        + '</div>'
      : '';
    return hero + (errHTML ? '<div class="md-err">' + errHTML + '</div>' : '') + bar + anchors + cands;
  }

  /* ---------- 角色资产那一节 ---------- */
  function assetSectionHTML(c) {
    const list = D.Cast.assetsOf(c);
    const tpls = D.Cast.assetTplsOf(c);
    const libProps = D.Lib.list().filter(x => x && D.isPropItem(x));
    const dr = ctx.draftOf(c.id);
    const drTpl = tpls.indexOf(dr.tpl) >= 0 ? dr.tpl : (tpls[0] || 'custom');
    const assetModel = gens.asset.model || ctx.defImgModel();
    const cap = capOf('image', assetModel);
    const rows = list.map(a => {
      const lab = D.Cast.assetName(a);
      const props = libProps.map(p => '<label class="ck sm" title="这一张图上带着「' + esc(p.name) + '」">'
        + '<input type="checkbox" data-a="assetprop" data-id="' + esc(a.id) + '" data-pid="' + esc(p.id) + '"'
        + ((a.propIds || []).indexOf(p.id) >= 0 ? ' checked' : '') + '>' + esc(p.name) + '</label>').join('');
      const rg = rowGens[a.id] || {};
      return '<div class="ui-asset" data-aid="' + esc(a.id) + '">'
        + '<span class="ui-cand" data-a="zoom" data-src="' + esc(a.src) + '" data-label="' + esc((c.name || '') + ' · ' + lab) + '">' + ctx.thumbImg(a.src) + '</span>'
        + '<input class="ui-inp" data-a="assetrename" data-id="' + esc(a.id) + '" maxlength="24" value="' + esc(lab) + '" title="这一张叫什么">'
        /* 这一行重出用**这一行自己的**型号与数量（记在 rowGens 里，重出时读它） */
        + '<span class="md-row-gen"><span class="md-row-gen-l">重出</span>'
        + modelHTML('image', 'text_to_image', rg.model || gens.asset.model, a.id)
        + countHTML(cap, rg.count || 1, '张', a.id) + '</span>'
        + '<button class="ui-linkbtn" data-a="assetregen" data-id="' + esc(a.id) + '">重出这一张</button>'
        + '<button class="ui-linkbtn" data-a="reuse" data-src="' + esc(a.src || '') + '" data-name="' + esc(lab) + '" title="去工作台">拿去生成</button>'
        + '<button class="ui-linkbtn" data-a="assetclear" data-id="' + esc(a.id) + '" data-label="' + esc(lab) + '">去掉这一张</button>'
        + (libProps.length ? '<span class="ui-props">' + props + '</span>' : '<span class="ui-hint sm">还没有道具</span>')
        + '</div>';
    }).join('');
    /* 加一张：名字 / 模板 / 自定义描述 / 型号 / 张数 —— 五样各管一件事。
       「自定义」那一档没有固定提示词，所以那一格只有选了自定义才用得上（选别的时它是灰的）。 */
    const bar = genBar({
      site: 'asset', label: '加一张', kind: 'image', mode: 'text_to_image', cap: cap, def: 1,
      act: 'AI 出这一张',
      why: '照「' + shortLab(ctx.kindFields(c).look.lab) + '」这一句画',
      extra: '<input class="ui-inp md-asset-name" data-a="assetname" maxlength="24" value="' + esc(dr.name) + '" placeholder="叫什么">'
        + '<select class="ui-inp md-asset-tpl" data-a="assettpl">' + tpls.map(k => '<option value="' + esc(k) + '"' + (k === drTpl ? ' selected' : '') + '>' + esc(D.Cast.assetLabel(c, k) || k) + '</option>').join('') + '</select>'
        + '<button class="ghost" type="button" data-d-act="assetpick">' + (window.icon ? window.icon('upload', 12) : '') + '自己传一张</button>',
      extra2: '<label class="md-what"><span>选「自定义」时要画什么</span>'
        + '<input class="ui-inp" data-a="assetwhat" maxlength="60" value="' + esc(dr.what) + '" placeholder="例：雨天造型、侧脸特写"></label>',
    });
    return '<section class="md-sec"><div class="md-sec-t">角色资产<span class="md-sec-n">' + list.length + ' 张</span></div>'
      + bar
      + (rows ? '<div class="ui-assets">' + rows + '</div>' : '')
      + '</section>';
  }

  /* ---------- 声音那一节：整块用数据层那一份（按这一位的定声音方式渲染） ---------- */
  function voiceSectionHTML(c) {
    const cap = voiceCapOf();
    const def = voiceDefOf();
    const n = siteCountOf('voice', cap, def);
    const o = ctx.optsWith(gens.voice.model || ctx.defTtsModel(), n);
    const bar = genBar({
      site: 'voice', label: '声音', kind: 'audio', mode: 'text_to_speech', cap: cap, unit: '条', def: def,
      act: '出 ' + n + ' 条试听',
      why: '照「' + shortLab(ctx.kindFields(c).bio.lab) + '」这一句定音色',
    });
    return '<section class="md-sec"><div class="md-sec-t">声音</div>'
      + bar
      + D.Cast.voiceRowHTML(ctx.REG, o, c, { waiting: ctx.genMsg('voicecands', c.id) })
      + '</section>';
  }

  /* ---------- 文档那一栏（右边） ---------- */
  function docHTML(c) {
    const kf = ctx.kindFields(c);
    const isActor = !D.isSceneItem(c) && !D.isPropItem(c);
    const vo = isActor && D.voiceOnlyOf(c);
    const out = [];
    out.push('<section class="md-sec"><div class="md-sec-t">基本信息</div>'
      + '<div class="md-row3">'
      + '<label class="md-field"><span>名字</span><input class="ui-inp" data-f="name" value="' + esc(c.name || '') + '" maxlength="20"></label>'
      + '<label class="md-field"><span>类型</span><select class="ui-inp" data-f="kind">'
      + Object.keys(D.LIB_KINDS).map(k => '<option value="' + k + '"' + (k === D.libKindOf(c) ? ' selected' : '') + '>' + D.LIB_KINDS[k] + '</option>').join('')
      + '</select></label>'
      + '<label class="md-field"><span>分组</span><input class="ui-inp" data-f="group" value="' + esc(c.group || '') + '" maxlength="20" placeholder="例：校园篇主要角色"></label>'
      + '</div>'
      + (isActor ? '<label class="md-check"><input type="checkbox" data-f="voiceOnly"' + (D.voiceOnlyOf(c) ? ' checked' : '') + '> 只出声（不出镜）</label>' : '')
      + '</section>');

    out.push('<section class="md-sec"><div class="md-sec-t">描述</div>'
      + '<label class="md-field"><span>' + esc(kf.look.lab) + '</span>'
      + '<textarea class="ui-ta" data-f="look" rows="3" placeholder="' + esc(kf.look.ph) + '">' + esc(c.look || c.desc || '') + '</textarea></label>'
      + (D.isSceneItem(c)
        ? '<label class="md-field"><span>' + esc(kf.time.lab) + '</span><select class="ui-inp" data-f="time" style="max-width:220px">' + D.Cast.timeOptsHTML(c) + '</select></label>'
        : '')
      + '<label class="md-field"><span>' + esc(kf.bio.lab) + '</span>'
      + '<input class="ui-inp" data-f="bio" value="' + esc(c.bio || '') + '" placeholder="' + esc(kf.bio.ph) + '"></label>'
      + (vo ? '<div class="ui-hint">只出声，不出画面。</div>' : '')
      + (D.isPropItem(c) ? '<div class="ui-hint">道具只有这一张图。</div>' : '')
      + '</section>');

    if (isActor && !vo) out.push(assetSectionHTML(c));
    if (isActor && !vo) out.push(voiceSectionHTML(c));

    /* 使用关系：被引用过才有这一节 */
    const uses = ctx.refUse.get(String(c.name || '')) || [];
    if (uses.length) {
      out.push('<section class="md-sec"><div class="md-sec-t">使用关系 · ' + uses.length + ' 个镜头</div>'
        + uses.slice(0, 12).map(u => '<div class="insp-use"><span>' + esc(u.pname) + '</span><span>' + esc(u.shname) + '</span><span>' + esc(u.sname) + '</span></div>').join('')
        + (uses.length > 12 ? '<div class="ui-hint">还有 ' + (uses.length - 12) + ' 处没列出来。</div>' : '')
        + '</section>');
    }
    return '<div class="md-doc-inner">' + out.join('') + '</div>';
  }

  /* ---------- 整层 ---------- */
  function layerHTML() {
    const c = live;
    const name = isNew ? '新建素材' : (c.name || '这条素材');
    const kind = isNew ? draft.kind : D.libKindOf(c);
    const tags = '<span class="ui-tag">' + esc(D.LIB_KINDS[kind] || kind) + '</span>'
      + (!isNew && c.group ? '<span class="ui-tag">' + esc(c.group) + '</span>' : '');
    const stat = isNew ? '' : detailDots(D, c) + detailStat(D, c);
    return '<header class="md-head">'
      + '<button class="ghost md-back" type="button" data-d-act="close">' + (window.icon ? window.icon('arrowLeft', 13) : '') + (isNew ? '取消' : '返回素材库') + '</button>'
      + '<div class="md-title"><span class="mname">' + esc(name) + '</span>' + tags + '</div>'
      + stat
      + '<span class="sp"></span>'
      + (isNew
        ? '<span class="md-saved is-new">还没存进库 · 填完存进素材库</span>'
        : '<span class="md-saved">' + (window.icon ? window.icon('check', 12) : '') + '已存到本机 · 刚刚存过</span>')
      + '</header>'
      + '<div class="md-body"><aside class="md-media">' + mediaHTML(c) + '</aside>'
      + '<div class="md-doc">' + docHTML(c) + '</div></div>'
      + '<footer class="md-foot">'
      + (isNew
        ? '<button class="ghost" type="button" data-d-act="saveonly">只存文字</button><span class="sp"></span>'
          + '<button class="pri" type="button" data-d-act="create">' + (window.icon ? window.icon('check', 12) : '') + '建好这一条</button>'
        : '<button class="ghost danger" type="button" data-d-act="del">' + (window.icon ? window.icon('trash', 12) : '') + '从库里删掉</button>'
          + '<span class="sp"></span>'
          + '<span class="md-foot-tip">改完就地存 · 这一条已经在库里了</span><span class="sp"></span>'
          + '<button class="ghost" type="button" data-d-act="reuse">' + (window.icon ? window.icon('reuse', 12) : '') + '拿去生成</button>'
          + '<button class="ghost" type="button" data-d-act="similar">' + (window.icon ? window.icon('eye', 12) : '') + '找相似素材</button>')
      + '</footer>';
  }

  function paint() {
    if (!host || !live) return;
    const top = host.scrollTop;
    host.innerHTML = layerHTML();
    if (window.Dropdowns) window.Dropdowns.build(host);
    if (window.Wb && window.Wb.thumbs) window.Wb.thumbs.bindAll(host);
    host.scrollTop = top;
    syncAssetWhat();
    if (!isNew && ctx.measureQuality) ctx.measureQuality(live, host);
  }

  /* ---------- 开 / 关 ---------- */
  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.className = 'md-layer';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-label', '素材详情');
    (ctx.hostEl || document.body).appendChild(host);
    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    host.addEventListener('focusout', onFocusOut);
    return host;
  }
  function openItem(id) {
    const c = D.Lib.get(id);
    if (!c) { Toast.warn('这一条已经不在了'); return; }
    live = c; isNew = false; draft = null;
    ensureHost();
    paint();
  }
  function openNew(fields) {
    /* 新建态：先填字段，再出图 —— 出图之前这一条还没建档 */
    const f = fields || {};
    live = {
      id: 'draft_' + Date.now().toString(36), name: f.name || '', kind: f.kind || 'actor',
      group: f.group || '', look: f.look || '', bio: f.bio || '',
      desc: f.kind === 'scene' ? (f.look || '') : '',
      time: f.kind === 'scene' ? (f.time || '深夜') : '',
      faces: [], voice: '', voiceName: '', voiceNote: '', voiceMode: '', assets: [],
    };
    draft = { kind: f.kind || 'actor' };
    isNew = true;
    ensureHost();
    paint();
  }
  function closeLayer() {
    if (!host) return;
    live = null; isNew = false; draft = null;
    host.remove(); host = null;
    ctx.onClose && ctx.onClose();
  }
  function layerIsOpen() { return !!live; }

  /* ---------- 事件 ---------- */
  function saveItem(c) {
    const ok = ctx.libSave(c);
    ctx.render && ctx.render();
    return ok;
  }
  /* 一张表：层里所有动作（数据层那几个标记与这一层自己那几个都从这里走） */
  const ACTS = {
    close: () => closeLayer(),
    pickface: (c) => pickFace(c),
    assetpick: (c) => pickAsset(c),
    morecand: (c, el) => moreCands(c, el.dataset.k || ctx.mainKind(c)),
    setanchor: (c, el) => {
      c.anchor = el.dataset.src;
      saveItem(c);
      Toast.receipt('锚点已设为这一张');
      paint();
    },
    usecand: (c, el) => useCand(c, el.dataset.k || ctx.mainKind(c), el.dataset.src),
    canddel: (c, el) => dropCand(c, el.dataset.k || ctx.mainKind(c), el.dataset.src),
    zoom: (c, el) => ctx.openZoom(c, el.dataset.label || el.dataset.name || '图', el.dataset.src),
    assetregen: (c, el) => regenAsset(c, el.dataset.id),
    assetclear: (c, el) => clearAsset(c, el.dataset.id, el.dataset.label),
    assetprop: (c, el) => pickAssetProps(c, el),
    reuse: (c, el) => {
      const s2 = el.dataset.src || D.picOf(c);
      if (!s2) return Toast.err('这一条还没有图，先出或挑一张');
      window.Wb.reuse.go({ from: 'chars', mtype: '图片', src: s2, name: el.dataset.name || c.name || '' });
    },
    voice: (c, el) => {
      c.voice = el.dataset.vid;
      c.voiceName = D.Cast.voiceName(ctx.REG, voiceOpts(), c.voice, c.voiceMode);
      saveItem(c); paint();
    },
    voiceway: (c, el) => {
      const w = D.Pipe.setVoiceWay(ctx.REG, voiceOpts(), c, el.dataset.way);
      c.voiceBy = ''; c.voiceName = D.Cast.voiceName(ctx.REG, voiceOpts(), c.voice, w.mode);
      saveItem(c);
      if (w.fellback) Toast.err('这个平台没有「' + D.Cast.wayLabel(el.dataset.way) + '」的型号，这一位现在按「' + D.Cast.wayLabel(w.mode) + '」出声');
      paint();
    },
    play: (c) => preview(c),
    vgen: (c, el) => genVoice(c, Number(el.dataset.n) || 2),
    vplay: (c, el) => playAsset(el.dataset.src),
    vuse: (c, el) => {
      c.voice = el.dataset.vid;
      c.voiceName = el.dataset.vname || D.Cast.voiceName(ctx.REG, voiceOpts(), c.voice, c.voiceMode);
      saveItem(c);
      Toast.receipt('这一位以后按「' + (c.voiceName || c.voice) + '」念');
      paint();
    },
    vclone: (c, el) => cloneFrom(c, el.dataset.src, el.dataset.name),
    vnotepick: (c) => takeNote(c),
    vaudiopick: (c) => takeAudio(c),
    refaudio: (c) => pickRefAudio(c),
    refclear: (c) => clearRef(c),
    del: (c) => del(c),
    similar: (c) => ctx.findSimilar(c, ''),
    create: () => create(false),
    saveonly: () => create(true),
    gen: (c, el) => runGen(el.dataset.site),
  };

  async function onClick(e) {
    const t = e.target && e.target.closest ? e.target.closest('[data-d-act],[data-act],[data-a]') : null;
    if (!t || !host.contains(t)) return;
    const c = live;
    if (!c) return;
    const a = t.dataset.dAct || t.dataset.act || t.dataset.a || '';
    if (!a) return;
    /* 输入框那一类不在这里派发（改名 / 模板 / 描述在 input / change 里走） */
    if (a === 'assetname' || a === 'assetwhat' || a === 'assettpl' || a === 'assetrename' || a === 'voicenote') return;
    const fn = ACTS[a];
    if (!fn) return;
    e.stopPropagation();
    try { await fn(c, t); } catch (err) { Toast.err(ctx.errText(err)); }
  }

  function onInput(e) {
    const t = e.target;
    const c = live;
    if (!t || !c) return;
    if (t.dataset && t.dataset.f) {
      if (t.tagName === 'SELECT' || t.type === 'checkbox') return;
      c[t.dataset.f] = t.value;
      /* 新建态：这一条还没进库，改字段只改草稿 —— 不能触发写库。 */
      if (t.dataset.f !== 'name' && !isNew) ctx.queueFieldSave(c);
      return;
    }
    if (t.dataset && t.dataset.a === 'assetname') { ctx.syncDraft(c, t); return; }
    if (t.dataset && t.dataset.a === 'assetwhat') { ctx.syncDraft(c, t); return; }
    if (t.dataset && t.dataset.act === 'voicenote') c.voiceNote = t.value;
  }
  function onChange(e) {
    const t = e.target;
    const c = live;
    if (!t || !c) return;
    if (t.dataset && t.dataset.f) {
      /* 新建态：只改草稿，不写库（建档是页脚那颗「建好这一条」的事）。 */
      if (isNew) {
        c[t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value;
        if (t.dataset.f === 'kind') { paint(); return; }
        paint();
        return;
      }
      ctx.saveField(c, t, t.dataset.f);
      paint();
      return;
    }
    /* 模板换了：把草稿记下，并把「自定义描述」那一格按需点亮（不重画 —— 重画会吃掉光标）。 */
    if (t.dataset && t.dataset.a === 'assettpl') { ctx.syncDraft(c, t); syncAssetWhat(); return; }
    if (t.dataset && t.dataset.a === 'assetrename') { renameAssetRow(c, t); return; }
    /* 行内重出参数：这一行自己记一份（重出时读它，不走区块那一档） */
    if (t.dataset && t.dataset.rowModel) {
      rowGens[t.dataset.rowModel] = Object.assign({}, rowGens[t.dataset.rowModel], { model: t.value });
      return;
    }
    if (t.dataset && t.dataset.rowCount) {
      rowGens[t.dataset.rowCount] = Object.assign({}, rowGens[t.dataset.rowCount], { count: Number(t.value) || 0 });
      return;
    }
    /* 生成条上的型号与数量：改了就记在这一处 */
    const bar = t.closest && t.closest('[data-gen]');
    if (bar && t.tagName === 'SELECT') {
      const site = bar.getAttribute('data-gen');
      if (t.classList.contains('gen-model')) gens[site].model = t.value;
      if (t.classList.contains('gen-count')) gens[site].count = Number(t.value) || 0;
      return;
    }
  }
  /* 「自定义」那一档没有固定提示词 —— 只有选了自定义，「要画什么」那一格才用得上。 */
  function syncAssetWhat() {
    const tpl = host && host.querySelector('[data-a="assettpl"]');
    const what = host && host.querySelector('[data-a="assetwhat"]');
    if (!tpl || !what) return;
    const custom = tpl.value === 'custom';
    what.disabled = !custom;
    what.placeholder = custom ? '写清楚要画什么，例：雨天造型、侧脸特写' : '（只有选「自定义」时才用这一格）';
  }
  function onFocusOut(e) {
    const t = e.target;
    const c = live;
    if (!t || !c) return;
    if (t.dataset && t.dataset.f) {
      if (t.type === 'checkbox' || t.tagName === 'SELECT') return;
      ctx.saveField(c, t, t.dataset.f);
      paint();
      return;
    }
    if (t.dataset && t.dataset.act === 'voicenote') { saveItem(c); paint(); }
  }

  /* ---------- 生成条上的动作 ---------- */
  async function runGen(site) {
    const c = live;
    if (!c) return;
    const g = gens[site];
    if (site === 'pic') {
      const model = g.model || ctx.defImgModel();
      const cap = capOf('image', model);
      const n = siteCountOf('pic', cap, ctx.candCount(model));
      const drama = ctx.dramaWith(model);
      await ctx.genRun('face', c.id, c, '正在出「' + (c.name || '这条') + '」的' + ctx.picWord(c) + '（' + n + ' 张）…',
        () => D.Pipe.drawPreview(ctx.REG, drama, c, { count: n, replace: true, onTask: ctx.onTaskHook }));
      paint();
      return;
    }
    if (site === 'asset') {
      const model = g.model || ctx.defImgModel();
      const cap = capOf('image', model);
      const n = siteCountOf('asset', cap, 1);
      const tpl = currentTpl();
      const what = currentWhat();
      if (tpl === 'custom' && !what.trim()) { Toast.err('选「自定义」要写清楚要画什么，例：雨天造型、侧脸特写'); return; }
      const lab = D.Cast.assetLabel(c, tpl) || '这张角色资产';
      const drama = ctx.dramaWith(model);
      const ok = await ctx.genRun('asset#new:' + tpl, c.id, c, '正在出「' + (c.name || '') + '」的' + lab + '…',
        () => D.Pipe.drawCharAsset(ctx.REG, drama, c, tpl, { count: n, name: currentName(), what: what, onTask: ctx.onTaskHook }), false, lab);
      if (ok && ctx.DRAFT) ctx.DRAFT.set(c.id, { name: '', tpl: tpl, what: '' });
      paint();
      return;
    }
    if (site === 'voice') {
      const cap = voiceCapOf();
      const n = siteCountOf('voice', cap, voiceDefOf());
      await genVoice(c, n);
    }
  }
  async function genVoice(c, n) {
    const o = ctx.optsWith(gens.voice.model || ctx.defTtsModel(), n);
    await ctx.genRun('voicecands', c.id, c, '正在给「' + (c.name || '') + '」出 ' + n + ' 条试听…',
      () => D.Pipe.voiceCands(ctx.REG, o, c, {
        onStep: (i, tot, nm) => ctx.genSet('voicecands', c.id, '正在出第 ' + i + ' / ' + tot + ' 条' + (nm ? '（' + nm + '）' : '') + '…'),
      }));
    paint();
  }
  function currentTpl() {
    const el = host && host.querySelector('[data-a="assettpl"]');
    return el ? el.value : 'three';
  }
  function currentName() {
    const el = host && host.querySelector('[data-a="assetname"]');
    return el ? el.value.trim() : '';
  }
  function currentWhat() {
    const el = host && host.querySelector('[data-a="assetwhat"]');
    return el ? el.value.trim() : '';
  }

  /* ---------- 各个动作 ---------- */
  async function pickFace(c) {
    const pw = ctx.picWord(c);
    const got = await window.AssetPicker.open({
      types: ['图片'], multiple: false, limit: 1,
      title: '给「' + (c.name || '') + '」选一张' + pw,
      note: D.isPropItem(c) ? '道具图就是道具自己：挑一张最像的，拍每一段时它都会作为参考图发出去'
        : pw + '是三视图与拍摄时认脸的凭据，挑一张最像的',
    });
    if (got && got[0]) {
      const s2 = await ctx.durablePic(got[0], (c.name || '素材') + '-' + pw);
      if (s2) { D.setPic(c, s2); saveItem(c); paint(); }
    }
  }
  async function pickAsset(c) {
    const got = await window.AssetPicker.open({ types: ['图片'], multiple: false, limit: 1,
      title: '给「' + (c.name || '') + '」加一张角色资产', note: '不靠生成，直接用现成的这一张' });
    if (got && got[0]) {
      const s2 = await ctx.durablePic(got[0], (c.name || '素材') + '-资产');
      if (s2) { D.Cast.addAsset(c, { name: currentName(), tpl: currentTpl(), src: s2 }); saveItem(c); paint(); }
    }
  }
  async function moreCands(c, kind) {
    const model = gens.pic.model || ctx.defImgModel();
    const cap = capOf('image', model);
    const n = siteCountOf('pic', cap, ctx.candCount(model));
    const drama = ctx.dramaWith(model);
    await ctx.genRun('face', c.id, c, '正在给「' + (c.name || '') + '」出 ' + n + ' 张候选…',
      () => D.Pipe.drawPreview(ctx.REG, drama, c, { count: n, onTask: ctx.onTaskHook }));
    paint();
  }
  function useCand(c, kind, s2) {
    if (!s2) return;
    D.setPic(c, s2);
    const ok = !!ctx.libSave(c);
    ctx.render && ctx.render();
    if (!ok) return;
    Toast.receipt('这条现在用这张。已经拍过的段还是旧参考图，要生效得重拍那一段', 'ok', 4200);
    paint();
  }
  function dropCand(c, kind, s2) {
    const list = (c.faces || []).slice();
    const next = list.filter(x => x && x.src !== s2);
    if (next.length === list.length) return;
    c.faces = next;
    if (D.picOf(c) === s2) D.setPic(c, next.length ? next[0].src : '');
    ctx.libSave(c);
    ctx.render && ctx.render();
    paint();
    Toast.receipt('删掉了这一张候选' + (next.length ? '，还剩 ' + next.length + ' 张' : '（这一类清空了）'));
  }
  async function regenAsset(c, id) {
    const a = D.Cast.assetById(c, id);
    if (!a) return Toast.err('这一张已经不在了');
    const lab = D.Cast.assetName(a);
    /* 这一行自己挑的型号与张数（没挑就用区块那一档） */
    const rg = rowGens[id] || {};
    const model = rg.model || gens.asset.model || ctx.defImgModel();
    const cap = capOf('image', model);
    const n = Math.max(1, Math.min(rg.count || 1, cap));
    const drama = ctx.dramaWith(model);
    await ctx.genRun('asset#' + a.id, c.id, c, '正在重出「' + (c.name || '') + '」的' + lab + '…',
      () => D.Pipe.drawCharAsset(ctx.REG, drama, c, a.tpl, { count: n, name: lab, replaceId: a.id, onTask: ctx.onTaskHook }));
    paint();
  }
  async function clearAsset(c, id, lab) {
    const btn = host.querySelector('[data-a="assetclear"][data-id="' + CSS.escape(id) + '"]');
    if (window.Confirm.arm(btn || host, '确认去掉' + (lab || '这一张'),
      { note: '素材库里这一张会空出来；已经拉进某一集的那条不受影响' })) return;
    D.Cast.removeAsset(c, id);
    saveItem(c);
    Toast.receipt('去掉了「' + (c.name || '') + '」的' + (lab || '这一张'));
    paint();
  }
  function pickAssetProps(c, el) {
    const a = D.Cast.assetById(c, el.dataset.id);
    if (!a) return Toast.err('这一张已经不在了');
    const pid = el.dataset.pid;
    const now = (a.propIds || []).slice();
    const i = now.indexOf(pid);
    if (el.checked) { if (i < 0) now.push(pid); } else if (i >= 0) now.splice(i, 1);
    D.Cast.setAssetProps(c, a.id, now);
    saveItem(c);
    paint();
  }
  function renameAssetRow(c, inp) {
    const nm = String(inp.value || '').trim();
    const a = D.Cast.assetById(c, inp.dataset.id);
    if (!a) return;
    if (!nm) { inp.value = D.Cast.assetName(a); Toast.err('名字不能是空的：这是角色资产，没名字就分不清是哪一张'); return; }
    if (nm === D.Cast.assetName(a)) return;
    D.Cast.setAssetName(c, a.id, nm);
    saveItem(c);
    paint();
    Toast.receipt('这一张改叫「' + nm + '」');
  }
  async function preview(c) {
    await ctx.genRun('voice', c.id, c, '正在合成「' + (c.name || '') + '」的试听…', async () => {
      const r = await D.Cast.preview(ctx.REG, voiceOpts(), c, { onStage: m => ctx.genSet('voice', c.id, m) });
      if (r.why) Toast.err(r.why);
      else if (r.label) Toast.ok('试听：' + r.label);
    });
    paint();
  }
  async function playAsset(src) {
    try { const r = await D.Cast.playAsset(src); if (r && r.why) Toast.err(r.why); }
    catch (e) { Toast.err(ctx.errText(e)); }
  }
  async function cloneFrom(c, src, name) {
    const r = D.Pipe.cloneFromCands(ctx.REG, voiceOpts(), c, src, name);
    if (!r.ok) { Toast.err(r.why); return; }
    saveItem(c);
    Toast.receipt('这一位以后按「' + r.name + '」这个声音念（复刻），拉进下一集也是它', 'ok', 6000);
    paint();
  }
  async function takeNote(c) {
    await window.VoiceNote.run({
      value: () => c.voiceNote || '',
      write: txt => { c.voiceNote = txt; c.voiceMode = 'design'; saveItem(c); paint(); },
      say: () => {},
    });
  }
  async function takeAudio(c) {
    await window.VoiceNote.runClone({
      apply: (entry) => {
        const r = D.Pipe.cloneFromLibEntry(ctx.REG, voiceOpts(), c, entry);
        if (!r.ok) { Toast.err(r.why); return; }
        saveItem(c);
        Toast.receipt('这一位以后按「' + r.name + '」这个声音念（复刻），拉进下一集也是它', 'ok', 6000);
        paint();
      },
      say: () => {},
    });
  }
  async function pickRefAudio(c) {
    const rr = D.Cast.refAudioRule(ctx.REG, voiceOpts());
    const got = await window.AssetPicker.open({ types: rr.types, multiple: false, limit: 1,
      title: '给「' + (c.name || '') + '」选一段参考音频', rule: rr.rule, upload: rr.upload });
    if (!got || !got.length) return;
    const it = got[0];
    const b = it.file || await window.Net.blob(it.dl || it.src, { timeout: 120000 });
    if (rr.rule.maxBytes && b.size > rr.rule.maxBytes) return Toast.err('参考音频太大：上限 ' + window.fmtBytes(rr.rule.maxBytes));
    await D.Pipe.saveRefAudio(c, b, (it.prompt || it.name || '参考音频').slice(0, 20));
    saveItem(c);
    paint();
    Toast.receipt('参考音频挂上了，可以试听');
  }
  async function clearRef(c) {
    await D.Pipe.clearRefAudio(c);
    saveItem(c);
    paint();
  }
  async function del(c) {
    const yes = await Confirm.ask({
      title: '删掉「' + (c.name || '这条素材') + '」？',
      body: '会从素材库删掉这条；已写的 @名字 不受影响。',
      okLabel: '删掉', danger: true,
    });
    if (!yes) return;
    if (c.refAudio) { try { await D.Pipe.clearRefAudio(c); } catch (e) { /* 清不掉不拦删除本身 */ } }
    const gone = D.Lib.remove(c.id);
    const e = D.Lib.writeError();
    if (e) Toast.err(e, 9000);
    closeLayer();
    if (gone) Toast.receipt('已删掉「' + (c.name || '这条素材') + '」');
  }

  /* ---------- 新建：建档 ---------- */
  async function create(onlyText) {
    const c = live;
    if (!c) return;
    const f = {
      name: String(c.name || '').trim().slice(0, 20),
      kind: c.kind, group: String(c.group || ''), look: String(c.look || ''),
      bio: String(c.bio || ''), time: String(c.time || '深夜'),
      pic: onlyText ? '' : D.picOf(c),
      faces: onlyText ? [] : (c.faces || []).slice(),
      voice: onlyText ? null : (c.voice ? {
        voice: c.voice, voiceName: c.voiceName, voiceNote: c.voiceNote, voiceMode: c.voiceMode,
        refAudio: c.refAudio, refAudioName: c.refAudioName, voiceBy: c.voiceBy,
      } : null),
    };
    if (!f.name) { Toast.err('名字不能空着'); return; }
    const r = D.Lib.commitForm(f);
    if (!r || r.error) { Toast.err((r && r.error) || '没能建档'); return; }
    const saved = r.item;
    closeLayer();
    Toast.receipt('建好了：' + saved.name + '。' + (r.tip || ''));
    ctx.render && ctx.render();
    ctx.onCreated && ctx.onCreated(saved);
  }

  function shortLab(lab) { return String(lab || '').split('（')[0].trim(); }

  return {
    open: openItem, openNew, close: closeLayer, isOpen: layerIsOpen, paint,
    get live() { return live; },
    destroy() { if (host) { host.remove(); host = null; } },
  };
}
