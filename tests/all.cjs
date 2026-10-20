#!/usr/bin/env node
/* 一键测试 —— 跑法：`node tests/all.cjs`（加 `--e2e` 或 ALL_E2E=1 跑浏览器）
   顺序：语法 → 常驻测试 → 架构 → metrics。W0 起作为重构的固定入口。
   日常不必整包跑这一份：`npm run check`（<3 秒）与 `npm run test:fast`（按改动挑判据）
   才是提交前的常手，这一份是合并前的全量（报告 §7.2 的三档流程）。
   语法段不在这里重写：与 `npm run check` 共用 `tests/syntax.cjs` 那一份判据。 */
'use strict';
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
let bad = 0;
const run = (name, cmd, args, opts = {}) => {
  console.log('\n=== ' + name + ' ===');
  const r = cp.spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...(opts.env || {}) } });
  if (r.status !== 0) { bad++; console.log('✗ ' + name + '（退出码 ' + r.status + '）'); }
};

/* ---------- 语法（tests/syntax.cjs：扫仓库里每个源码文件，两种解析模式都试） ---------- */
console.log('=== 语法 ===');
bad += require('./syntax.cjs').run();

/* ---------- 常驻测试 ---------- */
run('tests/selfcheck.cjs', process.execPath, ['tests/selfcheck.cjs']);
run('tests/editing.cjs', process.execPath, ['tests/editing.cjs']);
run('tests/local-first.cjs', process.execPath, ['tests/local-first.cjs']);
run('tests/relay-retry.cjs', process.execPath, ['tests/relay-retry.cjs']);
run('tests/index-store.cjs', process.execPath, ['tests/index-store.cjs']);
run('tests/core.mjs', process.execPath, ['tests/core.mjs']);
run('tests/ui-catalog.cjs', process.execPath, ['tests/ui-catalog.cjs']);
run('tests/editor-media.mjs', process.execPath, ['tests/editor-media.mjs']);
run('tests/local-edit.cjs', process.execPath, ['tests/local-edit.cjs']);
run('tests/fcpxml-client.mjs', process.execPath, ['tests/fcpxml-client.mjs']);
run('tests/director-util.mjs', process.execPath, ['tests/director-util.mjs']);
run('tests/director-board.mjs', process.execPath, ['tests/director-board.mjs']);
run('tests/director-split-assets.mjs', process.execPath, ['tests/director-split-assets.mjs']);
/* 拆分镜的「新素材」：重复出现才建 / 名字对不上不建 / 占位符词法 / 建档落点。 */
run('tests/director-board-assets.mjs', process.execPath, ['tests/director-board-assets.mjs']);
/* 项目组：老工程零迁移 / 建组 / 归组 / 删组 / 改名 / 树 / 组名即素材组名。 */
run('tests/director-groups.mjs', process.execPath, ['tests/director-groups.mjs']);
/* 发送前预览（dry-run）：预览与实发同源 / 不发网络请求 / 占位符 / 展示形状。 */
run('tests/raw-preview.mjs', process.execPath, ['tests/raw-preview.mjs']);
/* 项目引用规则：Skill 正文里的变量占位符（{cast} {what} …）按项目填料。 */
run('tests/skill-refvars.mjs', process.execPath, ['tests/skill-refvars.mjs']);
/* 接续拆分镜的纯算法：顺序 / 依赖原因码 / 选型 / 拆分守恒 / 报价键与合计。 */
run('tests/director-chain.mjs', process.execPath, ['tests/director-chain.mjs']);
/* 依赖式批量调度：等上一镜、失败级联、等待不占提交名额。 */
run('tests/director-genall.mjs', process.execPath, ['tests/director-genall.mjs']);
/* 场景镜头命名：本机素材名与 FCPXML 包内名同源（补零 / 截断 / 单扩展名 / 去重）。 */
run('tests/director-naming.mjs', process.execPath, ['tests/director-naming.mjs']);
run('tests/director-slice.mjs', process.execPath, ['tests/director-slice.mjs']);
run('tests/director-playback.mjs', process.execPath, ['tests/director-playback.mjs']);
run('tests/director-segments.mjs', process.execPath, ['tests/director-segments.mjs']);
run('tests/director-timeline.mjs', process.execPath, ['tests/director-timeline.mjs']);
run('tests/director-voice.mjs', process.execPath, ['tests/director-voice.mjs']);
run('tests/director-subtitles.mjs', process.execPath, ['tests/director-subtitles.mjs']);
run('tests/director-plan.mjs', process.execPath, ['tests/director-plan.mjs']);
run('tests/director-waveform.mjs', process.execPath, ['tests/director-waveform.mjs']);
run('tests/director-projection.mjs', process.execPath, ['tests/director-projection.mjs']);
run('tests/director-voice-block.mjs', process.execPath, ['tests/director-voice-block.mjs']);
/* 台词清单：剪辑右栏「台词」那一档的一份渲染（说话人缩略图 / 本镜与全片两个时间 / 三种状态）。 */
run('tests/director-lines.mjs', process.execPath, ['tests/director-lines.mjs']);
/* 剧本视图：分镜现算成稿、改稿只写回镜头上的画面（台词不在稿子里，也不跟着画面动）。 */
run('tests/director-script.mjs', process.execPath, ['tests/director-script.mjs']);
/* 导出格式只有一张表：页头按钮 / engine 分派 / 助手枚举都从它派生（报告 §6.2）。 */
run('tests/export-formats.cjs', process.execPath, ['tests/export-formats.cjs']);
/* 自由画布的六份纯模块：注册表 / 文档 / 操作 / 历史 / 空间索引 / 生成桥。
   画布页只有一个 commit() 写出口，规则全压在这几份里 —— 它们红了，页面上点什么都白点。 */
