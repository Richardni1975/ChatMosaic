// utils/crypto.test.js
// Phase 2 单元测试：验证 XOR 4-of-4 分片 → 重组可 100% 还原原文，
// 并覆盖 matchHash 一致性、碎片不可读性、篡改/不匹配检测。
//
// 运行方式（微信开发者工具控制台）：
//   const t = require('../../utils/crypto.test.js'); t.runTests();
// 或在页面 onLoad 临时调用 require('../../utils/crypto.test.js').runTests();

const crypto = require('./crypto.js');

/* ---------- 断言工具 ---------- */

function assert(name, cond, detail) {
  return { name, pass: !!cond, detail: detail || '' };
}

/** 对 3 个 hex 字符串做逐字节异或，返回 hex（用于"任取三路不应还原明文"的不可读性验证）。 */
function xorHex3(a, b, c) {
  const len = a.length / 2;
  let out = '';
  for (let i = 0; i < len; i++) {
    const v = parseInt(a.substr(i * 2, 2), 16)
      ^ parseInt(b.substr(i * 2, 2), 16)
      ^ parseInt(c.substr(i * 2, 2), 16);
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

/* ---------- 主测试入口 ---------- */

function runTests() {
  const results = [];

  /* 1. 多语种 / 边界文本往返还原 */
  const cases = [
    { name: '空字符串', text: '' },
    { name: '纯 ASCII', text: 'hello world' },
    { name: '中文短句', text: '熟人匿名决策，说出真实想法。' },
    { name: '中英数字混合', text: 'momo v1 · 匿名 channel 42' },
    { name: 'Emoji 与代理对', text: '🎉 匿名 👏 ok 🚀' },
    { name: '换行与制表符', text: '第一行\n第二行\t缩进\r\n第三行' },
    { name: '长文本(1KB+)', text: '匿名'.repeat(600) + ' end' },
  ];

  for (const c of cases) {
    let fragments = null;
    let recovered = '';
    let roundTrip = false;
    let err = '';
    try {
      fragments = crypto.splitMessage(c.text);
      recovered = crypto.combineMessage(fragments);
      roundTrip = recovered === c.text;
    } catch (e) {
      err = e.message;
    }

    results.push(assert(`往返 100% 还原：${c.name}`, roundTrip, err));
    results.push(assert(
      `碎片结构 = 4 且带 index：${c.name}`,
      Array.isArray(fragments) && fragments.length === 4
        && [0, 1, 2, 3].every((i) => fragments.some((f) => f.index === i)),
      '',
    ));
    results.push(assert(
      `matchHash 一致且非空：${c.name}`,
      !!fragments && fragments.every((f) => f.matchHash && f.matchHash === fragments[0].matchHash),
      '',
    ));

    // 不可读性：任一单碎片都不等于明文 hex（空文本无明文可泄漏，跳过）
    if (fragments && c.text.length > 0) {
      const plainHex = crypto.utf8ToHex(c.text);
      const noSingleLeak = fragments.every((f) => f.data !== plainHex);
      results.push(assert(`单碎片不泄漏明文：${c.name}`, noSingleLeak, ''));

      // 不可读性：任取 3 路异或不应等于明文（缺一路即不可还原）
      const three = [
        [fragments[0], fragments[1], fragments[2]],
        [fragments[0], fragments[1], fragments[3]],
        [fragments[0], fragments[2], fragments[3]],
        [fragments[1], fragments[2], fragments[3]],
      ];
      const noThreeLeak = three.every((g) => xorHex3(g[0].data, g[1].data, g[2].data) !== plainHex);
      results.push(assert(`任三路不泄漏明文：${c.name}`, noThreeLeak, ''));
    }
  }

  /* 2. SHA-256 matchHash 行为 */
  const a1 = crypto.splitMessage('same');
  const a2 = crypto.splitMessage('same');
  const b1 = crypto.splitMessage('diff');
  results.push(assert('同原文 → matchHash 相同', a1[0].matchHash === a2[0].matchHash, ''));
  results.push(assert('不同原文 → matchHash 不同', a1[0].matchHash !== b1[0].matchHash, ''));
  // 已知向量校验（确保 SHA-256 实现正确）
  // 已知向量校验（确保 SHA-256 实现正确，标准测试串 "abc"）
  results.push(assert(
    'SHA-256("abc") == 已知向量',
    crypto.sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    crypto.sha256('abc'),
  ));

  /* 3. 篡改检测 */
  try {
    const fr = crypto.splitMessage('tamper test');
    fr[1].data = '00' + fr[1].data.slice(2); // 改首字节
    crypto.combineMessage(fr);
    results.push(assert('篡改碎片应抛错', false, '未抛错'));
  } catch (e) {
    results.push(assert('篡改碎片被检测', /完整性校验失败/.test(e.message), e.message));
  }

  /* 4. matchHash 不一致检测 */
  try {
    const fr = crypto.splitMessage('hash mismatch');
    fr[2].matchHash = 'deadbeef'.repeat(8);
    crypto.combineMessage(fr);
    results.push(assert('matchHash 不一致应抛错', false, '未抛错'));
  } catch (e) {
    results.push(assert('matchHash 不一致被检测', /matchHash 不一致/.test(e.message), e.message));
  }

  /* 5. 碎片数量错误 */
  try {
    const fr = crypto.splitMessage('count');
    crypto.combineMessage(fr.slice(0, 3));
    results.push(assert('碎片数 <4 应抛错', false, '未抛错'));
  } catch (e) {
    results.push(assert('碎片数量校验', /需要恰好 4 个碎片/.test(e.message), e.message));
  }

  /* 6. 乱序碎片也能还原（combineMessage 内部按 index 排序） */
  let orderOk = false;
  try {
    const fr = crypto.splitMessage('乱序也能还原');
    const shuffled = [fr[2], fr[0], fr[3], fr[1]];
    orderOk = crypto.combineMessage(shuffled) === '乱序也能还原';
  } catch (e) {}
  results.push(assert('乱序碎片可还原', orderOk, ''));

  /* ---------- 汇总 ---------- */
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const report = { passed, failed, total: results.length, results };

  console.log(`[crypto.test] 通过 ${passed}/${results.length}` + (failed ? `，失败 ${failed}` : ' ✅'));
  results.forEach((r) => {
    if (!r.pass) console.log('  ✗', r.name, r.detail ? ('— ' + r.detail) : '');
  });
  return report;
}

module.exports = { runTests };

// 直接 `node crypto.test.js` 时自动运行并按结果退出（便于串入测试链 / 提交门禁）
if (require.main === module) {
  const r = runTests();
  if (r.failed) process.exit(1);
}
