// pages/room/index.js — Phase 1/2/3
// 三段式 UI + 语音识别 + 客户端分片 / 中转拼图重组 + 可视化信任动效

const crypto = require('../../utils/crypto.js'); // Phase 2 客户端 XOR 分片
const delay = require('../../utils/delay.js');   // Phase 4 stub
const clientConfig = require('../../utils/client-config.js'); // 开发/生产地址切换

// Phase 2：WebSocket 中转服务地址（由 utils/client-config.js 统一配置）
// 本地：ws://localhost:8080；生产：wss://api-mosaic.m0m0n1.top/socket
const RELAY_URL = clientConfig.relayUrl;

// WebSocket 生命周期参数
const HEARTBEAT_INTERVAL_MS = 15000;   // 心跳保活间隔
const MAX_RECONNECT = 6;               // 最大重连次数
const RECONNECT_BASE_DELAY_MS = 2000;  // 重连基础延迟（指数退避）
const RECONNECT_MAX_DELAY_MS = 30000;  // 重连延迟上限

// 录音参数：60s 上限，对齐微信「按住说话」语音消息时长
const MAX_RECORD_MS = 60000;

const CHANNELS = ['ch0', 'ch1', 'ch2', 'ch3'];

let recorderManager = null; // 底层录音管理器（插件不可用时的降级路径）
let lastRecordPath = null;   // 本次录音临时文件路径，发送后立即物理销毁

// 微信同声传译插件：提供流式语音转文字。需在 app.json 声明 + 后台授权，否则 requirePlugin 抛错→降级为纯录音。
let plugin = null;
try { plugin = requirePlugin('WechatSI'); } catch (e) { plugin = null; }
let recordRecognizer = null;

function emptySlots() {
  return CHANNELS.map((ch) => ({ ch, filled: false, preview: '' }));
}

