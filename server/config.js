// server/config.js — 服务端配置解耦
// 自动读取项目根 .env（不覆盖已存在的环境变量），无需 dotenv 依赖。

const fs = require('fs');
const path = require('path');

// 轻量 .env 加载器：读取项目根 .env（若存在）
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  let txt;
  try { txt = fs.readFileSync(envPath, 'utf8'); } catch (e) { return; }
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue; // 已存在的环境变量优先
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
})();

const PORT = parseInt(process.env.PORT, 10) || 8080;

module.exports = {
  // 中转服务端口
  PORT,
  // 图片 URL 公网/局域网基地址，客户端据此拼接图片绝对地址
  // 默认按本机端口推导；线上部署设为 https://api-mosaic.m0m0n1.top
  PUBLIC_URL: process.env.PUBLIC_URL || `http://localhost:${PORT}`,
  // 图片存活时长（小时），超过后由定时任务物理删除
  MAX_AGE_HOURS: parseInt(process.env.MAX_AGE_HOURS, 10) || 24,
  // 硅基流动 SiliconFlow API Key（后端接力 STT 用），填入 .env，勿提交
  SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY || '',
};
