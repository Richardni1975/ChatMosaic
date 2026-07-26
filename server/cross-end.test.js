// server/cross-end.test.js — 真实跨端互通测试
//
// 现有 smoke.test.js 用原生 ws('/socket') 模拟小程序，但真实小程序代码已改用
// utils/socket-io.js（Socket.IO 协议，/socket.io/）。本测试 mock 掉 wx API，
// 用「真实的 utils/socket-io.js 适配器」连服务端，PC 端用 socket.io-client，
// 验证真实跨端链路：握手 → 进房 → 分片拼图双向互通 → 实名直发。
//
// 运行：node cross-end.test.js

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const { io } = require('socket.io-client');
const crypto = require('../utils/crypto.js');

const PORT = 8098;
const CHILD_ENV = { ...process.env, PORT: String(PORT), PUBLIC_URL: '', SILICONFLOW_API_KEY: '' };
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- mock wx 全局，让 utils/socket-io.js 在 Node 里跑 ---------- */
function installWxMock() {
  const taskMap = new WeakMap();
  function makeTask(wsUrl) {
    // wsUrl 形如 ws://host/socket.io/?EIO=4&transport=websocket&sid=xxx
    const ws = new WebSocket(wsUrl);
    const task = {
      _ws: ws,
      _handlers: { open: [], message: [], error: [], close: [] },
      onOpen(fn) { this._handlers.open.push(fn); },
      onMessage(fn) { this._handlers.message.push(fn); },
      onError(fn) { this._handlers.error.push(fn); },
      onClose(fn) { this._handlers.close.push(fn); },
      send(obj) { ws.send(obj.data); },
      close(opts) { try { ws.close(1000, opts && opts.reason); } catch (e) {} },
    };
    ws.on('open', () => task._handlers.open.forEach((f) => { try { f(); } catch (e) {} }));
    ws.on('message', (data) => task._handlers.message.forEach((f) => { try { f({ data: data.toString() }); } catch (e) {} }));
    ws.on('error', (err) => task._handlers.error.forEach((f) => { try { f({ errMsg: err.message }); } catch (e) {} }));
    ws.on('close', (code, reason) => task._handlers.close.forEach((f) => { try { f({ code, reason: reason.toString() }); } catch (e) {} }));
    return task;
  }

  global.wx = {
    connectSocket(opts) { return makeTask(opts.url); },
    request(opts) {
      // 模拟 polling GET
      http.get(opts.url, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (opts.success) opts.success({ statusCode: res.statusCode, data: body });
        });
      }).on('error', (err) => { if (opts.fail) opts.fail({ errMsg: err.message }); });
    },
  };
}

installWxMock();
const socketIO = require('../utils/socket-io.js');

/* ---------- 真实小程序适配器客户端 ---------- */
function miniClient(url) {
  const sio = socketIO.connect(url, { path: '/socket.io/' });
  const handlers = {};
  sio.on('msg', (m) => { (handlers['msg'] || []).forEach((f) => f(m)); });
  sio.on('joined', (m) => { (handlers['joined'] || []).forEach((f) => f(m)); });
  function wait(pred, timeout = 5000) {
    return new Promise((resolve) => {
      let done = false;
      const h = (m) => { if (!done && pred(m)) { done = true; resolve(m); } };
      handlers['msg'] = (handlers['msg'] || []);
      handlers['msg'].push(h);
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
    });
  }
  return {
    sio,
    wait,
    emit: (ev, data) => sio.emit(ev, data),
    get connected() { return sio.connected; },
  };
}

function sendShards(sender, text, mid) {
  const fr = crypto.splitMessage(text);
  fr.forEach((f, i) => {
    sender.emit('msg', { type: 'shard', msgId: mid, matchHash: f.matchHash, index: f.index, channel: 'ch' + i, data: f.data, preview: f.preview });
  });
}

