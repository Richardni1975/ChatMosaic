// app.js — momo-anonymous-decision
// Phase 1: 全局逻辑占位，后续 Phase 接入云开发/Redis 时在此初始化。

App({
  globalData: {
    darkMode: false,
    // Phase 2: 无日志后端重组所需上下文占位
    // Phase 4: 静默中转能量值占位
  },

  onLaunch() {
    // 探测系统暗色模式，供页面做 prefers-color-scheme 之外的兜底
    // 优先用新 API getAppBaseInfo，旧基础库回退 getSystemInfoSync
    try {
      const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
      this.globalData.darkMode = info.theme === 'dark';
    } catch (e) {
      this.globalData.darkMode = false;
    }

    wx.onThemeChange && wx.onThemeChange((res) => {
      this.globalData.darkMode = res.theme === 'dark';
    });
  },
});
