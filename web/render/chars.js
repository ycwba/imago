/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/chars.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, toDisplayString as _toDisplayString, openBlock as _openBlock, createElementBlock as _createElementBlock, createCommentVNode as _createCommentVNode, normalizeClass as _normalizeClass, vModelText as _vModelText, withDirectives as _withDirectives, vShow as _vShow, createTextVNode as _createTextVNode, renderList as _renderList, Fragment as _Fragment, withModifiers as _withModifiers, withKeys as _withKeys, normalizeStyle as _normalizeStyle } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main chars-page page-shell",
  ref: "rootEl"
}
const _hoisted_2 = { class: "phead" }
const _hoisted_3 = { class: "phead-meta" }
const _hoisted_4 = { class: "phead-chip" }
const _hoisted_5 = { class: "phead-acts" }
const _hoisted_6 = ["innerHTML", "onClick"]
const _hoisted_7 = ["onClick"]
const _hoisted_8 = {
  class: "mat-rail",
  "aria-label": "素材目录"
}
const _hoisted_9 = { class: "rail-top" }
const _hoisted_10 = ["onClick"]
const _hoisted_11 = {
  class: "rail-scroll",
  ref: "railScrollEl"
}
const _hoisted_12 = {
  class: "rail-sub",
  ref: "railSubEl",
  role: "status"
}
const _hoisted_13 = {
  class: "mat-stage",
  "aria-label": "素材列表"
}
const _hoisted_14 = { class: "mat-head" }
const _hoisted_15 = ["aria-expanded", "onClick"]
const _hoisted_16 = {
  class: "toolbar",
  ref: "toolbarEl"
}
const _hoisted_17 = { class: "mat-caption" }
const _hoisted_18 = { class: "mat-heading" }
const _hoisted_19 = {
  class: "mat-count",
  role: "status"
}
const _hoisted_20 = { class: "mat-view" }
const _hoisted_21 = ["aria-pressed", "onClick"]
const _hoisted_22 = { class: "mat-scroll" }
const _hoisted_23 = { class: "bulkbar" }
const _hoisted_24 = { class: "bk-cnt" }
const _hoisted_25 = ["disabled", "onClick"]
const _hoisted_26 = ["disabled", "onClick"]
const _hoisted_27 = ["disabled", "onClick"]
const _hoisted_28 = ["onUpdate:modelValue"]
const _hoisted_29 = ["disabled", "onClick"]
const _hoisted_30 = {
  class: "bk-tip",
  role: "status"
}
const _hoisted_31 = ["disabled", "onClick"]
const _hoisted_32 = { class: "bk-gen" }
const _hoisted_33 = {
  class: "bk-gen-sel",
  ref: "bkImgPickEl"
}
const _hoisted_34 = {
  class: "bk-gen-sel",
  ref: "bkTtsPickEl"
}
const _hoisted_35 = {
  key: 0,
  class: "empty",
  role: "alert"
}
const _hoisted_36 = ["onClick"]
const _hoisted_37 = {
  key: 1,
  class: "empty",
  role: "status"
}
const _hoisted_38 = ["onClick", "onDragstart", "onDragend"]
const _hoisted_39 = ["innerHTML"]
const _hoisted_40 = ["aria-labelledby", "onKeydown", "data-id", "innerHTML"]
const _hoisted_41 = {
  id: "gridEnd",
  ref: "gridEndEl",
  style: {"height":"var(--sp-2)"}
}
const _hoisted_42 = ["onClick"]
const _hoisted_43 = {
  class: "mat-insp",
  ref: "inspEl",
  "aria-label": "素材信息"
}
const _hoisted_44 = { ref: "grpListEl" }

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createElementVNode("header", _hoisted_2, [
      _cache[0] || (_cache[0] = _createElementVNode("div", { class: "phead-id" }, [
        _createElementVNode("h1", { class: "phead-h1" }, "素材库")
      ], -1 /* CACHED */)),
      _createElementVNode("div", _hoisted_3, [
        _createElementVNode("span", _hoisted_4, _toDisplayString(_ctx.libraryCount) + " 项素材", 1 /* TEXT */)
      ]),
      _cache[1] || (_cache[1] = _createElementVNode("span", { class: "phead-sub" }, null, -1 /* CACHED */)),
      _createElementVNode("div", _hoisted_5, [
        _createElementVNode("button", {
          class: "pri",
          type: "button",
          ref: "btnNewEl",
          innerHTML: _ctx.newBtnHtml,
          onClick: _ctx.newChar
        }, null, 8 /* PROPS */, _hoisted_6)
      ])
    ]),
    _createElementVNode("div", {
      class: _normalizeClass(["mat", { 'has-insp': !!_ctx.inspId, 'rail-open': _ctx.railOpen }]),
      ref: "matEl"
    }, [
      (_ctx.railOpen)
        ? (_openBlock(), _createElementBlock("button", {
            key: 0,
            class: "mat-scrim",
            type: "button",
            "aria-label": "关闭目录",
            onClick: $event => (_ctx.railOpen = false)
          }, null, 8 /* PROPS */, _hoisted_7))
        : _createCommentVNode("v-if", true),
      _createElementVNode("aside", _hoisted_8, [
        _createElementVNode("div", _hoisted_9, [
          _cache[2] || (_cache[2] = _createElementVNode("div", { class: "rail-h1" }, "目录", -1 /* CACHED */)),
          _createElementVNode("button", {
            class: "ghost rail-close",
            type: "button",
            onClick: $event => (_ctx.railOpen = false)
          }, "收起", 8 /* PROPS */, _hoisted_10)
        ]),
        _createElementVNode("div", _hoisted_11, null, 512 /* NEED_PATCH */),
        _createElementVNode("div", _hoisted_12, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("section", _hoisted_13, [
        _createElementVNode("header", _hoisted_14, [
          _createElementVNode("button", {
            class: "ghost rail-toggle",
            type: "button",
            ref: "railToggleEl",
            "aria-expanded": _ctx.railOpen,
            onClick: $event => (_ctx.railOpen = !_ctx.railOpen)
          }, "目录", 8 /* PROPS */, _hoisted_15),
          _createElementVNode("div", _hoisted_16, null, 512 /* NEED_PATCH */)
        ]),
        _createElementVNode("div", _hoisted_17, [
          _createElementVNode("div", _hoisted_18, [
            _createElementVNode("h2", null, _toDisplayString(_ctx.scopeTitle), 1 /* TEXT */),
            _createElementVNode("span", _hoisted_19, _toDisplayString(_ctx.cntText), 1 /* TEXT */)
          ]),
          _createElementVNode("div", _hoisted_20, [
            _createElementVNode("button", {
              class: _normalizeClass(["ghost", { active: _ctx.multi }]),
              type: "button",
              ref: "btnMultiEl",
              "aria-pressed": _ctx.multi,
              onClick: $event => (_ctx.toggleMulti())
            }, _toDisplayString(_ctx.multi ? '退出多选' : '多选'), 11 /* TEXT, CLASS, PROPS */, _hoisted_21)
          ])
        ]),
        _createElementVNode("div", _hoisted_22, [
          _withDirectives(_createElementVNode("div", _hoisted_23, [
            _createElementVNode("span", _hoisted_24, "已选 " + _toDisplayString(_ctx.batchCount) + " 项", 1 /* TEXT */),
            _createElementVNode("button", {
              class: "tool",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchFillPics
            }, "补预览图", 8 /* PROPS */, _hoisted_25),
            _createElementVNode("button", {
              class: "tool",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchFillAssets
            }, "补角色资产", 8 /* PROPS */, _hoisted_26),
            _createElementVNode("button", {
              class: "tool",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchFillVoices
            }, "AI 定声音", 8 /* PROPS */, _hoisted_27),
            _withDirectives(_createElementVNode("input", {
              class: "ui-inp bk-grp",
              "onUpdate:modelValue": $event => ((_ctx.batchGroup) = $event),
              maxlength: "20",
              "aria-label": "批量分组",
              placeholder: "分组名称（留空清除）"
            }, null, 8 /* PROPS */, _hoisted_28), [
              [_vModelText, _ctx.batchGroup]
            ]),
            _createElementVNode("button", {
              class: "ghost",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchSetGroup
            }, "应用分组", 8 /* PROPS */, _hoisted_29),
            _cache[5] || (_cache[5] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
            _createElementVNode("span", _hoisted_30, _toDisplayString(_ctx.batchText), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "ghost danger",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchRemove
            }, "删除", 8 /* PROPS */, _hoisted_31),
            _createElementVNode("div", _hoisted_32, [
              _cache[3] || (_cache[3] = _createElementVNode("span", { class: "bk-gen-l" }, "出图", -1 /* CACHED */)),
              _createElementVNode("span", _hoisted_33, null, 512 /* NEED_PATCH */),
              _cache[4] || (_cache[4] = _createElementVNode("span", { class: "bk-gen-l" }, "声音", -1 /* CACHED */)),
              _createElementVNode("span", _hoisted_34, null, 512 /* NEED_PATCH */)
            ])
          ], 512 /* NEED_PATCH */), [
            [_vShow, _ctx.multi]
          ]),
          (_ctx.failed)
            ? (_openBlock(), _createElementBlock("div", _hoisted_35, [
                _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "ghost mini",
                  type: "button",
                  onClick: _ctx.retryLoad
                }, "重试", 8 /* PROPS */, _hoisted_36)
              ]))
            : (!_ctx.ready)
              ? (_openBlock(), _createElementBlock("div", _hoisted_37, [...(_cache[6] || (_cache[6] = [
                  _createElementVNode("span", { class: "ui-wait" }, null, -1 /* CACHED */),
                  _createTextVNode(" 加载中…", -1 /* CACHED */)
                ]))]))
              : _createCommentVNode("v-if", true),
          _withDirectives(_createElementVNode("div", {
            class: "mat-grid",
            ref: "gridEl",
            onClick: _ctx.onGridClick,
            onDragstart: _ctx.onGridDragStart,
            onDragend: _ctx.onGridDragEnd
          }, [
            (_ctx.ready && !_ctx.cards.length)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 0,
                  class: "empty",
                  innerHTML: _ctx.emptyHtml
                }, null, 8 /* PROPS */, _hoisted_39))
              : _createCommentVNode("v-if", true),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.cards, (card) => {
              return (_openBlock(), _createElementBlock("div", {
                key: card.id,
                class: _normalizeClass(["card card-surface mcard", { sel: _ctx.inspId === card.id, multi: _ctx.multi, picked: _ctx.isPicked(card.id) }]),
                draggable: "true",
                tabindex: "0",
                role: "group",
                "aria-labelledby": 'chars-name-' + card.id,
                onKeydown: [
                  _withKeys(_withModifiers($event => (_ctx.activateCard(card.id)), ["self"]), ["enter"]),
                  _withKeys(_withModifiers($event => (_ctx.activateCard(card.id)), ["self","prevent"]), ["space"])
                ],
                "data-id": card.id,
                innerHTML: card.html
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_40))
            }), 128 /* KEYED_FRAGMENT */))
          ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_38), [
            [_vShow, _ctx.ready && !_ctx.failed]
          ]),
          _createElementVNode("div", _hoisted_41, null, 512 /* NEED_PATCH */),
          _createElementVNode("div", {
            class: "pager-row",
            ref: "pagerRowEl",
            style: _normalizeStyle({ display: _ctx.pagerVisible ? '' : 'none' })
          }, null, 4 /* STYLE */)
        ])
      ]),
      (_ctx.inspId)
        ? (_openBlock(), _createElementBlock("button", {
            key: 1,
            class: "mat-scrim mat-insp-scrim",
            type: "button",
            "aria-label": "关闭素材信息",
            onClick: $event => (_ctx.inspId = '')
          }, null, 8 /* PROPS */, _hoisted_42))
        : _createCommentVNode("v-if", true),
      _createElementVNode("aside", _hoisted_43, null, 512 /* NEED_PATCH */)
    ], 2 /* CLASS */),
    _createElementVNode("datalist", _hoisted_44, null, 512 /* NEED_PATCH */)
  ], 512 /* NEED_PATCH */))
}
