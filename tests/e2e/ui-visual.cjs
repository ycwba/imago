#!/usr/bin/env node
/* 视觉回归：九条路由（工作台按视频/图像/语音分三档）× 1024/1440 × 浅/深主题，
   另加方案 §11 视觉行点名的两处「只有状态才画」的界面：字幕编辑区、助手来源卡片。
   不存整张截图：把画面缩成 24×14 的 RGB 指纹，和 tests/fixtures/visual/fingerprints.json 比。
   首次生成基线：UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs
   只补某一页：UI_VISUAL_WRITE=1 UI_VISUAL_PAGES=canvas node tests/e2e/ui-visual.cjs（其余画面的基线原样留着）
   点名也可以直接给参数：node tests/e2e/ui-visual.cjs --pages=canvas（cmd / PowerShell 里更好抄）
   有差异时把实际截图写到 tests/fixtures/visual/actual/（gitignore）。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const h = require('./harness.cjs');

let PNG;
try { PNG = require('pngjs').PNG; }
catch (e) { console.error('缺少开发依赖 pngjs：先运行 npm install'); process.exit(2); }

const ROOT = path.resolve(__dirname, '../..');
const BASE_FILE = path.join(ROOT, 'tests/fixtures/visual/fingerprints.json');
const ACTUAL_DIR = path.join(ROOT, 'tests/fixtures/visual/actual');
const WRITE = process.env.UI_VISUAL_WRITE === '1';
/* 点名只跑这几页（按 PAGES 里的那个名字）。加一页时不必为其余画面重跑一遍，
   更不必拿这一页的一次截图去赌另外十九档在这一刻还是不是准的。
   两种写法等价：`UI_VISUAL_PAGES=canvas` 与 `--pages=canvas`（后者在 Windows 的 cmd 里也能直接粘）。
   名字给前缀也算：`--pages=studio` 命中工作台那三档（studio-video / -image / -audio），
   改一个 spa-<页>.css 要的就是这一页的所有画面。 */
const argPages = (() => {
  const i = process.argv.findIndex(a => a === '--pages' || a.startsWith('--pages='));
  if (i < 0) return '';
  const a = process.argv[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (process.argv[i + 1] || '');
})();
const ONLY = String(argPages || process.env.UI_VISUAL_PAGES || '').split(',').map(s => s.trim()).filter(Boolean);
/* 名单为空 = 全跑；点名支持精确名与前缀（studio → studio-video/-image/-audio 三档都要）。 */
const wanted = name => !ONLY.length || ONLY.some(k => name === k || name.startsWith(k + '-'));
/* 页面名单从路由表现取：这一张表以前手抄过一份，加页面时只漏在这一处不会红 —— 那一页
   只是从来没有基线。需要点名的只有两类：工作台按输出类型分三档，与两处「先喂状态才画得出来」
   的界面（在下面那两条里）。 */
const ROUTES = (() => {
  const box = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'web/core/routes.js'), 'utf8'), box, { filename: 'web/core/routes.js' });
  return box.window.WB_ROUTES;
})();
const KINDS = { 'studio.html': ['video', 'image', 'audio'] };
const PAGES = ROUTES.pages
  .flatMap(p => (KINDS[p.file] || ['']).map(k => [p.file + (k ? '?t=' + k : ''), p.id + (k ? '-' + k : '')]))
  .concat([
    ['director.html', 'director-sub', { prep: prepSubtitles, needFfmpeg: true }],
    ['settings.html', 'chat-src', { prep: prepChatSources, panel: true }],
  ]);
const uncovered = ROUTES.pages.filter(p => !PAGES.some(e => String(e[0]).split('?')[0] === p.file)).map(p => p.file);
if (uncovered.length) { console.error('这些页面在路由表里，却没有任何视觉档位：' + uncovered.join(', ')); process.exit(1); }
const SIZES = [[1024, 768], [1440, 900]];
const THEMES = ['light', 'dark'];
const GW = 24, GH = 14;

/* 状态喂出来才有画面可拍的两处（方案 §11 视觉行点名）：
   prep 只在**这一档**的画面里跑；喂完必须证明界面真画出来了，否则这一档只是把上一页重拍一遍。 */

