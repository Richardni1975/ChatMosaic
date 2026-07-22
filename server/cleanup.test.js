// server/cleanup.test.js — 24 小时图片清理逻辑单测
// 运行：node server/cleanup.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanupOldFiles } = require('./cleanup.js');

let passed = 0, failed = 0;
const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  if (cond) passed++; else failed++;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function writeFile(dir, name, content) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, content);
  return fp;
}

async function setMtime(fp, timeMs) {
  const t = new Date(timeMs);
  fs.utimesSync(fp, t, t);
}

async function main() {
  /* 1. 超过 24h 的文件被删除，新文件保留 */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-c1-'));
    const oldFile = await writeFile(dir, 'old.png', 'x');
    const freshFile = await writeFile(dir, 'fresh.png', 'y');
    const now = Date.now();
    await setMtime(oldFile, now - 2 * DAY);
    await setMtime(freshFile, now - 1 * HOUR);
    const r = await cleanupOldFiles(dir, DAY, { now });
    assert('超时文件被删除', r.deleted === 1, 'deleted=' + r.deleted);
    assert('新文件保留', fs.existsSync(freshFile), '');
    assert('超时文件已不存在', !fs.existsSync(oldFile), '');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 2. .gitkeep 等占位文件被保留 */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-c2-'));
    const keep = await writeFile(dir, '.gitkeep', '');
    const old = await writeFile(dir, 'a.jpg', 'x');
    await setMtime(old, Date.now() - 3 * DAY);
    await setMtime(keep, Date.now() - 3 * DAY);
    const r = await cleanupOldFiles(dir, DAY);
    assert('.gitkeep 保留', fs.existsSync(keep), '');
    assert('旧图片删除', !fs.existsSync(old), '');
    assert('kept 计数包含 .gitkeep', r.kept >= 1, 'kept=' + r.kept);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 3. 边界：恰好 24h 不删（> 才删） */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-c3-'));
    const f = await writeFile(dir, 'edge.png', 'x');
    const now = Date.now();
    await setMtime(f, now - DAY);
    const r = await cleanupOldFiles(dir, DAY, { now });
    assert('恰好 24h 不删（> 才删）', fs.existsSync(f) && r.deleted === 0, 'deleted=' + r.deleted);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 4. 自定义 keep 集合 */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-c4-'));
    const keep1 = await writeFile(dir, 'README', 'x');
    const old = await writeFile(dir, 'b.png', 'x');
    await setMtime(keep1, Date.now() - 5 * DAY);
    await setMtime(old, Date.now() - 5 * DAY);
    await cleanupOldFiles(dir, DAY, { keep: new Set(['README']) });
    assert('自定义 keep 保留 README', fs.existsSync(keep1), '');
    assert('其他旧文件删除', !fs.existsSync(old), '');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 5. 目录不存在时静默返回零值 */
  {
    const r = await cleanupOldFiles(path.join(os.tmpdir(), 'momo-not-exist-' + Date.now()), DAY);
    assert('目录不存在静默返回', r.scanned === 0 && r.deleted === 0, JSON.stringify(r));
  }

  /* 6. 多文件批量清理计数 */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-c6-'));
    const old = Date.now() - 2 * DAY;
    for (let i = 0; i < 5; i++) await setMtime(await writeFile(dir, 'old' + i + '.png', 'x'), old);
    for (let i = 0; i < 3; i++) await writeFile(dir, 'new' + i + '.png', 'x');
    const r = await cleanupOldFiles(dir, DAY);
    assert('批量删除 5 个', r.deleted === 5, 'deleted=' + r.deleted);
    assert('批量扫描 8 个', r.scanned === 8, 'scanned=' + r.scanned);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`[cleanup.test] 通过 ${passed}/${passed + failed}` + (failed ? `，失败 ${failed}` : ' ✅'));
  results.filter((r) => !r.pass).forEach((r) => console.log('  ✗', r.name, r.detail));
  if (failed) process.exit(1);
}

main();
