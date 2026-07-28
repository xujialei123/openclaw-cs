# OpenClaw 客服桌面端

Electron 托盘壳：启停本仓 `Start-All` / `Stop-All`，并内嵌管理台（默认 `http://127.0.0.1:18790`）。

## 启动

在仓库根目录：

```powershell
npm install
# 若 electron 二进制下载失败（常见 404），先设镜像再装：
# $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
# npm install --prefix apps/desktop
npm run desktop
```

## 行为

- 顶部按钮：启动服务 / 停止服务 / 刷新 / 日志目录 / 浏览器打开管理台
- 关闭窗口会隐藏到托盘（不退出）；托盘菜单可选退出（退出前会尝试 Stop-All）
- 启动服务时带 `-NoOpenBrowser`，避免再弹系统浏览器

## 依赖

仍需本机具备：

- `OPENCLAW_PORTABLE_ROOT`（默认 `F:\OpenClaw-USB-Portable`）
- `config/cs-runtime.json` 与 `.env`
- 已 `npm install`（含 `wecom-bridge` 等）

本应用不替代 OpenClaw 托管浏览器 / CDP。
