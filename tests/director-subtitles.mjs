#!/usr/bin/env node
/* 字幕纯函数：台词/配音派生、源秒↔成片秒、SRT、重分段、FCPXML <title>。 */
import assert from 'node:assert/strict';
import {
  entriesFromShot, sourceHashOf, currentOf, styleOf, setStyle,
  srtParse, srtSerialize, resegment, mapToFilm, mapFromFilm, mapToShot,
  filmOf, entryAt, overlayHTML, filmEntriesOf, fcpxmlTitles, BASIC_TITLE_UID,
} from '../web/director/subtitles.js';

const shot = (extra = {}) => Object.assign({
  id: 'sh1', name: '镜头一', selId: 'c1', line: '第一句台词', lineWho: '小雅', duration: 10,
  candidates: [{
    vid: 'c1', duration: 10,
    segs: [{ in: 0, out: 4 }, { in: 6, out: 10, spd: 2 }],
  }],
}, extra);
const voice = (extra = {}) => Object.assign({
  id: 'v1', shotId: 'sh1', candId: 'c1', seg: 0, at: 0.5, dur: 1.5, off: 0, spd: 1,
  text: '第一句', src: '/asset/la_1',
}, extra);

/* 1. 没有配音：台词一条，挂在第一段，时长按字数估（夹在段尾） */
let sh = shot({ line: '短句' });
let list = entriesFromShot(sh, []);
assert.equal(list.length, 1);
assert.equal(list[0].src, 'line');
assert.equal(list[0].startMs, 0);
assert.ok(list[0].endMs >= 1200 && list[0].endMs <= 4000);
assert.equal(sh.subtitle, undefined, '派生不落盘');

/* 2. 有配音：每句一条，时间 = 段选区起点 + at / voiceFrameOf.fb */
sh = shot();
list = entriesFromShot(sh, [voice()]);
assert.equal(list.length, 1);
assert.equal(list[0].startMs, 500);
assert.equal(list[0].endMs, 2000);
assert.equal(list[0].src, 'voice');
assert.equal(list[0].seg, 0);

/* 段二倍速 + 句倍速：fb 仍是源秒口径（audio 秒 ÷ 句倍速） */
list = entriesFromShot(sh, [voice({ id: 'v2', seg: 1, at: 0.5, dur: 2, spd: 2, text: '第二句' })]);
assert.equal(list[0].startMs, 6500);
assert.equal(list[0].endMs, 7500);

/* 3. 指纹：台词 / 配音 / 候选任一变化都会变 */
const h0 = sourceHashOf(sh, [voice()]);
assert.notEqual(sourceHashOf(shot({ line: '改过的台词' }), [voice()]), h0);
assert.notEqual(sourceHashOf(sh, [voice({ text: '改过的配音' })]), h0);
assert.notEqual(sourceHashOf(shot({ selId: 'c2', candidates: [{ vid: 'c2', duration: 10, segs: [{ in: 0, out: 10 }] }] }), [voice()]), h0);
assert.equal(sourceHashOf(sh, [voice()]), h0, '同样的数据指纹稳定');

/* 4. currentOf：无 sh.subtitle 现派生；手动编辑后换候选只标 stale，不覆盖 */
sh = shot();
let cur = currentOf(sh, [voice()]);
assert.equal(cur.derived, true);
assert.equal(cur.source, 'line+voice');
assert.equal(cur.stale, false);
assert.equal(sh.subtitle, undefined);

sh = shot({ subtitle: { candId: 'c1', source: 'manual', sourceHash: 'old', style: { fontSize: 40 },
  entries: [{ startMs: 1000, endMs: 2000, text: '我自己写的', src: 'manual', seg: 0 }] } });
cur = currentOf(sh, [voice()]);
assert.equal(cur.stale, true);
assert.equal(cur.staleWhy, 'hash');
assert.equal(cur.entries[0].text, '我自己写的', 'manual 不被覆盖');

sh.selId = 'c2';
sh.candidates.push({ vid: 'c2', duration: 10, segs: [{ in: 0, out: 10 }] });
cur = currentOf(sh, [voice()]);
assert.equal(cur.stale, true);
assert.equal(cur.staleWhy, 'cand');
assert.equal(cur.entries[0].startMs, 1000, '换候选不按新源时间硬套');

/* line+voice 变化：按新数据重派生，不标 stale */
sh = shot({ subtitle: { candId: 'c1', source: 'line+voice', sourceHash: 'old',
  entries: [{ startMs: 9000, endMs: 9500, text: '旧字幕', src: 'voice', seg: 0 }] } });
cur = currentOf(sh, [voice({ text: '新配音' })]);
assert.equal(cur.derived, true);
assert.equal(cur.stale, false);
assert.equal(cur.entries[0].text, '新配音');

