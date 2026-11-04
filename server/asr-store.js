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

const ROUTES = new Set(['auto', 'browser', 'local', 'service']);
const JOB_KEEP = 60;
const SEG_MAX = 20000;

const defSettings = () => ({
  revision: 1,
  route: 'auto',
  language: '',
  /* 型号空着 = 用这一家声明里的默认型号（openai 是 whisper-1、智谱是 glm-asr-2512…）。
     以前这里写死 whisper-1，换一家之后照样把 whisper-1 发过去 —— 上游直接 400。 */
  service: { providerId: '', model: '', baseUrl: '', key: '' },
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
function srtTime(sec) {
  /* 先整体取整到毫秒再拆位：`Math.round(小数部分 * 1000)` 在 1.9996 这种值上会算出 1000，
     拼出来是 `00:00:01,1000` —— 那不是合法 SRT 时间（毫秒只有 000–999），
     导进别的软件会当场报错。整体取整还会自然进位到下一秒。 */
  const total = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
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
     同内容不留、一份备份至少留 10 分钟、备份没成就不覆盖（会抛，调用方照实回错）；
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
        model: cleanStr(raw.service && raw.service.model, 120),
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
    const base = loadSettings();
    /* 先在副本上改、全部校验通过再落回缓存对象：以前中途抛错（例如接口地址非法）时，
       前面几项已经改在内存里、磁盘却没写 —— 运行中的设置成了「半截新半截旧」，
       重启才复原，而这中间每一单转写都按那份半截配置走。 */
    const s = { ...base, service: { ...base.service } };
    const prevProvider = s.service.providerId;
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
    if (svc.model != null) s.service.model = cleanStr(svc.model, 120);
    if (svc.baseUrl != null) {
      const url = cleanStr(svc.baseUrl, 500).replace(/\/+$/, '');
      if (!isHttpUrl(url)) throw new Error('接口地址要以 http:// 或 https:// 开头');
      s.service.baseUrl = url;
    }
    if (p.clearKey === true) s.service.key = '';
    else if (svc.key != null && String(svc.key).trim()) s.service.key = cleanStr(svc.key, 500);
    /* 换在线服务商：接口地址 / 型号 / 单独那把密钥都属于「上一家」，一并作废。
       不清的话，上一家的密钥会带着 Authorization 发到新那家的地址上，
       上一家的自定义地址也会顶掉新那家声明的默认端点。同一趟显式给了新值就以新值为准。 */
    if (s.service.providerId !== prevProvider) {
      if (!String(svc.baseUrl == null ? '' : svc.baseUrl).trim()) s.service.baseUrl = '';
      if (svc.model == null) s.service.model = '';
      if (p.clearKey !== true && !String(svc.key == null ? '' : svc.key).trim()) s.service.key = '';
    }
    Object.assign(base, s);
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
      /* 「这份结果是谁出的」：local:<模型> / service:<供应商>/<型号> / browser。
         去重要连它一起比 —— 同一份音频换个在线模型再转一次，本来就是为了不同的结果。 */
      engineKey: cleanStr(j.engineKey, 160),
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
  /* 去重：同一份媒体 + 同一路线 + 同一语言 + 同一个引擎（`engineKey`）。
     engineKey 缺省时退回旧口径（只看前三样），旧账本里没有这个字段的条目仍可被复用。 */
  const findByHash = (hash, route, language, engineKey) => {
    const all = Object.values(loadJobs());
    return all.find(j => j.state === 'done' && j.sourceHash === hash
      && j.route === route && j.language === (language || '')
      && (!engineKey || j.engineKey === engineKey)) || null;
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
  let bin = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
  /* 相对路径一律按「启动代理时的工作目录」解析成绝对路径：runLocal 起子进程时
     cwd 是那一单的临时目录，相对路径到那里就找不到了。 */
  if (bin && !path.isAbsolute(bin)) bin = path.resolve(bin);
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
  if (model && !path.isAbsolute(model)) model = path.resolve(model);
  let bytes = 0;
  if (model) { try { bytes = fs.statSync(model).size; } catch (e) { bytes = 0; } }
  const why = !bin ? '没找到 whisper-cli（放到 tools/whisper/ 或在 .env 里设 WHISPER_BIN）'
    : !model ? '没找到模型（.bin 放到 tools/whisper/models/ 或在 .env 里设 WHISPER_MODEL）'
    : !bytes ? '模型文件读不到：' + model : '';
  return {
    available: !!(bin && model && bytes),
    bin,
    /* `model` 是给界面看的短名（basename）；真正传给 whisper-cli `-m` 的必须是 `modelPath`
       这一份绝对路径 —— 以前调用点拿的是 basename，而工作目录是临时目录，模型永远找不到。 */
    model: model ? path.basename(model) : '', modelPath: model, bytes, why,
  };
}

module.exports = { createAsrStore, localAsrState, toSrt, normSegments, srtTime };
