#!/usr/bin/env node
/* 型号偏好：
   ① 按「账号 + 能力档」分槽（同一 keyId 的文字档与语音档互不串）；
   ② 旧格子（按账号存）只作兜底，并按 modelsFilter / modelsExclude 过滤；
   ③ 按型号存输入能力，'auto' 删掉覆盖；④ 写 media 不会抹掉同一格的 typed / off / got；
   ⑤ 认不出这一家就不写。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const src = read('web/domain/gen-forms.js');
const at = src.indexOf('window.ModelPrefs = {');
const end = src.indexOf('\n};', at) + 3;
assert.ok(at > 0 && end > at, 'gen-forms.js 里应当找得到 ModelPrefs 那一段');

const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  key: i => [...store.keys()][i] || null,
  get length() { return store.size; },
};
const ctx = { window: {}, localStorage, console };
vm.createContext(ctx);
vm.runInContext(src.slice(at, end), ctx);
const MP = ctx.window.ModelPrefs;
const prov = { id: 'p1-text', keyId: 'p1', kind: 'text' };
const pv = { id: 'v1', keyId: 'v1', kind: 'video' };
/* 同一把密钥下的语音档：与文字档共用 /v1/models（MiMo 那种），清单必须各存各的。 */
const pa = { id: 'p1-audio', keyId: 'p1', kind: 'audio' };

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

ok(MP && typeof MP.mediaOf === 'function' && typeof MP.setMedia === 'function', 'ModelPrefs 没长出 media 读写口');
MP.addTyped(prov, 'm1');
MP.addTyped(prov, 'm2');
MP.setOff(pv, 'x', true);
MP.setGot(prov, [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }]);
MP.setMedia(prov, 'm1', 'video', 'off');
MP.setMedia(prov, 'm1', 'audio', 'on');
ok(MP.mediaOf(prov, 'm1').video === 'off' && MP.mediaOf(prov, 'm1').audio === 'on', '按型号记两档覆盖');
ok(Object.keys(MP.mediaOf(prov, 'm2')).length === 0, '另一个型号不串档');
ok(MP.typed(prov).join(',') === 'm1,m2' && MP.got(prov).length === 2 && MP.isOff(pv, 'x'), '写 media 没抹掉 typed / off / got');
MP.setMedia(prov, 'm1', 'video', '');
ok(MP.mediaOf(prov, 'm1').video === undefined && MP.mediaOf(prov, 'm1').audio === 'on', 'auto 只删这一档覆盖');
MP.setMedia(prov, 'm1', 'audio', '');
ok(Object.keys(JSON.parse(store.get('sk_model_prefs'))['p1:text'].media).length === 0, '最后一档删掉后不留空型号');
MP.setMedia({ id: '', keyId: '' }, 'm1', 'video', 'on');
ok(!JSON.parse(store.get('sk_model_prefs')).unknown, '认不出这一家就不写');

/* 分槽：同一个 keyId 下语音档看不到文字档的型号；语音档自己的清单也落在自己的槽里。 */
MP.setGot(pa, [{ id: 'tts-1', name: 'TTS' }]);
ok(MP.got(prov).length === 2 && MP.got(pa).length === 1, '同一账号的两类各存各的清单');
ok(MP.got(pa)[0].id === 'tts-1' && !MP.got(prov).some(m => m.id === 'tts-1'), '语音型号没混进文字档');

/* 旧格子（按账号存）：只作兜底，并按这一条的 modelsFilter / modelsExclude 过滤。
   MiMo 的文字档 modelsExclude='-tts'、语音档 modelsFilter='-tts'。 */
const raw = JSON.parse(store.get('sk_model_prefs'));
raw.legacy = { typed: ['mimo-v2.6-flash', 'mimo-v2.5-tts'], off: [], got: [{ id: 'mimo-v2.6-flash' }, { id: 'mimo-v2.5-tts' }], media: {} };
store.set('sk_model_prefs', JSON.stringify(raw));
const pText = { id: 'legacy-text', keyId: 'legacy', kind: 'text', modelsExclude: '-tts' };
const pAudio = { id: 'legacy-audio', keyId: 'legacy', kind: 'audio', modelsFilter: '-tts' };
ok(MP.typed(pText).join(',') === 'mimo-v2.6-flash', '旧格子的文字档只读到非 TTS 型号');
ok(MP.got(pText).map(m => m.id).join(',') === 'mimo-v2.6-flash', '旧格子的 got 也按 modelsExclude 过滤');
ok(MP.typed(pAudio).join(',') === 'mimo-v2.5-tts', '旧格子的语音档只读到 TTS 型号');
MP.addTyped(pText, 'mimo-v2.7-flash');
ok(JSON.parse(store.get('sk_model_prefs'))['legacy:text'].typed.join(',') === 'mimo-v2.6-flash,mimo-v2.7-flash'
  && MP.typed(pText).join(',') === 'mimo-v2.6-flash,mimo-v2.7-flash', '旧格子兜底出来的清单会带进新槽，之后只读新槽');
MP.dropKind('legacy', 'text');
ok(!JSON.parse(store.get('sk_model_prefs'))['legacy:text'] && MP.typed(pAudio).join(',') === 'mimo-v2.5-tts',
  'dropKind 只摘那一类，另一类不受影响');
MP.drop('legacy');
ok(!MP.typed(pAudio).length && !MP.typed(pText).length, 'drop 摘掉账号下的所有能力槽与旧格子');

console.log('型号输入能力记录：' + n + ' 条断言通过');
