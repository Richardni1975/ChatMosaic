// utils/socket-io.js
// 微信小程序 Socket.IO 客户端适配器（polling-only 传输）
//
// 为什么不用 WebSocket(wss)：
// Render 等海外托管 + 国内真机网络，wss 长连接经常 code=1006 超时连不上
// （onOpen 都触发不了），而 HTTPS 短请求（polling）稳定可达。
// Socket.IO 协议原生支持 polling 传输，与 PC 端 wss 走同一服务端、同一房间，
// 跨端互通不受影响。
//
// Engine.IO v4 polling 帧格式（与 wss 不同）：
// - 单包：直接 <packet>，无长度前缀（如 "40"、"2"）
// - 多包：用 \x1E (Record Separator) 分隔拼接
// - GET ?transport=polling&sid=xxx：long-poll 接收（服务端 hold ~25s）
// - POST ?transport=polling&sid=xxx body=<packet>：发送
//
// 严格遵守 CLAUDE.md：纯内存中转、零留存、无身份映射（本模块仅客户端传输）。

const EIO_VERSION = 4;
const RECORD_SEP = '\x1e';

/**
 * 创建 Socket.IO 连接（polling-only）
 * @param {string} url  服务端基地址，如 https://chatmosaic-1.onrender.com
 * @param {object} opts  选项（保留兼容，path 默认 /socket.io/）
 * @returns {object}  { emit, on, disconnect, connected }
 */
