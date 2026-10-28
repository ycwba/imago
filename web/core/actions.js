/* 全局动作注册表：唯一目录 + schema 子集 + 一次性 planToken + busyKey 串行 + 可选 Trace。
   纯注册表，不导入领域；动作由启动装配或页面注册。 */
const crypto = globalThis.crypto;
/* 错误文案的唯一实现在 net.js（window.errText）。本模块在 Node 测试里也会被直接 import，
   那边没有 net.js，所以只留一条「拿不到公共件就退回 e.message」的兜底，不另写一套文案。 */
const errOf = e => (globalThis.errText ? globalThis.errText(e) : (e && e.message) || String(e));

function stable(v) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function hash(v) {
  let h = 2166136261;
  const s = stable(v);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}
function validate(value, schema, path = '') {
  if (!schema) return '';
  const t = schema.type;
  if (t) {
    const actual = typeOf(value);
    const ok = t === actual || (t === 'number' && actual === 'integer');
    if (!ok) return (path || '参数') + ' 应为 ' + t + '，实际是 ' + actual;
  }
  if (schema.enum && !schema.enum.includes(value)) return (path || '参数') + ' 只能取 ' + schema.enum.join(' / ');
  if (typeof value === 'number') {
    if (schema.min != null && value < schema.min) return (path || '参数') + ' 不能小于 ' + schema.min;
    if (schema.max != null && value > schema.max) return (path || '参数') + ' 不能大于 ' + schema.max;
  }
  if (t === 'object' || (value && typeof value === 'object' && !Array.isArray(value))) {
    for (const k of (schema.required || [])) if (value == null || value[k] === undefined) return (path ? path + '.' : '') + k + ' 必填';
    for (const [k, s] of Object.entries(schema.properties || {})) {
      if (value && value[k] !== undefined) {
        const err = validate(value[k], s, (path ? path + '.' : '') + k);
        if (err) return err;
      }
    }
  }
  if (t === 'array' && schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = validate(value[i], schema.items, (path || '参数') + '[' + i + ']');
      if (err) return err;
    }
  }
  return '';
}

