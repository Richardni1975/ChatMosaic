// public/app.js — PC Web 客户端
// 复用 utils/crypto.js 的 XOR 4-of-4 分片；Socket.IO 跨端；Web Speech API 语音转写。
// 协议与小程序端完全一致：shard / shard-seen / assembled / direct_msg / ping-pong / isDecoy。

const crypto = window.MOMO_CRYPTO;
const profanity = window.MOMO_PROFANITY;
const API_BASE = (window.MOMO_CONFIG && window.MOMO_CONFIG.API_BASE) || ''; // '' = 同源
const MAX_RECORD_MS = 60000; // 与小程序端对齐：60s 上限
const CHANNELS = ['ch0', 'ch1', 'ch2', 'ch3'];
const WAVE_BARS = 16;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), roomView = $('room');
const codeInput = $('codeInput'), joinBtn = $('joinBtn'), createBtn = $('createBtn');
const roomLabel = $('roomLabel'), leaveBtn = $('leaveBtn');
const roomCount = $('roomCount');
const cardFlow = $('cardFlow');
const textInput = $('textInput'), sendBtn = $('sendBtn'), voiceBtn = $('voiceBtn');
const imgBtn = $('imgBtn'), fileInput = $('fileInput');
const anonToggle = $('anonToggle');
const waveEl = $('wave'), noiseValEl = $('noiseVal');
const exportBtn = $('exportBtn');

/* ---------- 状态 ---------- */
let socket = null;
let joinedRoom = null;
let isAnonymous = true;
const userName = 'PC-' + Math.floor(1000 + Math.random() * 9000);
const seenIds = new Set();
let messages = []; // 源数据
const cardEls = new Map(); // msgId -> HTMLElement

let recognition = null;
let recording = false;
let recordTimer = null;
let streamingText = '';

let noiseEnergy = 0;
let waveBars = new Array(WAVE_BARS).fill(0);
let noiseTimer = null;

/* ---------- 波形初始化 ---------- */
function initWave() {
  waveEl.innerHTML = '';
  for (let i = 0; i < WAVE_BARS; i++) {
    const b = document.createElement('div');
    b.className = 'wave-bar';
    b.style.height = '0%';
    waveEl.appendChild(b);
  }
}

function bumpEnergy(amount) {
  noiseEnergy = Math.min(100, noiseEnergy + amount);
  paintWave();
}

function paintWave() {
  const bars = waveEl.children;
  for (let i = 0; i < bars.length; i++) bars[i].style.height = waveBars[i] + '%';
  noiseValEl.textContent = Math.round(noiseEnergy) + '%';
}

function noiseTick() {
  noiseEnergy = Math.max(0, noiseEnergy - 4);
  waveBars = waveBars.slice(1).concat([noiseEnergy]);
  paintWave();
}

/* ---------- 进房 ---------- */
function genCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

/** "创建新房间" — 自动生成房间号并进入 */
function doCreate() {
  const code = genCode();
  codeInput.value = code;
  flashToast('房间号：' + code + ' — 已创建并进入');
  if (!socket) connect();
  socket.emit('join', { roomCode: code });
}

/** "加入" — 使用输入的 4 位房间号进入 */
function doJoin() {
  const code = codeInput.value.trim();
  if (!/^\d{4}$/.test(code)) {
    flashToast('请输入 4 位数字房间号');
    return;
  }
  if (!socket) connect();
  socket.emit('join', { roomCode: code });
}

function connect() {
  socket = io(API_BASE || undefined, { path: '/socket.io/', transports: ['websocket', 'polling'] });
  socket.on('connect', () => console.log('[momo] Socket.IO 已连接'));
  socket.on('joined', ({ roomCode, count }) => {
    joinedRoom = roomCode;
    roomLabel.textContent = roomCode;
    roomCount.textContent = (count || 0) + '/50 人在线';
    lobby.classList.add('hidden');
    roomView.classList.remove('hidden');
    initWave();
    if (!noiseTimer) noiseTimer = setInterval(noiseTick, 180);
  });
  socket.on('msg', handleMsg);
  socket.on('disconnect', () => console.warn('[momo] 连接断开'));
}

function doLeave() {
  if (socket) socket.disconnect();
  socket = null;
  joinedRoom = null;
  messages = []; cardEls.clear(); cardFlow.innerHTML = '';
  roomView.classList.add('hidden');
  lobby.classList.remove('hidden');
  if (noiseTimer) { clearInterval(noiseTimer); noiseTimer = null; }
}

