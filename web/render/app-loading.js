/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/app-loading.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, openBlock as _openBlock, createElementBlock as _createElementBlock } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = { class: "spa-frame-loading" }

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [...(_cache[0] || (_cache[0] = [
    _createElementVNode("span", { class: "spin-dot" }, null, -1 /* CACHED */),
    _createElementVNode("span", null, "加载中…", -1 /* CACHED */)
  ]))]))
}