export function createActionRegistry(opts = {}) {
  const defs = new Map();
  const plans = new Map();
  const busy = new Map();
  const ops = new Map();                     // operationId → { at, result }（24 小时内同一意图不重复执行）
  const now = opts.now || (() => Date.now());
  const planTTL = opts.planTTL || 10 * 60 * 1000;
  const opTTL = opts.opTTL || 24 * 60 * 60 * 1000;
  const trace = opts.trace || (() => {});

  function register(def) {
    if (!def || typeof def !== 'object') throw new Error('动作必须是对象');
    if (!def.id || typeof def.id !== 'string') throw new Error('动作缺少 id');
    if (defs.has(def.id)) throw new Error('动作 id 重复：' + def.id);
    const effect = def.effect || 'read';
    if (!['read', 'write', 'cost', 'ui'].includes(effect)) throw new Error(def.id + ' effect 非法：' + effect);
    if (typeof def.check !== 'function' || typeof def.run !== 'function') throw new Error(def.id + ' 必须同时有 check 与 run');
    if (effect === 'write' && !def.undo && !def.irreversible) throw new Error(def.id + ' 是内容写动作，必须声明 undo 或 irreversible');
    if (effect === 'cost' && def.cancel === undefined) throw new Error(def.id + ' 是花钱动作，必须声明 cancel（id 或 false）');
    const item = {
      ...def,
      effect,
      route: def.route || '*',
      expose: { chat: true, ui: true, ...(def.expose || {}) },
      timeoutMs: def.timeoutMs == null ? 30000 : def.timeoutMs,
    };
    defs.set(item.id, item);
    return () => defs.delete(item.id);
  }
  function list(o = {}) {
    const route = o.route;
    const chat = o.chat !== false;
    return [...defs.values()].filter(d =>
      (!route || d.route === '*' || d.route === route) &&
      (!chat || d.expose.chat !== false)
    ).map(d => ({
      id: d.id, domain: d.domain || '', title: d.title || '', summary: d.summary || '',
      route: d.route, effect: d.effect, expose: d.expose,
      input: d.input || null, undo: d.undo || false, irreversible: !!d.irreversible,
      cancel: d.cancel === undefined ? null : d.cancel,
    }));
  }
  function describe(id) {
    const d = defs.get(id);
    if (!d) throw new Error('没有这个动作：' + id);
    return { id: d.id, title: d.title || '', summary: d.summary || '', route: d.route, effect: d.effect, input: d.input || null, undo: d.undo || false, irreversible: !!d.irreversible, cancel: d.cancel === undefined ? null : d.cancel };
  }
  async function check(id, input, ctx = {}) {
    const d = defs.get(id);
    if (!d) return { ok: false, reason: '没有这个动作：' + id };
    const bad = validate(input, d.input);
    if (bad) return { ok: false, reason: bad };
    trace({ phase: 'checking', id });
    try { const r = await d.check(input, ctx); return r || { ok: true }; }
    catch (e) { return { ok: false, reason: errOf(e) }; }
  }
  function cleanup() {
    const t = now();
    for (const [k, p] of plans) if (p.used || p.expires < t) plans.delete(k);
    if (plans.size > 300) {
      const arr = [...plans.entries()].sort((a, b) => a[1].expires - b[1].expires);
      for (let i = 0; i < arr.length - 200; i++) plans.delete(arr[i][0]);
    }
  }
  async function plan(id, input, ctx = {}) {
    const chk = await check(id, input, ctx);
    if (!chk || chk.ok === false) return { ok: false, reason: (chk && (chk.reason || chk.err)) || '动作被拒绝' };
    const d = defs.get(id);
    const planId = 'plan_' + hash({ id, input, t: now() }) + '_' + Math.random().toString(36).slice(2, 8);
    const token = (crypto && crypto.randomUUID) ? crypto.randomUUID() : planId + '_' + Math.random();
    plans.set(planId, { id, input, token, route: ctx.route || '', hash: hash(input), expires: now() + planTTL, used: false });
    cleanup();
    trace({ phase: 'awaiting-confirm', id, planId });
    return { ok: true, planId, plan: chk.plan || chk, reason: chk.reason || '', effect: d.effect };
  }
  async function run(planId, ctx = {}) {
    cleanup();
    const p = plans.get(planId);
    if (!p) return { ok: false, reason: '计划不存在或已过期' };
    if (p.used) return { ok: false, reason: '这个计划已经执行过' };
    if (p.expires < now()) { plans.delete(planId); return { ok: false, reason: '计划已过期' }; }
    const d = defs.get(p.id);
    if (!d) return { ok: false, reason: '动作已下线' };
    /* 页面作用域：计划生成时记下 route，执行时页面已经切走就拒绝，不替用户换页后继续做。
       '*' 的动作不属于某一页，任何页面都能执行。 */
    if (p.route && p.route !== '*' && ctx.route && p.route !== ctx.route) {
      return { ok: false, code: 'route_mismatch', reason: '这个动作只属于「' + p.route + '」，先切回那一页再执行' };
    }
    const opId = String((p.input && p.input.operationId) || ctx.operationId || '');
    if (opId) {
      const hit = ops.get(opId);
      if (hit && now() - hit.at < opTTL) return { ...hit.result, deduped: true };
      if (hit) ops.delete(opId);
    }
    const key = d.busyKey || (opId ? 'op:' + opId : '');
    const prev = key ? busy.get(key) : null;
    if (prev) return { ok: false, reason: '同一目标还有动作在跑，等它结束再试' };
    p.used = true;
    const task = (async () => {
      trace({ phase: 'running', id: d.id, planId });
      let timer = null;
      try {
        const result = d.timeoutMs > 0
          ? await Promise.race([
              Promise.resolve().then(() => d.run(p.input, ctx)),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('动作超时（' + d.timeoutMs + 'ms）')), d.timeoutMs); }),
            ])
          : await d.run(p.input, ctx);
        trace({ phase: 'done', id: d.id, planId });
        return result || { ok: true };
      } catch (e) {
        trace({ phase: 'error', id: d.id, planId, reason: errOf(e) });
        throw e;
      } finally { if (timer) clearTimeout(timer); }
    })();
    if (key) {
      busy.set(key, task);
      task.finally(() => { if (busy.get(key) === task) busy.delete(key); }).catch(() => {});
    }
    try {
      const result = await task;
      if (opId) ops.set(opId, { at: now(), result: result || { ok: true } });
      cleanupOps();
      return result;
    } catch (e) { return { ok: false, reason: errOf(e) }; }
  }
  function cleanupOps() {
    const t = now();
    for (const [k, v] of ops) if (t - v.at > opTTL) ops.delete(k);
    if (ops.size > 500) {
      const arr = [...ops.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < arr.length - 400; i++) ops.delete(arr[i][0]);
    }
  }
  async function runNow(id, input, ctx = {}) {
    const d0 = defs.get(id);
    if (!d0) return { ok: false, reason: '没有这个动作：' + id };
    if (d0.route !== '*' && ctx.route && d0.route !== ctx.route) {
      return { ok: false, code: 'route_mismatch', reason: '这个动作只属于「' + d0.route + '」，先切回那一页再执行' };
    }
    const chk = await check(id, input, ctx);
    if (!chk || chk.ok === false) return { ok: false, reason: (chk && (chk.reason || chk.err)) || '动作被拒绝' };
    const d = defs.get(id);
    const key = d.busyKey || '';
    if (key && busy.has(key)) return { ok: false, reason: '同一目标还有动作在跑，等它结束再试' };
    const task = Promise.resolve().then(() => d.run(input, ctx));
    if (key) { busy.set(key, task); task.finally(() => { if (busy.get(key) === task) busy.delete(key); }).catch(() => {}); }
    try { return await task; } catch (e) { return { ok: false, reason: errOf(e) }; }
  }
  function contexts(route) {
    return [...defs.values()].filter(d => (d.route === '*' || d.route === route) && typeof d.context === 'function')
      .map(d => { try { return { id: d.id, context: d.context() }; } catch (e) { return null; } }).filter(Boolean);
  }
  return { register, list, describe, check, plan, run, runNow, contexts, has: id => defs.has(id), size: () => defs.size };
}
