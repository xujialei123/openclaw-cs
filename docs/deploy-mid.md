# 中台部署到华为云开发环境

## 📋 前置准备

从你的截图可以看到：
- ✅ 开发环境已创建（2vCPU 4GB）
- ✅ 状态：运行中
- ✅ 镜像：Node.js

---

## 步骤 1：获取服务器信息

在华为云开发环境页面，点击「远程连接」获取：
- **SSH 地址**：如 `sshocean.huaweicloud.com`
- **端口**：通常是 `22` 或随机分配的高端口
- **用户名**：通常是 `root` 或 `ubuntu`
- **密码/密钥**：创建时设置的

---

## 步骤 2：上传代码到服务器

### 方式 A：使用 SCP（推荐）

```powershell
# 在你的本地 PowerShell 执行
$IP = "你的服务器IP"
$Port = "端口号"
$User = "root"

# 上传整个 rag-service 目录
scp -P $Port -o StrictHostKeyChecking=no `
  -r "F:\openclawProject\brain\rag-service" `
  "${User}@${IP}:/home/${User}/"
```

### 方式 B：通过开发环境终端上传

1. 点击「远程连接」打开终端
2. 执行：
```bash
# 进入目录
cd ~

# 创建项目目录
mkdir -p rag-service
cd rag-service

# 然后手动粘贴文件内容，或通过浏览器上传 zip 包
```

### 方式 C：使用 Git（最推荐）

如果服务器有 Git 权限：
```bash
# 在服务器终端执行
git clone https://your-git-repo/openclawProject.git
cd brain/rag-service
```

---

## 步骤 3：安装依赖并构建

```bash
# 在服务器终端执行
cd ~/rag-service

# 查看 Node 版本
node --version  # 需要 >= 18

# 安装依赖
npm install --production

# 构建 TypeScript
npm run build

# 验证编译成功
ls dist/main.js
```

---

## 步骤 4：配置环境变量

```bash
# 创建 .env 文件
cat > .env << 'EOF'
# 数据库 - Supabase
DATABASE_URL=postgresql://postgres.zmucjwewjmkvmswedetb:Xjl%40123.com@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require
VECTOR_STORE=pgvector
VECTOR_DIM=1536

# Embedding API - 阿里云 DashScope
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=sk-ws-H.RYRDXEL.kh8C.MEYCIQCNEobjag84CfEExwPLMqrwUyz0V7BkJyDlMSlZAQTUwAIhAPwAE7pGc7gKcms0QmNTLkDbaIoQv0L36marbB6G9lik
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIM=1536

# API 配置
RAG_API_KEY=prod-rag-key-2024
RAG_SERVICE_PORT=8787
NODE_ENV=production
UPLOAD_DIR=./uploads
EOF
```

---

## 步骤 5：准备知识库数据

```bash
# 创建 uploads 目录
mkdir -p uploads/kb_9k9kBOVblT2JnKHfOQnRy

# 上传知识库文件（从本地）
# 方法1：SCP
scp -P 端口 "F:\openclawProject\brain\rag-service\uploads\kb_9k9kBOVblT2JnKHfOQnRy\*.md" user@ip:/home/user/rag-service/uploads/kb_9k9kBOVblT2JnKHfOQnRy/

# 方法2：在服务器上手动创建测试文件
cat > uploads/kb_9k9kBOVblT2JnKHfOQnRy/test.md << 'EOF'
# 测试知识库
## 对外话术
门店营业时间：9:00-21:00
门店地址：测试地址123号
## 问法示例
- 你们几点开门？
- 地址在哪里？
EOF
```

---

## 步骤 6：启动服务

```bash
# 前台运行（测试用）
node dist/main.js

# 后台运行（生产用）
nohup node dist/main.js > rag-service.log 2>&1 &

# 或使用 PM2（推荐）
npm install -g pm2
pm2 start dist/main.js --name rag-service
pm2 save
pm2 startup  # 按提示执行注册命令
```

---

## 步骤 7：配置防火墙

```bash
# Ubuntu/Debian
sudo ufw allow 8787/tcp
sudo ufw status

# CentOS/RHEL  
sudo firewall-cmd --add-port=8787/tcp --permanent
sudo firewall-cmd --reload
```

---

## 步骤 8：验证部署

```bash
# 健康检查
curl http://localhost:8787/health
# 预期: {"ok":true,"service":"rag-service"}

# 查看知识库列表
curl -H "Authorization: Bearer prod-rag-key-2024" \
  http://localhost:8787/api/kb/list
```

---

## 步骤 9：边端配置

修改本地边端机的配置，指向新中台：

**方法 A：修改 `.env`**
```bash
# F:\openclawProject\.env
RAG_BASE_URL=http://你的华为云IP:8787
RAG_API_KEY=prod-rag-key-2024
```

**方法 B：修改 `config/cs-runtime.json`**
```json
{
  "knowledge": {
    "rag": {
      "baseUrl": "http://你的华为云IP:8787",
      "apiKey": "prod-rag-key-2024",
      "kbIds": ["kb_9k9kBOVblT2JnKHfOQnRy", ...]
    }
  }
}
```

然后重启 cs-watch：
```powershell
# 停止旧进程
Get-Process | Where-Object {$_.ProcessName -eq 'node' -and $_.Id -eq 20044} | Stop-Process -Force

# 重新启动
$env:RAG_BASE_URL = "http://你的华为云IP:8787"
$env:RAG_API_KEY = "prod-rag-key-2024"
Start-Process -FilePath 'node' -ArgumentList 'F:\openclawProject\apps\edge-worker\cs-watch.js' -WindowStyle Hidden
```

---

## 验证端到端流程

```powershell
# 1. 检查中台健康
Invoke-RestMethod -Uri 'http://你的华为云IP:8787/health' -TimeoutSec 5

# 2. 检查知识库
Invoke-RestMethod -Uri 'http://你的华为云IP:8787/api/kb/list' `
  -Headers @{'Authorization'='Bearer prod-rag-key-2024'}

# 3. 测试检索
$body = @{
  query = "营业时间"
  platform = "meituan"
  shopId = "default"
  kbIds = @("kb_9k9kBOVblT2JnKHfOQnRy")
} | ConvertTo-Json
Invoke-RestMethod -Uri 'http://你的华为云IP:8787/api/rag/retrieve' `
  -Method POST `
  -ContentType 'application/json' `
  -Headers @{'Authorization'='Bearer prod-rag-key-2024'} `
  -Body $body
```

---

## 常见问题排查

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| ECONNREFUSED 5432 | Supabase 连接失败 | 检查 DATABASE_URL 和密码 |
| candidates=0 | 知识库文件未上传 | 检查 uploads/ 目录 |
| 404 /api/kb/list | 路由不匹配 | 检查 API Key 和路由 |
| Embedding 超时 | 阿里云 API 限流 | 检查 API Key 和配额 |

---

## 安全建议

1. **修改默认 API Key**：`RAG_API_KEY` 不要使用默认的 `local-dev-key`
2. **启用 HTTPS**：配置 Nginx + SSL 证书
3. **限制访问 IP**：在华为云安全组只允许边端机 IP 访问 8787 端口
4. **定期备份**：Supabase 开启自动备份
