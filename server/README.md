# momo-relay — 碎片中转服务（Phase 2）

纯内存、无日志、零留存的 WebSocket 中转。后端**只**做基于 `matchHash` 的碎片匹配与广播，不落盘、不记录用户身份、不建「用户 ↔ 发言」映射。

## 文件
- `matcher.js` — 纯函数匹配状态机（无 IO，可单测）。桶 key = `msgId`，同桶强制 `matchHash` 一致；4 个不同 channel 集齐 → 返回广播包并立即销毁桶。
- `relay.js` — `ws` WebSocket 服务，把 `matcher` 接到网络上。
- `matcher.test.js` — 匹配逻辑单测（`npm test`）。

## 运行
```bash
cd server
npm install        # 安装 ws
npm start          # 默认端口 8080，可用 PORT=9000 覆盖
npm test           # 跑匹配逻辑单测
```

## 协议
客户端 → 服务端：
```json
{ "type": "shard", "msgId": "<客户端生成的唯一id>", "matchHash": "<SHA-256(明文)>",
  "index": 0, "channel": "ch0", "data": "<hex乱码>", "preview": "0x8F" }
```
一条消息的 4 个碎片使用**相同 msgId + 相同 matchHash**，但 `channel` 各不相同（`ch0..ch3`）。

服务端 → 所有客户端（集齐 4 后广播，随即销毁桶）：
```json
{ "type": "assembled", "msgId": "...", "matchHash": "...",
  "fragments": [ {index, matchHash, data, preview}, ... 4 个 ] }
```

## 安全约束（CLAUDE.md）
- 内存零留存：广播后 `buckets.delete(msgId)`；未集齐桶 60s TTL 清理。
- 无日志：只打印连接数与聚合计数，不打印 `matchHash` / `data` / `msgId`。
- 无身份映射：不读取 openid，不记录连接归属。

## 接入小程序
1. 微信开发者工具 → 详情 → 勾选「不校验合法域名…」，即可连 `ws://localhost:8080`。
2. 生产环境需在小程序后台配置 `wss://` 合法域名，并修改 `pages/room/index.js` 里的 `RELAY_URL`。
