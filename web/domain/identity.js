/* 身份底层的 ESM 入口。ident.js 是全项目唯一的身份判据（UMD，浏览器挂 window.MediaId，
   Node require 同一份）；这里只做转出，不复制正则。 */
import './ident.js';

export const MediaId = (typeof globalThis !== 'undefined' && globalThis.MediaId);
export const VOLATILE_Q = MediaId.VOLATILE_Q;
export const innerMedia = MediaId.innerMedia;
export const upKeyOf = MediaId.upKeyOf;
export default MediaId;