/* ---------- 接收分发 ---------- */
function handleMsg(obj) {
  if (!obj) return;
  if (obj.type === 'pong') return;

  // 历史消息（进房时推送）
  if (obj.type === 'history') {
    if (Array.isArray(obj.messages)) onHistory(obj.messages);
    return;
  }

  // 房间人数更新
  if (obj.type === 'presence') {
    roomCount.textContent = (obj.count || 0) + '/50 人在线';
    return;
  }

  // 房间已满
  if (obj.type === 'room_full') {
    flashToast('房间已满（50人上限）');
    doLeave();
    return;
  }

  if (obj.isDecoy) { bumpEnergy(randInt(15, 30)); return; }
  if (obj.type === 'shard-seen') { bumpEnergy(randInt(3, 8)); onShardSeen(obj); }
  else if (obj.type === 'assembled') { bumpEnergy(randInt(10, 20)); onAssembled(obj); }
  else if (obj.type === 'direct_msg') { onDirectMsg(obj); }
  else if (obj.type === 'image') { onImage(obj); }
}

/* ---------- 卡片渲染（增量） ---------- */
function emptyHint() {
  if (messages.length === 0) {
    cardFlow.innerHTML = '<div class="empty">还没有人发言，做第一个说出真实想法的人。</div>';
  }
}

function getCardEl(data) {
  let el = cardEls.get(data.msgId);
  if (!el) {
    // 清空 empty 提示
    const empty = cardFlow.querySelector('.empty');
    if (empty) empty.remove();
    el = document.createElement('div');
    cardEls.set(data.msgId, el);
    cardFlow.prepend(el);
    messages.unshift(data);
  }
  return el;
}

function shortHash(h) { return h ? h.slice(0, 8) : ''; }

function paintCard(data) {
  const el = getCardEl(data);
  el.className = 'card ' + data.state;
  if (el._state === data.state) {
    if (data.state === 'collecting') patchSlots(el, data);
    return;
  }
  el._state = data.state;
  el.innerHTML = cardHTML(data);
  if (data.state === 'collecting') patchSlots(el, data);
}

function slotHTML() {
  return CHANNELS.map((ch) =>
    `<div class="shard-chip empty" data-ch="${ch}"><span class="ch-label">${ch}</span><span class="pv">····</span></div>`
  ).join('');
}

function cardHTML(d) {
  if (d.state === 'collecting') {
    return `<div class="collect-head"><span class="pulse"></span>
      <span class="collect-status">拼图收集中 (${d.count}/4)</span>
      <span class="hash-tag">${d.hashTag}</span></div>
      <div class="shard-row">${slotHTML()}</div>`;
  }
  if (d.state === 'assembling') {
    const frags = d.slots.map((s, i) =>
      `<span class="merge-frag" style="--i:${i}">${s.preview}</span>`).join('');
    return `<div class="merge-stage">${frags}<span class="merge-core"></span></div>
      <span class="collect-status" style="display:block;text-align:center;margin-top:6px">重组中…</span>`;
  }
  // decrypted
  const head = d.isAnonymous
    ? `<div class="card-topic">#${d.topic}</div>`
    : `<div class="realname-head"><span class="rn-badge">实名</span><span class="rn-name">${d.userName}</span></div>`;
  const trust = (d.isAnonymous && !d.imageUrl)
    ? (d.trust ? `<span class="trust-tag">SHA-256 校验通过 ✓</span>`
               : `<span class="trust-tag bad">⚠ 完整性校验失败</span>`)
    : '';
  const media = d.imageUrl
    ? `<img class="card-image" src="${d.imageUrl}" alt="img" />`
    : `<div class="card-body">${escapeHTML(d.body)}</div>`;
  return `${head}${media}${trust}
    <div class="card-footer">
      <span class="action ${d.agreed ? 'on' : ''}" data-act="agree" data-id="${d.msgId}">👍 ${d.agree}</span>
      <span class="action" data-act="clap" data-id="${d.msgId}">👏 ${d.clap}</span>
    </div>`;
}

