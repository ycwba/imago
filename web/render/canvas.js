/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/canvas.html 编译，别手改。 */
import { createCommentVNode as _createCommentVNode, createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, openBlock as _openBlock, createElementBlock as _createElementBlock, toDisplayString as _toDisplayString, normalizeClass as _normalizeClass, Fragment as _Fragment } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = { class: "cv-bar" }
const _hoisted_2 = ["onClick"]
const _hoisted_3 = ["value", "onChange"]
const _hoisted_4 = { key: 2 }
const _hoisted_5 = {
  key: 3,
  class: "cv-rev"
}
const _hoisted_6 = ["onClick", "disabled"]
const _hoisted_7 = ["onClick", "disabled"]
const _hoisted_8 = ["onClick", "disabled"]
const _hoisted_9 = {
  key: 0,
  class: "cv-lib"
}
const _hoisted_10 = { class: "cv-lib-bar" }
const _hoisted_11 = ["value", "onInput"]
const _hoisted_12 = ["onChange"]
const _hoisted_13 = { class: "cv-count" }
const _hoisted_14 = ["onClick", "disabled"]
const _hoisted_15 = {
  class: "cv-grid",
  ref: "libBox"
}
const _hoisted_16 = {
  key: 1,
  class: "cv-work"
}
const _hoisted_17 = {
  class: "cv-stage",
  ref: "stage",
  tabindex: "0",
  "aria-label": "画布，可拖动与缩放"
}
const _hoisted_18 = {
  class: "cv-layer",
  ref: "layer"
}
const _hoisted_19 = {
  class: "cv-svg",
  ref: "edges",
  "aria-hidden": "true"
}
const _hoisted_20 = ["onClick"]
const _hoisted_21 = { class: "cv-zoom" }
const _hoisted_22 = ["onClick", "innerHTML"]
const _hoisted_23 = { class: "cv-zt" }
const _hoisted_24 = ["onClick", "innerHTML"]
const _hoisted_25 = ["onClick"]
const _hoisted_26 = ["onClick"]
const _hoisted_27 = {
  key: 0,
  class: "cv-selbar"
}
const _hoisted_28 = ["onClick"]
const _hoisted_29 = ["onClick"]
const _hoisted_30 = {
  class: "cv-dock",
  role: "toolbar",
  "aria-label": "画布工具"
}
const _hoisted_31 = ["onClick"]
const _hoisted_32 = ["onClick"]
const _hoisted_33 = ["onClick"]
const _hoisted_34 = ["onClick"]
const _hoisted_35 = ["onClick", "disabled", "title"]
const _hoisted_36 = ["onClick", "disabled", "title"]
const _hoisted_37 = ["onClick"]
const _hoisted_38 = ["onClick"]
const _hoisted_39 = ["onClick"]
const _hoisted_40 = {
  key: 1,
  class: "cv-insp"
}
const _hoisted_41 = { class: "cv-insp-h" }
const _hoisted_42 = ["onClick"]
const _hoisted_43 = {
  class: "cv-insp-b",
  ref: "inspBody"
}
const _hoisted_44 = {
  key: 2,
  class: "cv-wait"
}
const _hoisted_45 = {
  key: 3,
  class: "empty cv-wait"
}
const _hoisted_46 = ["onClick"]

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock(_Fragment, null, [
    _createCommentVNode(" 画布页模板源：项目库与工程页在同一路由组件内切换（?id=）。 "),
    _createElementVNode("div", {
      class: _normalizeClass(["page-main canvas-page", { 'cv-doc': !!_ctx.docId }]),
      ref: "pageEl"
    }, [
      _createElementVNode("header", _hoisted_1, [
        (_ctx.docId)
          ? (_openBlock(), _createElementBlock("button", {
              key: 0,
              class: "ghost cv-back",
              onClick: _ctx.back,
              title: "返回项目库"
            }, [...(_cache[0] || (_cache[0] = [
              _createElementVNode("span", {
                class: "ic",
                "data-icon": "arrowLeft",
                "data-size": "13"
              }, null, -1 /* CACHED */),
              _createTextVNode("项目库", -1 /* CACHED */)
            ]))], 8 /* PROPS */, _hoisted_2))
          : _createCommentVNode("v-if", true),
        (_ctx.docId)
          ? (_openBlock(), _createElementBlock("input", {
              key: 1,
              class: "cv-name",
              value: _ctx.title,
              onChange: _ctx.renameDoc,
              "aria-label": "画布标题"
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_3))
          : (_openBlock(), _createElementBlock("b", _hoisted_4, "画布")),
        _createElementVNode("span", {
          class: _normalizeClass(["cv-state", _ctx.saveKind])
        }, _toDisplayString(_ctx.saveText), 3 /* TEXT, CLASS */),
        (_ctx.docId)
          ? (_openBlock(), _createElementBlock("span", _hoisted_5, "修订 " + _toDisplayString(_ctx.revision), 1 /* TEXT */))
          : _createCommentVNode("v-if", true),
        _cache[4] || (_cache[4] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
        _createElementVNode("button", {
          class: "ghost",
          onClick: _ctx.doExport,
          disabled: !_ctx.docId || !_ctx.ready
        }, [...(_cache[1] || (_cache[1] = [
          _createElementVNode("span", {
            class: "ic",
            "data-icon": "download",
            "data-size": "13"
          }, null, -1 /* CACHED */),
          _createTextVNode("导出", -1 /* CACHED */)
        ]))], 8 /* PROPS */, _hoisted_6),
        _createElementVNode("button", {
          class: "ghost",
          onClick: _ctx.doImport,
          disabled: !_ctx.ready
        }, [...(_cache[2] || (_cache[2] = [
          _createElementVNode("span", {
            class: "ic",
            "data-icon": "importInto",
            "data-size": "13"
          }, null, -1 /* CACHED */),
          _createTextVNode("导入", -1 /* CACHED */)
        ]))], 8 /* PROPS */, _hoisted_7),
        _createElementVNode("button", {
          class: "ghost",
          onClick: _ctx.openAssistant,
          disabled: !_ctx.ready
        }, [...(_cache[3] || (_cache[3] = [
          _createElementVNode("span", {
            class: "ic",
            "data-icon": "robot",
            "data-size": "13"
          }, null, -1 /* CACHED */),
          _createTextVNode("助手", -1 /* CACHED */)
        ]))], 8 /* PROPS */, _hoisted_8)
      ]),
      (!_ctx.docId)
        ? (_openBlock(), _createElementBlock("section", _hoisted_9, [
            _createElementVNode("div", _hoisted_10, [
              _createElementVNode("input", {
                class: "cv-q",
                value: _ctx.q,
                onInput: _ctx.filterLib,
                placeholder: "搜索画布标题或正文",
                "aria-label": "搜索画布"
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_11),
              _createElementVNode("select", {
                class: "cv-sort",
                onChange: _ctx.sortLib,
                "aria-label": "排序方式"
              }, [...(_cache[5] || (_cache[5] = [
                _createElementVNode("option", { value: "up" }, "最近修改", -1 /* CACHED */),
                _createElementVNode("option", { value: "new" }, "最近创建", -1 /* CACHED */),
                _createElementVNode("option", { value: "title" }, "按标题", -1 /* CACHED */)
              ]))], 40 /* PROPS, NEED_HYDRATION */, _hoisted_12),
              _createElementVNode("span", _hoisted_13, _toDisplayString(_ctx.libCount), 1 /* TEXT */),
              _cache[7] || (_cache[7] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
              _createElementVNode("button", {
                class: "pri",
                onClick: _ctx.newDoc,
                disabled: !_ctx.ready
              }, [...(_cache[6] || (_cache[6] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "plus",
                  "data-size": "13"
                }, null, -1 /* CACHED */),
                _createTextVNode("新建画布", -1 /* CACHED */)
              ]))], 8 /* PROPS */, _hoisted_14)
            ]),
            _createElementVNode("div", _hoisted_15, null, 512 /* NEED_PATCH */)
          ]))
        : (_openBlock(), _createElementBlock("section", _hoisted_16, [
            _createElementVNode("div", _hoisted_17, [
              _createElementVNode("div", _hoisted_18, null, 512 /* NEED_PATCH */),
              (_openBlock(), _createElementBlock("svg", _hoisted_19, null, 512 /* NEED_PATCH */))
            ], 512 /* NEED_PATCH */),
            _createElementVNode("div", {
              class: "cv-mini",
              ref: "mini",
              onClick: _ctx.miniJump,
              title: "小地图：点一下就跳过去"
            }, null, 8 /* PROPS */, _hoisted_20),
            _createElementVNode("div", _hoisted_21, [
              _createElementVNode("button", {
                class: "ghost mini",
                onClick: _ctx.zoomOut,
                title: "缩小",
                "aria-label": "缩小",
                innerHTML: _ctx.iconMinus
              }, null, 8 /* PROPS */, _hoisted_22),
              _createElementVNode("span", _hoisted_23, _toDisplayString(_ctx.zoomText), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ghost mini",
                onClick: _ctx.zoomIn,
                title: "放大",
                "aria-label": "放大",
                innerHTML: _ctx.iconPlus
              }, null, 8 /* PROPS */, _hoisted_24),
              _createElementVNode("button", {
                class: "ghost mini",
                onClick: _ctx.zoom100,
                title: "回到 100%"
              }, "100%", 8 /* PROPS */, _hoisted_25),
              _createElementVNode("button", {
                class: "ghost mini",
                onClick: _ctx.fit,
                title: "全部装进屏幕"
              }, "全部", 8 /* PROPS */, _hoisted_26)
            ]),
            (_ctx.selCount)
              ? (_openBlock(), _createElementBlock("div", _hoisted_27, [
                  _createTextVNode(" 已选 " + _toDisplayString(_ctx.selCount) + " 个 ", 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "ghost mini",
                    onClick: _ctx.alignSel
                  }, "对齐排开", 8 /* PROPS */, _hoisted_28),
                  _createElementVNode("button", {
                    class: "ghost mini",
                    onClick: _ctx.deleteSel
                  }, "删除", 8 /* PROPS */, _hoisted_29)
                ]))
              : _createCommentVNode("v-if", true),
            _createElementVNode("nav", _hoisted_30, [
              _createElementVNode("button", {
                class: _normalizeClass(["tool", { on: _ctx.tool === 'select' }]),
                onClick: $event => (_ctx.setTool('select')),
                title: "选择（V）"
              }, [...(_cache[8] || (_cache[8] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "checkBox",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("选择", -1 /* CACHED */)
              ]))], 10 /* CLASS, PROPS */, _hoisted_31),
              _createElementVNode("button", {
                class: _normalizeClass(["tool", { on: _ctx.tool === 'hand' }]),
                onClick: $event => (_ctx.setTool('hand')),
                title: "抓手平移（H，或按住空格）"
              }, [...(_cache[9] || (_cache[9] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "expand",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("抓手", -1 /* CACHED */)
              ]))], 10 /* CLASS, PROPS */, _hoisted_32),
              _createElementVNode("button", {
                class: "tool",
                onClick: _ctx.openAdd,
                title: "添加节点（N）"
              }, [...(_cache[10] || (_cache[10] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "plus",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("加节点", -1 /* CACHED */)
              ]))], 8 /* PROPS */, _hoisted_33),
              _createElementVNode("button", {
                class: "tool",
                onClick: _ctx.pickAsset,
                title: "从资产库放一个进来"
              }, [...(_cache[11] || (_cache[11] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "box",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("放素材", -1 /* CACHED */)
              ]))], 8 /* PROPS */, _hoisted_34),
              _createElementVNode("button", {
                class: "tool",
                onClick: _ctx.undoStep,
                disabled: !_ctx.canUndo,
                title: _ctx.undoTitle
              }, [...(_cache[12] || (_cache[12] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "stepBack",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("撤销", -1 /* CACHED */)
              ]))], 8 /* PROPS */, _hoisted_35),
              _createElementVNode("button", {
                class: "tool",
                onClick: _ctx.redoStep,
                disabled: !_ctx.canRedo,
                title: _ctx.redoTitle
              }, [...(_cache[13] || (_cache[13] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "stepNext",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("重做", -1 /* CACHED */)
              ]))], 8 /* PROPS */, _hoisted_36),
              _createElementVNode("button", {
                class: _normalizeClass(["tool", { on: _ctx.grid }]),
                onClick: _ctx.toggleGrid,
                title: "移动时贴 8px 网格"
              }, [...(_cache[14] || (_cache[14] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "layers",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("网格", -1 /* CACHED */)
              ]))], 10 /* CLASS, PROPS */, _hoisted_37),
              _createElementVNode("button", {
                class: _normalizeClass(["tool", { on: _ctx.showEdges }]),
                onClick: _ctx.toggleEdges,
                title: "显示连线"
              }, [...(_cache[15] || (_cache[15] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "link",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("连线", -1 /* CACHED */)
              ]))], 10 /* CLASS, PROPS */, _hoisted_38),
              _createElementVNode("button", {
                class: "tool",
                onClick: _ctx.keysHelp,
                title: "快捷键（?）"
              }, [...(_cache[16] || (_cache[16] = [
                _createElementVNode("span", {
                  class: "ic",
                  "data-icon": "key",
                  "data-size": "14"
                }, null, -1 /* CACHED */),
                _createTextVNode("快捷键", -1 /* CACHED */)
              ]))], 8 /* PROPS */, _hoisted_39)
            ]),
            (_ctx.inspOpen)
              ? (_openBlock(), _createElementBlock("aside", _hoisted_40, [
                  _createElementVNode("div", _hoisted_41, [
                    _cache[18] || (_cache[18] = _createElementVNode("b", null, "检查器", -1 /* CACHED */)),
                    _cache[19] || (_cache[19] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
                    _createElementVNode("button", {
                      class: "ghost mini",
                      onClick: _ctx.closeInsp,
                      title: "关闭（Esc）",
                      "aria-label": "关闭检查器"
                    }, [...(_cache[17] || (_cache[17] = [
                      _createElementVNode("span", {
                        class: "ic",
                        "data-icon": "close",
                        "data-size": "13"
                      }, null, -1 /* CACHED */)
                    ]))], 8 /* PROPS */, _hoisted_42)
                  ]),
                  _createElementVNode("div", _hoisted_43, null, 512 /* NEED_PATCH */)
                ]))
              : _createCommentVNode("v-if", true)
          ])),
      (!_ctx.ready && !_ctx.failed)
        ? (_openBlock(), _createElementBlock("div", _hoisted_44, [...(_cache[20] || (_cache[20] = [
            _createElementVNode("span", { class: "ui-wait" }, null, -1 /* CACHED */),
            _createTextVNode("正在读本机的画布…", -1 /* CACHED */)
          ]))]))
        : (_ctx.failed)
          ? (_openBlock(), _createElementBlock("div", _hoisted_45, [
              _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ghost mini",
                onClick: _ctx.retryLoad
              }, "重新加载本页", 8 /* PROPS */, _hoisted_46)
            ]))
          : _createCommentVNode("v-if", true)
    ], 2 /* CLASS */)
  ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
}
