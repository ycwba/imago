/* ============================================================================
   表单族公共件 —— 就地润色 / 润色审阅 / 页内确认 / 通用弹窗 / 提示词表单
   ---------------------------------------------------------------------------
   从 ui.js 切出（一个文件里十几个 `window.<Name>` 面挤在一起）。
   这里只放「弹窗与表单」这一族（含日期选择弹层 DatePicker）；调用点仍是 window.InlinePolish / PromptReview /
   Confirm / UiDialog / PromptForm，一个都没改。每个面仍是自己的 IIFE，彼此只经
   window 面调用；共享的转义与图标仍读 ui.js 的 window.esc / window.icon。
   加载顺序：ui.js → forms.js（见 shell.html），两者都排在页面模块之前。
   ========================================================================== */
/* ============================================================================
   InlinePolish —— 就地润色面板（不弹窗，展开在提示词输入框下方）
     · InlinePolish.loading(host, text)          占位：显示「正在润色…」
     · InlinePolish.show(host, o)                结果面板（结果可编辑，用户决定是否替换）
         o.after      润色后的文本
         o.note       小字说明（附带了几张素材图 / 为什么没带图…）
         o.before     原文（只用于显示字数对比）
         o.applyLabel 「替换」按钮文案，默认「替换原提示词」
         o.onEdit(v)  用户改动结果文本时回调（页面可把值存进自己的状态，重渲染不丢）
         o.onApply(v) 点「替换」时回调（页面在这里写回输入框）
         o.onRetry()  点「重新润色」时回调 → Promise<{after, note}|string>
         o.onReask()  点「改回答」时回调（两段式润色才给这个按钮，见下）
         o.onClose()  点「放弃」时回调
         o.onFollow(你那句话, 屏幕上这一版, ctl, ctx)
                    传了这一项才画「还要怎么改」那一行（没实现就不摆一颗点了没反应的按钮）。
                    结果面板上可以直接和 AI 对话：写一句要求 → 按回车或点「按这句再改」→
                    新那一版就地换进 textarea，你打过的每一句留在面板下面当对话记录。
                    `ctl.push(片段, 种类)` 接流式（边写边灌）、`ctl.signal` 接中止；跑着的时候
                    那颗按钮变成「停止这一轮」，停下后屏幕上回到改之前那一版（不会留半截）。
                    `ctx.answers` = 这一段先前那几题的回答（`interactive` 转发时给，页面不用自己记）。
         o.talk       先前那几轮「你说」的记录（**页面持有的数组**：整栏重画后还能画回来）。
         o.followPlaceholder 那一行输入框的提示语（按这一处润的是什么写，别用通用的一句）
     · InlinePolish.ask(host, o)                 问答面板（就地反问，每题 = 候选 + 最后一个自由输入框）
     · InlinePolish.live(host, o)                流式面板（边收边画；返回 { push, note, fail, text }）
     · InlinePolish.interactive(host, o)         两段式润色：先反问 → 按回答润色 → 结果面板（同一块面板内换内容）
         · o.run(answersText, ctl)：ctl 是流式接口（ctl.push(片段, 种类) + ctl.signal）——
           页面愿意流式就把 ctl.push 接到 TextAI.chatStream 的 onDelta、把 ctl.signal 传进 opts，
           不接也完全可以（面板照旧显示「正在润色…」）。
     · InlinePolish.clear(host)                  收起面板（纯 DOM 清理，不触发 onClose）
   ========================================================================== */