function patchSlots(el, d) {
  const chips = el.querySelectorAll('.shard-chip');
  chips.forEach((chip) => {
    const s = d.slots.find((x) => x.ch === chip.dataset.ch);
    if (s && s.filled) {
      if (!chip.classList.contains('filled')) {
        chip.classList.remove('empty');
        chip.classList.add('filled');
        chip.querySelector('.pv').textContent = s.preview;
      }
    } else {
      chip.classList.add('empty');
      chip.classList.remove('filled');
      chip.querySelector('.pv').textContent = '····';
    }
  });
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 历史消息回放 ---------- */

function onHistory(list) {
  const existingIds = new Set(messages.map((m) => m.msgId));
  list.forEach((m) => {
    if (existingIds.has(m.msgId)) return;
    existingIds.add(m.msgId);
    seenIds.add(m.msgId);
    if (m.type === 'anonymous') {
      const data = {
        msgId: m.msgId, state: 'decrypted', isAnonymous: true, userName: '',
        matchHash: m.matchHash, hashTag: shortHash(m.matchHash),
        topic: '匿名发言', body: m.body || '',
        agree: m.agree || 0, clap: m.clap || 0,
        agreed: false, trust: true, slots: [], count: 4,
      };
      paintCard(data);
    } else if (m.type === 'direct') {
      const data = {
        msgId: m.msgId, state: 'decrypted', isAnonymous: false,
        userName: m.userName || '', topic: '', body: m.body || '',
        agree: 0, clap: 0, agreed: false, trust: false,
        slots: [], count: 0, hashTag: '',
      };
      paintCard(data);
    } else if (m.type === 'image') {
      const data = {
        msgId: m.msgId, state: 'decrypted',
        isAnonymous: m.isAnonymous !== false,
        userName: m.userName || '', imageUrl: m.imageUrl,
        topic: m.isAnonymous !== false ? '匿名图片' : '', body: '',
        agree: 0, clap: 0, agreed: false, trust: false,
        slots: [], count: 0, hashTag: '',
      };
      paintCard(data);
    }
  });
}

/* ---------- collecting / assembled / direct 处理 ---------- */
function upsertCollecting(msgId, matchHash, filledSlot) {
  let data = messages.find((m) => m.msgId === msgId);
  if (!data) {
    data = {
      msgId, state: 'collecting', isAnonymous: true, userName: '',
      matchHash, hashTag: shortHash(matchHash), count: 0,
      slots: CHANNELS.map((ch) => ({ ch, filled: false, preview: '' })),
      topic: '', body: '', agree: 0, clap: 0, agreed: false, trust: false,
    };
  }
  if (filledSlot) {
    const s = data.slots.find((x) => x.ch === filledSlot.ch);
    if (s) { s.filled = true; s.preview = filledSlot.preview; }
    data.count = data.slots.filter((x) => x.filled).length;
  }
  paintCard(data);
}

function onShardSeen(evt) {
  if (seenIds.has(evt.msgId)) return; // 已完成，晚到的 seen 跳过
  upsertCollecting(evt.msgId, evt.matchHash, { ch: evt.channel, preview: evt.preview });
}

function onAssembled(evt) {
  const { msgId, matchHash, fragments } = evt;
  if (seenIds.has(msgId)) return;
  seenIds.add(msgId);
  let data = messages.find((m) => m.msgId === msgId);
  if (!data) {
    data = {
      msgId, state: 'collecting', isAnonymous: true, userName: '',
      matchHash, hashTag: shortHash(matchHash), count: 0,
      slots: CHANNELS.map((ch) => ({ ch, filled: false, preview: '' })),
      topic: '', body: '', agree: 0, clap: 0, agreed: false, trust: false,
    };
    messages.unshift(data);
  }
  // 填满 4 slot
  data.slots.forEach((s) => {
    const fi = parseInt(s.ch.slice(2), 10);
    const f = fragments.find((fr) => fr.index === fi);
    if (f) { s.filled = true; s.preview = f.preview; }
  });
  data.count = 4;
  paintCard(data);

  let text = '';
  try { text = crypto.combineMessage(fragments); }
  catch (e) { console.warn('[momo] 重组失败', e.message); data.state = 'decrypted'; data.body = '⚠ 重组失败'; paintCard(data); return; }
  if (profanity) text = profanity.mask(text); // 接收端兜底遮罩

  setTimeout(() => { data.state = 'assembling'; paintCard(data); }, 450);
  setTimeout(() => {
    data.state = 'decrypted'; data.body = text; data.trust = true; data.topic = '匿名发言';
    paintCard(data);
  }, 450 + 750);
}

function onDirectMsg(evt) {
  const { msgId, userName: who } = evt;
  if (seenIds.has(msgId)) return;
  seenIds.add(msgId);
  const text = profanity ? profanity.mask(evt.text || '') : (evt.text || ''); // 接收端兜底遮罩
  const data = {
    msgId, state: 'decrypted', isAnonymous: false, userName: who || '匿名',
    topic: '', body: text, agree: 0, clap: 0, agreed: false, trust: false,
    slots: [], count: 0, hashTag: '',
  };
  paintCard(data);
}

function addDirectLocal(msgId, text, who) {
  seenIds.add(msgId);
  const data = {
    msgId, state: 'decrypted', isAnonymous: false, userName: who,
    topic: '', body: text, agree: 0, clap: 0, agreed: false, trust: false,
    slots: [], count: 0, hashTag: '',
  };
  paintCard(data);
}

/* ---------------- 图片上传（HTTP，独立于 WebSocket） ---------------- */

function onImage(evt) {
  if (seenIds.has(evt.msgId)) return; // 去重：本机已本地显示则跳过广播回传
  seenIds.add(evt.msgId);
  console.log('[momo] ← image', evt.msgId, evt.imageUrl);
  const isAnon = evt.isAnonymous !== false;
  const data = {
    msgId: evt.msgId, state: 'decrypted', isAnonymous: isAnon, userName: evt.userName || '',
    imageUrl: evt.imageUrl, topic: isAnon ? '匿名图片' : '', body: '',
    agree: 0, clap: 0, agreed: false, trust: false, slots: [], count: 0, hashTag: '',
  };
  paintCard(data);
}

/** Canvas 压缩：限制最长边 1600px，JPEG 降质至 ≤2MB */
async function compressImage(file) {
  if (!/image\/(jpeg|png|webp)/.test(file.type)) throw new Error('仅支持 JPG/PNG/WebP');
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const MAX_DIM = 1600;
  if (width > MAX_DIM || height > MAX_DIM) {
    const r = Math.min(MAX_DIM / width, MAX_DIM / height);
    width = Math.round(width * r); height = Math.round(height * r);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  let q = 0.85;
  let blob = await new Promise((r) => canvas.toBlob(r, outType, q));
  while (blob.size > 2 * 1024 * 1024 && q > 0.3 && outType === 'image/jpeg') {
    q -= 0.15;
    blob = await new Promise((r) => canvas.toBlob(r, outType, q));
  }
  if (blob.size > 2 * 1024 * 1024) throw new Error('压缩后仍超过 2MB');
  return blob;
}

async function uploadImage(file) {
  try {
    console.log('[momo] 图片上传开始, room=', joinedRoom, '大小=', file.size);
    const blob = await compressImage(file);
    const fd = new FormData();
    fd.append('file', blob, 'img.' + (blob.type === 'image/png' ? 'png' : 'jpg'));
    fd.append('roomCode', joinedRoom || '0000');
    fd.append('userName', userName);
    fd.append('isAnonymous', isAnonymous ? 'true' : 'false');
    const res = await fetch(API_BASE + '/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '上传失败');
    console.log('[momo] 图片上传成功', data.imageUrl, 'msgId=', data.msgId);
    // 本地立即显示（复用服务端 msgId，随后广播到达时 seenIds 去重）
    onImage({ msgId: data.msgId, imageUrl: data.imageUrl, userName, isAnonymous });
  } catch (e) {
    console.error('[momo] 图片上传失败', e.message);
    alert('图片上传失败：' + e.message);
  }
}

/* ---------- 发送 ---------- */
function genMsgId() { return 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

function onSend() {
  const raw = textInput.value.trim();
  if (!raw) return;
  const msgId = genMsgId();

  // 发送即结束语音输入：停止识别，清空语音缓存，防止 onend 把旧文本写回输入框
  if (recording) stopVoice();
  recFinalText = '';
  recInterim = '';

  // 发送前本地脱敏侮辱性言论（主防线）
  let body = raw;
  if (profanity && profanity.contains(raw)) {
    body = profanity.mask(raw);
    flashToast('已脱敏不当言论');
  }

  if (!isAnonymous) {
    const direct = { type: 'direct_msg', msgId, text: body, userName, isAnonymous: false, timestamp: Date.now() };
    if (socket) socket.emit('msg', direct);
    addDirectLocal(msgId, body, userName);
    textInput.value = ''; streamingText = '';
    return;
  }

  const fragments = crypto.splitMessage(body);
  playShred(fragments);
  bumpEnergy(randInt(10, 20));
  if (socket) {
    fragments.forEach((f, i) => socket.emit('msg', {
      type: 'shard', msgId, matchHash: f.matchHash,
      index: f.index, channel: CHANNELS[i], data: f.data, preview: f.preview,
    }));
    upsertCollecting(msgId, fragments[0].matchHash, null);
  } else {
    // 未连接：本地直接展示
    addDecryptedLocal(msgId, body, fragments[0].matchHash);
  }
  textInput.value = ''; streamingText = '';
}

/** 顶部轻提示（自动消失） */
function flashToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(flashToast._timer);
  flashToast._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

/** 一键导出：把已解密的聊天记录导出为 .txt 文件下载到本地 */
function onExport() {
  const items = messages.filter((m) => m.state === 'decrypted' && (m.body || m.imageUrl));
  if (!items.length) { flashToast('暂无可导出内容'); return; }
  const text = items.map((m) => {
    const head = m.isAnonymous ? '#匿名发言' : ('实名：' + (m.userName || ''));
    const content = m.imageUrl ? '[图片] ' + m.imageUrl : m.body;
    return `${head}\n${content}\n赞同 ${m.agree || 0} · 击掌 ${m.clap || 0}`;
  }).join('\n---\n');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // ﻿ BOM 保证中文在记事本/Excel 不乱码
  const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chatmosaic-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flashToast('已导出 ' + items.length + ' 条到本地');
}

function addDecryptedLocal(msgId, text, matchHash) {
  seenIds.add(msgId);
  const data = {
    msgId, state: 'decrypted', isAnonymous: true, userName: '',
    matchHash, hashTag: shortHash(matchHash), topic: '匿名发言', body: text,
    agree: 0, clap: 0, agreed: false, trust: true, slots: [], count: 4,
  };
  paintCard(data);
}

/* ---------- 碎纸散开动效 ---------- */
function playShred(fragments) {
  const overlay = document.createElement('div');
  overlay.className = 'shred-overlay';
  const angles = [-135, -45, 45, 135];
  fragments.forEach((f, i) => {
    const rad = (angles[i] * Math.PI) / 180;
    const p = document.createElement('span');
    p.className = 'shred-particle';
    p.textContent = f.preview;
    p.style.setProperty('--dx', Math.round(Math.cos(rad) * 96) + 'px');
    p.style.setProperty('--dy', Math.round(Math.sin(rad) * 96) + 'px');
    p.style.animationDelay = (i * 60) + 'ms';
    overlay.appendChild(p);
  });
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 1100);
}

/* ---------- 按住说话（鼠标 + 空格键） + 自动标点 ---------- */

let recFinalText = ''; // 已确认并加标点的文本
let recInterim = '';   // 当前 interim（未确认）

/**
 * 自动标点：按句尾语义判断追加 ？/，/。
 * - 末尾为疑问语气词/疑问词 → ？
 * - 末尾为转折/承接连词 → ，
 * - 其他 → 。
 */
function punctuate(chunk) {
  let t = (chunk || '').trim().replace(/[。.！？!，,；;、~～]\s*$/, '').replace(/\s+/g, '');
  if (!t) return '';
  // 疑问语气词结尾 → ？
  if (/(吗|呢|吧|嘛|呀|哦|么)$/.test(t)) return t + '？';
  // 短句（≤8 字）含疑问词 → ？（疑问词常在句中，故用包含匹配 + 长度限制降低误判）
  if (t.length <= 8 && /(谁|什么|怎么|为什么|咋|哪儿|哪里|几|多少|是不是|能不能|可不可以|有没有)/.test(t)) return t + '？';
  // 句尾连词 → ，（话未说完，用户停顿）
  if (/(然后|但是|不过|而且|所以|因为|另外|接着|其次|其实)$/.test(t)) return t + '，';
  // 默认句号
  return t + '。';
}

let wantStop = false; // 标记：recognition.start() 异步完成前用户已松开 → onstart 时立即停
let micPermission = null; // null=未请求, true=已授权, false=已拒绝

/** 显式请求麦克风权限（现代 Chrome 要求先 getUserMedia 才能用 SpeechRecognition） */
async function ensureMicPermission() {
  if (micPermission === true) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 立即关闭音频轨道，避免占用麦克风
    stream.getTracks().forEach((t) => t.stop());
    micPermission = true;
    return true;
  } catch (e) {
    micPermission = false;
    console.warn('[momo] 麦克风权限被拒绝:', e.message);
    return false;
  }
}

async function startVoice() {
  if (recording) return;
  if (!SR) {
    flashToast('当前浏览器不支持语音识别，请使用 Chrome/Edge');
    return;
  }

  // 先标记 recording 防止重入；wantStop 用于权限请求期间用户提前松开的场景
  recording = true;
  wantStop = false;
  voiceBtn.classList.add('recording');
  voiceBtn.textContent = '获取权限…';

  // 显式获取麦克风权限（现代 Chrome 要求先 getUserMedia 才能用 SpeechRecognition）
  const ok = await ensureMicPermission();
  if (!ok || wantStop) {
    // 权限被拒、或用户在权限请求期间已松开
    stopVoiceUI();
    if (!ok) flashToast('需要麦克风权限才能使用语音输入，请在浏览器设置中允许');
    return;
  }

  voiceBtn.textContent = '松开结束';

  // 接续输入框已有文本
  recFinalText = textInput.value || '';
  recInterim = '';

  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  // 关键：start() 是异步的，若用户在启动完成前已松开（快速点击），onstart 时立即停
  recognition.onstart = () => {
    if (wantStop) { try { recognition.stop(); } catch (e) {} }
  };
  recognition.onresult = (e) => {
    if (!recording) return; // 松开后/发送后的回调不再写回输入框
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        recFinalText += punctuate(res[0].transcript);
      } else {
        interim += res[0].transcript;
      }
    }
    recInterim = interim;
    textInput.value = recFinalText + recInterim;
  };
  recognition.onerror = (e) => {
    console.warn('[momo] 识别错误', e.error);
    if (e.error === 'not-allowed') {
      flashToast('麦克风权限被阻止，请在浏览器设置中允许');
    } else if (e.error === 'no-speech') {
      // 静默忽略——用户没有说话，正常结束
    } else if (e.error === 'network') {
      flashToast('语音识别需要网络连接，请检查网络');
    } else if (e.error && e.error !== 'aborted') {
      flashToast('语音识别错误：' + e.error);
    }
  };
  recognition.onend = () => {
    // 落位最终文本（含未确认的 interim，避免丢字）
    textInput.value = recFinalText + recInterim;
    recInterim = '';
    streamingText = '';
    textInput.placeholder = '说点什么…';
    stopVoiceUI();
  };
  try { recognition.start(); } catch (e) { stopVoiceUI(); flashToast('语音识别启动失败'); }
  // 60s 强制上限，单一出口收尾
  recordTimer = setTimeout(() => {
    if (recording) { console.log('[momo] 达 60s 上限，自动停止'); wantStop = true; if (recognition) { try { recognition.stop(); } catch (e) {} } }
  }, MAX_RECORD_MS);
}

