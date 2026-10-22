#!/usr/bin/env node
/* task_detail（助手只读工具）的判据：入参 / 号反查 / 六种「查不到」的原因码 / 字段挑选。
   平台用桩替：`Api` / `AssetLib` / `AssetLocal` / `Wb` 都只实现这个工具真正读的那几个方法，
   断言的是「助手对模型说了什么」，不是上游实现。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let bad = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

const ST = { running: '生成中', succeeded: '已完成', failed: '生成失败', pending: '排队中' };
const sandbox = {
  console, URLSearchParams, JSON, Date, Math, Number, String, Array, Object, Map, Set,
  Promise, Error, RegExp, Boolean, isNaN, parseInt, parseFloat,
  setTimeout, clearTimeout,
  errText: e => String((e && e.message) || e || ''),
  when: ms => (ms ? '@' + ms : ''),
  AssetLib: {
    tsMs(v) {
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return v > 1e12 ? v : Math.round(v * 1000);
      const t = Date.parse(String(v));
      return Number.isFinite(t) ? t : 0;
    },
  },
  Wb: { stText: s => ST[String(s || '').trim().toLowerCase()] || s || '' },
  fmtBytes: n => String(n) + 'B',
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('web/features/chat-tools.js'), sandbox);
const tools = sandbox.AiChatTools.build({
  cap: (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t; },
  when: sandbox.when,
  EF: { ids: () => ['film'], list: () => [{ id: 'film', doc: '成片' }] },
  ctxRefs: () => [],
});
const run = a => tools.TOOLS.task_detail.run(a || {});

/* ---------- 桩：平台 / 缓存 / 本机 / 花费 ---------- */
let provs = {}, calls = [], pollMap = new Map(), cache = { task: {}, asset: {} }, localUrls = {};
sandbox.Api = {
  provOf: id => provs[id] || null,
  pollMany: async (prov, ids) => { calls.push({ prov: prov.id, ids: ids.slice() }); return pollMap; },
  priceText: (prov, p) => (p && p.credits != null ? p.credits + ' 积分'
    : (p && p.priceMicros != null ? '¥' + (p.priceMicros / 1e6).toFixed(4) : '')),
  promptFor: () => '',
  mediaExpired: () => false,
  healMedia: async () => {},
};
sandbox.AssetLib.findByTaskId = (id, pid) => cache.task[id] || null;
sandbox.AssetLib.findByAssetId = (id, pid) => cache.asset[id] || null;
sandbox.AssetLocal = {
  stateOf: o => ({ local: !!(o && o.url && localUrls[o.url]), cloud: true }),
  localAssetIdOf: u => localUrls[String(u || '')] || '',
};
const reset = () => { provs = {}; calls = []; pollMap = new Map(); cache = { task: {}, asset: {} }; localUrls = {}; };

/* ---------- 六种原因码 ---------- */
reset();
let r = await run({});
ok('① 没给号：说清要给任务号或产物号', /要给任务号/.test(r.错误 || ''), JSON.stringify(r));

r = await run({ taskId: 'la_abc' });
ok('② 本机资产号：不当任务号去平台白问一次', /本机资产号/.test(r.结论 || '') && calls.length === 0, JSON.stringify(r));

r = await run({ taskId: 'nowhere_1' });
ok('③ 本机缓存没有、也没给平台：让用户补 provider', /不知道它属于哪一家平台/.test(r.结论 || ''), JSON.stringify(r));

reset();
provs.p0 = { id: 'p0', displayName: '无端点平台', endpoints: {} };
r = await run({ taskId: 't0', provider: 'p0' });
ok('④ 平台没声明可查任务的接口：照实说查不了', /没有声明可查任务的接口/.test(r.结论 || ''), JSON.stringify(r));