(function () {
  const esc = s => window.esc(s);
  window.InlinePolish = {
    clear(host) {
      if (!host) return;
      host.innerHTML = '';
      host.hidden = true;
    },
    loading(host, text) {
      if (!host) return;
      host.hidden = false;
      host.innerHTML = `<div class="pinl"><div class="pinl-load"><span class="spin-dot"></span>${esc(text || '正在润色…')}</div></div>`;
    },
    /* ---------- 流式面板：AI 一边写一边画出来（不弹窗、不换界面）----------
       「正在润色…／正在写剧本」这种干等的占位有个实打实的毛病：长文本十几秒，
       人看不到 AI 往哪个方向写，也就无从判断要不要中途停。这一版把收到的每一段就地画出来。
         o = { title, onStop() }
       返回控制器：push(片段, 'content'|'reasoning') / note(文字) / fail(文字) / text()
       · 'content' 进正文（滚动跟随最新一行），'reasoning' 进上面那行「思考」小字 ——
         那是模型的草稿，不是给人抄进提示词的正文，混在一起会毁掉结果。
       · 收尾不用调它：调用方紧接着用 show() 把同一块换成可编辑的结果面板（正文一模一样，不跳）。 */
    live(host, o) {
      o = o || {};
      const noop = { push() {}, note() {}, fail() {}, text: () => '' };
      if (!host) return noop;
      host.hidden = false;
      host.innerHTML = `<div class="pinl pinl-live">
        <div class="pinl-hd">
          <span class="pinl-tt">${icon('sparkles', 13)}<span data-tt>${esc(o.title || 'AI 正在写…')}</span></span>
          <span class="pinl-note"></span>
        </div>
        <div class="pinl-think" hidden></div>
        <pre class="pinl-out" spellcheck="false"></pre>
        <div class="pinl-ft">
          ${o.onStop ? '<button class="ghost" data-act="stop">停止（已经写出来的会留着）</button>' : '<span class="pinl-load"><span class="spin-dot"></span>正在接收…</span>'}
          <span class="pinl-len"></span>
        </div>
      </div>`;
      const el = host.firstElementChild;
      const out = el.querySelector('.pinl-out');
      const think = el.querySelector('.pinl-think');
      const lenEl = el.querySelector('.pinl-len');
      let text = '', thinkTxt = '', over = false;
      return {
        push(piece, kind) {
          if (over || !piece) return;
          if (kind === 'reasoning') {
            thinkTxt += piece;
            think.hidden = false;
            think.textContent = '思考：' + thinkTxt;
            think.scrollTop = think.scrollHeight;
            return;
          }
          text += piece;
          out.textContent = text;
          /* 只在自己真的滚到底时才跟：中途往上翻看前面的内容，不该被下一帧拽回底部 */
          if (out.scrollTop + out.clientHeight >= out.scrollHeight - 24) out.scrollTop = out.scrollHeight;
          lenEl.textContent = text.trim().length + ' 字';
        },
        note(t) { el.querySelector('.pinl-note').textContent = t || ''; },
        text: () => text,
        /* 失败（含中途停止）时把已经写出来的字留在原地，只在顶上补一句原因 ——
           面板里明明有内容却整块清掉，用户看到的就是一次凭空消失的生成。 */
        fail(msg) {
          over = true;
          const sp = el.querySelector('.pinl-load');
          if (sp) sp.remove();
          el.querySelector('[data-tt]').textContent = '这次没写完';
          el.insertAdjacentHTML('afterbegin', `<div class="pinl-err">${esc(msg || '生成失败')}</div>`);
        },
      };
    },
    show(host, o) {
      if (!host) return null;
      o = o || {};
      host.hidden = false;
      host.innerHTML = `<div class="pinl">
        <div class="pinl-hd">
          <span class="pinl-tt">${icon('sparkles', 13)} AI 润色结果</span>
          <span class="pinl-note">${esc(o.note || '')}</span>
        </div>
        <textarea class="pinl-ta" spellcheck="false" placeholder="润色结果（可直接改）"></textarea>
        <div class="pinl-talk" hidden></div>
        ${o.onFollow ? `<div class="pinl-chat">
          <input class="pinl-chatin" type="text" spellcheck="false" placeholder="${esc(o.followPlaceholder || '还要怎么改？写完按回车')}">
          <button class="ghost" data-act="follow">${icon('sparkles', 13)} 按这句再改</button>
        </div>` : ''}
        <div class="pinl-ft">
          <button class="pri" data-act="apply">${esc(o.applyLabel || '替换原提示词')}</button>
          ${o.onReask ? '<button class="ghost" data-act="reask">' + icon('sparkles', 13) + ' 改回答</button>' : ''}
          <button class="ghost" data-act="retry">${icon('refresh', 13)} 重新润色</button>
          <button class="ghost" data-act="close">放弃</button>
          <span class="pinl-len"></span>
        </div>
      </div>`;
      const el = host.firstElementChild;
      const ta = el.querySelector('.pinl-ta');
      const lenEl = el.querySelector('.pinl-len');
      const noteEl = el.querySelector('.pinl-note');
      const before = String(o.before == null ? '' : o.before);
      const paintLen = () => {
        lenEl.textContent = (before ? '原文 ' + before.trim().length + ' 字 → ' : '') + '润色后 ' + ta.value.trim().length + ' 字';
      };
      const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 92), Math.round(window.innerHeight * 0.4)) + 'px'; };
      ta.value = o.after || '';
      paintLen(); grow();
      ta.oninput = () => { paintLen(); grow(); if (o.onEdit) o.onEdit(ta.value); };
      ta.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); } };
      const applyBtn = el.querySelector('[data-act="apply"]');
      const retry = el.querySelector('[data-act="retry"]');
      const fbtn = el.querySelector('[data-act="follow"]');
      const finp = el.querySelector('.pinl-chatin');
      /* 一轮在跑（重新润色或按这句再改）就不许再开第二轮：两个 handler 都会往同一个 textarea 写字，
         叠起来后界面上那一版是谁写的都说不清。 */
      let busy = false;
      const setBusy = on => {
        busy = on;
        applyBtn.disabled = on; retry.disabled = on;
        if (fbtn) {
          fbtn.disabled = false;                     // 「停止」在跑的时候必须能点
          fbtn.innerHTML = on ? icon('stop', 13) + ' 停止这一轮'
            : icon('sparkles', 13) + ' 按这句再改';
        }
        ta.readOnly = on;
      };
      /* 对话记录：`o.talk` 是页面自己存的那一份数组（导演台的编辑器每 3 秒整栏重画一次，
         只存在面板闭包里就会被抹掉）。页面没传就在本地记，本轮会话里照样看得见。 */
      const rounds = Array.isArray(o.talk) ? o.talk : [];
      const talk = el.querySelector('.pinl-talk');
      const paintTalk = () => {
        if (!talk) return;
        talk.hidden = !rounds.length;
        talk.innerHTML = rounds.map((t, i) => `<div class="pinl-turn">第 ${i + 1} 轮 · 你说：${esc(t)}</div>`).join('');
      };
      paintTalk();
      function apply() {
        const v = ta.value.trim();
        if (!v) return;
        if (o.onApply) o.onApply(v);
        window.InlinePolish.clear(host);
      }
      applyBtn.onclick = apply;
      el.querySelector('[data-act="close"]').onclick = () => { if (o.onClose) o.onClose(); window.InlinePolish.clear(host); };
      const reask = el.querySelector('[data-act="reask"]');
      if (reask) reask.onclick = () => { if (o.onReask) o.onReask(); };
      retry.onclick = async () => {
        if (!o.onRetry || busy) return;
        const keep = ta.value, keepNote = noteEl.textContent;
        let acc = '';
        setBusy(true);
        noteEl.textContent = '正在重新润色…';
        /* 与「按这句再改」同一套：字直接灌进这一块结果面板，页面愿意流式就接 ctl.push。
           ⚠ 页面**不许**在这一轮里把宿主换成 `live` 流式面板 —— 那会把这一块连同
           「替换 / 放弃 / 再问一句」那一排按钮一起销毁，跑完只剩一个只读的正文框。 */
        const ctl = {
          push(piece, kind) {
            if (kind === 'reasoning' || !piece) return;
            acc += piece;
            ta.value = acc; paintLen(); grow();
          },
          signal: null,                          // 这一颗没有「停止」，所以没有可中止的信号
        };
        try {
          const r = await o.onRetry(ctl);
          const next = (r && typeof r === 'object') ? r : { after: r };
          ta.value = next.after || '';
          noteEl.textContent = next.note || keepNote;
          paintLen(); grow();
          if (o.onEdit) o.onEdit(ta.value);
        } catch (e) {
          ta.value = keep;
          el.insertAdjacentHTML('afterbegin', `<div class="pinl-err">重新润色失败：${esc(errText(e))}</div>`);
          noteEl.textContent = keepNote;
        }
        setBusy(false);
      };
      /* ---------- 「按这句再改」：结果出来之后接着和 AI 说 ----------
         传了 onFollow 才画这一行（没实现就不摆一颗点了没反应的按钮）。
         `o.onFollow(你那句话, 屏幕上这一版, ctl)`：ctl.push 接流式（边写边往 textarea 里灌），
         ctl.signal 接中止（跑着的时候那颗按钮就是「停止这一轮」）。 */
      if (fbtn) {
        let ab = null;
        const stop = () => { if (ab) { try { ab.abort(); } catch (e) {} } };
        fbtn.onclick = async () => {
          if (busy) { stop(); return; }              // 正在跑：这一颗现在是「停止」
          const askTxt = String(finp.value || '').trim();
          if (!askTxt) {
            noteEl.textContent = '先在上面那一格写一句要怎么改（写完按回车，或点右边那颗按钮）';
            finp.focus();
            return;
          }
          if (typeof AbortController === 'function') ab = new AbortController();
          const keep = ta.value, keepNote = noteEl.textContent;
          let acc = '';
          setBusy(true);
          noteEl.textContent = '正在按这句再改一版…';
          const ctl = {
            push(piece, kind) {
              if (kind === 'reasoning' || !piece) return;   // 模型草稿不进正文
              acc += piece;
              ta.value = acc; paintLen(); grow();
            },
            get signal() { return ab && ab.signal; },
          };
          let r;
          try { r = await o.onFollow(askTxt, keep, ctl); }
          catch (e) {
            ta.value = keep; paintLen(); grow();
            const gone = ab && ab.signal && ab.signal.aborted;
            noteEl.textContent = keepNote;
            el.insertAdjacentHTML('afterbegin', `<div class="pinl-err">${gone
              ? '这一轮已经停下（屏幕上还是你改之前那一版）'
              : '这一轮没改成：' + esc(errText(e))}</div>`);
            ab = null; setBusy(false);
            return;
          }
          const next = (r && typeof r === 'object') ? r : { after: r };
          if (next.after) { ta.value = next.after; if (o.onEdit) o.onEdit(ta.value); }
          rounds.push(askTxt); paintTalk();
          noteEl.textContent = [next.note, '已按你这句话再改过一版（不满意就接着说，或直接改上面那一段）']
            .filter(Boolean).join(' · ');
          finp.value = '';
          paintLen(); grow();
          ab = null; setBusy(false);
        };
        /* Enter 发送、Shift+Enter 不换行（这一格本来就是单行输入）。
           中文输入法选词上屏那一下也会触发一次 keydown，不放过它就是把半句话发出去。 */
        finp.onkeydown = e => {
          if (e.key !== 'Enter') return;
          if (e.isComposing || e.keyCode === 229) return;
          e.preventDefault(); fbtn.onclick();
        };
      }
      return el;
    },
    /* ---------- 问答面板（两段式润色的第一段，就地问，不弹窗）----------
       每题 = 若干候选（点一下选中）+ **最后一个组件是自由输入框**：
       候选永远覆盖不到的写法，就靠那个输入框兜住（用户可以两个都不选、自己写）。
         o = { title, intro, questions:[{q, options:[]}], submitLabel, skipLabel,
                onSubmit(answersText) → void|Promise, onSkip() → void|Promise }
       answersText 交给 run() 拼进第二段提示词，所以问答和润色之间不用页面自己转格式。 */
    ask(host, o) {
      if (!host) return null;
      o = o || {};
      const qs = (o.questions || []).filter(q => q && String(q.q || '').trim());
      host.hidden = false;
      host.innerHTML = `<div class="pinl pinl-qa">
        <div class="pinl-hd">
          <span class="pinl-tt">${icon('sparkles', 13)} ${esc(o.title || 'AI 想先问几个问题')}</span>
        </div>
        ${o.intro ? `<div class="pinl-note" style="display:block">${esc(o.intro)}</div>` : ''}
        <div class="pinl-qs"></div>
        <div class="pinl-ft">
          <button class="pri" data-act="go">${esc(o.submitLabel || '按这些回答继续润色')}</button>
          <button class="ghost" data-act="skip">${esc(o.skipLabel || '跳过，直接润色')}</button>
          <span class="pinl-len"></span>
        </div>
      </div>`;
      const el = host.firstElementChild;
      const box = el.querySelector('.pinl-qs');
      /* state 可由调用方给（导演台每次重渲染编辑器都要把已选中的答案画回来，不能丢）；
         选/写任何一处都经 onChange 回传，调用方存进自己的状态里。 */
      const state = qs.map((q, i) => {
        const s = (o.state || [])[i] || {};
        return { pick: s.pick == null ? '' : String(s.pick), own: String(s.own || '') };
      });
      qs.forEach((q, i) => {
        const wrapEl = document.createElement('div');
        wrapEl.className = 'pinl-q';
        const opts = Array.isArray(q.options) ? q.options.filter(x => String(x || '').trim()) : [];
        wrapEl.innerHTML = `<div class="pinl-qt"></div>`
          + (opts.length ? `<div class="pinl-opts">${opts.map((t, j) => `<button class="pinl-opt" data-i="${i}" data-j="${j}"></button>`).join('')}`
            /* 「其他」永远是最后一个候选：点了就进自由输入 —— 候选覆盖不到的写法有个明确的入口，
               不必自己去找那个输入框（找不到就等于没有这个功能）。 */
            + `<button class="pinl-opt pinl-other" data-i="${i}" data-j="other" title="这些都不合适？点这里自己写"><span class="ic">${icon('pencil', 12)}</span>其他</button></div>` : '')
          /* 自由输入永远是每题的最后一块 —— 候选里没有的写法靠它 */
          + `<div class="pinl-own"><input type="text" data-i="${i}" placeholder="或者自己写…"></div>`;
        wrapEl.querySelector('.pinl-qt').textContent = q.q;
        const inp = wrapEl.querySelector('.pinl-own input');
        const chips = [...wrapEl.querySelectorAll('.pinl-opt')].filter(c => c.dataset.j !== 'other');
        const otherChip = wrapEl.querySelector('.pinl-other');
        opts.forEach((t, j) => { chips[j].textContent = t; chips[j].title = t; });
        const sync = () => {
          chips.forEach(c => c.classList.toggle('on', state[i].pick !== '' && state[i].pick === c.dataset.j));
          const onOther = state[i].own.trim().length > 0;
          if (otherChip) otherChip.classList.toggle('on', onOther);
          inp.classList.toggle('on', onOther);
          inp.placeholder = onOther ? '在这里写你要的答案…' : '或者自己写…';
        };
        chips.forEach(c => c.onclick = () => {
          const j = c.dataset.j;
          state[i].pick = (state[i].pick !== '' && state[i].pick === j) ? '' : j;
          if (state[i].pick) state[i].own = '';
          inp.value = state[i].own;
          sync(); count();
        });
        if (otherChip) otherChip.onclick = () => {
          state[i].pick = '';
          sync();
          inp.focus();                 // 「其他」= 就地打字，焦点直接送过去；打了字这个芯片就高亮
        };
        inp.oninput = () => { state[i].own = inp.value; if (state[i].own) state[i].pick = ''; sync(); count(); };
        inp.value = state[i].own;
        box.appendChild(wrapEl);
        sync();
      });
      const lenEl = el.querySelector('.pinl-len');
      const count = () => {
        const n = state.filter(s => s.pick !== '' || s.own.trim()).length;
        lenEl.textContent = qs.length ? '已回答 ' + n + ' / ' + qs.length + ' 题（没答的按默认理解走）' : '';
        if (o.onChange) o.onChange(state.map(s => ({ pick: s.pick, own: s.own })));
      };
      const goBtn = el.querySelector('[data-act="go"]');
      const text = () => qs.map((q, i) => {
        const s = state[i];
        const v = s.own.trim() || (s.pick !== '' ? String((q.options || [])[+s.pick] || '') : '');
        return v ? (q.q + ' → ' + v) : (q.q + ' → （未回答）');
      }).join('\n');
      goBtn.onclick = () => { goBtn.disabled = true; const t = text(); if (o.onSubmit) o.onSubmit(t); };
      el.querySelector('[data-act="skip"]').onclick = () => { if (o.onSkip) o.onSkip(); };
      el.addEventListener('keydown', e => {
        /* 走 click() 而不是直调 onclick：提交后按钮已 disabled，click() 不会再触发，
           直调会让 onSubmit 跑两遍、两路流式并发写同一块面板。 */
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); goBtn.click(); }
      });
      count();
      return el;
    },
    /* 两段式润色：先反问要点 → 按回答润色 → 出结果面板。全程在同一块面板里换内容，不开新弹窗。
       o = { ask(): Promise<[{q,options}]>, run(answersText): Promise<{after,note}|string>,
              before, applyLabel, onEdit, onApply, onStatus(text, isErr), note }
       问不出来（模型没按格式回 / 调用失败）就跳过问答直接润色，不把用户卡在这一步。 */
    async interactive(host, o) {
      if (!host || !o) return null;
      const self = this;
      let questions = [];
      let asked = false;
      let lastState = o.state || null;
      /* 问不问问交给 AI：它读完内容自己决定（o.ask() 返回 {need, questions}）。
         程序不按字数拍板 —— 一句 30 字可能很清楚，一段 200 字也可能全是废话。
         设置里选「从不问」时 o.ask 干脆不传，直接进润色。 */
      if (o.ask) {
        asked = true;
        this.loading(host, '正在读你的描述，判断还缺什么…');
        let r = [];
        try { r = (await o.ask()) || []; } catch (e) { r = []; }
        questions = Array.isArray(r) ? r : (r.need ? (r.questions || []) : []);
      }
      const run2 = async (answers, noAskNote) => {
        self.loading(host, answers ? '正在按你的回答润色…' : '正在润色…');
        /* 流式：面板**在第一个片段到达时**才建 —— 页面不支持流式（还是一次性 chat）时
           一个字节都收不到，看到的和以前完全一样，不会先摆出一个空面板。
           signal 交给页面转发给 TextAI.chatStream，「停止」要真能把请求断掉（不是把面板藏起来）。 */
        let lv = null, ab = null;
        const push = (piece, kind) => {
          if (!lv) { ab = new AbortController(); lv = self.live(host, { title: 'AI 正在写…', onStop: () => ab.abort() }); }
          lv.push(piece, kind);
        };
        const ctl = { push, get signal() { return ab && ab.signal; } };
        let r;
        try {
          r = await o.run(answers || '', ctl);
        } catch (e) {
          const msg = errText(e);
          if (ab && ab.signal.aborted) {
            self.clear(host);
            if (o.onStatus) o.onStatus('已经停下（这次没写完，原文没动）', false);
            return null;
          }
          if (lv) { lv.fail(msg); return null; }   // 写出来的字留着，原因补在顶上
          self.clear(host);
          if (o.onStatus) o.onStatus('润色失败：' + msg, true);
          return null;
        }
        const next = (r && typeof r === 'object') ? r : { after: r };
        const note = [o.note, next.note, answers ? '已按你的回答润色' : (noAskNote || '')].filter(Boolean).join(' · ');
        const el = self.show(host, {
          after: next.after, note, before: o.before, applyLabel: o.applyLabel,
          onEdit: o.onEdit, onApply: o.onApply,
          /* 「重新润色」用同一份回答重跑；问答在前面（「改回答」按钮），所以不会把回答问丢。
             ctl 也一并递给页面：它拿 ctl.push 就能把这一轮边收边灌进结果框，
             不递的话页面只能退回一次性 chat（等十几秒再整块蹦出来）。 */
          onRetry: async ctl => o.run(answers || '', ctl),
          /* 「改回答」重画**同一批问题**（已选的答案带回去），不重新问一遍模型 ——
             再问一次模型多半会直接回润色结果，问题就丢了。 */
          onReask: questions.length ? () => renderAsk() : null,
          /* 「按这句再改」：把这一轮的**回答**一并交给页面（第 4 个参数），
             否则页面只能自己记住用户点过哪些候选 —— 那一笔账在这里现成。 */
          onFollow: o.onFollow ? (askText, current, ctl) => o.onFollow(askText, current, ctl, { answers: answers || '' }) : null,
          talk: o.talk, followPlaceholder: o.followPlaceholder,
        });
        if (o.onStatus) o.onStatus('', false);
        return el;
      };
      const renderAsk = () => self.ask(host, {
        title: o.askTitle, intro: o.askIntro, questions,
        state: lastState,
        onChange: st => { lastState = st; },
        onSubmit: t => run2(t, ''),
        onSkip: () => run2('', ''),
      });
      if (!questions.length) return run2('', asked ? '这次没能反问，直接润色' : '');
      return renderAsk();
    },
  };
})();

