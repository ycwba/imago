/* 时间线标记（纯件，无 DOM）—— 参考 timelineMarkers：
   四类（标记 / 章节 / 范围 / 便签）× 五色，钉在成片秒，**不随剪辑搬移**。
   模型、钟面格式、边缘吸附点只有这一份；film.js 的 normalizeFilm 也调这里。
   颜色不新开主题令牌：五色直接落到既有的语义色上（深浅两档都成对），
   见 MARKER_COLOR_VAR —— 新增一枚颜色只改这张表。 */

import { num, round2 } from './util.js';

export const MARKER_TYPES = Object.freeze(['marker', 'chapter', 'range', 'note']);
export const MARKER_COLORS = Object.freeze(['cyan', 'amber', 'violet', 'rose', 'green']);
export const MARKER_TYPE_ZH = Object.freeze({ marker: '标记', chapter: '章节', range: '范围', note: '便签' });
export const MARKER_COLOR_ZH = Object.freeze({ cyan: '青', amber: '琥珀', violet: '紫', rose: '玫红', green: '绿' });
export const MARKER_TYPE_ICON = Object.freeze({ marker: 'flag', chapter: 'chapter', range: 'ripple', note: 'note' });
export const MARKER_COLOR_VAR = Object.freeze({
  cyan: '--acc', amber: '--warn', violet: '--pri', rose: '--err', green: '--ok',
});
/* 四类的默认色（参考 markersAbsoluteHint 的默认表）：用户不改就落这一枚。 */
export const MARKER_DEFAULT_COLOR = Object.freeze({ marker: 'cyan', chapter: 'amber', range: 'violet', note: 'rose' });

let seq = 1;
/* 标记的 id 生成留在这里（film.js 反向 import 会成环）：形状与 filmId 同一族，前缀 mark-。 */
const markerId = () => `mark-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function createMarker(o = {}) {
  const type = MARKER_TYPES.includes(o.type) ? o.type : 'marker';
  const time = Math.max(0, round2(num(o.time)));
  const marker = {
    id: o.id || markerId(),
    type,
    time,
    title: String(o.title || ''),
    notes: String(o.notes || ''),
    color: MARKER_COLORS.includes(o.color) ? o.color : MARKER_DEFAULT_COLOR[type],
  };
  if (type === 'range') marker.endTime = Math.max(time + 0.001, round2(num(o.endTime, time + 1)));
  return marker;
}

export const normalizeMarkers = raw => (Array.isArray(raw) ? raw : [])
  .filter(m => m && typeof m === 'object')
  .map(m => createMarker(m));

/* 这一枚标记占的区间：范围有尾，其余是一点。 */
export function markerRangeOf(marker) {
  if (!marker) return { start: 0, end: 0 };
  const start = Math.max(0, num(marker.time));
  const end = marker.type === 'range' ? Math.max(start, num(marker.endTime, start)) : start;
  return { start, end };
}

/* 轨道要盖住的最右一秒（无标记为 0）：标记钉在成片秒、不随剪辑搬移，剪短之后可以留在成片末尾之外，
   导航总长不把它算进去，尺与行底色就画不到那一截。 */
export function markerSpanEnd(markers) {
  let end = 0;
  (Array.isArray(markers) ? markers : []).forEach(m => { if (m) end = Math.max(end, markerRangeOf(m).end); });
  return end;
}

/* 吸附点：每一枚的起边 + 范围的尾边（参考「标记边缘进吸附点」）。 */
export function markerSnapPoints(markers) {
  const out = [];
  (Array.isArray(markers) ? markers : []).forEach(m => {
    if (!m) return;
    out.push({ time: Math.max(0, num(m.time)), kind: 'marker', id: m.id });
    if (m.type === 'range') out.push({ time: Math.max(0, num(m.endTime, num(m.time))), kind: 'marker', id: m.id });
  });
  return out;
}

/* 钟面格式 HH:MM:SS.mmm —— 标记面板、拖动提示、导出说明共用这一份。 */
export function markerClock(value) {
  const s = Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const zero2 = v => String(v).padStart(2, '0');
  return `${zero2(h)}:${zero2(m)}:${zero2(sec)}.${String(ms).padStart(3, '0')}`;
}

/* 标记面板里那一行读数：「范围」写成起止，其余写一点。 */
export function markerTimeText(marker) {
  const r = markerRangeOf(marker);
  return marker && marker.type === 'range'
    ? markerClock(r.start) + ' – ' + markerClock(r.end)
    : markerClock(r.start);
}

/* 按类型分组的计数（工具条徽标、面板「共 N 个」用它）。 */
export function markerCounts(markers) {
  const out = { marker: 0, chapter: 0, range: 0, note: 0, total: 0 };
  (Array.isArray(markers) ? markers : []).forEach(m => {
    if (!m) return;
    out.total++;
    if (out[m.type] != null) out[m.type]++;
  });
  return out;
}

/* 按时间排序的副本（画轨道与「上一处 / 下一处」都按这个顺序，原数组不动）。 */
export const markersSorted = markers => (Array.isArray(markers) ? markers.slice() : [])
  .sort((a, b) => num(a && a.time) - num(b && b.time));
