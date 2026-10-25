/* ============================================================================
   新建素材 / 编辑素材 —— 布局稿的演示脚手架（不进产品）
   ---------------------------------------------------------------------------
   真品里这些行为都在数据层与公共层里实现了（Chars.Lib.newForm / Chars.Cast / PromptForm …），
   稿子里只把**结构上的那几个动作**做成能点的，好让人看清布局怎么用：
     · 状态切换：新建（空骨架）/ 新建出图后 / 编辑角色 / 编辑场景 / 编辑道具
     · 「类型」那一格：换了类型，右栏的分节当场增减（时段只给场景、角色资产与声音只给角色）
     · 每个生成位都有自己的型号 + 数量（生成条），改一处不动别处
     · 左下角「换背景」：切深色档（令牌自动派生，不另设计）
   ========================================================================== */
(function () {
  'use strict';

  var IMG = {
    cand2: 'assets/linwan-cand2.jpg',
    cand3: 'assets/linwan-cand3.jpg',
    cand4: 'assets/linwan-cand4.jpg',
    three: 'assets/linwan-asset-threeview.jpg',
    expr: 'assets/linwan-asset-expression.jpg',
    rooftop: 'assets/scene-rooftop.jpg',
    umbrella: 'assets/prop-umbrella.jpg',
  };

  var KIND_LABEL = { actor: '角色', scene: '场景', prop: '道具' };
  /* 措辞取自真品的数据层（Chars 的 KIND_FIELDS）：新建弹窗与卡片编辑区读的是同一份表。 */
  var KIND_FIELDS = {
    actor: {
      look: { lab: '外貌 / 人物特点（预览图与角色资产都靠它）', ph: '例：二十出头，齐肩黑发，总穿米色风衣' },
      bio: { lab: '一句话人设（发给文字 AI 当「人物特点」）', ph: '例：嘴硬心软的师姐，嘴上不饶人但每次都替别人收尾' },
    },
    scene: {
      look: { lab: '场景描述（出场景图靠它）', ph: '例：教学楼天台，傍晚，铁栏杆与晾衣绳' },
      bio: { lab: '一句话说明（这一处是什么地方：只进搜索与文字 AI，不影响出图）', ph: '例：两人摊牌的地方，视野开阔但没有能躲的角落' },
      time: { lab: '时段（出这张场景图时那句「…的光线」用的就是它）' },
    },
    prop: {
      look: { lab: '道具描述（出道具图就靠它）', ph: '例：牛皮纸旧信封，边角磨白，盖一枚红蓝邮票' },
      bio: { lab: '一句话用途（剧情里这件东西干什么用，发给文字 AI）', ph: '例：用来交代那半页没写完的地址' },
    },
  };
  var TIME_OFS = ['深夜', '白天', '黄昏', '清晨'];

  /* 出图模板（真品 Chars.Cast.ASSET_KINDS 的五档） */
  var ASSET_TPLS = ['三视图', '表情表', '服装', '手持道具', '自定义'];
  /* 声音方式（真品 Chars.Cast.voiceWaySeg：只列这一家真有型号的方式） */
  var VOICE_WAYS = ['预设音色', '写声音描述', '复刻参考音频'];
  /* 平台（型号下拉按平台分组，真品 modelGroups 的口径） */
  var IMAGE_MODELS = [
    { group: 'FLUX', items: ['FLUX.1 dev', 'FLUX.1 schnell'] },
    { group: '可灵', items: ['可灵 2.1', '可灵 2.0'] },
    { group: '即梦', items: ['即梦 3.0', '即梦 2.0'] },
  ];
  var TTS_MODELS = [
    { group: 'MiniMax', items: ['云希 2.0', '小夜'] },
    { group: '火山引擎', items: ['星火 2.0'] },
  ];
  var VOICE_PRESETS = ['云希', '小夜', '星火', '沐辰', '稚柳', '青涩'];

  var STATES = {
    new: {
      isNew: true, kind: 'actor', name: '', group: '', look: '', bio: '',
      pics: [], cur: -1, anchor: -1, assets: [], voice: null, uses: [],
      hint: '先填右边的名字与外貌，再按「AI 出第一张」—— 出完挑一张，存进素材库。',
    },
    newPick: {
      isNew: true, kind: 'actor', name: '林晚', group: '校园篇',
      look: '二十出头，齐肩黑发，校服外套，总把书角折起来。',
      bio: '嘴硬心软的师姐，嘴上不饶人但每次都替别人收尾。',
      pics: [{ src: IMG.cand3, name: '第 1 张' }, { src: IMG.cand2, name: '第 2 张' }, { src: IMG.cand4, name: '第 3 张' }],
      cur: 0, anchor: 0, assets: [], voice: null, uses: [],
      hint: '出了 3 张 —— 挑一张当预览图，剩下的可以删掉。挑好再存进库。',
    },
    actor: {
      isNew: false, kind: 'actor', name: '林晚', group: '校园篇',
      look: '二十出头，齐肩黑发，校服外套，总把书角折起来。说话慢，但一句是一句。',
      bio: '嘴硬心软的师姐，嘴上不饶人但每次都替别人收尾。',
      pics: [{ src: IMG.cand3, name: '第 1 张' }, { src: IMG.cand2, name: '第 2 张' }, { src: IMG.cand4, name: '第 3 张' }],
      cur: 0, anchor: 0,
      assets: [
        { src: IMG.three, name: '三视图', tpl: '三视图', props: ['黑色雨伞'] },
        { src: IMG.expr, name: '表情表', tpl: '表情表', props: [] },
      ],
      voice: { model: '云希 2.0', way: '预设音色', preset: '云希', by: '手动挑的' },
      uses: [['第 3 集', '第 12 镜', '雨夜校门'], ['第 3 集', '第 19 镜', '教学楼天台'], ['第 5 集', '第 2 镜', '空教室']],
    },
    scene: {
      isNew: false, kind: 'scene', name: '教学楼天台', group: '校园篇', time: '黄昏',
      look: '教学楼天台，傍晚，铁栏杆与晾衣绳，水塔在楼角。',
      bio: '两人摊牌的地方，视野开阔但没有能躲的角落。',
      pics: [{ src: IMG.rooftop, name: '预览图' }],
      cur: 0, anchor: 0, assets: [], voice: null,
      uses: [['第 3 集', '第 19 镜', '雨夜校门'], ['第 5 集', '第 6 镜', '空教室']],
    },
    prop: {
      isNew: false, kind: 'prop', name: '黑色雨伞', group: '雨夜篇',
      look: '黑色长柄伞，伞骨断过一根，用灰胶带缠着。',
      bio: '用来交代那半页没写完的地址。',
      pics: [{ src: IMG.umbrella, name: '预览图' }],
      cur: 0, anchor: 0, assets: [], voice: null, uses: [],
    },
  };

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var ic = function (name, size) {
    var b = {
      back: '<path d="M12.8 8H3.4"/><path d="M7 3.8 3.2 8 7 12.2"/>',
      wand: '<path d="M3 13 10.6 5.4"/><path d="M12 2.2l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/><path d="M4.6 2.4l.3 1 1 .3-1 .3-.3 1-.3-1-1-.3 1-.3z"/>',
      upload: '<path d="M8 10.6V3.2M5.2 6L8 3.2 10.8 6M3.4 12.4h9.2"/>',
      trash: '<path d="M2.6 4.4h10.8"/><path d="M6.3 4.4V3.3a.9.9 0 0 1 .9-.9h1.6a.9.9 0 0 1 .9.9v1.1"/><path d="M4.4 4.4l.5 8.2a1.1 1.1 0 0 0 1.1 1.1h4a1.1 1.1 0 0 0 1.1-1.1l.5-8.2"/>',
      reuse: '<path d="M12.8 6.6A5.1 5.1 0 0 0 4 4.8"/><path d="M12.8 2.8v3.8H9"/><rect x="4.4" y="9" width="5.6" height="4.4" rx="1.1"/>',
      eye: '<path d="M1.8 8S4.1 4.3 8 4.3 14.2 8 14.2 8 11.9 11.7 8 11.7 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>',
      play: '<path d="M5.1 3.5 12.5 8l-7.4 4.5z" fill="currentColor" stroke-linejoin="round"/>',
      pencil: '<path d="M11.4 2.7l1.9 1.9L6 12l-2.6.6L4 10z"/>',
      check: '<path d="M3.4 8.4 6.4 11.4l6.2-6.6"/>',
      copy: '<rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.4"/><path d="M10.6 5.4V4a1.4 1.4 0 0 0-1.4-1.4H4a1.4 1.4 0 0 0-1.4 1.4v5.2A1.4 1.4 0 0 0 4 10.6h1.4"/>',
      plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
      mic: '<rect x="6.2" y="2.3" width="3.6" height="6.6" rx="1.8"/><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8V14M5.9 14h4.2"/>',
    }[name] || '';
    var s = size || 13;
    return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor"'
      + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + b + '</svg>';
  };

  /* ---------- 下拉：按平台分组（真品 modelGroups 的口径） ---------- */
  function modelSelect(groups, cur, cls) {
    return '<select class="' + (cls || 'ui-inp') + '">' + groups.map(function (g) {
      return '<optgroup label="' + esc(g.group) + '">' + g.items.map(function (m) {
        return '<option' + (m === cur ? ' selected' : '') + '>' + esc(m) + '</option>';
      }).join('') + '</optgroup>';
    }).join('') + '</select>';
  }

  /* ---------- 生成条（公共件）：型号 + 数量 + 动作，参数永远贴着它要生成的东西 ----------
     `stack: true` 是窄栏那种摆法：参数一行、动作一行（440px 那一栏挤不下一行）。 */
  function genBar(o) {
    var counts = [];
    for (var i = 1; i <= o.cap; i++) counts.push(i);
    var params = '<div class="gen-row"><span class="gen-lab">' + esc(o.label) + '</span>'
      + modelSelect(o.models, o.model, 'gen-model')
      + '<select class="gen-count">' + counts.map(function (n) {
        return '<option' + (n === o.count ? ' selected' : '') + '>' + n + ' ' + esc(o.unit) + '</option>';
      }).join('') + '</select>'
      + (o.stack ? '' : (o.extra || ''))
      + '<span class="sp"></span>'
      + (o.stack ? '' : '<button class="pri gen-act" type="button">' + ic(o.icon || 'wand', 12) + esc(o.act) + '</button>')
      + '</div>';
    var acts = o.stack
      ? '<div class="gen-row gen-row-acts">' + (o.extra || '') + '<span class="sp"></span>'
        + '<button class="pri gen-act" type="button">' + ic(o.icon || 'wand', 12) + esc(o.act) + '</button></div>'
      : '';
    return '<div class="gen-bar' + (o.stack ? ' is-stack' : '') + '">' + params + acts
      + '<div class="gen-why"><span>' + esc(o.why) + '</span></div>'
      + '</div>';
  }

  /* 依据那句话用**短标签**（「外貌 / 人物特点」而不是带一整句括注的那个）——
     完整说法在上面的「描述」区里已经写着，不必在这里再抄一遍。 */
  function shortLab(lab) { return String(lab || '').split('（')[0].trim(); }

  /* ---------- 完备度点阵（与素材库那一稿同一套形状语言） ---------- */
  function slots(s) {
    var isActor = s.kind === 'actor';
    return [
      { ok: !!s.pics[s.cur], na: false },
      { ok: isActor ? s.assets.length > 0 : null, na: !isActor },
      { ok: isActor ? !!s.voice : null, na: !isActor },
      { ok: !!(s.look || '').trim(), na: false },
    ];
  }
  function dotsHTML(s) {
    return '<span class="md-dots">' + slots(s).map(function (x) {
      if (x.na) return '<i class="na"></i>';
      return x.ok ? '<i class="ok"></i>' : '<i class="miss"></i>';
    }).join('') + '</span>';
  }
  function statHTML(s) {
    var sl = slots(s);
    var miss = sl.filter(function (x) { return !x.na && !x.ok; }).length;
    if (!miss) return '<span class="md-stat">齐了</span>';
    return '<span class="md-stat ' + (miss > 1 ? 'is-err' : 'is-warn') + '">缺 ' + miss + ' 项</span>';
  }

  /* ---------- 头栏 ---------- */
  function headHTML(s) {
    var isNew = s.isNew;
    var tags = isNew ? '' : '<span class="ui-tag">' + KIND_LABEL[s.kind] + '</span>'
      + (s.group ? '<span class="ui-tag">' + esc(s.group) + '</span>' : '');
    return '<button class="ghost md-back" type="button">' + ic('back', 13) + (isNew ? '取消' : '返回素材库') + '</button>'
      + '<div class="md-title"><span class="md-name">' + (isNew ? '新建素材' : esc(s.name)) + '</span>' + tags + '</div>'
      + (isNew ? '' : dotsHTML(s) + statHTML(s))
      + '<span class="sp"></span>'
      + (isNew
        ? '<span class="md-saved is-new">还没存进库 · 填完存进素材库</span>'
        : '<span class="md-saved">' + ic('check', 12) + '已存到本机 · 刚刚存过</span>');
  }

  /* ---------- 左栏：画面（预览图 + 它的生成条 + 锚点 + 候选） ---------- */
  function mediaHTML(s) {
    var cur = s.pics[s.cur];
    var hero = cur
      ? '<div class="md-hero"><img src="' + cur.src + '" alt="预览图"></div>'
      : '<div class="md-hero is-empty"><div class="mh-empty"><div class="t">还没有预览图</div>'
        + '<div class="s">' + (s.kind === 'scene'
          ? '场景图照着上面那段描述出，先把地方的样子写清楚。'
          : s.kind === 'prop' ? '道具图照着上面那段描述出。'
            : '先写清长什么样，出图会照着那一句来；也可以自己传一张。') + '</div></div></div>';

    /* 预览图这一处**自带**型号与数量：出图这一位用哪个型号、出几张，在这里定，
       不吃全页那一档。 */
    var picWord = s.kind === 'scene' ? '场景图' : s.kind === 'prop' ? '道具图' : '预览图';
    var whyPic = s.kind === 'scene'
      ? '照「' + shortLab(KIND_FIELDS.scene.look.lab) + '」这一句画 · 光线按「' + (s.time || '深夜') + '」走'
      : s.kind === 'prop'
        ? '照「' + shortLab(KIND_FIELDS.prop.look.lab) + '」这一句画 · 道具只有这一张图'
        : '照「' + shortLab(KIND_FIELDS.actor.look.lab) + '」这一句画';
    var picBar = genBar({
      label: '出图', model: 'FLUX.1 dev', count: 4, unit: '张', cap: 4, models: IMAGE_MODELS,
      act: cur ? '重出' + picWord : 'AI 出第一张',
      why: whyPic + (s.kind === 'actor' ? ' · 出图只做这一张预览图' : ''),
      stack: true,
      extra: '<button class="ghost" type="button">' + ic('upload', 12) + '自己传一张</button>',
    });

    var anchors = '';
    if (s.pics.length > 1) {
      anchors = '<div class="md-mrow"><div class="md-mt">身份锚点</div>'
        + '<div class="ui-hint">锚点是「认人最准的那一张」：出图、出角色资产与导演台取参考图时优先用它。</div>'
        + '<div class="md-anchors">' + s.pics.map(function (p, i) {
          return '<button class="md-anchor' + (i === s.anchor ? ' on' : '') + '" type="button">'
            + '<img src="' + p.src + '" alt=""><span>' + (i === s.cur ? '预览图' : '候选 ' + (i + 1)) + '</span></button>';
        }).join('') + '</div></div>';
    }

    var cands = '';
    if (s.pics.length > 1) {
      cands = '<div class="md-mrow"><div class="md-mt">预览图候选<span class="n">' + s.pics.length + ' 张</span></div>'
        + '<div class="ui-cands"><span class="lab">候选</span>' + s.pics.map(function (p, i) {
          var on = i === s.cur;
          return '<span class="ui-cand' + (on ? ' on' : '') + '"><img src="' + p.src + '" alt="">'
            + '<span class="t">' + esc(p.name) + '</span>'
            + '<button class="ui-linkbtn" type="button"' + (on ? ' disabled' : '') + '>' + (on ? '在用' : '用这一张') + '</button>'
            + '<button class="ui-linkbtn danger" type="button">删掉</button></span>';
        }).join('') + '</div>'
        /* 候选排的尾巴：再出一批 —— 这一批也自带型号与数量 */
        + '<div class="gen-row gen-row-inline">'
        + '<span class="gen-lab">再出</span>'
        + modelSelect(IMAGE_MODELS, 'FLUX.1 dev', 'gen-model')
        + '<select class="gen-count"><option>2 张</option><option selected>4 张</option></select>'
        + '<button class="ghost" type="button">' + ic('wand', 12) + '再出 4 张</button>'
        + '</div>'
        + '<div class="gen-why"><span>候选最多留 8 张 —— 攒到上限后最早的几张会被换掉（那几张是真金白银出的）。</span></div>'
        + '</div>';
    }

    var hint = s.hint ? '<div class="md-mrow"><div class="ui-note info">' + esc(s.hint) + '</div></div>' : '';
    return hero + picBar + anchors + cands + hint;
  }

  /* ---------- 角色资产区 ---------- */
  function assetSectionHTML(s) {
    var rows = s.assets.map(function (a) {
      return '<div class="md-asset">'
        + '<img src="' + a.src + '" alt="">'
        + '<input class="ui-inp" value="' + esc(a.name) + '" maxlength="24">'
        + '<span class="ui-tag">' + esc(a.tpl) + '</span>'
        + (a.props.length
          ? '<span class="md-props"><span class="md-props-l">带着</span>'
            + a.props.map(function (p) { return '<span class="ui-tag">' + esc(p) + '</span>'; }).join('')
            + '<button class="ui-linkbtn" type="button">改</button></span>'
          : '<span class="md-props"><span class="md-props-l">没带道具</span></span>')
        + '<span class="sp"></span>'
        /* 这一行重出用**这一行自己的**型号与数量 */
        + '<span class="md-row-gen"><span class="md-row-gen-l">重出</span>'
        + modelSelect(IMAGE_MODELS, 'FLUX.1 dev', 'gen-model')
        + '<select class="gen-count"><option>1 张</option><option selected>2 张</option></select></span>'
        + '<button class="ui-linkbtn" type="button">拿去生成</button>'
        + '<button class="ui-linkbtn" type="button">去掉这一张</button>'
        + '</div>';
    }).join('');

    /* 加一张：模板 + 型号 + 数量，都在这一条里定；出完是**追加**，不顶掉选中的那张 */
    var addBar = genBar({
      label: '加一张', model: 'FLUX.1 dev', count: 4, unit: '张', cap: 4, models: IMAGE_MODELS,
      act: 'AI 出这一张',
      why: '照「' + shortLab(KIND_FIELDS.actor.look.lab) + '」这一句画 · 拿预览图这一张当参考图 · 出完是追加，不顶掉已经选中的那张',
      extra: '<select class="gen-tpl">' + ASSET_TPLS.map(function (t) {
        return '<option' + (t === '三视图' ? ' selected' : '') + '>' + t + '</option>';
      }).join('') + '</select>'
        + '<button class="ghost" type="button">' + ic('upload', 12) + '自己传一张</button>',
    });

    return '<section class="md-sec md-sec-assets"><div class="md-sec-t">角色资产<span class="md-sec-n">'
      + s.assets.length + ' 张 · 拍摄时作参考图发出去</span></div>'
      + addBar
      + (rows ? '<div class="md-assets">' + rows + '</div>' : '')
      + '<div class="ui-hint" style="margin-top:var(--sp-8)">这些图拍摄时都会作为参考图发给视频 AI（按平台声明的上限截，超出的会点名哪几张没发）。'
      + '出图要一张预览图当参考 —— 没有预览图就只能凭文字重画一个样子。</div>'
      + '</section>';
  }

  /* ---------- 声音区 ---------- */
  function voiceSectionHTML(s) {
    var v = s.voice || {};
    var wave = '';
    for (var i = 0; i < 22; i++) wave += '<i style="height:' + (25 + ((i * 37) % 70)) + '%"></i>';

    /* 声音这一处**自带**型号与条数：试听这一条用哪个型号、出几条，在这里定 */
    var voiceBar = genBar({
      label: '声音', model: v.model || '云希 2.0', count: 4, unit: '条', cap: 4, models: TTS_MODELS,
      act: '试听这一条', icon: 'mic',
      why: '照「' + shortLab(KIND_FIELDS.actor.bio.lab) + '」这一句定音色 · 这一处单独选，不动本页其它地方',
      extra: '<span class="gen-ways">' + VOICE_WAYS.map(function (w) {
        return '<button class="gen-way' + (w === (v.way || VOICE_WAYS[0]) ? ' on' : '') + '" type="button" data-way="' + esc(w) + '">' + w + '</button>';
      }).join('') + '</span>',
    });

    var cur = '<div class="md-voice-now"><span class="md-voice-now-l">在用</span>'
      + '<span class="ui-tag ok">' + esc(v.preset || '云希') + ' · ' + esc(v.by || '手动挑的') + '</span>'
      + '<button class="ui-linkbtn" type="button">' + ic('play', 11) + '试听</button>'
      + '<button class="ui-linkbtn" type="button">改</button></div>';

    /* 这一位「怎么定声音」决定下面摆什么 —— 跟真品 voiceBoxHTML 同一个口径：
       preset → 一排预设音色；design → 一个声音描述输入框；clone → 一段参考音频。
       用不上的那一档不画（摆个空的参考音频框是骗人）。 */
    var way = v.way || VOICE_WAYS[0];
    var wayBody = '';
    if (way === '预设音色') {
      wayBody = '<div class="md-field"><span>这个型号的预设音色</span>'
        + '<div class="md-pills">' + VOICE_PRESETS.map(function (p) {
          return '<button class="ui-pill' + (p === (v.preset || '云希') ? ' on' : '') + '" type="button">' + p + '</button>';
        }).join('') + '</div></div>';
    } else if (way === '写声音描述') {
      wayBody = '<div class="md-field"><span>声音描述（发给语音 AI 当「这个人怎么说话」）</span>'
        + '<input class="ui-inp" value="说话慢，句尾常带一点迟疑。" placeholder="例：偏低、带点沙的女声，语速慢"></div>';
    } else {
      wayBody = '<div class="md-field"><span>参考音频（复刻的嗓子从这儿来）</span>'
        + '<div class="md-ref"><span class="ui-hint">还没有参考音频 —— 复刻要先有一段能听的。</span>'
        + '<button class="ghost" type="button">' + ic('copy', 12) + '用素材库里的另一位</button>'
        + '<button class="ghost" type="button">' + ic('upload', 12) + '自己传一段</button></div></div>';
    }

    var cands = '<div class="md-field"><span>声音候选</span>'
      + '<div class="ui-cands">'
      + '<span class="ui-cand on"><button class="ui-linkbtn" type="button">' + ic('play', 11) + '</button>'
      + '<span class="t">云希 2.0 · 3.2s</span><button class="ui-linkbtn" type="button" disabled>在用</button>'
      + '<button class="ui-linkbtn" type="button">拿这条去克隆</button></span>'
      + '<span class="ui-cand"><button class="ui-linkbtn" type="button">' + ic('play', 11) + '</button>'
      + '<span class="t">小夜 · 4.1s</span><button class="ui-linkbtn" type="button">用这一条</button>'
      + '<button class="ui-linkbtn" type="button">拿这条去克隆</button></span>'
      + '<span class="ui-cand"><button class="ui-linkbtn" type="button">' + ic('play', 11) + '</button>'
      + '<span class="t">云希 2.0 · 2.8s</span><button class="ui-linkbtn" type="button">用这一条</button>'
      + '<button class="ui-linkbtn danger" type="button">删掉</button></span>'
      + '</div></div>';

    return '<section class="md-sec md-sec-voice"><div class="md-sec-t">声音<span class="md-sec-n">这一位说话的声音</span></div>'
      + voiceBar
      + cur
      + wayBody
      + cands
      + '</section>';
  }

  /* ---------- 右栏：一条连续的文档 ---------- */
  function docHTML(s) {
    var kf = KIND_FIELDS[s.kind] || KIND_FIELDS.actor;
    var isActor = s.kind === 'actor';
    var out = [];

    /* ① 基本信息 */
    out.push('<section class="md-sec"><div class="md-sec-t">基本信息</div>'
      + '<div class="md-row3">'
      + '<label class="md-field"><span>名字</span><input class="ui-inp" value="' + esc(s.name) + '"'
      + (s.isNew ? ' placeholder="例：小雅 / 天台 / 旧信封"' : '') + ' maxlength="20"></label>'
      + '<label class="md-field"><span>类型</span><select class="ui-inp" id="kindSel">'
      + Object.keys(KIND_LABEL).map(function (k) {
        return '<option value="' + k + '"' + (k === s.kind ? ' selected' : '') + '>' + KIND_LABEL[k] + '</option>';
      }).join('') + '</select></label>'
      + '<label class="md-field"><span>分组</span><input class="ui-inp" value="' + esc(s.group) + '"'
      + (s.isNew ? ' placeholder="例：校园篇主要角色"' : '') + ' maxlength="20"></label>'
      + '</div>'
      + (isActor ? '<label class="md-check"><input type="checkbox"> 只出声（不出镜）</label>' : '')
      + '</section>');

    /* ② 描述 */
    out.push('<section class="md-sec"><div class="md-sec-t">描述</div>'
      + '<label class="md-field"><span>' + esc(kf.look.lab) + '</span>'
      + '<textarea class="ui-ta" rows="3" placeholder="' + esc(kf.look.ph) + '">' + esc(s.look) + '</textarea>'
      + (s.isNew ? '<div class="md-fhint">这一句是出图的依据 —— 预览图与角色资产都照着它来。</div>' : '')
      + '</label>'
      + (s.kind === 'scene'
        ? '<label class="md-field"><span>' + esc(kf.time.lab) + '</span><select class="ui-inp" style="max-width:220px">'
          + TIME_OFS.map(function (t) {
            return '<option' + (t === (s.time || '深夜') ? ' selected' : '') + '>' + t + '</option>';
          }).join('') + '</select></label>'
        : '')
      + '<label class="md-field"><span>' + esc(kf.bio.lab) + '</span>'
      + '<input class="ui-inp" value="' + esc(s.bio) + '" placeholder="' + esc(kf.bio.ph) + '"></label>'
      + '</section>');

    /* ③ 角色资产（只有角色有；新建时不画 —— 空的那一档不画） */
    if (isActor && !s.isNew) out.push(assetSectionHTML(s));

    /* ④ 声音（只有角色有） */
    if (isActor && !s.isNew) out.push(voiceSectionHTML(s));

    /* ⑤ 使用关系（没被引用过就不画这一节） */
    if (s.uses.length) {
      out.push('<section class="md-sec"><div class="md-sec-t">使用关系 · ' + s.uses.length + ' 个镜头</div>'
        + '<div class="md-uses">' + s.uses.map(function (u) {
          return '<div class="md-use"><span>' + esc(u[0]) + '</span><span>' + esc(u[1]) + '</span><span>' + esc(u[2]) + '</span></div>';
        }).join('') + '</div></section>');
    }

    return '<div class="md-doc-inner">' + out.join('') + '</div>';
  }

  /* ---------- 页脚 ---------- */
  function footHTML(s) {
    if (s.isNew) {
      return '<button class="ghost" type="button">' + ic('pencil', 12) + '先只存文字</button>'
        + '<span class="sp"></span>'
        + '<button class="pri" type="button">' + ic('check', 12) + '建好这一条</button>';
    }
    return '<button class="ghost danger" type="button">' + ic('trash', 12) + '从库里删掉</button>'
      + '<span class="sp"></span>'
      + '<span class="md-foot-tip">改完就地存 · 这一条已经在库里了</span>'
      + '<span class="sp"></span>'
      + '<button class="ghost" type="button">' + ic('reuse', 12) + '拿去生成</button>'
      + '<button class="ghost" type="button">' + ic('eye', 12) + '找相似素材</button>';
  }

  /* ---------- 渲染 ---------- */
  var head = document.getElementById('mdHead');
  var media = document.getElementById('mdMedia');
  var doc = document.getElementById('mdDoc');
  var foot = document.getElementById('mdFoot');
  var cur = 'new';

  function render(key) {
    cur = key;
    var s = STATES[key];
    head.innerHTML = headHTML(s);
    media.innerHTML = mediaHTML(s);
    doc.innerHTML = docHTML(s);
    foot.innerHTML = footHTML(s);
    var sel = document.getElementById('kindSel');
    if (sel) {
      sel.addEventListener('change', function () {
        /* 换了类型：这一类的字段与分节当场增减（时段只给场景，角色资产与声音只给角色） */
        var k = sel.value;
        var next = Object.assign({}, STATES[cur], { kind: k });
        if (k !== 'actor') { next.assets = []; next.voice = null; next.pics = []; next.cur = -1; next.anchor = -1; }
        else { next.pics = STATES.actor.pics; next.cur = 0; next.anchor = 0; next.assets = STATES.actor.assets; next.voice = STATES.actor.voice; }
        STATES[cur] = next;
        render(cur);
      });
    }
    /* 「这一位怎么定声音」那一排：换了方式，下面那一块当场换
       （预设音色 → 音色胶囊；写声音描述 → 描述输入框；复刻 → 参考音频）。 */
    Array.prototype.forEach.call(doc.querySelectorAll('.gen-way[data-way]'), function (b) {
      b.addEventListener('click', function () {
        var st = STATES[cur];
        if (!st.voice) return;
        st.voice = Object.assign({}, st.voice, { way: b.getAttribute('data-way') });
        render(cur);
      });
    });
  }

  /* ---------- 演示用的状态切换条 ---------- */
  var sw = document.getElementById('demoSwitch');
  sw.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-state]');
    if (!b) return;
    sw.querySelectorAll('button[data-state]').forEach(function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    render(b.getAttribute('data-state'));
  });

  /* ---------- 换背景（深色档是令牌自动派生） ---------- */
  document.getElementById('sbTheme').addEventListener('click', function () {
    var h = document.documentElement;
    h.setAttribute('data-theme', h.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  render(cur);
  window.__mdRender = render;
})();
