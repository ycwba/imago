/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/model.html 编译，别手改。 */
import { createCommentVNode as _createCommentVNode, createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, createStaticVNode as _createStaticVNode, Fragment as _Fragment, openBlock as _openBlock, createElementBlock as _createElementBlock } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
class: "page-main model-page",
ref: "pageEl"
}

export function render(_ctx, _cache) {
return (_openBlock(), _createElementBlock(_Fragment, null, [
_createCommentVNode(" 建模台：整页不滚（页头 + 三栏），与导演台同一副外壳契约。\n         三栏里的内容几乎全是命令式渲染（库卡片、视口、对象树、时间线），\n         模板只留宿主与页头那几格文字 —— 与工作台/素材库同一种做法：\n         动态区域由脚本灌 innerHTML，Vue 不接管它们的子节点。 "),
_createElementVNode("div", _hoisted_1, [...(_cache[0] || (_cache[0] = [
_createStaticVNode("<header class=\"phead\"><div class=\"phead-id\"><h1 class=\"phead-h1\">建模台</h1></div><div class=\"phead-meta\"><span class=\"phead-chip\" data-r=\"mmName\">未命名白膜</span><span class=\"phead-chip\" data-r=\"mmDirty\">新建</span></div><span class=\"phead-sub\" data-r=\"mmSub\">一句话生成白膜，调好机位再出图或出片</span><div class=\"phead-acts\"><button class=\"ghost\" type=\"button\" data-r=\"mmSave\"><span data-icon=\"download\" data-size=\"13\"></span> 保存</button><button class=\"ghost\" type=\"button\" data-r=\"mmSaveAs\"><span data-icon=\"box\" data-size=\"13\"></span> 另存为</button><button class=\"ghost\" type=\"button\" data-r=\"mmExportJson\" title=\"导出成一份能带走、能再导回来的 .json\"><span data-icon=\"upload\" data-size=\"13\"></span> 导出</button></div></header>", 1),
_createElementVNode("div", { class: "mm-layout" }, [
_createCommentVNode(" 左栏：白膜库（分组 / 卡片 / 底部动作）。栏宽可拖，拖动条由 Wb.split 提供。 "),
_createElementVNode("aside", {
class: "mm-rail",
"data-r": "mmRail"
}, [
_createElementVNode("div", { class: "mm-rail-head" }, [
_createElementVNode("input", {
class: "search",
"data-r": "mmSearch",
type: "search",
placeholder: "搜模型名 / 组…",
"aria-label": "搜模型"
})
]),
_createElementVNode("div", {
class: "mm-groups",
"data-r": "mmGroups",
role: "group",
"aria-label": "按组筛选"
}),
_createElementVNode("div", {
class: "mm-cards",
"data-r": "mmCards"
}),
_createElementVNode("div", { class: "mm-rail-foot" }, [
_createElementVNode("button", {
class: "ghost mini",
type: "button",
"data-r": "mmNew"
}, [
_createElementVNode("span", {
"data-icon": "sparkles",
"data-size": "12"
}),
_createTextVNode(" 新建")
]),
_createElementVNode("button", {
class: "ghost mini",
type: "button",
"data-r": "mmImport3d"
}, [
_createElementVNode("span", {
"data-icon": "box",
"data-size": "12"
}),
_createTextVNode(" 3D 文件")
]),
_createElementVNode("button", {
class: "ghost mini",
type: "button",
"data-r": "mmImportJson"
}, [
_createElementVNode("span", {
"data-icon": "upload",
"data-size": "12"
}),
_createTextVNode(" 导入")
]),
_createElementVNode("button", {
class: "ghost mini",
type: "button",
"data-r": "mmRename"
}, [
_createElementVNode("span", {
"data-icon": "list",
"data-size": "12"
}),
_createTextVNode(" 改名")
]),
_createElementVNode("button", {
class: "ghost mini",
type: "button",
"data-r": "mmMove"
}, [
_createElementVNode("span", {
"data-icon": "grid",
"data-size": "12"
}),
_createTextVNode(" 移组")
]),
_createElementVNode("button", {
class: "ghost mini danger",
type: "button",
"data-r": "mmDelete"
}, [
_createElementVNode("span", {
"data-icon": "trash",
"data-size": "12"
}),
_createTextVNode(" 删除")
])
]),
_createElementVNode("input", {
type: "file",
"data-r": "mmFileJson",
accept: ".json,application/json",
hidden: ""
}),
_createElementVNode("input", {
type: "file",
"data-r": "mmFile3d",
accept: ".fbx,.obj,.glb,.gltf",
hidden: ""
})
]),
_createCommentVNode(" 中栏：工具条 + 视口 + 底部轨道坞 "),
_createElementVNode("section", { class: "mm-stage" }, [
_createElementVNode("div", {
class: "mm-tools",
"data-r": "mmTools",
role: "toolbar",
"aria-label": "视口工具"
}),
_createElementVNode("div", {
class: "mm-viewport",
"data-r": "mmViewport",
tabindex: "0",
"aria-label": "三维视口"
}),
_createElementVNode("div", {
class: "mm-dock",
"data-r": "mmDock"
}),
_createCommentVNode(" 出图 / 出片之后那一条（刚出的这一份：下载 · 回传工作台 · 回传导演台）。\n               空的时候不占位，见 spa-model.css 的 `.mm-result:empty`。 "),
_createElementVNode("div", {
class: "mm-result",
"data-r": "mmResult"
})
]),
_createCommentVNode(" 右栏：AI / 场景 两档 "),
_createElementVNode("aside", { class: "mm-side" }, [
_createElementVNode("div", {
class: "mm-side-tabs",
"data-r": "mmSideTabs",
role: "tablist",
"aria-label": "右栏"
}),
_createElementVNode("div", {
class: "mm-side-body",
"data-r": "mmSideBody"
})
])
], -1 /* CACHED */)
]))], 512 /* NEED_PATCH */)
], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
}
