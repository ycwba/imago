#!/usr/bin/env node
/* 把真机的收藏 / 本机资产账 / 平台画廊抽成稿子的内容层（design/favorites-layout/data.js）。
   这份脚本**只读**真机数据，一个字节都不写回 `.data/`。

   用法：node design/favorites-layout/dump-data.cjs

   抽出来的东西：
     · 本机条目  —— 名字、大小、格式、日期取自 `.data/local-assets/index.json`（真机账），
                     缩略图取自 `.data/cache/thumbs/`（真机缩略图缓存）。
     · 云端条目  —— 取自 `.data/sparkcine_gallery.json`（真机平台画廊），
                     图片经本机代理 `/asset/<id>` 取真字节，再用 ffmpeg 压成小图。
                     真机里那一条真收藏（白猫）也在里面。

   ⚠ 稿子里的**备注文案是编的**（真机那一条收藏的备注是空的）：
     备注这一栏得写点东西才看得出新版把它提到了主位，所以编了几句用途，
     它们单放在 `NOTES` 里，文件里标得清清楚楚。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const HERE = __dirname;
const ASSETS = path.join(HERE, 'assets');
const PORT = Number((fs.readFileSync(path.join(ROOT, '.proxy-port'), 'utf8').trim()) || 5175);

/* 演示用的备注文案（按类型轮着发）。真机里的备注基本是空的 ——
   新版把备注提到主位，空的那几行就是虚线占位。 */
const NOTE_TEXT = {
  图片: [
    '开场镜头的暖调参考',
    '便利店雨街的霓虹底子，要的那种湿漉漉的反射',
    '女主的过场：站在走廊尽头，灯只亮一半',
  ],
  视频: [
    '片尾镜头，节奏要慢，最后停在招牌上',
  ],
  音频: [
    '片头环境音，凌晨的街道',
  ],
};

const readJson = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const la = readJson('.data/local-assets/index.json');
const thumbs = readJson('.data/cache/thumbs/__index.json');
const gallery = readJson('.data/sparkcine_gallery.json').data;
const favs = readJson('.data/fav_items.json').data;

const thumbBy = new Map(thumbs.map(t => [t.key, t]));

/* ── 一、挑本机条目 ─────────────────────────────────────────────────────────
   挑法：名字有信息量的优先（这批真机产物是「深夜短片」那条线的场景图，
   名字本身就是提示词）；同一条线的连拍变体只留一张（不然十五张全是同一个便利店）。
   探针名（数字…／111…／语音-111）一律不算。 */
const PROBE = /探针|测试|未命名|^\d+$|111|数字十一|状态序列/i;

const scoreName = n => {
  const s = String(n || '');
  let v = Math.min(s.length, 26);
  if (/场景|空景|走廊|楼道|旧书店|雨|便利店|构图|无人物|空无一/.test(s)) v += 18;
  if (/(剧场|教室|天台|巷|街|招牌|屋顶|后巷|窗)/.test(s)) v += 10;
  if (PROBE.test(s)) v -= 200;
  if (/[-_]\d+\.\w+$/.test(s)) v -= 4;            // 连拍变体，稍微靠后
  return v;
};

/* 场景指纹：名字里出现的场景关键词，用来判「这两张是不是同一个场景」 */
const SCENE_WORDS = ['便利店', '旧书店', '走廊', '楼道', '教室', '天台', '雨', '巷', '街', '屋顶', '窗', '剧场', '车站', '桥', '操场'];
const sceneOf = n => {
  const s = String(n || '');
  return SCENE_WORDS.filter(w => s.includes(w)).join('|') || s.slice(0, 4);
};

const byType = { 图片: [], 视频: [], 音频: [] };
for (const a of la) {
  const t = a.media_type;
  if (!byType[t]) continue;
  if (PROBE.test(String(a.name || ''))) continue;
  byType[t].push({ a, sc: scoreName(a.name), scene: sceneOf(a.name) });
}
for (const t of Object.keys(byType)) byType[t].sort((x, y) => y.sc - x.sc);

