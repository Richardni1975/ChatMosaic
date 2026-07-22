# momo-anonymous-decision · 熟人匿名决策微信小程序

面向微信生态的熟人匿名沟通与集体决策工具。核心宗旨：通过**肉眼可见、物理级别的客户端脱敏与解构**消除熟人社会网络压迫，让用户敢于发表真实意见；全功能免费、极致流畅。

> 项目宪章见 [CLAUDE.md](CLAUDE.md)。

---

## 核心安全与信任设计

| 机制 | 说明 |
|------|------|
| **零身份映射** | 后端绝不建立「用户真实 OpenID ↔ 匿名发言」关联表 |
| **客户端物理分片（4-of-4 XOR）** | 文本在手机本地打散为 4 串纯随机乱码碎片，四者异或还原；任取 3 路无法还原 |
| **matchHash 完整性** | `SHA-256(明文)` 作为统一标识与重组校验，纯 JS 本地实现 |
| **本地销毁** | 语音转写完成后原始音频立即 `unlink` 物理销毁，不上传 |
| **Jitter Buffer 抗时序** | 后端所有出站事件经 50–250ms 随机延迟，打乱广播时序 |
| **Decoy 诱饵包混淆** | 周期/并发注入不可凑齐的虚假碎片，混淆流量大小与频率 |
| **可视化信任** | 碎纸散开 → 拼图收集 (x/4) → 合体闪光 → 明文 + SHA-256 ✓ |

---

## 项目架构

```
c:\ChatMosaic\
├── app.js / app.json / app.wxss        # 小程序入口、插件/权限、全局色板（亮/暗）
├── sitemap.json / project.config.json  # 收录与工程配置（appid 占位 touristappid）
├── pages/
│   └── room/                           # 主决策房间（三段式纵向布局）
│       ├── index.wxml/wxss             # Zone1 卡片流 / Zone2 动效 / Zone3 输入 + NOISE 能量条
│       └── index.js                    # 语音识别·分片·中转·拼图重组·能量状态机
├── components/privacy-anim/            # Zone2 碎纸/合体动效组件
├── utils/
│   ├── crypto.js                       # 4-of-4 XOR 分片/重组 + 本地 SHA-256
│   ├── crypto.test.js                  # 40 项单测
│   └── delay.js                        # Phase 4 stub（随机延迟/混淆包，逻辑已迁至 server）
├── public/                             # PC Web 跨端客户端（独立，不干扰小程序主工程）
│   ├── index.html / style.css          # 极客风进房界面 + 房间聊天页
│   └── app.js                          # Socket.IO + Web Speech API + 复用 utils/crypto.js
└── server/                             # 纯内存双传输中转（无日志·零留存·roomId 路由）
    ├── matcher.js                      # 纯函数匹配状态机 + jitterDelay + isDecoy 防御
    ├── matcher.test.js                 # 39 项单测
    ├── relay.js                        # Socket.IO + 原生 ws 双传输 + Jitter/Decoy + 静态服务
    └── package.json / README.md
```

### 三段式 UI（Zone Architecture）
- **Zone 1（65% 高度）**：NOISE 能量脉冲条 + 筛选 + 卡片流（collecting / assembling / decrypted 三态）
- **Zone 2**：折叠态「安全健康度状态条」；发送时展开玻璃拟态面板播放碎纸散开动画
- **Zone 3**：momo 匿名模式开关 + 按住说话（流式 STT）+ 文本输入 + 发送

---

## 4 Phase 演进总结

