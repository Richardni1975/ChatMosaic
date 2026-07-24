// pages/lobby/index.js — 进房入口大厅
// 提供「创建新房间」与「加入已有房间」两个路径。
// 房间号为系统自动生成的 4 位纯数字，用户间口头约定后跨端互通。

Page({
  data: {
    joinCode: '', // 用户输入的 4 位房间号
  },

  /** 自动生成 4 位数字房间号并直接进入 */
  onCreateRoom() {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    wx.redirectTo({ url: '/pages/room/index?roomCode=' + code });
  },

  /** 过滤非数字输入，限制 4 位 */
  onCodeInput(e) {
    const v = (e.detail.value || '').replace(/\D/g, '').slice(0, 4);
    this.setData({ joinCode: v });
  },

  /** 使用输入的 4 位房间号加入（不足 4 位时静默忽略） */
  onJoinRoom() {
    const code = this.data.joinCode;
    if (!/^\d{4}$/.test(code)) return;
    wx.redirectTo({ url: '/pages/room/index?roomCode=' + code });
  },
});
