# 页面样式总览（demo）

> 纯静态、不进运行时。双击 `index.html`（或任意静态服务器）打开即可，不需要代理。

## 这是什么

一页看完七个页面长什么样：导演台 / 素材库 / 生成工作台 / 我的收藏 / 资产库 / 用量与余额 / 设置。
底部那条「样式示意」控制条负责切页与深浅主题，不属于任何页面。

## 怎么搭的（决策）

- **真样式表，不是截图**：`index.html` 直接 `../../web/styles/` 链接 tokens / ui / wb / sidebar / spa-* 十份真 CSS，
  每个页面示意都挂在**真实根类**下（`.chars-page .page-shell`、`.studio-page .wb`、`.settings-page` …），
  公共件（`.phead` `.ui-seg` `.task` `.bulkbar` `.viewtoggle` `.fcard` …）按 `web/styles/ui.css` 的真实类名手写。
  产品改了样式，重开这一页就是新面貌；demo 里**没有任何一份复制的样式值**。
- **侧栏**照 `web/ui/sidebar.js` 的 DOM 手抄一份静态示意（品牌砖 / 导航 / 余额卡 / 产物存本机行 / 底部设置与换背景），
  收展开关与真品同键：`html.sb-open` + `--sbw` 跟随当前宽度（demo.js 里三行）。
- **导演台是唯一手绘的一份**：它的样式住在 `web/director/template.html` 内嵌 `<style>`（作用域岛，无文件可外链），
  demo.css 按**同一副骨架与令牌**画缩小示意（三栏 clamp 宽、232px 轨道板、胶片格 / 配音 / 字幕三条道）。
  它不是第二份真相——真品仍是 template.html；这里只求「看个样子」。
- **没有真实字节**：缩略图与预览用主题色渐变占位（`.demo-ph-*`），翻页、弹层、下拉都是静帧。
- **主题**：demo.js 切 `html[data-theme="dark"]`，tokens.css 的深色档直接生效，七页一起换。

## 边界

- file:// 直开；不进路由表、不进预编译清单、不被 static.js 提供（design/ 不在服务范围）。
- 示意里的数字、名字、账单均为编造样例。
- 改产品界面时**不需要**同步本 demo；它只在「想一眼看全站长相」时打开。
