// server/relay.js
// Phase 2/3/4 + PC Web 跨端：双传输中转服务。
//
// 传输：
// - Socket.IO（path /socket.io/）：PC 浏览器端，按 roomId 进房。
// - 原生 ws（path /）：微信小程序端（不改 pages/），统一进入默认房间 DEFAULT_ROOM。
// 同一 httpServer，两路径互不干扰；两端共用 matcher 核心与同一房间，实现跨端互通。
//
// 房间寻址：按 client.room 路由广播。小程序端不发 roomId → DEFAULT_ROOM('0000')；
// PC 输入 0000 即可与小程序端跨端对讲，其他码为 PC 独立房间。
//
// 严格遵守 CLAUDE.md：纯内存 / 零留存 / 无日志（只打印连接数与聚合计数）/ 无身份映射。
// matcher.js 保持纯函数不变，单测 39/39 不受影响。
//
// 启动：npm install && npm start      测试：npm test      PC 页面：http://localhost:8080/

const http = require('http');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { WebSocket, WebSocketServer } = require('ws');
const { Server } = require('socket.io');
const { createState, ingestShard, expireBuckets, jitterDelay } = require('./matcher.js');
const config = require('./config.js');
const { cleanupOldFiles } = require('./cleanup.js');

const { PORT, PUBLIC_URL, MAX_AGE_HOURS, SILICONFLOW_API_KEY } = config;
const DEFAULT_ROOM = '0000';            // 小程序端未传 roomId，统一进默认房间
const SWEEP_INTERVAL_MS = 15 * 1000;
const DECOY_PERIOD_MIN_MS = 3000;
const DECOY_PERIOD_MAX_MS = 8000;
const DECOY_ON_SHARD_PROB = 0.3;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const ALLOWED_IMG_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时扫描一次上传目录
const MAX_IMAGE_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1000; // 默认 24h

const CHANNELS = ['ch0', 'ch1', 'ch2', 'ch3'];
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const ROOT_DIR = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const state = createState();
const rooms = new Map(); // roomId -> Set<client>
let connections = 0;
let decoyCount = 0;

/* ---------- 工具 ---------- */

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes; i++) s += randInt(0, 255).toString(16).padStart(2, '0');
  return s;
}

function normalizeRoom(code) {
  return /^\d{4}$/.test(String(code)) ? String(code) : DEFAULT_ROOM;
}

/* ---------- 房间管理 ---------- */

function roomOf(roomId) {
  let r = rooms.get(roomId);
  if (!r) { r = new Set(); rooms.set(roomId, r); }
  return r;
}

function joinRoom(client, roomId) {
  if (client.room) {
    const old = rooms.get(client.room);
    if (old) old.delete(client);
  }
  client.room = roomId;
  roomOf(roomId).add(client);
}

function leaveRoom(client) {
  if (client.room) {
    const r = rooms.get(client.room);
    if (r) r.delete(client);
    client.room = null;
  }
}

/** 向房间内所有客户端（跨传输）广播，按各自传输序列化 */
function broadcastToRoom(roomId, obj) {
  const r = rooms.get(roomId);
  if (!r) return;
  for (const c of r) {
    try { c.send(obj); } catch (e) {}
  }
}

/* ---------- Jitter Buffer：出站随机延迟，打乱时序 ---------- */

function scheduleSend(roomId, payload) {
  const delay = jitterDelay(); // 50–250ms
  // 载荷仅在闭包中存活至 flush（≤250ms），随后即被 GC，零留存
  setTimeout(() => broadcastToRoom(roomId, payload), delay);
}

/* ---------- 诱饵混淆包：不可凑齐的虚假 shard-seen ---------- */

function emitDecoy(roomId) {
  const i = randInt(0, 3);
  const decoy = {
    type: 'shard-seen',
    isDecoy: true,
    msgId: 'decoy-' + randHex(6),
    matchHash: randHex(32),
    channel: CHANNELS[i],
    index: i,
    preview: '0x' + randInt(0, 255).toString(16).toUpperCase().padStart(2, '0'),
    count: randInt(1, 3), // 永远 <4，绝不可凑齐
  };
  decoyCount++;
  scheduleSend(roomId, decoy);
}

function schedulePeriodicDecoy() {
  for (const roomId of rooms.keys()) emitDecoy(roomId);
  setTimeout(schedulePeriodicDecoy, randInt(DECOY_PERIOD_MIN_MS, DECOY_PERIOD_MAX_MS));
}

/* ---------- 统一消息处理（ws 与 sio 共用） ---------- */

