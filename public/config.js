// public/config.js — PC Web 端运行时配置（开发/生产切换）
//
// 本地调试：API_BASE 留空字符串 → Socket.IO 与 /upload 走同源（由 relay 静态服务提供页面）。
// 生产部署：PC 前端托管到 Cloudflare Pages（独立源），需把 API_BASE 改为后端公网地址。
window.MOMO_CONFIG = {
  API_BASE: '', // 生产示例：'https://api-mosaic.m0m0n1.top'
};
