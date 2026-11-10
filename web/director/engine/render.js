/* 导演台Render域：候选卡片、渲染左栏（镜头 / 场景 / 素材带）与渲染中栏（播放器 + 候选条 + 就地更新），
   以及轮询用的小件（provById 的注册表兜底、saveScheduleSoft 的 300ms 合并保存）。
   区间内的代码由 engine.js 逐字搬出；proj / REG / WS / historyCursor / voiceDraft / vcTab 这几枚可变状态
   与 Mid / Gen 两个后建的域走 E 里的访问器，engine.js 继续持有状态；document / window 用参数名遮蔽全局。 */

import { createMarker } from '../tl-markers.js';
import { chosenCandOf, deriveTimeline, normalizeTransition, transitionNameOf } from '../film.js';
import { num } from '../util.js';

export function createRender(E, document, window) {
  'use strict';
  const {
    $,
    NO_PROMPT_WHY,
    ST_ZH,
    addLibPicToShot,
    addShotToScene,
    beginEdit,
    candDur,
    compressImg,
    curShot,
    ensureFilm,
    filmClipName,
    filmEdited,
    fmtDur,
    historyCursorOf,
    historyGoTo,
    historyLog,
    mkDraftCandidate,
    newShot,
    paintPromptBox,
    playerEmptyText,
    playerTaskDetails,
    redo,
    releaseCandUrl,
    releaseSceneUrls,
    releaseShotUrls,
    renderAll,
    renderEditor,
    renderMid,
    scheduleSave,
    scheduleSaveQuiet,
    setSelectedCandidate,
    setStatus,
    setVcTab,
    shotDur,
    shotReady,
    thumbKey,
    toDataURL,
    uid,
    undo,
    updateArBadge,
    updateProjUI,
    vcTabOf,
    voiceDraftOf,
    voiceReg,
    voiceWayOf,
    projOf,
    regOf,
    wsOf,
    MidOf,
    GenOf,
    Edit,
    Play,
    Timeline,
  } = E;

/* ---------- 候选卡片（媒体标记与首帧缓存全部走 Wb.thumbs.mediaHTML，页面不再自己拼） ---------- */
/* 没有画面时那一格写什么：整块重画与轮询增量补丁共用这一份措辞
   （两处各写一份时，增量那份漏了 draft 分支，待写描述的候选会被改成「生成中」）。 */
function candStatusText(c) {
  return c.status === 'draft' ? '待写描述'
    : c.status === 'failed' ? '生成失败' : c.status === 'cancelled' ? '已取消'
    : c.status === 'queued' ? '排队中' : (c.status === 'creating' ? '创建中' : '生成中');
}
/* 这一镜「还没结束的那一条」（排队 / 创建中 / 正在跑都算）—— 进度条按它的 progress 走。 */
const shotRunCand = sh => (sh.candidates || []).find(c => c.status === 'running' || c.status === 'queued' || c.status === 'creating') || null;
/* 镜头状态只有一份措辞（右栏镜头清单与中栏「顺序」那条缩略图带共用）：
   「生成中」只给**真在跑的那一条**（`candStatusText` 那一份），排队中就写排队中、创建中就写创建中；
   而「有候选但没有任何在跑的」不再是生成中 —— 全部失败、全部取消、出片了却还没被选用，
   这三种都是「停下来等人处理」，挂着生成中会让人一直等一个不会再动的任务。
   （「顺序」带以前只按 `candidates.length` 判，于是全失败的那一镜永远显示生成中。） */
function shotStatusOf(sh) {
  const runC = shotRunCand(sh);
  const cands = sh.candidates || [];
  const allBad = cands.length > 0 && cands.every(c => c.status === 'failed' || c.status === 'cancelled');
  const text = shotReady(sh) ? '已选用'
    : runC ? candStatusText(runC)
    : allBad ? '生成失败'
    : cands.length ? '待选用'
    : (String(sh.prompt || '').trim() ? '未生成' : '待写描述');
  const cls = shotReady(sh) ? 'okc' : runC ? 'runc' : allBad ? 'errc' : '';
  return { runC, text, html: cls ? '<span class="' + cls + '">● ' + text + '</span>' : text };
}
function candMediaHTML(c) {
  if (c.url) return Wb.thumbs.mediaHTML(c.url, { key: thumbKey(c) });
  const cls = (c.status === 'draft' ? ' draft' : '') + (c.status === 'failed' || c.status === 'cancelled' ? ' fail' : '');
  return `<div class="pending${cls}">${candStatusText(c)}</div>`;
}
function candTitle(c) {
  const bits = [c.status === 'draft' ? '待写描述' : (ST_ZH[c.status] || c.status)];
  if (c.prompt) bits.push('描述：' + String(c.prompt).slice(0, 60));
  if (c.status === 'running' && c.progress) bits.push(c.progress + '%');
  if (c.queue_position) bits.push('队列#' + c.queue_position);
  if (c.created) bits.push('提交 ' + window.fmtHM(c.created));
  if (c.priceText) bits.push(c.priceText);
  if (c.error) bits.push(c.error);
  return bits.join(' · ');
}
function candBadgeHTML(c) {
  try {
    if (!window.AssetLocal || !AssetLocal.showBadge || !AssetLocal.showBadge() || !AssetLocal.stateOf) return '';
    const EM = window.EditorMedia;
    /* 徽标本身（文案 / class / title）只有 ui/badge-state.js 那一份 */
    return window.badgeHTML(AssetLocal.stateOf(EM ? EM.entryOf(c) : c));
  } catch (e) { return ''; }
}
function candThumbInner(c, isCur, i) {
  const list = (curShot() || { candidates: [] }).candidates || [];
  if (i === undefined) i = list.indexOf(c);
  return `<div class="cand-thumb${isCur ? ' cur' : ''}${c.vid === (curShot() || {}).selId ? ' sel' : ''}${c.locked ? ' lock' : ''}${c.status === 'succeeded' && c.url ? ' has' : ''}" data-vid="${esc(String(c.vid))}" data-i="${i}" title="${esc(candTitle(c))}">
    <span class="candno">${i + 1}</span>${c.locked ? `<span class="lockbadge">${icon('lock', 11)}</span>` : ''}${candMediaHTML(c)}${candBadgeHTML(c)}</div>`;
}
/* 没有候选时的占位卡：点了就按这一镜的配置生成一条 */
function candPlaceholder() {
  return `<div class="cand-thumb addcand big" data-add="1">
      <span class="plusic">${icon('plus', 18)}</span><span class="pt">还没有候选</span><span class="pd">点这里新增</span>
    </div>`;
}
/* 有候选时行尾的小加号：再抽一条 */
function candAddTile() {
  return `<div class="cand-thumb addcand" data-add="1" title="先写这条候选的描述，再点「生成这条」">${icon('plus', 16)}</div>`;
}
let midCandExpand = window.LS.get('dir_cand_expand') === '1';
/* 播放器下方那一排控件**只有一份标记**：剪辑态那个预览面与候选播放器以前各抄一遍
   （三行一模一样的按钮 + 一份「按 localStorage 决定喇叭图标」的判断），改一颗就得记着改两处。
   左下 = 播放/暂停 + 时长读数；右下 = 声音 + 全屏，两颗挨着、全屏在最右下角（用户点名）。
   静音态的图标与 title 都按 dir_muted 现读，不写死「声音开关」。 */
function pbBarHTML() {
  const muted = window.LS.get('dir_muted') === '1';
  return `<div class="pb-bar">
        <button class="pb-btn" id="pbBtn" title="播放 / 暂停">${icon('play', 15)}</button>
        <span class="pb-time" id="pbTime">00:00 / 00:00</span>
        <span class="sp"></span>
        <button class="pb-btn" id="pbMute" title="${muted ? '已静音' : '声音已开启'}">${icon(muted ? 'speakerOff' : 'speaker', 14)}</button>
        <button class="pb-btn" id="pbFull" title="全屏观看">${icon('expand', 14)}</button>
      </div>`;
}
/* 全屏：整块 `.player-box` 进去，控件跟着一起（只让 <video> 进全屏的话，
   全屏里就没有退出那颗了）。两个播放器共用这一份接线。
   被浏览器挡下来时（reject）不能只「点了没反应」—— 那是一颗看着能点、其实什么都不做的按钮。 */
function bindPbFull(box) {
  const fb = box && box.querySelector('#pbFull');
  if (!fb) return;
  fb.onclick = e => {
    e.stopPropagation();
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => 0); return; }
    box.requestFullscreen().catch(() => setStatus('<span class="err">全屏没成：浏览器不让这一层画面进全屏</span>'));
  };
}
/* 全屏正开着 → 中间栏这一轮不重建（`renderMid` 开头那一句问的就是它）。
   浏览器此刻显示的只有 `.player-box` 这一层，别处重画用户看不见；而 `renderMid` 是整列
   `col.innerHTML =`（连 `keepBox` 那一路也先 `old2.remove()` 一次）—— **全屏元素脱离文档 = 当场退出全屏**。
   轮询每 3 秒走一次 `renderSoft` → `renderMid`，所以「全屏进去几秒就被弹回工作台」是这一条，
   不是浏览器不让进。欠下的那一轮在退出那一刻补画：`fullscreenchange` 只在**离开**时做事。 */
