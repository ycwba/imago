/* ============================================================================
   设计令牌工具的共用件（「同一个功能只应有一份实现」）：
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
   范围照：**间距 / 字号 / 圆角 / 描边宽 / 阴影 / 时长 / 色值**。
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
   共享界面的字面量往**语义主题色**上收（--acc/--err/--warn/--ok）；
   导演台的轨道**标记色**归 --mark-*（功能语义，深浅两档各一套），
   导演台的**深底表面**归主题面板色（--panel/--panel2/--line）——
   导演台不再有独立深底作用域，跟其他页面一样跟主题走。 */
const HEX_BASE = {
  '7f7f7f': '--pal-gray', '5b5f72': '--pal-gray-2',
  '94a3b8': '--pal-slate', 'cbd5e1': '--pal-slate-2', 'b9bdd0': '--pal-slate-3',
  'e5e7eb': '--pal-slate-4', 'cfd4e2': '--pal-slate-5',
  /* 6c8cff 是夜间档的 --acc、6957e8 是白天档的 --acc —— 同一枚令牌的两档值 */
  '6c8cff': '--acc', '6957e8': '--acc',
  '6044d0': '--acc2',
  '35ead9': '--mark-cut', '7fd0ff': '--acc2',
  '22c55e': '--mark-ready', '16a34a': '--ok', '4ade80': '--ok', '006633': '--ok',
  'ef4444': '--mark-mute', 'dc2626': '--err',
  'f97316': '--mark-loud', 'd97706': '--warn', 'fbbf24': '--warn',
  /* 深底表面：归主题面板色（导演台跟主题走） */
  '05070a': '--line', '040b0f': '--panel2', '0c1218': '--panel',
  '12141a': '--panel2', '121218': '--panel2', '2a2550': '--panel2',
  '343842': '--line', '0a0616': '--panel',
  '0c0e16': '--pal-scrim',
  /* 深底上的浅色：归主题文字色 / 强调色 */
  'eae7fb': '--panel', 'f0ecff': '--acc', 'f4eeff': '--acc', 'ece6ff': '--acc',
  'eafcff': '--txt', 'ebfffd': '--txt', 'e1fffc': '--acc',
};
/* rgba() 的基色 → 令牌（键是归一化的 "r,g,b"，不带透明度）。
   透明度现算：color-mix(in srgb, var(--基色) N%, transparent)。 */
const RGBA_BASE = {
  '0,0,0': '--media-bg',
  '255,255,255': '--on-acc',
  '124,92,255': '--pri',
  '108,140,255': '--acc',
  '160,108,255': '--acc2',
  '105,87,232': '--acc',
  '53,234,217': '--mark-cut',
  '22,163,74': '--ok',
  '34,197,94': '--mark-ready',
  '74,222,128': '--ok',
  '220,38,38': '--err',
  '239,68,68': '--mark-mute',
  '217,119,6': '--warn',
  '251,191,36': '--warn',
  '249,115,22': '--mark-loud',
  '127,127,127': '--pal-gray',
  '148,163,184': '--pal-slate',
  '12,14,22': '--pal-scrim',
  /* 深底表面：归主题面板色（导演台跟主题走） */
  '4,11,15': '--panel2',
  '12,18,24': '--panel',
  '18,20,26': '--panel2',
  '18,18,24': '--panel2',
  '52,56,66': '--line',
  '10,6,22': '--panel',
  /* 深底上的浅色：归主题文字色 / 强调色 */
  '240,236,255': '--acc',
  '234,252,255': '--txt',
  '235,255,253': '--txt',
  '225,255,252': '--acc',
  '244,238,255': '--acc',
  '236,230,255': '--acc',
  '96,68,208': '--acc2',
  '35,38,47': '--txt',
};
/* 阴影字面量 → 令牌（唯一一份表；新阴影要先在这里登记）。
   键是字面量，值是**终档名**（五枚）：旧档位的名字不在这张表里，
   调用点的 var(--shadow-N) 由 --remap 改名，裸字面量由 --write 直接落终名。
   环形描边（0 0 0 Npx C）与 inset 色带不走这张表：它们只换「宽度那一段」。 */
