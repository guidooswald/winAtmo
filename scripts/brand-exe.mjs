import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'node_modules', 'electron', 'dist');
const electronExe = path.join(distDir, 'electron.exe');
const winAtmoExe = path.join(distDir, 'winAtmo.exe');
const pathTxt = path.join(rootDir, 'node_modules', 'electron', 'path.txt');

function patchPeVersionString(buf, key, oldVal, newVal) {
  const keyBuf = Buffer.from(key + '\0', 'utf16le');
  const oldValBuf = Buffer.from(oldVal + '\0', 'utf16le');
  const newValBuf = Buffer.from(newVal + '\0', 'utf16le');

  if (newValBuf.length > oldValBuf.length) {
    throw new Error(`New value "${newVal}" is longer than old value "${oldVal}"`);
  }

  let searchFrom = Math.max(0, buf.length - 30 * 1024 * 1024);
  let idx = buf.indexOf(keyBuf, searchFrom);
  let patched = false;

  while (idx !== -1) {
    const wType = buf.readUInt16LE(idx - 2);
    const wValueLength = buf.readUInt16LE(idx - 4);
    if (wType === 1 && wValueLength === oldVal.length + 1) {
      let valOffset = idx + keyBuf.length;
      while (valOffset % 4 !== 0) valOffset += 2;

      const existingVal = buf.subarray(valOffset, valOffset + oldValBuf.length);
      const alreadyPatchedVal = Buffer.concat([
        newValBuf,
        Buffer.alloc(oldValBuf.length - newValBuf.length),
      ]);
      if (existingVal.equals(oldValBuf) || existingVal.equals(alreadyPatchedVal)) {
        buf.fill(0, valOffset, valOffset + oldValBuf.length);
        newValBuf.copy(buf, valOffset);
        patched = true;
      }
    }
    idx = buf.indexOf(keyBuf, idx + 2);
  }

  return patched;
}

function refreshWindowsNotifyIconRegistry() {
  if (process.platform !== 'win32') return;
  try {
    const psScript = `
      Get-ChildItem "HKCU:\\Control Panel\\NotifyIconSettings" -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if ($p.ExecutablePath -match "winAtmo") {
          Set-ItemProperty -Path $_.PSPath -Name "InitialTooltip" -Value "winAtmo" -ErrorAction SilentlyContinue
        }
      }
    `;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
      stdio: 'ignore',
    });
  } catch {
    // Ignore registry cleanup errors
  }
}

function brandExecutable() {
  const sourceExe = fs.existsSync(electronExe) ? electronExe : winAtmoExe;
  if (!fs.existsSync(sourceExe)) {
    console.warn('[winAtmo] Electron executable not found, skipping branding.');
    return;
  }

  const buf = fs.readFileSync(sourceExe);

  patchPeVersionString(buf, 'FileDescription', 'Electron', 'winAtmo');
  patchPeVersionString(buf, 'ProductName', 'Electron', 'winAtmo');

  try {
    fs.writeFileSync(winAtmoExe, buf);
  } catch {
    // Ignore if winAtmo.exe is currently running
  }
  try {
    fs.writeFileSync(electronExe, buf);
  } catch {
    // Ignore if electron.exe is currently running
  }

  if (fs.existsSync(pathTxt)) {
    fs.writeFileSync(pathTxt, 'winAtmo.exe', 'utf8');
  }

  refreshWindowsNotifyIconRegistry();
  console.log('[winAtmo] Branded executable metadata to winAtmo (winAtmo.exe).');
}

brandExecutable();
