/* 切片帧的持久缓存（P5）：刷新后同一工程再打开，同一批时刻不用再逐格解码。
   一条素材一条记录：{ key, quantum, at, frames: [{ t, blob }] }；
   LRU 索引单独一条 `__index`（{ id, at, n, bytes }），淘汰按整条记录算 ——
   一条素材一次缩放产出的那几张总是一起进一起出，逐张淘汰会让一条素材剩半排、补不回来。
   上限 3000 张 / 40MB。内存里那份（engine 的 frameCache）仍是第一层，这里只接刷新后的第一排。

   ⚠ 时间必须是**绝对源秒**（sliceTimes 已吸附到绝对栅格），否则换一次比例尺这批帧就全废了。 */
const NAME = 'slices';
const INDEX_KEY = '__index';
const MAX_FRAMES = 3000;
const MAX_BYTES = 40 * 1024 * 1024;

let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}
function store() {
  try { return window.Kv && window.Kv.at ? window.Kv.at(NAME) : null; } catch (e) { return null; }
}
const bytesOf = blob => (blob && blob.size) || 0;

/* 索引与记录的读改写都经同一条串行队列：切片流水线有 2-6 路并发写，
   两个 put 同时读旧索引再加自己那条，后写的会把先写的那条从 LRU 账上抹掉。 */
async function indexOf(st) {
  const v = await st.get(INDEX_KEY);
  return Array.isArray(v) ? v : [];
}
function totals(idx) {
  let n = 0, bytes = 0;
  for (const e of idx) { n += e.n || 0; bytes += e.bytes || 0; }
  return { n, bytes };
}
async function prune(st, idx) {
  let { n, bytes } = totals(idx);
  const dead = [];
  /* 从最久没读过的开始删；刚写的这一条排在最后（at = 现在），不会当场被删。 */
  const ordered = idx.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const e of ordered) {
    if (n <= MAX_FRAMES && bytes <= MAX_BYTES) break;
    dead.push(e.id);
    n -= e.n || 0; bytes -= e.bytes || 0;
  }
  if (!dead.length) return idx;
  for (const id of dead) { try { await st.del(id); } catch (e) { /* 这一条已经没了：索引照样往下修 */ } }
  const keep = idx.filter(e => !dead.includes(e.id));
  await st.put(INDEX_KEY, keep);
  return keep;
}
function upsertIndex(idx, id, at, n, bytes) {
  const out = idx.filter(e => e.id !== id);
  out.push({ id, at, n, bytes });
  return out;
}

/* 读一条素材的帧：返回 [{ t, blob }]，顺带把 at 写成现在（「读路径也刷 LRU」）。 */
export async function load(key) {
  const st = store();
  if (!st || !key) return [];
  return serial(async () => {
    try {
      const rec = await st.get(key);
      if (!rec || !Array.isArray(rec.frames) || !rec.frames.length) return [];
      const at = Date.now();
      rec.at = at;
      const bytes = rec.frames.reduce((a, f) => a + bytesOf(f.blob), 0);
      const idx = upsertIndex(await indexOf(st), key, at, rec.frames.length, bytes);
      await st.tx('readwrite', s => { s.put(rec, key); s.put(INDEX_KEY, idx); });
      return rec.frames;
    } catch (e) { return []; }
  });
}

/* 写一批帧（一块 = 至少三格）。已有记录的帧合并进来，不覆盖前几块。 */
export async function put(key, quantum, frames) {
  const st = store();
  if (!st || !key || !frames || !frames.length) return;
  return serial(async () => {
    try {
      const old = await st.get(key);
      const byT = new Map();
      for (const f of (old && old.frames) || []) if (f && f.blob) byT.set(Number(f.t), f);
      for (const [t, blob] of frames) if (blob) byT.set(Number(t), { t: Number(t), blob });
      const list = Array.from(byT.values()).sort((a, b) => a.t - b.t).slice(-MAX_FRAMES);
      const rec = { key, quantum: Number(quantum) || 0, at: Date.now(), frames: list };
      const n = list.length, bytes = list.reduce((a, f) => a + bytesOf(f.blob), 0);
      let idx = upsertIndex(await indexOf(st), key, rec.at, n, bytes);
      await st.tx('readwrite', s => { s.put(rec, key); s.put(INDEX_KEY, idx); });
      idx = await prune(st, idx);
    } catch (e) { /* 隐私模式 / 配额满：切片只是缓存，不能因为它把剪辑打断 */ }
  });
}

/* 清空（设置页「清空缓存」或工程切换时可选调用）：只清这一张表。 */
export async function clear() {
  const st = store();
  if (!st) return;
  return serial(async () => { try { await st.clear(); } catch (e) { /* 清缓存失败不影响继续用：旧帧按 LRU 照样被挤掉 */ } });
}
