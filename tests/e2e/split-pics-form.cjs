#!/usr/bin/env node
/* 拆分镜图片界面判据（PromptForm 的 pics 多图栏 + 审阅行的挂图缩略）：
   ① Ctrl+V 粘贴一张图 → 缩略就地出现、textarea 光标处插「［图N］」占位；
   ② 把图片文件拖进弹窗 → 第二张缩略出现（与粘贴同一副落点）、dragover 时缩略行亮描边；
   ③ 字节的 `onFile` 钩子被调（粘贴 / 拖入同走它 —— 拆分镜那一路在这里做压缩）；
   ④ × 摘一张：缩略与隐藏值一起少一张；
   ⑤ 排版统一：表单缩略（.pf-picit）与审阅行挂图（.pr-pic）同为 44px 档。
   素材图用探针现造的 PNG（pngjs 不进这条：canvas.toBlob 直接造）。 */
'use strict';
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 1×1 PNG 的最小字节（探针只要「是张图」；内容无关）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  let proxy = null, browser = null, page = null;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.goto(proxy.base + '/shell.html');
    await page.waitFor(() => !!window.PromptForm && !!window.PromptReview, 20000);

    /* 开一个最小表单：pics 字段（onFile 记账）+ 一格 textarea。 */
    await page.eval(() => {
      window.__PF = { onFile: 0 };
      window.__pfRes = null;
      window.__pfDone = PromptForm.open({
        title: '判据：图片栏',
        okLabel: '确定',
        fields: [
          { key: 'script', type: 'textarea', value: '', placeholder: '剧本' },
          { key: 'pics', type: 'pics', label: '参考图', value: [],
            onFile: async f => { window.__PF.onFile++; return 'data:image/png;base64,' + btoa('img' + window.__PF.onFile); },
            pick: null },
        ],
      }).then(r => { window.__pfRes = r; });
      return true;
    });
    await page.waitFor(() => !!document.querySelector('#pfDlg'), 10000);

    /* ① 粘贴一张图（合成 ClipboardEvent 派发到 textarea——真实用户光标就在那里） */
    await page.eval(b64 => {
      const d = document.querySelector('#pfDlg');
      const ta = d.querySelector('textarea');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)))], 'p1.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      (ta || d).dispatchEvent(ev);
    }, PNG_B64);
    await page.waitFor(() => document.querySelectorAll('#pfDlg .pf-picit').length >= 1, 8000, 150);
    const p1 = await page.eval(() => ({
      n: document.querySelectorAll('#pfDlg .pf-picit').length,
      ta: document.querySelector('#pfDlg textarea').value,
      onFile: window.__PF.onFile,
      hiddenVal: JSON.parse(document.querySelector('#pfDlg input[type="hidden"]').value || '[]').length,
    }));
    if (p1.n !== 1) throw new Error('粘贴后缩略没有出现：' + JSON.stringify(p1));
    if (p1.ta.indexOf('［图1］') < 0) throw new Error('textarea 里没有插占位：' + JSON.stringify(p1.ta));
    if (p1.onFile !== 1) throw new Error('粘贴的字节没有走 onFile 钩子');

    /* ② 拖一张图进弹窗（dragover 高亮 + drop 落到 textarea 上：占位插进光标处） */
    await page.eval(b64 => {
      const d = document.querySelector('#pfDlg');
      const ta = d.querySelector('textarea');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)))], 'p2.png', { type: 'image/png' }));
      Object.defineProperty(dt, 'types', { value: ['Files'] });
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(over, 'dataTransfer', { value: dt });
      (ta || d).dispatchEvent(over);
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: dt });
      (ta || d).dispatchEvent(drop);
    }, PNG_B64);

    await page.waitFor(() => document.querySelectorAll('#pfDlg .pf-picit').length >= 2, 8000, 150);
    const p2 = await page.eval(() => ({
      n: document.querySelectorAll('#pfDlg .pf-picit').length,
      onFile: window.__PF.onFile,
      hot: !!document.querySelector('#pfDlg .pf-pics-t.hot'),
      ta: document.querySelector('#pfDlg textarea').value,
    }));
    if (p2.onFile !== 2) throw new Error('拖入的字节没有走 onFile 钩子：' + JSON.stringify(p2));
    if (p2.hot) throw new Error('drop 之后高亮没还原（.hot 还挂着）');
    if (p2.ta.indexOf('［图2］') < 0) throw new Error('拖入的占位没有插进 textarea：' + p2.ta);

    /* ④ × 摘第一张 */
    await page.eval(() => document.querySelector('#pfDlg .pf-picrm').click());
    await sleep(200);
    const p3 = await page.eval(() => ({
      n: document.querySelectorAll('#pfDlg .pf-picit').length,
      hiddenVal: JSON.parse(document.querySelector('#pfDlg input[type="hidden"]').value || '[]').length,
    }));
    if (p3.n !== 1 || p3.hiddenVal !== 1) throw new Error('× 摘一张后缩略与值没少：' + JSON.stringify(p3));

    /* ③⑤ 排版统一：表单缩略 44px；审阅行挂图（openBoard 的 .pr-pic）也 44px */
    const px = await page.eval(() => {
      const f = document.querySelector('#pfDlg .pf-picit');
      const fs = getComputedStyle(f);
      return { w: parseFloat(fs.width), h: parseFloat(fs.height) };
    });
    if (!(px.w === 44 && px.h === 44)) throw new Error('表单缩略不是 44px 档：' + JSON.stringify(px));

    /* 审阅行的挂图：openBoard 一份最小清单 + pics 表，量 .pr-pic */
    await page.eval(b64 => {
      document.querySelector('#pfDlg #pfCancel').click();
      window.__prDone = PromptReview.openList({
        title: '判据：审阅挂图',
        mode: 'board',
        items: [
          { key: 's·1', scene: 's', name: '一镜', dur: 5, text: '甲', line: '', who: '', chain: '', pics: [0] },
        ],
        pics: [{ label: '图1', src: 'data:image/png;base64,' + b64.replace('iVBORw0KGgo', 'iVBORw0KGgx') }],
      }).then(() => { window.__prRes = true; });
      return true;
    }, PNG_B64);
    await page.waitFor(() => !!document.querySelector('#prDlg .pr-pic img'), 10000);
    const pr = await page.eval(() => {
      const el = document.querySelector('#prDlg .pr-pic');
      const fs = getComputedStyle(el);
      return { w: parseFloat(fs.width), h: parseFloat(fs.height) };
    });
    if (!(pr.w === 44 && pr.h === 44)) throw new Error('审阅行挂图不是 44px 档（与表单不一致）：' + JSON.stringify(pr));

    console.log('split-pics-form: 粘贴 / 拖入 / onFile / × 摘 / 44px 统一 ✓');
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (proxy) {
      await proxy.stop();
      const f = h.logFaults(proxy.log);
      if (f.length) { console.error(f.join('\n')); process.exitCode = 1; }
    }
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
