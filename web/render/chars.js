/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/chars.html 编译，别手改。 */
import { createCommentVNode as _createCommentVNode, createElementVNode as _createElementVNode, toDisplayString as _toDisplayString, vModelText as _vModelText, withDirectives as _withDirectives, vShow as _vShow, createTextVNode as _createTextVNode, openBlock as _openBlock, createElementBlock as _createElementBlock, renderList as _renderList, Fragment as _Fragment, normalizeClass as _normalizeClass, normalizeStyle as _normalizeStyle } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main chars-page page-shell",
  ref: "rootEl"
}
const _hoisted_2 = { class: "phead" }
const _hoisted_3 = { class: "phead-acts" }
const _hoisted_4 = ["innerHTML", "onClick"]
const _hoisted_5 = { class: "mat-rail" }
const _hoisted_6 = { class: "rail-top" }
const _hoisted_7 = {
  class: "rail-sub",
  ref: "railSubEl"
}
const _hoisted_8 = {
  class: "rail-scroll",
  ref: "railScrollEl"
}
const _hoisted_9 = { class: "mat-stage" }
const _hoisted_10 = { class: "mat-head" }
const _hoisted_11 = ["onClick"]
const _hoisted_12 = {
  class: "toolbar",
  ref: "toolbarEl"
}
const _hoisted_13 = {
  class: "viewtoggle",
  ref: "viewEl"
}
const _hoisted_14 = ["onClick"]
const _hoisted_15 = {
  class: "mat-scroll",
  ref: "matScrollEl"
}
const _hoisted_16 = { class: "bulkbar" }
const _hoisted_17 = { class: "bk-cnt" }
const _hoisted_18 = ["disabled", "onClick"]
const _hoisted_19 = ["disabled", "onClick"]
const _hoisted_20 = ["disabled", "onClick"]
const _hoisted_21 = ["onUpdate:modelValue"]
const _hoisted_22 = ["disabled", "onClick"]
const _hoisted_23 = { class: "bk-tip" }
const _hoisted_24 = ["disabled", "onClick"]
const _hoisted_25 = { class: "bk-gen" }
const _hoisted_26 = {
  class: "bk-gen-sel",
  ref: "bkImgPickEl"
}
const _hoisted_27 = {
  class: "bk-gen-sel",
  ref: "bkTtsPickEl"
}
const _hoisted_28 = {
  key: 0,
  class: "empty"
}
const _hoisted_29 = ["onClick"]
const _hoisted_30 = {
  key: 1,
  class: "empty"
}
const _hoisted_31 = ["onClick", "onDragstart", "onDragend"]
const _hoisted_32 = ["innerHTML"]
const _hoisted_33 = ["data-id", "innerHTML"]
const _hoisted_34 = {
  id: "gridEnd",
  ref: "gridEndEl",
  style: {"height":"1px"}
}
const _hoisted_35 = {
  class: "mat-insp",
  ref: "inspEl"
}
const _hoisted_36 = { ref: "grpListEl" }

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createCommentVNode(" 统一页头（全站唯一一份 .phead）：标题从左轨提到顶排 —— 页面身份是整页的事，\n           不该由左边那一栏承担。左轨改写「目录」，它管的是分组与筛选。 "),
    _createElementVNode("header", _hoisted_2, [
      _cache[0] || (_cache[0] = _createElementVNode("div", { class: "phead-id" }, [
        _createElementVNode("h1", { class: "phead-h1" }, "素材库")
      ], -1 /* CACHED */)),
      _createElementVNode("div", _hoisted_3, [
        _createElementVNode("button", {
          class: "pri",
          type: "button",
          ref: "btnNewEl",
          innerHTML: _ctx.newBtnHtml,
          onClick: _ctx.newChar
        }, null, 8 /* PROPS */, _hoisted_4)
      ])
    ]),
    _createElementVNode("div", {
      class: _normalizeClass(["mat", { 'has-insp': !!_ctx.inspId, 'rail-open': _ctx.railOpen }]),
      ref: "matEl"
    }, [
      _createCommentVNode(" ① 目录轨：类型 / 还缺什么 / 分组 —— 取代原来的筛选芯片行 + 三行工具条 + 体检面板 "),
      _createElementVNode("aside", _hoisted_5, [
        _createElementVNode("div", _hoisted_6, [
          _cache[1] || (_cache[1] = _createElementVNode("div", { class: "rail-h1" }, "目录", -1 /* CACHED */)),
          _createElementVNode("div", _hoisted_7, null, 512 /* NEED_PATCH */)
        ]),
        _createElementVNode("div", _hoisted_8, null, 512 /* NEED_PATCH */)
      ]),
      _createCommentVNode(" ② 素材台 "),
      _createElementVNode("section", _hoisted_9, [
        _createElementVNode("header", _hoisted_10, [
          _createElementVNode("button", {
            class: "ghost rail-toggle",
            type: "button",
            ref: "railToggleEl",
            onClick: $event => (_ctx.railOpen = !_ctx.railOpen)
          }, "目录", 8 /* PROPS */, _hoisted_11),
          _createElementVNode("div", _hoisted_12, null, 512 /* NEED_PATCH */),
          _createElementVNode("span", _hoisted_13, null, 512 /* NEED_PATCH */),
          _createElementVNode("button", {
            class: "ghost",
            type: "button",
            ref: "btnMultiEl",
            onClick: _ctx.toggleMulti
          }, _toDisplayString(_ctx.multi ? '退出多选' : '多选'), 9 /* TEXT, PROPS */, _hoisted_14)
        ]),
        _createElementVNode("div", _hoisted_15, [
          _createCommentVNode(" 批量条用公共那一件 .bulkbar（资产库 / 生成工作台同款：粘顶、同一套描边与计数芯片）。\n                 用 v-show 而不是 v-if：多选态那一行要一直挂在那儿，\n                 底下两个型号下拉才有地方落（ref 拿得到）。 "),
          _withDirectives(_createElementVNode("div", _hoisted_16, [
            _createElementVNode("span", _hoisted_17, "已选 " + _toDisplayString(_ctx.batchCount) + " 项", 1 /* TEXT */),
            _createElementVNode("button", {
              class: "tool",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchFillPics
            }, "补预览图", 8 /* PROPS */, _hoisted_18),
            _createElementVNode("button", {
              class: "tool",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchFillAssets
            }, "补角色资产", 8 /* PROPS */, _hoisted_19),
            _createElementVNode("button", {
              class: "tool",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchFillVoices
            }, "AI 定声音", 8 /* PROPS */, _hoisted_20),
            _withDirectives(_createElementVNode("input", {
              class: "ui-inp bk-grp",
              "onUpdate:modelValue": $event => ((_ctx.batchGroup) = $event),
              maxlength: "20",
              placeholder: "批量分组（留空 = 清空）"
            }, null, 8 /* PROPS */, _hoisted_21), [
              [_vModelText, _ctx.batchGroup]
            ]),
            _createElementVNode("button", {
              class: "ghost",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchSetGroup
            }, "应用分组", 8 /* PROPS */, _hoisted_22),
            _cache[4] || (_cache[4] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
            _createElementVNode("span", _hoisted_23, _toDisplayString(_ctx.batchText), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "ghost danger",
              type: "button",
              disabled: !_ctx.batchCount || _ctx.batchBusy,
              onClick: _ctx.batchRemove
            }, "删除", 8 /* PROPS */, _hoisted_24),
            _createCommentVNode(" 这一批用哪两个型号：默认取设置页「素材库」那张卡里的默认，当场换的只管这一批。 "),
            _createElementVNode("div", _hoisted_25, [
              _cache[2] || (_cache[2] = _createElementVNode("span", { class: "bk-gen-l" }, "出图", -1 /* CACHED */)),
              _createElementVNode("span", _hoisted_26, null, 512 /* NEED_PATCH */),
              _cache[3] || (_cache[3] = _createElementVNode("span", { class: "bk-gen-l" }, "声音", -1 /* CACHED */)),
              _createElementVNode("span", _hoisted_27, null, 512 /* NEED_PATCH */)
            ])
          ], 512 /* NEED_PATCH */), [
            [_vShow, _ctx.multi]
          ]),
          (_ctx.failed)
            ? (_openBlock(), _createElementBlock("div", _hoisted_28, [
                _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "ghost mini",
                  type: "button",
                  onClick: _ctx.retryLoad
                }, "重试", 8 /* PROPS */, _hoisted_29)
              ]))
            : (!_ctx.ready)
              ? (_openBlock(), _createElementBlock("div", _hoisted_30, [...(_cache[5] || (_cache[5] = [
                  _createElementVNode("span", { class: "spin-dot" }, null, -1 /* CACHED */),
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
                }, null, 8 /* PROPS */, _hoisted_32))
              : _createCommentVNode("v-if", true),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.cards, (card) => {
              return (_openBlock(), _createElementBlock("div", {
                key: card.id,
                class: _normalizeClass(["card card-surface mcard", { sel: _ctx.inspId === card.id, multi: _ctx.multi, picked: _ctx.isPicked(card.id) }]),
                draggable: "true",
                "data-id": card.id,
                innerHTML: card.html
              }, null, 10 /* CLASS, PROPS */, _hoisted_33))
            }), 128 /* KEYED_FRAGMENT */))
          ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_31), [
            [_vShow, _ctx.ready && !_ctx.failed]
          ]),
          _createElementVNode("div", _hoisted_34, null, 512 /* NEED_PATCH */),
          _createElementVNode("div", {
            class: "pager-row",
            ref: "pagerRowEl",
            style: _normalizeStyle({ display: _ctx.pagerVisible ? '' : 'none' })
          }, null, 4 /* STYLE */)
        ], 512 /* NEED_PATCH */)
      ]),
      _createCommentVNode(" ③ 检查器：点一张卡才占位（取代卡内就地展开的编辑区） "),
      _createElementVNode("aside", _hoisted_35, null, 512 /* NEED_PATCH */)
    ], 2 /* CLASS */),
    _createElementVNode("datalist", _hoisted_36, null, 512 /* NEED_PATCH */)
  ], 512 /* NEED_PATCH */))
}
