/* ASR 设置与任务账本（server 侧唯一实现）。
   - .data/asr.json：设置（路线 / 语言 / 在线服务）。`service.key` 只留在盘上，
     读接口一律只回 hasKey，绝不回明文。
   - .data/asr-jobs.json：转写任务（状态 / 进度 / 分段 / SRT / sourceHash）。
     两个文件都是「先写 .tmp 再 rename」，覆盖前留 .bak.json（内容相同不留）。
   - 代理重启时把 queued/running 标成 interrupted，不自动重试（避免重复计费）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { writeJsonWithBak } = require('./fs-atomic.js');

const ROUTES = new Set(['auto', 'local', 'service']);
const JOB_KEEP = 60;
const SEG_MAX = 20000;

const defSettings = () => ({
  revision: 1,
  route: 'auto',
  language: '',
  service: { providerId: '', model: 'whisper-1', baseUrl: '', key: '' },
  updatedAt: '',
});

function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function isHttpUrl(v) {
  if (!v) return true;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && String(v).length <= 500;
  } catch { return false; }
}
function isLoopbackUrl(v) {
  try {
    const h = new URL(v).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch { return false; }
}
function srtTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n, w) => String(n).padStart(w, '0');
  return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
}
function toSrt(segs) {
  const list = Array.isArray(segs) ? segs : [];
  return list.map((s, i) => String(i + 1) + '\n'
    + srtTime(s.start) + ' --> ' + srtTime(s.end) + '\n'
    + String(s.text == null ? '' : s.text).replace(/\r/g, '').trim() + '\n').join('\n');
}
function normSegments(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, SEG_MAX).map(s => {
    const start = Math.max(0, Number(s && s.start) || 0);
    const end = Math.max(start, Number(s && s.end) || start);
    const text = String((s && s.text) == null ? '' : s.text).replace(/\s+/g, ' ').trim();
    return { start, end, text };
  }).filter(s => s.text);
}

function createAsrStore(opts) {
  const dataDir = opts.dataDir;
  const log = opts.log || (() => {});
  const settingsPath = path.join(dataDir, 'asr.json');
  const jobsPath = path.join(dataDir, 'asr-jobs.json');
  let settings = null;
  let jobs = null;

  const readJson = p => {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      if (e && e.code !== 'ENOENT') log('[asr] 读不出来 ' + path.basename(p) + '：' + e.message);
      return null;
    }
  };
  /* 覆盖写 + `.bak` 备份和写盘纪律都在 fs-atomic（writeJsonWithBak）：
     tmp → fsync → rename，被杀软/同步盘占住时退避重试。这里不再自己拼一份。 */
  const atomic = (p, obj) => writeJsonWithBak(p, obj);

  const loadSettings = () => {
    if (settings) return settings;
    const raw = readJson(settingsPath) || {};
    const d = defSettings();
    settings = {
      revision: Number(raw.revision) || 1,
      route: ROUTES.has(raw.route) ? raw.route : d.route,
      language: cleanStr(raw.language, 32),
      service: {
        providerId: cleanStr(raw.service && raw.service.providerId, 60),
        model: cleanStr(raw.service && raw.service.model, 120) || d.service.model,
        baseUrl: cleanStr(raw.service && raw.service.baseUrl, 500),
        key: cleanStr(raw.service && raw.service.key, 500),
      },
      updatedAt: cleanStr(raw.updatedAt, 40),
    };
    return settings;
  };
  const saveSettings = () => {
    const s = loadSettings();
    s.revision = (Number(s.revision) || 0) + 1;
    s.updatedAt = new Date().toISOString();
    atomic(settingsPath, s);
    return publicSettings();
  };
  const publicSettings = () => {
    const s = loadSettings();
    return {
      revision: s.revision,
      route: s.route,
      language: s.language,
      service: {
        providerId: s.service.providerId,
        model: s.service.model,
        baseUrl: s.service.baseUrl,
        hasKey: !!s.service.key,
      },
      updatedAt: s.updatedAt,
    };
  };
  /* patch 只收白名单字段；返回前不回明文。`service.key` 传空串不覆盖，
     要清掉得显式 clearKey（与设置页「清空密钥」那条路一致）。 */
  const patchSettings = patch => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const s = loadSettings();
    if (ROUTES.has(p.route)) s.route = p.route;
    if (p.language != null) {
      const lang = cleanStr(p.language, 32);
      if (lang && !/^[A-Za-z-]+$/.test(lang)) throw new Error('语言只能填 zh / en / ja 这类短标记');
      s.language = lang;
    }
    const svc = p.service && typeof p.service === 'object' ? p.service : {};
    if (svc.providerId != null) {
      const id = cleanStr(svc.providerId, 60);
      if (id && !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('供应商 id 不合法');
      s.service.providerId = id;
    }
    if (svc.model != null) s.service.model = cleanStr(svc.model, 120) || 'whisper-1';
    if (svc.baseUrl != null) {
      const base = cleanStr(svc.baseUrl, 500).replace(/\/+$/, '');
      if (!isHttpUrl(base)) throw new Error('接口地址要以 http:// 或 https:// 开头');
      s.service.baseUrl = base;
    }
    if (p.clearKey === true) s.service.key = '';
    else if (svc.key != null && String(svc.key).trim()) s.service.key = cleanStr(svc.key, 500);
    return saveSettings();
  };

  const normJob = raw => {
    const j = raw && typeof raw === 'object' ? raw : {};
    const state = ['queued', 'running', 'done', 'error', 'canceled', 'interrupted'].includes(j.state) ? j.state : 'error';
    const segments = state === 'done' ? normSegments(j.segments) : [];
    return {
      id: cleanStr(j.id, 80),
      state,
      progress: Math.max(0, Math.min(1, Number(j.progress) || 0)),
      segments,
      srt: state === 'done' ? (String(j.srt || '') || toSrt(segments)) : '',
      error: cleanStr(j.error, 800),
      sourceHash: cleanStr(j.sourceHash, 40),
      route: cleanStr(j.route, 20),
      language: cleanStr(j.language, 32),
      engine: cleanStr(j.engine, 120),
      media: cleanStr(j.media, 300),
      createdAt: Number(j.createdAt) || Date.now(),
      updatedAt: Number(j.updatedAt) || Date.now(),
    };
  };
  const loadJobs = () => {
    if (jobs) return jobs;
    const raw = readJson(jobsPath) || {};
    const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
    jobs = {};
    for (const id of Object.keys(items)) {
      const j = normJob({ ...items[id], id });
      if (j.id) jobs[j.id] = j;
    }
    let changed = false;
    for (const j of Object.values(jobs)) {
      if (j.state === 'queued' || j.state === 'running') {
        j.state = 'interrupted';
        j.error = '代理重启时这一单还没跑完；没有自动重试（避免重复计费）';
        j.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) persistJobs();
    return jobs;
  };
  const persistJobs = () => {
    const all = Object.values(loadJobs()).sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = {};
    for (const j of all.slice(0, JOB_KEEP)) keep[j.id] = j;
    jobs = keep;
    atomic(jobsPath, { revision: 1, items: keep });
  };
  const getJob = id => loadJobs()[String(id || '')] || null;
  const putJob = job => {
    loadJobs();
    jobs[job.id] = normJob(job);
    persistJobs();
    return jobs[job.id];
  };
  const patchJob = (id, patch) => {
    const cur = getJob(id);
    if (!cur) return null;
    const next = normJob({ ...cur, ...(patch || {}), id: cur.id, updatedAt: Date.now() });
    jobs[cur.id] = next;
    persistJobs();
    return next;
  };
  const removeJob = id => {
    loadJobs();
    if (!jobs[id]) return false;
    delete jobs[id];
    persistJobs();
    return true;
  };
  const findByHash = (hash, route, language) => {
    const all = Object.values(loadJobs());
    return all.find(j => j.state === 'done' && j.sourceHash === hash
      && j.route === route && j.language === (language || '')) || null;
  };
  const listJobs = () => Object.values(loadJobs()).sort((a, b) => b.createdAt - a.createdAt);

  return {
    settingsPath, jobsPath, toSrt, normSegments,
    settings: publicSettings, rawSettings: loadSettings, patchSettings,
    jobs: listJobs, job: getJob, putJob, patchJob, removeJob, findByHash,
  };
}

