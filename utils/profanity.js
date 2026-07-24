// utils/profanity.js — 客户端本地侮辱性言论过滤
//
// 纯 JS、零外部依赖，符合宪章「零留存 / 服务端不接触明文」：
// - 发送端：分片前调用 mask() 脱敏，脏话永不进入信道
// - 接收端：拼图还原后调用 mask() 兜底遮罩，防老版本/被绕过的发送端
//
// 匹配策略：大小写不敏感 + 允许词内插入分隔符（空格/标点/符号），应对 "脏 话"/"脏.话" 绕过。
// 局限：不识别谐音/拼音变体（如"沙雕"），生产可扩展词库或引入轻量拼音匹配。
// 误伤：词库只收明显粗鄙词，避开"垃圾"等有正常用途的词以降低误杀。

const BAD_WORDS = [
  '傻逼', '草泥马', '他妈的', '操你', '滚犊子', '王八蛋',
  '去死吧', '狗屎', '混蛋', '废物', '贱人', '去死',
  'fuck', 'shit', 'bitch', 'damn',
];

// 词内允许插入的分隔符（用于绕过检测）
const SEP_CLASS = '[\\s.,!?_:;~·*_\\-/\\\\]*';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pattern(word) {
  return word.toLowerCase().split('').map(escapeRegExp).join(SEP_CLASS);
}

/** 检测命中的侮辱性词汇列表 */
function findMatches(text) {
  const t = String(text == null ? '' : text);
  const hits = [];
  for (const w of BAD_WORDS) {
    if (new RegExp(pattern(w), 'i').test(t)) hits.push(w);
  }
  return hits;
}

/** 是否含侮辱性词汇 */
function contains(text) {
  return findMatches(text).length > 0;
}

/** 将命中的词汇遮罩为 ***（保留原文其余部分） */
function mask(text) {
  let out = String(text == null ? '' : text);
  for (const w of BAD_WORDS) {
    out = out.replace(new RegExp(pattern(w), 'gi'), '***');
  }
  return out;
}

module.exports = { contains, mask, findMatches, BAD_WORDS };
