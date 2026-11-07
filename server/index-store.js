/* 本机资产索引：快照 index.json + 增量 index.jsonl + 内存读缓存。
   - write(list) 保留旧调用方式：和上一次内存表做 diff，只追加 put/del；
   - 改一条用 upsert/remove/find 原语：它们是同步的（Node 单线程，中间没有 await），
     并发请求不会各拿整表互相覆盖；**调用点中间只要有 await 就必须改用 `update(fn)`**（串行队列，见那里）；
   - 每 200 次写或 5 分钟 compact 一次；启动时重放 journal，再压回快照；
   - 快照损坏时改名留档并按空表继续；journal 末行坏掉只丢最后一条，中间坏行跳过并留着 journal；
   - 写失败抛 err.indexWrite，调用方不能回 200。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWrite, renameWithRetry } = require('./data-hub.js');

const DEFAULT_MAX = 20000;
const COMPACT_EVERY = 200;
const COMPACT_MS = 5 * 60 * 1000;

function createIndexStore(opts) {
  const dir = opts.dir;
  const log = opts.log || (() => {});
  const max = opts.max || DEFAULT_MAX;
  const snapshotPath = path.join(dir, 'index.json');
  const journalPath = path.join(dir, 'index.jsonl');
  let cache = null;
  let byId = null;
  /* 上一次真正落盘的条目快照（id → JSON 串）。**不能拿 `cache` 当对照**：
     `read()` 把内存表原样交给调用方，调用方 `unshift` / 改字段之后再 `write(cache)`，
     这时新旧两份是同一个数组 —— diff 出来零条改动，索引永远不落盘。
     表现是「资产文件好好在盘上、列表重启后就空了」。 */
  let persisted = null;
  let ops = 0;
  let journalSkipped = 0;
  let lastCompact = Date.now();
  /* 每次真写盘 +1：外面按账建的反查表（来源地址 / 平台产物号 → 条目）靠它判缓存过期。
     条数不变的那种改法（同 id 换字段）长度看不出来，只有这个计数认得出来。 */
  let rev = 0;

  const atomic = (file, text) => {
    const { fsyncWhy } = atomicWrite(file, text, { dir });
    if (fsyncWhy) log('[local-assets] 落盘同步退化：' + fsyncWhy);
  };
  const compact = () => {
    const list = cache || [];
    atomic(snapshotPath, JSON.stringify(list));
    try { fs.writeFileSync(journalPath, ''); } catch (e) { log('[local-assets] 清空 journal 失败：' + e.message); }
    ops = 0;
    lastCompact = Date.now();
  };
  const bad = (file, why) => {
    /* 挪开坏文件用的是同一份退避重试：杀软正占着它时 renameSync 当场 EPERM，
       原样吞掉就等于「损坏证据被下一次覆盖写掉」—— 那时候什么都查不到。 */
    const bak = file + '.bad-' + Date.now();
    try {
      renameWithRetry(file, bak);
      log('[local-assets] ' + path.basename(file) + ' 损坏（' + why + '）→ 已另存为 ' + path.basename(bak));
    } catch (e) {
      log('[local-assets] ' + path.basename(file) + ' 损坏（' + why + '），但挪不开留证据失败（'
        + ((e && e.code) || '') + ' ' + ((e && e.message) || e) + '）：下一次写入会盖掉它');
    }
  };
  const load = () => {
    if (cache) return cache;
    let list = [];
    let snapshotBad = false;
    try {
      const v = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      if (Array.isArray(v)) list = v;
      else throw new Error('索引内容不是数组');
    } catch (e) {
      if (!e || e.code !== 'ENOENT') { snapshotBad = true; bad(snapshotPath, (e && e.message) || String(e)); }
    }
    if (snapshotBad) {
      bad(journalPath, '快照损坏，journal 无法安全重放');
    } else {
      try {
        const lines = fs.readFileSync(journalPath, 'utf8').split(/\r?\n/);
        const map = new Map(list.filter(x => x && x.id).map(x => [x.id, x]));
        let 坏行 = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim()) continue;
          let rec = null;
          const last = i === lines.length - 1;
          /* 只有最后一行才可能是「断电时写了一半」的残句，丢掉它就行；
             中间行解析不动是文件被改坏 / 被截断过，跳过这一条继续重放后面的 ——
             整段 break 会把后面每条合法记录一起扔了，随后 compact 就把这张残缺表固化成快照。 */
          try { rec = JSON.parse(line); }
          catch (e) {
            if (last) { log('[local-assets] journal 末行损坏，已忽略'); break; }
            坏行++;
            log('[local-assets] journal 第 ' + (i + 1) + ' 行损坏，已跳过，后面的照常重放');
            continue;
          }
          if (!rec || !rec.op) { if (last) break; 坏行++; continue; }
          if (rec.op === 'del') map.delete(rec.id);
          else if (rec.op === 'put' && rec.item && rec.item.id) map.set(rec.item.id, rec.item);
          ops++;
        }
        list = [...map.values()];
        if (坏行) log('[local-assets] journal 里有 ' + 坏行 + ' 条记录读不出来，已跳过（journal 原样留着，压缩要等下一次写入攒够才做）');
        journalSkipped = 坏行;
      } catch (e) {
        if (!e || e.code !== 'ENOENT') log('[local-assets] journal 读取失败：' + e.message);
      }
    }
    if (list.length > max) list = list.slice(0, max);
    cache = list;
    byId = null;
    persisted = new Map(list.filter(x => x && x.id).map(x => [x.id, JSON.stringify(x)]));
    /* 有坏行时不压缩：那些行对应的记录已经读不出来，journal 得留在盘上供人工找回，
       压完就再也拼不回来了。 */
    if (ops && !journalSkipped) {
      try { compact(); } catch (e) { log('[local-assets] 启动压缩失败：' + e.message); }
    }
    return cache;
  };
  const map = () => {
    if (!byId) {
      /* 先把表读出来再建索引：`load()` 末尾会把 `byId` 置空（表变了，旧索引作废）。
         先赋值再调 `load()` 的话，冷启动第一次 `entry()` 会在 for 里对 null 取下标 ——
         表现是「媒体检查 / 渲染取本机素材」在刚重启的代理上必失败，第二次又好了。 */
      const list = load();
      byId = Object.create(null);
      for (const x of list) if (x && x.id) byId[x.id] = x;
    }
    return byId;
  };
  const read = () => load();
  const entry = id => map()[id] || null;
  /* 落盘的唯一出口：和上一次落盘的表做 diff，只追加 put/del。
     同步执行 —— 中途没有 await，Node 单线程保证两条并发请求不会各拿整表互相覆盖。 */
  const flush = next => {
    const nextMap = new Map(next.filter(x => x && x.id).map(x => [x.id, JSON.stringify(x)]));
    const lines = [];
    for (const [id, json] of nextMap) {
      if (persisted.get(id) !== json) lines.push('{"op":"put","item":' + json + '}');
    }
    for (const id of persisted.keys()) if (!nextMap.has(id)) lines.push(JSON.stringify({ op: 'del', id }));
    if (!lines.length) { cache = next; byId = null; return false; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(journalPath, lines.join('\n') + '\n');
      cache = next;
      byId = null;
      persisted = nextMap;
      rev++;
      ops += lines.length;
      const need = ops >= COMPACT_EVERY || Date.now() - lastCompact >= COMPACT_MS;
      if (need && !journalSkipped) compact();       // 有坏行时不压：journal 得留在盘上供人工找回
    } catch (e) {
      cache = null; byId = null;
      const err = new Error('本机资产索引写盘失败：' + (e.message || e));
      err.indexWrite = true;
      log('[local-assets] 写入索引失败：' + e.message);
      throw err;
    }
    return true;
  };
  const write = list => {
    load();
    const arr = Array.isArray(list) ? list : [];
    return flush(arr.slice(0, max));
  };
  /* 改一条：整表读-改-写的四个入口（from-url / POST / DELETE / 成品入库）以前都会互相覆盖，
     跨 await 的那一段越长撞得越准 —— 表现是「产物在盘上，资产库里少一条」。
     新条目插到最前（与列表「新→旧」一致），同 id 就地替换。
     这两条规则只有 putInto / dropFrom 一份：`upsert` / `remove` / `update` 的回调共用，
     不然「怎么算同一条」在两处各写一遍，改一处漏一处。 */
  const putInto = (list, item) => {
    if (!item || !item.id) throw new Error('索引条目缺少 id');
    const i = list.findIndex(x => x && x.id === item.id);
    if (i >= 0) { list[i] = item; return true; }
    list.unshift(item);
    if (list.length > max) list.length = max;
    return true;
  };
  const dropFrom = (list, id) => {
    const i = list.findIndex(x => x && x.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  };
  /* 一次改表的唯一执行体：读当前整表 → 交给 fn 同步改 → 落盘。fn 返回 false 表示没东西要写。
     同步调用点用它（upsert / remove），跨 await 的调用点用下面排队后的 update —— 两条共用这一段。 */
  const mutate = fn => {
    const list = load();
    if (fn(list) === false) return false;
    return flush(list);
  };
  const upsert = item => mutate(list => putInto(list, item));
  const remove = id => mutate(list => dropFrom(list, id));
  /* 跨 await 的改表只能走这一条：`update(fn)` 把「读当前整表 → 同步改 → 落盘」排进一条 Promise 链。
     为什么拿着 `read()` 的结果再 `upsert()` 还不够：那条路中间只要有一次 await（下载字节、
     删文件、问余量），Node 就会先去跑别的请求；调用方手里那份 `read()` 出来的表是**改动前**的，
     它再写就把别人刚加的条目盖掉了。`withLocalSaveLock` 只按「同一份来源」上锁，
     两个不同产物并发入库照样撞。
     `fn(list)` 必须是同步的（拿到的是队首那一刻的表），返回 `false` 表示这一趟不写盘。
     前一条失败不阻断后面的；写盘失败照旧把 `err.indexWrite` 抛给调用方，不能回 200。 */
  let chain = Promise.resolve();
  const update = fn => {
    const next = chain.then(() => mutate(fn), () => mutate(fn));
    chain = next.then(() => true, () => true);
    return next;
  };
  return { read, entry, write, upsert, remove, update, putInto, dropFrom, compact, snapshotPath, journalPath, max, version: () => rev };
}

module.exports = { createIndexStore, DEFAULT_MAX };
