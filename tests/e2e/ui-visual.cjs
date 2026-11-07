#!/usr/bin/env node
/* 视觉回归：九条路由（工作台按视频/图像/语音分三档）× 1024/1440 × 浅/深主题，
   另加两处「只有状态才画」的界面：字幕编辑区、助手来源卡片。
   不存整张截图：把画面缩成 24×14 的 RGB 指纹，和 tests/fixtures/visual/fingerprints.json 比。
   首次生成基线：UI_VISUAL_WRITE=1 node tests/e2e/ui-visual.cjs
   只补某一页：UI_VISUAL_WRITE=1 UI_VISUAL_PAGES=studio node tests/e2e/ui-visual.cjs（其余画面的基线原样留着）
   点名也可以直接给参数：node tests/e2e/ui-visual.cjs --pages=studio（cmd / PowerShell 里更好抄）
   有差异时把实际截图写到 tests/fixtures/visual/actual/（gitignore）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./harness.cjs');

let PNG;
try { PNG = require('pngjs').PNG; }
catch (e) { console.error('缺少开发依赖 pngjs：先运行 npm install'); process.exit(2); }

const ROOT = path.resolve(__dirname, '../..');
const BASE_FILE = path.join(ROOT, 'tests/fixtures/visual/fingerprints.json');
const ACTUAL_DIR = path.join(ROOT, 'tests/fixtures/visual/actual');

/* 基线文件按「一屏一行」写：44 档 × 336 个 RGB 三元组，用 JSON.stringify(_, null, 2)
   铺开就是 7.4 万行 / 790 KB 的排版噪声，一次改版的 diff 淹在数字海里。
   键按字典序输出：只点名跑几页时（UI_VISUAL_PAGES）旧键按文件原顺序留着，
   新增画面会插在末尾，排过序才让「加一档」在 diff 里就是多出的那一行。 */
function serialize(obj) {
  const screens = (obj && obj.screens) || {};
  const rows = Object.keys(screens).sort()
    .map(k => '    ' + JSON.stringify(k) + ': ' + JSON.stringify(screens[k]));
  return '{\n  "version": ' + JSON.stringify(obj.version) + ',\n  "at": ' + JSON.stringify(obj.at)
    + ',\n  "screens": {\n' + (rows.length ? rows.join(',\n') + '\n' : '') + '  }\n}\n';
}
const WRITE = process.env.UI_VISUAL_WRITE === '1';
/* 逐张留底（`UI_VISUAL_SAVE=1`，进的是 gitignore 的 actual/）：只凭指纹分不清
   「画面真的改了」与「同一页两档主题各拍在两种版式上」，留底能直接看。 */
const SAVE_ALL = process.env.UI_VISUAL_SAVE === '1';
/* 点名只跑这几页（按 PAGES 里的那个名字）。加一页时不必为其余画面重跑一遍，
   更不必拿这一页的一次截图去赌另外十九档在这一刻还是不是准的。
   两种写法等价：`UI_VISUAL_PAGES=studio` 与 `--pages=studio`（后者在 Windows 的 cmd 里也能直接粘）。
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
    ['director.html', 'director-sub', { prep: prepSubtitles }],
    ['settings.html', 'chat-src', { prep: prepChatSources, panel: true }],
  ]);
const uncovered = ROUTES.pages.filter(p => !PAGES.some(e => String(e[0]).split('?')[0] === p.file)).map(p => p.file);
if (uncovered.length) { console.error('这些页面在路由表里，却没有任何视觉档位：' + uncovered.join(', ')); process.exit(1); }
const SIZES = [[1024, 768], [1440, 900]];
const THEMES = ['light', 'dark'];
const GW = 24, GH = 14;

/* 状态喂出来才有画面可拍的两处：
   prep 只在**这一档**的画面里跑；喂完必须证明界面真画出来了，否则这一档只是把上一页重拍一遍。 */

