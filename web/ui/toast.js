/* Toast — 全站统一的轻提示。
   从 web/ui/ui.js 拆出；加载顺序在 ui.js 之后、页面脚本之前。 */
(function () {
let box = null, last = { t: '', ts: 0 };
  function host() {
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.className = 'toast-box';
    document.body.appendChild(box);
    return box;
  }
  const ICON = { ok: '✓', err: '!', warn: '!', info: 'i' };
  /* 「右上角弹窗」的两档安静：
       · err / warn  → 一定弹。出错与警告是**必须看见**的（弹窗是它们唯一的出口）；
       · ok / info   → 默认**不弹**（`sk_quiet_ok` = '1' 时才弹）。
     为什么默认安静：这一类全是「已经做完了」或「这里没有东西可做」——
     做完的那件事在界面上本来就看得见（卡片换了、列表多了一行、按钮变成已选），
     而「没有东西可做」更是用户自己刚点的按钮造成的，不提示比提示更好。
     右上一排堆着七八条绿色对勾时，最该被看见的那条错误就淹在里面了 ——
     安静下来之后，右上角弹出来的**就是**真问题。
     判据只有这一处（`Toast.show` 的开头），页面不要自己各处判断。
     开关在「设置 → 界面」里（「操作成功也给一声提示」），默认关。 */
  const K_QUIET_OK = 'sk_quiet_ok';   // 键名是历史包袱：它现在存的是「要不要也弹一声」，不是「安静」
  const sayOk = () => { try { return localStorage.getItem(K_QUIET_OK) === '1'; } catch (e) { return false; } };
  const K_AFTER = '__toast_after_reload';   // 「这一次刷新之后要说的那一句」（sessionStorage，见 Toast.after）
  window.Toast = {
    show(text, type, ms, force) {
      const msg = String(text == null ? '' : text).trim();
      if (!msg) return;
      const kind = ICON[type] ? type : 'info';
      /* 安静档只压 ok / info；调用方给的 ms 一律照旧（有人靠 ms=0 做「一直挂着」的那种）。
         `force` 是回执档那一层传下来的：数据真的变了（删了 / 存了 / 导了 / 撤了）就不能被
         安静档吞掉，这一条判据仍然只在这一个地方。
         这一行原来写的是 `if (quietOk() && ...)` —— 判据正好反了：勾上「操作成功也给一声提示」
         的人被静音，什么都没设（默认）的人反而每一条成功都弹。用户报的「切换会话 / 新建会话
         老在右上角弹窗」就是这一条：右上角那一排本来默认该是空的。 */
      if (!force && !sayOk() && (kind === 'ok' || kind === 'info') && ms !== 0) return;
      const now = Date.now();
      if (msg === last.t && now - last.ts < 1500) return;    // 去重：同一句话不连弹
      last = { t: msg, ts: now };
      const el = document.createElement('div');
      el.className = 'toast ' + kind;
      el.innerHTML = `<span class="ic"></span><span class="tx"></span>`;
      el.querySelector('.ic').textContent = ICON[kind];
      el.querySelector('.tx').textContent = msg;
      const h = host();
      h.appendChild(el);
      while (h.children.length > 4) h.firstElementChild.remove();
      const life = ms || (kind === 'err' ? 6000 : 3200);
      const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
      el.onclick = kill;
      setTimeout(kill, life);
    },
    ok(t, ms) { this.show(t, 'ok', ms); },
    err(t, ms) { this.show(typeof t === 'object' ? Net.errorText(t) : t, 'err', ms); },
    warn(t, ms) { this.show(t, 'warn', ms); },
    info(t, ms) { this.show(t, 'info', ms); },
    /* 回执档：用户刚做完一件**改动了数据**的事（提交生成 / 撤销 / 删除 / 导入 / 另存 / 改名 / 建好），
       这一句必须让他看见 —— 安静档把那四类一起吞掉之后，按钮看起来就是「点了没反应」。
       页面不要再各自拿 `ms=0` 去绕静音判据：绕法只有这一处。
       `Toast.ok` 留给「没改数据、只是复述当前状态」的那一类（星标点亮、试听挂上），
       那些仍然归安静档管。 */
    receipt(t, kind, ms) { this.show(t, ICON[kind] ? kind : 'ok', ms === undefined ? 0 : ms, true); },
    /* 进度档：一条会自己改字的提示，给「逐条跑」的那种批量活（批量下载 / 批量补存）。
       以前这类活要么一个字不显示（跑三十条静默转圈），要么页面各自拿 innerHTML 拼一份进度条。
       进度只有这一个出口：`set(换一句话)` 与 `done(收摊并留下最后一句)`。
       它绕开安静档 —— 「正在跑第 12/30 条」是**正在发生**的事，不是「做完了」的绿对勾。 */
    progress(t) {
      const st = { el: null, timer: 0 };
      const put = x => {
        const msg = String(x == null ? '' : x).trim();
        if (!msg) return;
        if (!st.el || !st.el.isConnected) {
          const el = document.createElement('div');
          el.className = 'toast info';
          el.innerHTML = `<span class="ic"></span><span class="tx"></span>`;
          el.querySelector('.ic').textContent = '…';
          st.el = el;
          const h = host();
          h.appendChild(el);
          while (h.children.length > 4) h.firstElementChild.remove();
          el.onclick = () => { clearTimeout(st.timer); st.el = null; el.remove(); };
        }
        st.el.querySelector('.tx').textContent = msg;
      };
      put(t);
      return {
        set: put,
        done(last, ms) {
          if (last != null && String(last).trim()) {
            put(last);
            if (st.el) { st.el.className = 'toast ok'; st.el.querySelector('.ic').textContent = ICON.ok; }
          }
          const el = st.el; st.el = null;
          if (!el) return;
          clearTimeout(st.timer);
          st.timer = setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, ms || 3200);
        },
      };
    },
    /* 「这一次刷新**之后**才说的那一句」—— 页面自己发起的 reload 会把右上角挂着的一切
       连同卡内那行读数一起销毁，所以「刚做完什么」必须交给下一份文档去说。
       为什么非要有这一件（2026-10-15 普查查出来的那一类）：设置页里 6 处、`DataSync.boot` 里 1 处
       写的是 `Toast.ok('…正在刷新…')`，而 800~900 毫秒之后真的 `location.reload()` ——
       那句话有两重没落地：① ok 档默认被 `sk_quiet_ok` 静音，多数用户当场一个字都看不见；
       ② 就算设成了「操作成功也给一声提示」，它也只活 0.8 秒就被它自己宣布的那次刷新杀掉。
       于是「导入设置 / 恢复默认 / 从数据文件恢复 / 用云端覆盖本机 / 还原备份」这些**改掉了真数据**
       的动作，刷新完之后界面上没有任何一处说明过刚才发生了什么（页面看起来只是自己重开了一次）。
       口径：只留最后一句（一次刷新只会有一次说明）、默认走一定弹的那一档、取用即清（不重复弹）。
       键放 sessionStorage 不放 localStorage：它是「这一趟浏览」的留言，换标签页/重开浏览器就不该再提，
       而且 localStorage 会被镜像进 `.data/` 与云同步 —— 那两处都不该出现一条界面留言。 */
    after(t, kind) {
      const msg = String(t == null ? '' : t).trim();
      if (!msg) return;
      try { sessionStorage.setItem(K_AFTER, JSON.stringify({ t: msg, k: ICON[kind] ? kind : 'warn' })); } catch (e) {}
    },
  };
  const flushAfter = () => {
    let raw = null;
    try { raw = sessionStorage.getItem(K_AFTER); if (raw) sessionStorage.removeItem(K_AFTER); } catch (e) { return; }
    if (!raw) return;
    let o = null;
    try { o = JSON.parse(raw); } catch (e) { return; }        // 写坏的那一份直接丢掉，别让它卡住下一次加载
    if (o && typeof o.t === 'string' && o.t) window.Toast.show(o.t, o.k, 6000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', flushAfter);
  else flushAfter();
})();
