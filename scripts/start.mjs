import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

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

const mainScript = path.join(rootDir, 'dist/main/main.js');

if (!fs.existsSync(mainScript)) {
  execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
}

if (process.platform === 'win32') {
  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinStaStart {
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

  public static int Launch(string exePath, string scriptPath, string workDir) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.lpDesktop = "WinSta0\\\\Default";
    si.dwFlags = 1;
    si.wShowWindow = 1;
    PROCESS_INFORMATION pi;
    string cmd = "\\"" + exePath + "\\" \\"" + scriptPath + "\\"";
    bool ok = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, workDir, ref si, out pi);
    return ok ? 0 : Marshal.GetLastWin32Error();
  }
}
"@
exit ([WinStaStart]::Launch($env:WINATMO_EXE, $env:WINATMO_MAIN, $env:WINATMO_CWD))
`;
  spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      WINATMO_EXE: electronBin,
      WINATMO_MAIN: mainScript,
      WINATMO_CWD: rootDir,
    },
  });
} else {
  spawn(electronBin, [mainScript], {
    cwd: rootDir,
    stdio: 'inherit',
  });
}
