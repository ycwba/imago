/* 渲染任务索引（.data/render-jobs.json）：最近 50 单的轻量记录。
   为什么要有它：成片文件一直在 .renders 里，但任务对象（renders Map）5 分钟后就被回收，
   关掉页面 / 重启代理之后「最近导出过什么」就再也查不到 —— 用户只记得文件名大概长什么样。
   只记身份与状态，不记 ffmpeg 日志；文件本身不在这里，也不参与云同步（见 cloud-store 的跳过表）。
   进程重启时上次停在 queued/running 的单子不会自己回来：标成 interrupted 并说清原因。 */
'use strict';
const fs = require('fs');
const path = require('path');

const KEY = 'render-jobs';
const LIMIT = 50;
const ACTIVE = new Set(['queued', 'running']);

function createRenderJobsStore(opts) {
  const dataFileOf = opts.dataFileOf;
  const dataWriteRaw = opts.dataWriteRaw;
  const log = opts.log || (() => {});
  let list = null;

  function write() {
    try {
      dataWriteRaw(KEY, Buffer.from(JSON.stringify({ v: 1, jobs: list })));
    } catch (e) {
      /* 索引写不进去不该让一单已经出片的渲染失败：下一次状态变化还会再写一遍。 */
      log('[render-jobs] 写索引失败：' + e.message);
    }
  }

  function load() {
    if (list) return list;
    let raw = [];
    try {
      const v = JSON.parse(fs.readFileSync(dataFileOf(KEY), 'utf8'));
      raw = Array.isArray(v) ? v : (Array.isArray(v && v.jobs) ? v.jobs : []);
    } catch { raw = []; }
    let changed = false;
    list = raw.filter(j => j && typeof j.id === 'string' && j.id).slice(0, LIMIT).map(j => {
      const rec = {
        id: j.id,
        name: String(j.name || ''),
        out: j.out ? path.basename(String(j.out)) : null,
        state: String(j.state || ''),
        createdAt: Number(j.createdAt) || 0,
        updatedAt: Number(j.updatedAt) || 0,
        bytes: Number(j.bytes) || 0,
        width: Number(j.width) || 0,
        height: Number(j.height) || 0,
        audioOnly: !!j.audioOnly,
        err: String(j.err || ''),
      };
      if (ACTIVE.has(rec.state)) {
        rec.state = 'interrupted';
        rec.err = '代理重启时这一单还没跑完';
        changed = true;
      }
      return rec;
    });
    if (changed) write();
    return list;
  }

  /* 任务的每一次状态变化都落一次（queued / running / done / failed / cancelled）：
     每次都整表原子写，50 条 JSON 只有几 KB，不为此再维护一份增量日志。 */
  function record(job) {
    if (!job || !job.id) return;
    const l = load();
    const rec = {
      id: job.id,
      name: job.name || '成片',
      out: job.out ? path.basename(String(job.out)) : null,
      state: job.state || 'queued',
      createdAt: Number(job.createdAt || job.ts) || Date.now(),
      updatedAt: Date.now(),
      bytes: Number(job.size) || 0,
      width: Number(job.spec && job.spec.width) || 0,
      height: Number(job.spec && job.spec.height) || 0,
      audioOnly: !!(job.spec && job.spec.audioOnly),
      err: job.err ? String(job.err).slice(0, 500) : '',
    };
    const i = l.findIndex(x => x && x.id === rec.id);
    if (i >= 0) l[i] = rec;
    else {
      l.unshift(rec);
      if (l.length > LIMIT) l.length = LIMIT;
    }
    write();
  }

  function all() {
    return load().slice();
  }

  return { record, all, LIMIT };
}

module.exports = { createRenderJobsStore, RENDER_JOBS_LIMIT: LIMIT };
