/* 配音轨的行分配 —— 纯算法：不碰 DOM、不碰工程状态，配音对象的字段一个都不改写，只动 `ln`。
   三件事共用这一份：
     · 分轨：分组键三级兜底 —— 谁在说（`who`）→ 用的哪个音色（`voice`）→ 音频本身的素材身份（`src` 剥签名后）。
       第三级的剥签名只在调用方做（这里收 `srcKeyOf`）：同一段音频换了签名仍是同一个 key，换了角色不会合并。
     · 合轨：全部回到第 0 行。
     · 新句落行：目标时间窗内没被占的行里取行号最小的；全被占就新开一行，到上限照实报 `lanefull`。
   行号分配只落在 [0, maxRows-1]；超出上限的组单独报出来（`overflow`），不静默夹到最下面一行。 */

const KEY_PREFIX = /^(who|voice|src):/;

/* 三级兜底。空串不占键：没写说话人就看音色，没写音色才看素材地址。 */
export function defaultKeyOf(v, srcKeyOf) {
  const who = String((v && v.who) || '').trim();
  if (who) return 'who:' + who;
  const voice = String((v && v.voice) || '').trim();
  if (voice) return 'voice:' + voice;
  const raw = String((v && v.src) || '').trim();
  const key = raw && typeof srcKeyOf === 'function' ? String(srcKeyOf(raw) || '') : raw;
  return 'src:' + (key || raw);
}

/* 配音列表 → [{ key, label, voices }]。顺序按每组第一次出现的先后，同一份数据每次算出来都一样；
   标签取组内第一个有名字的成员（说话人 → 音色 → 名字 → 台词），都没有就用去掉前缀的键。 */
export function groupByMaterial(voices, keyOf) {
  const pick = typeof keyOf === 'function' ? keyOf : defaultKeyOf;
  const byKey = new Map();
  (Array.isArray(voices) ? voices : []).forEach(v => {
    if (!v || typeof v !== 'object') return;
    const key = String(pick(v) || '');
    let g = byKey.get(key);
    if (!g) { g = { key, voices: [] }; byKey.set(key, g); }
    g.voices.push(v);
  });
  const groups = [...byKey.values()];
  groups.forEach(g => { g.label = labelOf(g); });
  return groups;
}

function labelOf(g) {
  const first = k => {
    for (const v of g.voices) {
      const s = String((v && v[k]) || '').trim();
      if (s) return s;
    }
    return '';
  };
  const named = first('who') || first('voice') || first('name') || first('text');
  if (named) return named;
  return g.key.replace(KEY_PREFIX, '').trim() || '没有名字的一组';
}

/* 分组 → 行号。前 maxRows 组依次落 0..maxRows-1；再往后的组进 overflow（带名字与句数），
   它们保持原来的行号不动 —— 回执要说清「哪几组没排上」，而不是让用户看到它们被悄悄压在最后一行。 */
export function planLaneRows(groups, maxRows) {
  const cap = Math.max(1, Math.floor(Number(maxRows) || 1));
  const rows = [];
  const overflow = [];
  (Array.isArray(groups) ? groups : []).forEach((g, i) => {
    if (i < cap) rows.push({ key: g.key, label: g.label, ln: i, voices: g.voices });
    else overflow.push({ key: g.key, label: g.label, count: (g.voices || []).length });
  });
  return { rows, overflow };
}

/* 执行分配：只写 `v.ln`，只在真的变了才写；返回改动的句数。别的字段一个字节都不碰。 */
export function applyLanePlan(rows) {
  let moved = 0;
  (Array.isArray(rows) ? rows : []).forEach(r => {
    const ln = Math.max(0, Math.round(Number(r && r.ln) || 0));
    (r && r.voices || []).forEach(v => {
      if (!v || typeof v !== 'object') return;
      if (Math.round(Number(v.ln) || 0) === ln) return;
      v.ln = ln;
      moved++;
    });
  });
  return moved;
}

/* 新加一句配音该落哪一行：在**目标时间窗**内没有别的句子的行里取行号最小的那条。
   `items` = 已有每一句的矩形 `{ ln, l, w }`，`target` = 新那句的矩形 `{ l, w }`，
   两者都是**本镜那一排的轴秒**（调用方用 `voiceAxBox` 现算，与轨道上画块同一把尺子）。
   ⚠ 比的是**框**不是选区：块在轨道上占的就是框的宽度；框包住选区，判「被占」只会更保守。
   判据是「时间窗内没被占」，不是「整行一个字都没有」——同一行别处有句子不影响这一句落进来。
   多行可用取行号最小的（可预期；不取最后一行，免得行越堆越高）。
   全被占时：还没到上限就给新行号（`needNewRow`），到上限就照实回 `lanefull`，不静默塞进最后一行。 */
export function pickVoiceLane(items, target, rows, maxRows) {
  const cap = Math.max(1, Math.floor(Number(maxRows) || 1));
  const n = Math.max(1, Math.min(cap, Math.floor(Number(rows) || 1)));
  const tl = Number(target && target.l) || 0;
  const tw = Math.max(0, Number(target && target.w) || 0);
  const hit = (l, w) => (tl < l + w && l < tl + tw);
  for (let ln = 0; ln < n; ln++) {
    const busy = (Array.isArray(items) ? items : []).some(it => it
      && Math.max(0, Math.round(Number(it.ln) || 0)) === ln
      && hit(Number(it.l) || 0, Math.max(0, Number(it.w) || 0)));
    if (!busy) return { ln, needNewRow: false, why: '' };
  }
  if (n < cap) return { ln: n, needNewRow: true, why: '' };
  return { ln: -1, needNewRow: false, why: 'lanefull' };
}
