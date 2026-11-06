#!/usr/bin/env node
/* FCPXML 模块行为：给定一份**渲染计划**（engine/export.js 的 buildRenderPlan 那种形状），
   真的生成 XML。window 上的小工具换成桩，Net.save 接住 Blob，不联网、不花钱。
   钉的几件事：本机索引名 = 媒体包文件名 = <asset name>；同一素材多段复用只进包一次；
   扩展名恰好一个；片段显示名带场景与镜头；图片段写 still；配音独立 lane + timeMap 与淡入淡出；
   转场按 FCPXML 语义写成居中重叠的 Cross Dissolve（片段 offset 一个都不动）；
   字幕写 title + text-style（高亮底色 / 字体 / 字号可配）并同一份进 subtitles.srt；
   没地址的段写 <gap> 并点名；单文件指向本机真实落点、媒体包写相对路径；
   工程目录档走 /fcpxml/project 并回目录信息、不启动任何软件。 */
import assert from 'node:assert/strict';
import { buildFCPXML, exportFCPXML, exportProject } from '../web/director/fcpxml.js';

let saved = null, status = '';
/* path = 账里「相对库根的落点」（<类型子目录>\<规范名>.<ext>）：单文件 FCPXML 的 file://
   绝对路径从它拼 —— 本机号 la_xxx 不是文件名（本体在 <库根>\视频\<规范名>.mp4）。 */
const localFiles = {
  '/asset/la_pic?dl=1': { id: 'la_pic', format: 'mp4', name: '场景01-雨夜街头_镜头01-推门.mp4', path: '视频/场景01-雨夜街头_镜头01-推门.mp4' },
  '/asset/la_voice?dl=1': { id: 'la_voice', format: 'wav', name: '场景01-雨夜街头_镜头01-推门.wav', path: '音频/场景01-雨夜街头_镜头01-推门.wav' },
  '/asset/la_still?dl=1': { id: 'la_still', format: 'png', name: '封面.png', path: '图片/封面.png' },
};
const AssetLocal = {
  ready: async () => {},
  localFileOf: u => localFiles[String(u || '')] || null,
};
const Api = {
  sysStatus: async () => ({ 目录: { 资产: { 路径: 'C:/work/assets' } } }),
  assetSrc: id => '/asset/' + encodeURIComponent(id) + '?v=2',
};
globalThis.window = {
  fileSafe: (s, n) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').slice(0, n || 60),
  pad2: n => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(2, '0'),
  fileStamp: () => '20261027-120000',
  fmtDur: s => s + ' 秒',
  Api,
  AssetLocal,
  Net: {
    save: async (blob, name) => { saved = { blob, name }; },
    blob: async () => new Blob(['PK\u0003\u0004zip'], { type: 'application/zip' }),
  },
};

const cand = { vid: 'c1', format: 'mp4' };
const shot = { id: 's1', name: '推门', candidates: [cand] };
const proj = { name: '测试片', scenes: [{ name: '雨夜街头', shots: [shot] }] };
/* 一份渲染计划：两段同一素材（复用只进包一次）+ 一张图 + 一段没地址（写 gap）。 */
const mkClip = o => Object.assign({
  kind: 'video', name: '镜一', shotId: 's1', candId: 'c1',
  sourceStart: 0, sourceDuration: 4, mediaDuration: 8, volume: 1, muted: false,
}, o || {});
const plan = {
  rows: [
    { index: 0, start: 0, duration: 2, clip: mkClip(), shot, cand, src: '/asset/la_pic?dl=1', payload: { playbackRate: 2, volume: 2 } },
    { index: 1, start: 2, duration: 1, clip: mkClip(), shot, cand, src: '/asset/la_pic?dl=1', payload: { playbackRate: 1, volume: 1 } },
    { index: 2, start: 3, duration: 2,
      clip: mkClip({ kind: 'image', name: '封面', shotId: '', candId: '', sourceStart: 0, sourceDuration: 0, mediaDuration: 0 }),
      shot: null, cand: null, src: '/asset/la_still?dl=1', payload: { playbackRate: 1, volume: 1 } },
    { index: 3, start: 5, duration: 1, clip: mkClip(), shot, cand, src: '', payload: { playbackRate: 1, volume: 1 } },
  ],
  missing: [{ index: 3, name: '镜一' }],
  transitions: [{ id: 'fade', start: 1.5, end: 2, duration: 0.5, to: 1 }],
  voices: [{ src: '/asset/la_voice?dl=1', name: '第一句', start: 0, duration: 1,
    sourceStart: 0, sourceDuration: 2, playbackRate: 1, volume: 0.5, fadeIn: 0.2, fadeOut: 0, lane: 0, shotId: 's1' }],
  captions: [{ text: '一句字幕', start: 0.5, end: 1.5, position: 'middle', highlight: false, lane: 0 }],
  duration: 6,
};
const ctx = {
  proj,
  buildRenderPlan: async () => plan,
  clipNameOf: c => (c && c.name) || '',
  filmSize: () => ({ w: 1920, h: 1080 }),
  setStatus: s => { status = s; },
  el: () => ({ disabled: false }),
  AssetLocal,
  Api,
  Net: window.Net,
};

