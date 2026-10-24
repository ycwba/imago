/* ============================================================================
   设计令牌工具的共用件（§7「同一个功能只应有一份实现」）：
   扫描范围、注释遮罩、声明切分、「什么算裸值」的规则表、值→令牌的映射 ——
   全在这一份里。命令行外壳有两个：
     · tools/tokenize-css.cjs —— 裸值体检 / 机械替换 / 值→令牌映射
     · tools/check-vars.cjs   —— 令牌引用完整性（引了没定义的令牌）
   两者共用同一批规则，所以同一个毛病不会被两把尺子量出两个口径。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STYLE_DIR = path.join(ROOT, 'web', 'styles');
const TOKENS_CSS = path.join(STYLE_DIR, 'tokens.css');

/* ---------------------------------------------------------------------------
   一、值 → 令牌名
   --------------------------------------------------------------------------- */
/** 把像素值变成令牌名：12 → --sp-12；12.5 → --sp-12-5；1.5 → --hair-1-5。 */
function tokName(tier, num) {
  if (tier === 'hair' && num === 1) return '--hair';       // 1px 描边全站最多，给个短名
  const s = String(num).replace('.', '-');
  return `--${tier}-${s}`;
}

/* ---------------------------------------------------------------------------
   二、属性 → 哪一档令牌
   范围照 AGENTS.md §3.4：**间距 / 字号 / 圆角 / 描边宽 / 阴影 / 时长 / 色值**。
   宽高、flex-basis、定位偏移里的巨大数值是**布局事实**，不是档位 —— 不动。
   --------------------------------------------------------------------------- */
