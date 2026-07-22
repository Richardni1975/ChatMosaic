// PM2 进程配置 —— 后台持久运行 momo-relay
// 启动：  pm2 start ecosystem.config.js
// 重启：  pm2 restart momo-relay
// 停止：  pm2 stop momo-relay
// 日志：  pm2 logs momo-relay
// 开机自启：pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name: 'momo-relay',
      script: 'relay.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // 单实例：纯内存房间状态，不可多实例
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 8080,                            // 端口优先读 env，默认 8080
        PUBLIC_URL: 'https://api-mosaic.m0m0n1.top', // 图片 URL 公网基地址
        MAX_AGE_HOURS: 24,
      },
    },
  ],
};
