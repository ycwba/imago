/* 接续拆分镜与依赖式批量生成的纯算法。
   engine 只调用；这里不碰 DOM、不读 window，定时 / 轮询 / 取帧由调用方注入，便于单测。
   分工：
     shotPlacement  全片顺序 + 每一镜的上一镜 / 下一镜（「上一镜是谁」只在这一处算）
     chainDeps      哪些镜头在等上一镜的尾帧、等的是谁、为什么还没得接
     splitLongShots 长镜头按接续型号拆成几段（总秒数守恒，第二段起 chain:'tail'）
     pickChainModel 从可用型号里挑能接首帧、且能覆盖该段时长的型号
     quoteKeyOf     一次报价的稳定键（不含 count，方便把同一规格的多镜合并成一次询价）
     sumQuotes      把多次询价结果收成一份账（缺金额绝不当 0、多币种不合并）
     runWithDeps    依赖式调度器：只把真正在提交的那一下算进并发名额 */

const CODE_WHY = {
  'no-prev': '这是第一个镜头，没有上一镜可接',
  waiting: '等上一镜出画面后才能接它的尾帧',
  'no-frame': '上一镜还没有可用画面，先单独生成它',
};

/* 全片顺序（跨场景连续）：每一镜带上它在哪一场、第几镜、上一镜与下一镜。
   接续只看「片子里排在它前面的那一镜」，与场景边界无关 —— 一场的最后一句后面接下一场的第一句，
   这在成片里就是相邻的两个镜头。 */
export function shotPlacement(scenes) {
  const out = [];
  (scenes || []).forEach((sc, sceneIndex) => {
    ((sc && sc.shots) || []).forEach((shot, shotIndex) => {
      out.push({ shot, scene: sc, sceneIndex, shotIndex, prev: null, next: null });
    });
  });
  out.forEach((p, i) => {
    p.prev = i > 0 ? out[i - 1].shot : null;
    p.next = i + 1 < out.length ? out[i + 1].shot : null;
  });
  return out;
}

/* 上一镜是否已经有一张能当首帧的画面（静态尾帧 / 画面切片 / 已成功的候选）。
   只回答「有没有」，取哪一张由 engine 的 resolveChainFrame 决定。 */
export function hasTailFrame(sh) {
  if (!sh) return false;
  if (sh.lastFrame) return true;
  if ((sh.keyframes || []).some(k => k && k.assetId)) return true;
  return (sh.candidates || []).some(c => c && c.status === 'succeeded' && c.url);
}

export function isRunning(sh) {
  return ((sh && sh.candidates) || []).some(c => c && ['creating', 'queued', 'running'].includes(c.status));
}

/* 这一批镜头里谁在等上一镜。`opts.pending` 是「已经排进本批、马上会提交」的镜头集合：
   上一镜自己还没出画面、但它在同一批里等着跑，那这一镜就是「等」，不是「永远不能生成」。
   返回项：{ shot, prev, ok, code, why }；ok=false 时 code / why 说明卡在哪。 */
export function chainDeps(shots, opts) {
  const list = shots || [];
  const pending = (opts && opts.pending) || null;
  return list.map((sh, i) => {
    if (!sh || sh.linkPrev !== 'tail' || sh.firstFrame) return { shot: sh, prev: null, ok: true, code: '', why: '' };
    const prev = i > 0 ? list[i - 1] : null;
    if (!prev) return { shot: sh, prev: null, ok: false, code: 'no-prev', why: CODE_WHY['no-prev'] };
    if (hasTailFrame(prev)) return { shot: sh, prev, ok: true, code: 'ready', why: '' };
    if (isRunning(prev) || (pending && pending.has(prev))) return { shot: sh, prev, ok: false, code: 'waiting', why: CODE_WHY.waiting };
    return { shot: sh, prev, ok: false, code: 'no-frame', why: CODE_WHY['no-frame'] };
  });
}

/* 挑接续型号：优先当前型号（它已经能接首帧时不必换），其次同时支持首尾帧的型号，
   再次只支持首帧的；同一档里取时长上限最大的（少拆一段就少一道缝）。
   `duration` / `supportsDuration` 给了才按时长筛；不给时只按能力排序。 */
export function pickChainModel(models, currentModel, duration, supportsDuration) {
  const list = (models || []).filter(m => m && m.first);
  if (!list.length) return null;
  const fits = m => (!duration || typeof supportsDuration !== 'function' ? true : !!supportsDuration(m, duration));
  const cur = list.find(m => m.id === currentModel);
  if (cur && fits(cur)) return cur;
  const byMax = (a, b) => (Number(b.max) || 0) - (Number(a.max) || 0);
  const both = list.filter(m => m.last && fits(m)).sort(byMax);
  if (both.length) return both[0];
  const only = list.filter(fits).sort(byMax);
  return only[0] || null;
}