function stopVoice() {
  if (!recording) return;
  recording = false;
  wantStop = true; // 若 onstart 尚未触发，启动后立即停
  if (recordTimer) { clearTimeout(recordTimer); recordTimer = null; }
  if (recognition) { try { recognition.stop(); } catch (e) {} }
  // onend 会处理 UI 与文本落位；若 onend 迟迟不来，800ms 后强制 abort 兜底
  if (recognition) {
    setTimeout(() => {
      try { if (recognition && recording === false) recognition.abort(); } catch (e) {}
    }, 800);
  }
}

function stopVoiceUI() {
  recording = false;
  voiceBtn.classList.remove('recording');
  voiceBtn.textContent = '按住说话';
}

/* ---------- 事件绑定 ---------- */
createBtn.addEventListener('click', doCreate);
joinBtn.addEventListener('click', doJoin);
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
leaveBtn.addEventListener('click', doLeave);
exportBtn.addEventListener('click', onExport);
sendBtn.addEventListener('click', onSend);
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSend(); });
anonToggle.addEventListener('change', () => { isAnonymous = anonToggle.checked; });

voiceBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startVoice(); });
voiceBtn.addEventListener('mouseup', stopVoice);
window.addEventListener('mouseup', stopVoice); // 兜底：在按钮外松开也能停止
// 不绑 mouseleave：startVoice 改 textContent 会触发 mouseleave 误停识别，window mouseup 已覆盖释放

imgBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  if (f) uploadImage(f);
  fileInput.value = ''; // 允许重复选同一文件
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement !== textInput && document.activeElement !== codeInput) {
    e.preventDefault();
    if (!e.repeat) startVoice();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && document.activeElement !== textInput && document.activeElement !== codeInput) {
    e.preventDefault();
    stopVoice();
  }
});

// 赞同 / 击掌 事件委托
cardFlow.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const id = t.dataset.id;
  const data = messages.find((m) => m.msgId === id);
  if (!data) return;
  if (t.dataset.act === 'agree') { data.agreed = !data.agreed; data.agree += data.agreed ? 1 : -1; }
  else if (t.dataset.act === 'clap') { data.clap += 1; }
  paintCard(data);
});

codeInput.focus();