run('tests/canvas-registry.mjs', process.execPath, ['tests/canvas-registry.mjs']);
run('tests/canvas-doc.mjs', process.execPath, ['tests/canvas-doc.mjs']);
run('tests/canvas-ops.mjs', process.execPath, ['tests/canvas-ops.mjs']);
run('tests/canvas-history.mjs', process.execPath, ['tests/canvas-history.mjs']);
run('tests/canvas-spatial.mjs', process.execPath, ['tests/canvas-spatial.mjs']);
run('tests/canvas-gen.mjs', process.execPath, ['tests/canvas-gen.mjs']);
run('tests/providers-validate.cjs', process.execPath, ['tests/providers-validate.cjs']);
run('tests/asr-settings.mjs', process.execPath, ['tests/asr-settings.mjs']);
/* 设置键一张账（报告 §6.2「5 份清单已出现漂移」）：界面偏好只由 ui.js 的 UI_PREFS 决定，
   同步 / 导出 / 恢复默认三份名单从它现取；新加一项设置没登记就在这里红。 */
run('tests/settings-schema.cjs', process.execPath, ['tests/settings-schema.cjs']);
run('tests/skill-hub.mjs', process.execPath, ['tests/skill-hub.mjs']);
run('tests/zip.cjs', process.execPath, ['tests/zip.cjs']);
/* 生成前校验一致性（报告 §7.3③）：页面与助手对同一组 fixture 必须给同一个结论。
   写好了没登记就等于没跑过 —— 这一条与下面两条同批登记（§7.1 说的「孤儿判据」）。 */
run('tests/gen-rules.mjs', process.execPath, ['tests/gen-rules.mjs']);
/* 路由工厂的 ctx 注入 + 每条端点走一遍假 req/res（报告 §7.3①）：
   pick-dir 那一类「函数体用了没解构的变量 / 少注入一个 key」的坏法，只有真调一次才会红。 */
run('tests/routes-smoke.cjs', process.execPath, ['tests/routes-smoke.cjs']);
/* 静态纪律五条（报告 §7.3②）：内联事件、创建点缺「结果未知」判据、空 catch 没写原因、
   裸 #RRGGBB、页面侧碰 Dropdowns 私有物。存量违例登记在案，只许减不许增。 */
run('tests/static-guards.cjs', process.execPath, ['tests/static-guards.cjs']);
run('tests/architecture.cjs', process.execPath, ['tests/architecture.cjs']);
/* metrics：本地只打印差值，CI 用 --strict 让「膨胀 / 单文件超长」真的能红（报告 §7.4）。 */
run('tests/metrics.cjs', process.execPath,
  ['tests/metrics.cjs'].concat(process.env.CI ? ['--strict'] : []));

