/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/usage.html 编译，别手改。 */
import { createCommentVNode as _createCommentVNode, createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, toDisplayString as _toDisplayString, openBlock as _openBlock, createElementBlock as _createElementBlock, Fragment as _Fragment, normalizeStyle as _normalizeStyle, renderList as _renderList, vModelSelect as _vModelSelect, withDirectives as _withDirectives, vModelText as _vModelText, createStaticVNode as _createStaticVNode } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
class: "page-main usage-page page-shell",
ref: "rootEl"
}
const _hoisted_2 = { class: "bar" }
const _hoisted_3 = ["disabled", "onClick"]
const _hoisted_4 = ["innerHTML"]
const _hoisted_5 = {
class: "upd",
id: "upd"
}
const _hoisted_6 = {
key: 0,
class: "empty"
}
const _hoisted_7 = ["onClick"]
const _hoisted_8 = { class: "ub-layout" }
const _hoisted_9 = { class: "ub-left" }
const _hoisted_10 = { class: "cards" }
const _hoisted_11 = {
key: 0,
class: "empty"
}
const _hoisted_12 = { class: "hd" }
const _hoisted_13 = ["innerHTML"]
const _hoisted_14 = { class: "v" }
const _hoisted_15 = { key: 0 }
const _hoisted_16 = {
key: 0,
class: "md"
}
const _hoisted_17 = { class: "ex" }
const _hoisted_18 = { class: "panel" }
const _hoisted_19 = {
class: "chart-units",
ref: "chartUnitsEl"
}
const _hoisted_20 = ["innerHTML"]
const _hoisted_21 = { class: "panel" }
const _hoisted_22 = { class: "stat" }
const _hoisted_23 = {
key: 1,
class: "empty"
}
const _hoisted_24 = { key: 0 }
const _hoisted_25 = { class: "num" }
const _hoisted_26 = { key: 0 }
const _hoisted_27 = ["title"]
const _hoisted_28 = { class: "t" }
const _hoisted_29 = {
class: "w",
style: {"color":"var(--sub)"}
}
const _hoisted_30 = { class: "num" }
const _hoisted_31 = { class: "panel" }
const _hoisted_32 = {
class: "stat",
id: "aiStat"
}
const _hoisted_33 = {
class: "hint",
id: "aiPriceNote",
style: {"margin":"var(--sp-2) 0 var(--sp-12)"}
}
const _hoisted_34 = { key: 0 }
const _hoisted_35 = { class: "num" }
const _hoisted_36 = {
key: 1,
class: "empty"
}
const _hoisted_37 = { key: 0 }
const _hoisted_38 = { class: "t" }
const _hoisted_39 = { class: "num" }
const _hoisted_40 = {
key: 1,
class: "empty"
}
const _hoisted_41 = { class: "ub-right" }
const _hoisted_42 = { class: "panel bills-panel" }
const _hoisted_43 = { class: "filters" }
const _hoisted_44 = { class: "ddwrap" }
const _hoisted_45 = ["onUpdate:modelValue", "onChange"]
const _hoisted_46 = ["value"]
const _hoisted_47 = { class: "ddwrap" }
const _hoisted_48 = ["onUpdate:modelValue", "onChange"]
const _hoisted_49 = ["onUpdate:modelValue", "onInput"]
const _hoisted_50 = ["onClick"]
const _hoisted_51 = ["onClick", "innerHTML"]
const _hoisted_52 = {
class: "upd",
id: "billCnt",
style: {"margin-bottom":"var(--sp-8)"}
}
const _hoisted_53 = { id: "bills" }
const _hoisted_54 = ["innerHTML"]
const _hoisted_55 = {
key: 1,
class: "empty"
}
const _hoisted_56 = {
key: 2,
class: "empty"
}
const _hoisted_57 = { key: 3 }
const _hoisted_58 = ["title"]
const _hoisted_59 = { class: "t" }
const _hoisted_60 = { class: "p" }
const _hoisted_61 = {
class: "w",
style: {"color":"var(--sub)"}
}
const _hoisted_62 = {
key: 1,
style: {"font-size":"var(--fs-11)"}
}
const _hoisted_63 = {
key: 2,
style: {"color":"var(--err)"}
}
const _hoisted_64 = { class: "num" }
const _hoisted_65 = {
key: 1,
title: "平台这次没返回价格，不是 0"
}