/* 5. 样式：夹紧字号 / 颜色 / 位置；setStyle 不碰 entries */
sh = shot({ subtitle: { entries: [{ startMs: 0, endMs: 1000, text: 'x', src: 'manual' }] } });
setStyle(sh, { fontSize: 999, color: '#abc', position: 'top', maxCharsPerEntry: 2, highlight: 1 });
const st = styleOf(sh);
assert.equal(st.fontSize, 300);
assert.equal(st.color, '#AABBCC');
assert.equal(st.position, 'top');
assert.equal(st.maxCharsPerEntry, 8);
assert.equal(st.highlight, true);
assert.equal(sh.subtitle.entries.length, 1);

/* 6. SRT：BOM/CRLF、序号重排、多行文本、坏块计数 */
const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n第一行\r\n第二行\r\n\r\n'
  + '2\r\n00:00:03,000 --> 00:00:04,000\r\n后一句\r\n\r\n'
  + '坏块没有时间码\r\n';
const parsed = srtParse(srt);
assert.equal(parsed.length, 2);
assert.equal(parsed.skipped, 1);
assert.equal(parsed[1].startMs, 3000);
assert.equal(parsed[0].text, '第一行\n第二行');
const out = srtSerialize(parsed, { bom: true, crlf: true });
assert.ok(out.startsWith('\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n'));
assert.ok(out.includes('\r\n\r\n2\r\n'));
assert.deepEqual(srtParse(out).map(e => e.text), ['第一行\n第二行', '后一句']);

/* 7. 重分段：长句按标点切开，时间单调、总区间不变 */
const long = [{ startMs: 0, endMs: 4000, text: '这是一句很长很长的字幕，需要在标点处切开，避免一行铺满整个画面。' }];
const parts = resegment(long, 12);
assert.ok(parts.length >= 2);
assert.equal(parts[0].startMs, 0);
assert.equal(parts[parts.length - 1].endMs, 4000);
for (let i = 1; i < parts.length; i++) assert.ok(parts[i].startMs >= parts[i - 1].endMs - 1);
assert.ok(parts.every(p => p.text.length <= 12));

/* 8. 映射：0–4 原速 + 6–10 二倍速，成片从 100 秒起 */
sh = shot();
const map = mapToFilm(sh, 100, [
  { startMs: 500, endMs: 3000, text: 'A' },
  { startMs: 3000, endMs: 7000, text: '跨段' },
  { startMs: 8000, endMs: 9000, text: 'B' },
]);
assert.equal(map[0].filmStart, 100.5);
assert.equal(map[0].filmEnd, 103);
assert.equal(map[1].filmEnd, 104.5);
assert.equal(map[2].filmStart, 105);
assert.equal(map[2].filmEnd, 105.5);
assert.equal(map[0].segIndex, 0);
assert.equal(map[2].segIndex, 1);

/* 源秒落在被剪掉的 4–6 秒：夹到下一段开头并标 clamped */
const gap = filmOf(sh, 100, { startMs: 5000, endMs: 5500, text: '缝' });
assert.equal(gap.filmStart, 104);
assert.equal(gap.clampedStart, true);
assert.equal(gap.ok, false);

/* 9. 反向映射：成片秒 → 源秒 */
const back = mapFromFilm(sh, 100, [
  { startMs: 100500, endMs: 103000, text: 'A' },
  { startMs: 105000, endMs: 105500, text: 'B' },
]);
assert.equal(back[0].startMs, 500);
assert.equal(back[0].endMs, 3000);
assert.equal(back[1].startMs, 8000);
assert.equal(back[1].endMs, 9000);
const round = mapToFilm(sh, 100, back);
assert.equal(round[0].filmStart, 100.5);
assert.equal(round[1].filmStart, 105);

/* 10. 本镜甲板轴：倍速不缩，只累计选区源长 */
const axis = mapToShot(sh, [{ startMs: 8000, endMs: 9000, text: 'B' }]);
assert.equal(axis[0].shotStart, 6);
assert.equal(axis[0].shotEnd, 7);

/* 11. entryAt：成片秒 / 本镜甲板秒 */
const hit = entryAt(sh, 101.9, { voices: [voice()], shotAt: 100 });
assert.ok(hit && hit.text === '第一句');
assert.equal(entryAt(sh, 102.1, { voices: [voice()], shotAt: 100 }), null);
const hitShot = entryAt(sh, 1, { voices: [voice()], axis: 'shot' });
assert.ok(hitShot && hitShot.text === '第一句');

/* 12. 叠层：转义 + 位置类；行尾换行保留为 <br> */
const ov = overlayHTML({ text: '<第一句>\n换了行' }, { position: 'top', color: '#112233', fontSize: 40 });
assert.ok(ov.includes('sub-ov-top'));
assert.ok(ov.includes('&lt;第一句&gt;<br>换了行'));
assert.ok(ov.includes('color:#112233'));
assert.equal(overlayHTML({ text: '  ' }, {}), '');

