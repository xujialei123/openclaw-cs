# OpenClaw CS · 目标机本机联调部署

## 你需要准备两样

1. **本 zip** 解压得到的 `openclawProject`
2. **OpenClaw USB 便携包**整目录（源机常见 `F:\OpenClaw-USB-Portable`，约 1GB+）  
   → **直接整夹复制**到目标机即可，不必再装系统 Node

## 目标机步骤

1. 解压 zip，例如放到 `D:\openclawProject`
2. 复制便携包，例如放到 `D:\OpenClaw-USB-Portable`
3. 配置环境变量：
   - 复制 `.env.example` → `.env`
   - 复制 `brain\.env.example` → `brain\.env`
   - 编辑 `.env`，至少改：
     - `OPENCLAW_PORTABLE_ROOT=D:\OpenClaw-USB-Portable`（按你实际路径）
     - `RAG_BASE_URL=http://127.0.0.1:8787`
   - 编辑 `brain\.env`：填 `DATABASE_URL`、`EMBEDDING_API_KEY`、`RAG_API_KEY` 等  
     （若打包时用了 `-IncludeEnv`，已带源机密钥，仍要改便携包路径）
5. 在项目根执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Start-All.ps1
```

6. 浏览器打开：
   - 配置台 http://127.0.0.1:18790/
   - 知识中台 http://127.0.0.1:8787/kb-admin
   - 项目全景 http://127.0.0.1:18790/project-map
7. 在 OpenClaw 托管 Chrome 里登录美团经营宝 / 抖音来客
8. 白名单在 `config\cs-runtime.json` 或配置页修改

## 停止

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Stop-All.ps1
```

## 说明

- 这是「本机联调形态」，不是生产拆分中台。
- 便携包建议**单独复制**，不要硬塞进项目 zip（体积大，且含浏览器用户数据）。
- 目标机路径与源机不同时，务必改 `.env` 里的 `OPENCLAW_PORTABLE_ROOT`。
