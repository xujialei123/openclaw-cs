# Edge worker

常驻边端进程：OpenClaw CDP 巡检、查单、本地知识库降级。

```bash
# 从仓库根
npm run edge
npm run edge:once
node apps/edge-worker/order-lookup.js --once yl_xxx
```

配置：`../../config/cs-runtime.json`（相对本目录上两级为仓库根）。