/* 贪心挑：每个场景关键词最多留 2 张，避免十五张全是同一条线。 */
const want = { 图片: 9, 视频: 1, 音频: 2 };
const localItems = [];
for (const t of Object.keys(want)) {
  const sceneCount = new Map();
  for (const it of byType[t]) {
    if (localItems.filter(x => x.a.media_type === t).length >= want[t]) break;
    const c = sceneCount.get(it.scene) || 0;
    if (c >= 2) continue;
    sceneCount.set(it.scene, c + 1);
    localItems.push(it);
  }
}

/* ── 二、挑云端条目 ───────────────────────────────────────────────────────
   真机那一条真收藏（白猫）必进；再从平台画廊里挑两条**有画面感**的
   （画廊里大半是「111」「123」这种试跑提示词，挑不出来就别硬凑）。 */
const cloudItems = [];
for (const f of favs) {
  if (f.kind !== 'asset' || !f.assetId) continue;
  cloudItems.push({
    assetId: f.assetId,
    title: f.prompt || f.name || '一条收藏',
    provider: f.providerName || 'SparkCine',
    model: 'img-2-5t',
    credits: null,
    ts: f.ts,
    format: (f.format || 'png').toLowerCase(),
    kind: 'fav',
  });
}

const CLOUD_PICKS = [
  { match: '一只白猫坐在窗边', model: 'img-2-5s' },
  { match: '一只花猫趴在书上', model: 'img-2-5s' },
];
for (const p of CLOUD_PICKS) {
  const hit = gallery.find(g => String(g.prompt || '').trim() === p.match)
    || gallery.find(g => String(g.prompt || '').includes(p.match));
  if (!hit) continue;
  cloudItems.push({
    assetId: hit.asset_id,
    title: String(hit.prompt || '').trim().slice(0, 60),
    provider: 'SparkCine',
    model: hit.model,
    credits: hit.credits,
    ts: Date.parse(hit.ts),
    format: 'png',
    kind: 'gallery',
  });
}

/* ── 三、落图 ──────────────────────────────────────────────────────────────
   本机条目：缩略图缓存里那一份直接拷过来（本来就是 jpeg）。
   云端条目：经本机代理取真字节，再用 ffmpeg 压到最长边 720 的 jpeg。 */
fs.mkdirSync(ASSETS, { recursive: true });
/* 清掉上一轮的产物（挑选项变了就换一批图，留着旧件会让人以为数据乱了）。 */
for (const f of fs.readdirSync(ASSETS)) {
  if (/\.(jpg|jpeg|png)$/i.test(f)) fs.unlinkSync(path.join(ASSETS, f));
}

let cookie = '';
async function session() {
  if (cookie) return cookie;
  const r = await fetch(`http://127.0.0.1:${PORT}/`);
  const sc = r.headers.get('set-cookie') || '';
  cookie = (sc.split(';')[0] || '').trim();
  if (!cookie) throw new Error('代理没有下发会话 Cookie');
  return cookie;
}

async function fetchAsset(assetId) {
  const ck = await session();
  const r = await fetch(`http://127.0.0.1:${PORT}/asset/${assetId}`, { headers: { cookie: ck } });
  if (!r.ok) throw new Error('取字节失败 ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function shrink(buf, out) {
  const tmp = path.join(ASSETS, '_tmp_' + path.basename(out));
  fs.writeFileSync(tmp, buf);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp,
      '-vf', "scale='min(720,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
      '-q:v', '4', out], { stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 临时件，删不掉也不拦 */ }
  }
}

/* 缩略图缓存里的 .bin 存的是**数据 URI**（`data:image/jpeg;base64,……`），
   不是裸 JPEG —— 直接拷出来浏览器认不出来。这里解成裸字节。 */
function decodeDataUri(buf) {
  const s = buf.toString('utf8');
  const m = s.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!m) return { buf, mime: '' };
  return { buf: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8'), mime: m[1] || '' };
}

const fmtBytes = n => {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
};
const pad2 = n => String(n).padStart(2, '0');
const dateZh = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

