/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/studio.html 编译，别手改。 */
import { createCommentVNode as _createCommentVNode, createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, openBlock as _openBlock, createElementBlock as _createElementBlock } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main studio-page wb",
  ref: "pageEl"
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createCommentVNode(" 统一页头（全站唯一一份 .phead）：这一页以前标题缩在左栏顶部、字号还独一份，\n           左栏一滚标题就跟着走了。现在提到全宽顶排，左栏顶部让给类型切换与型号下拉。 "),
    _cache[0] || (_cache[0] = _createElementVNode("header", { class: "phead" }, [
      _createElementVNode("div", { class: "phead-id" }, [
        _createElementVNode("h1", { class: "phead-h1" }, "生成工作台")
      ]),
      _createElementVNode("div", { class: "phead-acts" })
    ], -1 /* CACHED */)),
    _cache[1] || (_cache[1] = _createElementVNode("div", { class: "layout" }, [
      _createElementVNode("div", {
        class: "col-left",
        "data-r": "leftCol"
      }, [
        _createElementVNode("div", { class: "st-top" }, [
          _createElementVNode("div", {
            class: "ui-seg",
            "data-r": "typeSeg",
            role: "tablist",
            "aria-label": "生成类型"
          }),
          _createElementVNode("div", { class: "st-model" }, [
            _createElementVNode("select", { "data-r": "model" })
          ])
        ]),
        _createElementVNode("div", {
          class: "st-sub",
          "data-r": "stSub"
        }),
        _createElementVNode("div", {
          class: "prompt-box",
          "data-r": "promptBox"
        }, [
          _createElementVNode("textarea", {
            "data-r": "prompt",
            spellcheck: "false"
          }),
          _createElementVNode("div", {
            class: "prompt-hint",
            "data-r": "promptHint",
            hidden: ""
          }),
          _createElementVNode("div", { class: "btn-row" }, [
            _createElementVNode("button", {
              class: "tool acc",
              "data-r": "polishBtn",
              title: "文字 AI 改写提示词"
            }, [
              _createElementVNode("span", {
                class: "ic",
                "data-icon": "sparkles",
                "data-size": "14"
              }),
              _createTextVNode("AI 润色")
            ]),
            _createElementVNode("button", {
              class: "tool",
              "data-r": "splitBtn",
              hidden: "",
              title: "拆成多张图的提示词"
            }, [
              _createElementVNode("span", {
                class: "ic",
                "data-icon": "sparkles",
                "data-size": "14"
              }),
              _createTextVNode("拆分片段生成")
            ]),
            _createElementVNode("span", { class: "sp" }),
            _createElementVNode("button", {
              class: "tool danger",
              "data-r": "clearAll",
              title: "清空提示词、素材与参数"
            }, [
              _createElementVNode("span", {
                class: "ic",
                "data-icon": "trash",
                "data-size": "14"
              }),
              _createElementVNode("span", { class: "tx" }, "一键清空")
            ])
          ]),
          _createElementVNode("div", {
            "data-r": "polishInline",
            hidden: ""
          }),
          _createElementVNode("div", {
            class: "pinl",
            "data-r": "splitInline",
            hidden: ""
          }, [
            _createElementVNode("div", { class: "pinl-hd" }, [
              _createElementVNode("span", { class: "pinl-tt" }, "拆分片段生成"),
              _createElementVNode("span", { class: "pinl-note" }, "每张独立计费。")
            ]),
            _createElementVNode("div", { class: "split-opts" }, [
              _createElementVNode("label", null, [
                _createTextVNode("张数 "),
                _createElementVNode("select", { "data-r": "splitCount" }, [
                  _createElementVNode("option", { value: "" }, "自动"),
                  _createElementVNode("option", null, "2"),
                  _createElementVNode("option", null, "3"),
                  _createElementVNode("option", null, "4"),
                  _createElementVNode("option", null, "5"),
                  _createElementVNode("option", null, "6")
                ])
              ]),
              _createElementVNode("label", null, [
                _createTextVNode("拆分维度 "),
                _createElementVNode("select", { "data-r": "splitDim" }, [
                  _createElementVNode("option", { value: "" }, "自动"),
                  _createElementVNode("option", null, "按时间顺序"),
                  _createElementVNode("option", null, "按场景变化"),
                  _createElementVNode("option", null, "按动作或状态阶段"),
                  _createElementVNode("option", { value: "__custom" }, "自定义…")
                ])
              ]),
              _createElementVNode("label", {
                "data-r": "splitDimCustomWrap",
                hidden: ""
              }, [
                _createElementVNode("input", {
                  "data-r": "splitDimCustom",
                  maxlength: "60",
                  placeholder: "例：按主角情绪变化"
                })
              ]),
              _createElementVNode("span", { class: "sp" }),
              _createElementVNode("button", {
                class: "tool acc",
                "data-r": "splitGo"
              }, "开始规划"),
              _createElementVNode("button", {
                class: "tool",
                "data-r": "splitCancel"
              }, "取消")
            ])
          ]),
          _createElementVNode("div", {
            class: "style-row",
            "data-r": "styleRow",
            hidden: ""
          }, [
            _createElementVNode("label", null, [
              _createTextVNode("风格 / 音色描述 "),
              _createElementVNode("span", { style: {"color":"var(--err)"} }, "*")
            ]),
            _createElementVNode("input", {
              "data-r": "style",
              class: "ui-inp",
              placeholder: "例：温柔女声，语速偏慢"
            }),
            _createElementVNode("div", { style: {"margin-top":"var(--sp-6)"} }, [
              _createElementVNode("button", {
                class: "ghost",
                "data-r": "stylePick"
              }, "取一位素材的音色描述")
            ])
          ]),
          _createElementVNode("div", {
            class: "ed-label",
            "data-r": "modeHead",
            hidden: ""
          }, [
            _createElementVNode("span", null, "输入模式"),
            _createElementVNode("span", {
              class: "cnt",
              "data-r": "modeHeadNote"
            })
          ]),
          _createElementVNode("div", {
            class: "mode-row",
            "data-r": "modeRow",
            hidden: ""
          }),
          _createElementVNode("div", {
            class: "ed-label",
            "data-r": "slotHead",
            hidden: ""
          }, [
            _createElementVNode("span", null, "参考素材"),
            _createElementVNode("span", {
              class: "cnt",
              "data-r": "slotHeadNote"
            })
          ]),
          _createElementVNode("div", {
            class: "slot-wrap",
            "data-r": "inputArea"
          })
        ]),
        _createElementVNode("div", {
          class: "adv",
          "data-r": "adv"
        }, [
          _createElementVNode("div", {
            class: "adv-head",
            "data-r": "advHead"
          }, [
            _createElementVNode("h2", null, [
              _createElementVNode("span", {
                "data-icon": "gear",
                "data-size": "14"
              }),
              _createTextVNode(),
              _createElementVNode("span", { "data-r": "advTitle" }, "高级设置")
            ]),
            _createElementVNode("span", { class: "sum" }, [
              _createElementVNode("span", { "data-r": "advSum" }),
              _createElementVNode("span", { class: "chev" }, "▼")
            ])
          ]),
          _createElementVNode("div", {
            class: "adv-body",
            "data-r": "advBody"
          }),
          _createElementVNode("div", {
            class: "hint",
            "data-r": "capHint",
            style: {"font-size":"var(--fs-11-5)","color":"var(--sub)","margin-top":"var(--sp-10)"}
          })
        ]),
        _createElementVNode("div", { class: "costbar" }, [
          _createElementVNode("span", { "data-r": "costTxt" }, "估价中…"),
          _createElementVNode("span", {
            class: "note",
            "data-r": "mode"
          }, "文生视频")
        ]),
        _createElementVNode("button", {
          class: "go",
          "data-r": "go"
        }, "生成视频"),
        _createElementVNode("div", {
          class: "hint",
          "data-r": "goWhy"
        }),
        _createElementVNode("div", { "data-r": "status" }),
        _createElementVNode("div", { "data-raw-host": "" }),
        _createElementVNode("div", {
          "data-r": "balTip",
          hidden: ""
        }),
        _createElementVNode("div", {
          class: "hint",
          "data-r": "pendingHint",
          style: {"display":"none","font-size":"var(--fs-11-5)","margin-top":"var(--sp-6)"}
        })
      ]),
      _createElementVNode("div", { class: "col-right" }, [
        _createCommentVNode(" 类型选择这一排在**上面**：下面那一排是搜索与「多选 / 刷新」这些动作，\n               筛选压在它们下面时，用户要先越过一排按钮才看见「按类型筛」；\n               资产库那一页也是这个次序（筛选在前、动作在后），两页次序一致。 "),
        _createElementVNode("div", { class: "hist-filters" }, [
          _createElementVNode("div", {
            class: "ui-seg",
            "data-r": "histFilter",
            role: "tablist",
            "aria-label": "按类型筛选"
          }),
          _createElementVNode("span", { class: "sp" }),
          _createElementVNode("span", {
            class: "hint",
            "data-r": "histNote"
          }),
          _createElementVNode("button", {
            class: "ghost",
            "data-r": "winAll",
            title: "默认只看最近 30 天"
          }, "查看全部")
        ]),
        _createElementVNode("div", { class: "tasks-head" }, [
          _createElementVNode("span", { class: "sp" }),
          _createElementVNode("span", { class: "pgroup" }, [
            _createElementVNode("span", {
              class: "fb-host",
              "data-r": "searchHost"
            }),
            _createElementVNode("span", { class: "pgsep" }),
            _createElementVNode("button", {
              class: "ghost",
              id: "multiBtn",
              "data-r": "multiBtn"
            }, [
              _createElementVNode("span", {
                "data-icon": "checkBox",
                "data-size": "13"
              }),
              _createTextVNode(" 多选")
            ]),
            _createElementVNode("button", {
              class: "ghost",
              "data-r": "sync",
              title: "重新取回列表"
            }, [
              _createElementVNode("span", {
                "data-icon": "refresh",
                "data-size": "13"
              }),
              _createTextVNode(" 刷新")
            ])
          ])
        ]),
        _createCommentVNode(" 翻页行在**右栏的上方**（搜索那一排下面）：翻页是「看这一屏」的动作，\n               放在结果区顶上，翻到第几页一眼就看得见；以前它塞在页底，右栏滚到底才找得到。\n               收藏 / 素材库 / 资产库三页仍在页底（整页滚，页底那一处是全站统一的位置）。 "),
        _createElementVNode("div", { class: "wb-pager" }, [
          _createElementVNode("span", {
            class: "pgrow",
            id: "stPgRow",
            "data-r": "stPgRow"
          }),
          _createElementVNode("input", {
            type: "number",
            id: "stGotoPage",
            "data-r": "stGotoPage",
            min: "1",
            placeholder: "跳页"
          }),
          _createElementVNode("button", {
            class: "ghost",
            "data-r": "gotoBtn"
          }, "跳转")
        ]),
        _createCommentVNode(" 多选条（与资产库同一套公共件：.bulkbar / .bk-cnt / .bk-tip） "),
        _createElementVNode("div", {
          class: "bulkbar",
          id: "stBulkBar",
          "data-r": "bulkBar",
          hidden: ""
        }, [
          _createElementVNode("span", {
            class: "bk-cnt",
            "data-r": "bulkCnt"
          }, "已选 0 项"),
          _createElementVNode("button", {
            class: "ghost",
            "data-r": "bulkAll"
          }, "全选"),
          _createElementVNode("button", {
            class: "ghost",
            "data-r": "bulkClear"
          }, "取消选择"),
          _createElementVNode("button", {
            class: "ghost",
            id: "stBulkDown",
            "data-r": "bulkDown",
            disabled: ""
          }, [
            _createElementVNode("span", {
              "data-icon": "download",
              "data-size": "13"
            }),
            _createTextVNode(" 批量下载")
          ]),
          _createCommentVNode(" 收藏那两颗：把勾选的产物收进「我的收藏」/ 从里面拿出来（与资产库同一套公共件） "),
          _createElementVNode("button", {
            class: "ghost",
            id: "stBulkFavAdd",
            "data-r": "bulkFavAdd",
            disabled: ""
          }, [
            _createElementVNode("span", {
              "data-icon": "star",
              "data-size": "13"
            }),
            _createTextVNode(" 收藏")
          ]),
          _createElementVNode("button", {
            class: "ghost",
            id: "stBulkFavRemove",
            "data-r": "bulkFavRemove",
            disabled: ""
          }, [
            _createElementVNode("span", {
              "data-icon": "starFill",
              "data-size": "13"
            }),
            _createTextVNode(" 取消收藏")
          ]),
          _createCommentVNode(" 「存回本机」是**多选才出现**的动作，存的是**勾选的那几条**（不是整屏）：\n                 不多选就点它，等于「把这一屏都存一遍」—— 那不是用户的意思。 "),
          _createElementVNode("button", {
            class: "ghost",
            id: "stPullLocal",
            "data-r": "pullLocalBtn"
          }, [
            _createElementVNode("span", { class: "ic" }, [
              _createElementVNode("span", {
                "data-icon": "box",
                "data-size": "13"
              })
            ]),
            _createTextVNode(),
            _createElementVNode("span", { class: "tx" }, "存回本机")
          ]),
          _createElementVNode("span", {
            class: "bk-tip",
            "data-r": "bulkTip"
          }, "点卡片勾选"),
          _createElementVNode("span", {
            class: "sp",
            style: {"flex":"1"}
          }),
          _createElementVNode("button", {
            class: "ghost",
            "data-r": "multiExit"
          }, "退出多选")
        ]),
        _createElementVNode("div", {
          id: "result",
          "data-r": "result"
        })
      ])
    ], -1 /* CACHED */)),
    _createCommentVNode(" 页底没有别的了：翻页行在右栏顶上（见上面 .col-right 里那一处），\n           提示词区那一块说明文字在左栏（.st-brand 的 .desc）。\n           ⚠ 这里**不要再加一个平级于 .layout 的块**：.wb 是固定高、overflow:hidden 的壳，\n           .layout 已经是 height:100%，多一个兄弟节点就会把两栏顶矮一截（页脚那行就是这么把\n           左右栏压短了一截的）。 ")
  ], 512 /* NEED_PATCH */))
}
