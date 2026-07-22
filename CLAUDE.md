# CLAUDE.md — momo-anonymous-decision 项目宪章与开发规范

> 本文件是项目宪法与 AI 协作规范。任何改动都不得违反本文的安全原则。

## 一、项目定位与核心哲学

本项目是一款面向微信生态（小程序及公众号嵌入）的**熟人匿名沟通与集体决策工具**。
核心宗旨：通过「肉眼可见、物理级别的客户端脱敏与解构」消除熟人社会网络压迫，让用户敢于发表最真实的意见，同时实现对用户的全功能免费与极致流畅的交互体验。

### 核心安全与信任原则（Zero-Knowledge & Transparency）— 不可违反
1. **零身份映射（No Identity Mapping）**：后端数据库架构绝对禁止建立「用户真实 OpenID/ID ↔ 匿名发言」的关联映射表。
2. **客户端物理分片（Client-Side Secret Sharing）**：文本/语音转写内容在手机本地通过算法（XOR）打散为 4 串纯随机乱码（OTP 密钥碎片，如 `0x8F`）。原始语音文件在转写完成后**必须立即在本地销毁**，不得上传服务器。
3. **可视化信任与社会学互证（Visual Trust）**：发送端呈现「文本碎纸化 → 乱码光块 → 飞向群友」动效；接收端收到碎片时显示拼图收集态，合成时播放拼图合体动画。
4. **防时间序攻击（Anti-Timing Attack）**：发送/中转引入随机延迟漂移与伪造混淆包，避免通过「放下手机的时间」推断发送者。

## 二、界面布局规范（UI/UX Architecture）

纵向三段式布局（Three-Zone Architecture）：

1. **Zone 1（顶部，65% 高度）— 高效率公共意见展示区**
   - 卡片式流式布局，卡片间距 `12px`，内边距 `16px`
   - 配色：背景 `#F8FAFC`（暗 `#0F172A`），正文 `#1E293B`（暗 `#F8FAFC`），辅助 `#64748B`，高亮/赞同 `#10B981`
   - 排版：正文 `15px`、行高 `1.6`、字间距 `0.5px`
   - 支持按「赞同数/击掌/提案主题」筛选与一键导出
   - Phase 4：顶部叠加 NOISE 抗追踪能量脉冲条

2. **Zone 2（中间）— 加密与社会学互证动效区**
   - 平时折叠为「安全健康度状态条」；发送时展开玻璃拟态（Glassmorphism）面板，播放碎纸-乱码动画，随后收起

3. **Zone 3（底部）— 极致响应输入控制区**
   - `momo 匿名模式`开关、流式语音输入按键、文本输入框、发送按钮

## 三、语音识别响应优化（STT）

1. **预加载**：监听语音按钮 `touchstart`，瞬间静默初始化录音引擎与硬件降噪
2. **流式实时刷字**：同声传译流式切片接口（200ms 分帧），感官延迟 <100ms
3. **手动校对与自动销毁**：松开后可在输入框修改错别字，发送后本地音频立即物理销毁

## 四、技术栈与代码结构

- 全量免费架构：核心通信、分片、合成禁止依赖外部付费大模型 API，基于本地 JS + 轻量云数据库
- 前端：微信小程序原生（WXML/WXSS/JS）
- 后端：Node.js + `ws` WebSocket（纯内存中转）；后续可引入 Redis 仅处理 `matchHash` 匹配（不存明文）
- 模块：
  - `/utils/crypto.js` — 本地 XOR 分片/拼接 + SHA-256 校验
  - `/utils/delay.js` — stub（逻辑已迁至 `/server`）
  - `/components/privacy-anim/` — Zone 2 碎纸/合体动效
  - `/pages/room/` — 主决策房间（三段式布局）
  - `/server/matcher.js` — 纯函数匹配状态机 + `jitterDelay` + `isDecoy` 防御
  - `/server/relay.js` — WebSocket 中转 + Jitter Buffer + Decoy 注入

## 五、开发路线图（Roadmap）— 已全部完成 ✅

- [x] **Phase 1**：高效能三段式 UI 框架 + 低延迟语音识别接入
- [x] **Phase 2**：客户端密码学分片（XOR）+ 无日志后端重组逻辑
- [x] **Phase 3**：可视化信任 UI（碎纸动画、群友乱码卡片、拼图合体）
- [x] **Phase 4**：防时间序攻击（Jitter Buffer 随机延迟 + Decoy 混淆包）+ 静默中转能量值

## 六、当前实现要点（供后续维护）

### 密码学
- `splitMessage(text)` → 4 碎片 `{index, matchHash, data(hex), preview(0xNN)}`
- `combineMessage(fragments)` → 校验 matchHash + SHA-256 后还原
- 桶 key = `msgId`（客户端生成），同桶强制 `matchHash` 一致；`matchHash=SHA-256(明文)` 同明文会撞，故用 msgId 做主键

### 中转协议
- 客户端 → 服务端：`{type:'shard', msgId, matchHash, index, channel:'ch0..3', data, preview}`
- 服务端 → 客户端：`{type:'shard-seen', msgId, channel, preview, count}`（无 data，渐进收集）
- 服务端 → 客户端：`{type:'assembled', msgId, matchHash, fragments[4]}`（集齐后广播，随即销毁桶）
- 诱饵：`{type:'shard-seen', isDecoy:true, count∈1..3, ...}`（永不凑齐，无 data）
- 所有出站经 `jitterDelay()` 50–250ms 延迟

### 客户端卡片状态机
`collecting`（拼图收集中 x/4）→ `assembling`（合体动画）→ `decrypted`（明文 + SHA-256 ✓）
- jitter 可能让 `shard-seen` 晚于 `assembled` 到达：`onShardSeen` 对已 `seenIds` 的 msgId 跳过
- `isDecoy` 静默丢弃，仅 `bumpEnergy` 跃迁 NOISE 能量

## 七、协作规范

- **保持纯净无日志、零留存**：后端不得落盘、不得打印碎片内容/身份信息
- **matcher 保持纯函数**：时序与网络 IO 一律放 `relay.js`；`matcher.js` 不得引入 `setTimeout/Date.now` 之外的副作用（`jitterDelay` 为纯函数除外）
- **改动需补测**：`utils/crypto.test.js` 与 `server/matcher.test.js` 必须随逻辑变更同步更新并全绿
- **样式**：遵循宪章色板与三段式比例；新增可视化元素保持赛博朋克/极客简洁（等宽字体 + 霓虹绿发光）
- **AppID**：仓库内 `project.config.json` 使用 `touristappid` 占位，禁止提交真实 AppID

## 八、快速验证命令

```bash
cd c:\ChatMosaic
node utils/crypto.test.js        # crypto 40/40
node server/matcher.test.js      # matcher 39/39
cd server && npm install && npm start   # 启动中转（端口 8080）
```
