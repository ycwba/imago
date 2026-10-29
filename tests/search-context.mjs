#!/usr/bin/env node
/* 联网搜索接给文字 AI 的唯一入口：总开关 / 查询词清洗 / 结果拼装 / 失败话说清。
   纯 Node 桩，不起代理。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('web/domain/search.js', 'utf8');
function boot(opts) {
  const calls = [];
  const ctx = { window: {}, console };
  ctx.window.Api = { errOf: (e, fallback) => new Error((e && e.message) || fallback || '错误') };
  ctx.window.errText = (e, fallback) => (e && e.message) || fallback || '错误';
  ctx.window.Net = {
    json: async (url, init) => {
      calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      if (url === '/search/settings') return { settings: { enabled: !!opts.enabled, maxResults: opts.maxResults || 5 } };
      if (url === '/search/query') {
        if (opts.fail) throw new Error('上游挂了');
        return { results: [{ title: '标题', url: 'https://example.com/a', snippet: '摘要' }] };
      }
      return {};
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { S: ctx.window.Search, calls };
}

const on = boot({ enabled: true, maxResults: 3 });
const text = await on.S.context('@参考图1 搜一下 赛博朋克 雨夜');
assert.match(text, /https:\/\/example\.com\/a/);
assert.match(text, /外部资料，只当参考/);
const q = on.calls.find(x => x.url === '/search/query').body;
assert.equal(q.query, '搜一下 赛博朋克 雨夜', '搜索词要把 @素材标记去掉');
assert.equal(q.limit, 3, '结果数读设置里的值');
assert.equal(on.calls[0].url, '/search/settings', '先问总开关，再搜索');

/* 纯创作内容不需要外部资料：不搜索、也不加一段「没搜」的废话。 */
const creative = boot({ enabled: true });
assert.equal(await creative.S.context('雨夜 赛博朋克 少女'), '');
assert.ok(!creative.calls.some(x => x.url === '/search/query'), '纯创作提示词不该触发搜索');
assert.equal(creative.S.needed('雨夜 赛博朋克'), false);
assert.equal(creative.S.needed('查一下 2026 年的价格'), true);

const off = boot({ enabled: false });
assert.equal(await off.S.context('赛博朋克'), '', '总开关关着时不起搜索、也不加一段假话');
assert.ok(!off.calls.some(x => x.url === '/search/query'), '关着时不该打 /search/query');

const bad = boot({ enabled: true, fail: true });
const note = await bad.S.context('搜一下赛博朋克');
assert.match(note, /联网搜索没有成功/);
assert.match(note, /不要假装搜过/);

console.log('✓ 联网搜索接入：总开关 / 查询词清洗 / 结果拼装 / 失败回执');
