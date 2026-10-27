#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateProviders, validateAssetStore, validateInterfaceShapes } = require('../server/providers/validate.js');
const good = { id: 'a', name: 'A', kind: 'image', relay: '/a', models: [{ id: 'm' }], endpoints: { create: '/x' } };
const dupId = { ...good, name: 'A2' };
const docOnly = { id: 'c', name: 'C', kind: 'audio', relay: '/c', newModelDefaults: { modes: ['text_to_speech'] } };
const text = { id: 'd', name: 'D', kind: 'text', relay: '/textai/d', endpoints: { chat: '/chat/completions' } };
const bad = { id: 'b', kind: 'nope', relay: 'b' };
/* relay 共用只允许「等价声明」（base / keyEnv / endpoints 完全一致）：
   前缀挂了不等价的几家，转发按前缀取第一家，第二家的请求与密钥会打到第一家的地址上
   （v19 以前八家文字 AI 共用 /textai，OpenAI 的密钥被原样发给 api.deepseek.com）。 */
const equiv1 = { id: 'e1', name: 'E1', kind: 'video', relay: '/eq', keyId: 'eq', base: 'https://eq.example', keyEnv: 'EQ_KEY',
  endpoints: { create: '/gen', models: '/models' }, models: [{ id: 'm' }] };
const equiv2 = { ...equiv1, id: 'e2', kind: 'image' };           // 等价：合法共用
const inequiv = { ...equiv1, id: 'e3', base: 'https://other.example' };  // base 不同：必须红
const r = validateProviders([good, dupId, equiv1, equiv2, docOnly, text, bad, inequiv]);
assert.equal(r.ok, false);
assert.ok(r.invalid.some(x => x.id === 'a' && x.errors.some(e => /id 重复/.test(e))));
assert.ok(r.sharedRelays.includes('/eq'), '等价共用要登记在 sharedRelays');
assert.ok(!r.invalid.some(x => (x.id === 'e1' || x.id === 'e2') && /relay 前缀/.test(x.errors.join(''))),
  '等价声明共用 relay 是合法的');
assert.ok(r.invalid.some(x => x.id === 'e3' && /relay 前缀/.test(x.errors.join(''))), '不等价共用 relay 要红');
assert.ok(r.invalid.some(x => x.id === 'b' && x.errors.some(e => /kind/.test(e))));
assert.equal(validateProviders([good, equiv1, equiv2, docOnly, text]).ok, true);
assert.equal(validateProviders([{ id: 'x', name: 'X', kind: 'video', relay: '/x' }]).ok, false, '没有型号来源要报错');
assert.equal(validateProviders([{ id: 'x', name: 'X', kind: 'text', relay: '/x' }]).ok, false, '文字缺 chat 要报错');
/* extraCaps（语音识别 / 联网搜索）：拼错一个字母不会报错、只会让设置页少一格 —— 值必须按白名单查，
   而且只能挂在文字供应商上（只有它们才有 /audio/transcriptions 与对话模型）。 */
assert.equal(validateProviders([{ ...text, id: 'x1', relay: '/textai/x1', extraCaps: ['asr', 'search'] }]).ok, true, 'asr / search 是登记过的档');
assert.equal(validateProviders([{ ...text, id: 'x2', relay: '/textai/x2', extraCaps: ['asrr'] }]).ok, false, '拼错的 extraCaps 要红');
assert.equal(validateProviders([{ ...text, id: 'x3', relay: '/textai/x3', extraCaps: 'asr' }]).ok, false, 'extraCaps 不是数组要红');
assert.equal(validateProviders([{ ...good, id: 'x4', relay: '/x4', extraCaps: ['asr'] }]).ok, false, '图片供应商声明 asr 要红');
/* 多段 relay（/textai/<id> 这种一段家族名 + 一段 id）是合法形状 */
assert.equal(validateProviders([{ ...good, id: 'p1', relay: '/textai/p1' }]).ok, true, '多段 relay 要认');
/* 声明了输入槽位（inputRoles）就必须有 create.inputTemplates 把它放进提交体 ——
   差一个就是「槽位画得出来、提交那一刻整个丢掉」，用户放了素材、钱照扣。 */
const slots = { id: 's1', name: 'S1', kind: 'video', relay: '/s1', endpoints: { create: '/x' },
  models: [{ id: 'm', inputRoles: { first_frame: { max: 1 } } }],
  create: { endpoint: 'create', body: { model: 'model' } } };
assert.equal(validateProviders([slots]).ok, false, 'inputRoles 没有对应 inputTemplates 要红');
assert.ok(validateProviders([slots]).errors.join('').includes('first_frame'));
slots.create.inputTemplates = { first_frame: { to: 'image', many: false, tmpl: '$url' } };
assert.equal(validateProviders([slots]).ok, true, '补上模板就合法');
/* TTS 模板族豁免：复刻的参考音频按约定走 create.template 的 {{voice}}（gen-forms.synthTts 同一收口），
   不走 inputTemplates —— 有 tts 声明的家族不按槽位查模板。 */
const ttsClone = { id: 't1', name: 'T1', kind: 'audio', relay: '/t1', endpoints: { create: '/x' },
  tts: { voices: [], textRole: 'assistant', styleRole: 'user', responsePath: 'x' },
  modelDocs: [{ id: 'm', ttsMode: 'clone', inputRoles: { reference_audio: { max: 1, min: 1 } } }],
  create: { endpoint: 'create', template: { model: '{{model}}', audio: { voice: '{{voice}}' } } } };
assert.equal(validateProviders([ttsClone]).ok, true, 'TTS 模板族的复刻槽位按约定走 {{voice}}，不该红');
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

/* interfaceShapes（自定义供应商的接口族）：template 必须真实存在；
   声明了 needs:['retrieve'] 的族，模板必须有 endpoints.retrieve + retrieve 配置 ——
   以前 file-id-retrieve 形状写着「要再换一次地址」，模板却没有 retrieve 环节，
   按那一族添加的自定义供应商永远换不到产物地址，谁都不会红。 */
const shapes = validateInterfaceShapes(REGISTRY);
assert.ok(shapes.ok, '真实 interfaceShapes 有坏声明：\n' + shapes.errors.join('\n'));
const fakeReg = { providers: [{ id: 't1', name: 'T', kind: 'video', relay: '/t1', models: [{ id: 'm' }], endpoints: { create: '/x' } }],
  interfaceShapes: { video: [{ id: 'fr', name: 'F', template: 't1', needs: ['retrieve'] }] } };
assert.equal(validateInterfaceShapes(fakeReg).ok, false, '承诺 retrieve 而模板没有要红');
assert.equal(validateInterfaceShapes({ providers: fakeReg.providers, interfaceShapes: { video: [{ id: 'fr', name: 'F', template: 'nope' }] } }).ok, false,
  'template 指向不存在的 id 要红');
assert.equal(validateInterfaceShapes({ providers: fakeReg.providers }).ok, true, '没有 interfaceShapes 是合法状态');
console.log('✓ interfaceShapes 声明校验通过');

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
