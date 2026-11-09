/* ============================================================================
   设置页「供应商与密钥」的账号卡流 —— 一家账号一张卡，六档能力同一层级
   ---------------------------------------------------------------------------
   六档 = 图片生成 / 视频生成 / 语音合成 / 文字 AI / 语音识别 / 联网搜索。
   前四档是「一类平台」（名字与顺序现读 ui.js 的 provKinds()），后两档是这家账号
   另外两种接法；六档在卡顶能力格、筛选芯片、型号面板与「添加能力」里都平级，
   不再把识别 / 搜索塞进文字档的开关里。

   这一层管：
     · 归并（注册表里的几条 provider 按存密钥的 keyId 并成一家 + 本机识别那张常驻卡）；
     · 每一档的状态牌（主位 / 在用 / 备用 / 停用）与点它做什么；
     · 卡上的草稿（密钥、清除、暂时不用、「作用文字 AI」那一家）—— 改完先留在内存，
       由页面的自动保存落盘；
     · 「添加能力」（只给自定义账号：打开多能力表单；默认供应商不再临时补档）、
       撤掉旧数据里手动补的档、型号面板的槽位（keyId:档）；
     · 「添加供应商」那张虚线卡的预设形态与整片重画 / 事件委托。

   数据与副作用一件都不重写：注册表、环境密钥、型号面板的读写、两条通道的设置、
   自动保存与目录轨都留在页面那一份，跨这一层只走 createAccountCards(deps)。
   ========================================================================== */

import { ref } from '../../../vue.runtime.esm-browser.prod.js';

const SERVICE_CAPS = ['asr', 'search'];
const EXTRA_ZH = { asr: '语音识别', search: '联网搜索' };
const LOCAL_ASR_KID = '__local_asr__';
const CAP_GLYPH = { image: '图', video: '视', audio: '音', text: '字', asr: '识', search: '搜' };
export const capZh = id => EXTRA_ZH[id]
  || (window.provKindZh ? window.provKindZh(id) : String(id || ''));
export const capGlyph = id => CAP_GLYPH[id] || '·';
const SOLO_CAP = new Set(['text', 'asr', 'search']);

