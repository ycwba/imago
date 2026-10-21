import assert from 'node:assert/strict';
import { createEditorMedia } from '../web/director/media.js';

const m = createEditorMedia({
  assetLocal: { localAssetIdOf: u => String(u).includes('sig') ? 'la_1' : '' },
  /* 注入的两把地址工具与页面里那一份同形（生产代码注入的是 window.Api）：
     mediaSrc 管「按开关选预览地址」，assetSrc 管「本机地址的唯一拼法」。 */
  api: {
    mediaSrc: u => String(u).includes('sig') ? '/asset/la_1?v=2' : '/getv?url=' + encodeURIComponent(u),
    assetSrc: id => '/asset/' + encodeURIComponent(id) + '?v=2',
  },
});
const cand = { provider: 'vgenv', vid: 'task_1', url: 'https://x.test/a.mp4?signature=sig', status: 'done' };
const e = m.entryOf(cand);
assert.equal(e.assetId, 'task_1');
assert.equal(m.localIdOf(e), 'la_1');
assert.equal(m.previewSrc(e), '/asset/la_1?v=2');
assert.equal(m.exportSrc(e), '/asset/la_1?v=2');

const cloud = { provider: 'vgenv', url: 'https://x.test/b.mp4' };
assert.equal(m.exportSrc(cloud, { fresh: 'https://fresh/b.mp4' }), 'https://fresh/b.mp4');
assert.equal(m.exportSrc({ src: '/asset/asset_9' }), '/asset/asset_9');
assert.equal(m.previewSrc(cloud), '/getv?url=' + encodeURIComponent('https://x.test/b.mp4'));
assert.equal(m.canUse(cloud), true);
assert.equal(m.canUse({}), false);
console.log('✓ editor media 解析通过');
