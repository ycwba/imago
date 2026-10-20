/* FCPXML 导入：把 Final Cut Pro / 达芬奇导出的 XML 读成导演台工程（纯数据，不碰 DOM/全局状态）。
   读的是「时间线本身」：spine 上的 asset-clip / gap、它们的 start·duration·timeMap、
   挂在画面上的配音 asset-clip 与 title。素材地址按三种写法认回本机：
     · /asset/la_xxx             → 本机资产
     · file:///…/la_xxx.mp4      → 本机资产（导出时写的是 assets 目录里的文件名）
     · https://…                 → 保留外链，导入后由页面自动存一份到本机
   媒体包里的 media/<name> 与任意别的本机路径认不回来：保留这一段的时间与入出点，
   把「哪几段没找到文件」原样报出去（不许静默丢段）。 */
import { round1 } from './util.js';

const clampSpd = v => Math.max(0.25, Math.min(4, Number(v) || 1));
const kids = (el, tag) => {
  const out = [];
  if (!el || !el.childNodes) return out;
  const want = String(tag).toLowerCase();   // localName 保留大小写：timeMap ≠ timemap
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === 1 && String(c.localName || c.nodeName).toLowerCase() === want) out.push(c);
  }
  return out;
};
const firstKid = (el, tag) => kids(el, tag)[0] || null;

function parseTime(v, fr) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let m = /^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)s$/.exec(s);
  if (m) return Number(m[1]) / Number(m[2]);
  m = /^(-?\d+(?:\.\d+)?)s$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(-)?(\d+):(\d+):(\d+)[:;.,](\d+)$/.exec(s);
  if (m) return (m[1] ? -1 : 1) * ((+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) + (+m[5]) / (Number(fr) || 30));
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* timeMap 的最后一个 timept 是「这一段在源里有多长」（导出写法是 0s → srcDur）。 */
function mapSrcDur(el, fallback) {
  const map = firstKid(el, 'timeMap');
  if (!map) return fallback;
  const pts = kids(map, 'timept');
  if (!pts.length) return fallback;
  const first = parseTime(pts[0].getAttribute('value'), 30) || 0;
  const last = parseTime(pts[pts.length - 1].getAttribute('value'), 30);
  if (last == null) return fallback;
  const span = last - first;
  return span > 0.05 ? span : fallback;
}

