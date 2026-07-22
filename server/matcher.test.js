// server/matcher.test.js
// Phase 2 后端匹配逻辑单元测试（纯函数，无网络依赖）。
// 运行：node server/matcher.test.js

const { createState, ingestShard, expireBuckets, jitterDelay, BUCKET_TTL_MS } = require('./matcher.js');

let passed = 0;
let failed = 0;
const results = [];

function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  if (cond) passed++; else failed++;
}

/** 构造同一原文的 4 个碎片（不同 channel） */
function makeShards(msgId, matchHash) {
  return [0, 1, 2, 3].map((i) => ({
    msgId, matchHash, index: i, channel: 'ch' + i, data: (i * 16).toString(16).padStart(2, '0'),
    preview: '0x' + (i * 16).toString(16).toUpperCase().padStart(2, '0'),
  }));
}

/* 1. 逐个投递 4 碎片，前 3 个不广播，第 4 个广播 */
{
  const st = createState();
  const shards = makeShards('m1', 'hashA');
  const r1 = ingestShard(st, shards[0]);
  const r2 = ingestShard(st, shards[1]);
  const r3 = ingestShard(st, shards[2]);
  const r4 = ingestShard(st, shards[3]);
  assert('前 3 碎片不广播', !r1.broadcast && !r2.broadcast && !r3.broadcast, '');
  assert('第 4 碎片触发广播', !!r4.broadcast, '');
  assert('广播含 4 碎片', r4.broadcast && r4.broadcast.fragments.length === 4, '');
  assert('广播携带 msgId/matchHash',
    r4.broadcast && r4.broadcast.msgId === 'm1' && r4.broadcast.matchHash === 'hashA', '');
  assert('广播后桶立即销毁（零留存）', st.buckets.size === 0, 'buckets=' + st.buckets.size);
  assert('assembledCount +1', st.assembledCount === 1, '');
}

/* 2. 同 channel 重复（重传）不应提前触发，仍需 4 个不同 channel */
{
  const st = createState();
  const s = makeShards('m2', 'hashB');
  ingestShard(st, s[0]);
  ingestShard(st, s[0]); // 重复 ch0
  ingestShard(st, s[1]);
  ingestShard(st, s[1]); // 重复 ch1
  const r = ingestShard(st, s[2]);
  assert('重复通道不增量（仍只有 3 个不同 channel）', !r.broadcast, '');
  const r2 = ingestShard(st, s[3]);
  assert('第 4 个不同 channel 才广播', !!r2.broadcast, '');
  assert('重传幂等：count 仍 +1', st.assembledCount === 1, '');
}

/* 3. 同 msgId 但 matchHash 不一致 → 丢弃，不混淆 */
{
  const st = createState();
  const s = makeShards('m3', 'hashC');
  ingestShard(st, s[0]);
  ingestShard(st, s[1]);
  ingestShard(st, s[2]);
  // 伪造第 4 碎片：同 msgId 但 matchHash 不同
  const bad = { ...s[3], matchHash: 'hashX' };
  const r = ingestShard(st, bad);
  assert('matchHash 不一致的碎片被丢弃', !r.broadcast, '');
  assert('桶内仍只有 3 个有效碎片', st.buckets.get('m3').byChannel.size === 3, '');
  // 补回正确第 4 碎片可正常广播
  const r2 = ingestShard(st, s[3]);
  assert('补回正确碎片后可广播', !!r2.broadcast, '');
}

/* 4. 字段不全的碎片被静默丢弃 */
{
  const st = createState();
  assert('缺 msgId 丢弃', !ingestShard(st, { matchHash: 'h', channel: 'c', data: 'aa' }).broadcast, '');
  assert('缺 data 丢弃', !ingestShard(st, { msgId: 'm', matchHash: 'h', channel: 'c' }).broadcast, '');
  assert('缺 channel 丢弃', !ingestShard(st, { msgId: 'm', matchHash: 'h', data: 'aa' }).broadcast, '');
  assert('无任何有效桶产生', st.buckets.size === 0, '');
}

/* 5. 两桶并存互不干扰 */
{
  const st = createState();
  const a = makeShards('mA', 'hA');
  const b = makeShards('mB', 'hB');
  ingestShard(st, a[0]); ingestShard(st, b[0]);
  ingestShard(st, a[1]); ingestShard(st, b[1]);
  ingestShard(st, a[2]); ingestShard(st, b[2]);
  assert('两桶并存（size=2）', st.buckets.size === 2, '');
  const ra = ingestShard(st, a[3]);
  const rb = ingestShard(st, b[3]);
  assert('两桶各自广播', !!ra.broadcast && !!rb.broadcast, '');
  assert('广播后两桶全销毁', st.buckets.size === 0, '');
  assert('assembledCount=2', st.assembledCount === 2, '');
}

