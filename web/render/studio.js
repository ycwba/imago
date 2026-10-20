/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/studio.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, openBlock as _openBlock, createElementBlock as _createElementBlock } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main studio-page wb2",
  ref: "pageEl"
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [...(_cache[0] || (_cache[0] = [
    _createElementVNode("div", { class: "layout" }, [
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
              title: "调用文字 AI 改写提示词（密钥在「设置」配置）"
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
              title: "把这段描述拆成几张图的提示词，确认后逐条提交（每条都是一条真任务）"
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
              title: "清空提示词、素材与参数（会先问你一次）"
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
              _createElementVNode("span", { class: "pinl-tt" }, "拆分片段批量生成"),
              _createElementVNode("span", { class: "pinl-note" }, "每张是一条独立任务（逐条提交、各自计费）；下方槽里的参考图会一起带去")
            ]),
            _createElementVNode("div", { class: "split-opts" }, [
              _createElementVNode("label", null, [
                _createTextVNode("张数 "),
                _createElementVNode("select", { "data-r": "splitCount" }, [
                  _createElementVNode("option", { value: "" }, "自动（AI 按内容定 2–6 张）"),
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
                  _createElementVNode("option", { value: "" }, "自动（AI 选最自然的）"),
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
                  placeholder: "例：按主角情绪变化 / 按道具出现的先后顺序"
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
              _createElementVNode("span", { style: {"color":"var(--err)"} }, "*"),
              _createTextVNode("（音色设计型号必填）")
            ]),
            _createElementVNode("input", {
              "data-r": "style",
              class: "ui-inp",
              placeholder: "例：一位温柔的年轻女声，语速偏慢，适合睡前故事"
            }),
            _createElementVNode("div", { style: {"margin-top":"6px"} }, [
              _createElementVNode("button", {
                class: "ghost",
                "data-r": "stylePick",
                title: "从素材库挑一位，把它身上写的那段音色描述填到这里"
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
            style: {"font-size":"11.5px","color":"var(--sub)","margin-top":"10px"}
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
        _createElementVNode("div", {
          "data-r": "balTip",
          hidden: ""
        }),
        _createElementVNode("div", {
          class: "hint",
          "data-r": "pendingHint",
          style: {"display":"none","font-size":"11.5px","margin-top":"6px"}
        })
      ]),
      _createElementVNode("div", { class: "col-right" }, [
        _createElementVNode("div", { class: "tasks-head" }, [
          _createElementVNode("span", { class: "tab" }, "这一台的生成历史"),
          _createElementVNode("span", { class: "sp" }),
          _createElementVNode("span", { class: "pgroup" }, [
            _createElementVNode("input", {
              type: "search",
              "data-r": "searchBox",
              placeholder: "搜索提示词 / ID",
              autocomplete: "off",
              spellcheck: "false"
            }),
            _createElementVNode("button", {
              class: "ghost",
              "data-r": "searchBtn"
            }, "搜索"),
            _createElementVNode("span", { class: "pgsep" }),
            _createElementVNode("button", {
              class: "ghost",
              id: "stPgPrev",
              style: {"display":"none"}
            }, "‹ 上一页"),
            _createElementVNode("span", {
              class: "pginfo",
              id: "stPgInfo"
            }, "第 1 页"),
            _createElementVNode("button", {
              class: "ghost",
              id: "stPgNext",
              style: {"display":"none"}
            }, "下一页 ›"),
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
            }, "跳转"),
            _createElementVNode("button", {
              class: "ghost",
              "data-r": "sync",
              title: "重新从各平台取回这一屏列表"
            }, [
              _createElementVNode("span", {
                "data-icon": "refresh",
                "data-size": "13"
              }),
              _createTextVNode(" 刷新")
            ]),
            _createElementVNode("button", {
              class: "ghost",
              "data-r": "pullLocalBtn",
              title: "把这一屏里本机还没有那份字节的产物取回本机资产库（外链过期不再是破图，「优先用本机文件」才有东西可用）"
            }, [
              _createElementVNode("span", {
                "data-icon": "box",
                "data-size": "13"
              }),
              _createTextVNode(" 存回本机")
            ])
          ])
        ]),
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
            title: "默认只看最近 30 天；点这里看全部"
          }, "查看全部")
        ]),
        _createElementVNode("div", {
          id: "result",
          "data-r": "result"
        })
      ])
    ], -1 /* CACHED */),
    _createElementVNode("div", { class: "ver" }, "生成工作台 · 视频 / 图像 / 音频 · 右栏卡片可拖到左栏当参考素材", -1 /* CACHED */)
  ]))], 512 /* NEED_PATCH */))
}