function connect(url, opts) {
  const base = (url || '').replace(/\/+$/, '');
  const path = (opts && opts.path) || '/socket.io/';

  const handlers = {}; // eventName → [callback]
  let sid = null;            // Engine.IO session id
  let open = false;          // Socket.IO namespace connected
  let disposed = false;
  let reconnectTimer = null;

  let polling = false;       // GET long-poll 是否在途
  let posting = false;       // POST 是否在途
  const sendQueue = [];      // 待发送的 packet（串行 POST，支持批量）

  function on(evt, fn) {
    if (disposed) return;
    if (!handlers[evt]) handlers[evt] = [];
    handlers[evt].push(fn);
  }

  function emit(evt, data) {
    if (!open || disposed) return;
    // EIO message(4) + SIO EVENT(2) + JSON → "42[event,data]"
    // 此前漏了 EIO type 4，服务端把 "2[...]" 当作带 data 的 ping → transport error
    const pkt = '42' + JSON.stringify([evt, data]);
    queueSend(pkt);
  }

  function trigger(evt, data) {
    if (disposed) return;
    const fns = handlers[evt];
    if (fns) fns.forEach((fn) => { try { fn(data); } catch (e) {} });
  }

  /* ---- 发送（POST polling）---- */
  // 多个 packet 用 \x1e 拼接一次性 POST，减少 HTTP 往返
  function queueSend(pkt) {
    if (disposed || !sid) return;
    sendQueue.push(pkt);
    flushSend();
  }

  function flushSend() {
    if (posting || disposed || !sid || sendQueue.length === 0) return;
    const mySid = sid;
    const batch = sendQueue.splice(0, sendQueue.length);
    const body = batch.join(RECORD_SEP);
    posting = true;
    wx.request({
      url: base + path + '?EIO=' + EIO_VERSION + '&transport=polling&sid=' + mySid,
      method: 'POST',
      data: body,
      header: { 'Content-Type': 'text/plain;charset=UTF-8' },
      timeout: 20000,
      success: (res) => {
        posting = false;
        if (disposed || sid !== mySid) return;
        if (res.statusCode !== 200) {
          // 400 通常是 sid 失效，触发重连
          if (res.statusCode === 400) scheduleReconnect();
        }
        flushSend();
      },
      fail: () => {
        posting = false;
        if (disposed || sid !== mySid) return;
        // POST 失败不直接重连，pollLoop 兜底；但把 packet 丢回队列重试一次
        if (sendQueue.length === 0) {
          sendQueue.unshift(...batch);
          setTimeout(flushSend, 1000);
        }
      },
    });
  }

  /* ---- 接收（GET long-poll 循环）---- */
  function pollLoop() {
    if (disposed || !sid || polling) return;
    const mySid = sid;
    polling = true;
    wx.request({
      url: base + path + '?EIO=' + EIO_VERSION + '&transport=polling&sid=' + mySid,
      method: 'GET',
      timeout: 35000, // > 服务端 long-poll hold(~25s)
      success: (res) => {
        polling = false;
        if (disposed || sid !== mySid) return;
        if (res.statusCode !== 200) {
          scheduleReconnect();
          return;
        }
        const body = typeof res.data === 'string' ? res.data : '';
        if (body) {
          const pkts = body.split(RECORD_SEP);
          for (const p of pkts) if (p) handleEioPacket(p);
        }
        pollLoop(); // 立即发起下一轮
      },
      fail: () => {
        polling = false;
        if (disposed || sid !== mySid) return;
        scheduleReconnect();
      },
    });
  }

  /* ---- Engine.IO 帧处理 ---- */
  function handleEioPacket(pkt) {
    const t = parseInt(pkt[0], 10);
    if (isNaN(t)) return;
    if (t === 2) {
      // 服务端 ping → 回 pong
      queueSend('3');
      return;
    }
    if (t === 3 || t === 6) {
      // pong / noop，忽略
      return;
    }
    if (t === 4) {
      // message → Socket.IO 帧
      handleSioPacket(pkt.slice(1));
      return;
    }
    if (t === 1) {
      // Engine.IO close
      open = false;
      scheduleReconnect();
      return;
    }
    if (t === 0) {
      // OPEN（polling 模式下 handshake 已处理，忽略重复）
      return;
    }
  }

  function handleSioPacket(s) {
    if (!s) return;
    const t = parseInt(s[0], 10);
    if (isNaN(t)) return;
    if (t === 0) {
      // CONNECT 确认 → namespace 已连接
      open = true;
      console.log('[socket-io] ✅ namespace connected (polling)');
      trigger('connect');
      return;
    }
    if (t === 1) {
      // DISCONNECT
      open = false;
      scheduleReconnect();
      return;
    }
    if (t === 4) {
      console.warn('[socket-io] CONNECT_ERROR', s.slice(1));
      return;
    }
    if (t === 2) {
      // EVENT: s = '2["event",payload]'
      try {
        const arr = JSON.parse(s.slice(1));
        if (Array.isArray(arr) && arr.length >= 1) {
          trigger(arr[0], arr.length > 1 ? arr[1] : null);
        }
      } catch (e) {}
      return;
    }
  }

  /* ---- 连接生命周期 ---- */
  function handshake() {
    if (disposed) return;
    console.log('[socket-io] polling 握手', base + path);
    wx.request({
      url: base + path + '?EIO=' + EIO_VERSION + '&transport=polling',
      method: 'GET',
      timeout: 60000, // Render 免费实例冷启动需 30–60s
      success: (res) => {
        if (disposed) return;
        if (res.statusCode !== 200) {
          console.warn('[socket-io] 握手 HTTP', res.statusCode);
          scheduleReconnect();
          return;
        }
        const body = typeof res.data === 'string' ? res.data : '';
        const pkts = body.split(RECORD_SEP);
        const openPkt = pkts.find((p) => p && p[0] === '0');
        if (!openPkt) {
          console.warn('[socket-io] 握手响应无 OPEN 帧', body.slice(0, 80));
          scheduleReconnect();
          return;
        }
        let d;
        try { d = JSON.parse(openPkt.slice(1)); } catch (e) {
          console.warn('[socket-io] 握手 JSON 解析失败');
          scheduleReconnect();
          return;
        }
        sid = d.sid;
        console.log('[socket-io] 握手成功 sid=' + sid);
        queueSend('40'); // Socket.IO CONNECT
        pollLoop();
      },
      fail: (err) => {
        if (disposed) return;
        console.warn('[socket-io] 握手网络错误', JSON.stringify(err));
        scheduleReconnect();
      },
    });
  }

  function scheduleReconnect() {
    if (disposed) return;
    if (reconnectTimer) return;
    open = false;
    // 清 sid：在途的 GET/POST 响应回来时 sid!==mySid 会被丢弃
    sid = null;
    polling = false;
    posting = false;
    sendQueue.length = 0;
    console.log('[socket-io] 3s 后重连…');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed) handshake();
    }, 3000);
  }

  function disconnect() {
    disposed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    open = false;
    sid = null;
    polling = false;
    posting = false;
    sendQueue.length = 0;
    Object.keys(handlers).forEach((k) => { delete handlers[k]; });
  }

  // 启动
  handshake();

  return {
    get connected() { return open; },
    on,
    emit,
    disconnect,
  };
}

module.exports = { connect };