const SHADOW_MAP = {
  /* 抬升（--shadow-1）：卡片 / 勾选框那一档小浮起 */
  '0 1px 3px rgba(0, 0, 0, .10)': '--shadow-1',
  '0 1px 3px rgba(0,0,0,.14)': '--shadow-1',
  /* 浮层（--shadow-2）：卡片 hover / 下拉 / 提示 */
  '0 8px 24px rgba(16,24,40,.12)': '--shadow-2',
  '0 6px 18px rgba(0, 0, 0, .08)': '--shadow-2',
  '0 4px 14px rgba(0,0,0,.06)': '--shadow-2',
  '0 4px 14px rgba(0, 0, 0, .08)': '--shadow-2',
  '0 10px 26px rgba(0, 0, 0, .14)': '--shadow-2',
  /* 重浮层（--shadow-3）：菜单 / 日期层 */
  '0 12px 32px rgba(0,0,0,.25)': '--shadow-3',
  '0 12px 32px rgba(0,0,0,.18)': '--shadow-3',
  '0 14px 34px rgba(0, 0, 0, .16)': '--shadow-3',
  /* 模态（--shadow-4）：弹窗 / 灯箱 */
  '0 20px 50px rgba(0, 0, 0, .3)': '--shadow-4',
  '0 18px 60px rgba(0, 0, 0, .28)': '--shadow-4',
  '0 12px 32px rgba(0, 0, 0, .35)': '--shadow-4',
  /* 深底小浮起（--shadow-5）：媒体上的播放钮 */
  '0 2px 10px rgba(0, 0, 0, .35)': '--shadow-5',
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
   这是「--collapse 干跑」用的影响面表；真收的那一步走 SP_REMAP（名字重映射）。 */
const SP_COLLAPSE = {
  1: 2, 2: 2, 3: 4, 5: 4, 6: 8, 7: 8, 9: 8, 10: 8,
  11: 12, 13: 12, 14: 16, 15: 16, 18: 16, 19: 16,
  20: 24, 22: 24, 26: 24, 28: 32, 34: 32, 40: 32, 42: 32,
};
/* 主档（不参与收敛）：新写样式优先用这几档。 */
const SP_MAIN = [4, 8, 12, 16, 24, 32];

/* ---------------------------------------------------------------------------
   六、档位收敛：旧名 → 终名（--remap 的改名表；值吸附的落点表）
   收敛写法是**直接重映射调用点到终档名**，然后把补档从 tokens.css 删掉 ——
   「名字即值」在终态成立（不留 --sp-6:8px 这种说谎的中间态）。
   --------------------------------------------------------------------------- */
/* 间距：补档 → 终表 2/4/8/12/16/24/32/64（54/60 是大留白角色 → 64）。 */
const SP_REMAP = {
  1: '2', 3: '4', 5: '4', 6: '8', 7: '8', 9: '8', 10: '8',
  11: '12', 13: '12', 14: '16', 15: '16', 18: '16', 19: '16',
  20: '24', 22: '24', 26: '24', 28: '32', 34: '32', 40: '32', 42: '32',
  54: '64', 60: '64',
};
/* 字号：半档与小档 → 终表 11/12/13/14/16/20/24（+ 展示档 42/54）。
   键是名字里的尾巴（--fs-12-5 → '12-5'）。 */
const FS_REMAP = {
  '8-5': '11', 9: '11', '9-5': '11', 10: '11', '10-5': '11',
  '11-5': '12', '12-5': '13', '13-5': '13', '14-5': '14', 15: '14',
  17: '16', 18: '16', 19: '20',
};
/* 时长：16 档 → 终表 120/180/280/800/1200（快 / 基准 / 慢 / 转圈 / 脉冲）。 */
const DUR_REMAP = {
  100: '120', 140: '120', 150: '120',
  160: '180', 200: '180',
  250: '280', 400: '280',
  900: '800',
  1100: '1200', 1400: '1200', 1600: '1200',
};
/* 阴影：16 枚 → 终表 1..5。名字会重排（旧 3→新 4、旧 4→新 1……），
   改名必须**一次替换**，不许链式（旧 4 先变新 1、再被旧 1 的映射吃掉就错了）。
   旧 15（零宽白环）没有终名：调用点改写成 none。 */
const SHADOW_REMAP = {
  1: '1', 2: '2', 3: '4', 4: '1', 5: '2', 6: '2', 7: '2', 8: '5',
  9: '1', 10: '4', 11: '3', 12: '4', 13: '2', 14: '3', 16: '3',
};
/* 圆角：15 枚 → 终表 4/6/10/14/999。8 是角色分裂档（控件→6 / 容器→10）——
   组件重构先按角色落位，剩的用这张表兜底扫尾（默认 8→6）。 */
const RADIUS_REMAP = {
  1: '4', 2: '4', 3: '4',
  5: '6', 7: '6', 8: '6',
  9: '10', 12: '10',
  20: '999', 99: '999',
};

/* 旧名 → 终名（按令牌名整体查；没登记的名字原样返回）。
   shadow-15 返回 null = 那一处不是改名而是改值（box-shadow: none）。 */
function remapName(fullName) {
  const m = /^--(sp|fs|radius|dur|shadow)-([\w.-]+)$/.exec(fullName);
  if (!m) return fullName;
  const [, fam, tail] = m;
  let to;
  if (fam === 'shadow') {
    if (tail === '15') return null;
    to = SHADOW_REMAP[tail];
  } else if (fam === 'sp') to = SP_REMAP[tail];
  else if (fam === 'fs') to = FS_REMAP[tail];
  else if (fam === 'dur') to = DUR_REMAP[tail];
  else if (fam === 'radius') to = RADIUS_REMAP[tail];
  return to === undefined ? fullName : `--${fam}-${to}`;
}

/* 值吸附：--write 造新名时先过这张表 —— 裸 6px 吸附成 --sp-8，
   不会造出已删档名（名字即值只对终表生效，补档名不许再出现）。 */
function snapName(tier, name) {
  const mapped = remapName(name);
  return mapped === null ? name : mapped;
}

module.exports = {
  ROOT, STYLE_DIR, TOKENS_CSS,
  tokName, tierOf, HAIR_MAX,
  COLOR_MAP, HEX_BASE, RGBA_BASE, SHADOW_MAP, COLORISH,
  CSS_DECL, INLINE_DECL,
  maskComments, maskCommentsKeepLength,
  bareRows, kindOfSrc, scanSource, walkSrc,
  SP_COLLAPSE, SP_MAIN,
  SP_REMAP, FS_REMAP, DUR_REMAP, SHADOW_REMAP, RADIUS_REMAP,
  remapName, snapName,
};
