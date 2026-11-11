import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** 一个请求体最多读这么多字节（一个姿势只有几百字节） */
const BODY_LIMIT = 20_000;

/** 读请求体；超过上限返回 null（但仍把请求读完，这样对方才收得到回复）。 */
const readBody = (req: IncomingMessage): Promise<string | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on('end', () => resolve(size <= BODY_LIMIT ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', () => resolve(null));
  });

/**
 * 只在开发模式（npm run dev）存在的小接口：把姿势实验室里"存成新墙"的姿势写进项目文件。
 *   POST   /__poses        请求体是一个姿势（JSON）→ 写进 public/custom-poses.json（同 id 覆盖）
 *   DELETE /__poses/<id>   从文件里删掉
 * 打包出来的网站里没有这个接口，那时自定义的墙存在浏览器里。
 *
 * 这里只管收请求和读写文件。"这个请求能不能信、文件该变成什么样"的规则在
 * src/games/wall/customPosesFile.ts，通过开发服务器加载进来（所以改了规则不用重启）。
 */
function customPosesPlugin(): Plugin {
  return {
    name: 'custom-poses',
    apply: 'serve',
    configureServer(server) {
      const file = path.join(server.config.publicDir || path.join(server.config.root, 'public'), 'custom-poses.json');
      type Rules = typeof import('./src/games/wall/customPosesFile');
      const loadRules = (): Promise<Rules> => server.ssrLoadModule('/src/games/wall/customPosesFile.ts') as Promise<Rules>;

      /** 文件的全部内容；文件不存在返回 null。别的读取错误（比如没有权限）照常抛出，不能当成"没有文件" */
      const readText = (): string | null => {
        try {
          return readFileSync(file, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw err;
        }
      };
      /** 先写到旁边的临时文件、再改名顶替：写到一半出事的话，原来的文件还是完整的 */
      const writeFile = (text: string): void => {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, text);
        renameSync(tmp, file);
      };
      const reply = (res: ServerResponse, status: number, body: unknown): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      };

      const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const rules = await loadRules();
        const refusal = rules.checkWriteRequest(req.method, req.headers, req.socket.remoteAddress ?? '');
        if (refusal) return reply(res, refusal.status, { error: refusal.error });

        // 先把请求体收完，**再**去读文件。顺序不能反：
        // 要是先读了文件再等请求体，两个前后脚到的请求读到的是同一份旧内容，后写的那个就把先写的盖掉了。
        // 从下面读文件到写回去，中间没有任何等待（没有 await），所以这一段不会被别的请求插进来。
        let input: unknown;
        if (req.method === 'POST') {
          const text = await readBody(req);
          if (text === null) return reply(res, 413, { error: '请求体太大' });
          try {
            input = JSON.parse(text);
          } catch {
            return reply(res, 400, { error: '不是合法的 JSON' });
          }
        }

        // 文件读不懂就到此为止，一个字也不写（否则会把里面原有的墙盖掉）
        const current = rules.readWallsFile(readText());
        if (!current.ok) {
          server.config.logger.warn(`[custom-poses] ${current.error}`);
          return reply(res, current.status, { error: current.error });
        }

        if (req.method === 'DELETE') {
          // 挂在 /__poses 下，所以这里的 req.url 是去掉前缀后剩下的 "/<id>"
          const id = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
          writeFile(rules.formatFile(rules.removeFromFile(current.list, id)));
          return reply(res, 200, { ok: true });
        }

        const result = rules.upsertIntoFile(current.list, input);
        if (!result.ok) return reply(res, result.status, { error: result.error });
        writeFile(rules.formatFile(result.list));
        reply(res, 200, { ok: true, id: result.id });
      };

      server.middlewares.use('/__poses', (req, res) => {
        handle(req, res).catch((err: unknown) => {
          server.config.logger.error(`[custom-poses] ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) reply(res, 500, { error: '存墙接口出错了，看一下运行 npm run dev 的那个窗口' });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), customPosesPlugin()],
  server: { port: 5188 },
  preview: { port: 5189 },
  build: { target: 'es2022', outDir: 'dist' },
  // 识别 Worker 是 ES 模块（它要 import 识别库），打包时也保持模块格式
  worker: { format: 'es' },
  test: {
    // tools/ 下只有会动到项目文件的那一小块（备份 / 恢复）有测试
    include: ['src/**/*.test.ts', 'tools/**/*.test.mjs'],
    environment: 'node',
    // 有些测试是把整局游戏模拟一遍，电脑忙的时候会超过默认的 5 秒；放宽到 20 秒，免得"超时"被当成"出错"
    testTimeout: 20_000,
  },
});