const SPACING_PROP = /^(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?$/;
const OFFSET_PROP = /^(inset|top|right|bottom|left)$/;
const FONT_PROP = /^font-size$/;
const RADIUS_PROP = /^border-radius$/;
const BORDER_PROP = /^(border|border-top|border-right|border-bottom|border-left|border-width|outline|outline-width|outline-offset)$/;
/* 描边宽的上限：超过 6px 的不是「描边」，是别的尺寸（留给原样）。 */
const HAIR_MAX = 6;

function tierOf(prop) {
  if (SPACING_PROP.test(prop) || OFFSET_PROP.test(prop)) return 'sp';
  if (FONT_PROP.test(prop)) return 'fs';
  if (RADIUS_PROP.test(prop)) return 'radius';
  if (BORDER_PROP.test(prop)) return 'hair';
  return null;
}

/* ---------------------------------------------------------------------------
   三、颜色与阴影的字面量表（唯一一份）
   --------------------------------------------------------------------------- */
const COLOR_MAP = {
  '#fff': '--on-acc', '#ffffff': '--on-acc',
  '#000': '--media-bg', '#000000': '--media-bg',
  '#c4c9dc': '--scroll', '#2a3046': '--scroll',
};
/* 十六进制基色 → 令牌（键是归一化后的 6 位小写）。
   共享界面的字面量往**语义主题色**上收（--acc/--err/--warn/--ok），
   导演台那套深底配色进 --dir-*（它不跟主题走）。 */
const HEX_BASE = {
  '7f7f7f': '--pal-gray', '5b5f72': '--pal-gray-2',
  '94a3b8': '--pal-slate', 'cbd5e1': '--pal-slate-2', 'b9bdd0': '--pal-slate-3',
  'e5e7eb': '--pal-slate-4', 'cfd4e2': '--pal-slate-5',
  '6c8cff': '--dir-indigo', '6957e8': '--acc',
  '6044d0': '--dir-violet-2',
  '35ead9': '--dir-cyan', '7fd0ff': '--dir-sky',
  '22c55e': '--dir-green', '16a34a': '--ok', '4ade80': '--ok', '006633': '--dir-forest',
  'ef4444': '--dir-red', 'dc2626': '--err',
  'f97316': '--dir-amber', 'd97706': '--warn', 'fbbf24': '--warn',
  '05070a': '--dir-ink-0', '040b0f': '--dir-ink-1', '0c1218': '--dir-ink-2',
  '12141a': '--dir-ink-3', '121218': '--dir-ink-4', '2a2550': '--dir-ink-5',
  '343842': '--dir-ink-6', '0a0616': '--dir-ink-7', '141828': '--dir-ink-8', '0c0e16': '--pal-scrim',
  'eae7fb': '--dir-fog-0', 'f0ecff': '--dir-fog-1', 'f4eeff': '--dir-fog-2', 'ece6ff': '--dir-fog-3',
  'eafcff': '--dir-fog-4', 'ebfffd': '--dir-fog-5', 'e1fffc': '--dir-fog-6',
};
/* rgba() 的基色 → 令牌（键是归一化的 "r,g,b"，不带透明度）。
   透明度现算：color-mix(in srgb, var(--基色) N%, transparent)。 */
const RGBA_BASE = {
  '0,0,0': '--media-bg',
  '255,255,255': '--on-acc',
  '124,92,255': '--pri',
  '108,140,255': '--dir-indigo',
  '160,108,255': '--acc2',
  '105,87,232': '--acc',
  '53,234,217': '--dir-cyan',
  '22,163,74': '--ok',
  '34,197,94': '--dir-green',
  '74,222,128': '--ok',
  '220,38,38': '--err',
  '239,68,68': '--dir-red',
  '217,119,6': '--warn',
  '251,191,36': '--warn',
  '249,115,22': '--dir-amber',
  '127,127,127': '--pal-gray',
  '148,163,184': '--pal-slate',
  '4,11,15': '--dir-ink-1',
  '12,18,24': '--dir-ink-2',
  '18,20,26': '--dir-ink-3',
  '18,18,24': '--dir-ink-4',
  '52,56,66': '--dir-ink-6',
  '10,6,22': '--dir-ink-7',
  '20,24,40': '--dir-ink-8',
  '12,14,22': '--dir-ink-9',
  '240,236,255': '--dir-fog-1',
  '234,252,255': '--dir-fog-4',
  '235,255,253': '--dir-fog-5',
  '225,255,252': '--dir-fog-6',
  '244,238,255': '--dir-fog-2',
  '236,230,255': '--dir-fog-3',
  '96,68,208': '--dir-violet-2',
  '35,38,47': '--txt',
};
/* 阴影字面量 → 令牌（唯一一份表；新阴影要先在这里登记）。
   环形描边（0 0 0 Npx C）与 inset 色带不走这张表：它们只换「宽度那一段」。 */
const SHADOW_MAP = {
  '0 20px 50px rgba(0, 0, 0, .3)': '--shadow-3',
  '0 1px 3px rgba(0, 0, 0, .10)': '--shadow-4',
  '0 6px 18px rgba(0, 0, 0, .08)': '--shadow-5',
  '0 4px 14px rgba(0,0,0,.06)': '--shadow-6',
  '0 4px 14px rgba(0, 0, 0, .08)': '--shadow-7',
  '0 2px 10px rgba(0, 0, 0, .35)': '--shadow-8',
  '0 1px 3px rgba(0,0,0,.14)': '--shadow-9',
  '0 18px 60px rgba(0, 0, 0, .28)': '--shadow-10',
  '0 12px 32px rgba(0,0,0,.18)': '--shadow-11',
  '0 12px 32px rgba(0, 0, 0, .35)': '--shadow-12',
  '0 10px 26px rgba(0, 0, 0, .14)': '--shadow-13',
  '0 14px 34px rgba(0, 0, 0, .16)': '--shadow-14',
  '0 0 0 0 rgba(255,255,255,.55)': '--shadow-15',
  '0 12px 32px rgba(0,0,0,.25)': '--shadow-16',
};

/* ---------------------------------------------------------------------------
   四、声明切分与遮罩
   --------------------------------------------------------------------------- */
/* CSS 声明：属性名允许普通名与自定义属性（--x），值里不能有 {} 或 ; */
const CSS_DECL = /(^|[;{])(\s*)(--)?([a-zA-Z][\w-]*)\s*:\s*([^;{}]*)/g;
/* JS 内联 style 的声明：属性之间用 ; 分隔，没有花括号 */
const INLINE_DECL = /(^|;)(\s*)(--)?([a-zA-Z][\w-]*)\s*:\s*([^;"']*)/g;

/** 注释遮罩：**等长**替换成空格 —— 长度不变，索引不变，
    所以可以在遮罩上匹配、在**原文**上按索引改写（注释原样保留）。 */
function maskCommentsKeepLength(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
}

/** 注释遮罩（不必等长）：体检用。 */
function maskComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/* ---------------------------------------------------------------------------
   五、裸值判据
   --------------------------------------------------------------------------- */
const PX = /(?:^|\s)-?\d*\.?\d+px(?=[\s,;)!]|$)/i;
const COLORISH = new Set(['color', 'background', 'background-color', 'background-image', 'border', 'border-color', 'border-top',
  'border-bottom', 'border-left', 'border-right', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-left-color', 'border-width', 'box-shadow', 'outline', 'outline-color', 'fill', 'stroke', 'accent-color', 'caret-color']);
const HEX = /#([0-9a-fA-F]{3,8})\b/i;
const FN_COLOR = /\brgba?\(/i;
const DUR = /(?:^|\s)\d*\.?\d+(?:ms|s)(?=[\s,)]|$)/i;

function bareRows(src, declRe) {
  const rows = [];
  let m;
  declRe.lastIndex = 0;
  while ((m = declRe.exec(src))) {
    const name = ((m[3] || '') + m[4]).toLowerCase(), value = m[5];
    const why = [];
    const tier = tierOf(name);
    if (tier && PX.test(value)) {
      /* 报告口径要与 --write 一致：超出档位范围的（离屏定位用的巨大偏移）不报，
         否则账上会出现「报了但改不掉」的条目。 */
      const nums = [...value.matchAll(/(-?\d*\.?\d+)px/g)].map(x => Math.abs(parseFloat(x[1]))).filter(x => x > 0);
      const inRange = nums.filter(x => (tier === 'sp' ? x <= 64 : tier === 'hair' ? x <= HAIR_MAX : true));
      if (inRange.length) {
        if (tier === 'sp') why.push('间距 px');
        else if (tier === 'fs') why.push('字号 px');
        else if (tier === 'radius') why.push('圆角 px');
        else why.push('描边 px');
      }
    }
    if (COLORISH.has(name) && (HEX.test(value) || FN_COLOR.test(value))) why.push('色值');
    if (/^(transition|animation)$/.test(name) && DUR.test(value)) why.push('时长');
    if (/var\(--[a-z0-9-]+\s*,\s*[^)]+\)/i.test(value)) why.push('令牌兜底值');
    /* calc() 里直接写 --x（没包 var()）= 非法 CSS：声明整条作废、退回初始值。
       这类错写出来页面照常显示，只是那一处没了 —— 肉眼极难发现。 */
    if (/calc\([^)]*?(?<!var\()--[a-zA-Z]/.test(value)) why.push('calc 里漏了 var()');
    if (why.length) rows.push({ name, value: value.trim(), why: why.join(' / ') });
  }
  return rows;
}

/** 源文件属于哪一类：css / js / html。 */
function kindOfSrc(p) {
  if (/\.(js|mjs|cjs)$/.test(p)) return 'js';
  if (p.endsWith('.html')) return 'html';
  return 'css';
}

/** 扫一个源文件，返回裸值清单。 */
function scanSource(src, kind) {
  const rows = [];
  if (kind === 'js') {
    for (const m of src.matchAll(/style\s*=\s*"([^"]*)"/g)) rows.push(...bareRows(m[1], INLINE_DECL));
  } else if (kind === 'html') {
    /* HTML 两种都扫：<style> 块与行内 style 属性（模板源里行内样式很常见）。 */
    for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) rows.push(...bareRows(m[1], CSS_DECL));
    for (const m of src.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)) rows.push(...bareRows(m[1], INLINE_DECL));
  } else {
    rows.push(...bareRows(src, CSS_DECL));
  }
  /* JS / HTML 里还有**模板字符串**装的 CSS（`` `…` ``），声明级的扫不到：
     助手面板那一段曾经就藏在模板字符串里。整份扫一遍这两类写法。 */
  if (kind === 'js' || kind === 'html') {
    for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*,[^)]*\)/g)) {
      rows.push({ name: '令牌兜底值', value: m[0].slice(0, 60), why: '令牌兜底值' });
    }
    for (const m of src.matchAll(/calc\([^)]*?(?<!var\()--[a-zA-Z][^)]*\)/g)) {
      rows.push({ name: 'calc 里漏了 var()', value: m[0].slice(0, 60), why: 'calc 里漏了 var()' });
    }
  }
  /* 同一条可能既被声明级扫到、又被整份扫到 —— 按「声明 + 值」去重。 */
  const seen = new Set();
  return rows.filter(r => {
    const k = r.name + '|' + r.value;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 递归列目录下的文件（跳过生成物与依赖）。 */
function walkSrc(dir, filter, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'render' || e.name === 'vendor') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, filter, out);
    else if (!filter || filter(p)) out.push(p);
  }
  return out;
}