/* 6. TTL 清理：超时未集齐的桶被删除且不广播 */
{
  const st = createState();
  const s = makeShards('mTTL', 'hTTL');
  ingestShard(st, s[0]);
  ingestShard(st, s[1]);
  // 模拟时间流逝超过 TTL
  const future = Date.now() + BUCKET_TTL_MS + 1;
  expireBuckets(st, future);
  assert('超时桶被清理', st.buckets.size === 0, 'size=' + st.buckets.size);
  // 清理后补齐剩余碎片不会误广播（桶已不存在，从 0 开始）
  const r = ingestShard(st, s[2]);
  assert('清理后继续投递不广播', !r.broadcast, '');
}

/* 7. seen 事件：每个有效碎片返回 count 递增，且不含 data */
{
  const st = createState();
  const s = makeShards('mSeen', 'hashS');
  const r1 = ingestShard(st, s[0]);
  const r2 = ingestShard(st, s[1]);
  const r3 = ingestShard(st, s[2]);
  const r4 = ingestShard(st, s[3]);
  assert('seen1.count=1', r1.seen && r1.seen.count === 1 && r1.seen.channel === 'ch0', '');
  assert('seen2.count=2', r2.seen && r2.seen.count === 2, '');
  assert('seen3.count=3', r3.seen && r3.seen.count === 3, '');
  assert('seen4.count=4 且同时广播', r4.seen && r4.seen.count === 4 && !!r4.broadcast, '');
  assert('seen 不含 data 字段', !('data' in r1.seen), JSON.stringify(r1.seen));
  assert('seen 携带 preview', r1.seen.preview === s[0].preview, '');
}

/* 8. 非法碎片不产生 seen */
{
  const st = createState();
  const r = ingestShard(st, { msgId: 'x', matchHash: 'h', channel: 'c' }); // 缺 data
  assert('非法碎片 seen=null', r.seen === null && r.broadcast === null, '');
}

/* 9. Jitter Buffer 延迟：纯函数 jitterDelay 边界与整数性 */
{
  assert('rng=0 → min', jitterDelay(50, 250, () => 0) === 50, '');
  assert('rng=1 → max', jitterDelay(50, 250, () => 1) === 250, '');
  assert('rng=0.5 → 中值 150', jitterDelay(50, 250, () => 0.5) === 150, '');
  assert('默认区间 50-250 内', (function () {
    for (let i = 0; i < 1000; i++) {
      const d = jitterDelay();
      if (d < 50 || d > 250 || d !== Math.floor(d)) return false;
    }
    return true;
  })(), '');
  assert('自定义区间 100-200 内', (function () {
    for (let i = 0; i < 1000; i++) {
      const d = jitterDelay(100, 200);
      if (d < 100 || d > 200) return false;
    }
    return true;
  })(), '');
}

/* 10. 混淆包（isDecoy）入站即丢弃：不进桶、不产生 seen/broadcast，4 个 decoy 也永不凑齐 */
{
  const st = createState();
  const decoy = { msgId: 'd1', matchHash: 'hD', index: 0, channel: 'ch0', data: 'aa', preview: '0x0A', isDecoy: true };
  const r1 = ingestShard(st, decoy);
  assert('decoy 不产生 seen/broadcast', r1.seen === null && r1.broadcast === null, '');

  // 连投 4 个「不同 channel」的 decoy，也不应建桶/凑齐
  for (let i = 0; i < 4; i++) {
    ingestShard(st, { msgId: 'd1', matchHash: 'hD', index: i, channel: 'ch' + i, data: 'aa', preview: '0x0A', isDecoy: true });
  }
  assert('4 个 decoy 仍无桶', st.buckets.size === 0, 'size=' + st.buckets.size);
  assert('4 个 decoy 永不凑齐（assembledCount=0）', st.assembledCount === 0, '');

  // 同一 msgId 投真实碎片仍可正常凑齐（decoy 不污染）
  const real = makeShards('d1', 'hD');
  let last;
  for (let i = 0; i < 4; i++) last = ingestShard(st, real[i]);
  assert('decoy 不影响真实碎片凑齐', !!last.broadcast, '');
  assert('真实凑齐 assembledCount=1', st.assembledCount === 1, '');
}

/* ---------- 汇总 ---------- */
console.log(`[matcher.test] 通过 ${passed}/${passed + failed}` + (failed ? `，失败 ${failed}` : ' ✅'));
results.filter((r) => !r.pass).forEach((r) => console.log('  ✗', r.name, r.detail));
if (failed) process.exit(1);
