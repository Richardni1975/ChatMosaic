# LOCK.md — 功能锁定与回归门禁

本文件记录当前已锁定的核心功能，以及防止后续修改破坏它们的机制。**改代码前先看这里。**

## 一、锁定的核心功能（回归测试覆盖）

| # | 功能 | 测试 | 断言 |
|---|------|------|------|
| 1 | XOR 4-of-4 分片/重组 + SHA-256 校验 | `utils/crypto.test.js` (40) | 往返还原、篡改检测、乱序还原、多语种/Emoji |
| 2 | matcher 桶匹配 + seen 事件 + decoy 忽略 + TTL | `server/matcher.test.js` (39) | 齐四广播/销毁、重传幂等、matchHash 不一致丢弃 |
| 3 | 24h 图片自动清理 | `server/cleanup.test.js` (12) | 超时删除、.gitkeep 保留、新文件保留 |
| 4 | 客户端侮辱性言论过滤 | `utils/profanity.test.js` (15) | 检测/遮罩、分隔变体、不误伤正常词 |
| 4 | 小程序→PC 跨端分片拼图 | `server/smoke.test.js` | ws 发碎片 → sio 收 assembled → 还原原文 |
| 5 | PC→小程序 跨端分片拼图 | `server/smoke.test.js` | sio 发碎片 → ws 收 assembled → 还原原文 |
| 6 | 实名 direct_msg 跨端透传 | `server/smoke.test.js` | 跳过 matcher/Jitter，房间内广播 |
| 7 | 心跳 ping/pong | `server/smoke.test.js` | ws ping → 服务端回 pong |
| 8 | 图片 imageUrl 从请求头自动推导 | `server/smoke.test.js` | 免 PUBLIC_URL，按 Host+X-Forwarded-Proto 拼公网地址 |
| 9 | 房间隔离 | `server/smoke.test.js` | 不同 roomId 互不串消息 |

## 二、门禁机制

### 提交门禁（pre-commit 钩子）
- 位置：`scripts/hooks/pre-commit`（已 `git config core.hooksPath scripts/hooks`）
- 行为：每次 `git commit` 前自动跑 `cd server && npm test`（matcher+cleanup+crypto+smoke）。
- **任一测试失败 → 提交被阻断**。修复后才能提交。
- 紧急情况可 `git commit --no-verify` 跳过（不推荐）。

### 全量测试命令
```bash
cd server && npm test        # 跑全部 4 套（matcher 39 / cleanup 12 / crypto 40 / smoke 6）
```
单跑某一套：
```bash
node utils/crypto.test.js
node server/matcher.test.js
node server/cleanup.test.js
node server/smoke.test.js
```

## 三、改这些文件要特别小心（高风险）

| 文件 | 风险 | 为什么 |
|------|------|--------|
| `utils/crypto.js` | 极高 | 改分片/重组算法会让历史碎片无法还原；必须保持 4-of-4 XOR + matchHash 语义 |
| `server/matcher.js` | 高 | 纯函数状态机，改协议会破坏中转；保持纯函数、无 IO |
| `server/relay.js` | 高 | 双传输 + 房间路由 + 路径分离（`/`、`/socket`、`/socket.io/`）；noServer 模式不能退回 `{server,path}`（会触发 Invalid frame header） |
| `pages/room/index.js` | 中 | 客户端协议必须与服务端一致（shard/shard-seen/assembled/direct_msg/image/join/ping） |
| `public/app.js` | 中 | 同上，Socket.IO 通道 |

## 四、不可违反的硬约束（来自 CLAUDE.md）

1. **零身份映射**：后端不记录 OpenID ↔ 发言。
2. **零留存**：碎片桶集齐即删；图片 24h 清理；STT 音频内存中转不落盘。
3. **无日志**：后端只打印连接数/聚合计数，绝不打印 matchHash/data/msgId/识别内容。
4. **AppID**：`project.config.json` 用 `touristappid` 占位，禁提交真实 AppID。
5. **密钥**：`SILICONFLOW_API_KEY` 只放 `.env`（已 gitignore），禁提交。

## 五、新增功能时的流程

1. 先跑 `cd server && npm test` 确认基线全绿。
2. 改代码 + 同步更新/新增测试。
3. 再跑 `npm test` 直到全绿。
4. `git commit`（钩子会再跑一遍兜底）。
