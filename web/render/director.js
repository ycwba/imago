/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/director.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, openBlock as _openBlock, createElementBlock as _createElementBlock, createCommentVNode as _createCommentVNode, toDisplayString as _toDisplayString, createTextVNode as _createTextVNode, Fragment as _Fragment } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  key: 0,
  class: "spa-frame-loading"
}
const _hoisted_2 = {
  class: "director-page",
  ref: "host"
}
const _hoisted_3 = {
  key: 1,
  class: "director-fallback"
}
const _hoisted_4 = { class: "hint" }
const _hoisted_5 = ["onClick"]

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock(_Fragment, null, [
    (_ctx.loading)
      ? (_openBlock(), _createElementBlock("div", _hoisted_1, [...(_cache[0] || (_cache[0] = [
          _createElementVNode("span", { class: "spin-dot" }, null, -1 /* CACHED */),
          _createElementVNode("span", null, "正在打开导演台…", -1 /* CACHED */)
        ]))]))
      : _createCommentVNode("v-if", true),
    _createElementVNode("div", _hoisted_2, null, 512 /* NEED_PATCH */),
    (_ctx.failed)
      ? (_openBlock(), _createElementBlock("div", _hoisted_3, [
          _createElementVNode("div", _hoisted_4, [
            _createTextVNode("导演台没有启动：" + _toDisplayString(_ctx.failed) + "。如果一直失败，看控制台里那一条 [director] 报错。 ", 1 /* TEXT */),
            _createElementVNode("button", {
              class: "ghost mini",
              onClick: _ctx.retryLoad
            }, "重新加载本页", 8 /* PROPS */, _hoisted_5)
          ])
        ]))
      : _createCommentVNode("v-if", true)
  ], 64 /* STABLE_FRAGMENT */))
}
