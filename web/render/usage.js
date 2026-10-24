/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/usage.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, toDisplayString as _toDisplayString, openBlock as _openBlock, createElementBlock as _createElementBlock, createCommentVNode as _createCommentVNode, Fragment as _Fragment, normalizeStyle as _normalizeStyle, renderList as _renderList, vModelSelect as _vModelSelect, withDirectives as _withDirectives, vModelText as _vModelText } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = {
  class: "page-main usage-page page-shell",
  ref: "rootEl"
}
const _hoisted_2 = { class: "page-h1" }
const _hoisted_3 = ["innerHTML"]
const _hoisted_4 = { class: "bar" }
const _hoisted_5 = ["disabled", "onClick"]
const _hoisted_6 = ["innerHTML"]
const _hoisted_7 = {
  class: "upd",
  id: "upd"
}
const _hoisted_8 = {
  key: 0,
  class: "empty"
}
const _hoisted_9 = ["onClick"]
const _hoisted_10 = { class: "ub-layout" }
const _hoisted_11 = { class: "ub-left" }
const _hoisted_12 = {
  class: "cards",
  id: "balances"
}
const _hoisted_13 = {
  key: 0,
  class: "empty"
}
const _hoisted_14 = { class: "hd" }
const _hoisted_15 = ["innerHTML"]
const _hoisted_16 = { class: "v" }
const _hoisted_17 = { key: 0 }
const _hoisted_18 = {
  key: 0,
  class: "md"
}
const _hoisted_19 = { class: "ex" }
const _hoisted_20 = { class: "panel" }
const _hoisted_21 = {
  class: "chart-units",
  id: "chartUnits",
  ref: "chartUnitsEl"
}
const _hoisted_22 = ["innerHTML"]
const _hoisted_23 = {
  class: "panel",
  id: "voicePanel"
}
const _hoisted_24 = {
  class: "stat",
  id: "voiceStat"
}
const _hoisted_25 = {
  key: 1,
  class: "empty"
}
const _hoisted_26 = { id: "voiceByModel" }
const _hoisted_27 = { key: 0 }
const _hoisted_28 = { class: "num" }
const _hoisted_29 = { id: "voiceRecent" }
const _hoisted_30 = { key: 0 }
const _hoisted_31 = ["title"]
const _hoisted_32 = { class: "t" }
const _hoisted_33 = {
  class: "w",
  style: {"color":"var(--sub)"}
}
const _hoisted_34 = { class: "num" }
const _hoisted_35 = { class: "panel" }
const _hoisted_36 = {
  class: "stat",
  id: "aiStat"
}
const _hoisted_37 = {
  class: "hint",
  id: "aiPriceNote",
  style: {"margin":"var(--sp-2) 0 var(--sp-12)"}
}
const _hoisted_38 = { id: "aiByModel" }
const _hoisted_39 = { key: 0 }
const _hoisted_40 = { class: "num" }
const _hoisted_41 = {
  key: 1,
  class: "empty"
}
const _hoisted_42 = { id: "aiDaily" }
const _hoisted_43 = { key: 0 }
const _hoisted_44 = { class: "t" }
const _hoisted_45 = { class: "num" }
const _hoisted_46 = {
  key: 1,
  class: "empty"
}
const _hoisted_47 = { class: "ub-right" }
const _hoisted_48 = { class: "panel bills-panel" }
const _hoisted_49 = { class: "filters" }
const _hoisted_50 = { class: "ddwrap" }
const _hoisted_51 = ["onUpdate:modelValue", "onChange"]
const _hoisted_52 = ["value"]
const _hoisted_53 = { class: "ddwrap" }
const _hoisted_54 = ["onUpdate:modelValue", "onChange"]
const _hoisted_55 = ["onUpdate:modelValue", "onInput"]
const _hoisted_56 = ["onClick"]
const _hoisted_57 = ["onClick", "innerHTML"]
const _hoisted_58 = {
  class: "upd",
  id: "billCnt",
  style: {"margin-bottom":"var(--sp-8)"}
}
const _hoisted_59 = { id: "bills" }
const _hoisted_60 = ["innerHTML"]
const _hoisted_61 = {
  key: 1,
  class: "empty"
}
const _hoisted_62 = {
  key: 2,
  class: "empty"
}
const _hoisted_63 = { key: 3 }
const _hoisted_64 = ["title"]
const _hoisted_65 = { class: "t" }
const _hoisted_66 = { class: "p" }
const _hoisted_67 = {
  class: "w",
  style: {"color":"var(--sub)"}
}
const _hoisted_68 = {
  key: 1,
  style: {"font-size":"var(--fs-10)"}
}
const _hoisted_69 = {
  key: 2,
  style: {"color":"var(--err)"}
}
const _hoisted_70 = { class: "num" }
const _hoisted_71 = {
  key: 1,
  title: "平台这次没返回价格，不是 0"
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createElementVNode("h1", _hoisted_2, [
      _createElementVNode("span", { innerHTML: _ctx.chartIcon }, null, 8 /* PROPS */, _hoisted_3),
      _cache[0] || (_cache[0] = _createTextVNode(" 用量与余额", -1 /* CACHED */))
    ]),
    _cache[35] || (_cache[35] = _createElementVNode("div", { class: "desc" }, [
      _createTextVNode("只统计"),
      _createElementVNode("b", null, "已配置密钥"),
      _createTextVNode("的平台。生成平台的花费取自接口返回的真实积分/价格；文字 AI 不折算金额，只统计消耗的 tokens。")
    ], -1 /* CACHED */)),
    _createElementVNode("div", _hoisted_4, [
      _createElementVNode("button", {
        class: "ghost",
        id: "reload",
        style: {"padding":"var(--sp-8) var(--sp-15)"},
        disabled: _ctx.reloading,
        onClick: _ctx.reloadAll
      }, [
        _createElementVNode("span", { innerHTML: _ctx.refreshIcon }, null, 8 /* PROPS */, _hoisted_6),
        _cache[1] || (_cache[1] = _createTextVNode(" 刷新", -1 /* CACHED */))
      ], 8 /* PROPS */, _hoisted_5),
      _cache[2] || (_cache[2] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
      _createElementVNode("span", _hoisted_7, _toDisplayString(_ctx.upd), 1 /* TEXT */)
    ]),
    (_ctx.failed)
      ? (_openBlock(), _createElementBlock("div", _hoisted_8, [
          _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ghost mini",
            onClick: _ctx.retryLoad
          }, "重新加载本页", 8 /* PROPS */, _hoisted_9)
        ]))
      : _createCommentVNode("v-if", true),
    _createElementVNode("div", _hoisted_10, [
      _createElementVNode("div", _hoisted_11, [
        _createElementVNode("div", _hoisted_12, [
          (_ctx.balanceLoading)
            ? (_openBlock(), _createElementBlock("div", _hoisted_13, "加载中…"))
            : (_ctx.balanceTip)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 1,
                  class: "empty",
                  style: _normalizeStyle(_ctx.balanceTip.kind === 'warn' ? 'color:var(--warn)' : '')
                }, [
                  (_ctx.balanceTip.kind === 'proxy')
                    ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                        _createTextVNode("读不到本机代理" + _toDisplayString(_ctx.balanceTip.why ? '（' + _ctx.balanceTip.why + '）' : '') + "：这一页的余额、曲线与账单都要问代理，它没起来就什么都取不到。", 1 /* TEXT */),
                        _cache[3] || (_cache[3] = _createElementVNode("br", null, null, -1 /* CACHED */)),
                        _cache[4] || (_cache[4] = _createTextVNode("先跑一次项目目录里的「启动.bat」（或 ", -1 /* CACHED */)),
                        _cache[5] || (_cache[5] = _createElementVNode("code", null, "node proxy.js", -1 /* CACHED */)),
                        _cache[6] || (_cache[6] = _createTextVNode("），再点右上「刷新」。", -1 /* CACHED */))
                      ], 64 /* STABLE_FRAGMENT */))
                    : (_ctx.balanceTip.kind === 'warn')
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _cache[7] || (_cache[7] = _createTextVNode("读不到平台配置：本地代理（proxy.js）可能没在运行。", -1 /* CACHED */)),
                          _cache[8] || (_cache[8] = _createElementVNode("br", null, null, -1 /* CACHED */)),
                          _cache[9] || (_cache[9] = _createTextVNode("请用「启动.bat」启动后点右上角「刷新」。", -1 /* CACHED */))
                        ], 64 /* STABLE_FRAGMENT */))
                      : (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                          _createTextVNode("还没有配置任何平台的密钥，请先到「设置」里填写")
                        ], 64 /* STABLE_FRAGMENT */))
                ], 4 /* STYLE */))
              : _createCommentVNode("v-if", true),
          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.balanceCards, (b) => {
            return (_openBlock(), _createElementBlock("div", {
              key: b.kid || b.name,
              class: "bal"
            }, [
              _createElementVNode("div", _hoisted_14, [
                _createElementVNode("span", {
                  class: "ic",
                  innerHTML: b.ic
                }, null, 8 /* PROPS */, _hoisted_15),
                _createElementVNode("span", null, _toDisplayString(b.name), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_16, [
                _createTextVNode(_toDisplayString(b.val), 1 /* TEXT */),
                (b.unit)
                  ? (_openBlock(), _createElementBlock("small", _hoisted_17, _toDisplayString(b.unit), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true)
              ]),
              (b.model && b.val !== '—')
                ? (_openBlock(), _createElementBlock("div", _hoisted_18, _toDisplayString(b.model), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("div", _hoisted_19, _toDisplayString(b.ex || ''), 1 /* TEXT */)
            ]))
          }), 128 /* KEYED_FRAGMENT */))
        ]),
        _createElementVNode("div", _hoisted_20, [
          _cache[10] || (_cache[10] = _createElementVNode("h2", null, "近 14 天每日消费", -1 /* CACHED */)),
          _createElementVNode("div", _hoisted_21, null, 512 /* NEED_PATCH */),
          _createElementVNode("div", {
            id: "chart",
            innerHTML: _ctx.chartHtml
          }, null, 8 /* PROPS */, _hoisted_22)
        ]),
        _createElementVNode("div", _hoisted_23, [
          _cache[19] || (_cache[19] = _createElementVNode("h2", null, "语音用量", -1 /* CACHED */)),
          _createElementVNode("div", _hoisted_24, [
            (_ctx.voiceStat)
              ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                  _createElementVNode("div", null, [
                    _cache[11] || (_cache[11] = _createTextVNode("调用次数", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.count), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[12] || (_cache[12] = _createTextVNode("累计字数", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.chars.toLocaleString()), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[13] || (_cache[13] = _createTextVNode("累计 tokens", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.tokens ? _ctx.voiceStat.tokens.toLocaleString() : '—'), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[14] || (_cache[14] = _createTextVNode("累计时长", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.secs ? _ctx.voiceStat.secs.toFixed(1) + 's' : '—'), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[15] || (_cache[15] = _createTextVNode("平均时长", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.secs && _ctx.voiceStat.count ? (_ctx.voiceStat.secs / _ctx.voiceStat.count).toFixed(1) + 's' : '—'), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[16] || (_cache[16] = _createTextVNode("费用", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.voiceStat.hasCost ? '见账单明细' : '平台未提供价格'), 1 /* TEXT */)
                  ])
                ], 64 /* STABLE_FRAGMENT */))
              : (_ctx.voiceEmpty)
                ? (_openBlock(), _createElementBlock("div", _hoisted_25, _toDisplayString(_ctx.voiceEmpty), 1 /* TEXT */))
                : _createCommentVNode("v-if", true)
          ]),
          _createElementVNode("div", _hoisted_26, [
            (_ctx.voiceModelRows.length)
              ? (_openBlock(), _createElementBlock("table", _hoisted_27, [
                  _cache[17] || (_cache[17] = _createElementVNode("thead", null, [
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
                        _createElementVNode("td", _hoisted_28, _toDisplayString(v.secs ? v.secs.toFixed(1) + 's' : '—'), 1 /* TEXT */)
                      ]))
                    }), 128 /* KEYED_FRAGMENT */))
                  ])
                ]))
              : _createCommentVNode("v-if", true)
          ]),
          _cache[20] || (_cache[20] = _createElementVNode("h2", { class: "sect-mini" }, "最近生成", -1 /* CACHED */)),
          _createElementVNode("div", _hoisted_29, [
            (_ctx.voiceRecentRows.length)
              ? (_openBlock(), _createElementBlock("table", _hoisted_30, [
                  _cache[18] || (_cache[18] = _createElementVNode("thead", null, [
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
                        _createElementVNode("td", _hoisted_32, _toDisplayString(_ctx.fmtWhen(r.ts) || '—'), 1 /* TEXT */),
                        _createElementVNode("td", _hoisted_33, _toDisplayString(r.platform || '') + " · " + _toDisplayString((r.desc || '').slice(0, 70)), 1 /* TEXT */),
                        _createElementVNode("td", null, _toDisplayString(r.duration ? r.duration + 's' : '—'), 1 /* TEXT */),
                        _createElementVNode("td", _hoisted_34, _toDisplayString(r.tokens ? Number(r.tokens).toLocaleString() : '—'), 1 /* TEXT */)
                      ], 8 /* PROPS */, _hoisted_31))
                    }), 128 /* KEYED_FRAGMENT */))
                  ])
                ]))
              : _createCommentVNode("v-if", true)
          ])
        ]),
        _createElementVNode("div", _hoisted_35, [
          _cache[28] || (_cache[28] = _createElementVNode("h2", null, "文字 AI 用量", -1 /* CACHED */)),
          _createElementVNode("div", _hoisted_36, [
            (_ctx.aiStat)
              ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                  _createElementVNode("div", null, [
                    _cache[21] || (_cache[21] = _createTextVNode("今日调用", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.aiStat.todayCalls), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[22] || (_cache[22] = _createTextVNode("今日 tokens", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.aiStat.todayTokens.toLocaleString()), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[23] || (_cache[23] = _createTextVNode("累计调用", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.aiStat.totalCalls), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[24] || (_cache[24] = _createTextVNode("累计 tokens", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.aiStat.totalTokens.toLocaleString()), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", null, [
                    _cache[25] || (_cache[25] = _createTextVNode("累计输入 / 输出", -1 /* CACHED */)),
                    _createElementVNode("b", null, _toDisplayString(_ctx.aiStat.pt.toLocaleString()) + " / " + _toDisplayString(_ctx.aiStat.ct.toLocaleString()), 1 /* TEXT */)
                  ])
                ], 64 /* STABLE_FRAGMENT */))
              : _createCommentVNode("v-if", true)
          ]),
          _createElementVNode("div", _hoisted_37, _toDisplayString(_ctx.aiPriceNote), 1 /* TEXT */),
          _createElementVNode("div", _hoisted_38, [
            (_ctx.aiModelRows.length)
              ? (_openBlock(), _createElementBlock("table", _hoisted_39, [
                  _cache[26] || (_cache[26] = _createElementVNode("thead", null, [
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
                        _createElementVNode("td", _hoisted_40, _toDisplayString((v.pt + v.ct).toLocaleString()), 1 /* TEXT */)
                      ]))
                    }), 128 /* KEYED_FRAGMENT */))
                  ])
                ]))
              : (_ctx.aiLoaded)
                ? (_openBlock(), _createElementBlock("div", _hoisted_41, "还没有按型号的用量：调用一次文字 AI（润色 / 分镜 / 检索）之后，这里会按型号分开记。"))
                : _createCommentVNode("v-if", true)
          ]),
          _cache[29] || (_cache[29] = _createElementVNode("h2", { class: "sect-mini" }, "按日用量", -1 /* CACHED */)),
          _createElementVNode("div", _hoisted_42, [
            (_ctx.aiDailyRows.length)
              ? (_openBlock(), _createElementBlock("table", _hoisted_43, [
                  _cache[27] || (_cache[27] = _createElementVNode("thead", null, [
                    _createElementVNode("tr", null, [
                      _createElementVNode("th", null, "日期"),
                      _createElementVNode("th", null, "调用次数"),
                      _createElementVNode("th", { class: "num" }, "tokens")
                    ])
                  ], -1 /* CACHED */)),
                  _createElementVNode("tbody", null, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.aiDailyRows, (d, i) => {
                      return (_openBlock(), _createElementBlock("tr", { key: i }, [
                        _createElementVNode("td", _hoisted_44, _toDisplayString(d.day), 1 /* TEXT */),
                        _createElementVNode("td", null, _toDisplayString(d.calls), 1 /* TEXT */),
                        _createElementVNode("td", _hoisted_45, _toDisplayString(d.tokens.toLocaleString()), 1 /* TEXT */)
                      ]))
                    }), 128 /* KEYED_FRAGMENT */))
                  ])
                ]))
              : (_ctx.aiLoaded)
                ? (_openBlock(), _createElementBlock("div", _hoisted_46, "还没有文字 AI 调用记录：用文字 AI 润色或分镜之后，这里会按天记下次数与 tokens。"))
                : _createCommentVNode("v-if", true)
          ])
        ])
      ]),
      _createElementVNode("aside", _hoisted_47, [
        _createElementVNode("div", _hoisted_48, [
          _cache[34] || (_cache[34] = _createElementVNode("h2", null, "账单明细", -1 /* CACHED */)),
          _createElementVNode("div", _hoisted_49, [
            _createElementVNode("div", _hoisted_50, [
              _withDirectives(_createElementVNode("select", {
                id: "fPlatform",
                ref: "fPlatformEl",
                "onUpdate:modelValue": $event => ((_ctx.fPlatform) = $event),
                onChange: _ctx.onPlatformChange
              }, [
                _cache[30] || (_cache[30] = _createElementVNode("option", { value: "" }, "全部平台", -1 /* CACHED */)),
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.platformOptions, (p) => {
                  return (_openBlock(), _createElementBlock("option", {
                    key: p,
                    value: p
                  }, _toDisplayString(p), 9 /* TEXT, PROPS */, _hoisted_52))
                }), 128 /* KEYED_FRAGMENT */))
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_51), [
                [_vModelSelect, _ctx.fPlatform]
              ])
            ]),
            _createElementVNode("div", _hoisted_53, [
              _withDirectives(_createElementVNode("select", {
                id: "fRange",
                "onUpdate:modelValue": $event => ((_ctx.fRange) = $event),
                onChange: _ctx.onRangeChange
              }, [...(_cache[31] || (_cache[31] = [
                _createElementVNode("option", { value: "1" }, "今天", -1 /* CACHED */),
                _createElementVNode("option", { value: "7" }, "近 7 天", -1 /* CACHED */),
                _createElementVNode("option", { value: "30" }, "近 30 天", -1 /* CACHED */),
                _createElementVNode("option", { value: "0" }, "全部时间", -1 /* CACHED */)
              ]))], 40 /* PROPS, NEED_HYDRATION */, _hoisted_54), [
                [_vModelSelect, _ctx.fRange]
              ])
            ]),
            _withDirectives(_createElementVNode("input", {
              id: "fQ",
              "onUpdate:modelValue": $event => ((_ctx.fQ) = $event),
              onInput: _ctx.onQInput,
              placeholder: "搜索提示词 / 型号 / ID…"
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_55), [
              [_vModelText, _ctx.fQ]
            ])
          ]),
          _createElementVNode("button", {
            class: "ghost",
            id: "expBills",
            title: "把当前筛选出的账单导出成 CSV（Excel 可直接打开）",
            onClick: _ctx.exportBills
          }, [...(_cache[32] || (_cache[32] = [
            _createElementVNode("span", {
              class: "ic",
              "data-icon": "download",
              "data-size": "13"
            }, null, -1 /* CACHED */),
            _createTextVNode(" 导出 CSV", -1 /* CACHED */)
          ]))], 8 /* PROPS */, _hoisted_56),
          _createElementVNode("div", {
            id: "billNote",
            onClick: _ctx.onBillNoteClick,
            innerHTML: _ctx.billNoteHtml
          }, null, 8 /* PROPS */, _hoisted_57),
          _createElementVNode("div", _hoisted_58, _toDisplayString(_ctx.billCntText), 1 /* TEXT */),
          _createElementVNode("div", _hoisted_59, [
            (_ctx.billDownHtml)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 0,
                  innerHTML: _ctx.billDownHtml
                }, null, 8 /* PROPS */, _hoisted_60))
              : (_ctx.billLoading)
                ? (_openBlock(), _createElementBlock("div", _hoisted_61, "加载中…"))
                : (!_ctx.billRows.length)
                  ? (_openBlock(), _createElementBlock("div", _hoisted_62, "这个筛选下没有账单：把时间范围放宽或换个平台看看；一条都没有的话，多半是还没在「设置」里填平台密钥。"))
                  : (_openBlock(), _createElementBlock("table", _hoisted_63, [
                      _cache[33] || (_cache[33] = _createElementVNode("thead", null, [
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
                            _createElementVNode("td", _hoisted_65, _toDisplayString(_ctx.fmtWhen(b.ts) || '—'), 1 /* TEXT */),
                            _createElementVNode("td", _hoisted_66, _toDisplayString(b.platform || ''), 1 /* TEXT */),
                            _createElementVNode("td", _hoisted_67, [
                              _createTextVNode(_toDisplayString(b.what), 1 /* TEXT */),
                              (b.desc)
                                ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                                    _createTextVNode(" · " + _toDisplayString(b.descShort), 1 /* TEXT */)
                                  ], 64 /* STABLE_FRAGMENT */))
                                : _createCommentVNode("v-if", true),
                              (b.genId)
                                ? (_openBlock(), _createElementBlock("code", _hoisted_68, _toDisplayString(b.genShort), 1 /* TEXT */))
                                : _createCommentVNode("v-if", true),
                              (b.status && b.status !== 'succeeded')
                                ? (_openBlock(), _createElementBlock("span", _hoisted_69, _toDisplayString(b.status), 1 /* TEXT */))
                                : _createCommentVNode("v-if", true)
                            ]),
                            _createElementVNode("td", _hoisted_70, [
                              (b.tokens != null)
                                ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                                    _createTextVNode(_toDisplayString(b.tokens.toLocaleString()) + " tokens", 1 /* TEXT */)
                                  ], 64 /* STABLE_FRAGMENT */))
                                : (b.cost == null)
                                  ? (_openBlock(), _createElementBlock("span", _hoisted_71, "平台未提供价格"))
                                  : (b.unit === '元')
                                    ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                                        _createTextVNode("¥" + _toDisplayString(Number(b.cost).toFixed(4)), 1 /* TEXT */)
                                      ], 64 /* STABLE_FRAGMENT */))
                                    : (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                                        _createTextVNode(_toDisplayString(b.cost) + " " + _toDisplayString(b.unit), 1 /* TEXT */)
                                      ], 64 /* STABLE_FRAGMENT */))
                            ])
                          ], 8 /* PROPS */, _hoisted_64))
                        }), 128 /* KEYED_FRAGMENT */))
                      ])
                    ]))
          ])
        ])
      ])
    ])
  ], 512 /* NEED_PATCH */))
}
