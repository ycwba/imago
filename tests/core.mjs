import assert from 'node:assert/strict';
import { createActivity } from '../web/core/activity.js';
import { createHooks } from '../web/core/hooks.js';
import { createActionRegistry } from '../web/core/actions.js';
import { badgeOf } from '../web/ui/badge-state.js';
import { innerMedia, upKeyOf } from '../web/domain/identity.js';
import { estimateTokens, redactSecrets } from '../web/domain/chat/text-util.js';

/* activity */
let route = { file: 'director.html' };
let pageVisible = true;
const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
const A = createActivity({ getRoute: () => route, doc });
assert.equal(A.visible('director.html'), true);
assert.equal(A.visible('studio.html'), false);
doc.hidden = true;
assert.equal(A.visible('director.html'), false);
doc.hidden = false;
A.setPageVisible(false);
assert.equal(A.visible('director.html'), false);
A.setPageVisible(true);
assert.equal(A.visible('director.html'), true);

/* hooks */
const H = createHooks();
let flushed = 0;
H.register(() => flushed++, () => (flushed ? '还有没存的' : ''));
assert.equal(H.size(), 1);
assert.equal(H.runAll(), '还有没存的');
assert.equal(flushed, 1);

/* actions */
const R = createActionRegistry({ now: () => Date.now() });
let ran = 0;
R.register({
  id: 'demo.read', effect: 'read', route: 'director.html',
  input: { type: 'object', properties: { n: { type: 'number', min: 1, max: 5 } }, required: ['n'] },
  check: a => ({ ok: true, plan: { n: a.n } }),
  run: a => { ran += a.n; return { ok: true, resultSummary: '跑了 ' + a.n }; },
});
R.register({
  id: 'demo.write', effect: 'write', route: 'director.html', undo: 'demo.undo', busyKey: 'd',
  check: () => ({ ok: true, plan: {} }),
  run: async () => { await new Promise(r => setTimeout(r, 40)); ran++; return { ok: true }; },
});
R.register({ id: 'demo.undo', effect: 'read', check: () => ({ ok: true }), run: () => ({ ok: true }) });
R.register({ id: 'demo.cost', effect: 'cost', cancel: false, check: () => ({ ok: true }), run: () => ({ ok: true }) });
assert.throws(() => R.register({ id: 'bad', effect: 'write', check() {}, run() {} }), /undo/);
assert.throws(() => R.register({ id: 'demo.read', effect: 'read', check() {}, run() {} }), /重复/);
assert.equal(R.list({ route: 'director.html' }).length >= 4, true);
assert.equal(R.list({ route: 'studio.html' }).some(x => x.id === 'demo.read' || x.id === 'demo.write'), false);

const bad = await R.check('demo.read', { n: 9 });
assert.equal(bad.ok, false);
const p = await R.plan('demo.read', { n: 2 });
assert.equal(p.ok, true);
const r1 = await R.run(p.planId);
assert.equal(r1.ok, true);
assert.equal(ran, 2);
const r2 = await R.run(p.planId);
assert.equal(r2.ok, false);

const w1 = await R.plan('demo.write', {});
const w2 = await R.plan('demo.write', {});
const pr1 = R.run(w1.planId);
const pr2 = await R.run(w2.planId);
assert.equal(pr2.ok, false, '同一 busyKey 的第二个写动作应被拒绝');
assert.equal((await pr1).ok, true);
assert.equal((await R.run(w1.planId)).ok, false, 'token 只能用一次');

const now = await R.runNow('demo.read', { n: 1 });
assert.equal(now.ok, true);
assert.equal(R.describe('demo.write').undo, 'demo.undo');

assert.deepEqual(badgeOf({ local: true, cloud: false }), { show: true, label: '本机', cls: 'local', why: '只在本机（本地上传或本机资产库）' });
assert.equal(badgeOf({ local: true, cloud: true }).label, '本机+云端');
assert.equal(badgeOf({ local: false, cloud: false }).show, false);
assert.equal(badgeOf({ local: true, cloud: true }, false).show, false);
assert.equal(innerMedia('/getv?url=' + encodeURIComponent('https://x/a.mp4?Signature=1')), 'https://x/a.mp4?Signature=1');
const u = new URL('https://x.test/a.mp4?Signature=1&Expires=2&k=3');
assert.equal(upKeyOf(u), 'x.test/a.mp4?k=3');

assert.ok(estimateTokens('中文提示词 test') > 0);
const red = redactSecrets('sk-proj-abcdefghijklmnop Bearer abcdefghijklmnop api_key=abcdefgh');
assert.ok(!red.includes('sk-proj-abcdefghijklmnop'));
assert.ok(!red.includes('Bearer abcdefghijklmnop'));
assert.ok(!red.includes('api_key=abcdefgh'));

console.log('✓ core modules 行为通过');
