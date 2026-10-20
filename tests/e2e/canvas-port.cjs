#!/usr/bin/env node
/* 画布进出与预算（方案 §8.9 的「导出/导入画布」与「720/5000 预算下不卡」两条）。
   走的是真实通道：页头那颗「导出」把 JSON 落到下载目录，再从盘上塞回「导入」那颗文件入口；
   大画布用同一份 Kv 面写进去、按 ?id= 重新开一次，量平移帧与 DOM 挂载数。
   全程 harness 起的隔离实例（.data-probe / .assets-probe 各一份，跑完自己删）。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./harness.cjs');

let n = 0;
function must(cond, msg) { if (!cond) throw new Error('第 ' + (++n) + ' 项不成立：' + msg); ++n; }

/* 下载目录里的 .json 出现即算导出的那一份；Chrome 先落 .crdownload，所以要跳过半成品。 */
function pickDownload(dir) {
  const list = fs.readdirSync(dir).filter(f => /\.json$/.test(f) && !f.endsWith('.crdownload'));
  if (!list.length) return '';
  const f = path.join(dir, list[list.length - 1]);
  return fs.statSync(f).size > 0 ? f : '';
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-cvport-'));
  const dl = path.join(work, 'dl');
  fs.mkdirSync(dl);
  let proxy, browser, page;
  try {
    proxy = await h.startProxy();
    browser = await h.launchBrowser();
    page = await browser.newPage();
    await page.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
    const A = () => 'window.WBBridge.get("canvas")';
    const ctx = () => page.eval(() => window.WBBridge.get('canvas').context());
    const click = sel => page.eval(s => { const b = [...document.querySelectorAll(s)]; if (!b.length) return false; b[b.length - 1].click(); return true; }, sel);
    const clickText = (sel, re) => page.eval(([s, src]) => {
      const b = [...document.querySelectorAll(s)].find(x => new RegExp(src).test(x.textContent));
      if (!b) return false; b.click(); return true;
    }, [sel, re]);
    const until = async (expr, ms, note) => {
      try { return await page.waitFor(expr, ms || 15000, 80); }
      catch (e) { throw new Error('第 ' + (++n) + ' 项等不到：' + (note || expr) + '（' + e.message + '）'); }
    };

    /* ---------- 1) 建一份六类节点齐、连着三条线、视口不是默认值的画布 ---------- */
    await page.goto(proxy.base + '/shell.html#canvas.html');
    await until('!!document.querySelector(".cv-lib")', 20000, '项目库那一屏');
    await until('window.WBBridge && ' + A(), 25000, '画布桥装上');
    must(await click('.cv-lib-bar button.pri'), '新建画布按钮点得到');
    await until('!!document.querySelector("#pfDlg")');
    await page.eval(() => { document.getElementById('pf_0').value = '进出探针'; document.getElementById('pfOk').click(); });
    await until(A() + '.ready()', 20000, '新建的画布打开');
    const base0 = await ctx();
    const rev0 = base0.revision;
    const ids = ['pv_text', 'pv_image', 'pv_video', 'pv_audio', 'pv_config', 'pv_ref'];
    const wrote = await page.eval(a => {
      const ops = a.nodes.map((d, i) => ({ op: 'add_node', node: { id: d.id, type: d.type, title: d.title,
        x: 80 + i * 40, y: 60 + i * 30, metadata: d.meta } }));
      a.edges.forEach(e => ops.push({ op: 'connect_nodes', from: e[0], to: e[1] }));
      return window.WBBridge.get('canvas').apply(ops, { label: '探针写一份六类' });
    }, {
      nodes: [
        { id: ids[0], type: 'text', title: '文本正文', meta: { content: '导出再导入应该还在的那一句' } },
        { id: ids[1], type: 'image', title: '图片节点', meta: { prompt: '一只纸鹤' } },
        { id: ids[2], type: 'video', title: '视频节点', meta: { prompt: '纸鹤飞过桌面' } },
        { id: ids[3], type: 'audio', title: '音频节点', meta: { prompt: '一句旁白' } },
        { id: ids[4], type: 'config', title: '生成配置', meta: { prompt: '型号与参数' } },
        { id: ids[5], type: 'asset-ref', title: '资产引用', meta: {} },
      ],
      edges: [['pv_text', 'pv_image'], ['pv_config', 'pv_image'], ['pv_ref', 'pv_audio']],
    });
    must(wrote.ok, '六类节点 + 三条线一批写完：' + JSON.stringify(wrote));
    const vpSet = await page.eval(() => window.WBBridge.get('canvas').view({ mode: 'set', x: 137, y: -89, scale: 1.5 }));
    must(!vpSet || vpSet.ok !== false, '视口 set 要成立：' + JSON.stringify(vpSet));
    await page.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 's', ctrlKey: true })));
    await until('/已存本机/.test((document.querySelector(".cv-state")||{}).textContent||"")', 12000, 'Ctrl+S 落盘');
    const doc0 = await ctx();
    must(doc0.节点数 === 7 && doc0.连线数 === 3, '这份画布该有 7 个节点、3 条线：' + JSON.stringify({ 节点: doc0.节点数, 线: doc0.连线数 }));
    must(doc0.revision > rev0, '写完要涨修订号：' + rev0 + ' → ' + doc0.revision);

    /* ---------- 2) 页头「导出」：文件真落到盘上，内容是一份能给别人看的 JSON ---------- */
    must(await clickText('.cv-bar button', '导出'), '页头那颗「导出」点得到');
    const at = Date.now();
    let file = '';
    while (Date.now() - at < 20000 && !file) {
      file = pickDownload(dl);
      if (!file) await h.sleep(120);
    }
    must(!!file, '导出后下载目录里该出现一份 JSON');
    must(/进出探针/.test(path.basename(file)), '文件名要带上画布标题：' + path.basename(file));
    const text = fs.readFileSync(file, 'utf8');
    let out;
    try { out = JSON.parse(text); } catch (e) { throw new Error('导出件不是合法 JSON：' + (e && e.message)); }
    must(out.kind === 'wb-canvas' && out.v === 1, '导出件要带上格式旗标与版本：' + JSON.stringify({ kind: out.kind, v: out.v }));
    const d = out.doc || {};
    must(d.title === '进出探针' && (d.nodes || []).length === 7 && (d.connections || []).length === 3,
      '文档主体数量对得上：' + JSON.stringify({ 标题: d.title, 节点: (d.nodes || []).length, 线: (d.connections || []).length }));
    must(d.viewport && Number(d.viewport.scale) === 1.5, '视口（含倍率）要跟着走：' + JSON.stringify(d.viewport));
    must(d.nodes.every(x => x.id && x.type && Number.isFinite(x.x)), '每个节点都带身份与位置');
    /* 导出件是要发给别人的：正文留下，但浏览器里的 blob 地址与密钥形状一个字都不该在。 */
    must(!/blob:|data:|token|secret|api[_-]?key/i.test(text), '导出件里不该有媒体字节或密钥形状');

    /* ---------- 3) 页头「导入」：从盘上把同一份塞回真实文件入口 ---------- */
    const origId = doc0.id;
    must(await clickText('.cv-bar button', '导入'), '页头那颗「导入」点得到');
    await until('!!document.querySelector(".cv-file")', 8000, '导入那颗文件入口要挂在页面里');
    await page.setFile('.cv-file', file);
    const errToast = () => page.eval(() => [...document.querySelectorAll('.toast.err')].map(t => t.textContent).join(' | '));
    /* 导入回执走 Toast 的 ok 档，默认被「操作成功不必再弹一声」那张闸压住（这是有意的：
       做完的事要在界面上自己看得见，右上角只留给真问题）。所以这里等的不是那一句，
       而是导入真正落下的那个结果 —— 存储里多出第二份、标题与节点数都来自文件。
       读不进去的那一条一定弹（err 档不被安静档管），所以它一出现就当场判死。 */
    const at2 = Date.now();
    let imp = null;
    while (Date.now() - at2 < 20000) {
      const e = await errToast();
      if (e) throw new Error('第 ' + (++n) + ' 项不成立：导入被页面判成读不进去：' + e);
      imp = await page.eval(id => window.Kv.at('canvasDocs').all().then(ds => {
        const o = ds.find(d => d.id !== id);
        return o ? { id: o.id, 标题: o.title, 节点: (o.nodes || []).length, 线: (o.connections || []).length, 修订: o.revision } : null;
      }), origId);
      if (imp) break;
      await h.sleep(150);
    }
    must(!!imp, '导入的那一份要真的落进存储（屏上没有报错气泡）');
    must(imp.标题 === '进出探针' && imp.节点 === 7 && imp.线 === 3,
      '导入件的账先按文件对一遍：' + JSON.stringify(imp));
    /* 导入不是「悄悄往库里塞了一份」：屏幕要跟着换到刚导进来的那一份面前，否则用户看不见生效。 */
    await until(A() + '.context().画布 === ' + JSON.stringify(imp.id), 20000, '界面切到导入的那一份');
    const landed = await ctx();
    must(landed.id === imp.id && landed.节点数 === 7 && landed.连线数 === 3 && landed.revision === 0,
      '切过去就是导入的那一份，修订从 0 起：' + JSON.stringify({ id: landed.id, 节点: landed.节点数, 线: landed.连线数, 修订: landed.revision }));
    must(await page.eval(() => document.querySelector('.cv-name').value === '进出探针'), '页头标题回填成导入件的标题');

    /* ---------- 4) 项目库里两份：原来是原来，导入的那一份换了号、修订从 0 起 ---------- */
    must(await click('.cv-back'), '返回项目库');
    await until('document.querySelectorAll(".cv-grid .task").length === 2', 15000, '库里两份画布');
    const cards = await page.eval(() => [...document.querySelectorAll('.cv-grid .task')]
      .map(el => ({ id: el.dataset.tkey, 文字: el.textContent.replace(/\s+/g, ' ') })));
    must(cards.length === 2 && new Set(cards.map(c => c.id)).size === 2, '两份画布两个号：' + JSON.stringify(cards.map(c => c.id)));
    must(cards.every(c => /7 个节点/.test(c.文字)), '两份卡片都写出 7 个节点：' + JSON.stringify(cards.map(c => c.文字)));
    must(cards.some(c => c.id !== origId), '导入的那一份不该沿用原来的号');
    const imported = cards.find(c => c.id !== origId).id;
    must(imported === imp.id, '库里的第二张卡片就是刚落盘的那一份：' + imported + ' vs ' + imp.id);
    await page.eval(id => { const el = [...document.querySelectorAll('.cv-grid .task')].find(x => x.dataset.tkey === id);
      el.querySelector('[data-x="open"]').click(); }, imported);
    await until(A() + '.ready() && window.WBBridge.get("canvas").context().画布 === ' + JSON.stringify(imported),
      20000, '打开导入的那一份');
    const re = await ctx();
    must(re.id === imported && re.节点数 === 7 && re.连线数 === 3 && re.revision === 0,
      '导入件的账要重起：' + JSON.stringify({ id: re.id, 节点: re.节点数, 线: re.连线数, 修订: re.revision }));
    /* 节点号要原样跟着走：连线是按号指的，号一换线就全断（新建时那枚空白文本节点也还在，所以是 7 枚）。 */
    const kept = await page.eval(pids => { const c = window.WBBridge.get('canvas').context();
      return pids.filter(id => !c.节点.some(x => x.id === id)); }, ids);
    must(kept.length === 0, '导入件里这些节点号一个都不该丢：' + JSON.stringify(kept));
    const row = await page.eval(id => window.WBBridge.get('canvas').nodeRead(id), 'pv_text');
    must(/导出再导入应该还在的那一句/.test(row.metadata.content || ''), '正文要原样回来：' + JSON.stringify(row.metadata.content));
    const back = await page.eval(() => window.WBBridge.get('canvas').context().视口);
    must(Number(back.scale) === 1.5 && Number(back.x) === 137, '视口也要原样回来：' + JSON.stringify(back));
    const inEdges = await page.eval(id => window.WBBridge.get('canvas').nodeRead(id).连线, 'pv_image');
    must(inEdges.length === 2 && inEdges.every(e => e.方向 === '入'), '两条入线连回同一个节点：' + JSON.stringify(inEdges));

    /* ---------- 5) 顶到预算：720 节点 / 5000 连线开起来，平移一轮看帧与挂载 ---------- */
    const bigId = 'cv_bigprobe';
    const built = await page.eval(id => (async () => {
      const NODES = 720, EDGES = 5000, COLS = 30, STEP = 300;
      const nodes = [], connections = [], seen = new Set();
      for (let i = 0; i < NODES; i++) {
        nodes.push({ id: 'b_' + i, type: i % 6 === 1 ? 'image' : i % 6 === 4 ? 'config' : 'text',
          title: '节点 ' + i, x: (i % COLS) * STEP, y: Math.floor(i / COLS) * STEP,
          width: 260, height: 160, metadata: { content: '第 ' + i + ' 格的正文' }, createdAt: Date.now(), updatedAt: Date.now() });
      }
      /* 每 7 条为一组：同一枚起点向外 fan 出 7 条不同的落点。成对去重（from>to）在导入收敛里会
         把重边剔掉，凑不满 5000 就等于自己造了个假红。 */
      for (let i = 0; i < EDGES; i++) {
        const a = Math.floor(i / 7), b = (a + 1 + (i % 7)) % NODES;
        if (a >= NODES || a === b || seen.has(a + '>' + b)) continue;
        seen.add(a + '>' + b);
        connections.push({ id: 'e_' + i, fromNodeId: 'b_' + a, toNodeId: 'b_' + b, fromHandle: '', toHandle: '' });
      }
      const doc = { v: 1, id: id, title: '预算探针', folderId: '', nodes: nodes, connections: connections,
        viewport: { x: 0, y: 0, scale: 0.55 }, revision: 0, createdAt: Date.now(), updatedAt: Date.now(), selection: [] };
      await window.Kv.at('canvasDocs').put(id, doc);
      return { 节点: doc.nodes.length, 线: doc.connections.length };
    })(), bigId);
    must(built.节点 === 720 && built.线 === 5000, '大画布该按预算写满：' + JSON.stringify(built));
    await page.goto(proxy.base + '/shell.html?probe=' + Date.now() + '#canvas.html?id=' + bigId);
    await until('window.WBBridge && ' + A() + '.ready() && ' + A() + '.context().节点数 === 720', 40000, '720 节点的画布开起来');
    const big = await ctx();
    must(big.连线数 === 5000, '连线按 5000 条收下：' + big.连线数);
    must(big.截断 === true, '快照只给前 120 行并照实说截断：' + JSON.stringify(big.截断));
    const dom0 = await page.eval(() => ({ 挂载: document.querySelectorAll('.cv-layer .cv-node').length,
      路径: document.querySelectorAll('.cv-svg path').length }));
    /* 索引始终覆盖全部节点，DOM 只挂视口里那一些：720 份数据不等于 720 个节点盒子。 */
    must(dom0.挂载 > 0 && dom0.挂载 < 720, '离屏节点不该挂着 DOM：' + JSON.stringify(dom0));

    /* 量的不是「等两帧」的墙上时间 —— 那里面有一半是排帧延迟，跟画布重不重没关系。
       这里包一层 window.requestAnimationFrame，只记每个回调自己跑了多久：一次平移真正压在
       主线程上的重绘（挂卸节点 + 画连线 + 小地图）就是这几个数。用的是浏览器公开接口，
       页面没有改动，跑完原样还原。 */
    const pan = await page.eval(async () => {
      const A = window.WBBridge.get('canvas');
      const longs = [];
      let po = null;
      try { po = new PerformanceObserver(l => { for (const e of l.getEntries()) longs.push(Math.round(e.duration)); });
        po.observe({ entryTypes: ['longtask'] }); } catch (e) {}
      const raw = window.requestAnimationFrame;
      const next = () => new Promise(res => raw.call(window, res));
      const work = [];
      window.requestAnimationFrame = function (cb) {
        return raw.call(window, function (t) {
          const s = performance.now();
          try { cb(t); } finally { work.push(+(performance.now() - s).toFixed(1)); }
        });
      };
      const times = [], repaint = [], mounts = [];
      try {
        for (let i = 0; i < 8; i++) {
          await next(); await next();                       // 把上一轮的尾巴排干，别算进这一次
          const mark = work.length;
          const t0 = performance.now();
          const r = A.view({ mode: 'set', x: 120 + i * 173, y: -80 - i * 131, scale: 0.55 });
          if (r && r.ok === false) return { err: r.reason || '视图写不进' };
          await next(); await next();
          times.push(+(performance.now() - t0).toFixed(1));
          repaint.push(+work.slice(mark).reduce((a, b) => a + b, 0).toFixed(1));
          mounts.push(document.querySelectorAll('.cv-layer .cv-node').length);
        }
      } finally {
        window.requestAnimationFrame = raw;
        if (po) po.disconnect();
      }
      return { times: times, repaint: repaint, longs: longs,
        挂载: Math.max.apply(null, mounts),
        路径: document.querySelectorAll('.cv-svg path').length };
    });
    if (pan.err) throw new Error('第 ' + (++n) + ' 项不成立：平移写不进视图：' + pan.err);
    must(pan.挂载 < 720, '平移一轮之后挂载仍然受预算管着：' + pan.挂载);
    const worst = Math.max.apply(null, pan.repaint);
    must(worst < 50, '720/5000 下平移一次的主线程重绘要 < 50ms，实测最长 ' + worst + 'ms（' + JSON.stringify(pan.repaint) + '）');
    must(Math.max.apply(null, pan.times) < 100, '两次排帧之间不该拖出 > 100ms 的长帧：' + JSON.stringify(pan.times));
    must(!(pan.longs || []).some(ms => ms > 100), '这一轮里没有 > 100ms 的长任务：' + JSON.stringify(pan.longs));

    /* 超预算的那一条要当场拒，并且说清上限：静默截断等于「明明有却说没有」。 */
    const over = await page.eval(() => {
      const ops = [];
      for (let i = 0; i < 20; i++) ops.push({ op: 'add_node', node: { id: 'ov_' + i, type: 'text', x: 10, y: 10 } });
      return window.WBBridge.get('canvas').apply(ops, { label: '顶破上限' });
    });
    must(!over.ok && /720/.test(over.reason || ''), '写到 720 之外要整批拒并给出上限：' + JSON.stringify(over));
    must((await ctx()).节点数 === 720, '被拒的这批一个节点都不该进画布');

    if (page.errors.length) throw new Error('控制台错误：' + page.errors.join(' | '));
    console.log('✓ 画布进出与预算通过（导出 ' + Math.round(fs.statSync(file).size / 1024) + 'KB JSON → 从盘上导回来：' +
      '标题/节点号/正文/连线/视口原样、界面切到那一份，号另起、修订从 0；720 节点 5000 连线开起来只挂 ' + dom0.挂载 +
      ' 个盒子，平移一次最长重绘 ' + worst.toFixed(1) + 'ms / 墙上最长 ' + Math.max.apply(null, pan.times).toFixed(1) +
      'ms；顶破上限整批拒 · 零控制台错误）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) await browser.close();
    if (proxy) await proxy.stop();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
})();