/* ---------- 拼装（媒体包）：名字与去重 ---------- */
const built = await buildFCPXML(ctx, { bundle: true });
assert.equal(built.ok, true);
const videoName = '场景01-雨夜街头_镜头01-推门.mp4';
const voiceName = '场景01-雨夜街头_镜头01-推门.wav';
const stillName = '封面.png';
assert.equal(built.rows, 4);
assert.equal(built.gapRows, 1, '没有地址的那一段写成 gap，不静默丢');
assert.equal(built.voices, 1);
assert.equal(built.transitions, 1);
assert.equal(built.duration, 6);
assert.equal(built.bundleAssets.length, 3, '画面两段复用 + 一句配音 + 一张图 = 三份素材，不能重复进包');
assert.deepEqual(built.bundleAssets.map(a => a.name).sort(), [voiceName, videoName, stillName].sort());
assert.ok(!/\.(mp4|wav|png)\.(mp4|wav|png)/.test(built.xml), '不能出现双扩展名');
const videoAsset = (built.xml.match(/<asset id="r\d+" name="[^"]*\.mp4"/) || [])[0] || '';
assert.ok(videoAsset.includes('name="' + videoName + '"'), '本机索引名要原样进 <asset name>');
assert.ok(built.xml.includes('src="media/' + encodeURIComponent(videoName) + '"'),
  '媒体包里的 media-rep 要与 asset name 同一个文件名');
assert.ok(built.xml.includes('src="media/' + encodeURIComponent(voiceName) + '"'), '配音同样同源');
assert.ok(built.xml.includes('name="场景01 雨夜街头 · 镜头01 推门 · 片段1"'), '片段名要带场景与镜头');
assert.ok(built.xml.includes('name="场景01 雨夜街头 · 镜头01 推门 · 片段2"'), '片段序号按段落在成片里的位置现算');
const videoRef = (videoAsset.match(/id="(r\d+)"/) || [])[1];
assert.equal((built.xml.match(new RegExp('ref="' + videoRef + '"', 'g')) || []).length, 2, '两段画面引用同一个 asset');

/* 没地址的那一段：gap + 文件头点名（「没有可用素材地址」） */
assert.ok(/<gap name="素材没取到 · 第 4 段「镜一」" offset="150\/30s" duration="30\/30s"\/>/.test(built.xml),
  '没地址的段写 <gap> 保持时间线连续');
assert.ok(/本机没有可用文件的素材/.test(built.xml) && built.missing.length >= 1, '文件头要点名缺的素材');
assert.ok(built.missing.some(m => /第 4 段/.test(m.name)), '缺地址的那一段要按段号点名');
assert.equal(built.transitions, 1);
/* 转场：FCPXML 1.10 的 <transition> 是 spine 里夹在两段之间的重叠元素，
   offset 以切点为中心（2s = 60/30s，半窗 8/30s → 52/30s），duration 16/30s。
   两段的 offset / start / duration 一个都不改 —— 总时长与配音/字幕的绝对时间才不动。 */
assert.equal(built.transitionsWritten, 1, '转场要真的写进 XML');
assert.equal(built.transitionsSkipped, 0);
assert.ok(/<transition name="Cross Dissolve" offset="52\/30s" duration="16\/30s">/.test(built.xml), '转场按居中重叠写');
assert.ok(/<filter-video ref="r_trans" name="Cross Dissolve"\/>/.test(built.xml), '转场引用内置交叉叠化效果');
assert.ok(/<effect id="r_trans" name="Cross Dissolve" uid="FxPlug:/.test(built.xml), '效果资源要在 resources 里');
assert.ok(/<transition[\s\S]*?<\/transition>[\s\S]*?offset="60\/30s"/.test(built.xml), '转场要排在左段与右段之间');
assert.ok(built.warnings.some(w => /转场已写进 XML/.test(w)), '文件头要说清转场已写以及居中语义的差异');
assert.ok(!built.warnings.some(w => /转场没写进 XML/.test(w)), '写进去了就不能再报「没写」');

/* 图片段：写成 still，不是一段「有入出点的视频」 */
const stillClip = (built.xml.match(/<asset-clip ref="r\d+" name="封面"[^>]*>[\s\S]*?<\/asset-clip>/) || [])[0] || '';
assert.ok(stillClip, '图片段要写成一条 asset-clip');
assert.ok(/ offset="90\/30s"/.test(stillClip), '图片段的起点接着上一段（成片秒）');
assert.ok(/ start="0s"/.test(stillClip), 'still 的入点恒为 0（图片没有源窗口）');
assert.ok(/ duration="60\/30s"/.test(stillClip), '图片段的时长照计划：2 秒');
assert.ok(!/<timeMap>/.test(stillClip), 'still 没有倍速，不能写 timeMap');
const stillRef = (stillClip.match(/ref="(r\d+)"/) || [])[1];
const stillAsset = (built.xml.match(new RegExp('<asset id="' + stillRef + '"[^>]*>')) || [])[0] || '';
assert.ok(/ name="封面\.png"/.test(stillAsset), '静态图的本机索引名要进 asset name');
assert.ok(/ hasVideo="1"/.test(stillAsset) && !/hasAudio/.test(stillAsset), '静态图只有视频轨属性');
assert.ok(built.xml.includes('src="media/' + encodeURIComponent(stillName) + '"'), '媒体包里的图片路径与 asset name 同源');
assert.ok(built.bundleAssets.some(a => a.name === stillName && /la_still/.test(a.src)), '图片也要真的进媒体包');

/* 画面段音量取渲染计划的 payload.volume（预览 / 导出一把尺子；静音在计划里已折成 0） */
const firstVideoClip = (built.xml.match(/<asset-clip ref="r\d+" name="[^"]*片段1"[^>]*>[\s\S]*?<\/asset-clip>/) || [])[0] || '';
assert.ok(/<adjust-volume amount="6\.0dB"\/>/.test(firstVideoClip), '计划里 volume 2 → +6dB');

/* 配音：spine 上独立 asset-clip，lane 1 起；源与成片长度不同 → timeMap；音量与淡入 */
const voiceClip = (built.xml.match(/<asset-clip ref="r\d+" lane="1"[^>]*>[\s\S]*?<\/asset-clip>/) || [])[0] || '';
assert.ok(voiceClip, '配音挂在 lane="1" 上');
assert.ok(/ name="第一句"/.test(voiceClip));
assert.ok(/<timeMap>/.test(voiceClip), '配音源 2 秒、成片 1 秒 → 要写 timeMap');
assert.ok(/<adjust-volume amount="-6\.0dB"\/>/.test(voiceClip), '音量 0.5 → −6dB');
assert.ok(/<adjust-fades fadeInDuration="6\/30s" fadeOutDuration="0s"\/>/.test(voiceClip), '淡入 0.2 秒');
assert.ok(built.xml.includes('src="media/' + encodeURIComponent(voiceName) + '"'), '配音也进媒体包');

/* 字幕：title 排在配音行之上；文本、位置、时间都对；同一份写进 subtitles.srt */
const titleClip = (built.xml.match(/<title ref="r_title" lane="\d+"[^>]*>[\s\S]*?<\/title>/) || [])[0] || '';
assert.ok(titleClip, '字幕要写成 title');
assert.ok(/lane="2"/.test(titleClip), '字幕行排在所有配音行之上（1 行配音 → 字幕 lane 2）');
assert.ok(/ offset="15\/30s" duration="30\/30s"/.test(titleClip), '字幕窗：0.5 → 1.5 秒');
assert.ok(/<text><text-style ref="ts1">一句字幕<\/text-style><\/text>/.test(titleClip), '字幕文本进 text');
assert.ok(/value="0 0"/.test(titleClip), '中间档的纵向位置是 0');
assert.ok(/一句字幕/.test(built.srt) && /00:00:00,500 --> 00:00:01,500/.test(built.srt), 'subtitles.srt 与时间线同一份表');
assert.equal(built.subtitles, 1);
assert.ok(/<sequence format="r1" duration="180\/30s"/.test(built.xml), 'sequence 时长 = 成片总长');
/* text-style：DTD 1.10 的属性（不是 CSS）；默认与预览/烧录同源，高亮写 backgroundColor。 */
assert.ok(/<text-style font="PingFang SC" fontSize="54" fontColor="1 1 1 1" bold="1" alignment="center" shadowColor="0 0 0 0\.9"/.test(built.xml),
  '字幕样式按 DTD 属性写出（字体 / 字号 / 字色 / 粗体 / 投影）');
assert.ok(!/backgroundColor=/.test(built.xml), '不高亮就不写底色');
const hlPlan = { ...plan, captions: [{ ...plan.captions[0], highlight: true }] };
const hl = await buildFCPXML({ ...ctx, buildRenderPlan: async () => hlPlan }, { bundle: false });
assert.ok(/backgroundColor="0 0 0 0\.55"/.test(hl.xml), '高亮底色写进 text-style（黑 55%，与成片一致）');
/* 可配置：工程上的 fcpTitle 与调用方的 opts.titleStyle 两条路都要生效，后者优先。 */
const styledProj = { ...proj, fcpTitle: { font: 'Microsoft YaHei', sizePx: 64, color: '1 0.9 0.8 1', backgroundColor: '0.1 0.2 0.3 0.7' } };
const styled = await buildFCPXML({ ...ctx, proj: styledProj, buildRenderPlan: async () => hlPlan }, { bundle: false });
assert.ok(/font="Microsoft YaHei" fontSize="64" fontColor="1 0\.9 0\.8 1"/.test(styled.xml), 'proj.fcpTitle 改字体/字号/字色');
assert.ok(/backgroundColor="0\.1 0\.2 0\.3 0\.7"/.test(styled.xml), 'proj.fcpTitle 改高亮底色');
const over = await buildFCPXML({ ...ctx, proj: styledProj, buildRenderPlan: async () => hlPlan },
  { bundle: false, titleStyle: { font: 'Songti SC', sizePx: 72, shadow: false } });
assert.ok(/font="Songti SC" fontSize="72"/.test(over.xml) && !/shadowColor/.test(over.xml), 'opts.titleStyle 优先且能关掉投影');
/* 写不出来的转场（一侧是 gap）照实报数，不假装写进去了。 */
const skipPlan = { ...plan, transitions: [...plan.transitions, { id: 'fade', start: 4.5, end: 5, duration: 0.5, to: 3 }] };
const skipped = await buildFCPXML({ ...ctx, buildRenderPlan: async () => skipPlan }, { bundle: true });
assert.equal(skipped.transitionsWritten, 1);
assert.equal(skipped.transitionsSkipped, 1);
assert.ok(skipped.warnings.some(w => /1 处转场没写进 XML/.test(w)), '写不出来的那一窗要报数');

/* ---------- 下载两档：单文件写真实路径，媒体包写相对路径 ---------- */
await exportFCPXML(ctx, { bundle: false });
assert.ok(saved && saved.blob && /\.fcpxml$/.test(saved.name), '应落一份 .fcpxml');
const xml = await saved.blob.text();
assert.ok(/<timeMap>/.test(xml), '倍速要写成 timeMap');
assert.ok(/lane="1"/.test(xml), '配音要挂在 lane 上');
assert.ok(/<gap /.test(xml), '没地址的段要写成 gap');
/* 真实落点 = <库根>\<类型>\<规范名>（localFileOf.path），不再是「库根/la_xxx.ext」那个不存在的地址。
   file:// 里的中文经 encodeURI 是百分号编码 —— 对着解码回可读文本的那一份比。 */
const plain = decodeURIComponent(xml);
assert.ok(/file:\/\/\/C:\/work\/assets\/视频\/场景01-雨夜街头_镜头01-推门\.mp4/.test(plain), '单文件指向本机真实落点（类型子目录 + 规范名）');
assert.ok(/C:\/work\/assets\/音频\/场景01-雨夜街头_镜头01-推门\.wav/.test(plain), '配音也要走本机文件');
assert.ok(/file:\/\/\/C:\/work\/assets\/图片\/封面\.png/.test(plain), '图片也走本机真实文件（导出始终本机优先）');
assert.ok(xml.includes('name="' + videoName + '"'), '单文件的 <asset name> 仍是同一个可读名');
assert.ok(!xml.includes('src="media/'), '单文件不写相对 media/ 路径');
assert.ok(/已导出 FCPXML/.test(status), '状态栏要说话');

const before = saved;
await exportFCPXML(ctx, { bundle: true });
assert.notEqual(saved, before, '媒体包也要落盘');
assert.ok(/媒体包/.test(saved.name), '媒体包文件名要对');
assert.ok(/已导出媒体包/.test(status), '状态栏要说媒体包');

/* ---------- 工程目录档：持久落盘、回路径，不启动任何剪辑软件 ---------- */
let projectBody = null;
const called = [];
ctx.Net = {
  ...window.Net,
  json: async (url, req) => {
    called.push(url);
    projectBody = JSON.parse(req.body);
    return { ok: true, id: 'prj1', dir: 'D:/成像/FCPXML工程/prj1',
      project: 'D:/成像/FCPXML工程/prj1/project.fcpxml', assets: 3, missingCount: 1 };
  },
};
const p = await exportProject(ctx);
assert.equal(p.ok, true);
assert.equal(p.dir, 'D:/成像/FCPXML工程/prj1');
assert.equal(p.missingCount, 1);
assert.equal(p.assets, 3);
assert.deepEqual(called, ['/fcpxml/project'], '只发一条工程目录请求，不启动软件');
assert.ok(projectBody && projectBody.fcpxml && projectBody.assets.length === 3, '工程带同一份 XML 与素材清单');
assert.ok(/一句字幕/.test(projectBody.srt), '工程里的 srt 与 XML 同源');
assert.ok(/已导出 FCPXML 工程目录/.test(status) && /1 份没取到/.test(status), '回执要说清目录与缺失数');

/* 错误处理：代理报错要说人话、结果 ok:false，且错误文本进状态栏前要转义（不能拼成 HTML）。
   以前这层用裸的 errText() / String(e)，Node 与早期装载里会二次抛错或吐 "Error: …"。 */
ctx.Net.json = async () => { throw new Error('盘满了 <script>'); };
const failed = await exportProject(ctx);
assert.equal(failed.ok, false);
assert.ok(/导出工程目录失败/.test(status) && /盘满了/.test(status), '失败要报出代理的原话');
assert.ok(!/<script>/.test(status) && /&lt;script&gt;/.test(status), '错误文本要转义');

console.log('✓ FCPXML 模块：渲染计划 → 倍速 timeMap / 转场居中重叠 / 字幕样式与高亮 / 配音 lane / gap 段 / 图片 still / 本机路径 / 三档导出 / 工程目录回执与失败转义；场景镜头名与媒体包名一致、复用素材只进包一次');
