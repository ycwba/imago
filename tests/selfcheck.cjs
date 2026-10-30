#!/usr/bin/env node
/* 常驻自检（Vue SPA 版）—— 跑法：`node tests/selfcheck.cjs`
 *
 * 2026-10-18：六个页面已迁到 Vue，旧的 `tests/selfcheck.cjs` / `tests/mutation.cjs`
 * 盯的是那些已经删除的旧 HTML，留着只会永远报「文件不存在」。这一版守的是新架构：
 *   ① 外壳 / 路由 / KeepAlive 页面池（交给 tests/spa.cjs 的 63 条判据）；
 *   ② 每个 Vue 页面只碰自己的 DOM、只引本地 Vue、不直连外部；
 *   ③ 旧页面确实不在了，旧地址由代理 302 到外壳（不是 404）；
 *   ④ 共享层（web/ui/ui.js / web/ui/forms.js / web/domain/api.js / web/domain/assetlib.js /
 *      web/domain/gen-forms.js / web/ui/workbench.js / web/domain/chars.js / web/domain/ident.js）仍在，而且
 *      没有被某个页面复制出一份同名实现（只在能静态判定的范围里查）。
 *
 * 行为层（点得动、切页不 reload、状态保留）由 headless 冒烟与临时探针负责；
 * 这里不做「文件里出现某个词就算过」的空断言 —— 每一条都要有可数的落点。
 */
const fs = require('fs');
const path = require('path');
const S = require('./support.cjs');            // 数「代码里真有几条」时要先剥注释（那条事件契约判据）

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
/* 导演台 engine 层 = engine.js（状态与接线）+ engine/<域>.js（按域搬出去的函数）。
   钉「这一层只有一份实现」的判据读这一份：函数搬进域模块还是同一层代码，判据跟着代码走。 */
const EL = S.engineLayer();
let bad = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + name); return true; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
  return false;
}
function group(t) { console.log('\n' + t); }

/* ---------- 1. SPA 架构判据的落点 ----------
   旧版这里同步 spawnSync 跑 tests/spa.cjs（另外再跑一遍 local-first.cjs）：
   两条子进程启动 + 与 all.cjs 里独立判据的**重复求值**，正是 selfcheck 3.8s 的慢点本体。
   现在 spa.cjs / local-first.cjs 都只作为 all.cjs 并发池里的独立判据各跑一次，
   本文件不再代跑、也不再垫「全绿」那句包装判据 —— 它们红，池子就红，退出码照样拦。
   （map.cjs 的 DELEGATED 表同步清空；挑中 selfcheck 的改动会把 spa 一并拉进清单。） */