/* 按句号 / 问号 / 分号 / 换行切句；句子不够分段时按字符数切。
   每段只拿自己那一截，**不把整段提示词重复发给每一段**。 */
function splitText(text, n, durs) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return new Array(n).fill('');
  const parts = (s.match(/[^。！？；!?;\n]+[。！？；!?;\n]?/g) || [s]).map(x => x.trim()).filter(Boolean);
  const total = durs.reduce((a, b) => a + b, 0) || 1;
  if (parts.length >= n) {
    const out = [];
    let at = 0;
    for (let i = 0; i < n; i++) {
      const want = i === n - 1 ? parts.length - at
        : Math.max(1, Math.min(parts.length - at - (n - i - 1), Math.round(parts.length * durs[i] / total)));
      out.push(parts.slice(at, at + want).join('').trim());
      at += want;
    }
    if (at < parts.length) out[n - 1] += parts.slice(at).join('');
    return out;
  }
  const chars = Array.from(s);
  const out = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const left = chars.length - at;
    const slots = n - i;
    if (i === n - 1) { out.push(chars.slice(at).join('').trim()); at = chars.length; break; }
    let take = Math.round(chars.length * durs[i] / total);
    take = Math.max(1, Math.min(left - (slots - 1), take));
    out.push(chars.slice(at, at + take).join('').trim());
    at += take;
  }
  return out;
}

/* 按总秒数均分：总和严格等于原时长、每段都是整数，并落在 [min,max] 内。
   返回 null = 拆不成合法片段（太短 / 型号没声明区间 / 均分后越界）。 */
function distribute(total, n, min, max) {
  if (!(n >= 2) || !(max >= 1)) return null;
  const base = Math.floor(total / n), rem = total - base * n;
  const out = Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
  if (out.some(d => d < Math.max(1, min) || d > max)) return null;
  return out;
}

const NAME_MAX = 12;
function segName(base, suffix) {
  const s = String(base == null ? '' : base).trim() || '镜头';
  const room = Math.max(1, NAME_MAX - suffix.length);
  return s.slice(0, room) + suffix;
}

/* 长镜头拆分。只在**没有任何可用视频型号能覆盖整段时长**时拆：
   有一家能吃下就整段交给它，多拆一段就多一道缝、多花一次钱。
   items 是审查弹窗那一层的条目（{ key, scene, name, dur, text, line, who, note, label }）。
   opts: { models, canDur, currentModel, maxName }
     models = [{ id, name, min, max, first, last }]
   canDur=false（本机没有声明时长区间的型号）时整段不动 —— 没有秒数依据，不替平台编。
   返回 { items, split, added, impossible, note }：
     split      有几个原镜头被拆开
     added      多出来几条（总条数 - 原条数）
     impossible [{ item, why }]：太长但拆不成合法片段，原样保留，交给落盘后的逐镜 clamp
     note       给审查弹窗的一句报数（没有拆分时为空串） */
export function splitLongShots(items, opts) {
  const o = opts || {};
  const list = items || [];
  const allModels = (o.models || []).filter(m => m && Number(m.max) > 0);
  const allMax = allModels.reduce((m, x) => Math.max(m, Number(x.max) || 0), 0);
  const out = [];
  const impossible = [];
  let split = 0, added = 0;
  if (o.canDur === false || !allMax) return { items: list.slice(), split: 0, added: 0, impossible, note: '' };
  list.forEach(src => {
    if (!src) { out.push(src); return; }
    const total = Math.round(Number(src.dur));
    if (!Number.isFinite(total) || total <= 0 || total <= allMax) { out.push(src); return; }
    const model = pickChainModel(o.models, o.currentModel || '', 0, null);
    const min = Math.max(1, Number(model && model.min) || 0);
    const max = Number(model && model.max) || 0;
    if (!model || !max) {
      out.push(src);
      impossible.push({ item: src, why: '没有支持首帧、又声明了时长区间的接续型号' });
      return;
    }
    const n = Math.ceil(total / max);
    const durs = distribute(total, n, min, max);
    if (!durs) {
      out.push(src);
      impossible.push({ item: src, why: '总时长 ' + total + ' 秒，按 ' + (model.name || model.id)
        + ' 每段 ' + min + '–' + max + ' 秒拆不成至少两段合法的接续片段' });
      return;
    }
    const texts = splitText(src.text, n, durs);
    const maxNameLen = Number(o.maxName) > 0 ? Number(o.maxName) : NAME_MAX;
    for (let i = 0; i < n; i++) {
      const suffix = n > 1 ? '（' + (i + 1) + '/' + n + '）' : '';
      const next = Object.assign({}, src, {
        key: String(src.key == null ? '' : src.key) + suffix,
        name: segName(src.name, suffix).slice(0, maxNameLen),
        dur: durs[i],
        text: i === 0 ? texts[0] : (texts[i] + '（第 ' + (i + 1) + ' 段，延续上一段结尾）'),
        chain: i === 0 ? (src.chain === 'tail' ? 'tail' : '') : 'tail',
        line: i === 0 ? src.line : '',
        who: i === 0 ? src.who : '',
        note: i === 0 ? src.note : '',
        label: String(src.label || '') + (n > 1 ? ' · 第 ' + (i + 1) + '/' + n + ' 段' : ''),
        chainModel: model.id,
        splitOf: src.key,
      });
      out.push(next);
    }
    split++;
    added += n - 1;
  });
  const note = split
    ? '已把 ' + split + ' 个超过所有型号上限的镜头拆成接续片段（共多出 ' + added
      + ' 条，第二段起接上一镜尾帧）'
    : '';
  return { items: out, split, added, impossible, note };
}

