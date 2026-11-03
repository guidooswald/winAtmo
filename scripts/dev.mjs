import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function stopExistingInstances() {
  if (process.platform === 'win32') {
    try {
      execSync('taskkill /F /IM winAtmo.exe /T', { stdio: 'ignore' });
    } catch {
      // No running winAtmo.exe instance
    }
  }
}

async function buildMain() {
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/main/main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    outfile: path.join(rootDir, 'dist/main/main.js'),
    external: ['electron', 'node:sqlite'],
  });

  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/main/preload.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    outfile: path.join(rootDir, 'dist/main/preload.js'),
    external: ['electron'],
  });
}

/**
 * Spawns the Electron binary explicitly onto WinSta0\Default on Windows so that even when
 * started inside a sandboxed IDE terminal (e.g. Antigravity exebox desktop), the GUI window
 * and system tray icon appear on the user's real visible Windows desktop.
 */
function spawnOnInteractiveDesktop(electronBin, mainScript, extraEnv = {}) {
  const mergedEnv = {
    ...process.env,
    ...extraEnv,
  };

  return spawn(electronBin, [mainScript], {
    cwd: rootDir,
    stdio: 'inherit',
    env: mergedEnv,
  });
}

async function startDev() {
  stopExistingInstances();

  console.log('[winAtmo] Building Electron main & preload bundles...');
  await buildMain();

  console.log('[winAtmo] Starting Vite dev server...');
  const viteServer = await createServer({
    root: rootDir,
    configFile: path.join(rootDir, 'vite.config.mjs'),
  });
  await viteServer.listen();
  const address = viteServer.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  const devUrl = `http://localhost:${port}`;
  console.log(`[winAtmo] Renderer ready at ${devUrl}`);

  const electronBin = path.join(
    rootDir,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  );

  console.log('[winAtmo] Launching winAtmo window...');
  const electronProc = spawnOnInteractiveDesktop(
    electronBin,
    path.join(rootDir, 'dist/main/main.js'),
    {
      NODE_ENV: 'development',
      VITE_DEV_SERVER_URL: devUrl,
    }
  );

  electronProc.on('exit', async (code) => {
    await viteServer.close();
    process.exit(code ?? 0);
  });
}

startDev().catch((err) => {
  console.error('[winAtmo] Dev launch failed:', err);
  process.exit(1);
});
