#!/usr/bin/env node
/* 设置键一张账—— 跑法：node tests/settings-schema.cjs
   「一项设置有哪些待遇」（跟着 .data 走 / 进设置导出 / 恢复默认不清 / 助手可改）
   只由 ui.js 的 `window.UI_PREFS` 一张声明答：rows（界面偏好）+ setRows（普通设置行）
   + families（键族）三节，节默认压底、条目显式标记压过节默认，认不出的键一律 false。
   设置页的导出 / 恢复默认、DataSync 的同步名单、助手可改白名单都是那张表的读法，
   不再各抄一份字面量名单 —— 所以这份判据不扫名单，而是**用 vm 求值真实的 UI_PREFS，
   直接调用真方法**断言待遇；名单本身没了，就没有「名单与表漂移」这类问题可判。
   另外判两件接线的事：加载顺序（datasync 取同步口径时 ui.js 必须已求值完）、
   云同步三格与 .env 的「填写 / 留空 / 内置默认」三档口径。
   云同步与「恢复默认」都是会动用户数据的路径，所以这里只做只读判据，不真去 sweep 或发请求。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0, total = 0;
const ok = (name, cond, hint) => {
  total++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && hint ? ' —— ' + hint : ''));
  if (!cond) fails++;
};
console.log('§ 设置键一张账（UI_PREFS 求值 · 只读判据）');

/* ---------- 求值真实的 UI_PREFS ----------
   从 `window.UI_PREFS = {` 起做括号扫描（跳过注释与字符串），取出整个对象字面量，
   在沙箱里求值 —— rows 里 `opts: window.VIEW_MODES` 在求值期就要有值，所以沙箱先塞。 */
const src = read('web/ui/ui.js');
function extractObject(s, marker) {
  const at = s.indexOf(marker);
  if (at < 0) return '';
  let i = s.indexOf('{', at), depth = 0, out = '';
  for (; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (c === '/' && n === '/') { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j; out += '\n'; continue; }
    if (c === '/' && n === '*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 1; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c;
      for (i++; i < s.length; i++) {
        const d = s[i]; out += d;
        if (d === '\\') { i++; out += s[i]; continue; }
        if (d === q) break;
      }
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (!depth) { out += c; break; } }
    out += c;
  }
  return out;
}
const sandbox = { window: { VIEW_MODES: [['list', '列表'], ['compact', '紧凑']] },
  localStorage: { getItem: () => null }, console };
vm.runInNewContext('window.UI_PREFS = ' + extractObject(src, 'window.UI_PREFS = {') + ';', sandbox);
const UP = sandbox.window.UI_PREFS;
ok('UI_PREFS 求值成功（rows / setRows / families 三节齐全）',
  !!UP && Array.isArray(UP.rows) && Array.isArray(UP.setRows) && Array.isArray(UP.families),
  '求值失败 = extractObject 没取出对象或求值期抛错');

/* 方法依赖 this（对象方法调用自然带上），不要解构：直接 UP.syncOf(k)。 */
const KEEP_WANT = ['dir_palette', 'dir_theme', 'sb_open', 'dir_asset_view', 'dir_fav_view',
  'sk_media_local', 'sk_media_prefer', 'sk_media_badge', 'sk_media_cloud_hide',
  'sk_media_local_scope', 'sb_bal_on', 'sb_mirror_on', 'ai_chat_off', 'sk_local_dir'];
const ASSIST_WANT = [...UP.rows.map(r => r.key),
  'sk_polish_ask', 'sk_model_vframes', 'sk_model_vframe_n',
  'sk_text_vision', 'sk_text_audio', 'sk_text_video'];

/* ---------- 节默认与三节待遇 ---------- */
ok('rows 精确键三档全开（同步 / 导出 / 恢复默认不清）',
  UP.syncOf('dir_theme') === true && UP.exportOf('dir_theme') === true && UP.keepOf('dir_theme') === true,
  'dir_theme 的待遇 = ' + [UP.syncOf('dir_theme'), UP.exportOf('dir_theme'), UP.keepOf('dir_theme')].join(','));

/* ---------- keepKeys：恰好 14 枚 ---------- */
const kk = UP.keepKeys();
ok('「恢复默认不清」恰好 14 枚（rows 9 + setRows 4 + families 1）',
  kk.length === 14 && KEEP_WANT.every(k => kk.includes(k)),
  'keep=' + kk.join(',') + '（应当恰好是 ' + KEEP_WANT.join(',') + '）');
ok('安静档这类纯显示项可以被恢复默认清掉', !kk.includes('sk_quiet_ok'), 'sk_quiet_ok 被标了 keep');
ok('「关掉助手」这一条恢复默认也不清', kk.includes('ai_chat_off'),
  'keepKeys 里没有 ai_chat_off：一次「恢复默认」会把那颗悬浮球重新装回来');

