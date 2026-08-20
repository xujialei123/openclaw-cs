# 华为云开发环境部署指南

## 📋 前提条件

1. 华为云开发环境已创建（Node.js 镜像）
2. 已获得 SSH 连接信息

---

## 步骤 1：SSH 连接到服务器

```bash
ssh root@你的服务器IP -p 端口号
# 例如：ssh root@1.2.3.4 -p 22222
```

---

## 步骤 2：克隆代码

```bash
git clone https://github.com/xujialei123/openclaw-cs.git
cd openclaw-cs
```

---

## 步骤 3：安装依赖并构建

```bash
# 进入 rag-service 目录
cd brain/rag-service

# 安装依赖
npm install --production

# 构建
npm run build

# 验证
ls dist/main.js
```

---

## 步骤 4：配置环境变量

```bash
cd ../..

# 创建 .env 文件
cat > brain/.env << 'EOF'
DATABASE_URL=postgresql://postgres.zmucjwewjmkvmswedetb:Xjl%40123.com@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require
VECTOR_STORE=pgvector
VECTOR_DIM=1536

EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=sk-ws-H.RYRDXEL.kh8C.MEYCIQCNEobjag84CfEExwPLMqrwUyz0V7BkJyDlMSlZAQTUwAIhAPwAE7pGc7gKcms0QmNTLkDbaIoQv0L36marbB6G9lik
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIM=1536

RAG_API_KEY=prod-rag-key-2024
RAG_SERVICE_PORT=8787
NODE_ENV=production
UPLOAD_DIR=./uploads
EOF
```

---

## 步骤 5：准备知识库数据

```bash
# 创建上传目录
mkdir -p brain/rag-service/uploads/kb_9k9kBOVblT2JnKHfOQnRy

# 上传知识库文件
cd brain/rag-service/uploads/kb_9k9kBOVblT2JnKHfOQnRy
# 从本地复制文件，或通过 git 仓库管理
```

---

## 步骤 6：启动服务

```bash
# 使用新创建的启动脚本
chmod +x scripts/start-mid.sh
./scripts/start-mid.sh
```

---

## 步骤 7：配置防火墙

```bash
# Ubuntu/Debian
sudo ufw allow 8787/tcp

# CentOS/RHEL
sudo firewall-cmd --add-port=8787/tcp --permanent
sudo firewall-cmd --reload
```

---

## 步骤 8：验证部署

```bash
# 健康检查
curl http://localhost:8787/health

# 查看知识库
curl -H "Authorization: Bearer prod-rag-key-2024" \
  http://localhost:8787/api/kb/list
```

---

## 边端配置

修改本地边端机的 `.env`：

```bash
RAG_BASE_URL=http://你的华为云IP:8787
RAG_API_KEY=prod-rag-key-2024
```

然后重启 cs-watch。