let fsRedraw = false;
function fullscreenHold(col) {
  /* 必须先确有播放器再比：首屏中栏还是空的，`querySelector` 与 `document.fullscreenElement`
     会同时是 null —— `null !== null` 为 false，这一句会把「还没画」误判成「正在全屏」，
     于是 renderMid 每次都早退、中栏永远画不出来（自锁）。 */
  const box = col && col.querySelector('.player-box');
  if (!box || document.fullscreenElement !== box) return false;
  fsRedraw = true;
  return true;
}
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement || !fsRedraw) return;
  fsRedraw = false;
  renderMid();
});
/* 中间栏那只播放器**此刻该放哪一条素材**——判据只有一份：
   `playerAreaHTML` 用它出 src 与首帧，`renderMid` 用它决定「这一轮要不要保住旧节点」。
   两处各算一份就会出现「保住的是上一条候选」，那比闪一下更难查。
   剪辑态交回 null —— 那一档没有单一素材，两个甲板按时间线轮流放。 */
function playerMediaOf(sh) {
  if (midEditTrim) return null;
  const cur = ((sh && sh.candidates) || [])[projOf().curCand];
  return cur && cur.url ? { cur, src: Api.mediaSrc(cur.url) } : null;
}
/* 播放区文案（本镜候选 / 剪辑态实时预览 / 空态） */
function playerAreaHTML(sh) {
  /* 剪辑态：播放交给 Play（单一预览面，按当前 clip 换元素）。
     这是「剪完马上看到效果」的落点 —— 改一个入点不用再整片合成一次。 */
  if (midEditTrim) {
    /* 一段都没有（这一镜没候选 / 还没有任何已选用的镜头）就别摆一个黑框骗人 ——
       那正是「看着能播、其实什么都没有」的空控件，按全站约定要照实说一句。 */
    if (!Play.clipCount()) {
      return `<div class="player-empty">
        <div class="pe-t">还没有已选用的镜头</div>
        <div class="pe-d">先在候选上点「选用」，这里的剪辑预览就会按剪完的样子播</div>
      </div>`;
    }
    return Play.stageHTML();
  }
  /* 走到这里就是生成态：剪辑态在上面已经 return（两个甲板 + 实时播），
     不再有别的一种播放器。 */
  const pm = playerMediaOf(sh);
  if (pm) {
    const frame = Wb.thumbs.get(pm.cur.url, thumbKey(pm.cur)) || '';
    return `<div class="player-box">
      <video id="player" src="${esc(pm.src)}" playsinline${frame ? ` poster="${frame}"` : ''}></video>
      ${pbBarHTML()}
      <span class="arbadge" id="arBadge"></span></div>`;
  }
  return `<div class="player-empty">
    <div class="pe-t">${playerEmptyText(sh)[0]}</div>
    <div class="pe-d">${playerEmptyText(sh)[1]}</div>
    ${playerTaskDetails(sh)}
  </div>`;
}
/* 操作行（导入 | 弹性空 | 取消选用/选用 | 锁定 / 删除）：取消选用与选用是同一格的两面 —— .faces
   把两面叠放在同一格里并各自右对齐，露出来的那面永远贴着锁定，不在用的那面挂 .off
   （visibility 隐身、宽度照常撑着这一格）—— 这一排随轮询重画，按钮一挪，点下去就落在别的键上。
   锁定那颗的文案只许等宽短词（锁定 / 解锁）：再长的字串会把右边的删除键横推出去；锁没锁看缩略图右上的角标。 */
function candActsHTML(sh) {
  const cands = sh.candidates || [];
  const cur = cands[projOf().curCand];
  const picked = !!(cur && cur.vid === sh.selId);
  const usable = !!(cur && !picked && cur.status === 'succeeded' && cur.url);
  return `<span class="faces"><button class="ghost${picked ? '' : ' off'}" id="unsel" ${picked && !cur.locked ? '' : 'disabled'}>× 取消选用</button><button class="ghost${picked ? ' off' : ''}" id="usec" ${usable ? '' : 'disabled'}>✓ 选用</button></span>
    <button class="ghost" id="lockc" ${cur ? '' : 'disabled'}>${icon('lock', 12)} ${cur && cur.locked ? '解锁' : '锁定'}</button>
    <button class="ghost danger" id="delc" ${cur && !cur.locked ? '' : 'disabled'}>${icon('trash', 12)} 删除</button>`;
}
/* 操作行的按钮绑定（renderMid 与「切换候选」共用） */
function bindCandActs(col) {
  col = col || $('midCol');
  if (!col) return;
  const sh = curShot();
  if (!sh) return;
  const cur = (sh.candidates || [])[projOf().curCand];
  const uc = col.querySelector('#usec');
  if (uc) uc.onclick = () => {
    const candNo = (sh.candidates || []).indexOf(cur) + 1;
    const prevNo = (sh.candidates || []).findIndex(x => x.vid === sh.selId) + 1;
    beginEdit(prevNo
      ? `把「${sh.name || '这一镜'}」选用的候选从第 ${prevNo} 条换成第 ${candNo} 条（${fmtDur(candDur(cur, sh))}）`
      : `把「${sh.name || '这一镜'}」第 ${candNo} 条候选（${fmtDur(candDur(cur, sh))}）接进成片`);
    setSelectedCandidate(sh, cur);
    filmEdited();
  };   // 选用后不自动锁定，可手动加锁（换候选 = 成片内容变了）
  const un = col.querySelector('#unsel');
  if (un) un.onclick = () => {
    /* 不设二次确认：撤选用一步可逆（重新点「选用」或 Ctrl/⌘+Z 都回得来），
       这排里带「确认…」的只有删除那颗 —— 它真的删字节。 */
    beginEdit(`把「${sh.name || '这一镜'}」从成片里撤掉（取消选用第 ${Math.max(1, (sh.candidates || []).findIndex(x => x.vid === sh.selId) + 1)} 条候选）`);
    setSelectedCandidate(sh, null);
    filmEdited();
  };
  const lk = col.querySelector('#lockc');
  if (lk) lk.onclick = () => { if (cur) { cur.locked = !cur.locked; renderAll(); scheduleSave(); } };
  const dl = col.querySelector('#delc');
  if (dl) dl.onclick = e => {
    const b = e.currentTarget;
    /* 就地确认走默认画法（与取消选用同一副）：整颗变红换字「确认删除？」，再点一下才真删；
       不带红环 / 角标 / toast。还在跑的这条撤不撤得了单，由注册表的 cancel 声明决定
       （判据只有 Api.canCancel 一份）：没有取消接口的那几家删了本机记录，平台上那条照样跑完。 */
    const live = !!cur && (cur.status === 'queued' || cur.status === 'running');
    const cxProv = live ? provById(cur.provider) : null;
    Confirm.arm(b, '确认删除？')
      || (() => {
        if (!cur || cur.locked) return;
        if (live && cxProv && Api.canCancel(cxProv)) {   // 还在跑的先取消上游任务
          // 取消走统一路由：POST 还是 DELETE 由 registry 的 cancelMethod 声明决定
          // 撤单失败不能静默吞 —— 那样用户以为平台上也没了，而那条还在计费
          Api.cancel(cxProv, cur.vid).catch(e => Toast.warn('没能让平台停掉这条任务：' + errText(e) + '（平台上可能还在跑）'));
        }
        sh.candidates = (sh.candidates || []).filter(c => c !== cur);
        if (sh.selId === cur.vid) setSelectedCandidate(sh, null);
        releaseCandUrl(cur);                                          // 本地视频的 blob: URL 用完了要回收
        projOf().curCand = Math.max(0, Math.min(projOf().curCand, sh.candidates.length - 1));
        filmEdited();
      })();
  };
}
/* 切换查看的候选：只改瓦片高亮 + 换播放器地址（<video> 元素原地保留，不动缩略图） */
function selectCandidate(at) {
  const col = $('midCol'), sh = curShot();
  if (!col || !sh) return;
  const cands = sh.candidates || [];
  if (at < 0 || at >= cands.length || at === projOf().curCand) return;
  projOf().curCand = at;
  /* 提示词框跟着换到**当前查看的候选**当年那句（promptTextOf 读的就是它），
    但**不回写 sh.prompt**：翻看是纯预览，这一镜的描述（左栏卡片 / 批量生成读的那份）
    只能由用户输入或 AI 拆分镜改 —— 以前顺手 `sh.prompt = picked.prompt`，
    用户刚写的新描述会被一条旧候选的旧描述顶掉，而且这一下还被当成一次编辑压进撤销栈。
    「生成这一镜」按屏幕上这句发（drawShot 收 promptTextOf(sh)），不会出现
    「屏幕上写着 B、生成出来的却是 A」。 */
  paintPromptBox(sh);
  col.querySelectorAll('.cand-thumb[data-vid]').forEach(t => {
    const c = cands.find(x => String(x.vid) === t.dataset.vid);
    t.classList.toggle('cur', c === cands[at]);
  });
  const target = cands[at];
  const pw = col.querySelector('#playerWrap');
  const pl = col.querySelector('#player');
  if (pw && target && target.url && pl) {
    // 已经有播放器：只换地址（再拿缓存首帧当封面，尽量不黑一下）
    const frame = Wb.thumbs.get(target.url, thumbKey(target)) || '';
    if (frame) pl.setAttribute('poster', frame); else pl.removeAttribute('poster');
    if (pl.getAttribute('src') !== Api.mediaSrc(target.url)) { pl.setAttribute('src', Api.mediaSrc(target.url)); try { pl.load(); } catch (e) { /* 换源后 load 被拒（正在播）不影响下一次起播 */ } }
    const badge = col.querySelector('#arBadge');
    if (badge) { badge.textContent = ''; badge.title = ''; }
    if (pl.readyState >= 1) updateArBadge(pl);
  } else if (pw) {
    // 当前这条还没有画面（排队/失败）或本来就没有播放器：重画播放区（这里没有视频缩略图，重建不会闪）
    pw.innerHTML = playerAreaHTML(sh);
    // 接线与整栏重画是同一份（Mid.wireMidPlayer）：这里以前那份缩水接线少了播放态换面
    MidOf().wireMidPlayer(col, { sh, cur: target, keepPlay: null, keepBox: null });
  }
  /* 只换尾段（#candActsRest）：#candActs 里前面的导入与弹性空是常驻的，
     整行换会把导入抹掉、三颗按钮失了弹性空挤到左边去 */
  const ca = col.querySelector('#candActsRest');
  if (ca) { ca.innerHTML = candActsHTML(sh); bindCandActs(col); }
  scheduleSave();
}

