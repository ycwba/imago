/* 拾帧 · 设置 › 账户与密钥 —— 设计稿 A：账户优先
   ---------------------------------------------------------------------------
   主张：
     · 一家供应商 = 一个账号 = 一把密钥 —— 一张**等高的竖排卡**。
     · 卡里列着它能开通的每一档；卡顶一条六格能力条（图片/视频/语音/文字/识别/搜索），
       横着是六档能力，纵着（多张卡叠起来）是账号。
     · **语音识别**与**联网搜索**是另外两张卡，用的是**同一副表单骨架** ——
       图标 + 标题 + 说明 + 键值行 + 底部动作行，与供应商卡长得一样；
       左栏不再单独占一行（它们跟「账户与密钥」同属一栏）。
     · 每一档能力自带**型号**：自动取回 / 自己填 / 逐个决定**要不要出现在工作台** /
       这一档默认用哪个。

   交互：点能力格改状态；点「型号 N」就地展开型号清单（不另起一层）；
   点「取一次」模拟自动获取；点「添加」把预设供应商接进来。
   这一稿是静态稿：不真存盘、不真请求。 */
(function () {
  'use strict';

  var D = window.DEMO;
  var S = {
    accounts: JSON.parse(JSON.stringify(D.ACCOUNTS)),
    filter: 'all',
    panels: {},           /* 'accId:capId' → 型号清单面板开没开 */
    keyOpen: {},          /* accId → 密钥设置开没开（默认折叠） */
    slots: [{ id: 'slot-1', consumed: false, custom: false }],  /* 「添加供应商」卡 */
    slotSeq: 1,
    msg: '',
    theme: 'light'
  };
  var CAPS = D.CAPS;
  var capById = {};
  CAPS.forEach(function (c) { capById[c.id] = c; });

  /* ---------- 小工具 ---------- */
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function q(sel, root) { return (root || document).querySelector(sel); }

  function findAcc(id) {
    for (var i = 0; i < S.accounts.length; i++) if (S.accounts[i].id === id) return S.accounts[i];
    return null;
  }
  function keyBadge(a) {
    if (a.key === 'local') return { cls: 'ok', zh: '已填密钥' };
    if (a.key === 'env') return { cls: 'on', zh: '用服务端密钥' };
    return { cls: 'alt', zh: '还没填密钥' };
  }
  function demote(capId, keepId) {
    S.accounts.forEach(function (a) {
      var c = a.caps[capId];
      if (c && c.state === 'pri' && a.id !== keepId) c.state = 'alt';
    });
  }
  function capsCount(a) {
    return Object.keys(a.caps || {}).length;
  }
  function visibleModels(cap) {
    return (cap.models || []).filter(function (m) { return !m.off; }).length;
  }

  /* ---------- 能力条 ---------- */
  /* 只画这家有的那几档，横向排开 —— 不支持的档连位置都不留。 */
  function capStrip(a) {
    var strip = h('div', { class: 'capstrip' });
    CAPS.forEach(function (c) {
      var s = a.caps[c.id];
      if (!s) return;
      var cls = 'capcell';
      if (s.state === 'pri') cls += ' pri';
      else if (s.state === 'on') cls += ' on';
      else if (s.state === 'alt') cls += ' alt';
      else cls += ' off';
      if (S.filter === c.id) cls += ' hit';
      strip.appendChild(h('div', {
        class: cls, title: c.zh + '（点一下改这一档的状态）',
        'data-act': 'cap-toggle', 'data-acc': a.id, 'data-cap': c.id, text: c.glyph
      }));
    });
    return strip;
  }
  function capLegend() {
    var lg = h('div', { class: 'caplegend' });
    CAPS.forEach(function (c) {
      lg.appendChild(h('span', { class: 'cl-item' }, [
        h('i', { class: 'cl-g', text: c.glyph }), h('b', { text: c.zh })
      ]));
    });
    return lg;
  }

  /* ---------- 型号清单面板 ---------- */
  function fetchNote(cap) {
    var f = cap.fetch || {};
    if (cap.manual) return { cls: 'alt', zh: '手动加的 · 型号自己填' };
    if (f.state === 'busy') return { cls: 'warn', zh: '正在取…' };
    if (f.state === 'done') return { cls: 'ok', zh: '已取回 ' + f.n + ' 个 · ' + f.ms + 'ms' };
    if (f.state === 'err') return { cls: 'err', zh: '取失败：' + f.why };
    if (f.state === 'na') return { cls: 'off', zh: '这一档没有型号接口' };
    return { cls: 'alt', zh: '还没取过' };
  }
  function modelPanel(a, c, capId) {
    var cap = a.caps[capId];
    var panel = h('div', { class: 'mpanel' });
    var fn = fetchNote(cap);
    var vis = visibleModels(cap);

    panel.appendChild(h('div', { class: 'mpanel-h' }, [
      h('span', { text: '型号清单' }),
      h('span', { class: 'st ' + fn.cls, text: fn.zh }),
      h('span', { class: 'sp' }),
      cap.fetch && cap.fetch.state !== 'na'
        ? h('button', { class: 'btn xs', 'data-act': 'fetch', 'data-acc': a.id, 'data-cap': capId,
            text: cap.fetch.state === 'busy' ? '取回中…' : '取一次型号清单' })
        : null
    ]));
    panel.appendChild(h('div', { class: 'mpanel-h' }, [
      h('span', { class: 'hint', text: '共 ' + (cap.models || []).length + ' 个型号 · 在工作台显示 ' + vis + ' 个' }),
      h('span', { class: 'sp' }),
      h('span', { class: 'hint', text: '藏起来的那几个不出现在工作台的型号下拉里，历史任务照常能看。' })
    ]));

    var list = h('div', { class: 'mlist' });
    if (!(cap.models || []).length) {
      list.appendChild(h('div', { class: 'mlist-empty', text: '这一档还没有型号 —— 取一次，或自己填一个。' }));
    } else {
      cap.models.forEach(function (m, i) {
        list.appendChild(h('div', { class: 'mlist-row' + (m.off ? ' offd' : '') }, [
          h('div', { class: 'mn2' }, [
            h('b', { text: m.name }),
            h('code', { text: m.id }),
            h('span', { class: 'mm', text: ' · ' + (m.modes || []).join(' / ') })
          ]),
          h('div', { class: 'rside' }, [
            h('label', { class: 'check', title: '勾上 = 它出现在工作台的型号下拉里' }, [
              h('input', { type: 'checkbox', checked: m.off ? null : true,
                'data-act': 'model-vis', 'data-acc': a.id, 'data-cap': capId, 'data-i': i }),
              h('span', { text: '在工作台显示' })
            ]),
            cap.model === m.id ? h('span', { class: 'st pri', text: '这一档默认' })
              : h('button', { class: 'btn xs', 'data-act': 'model-default', 'data-acc': a.id, 'data-cap': capId, 'data-i': i, text: '设为默认' }),
            h('button', { class: 'btn xs danger', 'data-act': 'model-del', 'data-acc': a.id, 'data-cap': capId, 'data-i': i, text: '删除' })
          ])
        ]));
      });
    }
    panel.appendChild(list);

    panel.appendChild(h('div', { class: 'krow' }, [
      h('span', { class: 'kn', text: '自己填' }),
      h('input', { class: 'inp', 'data-act': 'model-new', 'data-acc': a.id, 'data-cap': capId,
        placeholder: '型号 id（逗号分隔可一次填多个）' }),
      h('button', { class: 'btn xs', 'data-act': 'model-add', 'data-acc': a.id, 'data-cap': capId, text: '添加' })
    ]));
    return panel;
  }

  /* ---------- 能力行：六档长得一模一样 ---------- */
  /*   能力名 | 状态牌（就是选择器） | 这一档的默认型号 | 型号管理
       多选档（图片 / 视频 / 语音合成）：状态牌点一下 = 在用 / 停用；
       单选档（文字对话 / 语音识别 / 联网搜索）：状态牌点一下 = 这家上位（原主位自动降为备用）。 */
  function capRow(a, c) {
    var cap = a.caps[c.id];
    var single = !c.multi;
    var isPri = cap.state === 'pri';
    var row = h('div', { class: 'crow' });
    row.appendChild(h('div', { class: 'cn' }, [
      h('span', { class: 'cg', text: c.glyph }), h('span', { text: c.zh }),
      cap.manual ? h('span', { class: 'manual', title: '这一档是手动加的（硬编码里没写这家能做）', text: '手动' }) : null
    ]));

    var chip = h('button', {
      class: 'st st-btn ' + (isPri ? 'pri' : cap.state === 'on' ? 'on' : cap.state === 'alt' ? 'alt' : 'off'),
      'data-act': 'cap-toggle', 'data-acc': a.id, 'data-cap': c.id,
      title: single
        ? (isPri ? '这一档现在走这家（点一下没别的可切）' : '点一下让这一档走这家')
        : (cap.state === 'off' ? '点一下启用这一档' : '点一下停用这一档'),
      text: isPri ? '主位' : cap.state === 'on' ? '在用' : cap.state === 'alt' ? '备用' : '停用'
    });
    row.appendChild(chip);

    var sel = h('select', { class: 'sel', 'data-act': 'model-pick', 'data-acc': a.id, 'data-cap': c.id });
    var shown = (cap.models || []).filter(function (m) { return !m.off; });
    if (!shown.length) sel.appendChild(h('option', { value: '', text: '（没有可用的型号）' }));
    shown.forEach(function (m) {
      sel.appendChild(h('option', { value: m.id, text: m.name, selected: m.id === cap.model }));
    });
    row.appendChild(sel);

    var key = a.id + ':' + c.id;
    var open = !!S.panels[key];
    row.appendChild(h('button', { class: 'btn xs' + (open ? ' on' : ''), 'data-act': 'panel', 'data-key': key,
      text: (open ? '收起型号 ' : '型号 ') + shown.length + '/' + (cap.models || []).length }));
    return row;
  }

  /* 文字对话这一档的全局项：识图能力（对所有文字供应商生效）—— 画在主位那家的卡里 */
  function textExtra() {
    var box = h('div', { class: 'incard-form capform-text' });
    box.appendChild(h('div', { class: 'tai-h' }, [
      h('span', { text: '识图能力' }),
      h('span', { class: 'hint', text: '润色时要不要把参考图一起发给它（全局一项，对所有文字供应商生效）' })
    ]));
    box.appendChild(h('div', { class: 'krow form' }, [
      h('span', { class: 'kn', text: '参考图' }),
      h('select', { class: 'sel' }, [
        h('option', { value: 'auto', text: '自动（按接口返回与平台声明判断）' }),
        h('option', { value: 'on', text: '支持识图（把参考图一起发给它）' }),
        h('option', { value: 'off', text: '不支持（只发文字）' })
      ])
    ]));
    return box;
  }

  /* ---------- 语音识别 / 联网搜索：这一档的表单，画在顶着那家的卡里 ---------- */
  /* 这一档是单选（同一时刻只有一家顶着）。顶着那家的卡里，**
     直接把这一档的全局项摆出来（跟别的键值行同一种排法）。 */
  function asrForm(a) {
    var asr = D.ASR;
    var box = h('div', { class: 'incard-form capform-asr' });
    box.appendChild(h('div', { class: 'krow form' }, [
      h('span', { class: 'kn', text: '走哪条路' }),
      h('select', { class: 'sel' }, [
        h('option', { value: 'auto', text: '自动 —— 浏览器模型就绪就本机，否则本地，最后在线', selected: true }),
        h('option', { value: 'browser', text: '只走浏览器内 Whisper（首次约 250–500MB）' }),
        h('option', { value: 'local', text: '只走本地 whisper.cpp' }),
        h('option', { value: 'service', text: '只走在线服务' })
      ])
    ]));
    D.LOCAL.forEach(function (l) {
      box.appendChild(h('div', { class: 'krow form' }, [
        h('span', { class: 'kn', text: l.id === 'browser' ? '浏览器内' : '本机运行包' }),
        h('span', { class: 'st ' + (l.state === 'ok' ? 'ok' : 'warn'), text: l.stateZh }),
        h('span', { class: 'hint', text: l.note }),
        h('button', { class: 'btn xs', text: l.id === 'browser' ? '下载模型' : '重新检查' })
      ]));
    });
    box.appendChild(h('div', { class: 'krow form' }, [
      h('span', { class: 'kn', text: '地址' }),
      h('input', { class: 'inp', value: asr.baseUrl }),
      h('span', { class: 'hint', text: '留空 = 用这家默认的地址；型号在上面那一行选。' })
    ]));
    box.appendChild(h('div', { class: 'krow form' }, [
      h('span', { class: 'kn', text: '密钥' }),
      h('input', { class: 'inp', type: 'password', placeholder: '留空 = 复用这家账号的密钥' }),
      h('button', { class: 'btn xs', text: '显示' }),
      h('button', { class: 'btn xs', text: '清掉单独存的' })
    ]));
    box.appendChild(h('div', { class: 'krow form' }, [
      h('button', { class: 'btn pri', text: '保存语音识别设置' }),
      h('button', { class: 'btn', text: '选一段音频测试识别' })
    ]));
    return box;
  }
  function searchForm(a) {
    var s = D.SEARCH;
    var box = h('div', { class: 'incard-form capform-search' });
    box.appendChild(h('div', { class: 'krow form' }, [
      h('label', { class: 'check' }, [h('input', { type: 'checkbox' }), h('span', { text: '启用联网搜索' })])
    ]));
    box.appendChild(h('div', { class: 'krow form' }, [
      h('span', { class: 'kn', text: '搜索服务' }),
      h('select', { class: 'sel' }, [
        h('option', { value: 'tavily', text: 'Tavily（标题 / 网址 / 摘要）' }),
        h('option', { value: 'deepseek', text: 'DeepSeek（对话模型）' })
      ]),
      h('span', { class: 'kn', text: '结果数' }),
      h('input', { class: 'inp', style: 'flex:0 0 60px', value: String(s.maxResults) })
    ]));
    box.appendChild(h('div', { class: 'krow form' }, [
      h('span', { class: 'kn', text: '密钥来源' }),
      h('select', { class: 'sel' }, [
        h('option', { value: 'channel', text: '复用这家账号的密钥' }),
        h('option', { value: 'manual', text: '单独一把搜索密钥' })
      ])
    ]));
    box.appendChild(h('div', { class: 'krow form' }, [
      h('span', { class: 'kn', text: '地址' }),
      h('input', { class: 'inp', value: s.baseUrl }),
      h('span', { class: 'hint', text: '留空 = 服务默认；型号在上面那一行选。' })
    ]));
    box.appendChild(h('div', { class: 'krow form' }, [
      h('span', { class: 'kn', text: '密钥' }),
      h('input', { class: 'inp', type: 'password', placeholder: '留空 = 用这家账号的密钥' }),
      h('button', { class: 'btn xs', text: '显示' }),
      h('button', { class: 'btn xs', text: '清掉单独存的' })
    ]));
    box.appendChild(h('div', { class: 'krow form' }, [
      h('button', { class: 'btn pri', text: '保存搜索设置' }),
      h('button', { class: 'btn', text: '测试搜索' })
    ]));
    return box;
  }

  /* ---------- 手动加一档能力 ---------- */
  /* 真品里「这家会哪几档」是**注册表写死的 kind**（server/registry-config.js）——
     型号可以自己填（sk_model_prefs.json 的 typed），但「这家其实能做某一档、
     只是硬编码里没写」没有地方表达：改不了就得改 proxy.js 的 REGISTRY。
     这一稿在账号卡里给一个入口：手动声明一档能力，型号照样自己填。 */
  function capPicker(a) {
    var box = h('div', { class: 'mpanel' });
    box.appendChild(h('div', { class: 'mpanel-h' }, [
      h('span', { text: '手动加一档能力' }),
      h('span', { class: 'sp' }),
      h('span', { class: 'hint', text: '硬编码里没写这家能做的那一档 —— 选一档加进来，型号自己填。' })
    ]));
    var row = h('div', { class: 'pickrow' });
    CAPS.forEach(function (c) {
      var has = !!a.caps[c.id];
      row.appendChild(h('button', {
        class: 'pickchip' + (has ? ' has' : ''), 'data-act': has ? '' : 'cap-add',
        'data-acc': a.id, 'data-cap': c.id, disabled: has ? true : null,
        text: c.glyph + ' ' + c.zh + (has ? '（已有）' : '')
      }));
    });
    box.appendChild(row);
    box.appendChild(h('div', { class: 'mpanel-h' }, [
      h('span', { class: 'hint', text: '手动加的这一档：能力由你声明，型号清单由你自己填（下面那行「自己填」）。' })
    ]));
    return box;
  }

  /* ---------- 账号卡：等高、竖排 ---------- */
  function accountCard(a) {
    var kb = keyBadge(a);
    var card = h('div', { class: 'fcard acct' + (a.off ? ' acct-off' : ''), 'data-acc-id': a.id });

    card.appendChild(h('div', { class: 'fcard-h' }, [
      h('span', { class: 'fcard-ic', text: (a.name || '?').slice(0, 1) }),
      h('div', { style: 'min-width:0' }, [
        h('div', { class: 'fcard-t' }, [
          a.site ? h('a', { href: a.site, target: '_blank', rel: 'noopener', title: '打开官网 ' + a.site, text: a.name })
               : h('span', { text: a.name }),
          a.site ? h('span', { class: 'ext', text: '↗' }) : null,
          /* 密钥设置的开关：就在名字右边 */
          h('button', {
            class: 'keytoggle' + (S.keyOpen[a.id] ? ' on' : ''), 'data-act': 'key-toggle', 'data-acc': a.id,
            title: '密钥设置', text: '密钥 ' + (S.keyOpen[a.id] ? '▴' : '▾')
          }),
          a.custom ? h('span', { class: 'st alt', text: '自定义' }) : null
        ])
      ]),
      h('span', { class: 'fcard-badge' }, [h('span', { class: 'st ' + kb.cls, text: kb.zh })])
    ]));

    card.appendChild(capStrip(a));

    /* 中段（可滚）：密钥设置（默认收起来，点名字右边那颗开关才出现）/ 每一档能力。
       展开与折叠都在这一段里 —— 卡片高度因此**始终不变**。 */
    var mid = h('div', { class: 'acct-mid' });

    if (S.keyOpen[a.id]) {
      mid.appendChild(h('div', { class: 'krow' }, [
        h('span', { class: 'kn', text: '密钥' }),
        h('input', { class: 'inp', type: 'password', value: a.key === 'none' ? '' : 'sk-live-••••••••',
          placeholder: a.key === 'env' ? '已使用服务端环境密钥（留空即可）'
            : a.separateKey ? '这一把单独存着，不与别的账号共用'
            : '填写密钥，或使用默认' }),
        h('button', { class: 'btn xs', text: '显示' }),
        h('button', { class: 'btn xs', text: '清除', 'data-act': 'key-clear', 'data-acc': a.id }),
        h('button', { class: 'btn xs', text: '验证', 'data-act': 'key-verify', 'data-acc': a.id })
      ]));
    }

    CAPS.forEach(function (c) {
      if (!a.caps[c.id]) return;
      mid.appendChild(capRow(a, c));
      if (a.caps[c.id].state === 'pri') {
        /* 这一档的全局项：画在顶着那家的卡里 */
        if (c.id === 'text') mid.appendChild(textExtra());
        else if (c.id === 'asr') mid.appendChild(asrForm(a));
        else if (c.id === 'search') mid.appendChild(searchForm(a));
      }
      var key = a.id + ':' + c.id;
      if (S.panels[key]) mid.appendChild(modelPanel(a, c, c.id));
    });
    /* 手动加一档能力：硬编码里没写这家能做的那一档 */
    if (S.capPick === a.id) {
      mid.appendChild(capPicker(a));
    } else {
      mid.appendChild(h('div', { class: 'capadd' }, [
        h('button', { class: 'btn xs', 'data-act': 'cap-pick', 'data-acc': a.id, text: '＋ 手动加一档能力' }),
        h('span', { class: 'hint', text: '硬编码里没写这家能做的 —— 手动加进来，型号自己填' })
      ]));
    }
    card.appendChild(mid);

    card.appendChild(h('div', { class: 'fcard-acts' }, [
      h('label', { class: 'check' }, [
        h('input', { type: 'checkbox', checked: a.balance ? true : null, 'data-act': 'toggle-balance', 'data-acc': a.id }),
        h('span', { text: '侧栏余额' })
      ]),
      h('label', { class: 'check' }, [
        h('input', { type: 'checkbox', checked: a.off ? true : null, 'data-act': 'toggle-off', 'data-acc': a.id }),
        h('span', { text: '暂时不用' })
      ]),
      h('span', { class: 'sp' }),
      a.custom ? h('button', { class: 'btn xs', text: '编辑' }) : null,
      a.custom ? h('button', { class: 'btn xs danger', text: '删除' }) : null,
      h('span', { text: '改完就存本机' })
    ]));
    return card;
  }

  /* 能当渠道的那几家（文字账号）—— 返回下拉的选项 */
  function textAccountOpts(selectedId) {
    var opts = [];
    S.accounts.forEach(function (a) {
      if (!a.caps.text) return;
      opts.push(h('option', { value: a.id, text: a.name + '（文字对话）', selected: a.id === selectedId ? true : null }));
    });
    return opts;
  }

  /* ---------- 添加供应商：一张普通卡片（挑完就变成那家供应商，并自动多出一张新卡） ---------- */
  function presetRow(p, slotId) {
    var glyphs = p.caps.map(function (id) {
      var c = capById[id];
      return c ? c.glyph : '?';
    }).join('');
    return h('div', { class: 'preset' }, [
      h('span', { class: 'pg', text: (p.name || '?').slice(0, 1) }),
      h('div', { style: 'min-width:0;flex:1 1 auto' }, [
        h('div', { class: 'pn', text: p.name }),
        h('div', { class: 'pnote', text: p.note })
      ]),
      h('span', { class: 'pcaps', text: glyphs, title: p.note }),
      h('button', { class: 'btn xs', 'data-act': 'preset-add', 'data-preset': p.id, 'data-slot': slotId, text: '添加' })
    ]);
  }
  function addTile(slot) {
    var card = h('div', { class: 'fcard acct add-tile' });

    if (slot.custom) {
      /* 自定义那一种：中转站 / 网关 / 企业部署 */
      card.appendChild(h('div', { class: 'fcard-h' }, [
        h('span', { class: 'fcard-ic', text: '＋' }),
        h('div', { style: 'min-width:0' }, [
          h('div', { class: 'fcard-t', text: '自定义供应商' }),
          h('div', { class: 'fcard-d', text: '中转站 / 网关 / 企业部署：挑一个接口形状，地址与密钥填你自己的。' })
        ])
      ]));
      card.appendChild(h('div', { class: 'krow stack-inp' }, [
        h('span', { class: 'kn', text: '接口形状' }),
        h('select', { class: 'sel' }, [
          h('option', { value: 'openai-chat', text: 'OpenAI 兼容对话（POST /chat/completions + GET /models）' }),
          h('option', { value: 'openai-image', text: 'OpenAI 兼容生图（POST /images/generations）' }),
          h('option', { value: 'task-asset', text: '任务 + 资产号（建任务 → 轮询 → 按资产号换签名地址取图）' })
        ])
      ]));
      card.appendChild(h('div', { class: 'krow' }, [
        h('span', { class: 'kn', text: '显示名' }),
        h('input', { class: 'inp', style: 'flex:1 1 auto', value: '我的中转站' })
      ]));
      card.appendChild(h('div', { class: 'krow' }, [
        h('span', { class: 'kn', text: '密钥' }),
        h('input', { class: 'inp', type: 'password', style: 'flex:1 1 auto', placeholder: '这一家自己的密钥' })
      ]));
      card.appendChild(h('div', { class: 'krow stack-inp' }, [
        h('span', { class: 'kn', text: '地址' }),
        h('input', { class: 'inp', style: 'flex:1 1 auto', placeholder: 'https://gw.example.com/api/v1' })
      ]));
      card.appendChild(h('div', { class: 'fcard-acts' }, [
        h('button', { class: 'btn pri', 'data-act': 'custom-add', 'data-slot': slot.id, text: '添加' }),
        h('button', { class: 'btn', 'data-act': 'custom-cancel', 'data-slot': slot.id, text: '取消' }),
        h('span', { class: 'sp' }),
        h('span', { class: 'hint', text: '只收公网 https；这一家的密钥不会回退到 .env。' })
      ]));
      return card;
    }

    /* 预设那一种：注册表里还接着、本机没接进来的 */
    var rest = D.PRESETS.filter(function (p) { return !S.accounts.some(function (a) { return a.id === p.id; }); });
    card.appendChild(h('div', { class: 'fcard-h' }, [
      h('span', { class: 'fcard-ic', text: '＋' }),
      h('div', { style: 'min-width:0' }, [
        h('div', { class: 'fcard-t', text: '添加供应商' }),
        h('div', { class: 'fcard-d', text: '注册表里还接着、本机没接进来的 —— 点一下就接进来（接进来以后在它那张卡里填一把密钥就能用）。' })
      ]),
      h('span', { class: 'fcard-badge' }, [h('span', { class: 'st alt', text: '待接入 ' + rest.length })])
    ]));

    var list = h('div', { class: 'addlist' });
    rest.forEach(function (p) { list.appendChild(presetRow(p, slot.id)); });
    if (!rest.length) {
      list.appendChild(h('div', { class: 'mlist-empty', text: '注册表里的都接进来了 —— 还可以添加自己的中转站。' }));
    }
    list.appendChild(h('button', { class: 'btn wide', 'data-act': 'custom-open', 'data-slot': slot.id,
      text: '＋ 自定义（中转站 / 网关 / 企业部署）' }));
    card.appendChild(list);

    card.appendChild(h('div', { class: 'fcard-acts' }, [
      h('span', { class: 'hint', text: '添加当场落盘；建出来的都是独立的一家，不设家数上限。' })
    ]));
    return card;
  }

  /* ---------- 筛选 ---------- */
  function filterRow() {
    var row = h('div', { class: 'filters' });
    var all = h('button', { class: 'fchip' + (S.filter === 'all' ? ' on' : ''), 'data-act': 'filter', 'data-cap': 'all' });
    all.appendChild(h('span', { text: '全部' }));
    all.appendChild(h('span', { class: 'n', text: String(S.accounts.length) }));
    row.appendChild(all);
    CAPS.forEach(function (c) {
      var n = S.accounts.filter(function (a) { return a.caps[c.id]; }).length;
      var b = h('button', { class: 'fchip' + (S.filter === c.id ? ' on' : ''), 'data-act': 'filter', 'data-cap': c.id });
      b.appendChild(h('span', { text: c.zh }));
      b.appendChild(h('span', { class: 'n', text: String(n) }));
      row.appendChild(b);
    });
    return row;
  }
  /* 筛选后怎么排：在用/主位 → 备用 → 停用；同档里能力多的在前 */
  function filteredAccounts() {
    var list = S.accounts.filter(function (a) { return S.filter === 'all' || a.caps[S.filter]; });
    if (S.filter === 'all') return list;
    var rank = function (a) {
      var c = a.caps[S.filter];
      if (!c) return 3;
      return (c.state === 'pri' || c.state === 'on') ? 0 : (c.state === 'alt' ? 1 : 2);
    };
    return list.sort(function (a, b) { return rank(a) - rank(b) || capsCount(b) - capsCount(a); });
  }
  function filterSummary() {
    if (S.filter === 'all') return null;
    var c = capById[S.filter];
    var list = filteredAccounts();
    var on = list.filter(function (a) { var x = a.caps[S.filter]; return x.state === 'pri' || x.state === 'on'; }).length;
    var alt = list.filter(function (a) { var x = a.caps[S.filter]; return x.state === 'alt'; }).length;
    var off = list.length - on - alt;
    return h('div', { class: 'fsum' }, [
      h('span', { class: 'fsum-t' }, [
        h('b', { text: '做「' + c.zh + '」的 ' + list.length + ' 家' }),
        h('span', { text: ' · 在用 ' + on + ' 家' + (alt ? ' · 备用 ' + alt + ' 家' : '') + (off ? ' · 没接上 ' + off + ' 家' : '') })
      ]),
      h('span', { class: 'hint', text: '按「在用 → 备用 → 没接上」排；被筛的那一格在能力条上会圈出来。' }),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn xs', 'data-act': 'filter', 'data-cap': 'all', text: '看全部 ' + S.accounts.length + ' 家' })
    ]);
  }

  /* ---------- 目录轨 ---------- */
  function renderRail() {
    var rail = q('#rail');
    rail.innerHTML = '';
    rail.appendChild(h('input', { class: 'rail-q', type: 'search', placeholder: '找一项设置（密钥、目录、分页…）' }));
    D.RAIL.forEach(function (g) {
      var box = h('div', { class: 'rail-group' });
      box.appendChild(h('div', { class: 'rail-group-h' }, [
        h('span', { text: g.group }), h('span', { text: g.cards.length + ' 项' })
      ]));
      g.cards.forEach(function (c) {
        box.appendChild(h('div', { class: 'rail-item' + (c.live ? ' on' : ' dim') }, [
          h('span', { class: 'ri-n', text: c.zh }), h('span', { class: 'ri-v', text: c.val })
        ]));
      });
      rail.appendChild(box);
    });
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    var body = q('#acctBody');
    body.innerHTML = '';

    body.appendChild(h('div', { class: 'note-bar' }, [
      h('div', {}, [
        h('b', { text: '这一稿的结构：一家供应商 = 一个账号 = 一把密钥。' }),
        h('span', { text: ' 一张等高的竖排卡；卡顶那一排能力格就是这家有哪几档 —— 有几格、哪一档，'
          + '一眼就知道；下面每一行是一档能力（图片 / 视频 / 语音合成 / 文字对话 / 语音识别 / 联网搜索），'
          + '长得一模一样：不支持的档，连行都不画。' })
      ])
    ]));

    body.appendChild(h('div', { style: 'display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:10px' }, [
      h('span', { class: 'hint', text: '能力格' }), capLegend()
    ]));
    body.appendChild(h('div', { style: 'margin-bottom:12px' }, [filterRow()]));

    var sum = filterSummary();
    if (sum) body.appendChild(h('div', { style: 'margin-bottom:12px' }, [sum]));

    /* 一张卡片流：供应商卡 + 「添加供应商」卡（挑完就变成那家供应商，并自动多出一张新卡）。
       语音识别与联网搜索**不是另外两张卡** —— 它们是这家账号里的一行（能力行 + 这一档的表单）。 */
    var grid = h('div', { class: 'acct-grid' });
    filteredAccounts().forEach(function (a) { grid.appendChild(accountCard(a)); });
    S.slots.forEach(function (slot) { if (!slot.consumed) grid.appendChild(addTile(slot)); });
    body.appendChild(grid);

    body.appendChild(h('div', { class: 'fcard-acts', style: 'border:0;padding-top:12px' }, [
      h('span', { text: '改完就存本机 · 刚刚存过' }),
      h('span', { class: 'sp' }),
      h('span', { class: 'hint', text: '这一稿是静态稿：不真存盘、不真请求。' })
    ]));
  }

  /* ---------- 事件 ---------- */
  function capOf(accId, capId) {
    var a = findAcc(accId);
    return a ? a.caps[capId] : null;
  }
  function findSlot(id) {
    for (var i = 0; i < S.slots.length; i++) if (S.slots[i].id === id) return S.slots[i];
    return null;
  }
  /* 挑完一家：这一张「添加供应商」卡变成那家供应商，并自动多出一张新的添加卡 */
  function consumeSlot(id) {
    var slot = findSlot(id);
    if (slot) slot.consumed = true;
    S.slotSeq++;
    S.slots.push({ id: 'slot-' + S.slotSeq, consumed: false, custom: false });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.dataset.act;
    var a = t.dataset.acc ? findAcc(t.dataset.acc) : null;

    if (act === 'cap-toggle') {
      if (!a) return;
      var c = a.caps[t.dataset.cap];
      if (!c) return;
      var capDef = capById[t.dataset.cap];
      if (capDef.multi) {
        /* 多选档（图片 / 视频 / 语音合成）：点一下 = 在用 / 停用 */
        c.state = c.state === 'off' ? 'on' : 'off';
      } else {
        /* 单选档（文字对话 / 语音识别 / 联网搜索）：点一下 = 这家上位（原主位自动降为备用） */
        if (c.state !== 'pri') { demote(capDef.id, a.id); c.state = 'pri'; }
      }
      render();
    } else if (act === 'panel') {
      var key = t.dataset.key;
      S.panels[key] = !S.panels[key];
      render();
    } else if (act === 'key-toggle') {
      var kid2 = t.dataset.acc;
      S.keyOpen[kid2] = !S.keyOpen[kid2];
      render();
      /* 展开后把那段滚到可见处（卡片高度不变，滚的是卡内那一段） */
      if (S.keyOpen[kid2]) {
        var card = document.querySelector('.acct[data-acc-id="' + kid2 + '"]');
        var mid = card && card.querySelector('.acct-mid');
        if (mid) mid.scrollTop = 0;
      }
    } else if (act === 'cap-pick') {
      S.capPick = (S.capPick === t.dataset.acc) ? null : t.dataset.acc;
      render();
    } else if (act === 'cap-add') {
      var acc = findAcc(t.dataset.acc);
      var cid = t.dataset.cap;
      if (acc && cid && !acc.caps[cid]) {
        acc.caps[cid] = { state: 'off', model: '', models: [], fetch: { state: 'na' }, manual: true };
        /* 加进来就把型号清单打开 —— 型号得自己填 */
        S.panels[acc.id + ':' + cid] = true;
        S.capPick = null;
        render();
      }
    } else if (act === 'model-default') {
      var cap = capOf(t.dataset.acc, t.dataset.cap);
      if (cap) { cap.model = cap.models[Number(t.dataset.i)].id; render(); }
    } else if (act === 'model-del') {
      var cap2 = capOf(t.dataset.acc, t.dataset.cap);
      if (cap2) {
        cap2.models.splice(Number(t.dataset.i), 1);
        if (cap2.model && !cap2.models.some(function (m) { return m.id === cap2.model; })) {
          cap2.model = cap2.models.length ? cap2.models[0].id : '';
        }
        render();
      }
    } else if (act === 'model-add') {
      var cap3 = capOf(t.dataset.acc, t.dataset.cap);
      var inp = q('[data-act="model-new"][data-acc="' + t.dataset.acc + '"][data-cap="' + t.dataset.cap + '"]');
      var txt = inp ? String(inp.value || '').trim() : '';
      if (cap3 && txt) {
        txt.split(/[,，]/).forEach(function (x) {
          x = x.trim();
          if (x && !cap3.models.some(function (m) { return m.id === x; })) {
            cap3.models.push({ id: x, name: x, modes: ['自己填'], off: false });
          }
        });
        if (!cap3.model) cap3.model = cap3.models[0].id;
        render();
      }
    } else if (act === 'fetch') {
      var cap4 = capOf(t.dataset.acc, t.dataset.cap);
      if (cap4) {
        cap4.fetch = { state: 'busy' };
        render();
        setTimeout(function () {
          cap4.fetch = { state: 'done', n: (cap4.models.length || 3) + 6, ms: 760, src: '/models 自动取回' };
          render();
        }, 900);
      }
    } else if (act === 'filter') {
      S.filter = t.dataset.cap; render();
    } else if (act === 'custom-open') {
      var slot0 = findSlot(t.dataset.slot);
      if (slot0) { slot0.custom = true; render(); }
    } else if (act === 'custom-cancel') {
      var slot1 = findSlot(t.dataset.slot);
      if (slot1) { slot1.custom = false; render(); }
    } else if (act === 'custom-add') {
      S.accounts.push({
        id: 'mygw2', name: '我的中转站（另一个）', site: '', key: 'local',
        base: 'https://gw2.example.com/api/v1', balance: false, off: false,
        custom: true, shapeName: 'OpenAI 兼容对话', keyNote: '这一家自己的密钥，不回退 .env。',
        caps: { text: { state: 'off', model: 'gpt-4o-mini', models: [
          { id: 'gpt-4o-mini', name: 'GPT-4o mini', modes: ['对话'], off: false }
        ], fetch: { state: 'na' } } }
      });
      consumeSlot(t.dataset.slot);
      S.msg = '已添加「我的中转站（另一个）」—— 在它那张卡里填一把密钥';
      render();
    } else if (act === 'preset-add') {
      var p = null;
      D.PRESETS.forEach(function (x) { if (x.id === t.dataset.preset) p = x; });
      if (p && !findAcc(p.id)) {
        var caps = {};
        p.caps.forEach(function (id) {
          caps[id] = { state: 'off', model: '', models: [], fetch: { state: 'na' } };
        });
        S.accounts.push({
          id: p.id, name: p.name, site: p.site, key: 'none', base: p.base,
          balance: false, off: false, custom: false,
          keyNote: '刚接进来 —— 填一把密钥就能用（也可以配在 .env 的 ' + p.keyEnv + '）。',
          caps: caps
        });
        consumeSlot(t.dataset.slot);
        S.msg = '已添加「' + p.name + '」—— 在它那张卡里填一把密钥';
        render();
      }
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.dataset.act;
    var a = t.dataset.acc ? findAcc(t.dataset.acc) : null;
    if (act === 'model-pick' && a) {
      var c = a.caps[t.dataset.cap];
      if (c) { c.model = t.value; render(); }
    } else if (act === 'model-vis' && a) {
      var c2 = a.caps[t.dataset.cap];
      if (c2) { c2.models[Number(t.dataset.i)].off = !t.checked; render(); }
    } else if (act === 'toggle-balance' && a) {
      a.balance = t.checked;
    } else if (act === 'toggle-off' && a) {
      a.off = t.checked;
      render();
    }
  });

  /* ---------- 顶栏 ---------- */
  function initChrome() {
    var t = q('#themeBtn');
    if (t) t.addEventListener('click', function () {
      S.theme = S.theme === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', S.theme);
      t.textContent = S.theme === 'light' ? '深色（自动派生）' : '浅色';
    });
  }

  renderRail();
  render();
  initChrome();
  window.__demo = {
    state: S,
    open: function (id) { S.panels[id] = true; render(); },
    close: function () { S.panels = {}; render(); },
    set: function (o) { Object.keys(o).forEach(function (k) { S[k] = o[k]; }); render(); }
  };
})();