/* 字幕：先导入一段真视频（draft 占位那条没有可播地址，选用与字幕都进不去），
   选用它，再走导演台唯一写入桥写一条 —— 右栏那一列与本镜轨道的字幕块只在这之后才画。
   同一份页面要连拍 4 个画面（两档尺寸 × 两种主题），prep 每一步都得能重跑：
   再导一次会多一条候选、再点一次剪辑开关会把这一档关掉，拍出来的就不是同一张图。 */
/* 字幕这一档要先点进两处才画得出来：剪辑模式、右栏「字幕」那一格。
   都点用户点的那两颗开关，但先看状态再点（`#trimBtn` 的 `active` 与 `#grpSub.hidden` 就是它们的当前值），
   因为同一份页面要连拍四个画面，再点一次就是把这一档关掉。 */
async function enterTrimSub(page) {
  const steps = await page.eval(() => {
    const t = document.getElementById('trimBtn');
    if (!t) return { err: '导演台没有 #trimBtn 那颗剪辑开关，字幕编辑区进不去' };
    if (!t.classList.contains('active')) t.click();
    const g = document.getElementById('grpSub');
    if (!g) return { err: '开了剪辑模式也没有「字幕」那一格（#grpSub 没画出来）' };
    if (g.hidden) {
      const b = document.querySelector('#vcTabs [data-vctab="sub"]');
      if (!b) return { err: '有 #grpSub 却没有切过去的那一颗「字幕」' };
      b.click();
    }
    return { ok: true };
  });
  if (steps.err) throw new Error(steps.err);
  await page.waitFor(() => {
    const on = el => !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 2;
    return on(document.querySelector('.sub-list .sub-row')) && on(document.querySelector('.tl-sub-lane .tl-sub'));
  }, 10000, 200).catch(() => {
    throw new Error('进了剪辑模式、点了「字幕」也没画出字幕行 / 轨道字幕块（这一档拍不到东西）');
  });
}
/* 本镜轨道的切片：填完帧才是「画好了的那一屏」，还留着占位斜纹就只是加载态。 */
function tilesFilled() {
  return document.querySelectorAll('.tl-vrow i.fr.gap').length === 0
    && document.querySelectorAll('.tl-vrow i.fr[style]').length >= 1;
}
let clipFile = '';
async function prepSubtitles(page) {
  if (!h.hasFfmpeg()) throw new Error('本机没有 ffmpeg：造不出可选用的视频，字幕编辑区这一档喂不出状态');
  const hasClip = await page.eval(() => {
    const c = window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').context();
    return !!(c && c.候选 && c.候选.some(x => x.状态 === 'succeeded'));
  });
  if (!hasClip) {
    if (!clipFile) {
      fs.mkdirSync(os.tmpdir(), { recursive: true });
      clipFile = h.makeClip(fs.mkdtempSync(path.join(os.tmpdir(), 'aii-vis-clip-')));
    }
    await page.setFile('#importMediaFile', clipFile);
    await page.waitFor(() => {
      const c = window.WBBridge.get('director').context();
      return !!(c && c.候选 && c.候选.some(x => x.状态 === 'succeeded'));
    }, 30000, 200);
  }
  const w = await page.eval(async () => {
    const A = window.WBBridge.get('director');
    const c0 = A.context();
    const list = c0.候选 || [];
    const cand = list.filter(x => x.状态 === 'succeeded')[0] || list.filter(x => x.选用 || x.当前)[0] || list[0];
    if (!cand) return { err: '这一镜没有候选，字幕没有可挂的地方' };
    let rev = c0.revision;
    if (!cand.选用) {
      const s = await A.run('select', { candId: cand.id, expectedRevision: rev });
      if (s && s.ok === false) return { err: '选用候选被拒：' + JSON.stringify(s).slice(0, 200) };
      rev = (A.context() || {}).revision;
    }
    const c = A.context();
    if (c.字幕 && c.字幕.条数 >= 1) return { 条数: c.字幕.条数 };
    const r = await A.run('set', { kind: 'subtitle', candId: cand.id,
      entries: [{ index: 1, startMs: 400, endMs: 1800, text: '本地优先的一条探针字幕' }],
      expectedRevision: rev });
    if (r && r.ok === false) return { err: '写字幕被拒：' + JSON.stringify(r).slice(0, 200) };
    return { 条数: (A.context().字幕 || {}).条数 || 0 };
  });
  if (w.err) throw new Error('字幕编辑区没喂出状态：' + w.err);
  await enterTrimSub(page);
  /* 拍之前要把这一屏钉住：切片是解码完才回填的（没填好就是一排斜纹），甲板也可能还在播。
     整站连拍五十来张时，前面那些页面还占着同源连接，这一屏的解码会排不上 ——
     轨道那一侧有「退避到点自己再排一遍活」的闸门，等它把画面补回来就行，不靠再点一次剪辑开关去催。 */
  await page.eval(() => { [...document.querySelectorAll('video')].forEach(v => { try { v.pause(); } catch (e) {} }); return true; });
  await page.waitFor(tilesFilled, 90000, 400).catch(() => {});
  if (!(await page.eval(tilesFilled))) {
    const c = await page.eval(() => ({ gaps: document.querySelectorAll('.tl-vrow i.fr.gap').length,
      filled: document.querySelectorAll('.tl-vrow i.fr[style]').length,
      格子: [...document.querySelectorAll('.tl-vrow [data-frs]')].map(t => (t.getAttribute('data-frs') || '(空)').slice(0, 40)
        + ' n=' + t.getAttribute('data-n')).join(' | '),
      影: [...document.querySelectorAll('video')].map(v => 'rs=' + v.readyState + (v.paused ? ' 停' : ' 播')
        + ' src=' + String(v.currentSrc || v.src || '').slice(0, 40)).join(' | '),
      暂停: String(window.__directorSlicePaused ? window.__directorSlicePaused() : '(没有这个口子)'),
      活动: String(window.__spaActivity && window.__spaActivity.visible ? window.__spaActivity.visible() : '(读不到)') }));
    throw new Error('本镜轨道的切片一直没填完（填好 ' + c.filled + ' 格、还剩 ' + c.gaps + ' 格占位）——这一档拍出来的是加载态\n  '
      + JSON.stringify(c, null, 1));
  }
  const got = await page.eval(() => {
    const on = el => !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 2;
    return { rows: [...document.querySelectorAll('.sub-list .sub-row')].filter(on).length,
      lane: [...document.querySelectorAll('.tl-sub-lane .tl-sub')].filter(on).length };
  });
  if (!(got.rows >= 1 && got.lane >= 1)) {
    throw new Error('字幕写进去了但编辑区没画出来（右栏行 ' + got.rows + '、轨道块 ' + got.lane + '）——这一档拍不到东西');
  }
  return '字幕 ' + w.条数 + ' 条（右栏 ' + got.rows + ' 行 · 轨道 ' + got.lane + ' 块）';
}