export function createAccountCards(deps) {
  const {
    ic, q, qa,
    provEpoch, setDocEl, acctToolsEl, provListEl, provErrEl, acctParkEl,
    asrFormEl, asrLocalFormEl, searchFormEl, cusCardEl, cusShown,
    regOf, envOf, textFormOf,
    markChanged, msgOf, useFormCreds, autofetchTried, onPanelClick, onPanelChange,
    syncServiceProvs, openCus, hideCus, pickCusCap, editCus, removeCus, afterCustomChanged,
    asr, asrLocal, asrBrowser, search,
  } = deps;

  const acctFilter = ref('all');
  const keyOpen = new Set();
  const panelOpen = new Set();
  const pendingAdds = new Set();
  let textPickDraft = '';
  const keyDraft = new Map();
  const keyCleared = new Set();
  const acctOffSet = new Map();
  const provRows = new Map();
  let lastAcctAll = [];
  let acctSumPainter = null;

  const keyFor = id => window.LS.get('sk_key_' + id) || '';
  const draftKey = kid => (keyCleared.has(kid) ? ''
    : (keyDraft.has(kid) ? keyDraft.get(kid) : keyFor(kid)));

  const allCaps = () => (window.provKinds ? window.provKinds() : [])
    .concat(SERVICE_CAPS);

  function curTextId() {
    const list = window.TextAI ? TextAI.all(regOf()) : [];
    if (!list.length) return '';
    if (textPickDraft) return textPickDraft;
    const saved = TextAI.savedProv(regOf());
    return saved ? saved.id : ((TextAI.prov(regOf()) || list[0]).id);
  }
  const kidOfProv = id => {
    const p = (regOf().providers || []).find(x => x.id === id);
    return p ? String(p.keyId || p.id) : '';
  };
  function autoServiceKid(cap) {
    const list = (regOf().providers || []).filter(p => (p.extraCaps || []).indexOf(cap) >= 0
      && p[cap]);
    const seen = new Set();
    const hit = [];
    for (const p of list) {
      const kid = String(p.keyId || p.id);
      if (seen.has(kid)) continue;
      seen.add(kid);
      const m = lastAcctAll.find(x => x.keyId === kid);
      if (m && provUsable(m)) hit.push({ p, kid });
    }
    if (cap === 'search') {
      const api = hit.find(x => x.p.search && x.p.search.style === 'api');
      if (api) return api.kid;
    }
    return hit.length ? hit[0].kid : '';
  }
  function asrEffectiveRoute() {
    const r = asr.route;
    if (r !== 'auto') return r;
    if (asrBrowser.value && asrBrowser.value.complete) return 'browser';
    if (asrLocal.value && asrLocal.value.available) return 'local';
    return 'service';
  }
  function priKidOf(cap) {
    if (cap === 'text') return kidOfProv(curTextId());
    if (cap === 'asr') {
      const route = asrEffectiveRoute();
      if (route === 'browser' || route === 'local') return LOCAL_ASR_KID;
      const pid = asr.service.providerId;
      return kidOfProv(pid) || autoServiceKid('asr');
    }
    if (cap === 'search') {
      if (!search.enabled) return '';
      const pid = String(search.provider || '');
      if (pid === 'tavily') return '';
      if (!pid || pid === 'auto') return autoServiceKid('search');
      return kidOfProv(pid);
    }
    return '';
  }
  function hostKidOf(cap) {
    if (cap === 'text') return kidOfProv(curTextId());
    if (cap !== 'asr' && cap !== 'search') return '';
    const list = listedAccounts(lastAcctAll).filter(m => m.caps.indexOf(cap) >= 0 && !m.local);
    if (!list.length) return '';
    let want = '';
    if (cap === 'asr') {
      want = kidOfProv(asr.service.providerId);
      if (!want) want = autoServiceKid('asr');
    } else {
      const pid = String(search.provider || '');
      if (pid && pid !== 'auto' && pid !== 'tavily') want = kidOfProv(pid);
      else if (!pid || pid === 'auto') want = autoServiceKid('search');
    }
    if (want && list.some(m => m.keyId === want)) return want;
    const usable = list.find(m => provUsable(m));
    return (usable || list[0]).keyId;
  }

  /* ---------- 归并：一家账号一张卡 ---------- */
  function provGroups() {
    const merged = new Map();
    (regOf().providers || []).forEach(p => {
      const keyId = p.keyId || p.id;
      let m = merged.get(keyId);
      if (!m) {
        m = { keyId, names: [], byKind: new Map(), serviceProvs: new Map(), caps: [],
          credits: null, site: '', base: p.base || '', prov: p, custom: !!p.custom,
          shapeName: p.customShapeName || '', accountName: '', manualCaps: new Set() };
        merged.set(keyId, m);
      }
      m.names.push(p.name);
      if (!m.accountName && p.accountName) m.accountName = String(p.accountName);
      if (!m.site && p.site) m.site = p.site;
      if (!m.base && p.base) m.base = p.base;
      if (p.serviceOnly) {
        (p.extraCaps || []).forEach(c => {
          if (SERVICE_CAPS.indexOf(c) >= 0 && !m.serviceProvs.has(c)) m.serviceProvs.set(c, p);
        });
      } else if (!m.byKind.has(p.kind)) {
        m.byKind.set(p.kind, p);
      }
      (p.extraCaps || []).forEach(c => {
        if (SERVICE_CAPS.indexOf(c) >= 0 && !m.serviceProvs.has(c)) m.serviceProvs.set(c, p);
      });
      if (p.endpoints && p.endpoints.credits && !m.credits) {
        m.credits = { relay: p.relay, ep: p.endpoints.credits, p };
      }
    });
    const all = [...merged.values()];
    all.forEach(m => {
      m.name = m.accountName || (m.names[0] || '').split(' ')[0];
      const kinds = window.provKinds().filter(k => m.byKind.has(k));
      const service = SERVICE_CAPS.filter(c => m.serviceProvs.has(c));
      m.caps = kinds.concat(service);
      m.manualCaps = new Set();
      m.caps.forEach(cap => {
        const p = rawProvOfCap(m, cap);
        if (p && p.manual) m.manualCaps.add(cap);
      });
      m.kindLabel = m.caps.map(capZh).join('+');
      m.prov = capProv(m, m.caps[0]) || m.prov;
      m.custom = [...m.byKind.values(), ...m.serviceProvs.values()].every(p => !!p.custom);
    });
    all.push({
      keyId: LOCAL_ASR_KID, names: ['本机 / 浏览器内识别'], name: '本机 / 浏览器内识别',
      byKind: new Map(), serviceProvs: new Map(), caps: ['asr'], kindLabel: '语音识别', local: true,
      credits: null, site: '', base: '', custom: false, shapeName: '', manualCaps: new Set(),
      prov: { id: LOCAL_ASR_KID, keyId: LOCAL_ASR_KID, kind: 'text', name: '本机 / 浏览器内识别',
        base: '', endpoints: {}, extraCaps: ['asr'], local: true, serviceOnly: true },
    });
    return all;
  }
  function rawProvOfCap(m, cap) {
    if (!m) return null;
    if (cap === 'asr' || cap === 'search') return m.serviceProvs.get(cap) || null;
    return m.byKind.get(cap) || null;
  }
  /* 面板与型号偏好都读这一份：识别 / 搜索共用一条 carrier 时，槽位仍按 asr / search 分。 */
  function capProv(m, cap) {
    const p = rawProvOfCap(m, cap);
    if (!p) return null;
    if (cap === 'asr' || cap === 'search') return Object.assign({}, p, { modelKind: cap });
    return p;
  }
  function verifyProv(m) {
    const list = window.provKinds().map(k => m.byKind.get(k)).filter(Boolean);
    return list.find(p => p.endpoints && p.endpoints.credits)
      || list.find(p => p.endpoints && p.endpoints.models)
      || m.byKind.get('text') || list[0] || m.prov;
  }
  function keyState(m) {
    if (m.local) return '无需密钥';
    if (draftKey(m.keyId)) return '已填密钥';
    if ((envOf()[m.keyId] || {}).hasEnv) return '用服务端密钥';
    return '还没填密钥';
  }
  function provUsable(m) {
    if (m.local) return true;
    return (window.Api && Api.provUsable) ? Api.provUsable({ keyId: m.keyId, id: m.prov.id, custom: m.custom }, envOf())
      : (!!m.custom || keyState(m) !== '还没填密钥');
  }
  const acctOff = m => m.local ? false : (acctOffSet.has(m.keyId)
    ? acctOffSet.get(m.keyId)
    : (window.Api ? Api.isOff(m.prov) : false));
  function capState(m, cap) {
    if (!provUsable(m) || acctOff(m)) return 'off';
    if (SOLO_CAP.has(cap)) return priKidOf(cap) === m.keyId ? 'pri' : 'alt';
    return 'on';
  }
  const CAP_STATE_ZH = { pri: '主位', on: '在用', alt: '备用', off: '停用' };
  function capsShownOf(m) {
    const cap = acctFilter.value;
    if (!cap || cap === 'all' || m.caps.indexOf(cap) < 0) return m.caps;
    return [cap].concat(m.caps.filter(c => c !== cap));
  }
  function keySourceOf(kid) {
    if (keyCleared.has(kid) && window.LS.get('sk_key_' + kid)) {
      return { short: '正在存进本机…', tip: '存好之前旧密钥还在用。' };
    }
    const local = !!draftKey(kid);
    const env = !!(envOf()[kid] && envOf()[kid].hasEnv);
    if (local && env) return { short: '设置页存着一把', tip: '留空 = 改回 .env。' };
    if (local) return { short: '设置页里存着的（sk_key_' + kid + '）', tip: '点「清除」才会真的没有。' };
    if (env) return { short: '服务端环境密钥（.env）', tip: '来自 .env 或系统环境变量' };
    return { short: '还没有密钥', tip: '在上面填一把，或在 .env 里配同名变量' };
  }
  const keySourceNote = kid => keySourceOf(kid).short;
  function refreshProvNotes() {
    qa('[data-ksrc]').forEach(sp => {
      const kid = sp.dataset.ksrc;
      if (!kid) return;
      const s = keySourceOf(kid);
      sp.textContent = s.short;
      sp.title = s.tip;
    });
    if (acctSumPainter) acctSumPainter();
  }

  /* ---------- 型号面板的槽位 ---------- */
  const slotKey = (kid, cap) => String(kid) + ':' + String(cap);
  const slotKid = s => String(s || '').slice(0, Math.max(0, String(s || '').lastIndexOf(':')));
  const slotCap = s => String(s || '').slice(String(s || '').lastIndexOf(':') + 1);
  const slotOfProv = p => (p ? slotKey(p.keyId || p.id, p.modelKind || p.kind) : '');
  function provBySlot(slot) {
    const m = provRows.get(slotKid(slot));
    return m ? capProv(m, slotCap(slot)) : null;
  }
  const fetchNote = new Map();

  function plateTitle(m, cap, st) {
    if (st === 'off') {
      if (acctOff(m)) return '点一下取消「暂时不用」（它名下 ' + m.kindLabel + ' 一起恢复）';
      return '还没接上：点「密钥」填一把';
    }
    if (!SOLO_CAP.has(cap)) {
      return '点一下把这一家「暂时不用」（它名下 ' + m.kindLabel + ' 一起停）';
    }
    return st === 'pri' ? '这一档现在走这家' : '点一下让这一档走这家';
  }
  function capPlateClick(m, cap) {
    const st = capState(m, cap);
    if (acctOff(m)) {
      acctOffSet.set(m.keyId, false);
      markChanged();
      renderProv();
      Toast.receipt('「' + m.name + '」已重新启用', 'ok');
      return;
    }
    if (st === 'off') {
      Toast.receipt('「' + m.name + '」还没接上，点「密钥」填一把', 'warn');
      keyOpen.add(m.keyId);
      renderProv();
      return;
    }
    if (!SOLO_CAP.has(cap)) {
      acctOffSet.set(m.keyId, true);
      markChanged();
      renderProv();
      Toast.receipt('「' + m.name + '」暂时不用（它名下 ' + m.kindLabel + ' 一起不进型号下拉）', 'ok');
      return;
    }
    if (st === 'pri') { Toast.receipt('这一档走「' + m.name + '」', 'info'); return; }
    const p = capProv(m, cap);
    if (cap === 'text') {
      textPickDraft = (p && p.id) || '';
      markChanged();
      renderProv();
      Toast.receipt('文字对话改走「' + m.name + '」（原本那家降为备用）', 'ok');
      return;
    }
    if (cap === 'asr') {
      if (m.local) {
        asr.route = (asrBrowser.value && asrBrowser.value.complete) ? 'browser'
          : (asrLocal.value && asrLocal.value.available) ? 'local' : 'browser';
        markChanged();
        renderProv();
        Toast.receipt('语音识别改走「本机 / 浏览器内」', 'ok');
        return;
      }
      asr.service.providerId = (p && p.id) || '';
      asr.service.model = '';
      asr.route = 'service';
      markChanged();
      renderProv();
      Toast.receipt('在线识别的渠道改成「' + m.name + '」', 'ok');
      return;
    }
    search.provider = (p && p.id) || 'auto';
    if (!search.enabled) search.enabled = true;
    if (search.credentialSource !== 'channel') search.credentialSource = 'channel';
    markChanged();
    renderProv();
    syncServiceProvs();
    Toast.receipt('联网搜索改走「' + m.name + '」', 'ok');
  }

  /* ---------- 卡内一行：能力名 · 状态牌 · 型号 n/m ---------- */
  function capRowHTML(m, cap) {
    const p = capProv(m, cap);
    if (!p) return '';
    const es = window.esc(slotKey(m.keyId, cap));
    const st = capState(m, cap);
    const open = panelOpen.has(slotKey(m.keyId, cap));
    const isManual = !!(m.manualCaps && m.manualCaps.has(cap));
    const currentModel = cap === 'asr'
      ? (m.local ? (asrEffectiveRoute() === 'browser' ? '浏览器内 Whisper'
        : asrEffectiveRoute() === 'local' ? '本机 whisper.cpp' : '在线服务')
        : (asr.service.model || (p.asr && p.asr.model) || ''))
      : cap === 'search'
        ? ((p.search && p.search.style === 'chat') ? (search.model || '') : '')
        : '';
    return '<div class="crow' + (st === 'off' ? ' dim' : '') + '" data-crow="' + es + '">'
      + '<span class="cn"><span class="cg">' + capGlyph(cap) + '</span>' + window.esc(capZh(cap))
        + (isManual ? '<i class="manual" title="手动加的">手动</i>' : '')
      + '</span>'
      + '<button class="st st-btn ' + st + '" type="button" data-cap-toggle="' + es + '"'
        + ' title="' + window.esc(plateTitle(m, cap, st)) + '">' + CAP_STATE_ZH[st] + '</button>'
      + (currentModel
        ? '<span class="hint sm"><code>' + window.esc(currentModel) + '</code></span>' : '')
      + (m.local ? ''
        : '<button class="ghost mini' + (open ? ' active' : '') + '" type="button" data-panel="' + es + '"'
          + ' title="' + (open ? '收起型号清单' : '展开型号清单') + '">'
          + (open ? '收起型号 ' : '型号 ') + '<b data-mcount="' + es + '"></b></button>')
      + (isManual ? '<button class="ghost mini" type="button" data-cap-rm="' + es + '">撤掉</button>' : '')
      + (cap === 'text'
        ? '<div class="crow-sub"><span class="hint sm">润色型号</span>'
          + '<select class="sel" data-tmodel="' + window.esc(m.keyId) + '" aria-label="全站润色用的文字型号"></select>'
          + '<button class="ghost" type="button" data-ttest="' + es + '" title="发测试消息">测试</button></div>'
        : '')
      + '</div>'
      + (isManual && (cap === 'asr' || cap === 'search')
        ? '<div class="manual-note">走这家自己的地址与密钥。</div>' : '');
  }
  function priFormHTML(m, cap) {
    if (cap === 'text') return '';
    if (cap === 'asr') return '<div class="formslot" data-formslot="' + (m.local ? 'asrLocal' : 'asr') + '"></div>';
    if (cap === 'search') return '<div class="formslot" data-formslot="search"></div>';
    return '';
  }
  function modelPanelHTML(m, cap) {
    const slot = slotKey(m.keyId, cap);
    const es = window.esc(slot);
    const p = capProv(m, cap);
    const text = cap === 'text' && !!(p && p.kind === 'text' && !p.serviceOnly);
    const service = cap === 'asr' || cap === 'search';
    const canFetch = !service && !!(p && !p.serviceOnly && (text || (p.endpoints && p.endpoints.models)));
    return '<div class="mpanel" data-mblk="' + es + '">'
      + '<div class="mpanel-h"><span class="t">型号清单 · ' + window.esc(capZh(cap)) + '</span>'
        + '<span class="st alt" data-mfetch="' + es + '">还没取过</span><span class="sp"></span>'
        + (canFetch
          ? '<button class="ghost mini" type="button" data-tfetch="' + es + '" title="只读，不花钱">取一次型号清单</button>'
          : '')
      + '</div>'
      + '<div class="mpanel-h"><span class="hint" data-mnote="' + es + '"></span></div>'
      + '<div class="mlist" data-tchips="' + es + '"></div>'
      + '<div class="krow thin"><span class="kn">添加型号</span>'
        + '<input data-tmnew="' + es + '" placeholder="型号 id，逗号分隔多个">'
        + '<button class="ghost" type="button" data-tadd="' + es + '">添加</button></div>'
      + (text
        ? '<div class="mpanel-h"><span class="t">型号的输入能力</span><span class="sp"></span>'
          + '<span class="hint">每行右侧 图 / 音 / 视：自动 → 支持 → 不支持</span></div>'
        : '')
      + '<div class="msg" data-pmsg="' + es + '"></div>'
      + '</div>';
  }

  /* ---------- 「添加能力」：只给自定义账号 ----------
     内置账号的能力以注册表声明为准，不在卡上临时补档；要接新协议请用「添加供应商」
     新建一家，「默认供应商」卡从此不再出现「＋ 添加能力」。旧数据里已经手动补上的
     那一档仍按 `manual` 标记显示，可单独「撤掉」。 */
  function capAddHTML(m) {
    if (m.local || !m.custom) return '';
    return '<div class="capadd"><button class="ghost mini" type="button" data-cap-add-open="'
      + window.esc(m.keyId) + '">＋ 添加能力</button></div>';
  }
  function removeManualCap(m, cap) {
    const list = Api.customList();
    const e = list.find(x => x && String(x.keyId) === String(m.keyId) && x.id !== m.keyId);
    if (!e) return;
    e.caps = (Array.isArray(e.caps) ? e.caps : []).filter(c => c && c.kind !== cap);
    if (e.caps.length) {
      if (!Api.customSet(list)) { Toast.err('没写进本机存储：先清一次缓存'); return; }
    } else {
      if (!Api.customDrop(e.id)) { Toast.err('没写进本机存储：先清一次缓存'); return; }
    }
    if (window.ModelPrefs && window.ModelPrefs.dropKind) window.ModelPrefs.dropKind(m.keyId, cap);
    /* 正在走这一档的设置回自动：删掉之后不能让服务端继续指着一个不存在的 provider。 */
    const p = rawProvOfCap(m, cap);
    if (cap === 'asr' && p && (asr.service.providerId === p.id || asr.service.providerId === p.keyId)) {
      asr.service.providerId = '';
      asr.service.model = '';
      markChanged();
    }
    if (cap === 'search' && p && (search.provider === p.id || search.provider === p.keyId)) {
      search.provider = 'auto';
      markChanged();
    }
    afterCustomChanged()
      .then(() => Toast.receipt('已撤掉「' + m.name + '」的「' + capZh(cap) + '」', 'ok'))
      .catch(err => Toast.err('撤掉之后刷新注册表失败：' + errText(err)));
  }

  function capStripHTML(m) {
    return '<div class="capstrip">' + capsShownOf(m).map(cap => {
      const st = capState(m, cap);
      return '<button class="capcell ' + st + (acctFilter.value === cap ? ' hit' : '') + '" type="button"'
        + ' data-cap-toggle="' + window.esc(slotKey(m.keyId, cap)) + '"'
        + ' title="' + window.esc(capZh(cap) + ' · ' + CAP_STATE_ZH[st] + ' —— ' + plateTitle(m, cap, st)) + '">'
        + capGlyph(cap) + '</button>';
    }).join('') + '</div>';
  }
  function keyRowHTML(m) {
    const kid = window.esc(m.keyId);
    const ph = m.custom ? '这一家的密钥'
      : (envOf()[m.keyId] || {}).hasEnv ? '服务端密钥，留空即可' : '填写密钥，或使用默认';
    return '<div class="krow thin keyrow"><span class="kn">密钥</span>'
      + '<input type="password" data-key="' + kid + '" value="' + window.esc(draftKey(m.keyId)) + '"'
      + ' placeholder="' + window.esc(ph) + '">'
      + '<button class="ghost eye" type="button" data-eye="' + kid + '" title="显示 / 隐藏密钥">' + ic('eye', 13) + '</button>'
      + '<button class="ghost clr" type="button" data-clr="' + kid + '" title="清掉本机密钥">清除</button>'
      + '<button class="ghost" type="button" data-vfy="' + kid + '" title="只读验证，不扣费">验证</button>'
      + '</div>'
      + '<div class="krow thin"><span class="hint sm" data-ksrc="' + kid + '"'
        + ' title="' + window.esc(keySourceOf(m.keyId).tip) + '">' + window.esc(keySourceNote(m.keyId)) + '</span></div>'
      + '<div class="msg" data-msg="' + kid + '"></div>';
  }
  function keyBadge(m) {
    const s = keyState(m);
    return { cls: s === '已填密钥' ? 'ok' : (s === '用服务端密钥' || s === '无需密钥') ? 'on' : 'alt', zh: s };
  }
  function localAccountCardHTML(m) {
    const kid = window.esc(m.keyId);
    return '<div class="acct fcard local-asr" data-acct="' + kid + '">'
      + '<div class="fcard-h"><span class="fcard-ic">本</span>'
        + '<div class="fcard-tt"><div class="fcard-t"><span>本机 / 浏览器内识别</span></div></div>'
        + '<span class="fcard-badge"><span class="st on">无需密钥</span></span></div>'
      + capStripHTML(m)
      + '<div class="acct-mid" data-mid="' + kid + '">'
        + capsShownOf(m).map(cap => capRowHTML(m, cap) + priFormHTML(m, cap)).join('')
      + '</div></div>';
  }
  function balChipHTML(m) {
    if (!m.credits || !window.SbBalance) return '';
    const r = SbBalance.rowOf(m.keyId);
    const unit = r ? String(r.unit || '').trim() : '';
    const body = !r ? '<b>…</b>'
      : r.failed ? '<b>读取失败</b>'
        : '<b>' + window.esc(r.avail) + '</b>' + (unit ? '<span class="u">' + window.esc(unit) + '</span>' : '');
    const tip = !r ? '正在查这一家的余额…'
      : r.failed ? String(r.why || '查询失败')
        : '可用 ' + r.avail + (unit ? ' ' + unit : '') + ' · 冻结 ' + r.frozen + (unit ? ' ' + unit : '');
    return '<span class="balnow' + (r && r.failed ? ' err' : '') + '" data-balnow="' + window.esc(m.keyId) + '"'
      + ' title="' + window.esc(tip) + '"><span class="k">余额</span>' + body + '</span>';
  }
  function paintAccountBalances() {
    qa('[data-balnow]').forEach(el => {
      const m = provRows.get(el.dataset.balnow);
      if (!m) return;
      const box = document.createElement('span');
      box.innerHTML = balChipHTML(m);
      if (box.firstElementChild) el.replaceWith(box.firstElementChild);
    });
  }
  let balAskAt = 0, balAsking = false;
  function ensureBalances() {
    const S = window.SbBalance;
    if (!S || !S.fetchRows || balAsking) return;
    if (Date.now() - balAskAt < 60000) return;
    const want = lastAcctShown.filter(m => m.credits && m.credits.p && !S.rowOf(m.keyId));
    if (!want.length) return;
    balAskAt = Date.now();
    balAsking = true;
    S.fetchRows(want.map(m => ({ kid: m.keyId, name: m.name, p: m.credits.p })))
      .then(paintAccountBalances).catch(() => {}).then(() => { balAsking = false; });
  }
  function accountCardHTML(m) {
    if (m.local) return localAccountCardHTML(m);
    const kid = window.esc(m.keyId);
    const off = acctOff(m);
    const kb = keyBadge(m);
    const open = keyOpen.has(m.keyId) || pendingAdds.has(m.keyId);
    const mid = (open ? keyRowHTML(m) : '')
      + capsShownOf(m).map(cap => capRowHTML(m, cap)
        + (((cap === 'asr' && m.local) || hostKidOf(cap) === m.keyId) ? priFormHTML(m, cap) : '')
        + (panelOpen.has(slotKey(m.keyId, cap)) ? modelPanelHTML(m, cap) : '')).join('')
      + capAddHTML(m);
    return '<div class="acct fcard' + (off ? ' acct-off' : '') + (m.custom ? ' cus' : '')
      + '" data-acct="' + kid + '">'
      + '<div class="fcard-h"><span class="fcard-ic">' + window.esc((m.name || '?').slice(0, 1).toUpperCase()) + '</span>'
        + '<div class="fcard-tt"><div class="fcard-t">'
          + (m.site
            ? '<a class="site" href="' + window.esc(m.site) + '" target="_blank" rel="noopener" title="打开官网 '
              + window.esc(m.site) + '">' + window.esc(m.name) + '</a><span class="ext">↗</span>'
            : '<span>' + window.esc(m.name) + '</span>')
          + '<button class="keytoggle' + (open ? ' on' : '') + '" type="button" data-ktoggle="' + kid + '"'
            + ' title="密钥设置">密钥 ' + (open ? '▴' : '▾') + '</button>'
          + (m.custom ? '<span class="st alt">自定义</span>' : '')
          + '</div><div class="fcard-s">' + window.esc(m.kindLabel) + '</div></div>'
        + '<span class="fcard-badge"><span class="st ' + kb.cls + '">' + kb.zh + '</span></span></div>'
      + capStripHTML(m)
      + '<div class="acct-mid" data-mid="' + kid + '">' + mid + '</div>'
      + '<div class="fcard-acts">'
        + '<label class="check' + (m.credits ? '' : ' dim') + '"'
          + (m.credits ? '' : ' title="这一家没有余额查询接口，勾了也不显示"')
          + '"><input type="checkbox" data-bal="' + kid + '"' + (window.SbBal && SbBal.isOff(m.keyId) ? '' : ' checked') + '>侧栏余额</label>'
        + '<label class="check" title="勾上 = 不进工作台的型号下拉（它名下 '
          + window.esc(m.kindLabel) + ' 一起停，历史任务照常能看）">'
          + '<input type="checkbox" data-off="' + kid + '"' + (off ? ' checked' : '') + '>暂时不用</label>'
        + '<span class="sp"></span>'
        + (m.custom
          ? '<button class="ghost mini" type="button" data-cedit="' + kid + '">编辑</button>'
            + '<button class="ghost mini danger" type="button" data-cdel="' + kid + '">删除</button>'
          : '')
        + '<span class="hint sm" data-acctmsg="' + kid + '"></span>'
        + balChipHTML(m)
      + '</div></div>';
  }

  /* ---------- 「添加供应商」那张卡 ---------- */
  function presetAccounts(all) {
    return all.filter(m => !m.custom && !provUsable(m) && !pendingAdds.has(m.keyId));
  }
  function presetRowHTML(m) {
    const glyphs = m.caps.map(capGlyph).join('');
    return '<div class="preset"><span class="pg">' + window.esc((m.name || '?').slice(0, 1).toUpperCase()) + '</span>'
      + '<div class="pw"><span class="pn">' + window.esc(m.name) + '</span>'
      + '<span class="pnote">' + window.esc(m.base)
      + ((envOf()[m.keyId] || {}).hasEnv ? ' · <code>.env</code> 里已有密钥' : '') + '</span></div>'
      + '<span class="pcaps" title="' + window.esc(m.kindLabel) + '">' + glyphs + '</span>'
      + '<button class="ghost mini" type="button" data-preset="' + window.esc(m.keyId) + '">添加</button></div>';
  }
  function addTileHTML(all) {
    const rest = presetAccounts(all);
    const custom = cusShown.value;
    return '<div class="acct fcard add-tile' + (custom ? ' cus-open' : '') + '" data-acct="__add__">'
      + '<div class="fcard-h">'
        + '<div class="fcard-tt"><div class="fcard-t"><span>'
          + (custom ? '添加自定义供应商' : '添加供应商') + '</span></div></div>'
      + (custom
        ? '<span class="fcard-badge"><span class="st alt">编辑中</span></span>'
        : '<span class="fcard-badge"><span class="st alt">待接入 ' + rest.length + '</span></span>')
      + '</div>'
      + (custom
        ? '<div class="acct-mid" data-mid="__add__"><div class="formslot" data-formslot="cus"></div></div>'
        : '<div class="acct-mid" data-mid="__add__">'
          + (rest.length ? rest.map(presetRowHTML).join('')
            : '<div class="mlist-empty">注册表里的都请进来了。</div>')
          + '<button class="ghost" type="button" data-cus-open="1">＋ 自定义（中转站 / 网关 / 企业部署）</button>'
          + '</div>')
      + '</div>';
  }

  /* ---------- 芯片 / 摘要条 ---------- */
  let lastAcctShown = [];
  function paintSumLine() {
    const el = q('[data-fsum]');
    if (!el) return;
    const all = lastAcctAll;
    if (window.Api && Api.regFailed && Api.regFailed()) {
      el.className = 'fsum err';
      el.innerHTML = '<b>读不到注册表</b><span class="hint sm">代理未启动 —— 跑启动.bat 再刷新。</span>';
      return;
    }
    const cap = acctFilter.value;
    const cloud = all.filter(m => !m.local);
    const noKey = cloud.filter(m => !provUsable(m)).length;
    const localN = all.length - cloud.length;
    if (cap === 'all') {
      el.className = 'fsum';
      el.innerHTML = '<b>' + all.length + ' 家账号</b><span class="hint sm">已配 '
        + (cloud.length - noKey) + ' · 待配 ' + noKey
        + (localN ? ' · 本机 ' + localN : '') + '</span>';
      return;
    }
    const list = lastAcctShown;
    const on = list.filter(m => { const s = capState(m, cap); return s === 'pri' || s === 'on'; }).length;
    const alt = list.filter(m => capState(m, cap) === 'alt').length;
    const off = list.length - on - alt;
    el.className = 'fsum';
    el.innerHTML = '<b>做「' + window.esc(capZh(cap)) + '」的 ' + list.length + ' 家</b>'
      + '<span class="hint sm">在用 ' + on + ' 家' + (alt ? ' · 备用 ' + alt + ' 家' : '')
      + (off ? ' · 没接上 ' + off + ' 家' : '') + '。</span>'
      + '<span class="sp"></span><button class="ghost mini" type="button" data-fchip="all">看全部 '
      + all.length + ' 家</button>';
  }
  let toolsWired = false;
  function paintTools() {
    const el = acctToolsEl.value;
    if (!el) return;
    const chip = (id, zh, n) => '<button class="fchip' + (acctFilter.value === id ? ' on' : '') + '"'
      + ' type="button" data-fchip="' + id + '" title="数字是账号数"><span>'
      + window.esc(zh) + '</span>' + (n == null ? '' : '<b class="n">' + n + '</b>') + '</button>';
    el.innerHTML = '<div class="filters">' + chip('all', '全部', lastAcctAll.length)
      + allCaps().map(c => chip(c, capZh(c), lastAcctAll.filter(m => m.caps.indexOf(c) >= 0).length)).join('')
      + '</div><div class="fsum" data-fsum></div>';
    acctSumPainter = paintSumLine;
    paintSumLine();
    if (!toolsWired) {
      toolsWired = true;
      el.addEventListener('click', ev => {
        const b = ev.target.closest && ev.target.closest('[data-fchip]');
        if (!b) return;
        ev.preventDefault();
        acctFilter.value = b.dataset.fchip;
        renderProv();
      });
    }
  }
  function paintRegErr() {
    const el = provErrEl.value;
    if (!el) return;
    const lines = [];
    if (window.Api && Api.regFailed && Api.regFailed()) {
      lines.push('读不到注册表：本地代理没连上或还没启动' + (Api.regError ? '（原因：' + Api.regError() + '）' : '')
        + '。先把 proxy.js 启动起来再刷新这一页。');
    }
    const cu = regOf().custom;
    const dropped = (cu && cu.dropped) || [];
    if (dropped.length || (cu && cu.reason)) {
      lines.push('有 ' + dropped.length + ' 条自定义平台没被本地代理认：'
        + dropped.map(d => '「' + d.id + '」' + d.why).join('；') + (cu.reason ? '（' + cu.reason + '）' : '') + '。');
    }
    const mp = regOf().modelPrefs;
    if (mp && mp.reason) {
      lines.push('「自己填的型号」与「隐藏 / 展示」那份记录读不懂：' + mp.reason
        + ' —— 修好之前这里勾了也不会变。');
    }
    el.innerHTML = lines.map(t => '<div class="msg err">' + window.esc(t) + '</div>').join('');
  }

  function listedAccounts(all) {
    return all.filter(m => provUsable(m) || pendingAdds.has(m.keyId));
  }
  function filteredAccounts() {
    const all = listedAccounts(lastAcctAll);
    const cap = acctFilter.value;
    const list = cap === 'all' ? all.slice() : all.filter(m => m.caps.indexOf(cap) >= 0);
    const rank = m => {
      if (cap === 'all') return 0;
      const s = capState(m, cap);
      return (s === 'pri' || s === 'on') ? 0 : (s === 'alt' ? 1 : 2);
    };
    return list.sort((a, b) => rank(a) - rank(b)
      || (cap === 'all' ? (a.custom === b.custom ? 0 : (a.custom ? 1 : -1)) : b.caps.length - a.caps.length));
  }

  function renderProv() {
    if (!provListEl.value) return;
    const repaintGrid = () => {
      lastAcctAll = provGroups();
      provEpoch.value++;
      provRows.clear();
      lastAcctAll.forEach(m => provRows.set(m.keyId, m));
      lastAcctShown = filteredAccounts();
      paintTools();
      paintRegErr();
      provListEl.value.innerHTML = lastAcctShown.map(accountCardHTML).join('') + addTileHTML(lastAcctAll);
      lastAcctShown.forEach(m => {
        if (m.custom || !(envOf()[m.keyId] || {}).hasEnv) return;
        const lk = keyFor(m.keyId);
        if (!lk || lk.slice(-4) !== envOf()[m.keyId].tail || lk.length !== envOf()[m.keyId].len) return;
        keyDraft.delete(m.keyId);
        keyCleared.add(m.keyId);
        markChanged();
        const inp = q('[data-key="' + window.esc(m.keyId) + '"]');
        if (inp) inp.value = '';
      });
      const tf = textFormOf(); if (tf) tf.paint();
      placeForms();
      wireAcct();
      if (window.Dropdowns && provListEl.value) Dropdowns.build(provListEl.value);
    };
    window.Wb.viewport.keep(setDocEl.value, repaintGrid);
    syncServiceProvs();
    ensureBalances();
  }

  let acctWired = false;
  function setMsg(kid, text, cls) {
    const el = msgOf(kid);
    if (!el) return;
    el.className = cls; el.textContent = text;
  }
  function acctMsg(kid, text, cls) {
    const el = q('[data-acctmsg="' + window.esc(kid) + '"]');
    if (!el) return;
    el.className = 'hint sm ' + (cls || '');
    el.textContent = text;
  }
  const MOVERS = () => [['asr', asrFormEl.value], ['asrLocal', asrLocalFormEl.value],
    ['search', searchFormEl.value], ['cus', cusCardEl.value]];
  function placeForms() {
    MOVERS().forEach(([cap, el]) => {
      if (!el) return;
      const slot = q('[data-formslot="' + cap + '"]');
      if (slot && el.parentNode !== slot) slot.appendChild(el);
      else if (!slot && acctParkEl.value && el.parentNode !== acctParkEl.value) acctParkEl.value.appendChild(el);
    });
  }

  async function verifyAccount(kid, btn) {
    const m = provRows.get(kid);
    if (!m) return;
    const p = verifyProv(m);
    btn.disabled = true;
    const via = window.Api ? Api.verifyTarget(p) : { via: '', label: '' };
    const to = p && p.base;
    if (!via.via) {
      setMsg(kid, via.label || '', 'msg');
      let r = { state: 'unknown', text: '' };
      try {
        useFormCreds(p);
        r = await TextAI.verifyKey(regOf(), p);
      } catch (e) { r.text = errText(e); }
      btn.disabled = false;
      const ok = r.state === 'ok';
      setMsg(kid, (ok ? '✓ ' : r.state === 'invalid' ? '✗ ' : '· ') + (r.text || '') + '（转发到 ' + to + '）',
        'msg ' + (ok ? 'ok' : r.state === 'invalid' ? 'err' : ''));
      return;
    }
    setMsg(kid, '正在问「' + via.label + '」…', 'msg');
    let r = { ok: false, detail: '', why: '' };
    try { r = await Api.verify(p, { key: draftKey(kid), base: null }); } catch (e) { r.why = errText(e); }
    btn.disabled = false;
    setMsg(kid, (r.ok ? '✓ ' : '✗ ') + (r.ok ? r.detail : r.why) + '（转发到 ' + to + '）', 'msg ' + (r.ok ? 'ok' : 'err'));
  }

  function openCusForm() {
    openCus();
    renderProv();
  }

  function onAcctClick(ev) {
    const t = ev.target;
    const kt = t.closest && t.closest('[data-ktoggle]');
    if (kt) {
      ev.preventDefault();
      const kid = kt.dataset.ktoggle;
      if (keyOpen.has(kid)) keyOpen.delete(kid); else keyOpen.add(kid);
      renderProv();
      if (keyOpen.has(kid)) { const inp = q('[data-key="' + window.esc(kid) + '"]'); if (inp) window.focusQuiet(inp); }
      return;
    }
    const cap = t.closest && t.closest('[data-cap-toggle]');
    if (cap) {
      ev.preventDefault();
      const m = provRows.get(slotKid(cap.dataset.capToggle));
      if (m) capPlateClick(m, slotCap(cap.dataset.capToggle));
      return;
    }
    const pn = t.closest && t.closest('[data-panel]');
    if (pn) {
      ev.preventDefault();
      const slot = pn.dataset.panel;
      if (panelOpen.has(slot)) panelOpen.delete(slot);
      else { panelOpen.add(slot); autofetchTried.delete(slot); }
      renderProv();
      if (panelOpen.has(slot)) {
        window.Wb.viewport.reveal(q('[data-mblk="' + window.esc(slot) + '"]'),
          { pin: q('[data-crow="' + window.esc(slot) + '"]') });
      }
      return;
    }
    const co = t.closest && t.closest('[data-cus-open]');
    if (co) { ev.preventDefault(); openCusForm(); return; }
    const cc = t.closest && t.closest('[data-cus-close]');
    if (cc) { ev.preventDefault(); hideCus(); return; }
    const ccp = t.closest && t.closest('[data-cuscap]');
    if (ccp) { ev.preventDefault(); pickCusCap(ccp.dataset.cuscap); return; }
    const cao = t.closest && t.closest('[data-cap-add-open]');
    if (cao) { ev.preventDefault(); editCus(cao.dataset.capAddOpen); return; }
    const crm = t.closest && t.closest('[data-cap-rm]');
    if (crm) {
      ev.preventDefault();
      const m4 = provRows.get(slotKid(crm.dataset.capRm));
      if (m4) removeManualCap(m4, slotCap(crm.dataset.capRm));
      return;
    }
    const pa = t.closest && t.closest('[data-preset]');
    if (pa) {
      ev.preventDefault();
      const kid = pa.dataset.preset;
      pendingAdds.add(kid);
      keyOpen.add(kid);
      renderProv();
      const inp = q('[data-key="' + window.esc(kid) + '"]');
      if (inp) { window.focusQuiet(inp); window.Wb.viewport.reveal(inp, { pin: inp.closest('.krow') }); }
      Toast.receipt('已把「' + ((provRows.get(kid) || {}).name || kid) + '」请进界面；填一把密钥才算接上', 'ok');
      return;
    }
    const eye = t.closest && t.closest('[data-eye]');
    if (eye) {
      ev.preventDefault();
      const inp = eye.closest('.krow') ? eye.closest('.krow').querySelector('[data-key]') : null;
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      eye.innerHTML = ic(inp.type === 'password' ? 'eye' : 'eyeOff', 13);
      eye.title = inp.type === 'password' ? '显示密钥' : '隐藏密钥';
      return;
    }
    const clr = t.closest && t.closest('[data-clr]');
    if (clr) {
      ev.preventDefault();
      const kid = clr.dataset.clr;
      const inp = clr.closest('.krow') ? clr.closest('.krow').querySelector('[data-key]') : null;
      if (inp) inp.value = '';
      keyDraft.delete(kid);
      keyCleared.add(kid);
      markChanged();
      clr.textContent = '已清除';
      clr.title = '已排队，顶栏回执照说';
      setTimeout(() => { clr.textContent = '清除'; clr.title = '清掉本机存的这把密钥'; }, 1500);
      refreshProvNotes();
      return;
    }
    const vf = t.closest && t.closest('[data-vfy]');
    if (vf) { ev.preventDefault(); verifyAccount(vf.dataset.vfy, vf); return; }
    const ce = t.closest && t.closest('[data-cedit]');
    if (ce) { ev.preventDefault(); editCus(ce.dataset.cedit); return; }
    const cd = t.closest && t.closest('[data-cdel]');
    if (cd) { ev.preventDefault(); removeCus(cd.dataset.cdel); return; }
  }
  function onAcctChange(ev) {
    const t = ev.target;
    const off = t.closest && t.closest('[data-off]');
    if (off) {
      acctOffSet.set(off.dataset.off, !!off.checked);
      markChanged();
      renderProv();
      return;
    }
    const bal = t.closest && t.closest('[data-bal]');
    if (bal) {
      if (window.SbBal) {
        const off2 = new Set(SbBal.off());
        if (bal.checked) off2.delete(bal.dataset.bal); else off2.add(bal.dataset.bal);
        SbBal.setList([...off2]);
      }
      markChanged();
    }
  }
  function onAcctInput(ev) {
    const t = ev.target;
    if (!(t.dataset && t.dataset.key)) return;
    keyCleared.delete(t.dataset.key);
    if (t.value.trim()) keyDraft.set(t.dataset.key, t.value.trim());
    else keyDraft.delete(t.dataset.key);
  }
  function wireAcct() {
    const el = provListEl.value;
    if (acctWired || !el) return;
    acctWired = true;
    el.addEventListener('click', onAcctClick);
    el.addEventListener('click', onPanelClick);
    el.addEventListener('change', onAcctChange);
    el.addEventListener('change', onPanelChange);
    el.addEventListener('input', onAcctInput);
  }

  const acctAll = () => lastAcctAll;
  const textPick = () => textPickDraft;
  const setTextPick = v => { textPickDraft = v || ''; };

  return {
    provGroups, provUsable, curTextId, autoServiceKid, hostKidOf, allCaps, acctAll,
    draftKey, keyFor, keyCleared, keyDraft, acctOffSet, panelOpen, fetchNote,
    slotKey, slotKid, slotCap, slotOfProv, provBySlot,
    renderProv, refreshProvNotes, paintAccountBalances, acctMsg,
    textPick, setTextPick,
  };
}
