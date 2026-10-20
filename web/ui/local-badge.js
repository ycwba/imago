/* 本机 / 云端 / 本机+云端 徽标（唯一组件）。state 来自 AssetLocal.stateOf(entry)。 */
import { h } from '../../vue.runtime.esm-browser.prod.js';
import { badgeOf } from './badge-state.js';

export const meta = {
  name: 'LocalBadge',
  props: { state: { type: Object, default: () => ({}) }, show: { type: Boolean, default: true } },
  slots: [],
  events: [],
  description: '本机 / 云端 / 本机+云端状态徽标',
};

export default {
  name: 'LocalBadge',
  props: meta.props,
  setup(props) {
    return () => {
      const b = badgeOf(props.state, props.show);
      if (!b.show) return null;
      return h('span', { class: 'srcbadge ' + b.cls, title: b.why }, b.label);
    };
  },
};
