import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { execSync } from 'child_process';

function getGitVersionInfo() {
  try {
    const count = execSync('git rev-list --count HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const hash = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    let dateStr = '';
    try {
      dateStr = execSync('git log -1 --format=%cd --date=short HEAD', {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {}
    if (!dateStr) {
      dateStr = new Date().toISOString().split('T')[0];
    }
    const buildNum = Number.parseInt(count, 10) || 1;
    return {
      version: `0.1.${buildNum}`,
      build: buildNum,
      commit: hash,
      date: dateStr,
    };
  } catch {
    return {
      version: '0.1.1',
      build: 1,
      commit: 'dev',
      date: new Date().toISOString().split('T')[0],
    };
  }
}

const gitInfo = getGitVersionInfo();

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'winatmo-git-version-endpoint',
      configureServer(server) {
        server.middlewares.use('/__winatmo_version', (_req, res) => {
          const liveInfo = getGitVersionInfo();
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(liveInfo));
        });
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(gitInfo.version),
    __APP_BUILD__: JSON.stringify(gitInfo.build),
    __APP_COMMIT__: JSON.stringify(gitInfo.commit),
    __APP_DATE__: JSON.stringify(gitInfo.date),
  },
  base: './',
  root: '.',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src/renderer'),
    },
  },
});
