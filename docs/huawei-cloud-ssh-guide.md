# 华为云开发环境 SSH 连接指南

## 📦 关于 hdspace.exe

`hdspace.exe` 是华为云 DevEco Service 客户端。如果打不开，可能是：
- Windows Defender 拦截了
- 需要管理员权限
- 文件损坏需重新下载

**建议：直接跳过客户端，用浏览器操作！**

---

## 💡 最简单方案：浏览器 Web Terminal

### 步骤 1：打开华为云控制台

1. 浏览器访问：https://console.huaweicloud.com/
2. 登录你的账号
3. 搜索并进入 **「云开发环境」** 服务

### 步骤 2：找到远程连接

在你的开发环境详情页，找这些按钮：
- **「远程连接」**
- **「查看密码」**
- **「获取连接信息」**

点击后应该显示：
```
主机：ssh.ocean.huaweicloud.com
端口：xxxxx
用户名：root
密码：xxxxxxx
```

### 步骤 3：使用 Web Terminal（如果有）

部分页面提供 **「Web 终端」** 按钮，点击后直接在浏览器操作，**完全不需要 SSH 客户端**。

---

## 💻 本地 PowerShell 连接

如果拿到了 SSH 信息：

```powershell
# SSH 连接命令（替换成实际值）
ssh root@ssh.ocean.huaweicloud.com -p 22222

# 上传代码
scp -r -P 22222 `
  F:\openclawProject\brain\rag-service `
  root@ssh.ocean.huaweicloud.com:/home/root/
```

---

## 🚀 一键部署脚本

创建 `deploy-to-huawei.ps1` 在本地执行：

```powershell
param(
  [string]$IP = "ssh.ocean.huaweicloud.com",
  [int]$Port = 22222,
  [string]$User = "root"
)

Write-Host "=== 华为云部署 ===" -ForegroundColor Cyan

# 测试连接
Write-Host "`n1. 测试 SSH 连接..." -ForegroundColor Yellow
$result = Test-NetConnection -ComputerName $IP -Port $Port
if (-not $result.TcpTestSucceeded) {
  Write-Host "ERROR: 无法连接到 $IP:$Port" -ForegroundColor Red
  exit 1
}
Write-Host "  OK ✓" -ForegroundColor Green

# 上传代码
Write-Host "`n2. 上传代码到服务器..." -ForegroundColor Yellow
$src = "F:\openclawProject\brain\rag-service"
$dest = "${User}@${IP}:${Port}:/home/${User}/"
& scp -r -P $Port -o StrictHostKeyChecking=no $src $dest
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: SCP 失败" -ForegroundColor Red
  exit 1
}
Write-Host "  OK ✓" -ForegroundColor Green

# 显示后续步骤
Write-Host "`n3. 现在执行 SSH 登录并部署：" -ForegroundColor Yellow
Write-Host @'
  ssh root@IP -p PORT
  
  # 登录后执行：
  cd ~/rag-service
  npm install --production
  npm run build
  cat > .env << 'EOF'
DATABASE_URL=postgresql://postgres.zmucjwewjmkvmswedetb:Xjl%40123.com@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require
VECTOR_STORE=pgvector
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=sk-ws-H.RYRDXEL.kh8C.MEYCIQCNEobjag84CfEExwPLMqrwUyz0V7BkJyDlMSlZAQTUwAIhAPwAE7pGc7gKcms0QmNTLkDbaIoQv0L36marbB6G9lik
RAG_API_KEY=prod-key-2024
NODE_ENV=production
UPLOAD_DIR=./uploads
EOF
  mkdir -p uploads/kb_9k9kBOVblT2JnKHfOQnRy
  nohup node dist/main.js > rag-service.log 2>&1 &
  curl http://localhost:8787/health
'@ -ForegroundColor Gray

Write-Host "`n完成！" -ForegroundColor Green
```

使用方法：
```powershell
.\deploy-to-huawei.ps1 -IP "你的IP" -Port 22222
```

---

## ❓ 还是找不到连接信息？

请告诉我：

1. **控制台页面上有哪些按钮/文字？**（拍照或打字描述）
2. **有没有「远程连接」或「SSH」字样？**
3. **能否打开浏览器终端/Web Terminal？**

我可以根据具体情况给你精确步骤！
