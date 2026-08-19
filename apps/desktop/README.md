# 智能客服（桌面端）

Electron 壳 + 业务目录 + **精简 OpenClaw 便携包** 打成 Windows 安装包。  
对外产品名：**智能客服**；安装包 / 进程名仍为 `OpenClaw-CS`（避免安装器误杀）。  
**不含登录 Cookie**；装机后在橙框浏览器扫码一次即可。

图标：`apps/desktop/build/icon.ico`（由 `icon.png` 生成），窗口 / 托盘 / 安装快捷方式共用。

## 两种安装包（打包时固化，装机后不再选）

| 模式 | 命令 | 产物名 | 固化角色 | 适用 |
|---|---|---|---|---|
| 边端 | `npm run desktop:dist:edge` | `OpenClawDesktop-Setup-Edge-*.exe` | `DEPLOY_ROLE=edge` | 门店 / 坐席机，连公司中台 |
| 全栈 | `npm run desktop:dist:full` | `OpenClawDesktop-Setup-Full-*.exe` | `DEPLOY_ROLE=all` | 单机试点（本机 rag + Supabase） |
| 两种都打 | `npm run desktop:dist` | 上述两个 | — | 发版时一次打齐 |

角色写进 `product-profile.json` + 安装目录 `.env`；首次引导**不再出现**「全栈 / 边端」选择。边端版需填公司 `RAG_BASE_URL`；全栈版默认本机 `8787`。

## 开发运行

```powershell
npm run desktop
```

界面为浅色产品壳（顶栏「开始接待 / 停止接待」、状态灯、运行动态、店铺设置）。右侧 iframe 在 `?product=1&role=edge|all` 下会隐藏研发导航，并锁定 DEPLOY_ROLE。改 UI 后重启桌面端；配置页可点「刷新设置」。

## 打安装包（默认打进便携包）

```powershell
npm run desktop:dist          # Edge + Full 两个安装包
npm run desktop:dist:edge     # 仅边端
npm run desktop:dist:full     # 仅全栈
```

产物目录：`dist-pack/desktop/`

只要业务、不要便携包：

```powershell
powershell -File scripts\Pack-Desktop.ps1 -Mode edge -SkipPortable
```

## 安装注意

- 覆盖安装前请先**关闭窗口**（会自动停止接待）或托盘「退出」。
- **边端包**首次会引导填写公司话术服务地址；**全栈包**一般可直接开始（库走 `brain/.env` 的 Supabase）。
- 若安装器提示「无法关闭」：0.2.3 及更早安装包名 `OpenClaw-CS-Setup-*` 会和 `OpenClaw-CS.exe` 子串误匹配。请改用 **0.2.4+** 的 `OpenClawDesktop-Setup-*.exe`；临时可取消安装 → 任务管理器结束 `OpenClaw-CS.exe` 与 `*Setup*` → 删旧目录后重装到短路径如 `F:\OpenClawCS`。

## 装机后

### 边端版
1. 打开「智能客服」→ 填写公司话术服务地址 / 密钥  
2. 点「开始接待」→ 橙框浏览器登录美团 / 抖音  
3. 右侧设置白名单与话术  

### 全栈版
1. 打开「智能客服（全栈）」→「开始接待」（本机起 rag-service，库在 Supabase）  
2. 橙框浏览器登录；右侧上传话术  

关闭窗口会自动停止接待并退出；仅最小化可保持继续跑。
