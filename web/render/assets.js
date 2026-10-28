/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/assets.html 编译，别手改。 */
import { createCommentVNode as _createCommentVNode, createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, normalizeClass as _normalizeClass, toDisplayString as _toDisplayString, vShow as _vShow, withDirectives as _withDirectives, openBlock as _openBlock, createElementBlock as _createElementBlock, withKeys as _withKeys, createStaticVNode as _createStaticVNode } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main assets-page page-shell",
  ref: "pageEl"
}
const _hoisted_2 = { class: "phead" }
const _hoisted_3 = {
  class: "phead-meta",
  ref: "asSumEl",
  role: "group",
  "aria-label": "按任务状态筛选"
}
const _hoisted_4 = { class: "phead-acts" }
const _hoisted_5 = ["disabled", "title", "onClick"]
const _hoisted_6 = ["onClick"]
const _hoisted_7 = ["onClick"]
const _hoisted_8 = { class: "as-tools" }
const _hoisted_9 = {
  class: "as-head-tools",
  ref: "headToolsEl"
}
const _hoisted_10 = {
  class: "viewtoggle",
  id: "fView",
  ref: "viewEl",
  role: "group",
  "aria-label": "展示样式切换"
}
const _hoisted_11 = { class: "as-filters" }
const _hoisted_12 = {
  class: "ui-seg",
  ref: "asTypeEl",
  role: "group",
  "aria-label": "按类型筛选"
}
const _hoisted_13 = { class: "as-sel" }
const _hoisted_14 = {
  class: "ui-inp",
  ref: "asProvEl",
  "aria-label": "按平台筛选"
}
const _hoisted_15 = { class: "as-sel" }
const _hoisted_16 = {
  class: "ui-inp",
  ref: "asTimeEl",
  "aria-label": "按时间筛选"
}
const _hoisted_17 = { class: "as-range" }
const _hoisted_18 = ["onClick"]
const _hoisted_19 = ["value", "onChange"]
const _hoisted_20 = ["onClick"]
const _hoisted_21 = ["value", "onChange"]
const _hoisted_22 = ["onClick"]
const _hoisted_23 = {
  ref: "loadErrEl",
  id: "loadErr"
}
const _hoisted_24 = {
  class: "bulkbar",
  id: "bulkBar"
}
const _hoisted_25 = {
  class: "bk-cnt",
  id: "bulkCnt"
}
const _hoisted_26 = ["disabled", "onClick"]
const _hoisted_27 = ["onClick"]
const _hoisted_28 = ["disabled", "onClick"]
const _hoisted_29 = ["disabled", "onClick"]
const _hoisted_30 = ["disabled", "onClick"]
const _hoisted_31 = ["onClick"]
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
const _hoisted_38 = { class: "assets-pager" }
const _hoisted_39 = {
  class: "pager-row",
  ref: "pagerBtnsEl"
}
const _hoisted_40 = ["onKeydown"]
const _hoisted_41 = ["disabled", "onClick"]
const _hoisted_42 = {
  id: "cnt",
  class: "info"
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createCommentVNode(" ══ 统一页头（全站唯一一份 .phead）══\n           身份（图标铭牌 + 标题）+ **上下文**（在制 / 失败 / 结果未知：每一档带条数，\n           点一下就筛；计数为 0 的那一档不画）+ 页面级动作（刷新 / 多选 / 取消全部）。\n           状态放在上下文槽而不是筛选项里：它不是「第五颗筛选项」，\n           是「这批东西现在怎么样」的第一眼事实。 "),
    _createElementVNode("header", _hoisted_2, [
      _cache[3] || (_cache[3] = _createElementVNode("div", { class: "phead-id" }, [
        _createElementVNode("h1", { class: "phead-h1" }, "资产库")
      ], -1 /* CACHED */)),
      _createElementVNode("div", _hoisted_3, null, 512 /* NEED_PATCH */),
      _cache[4] || (_cache[4] = _createElementVNode("span", { class: "phead-sub" }, null, -1 /* CACHED */)),
      _createElementVNode("div", _hoisted_4, [
        _createElementVNode("button", {
          class: "ghost",
          disabled: _ctx.reloadDisabled,
          title: _ctx.reloadTitle,
          onClick: _ctx.reload
        }, [...(_cache[0] || (_cache[0] = [
          _createElementVNode("span", {
            "data-icon": "refresh",
            "data-size": "13"
          }, null, -1 /* CACHED */),
          _createTextVNode(" 刷新", -1 /* CACHED */)
        ]))], 8 /* PROPS */, _hoisted_5),
        _createElementVNode("button", {
          class: _normalizeClass(["ghost", { active: _ctx.multiMode }]),
          id: "multiBtn",
          onClick: _ctx.toggleMulti
        }, [...(_cache[1] || (_cache[1] = [
          _createElementVNode("span", {
            "data-icon": "checkBox",
            "data-size": "13"
          }, null, -1 /* CACHED */),
          _createTextVNode(" 多选", -1 /* CACHED */)
        ]))], 10 /* CLASS, PROPS */, _hoisted_6),
        _createElementVNode("button", {
          class: "ghost",
          id: "cancelAllBtn",
          ref: "cancelAllBtn",
          onClick: _ctx.cancelAll
        }, [...(_cache[2] || (_cache[2] = [
          _createElementVNode("span", {
            "data-icon": "stop",
            "data-size": "13"
          }, null, -1 /* CACHED */),
          _createTextVNode(" 取消全部进行中", -1 /* CACHED */)
        ]))], 8 /* PROPS */, _hoisted_7)
      ])
    ]),
    _createCommentVNode(" ══ 工具条 ══ 找东西 + 换档（视图切换）。筛选与视图属于「怎么看这一页」，不进页头。 "),
    _createElementVNode("div", _hoisted_8, [
      _createElementVNode("div", _hoisted_9, null, 512 /* NEED_PATCH */),
      _cache[5] || (_cache[5] = _createElementVNode("span", {
        class: "sp",
        style: {"flex":"1"}
      }, null, -1 /* CACHED */)),
      _createElementVNode("span", _hoisted_10, null, 512 /* NEED_PATCH */)
    ]),
    _createCommentVNode(" ══ 一行筛选 ══\n           类型（带条数）+ 平台 + 时间。\n           平台从一个下拉走（平台涨到十几家时，一行十几颗芯片会把整行撑开）；\n           时间也是一个下拉（预设），选「自定义区间」时后面才露出起止日期。 "),
    _createElementVNode("div", _hoisted_11, [
      _createCommentVNode(" 类型（带条数）：公共件 Wb.kindFilter —— 与生成工作台、收藏页同一副分段控件 "),
      _createElementVNode("div", _hoisted_12, null, 512 /* NEED_PATCH */),
      _createElementVNode("label", _hoisted_13, [
        _cache[6] || (_cache[6] = _createElementVNode("span", null, "平台", -1 /* CACHED */)),
        _createElementVNode("select", _hoisted_14, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("label", _hoisted_15, [
        _cache[8] || (_cache[8] = _createElementVNode("span", null, "时间", -1 /* CACHED */)),
        _createElementVNode("select", _hoisted_16, [...(_cache[7] || (_cache[7] = [
          _createStaticVNode("<option value=\"0\">全部时间</option><option value=\"1\">今天</option><option value=\"7\">近 7 天</option><option value=\"30\">近 30 天</option><option value=\"custom\">自定义区间</option>", 5)
        ]))], 512 /* NEED_PATCH */)
      ]),
      _withDirectives(_createElementVNode("span", _hoisted_17, [
        _createElementVNode("span", {
          class: "datepick",
          onClick: $event => (_ctx.openDatePicker('from', $event))
        }, [
          _createElementVNode("input", {
            type: "date",
            ref: "dFromEl",
            title: "起始日期",
            value: _ctx.F.from,
            onChange: $event => (_ctx.onDateChange('from'))
          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_19),
          _createElementVNode("span", {
            class: _normalizeClass(["dp-face", { ph: !_ctx.F.from }])
          }, [
            _createTextVNode(_toDisplayString(_ctx.faceFrom), 1 /* TEXT */),
            _cache[9] || (_cache[9] = _createElementVNode("span", {
              class: "ic",
              "data-icon": "calendar"
            }, null, -1 /* CACHED */))
          ], 2 /* CLASS */)
        ], 8 /* PROPS */, _hoisted_18),
        _cache[11] || (_cache[11] = _createElementVNode("span", { class: "dsep" }, "→", -1 /* CACHED */)),
        _createElementVNode("span", {
          class: "datepick",
          onClick: $event => (_ctx.openDatePicker('to', $event))
        }, [
          _createElementVNode("input", {
            type: "date",
            ref: "dToEl",
            title: "结束日期",
            value: _ctx.F.to,
            onChange: $event => (_ctx.onDateChange('to'))
          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_21),
          _createElementVNode("span", {
            class: _normalizeClass(["dp-face", { ph: !_ctx.F.to }])
          }, [
            _createTextVNode(_toDisplayString(_ctx.faceTo), 1 /* TEXT */),
            _cache[10] || (_cache[10] = _createElementVNode("span", {
              class: "ic",
              "data-icon": "calendar"
            }, null, -1 /* CACHED */))
          ], 2 /* CLASS */)
        ], 8 /* PROPS */, _hoisted_20),
        _createElementVNode("button", {
          class: "ghost",
          onClick: _ctx.clearDates
        }, "清除日期", 8 /* PROPS */, _hoisted_22)
      ], 512 /* NEED_PATCH */), [
        [_vShow, _ctx.timeMode === 'custom']
      ]),
      _cache[12] || (_cache[12] = _createElementVNode("span", {
        class: "sp",
        style: {"flex":"1"}
      }, null, -1 /* CACHED */))
    ]),
    _createElementVNode("div", _hoisted_23, null, 512 /* NEED_PATCH */),
    _createCommentVNode(" 多选条（与生成工作台同一套公共件）。「存回本机」是**多选才出现**的动作，\n           存的是**勾选的那几条**（不是整屏）：不多选就点它，等于「把这一屏都存一遍」。 "),
    _withDirectives(_createElementVNode("div", _hoisted_24, [
      _createElementVNode("span", _hoisted_25, _toDisplayString(_ctx.bulkCountText), 1 /* TEXT */),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkAll",
        disabled: _ctx.bulkAllDisabled,
        onClick: _ctx.bulkAll
      }, _toDisplayString(_ctx.bulkAllText), 9 /* TEXT, PROPS */, _hoisted_26),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkClear",
        onClick: _ctx.bulkClear
      }, "取消选择", 8 /* PROPS */, _hoisted_27),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkDown",
        disabled: _ctx.bulkDownDisabled,
        onClick: _ctx.bulkDownload
      }, [...(_cache[13] || (_cache[13] = [
        _createElementVNode("span", {
          "data-icon": "download",
          "data-size": "13"
        }, null, -1 /* CACHED */),
        _createTextVNode(" 批量下载", -1 /* CACHED */)
      ]))], 8 /* PROPS */, _hoisted_28),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkFavAdd",
        disabled: _ctx.bulkFavAddDisabled,
        onClick: _ctx.assetsBulkFavAdd
      }, [...(_cache[14] || (_cache[14] = [
        _createElementVNode("span", {
          "data-icon": "star",
          "data-size": "13"
        }, null, -1 /* CACHED */),
        _createTextVNode(" 收藏", -1 /* CACHED */)
      ]))], 8 /* PROPS */, _hoisted_29),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkFavRemove",
        disabled: _ctx.bulkFavRemoveDisabled,
        onClick: _ctx.assetsBulkFavRemove
      }, [...(_cache[15] || (_cache[15] = [
        _createElementVNode("span", {
          "data-icon": "starFill",
          "data-size": "13"
        }, null, -1 /* CACHED */),
        _createTextVNode(" 取消收藏", -1 /* CACHED */)
      ]))], 8 /* PROPS */, _hoisted_30),
      _createElementVNode("button", {
        class: "ghost",
        ref: "pullLocalBtn",
        id: "pullLocalBtn",
        onClick: _ctx.pullLocalPage
      }, null, 8 /* PROPS */, _hoisted_31),
      _createElementVNode("span", _hoisted_32, _toDisplayString(_ctx.bulkTipText), 1 /* TEXT */),
      _cache[16] || (_cache[16] = _createElementVNode("span", {
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
          }, "重试", 8 /* PROPS */, _hoisted_35)
        ]))
      : _createCommentVNode("v-if", true),
    _withDirectives(_createElementVNode("div", _hoisted_36, [...(_cache[17] || (_cache[17] = [
      _createElementVNode("div", { class: "empty" }, "加载中…", -1 /* CACHED */)
    ]))], 512 /* NEED_PATCH */), [
      [_vShow, !_ctx.failed]
    ]),
    _createElementVNode("div", _hoisted_37, null, 512 /* NEED_PATCH */),
    _createCommentVNode(" 翻页行在**页底**（收藏 / 素材库 / 工作台同一处）：以前它挤在顶部那条筛选行里，\n           一排按钮（多选 / 刷新 / 存回本机 / 取消全部）后面还跟着翻页与跳页，跨页时位置全不一样。 "),
    _createElementVNode("div", _hoisted_38, [
      _withDirectives(_createElementVNode("span", _hoisted_39, null, 512 /* NEED_PATCH */), [
        [_vShow, _ctx.isPageMode && _ctx.pagerReady]
      ]),
      _createElementVNode("input", {
        type: "number",
        id: "gotoPage",
        ref: "gotoPageEl",
        min: "1",
        placeholder: "跳页",
        onKeydown: _withKeys(_ctx.gotoPageInput, ["enter"])
      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_40),
      _createElementVNode("button", {
        class: "ghost",
        id: "gotoBtn",
        disabled: _ctx.gotoBusy,
        onClick: _ctx.gotoPageInput
      }, _toDisplayString(_ctx.gotoBtnText), 9 /* TEXT, PROPS */, _hoisted_41),
      _createElementVNode("span", _hoisted_42, _toDisplayString(_ctx.cntText), 1 /* TEXT */)
    ])
  ], 512 /* NEED_PATCH */))
}
