# RAG Service 部署指南

## 部署到华为云开发环境

### 1. 上传代码到服务器

```bash
# 方式一：SCP 上传
scp -r F:\openclawProject\brain\rag-service 用户名@服务器IP:/home/用户名/

# 方式二：使用 Git（推荐）
git clone <你的仓库地址>
cd brain/rag-service
```

### 2. 安装依赖并构建

```bash
# 进入服务目录
cd /home/用户名/rag-service

# 安装依赖
npm install --production

# 构建 TypeScript
npm run build
```

### 3. 创建 .env 文件

```bash
cat > .env << 'EOF'
# 数据库
DATABASE_URL=postgresql://postgres.zmucjwewjmkvmswedetb:Xjl%40123.com@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require
VECTOR_STORE=pgvector
VECTOR_DIM=1536

# Embedding
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=sk-ws-H.RYRDXEL.kh8C.MEYCIQCNEobjag84CfEExwPLMqrwUyz0V7BkJyDlMSlZAQTUwAIhAPwAE7pGc7gKcms0QmNTLkDbaIoQv0L36marbB6G9lik
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIM=1536

# API
RAG_API_KEY=your-production-api-key
RAG_SERVICE_PORT=8787
NODE_ENV=production

# 上传目录
UPLOAD_DIR=./uploads
EOF
```

### 4. 创建 uploads 目录

```bash
mkdir -p uploads/kb_9k9kBOVblT2JnKHfOQnRy
# 复制知识库文件
cp F:\openclawProject\brain\rag-service\uploads\kb_9k9kBOVblT2JnKHfOQnRy\* uploads/kb_9k9kBOVblT2JnKHfOQnRy/
```

### 5. 启动服务

```bash
# 前台运行（测试用）
node dist/main.js

# 后台运行（生产用）
nohup node dist/main.js > rag-service.log 2>&1 &

# 或使用 pm2
pm2 start dist/main.js --name rag-service
pm2 save
pm2 startup
```

### 6. 配置防火墙

```bash
# 放行 8787 端口
sudo ufw allow 8787/tcp
# 或
sudo firewall-cmd --add-port=8787/tcp --permanent
sudo firewall-cmd --reload
```

### 7. 验证部署

```bash
# 健康检查
curl http://localhost:8787/health

# 查看知识库
curl -H "Authorization: Bearer your-production-api-key" \
  http://localhost:8787/api/kb/list
```

## 边端配置

在边端机的 `config/cs-runtime.json` 中更新：

```json
{
  "knowledge": {
    "rag": {
      "baseUrl": "http://华为云服务器IP:8787",
      "apiKey": "your-production-api-key",
      "kbIds": ["kb_9k9kBOVblT2JnKHfOQnRy", ...]
    }
  }
}
```

或在 `.env` 中设置：
```bash
RAG_BASE_URL=http://华为云服务器IP:8787
RAG_API_KEY=your-production-api-key
```
