/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/studio.html 编译，别手改。 */
import { createCommentVNode as _createCommentVNode, createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, createStaticVNode as _createStaticVNode, openBlock as _openBlock, createElementBlock as _createElementBlock } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
class: "page-main studio-page wb",
ref: "pageEl"
}

export function render(_ctx, _cache) {
return (_openBlock(), _createElementBlock("div", _hoisted_1, [
_createCommentVNode(" 统一页头（全站唯一一份 .phead）：这一页以前标题缩在左栏顶部、字号还独一份，\n           左栏一滚标题就跟着走了。现在提到全宽顶排，左栏顶部让给类型切换与型号下拉。 "),
_cache[0] || (_cache[0] = _createStaticVNode("<header class=\"phead\"><div class=\"phead-id\"><h1 class=\"phead-h1\">工作台</h1></div><span class=\"phead-sub\"></span><div class=\"phead-acts\"></div></header>", 1)),
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
_createCommentVNode(" 两颗 AI 按钮的外观与那一行字都来自公共层（InlinePolish.btnHTML / window.aiBtnHTML）：\n                   模板里只留两块空宿主，页面挂载时灌进去 —— 这一页不写第二份「AI 润色」。 "),
_createElementVNode("span", {
class: "btn-host",
"data-r": "polishHost"
}),
_createElementVNode("span", {
class: "btn-host",
"data-r": "splitHost"
}),
_createCommentVNode(" 视频栏与图像栏之间的单向传送：这一颗只在视频栏出现（paintLeft 管显隐）。 "),
_createElementVNode("button", {
class: "ghost",
type: "button",
"data-r": "toImageBtn",
title: "把这段提示词填进图像栏"
}, [
_createElementVNode("span", {
class: "ic",
"data-icon": "image",
"data-size": "13"
}),
_createElementVNode("span", { class: "tx" }, "送进图像栏")
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
_createCommentVNode(" 那一排选项（张数 / 拆分维度 / 自定义，连「开始规划」与「取消」）由公共层\n                   window.SplitPlan 画 —— 导演台右栏的「画面切片规划」用的是同一一份，\n                   这里只留一块空宿主，页面挂载时灌进去。 "),
_createElementVNode("div", { "data-r": "splitOpts" }),
_createElementVNode("label", { class: "fill-video-row" }, [
_createElementVNode("input", {
type: "checkbox",
"data-r": "splitFillVideo"
}),
_createElementVNode("span", null, "生成后填入视频栏参考素材（生成完自动就位）")
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
_createElementVNode("div", { style: {"margin-top":"var(--sp-8)"} }, [
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
style: {"font-size":"var(--fs-12)","color":"var(--sub)","margin-top":"var(--sp-8)"}
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
type: "button",
class: "go pri",
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
style: {"display":"none","font-size":"var(--fs-12)","margin-top":"var(--sp-8)"}
})
]),
_createElementVNode("div", { class: "col-right" }, [
_createCommentVNode(" 类型选择这一排在**上面**：下面那一排是搜索与「多选 / 刷新」这些动作，\n               筛选压在它们下面时，用户要先越过一排按钮才看见「按类型筛」；\n               资产库那一页也是这个次序（筛选在前、动作在后），两页次序一致。\n               这一排只有类型档：历史不按时间裁，也就不再有「最近 30 天 / 查看全部」那一档。 "),
_createElementVNode("div", { class: "hist-filters" }, [
_createElementVNode("div", {
class: "ui-seg",
"data-r": "histFilter",
role: "tablist",
"aria-label": "按类型筛选"
})
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
]),
_createElementVNode("span", { class: "pgsep" }),
_createCommentVNode(" 搜索 / 多选 / 刷新与翻页（上一页 · 第几页 · 下一页 · 跳页 · 跳转）并成同一排：\n                   都只影响这一屏列表。这一组按「尽量一行」设计，右栏被拖窄时才自己换行。\n                   收藏 / 素材库 / 资产库三页的翻页仍在页底（整页滚，页底是全站统一的位置）。 "),
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
])
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
_createCommentVNode(" 勾选的图片送进视频栏的参考素材（只在图像栏 + 勾了图片才点得动）：\n                 视频型号收不收参考图、收几张由能力声明说了算，收不下时当场报数。 "),
_createElementVNode("button", {
class: "ghost",
"data-r": "bulkToVideo",
disabled: ""
}, [
_createElementVNode("span", {
"data-icon": "video",
"data-size": "13"
}),
_createTextVNode(" 送进视频栏")
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
class: "task-grid",
"data-r": "result"
})
])
], -1 /* CACHED */)),
_createCommentVNode(" 页底没有别的了：翻页行在右栏顶上（见上面 .col-right 里那一处），\n           提示词区那一块说明文字在左栏（.st-brand 的 .desc）。\n           ⚠ 这里**不要再加一个平级于 .layout 的块**：.wb 是固定高、overflow:hidden 的壳，\n           .layout 已经是 height:100%，多一个兄弟节点就会把两栏顶矮一截（页脚那行就是这么把\n           左右栏压短了一截的）。 ")
], 512 /* NEED_PATCH */))
}