group('§1 SPA 架构判据由 tests/spa.cjs 独立跑（本文件不代跑，见文件头注释）');
{
  /* 代跑删掉之后，「独立判据还在不在常驻段」就得有人盯 —— 谁把登记也顺手弄丢，这条会红。 */
  const allSrc = read('tests/all.cjs');
  const at = allSrc.search(/if\s*\(process\.argv\.includes\('--e2e'\)/);
  ok('spa.cjs 仍登记在 all.cjs 常驻段（不再由 selfcheck 代跑）', /run\('tests\/spa\.cjs'/.test(allSrc.slice(0, at)));
}

/* ---------- 2. 旧页面已经删除，旧地址仍有出路 ---------- */
group('§2 旧页面退场');
const GONE = ['director.html', 'favorites.html', 'usage.html', 'assets.html', 'settings.html', 'chars.html', 'studio.html'];
for (const f of GONE) ok(f + ' 已删除', !fs.existsSync(path.join(root, f)));
const proxy = read('server/app.js') + read('server/routes/static.js') + read('server/routes/local-assets.js');
const routesSrc2 = read('web/core/routes.js');
/* 2026-10-25 起服务端的 302 表从客户端路由表**现派生**（server/routes/static.js 的 deriveSpaRedirect，
   「路由表只有 web/core/routes.js 一份」）—— 静态源码里不再有那张字面量表，这里改查两端：
   static.js 还在派生（而不是又抄了一份回去），routes.js 的 pages / alias 里点得到这些地址。 */
ok('代理的 302 表从客户端路由表现派生', /deriveSpaRedirect/.test(proxy) && /WB_ROUTES/.test(proxy));
for (const f of ['/favorites.html', '/usage.html', '/assets.html', '/settings.html', '/chars.html', '/studio.html', '/roles.html', '/video.html', '/image.html', '/audio.html']) {
  ok('代理给旧地址 ' + f + ' 留了重定向', routesSrc2.includes("'" + f.slice(1) + "'"));
}
ok('重定向到 shell.html 的 hash', /Location:\s*'\/shell\.html#'/.test(proxy));
const redirAt = proxy.indexOf('SPA_REDIRECT[');
ok('旧地址重定向不缓存', redirAt >= 0 && /no-store/.test(proxy.slice(redirAt, redirAt + 1200)));

/* ---------- 3. 每个 Vue 页面只碰自己的 DOM ---------- */
group('§3 Vue 页面边界');
const pagesDir = path.join(root, 'web/pages');
const comps = fs.readdirSync(pagesDir).filter(f => /\.js$/.test(f)).map(f => 'web/pages/' + f);
comps.push('web/director/index.js');
ok('六个页面都已迁到 Vue', comps.length >= 7, String(comps.length));
const LOCAL_VUE = /from\s+'(?:\.\.\/\.\.\/|\.\/)vue\.runtime\.esm-browser\.prod\.js'/;
const routesSrc = read('web/core/routes.js');
const EXTERNAL_FETCH = /\b(?:fetch|import|src|href)\s*\(?\s*['"]https?:\/\//i;
for (const f of comps) {
  const src = read(f);
  const base = path.basename(f).replace(/\.js$/, '');
  const page = (base === 'index' ? 'director' : base) + '.html';
  ok(f + ' 引本地 Vue', LOCAL_VUE.test(src));
  ok(f + ' 有 export default', /export\s+default\b/.test(src));
  ok(f + ' 不直连外部', !EXTERNAL_FETCH.test(src));
  ok(f + ' 不用 document.getElementById', !/document\.getElementById\s*\(/.test(src));
  /* 组件登记在路由表那一条上（src 指向它），外壳按表现搭 VIEWS —— 不再要求 app.js 里出现文件名 */
  ok(f + ' 已登记 ' + page, routesSrc.includes("file: '" + page + "'") && routesSrc.includes("src: './" + f.replace(/^web\//, "") + "'"));
}

/* ---------- 4. 共享层与外壳接线 ---------- */
group('§4 共享层与外壳');
for (const f of ['web/ui/ui.js', 'web/ui/forms.js', 'web/ui/net.js', 'web/ui/datasync.js', 'web/ui/store.js', 'web/ui/kv.js', 'web/ui/toast.js', 'web/domain/api.js', 'web/domain/assetlib.js', 'web/domain/gen-forms.js', 'web/domain/asset-transfer.js', 'web/domain/local.js', 'web/domain/capabilities.js', 'web/domain/text-ai.js', 'web/domain/fav.js', 'web/domain/prompt-log.js', 'web/domain/asset-picker.js', 'web/domain/ai-find.js', 'web/ui/workbench.js', 'web/domain/chars.js', 'web/domain/ident.cjs', 'web/core/routes.js', 'web/core/bridges.js', 'web/shell-boot.js', 'web/boot-assistant.js', 'web/app.js', 'shell.html', 'web/director/index.js', 'web/director/engine.js', 'web/director/fcpxml.js', 'web/director/util.js', 'web/director/board.js', 'web/director/split-assets.js', 'web/director/slice.js', 'web/director/film.js', 'web/director/srt.js', 'web/director/naming.js', 'web/director/tl-scale.js', 'web/director/tl-cut.js', 'web/director/tl-resize.js', 'web/director/tl-ripple.js', 'web/director/tl-reorder.js', 'web/director/tl-snap.js', 'web/director/tl-peaks.js', 'web/director/tl-filmstrip.js', 'web/director/tl-markers.js', 'web/director/tl-autoscroll.js', 'web/core/page-context.js', 'web/core/report.js', 'web/domain/semantic.js']) {
  ok(f + ' 仍在', fs.existsSync(path.join(root, f)));
}
const shell = read('shell.html');
ok('shell 不再加载 app.js', !/<script[^>]+src="app\.js"/.test(shell));
ok('shell 不再有 iframe 标记', !/<iframe\b/i.test(shell));
ok('导演台模板与引擎各一份', fs.existsSync(path.join(root, 'web/director/template.html'))
  && /export\s+function\s+mount\s*\(/.test(read('web/director/engine.js')));
ok('导演台不再用 new Function 执行字符串', !/new Function\s*\(/.test(read('web/director/index.js')));
ok('导演台没有 iframe 兜底', !/<iframe\b/i.test(read('web/director/index.js')));
const batBuf = fs.readFileSync(path.join(root, '启动.bat'));
const batTxt = batBuf.toString('utf8');
ok('启动.bat 是 UTF-8 + chcp 65001，并带干跑自检口',
  !(batBuf[0] === 0xEF && batBuf[1] === 0xBB && batBuf[2] === 0xBF)
  && /chcp\s+65001/i.test(batTxt) && /WB_LAUNCHER_DRYRUN/.test(batTxt) && /拾帧/.test(batTxt));
const psBuf = fs.readFileSync(path.join(root, 'launcher.ps1'));
const psTxt = psBuf.toString('utf8');
ok('launcher.ps1 是 UTF-8 带 BOM + CRLF',
  psBuf[0] === 0xEF && psBuf[1] === 0xBB && psBuf[2] === 0xBF && psTxt.includes('\r\n'));
ok('页面清单只有 spa-routes 一份（sidebar 不再写死）',
  !/const\s+items\s*=\s*\[/.test(read('web/ui/sidebar.js')));
const core = read('web/app.js');
ok('KeepAlive 承载已迁移页面', /KeepAlive/.test(read('web/render/app-shell.js')) && /PageFrame/.test(core));
ok('页面池切页不改 iframe.src', !/\.src\s*=\s*route\.src/.test(core));
ok('有页面可见性事件', /spa:page/.test(core));
ok('有站内换页事件（pushState 不发 hashchange）', /spa:navigate/.test(core));
ok('切页前记录滚动位置', /spa:before-leave/.test(core));
ok('每个页面都有助手只读快照', ['director.html','studio.html','chars.html','assets.html','settings.html','usage.html','favorites.html']
  .every(f => read('web/core/page-context.js').includes("'" + f + "'")) && /__acPageCtx/.test(read('web/core/page-context.js')));
ok('助手在 compose 里自动带当前界面', /【当前界面/.test(read('web/features/chat.js')) && /hostCtx\(\)/.test(read('web/features/chat.js')));
ok('助手有本地语义检索工具', /find\s*:\s*\{/.test(read('web/features/chat-tools.js')) && /SemanticSearch/.test(read('web/features/chat-tools.js')));
ok('语义检索模块有 rank', /SemanticSearch\s*=\s*\{\s*norm/.test(read('web/domain/semantic.js')) && /function\s+rank/.test(read('web/domain/semantic.js')));
ok('切片缓存用稳定键 / 失败 TTL / 同图不重绘', /function\s+sliceKey/.test(EL)
  && /SLICE_FAIL_TTL/.test(EL) && /__stripSig/.test(EL));
ok('本机/云端标识有开关', /sk_media_badge/.test(read('web/ui/ui.js')) && /showBadge/.test(read('web/domain/local.js')));
ok('Vue 页面可交未保存状态', /__spaRegister\s*=/.test(core) && /hooks\.runAll\(\)/.test(core)
  && /window\.__spaFlush/.test(read('web/director/engine.js')) && /window\.__spaDirty/.test(read('web/pages/settings.js')));

/* ---------- 5. 关键机制仍只有一份 ---------- */
group('§5 唯一实现');
const all = comps.map(read).join('\n');
ok('页面不自己写 Toast / Confirm 外壳', !/class\s+="pr-mask"/.test(all));
ok('页面不自己拼分页文案', !/第\s*['"]?\s*\+\s*\(cur/.test(all));
ok('页面不自己写字节单位表', !/\['B',\s*'KB',\s*'MB'/.test(all));
ok('页面不自己写缩略图缓存键', !/function\s+thumbKeyOf|function\s+mediaKeyOf/.test(all));
ok('共享层里仍有 AssetLocal / AiFind / Chips / AdvExtras 的唯一实现',
  ['window.AssetLocal', 'window.AiFind', 'window.Chips', 'window.AdvExtras'].every(k => read('web/domain/assetlib.js').includes(k) || read('web/domain/gen-forms.js').includes(k) || read('web/domain/local.js').includes(k) || read('web/domain/ai-find.js').includes(k) || read('web/ui/ui.js').includes(k)));

/* ---------- 5b. 「让 AI 干一件事」那一族按钮：外壳与名字各只有一份 ----------
   同一件事在各处叫不同名字、各配一副外壳，用户按上一处记住的名字就找不到下一颗按钮 ——
   这一族收口的结果由下面几条钉住：外壳只在 ui.js、名字只在各自家族的那一处、
   忙与闲只换那一行字。旧的写法（页面自己拼 innerHTML、自己改 textContent）不再出现。 */
group('§5b AI 动作按钮只有一份画法');
{
  const tplDir = path.join(root, 'tools/vue-templates');
  /* 判据扫的是「人写的界面源码」：web/ 下的 js（不含生成物与 vendor，webSources 已经排掉）
     + 模板源 + 导演台那份 .html（walk 只收 js，这一份要单独点名）。 */
  const uiSrc = S.webSources().map(p => S.asRel(p)).map(read)
    .concat(fs.readdirSync(tplDir).filter(f => /\.html$/.test(f)).map(f => read('tools/vue-templates/' + f)))
    .concat([read('web/director/template.html')]);
  const join = uiSrc.join('\n');
  const ui = read('web/ui/ui.js');
  /* 定义处（ui.js 的 aiBtnHTML 本体）当然写着这一副外壳，扫描时把它排掉。 */
  const notUi = uiSrc.filter(s => s !== ui);
  ok('AI 动作按钮的外壳只有 ui.js 的 aiBtnHTML 一份（.tool.acc + .ic sparkles 14 + .tx）',
    /window\.aiBtnHTML\s*=\s*function/.test(ui) && /window\.aiBtnState\s*=\s*function/.test(ui)
    && !notUi.some(s => /class="tool acc[^"]*"[^>]*>[\s\S]{0,400}?icon\('sparkles'/.test(s)));
  ok('忙与闲只经 aiBtnState 切（没有哪一处再重写整副 innerHTML 或裸 textContent）',
    !/AiFind\.(busy|idle)\(/.test(join) && !/\b(aiBusy|aiIdle)\b/.test(join)
    && uiSrc.filter(s => /window\.aiBtnState\(/.test(s)).length >= 4);
  ok('「AI 搜索」那句名字只写在 AiFind.LABEL 一处',
    /LABEL:\s*'AI 搜索'/.test(read('web/domain/ai-find.js'))
    && uiSrc.filter(s => /['"]AI 搜索['"]/.test(s)).length === 1);
  ok('「AI 润色」那颗按钮只由 InlinePolish.btnHTML 画（作用域只进说明句）',
    /label:\s*'AI 润色'/.test(read('web/ui/forms.js'))
    && uiSrc.filter(s => /['"]AI 润色['"]/.test(s)).length === 1);
  /* 曾经叫过的名字不再回来：这几句一旦出现在源码里，就说明某处又开始自己拼按钮了。 */
  const GONE = ['AI 检索', '检索中…', 'AI 正在理解检索需求', 'AI 润色这一句', 'class="polish"'];
  ok('旧的按钮名字与那副自写外壳不再出现', !GONE.some(t => join.includes(t)),
    GONE.filter(t => join.includes(t)).join(' / '));
  ok('AI 回执写在列表重画之后（异步 render 不会把它覆盖成「N 项」）',
    /await oo\.done\(\)/.test(read('web/domain/ai-find.js'))
    && /done: \(\) => \{ resetPaging\(\); return render\(\); \}/.test(read('web/pages/chars.js'))
    && /done: \(\) => \{ resetPaging\(\); return render\(\); \}/.test(read('web/pages/favorites.js')));
  ok('AI 搜索那颗与搜索框同壳（.fb-ai），画法只在 AiFind.btnHTML 一处',
    /class="fb-ai"/.test(read('web/domain/ai-find.js'))
    && uiSrc.filter(s => /class="fb-ai"/.test(s)).length === 1);
  ok('搜索条没有单独的「搜索」按钮：回车 / 失焦搜，清空即取消筛选', (() => {
    const wb = read('web/ui/workbench.js');
    return !/GO_LABEL/.test(wb) && !/data-fb="go"/.test(wb)
      && /addEventListener\('blur'/.test(wb) && /applyQ\(''\)/.test(wb)
      && !['web/pages/assets.js', 'web/pages/studio.js'].some(f => /go:\s*true/.test(read(f)))
      && !/<button class="ghost"[^>]*>\s*搜索</.test(join);
  })());
}

/* ---------- 6. 本机优先 / 云端：身份判据只有一份 ---------- */
group('§6 本机优先与云端身份');
const al = read('web/domain/assetlib.js') + '\n' + read('web/domain/local.js');
ok('身份判据 rowOfEntry 恰好一层实现', (al.match(/function\s+rowOfEntry\s*\(/g) || []).length === 1);
ok('decorate 与 twinOf 都走 rowOfEntry', /rowOfEntry\(e,\s*opts && opts\.allowGen != null/.test(al)
  && /rowOfEntry\(e,\s*false\)/.test(al));
ok('本机/云端状态只有 stateOf 一份出口', /function\s+stateOf\s*\(/.test(al)
  && /\n\s*stateOf,\n/.test(al) && !/hasLocal,\s*hasCloud/.test(al));
/* 画「本机 / 云端」徽标的页（资产库 / 工作台）都读 stateOf —— 那一档的身份只有一份出口。
   收藏页**不画**这一档徽标（那一页不显示本机 / 云端 / 只剩外链），所以它不读 stateOf。 */
ok('画本机/云端徽标的两页都读 stateOf（收藏页不画这一档）',
  ['web/pages/assets.js', 'web/pages/studio.js'].every(f => read(f).includes('stateOf'))
  && !/stateOf/.test(read('web/pages/favorites.js')));
ok('镜像落盘带平台产物号（多图逐份认回）', /asset:\s*\(ent && ent\.assetId\)/.test(al));
ok('整表合并按产物数决定能否按任务号认', /outCount/.test(al) && /allowGen/.test(al));
group('§6b 本机优先判据的接线（local-first 由 all.cjs 独立跑，这里验接线不重跑）');
{
  /* 这里以前同步 spawnSync 再跑一遍 local-first.cjs（all.cjs 里已有一条同样的，纯重复求值）。
     换成静态接线判据：独立判据必须还登记在 all.cjs 的常驻段里 —— 谁把代跑删了又把登记也弄丢，
     这条会红；「跑不跑得过」由池子里那一条 local-first.cjs 自己回答。 */
  const allSrc = read('tests/all.cjs');
  const at = allSrc.search(/if\s*\(process\.argv\.includes\('--e2e'\)/);
  const resident = allSrc.slice(0, at);
  ok('local-first.cjs 仍登记在 all.cjs 常驻段（不再由 selfcheck 代跑）', /run\('tests\/local-first\.cjs'/.test(resident));
}

/* ---------- 7. 助手改时间线：唯一写入桥 ---------- */
group('§7 导演台时间线写入桥');
const frag = EL;
/* 动作表与查询表在 chat-tools.js，外壳/会话仍在 chat.js；这一组判据两半合看 */
const chat = read('web/features/chat.js') + '\n' + read('web/features/chat-tools.js');
ok('时间线写入桥只有一份', (frag.match(/WBBridge\.install\('director'/g) || []).length === 1
  && !/__directorActions/.test(frag));
ok('桥的切段走编辑器自己的函数', /function cutDelegated\(/.test(frag)
  && /Edit\.selectItem\('clip', id\)/.test(frag) && /Edit\.toolAction\('cut'\)/.test(frag)
  && /function cutTrim\(/.test(frag));
/* 「写入前当场压撤销快照」这一条盯机制在不在（不钉某个变量叫什么）：
   ① `beginEdit` 仍是压快照的唯一入口；
   ② 桥的每一次写入都包在 `undoWindow` 里（多字段合并成一条历史，收尾补重画与「成片变过」）；
   ③ select 走的那一侧自己不带快照，所以它也必须在窗里（`openUndoWindow` / `closeUndoWindow` 成对）。
   换了实现就要有人确认「去重这件事还在」，否则助手动作压过之后又压一份，撤销栈里全是重复步。 */
ok('写入前当场压撤销快照', /function beginEdit\(/.test(frag)
  && /function undoWindow\(/.test(frag)
  && /Edit\.openUndoWindow\(label\)/.test(frag) && /Edit\.closeUndoWindow\(\)/.test(frag));
ok('助手接了十一个时间线动作', ['select_take', 'cut_timeline', 'set_clip', 'undo_edit', 'timeline_apply',
  'subtitle_update', 'subtitle_resegment', 'subtitle_import_srt', 'media_transcribe', 'export_start',
  'export_save_to_assets'].every(k => chat.includes(k + ': {')) && /WBBridge\.get\('director'\)/.test(chat));
ok('剪辑只读面走桥不重算', ['timeline_get', 'timeline_history', 'subtitle_list', 'subtitle_export_srt',
  'media_info', 'media_frames', 'media_transcription', 'export_status', 'export_list']
  .every(k => chat.includes(k + ': {')) && /dirRead\(/.test(chat));
/* 写动作的凭据是**身份**而不是修订号：check 把「这一次要动谁」记下来，run 按同一份参数再解析一遍，
   目标对不上就当场拒（换工程 / 块被删或换了）。旧模型的 `proj.rev` / 修订号 CAS 已随模型整族删除。 */
ok('写动作按身份对账，目标变了当场拒', /let lastCheck = null/.test(frag) && /function targetOf\(/.test(frag)
  && /sameTarget\(prior\.target, targetOf\(p\)\)/.test(frag) && !/expectedRevision|revision_mismatch/.test(chat));
ok('批量剪辑不新增桥 op（仍只有四个）', /const APPLY_OPS = \['select', 'cut', 'set'\]/.test(chat)
  && !/if \(op === 'apply'\)/.test(frag) && /function applyOps\(/.test(chat));
ok('整批失败不留半截工程', /const rollback = why/.test(chat) && /A\.check\('undo'/.test(chat)
  && /工程没有留在半截状态/.test(chat));
ok('字幕写入走 set 的 subtitle 分支', /kind === 'subtitle'/.test(frag) && /function subPlan\(/.test(frag)
  && /subArgs/.test(chat));
ok('取帧只走 Wb.vframe 一份', /Wb\.vframe\.dataURL\(q\.src/.test(frag) && !/document\.createElement\('video'\)/.test(frag));
ok('助手动作统一走 ActionRegistry（planToken / 串行）', /createActionRegistry/.test(chat)
  && /CHAT_TOOLS\.registry\(\)\.plan\(/.test(chat) && /CHAT_TOOLS\.registry\(\)\.run\(/.test(chat)
  && /\/web\/core\/actions\.js/.test(chat));
ok('任意脚本注入整族已删除', !/new Function/.test(chat) && !/ai_chat_inject/.test(chat) && !/runInject/.test(chat));
ok('助手按页面与触发词加载 Skill', /WbSkills\.activeFor/.test(chat) && /CALL: skill/.test(chat));
ok('Skill 之外的输出契约读 contracts.js 一份', /text-ai\/contracts\.js/.test(chat) && /contractFor/.test(chat));
ok('提示词编辑器整块删除，正文以 Skill 为准（旧版手改档也已拆掉）', !/data-pp=/.test(read('web/pages/settings.js'))
  && !/renderPolishGroups/.test(read('web/pages/settings.js'))
  && !/clearManualPrompts/.test(read('web/domain/text-ai.js'))
  && !/promptKey\(/.test(read('web/domain/text-ai.js'))
  && !/migrateLegacyPrompts/.test(read('web/ui/skills.js')));
ok('查询结果预算按 tokens 估算', /chat\/text-util\.js/.test(chat) && /estimateTokens/.test(chat) && /tokenOf\(/.test(chat));
ok('发给模型前抹掉密钥形状', /chat\/text-util\.js/.test(chat) && /redactSecrets/.test(chat) && /redactOf\(out\)/.test(chat));
ok('当前界面快照带时间线只读上下文', /WBBridge\.get\('director'\)/.test(read('web/core/page-context.js')));

/* ---------- 8. 素材库：批量 / 锚点 / 视觉相似 ---------- */
group('§8 素材库（批量 / 锚点 / 相似）');
const charsJs = read('web/domain/chars.js');
const charsPage = read('web/pages/chars.js');
/* 详情层（新建 / 编辑一条素材）是素材库页的一部分，单独一个文件 —— 判据要连它一起读。 */
const charsDetail = read('web/pages/chars/detail.js');
ok('身份锚点只有一份读法 refPicOf', /function refPicOf\(/.test(charsJs)
  && /anchor: keep\(char\.anchor/.test(charsJs));
ok('出资产与重出预览都走锚点', /const base = refPicOf\(item\)/.test(charsJs)
  && /const anchor = String\(item\.anchor/.test(charsJs) && /inputEntries: inputEntries/.test(charsJs));
ok('导演台取参考图也走锚点', /refPicOf/.test(frag));
const charsTpl = read('tools/vue-templates/chars.html');
const charsCss = read('web/styles/spa-chars.css');
ok('素材库只剩紧凑网格（视图开关与列表档已撤）',
  !/viewEl|viewToggle|dir_char_view|view-list/.test(charsPage + charsTpl + charsCss)
  && /mat-grid/.test(charsTpl) && /mat-grid/.test(charsCss));
ok('素材库不再有待完善面板与导入导出',
  !/rail-gaps|GAP_ROWS|gapFilter|一键补齐|存回本机|exportLibJson|importLibJson|onLibImport/.test(charsPage + charsTpl)
  && !/type="file"/.test(charsTpl));
ok('多选批量五件事都在', ['batchFillPics', 'batchFillAssets', 'batchFillVoices', 'batchSetGroup', 'batchRemove']
  .every(k => charsPage.includes(k)));
ok('视觉相似在本机算 dHash', /function imgHash/.test(charsPage) && /function findSimilar/.test(charsPage));
ok('搜索走本地语义排序', /SemanticSearch/.test(charsPage) && /S\.rank/.test(charsPage));
ok('新建 / 编辑在素材详情那一层（不塞回卡片里）', /createDetail/.test(charsPage)
  && /export function createDetail/.test(charsDetail));
ok('每个生成位自带型号与数量', /gen-bar/.test(charsDetail) && /gen-model/.test(charsDetail)
  && /gen-count/.test(charsDetail));
/* 「本页默认」2026-10 撤掉：默认值改由设置页「素材库」那张卡管（默认生图型号 / 默认语音型号 /
   默认出几张），页面上每一处生成位仍能当场换 —— 换的那一次只管那一处。 */
ok('素材库页面上没有「本页默认」这一块',
  !/本页默认/.test(read('tools/vue-templates/chars.html'))
  && !/rail-foot|rf-row|rf-hint/.test(charsPage)
  && !/本页默认/.test(read('web/styles/spa-chars.css'))
  && !/gendef/.test(charsDetail));
ok('素材页的默认型号与张数在设置页「素材库」那张卡里',
  /imgModel/.test(charsJs) && /ttsModel/.test(charsJs) && /kind: 'model'/.test(charsJs)
  && /modelCtl/.test(read('web/pages/settings.js'))
  && /defImgModel/.test(charsPage) && /defTtsModel/.test(charsPage));
ok('语音条数是独立一项（与出图张数分开设）',
  /voiceN/.test(charsJs) && /char_voice_n/.test(charsJs) && /voiceN\(\)/.test(charsDetail));
ok('不再往本机存「上次用的型号与张数」', !/saveOpts/.test(charsPage)
  && !/write\(\s*'char_opts'/.test(charsPage) && !/getItem\('char_opts'\)/.test(charsPage));

/* ---------- 9. 导演台 FCPXML 导出 ---------- */
group('§9 导演台 FCPXML 导出');
const fcp = read('web/director/fcpxml.js');
/* 导出格式只有一张表（web/domain/export-formats.js）：页头按钮、engine 接线、助手枚举都从它派生。 */
const expFmt = read('web/domain/export-formats.js');
ok('页头导出入口由格式表生成并接线', /id="exportBtns"/.test(read('web/director/template.html'))
  && /button: 'exportFcp'/.test(expFmt) && /ExportFormats\.list\(\)\.forEach/.test(frag)
  && /b\.onclick = EXPORT_RUN\[f\.kind\]/.test(frag));
ok('FCPXML 两档：裸 XML 与带素材的媒体包', /button: 'exportFcpBundle'/.test(expFmt) && /bundle: true/.test(expFmt)
  && /Export\.fcp\(\{ bundle: !!f\.bundle \}\)/.test(frag)
  && /runFcpExport\(fcpCtx\(\), opts/.test(read('web/director/engine/export.js'))
  && /\/fcpxml\/bundle/.test(fcp) && /bundleAssets/.test(fcp));
/* 起点与行长只有一张表：`buildRenderPlan()`（engine/export.js）按成片顺序摊出来，
   FCPXML 只翻译，不再自己累加一遍 —— 两处各算一次，导出的 XML 与片子迟早对不上。 */
ok('导出只读当前时间线（起点与行长读同一份渲染计划）', /export async function buildFCPXML/.test(fcp)
  && /const plan = await buildRenderPlan\(\)/.test(fcp) && /plan\.rows/.test(fcp)
  && /export async function exportFCPXML/.test(fcp)
  && /buildFCPXML\(/.test(fcp.split('export async function exportFCPXML')[1] || ''));
ok('本机素材走真实文件、缺失素材保留离线引用（路径编码只有 encodePath 一份）', /localFileOf/.test(fcp)
  && /encodePath\(name\)/.test(fcp) && /missing\.push/.test(fcp));
ok('倍速写成 timeMap / 配音带行偏移', /<timeMap>/.test(fcp) && /lane="' \+ \(1 \+ v\.lane\)/.test(fcp));
ok('缺素材不静默丢段（写 <gap> 补时长并点名）', /<gap name=/.test(fcp) && /本机没有可用文件的素材/.test(fcp));

/* ---------- 10. 自动镜像 / 常驻页面生命周期 ---------- */
group('§10 自动镜像与常驻页面生命周期');
ok('代理有流式 from-url 通道且同源单飞', /dataPath === '\/local-assets\/from-url'/.test(proxy)
  && /withLocalSaveLock/.test(proxy) && /downloadTo\(target, tmp\)/.test(proxy));
/* 产物只有一份：镜像写进库根的类型子目录，写完不再「按号另存第二份到用户目录」。
   `Api.saveLocal(` 后面带括号钉死：`Api.saveLocalAsset` / `saveLocalFromUrl` 是写库那一条，
   不许被这一条误伤（少了那对括号，判据就变成「不许有任何本机写入」）。 */
ok('镜像写入浏览器侧只走 from-url，第二份「另存」整族已撤', /saveLocalFromUrl/.test(al)
  && !/Api\.saveLocal\(/.test(al) && !/Api\.saveToDir\(/.test(al));
ok('同一个本机号只留一行（落盘回执按 la 号就地替换）', /function putRow\(/.test(al)
  && /rows\.set\(row\.id, row\)/.test(al));
/* 「生成完成 → 自动镜像」这条链：三处生产者各自
   `dispatchEvent(new CustomEvent(...))` 的年代已经收掉；字段集合各不相同，消费方只能逐字段容错。
   判据钉的是反面：**事件名只许出现在 local.js 那一处生产点**，三个生产点必须都改调
   `AssetLocal.announce`。数之前先剥注释 —— 说明文字里引用旧写法不算一条违例（同一条规矩）。
   留着「旧写法也算过」的 or 分支 = 这条链可以慢慢长回三份。 */
{
  const code = f => S.stripComments(read(f));
  const localCode = code('web/domain/local.js');
  /* 三个生产点。导演台那一份自 G1 起按域住在 engine/<域>.js（生成 / 轮询那一条），
     所以这里看的是整层拼起来的那一份 —— 认「名字在哪儿」不认「文件叫什么」。 */
  const four = [
    ['导演台 engine 层', S.engineFiles().map(code).join('\n')],
    ['web/pages/studio.js', code('web/pages/studio.js')],
    ['web/domain/gen-forms.js', code('web/domain/gen-forms.js')],
  ];
  const dispatchN = (localCode.match(/new CustomEvent\('wb:asset-done'/g) || []).length;
  const stillOwn = four.filter(x => /new CustomEvent\('wb:asset-done'/.test(x[1])).map(x => x[0]);
  const notWired = four.filter(x => !/AssetLocal\.announce\(/.test(x[1])).map(x => x[0]);
  ok('生成完成事件驱动自动镜像，且只有一个生产出口',
    /function announce\(entries\)/.test(localCode) && dispatchN === 1 && !stillOwn.length && !notWired.length,
    'local.js 里投事件 ' + dispatchN + ' 处（要 1）；仍自己投的：' + (stillOwn.join(', ') || '无')
    + '；没改调 announce 的：' + (notWired.join(', ') || '无'));
}
ok('待镜像清单跨刷新 + 失败退避', /sk_local_pending/.test(al) && /replayPending/.test(al) && /pendSkip/.test(al));
ok('别名表由代理现给（开机快照 + 列表批量问），浏览器不留持久副本', /Net\.json\('\/local-assets\/aliases'/.test(al)
  && /Net\.json\('\/local-assets\/locate'/.test(al) && !/sk_local_mirror/.test(al) && !/\.at\('mirror'\)/.test(al));
/* 轮询器要写明自己属于哪一页（公共件按路由判前台，切走就停）。这一页的路由文件名已经
   收成一个常量，两种写法都算「点了名」。 */
ok('轮询器按路由可见性暂停', /page: 'director\.html'/.test(frag) && /page:\s*('studio\.html'|PAGE_FILE)/.test(read('web/pages/studio.js'))
  && /page:\s*('assets\.html'|PAGE_FILE)/.test(read('web/pages/assets.js')) && /r\.file !== page/.test(read('web/ui/workbench.js')));
ok('关标签前多页钩子都跑 + 导演台同步救生包', /__spaRegister/.test(core)
  && /__spaRegister\(window\.__spaFlush/.test(frag) && /dir_ws_unload/.test(frag)
  && /__spaRegister\(window\.__spaFlush/.test(read('web/pages/settings.js')));
ok('助手页面快照是合法 JSON 而不是截断串', /function compactCtx/.test(chat) && /compactCtx\(pc\)/.test(chat));

console.log('\n' + (bad ? '✗ ' : '✓ ') + checks + ' 项，' + bad + ' 项未通过');
process.exit(bad ? 1 : 0);