/* ---------- 助手可改白名单（静态档） ---------- */
const specs = UP.assistSpecs();
const specKeys = Object.keys(specs);
ok('助手静态白名单恰好 ' + ASSIST_WANT.length + ' 枚（rows 全部 + setRows 3 + families 3）',
  specKeys.length === ASSIST_WANT.length && ASSIST_WANT.every(k => specs[k]),
  'specs=' + specKeys.join(',') + '（应当恰好是 ' + ASSIST_WANT.join(',') + '）');
ok('静态白名单每一项都有「名」与取值形状（取值 / 数值 / 文本之一）',
  specKeys.every(k => specs[k].名 && (specs[k].取值 || specs[k].数值 || specs[k].文本)),
  specKeys.filter(k => !(specs[k].名 && (specs[k].取值 || specs[k].数值 || specs[k].文本))).join(','));
ok('分页 / 素材库 / 型号三族是动态档（声明在才去取清单）',
  UP.assistDynamic('page') && UP.assistDynamic('chars') && UP.assistDynamic('model'),
  [UP.assistDynamic('page'), UP.assistDynamic('chars'), UP.assistDynamic('model')].join(','));

/* ---------- 漂移点：助手开关那六条的口径 ---------- */
const ASSIST = ['ai_chat_auto', 'ai_chat_off', 'ai_chat_snap', 'ai_chat_notice', 'ai_chat_dock', 'ai_chat_ref_send'];
ok('助手那六颗开关进导出（notice/snap 漂移的收口）', ASSIST.every(k => UP.exportOf(k)),
  ASSIST.filter(k => !UP.exportOf(k)).join(','));
ok('除「固定右栏」外都是本机的事：不跟云同步', ASSIST.filter(k => k !== 'ai_chat_dock').every(k => UP.syncOf(k) === false)
  && UP.syncOf('ai_chat_dock') === true,
  ASSIST.filter(k => k !== 'ai_chat_dock' && UP.syncOf(k) !== false).join(','));

/* ---------- rows 全同步、setRows 进导出 ---------- */
ok('每一项界面偏好都跟着 .data 走（含 sb_open / sk_media_badge）',
  UP.keys().every(k => UP.syncOf(k)), UP.keys().filter(k => !UP.syncOf(k)).join(','));
ok('普通设置行（setRows）默认进导出', UP.setRows.every(r => UP.exportOf(r.key || r.num)),
  UP.setRows.filter(r => !UP.exportOf(r.key || r.num)).map(r => r.key || r.num).join(','));

/* ---------- 新增体检点：节内覆盖关系 ---------- */
ok('型号面板的本机草稿不进导出，型号偏好照走',
  UP.exportOf('sk_model_meta_x') === false && UP.exportOf('sk_model_gpt-4') === true,
  [UP.exportOf('sk_model_meta_x'), UP.exportOf('sk_model_gpt-4')].join(','));
ok('建模台的生成规矩进导出', UP.exportOf('sk_model3d_reuse') === true);
ok('导演台底栏坞档跟着走', UP.syncOf('dir_dock') === true);
ok('dock_h 死值与工作区救生包都不算设置', UP.exportOf('dir_dock_h') === false && UP.exportOf('dir_ws_unload') === false,
  [UP.exportOf('dir_dock_h'), UP.exportOf('dir_ws_unload')].join(','));
ok('补存游标跟着 scope 走但不进导出（它是游标不是设置）',
  UP.syncOf('sk_media_local_since') === true && UP.exportOf('sk_media_local_since') === false);
ok('密钥标凭据（导出时另问一次），地址不标', UP.secretOf('sk_key_x') === true && UP.secretOf('sk_base_x') === false,
  [UP.secretOf('sk_key_x'), UP.secretOf('sk_base_x')].join(','));
ok('首屏缓存既不同步也不导出', UP.syncOf('assets_cache_v1') === false && UP.exportOf('studio_tasks_cache_v1') === false,
  [UP.syncOf('assets_cache_v1'), UP.exportOf('studio_tasks_cache_v1')].join(','));
ok('余额缓存不能被「余额」精确键形似带进去', UP.syncOf('sb_bal_cache') === false);
ok('认不出的键一律 false（fail-closed）', UP.syncOf('no_such_key') === false && UP.exportOf('no_such_key') === false);

/* ---------- 接线：三处读法都在，名单字面量没了 ---------- */
const st = read('web/pages/settings.js');
const ds = read('web/ui/datasync.js');
const ct = read('web/features/chat-tools.js');
ok('设置页普通设置行取 UI_PREFS.setRows（不是再抄一份）',
  /const SET_ROWS = \(window\.UI_PREFS && window\.UI_PREFS\.setRows\)/.test(st));
ok('设置页导出 / 恢复默认问 UI_PREFS（exportOf / keepKeys / secretOf）',
  /UI_PREFS\.exportOf/.test(st) && /UI_PREFS\.keepKeys/.test(st) && /UI_PREFS\.secretOf/.test(st));
