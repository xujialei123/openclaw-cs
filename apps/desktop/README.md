# OpenClaw 客服一体端

Electron 壳 + 业务目录 + **精简 OpenClaw 便携包** 打成 Windows 安装包。  
**不含登录 Cookie**；装机后在橙框浏览器扫码一次即可。

## 开发运行

```powershell
npm run desktop
```

界面为浅色正式产品壳（顶栏 / 服务状态 / 运行日志 / 配置中心）。右侧 iframe 配置台与教程同主题（`admin/docs.css`、`admin/config.css`）。改 UI 后重启桌面端，配置页可点「刷新配置页」。

## 打安装包（默认打进便携包）

```powershell
npm run desktop:dist
```

产物：`dist-pack/desktop/OpenClaw-CS-Setup-*.exe`（体积会明显变大，因含 Node/OpenClaw 运行时）

只要业务、不要便携包：

```powershell
powershell -File scripts\Pack-Desktop.ps1 -SkipPortable
```

## 安装注意

- 覆盖安装前请先**关闭一体端窗口**（会自动 Stop-All）或托盘「退出」。
- 若安装器提示「无法关闭」：先结束路径含 `openclaw-portable` 的 `node.exe`，再删旧目录；推荐装到 `F:\OpenClawCS`。0.2.3+ 安装前会杀 portable 进程并清空 `$INSTDIR`。

## 装机后

1. 安装并打开一体端（会自动使用内置 `resources\openclaw-portable`）
2. 点「启动全部」
   - **未装 Docker**：弹窗提醒（可去下载，或跳过继续）
   - **已装 Docker**：自动启动 Docker Desktop → 拉镜像 / compose up / 建表
3. **配置页在窗口右侧**（内嵌 `http://127.0.0.1:18790/`，不弹系统浏览器）；可点顶部「刷新配置页」
4. 在橙框浏览器登录美团 / 抖音 / 查单后台（只需一次）
5. **关闭窗口会自动 Stop-All 并退出**；仅最小化可保持服务继续跑
