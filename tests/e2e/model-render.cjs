#!/usr/bin/env node
/* 建模台出图的像素基线（真浏览器 + 真 WebGL 渲染）。
   守的是「默认布光的存量白膜，出图与改动前逐像素一致」：场景不带 lights / light 段
   （读进来就是内置主光 + 补光），固定三件白模与固定的活动机位，用页面「出图」同一条
   grab 渲染路拍活动机位画面，缩成 24×14 指纹与基线比。
   第二张把主光打成两帧的灯轨道、播放头点到第 2 秒再拍：逐帧灯光的能量 / 颜色必须
   真的进画面（两张之间的差异由判据自己量，不是只看单张）。
   为什么在 e2e 档：要起 Chrome + 真 WebGL，跑不进常驻判据；CI 不跑这一档。
   同一台机器上两次独立浏览器进程的出图逐字节一致（WARP 软渲染），所以阈值取得比
   整页截图那条紧：任一分量差 >16 的格子超过 16 个、或平均差 >4、或单格最大差 >60 即红。
   基线：tests/fixtures/visual/model-render.json
   重打基线：UI_MODEL_RENDER_WRITE=1 node tests/e2e/model-render.cjs
   只留底不改基线：UI_MODEL_RENDER_SAVE=1 node tests/e2e/model-render.cjs（写进视觉那间 actual/，gitignore）
   跑法：`node tests/e2e/model-render.cjs` */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '../..');
const BASE_FILE = path.join(ROOT, 'tests/fixtures/visual/model-render.json');
const ACTUAL_DIR = path.join(ROOT, 'tests/fixtures/visual/actual');
const WRITE = process.env.UI_MODEL_RENDER_WRITE === '1';
const SAVE = process.env.UI_MODEL_RENDER_SAVE === '1';

/* 基线文件一屏一行：336 个三元组铺开是几千行噪声，diff 里只该看见「哪一屏变了」。 */
function serialize(pack) {
  const screens = pack.screens || {};
  const rows = Object.keys(screens).sort()
    .map(k => '    ' + JSON.stringify(k) + ': ' + JSON.stringify(screens[k]));
  return '{\n  "version": 1,\n  "at": ' + JSON.stringify(pack.at)
    + ',\n  "screens": {\n' + (rows.length ? rows.join(',\n') + '\n' : '') + '  }\n}\n';
}