export function render(_ctx, _cache) {
return (_openBlock(), _createElementBlock("div", _hoisted_1, [
_createCommentVNode(" 统一页头（全站唯一一份 .phead）：身份 + 说明。动作与上下文这一页用不上，就不留空位。 "),
_cache[27] || (_cache[27] = _createStaticVNode("<header class=\"phead\"><div class=\"phead-id\"><h1 class=\"phead-h1\">用量与余额</h1></div><p class=\"phead-sub\"></p><div class=\"phead-acts\"></div></header>", 1)),
_createElementVNode("div", _hoisted_2, [
_createElementVNode("button", {
class: "ghost",
id: "reload",
style: {"padding":"var(--sp-8) var(--sp-16)"},
disabled: _ctx.reloading,
onClick: _ctx.reloadAll
}, [
_createElementVNode("span", { innerHTML: _ctx.refreshIcon }, null, 8 /* PROPS */, _hoisted_4),
_cache[0] || (_cache[0] = _createTextVNode(" 刷新", -1 /* CACHED */))
], 8 /* PROPS */, _hoisted_3),
_cache[1] || (_cache[1] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
_createElementVNode("span", _hoisted_5, _toDisplayString(_ctx.upd), 1 /* TEXT */)
]),
(_ctx.failed)
? (_openBlock(), _createElementBlock("div", _hoisted_6, [
_createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
_createElementVNode("button", {
class: "ghost mini",
onClick: _ctx.retryLoad
}, "重试", 8 /* PROPS */, _hoisted_7)
]))
: _createCommentVNode("v-if", true),
_createElementVNode("div", _hoisted_8, [
_createElementVNode("div", _hoisted_9, [
_createElementVNode("div", _hoisted_10, [
(_ctx.balanceLoading)
? (_openBlock(), _createElementBlock("div", _hoisted_11, "加载中…"))
: (_ctx.balanceTip)
? (_openBlock(), _createElementBlock("div", {
key: 1,
class: "empty",
style: _normalizeStyle(_ctx.balanceTip.kind === 'warn' ? 'color:var(--warn)' : '')
}, [
(_ctx.balanceTip.kind === 'proxy')
? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
_createTextVNode("代理未启动，跑启动.bat 再刷新。")
], 64 /* STABLE_FRAGMENT */))
: (_ctx.balanceTip.kind === 'warn')
? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
_createTextVNode("代理未启动，跑启动.bat 再刷新。")
], 64 /* STABLE_FRAGMENT */))
: (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
_createTextVNode("还没有配置密钥")
], 64 /* STABLE_FRAGMENT */))
], 4 /* STYLE */))
: _createCommentVNode("v-if", true),
(_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.balanceCards, (b) => {
return (_openBlock(), _createElementBlock("div", {
key: b.kid || b.name,
class: "bal"
}, [
_createElementVNode("div", _hoisted_12, [
_createElementVNode("span", {
class: "ic",
innerHTML: b.ic
}, null, 8 /* PROPS */, _hoisted_13),
_createElementVNode("span", null, _toDisplayString(b.name), 1 /* TEXT */)
]),
_createElementVNode("div", _hoisted_14, [
_createTextVNode(_toDisplayString(b.val), 1 /* TEXT */),
(b.unit)
? (_openBlock(), _createElementBlock("small", _hoisted_15, _toDisplayString(b.unit), 1 /* TEXT */))
: _createCommentVNode("v-if", true)
]),
(b.model && b.val !== '—')
? (_openBlock(), _createElementBlock("div", _hoisted_16, _toDisplayString(b.model), 1 /* TEXT */))
: _createCommentVNode("v-if", true),
_createElementVNode("div", _hoisted_17, _toDisplayString(b.ex || ''), 1 /* TEXT */)
]))
}), 128 /* KEYED_FRAGMENT */))
]),
_createElementVNode("div", _hoisted_18, [
_cache[2] || (_cache[2] = _createElementVNode("h2", null, "近 14 天消费", -1 /* CACHED */)),
_createElementVNode("div", _hoisted_19, null, 512 /* NEED_PATCH */),
_createElementVNode("div", {
id: "chart",
innerHTML: _ctx.chartHtml
}, null, 8 /* PROPS */, _hoisted_20)
]),
_createElementVNode("div", _hoisted_21, [
_cache[11] || (_cache[11] = _createElementVNode("h2", null, "语音用量", -1 /* CACHED */)),
_createElementVNode("div", _hoisted_22, [
(_ctx.voiceStat)
? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
_createElementVNode("div", null, [
_cache[3] || (_cache[3] = _createTextVNode("调用次数", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.count), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[4] || (_cache[4] = _createTextVNode("累计字数", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.chars.toLocaleString()), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[5] || (_cache[5] = _createTextVNode("累计 tokens", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.tokens ? _ctx.voiceStat.tokens.toLocaleString() : '—'), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[6] || (_cache[6] = _createTextVNode("累计时长", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.secs ? _ctx.voiceStat.secs.toFixed(1) + 's' : '—'), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[7] || (_cache[7] = _createTextVNode("平均时长", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.secs && _ctx.voiceStat.count ? (_ctx.voiceStat.secs / _ctx.voiceStat.count).toFixed(1) + 's' : '—'), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[8] || (_cache[8] = _createTextVNode("费用", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.hasCost ? '见账单明细' : '平台未提供价格'), 1 /* TEXT */)
])
], 64 /* STABLE_FRAGMENT */))
: (_ctx.voiceEmpty)
? (_openBlock(), _createElementBlock("div", _hoisted_23, _toDisplayString(_ctx.voiceEmpty), 1 /* TEXT */))
: _createCommentVNode("v-if", true)
]),
_createElementVNode("div", null, [
(_ctx.voiceModelRows.length)
? (_openBlock(), _createElementBlock("table", _hoisted_24, [
_cache[9] || (_cache[9] = _createElementVNode("thead", null, [
_createElementVNode("tr", null, [
_createElementVNode("th", null, "型号 / 音色"),
_createElementVNode("th", null, "次数"),
_createElementVNode("th", null, "字数"),
_createElementVNode("th", null, "tokens"),
_createElementVNode("th", { class: "num" }, "时长")
])
], -1 /* CACHED */)),
_createElementVNode("tbody", null, [
(_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.voiceModelRows, (v, i) => {
return (_openBlock(), _createElementBlock("tr", { key: i }, [
_createElementVNode("td", null, _toDisplayString(v.name), 1 /* TEXT */),
_createElementVNode("td", null, _toDisplayString(v.cnt), 1 /* TEXT */),
_createElementVNode("td", null, _toDisplayString(v.chars.toLocaleString()), 1 /* TEXT */),
_createElementVNode("td", null, _toDisplayString(v.tokens ? v.tokens.toLocaleString() : '—'), 1 /* TEXT */),
_createElementVNode("td", _hoisted_25, _toDisplayString(v.secs ? v.secs.toFixed(1) + 's' : '—'), 1 /* TEXT */)
]))
}), 128 /* KEYED_FRAGMENT */))
])
]))
: _createCommentVNode("v-if", true)
]),
_cache[12] || (_cache[12] = _createElementVNode("h2", { class: "sect-mini" }, "最近生成", -1 /* CACHED */)),
_createElementVNode("div", null, [
(_ctx.voiceRecentRows.length)
? (_openBlock(), _createElementBlock("table", _hoisted_26, [
_cache[10] || (_cache[10] = _createElementVNode("thead", null, [
_createElementVNode("tr", null, [
_createElementVNode("th", null, "时间"),
_createElementVNode("th", { class: "w" }, "内容"),
_createElementVNode("th", null, "时长"),
_createElementVNode("th", { class: "num" }, "tokens")
])
], -1 /* CACHED */)),
_createElementVNode("tbody", null, [
(_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.voiceRecentRows, (r, i) => {
return (_openBlock(), _createElementBlock("tr", {
key: i,
title: r.desc || ''
}, [
_createElementVNode("td", _hoisted_28, _toDisplayString(_ctx.fmtWhen(r.ts) || '—'), 1 /* TEXT */),
_createElementVNode("td", _hoisted_29, _toDisplayString(r.platform || '') + " · " + _toDisplayString((r.desc || '').slice(0, 70)), 1 /* TEXT */),
_createElementVNode("td", null, _toDisplayString(r.duration ? r.duration + 's' : '—'), 1 /* TEXT */),
_createElementVNode("td", _hoisted_30, _toDisplayString(r.tokens ? Number(r.tokens).toLocaleString() : '—'), 1 /* TEXT */)
], 8 /* PROPS */, _hoisted_27))
}), 128 /* KEYED_FRAGMENT */))
])
]))
: _createCommentVNode("v-if", true)
])
]),
_createElementVNode("div", _hoisted_31, [
_cache[20] || (_cache[20] = _createElementVNode("h2", null, "文字 AI 用量", -1 /* CACHED */)),
_createElementVNode("div", _hoisted_32, [
(_ctx.aiStat)
? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
_createElementVNode("div", null, [
_cache[13] || (_cache[13] = _createTextVNode("今日调用", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.aiStat.todayCalls), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[14] || (_cache[14] = _createTextVNode("今日 tokens", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.aiStat.todayTokens.toLocaleString()), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[15] || (_cache[15] = _createTextVNode("累计调用", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.aiStat.totalCalls), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[16] || (_cache[16] = _createTextVNode("累计 tokens", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.aiStat.totalTokens.toLocaleString()), 1 /* TEXT */)
]),
_createElementVNode("div", null, [
_cache[17] || (_cache[17] = _createTextVNode("累计输入 / 输出", -1 /* CACHED */)),
_createElementVNode("b", null, _toDisplayString(_ctx.aiStat.pt.toLocaleString()) + " / " + _toDisplayString(_ctx.aiStat.ct.toLocaleString()), 1 /* TEXT */)
])
], 64 /* STABLE_FRAGMENT */))
: _createCommentVNode("v-if", true)
]),
_createElementVNode("div", _hoisted_33, _toDisplayString(_ctx.aiPriceNote), 1 /* TEXT */),
_createElementVNode("div", null, [
(_ctx.aiModelRows.length)
? (_openBlock(), _createElementBlock("table", _hoisted_34, [
_cache[18] || (_cache[18] = _createElementVNode("thead", null, [
_createElementVNode("tr", null, [
_createElementVNode("th", null, "型号"),
_createElementVNode("th", null, "次数"),
_createElementVNode("th", null, "输入 tokens"),
_createElementVNode("th", null, "输出 tokens"),
_createElementVNode("th", { class: "num" }, "合计 tokens")
])
], -1 /* CACHED */)),
_createElementVNode("tbody", null, [
(_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.aiModelRows, (v, i) => {
return (_openBlock(), _createElementBlock("tr", { key: i }, [
_createElementVNode("td", null, _toDisplayString(v.model), 1 /* TEXT */),
_createElementVNode("td", null, _toDisplayString(v.calls), 1 /* TEXT */),
_createElementVNode("td", null, _toDisplayString(v.pt.toLocaleString()), 1 /* TEXT */),
_createElementVNode("td", null, _toDisplayString(v.ct.toLocaleString()), 1 /* TEXT */),
_createElementVNode("td", _hoisted_35, _toDisplayString((v.pt + v.ct).toLocaleString()), 1 /* TEXT */)
]))
}), 128 /* KEYED_FRAGMENT */))
])
]))
: (_ctx.aiLoaded)
? (_openBlock(), _createElementBlock("div", _hoisted_36, "还没有用量"))
: _createCommentVNode("v-if", true)
]),
_cache[21] || (_cache[21] = _createElementVNode("h2", { class: "sect-mini" }, "按日用量", -1 /* CACHED */)),
_createElementVNode("div", null, [
(_ctx.aiDailyRows.length)
? (_openBlock(), _createElementBlock("table", _hoisted_37, [
_cache[19] || (_cache[19] = _createElementVNode("thead", null, [
_createElementVNode("tr", null, [
_createElementVNode("th", null, "日期"),
_createElementVNode("th", null, "调用次数"),
_createElementVNode("th", { class: "num" }, "tokens")
])
], -1 /* CACHED */)),
_createElementVNode("tbody", null, [
(_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.aiDailyRows, (d, i) => {
return (_openBlock(), _createElementBlock("tr", { key: i }, [
_createElementVNode("td", _hoisted_38, _toDisplayString(d.day), 1 /* TEXT */),
_createElementVNode("td", null, _toDisplayString(d.calls), 1 /* TEXT */),
_createElementVNode("td", _hoisted_39, _toDisplayString(d.tokens.toLocaleString()), 1 /* TEXT */)
]))
}), 128 /* KEYED_FRAGMENT */))
])
]))
: (_ctx.aiLoaded)
? (_openBlock(), _createElementBlock("div", _hoisted_40, "还没有调用记录"))
: _createCommentVNode("v-if", true)
])
])
]),
_createElementVNode("aside", _hoisted_41, [
_createElementVNode("div", _hoisted_42, [
_cache[26] || (_cache[26] = _createElementVNode("h2", null, "账单明细", -1 /* CACHED */)),
_createElementVNode("div", _hoisted_43, [
_createElementVNode("div", _hoisted_44, [
_withDirectives(_createElementVNode("select", {
id: "fPlatform",
ref: "fPlatformEl",
"onUpdate:modelValue": $event => ((_ctx.fPlatform) = $event),
onChange: _ctx.onPlatformChange
}, [
_cache[22] || (_cache[22] = _createElementVNode("option", { value: "" }, "全部平台", -1 /* CACHED */)),
(_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.platformOptions, (p) => {
return (_openBlock(), _createElementBlock("option", {
key: p,
value: p
}, _toDisplayString(p), 9 /* TEXT, PROPS */, _hoisted_46))
}), 128 /* KEYED_FRAGMENT */))
], 40 /* PROPS, NEED_HYDRATION */, _hoisted_45), [
[_vModelSelect, _ctx.fPlatform]
])
]),
_createElementVNode("div", _hoisted_47, [
_withDirectives(_createElementVNode("select", {
id: "fRange",
"onUpdate:modelValue": $event => ((_ctx.fRange) = $event),
onChange: _ctx.onRangeChange
}, [...(_cache[23] || (_cache[23] = [
_createElementVNode("option", { value: "1" }, "今天", -1 /* CACHED */),
_createElementVNode("option", { value: "7" }, "近 7 天", -1 /* CACHED */),
_createElementVNode("option", { value: "30" }, "近 30 天", -1 /* CACHED */),
_createElementVNode("option", { value: "0" }, "全部时间", -1 /* CACHED */)
]))], 40 /* PROPS, NEED_HYDRATION */, _hoisted_48), [
[_vModelSelect, _ctx.fRange]
])
]),
_withDirectives(_createElementVNode("input", {
id: "fQ",
class: "ui-inp",
"onUpdate:modelValue": $event => ((_ctx.fQ) = $event),
onInput: _ctx.onQInput,
placeholder: "搜索提示词 / 型号 / ID…"
}, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_49), [
[_vModelText, _ctx.fQ]
])
]),
_createElementVNode("button", {
class: "ghost",
onClick: _ctx.exportBills
}, [...(_cache[24] || (_cache[24] = [
_createElementVNode("span", {
class: "ic",
"data-icon": "download",
"data-size": "13"
}, null, -1 /* CACHED */),
_createTextVNode(" 导出 CSV", -1 /* CACHED */)
]))], 8 /* PROPS */, _hoisted_50),
_createElementVNode("div", {
onClick: _ctx.onBillNoteClick,
innerHTML: _ctx.billNoteHtml
}, null, 8 /* PROPS */, _hoisted_51),
_createElementVNode("div", _hoisted_52, _toDisplayString(_ctx.billCntText), 1 /* TEXT */),
_createElementVNode("div", _hoisted_53, [
(_ctx.billDownHtml)
? (_openBlock(), _createElementBlock("div", {
key: 0,
innerHTML: _ctx.billDownHtml
}, null, 8 /* PROPS */, _hoisted_54))
: (_ctx.billLoading)
? (_openBlock(), _createElementBlock("div", _hoisted_55, "加载中…"))
: (!_ctx.billRows.length)
? (_openBlock(), _createElementBlock("div", _hoisted_56, "没有账单"))
: (_openBlock(), _createElementBlock("table", _hoisted_57, [
_cache[25] || (_cache[25] = _createElementVNode("thead", null, [
_createElementVNode("tr", null, [
_createElementVNode("th", null, "时间"),
_createElementVNode("th", null, "平台"),
_createElementVNode("th", { class: "w" }, "明细"),
_createElementVNode("th", { class: "num" }, "花费 / 用量")
])
], -1 /* CACHED */)),
_createElementVNode("tbody", null, [
(_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.billRows, (b, i) => {
return (_openBlock(), _createElementBlock("tr", {
key: i,
title: _ctx.billRowTitle(b)
}, [
_createElementVNode("td", _hoisted_59, _toDisplayString(_ctx.fmtWhen(b.ts) || '—'), 1 /* TEXT */),
_createElementVNode("td", _hoisted_60, _toDisplayString(b.platform || ''), 1 /* TEXT */),
_createElementVNode("td", _hoisted_61, [
_createTextVNode(_toDisplayString(b.what), 1 /* TEXT */),
(b.desc)
? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
_createTextVNode(" · " + _toDisplayString(b.descShort), 1 /* TEXT */)
], 64 /* STABLE_FRAGMENT */))
: _createCommentVNode("v-if", true),
(b.genId)
? (_openBlock(), _createElementBlock("code", _hoisted_62, _toDisplayString(b.genShort), 1 /* TEXT */))
: _createCommentVNode("v-if", true),
(b.status && b.status !== 'succeeded')
? (_openBlock(), _createElementBlock("span", _hoisted_63, _toDisplayString(b.status), 1 /* TEXT */))
: _createCommentVNode("v-if", true)
]),
_createElementVNode("td", _hoisted_64, [
(b.tokens != null)
? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
_createTextVNode(_toDisplayString(b.tokens.toLocaleString()) + " tokens", 1 /* TEXT */)
], 64 /* STABLE_FRAGMENT */))
: (b.cost == null)
? (_openBlock(), _createElementBlock("span", _hoisted_65, "平台未提供价格"))
: (b.unit === '元')
? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
_createTextVNode("¥" + _toDisplayString(Number(b.cost).toFixed(4)), 1 /* TEXT */)
], 64 /* STABLE_FRAGMENT */))
: (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
_createTextVNode(_toDisplayString(b.cost) + " " + _toDisplayString(b.unit), 1 /* TEXT */)
], 64 /* STABLE_FRAGMENT */))
])
], 8 /* PROPS */, _hoisted_58))
}), 128 /* KEYED_FRAGMENT */))
])
]))
])
])
])
])
], 512 /* NEED_PATCH */))
}
