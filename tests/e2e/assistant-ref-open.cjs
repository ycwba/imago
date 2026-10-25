#!/usr/bin/env node
/* 凭号取图：拖进来的是「引用」（号 + 地址），不是字节；
   ① 队列里真的留下了号与地址，这一轮发给模型的正文里有【这次引用的素材】清单与同一下标；
   ② 助手用 asset_open 按清单序号取字节 —— 真的取到图、真的交给看图型号（字节是本机那份）；
   ③ 取不到就说取不到，不编图里的内容；
   ④ 输入框里的引用可悬停（弹出这一条）可点击（开弹层看图）；
      **正文是真相** —— 把那段文字改坏，这条引用就作废（队列里那条一起删、这一轮不再发给模型），
      资产库里的那一份没动。高亮上不再有 ×（标记就是正文里的文字，键盘删它就够了）。 */
'use strict';
const h = require('./harness.cjs');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let n = 0;
function must(cond, msg) { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); }

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    const la = await (await fetch(proxy.base + '/local-assets', {
      method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '助手引用探针.png', data: PNG, format: 'png', mime: 'image/png', media_type: 'image', meta: {} }),
    })).json();
    const laId = la && la.id;
    if (!laId) throw new Error('探针资产没建出来：' + JSON.stringify(la));

    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.Store && !!window.Fav, 20000, 100);
    await page.eval((id) => {
      localStorage.setItem('ai_chat_dock', '0');            // 浮层：面板不收边、贴球，量得到高亮矩形
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      localStorage.setItem('sk_text_vision', 'on');
      /* 12 小时识图判定缓存先钉住：asset_open 的 visionAsync 不必再去问上游 /models */
      localStorage.setItem('sk_model_meta_deepseek', JSON.stringify({ ts: Date.now(), byId: { 'stub-model': { vision: true, field: 'stub' } } }));
      localStorage.setItem('fav_items', JSON.stringify({ data: [{
        key: 'a:probe:' + id, kind: 'asset', provider: 'probe', providerName: '探针平台',
        assetId: id, type: '图片', prompt: '海边灯塔的一张小图', src: '/asset/' + id,
        dl: '', format: 'png', ts: Date.now(),
      }], ts: Date.now() }));
    }, laId);
    const key = 'a:probe:' + laId;
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => !!(window.AiChat && window.AiChat.open), 25000, 100);
    await page.waitFor(() => !!document.querySelector('.grid .card[data-key]'), 20000, 120);
    await h.sleep(200);

    const drop = () => page.eval((key) => {
      const card = document.querySelector('.card[data-key="' + key + '"]');
      const ball = document.getElementById('acBall');
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      ball.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      ball.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      ball.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return window.AssetRef.read(dt);
    }, key);

    /* ---------- 1) 引用队列：号与地址都留下了（真相是队列，不是那行字） ---------- */
    const ref = await drop();
    await h.sleep(320);
    const q1 = await page.eval((id) => {
      const raw = JSON.parse(localStorage.getItem('ai_chat_refs') || 'null');
      const arr = (raw && raw.data) || raw || [];
      const hl = document.querySelector('.ac-ref-hl');
      return {
        n: arr.length, rec: arr[0] || null,
        value: document.getElementById('acTa').value,
        hl: document.querySelectorAll('.ac-ref-hl').length,
        hlRect: hl ? { left: hl.getBoundingClientRect().left, top: hl.getBoundingClientRect().top,
          width: hl.getBoundingClientRect().width, height: hl.getBoundingClientRect().height } : null,
        assetId: id,
      };
    }, laId);
    must(ref && ref.assetId === laId, '拖动载荷里没有本机资产号：' + JSON.stringify(ref));
    must(q1.n === 1 && q1.rec, '引用队列没留下这一条：' + JSON.stringify(q1.rec));
    must(q1.rec.assetId === laId && /\/asset\//.test(q1.rec.src || ''), '队列里号或地址是空的：' + JSON.stringify(q1.rec));
    must(/\[引用素材：[^\]\n]+\]/.test(q1.value), '输入框里没有引用标记：' + JSON.stringify(q1.value));
    must(q1.hl >= 1 && q1.hlRect && q1.hlRect.width > 0 && q1.hlRect.height > 0, '高亮矩形没量出来：' + JSON.stringify(q1));

    /* ---------- 2) 悬停：弹出这一条（名字 / 类型 / 资产号 + 缩略图） ---------- */
    const tip = await page.eval(() => {
      const hl = document.querySelector('.ac-ref-hl');
      const ta = document.getElementById('acTa');
      const r = hl.getBoundingClientRect();
      const x = r.left + Math.max(1, r.width / 2), y = r.top + Math.max(1, r.height / 2);
      ta.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      const t = document.querySelector('.ac-ref-tip');
      const img = t ? t.querySelector('img') : null;
      return {
        has: !!t, hidden: t ? t.hidden : true, text: t ? t.innerText : '',
        img: img ? img.getAttribute('src') : '', color: ta ? getComputedStyle(ta).color : '',
      };
    });
    must(tip.has && tip.hidden === false, '悬停没有弹出这一条：' + JSON.stringify(tip));
    must(/海边灯塔的一张小图|助手引用探针/.test(tip.text) && /资产/.test(tip.text), '悬停卡里没有名字 / 资产号：' + JSON.stringify(tip.text));
    /* 本机资产地址的**唯一拼法**是 Api.assetSrc（带 ?v=2 那个固定版本位）——
       断言别写死形状，问产品要那条地址（web/domain/api.js 的 assetSrc）。 */
    const wantTip = await page.eval(id => (window.Api && window.Api.assetSrc ? window.Api.assetSrc(id) : '/asset/' + id), laId);
    must(tip.img === wantTip, '悬停卡里的缩略图不是这一份本机资产：' + tip.img + '（要 ' + wantTip + '）');

    /* ---------- 3) 点击：开弹层，图能画出来（地址就是队列里那一份） ---------- */
    const dlg = await page.eval(async () => {
      const hl = document.querySelector('.ac-ref-hl');
      const ta = document.getElementById('acTa');
      const r = hl.getBoundingClientRect();
      ta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true,
        clientX: r.left + Math.max(1, r.width / 2), clientY: r.top + Math.max(1, r.height / 2) }));
      await new Promise(r2 => setTimeout(r2, 120));
      const d = document.querySelector('dialog.ui-dlg');
      const img = d ? d.querySelector('.ac-refdl img') : null;
      const out = {
        open: !!(d && d.open), title: d ? (d.querySelector('.pr-head b') || {}).textContent || '' : '',
        img: img ? img.getAttribute('src') : '', text: d ? d.innerText.slice(0, 400) : '',
      };
      const btn = d ? [...d.querySelectorAll('.pr-foot button')].find(b => /关闭/.test(b.textContent)) : null;
      if (btn) btn.click();
      await new Promise(r2 => setTimeout(r2, 120));
      out.closed = !document.querySelector('dialog.ui-dlg[open]');
      return out;
    });
    must(dlg.open, '点引用没有开弹层：' + JSON.stringify(dlg));
    must(/引用的素材/.test(dlg.title), '弹层标题不对：' + dlg.title);
    must(dlg.img === wantTip, '弹层里画的不是这条资产：' + dlg.img + '（要 ' + wantTip + '）');
    must(dlg.closed, '弹层关不掉：' + JSON.stringify(dlg));

    /* ---------- 4) 这一轮的正文里有清单，序号从 0 起、带号带地址 ---------- */
    const sent = await page.eval(async () => {
      window.__sent = [];
      window.__seen = null;
      window.TextAI.chatStream = async (r, sys, user) => { window.__sent.push(String(user)); return '这一条我看到了。'; };
      let err = '';
      try { await AiChat.ask('这张图里是什么？'); } catch (e) { err = (e && e.stack) || String(e); }
      return {
        prompts: window.__sent, err,
        value: document.getElementById('acTa').value,
        saved: (() => { const raw = JSON.parse(localStorage.getItem('ai_chat_refs') || 'null');
          return ((raw && raw.data) || raw || []).length; })(),
        doc: AiChat.TOOLS.asset_open && AiChat.TOOLS.asset_open.doc || '',
      };
    });
    const prompt = sent.prompts[0] || '';
    must(!sent.err, '这一轮发送抛错了：' + sent.err);
    must(sent.prompts.length === 1, '这一轮没把正文送到模型（或送了不止一轮）：' + JSON.stringify(sent.prompts.length));
    must(/【这次引用的素材】/.test(prompt), '正文里没有【这次引用的素材】清单：' + prompt.slice(0, 600));
    must(/0 = [^\n]*/.test(prompt) && new RegExp('0 = [^\\n]*' + laId).test(prompt),
      '清单第 0 条里没有这条的号：' + prompt.slice(0, 900));
    must(/地址 \/asset\//.test(prompt), '清单里没把可取字节的地址写出来：' + prompt.slice(0, 900));
    must(sent.saved === 0, '发出之后引用队列没清空（会跟着后面每一轮一起进 prompt）：' + sent.saved);
    must(!/\[引用素材：/.test(sent.value), '发出之后输入框里还留着引用标记：' + JSON.stringify(sent.value));
    must(/用户提到某张图/.test(sent.doc) && /把图取出来看/.test(sent.doc) && /不要凭名字或提示词编/.test(sent.doc),
      'asset_open 的 doc 没写明什么时候该用：' + sent.doc);

    /* ---------- 5) 凭号取图：真的取到字节、真的交给看图型号 ---------- */
    const seen = await page.eval(async () => {
      window.TextAI.chat = async (r, sys, user, opts) => {
        window.__seen = { user: String(user), images: (opts && opts.images) || [] };
        return '窄长的一条海面，右边立着一座灯塔。';
      };
      const ok = await AiChat.TOOLS.asset_open.run({ index: 0 });
      const miss = await AiChat.TOOLS.asset_open.run({ id: 'la_ref_missing_probe' });
      const s = window.__seen || {};
      return { ok, miss, user: s.user || '', images: s.images || [] };
    });
    must(seen.ok && seen.ok.资产号 === laId, 'asset_open 没按清单序号取到这一条：' + JSON.stringify(seen.ok));
    must(/灯塔/.test(seen.ok.看到的 || ''), 'asset_open 没把图交给模型（没拿回回答）：' + JSON.stringify(seen.ok));
    must(seen.images.length === 1, '看图那一步没收到图：' + JSON.stringify(seen.images.length));
    must(/^data:image\/jpeg;base64,/.test(seen.images[0].url || '') && seen.images[0].url.length > 100,
      '交出去的不是从本机资产解出来的图：' + JSON.stringify(seen.images[0] && seen.images[0].url.slice(0, 40)));
    must(/海边灯塔的一张小图|助手引用探针/.test(seen.images[0].label || ''), '图的标签丢了对不上号：' + seen.images[0].label);
    must(seen.miss && /读不出像素|取不到/.test(seen.miss.结论 || ''),
      '取不到字节时没有照实说：' + JSON.stringify(seen.miss));

    /* ---------- 6) 改字即作废：正文是真相，这条引用不再算数（资产库那一份还在） ---------- */
    await drop();
    await h.sleep(260);
    const cut = await page.eval(async () => {
      const ta = document.getElementById('acTa');
      /* 模拟用户把那段标记改坏了（少掉右括号）：正文是真相 → 这条引用作废 */
      ta.value = ta.value.replace(/\]/, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 160));
      const raw = JSON.parse(localStorage.getItem('ai_chat_refs') || 'null');
      const note = document.getElementById('acNote');
      return {
        value: ta.value,
        hl: document.querySelectorAll('.ac-ref-hl').length,
        saved: ((raw && raw.data) || raw || []).length,
        note: note && !note.hidden ? note.textContent : '',
      };
    });
    must(!/\[引用素材：[^\]\n]+\]/.test(cut.value), '改字之后那圈完整标记还在输入框里：' + JSON.stringify(cut.value));
    must(cut.hl === 0, '改字之后高亮还画着：' + cut.hl);
    must(cut.saved === 0, '改字之后引用队列里还留着：' + cut.saved);
    must(/去掉/.test(cut.note) && /不会再拿到/.test(cut.note) && /没动/.test(cut.note),
      '改字之后没说清这条引用作废了：' + JSON.stringify(cut.note));
    const still = await (await fetch(proxy.base + '/local-assets', { headers: { cookie: proxy.cookie } })).json();
    must(((still && still.data) || []).some(x => x && x.id === laId), '引用作废把本机资产也删掉了：' + JSON.stringify(still).slice(0, 300));

    const errs = (page.errors || []).filter(Boolean).slice(0, 3);
    must(!errs.length, '页面异常：' + errs.join(' | '));
    console.log('✓ 凭号取图（队列留号 · 正文清单同下标 · asset_open 真的取到字节 · 取不到照实说 · 悬停/弹层 · 改字即作废）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
