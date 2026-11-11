#!/usr/bin/env node
/* 贴纸纯件判据（不开浏览器）：
   ① normalizeStickers：坏 src 整条丢、字段逐个夹取、id 缺省、z 排序；
   ② clampSticker：片长收紧（贴片 / 删镜后 t1 越界回夹）、t0<t1 保正；
   ③ activeAt：时间窗过滤 + z 升序稳定；
   ④ drawStickers：假 ctx 记录 drawImage / globalAlpha（一份画法预览与导出同视觉的前提）。 */
import assert from 'node:assert/strict';
import { normalizeStickers, clampSticker, activeAt, drawStickers } from '../web/director/sticker.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

/* ---- ① normalizeStickers ---- */
{
  const out = normalizeStickers([
    { name: '好', src: '/asset/la_abc', x: 2, y: -1, w: 0.001, h: 9, t0: 5, t1: 2, opacity: 7, z: 3 },
    { src: 'blob:https://x/y' },                       // blob: 刷新即失效 → 丢
    { src: '/getv?url=https://签名的图' },              // 签名外链一天 403 → 丢
    null, '字符串',                                      // 坏形状 → 丢
    { src: 'data:image/png;base64,AA' },                // 缺 id → 补缺省
  ]);
  ok(out.length === 2, 'blob: / 签名外链 / 坏形状整条丢，只剩两条：' + out.length);
  const good = out.find(x => x.name === '好');
  const noId = out.find(x => !x.name || x.name === '贴纸');
  ok(good && noId, '两条各归其位（按 z 排序后 data: 缺 id 的在前）');
  ok(good.x === 1.5 && good.y === -0.5, 'x / y 夹到 [-0.5, 1.5]：' + good.x + ',' + good.y);
  ok(good.w === 0.02 && good.h === 1.5, 'w / h 夹到 [0.02, 1.5]');
  ok(good.t0 === 5 && good.t1 === 5.1, 't1 < t0 时回夹成 t0 + 0.1');
  ok(good.opacity === 1, 'opacity 夹到 [0,1]（7 → 1）');
  ok(good.z === 3, 'z 原样保留');
  ok(String(noId.id).startsWith('stk-'), '缺 id 补缺省（序号派生）：' + noId.id);
  ok(out[0].z <= out[1].z, '按 z 升序出表');
  ok(normalizeStickers(null).length === 0 && normalizeStickers(undefined).length === 0, '空入参回空表');
}

/* ---- ② clampSticker：片长收紧 ---- */
{
  const s = clampSticker({ t0: 8, t1: 12, x: 0.1 }, 10);
  ok(s.t0 === 8 && s.t1 === 10, '片长 10s：t1 收回 10，t0 不动');
  const s2 = clampSticker({ t0: 9.98, t1: 12 }, 10);
  ok(s2.t1 > s2.t0 && s2.t1 <= 10.1, 't0 贴近片尾时仍保正跨度');
  const s3 = clampSticker({ t0: -2, t1: 0 }, 10);
  ok(s3.t0 === 0 && s3.t1 > s3.t0, '负起点回 0 且保正跨度');
  const s4 = clampSticker({ x: 0.3, y: 0.2, w: 0.25, h: 0.25, opacity: 0.5 }, 0);
  ok(s4.t0 === 0 && s4.t1 > 0, '空片（filmDur=0）只保正跨度不炸');
  ok(s4.x === 0.3 && s4.opacity === 0.5, '其余字段原样带过');
}

/* ---- ③ activeAt：时间窗 + z 序 ---- */
{
  const list = [
    { id: 'a', t0: 0, t1: 5, z: 2 },
    { id: 'b', t0: 2, t1: 6, z: 0 },
    { id: 'c', t0: 5.001, t1: 8, z: 1 },
  ];
  ok(activeAt(list, 3).map(s => s.id).join(',') === 'b,a', 't=3：窗内两张、z 升序（b 先画，a 叠上面）');
  ok(activeAt(list, 5).map(s => s.id).join(',') === 'b', 't=5：a 的窗左闭右开已出（c 未进）');
  ok(activeAt(list, 6).map(s => s.id).join(',') === 'c', 't=6：只剩 c');
  ok(activeAt(list, 99).length === 0 && activeAt(null, 0).length === 0, '窗外 / 空表回空');
}

/* ---- ④ drawStickers：假 ctx 记录 ---- */
{
  const calls = [];
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'drawImage') return (img, x, y, w, h) => calls.push(['draw', img, x, y, w, h]);
      if (k === 'save' || k === 'restore') return () => calls.push([k]);
      return () => {};
    },
    set() { return true; },
  });
  const imgOf = st => (st.id === 'a' ? { fake: 1 } : null);
  drawStickers(ctx, 1280, 720, [
    { id: 'a', x: 0.25, y: 0.1, w: 0.25, h: 0.25, opacity: 0.5, z: 0 },
    { id: 'b', x: 0, y: 0, w: 0.5, h: 0.5, opacity: 1, z: 1 },      // 字节不在 → 跳过
  ], imgOf);
  const draws = calls.filter(c => c[0] === 'draw');
  ok(draws.length === 1, '字节不在的那张跳过：' + calls.length);
  ok(draws[0][2] === 320 && draws[0][3] === 72 && draws[0][4] === 320 && draws[0][5] === 180,
    '归一化坐标按画幅换算：' + JSON.stringify(draws[0]));
  ok(draws[0][1].fake === 1, 'imgOf 给什么画什么（预览 img / 导出 bitmap 同口径）');
  ok(calls.some(c => c[0] === 'save') && calls.some(c => c[0] === 'restore'), 'save / restore 成对（不污染外层状态）');
}

console.log('✓ director-sticker：' + n + ' 项通过');
