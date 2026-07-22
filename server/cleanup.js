// server/cleanup.js — 24 小时图片自动清理
// 定时扫描 public/uploads/，按 mtime 判断存活，超时则物理删除；保留系统占位文件。
// 纯函数式 + 异步 fs，便于单测；relay.js 在 setInterval 中调用。

const fs = require('fs').promises;
const path = require('path');

const DEFAULT_KEEP = new Set(['.gitkeep']);

/**
 * 扫描目录并删除超过 maxAgeMs 的文件。
 * @param {string} dir 目标目录
 * @param {number} maxAgeMs 最大存活毫秒（按 mtime 计算）
 * @param {object} [opts] { now: number, keep: Set<string> }
 * @returns {Promise<{scanned:number, deleted:number, kept:number, errors:number}>}
 */
async function cleanupOldFiles(dir, maxAgeMs, opts = {}) {
  const keep = opts.keep || DEFAULT_KEEP;
  const now = opts.now != null ? opts.now : Date.now();
  const result = { scanned: 0, deleted: 0, kept: 0, errors: 0 };

  let entries;
  try { entries = await fs.readdir(dir); }
  catch (e) { return result; } // 目录不存在等：静默返回

  await Promise.all(entries.map(async (name) => {
    if (keep.has(name)) { result.kept++; return; }
    result.scanned++;
    const fp = path.join(dir, name);
    try {
      const st = await fs.stat(fp);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        await fs.unlink(fp);
        result.deleted++;
      }
    } catch (e) {
      result.errors++;
    }
  }));
  return result;
}

module.exports = { cleanupOldFiles, DEFAULT_KEEP };