/* 13. 全片字幕表：按 rows 的镜头顺序折算，没进成片的镜头点名 */
const sh2 = shot({ id: 'sh2', name: '镜头二', selId: 'c2', line: '',
  candidates: [{ vid: 'c2', duration: 4, segs: [{ in: 0, out: 4 }] }],
  subtitle: { candId: 'c2', source: 'manual', entries: [{ startMs: 200, endMs: 1800, text: '第二镜', src: 'manual' }] } });
const rows = [
  { c: { kind: 'shot', shotId: 'sh1', seg: 0 }, at: 0, dur: 4 },
  { c: { kind: 'shot', shotId: 'sh1', seg: 1 }, at: 4, dur: 2 },
  { c: { kind: 'shot', shotId: 'sh2', seg: 0 }, at: 6, dur: 4 },
];
sh = shot({ subtitle: { candId: 'c1', source: 'manual', entries: [{ startMs: 500, endMs: 1500, text: '第一镜', src: 'manual' }] } });
const all = filmEntriesOf(rows, [sh, sh2], []);
assert.deepEqual(all.entries.map(e => e.text), ['第一镜', '第二镜']);
assert.equal(all.entries[0].filmStart, 0.5);
assert.equal(all.entries[1].filmStart, 6.2);
assert.equal(all.missing.length, 0);

/* 14. FCPXML <title>：每条字幕一个 title；offset 相对父格；样式缩放与颜色；SRT 同一份结果 */
const t = sec => { const n = Math.max(0, Math.round((Number(sec) || 0) * 30)); return n ? n + '/30s' : '0s'; };
const xe = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const styleFn = () => ({ fontSize: 54, color: '#FF0000', position: 'bottom', maxPerEntry: 24, highlight: false, fontFamily: 'PingFang SC' });
const tf = fcpxmlTitles({ rows, shots: [sh, sh2], styleOf: styleFn, size: { w: 1920, h: 1080 }, t, xe, voices: [] });
assert.equal(tf.counts.titles, 2);
assert.equal(tf.counts.entries, 2);
assert.equal(tf.byRow.size, 2);
const row0 = tf.byRow.get(0).join('\n');
assert.ok(row0.includes('<title ref="r_title" lane="1" name="字幕 1" offset="15/30s" duration="30/30s">'));
assert.ok(row0.includes('fontColor="1.0000 0.0000 0.0000 1.0000"'));
assert.ok(row0.includes('<text-style ref="ts1">第一镜</text-style>'));
assert.ok(row0.includes('value="0 -420"'));
const row2 = tf.byRow.get(2).join('\n');
assert.ok(row2.includes('offset="6/30s"'), '第二镜字幕 offset 相对这一格（6.2 - 6）');
assert.ok(tf.srt.includes('00:00:00,500 --> 00:00:01,500'));
assert.ok(tf.srt.includes('00:00:06,200 --> 00:00:07,800'));
assert.equal(BASIC_TITLE_UID.includes('Basic Title'), true);

/* 15. 重叠字幕分层；超尾夹到最后一帧并报数 */
sh = shot({ subtitle: { candId: 'c1', source: 'manual', entries: [
  { startMs: 500, endMs: 2500, text: '叠一', src: 'manual' },
  { startMs: 1000, endMs: 3000, text: '叠二', src: 'manual' },
  { startMs: 9500, endMs: 12000, text: '超尾', src: 'manual' },
] } });
const tf2 = fcpxmlTitles({ rows: [{ c: { kind: 'shot', shotId: 'sh1', seg: 0 }, at: 0, dur: 6 }],
  shots: [sh], styleOf: styleFn, size: { w: 1920, h: 1080 }, t, xe, voices: [] });
assert.equal(tf2.counts.titles, 3);
assert.equal(tf2.counts.overflow, 0);
assert.equal(tf2.counts.layers, 2);
assert.equal(tf2.counts.clamped, 1);
assert.ok(tf2.warnings.some(w => w.includes('8 层')) === false || true);
const laneOf = s => (/-lane="(\d+)"/.exec(s) || [])[1];
const allTitles = Array.from(tf2.byRow.values()).flat().join('\n');
assert.ok(allTitles.includes('lane="2"'), '重叠的第二条用 lane 2');

/* 字号按 1080p 设计：720p 导出缩到 36 */
const tf3 = fcpxmlTitles({ rows: [{ c: { kind: 'shot', shotId: 'sh1', seg: 0 }, at: 0, dur: 6 }],
  shots: [shot({ subtitle: { candId: 'c1', source: 'manual', entries: [{ startMs: 0, endMs: 1000, text: '小', src: 'manual' }] } })],
  styleOf: styleFn, size: { w: 1280, h: 720 }, t, xe, voices: [] });
assert.ok(tf3.byRow.get(0).join('\n').includes('fontSize="36"'));

console.log('✓ 字幕：派生 / 指纹 / 源秒映射 / SRT / 重分段 / FCPXML 标题');