/* 中栏「就地更新」：轮询到新状态时只改需要改的节点，不重建整块 —— 候选缩略图不会一次次重画/重载 */
function updateMidLive() {
  const col = $('midCol');
  const sh = curShot();
  if (!col || !sh || !col.querySelector('.mid-head')) return;
  const cands = sh.candidates || [];
  const curC = cands[projOf().curCand] || null;
  // ① 每个候选瓦片：只改 class / title，必要时才换「占位 ↔ 媒体」这一小块
  col.querySelectorAll('.cand-thumb[data-vid]').forEach(t => {
    const c = cands.find(x => String(x.vid) === t.dataset.vid);
    if (!c) return;
    const want = 'cand-thumb' + (curC === c ? ' cur' : '') + (c.vid === sh.selId ? ' sel' : '')
      + (c.locked ? ' lock' : '') + (c.status === 'succeeded' && c.url ? ' has' : '');
    if (t.className !== want) t.className = want;
    const title = candTitle(c);
    if (t.title !== title) t.title = title;
    const media = t.querySelector('video, img');
    if (c.url && !media) {                                  // 刚出片：占位换成媒体（只动这一块）
      const tmp = document.createElement('div');
      tmp.innerHTML = candMediaHTML(c);
      while (tmp.firstChild) t.appendChild(tmp.firstChild);
      const m2 = t.querySelector('video, img');
      if (m2) Wb.thumbs.bind(t, m2, c.url);
    } else if (!c.url && media) {                           // 又变回没有画面（重试等）：媒体换回占位
      const tmp = document.createElement('div');
      tmp.innerHTML = candMediaHTML(c);
      media.replaceWith(...tmp.childNodes);
    } else if (!c.url) {                                    // 一直是占位：只改文案
      const p = t.querySelector('.pending');
      if (p) {
        const txt = candStatusText(c);
        if (p.textContent !== txt) p.textContent = txt;
        p.classList.toggle('fail', c.status === 'failed' || c.status === 'cancelled');
        p.classList.toggle('draft', c.status === 'draft');
      }
    }
  });
  // ② 播放器：当前候选刚拿到地址 → 需要结构变化，交给完整重画（一次性）
  if (curC && curC.url && !col.querySelector('#player')) { renderMid(); return; }
  const pl = col.querySelector('#player');
  if (pl && curC && curC.url && pl.getAttribute('src') !== Api.mediaSrc(curC.url)) { pl.setAttribute('src', Api.mediaSrc(curC.url)); }
  // ③ 空态里的任务详情：只更新文字
  const host = col.querySelector('.player-empty');
  if (host) {
    const html = playerTaskDetails(sh);
    const old = host.querySelector('.pe-task');
    if (old && !html) old.remove();
    else if (old) old.outerHTML = html;
    else if (html) host.insertAdjacentHTML('beforeend', html);
  }
}

/* 把当前选中那条候选滚进候选条视野：只在用户主动翻条（‹ / ›）时调用；
   新增候选、轮询刷新等自动重画一律保持原滚动位置，不抢视线。 */
function scrollCurThumbIntoView() {
  const box = document.getElementById('candThumbs');
  if (!box) return;
  const el = box.querySelector('.cand-thumb.cur') || box.querySelectorAll('.cand-thumb')[projOf().curCand];
  if (!el) return;
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.left < b.left) box.scrollLeft = Math.max(0, box.scrollLeft + (r.left - b.left) - 8);
  else if (r.right > b.right) box.scrollLeft = box.scrollLeft + (r.right - b.right) + 8;
}

/* 候选条的交互绑定：候选瓦片（切换查看）、占位卡/加号（加一条）、「加一条候选」按钮 */
function bindCandidateStrip(col) {
  col.querySelectorAll('.cand-thumb').forEach(t => {
    if (t.dataset.add) {                                // 占位卡 或 行尾加号
      if (!t.dataset.bound) { t.dataset.bound = '1'; t.onclick = () => addCandidateDraft(); }
      return;
    }
    if (!t.dataset.bound) {                             // 复用来的节点已经绑过，别重复绑
      t.dataset.bound = '1';
      t.onclick = () => {
        const vid = t.dataset.vid;
        const at = (curShot().candidates || []).findIndex(c => String(c.vid) === vid);
        selectCandidate(at);                            // 只换播放器与操作行，不碰候选缩略图
      };
    }
    const media = t.querySelector('video, img');
    /* 接线走公共层，地址用候选自己那条（bind 会自己归一化出缓存键）：
       别用 media.getAttribute('src') —— 占位 <video> 只有 data-src，取到的是 null。 */
    if (media) Wb.thumbs.bind(t, media, media.getAttribute('data-src') || media.getAttribute('src') || '');
  });
  /* 候选条绑定已在上方处理 */
  const exp = col.querySelector('#candExpand');
  if (exp) exp.onclick = () => {
    midCandExpand = !midCandExpand;
    window.LS.set('dir_cand_expand', midCandExpand ? '1' : '0');
    renderMid();
  };
}
/* 新增候选 = 建一个空的候选占位：给它写一条自己的描述，再点「生成这条」
   （占位字段归 mkDraftCandidate 那一份，这里只管「加进去并选中它」） */
function addCandidateDraft() {
  const sh = curShot();
  if (!sh) return;
  const ph = mkDraftCandidate(sh);
  sh.candidates.push(ph);
  projOf().curCand = sh.candidates.length - 1;         // 新占位直接选中，马上就能写描述
  renderAll(); scheduleSave();
  setTimeout(() => { const ta = $('edPrompt'); if (ta) { ta.scrollIntoView({ block: 'nearest' }); window.focusQuiet(ta); ta.select(); } }, 80);   // 描述在右栏写
}
/* 生成某一条候选（按它自己那条描述；草稿会原地变成任务） */
async function generateCandidate(ph) {
  const sh = curShot();
  if (!sh || !ph) return;
  const txt = String(ph.prompt == null ? sh.prompt : ph.prompt).trim();
  if (!txt) {
    setStatus('<span class="err">' + NO_PROMPT_WHY + '（可以先复制当前镜头的描述再改）</span>');
    const ta = $('edPrompt');
    if (ta) { ta.scrollIntoView({ block: 'nearest' }); window.focusQuiet(ta); }
    return;
  }
  ph.prompt = txt;
  ph.status = 'creating';
  renderAll();
  try {
    await GenOf().submitCandidate(sh, ph);
    setStatus('<span class="ok">✓ 已按这条候选的描述提交生成</span>');
  } catch (e) {
    setStatus('<span class="err">提交失败：' + e.message + '</span>');
  }
  renderAll(); scheduleSave();
}

/* 候选排序：已出片的在前，排队/生成中的在后，失败的最后；稳定排序，当前查看的那条跟着走 */
function candRank(c) {
  if (c.status === 'succeeded' && c.url) return 0;
  if (c.status === 'failed' || c.status === 'cancelled') return 2;
  return 1;                                     // draft / creating / queued / running（都还没有画面）
}
function sortCandidates(sh) {
  const arr = sh.candidates || [];
  const curCand = sh.candidates === (curShot() || {}).candidates ? projOf().curCand : -1;
  const keep = (curCand >= 0 && arr[curCand]) ? arr[curCand] : null;
  const ranked = arr.map((c, i) => ({ c, i, r: candRank(c) }));
  ranked.sort((a, b) => (a.r - b.r) || (a.i - b.i));
  const changed = ranked.some((x, i) => x.i !== i);
  if (!changed) return false;
  sh.candidates = ranked.map(x => x.c);
  if (keep) { const at = sh.candidates.indexOf(keep); if (at >= 0) projOf().curCand = at; }
  return true;
}

/* ---------- 生成轮询引擎 ---------- */
/* 平台对象一律来自注册表。**认不出就返回 null**，不兜底到别家 ——
   `Api.prov('video')` 那个兜底是同一个病的另一个实例：它会把「这一条候选属于 A 家」
   悄悄改成「按 B 家的接口去问」，于是轮询拿 B 的字段名读 A 的任务 —— 永远读不到状态。
   调用方本来都写了 `if (!prov) ...`（engine/gen.js 的 pollOne 那处会标 failed 并说清原因），
   去掉兜底反而让它们走到本来准备好的那条路上。 */
function provById(id) {
  if (window.Api && Api.prov) return Api.prov(id);
  const list = (regOf()?.providers || []);
  return list.find(p => p.id === id || (p.keyId || p.id) === id) || null;
}
let softTimer = null;
function saveScheduleSoft() { clearTimeout(softTimer); softTimer = setTimeout(scheduleSaveQuiet, 300); }

/* ---------- 渲染：左栏 ---------- */
/* 缩略图与首帧缓存：统一走 workbench.js 的 Wb.thumbs（全站一份实现）
   —— 以前这四个页面各写一份，连缓存用的 IndexedDB 库都不一样。
   页面这里不再自己攒「媒体元素复用表」：占位 <video> 从不加载（抽帧用的是公共层
   自己的离屏 video），重画时命中缓存就直接出 <img>，复用旧节点反而会把已经画好的
   那一帧换回空白节点。 */
