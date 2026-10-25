/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/favorites.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, toDisplayString as _toDisplayString, openBlock as _openBlock, createElementBlock as _createElementBlock, createCommentVNode as _createCommentVNode, renderList as _renderList, Fragment as _Fragment, withModifiers as _withModifiers, normalizeStyle as _normalizeStyle } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = { class: "page-main fav-page page-shell" }
const _hoisted_2 = { class: "page-h1" }
const _hoisted_3 = ["innerHTML"]
const _hoisted_4 = {
  class: "toolbar",
  ref: "toolbarEl"
}
const _hoisted_5 = { class: "toolbar2" }
const _hoisted_6 = {
  class: "viewtoggle",
  ref: "viewEl"
}
const _hoisted_7 = ["onClick"]
const _hoisted_8 = ["disabled", "onClick", "innerHTML"]
const _hoisted_9 = ["onChange"]
const _hoisted_10 = {
  key: 0,
  class: "empty"
}
const _hoisted_11 = ["onClick"]
const _hoisted_12 = {
  key: 1,
  class: "empty"
}
const _hoisted_13 = {
  key: 2,
  class: "grid",
  ref: "grids"
}
const _hoisted_14 = {
  key: 0,
  class: "empty"
}
const _hoisted_15 = ["data-key", "onDragstart", "onDragend"]
const _hoisted_16 = ["onClick", "innerHTML"]
const _hoisted_17 = { class: "body card-shell-body" }
const _hoisted_18 = ["onClick"]
const _hoisted_19 = { class: "m" }
const _hoisted_20 = ["innerHTML"]
const _hoisted_21 = { class: "note" }
const _hoisted_22 = ["value", "onInput", "onBlur", "onClick"]
const _hoisted_23 = { class: "acts card-shell-actions" }
const _hoisted_24 = ["title", "onClick"]
const _hoisted_25 = ["disabled", "onClick"]
const _hoisted_26 = ["onClick"]
const _hoisted_27 = {
  id: "gridEnd",
  ref: "gridEnd",
  style: {"height":"1px"}
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createElementVNode("h1", _hoisted_2, [
      _createElementVNode("span", { innerHTML: _ctx.starIcon }, null, 8 /* PROPS */, _hoisted_3),
      _cache[0] || (_cache[0] = _createTextVNode("我的收藏", -1 /* CACHED */))
    ]),
    _createElementVNode("div", _hoisted_4, null, 512 /* NEED_PATCH */),
    _createElementVNode("div", _hoisted_5, [
      _cache[1] || (_cache[1] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
      _createElementVNode("span", _hoisted_6, null, 512 /* NEED_PATCH */),
      _createElementVNode("button", {
        class: "ghost",
        ref: "pullBtn",
        onClick: _ctx.pullLocal,
        title: "把当前筛选里「本机还没有那份字节」的收藏存回本机；本地上传的那一批不算（字节本来就在浏览器里）"
      }, null, 8 /* PROPS */, _hoisted_7),
      _createElementVNode("button", {
        class: "ghost",
        disabled: _ctx.uploading,
        onClick: _ctx.pickFiles,
        innerHTML: _ctx.uploadHtml
      }, null, 8 /* PROPS */, _hoisted_8),
      _createElementVNode("input", {
        type: "file",
        multiple: "",
        hidden: "",
        ref: "fileEl",
        onChange: _ctx.onFiles
      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_9)
    ]),
    (_ctx.failed)
      ? (_openBlock(), _createElementBlock("div", _hoisted_10, [
          _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ghost mini",
            onClick: _ctx.retryLoad
          }, "重新加载本页", 8 /* PROPS */, _hoisted_11)
        ]))
      : (!_ctx.ready)
        ? (_openBlock(), _createElementBlock("div", _hoisted_12, [...(_cache[2] || (_cache[2] = [
            _createElementVNode("span", { class: "spin-dot" }, null, -1 /* CACHED */),
            _createTextVNode(" 正在读取收藏…", -1 /* CACHED */)
          ]))]))
        : (_openBlock(), _createElementBlock("div", _hoisted_13, [
            (!_ctx.viewItems.length)
              ? (_openBlock(), _createElementBlock("div", _hoisted_14, _toDisplayString(_ctx.emptyWhy), 1 /* TEXT */))
              : _createCommentVNode("v-if", true),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.pageItems, (it) => {
              return (_openBlock(), _createElementBlock("div", {
                key: it.key,
                class: "card card-surface",
                draggable: "true",
                "data-key": it.key,
                onDragstart: $event => (_ctx.onCardDragStart($event, it)),
                onDragend: $event => (_ctx.onCardDragEnd($event))
              }, [
                _createElementVNode("div", {
                  class: "thumb card-shell-media",
                  onClick: $event => (_ctx.openLb(it)),
                  innerHTML: _ctx.thumbHtml(it)
                }, null, 8 /* PROPS */, _hoisted_16),
                _createElementVNode("div", _hoisted_17, [
                  _createElementVNode("div", {
                    class: "t",
                    onClick: $event => (_ctx.openLb(it))
                  }, _toDisplayString(_ctx.titleOf(it)), 9 /* TEXT, PROPS */, _hoisted_18),
                  _createElementVNode("div", _hoisted_19, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.badgeHtml(it)
                    }, null, 8 /* PROPS */, _hoisted_20),
                    _createTextVNode(_toDisplayString(_ctx.metaOf(it)), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", _hoisted_21, [
                    _createElementVNode("textarea", {
                      value: it.note || '',
                      rows: "2",
                      onInput: $event => (_ctx.onNote(it, $event)),
                      onBlur: $event => (_ctx.flushNote(it)),
                      onClick: _withModifiers(() => {}, ["stop"]),
                      placeholder: "写备注：这条素材是干什么用的（搜索和 AI 都会用它）"
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_22)
                  ]),
                  _createElementVNode("div", _hoisted_23, [
                    (_ctx.canReuse(it))
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "ghost",
                          title: '带着这条素材去' + _ctx.reuseTabZh(it.type) + '那一栏',
                          onClick: _withModifiers($event => (_ctx.reuse(it)), ["stop"])
                        }, "复用", 8 /* PROPS */, _hoisted_24))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      class: "ghost",
                      disabled: !!_ctx.dlBusy[it.key],
                      onClick: _withModifiers($event => (_ctx.download(it)), ["stop"])
                    }, _toDisplayString(_ctx.dlMsg[it.key] || '下载'), 9 /* TEXT, PROPS */, _hoisted_25),
                    _createElementVNode("button", {
                      class: "ghost danger",
                      onClick: _withModifiers($event => (_ctx.dropItem(it)), ["stop"])
                    }, "移出收藏", 8 /* PROPS */, _hoisted_26)
                  ])
                ])
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_15))
            }), 128 /* KEYED_FRAGMENT */))
          ], 512 /* NEED_PATCH */)),
    _createElementVNode("div", _hoisted_27, null, 512 /* NEED_PATCH */),
    _createElementVNode("div", {
      class: "pager-row",
      id: "pagerRow",
      ref: "pagerRow",
      style: _normalizeStyle({ display: _ctx.pagerVisible ? '' : 'none' })
    }, null, 4 /* STYLE */)
  ]))
}
