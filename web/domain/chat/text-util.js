/* 对话层的两个纯函数：token 估算与密钥脱敏。
   聊天发送路径只读这一份；上下文压缩由 `web/features/chat.js` 的查询结果预算使用它。 */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0, ascii = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 128) ascii++;
    else cjk++;
  }
  return Math.ceil(cjk + ascii / 4);
}

export function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, 'sk_***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}\b/gi, 'Bearer ***')
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._~+\/=-]{12,}/gi, '$1$2***')
    .replace(/((?:api[_-]?key|secret|password)\s*[:=]\s*)[^\s,;'"]{6,}/gi, '$1***');
}