function handleMessage(client, msg) {
  if (!msg) return;

  // 进房：原生 ws 客户端（小程序）按 roomCode 加入房间（默认 0000）
  if (msg.type === 'join') {
    const code = normalizeRoom(msg.roomCode);
    joinRoom(client, code);
    client.send({ type: 'joined', roomCode: code });
    return;
  }

  // 心跳保活：静默回复 pong（仅回发送者，不广播、不日志）
  if (msg.type === 'ping') {
    client.send({ type: 'pong' });
    return;
  }

  // 实名直发：跳过 matcher 与 Jitter，直接透传至本房间，无日志
  if (msg.type === 'direct_msg') {
    broadcastToRoom(client.room, msg);
    return;
  }

  if (msg.type !== 'shard') return;

  // 入站 decoy 在 matcher 内即被忽略（不建桶）；真实碎片走匹配
  const { seen, broadcast } = ingestShard(state, msg);

  if (seen) {
    scheduleSend(client.room, { type: 'shard-seen', ...seen }); // 不含 data
    if (Math.random() < DECOY_ON_SHARD_PROB) emitDecoy(client.room);
  }

  if (broadcast) {
    scheduleSend(client.room, { type: 'assembled', ...broadcast });
    console.log(`[momo-relay] 已中转聚合 ${state.assembledCount} 条`); // 仅计数
  }
}

/* ---------- HTTP 静态服务（PC 页面 + 复用 utils/crypto.js） ---------- */

function serveStatic(req, res) {
  if (res.headersSent || req.url.startsWith('/socket.io/')) return;
  const urlPath = req.url.split('?')[0];
  let filePath;
  if (urlPath === '/') filePath = path.join(PUBLIC_DIR, 'index.html');
  else if (urlPath.startsWith('/utils/')) filePath = path.join(ROOT_DIR, urlPath);
  else filePath = path.join(PUBLIC_DIR, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- 图片上传（HTTP Multipart，独立于 WebSocket） ---------- */

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, Date.now() + '-' + randHex(4) + ext);
    },
  }),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMG_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error('FORMAT'));
  },
});

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function handleUpload(req, res) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件超过 2MB' : (err.message === 'FORMAT' ? '仅支持 JPG/PNG/WebP' : '上传失败');
      return json(res, 400, { error: msg });
    }
    const f = req.file;
    if (!f) return json(res, 400, { error: '未收到文件' });

    // 后端二次校验：后缀 + MIME + 大小
    const ext = path.extname(f.originalname).toLowerCase();
    if (!ALLOWED_IMG_EXT.includes(ext) || !ALLOWED_IMG_MIME.includes(f.mimetype) || f.size > MAX_IMAGE_BYTES) {
      fs.unlink(f.path, () => {});
      return json(res, 400, { error: '校验失败：格式或大小不符' });
    }

    const imageUrl = PUBLIC_URL + '/uploads/' + f.filename;
    const body = req.body || {};
    const roomCode = normalizeRoom(body.roomCode);
    const isAnonymous = String(body.isAnonymous) !== 'false';
    const payload = {
      type: 'image',
      msgId: 'img-' + randHex(6),
      imageUrl,
      userName: body.userName || '',
      isAnonymous,
      timestamp: Date.now(),
    };
    // 仅广播图片 URL（小 JSON），二进制已落盘 public/uploads/，绝不走 WebSocket
    broadcastToRoom(roomCode, payload);
    console.log(`[momo-relay] 图片上传 ${imageUrl} → 房间 ${roomCode}（${f.size}B）`);
    json(res, 200, { ok: true, imageUrl });
  });
}

/* ---------- 语音转文字 STT（后端接力 → 硅基流动 SenseVoice） ---------- */
// 隐私：音频仅在内存中转给 SiliconFlow，服务端不落盘、不留存、不打印内容。

const STT_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const STT_MODEL = 'FunAudioLLM/SenseVoice-Small';
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10MB

const sttUpload = multer({
  storage: multer.memoryStorage(), // 内存暂存，不落盘
  limits: { fileSize: MAX_AUDIO_BYTES },
});

async function callSiliconFlowSTT(audioBuffer, originalname, mimetype) {
  const form = new FormData();
  form.append('model', STT_MODEL);
  form.append('file', new Blob([audioBuffer], { type: mimetype || 'audio/mpeg' }), originalname || 'audio.mp3');
  const resp = await fetch(STT_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SILICONFLOW_API_KEY },
    body: form,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data && (data.error && data.error.message) || data.message) || ('HTTP ' + resp.status);
    throw new Error(msg);
  }
  return data;
}

