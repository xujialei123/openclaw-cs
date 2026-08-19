# 部署中台到华为云开发环境
param(
  [string]$ServerIP = "",
  [string]$User = "root",
  [string]$KeyFile = "",
  [switch]$SkipBuild,
  [switch]$ShowOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BrainRoot = Join-Path $Root "..\brain"
$RagService = Join-Path $BrainRoot "rag-service"

Write-Host "=== 中台部署脚本 ===" -ForegroundColor Cyan
Write-Host ""

# 检查参数
if (-not $ServerIP) {
  Write-Host "用法: .\deploy-mid.ps1 -ServerIP <华为云IP> [-User root] [-KeyFile path]" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "示例:" -ForegroundColor Yellow
  Write-Host "  .\deploy-mid.ps1 -ServerIP 1.2.3.4" -ForegroundColor Gray
  Write-Host "  .\deploy-mid.ps1 -ServerIP 1.2.3.4 -User ubuntu -KeyFile ~/.ssh/id_rsa" -ForegroundColor Gray
  exit 1
}

$RemotePath = "/home/$User/rag-service"

if ($ShowOnly) {
  Write-Host "=== 部署计划 ===" -ForegroundColor Green
  Write-Host "服务器: $User`@$ServerIP"
  Write-Host "远程路径: $RemotePath"
  Write-Host ""
  Write-Host "步骤:" -ForegroundColor Green
  Write-Host "  1. 上传 brain/rag-service 目录"
  Write-Host "  2. 安装依赖 (npm install --production)"
  Write-Host "  3. 构建 (npm run build)"
  Write-Host "  4. 创建 .env 文件"
  Write-Host "  5. 创建 uploads 目录并复制知识库文件"
  Write-Host "  6. 启动服务"
  exit 0
}

Write-Host "1/6 上传代码..." -ForegroundColor Cyan
$UploadDir = "$RagService"
$Dest = "$User`@$ServerIP`:$RemotePath"

# 使用 SCP 上传
$scpArgs = @(
  "-r"
  "-o" "StrictHostKeyChecking=no"
)
if ($KeyFile) {
  $scpArgs += @("-i", $KeyFile)
}
$scpArgs += @($UploadDir, $Dest)

Write-Host "  SCP: $UploadDir -> $Dest"
& scp @scpArgs 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Host "  ERROR: SCP 失败" -ForegroundColor Red
  exit 1
}
Write-Host "  OK" -ForegroundColor Green

Write-Host ""
Write-Host "2/6 登录服务器执行构建..." -ForegroundColor Cyan

$sshCmd = @"
cd $RemotePath
# 安装依赖
npm install --production 2>&1 | tail -5
# 构建
npm run build 2>&1 | tail -5
# 查看结果
ls -la dist/
"@

$sshArgs = @("-o", "StrictHostKeyChecking=no")
if ($KeyFile) {
  $sshArgs += @("-i", $KeyFile)
}
$sshArgs += "$User`@$ServerIP", "`"$sshCmd`""

Write-Host "  SSH: $User`@$ServerIP"
& ssh @sshArgs 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Host "  ERROR: SSH 执行失败" -ForegroundColor Red
  exit 1
}
Write-Host "  OK" -ForegroundColor Green

Write-Host ""
Write-Host "3/6 创建 .env 文件..." -ForegroundColor Cyan

# 读取本地 .env
$LocalEnv = Get-Content (Join-Path $RagService ".env") -Raw -Encoding UTF8

$envContent = @"
# RAG Service Production Env
DATABASE_URL=postgresql://postgres.zmucjwewjmkvmswedetb:Xjl%40123.com@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require
VECTOR_STORE=pgvector
VECTOR_DIM=1536

EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=sk-ws-H.RYRDXEL.kh8C.MEYCIQCNEobjag84CfEExwPLMqrwUyz0V7BkJyDlMSlZAQTUwAIhAPwAE7pGc7gKcms0QmNTLkDbaIoQv0L36marbB6G9lik
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIM=1536

RAG_API_KEY=prod-rag-key-$(Get-Random -Maximum 999999)
RAG_SERVICE_PORT=8787
NODE_ENV=production
UPLOAD_DIR=./uploads
"@

$envBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($envContent))

$writeEnvCmd = @"
echo '$envBase64' | base64 -d > $RemotePath/.env
cat $RemotePath/.env | head -20
"@

Write-Host "  Writing .env file..."
& ssh @sshArgs $writeEnvCmd 2>&1 | ForEach-Object { Write-Host "  $_" }
Write-Host "  OK" -ForegroundColor Green

Write-Host ""
Write-Host "4/6 创建 uploads 目录..." -ForegroundColor Cyan

$createUploadsCmd = @"
mkdir -p $RemotePath/uploads/kb_9k9kBOVblT2JnKHfOQnRy
ls -la $RemotePath/uploads/
"@

& ssh @sshArgs $createUploadsCmd 2>&1 | ForEach-Object { Write-Host "  $_" }
Write-Host "  OK" -ForegroundColor Green

Write-Host ""
Write-Host "5/6 启动服务..." -ForegroundColor Cyan

$startCmd = @"
cd $RemotePath
# 停止旧进程
pkill -f 'node.*dist/main.js' 2>/dev/null || true
sleep 1
# 后台启动
nohup node dist/main.js > rag-service.log 2>&1 &
sleep 2
# 检查状态
pgrep -f 'node.*dist/main.js' && echo 'Service started' || echo 'FAILED'
cat rag-service.log | tail -10
"@

& ssh @sshArgs $startCmd 2>&1 | ForEach-Object { Write-Host "  $_" }
Write-Host "  OK" -ForegroundColor Green

Write-Host ""
Write-Host "6/6 验证部署..." -ForegroundColor Cyan

$verifyCmd = @"
curl -s http://localhost:8787/health
echo ''
curl -s -H 'Authorization: Bearer prod-rag-key-xxx' http://localhost:8787/api/kb/list 2>/dev/null | head -20
"@

& ssh @sshArgs $verifyCmd 2>&1 | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Host "=== 部署完成 ===" -ForegroundColor Green
Write-Host ""
Write-Host "服务地址: http://$ServerIP:8787" -ForegroundColor Cyan
Write-Host "健康检查: curl http://$ServerIP:8787/health"
Write-Host ""
Write-Host "下一步：在边端配置 RAG_BASE_URL=http://$ServerIP:8787" -ForegroundColor Yellow