function hydrateThumbFrames() {
  return Wb.thumbs.hydrate().then(n => { if (n) { try { renderScenes(); } catch { /* 缩略图补齐后的重画失败就留着旧画面 */ } } });
}
/* 工作区里存着的镜头地址是平台产物的**签名外链**（VGENV 的 OSS 地址只管一天）。
   放着不管，第二天这些镜头就是「缩略图永远加载不出来、点开只回一句 Format error」，
   而界面上完全看不出原因。开机照旧先画旧地址（不阻塞首屏），这一趟放后台按任务号换新：
   换到就写回工作区并重画那一块 —— 下次打开直接是新鲜的，不用再吃一轮 403。
   过期判定、按平台整批回源（声明了 pollVia:'list' 的平台一次列表请求解出一批）都在
   api.js 的 Api.healMedia 里，页面不重复实现。 */
function healStaleUrls() {
  if (!window.Api || !Api.healMedia) return Promise.resolve(0);
  const recs = [];
  for (const p of wsOf().projects || []) for (const s of p.scenes || []) for (const sh of s.shots || [])
    for (const c of sh.candidates || []) {
      if (c.url && Api.mediaExpired(c.url)) recs.push({ provider: c.provider, id: c.vid, url: c.url, _c: c });
    }
  if (!recs.length) return Promise.resolve(0);
  setStatus('有 ' + recs.length + ' 个镜头的外链签名过期，正在后台换新…');
  return Api.healMedia(recs, {
    limit: 60,
    onFresh(rec, next) {
      rec._c.url = next;
      renderMidSoon();
      scheduleSave();                       // 新地址落盘
    },
  }).then(n => {
    setStatus(n ? '<span class="ok">✓ 已换新 ' + n + ' 个镜头的外链地址</span>'
      : '这些镜头的外链换不到新地址——画面可能已被平台清理');
    return n;
  }).catch(() => 0);
}