function handleSTT(req, res) {
  sttUpload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '音频超过 10MB' : '音频上传失败';
      return json(res, 400, { error: msg });
    }
    const f = req.file;
    if (!f || !f.buffer) return json(res, 400, { error: '未收到音频' });
    if (!SILICONFLOW_API_KEY) {
      return json(res, 500, { error: '服务端未配置 SILICONFLOW_API_KEY' });
    }
    try {
      const data = await callSiliconFlowSTT(f.buffer, f.originalname, f.mimetype);
      const text = (data && typeof data.text === 'string') ? data.text : '';
      // 仅打印长度，绝不打印识别内容（无日志原则）
      console.log(`[momo-relay] STT 完成 ${f.size}B → ${text.length} 字`);
      json(res, 200, { ok: true, text });
    } catch (e) {
      console.warn('[momo-relay] STT 失败:', e.message);
      json(res, 502, { error: '语音识别失败：' + e.message });
    }
    // f.buffer 出作用域即被 GC，内存零留存
  });
}

/* ---------- 服务装配 ---------- */

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (req.method === 'POST' && urlPath === '/upload') return handleUpload(req, res);
  if (req.method === 'POST' && urlPath === '/api/stt') return handleSTT(req, res);
  serveStatic(req, res);
});

// Socket.IO（PC 端），path /socket.io/
const io = new Server(httpServer, {
  path: '/socket.io/',
  cors: { origin: '*' },
  serveClient: true, // 自带 /socket.io/socket.io.min.js，PC 同源加载，免外部 CDN
  pingInterval: 15000,
  pingTimeout: 10000,
});

io.on('connection', (sio) => {
  connections++;
  const client = {
    transport: 'sio',
    room: DEFAULT_ROOM,
    send: (obj) => { sio.emit('msg', obj); },
  };
  roomOf(DEFAULT_ROOM).add(client);
  console.log(`[momo-relay] Socket.IO 连接，当前连接数 ${connections}`);

  sio.on('join', (payload) => {
    const code = normalizeRoom(payload && payload.roomCode);
    joinRoom(client, code);
    sio.emit('joined', { roomCode: code });
    console.log(`[momo-relay] PC 加入房间 ${code}`);
  });

  sio.on('msg', (obj) => handleMessage(client, obj));

  sio.on('disconnect', () => {
    leaveRoom(client);
    connections = Math.max(0, connections - 1);
    console.log(`[momo-relay] Socket.IO 断开，当前连接数 ${connections}`);
  });
});

// 原生 ws（小程序端）：noServer 模式，手动只接管 path '/' 的 upgrade。
// 不能用 { server } + path:'/' —— ws 的 upgrade 监听器会无条件 handleUpgrade，
// 对 /socket.io/ 路径调用 abortHandshake(400)，向已升级的 Socket.IO socket 写入
// HTTP 400 字节，导致浏览器端「Invalid frame header」。noServer 仅处理自己的路径，
// 其余 upgrade 交给 Engine.IO 自身监听器。
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];
  // 小程序原生 ws：接受根路径（本地调试）与 /socket（生产 WSS 显式路径）
  if (pathname === '/' || pathname === '/socket') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  // /socket.io/ 等其他路径不处理，由 Socket.IO 的 upgrade 监听器接管
});

wss.on('connection', (ws) => {
  connections++;
  const client = {
    transport: 'ws',
    room: DEFAULT_ROOM,
    send: (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
  };
  roomOf(DEFAULT_ROOM).add(client);
  console.log(`[momo-relay] 小程序连接，当前连接数 ${connections}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    handleMessage(client, msg);
  });

  ws.on('close', () => {
    leaveRoom(client);
    connections = Math.max(0, connections - 1);
    console.log(`[momo-relay] 小程序断开，当前连接数 ${connections}`);
  });

  ws.on('error', () => {});
});

// 周期清理超时未集齐的桶（不广播、不 seen）
setInterval(() => expireBuckets(state), SWEEP_INTERVAL_MS);

// 24 小时图片自动清理：每小时扫描 public/uploads/，超时物理删除（保留 .gitkeep）
function runCleanup() {
  cleanupOldFiles(UPLOAD_DIR, MAX_IMAGE_AGE_MS)
    .then((r) => { if (r.deleted > 0) console.log(`[momo-relay] 清理过期图片 ${r.deleted} 个`); })
    .catch(() => {});
}
setInterval(runCleanup, CLEANUP_INTERVAL_MS);
runCleanup(); // 启动即清理一次

// 启动周期 decoy 注入
schedulePeriodicDecoy();

httpServer.listen(PORT, () => {
  console.log(`[momo-relay] 中转服务已启动，端口 ${PORT}`);
  console.log(`  · PC 页面:   http://localhost:${PORT}/`);
  console.log(`  · Socket.IO: ws://localhost:${PORT}/socket.io/`);
  console.log(`  · 小程序 ws: ws://localhost:${PORT}/  (默认房间 ${DEFAULT_ROOM})`);
  console.log(`  · 图片 URL:  ${PUBLIC_URL}/uploads/  (存活 ${MAX_AGE_HOURS}h 自动清理)`);
  console.log(`  （纯内存 · 无日志 · 零留存 · Jitter+Decoy · 房间路由）`);
});