async function main() {
  const child = spawn('node', ['relay.js'], { cwd: __dirname, env: CHILD_ENV });
  child.stdout.on('data', (d) => process.stdout.write('[relay] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[relay.err] ' + d));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay 启动超时')), 8000);
    child.stdout.on('data', (d) => { if (d.toString().includes('中转服务已启动')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { if (code !== null) reject(new Error('relay 提前退出 code=' + code)); });
  });
  await sleep(300);

  console.log('\n[0] 真实小程序适配器握手 /socket.io/ + 进房');
  const mp = miniClient(BASE);
  // 等待适配器握手完成（polling → ws upgrade → 40 CONNECT）
  let handshook = false;
  for (let i = 0; i < 50; i++) { if (mp.connected) { handshook = true; break; } await sleep(200); }
  assert('小程序适配器 Socket.IO 握手成功', handshook, '5s 内未 connected');

  if (!handshook) {
    console.log('\n[cross-end] 握手失败，终止后续测试');
    child.kill(); process.exit(1);
  }

  mp.emit('join', { roomCode: '0000' });
  const pc = io(`http://localhost:${PORT}`, { path: '/socket.io/', transports: ['websocket'] });
  await new Promise((r, rej) => { pc.on('connect', r); pc.on('connect_error', rej); });
  pc.emit('join', { roomCode: '0000' });
  await sleep(300);

  console.log('\n[1] 小程序(真实适配器) → PC 跨端分片拼图');
  const t1 = '真实链路 🔒 小程序发';
  sendShards(mp, t1, 'r1');
  {
    const a = await new Promise((resolve) => {
      let done = false;
      const h = (m) => { if (!done && m.type === 'assembled' && m.msgId === 'r1') { done = true; pc.off('msg', h); resolve(m); } };
      pc.on('msg', h);
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, 5000);
    });
    const rec = a ? crypto.combineMessage(a.fragments) : '';
    assert('PC 收到 assembled 并还原原文', rec === t1, '得到:' + rec);
  }

  console.log('[2] PC → 小程序(真实适配器) 跨端分片拼图');
  const t2 = '反向互通 ✅ PC 发';
  sendShards({ emit: (ev, data) => pc.emit(ev, data) }, t2, 'r2');
  {
    const a = await mp.wait((m) => m.type === 'assembled' && m.msgId === 'r2', 5000);
    const rec = a ? crypto.combineMessage(a.fragments) : '';
    assert('小程序收到 assembled 并还原原文', rec === t2, '得到:' + rec);
  }

  console.log('[3] PC → 小程序 实名 direct_msg');
  pc.emit('msg', { type: 'direct_msg', msgId: 'rd1', text: '实名问候', userName: 'PC-1', isAnonymous: false, timestamp: Date.now() });
  {
    const d = await mp.wait((m) => m.type === 'direct_msg' && m.msgId === 'rd1', 5000);
    assert('小程序收到 direct_msg 文本', d && d.text === '实名问候', '');
  }

  console.log('[4] 小程序 → PC 实名 direct_msg');
  mp.emit('msg', { type: 'direct_msg', msgId: 'rd2', text: '小程序实名', userName: 'MP-1', isAnonymous: false, timestamp: Date.now() });
  {
    const d = await new Promise((resolve) => {
      let done = false;
      const h = (m) => { if (!done && m.type === 'direct_msg' && m.msgId === 'rd2') { done = true; pc.off('msg', h); resolve(m); } };
      pc.on('msg', h);
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, 5000);
    });
    assert('PC 收到 direct_msg 文本', d && d.text === '小程序实名', '');
  }

  console.log('[5] 多设备同房间并发：2 台小程序 + 1 台 PC，每台各发 1 条，验证三方互收');
  const mp2 = miniClient(BASE);
  for (let i = 0; i < 50; i++) { if (mp2.connected) break; await sleep(200); }
  mp2.emit('join', { roomCode: '0000' });
  await sleep(300);

  // 每台收集另外两台的 msgId
  const wantFor = { mp: ['d-MP2', 'd-PC'], mp2: ['d-MP1', 'd-PC'], pc: ['d-MP1', 'd-MP2'] };
  function collector(client, want) {
    const got = new Set();
    return {
      got: () => got.size,
      install() {
        const h = (m) => { if (m.type === 'direct_msg' && want.includes(m.msgId)) got.add(m.msgId); };
        client.sio.on('msg', h);
      },
    };
  }
  const c1 = collector(mp, wantFor.mp); c1.install();
  const c2 = collector(mp2, wantFor.mp2); c2.install();
  const cpc = collector({ sio: { on: (ev, h) => pc.on(ev, h) } }, wantFor.pc); cpc.install();

  // 三方各发一条 direct_msg
  mp.emit('msg', { type: 'direct_msg', msgId: 'd-MP1', text: '来自设备1', userName: 'MP-1', isAnonymous: false, timestamp: Date.now() });
  mp2.emit('msg', { type: 'direct_msg', msgId: 'd-MP2', text: '来自设备2', userName: 'MP-2', isAnonymous: false, timestamp: Date.now() });
  pc.emit('msg', { type: 'direct_msg', msgId: 'd-PC', text: '来自PC', userName: 'PC-1', isAnonymous: false, timestamp: Date.now() });

  await sleep(3500);
  assert('设备1 收到其他两台的消息', c1.got() === 2, '收到 ' + c1.got() + '/2');
  assert('设备2 收到其他两台的消息', c2.got() === 2, '收到 ' + c2.got() + '/2');
  assert('PC 收到其他两台的消息', cpc.got() === 2, '收到 ' + cpc.got() + '/2');

  console.log('[6] 房间隔离：另一台进 9999，收不到 0000 的消息');
  const mp3 = miniClient(BASE);
  for (let i = 0; i < 50; i++) { if (mp3.connected) break; await sleep(200); }
  mp3.emit('join', { roomCode: '9999' });
  await sleep(300);
  let leaked = null;
  const leakH = (m) => { if (m.type === 'direct_msg' && m.msgId === 'd-leak') leaked = m; };
  mp3.sio.on('msg', leakH);
  pc.emit('msg', { type: 'direct_msg', msgId: 'd-leak', text: '房间0000消息', userName: 'PC-1', isAnonymous: false, timestamp: Date.now() });
  await sleep(2000);
  assert('房间 9999 收不到 0000 的消息', leaked === null, '串房了！');

  pc.close();
  try { mp.sio.disconnect(); } catch (e) {}
  try { mp2.sio.disconnect(); } catch (e) {}
  try { mp3.sio.disconnect(); } catch (e) {}
  child.kill();
  try { mp.sio.disconnect(); } catch (e) {}
  try { mp2.sio.disconnect(); } catch (e) {}
  child.kill();

  console.log(`\n[cross-end] 通过 ${passed}/${passed + failed}` + (failed ? `，失败 ${failed}` : ' ✅'));
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('\n[cross-end] 异常:', e.message);
  process.exit(1);
});
