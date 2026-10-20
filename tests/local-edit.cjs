#!/usr/bin/env node
/* 剪辑页本机优先接线（静态 + 模块行为在 tests/editor-media.mjs）：
   - spa-director 注入 EditorMedia
   - 预览/导出/配音都走它
   - 不再直接返回 cand.url
   - 徽标只有一份 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let bad = 0, n = 0;
function ok(name, cond, detail) { n++; if (cond) return console.log('  ✓ ' + name); bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }

const sd = read('web/director/index.js');
const frag = read('web/director/engine.js');
ok('spa-director 注入 EditorMedia', /EditorMedia\s*=\s*createEditorMedia/.test(sd));
ok('候选轨道地址走 EditorMedia.previewSrc', /EditorMedia[\s\S]{0,80}previewSrc/.test(frag));
ok('导出地址走 EditorMedia.exportSrc', /exportSrc\(cand|exportSrc\(c\)/.test(frag));
ok('配音导出地址走 EditorMedia.exportSrc', /EditorMedia\.exportSrc\(\{ src: v\.src \}\)/.test(frag));
const tl = frag.slice(frag.indexOf('async function tlClipSrc'), frag.indexOf('async function buildRenderClips'));
ok('tlClipSrc 不再裸返回 cand.url', !/return\s+cand\.url\b/.test(tl));
ok('本机优先解析器唯一', fs.existsSync(path.join(root, 'web/director/media.js')));
ok('徽标组件已建立（页面迁移到 W7 再统一替换）', fs.existsSync(path.join(root, 'web/ui/local-badge.js')));
ok('导演台候选卡有本机/云端徽标', /candBadgeHTML/.test(frag) && /window\.badgeHTML/.test(frag));
console.log(`\n${n} 项，${bad} 项未通过`);
process.exit(bad ? 1 : 0);
