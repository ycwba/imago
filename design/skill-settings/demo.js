/* 拾帧 · 设置 › Skill —— 设计稿交互
   ---------------------------------------------------------------------------
   两屏：
     · 新版：场景轨（左）→ 场景详情（右）—— 本稿要推的那一版
     · 现状：照搬今天的结构（使用地方 12 行 + 全量清单 + 详情里的变量表），用来对照
   状态规则照 server/skills-store.js：同一个 contract 同一时刻只能有一份 Skill 生效；
   启一份就把同 contract 的原来那份自动停用（内置的、我的，都是让位，不报错）。 */
(function () {
  'use strict';

  var D = window.DEMO;
  var SKILLS = D.SKILLS;

  var state = {
    ver: 'new',
    scene: 'video',
    mode: 'scene',       /* 新版右栏：scene=场景详情 / all=全部 Skill / new=新建（编辑）Skill */
    q: '',
    oldSel: 'video-prompt',
    oldFilter: 'all',
    oldQ: '',
    form: { mode: 'create', id: '', name: '', description: '', triggers: '', pages: [], body: '' },
  };

  /* ---------- 极小 DOM 助手 ---------- */
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function code(t) { return h('span', { class: 'code', text: t }); }
  function tag(t, cls) { return h('span', { class: 'tg' + (cls ? ' ' + cls : ''), text: t }); }

  /* ---------- 场景与 Skill 的关系 ---------- */
  function allScenes() {
    return [D.ASSISTANT].concat(D.SCENES);
  }
  function sceneByKey(k) {
    var list = allScenes();
    for (var i = 0; i < list.length; i++) if (list[i].key === k) return list[i];
    return list[0];
  }
  function sceneByContract(c) {
    var list = allScenes();
    for (var i = 0; i < list.length; i++) if (list[i].contract === c) return list[i];
    return null;
  }
  function skillsOf(contract) {
    return SKILLS.filter(function (s) { return s.contract === contract; });
  }
  /* 冲突判定照 skills-store：同一 contract 下有多份启用时，除第一份外都算冲突 */
  function isConflict(s) {
    if (!s.enabled || !s.contract) return false;
    var on = SKILLS.filter(function (x) { return x.enabled && x.contract === s.contract; });
    return on.length > 1 && on[0].id !== s.id;
  }
  /* 这个场景现在用的是哪一份（启用且不冲突的那份） */
  function activeOf(scene) {
    var list = skillsOf(scene.contract);
    for (var i = 0; i < list.length; i++) {
      if (list[i].enabled && !isConflict(list[i])) return list[i];
    }
    return null;
  }
  function enabledCount() {
    return SKILLS.filter(function (s) { return s.enabled; }).length;
  }
  /* 场景状态灯：我的在用 / 内置在用 / 空档 / 冲突 */
  function lampOf(scene) {
    var list = skillsOf(scene.contract);
    if (list.some(isConflict)) return 'conflict';
    var a = activeOf(scene);
    if (!a) return 'empty';
    return a.source === 'user' ? 'mine' : 'builtin';
  }
  function slotText(scene) {
    var list = skillsOf(scene.contract);
    if (list.some(isConflict)) return '冲突';
    var a = activeOf(scene);
    if (!a) return '空档';
    return a.source === 'user' ? '我的' : '内置';
  }

  /* ---------- 消息条 ---------- */
  function say(t, kind) {
    var m = document.getElementById('msg');
    clear(m);
    if (!t) return;
    m.appendChild(h('div', { class: 'msgbox' + (kind ? ' ' + kind : ''), text: t }));
  }

  /* ---------- 启停（规则照服务端：同一 contract 只留一份，启一份 → 别的直接停） ---------- */
  function toggleEnabled(id) {
    var s = SKILLS.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (s.enabled) {
      s.enabled = false;
      say('已停用 ' + s.id + '：下一轮助手请求生效，当前这一轮不会热替换。');
    } else {
      /* 同 contract 的原来那份**直接让位**（不报错、不让人先关掉再开）；
         内置那份也一样让位。 */
      var others = SKILLS.filter(function (x) { return x.id !== id && x.enabled && x.contract === s.contract; });
      others.forEach(function (o) { o.enabled = false; });
      s.enabled = true;
      say(others.length
        ? '已启用 ' + s.id + '：同一 contract 上原来的「' + others.map(function (o) { return o.id; }).join('、') + '」自动停用。'
        : '已启用 ' + s.id + '：下一轮助手请求生效。');
    }
    render();
  }

  /* =====================================================================
     新版：场景轨 + 场景详情
     ===================================================================== */
  function renderRail() {
    var rail = document.getElementById('rail');
    clear(rail);

    var search = h('input', {
      class: 'rail-search', type: 'search', value: state.q,
      placeholder: '搜场景 / Skill 名 / id',
      oninput: function (e) { state.q = e.target.value; render(); },
    });
    var allBtn = h('button', {
      class: 'btn rail-all', type: 'button',
      text: '全部 Skill ' + SKILLS.length,
      onclick: function () { state.mode = state.mode === 'all' ? 'scene' : 'all'; render(); },
    });
    rail.appendChild(h('div', { class: 'rail-top' }, [search, allBtn]));

    var q = state.q.trim().toLowerCase();
    D.GROUPS.forEach(function (g) {
      var scenes = allScenes().filter(function (s) { return s.group === g.id; });
      if (q) {
        scenes = scenes.filter(function (s) {
          var hay = [s.label, s.contract, s.used].concat(
            skillsOf(s.contract).map(function (x) { return x.id + ' ' + x.name; })
          ).join(' ').toLowerCase();
          return hay.indexOf(q) >= 0;
        });
        if (!scenes.length) return;
      }
      rail.appendChild(h('div', { class: 'rg-h' }, [
        h('span', { class: 'rg-n', text: g.name }),
        h('span', { class: 'rg-c', text: String(scenes.length) }),
      ]));
      scenes.forEach(function (sc) {
        var isAsst = sc.key === 'assistant';
        var row = h('button', {
          class: 'srow' + (state.mode === 'scene' && state.scene === sc.key ? ' on' : ''),
          type: 'button',
          onclick: function () { state.scene = sc.key; state.mode = 'scene'; render(); },
        });
        if (!isAsst) row.appendChild(h('span', { class: 'lamp ' + lampOf(sc) }));
        else row.appendChild(h('span', { class: 'lamp asst' }));
        row.appendChild(h('span', { class: 's-l', text: sc.label }));
        row.appendChild(h('span', {
          class: 's-r' + (lampOf(sc) === 'conflict' ? ' err' : ''),
          text: isAsst ? (enabledCount() + ' 份已启用') : slotText(sc),
        }));
        rail.appendChild(row);
      });
    });

    rail.appendChild(h('div', { class: 'rail-legend' }, [
      h('span', { class: 'lg' }, [h('span', { class: 'lamp mine' }), '我的一份在用']),
      h('span', { class: 'lg' }, [h('span', { class: 'lamp builtin' }), '内置的在用']),
      h('span', { class: 'lg' }, [h('span', { class: 'lamp empty' }), '空档 · 用内置默认正文']),
      h('span', { class: 'lg' }, [h('span', { class: 'lamp conflict' }), '两份都启用了']),
      h('span', { class: 'lg' }, [h('span', { class: 'lamp asst' }), '助手不占固定位']),
    ]));
  }

  function renderDetail() {
    var box = document.getElementById('detail');
    clear(box);
    if (state.mode === 'all') { renderAll(box); return; }
    if (state.mode === 'new') { renderForm(box); return; }
    var sc = sceneByKey(state.scene);
    if (sc.key === 'assistant') { renderAssistant(box, sc); return; }
    renderScene(box, sc);
  }

  /* 新建 / 编辑：在浏览器里直接写一份 SKILL.md（frontmatter 由表单生成，正文自己敲） */
  function renderForm(box) {
    var sc = sceneByKey(state.scene);
    var f = state.form;
    box.appendChild(h('div', { class: 'd-head' }, [
      h('div', {}, [
        h('h3', { text: f.mode === 'edit' ? '编辑 Skill' : '添加新 Skill' }),
        h('div', {
          class: 'd-sub',
          text: f.mode === 'edit'
            ? '改的是「' + f.id + '」这一份 —— 保存后下一轮生效。'
            : '在浏览器里直接写一份：下面几格是它的身份，最下面那格是正文（也就是喂给 AI 的那份写法）。',
        }),
        h('div', { class: 'd-meta' }, [
          code('contract：' + sc.contract),
          h('span', { class: 'sk-id', text: '同一个 contract 同一时刻只能有一份生效 —— 装上去时原来那份会让位' }),
        ]),
      ]),
      h('div', { class: 'acts' }, [
        h('button', { class: 'btn', type: 'button', text: '返回场景', onclick: function () { state.mode = 'scene'; render(); } }),
        h('button', { class: 'btn pri', type: 'button', text: '保存', onclick: saveDemoSkill }),
      ]),
    ]));
    var form = h('div', { class: 'nform' });
    [['id', 'id', '小写字母 / 数字 / 连字符，例如 my-video-prompt'],
     ['name', '名字', '给人看的名字'],
     ['description', '它管什么', '一句话说清这份 Skill 负责哪类活儿'],
     ['triggers', '触发词', '用顿号或逗号隔开，例如 视频、提示词']].forEach(function (r) {
      form.appendChild(h('label', { class: 'nfield' }, [
        h('span', { class: 'nlabel', text: r[1] }),
        h('input', {
          class: 'ninput', type: 'text', value: f[r[0]], placeholder: r[2],
          disabled: f.mode === 'edit' && r[0] === 'id',
          oninput: function (e) { f[r[0]] = e.target.value; },
        }),
      ]));
    });
    var ta = h('textarea', {
      class: 'ntextarea', rows: 12,
      placeholder: '这份 Skill 要告诉 AI 怎么写。可以用 {变量} 占位，程序会按当前项目填进去。',
      oninput: function (e) { f.body = e.target.value; },
    });
    ta.value = f.body || '';
    form.appendChild(h('label', { class: 'nfield' }, [h('span', { class: 'nlabel', text: '正文' }), ta]));
    box.appendChild(h('div', { class: 'sec' }, [form]));
    box.appendChild(h('div', {
      class: 'vnote',
      text: '正文里的 {变量} 由程序按当前项目填料 —— 这个场景能拿到哪些变量，看上面「这一步会拿到什么」那一张表。填不上的原样留着，AI 会知道那是要它自己补的位子。',
    }));
  }

  function saveDemoSkill() {
    var f = state.form;
    var sc = sceneByKey(state.scene);
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(f.id || '').trim())) { say('id 只能用小写字母、数字与连字符（2–41 个字符）', 'err'); return; }
    if (!f.name || !f.description || !String(f.body || '').trim()) { say('名字、它管什么、正文都要填', 'err'); return; }
    var ex = SKILLS.filter(function (s) { return s.id === f.id; })[0];
    if (ex) {
      ex.name = f.name; ex.description = f.description;
      ex.triggers = String(f.triggers || '').split(/[、,，\s]+/).filter(Boolean);
      say('✓ 已更新 ' + ex.id + '（保存后下一轮生效）');
    } else {
      SKILLS.push({
        id: f.id, name: f.name, description: f.description,
        triggers: String(f.triggers || '').split(/[、,，\s]+/).filter(Boolean),
        pages: ['studio.html'], contract: sc.contract, version: 1,
        source: 'user', enabled: true, chars: String(f.body || '').length, placeholders: [],
      });
      say('✓ 已新建 ' + f.id + '（并已启用：同一 contract 上原来那份自动让位）');
    }
    state.mode = 'scene';
    render();
  }

  function renderScene(box, sc) {
    var list = skillsOf(sc.contract);
    var active = activeOf(sc);
    var conf = list.some(isConflict);
    var vars = sc.vars || [];

    /* —— 场景头 —— */
    var head = h('div', { class: 'd-head' }, [
      h('div', { class: 'd-title' }, [
        h('h3', { text: sc.label }),
        h('div', { class: 'd-used', text: sc.used }),
        h('div', { class: 'd-meta' }, [
          code(sc.contract),
          conf
            ? tag('contract 冲突 · 两份都启用了', 'err')
            : (active
              ? tag((active.source === 'user' ? '我的' : '内置') + ' · ' + active.name, active.source === 'user' ? 'acc' : '')
              : tag('空档 · 用内置默认正文', 'warn')),
          h('span', { class: 'sk-id', text: '场景里共 ' + list.length + ' 份 Skill' }),
        ]),
      ]),
      h('div', { class: 'acts' }, [
        h('button', {
          class: 'btn pri', type: 'button', text: '添加新 Skill',
          onclick: function () {
            state.form = { mode: 'create', id: '', name: '', description: '', triggers: '', pages: [], body: '' };
            state.mode = 'new';
            render();
          },
        }),
      ]),
    ]);
    box.appendChild(head);

    /* —— 这一步会拿到什么（场景级变量） —— */
    var secV = h('div', { class: 'sec' });
    secV.appendChild(h('div', { class: 'sec-h' }, [
      h('b', { text: '这一步会拿到什么' }),
      h('span', { class: 'hint', text: '程序在发请求前按当前项目把下面这些位置填上真实内容' }),
    ]));
    if (vars.length) {
      vars.forEach(function (v) {
        secV.appendChild(h('div', { class: 'vrow' }, [
          h('span', { class: 'vk', text: '{' + v.name + '}' }),
          h('span', { class: 'vfrom', text: v.from }),
          h('span', { class: 'vdesc', text: v.desc }),
        ]));
      });
      secV.appendChild(h('div', {
        class: 'vnote',
        text: '填得上的填，填不上的原样留着（AI 会知道那是要它自己补的位子）。这份表跟着「场景」走，不跟着某一份 Skill 走 —— 换一份写法，喂料方式不变。',
      }));
    } else {
      secV.appendChild(h('div', {
        class: 'vempty',
        text: '这一步不需要项目上下文 —— 它只读你写的那句话（用户在输入框里打的那段描述），不读角色表、不读素材库、不读分镜。',
      }));
    }
    /* 生效中的那份正文用到了场景说明里没有的占位符 → 提醒（这是现在看不见的坑） */
    if (active && active.placeholders && active.placeholders.length) {
      var known = vars.map(function (v) { return v.name; });
      var unknown = active.placeholders.filter(function (p) { return known.indexOf(p) < 0; });
      if (unknown.length) {
        secV.appendChild(h('div', { class: 'warnbox' }, [
          h('span', { text: '!' }),
          h('span', {
            html: '正在生效的「<b>' + active.name + '</b>」正文里还用了 ' +
              unknown.map(function (p) { return '<code>{' + p + '}</code>'; }).join(' ') +
              '，但这个场景的说明里没有登记它 —— 程序不会填这个位置，AI 会当成要自己补的空位。',
          }),
        ]));
      }
    }
    box.appendChild(secV);

    /* —— 这个场景的 Skill —— */
    var secS = h('div', { class: 'sec' });
    secS.appendChild(h('div', { class: 'sec-h' }, [
      h('b', { text: '这个场景的 Skill' }),
      h('span', { class: 'hint', text: '同一时刻只有一份生效；点「启用」会把这一格让给它' }),
    ]));
    if (!list.length) {
      secS.appendChild(h('div', { class: 'vempty', text: '这个场景还没有任何 Skill —— 现在用的是产品内置的默认正文。' }));
    }
    list.forEach(function (s) {
      var on = active && active.id === s.id;
      var conf = isConflict(s);
      var row = h('div', { class: 'skrow' + (on ? ' on' : '') + (!s.enabled ? ' off' : '') });
      row.appendChild(h('span', { class: 'sk-bar' }));
      var mid = h('div', {});
      mid.appendChild(h('div', {}, [
        h('span', { class: 'sk-name', text: s.name }),
        h('span', { class: 'sk-id', text: '  ' + s.id + ' · v' + s.version }),
      ]));
      mid.appendChild(h('div', { class: 'sk-desc', text: s.description }));
      var chips = h('div', { class: 'sk-chips' });
      if (on) chips.appendChild(tag('正在生效', 'acc'));
      if (conf) chips.appendChild(tag('contract 冲突', 'err'));
      chips.appendChild(tag(s.source === 'builtin' ? '内置（只读）' : '我的 Skill'));
      chips.appendChild(tag(s.enabled ? '已启用' : '已停用', s.enabled ? 'ok' : ''));
      chips.appendChild(tag(s.chars + ' 字'));
      (s.pages || []).forEach(function (p) { chips.appendChild(tag(p, 'mono')); });
      (s.triggers || []).forEach(function (t) { chips.appendChild(tag('#' + t)); });
      mid.appendChild(chips);
      row.appendChild(mid);

      var acts = h('div', { class: 'acts' });
      acts.appendChild(h('button', {
        class: 'btn', type: 'button', text: s.enabled ? '停用' : '启用',
        onclick: function () { toggleEnabled(s.id); },
      }));
      if (s.source === 'user') {
        acts.appendChild(h('button', {
          class: 'btn', type: 'button', text: '编辑正文',
          onclick: function () {
            state.form = { mode: 'edit', id: s.id, name: s.name, description: s.description, triggers: (s.triggers || []).join('、'), pages: (s.pages || []).slice(), body: '（这一份的正文）' };
            state.mode = 'new';
            render();
          },
        }));
      }
      acts.appendChild(h('button', { class: 'btn', type: 'button', text: '查看正文', onclick: function () { say('展开这一份：文件树 + 正文预览。'); } }));
      if (s.source !== 'builtin') {
        acts.appendChild(h('button', {
          class: 'btn danger', type: 'button', text: '卸载',
          onclick: function () { say('卸载 ' + s.id + '（内置那份会接管这个场景）。'); },
        }));
      }
      row.appendChild(acts);
      secS.appendChild(row);
    });
    box.appendChild(secS);

    box.appendChild(h('div', {
      class: 'd-foot',
      text: 'Skill 只补充写法，输出格式与禁止项由机器契约管，Skill 改不了它。启用 / 停用在下一轮助手请求里生效，当前这一轮不会热替换。',
    }));
  }

  function renderAssistant(box, sc) {
    var on = SKILLS.filter(function (s) { return s.enabled; });
    box.appendChild(h('div', { class: 'd-head' }, [
      h('div', { class: 'd-title' }, [
        h('h3', { text: 'AI 助手（按需触发）' }),
        h('div', { class: 'd-used', text: sc.used }),
        h('div', { class: 'd-meta' }, [
          tag('按需触发', 'acc'),
          h('span', { class: 'sk-id', text: '现在有 ' + on.length + ' 份启用的 Skill 会被它考虑' }),
        ]),
      ]),
    ]));
    var sec = h('div', { class: 'sec' });
    sec.appendChild(h('div', { class: 'sec-h' }, [
      h('b', { text: '这一项不是「一个位置一份」' }),
      h('span', { class: 'hint', text: '下面这些是候选：命中触发词才会被带进回合' }),
    ]));
    on.forEach(function (s) {
      var row = h('div', { class: 'skrow' });
      row.appendChild(h('span', { class: 'sk-bar' }));
      var mid = h('div', {});
      mid.appendChild(h('div', {}, [
        h('span', { class: 'sk-name', text: s.name }),
        h('span', { class: 'sk-id', text: '  ' + s.id + ' · ' + s.contract }),
      ]));
      mid.appendChild(h('div', { class: 'sk-desc', text: s.description }));
      var chips = h('div', { class: 'sk-chips' });
      (s.triggers || []).forEach(function (t) { chips.appendChild(tag('#' + t)); });
      (s.pages || []).forEach(function (p) { chips.appendChild(tag(p, 'mono')); });
      mid.appendChild(chips);
      row.appendChild(mid);
      row.appendChild(h('div', { class: 'acts' }, [
        h('button', { class: 'btn', type: 'button', text: '停用', onclick: function () { toggleEnabled(s.id); } }),
      ]));
      sec.appendChild(row);
    });
    box.appendChild(sec);
    box.appendChild(h('div', {
      class: 'd-foot',
      text: '助手这一项不吃「项目变量」那套：它拿的是当轮的对话上下文与工具结果，所以这一栏没有变量表。它与上面 11 个场景不是一回事，所以单列。',
    }));
  }

  function renderAll(box) {
    box.appendChild(h('div', { class: 'd-head' }, [
      h('div', { class: 'd-title' }, [
        h('h3', { text: '全部 Skill' }),
        h('div', { class: 'd-used', text: '原来的全量清单退到这里：按来源/状态查一份 Skill，或者找一份还没归位的。它不再和「使用地方」并排出现 —— 那就是今天这份重复的来源。' }),
      ]),
      h('div', { class: 'acts' }, [
        h('button', { class: 'btn', type: 'button', text: '回到场景', onclick: function () { state.mode = 'scene'; render(); } }),
      ]),
    ]));
    var sec = h('div', { class: 'sec' });
    sec.appendChild(h('div', { class: 'sec-h' }, [
      h('b', { text: SKILLS.length + ' 份' }),
      h('span', { class: 'hint', text: '每一份都标了它归哪个场景' }),
    ]));
    var all = h('div', { class: 'allbox' });
    SKILLS.forEach(function (s) {
      var sc = sceneByContract(s.contract);
      var row = h('div', { class: 'allrow' });
      row.appendChild(h('div', {}, [
        h('span', { class: 'allname', text: s.name }),
        h('span', { class: 'sk-id', text: '  ' + s.id }),
        h('div', { class: 'sk-desc', text: s.description }),
      ]));
      row.appendChild(h('div', { class: 'acts' }, [
        sc ? tag(sc.label, 'mono') : tag('—'),
        tag(s.source === 'builtin' ? '内置' : '我的'),
        tag(s.enabled ? '已启用' : '已停用', s.enabled ? 'ok' : ''),
      ]));
      all.appendChild(row);
    });
    sec.appendChild(all);
    box.appendChild(sec);
  }

  /* =====================================================================
     现状（对照）
     ===================================================================== */
  function renderOld() {
    var root = document.getElementById('viewOld');
    clear(root);

    root.appendChild(h('div', { class: 'ov-note' }, [
      h('span', { text: '!' }),
      h('span', {
        html: '下面这一屏是<b>改造前</b>的结构（现在真品上已经没有了）。重复有两处：① 一级菜单把 12 个使用地方平铺，没有分组；'
          + '② 它下面又是一份全量 Skill 清单 —— 同一批 Skill 又列了一遍；'
          + '③ 变量表绑在「选中的某一份 Skill」上，可变量其实是场景级的东西。'
          + '另外「复制为我的 Skill」与「导出」两条<b>已整族删除</b> —— 内置只读，要改就自己新建一份。',
      }),
    ]));

    /* ① 使用地方：12 行平铺 */
    var slots = h('div', { class: 'ov-slots' });
    slots.appendChild(h('div', { class: 'ov-slots-h' }, [
      h('b', { text: '使用地方' }),
      h('span', { class: 'hint', text: '每一处现在用的是哪一份；点一行看/改那一份' }),
    ]));
    allScenes().forEach(function (sc) {
      var list = skillsOf(sc.contract);
      var active = activeOf(sc);
      var btn = h('button', {
        class: 'ov-slot', type: 'button',
        onclick: function () {
          if (sc.key === 'assistant') { say('助手那项是按需触发的：没有「固定一份」可选。'); return; }
          if (active) { state.oldSel = active.id; render(); }
          else { say('「' + sc.label + '」现在用的是内置默认 —— 下面已筛出相关 Skill。'); }
        },
      });
      btn.appendChild(h('span', { class: 'ov-slot-l', text: sc.label }));
      var right = h('span', { class: 'ov-slot-r' });
      if (sc.key === 'assistant') right.appendChild(tag('按需触发', 'acc'));
      else if (active) right.appendChild(tag((active.source === 'builtin' ? '内置' : '我的') + '·' + active.name, active.source === 'user' ? 'acc' : 'ok'));
      else right.appendChild(tag('内置默认', 'warn'));
      if (list.some(isConflict)) right.appendChild(tag('contract 冲突', 'err'));
      btn.appendChild(right);
      btn.appendChild(h('span', { class: 'ov-slot-u', text: sc.used }));
      slots.appendChild(btn);
    });
    root.appendChild(slots);

    /* ② 全量清单 + 筛选 */
    var filters = h('div', { class: 'ov-filters' });
    var chips = h('span', { class: 'chips' });
    [['all', '全部'], ['enabled', '已启用'], ['disabled', '已停用'], ['builtin', '内置'], ['user', '我的']].forEach(function (f) {
      chips.appendChild(h('button', {
        class: 'chip' + (state.oldFilter === f[0] ? ' on' : ''), type: 'button', text: f[1],
        onclick: function () { state.oldFilter = f[0]; render(); },
      }));
    });
    filters.appendChild(h('span', { class: 'hint', text: '筛选' }));
    filters.appendChild(chips);
    filters.appendChild(h('input', {
      class: 'ov-search', type: 'search', value: state.oldQ,
      placeholder: '名称 / id / 描述 / 触发词',
      oninput: function (e) { state.oldQ = e.target.value; render(); },
    }));
    filters.appendChild(h('button', { class: 'btn', type: 'button', text: '重新读取', onclick: function () { say('重新读取 Skill 清单。'); } }));
    filters.appendChild(h('button', { class: 'btn', type: 'button', text: '导入 .md / .zip', onclick: function () { say('导入一个 .md / .zip 安装成一份 Skill。'); } }));
    var shown = filteredOld();
    filters.appendChild(h('span', { class: 'hint', text: shown.length + ' / ' + SKILLS.length + ' 份 Skill' }));
    root.appendChild(filters);

    var layout = h('div', { class: 'ov-layout' });
    var list = h('div', { class: 'ov-list' });
    shown.forEach(function (s) {
      var it = h('button', {
        class: 'ov-item' + (state.oldSel === s.id ? ' on' : ''), type: 'button',
        onclick: function () { state.oldSel = s.id; render(); },
      });
      it.appendChild(h('span', { class: 'ov-l1' }, [
        h('b', { class: 'ov-name', text: s.name }),
        h('span', { class: 'ov-id', text: s.id }),
      ]));
      var chips2 = h('span', { class: 'sk-chips' });
      chips2.appendChild(tag(s.enabled ? '已启用' : '已停用', s.enabled ? 'ok' : ''));
      chips2.appendChild(tag(s.source === 'builtin' ? '内置' : '我的'));
      if (s.contract) chips2.appendChild(tag(s.contract, 'mono'));
      it.appendChild(chips2);
      it.appendChild(h('span', { class: 'sk-desc', text: s.description }));
      list.appendChild(it);
    });
    layout.appendChild(list);

    /* 详情：变量表在这里（绑在选中的这一份上） */
    var detail = h('div', { class: 'ov-detail' });
    var sel = SKILLS.filter(function (x) { return x.id === state.oldSel; })[0] || shown[0] || SKILLS[0];
    if (sel) {
      state.oldSel = sel.id;
      detail.appendChild(h('h3', { text: sel.name }));
      detail.appendChild(h('div', { class: 'ov-meta', text: sel.id + ' · v' + sel.version + ' · ' + (sel.source === 'builtin' ? '内置（只读）' : '我的 Skill') + ' · 契约 ' + sel.contract }));
      var acts = h('div', { class: 'acts' });
      acts.appendChild(h('button', { class: 'btn', type: 'button', text: sel.enabled ? '停用' : '启用', onclick: function () { toggleEnabled(sel.id); } }));
      acts.appendChild(h('button', { class: 'btn', type: 'button', text: sel.source === 'builtin' ? '复制为我的 Skill' : '更新（导入同 id）', onclick: function () { say('复制/更新：' + sel.id); } }));
      acts.appendChild(h('button', { class: 'btn', type: 'button', text: '导出', onclick: function () { say('导出 ' + sel.id); } }));
      detail.appendChild(acts);
      detail.appendChild(h('div', { class: 'ov-desc2 sk-desc', text: sel.description }));
      detail.appendChild(h('div', { class: 'ov-flags' }, [h('b', { text: '触发词' }), sel.triggers.join(' / ')]));
      detail.appendChild(h('div', { class: 'ov-flags' }, [h('b', { text: '页面' }), sel.pages.join(' / ')]));
      detail.appendChild(h('div', { class: 'ov-flags' }, [h('b', { text: '机器契约' }), sel.contract]));

      var ref = h('div', { class: 'ov-ref' });
      ref.appendChild(h('div', { class: 'ov-flags' }, [
        h('b', { text: '项目引用规则' }),
        h('span', { class: 'hint', text: '正文里的 {变量} 由程序按当前项目填料' }),
      ]));
      var sc = sceneByContract(sel.contract);
      var known = sc && sc.vars ? sc.vars : [];
      if (sel.placeholders && sel.placeholders.length) {
        sel.placeholders.forEach(function (p) {
          var hit = known.filter(function (v) { return v.name === p; })[0];
          ref.appendChild(h('div', { class: 'vrow' }, [
            h('span', { class: 'vk', text: '{' + p + '}' }),
            h('span', { class: 'vfrom', text: hit ? hit.from : '（未登记）' }),
            h('span', { class: 'vdesc', text: hit ? hit.desc : '正文里用到但没写说明' }),
          ]));
        });
      } else {
        ref.appendChild(h('div', { class: 'vempty', text: '这份正文里没有 {变量} 占位符 —— 程序不用给它填料。' }));
      }
      detail.appendChild(ref);

      detail.appendChild(h('div', { class: 'ov-flags', style: 'margin-top:12px' }, [h('b', { text: '正文预览' })]));
      detail.appendChild(h('pre', { class: 'ov-pre', text: mockBody(sel) }));
    }
    layout.appendChild(detail);
    root.appendChild(layout);
  }

  function filteredOld() {
    var kw = state.oldQ.trim().toLowerCase();
    return SKILLS.filter(function (s) {
      if (state.oldFilter === 'enabled' && !s.enabled) return false;
      if (state.oldFilter === 'disabled' && s.enabled) return false;
      if (state.oldFilter === 'builtin' && s.source !== 'builtin') return false;
      if (state.oldFilter === 'user' && s.source !== 'user') return false;
      if (!kw) return true;
      return [s.id, s.name, s.description, (s.triggers || []).join(' '), s.contract].join(' ').toLowerCase().indexOf(kw) >= 0;
    });
  }

  function mockBody(s) {
    return '---\nid: ' + s.id + '\nname: ' + s.name + '\ndescription: ' + s.description +
      '\ntriggers: [' + s.triggers.map(function (t) { return '"' + t + '"'; }).join(', ') +
      ']\npages: [' + s.pages.map(function (p) { return '"' + p + '"'; }).join(', ') +
      ']\ncontract: ' + s.contract + '\nversion: ' + s.version + '\n---\n\n# ' + s.name +
      '\n\n（正文 ' + s.chars + ' 字）\n\n这一份告诉 AI：这类活儿该怎么写。' +
      (s.placeholders.length ? '\n\n可用到的位置：' + s.placeholders.map(function (p) { return '{' + p + '}'; }).join(' ') : '');
  }

  /* ---------- 渲染入口 ---------- */
  function render() {
    var isNew = state.ver === 'new';
    document.getElementById('viewNew').hidden = !isNew;
    document.getElementById('viewOld').hidden = isNew;
    document.getElementById('subNew').hidden = !isNew;
    document.getElementById('subOld').hidden = isNew;
    Array.prototype.forEach.call(document.querySelectorAll('.seg-b'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-ver') === state.ver);
    });
    if (isNew) { renderRail(); renderDetail(); }
    else renderOld();
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg-b'), function (b) {
      b.addEventListener('click', function () { state.ver = b.getAttribute('data-ver'); say(''); render(); });
    });
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
