/* 身份底层的 ESM 入口。ident.cjs 是全项目唯一的身份判据（UMD，浏览器挂 window.MediaId，
   Node require 同一份）；这里只做转出，不复制正则。
   直接 import 它的 CJS default（= module.exports），不走「先 import 触发副作用、
   再读 globalThis.MediaId」那条路 —— .cjs 在 Node 里走的是 module.exports 分支，
   全局副作用根本不会发生。 */
import MediaId from './ident.cjs';

export const VOLATILE_Q = MediaId.VOLATILE_Q;
export const innerMedia = MediaId.innerMedia;
export const upKeyOf = MediaId.upKeyOf;
export default MediaId;
