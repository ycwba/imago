#!/usr/bin/env node
/* Capabilities 那一份缓存认的是「哪一个注册表对象」—— 不是「哪一时刻」。
   跑法：`node tests/capabilities-cache.mjs`。不联网、不起实例：上游那一路由桩 window.Net 顶替。

   为什么必须有这一条：`load(REG)` 交回来的那份数据不是它的返回值 alone —— 真正的落地是**副作用**：
   `refreshProvider` → `apply(REG, provId, capsById)` 按 `REG.providers` 找到那一家、就地写
   `prov.models[i].options`。所以「这一轮已经富化过」只对**那一个对象**成立。
   设置页手填 / 隐藏 / 取回一个型号会经 `Api.invalidateModels()` 把 registry 缓存置空，
   下一次 `Api.registry()` 交回的是一个**全新对象**；而四个调用点（工作台 / 素材库 / 导演台右栏 / 助手）
   都是把现取的那个对象递进来。缓存不认身份，新对象就被当成「30 秒里已经问过」直接回旧结果：
   那一家的参数档位、价格表、参考素材槽整块退回静态声明，最长 30 秒，且一次 `wb:cap-ready` 都不投 ——
   界面上是「刚在设置里改了型号，工作台那一栏空了」，看不出跟缓存有关系。

   第二条守的是「全军覆没那一轮不许当成功缓 30 秒」：`byId` 是 `{}`，真值。
   上游整体坏掉时按成功缓存，表现是「重试一次要等 30 秒」。 */
let bad = 0, n = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 一上游答复：m1 / m2 各有 quality 三档与一个参考图槽。界面读的就是合进 `model.options` 的那一层。 */
const CAPS = {
  source: 'api',
  models: {
    m1: { parameters: { quality: { allowedValues: ['low', 'medium', 'high'], default: 'high' } },
      modes: { text_to_image: { inputs: [{ role: 'reference_image', media_type: 'image', max: 3 }] } } },
    m2: { parameters: { quality: { allowedValues: ['1080', '4k'] } },
      modes: { text_to_image: { inputs: [{ role: 'reference_image', media_type: 'image', max: 1 }] } } },
  },
};

const calls = [];
const events = [];
let mode = 'ok';               // ok | slow | fail
let slowMs = 0;
const response = () => (mode === 'fail'
  ? { ok: false, status: 500, json: async () => ({}) }
  : { ok: true, status: 200, json: async () => CAPS });

const stub = {
  Net: {
    fetch: async (q) => {
      calls.push(q);
      if (slowMs) await sleep(slowMs);
      return response();
    },
  },
  /* 三家筛料那一路只问 Api.provUsable：桩成「全在用」，让每一家都真的被问到。 */
  Api: { envStatus: async () => ({}), envKnown: () => true, provUsable: () => true },
  dispatchEvent: (e) => { events.push(e && e.detail && e.detail.id); return true; },
};
globalThis.window = stub;
/* 模块里读的是**裸名**（`Api.envStatus` / `Net.fetch`）—— 浏览器里 window 上的键同时就是全局，
   Node 不会自动把 `window.Api` 挂成 `Api`。不补这一步，`canJudge` 会永远为假、
   「本机在用的那几家」那一道筛选根本没进判据（现象是桩里改筛选判据、判据照样绿）。 */
globalThis.Net = stub.Net;
globalThis.Api = stub.Api;

/* 一个「新注册表对象」= 同样内容、全新的一棵树。invalidateModels 之后交回的就是这种。 */
const mkReg = (ids) => ({ providers: [{ id: 'p1', keyId: 'p1', name: '平台一',
  endpoints: { models: '/v1/models' }, models: ids.map(id => ({ id, name: id.toUpperCase() })) }] });
const optOf = (REG, id) => {
  const p = REG.providers[0];
  const m = (p.models || []).find(x => x.id === id) || null;
  return (m && m.options) || null;
};
/* 判「这一个对象有没有被富化」：整条链每一步都可能没建成，判据红了也不该由它自己抛出
   （抛出的那一条会带走同一轮剩下的所有断言）。 */
const enriched = (REG, id, n) => {
  const q = optOf(REG, id)?.qualities;
  return Array.isArray(q) && q.length === n;
};

