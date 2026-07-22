// utils/client-config.js — 小程序端运行时配置（开发/生产切换）
//
// 本地调试：保持 USE_PROD = false，开发者工具勾选「不校验合法域名」即可连 ws://localhost。
// 公网部署：把 USE_PROD 改为 true（或直接修改 PROD 地址），并确保小程序后台已配置合法域名。

const USE_PROD = false;

const DEV = {
  // 原生 ws 中转地址（path / 或 /socket 均可，本地用根路径）
  relayUrl: 'ws://localhost:8080',
  // 图片上传 HTTP 基地址
  httpBase: 'http://localhost:8080',
};

const PROD = {
  // 公网 WSS：小程序真机必须 wss://，路径 /socket 由 Nginx 反代到 relay
  relayUrl: 'wss://api-mosaic.m0m0n1.top/socket',
  // 公网 HTTPS：图片上传接口
  httpBase: 'https://api-mosaic.m0m0n1.top',
};

module.exports = USE_PROD ? PROD : DEV;