(async () => {
  const items = [];

  /* 本机 */
  for (const it of localItems) {
    const a = it.a;
    const th = thumbBy.get('/asset/' + a.id);
    let thumb = '';
    if (th) {
      const src = path.join(ROOT, '.data/cache/thumbs', th.id + '.bin');
      if (fs.existsSync(src)) {
        const dec = decodeDataUri(fs.readFileSync(src));
        const ext = /png/i.test(dec.mime || th.type || '') ? 'png' : 'jpg';
        const out = path.join(ASSETS, a.id + '.' + ext);
        fs.writeFileSync(out, dec.buf);
        thumb = 'assets/' + a.id + '.' + ext;
      }
    }
    items.push({
      key: 'la:' + a.id,
      title: String(a.name || '').replace(/\.\w+$/, ''),
      type: a.media_type,
      format: a.format || '',
      size: fmtBytes(a.byte_length),
      bytes: a.byte_length,
      date: dateZh(Date.parse(a.created_at)),
      provider: '本机',
      model: a.model || '',
      duration: a.duration || null,
      state: 'local',
      thumb,
      note: '',
    });
  }

  /* 云端 */
  for (const c of cloudItems) {
    let thumb = '';
    try {
      const buf = await fetchAsset(c.assetId);
      const out = path.join(ASSETS, 'cloud_' + c.assetId + '.jpg');
      shrink(buf, out);
      thumb = 'assets/cloud_' + c.assetId + '.jpg';
    } catch (e) {
      console.log('  ! 云端取字节失败 ' + c.assetId + '：' + e.message);
    }
    items.push({
      key: 'a:' + c.provider.toLowerCase() + ':' + c.assetId,
      title: c.title,
      type: '图片',
      format: c.format,
      size: '',
      bytes: 0,
      date: dateZh(c.ts),
      provider: c.provider,
      model: c.model,
      duration: null,
      credits: c.credits,
      state: 'cloud',
      thumb,
      note: '',
    });
  }

  /* 排序：新的在前 */
  items.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));

  const counts = items.reduce((m, x) => (m[x.type] = (m[x.type] || 0) + 1, m), {});
  const localN = items.filter(x => x.state === 'local').length;
  const cloudN = items.filter(x => x.state === 'cloud').length;

  const out = `/* 收藏页布局稿的**内容层** —— 由 design/favorites-layout/dump-data.cjs 生成，别手改。
   来源：真机 .data/local-assets/index.json（本机资产账）、.data/cache/thumbs（缩略图缓存）、
   .data/sparkcine_gallery.json（平台画廊）、.data/fav_items.json（真收藏）。
   重新生成：node design/favorites-layout/dump-data.cjs

   ⚠ NOTES 是**稿子专用的演示文案**（真机那一条收藏的备注是空的）。
     其余字段（名字、大小、格式、日期、类型、来源、缩略图）都是真机取出来的。 */
window.FAV_DATA = ${JSON.stringify({ items, counts, localN, cloudN }, null, 2)};

/* 稿子专用的演示备注：写的是「这条收藏是干什么用的」。
   真机里的备注基本是空的 —— 新版把备注提到主位，
   所以稿子里**只有一部分**条目写了备注（其余留空，看虚线空位那一档）。 */
window.FAV_NOTES = {
${(() => {
  const seen = {};
  const rows = [];
  for (const x of items) {
    seen[x.type] = (seen[x.type] || 0) + 1;
    const total = items.filter(y => y.type === x.type).length;
    /* 每种类型里六成写备注、四成留空。 */
    const n = (seen[x.type] <= Math.ceil(total * 0.6)) && NOTE_TEXT[x.type]
      ? NOTE_TEXT[x.type][(seen[x.type] - 1) % NOTE_TEXT[x.type].length] : '';
    rows.push('  ' + JSON.stringify(x.key) + ': ' + JSON.stringify(n));
  }
  return rows.join(',\n');
})()}
};
`;

  fs.writeFileSync(path.join(HERE, 'data.js'), out, 'utf8');
  console.log('写入 data.js：' + items.length + ' 条（本机 ' + localN + ' / 云端 ' + cloudN + '）');
  console.log('类型分布：' + JSON.stringify(counts));
})().catch(e => { console.error(e); process.exit(1); });