/* 输入框逐字触发的重渲染走防抖：避免每敲一个字就整列重建（左栏/中栏互刷时更明显） */
function debounce(fn, ms) { let t = null; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
const renderScenesSoon = debounce(() => renderScenes(), 350);
const renderMidSoon = debounce(() => renderMid(), 350);
/* 删场景 / 删掉最后一个镜头时兜底：项目至少保留一个场景，否则左栏会空、存档也会坏 */
function ensureSceneLeft() {
  if (!projOf() || projOf().scenes.length) return;
  projOf().scenes.push({ id: uid(), name: '场景 1', shots: [newShot()] });
  projOf().curScene = 0; projOf().curShot = 0;
}
/* 删掉一个镜头（连带空场景、光标修正、blob 回收）—— 左栏那颗「×」与 AI 分镜审查弹窗里的
   `delete` 条目走的是同一份，页面里不许再抄第二遍（「提交出去收不回来的动作，删之前要有硬拦」
   这一条纪律在两个入口上也得是同一个判据：调用方**自己**先问 `Wb.stLive`，这里不替它问，
   因为左栏删的是用户点名的一镜、弹窗删的是一批，报数的口径不一样）。
   返回 false = 这一镜（或它所属那一场）此刻已经不在账上了，调用方照实计 `skipped`。 */
function removeShot(sc, sh) {
  if (!projOf() || !sc) return false;
  const si = projOf().scenes.indexOf(sc);
  if (si < 0) return false;
  const xi = (sc.shots || []).indexOf(sh);
  if (xi < 0) return false;
  const wasCurScene = si === projOf().curScene;
  releaseShotUrls(sh);                                     // 回收本地视频的 blob 地址
  sc.shots.splice(xi, 1);
  if (!sc.shots.length) {
    projOf().scenes.splice(si, 1);                             // 空场景一并清掉
    if (si < projOf().curScene) projOf().curScene--;               // 它后面的场景整体前移了一格，当前指针对着不动就选错场景
  }
  ensureSceneLeft();                                       // 但至少留一个场景，别把项目删空
  projOf().curScene = Math.max(0, Math.min(projOf().curScene, projOf().scenes.length - 1));
  /* 只有删掉的正是「当前选中的那一镜」时才需要挪选中位（往前挪到它上面那条）。
     以前无条件写成 0：在别的场景里删一个镜头，会把用户正在敲的镜头跳到第一条。 */
  if (wasCurScene && xi <= projOf().curShot) projOf().curShot = Math.max(0, projOf().curShot - 1);
  const curSc = projOf().scenes[projOf().curScene];
  projOf().curShot = Math.max(0, Math.min(projOf().curShot, (curSc && curSc.shots.length ? curSc.shots.length : 1) - 1));
  return true;
}
/* ============================================================================
   场景图 —— 左栏每个场景一张图，这个场景里新建的镜头自动把它带进参考图
   ----------------------------------------------------------------------------
   「这一镜能不能收参考图 / 收到第几张 / 这张是不是已经有了」不在这里重写一遍：
   全部走 `addLibPicToShot`（能力声明 + 素材互斥 + 上限 + 按图去重那份判据），
   这里只回答两件事：**图从哪来**、**这句要不要跟用户说**。
   ========================================================================== */
/* 场景名的归一化只有一份，在 `web/ui/ui.js` 的 `window.nameKey`（2026-10-17 从这一页收成公共层）：
   判「同一个场景」、判「素材库里同名那一条」、素材库判「同一个分组」用的是同一把尺子。
   它以前是本页私有函数，于是素材库那份组名判据各按字面 trim，两组各算各的。 */
/* 素材库里那一族「场景」条目，按名字认领一张图。**只兜底**：用户在左栏亲手挑的那张永远优先，
   库里换了图也不必把工作区里那份覆盖掉。 */
function libScenePic(scName) {
  const D = window.Chars;
  if (!D || !D.Lib || !D.libKindOf || !D.picOf) return '';
  const k = nameKey(scName);
  if (!k) return '';
  const hit = (D.Lib.list() || []).find(x => x && D.libKindOf(x) === 'scene' && nameKey(x.name) === k);
  return (hit && (D.refPicOf ? D.refPicOf(hit) : D.picOf(hit))) || '';
}
/* 按 id 认库里那条（14.2-4：拆分镜建档时把 sceneLibId 绑上，喂图按 id）。
   改名 / 同名两条都分得开 —— 名字那条只是老工程的兜底（只读不写）。 */
function libEntryById(id) {
  const D = window.Chars;
  if (!D || !D.Lib || !id) return null;
  return (D.Lib.list() || []).find(x => x && x.id === id) || null;
}
/* 这个场景**现在**对得上的那张图：左栏挑的 → 素材库按 id 绑的那条 → 同名兜底 → 没有。
   `sc.noPic` = 用户在左栏按过「这个场景不带图」，连素材库那张也不认领。
   这一项不是多余的状态：缩略图上显示的就是库里那张，只把 `sc.img` 清掉的话
   点完「×」画面一个字没变 —— 看着像按钮坏了，而用户确实想让它不带。 */
function scenePicOf(sc) {
  if (!sc || sc.noPic) return '';
  if (sc.img) return sc.img;
  const byId = sc.sceneLibId ? libEntryById(sc.sceneLibId) : null;
  if (byId) return (window.Chars && (Chars.refPicOf ? Chars.refPicOf(byId) : Chars.picOf(byId))) || '';
  return libScenePic(sc.name) || '';   // 老工程没绑 id 的兜底：按名字找一次，不写回
}
/* 一批新镜头落进某个场景之后统一认领它的场景图，结果收成 {added, why}。
   `skipped`（这个场景本来就没有图）不进统计、也不吭声 —— 界面上不该为「本来就没有的东西」报一句；
   但「型号不收参考图」「已经选了首尾帧」「超出上限」这些**带不上的**必须说，
   否则用户以为新镜头带着场景图，实际提交的是干净的提示词。 */
function feedScenePics(sc, shots) {
  let added = 0, why = '';
  (shots || []).forEach(sh => {
    const r = applyScenePic(sh, sc);
    if (r.skipped) return;
    if (r.ok) { if (!r.dup) added++; return; }
    if (!why) why = r.why || '';
  });
  return { added: added, why: why };
}
function applyScenePic(sh, sc) {
  const pic = scenePicOf(sc);
  if (!pic) return { ok: false, skipped: true };
  /* 优先递库里那条真实条目（带 id）——refMeta 记 id 后改名不断引用；
     老工程没绑 sceneLibId 时递名字对象，只按名字对（兜底只读不写）。 */
  const hit = sc && sc.sceneLibId ? libEntryById(sc.sceneLibId) : null;
  return addLibPicToShot(sh, hit || { id: sc && sc.sceneLibId, name: (sc && sc.name) || '场景' }, { src: pic });
}
/* 把 AI 拆出来的一批场景落进一个**已有项目**：同名（归一之后）的并进那一场，对不上号的才新建一场。
   单独成一个函数的两个理由：
   ① 这一条判据要能被探针问一遍 —— `aiStoryboard` 那一整段要等文字 AI 与两个确认弹窗，探针跑不动它；
   ② 「并进已有场景时场景图归谁」必须以**那一场**为准（它可能自己挑过一张、也可能按过 ×），
      把这段就地写在页面里最容易漏掉这一半。
   `at` = 最后落笔的那一场在哪，调用方据此放光标：全部并进球场时 `scenes.length-1` 指的是
   一个与本次毫无关系的老场景，光标跳过去会让人以为追加错了地方。 */
function placeScenesInto(scenes, newScenes) {
  const list = scenes || [];
  let merged = 0, created = 0, added = 0, why = '', at = Math.max(0, list.length - 1);
  (newScenes || []).forEach(sc => {
    const k = nameKey(sc.name);
    const dst = k ? list.find(x => nameKey(x.name) === k) : null;
    const host = dst || sc;
    if (dst) { dst.shots.push(...sc.shots); merged++; }
    else { list.push(sc); created++; }
    at = Math.max(0, list.indexOf(host));
    const r = feedScenePics(host, sc.shots);        // 只喂这一次新建的镜头，那一场里原有的不动
    added += r.added; if (r.why && !why) why = r.why;
  });
  return { merged: merged, created: created, at: at, pics: { added: added, why: why } };
}
/* 结果怎么说：成功走顶部那行小字（不弹浮层，不打扰正在打字的人），
   带不上走 Toast.warn —— 它是「用户该知道、但此刻不在他眼前」的那一半。
   `tail` 给调用方把自己那句结果（「已追加 N 个镜头」）拼进来：顶部那一行只有一个位置，
   分两次 setStatus 等于后一句把前一句顶掉，界面上就只剩一半。
   `assets` 是同一批镜头上的**素材图**账（`SplitAssets.bind` 那份）：它和场景图抢同一批参考图名额，
   所以两笔一起报才有意义 —— 只报场景图那一句，用户会以为新镜头都带上图了。
   两句的「为什么带不上」合成一条 Toast：两条浮层叠着弹，读的人只会当成同一件事。 */
function reportScenePics(res, tail, assets) {
  const bits = [];
  if (tail) bits.push(tail);
  if (res && res.added) bits.push('场景图已自动带进 ' + res.added + ' 个新镜头的参考图');
  if (assets && assets.n) bits.push('素材图带进 ' + assets.n + ' 张（' + assets.shots + ' 个镜头）');
  if (assets && assets.dup) bits.push(assets.dup + ' 张原本就在参考图里');
  if (bits.length) setStatus('<span class="ok">✓ ' + esc(bits.join(' · ')) + '</span>');
  const why = [];
  if (res && res.why) why.push('场景图：' + res.why);
  if (assets && assets.why) why.push('素材图：' + assets.why);
  if (why.length) Toast.warn('没能带进参考图 —— ' + why.join('；'));
}
/* 上一次这一格画的究竟是哪一份图。场景图存的是 dataURL（要长期挂在左栏、还要整份拷进新镜头的
   参考图），而 `Wb.thumbs._kattr` 嫌键太长不落 DOM 属性，所以「是不是同一张」只能问这份记录 ——
   库里同名那一条继承来的图是普通地址，重画一次就等于重新发一次请求，闪的正是它。 */
const scenePicStamp = new WeakMap();
/* 这一格长什么样只有一份画法：整片重画（renderScenes）与「改完名就地重画」走同一个函数 ——
   两处各拼一遍迟早变成「改了场景名，那一格还挂着按旧名字认领的图」。 */
function paintSceneThumb(btn, sc) {
  if (!btn) return;
  const pic = scenePicOf(sc);
  btn.classList.toggle('none', !pic);
  btn.title = sc.img ? '这个场景自己挑的场景图'
    : pic ? '场景图认的是素材库里同名那条（「' + (sc.name || '') + '」）'
      : '还没有场景图；挑一张后，新建的镜头会自动带它当参考图';
  /* 还是同一张图 → 节点一个都不动。class 与 title 上面已经就地改过（改名那句要说的是新名字），
     所以「图没换、说法变了」这一种也能当场跟上，不必为了它把图重新加载一遍。 */
  if (scenePicStamp.get(btn) === pic && btn.firstElementChild) return;
  scenePicStamp.set(btn, pic);
  btn.innerHTML = pic
    ? Wb.thumbs.mediaHTML(Api.mediaSrc(pic), { type: 'image', mediaAttrs: 'class="sp" loading="lazy"' })
    + '<span class="sp-x" data-act="scpicclear" title="这个场景不再自动带图">' + icon('close', 9) + '</span>'
    : icon('image', 13);
  if (pic) Wb.thumbs.bind(btn, btn.querySelector('img'), Api.mediaSrc(pic));
}
/* 挑一张场景图：右栏那几个槽位用的同一份选择器（资产库 / 收藏 / 本地上传 / AI 搜索都在里面）。 */
function pickScenePic(sc) {
  AssetPicker.open({
    types: ['图片'], multiple: false, limit: 1, aiSearch: true,
    title: '给场景「' + (sc.name || '未命名') + '」挑一张图',
    note: '只对之后新建的镜头生效，已建好的不动。',
    onPick: e => setScenePic(sc, e),
  });
}
async function setScenePic(sc, e) {
  try {
    /* 存成 dataURL，不存选择器递回来的那个地址：/getv 那条包的是平台签名外链，一天就过期，
       而这一张要长期挂在左栏，还要整份拷进每个新镜头的 refImages（那里面存的本来就是 dataURL）。 */
    sc.img = e.file ? await AssetTransfer.toDataURL(await compressImg(e.file)) : await toDataURL(e.src);
    sc.noPic = false;                         // 重新挑一张 = 「这一场要带图」，之前按过 × 那句话作废
    renderScenes(); scheduleSave();
    /* 这句要说清「生效范围是以后的新镜头」：已经建好的那些一张都没动，
       界面却在下一次新建镜头时才带上图 —— 不说清会让人以为整场都换好了。 */
    setStatus('<span class="ok">✓ 已给「' + esc(sc.name || '这个场景') + '」设好场景图：这个场景里新建的镜头会自动带上它，已有的镜头不动</span>');
  } catch (err) {
    setStatus('<span class="err">场景图取回来失败：' + esc(errText(err)) + '</span>');
  }
}
/* 清掉 = 「这个场景不自动带图」，不只是抹掉自己挑的那一张：
   素材库里恰好有同名那条时，只清 `sc.img` 的话这一格画出来还是原来那张，按下去就是「没反应」。 */
function clearScenePic(sc) {
  sc.img = ''; sc.noPic = true;
  renderScenes(); scheduleSave();
  setStatus('已让「' + esc(sc.name || '这个场景') + '」不再自动带场景图');
}
/* 图标：垃圾桶（内联 SVG，颜色跟着按钮走，深浅主题都干净） */
const TRASH_SVG = icon('trash', 14);
function renderScenes() {
  const box = $('scenesBox');
  /* 剪辑态左栏换面（轨道坞在页面底栏，左栏让给「历史编辑记录 + 素材」）：
     只翻类与 hidden，常驻结构不销毁 —— 退出剪辑左栏原样回来。 */
  const leftCol = document.querySelector('.col-left');
  if (leftCol) leftCol.classList.toggle('editing', !!midEditTrim);
  const elBox = document.getElementById('editLeft');
  if (elBox) {
    elBox.hidden = !midEditTrim;
    if (midEditTrim) renderEditLeft(elBox);
  }
  /* 重画之前先把「此刻已经有画面的那一枚」按镜头收起来，建完再收养（见下面那一段的条件）。
     以前这里 `box.innerHTML = ''` 把每一张卡片连着那个**正在抽帧**的 `<video>` 一起销毁：
     于是剪一刀、点一次轨道、切一次候选，左栏每一张还没进缓存的缩略图都退回「…」重来一遍 ——
     用户报的「各个地方的视频预览都在闪」，左栏这一份就是它（中间栏那一份在 renderMid）。 */
  const keepWrap = new Map();
  box.querySelectorAll('.shot-item').forEach(x => {
    const w = x.querySelector('.sthumb-wrap');
    const m = w && w.querySelector('.sthumb');
    if (x.dataset.sid && w && m && m.getAttribute('data-thumb-key')) keepWrap.set(x.dataset.sid, w);
  });
  /* 场景图那一格同理：它挂在 `.scene-head` 上、不参与 `.shot-item`，所以单独收一份。
     这里只按场景收「候选」，「到底是不是同一张图」由下面拿 scenePicStamp 现比 ——
     按名字认领的那一张会随改名换掉，收养错了就等于让界面停在上一张图上。 */
  const keepPic = new Map();
  box.querySelectorAll('.scene-head').forEach(h => {
    const b = h.querySelector('[data-act=scpic]');
    if (h.dataset.scid && b) keepPic.set(h.dataset.scid, b);
  });
  /* 建列那一整段罩在公共件里（`Wb.viewport.keep`）：`box.innerHTML = ''` 之后从零重建，左栏那一列的滚动位
     在清空那一刻被夹回 0 —— 而这一列每轮任务轮询都要重画一次，表现是「正看着第 20 镜，一次刷新弹回栏顶」。
     锚点认镜头行与场景头那两枚身份（`data-sid` / `data-scid`）：删一镜、增一场之后还的是「同一行还在原来
     那个位置」，不是「同一堆像素」。缩略图与场景图的收养（keepWrap / keepPic）管的是「不重新抽帧」，
     与滚动位是两件事，照旧留在这里。 */
  let n = 0;                       // 列出的镜头数（重建那一趟只往上加，画完写给表头）
  Wb.viewport.keep(box, () => {
    box.innerHTML = '';
    projOf().scenes.forEach((sc, si) => {
      /* 剪辑态左栏这一列只列**已选用的候选**镜头（`shotReady` = 这一镜选的那条已经出画面，
         也就是它进了成片的那一份账）；生成态那一列照旧列全部镜头，一个都不少。
         「列出哪几镜」与「点它会去哪」是一件事：剪辑态点一行 = 剪辑针跳到那一镜在成片里的位置
         （见 `leftShotPick`）。
         场景分组留着，一个可用的都没有的空场景在剪辑态整个不画（别占一行空壳）。 */
      const listed = [];
      sc.shots.forEach((sh, xi) => { if (!midEditTrim || shotReady(sh)) listed.push([sh, xi]); });
      if (midEditTrim && !listed.length) return;
      const blk = document.createElement('div');
      blk.className = 'scene-block';
      const head = document.createElement('div');
      head.className = 'scene-head';
      /* 收养要有身份可认：按场景号收（不是按第几场 —— 删一场之后下面的场全体上移一格）。
         老项目里可能没有 id，退到序号，两侧用同一个表达式就仍然对得上。 */
      head.dataset.scid = sc.id == null ? 'i' + si : String(sc.id);
      /* 场景图那一格：有图就显示图，没图显示一个虚线空位。
         右上角那颗 ×「这个场景不再自动带图」，与「换一张」放在同一个格子里 ——
         分开放要多占一个 flex 子项，而左栏最窄只有 198px，四个按钮加改名框就顶不下了。
         剪辑态整块不画：场景图管的是「以后新建的镜头带哪张参考图」，
         属于生成态那一族（用户点名：剪辑态左栏不该带新建删除那些生成态的东西）。
         留着的是场景名与镜头数 —— 那是这一组的标签，剪的时候还要靠它认场景。 */
      head.innerHTML = (midEditTrim ? '' : `<button class="sc-thumb" data-act="scpic"></button>`)
        + `<input value="${esc(sc.name)}" title="点一下可以改场景名">
        <span class="sc-cnt">${listed.length} 镜</span>`
        + (midEditTrim ? '' : `<button class="icon-btn add" data-act="addshot" title="在这个场景末尾新建一个镜头">${icon('plus', 14)}</button>
        <button class="icon-btn del" data-act="delscene" title="删除整个场景（连带里面的镜头）">${TRASH_SVG}</button>`);
      /* 收养只认「画的是同一张图」这一件事：这一格的媒体可能是从素材库现取的外链，
         整颗按钮推倒重来就是让它重新走一遍加载（任务轮询每一轮都走 renderSoft 重画左栏，
         闪的正是这一下）。收养的是整颗按钮 —— 绑定的键是它，不是里面的 <img>。 */
      const picBtn = head.querySelector('[data-act=scpic]');
      if (picBtn) {
        const keptPic = keepPic.get(head.dataset.scid);
        if (keptPic && scenePicStamp.get(keptPic) === scenePicOf(sc)) picBtn.replaceWith(keptPic);
        paintSceneThumb(head.querySelector('[data-act=scpic]'), sc);
      }
      /* 改名要当场重画这一格（素材库里同名那条的图是**按名字**认领的），但不能整片 renderScenes：
         那会把这个正在打字 input 一起换掉、光标跳走。只换那一颗按钮的内容。 */
      head.querySelector('input').oninput = e => {
        sc.name = e.target.value; scheduleSave(); renderMidSoon();
        if (picBtn) paintSceneThumb(head.querySelector('[data-act=scpic]'), sc);
      };
      /* 一格两个动作：点图本身 = 换一张，点右上角 × = 这一场不带图。
         × 不做二次确认 —— 它随时可以反悔（再点一次图挑回来就是原样），
         而 Confirm.arm 会把按钮文字换成「确认…」，连带抹掉里面那张缩略图。 */
      if (picBtn) picBtn.onclick = e => {
        e.stopPropagation();
        if (e.target.closest('[data-act=scpicclear]')) { clearScenePic(sc); return; }
        pickScenePic(sc);
      };
      if (!midEditTrim) {
        head.querySelector('[data-act=addshot]').onclick = e => { e.stopPropagation(); addShotToScene(sc); };
        head.querySelector('[data-act=delscene]').onclick = e => {
          const b = e.currentTarget;
          const n = (sc.shots || []).length;
          Confirm.arm(b, '确认删除？', { note: n ? '这个场景里还有 ' + n + ' 个镜头，会一起删掉' : null })
            || (releaseSceneUrls(sc),                          // 回收本地视频的 blob 地址，否则一直占内存
                projOf().scenes.splice(si, 1),
                ensureSceneLeft(),                            // 删到最后一个场景时自动补一个空的，避免项目变成 0 场景
                projOf().curScene = Math.min(projOf().curScene, projOf().scenes.length - 1),
                renderAll(), scheduleSave());
        };
      }
      blk.appendChild(head);
      listed.forEach(([sh, xi]) => {
        n++;
        const it = document.createElement('div');
        it.className = 'shot-item' + (si === projOf().curScene && xi === projOf().curShot ? ' sel' : '');
        it.dataset.sid = sh.id;
        it.draggable = false;   // 默认不可拖，按住 ⠿ 抓手才开启拖动
        const cur = sh.candidates.find(c => c.vid === sh.selId);
        const rawSrc = cur?.url || sh.firstFrame || '';
        const sKey = cur?.url ? thumbKey(cur) : Wb.thumbs.keyOf(rawSrc);
        const thumb = cur?.url ? Wb.thumbs.mediaHTML(cur.url, { key: sKey, mediaAttrs: 'class="sthumb"' })
          : sh.firstFrame ? Wb.thumbs.mediaHTML(sh.firstFrame, { type: 'image', key: sKey, mediaAttrs: 'class="sthumb" loading="lazy"' })
          : `<div class="sthumb empty"></div>`;
        // 状态：已选用 / 生成中（带进度）/ 排队中 / 创建中 / 待选用 / 生成失败 / 未生成 / 待写描述
        const st = shotStatusOf(sh);
        const runC = st.runC;
        const statusTxt = st.html;
        const prog = runC ? Math.max(0, Math.min(100, Number(runC.progress) || 0)) : 0;
        const pbarHTML = runC ? `<span class="pbar"><i style="width:${prog}%"></i></span>` : '';
        const durTxt = shotDur(sh) ? ' · ' + fmtDur(shotDur(sh)) : '';   // 还没出片就不写「未生成」，避免「生成中 · 未生成」
        it.innerHTML = `<span class="num">${String(n).padStart(2, '0')}</span>
          <div class="sthumb-wrap">${thumb}${pbarHTML}</div>
          <div class="sinfo"><div class="sname">${esc(sh.name)}</div>
          <div class="smeta">${statusTxt}${durTxt}</div></div>`
          /* 抓手 / 复制 / 删除是生成态那三件（改的是分镜表，不是成片）。剪辑态这一列是**看**成片
             的镜头清单，点一行只做「切镜 / 跳针」，这三颗整个不画 ——
             以前它们悬停才浮出来，剪的时候一不留神就复制了一镜或删掉了一段。 */
          + (midEditTrim ? '' : `<div class="ops">
            <button class="op-btn grip" title="按住拖动排序">${icon('grip', 12)}</button>
            <button class="op-btn dup" title="复制镜头">${icon('copy', 12)}</button>
            <button class="op-btn del danger" title="删除镜头">${TRASH_SVG}</button>
          </div>`);
        /* 收养旧的那一格缩略图，条件只有「它显示的就是这一镜此刻选用的那一份素材」——
           按**缩略图身份**认，不按镜头认：换了选用的候选，旧格子里是另一条视频的首帧，
           留着它界面就在替用户说一件假话（卡片上播着的画面 ≠ 这一镜现在选的那一条）。
           整块 `.sthumb-wrap` 一起换（不能只换里面的媒体）：`Wb.thumbs._bindings` 是以 wrap 为键的，
           只换媒体节点会让绑定指向一个已经不在文档里的旧节点。
           进度条挂在 wrap 里面，所以收养之后要按这一轮的账重贴一次。 */
        const kept = keepWrap.get(String(sh.id));
        const keptMedia = kept && kept.querySelector('.sthumb');
        if (kept && keptMedia && keptMedia.getAttribute('data-thumb-key') === sKey) {
          it.querySelector('.sthumb-wrap').replaceWith(kept);
          const oldBar = kept.querySelector('.pbar');
          if (oldBar) oldBar.remove();
          if (pbarHTML) kept.insertAdjacentHTML('beforeend', pbarHTML);
          Wb.thumbs.bind(kept, keptMedia, rawSrc);
        } else Wb.thumbs.bind(it.querySelector('.sthumb-wrap'), it.querySelector('.sthumb'), rawSrc);
        /* 点一行：生成态 = 换看哪一镜（老样子，一字不改）；
           剪辑态 = 剪辑针跳到那一镜在成片里的位置（`leftShotPick`）。 */
        it.onclick = () => {
          if (!midEditTrim) { projOf().curScene = si; projOf().curShot = xi; renderAll(); return; }
          leftShotPick(sc, sh, xi);
        };
        /* 抓手 / 复制 / 删除这一族只挂在生成态上：剪辑态那一列是看成片的清单，
           改的是分镜表（排序 / 复制 / 删除），与「剪」不是一件事 —— 上一段已经把这三颗
           整个不画了，这里的处理器也跟着不绑（画出来但点不动是最坏的一种）。 */
        if (!midEditTrim) {
          const grip = it.querySelector('.grip');
          grip.addEventListener('mousedown', () => { it.draggable = true; });
          it.addEventListener('dragend', () => {
            it.draggable = false;
            it.classList.remove('dragging');
            document.querySelectorAll('.shot-item.drag-over').forEach(x => x.classList.remove('drag-over'));
          });
          it.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', `shot:${si}:${xi}`);
            e.dataTransfer.effectAllowed = 'move';
            document.querySelectorAll('.shot-item.dragging').forEach(x => x.classList.remove('dragging'));
            it.classList.add('dragging');
          });
          it.addEventListener('dragover', e => {
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            if (!it.classList.contains('dragging')) it.classList.add('drag-over');
          });
          it.addEventListener('dragleave', () => it.classList.remove('drag-over'));
          it.addEventListener('drop', e => {
            e.preventDefault(); e.stopPropagation();
            const d2 = e.dataTransfer.getData('text/plain');
            if (!d2.startsWith('shot:')) return;
            const [ , fsi, fxi ] = d2.split(':').map(Number);
            if (fsi === si && fxi === xi) return;
            const moved = projOf().scenes[fsi].shots.splice(fxi, 1)[0];
            /* 目标下标要按「源已被移走之后的数组」来算：同一个场景里往后拖时，splice(fxi,1) 已经把
               后面那些整体前移了一格，再拿原来的下标插入，落点就比用户放的位置多走一格
               （表现为「拖到第 3 个位置却落到第 4 个」）。 */
            const at = (fsi === si && fxi < xi) ? xi - 1 : xi;
            sc.shots.splice(at, 0, moved);
            projOf().curScene = si; projOf().curShot = at;
            renderAll(); scheduleSave();
          });
          it.querySelector('.dup').onclick = e => {
            e.stopPropagation();
            const copy = JSON.parse(JSON.stringify(sh));
            copy.id = uid(); copy.name = sh.name + ' 副本'; copy.candidates = []; copy.selId = null;
            copy.candidates.push(mkDraftCandidate(copy));
            sc.shots.splice(xi + 1, 0, copy);
            renderAll(); scheduleSave();
          };
          it.querySelector('.del').onclick = e => {
            e.stopPropagation();
            /* 后果只说与这一次删除直接相关的三条：这一镜已被选用 → 成片会少一段；
               这一镜里还有别的生成结果 → 那些会一起没；删的是最后一个镜头 → 场景也没了。 */
            const notes = [];
            if (sh.selId) notes.push('这一镜已经被选用：删掉之后成片会少这一段');
            const nc = (sh.candidates || []).filter(c => c.status !== 'draft').length;
            if (nc > 1) notes.push('这一镜里还有 ' + (nc - 1) + ' 条生成结果，会一起删掉');
            if (sc.shots.length === 1) notes.push('这是最后一个镜头：删掉之后这个场景也会一起没');
            Confirm.arm(e.currentTarget, '确认删除？', notes.length ? { note: notes.join(' · ') } : null)
              || (() => {
            removeShot(sc, sh);
            renderAll(); scheduleSave();
            })();
          };
        }
        blk.appendChild(it);
      });
      box.appendChild(blk);
    });
  });
  $('scCount').textContent = n;
  updateProjUI();
}

