// utils/client-config.js - 小程序端运行时配置

// 本地调试：保持 USE_PROD = false，开发者工具勾选「不校验合法域名」
// 公网部署：把 USE_PROD 改为 true
const USE_PROD = true;

const DEV = {
  // Socket.IO / HTTP 基地址
  httpBase: 'http://localhost:8080',
};

const PROD = {
  // 公网 HTTPS：Socket.IO / 图片上传 / HTTP 接口共用
  httpBase: 'https://chatmosaic-1.onrender.com',
};

module.exports = USE_PROD ? PROD : DEV;