/* 助手来源卡片：一轮搜索（固定回包 + 本机假上游）跑完，卡片挂在回答下面；
   后面几档直接从会话记录里画同一份，不再打上游。抽屉默认被冻住隐藏，这一档单独放行。
   要不要喂这一轮，看的是**抽屉里已经画出来几张**：数 localStorage 的消息形状会每档都再打一次上游，
   四张画面就成了 2、4、6、8 张卡片，同一档拍不出同一张图。 */
let chatFake = null;
async function prepChatSources(page, proxy) {
  await page.eval(() => { AiChat.open(); return true; });
  /* 底栏提示是设置页那份供应方 / 型号回来之后才写的（paintHint）：不等它落定，
     同一档第一次拍在写之前、第二次拍在写之后，四张画面里会出现两种底栏。 */
  await page.waitFor(() => {
    const h = document.getElementById('acHint');
    return !!h && !!h.textContent.trim();
  }, 15000).catch(() => {});
  await page.waitFor(() => !!document.querySelector('.ac-src-a'), 15000).catch(() => {});
  const painted = await page.eval(() => document.querySelectorAll('.ac-src-a').length);
  if (painted < 2) {
    if (!chatFake) {
      chatFake = await h.startFakeSearch(() => [
        { title: '本地优先的 AI 工作台', url: 'https://example.com/a', content: '把数据留在本机。', published_date: '2026-10-01' },
        { title: '字幕与配音怎么挂到时间线', url: 'https://example.com/b', content: '一条源秒一份账。', published_date: '2026-09-20' },
      ]);
      await h.useFakeSearch(proxy, chatFake, 'tvly-visual');
    }
    await page.eval(() => {
      localStorage.setItem('sk_text_prov', 'deepseek');
      localStorage.setItem('sk_model_deepseek', 'stub-model');
      const script = [
        'CALL: web_search {"query":"本地优先 是什么","limit":2}',
        '按搜到的资料回答：做法见 [来源 1]，另一条见 [来源 2]。',
      ];
      window.TextAI.chatStream = async () => {
        const line = script.shift();
        return line == null ? '（探针脚本用完）' : line;
      };
      AiChat.open();
      return true;
    });
    await new Promise(r => setTimeout(r, 900));
    await page.eval(() => AiChat.ask('本地优先的做法是什么'));
    await page.waitFor(() => !!document.querySelector('.ac-src'), 25000);
  }
  const n = await page.eval(() => document.querySelectorAll('.ac-src-a').length);
  if (!(n >= 2)) throw new Error('抽屉里没有来源卡片（' + n + ' 条）——这一档拍不到东西');
  return '来源卡片 ' + n + ' 条';
}