/* 剪辑态左栏点一镜：**播放头跳到那一镜在成片里的对应位置**（用户点名）。
   成片秒是派生几何（`deriveTimeline` 一处），这里只问它，不自己折算 ——
   折算是第二本账，播放头与格子迟早对不上。
   剪辑态只有成片那一排：点一行 = 把播放头放到那一镜在成片里的起点，没有第二种落点。 */
function leftShotPick(sc, sh, xi) {
  projOf().curScene = projOf().scenes.indexOf(sc);
  projOf().curShot = xi;
  /* 切过去之后右栏与候选条指着的是这一镜**选用**的那一条（不是上一镜的那条）。 */
  const c = chosenCandOf(sh);
  if (c) {
    const ci = (sh.candidates || []).findIndex(x => x.vid === c.vid);
    if (ci >= 0) projOf().curCand = ci;
  }
  if (inCutMode()) {
    const row = deriveTimeline(ensureFilm().clips || []).rows.find(r => (r.clip || {}).shotId === sh.id);
    if (!row) { setStatus('这一镜还没进成片：先在生成态给它点「选用」'); renderAll(); return; }
    Timeline.seekTo(num(row.start), { follow: true });
    return;
  }
  /* 不在剪辑态（顺序 / 生成）：点左栏就是**换看哪一镜**，没有轨道也就没有针要放 ——
     进剪辑态时那一排的针由几何现算（`filmPinInfo`），落在当前那一镜上。 */
  renderAll();
}

