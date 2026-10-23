/* 剪辑态播放计划：本镜 = 这一条候选剪出来的几段；全片 = 所有已选用镜头的段。
   两个页签同一份 `c.segs`，所以这里只是把它摊成「成片时间轴上的一段一段」。
   纯计划，不碰 DOM；播放器只按这份计划走。 */
import { segLen, segSpd, segsOf, tlClipDur } from './segments.js';
import { voiceRateOf, voiceRuns } from './voice-layout.js';

export function createPlayPlan(ctx) {
  return function tlPlayPlan() {
    const proj = ctx.getProj();
    const film = (proj.tlTab || 'shot') === 'film';
    const clips = [], voices = [];
    let acc = 0;
    /* `spd` 两条 push 都带上，但**只有全片页签真的按它折算**（`TlPlay` 拿 `film` 旗标决定轴系数）：
       本镜轨量的是「这一条候选的第几秒」，倍速把剪掉的那一截缩进成片，不该把这一镜的刻度尺也缩短 ——
       否则用户剪完一刀，本镜轨上「这一段从源第 3 秒开始」的读数会跟着漂，而把手拖的还是那几个源秒。 */
    const push = (src, s) => {
      const dur = segLen(s);
      if (dur <= 0.02) return;
      /* 灰掉的那一格在预览里也必须真的占住这几秒：甲板没有可播的素材，就推一条 `src:''` 的黑场，
         由 TlPlay 按墙钟把它走完。少了这一段，「删掉一段画面」会让预览停在那里、后面的段提前 ——
         用户看到的就是「时长明明没变，播起来却短了一截」。
         黑场没有原声（合成那边同理：`native:false`），所以不带宽。 */
      if (s.off) { clips.push({ src: '', in: s.in, out: s.out, vol: 1, spd: segSpd(s) }); acc += dur; return; }
      /* 图片段是一张静止画面：没有可 seek 的源秒，甲板换成一张图按墙钟走完（与黑场同一支计时）。 */
      if (s.img) { clips.push({ still: s.img, in: s.in, out: s.out, vol: 0, spd: 1 }); acc += dur; return; }
      clips.push({ src: src, in: s.in, out: s.out, vol: ctx.picVolOf(s), spd: segSpd(s) });
      acc += dur;
    };
    if (film) {
      /* 一次同步、一份框基几何：`tl.clips[i]` 与 `G.rows[i]` 是同一个序（下标 k 对上），
         所以这一格在**框基轴**上的起点就是 `G.rows[k].start`。
         为什么必须把 `fs`（框基起点）/ `fa`（框左沿）带进播放计划：全片轨的插针画在框基轴上，
         而 TlPlay.t 是**成片秒**（Σ 保留长度）。两根轴只在「一段没剪过」时长度相等 ——
         一旦哪一段剪出灰块，针就会走进灰块里（用户报的「播放后剪辑条在剪掉的灰块上走」）。 */
      const tl = ctx.tlSyncFromShots();
      const G = ctx.filmFrames(tl);
      const grayFilm = ctx.filmLayGray(G);
      tl.clips.forEach((cl, k) => {
        const fr = G.rows[k];
        const spd = Math.max(0.25, Math.min(4, Number(cl.speed) || 1));
        const sh2 = ctx.allShots().find(x => x.id === cl.shotId);
        const cand = sh2 && ctx.tlCandidateOf(sh2, cl.candId);
        if (!cand) return;
        const start = acc;
        /* 灰掉的那一格走的是 `src:''` + 时长占位这一支：
           它占的秒数与合成那边完全一致，预览走到这里按墙钟走完，接下一格真画面。 */
        const src = cl.gray ? '' : ctx.candTrackSrc(cand);
        if (cl.gray) clips.push({ src: '', in: cl.in, out: cl.out, fs: fr.start, fa: fr.a, vol: 1, spd: spd });
        else if (cl.img) clips.push({ still: cl.img, in: cl.in, out: cl.out, fs: fr.start, fa: fr.a, vol: 0, spd: 1 });
        else if (src) clips.push({ src: src, in: cl.in, out: cl.out, fs: fr.start, fa: fr.a, vol: cl.volume, spd: spd });
        acc = start + tlClipDur(cl);
        /* `off` 必须一起带进播放计划：它是「从音频文件的第几秒开始取」（拖左把手切掉开头时写的），
           而 `at` 是「在画面里从第几秒开始响」—— 两件不同的事。以前这一支只带 at/dur/vol，
           `startVoices` 拿到的 `v.off` 永远是 undefined → 预览一律从音频第 0 秒放，
           合成那边却按 `-ss off` 取，用户看到的就是「剪过开头的配音，预览与成片听到的不是同一截」。
           画面段与配音两条 push 都读同一份 `clipVoices` 的输出，不在这里另算一遍。
           `start`/`dur` 是**源秒**（`clipVoices` 的口径，也是代理 `at = offset + v.start/speed` 的口径），
           而 `voices[].at`/`dur` 要的是成片秒 —— 倍速把两者拉开，所以这里除一次；
           留着不除就是「画面已经 2 倍速了，配音还按原速从第 4 秒才开始响」，预览与成片差半句。
           `ctx` = 这一段的成片起点 + 全片灰场表：压在灰场上的一句会劈成几条（跳过的那几秒不响），
           逐条各起各停 —— 与合成（代理逐条 amix）同一份切法，预览与成片听的是同一句。 */
        ctx.clipVoices(cl, { start: fr.f0, gray: grayFilm }).list.forEach(v => {
          /* 这一句在成片时间轴上占多久 = 文件秒 ÷（那一格的倍速 × 这一句自己那一档）；
             `at` 只除画面倍速（起点是「画面的第几秒」，念得快慢不把它挪前挪后）—— 与代理那两条算式一字不差。
             两个乘数各自都在自己的写点夹过（`setCutSpd` 0.25–4、`voiceRateOf` 0.25–4），所以这里不再夹第三遍。 */
          const r = spd * (v.spd || 1);
          voices.push({ src: v.src, at: start + v.start / spd, dur: Math.max(0.1, v.dur / r), vol: v.vol, off: v.off, spd: r });
        });
      });
    } else {
      const sh = ctx.curShot();
      if (!sh) return { clips: [], voices: [], film: film };
      const cands = sh.candidates || [];
      const c = cands[proj.curCand] || cands.find(x => x.vid === sh.selId);
      if (!c || !ctx.candTrackSrc(c)) return { clips: [], voices: [], film: film };
      const total = ctx.candDur(c, sh);
      const src = ctx.candTrackSrc(c);
      /* 这一支的 `at` 不除倍速：本镜甲板走的是源秒（`TlPlay.srcT` 在 `film:false` 时 ax=1），
         配音也跟着源秒起播，两边同一把尺子。
         灰场表也量在这把尺子上（`push` 每段加 segLen，这里按同一序累一遍，跳法一致）——
         一句压在灰场上的配音在那几秒**停住、越过之后接着放**（`voiceRuns`），
         劈出来的每条各自带起点与时长；本镜预览与「全片」那一档听着是同一句。 */
      const grayWall = [];
      let wacc = 0;
      segsOf(c, total).forEach(s => {
        const d = segLen(s);
        if (d <= 0.02) return;
        if (s.off) grayWall.push([wacc, wacc + d]);
        wacc += d;
      });
      segsOf(c, total).forEach((s, i) => {
        const start = acc;
        push(src, s);
        ctx.shotVoices(sh.id, c.vid).forEach(v => {
          if ((Number(v.seg) || 0) !== i) return;
          /* 本镜这一档的画面甲板走的是源秒（不缩），所以这一句只按**自己那一档**变快慢：
             `at` 不乘（与上面全片那一支同一口径 —— 倍速不动起点，只动占多久）。 */
          const vr = voiceRateOf(v);
          const off0 = Math.max(0, Number(v.off) || 0);
          const lo = start + Math.max(0, Number(v.at) || 0);
          const vdur = Math.max(0.1, (Number(v.dur) || 0) / vr);
          const lay = voiceRuns(lo, vdur, grayWall);
          if (!lay.skips.length) {
            voices.push({ src: v.src, at: lo, dur: vdur, vol: ctx.voiceVolOf(v), off: off0, spd: vr });
            return;
          }
          /* 跳过的那几秒：逐段推一条（`startVoices` 一条一个 Audio、各起各停）——
             `off` 用累加的 consumed：跳过的灰场时长不进「从音频第几秒取」的账。 */
          let consumed = 0;
          lay.runs.forEach(r => {
            voices.push({ src: v.src, at: r[0], dur: Math.max(0.1, r[1] - r[0]), vol: ctx.voiceVolOf(v),
              off: off0 + consumed, spd: vr });
            consumed += (r[1] - r[0]) * vr;
          });
        });
      });
    }
    return { clips: clips, voices: voices, film: film };
  };
}
