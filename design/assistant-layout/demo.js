/* ============================================================================
   AI 助手 · 布局重构稿「副驾台」—— 稿子的行为（假数据，不碰真产品）。
   演示这几件事：
     · 形态：固定档（占住右边一整条）/ 浮窗档（贴着屏幕右下角）
     · 历史会话：沿用真产品那一块浮层（标题行 + 搜索 + 两行列表项 + ✕）
     · 工序：默认一行摘要，展开看每道工序的细节
     · 执行闸：花钱那一步就在工序线里，等你点头
     · 引用带：引用的是素材（角色/场景/道具/产物/文件），不是对话里的消息
     · Skill：这一轮按什么规范写 —— 显示在这一轮的卡上
     · 空态：三个动词（查 / 改 / 生）对应产品里「只读查询 / 写入动作」的分法
     · 深浅档：同一份稿子切两档（不是另设计一版）
   ========================================================================== */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const D = window.DECK;

  const state = { mode: 'dock', hist: false, trace: false, empty: false };

  /* ---------- 历史会话（浮层） ---------- */
  function paintHist() {
    const q = String(($('histQ') || {}).value || '').trim();
    const all = D.sessions;
    const items = q
      ? all.filter(s => (s.t + ' ' + s.at).toLowerCase().includes(q.toLowerCase()))
      : all;
    $('histSum').textContent = q
      ? '找到 ' + items.length + ' / ' + all.length + ' 段'
      : all.length + ' 段 · 共 ' + all.reduce((n, s) => n + s.n, 0) + ' 条（当前这段 ' +
        (all.filter(s => s.cur)[0] || { n: 0 }).n + ' 条）';
    $('histList').innerHTML = items.map(s =>
      '<button class="hist-item' + (s.cur ? ' on' : '') + '" type="button" data-sid="' + esc(s.id) + '">'
      + '<span class="hist-t">' + esc(s.t) + '</span>'
      + '<span class="hist-m">' + esc(s.at) + ' · ' + s.n + ' 条'
      + (s.cur ? '<em class="hist-cur">当前</em>' : '') + '</span>'
      + '<span class="hist-x" data-del="' + esc(s.id) + '" title="删除这段会话" aria-hidden="true">×</span>'
      + '</button>').join('') || '<div class="hist-none">没有匹配的会话</div>';
    $('histList').querySelectorAll('.hist-item').forEach(b => {
      b.onclick = ev => {
        if (ev.target.closest('[data-del]')) return;   // 删是另一件事，别顺手切过去
        closeHist();                                    // 选中即收起（产品同一行为）
      };
    });
    $('histList').querySelectorAll('[data-del]').forEach(x => {
      x.onclick = ev => { ev.stopPropagation(); };
    });
  }

  function closeHist() {
    state.hist = false;
    $('histBox').hidden = true;
    $('histBtn').setAttribute('aria-expanded', 'false');
    $('dRail').classList.remove('on');
  }

  /* ---------- 工单 ---------- */
  /* 工序节点的状态从这一轮的状态推出来：完成的一轮全是绿点，失败的一轮最后一步是红点，
     正在写的那一轮最后一步是蓝点（在跑），等确认的那一轮前面几步绿、最后一步琥珀。 */
  function stepState(job, i, n) {
    if (job.state === 'running') return i === n - 1 ? 'run' : 'done';
    if (job.state === 'failed') return i === n - 1 ? 'bad' : 'done';
    return 'done';
  }

  function stepHtml(st, stt) {
    const cls = 'tr' + (stt ? ' ' + stt : '');
    /* 收起时这一行只留「工序名 + 用时」—— 像一张工序表，一眼扫得过去；
       细节（命中了什么、跑在哪、为什么慢）留在展开后的那一行里。 */
    const more = state.trace && st.more
      ? '<div class="tr-more"><b>' + esc(st.note || '') + '</b>' + (st.note ? ' · ' : '') + esc(st.more) + '</div>'
      : '';
    return '<div class="' + cls + '"><i class="tr-dot"></i>'
      + '<span class="tr-name"><span class="tr-t">' + esc(st.name) + '</span></span>'
      + '<span class="tr-ms">' + esc(st.ms || '') + '</span></div>' + more;
  }

  function traceHtml(job) {
    const steps = job.steps || [];
    const n = steps.length;
    /* 这一轮没调任何工具 → 根本不会走到工单卡那一条路（纯问答渲染成气泡对） */
    if (!n && !job.gate) return '';
    const rows = steps.map((st, i) => stepHtml(st, stepState(job, i, n))).join('');
    const gateRow = job.gate
      ? '<div class="tr wait"><i class="tr-dot"></i>'
        + '<span class="tr-name"><span class="tr-t">提交生成（要花钱）</span>'
        + '<span class="tr-tag">' + esc(job.gate.tag || '') + '</span></span>'
        + '<span class="tr-ms">待确认</span></div>'
      : '';
    const toggle = n
      ? '<button class="tr-toggle" type="button" data-trace="' + job.id + '">'
        + '<svg class="ic sm ch' + (state.trace ? ' up' : '') + '" aria-hidden="true"><use href="#i-chev"/></svg>'
        + (state.trace ? '收起工序' : '展开工序') + '</button>'
      : '';
    return '<div class="trace"><div class="trace-rows">' + rows + gateRow + '</div>' + toggle + '</div>';
  }

  /* 这一轮按什么规范写：真产品里它是消息里的一排 Skill 芯片（名字 · 版本）。 */
  function skillsHtml(job) {
    if (!job.skills || !job.skills.length) return '';
    return '<div class="job-skills"><span class="job-skills-l">这一轮带的 Skill</span>'
      + job.skills.map(s => '<span class="skill-chip" title="看这一份 Skill 的正文">'
        + '<svg class="ic sm" aria-hidden="true"><use href="#i-spark"/></svg>' + esc(s) + '</span>').join('')
      + '</div>';
  }

  function outsHtml(job) {
    if (!job.outputs || !job.outputs.length) return '';
    const tiles = job.outputs.map(o =>
      '<figure class="out"><img class="out-img" src="' + esc(o.src) + '" alt="' + esc(o.name) + '">'
      + '<figcaption class="out-bd"><span class="out-n">' + esc(o.name) + '</span>'
      + '<span class="out-m">' + esc(o.type) + ' · ' + esc(o.size) + '</span></figcaption></figure>').join('');
    return '<div class="outs">' + tiles + '</div>'
      + (job.outputs.length > 2 ? '<div class="outs-more">查看全部 ' + job.outputs.length + ' 张 ›</div>' : '');
  }

  function srcsHtml(job) {
    if (!job.sources || !job.sources.length) return '';
    return '<div class="srcs"><span class="srcs-h">来源</span>'
      + job.sources.map(s => '<div class="src"><span class="src-n">[' + s.n + ']</span>'
        + '<a class="src-a" href="javascript:void(0)">' + esc(s.title) + ' · ' + esc(s.url) + '</a></div>').join('')
      + '</div>';
  }

  function gateHtml(job) {
    if (!job.gate) return '';
    return '<div class="gate"><div class="gate-h">'
      + '<svg class="ic" aria-hidden="true"><use href="#i-warn"/></svg>'
      + '<span>' + esc(job.gate.title) + '</span></div>'
      + '<ul class="gate-l">' + job.gate.lines.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul>'
      + '<div class="gate-a"><button class="gate-b pri" type="button">' + esc(job.gate.act) + '</button>'
      + '<button class="gate-b" type="button">' + esc(job.gate.cancel) + '</button></div></div>';
  }

  function failHtml(job) {
    if (!job.fail) return '';
    return '<div class="job-fail"><div class="gate-h err">'
      + '<svg class="ic" aria-hidden="true"><use href="#i-warn"/></svg><span>这一步没成</span></div>'
      + '<div class="gate-a"><button class="gate-b" type="button">' + esc(job.fail.act) + '</button></div></div>';
  }

  /* ---------- 一轮 ----------
     形态：**你发出去的那条**（独立一条，正文里带高亮引用）+ **助手的回应**。
     回应有两种：纯回答 → 一条气泡；动过手 → 一张工单卡（靠左，贴着栏的左边）。 */
  function turnHtml(job) {
    /* 引用：正文里的一段高亮文字，跟输入框里那一个同款（悬停出缩略图与号） */
    const refs = (job.refs || []).map(r =>
      '<span class="ref-mark" title="' + esc(r.tip || '') + '">' + esc(r.name)
      + (r.src ? '<span class="ref-tip"><img src="' + esc(r.src) + '" alt="">'
        + '<span class="ref-tip-b"><b>' + esc(r.name) + '</b><span>' + esc(r.tip || '') + '</span></span></span>' : '')
      + '</span>').join('');
    /* 附件：文件，单独一排小芯片（它不是正文的一部分） */
    const files = (job.files || []).map(f =>
      '<span class="fs-chip" title="' + esc(f.tip || '') + '">'
      + '<svg class="ic sm" aria-hidden="true"><use href="#i-' + f.icon + '"/></svg>'
      + esc(f.name) + (f.kind ? '<em>' + esc(f.kind) + '</em>' : '') + '</span>').join('');
    return '<div class="turn">'
      + '<div class="turn-mine">'
      + '<div class="turn-me">' + esc(job.ask) + refs + '</div>'
      + (files ? '<div class="turn-fs">' + files + '</div>' : '')
      + '</div>'
      + (job.plain ? sayAiHtml(job) : jobCardHtml(job))
      + '</div>';
  }

  /* 纯回答：一条气泡 */
  function sayAiHtml(job) {
    const body = (job.body || []).map(p => '<p>' + esc(p) + '</p>').join('');
    return '<div class="say-ai">' + (job.lead ? '<p class="say-lead">' + esc(job.lead) + '</p>' : '') + body + '</div>'
      + '<div class="say-ft"><button class="foot-b" type="button">复制</button>'
      + '<button class="foot-b" type="button">重问</button></div>';
  }

  /* 工单卡：动了手的那一轮。卡里不重复你的话 —— 上面那条就是。 */
  function jobCardHtml(job) {
    const body = (job.body || []).map(p => '<p>' + esc(p) + '</p>').join('');
    const diff = job.diff
      ? '<div class="diff"><span class="diff-k">原句</span><span class="diff-v old">' + esc(job.diff.before) + '</span>'
        + '<span class="diff-k">润色后</span><span class="diff-v new">' + esc(job.diff.after) + '</span></div>'
      : '';
    const live = job.streaming ? '<div class="job-live">' + esc(job.streaming) + '</div>' : '';
    const foot = job.state === 'running'
      ? '<div class="job-foot"><span class="sp"></span>'
        + '<button class="foot-b" type="button">停止</button></div>'
      : '<div class="job-foot"><span>花费 ' + esc(job.foot.cost) + '</span><span>用时 ' + esc(job.foot.dur) + '</span>'
        + '<span class="sp"></span><button class="foot-b" type="button">复制</button>'
        + '<button class="foot-b" type="button">重问</button></div>';
    return '<article class="job s-' + job.state + '">'
      + skillsHtml(job)
      + traceHtml(job)
      + (job.lead ? '<p class="job-lead">' + esc(job.lead) + '</p>' : '')
      + (body ? '<div class="job-body">' + body + '</div>' : '')
      + diff + gateHtml(job) + failHtml(job) + outsHtml(job) + srcsHtml(job)
      + live + foot
      + '</article>';
  }

  /* ---------- 空态 ---------- */
  function emptyHtml() {
    const e = D.empty;
    return '<div class="empty">'
      + '<div class="empty-who">' + esc(e.who) + '</div>'
      + '<button class="empty-entry" type="button">'
      + '<svg class="ic" aria-hidden="true"><use href="#i-check"/></svg>' + esc(e.entry) + '</button>'
      + '<div class="caps">' + e.caps.map(c =>
        '<div class="cap-row"><span class="cap-v">' + esc(c.verb) + '</span>'
        + '<span class="cap-l">' + c.items.map(i => '<span class="cap-i">' + esc(i) + '</span>').join('') + '</span></div>'
      ).join('') + '</div>'
      + '<div class="samples"><span class="samples-h">或者直接问</span>'
      + e.samples.map(s => '<button class="sample" type="button">' + esc(s) + '</button>').join('') + '</div>'
      + '<div class="empty-foot">' + esc(e.foot) + '</div>'
      + '</div>';
  }

  /* ---------- 画 ---------- */
  function paint() {
    $('deckStream').innerHTML = state.empty ? emptyHtml() : D.jobs.slice().reverse().map(turnHtml).join('');
    $('stage').classList.toggle('float', state.mode === 'float');
    $('stage').classList.toggle('dock', state.mode === 'dock');
    $('dMode').classList.toggle('on', state.mode === 'float');
    $('dTrace').classList.toggle('on', state.trace);
    $('dEmpty').classList.toggle('on', state.empty);
    $('deckLive').hidden = state.empty;
    document.querySelectorAll('[data-trace]').forEach(b => {
      b.onclick = () => { state.trace = !state.trace; paint(); };
    });
  }

  function openHist() {
    state.hist = true;
    $('histBox').hidden = false;
    $('histBtn').setAttribute('aria-expanded', 'true');
    $('dRail').classList.add('on');
    paintHist();
  }

  /* ---------- 控件 ---------- */
  $('histBtn').onclick = () => { if (state.hist) closeHist(); else openHist(); };
  $('dRail').onclick = () => { if (state.hist) closeHist(); else openHist(); };
  $('histScrim').onclick = closeHist;
  $('histClose').onclick = closeHist;
  $('histQ').oninput = paintHist;
  $('dMode').onclick = () => { state.mode = state.mode === 'dock' ? 'float' : 'dock'; paint(); };
  $('modeBtn').onclick = () => { state.mode = state.mode === 'dock' ? 'float' : 'dock'; paint(); };
  $('dTrace').onclick = () => { state.trace = !state.trace; paint(); };
  $('dEmpty').onclick = () => { state.empty = !state.empty; paint(); };
  $('dTheme').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', now);
    $('dTheme').classList.toggle('on', now === 'dark');
  };
  /* 拖资产到悬浮球上：球点亮一圈虚线（产品的 .ac-drop） */
  const setDrop = v => {
    $('acBall').classList.toggle('ac-drop', !!v);
    $('dDrop').classList.toggle('on', !!v);
  };
  $('dDrop').onclick = () => setDrop(!$('acBall').classList.contains('ac-drop'));

  /* 出图脚本用的钩子 */
  window.__deckSetMode = m => { state.mode = m; paint(); };
  window.__deckSetHist = v => { if (v) openHist(); else closeHist(); };
  window.__deckSetTrace = v => { state.trace = !!v; paint(); };
  window.__deckSetEmpty = v => { state.empty = !!v; paint(); };
  window.__deckSetTheme = t => {
    document.documentElement.setAttribute('data-theme', t);
    $('dTheme').classList.toggle('on', t === 'dark');
  };
  /* ---------- 宽度 / 高度把手：真产品那两根（.ac-grip / .ac-grip-b） ----------
     拖左沿改宽（360–760，记在本机）；浮窗档拖下沿改高。稿子里做成真能拖的。 */
  const stage = $('stage');
  const bindGrip = (el, mode) => {
    if (!el) return;
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      /* 必须抓住指针：不然鼠标一移出那 6px 的把手，pointermove 就不来了，拖到一半跟丢。 */
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 抓不到也照拖：move/up 挂在把手上 */ }
      const r = $('deck').getBoundingClientRect();
      const start = mode === 'x' ? e.clientX : e.clientY;
      const base = mode === 'x' ? r.width : r.height;
      const move = ev => {
        if (mode === 'x') {
          const w = Math.max(360, Math.min(760, base + (start - ev.clientX)));
          stage.style.setProperty('--dk-w', w + 'px');
        } else {
          const h = Math.max(240, Math.min(window.innerHeight - 24, base + (ev.clientY - start)));
          stage.style.setProperty('--dk-fh', h + 'px');
        }
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };
  bindGrip($('deckGrip'), 'x');
  bindGrip($('deckGripB'), 'y');

  /* ---------- 引用被改坏：正文是真相，改了就是删了 ----------
     真产品现在只弹一句警告（引用还在队列里、这一轮仍发给模型）；
     这一稿的语义是「正文里没有了 = 这条引用不作数」，所以改坏即作废。 */
  const REF_HTML = $('taRef').innerHTML;
  const setRefBroken = v => {
    const m = $('taRef');
    const tip = m.querySelector('.ref-tip');
    if (v) {
      m.classList.add('broken');
      m.childNodes[0].nodeValue = '[引用素材：雨夜街道-候选 1';   /* 少了个右括号 */
      if (tip) tip.style.display = 'none';
    } else {
      m.classList.remove('broken');
      m.innerHTML = REF_HTML;
    }
    $('refWarn').hidden = !v;
    $('dBreak').classList.toggle('on', !!v);
  };
  $('dBreak').onclick = () => setRefBroken(!$('taRef').classList.contains('broken'));

  /* 出图用：把悬停才出现的那个缩略图浮层钉住，拍一张下来 */
  window.__deckShowRefTip = v => {
    document.querySelectorAll('.ref-mark').forEach(m => m.classList.toggle('show-tip', !!v));
  };
  window.__deckBreakRef = v => setRefBroken(!!v);
  window.__deckSetDrop = v => setDrop(!!v);

  paint();
})();
