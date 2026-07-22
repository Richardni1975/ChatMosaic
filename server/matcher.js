// server/matcher.js
// Phase 2/3 后端核心：基于 matchHash 的碎片匹配状态机（纯函数，无 IO，便于单测）。
//
// 设计要点（严格遵守 CLAUDE.md「无日志后端 / 内存零留存」）：
// - 桶 key = msgId（每条消息客户端生成的唯一 id），同一桶内所有碎片必须携带相同 matchHash，
//   matchHash 不一致直接丢弃，防止不同原文碎片混淆。
//   注：matchHash = SHA-256(明文)，相同明文会撞 hash，故用 msgId 做主键、matchHash 做一致性校验。
// - 4 个碎片须来自 4 个不同 channel（模拟「4 路不同通道」分发），同 channel 重复覆盖、不增量。
// - 每收到一个有效碎片 → 返回 seen 事件（仅 channel/preview/count，不含 data），
//   供客户端展示「拼图收集中 (x/4)」渐进态；不含 data 故不泄漏可重组内容。
// - 集齐 4 个 → 返回 assembled 广播包，并从内存删除该桶（零留存）。后端永不落盘、不打印碎片内容。
// - 未集齐的桶由 expireBuckets 超时清理，避免内存泄漏（清理时不广播、不 seen）。
//
// 注：seen 事件会暴露单碎片到达时序，属 Phase 4「防时间序攻击（随机延迟+混淆包）」治理范畴，
// Phase 3 为可视化信任暂保留即时转发。

const BUCKET_TTL_MS = 60 * 1000; // 未集齐桶的存活上限

function createState() {
  return { buckets: new Map(), assembledCount: 0 };
}

function now() {
  return Date.now();
}

/**
 * 纯函数：计算 Jitter Buffer 的随机延迟（毫秒），用于打乱出站事件真实时序。
 * @param {number} min  下限（默认 50ms）
 * @param {number} max  上限（默认 250ms）
 * @param {function} rng  注入随机源，便于测试；默认 Math.random
 * @returns {number}  整数毫秒，区间 [min, max]
 */
function jitterDelay(min, max, rng) {
  const lo = min == null ? 50 : min;
  const hi = max == null ? 250 : max;
  const r = rng || Math.random;
  return lo + Math.floor(r() * (hi - lo));
}

/**
 * 投递一个碎片。
 * @param {object} state  由 createState() 创建的可变状态
 * @param {object} shard  { msgId, matchHash, index, channel, data, preview? }
 * @returns {{ seen: object|null, broadcast: object|null }}
 *          seen: { msgId, matchHash, channel, index, preview, count } 每个有效碎片都返回
 *          broadcast: { msgId, matchHash, fragments } 仅集齐 4 时返回（状态机已销毁该桶）
 */
function ingestShard(state, shard) {
  const { msgId, matchHash, index, channel, data } = shard || {};

  // 混淆包（decoy）：绝不进入桶、不产生事件，从入站侧即静默丢弃
  if (shard && shard.isDecoy) {
    return { seen: null, broadcast: null };
  }

  if (!msgId || !matchHash || channel == null || typeof data !== 'string') {
    return { seen: null, broadcast: null }; // 字段不全，静默丢弃
  }

  let bucket = state.buckets.get(msgId);
  if (!bucket) {
    bucket = { matchHash, byChannel: new Map(), createdAt: now() };
    state.buckets.set(msgId, bucket);
  }

  // 同一 msgId 必须同一 matchHash，否则丢弃防混淆
  if (bucket.matchHash !== matchHash) {
    return { seen: null, broadcast: null };
  }

  // 按 channel 去重：同通道重复覆盖（幂等，支持重传）
  bucket.byChannel.set(channel, { index, matchHash, data, preview: shard.preview });
  const count = bucket.byChannel.size;
  const seen = { msgId, matchHash, channel, index, preview: shard.preview, count };

  if (count >= 4) {
    const fragments = Array.from(bucket.byChannel.values());
    // 内存即刻销毁：广播后不再保留
    state.buckets.delete(msgId);
    state.assembledCount++;
    return { seen, broadcast: { msgId, matchHash, fragments } };
  }
  return { seen, broadcast: null };
}

/**
 * 清理超时未集齐的桶（不广播、不 seen，仅释放内存）。
 * @param {object} state
 * @param {number} [nowMs]  注入当前时间，便于测试
 */
function expireBuckets(state, nowMs) {
  const t = nowMs == null ? now() : nowMs;
  for (const [msgId, bucket] of state.buckets) {
    if (t - bucket.createdAt > BUCKET_TTL_MS) state.buckets.delete(msgId);
  }
}

module.exports = { createState, ingestShard, expireBuckets, jitterDelay, BUCKET_TTL_MS };
