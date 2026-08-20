// @ts-nocheck
/**
 * @file services/rag-service/src/routes/admin-page.ts
 * @module RAG Service 兼容层
 * @description 提供 /kb-admin 知识库管理页面路由。
 * @see 联动关注：public/kb-admin.html。
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function adminPageRoutes(app) {
    app.get('/', async (_request, reply) => reply.redirect('/kb-admin'));
    app.get('/kb-admin', async (_request, reply) => {
        // 本地管理页作为 rag-service 的静态调试入口，避免第一版再引入前端构建链路。
        // 使用 __dirname 而不是 process.cwd()，确保在任何启动方式下都能找到文件
        const htmlPath = resolve(__dirname, '..', '..', 'public', 'kb-admin.html');
        const html = await readFile(htmlPath, 'utf-8');
        return reply.type('text/html; charset=utf-8').send(html);
    });
}