| Phase | 主题 | 关键产出 | 验证 |
|-------|------|----------|------|
| **1** | 三段式 UI + 低延迟语音识别 | 纵向三段式布局、touchstart 预加载、200ms 流式刷字、发送后本地销毁音频 | 手动 |
| **2** | 客户端密码学分片 + 无日志后端中转 | `splitMessage/combineMessage` + 本地 SHA-256；纯内存 matcher + relay；本地拼图重组 | crypto 40/40 · matcher 22/22 · e2e |
| **3** | 可视化信任 UI | 碎纸散开粒子、拼图收集中 (x/4) 卡片、拼图合体动画 + SHA-256 ✓ 标签；`shard-seen` 渐进转发 | matcher 29/29 · e2e |
| **4** | 流量混淆与网络对抗 | Jitter Buffer (50–250ms)、Decoy 诱饵包 (`isDecoy`/`count<4`/无 data)、NOISE 能量脉冲 UI | matcher 39/39 · e2e（时序重排确认） |

---

## 密码学与安全设计细节

### 4-of-4 XOR 零留存分片（`utils/crypto.js`）
设明文字节 `P`（长度 n，UTF-8）：
- 生成 3 路纯随机 `R0, R1, R2`
- 第 4 路密文 `R3 = P ⊕ R0 ⊕ R1 ⊕ R2`
- 四者异或 `R0 ⊕ R1 ⊕ R2 ⊕ R3 = P` 还原
- 任取 3 路无法还原（缺的那一路等价一次性密钥）
- `matchHash = SHA-256(P)`：重组时双重校验（碎片 hash 一致 + 还原文本 hash 匹配），不符即抛错

### Jitter Buffer 抗时序分析（`server/relay.js`）
- 纯函数 `jitterDelay(min,max,rng)`（可注入 RNG 便于测试）
- `shard-seen / assembled / decoy` 全部经 `setTimeout(jitterDelay())` 后再广播
- 实测事件重排：`count=3(70ms) → count=4(115ms) → assembled(194ms) → count=1(222ms) → count=2(238ms)`

### Decoy 诱饵包混淆（`server/relay.js` + `matcher.js`）
- 出站：`emitDecoy()` 生成虚假 `shard-seen`，`isDecoy:true`、`count∈1..3`（永不凑齐）、无 `data`、伪 matchHash
- 触发：周期随机 3–8s + 每真实碎片 30% 概率附发
- 入站：`ingestShard` 对 `isDecoy:true` 直接丢弃，不建桶
- 客户端：`isDecoy` 静默丢弃，仅令 NOISE 能量跃迁

### 零留存与无日志
- 桶集齐 4 即 `delete`；Jitter 载荷 ≤250ms 即 flush；未集齐桶 60s TTL 清理
- 后端只打印连接数与聚合计数，绝不打印 `matchHash / data / msgId / decoy` 内容
- 不读 openid、不记连接归属

---

## 测试与验证结果

| 测试套件 | 用例数 | 通过 | 覆盖 |
|----------|--------|------|------|
| `utils/crypto.test.js` | 40 | 40 ✅ | 往返还原（多语种/Emoji/长文本）、不可读性、SHA-256 已知向量、篡改/不匹配检测、乱序还原 |
| `server/matcher.test.js` | 39 | 39 ✅ | 齐四广播/销毁、重传幂等、matchHash 不一致丢弃、TTL 清理、seen 事件、jitterDelay 边界、isDecoy 忽略 |
| `server/cleanup.test.js` | 12 | 12 ✅ | 24h 超时删除、新文件保留、`.gitkeep` 保留、边界 24h 不删、自定义 keep、目录缺失静默、批量计数 |

```bash
cd c:\ChatMosaic
node utils/crypto.test.js        # → [crypto.test] 通过 40/40 ✅
node server/matcher.test.js      # → [matcher.test] 通过 39/39 ✅
node server/cleanup.test.js      # → [cleanup.test] 通过 12/12 ✅
cd server && npm test            # matcher + cleanup 一起跑
```

**端到端**（启动 relay 后用 Node 模拟客户端）：4 碎片 → 4 个 `shard-seen` + 1 `assembled` → `combineMessage` 100% 还原；Phase 4 实测 jitter 时序重排 + decoy 周期注入均符合预期。

---

## 本地启动与调试