const LOCAL_NAMES = process.platform === 'win32'
  ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
  : ['whisper-cli', 'whisper', 'main'];
function localAsrState(root) {
  const toolDir = path.join(root, 'tools', 'whisper');
  const candidates = [];
  const envBin = String(process.env.WHISPER_BIN || '').trim();
  if (envBin) candidates.push(envBin);
  for (const n of LOCAL_NAMES) candidates.push(path.join(toolDir, n));
  const bin = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
  let model = String(process.env.WHISPER_MODEL || '').trim();
  if (!model) {
    const dirs = [path.join(toolDir, 'models'), toolDir];
    for (const dir of dirs) {
      try {
        const hit = fs.readdirSync(dir).find(f => /\.bin$/i.test(f));
        if (hit) { model = path.join(dir, hit); break; }
      } catch (e) {}
    }
  }
  let bytes = 0;
  if (model) { try { bytes = fs.statSync(model).size; } catch (e) { bytes = 0; } }
  const why = !bin ? '没找到 whisper-cli（放到 tools/whisper/ 或在 .env 里设 WHISPER_BIN）'
    : !model ? '没找到模型（.bin 放到 tools/whisper/models/ 或在 .env 里设 WHISPER_MODEL）'
    : !bytes ? '模型文件读不到：' + model : '';
  return {
    available: !!(bin && model && bytes),
    bin, model: model ? path.basename(model) : '', bytes, why,
  };
}

module.exports = { createAsrStore, localAsrState, toSrt, normSegments, srtTime };
