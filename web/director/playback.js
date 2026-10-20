/* 剪辑态播放层：两个 <video> 甲板接力 + 配音按成片绝对时间起播。
   与轨道渲染 / 切片解码分开：这里只依赖媒体地址解析与 DOM 媒体事件。
   播放不渲染 —— 成片第 T 秒落在计划里的哪一段，就把甲板指到那一段的入点。 */
import { round1 } from './util.js';

export function createPlayback({ mediaSrc }) {
  /* 甲板就位：src 换了才重新 load，已经在这条素材上就直接返回（拖动重画时最常走这条路） */
  function deckReady(v, src) {
    return new Promise(res => {
      if (v.getAttribute('src') === src && v.readyState >= 1) return res(true);
      let done = false;
      const fin = ok => {
        if (done) return; done = true; clearTimeout(to);
        v.removeEventListener('loadedmetadata', onOk); v.removeEventListener('error', onErr);
        res(ok);
      };
      const onOk = () => fin(true), onErr = () => fin(false);
      const to = setTimeout(() => fin(false), 15000);
      v.addEventListener('loadedmetadata', onOk);
      v.addEventListener('error', onErr);
      if (v.getAttribute('src') !== src) v.src = src;
      v.load();
    });
  }
  function deckSeek(v, t) {
    return new Promise(res => {
      const at = Math.max(0, Number(t) || 0);
      /* 已经停在目标位置：不会再触发 seeked，等下去要白白卡 8 秒（整列每 3 秒重画一次，
         每次都回到 0 秒的话这里就是每次都卡一下）。 */
      if (v.readyState >= 2 && Math.abs(v.currentTime - at) < 0.01) return res();
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(to); v.removeEventListener('seeked', fin); res(); };
      const to = setTimeout(fin, 8000);
      v.addEventListener('seeked', fin);
      try { v.currentTime = at; } catch (e) { fin(); }
    });
  }
  /* 为什么不让各处各写 `play().catch()`：`HTMLMediaElement.play()` 返回 Promise 是规范，
     但**旧浏览器与一部分内嵌 WebView 会返回 undefined** —— 那时 `.catch` 直接抛
     `Cannot read properties of undefined (reading 'catch')`，于是「点试听」当场炸，
     而且报错信息与用户做的事毫无关系（jsdom 探针正是这么抓到的）。
     这一份收成一处：**返回 Promise**，所以外面还能继续 `.then/.catch`。 */
  function playSafe(el, onFail) {
    if (!el) return Promise.resolve();
    try {
      const r = el.play();
      if (r && typeof r.catch === 'function') return r.catch(() => { if (onFail) onFail(); });
    } catch (e) { if (onFail) onFail(); }
    return Promise.resolve();
  }
  /* 预览里的音量：0–100% 用元素自己的 volume，**超过 100% 只能借 WebAudio 的增益节点**。
     `HTMLMediaElement.volume` 的上限就是 1，而右栏那张卡上那枚滑块声明的是 0–200%（`#tlVol`），
     代理合成那侧 `volume=` 收的也是真值 —— 以前预览里一句 `Math.min(1, …)` 把上半程悄悄削平：
     拖到 200% 听着和 100% 一模一样，导出的成片却真的响了一倍，
     「界面拖了、预览听不出、成片却变了」正是这一类要拦的。
     一条元素只能建一次 MediaElementSource，建过的把增益挂在元素上（重复建浏览器直接抛错）。
     浏览器不给 AudioContext（或压根没这个接口）时退回按 1 夹 —— 那时增量确实只在成片里生效，
     但至少不会「为了放大音量把原来能听的声音整条掐掉」。 */
  const PreviewVol = {
    ctx: null,
    ctxOf() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
      return this.ctx;
    },
    set(el, v) {
      if (!el) return;
      const want = Math.max(0, Number(v == null ? 1 : v));
      if (want <= 1 && !el.__pv) { try { el.volume = want; } catch (e) {} return; }
      const ac = this.ctxOf();
      if (!ac) { try { el.volume = Math.min(1, want); } catch (e) {} return; }
      if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
      try {
        if (!el.__pv) {
          const s = ac.createMediaElementSource(el);
          const g = ac.createGain();
          s.connect(g); g.connect(ac.destination);
          el.__pv = g; el.__pvsrc = s;
        }
        el.__pv.gain.value = want;
        el.volume = 1;
      } catch (e) { try { el.volume = Math.min(1, want); } catch (e2) {} }
    },
    /* 用完就拆：`startVoices` 每次定位都新建一批 Audio，接进图里的节点不会跟着元素一起被回收，
       不拆就是每 seek 一次留一对孤儿节点在 AudioContext 上。 */
    release(el) {
      if (!el) return;
      try { el.__pv && el.__pv.disconnect(); } catch (e) {}
      try { el.__pvsrc && el.__pvsrc.disconnect(); } catch (e) {}
      el.__pv = null; el.__pvsrc = null;
    },
  };
  const TlPlay = {
    A: null, B: null, front: null, back: null,
    plan: [], voices: [], total: 0, t: 0, playing: false, idx: -1,
    warmIdx: -1, muted: false, raf: 0, onTime: null, audio: [],
    /* 黑场（画面被删掉的那一格 / 一段纯黑）没有可播的素材，靠墙钟把成片时间推过去：
       `blackEnd` = 这一串连续黑场走完的那一秒，`blackFrom`/`blackT0` = 进入时的成片秒与墙钟。 */
    blackEnd: 0, blackFrom: 0, blackT0: 0, blackLast: -1,
    /* 每一次 play / seek / pause 都换一个「代号」。await（等甲板 loadedmetadata + seeked）
       醒来先核对代号 —— 不是自己的就直接收手，绝不再碰播放状态。
       为什么必须有这道闸：seek 是异步的，而「正在播」这个状态以前要等它 await 完才置起来，
       于是「点播放 → 甲板还在加载 → 再点一下」那一下读到的 playing 仍是 false，走的还是
       play()，等第一个 seek 醒来又把 front.play() 了 —— 用户看到的就是「点了暂停停不下来」。 */
    gen: 0,
    /* 装上两个甲板：A 是可见的那一个（`midEditTrim` 那一份播放器标记里就有它们） */
    mount(a, b, opt) {
      /* 还是同一对节点（整列重画时把播放区整块保下来了）：**别重排前后**。
         正在播的那一个可能是 B，重排就会把它翻到后面去、把停在别处的 A 翻上来 ——
         画面当场静止，而声音还在放（那一句 Audio 没被这一下碰到），看着像坏了。 */
      if (this.A === a && this.B === b) {
        this.muted = !!opt && !!opt.muted;
        return;
      }
      this.A = a; this.B = b;
      this.front = a; this.back = b;
      if (a) a.classList.remove('back');
      if (b) b.classList.add('back');
      this.muted = !!opt && !!opt.muted;
      this.idx = -1; this.warmIdx = -1;
    },
    /* 计划：一段 = { src, in, out, vol, spd }，配音 = { src, at, dur, vol, spd }（at 是成片绝对秒）。
       `starts` 是每段在成片里的起点，算一次存着，别每帧都从头累加。
       ⚠ `opt.film` 决定**倍速作不作数**：全片那一档播的是成片，2 倍速的那一段真的只占一半墙钟；
       本镜那一档播的是「这一条候选剪出来长什么样」，刻度尺是候选源秒，倍速不该把它缩短 ——
       所以 `rate = film ? spd : 1` 只在这一处判一次，下面所有换算都读 `c.rate`，不再各问一遍。 */
    /* 计划的指纹：整列每 3 秒重画一次（轮询），用它区分「只是重画」与「真的剪了一刀」。
       前者不该去 seek（会把正在播的这一句掐断重头再放），后者才该从头定位。 */
    setPlan(clips, voices, opt) {
      const film = !!(opt && opt.film);
      this.film = film;
      const starts = [];
      let acc = 0;
      this.plan = (clips || []).map(c => {
        const spd = Math.max(0.25, Math.min(4, Number(c.spd) || 1));
        const rate = film ? spd : 1;
        /* `dur` = 这一格在**成片 / 墙钟**上占多久（甲板按 rate 播，源秒 / rate = 墙钟秒） */
        const dur = Math.max(0.05, ((Number(c.out) || 0) - (Number(c.in) || 0)) / rate);
        starts.push(acc); acc += dur;
        /* fs / fa = 这一格在**框基时间轴**上的起点与框左沿（全片轨那一排就摆在这根轴上）。
           本镜档不传它们：这一档 `rate` 恒为 1（`srcT()` 直接就是源秒，不需要那根框基轴）。
           ⚠ 这与「本镜那一排的**格子**按轴秒摊」（`shotFrames`）是两件事 —— 轨道缩的是「这一格在
           成片里占多久」，甲板跟着缩就得重排时间线、还会让两种听法互相冒充，所以播放这一头刻意不动。 */
        return { src: c.src || '', in: Math.max(0, Number(c.in) || 0), out: Math.max(0, Number(c.out) || 0),
          dur: dur, spd: spd, rate: rate, fs: Number(c.fs) || 0, fa: Number(c.fa) || 0,
          vol: c.vol == null || !isFinite(Number(c.vol)) ? 1 : Math.max(0, Math.min(2, Number(c.vol))) };
      });
      this.starts = starts;
      this.total = acc;
      this.voices = (voices || []).slice();
      /* 画面段的音量**不进 fp**：甲板是现成的 `<video>`，`applyVol()` 当场就能改，
         不需要重排播放（把它写进 fp 会让「拖一下音量」变成一次 seek = 正在听的那一句被掐断）。
         配音那一边必须进 fp，因为 `Audio` 只在 seek 之后才新建（见 startVoices），
         不改 fp 就永远拿到旧的那一只 —— 两种控件的差别在重建时机，不在音量本身。
         倍速与音量同理要进 fp：它是甲板 `playbackRate` 与配音时机的来源，
         改了却不 seek 就等于「界面上写了 2 倍速，播起来还是原速」。 */
      this.fp = this.plan.map(c => c.src + ':' + c.in + '-' + c.out + '@' + c.spd).join('|')
        + '#' + this.voices.map(v => v.src + '@' + v.at + '+' + v.dur + 'x' + v.vol + 'o' + (v.off || 0) + 's' + (v.spd || 1)).join('|');
      if (this.t > this.total) this.t = 0;
      this.applyVol();
    },
    /* 把每一段自己的音量按到两个甲板上（正在播的那一段 + 预热的那一段）。
       0–100% 走元素自己的 volume，100–200% 走 `PreviewVol` 的增益节点 ——
       与配音那一句同一个入口，两边对同一枚滑块的反应必须一样。 */
    applyVol() {
      const set = (el, i) => {
        if (!el) return;
        const c = this.plan[i];
        PreviewVol.set(el, c ? c.vol : 1);
      };
      set(this.front, this.idx);
      set(this.back, this.warmIdx);
    },
    clipAt(t) {
      for (let i = 0; i < this.plan.length; i++) {
        const s = this.starts[i];
        if (t < s + this.plan[i].dur - 0.001) return i;
      }
      return this.plan.length ? this.plan.length - 1 : -1;
    },
    stopVoices() {
      this.audio.forEach(a => { try { clearTimeout(a._h); clearTimeout(a._s); a.pause(); } catch (e) {} PreviewVol.release(a); });
      this.audio = [];
    },
    startVoices(from) {
      this.stopVoices();
      this.voices.forEach(v => {
        if (!v.src) return;
        const end = (Number(v.at) || 0) + Math.max(0.1, Number(v.dur) || 0);
        if (end <= from + 0.02) return;                       // 这一句已经过去了
        const el = new Audio();
        el.src = mediaSrc(v.src);
        PreviewVol.set(el, v.vol == null ? 1 : v.vol);
        /* 一句配音跟着**它所在那一格**倍速 + **自己那一档**：合成侧代理对它做 `atempo=两者相乘`，
           预览这边用 `playbackRate` 同一件事（浏览器没有 atempo，倍速时音调会跟着变 —— 只差音色不差时机）。
           系数由 `tlPlayPlan` 两路各自算好后递进来（全片那一档乘画面倍速，本镜这一档画面不缩所以只乘自己那一档），
           这里不再问 `this.film` —— 两处各判一次「这一档要不要乘」就会出现「屏幕上 1.5 倍、成片里原速」。 */
        const rate = Math.max(0.0625, Math.min(16, Number(v.spd) || 1));
        try { el.playbackRate = rate; } catch (e) {}
        /* 音频内的起点 = off + （播放头在句内已经走过的那一段）——
           切过开头的句子直接从 off 起播，而不是从头放（否则会放出已经被切掉的那一截）。
           `skip` 是**成片秒**，而 `currentTime` 是**文件秒**，中间差一个倍速 —— 忘了乘就是
           「2 倍速的那一句在预览里只走了一半就被切过去」。 */
        const skip = from > (Number(v.at) || 0) ? Math.min(end - from - 0.05, from - (Number(v.at) || 0)) : 0;
        const offset = (Number(v.off) || 0) + Math.max(0, skip) * rate;
        const delay = Math.max(0, (Number(v.at) || 0) - from);
        el._h = setTimeout(() => {
          try { el.currentTime = offset; playSafe(el); } catch (e) {}
        }, Math.max(0, delay * 1000));
        /* 这一条**放到哪一秒为止**：压在灰场上的那一句会被劈成几条，每条都必须在自己的
           终点停住 —— 少了这一句，第一条会一路响着穿过灰场（画面是黑的、块上画着灰带，
           而声音还在走：跑的与画的是两回事）。`from` 是起播时的播放头位置，
           所以「已经在句内」的那一截也按剩余时长算。 */
        el._s = setTimeout(() => { try { el.pause(); } catch (e) {} }, Math.max(0, (end - from) * 1000));
        this.audio.push(el);
      });
    },
    /* 黑场：把两个甲板压成纯黑（画面此刻本来就没有内容），并把成片时间按墙钟走过去。
       `filter: brightness(0)` 而不是把节点藏起来 —— 藏掉就把 16:9 的盒子一起收了，
       画面会当场塌一下再弹回来。 */
    dark(on) {
      [this.A, this.B].forEach(v => { if (v) v.classList.toggle('blackout', !!on); });
    },
    /* 从当前这一段起，连续的黑场一共占到哪一秒（一次剪两刀会出现两格相邻的黑场）。
       整串一次走完：中途不必接甲板，也就不会在每一格边界上各卡一下。 */
    blackRun() {
      let last = this.idx;
      while (last + 1 < this.plan.length && !this.plan[last + 1].src) last++;
      return last;
    },
    enterBlack() {
      this.blackLast = this.blackRun();
      this.blackEnd = this.starts[this.blackLast] + this.plan[this.blackLast].dur;
      this.blackFrom = this.t;
      this.blackT0 = performance.now();
      this.dark(true);
      try { if (this.front) this.front.pause(); } catch (e) {}
      try { if (this.back) this.back.pause(); } catch (e) {}
    },
    async loadInto(v, i, at) {
      const c = this.plan[i];
      if (!c || !c.src) return false;
      const ok = await deckReady(v, c.src);
      if (!ok) return false;
      v.muted = this.muted;
      /* 音量跟着段走（seek / advance 两条路都经这里），所以「接段」时不会把上一段的音量留着 */
      try { v.volume = Math.min(1, c.vol); } catch (e) {}
      /* 倍速也跟着段走，而且**两个落点都要**（甲板是复用的：A/B 轮流当前面那一个）——
         只在新建时设过一次的话，一段 2 倍速播完接下一段 1 倍速，那块甲板还停在 2 倍速上。 */
      try { v.playbackRate = c.rate; } catch (e) {}
      await deckSeek(v, at);
      return true;
    },
    /* 预热下一段：把后面那个甲板定到它的入点上（不播），接段时它已经在正确位置 */
    async warm(i) {
      if (i < 0 || i >= this.plan.length) return;
      if (this.warmIdx === i && this.back.getAttribute('src') === this.plan[i].src) return;
      this.warmIdx = i;
      const c = this.plan[i];
      if (!c.src) return;
      const ok = await deckReady(this.back, c.src);
      if (!ok || this.warmIdx !== i) return;                  // 期间又跳走了：别把这一段定错位置
      try { this.back.volume = Math.min(1, c.vol); } catch (e) {}
      try { this.back.playbackRate = c.rate; } catch (e) {}
      try { await deckSeek(this.back, c.in); this.back.pause(); } catch (e) {}
    },
    emit() { if (this.onTime) this.onTime(this.t, this.total, this.playing); },
    /* 成片第 t 秒 → 它在**源素材**里的秒数（本镜那一档的插针按源秒走）。
       剪成三段之后「成片第 4 秒」可能落在第二段的源 1.2 秒上，拿 t 直接当源秒会把针放错地方。
       倍速再叠一层：成片走过 1 秒 = 源走过 `rate` 秒（2 倍速时源秒涨得比墙钟快）。 */
    srcT() {
      const c = this.plan[this.idx];
      if (!c) return this.t;
      return c.in + Math.max(0, this.t - this.starts[this.idx]) * c.rate;
    },
    /* 成片第 t 秒 → 它在**框基时间轴**上的秒数（全片那一档的插针按框基秒走）。
       这一根轴是「各段在源里分到的那一块」接起来的：段与段之间留着灰块（被剪掉的部分），
       所以播放头从一段进到下一段时会**跳过**那段灰 —— 针只走真正进成片的画面。
       算式与 filmVoiceHTML / filmPinT 同源（格起点 + 选区相对框左沿的偏移 + 段内偏移），
       而那一排的尺子已经被倍速缩过（`w = dur / spd`），所以偏移量要除回轴上。 */
    frameT() {
      const c = this.plan[this.idx];
      if (!c) return this.t;
      return round1(c.fs + (c.in - c.fa) / c.rate + Math.max(0, this.t - this.starts[this.idx]));
    },
    async seek(t, play) {
      const my = ++this.gen;
      this.stopVoices();
      this.t = Math.max(0, Math.min(this.total, Number(t) || 0));
      /* playing 先落定再 await：按钮图标与「这一手到底想干什么」在加载期间就已经是对的了 */
      this.playing = !!play;
      this.emit();
      const i = this.clipAt(this.t);
      if (i < 0) { this.pause(); return; }
      this.idx = i;
      /* 落在黑场上：不去接甲板（没有素材可接），按墙钟把这几秒走完。
         少了这一支 `loadInto` 会返回 false → 当场 pause，用户看到的就是
         「删掉一段画面之后，播放到这里就停了」。 */
      if (!this.plan[i].src) {
        this.enterBlack();
        if (play) { this.startVoices(this.t); this.warm(this.blackLast + 1); this.loop(); }
        this.emit();
        return;
      }
      this.dark(false);
      /* `idx` 与 `t` 上面都已经落定，所以甲板要定位的源秒就是 srcT() —— 不再另拼一遍算式（拼两遍就会有一遍忘乘倍速） */
      const ok = await this.loadInto(this.front, i, this.srcT());
      if (my !== this.gen) return;                       // 期间用户又点了播放/暂停：这一手作废
      if (!ok) { this.pause(); return; }
      if (play) {
        try { await playSafe(this.front); } catch (e) {}
        if (my !== this.gen) return;
        this.startVoices(this.t);
        this.warm(i + 1);
        this.loop();
      } else { try { this.front.pause(); } catch (e) {} }
      this.emit();
    },
    play() {
      if (!this.plan.length) return;
      if (this.t >= this.total - 0.05) this.t = 0;
      this.seek(this.t, true);
    },
    pause() {
      ++this.gen;                                        // 让在飞的那一双手失效
      this.playing = false;
      cancelAnimationFrame(this.raf); this.raf = 0;
      try { if (this.front) this.front.pause(); } catch (e) {}
      this.stopVoices();
      this.emit();
    },
    setMuted(on) {
      this.muted = !!on;
      [this.A, this.B].forEach(v => { try { v.muted = this.muted; } catch (e) {} });
    },
    /* 这一段放完 → 甲板接力。后面那个已经预热过，这里只是把它翻到前面并开播。 */
    async advance() {
      const my = ++this.gen;
      const next = this.idx + 1;
      if (next >= this.plan.length) {
        this.t = this.total;
        this.playing = false; cancelAnimationFrame(this.raf); this.raf = 0;
        this.stopVoices(); this.emit();
        return;
      }
      const f = this.back, b = this.front;
      this.front = f; this.back = b;
      if (f) f.classList.remove('back');
      if (b) b.classList.add('back');
      try { b.pause(); } catch (e) {}
      this.idx = next;
      this.t = this.starts[next];
      /* 接下来是黑场：与 seek 里同一支处理（墙钟走完、声音照放），否则播到删除处就停住 */
      if (!this.plan[next].src) {
        this.enterBlack();
        this.startVoices(this.t);
        this.warm(this.blackLast + 1);
        this.loop();
        return;
      }
      this.dark(false);
      const ok = await this.loadInto(f, next, this.plan[next].in);
      if (my !== this.gen) return;                       // 期间用户按了暂停：别把下一段又开起来
      if (!ok) { this.pause(); return; }
      try { await playSafe(f); } catch (e) {}
      if (my !== this.gen) { try { f.pause(); } catch (e) {} return; }
      this.warm(next + 1);
      this.loop();
    },
    loop() {
      cancelAnimationFrame(this.raf);
      const step = () => {
        if (!this.playing) return;
        const c = this.plan[this.idx];
        if (!c) { this.pause(); return; }
        if (!c.src) {
          /* 黑场：甲板没有素材可播，成片时间按墙钟走。走完这一串（可能连着好几格）
             再把指针交回 advance —— 那里接的是黑场后面第一格真画面。 */
          this.t = Math.min(this.blackEnd, this.blackFrom + (performance.now() - this.blackT0) / 1000);
          if (this.t >= this.blackEnd - 0.005) { this.idx = this.blackLast; this.advance(); return; }
          this.emit();
          this.raf = requestAnimationFrame(step);
          return;
        }
        const ct = this.front.currentTime;
        /* 时间以甲板自己的 currentTime 为准：掉几帧也不会漂（按帧计时会越走越慢）。
           甲板按 `rate` 播，所以「源里走过的秒」要除回「成片里走过的秒」—— 2 倍速那一格
           源走 4 秒只占成片 2 秒，不除的话播放头一秒跳两秒，针与画面差一倍。 */
        this.t = this.starts[this.idx] + Math.max(0, ct - c.in) / c.rate;
        if (ct >= c.out - 0.04 || this.front.ended) { this.advance(); return; }
        /* 这一段过半就把下一段预热起来：等到最后一帧再加载就来不及，接缝会卡一下（比的是源秒，与 ct 同一把尺） */
        if (ct > c.in + (c.out - c.in) * 0.5) this.warm(this.idx + 1);
        this.emit();
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    },
    destroy() {
      this.pause();
      this.plan = []; this.voices = [];
      this.A = this.B = this.front = this.back = null;
      this.idx = -1; this.warmIdx = -1;
    },
  };
  return { deckReady, deckSeek, playSafe, PreviewVol, TlPlay };
}
