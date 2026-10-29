#!/usr/bin/env node
/* 语音识别（ASR）端到端：
   - 本机路由要 wb_session Cookie；设置读回只有 hasKey、没有明文密钥
   - 用 /local-assets 存一份真 WAV（合法入口），在线路线指向本机假上游
   - 提交 → 轮询到 done → 分段 / SRT 正确
   - 同一份媒体同一语言再提交：复用旧结果，上游只收到一次请求
   - 取消一单正在跑的转写：账上落 canceled、挂着的上游请求真的断掉、迟到的回答不能把它写回 done
   - 上游回答超过响应上限：判 error 并说清原因，不把超限的响应当结果收下
   - 页面侧（window.Asr）：等待到点说清「可能还在跑」，cancel 把这一单落成 canceled
   - 设置页两张卡都画出来，且页面里看不到密钥
   不碰真实 .data / .assets：全部落在 harness 的 .*-probe-* 目录。 */
'use strict';
const http = require('http');
const h = require('./harness.cjs');

function wav(seconds = 0.2) {
  const rate = 8000;
  const samples = Math.floor(rate * seconds);
  const data = Buffer.alloc(samples * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

(async () => {
  let proxy, browser, page, fake;
  try {
    /* 给 OpenAI 一把假密钥：它是声明了语音识别的一家，接进来之后设置页才有
       「识」那一行、表单也才有地方摆（能力在哪家、设置就在哪家）。 */
    proxy = await h.startProxy({ env: { OPENAI_API_KEY: 'sk-openai-probe' } });
    let upstreamHits = 0;
    let hold = false;
    let big = false;
    let held = null;
    const answer = res => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        segments: [{ start: 0, end: 1.5, text: '你 好' }, { start: 1.5, end: 3, text: '世界' }],
      }));
    };
    fake = http.createServer((req, res) => {
      let body = 0;
      req.on('data', c => { body += c.length; });
      req.on('end', () => {
        upstreamHits++;
        if (req.url !== '/audio/transcriptions') { res.writeHead(404); res.end('{}'); return; }
        if (!body) { res.writeHead(400); res.end('{"error":{"message":"empty multipart"}}'); return; }
        /* 比 server/routes/asr.js 的 MAX_ONLINE_RESPONSE（8MB）大一档的回答 */
        if (big) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"text":"' + 'x'.repeat(9 * 1024 * 1024) + '"}');
          return;
        }
        if (hold) {
          /* 按住不给答：任务停在 running —— 这才是用户点「取消」时的那个现场。
             连接被掐断时 res 会 close，留着这个旗标就是给测试看「上游真的断了」。 */
          const slot = { res, closed: false };
          held = slot;
          res.on('close', () => { slot.closed = true; });
          res.on('error', () => { slot.closed = true; });
          return;
        }
        answer(res);
      });
    });
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;

    const call = async (p, opt = {}) => {
      const r = await fetch(proxy.base + p, {
        ...opt,
        headers: { cookie: proxy.cookie, ...(opt.headers || {}) },
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { status: r.status, json, text };
    };

    /* 没有 Cookie 的本机路由一律 401 */
    const noCookie = await fetch(proxy.base + '/asr/settings');
    if (noCookie.status !== 401) throw new Error('没带 Cookie 也读到了 ASR 设置：HTTP ' + noCookie.status);

    let g = await call('/asr/settings');
    if (g.status !== 200) throw new Error('读 ASR 设置失败：HTTP ' + g.status + ' ' + g.text);
    if (!g.json || !g.json.settings) throw new Error('ASR 设置响应缺 settings');
    if (g.json.settings.service.key !== undefined) throw new Error('ASR 设置回显了密钥');
    if (g.json.local === undefined) throw new Error('ASR 设置响应缺本机运行包状态');

    /* 默认 auto 且本机不可用时会先指出「在线还没有密钥」——同样是当场 400，不建空任务 */
    const badJob = await call('/asr/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (badJob.status !== 400 || !/密钥|素材/.test(badJob.text)) throw new Error('缺条件时应当场 400：' + badJob.status + ' ' + badJob.text);

    const missing = await call('/asr/jobs/asr_nope');
    if (missing.status !== 404) throw new Error('不存在的任务应当 404：HTTP ' + missing.status);

    /* 在线路线：设置里指到本机假上游 */
    const put = await call('/asr/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { route: 'service', language: 'zh',
        service: { providerId: '', model: 'whisper-1', baseUrl: 'http://127.0.0.1:' + fakePort, key: 'sk-asr-e2e' } } }),
    });
    if (put.status !== 200) throw new Error('保存 ASR 设置失败：HTTP ' + put.status + ' ' + put.text);
    if (!put.json.settings.service.hasKey) throw new Error('保存后 hasKey 应为 true');
    if (put.json.settings.service.key !== undefined) throw new Error('保存响应回显了密钥');

    const onDisk = require('fs').readFileSync(require('path').join(proxy.dataDir, 'asr.json'), 'utf8');
    if (!/"key": "sk-asr-e2e"/.test(onDisk)) throw new Error('密钥没有落到代理那一边的 asr.json');

    const noMedia = await call('/asr/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ route: 'service' }),
    });
    if (noMedia.status !== 400 || !/素材/.test(noMedia.text)) throw new Error('配好密钥后缺素材应当场 400：' + noMedia.status + ' ' + noMedia.text);

    const badLang = await call('/asr/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: '中文！' }),
    });
    if (badLang.status !== 400) throw new Error('非法语言应当 400：HTTP ' + badLang.status);

    /* 通过合法入口造一份本机音频 */
    const saved = await call('/local-assets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: wav().toString('base64'), format: 'wav', mime: 'audio/wav', name: 'asr-e2e.wav' }),
    });
    if (saved.status !== 200 || !saved.json || !saved.json.id) throw new Error('本机资产没存成：' + saved.status + ' ' + saved.text);
    const assetId = saved.json.id;

    const waitJob = async id => {
      const until = Date.now() + 15000;
      let last = null;
      while (Date.now() < until) {
        const r = await call('/asr/jobs/' + id);
        if (r.status !== 200) throw new Error('查任务失败：HTTP ' + r.status + ' ' + r.text);
        last = r.json;
        if (last.state === 'done' || last.state === 'error' || last.state === 'canceled' || last.state === 'interrupted') return last;
        await h.sleep(150);
      }
      throw new Error('等转写结果超时，最后状态：' + JSON.stringify(last));
    };

    const sub = await call('/asr/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId, route: 'service' }),
    });
    if (sub.status !== 200 || !sub.json.jobId) throw new Error('提交转写失败：' + sub.status + ' ' + sub.text);
    const j1 = await waitJob(sub.json.jobId);
    if (j1.state !== 'done') throw new Error('转写没成功：' + j1.state + ' · ' + (j1.error || ''));
    if (j1.segments.length !== 2 || j1.segments[1].text !== '世界') throw new Error('分段不对：' + JSON.stringify(j1.segments));
    if (!/00:00:00,000 --> 00:00:01,500/.test(j1.srt)) throw new Error('SRT 时间不对：' + j1.srt);
    if (upstreamHits !== 1) throw new Error('第一次转写应当只打一次上游，实际 ' + upstreamHits);

    /* 同一份媒体同一语言：复用，不再打上游 */
    const sub2 = await call('/asr/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId, route: 'service' }),
    });
    if (sub2.status !== 200 || !sub2.json.jobId) throw new Error('第二次提交失败：' + sub2.status + ' ' + sub2.text);
    const j2 = await waitJob(sub2.json.jobId);
    if (j2.state !== 'done') throw new Error('复用任务没成功：' + j2.state + ' · ' + (j2.error || ''));
    if (!/复用旧结果/.test(j2.engine)) throw new Error('第二次没有走复用：' + j2.engine);
    if (upstreamHits !== 1) throw new Error('复用却又打了一次上游：' + upstreamHits);

    /* 删任务 */
    const del = await call('/asr/jobs/' + j2.id, { method: 'DELETE' });
    if (del.status !== 200 || !del.json || !del.json.ok) throw new Error('删任务失败：' + del.status + ' ' + del.text);
    if (del.json.canceled !== false) throw new Error('删一份已经跑完的任务不该说成「取消」：' + del.text);
    const gone = await call('/asr/jobs/' + j2.id);
    if (gone.status !== 404) throw new Error('删掉的任务还在：HTTP ' + gone.status);

    /* 同一份媒体同一语言会命中复用，所以每个新场景都要一份字节不一样的音频 */
    const putWav = async (sec, name) => {
      const r = await call('/local-assets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: wav(sec).toString('base64'), format: 'wav', mime: 'audio/wav', name }),
      });
      if (r.status !== 200 || !r.json || !r.json.id) throw new Error('本机音频没存成（' + name + '）：' + r.status + ' ' + r.text);
      return r.json.id;
    };

    /* ---------- 取消一单正在跑的转写 ---------- */
    /* 真取消要做满三件事：账上落 canceled、把那一单挂着的上游请求掐断、
       迟到的回答不能再把已取消的任务写成 done。少任何一件，用户都会以为
       「点了取消但后台还在跑、还在计费」。 */
    hold = true;
    const assetId2 = await putWav(0.4, 'asr-e2e-2.wav');
    const hitsBefore = upstreamHits;
    const subC = await call('/asr/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: assetId2, route: 'service' }),
    });
    if (subC.status !== 200 || !subC.json.jobId) throw new Error('提交待取消的转写失败：' + subC.status + ' ' + subC.text);
    const cid = subC.json.jobId;

    /* 先确认这一单真的跑到上游、停在 running —— 没跑起来就去取消，测的是「取消一单没在跑的」，不是这条 */
    const runUntil = Date.now() + 15000;
    let jr = null;
    while (Date.now() < runUntil) {
      jr = (await call('/asr/jobs/' + cid)).json;
      if (jr.state === 'running' && upstreamHits > hitsBefore) break;
      await h.sleep(100);
    }
    if (!jr || jr.state !== 'running' || upstreamHits <= hitsBefore) {
      hold = false;
      throw new Error('取消之前这一单没有真的跑起来：' + JSON.stringify(jr) + ' · 上游 hits ' + hitsBefore + ' → ' + upstreamHits);
    }
    if (upstreamHits - hitsBefore !== 1) throw new Error('新提交的这一单只该打上游一次，实际 ' + (upstreamHits - hitsBefore));

    const cancel = await call('/asr/jobs/' + cid, { method: 'DELETE' });
    if (cancel.status !== 200 || !cancel.json || cancel.json.ok !== true || cancel.json.canceled !== true) {
      hold = false;
      throw new Error('取消在跑的转写要回 canceled:true：' + cancel.status + ' ' + cancel.text);
    }
    hold = false;
    const jc = await call('/asr/jobs/' + cid);
    if (jc.status !== 200) throw new Error('取消之后任务应当还在账上（写明「已取消」），实际 HTTP ' + jc.status);
    if (jc.json.state !== 'canceled') throw new Error('取消之后状态应是 canceled：' + JSON.stringify(jc.json));
    if (!/已取消/.test(jc.json.error || '')) throw new Error('取消没写明原因：' + JSON.stringify(jc.json.error));
    if ((jc.json.segments || []).length) throw new Error('已取消的任务不该带结果：' + JSON.stringify(jc.json.segments));

    /* 挂着的上游请求要真的断掉，不是只把账改了、请求还在后台流着 */
    const cutUntil = Date.now() + 8000;
    let cut = false;
    while (Date.now() < cutUntil) {
      if (held && held.closed) { cut = true; break; }
      await h.sleep(100);
    }
    if (!cut) throw new Error('取消之后上游那一头的连接还挂着');

    /* 迟到的回答：放行它（或让它撞上已断的连接），无论哪条路，账上都必须还是 canceled */
    try { if (held && !held.closed) answer(held.res); } catch (e) {}
    await h.sleep(800);
    const late = (await call('/asr/jobs/' + cid)).json;
    if (late.state !== 'canceled') throw new Error('上游迟到的回答把已取消的任务改成了 ' + late.state + '：' + JSON.stringify(late));
    if (upstreamHits - hitsBefore !== 1) throw new Error('取消之后不该再补打上游：' + (upstreamHits - hitsBefore));

    /* ---------- 上游回答超上限：判失败、说清原因，不拼一个假结果 ---------- */
    /* 在线转写的 15 分钟 socket 超时没法在测试里等满，但它与「响应过大」走的是同一条
       失败出口（runOnline 里 reject → work 的 catch → 账上 error）；
       这里用一份比 MAX_ONLINE_RESPONSE 还大的回答把这条出口钉住。 */
    big = true;
    const capId = await putWav(0.6, 'asr-e2e-3.wav');
    const hitsCap = upstreamHits;
    const subBig = await call('/asr/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: capId, route: 'service' }),
    });
    if (subBig.status !== 200 || !subBig.json.jobId) throw new Error('提交「超大回答」那一单失败：' + subBig.status + ' ' + subBig.text);
    const jBig = await waitJob(subBig.json.jobId);
    big = false;
    if (jBig.state !== 'error') throw new Error('上游回答超上限应当判 error，实际 ' + jBig.state + '：' + JSON.stringify(jBig).slice(0, 240));
    if (!/超过 ?8MB/.test(jBig.error || '')) throw new Error('失败原因要说清是响应超限：' + JSON.stringify(jBig.error));
    if ((jBig.segments || []).length) throw new Error('超限的回答不能被当成结果收下：' + (jBig.segments || []).length + ' 段');
    if (upstreamHits - hitsCap !== 1) throw new Error('这一单只该打上游一次，实际 ' + (upstreamHits - hitsCap));

    /* 设置页：在线识别那一块在 OpenAI 卡里；本机 / 浏览器内是一张**独立的常驻账号卡** */
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html#settings.html');
    await page.waitFor(() => !!document.querySelector('#asrCard') && !!document.querySelector('#asrLocalCard'), 15000);
    await page.waitFor(() => {
      const c = document.querySelector('#asrCard');
      const l = document.querySelector('#asrLocalCard');
      return !!(c && c.offsetParent !== null && l && l.offsetParent !== null);
    }, 10000);
    /* 等设置读回来（route 那一格在本机识别那张卡里） */
    await page.waitFor(() => {
      const l = document.querySelector('#asrLocalCard');
      const s = l && l.querySelector('select');
      return !!(s && s.value === 'service');
    }, 10000);
    const ui = await page.eval(() => {
      const card = document.querySelector('#asrCard');
      const local = document.querySelector('#asrLocalCard');
      const routeSel = local.querySelector('select');
      const hostOf = el => {
        const a = el.closest('.acct.fcard');
        return a && a.dataset ? a.dataset.acct : '';
      };
      return {
        rows: [...card.querySelectorAll('.krow > .kn')].map(e => e.textContent.trim()),
        localRows: [...local.querySelectorAll('.krow > .kn')].map(e => e.textContent.trim()),
        onlineHost: hostOf(card),
        localHost: hostOf(local),
        route: routeSel ? routeSel.value : '',
        keyShown: [...card.querySelectorAll('input')].some(i => /sk-asr-e2e/.test(i.value || '')),
      };
    });
    for (const want of ['在线服务商', '型号', '接口地址', '密钥']) {
      if (!ui.rows.includes(want)) throw new Error('设置页在线识别那一块缺了「' + want + '」这一行，实画：' + ui.rows.join('、'));
    }
    for (const want of ['走哪条路', '语言', '本机运行包', '浏览器内模型']) {
      if (!ui.localRows.includes(want)) throw new Error('本机识别那张卡缺了「' + want + '」这一行，实画：' + ui.localRows.join('、'));
    }
    if (ui.onlineHost !== 'openai') throw new Error('在线识别那一块没住在 OpenAI 卡里（实际挂在「' + ui.onlineHost + '」）');
    if (ui.localHost !== '__local_asr__') throw new Error('本机 / 浏览器内没有自己的账号卡（实际挂在「' + ui.localHost + '」）');
    if (ui.route !== 'service') throw new Error('设置页没读回 route=service：' + ui.route);
    if (ui.keyShown) throw new Error('设置页把密钥回显出来了');

    /* 浏览器内 Whisper 这一档：路线里有得选、模型状态行照 /models/status 画（探针实例没有模型 → 照实说还没下载） */
    const browserOpt = await page.eval(() => {
      const local = document.querySelector('#asrLocalCard');
      return {
        row: local.innerText.includes('浏览器内模型'),
        opt: !!local.querySelector('option[value="browser"]'),
      };
    });
    if (!browserOpt.row) throw new Error('本机识别那张卡没有画「浏览器内模型」这一行');
    if (!browserOpt.opt) throw new Error('「走哪条路」里没有浏览器内 Whisper 这一档');
    await page.waitFor(() => {
      const c = document.querySelector('#asrLocalCard');
      if (!(c && /还没下载|缺 \d+ 个文件/.test(c.innerText))) {
        throw new Error('浏览器内模型状态行没照 /models/status 画出来（探针实例没有模型，应说「还没下载」）');
      }
      return true;
    }, 10000);

    /* /models/ 双闸之外的行为：status 认只读、点号段进不了模型目录
       （%2e%2e 会被 URL 归一先吃掉、在路由表上落 404；字面 ..%2f 到了处理器按 400 拒 —— 两种都进不了盘） */
    const mst = await call('/models/status?id=onnx-community/whisper-small_timestamped');
    if (mst.status !== 200 || !mst.json || mst.json.id !== 'onnx-community/whisper-small_timestamped'
      || !Array.isArray(mst.json.files)) throw new Error('/models/status 形状不对：' + mst.status + ' ' + mst.text);
    const trav = await call('/models/%2e%2e/.env');
    if (trav.status !== 400 && trav.status !== 404) throw new Error('点号段进不了模型目录，实际 ' + trav.status);
    const trav2 = await call('/models/..%2f.env');
    if (trav2.status !== 400) throw new Error('编码点号段要按 400 拒，实际 ' + trav2.status);
    const mpost = await call('/models/org/name/f.bin', { method: 'POST' });
    if (mpost.status !== 405) throw new Error('/models 文件档只收 GET，实际 ' + mpost.status);
    await page.waitFor(() => {
      const c = document.querySelector('#searchCard');
      return !!(c && c.offsetParent !== null);
    }, 10000);
    const searchTitle = await page.eval(() => document.querySelector('#searchCard').innerText.slice(0, 40));
    if (!/联网搜索/.test(searchTitle)) throw new Error('设置页没有联网搜索卡：' + searchTitle);

    /* ---------- 页面这一头的等待上限与取消 ---------- */
    /* 设置页「试一试」用的就是 window.Asr.wait，它有自己的等待上限。
       上游按住不答：等待到点要照实说「任务可能还在跑」，然后由 Asr.cancel 把这一单落成 canceled ——
       否则页面以为还在等、代理以为还在跑，谁都没停下来。 */
    await page.waitFor(() => !!window.Asr, 15000);
    hold = true;
    const waitAsset = await putWav(0.8, 'asr-e2e-4.wav');
    const hitsWait = upstreamHits;
    const client = await page.eval(async (aid) => {
      const out = { jobId: '', 等待: '', 取消: null, 状态: '', 轮询次数: 0 };
      const r = await window.Asr.transcribe({ assetId: aid, route: 'service' });
      out.jobId = r.jobId;
      try {
        await window.Asr.wait(r.jobId, () => { out.轮询次数++; }, { timeoutMs: 1500, every: 250 });
        out.等待 = '没到点就把任务等到了结尾';
      } catch (e) { out.等待 = String((e && e.message) || e); }
      out.取消 = await window.Asr.cancel(r.jobId);
      out.状态 = (await window.Asr.job(r.jobId)).state;
      return out;
    }, waitAsset);
    hold = false;
    if (!client.jobId) throw new Error('页面没能提交这一单转写：' + JSON.stringify(client));
    if (!/等了太久|还在跑/.test(client.等待)) throw new Error('等待到点要说清「可能还在跑」，实际回：' + JSON.stringify(client.等待));
    if (client.轮询次数 < 2) throw new Error('等待期间要真的在轮询，实际只查了 ' + client.轮询次数 + ' 次');
    if (!client.取消 || client.取消.ok !== true || client.取消.canceled !== true) {
      throw new Error('页面侧取消没回 canceled:true：' + JSON.stringify(client.取消));
    }
    if (client.状态 !== 'canceled') throw new Error('页面侧取消之后账上还是 ' + client.状态);
    const srvJob = (await call('/asr/jobs/' + client.jobId)).json;
    if (srvJob.state !== 'canceled') throw new Error('页面与代理对这一单的状态不一致：' + JSON.stringify(srvJob));
    if (upstreamHits - hitsWait !== 1) throw new Error('这一单只该打上游一次，实际 ' + (upstreamHits - hitsWait));

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ ASR 端到端通过（设置不回显 / 在线转写 / 分段与 SRT / 同源复用 / 上游超限判失败 / '
      + '取消在跑的任务（代理侧与页面侧）/ 等待到点 / 设置页）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
    if (fake) { try { if (fake.closeAllConnections) fake.closeAllConnections(); } catch (e) {} fake.close(); }
  }
})();
