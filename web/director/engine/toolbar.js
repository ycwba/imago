/* 导演台工具栏事件域：左栏「加场景」、剧本查看 / 改稿（按分镜现算、写回只落 sh.prompt）、
   手动拆分弹窗与 AI 拆分入口这几颗按钮的接线。区间内的代码由 engine.js 逐字搬出；
   proj / REG 是 engine 继续持有的可变状态，走访问器，document / window 用参数名遮蔽全局。 */

import { scriptTextOf, parseScript, applyScript } from '../script.js';

export function createToolbar(E, document, window) {
  'use strict';
  const {
    $,
    REGOf,
    aiStoryboard,
    allShots,
    beginEdit,
    feedScenePics,
    filmEdited,
    newShot,
    placeScenesInto,
    projOf,
    renderAll,
    reportScenePics,
    scheduleSave,
    setStatus,
    uid,
  } = E;

/* ---------- 工具栏事件 ---------- */
$('addScene').onclick = () => {
  const sc = { id: uid(), name: `场景 ${projOf().scenes.length + 1}`, shots: [newShot()] };
  projOf().scenes.push(sc); projOf().curScene = projOf().scenes.length - 1; projOf().curShot = 0;
  reportScenePics(feedScenePics(sc, sc.shots));   // 场景名恰好对得上素材库那条场景时，第一个镜头就带上它的图
  renderAll(); scheduleSave();
};
/* 「剧本」这一档不是第二份数据：打开时按当前分镜现算（scriptTextOf），保存时只把解析结果写回
   `sh.prompt`（applyScript）。稿子里只有画面那一项 —— 台词另有自己的面板（剪辑右栏「台词」那一档），
   一份稿子同时握着画面与台词，改画面就会连着改台词，那是两件事。 */
function editScript() {
  if (!allShots().length) {
    setStatus('<span class="err">还没有镜头：先在左侧加一场，或用「拆分镜」写一份分镜</span>');
    return;
  }
  let ta = null, errEl = null;
  UiDialog.open({
    id: 'scriptEditDlg',
    title: '剧本',
    sub: '逐镜一段「画面」；台词在剪辑右栏「台词」那一档改。',
    body(el) {
      el.innerHTML = '<textarea class="ui-ta" spellcheck="false" aria-label="剧本正文"'
        + ' style="height:min(58vh,560px);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size: var(--fs-13);line-height:1.65"></textarea>'
        + '<div role="alert" style="display:none;color:var(--err);font-size: var(--fs-12);line-height:1.6;margin-top: var(--sp-8)"></div>';
      ta = el.querySelector('textarea');
      errEl = el.querySelector('[role="alert"]');
      ta.value = scriptTextOf(projOf().scenes);
    },
    actions: [
      { label: '取消', value: null },
      { label: '保存', primary: true, onClick() {
        const parsed = parseScript(ta.value);
        if (!parsed.blocks.length) {
          errEl.style.display = '';
          errEl.textContent = '没认出任何「## 镜头 N」：请保留每段的镜头标题，只改它下面那段「画面：」。';
          return false;
        }
        /* 先在镜头副本上试跑一次：一个字都没变时不该压一份撤销快照、也不该让撤销键凭空多一步。 */
        const probe = applyScript(projOf().scenes.map(sc => ({ ...sc, shots: (sc.shots || []).map(sh => ({ ...sh })) })), parsed);
        if (!probe.upd) {
          setStatus(probe.skipped ? '剧本里没有可写入的改动（' + probe.skipped + ' 个镜头号对不上）' : '剧本没有改动');
          return;
        }
        beginEdit('改剧本');
        const r = applyScript(projOf().scenes, parsed);
        filmEdited();
        setStatus('<span class="ok">✓ 剧本已写回分镜：画面 ' + r.promptUpd + ' 处'
          + (r.skipped ? '；' + r.skipped + ' 个镜头号对不上，已跳过' : '') + '</span>');
        if (r.skipped) Toast.warn(r.skipped + ' 个镜头号在分镜里不存在，那几段没有写入');
      } },
    ],
  });
}
$('scriptEditBtn').onclick = editScript;
/* 「导入视频 / 素材」的唯一入口在中栏动作行（`#importMid`，由 engine/mid.js 每轮重建时绑回来）；
   同一个函数只有这一个入口 —— 以前左栏表头一颗、中栏一颗，用户点名过位置乱。 */
$('scriptBtn').onclick = async () => {
  // 升级：优先走 AI 拆分场景与镜头；没配文字 AI 时回退到原来的手动拆分
  try {
    if (await TextAI.canRun(REGOf())) { aiStoryboard(); return; }
  } catch { /* 问不动文字 AI 就当没配，回退到手动拆分 */ }
  setStatus('未配置文字 AI 密钥，改用「手动拆分」：每行一个镜头，# 开头为场景名');
  $('scriptDlg').showModal();
};
$('scriptCancel').onclick = () => $('scriptDlg').close();
$('scriptOk').onclick = () => {
  const text = $('scriptText').value.trim();
  if (!text) return $('scriptDlg').close();
  /* 一行 `#` 就是**换场**：以前每个 `#` 都只是给同一个场景改名（后面的盖掉前面的），
     粘三段场景进去出来还是一整场，而界面那句话写的是「# 开头为场景名」——
     说的话与做的事不是同一件。 */
  const out = [];
  let sc = { id: uid(), name: '剧本分镜', shots: [] };
  out.push(sc);
  text.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    if (line.startsWith('#')) {
      const nm = line.slice(1).trim();
      /* 这一场还一个镜头都没有 → 给它改名，不再另起一场（粘贴内容第一行就是 `#` 时，
         否则会留一个空的「剧本分镜」排在最前面）。 */
      if (!sc.shots.length) { sc.name = nm || sc.name; return; }
      sc = { id: uid(), name: nm || '剧本分镜', shots: [] }; out.push(sc); return;
    }
    sc.shots.push(newShot(line));
  });
  const filled = out.filter(x => x.shots.length);
  /* 落点与「AI 分镜 → 追加」同一份判据（placeScenesInto）：同名（归一之后）的并进已有那一场，
     对不上号的才新建 —— 手动粘两遍同一个场景名不该出现两个「河岸」。 */
  const nShots = filled.reduce((a, x) => a + x.shots.length, 0);
  const r0 = placeScenesInto(projOf().scenes, filled);
  if (filled.length) { projOf().curScene = r0.at; projOf().curShot = 0; }
  renderAll(); scheduleSave(); $('scriptDlg').close();
  reportScenePics(r0.pics, '已写入 ' + filled.length + ' 个场景 / ' + nShots + ' 个镜头'
    + (r0.merged ? '（其中 ' + r0.merged + ' 个并进了同名场景）' : ''));
};

  return {
  };
}
