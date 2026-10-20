#!/usr/bin/env node
/* 画布「选完平台、型号下拉还是空的」回归（用户报的「不能正常使用」那条）。
   根因在页面自己：画布挂载时只取了注册表，从来没向能力层要过型号清单 ——
   而 vgenv / sparkcine 这类平台的 `prov.models` 只由 /capabilities 的结果现场长出来，
   注册表里没有写死。于是平台选得出来、型号那一格永远是「先选平台」。
   这份探针把能力层挂住：画布不发起这一次加载，型号列表就永远是空的；发起并合回来之后，
   型号下拉必须自己弹出来（检查器还开着时要跟着重画，不能让用户再点一次）。
   不碰任何生成平台：这里只验型号清单从哪来，一颗生成按钮都不按。 */
'use strict';
const h = require('./harness.cjs');

let n = 0;
function must(cond, msg) { if (!cond) throw new Error('第 ' + (++n) + ' 项不成立：' + msg); ++n; }

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();

    /* 文档脚本之前挂两件事：
       1) 本机「配过 vgenv 的密钥」：Api.forKind 只列本机在用的平台，少这一格平台下拉就是空的；
       2) 能力层的 load 先挂住不返回，放行时只往注册表里塞一个探针型号（模拟 /capabilities
          现场长出来的那一条），不发出站请求。画布漏了这一次调用，下面第 4 项当场红。 */
    await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      try { localStorage.setItem('sk_key_vgenv', 'probe-key'); } catch (e) {}
      (() => {
        let cap = null;
        Object.defineProperty(window, 'Capabilities', {
          configurable: true,
          get() { return cap; },
          set(v) {
            cap = v;
            if (!v || typeof v.load !== 'function') return;
            v.load = function (REG) {
              window.__capLoads = (window.__capLoads || 0) + 1;
              window.__capREG = REG;
              return new Promise(resolve => {
                let done = false;
                window.__releaseCaps = () => {
                  if (done) return;
                  done = true;
                  try {
                    const p = window.Api && Api.prov('vgenv');
                    if (p) {
                      p.models = (p.models || []).filter(m => m.id !== 'vg-probe').concat([
                        { id: 'vg-probe', name: '探针视频型号', options: {}, modes: [] },
                      ]);
                    }
                  } finally { resolve(1); }
                };
              });
            };
          },
        });
      })();
    ` });

    await page.goto(proxy.base + '/shell.html#canvas.html');
    await page.waitFor('!!document.querySelector(".cv-lib")', 25000);
    await page.waitFor('window.WBBridge && window.WBBridge.get("canvas")', 25000);

    /* ---------- 1) 画布挂载必须向能力层要一次 ---------- */
    const loads = await page.eval(() => window.__capLoads || 0);
    must(loads >= 1, '画布挂载时要向能力层要一次型号清单（现在一次都没要，型号只能永远是空的）：' + loads);
    must(await page.eval(() => !!(window.__capREG && window.__capREG.providers && window.__capREG.providers.length)),
      '交给能力层的必须是注册表本体（空壳合并不出型号）');
    must(await page.eval(() => typeof window.__releaseCaps === 'function'), '能力层这一次加载应还挂着（探针要自己放行）');

    /* ---------- 2) 建画布、加一个视频节点（会自己打开检查器） ---------- */
    must(await page.eval(() => { const b = document.querySelector('.cv-lib-bar button.pri'); if (!b) return false; b.click(); return true; }),
      '新建画布按钮点得到');
    await page.waitFor('!!document.getElementById("pfDlg")', 10000);
    await page.eval(() => { document.getElementById('pf_0').value = '型号探针'; document.getElementById('pfOk').click(); });
    await page.waitFor('(function(){var b=window.WBBridge.get("canvas");var c=b&&b.context();return !!(c&&c.id&&c.节点数>=1);})()', 20000);
    await page.eval(() => document.querySelector('.cv-dock .tool[title="添加节点（N）"]').click());
    await page.waitFor('!!document.getElementById("uiDlg")', 10000);
    await page.eval(() => { const b = document.querySelector('#uiDlg .cv-menu button[data-v="video"]'); if (!b) throw new Error('节点菜单里没有视频'); b.click(); });
    await page.waitFor('!!document.querySelector(".cv-insp-b select[data-f=\\"prov\\"]")', 10000);

    const snap = () => page.eval(() => {
      const prov = document.querySelector('.cv-insp-b select[data-f="prov"]');
      const model = document.querySelector('.cv-insp-b select[data-f="model"]');
      const vals = el => el ? [...el.options].map(o => o.value) : [];
      const texts = el => el ? [...el.options].map(o => o.textContent) : [];
      return { provDisabled: !!prov && prov.disabled, provValues: vals(prov),
        modelDisabled: !!model && model.disabled, modelValues: vals(model), modelTexts: texts(model) };
    });

    /* ---------- 3) 平台选得出来；能力还没回来时型号那一格必须是空的 ---------- */
    let s = await snap();
    must(!s.provDisabled && s.provValues.includes('vgenv'),
      '本机配过密钥的平台要出现在平台下拉里：' + JSON.stringify(s.provValues));
    must(s.modelDisabled && s.modelValues.length === 1,
      '能力还没回来时型号下拉应是禁用的空档（不许假装有东西）：' + JSON.stringify(s));

    await page.eval(() => {
      const el = document.querySelector('.cv-insp-b select[data-f="prov"]');
      el.value = 'vgenv';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    let vn = await page.eval(() => {
      const c = window.WBBridge.get('canvas').context();
      const row = c.节点.find(x => x.type === 'video');
      return row ? window.WBBridge.get('canvas').nodeRead(row.id).metadata || {} : null;
    });
    must(vn && vn.prov === 'vgenv', '选中平台要落进节点（prov=vgenv）：' + JSON.stringify(vn));
    s = await snap();
    must(s.modelDisabled && s.modelValues.length === 1,
      '型号清单还没回来时，选完平台也要照实空着、不画假选项：' + JSON.stringify(s));

    /* ---------- 4) 能力回来 → 检查器自己重画出型号，不用再点一次 ---------- */
    await page.eval(() => window.__releaseCaps());
    await page.waitFor('(function(){var m=document.querySelector(".cv-insp-b select[data-f=\\"model\\"]");return !!m && !m.disabled && [...m.options].some(o=>o.value==="vg-probe");})()', 10000);
    s = await snap();
    must(s.modelValues.includes('vg-probe') && s.modelTexts.includes('探针视频型号'),
      '能力层长出来的型号要出现在下拉里（带显示名）：' + JSON.stringify(s));
    must(!s.modelDisabled, '有型号之后型号下拉必须可点');

    /* ---------- 5) 选型号落进节点；换平台清掉型号，换回来清单还在 ---------- */
    await page.eval(() => {
      const el = document.querySelector('.cv-insp-b select[data-f="model"]');
      el.value = 'vg-probe';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    vn = await page.eval(() => {
      const c = window.WBBridge.get('canvas').context();
      const row = c.节点.find(x => x.type === 'video');
      return row ? window.WBBridge.get('canvas').nodeRead(row.id).metadata || {} : null;
    });
    must(vn && vn.model === 'vg-probe', '选中的型号要落进节点：' + JSON.stringify(vn));

    await page.eval(() => {
      const el = document.querySelector('.cv-insp-b select[data-f="prov"]');
      el.value = '';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    vn = await page.eval(() => {
      const c = window.WBBridge.get('canvas').context();
      const row = c.节点.find(x => x.type === 'video');
      return row ? window.WBBridge.get('canvas').nodeRead(row.id).metadata || {} : null;
    });
    must(vn && vn.prov === '' && vn.model === '', '换平台要同时清掉旧型号：' + JSON.stringify(vn));
    s = await snap();
    must(s.modelDisabled && s.modelValues.length === 1, '没有平台时型号下拉重新空着：' + JSON.stringify(s));

    await page.eval(() => {
      const el = document.querySelector('.cv-insp-b select[data-f="prov"]');
      el.value = 'vgenv';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitFor('(function(){var m=document.querySelector(".cv-insp-b select[data-f=\\"model\\"]");return !!m && !m.disabled && [...m.options].some(o=>o.value==="vg-probe");})()', 10000);
    must((await page.eval(() => window.__capLoads)) === loads,
      '换平台不该再问一次能力层（清单已经在注册表里）');

    const outs = await page.eval(() => window.__out || 0);
    must(outs === 0, '这一段一次生成请求都不该发：' + outs);
    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 画布型号回归：挂载时向能力层要清单 · 能力没回来时空着 · 回来后检查器自己重画 · 选平台/选型号落进节点 · 换平台清型号且不复问 · 零控制台错误');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