function shortHash(h) {
  return h ? h.slice(0, 8) : '';
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function waveBarsInit() {
  return new Array(16).fill(0);
}

Page({
  data: {
    messages: [],
    visibleMessages: [],
    filter: 'agree',
    inputText: '',
    streamingText: '',
    isAnonymous: true,
    userName: '我',
    roomCode: '0000',
    zone2Expanded: false,
    recording: false,
    shredParticles: [],
    shredKey: 0,
    noiseEnergy: 0,
    waveBars: waveBarsInit(),
  },

  onLoad() {
    this.applyFilter();
    this.seenIds = new Set();
    this.reconnectAttempts = 0;
    this.manualClose = false;
    this.setData({ userName: '玩家' + randInt(1000, 9999) });
    this.connectRelay();
    this.noiseTimer = setInterval(() => this.onNoiseTick(), 180);
  },

  onUnload() {
    if (this.noiseTimer) { clearInterval(this.noiseTimer); this.noiseTimer = null; }
    this.teardownRelay();
  },

  /* ---------------- Phase 4：抗追踪混淆能量 / 网络脉冲 ---------------- */

  bumpEnergy(amount) {
    const e = Math.min(100, (this.data.noiseEnergy || 0) + amount);
    const bars = this.data.waveBars.slice(1).concat([e]);
    this.setData({ noiseEnergy: e, waveBars: bars });
  },

  onNoiseTick() {
    const e = Math.max(0, (this.data.noiseEnergy || 0) - 4);
    const bars = this.data.waveBars.slice(1).concat([e]);
    this.setData({ noiseEnergy: e, waveBars: bars });
  },

  /* ---------------- Zone 1：筛选 / 互动 / 导出 ---------------- */

  onFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter }, () => this.applyFilter());
  },

  applyFilter() {
    const { messages, filter } = this.data;
    const inProgress = messages.filter((m) => m.state !== 'decrypted');
    const done = messages.filter((m) => m.state === 'decrypted').slice();
    if (filter === 'agree') done.sort((a, b) => b.agree - a.agree);
    else if (filter === 'clap') done.sort((a, b) => b.clap - a.clap);
    else if (filter === 'topic') done.sort((a, b) => String(a.topic).localeCompare(String(b.topic), 'zh'));
    this.setData({ visibleMessages: inProgress.concat(done) });
  },

  onAgree(e) {
    const id = e.currentTarget.dataset.id;
    const messages = this.data.messages.map((m) => {
      if (m.id !== id) return m;
      return { ...m, agreed: !m.agreed, agree: m.agreed ? m.agree - 1 : m.agree + 1 };
    });
    this.setData({ messages }, () => this.applyFilter());
  },

  onClap(e) {
    const id = e.currentTarget.dataset.id;
    const messages = this.data.messages.map((m) =>
      m.id === id ? { ...m, clap: m.clap + 1 } : m);
    this.setData({ messages }, () => this.applyFilter());
  },

  onExport() {
    const text = this.data.visibleMessages
      .filter((m) => m.state === 'decrypted')
      .map((m) => `#${m.topic}\n${m.body}\n赞同 ${m.agree} · 击掌 ${m.clap}`)
      .join('\n---\n');
    wx.setClipboardData({ data: text || '（暂无内容）' });
  },

  /* ---------------- Zone 3：文本输入 ---------------- */

  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  onToggleAnonymous(e) {
    this.setData({ isAnonymous: e.detail.value });
  },

  /* ---------------- Zone 3：语音识别（同声传译插件优先，降级纯录音） ---------------- */

  // 插件可用时用 getRecordRecognizerManager：自带录音 + 流式转文字，无需再开 recorderManager（避免双重抢麦）
  ensureRecognizer() {
    if (recordRecognizer || !plugin) return recordRecognizer;
    recordRecognizer = plugin.getRecordRecognizerManager();
    recordRecognizer.onRecognize = (res) => {
      this.setData({ streamingText: (res && res.result) || '' });
    };
    recordRecognizer.onError = (err) => console.warn('[momo] 识别 onError', err && err.errMsg);
    recordRecognizer.onStop = (res) => {
      const finalText = (res && res.result) || this.data.streamingText || '';
      this.setData({ streamingText: '', inputText: this.data.inputText + finalText });
      if (this._wantRecord) {
        this._wantRecord = false;
        wx.showToast({ title: '已达 60 秒上限', icon: 'none' });
      }
      this.setData({ recording: false });
    };
    return recordRecognizer;
  },

  ensureRecorder() {
    if (recorderManager) return recorderManager;
    recorderManager = wx.getRecorderManager();
    recorderManager.onStart(() => console.log('[momo] 录音 onStart'));
    recorderManager.onError((err) => console.warn('[momo] 录音 onError', err && err.errMsg));
    recorderManager.onStop((res) => {
      lastRecordPath = res.tempFilePath || null;
      console.log('[momo] 录音结束，待发送后销毁:', lastRecordPath);
      if (this._wantRecord) {
        this._wantRecord = false;
        wx.showToast({ title: '已达 60 秒上限', icon: 'none' });
      }
      this.setData({ recording: false });
    });
    return recorderManager;
  },

  onVoiceTouchStart() {
    this._wantRecord = true;
    console.log('[momo] 按下说话');
    this.ensureRecordPermission(() => {
      if (!this._wantRecord) return;
      this.setData({ recording: true });
      this.startListening();
    });
  },

  ensureRecordPermission(onGranted) {
    wx.getSetting({
      success: (res) => {
        const auth = (res && res.authSetting) || {};
        if (auth['scope.record'] === true) {
          onGranted();
        } else if (auth['scope.record'] === false) {
          this.promptOpenSetting();
        } else {
          wx.authorize({
            scope: 'scope.record',
            success: () => onGranted(),
            fail: () => this.promptOpenSetting(),
          });
        }
      },
      fail: () => {
        wx.authorize({
          scope: 'scope.record',
          success: () => onGranted(),
          fail: () => this.promptOpenSetting(),
        });
      },
    });
  },

  promptOpenSetting() {
    this.setData({ recording: false });
    wx.showModal({
      title: '需要麦克风权限',
      content: '需要麦克风权限才能使用语音输入，是否前往开启？',
      confirmText: '前往开启',
      cancelText: '不了',
      success: (modal) => {
        if (!modal.confirm) return;
        wx.openSetting({
          success: (s) => {
            if (s.authSetting && s.authSetting['scope.record'] === true) {
              wx.showToast({ title: '已开启，请按住说话', icon: 'none' });
            } else {
              wx.showToast({ title: '未开启麦克风权限', icon: 'none' });
            }
          },
          fail: () => {
            wx.showToast({ title: '打开设置失败，请稍后重试', icon: 'none' });
          },
        });
      },
    });
  },

  startListening() {
    // 二选一：插件可用走流式识别（自带录音）；否则降级纯录音。绝不同时启动两者，避免抢麦。
    if (plugin) {
      console.log('[momo] 启动流式语音识别（同声传译）');
      this.ensureRecognizer().start({ duration: MAX_RECORD_MS, lang: 'zh_CN' });
    } else {
      console.warn('[momo] 未配置同声传译插件，降级为纯录音（无转文字）');
      this.ensureRecorder().start({
        duration: MAX_RECORD_MS,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'mp3',
      });
    }
  },

  onVoiceTouchEnd() {
    console.log('[momo] 松开，recording=', this.data.recording, '插件=', !!plugin);
    this._wantRecord = false;
    if (!this.data.recording) return;
    // 停止正在运行的那个（识别器或录音器），触发其 onStop 完成收尾
    if (plugin && recordRecognizer) { try { recordRecognizer.stop(); } catch (e) {} }
    else if (recorderManager) { try { recorderManager.stop(); } catch (e) {} }
    else this.setData({ recording: false });
  },

  /* ---------------- Phase 2：中转连接 ---------------- */

  connectRelay() {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
      return;
    }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.manualClose = false;

    let socket;
    try {
      socket = wx.connectSocket({ url: RELAY_URL });
    } catch (e) {
      console.warn('[momo] connectSocket 失败，降级为本地展示', e.message);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onOpen(() => {
      console.log('[momo] 中转已连接', RELAY_URL);
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.sendJoin(this.data.roomCode);
    });

    socket.onError((err) => console.warn('[momo] ws 异常', err && err.errMsg));

    socket.onClose((info) => {
      console.warn('[momo] ws 关闭 code=', info && info.code, 'reason=', info && info.reason, 'wasClean=', info && info.wasClean);
      this.stopHeartbeat();
      this.socket = null;
      if (!this.manualClose) this.scheduleReconnect();
    });

    socket.onMessage((res) => {
      let msg;
      try { msg = JSON.parse(res.data); } catch (e) { return; }

      if (msg.type === 'pong') return;
      if (msg.type === 'joined') return;

      if (msg.isDecoy) {
        this.bumpEnergy(randInt(15, 30));
        return;
      }

      console.log('[momo] ← recv', msg.type, msg.msgId || '');

      try {
        if (msg.type === 'shard-seen') {
          this.bumpEnergy(randInt(3, 8));
          this.onShardSeen(msg);
        } else if (msg.type === 'assembled') {
          this.bumpEnergy(randInt(10, 20));
          this.onAssembled(msg);
        } else if (msg.type === 'direct_msg') {
          this.onDirectMsg(msg);
        } else if (msg.type === 'image') {
          this.onImage(msg);
        }
      } catch (e) {
        console.error('[momo] 处理消息异常', msg.type, e.message);
      }
    });
  },

  sendJoin(roomCode) {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send({ data: JSON.stringify({ type: 'join', roomCode }) });
    }
  },

  onRoomCodeChange(e) {
    let code = (e.detail.value || '').trim();
    if (!/^\d{4}$/.test(code)) {
      wx.showToast({ title: '房间码为 4 位数字', icon: 'none' });
      this.setData({ roomCode: this.data.roomCode });
      return;
    }
    this.setData({ roomCode: code });
    this.sendJoin(code);
    wx.showToast({ title: '已进入房间 ' + code, icon: 'none' });
  },

  /* ---------------- 心跳保活 ---------------- */

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === 1) {
        try { this.socket.send({ data: JSON.stringify({ type: 'ping' }) }); } catch (e) {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  },

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  },

  /* ---------------- 断线重连（指数退避 + 上限） ---------------- */

  scheduleReconnect() {
    if (this.manualClose) return;
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      console.warn('[momo] 达到最大重连次数 ' + MAX_RECONNECT + '，停止重连，UI 维持本地展示');
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts++;
    console.log('[momo] 第 ' + this.reconnectAttempts + ' 次重连，' + delay + 'ms 后尝试');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectRelay();
    }, delay);
  },

  /* ---------------- 优雅销毁 ---------------- */

  teardownRelay() {
    this.manualClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
    }
  },

  genMsgId() {
    return 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  },

  relayShards(msgId, fragments) {
    if (!this.socket) return false;
    fragments.forEach((f, i) => {
      const shard = {
        type: 'shard', msgId, matchHash: f.matchHash,
        index: f.index, channel: CHANNELS[i], data: f.data, preview: f.preview,
      };
      this.socket.send({ data: JSON.stringify(shard) });
    });
    return true;
  },

  /* ---------------- Phase 3：发送 = 碎纸散开 + 分片离体 ---------------- */

  buildShredParticles(fragments) {
    const angles = [-135, -45, 45, 135];
    const dist = 192;
    return fragments.map((f, i) => {
      const rad = (angles[i] * Math.PI) / 180;
      return {
        key: this.data.shredKey + '-' + i,
        preview: f.preview,
        dx: Math.round(Math.cos(rad) * dist) + 'rpx',
        dy: Math.round(Math.sin(rad) * dist) + 'rpx',
        delay: i * 60 + 'ms',
      };
    });
  },

  onSend() {
    const text = (this.data.inputText || '').trim();
    if (!text) {
      wx.showToast({ title: '内容为空', icon: 'none' });
      return;
    }

    const msgId = this.genMsgId();

    if (!this.data.isAnonymous) {
      const direct = {
        type: 'direct_msg',
        msgId,
        text,
        userName: this.data.userName,
        isAnonymous: false,
        timestamp: Date.now(),
      };
      if (this.socket) {
        this.socket.send({ data: JSON.stringify(direct) });
      } else {
        console.warn('[momo] 中转未连接，实名消息仅本地展示');
      }
      this.addDirect(msgId, text, this.data.userName);
      this.setData({ inputText: '', streamingText: '' });
      this.destroyLocalRecord();
      return;
    }

    const fragments = crypto.splitMessage(text);
    const matchHash = fragments[0].matchHash;

    try {
      console.assert(crypto.combineMessage(fragments) === text, '[momo] 分片往返还原失败');
    } catch (e) {
      console.warn('[momo] 重组校验异常:', e.message);
    }

    const particles = this.buildShredParticles(fragments);
    this.setData({
      zone2Expanded: true,
      shredParticles: particles,
      shredKey: this.data.shredKey + 1,
      inputText: '',
      streamingText: '',
    });
    setTimeout(() => this.setData({ zone2Expanded: false, shredParticles: [] }), 1100);

    this.bumpEnergy(randInt(10, 20));

    if (this.socket && this.relayShards(msgId, fragments)) {
      this.upsertCollecting(msgId, matchHash, null);
    } else {
      console.warn('[momo] 中转未连接，本地直接展示');
      this.addDecrypted(msgId, text, matchHash, '匿名发言');
    }

    this.destroyLocalRecord();
    console.log('[momo] Phase 4 stub: delay.randomDelay =', typeof delay.randomDelay);
  },

  /* ---------------- 实名直发：接收与渲染 ---------------- */

  onDirectMsg(evt) {
    const { msgId, text, userName } = evt;
    if (this.seenIds && this.seenIds.has(msgId)) return;
    this.addDirect(msgId, text, userName || '匿名');
  },

  addDirect(msgId, text, userName) {
    const card = {
      id: msgId, msgId, state: 'decrypted', isAnonymous: false, userName,
      topic: '', body: text, agree: 0, clap: 0, agreed: false, trust: false,
      slots: emptySlots(), count: 0, hashTag: '',
    };
    this.seenIds = this.seenIds || new Set();
    this.seenIds.add(msgId);
    const messages = [card].concat(this.data.messages);
    this.setData({ messages }, () => this.applyFilter());
  },

  /* ---------------- 图片上传（HTTP，独立于 WebSocket） ---------------- */

  onChooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        const path = (file.tempFilePath || '').toLowerCase();
        if (!/\.(jpe?g|png|webp)$/.test(path)) {
          wx.showToast({ title: '仅支持 JPG/PNG/WebP', icon: 'none' });
          return;
        }
        if (file.size > 2 * 1024 * 1024) {
          wx.showToast({ title: '图片不能超过 2MB', icon: 'none' });
          return;
        }
        this.uploadImage(file.tempFilePath);
      },
    });
  },

  uploadImage(filePath) {
    const url = clientConfig.httpBase + '/upload';
    wx.uploadFile({
      url,
      filePath,
      name: 'file',
      formData: {
        roomCode: '0000',
        userName: this.data.userName,
        isAnonymous: this.data.isAnonymous ? 'true' : 'false',
      },
      success: (res) => console.log('[momo] 图片上传成功', res.data),
      fail: (err) => {
        console.warn('[momo] 图片上传失败', err);
        wx.showToast({ title: '上传失败', icon: 'none' });
      },
    });
  },

  /** 收到图片广播：仅 URL，二进制未走 WebSocket */
  onImage(evt) {
    const isAnon = evt.isAnonymous !== false;
    const card = {
      id: evt.msgId, msgId: evt.msgId, state: 'decrypted',
      isAnonymous: isAnon, userName: evt.userName || '',
      imageUrl: evt.imageUrl, topic: isAnon ? '匿名图片' : '', body: '',
      agree: 0, clap: 0, agreed: false, trust: false,
      slots: emptySlots(), count: 0, hashTag: '',
    };
    const messages = [card].concat(this.data.messages);
    this.setData({ messages }, () => this.applyFilter());
  },

  /* ---------------- Phase 3：接收 = 收集 → 合体 → 解密 ---------------- */

  onShardSeen(evt) {
    if (this.seenIds && this.seenIds.has(evt.msgId)) return;
    this.upsertCollecting(evt.msgId, evt.matchHash, { ch: evt.channel, preview: evt.preview });
  },

  onAssembled(evt) {
    const { msgId, matchHash, fragments } = evt;
    if (this.seenIds.has(msgId)) return;
    this.seenIds.add(msgId);

    this.fillCollecting(msgId, matchHash, fragments);

    let text = '';
    try {
      text = crypto.combineMessage(fragments);
    } catch (e) {
      console.warn('[momo] 拼图重组失败：', e.message);
      this.setCardState(msgId, 'decrypted', { body: '⚠ 重组失败：碎片不完整', trust: false });
      return;
    }
    console.log('[momo] 拼图重组完成，还原长度', text.length);

    setTimeout(() => {
      this.setCardState(msgId, 'assembling');
      setTimeout(() => {
        this.setCardState(msgId, 'decrypted', {
          body: text, trust: true, topic: '匿名发言',
        });
      }, 750);
    }, 450);
  },

  upsertCollecting(msgId, matchHash, filledSlot) {
    let messages = this.data.messages.slice();
    let idx = messages.findIndex((m) => m.msgId === msgId);
    if (idx === -1) {
      const card = {
        id: msgId, msgId, state: 'collecting', isAnonymous: true, userName: '',
        matchHash, hashTag: shortHash(matchHash), count: 0, slots: emptySlots(),
        topic: '', body: '', agree: 0, clap: 0, agreed: false, trust: false,
      };
      messages = [card].concat(messages);
      idx = 0;
    }
    if (filledSlot) {
      const card = messages[idx];
      const slots = card.slots.map((s) =>
        s.ch === filledSlot.ch ? { ch: s.ch, filled: true, preview: filledSlot.preview } : s);
      messages[idx] = { ...card, slots, count: slots.filter((s) => s.filled).length };
    }
    this.setData({ messages }, () => this.applyFilter());
  },

  fillCollecting(msgId, matchHash, fragments) {
    let messages = this.data.messages.slice();
    let idx = messages.findIndex((m) => m.msgId === msgId);
    if (idx === -1) {
      const card = {
        id: msgId, msgId, state: 'collecting', isAnonymous: true, userName: '',
        matchHash, hashTag: shortHash(matchHash), count: 0, slots: emptySlots(),
        topic: '', body: '', agree: 0, clap: 0, agreed: false, trust: false,
      };
      messages = [card].concat(messages);
      idx = 0;
    }
    const card = messages[idx];
    const slots = card.slots.map((s) => {
      const fi = parseInt(s.ch.slice(2), 10);
      const f = fragments.find((fr) => fr.index === fi);
      return f ? { ch: s.ch, filled: true, preview: f.preview } : s;
    });
    messages[idx] = { ...card, slots, count: slots.filter((s) => s.filled).length, state: 'collecting' };
    this.setData({ messages }, () => this.applyFilter());
  },

  setCardState(msgId, state, patch) {
    const messages = this.data.messages.map((m) =>
      m.msgId === msgId ? Object.assign({}, m, { state }, patch || {}) : m);
    this.setData({ messages }, () => this.applyFilter());
  },

  addDecrypted(msgId, text, matchHash, topic) {
    const card = {
      id: msgId, msgId, state: 'decrypted', isAnonymous: true, userName: '',
      matchHash, hashTag: shortHash(matchHash), count: 4, slots: emptySlots(),
      topic, body: text, agree: 0, clap: 0, agreed: false, trust: true,
    };
    this.seenIds.add(msgId);
    const messages = [card].concat(this.data.messages);
    this.setData({ messages }, () => this.applyFilter());
  },

  destroyLocalRecord() {
    if (!lastRecordPath) return;
    const fs = wx.getFileSystemManager();
    fs.unlink({
      filePath: lastRecordPath,
      success: () => console.log('[momo] 本地音频已物理销毁:', lastRecordPath),
      fail: (err) => console.warn('[momo] 销毁失败:', err),
    });
    lastRecordPath = null;
  },
});