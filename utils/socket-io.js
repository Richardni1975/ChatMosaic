// utils/socket-io.js
// 微信小程序 Socket.IO 客户端适配器
//
// 小程序 wx.connectSocket 走的是原生 WebSocket，
// 但 Render 代理对原生 WS 升级处理有时不可靠（体验版 vs 真机调试）。
// PC 端用的 Socket.IO（先 HTTP 轮询再升级）则稳定通过。
//
// 本模块在小程序端实现了最小化的 Engine.IO v4 + Socket.IO v4 协议，
// 通过 /socket.io/ 端点与服务端通信，与 PC 端协议完全一致，
// 消除传输层不兼容导致的跨端不通。

const EIO_VERSION = 4;

/**
 * 创建 Socket.IO 连接
 * @param {string} url  服务端基地址，如 https://chatmosaic-1.onrender.com
 * @param {object} opts  选项（保留兼容）
 * @returns {object}  { emit, on, disconnect, connected }
 */
function connect(url, opts) {
  const base = (url || '').replace(/\/+$/, '');
  const path = (opts && opts.path) || '/socket.io/';

  const handlers = {}; // eventName → [callback]
  let sock = null;      // wx.connectSocket 返回的 SocketTask
  let sid = null;       // Engine.IO session id
  let open = false;     // Socket.IO namespace connected
  let pingTimer = null;
  let pingInterval = 15000;
  let pingTimeout = 10000;
  let reconnectTimer = null;
  let manualClose = false;
  let disposed = false; // disconnect 后标记，阻止重连与后续回调
  let eioBuf = '';      // Engine.IO 帧缓冲（处理 TCP 分片）

  function on(evt, fn) {
    if (disposed) return;
    if (!handlers[evt]) handlers[evt] = [];
    handlers[evt].push(fn);
  }

  function emit(evt, data) {
    if (!open || !sock) return;
    // 完整字节 = EIO message(4) + SIO EVENT(2) + JSON
    // sendEio 已拼 EIO type，故 payload 只含 SIO 部分：'2' + JSON
    const payload = '2' + JSON.stringify([evt, data]);
    sendEio(4, payload);
  }

  function sendEio(type, payload) {
    if (!sock) return;
    const s = String(type) + (payload || '');
    sock.send({ data: s });
  }

  function trigger(evt, data) {
    if (disposed) return;
    const fns = handlers[evt];
    if (fns) fns.forEach((fn) => { try { fn(data); } catch (e) {} });
  }

  function startPing() {
    stopPing();
    pingTimer = setTimeout(() => {
      sendEio(2); // Engine.IO ping
      pingTimer = setTimeout(() => {
        // ping timeout — 断开重连
        console.warn('[socket-io] ping 超时，断开重连');
        teardown();
        scheduleReconnect();
      }, pingTimeout);
    }, pingInterval);
  }

  function stopPing() {
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
  }

  function scheduleReconnect() {
    if (manualClose || disposed) return;
    if (reconnectTimer) return;
    console.log('[socket-io] 3s 后重连…');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed) handshake();
    }, 3000);
  }

  /* ---- Engine.IO 帧解析 ---- */
  // 缓冲区管理：每个分支只移动 pos，循环末尾统一 eioBuf = eioBuf.slice(pos)。
  // 这样无论帧是单独到达还是粘包，都能正确消费，不会残留已处理字节导致重放。
  function onSockMessage(res) {
    const raw = typeof res.data === 'string' ? res.data : '';
    eioBuf += raw;

    // Engine.IO 帧格式: <type>[data]，type 为单个数字字符
    let pos = 0;
    while (pos < eioBuf.length) {
      const type = parseInt(eioBuf[pos], 10);
      if (isNaN(type)) { pos++; continue; }

      if (type === 2) {
        // 服务端心跳 Ping → 回 Pong
        sendEio(3);
        pos++;
        continue;
      }
      if (type === 3) {
        // Pong：可能是 upgrade probe 回执，也可能是我们自己 ping 的回应
        const rest = eioBuf.slice(pos + 1);
        if (rest.startsWith('probe')) {
          // 收到 probe pong → 发 upgrade 完成 transport 切换；
          // 随后发 Socket.IO CONNECT(40) 进入默认 namespace。
          // 顺序关键：必须先 5（upgrade）再 40，否则 _maybeUpgrade 会因
          // 收到非 probe/upgrade 包而 transport.close()。
          sendEio(5);
          sendEio(4, '0');
          pos += 1 + 5; // 消费 "3probe"
          continue;
        }
        pos++;
        continue;
      }
      if (type === 0) {
        // Open — 解析 0{...}（WS 通道一般不再发，保留兼容）
        const rest = eioBuf.slice(pos + 1);
        const jsonEnd = findJsonEnd(rest);
        if (jsonEnd < 0) break; // JSON 不完整，等待更多数据
        let data = {};
        try { data = JSON.parse(rest.slice(0, jsonEnd + 1)); } catch (e) { break; }
        sid = data.sid;
        pingInterval = data.pingInterval || 15000;
        pingTimeout = data.pingTimeout || 10000;
        pos += 1 + jsonEnd + 1;
        continue;
      }
      if (type === 4) {
        // Message — 包含 Socket.IO 帧
        const rest = eioBuf.slice(pos + 1);
        const parsed = parseSioFrame(rest);
        if (parsed === null) break; // 数据不完整，等待更多
        pos += 1 + parsed.consumed;
        handleSioPacket(parsed.type, parsed.data);
        continue;
      }
      // 未知类型，跳过
      pos++;
    }
    eioBuf = eioBuf.slice(pos);
  }

  /** 从字符串起始找 JSON 对象的结束位置（匹配花括号层级） */
  function findJsonEnd(s) {
    if (!s || s[0] !== '{') return -1;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1; // 对象未闭合
  }

  // consumed = 在 raw 中消费的字符数（含 sioType）：1 + JSON 长度。
  function parseSioFrame(raw) {
    if (raw.length < 1) return null;
    const sioType = parseInt(raw[0], 10);
    if (isNaN(sioType)) return null;
    const rest = raw.slice(1); // JSON 部分（可能为空，如 "40"）
    if (rest.length === 0) {
      return { type: sioType, data: null, consumed: 1 };
    }
    try {
      const arr = JSON.parse(rest);
      return { type: sioType, data: arr, consumed: 1 + rest.length };
    } catch (e) {
      return null; // JSON 不完整，等待更多
    }
  }

  function handleSioPacket(type, data) {
    // type: 0=CONNECT, 1=DISCONNECT, 2=EVENT, 3=ACK, 4=CONNECT_ERROR
    if (type === 0) {
      // CONNECTED to namespace
      open = true;
      startPing();
      return;
    }
    if (type === 1) {
      // DISCONNECT
      open = false;
      stopPing();
      scheduleReconnect();
      return;
    }
    if (type === 4) {
      // CONNECT_ERROR
      console.warn('[socket-io] 连接错误', data);
      return;
    }
    if (type === 2 && Array.isArray(data) && data.length >= 1) {
      // EVENT: data = [eventName, payload]
      const evt = data[0];
      const payload = data.length > 1 ? data[1] : null;
      trigger(evt, payload);
    }
  }

  /* ---- 连接生命周期 ---- */

  function teardown() {
    stopPing();
    open = false;
    if (sock) {
      try { sock.close({ code: 1000, reason: 'client' }); } catch (e) {}
      sock = null;
    }
    eioBuf = '';
  }

  function openWebSocket() {
    if (!sid) return;
    const wsUrl = base.replace(/^http/, 'ws') + path + '?EIO=' + EIO_VERSION + '&transport=websocket&sid=' + sid;
    console.log('[socket-io] 连接 WebSocket', wsUrl);

    sock = wx.connectSocket({ url: wsUrl });

    sock.onOpen(() => {
      console.log('[socket-io] ✅ WebSocket 已连接 (sid=' + sid + ')');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      // Engine.IO upgrade probe：WS 连上后必须先发 2probe → 收 3probe → 发 5，
      // 服务端才会把这条 WS 接受为正式 transport；否则 10s 后被强制关闭。
      sendEio(2, 'probe');
    });

    sock.onMessage(onSockMessage);

    sock.onError((err) => {
      console.error('[socket-io] ❌ WebSocket 错误', JSON.stringify(err));
    });

    sock.onClose((info) => {
      console.warn('[socket-io] WebSocket 关闭 code=' + (info && info.code), 'reason=' + (info && info.reason));
      stopPing();
      open = false;
      sock = null;
      if (!manualClose) scheduleReconnect();
    });
  }

  function handshake() {
    const pollUrl = base + path + '?EIO=' + EIO_VERSION + '&transport=polling';
    console.log('[socket-io] 握手', pollUrl);

    wx.request({
      url: pollUrl,
      method: 'GET',
      timeout: 15000,
      success: (res) => {
        if (res.statusCode !== 200) {
          console.error('[socket-io] 握手失败 HTTP', res.statusCode);
          scheduleReconnect();
          return;
        }
        const body = typeof res.data === 'string' ? res.data : '';
        // 解析 Engine.IO open 帧: 0{...}
        if (body.length < 2 || body[0] !== '0') {
          console.error('[socket-io] 握手响应格式异常', body.slice(0, 60));
          scheduleReconnect();
          return;
        }
        let openData;
        try { openData = JSON.parse(body.slice(1)); } catch (e) {
          console.error('[socket-io] 握手 JSON 解析失败');
          scheduleReconnect();
          return;
        }
        sid = openData.sid;
        pingInterval = openData.pingInterval || 15000;
        pingTimeout = openData.pingTimeout || 10000;
        console.log('[socket-io] 握手成功 sid=' + sid);
        openWebSocket();
      },
      fail: (err) => {
        console.error('[socket-io] 握手网络错误', JSON.stringify(err));
        scheduleReconnect();
      },
    });
  }

  function disconnect() {
    manualClose = true;
    disposed = true;
    stopPing();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    teardown();
    // 清空监听器，释放闭包引用，杜绝重连过程中残留回调误触发
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