ok('DataSync 的同步口径问 UI_PREFS.syncOf，三份手抄名单已删',
  /UI_PREFS\.syncOf/.test(ds) && !/const (SYNCABLE|NOT_SYNC|PREF_KEYS) = \[/.test(ds));
ok('助手白名单问 assistSpecs / assistDynamic，ADJUST 字面量已删',
  /assistSpecs/.test(ct) && /assistDynamic/.test(ct) && !/const ADJUST = \{/.test(ct));
ok('设置页写的几族键都能导出',
  ['sk_key_x', 'sk_off_x', 'sk_model_x', 'page_mode_x', 'page_size_x',
    ...UP.setRows.map(r => r.key || r.num), ...UP.keys()].every(k => UP.exportOf(k)),
  '漏：' + ['sk_key_x', 'sk_off_x', 'sk_model_x', 'page_mode_x', 'page_size_x',
    ...UP.setRows.map(r => r.key || r.num), ...UP.keys()].filter(k => !UP.exportOf(k)).join(','));

/* ---------- 加载顺序：datasync.js 问 syncOf 时 ui.js 必须已经求值完 ----------
   datasync.js 不在 shell.html 里常驻：它由路由表的 `needs` 补载（路由表声明、app.js 发；
   与页面模块并行，但补载通道不变）。UI_PREFS 是 ui.js 求值时才挂上 window 的，datasync.js
   早一步就问不到（那时宁可这轮不同步）。ui.js 是壳里的同步经典脚本，任何经补载通道进来的
   datasync.js 都排在它之后求值；这里验的是「datasync 确实走的是补载通道，而不是也进了壳」。
   两种挂法（壳里串着排 / 走 needs）都验同一件事。 */
const shell = read('shell.html');
const order = [...shell.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
const iUi = order.findIndex(s => s.endsWith('web/ui/ui.js'));
const iDs = order.findIndex(s => s.endsWith('web/ui/datasync.js'));
const lazyDs = iDs < 0
  && /web\/ui\/datasync\.js/.test(read('web/core/routes.js'))
  && /__spaNeeds\(/.test(read('web/app.js'));
ok('ui.js 先于 datasync.js 求值（壳里排在前面，或 datasync 走路由 needs 在页面组件之前补载）',
  iUi >= 0 && (iDs > iUi || lazyDs),
  'ui.js=' + iUi + ' datasync.js=' + iDs + ' 按页补载=' + lazyDs);

/* ---------- 云同步三格与 .env 的「填写 / 留空 / 内置默认」三档口径 ----------
   服务端 cloudCfg 的三档由 data-hub 判据守；这里守页面这一侧：默认地址只能由代理下发，
   页面既不能预填、也不能把空串顶回默认地址，三格空值更不能当成「填了」带进请求头 ——
   任何一样漏了，.env 里的值就永远用不上。 */
const tpl = read('tools/vue-templates/settings.html');
const hubSrc = read('server/data-hub.js');
const cloudSrc = st.slice(st.indexOf('/* ---------- 云同步（WebDAV） ---------- */'),
  st.indexOf('/* 归档目录不在正文里'));
ok('云同步地址：本机没存过 / 存了空串都保持空（不预填默认地址）',
  /const cloudUrl = ref\(''\);/.test(cloudSrc)
  && /cloudUrl\.value = g\('url'\) \|\| '';/.test(cloudSrc)
  && !/https:\/\/dav\.jianguoyun\.com/.test(cloudSrc),
  '地址栏又自己预填了一份默认地址');
ok('默认地址只有代理侧一份，且从 /cloud/status 下发',
  (hubSrc.match(/const CLOUD_DEFAULT_URL = 'https:\/\/dav\.jianguoyun\.com\/dav\/imago\/';/g) || []).length === 1
  && /defaultUrl: CLOUD_DEFAULT_URL/.test(hubSrc)
  && /cloudDefaultUrl\.value = String\(d\.defaultUrl \|\| ''\)/.test(st),
  '默认地址在页面里又写了一遍 / 状态接口没下发 / 页面没接');
ok('地址格的点明三档语义（留空用 .env，都没填用默认）',
  /const cloudUrlHint = computed\(/.test(cloudSrc) && /留空 = 用 \.env；都没填就用/.test(cloudSrc),
  '输入提示没说明第三档，或写死在模板里');
ok('云同步三格都只在非空时才带请求头（留空 = 用 .env）',
  ["if (u) h['x-cloud-url']", "if (n) h['x-cloud-user']", "if (p) h['x-cloud-pass']"]
    .every(s => cloudSrc.includes(s)),
  '有哪一格空值也被当成填写发了出去');
const cloudTpl = tpl.slice(tpl.indexOf('<input id="cloudUrl"'), tpl.indexOf('id="cloudKeys"'));
ok('地址格 placeholder 绑到页面提示，另两格也点明「留空用 .env」',
  /<input id="cloudUrl"[^>]*:placeholder="cloudUrlHint"/.test(cloudTpl)
  && ['cloudUser', 'cloudPass'].every(id =>
    /留空/.test((cloudTpl.match(new RegExp('<input id="' + id + '"[^>]*>')) || [''])[0])));

console.log((fails ? '✗ ' : '✓ ') + total + ' 项，' + fails + ' 项未通过');
process.exit(fails ? 1 : 0);