reset();
provs.p1 = { id: 'p1', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
r = await run({ taskId: 't1', provider: 'p1' });
ok('⑤ 列表型平台里没有这个号：说「列表里没找到」', /任务列表里没有找到/.test(r.结论 || ''), JSON.stringify(r));

reset();
provs.p2 = { id: 'p2', displayName: '详情平台', endpoints: { detail: {} } };
pollMap.set('t2', { raw: null, p: null });
r = await run({ taskId: 't2', provider: 'p2' });
ok('⑥ 平台没回这一条：说「本机没有记录，平台上也没查到」', /本机没有记录，平台上也没查到/.test(r.结论 || ''), JSON.stringify(r));

/* ---------- 号反查与字段挑选 ---------- */
reset();
provs.p1 = { id: 'p1', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
const done = {
  genId: 't3', status: 'succeeded', done: true, running: false, failed: false,
  assetId: 'as_3', url: 'https://cdn.example/x.png', model: 'vm-1', tier: 'std',
  res: '1080p', ar: '16:9', quality: 'high', format: 'png', count: 1, duration: 5,
  credits: null, priceMicros: 1200000, currency: 'CNY', error: null,
  prompt: '夕阳下的海边', promptLocal: true,
  created: 1700000000000, completed: 1700000060000,
};
pollMap.set('t3', { raw: {}, p: done });
localUrls[done.url] = 'la_777';
r = await run({ taskId: 't3', provider: 'p1' });
ok('查到以后：状态 / 产物号 / 型号 / 规格 / 花费都报出来',
  r.状态 === '已完成' && r.产物号 === 'as_3' && r.型号 === 'vm-1'
  && /1080p/.test(r.规格 || '') && r.消耗 === '¥1.2000', JSON.stringify(r));
ok('平台不给提示词时标明「本机归档」', r.提示词 === '夕阳下的海边' && r.提示词来源 === '本机归档', JSON.stringify(r));
ok('在本机：只问 AssetLocal.stateOf，并给出本机号', r.在本机 === 'la_777', JSON.stringify(r));

reset();
provs.p1 = { id: 'p1', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
cache.asset.as_4 = { provider: 'p1', genId: 't4', prompt: '缓存里的那一句', ts: 1700000000000 };
pollMap.set('t4', { raw: {}, p: { genId: 't4', status: 'running', running: true, failed: false, done: false } });
r = await run({ assetId: 'as_4' });
ok('只给产物号：从本机缓存反查出任务号与平台，再问平台',
  calls.length === 1 && calls[0].prov === 'p1' && calls[0].ids[0] === 't4', JSON.stringify(calls));
ok('还在跑的任务：状态说人话并提示过一会儿再看', /生成中/.test(r.状态 || '') && /还在跑/.test(r.状态 || ''), JSON.stringify(r));
ok('缓存里有提示词时补上并标明来源', r.提示词 === '缓存里的那一句' && r.提示词来源 === '本机归档', JSON.stringify(r));

/* ---------- 一次查多条 ---------- */
reset();
provs.p1 = { id: 'p1', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
pollMap.set('a1', { raw: {}, p: { genId: 'a1', status: 'succeeded', done: true } });
pollMap.set('a2', { raw: {}, p: { genId: 'a2', status: 'running', running: true } });
r = await run({ ids: ['a1', 'a2'], provider: 'p1' });
ok('ids 一多：只发一轮请求，两条一起问',
  calls.length === 1 && JSON.stringify(calls[0].ids) === JSON.stringify(['a1', 'a2']), JSON.stringify(calls));
ok('批量结果带条数与逐条条目', r.条数 === 2 && r.条目.length === 2
  && r.条目[0].状态 === '已完成' && /还在跑/.test(r.条目[1].状态), JSON.stringify(r));

reset();
provs.p1 = { id: 'p1', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
const many = Array.from({ length: 10 }, (_, i) => 'm' + i);
r = await run({ ids: many, provider: 'p1' });
ok('ids 超过 8 条只查前 8 条（工具说明里写的就是最多 8）',
  calls.length === 1 && calls[0].ids.length === 8 && r.条数 === 8, JSON.stringify(calls));

/* ---------- 其余分支 ---------- */
reset();
provs.p9 = { id: 'p9', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
pollMap.set('bad', { error: new Error('上游 500') });
r = await run({ taskId: 'bad', provider: 'p9' });
ok('平台查询抛错：把原因带上，不说成「没有这条」', /查这条任务失败了/.test(r.结论 || '') && /500/.test(r.结论 || ''), JSON.stringify(r));

reset();
provs.p9 = { id: 'p9', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
r = await run({ taskId: 'zzz', provider: 'nope' });
ok('平台 id 不在注册表：照实说没有这一家', /注册表里没有平台/.test(r.结论 || ''), JSON.stringify(r));

reset();
provs.p9 = { id: 'p9', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
r = await run({ assetId: 'as_9', provider: 'p9' });
ok('只有产物号、本机又没缓存：不拿产物号硬当任务号去问', /只给了产物号/.test(r.结论 || '') && calls.length === 0, JSON.stringify(r));

reset();
provs.p9 = { id: 'p9', displayName: '列表平台', pollVia: 'list', endpoints: { list: {} } };
pollMap.set('t9', { raw: {}, p: { genId: 't9', status: 'failed', failed: true, error: '内容审核未通过' } });
r = await run({ taskId: 't9', provider: 'p9' });
ok('失败的任务：状态与错误原因都带上', r.状态 === '生成失败' && /审核/.test(r.错误 || ''), JSON.stringify(r));

console.log(bad ? `\n任务详情工具判据：${bad}/${checks} 条红` : `\n任务详情工具判据：${checks}/${checks} 全绿`);
process.exit(bad ? 1 : 0);
