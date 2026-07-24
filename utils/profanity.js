// utils/profanity.js — 客户端本地侮辱性言论过滤
//
// 纯 JS、零外部依赖，符合宪章「零留存 / 服务端不接触明文」：
// - 发送端：分片前调用 mask() 脱敏，脏话永不进入信道
// - 接收端：拼图还原后调用 mask() 兜底遮罩，防老版本/被绕过的发送端
//
// 匹配策略：
// - 大小写不敏感；允许词内插入分隔符（空格/标点/符号），应对 "傻 逼"/"傻.逼" 绕过
// - 英文词用 \b 词边界，避免 rat→rate、dog→hotdog、ass→class 式误伤
// - 已剔除会严重误伤正常文本的单字/常见词（操/草/狗/猪/B/比/批/逼/滚/垃圾/乌龟/250/白吃/曹/槽），
//   其脏话用法由合成词覆盖（操→操你妈、草→草泥马、狗→狗娘养的、B→傻B、比→丑比）。

const BAD_WORDS = [
  // —— 罕见单字（仅粗鄙义，低误伤）——
  '肏', '艹', '屄', '屎', '屌',
  // —— 中文合成词 ——
  '肏你妈', '操你妈', 'CNM', '草泥马', '我操你妈', '你妈逼',
  '去你妈的', '去你大爷的', '去尼玛的', '肏你祖宗十八代', '操你祖宗', '你祖宗的',
  '王八蛋', '王八', '忘八', '狗娘养的', '狗养的', '野种', '杂种',
  '傻逼', '煞笔', '傻B', 'SB', '2B', '二逼', '脑残', '脑瘫', '弱智', '白痴',
  '笨蛋', '蠢货', '二百五', '糊涂蛋', '蠢蛋', '丑逼', '丑比', '丑八怪',
  '死胖子', '肥猪', '矮冬瓜', '矬子', '走狗', '狗腿子', '狗崽子', '蠢猪',
  '畜生', '禽兽', '牲口', '人渣', '败类', '骗子', '诈骗犯', '狗骗子',
  '不要脸', '不要逼脸', '厚颜无耻', '贱人', '贱货', '骚货',
  '吃屎', '狗屎', '屁话', '放屁', '胡说八道',
  '鸡巴', 'JB', '屌丝', '肏你', '操你', '我操', '我靠', '我擦',
  '他妈的', 'TMD', '他妈', '特么', '去死吧', '去死', '滚蛋', '滚犊子', '混蛋', '废物',
  // —— 英文（\b 词边界）——
  'fuck', 'fuck you', 'motherfucker', 'mofo', 'mf', 'son of a bitch', 'sob',
  'bastard', 'cunt', 'bitch', 'whore', 'slut', 'cocksucker', 'dick', 'prick',
  'pussy', 'asshole', 'shit', 'bullshit', 'bs', 'piss', 'damn',
  'idiot', 'moron', 'imbecile', 'stupid', 'foolish', 'dumb', 'dense',
  'retard', 'retarded', 'nerd', 'geek', 'dork', 'jackass',
  'pig', 'dog', 'rat', 'beast', 'animal', 'trash', 'garbage', 'scum',
  'ugly', 'fatass', 'shorty', 'midge',
  'fuck off', 'go to hell', 'go to the devil', 'shut the fuck up',
  'you piece of shit', 'eat shit', 'damn you', 'drop dead', 'kiss my ass',
];

// 词内允许插入的分隔符（用于绕过检测）
const SEP_CLASS = '[\\s.,!?_:;~·*_\\-/\\\\]*';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pattern(word) {
  const chars = [...word.toLowerCase()].map(escapeRegExp);
  const inner = chars.join(SEP_CLASS);
  // 英文/数字词加 \b 词边界，避免子串误伤（rat→rate、dog→hotdog）
  return /^[\sa-z0-9]+$/.test(word.toLowerCase()) ? ('\\b' + inner + '\\b') : inner;
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