function fingerprint(buf) {
  const png = PNG.sync.read(buf);
  const cellW = png.width / GW, cellH = png.height / GH;
  const out = [];
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const x0 = Math.floor(gx * cellW), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));
      const y0 = Math.floor(gy * cellH), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
      for (let y = y0; y < Math.min(y1, png.height); y++) {
        for (let x = x0; x < Math.min(x1, png.width); x++) {
          const i = (y * png.width + x) * 4;
          r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
        }
      }
      out.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
    }
  }
  return out;
}

function diff(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return { bad: true, cells: 999, mean: 255, max: 255 };
  let cells = 0, sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.max(
      Math.abs((a[i] && a[i][0] || 0) - (b[i] && b[i][0] || 0)),
      Math.abs((a[i] && a[i][1] || 0) - (b[i] && b[i][1] || 0)),
      Math.abs((a[i] && a[i][2] || 0) - (b[i] && b[i][2] || 0))
    );
    sum += d;
    if (d > 24) cells++;
    if (d > max) max = d;
  }
  return { bad: false, cells, mean: sum / a.length, max };
}

(async () => {
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    const baseline = fs.existsSync(BASE_FILE) ? JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')) : { version: 1, screens: {} };
    if (!baseline.screens || typeof baseline.screens !== 'object') baseline.screens = {};
    /* 只点名跑几页时，其余画面的旧基线要原样留着：这一份文件是全站的历史，不是这一次的草稿。 */
    const next = { version: 1, at: new Date().toISOString(), screens: Object.assign({}, baseline.screens) };
    let bad = 0, checked = 0;
    /* 没有 ffmpeg 就拍不出「字幕编辑区」那一档（要一段可选用的真视频）：整档跳过，
       而不是拿一张没有字幕的画面去冒充基线。 */
    const screens = PAGES.filter(e => {
      if (e[2] && e[2].needFfmpeg && !h.hasFfmpeg()) {
        console.log('- 跳过 ' + e[1] + '：本机没有 ffmpeg，造不出可选用的视频');
        return false;
      }
      return true;
    });
    for (const entry of screens) {
      const [route, name, opts] = [entry[0], entry[1], entry[2] || {}];
      if (!wanted(name)) continue;
      for (const [w, hgt] of SIZES) {
        for (const theme of THEMES) {
          const key = name + '|' + w + '|' + theme;
          await page.setSize(w, hgt);
          await page.goto(proxy.base + '/shell.html#' + route);
          /* 工作室右栏会去各平台拉历史：真网慢，30 秒超时后拍出一块「没取回来」的错误横幅，
             同一档两次是两种画面。视觉档只看版式，把这份跨平台读口换成空清单
             （本机自己的任务记录仍照常画）—— 这一条必须在页面挂载前打上，
             且只打工作室三档：别的页的本机资产清单还要照常读。 */
          if (name.startsWith('studio-')) {
            await page.eval(() => {
              const L = window.AssetLib;
              if (!L || typeof L.load !== 'function') return false;
              if (!L.__visualLoad) {
                L.__visualLoad = L.load;
                L.load = async () => ({ entries: [], cursors: {}, hasMore: false, errors: {}, failed: {} });
              }
              return true;
            });
          }
          await page.waitFor(() => document.body && document.body.innerText.trim().length > 20, 15000);
          /* 抽屉默认冻住不拍（每一档都一样）；只有「来源卡片」这一档把它放行。 */
          const hide = opts.panel ? '#acBall,.toast-box' : '#acBall,#acPanel,.toast-box';
          await page.eval((t, hideIt) => {
            localStorage.setItem('dir_theme', t);
            document.documentElement.dataset.theme = t;
            /* 各档共用同一个文档（同路由只换 hash）：这一条不先摘掉，上一档「藏起抽屉」的
               规则就还留在 <head> 里，挂到来源卡片那一档时抽屉永远画不出来。 */
            const old = document.getElementById('__visual_freeze');
            if (old) old.remove();
            const st = document.createElement('style');
            st.id = '__visual_freeze';
            st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' +
              hideIt + '{display:none!important}';
            document.head.appendChild(st);
          }, theme, hide);
          /* 「正在取回…」是历史栏的异步回填（studio 三档）：不定下来就拍，同一页会在
             「正在取回…」与稳定读数之间来回变指纹 —— 那是探针在赌机器快慢，不是画面改版。 */
          await page.waitFor(() => {
            const t = document.body.innerText;
            const note = document.getElementById('histNote');
            return !t.includes('加载中…') && !t.includes('正在读取生成记录…')
              && (!note || !/正在取回/.test(note.textContent))
              && !document.querySelector('.spa-frame-loading');
          }, 15000).catch(() => {});
          /* 只等 body 有字不够：外壳侧栏先有字，studio 页可能还没挂上 —— 那样会拍到
             「请选择」和半截设置区，接着历史那一栏才慢悠悠地回填。等型号真选上、
             历史注脚真画出来再往下走（三档共用一个页面根）。 */
          if (name.startsWith('studio-')) {
            await page.waitFor(() => {
              const page = document.querySelector('.studio-page');
              const sel = document.getElementById('model');
              const note = document.getElementById('histNote');
              return !!page && !!sel && !!sel.value && !!note && !/正在取回/.test(note.textContent);
            }, 30000).catch(() => {});
          }
          let label = '';
          if (opts.prep) label = await opts.prep(page, proxy);
          await new Promise(r => setTimeout(r, 700));
          /* 固定等待之后再看一眼：历史栏的回填可能恰好在这一段里才开始。 */
          await page.waitFor(() => {
            const note = document.getElementById('histNote');
            const sel = document.getElementById('model');
            return (!note || !/正在取回/.test(note.textContent)) && (!sel || !!sel.value);
          }, 15000).catch(() => {});
          const shot = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
          const buf = Buffer.from(shot.data, 'base64');
          const fp = fingerprint(buf);
          next.screens[key] = fp;
          const want = baseline.screens[key];
          if (!want) {
            if (!WRITE) { bad++; console.log('✗ ' + key + '：没有基线（跑 UI_VISUAL_WRITE=1 生成）' + (label ? '（' + label + '）' : '')); }
            else console.log('✓ ' + key + ' 写入基线' + (label ? '（' + label + '）' : ''));
            continue;
          }
          const d = diff(want, fp);
          checked++;
          const fail = d.bad || d.cells > 24 || d.mean > 8;
          if (fail) {
            bad++;
            fs.mkdirSync(ACTUAL_DIR, { recursive: true });
            const out = path.join(ACTUAL_DIR, key.replace(/[|?]/g, '_') + '.png');
            fs.writeFileSync(out, buf);
            console.log('✗ ' + key + '：差异过大（' + d.cells + ' 格 >24，均值 ' + d.mean.toFixed(1) + '，最大 ' + d.max + '）→ ' + path.relative(ROOT, out) + (label ? '（' + label + '）' : ''));
          } else {
            console.log('✓ ' + key + (label ? '（' + label + '）' : ''));
          }
        }
      }
    }
    if (WRITE) {
      fs.mkdirSync(path.dirname(BASE_FILE), { recursive: true });
      fs.writeFileSync(BASE_FILE, JSON.stringify(next, null, 2) + '\n');
      console.log('\n已写入视觉基线：' + path.relative(ROOT, BASE_FILE));
      return;
    }
    if (bad) throw new Error(bad + ' 个画面与基线不一致');
    console.log('\n✓ 视觉回归通过（' + checked + ' 个画面）');
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
    if (chatFake) chatFake.stop();
  }
  process.exit(0);
})().catch(e => { console.error('\n✗ ' + (e && e.message || e)); process.exit(1); });
