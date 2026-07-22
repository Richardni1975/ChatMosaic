// utils/crypto.js
// Phase 2：客户端密码学分片与重组。
//
// 算法（XOR 一次性密钥分片，4-of-4）：
//   设明文字节为 P（长度 n）。
//   生成 3 路纯随机字节 R0、R1、R2（各长度 n）。
//   第 4 路 R3 = P ⊕ R0 ⊕ R1 ⊕ R2。
//   四路碎片任取其三都无法还原 P（缺的那一路等价于一次性密钥）；
//   四路异或：R0 ⊕ R1 ⊕ R2 ⊕ R3 = P，完整还原。
//
// matchHash = SHA-256(P)，作为同一原文碎片的统一标识与重组完整性校验。
// 全部计算在客户端（手机本地）完成，不依赖任何外部付费 API。
// 原始音频文件的销毁见 pages/room/index.js（宪章 §3）。

/* ===================== UTF-8 编解码（纯 JS）===================== */

function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // 代理对 → U+10000 以上
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function utf8Decode(bytes) {
  let str = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      str += String.fromCharCode(b);
    } else if (b < 0xe0) {
      str += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b < 0xf0) {
      const c = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      str += String.fromCharCode(c);
    } else {
      let cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      cp -= 0x10000;
      str += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return str;
}

/* ===================== 十六进制 / 随机字节 ===================== */

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return hex;
}

function hexToBytes(hex) {
  const out = new Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function randomBytes(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/* ===================== SHA-256（纯 JS 本地实现）===================== */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(n, x) {
  return (x >>> n) | (x << (32 - n));
}

function sha256Bytes(bytes) {
  const l = bytes.length;
  const bitLen = l * 8;
  // 补位到 64 字节整数倍
  const padLen = (((l + 9 + 63) >> 6) << 6);
  const data = new Array(padLen).fill(0);
  for (let i = 0; i < l; i++) data[i] = bytes[i];
  data[l] = 0x80;
  // 64 位大端长度（这里只支持 < 2^32 位，高 32 位为 0）
  data[padLen - 4] = (bitLen >>> 24) & 0xff;
  data[padLen - 3] = (bitLen >>> 16) & 0xff;
  data[padLen - 2] = (bitLen >>> 8) & 0xff;
  data[padLen - 1] = bitLen & 0xff;

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(7, w[t - 15]) ^ rotr(18, w[t - 15]) ^ (w[t - 15] >>> 3);
      const s1 = rotr(17, w[t - 2]) ^ rotr(19, w[t - 2]) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => ('00000000' + x.toString(16)).slice(-8))
    .join('');
}

/** 计算字符串的 SHA-256（先做 UTF-8 编码），返回 64 位小写 hex。 */
function sha256Hex(text) {
  return sha256Bytes(utf8Encode(text));
}

/* ===================== 分片 / 重组 ===================== */

/**
 * 将明文切分为 4 串完全不可读的 XOR 乱码碎片。
 * @param {string} text 原始文本
 * @returns {Array<{index:number, matchHash:string, data:string, preview:string}>}
 *          长度为 4 的碎片数组；data 为 hex，preview 为首字节 0xNN 形式（供 UI 动效）。
 */
function splitMessage(text) {
  const bytes = utf8Encode(text);
  const n = bytes.length;

  const r0 = randomBytes(n);
  const r1 = randomBytes(n);
  const r2 = randomBytes(n);
  const r3 = new Array(n);
  for (let i = 0; i < n; i++) {
    r3[i] = bytes[i] ^ r0[i] ^ r1[i] ^ r2[i];
  }

  const matchHash = sha256Bytes(bytes);
  const mk = (idx, data) => ({
    index: idx,
    matchHash,
    data: bytesToHex(data),
    preview: n > 0 ? '0x' + ('0' + data[0].toString(16)).slice(-2).toUpperCase() : '0x--',
  });
  return [mk(0, r0), mk(1, r1), mk(2, r2), mk(3, r3)];
}

/**
 * 由 4 个携带相同 matchHash 的乱码碎片还原原文。
 * @param {Array<{index:number, matchHash:string, data:string}>} fragments
 * @returns {string} 原始文本
 * @throws {Error} 碎片数量不符 / matchHash 不一致 / 完整性校验失败
 */
function combineMessage(fragments) {
  if (!Array.isArray(fragments) || fragments.length !== 4) {
    throw new Error('需要恰好 4 个碎片');
  }
  const matchHash = fragments[0].matchHash;
  for (const f of fragments) {
    if (f.matchHash !== matchHash) {
      throw new Error('matchHash 不一致，碎片不属于同一原文');
    }
  }

  const ordered = fragments.slice().sort((a, b) => a.index - b.index);
  const byteArrays = ordered.map((f) => hexToBytes(f.data));
  const len = byteArrays[0].length;
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = byteArrays[0][i] ^ byteArrays[1][i] ^ byteArrays[2][i] ^ byteArrays[3][i];
  }

  const text = utf8Decode(out);
  if (sha256Bytes(utf8Encode(text)) !== matchHash) {
    throw new Error('完整性校验失败：还原文本 Hash 与 matchHash 不匹配');
  }
  return text;
}

/* ===================== 导出 ===================== */

module.exports = {
  splitMessage,
  combineMessage,
  sha256: sha256Hex,
  // 辅助（供测试与后续 UI 使用）
  utf8ToHex: (text) => bytesToHex(utf8Encode(text)),
  hexToUtf8: (hex) => utf8Decode(hexToBytes(hex)),
};
