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
const S = require('./support.cjs');            // 数「代码里真有几条」时要先剥注释（§10 那条事件契约判据）

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
   旧版这里同步 spawnSync 跑 tests/spa.cjs（外加 §6b 再跑一遍 local-first.cjs）：
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
for (const f of ['/favorites.html', '/usage.html', '/assets.html', '/settings.html', '/chars.html', '/studio.html', '/roles.html', '/video.html', '/image.html', '/audio.html']) {
  ok('代理给旧地址 ' + f + ' 留了重定向', proxy.includes("'" + f + "'"));
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
for (const f of ['web/ui/ui.js', 'web/ui/forms.js', 'web/ui/net.js', 'web/ui/datasync.js', 'web/ui/store.js', 'web/ui/kv.js', 'web/ui/toast.js', 'web/domain/api.js', 'web/domain/assetlib.js', 'web/domain/gen-forms.js', 'web/domain/asset-transfer.js', 'web/domain/local.js', 'web/domain/capabilities.js', 'web/domain/text-ai.js', 'web/domain/fav.js', 'web/domain/prompt-log.js', 'web/domain/asset-picker.js', 'web/domain/ai-find.js', 'web/ui/workbench.js', 'web/domain/chars.js', 'web/domain/ident.cjs', 'web/core/routes.js', 'web/core/bridges.js', 'web/shell-boot.js', 'web/boot-assistant.js', 'web/app.js', 'shell.html', 'web/director/index.js', 'web/director/engine.js', 'web/director/fcpxml.js', 'web/director/fcpxml-import.js', 'web/director/util.js', 'web/director/board.js', 'web/director/split-assets.js', 'web/director/slice.js', 'web/director/playback.js', 'web/director/segments.js', 'web/director/timeline.js', 'web/director/voice-layout.js', 'web/director/plan.js', 'web/director/waveform.js', 'web/director/projection.js', 'web/director/voice-block.js', 'web/core/page-context.js', 'web/core/report.js', 'web/domain/semantic.js']) {
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
ok('每个页面都有助手只读快照', ['director.html','canvas.html','studio.html','chars.html','assets.html','settings.html','usage.html','favorites.html']
  .every(f => read('web/core/page-context.js').includes("'" + f + "'")) && /__acPageCtx/.test(read('web/core/page-context.js')));
ok('助手在 compose 里自动带当前界面', /【当前界面/.test(read('web/features/chat.js')) && /hostCtx\(\)/.test(read('web/features/chat.js')));
ok('助手有本地语义检索工具', /find\s*:\s*\{/.test(read('web/features/chat-tools.js')) && /SemanticSearch/.test(read('web/features/chat-tools.js')));
ok('语义检索模块有 rank', /SemanticSearch\s*=\s*\{\s*norm/.test(read('web/domain/semantic.js')) && /function\s+rank/.test(read('web/domain/semantic.js')));
ok('切片缓存用稳定键 / 失败 TTL / 同图不重绘', /function\s+sliceKey/.test(EL)
  && /SLICE_FAIL_TTL/.test(EL) && /__frsSig/.test(EL));
ok('导出素材名带成片时间点', /function\s+clipTimeLabel/.test(read('web/director/engine/export.js'))
  && /voiceFilmRange/.test(read('web/director/engine/export.js')));
ok('本机/云端标识有开关', /sk_media_badge/.test(read('web/ui/ui.js')) && /showBadge/.test(read('web/domain/local.js')));
ok('Vue 页面可交未保存状态', /__spaFlush/.test(core) && /__spaDirty/.test(core));

/* ---------- 5. 关键机制仍只有一份 ---------- */
group('§5 唯一实现');
const all = comps.map(read).join('\n');
ok('页面不自己写 Toast / Confirm 外壳', !/class\s+="pr-mask"/.test(all));
ok('页面不自己拼分页文案', !/第\s*['"]?\s*\+\s*\(cur/.test(all));
ok('页面不自己写字节单位表', !/\['B',\s*'KB',\s*'MB'/.test(all));
ok('页面不自己写缩略图缓存键', !/function\s+thumbKeyOf|function\s+mediaKeyOf/.test(all));
ok('共享层里仍有 AssetLocal / AiFind / Chips / AdvExtras 的唯一实现',
  ['window.AssetLocal', 'window.AiFind', 'window.Chips', 'window.AdvExtras'].every(k => read('web/domain/assetlib.js').includes(k) || read('web/domain/gen-forms.js').includes(k) || read('web/domain/local.js').includes(k) || read('web/domain/ai-find.js').includes(k) || read('web/ui/ui.js').includes(k)));

/* ---------- 6. 本机优先 / 云端：身份判据只有一份 ---------- */
group('§6 本机优先与云端身份');
const al = read('web/domain/assetlib.js') + '\n' + read('web/domain/local.js');
ok('身份判据 mirrorOf 恰好一层实现', (al.match(/function\s+mirrorOf\s*\(/g) || []).length === 1);
ok('decorate 与 twinOf 都走 mirrorOf', /mirrorOf\(e,\s*!!\(opts && opts\.allowGen\)\)/.test(al)
  && /mirrorOf\(e,\s*false\)/.test(al));
ok('本机/云端状态只有 stateOf 一份出口', /function\s+stateOf\s*\(/.test(al)
  && /hasLocal,\s*hasCloud,\s*stateOf/.test(al));
ok('三个页面的卡片标识都读 stateOf', ['web/pages/assets.js', 'web/pages/favorites.js', 'web/pages/studio.js']
  .every(f => read(f).includes('stateOf')));
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
ok('桥的切段走编辑器自己的函数', /cutSegs\(q\.c, total, at, way\)/.test(frag)
  && /segsWrite\(p\.c, p\.total, p\.out\.segs\)/.test(frag) && /reanchorVoices\(p\.sh/.test(frag));
ok('写入前当场压撤销快照', /function beginEdit\(/.test(frag) && /!undoPushed/.test(frag)
  && /if \(!b\.inBatch \|\| b\.first\) beginEdit\(label\)/.test(frag)
  && (frag.match(/const b = editBegin\(a, '/g) || []).length === 4);
ok('助手接了十一个时间线动作', ['select_take', 'cut_timeline', 'set_clip', 'undo_edit', 'timeline_apply',
  'subtitle_update', 'subtitle_resegment', 'subtitle_import_srt', 'media_transcribe', 'export_start',
  'export_save_to_assets'].every(k => chat.includes(k + ': {')) && /WBBridge\.get\('director'\)/.test(chat));
ok('剪辑只读面走桥不重算', ['timeline_get', 'timeline_history', 'subtitle_list', 'subtitle_export_srt',
  'media_info', 'media_frames', 'media_transcription', 'export_status', 'export_list']
  .every(k => chat.includes(k + ': {')) && /dirRead\(/.test(chat));
ok('写动作带修订号 CAS，缺凭据当场拒', /function revGate\(/.test(frag) && /expectedRevision/.test(frag)
  && /revision_mismatch/.test(frag) && /stampWrite/.test(chat));
ok('批量剪辑不新增桥 op（仍只有四个）', (frag.match(/if \(op === '(select|cut|set|undo)'\)/g) || []).length >= 4
  && !/if \(op === 'apply'\)/.test(frag) && /_batch/.test(frag) && /function applyOps\(/.test(chat));
ok('整批失败不留半截工程', /_rollback/.test(frag) && /A\.run\('undo'/.test(chat) && /整批退回/.test(chat));
ok('字幕写入走 set 的 subtitle 分支', /kind === 'subtitle'/.test(frag) && /function subPlan\(/.test(frag)
  && /subArgs/.test(chat));
ok('取帧只走 Wb.vframe 一份', /Wb\.vframe\.dataURL\(q\.src/.test(frag) && !/document\.createElement\('video'\)/.test(frag));
ok('助手动作统一走 ActionRegistry（planToken / 串行）', /createActionRegistry/.test(chat)
  && /CHAT_TOOLS\.registry\(\)\.plan\(/.test(chat) && /CHAT_TOOLS\.registry\(\)\.run\(/.test(chat)
  && /\/web\/core\/actions\.js/.test(chat));
ok('任意脚本注入整族已删除', !/new Function/.test(chat) && !/ai_chat_inject/.test(chat) && !/runInject/.test(chat));
ok('助手按页面与触发词加载 Skill', /WbSkills\.activeFor/.test(chat) && /CALL: skill/.test(chat));
ok('Skill 之外的输出契约读 contracts.js 一份', /text-ai\/contracts\.js/.test(chat) && /contractFor/.test(chat));
ok('提示词编辑器整块删除，正文以 Skill 为准', !/data-pp=/.test(read('web/pages/settings.js'))
  && !/renderPolishGroups/.test(read('web/pages/settings.js'))
  && /clearManualPrompts/.test(read('web/domain/text-ai.js')) && /清掉旧版手改/.test(read('web/pages/settings.js')));
ok('查询结果预算按 tokens 估算', /chat\/text-util\.js/.test(chat) && /estimateTokens/.test(chat) && /tokenOf\(/.test(chat));
ok('发给模型前抹掉密钥形状', /chat\/text-util\.js/.test(chat) && /redactSecrets/.test(chat) && /redactOf\(out\)/.test(chat));
ok('当前界面快照带时间线只读上下文', /WBBridge\.get\('director'\)/.test(read('web/core/page-context.js')));

/* ---------- 8. 素材库：体检 / 批量 / 锚点 / 视觉相似 ---------- */
group('§8 素材库（体检 / 批量 / 锚点 / 相似）');
const charsJs = read('web/domain/chars.js');
const charsPage = read('web/pages/chars.js');
ok('身份锚点只有一份读法 refPicOf', /function refPicOf\(/.test(charsJs)
  && /anchor: keep\(char\.anchor/.test(charsJs));
ok('出资产与重出预览都走锚点', /const base = refPicOf\(item\)/.test(charsJs)
  && /const anchor = String\(item\.anchor/.test(charsJs) && /inputEntries: inputEntries/.test(charsJs));
ok('导演台取参考图也走锚点', /refPicOf/.test(frag));
ok('素材库有体检与「还没有描述」缺口', /char-health/.test(read('tools/vue-templates/chars.html')) && /nodesc/.test(charsPage));
ok('多选批量五件事都在', ['batchFillPics', 'batchFillAssets', 'batchFillVoices', 'batchSetGroup', 'batchRemove']
  .every(k => charsPage.includes(k)));
ok('视觉相似在本机算 dHash', /function imgHash/.test(charsPage) && /function findSimilar/.test(charsPage));
ok('搜索走本地语义排序', /SemanticSearch/.test(charsPage) && /S\.rank/.test(charsPage));

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
ok('导出只读当前时间线', /export async function buildFCPXML/.test(fcp)
  && /tlSyncFromShots\(\)/.test(fcp.split('export async function buildFCPXML')[1] || '')
  && /export async function exportFCPXML/.test(fcp)
  && /buildFCPXML\(/.test(fcp.split('export async function exportFCPXML')[1] || ''));
ok('本机素材走真实文件、缺失素材保留离线引用', /localFileOf/.test(fcp)
  && /'media\/' \+ encodeURI\(name\)/.test(fcp) && /missing\.push/.test(fcp));
ok('倍速写成 timeMap / 配音带偏移', /<timeMap>/.test(fcp) && /lane="-/.test(fcp));
ok('黑场与缺素材不会静默丢段', /<gap /.test(fcp) && /本机没有可用文件的素材/.test(fcp));

/* ---------- 10. 自动镜像 / 常驻页面生命周期 ---------- */
group('§10 自动镜像与常驻页面生命周期');
ok('代理有流式 from-url 通道且同源单飞', /dataPath === '\/local-assets\/from-url'/.test(proxy)
  && /withLocalSaveLock/.test(proxy) && /downloadTo\(target, tmp\)/.test(proxy));
ok('镜像写入浏览器侧走 from-url、另存走 save-local', /saveLocalFromUrl/.test(al)
  && /Api\.saveLocal\(\{ ids: \[r\.id\] \}\)/.test(al));
ok('复用代理返回的旧键（一个 la 只挂一个键）', /const oldKey = d\.a\[r\.id\]/.test(al)
  && /const key = oldKey \|\| k/.test(al));
/* 「生成完成 → 自动镜像」这条链：以前四个生产者各自
   `dispatchEvent(new CustomEvent(...))`，字段集合各不相同，消费方只能逐字段容错。
   判据钉的是反面：**事件名只许出现在 local.js 那一处生产点**，四个原来的生产点必须都改调
   `AssetLocal.announce`。数之前先剥注释 —— 说明文字里引用旧写法不算一条违例（同一条规矩）。
   留着「旧写法也算过」的 or 分支 = 这条链可以慢慢长回四份。 */
{
  const code = f => S.stripComments(read(f));
  const localCode = code('web/domain/local.js');
  /* 四个生产点。导演台那一份自 G1 起按域住在 engine/<域>.js（生成 / 轮询那一条），
     所以这里看的是整层拼起来的那一份 —— 认「名字在哪儿」不认「文件叫什么」。 */
  const four = [
    ['导演台 engine 层', S.engineFiles().map(code).join('\n')],
    ['web/pages/studio.js', code('web/pages/studio.js')],
    ['web/domain/canvas/gen.js', code('web/domain/canvas/gen.js')],
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
ok('镜像指针本体在 IndexedDB、localStorage 只留暖缓存', /mirror: \{ db: 'mirror_db'/.test(read('web/ui/kv.js'))
  && /\.at\('mirror'\)/.test(al) && /LOCAL_CACHE_MAX = 2000/.test(al));
/* 轮询器要写明自己属于哪一页（公共件按路由判前台，切走就停）。这一页的路由文件名已经
   收成一个常量，两种写法都算「点了名」。 */
ok('轮询器按路由可见性暂停', /page: 'director\.html'/.test(frag) && /page:\s*('studio\.html'|PAGE_FILE)/.test(read('web/pages/studio.js'))
  && /page:\s*('assets\.html'|PAGE_FILE)/.test(read('web/pages/assets.js')) && /r\.file !== page/.test(read('web/ui/workbench.js')));
ok('关标签前多页钩子都跑 + 导演台同步救生包', /__spaRegister/.test(core)
  && /__spaRegister\(window\.__spaFlush/.test(frag) && /dir_ws_unload/.test(frag)
  && /__spaRegister\(window\.__spaFlush/.test(read('web/pages/settings.js')));
ok('助手页面快照是合法 JSON 而不是截断串', /function compactCtx/.test(chat) && /compactCtx\(pc\)/.test(chat));

/* ---------- 11. 画布助手：唯一写入桥 + 身份 / 参数 / 撤销判据 ---------- */
group('§11 画布助手（WBBridge.canvas）');
const cvPage = read('web/pages/canvas.js');
const cvGen = read('web/domain/canvas/gen.js');
const cvHist = read('web/domain/canvas/history.js');
const pcJs = read('web/core/page-context.js');
ok('画布写入桥只装一次，且只有页面装', (cvPage.match(/WBBridge\.install\('canvas'/g) || []).length === 1
  && !/WBBridge\.install\('canvas'/.test(chat));
ok('助手接了画布八个写动作', ['canvas_nodes_create', 'canvas_nodes_update', 'canvas_nodes_delete',
  'canvas_edges_create', 'canvas_edges_delete', 'canvas_viewport_set', 'canvas_generation_propose', 'canvas_undo']
  .every(k => chat.includes(k + ': {')));
ok('画布只读面走桥不重算', ['canvas_get', 'canvas_search', 'canvas_node_read', 'canvas_assets_list',
  'canvas_generation_status'].every(k => chat.includes(k + ': {')) && /canvasRead\(/.test(chat));
ok('写画布只有桥的 apply 一个出口', (chat.match(/g\.A\.apply\(ops,/g) || []).length === 1
  && /expectedRevision: a && a\.expectedRevision/.test(chat));
const cvSchema = chat.slice(chat.indexOf("canvas_nodes_create: { type: 'object'"), chat.indexOf("canvas_undo: { type: 'object'"));
ok('CAS 凭据不给模型填（schema 里没有修订号与 operationId）', cvSchema.length > 200
  && !/expectedRevision/.test(cvSchema) && !/operationId/.test(cvSchema));
ok('资产引用只认本机查得到的号', /模型编的号一律不收/.test(chat) && /await cvAssetGate\(ops\)/.test(chat)
  && /AssetLib\.listCache/.test(chat) && /\/local-assets/.test(chat));
ok('画布节点检索只有页面那一份（助手不另排序）', /function rankNodes\(/.test(cvPage) && !/rankNodes/.test(chat));
/* SemanticSearch.rank 回的是 { item, score, why } 那一层壳：把它当节点读会撞「metadata of undefined」，
   画布 Ctrl+F 与助手的 canvas_search 是同一条链路，一处坏两处死。 */
ok('节点检索解开 rank 那层壳（壳里的 item 才是检索行）', /const node = r\.item\.node/.test(cvPage)
  && /pick\(\{ item: d, score: 1/.test(cvPage));
/* 图片与视频两条提交共用同一个 base（图片 spread，视频 Object.assign 再覆盖），
   键名一律是 Api.createBody 认的那一份（res / ar / quality / tier / format / size / duration）。 */
ok('生成参数键名只认 createBody 那一份（画质不再被丢）', /res: r\.params\.res/.test(cvGen)
  && /\.\.\.base/.test(cvGen) && /Object\.assign\(\{\}, base/.test(cvGen) && !/resolution: r\.params/.test(cvGen)
  && /cvParamKeys/.test(chat) && /checkParam\(/.test(chat));
ok('一条资产变节点只有页面那一份 assetOpOf', /function assetOpOf\(/.test(cvPage)
  && /assetNode: \(kind, assetId, pt, title\) => assetOpOf/.test(cvPage) && /A\.assetNode\(/.test(chat));
ok('助手写入推进撤销基线，用户 Ctrl+Z 不跨越它', /source: 'external'/.test(cvPage)
  && /item\.source === 'external'\) baseline = cursor/.test(cvHist) && /canUndo\(\) \{ return cursor > baseline/.test(cvHist));
ok('撤销按 operationId 找，不是栈顶就拒并说清压了几步', /code: 'not_top'/.test(cvHist)
  && /r\.code === 'not_top'/.test(chat) && /steps/.test(chat) && /canvasUndoCall/.test(chat));
/* 那个号在注册表那一层是「这一次执行」的幂等键：要退掉的那一步的号留在原位，
   run() 会命中那一次写入的缓存结果 —— 撤销根本没跑，卡片却照着旧回执念「加了 1 枚节点」。 */
ok('撤销不拿目标步的号当幂等键（换名后才交给注册表）', /delete a\.operationId/.test(chat)
  && /a\.undoOperationId = target/.test(chat) && /a\.undoOperationId \|\| a\.operationId/.test(chat));
ok('只读画布不交写工具（页面一张闸，助手与快照都读它）', /readOnly: \(\) =>/.test(cvPage)
  && /g\.readOnly\(\)/.test(chat) && /\.只读 = !!/.test(pcJs));
const cvStampList = chat.slice(chat.indexOf('const CANVAS_WRITE = ['), chat.indexOf('function stampWrite('));
ok('视图动作不占 CAS（只动视图、不涨修订）', !/canvas_viewport_set/.test(cvStampList)
  && /S\.surface\.setViewport\(vp\)/.test(cvPage) && /不涨修订/.test(chat));
/* 策略登记从三张侧面表收进 ACTION_META 一张，
   所以这一条读的是 `{ effect: 'cost', … }` 那一行，不再是 `ACTION_EFFECT` 里的 `'…': 'cost'`。 */
ok('提案与扣费分开（画卡片不建任务）', /没有建任务也没扣费/.test(cvPage) && /不建任务也不扣费/.test(chat)
  && /canvas_generation_propose: *\{[^}]*effect: *'cost'/.test(chat));
/* 最常用的那一种是「这一枚打算怎么生成、还缺什么」：只给 nodeId、一条要写的操作都没有。
   拿「至少一条操作」当门槛等于把这一族的第一句拒掉，所以没有 ops 时要用当前文档算 —— 仍然纯读。 */
ok('只给 nodeId 的提案不被「至少要一条操作」拒掉', /ops\.length \? applyOperations\(S\.doc, ops\)/.test(cvPage)
  && /findNode\(S\.doc, want\)/.test(cvPage));

console.log('\n' + (bad ? '✗ ' : '✓ ') + checks + ' 项，' + bad + ' 项未通过');
process.exit(bad ? 1 : 0);
