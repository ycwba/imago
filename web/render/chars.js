/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/chars.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, toDisplayString as _toDisplayString, vShow as _vShow, withDirectives as _withDirectives, normalizeClass as _normalizeClass, openBlock as _openBlock, createElementBlock as _createElementBlock, createCommentVNode as _createCommentVNode, renderList as _renderList, Fragment as _Fragment, normalizeStyle as _normalizeStyle, vModelText as _vModelText } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main chars-page page-shell",
  ref: "rootEl"
}
const _hoisted_2 = { class: "page-h1" }
const _hoisted_3 = ["innerHTML"]
const _hoisted_4 = {
  class: "toolbar",
  ref: "toolbarEl"
}
const _hoisted_5 = { class: "toolbar2" }
const _hoisted_6 = { class: "grp" }
const _hoisted_7 = { ref: "grpPickEl" }
const _hoisted_8 = ["disabled", "title", "onClick"]
const _hoisted_9 = ["onClick"]
const _hoisted_10 = { class: "busy" }
const _hoisted_11 = ["disabled", "onClick"]
const _hoisted_12 = ["onClick"]
const _hoisted_13 = {
  class: "viewtoggle",
  ref: "viewEl"
}
const _hoisted_14 = ["innerHTML", "onClick"]
const _hoisted_15 = { class: "toolbar3" }
const _hoisted_16 = { class: "pick" }
const _hoisted_17 = { ref: "imgPickEl" }
const _hoisted_18 = { class: "pick" }
const _hoisted_19 = { ref: "candPickEl" }
const _hoisted_20 = { class: "pick" }
const _hoisted_21 = { ref: "ttsPickEl" }
const _hoisted_22 = {
  ref: "aiLiveEl",
  hidden: "",
  style: {"margin":"0 0 10px"}
}
const _hoisted_23 = {
  key: 0,
  class: "char-health"
}
const _hoisted_24 = { class: "hh" }
const _hoisted_25 = {
  key: 0,
  class: "hint"
}
const _hoisted_26 = { class: "hgrid" }
const _hoisted_27 = ["title", "onClick"]
const _hoisted_28 = { class: "lb" }
const _hoisted_29 = { class: "bar" }
const _hoisted_30 = { class: "n" }
const _hoisted_31 = {
  key: 0,
  class: "gap"
}
const _hoisted_32 = {
  key: 1,
  class: "gap ok"
}
const _hoisted_33 = {
  key: 1,
  class: "batchbar"
}
const _hoisted_34 = ["disabled", "onClick"]
const _hoisted_35 = ["disabled", "onClick"]
const _hoisted_36 = ["disabled", "onClick"]
const _hoisted_37 = ["onUpdate:modelValue"]
const _hoisted_38 = ["disabled", "onClick"]
const _hoisted_39 = { class: "batch-text" }
const _hoisted_40 = ["disabled", "onClick"]
const _hoisted_41 = {
  key: 2,
  class: "empty"
}
const _hoisted_42 = ["onClick"]
const _hoisted_43 = {
  key: 3,
  class: "empty"
}
const _hoisted_44 = ["onClick", "onInput", "onChange", "onFocusin", "onFocusout", "onDragstart", "onDragend"]
const _hoisted_45 = ["innerHTML"]
const _hoisted_46 = ["data-id", "innerHTML"]
const _hoisted_47 = {
  id: "gridEnd",
  ref: "gridEndEl",
  style: {"height":"1px"}
}
const _hoisted_48 = {
  id: "grpList",
  ref: "grpListEl"
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createElementVNode("h1", _hoisted_2, [
      _createElementVNode("span", { innerHTML: _ctx.ticHtml }, null, 8 /* PROPS */, _hoisted_3),
      _cache[0] || (_cache[0] = _createTextVNode("素材库", -1 /* CACHED */))
    ]),
    _cache[10] || (_cache[10] = _createElementVNode("div", { class: "desc" }, [
      _createTextVNode("可复用的"),
      _createElementVNode("b", null, "角色"),
      _createTextVNode("、"),
      _createElementVNode("b", null, "场景"),
      _createTextVNode("与"),
      _createElementVNode("b", null, "道具"),
      _createTextVNode("：预览图、描述、声音与角色资产都在这里改一次， 导演台选参考图、生成工作台出图出配音都直接用这一份，不必每处重画。")
    ], -1 /* CACHED */)),
    _createElementVNode("div", _hoisted_4, null, 512 /* NEED_PATCH */),
    _createElementVNode("div", _hoisted_5, [
      _createElementVNode("span", _hoisted_6, [
        _cache[1] || (_cache[1] = _createTextVNode("分组", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_7, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("button", {
        class: "tool",
        ref: "btnFillEl",
        disabled: _ctx.fillDisabled,
        title: _ctx.fillTitle,
        onClick: _ctx.fillRest
      }, _toDisplayString(_ctx.fillText), 9 /* TEXT, PROPS */, _hoisted_8),
      _createElementVNode("button", {
        class: "tool",
        ref: "btnLocalEl",
        title: "把当前这一档里「本机还没有那份字节」的图与参考音频取回本机资产库：换机器、外链过期、关掉网页都不影响它们",
        onClick: _ctx.pullLocal
      }, null, 8 /* PROPS */, _hoisted_9),
      _cache[2] || (_cache[2] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
      _createElementVNode("span", _hoisted_10, _toDisplayString(_ctx.busyText), 1 /* TEXT */),
      _withDirectives(_createElementVNode("button", {
        class: "ghost",
        ref: "btnStopEl",
        disabled: _ctx.stopDisabled,
        onClick: _ctx.onStop
      }, "停下", 8 /* PROPS */, _hoisted_11), [
        [_vShow, _ctx.stopVisible]
      ]),
      _createElementVNode("button", {
        class: _normalizeClass(["ghost", { on: _ctx.multi }]),
        title: "勾选多条，批量补预览图 / 资产 / 声音、设置分组或删除",
        onClick: _ctx.toggleMulti
      }, _toDisplayString(_ctx.multi ? '退出多选' : '多选'), 11 /* TEXT, CLASS, PROPS */, _hoisted_12),
      _createElementVNode("span", _hoisted_13, null, 512 /* NEED_PATCH */),
      _createElementVNode("button", {
        class: "tool",
        ref: "btnNewEl",
        innerHTML: _ctx.newBtnHtml,
        onClick: _ctx.newChar
      }, null, 8 /* PROPS */, _hoisted_14)
    ]),
    _createElementVNode("div", _hoisted_15, [
      _createElementVNode("span", _hoisted_16, [
        _cache[3] || (_cache[3] = _createTextVNode("出图型号", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_17, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("span", _hoisted_18, [
        _cache[4] || (_cache[4] = _createTextVNode("出图张数", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_19, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("span", _hoisted_20, [
        _cache[5] || (_cache[5] = _createTextVNode("语音型号", -1 /* CACHED */)),
        _createElementVNode("span", _hoisted_21, null, 512 /* NEED_PATCH */)
      ])
    ]),
    _createElementVNode("div", _hoisted_22, null, 512 /* NEED_PATCH */),
    (_ctx.ready && _ctx.health.total)
      ? (_openBlock(), _createElementBlock("div", _hoisted_23, [
          _createElementVNode("div", _hoisted_24, [
            _cache[6] || (_cache[6] = _createElementVNode("b", null, "素材体检", -1 /* CACHED */)),
            _createElementVNode("span", null, "共 " + _toDisplayString(_ctx.health.total) + " 条 · 分组 " + _toDisplayString(_ctx.health.groups) + " 个 · 被导演台 " + _toDisplayString(_ctx.health.used) + " 条用到", 1 /* TEXT */),
            _cache[7] || (_cache[7] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
            (_ctx.health.note)
              ? (_openBlock(), _createElementBlock("span", _hoisted_25, _toDisplayString(_ctx.health.note), 1 /* TEXT */))
              : _createCommentVNode("v-if", true)
          ]),
          _createElementVNode("div", _hoisted_26, [
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.health.rows, (r) => {
              return (_openBlock(), _createElementBlock("button", {
                class: "hrow",
                key: r.key,
                title: r.why + '；点一下筛出缺的那几条',
                onClick: $event => (_ctx.jumpFilter(r.filter))
              }, [
                _createElementVNode("span", _hoisted_28, _toDisplayString(r.label), 1 /* TEXT */),
                _createElementVNode("span", _hoisted_29, [
                  _createElementVNode("i", {
                    style: _normalizeStyle({ width: r.pct + '%' })
                  }, null, 4 /* STYLE */)
                ]),
                _createElementVNode("span", _hoisted_30, _toDisplayString(r.ok) + " / " + _toDisplayString(r.need), 1 /* TEXT */),
                (r.need > r.ok)
                  ? (_openBlock(), _createElementBlock("span", _hoisted_31, "缺 " + _toDisplayString(r.need - r.ok), 1 /* TEXT */))
                  : (_openBlock(), _createElementBlock("span", _hoisted_32, "齐"))
              ], 8 /* PROPS */, _hoisted_27))
            }), 128 /* KEYED_FRAGMENT */))
          ])
        ]))
      : _createCommentVNode("v-if", true),
    (_ctx.multi)
      ? (_openBlock(), _createElementBlock("div", _hoisted_33, [
          _createElementVNode("b", null, "已选 " + _toDisplayString(_ctx.batchCount) + " 条", 1 /* TEXT */),
          _createElementVNode("button", {
            class: "tool",
            disabled: !_ctx.batchCount || _ctx.batchBusy,
            onClick: _ctx.batchFillPics
          }, "补预览图", 8 /* PROPS */, _hoisted_34),
          _createElementVNode("button", {
            class: "tool",
            disabled: !_ctx.batchCount || _ctx.batchBusy,
            onClick: _ctx.batchFillAssets
          }, "补角色资产", 8 /* PROPS */, _hoisted_35),
          _createElementVNode("button", {
            class: "tool",
            disabled: !_ctx.batchCount || _ctx.batchBusy,
            onClick: _ctx.batchFillVoices
          }, "AI 定声音", 8 /* PROPS */, _hoisted_36),
          _withDirectives(_createElementVNode("input", {
            class: "ui-inp batch-grp",
            "onUpdate:modelValue": $event => ((_ctx.batchGroup) = $event),
            maxlength: "20",
            placeholder: "批量分组（留空 = 清空）"
          }, null, 8 /* PROPS */, _hoisted_37), [
            [_vModelText, _ctx.batchGroup]
          ]),
          _createElementVNode("button", {
            class: "ghost",
            disabled: !_ctx.batchCount || _ctx.batchBusy,
            onClick: _ctx.batchSetGroup
          }, "应用分组", 8 /* PROPS */, _hoisted_38),
          _cache[8] || (_cache[8] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
          _createElementVNode("span", _hoisted_39, _toDisplayString(_ctx.batchText), 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ghost danger",
            disabled: !_ctx.batchCount || _ctx.batchBusy,
            onClick: _ctx.batchRemove
          }, "删掉所选", 8 /* PROPS */, _hoisted_40)
        ]))
      : _createCommentVNode("v-if", true),
    (_ctx.failed)
      ? (_openBlock(), _createElementBlock("div", _hoisted_41, [
          _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ghost mini",
            onClick: _ctx.retryLoad
          }, "重新加载本页", 8 /* PROPS */, _hoisted_42)
        ]))
      : (!_ctx.ready)
        ? (_openBlock(), _createElementBlock("div", _hoisted_43, [...(_cache[9] || (_cache[9] = [
            _createElementVNode("span", { class: "spin-dot" }, null, -1 /* CACHED */),
            _createTextVNode(" 正在读取素材库…", -1 /* CACHED */)
          ]))]))
        : _createCommentVNode("v-if", true),
    _withDirectives(_createElementVNode("div", {
      class: "grid",
      ref: "gridEl",
      onClick: _ctx.onGridClick,
      onInput: _ctx.onGridInput,
      onChange: _ctx.onGridChange,
      onFocusin: _ctx.onGridFocusIn,
      onFocusout: _ctx.onGridFocusOut,
      onDragstart: _ctx.onGridDragStart,
      onDragend: _ctx.onGridDragEnd
    }, [
      (_ctx.ready && !_ctx.cards.length)
        ? (_openBlock(), _createElementBlock("div", {
            key: 0,
            class: "empty",
            innerHTML: _ctx.emptyHtml
          }, null, 8 /* PROPS */, _hoisted_45))
        : _createCommentVNode("v-if", true),
      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.cards, (card) => {
        return (_openBlock(), _createElementBlock("div", {
          key: card.id,
          class: _normalizeClass(["card card-surface", { open: _ctx.openId === card.id, multi: _ctx.multi, picked: _ctx.isPicked(card.id) }]),
          draggable: "true",
          "data-id": card.id,
          innerHTML: card.html
        }, null, 10 /* CLASS, PROPS */, _hoisted_46))
      }), 128 /* KEYED_FRAGMENT */))
    ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_44), [
      [_vShow, _ctx.ready && !_ctx.failed]
    ]),
    _createElementVNode("div", _hoisted_47, null, 512 /* NEED_PATCH */),
    _createElementVNode("div", {
      class: "pager-row",
      ref: "pagerRowEl",
      style: _normalizeStyle({ display: _ctx.pagerVisible ? '' : 'none' })
    }, null, 4 /* STYLE */),
    _createElementVNode("datalist", _hoisted_48, null, 512 /* NEED_PATCH */)
  ], 512 /* NEED_PATCH */))
}
