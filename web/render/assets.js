/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/assets.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, createCommentVNode as _createCommentVNode, toDisplayString as _toDisplayString, normalizeClass as _normalizeClass, createTextVNode as _createTextVNode, vShow as _vShow, withDirectives as _withDirectives, withKeys as _withKeys, openBlock as _openBlock, createElementBlock as _createElementBlock } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main assets-page page-shell",
  ref: "pageEl"
}
const _hoisted_2 = { class: "filters" }
const _hoisted_3 = {
  class: "frow",
  ref: "typeRowEl"
}
const _hoisted_4 = { class: "frow" }
const _hoisted_5 = {
  class: "chips",
  ref: "fDateEl"
}
const _hoisted_6 = { class: "daterange" }
const _hoisted_7 = ["onClick"]
const _hoisted_8 = ["value", "onChange"]
const _hoisted_9 = ["onClick"]
const _hoisted_10 = ["value", "onChange"]
const _hoisted_11 = ["onClick"]
const _hoisted_12 = { class: "frow" }
const _hoisted_13 = {
  class: "chips",
  ref: "fProvEl"
}
const _hoisted_14 = { class: "frow" }
const _hoisted_15 = {
  class: "chips",
  ref: "fStatusEl"
}
const _hoisted_16 = { class: "toolbar" }
const _hoisted_17 = ["onClick"]
const _hoisted_18 = ["disabled", "title", "onClick"]
const _hoisted_19 = ["onClick"]
const _hoisted_20 = ["onClick"]
const _hoisted_21 = { ref: "pagerBtnsEl" }
const _hoisted_22 = ["onKeydown"]
const _hoisted_23 = ["disabled", "onClick"]
const _hoisted_24 = {
  id: "cnt",
  class: "info"
}
const _hoisted_25 = {
  class: "viewtoggle",
  id: "fView",
  ref: "viewEl",
  role: "group",
  "aria-label": "展示样式切换"
}
const _hoisted_26 = {
  ref: "loadErrEl",
  id: "loadErr"
}
const _hoisted_27 = {
  class: "bulkbar",
  id: "bulkBar"
}
const _hoisted_28 = {
  class: "bk-cnt",
  id: "bulkCnt"
}
const _hoisted_29 = ["disabled", "onClick"]
const _hoisted_30 = ["onClick"]
const _hoisted_31 = ["disabled", "onClick"]
const _hoisted_32 = {
  class: "bk-tip",
  id: "bulkTip"
}
const _hoisted_33 = ["onClick"]
const _hoisted_34 = {
  key: 0,
  class: "empty"
}
const _hoisted_35 = ["onClick"]
const _hoisted_36 = {
  class: "grid",
  id: "grid",
  ref: "gridEl"
}
const _hoisted_37 = {
  id: "gridEnd",
  ref: "gridEndEl",
  style: {"height":"1px"}
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _cache[11] || (_cache[11] = _createElementVNode("h1", { class: "page-h1" }, "资产库", -1 /* CACHED */)),
    _createElementVNode("div", _hoisted_2, [
      _createCommentVNode(" 大类型 + 搜索这一行由公共 Wb.filterBar 生成（见 pages/assets.js 的 initWb）；\n             芯片、输入框、两颗按钮与 AI 芯片的插入顺序都由它那一份实现决定。 "),
      _createElementVNode("div", _hoisted_3, null, 512 /* NEED_PATCH */),
      _createElementVNode("div", _hoisted_4, [
        _cache[1] || (_cache[1] = _createElementVNode("span", { class: "flabel" }, "日期", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_5, null, 512 /* NEED_PATCH */),
        _createElementVNode("span", _hoisted_6, [
          _createElementVNode("span", {
            class: "datepick",
            onClick: $event => (_ctx.openDatePicker('from', $event))
          }, [
            _createElementVNode("input", {
              type: "date",
              id: "dFrom",
              ref: "dFromEl",
              title: "起始日期",
              value: _ctx.F.from,
              onChange: $event => (_ctx.onDateChange('from'))
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_8),
            _createElementVNode("span", {
              class: _normalizeClass(["dp-face", { ph: !_ctx.F.from }]),
              id: "dpFromFace"
            }, _toDisplayString(_ctx.faceFrom), 3 /* TEXT, CLASS */)
          ], 8 /* PROPS */, _hoisted_7),
          _cache[0] || (_cache[0] = _createElementVNode("span", { class: "dsep" }, "→", -1 /* CACHED */)),
          _createElementVNode("span", {
            class: "datepick",
            onClick: $event => (_ctx.openDatePicker('to', $event))
          }, [
            _createElementVNode("input", {
              type: "date",
              id: "dTo",
              ref: "dToEl",
              title: "结束日期",
              value: _ctx.F.to,
              onChange: $event => (_ctx.onDateChange('to'))
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_10),
            _createElementVNode("span", {
              class: _normalizeClass(["dp-face", { ph: !_ctx.F.to }]),
              id: "dpToFace"
            }, _toDisplayString(_ctx.faceTo), 3 /* TEXT, CLASS */)
          ], 8 /* PROPS */, _hoisted_9)
        ]),
        _createElementVNode("button", {
          class: "ghost",
          id: "dClear",
          onClick: _ctx.clearDates
        }, "清除日期", 8 /* PROPS */, _hoisted_11)
      ]),
      _createElementVNode("div", _hoisted_12, [
        _cache[2] || (_cache[2] = _createElementVNode("span", { class: "flabel" }, "API 平台", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_13, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("div", _hoisted_14, [
        _cache[6] || (_cache[6] = _createElementVNode("span", { class: "flabel" }, "状态", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_15, null, 512 /* NEED_PATCH */),
        _cache[7] || (_cache[7] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_16, [
          _createElementVNode("button", {
            class: _normalizeClass(["ghost", { active: _ctx.multiMode }]),
            id: "multiBtn",
            title: "进入多选：点卡片勾选，可批量下载",
            onClick: _ctx.toggleMulti
          }, [...(_cache[3] || (_cache[3] = [
            _createElementVNode("span", {
              "data-icon": "checkBox",
              "data-size": "13"
            }, null, -1 /* CACHED */),
            _createTextVNode(" 多选", -1 /* CACHED */)
          ]))], 10 /* CLASS, PROPS */, _hoisted_17),
          _createElementVNode("button", {
            class: "ghost",
            id: "reloadBtn",
            disabled: _ctx.reloadDisabled,
            title: _ctx.reloadTitle,
            onClick: _ctx.reload
          }, [...(_cache[4] || (_cache[4] = [
            _createElementVNode("span", {
              "data-icon": "refresh",
              "data-size": "13"
            }, null, -1 /* CACHED */),
            _createTextVNode(" 重新加载", -1 /* CACHED */)
          ]))], 8 /* PROPS */, _hoisted_18),
          _createElementVNode("button", {
            class: "ghost",
            id: "pullLocalBtn",
            ref: "pullLocalBtn",
            title: "把这一屏里本机还没有那份字节的产物取回本机（「优先用本机文件」才有东西可用，外链过期也不再是破图）",
            onClick: _ctx.pullLocalPage
          }, null, 8 /* PROPS */, _hoisted_19),
          _createElementVNode("button", {
            class: "ghost",
            id: "cancelAllBtn",
            ref: "cancelAllBtn",
            title: "取消所有排队/生成中的任务",
            onClick: _ctx.cancelAll
          }, [...(_cache[5] || (_cache[5] = [
            _createElementVNode("span", {
              "data-icon": "stop",
              "data-size": "13"
            }, null, -1 /* CACHED */),
            _createTextVNode(" 取消全部进行中", -1 /* CACHED */)
          ]))], 8 /* PROPS */, _hoisted_20),
          _withDirectives(_createElementVNode("span", _hoisted_21, null, 512 /* NEED_PATCH */), [
            [_vShow, _ctx.isPageMode && _ctx.pagerReady]
          ]),
          _createElementVNode("input", {
            type: "number",
            id: "gotoPage",
            ref: "gotoPageEl",
            min: "1",
            placeholder: "跳页",
            onKeydown: _withKeys(_ctx.gotoPageInput, ["enter"])
          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_22),
          _createElementVNode("button", {
            class: "ghost",
            id: "gotoBtn",
            disabled: _ctx.gotoBusy,
            onClick: _ctx.gotoPageInput
          }, _toDisplayString(_ctx.gotoBtnText), 9 /* TEXT, PROPS */, _hoisted_23),
          _createElementVNode("span", _hoisted_24, _toDisplayString(_ctx.cntText), 1 /* TEXT */),
          _createElementVNode("span", _hoisted_25, null, 512 /* NEED_PATCH */)
        ])
      ])
    ]),
    _createElementVNode("div", _hoisted_26, null, 512 /* NEED_PATCH */),
    _withDirectives(_createElementVNode("div", _hoisted_27, [
      _createElementVNode("span", _hoisted_28, _toDisplayString(_ctx.bulkCountText), 1 /* TEXT */),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkAll",
        disabled: _ctx.bulkAllDisabled,
        onClick: _ctx.bulkAll
      }, _toDisplayString(_ctx.bulkAllText), 9 /* TEXT, PROPS */, _hoisted_29),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkClear",
        onClick: _ctx.bulkClear
      }, "取消选择", 8 /* PROPS */, _hoisted_30),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkDown",
        disabled: _ctx.bulkDownDisabled,
        onClick: _ctx.bulkDownload
      }, [...(_cache[8] || (_cache[8] = [
        _createElementVNode("span", {
          "data-icon": "download",
          "data-size": "13"
        }, null, -1 /* CACHED */),
        _createTextVNode(" 批量下载", -1 /* CACHED */)
      ]))], 8 /* PROPS */, _hoisted_31),
      _createElementVNode("span", _hoisted_32, _toDisplayString(_ctx.bulkTipText), 1 /* TEXT */),
      _cache[9] || (_cache[9] = _createElementVNode("span", {
        class: "sp",
        style: {"flex":"1"}
      }, null, -1 /* CACHED */)),
      _createElementVNode("button", {
        class: "ghost",
        id: "multiExit",
        onClick: _ctx.exitMulti
      }, "退出多选", 8 /* PROPS */, _hoisted_33)
    ], 512 /* NEED_PATCH */), [
      [_vShow, _ctx.multiMode]
    ]),
    (_ctx.failed)
      ? (_openBlock(), _createElementBlock("div", _hoisted_34, [
          _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ghost mini",
            onClick: _ctx.retryLoad
          }, "重新加载本页", 8 /* PROPS */, _hoisted_35)
        ]))
      : _createCommentVNode("v-if", true),
    _withDirectives(_createElementVNode("div", _hoisted_36, [...(_cache[10] || (_cache[10] = [
      _createElementVNode("div", { class: "empty" }, "加载中…", -1 /* CACHED */)
    ]))], 512 /* NEED_PATCH */), [
      [_vShow, !_ctx.failed]
    ]),
    _createElementVNode("div", _hoisted_37, null, 512 /* NEED_PATCH */)
  ], 512 /* NEED_PATCH */))
}