/* 剪辑态左栏底部那一块：**历史编辑记录**。
   历史是一条**只追加的操作日志**：最新的一条在最上，**一条都不删**（回退也留痕）。
   「当前生效」的那一条用一枚标记点亮（指针）；点任意一行 = 回退到那一行那一版的状态，
   回退会在末尾追一条「回退到「xxx」」—— 于是所有记录始终可见、干过什么全查得到。
   被上限挤掉的最老那几条照实不显示（空态那句话把两档上限说清）。
   这一块做成**折叠区**（原生 details，默认收起）：它平时只是「有没有可退的步骤」这一句，
   展开才是一列记录 —— 以前它占掉左栏整列，剪的时候连分镜列表都看不见了。
   「导入视频 / 素材」已经挪到左栏表头（项目级动作），这里不再重复一个入口。 */
/* 折叠区的开合存在模块里：这一栏每轮轮询整片重画，`<details>` 是每次新造的节点 ——
   不留这一份账，用户正展开看历史时一次刷新就把它弹回收起。 */
let elHistOpen = false;
function renderEditLeft(box) {
  const rows = [];
  /* 倒序画（最新在最上）：日志本身是正的、只追加。 */
  for (let i = historyLog.length - 1; i >= 0; i--) {
    const e = historyLog[i];
    const isNow = i === historyCursorOf();
    const kindTxt = e.kind === 'rollback' ? '回退' : e.kind === 'redo' ? '重做' : '编辑';
    rows.push('<button type="button" class="hist-row' + (isNow ? ' now' : '') + (e.kind !== 'edit' ? ' mark' : '') + '"'
      + ' data-hist-i="' + i + '"'
      + ' title="' + esc(kindTxt + ' · ' + window.fmtHM(e.at) + '：' + e.label)
      + (isNow ? '（现在生效的就是这一版）' : '（点一下回退到这一版）') + '">'
      + '<span class="hk">' + esc(kindTxt) + '</span>'
      + '<span class="hn">' + esc(e.label) + '</span>'
      + '<span class="ht">' + window.fmtHM(e.at) + '</span></button>');
  }
  /* 重画罩在公共件里：这一栏自己滚（`#editLeft{overflow-y:auto}`），`innerHTML =` 把里面整片换掉
     就把滚动位清零 —— 而每一轮任务轮询都会重画它。折叠区的开合 `keep` 不管（那是节点上的属性，
     不是滚动位），所以它自己收进模块状态：`elHistOpen`。 */
  Wb.viewport.keep(box, () => {
    box.innerHTML = `
      <details class="el-hist"${elHistOpen ? ' open' : ''}>
        <summary><span class="hn">历史编辑记录</span><span class="n">${historyLog.length ? historyLog.length + ' 条 · ' + Math.max(0, historyCursorOf() + 1) + ' 步可退' : '还没有记录'}</span></summary>
        <div class="el-body">
          ${rows.length ? '<div class="hist-list">' + rows.join('') + '</div>'
            : '<div class="hist-empty">还没有记录</div>'}
        </div>
      </details>`;
    const det = box.querySelector('.el-hist');
    if (det) det.ontoggle = () => { elHistOpen = det.open; };
    box.querySelectorAll('[data-hist-i]').forEach(b => {
      b.onclick = () => {
        const i = Number(b.dataset.histI);
        if (!Number.isFinite(i) || i === historyCursorOf()) return;
        if (!historyGoTo(i, 'rollback', '回退到')) {
          setStatus('<span class="err">退不回去：这份快照没能恢复，工作区保持原样</span>');
          return;
        }
        setStatus('<span class="ok">✓ 已回退到「' + esc((historyLog[i] || {}).label || '那一步')
          + '」那一版</span>');
      };
    });
  });
}

/* ---------- 渲染：中栏 ---------- */
let midEditTrim = false;   // 剪辑模式（只有一条轨：成片那一排）
/* 剪辑态**只有一条轨**（用户点名：不再有「本镜 / 全片」两个页签），所以「是不是按成片那一套逻辑走」
   = 「剪辑模式开着没有」。这一枚判据只分**剪辑态 / 生成态**两档：生成态的播放器、左栏点一行、
   字幕叠层各有一套秒尺子，切了剪辑模式它们才换那一套。 */
const inCutMode = () => midEditTrim;
/* 打开 / 关掉剪辑模式只有一个出口：旗标 + 收甲板 + 中栏 + 右栏四件事必须一起做，漏一件就是
   「中栏已经换成轨道、右栏还停在镜头编辑器」或「甲板收掉了但后台还在解码发声」。
   页面里裸写 `midEditTrim = …` 的地方从此只有这一处。 */
function setTrimMode(on) {
  midEditTrim = !!on;
  /* 退出剪辑就收掉播放核：留着会在后台接着解码（声音也跟着响），
     而界面上已经没有它们的位置了。 */
  if (!midEditTrim) Play.dispose();
  /* 进剪辑态：播放头落到当前那一镜在成片里的起点（成片秒是派生几何，只问一处）。 */
  if (midEditTrim) {
    const sh0 = curShot();
    if (sh0) {
      const row = deriveTimeline(ensureFilm().clips || []).rows.find(r => (r.clip || {}).shotId === sh0.id);
      if (row) Timeline.seekTo(num(row.start), { follow: true });
    }
  }
  renderMid();
  /* 右栏同一次点完就要跟着换（用户点名的形状）：只调 renderMid 只换中栏，
     右栏还停在镜头编辑器上，看起来像「剪辑模式没打开」。
     左栏也要跟着换面（剪辑态 = 历史编辑记录 + 素材，renderScenes 里那一档）。 */
  renderEditor();
  renderScenes();
}
/* 连接点那一颗 ◇ 的唯一写口：转场挂在**左段**身上（进入下一段）。
   `live` 是拖动时长滑块那一刻（只刷新、不压撤销快照），松手那一下才定稿。 */
