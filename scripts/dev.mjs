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

  if (process.platform !== 'win32') {
    return spawn(electronBin, [mainScript], {
      cwd: rootDir,
      stdio: 'inherit',
      env: mergedEnv,
    });
  }

  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinStaLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public uint dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessW(
    string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
    bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll")]
  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
  [DllImport("kernel32.dll")]
  public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  public static int Run(string exePath, string scriptPath, string workDir) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.lpDesktop = "WinSta0\\\\Default";
    si.dwFlags = 1; // STARTF_USESHOWWINDOW
    si.wShowWindow = 1; // SW_SHOWNORMAL
    PROCESS_INFORMATION pi;
    string cmd = "\\"" + exePath + "\\" \\"" + scriptPath + "\\"";
    bool ok = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, workDir, ref si, out pi);
    if (!ok) {
      return Marshal.GetLastWin32Error();
    }
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code = 0;
    GetExitCodeProcess(pi.hProcess, out code);
    return (int)code;
  }
}
"@
$exitCode = [WinStaLauncher]::Run($env:WINATMO_EXE, $env:WINATMO_MAIN, $env:WINATMO_CWD)
exit $exitCode
`;

  return spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...mergedEnv,
      WINATMO_EXE: electronBin,
      WINATMO_MAIN: mainScript,
      WINATMO_CWD: rootDir,
    },
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
    process.platform === 'win32'
      ? fs.existsSync(path.join(rootDir, 'node_modules', 'electron', 'dist', 'winAtmo.exe'))
        ? 'winAtmo.exe'
        : 'electron.exe'
      : 'electron'
  );

  console.log('[winAtmo] Launching winAtmo window on WinSta0\\Default desktop...');
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
