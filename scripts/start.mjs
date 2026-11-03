import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function stopExistingInstances() {
  if (process.platform === 'win32') {
    try {
      execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' });
    } catch {
      // ignore
    }
    try {
      execSync('taskkill /F /IM winAtmo.exe /T', { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
}

stopExistingInstances();

const electronBin = path.join(
  rootDir,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

const mainScript = path.join(rootDir, 'dist/main/main.js');

if (!fs.existsSync(mainScript)) {
  execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
}

console.log('[winAtmo] Starting desktop app...');
const child = spawn(electronBin, [mainScript], {
  cwd: rootDir,
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});
child.unref();
console.log(`[winAtmo] Launched successfully (PID: ${child.pid})`);
