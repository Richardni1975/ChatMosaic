# ChatMosaic 部署指南

把后端中转服务部署到公网服务器，让微信小程序真机与 PC Web 端跨端跑起来。

> 架构：PC 前端 → Cloudflare Pages（独立源）；后端 → `api-mosaic.m0m0n1.top`（Node + PM2 + Nginx 反代 WSS）。两端经同一后端按 `roomId` 跨端互通。

---

## 0. 前置资源
- 域名 `m0m0n1.top`（Cloudflare DNS 托管）
- 一台云服务器（Linux，已装 Node.js ≥ 18、Nginx、PM2）
- SSL 证书（Let's Encrypt 或 Cloudflare 源证书）

## 1. 云服务器端口
| 端口 | 用途 | 对外 |
|------|------|------|
| 80 | HTTP → 重定向到 443 | 是 |
| 443 | HTTPS / WSS 入口（Nginx） | 是 |
| 8080 | Node relay.js 本地监听 | **否**（仅 Nginx 回源访问 127.0.0.1:8080） |

> 安全组 / 防火墙：仅开放 80/443，**8080 不对公网开放**。

## 2. 服务器端部署

### 2.1 拉代码 & 装依赖
```bash
cd /opt
git clone <repo> ChatMosaic && cd ChatMosaic/server
npm install --omit=dev   # 安装 ws / socket.io / multer
```

### 2.2 配置环境变量
复制模板并按需修改（`server/config.js` 会自动读取项目根 `.env`）：
```bash
cp .env.example .env
# 编辑 .env
#   PORT=8080
#   PUBLIC_URL=https://api-mosaic.m0m0n1.top
#   MAX_AGE_HOURS=24
```
> 也可不建 `.env`，直接在 PM2 配置 `server/ecosystem.config.js` 的 `env` 里填写（二者任选其一，PM2 env 优先）。

### 2.3 PM2 持久运行
```bash
pm2 start server/ecosystem.config.js
pm2 save && pm2 startup    # 开机自启
pm2 logs momo-relay        # 查看日志
```
`relay.js` 端口优先读 `process.env.PORT`，默认 8080（见 `server/config.js`）。

## 3. Nginx 反向代理（WSS 关键）

在 `/etc/nginx/nginx.conf` 的 `http {}` 块内加 `map`（WebSocket 升级映射）：
```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

新建 `/etc/nginx/conf.d/api-mosaic.conf`：
```nginx
# HTTP -> HTTPS 重定向
server {
    listen 80;
    server_name api-mosaic.m0m0n1.top;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api-mosaic.m0m0n1.top;

    ssl_certificate     /etc/letsencrypt/live/api-mosaic.m0m0n1.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api-mosaic.m0m0n1.top/privkey.pem;

    # 上传图片体积上限（略大于 2MB 即可）
    client_max_body_size 5m;

    # 所有路径统一反代到 relay：/socket（小程序 ws）、/socket.io/（PC）、/upload、/uploads/
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;   # WebSocket 长连接不超时
        proxy_send_timeout 86400s;
    }
}
```
重载：`nginx -t && nginx -s reload`。

> Cloudflare 用户：若开启橙色云（代理），需在 Cloudflare → Network 开启「WebSockets」。证书可用 Cloudflare 源证书；Nginx 监听 443 用源证书，Cloudflare 边缘用其托管证书。

## 4. 微信公众平台合法域名配置
登录 [mp.weixin.qq.com](https://mp.weixin.qq.com/) → 开发管理 → 开发设置 → 服务器域名，添加：

| 类别 | 域名 | 用途 |
|------|------|------|
| socket 合法域名 | `wss://api-mosaic.m0m0n1.top` | 小程序 `wx.connectSocket`（连 `/socket`） |
| request 合法域名 | `https://api-mosaic.m0m0n1.top` | 通用 HTTPS 请求 |
| uploadFile 合法域名 | `https://api-mosaic.m0m0n1.top` | 小程序图片上传 `wx.uploadFile` |
| downloadFile 合法域名 | `https://api-mosaic.m0m0n1.top` | 图片下载（如需 `wx.downloadFile`） |

> `<image src="https://...">` 直接显示图片无需 downloadFile 域名，但建议一并配置。

## 5. 客户端切换到生产地址

### 小程序端
编辑 `utils/client-config.js`，把 `USE_PROD` 改为 `true`：
```js
const USE_PROD = true;
// PROD.relayUrl = 'wss://api-mosaic.m0m0n1.top/socket'
// PROD.httpBase = 'https://api-mosaic.m0m0n1.top'
```
然后用微信开发者工具上传/真机预览。`pages/room/index.js` 已通过该配置读取 `RELAY_URL` 与上传地址，无需改业务代码。

### PC Web 端
部署 `public/` 到 Cloudflare Pages（项目名 `moyan` 同款），并编辑 `public/config.js`：
```js
window.MOMO_CONFIG = { API_BASE: 'https://api-mosaic.m0m0n1.top' };
```
访问 `https://moyan.pages.dev`（或绑定的 `https://web.m0m0n1.top`），进房输入 `0000` 即可与小程序跨端互通。

## 6. 启动与验证命令
```bash
# 服务器侧
pm2 start server/ecosystem.config.js
pm2 status                      # 应为 online
curl https://api-mosaic.m0m0n1.top/   # 返回 PC 页面 HTML 或 404（说明 Nginx→relay 通）

# WSS 连通性（服务器上执行）
# 小程序原生 ws 路径
wscat -c wss://api-mosaic.m0m0n1.top/socket
# Socket.IO 路径
curl https://api-mosaic.m0m0n1.top/socket.io/?EIO=4&transport=polling   # 应返回 Engine.IO 握手串

# 单元测试（部署前回归）
cd server && npm test           # matcher 39/39 + cleanup 12/12
node utils/crypto.test.js       # crypto 40/40
```

## 7. 排查清单
| 现象 | 排查 |
|------|------|
| 小程序真机连不上 | 合法域名是否配置；`USE_PROD` 是否 true；Cloudflare WebSockets 是否开启 |
| WSS 握手失败 | Nginx `map` 是否在 http 块；`Upgrade`/`Connection` 头是否透传；8080 是否监听 |
| 图片上传 400 | `client_max_body_size` 是否够；格式/大小是否超 2MB |
| PM2 重启循环 | `pm2 logs momo-relay` 看报错；端口是否被占用 |
| 跨端不通 | 两端是否在同一 `roomId`（小程序默认 0000，PC 输 0000） |

## 8. 安全约束（部署后仍须遵守）
- 后端纯内存零留存，不落盘碎片/明文；图片 24h 自动清理。
- 严禁建立「用户 ↔ 发言」映射；日志只打印连接数与聚合计数。
- 生产建议给 `/upload` 加鉴权或限流，防止被滥用刷盘（当前为演示未加）。
