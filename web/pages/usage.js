/* 用量与余额 —— 从 usage.html 迁到 Vue 3 的第二个页面。
   行为一律照旧：代理没起来 / 没配密钥 / 无余额接口三种空态各说各的，
   同一把密钥只画一张卡，账单 / 曲线 / 语音 / 文字 AI 四块读数都从原来的数据函数来；
   组件只负责「这一屏长什么样」，Dropdowns / Chips / Wb.loadNote / Net.save 仍是全站那一份实现。 */
import { ref, reactive, computed, onMounted, nextTick } from '../../vue.runtime.esm-browser.prod.js';
import { render } from '../render/usage.js';
import { ensureCss } from '../core/page-css.js';

ensureCss('web/styles/spa-usage.css');

const ROUND = v => Math.round((Number(v) || 0) * 100) / 100;

/* 平台显示名只有一份读法：注册表声明的 `displayName` / `name`（文字 AI 那几家名字里带的
   「文字 AI」是接口类型、不是厂商名，去掉它）。与 usage.html 完全一致。 */
function provLabel(p) {
  if (!p) return '';
  const t = String(p.displayName || p.name || '').trim();
  return t.replace(/\s+文字\s*AI\s*/g, ' ').trim() || t;
}
/* 账单与用量记录里只存了 provider id，按 id 现问注册表（问不到就照实显示那一个 id，不编名字） */
function kidLabel(reg, kid) {
  return provLabel((((reg && reg.providers) || [])
    .find(x => (x.keyId || x.id) === kid || x.id === kid))) || kid || '文字 AI';
}

/* 取 JSON：失败要能区分「读不到」和「内容为空」——两者都返回 null 时，
   最后界面统一显示「还没有配置任何平台的密钥」，代理没起来时会被误导 */
