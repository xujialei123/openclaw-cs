# @openclaw/wecom-bridge

企业微信 **智能机器人** 长连接桥：私聊 / 群 @ → 本仓 `generateReply`（含 **自动查单**、知识库）。

## 启动

```bash
# 根目录
npm install
# .env 配置 WECOM_AIBOT_ID / WECOM_AIBOT_SECRET
# cs-runtime.json → platforms.wecom.enabled = true
npm run start:wecom
```

## 查单

与美团/抖音相同：消息命中查单意图或带订单号时，走 `systems.order` → OpenClaw 浏览器打开自有 SaaS 查询（需已登录订单后台）。
