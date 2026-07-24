// server/smoke.test.js — 端到端回归测试（锁定当前核心功能）
//
// 启动真实 relay.js 子进程，用原生 ws（模拟小程序）+ Socket.IO（模拟 PC）双客户端
// 验证以下行为不被后续修改破坏：
//   1. 小程序 → PC 跨端分片拼图还原
//   2. PC → 小程序 跨端分片拼图还原
//   3. 实名 direct_msg 跨端透传
//   4. 心跳 ping/pong
//   5. 图片上传 imageUrl 从请求头自动推导（免 PUBLIC_URL）
//   6. 房间隔离（不同房间互不串消息）
//
// 运行：node smoke.test.js（已并入 npm test）

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { io } = require('socket.io-client');
const crypto = require('../utils/crypto.js');

const PORT = 8099;
const CHILD_ENV = { ...process.env, PORT: String(PORT), PUBLIC_URL: '', SILICONFLOW_API_KEY: '' };
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 客户端工厂 ---------- */

function wsClient(url) {
  const ws = new WebSocket(url);
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  function wait(pred, timeout = 4000) {
    return new Promise((resolve) => {
      let done = false;
      const h = (raw) => {
        if (done) return;
        let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (pred(m)) { done = true; ws.off('message', h); resolve(m); }
      };
      ws.on('message', h);
      setTimeout(() => { if (!done) { done = true; ws.off('message', h); resolve(null); } }, timeout);
    });
  }
  return { ws, ready, wait, send: (obj) => ws.send(JSON.stringify(obj)) };
}

function sioClient(url) {
  const s = io(url, { path: '/socket.io/', transports: ['websocket'] });
  const ready = new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
  function wait(pred, timeout = 4000) {
    return new Promise((resolve) => {
      let done = false;
      const h = (m) => { if (!done && pred(m)) { done = true; s.off('msg', h); resolve(m); } };
      s.on('msg', h);
      setTimeout(() => { if (!done) { done = true; s.off('msg', h); resolve(null); } }, timeout);
    });
  }
  return { s, ready, wait, emit: (ev, obj) => s.emit(ev, obj) };
}

function sendShards(sender, kind, text, mid) {
  const fr = crypto.splitMessage(text);
  fr.forEach((f, i) => {
    const shard = { type: 'shard', msgId: mid, matchHash: f.matchHash, index: f.index, channel: 'ch' + i, data: f.data, preview: f.preview };
    if (kind === 'ws') sender.send(shard); else sender.emit('msg', shard);
  });
}

/* ---------- 图片上传（Node fetch + FormData） ---------- */

// 用 http 模块手动构造 multipart，才能带上自定义 Host 头（fetch 禁止覆盖 Host）
function uploadImage(host) {
  return new Promise((resolve, reject) => {
    const boundary = '----smoke' + Math.random().toString(16).slice(2);
    const buf = Buffer.from(PNG_B64, 'base64');
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.png"\r\nContent-Type: image/png\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="roomCode"\r\n\r\n0000\r\n--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(parts);
    const req = http.request({
      host: 'localhost', port: PORT, path: '/upload', method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        Host: host,
        'X-Forwarded-Proto': 'https',
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ---------- 主流程 ---------- */

async function main() {
  const child = spawn('node', ['relay.js'], { cwd: __dirname, env: CHILD_ENV });
  child.stdout.on('data', (d) => process.stdout.write('[relay] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[relay.err] ' + d));

  // 等待服务就绪
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay 启动超时')), 8000);
    child.stdout.on('data', (d) => { if (d.toString().includes('中转服务已启动')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { if (code !== null) reject(new Error('relay 提前退出 code=' + code)); });
  });
  await sleep(300);

  const mp = wsClient(`ws://localhost:${PORT}/socket`);
  const pc = sioClient(`http://localhost:${PORT}`);
  await mp.ready; await pc.ready;
  mp.send({ type: 'join', roomCode: '0000' });
  pc.emit('join', { roomCode: '0000' });
  await mp.wait((m) => m.type === 'joined', 2000);
  await sleep(200);

  console.log('\n[1] 小程序 → PC 跨端分片拼图');
  const t1 = '跨端对讲测试 🔒';
  sendShards(mp, 'ws', t1, 'm1');
  {
    const a = await pc.wait((m) => m.type === 'assembled' && m.msgId === 'm1');
    const rec = a ? crypto.combineMessage(a.fragments) : '';
    assert('PC 收到 assembled 并还原原文', rec === t1, '得到:' + rec);
  }

  console.log('[2] PC → 小程序 跨端分片拼图');
  const t2 = '反向互通验证 ✅';
  sendShards(pc, 'sio', t2, 'm2');
  {
    const a = await mp.wait((m) => m.type === 'assembled' && m.msgId === 'm2');
    const rec = a ? crypto.combineMessage(a.fragments) : '';
    assert('小程序收到 assembled 并还原原文', rec === t2, '得到:' + rec);
  }

  console.log('[3] 实名 direct_msg 跨端透传');
  pc.emit('msg', { type: 'direct_msg', msgId: 'd1', text: '实名问候', userName: 'PC-1', isAnonymous: false, timestamp: Date.now() });
  {
    const d = await mp.wait((m) => m.type === 'direct_msg' && m.msgId === 'd1');
    assert('小程序收到 direct_msg 文本', d && d.text === '实名问候', '');
  }

  console.log('[4] 心跳 ping/pong');
  mp.send({ type: 'ping' });
  {
    const p = await mp.wait((m) => m.type === 'pong', 2000);
    assert('收到 pong 回执', !!p, '');
  }

  console.log('[5] 图片上传 imageUrl 自动推导');
  {
    const r = await uploadImage('chatmosaic-1.onrender.com');
    assert('imageUrl 从 Host 头推导为公网地址', r && typeof r.imageUrl === 'string' && r.imageUrl.startsWith('https://chatmosaic-1.onrender.com/uploads/'), '得到:' + (r && r.imageUrl));
  }

  console.log('[6] 房间隔离');
  const mp2 = wsClient(`ws://localhost:${PORT}/socket`);
  await mp2.ready;
  mp2.send({ type: 'join', roomCode: '1111' });
  await sleep(300);
  pc.emit('msg', { type: 'direct_msg', msgId: 'd2', text: '房间0000的消息', userName: 'PC-1', isAnonymous: false, timestamp: Date.now() });
  {
    const leaked = await mp2.wait((m) => m.type === 'direct_msg' && m.msgId === 'd2', 1500);
    assert('房间 1111 收不到 0000 的消息', leaked === null, '串房了！');
  }

  // 收尾
  pc.s.close(); mp.ws.close(); mp2.ws.close();
  child.kill();

  console.log(`\n[smoke.test] 通过 ${passed}/${passed + failed}` + (failed ? `，失败 ${failed}` : ' ✅'));
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('\n[smoke.test] 异常:', e.message);
  process.exit(1);
});
