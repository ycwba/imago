/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/app-error.html 编译，别手改。 */
import { toDisplayString as _toDisplayString, createElementVNode as _createElementVNode, openBlock as _openBlock, createElementBlock as _createElementBlock } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "spa-frame-loading",
  style: {"color":"var(--err)"}
}
const _hoisted_2 = ["onClick"]

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createElementVNode("span", null, "这一页没有加载起来：" + _toDisplayString(_ctx.error && _ctx.error.message || _ctx.error), 1 /* TEXT */),
    _createElementVNode("button", {
      type: "button",
      class: "ghost",
      onClick: _ctx.retry
    }, "重新加载本页", 8 /* PROPS */, _hoisted_2)
  ]))
}