function transitionSet(index, patch, opts) {
  const film = ensureFilm();
  const left = film.clips[index], right = film.clips[index + 1];
  if (!left || !right) return false;
  const live = !!(opts && opts.live);
  const cur = left.transition || { id: 'none' };
  const next = normalizeTransition(Object.assign({}, cur, patch || {}), left, right);
  /* 历史里只说「第 N 段 → 第 M 段」读不出是谁：段序一变，那两个数就指向别的镜头了。
     同一句话既是留痕也是回执 —— 浮层里点一颗预设，页面上要说「改了哪两段之间」。 */
  const label = '把「' + filmClipName(left) + '」→「' + filmClipName(right) + '」之间的转场'
    + (next ? '设为 ' + transitionNameOf(next.id) + ' ' + next.duration + ' 秒' : '去掉');
  if (!live) beginEdit(label);
  if (next) left.transition = next; else delete left.transition;
  /* 拖动时长滑块时不重建那块板：浮层就在板里面，重建会把手指底下的 range 换掉。
     松手那一下走 filmEdited()，整块跟着重画。 */
  if (live) scheduleSaveQuiet();
  else { filmEdited(); setStatus(label); }
  return true;
}
/* 工具条上除缩放 / 吸附 / 波纹 / 标记条 / 选择工具之外那几颗的出口（Timeline 只报动作名）：
   撤销与重做动的是工程快照，播放动的是播放层，所以留在这边；
   删 / 复制 / 切开 / 合并 / 增删段 / 长短微调 / 关联族 / 标记面板全部交 Edit 域（它改 `proj.film`）。 */
function toolAction(act) {
  if (act === 'undo') return undo();
  if (act === 'redo') return redo();
  if (act === 'play') return Play.toggle();
  /* 回到播放头 = 把视口滚到播放头那一秒（播放头本身不动）。 */
  if (act === 'to-playhead') return Timeline.scrollToTime(Timeline.playhead(), 0.3);
  return Edit.toolAction(act);
}
/* 在某一秒加一枚标记（工具条那颗 flag 与快捷键 M 同一个出口）。 */
function addMarkerAt(time, type) {
  const film = ensureFilm();
  const t = Math.max(0, Number(time) || 0);
  const m = createMarker({ type: type || 'marker', time: t });
  beginEdit('在 ' + Wb.fmtClock(t) + ' 加了一枚标记');
  film.markers.push(m);
  film.markers.sort((a, b) => a.time - b.time);
  filmEdited();
  setStatus('<span class="ok">✓ 已在 ' + Wb.fmtClock(m.time) + ' 加一枚标记</span>');
  return m;
}
/* ---------------- 「这一镜的台词配过音没有」 ---------------- */
const lineTrim = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
/* 「同一句话」按去空白后比：台词末尾多一个空格不该让这一句重新变成未配音。 */
const lineSame = (a, b) => String(a == null ? '' : a).replace(/\s+/g, '').trim().toLowerCase()
  === String(b == null ? '' : b).replace(/\s+/g, '').trim().toLowerCase();
function lineVoicesOf(sh) {
  const text = lineTrim(sh && sh.line);
  if (!text) return [];
  return (ensureFilm().voices || []).filter(v => v && v.shotId === sh.id && lineSame(v.text, text));
}
const lineVoicedOf = sh => lineVoicesOf(sh).length > 0;
/* 把焦点切到那一镜、播放头落到这一句自己的块上、台词填进合成框、翻到「生成配音」。
   先画一版（字已经在了），素材库那边取字节回来再补画一次那两格 —— 一条人声可能几 MB，
   为了等它把整个点击拖住不动，用户会以为没点中。 */
function openLineVoice(sh) {
  if (!sh) return;
  const sc = projOf().scenes.find(s2 => s2.shots.includes(sh));
  if (sc) { projOf().curScene = projOf().scenes.indexOf(sc); projOf().curShot = sc.shots.indexOf(sh); }
  /* 落到这一镜的画面段起点：合成出来的那一句也该落在这儿。这一镜还没进成片时不动针。 */
  const row = deriveTimeline(ensureFilm().clips || []).rows.find(r => r && r.clip && r.clip.shotId === sh.id);
  if (row) Timeline.seekTo(Math.max(0, Number(row.start) || 0), { follow: true });
  const p = { text: lineTrim(sh.line), who: lineTrim(sh.lineWho) };
  /* 草稿先认主（shotId），再填内容 —— 右栏配音那一栏只清「别人的」草稿。 */
  voiceDraftOf().shotId = sh.id;
  /* 换了一句台词就把上一句的音色草稿清掉（同一句重复点则留着用户手改过的那一份）：
     上一句的参考音频要是留在这一格里，合成出来会是另一个人的声音，而且真扣费。 */
  const sameText = voiceDraftOf().text === p.text;
  if (!sameText) { voiceDraftOf().design = ''; voiceDraftOf().ref = null; }
  voiceDraftOf().text = p.text;
  voiceDraftOf().who = p.who;
  setVcTab('voice');
  renderAll();
  /* 焦点 / 播放头 / 草稿都是视图状态（不进工程快照）：静默落盘即可，
     别在历史里压一步「点了一下台词行」。 */
  scheduleSaveQuiet();
  prefillVoiceWho(p.who, { keep: sameText, shot: sh }).then(note => {
    if (curShot() !== sh) return;
    renderEditor();
    if (note) setStatus('<span class="meta">' + esc(note) + '</span>');
  }).catch(() => {});
}
/* 按说话人去素材库找料：音色设计取那位的 `voiceNote`，音色复刻取那段参考音频的字节。
   找不到人 / 那一位没写描述 / 没挂音频时**一个字都不写**（仍可手挑），但要把原因说出来 ——
   「点了占位符，参考那一格却还空着」必须有一句话解释，否则看着像页面没接上。
   返回的是给人看的那句话（调用方决定往哪儿放），不在这里弹提示。 */
async function prefillVoiceWho(who, opt) {
  const way = voiceWayOf(voiceReg(), projOf().voiceModel || '');
  /* 同一句台词重复点占位符：那一格已经有用户手挑的音色（描述 / 参考音频）就不再用素材库那份盖掉。
     只有「换了一句」才重新按说话人预填。 */
  if (opt && opt.keep) {
    if (way.mode === 'design' && String(voiceDraftOf().design || '').trim()) return '';
    if (way.mode === 'clone' && voiceDraftOf().ref) return '';
  }
  /* 找谁、读音色描述还是取参考音频字节，全在 `Chars.Pipe.voicePrefillOf` 那一份里：
     库里那一列叫什么不出 web/domain/chars.js，这里只认它交回来的 note / blob / why。 */
  const pick = await Chars.Pipe.voicePrefillOf(who, way.mode);
  /* await 回来时用户可能已经切到另一镜：草稿只属于当前那一镜（shotId），
     慢回来的音色料写进别人的草稿 = B 镜合成出来是 A 镜说话人的声音，而且真扣费。 */
  if (opt && opt.shot && voiceDraftOf().shotId !== opt.shot.id) return '';
  if (!pick.found) return pick.why;
  if (pick.why) return pick.why;
  if (way.mode === 'design') {
    voiceDraftOf().design = pick.note;
    return '已按素材库「' + pick.name + '」的音色描述填进「声音描述」';
  }
  if (way.mode === 'clone') {
    voiceDraftOf().ref = { assetId: '', src: '', name: pick.refName || pick.name, file: pick.blob };
    return '已把素材库「' + pick.name + '」的参考音频填进「音色素材」';
  }
  return '这一档是预设音色：台词里的说话人「' + pick.name + '」不参与选音色，音色请在下拉里手挑';
}
/* 当前查看的是不是「空占位」候选（已新增、还没生成） */
function curDraftCand() {
  const sh = curShot();
  const c = sh && (sh.candidates || [])[projOf().curCand];
  return (c && c.status === 'draft') ? c : null;
}

  /* 这两枚是模块自己的可变状态；engine 那边只读，所以出去的是取值函数而不是值本身。 */
  function midCandExpandOf() { return midCandExpand; }
  function midEditTrimOf() { return midEditTrim; }

  return {
    addMarkerAt,
    bindCandActs,
    bindCandidateStrip,
    bindPbFull,
    candActsHTML,
    candAddTile,
    candPlaceholder,
    candThumbInner,
    curDraftCand,
    debounce,
    feedScenePics,
    fullscreenHold,
    generateCandidate,
    healStaleUrls,
    hydrateThumbFrames,
    lineVoicedOf,
    lineVoicesOf,
    midCandExpandOf,
    midEditTrimOf,
    openLineVoice,
    pbBarHTML,
    placeScenesInto,
    playerAreaHTML,
    playerMediaOf,
    provById,
    removeShot,
    renderEditLeft,
    renderScenes,
    renderScenesSoon,
    reportScenePics,
    saveScheduleSoft,
    scrollCurThumbIntoView,
    selectCandidate,
    setTrimMode,
    shotStatusOf,
    sortCandidates,
    toolAction,
    transitionSet,
    updateMidLive,
  };
}