try {
  await import('../web/domain/capabilities.js');
  const Cap = globalThis.window.Capabilities;
  ok('模块把 window.Capabilities 交出来了', !!Cap && typeof Cap.load === 'function');

  /* ① 第一轮：正常富化 */
  const REG1 = mkReg(['m1']);
  const first = calls.length;
  await Cap.load(REG1);
  ok('第一轮确实问过上游', calls.length - first === 1, 'got ' + (calls.length - first));
  ok('第一轮把 quality 三档合进了 options', enriched(REG1, 'm1', 3),
    'got ' + JSON.stringify(optOf(REG1, 'm1')));
  ok('一家落定广播一次 wb:cap-ready', events.includes('p1'));

  /* ② 同一个对象再问：30 秒 TTL 内直接回结果，一次请求都不发 */
  const second = calls.length;
  await Cap.load(REG1);
  ok('同一个注册表对象重复 load 不再打上游', calls.length === second, 'got +' + (calls.length - second));

  /* ③ 换了一个对象（invalidateModels 那一路）：必须重新走一轮，副作用要落在新对象上 */
  mode = 'ok';
  const REG2 = mkReg(['m1', 'm2']);       // 设置页刚取回 / 手填了一个型号
  const third = calls.length;
  await Cap.load(REG2);
  ok('换了注册表对象会重新问一轮', calls.length > third, 'got +' + (calls.length - third));
  ok('新对象拿得到参数档位', enriched(REG2, 'm1', 3) && enriched(REG2, 'm2', 2),
    'got ' + JSON.stringify(optOf(REG2, 'm2')));

  /* ④ 在途期间换了对象：两条各自一轮，谁都不能合到别人那条船上 */
  mode = 'slow'; slowMs = 30;
  const REG3 = mkReg(['m1']), REG4 = mkReg(['m1']);
  const fourth = calls.length;
  const p3 = Cap.load(REG3);
  const p4 = Cap.load(REG4);
  await Promise.all([p3, p4]);
  slowMs = 0; mode = 'ok';
  ok('不同对象的在途不互相顶替（各问一轮）', calls.length - fourth === 2, 'got ' + (calls.length - fourth));
  ok('两个对象都被富化', enriched(REG3, 'm1', 3) && enriched(REG4, 'm1', 3));

  /* ⑤ 同一对象的并发仍合船：一次请求都不多发 */
  const REG5 = mkReg(['m1']);
  await Cap.load(REG5);                     // 先让它落定（进入 TTL）
  const REG6 = mkReg(['m1']);
  mode = 'slow'; slowMs = 30;
  const fifth = calls.length;
  await Promise.all([Cap.load(REG6), Cap.load(REG6), Cap.load(REG6)]);
  slowMs = 0; mode = 'ok';
  ok('同一对象的并发调用共船', calls.length - fifth === 1, 'got +' + (calls.length - fifth));
  ok('REG5 与 REG6 是两个对象（前一轮没把后一轮顶掉）',
    enriched(REG5, 'm1', 3) && enriched(REG6, 'm1', 3));

  /* ⑥ force 绕过两层 */
  const sixth = calls.length;
  await Cap.load(REG6, { force: true });
  ok('force 那一档照常问上游', calls.length - sixth === 1, 'got +' + (calls.length - sixth));

  /* ⑦ 全军覆没：models 落空、且下一轮立刻再试（不在 TTL 里等 30 秒） */
  mode = 'fail';
  const REG7 = mkReg(['m1']);
  await Cap.load(REG7, { force: true });
  ok('一家都没问出来时不留一份空的「成功」', Cap.models === null, 'got ' + JSON.stringify(Cap.models));
  const seventh = calls.length;
  await Cap.load(REG7);
  ok('空的那一轮不算成功，下一轮马上重问', calls.length > seventh, 'got +' + (calls.length - seventh));
  mode = 'ok';
} catch (e) {
  bad++; console.log('  ✗ 判据本身抛出：' + ((e && e.message) || e));
}

console.log(bad ? '\n✗ Capabilities 缓存：' + bad + ' 项未通过' : '\n✓ Capabilities 缓存：' + n + ' 项全过');
process.exit(bad ? 1 : 0);
