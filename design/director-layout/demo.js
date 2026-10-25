/* 导演台 · 布局重构稿 —— 行为层（只为看稿子方便，不是产品的一部分） */
'use strict';
(function () {
  const D = window.DIR;
  const $ = s => document.querySelector(s);

  const STATE = {
    used: { word: '已选用', cls: 'used' },
    pick: { word: '待选用', cls: 'pick' },
    run: { word: '生成中', cls: 'run' },
    fail: { word: '生成失败', cls: 'fail' },
    draft: { word: '待写描述', cls: 'none' },
  };
  const CSTATE = { done: '已完成', running: '生成中', failed: '生成失败', draft: '待写描述' };

  const st = m => STATE[m] || STATE.draft;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* 轨行左列：行名 + 副标 + 三枚行内开关（联动 / 眼睛 / 锁） */
  const TICS = '<span class="tics"><button title="联动">⛓</button><button title="隐藏">👁</button><button title="锁定">🔒</button></span>';
  const tname = (label, sub, withTics) =>
    '<div class="tname"><span class="tlab"><span class="n">' + label + '</span>' +
    (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</span>' +
    (withTics ? TICS : '') + '</div>';

  /* 时码：HH:MM:SS:FF（25 帧）—— 这一稿里它出现三次：页头、轨道尺、读数行 */
  function tc(sec) {
    const s = Math.max(0, sec);
    const f = Math.floor((s % 1) * 25);
    const t = Math.floor(s);
    const p = (n, w) => String(n).padStart(w, '0');
    return p(Math.floor(t / 3600), 2) + ':' + p(Math.floor(t / 60) % 60, 2) + ':' + p(t % 60, 2) + ':' + p(f, 2);
  }
  const dur = s => s.toFixed(1) + ' 秒';
  const mmss = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  /* 时码 → 秒（HH:MM:SS:FF，25 帧） */
  function tcSec(t) {
    const p = String(t).split(':').map(Number);
    return p[0] * 3600 + p[1] * 60 + p[2] + (p[3] || 0) / 25;
  }

  /* 三把尺的密度都从 CSS 变量读 —— 窄窗时 CSS 会改密度，块的位置跟着走，
     不然块会画到尺子外面去（轨道横向滚动就是这么来的）。 */
  function cssPx(el, name, fallback) {
    const v = parseFloat(getComputedStyle(el || document.documentElement).getPropertyValue(name));
    return isFinite(v) && v > 0 ? v : fallback;
  }

  let sel = 'sh4';        /* 当前这一镜 */
  let selCand = 'c41';    /* 当前这条候选 */
  let mode = 'gen';       /* gen | edit */

  /* ───────── 全片顺序（按秒成比例的那条带） ───────── */
  function seqShots() { return D.sequence.map(id => D.shots[id]); }
  function totalDur() { return seqShots().reduce((a, s) => a + (s.dur || 0), 0); }
  function startOf(id) {
    let t = 0;
    for (const sid of D.sequence) {
      if (sid === id) break;
      t += D.shots[sid].dur || 0;
    }
    return t;
  }
  /* 这一镜在成片里的那一段（起止都是成片秒） */
  function filmSpan(id) {
    const s = D.shots[id];
    const a = startOf(id);
    return { a: a, b: a + (s.dur || 0) };
  }

  /* ═════════ 左栏 · 分镜表 ═════════ */
  function renderShots() {
    $('#shotCount').textContent = String(Object.keys(D.shots).length);
    const html = D.scenes.map(sc => {
      const rows = sc.shots.map(id => {
        const s = D.shots[id];
        const stt = st(s.state);
        const thumb = s.thumb
          ? '<img src="' + s.thumb + '" alt="">'
          : (s.state === 'run' ? '生成中' : '未生成');
        const prog = s.state === 'run'
          ? '<div class="pbar"><b style="width:' + s.prog + '%"></b></div>' : '';
        return '<div class="shot' + (id === sel ? ' on' : '') + '" data-shot="' + id + '">' +
          '<div class="shot-top">' +
            '<span class="shot-no">' + s.no + '</span>' +
            '<span class="shot-name">' + esc(s.name) + '</span>' +
            '<span class="sp"></span>' +
            '<span class="dot ' + stt.cls + '" title="' + stt.word + '"></span>' +
          '</div>' +
          '<div class="shot-bot">' +
            '<span class="thumbwrap shot-thumb">' + thumb + prog + '</span>' +
            '<span class="shot-meta">' +
              '<span>' + (s.dur ? dur(s.dur) : stt.word) + '</span>' +
              (s.cands.length ? '<span>· ' + s.cands.length + ' 条</span>' : '') +
            '</span>' +
          '</div>' +
        '</div>';
      }).join('');
      return '<div class="scene">' +
        '<div class="scene-h"><b>场 ' + sc.id.slice(1) + ' · ' + esc(sc.name) + '</b>' +
          '<span class="scene-c">' + sc.shots.length + ' 镜</span>' +
          '<button class="ic" type="button" title="场次操作">⋯</button>' +
        '</div>' + rows + '</div>';
    }).join('');
    $('#shotList').innerHTML = html;
  }

  /* ═════════ 中栏 · 候选带 ═════════ */
  function renderCands() {
    const s = D.shots[sel];
    const box = $('#cands');
    if (!s.cands.length) {
      box.innerHTML = '<div class="cand" style="width:180px;padding:var(--sp-10);text-align:center;color:var(--sub);font-size:var(--fs-11-5)">这一镜还没有候选</div>';
      return;
    }
    const cards = s.cands.map(c => {
      const img = c.thumb
        ? '<img src="' + c.thumb + '" alt="">'
        : (c.state === 'running' ? '生成中 ' + (c.prog || 0) + '%' : CSTATE[c.state]);
      const acts = c.state === 'done'
        ? '<div class="cand-acts">' +
            '<button type="button" data-act="use">' + (c.sel ? '取消选用' : '用这条') + '</button>' +
            '<button type="button" data-act="lock">' + (c.locked ? '已锁定' : '锁定') + '</button>' +
            '<button type="button" class="del" data-act="del">删除</button>' +
          '</div>'
        : '';
      return '<div class="cand' + (c.id === selCand ? ' on' : '') + '" data-cand="' + c.id + '">' +
        '<div class="cand-img">' + img +
          '<span class="cand-no">' + c.no + '</span>' +
          (c.locked ? '<span class="cand-lock">🔒</span>' : '') +
          acts +
        '</div>' +
        '<div class="cand-foot">' +
          '<span class="dot ' + (c.state === 'done' ? 'pick' : c.state === 'failed' ? 'fail' : c.state === 'running' ? 'run' : 'none') + '"></span>' +
          '<span>' + CSTATE[c.state] + '</span>' +
          '<span class="badge">' + esc(c.local) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
    const i = s.cands.findIndex(c => c.id === selCand);
    box.innerHTML = cards +
      '<button class="cand-add" type="button" title="新增一个候选">＋</button>' +
      '<div class="cand-pager">' +
        '<button type="button" title="展开">⌄</button>' +
        '<button type="button" title="上一条候选">‹</button>' +
        '<span class="mono">' + (i + 1) + ' / ' + s.cands.length + '</span>' +
        '<button type="button" title="下一条候选">›</button>' +
      '</div>';
  }

  /* ═════════ 中栏 · 全片顺序带（按秒成比例） ═════════ */
  function renderSeq() {
    $('#seqDur').textContent = mmss(totalDur());
    const pps = cssPx(document.documentElement, '--seq-pps', 44);
    let lastScene = null;
    const cells = seqShots().map(s => {
      const w = Math.max(56, Math.round(s.dur * pps));
      const stt = st(s.state);
      const img = s.thumb ? '<img src="' + s.thumb + '" alt="">' : '<div class="empty">未生成</div>';
      /* 换场就插一枚场次标 —— 竖排分镜表有的那层「场」信息，横带里也要留住 */
      let mark = '';
      if (s.scene !== lastScene) {
        lastScene = s.scene;
        const sc = D.scenes.find(x => x.id === s.scene);
        mark = '<span class="seq-scene">场 ' + sc.id.slice(1) + ' · ' + esc(sc.name) + '</span>';
      }
      return mark +
        '<div class="seq-cell' + (s.id === sel ? ' on' : '') + '" data-shot="' + s.id + '" ' +
        'style="width:' + w + 'px" title="' + esc(s.name) + '（点击切换，拖动排序）">' +
        img +
        '<div class="cap"><b>' + s.no + '</b><span class="dot ' + stt.cls + '"></span>' +
          '<span class="dur">' + (s.dur ? s.dur.toFixed(1) + 's' : '—') + '</span></div>' +
      '</div>';
    }).join('');
    $('#seqStrip').innerHTML = cells;
  }

  /* ═════════ 右栏 · 生成态表单 ═════════ */
  function renderGen() {
    const s = D.shots[sel];
    const p = D.panel;
    const sc = D.scenes.find(x => x.id === s.scene);
    $('#rhTitle').textContent = '这一镜';
    $('#rhSub').textContent = '第 ' + s.no + ' 镜 · ' + sc.name;
    const promptLen = p.prompt.length;
    $('#rGen').innerHTML =
      '<div class="grp">' +
        '<div class="grp-h">提示词<span class="v">' + promptLen + ' 字 · 20–800 字</span></div>' +
        '<textarea>' + esc(p.prompt) + '</textarea>' +
        '<div class="grp-row">' +
          '<button class="chip" type="button">@ 素材</button>' +
          '<button class="chip" type="button">✦ AI 润色</button>' +
          '<span class="sp"></span>' +
          '<button class="chip" type="button">清空</button>' +
        '</div>' +
      '</div>' +
      '<div class="grp">' +
        '<div class="grp-h">输入模式<span class="v">按型号声明</span></div>' +
        '<div class="grp-row"><button class="chip on" type="button">首尾帧 + 参考素材</button>' +
          '<button class="chip" type="button">纯文字</button>' +
          '<button class="chip" type="button">智能参考</button></div>' +
        '<div class="note">这一档：s1 · 短片 + s2 · 参考素材 · s1 · 不放素材就只发纯文本</div>' +
      '</div>' +
      '<div class="grp">' +
        '<div class="grp-h">画面素材<span class="v">顺序即参考顺序</span></div>' +
        '<div class="slots">' + p.slots.map(x =>
          '<div class="slot' + (x.empty ? ' empty' : '') + '"><div class="k">' + esc(x.k) + '</div><div class="v">' + esc(x.v) + '</div></div>'
        ).join('') + '</div>' +
        '<div class="grp-row"><label class="chip" style="cursor:default">□ 接上一镜尾帧当首帧</label>' +
          '<span class="note" style="margin:0">生成时自动截取上一镜结尾</span></div>' +
      '</div>' +
      '<div class="grp">' +
        '<div class="grp-h">型号与时长<span class="v">' + esc(p.model) + '</span></div>' +
        '<div class="kv">' +
          '<span>型号</span><span class="dd">' + esc(p.model) + '<span>⌄</span></span>' +
          '<span>画面比例</span><span class="dd">' + esc(p.ratio) + '<span>⌄</span></span>' +
          '<span>画质</span><span class="dd">' + esc(p.quality) + '<span>⌄</span></span>' +
          '<span>条数</span><span class="dd">' + esc(p.dur) + '<span>⌄</span></span>' +
        '</div>' +
      '</div>' +
      '<div class="grp">' +
        '<div class="grp-h">画面高级设置<span class="v">分辨率 · 输出格式</span></div>' +
        '<div class="kv"><span>分辨率</span><span class="dd">1080p<span>⌄</span></span>' +
          '<span>输出格式</span><span class="dd">MP4<span>⌄</span></span></div>' +
      '</div>';
    $('#estTxt').textContent = 'VGENV 视频换人 · ¥0.24';
    $('#genOne').textContent = s.cands.length ? '生成新候选镜头（1 条）' : '生成这一镜（1 条）';
  }

  /* ═════════ 右栏 · 剪辑态竖排四段 ═════════ */
  function renderRail() {
    const s = D.shots[sel];
    const sc = D.scenes.find(x => x.id === s.scene);
    $('#rhTitle').textContent = '这一镜';
    $('#rhSub').textContent = '第 ' + s.no + ' 镜 · ' + sc.name;

    let segT = 0;
    const segRows = D.segs.map((g, i) => {
      const a = segT; segT += g.dur;
      return '<div class="line-row"><span class="who">第 ' + (i + 1) + ' 段</span>' +
        '<span class="txt">保留 ' + g.dur.toFixed(1) + ' 秒</span>' +
        '<span class="tc">' + mmss(a) + ' → ' + mmss(segT) + '</span>' +
        '<span class="st ' + (g.mute ? 'none' : 'done') + '">' + (g.mute ? '静' : '声') + '</span></div>';
    }).join('');

    const voiceRows = D.voices.map(v =>
      '<div class="line-row"><span class="who">' + esc(v.who) + '</span>' +
      '<span class="txt">' + esc(v.text) + '</span>' +
      '<span class="tc">' + v.dur.toFixed(1) + 's · ' + v.speed + '</span></div>'
    ).join('') || '<div class="line-row"><span class="txt">这一镜还没有配音</span></div>';

    const lineRows = D.lines.local.map(l =>
      '<div class="line-row"><span class="who">' + esc(l.who) + '</span>' +
      '<span class="txt">' + esc(l.text) + '</span>' +
      '<span class="st ' + (l.state === 'done' ? 'done' : 'wait') + '">' + (l.state === 'done' ? '已生成' : '待生成') + '</span>' +
      '<span class="tc">' + l.at + '</span></div>'
    ).join('');

    $('#rail').innerHTML =
      '<section class="sec"><div class="sec-h"><b>画面</b><span class="cnt">剪成 3 段</span><span class="sp"></span>' +
        '<button type="button">切段</button></div>' + segRows +
        '<div class="note">这一段倍速 ×1 · 整轨倍速 ×1 · 画面轨这一行 第 1 行</div></section>' +

      '<section class="sec"><div class="sec-h"><b>配音</b><span class="cnt">分轨 1 句</span><span class="sp"></span>' +
        '<button type="button">合轨</button></div>' + voiceRows +
        '<div class="note">这一段音量 100% · 这一句倍速 ×1.0 · 配音轨这一行 第 1 行</div></section>' +

      '<section class="sec"><div class="sec-h"><b>台词</b><span class="cnt">本镜 1 句 · 全片 2 句</span><span class="sp"></span>' +
        '<button type="button">＋ 写一句</button></div>' + lineRows + '</section>' +

      '<section class="sec"><div class="sec-h"><b>字幕</b><span class="cnt">2 条 · 按台词/配音现派生</span></div>' +
        '<div class="grp-row"><button class="chip" type="button">从台词生成字幕</button>' +
          '<button class="chip" type="button">导入 SRT</button>' +
          '<button class="chip" type="button">导出 SRT</button>' +
          '<button class="chip" type="button">自动识别</button></div>' +
        '<div class="kv" style="margin-top:var(--sp-10)">' +
          '<span>字号</span><span class="dd">大<span>⌄</span></span>' +
          '<span>颜色</span><span class="dd">白<span>⌄</span></span>' +
          '<span>位置</span><span class="dd">底部 · 居中<span>⌄</span></span>' +
          '<span>每行字数</span><span class="dd">16<span>⌄</span></span>' +
        '</div>' +
        '<div class="grp-row"><label class="chip" style="cursor:default">☐ 高亮背景</label>' +
          '<button class="chip" type="button">按每行字数重切</button></div>' +
      '</section>';
  }

  /* ═════════ 中栏 · 这一镜的轨道（剪辑态） ═════════ */
  function renderShotTrack() {
    const span = filmSpan(sel);
    const pps = cssPx(document.querySelector('#shotTrack'), '--st-pps', 150);
    let t = 0;
    const picBlocks = D.segs.map(g => {
      const w = Math.round(g.dur * pps);
      const html = '<div class="seg-block sel" style="left:' + Math.round(t * pps) + 'px;width:' + w + 'px">' +
        '<img src="' + g.thumb + '" alt=""><span class="nm">' + esc(g.name.split(' · ')[1]) + '</span>' +
        '<span class="du">' + g.dur.toFixed(1) + 's</span></div>';
      t += g.dur;
      return html;
    }).join('');
    const total = t;

    /* 入出点：就地一条 trim 条（原来是一整句话压在坞底：「正在调这一条候选剪成 N 段…」） */
    const trimLeft = Math.round(D.segs[0].dur * pps);
    const trimW = Math.round(D.segs[1].dur * pps);
    const trim = '<div class="trim" style="left:' + trimLeft + 'px;width:' + trimW + 'px">' +
      '<i class="l"></i><i class="r"></i></div>';

    /* 这一镜只有几秒，尺子比全片那条密 —— 每秒都标 */
    const ticks = [];
    for (let i = 0; i <= Math.ceil(total); i++) {
      ticks.push('<span class="tk major" style="left:' + (i * pps) + 'px">' + mmss(i) + '</span>');
    }

    const voiceSec = D.voices.length ? tcSec(D.voices[0].at) - span.a : 0;
    const voice = '<div class="seg-block voice" style="left:' + Math.round(voiceSec * pps) + 'px;width:' + Math.round(2.1 * pps) + 'px">' +
      '<span class="nm">店员 · 欢迎光临。要关东煮吗？</span><span class="du">2.1s</span></div>';
    /* 字幕按**这一镜自己的时间**：成片秒落在这一镜范围内的才算，位置折回镜内 */
    const subs = D.subs.filter(sb => sb.start >= span.a && sb.start < span.b).map(sb =>
      '<div class="seg-block sub" style="left:' + Math.round((sb.start - span.a) * pps) + 'px;width:' + Math.round(sb.dur * pps) + 'px">' +
        '<span class="nm">' + esc(sb.text) + '</span></div>'
    ).join('') || '<div class="trow empty">这一镜还没有字幕</div>';

    $('#shotTrack').innerHTML =
      '<div class="mh st-head">' +
        '<b style="font-size:var(--fs-12-5)">这一镜的轨道</b>' +
        '<span class="muted" style="font-size:var(--fs-11-5)">剪后预览 · 3 段 · ' + total.toFixed(1) + 's</span>' +
        '<span class="sp"></span>' +
        /* 剪这一镜的工具跟着这一镜走 —— 原来它们在页面最底的坞里 */
        '<button class="ghost sm" type="button">✂ 切开</button>' +
        '<button class="ghost sm" type="button">← 向左切</button>' +
        '<button class="ghost sm" type="button">向右切 →</button>' +
        '<button class="ghost sm danger" type="button">⌫ 删掉</button>' +
        '<button class="ghost sm" type="button">⇄ 融合</button>' +
      '</div>' +
      '<div class="ruler st-ruler">' + ticks.join('') + '</div>' +
      '<div class="trk">' + tname('画面', '第 1 行', true) +
        '<div class="trow pic">' + picBlocks + trim + '</div></div>' +
      '<div class="trk">' + tname('配音', '第 1 行', false) +
        '<div class="trow voice">' + voice + '</div></div>' +
      '<div class="trk">' + tname('字幕', '成片秒', false) +
        '<div class="trow sub">' + subs + '</div></div>';
  }

  /* ═════════ 底部 · 时码尺 + 轨行 ═════════ */
  function renderDock() {
    const pps = cssPx(document.documentElement, '--tl-pps', 72);
    const total = totalDur();

    /* 时码尺 */
    const ticks = [];
    for (let i = 0; i <= Math.ceil(total); i++) {
      ticks.push('<span class="tk' + (i % 5 === 0 ? ' major' : '') + '" style="left:' + (i * pps) + 'px">' +
        (i % 5 === 0 ? mmss(i) : '') + '</span>');
    }
    $('#ruler').innerHTML = ticks.join('');

    /* 画面轨：全片每一镜一格，宽度 = 时长 × 同一把尺 */
    let t = 0;
    const picBlocks = seqShots().map(s => {
      const w = Math.max(40, Math.round(s.dur * pps));
      const html = '<div class="seg-block sel" style="left:' + Math.round(t * pps) + 'px;width:' + w + 'px">' +
        (s.thumb ? '<img src="' + s.thumb + '" alt="">' : '') +
        '<span class="nm">' + s.no + '</span><span class="du">' + s.dur.toFixed(1) + 's</span></div>';
      t += s.dur;
      return html;
    }).join('');

    const voice = '<div class="seg-block voice" style="left:' + Math.round(4.1 * pps) + 'px;width:' + Math.round(2.1 * pps) + 'px">' +
      '<span class="nm">店员 · 欢迎光临。要关东煮吗？</span><span class="du">2.1s</span></div>';
    const wait = '<div class="seg-block wait" style="left:' + Math.round(11.5 * pps) + 'px;width:' + Math.round(1.4 * pps) + 'px">' +
      '<span class="nm">待生成 · 推门的人</span></div>';
    const subs = D.subs.map(sb =>
      '<div class="seg-block sub" style="left:' + Math.round(sb.start * pps) + 'px;width:' + Math.round(sb.dur * pps) + 'px">' +
        '<span class="nm">' + esc(sb.text) + '</span></div>'
    ).join('');

    /* 播放头：贯穿四条轨行 —— 这一稿的签名件（同一把尺上的同一个位置） */
    const labelW = cssPx(document.documentElement, '--tl-label', 150);
    const headLeft = Math.round(4.2 * pps);
    const playhead = '<div class="playhead" style="left:' + (labelW + headLeft) + 'px"></div>';

    $('#tracks').innerHTML =
      '<div class="trk">' + tname('画面', '全片 5 镜', true) +
        '<div class="trow pic">' + picBlocks + '</div></div>' +
      '<div class="trk">' + tname('配音', '第 1 行 · 1 句', false) +
        '<div class="trow voice">' + voice + '</div></div>' +
      '<div class="trk">' + tname('待生成 1', '1 句台词还没有合成', false) +
        '<div class="trow voice">' + wait + '</div></div>' +
      '<div class="trk">' + tname('字幕', '成片秒 · 2 条', false) +
        '<div class="trow sub">' + subs + '</div></div>' +
      playhead;
  }

  /* ═════════ 状态渲染 ═════════ */
  function renderHead() {
    const s = D.shots[sel];
    const sc = D.scenes.find(x => x.id === s.scene);
    $('#mhNo').textContent = s.no;
    $('#mhName').value = s.name;
    $('#mhMeta').textContent = sc.name + ' · ' + (s.dur ? s.dur.toFixed(1) + ' 秒' : '未生成') + ' · ' + st(s.state).word;
    $('#mhHint').textContent = s.cands.length ? '这一镜有 ' + s.cands.length + ' 条候选' : '这一镜还没有候选';
    const img = $('#screenImg');
    if (s.thumb) { img.src = s.thumb; img.hidden = false; } else { img.hidden = true; }
    $('#dhTc').textContent = tc(4.2);
  }

  function renderAll() {
    renderHead();
    renderShots();
    renderCands();
    renderSeq();
    if (mode === 'gen') { renderGen(); } else { renderRail(); renderShotTrack(); }
    renderDock();
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    const edit = m === 'edit';
    $('#dock').hidden = !edit;
    $('#rail').hidden = !edit;
    $('#rGen').hidden = edit;
    $('#submit').hidden = edit;
    $('#genDock').hidden = edit;     /* 生成坞归生成态 */
    $('#histDock').hidden = !edit;    /* 历史编辑记录归剪辑态 */
    $('#shotTrack').hidden = !edit;
    $('#cands').hidden = edit;
    $('#seq').hidden = edit;      /* 全片概览在剪辑态由底部坞的画面轨承担，中栏不重复 */
    $('#screenTag').hidden = !edit;
    document.querySelector('.dir').dataset.mode = m;
    renderAll();
  }

  /* 事件 */
  document.addEventListener('click', e => {
    const shot = e.target.closest('[data-shot]');
    if (shot) {
      sel = shot.dataset.shot;
      const s = D.shots[sel];
      selCand = (s.cands[0] && s.cands[0].id) || null;
      renderAll();
      return;
    }
    const cand = e.target.closest('[data-cand]');
    if (cand) { selCand = cand.dataset.cand; renderCands(); return; }
    const seg = e.target.closest('#modeSeg button');
    if (seg) { setMode(seg.dataset.mode); return; }
  });

  $('#themeBtn').addEventListener('click', () => {
    const el = document.documentElement;
    el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark';
  });

  /* 窗口一变，尺子的密度跟着变（CSS 变量）—— 块要重画，不然画到尺子外面 */
  let rzTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(renderAll, 120);
  });

  /* 出图脚本用的钩子 */
  window.__dir = {
    setMode(m) { setMode(m); },
    setTheme(t) { document.documentElement.dataset.theme = t; },
    setShot(id) { sel = id; renderAll(); },
  };

  setMode('gen');
})();