/* ---------- 浏览器（按需） ---------- */
if (process.argv.includes('--e2e') || process.env.ALL_E2E === '1') {
  run('tests/e2e/smoke.cjs', process.execPath, ['tests/e2e/smoke.cjs']);
  run('tests/e2e/ui-visual.cjs', process.execPath, ['tests/e2e/ui-visual.cjs']);
  run('tests/e2e/proxy.cjs', process.execPath, ['tests/e2e/proxy.cjs']);
  run('tests/e2e/cloud-sync.cjs', process.execPath, ['tests/e2e/cloud-sync.cjs']);
  run('tests/e2e/asr.cjs', process.execPath, ['tests/e2e/asr.cjs']);
  run('tests/e2e/search.cjs', process.execPath, ['tests/e2e/search.cjs']);
  run('tests/e2e/chat-actions.cjs', process.execPath, ['tests/e2e/chat-actions.cjs']);
  run('tests/e2e/chat-receipt.cjs', process.execPath, ['tests/e2e/chat-receipt.cjs']);
  run('tests/e2e/assistant-dock.cjs', process.execPath, ['tests/e2e/assistant-dock.cjs']);
  run('tests/e2e/drag-guard.cjs', process.execPath, ['tests/e2e/drag-guard.cjs']);
  run('tests/e2e/actions.cjs', process.execPath, ['tests/e2e/actions.cjs']);
  run('tests/e2e/actions-feedback.cjs', process.execPath, ['tests/e2e/actions-feedback.cjs']);
  run('tests/e2e/chat-context.cjs', process.execPath, ['tests/e2e/chat-context.cjs']);
  run('tests/e2e/chat-search-cite.cjs', process.execPath, ['tests/e2e/chat-search-cite.cjs']);
  run('tests/e2e/director-perf.cjs', process.execPath, ['tests/e2e/director-perf.cjs']);
  run('tests/e2e/parity.cjs', process.execPath, ['tests/e2e/parity.cjs']);
  run('tests/e2e/skills.cjs', process.execPath, ['tests/e2e/skills.cjs']);
  run('tests/e2e/skill-hub.cjs', process.execPath, ['tests/e2e/skill-hub.cjs']);
  run('tests/e2e/fcpxml.cjs', process.execPath, ['tests/e2e/fcpxml.cjs']);
  run('tests/e2e/director-fcpxml-import.cjs', process.execPath, ['tests/e2e/director-fcpxml-import.cjs']);
  run('tests/e2e/editing-assets.cjs', process.execPath, ['tests/e2e/editing-assets.cjs']);
  run('tests/e2e/director-slice.cjs', process.execPath, ['tests/e2e/director-slice.cjs']);
  run('tests/e2e/director-lines.cjs', process.execPath, ['tests/e2e/director-lines.cjs']);
  /* 原始请求折叠条：脱敏 / 默认收起 / 导演台重画后仍展开 / 工作台三型标签。 */
  run('tests/e2e/raw-request.cjs', process.execPath, ['tests/e2e/raw-request.cjs']);
  /* 发送前预览：不用点生成就能看到将要发出的请求体 / 改提示词跟着变 / 预览不发请求。 */
  run('tests/e2e/raw-preview.cjs', process.execPath, ['tests/e2e/raw-preview.cjs']);
  /* 导演台项目组：分树 / 新建 / 老工程零迁移 / 删组不删短片。 */
  run('tests/e2e/director-groups.cjs', process.execPath, ['tests/e2e/director-groups.cjs']);
  run('tests/e2e/editing-assistant.cjs', process.execPath, ['tests/e2e/editing-assistant.cjs']);
  run('tests/e2e/render-jobs.cjs', process.execPath, ['tests/e2e/render-jobs.cjs']);
  run('tests/e2e/canvas.cjs', process.execPath, ['tests/e2e/canvas.cjs']);
  run('tests/e2e/canvas-model.cjs', process.execPath, ['tests/e2e/canvas-model.cjs']);
  run('tests/e2e/canvas-assistant.cjs', process.execPath, ['tests/e2e/canvas-assistant.cjs']);
  run('tests/e2e/canvas-port.cjs', process.execPath, ['tests/e2e/canvas-port.cjs']);
  run('tests/e2e/ui-contract.cjs', process.execPath, ['tests/e2e/ui-contract.cjs']);
  run('tests/e2e/ui-shared.cjs', process.execPath, ['tests/e2e/ui-shared.cjs']);
  run('tests/e2e/lock.cjs', process.execPath, ['tests/e2e/lock.cjs']);
} else {
  console.log('\n=== 浏览器 e2e ===\n  - 跳过（加 --e2e 或 ALL_E2E=1）');
}

console.log('\n' + (bad ? '✗ ' + bad + ' 项失败' : '✓ 全部通过'));
process.exit(bad ? 1 : 0);