/* 字幕：先导入一段真视频（draft 占位那条没有可播地址，选用与字幕都进不去），
   选用它，再走导演台唯一写入桥写一条 —— 右栏那一列与字幕轨那一行的字幕块只在这之后才画。
   同一份页面要连拍 4 个画面（两档尺寸 × 两种主题），prep 每一步都得能重跑：
   再导一次会多一条候选、再点一次剪辑开关会把这一档关掉，拍出来的就不是同一张图。 */
/* 字幕这一档要先点进两处才画得出来：剪辑模式、右栏「字幕」那一格。
   都点用户点的那两颗开关，但先看状态再点（`#trimBtn` 的 `on` 与 `#grpSub.hidden` 就是它们的当前值），
   因为同一份页面要连拍四个画面，再点一次就是把这一档关掉。 */
async function enterTrimSub(page) {
  const steps = await page.eval(() => {
    const t = document.getElementById('trimBtn');
    if (!t) return { err: '导演台没有 #trimBtn 那颗剪辑开关，字幕编辑区进不去' };
    if (!t.classList.contains('on')) t.click();
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
    return on(document.querySelector('.sub-list .sub-row')) && on(document.querySelector('.tl-board .tl-cap'));
  }, 10000, 200).catch(() => {
    throw new Error('进了剪辑模式、点了「字幕」也没画出字幕行 / 轨道字幕块（这一档拍不到东西）');
  });
}
/* 画面轨那排的切片：填完帧才是「画好了的那一屏」，还留着占位斜纹就只是加载态。 */
function tilesFilled() {
  return document.querySelectorAll('.tl-board .tl-strip i.tl-fr.gap').length === 0
    && document.querySelectorAll('.tl-board .tl-strip i.tl-fr[style]').length >= 1;
}
async function prepSubtitles(page) {
  const hasClip = await page.eval(() => {
    const c = window.WBBridge && window.WBBridge.get('director') && window.WBBridge.get('director').context();
    return !!(c && c.候选 && c.候选.some(x => x.状态 === 'succeeded'));
  });
  if (!hasClip) {
    await page.setFile('#importMediaFile', h.clipFixture());
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
    /* 新桥按身份对账：每一次写入都要先 check（记下目标）再 run（对一眼身份）。 */
    if (!cand.选用) {
      const arg = { take: 1, candId: cand.id };
      const k = A.check('select', arg);
      if (!k || k.ok === false) return { err: '选用候选没过校验：' + JSON.stringify(k).slice(0, 200) };
      const s = A.run('select', arg);
      if (s && s.ok === false) return { err: '选用候选被拒：' + JSON.stringify(s).slice(0, 200) };
    }
    const c = A.context();
    if (c.字幕 && c.字幕.条数 >= 1) return { 条数: c.字幕.条数 };
    const arg = { kind: 'subtitle', entries: [{ start: 0.4, end: 1.8, text: '本地优先的一条探针字幕' }] };
    const k = A.check('set', arg);
    if (!k || k.ok === false) return { err: '写字幕没过校验：' + JSON.stringify(k).slice(0, 200) };
    const r = A.run('set', arg);
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
  /* 播放器那一格也要定下来：首帧还没解出来时它是黑的，解出来后是那一帧 —— 同一份基线
     两次连拍会差 36 格、最大差 255（纯黑 ↔ 有画面）。等它「有一帧可画」（readyState ≥ 2）
     再拍，这一档才是同一张图。甲板有两个（#player / #playerB），两个都要等到。 */
  await page.waitFor(() => {
    const vs = [...document.querySelectorAll('#playerWrap video')];
    return vs.length ? vs.every(v => v.readyState >= 2) : true;
  }, 30000, 300).catch(() => {});
  if (!(await page.eval(tilesFilled))) {
    const c = await page.eval(() => ({ gaps: document.querySelectorAll('.tl-board .tl-strip i.tl-fr.gap').length,
      filled: document.querySelectorAll('.tl-board .tl-strip i.tl-fr[style]').length,
      格子: [...document.querySelectorAll('.tl-board .tl-strip')].map(t => (t.getAttribute('data-strip') || '(图片段)')
        + ' 帧=' + t.querySelectorAll('i.tl-fr[style]').length + '/' + t.querySelectorAll('i.tl-fr').length).join(' | '),
      影: [...document.querySelectorAll('video')].map(v => 'rs=' + v.readyState + (v.paused ? ' 停' : ' 播')
        + ' src=' + String(v.currentSrc || v.src || '').slice(0, 40)).join(' | '),
      暂停: String(window.__directorSlicePaused ? window.__directorSlicePaused() : '(没有这个口子)'),
      活动: String(window.__spaActivity && window.__spaActivity.visible ? window.__spaActivity.visible() : '(读不到)') }));
    throw new Error('画面轨那排的切片一直没填完（填好 ' + c.filled + ' 格、还剩 ' + c.gaps + ' 格占位）——这一档拍出来的是加载态\n  '
      + JSON.stringify(c, null, 1));
  }
  const got = await page.eval(() => {
    const on = el => !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 2;
    return { rows: [...document.querySelectorAll('.sub-list .sub-row')].filter(on).length,
      lane: [...document.querySelectorAll('.tl-board .tl-cap')].filter(on).length };
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
  /* 助手是空闲装载的：全量跑时前面几档的时间早把它带起来了，点名单跑这一档就得自己等。 */
  await page.waitFor(() => !!window.AiChat, 25000).catch(() => {});
  await page.eval(() => { AiChat.open(); return true; });
  /* 底栏提示（paintHint）在配置齐全时是空的：等一小段让抽屉画稳即可，别等「写出来」。 */
  await new Promise(r => setTimeout(r, 700));
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
    /* 视觉档的测试实例一律**直连**（PROXY_OFF=1）：以前这一条继承用户环境，于是「本机代理软件
       此刻开没开」会改变画面 —— 代理软件关着时工作台三型画出一整屏「上游能力接口请求失败：连不上代理
       127.0.0.1:7897」，指纹跟着红，而那既不是改版也不是缺陷。视觉档不发消息、不花钱，
       取型号只是读一次清单，直连拿不到就照实回落，红只代表「画面真的变了」。 */
    proxy = await h.startProxy({ env: { PROXY_OFF: '1' } });
    browser = await h.launchBrowser();
    page = await browser.newPage();
    /* ── 资产库那一档：把「卡片从哪来」钉死 ──────────────────────────────────
       这一页的卡片原本来自**平台列表接口**（要网络 + `.env` 里的真密钥）。同一个提交
       连跑两次会拍出两种画面：「网络通 → 一屏卡片」/「网络不通 → 空态 + 共 0 项」，
       指纹于是随机红 —— 那不是改版，是探针在赌网络。工作台三档早就是这么处理的
       （见下面 `studio-` 那段 stub），只是这一档漏了。
       这里不改产品行为，只把**读数据的那个口**换成固定答复：
         ① 先种一次**首屏缓存**（`assets_cache_v1`）—— 页面本来就先读缓存把界面填上
            （`web/pages/assets.js` 的 `load()`：`if (!assets.length) { const cached = LIST_CACHE.read() … }`），
            走的是产品自己的那条路径，所以拍出来的仍是**真实卡片版式**，不是另造一套假界面；
         ② 再 stub 掉 `AssetLib.load` / `countAll` 与 `Api.listSources` —— 不然网络真回来时
            会往缓存那几张后面再追加一批，画面又跟着网络变了。
       代价：这一档不看「平台接口通了会长什么样」（那本来就不该由视觉档担保）。 */
    const ASSETS_SEED = (() => {
      const mk = (o, i) => Object.assign({
        kind: 'asset', status: 'succeeded', src: '', dl: '', type: '图片', format: 'PNG',
        provider: 'sparkcine', providerName: 'SparkCine', model: 'visual-probe',
        duration: 0, assetId: 'visual-seed-' + i, genId: '', id: '',
        ts: Date.UTC(2026, 9, 10 + i, 9, 0, 0),
      }, o);
      return [
        mk({ prompt: '水下的光：微距特写，柔和的自然光。' }, 1),
        mk({ type: '视频', format: 'MP4', provider: 'vgenv', providerName: 'VGENV', duration: 5,
          prompt: '慢镜头推近，晨雾里的林间小路。' }, 2),
        mk({ prompt: '静物：陶罐与干花，暖色侧光。', assetId: 'visual-seed-3' }, 3),
        mk({ type: '视频', format: 'MP4', duration: 8, provider: 'vgenv', providerName: 'VGENV',
          prompt: '人物转身离开，背景虚化的街灯。', assetId: 'visual-seed-4' }, 4),
      ];
    })();
    /* 先落一次同源页面，把缓存写进去（localStorage 按 origin 存，必须在导航到资产库之前）。 */
    await page.goto(proxy.base + '/shell.html#favorites.html');
    await page.waitFor(() => !!window.Kv, 15000).catch(() => {});
    await page.eval(seed => {
      localStorage.setItem('assets_cache_v1', JSON.stringify({ ts: Date.now(), entries: seed }));
      return true;
    }, ASSETS_SEED);
    /* 上面那几处 stub 若只是「导航完再 eval」，会**输给时序**：资产库的 `load()` 跑在
       onMounted 里，等外壳把 AssetLib 补载完、我们再去包它，真数据已经在路上了
       （实测同一份代码连跑两次仍有 1/4 画面不同）。所以改成在**文档里任何页面脚本之前**
       就把两个数据口拦掉（CDP 的 addScriptToEvaluateOnNewDocument），时序问题从根上没有了。
       两条守卫：
         · 只对资产库那一档生效（`location.hash` 在文档起点就已可用），别的页一个字节都不碰；
         · 拦的是对象本身 —— `Api` / `AssetLib` 都由外壳**稍后才挂到 window 上**，
           所以用 setter 挂钩：谁赋值就当场改谁，外面再加 3 秒的定时兜底。 */
    await page.addInitScript(() => {
      if (String(location.hash || '').indexOf('assets.html') < 0) return;
      let total = 4;
      try { total = (JSON.parse(localStorage.getItem('assets_cache_v1') || '{}').entries || []).length || 0; } catch (e) {}
      const installApi = api => {
        if (!api || api.__visualNoSources) return false;
        try { api.listSources = () => []; api.__visualNoSources = 1; return true; } catch (e) { return false; }
      };
      const installLib = lib => {
        if (!lib || lib.__visualLib) return false;
        try {
          lib.__visualLib = 1;
          lib.load = async () => ({ entries: [], cursors: {}, more: {}, hasMore: false, errors: {}, failed: {} });
          lib.countAll = async () => ({ total, exact: true, assetIds: new Set() });
          return true;
        } catch (e) { return false; }
      };
      let apiRef = window.Api, libRef = window.AssetLib;
      installApi(apiRef); installLib(libRef);
      const hook = (name, get, set) => {
        try {
          Object.defineProperty(window, name, {
            configurable: true,
            get() { return get(); },
            set(v) { set(v); },
          });
        } catch (e) { /* 定义不了就只靠下面的定时兜底 */ }
      };
      hook('Api', () => apiRef, v => { apiRef = v; installApi(v); });
      hook('AssetLib', () => libRef, v => { libRef = v; installLib(v); });
      let n = 0;
      const t = setInterval(() => {
        if (window.Api && window.Api !== apiRef) { apiRef = window.Api; installApi(apiRef); }
        if (window.AssetLib && window.AssetLib !== libRef) { libRef = window.AssetLib; installLib(libRef); }
        installApi(apiRef); installLib(libRef);
        if (++n > 60) clearInterval(t);          // 3 秒后收手：页面早挂完了
      }, 50);
    });
    const baseline = fs.existsSync(BASE_FILE) ? JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')) : { version: 1, screens: {} };
    if (!baseline.screens || typeof baseline.screens !== 'object') baseline.screens = {};
    /* 只点名跑几页时，其余画面的旧基线要原样留着：这一份文件是全站的历史，不是这一次的草稿。 */
    const next = { version: 1, at: new Date().toISOString(), screens: Object.assign({}, baseline.screens) };
    let bad = 0, checked = 0;
    for (const entry of PAGES) {
      const [route, name, opts] = [entry[0], entry[1], entry[2] || {}];
      if (!wanted(name)) continue;
      for (const [w, hgt] of SIZES) {
        for (const theme of THEMES) {
          const key = name + '|' + w + '|' + theme;
          await page.setSize(w, hgt);
          /* 工作室右栏会去各平台拉历史：真网慢，30 秒超时后拍出一块「没取回来」的错误横幅，
             同一档两次是两种画面。视觉档只看版式，把这份跨平台读口换成空清单
             （本机自己的任务记录仍照常画）—— 只打工作室三档：别的页的本机资产清单还要照常读。
             ⚠ 必须在**切页之前**打：页面模块是预取过的，切页后 onMounted 可能先于这次 eval
             跑完，真的历史请求就发出去了 —— 那时同一份代码一次拍出「全部 0」、
             一次拍出真网络回来的「全部 196」，画面取决于机器快慢。 */
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
          await page.goto(proxy.base + '/shell.html#' + route);
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
          /* 页面的异步回填（studio 三档）不定下来就拍，同一页会在「加载中 / 读取记录」
             与稳定画面之间来回变指纹 —— 那是探针在赌机器快慢，不是画面改版。 */
          await page.waitFor(() => {
            const t = document.body.innerText;
            return !t.includes('加载中…') && !t.includes('正在读取生成记录…')
              && !document.querySelector('.spa-frame-loading');
          }, 15000).catch(() => {});
          /* 只等 body 有字不够：外壳侧栏先有字，studio 页可能还没挂上 —— 那样会拍到
             「请选择」和半截设置区，接着历史那一栏才慢悠悠地回填。等型号真选上、
             历史栏那一排（右栏的类型档）真画出来再往下走（三档共用一个页面根）。
             ⚠ 这两处是**页面的 data-r 登记名**（web/pages/studio.js 的 `$()` 读的是它），
             不是 DOM id —— 按 id 找会永远找不到，每条画面白等满 30 秒超时。 */
          if (name.startsWith('studio-')) {
            await page.waitFor(() => {
              const page = document.querySelector('.studio-page');
              const sel = document.querySelector('.studio-page [data-r="model"]');
              const hist = document.querySelector('.studio-page [data-r="histFilter"]');
              return !!page && !!sel && !!sel.value && !!hist;
            }, 30000).catch(() => {});
          }
          let label = '';
          if (opts.prep) label = await opts.prep(page, proxy);
          await new Promise(r => setTimeout(r, 700));
          /* 固定等待之后再看一眼：型号可能恰好在这一段里才选上。 */
          await page.waitFor(() => {
            const sel = document.querySelector('.studio-page [data-r="model"]');
            return !sel || !!sel.value;
          }, 15000).catch(() => {});
          /* 导演台右栏有两处异步回填，不定下来同一档两次就是两种画面：
             ① 型号能力 —— 没回的时候「输入模式」那一排芯片（`#modeRow`）整块不画，
                于是下面所有内容在右栏里往上挪一截；
             ② 两处报价 —— 模板里 `#estTxt` 的初值就是「估价中…」、`#kfEst` 是空的，
                报价回来才换成读数，而右栏每 3 秒整片重画一次，重画又把那两枚初值写回去。
             所以这一条要**紧贴截图**：轮询命中「两处报价都落定」那一刻就拍，
             落在重画与报价往返之间就等下一轮（100ms 一跳）。
             只盯生成态那一族：字幕那一档拍的是剪辑态，右栏这一列本来就不画。 */
          if (name === 'director') {
            await page.waitFor(() => {
              const est = document.getElementById('estTxt');
              const kf = document.getElementById('kfEst');
              return !!document.getElementById('modeRow')
                && !!est && !/估价中/.test(est.textContent)
                && !!kf && kf.textContent.trim() !== '';
            }, 15000).catch(() => {});
          }
          const shot = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
          const buf = Buffer.from(shot.data, 'base64');
          if (SAVE_ALL) {
            fs.mkdirSync(ACTUAL_DIR, { recursive: true });
            fs.writeFileSync(path.join(ACTUAL_DIR, key.replace(/[|?]/g, '_') + '.png'), buf);
          }
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
      fs.writeFileSync(BASE_FILE, serialize(next));
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
