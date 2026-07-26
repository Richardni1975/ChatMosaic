// pages/room/index.js — Phase 1/2/3
// 三段式 UI + 语音识别 + 客户端分片 / 中转拼图重组 + 可视化信任动效

const crypto = require('../../utils/crypto.js'); // Phase 2 客户端 XOR 分片
const delay = require('../../utils/delay.js');   // Phase 4 stub
const profanity = require('../../utils/profanity.js'); // 客户端本地侮辱性言论过滤
const clientConfig = require('../../utils/client-config.js'); // 开发/生产地址切换
const socketIO = require('../../utils/socket-io.js'); // Socket.IO 客户端适配器

// Socket.IO 服务端基地址（HTTP，适配器内部自动转 WSS）
// 本地：http://localhost:8080；生产：https://chatmosaic-1.onrender.com
const SIO_URL = clientConfig.httpBase;

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
    roomCount: 0,
    zone2Expanded: false,
    recording: false,
    shredParticles: [],
    shredKey: 0,
    noiseEnergy: 0,
    waveBars: waveBarsInit(),
  },

  onLoad(options) {
    this.applyFilter();
    this.seenIds = new Set();

    // 从 lobby 接收房间号（query 参数）；无参数或非法时回退默认 0000
    const roomCode = (options && options.roomCode && /^\d{4}$/.test(options.roomCode))
      ? options.roomCode
      : '0000';

    this.setData({ roomCode, userName: '玩家' + randInt(1000, 9999) });
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

  /** 匿名按钮点击切换：绿=匿名开，灰=实名 */
  toggleAnonymous() {
    this.setData({ isAnonymous: !this.data.isAnonymous });
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
      const filePath = res.tempFilePath || null;
      lastRecordPath = filePath;
      console.log('[momo] 录音结束，上传 STT:', filePath, res.duration ? res.duration + 'ms' : '');
      if (this._wantRecord) {
        this._wantRecord = false;
        wx.showToast({ title: '已达 60 秒上限', icon: 'none' });
      }
      this.setData({ recording: false, streamingText: '识别中…' });
      if (filePath) this.uploadSTT(filePath);
    });
    return recorderManager;
  },

  /** 上传录音到后端 /api/stt，识别文本填入输入框，转写完成立即销毁音频 */
  uploadSTT(filePath) {
    wx.uploadFile({
      url: clientConfig.httpBase + '/api/stt',
      filePath,
      name: 'file',
      success: (res) => {
        let data = {};
        try { data = JSON.parse(res.data); } catch (e) {}
        if (data.ok && typeof data.text === 'string') {
          this.setData({ inputText: this.data.inputText + data.text, streamingText: '' });
        } else {
          this.setData({ streamingText: '' });
          wx.showToast({ title: '识别失败：' + (data.error || res.statusCode), icon: 'none' });
        }
      },
      fail: (err) => {
        this.setData({ streamingText: '' });
        console.warn('[momo] STT 上传失败', err);
        wx.showToast({ title: '语音识别失败', icon: 'none' });
      },
      complete: () => {
        // 宪章 §3：转写完成后立即本地物理销毁原始音频
        this.destroyAudio(filePath);
      },
    });
  },

  destroyAudio(filePath) {
    if (!filePath) return;
    try {
      wx.getFileSystemManager().unlink({
        filePath,
        success: () => console.log('[momo] 原始音频已销毁:', filePath),
        fail: () => {},
      });
    } catch (e) {}
    if (lastRecordPath === filePath) lastRecordPath = null;
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

  /* ---------------- Socket.IO 连接（与 PC 端同一协议，消除跨端传输不兼容） ---------------- */

  connectRelay() {
    if (this.socket && this.socket.connected) return;

    console.log('[momo] Socket.IO 连接中…', SIO_URL);
    const sio = socketIO.connect(SIO_URL);
    this.socket = sio;

    // 连接成功后立即加入房间
    const onConnected = () => {
      console.log('[momo] ✅ Socket.IO 已连接 → 加入房间', this.data.roomCode);
      sio.emit('join', { roomCode: this.data.roomCode });
    };

    // 收到 joined 确认
    sio.on('joined', (data) => {
      console.log('[momo] ← joined 房间=', data.roomCode, '人数=', data.count);
      if (typeof data.count === 'number') this.setData({ roomCount: data.count });
    });

    // 收到历史消息
    sio.on('msg', (msg) => this._handleMsg(msg));

    // 定时检查连接（Socket.IO 适配器内部有重连，这里做兜底检测）
    this._connCheck = setInterval(() => {
      if (!this.socket || !this.socket.connected) {
        if (!this.socket) {
          console.log('[momo] Socket.IO 断开，重新连接…');
          this.connectRelay();
        }
      }
    }, 5000);

    // 首次连接：适配器握手完成后才能 emit
    this._connReady = setInterval(() => {
      if (sio.connected) {
        clearInterval(this._connReady);
        this._connReady = null;
        onConnected();
      }
    }, 200);

    // 10 秒超时——握手可能失败
    setTimeout(() => {
      if (this._connReady) {
        clearInterval(this._connReady);
        this._connReady = null;
        if (!sio.connected) {
          console.warn('[momo] Socket.IO 握手超时，重试…');
          this.teardownRelay();
          this.connectRelay();
        }
      }
    }, 10000);
  },

  /** 统一消息处理（替代原生 ws 的 onMessage） */
  _handleMsg(msg) {
    if (!msg) return;

    console.log('[momo] ← recv', msg.type, msg.msgId || '', msg.count != null ? '(' + msg.count + '人)' : '');

    if (msg.type === 'joined') {
      if (typeof msg.count === 'number') this.setData({ roomCount: msg.count });
      return;
    }

    if (msg.type === 'history') {
      if (Array.isArray(msg.messages)) this.onHistory(msg.messages);
      return;
    }

    if (msg.type === 'presence') {
      this.setData({ roomCount: msg.count || 0 });
      return;
    }

    if (msg.type === 'room_full') {
      wx.showToast({ title: '房间已满（50人上限）', icon: 'none', duration: 2500 });
      this.onLeaveRoom();
      return;
    }

    if (msg.isDecoy) {
      this.bumpEnergy(randInt(15, 30));
      return;
    }

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
  },

  sendJoin(roomCode) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('join', { roomCode });
    }
  },

  /** 复制当前房间号到剪贴板 */
  onCopyRoomCode() {
    wx.setClipboardData({
      data: this.data.roomCode,
      success: () => wx.showToast({ title: '房间号已复制 ' + this.data.roomCode, icon: 'success' }),
    });
  },

  /** 离开房间，返回大厅 */
  onLeaveRoom() {
    this.teardownRelay();
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.redirectTo({ url: '/pages/lobby/index' });
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

  /* ---------------- 优雅销毁 ---------------- */

  teardownRelay() {
    if (this._connCheck) { clearInterval(this._connCheck); this._connCheck = null; }
    if (this._connReady) { clearInterval(this._connReady); this._connReady = null; }
    if (this._localShowTimer) { clearTimeout(this._localShowTimer); this._localShowTimer = null; }
    if (this.socket) {
      try { this.socket.disconnect(); } catch (e) {}
      this.socket = null;
    }
  },

  genMsgId() {
    return 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  },

  relayShards(msgId, fragments) {
    if (!this.socket || !this.socket.connected) return false;
    fragments.forEach((f, i) => {
      const shard = {
        type: 'shard', msgId, matchHash: f.matchHash,
        index: f.index, channel: CHANNELS[i], data: f.data, preview: f.preview,
      };
      this.socket.emit('msg', shard);
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
    const raw = (this.data.inputText || '').trim();
    if (!raw) {
      wx.showToast({ title: '内容为空', icon: 'none' });
      return;
    }

    // 发送前本地脱敏侮辱性言论（主防线：脏话不进信道）
    let body = raw;
    if (profanity.contains(raw)) {
      body = profanity.mask(raw);
      wx.showToast({ title: '已脱敏不当言论', icon: 'none' });
    }

    const msgId = this.genMsgId();

    if (!this.data.isAnonymous) {
      const direct = {
        type: 'direct_msg',
        msgId,
        text: body,
        userName: this.data.userName,
        isAnonymous: false,
        timestamp: Date.now(),
      };
      if (this.socket && this.socket.connected) {
        this.socket.emit('msg', direct);
      } else {
        console.warn('[momo] 中转未连接，实名消息仅本地展示');
      }
      this.addDirect(msgId, body, this.data.userName);
      this.setData({ inputText: '', streamingText: '' });
      this.destroyLocalRecord();
      return;
    }

    const fragments = crypto.splitMessage(body);
    const matchHash = fragments[0].matchHash;

    try {
      console.assert(crypto.combineMessage(fragments) === body, '[momo] 分片往返还原失败');
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
      // 本地兜底：不依赖服务端 assembled 回传，动画后直接展示
      // （解决真机调试/复杂网络下 WebSocket 回传不可靠的问题）
      this._localShowTimer = setTimeout(() => {
        if (!this.seenIds.has(msgId)) {
          this.addDecrypted(msgId, body, matchHash, '匿名发言');
        }
      }, 1200);
    } else {
      console.warn('[momo] 中转未连接，本地直接展示');
      this.addDecrypted(msgId, body, matchHash, '匿名发言');
    }

    this.destroyLocalRecord();
    console.log('[momo] Phase 4 stub: delay.randomDelay =', typeof delay.randomDelay);
  },

  /* ---------------- 实名直发：接收与渲染 ---------------- */

  onDirectMsg(evt) {
    const { msgId, userName } = evt;
    if (this.seenIds && this.seenIds.has(msgId)) return;
    // 接收端兜底遮罩（防老版本/被绕过的发送端）
    this.addDirect(msgId, profanity.mask(evt.text || ''), userName || '匿名');
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
    const that = this;
    wx.uploadFile({
      url,
      filePath,
      name: 'file',
      formData: {
        roomCode: this.data.roomCode,
        userName: this.data.userName,
        isAnonymous: this.data.isAnonymous ? 'true' : 'false',
      },
      success: (res) => {
        console.log('[momo] 图片上传成功', res.data);
        // 本机立即显示图片，不依赖 WebSocket 回传
        try {
          const data = JSON.parse(res.data);
          if (data.ok && data.imageUrl) {
            const msgId = 'img-local-' + Date.now().toString(36);
            that.onImage({
              msgId,
              imageUrl: data.imageUrl,
              userName: that.data.userName,
              isAnonymous: that.data.isAnonymous,
            });
          }
        } catch (e) { /* 解析失败不阻塞 */ }
      },
      fail: (err) => {
        console.warn('[momo] 图片上传失败', err);
        wx.showToast({ title: '上传失败', icon: 'none' });
      },
    });
  },

  /** 收到图片广播：仅 URL，二进制未走 WebSocket */
  onImage(evt) {
    // 按 imageUrl 去重（本机已本地显示时，WebSocket 回传不再重复添加）
    if (this.seenIds && this.seenIds.has(evt.msgId)) return;
    const isAnon = evt.isAnonymous !== false;
    const card = {
      id: evt.msgId, msgId: evt.msgId, state: 'decrypted',
      isAnonymous: isAnon, userName: evt.userName || '',
      imageUrl: evt.imageUrl, topic: isAnon ? '匿名图片' : '', body: '',
      agree: 0, clap: 0, agreed: false, trust: false,
      slots: emptySlots(), count: 0, hashTag: '',
    };
    this.seenIds = this.seenIds || new Set();
    this.seenIds.add(evt.msgId);
    const messages = [card].concat(this.data.messages);
    this.setData({ messages }, () => this.applyFilter());
  },

  /* ---------------- 历史消息回放 ---------------- */

  onHistory(messages) {
    const cards = messages.map((m) => {
      if (m.type === 'anonymous') {
        return {
          id: m.msgId, msgId: m.msgId, state: 'decrypted',
          isAnonymous: true, userName: '',
          matchHash: m.matchHash, hashTag: shortHash(m.matchHash),
          topic: '匿名发言', body: m.body,
          agree: m.agree || 0, clap: m.clap || 0,
          agreed: false, trust: true,
          slots: emptySlots(), count: 4,
        };
      } else if (m.type === 'direct') {
        return {
          id: m.msgId, msgId: m.msgId, state: 'decrypted',
          isAnonymous: false, userName: m.userName || '',
          topic: '', body: m.body || '',
          agree: 0, clap: 0, agreed: false, trust: false,
          slots: emptySlots(), count: 0, hashTag: '',
        };
      } else if (m.type === 'image') {
        return {
          id: m.msgId, msgId: m.msgId, state: 'decrypted',
          isAnonymous: m.isAnonymous !== false,
          userName: m.userName || '',
          imageUrl: m.imageUrl, topic: m.isAnonymous !== false ? '匿名图片' : '', body: '',
          agree: 0, clap: 0, agreed: false, trust: false,
          slots: emptySlots(), count: 0, hashTag: '',
        };
      }
      return null;
    }).filter(Boolean);

    // 去重：跳过已存在的 msgId
    const existingIds = new Set(this.data.messages.map((c) => c.msgId));
    const newCards = cards.filter((c) => !existingIds.has(c.msgId));

    if (newCards.length > 0) {
      newCards.forEach((c) => this.seenIds.add(c.msgId));
      const messages = newCards.concat(this.data.messages);
      this.setData({ messages }, () => this.applyFilter());
    }
  },

  /* ---------------- Phase 3：接收 = 收集 → 合体 → 解密 ---------------- */

  onShardSeen(evt) {
    if (this.seenIds && this.seenIds.has(evt.msgId)) return;
    this.upsertCollecting(evt.msgId, evt.matchHash, { ch: evt.channel, preview: evt.preview });
  },

  onAssembled(evt) {
    const { msgId, matchHash, fragments } = evt;
    if (this.seenIds.has(msgId)) return;
    // 清除本地兜底计时器（若服务端 assembled 先到）
    if (this._localShowTimer) { clearTimeout(this._localShowTimer); this._localShowTimer = null; }
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
    text = profanity.mask(text); // 接收端兜底遮罩
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