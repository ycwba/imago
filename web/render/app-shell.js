/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/app-shell.html 编译，别手改。 */
import { resolveComponent as _resolveComponent, openBlock as _openBlock, createBlock as _createBlock, createCommentVNode as _createCommentVNode, KeepAlive as _KeepAlive, vShow as _vShow, createElementVNode as _createElementVNode, withDirectives as _withDirectives, createElementBlock as _createElementBlock } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = { class: "spa-shell" }
const _hoisted_2 = { class: "spa-frame-wrap" }

export function render(_ctx, _cache) {
  const _component_page_frame = _resolveComponent("page-frame")

  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _withDirectives(_createElementVNode("div", _hoisted_2, [
      (_openBlock(), _createBlock(_KeepAlive, null, [
        (_ctx.activeView)
          ? (_openBlock(), _createBlock(_component_page_frame, {
              key: _ctx.state.route.file,
              view: _ctx.activeView
            }, null, 8 /* PROPS */, ["view"]))
          : _createCommentVNode("v-if", true)
      ], 1024 /* DYNAMIC_SLOTS */))
    ], 512 /* NEED_PATCH */), [
      [_vShow, !!_ctx.activeView]
    ])
  ]))
}