/* `<media-rep src>` 的三种可认写法 → 页面能取的地址。认不出时 url 为空、写清原因。 */
function resolveSrc(raw) {
  const s = String(raw || '').trim();
  if (!s) return { url: '', local: false, why: '没有 media-rep src' };
  let m = /\/asset\/([A-Za-z0-9_-]+)/.exec(s);
  if (m) return { url: window.Api.assetSrc(m[1]), local: /^la_/.test(m[1]), why: '' };
  if (/^file:/i.test(s)) {
    let p = s.replace(/^file:\/\//i, '');
    try { p = decodeURIComponent(p); } catch (e) {}
    m = /(?:^|[\/\\])(la_[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]+)?$/i.exec(p);
    if (m) return { url: window.Api.assetSrc(m[1]), local: true, why: '' };
    return { url: '', local: false, why: '本机路径不在资产库里：' + p };
  }
  if (/^https?:\/\//i.test(s)) return { url: s, local: false, why: '' };
  if (/^media\//i.test(s)) return { url: '', local: false, why: '媒体包里的相对路径（' + s + '）' };
  return { url: s, local: false, why: '' };
}

const textOfTitle = el => {
  const text = firstKid(el, 'text');
  if (!text) return '';
  const style = firstKid(text, 'text-style');
  return String((style || text).textContent || '').replace(/\s+/g, ' ').trim();
};

const arOf = (w, h) => {
  const r = Number(w) / Math.max(1, Number(h));
  const hits = [[16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 3, '4:3']];
  const hit = hits.find(x => Math.abs(x[0] - r) < 0.02);
  return hit ? hit[1] : '16:9';
};

export function parseFCPXML(text, opts = {}) {
  const DP = opts.DOMParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!DP) return { ok: false, why: '当前环境没有 XML 解析器（DOMParser）' };
  const doc = new DP().parseFromString(String(text == null ? '' : text), 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) return { ok: false, why: '不是合法的 XML：' + String(err.textContent || '').trim().slice(0, 160) };
  const root = doc.documentElement;
  if (!root || String(root.localName || root.nodeName).toLowerCase() !== 'fcpxml') {
    return { ok: false, why: '不是 FCPXML：根节点是 <' + String((root && (root.nodeName || root.tagName)) || '空') + '>' };
  }
  const seq = doc.getElementsByTagName('sequence')[0];
  const spine = seq ? firstKid(seq, 'spine') : null;
  if (!spine) return { ok: false, why: '这份 FCPXML 里没有 <sequence><spine>，读不出时间线' };

  const resources = doc.getElementsByTagName('resources')[0] || root;
  const assets = {};
  kids(resources, 'asset').forEach(a => {
    const id = a.getAttribute('id') || '';
    if (!id) return;
    const rep = firstKid(a, 'media-rep');
    assets[id] = {
      name: a.getAttribute('name') || '',
      duration: parseTime(a.getAttribute('duration'), 30) || 0,
      src: rep ? rep.getAttribute('src') : '',
    };
  });
  const formats = {};
  kids(resources, 'format').forEach(f => {
    formats[f.getAttribute('id') || ''] = {
      w: Number(f.getAttribute('width')) || 0,
      h: Number(f.getAttribute('height')) || 0,
      fr: parseTime(f.getAttribute('frameDuration'), 30) ? 1 / parseTime(f.getAttribute('frameDuration'), 30) : 30,
    };
  });
  const fmtRef = (seq && seq.getAttribute('format')) || '';
  const fmt = formats[fmtRef] || {};
  const fr = fmt.fr || 30;
  const uid = typeof opts.uid === 'function' ? opts.uid : (() => 'fcp' + Math.random().toString(36).slice(2, 9));

  const warnings = [];
  const stats = { clips: 0, gaps: 0, voices: 0, titles: 0, remote: 0, local: 0, unresolved: 0 };
  const shots = [];
  const voices = [];

  const pushGap = (dur, name) => {
    const d = Math.max(0.1, round1(dur));
    const cand = {
      vid: 'fcpgap_' + uid(), provider: 'local', status: 'succeeded', progress: 100,
      url: '', local: true, locked: false, trimS: 0, trimE: d, priceMicros: null,
      duration: d, error: null, name: name || '黑场',
      segs: [{ in: 0, out: d, a: 0, b: d, off: 1 }],
    };
    shots.push({
      id: uid(), name: name || '黑场', prompt: '', ar: '16:9', res: '768p', tier: 'fast', draw: 1,
      firstFrame: null, lastFrame: null, refImages: [], refVideo: null, refAudio: null, keyframes: [],
      candidates: [cand], selId: cand.vid, combo: '', line: '', lineWho: '',
      note: 'FCPXML 导入的空档（gap）',
    });
    stats.gaps++;
  };

  const clipOf = el => {
    const refId = el.getAttribute('ref') || '';
    const a = assets[refId] || {};
    const start = Math.max(0, parseTime(el.getAttribute('start'), fr) || 0);
    const dur = Math.max(0.1, parseTime(el.getAttribute('duration'), fr) || 0.1);
    const srcDur = Math.max(0.1, mapSrcDur(el, dur));
    const spd = clampSpd(srcDur / dur);
    const res = resolveSrc(a.src);
    if (res.url && /^https?:/i.test(res.url)) stats.remote++;
    else if (res.url) stats.local++;
    if (!res.url) {
      stats.unresolved++;
      warnings.push((el.getAttribute('name') || a.name || '一段画面') + '：' + (res.why || '找不到素材地址'));
    }
    const cand = {
      vid: 'fcp_' + uid(), provider: /^https?:/i.test(res.url) ? 'remote' : 'local',
      status: 'succeeded', progress: 100, url: res.url, local: res.local, locked: false,
      trimS: start, trimE: round1(start + srcDur), priceMicros: null,
      duration: Math.max(a.duration || 0, round1(start + srcDur), dur),
      error: null, name: el.getAttribute('name') || a.name || '',
      segs: [{ in: round1(start), out: round1(start + srcDur), a: round1(start), b: round1(start + srcDur), spd: spd !== 1 ? spd : undefined }],
    };
    if (!cand.segs[0].spd) delete cand.segs[0].spd;
    const sh = {
      id: uid(), name: el.getAttribute('name') || a.name || ('镜头 ' + (shots.length + 1)),
      prompt: '', ar: arOf(fmt.w || 16, fmt.h || 9), res: '768p', tier: 'fast', draw: 1,
      firstFrame: null, lastFrame: null, refImages: [], refVideo: null, refAudio: null, keyframes: [],
      candidates: [cand], selId: cand.vid, combo: '', line: '', lineWho: '', note: 'FCPXML 导入',
    };
    /* 挂在这一段上的配音：offset 是相对这一格的成片秒，start 是源里的入点，
       timeMap 的末值 = 这一句在源里有多长。数据层要源秒，所以 at = offset × 画面倍速。 */
    kids(el, 'asset-clip').forEach(vEl => {
      const vr = resolveSrc((assets[vEl.getAttribute('ref') || ''] || {}).src);
      const vOffset = Math.max(0, parseTime(vEl.getAttribute('offset'), fr) || 0);
      const vTimeline = Math.max(0.05, parseTime(vEl.getAttribute('duration'), fr) || 0.05);
      const vStart = Math.max(0, parseTime(vEl.getAttribute('start'), fr) || 0);
      const vSrcDur = Math.max(0.05, mapSrcDur(vEl, vTimeline));
      const vSpd = clampSpd((vSrcDur / vTimeline) / spd);
      if (!vr.url) {
        stats.unresolved++;
        warnings.push((vEl.getAttribute('name') || '一句配音') + '：' + (vr.why || '找不到音频地址'));
      }
      voices.push({
        id: uid(), shotId: sh.id, candId: cand.vid, seg: 0,
        at: round1(vOffset * spd), dur: round1(vSrcDur), vol: 1,
        src: vr.url, name: vEl.getAttribute('name') || '配音', text: vEl.getAttribute('name') || '',
        provider: /^https?:/i.test(vr.url) ? 'remote' : 'local', model: '', voice: '',
        off: round1(vStart), ...(Math.abs(vSpd - 1) > 0.001 ? { spd: vSpd } : {}),
      });
      stats.voices++;
    });
    /* 字幕：同一段的几条 title 拼成这一镜的台词（换行保留）。 */
    const texts = kids(el, 'title').map(textOfTitle).filter(Boolean);
    if (texts.length) { sh.line = texts.join('\n'); stats.titles += texts.length; }
    shots.push(sh);
    stats.clips++;
    return { dur, spd };
  };

  let at = 0;
  for (const el of Array.from(spine.childNodes || [])) {
    if (!el || el.nodeType !== 1) continue;
    const tag = String(el.localName || el.nodeName).toLowerCase();
    if (tag === 'transition') continue;
    const offset = parseTime(el.getAttribute('offset'), fr);
    if (offset != null && offset > at + 1e-3) { pushGap(offset - at, '空档'); at = offset; }
    const dur = Math.max(0.1, parseTime(el.getAttribute('duration'), fr) || 0);
    if (tag === 'gap') {
      pushGap(dur || 0.1, el.getAttribute('name') || '黑场');
      at += dur || 0.1;
      continue;
    }
    if (tag === 'asset-clip' || tag === 'clip' || tag === 'ref-clip' || tag === 'mc-clip') {
      const got = clipOf(el);
      at += got.dur;
      continue;
    }
    if (tag === 'title') {
      /* 直接挂在 spine 上的字幕没有画面可挂：折成一段同长的黑场，把字写在台词里。 */
      const d = Math.max(0.1, dur);
      pushGap(d, '字幕');
      const last = shots[shots.length - 1];
      const t = textOfTitle(el);
      if (t && last) { last.line = t; stats.titles++; }
      at += d;
    }
  }

  const projectName = (doc.getElementsByTagName('project')[0] || {}).getAttribute
    ? ((doc.getElementsByTagName('project')[0].getAttribute('name')) || '')
    : '';
  const eventName = (doc.getElementsByTagName('event')[0] || {}).getAttribute
    ? ((doc.getElementsByTagName('event')[0].getAttribute('name')) || '')
    : '';
  /* 工程名以 XML 里的 <project / <event 为准（那是剪辑软件里真正的项目名），文件名只作兜底。 */
  const name = String(projectName || eventName || opts.name || 'FCPXML 导入').replace(/\.[^.]+$/, '').slice(0, 60);
  const project = {
    id: uid(), name,
    scenes: [{ id: uid(), name: 'FCPXML 导入', shots }],
  };
  if (fmt.w >= 64 && fmt.h >= 64) project.composition = { width: Math.round(fmt.w), height: Math.round(fmt.h) };
  return { ok: true, project, voices, stats, warnings, width: fmt.w || 0, height: fmt.h || 0 };
}
