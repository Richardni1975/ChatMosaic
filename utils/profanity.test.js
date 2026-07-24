// utils/profanity.test.js — 侮辱性言论过滤单测
// 运行：node utils/profanity.test.js（已并入 npm test）

const { contains, mask, findMatches } = require('./profanity.js');

const results = [];
function assert(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
}

/* ---------- 检测 ---------- */
assert('命中中文粗鄙词', contains('你真是个傻逼'), '');
assert('命中英文词（大小写不敏感）', contains('What the FUCK'), '');
assert('正常文本不命中', !contains('今天天气不错'), '');
assert('空文本不命中', !contains(''), '');
assert('词内插分隔符仍命中（脏 话）', contains('你 真 是 傻 逼'), '');
assert('词内插标点仍命中（脏.话）', contains('傻.逼'), '');
assert('findMatches 返回命中的词', findMatches('fuck and 傻逼').length === 2, '');

/* ---------- 遮罩 ---------- */
assert('遮罩中文词', mask('你真傻逼啊') === '你真***啊', '得到:' + mask('你真傻逼啊'));
assert('遮罩英文词（大小写不敏感）', mask('FUCK you') === '*** you', '得到:' + mask('FUCK you'));
assert('遮罩分隔变体', mask('傻 . 逼') === '***', '得到:' + mask('傻 . 逼'));
assert('遮罩多处', mask('傻逼和bitch') === '***和***', '得到:' + mask('傻逼和bitch'));
assert('正常文本遮罩后不变', mask('今天天气不错') === '今天天气不错', '');
assert('遮罩幂等（再遮一次不变）', mask(mask('你傻逼')) === mask('你傻逼'), '');
assert('不误伤正常词（垃圾分类）', !contains('垃圾分类'), '');
assert('词库项废物会被遮罩', mask('真废物') === '真***', '得到:' + mask('真废物'));

/* ---------- 扩充词库 ---------- */
assert('命中脑残', contains('你个脑残'), '');
assert('命中骗子', contains('他是个骗子'), '');
assert('命中英文 asshole（\\b）', contains('you asshole'), '');
assert('命中英文大小写 Damn', contains('damn it'), '');
assert('扩充词遮罩', mask('你脑残吧') === '你***吧', '得到:' + mask('你脑残吧'));
assert('英文遮罩', mask('you are an idiot') === 'you are an ***', '得到:' + mask('you are an idiot'));

/* ---------- 剔除单字/常见词后不误伤 ---------- */
assert('不误伤草莓（草已剔除）', !contains('草莓蛋糕'), '');
assert('不误伤比赛（比已剔除）', !contains('比赛开始了'), '');
assert('不误伤操场（操已剔除）', !contains('在操场上跑步'), '');
assert('不误伤热狗（狗已剔除）', !contains('吃热狗'), '');
assert('不误伤 250 元（250 已剔除）', !contains('这件 250 元'), '');
assert('英文 \\b 不误伤 rate（rat 已加词边界）', !contains('the rate is high'), '');
assert('英文 \\b 不误伤 hotdog（dog 词边界）', !contains('a hotdog'), '');

/* ---------- 汇总 ---------- */
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`[profanity.test] 通过 ${passed}/${results.length}` + (failed ? `，失败 ${failed}` : ' ✅'));
results.forEach((r) => { if (!r.pass) console.log('  ✗', r.name, r.detail ? '— ' + r.detail : ''); });
if (failed) process.exit(1);
