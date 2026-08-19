// @ts-nocheck
/**
 * @file services/rag-service/src/main.ts
 * @module RAG Service 兼容层
 * @description 启动 8787 端口 Fastify RAG 服务。
 * @see 联动关注：routes/api.ts 和 admin-page.ts。
 */
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { adminPageRoutes } from './routes/admin-page.js';
import { apiRoutes } from './routes/api.js';
// Supabase 首连可能 >10s；默认 pluginTimeout 会导致 apiRoutes 直接崩掉、8787 起不来。
const app = Fastify({ logger: true, pluginTimeout: 120000 });
await app.register(cors, { origin: true });
await app.register(multipart, {
    limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 }
});
// 尽早挂健康检查，避免建库/连云库慢时 Start-All 误判「RAG not ready」
app.get('/health', async () => ({ ok: true, service: 'rag-service' }));
await app.register(adminPageRoutes);
await app.register(apiRoutes);
app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(500).send({
        ok: false,
        error: error instanceof Error ? error.message : '服务内部错误'
    });
});
await app.listen({ port: env.RAG_SERVICE_PORT, host: '0.0.0.0' });