/* 间距档位收敛的**候选映射**（补档 → 主档）。
   ⚠ 这是「要不要收」的候选表，不是既成事实 —— 收敛会改画面，属于布局重构那一轮的设计决定。
   好处是：真要收的那天，只改 tokens.css 这一个文件（调用点不用动），
   而 `node tools/tokenize-css.cjs --collapse` 先报出「每个档会牵动多少处」，好掂量。 */
const SP_COLLAPSE = {
  1: 2, 2: 2, 3: 4, 5: 4, 6: 8, 7: 8, 9: 8, 10: 8,
  11: 12, 13: 12, 14: 16, 15: 16, 18: 16, 19: 16,
  20: 24, 22: 24, 26: 24, 28: 32, 34: 32, 40: 32, 42: 32,
};
/* 主档（不参与收敛）：新写样式优先用这几档。 */
const SP_MAIN = [4, 8, 12, 16, 24, 32];

module.exports = {
  ROOT, STYLE_DIR, TOKENS_CSS,
  tokName, tierOf, HAIR_MAX,
  COLOR_MAP, HEX_BASE, RGBA_BASE, SHADOW_MAP, COLORISH,
  CSS_DECL, INLINE_DECL,
  maskComments, maskCommentsKeepLength,
  bareRows, kindOfSrc, scanSource, walkSrc,
  SP_COLLAPSE, SP_MAIN,
};