/* ============================================================================
   PromptReview —— AI 结果确认弹窗（多条规划结果用；单段润色走 InlinePolish 就地面板）
     · PromptReview.open({ title, sub, before, after, hint, applyLabel, retry })
         → 单段文本：左原文 / 右可编辑结果；resolve(编辑后的文本) 或 null（取消）
         · retry: async () => newText   「重新润色」按钮用
     · PromptReview.openList({ title, sub, items:[{label,text}], hint, applyLabel, retry })
         → 多段（如分镜切片）：逐条可编辑 / 可删除；resolve([{label,text}]) 或 null
     · PromptReview.openList({ ..., mode:'board', durEditable, estimate, lineEditable })
         → 分镜那一种：按场分组、每条改名字与秒数、组内拖动排序、顶部三个读数、
           点「重新规划」时**用户改过的那几条原样留着**。`lineEditable` 再把台词与说话人
           一起列出来（拆分镜那一路 AI 已经填了，先看得见再写入）。不传 `mode` 的调用方
           走的还是上面那份平铺实现，一个字节都没动 —— 这是这一条的红线（时间切片、
           图像拆段都在那一边）。
   ========================================================================== */
(function () {
  function mount(title, sub) {
    /* 同一时刻只留一张（与 PromptForm 同一条）：连点两次会叠出两张模态，
       底下那张 getElementById 拿不到、也关不掉。 */
    document.querySelectorAll('dialog#prDlg').forEach(d => { try { d.close(); } catch (e) { /* 已经关掉了，接着摘节点 */ } d.remove(); });
    const dlg = document.createElement('dialog');
    dlg.id = 'prDlg';
    dlg.innerHTML = `<div class="pr-head"><b>${window.esc(title)}</b>${sub ? `<div class="sub">${window.esc(sub)}</div>` : ''}</div>
      <div class="pr-body" id="prBody"></div>
      <div class="pr-foot"><button class="ghost" id="prRetry">${icon('refresh', 13)} 重新润色</button>
        <span class="hint" id="prHint"></span><span class="sp"></span>
        <button class="ghost" id="prCancel">取消</button>
        <button class="pri" id="prOk"></button></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    return dlg;
  }
  function close(dlg, out, resolve) { try { dlg.close(); } catch {} dlg.remove(); resolve(out); }

  /* ============================ 分镜审阅（mode:'board'）============================
     与平铺那一份同住本 IIFE、共用 mount / close / `.pr-*` 外壳，但**代码路径完全分开**：
     openList 只在 `o.mode === 'board'` 时走进这里并当场 return，平铺那段一行不经过。
     条目契约 {key, scene, name, dur, text}：
       · `key` = 这一镜在「AI 这一趟方案」里的身份。点「重新规划」后靠它认「哪几条是我改过的」，
         不靠第几条 —— 组内拖过、删过几条之后序号就指错人了（调用方没给时按「场名 + 该场第几镜」现推）。
       · `scene` = **场名**（不是序号），相邻同名并成一组；拖动只许在本组内进行 ——
         跨场等于替用户把这一镜改到另一场去，那是拆分镜弹窗 `move` 的活，不是这里的一条手势。
       · `dur` = 秒数或 null（未定）。这里**一律不夹区间**：夹取只有落盘后 `clampShotDurations`
         那一处。弹窗里夹一回、落盘再夹一回，界面上的数与发出去的数就是两回事。
       · 时长输入格、总时长读数、估价三处一起听 `o.durEditable`（调用方递 `durWritable()`）：
         一家都没声明区间时这条链压根写不进秒数，就不该在界面上把它们求和、更不该按秒数估价。
       · `o.estimate(rows)` 由调用方给（导演台用它问 `AssetLib.estimateCost`），这一层只负责显示；
         空串 / 抛错都只说「报价不可用」，不拦采用 —— 估价问不到不等于这批镜头不能拆。 */
  function openBoard(o, dlg, body, okBtn, resolve) {
    let uid = 0, rows = [];
    const canDur = !!o.durEditable, canEst = typeof o.estimate === 'function';
    function normAll(arr) {
      const seen = new Map();
      return (arr || []).map(x => {
        const src = x && typeof x === 'object' ? x : {};
        const scene = String(src.scene == null ? '' : src.scene).trim() || '未分组';
        let key = String(src.key == null ? '' : src.key).trim();
        if (!key) { const n = (seen.get(scene) || 0) + 1; seen.set(scene, n); key = scene + '·' + n; }
        const raw = src.dur == null ? src.duration : src.dur;
        const d = Number(raw);
        return { u: ++uid, key, scene, name: String(src.name == null ? '' : src.name),
          dur: Number.isFinite(d) && d > 0 ? d : null,
          /* 接上一镜（`chain:'tail'`）由程序拆长镜头时标上，人也能在导演台里改；
             这里只读不改 —— 它决定这一镜提交时的首帧从哪儿来，弹窗里至少得让人看见。
             `chainModel` 是拆的时候挑好的接续型号，落盘时一起带走。 */
          chain: src.chain === 'tail' ? 'tail' : '',
          chainModel: String(src.chainModel == null ? '' : src.chainModel),
          /* 台词与说话人是分镜拆分那一路才会用到的一组字段（`lineEditable`）：
             平铺审阅不看它们，但原样存在这里，重新规划时「改过的那几条」才不会被新方案冲掉。 */
          line: String(src.line == null ? '' : src.line),
          who: String(src.who != null ? src.who : (src.speaker == null ? '' : src.speaker)),
          text: String(src.text == null ? '' : src.text), raw: src, edited: false };
      });
    }
    rows = normAll(o.items);
    const byU = u => { for (const r of rows) if (r.u === u) return r; return null; };

    /* 三个读数摆在标题与清单之间：`mount()` 那份外壳里没有这一行（平铺那一路零足迹），
       由这里插进去 —— 删条目、拖动、改秒数之后这一行必须跟着变，而它变得**不许动清单**。 */
    const sum = document.createElement('div');
    sum.className = 'pr-sum';
    sum.innerHTML = `<span class="s"><i>镜数</i><b id="prN">0</b></span>
      <span class="s"><i>总时长</i><b id="prTot">—</b></span>
      ${canEst ? '<span class="s"><i>估价</i><b id="prEst">—</b></span>' : ''}
      <span class="pn" id="prPin" hidden></span>`;
    dlg.querySelector('.pr-head').after(sum);
    const qN = sum.querySelector('#prN'), qTot = sum.querySelector('#prTot');
    const qEst = sum.querySelector('#prEst'), qPin = sum.querySelector('#prPin');

    /* 按**相邻同名**并组（拖动只在一场内换序，所以相邻就足够，不必全场排序）。
       名字不叫 `groups` —— 那个名字是 `Chars.Lib` 分组名单三兄弟的一份判据（按 `nameKey` 合并），
       这一处只是「弹窗里把同一场的镜头画在同一个组头下面」，两件事共用一个名字迟早让人认错。 */
    function sceneGroups() {
      const out = []; let cur = null;
      rows.forEach(r => {
        if (!cur || cur.scene !== r.scene) { cur = { scene: r.scene, items: [] }; out.push(cur); }
        cur.items.push(r);
      });
      out.forEach(g => g.items.forEach((r, i) => { r.no = i + 1; }));
      return out;
    }
    function rowHTML(r) {
      const dur = canDur
        ? `<span class="bdur"><input class="pb-dur" type="number" min="1" step="1" data-u="${r.u}" value="${r.dur == null ? '' : r.dur}" aria-label="这一镜几秒"><i>秒</i></span>`
        : '';
      const textCell = `<textarea class="pb-text" data-u="${r.u}">${esc(r.text)}</textarea>`;
      /* 拆分镜这一路把台词一起列出来：AI 已经按剧本填了 `line` / `speaker`，
         不在这儿显示的话，用户点「新建短片」之前根本看不见它填了什么。
         说话的人只有这一件控件（与导演台右栏同一立场）；台词空着时人不留着。 */
      const bodyCell = o.lineEditable
        ? `<div class="bcol">${textCell}<div class="bline">
            <input class="pb-who" data-u="${r.u}" value="${esc(r.who)}" placeholder="说话的人" aria-label="说这句话的人">
            <textarea class="pb-line" data-u="${r.u}" placeholder="这一镜的台词（没有就留空）">${esc(r.line)}</textarea>
          </div></div>`
        : textCell;
      const chain = r.chain === 'tail'
        ? '<span class="bchain" title="生成时自动截上一镜的尾帧当这一镜的首帧">接上一镜</span>' : '';
      return `<div class="pr-row brow${r.edited ? ' pin' : ''}" data-u="${r.u}" data-scene="${esc(r.scene)}">
        <span class="grip" draggable="true" title="按住这里在本场景内上下拖动排序">${icon('list', 12)}</span>
        <span class="no">${r.no}</span>
        <input class="pb-name" data-u="${r.u}" value="${esc(r.name)}" placeholder="镜头名" aria-label="这一镜的名字">
        ${dur}
        ${chain}
        ${bodyCell}
        <button class="x iconbtn" data-del="${r.u}" title="删掉这一条">${icon('close', 11)}</button>
      </div>`;
    }
    function paint() {
      /* 「待建素材」那块在镜头清单**上面** —— 它决定的是「这一镜引用谁」，
         放在下面会被镜头那一大堆挤到看不见。 */
      body.innerHTML = assetRowsHTML() + (rows.length
        ? sceneGroups().map(g => `<div class="pr-grp" data-scene="${esc(g.scene)}">
            <div class="gh"><b>${esc(g.scene)}</b><span class="gn">${g.items.length} 镜</span></div>
            ${g.items.map(rowHTML).join('')}</div>`).join('')
        : `<div class="pr-loading">${esc(o.empty || '没有可用的镜头，请点「重新规划」或取消')}</div>`);
      okBtn.disabled = !rows.length;
      bindRows();
      bindAssets();
      paintSum();
    }
    /* 就地改一格 = 只写数据 + 改读数，**不重画清单**：整表重画会把正在敲的那格换掉、光标跳走
       （导演台台词区那条 `paintDrift` 的教训在这里一模一样）。只有删条与拖完才 paint()。 */
    function markPin(r) {
      r.edited = true;
      const el = body.querySelector('.brow[data-u="' + r.u + '"]');
      if (el) el.classList.add('pin');
    }
    function bindRows() {
      body.querySelectorAll('.pb-name').forEach(el => {
        el.oninput = () => { const r = byU(+el.dataset.u); if (!r) return; r.name = el.value; markPin(r); };
      });
      body.querySelectorAll('.pb-dur').forEach(el => {
        el.oninput = () => {
          const r = byU(+el.dataset.u); if (!r) return;
          const v = Number(el.value);
          r.dur = Number.isFinite(v) && v > 0 ? v : null;
          markPin(r); paintSum();
        };
      });
      body.querySelectorAll('.pb-text').forEach(el => {
        el.oninput = () => { const r = byU(+el.dataset.u); if (!r) return; r.text = el.value; markPin(r); };
      });
      body.querySelectorAll('.pb-who').forEach(el => {
        el.oninput = () => { const r = byU(+el.dataset.u); if (!r) return; r.who = el.value; markPin(r); };
      });
      body.querySelectorAll('.pb-line').forEach(el => {
        el.oninput = () => {
          const r = byU(+el.dataset.u); if (!r) return;
          r.line = el.value; markPin(r);
          /* 台词清掉时说话人一起清：一句没有台词的名字是条死数据，
             会被下一镜的配音按钮拿去问一个不存在的音色（与 applyScript 同一判据）。 */
          if (!el.value.trim() && r.who) {
            r.who = '';
            const w = body.querySelector('.pb-who[data-u="' + r.u + '"]');
            if (w) w.value = '';
          }
        };
      });
      body.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = () => { const r = byU(+b.dataset.del); const i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1); paint(); };
      });
      bindDrag();
    }
    let dragU = null;
    const clearMarks = () => body.querySelectorAll('.dropbef,.dropaft').forEach(n => n.classList.remove('dropbef', 'dropaft'));
    const afterMid = (e, row) => { const b = row.getBoundingClientRect(); return e.clientY > b.top + b.height / 2; };
    function bindDrag() {
      body.querySelectorAll('.grip').forEach(g => {
        const row = g.parentNode;
        g.addEventListener('dragstart', e => {
          dragU = +row.dataset.u;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(dragU)); } catch {}
          }
          row.classList.add('drag');
        });
        g.addEventListener('dragend', () => { dragU = null; row.classList.remove('drag'); clearMarks(); });
      });
      body.querySelectorAll('.brow').forEach(row => {
        row.addEventListener('dragover', e => {
          const from = byU(dragU), to = byU(+row.dataset.u);
          /* 跨场（或拖到自己身上）时**不 preventDefault**：浏览器于是给「禁止落」的光标，
             既不落点也不弹一句「拖不过去」—— 这一条做不到是设计，不是坏了，别拿 Toast 喊。 */
          if (!from || !to || from === to || from.scene !== to.scene) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          clearMarks();
          row.classList.add(afterMid(e, row) ? 'dropaft' : 'dropbef');
        });
        row.addEventListener('dragleave', () => row.classList.remove('dropbef', 'dropaft'));
        row.addEventListener('drop', e => {
          const from = byU(dragU), to = byU(+row.dataset.u);
          const tail = afterMid(e, row);
          clearMarks();
          if (!from || !to || from === to || from.scene !== to.scene) return;
          e.preventDefault();
          rows.splice(rows.indexOf(from), 1);
          let j = rows.indexOf(to); if (tail) j++;
          rows.splice(j, 0, from);
          dragU = null;                       // 拖把手那个节点已经随整表重画换掉，dragend 未必还落到它身上
          paint();
        });
      });
    }
    /* 读数：条数与秒数同步改，估价异步问（见下面 queueEst）。 */
    function paintSum() {
      qN.textContent = String(rows.length);
      if (canDur) {
        let tot = 0, miss = 0;
        rows.forEach(r => { if (r.dur == null) miss++; else tot += r.dur; });
        qTot.textContent = tot > 0 ? Math.round(tot) + ' 秒' + (miss ? '（' + miss + ' 镜没填时长）' : '')
          : (miss ? '时长都没填' : '—');
      } else { sum.querySelectorAll('.s')[1].hidden = true; }
      queueEst();
    }
    /* 估价的三条规矩（与导演台 `refreshEst` 那一族同一立场）：
       ① 影响价钱的那几个数没变就不重问，也不把屏幕上已有的数擦成「估价中…」；
       ② 连续改格只问一次（去抖 500ms），期间回来的旧答案按序号作废；
       ③ 问不到只说「报价不可用」，采用那颗按钮照常能点。 */
    let estSig = '', estSeq = 0, estTimer = null;
    function queueEst() {
      if (!canEst) return;
      const sig = rows.length + '|' + rows.map(r => (r.dur == null ? '' : r.dur)).join(',');
      if (sig === estSig) return;
      estSig = sig;
      if (qEst) qEst.textContent = '估价中…';
      if (estTimer) clearTimeout(estTimer);
      estTimer = setTimeout(() => { estTimer = null; runEst(); }, 500);
    }
    async function runEst() {
      const my = ++estSeq;
      const list = rows.map(r => ({ key: r.key, scene: r.scene, name: r.name, dur: r.dur, text: r.text }));
      let t = '';
      try { t = String((await o.estimate(list)) || ''); } catch { t = ''; }
      if (my !== estSeq) return;
      if (qEst) qEst.textContent = t.trim() || '报价不可用';
    }
    /* 「重新规划」：新方案覆盖上来，但**用户改过的那几条原样留着**（判据是「改过没有」，不是第几条）。
       归并按场走：新方案里还在的场按新顺序摆，改过的那几条接在本场新条目之后；
       只剩钉住条目的场（新方案里没有这一场了）整组追加到表尾并计数说明。 */
    function mergeFresh(fresh) {
      const pinned = rows.filter(r => r.edited);
      const pk = new Set(pinned.map(r => r.key));
      const fmap = new Map(), pmap = new Map(), scenes = [];
      const put = (m, r) => { if (!m.has(r.scene)) m.set(r.scene, []); m.get(r.scene).push(r); };
      fresh.forEach(r => { if (pk.has(r.key)) return; put(fmap, r); if (scenes.indexOf(r.scene) < 0) scenes.push(r.scene); });
      pinned.forEach(r => put(pmap, r));
      pmap.forEach((_, s) => { if (scenes.indexOf(s) < 0) scenes.push(s); });
      const freshKeys = new Set(fresh.map(r => r.key));
      const out = []; let orphan = 0;
      scenes.forEach(s => {
        const ps = pmap.get(s) || [];
        ps.forEach(r => { if (!freshKeys.has(r.key)) orphan++; });
        (fmap.get(s) || []).concat(ps).forEach(r => out.push(r));
      });
      return { out, pinned: pinned.length, orphan };
    }
    function note(t, bad) {
      if (!qPin) return;
      qPin.textContent = t || '';
      qPin.hidden = !t;
      qPin.classList.toggle('bad', !!bad);
    }
    /* 「待建素材」那块（`o.assetEditable`）：拆分镜那一条要建档的角色/场景/物品。
       它**不是镜头** —— 所以单独一块，画在镜头清单上面：可逐条改名字 / 外貌 / 音色描述、可删。
       确认时把编辑后的那一份交给调用方（`o.onAssets(assets)`）——
       用回调而不是改返回值形状，是为了不破坏现有那些「返回数组」的调用方。 */
    let assets = Array.isArray(o.assets) ? o.assets.map(a => Object.assign({}, a)) : [];
    const canAssets = !!o.assetEditable;
    /* 素材名字的归一：跟全站那把尺子（window.nameKey）一样 —— 「小雅」与「小雅 」算同一条。
       没有 window.nameKey 时退回 trim + 小写（判据不会更严，只是近名可能不合并）。 */
    const nameKeyOf = s => {
      const t = String(s == null ? '' : s).trim();
      if (!t) return '';
      return (window.nameKey ? window.nameKey(t) : t.toLowerCase());
    };
    function assetRowsHTML() {
      if (!canAssets) return '';
      if (!assets.length) return '<div class="pr-assets"><div class="gh"><b>待建素材</b>'
        + '<span class="gn">0 条</span></div><div class="pr-note">这一份方案里没有要新建的素材</div></div>';
      return '<div class="pr-assets"><div class="gh"><b>待建素材</b>'
        + '<span class="gn">' + assets.length + ' 条 · 确认后建档并出图</span></div>'
        + assets.map((a, i) => `<div class="pr-arow" data-a="${i}">
            <input class="pa-name" data-a="${i}" value="${esc(a.name || '')}" placeholder="名字" aria-label="这一条素材的名字">
            <span class="pa-kind">${esc(kindZh(a.kind))}</span>
            <input class="pa-look" data-a="${i}" value="${esc(a.look || '')}" placeholder="外貌 / 场景 / 物品描述" aria-label="外貌描述">
            ${a.kind === 'actor' ? `<input class="pa-voice" data-a="${i}" value="${esc(a.voice || '')}" placeholder="音色描述（30~80 字）" aria-label="音色描述">` : ''}
            <button class="x iconbtn" data-adel="${i}" title="不建这一条">${icon('close', 11)}</button>
          </div>`).join('')
        + '</div>';
    }
    const kindZh = k => (k === 'scene' ? '场景' : (k === 'prop' ? '物品' : '角色'));
    function bindAssets() {
      if (!canAssets) return;
      /* 改过的打一个 `edited` 标记 —— 「重新规划」那一轮据此把改过的那几条原样留着
         （与镜头清单的 mergeFresh 同一立场）。 */
      const mark = a => { if (a) a.edited = true; };
      body.querySelectorAll('.pa-name').forEach(el => {
        el.oninput = () => { const a = assets[+el.dataset.a]; if (a) { a.name = el.value; mark(a); } };
      });
      body.querySelectorAll('.pa-look').forEach(el => {
        el.oninput = () => { const a = assets[+el.dataset.a]; if (a) { a.look = el.value; mark(a); } };
      });
      body.querySelectorAll('.pa-voice').forEach(el => {
        el.oninput = () => { const a = assets[+el.dataset.a]; if (a) { a.voice = el.value; mark(a); } };
      });
      body.querySelectorAll('[data-adel]').forEach(b => {
        b.onclick = () => { assets.splice(+b.dataset.adel, 1); paint(); };
      });
    }
    okBtn.onclick = () => {
      const per = new Map(), out = [];
      rows.forEach(r => {
        /* 空正文照旧丢掉（「这一条没写出任何东西」= 不采用它），`keep` 是调用方留的例外 ——
           与平铺那一份同一个判据。 */
        if (!r.raw.keep && !(r.text || '').trim()) return;
        const n = (per.get(r.scene) || 0) + 1; per.set(r.scene, n);
        const row = {
          key: r.key, scene: r.scene, name: r.name, dur: r.dur, text: r.text,
          shotNo: n,                       // 该场第几镜：只给报告用，落盘认的是数组顺序
          label: r.scene + ' · 镜头 ' + n,
          /* 接续标记与拆的时候挑好的型号（空串 = 这一镜不接）：落盘要写 `linkPrev` / `model`，
             没这两项，弹窗里看得见的「接上一镜」写进去就没了。 */
          chain: r.chain === 'tail' ? 'tail' : '',
          chainModel: r.chainModel,
        };
        /* 只在真的露出台词那一档才覆盖这两项：没露出的调用方连一个字都没看见，
           交给它一份现推的空台词等于把原数据擦掉。 */
        if (o.lineEditable) {
          row.line = String(r.line || '').trim();
          row.who = row.line ? String(r.who || '').trim() : '';
        }
        out.push(Object.assign({}, r.raw, row));
      });
      /* 「待建素材」那一份交给调用方（拆分镜那一条要拿去建档出图）。
         用回调而不是改返回值形状 —— 返回值是数组，改形状会破坏现有那些调用方。 */
      if (canAssets && typeof o.onAssets === 'function') {
        try { o.onAssets(assets.filter(a => String(a.name || '').trim())); } catch (e) { /* 交不回去也不拦采用 */ }
      }
      close(dlg, out, resolve);
    };
    dlg.querySelector('#prCancel').onclick = () => close(dlg, null, resolve);
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(dlg, null, resolve); });
    const retry = dlg.querySelector('#prRetry');
    if (o.retry) {
      retry.innerHTML = icon('refresh', 13) + ' 重新规划';
      retry.onclick = async () => {
        retry.disabled = true; retry.textContent = '规划中…';
        note('');
        const mine = rows;                 // 问失败时要原样退回的这一版：一个字都不动
        const mineAssets = assets.slice(); // 同上：待建素材那一份也一个字都不动
        rows = []; paint();
        let fresh = null, why = '';
        try { fresh = normAll(await o.retry()); } catch (e) { why = errText(e); }
        if (why) {
          rows = mine; paint();
          note('重新规划失败：' + why + '（下面还是这一版，一条没丢）', true);
        } else {
          const m = mergeFresh(fresh);
          rows = m.out;
          /* 待建素材：新一轮的清单也换掉，但**用户改过的那几条原样留着**
             （与镜头的 mergeFresh 同一立场：改过的不被新一轮冲掉）。 */
          if (canAssets && typeof o.retryAssets === 'function') {
            const editedNames = new Set(mineAssets.filter(a => a.edited).map(a => nameKeyOf(a.name)));
            let fa = null;
            try { fa = await o.retryAssets(); } catch (e) { fa = null; }
            if (Array.isArray(fa)) {
              const keep = mineAssets.filter(a => editedNames.has(nameKeyOf(a.name)));
              const seen = new Set(keep.map(a => nameKeyOf(a.name)));
              assets = keep.concat(fa.filter(a => a && !seen.has(nameKeyOf(a.name))).map(a => Object.assign({}, a)));
            } else {
              assets = mineAssets;    // 没问成 / 没提供这一路 → 保持原样，不清空
            }
          }
          paint();
          note(m.pinned ? '已留着改过的 ' + m.pinned + ' 条'
            + (m.orphan ? '，其中 ' + m.orphan + ' 条在新方案里没有对应、原样保留' : '') : '', false);
        }
        retry.disabled = false; retry.innerHTML = icon('refresh', 13) + ' 重新规划';
      };
    } else retry.style.display = 'none';
    paint();
  }

  window.PromptReview = {
    open(o) {
      return new Promise(resolve => {
        const dlg = mount(o.title || 'AI 润色结果（确认后再采用）', o.sub);
        const body = dlg.querySelector('#prBody');
        const okBtn = dlg.querySelector('#prOk');
        okBtn.textContent = o.applyLabel || '采用这段提示词';
        dlg.querySelector('#prHint').textContent = o.hint || '右侧内容可以直接编辑';
        const paint = after => {
          body.innerHTML = `<div class="pr-cols">
            <div class="pr-col"><h4>原始内容</h4><div class="ro" id="prBefore"></div></div>
            <div class="pr-col"><h4>AI 润色后（可编辑）</h4><textarea id="prAfter"></textarea></div>
          </div>`;
          body.querySelector('#prBefore').textContent = o.before || '(空)';
          body.querySelector('#prAfter').value = after;
          body.querySelector('#prAfter').focus();
        };
        paint(o.after || '');
        okBtn.onclick = () => close(dlg, (body.querySelector('#prAfter').value || '').trim() || null, resolve);
        dlg.querySelector('#prCancel').onclick = () => close(dlg, null, resolve);
        dlg.addEventListener('cancel', e => { e.preventDefault(); close(dlg, null, resolve); });
        const retry = dlg.querySelector('#prRetry');
        if (o.retry) {
          retry.onclick = async () => {
            retry.disabled = true; retry.textContent = '润色中…';
            body.innerHTML = '<div class="pr-loading"><span class="spin-dot"></span>正在重新润色…</div>';
            try { paint(await o.retry()); } catch (e) { paint(''); body.insertAdjacentHTML('afterbegin', `<div style="color:var(--err,#dc2626);font-size:12px;margin-bottom:8px">重新润色失败：${esc(e.message)}</div>`); }
            retry.disabled = false; retry.innerHTML = icon('refresh', 13) + ' 重新润色';
          };
        } else retry.style.display = 'none';
      });
    },

    openList(o) {
      return new Promise(resolve => {
        const dlg = mount(o.title || 'AI 规划结果（确认后再生成）', o.sub);
        const body = dlg.querySelector('#prBody');
        const okBtn = dlg.querySelector('#prOk');
        okBtn.textContent = o.applyLabel || '采用并开始生成';
        dlg.querySelector('#prHint').textContent = o.hint || '可以逐条修改或删掉不想生成的画面';
        /* 分镜那一种走上面那一套分组审阅，**当场 return**：下面这份平铺实现不认识 mode，
           时间切片与图像拆段那些调用方（不传 mode）走的还是原路 —— 一条 if 之外的字节都不动。 */
        if (o.mode === 'board') { openBoard(o, dlg, body, okBtn, resolve); return; }
        /* 条目上**多带的字段原样带着走**（`...x`）：导演台「修改现有分镜」拿它记 op / 目标镜头
           / 改哪几段（label 与 text 只是给人的两栏）。以前这里只挑 label / text 重拼 ——
           调用方拿回条目时附加字段全丢了，只能靠标签正则回查，场景名一改就对不上号。
           重拼 label / text 两个键是为了保住老形状（调用方都读这两项）。 */
        let items = (o.items || []).map(x => ({ ...x, label: x.label, text: x.text }));
        const paint = () => {
          /* `it.sub` 是可选的一行小字（只给人看「这一条会改什么」，如「原：… · 时长 5→8 秒」），
             不参与编辑 —— 要改的正文在右边的 textarea 里。 */
          body.innerHTML = items.length ? items.map((it, i) => `<div class="pr-row" data-i="${i}">
              <span class="tt">${esc(it.label)}${it.sub ? `<span class="psub">${esc(it.sub)}</span>` : ''}</span>
              <textarea data-i="${i}">${esc(it.text || '')}</textarea>
              <button class="x iconbtn" data-del="${i}" title="删掉这一条">${window.icon('close', 11)}</button>
            </div>`).join('') : `<div class="pr-loading">${esc(o.empty || '没有可用的画面，请点「重新润色」或取消')}</div>`;
          okBtn.disabled = !items.length;
          body.querySelectorAll('textarea').forEach(ta => ta.oninput = () => { items[+ta.dataset.i].text = ta.value; });
          body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { items.splice(+b.dataset.del, 1); paint(); });
        };
        paint();
        /* 空正文的条目默认丢掉（「这一张没写出任何东西」= 不生成它）；`keep` 是给
           「只改名字 / 时长，没有正文可展示」那一类留的例外 —— 正文那一格本来就是空的，
           照默认丢它等于用户点了「写入」而改动一条都没落下去。 */
        okBtn.onclick = () => close(dlg, items.filter(x => x.keep || (x.text || '').trim()), resolve);
        dlg.querySelector('#prCancel').onclick = () => close(dlg, null, resolve);
        dlg.addEventListener('cancel', e => { e.preventDefault(); close(dlg, null, resolve); });
        const retry = dlg.querySelector('#prRetry');
        if (o.retry) {
          retry.innerHTML = icon('refresh', 13) + ' 重新规划';
          retry.onclick = async () => {
            retry.disabled = true; retry.textContent = '规划中…';
            body.innerHTML = '<div class="pr-loading"><span class="spin-dot"></span>正在重新规划…</div>';
            try { items = (await o.retry()).map(x => ({ ...x, label: x.label, text: x.text })); }
            catch (e) { items = []; body.insertAdjacentHTML('afterbegin', `<div style="color:var(--err,#dc2626);font-size:12px;margin-bottom:8px">重新规划失败：${esc(e.message)}</div>`); }
            retry.disabled = false; retry.innerHTML = icon('refresh', 13) + ' 重新规划';
            paint();
          };
        } else retry.style.display = 'none';
      });
    },
  };
})();

/* ============================================================================
   Confirm —— 页内确认 / 选择弹窗（替代浏览器原生 confirm；样式与润色弹窗同一套）
   const ok = await Confirm.ask({ title, body, okLabel, cancelLabel, danger, sub });
   const v  = await Confirm.choose({ title, body, options: [{ value, label, hint }] });  // 取消返回 null
   ========================================================================== */
(function () {
  function shell(title, sub) {
    const dlg = document.createElement('dialog');
    dlg.id = 'cfDlg';
    dlg.innerHTML = `<div class="pr-head"><b>${window.esc(title)}</b>${sub ? `<div class="sub">${window.esc(sub)}</div>` : ''}</div>
      <div class="pr-body" id="cfBody"></div>
      <div class="pr-foot" id="cfFoot"></div>`;
    /* 记下「是谁把弹窗叫出来的」：关掉之后焦点要还给那一个按钮。
       不还的话焦点落回 body，键盘用户按 Tab 得从页面头重新找一遍 ——
       而危险确认弹的正是「取消」，用户按 Esc 关掉后原本要改主意的那颗按钮已经不在焦点路径上了。
       挂在 dlg 身上而不是让每个调用点多传一个参数：shut 是唯一出口，认这一份就够。 */
    dlg.__opener = document.activeElement;
    document.body.appendChild(dlg);
    dlg.showModal();
    return { dlg, body: dlg.querySelector('#cfBody'), foot: dlg.querySelector('#cfFoot') };
  }
  const shut = (dlg, resolve, v) => {
    const opener = dlg.__opener;
    try { dlg.close(); } catch {} dlg.remove();
    if (opener && opener.isConnected && typeof opener.focus === 'function') { try { opener.focus(); } catch {} }
    resolve(v);
  };
  /* 就地二次确认（Confirm.arm）当前那个「确认中」的按钮。
     整页**同时只有一个**：点别的地方、或点另一个删除按钮，上一个自动还原 ——
     界面上同时挂着两个「确认？再点一下」只会让人不知道哪一个是真的。
     状态记的是**按钮 + key**，不只是那个 DOM 节点：拍片记录那一列每次进度回调都整块
     innerHTML 重画，节点换人之后武装态必须能按 key 找回来（restoreArmed）。 */
  let armed = null;
  function paintArmed(el, a) {
    el.classList.add('armed');
    /* badge 模式（opts.badge）：**一个字都不动 el 的内容**，只在角上挂一枚小标签。
       默认画法是 textContent —— 那对按钮是对的（按钮只有一行字），可拿来武装**一张脸 /
       一张缩略图**就会把图整个冲掉：武装的那 5 秒里用户看到的是一块红底空白，
       而「等的就是再点一下」必须让他看清**是哪一张**才成立。
       还原走 disarm 里的 `el.innerHTML = a.html`（快照取自挂标签之前），所以下面
       不用另外记状态；只要别忘了把 armed-badge 这个 class 也摘掉。 */
    if (a.badge) {
      el.classList.add('armed-badge');
      const b = document.createElement('i');
      b.className = 'arm-badge';
      b.textContent = a.label || '确认';
      el.appendChild(b);
    }
    else el.textContent = a.label || '确认';
    /* 默认提示**不许写死「真删了」**：arm() 是通用的就地二次确认，不只删除在用 ——
       「重新拆剧本」这种**不删任何东西**、但要花钱的动作也走它，不传 hint 就会显示
       「再点一次就真删了」，等于在告诉用户一件根本没发生的事。
       所以默认说法从 label 里取动词：删除的地方照旧读成「真删了」，
       不删的地方读成它自己那个动词，一处判据、不用每个调用方各写一句。 */
    el.setAttribute('title', a.hint || ('再点一次就「' + (a.label || '执行') + '」 · 点别处或过一会儿自动取消'));
  }
  function disarm() {
    const a = armed; if (!a) return;
    armed = null;
    clearTimeout(a.timer);
    const el = a.el;
    if (!el) return;
    el.classList.remove('armed');
    el.classList.remove('armed-badge');
    /* 按钮可能已经被整块重画换掉了（内联脚本换过 innerHTML）—— 那就没什么可还原的 */
    if (el.isConnected) {
      el.innerHTML = a.html;
      if (a.title == null) el.removeAttribute('title'); else el.setAttribute('title', a.title);
    }
  }
  window.Confirm = {
    ask(o) {
      return new Promise(resolve => {
        const { dlg, body, foot } = shell(o.title || '确认操作', o.sub);
        body.innerHTML = '<div class="cf-msg"></div>';
        body.querySelector('.cf-msg').textContent = o.body || '';
        const no = document.createElement('button');
        no.className = 'ghost'; no.textContent = o.cancelLabel || '取消';
        const yes = document.createElement('button');
        yes.className = 'pri' + (o.danger ? ' danger' : ''); yes.textContent = o.okLabel || '确定';
        foot.appendChild(Object.assign(document.createElement('span'), { className: 'sp' }));
        foot.appendChild(no); foot.appendChild(yes);
        no.onclick = () => shut(dlg, resolve, false);
        yes.onclick = () => shut(dlg, resolve, true);
        dlg.addEventListener('cancel', e => { e.preventDefault(); shut(dlg, resolve, false); });
        /* 危险操作把焦点放在「取消」：Enter 是「取消」而不是「执行删除」。
           普通确认仍然聚焦「确定」，不改那一类的顺手程度。 */
        (o.danger ? no : yes).focus();
      });
    },
    choose(o) {
      return new Promise(resolve => {
        const { dlg, body, foot } = shell(o.title || '请选择', o.sub);
        /* `bodyNode`：**带交互的正文**（选择器、预览、试听…）。走 o.body 的那条只放纯文本
           （textContent）—— 那是这一层的立场：用户可见的文案不塞未转义的 HTML。
           要真需要一块能点的内容，就由页面造好一个节点递进来（节点是它自己造的，不是字符串）。
           两者只许给一个；都给了以 bodyNode 为准（它显然是更具体的那一个）。 */
        if (o.bodyNode) body.appendChild(o.bodyNode);
        else if (o.body) { body.innerHTML = '<div class="cf-msg" style="margin-bottom:12px"></div>'; body.querySelector('.cf-msg').textContent = o.body; }
        const box = document.createElement('div');
        box.className = 'cf-opts';
        (o.options || []).forEach(op => {
          const b = document.createElement('button');
          b.className = 'cf-opt';
          b.innerHTML = '<b></b><span></span>';
          b.querySelector('b').textContent = op.label || '';
          b.querySelector('span').textContent = op.hint || '';
          if (!op.hint) b.querySelector('span').remove();
          b.onclick = () => shut(dlg, resolve, op.value);
          box.appendChild(b);
        });
        body.appendChild(box);
        const no = document.createElement('button');
        no.className = 'ghost'; no.textContent = o.cancelLabel || '取消';
        foot.appendChild(Object.assign(document.createElement('span'), { className: 'sp' }));
        foot.appendChild(no);
        no.onclick = () => shut(dlg, resolve, null);
        dlg.addEventListener('cancel', e => { e.preventDefault(); shut(dlg, resolve, null); });
        const first = box.querySelector('.cf-opt');
        if (first) first.focus();
      });
    },

    /* ---------- 就地二次确认：删除这类动作不弹窗，改为按钮自己变成「确认」 ----------
       为什么不用上面那个 ask()：删一段、删一次拍摄、删一个角色是**连着点**的动作，
       每点一下弹一次模态框，页面节奏就被打断一次 —— 而且模态框一关，焦点、滚动位置、
       正在看的那一段全得重新找回来（用户往往就是删完一条接着看下一条）。
       「再点一下就真删」放在原地，代价最低，也不会把人从当前这一屏挪走。
       返回 true = 刚武装（调用方就此停下，别做那件事）；false = 这是第二次点，请往下执行。

       opts: { ms, hint, note, key }
         ms   武装多久自动还原（默认 5 秒）
         hint 武装态的 title（默认「再点一次就真删了 · 点别处自动取消」）
         key  这一次动作的**稳定身份**（例如 takeId）。给了它，整块 innerHTML 重画之后
              能靠 restoreArmed 把武装态找回来 —— 拍片记录每次进度回调都重画，
              没有这一步就是「点一下变确认、进度一来又变回 ✕、再点一下又变确认」。
         note 后果说明 —— 弹窗没了，原来写在确认框正文里的那几句话要**留在眼前**，
              用 toast（它就响在这一秒、人正在看这个按钮）。**只写与这次删除直接相关的后果**：
              「还会连带 N 条拍摄」「N 次还在平台上跑着」这种；不影响这次操作的话一句都别写。 */
    arm(el, label, opts) {
      if (!el) return true;
      opts = opts || {};
      if (armed && armed.el === el) { disarm(); return false; }   // 第二次点：先还原，再放行
      disarm();                                                    // 整页同时只有一个「确认中」
      const ms = opts.ms || 5000;
      armed = { el: el, key: opts.key || '', label: label, hint: opts.hint || '', badge: !!opts.badge,
        html: el.innerHTML, title: el.getAttribute('title'), timer: 0, deadline: Date.now() + ms };
      paintArmed(el, armed);                                        // 按钮走文字、badge 模式走角标（见上）
      armed.timer = setTimeout(disarm, ms);
      if (opts.note && window.Toast) window.Toast.err(opts.note, ms);
      return true;
    },
    /* 只读判据：调用方要自己拼 label / note 时用它（绝大多数地方直接用 arm 即可） */
    isArmed(el) { return !!(armed && armed.el === el); },
    /* 重画之后把武装态按 key 挂回新节点（**必须带 key 的 arm 才有效**）。
       传 `find(key) → 按钮`。找不到就不动 —— 那一行多半真被删了，
       让 disarm 按原来的时限自己收尾就行。 */
    restoreArmed(find) {
      if (!armed || !armed.key || !find) return;
      const el = find(armed.key);
      if (!el || el === armed.el) return;
      const a = armed;
      clearTimeout(a.timer);
      a.el = el; a.html = el.innerHTML; a.title = el.getAttribute('title');
      paintArmed(el, a);
      const left = Math.max(1200, a.deadline - Date.now());
      a.timer = setTimeout(disarm, left);
    },
    /* 还原（页面整块重画后不需要 —— 那个按钮已经不在文档里了） */
    disarm,
  };

  /* 「再点一下就真删」这句话只在原地成立：人一挪开注意力就该自动撤销，
     不能隔着一个仍然点得中的按钮等着下一次误触（点别处 / Esc 都还原）。
     监听装一次，用捕获阶段 —— 目标在**武装着的那一个**里就放过（那是第二次点击，由 arm 自己处理）。
     判别式是 `.armed` 而不是 `button.armed`：badge 模式武装的是一个 div（带脸的格子），
     写成 button.armed 的话，第二次点它自己反而会先把自己还原掉 ——
     arm 只看「armed 里是不是同一个 el」，还原完 armed 成了 null，于是又重新武装一遍，
     那个动作永远执行不到（看上去就是「点了没反应」）。 */
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', e => {
      if (!armed) return;
      const t = e.target;
      if (t && t.closest && t.closest('.armed')) return;
      disarm();
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && armed) disarm(); }, true);
  }
})();

/* ============================================================================
   UiDialog —— 自定义内容的弹窗（复用 Confirm 那一套 .pr-* 外壳，全站只有一个弹窗外壳）
   ---------------------------------------------------------------------------
   Confirm 只能「一段文字 + 确定/取消」，PromptForm 只能「若干字段 + 一个确定」。
   碰上「要放一个 <audio> 让用户试听，还要三个按钮」这类，页面就只能自己手搓 <dialog> ——
   结果每个页面各写一份 .dr-head/.dr-foot，样式慢慢走样。所以把外壳提到这里：
     const v = await UiDialog.open({
       title, sub,
       body(el) { el.innerHTML = '…'; },          // 自定义内容（音频、预览、列表…）
       actions: [{ label:'不用配乐', value:'off' }, { label:'换一段', value:'change' }, { label:'取消', value:null }],
       onOpen(el, close) { … },                    // 需要自己接管关闭时用
     });   // 返回被点按钮的 value；Esc / 取消返回 null
   ========================================================================== */
(function () {
  window.UiDialog = {
    open(o) {
      o = o || {};
      /* 开口前先清掉上一次的残留：直接调 dlg.close() 不会 remove 节点，
         留着就会撞 id（下一次 getElementById 拿到的是上一个的空壳，看着像「弹窗没换内容」）。 */
      document.querySelectorAll('dialog.ui-dlg').forEach(d => { try { d.close(); } catch (e) {} d.remove(); });
      return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.id = o.id || 'uiDlg';
        dlg.className = 'ui-dlg';
        const head = document.createElement('div');
        head.className = 'pr-head';
        const b = document.createElement('b'); b.textContent = o.title || '';
        head.appendChild(b);
        if (o.sub) { const s = document.createElement('div'); s.className = 'sub'; s.textContent = o.sub; head.appendChild(s); }
        const body = document.createElement('div'); body.className = 'pr-body';
        const foot = document.createElement('div'); foot.className = 'pr-foot';
        dlg.appendChild(head); dlg.appendChild(body); dlg.appendChild(foot);
        const opener = document.activeElement;
        document.body.appendChild(dlg);
        /* 关掉之后把焦点还给叫它出来的那颗按钮（与 Confirm.shut 同一条规矩）：
           不然按 Esc 收起弹窗后焦点落在 body 上，键盘用户得从页面头重新 Tab 一遍。 */
        const close = v => {
          try { dlg.close(); } catch {} dlg.remove();
          if (opener && opener.isConnected && typeof opener.focus === 'function') { try { opener.focus(); } catch {} }
          resolve(v);
        };
        if (typeof o.body === 'function') o.body(body, close); else if (o.html) body.innerHTML = o.html;
        const acts = o.actions || [{ label: '取消', value: null }];
        if (o.dangerFirst) acts.forEach(a => { if (a.danger) foot.appendChild(aBtn(a, close)); });
        acts.forEach(a => { if (!o.dangerFirst || !a.danger) foot.appendChild(aBtn(a, close)); });
        dlg.addEventListener('cancel', e => { e.preventDefault(); close(null); });
        dlg.showModal();
        if (typeof o.onOpen === 'function') o.onOpen(body, close);
        /* 首焦点避开 danger 那颗：一排按钮里第一颗是「删掉」时，顺手按 Enter 就直接执行了。 */
        const first = foot.querySelector('button:not(.danger)') || foot.querySelector('button');
        if (first) first.focus();
      });
    },
  };
  function aBtn(a, close) {
    const b = document.createElement('button');
    b.className = (a.cls || (a.primary ? 'pri' : 'ghost')) + (a.danger ? ' danger' : '');
    b.textContent = a.label || '';
    b.onclick = async () => {
      if (typeof a.onClick === 'function') {
        /* onClick 可以是 async（先弹表单再决定关不关窗）：同步版直接判返回值，
           返回 Promise 就 await —— 以前不 await，`Promise() === false` 永远不成立，
           async onClick 想「不关窗就地刷新」根本拦不住关闭。 */
        const r = a.onClick();
        if (r === false || (r && typeof r.then === 'function' && await r === false)) return;
      }
      close(a.value === undefined ? null : a.value);
    };
    return b;
  }
})();

/* ============================================================================
   PromptForm —— 通用表单弹窗（剧本分镜 / 重命名短片 / 新建素材 共用）
   const v = await PromptForm.open({
     title, sub, okLabel,
     fields: [{ key, label, type:'textarea'|'text'|'number'|'select'|'pic', value, placeholder, hint,
                options:[{v,t}], hidden:true, required:true }],
     // required：这一栏留空就拦住「确定」并在下方说一句。不拦的话关窗本身就是回执，
     //   用户以为存好了、实际拿到一个空标题。单行输入框按 Enter 等于点「确定」（textarea 不管 Enter，它是换行）。
     // 要在弹窗里做「选了这一项，别几项跟着改口」才传 onChange —— 公共层不认识具体语义，
     // 它只交出三个口子：读现在的值、改某一行的文字（标签 / 占位 / 说明）、藏一整行。
     // api 见下面的 parts 那一段；重画整张表单是不给的（那会把用户刚打的字清掉）。
     onChange(key, api) {},
   });   // 取消返回 null；带 hidden 的那一行不会出现在返回值里
   ========================================================================== */
(function () {
  window.PromptForm = {
    open(o) {
      return new Promise(resolve => {
        /* 同一时刻只留一张：不清理的话连点两次「拆分镜」会叠出两张 #pfDlg，
           界面里能同时看到两层，getElementById 只拿得到第一张。 */
        document.querySelectorAll('dialog#pfDlg').forEach(d => { try { d.close(); } catch (e) {} d.remove(); });
        const dlg = document.createElement('dialog');
        dlg.id = 'pfDlg';
        /* 开窗前记下触发它的那个节点：关掉之后还给它的焦点（见下面 done）。
           必须在这里记 —— 关窗那一刻 activeElement 已经是弹窗里的按钮了。 */
        const pfOpener = document.activeElement;
        /* 图片那一栏的缩略图（`type:'pic'`）：有值就画图，没值画一句「还没有图」。 */
        const pfPicHTML = v => (v
          ? '<img src="' + esc(window.Api && Api.mediaSrc ? Api.mediaSrc(v) : v) + '" alt="">'
          : '<span class="none">还没有图</span>');
        const fields = o.fields || [];
        /* 图片那一栏（type:'pic'）的动作由调用方给（见下面 data-picpick 的接线）：
           公共层不认识资产库 / 我的收藏 / 本地上传，也不该认识。 */
        const picOf = {};
        dlg.innerHTML = `<div class="pf-head"><b>${esc(o.title || '输入')}</b>${o.sub ? `<div class="sub">${esc(o.sub)}</div>` : ''}</div>
          <div class="pf-body">${fields.map((f, i) => {
            const id = 'pf_' + i;
            let ctl;
            if (f.type === 'textarea') ctl = `<textarea id="${id}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`;
            else if (f.type === 'select') ctl = `<select id="${id}">${(f.options || []).map(x => `<option value="${esc(x.v)}"${String(x.v) === String(f.value) ? ' selected' : ''}>${esc(x.t)}</option>`).join('')}</select>`;
            else if (f.type === 'pic') {
              /* 值存在一个 hidden input 里 —— `values()` 照旧读 `.value`，取数口子不必为它开特例。
                 缩略图与那颗按钮摆在一起，选完由 `api.set(key, {value})` 换图（见 set 里那一段）。 */
              picOf[id] = f;
              ctl = `<input type="hidden" id="${id}" value="${esc(f.value || '')}">`
                + `<div class="pf-pic"><span class="pf-pic-t" data-picbox="${id}">${pfPicHTML(f.value)}</span>`
                + `<button type="button" class="ghost mini" data-picpick="${id}">${esc(f.pickLabel || '挑一张')}</button></div>`;
            }
            else ctl = `<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value == null ? '' : String(f.value))}" placeholder="${esc(f.placeholder || '')}">`;
            return `<div class="pf-field"${f.hidden ? ' hidden' : ''} data-key="${esc(f.key)}"${f.required ? ' data-required="1"' : ''}><label>${esc(f.label || '')}</label>${ctl}${f.hint != null ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
          }).join('')}</div>
          <div class="pf-foot"><span class="hint" id="pfMsg"></span><span class="sp"></span>
            <button class="ghost" id="pfCancel">取消</button><button class="pri" id="pfOk">${esc(o.okLabel || '确定')}</button></div>`;
        document.body.appendChild(dlg);
        dlg.showModal();
        /* select 字段也过公共下拉组件（原生留在 DOM 里当数据源，读取仍走 .value） */
        if (window.Dropdowns) Dropdowns.build(dlg);
        /* 「某一项变了要让别的项跟着改口」的那三个口子（`onChange`）。
           为什么不给页面一份重画整张表单的能力：重画会把用户刚打进去的字清掉。
           所以这里只交出**改文字 / 改取值 / 藏一整行**三样，哪一类给哪几句话是页面自己的语义，
           公共层不认识「角色」与「场景」。`hint != null` 才画那一行 —— 页面想「先留空、等选了再填」
           就传 `hint: ''`，不然没有节点可填。 */
        const parts = {};
        dlg.querySelectorAll('.pf-field').forEach(el => {
          parts[el.dataset.key] = { row: el, ctl: el.querySelector('textarea,input,select'),
            lab: el.querySelector('label'), hint: el.querySelector('.hint') };
        });
        const api = {
          values() {
            const out = {};
            for (const k of Object.keys(parts)) {
              const c = parts[k].ctl;
              if (c) out[k] = String(c.value).trim();
            }
            return out;
          },
          set(key, patch) {
            const p = parts[key];
            if (!p || !patch) return;
            if ('label' in patch && p.lab) p.lab.textContent = patch.label;
            if ('placeholder' in patch && p.ctl) p.ctl.placeholder = patch.placeholder || '';
            if ('hint' in patch && p.hint) p.hint.textContent = patch.hint;
            if ('value' in patch && p.ctl) {
              p.ctl.value = patch.value == null ? '' : String(patch.value);
              /* 程序化改完 select 必须通知公共下拉：浮层那份列表是 build 那一刻的快照，
                 不 sync 就是按钮上写着 A、真实选中的是 B（与「填完 options 要 sync」同一条）。 */
              if (p.ctl.tagName === 'SELECT' && window.Dropdowns) Dropdowns.sync(p.ctl);
              /* 图片那一栏：值变了要把缩略图一起换掉（隐藏 input 自己不会画） */
              const box = dlg.querySelector('[data-picbox="' + p.ctl.id + '"]');
              if (box) box.innerHTML = pfPicHTML(p.ctl.value);
            }
            if ('hidden' in patch) p.row.hidden = !!patch.hidden;
          },
        };
        /* 图片那一栏那颗「挑一张」：动作完全由调用方给（公共层不认识资产库 / 收藏 / 本地上传）。
           没给 pick 的就把按钮藏掉 —— 摆一颗点了什么都不发生的按钮比不摆更糟。 */
        dlg.querySelectorAll('[data-picpick]').forEach(btn => {
          const f = picOf[btn.dataset.picpick];
          if (!f || typeof f.pick !== 'function') { btn.hidden = true; return; }
          btn.onclick = async () => {
            const msg = dlg.querySelector('#pfMsg');
            try { await f.pick(api); } catch (e) { if (msg) msg.textContent = '选图失败：' + errText(e); }
          };
        });
        if (typeof o.onChange === 'function') {
          for (const k of Object.keys(parts)) {
            const c = parts[k].ctl;
            if (c) c.addEventListener('change', () => o.onChange(k, api));
          }
          /* 表单刚打开时也走一次：调用方要按**默认值**决定哪几行先露出来
             （例：新建素材时默认类型是角色，「出声」那一行要露；换到道具就收）。
             没有这一下，页面只能把所有行的初值都写死在 fields 里 ——
             而初值里那些「这一行该不该露」是互相依赖的（露/收要看别的行现在是什么值），
             写死就会出现「默认是道具却摆着出图勾选框」这种界面与行为不一致。 */
          try { o.onChange(String(Object.keys(parts)[0] || ''), api); } catch (e) {}
        }
        const done = out => {
          try { dlg.close(); } catch {} dlg.remove();
          if (pfOpener && pfOpener.isConnected && typeof pfOpener.focus === 'function') { try { pfOpener.focus(); } catch {} }
          resolve(out);
        };
        dlg.querySelector('#pfCancel').onclick = () => done(null);
        dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
        /* 必填行留空不许「静默关闭」：关窗本身就是回执，用户以为存了，实际拿到的是一个空标题。
           藏起来的行不算必填（与下面取值同一条判据）：这一栏此刻不该存在，就不该拦着确定。 */
        dlg.querySelector('#pfOk').onclick = () => {
          const out = {};
          const miss = [];
          dlg.querySelectorAll('.pf-field').forEach(el => {
            /* 藏起来的行不算「填了」：这一类没有这一栏时，交回页面的就该是没有这一栏。
               留着它会把上一次切换时那个 select 的取值一起递出去（页面据此写字段就写错了）。 */
            if (el.hidden) return;
            const k = el.dataset.key, ctl = el.querySelector('textarea,input,select');
            out[k] = ctl.value.trim();
            if (el.dataset.required && !out[k]) {
              const lab = el.querySelector('label');
              miss.push((lab && lab.textContent) || k);
            }
          });
          if (miss.length) { dlg.querySelector('#pfMsg').textContent = '先把「' + miss.join('」「') + '」填上'; return; }
          if (o.validate) {
            const err = o.validate(out);
            if (err) { dlg.querySelector('#pfMsg').textContent = err; return; }
          }
          done(out);
        };
        /* 单行输入框按 Enter = 点确定：这一类弹窗就一栏「标题」，不提交的话用户打完字只能去摸鼠标。
           textarea 不接管（Enter 是换行），隐藏的值（pic 那一栏）与勾选类也不算输入焦点。
           `isComposing` 必须判：中文输入法里 Enter 是「把候选字落进输入框」，不是「提交」。 */
        dlg.addEventListener('keydown', e => {
          if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
          const t = e.target;
          if (!t || t.tagName !== 'INPUT') return;
          const ty = String(t.type || 'text').toLowerCase();
          if (ty === 'hidden' || ty === 'checkbox' || ty === 'radio' || ty === 'file' || ty === 'button') return;
          e.preventDefault();
          dlg.querySelector('#pfOk').click();
        });
        const first = dlg.querySelector('textarea,input,select');
        if (first) setTimeout(() => first.focus(), 60);
      });
    },
  };
})();

