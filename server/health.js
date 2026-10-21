/* 代理故障账：有界计数 + 最近几条，只报不自杀；连接错误单独计数、不参与上色。
   由 proxy.js 注入 timeText，保持「三份读法同一句」的格式。 */
'use strict';

const FAULT_KEEP = 8;
const FAULT_KINDS = ['未捕获异常', 'Promise失败', '请求出错', '连接错误', '页面报错'];
const cut1 = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

function createHealth(opts = {}) {
  const timeText = opts.timeText || (d => d.toISOString());
  const faultCount = {}; FAULT_KINDS.forEach(k => { faultCount[k] = 0; });
  const faultList = [];
  let lastFaultAt = 0, lastWorkAt = 0, lastWorkPath = '';

  function faultMsg(e) {
    if (!e) return '（没给原因）';
    if (typeof e === 'string') return e;
    return e.message || String((e && (e.code || e.errno)) || '');
  }
  function faultAt(e) {
    const lines = String((e && e.stack) || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/^at\s/.test(l)) return cut1(l.replace(/^at\s+/, ''), 160);
    }
    return '';
  }
  function noteFault(kind, e, extra) {
    faultCount[kind] = (faultCount[kind] || 0) + 1;
    lastFaultAt = Date.now();
    const msg = cut1(faultMsg(e) || (extra || ''), 200) || '（没给原因）';
    const at = cut1(faultAt(e), 160);
    const head = faultList[0];
    if (head && head.种类 === kind && head.消息 === msg && head.位置 === at) { head.重复++; head.at = lastFaultAt; return; }
    faultList.unshift({ at: lastFaultAt, 种类: kind, 消息: msg, 位置: at, 重复: 1 });
    if (faultList.length > FAULT_KEEP) faultList.length = FAULT_KEEP;
  }
  function noteWork(p) {
    if (p === '/sys-status') return;
    lastWorkAt = Date.now(); lastWorkPath = cut1(p || '', 60);
  }
  function agoShort(ts) {
    if (!ts) return '没有';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }
  function durShort(sec) {
    let s = Math.max(0, Math.round(sec));
    const parts = [[86400, '天'], [3600, '小时'], [60, '分']];
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const n = Math.floor(s / parts[i][0]);
      if (n) { out.push(n + ' ' + parts[i][1]); s -= n * parts[i][0]; }
    }
    if (!out.length) return s + ' 秒';
    return out.slice(0, 2).join(' ');
  }
  function healthStatus() {
    const nErr = faultCount['未捕获异常'] || 0, nRej = faultCount['Promise失败'] || 0;
    const nReq = faultCount['请求出错'] || 0, nSock = faultCount['连接错误'] || 0;
    const nPage = faultCount['页面报错'] || 0;
    let chip, cls, say;
    if (nErr) {
      const h = faultList.filter(x => x.种类 === '未捕获异常')[0];
      chip = '出过 ' + nErr + ' 次'; cls = 'err';
      say = '这个代理起过 ' + nErr + ' 次未捕获异常，按设计没有退出（本地工具不该因为一次异常打断使用），'
        + '但状态可能已经不完整' + (h ? '：最近一次 ' + agoShort(h.at) + '，' + h.消息 + (h.位置 ? '（' + h.位置 + '）' : '') : '')
        + '。要清掉这份账、把状态换回干净的一份，只有一条路：在启动器点「重启」。';
    } else if (nRej || nReq || nPage) {
      const bits = [];
      if (nRej) bits.push(nRej + ' 次没被 catch 的 Promise 失败');
      if (nReq) bits.push(nReq + ' 次请求处理里抛出的错');
      /* 页面自己报上来的那一句（web/core/report.js → POST /client-error）：
         它不影响代理干活，但「打开就是空的」这类事以前在代理这边完全无痕。 */
      if (nPage) bits.push(nPage + ' 次页面报错（boot 失败 / 未处理异常）');
      const h = faultList.filter(x => x.种类 === 'Promise失败' || x.种类 === '请求出错' || x.种类 === '页面报错')[0];
      chip = (nRej ? 'Promise 失败 ' + nRej + ' 次' : '') + (nRej && nReq ? ' · ' : '') + (nReq ? '请求抛错 ' + nReq + ' 次' : '')
        + ((nRej || nReq) && nPage ? ' · ' : '') + (nPage ? '页面报错 ' + nPage + ' 次' : '');
      cls = 'warn';
      say = '没有未捕获异常，但有 ' + bits.join('、')
        + (h ? '：最近一次 ' + agoShort(h.at) + '，' + h.消息 + (h.位置 ? '（' + h.位置 + '）' : '') : '') + '。'
        + '前者多半是一次外部请求或读盘没接住，后者那一句页面通常已经当场报过；不影响继续用，'
        + '但反复出现同一句就在启动器点「重启」，并把那一句抄给助手。';
    } else {
      chip = '正常'; cls = 'ok';
      say = nSock ? ('没有异常记录。另有 ' + nSock + ' 次连接错误 —— 浏览器提前断开或上游掐掉连接，正常现象，不算故障。')
        : '没有异常记录。';
    }
    return {
      档: cls, 芯片: chip, 说明: say,
      存活: durShort(process.uptime()),
      起于: timeText(new Date(Date.now() - process.uptime() * 1000)),
      未捕获异常: nErr, 'Promise失败': nRej, '请求出错': nReq, 连接错误: nSock, 页面报错: nPage,
      最近: faultList.map(x => ({ at: x.at, 时候: timeText(new Date(x.at)), 种类: x.种类, 消息: x.消息, 位置: x.位置, 重复: x.重复 })),
      最后请求: lastWorkAt ? (agoShort(lastWorkAt) + (lastWorkPath ? ' · ' + lastWorkPath : '')) : '还没有过（除体检外）',
      保留: '最近 ' + FAULT_KEEP + ' 条，重启后清零',
    };
  }
  return { noteFault, noteWork, healthStatus, faultCount, faultList, FAULT_KINDS };
}

module.exports = { createHealth, FAULT_KINDS };
