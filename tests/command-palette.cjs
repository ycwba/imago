/* 全局命令面板判据：页面清单只有路由表一份、跳页只走 GoPage、全局只占一个唤起键、
   输入框与输入法状态不抢键、面板内按键不外漏到导演台作用域岛。
   用 vm 把 web/ui/command.js 当经典脚本跑起来，DOM 全给最小替身。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const src = read('web/ui/command.js');
let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('  ✗ ' + msg); } };

const mockPages = [
  { file: 'director.html', id: 'director', label: '导演台', short: '导演', title: '导演台' },
  { file: 'studio.html', id: 'studio', label: '工作台', short: '工作', title: '工作台' },
  { file: 'usage.html', id: 'usage', label: '用量与余额', short: '用量', title: '用量与余额' },
  { file: 'settings.html', id: 'settings', label: '设置', title: '设置' },
];

function load() {
  const jumps = [], docHandlers = [];
  const key = () => ({ preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  const inputEl = {
    tagName: 'INPUT', value: '', listeners: {},
    addEventListener(t, fn) { this.listeners[t] = fn; },
    focus() {},
  };
  const listEl = { innerHTML: '', addEventListener() {} };
  const rootEl = {
    hidden: true, className: '', innerHTML: '',
    setAttribute() {}, addEventListener() {},
    querySelector(sel) { return sel === '.cmd-input' ? inputEl : listEl; },
  };
  const document = {
    activeElement: { tagName: 'DIV' },
    createElement() { return rootEl; },
    body: { appendChild() {} },
    addEventListener(type, fn) { if (type === 'keydown') docHandlers.push(fn); },
  };
  const win = {
    WB_ROUTES: { pages: mockPages },
    GoPage: { go(file) { jumps.push(file); } },
    esc: s => String(s == null ? '' : s),
    focusQuiet() {},
  };
  const ctx = { window: win, document, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'web/ui/command.js' });
  return { CP: win.CommandPalette, docHandlers, inputEl, listEl, rootEl, jumps, win, key };
}

/* ---------- ① 候选项只有路由表一份真相 ---------- */
const a = load();
ok(typeof a.CP.candidates === 'function', 'CommandPalette 没有暴露 candidates');
ok(a.CP.candidates('').length === mockPages.length, '候选条数与路由表条数不一致');
ok(a.CP.candidates('用量').length === 1 && a.CP.candidates('用量')[0].target === 'usage.html',
  '按名字筛不出来（用量与余额 → usage.html）');
ok(a.CP.candidates('不存在').length === 0, '没命中时还给了候选项');
/* 现取，不缓存：换掉路由表后立即跟着变 */
a.win.WB_ROUTES.pages = mockPages.slice(0, 1);
ok(a.CP.candidates('').length === 1, '路由表被抄了一份缓存（改了不跟着变）');
for (const word of ['导演台', '工作台', '用量与余额', '设置']) {
  ok(!src.includes("'" + word + "'"), '命令面板里写死了页面名「' + word + '」（第二份清单）');
}
ok(/WB_ROUTES[\s\S]{0,80}\.pages/.test(src), '候选清单不是从路由表读的');
ok(!/location\.(href|hash)/.test(src), '跳页绕开了 GoPage.go（手拼了 location）');
ok(/window\.GoPage\.go\(/.test(src), '没有走 GoPage.go');
ok(!/ActionRegistry|ACTS\b|ACTION_META/.test(src), '命令面板复制了动作目录');

/* ---------- ② 全局只占一个唤起键，且不抢输入框 / 输入法 ---------- */
ok((src.match(/document\.addEventListener\('keydown'/g) || []).length === 1,
  '全局键盘监听不止一处（会与导演台作用域岛抢键）');
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
ok((codeOnly.match(/Ctrl\/Cmd\+K/g) || []).length === 1, '快捷键表被抄成了两份');
const g = a.docHandlers[0];
ok(typeof g === 'function', '全局唤起键没挂上');
let e = Object.assign(a.key(), { key: 'k', ctrlKey: true, metaKey: false, target: { tagName: 'DIV' } });
g(e);
ok(a.CP.isOpen() === true, 'Ctrl+K 没唤起面板');
ok(e.prevented === true && e.stopped === true, '唤起键没截断（会漏到导演台）');
a.CP.close();
e = Object.assign(a.key(), { key: 'k', ctrlKey: true, metaKey: false, target: { tagName: 'INPUT' } });
g(e);
ok(a.CP.isOpen() === false, '在输入框里抢了 Ctrl+K');
e = Object.assign(a.key(), { key: 'k', ctrlKey: true, metaKey: false, target: { tagName: 'DIV' }, isComposing: true });
g(e);
ok(a.CP.isOpen() === false, '输入法合成中抢了 Ctrl+K');
e = Object.assign(a.key(), { key: 'a', ctrlKey: false, metaKey: false, target: { tagName: 'DIV' } });
g(e);
ok(a.CP.isOpen() === false, '普通按键也被面板拦了');

/* ---------- ③ 面板内按键不外漏；Enter 只跳页 ---------- */
const b = load();
b.CP.show();
ok(b.rootEl.hidden === false, 'show() 没把浮层显示出来');
ok(b.listEl.innerHTML.includes('cmd-item'), '面板没画出候选项');
const onKey = b.inputEl.listeners.keydown;
ok(typeof onKey === 'function', '面板输入框没接键盘');
let ev = Object.assign(b.key(), { key: 'ArrowDown', target: { tagName: 'INPUT' } });
onKey(ev);
ok(ev.stopped === true, '↑↓ 漏到了导演台作用域岛');
b.inputEl.value = '用量';
b.inputEl.listeners.input();          // 输入触发一次重画，候选集合跟着收窄
ev = Object.assign(b.key(), { key: 'Enter', target: { tagName: 'INPUT' } });
onKey(ev);
ok(b.jumps.length === 1 && b.jumps[0] === 'usage.html',
  'Enter 没有跳到选中的那一页（' + JSON.stringify(b.jumps) + '）');
ok(b.CP.isOpen() === false, '跳页之后面板没收起');
ok(ev.stopped === true, 'Enter 漏到了导演台作用域岛');
b.CP.show();
ev = Object.assign(b.key(), { key: 'Escape', target: { tagName: 'INPUT' } });
onKey(ev);
ok(b.CP.isOpen() === false && ev.stopped === true, 'Esc 没关掉面板或漏到了外面');

/* ---------- ④ 外壳接线与样式走令牌 ---------- */
const shell = read('shell.html');
ok(/<script src="web\/ui\/command\.js"><\/script>/.test(shell), 'shell.html 没挂载命令面板');
ok(shell.indexOf('web/ui/command.js') > shell.indexOf('web/core/routes.js'), '命令面板排在路由表之前（求值期拿不到页面清单）');
const css = read('web/styles/ui.css');
ok(/\.cmd-palette \{/.test(css) && /\.cmd-item\.is-sel \{/.test(css), 'ui.css 里没有面板样式');
const block = css.slice(css.indexOf('.cmd-palette {'));
ok(!/\d+px/.test(block), '面板样式里写了裸 px（没走令牌）');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), '面板样式里写了裸色值');

console.log(bad ? '\n✗ 全局命令面板：' + bad + ' / ' + n + ' 条对不上'
  : '\n✓ 全局命令面板：' + n + ' 条判据通过');
process.exit(bad ? 1 : 0);
