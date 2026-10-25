/* 生成文件：由 tools/precompile-vue.cjs 从 tools/vue-templates/favorites.html 编译，别手改。 */
import { createElementVNode as _createElementVNode, createTextVNode as _createTextVNode, createCommentVNode as _createCommentVNode, normalizeClass as _normalizeClass, toDisplayString as _toDisplayString, vShow as _vShow, withDirectives as _withDirectives, openBlock as _openBlock, createElementBlock as _createElementBlock, renderList as _renderList, Fragment as _Fragment, withModifiers as _withModifiers, normalizeStyle as _normalizeStyle } from "../../vue.runtime.esm-browser.prod.js"

const _hoisted_1 = { class: "page-main fav-page page-shell" }
const _hoisted_2 = { class: "page-h1" }
const _hoisted_3 = ["innerHTML"]
const _hoisted_4 = {
  class: "toolbar",
  ref: "toolbarEl"
}
const _hoisted_5 = { class: "fav-filters" }
const _hoisted_6 = { class: "fav-sel" }
const _hoisted_7 = {
  class: "ui-inp",
  id: "favProv",
  ref: "favProvEl",
  "aria-label": "按平台筛选"
}
const _hoisted_8 = { class: "fav-sel" }
const _hoisted_9 = {
  class: "ui-inp",
  id: "favTime",
  ref: "favTimeEl",
  "aria-label": "按收藏时间筛选"
}
const _hoisted_10 = {
  class: "viewtoggle",
  ref: "viewEl"
}
const _hoisted_11 = ["onClick"]
const _hoisted_12 = ["onClick"]
const _hoisted_13 = ["disabled", "onClick", "innerHTML"]
const _hoisted_14 = ["onChange"]
const _hoisted_15 = {
  class: "bulkbar",
  id: "bulkBar"
}
const _hoisted_16 = {
  class: "bk-cnt",
  id: "bulkCnt"
}
const _hoisted_17 = ["disabled", "onClick"]
const _hoisted_18 = ["onClick"]
const _hoisted_19 = ["disabled", "onClick"]
const _hoisted_20 = ["disabled", "onClick"]
const _hoisted_21 = {
  class: "bk-tip",
  id: "bulkTip"
}
const _hoisted_22 = ["onClick"]
const _hoisted_23 = {
  key: 0,
  class: "empty"
}
const _hoisted_24 = ["onClick"]
const _hoisted_25 = {
  key: 1,
  class: "empty"
}
const _hoisted_26 = {
  key: 0,
  class: "empty"
}
const _hoisted_27 = { class: "fav-row" }
const _hoisted_28 = ["data-key", "onDragstart", "onDragend"]
const _hoisted_29 = ["aria-checked", "onClick", "onKeydown"]
const _hoisted_30 = ["onClick", "innerHTML"]
const _hoisted_31 = { class: "body card-shell-body" }
const _hoisted_32 = { class: "note" }
const _hoisted_33 = ["value", "onInput", "onBlur", "onClick"]
const _hoisted_34 = ["onClick"]
const _hoisted_35 = { class: "m" }
const _hoisted_36 = { class: "acts card-shell-actions" }
const _hoisted_37 = ["title", "onClick"]
const _hoisted_38 = ["disabled", "onClick"]
const _hoisted_39 = ["onClick"]
const _hoisted_40 = ["onClick"]
const _hoisted_41 = { class: "exp" }
const _hoisted_42 = { class: "exp-in" }
const _hoisted_43 = { class: "exp-body" }
const _hoisted_44 = { class: "exp-acts" }
const _hoisted_45 = ["onClick"]
const _hoisted_46 = ["disabled", "onClick"]
const _hoisted_47 = ["onClick"]
const _hoisted_48 = ["data-for"]
const _hoisted_49 = { class: "band-in" }
const _hoisted_50 = { class: "band-hd" }
const _hoisted_51 = { class: "t" }
const _hoisted_52 = ["onClick"]
const _hoisted_53 = { class: "exp-acts" }
const _hoisted_54 = ["onClick"]
const _hoisted_55 = ["disabled", "onClick"]
const _hoisted_56 = ["onClick"]
const _hoisted_57 = {
  id: "gridEnd",
  ref: "gridEnd",
  style: {"height":"1px"}
}

