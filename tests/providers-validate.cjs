#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateProviders, validateAssetStore } = require('../server/providers/validate.js');
const good = { id: 'a', name: 'A', kind: 'image', relay: '/a', models: [{ id: 'm' }], endpoints: { create: '/x' } };
const dupId = { ...good, name: 'A2' };
const shared = { id: 'b', name: 'B', kind: 'video', relay: '/a', endpoints: { models: '/models' } };
const docOnly = { id: 'c', name: 'C', kind: 'audio', relay: '/c', newModelDefaults: { modes: ['text_to_speech'] } };
const text = { id: 'd', name: 'D', kind: 'text', relay: '/textai', endpoints: { chat: '/chat/completions' } };
const bad = { id: 'b', kind: 'nope', relay: 'b' };
const r = validateProviders([good, dupId, shared, docOnly, text, bad]);
assert.equal(r.ok, false);
assert.ok(r.invalid.some(x => x.id === 'a' && x.errors.some(e => /id 重复/.test(e))));
assert.ok(!r.invalid.some(x => /relay 重复/.test(x.errors.join(''))), 'relay 共用是合法声明');
assert.ok(r.invalid.some(x => x.id === 'b' && x.errors.some(e => /kind/.test(e))));
assert.ok(r.sharedRelays.includes('/a'));
assert.equal(validateProviders([good, shared, docOnly, text]).ok, true);
assert.equal(validateProviders([{ id: 'x', name: 'X', kind: 'video', relay: '/x' }]).ok, false, '没有型号来源要报错');
assert.equal(validateProviders([{ id: 'x', name: 'X', kind: 'text', relay: '/x' }]).ok, false, '文字缺 chat 要报错');
console.log('✓ provider 声明校验通过');

/* 真实注册表也要过同一套（这张判据以前只测 fixture，
   新加一家平台写坏了、`/capabilities` 少一档、设置页下拉空着，这里都不会红）。
   registry 从 app.js 搬进 registry-config.js 之后，测试才拿得到它 —— 搬之前那 3000 行
   组合根 require 一次就把整个代理连 .env 带监听都起起来了，所以只能测假的。 */
const { REGISTRY } = require('../server/registry-config.js');
assert.ok(Array.isArray(REGISTRY.providers) && REGISTRY.providers.length > 0, '真实注册表读不出来（REGISTRY.providers 空了？）');
const real = validateProviders(REGISTRY.providers);
assert.ok(real.ok, '真实注册表有坏声明：\n' + real.errors.map(e => '  · ' + e).join('\n'));
/* 四档都得有人：少一档不是「这一类还没接」，是设置页与工作台那一档整排空掉，
   而页面按声明画图，不会报错也不会有人发现。 */
assert.deepEqual(['image', 'video', 'audio', 'text'].filter(k => !REGISTRY.providers.some(p => p.kind === k)), [],
  '真实注册表缺类型档');

/* 上面那句 ok 之后，这条判据本身还是可能永远绿：校验器对着**一份本来就没毛病的表**
   当然回 true，谁也不知道它认不认得出真实条目长坏的样子。这里拿真实表的第一家改一个字，
   要求它必须被标红 —— 判据自己也得被验一次。 */
const corrupt = REGISTRY.providers.map((p, i) => (i === 0 ? { ...p, kind: 'nope' } : p));
const caught = validateProviders(corrupt);
assert.equal(caught.ok, false, '把真实注册表第一家改成非法 kind，校验器却没红 —— 上面那条真实表判据是空的');
assert.ok(caught.invalid.some(x => x.id === REGISTRY.providers[0].id && /kind/.test(x.errors.join(''))),
  '真实表改坏了，报错却没点名那一家');
console.log('✓ 真实注册表校验通过（' + REGISTRY.providers.length + ' 家，v' + REGISTRY.version + '）');

/* assetStore 声明（顶层一条）：/asset/<id>、渲染素材解析、本机补存三处都靠它知道
   「去问哪一家、换成响应里哪个字段的地址」。真表必须有，并且点名的供应商、retrieve 的 {id}
   与 urlFields 都得站得住 —— 坏任一样，运行期表现都是「资产永远取不回」且不抛错。
   三条变异各拆一样，要求校验器当场红。 */
const store = validateAssetStore(REGISTRY);
assert.equal(store.declared, true, '真实注册表没有 assetStore 声明：/asset/<id> 不知道去哪一家换地址');
assert.ok(store.ok, 'assetStore 声明有坏字段：\n' + store.errors.map(e => '  · ' + e).join('\n'));
const storeBad = patch => validateAssetStore(Object.assign({}, REGISTRY, { assetStore: Object.assign({}, REGISTRY.assetStore, patch) }));
assert.equal(storeBad({ provider: 'nope' }).ok, false, '点名的供应商不存在却没红');
assert.equal(storeBad({ retrieve: '/api/open/v1/assets/latest' }).ok, false, 'retrieve 少了 {id} 却没红');
assert.equal(storeBad({ urlFields: [] }).ok, false, 'urlFields 空着却没红');
assert.equal(validateAssetStore({ providers: REGISTRY.providers }).declared, false, '没有声明是合法状态');
const { resolveAssetStore } = require('../server/registry-config.js');
const resolved = resolveAssetStore(REGISTRY);
assert.ok(resolved && /^https:\/\//.test(resolved.base) && resolved.keyEnv,
  'resolveAssetStore 没从点名的供应商取到 base / keyEnv');
assert.equal(resolveAssetStore({ assetStore: { provider: 'nope', retrieve: '/x/{id}' }, providers: REGISTRY.providers }), null,
  '点名不存在时 resolveAssetStore 该回 null（不猜一家兜底）');
console.log('✓ assetStore 声明校验通过（' + resolved.provider + '）');

/* 型号清单响应形状：以前六处各抄一张字段表且互不相同（result 只有服务端认、items 只有资产库认）。
   现在统一读顶层 modelList.fields；这里验服务端那份照声明取数，并盯住页面不再长出第二张表。 */
const { modelRowsOf } = require('../server/registry-config.js');
assert.deepEqual(modelRowsOf(REGISTRY, [1]), [1], '响应本身是数组也要认');
for (const f of ['data', 'models', 'result', 'items']) {
  assert.deepEqual(modelRowsOf(REGISTRY, { [f]: [f] }), [f], '顶层 modelList.fields 里的 ' + f + ' 没被认出来');
}
assert.deepEqual(modelRowsOf(REGISTRY, { weird: [6] }), [], '没声明的字段不该被当成清单');
assert.deepEqual(modelRowsOf({ modelList: { fields: ['weird'] } }, { weird: [7] }), [7], '声明换了字段表却没照它取');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const apiSrc = read('web/domain/api.js');
assert.ok(/modelRows\(d\)\s*\{/.test(apiSrc) && /_reg\.modelList/.test(apiSrc),
  'Api.modelRows 没读注册表的 modelList 声明');
const modelSites = ['web/domain/text-ai.js', 'web/director/engine.js', 'web/pages/studio.js', 'web/pages/settings.js'];
for (const f of modelSites) {
  assert.ok(!/d\.data \|\| d\.models/.test(read(f)), f + ' 还自己抄着型号清单字段表，没走 Api.modelRows');
}
console.log('✓ 型号清单响应形状统一读 modelList 声明');