/* ============================================================================
   DatePicker —— 自定义日期选择弹层（替换浏览器原生日历，与全站样式统一）
   用法：DatePicker.open(holderEl, inputEl, { onPick })   holder 需 position:relative
   ========================================================================== */
(function () {
  let openPop = null;
  /* 日历格子的键就是上面那一份 dayKey（同一个文件里两份手拼「年-月-日」，改补零时只会改到一半，
     表现是选了 2026-1-5 而输入框写着 2026-01-05）。dayKey 挂在 window 上，本 IIFE 排在它后面。 */
  const iso = window.dayKey;
  const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

  function close() {
    if (!openPop) return;
    openPop.pop.remove();
    openPop = null;
  }
  document.addEventListener('click', e => {
    if (openPop && !e.target.closest('.dp-pop') && !e.target.closest('.datepick')) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  function paint() {
    const { pop, input, opts, view } = openPop;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cur = input.value ? new Date(input.value + 'T00:00:00') : null;
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const startIdx = (first.getDay() + 6) % 7;            // 周一为第一列
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const prevDays = new Date(view.getFullYear(), view.getMonth(), 0).getDate();
    const cells = [];
    for (let i = startIdx - 1; i >= 0; i--) cells.push({ d: new Date(view.getFullYear(), view.getMonth() - 1, prevDays - i), out: true });
    for (let i = 1; i <= daysInMonth; i++) cells.push({ d: new Date(view.getFullYear(), view.getMonth(), i), out: false });
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const last = cells[cells.length - 1].d;
      cells.push({ d: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), out: true });
      if (cells.length >= 42) break;
    }
    pop.innerHTML = `<div class="dp-head">
        <button class="dp-nav" data-nav="-1" title="上个月">‹</button>
        <b>${view.getFullYear()} 年 ${view.getMonth() + 1} 月</b>
        <button class="dp-nav" data-nav="1" title="下个月">›</button>
      </div>
      <div class="dp-week">${WEEK.map(w => `<span>${w}</span>`).join('')}</div>
      <div class="dp-grid">${cells.map(c => {
        const t = c.d.getTime();
        const cls = ['dp-day'];
        if (c.out) cls.push('out');
        if (t === today.getTime()) cls.push('today');
        if (cur && iso(c.d) === iso(cur)) cls.push('sel');
        return `<button class="${cls.join(' ')}" data-d="${iso(c.d)}">${c.d.getDate()}</button>`;
      }).join('')}</div>
      <div class="dp-foot">
        <button class="ghost mini" data-act="today">今天</button>
        <button class="ghost mini" data-act="clear">清除</button>
        <span style="flex:1"></span>
        <button class="ghost mini" data-act="close">关闭</button>
      </div>`;
    pop.querySelectorAll('[data-nav]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      view.setMonth(view.getMonth() + Number(b.dataset.nav));
      paint();
    });
    pop.querySelectorAll('[data-d]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      input.value = b.dataset.d;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick(b.dataset.d);
      close();
    });
    pop.querySelector('[data-act="today"]').onclick = e => {
      e.stopPropagation();
      input.value = iso(new Date());
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick(input.value);
      close();
    };
    pop.querySelector('[data-act="clear"]').onclick = e => {
      e.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (opts && opts.onPick) opts.onPick('');
      close();
    };
    pop.querySelector('[data-act="close"]').onclick = e => { e.stopPropagation(); close(); };
  }

  window.DatePicker = {
    open(holder, input, opts) {
      if (openPop && openPop.input === input) { close(); return; }
      close();
      const pop = document.createElement('div');
      pop.className = 'dp-pop';
      holder.appendChild(pop);
      const base = input.value ? new Date(input.value + 'T00:00:00') : new Date();
      openPop = { pop, input, opts: opts || {}, view: new Date(base.getFullYear(), base.getMonth(), 1) };
      paint();
    },
    close,
  };
})();