/* 报价稳定键：同一条键的镜头规格完全一样，可以合并成一次询价（count = 条数）。
   不含 count —— 那正是要被合并掉的那一项。键里只放影响价钱的输入。 */
function stable(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => k + ':' + stable(v[k])).join(',') + '}';
}
export function quoteKeyOf(shot, ctx) {
  const sh = shot || {};
  const c = ctx || {};
  return [
    c.provider || '', c.model || '',
    sh.duration == null ? '' : sh.duration,
    sh.res || '', sh.tier || '', sh.ar || '', sh.size || '',
    c.intent || '', c.mode || '',
    stable(c.topBools), stable(c.shapeFields), stable(c.caps),
    sh.combo || '', c.combo || '',
  ].join('|');
}

/* 报价合计：只加 `ok && typeof amount === 'number'` 的那几笔。
   缺金额 / 只报最低消费 / 询价失败 → 计入 unpriced，绝不当 0；
   币种不同不合并成一个总数（返回 mixed=true 与按币种分开的账）。 */
export function sumQuotes(list) {
  let total = 0, priced = 0, unpriced = 0;
  const byCurrency = new Map();
  (list || []).forEach(r => {
    if (!r || !r.ok || typeof r.amount !== 'number' || !Number.isFinite(r.amount)) { unpriced++; return; }
    priced++;
    total += r.amount;
    const cur = String(r.currency || '');
    byCurrency.set(cur, (byCurrency.get(cur) || 0) + r.amount);
  });
  const currencies = [...byCurrency.keys()];
  const mixed = currencies.length > 1;
  return {
    total: mixed ? null : total,
    priced,
    unpriced,
    currencies,
    byCurrency: [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount })),
    mixed,
  };
}

/* 依赖式调度器：每个 item 在提交前先等它的依赖（上一镜）跑完。
   · limit 只包住 run(item) 这一段（提交窗口），等待依赖的时间不占名额；
   · 依赖失败 → onBlocked(item, dep) 并级联（它后面的依赖它的 item 也会被 block）；
   · stateOf(item) 返回 'done' | 'failed' | 'running' | 'todo'（缺省 'todo'）；
   · wait(dep) 由调用方注入（轮询 / deferred），返回后重新问 stateOf。
   run 抛错按失败处理，不终止其它分支。返回与 items 等长的数组：
   [{ item, ok, blocked, error }]。 */
export async function runWithDeps(spec) {
  const s = spec || {};
  const items = s.items || [];
  const limit = Math.max(1, Number(s.limit) || 1);
  const stateOf = s.stateOf || (() => 'todo');
  const wait = s.wait || (() => Promise.resolve());
  const onBlocked = s.onBlocked || (() => {});
  const depOf = typeof s.deps === 'function' ? s.deps
    : it => (s.deps instanceof Map ? s.deps.get(it) : ((s.deps || {})[it] || null));
  let slots = limit;
  const queue = [];
  const acquire = () => (slots > 0 ? (slots--, Promise.resolve()) : new Promise(res => queue.push(res)));
  const release = () => {
    slots++;
    const next = queue.shift();
    if (next) { slots--; next(); }
  };
  const outs = new Array(items.length);
  const failed = new Set();
  await Promise.all(items.map(async (it, i) => {
    const dep = depOf(it);
    if (dep) {
      if (failed.has(dep)) {
        outs[i] = { item: it, ok: false, blocked: true, error: null };
        failed.add(it);
        onBlocked(it, dep);
        return;
      }
      if (stateOf(dep) !== 'done') {
        await wait(dep);
        if (stateOf(dep) !== 'done') {
          outs[i] = { item: it, ok: false, blocked: true, error: null };
          failed.add(it);
          onBlocked(it, dep);
          return;
        }
      }
    }
    await acquire();
    try {
      outs[i] = { item: it, ok: true, blocked: false, error: null, value: await s.run(it) };
    } catch (e) {
      outs[i] = { item: it, ok: false, blocked: false, error: e };
      failed.add(it);
    } finally {
      release();
    }
  }));
  return outs;
}
