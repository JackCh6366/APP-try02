import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv, type Plugin} from 'vite';
import generateHandler from './api/generate';
import discussHandler from './api/discuss';
import videoInfoHandler from './api/video-info';

function localApiPlugin(): Plugin {
  return {
    name: 'local-vercel-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        const reqUrl = req.url || '';
        const urlPath = reqUrl.split('?')[0];
        
        let handler: any = null;
        if (urlPath === '/generate') {
          handler = generateHandler;
        } else if (urlPath === '/discuss') {
          handler = discussHandler;
        } else if (urlPath === '/video-info') {
          handler = videoInfoHandler;
        }

        if (!handler) {
          return next();
        }

        try {
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }

          const rawBody = Buffer.concat(chunks).toString('utf8');
          const body = rawBody.trim() ? JSON.parse(rawBody) : {};
          const query = reqUrl.includes('?') ? Object.fromEntries(new URL(reqUrl, 'http://localhost').searchParams) : {};

          const vercelReq = Object.assign(req, { body, query });
          const vercelRes = {
            setHeader(name: string, value: string) {
              res.setHeader(name, value);
              return this;
            },
            status(statusCode: number) {
              res.statusCode = statusCode;
              return this;
            },
            json(payload: unknown) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(payload));
            },
            end(data?: any) {
              res.end(data);
            }
          };

          await handler(vercelReq, vercelRes);
        } catch (error: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: false,
            error: error?.message || `Local API handler for ${urlPath} failed.`,
          }));
        }
      });
    },
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  process.env.GEMINI_API_KEY = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  process.env.NVIDIA_API_KEY = env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY;

  return {
    plugins: [localApiPlugin(), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