async function getJson(url) {
  try {
    const r = await window.Net.fetch(url, { timeout: 10000, retry: 1 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    console.warn('[usage] 读取失败 ' + url + '：', e && e.message);
    return null;
  }
}

/* 自动配色：按平台名稳定分配（同一平台永远同色）。
   色值只在 `tokens.css` 的 `--chart-*`（唯一一份），这里现读 CSS 变量；
   读不到（没有 document / 变量被删）就退回当前文字色，绝不写死第二套十六进制。 */
const CHART_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6',
  '--chart-7', '--chart-8', '--chart-9', '--chart-10', '--chart-11', '--chart-12'];
let chartPalette = null, chartPaletteTheme = '';
function chartColors() {
  const theme = (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) || 'light';
  if (chartPalette && chartPaletteTheme === theme) return chartPalette;
  let list = [];
  try {
    const cs = getComputedStyle(document.documentElement);
    list = CHART_VARS.map(v => cs.getPropertyValue(v).trim()).filter(Boolean);
  } catch { /* 读不到就退回文字色 */ }
  chartPalette = list.length ? list : ['currentColor'];
  chartPaletteTheme = theme;
  return chartPalette;
}
/* 图例上那一行只放得下十六个字：名字已经由 `provLabel` 归一，不再在这里按平台写正则 */
const shortName = p => String(p || '').slice(0, 16);

export default {
  name: 'UsageView',
  setup() {
    const rootEl = ref(null);
    const chartUnitsEl = ref(null);
    const fPlatformEl = ref(null);

    const reloading = ref(true);
    const failed = ref('');
    const upd = ref('');

    const balanceCards = ref([]);
    const balanceLoading = ref(true);
    const balanceTip = ref(null);       // null | { kind: 'proxy' | 'warn' | 'none', why? }

    const chartHtml = ref('<div class="empty">加载中…</div>');

    const voiceStat = ref(null);
    const voiceEmpty = ref('');
    const voiceModelRows = ref([]);
    const voiceRecentRows = ref([]);

    const aiLoaded = ref(false);
    const aiStat = ref(null);
    const aiPriceNote = ref('');
    const aiModelRows = ref([]);
    const aiDailyRows = ref([]);

    const bills = ref([]);
    const billMore = ref(false);
    const billErrs = ref({});
    const billErr = ref('');
    const billLoading = ref(true);
    const billDownHtml = ref('');
    const billNoteHtml = ref('');
    const billCntText = ref('');
    const billRows = ref([]);
    const curBillRows = ref([]);

    const platformOptions = ref([]);
    const fPlatform = ref('');
    const fRange = ref('30');
    const fQ = ref('');

    let REG = null;
    let envStatus = null;               // /env-status 的结果：null = 读不到（代理没起来）
    let chartUnit = 'all';              // all | 积分 | 元
    const colorCache = new Map();
    let colorIdx = 0;

    /* ---------- 文字 AI 用量只有这一份读取入口 ---------- */
    function readUsage() { return window.TextAI.readUsageLog(); }

    /* ---------- 平台归并：判据只认注册表（同一家的生图 / 视频算同一个） ---------- */
    function apiOf(name, provider) {
      const p = ((REG && REG.providers) || []).find(x =>
        (provider && (x.id === provider || x.keyId === provider)) || x.keyId === name || x.id === name);
      if (p) return provLabel(p) || p.keyId || p.id || String(name || '').trim() || '其它';
      const raw = String(name || '').trim();
      if (!raw) return '其它';
      return raw.replace(/^文字\s*AI（(.+)）$/, '$1').replace(/^AI 生成\s*·\s*/, '')
        .replace(/[\s·:：-]*(生图|视频|图片|音频|音乐)$/, '').trim() || raw;
    }

    function colorOf(name) {
      const hit = colorCache.get(name);
      if (hit) return hit;
      const colors = chartColors();
      const c = colors[colorIdx++ % colors.length];
      colorCache.set(name, c);
      return c;
    }

    /* ---------- 已配置的平台（判据只有一份：`Api.provUsable`） ---------- */
    async function loadConfigured(reg) {
      const env = await window.Api.envStatus();
      envStatus = window.Api.envKnown() ? env : null;   // null = 读不到，{} = 读到了但没配密钥
      const list = [];
      for (const prov of ((reg && reg.providers) || [])) {
        if (!window.Api.provUsable(prov, env)) continue;
        const kid = prov.keyId || prov.id;
        /* 只补「密钥从哪来」那一句：custom 而两把都没有的也在用（刚添加完总得看得见） */
        const local = String(window.LS.get('sk_key_' + kid) || '').trim() !== '';
        const hasEnv = !!((env || {})[kid] && (env || {})[kid].hasEnv);
        list.push({ prov, kid, source: local ? '页面密钥' : hasEnv ? '服务端环境密钥' : '自己添加的' });
      }
      return list;
    }

    /* ---------- 余额 ----------
       同一密钥的平台只查一次，展示名用 displayName（不分开统计） */
    async function loadBalances(reg, configured) {
      const has = kid => configured.some(c => c.kid === kid);
      /* 「这一家列在用、但两把密钥都没有」= 刚添加完的自定义条目：别真去打一趟必然失败的接口 */
      const noKey = kid => (configured.find(c => c.kid === kid) || {}).source === '自己添加的';
      const cards = [];
      const jobs = [];
      if (window.Api) window.Api.setRegistry(reg);

      const genProvs = [];
      ((reg && reg.providers) || []).forEach(p => {
        if (!p.endpoints || !p.endpoints.credits) return;
        const kid = p.keyId || p.id;
        if (genProvs.some(x => (x.keyId || x.id) === kid)) return;
        genProvs.push(p);
      });
      genProvs.forEach(p => {
        const kid = p.keyId || p.id;
        if (!has(kid)) return;
        const name = provLabel(p);
        const ic = p.kind === 'video' ? window.icon('video', 15) : (p.kind === 'image' ? window.icon('film', 15) : window.icon('coin', 15));
        jobs.push((async () => {
          if (noKey(kid)) { cards.push({ kid, ic, name, unit: '', val: '—', ex: '还没填密钥' }); return; }
          try {
            const raw = await window.Api.request(p, 'credits');
            const b = window.Api.balance(p, raw);
            if (!b.ok) { cards.push({ kid, ic, name, unit: '', val: '—', ex: b.err || '读取失败' }); return; }
            /* 单位跟着 balance 返回的 unit 走；数字怎么报（积分千分位 / 金额 ¥ 两位）
               只在 Api.balNum 一处定，卡片这里不再自己写第二套分支。 */
            const val = window.Api.balNum(b.available, b.unit);
            const ex = [b.frozen ? ('冻结 ' + window.Api.balNum(b.frozen, b.unit)) : '', b.note].filter(Boolean).join(' · ');
            cards.push({ kid, ic, name, unit: b.unit, val, ex });
          } catch (e) { cards.push({ kid, ic, name, unit: '', val: '—', ex: '查询失败：' + e.message }); }
        })());
      });

      // 文字 AI：已配置的每个平台都单独查余额（展示名现读注册表）
      const textProvs = configured.filter(c => c.prov.kind === 'text');
      textProvs.forEach(c => jobs.push((async () => {
        if (noKey(c.kid)) { cards.push({ kid: c.kid, ic: window.icon('brain', 15), name: provLabel(c.prov) || c.kid, unit: '', val: '—', ex: '还没填密钥' }); return; }
        const model = window.TextAI.model(c.prov);
        const label = provLabel(c.prov) || c.kid;
        const r = await window.TextAI.fetchBalance(reg, c.prov);
        /* 型号不塞进卡片标题：标题只放平台名，型号作为一条说明（model） */
        if (r.ok) {
          cards.push({ kid: c.kid, ic: window.icon('brain', 15), name: label, model, unit: r.currency || 'CNY',
            val: (r.currency === 'CNY' || !r.currency ? '¥' : '') + Number(r.amount).toFixed(2),
            ex: [r.extra, c.source, r.available === false ? '不可用' : ''].filter(Boolean).join(' · ') });
        } else if (r.unsupported) {
          cards.push({ kid: c.kid, ic: window.icon('brain', 15), name: label, model, unit: '', val: '无余额接口', ex: [c.source, '该平台不提供余额查询'].filter(Boolean).join(' · ') });
        } else {
          cards.push({ kid: c.kid, ic: window.icon('brain', 15), name: label, model, unit: '', val: '—', ex: '查询失败：' + r.reason });
        }
      })()));

      await Promise.all(jobs);
      /* 没有余额接口的家也照实画一张卡，不能静默跳过。
         ⚠ 必须放在 `await Promise.all(jobs)` **之后**：下面合卡是「同一个 kid 先到者赢」，
           放在前面会把真正查得到的那张（以及它的金额）盖成「无余额接口」。 */
      {
        const taken = new Set(cards.map(c => c.kid));
        ((reg && reg.providers) || []).forEach(p => {
          if (p.endpoints && p.endpoints.credits) return;
          const kid = p.keyId || p.id;
          if (!kid || !has(kid) || taken.has(kid)) return;
          taken.add(kid);
          cards.push({ kid, ic: window.icon('coin', 15), name: p.displayName || p.name || kid, unit: '', val: '无余额接口',
            ex: [p.site ? '到 ' + p.site + ' 的账户页查' : '', '该平台不提供余额查询'].filter(Boolean).join(' · ') });
        });
      }
      /* 同一把密钥只画一张卡：保留先到的那张（生成平台那条更准），把另一条的说明并进来，型号只记一次。 */
      const byKid = new Map();
      for (const c of cards) {
        const k = c.kid || c.name;
        const prev = byKid.get(k);
        if (!prev) { byKid.set(k, c); continue; }
        if (prev.val === '—' && c.val !== '—') { prev.val = c.val; prev.unit = c.unit; }
        if (!prev.model && c.model) prev.model = c.model;
        /* 同一次失败会被两条路各报一遍：冒号前那段（失败类别）一样就当成同一次失败，只留带得动的那条。 */
        const lead = t => String(t || '').split('：')[0];
        const hasHint = t => String(t || '').includes('用的是：');
        if (c.ex && lead(prev.ex) && lead(prev.ex) === lead(c.ex)) {
          if (hasHint(c.ex) || (!hasHint(prev.ex) && c.ex.length > prev.ex.length)) prev.ex = c.ex;
        } else {
          for (const s of String(c.ex || '').split(' · ')) {
            if (s && !prev.ex.split(' · ').includes(s)) prev.ex = prev.ex ? prev.ex + ' · ' + s : s;
          }
        }
      }
      const list = [...byKid.values()];
      balanceLoading.value = false;
      if (!list.length) {
        // 区分三种情况，别把「读不到配置」说成「没配密钥」
        const envOk = envStatus !== null;
        balanceCards.value = [];
        balanceTip.value = envOk ? { kind: 'none' } : { kind: 'warn' };
      } else {
        balanceTip.value = null;
        balanceCards.value = list;
      }
      return list.length;
    }

    /* ---------- 账单 ---------- */
    async function loadBills() {
      const out = [];
      billMore.value = false; billErrs.value = {}; billErr.value = '';
      try {
        upd.value = '正在读取生成记录…';
        /* 只拉最近 2 页（每平台各 100 条）；hasMore / errors 必须接住 */
        const res = await window.AssetLib.load({ pages: 2 });
        billMore.value = !!res.hasMore;
        billErrs.value = res.errors || {};
        (res.entries || []).filter(e => e.kind === 'asset' || e.kind === 'task').forEach(e => {
          const c = window.AssetLib.costOf(e);
          const isVoice = window.isAudioType(e.type);
          const desc = [e.prompt || '', e.tier ? e.tier : '', e.res || '',
            e.voice ? '音色 ' + e.voice : '',
            e.chars ? e.chars + ' 字' : '',
            e.tokens ? e.tokens + ' tokens' : '',
            e.duration ? e.duration + 's' : '', e.format ? String(e.format).toUpperCase() : ''].filter(Boolean).join(' · ');
          out.push({
            ts: window.AssetLib.tsMs(e.ts), platform: e.providerName || e.provider || '—', provider: e.provider || '', genId: e.genId || e.id || '',
            what: (e.type || '素材') + (e.model ? ' · ' + e.model : '') + (isVoice && e.voice ? ' · ' + e.voice : ''),
            isVoice, chars: e.chars || null, tokens: e.tokens || null, duration: e.duration || null,
            desc,
            descShort: String(desc).slice(0, 60),
            genShort: String(e.genId || e.id || '').slice(0, 8),
            status: e.gstatus || (e.status === 'done' ? 'succeeded' : e.status || ''),
            cost: c.cost, unit: c.unit,
          });
        });
      } catch (e) { billErr.value = errText(e); }
      readUsage().forEach(u => {
        const pt = u.pt || 0, ct = u.ct || 0;
        const desc = `${pt.toLocaleString()} 输入 + ${ct.toLocaleString()} 输出 tokens`;
        out.push({
          ts: u.at, platform: kidLabel(REG, u.prov), genId: '',
          what: u.model || 'chat',
          desc,
          descShort: String(desc).slice(0, 60),
          genShort: '',
          status: 'succeeded',
          tokens: pt + ct,          // 文字 AI 只统计 tokens，不算金额
          cost: null, unit: '',
        });
      });
      out.sort((a, b) => b.ts - a.ts);
      return out;
    }

    function renderBills() {
      const pf = fPlatform.value, days = Number(fRange.value), q = fQ.value.trim().toLowerCase();
      const since = days ? Date.now() - days * 86400000 : 0;
      const rows = bills.value.filter(b => (!pf || b.platform === pf) && (!since || (b.ts || 0) >= since)
        && (!q || ((b.desc || '') + ' ' + (b.what || '') + ' ' + (b.genId || '')).toLowerCase().includes(q)));
      const scSum = rows.filter(r => r.unit === '积分').reduce((a, r) => a + (r.cost || 0), 0);
      const yuanSum = rows.filter(r => r.unit === '元').reduce((a, r) => a + (r.cost || 0), 0);
      const tkSum = rows.reduce((a, r) => a + (r.tokens || 0), 0);
      const noPrice = rows.filter(r => r.cost == null && r.tokens == null).length;
      const LIMIT = 300;
      const shown = rows.slice(0, LIMIT);
      /* 失败来源单独一条，样式与「重试」按钮都走公共层 `Wb.loadNote` */
      billNoteHtml.value = window.Wb ? window.Wb.loadNote(billErrs.value, 'billRetry') : '';
      // 计数写清楚「只显示了前 N 条」「还有几页没读」
      billCntText.value = `${rows.length} 条`
        + (rows.length > LIMIT ? `（表格只列出前 ${LIMIT} 条，导出 CSV 含已加载的全部）` : '')
        + (billMore.value ? ' · 各平台还有更多页没加载（这里只读最近 2 页，数量与积分不是完整账目）' : '')
        + ` · 积分 ${ROUND(scSum)}`
        + (yuanSum ? ' · 金额 ¥' + yuanSum.toFixed(4) : '')
        + (tkSum ? ' · 文字 AI ' + tkSum.toLocaleString() + ' tokens' : '')
        + (noPrice ? ` · ${noPrice} 条平台未返回价格` : '')
        + (billErr.value ? ' · 生成记录读取失败：' + billErr.value + '（下方仍显示本地文字 AI 记录）' : '');
      billRows.value = shown;
      billLoading.value = false;
      billDownHtml.value = '';
      curBillRows.value = rows;      // 导出 CSV 用（筛选后的全部，不只是表格里显示的）
      // 平台下拉选项
      const ps = [...new Set(bills.value.map(b => b.platform))].filter(Boolean);
      platformOptions.value = ps;
      if (pf && !ps.includes(pf)) fPlatform.value = '';
      if (window.Dropdowns) nextTick(() => {
        if (fPlatformEl.value) window.Dropdowns.sync(fPlatformEl.value);
      });
    }

    function billRowTitle(b) {
      return String((b.desc || '') + ' ' + (b.genId || '')).slice(0, 300);
    }

    /* ---------- 图表 ---------- */
    function buildSeries(list, days) {
      const N = days, buckets = [];
      for (let i = N - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        buckets.push({ key: window.dayKey(d), label: (d.getMonth() + 1) + '/' + d.getDate() });
      }
      const idx = new Map(buckets.map((b, i) => [b.key, i]));
      const series = new Map();     // API → { name, unit, vals[], total, subs:Map(子类型→每日值) }
      list.forEach(b => {
        if (b.cost == null) return;
        const bk = idx.get(window.dayKey(b.ts));
        if (bk == null) return;
        const key = apiOf(b.platform, b.provider);
        if (!series.has(key)) series.set(key, { name: key, unit: b.unit || '', vals: new Array(N).fill(0), total: 0, subs: new Map() });
        const sv = series.get(key);
        const v = Number(b.cost) || 0;
        sv.vals[bk] += v;
        sv.total += v;
        if (!sv.unit && b.unit) sv.unit = b.unit;
        // 记录来源明细（生图 / 视频 / …），用于悬停时展示拆分
        const sub = String(b.platform || '');
        if (sub && sub !== key) {
          if (!sv.subs.has(sub)) sv.subs.set(sub, new Array(N).fill(0));
          sv.subs.get(sub)[bk] += v;
        }
      });
      let arr = [...series.values()].sort((a, b) => b.total - a.total);
      if (chartUnit !== 'all') arr = arr.filter(sv => sv.unit === chartUnit);
      return { buckets, series: arr };
    }

    function chartSvg(list, days) {
      const { buckets, series } = buildSeries(list, days);
      const unitChips = chartUnitsEl.value;
      if (unitChips && window.Chips) {
        const units = [...new Set(list.filter(b => b.cost != null).map(b => b.unit || ''))].filter(Boolean);
        window.Chips.render(unitChips, [['all', '全部'], ...units.map(u => [u, u === '积分' ? '积分' : '金额（' + u + '）'])],
          chartUnit, v => { chartUnit = v; renderChart(); });
      }
      if (!series.length) {
        return window.Wb.emptyHTML('该单位下近 ' + days + ' 天没有消费记录');
      }
      const max = Math.max(1, ...buckets.map((_, i) => Math.max(0, ...series.map(sv => sv.vals[i]))));
      const W = 760, H = 160, bw = W / buckets.length;
      const n = series.length;
      const barW = Math.max(2.5, Math.min(14, (bw - 6) / n));
      const bars = buckets.map((b, i) => {
        const x0 = i * bw + 3;
        const inner = series.map((sv, k) => {
          const v = sv.vals[i];
          if (!v) return '';
          const h = Math.max(1, Math.round((v / max) * (H - 34)));
          const x = x0 + k * barW;
          const fmtV = x2 => x2.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
          const parts = [...sv.subs.entries()]
            .filter(([, arr]) => arr[i] > 0)
            .map(([sub, arr]) => sub.replace(/^SparkCine\s*/, '').replace(/^VGENV\s*/, '') + ' ' + fmtV(arr[i]));
          const tip = `${b.label} · ${sv.name}：${fmtV(v)} ${sv.unit}` + (parts.length > 1 ? '（' + parts.join(' + ') + '）' : '');
          return `<rect x="${x.toFixed(1)}" y="${H - 24 - h}" width="${Math.max(2, barW - 1).toFixed(1)}" height="${h}" rx="2" fill="${colorOf(sv.name)}">
        <title>${tip}</title></rect>`;
        }).join('');
        return `<g>${inner}<text x="${x0 + (bw - 6) / 2}" y="${H - 6}" font-size="10" text-anchor="middle" fill="var(--sub)">${b.label}</text></g>`;
      }).join('');
      const legend = series.map(sv => {
        const subs = [...sv.subs.keys()].map(x => x.replace(/^SparkCine\s*/, '').replace(/^VGENV\s*/, '')).filter(Boolean);
        const subTxt = subs.length ? `<i style="background:transparent;width:auto;margin:0 0 0 2px;font-style:normal;color:var(--sub)">（${subs.slice(0, 3).join('/')}${subs.length > 3 ? '…' : ''}）</i>` : '';
        return `<span title="${sv.name}"><i style="background:${colorOf(sv.name)}"></i>${shortName(sv.name)}${subTxt}${sv.unit ? ' · ' + sv.unit : ''} <b style="color:var(--sub);font-weight:500">${ROUND(sv.total).toLocaleString()}</b></span>`;
      }).join('');
      return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="每日消费曲线">${bars}</svg>
    <div class="legend" style="flex-wrap:wrap">${legend}<span style="margin-left:auto">近 ${days} 天</span></div>`;
    }

    function renderChart() {
      chartHtml.value = chartSvg(bills.value, 14);
    }

    /* ---------- 语音用量：从资产库里的语音条目汇总（字数 / 接口 tokens / 时长） ---------- */
    function renderVoiceStat() {
      const rows = bills.value.filter(b => b.isVoice);
      const cnt = rows.length;
      const chars = rows.reduce((a, r) => a + (Number(r.chars) || 0), 0);
      const tokens = rows.reduce((a, r) => a + (Number(r.tokens) || 0), 0);
      const secs = rows.reduce((a, r) => a + (Number(r.duration) || 0), 0);
      if (cnt) {
        voiceEmpty.value = '';
        voiceStat.value = {
          count: cnt,
          chars,
          tokens,
          secs,
          hasCost: rows.some(r => r.cost != null),
        };
      } else {
        voiceStat.value = null;
        voiceEmpty.value = '还没有语音记录（去「生成工作台」的语音栏生成一条就会出现在这里）';
      }
      // 按模型/音色汇总
      const byModel = new Map();
      rows.forEach(r => {
        const k = r.what || '语音';
        const cur = byModel.get(k) || { cnt: 0, chars: 0, tokens: 0, secs: 0 };
        cur.cnt++; cur.chars += Number(r.chars) || 0; cur.tokens += Number(r.tokens) || 0; cur.secs += Number(r.duration) || 0;
        byModel.set(k, cur);
      });
      voiceModelRows.value = [...byModel.entries()]
        .sort((a, b) => b[1].cnt - a[1].cnt)
        .map(([name, v]) => ({ name, ...v }));
      voiceRecentRows.value = rows.slice(0, 10);
    }

    function renderAiStat() {
      const usage = readUsage();
      // 只按 tokens 汇总（不折算金额）
      const byModel = new Map();
      usage.forEach(u => {
        const k = u.model || 'chat';
        const cur = byModel.get(k) || { calls: 0, pt: 0, ct: 0 };
        cur.calls++; cur.pt += u.pt || 0; cur.ct += u.ct || 0;
        byModel.set(k, cur);
      });
      const tk = window.dayKey(Date.now());
      const today = usage.filter(u => window.dayKey(u.at) === tk);
      const todayTokens = today.reduce((a, u) => a + (u.pt || 0) + (u.ct || 0), 0);
      const all = usage.reduce((a, u) => ({ pt: a.pt + (u.pt || 0), ct: a.ct + (u.ct || 0) }), { pt: 0, ct: 0 });
      aiStat.value = {
        todayCalls: today.length,
        todayTokens,
        totalCalls: usage.length,
        totalTokens: all.pt + all.ct,
        pt: all.pt,
        ct: all.ct,
      };
      aiPriceNote.value = usage.length ? '' : '还没有调用记录。';
      aiModelRows.value = [...byModel.entries()]
        .sort((a, b) => (b[1].pt + b[1].ct) - (a[1].pt + a[1].ct))
        .map(([model, v]) => ({ model, ...v }));
      const byDay = new Map();
      usage.forEach(u => { const k = window.dayKey(u.at); byDay.set(k, (byDay.get(k) || 0) + (u.pt || 0) + (u.ct || 0)); });
      const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 10);
      aiDailyRows.value = days.map(([day, tokens]) => ({
        day,
        tokens,
        calls: usage.filter(u => window.dayKey(u.at) === day).length,
      }));
      aiLoaded.value = true;
    }

    /* ---------- 代理没起来时的这一页该长什么样 ----------
       读不到注册表就当场把三块面板换成一句能照做的话，状态行也照实说。 */
    function showProxyDown(why) {
      const tip = window.Wb.emptyHTML(['读不到本机代理' + (why ? '（' + why + '）' : '') + '：'
        + '这一页的余额、曲线与账单都要问代理，它没起来就什么都取不到。',
        '先跑一次项目目录里的「启动.bat」（或 node proxy.js），再点右上「刷新」。']);
      balanceLoading.value = false;
      balanceCards.value = [];
      balanceTip.value = { kind: 'proxy', why: why || '' };
      chartHtml.value = tip;
      billLoading.value = false;
      billDownHtml.value = tip;
      upd.value = '代理没起来 —— 三块面板都取不到数';
    }

    /* 请求代际号：连点「刷新」或按 R 会同时跑两趟，旧那趟后回来会把新数据盖回去。
       每一段写状态之前先验「我还是不是最新那一趟」。 */
    let reloadSeq = 0;
    async function reloadAll() {
      const seq = ++reloadSeq;
      const mine = () => seq === reloadSeq;
      reloading.value = true;
      try {
        REG = await getJson('/registry');
        /* 读不到注册表 = 代理不在（这一页所有数据都经它）：当场说清并收工 */
        if (!REG) { if (mine()) showProxyDown('代理没响应'); return; }
        if (!mine()) return;
        const configured = await loadConfigured(REG);
        if (!mine()) return;
        await loadBalances(REG, configured);
        if (!mine()) return;
        const b = await loadBills();
        if (!mine()) return;
        bills.value = b;
        renderChart();
        renderAiStat();
        renderVoiceStat();
        renderBills();
        /* 状态行把这一趟的失败与截断一起说出来 */
        let s = '更新于 ' + window.fmtHMS(Date.now());
        if (billErr.value) s += ' · 生成记录读取失败：' + billErr.value;
        const errN = Object.keys(billErrs.value || {}).length;
        if (errN) s += ' · 有 ' + errN + ' 个来源没读回来（见账单上方）';
        if (billMore.value) s += ' · 账单只读了各平台最近 2 页';
        if (mine()) upd.value = s;
      } catch (e) {
        if (mine()) upd.value = '加载出错：' + e.message;
      } finally { if (mine()) reloading.value = false; }
    }

    /* 导出当前筛选出的账单（不是只导出屏幕上那 300 行） */
    function exportBills() {
      if (!curBillRows.value.length) { window.Toast.warn('当前没有可导出的账单'); return; }
      const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
      /* 表头必须与数据行一一对应（9 列） */
      const head = ['时间', '平台', '类型', '描述', '任务/资产ID', '状态', '花费', '单位', 'tokens'];
      const lines = [head.map(q).join(',')].concat(curBillRows.value.map(b => [
        window.fmtWhenSec(b.ts), b.platform || '', b.what || '', b.desc || '',
        b.genId || '', b.status || '', b.cost == null ? '' : b.cost, b.unit || '', b.tokens == null ? '' : b.tokens,
      ].map(q).join(',')));
      // 加 BOM：Excel 打开中文不乱码
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      window.Net.save(blob, '用量账单-' + new Date().toISOString().slice(0, 10) + '.csv');
      window.Toast.receipt('已导出 ' + curBillRows.value.length + ' 条账单');
    }

    function onBillNoteClick(e) {
      const t = e.target && e.target.closest ? e.target.closest('#billRetry') : null;
      if (t) { e.preventDefault(); reloadAll(); }
    }

    /* 筛选件的值在事件里当场落进 ref 再重算：v-model 的指令监听与模板上的 @input / @change
       谁先挂上没有保证，只读 ref 会慢一拍（打一个字才筛上一个字）。 */
    function onPlatformChange(e) { fPlatform.value = e.target.value; renderBills(); }
    function onRangeChange(e) { fRange.value = e.target.value; renderBills(); }
    function onQInput(e) { fQ.value = e.target.value; renderBills(); }

    const chartIcon = window.icon ? window.icon('chart', 18) : '';
    const refreshIcon = window.icon ? window.icon('refresh', 13) : '';

    onMounted(async () => {
      try {
        /* 外壳空闲时才会补 workbench.js；这里等它一次，账单上方的重试提示就有着落。
           它没就绪也照常往下走（那一块提示会退回空串，别的面板不受影响）。 */
        await window.__spaLoadScript('web/ui/workbench.js', () => window.Wb);
      } catch (e) {
        console.warn('[usage] workbench.js 没就绪：', e && e.message);
      }
      if (!window.Api || !window.AssetLib || !window.TextAI || !window.Net || !window.Toast) {
        failed.value = '公共模块没有就绪（ui.js / assetlib.js）';
        if (window.PageReport) PageReport.pageFail('用量', failed.value);
        reloading.value = false;
        return;
      }
      await nextTick();
      /* 模板里那几颗静态 `<span data-icon>`：ui.js 的 fillIcons 只在外壳 DOMContentLoaded 跑过一次，
         那时本页还没挂载 —— 不在这里补一遍，按钮上的图标是空的。 */
      if (rootEl.value) window.fillIcons(rootEl.value);
      try { if (window.Dropdowns && rootEl.value) window.Dropdowns.build(rootEl.value); }
      catch (e) { console.warn('[usage] Dropdowns.build 失败：', e && e.message); }
      try {
        await reloadAll();
      } finally {
        window.dispatchEvent(new Event('sb-balance-refresh'));
      }
    });

    return {
      retryLoad: () => { if (window.__spaReload) window.__spaReload(); },
      rootEl, chartUnitsEl, fPlatformEl,
      reloading, failed, upd,
      balanceCards, balanceLoading, balanceTip,
      chartHtml,
      voiceStat, voiceEmpty, voiceModelRows, voiceRecentRows,
      aiLoaded, aiStat, aiPriceNote, aiModelRows, aiDailyRows,
      bills, billMore, billErrs, billErr, billLoading, billDownHtml, billNoteHtml, billCntText, billRows, curBillRows,
      platformOptions, fPlatform, fRange, fQ,
      reloadAll, renderBills, exportBills, onBillNoteClick, onPlatformChange, onRangeChange, onQInput, billRowTitle,
      fmtWhen: window.fmtWhen, chartIcon, refreshIcon,
    };
  },
  render,
};
