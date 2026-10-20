/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/assets.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, toDisplayString as _toDisplayString, normalizeClass as _normalizeClass, createTextVNode as _createTextVNode, vShow as _vShow, withDirectives as _withDirectives, withKeys as _withKeys, openBlock as _openBlock, createElementBlock as _createElementBlock, createCommentVNode as _createCommentVNode } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main assets-page",
  ref: "pageEl"
}
const _hoisted_2 = { class: "filters" }
const _hoisted_3 = { class: "frow" }
const _hoisted_4 = {
  class: "chips",
  ref: "fTypeEl"
}
const _hoisted_5 = ["onInput"]
const _hoisted_6 = ["onClick"]
const _hoisted_7 = ["onClick"]
const _hoisted_8 = { ref: "aiChipEl" }
const _hoisted_9 = { class: "frow" }
const _hoisted_10 = {
  class: "chips",
  ref: "fDateEl"
}
const _hoisted_11 = { class: "daterange" }
const _hoisted_12 = ["onClick"]
const _hoisted_13 = ["value", "onChange"]
const _hoisted_14 = ["onClick"]
const _hoisted_15 = ["value", "onChange"]
const _hoisted_16 = ["onClick"]
const _hoisted_17 = { class: "frow" }
const _hoisted_18 = {
  class: "chips",
  ref: "fProvEl"
}
const _hoisted_19 = { class: "frow" }
const _hoisted_20 = {
  class: "chips",
  ref: "fStatusEl"
}
const _hoisted_21 = { class: "toolbar" }
const _hoisted_22 = ["onClick"]
const _hoisted_23 = ["disabled", "title", "onClick"]
const _hoisted_24 = ["onClick"]
const _hoisted_25 = ["onClick"]
const _hoisted_26 = ["disabled", "onClick"]
const _hoisted_27 = ["disabled", "onClick"]
const _hoisted_28 = ["onKeydown"]
const _hoisted_29 = ["disabled", "onClick"]
const _hoisted_30 = {
  id: "cnt",
  class: "info"
}
const _hoisted_31 = {
  class: "viewtoggle",
  id: "fView",
  ref: "viewEl",
  role: "group",
  "aria-label": "展示样式切换"
}
const _hoisted_32 = {
  ref: "loadErrEl",
  id: "loadErr"
}
const _hoisted_33 = {
  class: "bulkbar",
  id: "bulkBar"
}
const _hoisted_34 = {
  class: "bk-cnt",
  id: "bulkCnt"
}
const _hoisted_35 = ["disabled", "onClick"]
const _hoisted_36 = ["onClick"]
const _hoisted_37 = ["disabled", "onClick"]
const _hoisted_38 = {
  class: "bk-tip",
  id: "bulkTip"
}
const _hoisted_39 = ["onClick"]
const _hoisted_40 = {
  key: 0,
  class: "empty"
}
const _hoisted_41 = ["onClick"]
const _hoisted_42 = {
  class: "grid",
  id: "grid",
  ref: "gridEl"
}
const _hoisted_43 = {
  id: "gridEnd",
  ref: "gridEndEl",
  style: {"height":"1px"}
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _cache[13] || (_cache[13] = _createElementVNode("h1", null, "资产库", -1 /* CACHED */)),
    _createElementVNode("div", _hoisted_2, [
      _createElementVNode("div", _hoisted_3, [
        _cache[0] || (_cache[0] = _createElementVNode("span", { class: "flabel" }, "大类型", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_4, null, 512 /* NEED_PATCH */),
        _cache[1] || (_cache[1] = _createElementVNode("span", {
          class: "flabel",
          style: {"margin-left":"14px"}
        }, "搜索", -1 /* CACHED */)),
        _createElementVNode("input", {
          ref: "searchEl",
          id: "search",
          placeholder: "提示词 / 资产ID / 任务ID…",
          onInput: _ctx.onSearchInput
        }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_5),
        _createElementVNode("button", {
          class: "ghost",
          id: "searchBtn",
          title: "立即按当前关键词筛选（输入时也会自动筛）",
          style: {"flex":"0 0 auto"},
          onClick: _ctx.onSearchClick
        }, "搜索", 8 /* PROPS */, _hoisted_6),
        _createElementVNode("button", {
          class: "ghost",
          id: "aiSearchBtn",
          ref: "aiSearchBtn",
          title: "按左边搜索框里写的描述做 AI 检索（翻译成筛选条件就地过滤）",
          style: {"flex":"0 0 auto"},
          onClick: _ctx.runAiSearch
        }, "AI 检索", 8 /* PROPS */, _hoisted_7),
        _createElementVNode("span", _hoisted_8, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("div", _hoisted_9, [
        _cache[3] || (_cache[3] = _createElementVNode("span", { class: "flabel" }, "日期", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_10, null, 512 /* NEED_PATCH */),
        _createElementVNode("span", _hoisted_11, [
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
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_13),
            _createElementVNode("span", {
              class: _normalizeClass(["dp-face", { ph: !_ctx.F.from }]),
              id: "dpFromFace"
            }, _toDisplayString(_ctx.faceFrom), 3 /* TEXT, CLASS */)
          ], 8 /* PROPS */, _hoisted_12),
          _cache[2] || (_cache[2] = _createElementVNode("span", { class: "dsep" }, "→", -1 /* CACHED */)),
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
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_15),
            _createElementVNode("span", {
              class: _normalizeClass(["dp-face", { ph: !_ctx.F.to }]),
              id: "dpToFace"
            }, _toDisplayString(_ctx.faceTo), 3 /* TEXT, CLASS */)
          ], 8 /* PROPS */, _hoisted_14)
        ]),
        _createElementVNode("button", {
          class: "ghost",
          id: "dClear",
          onClick: _ctx.clearDates
        }, "清除日期", 8 /* PROPS */, _hoisted_16)
      ]),
      _createElementVNode("div", _hoisted_17, [
        _cache[4] || (_cache[4] = _createElementVNode("span", { class: "flabel" }, "API 平台", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_18, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("div", _hoisted_19, [
        _cache[8] || (_cache[8] = _createElementVNode("span", { class: "flabel" }, "状态", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_20, null, 512 /* NEED_PATCH */),
        _cache[9] || (_cache[9] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_21, [
          _createElementVNode("button", {
            class: _normalizeClass(["ghost", { active: _ctx.multiMode }]),
            id: "multiBtn",
            title: "进入多选：点卡片勾选，可批量下载",
            onClick: _ctx.toggleMulti
          }, [...(_cache[5] || (_cache[5] = [
            _createElementVNode("span", {
              "data-icon": "checkBox",
              "data-size": "13"
            }, null, -1 /* CACHED */),
            _createTextVNode(" 多选", -1 /* CACHED */)
          ]))], 10 /* CLASS, PROPS */, _hoisted_22),
          _createElementVNode("button", {
            class: "ghost",
            id: "reloadBtn",
            disabled: _ctx.reloadDisabled,
            title: _ctx.reloadTitle,
            onClick: _ctx.reload
          }, [...(_cache[6] || (_cache[6] = [
            _createElementVNode("span", {
              "data-icon": "refresh",
              "data-size": "13"
            }, null, -1 /* CACHED */),
            _createTextVNode(" 重新加载", -1 /* CACHED */)
          ]))], 8 /* PROPS */, _hoisted_23),
          _createElementVNode("button", {
            class: "ghost",
            id: "pullLocalBtn",
            ref: "pullLocalBtn",
            title: "把这一屏里本机还没有那份字节的产物取回本机（「优先用本机文件」才有东西可用，外链过期也不再是破图）",
            onClick: _ctx.pullLocalPage
          }, null, 8 /* PROPS */, _hoisted_24),
          _createElementVNode("button", {
            class: "ghost",
            id: "cancelAllBtn",
            ref: "cancelAllBtn",
            title: "取消所有排队/生成中的任务",
            onClick: _ctx.cancelAll
          }, [...(_cache[7] || (_cache[7] = [
            _createElementVNode("span", {
              "data-icon": "stop",
              "data-size": "13"
            }, null, -1 /* CACHED */),
            _createTextVNode(" 取消全部进行中", -1 /* CACHED */)
          ]))], 8 /* PROPS */, _hoisted_25),
          _withDirectives(_createElementVNode("button", {
            class: "ghost",
            id: "pgPrev",
            disabled: _ctx.pgPrevDisabled,
            onClick: _ctx.prevPage
          }, "‹ 上一页", 8 /* PROPS */, _hoisted_26), [
            [_vShow, _ctx.isPageMode && _ctx.pagerReady]
          ]),
          _withDirectives(_createElementVNode("span", {
            class: "pginfo",
            id: "pgInfo"
          }, _toDisplayString(_ctx.pgInfoText), 513 /* TEXT, NEED_PATCH */), [
            [_vShow, _ctx.isPageMode && _ctx.pagerReady]
          ]),
          _withDirectives(_createElementVNode("button", {
            class: "ghost",
            id: "pgNext",
            disabled: _ctx.pgNextDisabled,
            onClick: _ctx.nextPage
          }, _toDisplayString(_ctx.pgNextText), 9 /* TEXT, PROPS */, _hoisted_27), [
            [_vShow, _ctx.isPageMode && _ctx.pagerReady]
          ]),
          _createElementVNode("input", {
            type: "number",
            id: "gotoPage",
            ref: "gotoPageEl",
            min: "1",
            placeholder: "跳页",
            onKeydown: _withKeys(_ctx.gotoPageInput, ["enter"])
          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_28),
          _createElementVNode("button", {
            class: "ghost",
            id: "gotoBtn",
            disabled: _ctx.gotoBusy,
            onClick: _ctx.gotoPageInput
          }, _toDisplayString(_ctx.gotoBtnText), 9 /* TEXT, PROPS */, _hoisted_29),
          _createElementVNode("span", _hoisted_30, _toDisplayString(_ctx.cntText), 1 /* TEXT */),
          _createElementVNode("span", _hoisted_31, null, 512 /* NEED_PATCH */)
        ])
      ])
    ]),
    _createElementVNode("div", _hoisted_32, null, 512 /* NEED_PATCH */),
    _withDirectives(_createElementVNode("div", _hoisted_33, [
      _createElementVNode("span", _hoisted_34, _toDisplayString(_ctx.bulkCountText), 1 /* TEXT */),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkAll",
        disabled: _ctx.bulkAllDisabled,
        onClick: _ctx.bulkAll
      }, _toDisplayString(_ctx.bulkAllText), 9 /* TEXT, PROPS */, _hoisted_35),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkClear",
        onClick: _ctx.bulkClear
      }, "取消选择", 8 /* PROPS */, _hoisted_36),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkDown",
        disabled: _ctx.bulkDownDisabled,
        onClick: _ctx.bulkDownload
      }, [...(_cache[10] || (_cache[10] = [
        _createElementVNode("span", {
          "data-icon": "download",
          "data-size": "13"
        }, null, -1 /* CACHED */),
        _createTextVNode(" 批量下载", -1 /* CACHED */)
      ]))], 8 /* PROPS */, _hoisted_37),
      _createElementVNode("span", _hoisted_38, _toDisplayString(_ctx.bulkTipText), 1 /* TEXT */),
      _cache[11] || (_cache[11] = _createElementVNode("span", {
        class: "sp",
        style: {"flex":"1"}
      }, null, -1 /* CACHED */)),
      _createElementVNode("button", {
        class: "ghost",
        id: "multiExit",
        onClick: _ctx.exitMulti
      }, "退出多选", 8 /* PROPS */, _hoisted_39)
    ], 512 /* NEED_PATCH */), [
      [_vShow, _ctx.multiMode]
    ]),
    (_ctx.failed)
      ? (_openBlock(), _createElementBlock("div", _hoisted_40, [
          _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ghost mini",
            onClick: _ctx.retryLoad
          }, "重新加载本页", 8 /* PROPS */, _hoisted_41)
        ]))
      : _createCommentVNode("v-if", true),
    _withDirectives(_createElementVNode("div", _hoisted_42, [...(_cache[12] || (_cache[12] = [
      _createElementVNode("div", { class: "empty" }, "加载中…", -1 /* CACHED */)
    ]))], 512 /* NEED_PATCH */), [
      [_vShow, !_ctx.failed]
    ]),
    _createElementVNode("div", _hoisted_43, null, 512 /* NEED_PATCH */)
  ], 512 /* NEED_PATCH */))
}
