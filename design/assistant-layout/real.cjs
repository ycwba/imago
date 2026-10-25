#!/usr/bin/env node
/* 真机对照图：把**改完之后的那份真产品**拍下来（不是稿子）。
   用法：node design/assistant-layout/real.cjs
   出图落在 design/assistant-layout/shots/real-*.png

   这一份是「落地长什么样」的凭据：稿子在 design/assistant-layout/index.html，
   真机在 web/features/chat.js + web/styles/chat.css —— 两边对不上就以真机为准。

   模型是 stub（window.TextAI.chatStream 被换掉），走的是产品那条真的发送与工具循环；
   搜索上游是本机假上游（h.startFakeSearch），产物卡那一档用本机资产库里那一份。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../../tests/e2e/harness.cjs');

/* 1×1 的 PNG：造一份本机资产，好让「查本机资产」那一轮真的画出产物卡 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const shots = path.join(__dirname, 'shots');
fs.mkdirSync(shots, { recursive: true });

async function shot(page, name) {
  await page.screenshot(path.join(shots, name));
  console.log('  → ' + name);
}

(async () => {
  const proxy = await h.startProxy();
  const browser = await h.launchBrowser();
  let page, fake = null;
  try {
    const la = await (await fetch(proxy.base + '/local-assets', {
      method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '雨夜街道-候选 1.png', data: PNG, format: 'png', mime: 'image/png',
        media_type: 'image', meta: { prompt: '雨夜街道，湿沥青路面反着霓虹' },
      }),
    })).json();
    const laId = la && la.id;
    if (!laId) throw new Error('本机资产没建出来：' + JSON.stringify(la));

    page = await browser.newPage();
    await page.setSize(1440, 900);
    await page.goto(proxy.base + '/shell.html#studio.html');
    await page.waitFor(() => !!window.AiChat && !!window.AiChat.open, 30000, 100);
    await page.eval((id) => {
      localStorage.setItem('ai_chat_dock', '1');        // 固定档：占住右边一整条
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      localStorage.setItem('sk_text_vision', 'on');
      /* 那一轮带一条引用（拖进来的素材）：正文里会有一段高亮 */
      localStorage.setItem('ai_chat_refs', JSON.stringify({ data: [{
        kind: 'asset', name: '雨夜街道-候选 1', type: '图片',
        assetId: id, src: '/asset/' + id, taskId: 'task_7f21', from: 'assets',
      }], ts: Date.now() }));
    }, laId);

    fake = await h.startFakeSearch(() => ([
      { title: '本地优先的 AI 工作台', url: 'https://example.com/a', content: '把数据留在本机。', published_date: '2026-10-01' },
      { title: '字幕与配音怎么挂到时间线', url: 'https://example.com/b', content: '一条源秒一份账。', published_date: '2026-09-20' },
    ]));
    await h.useFakeSearch(proxy, fake, 'tvly-real');

    /* 模型走脚本：先查再答（工序脊 + 结论 + 来源），再提一个写动作（执行闸 —— 停在「等你确认」，
       不点执行就不动任何数据），最后一轮是纯回答（**不套卡壳**，只有一条气泡）。 */
    await page.eval(() => {
      window.__script = [
        'CALL: web_search {"query":"雨夜街道 提示词","limit":2}',
        '做法见 [来源 1]，另一条见 [来源 2]。',
        'RUN: set_setting {"key":"dir_theme","value":"light"}',
        '「雨夜街道」在视频平台上要减掉材质词吗？—— 要的话我把那句改短。',
      ];
      window.TextAI.chatStream = async () => window.__script.shift() || '（脚本用完了）';
    });
    await page.eval(() => { AiChat.open(); return true; });
    await h.sleep(600);

    /* 等一个条件；等不到就把面板里画出来的东西与页面错误打出来（不然只有一句「超时」）。
       ⚠ 选择器要**当参数传进去**：page.eval 把函数序列化之后，闭包里的变量会丢。 */
    const until = async (sel, why) => {
      const ok = await page.waitFor(s => !!document.querySelector(s), 25000, 150, sel)
        .then(() => true).catch(() => false);
      if (ok) return true;
      const dump = await page.eval(() => {
        const p = document.getElementById('acPanel');
        return {
          jobs: document.querySelectorAll('.ac-job').length,
          panel: p ? p.innerText.slice(0, 600) : '(没有面板)',
          errs: (window.__errs || []).slice(0, 5),
        };
      });
      console.log('等不到 ' + sel + '（' + why + '）：\n  卡数：' + dump.jobs
        + '\n  面板：' + JSON.stringify(dump.panel) + '\n  错误：' + JSON.stringify(dump.errs));
      throw new Error('等不到 ' + sel + '（' + why + '）');
    };

    await page.eval(() => AiChat.ask('雨夜街道那条视频后来好了吗'));
    await until('.ac-job', '第一轮：查 + 答');
    await h.sleep(400);
    await page.eval(() => AiChat.ask('把左栏收起来'));
    await until('.ac-run', '第二轮：执行闸');
    await h.sleep(400);
    await page.eval(() => AiChat.ask('「雨夜街道」在视频平台上要减掉材质词吗？'));
    await until('.ac-ai', '第三轮：纯回答（气泡，不套卡壳）');
    await h.sleep(700);

    await shot(page, 'real-01-副驾台-固定档-浅色-1440.png');

    /* 深色档：同一个页面切主题（不是另设计一版） */
    await page.eval(() => { document.documentElement.dataset.theme = 'dark'; localStorage.setItem('dir_theme', 'dark'); });
    await h.sleep(500);
    await shot(page, 'real-02-副驾台-固定档-深色-1440.png');
    await page.eval(() => { document.documentElement.dataset.theme = 'light'; localStorage.setItem('dir_theme', 'light'); });
    await h.sleep(400);

    /* 历史会话浮层 */
    await page.eval(() => { document.getElementById('acHist').click(); return true; });
    await h.sleep(500);
    await shot(page, 'real-03-历史会话浮层-浅色-1440.png');
    await page.eval(() => { document.getElementById('acHistClose').click(); return true; });
    await h.sleep(300);

    /* 浮窗档 */
    await page.eval(() => { localStorage.setItem('ai_chat_dock', '0'); location.reload(); return true; });
    await page.waitFor(() => !!window.AiChat && !!window.AiChat.open, 30000, 100);
    await h.sleep(600);
    await page.eval(() => { AiChat.open(); return true; });
    await h.sleep(600);
    await shot(page, 'real-04-浮窗档-浅色-1440.png');

    /* 引用高亮：拖进来的素材在正文里是**一段高亮文字**。
       这一档要真的把标记放进输入框（`shotRefs` 读的是输入框里的正文），
       再用 ask(输入框的值) 发出去 —— 两边一致，那一段才会高亮、也才会进清单。 */
    await page.eval(() => { localStorage.setItem('ai_chat_dock', '1'); location.reload(); return true; });
    await page.waitFor(() => !!window.AiChat && !!window.AiChat.open, 30000, 100);
    await h.sleep(600);
    await page.eval(() => {
      const ta = document.getElementById('acTa');
      ta.value = '照这版提示词生成一条 4 秒的视频\n[引用素材：雨夜街道-候选 1]';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    await h.sleep(300);
    await page.eval(() => { AiChat.open(); return true; });
    await h.sleep(300);
    await page.eval(() => AiChat.ask(document.getElementById('acTa').value));
    await until('.ac-mref', '引用高亮');
    await h.sleep(700);
    await shot(page, 'real-05-引用高亮-浅色-1440.png');

    const errs = (page.errors || []).filter(e => !/favicon/i.test(e));
    if (errs.length) console.log('页面报错：' + errs.slice(0, 4).join(' | '));
    else console.log('零控制台错误。');
  } finally {
    if (page) page.close();
    await browser.close();
    if (fake) fake.stop();
    await proxy.stop();
  }
})().catch(e => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