/* 一张指纹的亮度跨度：全同色 = 0（白屏 / 黑屏）。基线可以比，但先要证明它拍到了东西。 */
function spread(fp) {
  const lum = fp.map(c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
  return Math.max(...lum) - Math.min(...lum);
}

/* 出图走页面「出图」同一条 grab 渲染路（活动机位、RenderTarget、没有视口辅助物）。
   thumbnail() 交回来的是 JPEG，而指纹解析器只吃 PNG —— 在页面里解回 canvas 再转 PNG，
   来回都是确定性的，不引第二种解码依赖。 */
async function shot(page) {
  const data = await page.eval(async () => {
    const jpg = await window.WBBridge.get('model3d').thumbnail();
    if (!jpg || !String(jpg).startsWith('data:image/jpeg')) return { err: String(jpg).slice(0, 120) || '空' };
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = jpg; });
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext('2d', { alpha: false }).drawImage(img, 0, 0);
    return { png: cv.toDataURL('image/png') };
  });
  if (!data || data.err) {
    throw new Error('建模台没给出出图（thumbnail 不是 JPEG dataURL）：' + ((data && data.err) || '空'));
  }
  return Buffer.from(String(data.png).slice(String(data.png).indexOf(',') + 1), 'base64');
}

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.skipDataSyncBoot();
    await page.goto(proxy.base + '/shell.html#model.html');

    /* 新探针里一个白模库都没有：先建一个默认库再重载，开机才会选中它。 */
    await page.eval(async () => {
      const v = await import('/web/model3d/vault.js');
      const d = await v.list('');
      if (!d.libraries || !d.libraries.length) await v.saveLibrary({ name: '默认库' });
      return true;
    });
    await page.goto(proxy.base + '/shell.html?seed=render#model.html');
    await page.waitFor(() => {
      const b = window.WBBridge && window.WBBridge.get('model3d');
      return !!(b && b.ready());
    }, 30000);

    /* 固定场景：一块台面 + 一只球 + 一根柱，机位与视场角写死。
       场景不带 lights / light 段 —— 归一化补上的就是存量白膜的默认布光。 */
    const seeded = await page.eval(async () => {
      const b = window.WBBridge.get('model3d');
      const r = await b.run('edit', {
        ops: [
          { op: 'add', node: { kind: 'prim', name: '台面', shape: 'box', at: [0, 0.1, 0], size: [3, 0.2, 2.2], tone: 'mid' } },
          { op: 'add', node: { kind: 'prim', name: '球', shape: 'sphere', at: [0.75, 0.9, 0], size: [1.1, 1.1, 1.1], tone: 'hi' } },
          { op: 'add', node: { kind: 'prim', name: '柱', shape: 'cylinder', at: [-0.85, 0.85, 0.15], size: [0.5, 1.4, 0.5], tone: 'lo' } },
          { op: 'cam', id: 'cam-1', set: { pos: [4.2, 2.6, 5.4], target: [0, 0.7, 0], fov: 45 } },
        ],
      });
      return { ok: !!(r && r.ok), err: (r && r.err) || '' };
    });
    if (!seeded.ok) throw new Error('固定场景没种进去：' + seeded.err);
    /* 场景是同步建出来的白模，等一帧画完再拍（rAF 的脏标记由 setDoc 踢起来）。 */
    await h.sleep(800);

    const baseline = fs.existsSync(BASE_FILE)
      ? JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'))
      : { version: 1, screens: {} };
    if (!baseline.screens || typeof baseline.screens !== 'object') baseline.screens = {};
    const next = { version: 1, at: new Date().toISOString(), screens: {} };
    let bad = 0;
    const put = (key, fp) => {
      next.screens[key] = fp;
      const want = baseline.screens[key];
      if (!want) {
        if (!WRITE) { bad++; console.log('✗ ' + key + '：没有基线（跑 UI_MODEL_RENDER_WRITE=1 生成）'); }
        else console.log('✓ ' + key + ' 写入基线');
        return fp;
      }
      const d = h.fpDiff(want, fp, 16);
      if (d.bad || d.cells > 16 || d.mean > 4 || d.max > 60) {
        bad++;
        console.log('✗ ' + key + '：像素与基线不一致（' + d.cells + ' 格 >16，均值 ' + d.mean.toFixed(2)
          + '，最大 ' + d.max + '）' + (SAVE ? ' → 实际图见 tests/fixtures/visual/actual/' : ''));
      } else {
        console.log('✓ ' + key + '（' + d.cells + ' 格 >16，均值 ' + d.mean.toFixed(2) + '，最大 ' + d.max + '）');
      }
      return fp;
    };

    /* ① 默认布光、播放头在 0 秒。 */
    const png1 = await shot(page);
    if (SAVE) {
      fs.mkdirSync(ACTUAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(ACTUAL_DIR, 'model-render_default.png'), png1);
    }
    const fp1 = put('model-render|default', h.fingerprint(png1));
    if (!(spread(fp1) > 40)) { bad++; console.log('✗ 默认布光那张几乎是纯色（亮度跨度 ' + spread(fp1).toFixed(1) + '）—— 没拍到东西'); }

    /* ② 主光（l-key）打成两帧的灯轨道：0 秒原样，2 秒能量 0.5、颜色 #ff8844。
       把播放头点到轨道条正中（成片 4 秒 → 2 秒），逐帧灯光必须进画面。 */
    const lit = await page.eval(async () => {
      const b = window.WBBridge.get('model3d');
      const r = await b.run('edit', {
        ops: [{
          op: 'track',
          add: {
            of: { kind: 'light', id: 'l-key' },
            keys: [
              { t: 0, energy: 2.1, color: '#ffffff' },
              { t: 2, energy: 0.5, color: '#ff8844' },
            ],
          },
        }],
      });
      if (!r || !r.ok) return { err: (r && r.err) || '灯轨道没加上' };
      const row = document.querySelector('[data-r="mmDock"] .mm-track-row[data-track-id] .mm-track-bar');
      if (!row) return { err: '时间轴坞里没有刚加的灯轨道' };
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
      return { ok: true };
    });
    if (lit.err) throw new Error('灯轨道 / 定位失败：' + lit.err);
    await h.sleep(800);
    const png2 = await shot(page);
    if (SAVE) {
      fs.mkdirSync(ACTUAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(ACTUAL_DIR, 'model-render_light-key.png'), png2);
    }
    const fp2 = put('model-render|light-key', h.fingerprint(png2));
    const d12 = h.fpDiff(fp1, fp2, 16);
    if (!(d12.cells > 20)) {
      bad++;
      console.log('✗ 打了灯轨道、定位到第 2 秒，画面却没变（' + d12.cells + ' 格 >16，均值 ' + d12.mean.toFixed(2)
        + '）—— 逐帧灯光没进画面');
    } else {
      console.log('✓ 灯轨道生效（两张差 ' + d12.cells + ' 格 >16，均值 ' + d12.mean.toFixed(2) + '）');
    }

    if (page.errors.length) { bad++; console.log('✗ 控制台错误：' + page.errors.slice(-3).join(' | ')); }
    if (WRITE) {
      fs.mkdirSync(path.dirname(BASE_FILE), { recursive: true });
      fs.writeFileSync(BASE_FILE, serialize(next));
      console.log('\n已写入建模台出图基线：' + path.relative(ROOT, BASE_FILE));
      if (bad) throw new Error(bad + ' 处自检失败（基线仍已按当前画面重打）');
      return;
    }
    if (bad) throw new Error(bad + ' 处不符合');
    console.log('\n✓ 建模台出图的像素基线通过');
  } catch (e) {
    console.error('\n✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
  }
})();