### 1. 启动中转服务
```bash
cd c:\ChatMosaic\server
npm install        # 安装 ws
npm start          # 默认端口 8080，可用 PORT=9000 覆盖
npm test           # 跑 matcher 单测
```

### 2. 配置微信开发者工具
1. 安装「微信开发者工具」，导入项目目录 `c:\ChatMosaic`。
2. **详情 → 本地设置**：勾选「不校验合法域名、web-view……」，即可连 `ws://localhost:8080`。
3. **AppID**：当前为 `touristappid`（测试号）。正式使用需在 [mp.weixin.qq.com](https://mp.weixin.qq.com/) 注册小程序并替换 [project.config.json](project.config.json) 的 `appid`。
4. **同声传译插件**（可选，流式 STT）：小程序后台「开发 → 插件管理」添加「同声传译」插件，并在 `app.json` 的 `plugins` 中声明（见 [server/README.md](server/README.md) 协议说明）。未配置时语音按键降级为纯录音。

### 3. 调试流程
- 编译 → `pages/room/index` 渲染三段式 + 顶部 NOISE 能量条
- 发送消息 → 控制台可见 `[momo] 已本地分片` / `[momo] 拼图重组完成` / `[momo-relay] 已中转聚合 N 条`
- 长按语音 → touchstart 预加载、流式刷字；松开后文本入输入框可校对
- 切换系统暗色模式 → 色板随 `prefers-color-scheme` 切换

### 4. PC Web 跨端客户端（`public/`）
中转服务同时提供 PC 浏览器页面，与小程端跨端加密对讲：

```bash
cd c:\ChatMosaic\server && npm install && npm start
# 浏览器打开 http://localhost:8080/
```

- **进房**：输入 4 位数字房间码（或 🎲 随机生成）→ 进入房间。
- **跨端互通**：小程序端不发 roomId，统一进入**默认房间 `0000`**；PC 端输入 **`0000`** 即可与小程序端跨端对讲。PC 输入其他码则为 PC 独立房间（多开两个浏览器输同一码可互通）。
- **语音**：鼠标长按「按住说话」或按住 **空格键** 触发 Web Speech API 流式转写（需 Chrome/Edge + 麦克风权限），≤60s。
- **加密复用**：PC 端通过 `module` shim 直接加载 `utils/crypto.js`（原文件零修改），与小程序端共享同一套 XOR 4-of-4 分片与 SHA-256 校验。
- **传输**：PC 走 Socket.IO（`/socket.io/`），小程序走原生 ws（`/`），同端口分路径，由 `server/relay.js` 统一按 `roomId` 路由广播。

> 双端联调：启动 `npm start` 后，一边微信开发者工具开小程序（默认连 `ws://localhost:8080`，房间 0000），一边浏览器开 `http://localhost:8080/` 输入 `0000`，即可互相发送匿名分片消息并触发拼图合体。

### 5. 界面适配（rpx 响应式）
- **弃用 `100vh`**：移动端 `vh` 受浏览器地址栏/异形屏影响易溢出留白；改用 `page { height: 100% }` + `.room { height: 100% }`，由 flex 三段式撑满。
- **`rpx` 全屏等比缩放**：卡片间距、内边距、字号、按钮高度、粒子位移轨迹（碎纸 `dist=192rpx`）统一用 `rpx`（750rpx = 屏宽），大屏小屏自动等比缩放；`border` 用 `1rpx` 保证高清屏细线不发虚。
- **刘海屏适配**：Zone 3 底部 `env(safe-area-inset-bottom)` 适配 Home 指示条；顶部由导航栏处理。
- **长文本**：`word-break: break-word` 防长串 hex/URL 撑破卡片。

### 6. 语音输入（60s 限时 + 单一出口）
- **上限**：`MAX_RECORD_MS = 60000`，对齐微信「按住说话」语音消息 60s 时限；到时自动停止。
- **防御性收尾**：状态复位与识别文本落位统一收拢到 `recorderManager.onStop` 单一出口——手动松开（`onVoiceTouchEnd` 调 `stop`）与到 60s 自动停都走同一路径，避免「按住超时后按钮仍显示松开结束、识别器未停」的状态错乱。
- **权限**：`wx.getSetting` 三态判断 + 拒绝时 `wx.openSetting` 引导，详见 `pages/room/index.js` 的 `ensureRecordPermission`。

### 7. 图片存储策略（零存储压力）
图片采用「客户端压缩 + HTTP 独立上传 + 后端 24 小时定时清理」机制，服务器硬盘不会被占满：
- **客户端压缩**：小程序 `wx.chooseMedia` 选 `compressed`；PC 端 Canvas 限最长边 1600px、JPEG 降质至 ≤2MB 后再上传。
- **HTTP 独立上传**：二进制走 `POST /upload`（multer），与 WebSocket 实时拼图通道完全隔离；上传成功后服务端仅广播图片 URL（几十字节 JSON）至同房间。
- **后端二次校验**：后缀白名单（JPG/PNG/WebP）+ MIME 白名单 + 大小 ≤2MB，不符即删文件并 400。
- **24 小时自动清理**：`server/cleanup.js` 的 `cleanupOldFiles()` 每小时扫描 `public/uploads/`，按 `mtime` 超过 `MAX_AGE_HOURS`（默认 24）物理删除；`.gitkeep` 等占位文件保留。单测见 `server/cleanup.test.js`（12 项）。

### 8. 部署指导（m0m0n1.top + Cloudflare Pages + Supabase）
现有基础设施：域名 `m0m0n1.top`（Cloudflare DNS）、Cloudflare Pages（项目 `moyan` 同款）、Supabase。

**配置解耦**：服务端端口/域名/图片存活时长已抽离至 [server/config.js](server/config.js)，自动读取项目根 `.env`（见 [.env.example](.env.example)）：
```env
PORT=8080
PUBLIC_URL=https://api-mosaic.m0m0n1.top   # 图片 URL 公网基地址
MAX_AGE_HOURS=24
```

**PC Web 前端 → Cloudflare Pages**：
1. 将 `public/` 作为静态站点部署至 Cloudflare Pages（项目名沿用 `moyan` 同款环境）。
2. 部署后前端地址形如 `https://moyan.pages.dev` 或绑定自定义子域 `https://web.m0m0n1.top`。
3. 修改 `public/app.js` 的 Socket.IO 连接地址指向后端子域名（见下），或在 Cloudflare Pages 配置环境变量注入。

**Node.js 后端 → 公网域名**：
1. 在 Cloudflare DNS 为 `m0m0n1.top` 添加 A/CNAME 记录，将 `api-mosaic` 子域指向后端服务器 IP（或通过 Cloudflare Tunnel）。
2. 后端启用 HTTPS（`wss://`）：可用 Cloudflare 反代或 Nginx + Let's Encrypt。`PUBLIC_URL=https://api-mosaic.m0m0n1.top`。
3. 启动：`cd server && cp ../.env.example ../.env && npm install && npm start`。
4. 小程序后台配置合法 socket 域名 `wss://api-mosaic.m0m0n1.top` 与 downloadFile 域名 `https://api-mosaic.m0m0n1.top`；PC 端 Socket.IO 指向同一域名。

**Supabase（可选）**：当前后端为纯内存零留存，符合宪章「无身份映射」。如需持久化房间元数据或审计计数，可接入 Supabase，但**严禁**存储明文/碎片/用户↔发言映射。

### 生产部署（通用）
- 中转服务改为 `wss://` 并在小程序后台配置合法 socket 域名，更新 `pages/room/index.js` 的 `RELAY_URL`。
- 后端可水平扩展，但需共享内存匹配状态（如引入 Redis 仅做 `matchHash` 匹配，仍不存明文）。