export function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createElementVNode("h1", _hoisted_2, [
      _createElementVNode("span", { innerHTML: _ctx.starIcon }, null, 8 /* PROPS */, _hoisted_3),
      _cache[0] || (_cache[0] = _createTextVNode("我的收藏", -1 /* CACHED */))
    ]),
    _createCommentVNode(" 筛选行：类型（带条数）+ 搜索 + AI 找素材（公共件 Wb.filterBar） "),
    _createElementVNode("div", _hoisted_4, null, 512 /* NEED_PATCH */),
    _createCommentVNode(" 平台 + 时间（与资产库一样的两种）+ 摆法 "),
    _createElementVNode("div", _hoisted_5, [
      _createElementVNode("label", _hoisted_6, [
        _cache[1] || (_cache[1] = _createElementVNode("span", null, "平台", -1 /* CACHED */)),
        _createElementVNode("select", _hoisted_7, null, 512 /* NEED_PATCH */)
      ]),
      _createElementVNode("label", _hoisted_8, [
        _cache[3] || (_cache[3] = _createElementVNode("span", null, "时间", -1 /* CACHED */)),
        _createElementVNode("select", _hoisted_9, [...(_cache[2] || (_cache[2] = [
          _createElementVNode("option", { value: "0" }, "全部时间", -1 /* CACHED */),
          _createElementVNode("option", { value: "1" }, "今天", -1 /* CACHED */),
          _createElementVNode("option", { value: "7" }, "近 7 天", -1 /* CACHED */),
          _createElementVNode("option", { value: "30" }, "近 30 天", -1 /* CACHED */)
        ]))], 512 /* NEED_PATCH */)
      ]),
      _cache[5] || (_cache[5] = _createElementVNode("span", {
        class: "sp",
        style: {"flex":"1"}
      }, null, -1 /* CACHED */)),
      _createElementVNode("span", _hoisted_10, null, 512 /* NEED_PATCH */),
      _createElementVNode("button", {
        class: "ghost",
        ref: "pullBtn",
        onClick: _ctx.pullLocal,
        title: "把当前筛选里「本机还没有那份字节」的收藏存回本机"
      }, null, 8 /* PROPS */, _hoisted_11),
      _createElementVNode("button", {
        class: _normalizeClass(["ghost", { active: _ctx.multiMode }]),
        id: "multiBtn",
        title: "进入多选：点卡片勾选，可批量下载、移出收藏",
        onClick: _ctx.toggleMulti
      }, [...(_cache[4] || (_cache[4] = [
        _createElementVNode("span", {
          "data-icon": "checkBox",
          "data-size": "13"
        }, null, -1 /* CACHED */),
        _createTextVNode(" 多选", -1 /* CACHED */)
      ]))], 10 /* CLASS, PROPS */, _hoisted_12),
      _createElementVNode("button", {
        class: "ghost",
        disabled: _ctx.uploading,
        onClick: _ctx.pickFiles,
        innerHTML: _ctx.uploadHtml
      }, null, 8 /* PROPS */, _hoisted_13),
      _createElementVNode("input", {
        type: "file",
        multiple: "",
        hidden: "",
        ref: "fileEl",
        onChange: _ctx.onFiles
      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_14)
    ]),
    _createCommentVNode(" 多选条：与资产库同一套公共件（.bulkbar）。「移出收藏」这种破坏性动作\n           收在这一行里，不在每张卡上喊。 "),
    _withDirectives(_createElementVNode("div", _hoisted_15, [
      _createElementVNode("span", _hoisted_16, _toDisplayString(_ctx.bulkCountText), 1 /* TEXT */),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkAll",
        disabled: _ctx.bulkAllDisabled,
        onClick: _ctx.bulkAll
      }, _toDisplayString(_ctx.bulkAllText), 9 /* TEXT, PROPS */, _hoisted_17),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkClear",
        onClick: _ctx.bulkClear
      }, "取消选择", 8 /* PROPS */, _hoisted_18),
      _createElementVNode("button", {
        class: "ghost",
        id: "bulkDown",
        disabled: _ctx.bulkDownDisabled,
        onClick: _ctx.bulkDownload
      }, [...(_cache[6] || (_cache[6] = [
        _createElementVNode("span", {
          "data-icon": "download",
          "data-size": "13"
        }, null, -1 /* CACHED */),
        _createTextVNode(" 批量下载", -1 /* CACHED */)
      ]))], 8 /* PROPS */, _hoisted_19),
      _createElementVNode("button", {
        class: "ghost danger",
        id: "bulkDrop",
        disabled: _ctx.bulkFavRemoveDisabled,
        onClick: _ctx.bulkDrop
      }, [...(_cache[7] || (_cache[7] = [
        _createElementVNode("span", {
          "data-icon": "starFill",
          "data-size": "13"
        }, null, -1 /* CACHED */),
        _createTextVNode(" 取消收藏", -1 /* CACHED */)
      ]))], 8 /* PROPS */, _hoisted_20),
      _createElementVNode("span", _hoisted_21, _toDisplayString(_ctx.bulkTipText), 1 /* TEXT */),
      _cache[8] || (_cache[8] = _createElementVNode("span", {
        class: "sp",
        style: {"flex":"1"}
      }, null, -1 /* CACHED */)),
      _createElementVNode("button", {
        class: "ghost",
        id: "multiExit",
        onClick: _ctx.exitMulti
      }, "退出多选", 8 /* PROPS */, _hoisted_22)
    ], 512 /* NEED_PATCH */), [
      [_vShow, _ctx.multiMode]
    ]),
    (_ctx.failed)
      ? (_openBlock(), _createElementBlock("div", _hoisted_23, [
          _createTextVNode(_toDisplayString(_ctx.failed) + " ", 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ghost mini",
            onClick: _ctx.retryLoad
          }, "重新加载本页", 8 /* PROPS */, _hoisted_24)
        ]))
      : (!_ctx.ready)
        ? (_openBlock(), _createElementBlock("div", _hoisted_25, [...(_cache[9] || (_cache[9] = [
            _createElementVNode("span", { class: "spin-dot" }, null, -1 /* CACHED */),
            _createTextVNode(" 正在读取收藏…", -1 /* CACHED */)
          ]))]))
        : (_openBlock(), _createElementBlock("div", {
            key: 2,
            class: _normalizeClass(["grid", 'view-' + _ctx.view]),
            ref: "grids"
          }, [
            (!_ctx.viewItems.length)
              ? (_openBlock(), _createElementBlock("div", _hoisted_26, _toDisplayString(_ctx.emptyWhy), 1 /* TEXT */))
              : _createCommentVNode("v-if", true),
            _createCommentVNode(" 显式分行：紧凑档（网格）里展开的内容要插在**它那一行的下面**，\n             格子长高会把同一行别的格子底下留出空洞 —— 网格最怕这种。\n             清单档一行一条，不需要分组。 "),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.rows, (row, ri) => {
              return (_openBlock(), _createElementBlock(_Fragment, {
                key: 'r' + ri
              }, [
                _createElementVNode("div", _hoisted_27, [
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(row, (it) => {
                    return (_openBlock(), _createElementBlock("div", {
                      key: it.key,
                      class: _normalizeClass(["card card-surface fav-card", { 'is-open': _ctx.openKey === it.key }]),
                      draggable: "true",
                      "data-key": it.key,
                      onDragstart: $event => (_ctx.onCardDragStart($event, it)),
                      onDragend: $event => (_ctx.onCardDragEnd($event))
                    }, [
                      _createCommentVNode(" 多选框：与资产库同一件（.pick），勾选后走批量条 "),
                      (_ctx.multiMode)
                        ? (_openBlock(), _createElementBlock("div", {
                            key: 0,
                            class: _normalizeClass(["pick", { on: _ctx.favPicked(it) }]),
                            role: "checkbox",
                            tabindex: "0",
                            "aria-checked": _ctx.favPicked(it) ? 'true' : 'false',
                            "aria-label": "勾选这条（批量下载 / 移出收藏）",
                            onClick: _withModifiers($event => (_ctx.togglePick(it)), ["stop"]),
                            onKeydown: $event => (_ctx.onPickKey($event, it))
                          }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_29))
                        : _createCommentVNode("v-if", true),
                      _createElementVNode("div", {
                        class: "thumb card-shell-media",
                        onClick: $event => (_ctx.openLb(it)),
                        innerHTML: _ctx.thumbHtml(it)
                      }, null, 8 /* PROPS */, _hoisted_30),
                      _createElementVNode("div", _hoisted_31, [
                        _createCommentVNode(" 备注在这一页最要紧（产品自己的 AI 挑素材规则：备注 > 名称 > 类型），\n                     所以它在标题**上面**，做成一条带子；没写的留一条虚线空位。 "),
                        _createElementVNode("div", _hoisted_32, [
                          _createElementVNode("textarea", {
                            value: it.note || '',
                            rows: "1",
                            onInput: $event => (_ctx.onNote(it, $event)),
                            onBlur: $event => (_ctx.flushNote(it)),
                            onClick: _withModifiers(() => {}, ["stop"]),
                            placeholder: "＋ 写备注（这条素材是干什么用的）"
                          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_33)
                        ]),
                        _createElementVNode("div", {
                          class: "t",
                          onClick: $event => (_ctx.openLb(it))
                        }, _toDisplayString(_ctx.titleOf(it)), 9 /* TEXT, PROPS */, _hoisted_34),
                        _createElementVNode("div", _hoisted_35, _toDisplayString(_ctx.metaOf(it)), 1 /* TEXT */),
                        _createElementVNode("div", _hoisted_36, [
                          (_ctx.canReuse(it))
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 0,
                                class: "ghost",
                                title: '带着这条素材去' + _ctx.reuseTabZh(it.type) + '那一栏',
                                onClick: _withModifiers($event => (_ctx.reuse(it)), ["stop"])
                              }, "复用", 8 /* PROPS */, _hoisted_37))
                            : _createCommentVNode("v-if", true),
                          _createElementVNode("button", {
                            class: "ghost",
                            disabled: !!_ctx.dlBusy[it.key],
                            onClick: _withModifiers($event => (_ctx.download(it)), ["stop"])
                          }, _toDisplayString(_ctx.dlMsg[it.key] || '下载'), 9 /* TEXT, PROPS */, _hoisted_38),
                          _createElementVNode("button", {
                            class: "ghost fav-open",
                            onClick: _withModifiers($event => (_ctx.toggleFavDetail(it)), ["stop"])
                          }, _toDisplayString(_ctx.openKey === it.key ? '收起' : '详情'), 9 /* TEXT, PROPS */, _hoisted_39),
                          _createCommentVNode(" 移出收藏：卡面上就有一颗（用户要的就是「看得见、点得到」）。\n                       展开区里那一颗是同一件事的另一个入口，不是第二套实现。 "),
                          _createElementVNode("button", {
                            class: "ghost danger fav-drop",
                            onClick: _withModifiers($event => (_ctx.dropItem(it)), ["stop"])
                          }, "移出收藏", 8 /* PROPS */, _hoisted_40)
                        ]),
                        _createCommentVNode(" 详情就地展开（公共件 .exp）：清单档里那张卡自己长高，\n                     紧凑档里它落在下面那条带子上（.band）。 "),
                        _createElementVNode("div", _hoisted_41, [
                          _createElementVNode("div", _hoisted_42, [
                            _createElementVNode("div", _hoisted_43, [
                              _cache[11] || (_cache[11] = _createElementVNode("div", { class: "cdet" }, null, -1 /* CACHED */)),
                              _createElementVNode("div", _hoisted_44, [
                                (_ctx.canReuse(it))
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 0,
                                      class: "ghost",
                                      onClick: _withModifiers($event => (_ctx.reuse(it)), ["stop"])
                                    }, "复用", 8 /* PROPS */, _hoisted_45))
                                  : _createCommentVNode("v-if", true),
                                _createElementVNode("button", {
                                  class: "ghost",
                                  disabled: !!_ctx.dlBusy[it.key],
                                  onClick: _withModifiers($event => (_ctx.download(it)), ["stop"])
                                }, _toDisplayString(_ctx.dlMsg[it.key] || '下载'), 9 /* TEXT, PROPS */, _hoisted_46),
                                _cache[10] || (_cache[10] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
                                _createElementVNode("button", {
                                  class: "ghost danger",
                                  onClick: _withModifiers($event => (_ctx.dropItem(it)), ["stop"])
                                }, "移出收藏", 8 /* PROPS */, _hoisted_47)
                              ])
                            ])
                          ])
                        ])
                      ])
                    ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_28))
                  }), 128 /* KEYED_FRAGMENT */))
                ]),
                _createCommentVNode(" 紧凑档的展开带子：整行宽，插在它那一行的下面，一根连线指回那个格子 "),
                (_ctx.bandItem(row))
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "band",
                      "data-for": _ctx.bandItem(row).key
                    }, [
                      _cache[15] || (_cache[15] = _createElementVNode("span", { class: "band-tether" }, null, -1 /* CACHED */)),
                      _createElementVNode("div", _hoisted_49, [
                        _createElementVNode("div", _hoisted_50, [
                          _createElementVNode("span", _hoisted_51, _toDisplayString(_ctx.bandItem(row).prompt || _ctx.bandItem(row).name), 1 /* TEXT */),
                          _cache[12] || (_cache[12] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
                          _createElementVNode("button", {
                            class: "ghost fav-open",
                            onClick: _withModifiers(_ctx.closeDetail, ["stop"])
                          }, "收起", 8 /* PROPS */, _hoisted_52)
                        ]),
                        _cache[14] || (_cache[14] = _createElementVNode("div", { class: "cdet" }, null, -1 /* CACHED */)),
                        _createElementVNode("div", _hoisted_53, [
                          (_ctx.canReuse(_ctx.bandItem(row)))
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 0,
                                class: "ghost",
                                onClick: _withModifiers($event => (_ctx.reuse(_ctx.bandItem(row))), ["stop"])
                              }, "复用", 8 /* PROPS */, _hoisted_54))
                            : _createCommentVNode("v-if", true),
                          _createElementVNode("button", {
                            class: "ghost",
                            disabled: !!_ctx.dlBusy[_ctx.bandItem(row).key],
                            onClick: _withModifiers($event => (_ctx.download(_ctx.bandItem(row))), ["stop"])
                          }, _toDisplayString(_ctx.dlMsg[_ctx.bandItem(row).key] || '下载'), 9 /* TEXT, PROPS */, _hoisted_55),
                          _cache[13] || (_cache[13] = _createElementVNode("span", { class: "sp" }, null, -1 /* CACHED */)),
                          _createElementVNode("button", {
                            class: "ghost danger",
                            onClick: _withModifiers($event => (_ctx.dropItem(_ctx.bandItem(row))), ["stop"])
                          }, "移出收藏", 8 /* PROPS */, _hoisted_56)
                        ])
                      ])
                    ], 8 /* PROPS */, _hoisted_48))
                  : _createCommentVNode("v-if", true)
              ], 64 /* STABLE_FRAGMENT */))
            }), 128 /* KEYED_FRAGMENT */))
          ], 2 /* CLASS */)),
    _createElementVNode("div", _hoisted_57, null, 512 /* NEED_PATCH */),
    _createElementVNode("div", {
      class: "pager-row",
      id: "pagerRow",
      ref: "pagerRow",
      style: _normalizeStyle({ display: _ctx.pagerVisible ? '' : 'none' })
    }, null, 4 /* STYLE */)
  ]))
}
